import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceAuthStore,
  requireIngestDevice,
} from './deviceAuth.js';
import { digestDeviceToken, digestMachineId } from './ingestTokens.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const PEPPER = 'test-pepper';
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const MACHINE_ID = '  A1B2-C3D4  ';

function request(overrides = {}) {
  return {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-machine-id': MACHINE_ID,
      ...overrides,
    },
  };
}

function storedDevice(overrides = {}) {
  return {
    id: DEVICE_ID,
    client_id: CLIENT_ID,
    credential_hash: digestDeviceToken(TOKEN, PEPPER),
    machine_id_hash: digestMachineId(MACHINE_ID, PEPPER),
    status: 'active',
    revoked_at: null,
    schedule_time: '16:45:00',
    schedule_timezone: 'America/New_York',
    ...overrides,
  };
}

function setup(candidate = storedDevice()) {
  const lookups = [];
  const store = {
    async findByCredentialDigest(value) {
      lookups.push(value);
      return candidate;
    },
  };
  return { store, lookups };
}

describe('ingest device authentication', () => {
  it('authenticates a valid bearer credential bound to the normalized MachineGuid', async () => {
    const { store, lookups } = setup();
    const device = await requireIngestDevice(request(), { store, pepper: PEPPER });
    expect(lookups).toEqual([digestDeviceToken(TOKEN, PEPPER)]);
    expect(device).toEqual({
      id: DEVICE_ID,
      clientId: CLIENT_ID,
      status: 'active',
      revokedAt: null,
      scheduleTime: '16:45:00',
      scheduleTimezone: 'America/New_York',
    });
    expect(JSON.stringify(device)).not.toContain('credential_hash');
    expect(JSON.stringify(device)).not.toContain('machine_id_hash');
    expect(JSON.stringify(device)).not.toContain(TOKEN);
    expect(JSON.stringify(device)).not.toContain('a1b2-c3d4');
  });

  it.each([
    ['missing bearer', request({ authorization: undefined }), storedDevice()],
    ['malformed bearer', request({ authorization: 'Basic abc' }), storedDevice()],
    ['malformed token', request({ authorization: 'Bearer too-short' }), storedDevice()],
    ['missing machine', request({ 'x-machine-id': undefined }), storedDevice()],
    ['malformed machine', request({ 'x-machine-id': 'bad\u0000machine' }), storedDevice()],
    ['unknown token', request(), null],
    ['wrong token', request({ authorization: `Bearer ${Buffer.alloc(32, 9).toString('base64url')}` }), storedDevice()],
    ['machine mismatch', request(), storedDevice({ machine_id_hash: digestMachineId('other-machine', PEPPER) })],
    ['revoked timestamp', request(), storedDevice({ revoked_at: '2026-07-23T12:00:00Z' })],
    ['revoked lifecycle', request(), storedDevice({ status: 'revoked' })],
  ])('returns the same stable 401 for %s', async (_label, req, candidate) => {
    const { store } = setup(candidate);
    await expect(requireIngestDevice(req, { store, pepper: PEPPER })).rejects.toMatchObject({
      status: 401,
      message: 'invalid_device_credential',
    });
  });

  it('does not query the store when required headers have an invalid shape', async () => {
    const { store, lookups } = setup();
    await expect(requireIngestDevice(request({ authorization: 'Bearer short' }), { store, pepper: PEPPER }))
      .rejects.toMatchObject({ status: 401, message: 'invalid_device_credential' });
    expect(lookups).toHaveLength(0);
  });

  it('propagates storage failures for sanitized 500 handling instead of misclassifying them as credentials', async () => {
    const failure = new Error('database secret');
    const store = { findByCredentialDigest: vi.fn(async () => { throw failure; }) };
    await expect(requireIngestDevice(request(), { store, pepper: PEPPER })).rejects.toBe(failure);
  });
});

describe('device authentication Supabase adapter', () => {
  it('selects only authentication and safe handler fields by credential digest', async () => {
    const candidate = storedDevice();
    const maybeSingle = vi.fn(async () => ({ data: candidate, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const store = createDeviceAuthStore({ from });

    await expect(store.findByCredentialDigest(candidate.credential_hash)).resolves.toEqual(candidate);
    expect(from).toHaveBeenCalledWith('ingest_devices');
    expect(select).toHaveBeenCalledWith('id, client_id, credential_hash, machine_id_hash, status, revoked_at, schedule_time, schedule_timezone');
    expect(eq).toHaveBeenCalledWith('credential_hash', candidate.credential_hash);
    expect(maybeSingle).toHaveBeenCalledOnce();
  });

  it('propagates Supabase query failures', async () => {
    const failure = { code: '08006', message: 'connection_failure' };
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: failure }) }),
        }),
      }),
    };
    await expect(createDeviceAuthStore(admin).findByCredentialDigest('digest')).rejects.toBe(failure);
  });
});
