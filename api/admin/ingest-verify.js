import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNT_KEYS = ['accounts', 'strategies', 'orders', 'executions', 'flags'];
const COUNT_TABLES = {
  accounts: 'account_snapshots',
  strategies: 'strategy_snapshots',
  orders: 'orders',
  executions: 'executions',
  flags: 'operational_flags',
};
const TERMINAL_AUDIT_ACTIONS = [
  'ingest_batch_processed',
  'ingest_batch_late_closed_day',
  'ingest_batch_superseded',
  'ingest_batch_failed',
];

export function parseVerificationQuery(query = {}) {
  const value = query.batchId;
  if (value == null || Array.isArray(value) || typeof value === 'object') {
    throw new ApiError(400, 'invalid_batch_id');
  }
  const batchId = String(value).trim();
  if (!UUID.test(batchId)) throw new ApiError(400, 'invalid_batch_id');
  return { batchId: batchId.toLowerCase() };
}

function expectedCounts(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const result = {};
  for (const key of COUNT_KEYS) {
    const value = Number(summary[key]);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    result[key] = value;
  }
  return result;
}

export function assessIngestPersistence(evidence = {}) {
  const { batch, dailyImport } = evidence;
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, Number(evidence.normalizedCounts?.[key] || 0)]));
  const common = {
    counts,
    expectedCounts: null,
    duplicateClaimCount: Number(evidence.duplicateClaimCount || 0),
    terminalAuditCount: Number(evidence.terminalAuditCount || 0),
    downloadAuditCount: Number(evidence.downloadAuditCount || 0),
  };
  if (!dailyImport) return { ok: false, failures: ['daily_import_missing'], ...common };

  const expected = expectedCounts(dailyImport.sourceSummary);
  const failures = [];
  if (batch?.dailyImportId !== dailyImport.id) failures.push('batch_daily_link_mismatch');
  if (batch?.clientId !== dailyImport.clientId) failures.push('client_routing_mismatch');
  if (common.downloadAuditCount < 2) failures.push('download_audit_missing');
  if (common.duplicateClaimCount !== 1) failures.push('duplicate_capture_claim');
  if (!expected) failures.push('source_summary_invalid');
  else if (COUNT_KEYS.some((key) => counts[key] !== expected[key])) failures.push('normalized_count_mismatch');
  if (dailyImport.sourceBatchId !== batch?.id) failures.push('source_batch_mismatch');
  if (dailyImport.sourceType !== 'automatic') failures.push('source_type_mismatch');
  if (common.terminalAuditCount !== 1) failures.push('terminal_audit_mismatch');
  if (batch?.tradingDate !== dailyImport.tradingDate) failures.push('trading_date_mismatch');
  failures.sort();
  return { ok: failures.length === 0, failures, ...common, expectedCounts: expected };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    captureId: row.capture_id,
    deviceId: row.device_id,
    clientId: row.client_id,
    tradingDate: row.trading_date,
    dailyImportId: row.daily_import_id,
    status: row.status,
  };
}

function mapDailyImport(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    tradingDate: row.trading_date,
    sourceType: row.source_type,
    sourceBatchId: row.source_batch_id,
    sourceSummary: row.source_summary,
  };
}

async function maybeSingle(admin, table, columns, id) {
  const { data, error } = await admin.from(table).select(columns).eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function exactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid_exact_count');
  return count;
}

export function createVerificationStore(admin) {
  return {
    async verify(batchId) {
      const batch = mapBatch(await maybeSingle(
        admin,
        'ingest_batches',
        'id,capture_id,device_id,client_id,trading_date,daily_import_id,status',
        batchId,
      ));
      if (!batch) return null;

      const dailyImport = batch.dailyImportId
        ? mapDailyImport(await maybeSingle(
          admin,
          'daily_imports',
          'id,client_id,trading_date,source_type,source_batch_id,source_summary',
          batch.dailyImportId,
        ))
        : null;
      if (!dailyImport) {
        return {
          batch,
          dailyImport: null,
          normalizedCounts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
          duplicateClaimCount: 0,
          terminalAuditCount: 0,
          downloadAuditCount: 0,
        };
      }

      const countEntries = await Promise.all(COUNT_KEYS.map(async (key) => {
        const count = await exactCount(admin.from(COUNT_TABLES[key])
          .select('id', { count: 'exact', head: true })
          .eq('daily_import_id', dailyImport.id));
        return [key, count];
      }));
      const [duplicateClaimCount, terminalAuditCount, downloadAuditCount] = await Promise.all([
        exactCount(admin.from('ingest_batches')
          .select('id', { count: 'exact', head: true })
          .eq('device_id', batch.deviceId)
          .eq('capture_id', batch.captureId)),
        exactCount(admin.from('audit_logs')
          .select('id', { count: 'exact', head: true })
          .eq('entity_type', 'ingest_batch')
          .eq('entity_id', batch.id)
          .in('action', TERMINAL_AUDIT_ACTIONS)),
        exactCount(admin.from('audit_logs')
          .select('id', { count: 'exact', head: true })
          .eq('entity_type', 'ingest_batch')
          .eq('entity_id', batch.id)
          .eq('action', 'ingest_batch_downloaded')),
      ]);
      return {
        batch,
        dailyImport,
        normalizedCounts: Object.fromEntries(countEntries),
        duplicateClaimCount,
        terminalAuditCount,
        downloadAuditCount,
      };
    },
  };
}

function safeError(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'ingest_verification_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createVerificationStore,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      const { admin, auth } = createClients();
      await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const { batchId } = parseVerificationQuery(req.query || {});
      const evidence = await createStore(admin).verify(batchId);
      if (!evidence) throw new ApiError(404, 'batch_not_found');
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, assessIngestPersistence(evidence));
    } catch (error) {
      return handleApiError(res, safeError(error), { fallbackMessage: 'ingest_verification_failed' });
    }
  };
}

export default createHandler();
