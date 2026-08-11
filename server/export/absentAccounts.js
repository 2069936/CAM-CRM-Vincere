// The other half of a trading day: the registered accounts that did NOT file.
//
// THE HOLE THIS FILLS. server/export/clientExportSeries.js gives each day an
// `accounts` array built from that day's account_snapshots — whoever reported.
// An account that exists, is live, and simply did not trade produces no snapshot
// row, so it is missing from the day entirely and is indistinguishable in the
// payload from an account that does not exist. Downstream that reads as "nothing
// there", which is the same class of mistake that once told a client who made
// $589 there were no trades. On public/local-snapshot.json the hole is 1,209
// (client, day, account) slots out of 4,276 that a complete book would carry —
// 28% of the book was invisible on any given day.
//
// WHAT IT IS NOT. This file does not decide whether an account is finished. That
// question already has an answer in src/domain/accountLifecycle.js, which refuses
// to call an account dead on the status column alone for reasons measured on this
// same book (124 accounts breached and were never marked; 6 marked with no breach
// on record). This file adapts the export's raw rows into the shape that module
// reads, asks it once per trading date, and reports what it says.

import { LIFECYCLE_STATES, buildAccountLifecycleStates } from '../../src/domain/accountLifecycle.js';
import { ACCOUNT_NATURES, classifyAccountNature } from '../../src/domain/simulationAccounts.js';
import { ACCOUNT_TYPES } from '../../src/domain/reconcile.js';

/**
 * Why an account is not in a day's `accounts` array.
 *
 * Five, not one, because they call for five different actions: chase the
 * collector, chase the client, look at the account, look at nothing, or look at
 * the calendar. Collapsing them into "absent" would put "registered yesterday"
 * next to "breached and stopped" in the same bucket.
 */
export const ABSENCE_REASONS = {
  NEVER_REPORTED_IN_RANGE: 'never-reported-in-range',
  NOT_YET_REPORTING: 'not-yet-reporting',
  ABSENT_STILL_LIVE: 'absent-still-live',
  ABSENT_FINISHED: 'absent-finished',
  NOT_YET_REGISTERED: 'not-yet-registered',
};

export const ABSENCE_REASON_TEXT = {
  'never-reported-in-range': 'Registered and existed on this day, and filed no snapshot on ANY day of the exported range. Recently wired up, or never wired up at all — this is not evidence that it stopped, because there is nothing it stopped from.',
  'not-yet-reporting': 'Existed on this day and had not filed yet as of this day, but it does file later inside the range. Its first close is still ahead of this date; absence here is a start-up gap, not a stop.',
  'absent-still-live': 'Filed on an earlier day of the range, did not file on this one, and the lifecycle evidence as of this day says it is still live (running / quiet / stale / not enough to say). THIS is "it exists and it did not work today".',
  'absent-finished': 'Filed on an earlier day of the range, did not file on this one, and its last trailing-drawdown reading on or before this day is a breach under its own model (src/domain/accountLifecycle.js). Absence here is the expected end of an account, not a gap to chase.',
  'not-yet-registered': 'Excluded from the absence counts for this day: the earliest date this account can be shown to have existed is AFTER this day, so it could not have filed. Listing it as absent would invent an absence.',
};

/** Where an account's earliest provable existence date came from. */
export const EXISTS_FROM_BASIS = {
  DATE_ADDED: 'date_added',
  FIRST_OBSERVED_REPORT: 'first-observed-report',
  UNKNOWN: 'unknown',
};

/**
 * How an account's start date is decided, and why created_at is not in it.
 *
 * MEASURED ON THE REAL BOOK, because getting this wrong in the manufacturing
 * direction is the worst outcome available here — a bad rule makes every
 * historical day look like a desk that stopped working.
 *
 *   - trading_accounts.created_at is populated on 764 of 764, and is worthless
 *     as a birth date: every value falls in 2026-07-01..2026-07-30 and 573 of
 *     them land on just three days (242 on 07-13, 229 on 07-15, 102 on 07-22).
 *     It is the CRM migration timestamp. 246 of the 720 accounts that ever
 *     appear in a close were "created" AFTER the first close they appear in.
 *   - trading_accounts.date_added is populated on 764 of 764 and is much closer
 *     to a real date, but it is a desk-entry date and it lags: 229 of those 720
 *     accounts carry a date_added LATER than the first close they reported in
 *     (worst gap 3 days). Used alone it contradicts the book 237 times.
 *
 * So neither column alone is trustworthy, and the rule is the earlier of the two
 * things that CAN be evidence:
 *
 *     existsFrom = min(date_added, first date this account was actually observed)
 *
 * An observed close is proof of existence that no column can override. Sweeping
 * the whole book this scores 0 contradictions against 237 for date_added and 339
 * for created_at, and it excludes 374 of 1,583 candidate absences (24%) as
 * not-yet-existing.
 *
 * When neither is available the account is excluded from the absence counts and
 * listed separately with basis 'unknown', never counted as absent. Omitting an
 * absence understates a problem; inventing one manufactures a crisis on every
 * day before the account existed. On this book that case is 0 accounts.
 */
function existsFromOf(account, firstObservedDate) {
  const added = isoDay(account?.date_added);
  const observed = isoDay(firstObservedDate);
  if (added && observed) {
    return added <= observed
      ? { date: added, basis: EXISTS_FROM_BASIS.DATE_ADDED }
      // date_added is later than a close this account is IN. The close wins.
      : { date: observed, basis: EXISTS_FROM_BASIS.FIRST_OBSERVED_REPORT };
  }
  if (added) return { date: added, basis: EXISTS_FROM_BASIS.DATE_ADDED };
  if (observed) return { date: observed, basis: EXISTS_FROM_BASIS.FIRST_OBSERVED_REPORT };
  return { date: null, basis: EXISTS_FROM_BASIS.UNKNOWN };
}

function isoDay(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function nameKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function push(map, key, value) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * The export's raw PostgREST rows in the shape src/domain/accountLifecycle.js
 * reads, so that classifier is reused rather than re-implemented.
 *
 * Two joins the raw rows do not carry:
 *   - orders and executions hold a trading_account_id and no account name (their
 *     `name` column is a person). activityIndex() keys on the account name, so
 *     the id is resolved through the registry first; a row whose id resolves to
 *     nothing contributes no activity rather than a wrong account's activity.
 *   - account_snapshots carry their own account_name, and 41 of 3,100 on the real
 *     book carry a NULL trading_account_id. Keying on the name inside one client
 *     is safe here and recovers 8 of those 41: account_name has 0 collisions
 *     within a client on this book, even though 101 names collide across clients.
 */
export function adaptForLifecycle({
  clients = [],
  tradingAccounts = [],
  dailyImports = [],
  accountSnapshots = [],
  orders = [],
  executions = [],
} = {}) {
  const accountsById = new Map(tradingAccounts.map((row) => [row.id, row]));
  const importsByClient = new Map();
  for (const row of dailyImports) push(importsByClient, row.client_id, row);
  const snapshotsByImport = new Map();
  for (const row of accountSnapshots) push(snapshotsByImport, row.daily_import_id, row);
  const ordersByImport = new Map();
  for (const row of orders) push(ordersByImport, row.daily_import_id, row);
  const executionsByImport = new Map();
  for (const row of executions) push(executionsByImport, row.daily_import_id, row);
  const registryByClient = new Map();
  for (const row of tradingAccounts) {
    if (!registryByClient.has(row.client_id)) registryByClient.set(row.client_id, {});
    registryByClient.get(row.client_id)[row.account_name || row.id] = {
      accountName: row.account_name || row.id,
      alias: row.alias || null,
      accountType: row.account_type || '',
      status: row.status || '',
      dateAdded: row.date_added || null,
      dateFailed: row.date_failed || null,
      dateFunded: row.date_funded || null,
      algoStack: row.algo_stack || null,
      maxDrawdownLimit: numberOrNull(row.max_drawdown_limit),
    };
  }

  const nameOf = (id) => (id ? accountsById.get(id)?.account_name || null : null);

  return clients.map((client) => ({
    id: client.id,
    name: client.name || client.id,
    accountRegistry: registryByClient.get(client.id) || {},
    dailyImports: (importsByClient.get(client.id) || []).map((dailyImport) => ({
      date: isoDay(dailyImport.trading_date),
      snapshots: (snapshotsByImport.get(dailyImport.id) || []).map((snapshot) => ({
        accountName: snapshot.account_name || nameOf(snapshot.trading_account_id),
        accountBalance: numberOrNull(snapshot.account_balance),
        grossRealizedPnl: numberOrNull(snapshot.gross_realized_pnl),
        trailingMaxDrawdown: numberOrNull(snapshot.trailing_max_drawdown),
      })),
      orders: (ordersByImport.get(dailyImport.id) || []).map((order) => ({
        accountName: nameOf(order.trading_account_id),
        filled: order.filled,
        state: order.state,
      })),
      executions: (executionsByImport.get(dailyImport.id) || []).map((execution) => ({
        accountName: nameOf(execution.trading_account_id),
      })),
    })).filter((close) => close.date),
  }));
}

/**
 * The strategies an absent account was last seen carrying, and whether they were
 * on.
 *
 * This is what makes "these carry this algorithm and did not run today"
 * answerable at all. Two different facts are carried side by side because they
 * disagree: `algoStack` is what the desk ASSIGNED the account (trading_accounts.
 * algo_stack, a free-text column), and `lastStrategies` is what the platform last
 * actually REPORTED on it, dated. An absent account has no strategy_snapshots for
 * the day by construction, so the rows come from its most recent close on or
 * before the day, and that close's date travels with them.
 */
function strategiesOf(rows) {
  return rows.map((row) => ({
    strategyName: row.strategy_name || null,
    strategyFamily: row.strategy_family || null,
    strategyVersion: row.strategy_version || null,
    instrument: row.instrument || null,
    direction: row.direction || null,
    // Tri-state on purpose. `enabled` is nullable and a null means the import
    // carried no such column, which is not the same claim as "it was switched
    // off" — the whole point of this payload is that an unstated fact must not
    // arrive as a stated one.
    enabled: row.enabled === null || row.enabled === undefined ? null : Boolean(row.enabled),
  }));
}

/**
 * Per-client, per-day absence, built once for a whole payload.
 *
 * Returns `absenceFor(clientId, date)`, which clientExportSeries.js calls for
 * each day it emits.
 *
 * The lifecycle classifier is asked once per DISTINCT TRADING DATE in the
 * payload, with asOf pinned to that date, because "is it finished" is a question
 * about a moment: an account that breached on 2026-07-30 was not finished on
 * 2026-07-13, and answering every day with the end-of-range verdict would
 * backdate 76 of this book's breaches — all of them dated 2026-07-30 — across the
 * whole month behind them. The book holds 21 distinct dates, so this is 21 passes.
 */
export function buildAbsenceIndex({
  clients = [],
  tradingAccounts = [],
  dailyImports = [],
  accountSnapshots = [],
  strategySnapshots = [],
  orders = [],
  executions = [],
} = {}) {
  const clientIds = new Set(clients.map((client) => client.id));
  const accountsByClient = new Map();
  for (const account of tradingAccounts) {
    if (!clientIds.has(account.client_id)) continue;
    push(accountsByClient, account.client_id, account);
  }

  // (clientId, accountNameKey) -> sorted list of dates it filed a snapshot on,
  // and (clientId, date) -> the set of registry names that filed.
  const datesByAccount = new Map();
  const reportedByDay = new Map();
  const orphansByDay = new Map();
  const snapshotCountByDay = new Map();
  const importIdByAccountDate = new Map();
  const importsById = new Map(dailyImports.map((row) => [row.id, row]));
  const registryNames = new Map();
  for (const [clientId, accounts] of accountsByClient) {
    registryNames.set(clientId, new Set(accounts.map((account) => nameKey(account.account_name))));
  }

  const accountsById = new Map(tradingAccounts.map((row) => [row.id, row]));
  for (const snapshot of accountSnapshots) {
    const dailyImport = importsById.get(snapshot.daily_import_id);
    if (!dailyImport || !clientIds.has(dailyImport.client_id)) continue;
    const date = isoDay(dailyImport.trading_date);
    if (!date) continue;
    const clientId = dailyImport.client_id;
    const dayKey = `${clientId}|${date}`;
    snapshotCountByDay.set(dayKey, (snapshotCountByDay.get(dayKey) || 0) + 1);
    const key = nameKey(snapshot.account_name)
      || nameKey(accountsById.get(snapshot.trading_account_id)?.account_name);
    if (!key) continue;
    if (!registryNames.get(clientId)?.has(key)) {
      orphansByDay.set(dayKey, (orphansByDay.get(dayKey) || 0) + 1);
      continue;
    }
    if (!reportedByDay.has(dayKey)) reportedByDay.set(dayKey, new Set());
    reportedByDay.get(dayKey).add(key);
    const accountKey = `${clientId}|${key}`;
    if (!datesByAccount.has(accountKey)) datesByAccount.set(accountKey, new Set());
    datesByAccount.get(accountKey).add(date);
    importIdByAccountDate.set(`${accountKey}|${date}`, dailyImport.id);
  }
  const sortedDatesByAccount = new Map(
    [...datesByAccount].map(([key, set]) => [key, [...set].sort()]),
  );

  // strategy_snapshots keyed by (importId, accountNameKey). 61 of 3,805 rows on
  // the real book carry a null trading_account_id, so the id is resolved to a
  // name and rows that resolve to nothing are dropped rather than attached to
  // whichever account happens to sort first.
  const strategiesByImportAccount = new Map();
  for (const row of strategySnapshots) {
    const key = nameKey(accountsById.get(row.trading_account_id)?.account_name);
    if (!key) continue;
    push(strategiesByImportAccount, `${row.daily_import_id}|${key}`, row);
  }

  // One lifecycle pass per distinct trading date across the whole payload.
  const adapted = adaptForLifecycle({ clients, tradingAccounts, dailyImports, accountSnapshots, orders, executions });
  const allDates = [...new Set(dailyImports.map((row) => isoDay(row.trading_date)).filter(Boolean))].sort();
  const lifecycleByDate = new Map();
  for (const date of allDates) {
    const states = buildAccountLifecycleStates(adapted, { asOf: date });
    const byAccount = new Map();
    for (const record of states.accounts) {
      byAccount.set(`${record.clientId}|${nameKey(record.accountName)}`, record);
    }
    lifecycleByDate.set(date, byAccount);
  }

  function absenceFor(clientId, date) {
    const day = isoDay(date);
    const accounts = accountsByClient.get(clientId) || [];
    const dayKey = `${clientId}|${day}`;
    const reported = reportedByDay.get(dayKey) || new Set();
    const orphanReports = orphansByDay.get(dayKey) || 0;
    const snapshotRows = snapshotCountByDay.get(dayKey) || 0;
    const lifecycle = lifecycleByDate.get(day) || new Map();

    // The collection-vs-account distinction, decided once for the day. An import
    // exists (this function is only called for days that have one) but carries no
    // snapshot rows at all: 12 of the 535 imports on the real book are in that
    // state, one of them holding 19 executions and 7 operational flags against 0
    // accounts. Every absence on such a day is one fact about the collector, not
    // N facts about N accounts, and counting it the other way would read as a
    // desk-wide shutdown.
    const clientFiledNothing = snapshotRows === 0;

    const absent = [];
    const notYetRegistered = [];
    const counts = {
      [ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE]: 0,
      [ABSENCE_REASONS.NOT_YET_REPORTING]: 0,
      [ABSENCE_REASONS.ABSENT_STILL_LIVE]: 0,
      [ABSENCE_REASONS.ABSENT_FINISHED]: 0,
    };
    let ignored = 0;
    let simulated = 0;

    for (const account of accounts) {
      const key = nameKey(account.account_name);
      const accountKey = `${clientId}|${key}`;
      const reportedDates = sortedDatesByAccount.get(accountKey) || [];
      const existence = existsFromOf(account, reportedDates[0] || null);

      if (!existence.date || existence.date > day) {
        notYetRegistered.push(account.id);
        continue;
      }
      if (reported.has(key)) continue;

      const priorDates = reportedDates.filter((seen) => seen < day);
      const lastReportedDate = priorDates.length ? priorDates[priorDates.length - 1] : null;
      const record = lifecycle.get(accountKey) || null;

      // Marked 'Inactive / Ignore' by the desk. Kept in the absence list, never
      // filtered out of it, but counted separately because it swamps the
      // headline: 84 of 764 accounts on the real book carry this type, 12 of
      // them never appear in any close, and for the largest client 72 of its 74
      // never-reported-in-range account-days are ignore-marked accounts. A
      // reader who saw only "74 never reported" would go looking for a
      // collection failure that is really a shelf of retired accounts.
      const markedIgnore = account.account_type === ACCOUNT_TYPES.IGNORE;
      if (markedIgnore) ignored += 1;

      // A registered simulation account only appears in the grid while somebody
      // has it loaded, so it is absent on most closes by design. reconcile.js
      // exempts it from the CRM's own Missing-account sweep for exactly that
      // reason; without the same exemption here the export's report rate falls
      // by one account-day per client per close forever, and the desk reads a
      // collection failure that is a simulator sitting idle.
      //
      // Counted apart rather than filtered out, the same way markedIgnore is:
      // the row stays in `absentAccounts` so nothing disappears from the
      // payload, and the headline stops charging for it.
      const isSimulated = classifyAccountNature(
        { accountType: account.account_type || '', simulationMode: account.simulation_mode || '' },
        { accountName: account.account_name || '' },
      ).nature === ACCOUNT_NATURES.SIMULATION;
      if (isSimulated) simulated += 1;

      let reason;
      if (!reportedDates.length) reason = ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE;
      else if (!lastReportedDate) reason = ABSENCE_REASONS.NOT_YET_REPORTING;
      else if (record?.state === LIFECYCLE_STATES.FINISHED) reason = ABSENCE_REASONS.ABSENT_FINISHED;
      else reason = ABSENCE_REASONS.ABSENT_STILL_LIVE;
      counts[reason] += 1;

      const strategyRows = lastReportedDate
        ? strategiesByImportAccount.get(
          `${importIdByAccountDate.get(`${accountKey}|${lastReportedDate}`)}|${key}`,
        ) || []
        : [];

      // WHAT IS NOT ON THIS OBJECT, AND WHY.
      //
      // Every static registry attribute — alias, risk_level, start_balance,
      // target_profit, max_drawdown_limit, date_added — is deliberately absent.
      // tables.trading_accounts travels un-range-filtered in the same payload
      // (clientExport.js:502) precisely so it can be joined on
      // tradingAccountId, and repeating it once per absent account per day is
      // pure duplication: it measured 35 KB of the 337 KB this array costs the
      // busiest CAM over a 30-day pull, on an endpoint whose headline case was
      // already at 95% of the 4 MiB response ceiling. accountType and
      // accountStatus stay because they change how the absence READS and the
      // payload should not need a join to be legible.
      //
      // `reasonText` is likewise not here: five constant sentences repeated 266
      // times was 67 KB, and they are emitted once as the payload's
      // absenceReasons legend instead.
      absent.push({
        tradingAccountId: account.id,
        accountName: account.account_name || null,
        accountType: account.account_type || null,
        // The DECLARED status, and never the basis for `reason`. 48 accounts on
        // this book are marked Failed and 30 of them appear in their client's
        // most recent close; the reason above comes from the observed drawdown,
        // and this column is carried beside it so the disagreement is visible.
        accountStatus: account.status || null,
        // No realizedPnl, no accountBalance, no zeroes anywhere on this object:
        // "did not report" and "reported 0.00" are different facts and the export
        // must never let one wear the other's clothes. What IS known about this
        // account is in `lastReported` below, carrying the date it was true on.
        reported: false,
        markedIgnore,
        reason,
        lastReportedDate,
        closesReportedBeforeThisDay: priorDates.length,
        // What the desk ASSIGNED. Kept even though it is nearly always null —
        // algo_stack is populated on 8 of 764 accounts on the real book, which
        // is itself the reason lastStrategies below exists: the observed
        // strategy rows are the only usable answer to "what was this running".
        algoStack: account.algo_stack || null,
        // Dated by lastReportedDate above: these are the strategies from the
        // last close this account actually filed, not from this day. null means
        // it has never filed, [] means it filed and carried no strategy rows.
        lastStrategies: lastReportedDate ? strategiesOf(strategyRows) : null,
        lastReported: record && lastReportedDate
          ? {
            accountBalance: record.lastBalance,
            realizedPnl: record.lastDailyPnl,
            trailingMaxDrawdown: record.drawdown.value,
            // Its own date: readingOf() returns null for a trailing drawdown of
            // exactly 0 (585 of 3,100 rows), so the last MEASURED buffer is
            // often older than the last close the account filed.
            trailingMaxDrawdownDate: record.drawdown.date,
            breached: record.drawdown.breached,
          }
          : null,
        lifecycle: record
          ? {
            state: record.state,
            closesSinceSeen: record.closesSinceSeen,
            lastTradeDate: record.lastTradeDate,
            closesSinceTrade: record.closesSinceTrade,
            // 'unknown' whenever includeTradeHistory was false and the account
            // realized exactly 0 — the order rows that would settle it are not
            // in the payload, and that is a hole, not a "no".
            tradeEvidence: record.tradeEvidence,
          }
          : null,
      });
    }

    const registered = accounts.length;
    const existed = registered - notYetRegistered.length;
    // Every count below carries what it is out of. A bare "4 absent" is the
    // shape of number that lets a reader guess a denominator, and guessing it as
    // the whole book is how a partial day becomes a shutdown.
    return {
      absentAccounts: absent,
      // Ids only. WHICH accounts these are, and from when, is a per-client fact
      // with a date on it — summary.coverage.accountStarts carries
      // the identities once with their existsFrom, and every day is derivable
      // from that. Repeating the identities on all 183 days of a CAM's pull cost
      // 18 KB and said nothing a date could not.
      notYetRegisteredAccountIds: notYetRegistered,
      coverage: {
        registered,
        existedOnDay: existed,
        notYetRegistered: { count: notYetRegistered.length, of: registered },
        reported: { count: reported.size, of: existed },
        absent: { count: absent.length, of: existed },
        // Snapshot rows whose account_name matches no registry row for this
        // client: 33 of 3,100 on the real book. Counted apart from `reported`
        // because they are neither a registered account reporting nor an absence
        // — they are trading that the registry cannot name.
        reportedWithoutRegistryRow: orphanReports,
        // A subset of `absent`, not a fifth reason: an ignore-marked account is
        // still counted under whichever reason applies to it.
        absentMarkedIgnore: { count: ignored, of: absent.length },
        // Also a subset of `absent`, not a fifth reason. See the comment beside
        // `isSimulated` above: a simulator that did not report is not a missed
        // collection.
        absentSimulation: { count: simulated, of: absent.length },
        snapshotRows,
        clientFiledNothing,
        // One `of` for the four counts beside it rather than four copies of the
        // same number: the denominator is still stated, in the same object, and
        // the repeated form cost 31 KB of a 75 KB coverage block.
        absentByReason: {
          of: existed,
          neverReportedInRange: counts[ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE],
          notYetReporting: counts[ABSENCE_REASONS.NOT_YET_REPORTING],
          absentStillLive: counts[ABSENCE_REASONS.ABSENT_STILL_LIVE],
          absentFinished: counts[ABSENCE_REASONS.ABSENT_FINISHED],
        },
      },
    };
  }

  /**
   * The dates this client filed NOTHING on, against the desk's own calendar.
   *
   * The other half of the collection-vs-account split, and on this book it is
   * where the collection problem actually lives. `absenceFor` can only speak
   * about days that HAVE an import — a day with no import produces no entry in
   * `days` at all, so an account absent because nobody collected that client is
   * invisible there by construction.
   *
   * The denominator is the dates on which ANY client in this payload filed, not
   * the calendar days in the range: the book holds 21 trading dates inside 36
   * calendar days, so charging a client for 2026-06-27 — a Saturday nobody filed
   * — would turn a normal weekend into a coverage failure.
   *
   * Reported as its own number and never folded into accountDaysAbsent, because
   * "eleven accounts did not report" and "nobody collected this client that day"
   * call for two different people to be asked two different questions.
   */
  function uncollectedFor(clientId, filedDates) {
    const filed = new Set(filedDates);
    const missed = allDates.filter((date) => !filed.has(date));
    const accounts = accountsByClient.get(clientId) || [];
    const starts = accounts.map((account) => {
      const key = `${clientId}|${nameKey(account.account_name)}`;
      return existsFromOf(account, (sortedDatesByAccount.get(key) || [])[0] || null).date;
    });
    let accountDays = 0;
    for (const date of missed) {
      accountDays += starts.filter((start) => start && start <= date).length;
    }
    return {
      deskDates: allDates.length,
      // Says where the calendar came from, because it is only as wide as the
      // request. A one-client export derives the calendar from that client's own
      // imports, so datesNotFiled is 0 by construction and must not be read as
      // "this client filed on every trading day" — it means "we had nothing to
      // compare against". A CAM-wide export over 28 clients does have something.
      deskDatesBasis: `dates on which any of the ${clients.length} client(s) in this payload filed an import`,
      datesFiled: { count: filedDates.length, of: allDates.length },
      datesNotFiled: { count: missed.length, of: allDates.length },
      dates: missed,
      // Account-days lost to a missing import. Kept apart from
      // accountDaysAbsent, which is only ever "its siblings filed and it did not".
      accountDaysUncollected: accountDays,
    };
  }

  /**
   * Every account whose start date had to be DECIDED, once per client.
   *
   * Two kinds end up here and both are audit trail rather than decoration:
   *
   *   - the account was not there on the first day of the range, so
   *     `existsFrom` is the exact date its absences begin to count and
   *     days[].notYetRegisteredAccountIds before that date name its id;
   *   - `existsFromBasis` is 'first-observed-report', meaning the account
   *     reported in a close DATED EARLIER than its own date_added and the close
   *     won. 229 of the 720 observed accounts on the real book are in that
   *     state, and if this were not published the payload would silently be
   *     ignoring a column it also ships in tables.trading_accounts.
   *
   * An account registered before the range with a consistent date_added is not
   * listed: it existed on every day, and saying so 21 times says nothing.
   */
  function startsFor(clientId) {
    return (accountsByClient.get(clientId) || []).map((account) => {
      const key = `${clientId}|${nameKey(account.account_name)}`;
      const existence = existsFromOf(account, (sortedDatesByAccount.get(key) || [])[0] || null);
      return {
        tradingAccountId: account.id,
        accountName: account.account_name || null,
        dateAdded: isoDay(account.date_added),
        existsFrom: existence.date,
        existsFromBasis: existence.basis,
      };
    }).filter((row) => (
      row.existsFrom === null
      || row.existsFrom > allDates[0]
      || row.existsFromBasis === EXISTS_FROM_BASIS.FIRST_OBSERVED_REPORT
    ));
  }

  return { absenceFor, uncollectedFor, startsFor, dates: allDates };
}
