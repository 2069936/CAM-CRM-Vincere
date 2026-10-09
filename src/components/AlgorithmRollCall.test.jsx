// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlgorithmRollCall from './AlgorithmRollCall';
import { cycleClock } from '../domain/algorithmLiveComparison';

/* ------------------------------------------------------------------------- *
 * THE ROLL CALL, AS THE CAM READS IT AND PASTES IT.
 *
 * Pedro's words: the CAMs tell each other in the chat how each algorithm is
 * doing and spot the odd one out. One row per algorithm, my instances behind
 * a click, and a button that puts one line on the clipboard. Every assertion
 * is on the rendered DOM and on what reached the clipboard.
 * ------------------------------------------------------------------------- */

const CYCLE = '2026-10-08T14:10:00.000Z';
const NOW = new Date('2026-10-08T14:13:00.000Z');
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const SETTINGS = {
  minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false,
};
const CLIENTS = [
  { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' },
  { id: 'c-maple', name: 'Maple Ridge' },
];

function row(overrides = {}) {
  return {
    clientId: UUID,
    accountName: 'ACC 01',
    strategyId: '1',
    strategyName: 'URGO 1.3',
    algorithm: 'URGO',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -300,
    unrealizedPnl: -10,
    restartedAt: null,
    sampledAt: '2026-10-08T14:10:02.000Z',
    cycleStart: CYCLE,
    marketPosition: null,
    positionQuantity: null,
    tradesThisRun: null,
    ...overrides,
  };
}
const bullet = (overrides = {}) => row({ algorithm: 'BulletBot', strategyName: 'BulletBot 2.0', ...overrides });

const ROWS = [
  row({ accountName: 'ACC 01' }),
  row({ accountName: 'ACC 02', clientId: 'c-maple', realizedPnl: -300, unrealizedPnl: 0 }),
  row({ accountName: 'ACC 03', clientId: 'c-maple', realizedPnl: -295, unrealizedPnl: 0 }),
  bullet({ accountName: 'ACC 01', strategyId: '2', realizedPnl: -100, unrealizedPnl: -40, marketPosition: 'long', positionQuantity: 2, tradesThisRun: 3 }),
  bullet({ accountName: 'ACC 04', strategyId: '3', realizedPnl: -20, unrealizedPnl: 0, marketPosition: 'long', positionQuantity: 1, tradesThisRun: 1 }),
  bullet({ accountName: 'ACC 02', strategyId: '4', clientId: 'c-maple', realizedPnl: 10, unrealizedPnl: 0, marketPosition: 'long', positionQuantity: 1, tradesThisRun: 2 }),
  bullet({ accountName: 'ACC 03', strategyId: '5', clientId: 'c-maple', realizedPnl: 50, unrealizedPnl: 10, marketPosition: 'short', positionQuantity: 1, tradesThisRun: 1 }),
];
const COHORTS = [
  { algorithm: 'URGO', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 12, nClients: 8, median: -300, spread: 20, nFlat: 0 },
  { algorithm: 'BulletBot', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 9, nClients: 6, median: 20, spread: 10, nFlat: 1 },
];

function live({ rows = ROWS, cohorts = COHORTS, settings = SETTINGS, desk = {} } = {}) {
  return { available: true, desk: { available: true, cycleStart: CYCLE, filling: false, scope: 'rest_of_desk', cohorts, ...desk }, rows, settings };
}

const TRACKER = {
  available: true,
  staleSeconds: 1500,
  samplesByClientId: new Map([
    [UUID, [{ accountName: 'ACC 01', connectionName: 'Bluesky' }, { accountName: 'ACC 04', connectionName: '' }]],
    ['c-maple', [{ accountName: 'ACC 02', connectionName: 'Live' }, { accountName: 'ACC 03', connectionName: 'Live' }]],
  ]),
};

async function show(props = {}) {
  const load = props.load || vi.fn(async () => live());
  const copy = props.copy === undefined ? vi.fn(async () => true) : props.copy;
  let view;
  await act(async () => {
    view = render(
      <AlgorithmRollCall
        clients={CLIENTS}
        tracker={TRACKER}
        load={load}
        refreshMs={0}
        now={() => NOW}
        {...props}
        copy={copy}
      />,
    );
  });
  return { ...view, load, copy };
}

const rowsOf = (container) => [...container.querySelectorAll('.algorithm-rollcall-row')];
const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('one row per algorithm', () => {
  it('names the algorithm, counts my instances, gives my range, the desk and the status word, differing first', async () => {
    const { container } = await show();
    const rows = rowsOf(container);
    expect(rows.map((node) => node.querySelector('.algorithm-rollcall-name').textContent)).toEqual(['BulletBot MNQ', 'URGO MNQ']);
    const [bulletRow, urgoRow] = rows;
    expect(bulletRow.className).toContain('differs');
    expect(urgoRow.className).not.toContain('differs');
    expect(bulletRow.querySelector('.algorithm-rollcall-count').textContent).toBe('4 accounts');
    expect(bulletRow.querySelector('.algorithm-rollcall-range').textContent).toBe('-140 to +60');
    expect(bulletRow.querySelector('.algorithm-rollcall-desk').textContent).toBe('Desk median $20 over 9 accounts from 6 clients, spread $10.');
    expect(bulletRow.querySelector('.algorithm-rollcall-status').textContent).toBe('1 differs from the desk');
    expect(bulletRow.querySelector('.algorithm-rollcall-status').className).toContain('differs');
    expect(urgoRow.querySelector('.algorithm-rollcall-count').textContent).toBe('3 accounts');
    expect(urgoRow.querySelector('.algorithm-rollcall-range').textContent).toBe('-310 to -295');
    expect(urgoRow.querySelector('.algorithm-rollcall-status').textContent).toBe('in line with the desk');
    expect(urgoRow.querySelector('.algorithm-rollcall-status').className).toContain('in_line');
    // The instances are behind the click.
    expect(container.querySelectorAll('.algorithm-rollcall-instance').length).toBe(0);
  });

  it('says desk not comparable yet for a thin cohort, and nothing differs then', async () => {
    const thin = { ...COHORTS[0], status: 'thin', nAccounts: null, nClients: null, median: null, spread: null };
    const { container } = await show({ load: async () => live({ rows: ROWS.slice(0, 3), cohorts: [thin] }) });
    const [urgoRow] = rowsOf(container);
    expect(urgoRow.querySelector('.algorithm-rollcall-desk').textContent).toBe('Desk not comparable yet.');
    expect(urgoRow.querySelector('.algorithm-rollcall-status').textContent).toBe('desk not comparable yet');
    expect(container.querySelector('.algorithm-rollcall-row.differs')).toBeNull();
  });

  it('says the cycle and that it refreshes, and that the position comes from agent 1.2.1', async () => {
    const { container } = await show();
    const head = text(container.querySelector('.algorithm-rollcall-head'));
    expect(head).toMatch(/cycle \d\d:\d\d/);
    expect(head).toContain('Position and trades arrive from machines on agent 1.2.1 or newer.');
    expect(container.querySelector('.live-refresh')).not.toBeNull();
  });

  it('names whose clients it reads by scope: the CAM\'s own, a book a Manager opened, the whole desk', async () => {
    const intro = (container) => text(container.querySelector('.algorithm-rollcall-head'));
    const mine = await show();
    expect(intro(mine.container)).toMatch(/^One row per algorithm your clients run, cycle \d\d:\d\d:/);
    mine.unmount();
    const book = await show({ scope: 'book' });
    expect(intro(book.container)).toMatch(/^One row per algorithm this book's clients run, cycle \d\d:\d\d:/);
    book.unmount();
    const desk = await show({ scope: 'desk' });
    expect(intro(desk.container)).toMatch(/^One row per algorithm the desk's clients run, cycle \d\d:\d\d:/);
    expect(intro(desk.container)).not.toContain('book');
    desk.unmount();
    // The empty cycle says the same words.
    const empty = await show({ scope: 'desk', load: async () => live({ rows: [] }) });
    expect(text(empty.container)).toMatch(/None of the desk's clients ran an algorithm in the \d\d:\d\d cycle\./);
  });
});

describe('the instances behind a click, one row open at a time', () => {
  it('opens the instances with client, account, connection, the three figures, the position and the trades', async () => {
    const { container } = await show();
    const [bulletRow] = rowsOf(container);
    const toggle = bulletRow.querySelector('.algorithm-rollcall-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = bulletRow.querySelector('.algorithm-rollcall-instances');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    const instances = [...list.querySelectorAll('.algorithm-rollcall-instance')];
    // The comparison's order: by distance in the spread, ties by client then account.
    expect(instances.map((node) => node.querySelector('strong').textContent)).toEqual([
      'Northwind / ACC 01', 'Maple Ridge / ACC 03', 'Northwind / ACC 04', 'Maple Ridge / ACC 02',
    ]);
    const first = instances[0];
    expect(first.querySelector('.algorithm-rollcall-connection').textContent).toBe('Bluesky');
    expect([...first.querySelectorAll('.algorithm-rollcall-figure')].map(text)).toEqual(['realized -$100', 'open -$40', 'total -$140']);
    expect(first.querySelector('.algorithm-rollcall-position').textContent).toBe('long 2');
    expect(first.querySelector('.algorithm-rollcall-trades').textContent).toBe('3 trades this run');
    // ACC 04's sample has no connection name: the ordinary muted word.
    const fourth = instances[2];
    expect(fourth.querySelector('.algorithm-rollcall-connection').textContent).toBe('No connection name');
    expect(fourth.querySelector('.algorithm-rollcall-connection').className).toContain('absent');
    expect(instances[1].querySelector('.algorithm-rollcall-position').textContent).toBe('short 1');
    expect(instances[1].querySelector('.algorithm-rollcall-trades').textContent).toBe('1 trade this run');
  });

  it('puts the amber chip on the instance that differs and on no other', async () => {
    const { container } = await show();
    const [bulletRow] = rowsOf(container);
    act(() => { bulletRow.querySelector('.algorithm-rollcall-toggle').click(); });
    const instances = [...bulletRow.querySelectorAll('.algorithm-rollcall-instance')];
    expect(instances[0].className).toContain('differs');
    expect(instances[0].querySelector('.badge.warning.algorithm-rollcall-differs').textContent).toBe('Differs from the desk');
    for (const other of instances.slice(1)) {
      expect(other.className).not.toContain('differs');
      expect(other.querySelector('.algorithm-rollcall-differs')).toBeNull();
    }
  });

  it('prints no position at all for a reading that carried none, never flat', async () => {
    const { container } = await show();
    const urgoRow = rowsOf(container)[1];
    act(() => { urgoRow.querySelector('.algorithm-rollcall-toggle').click(); });
    expect(urgoRow.querySelectorAll('.algorithm-rollcall-position').length).toBe(0);
    expect(urgoRow.querySelectorAll('.algorithm-rollcall-trades').length).toBe(0);
    expect(text(urgoRow)).not.toContain('flat');
  });

  it('keeps one row open at a time, and a second click on the same row closes it', async () => {
    const { container } = await show();
    const [bulletRow, urgoRow] = rowsOf(container);
    act(() => { bulletRow.querySelector('.algorithm-rollcall-toggle').click(); });
    expect(bulletRow.querySelector('.algorithm-rollcall-instances')).not.toBeNull();
    act(() => { urgoRow.querySelector('.algorithm-rollcall-toggle').click(); });
    expect(bulletRow.querySelector('.algorithm-rollcall-instances')).toBeNull();
    expect(urgoRow.querySelector('.algorithm-rollcall-instances')).not.toBeNull();
    expect(bulletRow.querySelector('.algorithm-rollcall-toggle').getAttribute('aria-expanded')).toBe('false');
    act(() => { urgoRow.querySelector('.algorithm-rollcall-toggle').click(); });
    expect(container.querySelectorAll('.algorithm-rollcall-instances').length).toBe(0);
  });
});

describe('the line for the chat', () => {
  it('"Copy for the chat" writes exactly the line, says Copied, and says it for two seconds', async () => {
    const { container, copy } = await show({ copiedMs: 40 });
    const [bulletRow, urgoRow] = rowsOf(container);
    const button = bulletRow.querySelector('.algorithm-rollcall-copy');
    expect(button.textContent).toBe('Copy for the chat');
    await act(async () => { fireEvent.click(button); });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith('BulletBot: 4 accounts, long on 3, short on 1, -140 to +60, 1 differs from the desk.');
    expect(button.textContent).toBe('Copied');
    // Only this row says Copied.
    expect(urgoRow.querySelector('.algorithm-rollcall-copy').textContent).toBe('Copy for the chat');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(button.textContent).toBe('Copy for the chat');
    await act(async () => { fireEvent.click(urgoRow.querySelector('.algorithm-rollcall-copy')); });
    expect(copy).toHaveBeenLastCalledWith('URGO: 3 accounts, -310 to -295, in line with the desk.');
  });

  it('says it could not copy when neither way worked, instead of Copied', async () => {
    const { container } = await show({ copy: vi.fn(async () => false) });
    const button = rowsOf(container)[0].querySelector('.algorithm-rollcall-copy');
    await act(async () => { fireEvent.click(button); });
    expect(button.textContent).toBe('Could not copy');
  });

  it('without an injected copier, falls back to a textarea and execCommand when the clipboard API is missing', async () => {
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    let selected = '';
    const original = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = function select() { selected = this.value; };
    try {
      const { container } = await show({ copy: null });
      const button = rowsOf(container)[1].querySelector('.algorithm-rollcall-copy');
      await act(async () => { fireEvent.click(button); });
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(selected).toBe('URGO: 3 accounts, -310 to -295, in line with the desk.');
      expect(button.textContent).toBe('Copied');
    } finally {
      HTMLTextAreaElement.prototype.select = original;
    }
  });
});

describe('the states before the rows', () => {
  it('names the migration, the first reading, the empty cycle and a failed read, with no figure', async () => {
    const deployed = await show({ load: async () => ({ available: false, reason: 'not_deployed' }) });
    expect(text(deployed.container)).toContain('Migration step 57 has not been run, so there is no roll call yet.');
    deployed.unmount();
    const none = await show({ load: async () => live({ rows: [], desk: { cycleStart: null } }) });
    expect(text(none.container)).toContain('No machine has sent per strategy readings yet.');
    none.unmount();
    const empty = await show({ load: async () => live({ rows: [] }) });
    expect(text(empty.container)).toMatch(/None of your clients ran an algorithm in the \d\d:\d\d cycle\./);
    empty.unmount();
    const load = vi.fn(async () => { throw new Error('boom'); });
    const failed = await show({ load });
    expect(text(failed.container)).toContain('Could not read the roll call.');
    expect(text(failed.container)).not.toMatch(/\$/);
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reopened an hour later in the filling window, says the new cycle is coming in and never offers the old one as the last complete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const FILLING = '2026-10-08T15:20:00.000Z';
    let release;
    let call = 0;
    const load = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(live());
      return new Promise((resolve) => { release = () => resolve(live({ rows: [], cohorts: [], desk: { filling: true, cycleStart: FILLING } })); });
    });
    const props = { clients: CLIENTS, tracker: TRACKER, load, refreshMs: 120_000, now: () => new Date(), copy: vi.fn(async () => true) };
    const first = render(<AlgorithmRollCall {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(text(first.container)).toContain(`cycle ${cycleClock(CYCLE)}`);
    first.unmount();

    vi.setSystemTime(new Date('2026-10-08T15:20:40.000Z'));
    const again = render(<AlgorithmRollCall {...props} />);
    // While the new read is on its way, the hour old cycle is not on screen.
    expect(text(again.container)).not.toContain(cycleClock(CYCLE));
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(load).toHaveBeenCalledTimes(2);
    const words = text(again.container);
    expect(words).toContain(`The ${cycleClock(FILLING)} cycle is still coming in. The roll call shows once it is complete.`);
    expect(words).not.toContain('so this shows the last complete one');
    expect(words).not.toContain('Strategies are switched off after the close');
    expect(words).not.toContain(cycleClock(CYCLE));
  });

  it('scopes the read by uuid, never by the legacy key, and re-reads on its cadence', async () => {
    const load = vi.fn(async () => live());
    await show({ load, refreshMs: 30 });
    expect(load).toHaveBeenCalledWith({ clientIds: ['c-maple', UUID].sort() });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the words and the styles', () => {
  it('has no verdict word and no dash used as punctuation, in any state, rows open', async () => {
    const states = [
      live(),
      live({ rows: ROWS.slice(0, 3), cohorts: [{ ...COHORTS[0], status: 'thin', median: null, nAccounts: null }] }),
      live({ rows: [row({ realizedPnl: null }), row({ accountName: 'R', restartedAt: '2026-10-08T13:40:00.000Z' })] }),
      live({ rows: [] }),
      { available: false, reason: 'not_deployed' },
    ];
    for (const state of states) {
      const { container, unmount } = await show({ load: async () => state });
      const first = container.querySelector('.algorithm-rollcall-toggle');
      if (first) act(() => { first.click(); });
      const words = text(container);
      for (const word of ['wrong', 'worse', 'underperform', 'outlier', 'below', 'bad ']) {
        expect(words.toLowerCase(), word).not.toContain(word);
      }
      expect(words).not.toMatch(/\s[-\u2013\u2014]\s|[\u2013\u2014]/);
      unmount();
    }
  });

  it('has a rule in index.css for every algorithm-rollcall class it renders', async () => {
    const css = readFileSync('src/index.css', 'utf8');
    const seen = new Set();
    const states = [
      { },
      { load: async () => live({ rows: ROWS.slice(0, 3), cohorts: [{ ...COHORTS[0], status: 'thin', median: null, nAccounts: null }] }) },
      { load: async () => ({ available: false, reason: 'not_deployed' }) },
      { load: async () => { throw new Error('boom'); } },
      { copy: vi.fn(async () => false) },
    ];
    for (const props of states) {
      const { container, unmount } = await show(props);
      // One row open at a time, so the first (differing) row is the one opened.
      const first = container.querySelector('.algorithm-rollcall-toggle');
      if (first) act(() => { first.click(); });
      for (const node of container.querySelectorAll('.algorithm-rollcall-copy')) await act(async () => { fireEvent.click(node); });
      for (const element of container.querySelectorAll('[class]')) {
        for (const name of element.classList) if (name.startsWith('algorithm-rollcall')) seen.add(name);
      }
      unmount();
    }
    expect([...seen]).toEqual(expect.arrayContaining([
      'algorithm-rollcall', 'algorithm-rollcall-head', 'algorithm-rollcall-list', 'algorithm-rollcall-row',
      'algorithm-rollcall-line', 'algorithm-rollcall-toggle', 'algorithm-rollcall-name', 'algorithm-rollcall-count',
      'algorithm-rollcall-range', 'algorithm-rollcall-desk', 'algorithm-rollcall-status', 'algorithm-rollcall-copy',
      'algorithm-rollcall-instances', 'algorithm-rollcall-instance', 'algorithm-rollcall-connection',
      'algorithm-rollcall-figure', 'algorithm-rollcall-position', 'algorithm-rollcall-trades', 'algorithm-rollcall-differs',
      'algorithm-rollcall-empty',
    ]));
    for (const name of seen) {
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
    // Amber, never red: the differing row and chip use the warning token.
    const block = css.slice(css.indexOf('(AlgorithmRollCall)'), css.indexOf('/* ── Each algorithm today, against the desk'));
    expect(block).toMatch(/\.algorithm-rollcall-row\.differs[^}]*var\(--warning\)/);
    expect(block).not.toMatch(/--error|--red|#ff5a69/);
  });
});
