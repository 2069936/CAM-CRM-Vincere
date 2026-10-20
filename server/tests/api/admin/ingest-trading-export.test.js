import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import { createTradingExportAdminStore } from '../../../apiLib/tradingExportStore.js';
import {
  createHandler,
  parseTradingExportBody,
  publicTradingExport,
  splitTradingExportRequest,
  summarizeDevices,
} from '../../../autoCollection/admin/ingest-trading-export.js';
import { FIRST_SLIM_EXPORT_AGENT } from '../../../../src/domain/tradingExport.js';

/* POST /api/admin/ingest-trading-export, the Manager's half of a slim trading
 * export. Manager only; { action, ... } with exactly the keys each action
 * takes. request never asks an agent older than FIRST_SLIM_EXPORT_AGENT and
 * counts it in needsVps; list and listAll expire what is past its 14 days
 * (storage first, then the row); download signs a URL for five minutes and
 * audits it; delete removes the object, then marks the request expired. */

const ACTOR = { id: '99999999-9999-4999-8999-999999999999', role: 'Manager', status: 'Active' };
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const PATH = `deep-exports/${CLIENT_ID}/${REQUEST_ID}.jsonl.gz`;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const ALL = ['executions', 'orders', 'strategies', 'trades'];
const id = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rid = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function exportRow(overrides = {}) {
  return {
    id: REQUEST_ID, device_id: id(1), client_id: CLIENT_ID, requested_by: ACTOR.id,
    requested_at: '2026-10-19T14:00:00.000Z', from_date: null, to_date: null, datasets: ALL,
    status: 'ready', error_code: null, storage_path: PATH, byte_size: 831488, sha256: 'a'.repeat(64),
    row_counts: { executions: 2140, orders: 900, strategies: 12, trades: 610 },
    covered_from: '2026-07-01', covered_to: '2026-10-19', started_at: '2026-10-19T14:01:00.000Z',
    completed_at: '2026-10-19T14:05:00.000Z', expires_at: '2026-11-02T14:05:00.000Z', updated_at: '2026-10-19T14:05:00.000Z',
    ...overrides,
  };
}

function deviceRow(n, overrides = {}) {
  return { id: id(n), client_id: CLIENT_ID, status: 'active', revoked_at: null, agent_version: '1.4.0', ...overrides };
}

function makeStore(overrides = {}) {
  const log = [];
  const calls = {};
  const record = (name, payload) => { log.push(name); (calls[name] ||= []).push(payload); };
  const store = {
    log,
    calls,
    async loadDevices(deviceIds) { record('loadDevices', deviceIds); return overrides.loadDevices ? overrides.loadDevices(deviceIds) : deviceIds.map((deviceId) => deviceRow(0, { id: deviceId })); },
    async request(payload) { record('request', payload); return overrides.request ? overrides.request(payload) : payload.deviceIds.length; },
    async cancel(payload) { record('cancel', payload); return overrides.cancel ? overrides.cancel(payload) : payload.requestIds.map((requestId) => ({ id: requestId, path: null })); },
    async close(payload) { record('close', payload); return overrides.close ? overrides.close(payload) : payload.requestIds; },
    async listForClient(clientId) { record('listForClient', clientId); return overrides.listForClient ? overrides.listForClient(clientId) : [exportRow()]; },
    async listAll(payload) { record('listAll', payload); return overrides.listAll ? overrides.listAll(payload) : { rows: [exportRow()], total: 1 }; },
    async loadRequest(requestId) { record('loadRequest', requestId); return overrides.loadRequest ? overrides.loadRequest(requestId) : exportRow(); },
    async dueForExpiry(payload) { record('dueForExpiry', payload); return overrides.dueForExpiry ? overrides.dueForExpiry(payload) : []; },
    async activeDevices() { record('activeDevices', null); return overrides.activeDevices ? overrides.activeDevices() : []; },
    async exportSummaries() { record('exportSummaries', null); return overrides.exportSummaries ? overrides.exportSummaries() : []; },
    async clientNames(ids) { record('clientNames', ids); return new Map([[CLIENT_ID, 'Gray Elm'], [OTHER_CLIENT, 'Blue Oak']]); },
    async signDownload(...args) { record('signDownload', args); return overrides.signDownload ? overrides.signDownload(...args) : 'https://storage.example.test/object/sign/x?token=t'; },
    async removeObjects(paths) { record('removeObjects', paths); return overrides.removeObjects ? overrides.removeObjects(paths) : undefined; },
    async auditDownload(payload) { record('auditDownload', payload); return overrides.auditDownload ? overrides.auditDownload(payload) : undefined; },
  };
  return store;
}

function setup({ store = makeStore(), authorize, report = vi.fn() } = {}) {
  const authorizeCalls = [];
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: authorize || (async (req, options) => { authorizeCalls.push(options); return ACTOR; }),
    createStore: () => store,
    now: () => NOW,
    report,
  });
  return { handler, store, authorizeCalls, report };
}

async function post(handler, body, overrides = {}) {
  const res = response();
  await handler({ method: 'POST', headers: {}, body, ...overrides }, res);
  return res;
}

const quietly = async (fn) => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    errors.mockRestore();
  }
};

/* ── The body ─────────────────────────────────────────────────────────────── */

describe('the request body: exact keys per action', () => {
  it('request: ids lower cased, datasets all four by default and in the contract\'s order', () => {
    expect(parseTradingExportBody({ action: 'request', deviceIds: [id(1).toUpperCase()] }))
      .toEqual({ action: 'request', deviceIds: [id(1)], from: null, to: null, datasets: ALL });
    expect(parseTradingExportBody({ action: 'request', deviceIds: [id(1)], from: '2026-07-01', to: '2026-07-01', datasets: ['trades', 'orders'] }))
      .toEqual({ action: 'request', deviceIds: [id(1)], from: '2026-07-01', to: '2026-07-01', datasets: ['orders', 'trades'] });
    expect(parseTradingExportBody({ action: 'request', deviceIds: [id(1)], from: null, to: null, datasets: null }).datasets).toEqual(ALL);
  });

  it('the other actions', () => {
    expect(parseTradingExportBody({ action: 'cancel', requestIds: [rid(1)] })).toEqual({ action: 'cancel', requestIds: [rid(1)] });
    expect(parseTradingExportBody({ action: 'list', clientId: CLIENT_ID })).toEqual({ action: 'list', clientId: CLIENT_ID });
    expect(parseTradingExportBody({ action: 'listAll' })).toEqual({ action: 'listAll', limit: 50, offset: 0, status: null });
    expect(parseTradingExportBody({ action: 'listAll', limit: 200, offset: 400, status: 'ready' })).toEqual({ action: 'listAll', limit: 200, offset: 400, status: 'ready' });
    expect(parseTradingExportBody({ action: 'devices' })).toEqual({ action: 'devices' });
    expect(parseTradingExportBody({ action: 'download', requestId: REQUEST_ID })).toEqual({ action: 'download', requestId: REQUEST_ID });
    expect(parseTradingExportBody({ action: 'delete', requestId: REQUEST_ID })).toEqual({ action: 'delete', requestId: REQUEST_ID });
  });

  it('takes 300 ids, the most one request carries', () => {
    expect(parseTradingExportBody({ action: 'request', deviceIds: Array.from({ length: 300 }, (_, n) => id(n)) }).deviceIds).toHaveLength(300);
  });

  it.each([
    ['no action', { deviceIds: [id(1)] }],
    ['an unknown action', { action: 'export', deviceIds: [id(1)] }],
    ['an action that is not a string', { action: ['download'], requestId: REQUEST_ID }],
    ['an action from the prototype', { action: 'toString' }],
    ['request with an extra key', { action: 'request', deviceIds: [id(1)], version: '1.4.0' }],
    ['request with a key of another action', { action: 'request', deviceIds: [id(1)], requestId: REQUEST_ID }],
    ['request with no ids', { action: 'request' }],
    ['an empty list', { action: 'request', deviceIds: [] }],
    ['301 ids', { action: 'request', deviceIds: Array.from({ length: 301 }, (_, n) => id(n)) }],
    ['a duplicate in another case', { action: 'request', deviceIds: [id(1), id(1).toUpperCase()] }],
    ['a non uuid', { action: 'request', deviceIds: ['device-1'] }],
    ['a date that is not one', { action: 'request', deviceIds: [id(1)], from: '2026-02-30' }],
    ['a date in another shape', { action: 'request', deviceIds: [id(1)], to: '10/19/2026' }],
    ['from after to', { action: 'request', deviceIds: [id(1)], from: '2026-10-20', to: '2026-10-19' }],
    ['no datasets', { action: 'request', deviceIds: [id(1)], datasets: [] }],
    ['an unknown dataset', { action: 'request', deviceIds: [id(1)], datasets: ['fills'] }],
    ['a dataset twice', { action: 'request', deviceIds: [id(1)], datasets: ['orders', 'orders'] }],
    ['cancel with no ids', { action: 'cancel', requestIds: [] }],
    ['list without a client', { action: 'list' }],
    ['list with a bad client', { action: 'list', clientId: 'gray-elm' }],
    ['listAll with a limit of 0', { action: 'listAll', limit: 0 }],
    ['listAll with a limit of 201', { action: 'listAll', limit: 201 }],
    ['listAll with a negative offset', { action: 'listAll', offset: -1 }],
    ['listAll with a limit as text', { action: 'listAll', limit: '50' }],
    ['listAll with an unknown status', { action: 'listAll', status: 'done' }],
    ['listAll with a client', { action: 'listAll', clientId: CLIENT_ID }],
    ['devices with an extra key', { action: 'devices', all: true }],
    ['download without an id', { action: 'download' }],
    ['delete with two ids', { action: 'delete', requestIds: [REQUEST_ID] }],
    ['an array body', [{ action: 'devices' }]],
    ['null', null],
  ])('refuses %s with 400 invalid_request', (_label, value) => {
    expect(() => parseTradingExportBody(value)).toThrow('invalid_request');
  });
});

/* ── Who may call it ─────────────────────────────────────────────────────── */

describe('Manager only', () => {
  it('asks requireAppUser for the Manager role and nothing wider, before the body is read', async () => {
    const authorize = vi.fn(async () => { throw new ApiError(403, 'Manager permission required.'); });
    const { handler, store } = setup({ authorize });
    const res = await post(handler, 'not json');
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roles: ['Manager'] }));
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(store.log).toEqual([]);
  });

  it('every action is decided with roles exactly [\'Manager\']', async () => {
    const { handler, authorizeCalls } = setup();
    for (const body of [{ action: 'devices' }, { action: 'listAll' }, { action: 'download', requestId: REQUEST_ID }]) {
      await post(handler, body);
    }
    expect(authorizeCalls.map((options) => options.roles)).toEqual([['Manager'], ['Manager'], ['Manager']]);
  });

  it('only takes POST', async () => {
    const { handler, store } = setup();
    expect((await post(handler, { action: 'devices' }, { method: 'GET' })).statusCode).toBe(405);
    expect(store.log).toEqual([]);
  });

  it('refuses a malformed body with 400 before touching the store', async () => {
    const { handler, store } = setup();
    expect(await post(handler, { action: 'request', deviceIds: Array.from({ length: 301 }, (_, n) => id(n)) }))
      .toMatchObject({ statusCode: 400, body: { error: 'invalid_request' } });
    expect(store.log).toEqual([]);
  });
});

/* ── request ──────────────────────────────────────────────────────────────── */

describe('request', () => {
  it(`asks only agents at ${FIRST_SLIM_EXPORT_AGENT} or later, counts the older ones in needsVps, and answers the counts`, async () => {
    const rows = [
      deviceRow(1, { agent_version: '1.4.0' }),
      deviceRow(2, { agent_version: '1.10.0' }),
      deviceRow(3, { agent_version: '1.3.1' }),
      deviceRow(4, { agent_version: null }),
      deviceRow(5, { agent_version: '1.4.0', status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' }),
      deviceRow(6, { agent_version: '1.4.0.1' }),
    ];
    const store = makeStore({ loadDevices: () => rows, request: () => 2 });
    const { handler } = setup({ store });
    const res = await post(handler, { action: 'request', deviceIds: rows.map((row) => row.id), from: '2026-07-01', datasets: ['trades'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, requested: 2, skipped: 4, needsVps: 2 });
    expect(store.calls.request).toEqual([{ deviceIds: [id(1), id(2), id(6)], from: '2026-07-01', to: null, datasets: ['trades'], actorId: ACTOR.id }]);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('does not call the database when nothing is left to ask', async () => {
    const store = makeStore({ loadDevices: () => [deviceRow(1, { agent_version: '1.3.1' })] });
    const { handler } = setup({ store });
    expect((await post(handler, { action: 'request', deviceIds: [id(1)] })).body).toEqual({ ok: true, requested: 0, skipped: 1, needsVps: 1 });
    expect(store.calls.request).toBeUndefined();
  });

  it('splits by status, revocation and version, nothing else', () => {
    expect(splitTradingExportRequest([
      deviceRow(1), deviceRow(2, { agent_version: '1.3.9' }), deviceRow(3, { revoked_at: '2026-10-01T00:00:00Z' }),
      deviceRow(4, { status: 'revoked' }), deviceRow(5, { agent_version: 'latest' }),
    ])).toEqual({ sendable: [id(1)], needsVps: 2 });
  });
});

/* ── cancel ───────────────────────────────────────────────────────────────── */

describe('cancel', () => {
  it('cancels as the signed in Manager, counts it, and removes what an upload had reached', async () => {
    const store = makeStore({ cancel: () => [{ id: rid(1), path: PATH }, { id: rid(2), path: null }] });
    const { handler } = setup({ store });
    const res = await post(handler, { action: 'cancel', requestIds: [rid(1), rid(2), rid(3)] });
    expect(res.body).toEqual({ ok: true, cancelled: 2 });
    expect(store.calls.cancel).toEqual([{ requestIds: [rid(1), rid(2), rid(3)], actorId: ACTOR.id }]);
    expect(store.calls.removeObjects).toEqual([[PATH]]);
  });

  it('a storage fault while removing is reported, and the cancel still stands', async () => {
    const store = makeStore({ cancel: () => [{ id: rid(1), path: PATH }], removeObjects: () => { throw new Error('storage down'); } });
    const { handler, report } = setup({ store });
    expect((await post(handler, { action: 'cancel', requestIds: [rid(1)] })).body).toEqual({ ok: true, cancelled: 1 });
    expect(report).toHaveBeenCalledTimes(1);
  });
});

/* ── list and listAll, and the lazy expiry ───────────────────────────────── */

describe('list and listAll', () => {
  it('list: the client\'s exports, without the storage path or the digest', async () => {
    const { handler, store } = setup();
    const res = await post(handler, { action: 'list', clientId: CLIENT_ID });
    expect(res.statusCode).toBe(200);
    expect(store.calls.listForClient).toEqual([CLIENT_ID]);
    expect(res.body.exports).toEqual([{
      id: REQUEST_ID, deviceId: id(1), clientId: CLIENT_ID, clientName: 'Gray Elm', requestedAt: '2026-10-19T14:00:00.000Z',
      fromDate: null, toDate: null, datasets: ALL, status: 'ready', errorCode: null, byteSize: 831488,
      rowCounts: { executions: 2140, orders: 900, strategies: 12, trades: 610 }, coveredFrom: '2026-07-01', coveredTo: '2026-10-19',
      startedAt: '2026-10-19T14:01:00.000Z', completedAt: '2026-10-19T14:05:00.000Z', expiresAt: '2026-11-02T14:05:00.000Z', updatedAt: '2026-10-19T14:05:00.000Z',
    }]);
    expect(JSON.stringify(res.body)).not.toContain('deep-exports');
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));
  });

  it('list: removes the files of the client\'s exports past expiry FIRST, then marks them expired with no actor', async () => {
    const store = makeStore({ dueForExpiry: () => [{ id: rid(1), storage_path: PATH }] });
    const { handler } = setup({ store });
    await post(handler, { action: 'list', clientId: CLIENT_ID });
    expect(store.calls.dueForExpiry).toEqual([{ clientId: CLIENT_ID, nowIso: NOW.toISOString(), limit: 100 }]);
    expect(store.calls.removeObjects).toEqual([[PATH]]);
    expect(store.calls.close).toEqual([{ requestIds: [rid(1)], actorId: null, reason: 'expired' }]);
    expect(store.log.indexOf('removeObjects')).toBeLessThan(store.log.indexOf('close'));
    expect(store.log.indexOf('close')).toBeLessThan(store.log.indexOf('listForClient'));
  });

  it('a storage fault during the sweep closes nothing, is reported, and still shows the lapsed export as expired', async () => {
    const lapsed = exportRow({ expires_at: '2026-10-20T14:59:59.000Z' });
    const store = makeStore({
      dueForExpiry: () => [{ id: REQUEST_ID, storage_path: PATH }],
      removeObjects: () => { throw new Error('storage down'); },
      listForClient: () => [lapsed],
    });
    const { handler, report } = setup({ store });
    const res = await post(handler, { action: 'list', clientId: CLIENT_ID });
    expect(res.statusCode).toBe(200);
    expect(store.calls.close).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(res.body.exports[0].status).toBe('expired');
  });

  it('a ready export one second before its expiry is still ready', () => {
    const row = exportRow({ expires_at: '2026-10-20T15:00:01.000Z' });
    expect(publicTradingExport(row, new Map(), NOW.getTime()).status).toBe('ready');
    expect(publicTradingExport({ ...row, expires_at: NOW.toISOString() }, new Map(), NOW.getTime()).status).toBe('expired');
  });

  it('listAll: sweeps every client, then pages newest first and says how many there are', async () => {
    const store = makeStore({
      dueForExpiry: () => [],
      listAll: () => ({ rows: [exportRow(), exportRow({ id: rid(2), client_id: OTHER_CLIENT, status: 'building' })], total: 120 }),
    });
    const { handler } = setup({ store });
    const res = await post(handler, { action: 'listAll', limit: 2, offset: 40, status: null });
    expect(store.calls.dueForExpiry).toEqual([{ clientId: null, nowIso: NOW.toISOString(), limit: 100 }]);
    expect(store.calls.listAll).toEqual([{ action: 'listAll', limit: 2, offset: 40, status: null }]);
    expect(res.body).toMatchObject({ ok: true, total: 120, limit: 2, offset: 40 });
    expect(res.body.exports.map((row) => [row.clientName, row.status])).toEqual([['Gray Elm', 'ready'], ['Blue Oak', 'building']]);
  });

  it('before step 72: 404 trading_export_unavailable', async () => {
    const unavailable = () => { throw new ApiError(404, 'trading_export_unavailable'); };
    for (const body of [{ action: 'listAll' }, { action: 'list', clientId: CLIENT_ID }, { action: 'devices' }]) {
      const { handler } = setup({ store: makeStore({ dueForExpiry: unavailable, exportSummaries: unavailable }) });
      expect(await post(handler, body)).toMatchObject({ statusCode: 404, body: { error: 'trading_export_unavailable' } });
    }
  });
});

/* ── devices ──────────────────────────────────────────────────────────────── */

describe('devices', () => {
  it('lists every paired active device with its client, agent, eligibility, last ready export and open export', async () => {
    const store = makeStore({
      activeDevices: () => [
        { id: id(1), client_id: CLIENT_ID, agent_version: '1.4.0', last_seen_at: '2026-10-20T14:59:00.000Z' },
        { id: id(2), client_id: OTHER_CLIENT, agent_version: '1.3.1', last_seen_at: null },
      ],
      exportSummaries: () => [
        { device_id: id(1), status: 'building', completed_at: null, covered_to: null },
        { device_id: id(1), status: 'expired', completed_at: '2026-09-01T10:00:00.000Z', covered_to: '2026-08-31' },
        { device_id: id(1), status: 'ready', completed_at: '2026-10-01T10:00:00.000Z', covered_to: '2026-09-30' },
      ],
    });
    const { handler } = setup({ store });
    const res = await post(handler, { action: 'devices' });
    expect(res.body).toEqual({
      ok: true,
      minimumAgentVersion: '1.4.0',
      devices: [
        { id: id(2), clientId: OTHER_CLIENT, clientName: 'Blue Oak', agentVersion: '1.3.1', lastSeenAt: null, eligible: false, lastReadyExportAt: null, lastReadyCoveredTo: null, openStatus: null },
        { id: id(1), clientId: CLIENT_ID, clientName: 'Gray Elm', agentVersion: '1.4.0', lastSeenAt: '2026-10-20T14:59:00.000Z', eligible: true, lastReadyExportAt: '2026-10-01T10:00:00.000Z', lastReadyCoveredTo: '2026-09-30', openStatus: 'building' },
      ],
    });
  });

  it('a device with no version is not eligible', () => {
    expect(summarizeDevices([{ id: id(1), client_id: CLIENT_ID, agent_version: null }], [], new Map())[0].eligible).toBe(false);
  });
});

/* ── download ─────────────────────────────────────────────────────────────── */

describe('download', () => {
  it('signs a five minute URL that saves as <client>_<from>_<to>.jsonl.gz, audits it as the Manager, and answers both', async () => {
    const { handler, store } = setup();
    const res = await post(handler, { action: 'download', requestId: REQUEST_ID });
    expect(res.body).toEqual({
      ok: true,
      url: 'https://storage.example.test/object/sign/x?token=t',
      fileName: 'Gray-Elm_2026-07-01_2026-10-19.jsonl.gz',
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    expect(store.calls.signDownload).toEqual([[PATH, 300, 'Gray-Elm_2026-07-01_2026-10-19.jsonl.gz']]);
    expect(store.calls.auditDownload).toEqual([{ actorId: ACTOR.id, requestId: REQUEST_ID, clientId: CLIENT_ID, deviceId: id(1), byteSize: 831488 }]);
  });

  it('refuses an export that is gone, not ready, or past its expiry, and signs nothing', async () => {
    for (const [row, status, code] of [
      [null, 404, 'export_not_found'],
      [exportRow({ status: 'building', storage_path: null }), 409, 'export_not_ready'],
      [exportRow({ status: 'failed', error_code: 'disk_full' }), 409, 'export_not_ready'],
      [exportRow({ status: 'expired' }), 410, 'export_expired'],
      [exportRow({ expires_at: '2026-10-20T14:59:59.000Z' }), 410, 'export_expired'],
    ]) {
      const { handler, store } = setup({ store: makeStore({ loadRequest: () => row }) });
      expect(await post(handler, { action: 'download', requestId: REQUEST_ID }), code).toMatchObject({ statusCode: status, body: { error: code } });
      expect(store.calls.signDownload).toBeUndefined();
      expect(store.calls.auditDownload).toBeUndefined();
    }
  });

  it('an export found past its expiry is expired on the spot: file first, then the row', async () => {
    const store = makeStore({
      loadRequest: () => exportRow({ expires_at: '2026-10-20T14:59:59.000Z' }),
      dueForExpiry: () => [{ id: REQUEST_ID, storage_path: PATH }],
    });
    const { handler } = setup({ store });
    await post(handler, { action: 'download', requestId: REQUEST_ID });
    expect(store.calls.dueForExpiry).toEqual([{ clientId: CLIENT_ID, nowIso: NOW.toISOString(), limit: 100 }]);
    expect(store.log.slice(-2)).toEqual(['removeObjects', 'close']);
  });

  it('no URL leaves without its audit row', async () => {
    await quietly(async () => {
      const { handler } = setup({ store: makeStore({ auditDownload: () => { throw Object.assign(new Error('insert failed'), { code: '42501' }); } }) });
      const res = await post(handler, { action: 'download', requestId: REQUEST_ID });
      expect(res).toMatchObject({ statusCode: 500, body: { error: 'trading_export_failed' } });
      expect(res.body.url).toBeUndefined();
    });
  });
});

/* ── delete ───────────────────────────────────────────────────────────────── */

describe('delete', () => {
  it('removes the object, then marks the request expired as the Manager', async () => {
    const { handler, store } = setup();
    expect((await post(handler, { action: 'delete', requestId: REQUEST_ID })).body).toEqual({ ok: true, deleted: true });
    expect(store.calls.removeObjects).toEqual([[PATH]]);
    expect(store.calls.close).toEqual([{ requestIds: [REQUEST_ID], actorId: ACTOR.id, reason: 'deleted' }]);
    expect(store.log.indexOf('removeObjects')).toBeLessThan(store.log.indexOf('close'));
  });

  it('a storage fault leaves the row ready to try again', async () => {
    await quietly(async () => {
      const { handler, store } = setup({ store: makeStore({ removeObjects: () => { throw new Error('storage down'); } }) });
      expect((await post(handler, { action: 'delete', requestId: REQUEST_ID })).statusCode).toBe(500);
      expect(store.calls.close).toBeUndefined();
    });
  });

  it('refuses one that is not ready', async () => {
    const { handler, store } = setup({ store: makeStore({ loadRequest: () => exportRow({ status: 'uploading' }) }) });
    expect(await post(handler, { action: 'delete', requestId: REQUEST_ID })).toMatchObject({ statusCode: 409, body: { error: 'export_not_ready' } });
    expect(store.calls.removeObjects).toBeUndefined();
  });
});

it('does not hand a database error to the browser', async () => {
  await quietly(async () => {
    const { handler } = setup({ store: makeStore({ request: () => { throw Object.assign(new Error('permission denied for table secret'), { code: '42501' }); } }) });
    const res = await post(handler, { action: 'request', deviceIds: [id(1)] });
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'trading_export_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

/* ── The store, against step 72's functions and Supabase storage ─────────── */

function fakeAdmin({ rpc = {}, query = { data: [], error: null, count: null }, storage = {} } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push(['rpc', name, args]); return rpc[name] || { data: null, error: null }; },
    from(table) {
      const chain = {
        select(columns, options) { calls.push(['select', table, columns, options]); return chain; },
        eq(column, value) { calls.push(['eq', column, value]); return chain; },
        lte(column, value) { calls.push(['lte', column, value]); return chain; },
        in(column, values) { calls.push(['in', column, values]); return chain; },
        is(column, value) { calls.push(['is', column, value]); return chain; },
        order(column, options) { calls.push(['order', column, options]); return chain; },
        limit(n) { calls.push(['limit', n]); return chain; },
        range(from, to) { calls.push(['range', from, to]); return chain; },
        async maybeSingle() { return query; },
        async insert(row) { calls.push(['insert', table, row]); return { error: null }; },
        then(resolve, reject) { return Promise.resolve(query).then(resolve, reject); },
      };
      return chain;
    },
    storage: {
      from(bucket) {
        return {
          async createSignedUrl(path, seconds, options) { calls.push(['createSignedUrl', bucket, path, seconds, options]); return storage.sign || { data: { signedUrl: 'https://s/d' }, error: null }; },
          async remove(paths) { calls.push(['remove', bucket, paths]); return { data: [], error: null }; },
        };
      },
    },
  };
}

describe('the Manager store', () => {
  it('requests through request_trading_exports with the five arguments and reads the count', async () => {
    const db = fakeAdmin({ rpc: { request_trading_exports: { data: 2, error: null } } });
    await expect(createTradingExportAdminStore(db).request({ deviceIds: [id(1)], from: null, to: '2026-10-19', datasets: ALL, actorId: ACTOR.id })).resolves.toBe(2);
    expect(db.calls).toEqual([['rpc', 'request_trading_exports', { p_device_ids: [id(1)], p_from: null, p_to: '2026-10-19', p_datasets: ALL, p_actor: ACTOR.id }]]);
  });

  it('cancels and closes through their functions', async () => {
    const db = fakeAdmin({ rpc: {
      cancel_trading_exports: { data: [{ request_id: rid(1), object_path: PATH }], error: null },
      close_trading_exports: { data: [{ request_id: rid(1) }], error: null },
    } });
    const store = createTradingExportAdminStore(db);
    await expect(store.cancel({ requestIds: [rid(1)], actorId: ACTOR.id })).resolves.toEqual([{ id: rid(1), path: PATH }]);
    await expect(store.close({ requestIds: [rid(1)], actorId: null, reason: 'expired' })).resolves.toEqual([rid(1)]);
    expect(db.calls).toEqual([
      ['rpc', 'cancel_trading_exports', { p_request_ids: [rid(1)], p_actor: ACTOR.id }],
      ['rpc', 'close_trading_exports', { p_request_ids: [rid(1)], p_actor: null, p_reason: 'expired' }],
    ]);
  });

  it('pages every client newest first with an exact count, filtered by status when asked', async () => {
    const db = fakeAdmin({ query: { data: [exportRow()], error: null, count: 120 } });
    await expect(createTradingExportAdminStore(db).listAll({ limit: 50, offset: 100, status: 'ready' })).resolves.toEqual({ rows: [exportRow()], total: 120 });
    expect(db.calls.find((call) => call[0] === 'select')[3]).toEqual({ count: 'exact' });
    expect(db.calls).toContainEqual(['eq', 'status', 'ready']);
    expect(db.calls).toContainEqual(['order', 'requested_at', { ascending: false }]);
    expect(db.calls).toContainEqual(['range', 100, 149]);
  });

  it('finds expired exports by status ready and expires_at, of one client when given', async () => {
    const db = fakeAdmin({ query: { data: [{ id: rid(1), storage_path: PATH }], error: null } });
    await createTradingExportAdminStore(db).dueForExpiry({ clientId: CLIENT_ID, nowIso: NOW.toISOString(), limit: 100 });
    expect(db.calls).toEqual(expect.arrayContaining([
      ['eq', 'status', 'ready'], ['lte', 'expires_at', NOW.toISOString()], ['eq', 'client_id', CLIENT_ID], ['limit', 100],
    ]));
  });

  it('signs downloads in the private bucket for the given seconds and file name; a missing object is expired', async () => {
    const db = fakeAdmin();
    await expect(createTradingExportAdminStore(db).signDownload(PATH, 300, 'Gray-Elm_start_latest.jsonl.gz')).resolves.toBe('https://s/d');
    expect(db.calls).toEqual([['createSignedUrl', 'trading-exports', PATH, 300, { download: 'Gray-Elm_start_latest.jsonl.gz' }]]);
    const missing = fakeAdmin({ storage: { sign: { data: null, error: { status: 400, message: 'Object not found' } } } });
    await expect(createTradingExportAdminStore(missing).signDownload(PATH, 300, 'x')).rejects.toMatchObject({ status: 410, message: 'export_expired' });
  });

  it('audits a download with entity_type trading_export', async () => {
    const db = fakeAdmin();
    await createTradingExportAdminStore(db).auditDownload({ actorId: ACTOR.id, requestId: REQUEST_ID, clientId: CLIENT_ID, deviceId: id(1), byteSize: 5 });
    expect(db.calls).toEqual([['insert', 'audit_logs', {
      user_id: ACTOR.id, entity_type: 'trading_export', entity_id: REQUEST_ID, action: 'trading_export.downloaded',
      after_data: { clientId: CLIENT_ID, deviceId: id(1), byteSize: 5 },
    }]]);
  });

  it.each([
    [{ code: 'PGRST205', message: "Could not find the table 'public.trading_export_requests' in the schema cache" }, 404, 'trading_export_unavailable'],
    [{ code: '42P01', message: 'relation "public.trading_export_requests" does not exist' }, 404, 'trading_export_unavailable'],
  ])('reads %j as step 72 not having run', async (error, status, message) => {
    const db = fakeAdmin({ query: { data: null, error } });
    await expect(createTradingExportAdminStore(db).listForClient(CLIENT_ID)).rejects.toMatchObject({ status, message });
  });

  it('turns the request function\'s refusal into 400, and refuses an answer that is not a count', async () => {
    await expect(createTradingExportAdminStore(fakeAdmin({ rpc: { request_trading_exports: { data: null, error: { code: '22023', message: 'INVALID_TRADING_EXPORT_REQUEST' } } } }))
      .request({ deviceIds: [id(1)], from: null, to: null, datasets: ALL, actorId: ACTOR.id })).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
    await expect(createTradingExportAdminStore(fakeAdmin({ rpc: { request_trading_exports: { data: 'two', error: null } } }))
      .request({ deviceIds: [id(1)], from: null, to: null, datasets: ALL, actorId: ACTOR.id })).rejects.toThrow('no count');
  });
});
