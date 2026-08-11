// What is running right now, how it ran, and in which group.
//
// Three things this module exists to stop happening.
//
// 1. THE VIEW EMPTYING OUT BECAUSE THE CALENDAR MOVED. The client workspace
//    seeds its date from the wall clock and looks the close up by exact match
//    (`getClientImportByDate` returns null when the date is not in the array).
//    On this book, on 2026-08-11, that is 0 of 96 clients with a close — the
//    whole screen reads as "you have not uploaded" when the truth is "the last
//    close was 12 days ago". Nothing here ever asks what today is. Every date
//    used is a date that exists in the data.
//
// 2. A STALE NUMBER WEARING TODAY'S DATE. Falling back to "the latest close"
//    without saying which date that is would be worse than the emptiness: an
//    account showing 2026-07-13 numbers under a 2026-08-11 header is a lie a
//    CAM would repeat to a client. So the as-of date is a property of the ROW,
//    not of the panel. It has to be, because the rows disagree: of 685 registry
//    accounts, 436 are in their client's most recent close and 220 last
//    reported 1 to 17 days before it (17 days behind: 64 accounts; 15 days: 41;
//    8 days: 34). One header date would be wrong for a third of the book.
//
// 3. "NOT MEASURED" RENDERED AS ZERO. 121 of the 457 accounts on the live book
//    carry no strategy row at all. That is not "nothing is running" — 245 other
//    accounts genuinely have every strategy switched off, and those two facts
//    lead to opposite actions. Three run states, never two.
//
// Nothing in this file reads `todayIsoDate()`. That is deliberate.

import { isLiveOrderState } from './tradingDayScope';
import { strategyFamilyOf } from './strategyRiskProfile';
import { parseStrategyVersion } from './csvImport';

/* ── Period ───────────────────────────────────────────────────────────────── */

/**
 * The period a strategy is running: `0 - URGO-4.5` → 0.
 *
 * The leading number IS the period. `strategyRiskProfile.strategyFamilyOf`
 * calls it "the NinjaTrader grid's row index"; that comment is wrong, and it is
 * the reason this number appears nowhere in the UI today.
 *
 * The set-file library proves it. `scripts/build-setfile-catalog.mjs` reads the
 * `<Name>` field out of the XML (line 316) and the period out of the FILENAME
 * (line 194, `Period\s+(?<period>\d+)\s*$`) — two independent sources. Across
 * all 876 catalogued files that have a parseable period, the numeric prefix of
 * `<Name>` equals the filename's period 876 times and disagrees 0 times:
 *
 *   ARPD/1 - ARPD (MGC) - 5 Min Candle - Low Risk - v1 - Period 0.xml
 *     -> <Name> "0 - ARPD-1.1"
 *
 * The 18 BulletBot files whose filenames the catalog pattern does not parse
 * still carry it: `Period 0/1/2` files hold `<Name>` "0 -"/"1 -"/"2 - Bullet
 * Bot-1.1". And the live name is that same field — the AddOn sends
 * `strategy.Name` verbatim (NinjaTraderFacade.cs:156) and it lands in
 * `strategy_snapshots.strategy_name` unchanged; 32 of the 38 distinct names on
 * this book are byte-identical catalog labels.
 *
 * Three disproofs of the row-index reading, all on the real book:
 *   - Row indices are unique per grid; these are not. Of 881 account-days
 *     holding 2+ strategy rows, 783 have EVERY row on the same prefix — nine
 *     `0 - X` rows on one account.
 *   - 8 groups carry the same strategy_name twice (same algo, two data series).
 *     A row index cannot repeat.
 *   - The catalog stores the FILENAME's leading index separately and it is
 *     constant across periods (all nine URGO MNQ 15-min files are index `1`
 *     while the Name prefix runs 0/1/2). That index also takes values like
 *     `1-L`, `4.2` — not integers. Do not read it as a period.
 *
 * Nothing else carries the period. Parameters cannot: the periods differ only
 * in the backtest `From`/`To` window, and neither name appears anywhere in the
 * 98 distinct parameter names on this book. The registry cannot: `algo_stack`
 * is null on 756 of 764 accounts and holds "Custom" on the other 8, and no
 * table has a period column.
 *
 * The `\s*` around the dash is load-bearing: 4 rows on this book are written
 * `0-Bullet Bot-1.1` with no spaces, and a stricter pattern drops them into the
 * unknown bucket.
 *
 * Unreadable returns null, never 0. 645 of 3805 strategy rows (17%) have no
 * prefix at all — 642 bare `Bullet Bot-1.1` plus 3 `IFSP-PF-1.1`. The library
 * contains ZERO Bullet Bot files whose `<Name>` is unprefixed, so those rows
 * are a name that was edited inside NinjaTrader, not a period-0 account.
 * Calling them 0 would put 642 rows in a group they may not belong to.
 */
export function periodOf(strategyName) {
  const match = String(strategyName || '').trim().match(/^(\d+)\s*-\s*\S/);
  if (!match) return null;
  return Number(match[1]);
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

/**
 * Group keys in render order.
 *
 * Period is a property of the STRATEGY ROW, not of the account. On this book
 * 97 of 2280 account-days (4.3%) run more than one period at once — and never
 * the same algo at two periods, so a mixed account is running different algos
 * from different periods (`0 - IFSP-1.1` + `1 - RBO-1.8` + `2 - OGX-2.4`).
 * Modelling it as one value per account would misreport all 97, so `mixed` is
 * its own group rather than a coin flip between two.
 *
 * `unstated` and `no-data` are separate for the same reason `null` is not 0:
 * `unstated` means strategies are loaded and their names lost the prefix,
 * `no-data` means the account reported a balance and no strategy row at all.
 */
export const GROUP_ORDER = ['period-0', 'period-1', 'period-2', 'mixed', 'unstated', 'no-data'];

const GROUP_LABELS = {
  'period-0': 'Period 0',
  'period-1': 'Period 1',
  'period-2': 'Period 2',
  mixed: 'Mixed periods',
  unstated: 'Period not stated',
  'no-data': 'No strategy data',
};

const GROUP_NOTES = {
  mixed: 'More than one period running on the same account — different algorithms, each on its own period.',
  unstated:
    'These strategy names carry no period prefix. The set-file library has no unprefixed build, so the name was most likely edited inside NinjaTrader. Unknown, not period 0.',
  'no-data':
    'The account reported a balance on this close but no strategy row came with it. That is not the same as everything being switched off.',
};

export function groupLabelOf(key) {
  return GROUP_LABELS[key] || key;
}

export function groupNoteOf(key) {
  return GROUP_NOTES[key] || null;
}

function groupKeyFor({ periods, hasUnstated, strategyCount }) {
  if (!strategyCount) return 'no-data';
  if (periods.length > 1) return 'mixed';
  if (periods.length === 1) return `period-${periods[0]}`;
  if (hasUnstated) return 'unstated';
  return 'no-data';
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

const lower = (value) => String(value || '').toLowerCase();

/**
 * A number, or null when the field was absent.
 *
 * Zero survives — a flat day is a real result. `undefined`, `null`, `''` and
 * anything unparseable do not, because `Number(x || 0)` reporting an account
 * that never sent a balance as $0 is the failure this rule exists for.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * `enabled` as three values, not two.
 *
 * Today every one of the 3805 strategy rows on the book is a hard boolean, so
 * this is a pass-through. It is written this way because the collapse to false
 * happens in three places on the way in (`Boolean(row.enabled)` in
 * supabaseStore, `Boolean(strategy.enabled)` in dailyImportPersistence,
 * `parseBool` in csvImport, which maps a MISSING column to false) and the
 * headline claim of this panel is "this is running". The first grid exported
 * without an Enabled column would otherwise report every strategy as off.
 */
function enabledOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function dayGap(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Closes with a usable date, oldest first, optionally clamped to a bound. */
function closesOf(client, asOfDate) {
  const bound = String(asOfDate || '').slice(0, 10);
  return (client?.dailyImports || [])
    .filter((entry) => entry?.date && (!bound || String(entry.date).slice(0, 10) <= bound))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * The most recent close on the whole desk, clamped the same way.
 *
 * Used only to say how far behind the desk a client's own latest close sits.
 * It is a date that exists in the data; the wall clock is not consulted, so a
 * book opened next month reads exactly the same as it does today.
 */
export function bookLatestDateOf(clients = [], asOfDate = '') {
  let latest = null;
  for (const client of clients) {
    const last = closesOf(client, asOfDate).at(-1);
    if (last?.date && (!latest || String(last.date) > latest)) latest = String(last.date);
  }
  return latest;
}

/* ── Retirement ───────────────────────────────────────────────────────────── */

/**
 * Accounts the desk has already stood down.
 *
 * Kept and counted rather than filtered away silently — 84 registry accounts
 * are typed `Inactive / Ignore` and 52 more carry a Failed or Inactive status,
 * and a panel that just dropped 136 rows would be a second kind of emptiness.
 */
function retirementOf(meta) {
  if (!meta) return null;
  if (meta.accountType === 'Inactive / Ignore') return 'Typed Inactive / Ignore';
  if (meta.status === 'Failed') return 'Account failed';
  if (meta.status === 'Inactive') return 'Marked inactive';
  return null;
}

/* ── Strategy rows ────────────────────────────────────────────────────────── */

function describeStrategy(strategy) {
  const name = String(strategy?.strategyName || '').trim();
  return {
    name,
    family: strategy?.strategyFamily || strategyFamilyOf(name) || null,
    version: strategy?.strategyVersion || parseStrategyVersion(name) || null,
    instrument: strategy?.instrument || null,
    dataSeries: strategy?.dataSeries || null,
    direction: strategy?.direction || null,
    period: periodOf(name),
    enabled: enabledOrNull(strategy?.enabled),
    realized: numberOrNull(strategy?.realized),
    unrealized: numberOrNull(strategy?.unrealized),
  };
}

/* ── One account ──────────────────────────────────────────────────────────── */

function buildAccountRow({
  accountName,
  meta,
  inRegistry,
  close,
  snapshot,
  clientLatestDate,
  bookLatestDate,
  closeCount,
}) {
  const strategies = (snapshot?.strategies || []).map(describeStrategy);
  const periods = [...new Set(strategies.map((item) => item.period).filter((value) => value !== null))]
    .sort((a, b) => a - b);
  const hasUnstated = strategies.some((item) => item.period === null);
  const enabledCount = strategies.filter((item) => item.enabled === true).length;
  const disabledCount = strategies.filter((item) => item.enabled === false).length;
  const unknownEnabledCount = strategies.filter((item) => item.enabled === null).length;

  // Three states. `unmeasured` is 121 of 457 accounts on this book and it is
  // the one a CAM has to chase — the account reported, the strategy export did
  // not. Folding it into `idle` would tell them nothing is running when in fact
  // nobody looked.
  let runState = 'unmeasured';
  if (strategies.length) runState = enabledCount > 0 ? 'running' : 'idle';

  const asOfDate = close?.date ? String(close.date).slice(0, 10) : null;

  // Fills are only countable when the close carried an execution list at all.
  // 13 of the 84 live closes have none, and reporting those accounts as "0
  // trades" would claim they sat out a day nobody measured.
  const closeHasExecutions = Boolean(close?.executions?.length);
  const fills = closeHasExecutions
    ? (close.executions || []).filter((execution) => lower(execution.accountName) === lower(accountName)).length
    : null;

  // isLiveOrderState is the codebase's only definition of "working now" that is
  // not a stale flag, so it is reused rather than reinvented. Reported, never
  // used to decide runState: `Initialized` alone is 1642 of the 3153 orders on
  // the live closes, and NinjaTrader initialises a strategy's unsent stop and
  // target objects, so a high count here does not mean live exposure.
  const closeHasOrders = Boolean(close?.orders?.length);
  const workingOrders = closeHasOrders
    ? (close.orders || []).filter(
      (order) => lower(order.accountName) === lower(accountName) && isLiveOrderState(order.state),
    ).length
    : null;

  const session = snapshot
    ? {
      realized: numberOrNull(snapshot.grossRealizedPnl),
      unrealized: numberOrNull(snapshot.unrealizedPnl),
      balance: numberOrNull(snapshot.accountBalance),
      weekly: numberOrNull(snapshot.weeklyPnl),
      drawdown: numberOrNull(snapshot.trailingMaxDrawdown),
    }
    : null;

  // The strategy rows are NOT a breakdown of the account's day.
  //
  // On the live book, 234 of the 416 accounts that carry both a session and a
  // strategy row disagree: 360 have every strategy row at 0.00 realized, and
  // 195 of those sit on an account that moved real money (one account here
  // reads -$448 for the day beside a single strategy row reading $0.00).
  // NinjaTrader's Strategies grid reports realized since the strategy instance
  // was enabled, and enabling one resets it — it is not the day's attribution.
  // Both numbers are shown and the gap is stated, because silently printing a
  // per-strategy $0 under an account that lost $448 reads as "this algorithm
  // made nothing today", which is a claim the data does not support.
  const measuredRealized = strategies.filter((item) => item.realized !== null);
  const strategyRealized = measuredRealized.length
    ? measuredRealized.reduce((sum, item) => sum + item.realized, 0)
    : null;
  const realizedGap = session?.realized !== null && session?.realized !== undefined && strategyRealized !== null
    ? Math.round((session.realized - strategyRealized) * 100) / 100
    : null;

  // "Did it trade" is three-valued too. A fill or any P&L movement is a yes.
  // Zero fills on a close that counted fills is a no. Zero P&L on a close that
  // shipped no executions is a shrug — flat and untraded look identical from
  // the balance alone, and this book has 13 such closes.
  let traded = null;
  if (fills !== null && fills > 0) traded = true;
  else if (session && (session.realized || session.unrealized)) traded = true;
  else if (fills !== null) traded = false;

  return {
    accountName,
    alias: meta?.alias || accountName,
    accountType: meta?.accountType || null,
    status: meta?.status || null,
    connection: snapshot?.connection || meta?.connection || null,
    inRegistry,
    reported: Boolean(snapshot) && asOfDate !== null && asOfDate === clientLatestDate,
    asOfDate,
    daysBehindClose: dayGap(asOfDate, clientLatestDate),
    daysBehindBook: dayGap(asOfDate, bookLatestDate),
    closeCount,
    retiredReason: retirementOf(meta),
    strategies,
    strategyCount: strategies.length,
    enabledCount,
    disabledCount,
    unknownEnabledCount,
    runState,
    periods,
    hasUnstatedPeriod: hasUnstated,
    groupKey: groupKeyFor({ periods, hasUnstated, strategyCount: strategies.length }),
    session,
    strategyRealized,
    realizedGap,
    fills,
    traded,
    workingOrders,
  };
}

/* ── One client ───────────────────────────────────────────────────────────── */

function emptyTotals() {
  return {
    accounts: 0,
    reporting: 0,
    behind: 0,
    neverReported: 0,
    running: 0,
    // `running` on its own is a present-tense claim that a third of these rows
    // cannot support, and the panel used to print it as one number beside the
    // client's latest close date.
    //
    // Sweeping the real book: 121 accounts are badged running and 31 of them
    // last reported BEFORE their own client's most recent close, by up to 17
    // days. On SEVEN clients every single running account is stale — Vale Frost
    // renders "last close 2026-07-30 · 4 running" and all four of those four
    // last appeared on 2026-07-13, while every account that did report on
    // 2026-07-30 is idle or unmeasured. The honest reading of Vale Frost is
    // "0 running on the latest close, 4 that were running 17 days ago", and
    // those are opposite instructions: one says the desk is flat, the other
    // says four accounts have gone dark with strategies enabled.
    //
    // Same shape as the 1,900-against-a-header-reading-253 defect: a number
    // rendered next to a date it does not belong to. Split, never summed.
    runningOnLatestClose: 0,
    runningBehindLatestClose: 0,
    idle: 0,
    unmeasured: 0,
    strategyRows: 0,
    strategiesOn: 0,
    strategiesOff: 0,
    strategiesUnknown: 0,
    traded: 0,
    flat: 0,
    tradedUnknown: 0,
  };
}

function tally(totals, row) {
  totals.accounts += 1;
  if (row.asOfDate === null) totals.neverReported += 1;
  else if (row.reported) totals.reporting += 1;
  else totals.behind += 1;
  totals[row.runState] += 1;
  if (row.runState === 'running') {
    // `reported` is already "this row's close IS the client's latest close",
    // so the split costs nothing and cannot drift from the as-of stamp the row
    // prints next to it.
    if (row.reported) totals.runningOnLatestClose += 1;
    else totals.runningBehindLatestClose += 1;
  }
  totals.strategyRows += row.strategyCount;
  totals.strategiesOn += row.enabledCount;
  totals.strategiesOff += row.disabledCount;
  totals.strategiesUnknown += row.unknownEnabledCount;
  if (row.traded === true) totals.traded += 1;
  else if (row.traded === false) totals.flat += 1;
  else totals.tradedUnknown += 1;
  return totals;
}

function groupRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.groupKey)) byKey.set(row.groupKey, []);
    byKey.get(row.groupKey).push(row);
  }
  const known = GROUP_ORDER.filter((key) => byKey.has(key));
  // A period beyond 0/1/2 has never appeared on this book, but the prefix is a
  // free integer and a new library folder would produce one. Ordering it after
  // the known keys rather than dropping it keeps an unseen period visible.
  const extra = [...byKey.keys()]
    .filter((key) => !GROUP_ORDER.includes(key))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...extra].map((key) => {
    const accounts = byKey.get(key);
    return {
      key,
      label: groupLabelOf(key),
      note: groupNoteOf(key),
      accounts,
      totals: accounts.reduce(tally, emptyTotals()),
    };
  });
}

/**
 * Every account of one client, each carrying the date its numbers come from.
 *
 * `asOfDate` is a BOUND, not a target. Empty means "each account's own most
 * recent close"; a date means "as it stood on or before that date". There is no
 * exact-match path and no null return for a date with no import — that is the
 * defect this replaces.
 *
 * Accounts are resolved individually because they do not move together: on this
 * book 436 of 685 registry accounts are in their client's most recent close and
 * 220 last reported up to 17 days earlier. Each row therefore carries its own
 * close, its own date, and its own distance behind that client's latest close.
 */
export function buildLiveAccounts(client, { asOfDate = '', bookLatestDate = null } = {}) {
  const closes = closesOf(client, asOfDate);
  const clientLatest = closes.at(-1) || null;
  const clientLatestDate = clientLatest?.date ? String(clientLatest.date).slice(0, 10) : null;

  // Walk newest-first once and keep the first close each account appears in.
  // That close, not the client's latest, is the source of truth for the row.
  const latestByAccount = new Map();
  const countByAccount = new Map();
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const close = closes[index];
    for (const snapshot of close.snapshots || []) {
      const key = lower(snapshot.accountName);
      if (!key) continue;
      countByAccount.set(key, (countByAccount.get(key) || 0) + 1);
      if (!latestByAccount.has(key)) latestByAccount.set(key, { close, snapshot });
    }
  }

  // Registry keys and CSV keys disagree on case throughout this codebase, and
  // 21 accounts on the live book appear in a close with no registry row at all,
  // so the union is built from both sides.
  const registry = client?.accountRegistry || {};
  const names = new Map();
  for (const name of Object.keys(registry)) names.set(lower(name), name);
  for (const [key, found] of latestByAccount) {
    if (!names.has(key)) names.set(key, found.snapshot.accountName);
  }

  const metaByLower = Object.fromEntries(Object.entries(registry).map(([name, meta]) => [lower(name), meta]));

  const rows = [...names.entries()].map(([key, accountName]) => buildAccountRow({
    accountName,
    meta: metaByLower[key] || null,
    inRegistry: Boolean(metaByLower[key]),
    close: latestByAccount.get(key)?.close || null,
    snapshot: latestByAccount.get(key)?.snapshot || null,
    clientLatestDate,
    bookLatestDate,
    closeCount: countByAccount.get(key) || 0,
  }));

  // Reporting first, then the freshest stale rows, then never-reported. Within
  // a date, running before idle: the CAM scans for what is live.
  const runRank = { running: 0, idle: 1, unmeasured: 2 };
  rows.sort((a, b) => {
    if (a.reported !== b.reported) return a.reported ? -1 : 1;
    if ((a.asOfDate || '') !== (b.asOfDate || '')) return (b.asOfDate || '').localeCompare(a.asOfDate || '');
    if (runRank[a.runState] !== runRank[b.runState]) return runRank[a.runState] - runRank[b.runState];
    return String(a.alias).localeCompare(String(b.alias));
  });

  const active = rows.filter((row) => !row.retiredReason);
  const retired = rows.filter((row) => row.retiredReason);

  // How far back the stale "running" rows reach, for the one sentence that
  // stops the split above from reading as a rounding note. Vale Frost's four
  // are all 17 days behind their own client's latest close. null when there are
  // none — not 0, which would claim they are current.
  const behindGaps = active
    .filter((row) => row.runState === 'running' && !row.reported)
    .map((row) => row.daysBehindClose)
    .filter((days) => days !== null);
  const runningBehindMaxDays = behindGaps.length ? Math.max(...behindGaps) : null;

  // The bridge to "Accounts (all time)", which sits directly above this panel
  // in the client workspace and counts registry rows only.
  //
  // The two disagree on 7 of 96 clients because this view is the UNION of the
  // registry and the account names seen in closes: Gray Elm renders 20 rows
  // (18 live + 2 stood down) against a registry of 15, and the whole 5-row gap
  // is snapshots whose account has no registry row. The worst is a Devon North
  // whose registry is EMPTY — "Accounts (all time) 0" directly above six
  // accounts with balances. 33 such rows book-wide. Counted here so the panel
  // can state the arithmetic instead of leaving a reader to assume one of the
  // two numbers is broken.
  const notInRegistry = rows.filter((row) => !row.inRegistry).length;

  return {
    clientId: client?.id || null,
    clientName: client?.name || '',
    latestCloseDate: clientLatestDate,
    runningBehindMaxDays,
    registryAccounts: Object.keys(registry).length,
    notInRegistry,
    daysBehindBook: dayGap(clientLatestDate, bookLatestDate),
    bookLatestDate,
    closeCount: closes.length,
    accounts: active,
    // Stood-down accounts are kept whole, not just counted, so the panel can
    // open them. 111 of the 706 rows on this book are retired; dropping them
    // without a way back would be a second kind of emptiness.
    retired,
    retiredCount: retired.length,
    groups: groupRows(active),
    totals: active.reduce(tally, emptyTotals()),
    // Distinct as-of dates on the surfaced rows. Length > 1 is the reason this
    // panel refuses a single header date, and the panel says so out loud.
    asOfDates: [...new Set(active.map((row) => row.asOfDate).filter(Boolean))].sort().reverse(),
  };
}

/**
 * The same view for a whole CAM book.
 *
 * The desk-wide latest close is resolved once and handed down so every client
 * can be read against the same yardstick — a client 17 days behind the desk is
 * the finding, and it is invisible from that client's own numbers alone.
 */
export function buildLiveBook(clients = [], { asOfDate = '' } = {}) {
  const bookLatestDate = bookLatestDateOf(clients, asOfDate);
  const views = (clients || []).map((client) => buildLiveAccounts(client, { asOfDate, bookLatestDate }));

  const totals = emptyTotals();
  for (const view of views) {
    for (const key of Object.keys(totals)) totals[key] += view.totals[key];
  }

  const allRows = views.flatMap((view) => view.accounts.map((row) => ({ ...row, clientId: view.clientId, clientName: view.clientName })));

  return {
    bookLatestDate,
    clients: views,
    // Clients with no close at all under this bound. 12 of 96 on this book —
    // they have registry accounts and have never reported one.
    clientsWithoutClose: views.filter((view) => !view.latestCloseDate).length,
    retiredCount: views.reduce((sum, view) => sum + view.retiredCount, 0),
    // Same reconciliation as the single-client view, summed: 33 rows across 7
    // clients trade under a name the registry does not hold.
    notInRegistry: views.reduce((sum, view) => sum + view.notInRegistry, 0),
    clientsWithOrphans: views.filter((view) => view.notInRegistry > 0).length,
    // Clients where NOT ONE running account is on their own latest close — the
    // reading that is entirely stale rather than partly. 7 of 96.
    clientsRunningAllStale: views.filter(
      (view) => view.totals.running > 0 && view.totals.runningOnLatestClose === 0,
    ).length,
    groups: groupRows(allRows),
    totals,
  };
}
