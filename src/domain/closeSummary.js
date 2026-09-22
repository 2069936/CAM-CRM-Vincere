// One close, reduced to the few rows the desk's money is actually read from.
//
// WHY THIS EXISTS. Every money figure on the manager's first screen —
// the four business rows, the reconciliation counts, the ten-close history
// strip, the month — is `buildSegmentTotals` walking `account_snapshots` for
// every close in the book. On 2026-09-22 that is 12,778 snapshot rows and
// 14,514 strategy rows downloaded into a browser so that about five thousand
// numbers can be added up. The addition is per (close, segment); the download
// is per (close, account). This file is the per (close, segment) row, written
// once at ingest and read at login.
//
// WHAT IT IS NOT. It is not a second segmentation. `segmentForAccount` decides
// which segment an account close belongs to, here and nowhere else, and this
// module calls it through `buildSegmentTotals` — the same function, over the
// same close, producing the same rows the screen would have produced. A SQL
// view or a trigger that re-derived the segment would put `segmentForAccount`
// in two languages, and two desk answers on one screen is the defect
// deskMoney.js was written to end. The migration that creates the table
// therefore stores what this file decided and computes nothing.
//
// AND IT IS NOT A TOTAL. There is no total column, at any grain. See the long
// comment in operationsSegments.js on why `total` was deleted; a stored total
// is the same figure coming back through a table instead of through a function.
//
// THE CLASSIFICATION HAZARD, and the column that catches it.
// `buildCrmStateFromTables` recomputes the live/simulated/prop/cash split from
// each account's CURRENT record on every load, deliberately, so that correcting
// a misclassification fixes every close the client ever had. A stored summary
// freezes the classification it was built under. `account_names` is what makes
// that detectable rather than silent: the row names the accounts it counted, so
// a reader holding `trading_accounts` can re-ask `segmentForAccount` for each of
// them and refuse the row when the answer has moved. A refused row is not a
// wrong figure — the close simply reads as not summarised, and the app rebuilds
// it.

import { buildSegmentTotals, segmentForAccount } from './operationsSegments.js';

/**
 * The row that says "this close was summarised and it held no account rows".
 *
 * A close with no account rows is real: 8 of the 485 on the book are in that
 * state, one of them holding 15 orders against 0 accounts — the client's export
 * carried the fills and not the grid. Such a close produces no segment row, and
 * without this marker the table could not tell it apart from a close nobody has
 * summarised yet. One of those contributes nothing and is complete; the other
 * contributes nothing and is a hole, and a manager's basis line that called the
 * first a hole would be wrong 8 times on every screen.
 *
 * Deliberately NOT a member of SEGMENTS. It must never reach `segmentFor`,
 * `businessForSegment` or a roll-up — an unrecognised segment name lands in
 * `propOther` by design, and this one carries no money to land there with. It
 * is skipped on the way back in: a summary row with no accounts is a marker,
 * never a figure.
 */
export const EMPTY_CLOSE_SEGMENT = '(no account rows)';

/**
 * The summary rows for one close, in the shape the table stores.
 *
 * `dailyImport` is a close as the app holds it — live snapshots on `snapshots`,
 * the simulated and undetermined ones under `simulation` — because that is what
 * `buildSegmentTotals` reads and what reconcile produces at ingest.
 */
export function buildCloseSummaryRows({ accountRegistry = {}, dailyImport = null } = {}) {
  if (!dailyImport) return [];
  const totals = buildSegmentTotals(
    [{ client: { id: dailyImport.clientId || '', accountRegistry }, dailyImport }],
    { withAccountNames: true },
  );
  if (!totals.segments.length) {
    return [{
      segment: EMPTY_CLOSE_SEGMENT,
      accounts: 0,
      dailyPnl: 0,
      weeklyPnl: 0,
      balance: 0,
      countedInTotal: false,
      accountNames: [],
    }];
  }
  return totals.segments.map((row) => ({
    segment: row.segment,
    accounts: row.accounts,
    dailyPnl: round2(row.dailyPnl),
    weeklyPnl: round2(row.weeklyPnl),
    balance: round2(row.balance),
    countedInTotal: row.countedInTotal,
    accountNames: row.accountNames || [],
  }));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** The stored row, as the database column names spell it. */
export function closeSummaryToDb(row, { dailyImportId, clientId, tradingDate }) {
  return {
    daily_import_id: dailyImportId,
    client_id: clientId,
    trading_date: tradingDate,
    segment: row.segment,
    accounts: row.accounts,
    daily_pnl: row.dailyPnl,
    weekly_pnl: row.weeklyPnl,
    balance: row.balance,
    counted_in_total: row.countedInTotal,
    account_names: row.accountNames || [],
  };
}

/** The stored row, read back. */
export function closeSummaryFromRow(row = {}) {
  return {
    dailyImportId: row.daily_import_id || '',
    clientUuid: row.client_id || '',
    date: String(row.trading_date || '').slice(0, 10),
    segment: row.segment || '',
    accounts: Number(row.accounts || 0),
    dailyPnl: Number(row.daily_pnl || 0),
    weeklyPnl: Number(row.weekly_pnl || 0),
    balance: Number(row.balance || 0),
    // Never derived from the segment name here. The writer decided it from
    // EXCLUDED_FROM_TOTAL and stored it; re-deriving it on the way back is the
    // second implementation this file exists to avoid.
    countedInTotal: row.counted_in_total !== false,
    accountNames: Array.isArray(row.account_names) ? row.account_names : [],
  };
}

/**
 * The summary rows a close can still be read from, grouped by close.
 *
 * `registryByClientId` is each client's CURRENT account registry, which is what
 * makes the staleness check possible: a row whose named accounts no longer
 * segment the way they did when it was written is dropped, and the close it
 * belongs to is reported under `stale` rather than quietly reading low.
 *
 * A row naming an account the registry has never heard of is NOT stale. An
 * orphan close — the account was deleted or renamed underneath it — segments to
 * ORPHAN both then and now, and `segmentForAccount` answers that from the
 * absence itself.
 */
export function indexCloseSummaries(rows = [], { registryByClientId = {} } = {}) {
  const byImport = new Map();
  for (const row of rows || []) {
    if (!row?.dailyImportId) continue;
    if (!byImport.has(row.dailyImportId)) byImport.set(row.dailyImportId, []);
    byImport.get(row.dailyImportId).push(row);
  }

  const usable = new Map();
  const stale = new Set();
  for (const [importId, segments] of byImport) {
    let fresh = true;
    for (const row of segments) {
      const registry = registryByClientId[row.clientIdForRegistry || ''] || null;
      if (!registry) continue;
      for (const accountName of row.accountNames) {
        if (segmentForAccount(registry[accountName], accountName) !== row.segment) {
          fresh = false;
          break;
        }
      }
      if (!fresh) break;
    }
    if (fresh) usable.set(importId, segments);
    else stale.add(importId);
  }
  return { usable, stale };
}

/**
 * Attaches the app-level client id each row belongs to.
 *
 * The stored row carries the client UUID, and the registry is held against the
 * app id (`legacy_key` where there is one). Done once here rather than inside
 * the staleness loop, which would otherwise do the lookup per account name.
 */
export function attachClientIds(rows = [], clientIdByUuid = {}) {
  return (rows || []).map((row) => ({
    ...row,
    clientIdForRegistry: clientIdByUuid[row.clientUuid] || row.clientUuid,
  }));
}
