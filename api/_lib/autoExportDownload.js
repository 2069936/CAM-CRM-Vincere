import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { validateAutoExportSnapshot } from '../../src/domain/autoExportContract.js';
import { selectDailyPnl } from '../../src/domain/autoImport.js';
import { canonicalSnapshotPayload, DEFAULT_MAX_COMPRESSED_BYTES, DEFAULT_MAX_UNCOMPRESSED_BYTES } from './autoImportStore.js';
import { ApiError } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SECTIONS = Object.freeze(['accounts', 'strategies', 'orders', 'executions']);
export const DEFAULT_MAX_ZIP_BYTES = 20 * 1024 * 1024;

export const CSV_COLUMNS = Object.freeze({
  accounts: Object.freeze([
    'accountName', 'connectionName', 'displayName', 'netLiquidation', 'cashValue',
    'realizedPnl', 'grossRealizedPnl', 'unrealizedPnl', 'totalPnl', 'weeklyPnl',
    'buyingPower', 'excessIntradayMargin', 'initialMargin', 'maintenanceMargin',
    'currency', 'status',
  ]),
  strategies: Object.freeze([
    'strategyId', 'strategyName', 'strategyDisplayName', 'accountName', 'instrument',
    'state', 'quantity', 'position', 'averagePrice', 'realizedPnl', 'unrealizedPnl',
    'enabled', 'startedAt', 'parameters', 'parameterCaptureStatus',
  ]),
  orders: Object.freeze([
    'orderId', 'accountName', 'strategyId', 'strategyName', 'instrument', 'action',
    'orderType', 'quantity', 'filled', 'remaining', 'limitPrice', 'stopPrice',
    'averageFillPrice', 'state', 'time', 'tif', 'oco', 'name', 'nativeId',
  ]),
  executions: Object.freeze([
    'executionId', 'orderId', 'accountName', 'strategyId', 'strategyName',
    'instrument', 'action', 'quantity', 'price', 'time', 'marketPosition',
    'commission', 'fee', 'realizedPnl', 'nativeId',
  ]),
});

function corruption() {
  return new ApiError(409, 'stored_snapshot_corrupt');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function validDate(value) {
  if (!DATE.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function expectedPath(batch) {
  if (!UUID.test(batch?.clientId || '') || !UUID.test(batch?.captureId || '') || !validDate(batch?.tradingDate)) {
    throw corruption();
  }
  return `${batch.clientId}/${batch.tradingDate}/${batch.captureId}.json.gz`;
}

function checkedBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw corruption();
}

function sameInstant(left, right) {
  const leftTime = typeof left === 'string' ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === 'string' ? Date.parse(right) : Number.NaN;
  return !Number.isNaN(leftTime) && leftTime === rightTime;
}

export function verifyStoredSnapshot({
  batch,
  compressed,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
}) {
  validateStoredSnapshotMetadata(batch, { maxUncompressedBytes });
  const gzip = checkedBuffer(compressed);
  if (gzip.length === 0 || gzip.length > maxCompressedBytes) throw corruption();
  let jsonBytes;
  try {
    jsonBytes = gunzipSync(gzip, { maxOutputLength: maxUncompressedBytes });
  } catch {
    throw corruption();
  }
  if (jsonBytes.length !== batch.byteCount || sha256(jsonBytes) !== batch.contentSha256) throw corruption();

  let snapshot;
  try {
    snapshot = JSON.parse(jsonBytes.toString('utf8'));
  } catch {
    throw corruption();
  }
  if (snapshot?.schemaVersion !== 1) throw new ApiError(409, 'unsupported_schema_version');
  const validation = validateAutoExportSnapshot(snapshot);
  if (!validation.ok) throw corruption();
  const canonical = canonicalSnapshotPayload(snapshot).utf8;
  if (!jsonBytes.equals(canonical)
    || snapshot.captureId !== batch.captureId
    || snapshot.tradingDate !== batch.tradingDate
    || !sameInstant(snapshot.capturedAt, batch.capturedAt)) {
    throw corruption();
  }
  for (const section of SECTIONS) {
    if (batch.rowCounts[section] !== snapshot[section].length) throw corruption();
  }
  return { snapshot, jsonBytes };
}

export function validateStoredSnapshotMetadata(batch, {
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
} = {}) {
  if (batch?.schemaVersion !== 1) throw new ApiError(409, 'unsupported_schema_version');
  if (batch?.storagePath !== expectedPath(batch)
    || !SHA256.test(batch?.contentSha256 || '')
    || !Number.isSafeInteger(batch?.byteCount)
    || batch.byteCount < 0
    || batch.byteCount > maxUncompressedBytes) {
    throw corruption();
  }
  for (const section of SECTIONS) {
    if (!Number.isSafeInteger(batch?.rowCounts?.[section]) || batch.rowCounts[section] < 0) throw corruption();
  }
  return batch.storagePath;
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? stableJson(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvForSection(section, rows) {
  const columns = CSV_COLUMNS[section];
  if (!columns || !Array.isArray(rows)) throw new ApiError(500, 'download_generation_failed');
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(','))];
  // These files are explicitly intended for Excel inspection on Windows VPSs.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function pnlSourceCounts(accounts) {
  const counts = { realized: 0, grossFallback: 0, grossMissingRealized: 0, unavailable: 0 };
  const names = {
    realized: 'realized',
    gross_fallback: 'grossFallback',
    gross_missing_realized: 'grossMissingRealized',
    unavailable: 'unavailable',
  };
  for (const account of accounts) {
    const { source } = selectDailyPnl(account);
    counts[names[source]] += 1;
  }
  return counts;
}

function pnlSourceDetails(accounts) {
  return accounts.map((account) => {
    const selected = selectDailyPnl(account);
    return {
      accountName: account.accountName,
      realizedPnl: account.realizedPnl,
      grossRealizedPnl: account.grossRealizedPnl,
      selectedPnl: selected.value,
      source: selected.source,
    };
  });
}

export function buildSnapshotZip({ batch, snapshot, jsonBytes, maxZipBytes = DEFAULT_MAX_ZIP_BYTES }) {
  const csv = Object.fromEntries(SECTIONS.map((section) => [section, Buffer.from(csvForSection(section, snapshot[section]), 'utf8')]));
  const manifest = {
    schemaVersion: snapshot.schemaVersion,
    capture: {
      id: snapshot.captureId,
      capturedAt: snapshot.capturedAt,
      tradingDate: snapshot.tradingDate,
      timeZone: snapshot.timeZone,
      source: snapshot.source,
    },
    batch: {
      id: batch.id,
      clientId: batch.clientId,
      deviceId: batch.deviceId,
      receivedAt: batch.receivedAt,
      processedAt: batch.processedAt || null,
      status: batch.status,
      dailyImportId: batch.dailyImportId || null,
      replacesBatchId: batch.replacesBatchId || null,
    },
    rowCounts: Object.fromEntries(SECTIONS.map((section) => [section, snapshot[section].length])),
    completeness: batch.completeness || {},
    hashes: {
      algorithm: 'SHA-256',
      canonicalJsonSha256: sha256(jsonBytes),
      csvSha256: Object.fromEntries(SECTIONS.map((section) => [section, sha256(csv[section])])),
    },
    pnlSources: pnlSourceCounts(snapshot.accounts),
    pnlSourceDetails: pnlSourceDetails(snapshot.accounts),
    pnlSourcePolicy: 'Prefer realized PnL; when realized is zero and gross is non-zero, use gross as the fallback.',
  };
  const inputBytes = Object.values(csv).reduce((total, bytes) => total + bytes.length, 0)
    + Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  if (!Number.isSafeInteger(maxZipBytes) || maxZipBytes <= 0 || inputBytes > DEFAULT_MAX_UNCOMPRESSED_BYTES) {
    throw new ApiError(413, 'download_too_large');
  }
  const archive = Buffer.from(zipSync({
    'Accounts.csv': csv.accounts,
    'Strategies.csv': csv.strategies,
    'Orders.csv': csv.orders,
    'Executions.csv': csv.executions,
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  }, { level: 6 }));
  if (archive.length > maxZipBytes) throw new ApiError(413, 'download_too_large');
  return archive;
}

export function deterministicDownloadName(batch, format) {
  expectedPath(batch);
  if (!['json', 'zip'].includes(format)) throw new ApiError(400, 'invalid_download_format');
  return `ninjatrader-${batch.clientId}-${batch.tradingDate}-${batch.captureId}.${format}`;
}
