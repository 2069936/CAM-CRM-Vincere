import { describe, expect, it, vi } from 'vitest';
import {
  DAILY_IMPORT_CLOSED_CODE,
  persistDailyImportWithClient,
} from './dailyImportPersistence.js';

function makeDb({ existingImport = null, supportsSourceColumns = false } = {}) {
  const db = {
    supportsDailyImportSourceColumns: supportsSourceColumns,
    transaction: vi.fn(async (work) => work(db)),
    findDailyImportByClientAndDate: vi.fn(async () => existingImport),
    upsertTradingAccounts: vi.fn(async () => undefined),
    listTradingAccounts: vi.fn(async () => [
      { id: 'account-1', account_name: 'ACC-One' },
    ]),
    upsertDailyImport: vi.fn(async (row) => ({ id: existingImport?.id || 'import-1', ...row })),
    deleteDailyImportRows: vi.fn(async () => undefined),
    upsertAccountSnapshots: vi.fn(async (rows) => rows.map((row, index) => ({
      id: `snapshot-${index + 1}`,
      ...row,
    }))),
    insertRows: vi.fn(async () => undefined),
  };
  return db;
}

function importResult(overrides = {}) {
  return {
    id: 'legacy-import-1',
    date: '2026-07-23',
    importedAt: '2026-07-23T22:00:00.000Z',
    status: 'Needs review',
    accounts: {},
    snapshots: [],
    strategies: [],
    orders: [],
    executions: [],
    flags: [],
    ...overrides,
  };
}

function mutationCalls(db) {
  return [
    db.upsertTradingAccounts,
    db.upsertDailyImport,
    db.deleteDailyImportRows,
    db.upsertAccountSnapshots,
    db.insertRows,
  ].reduce((total, spy) => total + spy.mock.calls.length, 0);
}

describe('persistDailyImportWithClient', () => {
  it('rejects a missing import date before accessing the adapter', async () => {
    const db = makeDb();

    await expect(persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({ date: '' }),
    })).rejects.toThrow('Import date is required.');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a missing client UUID before accessing the adapter', async () => {
    const db = makeDb();

    await expect(persistDailyImportWithClient({
      db,
      clientUuid: '',
      importResult: importResult(),
    })).rejects.toThrow('Client UUID is required.');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('refuses a Closed day with a stable conflict code and zero mutations', async () => {
    const existingImport = { id: 'closed-import', status: 'Closed' };
    const db = makeDb({ existingImport });

    await expect(persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult(),
    })).rejects.toMatchObject({ code: DAILY_IMPORT_CLOSED_CODE });

    expect(db.findDailyImportByClientAndDate).toHaveBeenCalledWith('client-uuid', '2026-07-23');
    expect(mutationCalls(db)).toBe(0);
  });

  it.each([
    ['missing', null, 'import-1'],
    ['open', { id: 'open-import', status: 'Needs review' }, 'open-import'],
  ])('upserts a %s day and returns the saved daily import', async (_label, existingImport, expectedId) => {
    const db = makeDb({ existingImport });

    const saved = await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult(),
    });

    expect(db.upsertDailyImport).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({ id: expectedId, client_id: 'client-uuid', trading_date: '2026-07-23' });
  });

  it('maps every persisted table and links account names case-insensitively', async () => {
    const db = makeDb();
    const result = importResult({
      accounts: {
        account: {
          accountName: 'acc-one',
          alias: 'Primary',
          connection: 'Lucid',
          accountType: 'Funded',
          status: 'Active',
          payoutState: 'Requested',
          startBalance: '50000',
          targetProfit: 3000,
          maxDrawdownLimit: 2000,
          bulletBotPassType: 'Evaluation',
          bulletBotDirection: 'Long',
          notes: 'note',
          dateAdded: '2026-01-01',
          dateFunded: '2026-02-01',
          dateFailed: '',
          dateLastPayout: '2026-07-01',
          payoutCount: 2,
        },
      },
      snapshots: [{
        accountName: 'acc-one',
        connection: 'Lucid',
        grossRealizedPnl: 125,
        trailingMaxDrawdown: 450,
        accountBalance: 50125,
        weeklyPnl: 600,
        unrealizedPnl: -10,
      }],
      strategies: [{
        accountName: 'ACC-ONE',
        strategyName: 'RBO-1.8',
        strategyFamily: 'RBO',
        strategyVersion: '1.8',
        instrument: 'MNQ SEP26',
        dataSeries: '1 Minute',
        parametersRaw: '{}',
        params: { parsed: true },
        direction: 'Long',
        enabled: true,
        realized: 125,
        unrealized: -10,
      }],
      orders: [{
        id: 'order-1', accountName: 'Acc-One', strategyName: 'RBO-1.8', instrument: 'MNQ SEP26',
        action: 'Buy', orderType: 'Limit', quantity: 2, limit: 20100.25, stop: 20000,
        state: 'Working', filled: 1, avgPrice: 20100, remaining: 1, name: 'Entry', time: '09:30',
      }],
      executions: [{
        id: 'execution-1', orderId: 'order-1', accountName: 'acc-one', strategyName: 'RBO-1.8',
        instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 20100, time: '09:31',
        entryExit: 'Entry', position: 'Long', name: 'Entry', commission: 1.24, rate: 0.35,
        connection: 'Lucid',
      }],
      flags: [{
        accountName: 'ACC-ONE', type: 'Review', severity: 'Critical', message: 'Check it', status: 'Open',
      }],
    });

    await persistDailyImportWithClient({ db, clientUuid: 'client-uuid', importResult: result });

    expect(db.upsertTradingAccounts).toHaveBeenCalledWith([
      expect.objectContaining({
        client_id: 'client-uuid', legacy_key: 'acc-one', account_name: 'acc-one', alias: 'Primary',
        connection: 'Lucid', account_type: 'Funded', status: 'Active', payout_state: 'Requested',
        start_balance: 50000, target_profit: 3000, max_drawdown_limit: 2000,
        bullet_bot_pass_type: 'Evaluation', bullet_bot_direction: 'Long', notes: 'note',
        date_added: '2026-01-01', date_funded: '2026-02-01', date_failed: null,
        date_last_payout: '2026-07-01', payout_count: 2, updated_at: expect.any(String),
      }),
    ]);
    expect(db.upsertDailyImport).toHaveBeenCalledWith(expect.objectContaining({
      client_id: 'client-uuid', legacy_key: 'legacy-import-1', trading_date: '2026-07-23',
      imported_at: '2026-07-23T22:00:00.000Z', status: 'Needs review',
      source_summary: { accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 1 },
      updated_at: expect.any(String),
    }));
    expect(db.deleteDailyImportRows.mock.calls).toEqual([
      ['strategy_snapshots', 'import-1'],
      ['orders', 'import-1'],
      ['executions', 'import-1'],
      ['operational_flags', 'import-1'],
    ]);
    expect(db.upsertAccountSnapshots).toHaveBeenCalledWith([{
      daily_import_id: 'import-1', trading_account_id: 'account-1', account_name: 'acc-one',
      connection: 'Lucid', gross_realized_pnl: 125, trailing_max_drawdown: 450,
      account_balance: 50125, weekly_pnl: 600, unrealized_pnl: -10,
    }]);
    expect(db.insertRows).toHaveBeenNthCalledWith(1, 'strategy_snapshots', [{
      daily_import_id: 'import-1', trading_account_id: 'account-1', account_snapshot_id: 'snapshot-1',
      strategy_name: 'RBO-1.8', strategy_family: 'RBO', strategy_version: '1.8',
      instrument: 'MNQ SEP26', data_series: '1 Minute', parameters_raw: '{}',
      params_parsed: { parsed: true }, direction: 'Long', enabled: true, realized: 125, unrealized: -10,
    }]);
    expect(db.insertRows).toHaveBeenNthCalledWith(2, 'orders', [{
      daily_import_id: 'import-1', trading_account_id: 'account-1', external_order_id: 'order-1',
      strategy_name: 'RBO-1.8', instrument: 'MNQ SEP26', action: 'Buy', order_type: 'Limit',
      quantity: 2, limit_price: 20100.25, stop_price: 20000, state: 'Working', filled: 1,
      avg_price: 20100, remaining: 1, name: 'Entry', time_text: '09:30',
    }]);
    expect(db.insertRows).toHaveBeenNthCalledWith(3, 'executions', [{
      daily_import_id: 'import-1', trading_account_id: 'account-1', external_execution_id: 'execution-1',
      external_order_id: 'order-1', strategy_name: 'RBO-1.8', instrument: 'MNQ SEP26', action: 'Buy',
      quantity: 1, price: 20100, time_text: '09:31', entry_exit: 'Entry', position: 'Long',
      name: 'Entry', commission: 1.24, rate: 0.35, connection: 'Lucid',
    }]);
    expect(db.insertRows).toHaveBeenNthCalledWith(4, 'operational_flags', [{
      daily_import_id: 'import-1', client_id: 'client-uuid', trading_account_id: 'account-1',
      type: 'Review', severity: 'Critical', message: 'Check it', status: 'Open',
    }]);
  });

  it('retains empty strategy/order/execution sections while always refreshing derived flags', async () => {
    const db = makeDb({ existingImport: { id: 'open-import', status: 'Ready to close' } });

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({ flags: [] }),
    });

    expect(db.deleteDailyImportRows).toHaveBeenCalledOnce();
    expect(db.deleteDailyImportRows).toHaveBeenCalledWith('operational_flags', 'open-import');
    expect(db.upsertAccountSnapshots).not.toHaveBeenCalled();
    expect(db.insertRows).not.toHaveBeenCalled();
  });

  it('preserves explicit null numeric values while defaulting undefined legacy snapshot values', async () => {
    const db = makeDb();

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({
        accounts: { account: { accountName: 'acc-one', payoutCount: null } },
        snapshots: [
          {
            accountName: 'acc-one', grossRealizedPnl: null, trailingMaxDrawdown: null,
            accountBalance: null, weeklyPnl: null, unrealizedPnl: null,
          },
          { accountName: 'legacy-account' },
        ],
        strategies: [{ accountName: 'acc-one', realized: null, unrealized: null }],
        orders: [{ accountName: 'acc-one', quantity: null, limit: null, stop: null, filled: null, avgPrice: null, remaining: null }],
        executions: [{ accountName: 'acc-one', quantity: null, price: null, commission: null, rate: null }],
      }),
    });

    expect(db.upsertTradingAccounts.mock.calls[0][0][0].payout_count).toBeNull();
    expect(db.upsertAccountSnapshots.mock.calls[0][0][0]).toMatchObject({
      gross_realized_pnl: null, trailing_max_drawdown: null, account_balance: null,
      weekly_pnl: null, unrealized_pnl: null,
    });
    expect(db.upsertAccountSnapshots.mock.calls[0][0][1]).toMatchObject({
      gross_realized_pnl: 0, trailing_max_drawdown: 0, account_balance: 0,
      weekly_pnl: 0, unrealized_pnl: 0,
    });
    expect(db.insertRows.mock.calls[0][1][0]).toMatchObject({ realized: null, unrealized: null });
    expect(db.insertRows.mock.calls[1][1][0]).toMatchObject({
      quantity: null, limit_price: null, stop_price: null, filled: null, avg_price: null, remaining: null,
    });
    expect(db.insertRows.mock.calls[2][1][0]).toMatchObject({
      quantity: null, price: null, commission: null, rate: null,
    });
  });

  it('adds supported source columns and retains batch linkage in source summary metadata', async () => {
    const db = makeDb({ supportsSourceColumns: true });

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult(),
      sourceBatchId: 'batch-1',
    });

    expect(db.upsertDailyImport).toHaveBeenCalledWith(expect.objectContaining({
      source_type: 'automatic',
      source_batch_id: 'batch-1',
      source_summary: expect.objectContaining({ source_type: 'automatic', source_batch_id: 'batch-1' }),
    }));
  });

  it('omits unsupported source columns but retains batch linkage in source summary metadata', async () => {
    const db = makeDb({ supportsSourceColumns: false });

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult(),
      sourceBatchId: 'batch-1',
    });

    const row = db.upsertDailyImport.mock.calls[0][0];
    expect(row).not.toHaveProperty('source_type');
    expect(row).not.toHaveProperty('source_batch_id');
    expect(row.source_summary).toMatchObject({ source_type: 'automatic', source_batch_id: 'batch-1' });
  });

  it('keeps manual imports source-compatible when no source batch is supplied', async () => {
    const db = makeDb({ supportsSourceColumns: true });

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult(),
    });

    const row = db.upsertDailyImport.mock.calls[0][0];
    expect(row).not.toHaveProperty('source_type');
    expect(row).not.toHaveProperty('source_batch_id');
    expect(row.source_summary).not.toHaveProperty('source_type');
    expect(row.source_summary).not.toHaveProperty('source_batch_id');
  });

  it('rejects a child failure and lets a transactional adapter discard staged mutations', async () => {
    const committed = [];
    const db = {
      supportsDailyImportSourceColumns: false,
      async transaction(work) {
        const staged = [];
        const tx = {
          findDailyImportByClientAndDate: async () => null,
          upsertTradingAccounts: async () => staged.push('accounts'),
          listTradingAccounts: async () => [{ id: 'account-1', account_name: 'acc-one' }],
          upsertDailyImport: async (row) => {
            staged.push('daily-import');
            return { id: 'import-1', ...row };
          },
          deleteDailyImportRows: async (table) => staged.push(`delete:${table}`),
          upsertAccountSnapshots: async (rows) => {
            staged.push('snapshots');
            return rows;
          },
          async insertRows(table) {
            staged.push(`insert:${table}`);
            if (table === 'orders') throw new Error('order insert failed');
          },
        };
        const result = await work(tx);
        committed.push(...staged);
        return result;
      },
    };

    await expect(persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({
        strategies: [{ accountName: 'acc-one' }],
        orders: [{ accountName: 'acc-one' }],
      }),
    })).rejects.toThrow('order insert failed');

    expect(committed).toEqual([]);
  });
});
