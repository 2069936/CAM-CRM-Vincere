import { describe, expect, it } from 'vitest';
import {
  ATTENTION_VERDICTS,
  DEFAULT_SETTINGS,
  FLAGS,
  VERDICTS,
  closePnlSourceSentence,
  compareTrackerToClose,
  formatMoney,
  matchTolerance,
  minutesBetween,
  resolveComparisonSettings,
  verdictRank,
} from './trackerCloseComparison';
import { cycleClock } from './algorithmLiveComparison';

/* Fixed clocks on a fictional trading day. The capture is 16:31 New York, which
 * is 20:31 UTC in October; the grace is two minutes. */
const CAPTURED = '2026-10-07T20:31:00.000Z';
const SETTINGS = { toleranceDollars: 5, toleranceRatio: 0.02, staleSeconds: 1500, graceSeconds: 120, fallback: false };
const DASH = /[—–]/;

/* A FIXED ZONE for the clocks in the sentences: the close copy's own, New
 * York, as "HH:MM", whatever zone the machine running the suite is in. */
const NEW_YORK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const newYorkClock = (value) => NEW_YORK.format(new Date(value));

function reading(over = {}) {
  return {
    accountName: 'ACC 01',
    source: 'crm_history',
    connectionName: 'Northwind',
    connected: true,
    status: 'Connected',
    realizedPnl: 120.5,
    unrealizedPnl: 0,
    totalPnl: 120.5,
    strategyCount: 2,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-07T20:30:00.000Z',
    readingSince: '2026-10-07T20:20:00.000Z',
    resetSeen: false,
    nextSampledAt: null,
    strategies: [],
    closeBatchId: 'batch-1',
    closeCapturedAt: CAPTURED,
    closeTimeBasis: 'captured',
    graceSeconds: 120,
    staleSeconds: 1500,
    comparedAt: '2026-10-07T20:31:05.000Z',
    ...over,
  };
}

function snapshot(over = {}) {
  return {
    id: 'snap-1',
    account_name: 'ACC 01',
    connection: 'Northwind',
    gross_realized_pnl: '120.5',
    unrealized_pnl: '0',
    ...over,
  };
}

function strategy(over = {}) {
  return {
    strategyId: '100',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    realizedPnl: 120.5,
    unrealizedPnl: 0,
    restartedAt: null,
    sampledAt: '2026-10-07T20:30:02.000Z',
    ...over,
  };
}

function closeStrategy(over = {}) {
  return {
    id: 'ss-1',
    account_snapshot_id: 'snap-1',
    strategy_name: '0 - OGX-PF-2.4',
    instrument: 'MNQ 12-26',
    realized: '120.5',
    unrealized: '0',
    enabled: false,
    ran: true,
    ...over,
  };
}

function compare(input = {}) {
  return compareTrackerToClose({ settings: SETTINGS, ...input });
}

function only(result) {
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

describe('the words', () => {
  it('nine verdicts in decision order, three flags, five attention verdicts', () => {
    expect(VERDICTS).toEqual([
      'tracker_only', 'close_only', 'after_close', 'stale_reading', 'tracker_no_figure',
      'matches', 'settled_at_close', 'tracker_reset', 'differs',
    ]);
    expect(FLAGS).toEqual(['strategies_differ', 'connection_differs', 'algo_moved']);
    expect([...ATTENTION_VERDICTS].sort()).toEqual(['close_only', 'differs', 'stale_reading', 'tracker_only', 'tracker_reset']);
    expect(verdictRank('differs')).toBeLessThan(verdictRank('tracker_reset'));
    expect(verdictRank('tracker_reset')).toBeLessThan(verdictRank('stale_reading'));
    expect(verdictRank('matches')).toBeGreaterThan(verdictRank('settled_at_close'));
    expect(verdictRank('nonsense')).toBeGreaterThan(verdictRank('matches'));
  });
});

describe('the tolerance', () => {
  it('is max(dollars, ratio x |close|), rounded to cents', () => {
    expect(matchTolerance(100, SETTINGS)).toBe(5);
    expect(matchTolerance(250, SETTINGS)).toBe(5);
    expect(matchTolerance(-1000, SETTINGS)).toBe(20);
    expect(matchTolerance(20000, SETTINGS)).toBe(400);
    expect(matchTolerance(333.33, SETTINGS)).toBe(6.67);
    expect(matchTolerance(null, SETTINGS)).toBe(5);
  });

  it('a zero dollar floor leaves the ratio alone, and a zero ratio leaves the floor', () => {
    expect(matchTolerance(1000, { ...SETTINGS, toleranceDollars: 0 })).toBe(20);
    expect(matchTolerance(1000, { ...SETTINGS, toleranceRatio: 0 })).toBe(5);
    expect(matchTolerance(10, { ...SETTINGS, toleranceDollars: 0, toleranceRatio: 0 })).toBe(0);
  });

  it('settings complete from the defaults, and say so', () => {
    expect(resolveComparisonSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
    expect(resolveComparisonSettings({ toleranceDollars: 10 })).toMatchObject({
      toleranceDollars: 10, toleranceRatio: 0.02, staleSeconds: 1500, graceSeconds: 120, fallback: false,
    });
    expect(resolveComparisonSettings({ staleSeconds: 0, toleranceDollars: -1, fallback: true }))
      .toMatchObject({ staleSeconds: 1500, toleranceDollars: 5, fallback: true });
  });
});

describe('each verdict, in order', () => {
  it('tracker_only: a reading with no close row', () => {
    const row = only(compare({ readings: [reading()], accountSnapshots: [] }));
    expect(row.verdict).toBe('tracker_only');
    expect(row.close).toBeNull();
    expect(row.delta).toBeNull();
    expect(row.attention).toBe(true);
    expect(row.sentence).toMatch(/tracker saw this account at \d\d:\d\d but the close does not list it/);
  });

  it('tracker_only says the clock through the formatter it is handed, the one the header uses, never UTC', () => {
    // 20:30 UTC is 16:30 in New York in October.
    const fixed = only(compare({ readings: [reading()], accountSnapshots: [], clock: newYorkClock }));
    expect(fixed.sentence).toBe('The tracker saw this account at 16:30 but the close does not list it.');
    // By default it is the viewer's clock, cycleClock, the panel header's formatter.
    const viewer = only(compare({ readings: [reading()], accountSnapshots: [] }));
    expect(viewer.sentence).toBe(`The tracker saw this account at ${cycleClock('2026-10-07T20:30:00.000Z')} but the close does not list it.`);
    expect(viewer.sentence).not.toContain('UTC');
    // A reading with no time says so instead of inventing one.
    const unknown = only(compare({ readings: [reading({ sampledAt: null })], accountSnapshots: [], clock: newYorkClock }));
    expect(unknown.sentence).toBe('The tracker saw this account at an unknown time but the close does not list it.');
  });

  it('close_only: a none row with no later reading, and the sentence names the retention possibility', () => {
    const row = only(compare({ readings: [reading({ source: 'none', realizedPnl: null, totalPnl: null, connected: null, sampledAt: null, readingSince: null })], accountSnapshots: [snapshot()] }));
    expect(row.verdict).toBe('close_only');
    expect(row.delta).toBeNull();
    expect(row.attention).toBe(true);
    expect(row.sentence).toMatch(/never saw it before the capture/);
    expect(row.sentence).toMatch(/left the history before this close was compared/);
  });

  it('close_only: a close account the pin never saw at all (the close changed after the comparison)', () => {
    const result = compare({ readings: [reading()], accountSnapshots: [snapshot(), snapshot({ id: 'snap-2', account_name: 'ACC 09' })] });
    const late = result.rows.find((row) => row.accountName === 'ACC 09');
    expect(late.verdict).toBe('close_only');
    expect(late.tracker).toBeNull();
    expect(late.delta).toBeNull();
    expect(late.sentence).toMatch(/no tracker reading was pinned for it/);
  });

  it('after_close: a none row whose first reading came after the capture, with the minutes', () => {
    const row = only(compare({
      readings: [reading({ source: 'none', realizedPnl: null, totalPnl: null, connected: null, sampledAt: null, readingSince: null, nextSampledAt: '2026-10-07T20:40:00.000Z' })],
      accountSnapshots: [snapshot()],
    }));
    expect(row.verdict).toBe('after_close');
    expect(row.sentence).toBe('The first tracker reading was 9 minutes after the capture, so there is nothing to compare.');
    expect(row.attention).toBe(false);
    expect(row.delta).toBeNull();
  });

  it('stale_reading: the capture is more than stale_sample_seconds after the reading, exactly at the horizon is not stale', () => {
    const stale = only(compare({ readings: [reading({ sampledAt: '2026-10-07T20:05:59.000Z' })], accountSnapshots: [snapshot()] }));
    expect(stale.verdict).toBe('stale_reading');
    expect(stale.sentence).toBe('The last tracker reading was 25 minutes before the capture, older than the 25 minutes staleness horizon.');
    expect(stale.attention).toBe(true);
    const edge = only(compare({ readings: [reading({ sampledAt: '2026-10-07T20:06:00.000Z' })], accountSnapshots: [snapshot()] }));
    expect(edge.verdict).toBe('matches');
  });

  it('stale_reading is judged against the current horizon when settings are given, the pinned one otherwise', () => {
    const now = only(compare({ readings: [reading({ sampledAt: '2026-10-07T20:20:00.000Z' })], accountSnapshots: [snapshot()], settings: { ...SETTINGS, staleSeconds: 600 } }));
    expect(now.verdict).toBe('stale_reading');
    const result = compareTrackerToClose({ readings: [reading({ sampledAt: '2026-10-07T20:20:00.000Z', staleSeconds: 600 })], accountSnapshots: [snapshot()] });
    expect(only(result).verdict).toBe('stale_reading');
    expect(result.settings.staleSeconds).toBe(600);
    expect(result.settings.fallback).toBe(true);
  });

  it('tracker_no_figure: a reading with no realized figure, delta null and never zero', () => {
    const row = only(compare({ readings: [reading({ realizedPnl: null, totalPnl: null })], accountSnapshots: [snapshot()] }));
    expect(row.verdict).toBe('tracker_no_figure');
    expect(row.delta).toBeNull();
    expect(row.attention).toBe(false);
  });

  it('matches: within tol, at the boundary too, and the delta is the signed difference', () => {
    const exact = only(compare({ readings: [reading()], accountSnapshots: [snapshot()] }));
    expect(exact.verdict).toBe('matches');
    expect(exact.delta).toBe(0);
    expect(exact.sentence).toBe('Tracker realized $120.50 matches the close $120.50 within $5.00.');
    const edge = only(compare({ readings: [reading({ realizedPnl: 115.5 })], accountSnapshots: [snapshot()] }));
    expect(edge.verdict).toBe('matches');
    expect(edge.delta).toBe(-5);
    const over = only(compare({ readings: [reading({ realizedPnl: 115.49, totalPnl: 115.49 })], accountSnapshots: [snapshot()] }));
    expect(over.verdict).toBe('differs');
    expect(over.delta).toBe(-5.01);
  });

  it('matches uses the ratio half on a large figure', () => {
    const row = only(compare({ readings: [reading({ realizedPnl: 20350, totalPnl: 20350 })], accountSnapshots: [snapshot({ gross_realized_pnl: '20000' })] }));
    expect(row.verdict).toBe('matches');
    expect(row.tolerance).toBe(400);
    const beyond = only(compare({ readings: [reading({ realizedPnl: 20401, totalPnl: 20401 })], accountSnapshots: [snapshot({ gross_realized_pnl: '20000' })] }));
    expect(beyond.verdict).toBe('differs');
  });

  it('settled_at_close: the realized figure differs but the tracker total matches the close', () => {
    const row = only(compare({ readings: [reading({ realizedPnl: 100, unrealizedPnl: 20.5, totalPnl: 120.5 })], accountSnapshots: [snapshot()] }));
    expect(row.verdict).toBe('settled_at_close');
    expect(row.delta).toBe(-20.5);
    expect(row.attention).toBe(false);
    expect(row.sentence).toMatch(/open position settled at the close/);
    expect(row.sentence).toContain('$100.00');
    expect(row.sentence).toContain('$20.50');
  });

  it('tracker_reset: neither figure matches and a reset was seen during the day', () => {
    const row = only(compare({ readings: [reading({ realizedPnl: 20, totalPnl: 20, resetSeen: true })], accountSnapshots: [snapshot({ gross_realized_pnl: '520' })] }));
    expect(row.verdict).toBe('tracker_reset');
    expect(row.delta).toBe(-500);
    expect(row.attention).toBe(true);
    expect(row.sentence).toMatch(/looks like a NinjaTrader restart/);
  });

  it('a reset that still matches is a match: the reset word only speaks when the numbers do not agree', () => {
    const row = only(compare({ readings: [reading({ resetSeen: true })], accountSnapshots: [snapshot()] }));
    expect(row.verdict).toBe('matches');
  });

  it('differs: everything else, with both numbers and the gap in the sentence', () => {
    const row = only(compare({ readings: [reading({ realizedPnl: 80, totalPnl: 80 })], accountSnapshots: [snapshot()] }));
    expect(row.verdict).toBe('differs');
    expect(row.delta).toBe(-40.5);
    expect(row.attention).toBe(true);
    expect(row.sentence).toBe('Tracker realized $80.00 differs from the close $120.50 by $40.50, beyond the $5.00 tolerance.');
  });

  it('a none row for an account the close no longer lists is no row at all', () => {
    const result = compare({
      readings: [reading(), reading({ accountName: 'ACC 08', source: 'none', realizedPnl: null, totalPnl: null, connected: null, sampledAt: null, readingSince: null })],
      accountSnapshots: [snapshot()],
    });
    expect(result.rows.map((row) => row.accountName)).toEqual(['ACC 01']);
  });

  it('matches account names case insensitively and prints the close spelling', () => {
    const row = only(compare({ readings: [reading({ accountName: 'ACC 01' })], accountSnapshots: [snapshot({ account_name: 'acc 01' })] }));
    expect(row.verdict).toBe('matches');
    expect(row.accountName).toBe('acc 01');
  });
});

describe('the flags', () => {
  it('connection_differs when both sides name a connection and they differ, never when the close has none', () => {
    const differs = only(compare({ readings: [reading()], accountSnapshots: [snapshot({ connection: 'Apex' })] }));
    expect(differs.flags).toEqual(['connection_differs']);
    expect(differs.attention).toBe(true);
    expect(differs.verdict).toBe('matches');
    expect(differs.notes[0]).toBe('Connection differs: tracker Northwind, close Apex.');
    const unknown = only(compare({ readings: [reading()], accountSnapshots: [snapshot({ connection: '' })] }));
    expect(unknown.flags).toEqual([]);
    const sameCase = only(compare({ readings: [reading({ connectionName: 'northwind' })], accountSnapshots: [snapshot()] }));
    expect(sameCase.flags).toEqual([]);
  });

  it('strategies_differ when the tracker carried strategies and the sets by (name, instrument) differ', () => {
    const extraOnTracker = only(compare({
      readings: [reading({ strategies: [strategy(), strategy({ strategyId: '101', strategyName: '1 - ALPHA-1.0', instrument: 'NQ 12-26', realizedPnl: 0 })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(extraOnTracker.flags).toEqual(['strategies_differ']);
    expect(extraOnTracker.strategyGap).toEqual({ trackerOnly: ['1 - ALPHA-1.0 on NQ 12-26'], closeOnly: [] });
    expect(extraOnTracker.notes[0]).toBe('Strategies differ: tracker ran 1 - ALPHA-1.0 on NQ 12-26 that the close does not show.');

    const extraOnClose = only(compare({
      readings: [reading({ strategies: [strategy()] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy(), closeStrategy({ id: 'ss-2', strategy_name: '2 - URGO-4.5', instrument: 'MNQ 12-26', realized: '10' })],
    }));
    expect(extraOnClose.flags).toEqual(['strategies_differ']);
    expect(extraOnClose.strategyGap.closeOnly).toEqual(['2 - URGO-4.5 on MNQ 12-26']);
  });

  it('a close strategy that did not run is not in the close set; ran null falls back to enabled', () => {
    const idle = only(compare({
      readings: [reading({ strategies: [strategy()] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy(), closeStrategy({ id: 'ss-2', strategy_name: '2 - URGO-4.5', ran: false })],
    }));
    expect(idle.flags).toEqual([]);
    const legacy = only(compare({
      readings: [reading({ strategies: [strategy()] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy({ ran: null, enabled: true }), closeStrategy({ id: 'ss-2', strategy_name: '2 - URGO-4.5', ran: null, enabled: false })],
    }));
    expect(legacy.flags).toEqual([]);
  });

  it('no strategies on the tracker side says nothing, even when the close ran some', () => {
    const row = only(compare({ readings: [reading({ strategies: [] })], accountSnapshots: [snapshot()], strategySnapshots: [closeStrategy()] }));
    expect(row.flags).toEqual([]);
    expect(row.strategies).toEqual([]);
  });

  it('algo_moved when both sides carry a figure, no restart, read before the cutoff, and the gap beats the per algo tolerance', () => {
    const moved = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: 90 })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(moved.flags).toEqual(['algo_moved']);
    expect(moved.strategies[0]).toMatchObject({ moved: true, gap: -30.5, tolerance: 5, closeRan: true, inClose: true });
    expect(moved.notes[0]).toBe('0 - OGX-PF-2.4 on MNQ 12-26 moved: tracker $90.00, close $120.50, beyond $5.00.');

    const atEdge = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: 115.5 })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(atEdge.flags).toEqual([]);
    expect(atEdge.strategies[0].gap).toBe(-5);
  });

  it('algo_moved is withheld on a restarted instance, an unmeasured one, or one read after the cutoff', () => {
    const restarted = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: 0, restartedAt: '2026-10-07T18:00:00.000Z' })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(restarted.flags).toEqual([]);
    expect(restarted.strategies[0]).toMatchObject({ moved: false, gap: null });

    const unmeasured = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: null })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(unmeasured.strategies[0]).toMatchObject({ moved: false, gap: null, trackerRealized: null });

    const late = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: 0, sampledAt: '2026-10-07T20:50:00.000Z' })] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy()],
    }));
    expect(late.flags).toEqual([]);
    expect(late.strategies[0]).toMatchObject({ moved: false, readAfterCapture: true });
  });

  it('the per algo tolerance is max(dollars, ratio x |close strategy realized|)', () => {
    const row = only(compare({
      readings: [reading({ realizedPnl: 20000, totalPnl: 20000, strategies: [strategy({ realizedPnl: 20300 })] })],
      accountSnapshots: [snapshot({ gross_realized_pnl: '20000' })],
      strategySnapshots: [closeStrategy({ realized: '20000' })],
    }));
    expect(row.strategies[0]).toMatchObject({ tolerance: 400, moved: false });
  });

  it('strategies are matched through account_snapshot_id, and a snapshot row without one belongs to nobody', () => {
    const row = only(compare({
      readings: [reading({ strategies: [strategy()] })],
      accountSnapshots: [snapshot()],
      strategySnapshots: [closeStrategy({ account_snapshot_id: null })],
    }));
    expect(row.strategyGap.trackerOnly).toEqual(['0 - OGX-PF-2.4 on MNQ 12-26']);
    expect(row.flags).toEqual(['strategies_differ']);
  });
});

describe('the comparison as a whole', () => {
  it('orders attention first, worst verdict first, then by account name', () => {
    const result = compare({
      readings: [
        reading({ accountName: 'ACC 03' }),
        reading({ accountName: 'ACC 02', realizedPnl: 10, totalPnl: 10 }),
        reading({ accountName: 'ACC 01', realizedPnl: 20, totalPnl: 20, resetSeen: true }),
        reading({ accountName: 'ACC 04' }),
      ],
      accountSnapshots: [
        snapshot({ id: 's3', account_name: 'ACC 03' }),
        snapshot({ id: 's2', account_name: 'ACC 02' }),
        snapshot({ id: 's1', account_name: 'ACC 01' }),
        snapshot({ id: 's4', account_name: 'ACC 04', connection: 'Apex' }),
      ],
    });
    expect(result.rows.map((row) => [row.accountName, row.verdict, row.flags])).toEqual([
      ['ACC 02', 'differs', []],
      ['ACC 01', 'tracker_reset', []],
      ['ACC 04', 'matches', ['connection_differs']],
      ['ACC 03', 'matches', []],
    ]);
    expect(result.summary).toMatchObject({
      accounts: 4,
      attention: 3,
      worst: 'differs',
      byVerdict: { differs: 1, tracker_reset: 1, matches: 2 },
      byFlag: { connection_differs: 1, strategies_differ: 0, algo_moved: 0 },
    });
  });

  it('carries the clocks and the basis from the pinned rows, and the cutoff from the pinned grace', () => {
    const result = compare({ readings: [reading()], accountSnapshots: [snapshot()] });
    expect(result).toMatchObject({
      available: true,
      closeCapturedAt: CAPTURED,
      closeTimeBasis: 'captured',
      closeBatchId: 'batch-1',
      comparedAt: '2026-10-07T20:31:05.000Z',
      cutoffAt: '2026-10-07T20:33:00.000Z',
    });
  });

  it('with no pinned row at all it is not available, and lists nothing', () => {
    const result = compare({ readings: [], accountSnapshots: [snapshot()] });
    expect(result.available).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.summary.worst).toBeNull();
  });

  it('accepts camelCase close rows as well as PostgREST snake_case', () => {
    const row = only(compare({
      readings: [reading({ strategies: [strategy({ realizedPnl: 50 })] })],
      accountSnapshots: [{ id: 'snap-1', accountName: 'ACC 01', connection: 'Northwind', grossRealizedPnl: 120.5, unrealizedPnl: 0 }],
      strategySnapshots: [{ accountSnapshotId: 'snap-1', strategyName: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26', realized: 120.5, ran: true }],
    }));
    expect(row.verdict).toBe('matches');
    expect(row.flags).toEqual(['algo_moved']);
  });

  it('no sentence or note carries a dash as punctuation', () => {
    const result = compare({
      readings: [
        reading({ accountName: 'A1' }),
        reading({ accountName: 'A2', realizedPnl: 10, totalPnl: 10 }),
        reading({ accountName: 'A3', realizedPnl: 20, totalPnl: 20, resetSeen: true }),
        reading({ accountName: 'A4', realizedPnl: 100, unrealizedPnl: 20.5, totalPnl: 120.5 }),
        reading({ accountName: 'A5', realizedPnl: null, totalPnl: null }),
        reading({ accountName: 'A6', sampledAt: '2026-10-07T19:00:00.000Z' }),
        reading({ accountName: 'A7', source: 'none', realizedPnl: null, totalPnl: null, connected: null, sampledAt: null, readingSince: null }),
        reading({ accountName: 'A8', source: 'none', realizedPnl: null, totalPnl: null, connected: null, sampledAt: null, readingSince: null, nextSampledAt: '2026-10-07T20:40:00.000Z' }),
        reading({ accountName: 'A9' }),
        reading({ accountName: 'A10', strategies: [strategy({ realizedPnl: 10 }), strategy({ strategyId: '2', strategyName: '1 - ALPHA-1.0', instrument: 'NQ 12-26' })] }),
      ],
      accountSnapshots: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A10', 'A11'].map((name) => snapshot({ id: `s-${name}`, account_name: name, connection: name === 'A1' ? 'Apex' : 'Northwind' })),
      strategySnapshots: [closeStrategy({ account_snapshot_id: 's-A10' })],
    });
    expect(result.rows).toHaveLength(11);
    expect(new Set(result.rows.map((row) => row.verdict))).toEqual(new Set(VERDICTS));
    for (const row of result.rows) {
      expect(row.sentence, row.verdict).not.toMatch(DASH);
      for (const note of row.notes) expect(note).not.toMatch(DASH);
    }
    expect(result.pnlSourceSentence).not.toMatch(DASH);
  });
});

describe('the close\'s own note about its figures', () => {
  it('is one sentence per close, from the import level counts', () => {
    expect(closePnlSourceSentence({ realized: 4, gross_fallback: 0, gross_missing_realized: 0, unavailable: 0, unknown: 0 }))
      .toBe('The close carried a realized figure for 4 of 4 accounts.');
    expect(closePnlSourceSentence({ realized: 3, gross_fallback: 1, gross_missing_realized: 1, unavailable: 1, unknown: 1 }))
      .toBe('The close carried a realized figure for 3 of 7 accounts; 1 used the gross figure instead; 1 had a gross figure and no realized one; 1 had neither; 1 did not say.');
  });

  it('says so when the close carries no counts', () => {
    expect(closePnlSourceSentence(null)).toBe('The close does not say where its realized figures came from.');
    expect(closePnlSourceSentence({})).toBe('The close does not say where its realized figures came from.');
  });
});

describe('the small helpers', () => {
  it('formats money as US dollars and names a missing figure', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(-12)).toBe('-$12.00');
    expect(formatMoney(null)).toBe('no figure');
    expect(formatMoney('')).toBe('no figure');
  });

  it('counts whole minutes and never goes negative', () => {
    expect(minutesBetween('2026-10-07T20:00:00Z', '2026-10-07T20:31:00Z')).toBe(31);
    expect(minutesBetween('2026-10-07T20:31:00Z', '2026-10-07T20:00:00Z')).toBe(0);
    expect(minutesBetween(null, '2026-10-07T20:00:00Z')).toBeNull();
  });
});
