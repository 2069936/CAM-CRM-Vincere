import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  createPairRateLimiter,
  createPairStore,
  PairingDeniedError,
} from './pair.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const NONCE = Buffer.alloc(32, 5).toString('base64url');

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
    enrollmentCode: 'abcd-efgh-jk',
    machineId: '  MACHINE-GUID  ',
    pairingNonce: NONCE,
    agentVersion: '1.2.3',
    addonVersion: '4.5.6',
    ...overrides,
  };
}

function setup({ pairImpl, limiterImpl, now = () => new Date('2026-07-23T12:00:00Z') } = {}) {
  const calls = { pair: [], audit: [], limit: [] };
  const store = {
    async pairDevice(payload) {
      calls.pair.push(payload);
      if (pairImpl) return pairImpl(payload);
      return {
        deviceId: DEVICE_ID,
        clientId: CLIENT_ID,
        clientName: 'Acme Trading',
        scheduleTime: '16:45:00',
        scheduleTimezone: 'America/New_York',
        agentVersion: payload.agentVersion,
        addonVersion: payload.addonVersion,
      };
    },
    async writeAudit(payload) { calls.audit.push(payload); },
  };
  const limiter = {
    async check(payload) {
      calls.limit.push(payload);
      return limiterImpl ? limiterImpl(payload) : { allowed: true, retryAfterSeconds: 0 };
    },
  };
  const handler = createHandler({
    createClients: () => ({ admin: {} }),
    createStore: () => store,
    createLimiter: () => limiter,
    trustedClientIp: () => '203.0.113.8',
    pepper: 'test-pepper',
    now,
  });
  return { handler, calls };
}

async function pair(handler, payload = body()) {
  const res = response();
  await handler({ method: 'POST', body: payload, headers: {} }, res);
  return res;
}

describe('public ingest pairing', () => {
  it('returns the deterministic device token once with client and 16:45 New York schedule', async () => {
    const { handler, calls } = setup();
    const res = await pair(handler);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      deviceId: DEVICE_ID,
      clientName: 'Acme Trading',
      schedule: { time: '16:45', timeZone: 'America/New_York' },
    });
    expect(calls.limit).toHaveLength(1);
    expect(calls.pair).toEqual([expect.objectContaining({
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      machineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      credentialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      credentialPrefix: res.body.deviceToken.slice(0, 8),
    })]);
    expect(calls.audit).toHaveLength(0);
  });

  it('returns the same token and device for an exact lost-response retry', async () => {
    const { handler, calls } = setup();
    const first = await pair(handler);
    const retry = await pair(handler);
    expect(retry.body.deviceToken).toBe(first.body.deviceToken);
    expect(retry.body.deviceId).toBe(first.body.deviceId);
    expect(calls.pair[1]).toEqual(calls.pair[0]);
  });

  it.each([
    ['different machine', { machineId: 'other-machine' }],
    ['different nonce', { pairingNonce: Buffer.alloc(32, 6).toString('base64url') }],
  ])('returns the same generic conflict for a %s retry', async (_label, change) => {
    let winningHash;
    const { handler } = setup({
      pairImpl: async (payload) => {
        if (!winningHash) winningHash = payload.credentialHash;
        if (payload.credentialHash !== winningHash) throw new PairingDeniedError('nonce_or_credential_conflict');
        return { deviceId: DEVICE_ID, clientId: CLIENT_ID, clientName: 'Acme', scheduleTime: '16:45:00', scheduleTimezone: 'America/New_York' };
      },
    });
    expect((await pair(handler)).statusCode).toBe(200);
    expect(await pair(handler, body(change))).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
  });

  it.each(['invalid', 'expired', 'used', 'revoked'])('uses one public status and body for an %s code', async (reason) => {
    const reasonCode = { invalid: 'code_not_found', expired: 'code_expired', used: 'code_consumed', revoked: 'code_revoked' }[reason];
    const { handler } = setup({ pairImpl: async () => { throw new PairingDeniedError(reasonCode); } });
    expect(await pair(handler)).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
  });

  it('rejects malformed bodies generically without looking up a code', async () => {
    const { handler, calls } = setup();
    for (const payload of [
      body({ enrollmentCode: 'bad' }),
      body({ machineId: '   ' }),
      body({ pairingNonce: 'short' }),
      body({ agentVersion: '' }),
      body({ addonVersion: 'x'.repeat(65) }),
      body({ agentVersion: '1.2.3-beta' }),
      body({ addonVersion: 'a'.repeat(64) }),
    ]) {
      expect(await pair(handler, payload)).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    }
    expect(calls.pair).toHaveLength(0);
    expect(calls.audit).toHaveLength(7);
    expect(calls.audit.every((entry) => entry.afterData.reasonCode === 'invalid_request')).toBe(true);
    expect(JSON.stringify(calls.audit)).not.toContain('a'.repeat(64));
  });

  it('uses the generic public denial for malformed JSON', async () => {
    const { handler, calls } = setup();
    const res = response();
    await handler({ method: 'POST', body: '{not-json', headers: {} }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    expect(calls.pair).toHaveLength(0);
    expect(calls.audit).toEqual([expect.objectContaining({ afterData: { reasonCode: 'invalid_request' } })]);
  });

  it('rate-limits before code lookup with the same body for known and unknown codes', async () => {
    const { handler, calls } = setup({ limiterImpl: async () => ({ allowed: false, retryAfterSeconds: 30 }) });
    const known = await pair(handler);
    const unknown = await pair(handler, body({ enrollmentCode: 'ZZZZ-ZZZZ-ZZ' }));
    expect(known).toMatchObject({ statusCode: 429, body: { error: 'invalid_or_expired_code' }, headers: { 'Retry-After': '30' } });
    expect(unknown.body).toEqual(known.body);
    expect(calls.pair).toHaveLength(0);
    expect(calls.audit.every((entry) => entry.afterData.reasonCode === 'rate_limited')).toBe(true);
  });

  it('supports injected durable limiter threshold and window reset behavior', async () => {
    let currentMs = Date.parse('2026-07-23T12:00:00Z');
    let windowStart = currentMs;
    let attempts = 0;
    const limiterImpl = async () => {
      if (currentMs - windowStart >= 60_000) { windowStart = currentMs; attempts = 0; }
      attempts += 1;
      return { allowed: attempts <= 2, retryAfterSeconds: attempts <= 2 ? 0 : 20 };
    };
    const { handler, calls } = setup({ limiterImpl, now: () => new Date(currentMs) });
    expect((await pair(handler)).statusCode).toBe(200);
    expect((await pair(handler)).statusCode).toBe(200);
    expect((await pair(handler)).statusCode).toBe(429);
    currentMs += 60_000;
    expect((await pair(handler)).statusCode).toBe(200);
    expect(calls.pair).toHaveLength(3);
  });

  it('returns pairing_unavailable when durable rate-limit infrastructure fails', async () => {
    const { handler, calls } = setup({ limiterImpl: async () => { throw new Error('rpc offline'); } });
    expect(await pair(handler)).toMatchObject({ statusCode: 500, body: { error: 'pairing_unavailable' } });
    expect(calls.pair).toHaveLength(0);
    expect(calls.audit).toEqual([expect.objectContaining({
      afterData: { reasonCode: 'rate_limit_unavailable', agentVersion: '1.2.3', addonVersion: '4.5.6' },
    })]);
    expect(JSON.stringify(calls.audit)).not.toContain('rpc offline');
  });

  it('never passes raw code, machine, nonce, token, IP, or request body to persistence or audit', async () => {
    const { handler, calls } = setup();
    const res = await pair(handler);
    const persisted = JSON.stringify(calls);
    expect(persisted).not.toContain('ABCDEFGHJK');
    expect(persisted).not.toContain('abcd-efgh-jk');
    expect(persisted).not.toContain('MACHINE-GUID');
    expect(persisted).not.toContain(NONCE);
    expect(persisted).not.toContain(res.body.deviceToken);
    expect(persisted).not.toContain('203.0.113.8');
    expect(calls.audit).toHaveLength(0);
  });

  it.each([
    ['code_not_found', 'ingest_pair.denied'],
    ['code_expired', 'ingest_pair.expired'],
    ['code_revoked', 'ingest_pair.denied'],
    ['code_consumed', 'ingest_pair.denied'],
    ['machine_conflict', 'ingest_pair.denied'],
    ['nonce_or_credential_conflict', 'ingest_pair.denied'],
    ['credential_conflict', 'ingest_pair.denied'],
    ['device_revoked', 'ingest_pair.denied'],
    ['client_ineligible', 'ingest_pair.denied'],
  ])('audits stable internal denial %s while preserving the generic public error', async (reasonCode, action) => {
    const { handler, calls } = setup({ pairImpl: async () => { throw new PairingDeniedError(reasonCode); } });
    expect(await pair(handler)).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    expect(calls.audit).toEqual([expect.objectContaining({
      action,
      afterData: { reasonCode, agentVersion: '1.2.3', addonVersion: '4.5.6' },
    })]);
  });

  it('returns pairing_unavailable for unknown RPC/infrastructure failures without mislabeling them', async () => {
    const { handler, calls } = setup({ pairImpl: async () => { throw new Error('connection detail'); } });
    expect(await pair(handler)).toMatchObject({ statusCode: 500, body: { error: 'pairing_unavailable' } });
    expect(calls.audit).toEqual([expect.objectContaining({
      action: 'ingest_pair.unavailable',
      afterData: { reasonCode: 'pairing_unavailable', agentVersion: '1.2.3', addonVersion: '4.5.6' },
    })]);
    expect(JSON.stringify(calls.audit)).not.toContain('connection detail');
  });

  it('returns no token for a legacy enrollment whose client is now ineligible', async () => {
    const { handler, calls } = setup({ pairImpl: async () => { throw new PairingDeniedError('client_ineligible'); } });
    const res = await pair(handler);
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    expect(res.body).not.toHaveProperty('deviceToken');
    expect(calls.audit).toEqual([expect.objectContaining({ afterData: expect.objectContaining({ reasonCode: 'client_ineligible' }) })]);
  });
});

describe('pairing Supabase adapters', () => {
  it('uses atomic RPCs for pairing and durable rate limiting', async () => {
    const rpc = vi.fn(async (name) => ({
      data: name === 'pair_ingest_device_v2'
        ? { device_id: DEVICE_ID, client_id: CLIENT_ID, client_name: 'Acme Trading', schedule_time: '16:45:00', schedule_timezone: 'America/New_York' }
        : { allowed: true, retry_after_seconds: 0 },
      error: null,
    }));
    const admin = { rpc, from: vi.fn() };
    const store = createPairStore(admin);
    const limiter = createPairRateLimiter(admin, { maxAttempts: 5, windowSeconds: 60, blockSeconds: 120 });
    await store.pairDevice({ codeHash: 'a'.repeat(64), machineHash: 'b'.repeat(64), credentialHash: 'c'.repeat(64), credentialPrefix: 'prefix12', agentVersion: '1.2.3', addonVersion: '4.5.6' });
    await limiter.check({ keyHash: 'd'.repeat(64), now: new Date('2026-07-23T12:00:00Z') });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['pair_ingest_device_v2', 'check_ingest_pair_rate_limit']);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_max_attempts: 5, p_window_seconds: 60, p_block_seconds: 120 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it.each([
    ['CODE_NOT_FOUND', 'code_not_found'],
    ['CODE_EXPIRED', 'code_expired'],
    ['CODE_REVOKED', 'code_revoked'],
    ['CODE_CONSUMED', 'code_consumed'],
    ['MACHINE_CONFLICT', 'machine_conflict'],
    ['NONCE_OR_CREDENTIAL_CONFLICT', 'nonce_or_credential_conflict'],
    ['CREDENTIAL_CONFLICT', 'credential_conflict'],
    ['DEVICE_REVOKED', 'device_revoked'],
    ['CLIENT_INELIGIBLE', 'client_ineligible'],
  ])('maps known SQL denial %s to stable internal code %s', async (message, reasonCode) => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message } })), from: vi.fn() };
    await expect(createPairStore(admin).pairDevice({})).rejects.toMatchObject({ reasonCode });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('propagates unknown SQL failures without classifying them as invalid code', async () => {
    const sqlError = { code: '08006', message: 'connection_failure' };
    const admin = { rpc: vi.fn(async () => ({ data: null, error: sqlError })), from: vi.fn() };
    await expect(createPairStore(admin).pairDevice({})).rejects.toBe(sqlError);
  });

  it.each([
    ['MACHINE_CONFLICT', 'machine_conflict'],
    ['CREDENTIAL_CONFLICT', 'credential_conflict'],
  ])('maps constraint-specific insert race result %s to generic public denial via %s', async (message, reasonCode) => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message } })), from: vi.fn() };
    const store = createPairStore(admin);
    const { handler, calls } = setup({ pairImpl: (payload) => store.pairDevice(payload) });
    expect(await pair(handler)).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    expect(calls.audit).toEqual([expect.objectContaining({ afterData: expect.objectContaining({ reasonCode }) })]);
  });

  it('rejects a non-string or blank client name returned by the atomic RPC', async () => {
    for (const clientName of [{ secret: 'value' }, '   ']) {
      const admin = {
        rpc: vi.fn(async () => ({
          data: { device_id: DEVICE_ID, client_id: CLIENT_ID, client_name: clientName, schedule_time: '16:45:00', schedule_timezone: 'America/New_York' },
          error: null,
        })),
        from: vi.fn(),
      };
      await expect(createPairStore(admin).pairDevice({})).rejects.toThrow('Pairing RPC returned no device.');
      expect(admin.from).not.toHaveBeenCalled();
    }
  });
});
