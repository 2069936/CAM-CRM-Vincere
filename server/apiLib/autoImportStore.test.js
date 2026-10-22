import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalSnapshotPayload,
  createAutoImportStore,
  decodeSnapshotRequest,
  recordValidationReason,
} from './autoImportStore.js';

const fixture = {
  schemaVersion: 1,
  captureId: '0f5fa8a0-2e84-43d8-8788-24055979f6fe',
  capturedAt: '2026-07-23T16:45:00-04:00',
  tradingDate: '2026-07-23',
  timeZone: 'America/New_York',
  source: { machineId: 'redacted', agentVersion: '1.0.0', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.5.2' },
  accounts: [], strategies: [], orders: [], executions: [],
};

function request(buffer, headers = {}) {
  return { body: buffer, headers: { 'content-encoding': 'gzip', ...headers } };
}

describe('immutable auto-import payloads', () => {
  it('canonicalizes object keys before hashing and stores a gzip round trip', async () => {
    const reordered = { ...fixture, source: { ninjaTraderVersion: '8.1.5.2', addonVersion: '1.0.0', agentVersion: '1.0.0', machineId: 'redacted' } };
    const first = canonicalSnapshotPayload(fixture);
    const second = canonicalSnapshotPayload(reordered);
    expect(first.sha256).toBe(second.sha256);
    expect(JSON.parse(first.utf8.toString('utf8'))).toEqual(fixture);
    expect(JSON.parse(gunzipSync(first.gzip))).toEqual(fixture);

    const decoded = await decodeSnapshotRequest(request(gzipSync(Buffer.from(JSON.stringify(reordered)))));
    expect(decoded.snapshot).toEqual(reordered);
    expect(decoded.sha256).toBe(first.sha256);
    expect(gunzipSync(decoded.gzip)).toEqual(first.utf8);
  });

  it('rejects the exact compressed byte overrun before decompressing or parsing', async () => {
    const raw = gzipSync(Buffer.from(JSON.stringify(fixture)));
    await expect(decodeSnapshotRequest(request(raw), { maxCompressedBytes: raw.length - 1 }))
      .rejects.toMatchObject({ status: 413, message: 'compressed_payload_too_large' });
  });

  it('accepts a streamed raw body at the exact compressed maximum', async () => {
    const raw = gzipSync(Buffer.from(JSON.stringify(fixture)));
    const req = {
      headers: { 'content-encoding': 'gzip', 'content-length': String(raw.length) },
      async *[Symbol.asyncIterator]() { yield raw.subarray(0, 5); yield raw.subarray(5); },
    };
    await expect(decodeSnapshotRequest(req, { maxCompressedBytes: raw.length }))
      .resolves.toMatchObject({ snapshot: fixture });
  });

  it('rejects the exact uncompressed byte overrun before JSON parsing', async () => {
    const json = Buffer.from(JSON.stringify(fixture));
    await expect(decodeSnapshotRequest(request(gzipSync(json)), { maxUncompressedBytes: json.length - 1 }))
      .rejects.toMatchObject({ status: 413, message: 'uncompressed_payload_too_large' });
  });

  it('accepts the exact uncompressed byte maximum', async () => {
    const json = Buffer.from(JSON.stringify(fixture));
    await expect(decodeSnapshotRequest(request(gzipSync(json)), {
      maxUncompressedBytes: json.length,
    })).resolves.toMatchObject({ snapshot: fixture });
  });

  it('rejects a canonical gzip expansion above the same compressed cap', async () => {
    const expanded = {
      ...fixture,
      accounts: Array.from({ length: 100 }, (_, index) => ({
        z: 'abcdefghij'.repeat((index % 7) + 1),
        a: String(index),
        m: 'qwertyuiop'.repeat((index % 11) + 1),
      })),
    };
    const incoming = gzipSync(Buffer.from(JSON.stringify(expanded)), { level: 9 });
    const canonical = canonicalSnapshotPayload(expanded);
    expect(incoming.length).toBeLessThan(canonical.gzip.length);
    await expect(decodeSnapshotRequest(request(incoming), {
      maxCompressedBytes: canonical.gzip.length - 1,
    })).rejects.toMatchObject({ status: 413, message: 'compressed_payload_too_large' });
  });

  it('requires raw gzip bytes and rejects malformed compression with stable errors', async () => {
    await expect(decodeSnapshotRequest({ body: fixture, headers: { 'content-encoding': 'gzip' } }))
      .rejects.toMatchObject({ status: 400, message: 'raw_gzip_body_required' });
    await expect(decodeSnapshotRequest(request(Buffer.from('{"bad":true}'))))
      .rejects.toMatchObject({ status: 400, message: 'invalid_gzip_payload' });
  });
});

describe('auto import Supabase store', () => {
  it('persists automatic imports through the PnL-audited token-bound RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: { disposition: 'persisted', daily_import: { id: 'daily-1' } }, error: null,
    }));
    const store = createAutoImportStore({ rpc });
    const adapter = store.createPersistenceAdapter('99999999-9999-4999-8999-999999999999');
    await adapter.persistDailyImportAtomic({
      clientUuid: 'client-1',
      sourceBatchId: 'batch-1',
      importResult: { date: '2026-07-23', pnlSourceSummary: { gross_fallback: 1 } },
    });
    expect(rpc).toHaveBeenCalledWith('persist_auto_daily_import_v3', expect.objectContaining({
      p_source_batch_id: 'batch-1',
      p_import_result: expect.objectContaining({ pnlSourceSummary: { gross_fallback: 1 } }),
    }));
  });

  it('uses the lease claim RPC and preserves its explicit outcome', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { outcome: 'busy', retry_after_seconds: 17, batch: { id: 'batch-1', daily_import_id: null, status: 'processing', error_code: null } }, error: null });
    const store = createAutoImportStore({ rpc });
    await expect(store.claimBatch({ deviceId: 'device-1', captureId: fixture.captureId, clientId: 'client-1', tradingDate: fixture.tradingDate, capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path', sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {}, processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120 }))
      .resolves.toEqual({ outcome: 'busy', retryAfterSeconds: 17, batch: { id: 'batch-1', dailyImportId: null, status: 'processing', errorCode: null } });
    expect(rpc).toHaveBeenCalledWith('claim_ingest_batch_v4', expect.objectContaining({ p_capture_id: fixture.captureId, p_processing_token: '99999999-9999-4999-8999-999999999999', p_lease_seconds: 120 }));
  });

  it('maps immutable metadata reuse to a stable conflict', async () => {
    const store = createAutoImportStore({ rpc: async () => ({ data: null, error: { code: 'P0001', message: 'capture_metadata_conflict', details: 'private row detail' } }) });
    await expect(store.claimBatch({
      deviceId: 'device-1', captureId: fixture.captureId, tradingDate: fixture.tradingDate,
      capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path',
      sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {},
      processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120,
    })).rejects.toMatchObject({ status: 409, message: 'capture_metadata_conflict' });
  });

  it('preserves the stored safe failure code for an explicit failed retry', async () => {
    const store = createAutoImportStore({ rpc: async () => ({
      data: { outcome: 'failed', retry_after_seconds: 0, batch: {
        id: 'batch-1', daily_import_id: null, status: 'failed', error_code: 'normalization_failed',
      } }, error: null,
    }) });
    await expect(store.claimBatch({
      deviceId: 'device-1', captureId: fixture.captureId, tradingDate: fixture.tradingDate,
      capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path',
      sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {},
      processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120,
    })).resolves.toMatchObject({ batch: { status: 'failed', errorCode: 'normalization_failed' } });
  });

  it('maps an in-flight device revocation to the generic credential error', async () => {
    const store = createAutoImportStore({ rpc: async () => ({
      data: null, error: { code: 'P0001', message: 'invalid_ingest_device', details: 'private device state' },
    }) });
    await expect(store.claimBatch({
      deviceId: 'device-1', captureId: fixture.captureId, tradingDate: fixture.tradingDate,
      capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path',
      sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {},
      processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120,
    })).rejects.toMatchObject({ status: 401, message: 'invalid_device_credential' });
  });

  it('uploads immutable gzip without overwrite', async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const download = vi.fn().mockResolvedValue({ data: null, error: { statusCode: 404, message: 'not found' } });
    const store = createAutoImportStore({ storage: { from: () => ({ upload, download }) } });
    await store.ensureRaw('client/date/capture.json.gz', Buffer.from('gzip'), {
      sha256: 'a'.repeat(64), byteCount: 4,
    });
    expect(upload).toHaveBeenCalledWith('client/date/capture.json.gz', expect.any(Buffer), {
      contentType: 'application/gzip', cacheControl: '31536000', upsert: false,
    });
  });

  it('resumes from an existing immutable object only when canonical bytes match', async () => {
    const canonical = canonicalSnapshotPayload(fixture);
    const download = vi.fn().mockResolvedValue({ data: new Blob([canonical.gzip]), error: null });
    const upload = vi.fn();
    const store = createAutoImportStore({ storage: { from: () => ({ download, upload }) } });
    await expect(store.ensureRaw('path', canonical.gzip, {
      sha256: canonical.sha256, byteCount: canonical.utf8.length,
    })).resolves.toEqual({ existed: true });
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects an existing deterministic object whose canonical evidence mismatches', async () => {
    const canonical = canonicalSnapshotPayload(fixture);
    const wrong = gzipSync(Buffer.from('{"different":true}'));
    const store = createAutoImportStore({ storage: { from: () => ({ download: async () => ({ data: new Blob([wrong]), error: null }) }) } });
    await expect(store.ensureRaw('path', canonical.gzip, {
      sha256: canonical.sha256, byteCount: canonical.utf8.length,
    })).rejects.toMatchObject({ status: 409, message: 'immutable_object_conflict' });
  });

  it('rejects oversized downloaded evidence before buffering it', async () => {
    const canonical = canonicalSnapshotPayload(fixture);
    const arrayBuffer = vi.fn();
    const store = createAutoImportStore({ storage: { from: () => ({
      download: async () => ({ data: { size: canonical.gzip.length + 1, arrayBuffer }, error: null }),
    }) } });
    await expect(store.ensureRaw('path', canonical.gzip, {
      sha256: canonical.sha256,
      byteCount: canonical.utf8.length,
      compressedByteCount: canonical.gzip.length,
      maxCompressedBytes: canonical.gzip.length,
    })).rejects.toMatchObject({ status: 409, message: 'immutable_object_conflict' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uses one RPC to finalize batch, device result, audit and late alert', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'batch-1', status: 'late_closed_day', daily_import_id: 'daily-1' }, error: null });
    const store = createAutoImportStore({ rpc });
    await expect(store.completeBatch({
      batchId: 'batch-1', deviceId: 'device-1', status: 'late_closed_day',
      dailyImportId: 'daily-1', capturedAt: fixture.capturedAt, success: true,
      completeness: { isComplete: true }, rowCounts: { accounts: 1 },
      eventType: 'ingest_batch_late_closed_day', processingToken: '99999999-9999-4999-8999-999999999999', clientId: 'client-1',
    })).resolves.toEqual({ id: 'batch-1', dailyImportId: 'daily-1', status: 'late_closed_day', errorCode: null });
    expect(rpc).toHaveBeenCalledWith('finalize_ingest_batch_v3', expect.objectContaining({
      p_batch_id: 'batch-1', p_device_id: 'device-1', p_status: 'late_closed_day',
      p_success: true, p_event_type: 'ingest_batch_late_closed_day', p_processing_token: expect.any(String),
    }));
  });

  it('maps a stale processing token to a stable lease conflict', async () => {
    const store = createAutoImportStore({ rpc: async () => ({ data: null, error: { code: 'P0001', message: 'processing_lease_lost', details: 'private' } }) });
    await expect(store.completeBatch({
      batchId: 'batch-1', deviceId: 'device-1', clientId: 'client-1',
      processingToken: '99999999-9999-4999-8999-999999999999',
      status: 'failed', capturedAt: fixture.capturedAt, success: false,
      errorCode: 'validation_failed', completeness: {}, rowCounts: {},
      eventType: 'ingest_batch_failed',
    })).rejects.toMatchObject({ status: 409, message: 'capture_lease_lost' });
  });

  it.each([
    ['invalid_ingest_device', 401, 'invalid_device_credential'],
    ['processing_lease_lost', 409, 'capture_lease_lost'],
  ])('maps release RPC %s without conflating revocation and lease loss', async (databaseCode, status, message) => {
    const store = createAutoImportStore({ rpc: async () => ({
      data: null, error: { code: 'P0001', message: databaseCode, details: 'private' },
    }) });
    await expect(store.releaseLease({
      batchId: 'batch-1', deviceId: 'device-1',
      processingToken: '99999999-9999-4999-8999-999999999999',
    })).rejects.toMatchObject({ status, message });
  });

  it('keeps the door\'s answer as its own outcome rather than folding it into busy', async () => {
    // 'busy' says this capture is already being processed. 'at_capacity' says
    // the server is full and has nothing to do with this capture. The desk
    // counts them separately, so they never share a name.
    const rpc = vi.fn().mockResolvedValue({ data: { outcome: 'at_capacity', retry_after_seconds: 63, batch: { id: 'batch-1', daily_import_id: null, status: 'received', error_code: null } }, error: null });
    const store = createAutoImportStore({ rpc });
    await expect(store.claimBatch({ deviceId: 'device-1', captureId: fixture.captureId, clientId: 'client-1', tradingDate: fixture.tradingDate, capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path', sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {}, processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120 }))
      .resolves.toEqual({ outcome: 'at_capacity', retryAfterSeconds: 63, batch: { id: 'batch-1', dailyImportId: null, status: 'received', errorCode: null } });
  });

  it('falls back to the claim the running database has when step 45 has not been run yet', async () => {
    // The deploy and the migration can happen in either order. A server that
    // asks for v4 before the SQL editor has been opened must keep collecting.
    const rpc = vi.fn(async (name) => (name === 'claim_ingest_batch_v4'
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_ingest_batch_v4 in the schema cache' } }
      : { data: { outcome: 'owned', retry_after_seconds: 0, batch: { id: 'batch-1', daily_import_id: null, status: 'processing', error_code: null } }, error: null }));
    const store = createAutoImportStore({ rpc });
    await expect(store.claimBatch({ deviceId: 'device-1', captureId: fixture.captureId, clientId: 'client-1', tradingDate: fixture.tradingDate, capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path', sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {}, processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120 }))
      .resolves.toMatchObject({ outcome: 'owned' });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['claim_ingest_batch_v4', 'claim_ingest_batch_v3']);
  });

  it('does not fall back for a real failure, which would hide it behind the old function', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }));
    const store = createAutoImportStore({ rpc });
    await expect(store.claimBatch({ deviceId: 'device-1', captureId: fixture.captureId, clientId: 'client-1', tradingDate: fixture.tradingDate, capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path', sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {}, processingToken: '99999999-9999-4999-8999-999999999999', leaseSeconds: 120 }))
      .rejects.toMatchObject({ code: '57014' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('carries the stopwatch to the finalize that stores it, and drops it for the older one', async () => {
    const rpc = vi.fn(async (name) => (name === 'finalize_ingest_batch_v3'
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.finalize_ingest_batch_v3 in the schema cache' } }
      : { data: { id: 'batch-1', status: 'processed', daily_import_id: 'daily-1' }, error: null }));
    const store = createAutoImportStore({ rpc });
    await store.completeBatch({
      batchId: 'batch-1', deviceId: 'device-1', clientId: 'client-1', status: 'processed',
      dailyImportId: 'daily-1', capturedAt: fixture.capturedAt, success: true,
      completeness: {}, rowCounts: {}, eventType: 'ingest_batch_processed',
      processingToken: '99999999-9999-4999-8999-999999999999',
      stageDurationsMs: { storage: 40, persist: 900 }, ingestDurationMs: 1200,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'finalize_ingest_batch_v3', expect.objectContaining({
      p_stage_durations_ms: { storage: 40, persist: 900 }, p_ingest_duration_ms: 1200,
    }));
    // The older function has twelve arguments and would refuse fourteen.
    expect(rpc.mock.calls[1][0]).toBe('finalize_ingest_batch_v2');
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_stage_durations_ms');
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_ingest_duration_ms');
  });

  it('maps the locked closed-day persistence result without exposing database details', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'P0001', message: 'daily_import_closed', details: 'daily-closed' } });
    const store = createAutoImportStore({ rpc });
    await expect(store.createPersistenceAdapter().persistDailyImportAtomic({
      clientUuid: 'client-1', sourceBatchId: 'batch-1', importResult: { date: '2026-07-23' },
    })).rejects.toMatchObject({ code: 'daily_import_closed', dailyImportId: 'daily-closed' });
  });
});

/* STEP 69: WHY A REFUSED CLOSE WAS REFUSED, BEST EFFORT. */
describe('recording why a close was rejected', () => {
  const BATCH = '44444444-4444-4444-8444-444444444444';
  const ERRORS = [
    'orders[0, 1, 2] and 4 more.accountName does not reference an account (APEX 4521 07)',
    'accounts[0].netLiquidation must be a number or null',
    'accounts[3].netLiquidation must be a number or null',
  ];
  const SUMMARY = 'orders[*].accountName does not reference an account (APEX 4521 07); accounts[*].netLiquidation must be a number or null';

  it('calls record_ingest_batch_error_detail with the batch and the text, and reports what the database said', async () => {
    for (const [data, written] of [[true, true], [false, false], [[true], true], [null, false]]) {
      const rpc = vi.fn(async () => ({ data, error: null }));
      await expect(createAutoImportStore({ rpc }).recordBatchErrorDetail({ batchId: BATCH, detail: SUMMARY })).resolves.toBe(written);
      expect(rpc).toHaveBeenCalledWith('record_ingest_batch_error_detail', { p_batch_id: BATCH, p_detail: SUMMARY });
    }
  });

  it('throws the database error from the store method, for the wrapper to swallow', async () => {
    const failure = { code: 'PGRST202', message: 'Could not find the function' };
    const rpc = vi.fn(async () => ({ data: null, error: failure }));
    await expect(createAutoImportStore({ rpc }).recordBatchErrorDetail({ batchId: BATCH, detail: SUMMARY })).rejects.toBe(failure);
  });

  it('hands the summary of the errors to the store, and returns what it stored', async () => {
    const store = { recordBatchErrorDetail: vi.fn(async () => true) };
    await expect(recordValidationReason(store, BATCH, ERRORS)).resolves.toBe(true);
    expect(store.recordBatchErrorDetail).toHaveBeenCalledWith({ batchId: BATCH, detail: SUMMARY });
    store.recordBatchErrorDetail.mockResolvedValueOnce(false);
    await expect(recordValidationReason(store, BATCH, ERRORS)).resolves.toBe(false);
  });

  it('calls nothing when there is nothing to say, or nowhere to say it', async () => {
    const store = { recordBatchErrorDetail: vi.fn(async () => true) };
    for (const errors of [[], undefined, null, 'accounts must be an array', ['', null]]) {
      await expect(recordValidationReason(store, BATCH, errors)).resolves.toBe(false);
    }
    expect(store.recordBatchErrorDetail).not.toHaveBeenCalled();
    await expect(recordValidationReason({}, BATCH, ERRORS)).resolves.toBe(false);
    await expect(recordValidationReason(undefined, BATCH, ERRORS)).resolves.toBe(false);
  });

  it('never throws: a failing store is reported by batch and cause, and a failing reporter is swallowed too', async () => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const store = { recordBatchErrorDetail: vi.fn(async () => { throw failure; }) };
    const report = vi.fn();
    await expect(recordValidationReason(store, BATCH, ERRORS, { report })).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith(BATCH, failure);
    await expect(recordValidationReason(store, BATCH, ERRORS, { report: () => { throw new Error('logger down'); } })).resolves.toBe(false);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recordValidationReason(store, BATCH, ERRORS)).resolves.toBe(false);
      expect(logged).toHaveBeenCalledWith(`[CRM] could not record why batch ${BATCH} was rejected: Error 57014 canceling statement due to statement timeout`);
      expect(logged.mock.calls.flat().join(' ')).not.toContain('APEX');
    } finally {
      logged.mockRestore();
    }
  });
});

/* THE DAY'S STORED FILLS (step 73), read a page at a time because PostgREST
 * stops at its max-rows without saying so, and mapped to the normalizer's
 * shape so reconcile can derive over the union. */
describe('loading the fills a day already holds', () => {
  function fakeAdmin(tables, refuse = null) {
    const reads = [];
    return {
      reads,
      from(table) {
        const query = { table, filters: [], range: null };
        const builder = {
          select(columns) { query.columns = columns; return builder; },
          eq(column, value) { query.filters.push([column, value]); return builder; },
          order(column) { query.order = column; return builder; },
          range(from, to) { query.range = [from, to]; return builder; },
          maybeSingle() { reads.push(query); return Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null }); },
          then(resolve, reject) {
            reads.push(query);
            const refusal = refuse && refuse(query);
            if (refusal) return Promise.resolve({ data: null, error: refusal }).then(resolve, reject);
            const rows = tables[table] || [];
            const data = query.range ? rows.slice(query.range[0], query.range[1] + 1) : rows;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  it('reads every page of the close, names each row\'s account and marks it fromStore', async () => {
    const executions = Array.from({ length: 1500 }, (_, n) => ({
      id: `row-${n}`, trading_account_id: n % 2 ? 'a1' : 'a2', external_execution_id: `E${n}`, external_order_id: `O${n}`,
      strategy_name: '', instrument: 'MNQ 12-26', action: 'Buy', quantity: '1', price: '21000', time_text: '2026-10-22 10:00:00',
      entry_exit: '', position: '', name: '', commission: null, rate: null, connection: '',
    }));
    const admin = fakeAdmin({
      daily_imports: [{ id: 'daily-1' }],
      executions,
      orders: [{ id: 'o', trading_account_id: 'a1', external_order_id: 'O1', state: 'Filled', quantity: '1' }],
      trading_accounts: [{ id: 'a1', account_name: 'APEX 01' }, { id: 'a2', account_name: 'APEX 02' }],
    });
    const stored = await createAutoImportStore(admin).loadStoredFills('client-1', '2026-10-22');
    expect(stored.executions).toHaveLength(1500);
    expect(stored.executions[1]).toMatchObject({ id: 'E1', accountName: 'APEX 01', quantity: 1, price: 21000, fromStore: true });
    expect(stored.orders).toEqual([expect.objectContaining({ id: 'O1', accountName: 'APEX 01', state: 'Filled', fromStore: true })]);
    const pages = admin.reads.filter((read) => read.table === 'executions').map((read) => read.range);
    expect(pages).toEqual([[0, 999], [1000, 1999]]);
    expect(admin.reads.find((read) => read.table === 'daily_imports').filters)
      .toEqual([['client_id', 'client-1'], ['trading_date', '2026-10-22']]);
  });

  it('reads the day\'s strategy rows without their parameters and leaves the tracker\'s out', async () => {
    const admin = fakeAdmin({
      daily_imports: [{ id: 'daily-1' }],
      strategy_snapshots: [
        { id: 's1', trading_account_id: 'a1', strategy_name: '2 - BETA-1.0', instrument: 'ES 12-26', realized: null, source: 'capture' },
        { id: 's2', trading_account_id: 'a1', strategy_name: '9 - TRK', instrument: 'NQ 12-26', realized: '5', source: 'tracker' },
      ],
      trading_accounts: [{ id: 'a1', account_name: 'APEX 01' }],
    });
    const stored = await createAutoImportStore(admin).loadStoredFills('client-1', '2026-10-22');
    expect(stored.strategies).toEqual([expect.objectContaining({ accountName: 'APEX 01', strategyName: '2 - BETA-1.0', realized: null, fromStore: true })]);
    const columns = admin.reads.find((read) => read.table === 'strategy_snapshots').columns;
    expect(columns).toContain('source');
    expect(columns).not.toMatch(/parameters_raw|params_parsed/);
  });

  it('asks again without `source` on a database where step 73 has not run', async () => {
    const admin = fakeAdmin({
      daily_imports: [{ id: 'daily-1' }],
      strategy_snapshots: [{ id: 's1', trading_account_id: 'a1', strategy_name: '2 - BETA-1.0', instrument: 'ES 12-26' }],
      trading_accounts: [{ id: 'a1', account_name: 'APEX 01' }],
    }, (query) => (query.table === 'strategy_snapshots' && query.columns.includes('source')
      ? { code: '42703', message: 'column strategy_snapshots.source does not exist' }
      : null));
    const stored = await createAutoImportStore(admin).loadStoredFills('client-1', '2026-10-22');
    expect(stored.strategies.map((row) => row.strategyName)).toEqual(['2 - BETA-1.0']);
    expect(admin.reads.filter((read) => read.table === 'strategy_snapshots')).toHaveLength(2);
  });

  it('throws any other failed read, for the route to turn into a retry', async () => {
    const admin = fakeAdmin({ daily_imports: [{ id: 'daily-1' }] },
      (query) => (query.table === 'executions' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    await expect(createAutoImportStore(admin).loadStoredFills('client-1', '2026-10-22')).rejects.toMatchObject({ code: '57014' });
  });

  it('is empty for a day with no close yet', async () => {
    const admin = fakeAdmin({ daily_imports: [] });
    await expect(createAutoImportStore(admin).loadStoredFills('client-1', '2026-10-22'))
      .resolves.toEqual({ executions: [], orders: [], strategies: [] });
    expect(admin.reads.map((read) => read.table)).toEqual(['daily_imports']);
  });
});
