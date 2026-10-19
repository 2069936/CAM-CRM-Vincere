import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import { pinnedReleaseManifest, resolveInstallerRelease } from '../../../apiLib/collectorRelease.js';
import {
  agentUpdateDirective,
  config,
  createAgentUpdateStore,
  createHandler,
  normalizeAgentUpdateBody,
} from '../../../autoCollection/ingest/agentUpdate.js';

/* THE AGENT'S POLL, AS THE AGENT IS CODED AGAINST IT.
 *
 * POST /api/ingest/agent-update with the device headers and exactly four keys;
 * 200 { ok: true, update: null | { version, manifestUrl, manifestSha256,
 * requestedAt } }. The directive is given only for a pending request whose
 * target is exactly the release the CRM pins now, to an agent below it, with
 * an AddOn the release works with. Everything that cannot be established
 * withholds it; nothing about the release turns into a 500. */

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const PINNED = { url: 'https://downloads.example.test/agent-v1.3.1/release-manifest.json', sha256: 'e'.repeat(64) };
const REQUESTED_AT = '2026-10-19T14:03:00.123456+00:00';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function body(overrides = {}) {
  return { agentVersion: '1.3.0', state: null, errorCode: null, targetVersion: null, ...overrides };
}

function setup({
  pending = { targetVersion: '1.3.1', requestedAt: REQUESTED_AT },
  release = { version: '1.3.1', minimumAddonVersion: null },
  resolveRelease,
  pinnedManifest = () => PINNED,
  addonVersion = '1.2.0',
  recordImpl,
  loadAddonImpl,
  authenticateImpl,
} = {}) {
  const calls = { record: [], resolve: 0, addon: 0, authenticate: 0 };
  const store = {
    async recordPoll(payload) {
      calls.record.push(payload);
      if (recordImpl) return recordImpl(payload);
      return pending;
    },
    async loadAddonVersion(deviceId) {
      calls.addon += 1;
      expect(deviceId).toBe(DEVICE_ID);
      if (loadAddonImpl) return loadAddonImpl();
      return addonVersion;
    },
  };
  const handler = createHandler({
    createClient: () => ({}),
    createAuthStore: () => ({}),
    createStore: () => store,
    authenticate: async () => {
      calls.authenticate += 1;
      if (authenticateImpl) return authenticateImpl();
      return { id: DEVICE_ID, clientId: CLIENT_ID, status: 'active', revokedAt: null };
    },
    pepper: 'test-pepper',
    resolveRelease: resolveRelease || (async () => { calls.resolve += 1; return release; }),
    pinnedManifest,
    env: {},
    production: true,
    fetchRelease: vi.fn(),
  });
  return { handler, calls };
}

async function poll(handler, payload = body(), overrides = {}) {
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

describe('the poll body: exactly four keys', () => {
  it('accepts the four keys and returns them normalized', () => {
    expect(normalizeAgentUpdateBody(body({ agentVersion: ' 1.3.0 ' }))).toEqual(body());
    expect(normalizeAgentUpdateBody(body({ state: 'downloading', targetVersion: '1.3.1' })))
      .toEqual({ agentVersion: '1.3.0', state: 'downloading', errorCode: null, targetVersion: '1.3.1' });
    expect(normalizeAgentUpdateBody(body({ state: 'failed', errorCode: 'hash_mismatch', targetVersion: '1.3.1' })))
      .toEqual({ agentVersion: '1.3.0', state: 'failed', errorCode: 'hash_mismatch', targetVersion: '1.3.1' });
  });

  it('reads an absent nullable key as null, as the heartbeat does', () => {
    expect(normalizeAgentUpdateBody({ agentVersion: '1.3.0' })).toEqual(body());
  });

  it('refuses any other key, including one the response uses', () => {
    for (const extra of [{ update: null }, { ok: true }, { addonVersion: '1.2.0' }, { deviceId: DEVICE_ID }]) {
      expect(() => normalizeAgentUpdateBody({ ...body(), ...extra }), JSON.stringify(extra)).toThrow('invalid_request');
    }
  });

  it('refuses arrays, null, primitives and objects with a custom prototype', () => {
    for (const value of [[], null, 'x', 1, Object.assign(Object.create({ inherited: true }), body())]) {
      expect(() => normalizeAgentUpdateBody(value)).toThrow('invalid_request');
    }
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 1.3],
    ['a word', 'latest'],
    ['one part', '1'],
    ['five parts', '1.2.3.4.5'],
  ])('refuses an agentVersion that is %s', (_label, agentVersion) => {
    const value = body();
    if (agentVersion === undefined) delete value.agentVersion;
    else value.agentVersion = agentVersion;
    expect(() => normalizeAgentUpdateBody(value)).toThrow('invalid_request');
  });

  it.each([['requested'], ['completed'], ['cancelled'], ['Downloading'], [''], [1]])('refuses the state %j', (state) => {
    expect(() => normalizeAgentUpdateBody(body({ state, targetVersion: '1.3.1' }))).toThrow('invalid_request');
  });

  it('couples failed and errorCode: failed needs a code, and nothing else may carry one', () => {
    expect(() => normalizeAgentUpdateBody(body({ state: 'failed', targetVersion: '1.3.1' }))).toThrow('invalid_request');
    for (const state of [null, 'downloading', 'staged', 'applying']) {
      expect(() => normalizeAgentUpdateBody(body({ state, errorCode: 'download_failed', targetVersion: '1.3.1' })), String(state))
        .toThrow('invalid_request');
    }
  });

  it.each([['Download_failed'], ['1_failed'], ['_x'], [''], [`a${'b'.repeat(64)}`], ['has space'], [42]])(
    'refuses the errorCode %j', (errorCode) => {
      expect(() => normalizeAgentUpdateBody(body({ state: 'failed', errorCode, targetVersion: '1.3.1' }))).toThrow('invalid_request');
    },
  );

  it('accepts a 64 character errorCode', () => {
    expect(normalizeAgentUpdateBody(body({ state: 'failed', errorCode: `a${'b'.repeat(63)}`, targetVersion: '1.3.1' })).errorCode)
      .toHaveLength(64);
  });

  it.each([['1.3'], ['1.3.1.0'], ['v1.3.1'], ['1.3.1 '], [131]])('refuses the targetVersion %j', (targetVersion) => {
    expect(() => normalizeAgentUpdateBody(body({ state: 'downloading', targetVersion }))).toThrow('invalid_request');
  });
});

describe('POST /api/ingest/agent-update', () => {
  it('disables the platform body parser like every ingest route', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it('records the poll for the authenticated device and hands out the directive for the pinned release', async () => {
    const { handler, calls } = setup();
    const res = await poll(handler, body({ agentVersion: '1.2.2', state: 'staged', targetVersion: '1.3.1' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      update: {
        version: '1.3.1',
        manifestUrl: PINNED.url,
        manifestSha256: PINNED.sha256,
        requestedAt: '2026-10-19T14:03:00.123Z',
      },
    });
    expect(calls.record).toEqual([{ deviceId: DEVICE_ID, agentVersion: '1.2.2', state: 'staged', errorCode: null, targetVersion: '1.3.1' }]);
  });

  it('answers update null when nothing is pending, without resolving the release', async () => {
    const { handler, calls } = setup({ pending: { targetVersion: null, requestedAt: null } });
    const res = await poll(handler, body({ agentVersion: '1.2.2' }));
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, update: null } });
    expect(calls.resolve).toBe(0);
  });

  it('withholds the directive when the pending target is not the release pinned now', async () => {
    for (const version of ['1.3.2', '1.3.0', '1.3.1.0']) {
      const { handler } = setup({ release: { version } });
      expect((await poll(handler, body({ agentVersion: '1.2.2' }))).body, version).toEqual({ ok: true, update: null });
    }
  });

  it('withholds it when no release can be resolved, and never answers 500 for that', async () => {
    const none = setup({ release: null });
    expect(await poll(none.handler, body({ agentVersion: '1.2.2' }))).toMatchObject({ statusCode: 200, body: { ok: true, update: null } });
    const broken = setup({ resolveRelease: async () => { throw new Error('Invalid auto-collection installer manifest configuration.'); } });
    expect(await poll(broken.handler, body({ agentVersion: '1.2.2' }))).toMatchObject({ statusCode: 200, body: { ok: true, update: null } });
    const unpinned = setup({ pinnedManifest: () => { throw new Error('Invalid auto-collection installer manifest configuration.'); } });
    expect(await poll(unpinned.handler, body({ agentVersion: '1.2.2' }))).toMatchObject({ statusCode: 200, body: { ok: true, update: null } });
    const malformed = setup({ pinnedManifest: () => ({ url: PINNED.url, sha256: 'E'.repeat(64) }) });
    expect(await poll(malformed.handler, body({ agentVersion: '1.2.2' }))).toMatchObject({ statusCode: 200, body: { ok: true, update: null } });
  });

  it('withholds it from an agent already at or above the target', async () => {
    for (const agentVersion of ['1.3.1', '1.3.1.1', '1.4.0', '1.10.0']) {
      const { handler } = setup();
      expect((await poll(handler, body({ agentVersion }))).body, agentVersion).toEqual({ ok: true, update: null });
    }
  });

  it('gives it to an agent below the target, numerically (1.9.0 is below 1.10.0)', async () => {
    const { handler } = setup({ pending: { targetVersion: '1.10.0', requestedAt: REQUESTED_AT }, release: { version: '1.10.0' } });
    expect((await poll(handler, body({ agentVersion: '1.9.0' }))).body.update).toMatchObject({ version: '1.10.0' });
  });

  it('withholds it while the request carries no readable time', async () => {
    const { handler } = setup({ pending: { targetVersion: '1.3.1', requestedAt: null } });
    expect((await poll(handler, body({ agentVersion: '1.2.2' }))).body).toEqual({ ok: true, update: null });
  });

  describe('a release that needs a newer NinjaTrader AddOn', () => {
    const release = { version: '1.3.1', minimumAddonVersion: '1.3.0' };

    it.each([
      ['below it', '1.2.9', null],
      ['unknown', null, null],
      ['equal', '1.3.0', '1.3.1'],
      ['equal with a fourth part', '1.3.0.0', '1.3.1'],
      ['above it', '1.4.0', '1.3.1'],
    ])('with the VPS AddOn %s', async (_label, addonVersion, expected) => {
      const { handler, calls } = setup({ release, addonVersion });
      const res = await poll(handler, body({ agentVersion: '1.3.0' }));
      expect(res.statusCode).toBe(200);
      expect(res.body.update?.version ?? null).toBe(expected);
      expect(calls.addon).toBe(1);
    });

    it('withholds it when the AddOn version cannot be read', async () => {
      const { handler } = setup({ release, loadAddonImpl: async () => { throw new Error('read failed'); } });
      expect((await poll(handler, body({ agentVersion: '1.3.0' }))).body).toEqual({ ok: true, update: null });
    });

    it('does not read the AddOn for a release without a minimum', async () => {
      const { handler, calls } = setup({ release: { version: '1.3.1', minimumAddonVersion: null } });
      await poll(handler, body({ agentVersion: '1.3.0' }));
      expect(calls.addon).toBe(0);
    });
  });

  it('refuses a malformed body with 400 invalid_request and records nothing', async () => {
    const { handler, calls } = setup();
    for (const payload of [body({ extra: 1 }), body({ state: 'failed', targetVersion: '1.3.1' }), '{"agentVersion":', '[]']) {
      const res = await poll(handler, payload);
      expect(res, JSON.stringify(payload)).toMatchObject({ statusCode: 400, body: { error: 'invalid_request' } });
    }
    expect(calls.record).toEqual([]);
  });

  it('refuses an oversized body with 413 invalid_request', async () => {
    const { handler, calls } = setup();
    const res = await poll(handler, body({ agentVersion: '1.3.0', padding: 'x'.repeat(5000) }));
    expect(res).toMatchObject({ statusCode: 413, body: { error: 'invalid_request' } });
    expect(calls.record).toEqual([]);
  });

  it('authenticates before reading anything, and a refused device records nothing', async () => {
    const { handler, calls } = setup({ authenticateImpl: () => { throw new ApiError(401, 'invalid_device_credential'); } });
    const res = await poll(handler, '{not json');
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'invalid_device_credential' } });
    expect(calls.record).toEqual([]);
  });

  it('only takes POST', async () => {
    const { handler, calls } = setup();
    const res = await poll(handler, body(), { method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(calls.authenticate).toBe(0);
  });

  it('maps the store\'s refusals: 400 for the RPC\'s validation, 401 for a device it refuses, 404 before step 70, 503 otherwise', async () => {
    const cases = [
      [new ApiError(400, 'invalid_request'), 400, 'invalid_request'],
      [new ApiError(401, 'invalid_device_credential'), 401, 'invalid_device_credential'],
      [new ApiError(404, 'not_found'), 404, 'not_found'],
      [Object.assign(new Error('connection reset'), { code: '08006' }), 503, 'agent_update_unavailable'],
    ];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [error, status, code] of cases) {
        const { handler } = setup({ recordImpl: () => { throw error; } });
        expect(await poll(handler, body()), code).toMatchObject({ statusCode: status, body: { error: code } });
      }
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the store, against the RPC step 70 defines', () => {
  function admin({ data = [{ target_version: '1.3.1', requested_at: REQUESTED_AT }], error = null, addon = { data: { addon_version: '1.2.0' }, error: null } } = {}) {
    const calls = { rpc: [], from: [] };
    return {
      calls,
      async rpc(name, args) { calls.rpc.push([name, args]); return { data, error }; },
      from(table) {
        const query = {
          select(columns) { calls.from.push([table, columns]); return query; },
          eq(column, value) { calls.from.push([column, value]); return query; },
          async maybeSingle() { return addon; },
        };
        return query;
      },
    };
  }

  it('calls record_agent_update_poll with the five arguments and unwraps the row', async () => {
    const db = admin();
    await expect(createAgentUpdateStore(db).recordPoll({ deviceId: DEVICE_ID, agentVersion: '1.2.2', state: 'failed', errorCode: 'x', targetVersion: '1.3.1' }))
      .resolves.toEqual({ targetVersion: '1.3.1', requestedAt: REQUESTED_AT });
    expect(db.calls.rpc).toEqual([['record_agent_update_poll', {
      p_device_id: DEVICE_ID, p_agent_version: '1.2.2', p_state: 'failed', p_error_code: 'x', p_target_version: '1.3.1',
    }]]);
  });

  it('reads the row of nulls as nothing pending', async () => {
    await expect(createAgentUpdateStore(admin({ data: [{ target_version: null, requested_at: null }] })).recordPoll({ deviceId: DEVICE_ID }))
      .resolves.toEqual({ targetVersion: null, requestedAt: null });
  });

  it('refuses a target the database should never hold', async () => {
    await expect(createAgentUpdateStore(admin({ data: [{ target_version: '1.3', requested_at: REQUESTED_AT }] })).recordPoll({ deviceId: DEVICE_ID }))
      .rejects.toThrow('invalid target version');
  });

  it.each([
    [{ code: '22023', message: 'INVALID_AGENT_UPDATE_REQUEST' }, 400, 'invalid_request'],
    [{ code: 'P0001', message: 'INVALID_INGEST_DEVICE' }, 401, 'invalid_device_credential'],
    [{ code: 'PGRST202', message: 'Could not find the function public.record_agent_update_poll' }, 404, 'not_found'],
    [{ code: '42883', message: 'function public.record_agent_update_poll does not exist' }, 404, 'not_found'],
  ])('turns %j into %i %s', async (error, status, message) => {
    await expect(createAgentUpdateStore(admin({ data: null, error })).recordPoll({ deviceId: DEVICE_ID }))
      .rejects.toMatchObject({ status, message });
  });

  it('passes any other database error through, for the route to answer 503', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout' };
    await expect(createAgentUpdateStore(admin({ data: null, error })).recordPoll({ deviceId: DEVICE_ID })).rejects.toBe(error);
  });

  it('reads the AddOn version of this device only', async () => {
    const db = admin();
    await expect(createAgentUpdateStore(db).loadAddonVersion(DEVICE_ID)).resolves.toBe('1.2.0');
    expect(db.calls.from).toEqual([['ingest_devices', 'addon_version'], ['id', DEVICE_ID]]);
    await expect(createAgentUpdateStore(admin({ addon: { data: null, error: null } })).loadAddonVersion(DEVICE_ID)).resolves.toBeNull();
  });
});

describe('the directive against the real release resolver', () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version: '1.3.1',
    minimumAgentVersion: '1.0.0',
    minimumSchemaVersion: 1,
    publishedAt: '2026-10-18T12:00:00.000Z',
    artifacts: [{ name: 'Vincere-AutoExport-Agent.zip', url: 'https://downloads.example.test/Vincere-AutoExport-Agent.zip', sha256: 'a'.repeat(64), size: 110 }],
  });
  const env = {
    AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'https://downloads.example.test/release-manifest.json',
    AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: createHash('sha256').update(manifest).digest('hex').toUpperCase(),
  };
  const fetchImpl = async () => new Response(manifest, { status: 200, headers: { 'content-length': String(Buffer.byteLength(manifest)) } });

  it('names exactly the manifest resolveInstallerRelease verified, digest in lower case', async () => {
    const update = await agentUpdateDirective({
      pending: { targetVersion: '1.3.1', requestedAt: REQUESTED_AT },
      agentVersion: '1.3.0',
      loadRelease: () => resolveInstallerRelease(env, { production: true, fetchImpl }),
      loadPinned: () => pinnedReleaseManifest(env),
      loadAddonVersion: async () => '1.2.0',
    });
    expect(update).toEqual({
      version: '1.3.1',
      manifestUrl: env.AUTO_COLLECTION_RELEASE_MANIFEST_URL,
      manifestSha256: env.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256.toLowerCase(),
      requestedAt: '2026-10-19T14:03:00.123Z',
    });
  });
});
