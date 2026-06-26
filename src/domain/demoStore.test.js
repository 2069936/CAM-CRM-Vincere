import { describe, expect, it } from 'vitest';
import {
  addActivityEntry,
  addClient,
  addTask,
  appendDailyImport,
  deleteActivityEntry,
  deleteTask,
  getLatestClientImport,
  parseImportedState,
  removeAccountFromRegistry,
  removeClient,
  resolveFlagInImport,
  transferClient,
  updateTask,
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

  it('appendDailyImport does not create duplicate registry keys when NT CSV casing differs from stored casing', () => {
    // Reproduce the root-cause bug: registry has 'APEX1234' but CSV exports 'apex1234'
    let state = addClient(emptyState(), 'Test Trader');
    const clientId = state.clients[0].id;
    state = { ...state, clients: state.clients.map(c => c.id === clientId
      ? { ...c, accountRegistry: { APEX1234: { accountName: 'APEX1234', accountType: 'Funded', alias: 'My Account' } } }
      : c) };

    const importResult = {
      id: 'imp-1', date: '2026-06-25', importedAt: '2026-06-25T22:00:00Z',
      accounts: { apex1234: { accountName: 'apex1234', accountType: 'Funded' } },
      snapshots: [], strategies: [], orders: [], executions: [], flags: [],
    };

    const next = appendDailyImport(state, clientId, importResult);
    const reg = next.clients[0].accountRegistry;
    const keys = Object.keys(reg);

    // Must not have both 'APEX1234' and 'apex1234' — only one entry
    expect(keys.length).toBe(1);
    // User-configured alias must be preserved (registry takes precedence over import)
    expect(Object.values(reg)[0].alias).toBe('My Account');
  });

  it('upsertAccountMeta merges with existing entry case-insensitively without duplicating keys', () => {
    let state = addClient(emptyState(), 'Test Trader');
    const clientId = state.clients[0].id;
    // Pre-seed with uppercase key
    state = upsertAccountMeta(state, clientId, 'APEX1234', { accountType: 'Funded', alias: 'Original' });
    // Update using lowercase — should update, not create a second key
    const next = upsertAccountMeta(state, clientId, 'apex1234', { alias: 'Updated' });
    const reg = next.clients[0].accountRegistry;
    expect(Object.keys(reg).length).toBe(1);
    expect(Object.values(reg)[0].alias).toBe('Updated');
  });

  it('upsertAccountMeta coerces string numeric fields to numbers on save', () => {
    let state = addClient(emptyState(), 'Test Trader');
    const clientId = state.clients[0].id;
    // Simulate HTML input saving strings (event.target.value always returns string)
    const next = upsertAccountMeta(state, clientId, 'ACC1', {
      accountType: 'Funded',
      targetProfit: '52000',
      maxDrawdownLimit: '2500',
      startBalance: '50000',
    });
    const reg = next.clients[0].accountRegistry.ACC1;
    expect(typeof reg.targetProfit).toBe('number');
    expect(typeof reg.maxDrawdownLimit).toBe('number');
    expect(typeof reg.startBalance).toBe('number');
    expect(reg.targetProfit).toBe(52000);
    expect(reg.maxDrawdownLimit).toBe(2500);
    expect(reg.startBalance).toBe(50000);
  });
});

// ── Flag resolution ────────────────────────────────────────────────────────────

describe('resolveFlagInImport', () => {
  function stateWithFlag() {
    let s = addClient(emptyState(), 'Test Trader');
    const clientId = s.clients[0].id;
    s = appendDailyImport(s, clientId, {
      id: 'imp-1', date: '2026-06-25', importedAt: '2026-06-25T12:00:00Z',
      accounts: {}, snapshots: [], flags: [
        { id: 'flag-1', severity: 'Critical', status: 'Open', message: 'Drawdown breached' },
        { id: 'flag-2', severity: 'Warning', status: 'Open', message: 'Consistency warning' },
      ],
    });
    return { state: s, clientId };
  }

  it('sets flag status to Resolved', () => {
    const { state, clientId } = stateWithFlag();
    const next = resolveFlagInImport(state, clientId, 'imp-1', 'flag-1', 'Resolved');
    const flag = next.clients[0].dailyImports[0].flags.find(f => f.id === 'flag-1');
    expect(flag.status).toBe('Resolved');
    expect(flag.resolvedAt).toBeTruthy();
  });

  it('sets flag status to Acknowledged without affecting other flags', () => {
    const { state, clientId } = stateWithFlag();
    const next = resolveFlagInImport(state, clientId, 'imp-1', 'flag-1', 'Acknowledged');
    const flags = next.clients[0].dailyImports[0].flags;
    expect(flags.find(f => f.id === 'flag-1').status).toBe('Acknowledged');
    expect(flags.find(f => f.id === 'flag-2').status).toBe('Open');
  });
});

// ── Task CRUD ─────────────────────────────────────────────────────────────────

describe('task CRUD', () => {
  function stateWithClient() {
    const s = addClient(emptyState(), 'Test Trader');
    return { state: s, clientId: s.clients[0].id };
  }

  it('addTask appends a task to the client', () => {
    const { state, clientId } = stateWithClient();
    const task = { id: 't1', text: 'Call client', done: false, dueDate: '2026-06-30' };
    const next = addTask(state, clientId, task);
    expect(next.clients[0].tasks).toHaveLength(1);
    expect(next.clients[0].tasks[0].text).toBe('Call client');
  });

  it('updateTask marks a task done', () => {
    const { state, clientId } = stateWithClient();
    const task = { id: 't1', text: 'Send report', done: false };
    const withTask = addTask(state, clientId, task);
    const next = updateTask(withTask, clientId, 't1', { done: true });
    expect(next.clients[0].tasks[0].done).toBe(true);
  });

  it('deleteTask removes only the target task', () => {
    let { state, clientId } = stateWithClient();
    state = addTask(state, clientId, { id: 't1', text: 'First', done: false });
    state = addTask(state, clientId, { id: 't2', text: 'Second', done: false });
    const next = deleteTask(state, clientId, 't1');
    const tasks = next.clients[0].tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t2');
  });
});

// ── Activity log ──────────────────────────────────────────────────────────────

describe('activity log', () => {
  function stateWithClient() {
    const s = addClient(emptyState(), 'Test Trader');
    return { state: s, clientId: s.clients[0].id };
  }

  it('addActivityEntry prepends entry (newest first)', () => {
    const { state, clientId } = stateWithClient();
    let s = addActivityEntry(state, clientId, { id: 'e1', text: 'First entry', createdAt: '2026-06-24T10:00:00Z' });
    s = addActivityEntry(s, clientId, { id: 'e2', text: 'Second entry', createdAt: '2026-06-25T10:00:00Z' });
    expect(s.clients[0].activityLog[0].id).toBe('e2');
    expect(s.clients[0].activityLog[1].id).toBe('e1');
  });

  it('deleteActivityEntry removes only the matching entry', () => {
    const { state, clientId } = stateWithClient();
    let s = addActivityEntry(state, clientId, { id: 'e1', text: 'Keep me', createdAt: '2026-06-24T10:00:00Z' });
    s = addActivityEntry(s, clientId, { id: 'e2', text: 'Delete me', createdAt: '2026-06-25T10:00:00Z' });
    const next = deleteActivityEntry(s, clientId, 'e2');
    const log = next.clients[0].activityLog;
    expect(log).toHaveLength(1);
    expect(log[0].id).toBe('e1');
  });
});

// ── Client management ─────────────────────────────────────────────────────────

describe('removeClient', () => {
  it('removes a client from state and clears selectedClientId', () => {
    let state = addClient(emptyState(), 'Amanda');
    state = addClient(state, 'Pedro');
    const id = state.clients[0].id;
    const next = removeClient(state, id);
    expect(next.clients.map(c => c.name)).not.toContain('Amanda');
    expect(next.selectedClientId).not.toBe(id);
  });
});

describe('transferClient', () => {
  it('moves a client from one CAM to another', () => {
    let state = {
      ...emptyState(),
      camProfiles: [
        { id: 'cam-a', name: 'CAM A', clientIds: [] },
        { id: 'cam-b', name: 'CAM B', clientIds: [] },
      ],
    };
    state = addClient(state, 'Test Client', 'cam-a');
    const clientId = state.clients[0].id;
    const next = transferClient(state, clientId, 'cam-b');
    const camA = next.camProfiles.find(c => c.id === 'cam-a');
    const camB = next.camProfiles.find(c => c.id === 'cam-b');
    expect(camA.clientIds).not.toContain(clientId);
    expect(camB.clientIds).toContain(clientId);
  });
});

// ── removeAccountFromRegistry ─────────────────────────────────────────────────

describe('removeAccountFromRegistry', () => {
  it('removes the account using case-insensitive key lookup', () => {
    let state = addClient(emptyState(), 'Test Trader');
    const clientId = state.clients[0].id;
    state = upsertAccountMeta(state, clientId, 'APEX1234', { accountType: 'Funded' });
    const next = removeAccountFromRegistry(state, clientId, 'apex1234'); // lowercase
    expect(next.clients[0].accountRegistry).not.toHaveProperty('APEX1234');
  });
});
