import { describe, expect, it, vi } from 'vitest';
import {
  DAILY_IMPORT_CLOSED_CODE,
  DailyImportClosedError,
  persistDailyImportWithClient,
  withLegacyDailyImportId,
} from './dailyImportPersistence.js';
import { reconcileDailyImport } from './reconcile.js';

function makeDb({ existingImport = null, supportsSourceColumns = false } = {}) {
  const db = {
    supportsDailyImportSourceColumns: supportsSourceColumns,
    transaction: vi.fn(async (work) => work(db)),
    guardDailyImportWritable: vi.fn(async (_clientUuid, tradingDate) => {
      if (existingImport?.status === 'Closed') throw new DailyImportClosedError(tradingDate);
      return existingImport;
    }),
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
  it('delegates automatic imports to the adapter atomic persistence boundary', async () => {
    const persistDailyImportAtomic = vi.fn().mockResolvedValue({ id: 'daily-atomic' });
    const result = await persistDailyImportWithClient({
      db: { persistDailyImportAtomic, isAtomic: true },
      clientUuid: 'client-uuid',
      importResult: { date: '2026-07-23' },
      sourceBatchId: 'batch-1',
    });
    expect(result).toEqual({ id: 'daily-atomic' });
    // The atomic RPC reads snapshots/strategies/orders/executions in SQL and
    // knows nothing about the simulation container, so the whole close is
    // flattened before it is handed over. Without this, automatically collected
    // clients would keep losing their simulated rows entirely.
    expect(persistDailyImportAtomic).toHaveBeenCalledWith({
      clientUuid: 'client-uuid',
      importResult: {
        date: '2026-07-23', snapshots: [], strategies: [], orders: [], executions: [],
      },
      sourceBatchId: 'batch-1',
    });
  });
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

    expect(db.guardDailyImportWritable).toHaveBeenCalledWith('client-uuid', '2026-07-23');
    expect(mutationCalls(db)).toBe(0);
  });

  it('runs the writable guard before the first mutation', async () => {
    const db = makeDb();

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({ accounts: { account: { accountName: 'acc-one' } } }),
    });

    expect(db.guardDailyImportWritable.mock.invocationCallOrder[0])
      .toBeLessThan(db.upsertTradingAccounts.mock.invocationCallOrder[0]);
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
          riskLevel: 'Balanced',
          bulletBotPassType: 'Evaluation',
          bulletBotDirection: 'Long',
          algoStack: 'RBO + URGO',
          dailyLossLimit: '750',
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
        id: '11111111-1111-4111-8111-111111111111',
        accountName: 'ACC-ONE', type: 'Review', severity: 'Critical', message: 'Check it',
        status: 'Acknowledged', resolvedAt: '2026-07-23T22:15:00.000Z', resolvedByUserId: 'user-1',
      }, {
        id: '22222222-2222-4222-8222-222222222222',
        accountName: 'acc-one', type: 'Open review', message: 'Still open', status: 'Open',
      }],
    });

    await persistDailyImportWithClient({ db, clientUuid: 'client-uuid', importResult: result });

    expect(db.upsertTradingAccounts).toHaveBeenCalledWith([
      expect.objectContaining({
        client_id: 'client-uuid', legacy_key: 'acc-one', account_name: 'acc-one', alias: 'Primary',
        connection: 'Lucid', account_type: 'Funded', status: 'Active', payout_state: 'Requested',
        start_balance: 50000, target_profit: 3000, max_drawdown_limit: 2000,
        risk_level: 'Balanced', algo_stack: 'RBO + URGO', daily_loss_limit: '750',
        bullet_bot_pass_type: 'Evaluation', bullet_bot_direction: 'Long', notes: 'note',
        date_added: '2026-01-01', date_funded: '2026-02-01', date_failed: null,
        date_last_payout: '2026-07-01', payout_count: 2, updated_at: expect.any(String),
      }),
    ]);
    expect(db.upsertDailyImport).toHaveBeenCalledWith(expect.objectContaining({
      client_id: 'client-uuid', legacy_key: 'legacy-import-1', trading_date: '2026-07-23',
      imported_at: '2026-07-23T22:00:00.000Z', status: 'Needs review',
      source_summary: { accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2 },
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
      // Null because this fixture's snapshot carries no derivation. The column
      // has to be written even so: an account-day whose derivation is absent
      // must read back as absent, not inherit whatever the previous row had.
      derivation: null,
    }]);
    expect(db.insertRows).toHaveBeenNthCalledWith(1, 'strategy_snapshots', [{
      daily_import_id: 'import-1', trading_account_id: 'account-1', account_snapshot_id: 'snapshot-1',
      strategy_name: 'RBO-1.8', strategy_family: 'RBO', strategy_version: '1.8',
      instrument: 'MNQ SEP26', data_series: '1 Minute', parameters_raw: '{}',
      params_parsed: { parsed: true }, direction: 'Long', enabled: true, realized: 125, unrealized: -10,
      // Whether the algorithm ran that day, beside the checkbox and never over
      // it. Null here because this fixture's row reached the mapper without an
      // answer, which is what a close written before step 47 looks like; the
      // reconcile fixtures below carry one, because reconcile decides it.
      ran: null,
      ran_basis: null,
      // ONE derived column, and this assertion is an exact object match, so it
      // is also the guard that the two cut ones do not come back. The account-day
      // verdict and the per-row join reason are answerable from
      // account_snapshots.derivation, which stores them once instead of once per
      // roster row; see step 37 for the measurement that decided it.
      derived_realized: null,
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
    // The id travels with the row. Without it Postgres mints its own, the app
    // never learns it, and resolving the flag later targets an id the database
    // has never seen.
    expect(db.insertRows).toHaveBeenNthCalledWith(4, 'operational_flags', [{
      id: '11111111-1111-4111-8111-111111111111',
      daily_import_id: 'import-1', client_id: 'client-uuid', trading_account_id: 'account-1',
      type: 'Review', severity: 'Critical', message: 'Check it', status: 'Acknowledged',
      resolved_at: '2026-07-23T22:15:00.000Z', resolved_by_user_id: 'user-1',
    }, {
      id: '22222222-2222-4222-8222-222222222222',
      daily_import_id: 'import-1', client_id: 'client-uuid', trading_account_id: 'account-1',
      type: 'Open review', severity: 'Warning', message: 'Still open', status: 'Open',
      resolved_at: null, resolved_by_user_id: null,
    }]);
  });

  it('stores whether each strategy ran, and the evidence for it', async () => {
    // The answer reconcile reached over the close's own fills. It is stored
    // because the screens that ask must not have to load the fills to find out:
    // `enabled` is a checkbox at export time and the exports are taken after
    // the desk switches the algos off. See src/domain/strategyRan.js, step 47.
    const db = makeDb();

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({
        strategies: [
          { accountName: 'acc-one', strategyName: 'RBO-1.8', enabled: false, realized: 0, ran: true, ranBasis: 'fills' },
          { accountName: 'acc-one', strategyName: 'IFSP-1.1', enabled: false, realized: 0, ran: false, ranBasis: 'none' },
        ],
      }),
    });

    const [, rows] = db.insertRows.mock.calls.find(([table]) => table === 'strategy_snapshots');
    expect(rows.map((row) => [row.strategy_name, row.enabled, row.ran, row.ran_basis])).toEqual([
      ['RBO-1.8', false, true, 'fills'],
      ['IFSP-1.1', false, false, 'none'],
    ]);
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

  it('defaults only undefined legacy numeric values and maps all other invalid values to null', async () => {
    const db = makeDb();
    const values = [null, '', 'not-a-number', Number.NaN, Number.POSITIVE_INFINITY, undefined];

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({
        accounts: Object.fromEntries(values.map((payoutCount, index) => [
          `account-${index}`,
          { accountName: `account-${index}`, payoutCount },
        ])),
        snapshots: values.map((value, index) => ({
          accountName: `account-${index}`,
          grossRealizedPnl: value,
          trailingMaxDrawdown: value,
          accountBalance: value,
          weeklyPnl: value,
          unrealizedPnl: value,
        })),
        strategies: values.map((value, index) => ({
          accountName: `account-${index}`,
          realized: value,
          unrealized: value,
        })),
      }),
    });

    const expected = [null, null, null, null, null, 0];
    expect(db.upsertTradingAccounts.mock.calls[0][0].map((row) => row.payout_count)).toEqual(expected);
    for (const field of [
      'gross_realized_pnl', 'trailing_max_drawdown', 'account_balance', 'weekly_pnl', 'unrealized_pnl',
    ]) {
      expect(db.upsertAccountSnapshots.mock.calls[0][0].map((row) => row[field])).toEqual(expected);
    }
    for (const field of ['realized', 'unrealized']) {
      expect(db.insertRows.mock.calls[0][1].map((row) => row[field])).toEqual(expected);
    }
  });

  it('adds supported source columns and retains batch linkage in source summary metadata', async () => {
    const db = makeDb({ supportsSourceColumns: true });

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({
        snapshots: [
          { accountName: 'a', pnlSource: 'realized' },
          { accountName: 'b', pnlSource: 'gross_fallback' },
          { accountName: 'c', pnlSource: 'gross_missing_realized' },
          { accountName: 'd', pnlSource: 'unavailable' },
          { accountName: 'e', pnlSource: 'unexpected' },
        ],
      }),
      sourceBatchId: 'batch-1',
    });

    expect(db.upsertDailyImport).toHaveBeenCalledWith(expect.objectContaining({
      source_type: 'automatic',
      source_batch_id: 'batch-1',
      source_summary: expect.objectContaining({
        source_type: 'automatic',
        source_batch_id: 'batch-1',
        pnl_sources: {
          realized: 1,
          gross_fallback: 1,
          gross_missing_realized: 1,
          unavailable: 1,
          unknown: 1,
        },
      }),
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
          guardDailyImportWritable: async () => null,
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

  it('keeps an atomic writable guard held through all transaction work', async () => {
    const events = [];
    let guardHeld = false;
    const assertGuarded = (event) => {
      expect(guardHeld).toBe(true);
      events.push(event);
    };
    const db = {
      supportsDailyImportSourceColumns: false,
      async transaction(work) {
        events.push('transaction:start');
        const tx = {
          async guardDailyImportWritable() {
            guardHeld = true;
            events.push('guard:acquired');
          },
          upsertTradingAccounts: async () => assertGuarded('accounts:upsert'),
          listTradingAccounts: async () => {
            assertGuarded('accounts:list');
            return [];
          },
          upsertDailyImport: async (row) => {
            assertGuarded('daily-import:upsert');
            return { id: 'import-1', ...row };
          },
          deleteDailyImportRows: async (table) => assertGuarded(`${table}:delete`),
          upsertAccountSnapshots: async () => [],
          insertRows: async () => undefined,
        };
        try {
          const result = await work(tx);
          assertGuarded('transaction:commit');
          return result;
        } finally {
          guardHeld = false;
          events.push('guard:released');
        }
      },
    };

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({ accounts: { account: { accountName: 'acc-one' } } }),
    });

    expect(events).toEqual([
      'transaction:start',
      'guard:acquired',
      'accounts:upsert',
      'accounts:list',
      'daily-import:upsert',
      'operational_flags:delete',
      'transaction:commit',
      'guard:released',
    ]);
  });
});

describe('withLegacyDailyImportId', () => {
  it('fills the legacy manual key from the original client id without mutating input', () => {
    const input = { date: '2026-07-23', status: 'Ready to close' };

    const result = withLegacyDailyImportId('legacy-client', input);

    expect(result).toEqual({ ...input, id: 'legacy-client-2026-07-23' });
    expect(result).not.toBe(input);
    expect(input).not.toHaveProperty('id');
  });

  it('preserves an existing import id while still returning a shallow copy', () => {
    const input = { id: 'existing-id', date: '2026-07-23' };

    const result = withLegacyDailyImportId('legacy-client', input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe('manual reconcile to persistence', () => {
  it('preserves configured algo stack and daily loss limit for a seen account', async () => {
    const registry = {
      ACC1: {
        accountName: 'ACC1',
        alias: 'Primary',
        connection: 'Lucid',
        accountType: 'Funded',
        status: 'Active',
        payoutState: 'Not requested',
        riskLevel: 'Medium',
        algoStack: 'RBO + URGO',
        dailyLossLimit: '750',
      },
    };
    const reconciled = reconcileDailyImport({
      clientId: 'legacy-client',
      date: '2026-07-23',
      registry,
      parsed: {
        accounts: [{
          accountName: 'ACC1',
          connection: 'Lucid',
          grossRealizedPnl: 125,
          accountBalance: 50125,
        }],
        strategies: [{ accountName: 'ACC1', strategyName: 'RBO-1.8', enabled: true }],
        orders: [],
        executions: [],
      },
    });
    const db = makeDb();

    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: reconciled,
    });

    expect(db.upsertTradingAccounts).toHaveBeenCalledWith([
      expect.objectContaining({
        account_name: 'ACC1',
        risk_level: 'Medium',
        algo_stack: 'RBO + URGO',
        daily_loss_limit: '750',
      }),
    ]);
  });
});

/* ── The per (close, segment) money, written where the close is written ──────
 *
 * Step 48. The manager's first screen used to compute these figures in the
 * browser by walking `account_snapshots` for every close in the book — 12,778
 * rows on production to produce about 5,000 numbers. They are now written once,
 * at ingest, by the same `buildSegmentTotals` the screen ran.
 *
 * What these tests pin is that BOTH ingest paths write them, that they are
 * decided from the close as reconcile produced it rather than from the
 * flattened payload the atomic RPC receives, and that an adapter without the
 * writer still stores the close. */

describe('the close summary the desk money is read from', () => {
  const closeWithEverything = () => importResult({
    accounts: {
      'ACC-One': { accountName: 'ACC-One', accountType: 'Cash' },
      'ACC-Two': { accountName: 'ACC-Two', accountType: 'Funded' },
      'SIM-1': { accountName: 'SIM-1', accountType: 'Simulation' },
    },
    snapshots: [
      { accountName: 'ACC-One', grossRealizedPnl: 10, weeklyPnl: 20, accountBalance: 100 },
      { accountName: 'ACC-Two', grossRealizedPnl: -5, weeklyPnl: -7, accountBalance: 50 },
    ],
    simulation: {
      snapshots: [{ accountName: 'SIM-1', grossRealizedPnl: 999, weeklyPnl: 999, accountBalance: 9999 }],
      strategies: [],
      orders: [],
      executions: [],
      totals: { accounts: 1, balance: 9999, dailyPnl: 999, weeklyPnl: 999 },
      denominator: { accountsInClose: 3 },
      undetermined: {
        snapshots: [], strategies: [], orders: [], executions: [],
        totals: { accounts: 0, balance: 0, dailyPnl: 0, weeklyPnl: 0 },
      },
    },
  });

  it('writes one row per segment through the browser adapter', async () => {
    const db = makeDb();
    db.replaceCloseSummaries = vi.fn(async () => undefined);
    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: closeWithEverything(),
    });

    expect(db.replaceCloseSummaries).toHaveBeenCalledTimes(1);
    const { dailyImportId, rows } = db.replaceCloseSummaries.mock.calls[0][0];
    expect(dailyImportId).toBe('import-1');
    expect(rows.map((row) => row.segment).sort()).toEqual(['Cash', 'Funded', 'Simulated (not real money)']);
    const cash = rows.find((row) => row.segment === 'Cash');
    expect(cash).toMatchObject({
      client_id: 'client-uuid',
      trading_date: '2026-07-23',
      accounts: 1,
      daily_pnl: 10,
      weekly_pnl: 20,
      balance: 100,
      counted_in_total: true,
      account_names: ['ACC-One'],
    });
    // Counted, and never part of a business. EXCLUDED_FROM_TOTAL is evaluated
    // by the writer and stored, not re-derived from the segment name on the way
    // back in.
    expect(rows.find((row) => row.segment === 'Simulated (not real money)').counted_in_total).toBe(false);
  });

  it('writes them through the collector adapter too, after the close is stored', async () => {
    const calls = [];
    const persistDailyImportAtomic = vi.fn(async () => {
      calls.push('close');
      return { id: 'daily-atomic' };
    });
    const replaceCloseSummaries = vi.fn(async () => { calls.push('summary'); });
    await persistDailyImportWithClient({
      db: { persistDailyImportAtomic, isAtomic: true, replaceCloseSummaries },
      clientUuid: 'client-uuid',
      importResult: closeWithEverything(),
      sourceBatchId: 'batch-1',
    });

    // Order matters: the summary references the close, so the close is stored
    // first and its id is what the rows are written against.
    expect(calls).toEqual(['close', 'summary']);
    expect(replaceCloseSummaries.mock.calls[0][0].dailyImportId).toBe('daily-atomic');
  });

  it('counts a simulated account once, not twice', async () => {
    // THE TRAP. The atomic path sends `{...importResult, ...mergeSimulationRows(importResult)}`
    // to the RPC, which flattens the simulated rows into `snapshots` while
    // `simulation` travels along untouched. Summarising THAT payload would read
    // every simulated account twice — once in `snapshots`, once under
    // `simulation` — so the summary is taken from the original result.
    const replaceCloseSummaries = vi.fn(async () => undefined);
    await persistDailyImportWithClient({
      db: {
        persistDailyImportAtomic: vi.fn(async () => ({ id: 'daily-atomic' })),
        isAtomic: true,
        replaceCloseSummaries,
      },
      clientUuid: 'client-uuid',
      importResult: closeWithEverything(),
      sourceBatchId: 'batch-1',
    });
    const rows = replaceCloseSummaries.mock.calls[0][0].rows;
    const simulated = rows.find((row) => row.segment === 'Simulated (not real money)');
    expect(simulated.accounts).toBe(1);
    expect(simulated.balance).toBe(9999);
    expect(rows.reduce((total, row) => total + row.accounts, 0)).toBe(3);
  });

  it('marks a close that carried no account rows as summarised anyway', async () => {
    // 8 of the book's 485 closes hold no account rows at all, one of them with
    // 15 orders against 0 accounts. Without a row the table cannot tell that
    // close apart from one nobody has summarised, and the manager's basis line
    // would report eight permanent holes that are not holes.
    const db = makeDb();
    db.replaceCloseSummaries = vi.fn(async () => undefined);
    await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: importResult({ accounts: {}, snapshots: [] }),
    });
    const { rows } = db.replaceCloseSummaries.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].accounts).toBe(0);
    expect(rows[0].counted_in_total).toBe(false);
    expect(rows[0].account_names).toEqual([]);
  });

  it('stores the close on an adapter that cannot write summaries', async () => {
    // A database where step 48 has not run. The close is saved, the desk figure
    // falls back to the closes the session holds, and nothing fails.
    const db = makeDb();
    const saved = await persistDailyImportWithClient({
      db,
      clientUuid: 'client-uuid',
      importResult: closeWithEverything(),
    });
    expect(saved.id).toBe('import-1');
    expect(db.upsertAccountSnapshots).toHaveBeenCalled();
  });
});
