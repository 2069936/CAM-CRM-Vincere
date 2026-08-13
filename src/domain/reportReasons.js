// Why the day looked the way it did, for ONE client and ONE close.
//
// THE HOLE THIS FILLS. buildDailyReportSummary reads exactly three things off a
// reconciled import — snapshots, accounts, flags — and prints four sums. The
// import it is handed also carries `orders` (with the broker's own `state`
// text), `executions`, an import-level `strategies` array and a `pnlSource`
// per snapshot, and the report references none of them. So Daniel Swanson's
// 2026-08-11 PDF prints `DAILY REALIZED PNL $0`, the word `BREACHED` on two
// accounts, and an enabled `Bullet Bot-1.1` beside them, and never says that the
// only two orders his desk placed that day came back
// `Rejected: Your account is currently set to liquidation only due to Drawdown
// level breached at end of day.` The client reads $0 and cannot tell "nothing
// happened" from "the firm stopped me".
//
// WHAT EARNS A LINE HERE, and the rate each fires at. Measured over the 11 real
// unredacted client exports for 2026-08-11 and over public/local-snapshot.json
// (535 imports / 3,100 snapshots / 16,135 orders / 3,805 strategy rows):
//
//   rejected orders     2 orders on 1 of 11 clients (9%); 198 orders on 86 of
//                       535 imports (16%) on the book. Rare, dated, and the
//                       broker's own sentence is already the sentence the client
//                       needs. IN.
//   strategies all off  9 live accounts across 5 of 11 clients carry >=1
//                       strategy row and 0 enabled; on the book 261 of 535
//                       imports (49%) have EVERY strategy row off. A client-level
//                       "strategies are off" banner would therefore fire on half
//                       of all days = noise. IN, but per account and only for an
//                       account that also recorded nothing that day, so the line
//                       is attached to a flat account rather than to the client.
//   accounts absent     1,153 of 4,650 non-ignore (client, day, account) slots
//                       on the book (25%); 255 of 535 imports (48%) have >=1.
//                       IN, grouped into one entry that names the accounts and
//                       splits them by the five reasons in accountAbsence.js —
//                       never as a bare count, which is what makes it noise.
//   stopped vs idled    413 of 3,100 snapshots carry a negative trailing
//                       drawdown, on 198 of 535 imports (37%). IN, from
//                       accountLifecycle's evidence rather than the status
//                       column (which is wrong 124 times in one direction and 6
//                       in the other on this same book).
//
// WHAT WAS MEASURED AND DROPPED:
//
//   flag counts         ANY flag fires on 449 of 535 imports (84%) and a
//                       CRITICAL flag on 363 (68%). A "you have flags" line is
//                       therefore true on two days in three and carries no
//                       information. The report already has a correctly scoped
//                       flag section (report.openFlags, non-empty on 140 of 535
//                       = 26%) behind showFlags, so nothing is added here.
//   connection status   ConnectionStatus reads `Connected` on all 68 account
//                       rows in the 11 exports. A signal that never fires.
//   "N accounts idled"  on its own. Emitted only as a contrast sentence when
//                       something material is already on the list, because a
//                       standalone "3 accounts did not trade" on a clean quiet
//                       day reads as an accusation rather than a fact.
//
// WHAT THIS FILE MUST NEVER DO. It never states a cause. "Two orders were
// rejected, and the platform's reason was X" is a fact; "the account was
// breached so nothing traded" is an inference, and a wrong one for the four
// accounts in these same 11 folders that were both breached AND carrying only
// disabled strategies. Every entry below is one observation with its own
// evidence attached, and the reader joins them.
//
// AND IT NEVER TURNS A HOLE INTO A CLEAN BILL. Orders and executions are lazily
// loaded (supabaseStore TRADE_HISTORY_TABLES, hydrated by App.hydrateTradeHistory
// after the shell), and a CSV upload can simply not include the orders grid.
// "No orders were rejected" and "we do not have the orders for this close" are
// different claims: the second travels in `unstated` and the first is never
// printed at all, because the absence of a reason is not a statement.

import { ABSENCE_REASONS, existsFrom, isoDay, nameKey } from './accountAbsence';
import {
  LIFECYCLE_STATES,
  buildAccountLifecycleStates,
} from './accountLifecycle';
import { ACCOUNT_TYPES, isCashType } from './reconcile';
import { ACCOUNT_NATURES, classifyAccountNature } from './simulationAccounts';
import { formatCurrency } from './report';

export const REASON_KINDS = {
  /** The platform refused an order, in its own words. */
  ORDERS_REJECTED: 'orders-rejected',
  /** The account is past its trailing drawdown, by observed reading. */
  ACCOUNT_STOPPED: 'account-stopped',
  /** Strategies are assigned to the account and none of them were switched on. */
  STRATEGIES_ALL_OFF: 'strategies-all-off',
  /** Registered accounts with no row in this close. */
  ACCOUNTS_ABSENT: 'accounts-absent',
  /** The close carries no account rows at all — one fact about collection. */
  NOTHING_COLLECTED: 'nothing-collected',
  /** The contrast line: the rest reported and simply did not trade. */
  ACCOUNTS_IDLE: 'accounts-idle',
};

/**
 * Whether a source is present at all.
 *
 * Two values, not a boolean, because `false` reads as "there were none" at every
 * call site and that is precisely the confusion this module exists to prevent.
 */
export const EVIDENCE = {
  OBSERVED: 'observed',
  UNAVAILABLE: 'unavailable',
};

const REJECTED = /^\s*rejected\b/i;

/**
 * The broker's sentence, with its own label stripped and nothing else changed.
 *
 * All 198 rejected orders on the book carry the reason inside the state text as
 * `Rejected: <sentence>`; 2 of the 11 folders' orders read exactly
 * `Rejected: Your account is currently set to liquidation only due to Drawdown
 * level breached at end of day.` The sentence is never paraphrased — a
 * paraphrase is the CRM speaking for the broker, and on a client-facing page
 * that is the desk taking on a claim it did not make.
 */
function rejectionText(state) {
  const raw = String(state || '').trim();
  const stripped = raw.replace(/^rejected\s*:?\s*/i, '').trim();
  return stripped || raw || null;
}

/**
 * Are the order rows for this close actually in hand?
 *
 * Scoped to THIS CLIENT rather than the whole book (accountLifecycle.js:417 does
 * the same test across all clients, because it is handed all of them). An empty
 * `orders` array is structurally identical whether the close had no orders, the
 * CSV upload carried no orders grid, or App.hydrateTradeHistory has not returned
 * yet — so a single close can never answer it. If ANY close this client has on
 * file carries an order or an execution, the tables are loaded and an empty
 * array for this day is a real "none". Otherwise it is a hole, and this module
 * refuses to read it as a clean day.
 *
 * THE SIMULATION ARRAYS COUNT AS EVIDENCE and the live ones alone do not. Craig
 * Weschke's 2026-08-11 folder carries a 17-row orders grid in which every single
 * row belongs to his Sim101, so splitSimulationRows leaves `orders` empty and
 * `simulation.orders` full. Probing only the live array called his orders "not
 * on file" and printed the hole warning on a client whose orders we hold — the
 * mirror image of the mistake this function exists to prevent.
 */
function hasOrderRows(close) {
  return Boolean(
    (close?.orders || []).length
    || (close?.executions || []).length
    || (close?.simulation?.orders || []).length
    || (close?.simulation?.executions || []).length,
  );
}

function ordersEvidenceOf(client, dailyImport) {
  if (hasOrderRows(dailyImport)) return EVIDENCE.OBSERVED;
  for (const close of client?.dailyImports || []) {
    if (hasOrderRows(close)) return EVIDENCE.OBSERVED;
  }
  return EVIDENCE.UNAVAILABLE;
}

/** Per-account order / execution counts for one close, keyed case-insensitively. */
function activityOf(dailyImport) {
  const index = new Map();
  const bump = (name, field, amount = 1) => {
    const key = nameKey(name);
    if (!key) return;
    if (!index.has(key)) index.set(key, { orders: 0, filled: 0, rejected: 0, executions: 0 });
    index.get(key)[field] += amount;
  };
  for (const order of dailyImport?.orders || []) {
    bump(order?.accountName, 'orders');
    if (Number(order?.filled) > 0) bump(order.accountName, 'filled');
    if (REJECTED.test(String(order?.state || ''))) bump(order.accountName, 'rejected');
  }
  for (const execution of dailyImport?.executions || []) bump(execution?.accountName, 'executions');
  return index;
}

/**
 * Every strategy row known for one account on this close.
 *
 * Two sources because they are populated on different paths and either can be
 * empty: `snapshot.strategies` is what reconcile.createSnapshot nests and what
 * the report table already renders, while `dailyImport.strategies` is the flat
 * import-level array (the only one populated right after an upload, before a
 * reload — recalculateDailyImport documents that exact window). Merged by name
 * so an account present in both is not counted twice.
 */
function strategiesFor(snapshot, byAccount) {
  const merged = new Map();
  for (const row of snapshot?.strategies || []) {
    merged.set(`${row.strategyName || ''}|${row.instrument || ''}`, row);
  }
  for (const row of byAccount || []) {
    const key = `${row.strategyName || ''}|${row.instrument || ''}`;
    if (!merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()];
}

/**
 * on / off / unknown for a strategy row.
 *
 * `enabled` is tri-state in the export payload (absentAccounts.strategiesOf:
 * null means the import carried no such column) and BOTH import paths currently
 * collapse a missing value to false — csvImport.parseBool:108 and
 * supabaseStore.strategyFromRow's `Boolean(row.enabled)`. So `unknown` does not
 * occur today on either path; it is handled anyway because the day a nullable
 * column reaches here, "we were not told" must not print as "switched off" on a
 * page the client reads.
 */
function enabledState(row) {
  if (row?.enabled === true) return 'on';
  if (row?.enabled === false) return 'off';
  return 'unknown';
}

function aliasOf(meta, accountName) {
  return meta?.alias || accountName;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * The reasons behind one client's close.
 *
 * `client` is the CRM client shape (id, name, accountRegistry, dailyImports) and
 * `dailyImport` is one of its closes — exactly what ReportPanel already holds,
 * so nothing new has to be loaded to render this.
 */
export function buildReportReasons(client, dailyImport) {
  const date = isoDay(dailyImport?.date) || String(dailyImport?.date || '');
  const snapshots = dailyImport?.snapshots || [];
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const ordersEvidence = ordersEvidenceOf(client, dailyImport);
  const activity = activityOf(dailyImport);
  const strategiesByAccount = new Map();
  for (const row of dailyImport?.strategies || []) {
    const key = nameKey(row?.accountName);
    if (!key) continue;
    if (!strategiesByAccount.has(key)) strategiesByAccount.set(key, []);
    strategiesByAccount.get(key).push(row);
  }

  const metaFor = (accountName) => {
    const direct = registry[accountName];
    if (direct) return direct;
    const key = nameKey(accountName);
    const found = Object.keys(registry).find((name) => nameKey(name) === key);
    return found ? registry[found] : {};
  };

  // The lifecycle classifier, asked as of THIS close and not as of today. An
  // account that breached on 2026-08-11 was not breached on 2026-08-04, and a
  // report re-opened for an older day must show the book as it stood then —
  // ReportPanel already bounds its charts the same way.
  const lifecycle = buildAccountLifecycleStates(client ? [client] : [], { asOf: date });
  const lifecycleByAccount = new Map(
    lifecycle.accounts.map((record) => [nameKey(record.accountName), record]),
  );

  const reasons = [];
  const unstated = [];
  const reported = new Set(snapshots.map((snapshot) => nameKey(snapshot.accountName)));

  /* ----------------------------------------------------------------- *
   * 1. Orders the platform refused, in its own words.
   * ----------------------------------------------------------------- */
  if (ordersEvidence === EVIDENCE.OBSERVED) {
    const byAccount = new Map();
    for (const order of dailyImport?.orders || []) {
      if (!REJECTED.test(String(order?.state || ''))) continue;
      const key = nameKey(order.accountName);
      if (!byAccount.has(key)) byAccount.set(key, { accountName: order.accountName, orders: [], reasons: new Map() });
      const bucket = byAccount.get(key);
      bucket.orders.push(order);
      const text = rejectionText(order.state);
      if (text) bucket.reasons.set(text, (bucket.reasons.get(text) || 0) + 1);
    }
    for (const bucket of byAccount.values()) {
      const meta = metaFor(bucket.accountName);
      const placed = activity.get(nameKey(bucket.accountName))?.orders || bucket.orders.length;
      const n = bucket.orders.length;
      // "1 of the 1 order" is what the arithmetic wants to say and it is not
      // English. Daniel Swanson's two accounts each sent exactly one order and
      // each one came back rejected, which is the whole of his trading day.
      const share = n === placed
        ? (n === 1 ? 'the only order sent on this account was' : `all ${n} orders sent on this account were`)
        : `${n} of the ${placed} orders sent on this account ${plural(n, 'was', 'were')}`;
      reasons.push({
        kind: REASON_KINDS.ORDERS_REJECTED,
        accountName: bucket.accountName,
        alias: aliasOf(meta, bucket.accountName),
        headline: `${aliasOf(meta, bucket.accountName)}: ${share} not accepted by the platform.`,
        // The broker's exact text, never rewritten. Several distinct reasons on
        // one account is possible (the book carries 13 distinct reason strings),
        // so they are listed rather than reduced to the first.
        quotes: [...bucket.reasons.entries()].map(([text, count]) => ({ text, count })),
        detail: null,
        count: n,
      });
    }
  } else {
    unstated.push({
      topic: 'rejected-orders',
      text: 'Order records for this close are not on file, so this report does not say whether any order was rejected. That is not the same as saying none was.',
    });
  }

  /* ----------------------------------------------------------------- *
   * 2. Accounts past their trailing drawdown, from the observed reading.
   *
   * accountLifecycle.readingOf treats EXACTLY 0 as "never measured" and returns
   * null — 585 of the 3,100 snapshot rows on the book read 0, and 89 of the 108
   * accounts whose last reading is 0 have read 0 on every close they ever had.
   * reconcile.js:348 reads `rawDD <= 0` as a breach, so any rule reusing `<= 0`
   * inherits 89 accounts declared dead by a column that was switched off. This
   * section states nothing about those accounts and says so under `unstated`.
   * ----------------------------------------------------------------- */
  const notMeasured = [];
  for (const snapshot of snapshots) {
    const key = nameKey(snapshot.accountName);
    const meta = metaFor(snapshot.accountName);
    const record = lifecycleByAccount.get(key);
    // Cash accounts have no trailing rule at all — accountLifecycle.breachOf
    // returns null for them rather than false, so they can never reach FINISHED
    // and can never be "not measured" either. Skipped before either branch so
    // neither sentence is written about an account the rule does not apply to.
    if (isCashType(meta.accountType) || record?.cash) continue;
    // FINISHED means the LATEST measured reading is a breach (a later healthy
    // reading clears it — 1 of 50 accounts that went negative recovered a
    // buffer), so this is a statement about where the account stands, not about
    // something that happened today. The reading carries its own date because it
    // is often older than the close being reported: readingOf() returns null for
    // a trailing drawdown of exactly 0, which is 585 of 3,100 rows.
    if (record && record.state === LIFECYCLE_STATES.FINISHED) {
      const value = record.drawdown.value;
      reasons.push({
        kind: REASON_KINDS.ACCOUNT_STOPPED,
        accountName: snapshot.accountName,
        alias: aliasOf(meta, snapshot.accountName),
        headline: record.drawdownModel === 'limit'
          ? `${aliasOf(meta, snapshot.accountName)} has reached its drawdown allowance: ${formatCurrency(Math.abs(value))} of ${formatCurrency(record.maxDrawdownLimit)} on ${record.drawdown.date}.`
          : `${aliasOf(meta, snapshot.accountName)} is past its trailing drawdown: the platform reported ${formatCurrency(value)} of remaining buffer on ${record.drawdown.date}.`,
        // Carried because it is the fact a CAM is asked about first, and it is
        // the one the report has never shown: the desk's own status column and
        // the observed reading disagree for 130 of the 487 testable accounts on
        // this book, so only the observed reading is stated and the declared
        // status is not printed to the client at all.
        detail: record.sinceBreach && record.sinceBreach.closesReported > 0
          ? `It has reported on ${record.sinceBreach.closesReported} ${plural(record.sinceBreach.closesReported, 'close', 'closes')} since ${record.sinceBreach.firstDate}, trading in ${record.sinceBreach.closesTraded} of them.`
          : null,
        quotes: [],
        count: 1,
      });
      continue;
    }
    if (record && record.drawdown.value === null && !record.cash) notMeasured.push(aliasOf(meta, snapshot.accountName));
  }
  if (notMeasured.length) {
    unstated.push({
      topic: 'trailing-drawdown',
      text: `No trailing drawdown figure is stated for ${notMeasured.length} ${plural(notMeasured.length, 'account', 'accounts')} (${notMeasured.join(', ')}): the platform export has never carried that column for ${plural(notMeasured.length, 'it', 'them')}. Not measured is not the same as no buffer left.`,
    });
  }

  /* ----------------------------------------------------------------- *
   * 3. Strategies assigned and none switched on, on an account that also did
   *    nothing.
   *
   * The gate is the whole design. 1,273 of 3,100 snapshot rows on the book
   * (41%) carry strategy rows with every one disabled, and 261 of 535 imports
   * (49%) are entirely in that state, so listing the condition on its own would
   * put a line on half of every client's days. What is worth saying is the
   * narrower thing: this account is flat AND the strategies on it were off.
   * Both halves are stated; the link between them is not.
   * ----------------------------------------------------------------- */
  for (const snapshot of snapshots) {
    const key = nameKey(snapshot.accountName);
    const meta = metaFor(snapshot.accountName);
    const rows = strategiesFor(snapshot, strategiesByAccount.get(key));
    if (!rows.length) continue;
    const states = rows.map(enabledState);
    if (states.some((state) => state === 'on') || states.some((state) => state === 'unknown')) continue;

    const counts = activity.get(key) || null;
    const realized = Number(snapshot.grossRealizedPnl || 0);
    if (realized !== 0) continue;
    if (ordersEvidence === EVIDENCE.OBSERVED && counts && (counts.orders > 0 || counts.executions > 0)) continue;

    const names = rows.map((row) => row.strategyName || row.strategyFamily || 'Strategy');
    reasons.push({
      kind: REASON_KINDS.STRATEGIES_ALL_OFF,
      accountName: snapshot.accountName,
      alias: aliasOf(meta, snapshot.accountName),
      headline: `${aliasOf(meta, snapshot.accountName)}: ${rows.length} ${plural(rows.length, 'strategy is', 'strategies are')} assigned to this account and none ${plural(rows.length, 'was', 'were')} switched on in this close.`,
      detail: `${plural(rows.length, 'Assigned', 'Assigned')}: ${names.join(', ')}. The account recorded no realized profit or loss${ordersEvidence === EVIDENCE.OBSERVED ? ' and sent no orders' : ''} on this close.`,
      quotes: [],
      count: rows.length,
    });
  }

  /* ----------------------------------------------------------------- *
   * 4. Registered accounts with no row in this close.
   * ----------------------------------------------------------------- */
  const closes = (client?.dailyImports || [])
    .filter((close) => close?.date && String(close.date).slice(0, 10) <= date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstSeen = new Map();
  const lastSeen = new Map();
  for (const close of closes) {
    const day = isoDay(close.date);
    for (const snapshot of close.snapshots || []) {
      const key = nameKey(snapshot.accountName);
      if (!key || !day) continue;
      if (!firstSeen.has(key)) firstSeen.set(key, day);
      if (day < date) lastSeen.set(key, day);
    }
  }

  // 12 of the 535 imports on the book carry 0 snapshot rows, one of them with 19
  // executions and 7 operational flags against 0 accounts. On such a close every
  // absence is ONE fact about the collection, not N facts about N accounts, and
  // counting it the other way reads as a desk-wide shutdown.
  const clientFiledNothing = snapshots.length === 0;
  const absent = { [ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE]: [], [ABSENCE_REASONS.NOT_YET_REPORTING]: [], [ABSENCE_REASONS.ABSENT_STILL_LIVE]: [], [ABSENCE_REASONS.ABSENT_FINISHED]: [] };
  let countedApartIgnore = 0;
  let countedApartSimulation = 0;
  let notYetRegistered = 0;

  for (const [accountName, meta] of Object.entries(client?.accountRegistry || {})) {
    const key = nameKey(accountName);
    if (reported.has(key)) continue;

    // A registered simulation account only appears in the grid while somebody
    // has it loaded, so it is absent on most closes by design — reconcile.js
    // exempts it from the CRM's own Missing-account sweep for the same reason.
    // Counted apart rather than dropped so the report never claims a complete
    // sweep it did not do.
    if (classifyAccountNature(meta || {}, { accountName }).nature === ACCOUNT_NATURES.SIMULATION) {
      countedApartSimulation += 1;
      continue;
    }
    // 84 of 764 accounts on the book are marked Inactive / Ignore, and for the
    // largest client 72 of its 74 never-reported account-days are these. A
    // reader who saw them in the headline would chase a collection failure that
    // is really a shelf of retired accounts.
    if (meta?.accountType === ACCOUNT_TYPES.IGNORE) {
      countedApartIgnore += 1;
      continue;
    }

    const existence = existsFrom(meta?.dateAdded, firstSeen.get(key) || null);
    if (!existence.date || existence.date > date) {
      notYetRegistered += 1;
      continue;
    }

    const record = lifecycleByAccount.get(key);
    const priorDate = lastSeen.get(key) || null;
    let reason;
    if (!firstSeen.has(key)) reason = ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE;
    else if (!priorDate) reason = ABSENCE_REASONS.NOT_YET_REPORTING;
    else if (record?.state === LIFECYCLE_STATES.FINISHED) reason = ABSENCE_REASONS.ABSENT_FINISHED;
    else reason = ABSENCE_REASONS.ABSENT_STILL_LIVE;

    absent[reason].push({
      accountName,
      alias: aliasOf(meta, accountName),
      lastReportedDate: priorDate,
      reason,
    });
  }

  const absentTotal = Object.values(absent).reduce((sum, list) => sum + list.length, 0);
  if (clientFiledNothing && absentTotal) {
    reasons.push({
      kind: REASON_KINDS.NOTHING_COLLECTED,
      accountName: null,
      alias: null,
      headline: `No account data reached us for ${date}. None of the ${absentTotal} ${plural(absentTotal, 'account', 'accounts')} on file appears in this close.`,
      detail: 'This is one gap in the day’s collection, not a statement about any individual account.',
      quotes: [],
      count: absentTotal,
    });
  } else if (absentTotal) {
    const groups = [];
    if (absent[ABSENCE_REASONS.ABSENT_STILL_LIVE].length) {
      const list = absent[ABSENCE_REASONS.ABSENT_STILL_LIVE];
      groups.push(`${list.map((row) => `${row.alias} (last reported ${row.lastReportedDate})`).join(', ')} — ${plural(list.length, 'reported', 'reported')} on an earlier close and did not appear in this one.`);
    }
    if (absent[ABSENCE_REASONS.ABSENT_FINISHED].length) {
      const list = absent[ABSENCE_REASONS.ABSENT_FINISHED];
      groups.push(`${list.map((row) => `${row.alias} (last reported ${row.lastReportedDate})`).join(', ')} — past ${plural(list.length, 'its', 'their')} trailing drawdown on the last reading we hold.`);
    }
    if (absent[ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE].length) {
      const list = absent[ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE];
      groups.push(`${list.map((row) => row.alias).join(', ')} — on file and not yet present in any close we hold.`);
    }
    if (absent[ABSENCE_REASONS.NOT_YET_REPORTING].length) {
      const list = absent[ABSENCE_REASONS.NOT_YET_REPORTING];
      groups.push(`${list.map((row) => row.alias).join(', ')} — first close still ahead of this date.`);
    }
    reasons.push({
      kind: REASON_KINDS.ACCOUNTS_ABSENT,
      accountName: null,
      alias: null,
      headline: `${absentTotal} ${plural(absentTotal, 'account', 'accounts')} on file did not appear in this close.`,
      detail: groups.join(' '),
      quotes: [],
      count: absentTotal,
      accounts: Object.values(absent).flat(),
    });
  }

  /* ----------------------------------------------------------------- *
   * 5. The contrast line: everything else reported and simply did not trade.
   *
   * Only printed when something material is already on the list. Standing alone
   * on a clean quiet day it would be the report's only sentence, and "3 of your
   * accounts did not trade" with nothing beside it reads as an accusation. Its
   * job is to stop `stopped` and `rejected` above from being read onto the rest
   * of the book.
   * ----------------------------------------------------------------- */
  const material = reasons.filter((entry) => entry.kind !== REASON_KINDS.ACCOUNTS_IDLE);
  const namedAccounts = new Set(material.map((entry) => nameKey(entry.accountName)).filter(Boolean));
  const idle = snapshots.filter((snapshot) => {
    const key = nameKey(snapshot.accountName);
    if (namedAccounts.has(key)) return false;
    if (Number(snapshot.grossRealizedPnl || 0) !== 0) return false;
    const counts = activity.get(key);
    return !counts || (counts.orders === 0 && counts.executions === 0);
  });
  if (material.length && idle.length && ordersEvidence === EVIDENCE.OBSERVED) {
    reasons.push({
      kind: REASON_KINDS.ACCOUNTS_IDLE,
      accountName: null,
      alias: null,
      headline: `The other ${idle.length} ${plural(idle.length, 'account', 'accounts')} in this close reported normally and sent no orders.`,
      detail: null,
      quotes: [],
      count: idle.length,
    });
  }

  const byKind = {};
  for (const entry of reasons) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;

  return {
    date,
    clientName: client?.name || 'Client',
    evidence: {
      orders: ordersEvidence,
      closesOnFile: closes.length,
      // Straight through from accountLifecycle so a caller can tell a genuine
      // "never traded" from "the order tables are not loaded".
      tradeHistoryLoaded: lifecycle.settings.tradeHistoryLoaded,
    },
    reasons,
    unstated,
    counts: {
      reasons: reasons.length,
      byKind,
      rejectedOrders: reasons
        .filter((entry) => entry.kind === REASON_KINDS.ORDERS_REJECTED)
        .reduce((sum, entry) => sum + entry.count, 0),
      absent: absentTotal,
      // Never folded into `absent`: these are expected absences and putting them
      // in the headline is what turns a shelf of retired accounts into a
      // collection incident.
      absentCountedApart: { ignore: countedApartIgnore, simulation: countedApartSimulation, notYetRegistered },
      idle: idle.length,
    },
    // True when there is anything at all to print, INCLUDING an `unstated` line.
    // A section that renders nothing because a source is missing would be the
    // exact failure this module exists to prevent.
    hasAnything: reasons.length > 0 || unstated.length > 0,
  };
}
