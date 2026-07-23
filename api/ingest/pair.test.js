import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createHandler, createPairRateLimiter, createPairStore } from './pair.js';

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
    expect(res).toMatchObject({
      statusCode: 200,
      body: {
        deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        deviceId: DEVICE_ID,
        clientName: 'Acme Trading',
        schedule: { time: '16:45', timeZone: 'America/New_York' },
        agentVersion: '1.2.3',
        addonVersion: '4.5.6',
      },
    });
    expect(calls.limit).toHaveLength(1);
    expect(calls.pair).toEqual([expect.objectContaining({
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      machineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      credentialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      credentialPrefix: res.body.deviceToken.slice(0, 8),
    })]);
    expect(calls.audit).toEqual([expect.objectContaining({
      action: 'ingest_pair.succeeded',
      entityId: DEVICE_ID,
      afterData: { clientId: CLIENT_ID, deviceId: DEVICE_ID, agentVersion: '1.2.3', addonVersion: '4.5.6' },
    })]);
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
        if (payload.credentialHash !== winningHash) throw Object.assign(new Error('consumed detail'), { code: 'INVALID_PAIRING' });
        return { deviceId: DEVICE_ID, clientId: CLIENT_ID, clientName: 'Acme', scheduleTime: '16:45:00', scheduleTimezone: 'America/New_York' };
      },
    });
    expect((await pair(handler)).statusCode).toBe(200);
    expect(await pair(handler, body(change))).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
  });

  it.each(['invalid', 'expired', 'used', 'revoked'])('uses one public status and body for an %s code', async (reason) => {
    const { handler } = setup({ pairImpl: async () => { throw Object.assign(new Error(reason), { code: 'INVALID_PAIRING' }); } });
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
    ]) {
      expect(await pair(handler, payload)).toMatchObject({ statusCode: 400, body: { error: 'invalid_or_expired_code' } });
    }
    expect(calls.pair).toHaveLength(0);
    expect(calls.audit).toHaveLength(5);
    expect(calls.audit.every((entry) => entry.afterData.reasonCode === 'invalid_request')).toBe(true);
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
    expect(calls.audit[0].afterData).toEqual({ clientId: CLIENT_ID, deviceId: DEVICE_ID, agentVersion: '1.2.3', addonVersion: '4.5.6' });
  });
});

describe('pairing Supabase adapters', () => {
  it('uses atomic RPCs for pairing and durable rate limiting', async () => {
    const rpc = vi.fn(async (name) => ({
      data: name === 'pair_ingest_device'
        ? { id: DEVICE_ID, client_id: CLIENT_ID, schedule_time: '16:45:00', schedule_timezone: 'America/New_York' }
        : { allowed: true, retry_after_seconds: 0 },
      error: null,
    }));
    const clientQuery = { select: vi.fn(() => clientQuery), eq: vi.fn(() => clientQuery), maybeSingle: vi.fn(async () => ({ data: { name: 'Acme Trading' }, error: null })) };
    const admin = { rpc, from: vi.fn(() => clientQuery) };
    const store = createPairStore(admin);
    const limiter = createPairRateLimiter(admin, { maxAttempts: 5, windowSeconds: 60, blockSeconds: 120 });
    await store.pairDevice({ codeHash: 'a'.repeat(64), machineHash: 'b'.repeat(64), credentialHash: 'c'.repeat(64), credentialPrefix: 'prefix12', agentVersion: '1.2.3', addonVersion: '4.5.6' });
    await limiter.check({ keyHash: 'd'.repeat(64), now: new Date('2026-07-23T12:00:00Z') });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['pair_ingest_device', 'check_ingest_pair_rate_limit']);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_max_attempts: 5, p_window_seconds: 60, p_block_seconds: 120 });
  });
});
