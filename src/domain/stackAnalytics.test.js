import { describe, it, expect } from 'vitest';
import { buildAccountEquitySeries, projectDaysToBreach, buildAccountStreaks, buildComboByFirm } from './stackAnalytics';

function di(date, snap) {
  return { date, snapshots: snap ? [snap] : [] };
}

const client = {
  dailyImports: [
    // out of order on purpose - the series must sort by date
    di('2026-07-03', { accountName: 'A1', grossRealizedPnl: -200, accountBalance: 50100, trailingMaxDrawdown: -600 }),
    di('2026-07-01', { accountName: 'A1', grossRealizedPnl: 300, accountBalance: 50300, trailingMaxDrawdown: -200 }),
    di('2026-07-02', { accountName: 'A1', grossRealizedPnl: 0, accountBalance: 50300, trailingMaxDrawdown: -400 }),
    di('2026-07-03', { accountName: 'OTHER', grossRealizedPnl: 999 }), // different account, ignored
  ],
};

describe('buildAccountEquitySeries', () => {
  it('builds a chronological cumulative series for the account', () => {
    const series = buildAccountEquitySeries(client, 'A1');
    expect(series.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(series.map((p) => p.cumPnl)).toEqual([300, 300, 100]);
    expect(series[2].trailing).toBe(-600);
  });

  it('is case-insensitive on account name and returns [] for unknown accounts', () => {
    expect(buildAccountEquitySeries(client, 'a1')).toHaveLength(3);
    expect(buildAccountEquitySeries(client, 'nope')).toEqual([]);
  });
});

describe('projectDaysToBreach', () => {
  it('projects days to breach when the buffer is shrinking (configured limit)', () => {
    // ddLimit 2000; trailing -600/-400/-200... build a shrinking-buffer series
    const series = [
      { trailing: -400 }, // buffer 1600
      { trailing: -600 }, // buffer 1400
      { trailing: -800 }, // buffer 1200
    ];
    const r = projectDaysToBreach(series, 2000);
    expect(r.slope).toBeCloseTo(-200); // buffer drops 200/day
    expect(r.current).toBe(1200);
    expect(r.daysToBreach).toBe(6); // 1200 / 200
  });

  it('returns null daysToBreach when the buffer is stable or growing', () => {
    const series = [{ trailing: -800 }, { trailing: -600 }, { trailing: -400 }];
    const r = projectDaysToBreach(series, 2000);
    expect(r.daysToBreach).toBeNull();
  });

  it('returns null without enough points', () => {
    expect(projectDaysToBreach([{ trailing: -100 }], 2000)).toBeNull();
  });
});

describe('buildAccountStreaks', () => {
  it('computes win rate and current/longest streaks, skipping flat days', () => {
    const series = [
      { dayPnl: 100 }, { dayPnl: 50 }, { dayPnl: 0 }, { dayPnl: -20 }, { dayPnl: -10 }, { dayPnl: -5 },
    ];
    const s = buildAccountStreaks(series);
    expect(s.tradingDays).toBe(5); // flat day skipped
    expect(s.winRate).toBe(40); // 2 of 5
    expect(s.longestWin).toBe(2);
    expect(s.longestLoss).toBe(3);
    expect(s.currentStreak).toBe(-3); // ending on a 3-day losing streak
  });
});

describe('buildComboByFirm', () => {
  it('cross-tabs avg PnL by combo and firm', () => {
    const comboFn = (strats) => strats[0]?.combo || 'Unknown';
    const clients = [{
      dailyImports: [
        { snapshots: [{ strategies: [{ combo: 'URGO' }], connection: 'Lucid', grossRealizedPnl: 100 }] },
        { snapshots: [{ strategies: [{ combo: 'URGO' }], connection: 'Lucid', grossRealizedPnl: 200 }] },
        { snapshots: [{ strategies: [{ combo: 'URGO' }], connection: 'Tradeify', grossRealizedPnl: -50 }] },
      ],
    }];
    const result = buildComboByFirm(clients, comboFn);
    expect(result.combos).toEqual(['URGO']);
    expect(result.firms).toEqual(expect.arrayContaining(['Lucid', 'Tradeify']));
    const lucid = result.matrix[0].cells.find((c) => c.firm === 'Lucid');
    expect(lucid.avgPnl).toBeCloseTo(150);
    expect(lucid.days).toBe(2);
  });
});
