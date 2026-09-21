import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';

/* ITS OWN ENDPOINT, AND NOT A FIELD ON THE HEARTBEAT.
 *
 * The heartbeat refuses any key it does not know with a 400 and its record
 * function refuses any error code outside its list, and every deployed agent
 * depends on that staying true. An agent that put the quarantine on the
 * heartbeat would silence every heartbeat on the fleet until the CRM caught up.
 * So agent 1.0.7 posts the inventory here, with the same device headers, after
 * every review of its quarantine folder, and expects a 404 from a CRM that has
 * not been deployed with this handler yet: it logs that once and tries again
 * tomorrow. That is also what this handler answers when the table behind it is
 * not there yet, so the deploy and migration step 46 can happen in either
 * order without a single error line on a VPS. */
const REPORT_KEYS = new Set(['schemaVersion', 'reportedAt', 'items']);
const ITEM_KEYS = new Set(['tradingDate', 'captureId', 'code', 'attempts', 'quarantinedAt', 'lastAttemptAt']);
export const MAX_ITEMS = 200;
/* The vocabulary, in the same order as the CHECK in step 46. The six the CRM
 * answers with, the five the queue writes for a file on disk it cannot trust,
 * the one for a payload with no reason file, the two the uploader writes on
 * its own, and 'other'. */
export const QUARANTINE_CODES = new Set([
  'snapshot_processing_failed',
  'unsupported_schema_version',
  'snapshot_rejected',
  'payload_too_large',
  'capture_requires_replay',
  'capture_conflict',
  'queue_payload_corrupt',
  'queue_payload_mismatch',
  'queue_payload_changed',
  'queue_item_invalid',
  'capture_id_conflict',
  'receipt_invalid',
  'receipt_hash_mismatch',
  'quarantine_reason_invalid',
  'upload_failed',
  'unexpected_redirect',
  'tls_failure',
  'other',
]);
const CODE_SHAPE = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

export const config = { api: { bodyParser: false } };

function invalidReport(status = 400) {
  return new ApiError(status, 'invalid_quarantine_report');
}

function plainObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && !Object.keys(value).some((key) => !keys.has(key));
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function tradingDate(value) {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!match) throw invalidReport();
  const [year, month, day] = match.slice(1).map(Number);
  if (!validCalendarDate(year, month, day)) throw invalidReport();
  return value;
}

function captureId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidReport();
  return value.toLowerCase();
}

/* AN UNKNOWN CODE IS NOT A REASON TO REFUSE THE REPORT. The heartbeat refuses
 * a code it does not know and that has cost the desk a fleet of silent devices
 * once already. A code this CRM has not met is a newer agent, and what the
 * desk needs from the report, how many, which dates, which will move on their
 * own, is all still true of it. It collapses to 'other', which the agent never
 * retries and which the table therefore reads as final. */
function quarantineCode(value) {
  if (typeof value !== 'string' || !CODE_SHAPE.test(value)) throw invalidReport();
  return QUARANTINE_CODES.has(value) ? value : 'other';
}

/* No upper bound. The two 422 codes stop at three, but a close the CRM already
 * holds is sent again at every review until the desk replays it, and a month
 * of that is thirty: the number is what the desk reads to see how long a
 * replay has waited. */
function attempts(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidReport();
  return value;
}

function timestamp(value, latestAllowedMs, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw invalidReport();
  }
  const match = typeof value === 'string' ? ISO_TIMESTAMP_WITH_OFFSET.exec(value) : null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    (match?.slice(1) || []).map((part) => (part === undefined ? undefined : Number(part)));
  const validOffset = offsetHour === undefined
    || (offsetHour < 14 && offsetMinute <= 59)
    || (offsetHour === 14 && offsetMinute === 0);
  if (!match
    || !validCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || !validOffset
    || Number.isNaN(Date.parse(value))
    || Date.parse(value) > latestAllowedMs) {
    throw invalidReport();
  }
  return value;
}

function reportItem(value, latestAllowedMs) {
  if (!plainObject(value, ITEM_KEYS)) throw invalidReport();
  return {
    tradingDate: tradingDate(value.tradingDate),
    captureId: captureId(value.captureId),
    code: quarantineCode(value.code),
    attempts: attempts(value.attempts),
    quarantinedAt: timestamp(value.quarantinedAt, latestAllowedMs),
    lastAttemptAt: timestamp(value.lastAttemptAt, latestAllowedMs, { nullable: true }),
  };
}

export function normalizeQuarantineBody(value, {
  now = new Date(),
  maxFutureSkewMs = 5 * 60 * 1000,
} = {}) {
  if (!plainObject(value, REPORT_KEYS)) throw invalidReport();
  try {
    const referenceNow = now instanceof Date ? now : new Date(now);
    const latestAllowedMs = referenceNow.getTime() + maxFutureSkewMs;
    if (Number.isNaN(latestAllowedMs)) throw invalidReport();
    if (value.schemaVersion !== 1) throw invalidReport();
    if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw invalidReport();
    const items = value.items.map((item) => reportItem(item, latestAllowedMs));
    // The same capture twice is not a folder, where a file has one name.
    if (new Set(items.map((item) => item.captureId)).size !== items.length) throw invalidReport();
    return {
      schemaVersion: 1,
      reportedAt: timestamp(value.reportedAt, latestAllowedMs),
      items,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidReport();
  }
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function errorText(error) {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
}

/* NOT DEPLOYED YET IS AN ANSWER, NOT A FAULT. The function and the table
 * arrive with migration step 46, and the handler may be live before it has
 * run. PostgREST names a function it cannot find PGRST202 and Postgres names
 * a missing relation 42P01; both mean the same thing the agent already
 * expects from a CRM without this handler at all, so the answer is the same
 * 404, which the agent remembers for a day and never marks on the device. */
function isNotDeployedYet(error) {
  const code = String(error?.code || '');
  if (code === 'PGRST202' || code === '42883' || code === '42P01') return true;
  const text = errorText(error).toLowerCase();
  return /could not find the function|function .* does not exist|relation .* does not exist/.test(text);
}

function reportValidationError(error) {
  const source = errorText(error).toUpperCase();
  if (source.includes('INVALID_QUARANTINE_REPORT')) return invalidReport();
  if (source.includes('INVALID_INGEST_DEVICE')) return new ApiError(401, 'invalid_device_credential');
  return null;
}

export function createQuarantineStore(admin) {
  return {
    async recordReport(payload) {
      const { data, error } = await admin.rpc('record_ingest_quarantine_report', {
        p_device_id: payload.deviceId,
        p_items: payload.items,
      });
      if (error) {
        if (isNotDeployedYet(error)) throw new ApiError(404, 'not_found');
        throw reportValidationError(error) || error;
      }
      const row = unwrapRpcRow(data);
      if (!row?.device_id || !Number.isInteger(row.recorded)) {
        throw new Error('Quarantine report RPC returned no device.');
      }
      return { deviceId: row.device_id, recorded: row.recorded, removed: Number.isInteger(row.removed) ? row.removed : 0 };
    },
  };
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createQuarantineStore,
  authenticate = requireIngestDevice,
  pepper = resolveIngestPepper(),
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
        // 200 items at roughly 220 bytes each is 44 KiB; the agent caps the
        // report there, newest first. Same defensive read as the heartbeat.
        requestBody = await readJsonBody(req, { maxBytes: 64 * 1024 });
      } catch (error) {
        if (error instanceof ApiError && [400, 413].includes(error.status)) {
          throw invalidReport(error.status);
        }
        throw error;
      }
      const report = normalizeQuarantineBody(requestBody, { now: now() });
      const recorded = await createStore(admin).recordReport({
        deviceId: device.id,
        items: report.items,
      });

      return sendJson(res, 200, { ok: true, recorded: recorded.recorded });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'quarantine_report_unavailable' });
      }
      // A 503, not a 500: the agent retries a 5xx inside its client and offers
      // the report again fifteen minutes later, and nothing about the queue
      // depends on it landing. The cause reaches the log the way the heartbeat's
      // does, so the next failure here gets to name itself.
      return handleApiError(res, new ApiError(503, 'quarantine_report_unavailable'), {
        fallbackMessage: 'quarantine_report_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
