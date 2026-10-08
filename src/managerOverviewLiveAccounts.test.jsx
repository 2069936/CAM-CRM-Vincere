// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * THE BULBS ON THE OPERATIONS COMMAND CENTER, AND WHERE A CLIENT GOES.
 *
 * Pedro's words: the Manager's view should be one bulb per client, not every
 * account of every client; a click opens the breakdown, and from there the
 * client. A Manager has one route to a client page: through the CAM's
 * workspace. So the drawer's "Open client" has to find the CAM that holds the
 * client. The loader (src/domain/supabaseStore.js) records that mapping on the
 * CAM profile, as `clientIds` built from client_assignments; a client object
 * never carries a `camProfileId`. The first cut of the tiles looked for the
 * latter and every click was a no-op, with a green suite, because nothing
 * rendered the panel.
 *
 * Asked of a RENDERED Operations Command Center: clients in the shape the
 * loader produces, a CAM profile with clientIds, the fleet route answered with
 * devices, a click on a bulb and on the drawer's button, and the arguments
 * onOpenCam received. The heading order is asked of the same render, and so
 * is the absence of the CAM overview's tiles here.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseAccountTracker: vi.fn(),
  loadFleet: vi.fn(),
}));

vi.mock('./domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
}));

vi.mock('./domain/autoCollectionApi', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, autoCollectionApi: { ...original.autoCollectionApi, loadFleet: mocks.loadFleet } };
});

import { ManagerOverview } from './App';

// The loader's client shape: no camProfileId on the client, ever.
function client(id, name, accounts) {
  return {
    id,
    name,
    profile: { stage: 'Active', subscriptionPrice: '$250' },
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, {
      accountName, accountType: 'Funded', status: 'Active',
    }])),
    dailyImports: [],
    tasks: [],
    activities: [],
  };
}

// One close with one open flag, so the desk's flags table has a reason to render.
function withOpenFlag(entry) {
  return {
    ...entry,
    dailyImports: [{
      id: `${entry.id}-close`,
      date: '2026-10-07',
      snapshots: [],
      flags: [{ id: `${entry.id}-flag`, type: 'Drawdown', severity: 'Critical', status: 'Open', message: 'Daily loss limit hit' }],
    }],
  };
}

const DESK = [
  withOpenFlag(client('c-1', 'Cedar Row', ['CR-1', 'CR-2'])),
  client('c-2', 'Birch Lane', ['BL-1']),
  client('c-3', 'Alder Court', ['AC-1']),
  // No registry, no device, no sample: the folded line, not a bulb.
  client('c-4', 'Dry Creek', []),
];

// The loader's CAM shape: the mapping lives here, as clientIds.
const CAMS = [
  { id: 'cam-north', name: 'North desk', status: 'Active', clientIds: ['c-1', 'c-3'], clientOrder: [] },
  { id: 'cam-south', name: 'South desk', status: 'Active', clientIds: ['c-2', 'c-4'], clientOrder: [] },
];

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connectionName: 'Live',
    connected: true,
    status: 'Connected',
    totalPnl: 50,
    runState: 'running',
    sampledAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

const TRACKER = {
  available: true,
  staleSeconds: 1500,
  minAgentVersion: '1.2.0',
  samplesByClientId: new Map([
    ['c-1', [sample('CR-1'), sample('CR-2', { connected: false, status: 'ConnectionLost', connectionName: 'Bluesky' })]],
    ['c-2', [sample('BL-1')]],
  ]),
};

const device = (id) => ({ id, status: 'active', healthStatus: 'online', lastSeenAt: new Date().toISOString(), lastErrorCode: null, revokedAt: null });
const FLEET = {
  rows: [
    { client: { uuid: 'c-1', name: 'Cedar Row' }, device: device('d-1') },
    { client: { uuid: 'c-2', name: 'Birch Lane' }, device: device('d-2') },
    { client: { uuid: 'c-3', name: 'Alder Court' }, device: device('d-3') },
    { client: { uuid: 'c-4', name: 'Dry Creek' }, device: null },
  ],
  total: 4,
};

function mount(props = {}) {
  const onOpenCam = vi.fn();
  const utils = render(<ManagerOverview
    clients={DESK}
    camProfiles={CAMS}
    users={[]}
    coverage={[]}
    timeOff={[]}
    session={{ id: 'u-manager', role: 'Manager', username: 'manager' }}
    onOpenCam={onOpenCam}
    onApproveTimeOff={vi.fn()}
    onDenyTimeOff={vi.fn()}
    onEndCoverage={vi.fn()}
    onEditCoverage={vi.fn()}
    onCreateCam={vi.fn()}
    onUpdateCamProfile={vi.fn()}
    onAddClient={vi.fn()}
    onImportClient={vi.fn()}
    onUpdateClientById={vi.fn()}
    onAppendDailyImport={vi.fn()}
    onAppendActivity={vi.fn()}
    onLogout={vi.fn()}
    onUsersChange={vi.fn()}
    onRefreshState={vi.fn()}
    onUpdateClientAccount={vi.fn()}
    onTransferClient={vi.fn()}
    onResolveFlag={vi.fn()}
    {...props}
  />);
  return { ...utils, onOpenCam };
}

const headings = (container) => [...container.querySelectorAll('h3')].map((node) => node.textContent.trim());

function indexOfHeading(container, text) {
  const list = headings(container);
  const index = list.findIndex((heading) => heading.startsWith(text));
  expect(index, `heading "${text}" is on the page; saw ${JSON.stringify(list)}`).toBeGreaterThanOrEqual(0);
  return index;
}

function bulbFor(container, clientId) {
  const bulb = container.querySelector(`.dcl-bulb[data-client-id="${clientId}"] .dcl-bulb-button`);
  expect(bulb, `a bulb for ${clientId}`).not.toBeNull();
  return bulb;
}

function openClientFromDrawer(container, clientId) {
  act(() => { bulbFor(container, clientId).click(); });
  const button = container.querySelector('.dcl-drawer .dcl-drawer-open');
  expect(button, `the drawer for ${clientId} offers to open the client`).not.toBeNull();
  act(() => { button.click(); });
}

async function bulbsReady(container) {
  await waitFor(() => expect(container.querySelectorAll('.dcl-bulb').length).toBe(3));
  // The fleet has answered: the source line says the devices are in.
  await waitFor(() => expect(container.querySelector('.dcl-source').textContent).toBe('VPS health from the collector fleet.'));
}

beforeEach(() => {
  mocks.loadSupabaseAccountTracker.mockReset();
  mocks.loadSupabaseAccountTracker.mockResolvedValue(TRACKER);
  mocks.loadFleet.mockReset();
  mocks.loadFleet.mockResolvedValue(FLEET);
});
afterEach(cleanup);

describe('a Live accounts bulb on the Operations Command Center', () => {
  it('is one light per client, worst first, and the CAM overview tiles are not here', async () => {
    const { container } = mount();
    await bulbsReady(container);
    expect([...container.querySelectorAll('.dcl-bulb')].map((node) => `${node.dataset.state}:${node.dataset.clientId}`))
      .toEqual(['partly:c-1', 'never_sampled:c-3', 'live:c-2']);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    expect(container.querySelector('.dcl-hidden').textContent).toContain('1 client without a VPS paired');
  });

  it('opens the client, from the drawer, inside the workspace of the CAM whose clientIds hold it', async () => {
    const { container, onOpenCam } = mount();
    await bulbsReady(container);

    openClientFromDrawer(container, 'c-1');
    expect(onOpenCam).toHaveBeenCalledTimes(1);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-1');

    openClientFromDrawer(container, 'c-2');
    expect(onOpenCam).toHaveBeenCalledTimes(2);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-south', 'c-2');

    // A client nothing has sampled still has a bulb, and its drawer still opens it.
    openClientFromDrawer(container, 'c-3');
    expect(onOpenCam).toHaveBeenCalledTimes(3);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-3');
  });

  it('shows the breakdown under the grid: connections, then the account pills', async () => {
    const { container } = mount();
    await bulbsReady(container);
    act(() => { bulbFor(container, 'c-1').click(); });
    const drawer = container.querySelector('.dcl-drawer');
    expect(drawer.querySelector('.dcl-drawer-sentence').textContent).toBe('Partly live, 1 connected, 1 disconnected.');
    expect([...drawer.querySelectorAll('.dcl-connection-name')].map((node) => node.textContent)).toEqual(['Bluesky', 'Live']);
    expect([...drawer.querySelectorAll('.account-pill')].map((node) => node.dataset.account)).toEqual(['CR-2', 'CR-1']);
  });

  it('does not route through a CAM whose user is deactivated, the way the Insight Feed does not', async () => {
    // With a user directory present, only CAMs with an active user are active.
    // South desk's user is inactive, so its client is opened with no CAM to
    // host it, exactly what InsightFeedPanel's onSelectClient hands over.
    const users = [
      { id: 'u-n', username: 'north', role: 'CAM', status: 'Active', camProfileId: 'cam-north' },
      { id: 'u-s', username: 'south', role: 'CAM', status: 'Inactive', camProfileId: 'cam-south' },
    ];
    const { container, onOpenCam } = mount({ users });
    await bulbsReady(container);
    openClientFromDrawer(container, 'c-1');
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-1');
    openClientFromDrawer(container, 'c-2');
    expect(onOpenCam).toHaveBeenLastCalledWith(undefined, 'c-2');
  });
});

describe('the order of the Operations Command Center', () => {
  it('shows the light right after the money, before the Insight Feed and the flags', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.dcl-grid')).not.toBeNull());
    expect(container.querySelector('h1').textContent).toBe('Operations Command Center');
    const money = indexOfHeading(container, 'Desk money');
    const live = indexOfHeading(container, 'Live accounts');
    const rollCall = indexOfHeading(container, 'Algorithm roll call');
    const close = indexOfHeading(container, 'Tracker against the close');
    const feed = indexOfHeading(container, 'Insight Feed');
    const flags = indexOfHeading(container, 'Open flags, all clients');
    expect(money).toBeLessThan(live);
    // The roll call per algorithm, right after the desk lights.
    expect(rollCall).toBe(live + 1);
    // The tracker against today's close for the whole desk, right after the roll call.
    expect(close).toBe(rollCall + 1);
    expect(close).toBeLessThan(feed);
    expect(rollCall).toBeLessThan(feed);
    expect(live).toBeLessThan(feed);
    expect(feed).toBeLessThan(flags);
    // Nothing else sits between the money and the light.
    expect(live).toBe(money + 1);
    // The money (the metric strip) comes before the light in the document.
    const strip = container.querySelector('.metric-grid');
    const panel = container.querySelector('.dcl-grid');
    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Open by default, so the bulbs are visible without a click.
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Live accounts'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reads the tracker once for every working client, and the fleet once, by pages of 100', async () => {
    const { container } = mount();
    await bulbsReady(container);
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledWith({ clientIds: ['c-1', 'c-2', 'c-3', 'c-4'] });
    expect(mocks.loadFleet).toHaveBeenCalledTimes(1);
    expect(mocks.loadFleet).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 100 }));
  });
});
