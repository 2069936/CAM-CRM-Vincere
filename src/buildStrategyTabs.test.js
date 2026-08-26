import { describe, expect, it } from 'vitest';
import { buildStrategyAnalyzer, buildVisibleTabs } from './App';

// ── buildStrategyAnalyzer ─────────────────────────────────────────────────────

function makeAnalyzerClient(strategyRows) {
  return {
    id: 'c1', name: 'Pedro',
    accountRegistry: {},
    dailyImports: [{
      id: 'di-latest', date: '2026-06-25', accounts: {},
      snapshots: strategyRows.map(({ account, pnl, weeklyPnl, strategies }) => ({
        accountName: account, grossRealizedPnl: pnl, weeklyPnl, strategies,
      })),
      flags: [],
    }],
  };
}

describe('buildStrategyAnalyzer', () => {
  it('returns empty for empty client list', () => {
    expect(buildStrategyAnalyzer([])).toHaveLength(0);
  });

  it('returns empty for clients with no imports', () => {
    expect(buildStrategyAnalyzer([{ id: 'c1', name: 'X', accountRegistry: {}, dailyImports: [] }])).toHaveLength(0);
  });

  it('aggregates instances and realized P&L per strategy family', () => {
    const client = makeAnalyzerClient([
      { account: 'A1', pnl: 200, weeklyPnl: 800, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 150 }] },
      { account: 'A2', pnl: 100, weeklyPnl: 400, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] },
    ]);
    const [row] = buildStrategyAnalyzer([client]);
    expect(row.name).toBe('RBO');
    expect(row.count).toBe(2);
    expect(row.accounts).toBe(2);
    expect(row.totalRealized).toBe(250);
  });

  it('computes avgDaily as totalRealized / count', () => {
    const client = makeAnalyzerClient([
      { account: 'A1', pnl: 100, weeklyPnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 300 }] },
      { account: 'A2', pnl: 100, weeklyPnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] },
    ]);
    const [row] = buildStrategyAnalyzer([client]);
    expect(row.avgDaily).toBe(200); // 400/2
  });

  it('publishes no composite score', () => {
    // This test used to assert `Number(row.score)` was between 0 and 10, and
    // read NaN as soon as the field went: `Number(undefined)` is NaN, and NaN
    // fails both comparisons, so the assertion could only ever have been
    // pinning a field that existed. The field was removed with
    // buildStrategyEffectiveness (see the note in App.jsx) because a single
    // 0-10 number over the whole desk ranks deployment size, not performance.
    // What is pinned now is its absence.
    const client = makeAnalyzerClient([
      { account: 'A1', pnl: 100, weeklyPnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] },
    ]);
    const [row] = buildStrategyAnalyzer([client]);
    expect(row).not.toHaveProperty('score');
    expect(Object.keys(row).sort()).toEqual(
      ['accounts', 'avgDaily', 'count', 'name', 'totalRealized'],
    );
  });

  it('sorts by totalRealized descending', () => {
    const client = makeAnalyzerClient([
      { account: 'A1', pnl: 50, weeklyPnl: 0, strategies: [{ strategyFamily: 'OGX', enabled: true, realized: 50 }] },
      { account: 'A2', pnl: 300, weeklyPnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 300 }] },
    ]);
    const results = buildStrategyAnalyzer([client]);
    expect(results[0].name).toBe('RBO');
    expect(results[1].name).toBe('OGX');
  });

  it('counts unique accounts (not instances) in the accounts field', () => {
    // Same account runs two RBO strategies → accounts=1, count=2
    const client = makeAnalyzerClient([
      { account: 'A1', pnl: 200, weeklyPnl: 0, strategies: [
        { strategyFamily: 'RBO', enabled: true, realized: 100 },
        { strategyFamily: 'RBO', enabled: true, realized: 80 },
      ]},
    ]);
    const [row] = buildStrategyAnalyzer([client]);
    expect(row.accounts).toBe(1);
    expect(row.count).toBe(2);
  });
});

// ── buildVisibleTabs ──────────────────────────────────────────────────────────

describe('buildVisibleTabs', () => {
  it('always includes Overview as first tab', () => {
    const client = { accountRegistry: {} };
    const tabs = buildVisibleTabs(client, null);
    expect(tabs[0]).toBe('Overview');
  });

  it('includes Review tab when any account is Unassigned', () => {
    const client = { accountRegistry: { A1: { accountType: 'Unassigned' } } };
    expect(buildVisibleTabs(client, null)).toContain('Review');
  });

  it('includes Evaluations tab when any Evaluation account exists', () => {
    const client = { accountRegistry: { A1: { accountType: 'Evaluation - Standard' } } };
    expect(buildVisibleTabs(client, null)).toContain('Evaluations');
  });

  it('includes Funded tab when any Funded account exists', () => {
    const client = { accountRegistry: { A1: { accountType: 'Funded' } } };
    expect(buildVisibleTabs(client, null)).toContain('Funded');
  });

  it('includes Cash tab when any Cash account exists', () => {
    const client = { accountRegistry: { A1: { accountType: 'Cash' } } };
    expect(buildVisibleTabs(client, null)).toContain('Cash');
  });

  it('does not include account-specific tabs when no matching accounts', () => {
    const client = { accountRegistry: {} };
    const tabs = buildVisibleTabs(client, null);
    expect(tabs).not.toContain('Funded');
    expect(tabs).not.toContain('Evaluations');
    expect(tabs).not.toContain('Cash');
    expect(tabs).not.toContain('Review');
  });

  it('merges dailyImport accounts with registry for tab detection', () => {
    const client = { accountRegistry: {} };
    const dailyImport = { accounts: { A1: { accountType: 'Funded' } } };
    expect(buildVisibleTabs(client, dailyImport)).toContain('Funded');
  });
});
