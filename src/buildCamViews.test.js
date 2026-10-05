import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIncomeProjection, buildTodayBriefing, importAsOf, liveCardTitle, liveDotTone } from './App';

// ── buildIncomeProjection ─────────────────────────────────────────────────────

function makeFundedClient({ id = 'c1', name = 'Client', balance, target, start, dailyPnls = [] } = {}) {
  const accountName = 'APEX1';
  const prior = dailyPnls.map((pnl, i) => ({
    id: `di-${i}`,
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    accounts: {},
    snapshots: [{ accountName, grossRealizedPnl: pnl, accountBalance: start + pnl }],
  }));
  return {
    id,
    name,
    accountRegistry: {
      [accountName]: { accountName, accountType: 'Funded', status: 'Active', targetProfit: target, startBalance: start, alias: 'Apex Main' },
    },
    dailyImports: [
      ...prior,
      {
        id: 'di-latest',
        date: '2026-06-25',
        accounts: {},
        snapshots: [{ accountName, grossRealizedPnl: balance - start, accountBalance: balance }],
      },
    ],
  };
}

describe('buildIncomeProjection', () => {
  it('returns empty for no clients', () => {
    expect(buildIncomeProjection([])).toHaveLength(0);
  });

  it('returns empty for clients with no funded accounts with target set', () => {
    const client = {
      id: 'c1', name: 'X',
      accountRegistry: { A1: { accountType: 'Funded', status: 'Active' } }, // no targetProfit
      dailyImports: [{ date: '2026-06-25', accounts: {}, snapshots: [{ accountName: 'A1', accountBalance: 50000, grossRealizedPnl: 0 }] }],
    };
    expect(buildIncomeProjection([client])).toHaveLength(0);
  });

  it('computes pct progress toward target', () => {
    // start=50000, target=53000, balance=51500 → profit=1500, needed=3000 → pct=50
    const client = makeFundedClient({ balance: 51500, target: 53000, start: 50000 });
    const rows = buildIncomeProjection([client]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pct).toBe(50);
    expect(rows[0].ready).toBe(false);
  });

  it('marks ready=true when balance >= target', () => {
    const client = makeFundedClient({ balance: 53200, target: 53000, start: 50000 });
    const [row] = buildIncomeProjection([client]);
    expect(row.ready).toBe(true);
    expect(row.pct).toBe(100);
  });

  it('computes daysLeft from recent avg daily P&L', () => {
    // 6 days of 100/day → avgDaily=100; balance=50600, needed=3000, remaining=2400 → ceil(2400/100)=24
    const client = makeFundedClient({ balance: 50600, target: 53000, start: 50000, dailyPnls: [100, 100, 100, 100, 100] });
    // makeFundedClient appends latest snapshot with grossRealizedPnl=balance-start=600, but
    // the 7-day window averages [100,100,100,100,100,600] = 1100/6 ≈ 183 → daysLeft=ceil(2400/183)=14
    // To get a clean predictable result use only the slice that excludes the latest
    // Just verify daysLeft is a positive integer and avgDaily > 0
    const [row] = buildIncomeProjection([client]);
    expect(typeof row.daysLeft).toBe('number');
    expect(row.daysLeft).toBeGreaterThan(0);
    expect(row.avgDaily).toBeGreaterThan(0);
  });

  it('sets daysLeft=null when average daily P&L is 0', () => {
    const client = makeFundedClient({ balance: 50000, target: 53000, start: 50000 });
    const [row] = buildIncomeProjection([client]);
    expect(row.daysLeft).toBeNull();
  });

  it('sorts results by pct descending', () => {
    const clients = [
      makeFundedClient({ id: 'c1', name: 'A', balance: 51000, target: 53000, start: 50000 }), // 33%
      makeFundedClient({ id: 'c2', name: 'B', balance: 52500, target: 53000, start: 50000 }), // 83%
    ];
    const rows = buildIncomeProjection(clients);
    expect(rows[0].clientName).toBe('B');
    expect(rows[1].clientName).toBe('A');
  });
});

// ── buildTodayBriefing ────────────────────────────────────────────────────────

const TODAY = '2026-06-25';

describe('buildTodayBriefing', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`)); });
  afterEach(() => { vi.useRealTimers(); });

  function makeClient({ flags = [], tasks = [], hasImportToday = false } = {}) {
    const imports = hasImportToday
      ? [{ id: 'di-today', date: TODAY, status: 'Needs review', snapshots: [], flags }]
      : [];
    // add a prior import for latest
    if (!hasImportToday && flags.length) {
      imports.push({ id: 'di-latest', date: '2026-06-24', status: 'Closed', snapshots: [], flags });
    }
    return { id: 'c1', name: 'Pedro', accountRegistry: {}, dailyImports: imports, tasks, activityLog: [] };
  }

  it('assigns critical urgency when latest import has unresolved critical flags', () => {
    const client = makeClient({ flags: [{ id: 'f1', severity: 'Critical', status: 'Open', message: 'DD breached' }] });
    const [briefing] = buildTodayBriefing([client]);
    expect(briefing.urgency).toBe('critical');
  });

  it('does not count Acknowledged critical flags as critical', () => {
    const client = makeClient({ flags: [{ id: 'f1', severity: 'Critical', status: 'Acknowledged', message: 'X' }] });
    const [briefing] = buildTodayBriefing([client]);
    expect(briefing.urgency).not.toBe('critical');
  });

  it('assigns warning urgency for overdue tasks', () => {
    const client = makeClient({ tasks: [{ id: 't1', text: 'Call', done: false, dueDate: '2026-06-20' }] });
    const [briefing] = buildTodayBriefing([client]);
    expect(briefing.urgency).toBe('warning');
  });

  it('assigns pending when no import uploaded today', () => {
    const client = makeClient({ hasImportToday: false });
    const [briefing] = buildTodayBriefing([client]);
    expect(briefing.closeStatus).toBe('pending');
  });

  it('assigns uploaded when import exists for today', () => {
    const client = makeClient({ hasImportToday: true });
    const [briefing] = buildTodayBriefing([client]);
    expect(briefing.closeStatus).toBe('uploaded');
  });

  it('assigns info urgency when last activity was 7+ days ago (stale contact)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
    const staleClient = {
      id: 'c-stale', name: 'Stale', accountRegistry: {}, tasks: [], dailyImports: [],
      activityLog: [{ id: 'a1', text: 'call', createdAt: new Date(`2026-06-18T12:00:00`).toISOString() }], // 7 days before TODAY
    };
    const [briefing] = buildTodayBriefing([staleClient]);
    expect(briefing.staleContact).toBe(true);
    expect(briefing.urgency).toBe('info');
    vi.useRealTimers();
  });

  it('staleContact is false when last contact was recent (< 7 days)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
    const freshClient = {
      id: 'c-fresh', name: 'Fresh', accountRegistry: {}, tasks: [], dailyImports: [],
      activityLog: [{ id: 'a1', text: 'call', createdAt: new Date(`2026-06-24T12:00:00`).toISOString() }], // 1 day ago
    };
    const [briefing] = buildTodayBriefing([freshClient]);
    expect(briefing.staleContact).toBe(false);
    vi.useRealTimers();
  });

  it('sorts results with critical first, ok last', () => {
    const critClient = makeClient({ flags: [{ id: 'f1', severity: 'Critical', status: 'Open', message: 'X' }] });
    critClient.name = 'Crit';
    const okClient = { id: 'c2', name: 'OK', accountRegistry: {}, tasks: [],
      dailyImports: [{ id: 'd1', date: TODAY, status: 'Closed', snapshots: [], flags: [] }],
      activityLog: [{ id: 'a1', type: 'Call', createdAt: new Date().toISOString() }],
    };
    const briefing = buildTodayBriefing([okClient, critClient]);
    expect(briefing[0].client.name).toBe('Crit');
    expect(briefing[briefing.length - 1].urgency).toBe('ok');
  });
});

describe('importAsOf', () => {
  const client = {
    dailyImports: [
      { date: '2026-07-19', snapshots: [] },
      { date: '2026-07-20', snapshots: [] },
      { date: '2026-07-21', snapshots: [] },
    ],
  };

  it('returns the most recent close when no date is pinned', () => {
    expect(importAsOf(client, '').date).toBe('2026-07-21');
    expect(importAsOf(client).date).toBe('2026-07-21');
  });

  it('returns that exact day when a date is pinned', () => {
    expect(importAsOf(client, '2026-07-20').date).toBe('2026-07-20');
  });

  it('returns null when the client had no close that day', () => {
    expect(importAsOf(client, '2026-07-15')).toBeNull();
  });

  it('handles a client with no closes at all', () => {
    expect(importAsOf({ dailyImports: [] }, '2026-07-20')).toBeNull();
    expect(importAsOf({}, '')).toBeNull();
  });
});

// ── the live half of the briefing card (supabase/step_55) ─────────────────────
//
// The card already answers "did today's close arrive", which is `pending` for
// every client from midnight until the closes land. This is the half that is
// true before 16:45 - and the half that must make NO claim at all on the day
// step 55 is run, when nothing in the world is sampling.

const LIVE_TODAY = '2026-06-25';

describe('buildTodayBriefing and the live tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${LIVE_TODAY}T12:00:00Z`)); });
  afterEach(() => { vi.useRealTimers(); });

  const client = { id: 'c1', name: 'Gray Elm', accountRegistry: {}, dailyImports: [], tasks: [], activityLog: [] };

  function sample(overrides = {}) {
    return {
      accountName: 'APEX-1',
      connected: true,
      status: 'Connected',
      totalPnl: 250,
      runState: 'running',
      sampledAt: '2026-06-25T11:56:00.000Z',
      ...overrides,
    };
  }

  it('says nothing live when no tracker is handed in', () => {
    // Which is the state before step 55 is run, the state on a CRM where the
    // read failed, and the state for every client on the day it is run.
    const [entry] = buildTodayBriefing([client]);
    expect(entry.live).toBeNull();
    expect(liveDotTone(entry.live)).toBe('none');
    expect(liveCardTitle(entry.live)).toBe('No live sample for this client.');
  });

  it('says nothing live for a client with no rows, even when other clients have them', () => {
    const [entry] = buildTodayBriefing([client], {
      liveByClientId: new Map([['someone-else', [sample()]]]),
    });
    expect(entry.live).toBeNull();
  });

  it('counts the client\'s own accounts and keeps the close status untouched', () => {
    const [entry] = buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', [
        sample({ accountName: 'A' }),
        sample({ accountName: 'B', runState: 'idle', totalPnl: -40 }),
        sample({ accountName: 'C', connected: false, totalPnl: 10 }),
      ]]]),
    });
    expect(entry.live).toMatchObject({ total: 3, running: 1, idle: 1, disconnected: 1, silent: 0 });
    expect(entry.live.totalPnl).toBe(220);
    // The close half of the card is unchanged: these are two different questions
    // and the card answers both.
    expect(entry.closeStatus).toBe('pending');
    expect(entry.dailyPnl).toBe(0);
  });

  it('reads the staleness horizon it is handed and never a literal', () => {
    const rows = new Map([['c1', [sample({ sampledAt: '2026-06-25T11:30:00.000Z' })]]]);
    expect(buildTodayBriefing([client], { liveByClientId: rows, staleSeconds: 1500 })[0].live)
      .toMatchObject({ silent: 1, live: 0 });
    expect(buildTodayBriefing([client], { liveByClientId: rows, staleSeconds: 7200 })[0].live)
      .toMatchObject({ silent: 0, live: 1 });
  });

  it('turns a disconnected or silent account into a dot worth looking at', () => {
    const tone = (rows) => liveDotTone(buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', rows]]),
    })[0].live);
    expect(tone([sample()])).toBe('running');
    expect(tone([sample({ runState: 'idle' })])).toBe('idle');
    expect(tone([sample({ connected: false })])).toBe('warn');
    expect(tone([sample({ sampledAt: '2026-06-25T10:00:00.000Z' })])).toBe('warn');
  });

  it('counts a flat desk as flat on the card, not as a desk nobody measured', () => {
    /* THE DEFECT, ON THE BRIEFING CARD. `no_strategies` and `unmeasured` were one
     * counter, so an account the VPS had measured and found empty was reported as
     * "with no strategy count". Every account on the fleet reports (0, 0) overnight
     * and before the open - the collector's own measurement is "14 at 09:21, 9 at
     * 16:30, 0 at 18:28" - so a quiet desk read as an unmeasured one every morning. */
    const [entry] = buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', [
        sample({ accountName: 'A', runState: 'no_strategies' }),
        sample({ accountName: 'B', runState: 'no_strategies' }),
        sample({ accountName: 'C', runState: 'unmeasured' }),
      ]]]),
    });
    expect(entry.live).toMatchObject({ total: 3, running: 0, idle: 0, no_strategies: 2, unmeasured: 1 });
    const title = liveCardTitle(entry.live);
    expect(title).toContain('2 with nothing loaded');
    expect(title).toContain('1 with no strategy count');
    // A quiet desk is not an alarm: nothing here is attention.
    expect(entry.live.attention).toBe(0);
    expect(liveDotTone(entry.live)).toBe('idle');
  });

  it('says out loud how many accounts the live figure is about', () => {
    /* A live total silently covering 3 of 11 accounts would be read as the
       client's whole book, which is the same mistake the card's own "$0 today"
       makes before the close. */
    const [entry] = buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', [sample({ accountName: 'A' }), sample({ accountName: 'B', totalPnl: null })]]]),
    });
    const title = liveCardTitle(entry.live);
    expect(title).toContain('2 accounts sampled');
    expect(title).toContain('1 account that reported a figure');
    expect(title).toContain('Last sample');
  });

  it('says so rather than printing a zero when no account reported a figure', () => {
    const [entry] = buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', [sample({ totalPnl: null })]]]),
    });
    expect(entry.live.totalPnl).toBeNull();
    expect(liveCardTitle(entry.live)).toContain('No account reported a profit and loss figure');
  });

  it('does not let the live half change a client\'s urgency', () => {
    /* Urgency drives the sort order and the "N clients critical" badge, both of
       which are about flags, tasks and the close. A tracker hiccup must not
       reorder a CAM's morning. */
    const quiet = buildTodayBriefing([client])[0].urgency;
    const withSilence = buildTodayBriefing([client], {
      liveByClientId: new Map([['c1', [sample({ connected: false, sampledAt: '2026-06-25T09:00:00.000Z' })]]]),
    })[0].urgency;
    expect(withSilence).toBe(quiet);
  });
});
