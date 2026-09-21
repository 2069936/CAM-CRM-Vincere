import process from 'node:process';
import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../../apiLib/http.js';
import { classifyFleetRow, newYorkTradingClock, summarizeFleet, summarizeIngestDay, summarizeQuarantine } from '../../../src/domain/autoCollectionFleet.js';

const DEVICE_COLUMNS = 'id,client_id,status,health_status,schedule_time,schedule_timezone,agent_version,addon_version,ninjatrader_version,last_seen_at,last_capture_at,last_success_at,last_error_code,revoked_at,created_at';
const BATCH_COLUMNS = 'id,capture_id,client_id,device_id,trading_date,captured_at,received_at,processed_at,status,row_counts,completeness,daily_import_id,replaces_batch_id,error_code';
/* THE TWO COLUMNS STEP 45 ADDS, ASKED FOR SEPARATELY SO THEIR ABSENCE IS NOT
 * THIS SCREEN'S PROBLEM. PostgREST answers a select naming a column that does
 * not exist with an error, not with nulls, so asking for them unconditionally
 * would turn "the migration has not run yet" into a fleet view that shows the
 * manager nothing at all. The day line disappears instead. */
const BATCH_TIMING_COLUMNS = `${BATCH_COLUMNS},ingest_duration_ms,admission_deferrals,stage_durations_ms`;

function isMissingColumn(error) {
  if (String(error?.code || '') === '42703') return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('column') && message.includes('does not exist');
}
/* THE TABLE STEP 46 ADDS, ASKED FOR ON ITS OWN SO ITS ABSENCE IS NOT THIS
 * SCREEN'S PROBLEM EITHER. Same shape as the timing columns above: a fleet
 * view on a database that has not run the migration shows every row it showed
 * before and no quarantine anywhere, rather than nothing at all. */
const QUARANTINE_COLUMNS = 'id,device_id,client_id,capture_id,trading_date,code,attempts,quarantined_at,last_attempt_at,reported_at,final';
const QUARANTINE_BATCH_COLUMNS = 'id,capture_id,device_id,status,error_code';

function isMissingRelation(error) {
  if (String(error?.code || '') === '42P01') return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
}
const SAFE_DEVICE_ERRORS = new Set(['ninjatrader_not_running', 'addon_unavailable', 'capture_timeout', 'capture_failed', 'contract_mismatch', 'queue_capacity_warning', 'upload_failed', 'configuration_error', 'ingest_at_capacity']);
const SAFE_BATCH_ERRORS = new Set(['storage_failed', 'normalization_failed', 'registry_load_failed', 'reconciliation_failed', 'persistence_failed', 'ingest_failed', 'immutable_object_conflict', 'unsupported_schema_version', 'invalid_auto_import_snapshot']);

export function parseFleetQuery(query = {}) {
  const page = query.page == null || query.page === '' ? 1 : Number(query.page);
  const pageSize = query.pageSize == null || query.pageSize === '' ? 25 : Number(query.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new ApiError(400, 'invalid_page');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError(400, 'invalid_page_size');
  if (Array.isArray(query.search) || typeof query.search === 'object') throw new ApiError(400, 'invalid_search');
  const search = String(query.search || '').trim();
  if (search.length > 100) throw new ApiError(400, 'invalid_search');
  return { page, pageSize, search };
}

async function loadAll(admin, table, columns, decorate = (query) => query) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = admin.from(table).select(columns);
    query = decorate(query).range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

function firstByClient(rows) {
  const result = new Map();
  for (const row of rows) if (!result.has(row.client_id)) result.set(row.client_id, row);
  return result;
}

function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, healthStatus: row.health_status,
    schedule: { time: row.schedule_time, timezone: row.schedule_timezone },
    agentVersion: row.agent_version || null, addonVersion: row.addon_version || null,
    ninjaTraderVersion: row.ninjatrader_version || null, lastSeenAt: row.last_seen_at || null,
    lastCaptureAt: row.last_capture_at || null, lastSuccessAt: row.last_success_at || null,
    lastErrorCode: SAFE_DEVICE_ERRORS.has(row.last_error_code) ? row.last_error_code : row.last_error_code ? 'collector_error' : null,
    revokedAt: row.revoked_at || null,
  };
}

function publicBatch(row) {
  if (!row) return null;
  return {
    id: row.id, captureId: row.capture_id, deviceId: row.device_id,
    tradingDate: row.trading_date, capturedAt: row.captured_at, receivedAt: row.received_at,
    processedAt: row.processed_at || null, status: row.status, rowCounts: row.row_counts || {},
    completeness: row.completeness || {}, dailyImportId: row.daily_import_id || null,
    replacesBatchId: row.replaces_batch_id || null,
    errorCode: SAFE_BATCH_ERRORS.has(row.error_code) ? row.error_code : row.error_code ? 'ingest_failed' : null,
    ingestDurationMs: Number.isInteger(row.ingest_duration_ms) ? row.ingest_duration_ms : null,
    stageDurationsMs: row.stage_durations_ms && typeof row.stage_durations_ms === 'object' && !Array.isArray(row.stage_durations_ms)
      ? Object.fromEntries(Object.entries(row.stage_durations_ms).filter(([, v]) => Number.isInteger(v) && v >= 0))
      : null,
    admissionDeferrals: Number.isInteger(row.admission_deferrals) ? row.admission_deferrals : 0,
  };
}

/* One quarantined capture as the VPS reported it, with what this CRM holds of
 * it. `stored` is the batch matched by capture id on the same device, or null
 * when the capture never reached storage, which is the fact the drawer needs
 * to say "replay it from here" versus "only the VPS has it". */
function publicQuarantineItem(row, batch) {
  return {
    captureId: row.capture_id,
    tradingDate: row.trading_date,
    code: row.code,
    attempts: Number.isInteger(row.attempts) ? row.attempts : 0,
    final: row.final === true,
    quarantinedAt: row.quarantined_at,
    lastAttemptAt: row.last_attempt_at || null,
    reportedAt: row.reported_at,
    stored: batch ? {
      batchId: batch.id,
      status: batch.status,
      errorCode: SAFE_BATCH_ERRORS.has(batch.error_code) ? batch.error_code : batch.error_code ? 'ingest_failed' : null,
    } : null,
  };
}

/* An `in` list rides in the URL, and a fleet of 139 machines with a bad week
 * behind it could name thousands of captures. Asked for in slices so no one
 * request outgrows what the platform will route. */
async function loadWhereIn(admin, table, columns, column, values, decorate = (query) => query) {
  const rows = [];
  const sliceSize = 100;
  for (let from = 0; from < values.length; from += sliceSize) {
    const slice = values.slice(from, from + sliceSize);
    rows.push(...await loadAll(admin, table, columns, (query) => decorate(query.in(column, slice))));
  }
  return rows;
}

/* The quarantine rows for the devices on the screen, and the batches they
 * name, only when there is something to name. Both grouped by device so the
 * row build below is a map lookup. */
async function loadQuarantine(admin, deviceIds) {
  if (!deviceIds.length) return { byDevice: new Map(), supported: true };
  let rows;
  try {
    rows = await loadWhereIn(admin, 'ingest_quarantine_reports', QUARANTINE_COLUMNS, 'device_id', deviceIds,
      (query) => query.order('trading_date', { ascending: false }));
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    return { byDevice: new Map(), supported: false };
  }
  const captureIds = [...new Set(rows.map((row) => row.capture_id))];
  const batches = await loadWhereIn(admin, 'ingest_batches', QUARANTINE_BATCH_COLUMNS, 'capture_id', captureIds);
  const batchByCapture = new Map(batches.map((batch) => [`${batch.device_id}:${batch.capture_id}`, batch]));
  const byDevice = new Map();
  for (const row of rows) {
    const item = publicQuarantineItem(row, batchByCapture.get(`${row.device_id}:${row.capture_id}`));
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, []);
    byDevice.get(row.device_id).push(item);
  }
  return { byDevice, supported: true };
}

export function createFleetStore(admin) {
  return {
    async list({ page, pageSize, search, tradingDate, now, releaseVersion }) {
      const dayBatches = (query) => query.eq('trading_date', tradingDate).order('received_at', { ascending: false });
      let timed = true;
      const [clients, devices, batches] = await Promise.all([
        loadAll(admin, 'clients', 'id,name', (query) => query.order('name', { ascending: true }).order('id', { ascending: true })),
        loadAll(admin, 'ingest_devices', DEVICE_COLUMNS, (query) => query.order('created_at', { ascending: false })),
        loadAll(admin, 'ingest_batches', BATCH_TIMING_COLUMNS, dayBatches).catch((error) => {
          if (!isMissingColumn(error)) throw error;
          timed = false;
          return loadAll(admin, 'ingest_batches', BATCH_COLUMNS, dayBatches);
        }),
      ]);
      const deviceByClient = firstByClient(devices);
      const batchByClient = firstByClient(batches);
      const quarantine = await loadQuarantine(admin, [...deviceByClient.values()].map((device) => device.id));
      const normalizedSearch = search.toLocaleLowerCase('en-US');
      const allRows = clients.map((client) => {
          const device = publicDevice(deviceByClient.get(client.id));
          const todayBatch = publicBatch(batchByClient.get(client.id));
          // null before step 46 has run, so the screen says nothing about a
          // quarantine rather than reporting every folder empty.
          const rowQuarantine = quarantine.supported && device
            ? summarizeQuarantine(quarantine.byDevice.get(device.id) || [])
            : null;
          return {
            client: { uuid: client.id, name: client.name }, device, todayBatch, quarantine: rowQuarantine,
            operationalStatus: classifyFleetRow({ now, device, todayBatch, releaseVersion, quarantine: rowQuarantine }),
          };
        });
      const matchingRows = allRows.filter((row) => !normalizedSearch
        || String(row.client.name || '').toLocaleLowerCase('en-US').includes(normalizedSearch)
        || String(row.device?.id || '').toLocaleLowerCase('en-US').includes(normalizedSearch));
      const start = (page - 1) * pageSize;
      return {
        rows: matchingRows.slice(start, start + pageSize),
        total: matchingRows.length,
        summary: summarizeFleet(allRows),
        // One pass over rows already in memory. The search box and the page
        // number do not narrow it: this line is about the day, not the page.
        ingestDay: timed ? summarizeIngestDay(batches.map(publicBatch)) : null,
      };
    },
  };
}

function safeError(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'collector_fleet_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createFleetStore,
  now = () => new Date(),
  resolveRelease = resolveInstallerRelease,
  env = process.env,
  production = env.NODE_ENV === 'production',
  fetchRelease = globalThis.fetch,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      const { admin, auth } = createClients();
      await authorize(req, { admin, authClient: auth, roles: ['Manager'] });
      const filters = parseFleetQuery(req.query || {});
      const serverTime = now();
      const tradingDate = newYorkTradingClock(serverTime)?.date;
      const releaseVersion = (await resolveRelease(env, { production, fetchImpl: fetchRelease }))?.version || null;
      const result = await createStore(admin).list({ ...filters, tradingDate, now: serverTime, releaseVersion });
      res.setHeader('Cache-Control', 'private, no-store');
      // The New York trading date the day line and every row's status were
      // computed against. Without it the screen would have to re-derive it from
      // a UTC timestamp and would name the wrong day for part of every evening.
      return sendJson(res, 200, { serverTime: serverTime.toISOString(), tradingDate, ...filters, ...result });
    } catch (error) {
      return handleApiError(res, safeError(error), { fallbackMessage: 'collector_fleet_failed' });
    }
  };
}

export default createHandler();
