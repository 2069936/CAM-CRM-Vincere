import { describe, expect, it } from 'vitest';
import { buildStrategyAnalyzer, buildVisibleTabs, filteredAccountsForTab } from './App';

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
    expect(tabs).not.toContain('Simulation');
  });

  /* 126 ACCOUNTS ON 124 CLIENTS WERE IN NO TAB AT ALL.
   *
   * `Simulation` became a real account type on 2026-08-13. By 2026-09-28
   * production held 126 of them, every one Active, across 124 of the book's
   * clients, and not one test or branch above knew the type existed. */
  it('includes Simulation tab when any Simulation account exists', () => {
    const client = { accountRegistry: { A1: { accountType: 'Simulation' } } };
    expect(buildVisibleTabs(client, null)).toContain('Simulation');
  });

  it('catches a Sim101 the desk never retyped', () => {
    // Asked of the classifier, not of the string, so this tab and the split
    // that moves the rows agree about the same account.
    const client = { accountRegistry: { Sim101: { accountType: 'Unassigned' } } };
    expect(buildVisibleTabs(client, null)).toContain('Simulation');
  });

  it('does not put a simulated account on the money tabs', () => {
    const client = { accountRegistry: { Sim101: { accountType: 'Simulation' } } };
    const tabs = buildVisibleTabs(client, null);
    expect(tabs).not.toContain('Funded');
    expect(tabs).not.toContain('Cash');
    expect(tabs).not.toContain('Evaluations');
  });
});

describe('filteredAccountsForTab, Simulation', () => {
  /* THE SIMULATED ROWS ARE NOT IN `snapshots`.
   *
   * reconcileDailyImport splits the close at the boundary: `snapshots` is
   * live money only and everything simulated travels in `simulation`. A tab
   * that filtered `snapshots` would always be empty, which looks exactly like
   * a broken tab. */
  const client = {
    accountRegistry: {
      F1: { accountType: 'Funded' },
      Sim101: { accountType: 'Simulation' },
    },
  };
  const dailyImport = {
    accounts: {},
    snapshots: [{ accountName: 'F1', grossRealizedPnl: 100 }],
    simulation: {
      snapshots: [{ accountName: 'Sim101', grossRealizedPnl: 4200 }],
      undetermined: { snapshots: [] },
    },
  };

  it('reads the rows from the other side of the split', () => {
    const data = filteredAccountsForTab(client, dailyImport, 'Simulation');
    expect(Object.keys(data.accounts)).toEqual(['Sim101']);
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0].accountName).toBe('Sim101');
    expect(data.snapshots[0].grossRealizedPnl).toBe(4200);
  });

  it('keeps the simulated dollars off the Funded tab', () => {
    const data = filteredAccountsForTab(client, dailyImport, 'Funded');
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0].accountName).toBe('F1');
  });

  it('shows an account whose signals disagree rather than losing it', () => {
    // Undetermined rows are in neither the live list nor the simulated one.
    // None exist in production today, measured, but an account that lands
    // there is otherwise invisible in every tab.
    const conflicted = {
      accountRegistry: { Sim101: { accountType: 'Funded' } },
    };
    const close = {
      accounts: {},
      snapshots: [],
      simulation: {
        snapshots: [],
        undetermined: { snapshots: [{ accountName: 'Sim101', grossRealizedPnl: 7 }] },
      },
    };
    const data = filteredAccountsForTab(conflicted, close, 'Simulation');
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0].grossRealizedPnl).toBe(7);
  });

  it('merges dailyImport accounts with registry for tab detection', () => {
    const client = { accountRegistry: {} };
    const dailyImport = { accounts: { A1: { accountType: 'Funded' } } };
    expect(buildVisibleTabs(client, dailyImport)).toContain('Funded');
  });
});
