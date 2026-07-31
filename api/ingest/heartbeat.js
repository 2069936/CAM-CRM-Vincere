import process from 'node:process';
import { createServiceClient } from '../_lib/apiAuth.js';
import { normalizeCollectorVersion, requiresCollectorUpdate } from '../_lib/collectorVersion.js';
import { createDeviceAuthStore, requireIngestDevice } from '../_lib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../_lib/http.js';

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

function stableErrorCode(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ERROR_CODES.has(value)) throw invalidHeartbeat();
  return value;
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
    if (lastCaptureAt && lastSuccessAt
      && Date.parse(lastSuccessAt) > Date.parse(lastCaptureAt)) {
      throw invalidHeartbeat();
    }
    return {
      agentVersion: normalizeCollectorVersion(value.agentVersion),
      addonVersion: normalizeCollectorVersion(value.addonVersion),
      ninjaTraderVersion: normalizeCollectorVersion(value.ninjaTraderVersion),
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
  pepper = process.env.INGEST_TOKEN_PEPPER,
  minimumAgentVersion = process.env.AUTO_COLLECTION_MIN_AGENT_VERSION,
  minIntervalSeconds = parseHeartbeatIntervalSeconds(
    process.env.AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS,
  ),
  now = () => new Date(),
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
        requestBody = await readJsonBody(req, {
          maxBytes: 8 * 1024,
          requireRawBody: true,
        });
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
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'heartbeat_unavailable' });
      }
      return handleApiError(res, new ApiError(500, 'heartbeat_unavailable'), {
        fallbackMessage: 'heartbeat_unavailable',
      });
    }
  };
}

export default createHandler();
