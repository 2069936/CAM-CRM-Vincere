import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalSnapshotPayload,
  createAutoImportStore,
  decodeSnapshotRequest,
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

  it('rejects the exact uncompressed byte overrun before JSON parsing', async () => {
    const json = Buffer.from(JSON.stringify(fixture));
    await expect(decodeSnapshotRequest(request(gzipSync(json)), { maxUncompressedBytes: json.length - 1 }))
      .rejects.toMatchObject({ status: 413, message: 'uncompressed_payload_too_large' });
  });

  it('requires raw gzip bytes and rejects malformed compression with stable errors', async () => {
    await expect(decodeSnapshotRequest({ body: fixture, headers: { 'content-encoding': 'gzip' } }))
      .rejects.toMatchObject({ status: 400, message: 'raw_gzip_body_required' });
    await expect(decodeSnapshotRequest(request(Buffer.from('{"bad":true}'))))
      .rejects.toMatchObject({ status: 400, message: 'invalid_gzip_payload' });
  });
});

describe('auto import Supabase store', () => {
  it('uses an atomic claim RPC with an explicit duplicate signal', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { claimed: false, batch: { id: 'batch-1', daily_import_id: 'daily-1', status: 'processed' } }, error: null });
    const store = createAutoImportStore({ rpc });
    await expect(store.claimBatch({ deviceId: 'device-1', captureId: fixture.captureId, clientId: 'client-1', tradingDate: fixture.tradingDate, capturedAt: fixture.capturedAt, schemaVersion: 1, storagePath: 'path', sha256: 'a'.repeat(64), byteCount: 10, rowCounts: {} }))
      .resolves.toEqual({ claimed: false, duplicate: true, batch: { id: 'batch-1', dailyImportId: 'daily-1', status: 'processed' } });
    expect(rpc).toHaveBeenCalledWith('claim_ingest_batch_v2', expect.objectContaining({ p_capture_id: fixture.captureId }));
  });

  it('uploads immutable gzip without overwrite', async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const store = createAutoImportStore({ storage: { from: () => ({ upload }) } });
    await store.storeRaw('client/date/capture.json.gz', Buffer.from('gzip'));
    expect(upload).toHaveBeenCalledWith('client/date/capture.json.gz', expect.any(Buffer), {
      contentType: 'application/gzip', cacheControl: '31536000', upsert: false,
    });
  });

  it('uses one RPC to finalize batch, device result, audit and late alert', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'batch-1', status: 'late_closed_day', daily_import_id: 'daily-1' }, error: null });
    const store = createAutoImportStore({ rpc });
    await expect(store.completeBatch({
      batchId: 'batch-1', deviceId: 'device-1', status: 'late_closed_day',
      dailyImportId: 'daily-1', capturedAt: fixture.capturedAt, success: true,
      completeness: { isComplete: true }, rowCounts: { accounts: 1 },
      eventType: 'ingest_batch_late_closed_day',
    })).resolves.toEqual({ id: 'batch-1', dailyImportId: 'daily-1', status: 'late_closed_day' });
    expect(rpc).toHaveBeenCalledWith('finalize_ingest_batch', expect.objectContaining({
      p_batch_id: 'batch-1', p_device_id: 'device-1', p_status: 'late_closed_day',
      p_success: true, p_event_type: 'ingest_batch_late_closed_day',
    }));
  });

  it('maps the locked closed-day persistence result without exposing database details', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'P0001', message: 'daily_import_closed', details: 'daily-closed' } });
    const store = createAutoImportStore({ rpc });
    await expect(store.createPersistenceAdapter().persistDailyImportAtomic({
      clientUuid: 'client-1', sourceBatchId: 'batch-1', importResult: { date: '2026-07-23' },
    })).rejects.toMatchObject({ code: 'daily_import_closed', dailyImportId: 'daily-closed' });
  });
});
