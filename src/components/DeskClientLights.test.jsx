// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeskClientLights from './DeskClientLights';
import { resetClientLiveStrategiesCache } from './useClientLiveStrategies';
import { AutoCollectionApiError } from '../domain/autoCollectionApi';

/* ------------------------------------------------------------------------- *
 * ONE BULB PER CLIENT ON THE OPERATIONS COMMAND CENTER.
 *
 * Pedro's words: all the clients at once is unreadable for the Manager; one
 * light per client, is NinjaTrader up and are the connections active, amber
 * when some are and some that should be are not, and a click opens the
 * breakdown: the connections, under each its accounts, under each account what
 * it has been doing. The clients with no VPS are one folded line, not bulbs.
 * These assertions are about that screen as rendered, with fictional clients.
 * ------------------------------------------------------------------------- */

const NOW = new Date('2026-10-08T15:00:00.000Z');
const FRESH = '2026-10-08T14:56:00.000Z';
const STALE = '2026-10-08T14:18:00.000Z';
const CYCLE = '2026-10-08T14:50:00.000Z';
const UUID_A = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const UUID_B = '7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connectionName: 'Live',
    connected: true,
    status: 'Connected',
    realizedPnl: -950,
    unrealizedPnl: -50,
    totalPnl: -1000,
    strategyCount: 2,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: FRESH,
    ...overrides,
  };
}
const disconnected = (name, extra = {}) => sample(name, { connected: false, status: 'ConnectionLost', ...extra });
const silent = (name, extra = {}) => sample(name, { sampledAt: STALE, ...extra });

function client(id, name, accounts = [], extra = {}) {
  return {
    id,
    name,
    profile: { stage: 'Active' },
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, { accountName, status: 'Active' }])),
    ...extra,
  };
}

function device(overrides = {}) {
  return { id: 'dev', status: 'active', healthStatus: 'online', lastSeenAt: '2026-10-08T14:59:30.000Z', lastErrorCode: null, revokedAt: null, ...overrides };
}

const CLIENTS = [
  client('c-live', 'Green Oak', ['G-1']),
  // Legacy key plus uuid: the rows carry the uuid, the app names it by the key.
  client('act-1700000000-client-a', 'Client A', ['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04'], { uuid: UUID_A }),
  client('c-off', 'Red Cedar', ['R-1']),
  // A legacy key with a uuid and no sample: only the device, keyed by the uuid, makes it a bulb.
  client('c-never', 'Brown Elm', ['E-1', 'E-2'], { uuid: UUID_B }),
  client('c-none-1', 'Grey Birch', ['B-1']),
  client('c-none-2', 'Grey Ash', []),
];

const SAMPLES = new Map([
  ['c-live', [sample('G-1', { connectionName: 'Bluesky' })]],
  [UUID_A, [
    sample('ACC 01', { connectionName: 'Bluesky' }),
    disconnected('ACC 02', { connectionName: 'Bluesky' }),
    sample('ACC 03', { connectionName: 'Live' }),
    sample('ACC 04', { connectionName: null }),
  ]],
  ['c-off', [silent('R-1')]],
]);

const DEVICES = new Map([
  ['c-live', [device()]],
  [UUID_A, [device()]],
  ['c-off', [device()]],
  [UUID_B, [device()]],
]);

function tracker(overrides = {}) {
  return { available: true, staleSeconds: 1500, minAgentVersion: '1.2.0', samplesByClientId: SAMPLES, ...overrides };
}

function strategyRow(clientId, accountName, overrides = {}) {
  return {
    clientId, accountName, strategyId: '1', strategyName: '0 - OGX-PF-2.4', algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26', instrumentRoot: 'MNQ', realizedPnl: -950, unrealizedPnl: -50,
    restartedAt: null, sampledAt: '2026-10-08T14:50:02.000Z', cycleStart: CYCLE, ...overrides,
  };
}

function strategiesAnswer(clientId, rows) {
  return {
    available: true,
    clientId,
    desk: {
      available: true, cycleStart: CYCLE, filling: false, scope: 'desk',
      cohorts: [{ algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 12, nClients: 8, median: -500, spread: 100, nFlat: 0 }],
    },
    rows,
    settings: { minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false },
  };
}

function mount(props = {}) {
  const onSelectClient = vi.fn();
  const loadDevices = props.loadDevices ?? vi.fn(async () => ({ available: true, byClientId: DEVICES }));
  const loadStrategies = props.loadStrategies ?? vi.fn(async ({ clientId }) => strategiesAnswer(clientId, []));
  const utils = render(<DeskClientLights
    clients={CLIENTS}
    tracker={tracker()}
    now={NOW}
    onSelectClient={onSelectClient}
    refreshMs={120_000}
    {...props}
    loadDevices={loadDevices}
    loadStrategies={loadStrategies}
  />);
  return { ...utils, onSelectClient, loadDevices, loadStrategies };
}

const bulbs = (container) => [...container.querySelectorAll('.dcl-bulb')];
const bulbFor = (container, id) => container.querySelector(`.dcl-bulb[data-client-id="${id}"] .dcl-bulb-button`);
async function ready(container, count = 4) {
  await waitFor(() => expect(bulbs(container).length).toBe(count));
}

beforeEach(() => resetClientLiveStrategiesCache());
afterEach(cleanup);

describe('one bulb per client', () => {
  it('renders one light per client with a VPS or a sample, worst first, and nothing per account at this level', async () => {
    const { container } = mount();
    await ready(container);
    expect(bulbs(container).map((node) => `${node.dataset.state}:${node.querySelector('.dcl-bulb-name').textContent}`)).toEqual([
      'off:Red Cedar', 'partly:Client A', 'never_sampled:Brown Elm', 'live:Green Oak',
    ]);
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
    // Colour, word and sentence on every bulb.
    const off = container.querySelector('.dcl-bulb[data-client-id="c-off"]');
    expect(off.className).toContain('tone-off');
    expect(off.querySelector('.sr-only').textContent).toBe('Off');
    expect(off.querySelector('.dcl-bulb-button').getAttribute('title')).toBe('Red Cedar: Off, no connection for 42 minutes.');
    const partly = container.querySelector('.dcl-bulb[data-client-id="act-1700000000-client-a"]');
    expect(partly.className).toContain('tone-partly');
    expect(partly.querySelector('.dcl-bulb-button').getAttribute('title')).toBe('Client A: Partly live, 3 connected, 1 disconnected.');
    for (const button of container.querySelectorAll('.dcl-bulb-button')) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('says the counts, the latest sample and the refresh over the grid, with the legend', async () => {
    const { container } = mount();
    await ready(container);
    expect(container.querySelector('.dcl-summary').textContent).toContain('1 live, 1 partly live, 1 off, 1 never sampled, 2 without a VPS. Latest sample 4m ago.');
    expect(container.querySelector('.live-refresh').textContent).toMatch(/^Updated .*refreshes every 2 min\.$/);
    expect(container.querySelector('.dcl-source').textContent).toBe('VPS health from the collector fleet.');
    const legend = [...container.querySelectorAll('.dcl-legend-item')].map((node) => node.textContent.trim());
    expect(legend).toEqual(['Live', 'Partly live', 'Off', 'Never sampled', 'No VPS paired', 'Amber corner: an algorithm differs from the desk']);
  });

  it('folds the clients without a VPS into one line with a Show toggle that lists their names', async () => {
    const { container } = mount();
    await ready(container);
    const line = container.querySelector('.dcl-hidden');
    expect(line.textContent).toContain('2 clients without a VPS paired');
    const toggle = line.querySelector('button');
    expect(toggle.textContent).toBe('Show');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.dcl-hidden-list')).toBeNull();
    act(() => { toggle.click(); });
    expect(toggle.textContent).toBe('Hide');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect([...container.querySelectorAll('.dcl-hidden-list li')].map((node) => node.textContent)).toEqual(['Grey Ash', 'Grey Birch']);
    expect(container.querySelector('.dcl-hidden-list').className).toContain('muted');
    act(() => { toggle.click(); });
    expect(container.querySelector('.dcl-hidden-list')).toBeNull();
  });
});

describe('click a bulb for the breakdown', () => {
  it('opens one drawer under the grid: the sentence, then connections, then the pills under each', async () => {
    const { container } = mount();
    await ready(container);
    act(() => { bulbFor(container, 'act-1700000000-client-a').click(); });
    const button = bulbFor(container, 'act-1700000000-client-a');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const drawer = container.querySelector('.dcl-drawer');
    expect(drawer).not.toBeNull();
    expect(button.getAttribute('aria-controls')).toBe(drawer.id);
    expect(drawer.querySelector('.dcl-drawer-name').textContent).toBe('Client A');
    expect(drawer.querySelector('.dcl-drawer-sentence').textContent).toBe('Partly live, 3 connected, 1 disconnected.');
    // The drawer sits under the grid, not inside a bulb.
    expect(drawer.closest('.dcl-bulb')).toBeNull();
    expect(container.querySelector('.dcl-grid').compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const connections = [...drawer.querySelectorAll('.dcl-connection')];
    expect(connections.map((node) => node.querySelector('.dcl-connection-name').textContent)).toEqual(['Bluesky', 'Live', 'No connection name']);
    expect(connections.map((node) => node.querySelector('.dcl-connection-words').textContent)).toEqual(['1 of 2 connected', '1 of 1 connected', '1 of 1 connected']);
    expect(connections.map((node) => [...node.querySelectorAll('.account-pill')].map((pill) => pill.dataset.account))).toEqual([
      ['ACC 01', 'ACC 02'], ['ACC 03'], ['ACC 04'],
    ]);
    // Each pill is builder 1's pill: dot, account, connection, state.
    const pill = connections[0].querySelector('.account-pill[data-account="ACC 02"]');
    expect(pill.className).toContain('tracker-disconnected');
    expect(pill.querySelector('.account-pill-connection').textContent).toBe('Bluesky');
    expect(pill.querySelector('.account-pill-state').textContent).toBe('Disconnected');
    expect(connections[2].querySelector('.account-pill-connection').className).toContain('absent');
  });

  it('keeps one drawer open at a time, and the open bulb, Escape or Close shut it', async () => {
    const { container } = mount();
    await ready(container);
    act(() => { bulbFor(container, 'c-off').click(); });
    expect(container.querySelector('.dcl-drawer-name').textContent).toBe('Red Cedar');
    act(() => { bulbFor(container, 'c-live').click(); });
    expect(container.querySelectorAll('.dcl-drawer').length).toBe(1);
    expect(container.querySelector('.dcl-drawer-name').textContent).toBe('Green Oak');
    expect(bulbFor(container, 'c-off').getAttribute('aria-expanded')).toBe('false');
    expect(bulbFor(container, 'c-live').getAttribute('aria-expanded')).toBe('true');
    // The open bulb closes it.
    act(() => { bulbFor(container, 'c-live').click(); });
    expect(container.querySelector('.dcl-drawer')).toBeNull();
    // Escape closes it.
    act(() => { bulbFor(container, 'c-live').click(); });
    expect(container.querySelector('.dcl-drawer')).not.toBeNull();
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(container.querySelector('.dcl-drawer')).toBeNull();
    // The Close button closes it.
    act(() => { bulbFor(container, 'c-live').click(); });
    act(() => { container.querySelector('.dcl-drawer-close').click(); });
    expect(container.querySelector('.dcl-drawer')).toBeNull();
  });

  it('opens the client from the drawer with the legacy id, the key the CAM profiles hold', async () => {
    const { container, onSelectClient } = mount();
    await ready(container);
    act(() => { bulbFor(container, 'act-1700000000-client-a').click(); });
    act(() => { container.querySelector('.dcl-drawer-open').click(); });
    expect(onSelectClient).toHaveBeenCalledTimes(1);
    expect(onSelectClient).toHaveBeenCalledWith('act-1700000000-client-a');
  });

  it('shows the never sampled registry accounts in their own group under the connections', async () => {
    const { container } = mount();
    await ready(container);
    act(() => { bulbFor(container, 'c-never').click(); });
    const groups = [...container.querySelectorAll('.dcl-connection')];
    expect(groups.map((node) => node.querySelector('.dcl-connection-name').textContent)).toEqual(['Never sampled']);
    expect(groups[0].querySelector('.dcl-connection-words').textContent).toBe('2 on the registry, no sample yet');
    expect([...groups[0].querySelectorAll('.account-pill')].map((pill) => pill.dataset.state)).toEqual(['never_sampled', 'never_sampled']);
  });
});

describe('click a pill for what the account is running', () => {
  it('reads the strategies for that client by its uuid once the drawer opens, and opens the detail under the pill', async () => {
    const loadStrategies = vi.fn(async ({ clientId }) => strategiesAnswer(clientId, [strategyRow(UUID_A, 'ACC 01')]));
    const { container } = mount({ loadStrategies });
    await ready(container);
    expect(loadStrategies).not.toHaveBeenCalled();
    act(() => { bulbFor(container, 'act-1700000000-client-a').click(); });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledTimes(1));
    expect(loadStrategies).toHaveBeenCalledWith({ clientId: UUID_A });
    // The marker lands on the pill before any click: this account differs ($1,000 against a $500 median at 100 spread).
    await waitFor(() => expect(container.querySelector('.account-pill[data-account="ACC 01"]').className).toContain('differs'));
    const pillButton = container.querySelector('.account-pill[data-account="ACC 01"] .account-pill-button');
    expect(pillButton.getAttribute('aria-expanded')).toBe('false');
    act(() => { pillButton.click(); });
    expect(pillButton.getAttribute('aria-expanded')).toBe('true');
    const detail = container.querySelector('.account-live-detail');
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain('Connection Bluesky');
    expect(detail.textContent).toContain('Differs from the desk by $500, 5 times the usual spread.');
    expect(detail.querySelector('.badge.warning')).not.toBeNull();
    // One account open at a time in the drawer.
    act(() => { container.querySelector('.account-pill[data-account="ACC 03"] .account-pill-button').click(); });
    expect(container.querySelectorAll('.account-live-detail').length).toBe(1);
    expect(container.querySelector('.account-live-detail').getAttribute('aria-label')).toBe('ACC 03, what it is running');
  });

  it('says so inside the detail when the strategies cannot be read', async () => {
    const loadStrategies = vi.fn(async () => { throw new Error('boom'); });
    const { container } = mount({ loadStrategies });
    await ready(container);
    act(() => { bulbFor(container, 'c-live').click(); });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalled());
    act(() => { container.querySelector('.account-pill[data-account="G-1"] .account-pill-button').click(); });
    await waitFor(() => expect(container.querySelector('.account-live-detail-failed')).not.toBeNull());
    expect(container.querySelector('.account-live-detail-failed').textContent).toBe('Could not read what is running.');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('the devices, when the role can read them', () => {
  it('reads the fleet once on mount and derives the bulbs from samples alone until it answers', async () => {
    let release;
    const loadDevices = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { container } = mount({ loadDevices });
    // Before the fleet answers: samples and registry only, so Grey Birch is a brown bulb.
    await waitFor(() => expect(bulbs(container).length).toBe(5));
    expect(container.querySelector('.dcl-source').textContent).toBe('Reading VPS health from the collector fleet.');
    await act(async () => { release({ available: true, byClientId: DEVICES }); });
    await ready(container, 4);
    expect(loadDevices).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.dcl-source').textContent).toBe('VPS health from the collector fleet.');
  });

  it('falls back to samples and the registry when the fleet refuses the role, and says so', async () => {
    const loadDevices = vi.fn(async () => { throw new AutoCollectionApiError('permission_denied', { status: 403 }); });
    const { container } = mount({ loadDevices });
    await waitFor(() => expect(container.querySelector('.dcl-source').textContent).toBe('VPS health is not readable for this role, so the lights come from the samples and the registry alone.'));
    expect(bulbs(container).map((node) => node.dataset.state)).toEqual(['off', 'partly', 'never_sampled', 'never_sampled', 'live']);
  });

  it('reads nothing when told the role cannot, and says the lights are from samples alone', async () => {
    const { container, loadDevices } = mount({ deviceAware: false });
    await waitFor(() => expect(bulbs(container).length).toBe(5));
    expect(loadDevices).not.toHaveBeenCalled();
    expect(container.querySelector('.dcl-source').textContent).toBe('VPS health is not readable for this role, so the lights come from the samples and the registry alone.');
  });
});

describe('the honest empty states', () => {
  it('says step 55 has not run when the tracker is unavailable', () => {
    const { container, loadDevices } = mount({ tracker: null });
    expect(container.querySelector('[role="status"]').textContent).toContain('Live account tracking is not available on this CRM yet.');
    expect(container.querySelector('.dcl-grid')).toBeNull();
    expect(loadDevices).not.toHaveBeenCalled();
  });

  it('says nothing has sampled and no VPS is paired when that is the case', async () => {
    const loadDevices = vi.fn(async () => ({ available: true, byClientId: new Map() }));
    const { container } = mount({ tracker: tracker({ samplesByClientId: new Map() }), loadDevices });
    await waitFor(() => expect(loadDevices).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[role="status"]').textContent).toContain('No collector sends live samples yet.'));
  });
});

describe('the stylesheet', () => {
  const css = readFileSync('src/index.css', 'utf8');
  const has = (selector) => new RegExp(`${selector.replace(/[.[\]()*+?^$|{}\\]/g, '\\$&')}(?![\\w-])`).test(css);

  it('has a rule for every class the bulbs render', async () => {
    const { container } = mount();
    await ready(container);
    act(() => { bulbFor(container, 'act-1700000000-client-a').click(); });
    act(() => { container.querySelector('.dcl-hidden button').click(); });
    const classes = new Set();
    for (const node of container.querySelectorAll('[class]')) {
      for (const name of String(node.getAttribute('class') || '').split(/\s+/)) if (name.startsWith('dcl-')) classes.add(name);
    }
    expect(classes.size).toBeGreaterThan(10);
    for (const name of classes) expect(has(`.${name}`), `.${name} is styled`).toBe(true);
  });

  it('colours the off bulb red and nothing else, and the partly bulb amber', () => {
    const start = css.indexOf('(DeskClientLights)');
    expect(start).toBeGreaterThan(0);
    const end = css.indexOf('/* ──', start + 1);
    const block = css.slice(start, end > start ? end : undefined);
    const line = (selector) => block.split('\n').find((row) => row.includes(selector)) || '';
    expect(line('.dcl-bulb.tone-off .dcl-light')).toContain('var(--error)');
    expect(line('.dcl-bulb.tone-partly .dcl-light')).toContain('var(--warning)');
    expect(line('.dcl-bulb.tone-partly .dcl-light')).not.toContain('--error');
    expect(line('.dcl-bulb.tone-live .dcl-light')).toContain('var(--success)');
    const redLines = block.split('\n').filter((row) => /--error|--red\b|\.danger/.test(row));
    expect(redLines.every((row) => row.includes('tone-off'))).toBe(true);
  });
});
