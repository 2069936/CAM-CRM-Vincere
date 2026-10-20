import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import {
  byteSizeOf,
  createTradingExportAdminStore,
} from '../../apiLib/tradingExportStore.js';
import {
  FIRST_SLIM_EXPORT_AGENT,
  OPEN_TRADING_EXPORT_STATUSES,
  TRADING_EXPORT_BATCH_LIMIT,
  TRADING_EXPORT_DATASETS,
  TRADING_EXPORT_DOWNLOAD_SECONDS,
  TRADING_EXPORT_STATUSES,
  canSendTradingExport,
  isIsoDate,
  normalizeDatasets,
  tradingExportFileName,
} from '../../../src/domain/tradingExport.js';

/* THE MANAGER'S HALF OF A SLIM TRADING EXPORT (step 72), one route.
 *
 * POST /api/admin/ingest-trading-export, Manager only, decided before the body
 * is read. { action, ... } with exactly the keys each action takes:
 *
 *   request  { deviceIds (1 to 300 uuids), from?, to?, datasets? }
 *            -> { ok, requested, skipped, needsVps }
 *            One requested row per listed device that is active, not revoked,
 *            has an agent at FIRST_SLIM_EXPORT_AGENT or later and no export in
 *            progress. A device below that (or with no version) is counted in
 *            needsVps and in skipped, never sent a request nothing would act
 *            on. from and to are YYYY-MM-DD or null (from null: since the
 *            device's last export; to null: today); datasets default to all
 *            four.
 *   cancel   { requestIds (1 to 300) }        -> { ok, cancelled }
 *   list     { clientId }                     -> { ok, exports }
 *   listAll  { limit?, offset?, status? }     -> { ok, exports, total, limit, offset }
 *            The Data lab's list: every client, newest first, paged.
 *   devices  {}                               -> { ok, minimumAgentVersion, devices }
 *            Every paired active device, with its client, its agent and the
 *            date of its last ready export: the Data lab's picker.
 *   download { requestId }                    -> { ok, url, fileName, expiresAt }
 *            A signed URL that lives five minutes, for a ready export that
 *            has not expired, and an audit row.
 *   delete   { requestId }                    -> { ok, deleted }
 *            The object removed, then the request marked expired.
 *
 * EXPIRY IS LAZY. Nothing runs on a clock: list, listAll and download remove
 * the file of every ready export past its 14 days, then mark it expired, and a
 * row that could not be closed yet is still shown as expired, so a download is
 * never offered for a file that should be gone.
 *
 * AUDIT. request, cancel, delete and each expiry write their rows inside step
 * 72's functions; download writes its own after the URL is signed. list,
 * listAll and devices are reads and write nothing.
 *
 * Before step 72 runs, every action answers 404 trading_export_unavailable. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const OFFSET_MAX = 1_000_000;
const EXPIRY_SWEEP = 100;

const ACTION_KEYS = Object.freeze({
  request: { required: ['deviceIds'], optional: ['from', 'to', 'datasets'] },
  cancel: { required: ['requestIds'], optional: [] },
  list: { required: ['clientId'], optional: [] },
  listAll: { required: [], optional: ['limit', 'offset', 'status'] },
  devices: { required: [], optional: [] },
  download: { required: ['requestId'], optional: [] },
  delete: { required: ['requestId'], optional: [] },
});

function invalidRequest() {
  return new ApiError(400, 'invalid_request');
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidRequest();
  return value.toLowerCase();
}

function uuidList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > TRADING_EXPORT_BATCH_LIMIT) throw invalidRequest();
  const ids = value.map(uuid);
  if (new Set(ids).size !== ids.length) throw invalidRequest();
  return ids;
}

function optionalDate(value) {
  if (value === undefined || value === null) return null;
  if (!isIsoDate(value)) throw invalidRequest();
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidRequest();
  return value;
}

/** The body of one action, or a 400 invalid_request. */
export function parseTradingExportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest();
  const shape = typeof body.action === 'string' && Object.hasOwn(ACTION_KEYS, body.action) ? ACTION_KEYS[body.action] : null;
  if (!shape) throw invalidRequest();
  const allowed = new Set(['action', ...shape.required, ...shape.optional]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw invalidRequest();
  if (shape.required.some((key) => !Object.hasOwn(body, key))) throw invalidRequest();

  switch (body.action) {
    case 'request': {
      const from = optionalDate(body.from);
      const to = optionalDate(body.to);
      if (from && to && from > to) throw invalidRequest();
      const datasets = body.datasets === undefined || body.datasets === null
        ? [...TRADING_EXPORT_DATASETS]
        : normalizeDatasets(body.datasets);
      if (!datasets) throw invalidRequest();
      return { action: 'request', deviceIds: uuidList(body.deviceIds), from, to, datasets };
    }
    case 'cancel':
      return { action: 'cancel', requestIds: uuidList(body.requestIds) };
    case 'list':
      return { action: 'list', clientId: uuid(body.clientId) };
    case 'listAll': {
      const status = body.status === undefined || body.status === null ? null : body.status;
      if (status !== null && !TRADING_EXPORT_STATUSES.includes(status)) throw invalidRequest();
      return {
        action: 'listAll',
        limit: boundedInteger(body.limit, LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX),
        offset: boundedInteger(body.offset, 0, 0, OFFSET_MAX),
        status,
      };
    }
    case 'devices':
      return { action: 'devices' };
    default:
      return { action: body.action, requestId: uuid(body.requestId) };
  }
}

/**
 * Which listed devices the request function is asked about, and how many need
 * an agent update on the VPS first. Only an active, not revoked device counts
 * either way; the function checks that again, and that no export is open.
 */
export function splitTradingExportRequest(rows) {
  const sendable = [];
  let needsVps = 0;
  for (const row of rows) {
    if (row.status !== 'active' || row.revoked_at) continue;
    if (canSendTradingExport(row.agent_version)) sendable.push(row.id);
    else needsVps += 1;
  }
  return { sendable, needsVps };
}

function isPast(value, nowMs) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at <= nowMs;
}

/** What the screen is told about one export: never the storage path or the digest. */
export function publicTradingExport(row, clientNames, nowMs) {
  const lapsed = row.status === 'ready' && isPast(row.expires_at, nowMs);
  return {
    id: row.id,
    deviceId: row.device_id,
    clientId: row.client_id,
    clientName: clientNames.get(row.client_id) || '',
    requestedAt: row.requested_at || null,
    fromDate: row.from_date || null,
    toDate: row.to_date || null,
    datasets: Array.isArray(row.datasets) ? row.datasets : [],
    status: lapsed ? 'expired' : row.status,
    errorCode: row.error_code || null,
    byteSize: byteSizeOf(row.byte_size),
    rowCounts: row.row_counts && typeof row.row_counts === 'object' ? row.row_counts : null,
    coveredFrom: row.covered_from || null,
    coveredTo: row.covered_to || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Removes the file of every ready export past its expiry (of one client, or
 * of all), then marks them expired. Storage first: a failure in between
 * leaves a row that is still ready and is closed on the next pass, never an
 * object nothing points at. A failure here never fails the read that asked;
 * the rows still read as expired.
 */
export async function sweepExpired(store, { clientId = null, nowMs, report = () => {} }) {
  try {
    const due = await store.dueForExpiry({ clientId, nowIso: new Date(nowMs).toISOString(), limit: EXPIRY_SWEEP });
    if (!due.length) return [];
    await store.removeObjects(due.map((row) => row.storage_path).filter(Boolean));
    return await store.close({ requestIds: due.map((row) => row.id), actorId: null, reason: 'expired' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw error;
    report(error);
    return [];
  }
}

function reportFailure(error) {
  console.error(`[CRM] Trading export storage cleanup failed: ${String(error?.code || '')} ${String(error?.message || '')}`.trim());
}

async function listExports(store, rows, nowMs) {
  const names = await store.clientNames(rows.map((row) => row.client_id));
  return rows.map((row) => publicTradingExport(row, names, nowMs));
}

/** The Data lab's picker: each paired active device with its last ready export and any open one. */
export function summarizeDevices(devices, exports, names) {
  const lastReady = new Map();
  const open = new Map();
  for (const row of exports) {
    if (OPEN_TRADING_EXPORT_STATUSES.includes(row.status)) {
      if (!open.has(row.device_id)) open.set(row.device_id, row.status);
      continue;
    }
    if (!row.completed_at) continue;
    const current = lastReady.get(row.device_id);
    if (!current || Date.parse(row.completed_at) > Date.parse(current.completed_at)) lastReady.set(row.device_id, row);
  }
  return devices
    .map((device) => ({
      id: device.id,
      clientId: device.client_id,
      clientName: names.get(device.client_id) || '',
      agentVersion: device.agent_version || null,
      lastSeenAt: device.last_seen_at || null,
      eligible: canSendTradingExport(device.agent_version),
      lastReadyExportAt: lastReady.get(device.id)?.completed_at || null,
      lastReadyCoveredTo: lastReady.get(device.id)?.covered_to || null,
      openStatus: open.get(device.id) || null,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.id.localeCompare(b.id));
}

function safeError(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'trading_export_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createTradingExportAdminStore,
  now = () => new Date(),
  report = reportFailure,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST']);
      const { admin, auth } = createClients();
      const actor = await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const input = parseTradingExportBody(await readJsonBody(req, { maxBytes: 32 * 1024 }));
      const store = createStore(admin);
      const nowMs = now().getTime();
      res.setHeader('Cache-Control', 'private, no-store');

      if (input.action === 'request') {
        const rows = await store.loadDevices(input.deviceIds);
        const { sendable, needsVps } = splitTradingExportRequest(rows);
        const requested = sendable.length
          ? await store.request({ deviceIds: sendable, from: input.from, to: input.to, datasets: input.datasets, actorId: actor.id })
          : 0;
        return sendJson(res, 200, { ok: true, requested, skipped: input.deviceIds.length - requested, needsVps });
      }

      if (input.action === 'cancel') {
        const cancelled = await store.cancel({ requestIds: input.requestIds, actorId: actor.id });
        // An upload that had started may have landed; nobody will download it.
        const paths = cancelled.map((row) => row.path).filter(Boolean);
        if (paths.length) {
          try {
            await store.removeObjects(paths);
          } catch (error) {
            report(error);
          }
        }
        return sendJson(res, 200, { ok: true, cancelled: cancelled.length });
      }

      if (input.action === 'list') {
        await sweepExpired(store, { clientId: input.clientId, nowMs, report });
        const rows = await store.listForClient(input.clientId);
        return sendJson(res, 200, { ok: true, exports: await listExports(store, rows, nowMs) });
      }

      if (input.action === 'listAll') {
        await sweepExpired(store, { nowMs, report });
        const { rows, total } = await store.listAll(input);
        return sendJson(res, 200, {
          ok: true,
          exports: await listExports(store, rows, nowMs),
          total,
          limit: input.limit,
          offset: input.offset,
        });
      }

      if (input.action === 'devices') {
        const exports = await store.exportSummaries();
        const devices = await store.activeDevices();
        const names = await store.clientNames(devices.map((device) => device.client_id));
        return sendJson(res, 200, {
          ok: true,
          minimumAgentVersion: FIRST_SLIM_EXPORT_AGENT,
          devices: summarizeDevices(devices, exports, names),
        });
      }

      const row = await store.loadRequest(input.requestId);
      if (!row) throw new ApiError(404, 'export_not_found');
      if (row.status === 'ready' && isPast(row.expires_at, nowMs)) {
        await sweepExpired(store, { clientId: row.client_id, nowMs, report });
        throw new ApiError(410, 'export_expired');
      }
      if (row.status === 'expired') throw new ApiError(410, 'export_expired');
      if (row.status !== 'ready') throw new ApiError(409, 'export_not_ready');

      if (input.action === 'download') {
        const names = await store.clientNames([row.client_id]);
        const fileName = tradingExportFileName(publicTradingExport(row, names, nowMs));
        const url = await store.signDownload(row.storage_path, TRADING_EXPORT_DOWNLOAD_SECONDS, fileName);
        await store.auditDownload({
          actorId: actor.id,
          requestId: row.id,
          clientId: row.client_id,
          deviceId: row.device_id,
          byteSize: byteSizeOf(row.byte_size),
        });
        return sendJson(res, 200, {
          ok: true,
          url,
          fileName,
          expiresAt: new Date(nowMs + TRADING_EXPORT_DOWNLOAD_SECONDS * 1000).toISOString(),
        });
      }

      // delete: the object first, then the row, so a failure in between can be retried.
      await store.removeObjects([row.storage_path]);
      const closed = await store.close({ requestIds: [row.id], actorId: actor.id, reason: 'deleted' });
      return sendJson(res, 200, { ok: true, deleted: closed.length === 1 });
    } catch (error) {
      return handleApiError(res, safeError(error), {
        fallbackMessage: 'trading_export_failed',
        underlying: error instanceof ApiError ? null : error,
      });
    }
  };
}

export default createHandler();
