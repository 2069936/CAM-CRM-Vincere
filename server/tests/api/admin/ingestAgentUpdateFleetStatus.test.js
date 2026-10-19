import { describe, expect, it, vi } from 'vitest';
import { createFleetStore, createHandler as createFleetHandler } from '../../../autoCollection/admin/ingest-fleet.js';
import { createHandler as createStatusHandler, createIngestStatusStore } from '../../../autoCollection/admin/ingest-status.js';

/* WHERE EACH VPS'S UPDATE STANDS, ON THE TWO SCREENS THAT SHOW A DEVICE.
 *
 * Step 70's five columns ride on every device the fleet view and the client
 * card read, shaped and checked; the fleet view also works out, over the whole
 * fleet, which machines the bulk button may send the pinned release to and how
 * many need an install on the VPS. Before step 70 runs both screens read as
 * they did, with no update line and no button. */

const CLIENT_1 = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-19T15:00:00.000Z';
const REQUESTED_AT = '2026-10-19T14:57:00+00:00';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const deviceId = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clientId = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function deviceRow(n, overrides = {}) {
  return {
    id: deviceId(n), client_id: clientId(n), status: 'active', health_status: 'online',
    schedule_time: '16:30:00', schedule_timezone: 'America/New_York',
    agent_version: '1.3.0', addon_version: '1.3.0', last_seen_at: NOW, created_at: NOW, revoked_at: null,
    update_target_version: null, update_requested_at: null, update_state: null, update_state_at: null, update_error_code: null,
    ...overrides,
  };
}

function fleetAdmin(devices, { updateColumnsMissing = false } = {}) {
  const asked = [];
  const clients = devices.map((row, index) => ({ id: row.client_id, name: `Client ${index + 1}` }));
  return {
    asked,
    from(table) {
      const builder = {
        select(columns) { asked.push({ table, columns }); builder.columns = columns; return builder; },
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: async () => {
          if (table === 'ingest_devices' && updateColumnsMissing && builder.columns.includes('update_target_version')) {
            return { data: null, error: { code: '42703', message: 'column ingest_devices.update_target_version does not exist' } };
          }
          if (table === 'clients') return { data: clients, error: null };
          if (table === 'ingest_devices') {
            const strip = (row) => (builder.columns.includes('update_') ? row
              : Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('update_'))));
            return { data: devices.map(strip), error: null };
          }
          return { data: [], error: null };
        },
      };
      return builder;
    },
  };
}

async function listFleet(admin, release = { version: '1.3.1', minimumAddonVersion: '1.3.0' }) {
  return createFleetStore(admin).list({
    page: 1, pageSize: 25, search: '', tradingDate: '2026-10-19', now: new Date(NOW),
    releaseVersion: release?.version || null, release,
  });
}

describe('the fleet view', () => {
  it('carries step 70\'s five fields on every device, shaped, and nothing the database should not hold', async () => {
    const devices = [
      deviceRow(1, {
        agent_version: '1.2.2', update_target_version: '1.3.1', update_requested_at: REQUESTED_AT,
        update_state: 'failed', update_state_at: NOW, update_error_code: 'hash_mismatch', update_requested_by: 'not-sent',
      }),
      deviceRow(2, { update_target_version: '1.3', update_state: 'weird', update_error_code: 'Bad Code' }),
    ];
    const result = await listFleet(fleetAdmin(devices));
    expect(result.rows[0].device).toMatchObject({
      updateTargetVersion: '1.3.1', updateRequestedAt: REQUESTED_AT, updateState: 'failed',
      updateStateAt: NOW, updateErrorCode: 'hash_mismatch',
    });
    expect(result.rows[0].device).not.toHaveProperty('updateRequestedBy');
    expect(result.rows[1].device).toMatchObject({ updateTargetVersion: null, updateState: null, updateErrorCode: null });
  });

  it('asks for the update columns in the same one select of devices', async () => {
    const admin = fleetAdmin([deviceRow(1)]);
    await listFleet(admin);
    const deviceSelects = admin.asked.filter((call) => call.table === 'ingest_devices');
    expect(deviceSelects).toHaveLength(1);
    expect(deviceSelects[0].columns).toContain('update_target_version,update_requested_at,update_state,update_state_at,update_error_code');
  });

  it('plans the bulk request over the whole fleet: who can be sent the release, and how many need the VPS', async () => {
    const devices = [
      deviceRow(1, { agent_version: '1.3.0' }), // can be sent
      deviceRow(2, { agent_version: '1.2.2' }), // older than the updater: VPS
      deviceRow(3, { agent_version: '1.3.0', addon_version: '1.2.0' }), // AddOn below the release's minimum: VPS
      deviceRow(4, { agent_version: '1.3.1' }), // up to date
      deviceRow(5, { agent_version: '1.3.0', update_target_version: '1.3.1', update_state: 'downloading', update_requested_at: REQUESTED_AT }), // in flight
      deviceRow(6, { agent_version: '1.3.0', update_target_version: '1.3.1', update_state: 'failed', update_error_code: 'x', update_requested_at: REQUESTED_AT }), // failed: retry
      deviceRow(7, { agent_version: '1.2.2', status: 'revoked', revoked_at: NOW }), // not active
      deviceRow(8, { agent_version: null }), // never reported a version
    ];
    // A page of two does not narrow the plan.
    const result = await createFleetStore(fleetAdmin(devices)).list({
      page: 1, pageSize: 2, search: '', tradingDate: '2026-10-19', now: new Date(NOW),
      releaseVersion: '1.3.1', release: { version: '1.3.1', minimumAddonVersion: '1.3.0' },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.agentUpdate).toEqual({
      version: '1.3.1', minimumAddonVersion: '1.3.0', deviceIds: [deviceId(1), deviceId(6)], needsVps: 2,
    });
  });

  it('has no plan without a pinned release', async () => {
    expect((await listFleet(fleetAdmin([deviceRow(1, { agent_version: '1.2.2' })]), null)).agentUpdate).toBeNull();
  });

  it('still lists every device before step 70 has run, with no update fields and no plan', async () => {
    const admin = fleetAdmin([deviceRow(1, { agent_version: '1.2.2' })], { updateColumnsMissing: true });
    const result = await listFleet(admin);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].device).toMatchObject({ id: deviceId(1), agentVersion: '1.2.2', updateTargetVersion: null, updateState: null });
    expect(result.agentUpdate).toBeNull();
    expect(admin.asked.filter((call) => call.table === 'ingest_devices')).toHaveLength(2);
  });

  it('the handler hands the store the release version and its AddOn minimum', async () => {
    const list = vi.fn(async () => ({ rows: [], summary: { total: 0 }, total: 0, agentUpdate: null }));
    const handler = createFleetHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ role: 'Manager' }),
      createStore: () => ({ list }),
      now: () => new Date(NOW),
      resolveRelease: async () => ({ version: '1.3.1', minimumAddonVersion: '1.3.0', url: 'https://x.test/a.zip' }),
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ releaseVersion: '1.3.1', release: { version: '1.3.1', minimumAddonVersion: '1.3.0' } }));
    expect(res.statusCode).toBe(200);
  });
});

describe('the client card\'s status', () => {
  function statusAdmin({ updateColumnsMissing = false, device = deviceRow(1, { client_id: CLIENT_1, update_target_version: '1.3.1', update_state: 'staged', update_requested_at: REQUESTED_AT }) } = {}) {
    const selected = [];
    return {
      selected,
      from(table) {
        const query = {
          select(columns) { selected.push([table, columns]); query.columns = columns; return query; },
          eq() { return query; },
          order() { return query; },
          limit() { return query; },
          maybeSingle() { return query; },
          then(resolve, reject) {
            let result = { data: null, error: null };
            if (table === 'clients') result = { data: { id: CLIENT_1, name: 'Acme' }, error: null };
            if (table === 'ingest_devices') {
              result = updateColumnsMissing && query.columns.includes('update_target_version')
                ? { data: null, error: { code: '42703', message: 'column ingest_devices.update_target_version does not exist' } }
                : { data: device, error: null };
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    };
  }

  it('reads the update columns with the device and says the request has somewhere to live', async () => {
    const admin = statusAdmin();
    const loaded = await createIngestStatusStore(admin).load(CLIENT_1);
    expect(loaded.agentUpdateSupported).toBe(true);
    expect(admin.selected.filter(([table]) => table === 'ingest_devices')).toHaveLength(1);
    expect(admin.selected.find(([table]) => table === 'ingest_devices')[1]).toContain('update_state');
  });

  it('falls back to the device\'s own columns before step 70 runs, and says so', async () => {
    const admin = statusAdmin({ updateColumnsMissing: true });
    const loaded = await createIngestStatusStore(admin).load(CLIENT_1);
    expect(loaded.agentUpdateSupported).toBe(false);
    expect(loaded.device).toMatchObject({ id: deviceId(1) });
    expect(admin.selected.filter(([table]) => table === 'ingest_devices').map(([, columns]) => columns.includes('update_')))
      .toEqual([true, false]);
  });

  async function invoke({ role = 'Manager', agentUpdateSupported = true } = {}) {
    const device = deviceRow(1, { client_id: CLIENT_1, update_target_version: '1.3.1', update_state: 'staged', update_requested_at: REQUESTED_AT, update_state_at: NOW });
    const handler = createStatusHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ id: 'actor-1', role }),
      enforceAssignment: async () => {},
      createStore: () => ({ load: async () => ({ client: { id: CLIENT_1, name: 'Acme' }, device, agentUpdateSupported }) }),
      // The committed default, fetched through a fetch that fails: no release, which is enough here.
      env: {},
      fetchRelease: async () => { throw new Error('offline'); },
      production: true,
      now: () => new Date(NOW),
    });
    const res = response();
    await handler({ method: 'GET', query: { clientUuid: CLIENT_1 }, headers: {} }, res);
    return res;
  }

  it('sends the five fields on the device', async () => {
    const res = await invoke();
    expect(res.body.device).toMatchObject({
      updateTargetVersion: '1.3.1', updateRequestedAt: REQUESTED_AT, updateState: 'staged', updateStateAt: NOW, updateErrorCode: null,
    });
  });

  it('offers the update to a Manager only, and only once step 70 has run', async () => {
    expect((await invoke()).body.permissions.updateAgent).toBe(true);
    expect((await invoke({ role: 'CAM' })).body.permissions.updateAgent).toBe(false);
    expect((await invoke({ agentUpdateSupported: false })).body.permissions.updateAgent).toBe(false);
  });
});
