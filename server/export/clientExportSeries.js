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
// A LEAF module: it imports nothing, so it resolves under plain Node ESM the
// same way performanceSeries.js does. This file cannot reach
// operationsSegments.js for the same rule (its chain uses extension-less
// specifiers), which is why the nature is computed here from the classifier
// directly rather than from a segment.
import { ACCOUNT_NATURES, classifyAccountNature } from '../../src/domain/simulationAccounts.js';
import { buildAbsenceIndex } from './absentAccounts.js';

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

/** A trading date this payload can actually key a day on. See buildDays below. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

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
 *
 * UNDATED IMPORTS ARE DROPPED, and that is not tidiness. Every absence figure is
 * keyed on the trading date: absenceFor() resolves it through isoDay(), an
 * unparseable value comes back null, and `existsFrom > null` is false for every
 * account — so the whole registry clears the existence gate and none of it can
 * match a reported name. Feeding one dateless import to the 41-account client on
 * this book produced a day literally called "null" carrying 41 invented
 * absences, and pulled that client's reportRatePct from 51.2 to 43.9. That is
 * the failure this file exists to prevent, arriving through the calendar instead
 * of through the registry. adaptForLifecycle() in absentAccounts.js already
 * drops the same rows (`.filter((close) => close.date)`), so until now the two
 * halves of one day disagreed about whether the close existed at all.
 *
 * daily_imports.trading_date is `date not null` (supabase/cam_crm_schema.sql:101),
 * so this is defence and not a live count — 0 of the 535 imports on the real book
 * are undated. It is one filter, and what it guards against is a desk-wide false
 * alarm.
 */
/**
 * The nature of the money behind one snapshot row.
 *
 * `simulation_mode` is the CAM's explicit override and outranks everything; the
 * account_type and the Sim<number> naming come next. A row with no registry
 * account behind it (41 of 3,100 on the real book) is classified off its stored
 * account_name alone, which is what stops an unregistered Sim101 close from
 * being exported as real capital.
 */
function natureOf(account, snapshot) {
  return classifyAccountNature(
    {
      accountType: account?.account_type || '',
      simulationMode: account?.simulation_mode || '',
    },
    { accountName: snapshot?.account_name || account?.account_name || '' },
  ).nature;
}

/** Per-nature subtotals for the rows that are NOT real money. */
function summarizeExcluded(rows) {
  if (!rows.length) return null;
  const of = (nature) => {
    const picked = rows.filter((row) => row.nature === nature);
    if (!picked.length) return null;
    return {
      accounts: picked.length,
      realizedPnl: sumOrNull(picked.map((row) => row.realizedPnl)),
      unrealizedPnl: sumOrNull(picked.map((row) => row.unrealizedPnl)),
      accountBalance: sumOrNull(picked.map((row) => row.accountBalance)),
    };
  };
  return {
    accounts: rows.length,
    // Simulated funds. Not money, and never summed with anything that is.
    simulation: of(ACCOUNT_NATURES.SIMULATION),
    // Neither confirmed real nor confirmed simulated. Left out of both totals
    // rather than guessed into one of them.
    undetermined: of(ACCOUNT_NATURES.UNDETERMINED),
  };
}

function buildDays({
  clientId,
  imports,
  snapshotsByImport,
  strategyCountByImport,
  flagCountByImport,
  orderCountByImport,
  executionCountByImport,
  accountsById,
  includeTradeHistory,
  rangeFrom,
  absenceFor,
}) {
  const ordered = imports
    .filter((dailyImport) => ISO_DAY.test(String(dailyImport?.trading_date ?? '').slice(0, 10)))
    .sort((a, b) => String(a.trading_date).localeCompare(String(b.trading_date)));
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
        // accountType stays and the rest of the registry does not, and the
        // reason is correctness rather than payload size.
        //
        // accountStatus, riskLevel, startBalance, targetProfit and
        // maxDrawdownLimit are CURRENT registry values with no history behind
        // them. Stamping them onto a row dated 2026-07-13 asserts they held on
        // that date, and they did not: an account marked Failed today was very
        // likely Active in July, and 143 accounts on this book are past their
        // drawdown limit while still carrying status Active, so the column and
        // the day disagree in both directions. A reader summing "funded balance
        // in July" off these rows would be reading August's registry.
        //
        // accountType survives because it is what makes a figure legible at all
        // — "-1,240 on Tuesday" reads completely differently on a funded account
        // than on an evaluation — and because it is the most stable of the six.
        // It carries the same caveat in principle, stated in the export's
        // caveats block.
        //
        // The other five already travel whole and un-range-filtered in
        // tables.trading_accounts, joinable on the tradingAccountId every row
        // here carries, so nothing is lost — only the false implication that
        // they were the values of that day.
        //
        // This is NOT the fix for the response ceiling. It returns roughly 100
        // KB on the busiest CAM, and MAX_RESPONSE_BYTES in clientExport.js
        // explains why that is a rounding error against a structural problem.
        accountType: account?.account_type || null,
        // WHAT KIND OF MONEY THIS ROW IS, and why.
        //
        // Until 2026-08-11 a simulated close could not reach this table at all:
        // reconcile dropped every `sim*` row before anything was stored. That
        // filter is gone and simulated closes are now persisted alongside real
        // ones, so this payload started carrying them with nothing to say so.
        // Craig Weschke's 2026-08-06 is the measured case: his day exports as
        // balance 185,419.60 / realized -1,298.00 when the real figures are
        // 85,829.60 and 0.00 — his Sim101's 99,590.00 and its entire -1,298.00
        // loss attributed to him as money, in a payload whose whole purpose is
        // to feed an analysis outside the CRM.
        //
        // Recomputed from the account's CURRENT record rather than stored on the
        // snapshot, which is the same rule the app uses (supabaseStore.js): a
        // CAM correcting a misclassification fixes every historical close.
        nature: natureOf(account, snapshot),
        realizedPnl: numberOrNull(snapshot.gross_realized_pnl),
        unrealizedPnl: numberOrNull(snapshot.unrealized_pnl),
        accountBalance: numberOrNull(snapshot.account_balance),
        trailingMaxDrawdown: numberOrNull(snapshot.trailing_max_drawdown),
        weeklyPnlReported: numberOrNull(snapshot.weekly_pnl),
      };
    });

    const date = String(dailyImport.trading_date).slice(0, 10);
    // EVERY TOTAL BELOW IS REAL MONEY ONLY. `accounts` keeps every row of the
    // day, of every nature, because dropping one would hide a close that was
    // filed; the aggregates take the live ones. The rest are summed separately,
    // under their own labelled keys, so the payload states them instead of
    // either hiding them or adding them in.
    const liveRows = accounts.filter((row) => row.nature === ACCOUNT_NATURES.LIVE);
    const notLiveRows = accounts.filter((row) => row.nature !== ACCOUNT_NATURES.LIVE);
    const realizedPnl = sumOrNull(liveRows.map((row) => row.realizedPnl));
    const weekStart = weekStartOf(date);

    // Two week-to-date figures because they answer different questions and
    // disagree in a known way. `reported` is the platform's own accumulator,
    // which src/domain/capitalDetail.js measured as the NET one: it reconciled
    // against the balance move on 2,075 of 2,237 July pairs where gross managed
    // 1,656. `derivedInRange` is this export's own running sum, which is only
    // as complete as the range asked for.
    const weekToDateReported = sumOrNull(liveRows.map((row) => row.weeklyPnlReported));
    const runningWeek = weekStart ? derivedByWeek.get(weekStart) ?? null : null;
    const weekToDateDerived = realizedPnl === null && runningWeek === null
      ? null
      : cents((runningWeek === null ? 0 : runningWeek) + (realizedPnl === null ? 0 : realizedPnl));
    if (weekStart) derivedByWeek.set(weekStart, weekToDateDerived);

    const source = dailyImport.source_summary && typeof dailyImport.source_summary === 'object'
      ? dailyImport.source_summary
      : {};

    // The other half of the day. `accounts` above is whoever filed; this is every
    // registered account that did not, with the reason. Without it a live account
    // that simply did not trade is byte-for-byte identical in this payload to an
    // account that does not exist — 1,209 of 4,276 (client, day, account) slots on
    // the real book were in that state.
    const absence = absenceFor(clientId, date);

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
      absentAccounts: absence.absentAccounts,
      notYetRegisteredAccountIds: absence.notYetRegisteredAccountIds,
      coverage: absence.coverage,
      totals: {
        realizedPnl,
        unrealizedPnl: sumOrNull(liveRows.map((row) => row.unrealizedPnl)),
        accountBalance: sumOrNull(liveRows.map((row) => row.accountBalance)),
        // Snapshot rows filed this day, which is NOT the size of the book. The
        // book's size on this day is coverage.existedOnDay, and the gap between
        // the two is coverage.absent. Real-money rows only, like the three
        // figures above it — a count that included the simulated rows would be
        // the denominator of totals that do not.
        accounts: liveRows.length,
        // Stated, never added. Null when the day held nothing of that nature, so
        // "no simulated account" and "a simulated account that ended flat" are
        // different values rather than the same 0.
        excluded: summarizeExcluded(notLiveRows),
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
 * The range's filing record, as account-days rather than as days.
 *
 * A per-day `absent` count answers "was today thin"; nothing in the payload
 * answered "how much of this month did we actually see". The denominator is
 * account-days that COULD have been filed — every day summed over the accounts
 * that existed on it — so a client who added five accounts mid-range is not
 * charged for the days before they existed.
 *
 * `daysClientFiledNothing` is separated from the account counts on purpose: on
 * those days the absence is one fact about the collector, and rolling it into
 * `absentStillLive` would let a handful of missed imports read as a fleet that
 * stopped trading.
 */
function summarizeCoverage(days, uncollected, accountStarts) {
  const sum = (pick) => days.reduce((total, day) => total + pick(day.coverage), 0);
  const expected = sum((coverage) => coverage.existedOnDay);
  const reported = sum((coverage) => coverage.reported.count);
  const absent = sum((coverage) => coverage.absent.count);
  return {
    accountDaysExpected: expected,
    accountDaysReported: { count: reported, of: expected },
    accountDaysAbsent: { count: absent, of: expected },
    accountDaysAbsentMarkedIgnore: { count: sum((c) => c.absentMarkedIgnore.count), of: absent },
    accountDaysNotYetRegistered: sum((coverage) => coverage.notYetRegistered.count),
    // Every account whose start date had to be decided, once, each with the
    // date its absences begin counting from and where that date came from.
    // days[].notYetRegisteredAccountIds indexes into this. Named for what it
    // holds rather than for the count above it: it also carries the accounts
    // that existed all range but whose date_added contradicted a close they
    // appear in (existsFromBasis 'first-observed-report'), which is not a
    // not-yet-registered fact but is the same decision.
    accountStarts,
    reportedWithoutRegistryRow: sum((coverage) => coverage.reportedWithoutRegistryRow),
    // Same shape as days[].coverage.absentByReason — one `of` for the four
    // counts beside it — so a reader parses the key once, not twice.
    absentByReason: {
      of: expected,
      neverReportedInRange: sum((c) => c.absentByReason.neverReportedInRange),
      notYetReporting: sum((c) => c.absentByReason.notYetReporting),
      absentStillLive: sum((c) => c.absentByReason.absentStillLive),
      absentFinished: sum((c) => c.absentByReason.absentFinished),
    },
    // Two different collection failures, kept apart. `daysClientFiledNothing`
    // is an import that arrived carrying no account rows at all — 12 of the 535
    // imports on the real book, and every one of them belongs to a client whose
    // registry was still empty on that date, which is why they contribute 0
    // absences rather than 23 invented ones. `uncollected` is the heavier one:
    // dates the desk was filing and this client produced no import whatsoever.
    daysClientFiledNothing: {
      count: days.filter((day) => day.coverage.clientFiledNothing).length,
      of: days.length,
    },
    uncollected,
    // Null, never 0: with no day carrying a denominator there is no rate to
    // report, and 0% would read as "this client filed nothing".
    reportRatePct: expected ? Math.round((reported / expected) * 1000) / 10 : null,
  };
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
function summarize(days, uncollected, accountStarts) {
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
    coverage: summarizeCoverage(days, uncollected, accountStarts),
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

  // Built once for the whole payload rather than per client: it runs the shared
  // lifecycle classifier one pass per distinct trading date, and the dates are
  // shared across clients (21 of them on the whole real book).
  const { absenceFor, uncollectedFor, startsFor } = buildAbsenceIndex({
    clients: clients || [],
    tradingAccounts: tradingAccounts || [],
    dailyImports: dailyImports || [],
    accountSnapshots: accountSnapshots || [],
    strategySnapshots: strategySnapshots || [],
    orders: orders || [],
    executions: executions || [],
  });

  return (clients || []).map((client) => {
    const days = buildDays({
      clientId: client.id,
      imports: importsByClient.get(client.id) || [],
      snapshotsByImport,
      strategyCountByImport,
      flagCountByImport,
      orderCountByImport,
      executionCountByImport,
      accountsById,
      includeTradeHistory,
      rangeFrom,
      absenceFor,
    });
    return {
      clientId: client.id,
      clientName: client.name || null,
      clientStatus: client.status || null,
      days,
      summary: summarize(
        days,
        uncollectedFor(client.id, days.map((day) => day.date)),
        startsFor(client.id),
      ),
    };
  });
}
