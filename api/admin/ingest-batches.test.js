import { describe, expect, it, vi } from 'vitest';
import {
  createBatchHistoryStore,
  createHandler,
  encodeBatchCursor,
  parseBatchFilters,
} from './ingest-batches.js';
import { ApiError } from '../_lib/http.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const CAPTURE_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function row(overrides = {}) {
  return {
    id: BATCH_ID,
    capture_id: CAPTURE_ID,
    client_id: CLIENT_ID,
    device_id: DEVICE_ID,
    trading_date: '2026-07-23',
    captured_at: '2026-07-23T20:45:00.000Z',
    received_at: '2026-07-23T20:45:03.000Z',
    processed_at: '2026-07-23T20:45:04.000Z',
    status: 'processed',
    schema_version: 1,
    byte_count: 1234,
    row_counts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
    completeness: { isComplete: true, emptySections: [] },
    daily_import_id: null,
    replaces_batch_id: null,
    error_code: null,
    storage_path: 'must-not-leak',
    content_sha256: 'must-not-leak',
    error_detail: 'must-not-leak',
    processing_token: 'must-not-leak',
    ...overrides,
  };
}

function setup({ rows = [row()], authorizeError } = {}) {
  const list = vi.fn(async () => rows);
  const store = { list };
  const authorize = vi.fn(async (_req, options) => {
    expect(options.roles).toEqual(['Manager']);
    if (authorizeError) throw authorizeError;
    return { id: 'manager-1', role: 'Manager' };
  });
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize,
    createStore: () => store,
  });
  return { handler, list, authorize };
}

describe('admin collector batch history', () => {
  it('authorizes a Manager and returns only safe fields', async () => {
    const { handler, list } = setup();
    const res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer session' }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(res.body.batches[0]).toMatchObject({
      id: BATCH_ID,
      captureId: CAPTURE_ID,
      clientUuid: CLIENT_ID,
      deviceId: DEVICE_ID,
      status: 'processed',
      rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/storage_path|storagePath|content_sha|sha256|error_detail|must-not-leak|processing_token/i);
  });

  it('passes bounded filters and returns a stable received-at/id cursor', async () => {
    const first = row();
    const second = row({ id: '55555555-5555-4555-8555-555555555555', received_at: '2026-07-23T20:44:00.000Z' });
    const extra = row({ id: '66666666-6666-4666-8666-666666666666', received_at: '2026-07-23T20:43:00.000Z' });
    const { handler, list } = setup({ rows: [first, second, extra] });
    const res = response();
    await handler({
      method: 'GET', headers: {}, query: {
        clientUuid: CLIENT_ID,
        deviceId: DEVICE_ID,
        captureId: CAPTURE_ID,
        status: 'incomplete',
        from: '2026-07-01',
        to: '2026-07-31',
        pageSize: '2',
      },
    }, res);

    expect(list).toHaveBeenCalledWith({
      clientUuid: CLIENT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_ID,
      status: 'incomplete', from: '2026-07-01', to: '2026-07-31',
      limit: 2, cursor: null,
    });
    expect(res.body.batches).toHaveLength(2);
    expect(parseBatchFilters({ cursor: res.body.nextCursor })).toMatchObject({
      cursor: { receivedAt: second.received_at, id: second.id },
    });
  });

  it('accepts its own cursor and preserves tie-breaking UUIDs', () => {
    const cursor = encodeBatchCursor({ receivedAt: '2026-07-23T20:45:03.000Z', id: BATCH_ID });
    expect(parseBatchFilters({ cursor })).toMatchObject({
      cursor: { receivedAt: '2026-07-23T20:45:03.000Z', id: BATCH_ID },
    });
  });

  it.each([
    [{ clientUuid: 'bad' }, 'invalid_client_uuid'],
    [{ deviceId: ['x', 'y'] }, 'invalid_device_id'],
    [{ captureId: 'bad' }, 'invalid_capture_id'],
    [{ status: 'secret_database_state' }, 'invalid_status'],
    [{ from: '2026-02-30' }, 'invalid_from'],
    [{ to: 'not-a-date' }, 'invalid_to'],
    [{ from: '2026-08-01', to: '2026-07-01' }, 'invalid_date_range'],
    [{ pageSize: '0' }, 'invalid_page_size'],
    [{ pageSize: '101' }, 'invalid_page_size'],
    [{ cursor: 'not-base64-json' }, 'invalid_cursor'],
    [{ cursor: 'a'.repeat(513) }, 'invalid_cursor'],
  ])('rejects invalid bounded query %#', async (query, message) => {
    const { handler, list } = setup();
    const res = response();
    await handler({ method: 'GET', headers: {}, query }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error: message } });
    expect(list).not.toHaveBeenCalled();
  });

  it('does not validate or query history before Manager authorization succeeds', async () => {
    const { handler, list } = setup({ authorizeError: new ApiError(403, 'Manager permission required.') });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { pageSize: '999' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(list).not.toHaveBeenCalled();
  });

  it('maps an untrusted dependency error with a forged 4xx status to one stable 500', async () => {
    const res = response();
    const secret = Object.assign(new Error('database secret should never escape'), { status: 400 });
    const guarded = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ id: 'manager-1' }),
      createStore: () => ({ list: async () => { throw secret; } }),
    });
    await guarded({ method: 'GET', headers: {}, query: {} }, res);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'batch_history_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('database secret');
  });

  it('rejects non-GET methods', async () => {
    const { handler, authorize } = setup();
    const res = response();
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('batch history Supabase adapter', () => {
  it('selects only safe columns and applies descending stable cursor pagination', async () => {
    const calls = [];
    const query = {
      select(value) { calls.push(['select', value]); return this; },
      eq(...args) { calls.push(['eq', ...args]); return this; },
      gte(...args) { calls.push(['gte', ...args]); return this; },
      lte(...args) { calls.push(['lte', ...args]); return this; },
      or(value) { calls.push(['or', value]); return this; },
      order(...args) { calls.push(['order', ...args]); return this; },
      limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: [row()], error: null }); },
    };
    const store = createBatchHistoryStore({ from: vi.fn(() => query) });
    await store.list({
      clientUuid: CLIENT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_ID,
      status: 'processed', from: '2026-07-01', to: '2026-07-31', limit: 10,
      cursor: { receivedAt: '2026-07-23T20:45:03.000Z', id: BATCH_ID },
    });
    const selected = calls.find(([kind]) => kind === 'select')[1];
    expect(selected).not.toMatch(/storage_path|content_sha256|error_detail|processing_token/);
    expect(calls).toContainEqual(['order', 'received_at', { ascending: false }]);
    expect(calls).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls).toContainEqual(['limit', 11]);
    expect(calls.find(([kind]) => kind === 'or')[1]).toContain(`id.lt.${BATCH_ID}`);
  });
});
