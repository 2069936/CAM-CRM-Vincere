import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import {
  createAgentUpdateAdminStore,
  createHandler,
  parseAgentUpdateBody,
  splitAgentUpdateRequest,
} from '../../../autoCollection/admin/ingest-agent-update.js';
import { FIRST_SELF_UPDATING_AGENT } from '../../../../src/domain/agentUpdate.js';

/* POST /api/admin/ingest-agent-update, the Manager's half of updating the
 * agent from the CRM. Manager only; { action, deviceIds } and nothing else;
 * 1 to 300 unique uuids. A request is always for the release the CRM pins
 * (409 release_unavailable without one) and never sent to a VPS that only an
 * install on the VPS can update, which is counted in needsVps. */

const ACTOR = { id: '99999999-9999-4999-8999-999999999999', role: 'Manager', status: 'Active' };
const id = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function deviceRow(n, overrides = {}) {
  return { id: id(n), status: 'active', revoked_at: null, agent_version: '1.3.0', addon_version: '1.3.0', ...overrides };
}

function setup({
  release = { version: '1.3.1', minimumAddonVersion: null },
  resolveRelease,
  rows = null,
  requestImpl,
  cancelImpl,
  authorize,
} = {}) {
  const calls = { request: [], cancel: [], load: [], authorize: [] };
  const store = {
    async loadDevices(deviceIds) {
      calls.load.push(deviceIds);
      return rows || deviceIds.map((deviceId, index) => deviceRow(index, { id: deviceId }));
    },
    async request(payload) {
      calls.request.push(payload);
      return requestImpl ? requestImpl(payload) : payload.deviceIds.length;
    },
    async cancel(payload) {
      calls.cancel.push(payload);
      return cancelImpl ? cancelImpl(payload) : payload.deviceIds.length;
    },
  };
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: authorize || (async (req, options) => { calls.authorize.push(options); return ACTOR; }),
    createStore: () => store,
    resolveRelease: resolveRelease || (async () => release),
    env: {},
    production: true,
    fetchRelease: vi.fn(),
  });
  return { handler, calls };
}

async function post(handler, body, overrides = {}) {
  const res = response();
  await handler({ method: 'POST', headers: {}, body, ...overrides }, res);
  return res;
}

describe('the request body', () => {
  it('takes exactly action and deviceIds, lower cased', () => {
    expect(parseAgentUpdateBody({ action: 'request', deviceIds: [id(1).toUpperCase()] })).toEqual({ action: 'request', deviceIds: [id(1)] });
    expect(parseAgentUpdateBody({ action: 'cancel', deviceIds: [id(1), id(2)] })).toEqual({ action: 'cancel', deviceIds: [id(1), id(2)] });
  });

  it.each([
    ['an extra key', { action: 'request', deviceIds: [id(1)], version: '1.3.1' }],
    ['no deviceIds', { action: 'request' }],
    ['no action', { deviceIds: [id(1)] }],
    ['an unknown action', { action: 'update', deviceIds: [id(1)] }],
    ['an empty list', { action: 'request', deviceIds: [] }],
    ['301 ids', { action: 'request', deviceIds: Array.from({ length: 301 }, (_, n) => id(n)) }],
    ['a duplicate', { action: 'request', deviceIds: [id(1), id(1)] }],
    ['a duplicate in another case', { action: 'request', deviceIds: [id(1), id(1).toUpperCase()] }],
    ['a non uuid', { action: 'request', deviceIds: ['device-1'] }],
    ['a number', { action: 'request', deviceIds: [1] }],
    ['ids as a string', { action: 'request', deviceIds: id(1) }],
    ['an array body', [{ action: 'request', deviceIds: [id(1)] }]],
    ['null', null],
  ])('refuses %s with 400 invalid_request', (_label, value) => {
    expect(() => parseAgentUpdateBody(value)).toThrow('invalid_request');
  });

  it('takes 300 ids, the most one request carries', () => {
    expect(parseAgentUpdateBody({ action: 'request', deviceIds: Array.from({ length: 300 }, (_, n) => id(n)) }).deviceIds).toHaveLength(300);
  });
});

describe('POST /api/admin/ingest-agent-update', () => {
  it('is Manager only, decided before the body is read', async () => {
    const authorize = vi.fn(async () => { throw new ApiError(403, 'Manager permission required.'); });
    const { handler, calls } = setup({ authorize });
    const res = await post(handler, 'not json');
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roles: ['Manager'] }));
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(calls.request).toEqual([]);
    expect(calls.cancel).toEqual([]);
  });

  it('asks requireAppUser for the Manager role and nothing wider', async () => {
    const { handler, calls } = setup();
    await post(handler, { action: 'request', deviceIds: [id(1)] });
    expect(calls.authorize).toEqual([expect.objectContaining({ roles: ['Manager'] })]);
  });

  it('only takes POST', async () => {
    const { handler } = setup();
    expect((await post(handler, {}, { method: 'GET' })).statusCode).toBe(405);
  });

  it('requests the pinned release for the listed devices, as the signed in Manager, and counts what it did', async () => {
    const { handler, calls } = setup({ requestImpl: () => 2 });
    const res = await post(handler, { action: 'request', deviceIds: [id(1), id(2), id(3)] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '1.3.1', requested: 2, skipped: 1, needsVps: 0 });
    expect(calls.request).toEqual([{ deviceIds: [id(1), id(2), id(3)], version: '1.3.1', actorId: ACTOR.id }]);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('answers 409 release_unavailable and writes nothing when no release is pinned, or it cannot be resolved', async () => {
    for (const resolveRelease of [
      async () => null,
      async () => ({ version: null }),
      async () => { throw new Error('Invalid auto-collection installer manifest configuration.'); },
      // Step 70 stores x.y.z; a four part release cannot be a target.
      async () => ({ version: '1.3.1.0' }),
    ]) {
      const { handler, calls } = setup({ resolveRelease });
      const res = await post(handler, { action: 'request', deviceIds: [id(1)] });
      expect(res).toMatchObject({ statusCode: 409, body: { error: 'release_unavailable' } });
      expect(calls.request).toEqual([]);
    }
  });

  it('cancels without needing a release, and counts what it cancelled', async () => {
    const resolveRelease = vi.fn(async () => null);
    const { handler, calls } = setup({ resolveRelease, cancelImpl: () => 1 });
    const res = await post(handler, { action: 'cancel', deviceIds: [id(1), id(2)] });
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, cancelled: 1 } });
    expect(calls.cancel).toEqual([{ deviceIds: [id(1), id(2)], actorId: ACTOR.id }]);
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  it('refuses a malformed body with 400 before touching the store', async () => {
    const { handler, calls } = setup();
    const res = await post(handler, { action: 'request', deviceIds: Array.from({ length: 301 }, (_, n) => id(n)) });
    expect(res).toMatchObject({ statusCode: 400, body: { error: 'invalid_request' } });
    expect(calls.load).toEqual([]);
  });

  it('does not hand a database error to the browser', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handler } = setup({ requestImpl: () => { throw Object.assign(new Error('permission denied for table secret'), { code: '42501' }); } });
      const res = await post(handler, { action: 'request', deviceIds: [id(1)] });
      expect(res).toMatchObject({ statusCode: 500, body: { error: 'agent_update_failed' } });
      expect(JSON.stringify(res.body)).not.toContain('secret');
    } finally {
      errors.mockRestore();
    }
  });

  describe('a VPS only an install on the VPS can update is not requested, and is counted', () => {
    it(`holds back an agent older than ${FIRST_SELF_UPDATING_AGENT}, and one that reported no version`, async () => {
      const rows = [
        deviceRow(1, { agent_version: '1.2.2' }),
        deviceRow(2, { agent_version: null }),
        deviceRow(3, { agent_version: '1.3.0' }),
      ];
      const { handler, calls } = setup({ rows, requestImpl: () => 1 });
      const res = await post(handler, { action: 'request', deviceIds: [id(1), id(2), id(3)] });
      expect(calls.request).toEqual([{ deviceIds: [id(3)], version: '1.3.1', actorId: ACTOR.id }]);
      expect(res.body).toEqual({ ok: true, version: '1.3.1', requested: 1, skipped: 2, needsVps: 2 });
    });

    it('holds back a VPS whose AddOn is below the release\'s minimum, or unknown', async () => {
      const rows = [
        deviceRow(1, { addon_version: '1.2.9' }),
        deviceRow(2, { addon_version: null }),
        deviceRow(3, { addon_version: '1.4.0' }),
        deviceRow(4, { addon_version: '1.3.0.0' }),
      ];
      const { handler, calls } = setup({ rows, release: { version: '1.3.1', minimumAddonVersion: '1.3.0' }, requestImpl: (p) => p.deviceIds.length });
      const res = await post(handler, { action: 'request', deviceIds: [id(1), id(2), id(3), id(4)] });
      expect(calls.request[0].deviceIds).toEqual([id(3), id(4)]);
      expect(res.body).toEqual({ ok: true, version: '1.3.1', requested: 2, skipped: 2, needsVps: 2 });
    });

    it('does not call the database when nothing is left to request', async () => {
      const rows = [deviceRow(1, { agent_version: '1.2.2' })];
      const { handler, calls } = setup({ rows });
      const res = await post(handler, { action: 'request', deviceIds: [id(1)] });
      expect(calls.request).toEqual([]);
      expect(res.body).toEqual({ ok: true, version: '1.3.1', requested: 0, skipped: 1, needsVps: 1 });
    });
  });

  it('counts in needsVps only machines that would otherwise have been requested', () => {
    const release = { version: '1.3.1', minimumAddonVersion: '1.3.0' };
    const rows = [
      deviceRow(1, { agent_version: '1.2.2', status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' }),
      deviceRow(2, { agent_version: '1.2.2', revoked_at: '2026-10-01T00:00:00Z' }),
      // Already at or above the release: nothing to update, whatever its AddOn.
      deviceRow(3, { agent_version: '1.3.1', addon_version: '1.0.0' }),
      deviceRow(4, { agent_version: '1.10.0', addon_version: null }),
      deviceRow(5, { agent_version: '1.2.2' }),
      deviceRow(6, { agent_version: '1.3.0', addon_version: '1.3.0' }),
    ];
    expect(splitAgentUpdateRequest(rows, release)).toEqual({ sendable: [id(6)], needsVps: 1 });
  });
});

describe('the store, against the RPCs step 70 defines', () => {
  function admin(result = { data: 2, error: null }) {
    const calls = [];
    return {
      calls,
      async rpc(name, args) { calls.push([name, args]); return result; },
      from(table) {
        const query = {
          select(columns) { calls.push(['select', table, columns]); return query; },
          async in(column, values) { calls.push(['in', column, values]); return { data: [deviceRow(1)], error: null }; },
        };
        return query;
      },
    };
  }

  it('calls request_agent_update with the ids, the version and the actor', async () => {
    const db = admin();
    await expect(createAgentUpdateAdminStore(db).request({ deviceIds: [id(1)], version: '1.3.1', actorId: ACTOR.id })).resolves.toBe(2);
    expect(db.calls).toEqual([['request_agent_update', { p_device_ids: [id(1)], p_target_version: '1.3.1', p_actor: ACTOR.id }]]);
  });

  it('calls cancel_agent_update with the ids and the actor', async () => {
    const db = admin({ data: 1, error: null });
    await expect(createAgentUpdateAdminStore(db).cancel({ deviceIds: [id(1)], actorId: ACTOR.id })).resolves.toBe(1);
    expect(db.calls).toEqual([['cancel_agent_update', { p_device_ids: [id(1)], p_actor: ACTOR.id }]]);
  });

  it('reads the version columns of the listed devices only', async () => {
    const db = admin();
    await createAgentUpdateAdminStore(db).loadDevices([id(1)]);
    expect(db.calls).toEqual([['select', 'ingest_devices', 'id,status,revoked_at,agent_version,addon_version'], ['in', 'id', [id(1)]]]);
  });

  it('turns the RPC\'s validation refusal into 400, and refuses an answer that is not a count', async () => {
    await expect(createAgentUpdateAdminStore(admin({ data: null, error: { code: '22023', message: 'INVALID_AGENT_UPDATE_REQUEST' } }))
      .request({ deviceIds: [id(1)], version: '1.3.1', actorId: ACTOR.id })).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
    await expect(createAgentUpdateAdminStore(admin({ data: 'two', error: null }))
      .cancel({ deviceIds: [id(1)], actorId: ACTOR.id })).rejects.toThrow('no count');
  });
});
