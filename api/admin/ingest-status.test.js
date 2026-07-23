import { describe, expect, it, vi } from 'vitest';
import { createHandler, createIngestStatusStore, resolveInstallerRelease } from './ingest-status.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ENROLLMENT_ID = '33333333-3333-4333-8333-333333333333';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

const releaseEnv = {
  AUTO_COLLECTION_INSTALLER_URL: 'https://downloads.example.test/vincere-agent.msi',
  AUTO_COLLECTION_INSTALLER_VERSION: '1.4.2',
  AUTO_COLLECTION_INSTALLER_SHA256: 'a'.repeat(64),
  AUTO_COLLECTION_INSTALLER_PUBLISHED_AT: '2026-07-23T14:00:00.000Z',
};

function setup({ authorize, status } = {}) {
  const safeStatus = status || {
    client: { id: CLIENT_ID, name: 'Acme Trading' },
    device: {
      id: DEVICE_ID,
      status: 'active',
      health_status: 'online',
      agent_version: '1.4.2',
      addon_version: '1.1.0',
      ninjatrader_version: '8.1.5.2',
      schedule_time: '16:45:00',
      schedule_timezone: 'America/New_York',
      last_seen_at: '2026-07-23T16:40:00.000Z',
      last_capture_at: '2026-07-22T20:45:00.000Z',
      last_success_at: '2026-07-22T20:46:00.000Z',
      last_error_code: 'private_database_detail',
      revoked_at: null,
      machine_id_hash: 'must-not-leak',
      credential_hash: 'must-not-leak',
      metadata: { lastErrorMessage: 'must-not-leak' },
    },
    enrollment: {
      id: ENROLLMENT_ID,
      expires_at: '2026-07-23T17:00:00.000Z',
      consumed_at: '2026-07-23T15:00:00.000Z',
      revoked_at: null,
      code_hash: 'must-not-leak',
    },
  };
  const calls = [];
  const assignments = [];
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: authorize || vi.fn(async (_req, options) => {
      calls.push(options);
      return { id: 'actor-1', role: 'Manager' };
    }),
    enforceAssignment: vi.fn(async (_admin, actor, clientId) => {
      assignments.push({ actor, clientId });
    }),
    createStore: () => ({ load: vi.fn(async () => safeStatus) }),
    env: releaseEnv,
    production: true,
    now: () => new Date('2026-07-23T16:45:00.000Z'),
  });
  return { handler, calls, assignments };
}

describe('collector profile status endpoint', () => {
  it('authorizes Manager or assigned CAM against the requested client', async () => {
    const { handler, calls, assignments } = setup();
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: CLIENT_ID }, headers: { authorization: 'Bearer session' } }, res);
    expect(calls).toEqual([expect.objectContaining({ roles: ['Manager', 'CAM'] })]);
    expect(calls[0]).not.toHaveProperty('clientUuid');
    expect(assignments).toEqual([{ actor: { id: 'actor-1', role: 'Manager' }, clientId: CLIENT_ID }]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('returns only safe binding, health, schedule, versions, release, and server time', async () => {
    const { handler } = setup();
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: CLIENT_ID }, headers: { authorization: 'Bearer session' } }, res);
    expect(res.body).toMatchObject({
      serverTime: '2026-07-23T16:45:00.000Z',
      client: { uuid: CLIENT_ID, name: 'Acme Trading' },
      permissions: { generate: true, rebind: true, revoke: true },
      release: { version: '1.4.2', sha256: 'a'.repeat(64) },
      device: { id: DEVICE_ID, healthStatus: 'online', lastErrorCode: 'collector_error', schedule: { time: '16:45:00', timezone: 'America/New_York' } },
      enrollment: { id: ENROLLMENT_ID, consumedAt: '2026-07-23T15:00:00.000Z' },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/machine_id|credential|code_hash|product.?key|lastErrorMessage|must-not-leak/i);
    expect(serialized).not.toContain('private_database_detail');
  });

  it('preserves a controlled permission denial and hides storage detail', async () => {
    const { handler } = setup({ authorize: vi.fn(async () => { throw Object.assign(new Error('Client assignment required.'), { status: 403 }); }) });
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: CLIENT_ID }, headers: {} }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Client assignment required.' } });
  });

  it('rejects malformed client identifiers before querying status', async () => {
    const { handler } = setup();
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: 'nope' }, headers: {} }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_client_uuid' } });
  });

  it('does not reflect arbitrary plain 4xx errors from dependencies', async () => {
    const { handler } = setup({ authorize: vi.fn(async () => { throw Object.assign(new Error('database password detail'), { status: 418 }); }) });
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: CLIENT_ID }, headers: {} }, res);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'collector_status_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('database password detail');
  });
});

describe('installer release manifest validation', () => {
  it('accepts a complete server-controlled HTTPS manifest', () => {
    expect(resolveInstallerRelease(releaseEnv, { production: true })).toEqual({
      url: releaseEnv.AUTO_COLLECTION_INSTALLER_URL,
      version: '1.4.2',
      sha256: 'a'.repeat(64),
      publishedAt: '2026-07-23T14:00:00.000Z',
    });
  });

  it('returns unavailable only when the complete manifest is omitted', () => {
    expect(resolveInstallerRelease({}, { production: true })).toBeNull();
  });

  it.each([
    [{ ...releaseEnv, AUTO_COLLECTION_INSTALLER_URL: 'http://downloads.example.test/a.msi' }, true],
    [{ ...releaseEnv, AUTO_COLLECTION_INSTALLER_SHA256: 'short' }, true],
    [{ ...releaseEnv, AUTO_COLLECTION_INSTALLER_VERSION: 'latest' }, true],
    [{ ...releaseEnv, AUTO_COLLECTION_INSTALLER_PUBLISHED_AT: 'tomorrow' }, true],
    [{ AUTO_COLLECTION_INSTALLER_URL: releaseEnv.AUTO_COLLECTION_INSTALLER_URL }, true],
  ])('rejects partial or invalid release configuration', (env, production) => {
    expect(() => resolveInstallerRelease(env, { production })).toThrow('Invalid auto-collection installer manifest configuration.');
  });

  it('permits localhost HTTP only outside production', () => {
    expect(resolveInstallerRelease({ ...releaseEnv, AUTO_COLLECTION_INSTALLER_URL: 'http://localhost:4173/agent.msi' }, { production: false }))
      .toMatchObject({ url: 'http://localhost:4173/agent.msi' });
  });
});

describe('collector profile status store', () => {
  it('selects only the server-approved safe columns and loads independent rows together', async () => {
    const selected = [];
    const rows = {
      clients: { id: CLIENT_ID, name: 'Acme Trading' },
      ingest_devices: { id: DEVICE_ID, health_status: 'online' },
      ingest_enrollments: { id: ENROLLMENT_ID, expires_at: '2026-07-23T17:00:00Z' },
    };
    function builder(table) {
      const query = {
        select(columns) { selected.push([table, columns]); return query; },
        eq() { return query; },
        order() { return query; },
        limit() { return query; },
        maybeSingle() { return query; },
        then(resolve, reject) { return Promise.resolve({ data: rows[table], error: null }).then(resolve, reject); },
      };
      return query;
    }
    const admin = { from: vi.fn((table) => builder(table)) };
    await expect(createIngestStatusStore(admin).load(CLIENT_ID)).resolves.toEqual({
      client: rows.clients,
      device: rows.ingest_devices,
      enrollment: rows.ingest_enrollments,
    });
    const columns = selected.map(([, value]) => value).join(',');
    expect(columns).not.toMatch(/product.?key|machine|credential|code_hash|metadata/i);
    expect(admin.from).toHaveBeenCalledTimes(3);
  });
});
