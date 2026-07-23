import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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

const releaseManifest = {
  schemaVersion: 1,
  version: '1.4.2',
  minimumAgentVersion: '1.4.2',
  minimumSchemaVersion: 1,
  publishedAt: '2026-07-23T14:00:00.000Z',
  signingThumbprint: 'A'.repeat(40),
  artifacts: [
    { name: 'Vincere.AutoExport.Machine.msi', url: 'https://downloads.example.test/Vincere.AutoExport.Machine.msi', sha256: 'b'.repeat(64), size: 100 },
    { name: 'Vincere.AutoExport.AddOn.msi', url: 'https://downloads.example.test/Vincere.AutoExport.AddOn.msi', sha256: 'c'.repeat(64), size: 200 },
    { name: 'Vincere-AutoExport-Setup.exe', url: 'https://downloads.example.test/Vincere-AutoExport-Setup.exe', sha256: 'a'.repeat(64), size: 300 },
  ],
};
const releaseManifestText = JSON.stringify(releaseManifest);
const releaseEnv = {
  AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'https://downloads.example.test/release-manifest.json',
  AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: createHash('sha256').update(releaseManifestText).digest('hex'),
};
const fetchRelease = vi.fn(async () => new Response(releaseManifestText, {
  status: 200,
  headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(releaseManifestText)) },
}));

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
    fetchRelease,
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
  it('fetches a pinned HTTPS manifest and selects the signed setup bundle', async () => {
    await expect(resolveInstallerRelease(releaseEnv, { production: true, fetchImpl: fetchRelease })).resolves.toEqual({
      url: 'https://downloads.example.test/Vincere-AutoExport-Setup.exe',
      version: '1.4.2',
      sha256: 'a'.repeat(64),
      publishedAt: '2026-07-23T14:00:00.000Z',
      size: 300,
      signingThumbprint: 'A'.repeat(40),
    });
    expect(fetchRelease).toHaveBeenCalledWith(releaseEnv.AUTO_COLLECTION_RELEASE_MANIFEST_URL, expect.objectContaining({ redirect: 'error' }));
  });

  it('reuses a verified immutable manifest instead of fetching once per client', async () => {
    const fetchImpl = vi.fn(async () => new Response(releaseManifestText, { status: 200 }));
    await resolveInstallerRelease(releaseEnv, { production: true, fetchImpl });
    await resolveInstallerRelease(releaseEnv, { production: true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable only when the manifest configuration is completely omitted', async () => {
    await expect(resolveInstallerRelease({}, { production: true, fetchImpl: fetchRelease })).resolves.toBeNull();
  });

  it.each([
    [{ ...releaseEnv, AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'http://downloads.example.test/release-manifest.json' }, true],
    [{ ...releaseEnv, AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: 'short' }, true],
    [{ AUTO_COLLECTION_RELEASE_MANIFEST_URL: releaseEnv.AUTO_COLLECTION_RELEASE_MANIFEST_URL }, true],
  ])('rejects partial or invalid release configuration', async (env, production) => {
    await expect(resolveInstallerRelease(env, { production, fetchImpl: fetchRelease }))
      .rejects.toThrow('Invalid auto-collection installer manifest configuration.');
  });

  it('rejects a fetched manifest whose bytes do not match the pinned SHA-256', async () => {
    await expect(resolveInstallerRelease({ ...releaseEnv, AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: 'd'.repeat(64) }, {
      production: true,
      fetchImpl: fetchRelease,
    })).rejects.toThrow('Invalid auto-collection installer manifest configuration.');
  });

  it.each([
    [{ ...releaseManifest, artifacts: releaseManifest.artifacts.filter(({ name }) => name !== 'Vincere-AutoExport-Setup.exe') }],
    [{ ...releaseManifest, version: 'latest' }],
    [{ ...releaseManifest, signingThumbprint: 'short' }],
    [{ ...releaseManifest, artifacts: releaseManifest.artifacts.map((artifact) => artifact.name === 'Vincere-AutoExport-Setup.exe' ? { ...artifact, url: 'http://downloads.example.test/setup.exe' } : artifact) }],
  ])('rejects a malformed or incomplete release manifest %#', async (manifest) => {
    const text = JSON.stringify(manifest);
    const env = {
      ...releaseEnv,
      AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: createHash('sha256').update(text).digest('hex'),
    };
    const fetchImpl = vi.fn(async () => new Response(text, { status: 200 }));
    await expect(resolveInstallerRelease(env, { production: true, fetchImpl }))
      .rejects.toThrow('Invalid auto-collection installer manifest configuration.');
  });

  it('permits localhost HTTP only outside production', async () => {
    const localManifest = {
      ...releaseManifest,
      artifacts: releaseManifest.artifacts.map((artifact) => ({ ...artifact, url: artifact.url.replace('https://downloads.example.test', 'http://localhost:4173') })),
    };
    const text = JSON.stringify(localManifest);
    const env = {
      AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'http://localhost:4173/release-manifest.json',
      AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: createHash('sha256').update(text).digest('hex'),
    };
    const fetchImpl = vi.fn(async () => new Response(text, { status: 200 }));
    await expect(resolveInstallerRelease(env, { production: false, fetchImpl }))
      .resolves.toMatchObject({ url: 'http://localhost:4173/Vincere-AutoExport-Setup.exe' });
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
