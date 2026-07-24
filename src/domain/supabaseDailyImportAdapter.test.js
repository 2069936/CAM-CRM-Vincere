import { describe, expect, it } from 'vitest';
import { DAILY_IMPORT_CLOSED_CODE } from './dailyImportPersistence.js';
import { createSupabaseDailyImportAdapter } from './supabaseStore.js';

function makePostgrestFake(responder = () => ({ data: null, error: null })) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const call = { table, operations: [] };
      calls.push(call);
      let terminal = 'query';
      const builder = {
        select(columns) {
          call.operations.push(['select', columns]);
          terminal = 'select';
          return builder;
        },
        eq(column, value) {
          call.operations.push(['eq', column, value]);
          return builder;
        },
        upsert(rows, options) {
          call.operations.push(['upsert', rows, options]);
          terminal = 'upsert';
          return builder;
        },
        delete() {
          call.operations.push(['delete']);
          terminal = 'delete';
          return builder;
        },
        insert(rows) {
          call.operations.push(['insert', rows]);
          terminal = 'insert';
          return builder;
        },
        maybeSingle() {
          call.operations.push(['maybeSingle']);
          return Promise.resolve(responder({ table, terminal: 'maybeSingle', call }));
        },
        single() {
          call.operations.push(['single']);
          return Promise.resolve(responder({ table, terminal: 'single', call }));
        },
        then(resolve, reject) {
          return Promise.resolve(responder({ table, terminal, call })).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}

describe('createSupabaseDailyImportAdapter', () => {
  it('is explicitly manual-only and non-atomic', () => {
    const adapter = createSupabaseDailyImportAdapter(makePostgrestFake());

    expect(adapter).toMatchObject({ isAtomic: false, manualOnly: true });
  });

  it('checks writability with the expected client/date query shape', async () => {
    const client = makePostgrestFake(() => ({
      data: { id: 'open-import', status: 'Needs review' },
      error: null,
    }));
    const adapter = createSupabaseDailyImportAdapter(client);

    const existing = await adapter.guardDailyImportWritable('client-uuid', '2026-07-23');

    expect(existing).toEqual({ id: 'open-import', status: 'Needs review' });
    expect(client.calls).toEqual([{
      table: 'daily_imports',
      operations: [
        ['select', 'id, status'],
        ['eq', 'client_id', 'client-uuid'],
        ['eq', 'trading_date', '2026-07-23'],
        ['maybeSingle'],
      ],
    }]);
  });

  it('rejects a Closed day from its compatibility writability check', async () => {
    const client = makePostgrestFake(() => ({
      data: { id: 'closed-import', status: 'Closed' },
      error: null,
    }));
    const adapter = createSupabaseDailyImportAdapter(client);

    await expect(adapter.guardDailyImportWritable('client-uuid', '2026-07-23'))
      .rejects.toMatchObject({ code: DAILY_IMPORT_CLOSED_CODE });
  });

  it('routes supported upsert, delete, and insert operations through PostgREST', async () => {
    const client = makePostgrestFake(({ table, terminal }) => {
      if (table === 'trading_accounts' && terminal === 'select') {
        return { data: [{ id: 'account-1', account_name: 'ACC1' }], error: null };
      }
      if (table === 'daily_imports' && terminal === 'single') {
        return { data: { id: 'import-1' }, error: null };
      }
      if (table === 'account_snapshots' && terminal === 'select') {
        return { data: [{ id: 'snapshot-1' }], error: null };
      }
      return { data: null, error: null };
    });
    const adapter = createSupabaseDailyImportAdapter(client);
    const accountRows = [{ account_name: 'ACC1' }];
    const dailyImportRow = { client_id: 'client-1', trading_date: '2026-07-23' };
    const snapshotRows = [{ account_name: 'ACC1' }];
    const orderRows = [{ external_order_id: 'order-1' }];

    await adapter.upsertTradingAccounts(accountRows);
    await expect(adapter.listTradingAccounts('client-1')).resolves.toEqual([
      { id: 'account-1', account_name: 'ACC1' },
    ]);
    await expect(adapter.upsertDailyImport(dailyImportRow)).resolves.toEqual({ id: 'import-1' });
    await adapter.deleteDailyImportRows('orders', 'import-1');
    await expect(adapter.upsertAccountSnapshots(snapshotRows)).resolves.toEqual([{ id: 'snapshot-1' }]);
    await adapter.insertRows('orders', orderRows);

    expect(client.calls).toEqual([
      {
        table: 'trading_accounts',
        operations: [['upsert', accountRows, { onConflict: 'client_id,account_name' }]],
      },
      {
        table: 'trading_accounts',
        operations: [['select', 'id, account_name'], ['eq', 'client_id', 'client-1']],
      },
      {
        table: 'daily_imports',
        operations: [
          ['upsert', dailyImportRow, { onConflict: 'client_id,trading_date' }],
          ['select', undefined],
          ['single'],
        ],
      },
      {
        table: 'orders',
        operations: [['delete'], ['eq', 'daily_import_id', 'import-1']],
      },
      {
        table: 'account_snapshots',
        operations: [
          ['upsert', snapshotRows, { onConflict: 'daily_import_id,account_name' }],
          ['select', undefined],
        ],
      },
      { table: 'orders', operations: [['insert', orderRows]] },
    ]);
  });

  it('propagates mutation errors without swallowing them', async () => {
    const client = makePostgrestFake(({ table, terminal }) => ({
      data: null,
      error: table === 'orders' && terminal === 'insert' ? { message: 'insert failed' } : null,
    }));
    const adapter = createSupabaseDailyImportAdapter(client);

    await expect(adapter.insertRows('orders', [{ external_order_id: 'order-1' }]))
      .rejects.toThrow('insert failed');
  });

  it('rejects unsupported child tables before accessing PostgREST', async () => {
    const client = makePostgrestFake();
    const adapter = createSupabaseDailyImportAdapter(client);

    await expect(adapter.deleteDailyImportRows('clients', 'import-1'))
      .rejects.toThrow('Unsupported daily import delete table: clients');
    await expect(adapter.insertRows('clients', []))
      .rejects.toThrow('Unsupported daily import insert table: clients');
    expect(client.calls).toEqual([]);
  });
});
