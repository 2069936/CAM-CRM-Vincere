import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { canonicalSnapshotPayload } from '../_lib/autoImportStore.js';
import { createDownloadStore, createHandler, storageObjectBytes } from './ingest-download.js';
import { ApiError } from '../_lib/http.js';
import { DEFAULT_MAX_COMPRESSED_BYTES } from '../_lib/autoCollectionLimits.js';

const snapshot = JSON.parse(readFileSync(new URL('../../test/fixtures/auto-export/snapshot-v1.json', import.meta.url), 'utf8'));
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const canonical = canonicalSnapshotPayload(snapshot);

function batch(overrides = {}) {
  return {
    id: BATCH_ID,
    captureId: snapshot.captureId,
    clientId: CLIENT_ID,
    deviceId: DEVICE_ID,
    tradingDate: snapshot.tradingDate,
    capturedAt: snapshot.capturedAt,
    receivedAt: '2026-07-23T20:45:03.000Z',
    processedAt: '2026-07-23T20:45:04.000Z',
    status: 'processed',
    schemaVersion: 1,
    storagePath: `${CLIENT_ID}/${snapshot.tradingDate}/${snapshot.captureId}.json.gz`,
    contentSha256: canonical.sha256,
    byteCount: canonical.utf8.length,
    rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
    completeness: { isComplete: true, emptySections: [] },
    dailyImportId: null,
    replacesBatchId: null,
    errorCode: null,
    ...overrides,
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function setup({ found = batch(), object = canonical.gzip, authorizeError, getError, auditError } = {}) {
  const calls = { audit: [], download: [] };
  const store = {
    async getBatch(id) {
      if (getError) throw getError;
      expect(id).toBe(BATCH_ID);
      return found;
    },
    async downloadObject(path) { calls.download.push(path); return object; },
    async auditDownload(value) {
      calls.audit.push(value);
      if (auditError) throw auditError;
    },
  };
  const authorize = vi.fn(async (_req, options) => {
    expect(options.roles).toEqual(['Manager']);
    if (authorizeError) throw authorizeError;
    return { id: 'manager-1', role: 'Manager' };
  });
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }), authorize, createStore: () => store,
  });
  return { handler, calls, authorize };
}

describe('admin collector batch downloads', () => {
  it('returns exact verified canonical JSON through the authorized server with private headers', async () => {
    const { handler, calls } = setup();
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);

    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(canonical.utf8)).toBe(true);
    expect(res.headers).toMatchObject({
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ninjatrader-${CLIENT_ID}-2026-07-23-${snapshot.captureId}.json"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(canonical.utf8.length),
    });
    expect(calls.download).toEqual([`${CLIENT_ID}/2026-07-23/${snapshot.captureId}.json.gz`]);
    expect(calls.audit).toEqual([{
      actorId: 'manager-1', batchId: BATCH_ID, clientId: CLIENT_ID,
      deviceId: DEVICE_ID, tradingDate: '2026-07-23', status: 'processed', format: 'json',
    }]);
    expect(JSON.stringify(calls.audit)).not.toMatch(/sha|storage|token|payload|error/i);
  });

  it('returns a generated ZIP containing exactly four CSVs and the manifest', async () => {
    const { handler, calls } = setup();
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'zip' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/zip');
    expect(Object.keys(unzipSync(res.body)).sort()).toEqual([
      'Accounts.csv', 'Executions.csv', 'Orders.csv', 'Strategies.csv', 'manifest.json',
    ]);
    expect(calls.audit[0]).toMatchObject({ format: 'zip', batchId: BATCH_ID });
  });

  it('passes the shared configured compressed cap into Storage and snapshot verification', async () => {
    const createStore = vi.fn(() => ({
      getBatch: async () => batch(),
      downloadObject: async () => canonical.gzip,
      auditDownload: async () => {},
    }));
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ id: 'manager-1' }),
      createStore,
      env: {
        AUTO_COLLECTION_MAX_COMPRESSED_BYTES: String(canonical.gzip.length - 1),
        AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: String(17 * 1024 * 1024),
      },
    });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);
    expect(createStore).toHaveBeenCalledWith({}, { maxCompressedBytes: canonical.gzip.length - 1 });
    expect(res).toMatchObject({ statusCode: 409, body: { error: 'stored_snapshot_corrupt' } });
    expect(DEFAULT_MAX_COMPRESSED_BYTES).toBeGreaterThan(canonical.gzip.length - 1);
  });

  it.each([
    [{ batchId: 'bad', format: 'json' }, 'invalid_batch_id'],
    [{ batchId: BATCH_ID, format: 'xml' }, 'invalid_download_format'],
    [{ batchId: BATCH_ID, format: ['json', 'zip'] }, 'invalid_download_format'],
    [{ format: 'json' }, 'invalid_batch_id'],
  ])('rejects invalid download query %#', async (query, error) => {
    const { handler, calls } = setup();
    const res = response();
    await handler({ method: 'GET', headers: {}, query }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error } });
    expect(calls.download).toHaveLength(0);
    expect(calls.audit).toHaveLength(0);
  });

  it('authorizes before validating identifiers or reading private storage', async () => {
    const { handler, calls } = setup({ authorizeError: new ApiError(403, 'Manager permission required.') });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: 'bad', format: 'json' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(calls.download).toHaveLength(0);
  });

  it('maps an untrusted dependency error with a forged 4xx status to one stable 500', async () => {
    const { handler, calls } = setup({
      getError: Object.assign(new Error('private dependency secret'), { status: 400 }),
    });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'batch_download_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('private dependency secret');
    expect(calls.download).toHaveLength(0);
  });

  it('uses stable missing, corrupt, unsupported-schema and unavailable errors without leaking details', async () => {
    for (const [options, status, error] of [
      [{ found: null }, 404, 'batch_not_found'],
      [{ object: Buffer.from('secret corrupt bytes') }, 409, 'stored_snapshot_corrupt'],
      [{ found: batch({ schemaVersion: 99 }) }, 409, 'unsupported_schema_version'],
      [{ getError: new Error('database password and table detail') }, 500, 'batch_download_failed'],
    ]) {
      const { handler, calls } = setup(options);
      const res = response();
      await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);
      expect(res).toMatchObject({ statusCode: status, body: { error } });
      expect(JSON.stringify(res.body)).not.toMatch(/password|secret corrupt|table detail/i);
      expect(calls.audit).toHaveLength(0);
      if (error === 'unsupported_schema_version') expect(calls.download).toHaveLength(0);
    }
  });

  it('rejects client/path confusion before requesting any private object', async () => {
    const { handler, calls } = setup({
      found: batch({ storagePath: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/2026-07-23/${snapshot.captureId}.json.gz` }),
    });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);
    expect(res).toMatchObject({ statusCode: 409, body: { error: 'stored_snapshot_corrupt' } });
    expect(calls.download).toHaveLength(0);
    expect(calls.audit).toHaveLength(0);
  });

  it('fails closed when the download audit cannot be recorded', async () => {
    const { handler } = setup({ auditError: new Error('audit private detail') });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { batchId: BATCH_ID, format: 'json' } }, res);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'batch_download_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('audit private detail');
  });

  it('rejects non-GET methods before authorization', async () => {
    const { handler, authorize } = setup();
    const res = response();
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('private Storage download adapter', () => {
  it('selects one batch with server-only evidence and downloads from the fixed private bucket', async () => {
    const calls = [];
    const single = {
      select(value) { calls.push(['select', value]); return this; },
      eq(...args) { calls.push(['eq', ...args]); return this; },
      maybeSingle: async () => ({ data: {
        id: BATCH_ID, capture_id: snapshot.captureId, client_id: CLIENT_ID, device_id: DEVICE_ID,
        trading_date: snapshot.tradingDate, captured_at: snapshot.capturedAt,
        received_at: '2026-07-23T20:45:03.000Z', status: 'processed', schema_version: 1,
        storage_path: `${CLIENT_ID}/${snapshot.tradingDate}/${snapshot.captureId}.json.gz`,
        content_sha256: canonical.sha256, byte_count: canonical.utf8.length,
        row_counts: { accounts: 1, strategies: 1, orders: 1, executions: 1 }, completeness: {},
      }, error: null }),
    };
    const insert = vi.fn(async () => ({ error: null }));
    const download = vi.fn(async () => ({ data: new Blob([canonical.gzip]), error: null }));
    const admin = {
      from(name) {
        if (name === 'ingest_batches') return single;
        if (name === 'audit_logs') return { insert };
        throw new Error('unexpected table');
      },
      storage: { from: vi.fn((name) => {
        expect(name).toBe('ninjatrader-imports');
        return { download };
      }) },
    };
    const store = createDownloadStore(admin);
    const loaded = await store.getBatch(BATCH_ID);
    const bytes = await store.downloadObject(loaded.storagePath);
    await store.auditDownload({ actorId: 'manager-1', batchId: BATCH_ID, clientId: CLIENT_ID, deviceId: DEVICE_ID, tradingDate: '2026-07-23', status: 'processed', format: 'json' });
    expect(bytes.equals(canonical.gzip)).toBe(true);
    expect(download).toHaveBeenCalledWith(loaded.storagePath);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'manager-1', entity_type: 'ingest_batch', entity_id: BATCH_ID,
      action: 'ingest_batch_downloaded',
    }));
    const auditJson = JSON.stringify(insert.mock.calls);
    expect(auditJson).not.toMatch(/sha|storage_path|signed|payload|error_detail/i);
    expect(calls.find(([kind]) => kind === 'select')[1]).toContain('storage_path');
  });

  it('bounds a declared Storage object before arrayBuffer allocation', async () => {
    const arrayBuffer = vi.fn();
    await expect(storageObjectBytes({ size: 2049, arrayBuffer }, { maxBytes: 2048 }))
      .rejects.toMatchObject({ status: 409, message: 'stored_snapshot_corrupt' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('maps a missing private object without creating a public or signed URL', async () => {
    const bucket = { download: vi.fn(async () => ({ data: null, error: { statusCode: 404, message: 'Object not found private detail' } })) };
    const admin = { storage: { from: vi.fn(() => bucket) } };
    const store = createDownloadStore(admin);
    await expect(store.downloadObject('safe/path.json.gz')).rejects.toMatchObject({ status: 404, message: 'stored_snapshot_missing' });
    expect(bucket).not.toHaveProperty('createSignedUrl');
  });
});
