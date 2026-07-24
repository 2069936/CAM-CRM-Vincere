import { randomUUID } from 'node:crypto';
import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { createDownloadStore } from './ingest-download.js';
import { createAutoImportStore } from '../_lib/autoImportStore.js';
import { verifyStoredSnapshot } from '../_lib/autoExportDownload.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../_lib/http.js';
import { normalizeAutoImportSnapshot } from '../../src/domain/autoImport.js';
import { reconcileDailyImport } from '../../src/domain/reconcile.js';
import { persistDailyImportWithClient } from '../../src/domain/dailyImportPersistence.js';

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
      const dailyPromise = batch.dailyImportId
        ? admin.from('daily_imports').select('status').eq('id', batch.dailyImportId).maybeSingle()
        : Promise.resolve({ data: null, error: null });
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
    createPersistenceAdapter: ingest.createPersistenceAdapter,
    createClosedReplacementAdapter({ processingToken, actorId, reason }) {
      return {
        isAtomic: true,
        supportsDailyImportSourceColumns: true,
        async persistDailyImportAtomic({ clientUuid, importResult, sourceBatchId }) {
          const { data, error } = await admin.rpc('persist_closed_auto_daily_import_replacement', {
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
  };
}

export async function processStoredReplay({ batch, store, processingToken, actorId, reason, closedReplacement, normalize = normalizeAutoImportSnapshot, reconcile = reconcileDailyImport, persist = persistDailyImportWithClient }) {
  let persisted = false;
  try {
    const compressed = await store.downloadObject(batch.storagePath);
    const { snapshot } = verifyStoredSnapshot({ batch, compressed });
    const normalized = normalize(snapshot);
    const registry = await store.loadRegistry(batch.clientId);
    const importResult = reconcile({ clientId: batch.clientId, date: normalized.date, registry, parsed: normalized.parsed });
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
      try {
        await store.completeBatch({ eventType: 'ingest_batch_failed', clientId: batch.clientId, deviceId: batch.deviceId, batchId: batch.id, dailyImportId: null, processingToken, capturedAt: batch.capturedAt, success: false, status: 'failed', errorCode: 'ingest_failed', rowCounts: batch.rowCounts, completeness: {} });
      } catch { /* the lease remains bounded and the original failure is safer */ }
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
