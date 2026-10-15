import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import snapshotFixture from '../../../../test/fixtures/auto-export/snapshot-v1.json';
import { canonicalSnapshotPayload } from '../../../apiLib/autoImportStore.js';
import { createHandler, createReplayStore, parseReplayBody, processStoredReplay } from '../../../autoCollection/admin/ingest-reprocess.js';
import { ApiError } from '../../../apiLib/http.js';
import { createHandler as createBulkHandler } from '../../../autoCollection/admin/ingest-reprocess-failed.js';

const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
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

/* A REPLAY THAT THE VALIDATOR REFUSES AGAIN SAYS WHY (step 69).
 *
 * The thirteen closes refused before step 69 carry only their code. Replaying
 * one runs the same validator over the same stored bytes, so the replay is
 * how they get their reason: it is recorded with the code the upload got (it
 * used to become 'ingest_failed') and the rules, after the finalize. */
describe('a replay refused by the validator records why', () => {
  const REFUSED = 'orders[*].accountName does not reference an account (APEX 4521 07)';

  function evidenceOf(snapshot) {
    const canonical = canonicalSnapshotPayload(snapshot);
    const batch = {
      ...baseBatch, captureId: snapshot.captureId, capturedAt: snapshot.capturedAt,
      tradingDate: snapshot.tradingDate, schemaVersion: snapshot.schemaVersion,
      storagePath: `${CLIENT_ID}/${snapshot.tradingDate}/${snapshot.captureId}.json.gz`,
      contentSha256: canonical.sha256, byteCount: canonical.utf8.length,
      rowCounts: Object.fromEntries(['accounts', 'strategies', 'orders', 'executions'].map((name) => [name, snapshot[name].length])),
    };
    return { canonical, batch };
  }

  function unknownAccount() {
    const value = structuredClone(snapshotFixture);
    value.orders.push({ ...value.orders[0], orderId: 'order-02', accountName: 'APEX 4521 07' });
    return value;
  }

  function storeFor(canonical, { recordDetail, complete } = {}) {
    const order = [];
    const store = {
      order,
      downloadObject: vi.fn(async () => canonical.gzip), loadRegistry: vi.fn(async () => ({})),
      createPersistenceAdapter: vi.fn(() => ({})), createClosedReplacementAdapter: vi.fn(() => ({})),
      completeBatch: vi.fn(async (value) => { order.push('finalize'); if (complete) return complete(value); return undefined; }),
    };
    if (recordDetail !== false) {
      store.recordBatchErrorDetail = vi.fn(async (value) => { order.push('detail'); return recordDetail ? recordDetail(value) : true; });
    }
    return store;
  }

  const replay = (batch, store, extra = {}) => processStoredReplay({ batch, store, processingToken: 'token', actorId: 'manager-1', reason: 'Record why it was rejected', closedReplacement: false, ...extra });

  it('normalize refuses it: failed with invalid_auto_import_snapshot, then the rules, and the original error rethrown', async () => {
    const { canonical, batch } = evidenceOf(unknownAccount());
    const store = storeFor(canonical);
    await expect(replay(batch, store)).rejects.toMatchObject({ name: 'AutoImportValidationError', code: 'invalid_auto_import_snapshot' });
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', success: false, errorCode: 'invalid_auto_import_snapshot' }));
    expect(store.recordBatchErrorDetail).toHaveBeenCalledWith({ batchId: BATCH_ID, detail: REFUSED });
    expect(store.order).toEqual(['finalize', 'detail']);
    expect(store.loadRegistry).not.toHaveBeenCalled();
  });

  it('the stored snapshot breaks the contract: the same code and its rules, and the answer is still stored_snapshot_corrupt', async () => {
    const broken = structuredClone(snapshotFixture);
    broken.accounts[0].netLiquidation = 'fifty one thousand';
    const { canonical, batch } = evidenceOf(broken);
    const store = storeFor(canonical);
    await expect(replay(batch, store)).rejects.toMatchObject({ status: 409, message: 'stored_snapshot_corrupt' });
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'invalid_auto_import_snapshot' }));
    expect(store.recordBatchErrorDetail).toHaveBeenCalledWith({ batchId: BATCH_ID, detail: 'accounts[*].netLiquidation must be a number or null' });
  });

  it('an unsupported schema version keeps its code and says so', async () => {
    const { canonical, batch } = evidenceOf(snapshotFixture);
    const store = storeFor(canonical);
    await expect(replay({ ...batch, schemaVersion: 2 }, store)).rejects.toMatchObject({ status: 409, message: 'unsupported_schema_version' });
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'unsupported_schema_version' }));
    expect(store.recordBatchErrorDetail).toHaveBeenCalledWith({ batchId: BATCH_ID, detail: 'schemaVersion must be 1' });
  });

  it.each([
    ['damaged bytes', (canonical) => ({ downloadObject: vi.fn(async () => Buffer.from('not-gzip')), canonical })],
    ['a registry failure', () => ({ loadRegistry: vi.fn(async () => { throw new Error('registry down'); }) })],
    ['a normalize that throws something else', () => ({ normalize: () => { throw Object.assign(new Error('boom'), { errors: ['accounts[0].x is required'] }); } })],
  ])('%s: ingest_failed as before, and no reason', async (_name, patch) => {
    const { canonical, batch } = evidenceOf(snapshotFixture);
    const store = storeFor(canonical);
    const { normalize, ...storePatch } = patch(canonical);
    delete storePatch.canonical;
    Object.assign(store, storePatch);
    await expect(replay(batch, store, normalize ? { normalize } : {})).rejects.toThrow();
    expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'ingest_failed' }));
    expect(store.recordBatchErrorDetail).not.toHaveBeenCalled();
  });

  it('no reason when the finalize itself failed, and the original error still wins', async () => {
    const { canonical, batch } = evidenceOf(unknownAccount());
    const store = storeFor(canonical, { complete: () => { throw new Error('finalizer unavailable'); } });
    await expect(replay(batch, store)).rejects.toMatchObject({ code: 'invalid_auto_import_snapshot' });
    expect(store.recordBatchErrorDetail).not.toHaveBeenCalled();
  });

  it('the controlled replay answers the same whether the RPC records, refuses, fails or is missing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answers = [];
      for (const recordDetail of [undefined, () => false, () => { throw new Error('function missing'); }, false]) {
        const { canonical, batch } = evidenceOf(unknownAccount());
        const store = { ...storeFor(canonical, { recordDetail }), getBatch: vi.fn(async () => batch), claimReplay: vi.fn(async () => ({ outcome: 'owned' })) };
        const handler = createHandler({ createClients: () => ({ admin: {}, auth: {} }), authorize: async () => ({ id: 'manager-1' }), createStore: () => store, createProcessingToken: () => '99999999-9999-4999-8999-999999999999' });
        const res = response();
        await handler({ method: 'POST', body: { batchId: BATCH_ID, reason: 'Record why it was rejected', confirmation: 'REPROCESS Acme Trading 2026-07-23' } }, res);
        answers.push({ statusCode: res.statusCode, body: res.body, headers: res.headers });
        expect(store.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'invalid_auto_import_snapshot' }));
      }
      for (const answer of answers) expect(answer).toEqual(answers[0]);
      expect(answers[0]).toMatchObject({ statusCode: 500, body: { error: 'batch_reprocess_failed' } });
      expect(logged.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('could not record why')))
        .toEqual([`[CRM] could not record why batch ${BATCH_ID} was rejected: Error function missing`]);
    } finally {
      logged.mockRestore();
    }
  });

  it('the bulk replay from the failed closes panel records it too, and reports the batch exactly as before', async () => {
    const outcomes = [];
    for (const recordDetail of [undefined, () => { throw new Error('function missing'); }]) {
      const { canonical, batch } = evidenceOf(unknownAccount());
      const store = { ...storeFor(canonical, { recordDetail }), getBatch: vi.fn(async () => batch), claimReplay: vi.fn(async () => ({ outcome: 'owned' })) };
      const handler = createBulkHandler({ createClients: () => ({ admin: {}, auth: {} }), authorize: async () => ({ id: 'manager-1' }), createStore: () => store, createProcessingToken: () => '99999999-9999-4999-8999-999999999999', report: () => {} });
      const res = response();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await handler({ method: 'POST', body: { batchIds: [BATCH_ID], reason: 'Record why it was rejected' } }, res);
      } finally {
        logged.mockRestore();
      }
      expect(store.recordBatchErrorDetail).toHaveBeenCalledWith({ batchId: BATCH_ID, detail: REFUSED });
      outcomes.push({ statusCode: res.statusCode, body: res.body });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ statusCode: 200, body: { replayed: 0, results: [{ batchId: BATCH_ID, outcome: 'failed', error: 'invalid_auto_import_snapshot' }] } });
  });

  it('the replay store carries the RPC, with its two arguments', async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createReplayStore({ rpc });
    await expect(store.recordBatchErrorDetail({ batchId: BATCH_ID, detail: REFUSED })).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_ingest_batch_error_detail', { p_batch_id: BATCH_ID, p_detail: REFUSED });
  });
});

describe('the day a replay would write', () => {
  /* A failed batch owns no daily import, so asking the day about itself
   * through batch.dailyImportId asked about null and answered "not closed"
   * for every batch a replay is ever aimed at. Meanwhile the day was closed,
   * by hand, by the CAM who covered for the capture that failed. */
  function adminFor(batchRow, dailyRows) {
    const calls = [];
    return {
      calls,
      from(table) {
        const filters = {};
        const chain = {
          select() { return chain; },
          eq(column, value) { filters[column] = value; return chain; },
          async maybeSingle() {
            calls.push({ table, filters });
            if (table === 'ingest_batches') return { data: batchRow, error: null };
            if (table === 'clients') return { data: { name: 'Acme Trading' }, error: null };
            if (table === 'daily_imports') {
              const row = dailyRows.find((candidate) => candidate.client_id === filters.client_id
                && candidate.trading_date === filters.trading_date) || null;
              return { data: row ? { status: row.status } : null, error: null };
            }
            return { data: null, error: null };
          },
        };
        return chain;
      },
    };
  }

  const failedRow = {
    id: BATCH_ID, capture_id: BATCH_ID, device_id: DEVICE_ID, client_id: CLIENT_ID,
    trading_date: '2026-09-18', captured_at: '2026-09-18T20:30:00Z', received_at: '2026-09-18T20:31:00Z',
    processed_at: null, status: 'failed', schema_version: 1, storage_path: 'p.json.gz',
    content_sha256: 'a'.repeat(64), byte_count: 10, row_counts: {}, completeness: {},
    daily_import_id: null, replaces_batch_id: null, error_code: 'invalid_auto_import_snapshot',
  };

  it('sees a day a CAM closed by hand even though the failed batch has no import of its own', async () => {
    const admin = adminFor(failedRow, [{ client_id: CLIENT_ID, trading_date: '2026-09-18', status: 'Closed' }]);
    const batch = await createReplayStore(admin).getBatch(BATCH_ID);
    expect(batch).toMatchObject({ closedDay: true, dailyImportId: null, clientName: 'Acme Trading' });
    expect(admin.calls).toContainEqual({ table: 'daily_imports', filters: { client_id: CLIENT_ID, trading_date: '2026-09-18' } });
  });

  it('leaves an open day open', async () => {
    const admin = adminFor(failedRow, [{ client_id: CLIENT_ID, trading_date: '2026-09-18', status: 'Open' }]);
    expect(await createReplayStore(admin).getBatch(BATCH_ID)).toMatchObject({ closedDay: false });
  });

  it('leaves a day with no import at all open', async () => {
    const admin = adminFor(failedRow, []);
    expect(await createReplayStore(admin).getBatch(BATCH_ID)).toMatchObject({ closedDay: false });
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
    expect(rpc).toHaveBeenNthCalledWith(2, 'persist_closed_auto_daily_import_replacement_v2', expect.objectContaining({ p_source_batch_id: BATCH_ID, p_processing_token: 'token-1', p_reason: 'Approved closed replacement' }));
  });
});
