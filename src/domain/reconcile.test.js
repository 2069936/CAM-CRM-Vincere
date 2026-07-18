import { describe, expect, it } from 'vitest';
import { makeAccountAlias, recalculateDailyImport, reconcileDailyImport } from './reconcile';

describe('reconcileDailyImport', () => {
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

  it('ignores simulator accounts that start with SIM', () => {
    const parsed = {
      accounts: [
        { accountName: 'Sim101', connection: 'Simulated Data Feed', grossRealizedPnl: 999, accountBalance: 100000, weeklyPnl: 999 },
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

    expect(Object.keys(result.accounts)).toEqual(['LIVE1234']);
    expect(result.snapshots.map((snapshot) => snapshot.accountName)).toEqual(['LIVE1234']);
    expect(result.strategies.map((strategy) => strategy.accountName)).toEqual(['LIVE1234']);
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
