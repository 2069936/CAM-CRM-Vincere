import { describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  createIngestEnrollmentStore,
  REBIND_REASONS,
  REVOKE_REASONS,
} from './ingest-enrollment.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(method, body) {
  return { method, body, headers: { authorization: 'Bearer browser-session' } };
}

function setup({ role = 'Manager', assigned = true, createError } = {}) {
  const calls = { create: [], revoke: [], audit: [] };
  const store = {
    async createEnrollment(payload) {
      calls.create.push(payload);
      if (createError) throw Object.assign(new Error('database detail'), createError);
      return {
        enrollmentId: ENROLLMENT_ID,
        clientId: CLIENT_ID,
        clientName: 'Acme Trading',
        expiresAt: payload.expiresAt,
        revokedDeviceIds: payload.rebind ? [DEVICE_ID] : [],
      };
    },
    async revokeAccess(payload) {
      calls.revoke.push(payload);
      return { clientId: CLIENT_ID, kind: payload.deviceId ? 'device' : 'enrollment', id: payload.deviceId || payload.enrollmentId };
    },
    async writeAudit(payload) { calls.audit.push(payload); },
  };
  const authorize = vi.fn(async (_req, options) => {
    if (role === 'CAM' && !assigned) throw Object.assign(new Error('Client assignment required.'), { status: 403 });
    expect(options.roles).toEqual(['Manager', 'CAM']);
    expect(options.clientUuid).toBe(CLIENT_ID);
    return { id: 'actor-1', role };
  });
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize,
    createStore: () => store,
    pepper: 'test-pepper',
    now: () => new Date('2026-07-23T12:00:00.000Z'),
    issueCode: () => ({
      code: 'ABCDEFGHJK',
      record: { credentialHash: 'a'.repeat(64), expiresAt: '2026-07-23T13:00:00.000Z' },
    }),
    logger,
  });
  return { handler, calls, authorize, logger };
}

describe('admin ingest enrollment', () => {
  it.each(['Manager', 'CAM'])('allows an authorized %s to atomically generate a client-scoped code', async (role) => {
    const { handler, calls } = setup({ role });
    const res = response();
    await handler(request('POST', { clientUuid: CLIENT_ID }), res);

    expect(res).toMatchObject({
      statusCode: 201,
      body: {
        enrollment: {
          id: ENROLLMENT_ID,
          clientUuid: CLIENT_ID,
          clientName: 'Acme Trading',
          code: 'ABCDEFGHJK',
          expiresAt: '2026-07-23T13:00:00.000Z',
        },
      },
    });
    expect(calls.create).toEqual([expect.objectContaining({
      clientId: CLIENT_ID,
      createdBy: 'actor-1',
      codeHash: 'a'.repeat(64),
      rebind: false,
    })]);
    expect(calls.create[0]).toMatchObject({ actionCode: 'generated', reasonCode: null });
    expect(calls.audit).toHaveLength(0);
  });

  it('denies an unassigned CAM before any enrollment mutation', async () => {
    const { handler, calls } = setup({ role: 'CAM', assigned: false });
    const res = response();
    await handler(request('POST', { clientUuid: CLIENT_ID }), res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Client assignment required.' } });
    expect(calls.create).toHaveLength(0);
  });

  it('uses an atomic rebind operation that revokes active devices and old codes', async () => {
    const { handler, calls } = setup();
    const res = response();
    await handler(request('POST', { action: 'rebind', clientUuid: CLIENT_ID, reason: 'vps_rebuilt' }), res);
    expect(res.statusCode).toBe(201);
    expect(calls.create[0]).toMatchObject({ rebind: true, actionCode: 'rebound', reasonCode: 'vps_rebuilt' });
    expect(calls.audit).toHaveLength(0);
  });

  it('returns a stable eligibility error without exposing a client product key or database detail', async () => {
    const { handler } = setup({ createError: { code: 'CLIENT_NOT_ELIGIBLE' } });
    const res = response();
    await handler(request('POST', { clientUuid: CLIENT_ID }), res);
    expect(res).toMatchObject({ statusCode: 409, body: { error: 'client_not_eligible' } });
    expect(JSON.stringify(res.body)).not.toMatch(/product|database detail/i);
  });

  it('returns no enrollment code when SQL rejects an empty client name before mutation', async () => {
    const { handler, calls } = setup({ createError: { code: 'CLIENT_NOT_ELIGIBLE' } });
    const res = response();
    await handler(request('POST', { clientUuid: CLIENT_ID }), res);
    expect(res).toEqual(expect.objectContaining({ statusCode: 409, body: { error: 'client_not_eligible' } }));
    expect(res.body).not.toHaveProperty('enrollment');
    expect(calls.audit).toHaveLength(0);
  });

  it('atomically revokes a client-scoped enrollment or device with a sanitized reason', async () => {
    const { handler, calls } = setup();
    const enrollmentRes = response();
    await handler(request('DELETE', { clientUuid: CLIENT_ID, enrollmentId: ENROLLMENT_ID, reason: 'support_reset' }), enrollmentRes);
    expect(enrollmentRes).toMatchObject({ statusCode: 200, body: { revoked: { kind: 'enrollment', id: ENROLLMENT_ID } } });
    expect(calls.revoke[0]).toMatchObject({ clientId: CLIENT_ID, enrollmentId: ENROLLMENT_ID, reasonCode: 'support_reset', actorId: 'actor-1' });

    const deviceRes = response();
    await handler(request('DELETE', { clientUuid: CLIENT_ID, deviceId: DEVICE_ID, reason: 'security_revoke' }), deviceRes);
    expect(deviceRes).toMatchObject({ statusCode: 200, body: { revoked: { kind: 'device', id: DEVICE_ID } } });
    expect(calls.audit).toHaveLength(0);
  });

  it('rejects malformed UUIDs, actions, reasons, and ambiguous revoke targets', async () => {
    const { handler, calls } = setup();
    for (const [method, body] of [
      ['POST', { clientUuid: 'not-a-uuid' }],
      ['POST', { clientUuid: CLIENT_ID, action: 'rotate' }],
      ['DELETE', { clientUuid: CLIENT_ID, enrollmentId: ENROLLMENT_ID, deviceId: DEVICE_ID }],
      ['POST', { clientUuid: CLIENT_ID, action: 'rebind', reason: 'operator_request' }],
      ['DELETE', { clientUuid: CLIENT_ID, enrollmentId: ENROLLMENT_ID, reason: '<secret>' }],
    ]) {
      const res = response();
      await handler(request(method, body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(calls.create).toHaveLength(0);
    expect(calls.revoke).toHaveLength(0);
  });

  it('never sends raw codes, product keys, or secret hashes to audit and logger arguments', async () => {
    const { handler, calls, logger } = setup();
    const res = response();
    await handler(request('POST', { clientUuid: CLIENT_ID }), res);
    const sideEffects = JSON.stringify({ audit: calls.audit, logs: logger.error.mock.calls, create: calls.create });
    expect(sideEffects).not.toContain('ABCDEFGHJK');
    expect(sideEffects).not.toContain('product_key');
    expect(JSON.stringify(calls.audit)).not.toContain('a'.repeat(64));
  });

  it('exports narrow rebind and revoke reason allowlists and rejects secret-shaped reasons', async () => {
    expect(REBIND_REASONS).toEqual(['vps_rebuilt', 'device_replaced', 'support_reset']);
    expect(REVOKE_REASONS).toEqual(['client_offboarded', 'security_revoke', 'support_reset']);
    const { handler, calls } = setup();
    for (const [method, payload] of [
      ['POST', { action: 'rebind', clientUuid: CLIENT_ID, reason: 'a'.repeat(64) }],
      ['DELETE', { clientUuid: CLIENT_ID, deviceId: DEVICE_ID, reason: 'b'.repeat(64) }],
    ]) {
      expect(await (async () => { const res = response(); await handler(request(method, payload), res); return res; })())
        .toMatchObject({ statusCode: 400 });
    }
    expect(calls.create).toHaveLength(0);
    expect(calls.revoke).toHaveLength(0);
    expect(calls.audit).toHaveLength(0);
  });

  it.each(['null', '42', '"text"'])('returns controlled 400 for primitive JSON body %s', async (rawBody) => {
    const { handler, calls } = setup();
    const res = response();
    await handler({ method: 'POST', body: rawBody, headers: { authorization: 'Bearer browser-session' } }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_request' } });
    expect(calls.create).toHaveLength(0);
  });
});

describe('ingest enrollment Supabase store', () => {
  it('calls only atomic RPCs and maps their stable result', async () => {
    const rpc = vi.fn(async (name) => ({
      data: name === 'create_ingest_enrollment'
        ? { enrollment_id: ENROLLMENT_ID, client_id: CLIENT_ID, client_name: 'Acme Trading', expires_at: '2026-07-23T13:00:00Z', revoked_device_ids: [] }
        : { client_id: CLIENT_ID, revoked_kind: 'device', revoked_id: DEVICE_ID },
      error: null,
    }));
    const admin = { rpc, from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) };
    const store = createIngestEnrollmentStore(admin);
    expect(await store.createEnrollment({ clientId: CLIENT_ID, codeHash: 'a'.repeat(64), createdBy: 'actor-1', expiresAt: '2026-07-23T13:00:00Z', rebind: false, actionCode: 'generated', reasonCode: null }))
      .toMatchObject({ enrollmentId: ENROLLMENT_ID, clientName: 'Acme Trading' });
    expect(await store.revokeAccess({ clientId: CLIENT_ID, deviceId: DEVICE_ID, reasonCode: 'security_revoke', actorId: 'actor-1' }))
      .toEqual({ clientId: CLIENT_ID, kind: 'device', id: DEVICE_ID });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['create_ingest_enrollment', 'revoke_ingest_access']);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action_code: 'generated', p_reason_code: null });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_actor_id: 'actor-1', p_reason_code: 'security_revoke' });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('does not attempt a post-commit audit when an atomic mutation RPC fails', async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'audit insert failed' } })),
      from: vi.fn(),
    };
    await expect(createIngestEnrollmentStore(admin).createEnrollment({
      clientId: CLIENT_ID,
      codeHash: 'a'.repeat(64),
      createdBy: 'actor-1',
      expiresAt: '2026-07-23T13:00:00Z',
      rebind: false,
      actionCode: 'generated',
      reasonCode: null,
    })).rejects.toThrow();
    expect(admin.from).not.toHaveBeenCalled();
  });
});
