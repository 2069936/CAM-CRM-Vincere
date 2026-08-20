import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAllFundedAccounts, buildStrategyEffectiveness } from './App';

// ── buildAllFundedAccounts ────────────────────────────────────────────────────

function makeFundedClient({ id = 'c1', name = 'Pedro', balance = 51500, ddLimit = 2000, rawDD = -500, target = 53000, start = 50000, strategies = [] } = {}) {
  const accountName = 'APEX1';
  return {
    id, name,
    accountRegistry: {
      [accountName]: {
        accountName, alias: 'Apex Main', accountType: 'Funded', status: 'Active',
        maxDrawdownLimit: ddLimit, targetProfit: target, startBalance: start,
        payoutState: 'Not requested',
      },
    },
    dailyImports: [{
      id: `${id}-di`, date: '2026-06-25', accounts: {},
      snapshots: [{ accountName, grossRealizedPnl: 200, weeklyPnl: 800, accountBalance: balance, trailingMaxDrawdown: rawDD, strategies }],
      flags: [],
    }],
  };
}

describe('buildAllFundedAccounts', () => {
  it('returns empty for clients with no imports', () => {
    const client = { id: 'c1', name: 'X', accountRegistry: {}, dailyImports: [] };
    expect(buildAllFundedAccounts([client], [])).toHaveLength(0);
  });

  it('only includes Funded account type', () => {
    const client = {
      id: 'c1', name: 'X',
      accountRegistry: {
        A1: { accountName: 'A1', accountType: 'Funded' },
        A2: { accountName: 'A2', accountType: 'Evaluation - Standard' },
      },
      dailyImports: [{
        id: 'd1', date: '2026-06-25', accounts: {},
        snapshots: [
          { accountName: 'A1', grossRealizedPnl: 100, weeklyPnl: 400, accountBalance: 50100 },
          { accountName: 'A2', grossRealizedPnl: 50, weeklyPnl: 200, accountBalance: 50050 },
        ],
        flags: [],
      }],
    };
    const rows = buildAllFundedAccounts([client], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountName).toBe('A1');
  });

  it('computes model-1 buffer (ddLimit - |rawDD|)', () => {
    const client = makeFundedClient({ ddLimit: 2000, rawDD: -800 }); // buffer = 1200
    const [row] = buildAllFundedAccounts([client], []);
    expect(row.buffer).toBe(1200);
    expect(row.bufferPct).toBe(60); // 1200/2000 * 100
  });

  it('uses rawDD directly as buffer for model-2 (no ddLimit)', () => {
    const client = makeFundedClient({ ddLimit: 0, rawDD: 900 }); // model-2: buffer = 900
    const [row] = buildAllFundedAccounts([client], []);
    expect(row.buffer).toBe(900);
    expect(row.bufferPct).toBeNull();
  });

  it('computes targetPct as progress toward payout target', () => {
    // start=50000, target=53000, balance=51500 → progress = 1500/3000 = 50%
    const client = makeFundedClient({ balance: 51500, target: 53000, start: 50000 });
    const [row] = buildAllFundedAccounts([client], []);
    expect(row.targetPct).toBe(50);
  });

  it('resolves CAM name from camProfiles', () => {
    const cam = { id: 'cam-1', name: 'Maria', clientIds: ['c1'] };
    const client = makeFundedClient({ id: 'c1' });
    const [row] = buildAllFundedAccounts([client], [cam]);
    expect(row.camName).toBe('Maria');
  });

  it('sorts most at-risk accounts first (lowest bufferPct ascending)', () => {
    const clients = [
      makeFundedClient({ id: 'c1', name: 'Safe', ddLimit: 2000, rawDD: -200 }),   // 90% buffer
      makeFundedClient({ id: 'c2', name: 'AtRisk', ddLimit: 2000, rawDD: -1800 }), // 10% buffer
    ];
    const rows = buildAllFundedAccounts(clients, []);
    expect(rows[0].clientName).toBe('AtRisk');
    expect(rows[1].clientName).toBe('Safe');
  });
});

// ── buildStrategyEffectiveness ────────────────────────────────────────────────

describe('buildStrategyEffectiveness', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-25T12:00:00')); });
  afterEach(() => { vi.useRealTimers(); });

  function makeStratClient(stratName, dailyData) {
    return {
      id: 'c1', name: 'Pedro',
      accountRegistry: {},
      dailyImports: dailyData.map(({ date, pnl }) => ({
        id: `di-${date}`, date, accounts: {},
        snapshots: [{
          accountName: 'ACC1', grossRealizedPnl: pnl, weeklyPnl: 0,
          strategies: [{ strategyFamily: stratName, strategyName: `0-${stratName}`, enabled: true, realized: pnl }],
        }],
        flags: [],
      })),
    };
  }

  it('returns empty for clients with no imports', () => {
    expect(buildStrategyEffectiveness([])).toHaveLength(0);
  });

  it('aggregates total P&L and win/loss days per strategy', () => {
    const client = makeStratClient('RBO', [
      { date: '2026-06-20', pnl: 200 },
      { date: '2026-06-21', pnl: -100 },
      { date: '2026-06-22', pnl: 300 },
    ]);
    const [row] = buildStrategyEffectiveness([client]);
    expect(row.name).toBe('RBO');
    expect(row.totalPnl).toBe(400);
    expect(row.winDays).toBe(2);
    expect(row.lossDays).toBe(1);
    expect(row.winRate).toBe(67); // round(2/3 * 100)
  });

  it('counts unique accounts and clients per strategy', () => {
    const clients = [
      {
        id: 'c1', name: 'Alice', accountRegistry: {},
        dailyImports: [{ id: 'd1', date: '2026-06-25', accounts: {}, flags: [],
          snapshots: [{ accountName: 'A1', grossRealizedPnl: 100, weeklyPnl: 0,
            strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] }] }],
      },
      {
        id: 'c2', name: 'Bob', accountRegistry: {},
        dailyImports: [{ id: 'd2', date: '2026-06-25', accounts: {}, flags: [],
          snapshots: [{ accountName: 'B1', grossRealizedPnl: 200, weeklyPnl: 0,
            strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 200 }] }] }],
      },
    ];
    const [row] = buildStrategyEffectiveness(clients);
    expect(row.accounts).toBe(2);
    expect(row.clients).toBe(2);
  });

  // ── what the leaderboard does when nothing measured the day ────────────────
  //
  // The roll-up used to fall through to the account's P&L divided evenly across
  // the enabled strategies. Its own comment called that a genuine fabrication,
  // and nothing pinned it either way: the branch was only reachable for a row
  // whose `realized` is null, and until supabaseStore stopped collapsing NULL to
  // 0 on the way back, no reloaded row could be.

  const noEvidenceClient = (overrides = {}) => ({
    id: 'c1', name: 'Pedro', accountRegistry: {},
    dailyImports: [{
      id: 'd1', date: '2026-06-25', accounts: {}, flags: [],
      snapshots: [{
        accountName: 'ACC1', grossRealizedPnl: -776, weeklyPnl: 0,
        strategies: [
          { strategyFamily: 'RBO', enabled: true, realized: null, ...overrides },
          { strategyFamily: 'IFSP', enabled: true, realized: null, ...overrides },
        ],
      }],
    }],
  });

  it('never splits an account day evenly across the algos that were running', () => {
    // Two enabled strategies, an account down $776, and an export that said
    // nothing about either of them. The even split would put -$388 on each — a
    // figure nobody measured, on the leaderboard the desk ranks algos by.
    const rows = buildStrategyEffectiveness([noEvidenceClient()]);
    expect(rows.map((r) => r.totalPnl)).toEqual([0, 0]);
    expect(rows.every((r) => r.lossDays === 0 && r.winDays === 0)).toBe(true);
    expect(rows.every((r) => r.days === 0)).toBe(true);
  });

  it('says how many days it could not measure instead of leaving the total to speak for them', () => {
    const rows = buildStrategyEffectiveness([noEvidenceClient()]);
    expect(rows.every((r) => r.noEvidenceDays === 1)).toBe(true);
    // The roster is still exact: both algos ran on this account, and that part
    // was never in doubt.
    expect(rows.every((r) => r.accounts === 1 && r.clients === 1)).toBe(true);
  });

  it('treats an absent Realized column exactly like a grid that reported zero', () => {
    // The same statement — "this export does not say" — reaching the roll-up two
    // ways. Before, the first contributed 0 and the second contributed a third
    // of the account's day, and which one a row got depended on whether
    // NinjaTrader emitted the column.
    const absent = buildStrategyEffectiveness([noEvidenceClient()]);
    const zero = buildStrategyEffectiveness([noEvidenceClient({ realized: 0 })]);
    expect(absent.map((r) => r.totalPnl)).toEqual(zero.map((r) => r.totalPnl));
    expect(absent.map((r) => r.winRate)).toEqual(zero.map((r) => r.winRate));
  });

  it('still prefers a derived figure over everything, and a reported one over nothing', () => {
    const rows = buildStrategyEffectiveness([{
      id: 'c1', name: 'Pedro', accountRegistry: {},
      dailyImports: [{
        id: 'd1', date: '2026-06-25', accounts: {}, flags: [],
        snapshots: [{
          accountName: 'ACC1', grossRealizedPnl: 110, weeklyPnl: 0,
          strategies: [
            { strategyFamily: 'RBO', enabled: true, realized: 5, derivedRealized: 80 },
            { strategyFamily: 'IFSP', enabled: true, realized: 30 },
          ],
        }],
      }],
    }]);
    expect(rows.find((r) => r.name === 'RBO').totalPnl).toBe(80);
    expect(rows.find((r) => r.name === 'IFSP').totalPnl).toBe(30);
    expect(rows.every((r) => r.noEvidenceDays === 0)).toBe(true);
  });

  it('sorts by totalPnl descending', () => {
    const clients = [
      makeStratClient('RBO', [{ date: '2026-06-25', pnl: 100 }]),
      makeStratClient('IFSP', [{ date: '2026-06-25', pnl: 500 }]),
    ];
    // Override second client to use IFSP
    clients[1].dailyImports[0].snapshots[0].strategies[0].strategyFamily = 'IFSP';
    const results = buildStrategyEffectiveness(clients);
    expect(results[0].totalPnl).toBeGreaterThanOrEqual(results[1].totalPnl);
  });
});
