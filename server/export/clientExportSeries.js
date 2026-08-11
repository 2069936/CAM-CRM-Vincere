// The continuity view of a CAM-scoped export.
//
// The CRM already answers "what happened today" — that is what the daily close
// and the CSV drop are. Everything a CAM wants to do OUTSIDE the CRM needs the
// run of sessions instead: whether a bad Tuesday is a pattern, how many of the
// last twenty closes were green, whether an account has been drifting for a
// fortnight. A payload of raw tables can answer that only after the consumer
// re-derives the joins, and the joins are where the real book bites.
//
// Deriving it once, here, is not convenience. On public/local-snapshot.json
// (136 clients, 764 accounts, 3,100 account_snapshots over 21 closes):
//   - 41 of 3,100 account_snapshots carry a null trading_account_id, so a join
//     that assumes an account silently drops them together with their P&L;
//   - 101 of 764 account names belong to more than one client, so keying a
//     series on the account name alone merges two people's books
//     (see the same finding in src/domain/capitalDetail.js);
//   - account_snapshots has no date column at all — the trading date only
//     exists on the parent daily_import.
// Every consumer re-deriving that gets it wrong quietly. Once, here, is better.

import { buildPerformanceSeries, summarizePerformance } from '../../src/domain/performanceSeries.js';

/**
 * The realized-P&L caveat, carried in the payload rather than assumed known.
 *
 * src/domain/csvImport.js:244 is `realizedPnl !== 0 ? realizedPnl : grossRealizedPnl`.
 * "Realized PnL" from a NinjaTrader export is net of commissions; "Gross
 * realized PnL" is not. So the SAME column means net on every row where the CSV
 * carried a non-zero net figure and gross everywhere else — per row, not per
 * import. src/domain/capitalDetail.js measured the size of it: on account
 * 1071787 every residual between the balance move and this field is an exact
 * multiple of 3.76, the round-turn commission.
 *
 * An analyst summing a month of this is mixing two definitions. That cannot be
 * fixed here — the information needed to separate them was not stored — so it
 * is stated instead of papered over.
 */
export const PNL_BASIS = 'mixed-gross-and-net';

export const PNL_BASIS_NOTE = 'account_snapshots.gross_realized_pnl is net of commissions on rows whose source CSV carried a non-zero "Realized PnL", and gross of commissions on every other row (src/domain/csvImport.js:244). It is not consistently gross despite the column name. Totals derived from it in this payload inherit the same mixture.';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sum that keeps "nothing was reported" distinct from "the total was zero".
 *
 * weekly_pnl is the field that makes this matter: 1,270 of 3,100 snapshots on
 * the real book hold a literal 0, which is a real flat week, while a missing
 * column in the source CSV stores null. src/domain/supabaseStore.js:84 collapses
 * both to 0 for the UI; an export that did the same would tell the analysis a
 * client broke even on a week nobody measured.
 */
function sumOrNull(values) {
  let total = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total === null ? 0 : total) + value;
  }
  return cents(total);
}

/**
 * Cents, on derived figures only.
 *
 * Summing five snapshots on the real book produces -1187.99999999999 for what
 * is plainly -1188.00; the stored values themselves already carry the artefact
 * (account 26deaaf7 holds -423.999999999996). Aggregates are rounded so the
 * analysis is not reading binary floating point as precision, while the
 * per-account figures below are passed through exactly as stored — that is what
 * makes the series reconcilable against `tables.account_snapshots` row by row.
 */
function cents(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

/**
 * Monday of the ISO week, as YYYY-MM-DD.
 *
 * Same rule as the exported weekStart in src/domain/capitalDetail.js, restated
 * rather than imported: that module's dependency chain (operationsSegments →
 * reconcile → tradingDayScope) uses extension-less specifiers, which Vite
 * resolves and plain Node ESM — what a Vercel function runs — does not.
 * src/domain/performanceSeries.js imports nothing, which is why that one can be
 * reused directly below.
 */
export function weekStartOf(date) {
  const at = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const value = row?.[key];
    if (value === null || value === undefined) continue;
    const bucket = map.get(value);
    if (bucket) bucket.push(row);
    else map.set(value, [row]);
  }
  return map;
}

function countBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const value = row?.[key];
    if (value === null || value === undefined) continue;
    map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
}

/**
 * Per-day, per-account P&L for one client, ordered oldest first.
 *
 * The account identity carried alongside each figure is the point of including
 * trading_accounts in the payload at all: "-1,240 on Tuesday" reads completely
 * differently on a funded account than on an evaluation, and the snapshot rows
 * do not say which they are.
 */
function buildDays({
  imports,
  snapshotsByImport,
  strategyCountByImport,
  flagCountByImport,
  orderCountByImport,
  executionCountByImport,
  accountsById,
  includeTradeHistory,
  rangeFrom,
}) {
  const ordered = [...imports].sort((a, b) => String(a.trading_date).localeCompare(String(b.trading_date)));
  const derivedByWeek = new Map();

  return ordered.map((dailyImport) => {
    const snapshots = snapshotsByImport.get(dailyImport.id) || [];
    const accounts = snapshots.map((snapshot) => {
      const account = snapshot.trading_account_id ? accountsById.get(snapshot.trading_account_id) || null : null;
      return {
        accountSnapshotId: snapshot.id,
        // Null, not the snapshot's own name-as-id: 41 of 3,100 snapshots on the
        // real book have no account row behind them, and pretending otherwise
        // would attach their P&L to whatever account shares the name.
        tradingAccountId: snapshot.trading_account_id || null,
        accountName: snapshot.account_name || null,
        accountType: account?.account_type || null,
        accountStatus: account?.status || null,
        riskLevel: account?.risk_level || null,
        startBalance: numberOrNull(account?.start_balance),
        targetProfit: numberOrNull(account?.target_profit),
        maxDrawdownLimit: numberOrNull(account?.max_drawdown_limit),
        realizedPnl: numberOrNull(snapshot.gross_realized_pnl),
        unrealizedPnl: numberOrNull(snapshot.unrealized_pnl),
        accountBalance: numberOrNull(snapshot.account_balance),
        trailingMaxDrawdown: numberOrNull(snapshot.trailing_max_drawdown),
        weeklyPnlReported: numberOrNull(snapshot.weekly_pnl),
      };
    });

    const date = String(dailyImport.trading_date).slice(0, 10);
    const realizedPnl = sumOrNull(accounts.map((row) => row.realizedPnl));
    const weekStart = weekStartOf(date);

    // Two week-to-date figures because they answer different questions and
    // disagree in a known way. `reported` is the platform's own accumulator,
    // which src/domain/capitalDetail.js measured as the NET one: it reconciled
    // against the balance move on 2,075 of 2,237 July pairs where gross managed
    // 1,656. `derivedInRange` is this export's own running sum, which is only
    // as complete as the range asked for.
    const weekToDateReported = sumOrNull(accounts.map((row) => row.weeklyPnlReported));
    const runningWeek = weekStart ? derivedByWeek.get(weekStart) ?? null : null;
    const weekToDateDerived = realizedPnl === null && runningWeek === null
      ? null
      : cents((runningWeek === null ? 0 : runningWeek) + (realizedPnl === null ? 0 : realizedPnl));
    if (weekStart) derivedByWeek.set(weekStart, weekToDateDerived);

    const source = dailyImport.source_summary && typeof dailyImport.source_summary === 'object'
      ? dailyImport.source_summary
      : {};

    return {
      date,
      dailyImportId: dailyImport.id,
      // Closed 465, Needs review 60, Ready to close 10 on the real book. A
      // "how many sessions were green" answer that ignores this counts
      // unreviewed days alongside signed-off ones.
      status: dailyImport.status || null,
      importedAt: dailyImport.imported_at || null,
      sourceType: dailyImport.source_type || null,
      accounts,
      totals: {
        realizedPnl,
        unrealizedPnl: sumOrNull(accounts.map((row) => row.unrealizedPnl)),
        accountBalance: sumOrNull(accounts.map((row) => row.accountBalance)),
        accounts: accounts.length,
      },
      week: {
        weekStart,
        // The derived figure is missing the part of the week that fell before
        // the range. Saying so is the difference between "flat week" and
        // "we only looked at Thursday".
        startsBeforeRange: Boolean(weekStart && rangeFrom && weekStart < rangeFrom),
        toDateReported: weekToDateReported,
        toDateDerivedInRange: weekToDateDerived,
      },
      counts: {
        accountSnapshots: accounts.length,
        strategySnapshots: strategyCountByImport.get(dailyImport.id) || 0,
        operationalFlags: flagCountByImport.get(dailyImport.id) || 0,
        // Without trade history the rows are not in the payload, so the count
        // comes from daily_imports.source_summary, which the importer already
        // wrote. Null rather than 0 when neither source exists — a day with no
        // orders and a day nobody counted are not the same day.
        orders: includeTradeHistory ? (orderCountByImport.get(dailyImport.id) || 0) : numberOrNull(source.orders),
        executions: includeTradeHistory
          ? (executionCountByImport.get(dailyImport.id) || 0)
          : numberOrNull(source.executions),
        countedFrom: includeTradeHistory ? 'exported_rows' : 'daily_imports.source_summary',
      },
    };
  });
}

/**
 * Chain-linked return and drawdown, from the shared implementation.
 *
 * src/domain/performanceSeries.js is what the client report already draws, so
 * a percentage in this export and a percentage on the CAM's screen come from
 * the same code and cannot drift. It reads `dailyPnl` as a number, so a day
 * with no determinable P&L enters it as flat; `daysWithoutPnl` below counts
 * those so the flat days are not mistaken for measured ones.
 */
function summarize(days) {
  if (!days.length) return null;
  const points = buildPerformanceSeries(days.map((day) => ({
    date: day.date,
    dailyPnl: day.totals.realizedPnl === null ? 0 : day.totals.realizedPnl,
    balance: day.totals.accountBalance === null ? 0 : day.totals.accountBalance,
    accounts: day.totals.accounts,
  })));
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const day of days) {
    const point = byDate.get(day.date) || null;
    day.cumulative = point
      ? {
        pnl: cents(point.cumulativePnl),
        capitalBase: cents(point.capitalBase),
        dailyReturnPct: point.dailyReturnPct,
        cumulativeReturnPct: point.cumulativeReturnPct,
      }
      : null;
  }

  const performance = summarizePerformance(points);
  const determined = days.filter((day) => day.totals.realizedPnl !== null);
  // bestDay/worstDay come out of `points`, where an undetermined day was fed in
  // as 0 so the chain-linked return could be computed at all. Reporting that 0
  // back as a day's P&L invents a measurement: a client with one session and no
  // snapshot rows was returning `daysWithoutPnl: 1` alongside
  // `bestDay: { date: "2026-07-13", pnl: 0 }` — a flat day nobody measured,
  // dressed as a flat day somebody did. Both are only meaningful over days
  // whose P&L was actually determined, so both are keyed off that set.
  const determinedDates = new Set(determined.map((day) => day.date));
  const extreme = (candidate) => (
    candidate && determinedDates.has(candidate.date)
      ? { date: candidate.date, pnl: cents(candidate.dailyPnl) }
      : null
  );
  return {
    sessions: days.length,
    firstSession: days[0].date,
    lastSession: days[days.length - 1].date,
    positiveSessions: determined.filter((day) => day.totals.realizedPnl > 0).length,
    negativeSessions: determined.filter((day) => day.totals.realizedPnl < 0).length,
    flatSessions: determined.filter((day) => day.totals.realizedPnl === 0).length,
    daysWithoutPnl: days.length - determined.length,
    closedSessions: days.filter((day) => day.status === 'Closed').length,
    netPnl: determined.length ? cents(performance.netPnl) : null,
    returnPct: performance.returnPct,
    maxDrawdown: determined.length ? cents(performance.maxDrawdown) : null,
    bestDay: extreme(performance.bestDay),
    worstDay: extreme(performance.worstDay),
    pnlBasis: PNL_BASIS,
  };
}

/**
 * One entry per requested client, whether or not the client traded in the range.
 *
 * A client with no sessions is emitted with an empty `days` array and a null
 * summary rather than dropped. 38 of the 136 clients on the real book have no
 * import at all; if they vanished from the payload the analysis downstream
 * would read the absence as a data problem instead of as a quiet month.
 */
export function buildClientSeries({
  clients = [],
  tradingAccounts = [],
  dailyImports = [],
  accountSnapshots = [],
  strategySnapshots = [],
  operationalFlags = [],
  orders = [],
  executions = [],
  includeTradeHistory = false,
  rangeFrom = null,
} = {}) {
  const accountsById = new Map((tradingAccounts || []).map((row) => [row.id, row]));
  const importsByClient = groupBy(dailyImports, 'client_id');
  const snapshotsByImport = groupBy(accountSnapshots, 'daily_import_id');
  const strategyCountByImport = countBy(strategySnapshots, 'daily_import_id');
  const flagCountByImport = countBy(operationalFlags, 'daily_import_id');
  const orderCountByImport = countBy(orders, 'daily_import_id');
  const executionCountByImport = countBy(executions, 'daily_import_id');

  return (clients || []).map((client) => {
    const days = buildDays({
      imports: importsByClient.get(client.id) || [],
      snapshotsByImport,
      strategyCountByImport,
      flagCountByImport,
      orderCountByImport,
      executionCountByImport,
      accountsById,
      includeTradeHistory,
      rangeFrom,
    });
    return {
      clientId: client.id,
      clientName: client.name || null,
      clientStatus: client.status || null,
      days,
      summary: summarize(days),
    };
  });
}
