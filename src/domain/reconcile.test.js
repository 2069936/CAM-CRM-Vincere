import { describe, expect, it } from 'vitest';
import { recalculateDailyImport, reconcileDailyImport } from './reconcile';

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
    // Registry has uppercase key; CSV exports lowercase — must not produce a false "Missing account" flag
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
});
