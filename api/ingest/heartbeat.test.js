import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../_lib/http.js';
import {
  createHandler,
  createHeartbeatStore,
  normalizeHeartbeatBody,
  parseHeartbeatIntervalSeconds,
} from './heartbeat.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function body(overrides = {}) {
  return {
    agentVersion: '1.2.3',
    addonVersion: '4.5.6',
    ninjaTraderVersion: '8.1.4.2',
    lastCaptureAt: '2026-07-23T15:40:00-05:00',
    lastSuccessAt: '2026-07-23T20:41:00Z',
    lastErrorCode: null,
    lastErrorMessage: null,
    queueDepth: 2,
    queueBytes: 4096,
    addonAvailable: true,
    ...overrides,
  };
}

function setup({
  minimumAgentVersion = '1.2.3',
  authenticateImpl,
  recordImpl,
  minIntervalSeconds = 30,
} = {}) {
  const calls = { authenticate: [], record: [], createClient: 0 };
  const admin = {};
  const authStore = {};
  const store = {
    async recordHeartbeat(payload) {
      calls.record.push(payload);
      if (recordImpl) return recordImpl(payload);
      return {
        deviceId: DEVICE_ID,
        status: payload.healthStatus,
        throttled: false,
        scheduleTime: '16:45:00',
        scheduleTimezone: 'America/New_York',
      };
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
        scheduleTime: '16:45:00',
        scheduleTimezone: 'America/New_York',
      };
    },
    pepper: 'test-pepper',
    minimumAgentVersion,
    minIntervalSeconds,
  });
  return { handler, calls };
}

async function heartbeat(handler, payload = body(), overrides = {}) {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer redacted', 'x-machine-id': 'redacted' },
    body: payload,
    ...overrides,
  };
  const res = response();
  await handler(req, res);
  return res;
}

describe('heartbeat body validation', () => {
  it('accepts only the allowlisted collector metadata and normalizes nullable values', () => {
    expect(normalizeHeartbeatBody(body({ lastErrorCode: '', addonAvailable: null }))).toEqual({
      ...body({ lastErrorCode: null, addonAvailable: null }),
      lastErrorCode: null,
    });
  });

  it('rejects arrays, null, and objects with custom prototypes', () => {
    expect(() => normalizeHeartbeatBody([])).toThrow('invalid_heartbeat');
    expect(() => normalizeHeartbeatBody(null)).toThrow('invalid_heartbeat');
    expect(() => normalizeHeartbeatBody(Object.assign(Object.create({ inherited: true }), body())))
      .toThrow('invalid_heartbeat');
  });

  it('rejects unknown keys including a client-supplied status', () => {
    expect(() => normalizeHeartbeatBody(body({ status: 'online' }))).toThrow('invalid_heartbeat');
    expect(() => normalizeHeartbeatBody(body({ updateRequired: false }))).toThrow('invalid_heartbeat');
  });

  it.each([
    ['agentVersion', '1.2-beta'],
    ['addonVersion', '4'],
    ['ninjaTraderVersion', 'latest'],
  ])('rejects an invalid %s', (field, value) => {
    expect(() => normalizeHeartbeatBody(body({ [field]: value }))).toThrow('invalid_heartbeat');
  });

  it('rejects a null NinjaTrader version because every reported version is strict numeric dotted', () => {
    expect(() => normalizeHeartbeatBody(body({ ninjaTraderVersion: null }))).toThrow('invalid_heartbeat');
  });

  it.each([
    ['lastCaptureAt', '2026-07-23'],
    ['lastCaptureAt', '2026-07-23T20:40:00'],
    ['lastCaptureAt', '2026-02-30T20:40:00Z'],
    ['lastSuccessAt', 'not-a-date'],
    ['lastSuccessAt', 123],
  ])('rejects invalid or offset-free %s value %j', (field, value) => {
    expect(() => normalizeHeartbeatBody(body({ [field]: value }))).toThrow('invalid_heartbeat');
  });

  it.each([
    ['queueDepth', -1],
    ['queueDepth', 1.5],
    ['queueDepth', Number.MAX_SAFE_INTEGER + 1],
    ['queueBytes', '10'],
    ['queueBytes', Number.POSITIVE_INFINITY],
  ])('rejects invalid %s value %j', (field, value) => {
    expect(() => normalizeHeartbeatBody(body({ [field]: value }))).toThrow('invalid_heartbeat');
  });

  it.each([false, 'true', 1])('rejects invalid addon availability %j', (value) => {
    if (value === false) {
      expect(normalizeHeartbeatBody(body({ addonAvailable: value })).addonAvailable).toBe(false);
      return;
    }
    expect(() => normalizeHeartbeatBody(body({ addonAvailable: value }))).toThrow('invalid_heartbeat');
  });

  it.each([
    'unknown_failure',
    'NINJATRADER_NOT_RUNNING',
    42,
  ])('rejects unsupported stable error code %j', (value) => {
    expect(() => normalizeHeartbeatBody(body({ lastErrorCode: value }))).toThrow('invalid_heartbeat');
  });

  it('accepts every supported stable error code', () => {
    const codes = [
      'ninjatrader_not_running', 'addon_unavailable', 'capture_timeout', 'capture_failed',
      'contract_mismatch', 'queue_capacity_warning', 'upload_failed', 'configuration_error',
    ];
    expect(codes.map((lastErrorCode) => normalizeHeartbeatBody(body({ lastErrorCode })).lastErrorCode))
      .toEqual(codes);
  });

  it('strips control characters and clamps free-form error text to 256 Unicode characters', () => {
    const normalized = normalizeHeartbeatBody(body({
      lastErrorMessage: `before\u0000\u001f\u007f${'💥'.repeat(300)}after`,
    }));
    expect(Array.from(normalized.lastErrorMessage)).toHaveLength(256);
    expect(Array.from(normalized.lastErrorMessage).every((character) => {
      const code = character.codePointAt(0);
      return code > 31 && !(code >= 127 && code <= 159);
    })).toBe(true);
    expect(normalized.lastErrorMessage).toContain('before');
  });

  it('rejects non-string free-form error text', () => {
    expect(() => normalizeHeartbeatBody(body({ lastErrorMessage: { secret: true } })))
      .toThrow('invalid_heartbeat');
  });
});

describe('public ingest heartbeat', () => {
  it.each([
    ['1.2.2', 'update_required', true],
    ['1.2.3', 'online', false],
    ['1.2.4', 'online', false],
  ])('calculates server status for agent %s', async (agentVersion, status, updateRequired) => {
    const { handler, calls } = setup();
    const res = await heartbeat(handler, body({ agentVersion }));
    expect(res).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        deviceId: DEVICE_ID,
        status,
        updateRequired,
        throttled: false,
        schedule: { time: '16:45', timeZone: 'America/New_York' },
      },
    });
    expect(calls.record).toEqual([expect.objectContaining({
      deviceId: DEVICE_ID,
      healthStatus: status,
      minIntervalSeconds: 30,
    })]);
    expect(res.body).not.toHaveProperty('lastErrorMessage');
  });

  it('uses error health when a supported error is reported by a current agent', async () => {
    const { handler, calls } = setup();
    const res = await heartbeat(handler, body({ lastErrorCode: 'capture_timeout', lastErrorMessage: 'private detail' }));
    expect(res.body).toMatchObject({ status: 'error', updateRequired: false });
    expect(calls.record[0]).toMatchObject({
      healthStatus: 'error',
      lastErrorCode: 'capture_timeout',
      lastErrorMessage: 'private detail',
    });
    expect(JSON.stringify(res.body)).not.toContain('private detail');
  });

  it('keeps update-required status authoritative even when the old agent reports an error', async () => {
    const { handler } = setup({ minimumAgentVersion: '2.0.0' });
    const res = await heartbeat(handler, body({ lastErrorCode: 'capture_failed' }));
    expect(res.body).toMatchObject({ status: 'update_required', updateRequired: true });
  });

  it('returns the RPC throttling and schedule result rather than request or auth defaults', async () => {
    const { handler } = setup({
      recordImpl: async () => ({
        deviceId: DEVICE_ID,
        status: 'online',
        throttled: true,
        scheduleTime: '17:15:00',
        scheduleTimezone: 'America/New_York',
      }),
    });
    const res = await heartbeat(handler);
    expect(res.body).toMatchObject({
      throttled: true,
      schedule: { time: '17:15', timeZone: 'America/New_York' },
    });
  });

  it('authenticates before parsing or validating the body', async () => {
    const { handler, calls } = setup({
      authenticateImpl: async () => { throw new ApiError(401, 'invalid_device_credential'); },
    });
    const res = await heartbeat(handler, { status: 'probe', unknown: true });
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
    expect(calls.authenticate).toHaveLength(1);
    expect(calls.record).toHaveLength(0);
  });

  it('rejects an authenticated unknown field with a stable validation error', async () => {
    const { handler, calls } = setup();
    const res = await heartbeat(handler, body({ unexpected: 'secret' }));
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_heartbeat' } });
    expect(calls.record).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('unexpected');
  });

  it('rejects authenticated bodies over 8 KiB', async () => {
    const { handler, calls } = setup();
    const res = await heartbeat(handler, JSON.stringify({ value: 'x'.repeat(9 * 1024) }));
    expect(res).toMatchObject({ statusCode: 413, body: { error: 'invalid_heartbeat' } });
    expect(calls.record).toHaveLength(0);
  });

  it('fails invalid nonblank minimum-version configuration with a sanitized 500', async () => {
    const { handler, calls } = setup({ minimumAgentVersion: 'latest-secret' });
    const res = await heartbeat(handler);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'heartbeat_unavailable' } });
    expect(calls.authenticate).toHaveLength(1);
    expect(calls.record).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('latest-secret');
  });

  it('allows a blank minimum version without requiring an update', async () => {
    const { handler } = setup({ minimumAgentVersion: '' });
    expect((await heartbeat(handler)).body).toMatchObject({ status: 'online', updateRequired: false });
  });

  it('requires POST and initializes the service client only when invoked', async () => {
    const { handler, calls } = setup();
    expect(calls.createClient).toBe(0);
    const res = await heartbeat(handler, body(), { method: 'GET' });
    expect(res).toMatchObject({ statusCode: 405, body: { error: 'Method not allowed.' } });
    expect(res.headers.Allow).toBe('POST');
    expect(calls.createClient).toBe(0);
  });
});

describe('heartbeat configuration and Supabase adapter', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['15', 15],
    ['0', 30],
    ['1.5', 30],
    ['not-a-number', 30],
    ['999999', 3600],
  ])('parses bounded interval %j as %d seconds', (value, expected) => {
    expect(parseHeartbeatIntervalSeconds(value)).toBe(expected);
  });

  it('calls the atomic heartbeat RPC with allowlisted fields and maps only its safe result', async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        device_id: DEVICE_ID,
        health_status: 'online',
        throttled: false,
        schedule_time: '16:45:00',
        schedule_timezone: 'America/New_York',
        credential_hash: 'must-not-escape',
      }],
      error: null,
    }));
    const payload = {
      deviceId: DEVICE_ID,
      ...normalizeHeartbeatBody(body()),
      healthStatus: 'online',
      minIntervalSeconds: 30,
    };
    await expect(createHeartbeatStore({ rpc }).recordHeartbeat(payload)).resolves.toEqual({
      deviceId: DEVICE_ID,
      status: 'online',
      throttled: false,
      scheduleTime: '16:45:00',
      scheduleTimezone: 'America/New_York',
    });
    expect(rpc).toHaveBeenCalledWith('record_ingest_heartbeat', {
      p_device_id: DEVICE_ID,
      p_agent_version: '1.2.3',
      p_addon_version: '4.5.6',
      p_ninjatrader_version: '8.1.4.2',
      p_last_capture_at: '2026-07-23T15:40:00-05:00',
      p_last_success_at: '2026-07-23T20:41:00Z',
      p_last_error_code: null,
      p_last_error_message: null,
      p_queue_depth: 2,
      p_queue_bytes: 4096,
      p_addon_available: true,
      p_health_status: 'online',
      p_min_interval_seconds: 30,
    });
  });

  it('rejects missing or unsafe RPC response shapes', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    await expect(createHeartbeatStore(admin).recordHeartbeat({})).rejects.toThrow('Heartbeat RPC returned no device.');
  });

  it('propagates RPC failures', async () => {
    const failure = { code: '08006', message: 'connection_failure' };
    const admin = { rpc: vi.fn(async () => ({ data: null, error: failure })) };
    await expect(createHeartbeatStore(admin).recordHeartbeat({})).rejects.toBe(failure);
  });
});
