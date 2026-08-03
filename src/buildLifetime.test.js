import { describe, expect, it, vi } from 'vitest';
import { buildLifetimeStats, buildMonthlyTotals } from './App';

function makeClient(dailyPnls) {
  return {
    profile: {},
    dailyImports: dailyPnls.map((pnl, i) => ({
      id: `di-${i}`,
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{ accountName: 'ACC1', grossRealizedPnl: pnl }],
    })),
  };
}

// ── buildLifetimeStats ────────────────────────────────────────────────────────

describe('buildLifetimeStats', () => {
  it('returns null for client with no imports', () => {
    expect(buildLifetimeStats({ dailyImports: [] })).toBeNull();
  });

  it('computes totalPnl and win rate correctly', () => {
    const client = makeClient([200, -50, 300, 0, 100]);
    const stats = buildLifetimeStats(client);
    expect(stats.totalPnl).toBe(550);
    expect(stats.totalDays).toBe(5);
    expect(stats.positiveDays).toBe(3);
    expect(stats.negativeDays).toBe(1);
    // winRate = round(3/5 * 100) = 60
    expect(stats.winRate).toBe(60);
  });

  it('identifies best and worst day with their dates', () => {
    const client = makeClient([100, 500, -200]);
    const stats = buildLifetimeStats(client);
    expect(stats.bestDay).toBe(500);
    expect(stats.bestDayDate).toBe('2026-06-02');
    expect(stats.worstDay).toBe(-200);
    expect(stats.worstDayDate).toBe('2026-06-03');
  });

  it('computes current positive streak from tail of imports', () => {
    // last 3 days positive → streak 3
    const client = makeClient([-100, 200, 300, 150]);
    const stats = buildLifetimeStats(client);
    expect(stats.streak).toBe(3);
    expect(stats.streakType).toBe(true);
  });

  it('computes current negative streak from tail of imports', () => {
    const client = makeClient([200, -100, -50]);
    const stats = buildLifetimeStats(client);
    expect(stats.streak).toBe(2);
    expect(stats.streakType).toBe(false);
  });

  it('computes avgDay as totalPnl / totalDays', () => {
    const client = makeClient([100, 200, 300]);
    const stats = buildLifetimeStats(client);
    expect(stats.avgDay).toBeCloseTo(200, 5);
  });

  it('computes daysSinceStart from first import date when profile.startDate absent', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-25T12:00:00'));
    // makeClient creates dates starting at 2026-06-01
    const stats = buildLifetimeStats(makeClient([100]));
    // 2026-06-25 - 2026-06-01 = 24 days
    expect(stats.daysSinceStart).toBe(24);
    expect(stats.startDate).toBe('2026-06-01');
    vi.useRealTimers();
  });

  it('uses profile.startDate over first import date', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-25T12:00:00'));
    const client = { profile: { startDate: '2026-06-15' }, dailyImports: [{ id: 'd1', date: '2026-06-20', snapshots: [{ accountName: 'A1', grossRealizedPnl: 100 }] }] };
    const stats = buildLifetimeStats(client);
    // 2026-06-25 - 2026-06-15 = 10 days
    expect(stats.daysSinceStart).toBe(10);
    expect(stats.startDate).toBe('2026-06-15');
    vi.useRealTimers();
  });
});

// ── buildMonthlyTotals ────────────────────────────────────────────────────────

describe('buildMonthlyTotals', () => {
  it('returns empty array for client with no imports', () => {
    expect(buildMonthlyTotals({ dailyImports: [] })).toHaveLength(0);
  });

  it('groups imports by month and sums P&L', () => {
    const client = {
      dailyImports: [
        { date: '2026-05-30', snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 200 }] },
        { date: '2026-06-01', snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 300 }] },
        { date: '2026-06-02', snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 100 }] },
      ],
    };
    const totals = buildMonthlyTotals(client);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ month: '2026-05', monthlyPnl: 200, closedDays: 1 });
    expect(totals[1]).toMatchObject({ month: '2026-06', monthlyPnl: 400, closedDays: 2 });
  });

  it('sorts months ascending', () => {
    const client = {
      dailyImports: [
        { date: '2026-08-01', snapshots: [{ accountName: 'A', grossRealizedPnl: 100 }] },
        { date: '2026-06-01', snapshots: [{ accountName: 'A', grossRealizedPnl: 50 }] },
        { date: '2026-07-01', snapshots: [{ accountName: 'A', grossRealizedPnl: 75 }] },
      ],
    };
    const months = buildMonthlyTotals(client).map(m => m.month);
    expect(months).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('tracks peak account count per month', () => {
    const client = {
      dailyImports: [
        { date: '2026-06-01', snapshots: [{ accountName: 'A', grossRealizedPnl: 0 }, { accountName: 'B', grossRealizedPnl: 0 }] },
        { date: '2026-06-02', snapshots: [{ accountName: 'A', grossRealizedPnl: 0 }] },
      ],
    };
    const [june] = buildMonthlyTotals(client);
    expect(june.accounts).toBe(2);
  });

  it('skips entries with no date', () => {
    const client = {
      dailyImports: [
        { date: '', snapshots: [{ accountName: 'A', grossRealizedPnl: 999 }] },
        { date: '2026-06-01', snapshots: [{ accountName: 'A', grossRealizedPnl: 100 }] },
      ],
    };
    const totals = buildMonthlyTotals(client);
    expect(totals).toHaveLength(1);
    expect(totals[0].monthlyPnl).toBe(100);
  });
});
