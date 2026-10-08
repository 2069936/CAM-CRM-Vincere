// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * THE STATUS LIGHT ON THE OPERATIONS COMMAND CENTER, AND WHERE A TILE GOES.
 *
 * A Manager has one route to a client page: through the CAM's workspace. So a
 * Live accounts tile has to find the CAM that holds the client. The loader
 * (src/domain/supabaseStore.js) records that mapping on the CAM profile, as
 * `clientIds` built from client_assignments; a client object never carries a
 * `camProfileId`. The first cut of this panel looked for the latter and every
 * click was a no-op, with a green suite, because nothing rendered the panel.
 *
 * Asked of a RENDERED Operations Command Center: clients in the shape the
 * loader produces, a CAM profile with clientIds, a click on a tile, and the
 * arguments onOpenCam received. The heading order is asked of the same render.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseAccountTracker: vi.fn(),
}));

vi.mock('./domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
}));

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
];

// The loader's CAM shape: the mapping lives here, as clientIds.
const CAMS = [
  { id: 'cam-north', name: 'North desk', status: 'Active', clientIds: ['c-1', 'c-3'], clientOrder: [] },
  { id: 'cam-south', name: 'South desk', status: 'Active', clientIds: ['c-2'], clientOrder: [] },
];

function sample(accountName, overrides = {}) {
  return {
    accountName,
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
    ['c-1', [sample('CR-1'), sample('CR-2', { connected: false, status: 'ConnectionLost' })]],
    ['c-2', [sample('BL-1')]],
  ]),
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

function tileFor(container, clientId) {
  const tile = container.querySelector(`.fsl-tile[data-client-id="${clientId}"] .fsl-tile-button`);
  expect(tile, `a clickable tile for ${clientId}`).not.toBeNull();
  return tile;
}

beforeEach(() => {
  mocks.loadSupabaseAccountTracker.mockReset();
  mocks.loadSupabaseAccountTracker.mockResolvedValue(TRACKER);
});
afterEach(cleanup);

describe('a Live accounts tile on the Operations Command Center', () => {
  it('opens the client inside the workspace of the CAM whose clientIds hold it', async () => {
    const { container, onOpenCam } = mount();
    await waitFor(() => expect(container.querySelectorAll('.fsl-tile').length).toBe(3));

    act(() => { tileFor(container, 'c-1').click(); });
    expect(onOpenCam).toHaveBeenCalledTimes(1);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-1');

    act(() => { tileFor(container, 'c-2').click(); });
    expect(onOpenCam).toHaveBeenCalledTimes(2);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-south', 'c-2');

    // A client nothing has sampled still has a tile, and the tile still opens it.
    act(() => { tileFor(container, 'c-3').click(); });
    expect(onOpenCam).toHaveBeenCalledTimes(3);
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-3');
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
    await waitFor(() => expect(container.querySelectorAll('.fsl-tile').length).toBe(3));
    act(() => { tileFor(container, 'c-1').click(); });
    expect(onOpenCam).toHaveBeenLastCalledWith('cam-north', 'c-1');
    act(() => { tileFor(container, 'c-2').click(); });
    expect(onOpenCam).toHaveBeenLastCalledWith(undefined, 'c-2');
  });
});

describe('the order of the Operations Command Center', () => {
  it('shows the light right after the money, before the Insight Feed and the flags', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    expect(container.querySelector('h1').textContent).toBe('Operations Command Center');
    const money = indexOfHeading(container, 'Desk money');
    const live = indexOfHeading(container, 'Live accounts');
    const feed = indexOfHeading(container, 'Insight Feed');
    const flags = indexOfHeading(container, 'Open flags - all clients');
    expect(money).toBeLessThan(live);
    expect(live).toBeLessThan(feed);
    expect(feed).toBeLessThan(flags);
    // Nothing else sits between the money and the light.
    expect(live).toBe(money + 1);
    // The money (the metric strip) comes before the light in the document.
    const strip = container.querySelector('.metric-grid');
    const panel = container.querySelector('.fsl-grid');
    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Open by default, so the tiles are visible without a click.
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Live accounts'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reads the tracker once, for every working client on the desk', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledWith({ clientIds: ['c-1', 'c-2', 'c-3'] });
  });
});
