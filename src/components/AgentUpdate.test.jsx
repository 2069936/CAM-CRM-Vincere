// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AutoCollectionCard from './AutoCollectionCard';
import AutoCollectionManager from './AutoCollectionManager';

/* ------------------------------------------------------------------------- *
 * UPDATING THE AGENT FROM THE CRM, ON THE TWO SCREENS THAT OFFER IT.
 *
 * The client card: for a Manager, "Update agent to X" on a VPS whose agent is
 * below the pinned release, "Cancel update" while a request is pending, and
 * one plain sentence for where it stands. A VPS the button can never reach
 * (an agent older than 1.3.0, or a release that changes the AddOn) gets the
 * sentence that sends someone to the VPS, and no button. A CAM sees none of it.
 *
 * Auto Collection: one button for every outdated agent the CRM can update,
 * which asks first, naming how many and which version, and how many need an
 * install on the VPS instead.
 *
 * Asked of RENDERED components, with the clicks a Manager makes and the API
 * calls those clicks produce.
 * ------------------------------------------------------------------------- */

afterEach(cleanup);

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const DASHES = /[‒–—―]/;

function cardStatus({ device = {}, release = {}, permissions = {} } = {}) {
  return {
    serverTime: '2026-10-19T15:00:00.000Z',
    client: { uuid: CLIENT_ID, name: 'Acme Trading' },
    permissions: { generate: true, rebind: true, revoke: true, replay: true, updateAgent: true, ...permissions },
    release: { url: 'https://downloads.example.test/agent.zip', kind: 'zip', version: '1.3.1', sha256: 'a'.repeat(64), minimumAddonVersion: null, ...release },
    device: {
      id: DEVICE_ID, status: 'active', healthStatus: 'online', revokedAt: null,
      agentVersion: '1.3.0', addonVersion: '1.3.0', ninjaTraderVersion: '8.1.5.2',
      lastSeenAt: '2026-10-19T14:59:00.000Z', schedule: { time: '16:30:00', timezone: 'America/New_York' },
      updateTargetVersion: null, updateRequestedAt: null, updateState: null, updateStateAt: null, updateErrorCode: null,
      ...device,
    },
    enrollment: null,
  };
}

function renderCard(status, api = {}) {
  const fullApi = {
    loadStatus: vi.fn(async () => status),
    requestAgentUpdate: vi.fn(async () => ({ ok: true, version: '1.3.1', requested: 1, skipped: 0, needsVps: 0 })),
    cancelAgentUpdate: vi.fn(async () => ({ ok: true, cancelled: 1 })),
    ...api,
  };
  const view = render(<AutoCollectionCard clientUuid={CLIENT_ID} clientName="Acme Trading" initialStatus={status} disableAutoLoad api={fullApi} />);
  return { ...view, api: fullApi };
}

const updateButton = () => screen.queryByRole('button', { name: /Update agent to/ });
const cancelButton = () => screen.queryByRole('button', { name: 'Cancel update' });

describe('the client card, for a Manager', () => {
  it('offers "Update agent to 1.3.1" on a VPS below the pinned release, and no status line yet', () => {
    const { container } = renderCard(cardStatus());
    expect(updateButton()).toHaveProperty('textContent', ' Update agent to 1.3.1');
    expect(cancelButton()).toBeNull();
    expect(container.querySelector('.auto-collection-agent-update-line')).toBeNull();
  });

  it('a click requests the update for this VPS, then reads the card again', async () => {
    const requested = cardStatus({ device: { updateTargetVersion: '1.3.1', updateState: 'requested', updateRequestedAt: '2026-10-19T14:57:00.000Z' } });
    const { api } = renderCard(cardStatus(), { loadStatus: vi.fn(async () => requested) });
    await act(async () => { fireEvent.click(updateButton()); });
    expect(api.requestAgentUpdate).toHaveBeenCalledWith([DEVICE_ID]);
    await waitFor(() => expect(api.loadStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Update to 1.3.1 requested 3 min ago')).toBeTruthy());
    // In flight: no second request offered, the cancel is.
    expect(updateButton()).toBeNull();
    expect(cancelButton()).not.toBeNull();
  });

  it('Cancel update cancels this VPS\'s request, then reads the card again', async () => {
    const { api } = renderCard(cardStatus({ device: { updateTargetVersion: '1.3.1', updateState: 'downloading' } }));
    await act(async () => { fireEvent.click(cancelButton()); });
    expect(api.cancelAgentUpdate).toHaveBeenCalledWith([DEVICE_ID]);
    expect(api.requestAgentUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(api.loadStatus).toHaveBeenCalledTimes(1));
  });

  it('keeps a refused request beside the buttons instead of replacing the card', async () => {
    const refused = Object.assign(new Error('No agent release is available to update to right now. Try again in a few minutes.'), { code: 'release_unavailable', status: 409 });
    renderCard(cardStatus(), { requestAgentUpdate: vi.fn(async () => { throw refused; }) });
    await act(async () => { fireEvent.click(updateButton()); });
    expect(screen.getByRole('alert').textContent).toBe(refused.message);
    expect(screen.getByText('Automatic NinjaTrader collection')).toBeTruthy();
    expect(updateButton()).not.toBeNull();
  });

  it.each([
    [{ updateState: 'requested', updateRequestedAt: '2026-10-19T14:57:00.000Z' }, 'Update to 1.3.1 requested 3 min ago'],
    [{ updateState: 'downloading' }, 'Downloading 1.3.1'],
    [{ updateState: 'staged' }, '1.3.1 downloaded, installing outside the 4 pm capture window'],
    [{ updateState: 'applying' }, 'Installing 1.3.1'],
  ])('a request in flight reads %j as %j, with Cancel and no second Update', (fields, line) => {
    renderCard(cardStatus({ device: { updateTargetVersion: '1.3.1', ...fields } }));
    expect(screen.getByText(line)).toBeTruthy();
    expect(cancelButton()).not.toBeNull();
    expect(updateButton()).toBeNull();
  });

  it('a failed request names its code, and can be cancelled or asked for again', () => {
    renderCard(cardStatus({ device: { updateTargetVersion: '1.3.1', updateState: 'failed', updateErrorCode: 'hash_mismatch' } }));
    expect(screen.getByText('Update to 1.3.1 failed: hash_mismatch')).toBeTruthy();
    expect(cancelButton()).not.toBeNull();
    expect(updateButton()).not.toBeNull();
  });

  it('a completed request says so, and an up to date VPS is offered nothing', () => {
    renderCard(cardStatus({ device: { agentVersion: '1.3.1', updateState: 'completed' } }));
    expect(screen.getByText('Updated to 1.3.1')).toBeTruthy();
    expect(updateButton()).toBeNull();
    expect(cancelButton()).toBeNull();
  });

  it('an agent older than 1.3.0 gets the VPS sentence and no button', () => {
    renderCard(cardStatus({ device: { agentVersion: '1.2.2' } }));
    expect(screen.getByText('This agent is older than 1.3.0 and cannot update itself. Install 1.3.0 on the VPS once; later updates can be sent from here.')).toBeTruthy();
    expect(updateButton()).toBeNull();
  });

  it('a release that changes the AddOn gets the VPS sentence and no button when the VPS AddOn is below it', () => {
    renderCard(cardStatus({ device: { addonVersion: '1.2.0' }, release: { minimumAddonVersion: '1.3.0' } }));
    expect(screen.getByText('This update changes the NinjaTrader AddOn. Install it on the VPS with NinjaTrader closed.')).toBeTruthy();
    expect(updateButton()).toBeNull();
  });

  it('the AddOn sentence is not shown when the VPS AddOn is already new enough', () => {
    renderCard(cardStatus({ device: { addonVersion: '1.3.0' }, release: { minimumAddonVersion: '1.3.0' } }));
    expect(screen.queryByText(/changes the NinjaTrader AddOn/)).toBeNull();
    expect(updateButton()).not.toBeNull();
  });

  it('nothing is offered without a release, or on a revoked VPS', () => {
    const noRelease = cardStatus();
    noRelease.release = null;
    renderCard(noRelease);
    expect(updateButton()).toBeNull();
    cleanup();
    renderCard(cardStatus({ device: { status: 'revoked', revokedAt: '2026-10-01T00:00:00.000Z' } }));
    expect(updateButton()).toBeNull();
  });

  it('no sentence on the card about the update carries a dash', () => {
    const { container } = renderCard(cardStatus({ device: { agentVersion: '1.2.2', updateTargetVersion: '1.3.1', updateState: 'staged' }, release: { minimumAddonVersion: '9.0.0' } }));
    expect(container.querySelector('[aria-label="Agent update"]').textContent).not.toMatch(DASHES);
  });
});

describe('the client card, for a CAM', () => {
  it('shows no update button, no cancel and no update line', () => {
    const { container } = renderCard(cardStatus({
      permissions: { updateAgent: false },
      device: { updateTargetVersion: '1.3.1', updateState: 'downloading' },
    }));
    expect(updateButton()).toBeNull();
    expect(cancelButton()).toBeNull();
    expect(container.querySelector('[aria-label="Agent update"]')).toBeNull();
    expect(screen.queryByText('Downloading 1.3.1')).toBeNull();
  });

  it('nor before the server says the permission exists at all', () => {
    const status = cardStatus();
    delete status.permissions.updateAgent;
    renderCard(status);
    expect(updateButton()).toBeNull();
  });
});

/* ── Auto Collection ─────────────────────────────────────────────────────── */

const fleetIds = (count) => Array.from({ length: count }, (_, index) => `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

function fleet(agentUpdate, rows = []) {
  return {
    serverTime: '2026-10-19T15:00:00.000Z', page: 1, pageSize: 25, total: rows.length,
    summary: { total: rows.length, attention: 0 }, rows, agentUpdate,
  };
}

function renderManager(initialFleet, { confirm = vi.fn(() => true), api = {} } = {}) {
  const fullApi = {
    loadFleet: vi.fn(async () => initialFleet),
    requestAgentUpdate: vi.fn(async (ids) => ({ ok: true, version: '1.3.1', requested: ids.length, skipped: 0, needsVps: 0 })),
    ...api,
  };
  const view = render(<AutoCollectionManager initialFleet={initialFleet} disableAutoLoad api={fullApi} confirm={confirm} />);
  return { ...view, api: fullApi, confirm };
}

const bulkButton = () => screen.queryByRole('button', { name: /outdated agents? to/ });

describe('Auto Collection: every outdated agent at once', () => {
  it('offers "Update N outdated agents to X.Y.Z" for the machines the CRM can update', () => {
    renderManager(fleet({ version: '1.3.1', minimumAddonVersion: null, deviceIds: fleetIds(12), needsVps: 0 }));
    expect(bulkButton().textContent).toBe(' Update 12 outdated agents to 1.3.1');
  });

  it('asks first, naming how many, the version and how many need the VPS, then posts every id', async () => {
    const ids = fleetIds(301);
    const { api, confirm } = renderManager(fleet({ version: '1.3.1', minimumAddonVersion: '1.3.0', deviceIds: ids, needsVps: 4 }));
    await act(async () => { fireEvent.click(bulkButton()); });
    expect(confirm).toHaveBeenCalledWith('Update 301 outdated agents to 1.3.1? Each one downloads 1.3.1 and installs it outside the 4 pm capture window. 4 other outdated agents need an install on the VPS instead and will not be sent this update.');
    // The API slices to 300 (tested beside it); the screen hands it every id.
    expect(api.requestAgentUpdate).toHaveBeenCalledWith(ids);
    await waitFor(() => expect(screen.getByText('Update to 1.3.1 requested for 301 agents.')).toBeTruthy());
    expect(api.loadFleet).toHaveBeenCalled();
  });

  it('sends nothing when the Manager says no', async () => {
    const { api, confirm } = renderManager(fleet({ version: '1.3.1', minimumAddonVersion: null, deviceIds: fleetIds(2), needsVps: 0 }), { confirm: vi.fn(() => false) });
    await act(async () => { fireEvent.click(bulkButton()); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.requestAgentUpdate).not.toHaveBeenCalled();
  });

  it('says how many need an install on the VPS, with or without a button', () => {
    renderManager(fleet({ version: '1.3.1', minimumAddonVersion: '1.3.0', deviceIds: [], needsVps: 3 }));
    expect(bulkButton()).toBeNull();
    expect(screen.getByText('3 outdated agents need an install on the VPS to reach 1.3.1: they are older than 1.3.0, or the update changes the NinjaTrader AddOn.')).toBeTruthy();
  });

  it('shows nothing when every agent is current, before step 70, or with no release', () => {
    for (const plan of [{ version: '1.3.1', minimumAddonVersion: null, deviceIds: [], needsVps: 0 }, null, undefined]) {
      const { container } = renderManager(fleet(plan));
      expect(bulkButton()).toBeNull();
      expect(container.querySelector('[aria-label="Agent updates"]')).toBeNull();
      cleanup();
    }
  });

  it('shows where each row\'s request stands under its version', () => {
    const rows = [{
      client: { uuid: CLIENT_ID, name: 'Acme Trading' },
      device: { id: DEVICE_ID, agentVersion: '1.3.0', schedule: { time: '16:30:00' }, updateTargetVersion: '1.3.1', updateState: 'staged' },
      todayBatch: null,
      operationalStatus: { state: 'update_required', label: 'Update required', detail: '' },
    }];
    renderManager(fleet(null, rows));
    expect(screen.getByText('1.3.1 downloaded, installing outside the 4 pm capture window')).toBeTruthy();
  });
});
