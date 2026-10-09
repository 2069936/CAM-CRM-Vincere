// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FleetStatusLights from './FleetStatusLights';
import { resetClientLiveStrategiesCache } from './useClientLiveStrategies';
import { resetAccountObservationSettingsCache } from './useAccountObservationSettings';
import {
  DOT_TONES,
  LEGEND,
  LIVE_ACCOUNTS_VIEW_KEY,
  LIVE_SAMPLING_BUILD,
  buildFleetStatusLights,
  compareTiles,
  disconnectedClientKeys,
  parseLiveAccountsView,
} from '../domain/fleetStatusLights';
import { historyWindowStart } from '../domain/disconnectedSince';

/* ------------------------------------------------------------------------- *
 * THE STATUS LIGHT FOR THE WHOLE BOOK.
 *
 * Pedro's words: the "semáforo" first, for all of my clients, as a picture and
 * not as text to read; and the dots should say what the client page's say, the
 * account, the connection, whether it is active. These assertions are about
 * what a glance has to get right: the colour of each pill matches its state,
 * the three words are on it, the worst client is at the top, every colour has
 * a word beside it, the summary line counts what the grid shows, a click on a
 * pill shows what the account is running, and each of the three empty states
 * says a different true thing.
 * ------------------------------------------------------------------------- */

const NOW = new Date('2026-10-05T15:00:00.000Z');
const CYCLE = '2026-10-05T14:50:00.000Z';

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connectionName: 'Rithmic',
    connected: true,
    status: 'Connected',
    realizedPnl: 100,
    unrealizedPnl: 20,
    totalPnl: 120,
    strategyCount: 2,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-05T14:56:00.000Z',
    ...overrides,
  };
}

const disconnected = (name) => sample(name, { connected: false, status: 'ConnectionLost' });
const silent = (name) => sample(name, { sampledAt: '2026-10-05T13:00:00.000Z' });
const allOff = (name, extra = {}) => sample(name, { runState: 'idle', enabledStrategyCount: 0, ...extra });

function client(id, name, accounts = []) {
  return {
    id,
    name,
    profile: { stage: 'Active' },
    accountRegistry: Object.fromEntries(
      accounts.map(([accountName, status = 'Active']) => [accountName, { accountName, status }]),
    ),
  };
}

function tracker(samples, overrides = {}) {
  return {
    available: true,
    staleSeconds: 1500,
    minAgentVersion: '1.2.0',
    samplesByClientId: new Map(Object.entries(samples)),
    ...overrides,
  };
}

const CLIENTS = [
  client('c-green', 'Green Oak', [['G-1'], ['G-2']]),
  client('c-amber', 'Amber Pine', [['A-1'], ['A-2'], ['A-3']]),
  client('c-grey', 'Grey Birch', [['B-1']]),
  client('c-silent', 'Silent Elm', [['E-1'], ['E-2']]),
];

const SAMPLES = {
  'c-green': [sample('G-1'), allOff('G-2', { connectionName: 'Bluesky' })],
  'c-amber': [sample('A-1'), disconnected('A-2'), sample('A-3', { connectionName: null })],
  'c-silent': [sample('E-1'), silent('E-2')],
};

/* What one client is running, as the on demand loader answers it. */
function strategyRow(clientId, accountName, overrides = {}) {
  return {
    clientId,
    accountName,
    strategyId: '1',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -950,
    unrealizedPnl: -50,
    restartedAt: null,
    sampledAt: '2026-10-05T14:50:02.000Z',
    cycleStart: CYCLE,
    ...overrides,
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

const neverAnswers = vi.fn(() => new Promise(() => {}));
// Step 66 not run: the panel reads the history and says nothing of it.
const historyNotDeployed = vi.fn(async () => ({ available: false, reason: 'not_deployed' }));

function mount(props = {}) {
  return render(<FleetStatusLights
    clients={CLIENTS}
    tracker={tracker(SAMPLES)}
    now={NOW}
    onSelectClient={vi.fn()}
    loadStrategies={neverAnswers}
    loadHistory={historyNotDeployed}
    {...props}
  />);
}

/* A client with an account marked Failed that is still connected and running. */
const MAPLE_MARKED = {
  id: 'c-maple', name: 'Maple Ridge', profile: { stage: 'Active' },
  accountRegistry: { 'ACC 01': { accountName: 'ACC 01', status: 'Active' }, 'ACC 06': { accountName: 'ACC 06', status: 'Failed' } },
};
const MARKED_SAMPLES = { 'c-maple': [sample('ACC 01'), sample('ACC 06')], 'c-green': SAMPLES['c-green'] };

const tileNames = (container) => [...container.querySelectorAll('.fsl-tile')]
  .map((tile) => tile.querySelector('.fsl-tile-name').textContent);

const pillsOf = (tile) => [...tile.querySelectorAll('.account-pill')];
const pillText = (pill, part) => pill.querySelector(`.account-pill-${part}`)?.textContent ?? null;

/* The tile suites read the Tiles view, as a CAM who chose it would; Compact
 * (the default) has its own suites at the end of this file, which start from
 * an empty store. */
beforeEach(() => {
  resetClientLiveStrategiesCache();
  window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, 'tiles');
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('one pill per account: the account, the connection, the state, never colour alone', () => {
  it('paints live green, disconnected and silent amber, never sampled faded amber, each with its words', () => {
    const { container } = mount();
    const amber = container.querySelector('[data-client-id="c-amber"]');
    const pills = pillsOf(amber);
    expect(pills.map((pill) => pill.className)).toEqual([
      'account-pill tracker-live tone-live',
      'account-pill tracker-disconnected tone-attention',
      'account-pill tracker-live tone-live',
    ]);
    expect(pills.map((pill) => pillText(pill, 'name'))).toEqual(['A-1', 'A-2', 'A-3']);
    expect(pills.map((pill) => pillText(pill, 'state'))).toEqual(['Live', 'Disconnected', 'Live']);
    expect(pills.map((pill) => pillText(pill, 'run'))).toEqual(['running', 'running', 'running']);
    const title = pills[1].querySelector('.account-pill-button').getAttribute('title');
    expect(title).toContain('A-2: Disconnected.');
    expect(title).toContain('Connection Rithmic.');
    expect(title).toContain('not connected to its broker');
    expect(title).toContain('ConnectionLost');

    const quiet = container.querySelector('[data-client-id="c-silent"]');
    const quietPills = pillsOf(quiet);
    expect(quietPills[1].className).toBe('account-pill tracker-sample_stale tone-attention');
    expect(pillText(quietPills[1], 'state')).toBe('Silent');
    // No run word under a silent account: its last "running" is about a machine that stopped answering.
    expect(pillText(quietPills[1], 'run')).toBeNull();

    // The run state is the second word under a live pill, because what a live
    // account is DOING is the question once its colour has said it is alive.
    const green = container.querySelector('[data-client-id="c-green"]');
    expect(pillsOf(green).map((pill) => pillText(pill, 'run'))).toEqual(['running', 'all off']);
  });

  it('says the connection on every pill, and "No connection name" muted when the sample has none', () => {
    const { container } = mount();
    const amber = container.querySelector('[data-client-id="c-amber"]');
    const connections = pillsOf(amber).map((pill) => pill.querySelector('.account-pill-connection'));
    expect(connections.map((node) => node.textContent)).toEqual(['Rithmic', 'Rithmic', 'No connection name']);
    expect(connections.map((node) => node.className)).toEqual([
      'account-pill-connection', 'account-pill-connection', 'account-pill-connection absent',
    ]);
    // Still live and green: the missing name is a label, not a health signal.
    expect(pillsOf(amber)[2].className).toBe('account-pill tracker-live tone-live');
    const green = container.querySelector('[data-client-id="c-green"]');
    expect(pillsOf(green).map((pill) => pillText(pill, 'connection'))).toEqual(['Rithmic', 'Bluesky']);
  });

  it('the palette is the client page\'s: live green, disconnected or silent amber, never sampled faint', () => {
    expect(DOT_TONES).toEqual({
      live: 'live',
      disconnected: 'attention',
      sample_stale: 'attention',
      never_sampled: 'faint',
    });
  });

  it('gives a registered account nobody has sampled a pill of its own, and leaves retired accounts out', () => {
    const clients = [client('c-1', 'One', [['S-1'], ['S-2'], ['S-old', 'Inactive'], ['S-dead', 'Failed'], ['S-hold', 'Payout Hold']])];
    const { container } = render(<FleetStatusLights
      clients={clients}
      tracker={tracker({ 'c-1': [sample('S-1')] })}
      now={NOW}
      loadStrategies={neverAnswers}
    />);
    const pills = [...container.querySelectorAll('.account-pill')];
    // One sampled, two registered and expected to trade: three pills. Inactive and
    // Failed are not expected to sample, so a light on them would be a false alarm.
    expect(pills.map((pill) => `${pillText(pill, 'name')}: ${pillText(pill, 'state')}${pillText(pill, 'run') ? `, ${pillText(pill, 'run')}` : ''}`)).toEqual([
      'S-1: Live, running',
      'S-2: Never sampled',
      'S-hold: Never sampled',
    ]);
    expect(pills[1].className).toBe('account-pill tracker-never_sampled tone-faint');
    expect(pillText(pills[1], 'connection')).toBe('No connection name');
    // Honest about what the browser cannot see: it does not claim a paired VPS.
    const title = pills[1].querySelector('.account-pill-button').getAttribute('title');
    expect(title).toContain('Open the client to see whether a VPS is paired');
    expect(title).not.toContain('paired and answering');
    expect(container.textContent).toContain('2 registered and never sampled');
  });

  it('counts one pill per account and no more, whatever the sample order', () => {
    const clients = [client('c-1', 'One', [['Z-1'], ['Y-2']])];
    const { container } = render(<FleetStatusLights
      clients={clients}
      tracker={tracker({ 'c-1': [sample('Y-2'), sample('Z-1'), sample('X-3')] })}
      now={NOW}
      loadStrategies={neverAnswers}
    />);
    expect(container.querySelectorAll('.account-pill').length).toBe(3);
    expect([...container.querySelectorAll('.account-pill')].map((pill) => pill.getAttribute('data-account')))
      .toEqual(['X-3', 'Y-2', 'Z-1']);
  });
});

describe('worst first', () => {
  it('sorts the client that is not connected above the silent one, above the unsampled one, above the all-live one', () => {
    const { container } = mount();
    expect(tileNames(container)).toEqual(['Amber Pine', 'Silent Elm', 'Grey Birch', 'Green Oak']);
    const worst = [...container.querySelectorAll('.fsl-tile')].map((tile) => tile.getAttribute('data-worst'));
    expect(worst).toEqual(['disconnected', 'sample_stale', 'none', 'live']);
  });

  it('tints each tile by its worst account and says that state in a word on the tile', () => {
    const { container } = mount();
    const tiles = [...container.querySelectorAll('.fsl-tile')];
    expect(tiles.map((tile) => tile.className)).toEqual([
      'fsl-tile tone-attention',
      'fsl-tile tone-attention',
      'fsl-tile tone-none',
      'fsl-tile tone-live',
    ]);
    expect(tiles.map((tile) => tile.querySelector('.fsl-tile-state').textContent))
      .toEqual(['Disconnected', 'Silent', 'No sample yet', 'All live']);
  });

  it('a registered account never sampled ranks the tile above a client nothing has sampled', () => {
    const clients = [
      client('c-none', 'Nothing Yet', [['N-1']]),
      client('c-faint', 'Half Sampled', [['H-1'], ['H-2']]),
    ];
    const { container } = render(<FleetStatusLights
      clients={clients}
      tracker={tracker({ 'c-faint': [sample('H-1')] })}
      now={NOW}
      loadStrategies={neverAnswers}
    />);
    expect(tileNames(container)).toEqual(['Half Sampled', 'Nothing Yet']);
    expect(container.querySelector('[data-client-id="c-faint"]').className).toBe('fsl-tile tone-faint');
    expect(container.querySelector('[data-client-id="c-faint"] .fsl-tile-state').textContent).toBe('Never sampled');
  });

  it('breaks a tie on how many accounts need a look, then on the name', () => {
    const view = buildFleetStatusLights({
      now: NOW,
      clients: [
        client('a', 'Alpha', [['A-1'], ['A-2']]),
        client('b', 'Beta', [['B-1'], ['B-2']]),
        client('c', 'Gamma', [['C-1'], ['C-2']]),
      ],
      tracker: tracker({
        a: [disconnected('A-1'), sample('A-2')],
        b: [disconnected('B-1'), disconnected('B-2')],
        c: [disconnected('C-1'), sample('C-2')],
      }),
    });
    expect(view.tiles.map((tile) => tile.clientName)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('builds every dot as the shared pill, with the connection and the rank', () => {
    const view = buildFleetStatusLights({ clients: CLIENTS, tracker: tracker(SAMPLES), now: NOW });
    const amber = view.tiles.find((tile) => tile.clientId === 'c-amber');
    expect(amber.dots.map((dot) => [dot.accountName, dot.connectionWord, dot.label, dot.runLabel, dot.rank])).toEqual([
      ['A-1', 'Rithmic', 'Live', 'running', 1],
      ['A-2', 'Rithmic', 'Disconnected', 'running', 5],
      ['A-3', 'No connection name', 'Live', 'running', 1],
    ]);
    expect(amber.dots[0].title).toBe('A-1: Live. Connection Rithmic. Sampled 4 minutes ago. Strategies: running.');
    expect(amber.clientKey).toBe('c-amber');
  });
});

describe('words beside every colour', () => {
  it('prints a legend naming all four tones and the amber marker', () => {
    const { container } = mount();
    const legend = [...container.querySelectorAll('.fsl-legend-item')];
    expect(legend.map((item) => item.className)).toEqual([
      'fsl-legend-item tone-live',
      'fsl-legend-item tone-attention',
      'fsl-legend-item tone-faint',
      'fsl-legend-item tone-none',
      'fsl-legend-item fsl-legend-mark',
    ]);
    expect(legend.map((item) => item.textContent)).toEqual([
      'Live',
      'Disconnected or silent',
      'Never sampled',
      'No sample for this client',
      'Amber corner: an algorithm differs from the desk',
    ]);
    expect(LEGEND.length).toBe(4);
  });

  it('every pill has visible words and every tile a visible state word', () => {
    const { container } = mount();
    const pills = [...container.querySelectorAll('.account-pill')];
    expect(pills.length).toBe(8);
    for (const pill of pills) {
      expect(pillText(pill, 'name').trim()).not.toBe('');
      expect(pillText(pill, 'connection').trim()).not.toBe('');
      expect(pillText(pill, 'state').trim()).not.toBe('');
      expect(pill.querySelector('.account-pill-button').getAttribute('title')).toMatch(/: /);
    }
    for (const tile of container.querySelectorAll('.fsl-tile')) {
      expect(tile.querySelector('.fsl-tile-state').textContent.trim()).not.toBe('');
      expect(tile.querySelector('.fsl-tile-words').textContent.trim()).not.toBe('');
    }
  });

  it('says on the tile what the pills add up to, and when the latest sample was', () => {
    const { container } = mount();
    const amber = container.querySelector('[data-client-id="c-amber"] .fsl-tile-words').textContent;
    expect(amber).toBe('3 accounts sampled: 2 running, 1 disconnected. Latest sample 4m ago.');
    const grey = container.querySelector('[data-client-id="c-grey"] .fsl-tile-words').textContent;
    expect(grey).toContain('1 account on the registry, none sampled.');
    expect(grey).toContain('Either no VPS is paired with this client or it has not sampled yet.');
  });
});

describe('the one line over the grid', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses the tracker summary and says how many clients it covers', () => {
    const { container } = mount();
    const line = container.querySelector('.fsl-summary').textContent;
    // 7 sampled across three clients: 5 running, 1 all off, 1 disconnected, 1 silent.
    expect(line).toContain('7 accounts sampled: 4 running, 1 all off, 1 disconnected, 1 silent, across 3 of 4 clients. Latest sample 4m ago.');
  });

  it('says when it was updated and that it refreshes every two minutes, and ages that without a read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T15:00:40.000Z'));
    const { container } = mount();
    const note = () => container.querySelector('.fsl-summary .live-refresh').textContent;
    expect(note()).toBe('Updated 40 s ago, refreshes every 2 min.');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(note()).toBe('Updated 50 s ago, refreshes every 2 min.');
    expect(neverAnswers).not.toHaveBeenCalled();
  });

  it('prints the cadence it is handed, never a literal of its own', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T15:00:05.000Z'));
    const { container } = mount({ refreshMs: 60_000 });
    expect(container.querySelector('.live-refresh').textContent).toBe('Updated just now, refreshes every 1 min.');
  });

  it('is computed from the same rows the tiles show, so the two cannot disagree', () => {
    const view = buildFleetStatusLights({ clients: CLIENTS, tracker: tracker(SAMPLES), now: NOW });
    const dotsFromTiles = view.tiles.flatMap((tile) => tile.dots.filter((dot) => dot.state !== 'never_sampled'));
    expect(view.summary.total).toBe(dotsFromTiles.length);
    expect(view.summary.disconnected).toBe(dotsFromTiles.filter((dot) => dot.state === 'disconnected').length);
    expect(view.summary.silent).toBe(dotsFromTiles.filter((dot) => dot.state === 'sample_stale').length);
    expect(view.clientsSampled).toBe(3);
    expect(view.clientsTotal).toBe(4);
  });
});

describe('a tile opens its client, a pill opens its account', () => {
  it('calls onSelectClient with the client id from the tile head, and never from a pill', () => {
    const onSelectClient = vi.fn();
    const { container } = mount({ onSelectClient });
    container.querySelector('[data-client-id="c-silent"] .fsl-tile-button').click();
    expect(onSelectClient).toHaveBeenCalledTimes(1);
    expect(onSelectClient).toHaveBeenCalledWith('c-silent');
    act(() => { container.querySelector('[data-client-id="c-silent"] .account-pill-button').click(); });
    expect(onSelectClient).toHaveBeenCalledTimes(1);
  });

  it('renders no head button when nothing can be opened, and the pills stay buttons', () => {
    const { container } = mount({ onSelectClient: null });
    expect(container.querySelectorAll('button.fsl-tile-button').length).toBe(0);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(4);
    expect(container.querySelectorAll('button.account-pill-button').length).toBe(8);
    // No button inside a button, anywhere.
    expect(container.querySelectorAll('button button').length).toBe(0);
  });

  it('expands one account per tile with what it is running, read on demand for that client', async () => {
    const loadStrategies = vi.fn(async ({ clientId }) => strategiesAnswer(clientId, [
      strategyRow('c-amber', 'A-1', { realizedPnl: -480, unrealizedPnl: 0 }),
      strategyRow('c-amber', 'A-2', { strategyId: '2' }),
    ]));
    const { container } = mount({ loadStrategies });
    const amber = container.querySelector('[data-client-id="c-amber"]');
    const [a1, a2] = pillsOf(amber).map((pill) => pill.querySelector('.account-pill-button'));
    expect(amber.querySelector('.account-live-detail')).toBeNull();
    expect(loadStrategies).not.toHaveBeenCalled();

    act(() => { a1.click(); });
    expect(a1.getAttribute('aria-expanded')).toBe('true');
    expect(a1.getAttribute('aria-controls')).toBe(amber.querySelector('.account-live-detail').getAttribute('id'));
    expect(amber.querySelectorAll('.account-live-detail').length).toBe(1);
    // One select for the client, by the key the rows carry.
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledTimes(1));
    expect(loadStrategies).toHaveBeenCalledWith({ clientId: 'c-amber' });
    await waitFor(() => expect(amber.querySelectorAll('.account-live-strategy').length).toBe(1));
    const detail = amber.querySelector('.account-live-detail');
    expect(detail.querySelector('.account-live-detail-connection').textContent).toBe('Connection Rithmic');
    expect(detail.textContent).toContain('OGX_PF');
    expect(detail.textContent).toContain('MNQ 12-26');
    expect(detail.textContent).toContain('Within the usual spread of the desk');
    expect(detail.querySelector('.account-live-strategy-differs')).toBeNull();

    // A second pill on the same tile replaces the first: one open per tile, and
    // no second read, the client's rows are already in hand.
    act(() => { a2.click(); });
    expect(a1.getAttribute('aria-expanded')).toBe('false');
    expect(a2.getAttribute('aria-expanded')).toBe('true');
    expect(amber.querySelectorAll('.account-live-detail').length).toBe(1);
    expect(amber.querySelector('.account-live-detail strong').textContent).toBe('A-2');
    expect(amber.querySelector('.account-live-strategy-differs').textContent).toBe('Differs from the desk');
    expect(loadStrategies).toHaveBeenCalledTimes(1);

    // The same pill again closes it.
    act(() => { a2.click(); });
    expect(amber.querySelector('.account-live-detail')).toBeNull();
    expect(a2.getAttribute('aria-expanded')).toBe('false');
    // Other tiles are untouched and have read nothing.
    expect(container.querySelectorAll('.account-live-detail').length).toBe(0);
    expect(loadStrategies.mock.calls.every(([args]) => args.clientId === 'c-amber')).toBe(true);
  });

  it('puts the amber marker on the pill whose algorithm differs, and on no other, once the rows are known', async () => {
    const loadStrategies = vi.fn(async ({ clientId }) => strategiesAnswer(clientId, [
      strategyRow('c-amber', 'A-1', { realizedPnl: -480, unrealizedPnl: 0 }),
      strategyRow('c-amber', 'A-2', { strategyId: '2' }),
    ]));
    const { container } = mount({ loadStrategies });
    const amber = container.querySelector('[data-client-id="c-amber"]');
    expect(amber.querySelectorAll('.account-pill.differs').length).toBe(0);
    act(() => { pillsOf(amber)[0].querySelector('button').click(); });
    await waitFor(() => expect(amber.querySelectorAll('.account-pill.differs').length).toBe(1));
    const marked = amber.querySelector('.account-pill.differs');
    expect(marked.getAttribute('data-account')).toBe('A-2');
    expect(marked.querySelector('.account-pill-mark')).not.toBeNull();
    expect(marked.querySelector('button').getAttribute('title')).toContain('1 algorithm differs from the desk.');
    // The marker is not the colour: A-2 is still the disconnected amber pill it was.
    expect(marked.className).toBe('account-pill tracker-disconnected tone-attention differs');
    // (A-1 is the open one, so it also carries `expanded`; it carries no marker.)
    expect(pillsOf(amber)[0].className).toBe('account-pill tracker-live tone-live expanded');
    // Closing the detail keeps the marker: the answer is cached for the client.
    act(() => { pillsOf(amber)[0].querySelector('button').click(); });
    expect(amber.querySelector('.account-live-detail')).toBeNull();
    expect(amber.querySelectorAll('.account-pill.differs').length).toBe(1);
  });

  it('reads the rows by the uuid when the client has a legacy key, and finds them under it', async () => {
    const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
    const legacy = { ...client('act-1700000000-ash', 'Ash', [['APEX-1']]), uuid: UUID };
    const loadStrategies = vi.fn(async ({ clientId }) => strategiesAnswer(clientId, [strategyRow(UUID, 'APEX-1')]));
    const { container } = render(<FleetStatusLights
      clients={[legacy]}
      tracker={tracker({ [UUID]: [sample('APEX-1')] })}
      now={NOW}
      loadStrategies={loadStrategies}
    />);
    act(() => { container.querySelector('.account-pill-button').click(); });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledWith({ clientId: UUID }));
    await waitFor(() => expect(container.querySelectorAll('.account-live-strategy').length).toBe(1));
    expect(container.querySelector('.account-pill.differs')).not.toBeNull();
  });

  it('says it could not read what is running, inside the detail and never as a banner', async () => {
    const loadStrategies = vi.fn(async () => { throw new Error('timeout'); });
    const { container } = mount({ loadStrategies });
    const amber = container.querySelector('[data-client-id="c-amber"]');
    act(() => { pillsOf(amber)[0].querySelector('button').click(); });
    await waitFor(() => expect(amber.textContent).toContain('Could not read what is running.'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The account totals from the tracker sample are still shown.
    expect(amber.querySelector('.account-live-detail').textContent).toContain('$120');
    // And the pills keep their colour and carry no marker.
    expect(amber.querySelectorAll('.account-pill.differs').length).toBe(0);
  });
});

describe('three honest empty states', () => {
  it('step 55 not run: says so and claims nothing about any machine', () => {
    const { container } = mount({ tracker: null });
    expect(container.textContent).toContain('Live account tracking is not available on this CRM yet.');
    expect(container.textContent).toContain('Migration step 55 has not been run');
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
    expect(container.textContent).not.toContain('No collector sends live samples yet');
  });

  it('nothing sampled anywhere and no build named: names the build that samples and the column that turns it on', () => {
    const { container } = mount({ tracker: tracker({}, { minAgentVersion: null }) });
    expect(container.textContent).toContain('No collector sends live samples yet.');
    expect(container.textContent).toContain(`collector build ${LIVE_SAMPLING_BUILD}`);
    expect(LIVE_SAMPLING_BUILD).toBe('1.2.0');
    expect(container.textContent).toContain('account_tracker_settings.min_agent_version');
    expect(container.textContent).toContain('4 clients in this book');
    expect(container.textContent).toContain('The daily close is unaffected by this.');
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
  });

  it('nothing sampled and a build named: names THAT build rather than the literal', () => {
    const { container } = mount({ tracker: tracker({}, { minAgentVersion: '1.3.0' }) });
    expect(container.textContent).toContain('collector build 1.3.0 or newer');
    expect(container.textContent).not.toContain('1.2.0');
    expect(container.textContent).not.toContain('min_agent_version');
  });

  it('a client no VPS has reached is a grey tile that says so, beside the lit ones', () => {
    const { container } = mount();
    const grey = container.querySelector('[data-client-id="c-grey"]');
    expect(grey.className).toBe('fsl-tile tone-none');
    expect(grey.querySelector('.fsl-tile-state').textContent).toBe('No sample yet');
    expect(grey.textContent).toContain('Either no VPS is paired with this client or it has not sampled yet.');
    // Its registered account still gets a pill, faint, so it is visibly unsampled.
    expect(grey.querySelectorAll('.account-pill.tone-faint').length).toBe(1);
  });

  it('an empty book says so instead of rendering nothing', () => {
    const { container } = mount({ clients: [] });
    expect(container.textContent).toContain('No client in this book to light.');
  });
});

/* ------------------------------------------------------------------------- *
 * THE "CLOSE DIFFERS" BADGE ON THE TILES (step 66).
 *
 * The overview's read of today's pinned readings hands the lights a Map of
 * client key to (lower case account name to verdict). A pill whose verdict asks
 * for a look carries the amber badge in words, with the verdict in its title;
 * every other pill is untouched; the legend names the badge only when a Map was
 * handed at all. The lookup follows the identity rule: the Map may be keyed by
 * the client's uuid (the tile's clientKey) or by its id.
 * ------------------------------------------------------------------------- */
describe('the "Close differs" badge from today\'s close', () => {
  const badgesIn = (root) => [...root.querySelectorAll('.fsl-tile .account-pill-close-differs')];
  const greenDiffers = () => new Map([['c-green', new Map([['g-1', 'differs']])]]);

  it('puts the badge on the one account whose verdict asks for a look, with the verdict in its title, and on no other', () => {
    const { container } = mount({ closeVerdicts: greenDiffers() });
    const badges = badgesIn(container);
    expect(badges).toHaveLength(1);
    const pill = badges[0].closest('.account-pill');
    expect(pill.getAttribute('data-account')).toBe('G-1');
    expect(pill.closest('.fsl-tile').getAttribute('data-client-id')).toBe('c-green');
    expect(badges[0].textContent).toBe('Close differs');
    expect(badges[0].getAttribute('title')).toBe('Close differs: the realized figures differ.');
    expect(pill.querySelector('.account-pill-button').getAttribute('title')).toContain('Close differs: the realized figures differ.');
    // The badge is never the pill's colour: G-1 is still the live green pill it was.
    expect(pill.className).toBe('account-pill tracker-live tone-live close-differs');
    const green = container.querySelector('[data-client-id="c-green"]');
    expect(pillsOf(green).find((item) => item.getAttribute('data-account') === 'G-2').querySelector('.account-pill-close-differs')).toBeNull();
    const amber = container.querySelector('[data-client-id="c-amber"]');
    expect(amber.querySelectorAll('.account-pill-close-differs').length).toBe(0);
    expect(amber.querySelectorAll('.account-pill.close-differs').length).toBe(0);
  });

  it('names the badge in the legend when a Map is handed, and not when nothing is known about the close', () => {
    const withMap = mount({ closeVerdicts: greenDiffers() });
    const legendItem = withMap.container.querySelector('.fsl-legend-close');
    expect(legendItem).not.toBeNull();
    expect(legendItem.className).toBe('fsl-legend-item fsl-legend-close');
    expect(legendItem.querySelector('.account-pill-close-differs').textContent).toBe('Close differs');
    expect(legendItem.textContent).toContain('The tracker and today\'s close disagree about the account');
    expect(withMap.container.querySelectorAll('.fsl-legend-item').length).toBe(6);
    withMap.unmount();

    const without = mount({ closeVerdicts: null });
    expect(without.container.querySelector('.fsl-legend-close')).toBeNull();
    expect(without.container.querySelectorAll('.account-pill-close-differs').length).toBe(0);
    expect(without.container.querySelectorAll('.fsl-legend-item').length).toBe(5);
    without.unmount();

    // An empty Map says the read ran and found nothing to flag: the legend names the badge, no pill carries it.
    const empty = mount({ closeVerdicts: new Map() });
    expect(empty.container.querySelector('.fsl-legend-close')).not.toBeNull();
    expect(badgesIn(empty.container)).toHaveLength(0);
  });

  it('leaves a pill alone for a verdict that agrees or says nothing to compare', () => {
    const { container } = mount({
      closeVerdicts: new Map([['c-green', new Map([['g-1', 'matches'], ['g-2', 'after_close']])], ['c-amber', new Map([['a-1', 'settled_at_close']])]]),
    });
    expect(badgesIn(container)).toHaveLength(0);
    expect(container.querySelectorAll('.account-pill.close-differs').length).toBe(0);
    // The legend still names it: a Map was handed.
    expect(container.querySelector('.fsl-legend-close')).not.toBeNull();
  });

  it('finds the verdicts under the client uuid (the tile\'s clientKey) as well as under its id', () => {
    const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
    const legacy = { ...client('act-1700000000-ash', 'Ash', [['APEX-1'], ['APEX-2']]), uuid: UUID };
    const lights = (closeVerdicts) => render(<FleetStatusLights
      clients={[legacy]}
      tracker={tracker({ [UUID]: [sample('APEX-1'), sample('APEX-2')] })}
      now={NOW}
      loadStrategies={neverAnswers}
      closeVerdicts={closeVerdicts}
    />);
    const byUuid = lights(new Map([[UUID, new Map([['apex-1', 'tracker_only']])]]));
    let badges = badgesIn(byUuid.container);
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('.account-pill').getAttribute('data-account')).toBe('APEX-1');
    expect(badges[0].getAttribute('title')).toBe('Close differs: tracker only.');
    byUuid.unmount();

    const byId = lights(new Map([['act-1700000000-ash', new Map([['apex-2', 'close_only']])]]));
    badges = badgesIn(byId.container);
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('.account-pill').getAttribute('data-account')).toBe('APEX-2');
    expect(badges[0].getAttribute('title')).toBe('Close differs: close only.');
    byId.unmount();

    // A Map about some other client says nothing about this one.
    const elsewhere = lights(new Map([['someone-else', new Map([['apex-1', 'differs']])]]));
    expect(badgesIn(elsewhere.container)).toHaveLength(0);
  });
});

describe('a client with a legacy key', () => {
  /* On a real book a client's `id` is its legacy key and `uuid` is the row's
   * uuid. The tracker keys samples by client_id, which is the uuid, so a lookup
   * by `id` found nothing and every client read as never sampled. */
  const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
  const legacy = { ...client('act-1700000000-ash', 'Ash', [['APEX-1']]), uuid: UUID };

  it('finds its samples under the uuid', () => {
    const view = buildFleetStatusLights({ clients: [legacy], tracker: tracker({ [UUID]: [sample('APEX-1')] }), now: NOW });
    expect(view.kind).toBe('ready');
    expect(view.tiles[0].summary.rows[0].sample.accountName).toBe('APEX-1');
    expect(view.tiles[0].worst.state).toBe('live');
    // And the key the strategies read is scoped by is the uuid too.
    expect(view.tiles[0].clientKey).toBe(UUID);
    expect(view.tiles[0].clientId).toBe('act-1700000000-ash');
  });

  it('still finds samples keyed by id for a client without a uuid', () => {
    const plain = client('c-plain', 'Plain', [['APEX-2']]);
    const view = buildFleetStatusLights({ clients: [plain], tracker: tracker({ 'c-plain': [sample('APEX-2')] }), now: NOW });
    expect(view.tiles[0].summary.rows[0].sample.accountName).toBe('APEX-2');
    expect(view.tiles[0].clientKey).toBe('c-plain');
  });
});

/* ------------------------------------------------------------------------- *
 * ONLY THE ACCOUNTS EXPECTED TO TRADE GET A LIGHT.
 *
 * Pedro's words: the lights kept showing dead accounts as never sampled. The
 * database now says what the closes saw of every registry row (step 65), so a
 * tile draws a pill for the expected accounts only, says "New, not sampled yet"
 * on a new one, and folds the rest into one muted line under the tile with a
 * Show toggle, so a CAM can tell a dead account from a new one from a missing
 * one. Fictional client, fictional accounts.
 * ------------------------------------------------------------------------- */
describe('only the accounts expected to trade get a light', () => {
  const observed = (accountName, over = {}) => [accountName, {
    accountName, status: 'Active', accountType: 'Funded', observedState: 'seen',
    closesMissed: 0, lastCloseSeenOn: '2026-10-04', dateAdded: '2026-06-01', ...over,
  }];
  const MAPLE_ROWS = [
    observed('ACC 01'),
    observed('ACC 02'),
    observed('ACC 03', { observedState: 'breached', breachedOn: '2026-10-04', breachReading: -263 }),
    observed('ACC 04', { observedState: 'absent', closesMissed: 6, lastCloseSeenOn: '2026-09-26' }),
    observed('ACC 05', { observedState: 'never_seen', lastCloseSeenOn: '', dateAdded: '2026-10-02' }),
  ];
  function mapleRidge(rows = MAPLE_ROWS, extra = {}) {
    return { id: 'c-maple', name: 'Maple Ridge', profile: { stage: 'Active' }, accountRegistry: Object.fromEntries(rows), ...extra };
  }
  const settingsNever = vi.fn(() => new Promise(() => {}));
  function lights(props = {}) {
    return render(<FleetStatusLights
      clients={[mapleRidge()]}
      tracker={tracker({ 'c-maple': [sample('ACC 01')] })}
      now={NOW}
      loadStrategies={neverAnswers}
      loadObservationSettings={settingsNever}
      {...props}
    />);
  }
  const names = (container) => [...container.querySelectorAll('.account-pill')]
    .map((pill) => `${pillText(pill, 'name')}: ${pillText(pill, 'state')}`);
  const lineWords = (container) => container.querySelector('.fsl-tile .not-shown .not-shown-words')?.textContent ?? null;

  afterEach(() => resetAccountObservationSettingsCache());

  it('draws a pill for the two seen and the new one, and none for the account that looks failed or the one gone from the close', () => {
    const { container } = lights();
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(container.querySelectorAll('.account-pill').length).toBe(3);
    // Folded: the hidden names are not on the tile until Show is clicked.
    expect(container.textContent).not.toContain('ACC 03');
    expect(container.textContent).not.toContain('ACC 04');
    expect(container.querySelector('.fsl-tile').className).toBe('fsl-tile tone-faint');
  });

  it('the new account reads "New, not sampled yet" on the pill and in its title, faint like a never sampled one', () => {
    const { container } = lights();
    const fresh = container.querySelector('.account-pill[data-account="ACC 05"]');
    expect(fresh.className).toBe('account-pill tracker-never_sampled tone-faint');
    expect(pillText(fresh, 'state')).toBe('New, not sampled yet');
    expect(pillText(fresh, 'connection')).toBe('No connection name');
    const title = fresh.querySelector('.account-pill-button').getAttribute('title');
    expect(title).toContain('ACC 05: New, not sampled yet.');
    expect(title).toContain('Added 3 days ago, not seen in a close yet.');
    expect(title).toContain('Open the client to see whether a VPS is paired');
    // The one that is not new keeps the old word.
    const plain = container.querySelector('.account-pill[data-account="ACC 02"]');
    expect(pillText(plain, 'state')).toBe('Never sampled');
    expect(plain.querySelector('.account-pill-button').getAttribute('title')).not.toContain('not seen in a close');
    // The tile's own sentence counts the two apart.
    expect(container.querySelector('.fsl-tile-words').textContent)
      .toBe('1 account sampled: 1 running, 1 registered and never sampled, 1 new and not sampled yet. Latest sample 4m ago.');
  });

  it('says in one folded line why the others are not shown, and Show lists them with a reason word', () => {
    const { container } = lights();
    const line = container.querySelector('.fsl-tile .not-shown');
    expect(lineWords(container)).toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes.');
    expect(line.querySelector('.not-shown-words').className).toContain('muted');
    const toggle = line.querySelector('button.not-shown-toggle');
    expect(toggle.textContent).toBe('Show');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(line.querySelector('.not-shown-list')).toBeNull();
    act(() => { toggle.click(); });
    expect(toggle.textContent).toBe('Hide');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = line.querySelector('.not-shown-list');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    expect(list.className).toContain('muted');
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['ACC 03 looks failed', 'ACC 04 gone from the close']);
    expect(list.querySelector('li').getAttribute('title')).toBe('Breached on 2026-10-04, reading -$263, status still Active.');
    // The line sits under the pills and the tile sentence, and no button is inside a button.
    expect(container.querySelector('.fsl-tile-words').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('button button').length).toBe(0);
    act(() => { toggle.click(); });
    expect(line.querySelector('.not-shown-list')).toBeNull();
  });

  it('prints no line at all when every account on the registry is expected', () => {
    const { container } = lights({ clients: [mapleRidge([MAPLE_ROWS[0], MAPLE_ROWS[1], MAPLE_ROWS[4]])] });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(container.querySelector('.not-shown')).toBeNull();
    expect(container.textContent).not.toContain('Not shown');
  });

  it('counts the retired accounts in the line too, so a dead account is told from a missing one', () => {
    const { container } = lights({
      clients: [mapleRidge([
        ...MAPLE_ROWS,
        observed('ACC 06', { status: 'Failed', observedState: 'breached', breachedOn: '2026-10-01' }),
        observed('ACC 07', { status: 'Inactive' }),
      ])],
    });
    expect(names(container).length).toBe(3);
    expect(lineWords(container)).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. 2 retired: 1 Failed, 1 Inactive.',
    );
    act(() => { container.querySelector('.not-shown-toggle').click(); });
    expect([...container.querySelectorAll('.not-shown-list li')].map((item) => item.textContent))
      .toEqual(['ACC 03 looks failed', 'ACC 04 gone from the close', 'ACC 06 Failed', 'ACC 07 Inactive']);
  });

  it('keeps a pill for an account the VPS sampled that the registry lacks, or that the close hid', () => {
    const { container } = lights({
      tracker: tracker({ 'c-maple': [sample('ACC 01'), sample('ACC 03'), sample('ACC 09', { connectionName: 'Bluesky' })] }),
    });
    // ACC 03 looks failed on the close and NinjaTrader has it connected and
    // running: a pill, in the registry, with the question on it in words;
    // ACC 09 is not on the registry at all: a pill too, with no marker.
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 03: Live', 'ACC 05: New, not sampled yet', 'ACC 09: Live']);
    // And the line counts only what has no light anywhere.
    expect(lineWords(container)).toBe('Not shown: 1 gone from the close for 6 closes.');
    const marked = container.querySelector('.account-pill[data-account="ACC 03"]');
    expect(marked.querySelector('.account-pill-marked').textContent).toBe('Looks failed');
    expect(marked.querySelector('.account-pill-button').getAttribute('title')).toContain('ACC 03: Live. Looks failed on the close but still running.');
    expect(container.querySelector('.account-pill[data-account="ACC 09"] .account-pill-marked')).toBeNull();
    expect(container.querySelector('.fsl-tile-words').textContent).toContain('1 retired but still running');
  });

  /* Measured in production: accounts the database marked Failed on last
   * night's close are still in NinjaTrader's Accounts tab, disconnected with
   * nothing loaded, so the VPS samples them and they lit amber. Now they are
   * the folded line only: no pill, no amber tile, not in any count. */
  it('a Failed account NinjaTrader still lists disconnected is no pill and no amber: the line says so', () => {
    const { container } = lights({
      clients: [mapleRidge([...MAPLE_ROWS, observed('ACC 06', { status: 'Failed' })])],
      tracker: tracker({ 'c-maple': [
        sample('ACC 01'),
        disconnected('ACC 06'),
        sample('ACC 03', { connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 }),
      ] }),
    });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(container.querySelector('.fsl-tile').className).toBe('fsl-tile tone-faint');
    expect(container.querySelector('.fsl-tile-words').textContent)
      .toBe('1 account sampled: 1 running, 1 registered and never sampled, 1 new and not sampled yet. Latest sample 4m ago.');
    expect(container.querySelector('.fsl-summary').textContent).toContain('1 account sampled: 1 running, across 1 of 1 client.');
    expect(lineWords(container)).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. 1 retired: 1 Failed. '
      + '2 still listed by NinjaTrader, disconnected.',
    );
    act(() => { container.querySelector('.not-shown-toggle').click(); });
    expect([...container.querySelectorAll('.not-shown-list li')].map((item) => item.textContent)).toEqual([
      'ACC 03 looks failed, still listed by NinjaTrader, disconnected',
      'ACC 04 gone from the close',
      'ACC 06 Failed, still listed by NinjaTrader, disconnected',
    ]);
  });

  it('a Failed account still connected and running keeps its pill with "Marked Failed", and the domain counts it', () => {
    const clients = [mapleRidge([...MAPLE_ROWS, observed('ACC 06', { status: 'Failed' })])];
    const { container } = lights({ clients, tracker: tracker({ 'c-maple': [sample('ACC 01'), sample('ACC 06')] }) });
    const pill = container.querySelector('.account-pill[data-account="ACC 06"]');
    expect(pill.className).toBe('account-pill tracker-live tone-live marked');
    expect(pill.querySelector('.account-pill-marked').textContent).toBe('Marked Failed');
    expect(pill.querySelector('.account-pill-button').getAttribute('title')).toContain('Marked Failed but still running.');
    const view = buildFleetStatusLights({ clients, tracker: tracker({ 'c-maple': [sample('ACC 01'), sample('ACC 06')] }), now: NOW });
    expect(view.tiles[0].marked).toEqual([{ accountName: 'ACC 06', words: 'Marked Failed but still running' }]);
    expect(view.tiles[0].summary.total).toBe(2);
  });

  it('an account the registry does not have keeps its pill, disconnected, and colours the tile as before', () => {
    const { container } = lights({ tracker: tracker({ 'c-maple': [sample('ACC 01'), disconnected('ACC 09')] }) });
    expect(names(container)).toContain('ACC 09: Disconnected');
    expect(container.querySelector('.fsl-tile').className).toBe('fsl-tile tone-attention');
  });

  it('a client whose VPS lists only dead accounts says so, instead of claiming no VPS', () => {
    const { container } = lights({
      clients: [mapleRidge([observed('ACC 06', { status: 'Failed' })]), client('c-green', 'Green Oak', [['G-1']])],
      tracker: tracker({ 'c-maple': [disconnected('ACC 06')], 'c-green': [sample('G-1')] }),
    });
    const tile = container.querySelector('.fsl-tile[data-client-id="c-maple"]');
    expect(tile.className).toBe('fsl-tile tone-none');
    expect(tile.querySelector('.fsl-tile-state').textContent).toBe('Only retired accounts sampled');
    expect(tile.querySelector('.fsl-tile-words').textContent).toBe('NinjaTrader lists only accounts not expected to trade, in the line below.');
  });

  it('reads new_account_days once and moves the line with it: at 2 days a 3 day old account is never seen, not new', async () => {
    const loadObservationSettings = vi.fn(async () => ({ available: true, staleCloses: 5, autoFailOnBreach: true, newAccountDays: 2 }));
    const { container } = lights({ loadObservationSettings });
    await waitFor(() => expect(container.querySelectorAll('.account-pill').length).toBe(2));
    expect(loadObservationSettings).toHaveBeenCalledTimes(1);
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled']);
    expect(lineWords(container)).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. '
      + '1 registered and never seen in a close, added more than 2 days ago.',
    );
    act(() => { container.querySelector('.not-shown-toggle').click(); });
    expect([...container.querySelectorAll('.not-shown-list li')].map((item) => item.textContent))
      .toContain('ACC 05 never seen in a close');
  });

  it('falls back to 14 days when the settings cannot be read, and says nothing about it', async () => {
    const loadObservationSettings = vi.fn(async () => { throw new Error('timeout'); });
    const { container } = lights({ loadObservationSettings });
    await waitFor(() => expect(loadObservationSettings).toHaveBeenCalled());
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(container.textContent).not.toMatch(/could not|failed to read|timeout/i);
  });

  it('finds the samples by the uuid and the registry on the client, for a client with a legacy key', () => {
    const UUID = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const legacy = mapleRidge(MAPLE_ROWS, { id: 'act-1700000000-maple', uuid: UUID });
    const view = buildFleetStatusLights({ clients: [legacy], tracker: tracker({ [UUID]: [sample('ACC 01')] }), now: NOW });
    expect(view.tiles[0].clientKey).toBe(UUID);
    expect(view.tiles[0].dots.map((dot) => `${dot.accountName}: ${dot.label}`)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(view.tiles[0].notShown.sentence).toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes.');
    // The settings reach the domain too, by the same name the loader maps.
    const tight = buildFleetStatusLights({ clients: [legacy], tracker: tracker({ [UUID]: [sample('ACC 01')] }), now: NOW, settings: { newAccountDays: 2 } });
    expect(tight.tiles[0].dots.map((dot) => dot.accountName)).toEqual(['ACC 01', 'ACC 02']);
    expect(tight.tiles[0].notShown.count).toBe(3);
  });

  it('a client whose expected accounts are all hidden still says so on a grey tile', () => {
    const { container } = lights({
      clients: [mapleRidge([MAPLE_ROWS[2], MAPLE_ROWS[3]]), client('c-green', 'Green Oak', [['G-1']])],
      tracker: tracker({ 'c-green': [sample('G-1')] }),
    });
    const tile = container.querySelector('[data-client-id="c-maple"]');
    expect(tile.className).toBe('fsl-tile tone-none');
    expect(tile.querySelectorAll('.account-pill').length).toBe(0);
    expect(tile.querySelector('.fsl-tile-words').textContent).toBe('No account expected on the close and none sampled.');
    expect(lineWords(container)).toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes.');
  });
});

/* ------------------------------------------------------------------------- *
 * A BOOK WHERE THE ONLY SAMPLES ARE OF RETIRED ACCOUNTS.
 *
 * The review's fixture: ACC 41 is marked Failed, and the VPS still sends it,
 * a few minutes old, not connected, nothing loaded. With that client alone in
 * the book, the panel said "No collector sends live samples yet", which is
 * false: a collector is sending. The grid shows the client with the tile's
 * words, and the line over it says the same.
 * ------------------------------------------------------------------------- */
describe('a book whose only samples are of retired accounts', () => {
  beforeEach(() => window.localStorage.clear());
  const QUIET = { id: 'c-quiet', name: 'Quiet Larch', profile: { stage: 'Active' }, accountRegistry: { 'ACC 41': { status: 'Failed' } } };
  const dead = () => sample('ACC 41', { connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 });

  it('reaches the grid, never "no collector sends live samples", and says only retired accounts are sampled', () => {
    const view = buildFleetStatusLights({ clients: [QUIET], tracker: tracker({ 'c-quiet': [dead()] }), now: NOW });
    expect(view.kind).toBe('ready');
    expect(view.onlyRetiredClients).toBe(1);
    expect(view.words).toBe('Only retired accounts sampled, across 1 of 1 client. Latest sample 4m ago.');
    expect(view.tiles[0].worst.word).toBe('Only retired accounts sampled');
    expect(view.tiles[0].lastSampledAt.toISOString()).toBe('2026-10-05T14:56:00.000Z');

    const { container } = mount({ clients: [QUIET], tracker: tracker({ 'c-quiet': [dead()] }) });
    expect(container.textContent).not.toContain('No collector sends live samples yet');
    expect(container.querySelector('.fsl-summary').textContent).toContain('Only retired accounts sampled, across 1 of 1 client. Latest sample 4m ago.');
    const bulb = container.querySelector('.fsl-bulb[data-client-id="c-quiet"]');
    expect(bulb.querySelector('.sr-only').textContent).toBe('Only retired accounts sampled');
    act(() => { bulb.querySelector('.fsl-bulb-button').click(); });
    const tile = container.querySelector('.fsl-drawer .fsl-tile');
    expect(tile.querySelector('.fsl-tile-words').textContent).toBe('NinjaTrader lists only accounts not expected to trade, in the line below.');
    act(() => { tile.querySelector('.not-shown-toggle').click(); });
    expect([...tile.querySelectorAll('.not-shown-list li')].map((node) => node.textContent)).toEqual(['ACC 41 Failed, still listed by NinjaTrader, disconnected']);
  });

  it('a book with nothing sampled at all still says no collector sends samples', () => {
    const view = buildFleetStatusLights({ clients: [QUIET], tracker: tracker({}), now: NOW });
    expect(view.kind).toBe('no_samples');
  });
});

/* ------------------------------------------------------------------------- *
 * COMPACT: ONE BULB PER CLIENT, THE TILE ONE CLICK AWAY.
 *
 * Pedro's words: the tiles should be the expanded version; summarised, just
 * one circle per client with the colours of the legend, so it works for both
 * and every client is on screen at once without scrolling. Compact is the
 * default; the bulb is the tile's worst tone in the tiles' own order; a click
 * opens that client's tile, the same one, in a drawer under the bulbs; and the
 * choice between Compact and Tiles is remembered in this browser.
 * ------------------------------------------------------------------------- */
describe('compact: one bulb per client, and its tile in a drawer', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const bulbsOf = (container) => [...container.querySelectorAll('.fsl-bulb')];
  const bulbButton = (container, id) => container.querySelector(`.fsl-bulb[data-client-id="${id}"] .fsl-bulb-button`);
  const toggleButton = (container, word) => [...container.querySelectorAll('.fsl-view-toggle button')].find((node) => node.textContent === word);

  it('is the default: one bulb per client, worst first like the tiles, each in its tile\'s worst tone, and no tile until asked', () => {
    const { container } = mount();
    const view = buildFleetStatusLights({ clients: CLIENTS, tracker: tracker(SAMPLES), now: NOW });
    expect(bulbsOf(container).map((node) => node.dataset.clientId)).toEqual(view.tiles.map((tile) => tile.clientId));
    expect(bulbsOf(container).map((node) => node.dataset.clientId)).toEqual(['c-amber', 'c-silent', 'c-grey', 'c-green']);
    expect(bulbsOf(container).map((node) => node.className)).toEqual(view.tiles.map((tile) => `fsl-bulb tone-${tile.worst.tone}`));
    expect(bulbsOf(container).map((node) => node.className)).toEqual([
      'fsl-bulb tone-attention', 'fsl-bulb tone-attention', 'fsl-bulb tone-none', 'fsl-bulb tone-live',
    ]);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    expect(container.querySelector('.fsl-bulbs').getAttribute('aria-label')).toBe('One light per client');
  });

  it('says on every bulb the name, how many of its pills are live, and its worst state in words', () => {
    const { container } = mount();
    const words = bulbsOf(container).map((node) => [
      node.querySelector('.fsl-bulb-name').textContent,
      node.querySelector('.fsl-bulb-count').textContent,
      node.querySelector('.sr-only').textContent,
    ]);
    expect(words).toEqual([
      ['Amber Pine', '2 of 3 live', 'Disconnected'],
      ['Silent Elm', '1 of 2 live', 'Silent'],
      ['Grey Birch', '0 of 1 live', 'No sample yet'],
      ['Green Oak', '2 of 2 live', 'All live'],
    ]);
    expect(bulbButton(container, 'c-amber').getAttribute('title'))
      .toBe('Amber Pine: Disconnected. 3 accounts sampled: 2 running, 1 disconnected.');
    // The legend is the tiles' own four tones: one convention for both views.
    expect([...container.querySelectorAll('.fsl-legend-item')].slice(0, 4).map((item) => item.textContent))
      .toEqual(LEGEND.map((entry) => entry.word));
  });

  it('opens that client\'s own tile in a drawer under the bulbs, one at a time; the bulb again, Close or Escape shut it', () => {
    const onSelectClient = vi.fn();
    const { container } = mount({ onSelectClient });
    const amber = bulbButton(container, 'c-amber');
    expect(amber.getAttribute('aria-expanded')).toBe('false');
    expect(amber.hasAttribute('aria-controls')).toBe(false);
    act(() => { amber.click(); });
    expect(amber.getAttribute('aria-expanded')).toBe('true');
    const drawer = container.querySelector('.fsl-drawer');
    expect(amber.getAttribute('aria-controls')).toBe(drawer.id);
    expect(drawer.getAttribute('role')).toBe('region');
    expect(drawer.querySelectorAll('.fsl-tile').length).toBe(1);
    const tile = drawer.querySelector('.fsl-tile');
    expect(tile.dataset.clientId).toBe('c-amber');
    expect(pillsOf(tile).map((pill) => pillText(pill, 'name'))).toEqual(['A-1', 'A-2', 'A-3']);
    expect(tile.querySelector('.fsl-tile-words').textContent).toBe('3 accounts sampled: 2 running, 1 disconnected. Latest sample 4m ago.');
    expect(container.querySelector('.fsl-bulb[data-client-id="c-amber"]').className).toBe('fsl-bulb tone-attention open');
    // Under the bulbs, not above them.
    expect(container.querySelector('.fsl-bulbs').compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Another bulb replaces it: one drawer, one tile.
    act(() => { bulbButton(container, 'c-silent').click(); });
    expect(amber.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.fsl-drawer').length).toBe(1);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(1);
    expect(container.querySelector('.fsl-drawer .fsl-tile').dataset.clientId).toBe('c-silent');
    expect(container.querySelectorAll('.fsl-bulb.open').length).toBe(1);

    // The same bulb again closes it.
    act(() => { bulbButton(container, 'c-silent').click(); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();

    // Escape closes it.
    act(() => { bulbButton(container, 'c-green').click(); });
    expect(container.querySelector('.fsl-drawer')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(bulbButton(container, 'c-green').getAttribute('aria-expanded')).toBe('false');

    // Close closes it, and the tile's head still opens the client.
    act(() => { bulbButton(container, 'c-green').click(); });
    act(() => { container.querySelector('.fsl-drawer .fsl-tile-button').click(); });
    expect(onSelectClient).toHaveBeenCalledWith('c-green');
    act(() => { container.querySelector('.fsl-drawer button[aria-label="Close Green Oak"]').click(); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(container.querySelectorAll('button button').length).toBe(0);
  });

  it('the drawer\'s tile is the whole tile: a pill opens what the account is running, and the folded line is there', async () => {
    const loadStrategies = vi.fn(async ({ clientId }) => strategiesAnswer(clientId, [strategyRow('c-amber', 'A-2')]));
    const { container } = mount({ loadStrategies });
    act(() => { bulbButton(container, 'c-amber').click(); });
    const pill = container.querySelector('.fsl-drawer .account-pill[data-account="A-2"] .account-pill-button');
    act(() => { pill.click(); });
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(container.querySelectorAll('.fsl-drawer .account-live-strategy').length).toBe(1));
    expect(loadStrategies).toHaveBeenCalledWith({ clientId: 'c-amber' });
  });

  it('switches to Tiles and back from the header, and remembers the choice in this browser', () => {
    const { container, unmount } = mount();
    const compact = toggleButton(container, 'Compact');
    const tiles = toggleButton(container, 'Tiles');
    expect(compact.getAttribute('aria-pressed')).toBe('true');
    expect(tiles.getAttribute('aria-pressed')).toBe('false');
    act(() => { bulbButton(container, 'c-amber').click(); });
    act(() => { tiles.click(); });
    expect(tiles.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('.fsl-tile').length).toBe(4);
    expect(container.querySelectorAll('.fsl-bulb').length).toBe(0);
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(window.localStorage.getItem(LIVE_ACCOUNTS_VIEW_KEY)).toBe('tiles');
    unmount();

    const again = mount();
    expect(again.container.querySelectorAll('.fsl-tile').length).toBe(4);
    expect(toggleButton(again.container, 'Tiles').getAttribute('aria-pressed')).toBe('true');
    act(() => { toggleButton(again.container, 'Compact').click(); });
    expect(again.container.querySelectorAll('.fsl-bulb').length).toBe(4);
    expect(window.localStorage.getItem(LIVE_ACCOUNTS_VIEW_KEY)).toBe('compact');
    // The drawer that was open before the switch is not reopened by it.
    expect(again.container.querySelector('.fsl-drawer')).toBeNull();
  });

  it('a storage that throws on read and on write is Compact, and the panel still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const { container } = mount();
    expect(container.querySelectorAll('.fsl-bulb').length).toBe(4);
    act(() => { toggleButton(container, 'Tiles').click(); });
    expect(container.querySelectorAll('.fsl-tile').length).toBe(4);
    act(() => { toggleButton(container, 'Compact').click(); });
    act(() => { bulbButton(container, 'c-amber').click(); });
    expect(container.querySelector('.fsl-drawer .fsl-tile').dataset.clientId).toBe('c-amber');
  });

  it('anything stored that is not a view is Compact', () => {
    window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, 'grid');
    const { container } = mount();
    expect(container.querySelectorAll('.fsl-bulb').length).toBe(4);
    expect(parseLiveAccountsView('tiles')).toBe('tiles');
    for (const value of [null, undefined, '', 'Tiles', 'compact', '{}']) expect(parseLiveAccountsView(value)).toBe('compact');
    expect(LIVE_ACCOUNTS_VIEW_KEY).toBe('cam.liveAccountsView');
  });

  it('thirteen clients are thirteen bulbs in one list, worst first, and nothing per account', () => {
    const book = Array.from({ length: 13 }, (_, index) => client(`c-${index}`, `Client ${String.fromCharCode(65 + index)}`, [[`ACC ${index}`]]));
    const samples = Object.fromEntries(book.map((entry, index) => [entry.id, [index % 4 === 0 ? disconnected(`ACC ${index}`) : sample(`ACC ${index}`)]]));
    const { container } = mount({ clients: book, tracker: tracker(samples) });
    expect(container.querySelectorAll('.fsl-bulbs > .fsl-bulb').length).toBe(13);
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    const tones = bulbsOf(container).map((node) => node.className.replace('fsl-bulb ', ''));
    expect(tones.slice(0, 4)).toEqual(['tone-attention', 'tone-attention', 'tone-attention', 'tone-attention']);
    expect(tones.slice(4).every((tone) => tone === 'tone-live')).toBe(true);
    const view = buildFleetStatusLights({ clients: book, tracker: tracker(samples), now: NOW });
    expect([...view.tiles].sort(compareTiles).map((tile) => tile.clientId)).toEqual(bulbsOf(container).map((node) => node.dataset.clientId));
  });

  it('a client with a retired account still running carries the amber ring on its bulb, said in words', () => {
    const { container } = mount({ clients: [MAPLE_MARKED, CLIENTS[0]], tracker: tracker(MARKED_SAMPLES) });
    const bulb = container.querySelector('.fsl-bulb[data-client-id="c-maple"]');
    expect(bulb.className).toBe('fsl-bulb tone-live marked');
    expect(bulb.querySelector('.fsl-light').className).toBe('dcl-light fsl-light fsl-bulb-still-running');
    // The ring, not the pill's amber corner: that one means "differs from the desk".
    expect(bulb.querySelector('.account-pill-mark')).toBeNull();
    expect(bulb.querySelector('.sr-only').textContent).toBe('All live, ACC 06 marked Failed but still running');
    expect(bulb.querySelector('.fsl-bulb-button').getAttribute('title')).toContain('ACC 06 marked Failed but still running.');
    const green = container.querySelector('.fsl-bulb[data-client-id="c-green"]');
    expect(green.querySelector('.fsl-light').className).toBe('dcl-light fsl-light');
    expect(green.querySelector('.account-pill-mark')).toBeNull();
    // Sorted ahead of an all live client with nothing to ask about.
    expect(bulbsOf(container).map((node) => node.dataset.clientId)).toEqual(['c-maple', 'c-green']);
  });

  /* ONE SYMBOL, ONE MEANING. The amber corner on a pill says an algorithm
   * differs from the desk, in the drawer as in the tiles, so its legend line
   * says that in both views; the bulb's still running signal is a ring, with
   * its own line in Compact; and the Marked badge's line is there whenever a
   * pill on screen carries the badge. */
  it('keeps the amber corner\'s one meaning in both views, names the ring in Compact, and the Marked badge when the drawer shows one', () => {
    const { container } = mount({ clients: [MAPLE_MARKED, CLIENTS[0]], tracker: tracker(MARKED_SAMPLES) });
    const legend = () => [...container.querySelectorAll('.fsl-legend-item')].map((item) => item.textContent);
    expect(container.querySelector('.fsl-legend-mark').textContent).toBe('Amber corner: an algorithm differs from the desk');
    expect(legend()).not.toContain('Amber corner: an account marked retired is still running');
    const ring = container.querySelector('.fsl-legend-still-running');
    expect(ring.textContent).toBe('Amber ring: an account marked retired is still running');
    expect(ring.querySelector('.fsl-dot').className).toBe('fsl-dot fsl-bulb-still-running');
    expect(ring.querySelector('.account-pill-mark')).toBeNull();
    // No pill with the badge on screen yet: no badge line.
    expect(container.querySelector('.fsl-legend-marked')).toBeNull();
    // The drawer of the client with the marked pill: the badge line appears.
    act(() => { bulbButton(container, 'c-maple').click(); });
    expect(container.querySelector('.fsl-drawer .account-pill-marked').textContent).toBe('Marked Failed');
    expect(container.querySelector('.fsl-legend-marked').textContent).toBe('MarkedThe registry retired the account and it is still running');
    expect(container.querySelector('.fsl-legend-mark').textContent).toBe('Amber corner: an algorithm differs from the desk');
    // Another client's drawer has no Marked pill: the line goes.
    act(() => { bulbButton(container, 'c-green').click(); });
    expect(container.querySelector('.fsl-legend-marked')).toBeNull();
    act(() => { bulbButton(container, 'c-green').click(); });
    // Tiles: the same corner line, no ring line, and the badge line since a tile shows the badge.
    act(() => { toggleButton(container, 'Tiles').click(); });
    expect(container.querySelector('.fsl-legend-mark').textContent).toBe('Amber corner: an algorithm differs from the desk');
    expect(container.querySelector('.fsl-legend-still-running')).toBeNull();
    expect(container.querySelector('.fsl-legend-marked')).not.toBeNull();
  });

  it('a book with no retired account still running has no ring and no ring line', () => {
    const { container } = mount();
    expect(container.querySelector('.fsl-bulb-still-running')).toBeNull();
    expect(container.querySelector('.fsl-legend-still-running')).toBeNull();
    expect(container.querySelector('.fsl-legend-mark').textContent).toBe('Amber corner: an algorithm differs from the desk');
  });
});

/* ------------------------------------------------------------------------- *
 * THE COMPACT DRAWER AND THE KEYBOARD.
 *
 * Escape closes the drawer and no other key does; an Escape pressed while
 * typing in a field or inside a dialog belongs to that field or dialog. And
 * whichever way the drawer closes (Escape, Close, the bulb again), focus goes
 * back to the bulb that opened it.
 * ------------------------------------------------------------------------- */
describe('the compact drawer and the keyboard', () => {
  beforeEach(() => window.localStorage.clear());
  const extras = [];
  afterEach(() => { for (const node of extras.splice(0)) node.remove(); });
  const bulbButton = (container, id) => container.querySelector(`.fsl-bulb[data-client-id="${id}"] .fsl-bulb-button`);
  function opened() {
    const utils = mount();
    act(() => { bulbButton(utils.container, 'c-amber').click(); });
    expect(utils.container.querySelector('.fsl-drawer')).not.toBeNull();
    return utils;
  }

  it('closes on Escape and on no other key', () => {
    const { container } = opened();
    for (const key of ['Enter', ' ', 'a', 'Tab', 'ArrowDown', 'Esc']) {
      act(() => { fireEvent.keyDown(document, { key }); });
      expect(container.querySelector('.fsl-drawer'), key).not.toBeNull();
    }
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
  });

  it('leaves an Escape pressed in an input, a textarea, a select or a dialog to them', () => {
    const { container } = opened();
    const host = document.createElement('div');
    host.innerHTML = `
      <input aria-label="Search" />
      <textarea aria-label="Note"></textarea>
      <select aria-label="Pick"><option>One</option></select>
      <div role="dialog" aria-label="Confirm"><button type="button">Inside a dialog</button></div>
      <dialog open><button type="button">Inside a dialog element</button></dialog>
    `;
    document.body.appendChild(host);
    extras.push(host);
    for (const node of host.querySelectorAll('input, textarea, select, button')) {
      node.focus();
      expect(document.activeElement).toBe(node);
      act(() => { fireEvent.keyDown(node, { key: 'Escape' }); });
      expect(container.querySelector('.fsl-drawer'), node.outerHTML).not.toBeNull();
    }
    const pill = container.querySelector('.fsl-drawer .account-pill-button');
    pill.focus();
    act(() => { fireEvent.keyDown(pill, { key: 'Escape' }); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
  });

  it('hands focus back to the bulb that opened it, after Escape, Close or the bulb again', () => {
    const { container } = opened();
    const bulb = bulbButton(container, 'c-amber');
    container.querySelector('.fsl-drawer .account-pill-button').focus();
    act(() => { fireEvent.keyDown(document.activeElement, { key: 'Escape' }); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(document.activeElement).toBe(bulb);

    act(() => { bulb.click(); });
    const close = container.querySelector('.fsl-drawer button[aria-label="Close Amber Pine"]');
    close.focus();
    act(() => { close.click(); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(document.activeElement).toBe(bulb);

    act(() => { bulb.click(); });
    container.querySelector('.fsl-drawer .account-pill-button').focus();
    act(() => { bulb.click(); });
    expect(container.querySelector('.fsl-drawer')).toBeNull();
    expect(document.activeElement).toBe(bulb);

    // Another bulb opens its own drawer, and Escape returns to that one.
    const other = bulbButton(container, 'c-silent');
    act(() => { bulb.click(); });
    act(() => { other.click(); });
    container.querySelector('.fsl-drawer .account-pill-button').focus();
    act(() => { fireEvent.keyDown(document.activeElement, { key: 'Escape' }); });
    expect(document.activeElement).toBe(other);
  });
});

/* ------------------------------------------------------------------------- *
 * "DISCONNECTED SINCE 09:40".
 *
 * Step 66 keeps the tracker's history as runs. For the clients with a
 * disconnected pill, and only for them, the panel reads today's history once
 * per tracker read and says since when, in the pill's title and in its detail.
 * The pill's own word stays "Disconnected". Times are built in the viewer's
 * clock from its midnight, so the assertions hold in any time zone.
 * ------------------------------------------------------------------------- */
describe('since when an account has been disconnected', () => {
  beforeEach(() => window.localStorage.clear());
  const dayStart = historyWindowStart(NOW).getTime();
  const clock = (hours, minutes) => new Date(dayStart + (hours * 60 + minutes) * 60_000).toISOString();
  function run(accountName, connected, first, last, over = {}) {
    return { clientId: 'c-amber', deviceId: 'dev-1', accountName, connected, runState: 'running', firstSampledAt: first, lastSampledAt: last, samples: 2, ...over };
  }
  const HISTORY = {
    available: true,
    rows: [
      run('A-1', true, clock(6, 30), clock(10, 58)),
      run('A-2', true, clock(6, 30), clock(9, 30)),
      run('A-2', false, clock(9, 40), clock(10, 20)),
      run('A-2', false, clock(10, 30), clock(10, 58), { status: 'ConnectionLost' }),
    ],
  };

  it('reads today\'s history once, for the clients with a disconnected pill only, from the viewer\'s midnight', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    const { container } = mount({ loadHistory });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(loadHistory).toHaveBeenCalledWith({ clientIds: ['c-amber'], since: new Date(dayStart).toISOString() });
    await waitFor(() => expect(container.querySelector('.fsl-bulb')).not.toBeNull());
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('reads nothing at all when nobody is disconnected', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    const calm = { ...SAMPLES, 'c-amber': [sample('A-1'), sample('A-2'), sample('A-3')] };
    const { container } = mount({ loadHistory, tracker: tracker(calm) });
    act(() => { container.querySelector('.fsl-view-toggle button:last-child').click(); });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(loadHistory).not.toHaveBeenCalled();
    expect(disconnectedClientKeys(buildFleetStatusLights({ clients: CLIENTS, tracker: tracker(calm), now: NOW }).tiles)).toEqual([]);
  });

  it('reads again when the tracker reads again, and not on a plain re-render', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    const { rerender } = mount({ loadHistory });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    const props = { clients: CLIENTS, tracker: tracker(SAMPLES), onSelectClient: vi.fn(), loadStrategies: neverAnswers, loadHistory };
    rerender(<FleetStatusLights {...props} now={new Date(NOW.getTime())} />);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(loadHistory).toHaveBeenCalledTimes(1);
    rerender(<FleetStatusLights {...props} now={new Date(NOW.getTime() + 120_000)} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
  });

  it('says it in the pill\'s title and in its detail, from the start of the unbroken disconnected stretch, and keeps the word short', async () => {
    window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, 'tiles');
    const loadHistory = vi.fn(async () => HISTORY);
    const { container } = mount({ loadHistory });
    const pill = () => container.querySelector('[data-client-id="c-amber"] .account-pill[data-account="A-2"]');
    await waitFor(() => expect(pill().querySelector('.account-pill-button').getAttribute('title')).toMatch(/^A-2: Disconnected since 09:40\. /));
    expect(pillText(pill(), 'state')).toBe('Disconnected');
    // A connected pill on the same tile says nothing of the kind.
    expect(container.querySelector('.account-pill[data-account="A-1"] .account-pill-button').getAttribute('title')).not.toContain('since');
    act(() => { pill().querySelector('.account-pill-button').click(); });
    expect(container.querySelector('.account-live-detail-since').textContent).toBe('Disconnected since 09:40');
  });

  it('in the compact drawer too', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    const { container } = mount({ loadHistory });
    await waitFor(() => expect(loadHistory).toHaveBeenCalled());
    act(() => { container.querySelector('.fsl-bulb[data-client-id="c-amber"] .fsl-bulb-button').click(); });
    await waitFor(() => expect(container.querySelector('.fsl-drawer .account-pill[data-account="A-2"] .account-pill-button').getAttribute('title'))
      .toContain('Disconnected since 09:40'));
  });

  it('says "since before" the first run of today when the stretch began yesterday', async () => {
    window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, 'tiles');
    const loadHistory = vi.fn(async () => ({
      available: true,
      rows: [run('A-1', true, clock(6, 30), clock(10, 58)), run('A-2', false, new Date(dayStart - 3 * 3600_000).toISOString(), clock(10, 58))],
    }));
    const { container } = mount({ loadHistory });
    await waitFor(() => expect(container.querySelector('.account-pill[data-account="A-2"] .account-pill-button').getAttribute('title'))
      .toMatch(/^A-2: Disconnected since before 06:30\. /));
  });

  it('says nothing when the history is not deployed or the read fails, and the pills stand', async () => {
    window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, 'tiles');
    const failing = vi.fn(async () => { throw new Error('account_live_sample_history: timeout'); });
    const { container } = mount({ loadHistory: failing });
    await waitFor(() => expect(failing).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const title = container.querySelector('.account-pill[data-account="A-2"] .account-pill-button').getAttribute('title');
    expect(title).toMatch(/^A-2: Disconnected\. /);
    expect(container.querySelectorAll('.account-pill').length).toBe(8);
    expect(container.textContent).not.toMatch(/timeout|could not/i);
  });
});

describe('the stylesheet', () => {
  const css = readFileSync('src/index.css', 'utf8');
  const has = (selector) => new RegExp(`${selector.replace(/[.[\]()*+?^$|{}\\]/g, '\\$&')}(?![\\w-])`).test(css);

  it('has a rule for every class the compact view, its drawer and the tiles render', async () => {
    window.localStorage.clear();
    const maple = {
      id: 'c-maple', name: 'Maple Ridge', profile: { stage: 'Active' },
      accountRegistry: { 'ACC 01': { accountName: 'ACC 01', status: 'Active' }, 'ACC 06': { accountName: 'ACC 06', status: 'Failed' } },
    };
    const clients = [...CLIENTS, maple];
    const samples = tracker({ ...SAMPLES, 'c-maple': [sample('ACC 01'), sample('ACC 06')] });
    const loadHistory = vi.fn(async () => ({ available: true, rows: [{ clientId: 'c-amber', deviceId: 'd', accountName: 'A-2', connected: false, firstSampledAt: NOW.toISOString(), lastSampledAt: NOW.toISOString() }] }));
    const { container } = mount({ clients, tracker: samples, loadHistory, closeVerdicts: new Map() });
    const classes = new Set();
    const collect = () => {
      for (const node of container.querySelectorAll('[class]')) {
        for (const name of String(node.getAttribute('class') || '').split(/\s+/)) {
          if (name.startsWith('fsl-') || name.startsWith('account-pill-marked') || name.startsWith('account-live-detail-since')) classes.add(name);
        }
      }
      // Every class on the panel's own root, whatever its prefix: a class
      // added there for a view (view-compact, view-tiles) needs a rule too.
      for (const name of container.querySelector('.fsl').classList) classes.add(name);
    };
    await waitFor(() => expect(loadHistory).toHaveBeenCalled());
    act(() => { container.querySelector('.fsl-bulb[data-client-id="c-amber"] .fsl-bulb-button').click(); });
    await waitFor(() => expect(container.querySelector('.fsl-drawer .account-pill[data-account="A-2"] .account-pill-button').getAttribute('title')).toContain('since'));
    act(() => { container.querySelector('.fsl-drawer .account-pill[data-account="A-2"] .account-pill-button').click(); });
    collect();
    act(() => { [...container.querySelectorAll('.fsl-view-toggle button')].find((node) => node.textContent === 'Tiles').click(); });
    collect();
    expect(classes.size).toBeGreaterThan(20);
    for (const name of classes) expect(has(`.${name}`), `.${name} is styled`).toBe(true);
    for (const name of ['fsl', 'fsl-bulbs', 'fsl-bulb-button', 'fsl-light', 'fsl-bulb-count', 'fsl-drawer', 'fsl-tile-close', 'fsl-bulb-still-running', 'fsl-legend-still-running', 'account-pill-marked', 'account-live-detail-since']) {
      expect(classes.has(name), name).toBe(true);
    }
  });

  it('draws the still running ring amber, with a rule of its own, and never as the pill\'s corner', () => {
    const rule = (selector) => css.split('\n').find((row) => row.startsWith(selector)) || '';
    expect(rule('.fsl-light.fsl-bulb-still-running')).toContain('var(--warning)');
    expect(rule('.fsl-dot.fsl-bulb-still-running')).toContain('var(--warning)');
    expect(rule('.fsl-light.fsl-bulb-still-running')).not.toMatch(/--error|position: absolute/);
    expect(css).not.toMatch(/fsl-bulb-still-running[^{]*account-pill-mark/);
  });

  it('the panel\'s root carries no class without a rule, in either view', () => {
    window.localStorage.clear();
    const { container } = mount();
    expect(container.querySelector('[role="region"]').className).toBe('fsl');
    act(() => { [...container.querySelectorAll('.fsl-view-toggle button')].find((node) => node.textContent === 'Tiles').click(); });
    expect(container.querySelector('[role="region"]').className).toBe('fsl');
  });

  it('paints the bulb with the tile tones and never red', () => {
    const start = css.indexOf('Compact: one bulb per client (FleetStatusLights)');
    expect(start).toBeGreaterThan(0);
    const end = css.indexOf('@media', start);
    const block = css.slice(start, end);
    const line = (selector) => block.split('\n').find((row) => row.includes(selector)) || '';
    expect(line('.fsl-bulb.tone-live .fsl-light')).toContain('var(--success)');
    expect(line('.fsl-bulb.tone-attention .fsl-light')).toContain('var(--warning)');
    expect(line('.fsl-bulb.tone-faint .fsl-light')).toContain('opacity: 0.55');
    expect(line('.fsl-bulb.tone-none .fsl-light')).toContain('#94a3b8');
    expect(block).not.toMatch(/--error|--red\b|\.danger/);
  });
});
