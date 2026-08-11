// What a CAM-scoped export will actually contain, worked out before it is asked for.
//
// The download is one button, and behind it is anything from 55 rows to five
// figures. A CAM pulling a month for nineteen clients should see the size on
// the button, not in their downloads folder. Everything here is computed from
// state the browser already holds, so the preview costs no request.
//
// The counts are not guesses. daily_imports.source_summary is written by the
// importer and holds {accounts, strategies, orders, executions, flags} for the
// day; on the real book it is present on all 535 imports and its order count
// matches the actual order rows on 491 of the 493 imports that have any. That
// is what makes an estimate possible without loading the 16,135 order rows the
// CRM deliberately does not load.

/**
 * Bytes per row, measured on the endpoint's own output rather than assumed.
 *
 * From the busiest CAM's 30-day pull (28 clients, 148 sessions, 3.81 MB raw
 * without trade history / 6.92 MB with). strategy_snapshots is the outlier at
 * ~2.1 KB a row because params_parsed carries the whole strategy configuration;
 * orders and executions are ~0.5 KB each but arrive in thousands.
 */
const BYTES_PER_ROW = {
  daily_imports: 496,
  account_snapshots: 386,
  strategy_snapshots: 2113,
  orders: 508,
  executions: 531,
  operational_flags: 424,
  trading_accounts: 713,
  activity_logs: 320,
  reports: 555,
  clients: 749,
};

/** The continuity block costs ~3.3 KB a session on the same measurement. */
const BYTES_PER_SESSION = 3330;

/**
 * Gzip ratio observed on real payloads: 3.81 MB raw compressed to 0.40 MB and
 * 6.92 MB to 0.76 MB, so about 9x. Vercel compresses the response, so this is
 * what actually crosses the wire; the raw figure is what the browser holds.
 */
const GZIP_RATIO = 9;

/**
 * The server's own response ceiling, mirrored so the dialog can say "too big"
 * before the request is spent rather than after.
 *
 * Must track MAX_RESPONSE_BYTES in server/export/clientExport.js. It is not a
 * cosmetic threshold: the busiest CAM's 30-day pull with trade history is
 * 6.92 MB and the endpoint refuses it with a 413, so a preview that promised
 * that download would be promising a failure.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function inRange(date, from, to) {
  const day = String(date || '').slice(0, 10);
  if (!day) return false;
  return day >= from && day <= to;
}

function countOrNull(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows a single day contributes.
 *
 * source_summary first, the loaded arrays second. The fallback matters for the
 * trade tables specifically: the CRM loads orders and executions only when
 * trade history was asked for, so `dailyImport.orders` is an empty array on a
 * normal session rather than a count of zero. Reading it as zero would promise
 * a small download and deliver a large one.
 */
function countsForDay(dailyImport) {
  const summary = dailyImport?.sourceSummary && typeof dailyImport.sourceSummary === 'object'
    ? dailyImport.sourceSummary
    : {};
  const snapshots = (dailyImport?.snapshots || []).length;
  const strategies = (dailyImport?.strategies || []).length;
  const flags = (dailyImport?.flags || []).length;
  return {
    account_snapshots: snapshots || countOrNull(summary.accounts) || 0,
    strategy_snapshots: strategies || countOrNull(summary.strategies) || 0,
    operational_flags: flags || countOrNull(summary.flags) || 0,
    orders: countOrNull(summary.orders) ?? (dailyImport?.orders || []).length,
    executions: countOrNull(summary.executions) ?? (dailyImport?.executions || []).length,
  };
}

/**
 * A preview of the export for the given clients and range.
 *
 * `clients` are the CRM's client objects, not rows: they carry dailyImports,
 * accountRegistry and activityLog already.
 */
export function buildClientExportPlan(clients = [], { from, to, includeTradeHistory = false } = {}) {
  const rows = {
    clients: 0,
    trading_accounts: 0,
    daily_imports: 0,
    account_snapshots: 0,
    strategy_snapshots: 0,
    operational_flags: 0,
    activity_logs: 0,
  };
  if (includeTradeHistory) {
    rows.orders = 0;
    rows.executions = 0;
  }

  let sessions = 0;
  let clientsWithSessions = 0;
  let ordersEstimate = 0;
  let executionsEstimate = 0;

  for (const client of clients) {
    rows.clients += 1;
    rows.trading_accounts += Object.keys(client?.accountRegistry || {}).length;
    // activity_logs is filtered server-side on created_at, which the loaded
    // entries also carry, so the same window applies here.
    rows.activity_logs += (client?.activityLog || []).filter((entry) => (
      inRange(entry?.createdAt || entry?.logDate, from, to)
    )).length;

    const days = (client?.dailyImports || []).filter((entry) => inRange(entry?.date, from, to));
    if (days.length) clientsWithSessions += 1;
    sessions += days.length;
    rows.daily_imports += days.length;
    for (const day of days) {
      const counts = countsForDay(day);
      rows.account_snapshots += counts.account_snapshots;
      rows.strategy_snapshots += counts.strategy_snapshots;
      rows.operational_flags += counts.operational_flags;
      ordersEstimate += counts.orders;
      executionsEstimate += counts.executions;
    }
  }

  if (includeTradeHistory) {
    rows.orders = ordersEstimate;
    rows.executions = executionsEstimate;
  }

  const totalRows = Object.values(rows).reduce((sum, count) => sum + count, 0);
  const estimatedBytes = Object.entries(rows).reduce(
    (sum, [table, count]) => sum + count * (BYTES_PER_ROW[table] || 0),
    0,
  ) + sessions * BYTES_PER_SESSION;

  return {
    from,
    to,
    includeTradeHistory,
    clients: rows.clients,
    clientsWithSessions,
    sessions,
    rows,
    totalRows,
    estimatedBytes,
    estimatedDownloadBytes: Math.round(estimatedBytes / GZIP_RATIO),
    // Compared against the RAW estimate, not the gzipped one: the platform cap
    // applies to the body the function returns, and compression happens after.
    maxResponseBytes: MAX_RESPONSE_BYTES,
    exceedsResponseLimit: estimatedBytes > MAX_RESPONSE_BYTES,
    // Orders and executions the CRM knows about but this export is leaving out.
    // Shown so "trade history off" is a visible choice rather than a silence.
    excludedTradeRows: includeTradeHistory ? null : ordersEstimate + executionsEstimate,
  };
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
