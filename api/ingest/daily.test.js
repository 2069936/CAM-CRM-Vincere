import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { normalizeAutoImportSnapshot } from '../../src/domain/autoImport.js';
import { DailyImportClosedError } from '../../src/domain/dailyImportPersistence.js';
import { reconcileDailyImport } from '../../src/domain/reconcile.js';
import { ApiError } from '../_lib/http.js';
import { createHandler, config } from './daily.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURE_ID = '0f5fa8a0-2e84-43d8-8788-24055979f6fe';
const contractFixture = JSON.parse(readFileSync(new URL('../../test/fixtures/auto-export/snapshot-v1.json', import.meta.url), 'utf8'));

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1, captureId: CAPTURE_ID,
    capturedAt: '2026-07-23T16:45:00-04:00', tradingDate: '2026-07-23',
    timeZone: 'America/New_York',
    source: { machineId: 'redacted', agentVersion: '1.0.0', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.5.2' },
    accounts: [], strategies: [], orders: [], executions: [], ...overrides,
  };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function setup({ claim, storeRaw, normalize, reconcile, persist, registry, authenticate, now, useRealDomain = false, complete } = {}) {
  const calls = { order: [], claim: [], storeRaw: [], terminal: [], audit: [], device: [], persist: [], release: [] };
  const batch = { id: 'batch-1', dailyImportId: null, status: 'received' };
  const autoStore = {
    async claimBatch(value) { calls.order.push('claim'); calls.claim.push(value); return claim ? claim(value) : { outcome: 'owned', batch: { ...batch, status: 'processing' } }; },
    async ensureRaw(...args) { calls.order.push('storage'); calls.storeRaw.push(args); if (storeRaw) return storeRaw(...args); return { existed: false }; },
    async releaseLease(value) { calls.release.push(value); },
    async loadRegistry() { calls.order.push('registry'); return registry || {}; },
    createPersistenceAdapter(processingToken) { return { persistDailyImportAtomic: async (value) => persist(value), supportsDailyImportSourceColumns: true, processingToken }; },
    async finalizeBatch(value) { calls.terminal.push(value); if (complete) return complete(value); return { ...batch, ...value }; },
    async recordDeviceResult(value) { calls.device.push(value); },
    async writeAudit(value) { calls.audit.push(value); },
  };
  const handler = createHandler({
    createClient: () => ({}), createAuthStore: () => ({}), createStore: () => autoStore,
    authenticate: async () => { calls.order.push('auth'); return authenticate ? authenticate() : { id: DEVICE_ID, clientId: CLIENT_ID }; },
    normalizeSnapshot: (value) => { calls.order.push('normalize'); if (useRealDomain) return normalizeAutoImportSnapshot(value); return normalize ? normalize(value) : { date: value.tradingDate, parsed: {}, metadata: { isComplete: value.accounts.length > 0, emptySections: value.accounts.length ? [] : ['accounts', 'strategies', 'orders', 'executions'], sectionCounts: { accounts: value.accounts.length, strategies: value.strategies.length, orders: value.orders.length, executions: value.executions.length } } }; },
    reconcile: (value) => { calls.order.push('reconcile'); if (useRealDomain) return reconcileDailyImport(value); return reconcile ? reconcile(value) : { id: 'import-1', date: value.date, accounts: {}, snapshots: [], strategies: [], orders: [], executions: [], flags: [] }; },
    persist: async (value) => { calls.order.push('persist'); calls.persist.push(value); return persist ? persist(value) : { id: 'daily-1', status: 'Needs review' }; },
    now: now || (() => new Date('2026-07-23T21:00:00Z')),
    createProcessingToken: () => '99999999-9999-4999-8999-999999999999',
  });
  return { handler, calls };
}

async function ingest(handler, value = snapshot(), reqOverrides = {}) {
  const req = { method: 'POST', headers: { authorization: 'Bearer x', 'x-machine-id': 'x', 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(JSON.stringify(value))), ...reqOverrides };
  const res = response(); await handler(req, res); return res;
}

describe('daily snapshot ingest', () => {
  it('disables framework parsing and authenticates before reading any request bytes', async () => {
    expect(config).toEqual({ api: { bodyParser: false } });
    const { handler, calls } = setup({ authenticate: () => { throw Object.assign(new Error('invalid_device_credential'), { status: 401 }); } });
    const res = await ingest(handler, snapshot(), { body: { async *[Symbol.asyncIterator]() { calls.order.push('read'); yield Buffer.from('secret'); } } });
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
    expect(calls.order).toEqual(['auth']);
  });

  it('claims, stores, normalizes, reconciles, persists and finalizes a valid batch in order', async () => {
    const { handler, calls } = setup({ useRealDomain: true });
    const res = await ingest(handler, contractFixture);
    expect(res).toMatchObject({ statusCode: 201, body: { ok: true, duplicate: false, batchId: 'batch-1', dailyImportId: 'daily-1', status: 'processed' } });
    expect(calls.order).toEqual(['auth', 'claim', 'storage', 'normalize', 'registry', 'reconcile', 'persist']);
    expect(calls.claim[0]).toMatchObject({ deviceId: DEVICE_ID, clientId: CLIENT_ID, captureId: CAPTURE_ID, storagePath: `${CLIENT_ID}/2026-07-23/${CAPTURE_ID}.json.gz`, rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 } });
    expect(calls.terminal[0]).toMatchObject({ batchId: 'batch-1', status: 'processed', dailyImportId: 'daily-1' });
    expect(calls.audit).toHaveLength(1);
    expect(calls.device).toEqual([expect.objectContaining({ deviceId: DEVICE_ID, success: true })]);
  });

  it('returns the original identifiers only for a confirmed terminal duplicate', async () => {
    const { handler, calls } = setup({ claim: () => ({ outcome: 'terminal', batch: { id: 'batch-old', dailyImportId: 'daily-old', status: 'processed' } }) });
    const res = await ingest(handler);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, duplicate: true, batchId: 'batch-old', dailyImportId: 'daily-old', status: 'processed' } });
    expect(calls.storeRaw).toHaveLength(0);
    expect(calls.audit).toHaveLength(0);
  });

  it.each([
    ['busy', 'processing', 409, 'capture_processing'],
    ['failed', 'failed', 409, 'capture_requires_replay'],
  ])('never acknowledges a %s duplicate as success', async (outcome, status, statusCode, error) => {
    const { handler, calls } = setup({ claim: () => ({ outcome, retryAfterSeconds: 12, batch: { id: 'batch-old', dailyImportId: null, status } }) });
    const res = await ingest(handler);
    expect(res).toMatchObject({ statusCode, body: { error, batchId: 'batch-old', status } });
    expect(res.body).not.toHaveProperty('ok');
    if (outcome === 'busy') expect(res.headers).toMatchObject({ 'Retry-After': '12' });
    expect(calls.storeRaw).toHaveLength(0);
  });

  it.each(['received', 'processing', 'failed'])('never acknowledges terminal outcome carrying %s', async (status) => {
    const { handler } = setup({ claim: () => ({ outcome: 'terminal', batch: { id: 'batch-old', dailyImportId: null, status } }) });
    const res = await ingest(handler);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toHaveProperty('ok');
  });

  it('marks an incomplete snapshot without auto-closing it', async () => {
    const { handler, calls } = setup();
    const res = await ingest(handler);
    expect(res).toMatchObject({ statusCode: 201, body: { status: 'incomplete' } });
    expect(calls.terminal[0]).toMatchObject({ status: 'incomplete', completeness: { isComplete: false, emptySections: ['accounts', 'strategies', 'orders', 'executions'] } });
  });

  it('keeps a transient pre-storage failure immediately reclaimable', async () => {
    const { handler, calls } = setup({ storeRaw: () => { throw new Error('bucket secret'); } });
    const res = await ingest(handler);
    expect(res).toMatchObject({ statusCode: 503, body: { error: 'snapshot_ingest_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('bucket secret');
    expect(calls.terminal).toHaveLength(0);
    expect(calls.release).toEqual([expect.objectContaining({ batchId: 'batch-1', processingToken: '99999999-9999-4999-8999-999999999999' })]);
  });

  it('fails a batch with a stable conflict when deterministic raw evidence mismatches', async () => {
    const mismatch = new ApiError(409, 'immutable_object_conflict');
    const { handler, calls } = setup({ storeRaw: () => { throw mismatch; } });
    const res = await ingest(handler);
    expect(res).toMatchObject({ statusCode: 409, body: { error: 'immutable_object_conflict' } });
    expect(calls.release).toHaveLength(0);
    expect(calls.terminal[0]).toMatchObject({ status: 'failed', errorCode: 'immutable_object_conflict' });
  });

  it('returns a stable 409 for the same capture ID with different immutable metadata', async () => {
    const conflict = Object.assign(new Error('database detail'), { status: 409, code: 'capture_metadata_conflict' });
    const { handler } = setup({ claim: () => { throw conflict; } });
    expect(await ingest(handler)).toMatchObject({ statusCode: 409, body: { error: 'capture_metadata_conflict' } });
  });

  it('quarantines unsupported schema and missing arrays after raw storage with precise stable codes', async () => {
    for (const [payload, code] of [
      [snapshot({ schemaVersion: 2 }), 'unsupported_schema_version'],
      [Object.fromEntries(Object.entries(snapshot()).filter(([key]) => key !== 'orders')), 'invalid_auto_import_snapshot'],
      [snapshot({ accounts: [{}] }), 'invalid_auto_import_snapshot'],
    ]) {
      const { handler, calls } = setup({ useRealDomain: true });
      const res = await ingest(handler, payload);
      expect(res).toMatchObject({ statusCode: 422, body: { error: code } });
      expect(calls.storeRaw).toHaveLength(1);
      expect(calls.terminal[0]).toMatchObject({ status: 'failed', errorCode: code });
    }
  });

  it.each([
    [{ tradingDate: '2026-02-30' }, 'impossible trading date'],
    [{ capturedAt: '2026-07-23T20:45:00' }, 'offsetless capturedAt'],
    [{ captureId: 'not-a-uuid' }, 'malformed capture identity'],
  ])('rejects %s before PostgREST claim', async (change) => {
    const { handler, calls } = setup();
    const res = await ingest(handler, snapshot(change));
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_snapshot_envelope' } });
    expect(calls.claim).toHaveLength(0);
  });

  it('retains raw storage and marks normalization or reconciliation failures with stable codes', async () => {
    for (const [option, code] of [
      [{ normalize: () => { throw new Error('raw account data'); } }, 'normalization_failed'],
      [{ reconcile: () => { throw new Error('registry detail'); } }, 'reconciliation_failed'],
    ]) {
      const { handler, calls } = setup(option);
      const res = await ingest(handler);
      expect(res).toMatchObject({ statusCode: 422, body: { error: 'snapshot_processing_failed' } });
      expect(calls.storeRaw).toHaveLength(1);
      expect(calls.terminal[0]).toMatchObject({ status: 'failed', errorCode: code });
      expect(JSON.stringify(res.body)).not.toMatch(/raw account|registry detail/);
    }
  });

  it('retains and links a late closed-day batch without replacing the daily import', async () => {
    const { handler, calls } = setup({ persist: async () => { throw Object.assign(new DailyImportClosedError('2026-07-23'), { dailyImportId: 'daily-closed' }); } });
    const res = await ingest(handler, snapshot({ accounts: [{ accountName: 'A' }] }));
    expect(res).toMatchObject({ statusCode: 202, body: { ok: true, status: 'late_closed_day', dailyImportId: 'daily-closed' } });
    expect(calls.terminal[0]).toMatchObject({ status: 'late_closed_day', dailyImportId: 'daily-closed' });
    expect(calls.audit).toEqual([expect.objectContaining({ eventType: 'ingest_batch_late_closed_day' })]);
  });

  it('does not let a newer same-date open capture reuse the earlier capture claim', async () => {
    const { handler, calls } = setup();
    await ingest(handler, snapshot());
    await ingest(handler, snapshot({ captureId: '7f47bc12-f9cc-4ed9-b8f4-d24362316e7b', capturedAt: '2026-07-23T16:50:00-04:00' }));
    expect(calls.claim).toHaveLength(2);
    expect(calls.persist).toHaveLength(2);
    expect(calls.claim[1].captureId).not.toBe(calls.claim[0].captureId);
  });

  it('retains an older arrival as replaced without overwriting the current daily import', async () => {
    const { handler, calls } = setup({ persist: () => ({ id: 'daily-newer', disposition: 'superseded' }) });
    const res = await ingest(handler, snapshot({ accounts: [{ accountName: 'A' }] }));
    expect(res).toMatchObject({
      statusCode: 201,
      body: { ok: true, duplicate: false, dailyImportId: 'daily-newer', status: 'replaced' },
    });
    expect(calls.terminal[0]).toMatchObject({
      status: 'replaced', eventType: 'ingest_batch_superseded', dailyImportId: 'daily-newer',
    });
  });

  it('keeps a persisted batch recoverable when terminal finalization fails', async () => {
    const { handler, calls } = setup({ complete: () => { throw new Error('finalize transport'); } });
    const res = await ingest(handler, snapshot({ accounts: [{ accountName: 'A' }] }));
    expect(res).toMatchObject({ statusCode: 503, body: { error: 'snapshot_finalization_pending' } });
    expect(calls.persist).toHaveLength(1);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].status).toBe('processed');
    expect(calls.release).toHaveLength(0);
  });

  it('rejects a device capture timestamp beyond the five-minute server skew before claiming', async () => {
    const { handler, calls } = setup();
    const res = await ingest(handler, snapshot({ capturedAt: '2026-07-23T21:05:00.001Z' }));
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_snapshot_envelope' } });
    expect(calls.claim).toHaveLength(0);
  });
});
