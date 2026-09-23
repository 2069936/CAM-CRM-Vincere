import process from 'node:process';
import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import {
  createAutoImportStore,
  decodeSnapshotRequest,
} from '../../apiLib/autoImportStore.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../../apiLib/http.js';
import { normalizeAutoImportSnapshot } from '../../../src/domain/autoImport.js';
import { persistDailyImportWithClient } from '../../../src/domain/dailyImportPersistence.js';
import { reconcileDailyImport } from '../../../src/domain/reconcile.js';
import { resolveAutoCollectionLimits } from '../../apiLib/autoCollectionLimits.js';
import { normalizeMachineId } from '../../apiLib/ingestTokens.js';

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

function requireSourceMachine(snapshot, req) {
  let sourceMachine;
  let authenticatedMachine;
  try {
    sourceMachine = normalizeMachineId(snapshot?.source?.machineId);
    authenticatedMachine = normalizeMachineId(req?.headers?.['x-machine-id']);
  } catch {
    throw new ApiError(400, 'source_machine_mismatch');
  }
  if (sourceMachine !== authenticatedMachine) throw new ApiError(400, 'source_machine_mismatch');
}

/* A DATABASE THAT IS SLOW IS NOT A SNAPSHOT THAT IS WRONG.
 *
 * Every persist failure used to come back 422 snapshot_processing_failed, and
 * 422 is the answer the agent quarantines on: the capture leaves the queue for
 * good, with a .reason file, and nobody uploads it again. That is the right
 * treatment for a snapshot the CRM cannot make sense of. It is the wrong one
 * for a snapshot the CRM never got to read, because Postgres cancelled the
 * insert on its statement timeout while the project was starved.
 *
 * That is exactly what happened on 2026-09-14 and again on 2026-09-17 at
 * 16:30: four captures, then one more, quarantined on a VPS with nothing wrong
 * in them, while the database behind the CRM answered one-row reads in twenty
 * seconds. The desk lost the first RBO day on that client.
 *
 * So a persist failure whose cause is the connection or the server, not the
 * data, is a 503 now, which the agent retries with backoff and keeps in the
 * queue. Normalize and reconcile stay 422: they are pure functions of the
 * snapshot and fail the same way every time. */
const TRANSIENT_POSTGRES_CODES = new Set([
  '57014', // query_canceled: the statement timeout
  '57P01', '57P02', '57P03', // admin_shutdown, crash_shutdown, cannot_connect_now
  '53300', '53400', // too_many_connections, configuration_limit_exceeded
  '08000', '08001', '08003', '08004', '08006', // connection_exception family
  '40001', '40P01', // serialization_failure, deadlock_detected
  '55P03', // lock_not_available
  'PGRST001', 'PGRST002', 'PGRST003', // PostgREST: connection pool, schema cache, request timeout
]);
const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_TEXT = /statement timeout|canceling statement|timed? ?out|fetch failed|socket hang up|too many connections|connection (?:reset|refused|terminated|closed)|could not connect|server closed the connection|temporarily unavailable|remaining connection slots|\b50[234]\b/i;

export function isTransientStoreError(error) {
  if (!error || error instanceof ApiError) return false;
  const code = String(error.code || '');
  if (TRANSIENT_POSTGRES_CODES.has(code) || TRANSIENT_NODE_CODES.has(code)) return true;
  if (error.cause && isTransientStoreError(error.cause)) return true;
  return TRANSIENT_TEXT.test(`${error.message || ''} ${error.details || ''} ${error.hint || ''}`);
}

function publicFailure(stage, error) {
  if (stage === 'storage') return new ApiError(503, 'snapshot_ingest_failed');
  if (stage === 'persist' && isTransientStoreError(error)) return new ApiError(503, 'snapshot_ingest_failed');
  if (['normalize', 'reconcile', 'persist'].includes(stage)) return new ApiError(422, 'snapshot_processing_failed');
  if (stage === 'registry') return new ApiError(503, 'snapshot_ingest_failed');
  return new ApiError(500, 'snapshot_ingest_unavailable');
}

function failureCode(stage, error) {
  if (stage === 'persist' && isTransientStoreError(error)) return 'persistence_unavailable';
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

/* THE STOPWATCH, SO NOBODY HAS TO GUESS AGAIN.
 *
 * On 2026-09-17 and 18 the only way to say how slow the ingest was running was
 * to read a Supabase dashboard afterwards and infer. Five of the six stages are
 * timed here and handed to the finalize RPC, which adds its own and stores the
 * lot on the batch row; the Auto Collection fleet view reads them back.
 *
 * The sum of the stages is LESS than the total, and that gap is the point of
 * keeping both: what it holds is authentication, the gzip decode and the claim
 * itself, none of which is a stage anyone can act on separately.
 */
export function createStageTimer(clock = () => Date.now()) {
  const durations = {};
  const openedAt = clock();
  let current = null;
  let enteredAt = openedAt;
  function close(at) {
    if (current) durations[current] = (durations[current] || 0) + (at - enteredAt);
    current = null;
  }
  return {
    enter(name) {
      const at = clock();
      close(at);
      current = name;
      enteredAt = at;
      return name;
    },
    // Called once, as the finalize payload is built: it closes whatever stage
    // was open and freezes the total at that moment.
    seal() {
      const at = clock();
      close(at);
      return { stageDurationsMs: { ...durations }, ingestDurationMs: at - openedAt };
    },
  };
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
  env = process.env,
  pepper = resolveIngestPepper(env),
  maxCompressedBytes = resolveAutoCollectionLimits(env).maxCompressedBytes,
  maxUncompressedBytes = resolveAutoCollectionLimits(env).maxUncompressedBytes,
  leaseSeconds = Math.min(600, Math.max(30,
    positiveLimit(env.AUTO_COLLECTION_PROCESSING_LEASE_SECONDS, 120))),
  createProcessingToken = randomUUID,
  now = () => new Date(),
  monotonic = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    let store;
    let device;
    let batch;
    let info;
    let processingToken;
    let stage = 'request';
    const timer = createStageTimer(monotonic);
    try {
      requireMethod(req, 'POST');
      const admin = createClient();
      device = await authenticate(req, { store: createAuthStore(admin), pepper });
      const decoded = await decodeRequest(req, { maxCompressedBytes, maxUncompressedBytes });
      requireSourceMachine(decoded.snapshot, req);
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
      /* THE DOOR. A DIFFERENT ANSWER FROM 'busy', DELIBERATELY.
       *
       * 409 capture_processing says this capture is already being processed;
       * this says the server is full and has nothing to do with this capture.
       * They are kept apart in the outcome, in the status code and in the
       * public error name so that a desk reading the fleet view can tell a
       * duplicate upload from a shed one.
       *
       * 429 with Retry-After because that is what the fleet already obeys:
       * RetryPolicy in 1.0.3, 1.0.4 and 1.0.5 retries a 429, uses the header,
       * caps the wait at two minutes, and leaves the item in the queue
       * afterwards. Nothing is finalized here, nothing is stored, and the batch
       * row the claim left behind is still claimable, so the retry is the
       * ordinary first attempt it would have been a minute earlier. */
      if (claim.outcome === 'at_capacity') {
        if (claim.retryAfterSeconds > 0) res.setHeader('Retry-After', String(claim.retryAfterSeconds));
        return sendJson(res, 429, {
          error: 'ingest_at_capacity', batchId: batch.id, status: batch.status,
          retryAfterSeconds: claim.retryAfterSeconds || 0,
        });
      }
      if (claim.outcome !== 'owned') throw new ApiError(500, 'snapshot_ingest_unavailable');

      stage = timer.enter('storage');
      await store.ensureRaw(storagePath, decoded.gzip, {
        sha256: decoded.sha256,
        byteCount: decoded.utf8.length,
        compressedByteCount: decoded.gzip.length,
        maxCompressedBytes,
      });
      stage = timer.enter('normalize');
      const normalized = normalizeSnapshot(decoded.snapshot);
      stage = timer.enter('registry');
      const registry = await store.loadRegistry(device.clientId);
      stage = timer.enter('reconcile');
      // NO `priorImports` HERE, AND THAT IS A KNOWN GAP, NOT A DECISION THAT
      // NOTHING WAS OPEN. reconcileDailyImport uses the client's previous closes
      // to price a lot opened yesterday and closed today (carryForwardLots.js).
      // The browser paths pass them because supabaseStore already loads each
      // daily_import's executions; this path holds only a device batch, so
      // supplying them needs a new store read over `daily_imports` -> `executions`
      // / `orders` for the days before `normalized.date`.
      //
      // The effect of the gap is a REFUSAL, never a wrong number: an account with
      // a carried-in book comes back status 'refused' and publishes no per-algo
      // split, exactly as it did before carry-in was handled at all. No real
      // export has yet contained such a book (0 of 25 on 2026-08-18, 0 of 31 on
      // 2026-08-19), so nothing observed is currently being refused here.
      const importResult = reconcile({
        clientId: device.clientId,
        date: normalized.date,
        registry,
        parsed: normalized.parsed,
      });
      stage = timer.enter('persist');
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
          ...timer.seal(),
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
          ...timer.seal(),
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
        ...timer.seal(),
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
        const errorCode = preciseValidationCode || preciseStorageCode || failureCode(stage, error);
        // A transient persist failure takes the storage stage's exit: release
        // the lease so the batch goes back to 'received' and the agent's
        // retry of the SAME capture is claimed again. Finalizing it as failed
        // here would make that retry a 409 capture_requires_replay, which the
        // agent treats as operator action and quarantines: the 503 would have
        // promised a retry it could not keep.
        const transientPersist = stage === 'persist' && isTransientStoreError(error);
        if ((stage === 'storage' && error?.message !== 'immutable_object_conflict') || transientPersist) {
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
          return handleApiError(res, publicFailure(stage, error), {
            fallbackMessage: 'snapshot_ingest_unavailable',
            underlying: error,
          });
        }
        try {
          await completeBatch(store, {
            eventType: 'ingest_batch_failed', clientId: device.clientId,
            deviceId: device.id, batchId: batch.id, dailyImportId: null,
            processingToken,
            capturedAt: info?.capturedAt || new Date().toISOString(),
            success: false, status: 'failed', errorCode,
            completeness: {}, rowCounts: info?.rowCounts || {},
            // A failure is worth timing too: the stage it died in and how long
            // it took there is the first question anyone asks about one.
            ...timer.seal(),
          });
        } catch (completionError) {
          if (isDeviceCredentialError(completionError)) return sendDeviceCredentialError(res);
          // Preserve the original stable public failure if cleanup also fails.
        }
        const failure = preciseValidationCode
          ? new ApiError(422, preciseValidationCode)
          : (error instanceof ApiError && error.status === 409 ? error : publicFailure(stage, error));
        return handleApiError(res, failure, {
          fallbackMessage: 'snapshot_ingest_unavailable',
          underlying: error,
        });
      }
      if (error instanceof ApiError || Number.isInteger(error?.status)) {
        const exposed = error?.code === 'capture_metadata_conflict'
          ? new ApiError(409, 'capture_metadata_conflict')
          : error;
        return handleApiError(res, exposed, { fallbackMessage: 'snapshot_ingest_unavailable' });
      }
      // THE ONE THAT HID EVERYTHING. Replacing the error with a clean ApiError
      // here is what made every unexpected upload failure a silent 500 with no
      // log line and no cause, which is exactly the state the desk spent days
      // in. The public answer is unchanged; the reason now reaches the log.
      return handleApiError(res, new ApiError(500, 'snapshot_ingest_unavailable'), {
        fallbackMessage: 'snapshot_ingest_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
