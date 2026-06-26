import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPortfolioInsights } from './App';

const TODAY = '2026-06-25'; // Thursday

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`)); });
afterEach(() => { vi.useRealTimers(); });

function makeImport(date, pnls, trailingDD = 0) {
  return {
    id: `di-${date}`,
    date,
    accounts: {},
    snapshots: pnls.map(([name, pnl, bal]) => ({
      accountName: name,
      grossRealizedPnl: pnl,
      accountBalance: bal,
      trailingMaxDrawdown: trailingDD,
    })),
    flags: [],
  };
}

// ── Drawdown Velocity ─────────────────────────────────────────────────────────

describe('Drawdown Velocity insight', () => {
  it('fires warning when model-2 buffer depletes ~100/day and will breach in ≤5 days', () => {
    // buffer today = 400, depleting at ~100/day → ~4 days → warning
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', alias: 'Apex' } },
      dailyImports: [
        makeImport('2026-06-18', [['ACC1', -100, 49100]], 900),
        makeImport('2026-06-19', [['ACC1', -100, 49000]], 800),
        makeImport('2026-06-20', [['ACC1', -100, 48900]], 700),
        makeImport('2026-06-23', [['ACC1', -100, 48800]], 600),
        makeImport('2026-06-24', [['ACC1', -100, 48700]], 500),
        makeImport(TODAY,        [['ACC1', -100, 48600]], 400),
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const dv = insights.filter(i => i.type === 'Drawdown Velocity');
    expect(dv.length).toBeGreaterThanOrEqual(1);
    expect(['warning', 'critical']).toContain(dv[0].severity);
  });

  it('does not fire when buffer is growing', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        makeImport('2026-06-20', [['ACC1', 100, 50200]], 500),
        makeImport('2026-06-23', [['ACC1', 100, 50300]], 600),
        makeImport(TODAY,        [['ACC1', 100, 50400]], 700),
      ],
    };
    expect(buildPortfolioInsights([client]).filter(i => i.type === 'Drawdown Velocity')).toHaveLength(0);
  });
});

// ── Payout Opportunity ────────────────────────────────────────────────────────

describe('Payout Opportunity insight', () => {
  it('fires info-green when funded balance reaches target', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [makeImport(TODAY, [['MFF1', 3200, 53200]])],
    };
    const insights = buildPortfolioInsights([client]);
    const po = insights.filter(i => i.type === 'Payout Opportunity');
    expect(po.length).toBeGreaterThanOrEqual(1);
    expect(po[0].severity).toBe('info-green');
  });

  it('fires info (not info-green) when account is near but not at target', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [makeImport(TODAY, [['MFF1', 2800, 52800]])], // 96% of target
    };
    const insights = buildPortfolioInsights([client]);
    const po = insights.filter(i => i.type === 'Payout Opportunity');
    expect(po.length).toBeGreaterThanOrEqual(1);
    expect(po[0].severity).toBe('info');
  });
});

// ── Strategy Cooling ──────────────────────────────────────────────────────────

describe('Strategy Cooling insight', () => {
  it('fires warning when algo was profitable then turned consistently negative', () => {
    const strat = [{ strategyFamily: 'RBO', strategyName: '0-RBO-1.8', enabled: true }];
    function snap(name, pnl) { return { accountName: name, grossRealizedPnl: pnl, accountBalance: 50000 + pnl, strategies: strat }; }
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        { id: 'd1', date: '2026-06-10', accounts: {}, snapshots: [snap('ACC1', 200)], flags: [] },
        { id: 'd2', date: '2026-06-11', accounts: {}, snapshots: [snap('ACC1', 150)], flags: [] },
        { id: 'd3', date: '2026-06-12', accounts: {}, snapshots: [snap('ACC1', 180)], flags: [] },
        { id: 'd4', date: '2026-06-13', accounts: {}, snapshots: [snap('ACC1', -200)], flags: [] },
        { id: 'd5', date: '2026-06-16', accounts: {}, snapshots: [snap('ACC1', -180)], flags: [] },
        { id: 'd6', date: '2026-06-17', accounts: {}, snapshots: [snap('ACC1', -160)], flags: [] },
        { id: 'd7', date: '2026-06-18', accounts: {}, snapshots: [snap('ACC1', -140)], flags: [] },
        { id: 'd8', date: TODAY,        accounts: {}, snapshots: [snap('ACC1', -120)], flags: [] },
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const sc = insights.filter(i => i.type === 'Strategy Cooling');
    expect(sc.length).toBeGreaterThanOrEqual(1);
    expect(sc[0].severity).toBe('warning');
  });

  it('does not fire when account has fewer than 6 data points', () => {
    const strat = [{ strategyFamily: 'RBO', enabled: true }];
    function snap(name, pnl) { return { accountName: name, grossRealizedPnl: pnl, accountBalance: 50000, strategies: strat }; }
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        { id: 'd1', date: '2026-06-20', accounts: {}, snapshots: [snap('ACC1', -100)], flags: [] },
        { id: 'd2', date: TODAY,        accounts: {}, snapshots: [snap('ACC1', -100)], flags: [] },
      ],
    };
    expect(buildPortfolioInsights([client]).filter(i => i.type === 'Strategy Cooling')).toHaveLength(0);
  });
});

// ── Sort order ────────────────────────────────────────────────────────────────

describe('insight sort order', () => {
  it('returns critical insights before warnings before info', () => {
    // Use payout (info-green) + consistency warning (from >50% best-day ratio) on same client
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [
        { id: 'd1', date: '2026-06-20', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 100, accountBalance: 50100 }], flags: [] },
        { id: 'd2', date: '2026-06-21', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 100, accountBalance: 50200 }], flags: [] },
        { id: 'd3', date: '2026-06-22', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 700, accountBalance: 53200 }], flags: [] },
        makeImport(TODAY, [['MFF1', 0, 53200]]),
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const severityOrder = { critical: 0, warning: 1, 'info-green': 2, info: 3 };
    for (let i = 1; i < insights.length; i++) {
      expect(severityOrder[insights[i].severity] ?? 4).toBeGreaterThanOrEqual(severityOrder[insights[i - 1].severity] ?? 4);
    }
  });
});
