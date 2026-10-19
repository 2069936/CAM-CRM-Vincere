import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_UPDATE_BATCH_LIMIT,
  AGENT_UPDATE_BLOCKER_COPY,
  FIRST_SELF_UPDATING_AGENT,
  agentUpdateBlockers,
  agentUpdatePlan,
  agentUpdateResultWords,
  chunkDeviceIds,
  compareAgentVersions,
  describeAgentUpdate,
  fleetAgentUpdateConfirmation,
  fleetAgentUpdateLabel,
  fleetNeedsVpsWords,
  isAgentOutdated,
  planFleetAgentUpdate,
  publicAgentUpdateFields,
} from './agentUpdate';
import { createAutoCollectionApi } from './autoCollectionApi';

const NOW = Date.parse('2026-10-19T15:00:00.000Z');
const RELEASE = { version: '1.3.1', minimumAddonVersion: null };
const DASHES = /[‒–—―]/;

function device(overrides = {}) {
  return {
    id: 'd0000000-0000-4000-8000-000000000001', status: 'active', revokedAt: null,
    agentVersion: '1.3.0', addonVersion: '1.3.0',
    updateTargetVersion: null, updateRequestedAt: null, updateState: null, updateStateAt: null, updateErrorCode: null,
    ...overrides,
  };
}

describe('versions, as numbers', () => {
  it('compares part by part, padding to four parts', () => {
    expect(compareAgentVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareAgentVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareAgentVersions('1.3', '1.3.0')).toBe(0);
    expect(compareAgentVersions('1.3.0.1', '1.3.0')).toBeGreaterThan(0);
  });

  it('answers null when either side is not a version', () => {
    for (const value of [null, undefined, '', 'latest', '1', '1.2.3.4.5', 130]) {
      expect(compareAgentVersions(value, '1.3.0'), String(value)).toBeNull();
    }
  });

  it('the first self updating build is 1.3.0, in one place', () => {
    expect(FIRST_SELF_UPDATING_AGENT).toBe('1.3.0');
    expect(AGENT_UPDATE_BLOCKER_COPY.agent_too_old).toContain(FIRST_SELF_UPDATING_AGENT);
  });
});

describe('which VPS the CRM can update', () => {
  it('outdated is an active VPS reporting a version below the release', () => {
    expect(isAgentOutdated(device({ agentVersion: '1.3.0' }), '1.3.1')).toBe(true);
    expect(isAgentOutdated(device({ agentVersion: '1.9.0' }), '1.10.0')).toBe(true);
    expect(isAgentOutdated(device({ agentVersion: '1.10.0' }), '1.9.0')).toBe(false);
    expect(isAgentOutdated(device({ agentVersion: '1.3.1' }), '1.3.1')).toBe(false);
    expect(isAgentOutdated(device({ agentVersion: null }), '1.3.1')).toBe(false);
    expect(isAgentOutdated(device({ status: 'revoked' }), '1.3.1')).toBe(false);
    expect(isAgentOutdated(device({ revokedAt: '2026-10-01T00:00:00Z' }), '1.3.1')).toBe(false);
    expect(isAgentOutdated(null, '1.3.1')).toBe(false);
  });

  it(`an agent older than ${FIRST_SELF_UPDATING_AGENT}, or one with no readable version, cannot update itself`, () => {
    expect(agentUpdateBlockers(device({ agentVersion: '1.2.2' }), RELEASE)).toEqual(['agent_too_old']);
    expect(agentUpdateBlockers(device({ agentVersion: '1.2.9.9' }), RELEASE)).toEqual(['agent_too_old']);
    expect(agentUpdateBlockers(device({ agentVersion: null }), RELEASE)).toEqual(['agent_too_old']);
    expect(agentUpdateBlockers(device({ agentVersion: '1.3.0' }), RELEASE)).toEqual([]);
    expect(agentUpdateBlockers(device({ agentVersion: '1.3' }), RELEASE)).toEqual([]);
  });

  it('a release that needs a newer AddOn than the VPS reports, or one it cannot read, waits for the VPS', () => {
    const release = { version: '1.3.1', minimumAddonVersion: '1.3.0' };
    expect(agentUpdateBlockers(device({ addonVersion: '1.2.0' }), release)).toEqual(['addon_too_old']);
    expect(agentUpdateBlockers(device({ addonVersion: null }), release)).toEqual(['addon_too_old']);
    expect(agentUpdateBlockers(device({ addonVersion: '1.3.0' }), release)).toEqual([]);
    expect(agentUpdateBlockers(device({ addonVersion: '1.10.0' }), release)).toEqual([]);
    expect(agentUpdateBlockers(device({ agentVersion: '1.2.2', addonVersion: '1.2.0' }), release)).toEqual(['agent_too_old', 'addon_too_old']);
    // No minimum in the manifest: the AddOn is not asked about.
    expect(agentUpdateBlockers(device({ addonVersion: null }), RELEASE)).toEqual([]);
  });

  it('the plan offers the button only when the agent is below, nothing blocks it, and the same request is not already moving', () => {
    expect(agentUpdatePlan(device(), RELEASE)).toEqual({ version: '1.3.1', outdated: true, blockers: [], pending: false, inFlight: false, canRequest: true });
    expect(agentUpdatePlan(device({ agentVersion: '1.3.1' }), RELEASE)).toMatchObject({ outdated: false, canRequest: false });
    expect(agentUpdatePlan(device({ agentVersion: '1.2.2' }), RELEASE)).toMatchObject({ outdated: true, blockers: ['agent_too_old'], canRequest: false });
    for (const state of ['requested', 'downloading', 'staged', 'applying']) {
      expect(agentUpdatePlan(device({ updateTargetVersion: '1.3.1', updateState: state }), RELEASE), state)
        .toMatchObject({ pending: true, inFlight: true, canRequest: false });
    }
    // A failed request can be asked for again, and so can one for a release the CRM no longer pins.
    expect(agentUpdatePlan(device({ updateTargetVersion: '1.3.1', updateState: 'failed' }), RELEASE)).toMatchObject({ pending: true, inFlight: false, canRequest: true });
    expect(agentUpdatePlan(device({ updateTargetVersion: '1.3.0', updateState: 'requested', agentVersion: '1.3.0' }), RELEASE)).toMatchObject({ pending: true, inFlight: false, canRequest: true });
    expect(agentUpdatePlan(device(), null)).toMatchObject({ version: null, outdated: false, canRequest: false });
  });

  it('the fleet plan lists what can be sent and counts what needs the VPS', () => {
    const devices = [
      device({ id: 'a' }),
      device({ id: 'b', agentVersion: '1.2.2' }),
      device({ id: 'c', addonVersion: '1.2.0' }),
      device({ id: 'd', agentVersion: '1.3.1' }),
      device({ id: 'e', updateTargetVersion: '1.3.1', updateState: 'staged' }),
      device({ id: 'f', updateTargetVersion: '1.3.1', updateState: 'failed', updateErrorCode: 'x' }),
    ];
    expect(planFleetAgentUpdate(devices, { version: '1.3.1', minimumAddonVersion: '1.3.0' }))
      .toEqual({ version: '1.3.1', minimumAddonVersion: '1.3.0', deviceIds: ['a', 'f'], needsVps: 2 });
    expect(planFleetAgentUpdate(devices, null)).toBeNull();
  });

  it('chunks to the 300 the route takes', () => {
    const ids = Array.from({ length: 601 }, (_, index) => String(index));
    expect(AGENT_UPDATE_BATCH_LIMIT).toBe(300);
    expect(chunkDeviceIds(ids).map((chunk) => chunk.length)).toEqual([300, 300, 1]);
    expect(chunkDeviceIds(ids).flat()).toEqual(ids);
    expect(chunkDeviceIds([])).toEqual([]);
  });
});

describe('the status line, in plain English', () => {
  it.each([
    [{ updateState: 'requested', updateRequestedAt: '2026-10-19T14:57:00Z' }, 'Update to 1.3.1 requested 3 min ago'],
    [{ updateState: 'requested', updateRequestedAt: '2026-10-19T14:59:30Z' }, 'Update to 1.3.1 requested just now'],
    [{ updateState: 'requested', updateRequestedAt: '2026-10-19T12:00:00Z' }, 'Update to 1.3.1 requested 3 h ago'],
    [{ updateState: 'requested', updateRequestedAt: null }, 'Update to 1.3.1 requested'],
    [{ updateState: 'downloading' }, 'Downloading 1.3.1'],
    [{ updateState: 'staged' }, '1.3.1 downloaded, installing outside the 4 pm capture window'],
    [{ updateState: 'applying' }, 'Installing 1.3.1'],
    [{ updateState: 'failed', updateErrorCode: 'hash_mismatch' }, 'Update to 1.3.1 failed: hash_mismatch'],
  ])('a pending request %j reads %j', (fields, line) => {
    expect(describeAgentUpdate(device({ updateTargetVersion: '1.3.1', ...fields }), NOW)).toBe(line);
  });

  it('a completed request names the version the agent now reports', () => {
    expect(describeAgentUpdate(device({ agentVersion: '1.3.1', updateState: 'completed' }), NOW)).toBe('Updated to 1.3.1');
  });

  it('says nothing for a VPS never asked, or a cancelled request', () => {
    expect(describeAgentUpdate(device(), NOW)).toBeNull();
    expect(describeAgentUpdate(device({ updateState: 'cancelled' }), NOW)).toBeNull();
    expect(describeAgentUpdate(null, NOW)).toBeNull();
  });

  it('no line and no sentence carries a dash', () => {
    const lines = [
      ...['requested', 'downloading', 'staged', 'applying', 'failed'].map((state) => describeAgentUpdate(device({ updateTargetVersion: '1.3.1', updateState: state, updateErrorCode: 'x', updateRequestedAt: '2026-10-19T14:57:00Z' }), NOW)),
      describeAgentUpdate(device({ updateState: 'completed' }), NOW),
      ...Object.values(AGENT_UPDATE_BLOCKER_COPY),
      fleetAgentUpdateLabel({ version: '1.3.1', deviceIds: ['a', 'b'] }),
      fleetAgentUpdateConfirmation({ version: '1.3.1', deviceIds: ['a'], needsVps: 2 }),
      fleetNeedsVpsWords({ version: '1.3.1', needsVps: 1 }),
      agentUpdateResultWords({ version: '1.3.1', requested: 2, skipped: 3, needsVps: 1 }),
    ];
    for (const line of lines) expect(line, line).not.toMatch(DASHES);
  });

  it('the two VPS sentences are the agreed ones', () => {
    expect(AGENT_UPDATE_BLOCKER_COPY).toEqual({
      agent_too_old: 'This agent is older than 1.3.0 and cannot update itself. Install 1.3.0 on the VPS once; later updates can be sent from here.',
      addon_too_old: 'This update changes the NinjaTrader AddOn. Install it on the VPS with NinjaTrader closed.',
    });
  });
});

describe('the fleet button and its confirmation', () => {
  it('names how many and which version', () => {
    expect(fleetAgentUpdateLabel({ version: '1.3.1', deviceIds: ['a', 'b', 'c'] })).toBe('Update 3 outdated agents to 1.3.1');
    expect(fleetAgentUpdateLabel({ version: '1.3.1', deviceIds: ['a'] })).toBe('Update 1 outdated agent to 1.3.1');
  });

  it('the confirmation names the count and the version, and how many need a VPS install instead', () => {
    expect(fleetAgentUpdateConfirmation({ version: '1.3.1', deviceIds: ['a', 'b'], needsVps: 0 }))
      .toBe('Update 2 outdated agents to 1.3.1? Each one downloads 1.3.1 and installs it outside the 4 pm capture window.');
    expect(fleetAgentUpdateConfirmation({ version: '1.3.1', deviceIds: ['a', 'b'], needsVps: 3 }))
      .toBe('Update 2 outdated agents to 1.3.1? Each one downloads 1.3.1 and installs it outside the 4 pm capture window. 3 other outdated agents need an install on the VPS instead and will not be sent this update.');
    expect(fleetAgentUpdateConfirmation({ version: '1.3.1', deviceIds: ['a'], needsVps: 1 }))
      .toContain('1 other outdated agent needs an install on the VPS instead');
  });

  it('the result sentence separates the VPS installs from the rest', () => {
    expect(agentUpdateResultWords({ version: '1.3.1', requested: 4, skipped: 3, needsVps: 2 }))
      .toBe('Update to 1.3.1 requested for 4 agents. 2 need an install on the VPS instead. 1 was already up to date or no longer active.');
    expect(agentUpdateResultWords({ version: '1.3.1', requested: 1, skipped: 0, needsVps: 0 })).toBe('Update to 1.3.1 requested for 1 agent.');
  });
});

describe('step 70\'s columns, shaped for a screen', () => {
  it('passes what the columns allow and drops what they do not', () => {
    expect(publicAgentUpdateFields({
      update_target_version: '1.3.1', update_requested_at: '2026-10-19T14:57:00Z', update_state: 'failed',
      update_state_at: '2026-10-19T14:58:00Z', update_error_code: 'hash_mismatch', update_requested_by: 'someone',
    })).toEqual({
      updateTargetVersion: '1.3.1', updateRequestedAt: '2026-10-19T14:57:00Z', updateState: 'failed',
      updateStateAt: '2026-10-19T14:58:00Z', updateErrorCode: 'hash_mismatch',
    });
    expect(publicAgentUpdateFields({ update_target_version: '1.3', update_state: 'odd', update_error_code: 'Bad Code' }))
      .toMatchObject({ updateTargetVersion: null, updateState: null, updateErrorCode: null });
    expect(publicAgentUpdateFields({})).toEqual({
      updateTargetVersion: null, updateRequestedAt: null, updateState: null, updateStateAt: null, updateErrorCode: null,
    });
  });
});

describe('the browser API for it', () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  function json(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it('posts a request with the Manager\'s token, in slices of 300, and adds the counts up', async () => {
    const fetchImpl = vi.fn(async (_path, options) => {
      const { deviceIds } = JSON.parse(options.body);
      return json({ ok: true, version: '1.3.1', requested: deviceIds.length - 1, skipped: 1, needsVps: 1 });
    });
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await expect(api.requestAgentUpdate(ids(301))).resolves.toEqual({ ok: true, version: '1.3.1', requested: 299, skipped: 2, needsVps: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies.map((body) => [body.action, body.deviceIds.length])).toEqual([['request', 300], ['request', 1]]);
    expect(Object.keys(bodies[0])).toEqual(['action', 'deviceIds']);
    for (const [path, options] of fetchImpl.mock.calls) {
      expect(path).toBe('/api/admin/ingest-agent-update');
      expect(options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer manager-token', 'Content-Type': 'application/json' } });
    }
  });

  it('posts a cancel the same way', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, cancelled: 1 }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await expect(api.cancelAgentUpdate(ids(1))).resolves.toEqual({ ok: true, cancelled: 1 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: 'cancel', deviceIds: ids(1) });
  });

  it('sends each id once, lower cased, and refuses an empty list or a non uuid before fetching', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, version: '1.3.1', requested: 1, skipped: 0, needsVps: 0 }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await api.requestAgentUpdate([ids(1)[0].toUpperCase(), ids(1)[0]]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).deviceIds).toEqual(ids(1));
    fetchImpl.mockClear();
    await expect(api.requestAgentUpdate([])).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.requestAgentUpdate(['device-1'])).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.cancelAgentUpdate(null)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says plainly when there is no release to update to', async () => {
    const api = createAutoCollectionApi({ fetchImpl: async () => json({ error: 'release_unavailable' }, 409), getAccessToken: async () => 'token' });
    await expect(api.requestAgentUpdate(ids(1))).rejects.toMatchObject({
      code: 'release_unavailable', status: 409, message: 'No agent release is available to update to right now. Try again in a few minutes.',
    });
  });
});
