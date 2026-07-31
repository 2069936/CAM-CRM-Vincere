import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import {
  AUTO_IMPORT_BUCKET,
  DEFAULT_MAX_COMPRESSED_BYTES,
} from '../_lib/autoImportStore.js';
import {
  buildSnapshotZip,
  deterministicDownloadName,
  validateStoredSnapshotMetadata,
  verifyStoredSnapshot,
} from '../_lib/autoExportDownload.js';
import { deriveAutoExportLimits, resolveAutoCollectionLimits } from '../_lib/autoCollectionLimits.js';
import { ApiError, handleApiError, requireMethod } from '../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_SELECT = [
  'id', 'capture_id', 'device_id', 'client_id', 'trading_date', 'captured_at',
  'received_at', 'processed_at', 'status', 'schema_version', 'storage_path',
  'content_sha256', 'byte_count', 'row_counts', 'completeness',
  'daily_import_id', 'replaces_batch_id', 'error_code',
].join(',');

function scalar(value, error) {
  if (value == null || Array.isArray(value) || typeof value === 'object') throw new ApiError(400, error);
  return String(value).trim();
}

function parseDownloadQuery(query = {}) {
  const batchId = scalar(query.batchId, 'invalid_batch_id');
  if (!UUID.test(batchId)) throw new ApiError(400, 'invalid_batch_id');
  const format = scalar(query.format, 'invalid_download_format').toLowerCase();
  if (!['json', 'zip'].includes(format)) throw new ApiError(400, 'invalid_download_format');
  return { batchId: batchId.toLowerCase(), format };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    captureId: row.capture_id,
    deviceId: row.device_id,
    clientId: row.client_id,
    tradingDate: row.trading_date,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at || null,
    status: row.status,
    schemaVersion: row.schema_version,
    storagePath: row.storage_path,
    contentSha256: row.content_sha256,
    byteCount: Number(row.byte_count),
    rowCounts: row.row_counts,
    completeness: row.completeness,
    dailyImportId: row.daily_import_id || null,
    replacesBatchId: row.replaces_batch_id || null,
    errorCode: row.error_code || null,
  };
}

function isMissing(error) {
  const status = Number(error?.statusCode || error?.status);
  const detail = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return status === 404 || detail.includes('not found') || detail.includes('not_found');
}

export async function storageObjectBytes(value, { maxBytes = DEFAULT_MAX_COMPRESSED_BYTES } = {}) {
  // Vercel amendment: private objects are intentionally buffered only under
  // the shared hard cap so every byte/hash can be verified before any response
  // is emitted. Revisit streaming only if measured staging limits require it.
  if (Buffer.isBuffer(value)) {
    if (value.length === 0 || value.length > maxBytes) throw new ApiError(409, 'stored_snapshot_corrupt');
    return value;
  }
  const declaredSize = Number(value?.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > maxBytes
    || typeof value?.arrayBuffer !== 'function') {
    throw new ApiError(409, 'stored_snapshot_corrupt');
  }
  const bytes = Buffer.from(await value.arrayBuffer());
  if (bytes.length !== declaredSize) throw new ApiError(409, 'stored_snapshot_corrupt');
  return bytes;
}

export function createDownloadStore(admin, { maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES } = {}) {
  return {
    async getBatch(batchId) {
      const { data, error } = await admin.from('ingest_batches')
        .select(DOWNLOAD_SELECT)
        .eq('id', batchId)
        .maybeSingle();
      if (error) throw error;
      return mapBatch(data);
    },

    async downloadObject(path) {
      const { data, error } = await admin.storage.from(AUTO_IMPORT_BUCKET).download(path);
      if (error) {
        if (isMissing(error)) throw new ApiError(404, 'stored_snapshot_missing');
        throw new ApiError(503, 'stored_snapshot_unavailable');
      }
      return storageObjectBytes(data, { maxBytes: maxCompressedBytes });
    },

    async auditDownload({ actorId, batchId, clientId, deviceId, tradingDate, status, format }) {
      const { error } = await admin.from('audit_logs').insert({
        user_id: actorId,
        entity_type: 'ingest_batch',
        entity_id: batchId,
        action: 'ingest_batch_downloaded',
        after_data: { batchId, clientId, deviceId, tradingDate, status, format },
      });
      if (error) throw error;
    },
  };
}

function safeError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'batch_download_failed');
}

function sendDownload(res, { bytes, contentType, filename }) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(bytes.length));
  return res.status(200).send(bytes);
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createDownloadStore,
  env = process.env,
  maxCompressedBytes = resolveAutoCollectionLimits(env).maxCompressedBytes,
  maxUncompressedBytes = resolveAutoCollectionLimits(env).maxUncompressedBytes,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      const { admin, auth } = createClients();
      const actor = await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const { batchId, format } = parseDownloadQuery(req.query || {});
      const store = createStore(admin, { maxCompressedBytes });
      const batch = await store.getBatch(batchId);
      if (!batch) throw new ApiError(404, 'batch_not_found');
      const storagePath = validateStoredSnapshotMetadata(batch, { maxUncompressedBytes });
      const compressed = await store.downloadObject(storagePath);
      const verified = verifyStoredSnapshot({ batch, compressed, maxCompressedBytes, maxUncompressedBytes });
      const bytes = format === 'json'
        ? verified.jsonBytes
        : buildSnapshotZip({ batch, ...verified, ...deriveAutoExportLimits(maxUncompressedBytes) });
      await store.auditDownload({
        actorId: actor.id,
        batchId: batch.id,
        clientId: batch.clientId,
        deviceId: batch.deviceId,
        tradingDate: batch.tradingDate,
        status: batch.status,
        format,
      });
      return sendDownload(res, {
        bytes,
        filename: deterministicDownloadName(batch, format),
        contentType: format === 'json' ? 'application/json; charset=utf-8' : 'application/zip',
      });
    } catch (error) {
      return handleApiError(res, safeError(error), { fallbackMessage: 'batch_download_failed' });
    }
  };
}

export default createHandler();
