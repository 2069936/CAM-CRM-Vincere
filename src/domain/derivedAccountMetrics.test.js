import { describe, expect, it } from 'vitest';
import {
  deriveTrailingDrawdown,
  deriveWeeklyPnl,
  drawdownThresholds,
  weekStart,
} from './derivedAccountMetrics';

const close = (date, balance, pnl = 0, account = 'ACC1') => ({
  date,
  snapshots: [{ accountName: account, accountBalance: balance, grossRealizedPnl: pnl }],
});

describe('weekStart', () => {
  it('returns the Monday of that week', () => {
    expect(weekStart('2026-07-22')).toBe('2026-07-20'); // Wednesday -> Monday
    expect(weekStart('2026-07-20')).toBe('2026-07-20'); // Monday stays
    expect(weekStart('2026-07-24')).toBe('2026-07-20'); // Friday
  });

  it('puts Sunday with the week that just ended', () => {
    expect(weekStart('2026-07-26')).toBe('2026-07-20');
  });

  it('rejects a malformed date instead of guessing', () => {
    expect(weekStart('soon')).toBe('');
    expect(weekStart('')).toBe('');
  });
});

describe('deriveWeeklyPnl', () => {
  const week = [
    close('2026-07-20', 50100, 100),
    close('2026-07-21', 49900, -200),
    close('2026-07-22', 50250, 350),
  ];

  it('sums the realized PnL of the week so far', () => {
    expect(deriveWeeklyPnl(week, 'ACC1', '2026-07-22')).toMatchObject({
      value: 250, daysCounted: 3, weekStart: '2026-07-20', source: 'derived',
    });
  });

  it('stops at the day asked about rather than using later closes', () => {
    expect(deriveWeeklyPnl(week, 'ACC1', '2026-07-21').value).toBe(-100);
  });

  it('excludes the previous week', () => {
    const withLastWeek = [close('2026-07-17', 49000, 9999), ...week];
    expect(deriveWeeklyPnl(withLastWeek, 'ACC1', '2026-07-22').value).toBe(250);
  });

  it('is null when the account has no closes that week', () => {
    expect(deriveWeeklyPnl(week, 'OTHER', '2026-07-22')).toBeNull();
    expect(deriveWeeklyPnl([], 'ACC1', '2026-07-22')).toBeNull();
  });

  it('matches the account case-insensitively', () => {
    expect(deriveWeeklyPnl(week, 'acc1', '2026-07-22').value).toBe(250);
  });
});

describe('deriveTrailingDrawdown', () => {
  it('measures the fall from the highest recorded balance', () => {
    const history = [
      close('2026-07-20', 50000),
      close('2026-07-21', 51500),   // peak
      close('2026-07-22', 50600),
    ];
    expect(deriveTrailingDrawdown(history, 'ACC1', '2026-07-22')).toMatchObject({
      value: 900, peak: 51500, peakDate: '2026-07-21', closesUsed: 3, isLowerBound: true,
    });
  });

  it('measures from the starting balance when the account only ever lost', () => {
    const history = [close('2026-07-20', 49000), close('2026-07-21', 48500)];
    expect(deriveTrailingDrawdown(history, 'ACC1', '2026-07-21', { startBalance: 50000 }))
      .toMatchObject({ value: 1500, peak: 50000 });
  });

  it('reports zero at a fresh high rather than a negative drawdown', () => {
    const history = [close('2026-07-20', 50000), close('2026-07-21', 52000)];
    expect(deriveTrailingDrawdown(history, 'ACC1', '2026-07-21').value).toBe(0);
  });

  it('flags a history with holes, since the peak may be in one', () => {
    const gapped = [close('2026-07-20', 50000), close('2026-07-24', 49000)];
    expect(deriveTrailingDrawdown(gapped, 'ACC1', '2026-07-24').hasGaps).toBe(true);

    const complete = [
      close('2026-07-20', 50000), close('2026-07-21', 50100),
      close('2026-07-22', 50200), close('2026-07-23', 50300), close('2026-07-24', 49000),
    ];
    expect(deriveTrailingDrawdown(complete, 'ACC1', '2026-07-24').hasGaps).toBe(false);
  });

  it('refuses to answer for a day it has no close for', () => {
    const history = [close('2026-07-20', 50000)];
    expect(deriveTrailingDrawdown(history, 'ACC1', '2026-07-22')).toBeNull();
  });

  it('ignores closes after the day asked about', () => {
    const history = [
      close('2026-07-20', 50000),
      close('2026-07-21', 49000),
      close('2026-07-22', 60000),   // a later peak must not affect an earlier day
    ];
    expect(deriveTrailingDrawdown(history, 'ACC1', '2026-07-21').value).toBe(1000);
  });

  it('is null with no history at all', () => {
    expect(deriveTrailingDrawdown([], 'ACC1', '2026-07-22')).toBeNull();
  });
});

describe('drawdownThresholds', () => {
  it('warns earlier on a derived number, because the real drawdown can only be worse', () => {
    const derived = drawdownThresholds('derived');
    const reported = drawdownThresholds('reported');
    expect(derived.critical).toBeGreaterThan(reported.critical);
    expect(derived.warning).toBeGreaterThan(reported.warning);
  });
});

describe('against the real exported numbers', () => {
  // Two Legends accounts running the same mirrored bullet bot: different
  // balances, identical reported trailing of 888.48 — consistent with the grid
  // reporting distance from peak rather than remaining room.
  it('reproduces a reported drawdown from the peak that produced it', () => {
    const history = [
      close('2026-07-20', 50241.32),   // peak
      close('2026-07-21', 49352.84),
    ];
    const derived = deriveTrailingDrawdown(history, 'ACC1', '2026-07-21');
    expect(derived.value).toBeCloseTo(888.48, 2);
  });
});
