import process from 'node:process';
import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { AGENT_UPDATE_BATCH_LIMIT, agentUpdateBlockers, compareAgentVersions } from '../../../src/domain/agentUpdate.js';

/* A MANAGER ASKS ONE VPS, OR MANY, TO UPDATE ITS AGENT; OR TAKES IT BACK.
 *
 * POST { action: 'request' | 'cancel', deviceIds: [uuid, ...] }, 1 to 300
 * unique ids and no other key. Step 70 keeps the request; the agent finds it
 * at its next poll of /api/ingest/agent-update.
 *
 * A REQUEST IS FOR THE RELEASE THE CRM PINS NOW, never a version the caller
 * names, so nobody can point a VPS at a build the CRM has not verified. No
 * release, or one whose version is not x.y.z (the shape step 70 stores), is a
 * 409 release_unavailable and nothing is written.
 *
 * NOT SENT WHERE NOTHING WILL ACT ON IT. A VPS below the release whose agent
 * is older than the first build with the updater, or whose AddOn is below the
 * release's minimumAddonVersion, is not requested: it is counted in needsVps
 * (and in skipped), because only an install on the VPS updates it. The rule is
 * src/domain/agentUpdate.js's, the one the card and the fleet view read. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const BODY_KEYS = ['action', 'deviceIds'];

function invalidRequest() {
  return new ApiError(400, 'invalid_request');
}

export function parseAgentUpdateBody(body) {
  if (!body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length !== BODY_KEYS.length
    || !BODY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    throw invalidRequest();
  }
  if (body.action !== 'request' && body.action !== 'cancel') throw invalidRequest();
  if (!Array.isArray(body.deviceIds)
    || body.deviceIds.length < 1
    || body.deviceIds.length > AGENT_UPDATE_BATCH_LIMIT
    || body.deviceIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw invalidRequest();
  }
  const deviceIds = body.deviceIds.map((id) => id.toLowerCase());
  if (new Set(deviceIds).size !== deviceIds.length) throw invalidRequest();
  return { action: body.action, deviceIds };
}

function rpcCount(data) {
  const value = Array.isArray(data) ? data[0] : data;
  const count = typeof value === 'object' && value !== null ? Object.values(value)[0] : value;
  if (!Number.isInteger(count) || count < 0) throw new Error('Agent update RPC returned no count.');
  return count;
}

function rpcError(error) {
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toUpperCase();
  return source.includes('INVALID_AGENT_UPDATE_REQUEST') ? invalidRequest() : error;
}

export function createAgentUpdateAdminStore(admin) {
  return {
    async loadDevices(deviceIds) {
      const { data, error } = await admin
        .from('ingest_devices')
        .select('id,status,revoked_at,agent_version,addon_version')
        .in('id', deviceIds);
      if (error) throw error;
      return data || [];
    },
    async request({ deviceIds, version, actorId }) {
      const { data, error } = await admin.rpc('request_agent_update', {
        p_device_ids: deviceIds, p_target_version: version, p_actor: actorId,
      });
      if (error) throw rpcError(error);
      return rpcCount(data);
    },
    async cancel({ deviceIds, actorId }) {
      const { data, error } = await admin.rpc('cancel_agent_update', {
        p_device_ids: deviceIds, p_actor: actorId,
      });
      if (error) throw rpcError(error);
      return rpcCount(data);
    },
  };
}

/**
 * Which of the listed devices the RPC is asked to update, and how many need
 * the VPS instead. "Would be requested" is step 70's own rule (active, not
 * revoked, agent unknown or below the target); of those, any the CRM cannot
 * reach is held back. An unknown agent version counts as too old here: there
 * is no evidence it has the updater.
 */
export function splitAgentUpdateRequest(rows, release) {
  const sendable = [];
  let needsVps = 0;
  for (const row of rows) {
    const device = {
      agentVersion: row.agent_version || null,
      addonVersion: row.addon_version || null,
    };
    const active = row.status === 'active' && !row.revoked_at;
    const below = compareAgentVersions(device.agentVersion, release.version);
    if (!active || (below !== null && below >= 0)) continue;
    if (agentUpdateBlockers(device, release).length) needsVps += 1;
    else sendable.push(row.id);
  }
  return { sendable, needsVps };
}

function safeError(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'agent_update_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createAgentUpdateAdminStore,
  resolveRelease = resolveInstallerRelease,
  env = process.env,
  production = env.NODE_ENV === 'production',
  fetchRelease = globalThis.fetch,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST']);
      const { admin, auth } = createClients();
      const actor = await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const input = parseAgentUpdateBody(await readJsonBody(req, { maxBytes: 16 * 1024 }));
      const store = createStore(admin);
      res.setHeader('Cache-Control', 'private, no-store');

      if (input.action === 'cancel') {
        const cancelled = await store.cancel({ deviceIds: input.deviceIds, actorId: actor.id });
        return sendJson(res, 200, { ok: true, cancelled });
      }

      let release = null;
      try {
        release = await resolveRelease(env, { production, fetchImpl: fetchRelease });
      } catch {
        release = null;
      }
      if (!release?.version || !TARGET_VERSION.test(release.version)) throw new ApiError(409, 'release_unavailable');

      const rows = await store.loadDevices(input.deviceIds);
      const { sendable, needsVps } = splitAgentUpdateRequest(rows, release);
      const requested = sendable.length
        ? await store.request({ deviceIds: sendable, version: release.version, actorId: actor.id })
        : 0;
      return sendJson(res, 200, {
        ok: true,
        version: release.version,
        requested,
        skipped: input.deviceIds.length - requested,
        needsVps,
      });
    } catch (error) {
      return handleApiError(res, safeError(error), {
        fallbackMessage: 'agent_update_failed',
        underlying: error instanceof ApiError ? null : error,
      });
    }
  };
}

export default createHandler();
