import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import {
  SIGNED_UPLOAD_SECONDS,
  TRADING_EXPORT_BUCKET,
  createTradingExportDeviceStore,
} from '../../../apiLib/tradingExportStore.js';
import {
  config,
  createExportCompleteHandler,
  createExportRequestHandler,
  createExportUploadUrlHandler,
  parseCompleteBody,
  parseExportRequestBody,
  parseUploadUrlBody,
} from '../../../autoCollection/ingest/tradingExport.js';

/* THE AGENT'S THREE EXPORT ROUTES, AS THE AGENT IS CODED AGAINST THEM.
 *
 * Device headers like the heartbeat, checked before the body; exact keys;
 * export-request hands out { id, from, to, datasets, maxBytes } or null;
 * export-upload-url refuses a size outside 1 to 25 MiB with 413
 * export_too_large and hands back a signed upload URL for the device's own
 * request only; export-complete marks it ready only when the object is in
 * storage with the size the upload declared. */

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DEVICE = '44444444-4444-4444-8444-444444444444';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const PATH = `deep-exports/${CLIENT_ID}/${REQUEST_ID}.jsonl.gz`;
const SHA = 'a'.repeat(64);
const SIZE = 831488;
const COUNTS = { executions: 2140, orders: 900, strategies: 12, trades: 610 };
const MAX = 26214400;
const NOW = new Date('2026-10-20T15:00:00.000Z');

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function uploadingRow(overrides = {}) {
  return { id: REQUEST_ID, device_id: DEVICE_ID, client_id: CLIENT_ID, status: 'uploading', storage_path: PATH, byte_size: SIZE, sha256: SHA, error_code: null, ...overrides };
}

function makeStore(overrides = {}) {
  const calls = { claim: [], begin: [], load: [], complete: [], sign: [], info: [], remove: [] };
  const store = {
    calls,
    async claim(payload) { calls.claim.push(payload); return overrides.claim ? overrides.claim(payload) : null; },
    async beginUpload(payload) { calls.begin.push(payload); return overrides.beginUpload ? overrides.beginUpload(payload) : PATH; },
    async loadForDevice(deviceId, requestId) {
      calls.load.push([deviceId, requestId]);
      if (overrides.loadForDevice) return overrides.loadForDevice(deviceId, requestId);
      return deviceId === DEVICE_ID && requestId === REQUEST_ID ? uploadingRow() : null;
    },
    async complete(payload) { calls.complete.push(payload); return overrides.complete ? overrides.complete(payload) : payload.status; },
    async signUpload(path) { calls.sign.push(path); return overrides.signUpload ? overrides.signUpload(path) : `https://storage.example.test/upload/sign/${path}?token=t`; },
    async objectInfo(path) { calls.info.push(path); return overrides.objectInfo ? overrides.objectInfo(path) : { size: SIZE, sha256: null }; },
    async removeObjects(paths) { calls.remove.push(paths); if (overrides.removeObjects) return overrides.removeObjects(paths); return undefined; },
  };
  return store;
}

function setup(create, { store = makeStore(), authenticateImpl } = {}) {
  const calls = { authenticate: 0 };
  const handler = create({
    createClient: () => ({}),
    createAuthStore: () => ({}),
    createStore: () => store,
    authenticate: async () => {
      calls.authenticate += 1;
      if (authenticateImpl) return authenticateImpl();
      return { id: DEVICE_ID, clientId: CLIENT_ID, status: 'active', revokedAt: null };
    },
    pepper: 'test-pepper',
    now: () => NOW,
  });
  return { handler, store, calls };
}

async function post(handler, payload, overrides = {}) {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer redacted', 'x-machine-id': 'redacted' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...overrides,
  };
  const res = response();
  await handler(req, res);
  return res;
}

function uploadBody(overrides = {}) {
  return { requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE, contentType: 'application/gzip', ...overrides };
}

function readyBody(overrides = {}) {
  return { requestId: REQUEST_ID, status: 'ready', sha256: SHA, byteSize: SIZE, rowCounts: COUNTS, from: '2026-07-01', to: '2026-10-19', errorCode: null, ...overrides };
}

function failedBody(overrides = {}) {
  return { requestId: REQUEST_ID, status: 'failed', sha256: null, byteSize: null, rowCounts: null, from: null, to: null, errorCode: 'database_locked', ...overrides };
}

const quietly = async (fn) => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    errors.mockRestore();
  }
};

/* ── The bodies ──────────────────────────────────────────────────────────── */

describe('the export-request body: { agentVersion } and nothing else', () => {
  it('takes the version, trimmed', () => {
    expect(parseExportRequestBody({ agentVersion: ' 1.4.0 ' })).toEqual({ agentVersion: '1.4.0' });
  });

  it.each([
    ['an extra key', { agentVersion: '1.4.0', deviceId: DEVICE_ID }],
    ['no version', {}],
    ['a number', { agentVersion: 1.4 }],
    ['a word', { agentVersion: 'latest' }],
    ['an array body', [{ agentVersion: '1.4.0' }]],
    ['null', null],
  ])('refuses %s with invalid_request', (_label, value) => {
    expect(() => parseExportRequestBody(value)).toThrow('invalid_request');
  });
});

describe('the export-upload-url body', () => {
  it('takes the four keys, the digest and the id lower cased', () => {
    expect(parseUploadUrlBody(uploadBody({ requestId: REQUEST_ID.toUpperCase(), sha256: 'A'.repeat(64) })))
      .toEqual({ requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE });
  });

  it.each([
    ['an extra key', uploadBody({ path: PATH })],
    ['no content type', (() => { const body = uploadBody(); delete body.contentType; return body; })()],
    ['another content type', uploadBody({ contentType: 'application/json' })],
    ['a short digest', uploadBody({ sha256: 'a'.repeat(63) })],
    ['a non uuid', uploadBody({ requestId: 'export-1' })],
    ['a size as text', uploadBody({ byteSize: '100' })],
    ['a fractional size', uploadBody({ byteSize: 10.5 })],
    ['no size', uploadBody({ byteSize: null })],
  ])('refuses %s with 400 invalid_request', (_label, value) => {
    expect(() => parseUploadUrlBody(value)).toThrow(expect.objectContaining({ status: 400, message: 'invalid_request' }));
  });

  it.each([[0], [-1], [MAX + 1], [10 * MAX]])('refuses the whole number size %i with 413 export_too_large', (byteSize) => {
    expect(() => parseUploadUrlBody(uploadBody({ byteSize }))).toThrow(expect.objectContaining({ status: 413, message: 'export_too_large' }));
  });

  it('takes 1 byte and exactly 25 MiB', () => {
    expect(parseUploadUrlBody(uploadBody({ byteSize: 1 })).byteSize).toBe(1);
    expect(parseUploadUrlBody(uploadBody({ byteSize: MAX })).byteSize).toBe(MAX);
  });
});

describe('the export-complete body', () => {
  it('takes a ready report whole', () => {
    expect(parseCompleteBody(readyBody())).toEqual({
      requestId: REQUEST_ID, status: 'ready', sha256: SHA, byteSize: SIZE, rowCounts: COUNTS, from: '2026-07-01', to: '2026-10-19', errorCode: null,
    });
  });

  it('reads absent nullable keys as null, and a failure keeps only its code and days', () => {
    expect(parseCompleteBody({ requestId: REQUEST_ID, status: 'failed', errorCode: 'disk_full', sha256: SHA, byteSize: 5, rowCounts: COUNTS }))
      .toEqual({ requestId: REQUEST_ID, status: 'failed', sha256: null, byteSize: null, rowCounts: null, from: null, to: null, errorCode: 'disk_full' });
  });

  it.each([
    ['an extra key', readyBody({ path: PATH })],
    ['no status', (() => { const body = readyBody(); delete body.status; return body; })()],
    ['an unknown status', readyBody({ status: 'cancelled' })],
    ['ready without counts', readyBody({ rowCounts: null })],
    ['ready without a digest', readyBody({ sha256: null })],
    ['ready without a size', readyBody({ byteSize: null })],
    ['ready with an error code', readyBody({ errorCode: 'disk_full' })],
    ['failed without a code', failedBody({ errorCode: null })],
    ['a code in capitals', failedBody({ errorCode: 'Disk_full' })],
    ['a code of 65 characters', failedBody({ errorCode: `a${'b'.repeat(64)}` })],
    ['counts with an extra key', readyBody({ rowCounts: { ...COUNTS, accounts: 1 } })],
    ['counts missing a key', readyBody({ rowCounts: { executions: 1, orders: 1, strategies: 1 } })],
    ['a negative count', readyBody({ rowCounts: { ...COUNTS, trades: -1 } })],
    ['a fractional count', readyBody({ rowCounts: { ...COUNTS, trades: 1.5 } })],
    ['a date that is not one', readyBody({ from: '2026-02-30' })],
    ['days backwards', readyBody({ from: '2026-10-20', to: '2026-10-19' })],
  ])('refuses %s with 400 invalid_request', (_label, value) => {
    expect(() => parseCompleteBody(value)).toThrow(expect.objectContaining({ status: 400, message: 'invalid_request' }));
  });

  it('refuses a ready size above 25 MiB with 413 export_too_large', () => {
    expect(() => parseCompleteBody(readyBody({ byteSize: MAX + 1 }))).toThrow(expect.objectContaining({ status: 413, message: 'export_too_large' }));
  });
});

/* ── The three routes ────────────────────────────────────────────────────── */

describe('every export route authenticates like the heartbeat', () => {
  it('disables the platform body parser like every ingest route', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it.each([
    ['export-request', createExportRequestHandler],
    ['export-upload-url', createExportUploadUrlHandler],
    ['export-complete', createExportCompleteHandler],
  ])('%s: a refused device is a 401 before the body is read, and the store is not touched', async (_label, create) => {
    const { handler, store } = setup(create, { authenticateImpl: () => { throw new ApiError(401, 'invalid_device_credential'); } });
    const res = await post(handler, '{not json');
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
    expect(Object.values(store.calls).flat()).toEqual([]);
  });

  it.each([
    ['export-request', createExportRequestHandler],
    ['export-upload-url', createExportUploadUrlHandler],
    ['export-complete', createExportCompleteHandler],
  ])('%s: only takes POST', async (_label, create) => {
    const { handler, calls } = setup(create);
    expect((await post(handler, {}, { method: 'GET' })).statusCode).toBe(405);
    expect(calls.authenticate).toBe(0);
  });

  it('the default handler uses the real device check: no token, no answer', async () => {
    const handler = createExportRequestHandler({
      createClient: () => ({}),
      createAuthStore: () => ({ async findByCredentialDigest() { throw new Error('must not be reached'); } }),
      createStore: () => makeStore(),
      pepper: 'test-pepper',
    });
    const res = await post(handler, { agentVersion: '1.4.0' }, { headers: {} });
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
  });
});

describe('POST /api/ingest/export-request', () => {
  it('answers request null when nothing is open, for the authenticated device', async () => {
    const { handler, store } = setup(createExportRequestHandler);
    const res = await post(handler, { agentVersion: '1.4.0' });
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, request: null } });
    expect(store.calls.claim).toEqual([{ deviceId: DEVICE_ID, agentVersion: '1.4.0' }]);
  });

  it('hands out the open request with the datasets, the days and the 25 MiB limit', async () => {
    const store = makeStore({ claim: () => ({ id: REQUEST_ID, from: '2026-09-30', to: null, datasets: ['executions', 'orders', 'strategies', 'trades'] }) });
    const { handler } = setup(createExportRequestHandler, { store });
    expect((await post(handler, { agentVersion: '1.4.0' })).body).toEqual({
      ok: true,
      request: { id: REQUEST_ID, from: '2026-09-30', to: null, datasets: ['executions', 'orders', 'strategies', 'trades'], maxBytes: 26214400 },
    });
  });

  it('refuses an unknown key with 400 and an oversized body with 413, claiming nothing', async () => {
    const { handler, store } = setup(createExportRequestHandler);
    expect(await post(handler, { agentVersion: '1.4.0', state: 'idle' })).toMatchObject({ statusCode: 400, body: { error: 'invalid_request' } });
    expect(await post(handler, { agentVersion: '1.4.0', padding: 'x'.repeat(5000) })).toMatchObject({ statusCode: 413, body: { error: 'invalid_request' } });
    expect(store.calls.claim).toEqual([]);
  });

  it('maps the store: 404 before step 72, 401 for a device it refuses, 503 for a fault', async () => {
    await quietly(async () => {
      for (const [error, status, code] of [
        [new ApiError(404, 'not_found'), 404, 'not_found'],
        [new ApiError(401, 'invalid_device_credential'), 401, 'invalid_device_credential'],
        [Object.assign(new Error('connection reset'), { code: '08006' }), 503, 'trading_export_unavailable'],
      ]) {
        const { handler } = setup(createExportRequestHandler, { store: makeStore({ claim: () => { throw error; } }) });
        expect(await post(handler, { agentVersion: '1.4.0' }), code).toMatchObject({ statusCode: status, body: { error: code } });
      }
    });
  });
});

describe('POST /api/ingest/export-upload-url', () => {
  it('marks this device\'s request uploading and hands back a signed upload URL, its path and when it ends', async () => {
    const { handler, store } = setup(createExportUploadUrlHandler);
    const res = await post(handler, uploadBody({ sha256: 'A'.repeat(64) }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      uploadUrl: `https://storage.example.test/upload/sign/${PATH}?token=t`,
      path: PATH,
      expiresAt: new Date(NOW.getTime() + SIGNED_UPLOAD_SECONDS * 1000).toISOString(),
    });
    expect(SIGNED_UPLOAD_SECONDS).toBe(7200);
    expect(store.calls.begin).toEqual([{ deviceId: DEVICE_ID, requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE }]);
    expect(store.calls.sign).toEqual([PATH]);
  });

  it('refuses a size above 25 MiB with 413 export_too_large before anything is written or signed', async () => {
    const { handler, store } = setup(createExportUploadUrlHandler);
    expect(await post(handler, uploadBody({ byteSize: MAX + 1 }))).toMatchObject({ statusCode: 413, body: { error: 'export_too_large' } });
    expect(await post(handler, uploadBody({ byteSize: 0 }))).toMatchObject({ statusCode: 413, body: { error: 'export_too_large' } });
    expect(store.calls.begin).toEqual([]);
    expect(store.calls.sign).toEqual([]);
  });

  it('answers another device\'s request like one that does not exist, and signs nothing', async () => {
    const store = makeStore({ beginUpload: () => { throw new ApiError(404, 'export_request_not_found'); } });
    const { handler } = setup(createExportUploadUrlHandler, { store });
    expect(await post(handler, uploadBody())).toMatchObject({ statusCode: 404, body: { error: 'export_request_not_found' } });
    expect(store.calls.sign).toEqual([]);
  });

  it('a request that is no longer building or uploading is a 409, and nothing is signed', async () => {
    const store = makeStore({ beginUpload: () => { throw new ApiError(409, 'export_request_closed'); } });
    const { handler } = setup(createExportUploadUrlHandler, { store });
    expect(await post(handler, uploadBody())).toMatchObject({ statusCode: 409, body: { error: 'export_request_closed' } });
    expect(store.calls.sign).toEqual([]);
  });

  it('a storage fault while signing is a 503 the agent can retry', async () => {
    await quietly(async () => {
      const store = makeStore({ signUpload: () => { throw Object.assign(new Error('storage down'), { status: 500 }); } });
      const { handler } = setup(createExportUploadUrlHandler, { store });
      expect(await post(handler, uploadBody())).toMatchObject({ statusCode: 503, body: { error: 'trading_export_unavailable' } });
    });
  });
});

describe('POST /api/ingest/export-complete', () => {
  it('ready: finds the object at the path with the declared size, then completes it', async () => {
    const { handler, store } = setup(createExportCompleteHandler);
    const res = await post(handler, readyBody());
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, status: 'ready' } });
    expect(store.calls.load).toEqual([[DEVICE_ID, REQUEST_ID]]);
    expect(store.calls.info).toEqual([PATH]);
    expect(store.calls.complete).toEqual([{
      deviceId: DEVICE_ID, requestId: REQUEST_ID, status: 'ready', sha256: SHA, byteSize: SIZE, rowCounts: COUNTS,
      from: '2026-07-01', to: '2026-10-19', errorCode: null,
    }]);
    expect(store.calls.remove).toEqual([]);
  });

  it('another device\'s request is a 404, read with the authenticated device\'s id, and nothing is checked or written', async () => {
    const { handler, store } = setup(createExportCompleteHandler, {
      authenticateImpl: () => ({ id: OTHER_DEVICE, clientId: CLIENT_ID, status: 'active', revokedAt: null }),
    });
    expect(await post(handler, readyBody())).toMatchObject({ statusCode: 404, body: { error: 'export_request_not_found' } });
    expect(store.calls.load).toEqual([[OTHER_DEVICE, REQUEST_ID]]);
    expect(store.calls.info).toEqual([]);
    expect(store.calls.complete).toEqual([]);
  });

  it('refuses ready when the object is missing, or its size is not the declared one, and completes nothing', async () => {
    for (const [objectInfo, code] of [
      [() => null, 'export_object_missing'],
      [() => ({ size: SIZE - 1, sha256: null }), 'export_object_mismatch'],
      [() => ({ size: SIZE, sha256: 'b'.repeat(64) }), 'export_object_mismatch'],
    ]) {
      const { handler, store } = setup(createExportCompleteHandler, { store: makeStore({ objectInfo }) });
      expect(await post(handler, readyBody()), code).toMatchObject({ statusCode: 409, body: { error: code } });
      expect(store.calls.complete).toEqual([]);
    }
  });

  it('accepts a matching SHA-256 when the object metadata carries one', async () => {
    const { handler } = setup(createExportCompleteHandler, { store: makeStore({ objectInfo: () => ({ size: SIZE, sha256: SHA }) }) });
    expect(await post(handler, readyBody())).toMatchObject({ statusCode: 200, body: { ok: true, status: 'ready' } });
  });

  it('refuses ready when the digest or size is not what the upload declared, without asking storage', async () => {
    for (const body of [readyBody({ sha256: 'c'.repeat(64) }), readyBody({ byteSize: SIZE + 1 })]) {
      const { handler, store } = setup(createExportCompleteHandler);
      expect(await post(handler, body)).toMatchObject({ statusCode: 409, body: { error: 'export_mismatch' } });
      expect(store.calls.info).toEqual([]);
      expect(store.calls.complete).toEqual([]);
    }
  });

  it('refuses ready before any upload began', async () => {
    const store = makeStore({ loadForDevice: () => uploadingRow({ status: 'building', storage_path: null, sha256: null, byte_size: null }) });
    const { handler } = setup(createExportCompleteHandler, { store });
    expect(await post(handler, readyBody())).toMatchObject({ statusCode: 409, body: { error: 'export_request_closed' } });
    expect(store.calls.complete).toEqual([]);
  });

  it('a request cancelled during the upload: 409, and what landed is removed', async () => {
    const store = makeStore({ loadForDevice: () => uploadingRow({ status: 'cancelled' }) });
    const { handler } = setup(createExportCompleteHandler, { store });
    expect(await post(handler, readyBody())).toMatchObject({ statusCode: 409, body: { error: 'export_request_closed' } });
    expect(store.calls.remove).toEqual([[PATH]]);
    expect(store.calls.complete).toEqual([]);
  });

  it('the same ready report again is answered ready without asking storage', async () => {
    const store = makeStore({ loadForDevice: () => uploadingRow({ status: 'ready' }) });
    const { handler } = setup(createExportCompleteHandler, { store });
    expect(await post(handler, readyBody())).toMatchObject({ statusCode: 200, body: { ok: true, status: 'ready' } });
    expect(store.calls.info).toEqual([]);
    expect(store.calls.complete).toHaveLength(1);
  });

  it('failed: records the code with no file fields, and removes a file that had landed', async () => {
    const { handler, store } = setup(createExportCompleteHandler);
    expect(await post(handler, failedBody({ sha256: SHA, byteSize: SIZE }))).toMatchObject({ statusCode: 200, body: { ok: true, status: 'failed' } });
    expect(store.calls.complete).toEqual([{
      deviceId: DEVICE_ID, requestId: REQUEST_ID, status: 'failed', sha256: null, byteSize: null, rowCounts: null, from: null, to: null, errorCode: 'database_locked',
    }]);
    expect(store.calls.info).toEqual([]);
    expect(store.calls.remove).toEqual([[PATH]]);
  });

  it('a storage fault while looking at the object is a 503, and nothing is completed', async () => {
    await quietly(async () => {
      const store = makeStore({ objectInfo: () => { throw Object.assign(new Error('storage down'), { status: 500 }); } });
      const { handler } = setup(createExportCompleteHandler, { store });
      expect(await post(handler, readyBody())).toMatchObject({ statusCode: 503, body: { error: 'trading_export_unavailable' } });
      expect(store.calls.complete).toEqual([]);
    });
  });

  it('passes the state machine\'s own refusals through', async () => {
    for (const [error, status, code] of [
      [new ApiError(409, 'export_request_closed'), 409, 'export_request_closed'],
      [new ApiError(409, 'export_mismatch'), 409, 'export_mismatch'],
      [new ApiError(404, 'not_found'), 404, 'not_found'],
    ]) {
      const { handler } = setup(createExportCompleteHandler, { store: makeStore({ complete: () => { throw error; } }) });
      expect(await post(handler, failedBody()), code).toMatchObject({ statusCode: status, body: { error: code } });
    }
  });
});

/* ── The store, against step 72's functions and Supabase storage ─────────── */

function fakeAdmin({ rpc = {}, rows = {}, storage = {} } = {}) {
  const calls = { rpc: [], from: [], storage: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push([name, args]);
      return rpc[name] || { data: null, error: null };
    },
    from(table) {
      const query = {
        select(columns) { calls.from.push(['select', table, columns]); return query; },
        eq(column, value) { calls.from.push(['eq', column, value]); return query; },
        async maybeSingle() { return rows[table] || { data: null, error: null }; },
      };
      return query;
    },
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(path, options) { calls.storage.push(['createSignedUploadUrl', bucket, path, options]); return storage.upload || { data: { signedUrl: 'https://s/u', path, token: 't' }, error: null }; },
          async info(path) { calls.storage.push(['info', bucket, path]); return storage.info || { data: { size: SIZE, metadata: {} }, error: null }; },
          async remove(paths) { calls.storage.push(['remove', bucket, paths]); return storage.remove || { data: [], error: null }; },
        };
      },
    },
  };
}

describe('the device store', () => {
  it('claims through claim_trading_export and reads its row', async () => {
    const db = fakeAdmin({ rpc: { claim_trading_export: { data: [{ request_id: REQUEST_ID.toUpperCase(), export_from: '2026-09-30', export_to: null, export_datasets: ['trades'] }], error: null } } });
    await expect(createTradingExportDeviceStore(db).claim({ deviceId: DEVICE_ID, agentVersion: '1.4.0' }))
      .resolves.toEqual({ id: REQUEST_ID, from: '2026-09-30', to: null, datasets: ['trades'] });
    expect(db.calls.rpc).toEqual([['claim_trading_export', { p_device_id: DEVICE_ID, p_agent_version: '1.4.0' }]]);
  });

  it('reads no rows as nothing to do, and refuses a date the database should never return', async () => {
    await expect(createTradingExportDeviceStore(fakeAdmin({ rpc: { claim_trading_export: { data: [], error: null } } })).claim({ deviceId: DEVICE_ID, agentVersion: '1.4.0' }))
      .resolves.toBeNull();
    const odd = fakeAdmin({ rpc: { claim_trading_export: { data: [{ request_id: REQUEST_ID, export_from: 'yesterday', export_to: null, export_datasets: ['trades'] }], error: null } } });
    await expect(createTradingExportDeviceStore(odd).claim({ deviceId: DEVICE_ID, agentVersion: '1.4.0' })).rejects.toThrow('invalid from date');
  });

  it.each([
    [{ code: '22023', message: 'INVALID_TRADING_EXPORT_REQUEST' }, 400, 'invalid_request'],
    [{ code: 'P0001', message: 'INVALID_INGEST_DEVICE' }, 401, 'invalid_device_credential'],
    [{ code: 'P0002', message: 'TRADING_EXPORT_NOT_FOUND' }, 404, 'export_request_not_found'],
    [{ code: 'P0001', message: 'TRADING_EXPORT_CLOSED' }, 409, 'export_request_closed'],
    [{ code: 'P0001', message: 'TRADING_EXPORT_MISMATCH' }, 409, 'export_mismatch'],
    [{ code: 'PGRST202', message: 'Could not find the function public.begin_trading_export_upload' }, 404, 'not_found'],
    [{ code: '42883', message: 'function public.begin_trading_export_upload does not exist' }, 404, 'not_found'],
  ])('turns %j into %i %s', async (error, status, message) => {
    await expect(createTradingExportDeviceStore(fakeAdmin({ rpc: { begin_trading_export_upload: { data: null, error } } }))
      .beginUpload({ deviceId: DEVICE_ID, requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE }))
      .rejects.toMatchObject({ status, message });
  });

  it('begins the upload with the four arguments and returns only a path of the one allowed shape', async () => {
    const db = fakeAdmin({ rpc: { begin_trading_export_upload: { data: PATH, error: null } } });
    await expect(createTradingExportDeviceStore(db).beginUpload({ deviceId: DEVICE_ID, requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE })).resolves.toBe(PATH);
    expect(db.calls.rpc).toEqual([['begin_trading_export_upload', { p_device_id: DEVICE_ID, p_request_id: REQUEST_ID, p_sha256: SHA, p_byte_size: SIZE }]]);
    const odd = fakeAdmin({ rpc: { begin_trading_export_upload: { data: '../elsewhere.gz', error: null } } });
    await expect(createTradingExportDeviceStore(odd).beginUpload({ deviceId: DEVICE_ID, requestId: REQUEST_ID, sha256: SHA, byteSize: SIZE })).rejects.toThrow('invalid storage path');
  });

  it('reads a request by its id AND the device\'s id', async () => {
    const db = fakeAdmin({ rows: { trading_export_requests: { data: uploadingRow(), error: null } } });
    await expect(createTradingExportDeviceStore(db).loadForDevice(DEVICE_ID, REQUEST_ID)).resolves.toEqual(uploadingRow());
    expect(db.calls.from).toEqual([
      ['select', 'trading_export_requests', 'id,device_id,client_id,status,storage_path,byte_size,sha256,error_code'],
      ['eq', 'id', REQUEST_ID],
      ['eq', 'device_id', DEVICE_ID],
    ]);
  });

  it('completes through complete_trading_export with the nine arguments', async () => {
    const db = fakeAdmin({ rpc: { complete_trading_export: { data: 'ready', error: null } } });
    await expect(createTradingExportDeviceStore(db).complete({
      deviceId: DEVICE_ID, requestId: REQUEST_ID, status: 'ready', sha256: SHA, byteSize: SIZE, rowCounts: COUNTS, from: '2026-07-01', to: '2026-10-19', errorCode: null,
    })).resolves.toBe('ready');
    expect(db.calls.rpc).toEqual([['complete_trading_export', {
      p_device_id: DEVICE_ID, p_request_id: REQUEST_ID, p_status: 'ready', p_sha256: SHA, p_byte_size: SIZE,
      p_row_counts: COUNTS, p_covered_from: '2026-07-01', p_covered_to: '2026-10-19', p_error_code: null,
    }]]);
  });

  it('signs uploads into the private bucket with upsert, so a retried upload replaces a partial one', async () => {
    const db = fakeAdmin();
    await expect(createTradingExportDeviceStore(db).signUpload(PATH)).resolves.toBe('https://s/u');
    expect(TRADING_EXPORT_BUCKET).toBe('trading-exports');
    expect(db.calls.storage).toEqual([['createSignedUploadUrl', 'trading-exports', PATH, { upsert: true }]]);
  });

  it('reads the object\'s size, a SHA-256 only from metadata that carries one, and null for a missing object', async () => {
    await expect(createTradingExportDeviceStore(fakeAdmin()).objectInfo(PATH)).resolves.toEqual({ size: SIZE, sha256: null });
    await expect(createTradingExportDeviceStore(fakeAdmin({ storage: { info: { data: { size: String(SIZE), metadata: { sha256: SHA.toUpperCase() } }, error: null } } })).objectInfo(PATH))
      .resolves.toEqual({ size: SIZE, sha256: SHA });
    for (const error of [{ status: 404, message: 'Object not found' }, { status: 400, message: 'Object not found' }]) {
      await expect(createTradingExportDeviceStore(fakeAdmin({ storage: { info: { data: null, error } } })).objectInfo(PATH)).resolves.toBeNull();
    }
    const down = { status: 500, message: 'internal error' };
    await expect(createTradingExportDeviceStore(fakeAdmin({ storage: { info: { data: null, error: down } } })).objectInfo(PATH)).rejects.toBe(down);
  });

  it('removes objects from the private bucket, and passes a storage error up', async () => {
    const db = fakeAdmin();
    await createTradingExportDeviceStore(db).removeObjects([PATH]);
    expect(db.calls.storage).toEqual([['remove', 'trading-exports', [PATH]]]);
    const down = { status: 500, message: 'internal error' };
    await expect(createTradingExportDeviceStore(fakeAdmin({ storage: { remove: { data: null, error: down } } })).removeObjects([PATH])).rejects.toBe(down);
  });
});
