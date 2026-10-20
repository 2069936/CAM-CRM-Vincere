import { ApiError } from './http.js';

/* WHERE THE SLIM TRADING EXPORTS LIVE (step 72), for the agent's three routes
 * and the Manager's one.
 *
 * The state machine is step 72's six functions, called here and nowhere else;
 * the bytes are in the private bucket trading-exports and never pass through
 * Vercel: the agent PUTs them to a signed upload URL, the Manager GETs them
 * from a signed download URL, and this file only signs, inspects and removes.
 * Every storage call is the service role's, which step 72's restrictive
 * storage policy does not apply to. */

export const TRADING_EXPORT_BUCKET = 'trading-exports';

/** Supabase fixes a signed upload URL's life at two hours; the agent is told when it ends. */
export const SIGNED_UPLOAD_SECONDS = 2 * 60 * 60;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_PATH = new RegExp(`^deep-exports/${UUID}/${UUID}\\.jsonl\\.gz$`);
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isTradingExportPath(value) {
  return typeof value === 'string' && STORAGE_PATH.test(value);
}

function errorText(error) {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
}

/* NOT DEPLOYED YET IS AN ANSWER, NOT A FAULT, the agent update route's rule.
 * Before step 72 runs the functions and the table are missing, and every
 * caller is told what a CRM without these routes would tell it. */
export function isTradingExportNotDeployed(error) {
  const code = String(error?.code || '');
  if (['PGRST202', 'PGRST205', '42883', '42P01', '42703'].includes(code)) return true;
  const text = errorText(error).toLowerCase();
  return /could not find the (function|table)|function .* does not exist|relation .* does not exist|column .* does not exist/.test(text);
}

/** The refusals step 72's functions raise, as the answers the routes give. */
export function tradingExportRpcError(error) {
  const source = errorText(error).toUpperCase();
  if (source.includes('INVALID_TRADING_EXPORT_REQUEST')) return new ApiError(400, 'invalid_request');
  if (source.includes('INVALID_INGEST_DEVICE')) return new ApiError(401, 'invalid_device_credential');
  if (source.includes('TRADING_EXPORT_NOT_FOUND')) return new ApiError(404, 'export_request_not_found');
  if (source.includes('TRADING_EXPORT_CLOSED')) return new ApiError(409, 'export_request_closed');
  if (source.includes('TRADING_EXPORT_MISMATCH')) return new ApiError(409, 'export_mismatch');
  return null;
}

/** A storage answer that means "there is no such object". */
export function isStorageObjectMissing(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.originalError?.status);
  if (status === 404) return true;
  const text = `${error?.message || ''} ${error?.error || ''}`.toLowerCase();
  return text.includes('not found') || text.includes('not_found');
}

function unwrapRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function dateOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new Error(`Trading export RPC returned an invalid ${label}.`);
  return value;
}

/** A row's byte_size, which PostgREST returns as a number or, for a bigint, sometimes a string. */
export function byteSizeOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

async function removeFromBucket(admin, paths) {
  if (!paths.length) return;
  const { error } = await admin.storage.from(TRADING_EXPORT_BUCKET).remove(paths);
  if (error) throw error;
}

/* ------------------------------------------------------------------------- *
 * The agent's side.
 * ------------------------------------------------------------------------- */

export function createTradingExportDeviceStore(admin) {
  function rpcFailure(error) {
    if (isTradingExportNotDeployed(error)) return new ApiError(404, 'not_found');
    return tradingExportRpcError(error) || error;
  }

  return {
    /** The open request this device should work on, or null (step 72's claim). */
    async claim({ deviceId, agentVersion }) {
      const { data, error } = await admin.rpc('claim_trading_export', {
        p_device_id: deviceId,
        p_agent_version: agentVersion,
      });
      if (error) throw rpcFailure(error);
      const row = unwrapRow(data);
      if (!row?.request_id) return null;
      const datasets = Array.isArray(row.export_datasets) ? row.export_datasets : null;
      if (!datasets?.length) throw new Error('Trading export RPC returned no datasets.');
      return {
        id: String(row.request_id).toLowerCase(),
        from: dateOrNull(row.export_from, 'from date'),
        to: dateOrNull(row.export_to, 'to date'),
        datasets,
      };
    },

    /** Marks the request uploading and returns its storage path. */
    async beginUpload({ deviceId, requestId, sha256, byteSize }) {
      const { data, error } = await admin.rpc('begin_trading_export_upload', {
        p_device_id: deviceId,
        p_request_id: requestId,
        p_sha256: sha256,
        p_byte_size: byteSize,
      });
      if (error) throw rpcFailure(error);
      const path = typeof data === 'string' ? data : unwrapRow(data)?.begin_trading_export_upload;
      if (!isTradingExportPath(path)) throw new Error('Trading export RPC returned an invalid storage path.');
      return path;
    },

    /** This device's own request, or null: the device id is part of the filter. */
    async loadForDevice(deviceId, requestId) {
      const { data, error } = await admin
        .from('trading_export_requests')
        .select('id,device_id,client_id,status,storage_path,byte_size,sha256,error_code')
        .eq('id', requestId)
        .eq('device_id', deviceId)
        .maybeSingle();
      if (error) throw rpcFailure(error);
      return data || null;
    },

    async complete({ deviceId, requestId, status, sha256, byteSize, rowCounts, from, to, errorCode }) {
      const { data, error } = await admin.rpc('complete_trading_export', {
        p_device_id: deviceId,
        p_request_id: requestId,
        p_status: status,
        p_sha256: sha256,
        p_byte_size: byteSize,
        p_row_counts: rowCounts,
        p_covered_from: from,
        p_covered_to: to,
        p_error_code: errorCode,
      });
      if (error) throw rpcFailure(error);
      const result = typeof data === 'string' ? data : unwrapRow(data)?.complete_trading_export;
      if (result !== 'ready' && result !== 'failed') throw new Error('Trading export RPC returned no status.');
      return result;
    },

    /** A signed URL the agent PUTs the gzip to. Upsert, so a retried upload replaces a partial one. */
    async signUpload(path) {
      const { data, error } = await admin.storage.from(TRADING_EXPORT_BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data?.signedUrl) throw error || new Error('Storage returned no signed upload URL.');
      return data.signedUrl;
    },

    /**
     * What storage holds at the path: its size, and a SHA-256 only when the
     * object's own metadata carries one (Supabase records an MD5 etag, not a
     * SHA-256, so normally it does not and the agent's digest is what is kept).
     * Null when there is no object.
     */
    async objectInfo(path) {
      const { data, error } = await admin.storage.from(TRADING_EXPORT_BUCKET).info(path);
      if (error) {
        if (isStorageObjectMissing(error)) return null;
        throw error;
      }
      if (!data) return null;
      const size = byteSizeOf(data.size ?? data.metadata?.size ?? data.metadata?.contentLength);
      const declared = String(data.metadata?.sha256 || '').toLowerCase();
      return { size, sha256: SHA256.test(declared) ? declared : null };
    },

    async removeObjects(paths) {
      return removeFromBucket(admin, paths);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * The Manager's side.
 * ------------------------------------------------------------------------- */

const EXPORT_COLUMNS = [
  'id', 'device_id', 'client_id', 'requested_by', 'requested_at', 'from_date', 'to_date',
  'datasets', 'status', 'error_code', 'storage_path', 'byte_size', 'sha256', 'row_counts',
  'covered_from', 'covered_to', 'started_at', 'completed_at', 'expires_at', 'updated_at',
].join(',');

async function loadPaged(buildQuery) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

export function createTradingExportAdminStore(admin) {
  function rpcFailure(error) {
    if (isTradingExportNotDeployed(error)) return new ApiError(404, 'trading_export_unavailable');
    return tradingExportRpcError(error) || error;
  }

  function table() {
    return admin.from('trading_export_requests');
  }

  return {
    async loadDevices(deviceIds) {
      const { data, error } = await admin
        .from('ingest_devices')
        .select('id,client_id,status,revoked_at,agent_version')
        .in('id', deviceIds);
      if (error) throw error;
      return data || [];
    },

    async request({ deviceIds, from, to, datasets, actorId }) {
      const { data, error } = await admin.rpc('request_trading_exports', {
        p_device_ids: deviceIds,
        p_from: from,
        p_to: to,
        p_datasets: datasets,
        p_actor: actorId,
      });
      if (error) throw rpcFailure(error);
      const value = unwrapRow(data);
      const count = typeof value === 'object' && value !== null ? Object.values(value)[0] : value;
      if (!Number.isInteger(count) || count < 0) throw new Error('Trading export RPC returned no count.');
      return count;
    },

    /** The requests it cancelled, each with the path an upload may have reached. */
    async cancel({ requestIds, actorId }) {
      const { data, error } = await admin.rpc('cancel_trading_exports', {
        p_request_ids: requestIds,
        p_actor: actorId,
      });
      if (error) throw rpcFailure(error);
      return (data || []).map((row) => ({ id: row.request_id, path: row.object_path || null }));
    },

    /** Marks ready requests expired: 'expired' only once past expires_at, 'deleted' at once. */
    async close({ requestIds, actorId, reason }) {
      const { data, error } = await admin.rpc('close_trading_exports', {
        p_request_ids: requestIds,
        p_actor: actorId,
        p_reason: reason,
      });
      if (error) throw rpcFailure(error);
      return (data || []).map((row) => row.request_id);
    },

    async listForClient(clientId) {
      const { data, error } = await table()
        .select(EXPORT_COLUMNS)
        .eq('client_id', clientId)
        .order('requested_at', { ascending: false })
        .limit(500);
      if (error) throw rpcFailure(error);
      return data || [];
    },

    async listAll({ limit, offset, status }) {
      let query = table()
        .select(EXPORT_COLUMNS, { count: 'exact' })
        .order('requested_at', { ascending: false })
        .order('id', { ascending: false });
      if (status) query = query.eq('status', status);
      const { data, error, count } = await query.range(offset, offset + limit - 1);
      if (error) throw rpcFailure(error);
      return { rows: data || [], total: Number.isInteger(count) ? count : (data || []).length };
    },

    async loadRequest(requestId) {
      const { data, error } = await table()
        .select(EXPORT_COLUMNS)
        .eq('id', requestId)
        .maybeSingle();
      if (error) throw rpcFailure(error);
      return data || null;
    },

    /** Ready exports past their expiry, of one client or of every client, oldest first. */
    async dueForExpiry({ clientId = null, nowIso, limit = 100 }) {
      let query = table()
        .select('id,storage_path')
        .eq('status', 'ready')
        .lte('expires_at', nowIso);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.order('expires_at', { ascending: true }).limit(limit);
      if (error) throw rpcFailure(error);
      return data || [];
    },

    /** Every paired, active, not revoked device: the Data lab's list. */
    async activeDevices() {
      return loadPaged(() => admin
        .from('ingest_devices')
        .select('id,client_id,agent_version,last_seen_at')
        .eq('status', 'active')
        .is('revoked_at', null)
        .order('id', { ascending: true }));
    },

    /** What the Data lab needs of each device's exports: the last ready one and the open one. */
    async exportSummaries() {
      try {
        return await loadPaged(() => table()
          .select('device_id,status,completed_at,covered_to,requested_at')
          .in('status', ['requested', 'building', 'uploading', 'ready', 'expired'])
          .order('requested_at', { ascending: false })
          .order('id', { ascending: false }));
      } catch (error) {
        throw rpcFailure(error);
      }
    },

    async clientNames(clientIds) {
      const names = new Map();
      const ids = [...new Set(clientIds.filter(Boolean))];
      for (let from = 0; from < ids.length; from += 200) {
        const { data, error } = await admin.from('clients').select('id,name').in('id', ids.slice(from, from + 200));
        if (error) throw error;
        for (const row of data || []) names.set(row.id, row.name || '');
      }
      return names;
    },

    /** A signed GET that saves the file under fileName. A missing object is an expired export. */
    async signDownload(path, seconds, fileName) {
      const { data, error } = await admin.storage.from(TRADING_EXPORT_BUCKET)
        .createSignedUrl(path, seconds, { download: fileName });
      if (error) {
        if (isStorageObjectMissing(error)) throw new ApiError(410, 'export_expired');
        throw error;
      }
      if (!data?.signedUrl) throw new Error('Storage returned no signed URL.');
      return data.signedUrl;
    },

    async removeObjects(paths) {
      return removeFromBucket(admin, paths);
    },

    async auditDownload({ actorId, requestId, clientId, deviceId, byteSize }) {
      const { error } = await admin.from('audit_logs').insert({
        user_id: actorId,
        entity_type: 'trading_export',
        entity_id: requestId,
        action: 'trading_export.downloaded',
        after_data: { clientId, deviceId, byteSize },
      });
      if (error) throw error;
    },
  };
}
