import { describe, expect, it } from 'vitest';
import { buildManagerSummary } from './App';

function makeClient({ id = 'c1', snapshots = [], flags = [], extraImports = [] } = {}) {
  const latestImport = snapshots.length || flags.length
    ? { id: `${id}-di`, date: '2026-06-25', accounts: {}, snapshots, flags }
    : null;
  return {
    id,
    name: `Client ${id}`,
    accountRegistry: {},
    dailyImports: [
      ...extraImports,
      ...(latestImport ? [latestImport] : []),
    ],
  };
}

function makeSnapshot(accountName, pnl, weeklyPnl = 0, strategies = []) {
  return { accountName, grossRealizedPnl: pnl, weeklyPnl, accountBalance: 50000 + pnl, strategies };
}

// ── buildManagerSummary ───────────────────────────────────────────────────────

describe('buildManagerSummary', () => {
  it('returns zeros for empty client list', () => {
    const s = buildManagerSummary([]);
    expect(s.clients).toBe(0);
    expect(s.accounts).toBe(0);
    expect(s.dailyPnl).toBe(0);
    expect(s.openFlags).toBe(0);
  });

  it('counts total clients and accounts across all latest imports', () => {
    const clients = [
      makeClient({ id: 'c1', snapshots: [makeSnapshot('A1', 100), makeSnapshot('A2', 200)] }),
      makeClient({ id: 'c2', snapshots: [makeSnapshot('B1', 50)] }),
    ];
    const s = buildManagerSummary(clients);
    expect(s.clients).toBe(2);
    expect(s.accounts).toBe(3);
  });

  it('sums daily and weekly P&L across all snapshots', () => {
    const clients = [
      makeClient({ id: 'c1', snapshots: [makeSnapshot('A1', 300, 1200)] }),
      makeClient({ id: 'c2', snapshots: [makeSnapshot('B1', -100, 400)] }),
    ];
    const s = buildManagerSummary(clients);
    expect(s.dailyPnl).toBe(200);
    expect(s.weeklyPnl).toBe(1600);
  });

  it('counts open flags excluding Resolved and Acknowledged', () => {
    const flags = [
      { id: 'f1', severity: 'Critical', status: 'Open', message: 'X' },
      { id: 'f2', severity: 'Warning', status: 'Resolved', message: 'Y' },
      { id: 'f3', severity: 'Warning', status: 'Acknowledged', message: 'Z' },
    ];
    const client = makeClient({ id: 'c1', snapshots: [makeSnapshot('A1', 0)], flags });
    const s = buildManagerSummary([client]);
    expect(s.openFlags).toBe(1);
  });

  it('counts unique running algorithm families', () => {
    const strategies = [
      { strategyFamily: 'RBO', strategyVersion: '1.8', enabled: true },
      { strategyFamily: 'RBO', strategyVersion: '1.8', enabled: true }, // same family+version on second account
      { strategyFamily: 'IFSP', strategyVersion: '2.0', enabled: true },
      { strategyFamily: 'RBO', strategyVersion: '1.8', enabled: false }, // disabled - not counted
    ];
    const clients = [
      makeClient({ id: 'c1', snapshots: [makeSnapshot('A1', 0, 0, [strategies[0]]), makeSnapshot('A2', 0, 0, [strategies[1]])] }),
      makeClient({ id: 'c2', snapshots: [makeSnapshot('B1', 0, 0, [strategies[2]]), makeSnapshot('B2', 0, 0, [strategies[3]])] }),
    ];
    const s = buildManagerSummary(clients);
    // RBO-1.8 and IFSP-2.0 → 2 unique
    expect(s.algorithms).toBe(2);
  });

  it('handles clients with no imports gracefully', () => {
    const client = { id: 'c1', name: 'Empty', accountRegistry: {}, dailyImports: [] };
    expect(() => buildManagerSummary([client])).not.toThrow();
    expect(buildManagerSummary([client]).dailyPnl).toBe(0);
  });
});

// buildTeamHistory's tests used to be here. The function is gone.
//
// It was the second of three answers to "team daily P&L" that the Operations
// screen carried at once, and the only one that filtered nothing: its last cell
// read -$172,979.64 over 333 accounts against a tile reading -$169,926.90 over
// 427, and the per-day gap between the two decomposed exactly to Ignored +
// Orphan on all fourteen closes. The history strip now renders
// buildDeskMoneyHistory, whose guards live in src/domain/deskMoney.test.js
// (synthetic, ungated) and src/domain/deskMoney.book.test.js (the real book).
