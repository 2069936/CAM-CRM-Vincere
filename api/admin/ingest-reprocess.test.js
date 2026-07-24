import { describe, expect, it, vi } from 'vitest';
import snapshotFixture from '../../test/fixtures/auto-export/snapshot-v1.json';
import { canonicalSnapshotPayload } from '../_lib/autoImportStore.js';
import { createHandler, createReplayStore, parseReplayBody, processStoredReplay } from './ingest-reprocess.js';
import { ApiError } from '../_lib/http.js';

const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const baseBatch = { id: BATCH_ID, clientId: CLIENT_ID, clientName: 'Acme Trading', deviceId: '22222222-2222-4222-8222-222222222222', tradingDate: '2026-07-23', capturedAt: '2026-07-23T20:45:00Z', status: 'failed', rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 } };

function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function setup({ batch = baseBatch, outcome = 'owned', authorizeError } = {}) {
  const store = { getBatch: vi.fn(async () => batch), claimReplay: vi.fn(async () => ({ outcome, batch })) };
  const processReplay = vi.fn(async () => ({ status: 'processed', dailyImportId: 'daily-1' }));
  const authorize = vi.fn(async () => { if (authorizeError) throw authorizeError; return { id: 'manager-1', role: 'Manager' }; });
  return { store, processReplay, handler: createHandler({ createClients: () => ({ admin: {}, auth: {} }), authorize, createStore: () => store, processReplay, createProcessingToken: () => '99999999-9999-4999-8999-999999999999' }) };
}

describe('controlled batch replay', () => {
  it.each(['failed', 'incomplete'])('replays a %s batch from its immutable evidence', async (status) => {
    const { handler, store, processReplay } = setup({ batch: { ...baseBatch, status } });
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Reviewed collector failure', confirmation: 'REPROCESS Acme Trading 2026-07-23' } }, res);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, status: 'processed', batchId: BATCH_ID } });
    expect(store.claimReplay).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'manager-1', confirmClosedDay: false, reason: 'Reviewed collector failure' }));
    expect(processReplay).toHaveBeenCalledWith(expect.objectContaining({ batch: expect.objectContaining({ id: BATCH_ID }), closedReplacement: false }));
  });

  it('returns an idempotent success without processing an already successful batch', async () => {
    const { handler, processReplay } = setup({ batch: { ...baseBatch, status: 'processed' }, outcome: 'terminal' });
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Verified duplicate request', confirmation: 'REPROCESS Acme Trading 2026-07-23' } }, res);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, duplicate: true, status: 'processed' } });
    expect(processReplay).not.toHaveBeenCalled();
  });

  it('requires explicit client/date confirmation and a reason for a closed day', async () => {
    const batch = { ...baseBatch, status: 'late_closed_day' };
    const { handler, store, processReplay } = setup({ batch });
    for (const body of [
      { batchId: BATCH_ID, reason: 'Approved correction' },
      { batchId: BATCH_ID, reason: 'Approved correction', confirmClosedDay: true, confirmation: 'wrong' },
    ]) {
      const res = response(); await handler({ method: 'POST', body }, res);
      expect(res).toMatchObject({ statusCode: 409, body: { error: 'closed_day_confirmation_required' } });
    }
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Approved correction', confirmClosedDay: true, confirmation: 'REPLACE Acme Trading 2026-07-23' } }, res);
    expect(res.statusCode).toBe(200);
    expect(store.claimReplay).toHaveBeenLastCalledWith(expect.objectContaining({ confirmClosedDay: true }));
    expect(processReplay).toHaveBeenCalledWith(expect.objectContaining({ closedReplacement: true }));
  });

  it('preserves closed-day confirmation semantics when retrying an expired processing lease', async () => {
    const batch = { ...baseBatch, status: 'processing', closedDay: true, reprocessMode: 'closed_day' };
    const { handler, processReplay } = setup({ batch });
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Retry after finalizer outage', confirmClosedDay: true, confirmation: 'REPLACE Acme Trading 2026-07-23' } }, res);
    expect(res.statusCode).toBe(200);
    expect(processReplay).toHaveBeenCalledWith(expect.objectContaining({ closedReplacement: true }));
  });

  it('retains closed-day mode after a failed processing attempt', async () => {
    const batch = { ...baseBatch, status: 'failed', reprocessMode: 'closed_day' };
    const { handler, processReplay } = setup({ batch });
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Retry closed replacement safely', confirmClosedDay: true, confirmation: 'REPLACE Acme Trading 2026-07-23' } }, res);
    expect(res.statusCode).toBe(200);
    expect(processReplay).toHaveBeenCalledWith(expect.objectContaining({ closedReplacement: true }));
  });

  it('allows a normal confirmed retry to reach the lease-aware claim', async () => {
    const batch = { ...baseBatch, status: 'processing', closedDay: false };
    const { handler, processReplay } = setup({ batch });
    const res = response();
    await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Retry after finalizer outage', confirmation: 'REPROCESS Acme Trading 2026-07-23' } }, res);
    expect(res.statusCode).toBe(200);
    expect(processReplay).toHaveBeenCalledWith(expect.objectContaining({ closedReplacement: false }));
  });

  it('authorizes a Manager before reading or validating the batch', async () => {
    const { handler, store } = setup({ authorizeError: new ApiError(403, 'Manager permission required.') });
    const res = response(); await handler({ method: 'POST', body: { batchId: 'bad' } }, res);
    expect(res).toMatchObject({ statusCode: 403 });
    expect(store.getBatch).not.toHaveBeenCalled();
  });

  it.each([
    [{ batchId: 'bad', reason: 'A valid operational reason' }, 'invalid_batch_id'],
    [{ batchId: BATCH_ID, reason: 'short' }, 'invalid_reprocess_reason'],
  ])('rejects invalid input %#', (body, error) => {
    expect(() => parseReplayBody(body)).toThrow(expect.objectContaining({ status: 400, message: error }));
  });
});

describe('immutable stored replay processor', () => {
  function replayEvidence() {
    const canonical = canonicalSnapshotPayload(snapshotFixture);
    const batch = {
      ...baseBatch, captureId: snapshotFixture.captureId, capturedAt: snapshotFixture.capturedAt,
      tradingDate: snapshotFixture.tradingDate, schemaVersion: 1,
      storagePath: `${CLIENT_ID}/${snapshotFixture.tradingDate}/${snapshotFixture.captureId}.json.gz`,
      contentSha256: canonical.sha256, byteCount: canonical.utf8.length,
      rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
    };
    return { canonical, batch };
  }

  it.each([false, true])('verifies immutable bytes and uses the correct atomic adapter (closed=%s)', async (closedReplacement) => {
    const { canonical, batch } = replayEvidence();
    const normalAdapter = { kind: 'normal' };
    const closedAdapter = { kind: 'closed' };
    const store = {
      downloadObject: vi.fn(async () => canonical.gzip), loadRegistry: vi.fn(async () => ({})),
      createPersistenceAdapter: vi.fn(() => normalAdapter), createClosedReplacementAdapter: vi.fn(() => closedAdapter),
      completeBatch: vi.fn(async () => undefined),
    };
    const normalize = vi.fn(() => ({ date: batch.tradingDate, parsed: {}, metadata: { isComplete: true, emptySections: [] } }));
    const reconcile = vi.fn(() => ({ date: batch.tradingDate }));
    const persist = vi.fn(async ({ db }) => ({ id: 'daily-1', adapter: db.kind }));
    await expect(processStoredReplay({ batch, store, processingToken: 'token', actorId: 'manager-1', reason: 'Approved replay reason', closedReplacement, normalize, reconcile, persist })).resolves.toMatchObject({ status: 'processed', dailyImportId: 'daily-1' });
    expect(normalize).toHaveBeenCalledWith(expect.objectContaining({ captureId: snapshotFixture.captureId }));
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ db: closedReplacement ? closedAdapter : normalAdapter, sourceBatchId: batch.id }));
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'processed', success: true }));
  });

  it('records a failed attempt without changing the immutable object', async () => {
    const { canonical, batch } = replayEvidence();
    const store = { downloadObject: vi.fn(async () => canonical.gzip), loadRegistry: vi.fn(async () => { throw new Error('registry down'); }), createPersistenceAdapter: vi.fn(), completeBatch: vi.fn(async () => undefined) };
    await expect(processStoredReplay({ batch, store, processingToken: 'token', actorId: 'manager-1', reason: 'Approved replay reason', closedReplacement: false })).rejects.toThrow('registry down');
    expect(store.downloadObject).toHaveBeenCalledTimes(1);
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'ingest_failed' }));
  });

  it('does not overwrite a successfully persisted attempt when only finalization fails', async () => {
    const { canonical, batch } = replayEvidence();
    const store = { downloadObject: vi.fn(async () => canonical.gzip), loadRegistry: vi.fn(async () => ({})), createPersistenceAdapter: vi.fn(() => ({})), completeBatch: vi.fn(async () => { throw new Error('finalizer unavailable'); }) };
    await expect(processStoredReplay({ batch, store, processingToken: 'token', actorId: 'manager-1', reason: 'Approved replay reason', closedReplacement: false, normalize: () => ({ date: batch.tradingDate, parsed: {}, metadata: { isComplete: true } }), reconcile: () => ({ date: batch.tradingDate }), persist: async () => ({ id: 'daily-1' }) })).rejects.toThrow('finalizer unavailable');
    expect(store.completeBatch).toHaveBeenCalledTimes(1);
    expect(store.completeBatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});

describe('replay Supabase adapter', () => {
  it('uses service-only token-bound RPCs for claims and closed persistence', async () => {
    const rpc = vi.fn(async (name) => name === 'claim_ingest_batch_reprocess'
      ? { data: { outcome: 'owned', batch: { id: BATCH_ID } }, error: null }
      : { data: { daily_import: { id: 'daily-1' } }, error: null });
    const store = createReplayStore({ rpc });
    await store.claimReplay({ batchId: BATCH_ID, actorId: 'manager-1', processingToken: 'token-1', confirmClosedDay: true, reason: 'Approved closed replacement' });
    const adapter = store.createClosedReplacementAdapter({ processingToken: 'token-1', actorId: 'manager-1', reason: 'Approved closed replacement' });
    await adapter.persistDailyImportAtomic({ clientUuid: CLIENT_ID, sourceBatchId: BATCH_ID, importResult: { date: '2026-07-23' } });
    expect(rpc).toHaveBeenNthCalledWith(1, 'claim_ingest_batch_reprocess', expect.objectContaining({ p_batch_id: BATCH_ID, p_actor_id: 'manager-1', p_confirm_closed_day: true }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'persist_closed_auto_daily_import_replacement', expect.objectContaining({ p_source_batch_id: BATCH_ID, p_processing_token: 'token-1', p_reason: 'Approved closed replacement' }));
  });
});
