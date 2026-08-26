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
//
// It now also decides how a pull too big for one response is SPLIT. The axis is
// bytes, not clients: on this book the largest CAM by client count (32) is the
// cheapest export on the desk at 0.27 MiB, and the one that was 0.1% away from
// being refused carries 28. See planExportBatches.

/**
 * Bytes per row, measured on the endpoint's own output rather than assumed.
 *
 * Re-measured through server/export/clientExport.js against
 * public/local-snapshot.json after the strategy-parameter dictionary landed,
 * pooled over all eight CAMs' default 30-day pulls (3,707 strategy rows, 2,981
 * account snapshots, 6,702 flags). The one that moved is strategy_snapshots:
 * 2,113 bytes a row while params_parsed and parameters_raw sat on every row,
 * 503 now that they are stored once per payload. Leaving the old figure here
 * would have made the dialog refuse pulls the server now accepts.
 *
 * Only tables the browser can count are listed. reports, client_assignments,
 * price_checks, tasks and payout_events are real bytes the CRM does not hold
 * per client, and they are absorbed into BYTES_PER_CLIENT / BYTES_PER_SESSION
 * below rather than left out — an estimate that silently omits a table is the
 * kind that promises a download the server then refuses.
 */
const BYTES_PER_ROW = {
  clients: 572,
  trading_accounts: 713,
  daily_imports: 493,
  account_snapshots: 391,
  strategy_snapshots: 503,
  operational_flags: 421,
  activity_logs: 324,
  orders: 508,
  executions: 533,
};

/**
 * What a client and a session cost ON TOP of the rows counted above.
 *
 * Least-squares fit over 272 single-client payloads taken through the real
 * handler (every client on the book, with and without trade history), so these
 * two absorb the `series` continuity block plus the five tables the browser
 * cannot count. The previous 3,330 B/session was fitted before per-day absence
 * coverage existed and against `series` alone; it under-stated a session by
 * nearly half.
 *
 * ACCURACY, measured per CAM against the real payload: the model over-estimates
 * a dormant book by up to 41% (eight clients, ten sessions) and under-estimates
 * the worst real case by 9.7% (18 clients, 101 sessions). Over-estimating is
 * the safe direction — it warns early. The 9.7% is what BATCH_TARGET_FRACTION
 * has to cover, and is why it is not 0.95.
 */
const BYTES_PER_CLIENT = 869;
const BYTES_PER_SESSION = 5930;

/**
 * The fixed cost of one payload, whatever it carries.
 *
 * The envelope — range, limits, caveats, absence legend — plus the strategy
 * parameter dictionary, which is sized by how many DISTINCT configurations the
 * range touches and not by how many rows repeat them. Measured across the eight
 * CAMs it runs 30 KB to 109 KB, the top being a 13-client CAM whose book spans
 * 53 distinct configurations. 112 KB is the measured maximum rounded up.
 *
 * It matters most where it is least obvious: it is paid once PER PART, so a
 * five-part export spends half a megabyte restating the same envelope.
 */
const BYTES_PER_PAYLOAD = 112 * 1024;

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
 * cosmetic threshold: before the dictionary the busiest CAM's default pull sat
 * at 99.9% of it and the same pull with trade history was refused outright, so
 * a preview that promised those downloads would be promising a failure.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The server's per-request client cap, mirrored for the same reason.
 * See MAX_CLIENTS in server/export/clientExport.js — it is a bound on one
 * request, not on how many clients may be exported.
 */
export const MAX_CLIENTS_PER_REQUEST = 60;

/** The server's ceiling on how many parts one export may declare. */
export const MAX_BATCHES = 200;

/**
 * How much of the response ceiling one part is allowed to be PLANNED at.
 *
 * Not 1.0, and not because of timidity. The estimate above under-states the
 * worst measured case on this book by 9.7%, so a part planned to fill the
 * ceiling exactly is a part the server refuses — and the whole point of
 * planning parts is that every one of them arrives. 0.8 is a little over twice
 * the measured worst-case error, and it also leaves room for the book to grow
 * between the moment the plan is drawn and the moment the pull runs.
 *
 * The cost of being wrong in this direction is one extra file. The cost of
 * being wrong in the other is a 413 in the middle of a multi-part download.
 */
export const BATCH_TARGET_FRACTION = 0.8;

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
 * One client's contribution: the rows it adds and what they weigh.
 *
 * Split out from buildClientExportPlan because it is the unit planExportBatches
 * packs. A batcher that re-derived per-client sizes some other way would be a
 * second estimate of the same thing, free to disagree with the number shown on
 * the button beside it.
 *
 * The bytes here EXCLUDE BYTES_PER_PAYLOAD: a client costs the same whichever
 * part it lands in, while the envelope is paid once per part.
 */
export function estimateClientExportBytes(client, { from, to, includeTradeHistory = false } = {}) {
  const rows = {
    clients: 1,
    trading_accounts: Object.keys(client?.accountRegistry || {}).length,
    daily_imports: 0,
    account_snapshots: 0,
    strategy_snapshots: 0,
    operational_flags: 0,
    // activity_logs is filtered server-side on created_at, which the loaded
    // entries also carry, so the same window applies here.
    activity_logs: (client?.activityLog || []).filter((entry) => (
      inRange(entry?.createdAt || entry?.logDate, from, to)
    )).length,
  };

  let ordersEstimate = 0;
  let executionsEstimate = 0;
  const days = (client?.dailyImports || []).filter((entry) => inRange(entry?.date, from, to));
  rows.daily_imports = days.length;
  for (const day of days) {
    const counts = countsForDay(day);
    rows.account_snapshots += counts.account_snapshots;
    rows.strategy_snapshots += counts.strategy_snapshots;
    rows.operational_flags += counts.operational_flags;
    ordersEstimate += counts.orders;
    executionsEstimate += counts.executions;
  }
  if (includeTradeHistory) {
    rows.orders = ordersEstimate;
    rows.executions = executionsEstimate;
  }

  const bytes = Object.entries(rows).reduce(
    (sum, [table, count]) => sum + count * (BYTES_PER_ROW[table] || 0),
    0,
  ) + BYTES_PER_CLIENT + days.length * BYTES_PER_SESSION;

  return {
    id: client?.id || null,
    uuid: client?.uuid || client?.id || null,
    name: client?.name || '',
    rows,
    sessions: days.length,
    bytes,
    // Orders and executions this client has that the export is leaving out.
    excludedTradeRows: includeTradeHistory ? 0 : ordersEstimate + executionsEstimate,
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
  let excludedTradeRows = 0;
  let clientBytes = 0;
  const perClient = [];

  for (const client of clients) {
    const estimate = estimateClientExportBytes(client, { from, to, includeTradeHistory });
    perClient.push(estimate);
    for (const [table, count] of Object.entries(estimate.rows)) {
      rows[table] = (rows[table] || 0) + count;
    }
    if (estimate.sessions) clientsWithSessions += 1;
    sessions += estimate.sessions;
    excludedTradeRows += estimate.excludedTradeRows;
    clientBytes += estimate.bytes;
  }

  const totalRows = Object.values(rows).reduce((sum, count) => sum + count, 0);
  const estimatedBytes = clientBytes + BYTES_PER_PAYLOAD;

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
    // Kept separate so a caller can tell "this is what the data weighs" from
    // "this is what saying it once more costs", which is the whole difference
    // between one part and five.
    fixedBytes: BYTES_PER_PAYLOAD,
    perClient,
    estimatedDownloadBytes: Math.round(estimatedBytes / GZIP_RATIO),
    // Compared against the RAW estimate, not the gzipped one: the platform cap
    // applies to the body the function returns, and compression happens after.
    maxResponseBytes: MAX_RESPONSE_BYTES,
    exceedsResponseLimit: estimatedBytes > MAX_RESPONSE_BYTES,
    // Orders and executions the CRM knows about but this export is leaving out.
    // Shown so "trade history off" is a visible choice rather than a silence.
    excludedTradeRows: includeTradeHistory ? null : excludedTradeRows,
  };
}

/**
 * Splits a client list into parts that each fit inside one response.
 *
 * BY BYTES. A cap on clients per part is also applied, because the server keeps
 * one, but it is the second test and never the first — on this book the two
 * bite in opposite places. The largest CAM by headcount (32 clients) exports in
 * 0.27 MiB; the CAM that was 0.1% from being refused carries 28; and a part of
 * 60 dormant clients weighs less than a part of six busy ones.
 *
 * The walk is greedy IN THE ORDER GIVEN rather than a best-fit packing. Fewer
 * parts is not worth a split nobody can predict: parts in list order can be
 * named ("clients 1-14, 15-31"), reproduce identically on a second run, and let
 * a reader of a failed part see exactly which clients were in it. Packing
 * efficiency buys nothing here — the constraint is a hard ceiling per part, not
 * a total.
 *
 * A client too big for a part on its own is NOT quietly dropped and NOT quietly
 * merged into a part that will fail. It gets its own part and is named in
 * `oversized`, and `deliverable` goes false so the caller refuses to start
 * rather than downloading four good files and one 413.
 */
export function planExportBatches(clients = [], {
  from,
  to,
  includeTradeHistory = false,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxClients = MAX_CLIENTS_PER_REQUEST,
  maxBatches = MAX_BATCHES,
  targetFraction = BATCH_TARGET_FRACTION,
} = {}) {
  // What a part has left for actual data once the envelope has been paid.
  const budgetBytes = Math.max(1, Math.floor(maxResponseBytes * targetFraction) - BYTES_PER_PAYLOAD);
  const estimates = clients.map((client) => estimateClientExportBytes(client, { from, to, includeTradeHistory }));

  const parts = [];
  const oversized = [];
  for (const estimate of estimates) {
    const tooBigAlone = estimate.bytes > budgetBytes;
    if (tooBigAlone) oversized.push(estimate);
    const current = parts[parts.length - 1];
    const fits = current
      && !tooBigAlone
      && current.estimatedBytes - BYTES_PER_PAYLOAD + estimate.bytes <= budgetBytes
      && current.clients.length < maxClients;
    if (fits) {
      current.clients.push(estimate);
      current.estimatedBytes += estimate.bytes;
      current.sessions += estimate.sessions;
    } else {
      parts.push({
        clients: [estimate],
        estimatedBytes: BYTES_PER_PAYLOAD + estimate.bytes,
        sessions: estimate.sessions,
      });
    }
    // A client that cannot share a part cannot take one either, so the next
    // client starts a fresh part rather than joining the doomed one.
    if (tooBigAlone) parts.push({ clients: [], estimatedBytes: BYTES_PER_PAYLOAD, sessions: 0 });
  }
  while (parts.length && !parts[parts.length - 1].clients.length) parts.pop();

  const batches = parts.map((part, index) => ({
    ...part,
    index: index + 1,
    of: parts.length,
    clientIds: part.clients.map((entry) => entry.uuid),
  }));

  const tooManyBatches = batches.length > maxBatches;
  return {
    batches,
    batchCount: batches.length,
    budgetBytes,
    fixedBytes: BYTES_PER_PAYLOAD,
    targetFraction,
    maxResponseBytes,
    maxClients,
    maxBatches,
    oversized,
    tooManyBatches,
    // The one question the caller has: can this be handed over whole?
    deliverable: batches.length > 0 && !oversized.length && !tooManyBatches,
    totalEstimatedBytes: batches.reduce((sum, batch) => sum + batch.estimatedBytes, 0),
  };
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
