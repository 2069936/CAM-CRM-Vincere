import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, makeAccountAlias, recalculateDailyImport, reconcileDailyImport } from './reconcile';
import { buildAlgoAccountHistory } from './algoContribution';

describe('reconcileDailyImport', () => {
  it('preserves explicit null snapshot values but defaults missing legacy fields to zero', () => {
    const nullResult = reconcileDailyImport({
      clientId: 'nulls', date: '2026-07-23', registry: {}, parsed: {
        accounts: [{ accountName: 'ACC1', grossRealizedPnl: null, trailingMaxDrawdown: null, accountBalance: null, weeklyPnl: null, unrealizedPnl: null }],
        strategies: [], orders: [], executions: [],
      },
    });
    expect(nullResult.snapshots[0]).toMatchObject({
      grossRealizedPnl: null, trailingMaxDrawdown: null, accountBalance: null, weeklyPnl: null, unrealizedPnl: null,
    });

    const legacyResult = reconcileDailyImport({
      clientId: 'legacy', date: '2026-07-23', registry: {}, parsed: {
        accounts: [{ accountName: 'ACC2', grossRealizedPnl: 0, accountBalance: -1 }],
        strategies: [], orders: [], executions: [],
      },
    });
    expect(legacyResult.snapshots[0]).toMatchObject({
      grossRealizedPnl: 0, trailingMaxDrawdown: 0, accountBalance: -1, weeklyPnl: 0, unrealizedPnl: 0,
    });
  });

  it('preserves existing manual classification and flags only new accounts', () => {
    const registry = {
      ACC1: {
        accountName: 'ACC1',
        accountType: 'Funded',
        status: 'Active',
        payoutState: 'Not requested',
      },
    };
    const parsed = {
      accounts: [
        { accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 10, accountBalance: 50100, weeklyPnl: 20 },
        { accountName: 'ACC2', connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0 },
      ],
      strategies: [
        { accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true, instrument: 'M2K JUN26' },
      ],
      orders: [],
      executions: [],
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    expect(result.accounts.ACC1.accountType).toBe('Funded');
    expect(result.accounts.ACC2.accountType).toBe('Unassigned');
    expect(result.flags.map((flag) => flag.type)).toContain('New account');
  });

  it('raises critical flag when payout hold account has an enabled strategy', () => {
    const registry = {
      ACC1: {
        accountName: 'ACC1',
        accountType: 'Funded',
        status: 'Payout Hold',
        payoutState: 'Payout requested',
      },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 10, accountBalance: 50100, weeklyPnl: 20 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true, instrument: 'M2K JUN26' }],
      orders: [],
      executions: [],
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    expect(result.flags).toContainEqual(expect.objectContaining({
      type: 'Payout hold violation',
      severity: 'Critical',
      accountName: 'ACC1',
    }));
  });

  it('flags historical active accounts that are missing from the daily import', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' },
    };
    const parsed = { accounts: [], strategies: [], orders: [], executions: [] };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    expect(result.flags).toContainEqual(expect.objectContaining({
      type: 'Missing account',
      severity: 'Warning',
      accountName: 'ACC1',
    }));
  });

  // REPLACES 'ignores simulator accounts that start with SIM'.
  //
  // That test asserted the old behaviour: any account whose name began with
  // "sim" was deleted, rows and all. It passed while the CRM told Craig Weschke
  // his 2026-08-06 was $0 on 2 idle accounts, when in fact his Sim101 had run 40
  // orders and 15 executions for a realized -$1,297.9999999 and was the only
  // account of his that traded. The rule now is separation, not deletion.
  it('separates simulated rows from live rows instead of deleting them', () => {
    const parsed = {
      accounts: [
        { accountName: 'Sim101', connection: 'Legends', grossRealizedPnl: -1298, accountBalance: 99590, weeklyPnl: -1298 },
        { accountName: 'SIM-Amanda-Test', connection: 'Simulated', grossRealizedPnl: 999, accountBalance: 100000, weeklyPnl: 999 },
        { accountName: 'LIVE1234', connection: 'Live', grossRealizedPnl: 10, accountBalance: 50100, weeklyPnl: 20 },
      ],
      strategies: [
        { accountName: 'Sim101', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true },
        { accountName: 'LIVE1234', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true },
      ],
      orders: [],
      executions: [],
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry: {}, parsed });

    // Every account is on the record — none was thrown away.
    expect(Object.keys(result.accounts).sort()).toEqual(['LIVE1234', 'SIM-Amanda-Test', 'Sim101']);

    // The live arrays hold live money ONLY, which is what every downstream
    // total assumes it is reading.
    expect(result.snapshots.map((snapshot) => snapshot.accountName)).toEqual(['LIVE1234']);
    expect(result.strategies.map((strategy) => strategy.accountName)).toEqual(['LIVE1234']);

    // Sim101 matches NinjaTrader's Sim<number> naming: simulated, and its
    // $99,590 is in the simulated total, not the desk's.
    expect(result.simulation.snapshots.map((snapshot) => snapshot.accountName)).toEqual(['Sim101']);
    expect(result.simulation.totals).toMatchObject({ accounts: 1, balance: 99590, dailyPnl: -1298 });
    expect(result.simulation.strategies.map((strategy) => strategy.accountName)).toEqual(['Sim101']);
    expect(result.accounts.Sim101.accountType).toBe(ACCOUNT_TYPES.SIMULATION);

    // SIM-Amanda-Test does NOT match that naming. It is reported as
    // undetermined and counted as neither — never guessed into a bucket.
    expect(result.simulation.undetermined.snapshots.map((s) => s.accountName)).toEqual(['SIM-Amanda-Test']);
    expect(result.simulation.undetermined.totals.balance).toBe(100000);
    expect(result.accounts['SIM-Amanda-Test'].accountType).toBe(ACCOUNT_TYPES.UNASSIGNED);

    // Both automatic decisions are visible to the CAM, with their reason.
    const simFlag = result.flags.find((flag) => flag.type === 'New simulation account');
    expect(simFlag.accountName).toBe('Sim101');
    expect(simFlag.message).toContain("named Sim101");
    expect(result.flags).toContainEqual(expect.objectContaining({
      type: 'Account nature undetermined',
      accountName: 'SIM-Amanda-Test',
    }));

    // Denominators, always.
    expect(result.simulation.denominator.accountsInClose).toBe(3);
  });

  it('does not flag a registered simulation account as missing when it stays idle', () => {
    // The old filter dropped sim accounts before `seen.add()`, so the registry
    // sweep fired on a registered Sim101 EVERY close and dragged the whole
    // import to Needs review forever. There was no way to register a simulation
    // account without permanently poisoning the client's flag queue.
    const registry = {
      Sim101: { accountName: 'Sim101', alias: 'Sim', accountType: ACCOUNT_TYPES.SIMULATION, status: 'Active' },
      ACC1: { accountName: 'ACC1', alias: 'Legends - CC1', accountType: 'Funded', status: 'Active' },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Legends', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0, trailingMaxDrawdown: 2000 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO-1.8', enabled: true }],
      orders: [],
      executions: [],
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    expect(result.flags.filter((flag) => flag.type === 'Missing account')).toEqual([]);
    // And an account already declared Simulation raises no heuristic flag: the
    // classification came from the record, not from a guess.
    expect(result.flags.filter((flag) => flag.type === 'New simulation account')).toEqual([]);
  });

  it('raises no drawdown, payout or unassigned flag against simulated money', () => {
    const parsed = {
      accounts: [
        // Balance over the 100k evaluation target, and a trailing buffer that
        // would read as "breached" on a real prop account.
        { accountName: 'Sim101', connection: 'Live', grossRealizedPnl: 0, accountBalance: 107500, weeklyPnl: 0, trailingMaxDrawdown: -5000 },
      ],
      strategies: [],
      orders: [],
      executions: [],
    };
    const registry = {
      Sim101: {
        accountName: 'Sim101', alias: 'Sim', accountType: ACCOUNT_TYPES.SIMULATION,
        status: 'Active', maxDrawdownLimit: 2500, targetProfit: 107300, payoutState: 'Not requested',
      },
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    const types = result.flags.map((flag) => flag.type);
    expect(types).not.toContain('Drawdown breached');
    expect(types).not.toContain('Drawdown near limit');
    expect(types).not.toContain('Payout eligible');
    expect(types).not.toContain('Evaluation target reached');
    expect(types).not.toContain('Unassigned account');
    expect(types).not.toContain('Expected strategy missing');
  });

  it('lets an explicit registry setting override the name heuristic in both directions', () => {
    const parsed = {
      accounts: [
        // Named like a simulator, declared live money by the CAM.
        { accountName: 'Sim101', connection: 'Legends', grossRealizedPnl: 25, accountBalance: 50000, weeklyPnl: 25 },
        // Named like nothing in particular, declared a simulation by the CAM.
        { accountName: 'LTATALEST500004585512', connection: 'Legends', grossRealizedPnl: 99, accountBalance: 100000, weeklyPnl: 99 },
      ],
      strategies: [],
      orders: [],
      executions: [],
    };
    const registry = {
      Sim101: { accountName: 'Sim101', alias: 'Real - 101', accountType: 'Funded', simulationMode: 'live', status: 'Active' },
      LTATALEST500004585512: { accountName: 'LTATALEST500004585512', alias: 'Legends - 5512', accountType: 'Funded', simulationMode: 'simulation', status: 'Active' },
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry, parsed });

    expect(result.snapshots.map((snapshot) => snapshot.accountName)).toEqual(['Sim101']);
    expect(result.simulation.snapshots.map((snapshot) => snapshot.accountName)).toEqual(['LTATALEST500004585512']);
    expect(result.simulation.totals.balance).toBe(100000);
  });

  it('attributes executions to strategies through matching order ids', () => {
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
      orders: [
        { accountName: 'ACC1', id: 'ORDER-1', strategyName: '0 - RBO-1.8' },
      ],
      executions: [
        { accountName: 'ACC1', orderId: 'ORDER-1', action: 'Buy', quantity: 2, price: 19000 },
        { accountName: 'ACC1', orderId: 'MANUAL-1', action: 'Sell', quantity: 2, price: 19010 },
      ],
    };

    const result = reconcileDailyImport({ clientId: 'client-1', date: '2026-06-08', registry: {}, parsed });

    expect(result.executions).toEqual([
      expect.objectContaining({ orderId: 'ORDER-1', strategyName: '0 - RBO-1.8' }),
      expect.objectContaining({ orderId: 'MANUAL-1', strategyName: '' }),
    ]);
  });

  it('recalculates flags after account registry classification changes', () => {
    const initial = reconcileDailyImport({
      clientId: 'client-1',
      date: '2026-06-08',
      registry: {},
      parsed: {
        accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000 }],
        strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
        orders: [],
        executions: [],
      },
    });

    const recalculated = recalculateDailyImport({
      dailyImport: initial,
      registry: {
        ACC1: {
          ...initial.accounts.ACC1,
          accountType: 'Funded',
          status: 'Active',
        },
      },
    });

    expect(initial.flags.map((flag) => flag.type)).toContain('Unassigned account');
    expect(recalculated.flags.map((flag) => flag.type)).not.toContain('Unassigned account');
    expect(recalculated.status).toBe('Ready to close');
  });

  it('does not raise Missing account when CSV casing differs from registry key casing', () => {
    // Registry has uppercase key; CSV exports lowercase - must not produce a false "Missing account" flag
    const registry = {
      APEX1234: { accountName: 'APEX1234', accountType: 'Funded', status: 'Active', alias: 'My Account' },
    };
    const parsed = {
      accounts: [{ accountName: 'apex1234', connection: 'Live', grossRealizedPnl: 150, accountBalance: 55000, weeklyPnl: 300 }],
      strategies: [{ accountName: 'apex1234', strategyName: '1 - RBO-1.8', strategyFamily: 'RBO', enabled: true, realized: 150 }],
      orders: [],
      executions: [],
    };

    const result = reconcileDailyImport({ clientId: 'client-ci', date: '2026-06-25', registry, parsed });

    const missingFlags = result.flags.filter((f) => f.type === 'Missing account');
    expect(missingFlags).toHaveLength(0);
  });

  it('handles undefined registry without throwing (new client with no accounts yet)', () => {
    const parsed = {
      accounts: [{ accountName: 'BRAND1', connection: 'Live', grossRealizedPnl: 50, accountBalance: 50100, weeklyPnl: 100 }],
      strategies: [],
      orders: [],
      executions: [],
    };
    expect(() => reconcileDailyImport({ clientId: 'new-client', date: '2026-06-25', registry: undefined, parsed })).not.toThrow();
    const result = reconcileDailyImport({ clientId: 'new-client', date: '2026-06-25', registry: undefined, parsed });
    expect(result.snapshots).toHaveLength(1);
  });

  it('raises Critical Drawdown breached flag when model-1 limit is exceeded', () => {
    const registry = {
      APEX1234: { accountName: 'APEX1234', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000 },
    };
    const parsed = {
      accounts: [{ accountName: 'APEX1234', connection: 'Lucid', grossRealizedPnl: -2500, accountBalance: 47500, trailingMaxDrawdown: -2500, weeklyPnl: -2500 }],
      strategies: [{ accountName: 'APEX1234', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c1', date: '2026-06-25', registry, parsed });
    const breachFlags = result.flags.filter(f => f.type === 'Drawdown breached');
    expect(breachFlags).toHaveLength(1);
    expect(breachFlags[0].severity).toBe('Critical');
  });

  it('raises payout eligible flag when funded balance reaches target and payout not requested', () => {
    const registry = {
      MFF123: { accountName: 'MFF123', accountType: 'Funded', status: 'Active', targetProfit: 53000, payoutState: 'Not requested' },
    };
    const parsed = {
      accounts: [{ accountName: 'MFF123', connection: 'Lucid', grossRealizedPnl: 3200, accountBalance: 53200, trailingMaxDrawdown: 500, weeklyPnl: 3200 }],
      strategies: [{ accountName: 'MFF123', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c2', date: '2026-06-25', registry, parsed });
    const payoutFlags = result.flags.filter(f => f.type === 'Payout eligible');
    expect(payoutFlags).toHaveLength(1);
  });

  it('does not raise payout eligible flag when payout is already requested', () => {
    const registry = {
      MFF123: { accountName: 'MFF123', accountType: 'Funded', status: 'Active', targetProfit: 53000, payoutState: 'Payout requested' },
    };
    const parsed = {
      accounts: [{ accountName: 'MFF123', connection: 'Lucid', grossRealizedPnl: 3200, accountBalance: 53200, trailingMaxDrawdown: 500, weeklyPnl: 3200 }],
      strategies: [{ accountName: 'MFF123', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c3', date: '2026-06-25', registry, parsed });
    expect(result.flags.filter(f => f.type === 'Payout eligible')).toHaveLength(0);
  });

  it('raises Evaluation target reached flag when a bullet-bot eval balance reaches target', () => {
    const registry = {
      EVAL1: { accountName: 'EVAL1', accountType: 'Evaluation - Bullet Bot', status: 'Active', targetProfit: 3000 },
    };
    const parsed = {
      accounts: [{ accountName: 'EVAL1', connection: 'Lucid', grossRealizedPnl: 3100, accountBalance: 3100, trailingMaxDrawdown: 500, weeklyPnl: 3100 }],
      strategies: [{ accountName: 'EVAL1', strategyName: '0 - BulletBot-1.0', strategyFamily: 'BulletBot', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c-eval', date: '2026-06-25', registry, parsed });
    expect(result.flags.filter(f => f.type === 'Evaluation target reached')).toHaveLength(1);
  });

  it('does not raise Evaluation target reached for a cash account (no target)', () => {
    const registry = {
      CASH1: { accountName: 'CASH1', accountType: 'Cash', status: 'Active', targetProfit: 3000 },
    };
    const parsed = {
      accounts: [{ accountName: 'CASH1', connection: 'Lucid', grossRealizedPnl: 3100, accountBalance: 3100, trailingMaxDrawdown: 500, weeklyPnl: 3100 }],
      strategies: [{ accountName: 'CASH1', strategyName: '0 - BulletBot-1.0', strategyFamily: 'BulletBot', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c-cash', date: '2026-06-25', registry, parsed });
    expect(result.flags.filter(f => f.type === 'Evaluation target reached')).toHaveLength(0);
  });

  it('raises Critical Expected strategy missing for active funded account with no enabled strategy', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: false }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c4', date: '2026-06-25', registry, parsed });
    const missing = result.flags.filter(f => f.type === 'Expected strategy missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('Critical');
  });

  it('raises Strategy disabled warning for each disabled strategy', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: 100, accountBalance: 50100, weeklyPnl: 100 }],
      strategies: [
        { accountName: 'ACC1', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: true },
        { accountName: 'ACC1', strategyName: '1 - IFSP-2.0', strategyFamily: 'IFSP', enabled: false },
      ],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c5', date: '2026-06-25', registry, parsed });
    expect(result.flags.filter(f => f.type === 'Strategy disabled')).toHaveLength(1);
  });

  it('raises Critical Unexpected strategy active for Inactive account with enabled strategy', () => {
    const registry = {
      OLD1: { accountName: 'OLD1', accountType: 'Funded', status: 'Inactive' },
    };
    const parsed = {
      accounts: [{ accountName: 'OLD1', connection: 'Live', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0 }],
      strategies: [{ accountName: 'OLD1', strategyName: '0 - RBO-1.8', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c6', date: '2026-06-25', registry, parsed });
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Unexpected strategy active', severity: 'Critical' }));
  });

  it('does not raise Missing account for Inactive accounts absent from the close', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Inactive' },
    };
    const parsed = { accounts: [], strategies: [], orders: [], executions: [] };
    const result = reconcileDailyImport({ clientId: 'c7', date: '2026-06-25', registry, parsed });
    expect(result.flags.filter(f => f.type === 'Missing account')).toHaveLength(0);
  });

  it('raises Critical Drawdown near limit when model-1 buffer is ≤ $500', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000 },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: -1600, accountBalance: 48400, trailingMaxDrawdown: -1600, weeklyPnl: -1600 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c8', date: '2026-06-25', registry, parsed });
    // buffer = 2000 - 1600 = 400 → ≤500 → Critical near limit
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Drawdown near limit', severity: 'Critical' }));
  });

  it('raises Warning Drawdown approaching limit when model-1 buffer is ≤ $1200', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000 },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: -1100, accountBalance: 48900, trailingMaxDrawdown: -1100, weeklyPnl: -1100 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c9', date: '2026-06-25', registry, parsed });
    // buffer = 2000 - 1100 = 900 → 500 < 900 ≤ 1200 → Warning approaching
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Drawdown approaching limit', severity: 'Warning' }));
  });

  it('raises Critical Drawdown breached for model-2 when rawDD ≤ 0', () => {
    // Model-2: no maxDrawdownLimit configured, rawDD IS the remaining buffer
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' }, // no maxDrawdownLimit
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: -5000, accountBalance: 45000, trailingMaxDrawdown: -50, weeklyPnl: -5000 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c10', date: '2026-06-25', registry, parsed });
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Drawdown breached', severity: 'Critical' }));
  });

  it('raises Critical Drawdown near limit for model-2 when rawDD is 1–500', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' },
    };
    const parsed = {
      accounts: [{ accountName: 'ACC1', connection: 'Lucid', grossRealizedPnl: -4700, accountBalance: 45300, trailingMaxDrawdown: 300, weeklyPnl: -4700 }],
      strategies: [{ accountName: 'ACC1', strategyName: '0 - RBO', enabled: true }],
      orders: [], executions: [],
    };
    const result = reconcileDailyImport({ clientId: 'c11', date: '2026-06-25', registry, parsed });
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Drawdown near limit', severity: 'Critical' }));
  });
});

// ── makeAccountAlias ──────────────────────────────────────────────────────────

describe('makeAccountAlias', () => {
  it('uses last 4 chars of accountName with connection label', () => {
    expect(makeAccountAlias('APEX-12345678', 'Lucid')).toBe('Lucid - 5678');
  });

  it('falls back to Account label when connection is empty', () => {
    expect(makeAccountAlias('APEX-12345678', '')).toBe('Account - 5678');
  });

  it('returns connection label alone when accountName is too short to have a suffix', () => {
    expect(makeAccountAlias('AB', 'Lucid')).toBe('Lucid - AB');
  });

  it('handles null/undefined gracefully', () => {
    const alias = makeAccountAlias(null, null);
    expect(typeof alias).toBe('string');
  });
});

// ── recalculateDailyImport ────────────────────────────────────────────────────

describe('recalculateDailyImport', () => {
  it('rebuilds flags from existing snapshot data using the current registry', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000, targetProfit: 52000, payoutState: 'Not requested' },
    };
    const dailyImport = {
      id: 'di-1', clientId: 'c1', date: '2026-06-25', status: 'Closed',
      snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 200, accountBalance: 51200, trailingMaxDrawdown: -1900, weeklyPnl: 800 }],
      strategies: [{ accountName: 'ACC1', strategyName: '1-RBO', enabled: true }],
      orders: [], executions: [], accounts: {},
      flags: [], // start with no flags - recalculate should generate them
    };
    const result = recalculateDailyImport({ dailyImport, registry });
    // drawdown used = 1900 / 2000 = 95% → Critical
    expect(result.flags).toContainEqual(expect.objectContaining({ type: 'Drawdown near limit', severity: 'Critical' }));
  });

  it('preserves non-flag fields from the original import', () => {
    const dailyImport = {
      id: 'di-custom', clientId: 'c1', date: '2026-06-25', status: 'Closed',
      snapshots: [], strategies: [], orders: [], executions: [], accounts: {}, flags: [],
      customField: 'keep-me',
    };
    const result = recalculateDailyImport({ dailyImport, registry: {} });
    expect(result.customField).toBe('keep-me');
    expect(result.id).toBe('di-custom');
  });

  it('preserves resolved/acknowledged flag status across a recalculate (no triage reset)', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000, targetProfit: 52000 },
    };
    const dailyImport = {
      id: 'di-1', clientId: 'c1', date: '2026-06-25', status: 'Closed',
      snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 200, accountBalance: 51200, trailingMaxDrawdown: -1900, weeklyPnl: 800 }],
      strategies: [], orders: [], executions: [], accounts: {}, flags: [],
    };
    const first = recalculateDailyImport({ dailyImport, registry });
    expect(first.flags.length).toBeGreaterThan(0);
    // operator resolves the generated flags, then recalculates again
    const resolved = { ...dailyImport, flags: first.flags.map((f) => ({ ...f, status: 'Resolved', resolvedAt: '2026-06-25T10:00:00Z' })) };
    const second = recalculateDailyImport({ dailyImport: resolved, registry });
    expect(second.flags.every((f) => f.status === 'Resolved')).toBe(true);
  });

  it('does not erase uploaded data: keeps snapshots + their nested strategies even when top-level detail is empty', () => {
    const registry = {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 2000, targetProfit: 52000 },
    };
    // Post-upload shape: strategies are nested on the snapshot, top-level arrays empty.
    const dailyImport = {
      id: 'di-1', clientId: 'c1', date: '2026-06-25', status: 'Closed',
      snapshots: [{
        accountName: 'ACC1', grossRealizedPnl: 200, accountBalance: 51200, trailingMaxDrawdown: -500, weeklyPnl: 800,
        strategies: [{ strategyName: '1-RBO', enabled: true }],
      }],
      strategies: [], orders: [], executions: [], accounts: {}, flags: [],
    };
    const result = recalculateDailyImport({ dailyImport, registry });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].strategies).toHaveLength(1);
    expect(result.snapshots[0].accountBalance).toBe(51200);
  });
});

describe('trailing drawdown does not apply to cash accounts', () => {
  const history = [
    { date: '2026-07-24', snapshots: [{ accountName: 'CASH1', accountBalance: 52000, grossRealizedPnl: 0 }] },
  ];
  const parsed = (accountName) => ({
    accounts: [{ accountName, accountBalance: 49000, grossRealizedPnl: -100, trailingMaxDrawdown: null, weeklyPnl: null }],
    strategies: [], orders: [], executions: [],
  });

  it('leaves trailing alone for a cash account, since it has no trailing rule', () => {
    const result = reconcileDailyImport({
      clientId: 'c', date: '2026-07-27', history,
      registry: { CASH1: { accountName: 'CASH1', accountType: 'Cash - IRA', status: 'Active' } },
      parsed: parsed('CASH1'),
    });
    expect(result.snapshots[0].trailingSource).toBeNull();
    // Null, not 0: "does not apply" rather than "measured, and it is zero".
    // A prop account with the same history would measure 3000 down from its peak.
    expect(result.snapshots[0].trailingMaxDrawdown).toBeNull();
  });

  it('still derives trailing for a prop account', () => {
    const result = reconcileDailyImport({
      clientId: 'c', date: '2026-07-27', history,
      registry: { CASH1: { accountName: 'CASH1', accountType: 'Funded', status: 'Active' } },
      parsed: parsed('CASH1'),
    });
    expect(result.snapshots[0].trailingSource).toBe('derived');
    expect(result.snapshots[0].trailingMaxDrawdown).toBe(3000);
  });

  it('raises no drawdown flag on a cash account carrying a stale limit', () => {
    const result = reconcileDailyImport({
      clientId: 'c', date: '2026-07-27', history,
      registry: { CASH1: { accountName: 'CASH1', accountType: 'Cash - IRA', status: 'Active', maxDrawdownLimit: 2000 } },
      parsed: parsed('CASH1'),
    });
    expect(result.flags.filter((f) => f.type.startsWith('Drawdown'))).toEqual([]);
  });

  it('still counts weekly PnL for cash, which is a real figure for it', () => {
    const result = reconcileDailyImport({
      clientId: 'c', date: '2026-07-27', history,
      registry: { CASH1: { accountName: 'CASH1', accountType: 'Cash - IRA', status: 'Active' } },
      parsed: parsed('CASH1'),
    });
    expect(result.snapshots[0].weeklyPnlSource).toBe('derived');
    expect(result.snapshots[0].weeklyPnl).toBe(-100);
  });
});

describe('flag ids are uuids', () => {
  // Regression: flags were keyed `${type}-${accountName}-${random}`, which React
  // accepted and Postgres did not. Resolving a freshly imported flag failed with
  // "invalid input syntax for type uuid", the optimistic update hid it anyway,
  // and it returned on the next load.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('gives every flag an id operational_flags.id will accept', () => {
    const result = reconcileDailyImport({
      clientId: 'client-1',
      date: '2026-07-27',
      registry: {
        'FTDFYL100195681612': {
          alias: 'Apex 1', accountType: 'Funded',
          status: 'Active', startBalance: 50000,
        },
      },
      parsed: {
        accounts: [{ accountName: 'FTDFYL100195681612', accountBalance: 50000 }],
        strategies: [{ accountName: 'FTDFYL100195681612', strategyName: 'RBO-1.8', enabled: false }],
        orders: [],
        executions: [],
      },
    });

    expect(result.flags.length).toBeGreaterThan(0);
    // The exact shape that used to break: a disabled strategy on a real account.
    expect(result.flags.map((flag) => flag.type)).toContain('Strategy disabled');
    for (const flag of result.flags) {
      expect(flag.id).toMatch(UUID);
    }
  });

  it('does not repeat an id across flags', () => {
    const result = reconcileDailyImport({
      clientId: 'client-1',
      date: '2026-07-27',
      registry: {},
      parsed: {
        accounts: [
          { accountName: 'ACC-A', accountBalance: 1000 },
          { accountName: 'ACC-B', accountBalance: 2000 },
        ],
        strategies: [], orders: [], executions: [],
      },
    });

    const ids = result.flags.map((flag) => flag.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('derived per-strategy PnL is carried beside the reported one, never over it', () => {
  // The Strategies grid reports `realized` on a minority of rows, so most
  // accounts move without the export saying which algo moved them. reconcile
  // fills that in from the fills themselves — and the two figures must stay
  // separable forever, because one is what NinjaTrader said and the other is
  // what we worked out, and a reader who cannot tell them apart cannot judge
  // either.
  const day = (overrides = {}) => reconcileDailyImport({
    clientId: 'c1',
    date: '2026-08-18',
    registry: {},
    parsed: {
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50000 }],
      strategies: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true }],
      orders: [
        { id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
        { id: 'O2', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
      ],
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' },
        { id: '2_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:35:01 AM' },
      ],
      ...overrides,
    },
  });

  it('derives a figure for a strategy the export reported nothing for', () => {
    const snapshot = day().snapshots[0];
    const strategy = snapshot.strategies[0];
    expect(strategy.realized).toBeNull();          // what NinjaTrader said: nothing
    expect(strategy.derivedRealized).toBe(20);     // what the fills say
    // The verdict that licensed that figure belongs to the whole account-day and
    // is stored once, on the snapshot — not repeated on every roster row.
    expect(snapshot.derivation.status).toBe('exact');
    expect(strategy.derivedRealizedStatus).toBeUndefined();
  });

  it('never overwrites a figure the export did report', () => {
    const result = day({
      strategies: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: 20, enabled: true }],
    });
    const strategy = result.snapshots[0].strategies[0];
    expect(strategy.realized).toBe(20);
    expect(strategy.derivedRealized).toBe(20);
  });

  it('publishes no derived figure when the day does not reconcile', () => {
    // The account's own gross says 999; the fills say 20. Something is missing
    // from this export, so a per-strategy split would be a fiction whichever
    // number it was built on.
    const result = day({
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 999, grossRealizedPnlReported: 999, accountBalance: 50000 }],
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies[0].derivedRealized).toBeNull();
    expect(snapshot.strategies[0].derivedRealizedStatus).toBeUndefined();
    expect(snapshot.derivation.status).toBe('unreconciled');
    // The arithmetic behind that verdict — derivedTotal 20, difference -979 —
    // is computed and is what decided `status`, but it is deliberately not
    // stored: it is re-derivable from the executions and orders this same close
    // already persists. See storableDerivation.
    expect(snapshot.derivation.derivedTotal).toBeUndefined();
    expect(snapshot.derivation.difference).toBeUndefined();
  });

  it('publishes no derived figure when a pair could not be attributed, and says why', () => {
    // A hand-placed exit: blank Strategy AND blank Name. Rule 4b does not reach
    // it — that separation is the whole reason 4b is allowed to exist — so the
    // pair stays in the residual and the account publishes nothing per-algo.
    const result = day({
      orders: [
        { id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
        { id: 'O2', accountName: 'ACC1', strategyName: '', name: '' },
      ],
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies[0].derivedRealized).toBeNull();
    expect(snapshot.derivation.status).toBe('partial');
    expect(snapshot.derivation.residual).toMatchObject({ realized: 20, pairs: 1, reasons: { 'manual-leg': 1 } });
  });

  it('credits a detached exit — the same fixture, with the Name NinjaTrader writes', () => {
    // One character of difference from the test above: order O2 carries a Name.
    // That is NinjaTrader's own order for the strategy, detached from it, and
    // 2026-08-19 showed the grid crediting exactly these to the strategy — four
    // reported values the strict rule missed by $311.50, $315.00, $400.00 and
    // $201.00. See rule 4b in deriveStrategyPnl.js.
    const result = day({
      orders: [
        { id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
        { id: 'O2', accountName: 'ACC1', strategyName: '', name: 'Close' },
      ],
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies[0].derivedRealized).toBe(20);
    expect(snapshot.derivation.status).toBe('exact');
  });

  it('refuses an account whose grid exported no gross column, rather than checking nothing', () => {
    const result = day({
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 15.64, grossRealizedPnlReported: null, accountBalance: 50000 }],
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.derivation.status).toBe('no-reported-gross');
    expect(snapshot.strategies[0].derivedRealized).toBeNull();
  });

  it('refuses an account holding a book it cannot price, and shows nothing per-algo', () => {
    // The first fill sells from a position that no fill in this close opened.
    // Nothing here can price it, and reconcileDailyImport was given no prior
    // closes to price it from.
    const result = day({
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '1 L', orderId: 'O1', time: '8/18/2026 9:35:01 AM' },
      ],
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.derivation.status).toBe('refused');
    expect(snapshot.derivation.residual.reasons).toMatchObject({ 'carry-in-refused': 1 });
    expect(snapshot.strategies[0].derivedRealized).toBeNull();
  });

  it('prices that same book once the previous close is handed over', () => {
    // The difference between the CRM and the one-day verifier, end to end. The
    // stored close opened 2 long at 100; today sells 1 of them at 110.
    const priorImports = [{
      date: '2026-08-17',
      snapshots: [],
      strategies: [],
      orders: [{ id: 'P1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }],
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 2, price: 100, position: '2 L', orderId: 'P1', time: '8/17/2026 9:30:01 AM' },
      ],
    }];
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-08-18',
      registry: {},
      priorImports,
      parsed: {
        accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50000 }],
        strategies: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true }],
        orders: [{ id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }],
        executions: [
          { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '1 L', orderId: 'O1', time: '8/18/2026 9:35:01 AM' },
        ],
      },
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.derivation.status).toBe('exact');
    expect(snapshot.strategies[0].derivedRealized).toBe(20);
  });

  it('finds a simulated account\'s carry-in in the stored close\'s simulation bucket', () => {
    // A stored close keeps simulated rows in a separate `simulation` bucket, so
    // a replay reading only `executions` would see a Sim101 that traded nothing
    // and report a phantom gap — on exactly the accounts nobody would think to
    // check. The rows are merged back before the replay for that reason.
    const prior = {
      date: '2026-08-17',
      snapshots: [], strategies: [], orders: [], executions: [],
      simulation: {
        snapshots: [], strategies: [],
        orders: [{ id: 'P1', accountName: 'Sim101', strategyName: 'Alpha-1.0', name: '' }],
        executions: [
          { id: '1_1', accountName: 'Sim101', instrument: 'MNQ SEP26', action: 'Buy', quantity: 2, price: 100, position: '2 L', orderId: 'P1', time: '8/17/2026 9:30:01 AM' },
        ],
      },
    };
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-08-18',
      registry: {},
      priorImports: [prior],
      parsed: {
        accounts: [{ accountName: 'Sim101', grossRealizedPnl: 40, grossRealizedPnlReported: 40, accountBalance: 50000 }],
        strategies: [{ accountName: 'Sim101', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true }],
        orders: [{ id: 'O1', accountName: 'Sim101', strategyName: 'Alpha-1.0', name: '' }],
        executions: [
          { id: '9_1', accountName: 'Sim101', instrument: 'MNQ SEP26', action: 'Sell', quantity: 2, price: 110, position: '-', orderId: 'O1', time: '8/18/2026 9:35:01 AM' },
        ],
      },
    });
    const snapshot = result.simulation.snapshots[0];
    expect(snapshot.derivation.status).toBe('exact');
    expect(snapshot.strategies[0].derivedRealized).toBe(40);
  });

  it('still refuses when the stored close cannot explain today\'s opening position', () => {
    // The gap. The prior close left 1 lot open; today's fills say 2 were held.
    // A day is missing, so the basis is stale and the book is refused.
    const priorImports = [{
      date: '2026-08-17',
      snapshots: [],
      strategies: [],
      orders: [{ id: 'P1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }],
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'P1', time: '8/17/2026 9:30:01 AM' },
      ],
    }];
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-08-18',
      registry: {},
      priorImports,
      parsed: {
        accounts: [{ accountName: 'ACC1', grossRealizedPnl: 40, grossRealizedPnlReported: 40, accountBalance: 50000 }],
        strategies: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true }],
        orders: [{ id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }],
        executions: [
          { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 2, price: 110, position: '-', orderId: 'O1', time: '8/18/2026 9:35:01 AM' },
        ],
      },
    });
    expect(result.snapshots[0].derivation.status).toBe('refused');
  });

  it('reconciles against gross, not against the commission-netted field', () => {
    // mapAccount stores the NET 'Realized PnL' in `grossRealizedPnl` whenever
    // the grid exported both. Gating on that would reject nearly every account.
    const result = day({
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 15.64, grossRealizedPnlReported: 20, accountBalance: 50000 }],
    });
    expect(result.snapshots[0].strategies[0].derivedRealized).toBe(20);
  });

  it('leaves an account that did not trade with no derivation at all', () => {
    // Null, not a 'no-trades' object. The two say exactly the same thing to
    // every reader — buildAlgoAccountHistory cannot produce a derived day from
    // either — and one of them costs 560 bytes in a jsonb column that two
    // `select '*'` paths carry, one of which is already over a 4 MiB ceiling
    // enforced as a 413. 19 of the 40 account-days on the 2026-08-18 export are
    // in this state.
    const result = day({ executions: [], orders: [] });
    expect(result.snapshots[0].derivation).toBeNull();
    expect(result.snapshots[0].strategies[0].derivedRealized).toBeNull();
    // And nothing on the strategy row says 'no-trades' either. That verdict was
    // being written onto every roster row of the account while the snapshot's
    // own copy of it was already being dropped for saying nothing — the same
    // 560-byte argument, one table over and once per strategy instead of once
    // per account.
    expect(result.snapshots[0].strategies[0].derivedRealizedStatus).toBeUndefined();
  });

  it('stores only what a reader cannot get from another column', () => {
    // The stored blob is a projection, not the derivation. Everything kept here
    // is unrecoverable from anywhere else in the schema: `reportedGross` is the
    // only surviving copy of the raw Gross column (mapAccountSnapshot does not
    // store grossRealizedPnlReported), `residual` is money no strategy could be
    // named for, and `join.offRoster` is money whose strategy is on no roster
    // row — so no strategy_snapshots row can carry it either.
    //
    // Widen this set and the export pays for it on every account-day of every
    // client. Narrow it and the panel loses a number it prints.
    const derivation = day().snapshots[0].derivation;
    expect(Object.keys(derivation).sort()).toEqual(['join', 'reportedGross', 'residual', 'status']);
    // `ambiguousNames` is NOT in this list, and that is the point of it being
    // conditional: the ordinary account-day has no duplicate-named roster row,
    // so it spends nothing at all. It appears only on the day that has one —
    // see 'refuses to put one derived figure on two same-named roster rows'.
    expect(Object.keys(derivation.join).sort())
      .toEqual(['offRoster', 'offRosterRealized', 'published', 'status']);
    expect(derivation.reportedGross).toBe(20);
    // `byStrategy` is the one that matters most: it is the per-strategy figures
    // a second time, and strategy_snapshots.derived_realized already holds them.
    expect(derivation.byStrategy).toBeUndefined();
    expect(JSON.stringify(derivation).length).toBeLessThan(260);
  });
});

// ---------------------------------------------------------------------------
// The join, end to end.
//
// These run the real reconcileDailyImport into the real buildAlgoAccountHistory
// — the production path, no hand-built snapshot in between — because both
// failures below were invisible at every layer taken on its own. The derivation
// was right, the panel was right, and the screen was wrong: the seam between
// them joined by strategy name in one direction and defaulted the miss to zero.
// ---------------------------------------------------------------------------
describe('the derived split joined onto the Strategies-grid roster', () => {
  // One MNQ round trip worth 10 points. MNQ is $2 a point, so this account's
  // gross is 20 and the fills name one strategy on both legs.
  const fills = (strategyName) => ({
    orders: [
      { id: 'O1', accountName: 'ACC1', strategyName, name: '' },
      { id: 'O2', accountName: 'ACC1', strategyName, name: '' },
    ],
    executions: [
      { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' },
      { id: '2_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:35:01 AM' },
    ],
  });

  const importOf = (strategies, strategyName = 'RBO-1.8') => reconcileDailyImport({
    clientId: 'c1',
    date: '2026-08-18',
    registry: {},
    parsed: {
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50000 }],
      strategies,
      ...fills(strategyName),
    },
  });

  it('gives a roster row the fills never named no derived figure at all', () => {
    // Reproduced: the account made 20, every cent of it derived to RBO-1.8,
    // which has no grid row. The one grid row it does have took a zero wearing
    // the "derived from fills" label, the panel announced "all 1 days carry a
    // per-algo split", printed "IFSP 1.1 $0 over 1d", and printed no residual.
    // The 20 left the account in silence and the split was shown as complete.
    const result = importOf([
      { accountName: 'ACC1', strategyName: 'IFSP-1.1', strategyFamily: 'IFSP', strategyVersion: '1.1', realized: null, enabled: true },
    ]);
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies[0].derivedRealized).toBeNull();
    expect(snapshot.strategies[0].derivedRealizedJoin).toBe('refused');
    expect(snapshot.derivation.join.offRoster).toEqual([{ strategyName: 'RBO-1.8', realized: 20 }]);
    expect(snapshot.derivation.join.offRosterRealized).toBe(20);
    expect(snapshot.derivation.join.published).toBe(false);

    const { attribution, algos } = buildAlgoAccountHistory({ dailyImports: [result] }, 'ACC1');
    expect(attribution.status).toBe('unavailable');
    expect(attribution.derivedDays).toBe(0);
    expect(algos[0].contributionPnl).toBe(0);
    // The money is still on the account and still named.
    expect(attribution.offRosterPnl).toBe(20);
    expect(attribution.offRosterNames).toEqual(['RBO-1.8']);
  });

  it('refuses to put one derived figure on two same-named roster rows', () => {
    // Reproduced: the same algo on two instruments in one account is two grid
    // rows and one derived row, and the panel showed 40 on an account that made
    // 20 — labelled derived, residual 0.
    const result = importOf([
      { accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', strategyVersion: '1.0', instrument: 'MNQ SEP26', realized: null, enabled: true },
      { accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', strategyVersion: '1.0', instrument: 'MES SEP26', realized: null, enabled: true },
    ], 'Alpha-1.0');
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies.map((s) => s.derivedRealized)).toEqual([null, null]);
    expect(snapshot.derivation.join.status).toBe('ambiguous');
    expect(snapshot.strategies.map((s) => s.derivedRealizedJoin))
      .toEqual(['ambiguous-name', 'ambiguous-name']);
    expect(snapshot.strategies.map((s) => s.strategyName)).toEqual(['Alpha-1.0', 'Alpha-1.0']);
    // WHICH names were ambiguous is stored ON THE ACCOUNT-DAY, once, and only on
    // a day that had any. It is the single per-row verdict the account-day blob
    // could not otherwise answer — every other one is recoverable from
    // `derived_realized` plus `status`/`published` — so it is kept here rather
    // than paid for with a string on every roster row of every account-day. A
    // reader looking at a blank figure asks `strategyName ∈ ambiguousNames`.
    expect(snapshot.derivation.join.ambiguousNames).toEqual(['Alpha-1.0']);
    expect(snapshot.strategies.map((s) => s.strategyName)
      .filter((n) => snapshot.derivation.join.ambiguousNames.includes(n)))
      .toEqual(['Alpha-1.0', 'Alpha-1.0']);

    const { algos, attribution } = buildAlgoAccountHistory({ dailyImports: [result] }, 'ACC1');
    expect(attribution.derivedDays).toBe(0);
    expect(algos.reduce((n, a) => n + a.contributionPnl, 0)).toBe(0);
  });

  it('still derives the ordinary case, where the roster and the fills agree', () => {
    // The regression guard for the two refusals above: they must not cost the
    // feature the case it exists for.
    const result = importOf([
      { accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', strategyVersion: '1.0', realized: null, enabled: true },
    ], 'Alpha-1.0');
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies[0].derivedRealized).toBe(20);
    expect(snapshot.derivation.join.status).toBe('exact');

    const { algos, attribution } = buildAlgoAccountHistory({ dailyImports: [result] }, 'ACC1');
    expect(attribution.derivedDays).toBe(1);
    expect(algos[0].contributionPnl).toBe(20);
  });

  it('joins each account separately when two accounts share a strategy name', () => {
    // A strategy name is not unique inside one client export — "Bullet Bot-1.1"
    // runs on four accounts in a single folder. A roster row of the other
    // account must never make this account's name look ambiguous.
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-08-18',
      registry: {},
      parsed: {
        accounts: [
          { accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50000 },
          { accountName: 'ACC2', grossRealizedPnl: 0, grossRealizedPnlReported: 0, accountBalance: 50000 },
        ],
        strategies: [
          { accountName: 'ACC2', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true },
          { accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', realized: null, enabled: true },
        ],
        ...fills('Alpha-1.0'),
      },
    });
    const first = result.snapshots.find((s) => s.accountName === 'ACC1');
    const second = result.snapshots.find((s) => s.accountName === 'ACC2');
    expect(first.strategies[0].derivedRealized).toBe(20);
    expect(second.strategies[0].derivedRealized).toBeNull();
    // Row order is the order the grid listed them in, unchanged by the join.
    expect(result.strategies.map((s) => s.accountName)).toEqual(['ACC2', 'ACC1']);
  });

  it('reports an account whose fills name a strategy its grid does not list at all', () => {
    // The account that has a derivation and NO roster: the Strategies grid
    // listed nothing for it, and the fills credited its whole $20 to Alpha-1.0.
    //
    // reconcile walks the UNION of the roster keys and the derivation keys for
    // exactly this account. Walk only the roster and this account is never
    // joined, so no derivation reaches its snapshot, and $20 of derived money
    // with a named owner leaves the close in silence — the same deletion the
    // one-directional join produced one layer down, reintroduced at the layer
    // above it. Drop `...derivationByAccount.keys()` from that Set and this
    // test fails.
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-08-18',
      registry: {},
      parsed: {
        accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50000 }],
        strategies: [],
        ...fills('Alpha-1.0'),
      },
    });
    const snapshot = result.snapshots[0];
    expect(snapshot.strategies).toEqual([]);
    expect(snapshot.derivation).not.toBeNull();
    expect(snapshot.derivation.join.status).toBe('off-roster');
    expect(snapshot.derivation.join.published).toBe(false);
    expect(snapshot.derivation.join.offRoster).toEqual([{ strategyName: 'Alpha-1.0', realized: 20 }]);
    expect(snapshot.derivation.join.offRosterRealized).toBe(20);

    // And it reaches the screen as money with a name, not as a blank roster.
    const { attribution } = buildAlgoAccountHistory({ dailyImports: [result] }, 'ACC1');
    expect(attribution.derivedDays).toBe(0);
    expect(attribution.offRosterPnl).toBe(20);
    expect(attribution.offRosterNames).toEqual(['Alpha-1.0']);
  });
});
