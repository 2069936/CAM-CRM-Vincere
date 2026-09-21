import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import {
  MAX_ITEMS,
  QUARANTINE_CODES,
  config,
  createHandler,
  createQuarantineStore,
  normalizeQuarantineBody as normalizeQuarantineBodyImpl,
} from '../../../autoCollection/ingest/quarantine.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAPTURE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REFERENCE_NOW = new Date('2026-09-21T17:00:00Z');

function normalizeQuarantineBody(value, options = {}) {
  return normalizeQuarantineBodyImpl(value, { now: REFERENCE_NOW, ...options });
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

// Exactly what QuarantineReport in the agent serialises: Newtonsoft writes a
// DateTimeOffset with seven fractional digits and a +00:00 rather than a Z,
// and a null lastAttemptAt as null rather than leaving the key out.
function item(overrides = {}) {
  return {
    tradingDate: '2026-09-14',
    captureId: CAPTURE_A,
    code: 'snapshot_processing_failed',
    attempts: 1,
    quarantinedAt: '2026-09-14T20:30:09.1234567+00:00',
    lastAttemptAt: '2026-09-15T17:00:00.0000000+00:00',
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    schemaVersion: 1,
    reportedAt: '2026-09-21T16:59:30.0000000+00:00',
    items: [
      item(),
      item({ tradingDate: '2026-09-17', captureId: CAPTURE_B, code: 'snapshot_rejected', attempts: 0, lastAttemptAt: null }),
    ],
    ...overrides,
  };
}

function setup({ authenticateImpl, recordImpl, now = () => REFERENCE_NOW } = {}) {
  const calls = { authenticate: [], record: [], createClient: 0 };
  const admin = {};
  const authStore = {};
  const store = {
    async recordReport(payload) {
      calls.record.push(payload);
      if (recordImpl) return recordImpl(payload);
      return { deviceId: DEVICE_ID, recorded: payload.items.length, removed: 0 };
    },
  };
  const handler = createHandler({
    createClient: () => { calls.createClient += 1; return admin; },
    createAuthStore: () => authStore,
    createStore: () => store,
    authenticate: async (req, deps) => {
      calls.authenticate.push({ req, deps });
      if (authenticateImpl) return authenticateImpl(req, deps);
      return {
        id: DEVICE_ID,
        clientId: CLIENT_ID,
        status: 'active',
        revokedAt: null,
        scheduleTime: '16:30:00',
        scheduleTimezone: 'America/New_York',
      };
    },
    pepper: 'test-pepper',
    now,
  });
  return { handler, calls };
}

async function report(handler, payload = body(), overrides = {}) {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer redacted', 'x-machine-id': 'redacted' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...overrides,
  };
  const res = response();
  await handler(req, res);
  return res;
}

describe('quarantine report body validation', () => {
  it('accepts the report the agent sends and lowercases the capture ids', () => {
    expect(normalizeQuarantineBody(body({ items: [item({ captureId: CAPTURE_A.toUpperCase() })] }))).toEqual({
      schemaVersion: 1,
      reportedAt: '2026-09-21T16:59:30.0000000+00:00',
      items: [item()],
    });
  });

  it('accepts an empty report, which is how a device says its folder is clear', () => {
    expect(normalizeQuarantineBody(body({ items: [] })).items).toEqual([]);
  });

  it('rejects arrays, null, and objects with custom prototypes', () => {
    expect(() => normalizeQuarantineBody([])).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(null)).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(Object.assign(Object.create({ inherited: true }), body())))
      .toThrow('invalid_quarantine_report');
  });

  it('rejects unknown keys on the report and on an item', () => {
    expect(() => normalizeQuarantineBody(body({ deviceId: DEVICE_ID }))).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(body({ items: [item({ final: true })] }))).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(body({ items: [item({ reason: 'free text' })] }))).toThrow('invalid_quarantine_report');
  });

  it('rejects a schema version it does not know', () => {
    expect(() => normalizeQuarantineBody(body({ schemaVersion: 2 }))).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(body({ schemaVersion: '1' }))).toThrow('invalid_quarantine_report');
  });

  it('rejects more items than the agent ever sends', () => {
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => item({
      captureId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    expect(() => normalizeQuarantineBody(body({ items }))).toThrow('invalid_quarantine_report');
    expect(normalizeQuarantineBody(body({ items: items.slice(0, MAX_ITEMS) })).items).toHaveLength(MAX_ITEMS);
  });

  it.each([
    ['tradingDate', '2026-9-1'],
    ['tradingDate', '2026-02-30'],
    ['tradingDate', 20260914],
    ['captureId', 'not-a-uuid'],
    ['captureId', null],
    ['attempts', -1],
    ['attempts', 1.5],
    ['attempts', '1'],
    ['quarantinedAt', '2026-09-14'],
    ['quarantinedAt', '2026-09-14T20:30:09'],
    ['quarantinedAt', null],
    ['lastAttemptAt', 'yesterday'],
    ['code', 'Snapshot_Rejected'],
    ['code', ''],
    ['code', 42],
  ])('rejects an invalid %s value %j', (field, value) => {
    expect(() => normalizeQuarantineBody(body({ items: [item({ [field]: value })] }))).toThrow('invalid_quarantine_report');
  });

  it('puts no ceiling on attempts: a close the desk has not replayed is sent again every trading day', () => {
    // capture_requires_replay is resent at every review until the desk replays
    // the failed close here, and a month of that is thirty. The number is what
    // the desk reads to see how long a replay has waited.
    const waited = normalizeQuarantineBody(body({ items: [item({ code: 'capture_requires_replay', attempts: 31 })] }));
    expect(waited.items[0]).toMatchObject({ code: 'capture_requires_replay', attempts: 31 });
  });

  it('rejects a timestamp beyond the five minute future skew, on the report and on an item', () => {
    expect(() => normalizeQuarantineBody(body({ reportedAt: '2026-09-21T17:05:00.001Z' }))).toThrow('invalid_quarantine_report');
    expect(() => normalizeQuarantineBody(body({ items: [item({ quarantinedAt: '2026-09-21T17:05:00.001Z' })] })))
      .toThrow('invalid_quarantine_report');
    expect(normalizeQuarantineBody(body({ reportedAt: '2026-09-21T17:05:00Z' })).reportedAt).toBe('2026-09-21T17:05:00Z');
  });

  it('rejects the same capture twice, which is not a folder', () => {
    expect(() => normalizeQuarantineBody(body({ items: [item(), item({ tradingDate: '2026-09-15' })] })))
      .toThrow('invalid_quarantine_report');
  });

  it('accepts every code the agent can write', () => {
    const codes = [...QUARANTINE_CODES];
    expect(codes).toEqual(expect.arrayContaining([
      'snapshot_processing_failed', 'unsupported_schema_version', 'snapshot_rejected',
      'payload_too_large', 'capture_requires_replay', 'capture_conflict',
    ]));
    const items = codes.map((code, index) => item({
      code,
      captureId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    expect(normalizeQuarantineBody(body({ items })).items.map((entry) => entry.code)).toEqual(codes);
  });

  it('collapses a code it has not met to other rather than refusing the whole report', () => {
    // A newer agent with a new code is still a report worth reading: how
    // many, which dates, which will move on their own. The heartbeat refuses
    // such a code and that has already cost the desk a fleet of silent
    // devices once.
    expect(normalizeQuarantineBody(body({ items: [item({ code: 'a_code_from_next_year' })] })).items[0].code).toBe('other');
  });
});

describe('public ingest quarantine report', () => {
  it('disables Vercel body parsing so the route can enforce the wire byte limit', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it('records the report for the authenticated device and answers with the count', async () => {
    const { handler, calls } = setup();
    const res = await report(handler);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, recorded: 2 } });
    expect(calls.record).toEqual([{
      deviceId: DEVICE_ID,
      items: [
        item(),
        item({ tradingDate: '2026-09-17', captureId: CAPTURE_B, code: 'snapshot_rejected', attempts: 0, lastAttemptAt: null }),
      ],
    }]);
    // The device id comes from the credential, never from the body, and the
    // response carries nothing the agent did not already know.
    expect(JSON.stringify(res.body)).not.toContain(DEVICE_ID);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_ID);
  });

  it('authenticates before parsing or validating the body', async () => {
    const { handler, calls } = setup({
      authenticateImpl: async () => { throw new ApiError(401, 'invalid_device_credential'); },
    });
    const res = await report(handler, { probe: true });
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
    expect(calls.authenticate).toHaveLength(1);
    expect(calls.record).toHaveLength(0);
  });

  it('rejects an authenticated unknown field with a stable validation error', async () => {
    const { handler, calls } = setup();
    const res = await report(handler, body({ unexpected: 'secret' }));
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_quarantine_report' } });
    expect(calls.record).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('unexpected');
  });

  it('rejects more than 200 items with the same stable error', async () => {
    const { handler, calls } = setup();
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => item({
      captureId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    const res = await report(handler, body({ items }));
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_quarantine_report' } });
    expect(calls.record).toHaveLength(0);
  });

  it('rejects authenticated bodies over 64 KiB', async () => {
    const { handler, calls } = setup();
    const res = await report(handler, JSON.stringify({ value: 'x'.repeat(65 * 1024) }));
    expect(res).toMatchObject({ statusCode: 413, body: { error: 'invalid_quarantine_report' } });
    expect(calls.record).toHaveLength(0);
  });

  it('accepts a pre parsed object, because the platform always hands one over', async () => {
    const { handler, calls } = setup();
    const res = await report(handler, body(), { body: body() });
    expect(res).toMatchObject({ statusCode: 200 });
    expect(calls.record).toHaveLength(1);
  });

  it('answers 404 not_found when the migration has not run, which the agent already expects', async () => {
    // The same answer a CRM without this handler gives, and the agent treats
    // it the same way: one INFO line, one attempt a day, nothing on the device.
    const { handler } = setup({ recordImpl: async () => { throw new ApiError(404, 'not_found'); } });
    const res = await report(handler);
    expect(res).toMatchObject({ statusCode: 404, body: { error: 'not_found' } });
  });

  it('answers a store failure with a 503 the agent retries, and names the cause', async () => {
    const { handler, calls } = setup({
      recordImpl: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
    });
    const res = await report(handler);
    expect(res).toMatchObject({ statusCode: 503, body: { error: 'quarantine_report_unavailable', cause: 'server_timeout' } });
    expect(calls.record).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('canceling statement');
  });

  it('requires POST and initializes the service client only when invoked', async () => {
    const { handler, calls } = setup();
    expect(calls.createClient).toBe(0);
    const res = await report(handler, body(), { method: 'GET' });
    expect(res).toMatchObject({ statusCode: 405, body: { error: 'Method not allowed.' } });
    expect(res.headers.Allow).toBe('POST');
    expect(calls.createClient).toBe(0);
  });
});

describe('quarantine report Supabase adapter', () => {
  it('calls the replace RPC with the device and the normalized items and maps only the counts', async () => {
    const rpc = vi.fn(async () => ({
      data: { device_id: DEVICE_ID, recorded: 2, removed: 1, credential_hash: 'must-not-escape' },
      error: null,
    }));
    const payload = { deviceId: DEVICE_ID, items: normalizeQuarantineBody(body()).items };
    await expect(createQuarantineStore({ rpc }).recordReport(payload)).resolves.toEqual({
      deviceId: DEVICE_ID,
      recorded: 2,
      removed: 1,
    });
    expect(rpc).toHaveBeenCalledWith('record_ingest_quarantine_report', {
      p_device_id: DEVICE_ID,
      p_items: payload.items,
    });
  });

  it('rejects missing or unsafe RPC response shapes', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: null })) };
    await expect(createQuarantineStore(admin).recordReport({ deviceId: DEVICE_ID, items: [] }))
      .rejects.toThrow('Quarantine report RPC returned no device.');
  });

  it('maps a SQL validation denial to the controlled public 400', async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: null, error: { code: '22023', message: 'INVALID_QUARANTINE_REPORT' } })),
    };
    await expect(createQuarantineStore(admin).recordReport({ deviceId: DEVICE_ID, items: [] })).rejects.toMatchObject({
      status: 400,
      message: 'invalid_quarantine_report',
    });
  });

  it('maps a device the function will not accept to the credential error the agent re pairs on', async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'INVALID_INGEST_DEVICE' } })),
    };
    await expect(createQuarantineStore(admin).recordReport({ deviceId: DEVICE_ID, items: [] })).rejects.toMatchObject({
      status: 401,
      message: 'invalid_device_credential',
    });
  });

  it.each([
    [{ code: 'PGRST202', message: 'Could not find the function public.record_ingest_quarantine_report in the schema cache' }],
    [{ code: '42883', message: 'function public.record_ingest_quarantine_report(uuid, jsonb) does not exist' }],
    [{ code: '42P01', message: 'relation "public.ingest_quarantine_reports" does not exist' }],
  ])('answers a database without step 46 with the 404 a CRM without the endpoint gives %#', async (failure) => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: failure })) };
    await expect(createQuarantineStore(admin).recordReport({ deviceId: DEVICE_ID, items: [] })).rejects.toMatchObject({
      status: 404,
      message: 'not_found',
    });
  });

  it('propagates other RPC failures', async () => {
    const failure = { code: '08006', message: 'connection_failure' };
    const admin = { rpc: vi.fn(async () => ({ data: null, error: failure })) };
    await expect(createQuarantineStore(admin).recordReport({ deviceId: DEVICE_ID, items: [] })).rejects.toBe(failure);
  });
});
