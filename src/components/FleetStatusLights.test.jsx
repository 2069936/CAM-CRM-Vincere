// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FleetStatusLights from './FleetStatusLights';
import {
  DOT_TONES,
  LEGEND,
  LIVE_SAMPLING_BUILD,
  buildFleetStatusLights,
} from '../domain/fleetStatusLights';

/* ------------------------------------------------------------------------- *
 * THE STATUS LIGHT FOR THE WHOLE BOOK.
 *
 * Pedro's words: the "semáforo" first, for all of my clients, as a picture and
 * not as text to read. These assertions are about what a glance has to get
 * right: the colour of each dot matches its state, the worst client is at the
 * top, every colour has a word beside it, the summary line counts what the
 * grid shows, and each of the three empty states says a different true thing.
 * ------------------------------------------------------------------------- */

const NOW = new Date('2026-10-05T15:00:00.000Z');

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connectionName: 'Rithmic',
    connected: true,
    status: 'Connected',
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
const allOff = (name) => sample(name, { runState: 'idle', enabledStrategyCount: 0 });

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
  'c-green': [sample('G-1'), allOff('G-2')],
  'c-amber': [sample('A-1'), disconnected('A-2'), sample('A-3')],
  'c-silent': [sample('E-1'), silent('E-2')],
};

function mount(props = {}) {
  return render(<FleetStatusLights
    clients={CLIENTS}
    tracker={tracker(SAMPLES)}
    now={NOW}
    onSelectClient={vi.fn()}
    {...props}
  />);
}

const tileNames = (container) => [...container.querySelectorAll('.fsl-tile')]
  .map((tile) => tile.querySelector('.fsl-tile-name').textContent);

afterEach(cleanup);

describe('one dot per account, coloured by its state and never by colour alone', () => {
  it('paints live green, disconnected and silent amber, never sampled faded amber, each with its word', () => {
    const { container } = mount();
    const amber = container.querySelector('[data-client-id="c-amber"]');
    const dots = [...amber.querySelectorAll('.fsl-dot-item')];
    expect(dots.map((dot) => dot.className)).toEqual([
      'fsl-dot-item tone-live tracker-live',
      'fsl-dot-item tone-attention tracker-disconnected',
      'fsl-dot-item tone-live tracker-live',
    ]);
    expect(dots.map((dot) => dot.querySelector('.fsl-dot-word').textContent))
      .toEqual(['running', 'disconnected', 'running']);
    expect(dots[1].getAttribute('title')).toContain('A-2: Disconnected.');
    expect(dots[1].getAttribute('title')).toContain('not connected to its broker');
    expect(dots[1].getAttribute('title')).toContain('ConnectionLost');

    const quiet = container.querySelector('[data-client-id="c-silent"]');
    const quietDots = [...quiet.querySelectorAll('.fsl-dot-item')];
    expect(quietDots[1].className).toBe('fsl-dot-item tone-attention tracker-sample_stale');
    expect(quietDots[1].querySelector('.fsl-dot-word').textContent).toBe('silent');

    // The run state is the word under a live dot, because what a live account is
    // DOING is the question once its colour has said it is alive.
    const green = container.querySelector('[data-client-id="c-green"]');
    expect([...green.querySelectorAll('.fsl-dot-word')].map((word) => word.textContent))
      .toEqual(['running', 'all off']);
  });

  it('the palette is the client page\'s: live green, disconnected or silent amber, never sampled faint', () => {
    expect(DOT_TONES).toEqual({
      live: 'live',
      disconnected: 'attention',
      sample_stale: 'attention',
      never_sampled: 'faint',
    });
  });

  it('gives a registered account nobody has sampled a dot of its own, and leaves retired accounts out', () => {
    const clients = [client('c-1', 'One', [['S-1'], ['S-2'], ['S-old', 'Inactive'], ['S-dead', 'Failed'], ['S-hold', 'Payout Hold']])];
    const { container } = render(<FleetStatusLights
      clients={clients}
      tracker={tracker({ 'c-1': [sample('S-1')] })}
      now={NOW}
    />);
    const dots = [...container.querySelectorAll('.fsl-dot-item')];
    // One sampled, two registered and expected to trade: three dots. Inactive and
    // Failed are not expected to sample, so a light on them would be a false alarm.
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'S-1: Live, running',
      'S-2: Never sampled',
      'S-hold: Never sampled',
    ]);
    expect(dots[1].className).toBe('fsl-dot-item tone-faint tracker-never_sampled');
    expect(dots[1].querySelector('.fsl-dot-word').textContent).toBe('never sampled');
    // Honest about what the browser cannot see: it does not claim a paired VPS.
    expect(dots[1].getAttribute('title')).toContain('Open the client to see whether a VPS is paired');
    expect(dots[1].getAttribute('title')).not.toContain('paired and answering');
    expect(container.textContent).toContain('2 registered and never sampled');
  });

  it('counts one dot per account and no more, whatever the sample order', () => {
    const clients = [client('c-1', 'One', [['Z-1'], ['Y-2']])];
    const { container } = render(<FleetStatusLights
      clients={clients}
      tracker={tracker({ 'c-1': [sample('Y-2'), sample('Z-1'), sample('X-3')] })}
      now={NOW}
    />);
    expect(container.querySelectorAll('.fsl-dot-item').length).toBe(3);
    expect([...container.querySelectorAll('.fsl-dot-item')].map((dot) => dot.getAttribute('aria-label').split(':')[0]))
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
});

describe('words beside every colour', () => {
  it('prints a legend naming all four tones', () => {
    const { container } = mount();
    const legend = [...container.querySelectorAll('.fsl-legend-item')];
    expect(legend.map((item) => item.className)).toEqual([
      'fsl-legend-item tone-live',
      'fsl-legend-item tone-attention',
      'fsl-legend-item tone-faint',
      'fsl-legend-item tone-none',
    ]);
    expect(legend.map((item) => item.textContent)).toEqual([
      'Live',
      'Disconnected or silent',
      'Never sampled',
      'No sample for this client',
    ]);
    expect(LEGEND.length).toBe(4);
  });

  it('every dot has a visible word and every tile a visible state word', () => {
    const { container } = mount();
    const dots = [...container.querySelectorAll('.fsl-dot-item')];
    expect(dots.length).toBe(8);
    for (const dot of dots) {
      expect(dot.querySelector('.fsl-dot-word').textContent.trim()).not.toBe('');
      expect(dot.getAttribute('title')).toMatch(/\w/);
      expect(dot.getAttribute('aria-label')).toMatch(/: /);
    }
    for (const tile of container.querySelectorAll('.fsl-tile')) {
      expect(tile.querySelector('.fsl-tile-state').textContent.trim()).not.toBe('');
      expect(tile.querySelector('.fsl-tile-words').textContent.trim()).not.toBe('');
    }
  });

  it('says on the tile what the dots add up to, and when the latest sample was', () => {
    const { container } = mount();
    const amber = container.querySelector('[data-client-id="c-amber"] .fsl-tile-words').textContent;
    expect(amber).toBe('3 accounts sampled: 2 running, 1 disconnected. Latest sample 4m ago.');
    const grey = container.querySelector('[data-client-id="c-grey"] .fsl-tile-words').textContent;
    expect(grey).toContain('1 account on the registry, none sampled.');
    expect(grey).toContain('Either no VPS is paired with this client or it has not sampled yet.');
  });
});

describe('the one line over the grid', () => {
  it('reuses the tracker summary and says how many clients it covers', () => {
    const { container } = mount();
    const line = container.querySelector('.fsl-summary').textContent;
    // 7 sampled across three clients: 5 running, 1 all off, 1 disconnected, 1 silent.
    expect(line).toContain('7 accounts sampled: 4 running, 1 all off, 1 disconnected, 1 silent, across 3 of 4 clients. Latest sample 4m ago.');
    expect(line).toContain('As of ');
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

describe('a tile opens its client', () => {
  it('calls onSelectClient with the client id', () => {
    const onSelectClient = vi.fn();
    const { container } = mount({ onSelectClient });
    container.querySelector('[data-client-id="c-silent"] button').click();
    expect(onSelectClient).toHaveBeenCalledTimes(1);
    expect(onSelectClient).toHaveBeenCalledWith('c-silent');
  });

  it('renders no button at all when nothing can be opened', () => {
    const { container } = mount({ onSelectClient: null });
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.querySelectorAll('.fsl-tile').length).toBe(4);
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
    // Its registered account still gets a dot, faint, so it is visibly unsampled.
    expect(grey.querySelectorAll('.fsl-dot-item.tone-faint').length).toBe(1);
  });

  it('an empty book says so instead of rendering nothing', () => {
    const { container } = mount({ clients: [] });
    expect(container.textContent).toContain('No client in this book to light.');
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
    expect(view.tiles[0].worst).toBe('live');
  });

  it('still finds samples keyed by id for a client without a uuid', () => {
    const plain = client('c-plain', 'Plain', [['APEX-2']]);
    const view = buildFleetStatusLights({ clients: [plain], tracker: tracker({ 'c-plain': [sample('APEX-2')] }), now: NOW });
    expect(view.tiles[0].summary.rows[0].sample.accountName).toBe('APEX-2');
  });
});
