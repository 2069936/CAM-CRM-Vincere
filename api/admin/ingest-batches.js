import { Buffer } from 'node:buffer';
import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['received', 'processing', 'processed', 'incomplete', 'late_closed_day', 'failed', 'replaced']);
const SAFE_ERROR_CODES = new Set([
  'storage_failed', 'normalization_failed', 'registry_load_failed',
  'reconciliation_failed', 'persistence_failed', 'ingest_failed',
  'immutable_object_conflict', 'unsupported_schema_version',
  'invalid_auto_import_snapshot',
]);
const SAFE_SELECT = [
  'id', 'capture_id', 'device_id', 'client_id', 'trading_date', 'captured_at',
  'received_at', 'processed_at', 'status', 'schema_version', 'byte_count',
  'row_counts', 'completeness', 'daily_import_id', 'replaces_batch_id', 'error_code',
].join(',');

function scalar(value, field) {
  if (value == null || value === '') return null;
  if (Array.isArray(value) || typeof value === 'object') throw new ApiError(400, `invalid_${field}`);
  return String(value).trim();
}

function uuid(value, field) {
  const normalized = scalar(value, field);
  if (normalized === null) return null;
  if (!UUID.test(normalized)) throw new ApiError(400, `invalid_${field}`);
  return normalized.toLowerCase();
}

function validDate(value) {
  if (!DATE.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateFilter(value, field) {
  const normalized = scalar(value, field);
  if (normalized === null) return null;
  if (!validDate(normalized)) throw new ApiError(400, `invalid_${field}`);
  return normalized;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function encodeBatchCursor({ receivedAt, id }) {
  const timestamp = canonicalTimestamp(receivedAt);
  if (!timestamp || !UUID.test(id || '')) throw new ApiError(500, 'batch_history_failed');
  return Buffer.from(JSON.stringify({ receivedAt: timestamp, id: id.toLowerCase() }), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  const cursor = scalar(value, 'cursor');
  if (cursor === null) return null;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ApiError(400, 'invalid_cursor');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'id,receivedAt'
      || !UUID.test(parsed.id || '')) throw new Error('invalid');
    const receivedAt = canonicalTimestamp(parsed.receivedAt);
    if (!receivedAt) throw new Error('invalid');
    return { receivedAt, id: parsed.id.toLowerCase() };
  } catch {
    throw new ApiError(400, 'invalid_cursor');
  }
}

export function parseBatchFilters(query = {}) {
  const pageSizeRaw = scalar(query.pageSize, 'page_size');
  const limit = pageSizeRaw === null ? 50 : Number(pageSizeRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_page_size');
  const status = scalar(query.status, 'status');
  if (status !== null && !STATUSES.has(status)) throw new ApiError(400, 'invalid_status');
  const from = dateFilter(query.from, 'from');
  const to = dateFilter(query.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'invalid_date_range');
  return {
    clientUuid: uuid(query.clientUuid, 'client_uuid'),
    deviceId: uuid(query.deviceId, 'device_id'),
    captureId: uuid(query.captureId, 'capture_id'),
    status,
    from,
    to,
    limit,
    cursor: decodeCursor(query.cursor),
  };
}

export function createBatchHistoryStore(admin) {
  return {
    async list(filters) {
      let query = admin.from('ingest_batches').select(SAFE_SELECT);
      if (filters.clientUuid) query = query.eq('client_id', filters.clientUuid);
      if (filters.deviceId) query = query.eq('device_id', filters.deviceId);
      if (filters.captureId) query = query.eq('capture_id', filters.captureId);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.from) query = query.gte('trading_date', filters.from);
      if (filters.to) query = query.lte('trading_date', filters.to);
      if (filters.cursor) {
        query = query.or(`received_at.lt.${filters.cursor.receivedAt},and(received_at.eq.${filters.cursor.receivedAt},id.lt.${filters.cursor.id})`);
      }
      query = query.order('received_at', { ascending: false }).order('id', { ascending: false });
      const { data, error } = await query.limit(filters.limit + 1);
      if (error) throw error;
      return data || [];
    },
  };
}

function publicBatch(row = {}) {
  return {
    id: row.id,
    captureId: row.capture_id,
    clientUuid: row.client_id,
    deviceId: row.device_id,
    tradingDate: row.trading_date,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at || null,
    status: row.status,
    schemaVersion: row.schema_version,
    byteCount: row.byte_count,
    rowCounts: row.row_counts || {},
    completeness: row.completeness || {},
    dailyImportId: row.daily_import_id || null,
    replacesBatchId: row.replaces_batch_id || null,
    errorCode: SAFE_ERROR_CODES.has(row.error_code) ? row.error_code : null,
  };
}

function safeError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'batch_history_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createBatchHistoryStore,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      const { admin, auth } = createClients();
      await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const filters = parseBatchFilters(req.query || {});
      const rows = await createStore(admin).list(filters);
      const page = rows.slice(0, filters.limit);
      const nextCursor = rows.length > filters.limit
        ? encodeBatchCursor({ receivedAt: page.at(-1)?.received_at, id: page.at(-1)?.id })
        : null;
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, { batches: page.map(publicBatch), nextCursor });
    } catch (error) {
      return handleApiError(res, safeError(error), { fallbackMessage: 'batch_history_failed' });
    }
  };
}

export default createHandler();
