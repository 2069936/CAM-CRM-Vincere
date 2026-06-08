import { describe, expect, it } from 'vitest';
import { reconcileDailyImport } from './reconcile';

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
});
