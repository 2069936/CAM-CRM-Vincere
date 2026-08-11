// Account lifecycle: born (dateAdded) -> algos it ran (from algoHistory) ->
// outcome (funded / failed / still active). Built from the CSV-driven account
// meta (not logs). Two views: one account's timeline, and per-algo aggregates
// (which combo gets accounts funded, lasts longer, survives) so a CAM/manager can
// see which configuration makes accounts win.
//
// WARNING about the two functions above, kept because StackPlaybook and
// LifecycleByAlgo render them: they key `outcome` entirely off `dateFailed`, and
// `dateFailed` is set on 2 of 764 accounts on the real book. buildLifecycleByAlgo
// therefore reports `failed: 0` for every algo combo while 48 accounts carry
// status 'Failed'. That is not a bug in the aggregation, it is the column being
// empty — the AccountManager dropdown writes `status` and nothing else — but it
// is the reason buildAccountLifecycleStates below never reads `dateFailed` as
// evidence of anything.

// './reconcile.js', not './reconcile'. Vite resolves the extension-less form and
// plain Node ESM does not — server/export/ runs as a Vercel function, which is
// plain Node ESM, and importing this module from there threw ERR_MODULE_NOT_FOUND
// on this line. clientExportSeries.js:88 documents the same trap from the other
// side. The chain is accountLifecycle -> reconcile -> tradingDayScope; both
// extension-less specifiers in it are now explicit, and node --input-type=module
// can load this file.
import { ACCOUNT_STATUSES, isCashType, isSimulationAccountType } from './reconcile.js';

function toDate(value) {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

function daysBetween(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  const d = Math.round((db - da) / 86400000);
  return d >= 0 ? d : null;
}

// The lifecycle timeline for one account. asOf (YYYY-MM-DD) dates the "still
// alive" end; defaults to the account's last known date.
export function buildAccountLifecycle(account = {}, { asOf = '' } = {}) {
  const born = account.dateAdded || '';
  const funded = account.dateFunded || '';
  const died = account.dateFailed || '';
  const outcome = died ? 'failed' : funded || account.accountType === 'Funded' ? 'funded' : 'active';
  const end = died || asOf || funded || born;
  const daysAlive = born ? daysBetween(born, end) : null;

  const history = [...(account.algoHistory || [])].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );
  const phases = [];
  let cursor = born;
  let algo = history.length ? history[0].from || account.algoStack || '' : account.algoStack || '';
  for (const change of history) {
    if (cursor && change.date) {
      phases.push({ algo: algo || '-', start: cursor, end: change.date, days: daysBetween(cursor, change.date) });
    }
    cursor = change.date;
    algo = change.to;
  }
  if (cursor && end) {
    phases.push({ algo: algo || account.algoStack || '-', start: cursor, end, days: daysBetween(cursor, end) });
  }

  return {
    accountName: account.accountName,
    alias: account.alias || account.accountName,
    born,
    funded,
    died,
    outcome,
    daysAlive,
    currentAlgo: account.algoStack || algo || '',
    phases,
  };
}

// Per-algo (algoStack combo) lifecycle aggregates across clients: funded rate,
// average lifespan, average days-to-fund. Cash / ignored accounts excluded.
export function buildLifecycleByAlgo(clients = [], { asOf = '' } = {}) {
  const byCombo = {};
  for (const client of clients || []) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      // A simulator is never funded and never fails, so counting one here would
      // push every algo's funded rate down by a denominator that can never
      // convert. 11 of the clients in the real exports carry one.
      if (
        isCashType(meta.accountType)
        || isSimulationAccountType(meta.accountType)
        || meta.accountType === 'Inactive / Ignore'
      ) continue;
      const combo = meta.algoStack || 'Unassigned';
      if (!byCombo[combo]) {
        byCombo[combo] = { combo, accounts: 0, funded: 0, failed: 0, active: 0, lifespans: [], daysToFund: [] };
      }
      const g = byCombo[combo];
      g.accounts += 1;
      if (meta.dateFailed) g.failed += 1;
      else if (meta.dateFunded || meta.accountType === 'Funded') g.funded += 1;
      else g.active += 1;

      const end = meta.dateFailed || asOf || meta.dateFunded || meta.dateAdded;
      const life = meta.dateAdded ? daysBetween(meta.dateAdded, end) : null;
      if (life != null) g.lifespans.push(life);
      const ttf = meta.dateAdded && meta.dateFunded ? daysBetween(meta.dateAdded, meta.dateFunded) : null;
      if (ttf != null) g.daysToFund.push(ttf);
    }
  }
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);
  return Object.values(byCombo)
    .map((g) => ({
      combo: g.combo,
      accounts: g.accounts,
      funded: g.funded,
      failed: g.failed,
      active: g.active,
      fundedRate: g.accounts ? Math.round((g.funded / g.accounts) * 100) : 0,
      avgLifespan: avg(g.lifespans),
      avgDaysToFund: avg(g.daysToFund),
    }))
    .sort((a, b) => b.fundedRate - a.fundedRate || b.accounts - a.accounts);
}

/* ------------------------------------------------------------------------- *
 * Where an account actually is in its life, from evidence rather than a field.
 *
 * THE PROBLEM. `trading_accounts.status` is free text with no CHECK constraint,
 * written from one <select> in AccountManager that saves `{status}` and nothing
 * else — no date, no side effect. On the real book that produces:
 *
 *   - 48 accounts marked 'Failed', of which 1 carries a date_failed (2%). So no
 *     Failed account can be placed in time, and avgDaysToFail upstream is a mean
 *     over n = 1.
 *   - 30 of those 48 appear in their client's most recent close, and 25 of the
 *     30 had a fill or an execution inside that close. Combined balance
 *     $1,466,363. The desk is running accounts it has written off, so "Failed"
 *     alone cannot mean "retire this".
 *   - Against observed breaches (prop accounts on the no-configured-limit model,
 *     n = 487): 124 accounts breached and were never marked, 6 are marked with
 *     no breach on record, and 4 of those 6 sit in the latest close with a
 *     healthy positive buffer ($81, $1,567, $999, $0 on a $47,380 balance).
 *
 * So the declared status and the observed evidence are nearly independent, and
 * anything that collapses them into one boolean is wrong 124 times in one
 * direction and 6 in the other. This module keeps them as two separate facts and
 * says which one it is looking at, every time.
 *
 * IT SUGGESTS, IT NEVER DECIDES. Retiring an account is a human action with
 * money attached, so a false "this is dead" on a live funded account costs far
 * more than a missed suggestion. Every suggestion carries the evidence that
 * produced it in one line a CAM can check, and everything the evidence does not
 * support comes back as a counted withheld reason rather than a guess.
 * ------------------------------------------------------------------------- */

export const LIFECYCLE_STATES = {
  RUNNING: 'running',
  QUIET: 'quiet',
  FINISHED: 'finished',
  STALE: 'stale',
  UNKNOWN: 'unknown',
};

export const LIFECYCLE_STATE_LABELS = {
  running: 'Running',
  quiet: 'Quiet',
  finished: 'Breached / finished',
  stale: 'Stale (not reporting)',
  unknown: 'Not enough to say',
};

/** Why an account was deliberately NOT put on the retire list. */
export const WITHHELD_REASONS = {
  NOT_IN_REGISTRY: 'not-in-registry',
  DECLARED_FAILED_STILL_REPORTING: 'declared-failed-still-reporting',
  DECLARED_FAILED_NEVER_OBSERVED: 'declared-failed-never-observed',
  STALE_ONLY: 'stale-only',
  NEVER_REPORTED: 'never-reported',
  LIQUIDATION_ONLY: 'liquidation-only',
  DRAWDOWN_NEVER_REPORTED: 'drawdown-never-reported',
  NO_EVIDENCE: 'no-evidence',
};

export const WITHHELD_REASON_TEXT = {
  'not-in-registry': 'Trades under a name with no registry row, so there is nothing to retire — these are the orphaned snapshots, and hard-deleting an account is what creates them.',
  'declared-failed-still-reporting': 'Marked Failed by the desk but still turning up in recent closes, several still filling orders. Retiring it would hide a live balance, so this needs a human to say which of the two is true.',
  'declared-failed-never-observed': 'Marked Failed and never appeared in any close, so there is no evidence either way — only the declaration.',
  'stale-only': 'Has not reported for several closes but never breached. Absence is a data problem first: 6 accounts on this book missed a close and came back.',
  'never-reported': 'Registered and never seen in any close. Pre-registered is not the same claim as stopped.',
  'liquidation-only': 'Carries a liquidation-only reject but no breach. That is a margin state, not a death: of the accounts with one and enough history to test, 74% reported again and 32% traded again.',
  'drawdown-never-reported': 'The trailing drawdown column has read exactly 0 on every close this account ever had, so its buffer was never measured — 0 here is the import having no column, not a buffer of zero.',
  'no-evidence': 'Still reporting and no breach on record. Nothing in the closes suggests these are finished.',
};

/**
 * A rejected order that says the account is on liquidation only.
 *
 * 140 orders on the book across 59 accounts: 108 "low net liquidating value",
 * 22 "contract about to be expired", 9 "missed pre-approval deadline", 1
 * "Manual Enable". Supporting evidence only — never a reason to retire on its
 * own, see WITHHELD_REASON_TEXT above.
 */
const LIQUIDATION_ONLY = /liquidation only/i;

function nameKey(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * One trailing-drawdown reading, or null when there is nothing to read.
 *
 * EXACTLY 0 IS "NOT MEASURED", NOT "NO BUFFER LEFT". 585 of the 3,100 snapshot
 * rows carry 0, and 89 of the 108 accounts whose last reading is 0 have been 0
 * on every close they ever had — 52 of those are cash accounts and 106 of the
 * 108 are status Active. That is reconcile.createSnapshot collapsing "the grid
 * reported no drawdown column" into 0, and account_snapshots has no
 * trailing_source column to tell the two apart afterwards. reconcile.js:348
 * reads `rawDD <= 0` as "Drawdown breached", so any rule reusing `<= 0` inherits
 * 89 false deaths. Strictly `< 0` here, and 0 returns null.
 */
function readingOf(snapshot) {
  const raw = Number(snapshot?.trailingMaxDrawdown);
  if (!Number.isFinite(raw) || raw === 0) return null;
  return raw;
}

/**
 * Whether one reading is a breach, under whichever model the account is on.
 *
 * Model 1 (max_drawdown_limit configured, 14 of 764 accounts): the value is
 * cumulative loss and the account is done when it reaches the limit.
 * Model 2 (the other 750): the value IS the remaining buffer and the account is
 * done when it goes negative.
 * Cash accounts have no trailing rule at all, so the answer is null, never false
 * — "this cannot breach" and "this has not breached" are different claims.
 */
function breachOf(value, limit, cash) {
  if (cash) return null;
  if (value === null) return null;
  return Number.isFinite(limit) && limit > 0 ? Math.abs(value) >= limit : value < 0;
}

function activityIndex(close) {
  const index = new Map();
  const bump = (name, field, amount = 1) => {
    const key = nameKey(name);
    if (!key) return;
    if (!index.has(key)) index.set(key, { fills: 0, liquidationOnly: 0 });
    index.get(key)[field] += amount;
  };
  for (const order of close?.orders || []) {
    if (Number(order?.filled) > 0) bump(order.accountName, 'fills');
    if (LIQUIDATION_ONLY.test(String(order?.state || ''))) bump(order.accountName, 'liquidationOnly');
  }
  for (const execution of close?.executions || []) bump(execution?.accountName, 'fills');
  return index;
}

function money(value) {
  const rounded = Math.round(Number(value) || 0);
  return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

function closesAgo(count) {
  if (count === null) return null;
  if (count === 0) return 'this close';
  return `${count} close${count === 1 ? '' : 's'} ago`;
}

/**
 * The one line a CAM checks the suggestion against.
 *
 * Deliberately states the declared status and the observed reading side by side
 * — "status Failed, buffer -3000 on 2026-06-24, last traded this close" — because
 * on this book those two disagree for 130 of the 487 testable accounts, and a
 * line that showed only one of them would be the same mistake the status column
 * already makes.
 */
function evidenceChipsOf(record) {
  const chips = [];
  chips.push({
    key: 'status',
    label: 'desk status',
    value: record.status || 'Active',
    tone: record.declaredFailed ? 'danger' : 'muted',
  });
  if (record.drawdown.value === null) {
    chips.push({
      key: 'drawdown',
      label: 'trailing buffer',
      value: 'never reported',
      tone: 'muted',
      title: 'The trailing drawdown column read exactly 0 on every close this account had. Not measured, which is not the same as no buffer left.',
    });
  } else {
    chips.push({
      key: 'drawdown',
      label: record.drawdownModel === 'limit' ? 'drawdown vs limit' : 'trailing buffer',
      value: record.drawdownModel === 'limit'
        ? `${money(record.drawdown.value)} of ${money(record.maxDrawdownLimit)}`
        : money(record.drawdown.value),
      note: record.drawdown.date,
      tone: record.drawdown.breached ? 'danger' : 'ok',
    });
  }
  chips.push({
    key: 'reported',
    label: 'last reported',
    value: record.lastSeenDate
      ? `${record.lastSeenDate} (${closesAgo(record.closesSinceSeen)})`
      : 'never',
    tone: record.closesSinceSeen !== null && record.closesSinceSeen > 0 ? 'warn' : 'muted',
  });
  chips.push({
    key: 'traded',
    label: 'last traded',
    value: record.lastTradeDate
      ? `${record.lastTradeDate} (${closesAgo(record.closesSinceTrade)})`
      : (record.tradeEvidence === 'unknown'
        ? 'not known — trade history not loaded'
        : `never in the ${record.closes} close${record.closes === 1 ? '' : 's'} we hold`),
    tone: record.tradeEvidence === 'unknown' ? 'muted' : 'ok',
  });
  if (record.sinceBreach && record.sinceBreach.closesReported > 0) {
    // The KGEF7919 shape: an account that breached and then kept going. That one
    // has 7 snapshots dated after its own date_failed, realizing -709, -885,
    // -901, -1077, -1093, -1269, -1200. The prop firm not having stopped it is
    // not evidence that it is alive, but a CAM has to see it before retiring —
    // and it is anchored on the FIRST breach, because the last reading is
    // usually the last close and would show nothing after it by construction.
    chips.push({
      key: 'after',
      label: `since it first went negative (${record.sinceBreach.firstDate})`,
      value: `reported ${record.sinceBreach.closesReported} more close${record.sinceBreach.closesReported === 1 ? '' : 's'}, traded in ${record.sinceBreach.closesTraded}`,
      tone: 'warn',
    });
  }
  if (record.liquidationOnly.orders > 0) {
    chips.push({
      key: 'liquidation',
      label: 'liquidation-only rejects',
      value: `${record.liquidationOnly.orders} (last ${record.liquidationOnly.lastDate})`,
      tone: 'warn',
    });
  }
  return chips;
}

function evidenceLineOf(chips) {
  return chips
    .map((chip) => `${chip.label} ${chip.value}${chip.note ? ` (${chip.note})` : ''}`)
    .join(' \u00b7 ');
}

function blankRecord(client, accountName, meta, registered) {
  const cash = isCashType(meta.accountType);
  const limit = Number(meta.maxDrawdownLimit);
  return {
    clientId: client.id,
    clientName: client.name || client.id,
    accountName,
    alias: meta.alias || accountName,
    accountType: meta.accountType || '',
    status: meta.status || '',
    declaredFailed: meta.status === ACCOUNT_STATUSES.FAILED,
    dateFailed: meta.dateFailed || null,
    dateAdded: meta.dateAdded || null,
    registered,
    cash,
    maxDrawdownLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    drawdownModel: Number.isFinite(limit) && limit > 0 ? 'limit' : 'buffer',
    seenCloses: 0,
    firstSeenIndex: null,
    lastSeenIndex: null,
    // Kept as index lists, not just counters, because "did it keep trading AFTER
    // the breach" cannot be answered from totals and it is the question that
    // separates a dead account from a written-off one still running.
    seenIndices: [],
    tradedIndices: [],
    skippedCloses: 0,
    lastBalance: null,
    lastDailyPnl: null,
    lastMeasured: null,
    breachedCloses: 0,
    firstBreachIndex: null,
    everBreachedIndex: null,
    lastTradeIndex: null,
    tradedCloses: 0,
    tradeEvidenceSeen: false,
    liquidationOnlyOrders: 0,
    liquidationOnlyIndex: null,
  };
}

/**
 * Every account placed in a lifecycle state, with the evidence and a suggestion
 * that is allowed to be "not enough to say".
 *
 * `staleCloses` is 5 because absence is reversible and lagging: sweeping the
 * real book, "absent for at least N of its client's closes" gives 220 accounts
 * at N=1, 183 at 2, 160 at 3, 148 at 5, 17 at 8. Six accounts skipped a close
 * and came back (18 skipped closes inside their own observed span), so no value
 * of N makes absence absorbing — which is why stale is a state and never, on its
 * own, a suggestion.
 *
 * `quietCloses` is 3: a prop account that has reported for three closes without
 * a fill is quiet, not finished. Nothing acts on the difference, it only decides
 * which word the panel prints.
 */
export function buildAccountLifecycleStates(clients = [], {
  asOf = '',
  staleCloses = 5,
  quietCloses = 3,
} = {}) {
  const bound = String(asOf || '').slice(0, 10);

  // Orders and executions are the two biggest tables and the app loads them
  // after the rest of the state (supabaseStore.CRM_STATE_TABLES excludes them,
  // mergeSupabaseTradeHistory fills them in later). Both arrive as [] either
  // way, so "no orders that day" and "orders not loaded yet" are structurally
  // identical per close and can only be told apart book-wide. Without this the
  // panel would report every account as "never traded" for the first seconds
  // after a load — a claim, not a hole.
  let tradeHistoryLoaded = false;
  for (const client of clients || []) {
    for (const close of client?.dailyImports || []) {
      if ((close?.orders || []).length || (close?.executions || []).length) {
        tradeHistoryLoaded = true;
        break;
      }
    }
    if (tradeHistoryLoaded) break;
  }

  const records = [];
  let asOfSeen = '';

  for (const client of clients || []) {
    const closes = (client?.dailyImports || [])
      .filter((close) => close?.date && (!bound || String(close.date).slice(0, 10) <= bound))
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (closes.length) {
      const last = String(closes[closes.length - 1].date).slice(0, 10);
      if (last > asOfSeen) asOfSeen = last;
    }

    const registry = client?.accountRegistry || {};
    const byKey = new Map();
    for (const [accountName, meta] of Object.entries(registry)) {
      // Simulation accounts are not lifecycle subjects: there is no funding to
      // reach, no drawdown rule to breach and nothing to retire. Left in, each
      // would sit here permanently as an account that "never reported" — its
      // closes live in dailyImport.simulation, which this module deliberately
      // does not read — and would be suggested for retirement every run.
      if (isSimulationAccountType((meta || {}).accountType)) continue;
      byKey.set(nameKey(accountName), blankRecord(client, accountName, meta || {}, true));
    }

    closes.forEach((close, index) => {
      const activity = activityIndex(close);
      for (const snapshot of close?.snapshots || []) {
        const key = nameKey(snapshot?.accountName);
        if (!key) continue;
        if (!byKey.has(key)) {
          // A snapshot whose account has no registry row. 41 account_snapshots
          // rows carry a null trading_account_id on this book and the
          // operations segments already surface 21 such accounts holding
          // $974,922. They are real trading accounts, so they are classified —
          // but never suggested for retirement, because there is no registry
          // row to retire.
          byKey.set(key, blankRecord(client, snapshot.accountName, snapshot.meta || {}, false));
        }
        const record = byKey.get(key);

        record.seenCloses += 1;
        if (record.firstSeenIndex === null) record.firstSeenIndex = index;
        else record.skippedCloses += index - record.lastSeenIndex - 1;
        record.lastSeenIndex = index;
        record.seenIndices.push(index);
        record.lastBalance = Number(snapshot.accountBalance) || 0;
        record.lastDailyPnl = Number(snapshot.grossRealizedPnl) || 0;

        const value = readingOf(snapshot);
        if (value !== null) {
          const breached = breachOf(value, record.maxDrawdownLimit, record.cash);
          record.lastMeasured = { value, date: close.date, index, breached };
          if (breached) {
            record.breachedCloses += 1;
            record.everBreachedIndex = index;
            if (record.firstBreachIndex === null) record.firstBreachIndex = index;
          }
        }

        const counts = activity.get(key) || null;
        if (counts?.liquidationOnly) {
          record.liquidationOnlyOrders += counts.liquidationOnly;
          record.liquidationOnlyIndex = index;
        }
        const realized = Number(snapshot.grossRealizedPnl) || 0;
        // Realized PnL is on every snapshot; fills need the trade tables. A
        // non-zero realized proves a trade on its own, which is why 25 of the 30
        // written-off accounts in the latest close can be called trading even
        // before the order rows load.
        const traded = realized !== 0 || (counts ? counts.fills > 0 : false);
        if (tradeHistoryLoaded || realized !== 0) record.tradeEvidenceSeen = true;
        if (traded) {
          record.tradedCloses += 1;
          record.lastTradeIndex = index;
          record.tradedIndices.push(index);
        }
      }
    });

    const closeDates = closes.map((close) => String(close.date).slice(0, 10));
    for (const record of byKey.values()) {
      records.push(finishRecord(record, closeDates, { staleCloses, quietCloses, tradeHistoryLoaded }));
    }
  }

  const counts = { running: 0, quiet: 0, finished: 0, stale: 0, unknown: 0 };
  for (const record of records) counts[record.state] += 1;

  const suggestions = records
    .filter((record) => record.suggestion)
    .sort(bySeverity);

  const withheldCounts = {};
  for (const record of records) {
    if (record.suggestion) continue;
    withheldCounts[record.withheldReason] = (withheldCounts[record.withheldReason] || 0) + 1;
  }
  const withheld = Object.entries(withheldCounts)
    .map(([reason, count]) => ({ reason, count, text: WITHHELD_REASON_TEXT[reason] || reason }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  // The contradiction that started all of this, kept as its own number: accounts
  // the desk has written off that were still trading in their latest close. 25
  // of them on the real book holding $1,219,742, and they are counted in the
  // segment tiles as live because operationsSegments.segmentFor branches on
  // accountType and never reads status.
  //
  // Split by suggestion on purpose. 21 of the 25 are ALSO past their drawdown
  // limit, so they are on the retire list and the status and the book agree
  // about them; the remaining 4 are the real disagreement — written off, still
  // trading, and their last buffers read $81, $1,567, $999 and never-measured
  // on a $47,380 balance. Reporting all 25 as "a question for the CAM" would
  // have been wrong about 21 of them.
  const declaredFailed = records.filter((record) => record.declaredFailed);
  const stillTrading = declaredFailed.filter(
    (record) => record.closesSinceSeen === 0 && record.tradedInLastSeenClose === true,
  );

  return {
    // The latest close the evidence ACTUALLY reaches, never the filter date.
    //
    // This used to be `bound || asOfSeen`, so the ops screen — which hands in
    // its date picker, seeded from the wall clock — rendered "closes to
    // 2026-08-11". There is no close on 2026-08-11 for any of the 96 clients;
    // the book ends 2026-07-30. Every state below is derived from close indices
    // and none of them moved when the picker did, so the only thing the bound
    // changed was the date printed beside them: a twelve-day-old measurement
    // wearing today's date, which is the exact failure liveAccounts.js was
    // written to prevent.
    asOf: asOfSeen || bound || '',
    // The filter that was applied, kept separately so a panel can say "nothing
    // closed between these two dates" instead of implying data it does not have.
    bound: bound || null,
    settings: { staleCloses, quietCloses, tradeHistoryLoaded },
    accounts: records,
    counts,
    suggestions,
    withheld,
    withheldTotal: records.length - suggestions.length,
    declared: {
      failed: declaredFailed.length,
      failedSuggested: declaredFailed.filter((record) => record.suggestion).length,
      failedStillTrading: stillTrading.length,
      failedStillTradingSuggested: stillTrading.filter((record) => record.suggestion).length,
      failedStillTradingWithheld: stillTrading.filter((record) => !record.suggestion).length,
      failedStillTradingBalance: stillTrading.reduce((sum, record) => sum + (record.lastBalance || 0), 0),
      failedStillTradingDailyPnl: stillTrading.reduce((sum, record) => sum + (record.lastDailyPnl || 0), 0),
      // date_failed is set on 2 of 764 accounts, so 46 of the 48 Failed accounts
      // cannot be placed in time at all. Printed rather than assumed.
      failedWithDate: declaredFailed.filter((record) => record.dateFailed).length,
    },
  };
}

const SEVERITY_ORDER = ['breached-and-trading', 'breached', 'declared-and-silent'];

function bySeverity(a, b) {
  const rank = SEVERITY_ORDER.indexOf(a.suggestion.kind) - SEVERITY_ORDER.indexOf(b.suggestion.kind);
  if (rank) return rank;
  return (b.lastBalance || 0) - (a.lastBalance || 0)
    || String(a.clientName).localeCompare(String(b.clientName));
}

/**
 * State first, suggestion second, and they are different questions.
 *
 * The state says what the account is doing. The suggestion says what a human
 * should do about it, and the two do not line up: a breached account that is
 * still trading is `finished` AND the most urgent thing on the list, while a
 * `stale` account is a missing import to chase, not a retirement.
 */
function finishRecord(record, closeDates, { staleCloses, quietCloses, tradeHistoryLoaded }) {
  const total = closeDates.length;
  const lastIndex = total - 1;
  const seen = record.seenCloses > 0;
  const closesSinceSeen = seen ? lastIndex - record.lastSeenIndex : null;
  const closesSinceTrade = record.lastTradeIndex === null ? null : lastIndex - record.lastTradeIndex;
  const measured = record.lastMeasured;
  const closesSinceMeasured = measured ? lastIndex - measured.index : null;

  const drawdown = {
    value: measured ? measured.value : null,
    date: measured ? measured.date : null,
    breached: measured ? measured.breached : null,
    closesSince: closesSinceMeasured,
    breachedCloses: record.breachedCloses,
    // A breach followed by a healthy reading is a recovery, and it happens: of
    // 50 uncensored accounts that went negative, 1 got a positive buffer back.
    // Reading "ever breached" as "dead" would retire that one by mistake.
    recovered: record.everBreachedIndex !== null && measured ? !measured.breached : false,
    // Right-censored: the reading is the last close on the book, so there is no
    // "after" to check. 76 of the 176 breaches this book suggests retiring
    // happened on 2026-07-30 itself. Not a weaker breach — a breach nothing has
    // had the chance to contradict — and the panel says which it is.
    censored: measured ? measured.index === lastIndex : null,
  };

  // What the account did after it FIRST went negative. Anchoring this on the
  // last reading answers nothing — the last reading is the last close for
  // essentially every breached account on this book, so "closes after it" is 0
  // by construction and the KGEF7919 shape (7 closes traded after its own
  // failure date) would never appear. From the first breach it does.
  const sinceBreach = measured && measured.breached && record.firstBreachIndex !== null
    ? {
      firstDate: closeDates[record.firstBreachIndex],
      closesReported: record.seenIndices.filter((index) => index > record.firstBreachIndex).length,
      closesTraded: record.tradedIndices.filter((index) => index > record.firstBreachIndex).length,
    }
    : null;

  const tradeEvidence = record.tradeEvidenceSeen || tradeHistoryLoaded ? 'observed' : 'unknown';
  const tradedInLastSeenClose = record.lastSeenIndex === null
    ? null
    : (tradeEvidence === 'unknown' ? null : record.lastTradeIndex === record.lastSeenIndex);

  let state;
  let stateBasis;
  if (!seen) {
    state = LIFECYCLE_STATES.UNKNOWN;
    stateBasis = 'Registered but never present in any close, so nothing has been observed about it.';
  } else if (drawdown.breached === true) {
    state = LIFECYCLE_STATES.FINISHED;
    stateBasis = record.drawdownModel === 'limit'
      ? `Cumulative drawdown ${money(drawdown.value)} against a ${money(record.maxDrawdownLimit)} limit on ${drawdown.date}.`
      : `Trailing buffer ${money(drawdown.value)} on ${drawdown.date} — negative means the limit is reached.`;
  } else if (closesSinceSeen >= staleCloses) {
    state = LIFECYCLE_STATES.STALE;
    stateBasis = `Absent from the last ${closesSinceSeen} closes. Absence is a reporting fact, not a burn.`;
  } else if (closesSinceTrade !== null && closesSinceTrade < quietCloses) {
    state = LIFECYCLE_STATES.RUNNING;
    stateBasis = `Reported on ${closeDates[record.lastSeenIndex]} and traded ${closesAgo(closesSinceTrade)}.`;
  } else if (tradeEvidence === 'unknown') {
    state = LIFECYCLE_STATES.UNKNOWN;
    stateBasis = 'Reporting, but no realized PnL and no order rows loaded, so whether it traded cannot be answered.';
  } else if (record.cash) {
    // A cash account has no trailing rule to be inside, so "within its limits"
    // is true by construction rather than by measurement. 53 accounts.
    state = LIFECYCLE_STATES.QUIET;
    stateBasis = 'Reporting, no fills recently, and a cash account has no drawdown rule to breach.';
  } else if (drawdown.value === null) {
    state = LIFECYCLE_STATES.UNKNOWN;
    stateBasis = 'Reporting but not trading, and its trailing drawdown has never been reported — there is no measurement to call it safe by.';
  } else {
    state = LIFECYCLE_STATES.QUIET;
    stateBasis = `Reporting, no fills for ${closesSinceTrade === null ? 'its whole observed span' : closesAgo(closesSinceTrade)}, buffer ${money(drawdown.value)}.`;
  }

  const enriched = {
    ...record,
    closes: total,
    lastSeenDate: seen ? closeDates[record.lastSeenIndex] : null,
    firstSeenDate: seen ? closeDates[record.firstSeenIndex] : null,
    closesSinceSeen,
    lastTradeDate: record.lastTradeIndex === null ? null : closeDates[record.lastTradeIndex],
    closesSinceTrade,
    tradedInLastSeenClose,
    tradeEvidence,
    drawdown,
    sinceBreach,
    liquidationOnly: {
      orders: record.liquidationOnlyOrders,
      lastDate: record.liquidationOnlyIndex === null ? null : closeDates[record.liquidationOnlyIndex],
    },
    state,
    stateBasis,
  };

  const { suggestion, withheldReason } = decide(enriched, { staleCloses });
  enriched.suggestion = suggestion;
  enriched.withheldReason = withheldReason;
  enriched.evidence = evidenceChipsOf(enriched);
  enriched.evidenceLine = evidenceLineOf(enriched.evidence);
  return enriched;
}

/**
 * Retire or not, and the reason either way.
 *
 * Only two things earn a suggestion:
 *
 *   1. The latest measured reading is a breach. Observed, dated, and the
 *      strongest signal on the book — of 50 accounts that went negative with at
 *      least three further closes to check, 31 (62%) never reported again and
 *      only 1 recovered a buffer.
 *   2. The desk marked it Failed AND it has gone quiet for `staleCloses` closes.
 *      Declaration plus silence agree; neither is enough alone.
 *
 * Everything else is withheld with a counted reason. In particular a marked-
 * Failed account that is still reporting is NOT suggested: 30 of them on this
 * book, 25 with a fill in the latest close and $1,466,363 of balance between
 * them. Retiring those on the strength of the status column would hide live
 * money, which is the expensive direction of this error.
 */
function decide(record, { staleCloses }) {
  const withhold = (reason) => ({ suggestion: null, withheldReason: reason });

  if (!record.registered) return withhold(WITHHELD_REASONS.NOT_IN_REGISTRY);

  if (record.state === LIFECYCLE_STATES.FINISHED) {
    const trading = record.tradedInLastSeenClose === true && record.closesSinceSeen === 0;
    return {
      suggestion: {
        action: 'retire',
        kind: trading ? 'breached-and-trading' : 'breached',
        headline: trading
          ? `Breached and still trading — ${money(record.drawdown.value)} on ${record.drawdown.date}, and it was still trading in that same close.`
          : `Breached on ${record.drawdown.date} (${money(record.drawdown.value)})${record.closesSinceSeen ? `, and it has not reported in the ${record.closesSinceSeen} close${record.closesSinceSeen === 1 ? '' : 's'} since.` : '.'}`,
        agreement: record.declaredFailed
          ? 'The desk already marked this Failed — confirming the retire only records what both the status and the closes say.'
          : 'The desk has NOT marked this Failed. The breach is observed, the status is not — check the account before confirming.',
        confidence: confidenceOf(record),
      },
      withheldReason: null,
    };
  }

  if (record.declaredFailed) {
    if (!record.seenCloses) return withhold(WITHHELD_REASONS.DECLARED_FAILED_NEVER_OBSERVED);
    if (record.closesSinceSeen >= staleCloses) {
      return {
        suggestion: {
          action: 'retire',
          kind: 'declared-and-silent',
          headline: `Marked Failed by the desk and absent from the last ${record.closesSinceSeen} closes.`,
          agreement: record.drawdown.value === null
            ? 'No drawdown was ever reported for it, so the declaration and the silence are the whole case — thin, but they agree.'
            : `Its last reported buffer was ${money(record.drawdown.value)}, which is not a breach; the case rests on the declaration and the silence.`,
          confidence: 'declared, not observed',
        },
        withheldReason: null,
      };
    }
    return withhold(WITHHELD_REASONS.DECLARED_FAILED_STILL_REPORTING);
  }

  if (record.state === LIFECYCLE_STATES.STALE) return withhold(WITHHELD_REASONS.STALE_ONLY);
  if (!record.seenCloses) return withhold(WITHHELD_REASONS.NEVER_REPORTED);
  // Order matters below. A running account is not on the list because it is
  // alive, not because its drawdown column is empty: reporting the 5 accounts
  // that trade every close but never carried a drawdown reading as "we cannot
  // measure it" buries the real 6 — the ones that are neither trading nor
  // measurable, which is the bucket a CAM should actually go and look at.
  if (record.state === LIFECYCLE_STATES.UNKNOWN && !record.cash && record.drawdown.value === null) {
    return withhold(WITHHELD_REASONS.DRAWDOWN_NEVER_REPORTED);
  }
  if (record.liquidationOnly.orders > 0) return withhold(WITHHELD_REASONS.LIQUIDATION_ONLY);
  return withhold(WITHHELD_REASONS.NO_EVIDENCE);
}

/**
 * How much weight the breach can carry, in words rather than a score.
 *
 * The three cases are genuinely different and a CAM has to be able to tell them
 * apart at a glance: a breach nothing has had the chance to contradict (76 of
 * them on this book, all dated 2026-07-30), a breach the account never reported
 * after, and a breach the account went on trading through.
 */
function confidenceOf(record) {
  const after = record.sinceBreach;
  if (after && after.closesTraded > 0) {
    return `negative since ${after.firstDate} and it has traded in ${after.closesTraded} of the ${after.closesReported} close${after.closesReported === 1 ? '' : 's'} since — the prop firm has not stopped it, so confirm with them before retiring`;
  }
  if (record.drawdown.breachedCloses > 1) {
    return `negative on ${record.drawdown.breachedCloses} closes, first on ${after ? after.firstDate : record.drawdown.date}`;
  }
  if (record.drawdown.censored) {
    return 'negative on the latest close on file — no close after it yet, so nothing has confirmed or contradicted it';
  }
  if (after && after.closesReported === 0) {
    return `has not reported in the ${record.closesSinceSeen} close${record.closesSinceSeen === 1 ? '' : 's'} since it went negative`;
  }
  return 'negative on one close, and it has reported since without trading';
}
