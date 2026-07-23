import process from 'node:process';
import { createServiceClient } from '../_lib/apiAuth.js';
import {
  createAutoImportStore,
  decodeSnapshotRequest,
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
} from '../_lib/autoImportStore.js';
import { createDeviceAuthStore, requireIngestDevice } from '../_lib/deviceAuth.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../_lib/http.js';
import { normalizeAutoImportSnapshot } from '../../src/domain/autoImport.js';
import { persistDailyImportWithClient } from '../../src/domain/dailyImportPersistence.js';
import { reconcileDailyImport } from '../../src/domain/reconcile.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECTIONS = ['accounts', 'strategies', 'orders', 'executions'];

export const config = { api: { bodyParser: false } };

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envelope(snapshot, { now, maxFutureSkewMs = 5 * 60 * 1000 }) {
  if (!UUID.test(String(snapshot.captureId || ''))
    || !DATE.test(String(snapshot.tradingDate || ''))
    || !Number.isInteger(snapshot.schemaVersion)
    || snapshot.schemaVersion <= 0
    || typeof snapshot.capturedAt !== 'string') {
    throw new ApiError(400, 'invalid_snapshot_envelope');
  }
  const captured = Date.parse(snapshot.capturedAt);
  const reference = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(captured) || Number.isNaN(reference) || captured > reference + maxFutureSkewMs) {
    throw new ApiError(400, 'invalid_snapshot_envelope');
  }
  return {
    captureId: snapshot.captureId,
    tradingDate: snapshot.tradingDate,
    capturedAt: snapshot.capturedAt,
    schemaVersion: snapshot.schemaVersion,
    rowCounts: Object.fromEntries(SECTIONS.map((name) => [name, Array.isArray(snapshot[name]) ? snapshot[name].length : 0])),
  };
}

function publicFailure(stage) {
  if (stage === 'storage') return new ApiError(503, 'snapshot_ingest_failed');
  if (['normalize', 'reconcile', 'persist'].includes(stage)) return new ApiError(422, 'snapshot_processing_failed');
  if (stage === 'registry') return new ApiError(503, 'snapshot_ingest_failed');
  return new ApiError(500, 'snapshot_ingest_unavailable');
}

function failureCode(stage) {
  return ({ storage: 'storage_failed', normalize: 'normalization_failed', registry: 'registry_load_failed', reconcile: 'reconciliation_failed', persist: 'persistence_failed' })[stage] || 'ingest_failed';
}

async function completeBatch(store, payload) {
  if (typeof store.completeBatch === 'function') return store.completeBatch(payload);
  await store.finalizeBatch(payload);
  await store.recordDeviceResult({
    deviceId: payload.deviceId,
    capturedAt: payload.capturedAt,
    success: payload.success,
    errorCode: payload.errorCode,
  });
  return store.writeAudit(payload);
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createAutoImportStore,
  authenticate = requireIngestDevice,
  decodeRequest = decodeSnapshotRequest,
  normalizeSnapshot = normalizeAutoImportSnapshot,
  reconcile = reconcileDailyImport,
  persist = persistDailyImportWithClient,
  pepper = process.env.INGEST_TOKEN_PEPPER,
  maxCompressedBytes = positiveLimit(process.env.AUTO_COLLECTION_MAX_COMPRESSED_BYTES, DEFAULT_MAX_COMPRESSED_BYTES),
  maxUncompressedBytes = positiveLimit(process.env.AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES, DEFAULT_MAX_UNCOMPRESSED_BYTES),
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    let store;
    let device;
    let batch;
    let info;
    let stage = 'request';
    try {
      requireMethod(req, 'POST');
      const admin = createClient();
      device = await authenticate(req, { store: createAuthStore(admin), pepper });
      const decoded = await decodeRequest(req, { maxCompressedBytes, maxUncompressedBytes });
      info = envelope(decoded.snapshot, { now: now() });
      const storagePath = `${device.clientId}/${info.tradingDate}/${info.captureId}.json.gz`;
      store = createStore(admin);
      const claim = await store.claimBatch({
        deviceId: device.id,
        clientId: device.clientId,
        ...info,
        storagePath,
        sha256: decoded.sha256,
        byteCount: decoded.utf8.length,
      });
      batch = claim.batch;
      if (claim.duplicate) {
        return sendJson(res, 200, {
          ok: true, duplicate: true, batchId: batch.id,
          dailyImportId: batch.dailyImportId, status: batch.status,
        });
      }

      stage = 'storage';
      await store.storeRaw(storagePath, decoded.gzip);
      stage = 'normalize';
      const normalized = normalizeSnapshot(decoded.snapshot);
      stage = 'registry';
      const registry = await store.loadRegistry(device.clientId);
      stage = 'reconcile';
      const importResult = reconcile({
        clientId: device.clientId,
        date: normalized.date,
        registry,
        parsed: normalized.parsed,
      });
      stage = 'persist';
      let dailyImport;
      try {
        dailyImport = await persist({
          db: store.createPersistenceAdapter(),
          clientUuid: device.clientId,
          importResult,
          sourceBatchId: batch.id,
        });
      } catch (error) {
        if (error?.code !== 'daily_import_closed') throw error;
        const dailyImportId = error.dailyImportId || null;
        await completeBatch(store, {
          eventType: 'ingest_batch_late_closed_day', clientId: device.clientId,
          deviceId: device.id, batchId: batch.id, dailyImportId,
          capturedAt: info.capturedAt, success: true,
          status: 'late_closed_day', rowCounts: info.rowCounts,
          completeness: normalized.metadata,
        });
        return sendJson(res, 202, { ok: true, duplicate: false, batchId: batch.id, dailyImportId, status: 'late_closed_day' });
      }

      const status = normalized.metadata.isComplete ? 'processed' : 'incomplete';
      await completeBatch(store, {
        eventType: 'ingest_batch_processed', clientId: device.clientId,
        deviceId: device.id, batchId: batch.id, dailyImportId: dailyImport.id,
        capturedAt: info.capturedAt, success: true,
        status, rowCounts: info.rowCounts,
        completeness: {
          isComplete: normalized.metadata.isComplete,
          emptySections: normalized.metadata.emptySections,
        },
      });
      return sendJson(res, 201, {
        ok: true, duplicate: false, batchId: batch.id,
        dailyImportId: dailyImport.id, status,
      });
    } catch (error) {
      if (batch && store) {
        const errorCode = failureCode(stage);
        try {
          await completeBatch(store, {
            eventType: 'ingest_batch_failed', clientId: device.clientId,
            deviceId: device.id, batchId: batch.id, dailyImportId: null,
            capturedAt: info?.capturedAt || new Date().toISOString(),
            success: false, status: 'failed', errorCode,
            completeness: {}, rowCounts: info?.rowCounts || {},
          });
        } catch {
          // Preserve the original stable public failure if cleanup also fails.
        }
        return handleApiError(res, publicFailure(stage), { fallbackMessage: 'snapshot_ingest_unavailable' });
      }
      if (error instanceof ApiError || Number.isInteger(error?.status)) {
        return handleApiError(res, error, { fallbackMessage: 'snapshot_ingest_unavailable' });
      }
      return handleApiError(res, new ApiError(500, 'snapshot_ingest_unavailable'), { fallbackMessage: 'snapshot_ingest_unavailable' });
    }
  };
}

export default createHandler();
