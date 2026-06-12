import { describe, expect, it } from 'vitest';
import {
  addClient,
  appendDailyImport,
  getLatestClientImport,
  parseImportedState,
  upsertAccountMeta,
} from './demoStore';

function emptyState() {
  return {
    accountManager: { id: 'am-test', name: 'Test AM' },
    clients: [],
    selectedClientId: null,
  };
}

describe('demoStore', () => {
  it('creates clients and persists account metadata updates in state', () => {
    const withClient = addClient(emptyState(), 'Amanda Example');
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
    const state = addClient(emptyState(), 'Amanda Example');
    const clientId = state.clients[0].id;
    const firstImport = { id: 'one', date: '2026-06-08', importedAt: '2026-06-08T10:00:00.000Z', accounts: {} };
    const secondImport = { id: 'two', date: '2026-06-09', importedAt: '2026-06-09T10:00:00.000Z', accounts: {} };

    const withFirst = appendDailyImport(state, clientId, firstImport);
    const withSecond = appendDailyImport(withFirst, clientId, secondImport);

    expect(getLatestClientImport(withSecond.clients[0])).toMatchObject({ id: 'two' });
  });

  it('round-trips an exported backup through parseImportedState', () => {
    const state = addClient(emptyState(), 'Amanda Example');
    const restored = parseImportedState(JSON.stringify(state));

    expect(restored.clients[0].name).toBe('Amanda Example');
    expect(restored.selectedClientId).toBe(state.clients[0].id);
  });

  it('rejects files that are not valid CAM backups', () => {
    expect(() => parseImportedState('{"foo":1}')).toThrow();
    expect(() => parseImportedState('not json')).toThrow();
  });
});
