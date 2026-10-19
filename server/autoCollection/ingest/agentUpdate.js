import process from 'node:process';
import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { pinnedReleaseManifest, resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { compareCollectorVersions, normalizeCollectorVersion } from '../../apiLib/collectorVersion.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';

/* THE AGENT ASKS WHETHER THE CRM WANTS IT UPDATED, AND SAYS HOW THE LAST ONE WENT.
 *
 * Agent 1.3.0 and later posts here on its own schedule with the device headers
 * every ingest route takes. The body is four keys and nothing else: the
 * version it runs, and, while it is working on an update, the state it is in,
 * the code of a failure, and the version that state is about. The answer is
 * `update: null`, or a directive naming the release the CRM pins: its version,
 * the manifest's address and the manifest's SHA-256. The agent fetches the
 * manifest itself, checks the bytes against that digest, and installs the
 * package outside the capture window.
 *
 * Its own endpoint and not a field on the heartbeat, for the reason the
 * quarantine report gives: the heartbeat refuses a key it does not know, and
 * every deployed agent depends on that staying true.
 *
 * A DIRECTIVE ONLY FOR THE RELEASE PINNED RIGHT NOW. Step 70 keeps what a
 * Manager asked for; this route hands it out only while that target is exactly
 * the version resolveInstallerRelease verifies today and the agent is below it.
 * A request for a release the CRM has since moved away from is never acted on:
 * the agent would be sent a manifest that names a different version. A release
 * that cannot be resolved right now (GitHub down, a broken configuration) is
 * "no directive", never a 500, so a polling agent never logs an error for a
 * fault on this side.
 *
 * AND NOT WHEN THE RELEASE NEEDS A NEWER ADDON than the VPS last reported in
 * its heartbeat. The agent cannot install the AddOn (NinjaTrader has to be
 * closed for it), so the update waits for a person on the VPS. */
const BODY_KEYS = new Set(['agentVersion', 'state', 'errorCode', 'targetVersion']);
export const AGENT_REPORTED_STATES = new Set(['downloading', 'staged', 'applying', 'failed']);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TARGET_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const config = { api: { bodyParser: false } };

function invalidRequest(status = 400) {
  return new ApiError(status, 'invalid_request');
}

function nullable(value) {
  return value === undefined ? null : value;
}

/**
 * The poll body, or a 400 invalid_request.
 *
 * A key outside the four is refused, like the heartbeat refuses one. A key
 * that is absent reads as null, also like the heartbeat: only agentVersion is
 * required.
 */
export function normalizeAgentUpdateBody(value) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !BODY_KEYS.has(key))) {
    throw invalidRequest();
  }
  if (typeof value.agentVersion !== 'string') throw invalidRequest();
  let agentVersion;
  try {
    agentVersion = normalizeCollectorVersion(value.agentVersion);
  } catch {
    throw invalidRequest();
  }

  const state = nullable(value.state);
  if (state !== null && !AGENT_REPORTED_STATES.has(state)) throw invalidRequest();

  const errorCode = nullable(value.errorCode);
  if (errorCode !== null && (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode))) throw invalidRequest();
  // A failure names its code, and nothing else carries one.
  if ((state === 'failed') !== (errorCode !== null)) throw invalidRequest();

  const targetVersion = nullable(value.targetVersion);
  if (targetVersion !== null && (typeof targetVersion !== 'string' || !TARGET_VERSION.test(targetVersion))) {
    throw invalidRequest();
  }

  return { agentVersion, state, errorCode, targetVersion };
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function errorText(error) {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
}

/* NOT DEPLOYED YET IS AN ANSWER, NOT A FAULT, the quarantine route's rule.
 * Before step 70 runs the function is missing, and the agent is told what a
 * CRM without this route would tell it: 404, which it treats as "nothing to
 * do here" and asks again later. */
function isNotDeployedYet(error) {
  const code = String(error?.code || '');
  if (code === 'PGRST202' || code === '42883' || code === '42P01' || code === '42703') return true;
  const text = errorText(error).toLowerCase();
  return /could not find the function|function .* does not exist|relation .* does not exist|column .* does not exist/.test(text);
}

function pollValidationError(error) {
  const source = errorText(error).toUpperCase();
  if (source.includes('INVALID_AGENT_UPDATE_REQUEST')) return invalidRequest();
  if (source.includes('INVALID_INGEST_DEVICE')) return new ApiError(401, 'invalid_device_credential');
  return null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createAgentUpdateStore(admin) {
  return {
    /** Records the poll (step 70) and returns what is pending for this device. */
    async recordPoll(payload) {
      const { data, error } = await admin.rpc('record_agent_update_poll', {
        p_device_id: payload.deviceId,
        p_agent_version: payload.agentVersion,
        p_state: payload.state,
        p_error_code: payload.errorCode,
        p_target_version: payload.targetVersion,
      });
      if (error) {
        if (isNotDeployedYet(error)) throw new ApiError(404, 'not_found');
        throw pollValidationError(error) || error;
      }
      const row = unwrapRpcRow(data);
      const target = row?.target_version ?? null;
      if (target !== null && (typeof target !== 'string' || !TARGET_VERSION.test(target))) {
        throw new Error('Agent update RPC returned an invalid target version.');
      }
      return { targetVersion: target, requestedAt: row?.requested_at ?? null };
    },

    /** The AddOn version the VPS last reported in its heartbeat, null when none. */
    async loadAddonVersion(deviceId) {
      const { data, error } = await admin
        .from('ingest_devices')
        .select('addon_version')
        .eq('id', deviceId)
        .maybeSingle();
      if (error) throw error;
      return data?.addon_version || null;
    },
  };
}

function addonBelow(addonVersion, minimum) {
  if (!addonVersion) return true;
  try {
    return compareCollectorVersions(addonVersion, minimum) < 0;
  } catch {
    return true;
  }
}

/**
 * The directive for one poll, or null. Never throws: anything it cannot
 * establish (the release, the pin, the AddOn) withholds the directive.
 */
export async function agentUpdateDirective({ pending, agentVersion, loadRelease, loadPinned, loadAddonVersion }) {
  if (!pending?.targetVersion) return null;
  if (compareCollectorVersions(agentVersion, pending.targetVersion) >= 0) return null;
  const requestedAt = canonicalTimestamp(pending.requestedAt);
  if (!requestedAt) return null;
  try {
    const release = await loadRelease();
    if (!release?.version || release.version !== pending.targetVersion) return null;
    const pinned = loadPinned();
    if (!pinned?.url || typeof pinned.sha256 !== 'string' || !SHA256.test(pinned.sha256)) return null;
    if (release.minimumAddonVersion && addonBelow(await loadAddonVersion(), release.minimumAddonVersion)) return null;
    return {
      version: pending.targetVersion,
      manifestUrl: pinned.url,
      manifestSha256: pinned.sha256,
      requestedAt,
    };
  } catch {
    return null;
  }
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createAgentUpdateStore,
  authenticate = requireIngestDevice,
  pepper = resolveIngestPepper(),
  resolveRelease = resolveInstallerRelease,
  pinnedManifest = pinnedReleaseManifest,
  env = process.env,
  production = env.NODE_ENV === 'production',
  fetchRelease = globalThis.fetch,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, 'POST');
      const admin = createClient();
      const device = await authenticate(req, {
        store: createAuthStore(admin),
        pepper,
      });

      let requestBody;
      try {
        // Four short fields; the heartbeat's defensive read, smaller.
        requestBody = await readJsonBody(req, { maxBytes: 4 * 1024 });
      } catch (error) {
        if (error instanceof ApiError && [400, 413].includes(error.status)) {
          throw invalidRequest(error.status);
        }
        throw error;
      }
      const report = normalizeAgentUpdateBody(requestBody);
      const store = createStore(admin);
      const pending = await store.recordPoll({ deviceId: device.id, ...report });
      const update = await agentUpdateDirective({
        pending,
        agentVersion: report.agentVersion,
        loadRelease: () => resolveRelease(env, { production, fetchImpl: fetchRelease }),
        loadPinned: () => pinnedManifest(env),
        loadAddonVersion: () => store.loadAddonVersion(device.id),
      });
      return sendJson(res, 200, { ok: true, update });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'agent_update_unavailable' });
      }
      // A 503, like the quarantine report: the agent asks again on its next
      // poll and nothing depends on this one landing. The cause reaches the log.
      return handleApiError(res, new ApiError(503, 'agent_update_unavailable'), {
        fallbackMessage: 'agent_update_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
