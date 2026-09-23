import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import { MAX_BATCHES_PER_CALL, createHandler, parseBulkReplayBody } from '../../../autoCollection/admin/ingest-reprocess-failed.js';

/* THE QUARANTINE THE DESK CAN CLEAR FROM ITS OWN SCREEN.
 *
 * Every 422 quarantine on a VPS is also a failed batch here, with its raw
 * snapshot stored. When the refusal was ours (a normalizer too strict, a
 * database that timed out) the fix lands here and the batches need replaying
 * in bulk, not one typed confirmation per client per day. */
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const C = '55555555-5555-4555-8555-555555555555';
const CLIENT = '11111111-1111-4111-8111-111111111111';

function batch(id, extra = {}) {
  return { id, clientId: CLIENT, clientName: 'Acme Trading', deviceId: '22222222-2222-4222-8222-222222222222', tradingDate: '2026-09-14', capturedAt: '2026-09-14T20:30:00Z', status: 'failed', rowCounts: {}, ...extra };
}

function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function setup({ batches = {}, claim = () => ({ outcome: 'owned' }), replay, role = 'Manager', getBatch, timeBudgetMs, now } = {}) {
  const store = {
    getBatch: vi.fn(getBatch || (async (id) => batches[id] || null)),
    claimReplay: vi.fn(async (payload) => claim(payload)),
  };
  const processReplay = vi.fn(replay || (async () => ({ status: 'processed', dailyImportId: 'daily-1' })));
  const authorize = vi.fn(async (req, { roles }) => {
    if (!roles.includes(role)) throw new ApiError(403, 'forbidden');
    return { id: 'manager-1', role };
  });
  const report = vi.fn();
  const handler = createHandler({ createClients: () => ({ admin: {}, auth: {} }), authorize, createStore: () => store, processReplay, createProcessingToken: () => '99999999-9999-4999-8999-999999999999', timeBudgetMs, now, report });
  return { store, processReplay, handler, report };
}

describe('bulk replay of failed batches', () => {
  it('replays every failed batch under one reason and reports each outcome', async () => {
    const { handler, store, processReplay } = setup({ batches: { [A]: batch(A), [B]: batch(B, { tradingDate: '2026-09-17' }) } });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B], reason: 'Normalizer repaired duplicate strategy rows' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, requested: 2, replayed: 2 });
    expect(res.body.results).toEqual([
      expect.objectContaining({ batchId: A, outcome: 'replayed', status: 'processed', tradingDate: '2026-09-14' }),
      expect.objectContaining({ batchId: B, outcome: 'replayed', status: 'processed', tradingDate: '2026-09-17' }),
    ]);
    expect(store.claimReplay).toHaveBeenCalledTimes(2);
    expect(store.claimReplay).toHaveBeenCalledWith(expect.objectContaining({ confirmClosedDay: false, reason: 'Normalizer repaired duplicate strategy rows', actorId: 'manager-1' }));
    expect(processReplay).toHaveBeenCalledTimes(2);
  });

  it('skips what it must not touch and says why, without failing the rest', async () => {
    // A closed day keeps its typed confirmation. A batch that is not failed
    // is not this endpoint's business. A missing one is reported, not thrown.
    const { handler, processReplay } = setup({ batches: {
      [A]: batch(A),
      [B]: batch(B, { reprocessMode: 'closed_day' }),
      [C]: batch(C, { status: 'processed' }),
    } });
    const missing = '66666666-6666-4666-8666-666666666666';
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B, C, missing], reason: 'Replaying after the fix' } }, res);
    expect(res.body).toMatchObject({ requested: 4, replayed: 1 });
    expect(res.body.results.map((r) => r.outcome)).toEqual(['replayed', 'skipped', 'skipped', 'not_found']);
    expect(res.body.results[1].reason).toBe('closed_day_needs_confirmation');
    expect(res.body.results[2].reason).toBe('status_processed');
    expect(processReplay).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one replay fails again, and names that one', async () => {
    const replay = vi.fn(async ({ batch: b }) => {
      if (b.id === A) throw new Error('canceling statement due to statement timeout');
      return { status: 'processed', dailyImportId: 'daily-2' };
    });
    const { handler } = setup({ batches: { [A]: batch(A), [B]: batch(B) }, replay });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B], reason: 'Replaying after the fix' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.results[0]).toMatchObject({ batchId: A, outcome: 'failed', error: 'batch_reprocess_failed' });
    expect(res.body.results[1]).toMatchObject({ batchId: B, outcome: 'replayed' });
    expect(JSON.stringify(res.body)).not.toMatch(/statement timeout/);
  });

  it('reports a batch someone else is replaying as busy and one already done as terminal', async () => {
    const claim = ({ batchId }) => ({ outcome: batchId === A ? 'busy' : 'terminal' });
    const { handler, processReplay } = setup({ batches: { [A]: batch(A), [B]: batch(B) }, claim });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B], reason: 'Replaying after the fix' } }, res);
    expect(res.body.results.map((r) => r.outcome)).toEqual(['busy', 'already_terminal']);
    expect(processReplay).not.toHaveBeenCalled();
  });

  it('stops inside the time budget and hands back what it did not reach', async () => {
    // Vercel drops the whole response at maxDuration. Better to answer with
    // the batches still to do than to lose the ones already done.
    let clock = 0;
    const replay = vi.fn(async () => { clock += 4000; return { status: 'processed', dailyImportId: 'daily-1' }; });
    const { handler } = setup({ batches: { [A]: batch(A), [B]: batch(B), [C]: batch(C) }, replay, timeBudgetMs: 6500, now: () => clock });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B, C], reason: 'Replaying after the fix' } }, res);
    expect(res.body.replayed).toBe(2);
    expect(res.body.remaining).toEqual([C]);
    expect(res.body.results.map((r) => r.outcome)).toEqual(['replayed', 'replayed', 'not_attempted']);
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('turns a batch lookup failure into that batch\'s outcome and logs the cause', async () => {
    const { handler, report } = setup({ batches: { [B]: batch(B) }, getBatch: async (id) => { if (id === A) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); return batch(B); } });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B], reason: 'Replaying after the fix' } }, res);
    expect(res.statusCode).toBe(200);
    // 57014 is a statement timeout, and the desk's next move for one is to
    // press the button again. This used to answer batch_reprocess_failed,
    // which is the same word a closed day and a revoked device answered, so
    // the screen could not tell "try again" from "stop". The SQLSTATE names
    // the fault and names no data; the message itself still never travels.
    expect(res.body.results[0]).toMatchObject({ batchId: A, outcome: 'failed', error: 'postgres_57014' });
    expect(res.body.results[1]).toMatchObject({ batchId: B, outcome: 'replayed' });
    expect(JSON.stringify(res.body)).not.toMatch(/statement timeout/);
    expect(report).toHaveBeenCalledWith(A, expect.objectContaining({ code: '57014' }));
  });

  it('names the causes the desk can act on instead of one word for all of them', async () => {
    // Measured on 43 client days replayed on 2026-09-23: sixteen came back
    // failed and every one of them said batch_reprocess_failed, so the only
    // way to tell a day a CAM had already closed from a device that had been
    // re-paired was an account with access to the server log.
    const closed = Object.assign(new Error('Daily import is closed for 2026-09-18.'), { code: 'daily_import_closed' });
    const revoked = Object.assign(new Error('invalid_ingest_device'), { code: 'P0001' });
    const replay = vi.fn(async ({ batch: b }) => { throw b.id === A ? closed : revoked; });
    const { handler } = setup({ batches: { [A]: batch(A), [B]: batch(B) }, replay });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A, B], reason: 'Replaying after the fix' } }, res);
    expect(res.body.results.map((r) => r.error)).toEqual(['daily_import_closed', 'invalid_ingest_device']);
    expect(JSON.stringify(res.body)).not.toMatch(/2026-09-18/);
  });

  it('keeps a database message out of the answer when it is not an identifier', async () => {
    const leaky = new Error('duplicate key value violates unique constraint "accounts_pkey" (BSKELAUNCH26643)');
    const replay = vi.fn(async () => { throw leaky; });
    const { handler } = setup({ batches: { [A]: batch(A) }, replay });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A], reason: 'Replaying after the fix' } }, res);
    expect(res.body.results[0]).toMatchObject({ outcome: 'failed', error: 'batch_reprocess_failed' });
    expect(JSON.stringify(res.body)).not.toMatch(/BSKELAUNCH/);
  });

  it('is for managers only', async () => {
    const { handler } = setup({ role: 'CAM' });
    const res = response();
    await handler({ method: 'POST', body: { batchIds: [A], reason: 'Replaying after the fix' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it('validates the request the way the single replay does', () => {
    expect(() => parseBulkReplayBody({ batchIds: [], reason: 'Replaying after the fix' })).toThrow(ApiError);
    expect(() => parseBulkReplayBody({ batchIds: ['nope'], reason: 'Replaying after the fix' })).toThrow(ApiError);
    expect(() => parseBulkReplayBody({ batchIds: [A], reason: 'short' })).toThrow(ApiError);
    expect(() => parseBulkReplayBody({ batchIds: Array.from({ length: MAX_BATCHES_PER_CALL + 1 }, () => A), reason: 'Replaying after the fix' })).toThrow(ApiError);
    expect(parseBulkReplayBody({ batchIds: [A, A.toUpperCase(), B], reason: 'Replaying after the fix' }).batchIds).toEqual([A, B]);
  });
});
