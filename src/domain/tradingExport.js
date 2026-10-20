/* ────────────────────────────────────────────────────────────────────────────
 * SLIM TRADING EXPORTS FROM A CLIENT'S VPS (step 72).
 *
 * A Manager asks one VPS, or many, for its trading history in a date range:
 * orders, fills, strategy configurations and per trade geometry. Agent 1.4.0
 * and later polls /api/ingest/export-request, builds the file, uploads it
 * through a signed upload URL straight into the private bucket, and says how
 * it went; the Manager downloads it from the Data lab page for 14 days.
 *
 * This module is the one place that says which agents can send an export,
 * what the vocabulary is, and what each export says in words. The request
 * route and the page both read it, so the two can never disagree about which
 * machine is eligible.
 *
 * Pure: no React, no clock of its own. The server imports it too.
 * ──────────────────────────────────────────────────────────────────────────── */

import { compareAgentVersions } from './agentUpdate.js';

/** The first agent build that can build and upload a slim export. */
export const FIRST_SLIM_EXPORT_AGENT = '1.4.0';

/** What an export can hold, in the order the contract lists it. */
export const TRADING_EXPORT_DATASETS = Object.freeze(['executions', 'orders', 'strategies', 'trades']);

/** Step 72's status vocabulary. */
export const TRADING_EXPORT_STATUSES = Object.freeze([
  'requested', 'building', 'uploading', 'ready', 'failed', 'cancelled', 'expired',
]);

/** The statuses the agent is still working on. One per device at a time. */
export const OPEN_TRADING_EXPORT_STATUSES = Object.freeze(['requested', 'building', 'uploading']);

/** 25 MiB: the agent's limit, the route's 413, the CHECK and the bucket's limit. */
export const TRADING_EXPORT_MAX_BYTES = 26214400;

/** The most ids one request to /api/admin/ingest-trading-export carries. */
export const TRADING_EXPORT_BATCH_LIMIT = 300;

/** How long a ready export stays downloadable. */
export const TRADING_EXPORT_RETENTION_DAYS = 14;

/** How long a signed download URL lives. */
export const TRADING_EXPORT_DOWNLOAD_SECONDS = 300;

export const TRADING_EXPORT_TOO_OLD_COPY = `This agent is older than ${FIRST_SLIM_EXPORT_AGENT} and cannot send trading exports. Update it first.`;

export const TRADING_EXPORT_DATASET_LABELS = Object.freeze({
  executions: 'Executions',
  orders: 'Orders',
  strategies: 'Strategies',
  trades: 'Trades',
});

export const TRADING_EXPORT_STATUS_LABELS = Object.freeze({
  requested: 'Requested',
  building: 'Building on the VPS',
  uploading: 'Uploading',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD, and nothing else. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Whether an agent can build a slim export. An agent that reported no
 * version, or something that is not one, cannot: nothing says it has the code.
 */
export function canSendTradingExport(agentVersion) {
  const difference = compareAgentVersions(agentVersion, FIRST_SLIM_EXPORT_AGENT);
  return difference !== null && difference >= 0;
}

/** True while the agent is still working on the export. */
export function isOpenTradingExport(status) {
  return OPEN_TRADING_EXPORT_STATUSES.includes(status);
}

/**
 * The datasets in the contract's order, or null when the list is not a
 * non empty set of known names (a duplicate or an unknown name is refused,
 * not dropped).
 */
export function normalizeDatasets(list) {
  if (!Array.isArray(list) || !list.length || list.length > TRADING_EXPORT_DATASETS.length) return null;
  if (list.some((name) => !TRADING_EXPORT_DATASETS.includes(name))) return null;
  if (new Set(list).size !== list.length) return null;
  return TRADING_EXPORT_DATASETS.filter((name) => list.includes(name));
}

const NUMBER = new Intl.NumberFormat('en-US');

/** "512 bytes", "812 KB", "12.4 MB". */
export function formatExportBytes(bytes) {
  const value = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${NUMBER.format(Math.round(value))} ${Math.round(value) === 1 ? 'byte' : 'bytes'}`;
  if (value < 1024 * 1024) return `${NUMBER.format(Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function dayParts(value) {
  if (!isIsoDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return { year, date: new Date(Date.UTC(year, month - 1, day)) };
}

function dayWords(parts, withYear) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(parts.date);
}

/**
 * The days of an export in words: "Jul 1 to Oct 19", with the years only when
 * the two ends are in different years. "Through Oct 19" or "From Jul 1" when
 * one end is open, '' when neither is known. In the middle of a sentence
 * (`midSentence`) the open forms read "through" and "from".
 */
export function describeExportRange(from, to, { midSentence = false } = {}) {
  const start = dayParts(from);
  const end = dayParts(to);
  if (start && end) {
    const withYear = start.year !== end.year;
    return `${dayWords(start, withYear)} to ${dayWords(end, withYear)}`;
  }
  if (end) return `${midSentence ? 'through' : 'Through'} ${dayWords(end, false)}`;
  if (start) return `${midSentence ? 'from' : 'From'} ${dayWords(start, false)}`;
  return '';
}

/** The days a request asked for, in words: NULL from is since the last export, NULL to is today. */
export function requestedRangeWords(row) {
  if (row?.fromDate && row?.toDate) return describeExportRange(row.fromDate, row.toDate);
  if (row?.fromDate) return `${describeExportRange(row.fromDate, null)} to today`;
  if (row?.toDate) return `Since the last export, ${describeExportRange(null, row.toDate, { midSentence: true })}`;
  return 'Since the last export';
}

/** A YYYY-MM-DD or timestamp as "Oct 19, 2026", '' when it is neither. */
export function formatExportDate(value) {
  if (!value) return '';
  const day = isIsoDate(value) ? value : String(value).slice(0, 10);
  const parts = dayParts(day);
  return parts ? dayWords(parts, true) : '';
}

function fillsWords(rowCounts) {
  const fills = rowCounts && typeof rowCounts === 'object' ? Number(rowCounts.executions) : NaN;
  if (!Number.isInteger(fills) || fills < 0) return '';
  return `${NUMBER.format(fills)} ${fills === 1 ? 'fill' : 'fills'}`;
}

/**
 * Where an export stands, as one plain sentence:
 * "Requested", "Building on the VPS", "Uploading",
 * "Ready, 812 KB, Jul 1 to Oct 19, 2,140 fills", "Failed: <code>",
 * "Cancelled", "Expired".
 */
export function describeTradingExport(row) {
  const status = row?.status;
  if (status === 'ready') {
    return [
      'Ready',
      formatExportBytes(row.byteSize),
      describeExportRange(row.coveredFrom, row.coveredTo, { midSentence: true }),
      fillsWords(row.rowCounts),
    ].filter(Boolean).join(', ');
  }
  if (status === 'failed') return `Failed: ${row.errorCode || 'unknown_error'}`;
  return TRADING_EXPORT_STATUS_LABELS[status] || 'Unknown';
}

/**
 * What the file is saved as: <clientName>_<from>_<to>.jsonl.gz, the client's
 * name made safe for any file system (letters, digits and hyphens, at most 60
 * characters), the days the file holds when the agent reported them, else the
 * days that were asked for, else "start" and "latest".
 */
export function tradingExportFileName(row) {
  const name = String(row?.clientName || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'client';
  const from = [row?.coveredFrom, row?.fromDate].find(isIsoDate) || 'start';
  const to = [row?.coveredTo, row?.toDate].find(isIsoDate) || 'latest';
  return `${name}_${from}_${to}.jsonl.gz`;
}

/** What the request answered, summed over its slices, as one sentence. */
export function tradingExportRequestWords(result) {
  const requested = Number(result?.requested) || 0;
  const skipped = Number(result?.skipped) || 0;
  const needsVps = Number(result?.needsVps) || 0;
  const others = Math.max(0, skipped - needsVps);
  const parts = [`Requested ${requested} ${requested === 1 ? 'export' : 'exports'}.`];
  if (skipped) parts.push(`${skipped} skipped.`);
  if (needsVps) parts.push(`${needsVps} ${needsVps === 1 ? 'needs' : 'need'} an agent update on the VPS first (older than ${FIRST_SLIM_EXPORT_AGENT}).`);
  if (others) parts.push(`${others} already ${others === 1 ? 'has' : 'have'} an export in progress or ${others === 1 ? 'is' : 'are'} no longer active.`);
  return parts.join(' ');
}

/** Splits ids into requests the route accepts. */
export function chunkIds(ids, size = TRADING_EXPORT_BATCH_LIMIT) {
  const chunks = [];
  for (let from = 0; from < ids.length; from += size) chunks.push(ids.slice(from, from + size));
  return chunks;
}
