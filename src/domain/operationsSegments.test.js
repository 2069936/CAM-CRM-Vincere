import { describe, expect, it } from 'vitest';
import { SEGMENTS, buildSegmentTotals, rollUpByBusiness, segmentFor } from './operationsSegments';

const entry = (registry, snapshots, id = 'client-1') => ({
  client: { id, accountRegistry: registry },
  dailyImport: { snapshots },
});

describe('segmentFor', () => {
  it('separates the two evaluation kinds', () => {
    // Bullet Bot is a different business from a standard evaluation: high risk,
    // pass or fail in one to three days. Folding them together hides that.
    expect(segmentFor({ accountType: 'Evaluation - Bullet Bot' })).toBe(SEGMENTS.EVAL_BULLET);
    expect(segmentFor({ accountType: 'Evaluation - Standard' })).toBe(SEGMENTS.EVAL_STANDARD);
  });

  it('treats both cash kinds as cash', () => {
    expect(segmentFor({ accountType: 'Cash - IRA' })).toBe(SEGMENTS.CASH);
    expect(segmentFor({ accountType: 'Cash - Straight' })).toBe(SEGMENTS.CASH);
    expect(segmentFor({ accountType: 'Cash' })).toBe(SEGMENTS.CASH);
  });

  it('names an unknown type instead of calling it unclassified', () => {
    // Unclassified means nobody has looked at it. A type this function has not
    // been taught is the opposite: somebody chose it.
    expect(segmentFor({ accountType: 'Evaluation - New Thing' })).toBe('Evaluation - New Thing');
  });

  it('distinguishes an account with no type from one with no record at all', () => {
    expect(segmentFor({ accountType: '' })).toBe(SEGMENTS.UNCLASSIFIED);
    expect(segmentFor({ accountType: 'Unassigned' })).toBe(SEGMENTS.UNCLASSIFIED);
    expect(segmentFor(undefined)).toBe(SEGMENTS.ORPHAN);
  });
});

describe('buildSegmentTotals', () => {
  const registry = {
    E1: { accountType: 'Evaluation - Bullet Bot' },
    E2: { accountType: 'Evaluation - Standard' },
    F1: { accountType: 'Funded' },
    C1: { accountType: 'Cash - IRA' },
    X1: { accountType: 'Inactive / Ignore' },
  };
  const snapshots = [
    { accountName: 'E1', grossRealizedPnl: -900, accountBalance: 49000 },
    { accountName: 'E2', grossRealizedPnl: -100, accountBalance: 50000 },
    { accountName: 'F1', grossRealizedPnl: 200, accountBalance: 51000 },
    { accountName: 'C1', grossRealizedPnl: -50, accountBalance: 20000 },
    { accountName: 'X1', grossRealizedPnl: -700, accountBalance: 1000 },
    { accountName: 'GONE', grossRealizedPnl: -300, accountBalance: 5000 },
  ];

  it('offers no total at all, not even an empty one', () => {
    // THE GUARD FOR THE WHOLE FEATURE. `total` was one figure for "the desk",
    // and it added a cash desk's real client money to a prop desk's simulated
    // plan size with Bullet Bot netted against the ordinary algorithms inside
    // it. Removing it and documenting "do not use" would not hold: the next
    // caller who needs a number reaches for the key that exists. It must be
    // absent, so that reading it is a crash and not a wrong answer.
    const totals = buildSegmentTotals([entry(registry, snapshots)]);

    expect(totals.total).toBeUndefined();
    expect(Object.keys(totals)).not.toContain('total');
  });

  it('keeps ignored and orphan snapshots out of the counted rows', () => {
    // An account marked Inactive / Ignore is not the book, and a snapshot whose
    // account no longer exists cannot be attributed to anything. Both are still
    // returned, flagged, so the data problem is visible.
    const totals = buildSegmentTotals([entry(registry, snapshots)]);
    const counted = totals.segments.filter((row) => row.countedInTotal);

    expect(counted.reduce((sum, row) => sum + row.dailyPnl, 0)).toBe(-850);
    expect(counted.reduce((sum, row) => sum + row.accounts, 0)).toBe(4);
    expect(totals.excluded.map((row) => row.segment).sort())
      .toEqual([SEGMENTS.IGNORED, SEGMENTS.ORPHAN].sort());
  });

  it('counts the clients behind a segment, not just the accounts', () => {
    // Two clients, one of them holding two bullet-bot evaluations. The row is
    // 3 accounts across 2 clients, and the two counts are not interchangeable.
    const totals = buildSegmentTotals([
      entry({ A: { accountType: 'Evaluation - Bullet Bot' }, B: { accountType: 'Evaluation - Bullet Bot' } }, [
        { accountName: 'A', grossRealizedPnl: 1 },
        { accountName: 'B', grossRealizedPnl: 1 },
      ], 'c1'),
      entry({ C: { accountType: 'Evaluation - Bullet Bot' } }, [{ accountName: 'C', grossRealizedPnl: 1 }], 'c2'),
    ]);
    const bullet = totals.segments.find((row) => row.segment === SEGMENTS.EVAL_BULLET);

    expect(bullet.accounts).toBe(3);
    expect(bullet.clients).toBe(2);
  });

  it('counts what it excluded rather than dropping it silently', () => {
    // Excluding without saying so replaces one wrong total with another and
    // hides the data problem behind it.
    const totals = buildSegmentTotals([entry(registry, snapshots)]);
    const excluded = Object.fromEntries(totals.excluded.map((row) => [row.segment, row.dailyPnl]));

    expect(excluded[SEGMENTS.IGNORED]).toBe(-700);
    expect(excluded[SEGMENTS.ORPHAN]).toBe(-300);
  });

  it('shows the worst segment first', () => {
    const totals = buildSegmentTotals([entry(registry, snapshots)]);

    expect(totals.segments[0].segment).toBe(SEGMENTS.EVAL_BULLET);
    expect(totals.segments[0].dailyPnl).toBe(-900);
  });

  it('has no `prop` key, because Bullet Bot is not the other algorithms', () => {
    // Not a documentation problem. A key named `prop` gets summed by the next
    // caller who wants a number, and on the real book "prop -$5,070.50" on
    // 2026-07-13 was Bullet Bot +$14,861.50 netted against the ordinary
    // algorithms -$19,932.00 — opposite signs on 9 of the 13 non-zero days.
    const rolled = rollUpByBusiness(buildSegmentTotals([entry(registry, snapshots)]));

    expect(rolled.prop).toBeUndefined();
    expect(Object.keys(rolled)).not.toContain('prop');
  });

  it('rolls Bullet Bot, the other prop algos, cash and unclassified apart', () => {
    const rolled = rollUpByBusiness(buildSegmentTotals([entry(registry, snapshots)]));

    expect(rolled.bulletBot.dailyPnl).toBe(-900);
    expect(rolled.bulletBot.accounts).toBe(1);
    expect(rolled.propOther.dailyPnl).toBe(100);
    expect(rolled.propOther.accounts).toBe(2);
    expect(rolled.cash.dailyPnl).toBe(-50);
    expect(rolled.cash.accounts).toBe(1);
    expect(rolled.unclassified.accounts).toBe(0);
  });

  it('puts an account type nobody taught it into the other-prop row rather than nowhere', () => {
    // propOther is defined by exclusion on purpose. segmentFor() reports an
    // unknown accountType under its own name, and a roll-up that listed the
    // known prop segments by name would drop that segment out of every figure
    // on the page without saying so.
    const rolled = rollUpByBusiness(buildSegmentTotals([
      entry({ N1: { accountType: 'Evaluation - New Thing' } }, [
        { accountName: 'N1', grossRealizedPnl: -25, accountBalance: 1000 },
      ]),
    ]));

    expect(rolled.propOther.dailyPnl).toBe(-25);
    expect(rolled.propOther.segments).toContain('Evaluation - New Thing');
  });

  it('counts the clients behind a rolled-up row by union, never by adding counts', () => {
    // One client holding cash and a bullet-bot evaluation is one client. Adding
    // the two segments' client counts would report two.
    const rolled = rollUpByBusiness(buildSegmentTotals([
      entry({ F: { accountType: 'Funded' }, E: { accountType: 'Evaluation - Standard' } }, [
        { accountName: 'F', grossRealizedPnl: 0 },
        { accountName: 'E', grossRealizedPnl: 0 },
      ], 'solo'),
    ]));

    expect(rolled.propOther.accounts).toBe(2);
    expect(rolled.propOther.clients).toBe(1);
  });

  it('answers for a day with nothing in it', () => {
    const totals = buildSegmentTotals([]);

    expect(totals.segments).toEqual([]);
    expect(rollUpByBusiness(totals).cash.dailyPnl).toBe(0);
    expect(rollUpByBusiness(totals).cash.accounts).toBe(0);
  });
});
