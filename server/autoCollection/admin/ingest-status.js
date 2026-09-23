import process from 'node:process';
import { createApiClients, requireAppUser, requireClientAssignment } from '../../apiLib/apiAuth.js';
import { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../../apiLib/http.js';
import { summarizeQuarantine } from '../../../src/domain/autoCollectionFleet.js';

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
const QUARANTINE_SELECT = 'device_id,capture_id,trading_date,code,attempts,quarantined_at,last_attempt_at,reported_at,final';

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

  /* WHAT THE VPS SAYS IT IS HOLDING BACK.
   *
   * Agent 1.0.7 reports its quarantine folder after every daily review and
   * step 46 keeps the rows. Read by client, newest trading date first, and
   * narrowed to the device on the card afterwards. Null, not empty, when the
   * table is not there yet: an un-migrated database has nothing to say about
   * a quarantine and the card says nothing, the same way the fleet view does.
   *
   * Swallows its own failure for the same reason the pairing audit does: the
   * device and enrollment rows are the card, and a courtesy line is not worth
   * a 500 on the client page. */
  async function quarantineRows(clientId) {
    try {
      const { data, error } = await admin
        .from('ingest_quarantine_reports')
        .select(QUARANTINE_SELECT)
        .eq('client_id', clientId)
        .order('trading_date', { ascending: false })
        .limit(200);
      if (error) return null;
      return data || [];
    } catch {
      return null;
    }
  }

  /* THE LAST THING THE VPS ACTUALLY COLLECTED, WHICH THE CARD HAS NEVER SEEN.
   *
   * The Connected light is heartbeat-only: this endpoint has never read
   * ingest_batches at all, so a VPS that checks in every minute and captures
   * nothing reads exactly like a healthy one. On 2026-09-22, 11 of the 79
   * clients that captured finished the day with zero trading accounts in the
   * snapshot, because NinjaTrader was closed or not connected to the broker.
   *
   * Swallows its own failure, like the pairing audit and the quarantine read:
   * the device row is the card, and a courtesy line is not worth a 500. */
  async function lastBatch(clientId) {
    try {
      const { data, error } = await admin
        .from('ingest_batches')
        .select('id,trading_date,status,row_counts,received_at,error_code')
        .eq('client_id', clientId)
        .order('received_at', { ascending: false })
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
      const quarantinePromise = quarantineRows(clientId);
      const batchPromise = lastBatch(clientId);
      const [{ data: client, error }, device, enrollment, attempt, quarantine, batch] = await Promise.all([
        clientPromise,
        devicePromise,
        enrollmentPromise,
        attemptPromise,
        quarantinePromise,
        batchPromise,
      ]);
      if (error) throw error;
      if (!client?.id) throw new ApiError(404, 'client_not_found');
      return { client, device, enrollment, attempt, quarantine, batch };
    },
  };
}

/* Counts and a status, never a storage path or a capture id: this is the
 * client page, and the only question it asks of a batch is whether the last
 * collection carried anything. */
function publicLastBatch(row) {
  if (!row) return null;
  const counts = row.row_counts && typeof row.row_counts === 'object' ? row.row_counts : {};
  return {
    tradingDate: row.trading_date || null,
    status: row.status || null,
    receivedAt: row.received_at || null,
    rowCounts: {
      accounts: Number.isFinite(Number(counts.accounts)) ? Number(counts.accounts) : null,
      strategies: Number.isFinite(Number(counts.strategies)) ? Number(counts.strategies) : null,
      orders: Number.isFinite(Number(counts.orders)) ? Number(counts.orders) : null,
      executions: Number.isFinite(Number(counts.executions)) ? Number(counts.executions) : null,
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
    // When this VPS was paired. A machine paired an hour ago has collected
    // nothing yet, and that is what a new install looks like, not a fault.
    createdAt: row.created_at || null,
    schedule: {
      time: row.schedule_time,
      timezone: row.schedule_timezone,
    },
  };
}

/* The count, the dates and the codes, which are a fixed vocabulary and carry
 * no free text. Only the device on the card: a row left by a machine this
 * client no longer uses is not this client's problem. */
function publicQuarantine(rows, device) {
  if (!Array.isArray(rows) || !device) return null;
  return summarizeQuarantine(rows
    .filter((row) => row.device_id === device.id)
    .map((row) => ({
      captureId: row.capture_id,
      tradingDate: row.trading_date,
      code: row.code,
      attempts: Number.isInteger(row.attempts) ? row.attempts : 0,
      final: row.final === true,
      quarantinedAt: row.quarantined_at,
      lastAttemptAt: row.last_attempt_at || null,
      reportedAt: row.reported_at,
    })));
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
          // Replaying a refused close happens in Auto Collection, which only a
          // Manager can open, so only a Manager is pointed there.
          replay: actor.role === 'Manager',
        },
        release,
        device: publicDevice(status.device),
        enrollment: publicEnrollment(status.enrollment),
        lastPairAttempt: publicPairAttempt(status.attempt),
        quarantine: publicQuarantine(status.quarantine, status.device),
        lastBatch: publicLastBatch(status.batch),
      });
    } catch (error) {
      return handleApiError(res, publicError(error), { fallbackMessage: 'collector_status_failed' });
    }
  };
}

export default createHandler();
