import { describe, expect, it } from 'vitest';
import { buildAllFundedAccounts } from './App';

// buildStrategyEffectiveness used to be tested below this file's funded-account
// suite. The function is deleted; its evidence rules — never split an account's
// day across the algorithms that were running, treat an absent Realized column
// exactly like a grid that reported zero, prefer a derived figure over a
// reported one — moved to src/domain/algorithmRanking.test.js, which is ungated so
// CI pins them.

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
