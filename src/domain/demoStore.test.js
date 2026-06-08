import { describe, expect, it } from 'vitest';
import {
  addClient,
  appendDailyImport,
  createInitialState,
  getLatestClientImport,
  upsertAccountMeta,
} from './demoStore';

describe('demoStore', () => {
  it('creates clients and persists account metadata updates in state', () => {
    const withClient = addClient(createInitialState(), 'Amanda Example');
    const client = withClient.clients[0];

    const updated = upsertAccountMeta(withClient, client.id, 'ACC1', {
      accountType: 'Funded',
      status: 'Active',
    });

    expect(updated.clients[0].accountRegistry.ACC1).toMatchObject({
      accountName: 'ACC1',
      accountType: 'Funded',
      status: 'Active',
    });
  });

  it('appends daily imports and returns the latest import by timestamp', () => {
    const state = addClient(createInitialState(), 'Amanda Example');
    const clientId = state.clients[0].id;
    const firstImport = { id: 'one', date: '2026-06-08', importedAt: '2026-06-08T10:00:00.000Z', accounts: {} };
    const secondImport = { id: 'two', date: '2026-06-09', importedAt: '2026-06-09T10:00:00.000Z', accounts: {} };

    const withFirst = appendDailyImport(state, clientId, firstImport);
    const withSecond = appendDailyImport(withFirst, clientId, secondImport);

    expect(getLatestClientImport(withSecond.clients[0])).toMatchObject({ id: 'two' });
  });
});
