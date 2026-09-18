import { randomUUID } from 'node:crypto';
import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { createReplayStore, processStoredReplay } from './ingest-reprocess.js';

/* THE QUARANTINE THE DESK CAN CLEAR FROM ITS OWN SCREEN.
 *
 * When the CRM answers 422 to an upload, the agent quarantines the capture on
 * the VPS and never sends it again. But by then the CRM has already stored the
 * raw snapshot (the storage stage runs before anything can refuse it) and
 * recorded a failed batch. So every quarantine of that kind exists here too,
 * with its evidence, and the fix for it is nearly always on this side: a
 * normalizer that was too strict, a database that timed out. Once that fix is
 * deployed, the batches need replaying, and asking a CAM to type a reason and
 * a confirmation once per batch per client is how a week of closes stays
 * unrecovered.
 *
 * This replays a list of failed batches under one reason. It is deliberately
 * narrower than the single-batch replay: only status 'failed', never a closed
 * day replacement (those keep their typed confirmation), at most fifty per
 * call, and every batch reports its own outcome so a replay that fails again
 * is visible rather than averaged away. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_BATCHES_PER_CALL = 50;

export function parseBulkReplayBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_reprocess_request');
  if (!Array.isArray(body.batchIds) || body.batchIds.length === 0) throw new ApiError(400, 'invalid_batch_id');
  if (body.batchIds.length > MAX_BATCHES_PER_CALL) throw new ApiError(400, 'too_many_batches');
  const batchIds = [];
  for (const value of body.batchIds) {
    const id = String(value || '').trim().toLowerCase();
    if (!UUID.test(id)) throw new ApiError(400, 'invalid_batch_id');
    if (!batchIds.includes(id)) batchIds.push(id);
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 10 || reason.length > 500) throw new ApiError(400, 'invalid_reprocess_reason');
  return { batchIds, reason };
}

function publicOutcome(error) {
  if (error instanceof ApiError) return error.message;
  return 'batch_reprocess_failed';
}

export async function replayOne({ batchId, store, actorId, reason, processReplay, createProcessingToken }) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { batchId, outcome: 'not_found' };
  const base = { batchId, clientUuid: batch.clientId, clientName: batch.clientName, tradingDate: batch.tradingDate };
  if (batch.status !== 'failed') return { ...base, outcome: 'skipped', reason: `status_${batch.status}` };
  if (batch.reprocessMode === 'closed_day' || batch.closedDay) return { ...base, outcome: 'skipped', reason: 'closed_day_needs_confirmation' };
  const processingToken = createProcessingToken();
  try {
    const claim = await store.claimReplay({ batchId: batch.id, actorId, processingToken, confirmClosedDay: false, reason });
    if (claim.outcome === 'terminal') return { ...base, outcome: 'already_terminal', status: batch.status };
    if (claim.outcome === 'busy') return { ...base, outcome: 'busy' };
    if (claim.outcome !== 'owned') return { ...base, outcome: 'not_replayable' };
    const result = await processReplay({ batch, store, processingToken, actorId, reason, closedReplacement: false });
    return { ...base, outcome: 'replayed', status: result.status, dailyImportId: result.dailyImportId };
  } catch (error) {
    // The batch is recorded failed again by processStoredReplay; what the
    // caller needs is that THIS one did not make it, not a 500 for the lot.
    return { ...base, outcome: 'failed', error: publicOutcome(error) };
  }
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createReplayStore,
  processReplay = processStoredReplay,
  createProcessingToken = randomUUID,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST']);
      const { admin, auth } = createClients();
      const actor = await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const input = parseBulkReplayBody(await readJsonBody(req, { maxBytes: 8192 }));
      const store = createStore(admin);
      const results = [];
      // One at a time on purpose: each replay holds a lease and writes a
      // daily import, and the database behind this has been the bottleneck.
      for (const batchId of input.batchIds) {
        results.push(await replayOne({ batchId, store, actorId: actor.id, reason: input.reason, processReplay, createProcessingToken }));
      }
      const replayed = results.filter((result) => result.outcome === 'replayed').length;
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, { ok: true, requested: input.batchIds.length, replayed, results });
    } catch (error) {
      return handleApiError(res, error instanceof ApiError ? error : new ApiError(500, 'batch_reprocess_failed'), { fallbackMessage: 'batch_reprocess_failed' });
    }
  };
}

export default createHandler();
