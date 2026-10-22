import { randomUUID } from 'node:crypto';
import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { createDownloadStore } from './ingest-download.js';
import { createAutoImportStore, recordValidationReason } from '../../apiLib/autoImportStore.js';
import { verifyStoredSnapshot } from '../../apiLib/autoExportDownload.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { normalizeAutoImportSnapshot } from '../../../src/domain/autoImport.js';
import { VALIDATION_REASON_CODES } from '../../../src/domain/autoImportValidationReason.js';
import { reconcileDailyImport } from '../../../src/domain/reconcile.js';
import { persistDailyImportWithClient } from '../../../src/domain/dailyImportPersistence.js';
import { addStoredFills } from '../../../src/domain/storedFills.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLAYABLE = new Set(['failed', 'incomplete', 'late_closed_day', 'processing']);
const TERMINAL = new Set(['processed', 'replaced']);

export function parseReplayBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_reprocess_request');
  const batchId = String(body.batchId || '').trim().toLowerCase();
  if (!UUID.test(batchId)) throw new ApiError(400, 'invalid_batch_id');
  const reason = String(body.reason || '').trim();
  if (reason.length < 10 || reason.length > 500) throw new ApiError(400, 'invalid_reprocess_reason');
  const confirmation = String(body.confirmation || '').trim();
  if (confirmation.length > 300) throw new ApiError(400, 'invalid_reprocess_confirmation');
  return { batchId, reason, confirmClosedDay: body.confirmClosedDay === true, confirmation };
}

export function createReplayStore(admin) {
  const download = createDownloadStore(admin);
  const ingest = createAutoImportStore(admin);
  return {
    async getBatch(batchId) {
      const batch = await download.getBatch(batchId);
      if (!batch) return null;
      const clientPromise = admin.from('clients').select('name').eq('id', batch.clientId).maybeSingle();
      // THE DAY, NOT THIS BATCH'S IMPORT.
      //
      // A failed batch has no daily import of its own, so looking the day up
      // through batch.dailyImportId answered null for every batch a replay
      // would ever be aimed at, and closedDay was therefore always false. The
      // day was still closed: a CAM had filled it by hand precisely because
      // the automatic capture failed. The replay then walked past the guard,
      // claimed a lease, downloaded the snapshot and only learned the truth
      // when persistence refused, which reached the desk as a nameless
      // failure. The day the replay would write is the day to ask about.
      const dailyPromise = admin.from('daily_imports')
        .select('status')
        .eq('client_id', batch.clientId)
        .eq('trading_date', batch.tradingDate)
        .maybeSingle();
      const modePromise = admin.from('ingest_batches').select('reprocess_mode').eq('id', batch.id).maybeSingle();
      const [{ data: client, error }, { data: daily, error: dailyError }, { data: mode, error: modeError }] = await Promise.all([clientPromise, dailyPromise, modePromise]);
      if (error || dailyError || modeError) throw error || dailyError || modeError;
      return { ...batch, clientName: client?.name || 'Client', closedDay: daily?.status === 'Closed', reprocessMode: mode?.reprocess_mode || null };
    },
    async claimReplay(payload) {
      const { data, error } = await admin.rpc('claim_ingest_batch_reprocess', {
        p_batch_id: payload.batchId, p_actor_id: payload.actorId,
        p_processing_token: payload.processingToken, p_lease_seconds: 300,
        p_confirm_closed_day: payload.confirmClosedDay, p_reason: payload.reason,
      });
      if (error) throw error;
      const value = Array.isArray(data) ? data[0] : data;
      if (!value?.outcome) throw new Error('Replay claim returned no outcome.');
      return value;
    },
    downloadObject: download.downloadObject,
    loadRegistry: ingest.loadRegistry,
    loadStoredFills: ingest.loadStoredFills,
    createPersistenceAdapter: ingest.createPersistenceAdapter,
    createClosedReplacementAdapter({ processingToken, actorId, reason }) {
      return {
        isAtomic: true,
        supportsDailyImportSourceColumns: true,
        async persistDailyImportAtomic({ clientUuid, importResult, sourceBatchId }) {
          const { data, error } = await admin.rpc('persist_closed_auto_daily_import_replacement_v2', {
            p_client_id: clientUuid, p_source_batch_id: sourceBatchId,
            p_processing_token: processingToken, p_actor_id: actorId,
            p_reason: reason, p_import_result: importResult,
          });
          if (error) throw error;
          const value = Array.isArray(data) ? data[0] : data;
          if (!value?.daily_import?.id) throw new Error('Closed replacement returned no daily import.');
          return { ...value.daily_import, disposition: 'persisted' };
        },
      };
    },
    completeBatch: ingest.completeBatch,
    recordBatchErrorDetail: ingest.recordBatchErrorDetail,
  };
}

/* A REPLAY REFUSED BY THE VALIDATOR IS RECORDED AS THE UPLOAD WAS.
 *
 * Every replay failure used to be recorded 'ingest_failed', so replaying a
 * close refused as invalid_auto_import_snapshot overwrote that code with a
 * vaguer one, and step 69 (which writes a reason only for the two validation
 * codes) would have nothing to write it on. The validator speaks in three
 * places on this path: normalize, as at upload; the stored snapshot's contract
 * check in verifyStoredSnapshot, whose bytes matched their hash and still
 * break the contract; and the schema version check in front of both. Each is
 * recorded with the code the upload got and the rules it broke. */
function validationRefusal(error) {
  if (VALIDATION_REASON_CODES.includes(error?.code) && Array.isArray(error?.errors)) {
    return { code: error.code, errors: error.errors };
  }
  if (Array.isArray(error?.validationErrors)) return { code: 'invalid_auto_import_snapshot', errors: error.validationErrors };
  if (error instanceof ApiError && error.message === 'unsupported_schema_version') {
    return { code: 'unsupported_schema_version', errors: ['schemaVersion must be 1'] };
  }
  return null;
}

export async function processStoredReplay({ batch, store, processingToken, actorId, reason, closedReplacement, normalize = normalizeAutoImportSnapshot, reconcile = reconcileDailyImport, persist = persistDailyImportWithClient }) {
  let persisted = false;
  try {
    const compressed = await store.downloadObject(batch.storagePath);
    const { snapshot } = verifyStoredSnapshot({ batch, compressed });
    const normalized = normalize(snapshot);
    const registry = await store.loadRegistry(batch.clientId);
    // A normal replay merges into the day like the ingest route (step 73), so
    // its split is worked out over the day's stored fills too. Replace closed
    // day replaces the day's fills, so it is worked out over the snapshot alone.
    const parsed = closedReplacement
      ? normalized.parsed
      : await addStoredFills({ store, clientId: batch.clientId, date: normalized.date, parsed: normalized.parsed });
    const importResult = reconcile({ clientId: batch.clientId, date: normalized.date, registry, parsed });
    const adapter = closedReplacement
      ? store.createClosedReplacementAdapter({ processingToken, actorId, reason })
      : store.createPersistenceAdapter(processingToken);
    const dailyImport = await persist({ db: adapter, clientUuid: batch.clientId, importResult, sourceBatchId: batch.id });
    persisted = true;
    const status = normalized.metadata.isComplete ? 'processed' : 'incomplete';
    await store.completeBatch({
      eventType: 'ingest_batch_processed', clientId: batch.clientId, deviceId: batch.deviceId,
      batchId: batch.id, dailyImportId: dailyImport.id, processingToken,
      capturedAt: batch.capturedAt, success: true, status,
      rowCounts: batch.rowCounts, completeness: normalized.metadata,
    });
    return { status, dailyImportId: dailyImport.id };
  } catch (error) {
    if (!persisted) {
      const refusal = validationRefusal(error);
      let finalized = false;
      try {
        await store.completeBatch({ eventType: 'ingest_batch_failed', clientId: batch.clientId, deviceId: batch.deviceId, batchId: batch.id, dailyImportId: null, processingToken, capturedAt: batch.capturedAt, success: false, status: 'failed', errorCode: refusal?.code || 'ingest_failed', rowCounts: batch.rowCounts, completeness: {} });
        finalized = true;
      } catch { /* the lease remains bounded and the original failure is safer */ }
      // Why, after the finalize that clears it; best effort, never throws.
      if (finalized && refusal) await recordValidationReason(store, batch.id, refusal.errors);
    }
    throw error;
  }
}

function safeError(error) { return error instanceof ApiError ? error : new ApiError(500, 'batch_reprocess_failed'); }

export function createHandler({ createClients = createApiClients, authorize = requireAppUser, createStore = createReplayStore, processReplay = processStoredReplay, createProcessingToken = randomUUID } = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST']);
      const { admin, auth } = createClients();
      const actor = await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const input = parseReplayBody(await readJsonBody(req, { maxBytes: 2048 }));
      const store = createStore(admin);
      const batch = await store.getBatch(input.batchId);
      if (!batch) throw new ApiError(404, 'batch_not_found');
      const closedReplacement = batch.status === 'late_closed_day' || batch.reprocessMode === 'closed_day'
        || (batch.status === 'processing' && batch.closedDay && input.confirmClosedDay);
      const expected = `${closedReplacement ? 'REPLACE' : 'REPROCESS'} ${batch.clientName} ${batch.tradingDate}`;
      if (closedReplacement) {
        if (!input.confirmClosedDay || input.confirmation !== expected) throw new ApiError(409, 'closed_day_confirmation_required');
      } else if (input.confirmation !== expected) {
        throw new ApiError(409, 'reprocess_confirmation_required');
      } else if (!REPLAYABLE.has(batch.status) && !TERMINAL.has(batch.status)) {
        throw new ApiError(409, 'batch_not_replayable');
      }
      const processingToken = createProcessingToken();
      const claim = await store.claimReplay({ batchId: batch.id, actorId: actor.id, processingToken, confirmClosedDay: closedReplacement, reason: input.reason });
      if (claim.outcome === 'terminal') return sendJson(res, 200, { ok: true, duplicate: true, batchId: batch.id, status: batch.status, dailyImportId: batch.dailyImportId || null });
      if (claim.outcome === 'busy') throw new ApiError(409, 'batch_reprocess_busy', { headers: { 'Retry-After': String(claim.retry_after_seconds || 30) } });
      if (claim.outcome !== 'owned') throw new ApiError(409, 'batch_not_replayable');
      const result = await processReplay({ batch, store, processingToken, actorId: actor.id, reason: input.reason, closedReplacement });
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, { ok: true, duplicate: false, batchId: batch.id, ...result });
    } catch (error) {
      return handleApiError(res, safeError(error), { fallbackMessage: 'batch_reprocess_failed' });
    }
  };
}

export default createHandler();
