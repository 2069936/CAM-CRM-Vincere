import process from 'node:process';
import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { resolveAgentMailSecret, resolveAgentMailUrl } from './reportEmail.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { normalizeCollectorVersion, requiresCollectorUpdate } from '../../apiLib/collectorVersion.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';

const HEARTBEAT_KEYS = new Set([
  'agentVersion',
  'addonVersion',
  'ninjaTraderVersion',
  'lastCaptureAt',
  'lastSuccessAt',
  'lastErrorCode',
  'lastErrorMessage',
  'queueDepth',
  'queueBytes',
  'addonAvailable',
]);
const ERROR_CODES = new Set([
  'ninjatrader_not_running',
  'addon_unavailable',
  'capture_timeout',
  'capture_failed',
  'contract_mismatch',
  'queue_capacity_warning',
  'upload_failed',
  'configuration_error',
]);
const HEALTH_STATUSES = new Set(['online', 'error', 'update_required']);
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

export const config = { api: { bodyParser: false } };

function invalidHeartbeat(status = 400) {
  return new ApiError(status, 'invalid_heartbeat');
}

function nullableTimestamp(value, latestAllowedMs) {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? ISO_TIMESTAMP_WITH_OFFSET.exec(value) : null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    (match?.slice(1) || []).map((part) => (part === undefined ? undefined : Number(part)));
  const calendarDate = match ? new Date(Date.UTC(year, month - 1, day)) : null;
  const validCalendarDate = calendarDate
    && calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
  const validOffset = offsetHour === undefined
    || (offsetHour < 14 && offsetMinute <= 59)
    || (offsetHour === 14 && offsetMinute === 0);
  if (!match
    || !validCalendarDate
    || hour > 23
    || minute > 59
    || second > 59
    || !validOffset
    || Number.isNaN(Date.parse(value))
    || Date.parse(value) > latestAllowedMs) {
    throw invalidHeartbeat();
  }
  return value;
}

function queueMetric(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidHeartbeat();
  return value;
}

/* A WORD THE CRM DOES NOT KNOW IS NOT A REASON TO SILENCE A MACHINE.
 *
 * The heartbeat is the only thing that says a machine is alive, and the agent
 * copies the code of its LAST failure into every heartbeat until something
 * succeeds. That includes the code of a refused heartbeat itself. So a single
 * 400 on this route used to close a loop: the agent recorded `invalid_heartbeat`,
 * sent it back as lastErrorCode, was refused for that word, recorded it again,
 * and the device went silent on the fleet screen until somebody reinstalled.
 * Two machines updated to 1.2.0 on 2026-10-08 were found this way: posting
 * account samples every ten minutes, last_seen_at frozen at the install.
 *
 * An unknown STRING is therefore accepted and stored as "no code": the device
 * stays online, the message (already sanitised) still says what happened, and
 * the record RPC's own vocabulary check never sees the word. A non string is
 * still a malformed body. */
function stableErrorCode(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalidHeartbeat();
  return ERROR_CODES.has(value) ? value : null;
}

function safeErrorMessage(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalidHeartbeat();
  const sanitized = Array.from(value)
    .filter((character) => !/\p{Cc}/u.test(character))
    .slice(0, 256)
    .join('');
  return sanitized || null;
}

/* THE FIELD THAT DEADLOCKED EVERY COLLECTOR ON THE DESK.
 *
 * ninjaTraderVersion went through normalizeCollectorVersion, which throws on an
 * empty string, and the catch below turns any throw into a 400. The agent does
 * not know the NinjaTrader version until the add-on has told it, so a machine
 * that has not completed a capture sends null and every heartbeat it will ever
 * send is refused as malformed.
 *
 * That is a closed loop. The column is only ever written by a heartbeat, so a
 * device whose heartbeats are refused for having no NinjaTrader version can
 * never acquire one. Four devices paired across three days, every one of them
 * with ninjatrader_version NULL, health_status still 'pending', last_seen_at
 * frozen at the second they paired, and nine snapshots stacked up on disk.
 *
 * The agent's own model has always declared this nullable, and lastCaptureAt
 * and lastSuccessAt beside it are already allowed to be null for exactly the
 * same reason: not knowing yet is the normal state of a new install.
 *
 * HALF A FIX UNTIL STEP 63. Passing null through here was not enough: the RPC
 * record_ingest_heartbeat (step 41) still refused `p_ninjatrader_version is
 * null`, and heartbeatValidationError below turned that refusal into the same
 * 400, so the loop above simply closed one layer down. Agents up to 1.1.x hid
 * it by sending the literal "8.1.0"; 1.2.0 sends the honest null and every
 * heartbeat from a restarted machine was refused until that day's capture.
 * supabase/step_63_heartbeat_without_ninjatrader_version.sql accepts the null
 * and keeps the version the database already holds. */
function nullableCollectorVersion(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return normalizeCollectorVersion(value);
}

export function normalizeHeartbeatBody(value, {
  now = new Date(),
  maxFutureSkewMs = 5 * 60 * 1000,
} = {}) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !HEARTBEAT_KEYS.has(key))) {
    throw invalidHeartbeat();
  }

  try {
    const referenceNow = now instanceof Date ? now : new Date(now);
    const latestAllowedMs = referenceNow.getTime() + maxFutureSkewMs;
    if (Number.isNaN(latestAllowedMs)) throw invalidHeartbeat();
    const addonAvailable = value.addonAvailable;
    if (addonAvailable !== null && typeof addonAvailable !== 'boolean') throw invalidHeartbeat();
    const lastCaptureAt = nullableTimestamp(value.lastCaptureAt, latestAllowedMs);
    const lastSuccessAt = nullableTimestamp(value.lastSuccessAt, latestAllowedMs);
    // No ordering rule between these two. An upload finishes after the capture it
    // carries, so lastSuccessAt later than lastCaptureAt is the ordinary case,
    // and the reverse is ordinary as well once a capture has happened since the
    // last acknowledged upload. Rejecting the first meant every heartbeat after
    // a successful upload was refused as malformed.
    return {
      agentVersion: normalizeCollectorVersion(value.agentVersion),
      addonVersion: normalizeCollectorVersion(value.addonVersion),
      ninjaTraderVersion: nullableCollectorVersion(value.ninjaTraderVersion),
      lastCaptureAt,
      lastSuccessAt,
      lastErrorCode: stableErrorCode(value.lastErrorCode),
      lastErrorMessage: safeErrorMessage(value.lastErrorMessage),
      queueDepth: queueMetric(value.queueDepth),
      queueBytes: queueMetric(value.queueBytes),
      addonAvailable,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidHeartbeat();
  }
}

export function parseHeartbeatIntervalSeconds(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return 30;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 30;
  return Math.min(parsed, 3600);
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function heartbeatValidationError(error) {
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toUpperCase();
  return source.includes('INVALID_HEARTBEAT_REQUEST')
    ? invalidHeartbeat()
    : null;
}

export function createHeartbeatStore(admin) {
  return {
    async recordHeartbeat(payload) {
      const { data, error } = await admin.rpc('record_ingest_heartbeat', {
        p_device_id: payload.deviceId,
        p_agent_version: payload.agentVersion,
        p_addon_version: payload.addonVersion,
        p_ninjatrader_version: payload.ninjaTraderVersion,
        p_last_capture_at: payload.lastCaptureAt,
        p_last_success_at: payload.lastSuccessAt,
        p_last_error_code: payload.lastErrorCode,
        p_last_error_message: payload.lastErrorMessage,
        p_queue_depth: payload.queueDepth,
        p_queue_bytes: payload.queueBytes,
        p_addon_available: payload.addonAvailable,
        p_health_status: payload.healthStatus,
        p_min_interval_seconds: payload.minIntervalSeconds,
      });
      if (error) throw heartbeatValidationError(error) || error;
      const row = unwrapRpcRow(data);
      if (!row?.device_id
        || !HEALTH_STATUSES.has(row.health_status)
        || typeof row.throttled !== 'boolean'
        || typeof row.schedule_time !== 'string'
        || typeof row.schedule_timezone !== 'string') {
        throw new Error('Heartbeat RPC returned no device.');
      }
      return {
        deviceId: row.device_id,
        status: row.health_status,
        throttled: row.throttled,
        scheduleTime: row.schedule_time,
        scheduleTimezone: row.schedule_timezone,
      };
    },
  };
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createHeartbeatStore,
  authenticate = requireIngestDevice,
  pepper = resolveIngestPepper(),
  minimumAgentVersion = process.env.AUTO_COLLECTION_MIN_AGENT_VERSION,
  minIntervalSeconds = parseHeartbeatIntervalSeconds(
    process.env.AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS,
  ),
  now = () => new Date(),
  // Injected like everything else here, so a test can assert both the handed
  // out case and the deployment that has no relay configured.
  reportEmailSecret = resolveAgentMailSecret(),
  reportEmailUrl = resolveAgentMailUrl(),
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
        // No requireRawBody: it refused a body the platform had already
        // parsed, and the platform always parses. See readJsonBody.
        requestBody = await readJsonBody(req, { maxBytes: 8 * 1024 });
      } catch (error) {
        if (error instanceof ApiError && [400, 413].includes(error.status)) {
          throw invalidHeartbeat(error.status);
        }
        throw error;
      }
      const heartbeat = normalizeHeartbeatBody(requestBody, { now: now() });
      const updateRequired = requiresCollectorUpdate(
        heartbeat.agentVersion,
        minimumAgentVersion,
      );
      const healthStatus = updateRequired
        ? 'update_required'
        : (heartbeat.lastErrorCode ? 'error' : 'online');
      const recorded = await createStore(admin).recordHeartbeat({
        deviceId: device.id,
        ...heartbeat,
        healthStatus,
        minIntervalSeconds,
      });

      return sendJson(res, 200, {
        ok: true,
        deviceId: recorded.deviceId,
        status: recorded.status,
        updateRequired,
        throttled: recorded.throttled,
        schedule: {
          time: recorded.scheduleTime.slice(0, 5),
          timeZone: recorded.scheduleTimezone,
        },
        /* HANDED OUT HERE SO NOBODY HAS TO RE-PAIR THIRTY MACHINES.
         *
         * The agent needs this to ask /api/ingest/report-email to send its
         * local report on a day the database is down. It cannot be fetched on
         * that day, because fetching it is what is broken, so it arrives on
         * every ordinary day and the agent keeps the last one it was given.
         *
         * Pairing would have been the other place, and it is the wrong one:
         * every machine in the field is already paired, and re-pairing them is
         * a person opening thirty VPSs to fix an outage that has not happened
         * yet.
         *
         * WHAT IT IS WORTH TO AN ATTACKER, stated plainly. It buys one thing:
         * asking that route to email a report to an address the route reads
         * from its own environment and never from the request. It is not a
         * mail credential, it grants nothing in this database, and it cannot
         * redirect a message. That is why it can travel to thirty client
         * machines at all, and the bound is enforced in the route, not here.
         *
         * Absent from the response when the deployment has no relay
         * configured, rather than sent empty: the agent then has nothing to
         * cache and says so, instead of posting a blank secret all year. */
        ...(reportEmailSecret ? { reportEmailSecret } : {}),
        /* WHERE TO POST IT, WHICH IS NOT THIS DEPLOYMENT.
         *
         * The Brevo key cannot live on Vercel - nobody here can add an
         * environment variable to it - so the send happens in a Supabase Edge
         * Function, where the CAM sets the secret himself. The agent is told
         * the address rather than having it compiled in, so moving it later
         * costs a heartbeat instead of thirty machine visits.
         *
         * Derived from SUPABASE_URL, which this deployment is guaranteed to
         * have. Absent when it is not, and the agent then falls back to this
         * deployment's own relay route, which is where it posted first. */
        ...(reportEmailUrl ? { reportEmailUrl } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'heartbeat_unavailable' });
      }
      // Same laundering the upload path had: replacing the error with a clean
      // ApiError makes it look deliberate, and a deliberate error is neither
      // logged nor given a cause. Four devices have been failing here since
      // 31 August and no theory about why has survived contact with the
      // evidence, so the next failure gets to name itself.
      return handleApiError(res, new ApiError(500, 'heartbeat_unavailable'), {
        fallbackMessage: 'heartbeat_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
