import { describe, expect, it } from 'vitest';
import { buildPerformanceSeries, summarizePerformance } from './performanceSeries';

const day = (date, dailyPnl, balance, accounts = 1) => ({ date, dailyPnl, balance, accounts });

describe('buildPerformanceSeries', () => {
  it('accumulates profit and loss rather than tracking balance', () => {
    const points = buildPerformanceSeries([
      day('2026-07-20', 500, 50500),
      day('2026-07-21', -200, 50300),
      day('2026-07-22', 700, 51000),
    ]);

    expect(points.map((point) => point.cumulativePnl)).toEqual([500, 300, 1000]);
  });

  it('sorts by date so an out-of-order import does not scramble the curve', () => {
    const points = buildPerformanceSeries([
      day('2026-07-22', 700, 51000),
      day('2026-07-20', 500, 50500),
      day('2026-07-21', -200, 50300),
    ]);

    expect(points.map((point) => point.date)).toEqual([
      '2026-07-20', '2026-07-21', '2026-07-22',
    ]);
    expect(points[2].cumulativePnl).toBe(1000);
  });

  it('does not report a loss on the day a client adds an account', () => {
    // The whole reason for chain-linking. Day three opens a second 100k account
    // and still earns money. Dividing cumulative P&L by the new, much larger
    // balance would print a fall in return on a day the client grew.
    const points = buildPerformanceSeries([
      day('2026-07-20', 500, 50500, 1),
      day('2026-07-21', 500, 51000, 1),
      day('2026-07-22', 500, 151500, 2),
    ]);

    const returns = points.map((point) => point.cumulativeReturnPct);
    expect(returns[1]).toBeGreaterThan(returns[0]);
    expect(returns[2]).toBeGreaterThan(returns[1]);

    // The naive figure — cumulative P&L over the closing balance — reads 0.99%
    // on day three, lower than day two's, because the denominator tripled while
    // the client was making money.
    const naive = (points[2].cumulativePnl / 151500) * 100;
    expect(naive).toBeLessThan(returns[1]);

    // Chain-linking keeps the two 1% days on 50k intact and adds day three's
    // smaller return on the larger base.
    expect(returns[2]).toBeCloseTo(2.35, 1);
    expect(returns[2]).toBeGreaterThan(naive * 2);
  });

  it('measures each day against the capital working that day', () => {
    const points = buildPerformanceSeries([day('2026-07-20', 500, 50500)]);

    expect(points[0].capitalBase).toBe(50000);
    expect(points[0].dailyReturnPct).toBeCloseTo(1, 6);
  });

  it('compounds rather than adding daily returns', () => {
    const points = buildPerformanceSeries([
      day('2026-07-20', 1000, 11000),
      day('2026-07-21', 1100, 12100),
    ]);

    // 10% then 10% is 21%, not 20%.
    expect(points[1].cumulativeReturnPct).toBeCloseTo(21, 6);
  });

  it('leaves the percentage absent when no capital was working', () => {
    // A division by zero rendered as "0.0%" would read as a flat day rather
    // than as a day with nothing to measure against.
    const points = buildPerformanceSeries([
      day('2026-07-20', 0, 0),
      day('2026-07-21', 250, 50250),
    ]);

    expect(points[0].dailyReturnPct).toBeNull();
    expect(points[0].cumulativeReturnPct).toBeNull();
    expect(points[1].cumulativeReturnPct).toBeCloseTo(0.5, 6);
  });

  it('treats missing and unparseable figures as zero without breaking the curve', () => {
    const points = buildPerformanceSeries([
      { date: '2026-07-20', dailyPnl: null, balance: 50000 },
      { date: '2026-07-21', dailyPnl: 'abc', balance: 50000 },
      day('2026-07-22', 100, 50100),
    ]);

    expect(points.map((point) => point.cumulativePnl)).toEqual([0, 0, 100]);
  });

  it('drops entries without a date instead of charting them at the origin', () => {
    const points = buildPerformanceSeries([
      day('2026-07-20', 500, 50500),
      { dailyPnl: 900, balance: 60000 },
      null,
    ]);

    expect(points).toHaveLength(1);
  });

  it('returns nothing for empty history', () => {
    expect(buildPerformanceSeries([])).toEqual([]);
    expect(buildPerformanceSeries()).toEqual([]);
  });
});

describe('summarizePerformance', () => {
  const points = buildPerformanceSeries([
    day('2026-07-20', 500, 50500),
    day('2026-07-21', -800, 49700),
    day('2026-07-22', 300, 50000),
    day('2026-07-23', 1200, 51200),
  ]);

  it('reports the net, the green-day count, and the best and worst days', () => {
    const summary = summarizePerformance(points);

    expect(summary.netPnl).toBe(1200);
    expect(summary.greenDays).toBe(3);
    expect(summary.tradingDays).toBe(4);
    expect(summary.bestDay.dailyPnl).toBe(1200);
    expect(summary.worstDay.dailyPnl).toBe(-800);
  });

  it('measures the deepest dip from the running peak, not from the start', () => {
    // Peak is 500 after day one, cumulative falls to -300 on day two, so the
    // dip is 800. Measuring from zero would call it 300 and understate it.
    expect(summarizePerformance(points).maxDrawdown).toBe(-800);
  });

  it('reports no drawdown for a curve that only rises', () => {
    const rising = buildPerformanceSeries([
      day('2026-07-20', 100, 50100),
      day('2026-07-21', 200, 50300),
    ]);

    expect(summarizePerformance(rising).maxDrawdown).toBe(0);
  });

  it('answers safely for empty history', () => {
    const summary = summarizePerformance([]);

    expect(summary.netPnl).toBe(0);
    expect(summary.returnPct).toBeNull();
    expect(summary.tradingDays).toBe(0);
  });
});
