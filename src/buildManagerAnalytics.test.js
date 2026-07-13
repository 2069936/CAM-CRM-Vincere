import { describe, expect, it } from 'vitest';
import { buildManagerSummary, buildTeamHistory } from './App';

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

// ── buildTeamHistory ──────────────────────────────────────────────────────────

describe('buildTeamHistory', () => {
  it('returns empty array for empty client list', () => {
    expect(buildTeamHistory([])).toHaveLength(0);
  });

  it('aggregates P&L across clients for the same date', () => {
    const clients = [
      makeClient({ id: 'c1', extraImports: [{ id: 'd1', date: '2026-06-24', accounts: {}, snapshots: [makeSnapshot('A1', 200, 800)], flags: [] }] }),
      makeClient({ id: 'c2', extraImports: [{ id: 'd2', date: '2026-06-24', accounts: {}, snapshots: [makeSnapshot('B1', 100, 400)], flags: [] }] }),
    ];
    const history = buildTeamHistory(clients);
    const entry = history.find(h => h.date === '2026-06-24');
    expect(entry).toBeDefined();
    expect(entry.dailyPnl).toBe(300);
    expect(entry.weeklyPnl).toBe(1200);
    expect(entry.accounts).toBe(2);
  });

  it('returns entries sorted ascending by date', () => {
    const clients = [
      {
        id: 'c1', name: 'C', accountRegistry: {}, dailyImports: [
          { id: 'd3', date: '2026-06-25', accounts: {}, snapshots: [makeSnapshot('A', 100)], flags: [] },
          { id: 'd1', date: '2026-06-23', accounts: {}, snapshots: [makeSnapshot('A', 200)], flags: [] },
          { id: 'd2', date: '2026-06-24', accounts: {}, snapshots: [makeSnapshot('A', 150)], flags: [] },
        ],
      },
    ];
    const dates = buildTeamHistory(clients).map(h => h.date);
    expect(dates).toEqual(['2026-06-23', '2026-06-24', '2026-06-25']);
  });

  it('tracks account count as sum across all clients for a given date', () => {
    const make = (id, date, count) => ({
      id, name: id, accountRegistry: {},
      dailyImports: [{ id: `${id}-d`, date, accounts: {}, flags: [],
        snapshots: Array.from({ length: count }, (_, i) => makeSnapshot(`${id}-A${i}`, 0)) }],
    });
    const history = buildTeamHistory([make('c1', '2026-06-25', 3), make('c2', '2026-06-25', 2)]);
    expect(history[0].accounts).toBe(5);
  });
});
