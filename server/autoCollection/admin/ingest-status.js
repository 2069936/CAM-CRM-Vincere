import process from 'node:process';
import { createApiClients, requireAppUser, requireClientAssignment } from '../../apiLib/apiAuth.js';
import { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../../apiLib/http.js';

export { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_DEVICE_ERROR_CODES = new Set([
  'ninjatrader_not_running',
  'addon_unavailable',
  'capture_timeout',
  'capture_failed',
  'contract_mismatch',
  'queue_capacity_warning',
  'upload_failed',
  'configuration_error',
]);
const DEVICE_SELECT = [
  'id', 'status', 'health_status', 'schedule_time', 'schedule_timezone',
  'agent_version', 'addon_version', 'ninjatrader_version', 'last_seen_at',
  'last_capture_at', 'last_success_at', 'last_error_code', 'revoked_at', 'created_at',
].join(',');
const ENROLLMENT_SELECT = 'id,expires_at,consumed_at,revoked_at,created_at';

/* The refusals a CAM is allowed to read back, by the name the agent already
 * shows on the VPS. Anything unrecognised collapses, so a reason added to the
 * pairing RPC later cannot surface here unreviewed. */
const SAFE_PAIR_REASONS = new Set([
  'code_expired',
  'code_consumed',
  'code_revoked',
  'machine_conflict',
  'device_revoked',
  'client_ineligible',
  'credential_conflict',
  'nonce_or_credential_conflict',
  'invalid_request',
  'rate_limited',
]);

function requireClientUuid(value) {
  const normalized = String(value || '').trim();
  if (!UUID.test(normalized)) throw new ApiError(400, 'invalid_client_uuid');
  return normalized.toLowerCase();
}

export function createIngestStatusStore(admin) {
  async function maybeLatest(table, columns, clientId) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  /* THE ATTEMPT NOBODY COULD SEE.
   *
   * Pairing happens on the VPS and fails there, so the CRM showed a client
   * stuck at "Not connected" with no hint of why, while the person at the VPS
   * read a sentence the CAM never saw. The refusals were being audited the
   * whole time. This reads the last one back.
   *
   * Swallows its own failure: a card that renders without this line is the card
   * that shipped, and an audit read is not worth a 500 on the client page. */
  async function lastPairAttempt(clientId) {
    try {
      const { data, error } = await admin
        .from('audit_logs')
        .select('created_at, after_data')
        .eq('entity_type', 'ingest_pair_attempt')
        .eq('entity_id', clientId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data || null;
    } catch {
      return null;
    }
  }

  return {
    async load(clientId) {
      const clientPromise = admin.from('clients').select('id,name').eq('id', clientId).maybeSingle();
      const devicePromise = maybeLatest('ingest_devices', DEVICE_SELECT, clientId);
      const enrollmentPromise = maybeLatest('ingest_enrollments', ENROLLMENT_SELECT, clientId);
      const attemptPromise = lastPairAttempt(clientId);
      const [{ data: client, error }, device, enrollment, attempt] = await Promise.all([
        clientPromise,
        devicePromise,
        enrollmentPromise,
        attemptPromise,
      ]);
      if (error) throw error;
      if (!client?.id) throw new ApiError(404, 'client_not_found');
      return { client, device, enrollment, attempt };
    },
  };
}

function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    healthStatus: row.health_status,
    agentVersion: row.agent_version || null,
    addonVersion: row.addon_version || null,
    ninjaTraderVersion: row.ninjatrader_version || null,
    lastSeenAt: row.last_seen_at || null,
    lastCaptureAt: row.last_capture_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorCode: SAFE_DEVICE_ERROR_CODES.has(row.last_error_code)
      ? row.last_error_code
      : row.last_error_code ? 'collector_error' : null,
    revokedAt: row.revoked_at || null,
    schedule: {
      time: row.schedule_time,
      timezone: row.schedule_timezone,
    },
  };
}

function publicEnrollment(row) {
  if (!row) return null;
  return {
    id: row.id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    revokedAt: row.revoked_at || null,
  };
}

/* WHAT THE CAM IS TOLD ABOUT THE BLOCKING CLIENT, AND WHAT THEY ARE NOT.
 *
 * The name, because asking for a revocation requires knowing whom to ask, and
 * the CAM's own fleet view cannot show a client outside their book. Not the
 * uuid and not the device id: neither is actionable without Manager rights,
 * and both are identifiers for a record this CAM has no rights over. */
function publicPairAttempt(row) {
  if (!row) return null;
  const reason = row.after_data?.reasonCode;
  const blockedBy = row.after_data?.blockedBy;
  const holderName = String(blockedBy?.clientName || '').trim();
  return {
    at: row.created_at,
    reason: SAFE_PAIR_REASONS.has(reason) ? reason : 'pairing_refused',
    agentVersion: row.after_data?.agentVersion || null,
    blockedBy: holderName ? { clientName: holderName, pairedAt: blockedBy.pairedAt || null } : null,
  };
}

function publicError(error) {
  if (error instanceof ApiError) return error;
  if (error?.status === 401) return new ApiError(401, 'Invalid session token.');
  if (error?.status === 403) return new ApiError(403, 'Client assignment required.');
  return new ApiError(500, 'collector_status_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  enforceAssignment = requireClientAssignment,
  createStore = createIngestStatusStore,
  env = process.env,
  production = env.NODE_ENV === 'production',
  fetchRelease = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      res.setHeader('Cache-Control', 'private, no-store');
      const { admin, auth } = createClients();
      const actor = await authorize(req, {
        admin,
        authClient: auth,
        roles: ['Manager', 'CAM'],
      });
      const clientId = requireClientUuid(req.query?.clientUuid);
      await enforceAssignment(admin, actor, clientId);
      const status = await createStore(admin).load(clientId);
      const release = await resolveInstallerRelease(env, { production, fetchImpl: fetchRelease });
      return sendJson(res, 200, {
        serverTime: now().toISOString(),
        client: { uuid: status.client.id, name: status.client.name },
        permissions: {
          generate: ['Manager', 'CAM'].includes(actor.role),
          rebind: ['Manager', 'CAM'].includes(actor.role),
          revoke: ['Manager', 'CAM'].includes(actor.role),
        },
        release,
        device: publicDevice(status.device),
        enrollment: publicEnrollment(status.enrollment),
        lastPairAttempt: publicPairAttempt(status.attempt),
      });
    } catch (error) {
      return handleApiError(res, publicError(error), { fallbackMessage: 'collector_status_failed' });
    }
  };
}

export default createHandler();
