import { describe, expect, it } from 'vitest';
import { SEGMENTS, buildSegmentTotals, rollUpByBusiness, segmentFor } from './operationsSegments';

const entry = (registry, snapshots) => ({
  client: { accountRegistry: registry },
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

  it('keeps ignored and orphan snapshots out of the headline total', () => {
    // The tile answers "how did the book trade today". An account marked
    // Inactive / Ignore is not the book, and a snapshot whose account no longer
    // exists cannot be attributed to anything.
    const totals = buildSegmentTotals([entry(registry, snapshots)]);

    expect(totals.total.dailyPnl).toBe(-850);
    expect(totals.total.accounts).toBe(4);
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

  it('rolls prop and cash apart', () => {
    const rolled = rollUpByBusiness(buildSegmentTotals([entry(registry, snapshots)]));

    expect(rolled.prop.dailyPnl).toBe(-800);
    expect(rolled.prop.accounts).toBe(3);
    expect(rolled.cash.dailyPnl).toBe(-50);
    expect(rolled.cash.accounts).toBe(1);
  });

  it('answers for a day with nothing in it', () => {
    const totals = buildSegmentTotals([]);

    expect(totals.segments).toEqual([]);
    expect(totals.total.dailyPnl).toBe(0);
  });
});
