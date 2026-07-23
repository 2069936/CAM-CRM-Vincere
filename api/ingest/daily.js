import process from 'node:process';
import { randomUUID } from 'node:crypto';
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
const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const SECTIONS = ['accounts', 'strategies', 'orders', 'executions'];
const SUCCESS_STATES = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);

export const config = { api: { bodyParser: false } };

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validDate(value) {
  if (!DATE.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validOffsetTimestamp(value) {
  const match = typeof value === 'string' ? OFFSET_TIMESTAMP.exec(value) : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  const date = new Date(Date.UTC(year, month - 1, day));
  const calendar = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const offset = offsetHour === undefined || (offsetHour < 14 && offsetMinute <= 59) || (offsetHour === 14 && offsetMinute === 0);
  return calendar && hour <= 23 && minute <= 59 && second <= 59 && offset && !Number.isNaN(Date.parse(value));
}

function envelope(snapshot, { now, maxFutureSkewMs = 5 * 60 * 1000 }) {
  if (!UUID.test(String(snapshot.captureId || ''))
    || !validDate(snapshot.tradingDate)
    || !Number.isInteger(snapshot.schemaVersion)
    || snapshot.schemaVersion <= 0
    || !validOffsetTimestamp(snapshot.capturedAt)) {
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

function isDeviceCredentialError(error) {
  return error?.code === 'invalid_device_credential'
    || (error instanceof ApiError && error.message === 'invalid_device_credential');
}

function sendDeviceCredentialError(res) {
  return handleApiError(res, new ApiError(401, 'invalid_device_credential'), {
    fallbackMessage: 'snapshot_ingest_unavailable',
  });
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
  leaseSeconds = Math.min(600, Math.max(30,
    positiveLimit(process.env.AUTO_COLLECTION_PROCESSING_LEASE_SECONDS, 120))),
  createProcessingToken = randomUUID,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    let store;
    let device;
    let batch;
    let info;
    let processingToken;
    let stage = 'request';
    try {
      requireMethod(req, 'POST');
      const admin = createClient();
      device = await authenticate(req, { store: createAuthStore(admin), pepper });
      const decoded = await decodeRequest(req, { maxCompressedBytes, maxUncompressedBytes });
      info = envelope(decoded.snapshot, { now: now() });
      const storagePath = `${device.clientId}/${info.tradingDate}/${info.captureId}.json.gz`;
      processingToken = createProcessingToken();
      store = createStore(admin);
      const claim = await store.claimBatch({
        deviceId: device.id,
        clientId: device.clientId,
        ...info,
        storagePath,
        sha256: decoded.sha256,
        byteCount: decoded.utf8.length,
        processingToken,
        leaseSeconds,
      });
      batch = claim.batch;
      if (claim.outcome === 'terminal') {
        if (!SUCCESS_STATES.has(batch.status)) throw new ApiError(500, 'snapshot_ingest_unavailable');
        return sendJson(res, 200, {
          ok: true, duplicate: true, batchId: batch.id,
          dailyImportId: batch.dailyImportId, status: batch.status,
        });
      }
      if (claim.outcome === 'busy') {
        if (claim.retryAfterSeconds > 0) res.setHeader('Retry-After', String(claim.retryAfterSeconds));
        return sendJson(res, 409, {
          error: 'capture_processing', batchId: batch.id, status: batch.status,
        });
      }
      if (claim.outcome === 'failed') {
        return sendJson(res, 409, {
          error: 'capture_requires_replay', errorCode: batch.errorCode,
          batchId: batch.id, status: batch.status,
        });
      }
      if (claim.outcome !== 'owned') throw new ApiError(500, 'snapshot_ingest_unavailable');

      stage = 'storage';
      await store.ensureRaw(storagePath, decoded.gzip, {
        sha256: decoded.sha256,
        byteCount: decoded.utf8.length,
        compressedByteCount: decoded.gzip.length,
        maxCompressedBytes,
      });
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
          db: store.createPersistenceAdapter(processingToken),
          clientUuid: device.clientId,
          importResult,
          sourceBatchId: batch.id,
        });
      } catch (error) {
        if (error?.code !== 'daily_import_closed') throw error;
        const dailyImportId = error.dailyImportId || null;
        stage = 'finalize';
        await completeBatch(store, {
          eventType: 'ingest_batch_late_closed_day', clientId: device.clientId,
          deviceId: device.id, batchId: batch.id, dailyImportId,
          processingToken,
          capturedAt: info.capturedAt, success: true,
          status: 'late_closed_day', rowCounts: info.rowCounts,
          completeness: normalized.metadata,
        });
        return sendJson(res, 202, { ok: true, duplicate: false, batchId: batch.id, dailyImportId, status: 'late_closed_day' });
      }

      if (dailyImport.disposition === 'superseded') {
        stage = 'finalize';
        await completeBatch(store, {
          eventType: 'ingest_batch_superseded', clientId: device.clientId,
          deviceId: device.id, batchId: batch.id, dailyImportId: dailyImport.id,
          processingToken, capturedAt: info.capturedAt, success: true,
          status: 'replaced', rowCounts: info.rowCounts,
          completeness: {
            isComplete: normalized.metadata.isComplete,
            emptySections: normalized.metadata.emptySections,
          },
        });
        return sendJson(res, 201, {
          ok: true, duplicate: false, batchId: batch.id,
          dailyImportId: dailyImport.id, status: 'replaced',
        });
      }

      const status = normalized.metadata.isComplete ? 'processed' : 'incomplete';
      stage = 'finalize';
      await completeBatch(store, {
        eventType: 'ingest_batch_processed', clientId: device.clientId,
        deviceId: device.id, batchId: batch.id, dailyImportId: dailyImport.id,
        processingToken,
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
      if (isDeviceCredentialError(error)) return sendDeviceCredentialError(res);
      if (batch && store) {
        if (stage === 'finalize') {
          const finalizationError = error instanceof ApiError && error.status === 409
            ? error
            : new ApiError(503, 'snapshot_finalization_pending');
          return handleApiError(res, finalizationError, {
            fallbackMessage: 'snapshot_ingest_unavailable',
          });
        }
        const preciseValidationCode = stage === 'normalize'
          && ['unsupported_schema_version', 'invalid_auto_import_snapshot'].includes(error?.code)
          ? error.code
          : null;
        const preciseStorageCode = stage === 'storage' && error?.message === 'immutable_object_conflict'
          ? 'immutable_object_conflict'
          : null;
        const errorCode = preciseValidationCode || preciseStorageCode || failureCode(stage);
        if (stage === 'storage' && error?.message !== 'immutable_object_conflict') {
          try {
            await store.releaseLease({
              batchId: batch.id,
              deviceId: device.id,
              processingToken,
            });
          } catch (releaseError) {
            if (isDeviceCredentialError(releaseError)) return sendDeviceCredentialError(res);
            // The bounded lease remains recoverable if an explicit release fails.
          }
          return handleApiError(res, publicFailure(stage), { fallbackMessage: 'snapshot_ingest_unavailable' });
        }
        try {
          await completeBatch(store, {
            eventType: 'ingest_batch_failed', clientId: device.clientId,
            deviceId: device.id, batchId: batch.id, dailyImportId: null,
            processingToken,
            capturedAt: info?.capturedAt || new Date().toISOString(),
            success: false, status: 'failed', errorCode,
            completeness: {}, rowCounts: info?.rowCounts || {},
          });
        } catch (completionError) {
          if (isDeviceCredentialError(completionError)) return sendDeviceCredentialError(res);
          // Preserve the original stable public failure if cleanup also fails.
        }
        const failure = preciseValidationCode
          ? new ApiError(422, preciseValidationCode)
          : (error instanceof ApiError && error.status === 409 ? error : publicFailure(stage));
        return handleApiError(res, failure, { fallbackMessage: 'snapshot_ingest_unavailable' });
      }
      if (error instanceof ApiError || Number.isInteger(error?.status)) {
        const exposed = error?.code === 'capture_metadata_conflict'
          ? new ApiError(409, 'capture_metadata_conflict')
          : error;
        return handleApiError(res, exposed, { fallbackMessage: 'snapshot_ingest_unavailable' });
      }
      return handleApiError(res, new ApiError(500, 'snapshot_ingest_unavailable'), { fallbackMessage: 'snapshot_ingest_unavailable' });
    }
  };
}

export default createHandler();
