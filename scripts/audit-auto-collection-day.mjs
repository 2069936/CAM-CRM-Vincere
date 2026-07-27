import { createHmac } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { newYorkTradingClock } from '../src/domain/autoCollectionFleet.js';

const ARGUMENTS = Object.freeze({
  '--base-url': 'baseUrl',
  '--confirm-origin': 'confirmOrigin',
  '--out': 'outputPath',
});
const REQUIRED_ARGUMENTS = Object.freeze(Object.keys(ARGUMENTS));
const PAGE_SIZE = 100;
const MAX_ROWS = 10_000;
const STATUS_ORDER = Object.freeze([
  'pending', 'expected', 'received', 'late', 'incomplete', 'offline', 'failed',
  'revoked', 'paused', 'update_required', 'not_installed', 'not_expected',
]);
const STATUS_SET = new Set(STATUS_ORDER);
const NON_ACTIONABLE = new Set(['pending', 'expected', 'received', 'not_expected']);
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    const value = argv[index + 1];
    if (!key) throw new Error(`Unknown argument: ${flag || '(empty)'}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    result[key] = value;
  }
  for (const flag of REQUIRED_ARGUMENTS) {
    if (!result[ARGUMENTS[flag]]) throw new Error(`Missing required argument ${flag}.`);
  }
  return result;
}

function exactHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('audit_origin_invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new Error('audit_origin_invalid');
  }
  return parsed.origin;
}

function opaqueReference(kind, value, key) {
  if (typeof value !== 'string' || !value) return null;
  const digest = createHmac('sha256', key)
    .update(`vincere-auto-collection-audit:${kind}\0${value}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${kind}_${digest}`;
}

function safeErrorCode(row) {
  const value = row.todayBatch?.errorCode || row.device?.lastErrorCode || null;
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value) ? value : value ? 'collector_error' : null;
}

function validateFleetRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || typeof row.client?.uuid !== 'string'
    || (row.device != null && typeof row.device?.id !== 'string')) {
    throw new Error('fleet_row_invalid');
  }
  const state = row.operationalStatus?.state;
  if (!STATUS_SET.has(state)) throw new Error('fleet_status_invalid');
  return state;
}

export function buildAuditReport({ rows, serverTime, redactionKey }) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('fleet_rows_invalid');
  if (typeof redactionKey !== 'string' || Buffer.byteLength(redactionKey, 'utf8') < 32) {
    throw new Error('audit_redaction_key_required');
  }
  const clock = newYorkTradingClock(serverTime);
  if (!clock) throw new Error('fleet_server_time_invalid');
  const counts = Object.fromEntries(STATUS_ORDER.map((state) => [state, 0]));
  const attention = [];
  for (const row of rows) {
    const state = validateFleetRow(row);
    counts[state] += 1;
    if (!NON_ACTIONABLE.has(state)) {
      const item = {
        state,
        clientRef: opaqueReference('client', row.client.uuid, redactionKey),
        deviceRef: opaqueReference('device', row.device?.id, redactionKey),
      };
      const errorCode = safeErrorCode(row);
      if (errorCode) item.errorCode = errorCode;
      attention.push(item);
    }
  }
  return {
    schemaVersion: 1,
    purpose: 'vincere-auto-collection-daily-audit',
    generatedAt: new Date(serverTime).toISOString(),
    tradingDate: clock.date,
    timeZone: 'America/New_York',
    total: rows.length,
    counts,
    attention,
  };
}

async function requestFleetPage({ baseUrl, page, managerToken, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('/api/admin/ingest-fleet', `${baseUrl}/`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    const response = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${managerToken}` },
    });
    if (!response.ok) throw new Error(`fleet_request_failed_${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.rows)
      || body.rows.length > PAGE_SIZE
      || body.page !== page || body.pageSize !== PAGE_SIZE
      || !Number.isInteger(body.total) || body.total < 0 || body.total > MAX_ROWS
      || typeof body.serverTime !== 'string') {
      throw new Error('fleet_page_invalid');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function auditAutoCollectionDay({
  baseUrl,
  managerToken,
  redactionKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const origin = exactHttpsOrigin(baseUrl);
  if (typeof managerToken !== 'string' || !managerToken) throw new Error('audit_manager_token_required');
  if (typeof redactionKey !== 'string' || Buffer.byteLength(redactionKey, 'utf8') < 32) {
    throw new Error('audit_redaction_key_required');
  }
  if (typeof fetchImpl !== 'function') throw new Error('audit_fetch_unavailable');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('audit_timeout_invalid');
  const rows = [];
  let firstTradingDate = null;
  let expectedTotal = null;
  for (let page = 1; page <= Math.ceil(MAX_ROWS / PAGE_SIZE); page += 1) {
    const body = await requestFleetPage({ origin, baseUrl: origin, page, managerToken, fetchImpl, timeoutMs });
    const tradingDate = newYorkTradingClock(body.serverTime)?.date;
    if (!tradingDate || (firstTradingDate && tradingDate !== firstTradingDate)) {
      throw new Error('fleet_trading_date_changed');
    }
    firstTradingDate ||= tradingDate;
    expectedTotal ??= body.total;
    if (body.total !== expectedTotal) throw new Error('fleet_total_changed');
    for (const row of body.rows) validateFleetRow(row);
    rows.push(...body.rows);
    if (rows.length > expectedTotal) throw new Error('fleet_page_count_mismatch');
    if (rows.length === expectedTotal) {
      return buildAuditReport({ rows, serverTime: body.serverTime, redactionKey });
    }
    if (body.rows.length < PAGE_SIZE) throw new Error('fleet_page_count_mismatch');
  }
  throw new Error('fleet_page_limit_exceeded');
}

export async function runDailyAudit({
  baseUrl,
  confirmOrigin,
  outputPath,
  env = process.env,
  audit = auditAutoCollectionDay,
} = {}) {
  const origin = exactHttpsOrigin(baseUrl);
  if (confirmOrigin !== origin || env.AUTO_COLLECTION_AUDIT_ALLOW_ORIGIN !== origin) {
    throw new Error('audit_origin_confirmation_required');
  }
  const managerToken = env.AUTO_COLLECTION_AUDIT_MANAGER_TOKEN;
  const redactionKey = env.AUTO_COLLECTION_AUDIT_REDACTION_KEY;
  const report = await audit({ baseUrl: origin, managerToken, redactionKey });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, outputPath);
  await chmod(outputPath, 0o600);
  return report;
}

export function formatAuditSummary(report) {
  return `Collector audit ${report.tradingDate}: ${report.total} expected clients, ${report.counts.received} received, ${report.attention.length} requiring review.\n`;
}

async function main() {
  try {
    const report = await runDailyAudit(parseArguments(process.argv.slice(2)));
    process.stdout.write(formatAuditSummary(report));
  } catch (error) {
    process.stderr.write(`Auto-collection daily audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
