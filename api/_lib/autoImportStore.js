import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiError } from './http.js';

export const DEFAULT_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
export const AUTO_IMPORT_BUCKET = 'ninjatrader-imports';

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function canonicalSnapshotPayload(snapshot) {
  const utf8 = Buffer.from(stableJson(snapshot), 'utf8');
  return {
    utf8,
    gzip: gzipSync(utf8),
    sha256: createHash('sha256').update(utf8).digest('hex'),
  };
}

async function readRawBody(req, maxBytes) {
  const contentLength = String(req?.headers?.['content-length'] || '').trim();
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new ApiError(413, 'compressed_payload_too_large');
  }
  if (Buffer.isBuffer(req?.body)) {
    if (req.body.length > maxBytes) throw new ApiError(413, 'compressed_payload_too_large');
    return req.body;
  }
  if (typeof req?.body === 'string') {
    const bytes = Buffer.from(req.body, 'binary');
    if (bytes.length > maxBytes) throw new ApiError(413, 'compressed_payload_too_large');
    return bytes;
  }
  if (req?.body !== undefined && req?.body !== null) {
    throw new ApiError(400, 'raw_gzip_body_required');
  }
  if (!req || !(Symbol.asyncIterator in Object(req))) {
    throw new ApiError(400, 'raw_gzip_body_required');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new ApiError(413, 'compressed_payload_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function decodeSnapshotRequest(req, {
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
} = {}) {
  if (String(req?.headers?.['content-encoding'] || '').toLowerCase() !== 'gzip') {
    throw new ApiError(415, 'gzip_content_encoding_required');
  }
  const compressed = await readRawBody(req, maxCompressedBytes);
  let uncompressed;
  try {
    uncompressed = gunzipSync(compressed, { maxOutputLength: maxUncompressedBytes });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ApiError(413, 'uncompressed_payload_too_large');
    }
    throw new ApiError(400, 'invalid_gzip_payload');
  }
  if (uncompressed.length > maxUncompressedBytes) {
    throw new ApiError(413, 'uncompressed_payload_too_large');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(uncompressed.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_snapshot_json');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ApiError(400, 'invalid_snapshot_json');
  }
  return { snapshot, ...canonicalSnapshotPayload(snapshot) };
}

function rpcValue(data) {
  return Array.isArray(data) ? data[0] : data;
}

function batchFromRow(row = {}) {
  return {
    id: row.id,
    dailyImportId: row.daily_import_id || null,
    status: row.status,
  };
}

function registryFromRows(rows = []) {
  return Object.fromEntries(rows.map((row) => [row.account_name, {
    accountName: row.account_name,
    alias: row.alias,
    connection: row.connection,
    accountType: row.account_type,
    status: row.status,
    payoutState: row.payout_state,
    startBalance: row.start_balance,
    targetProfit: row.target_profit,
    maxDrawdownLimit: row.max_drawdown_limit,
    riskLevel: row.risk_level,
    bulletBotPassType: row.bullet_bot_pass_type,
    bulletBotDirection: row.bullet_bot_direction,
    algoStack: row.algo_stack,
    dailyLossLimit: row.daily_loss_limit,
    notes: row.notes,
    dateAdded: row.date_added,
    dateFunded: row.date_funded,
    dateFailed: row.date_failed,
    dateLastPayout: row.date_last_payout,
    payoutCount: row.payout_count,
  }]));
}

export function createAutoImportStore(admin) {
  return {
    async claimBatch(payload) {
      const { data, error } = await admin.rpc('claim_ingest_batch_v2', {
        p_device_id: payload.deviceId,
        p_capture_id: payload.captureId,
        p_trading_date: payload.tradingDate,
        p_captured_at: payload.capturedAt,
        p_schema_version: payload.schemaVersion,
        p_storage_path: payload.storagePath,
        p_content_sha256: payload.sha256,
        p_byte_count: payload.byteCount,
        p_row_counts: payload.rowCounts,
      });
      if (error) throw error;
      const result = rpcValue(data);
      if (!result || typeof result.claimed !== 'boolean' || !result.batch?.id) {
        throw new Error('Batch claim RPC returned no result.');
      }
      return {
        claimed: result.claimed,
        duplicate: !result.claimed,
        batch: batchFromRow(result.batch),
      };
    },

    async storeRaw(path, gzip) {
      const { error } = await admin.storage.from(AUTO_IMPORT_BUCKET).upload(path, gzip, {
        contentType: 'application/gzip',
        cacheControl: '31536000',
        upsert: false,
      });
      if (error) throw error;
    },

    async loadRegistry(clientUuid) {
      const { data, error } = await admin.from('trading_accounts').select('*').eq('client_id', clientUuid);
      if (error) throw error;
      return registryFromRows(data || []);
    },

    createPersistenceAdapter() {
      return {
        isAtomic: true,
        supportsDailyImportSourceColumns: true,
        async persistDailyImportAtomic({ clientUuid, importResult, sourceBatchId }) {
          const { data, error } = await admin.rpc('persist_auto_daily_import', {
            p_client_id: clientUuid,
            p_source_batch_id: sourceBatchId,
            p_import_result: importResult,
          });
          if (error) {
            const detail = `${error.code || ''} ${error.message || ''}`.toLowerCase();
            if (detail.includes('daily_import_closed')) {
              const closed = new Error('Daily import is closed.');
              closed.name = 'DailyImportClosedError';
              closed.code = 'daily_import_closed';
              closed.dailyImportId = error.details || null;
              throw closed;
            }
            throw error;
          }
          const row = rpcValue(data);
          if (!row?.id) throw new Error('Daily import RPC returned no result.');
          return row;
        },
      };
    },

    async completeBatch(payload) {
      const { data, error } = await admin.rpc('finalize_ingest_batch', {
        p_batch_id: payload.batchId,
        p_device_id: payload.deviceId,
        p_status: payload.status,
        p_daily_import_id: payload.dailyImportId || null,
        p_captured_at: payload.capturedAt,
        p_success: payload.success,
        p_error_code: payload.errorCode || null,
        p_completeness: payload.completeness || {},
        p_row_counts: payload.rowCounts || {},
        p_event_type: payload.eventType,
      });
      if (error) throw error;
      const row = rpcValue(data);
      if (!row?.id) throw new Error('Batch finalization RPC returned no result.');
      return batchFromRow(row);
    },
  };
}
