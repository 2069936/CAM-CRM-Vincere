import { summarizePnlSources } from './pnlSourceSummary.js';
// Extension explicit: this module is now on the import chain of a Vercel
// serverless function (server/export/absentAccounts.js -> accountLifecycle ->
// here), and plain Node ESM does not resolve './tradingDayScope'. The other two
// specifiers on this line's neighbours already carried it.
import { scopeExecutionsToDay, scopeOrdersToDay } from './tradingDayScope.js';
import { deriveTrailingDrawdown, deriveWeeklyPnl, drawdownThresholds } from './derivedAccountMetrics.js';
import { deriveStrategyPnlByAccount } from './deriveStrategyPnl.js';
import { carryForwardLots } from './carryForwardLots.js';
import { joinDerivedStrategies } from './joinDerivedStrategies.js';
import {
  ACCOUNT_NATURES,
  SIMULATION_ACCOUNT_TYPE,
  classifyAccountNature,
  mergeSimulationRows,
  splitSimulationRows,
} from './simulationAccounts.js';

export const ACCOUNT_TYPES = {
  UNASSIGNED: 'Unassigned',
  EVALUATION_BULLET: 'Evaluation - Bullet Bot',
  EVALUATION_STANDARD: 'Evaluation - Standard',
  FUNDED: 'Funded',
  CASH_IRA: 'Cash - IRA',
  CASH_STRAIGHT: 'Cash - Straight',
  // LEGACY. Rows written before the IRA/Straight split still store 'Cash' in
  // Supabase (trading_accounts.account_type is free text, no CHECK constraint),
  // so this key must stay: removing it would make every pre-split row fall
  // through to Unassigned behaviour.
  CASH: 'Cash',
  IGNORE: 'Inactive / Ignore',
  // ADDED, never assigned to an existing row by migration. Every one of the 764
  // trading_accounts on the real book carries one of the six values above, so no
  // stored row changes behaviour because this exists. It is only written when a
  // brand-new account arrives already recognised as a simulator, or when a CAM
  // picks it — see simulationAccounts.js for why the money in it is never summed
  // with the rest.
  SIMULATION: SIMULATION_ACCOUNT_TYPE,
};

// Every value that must behave like cash: no profit target, no drawdown limit,
// balance-only reporting. Branch on isCashType(), never on a single string.
export const CASH_ACCOUNT_TYPES = [
  ACCOUNT_TYPES.CASH_IRA,
  ACCOUNT_TYPES.CASH_STRAIGHT,
  ACCOUNT_TYPES.CASH,
];

export function isCashType(accountType) {
  return CASH_ACCOUNT_TYPES.includes(accountType);
}

export function isLegacyCashType(accountType) {
  return accountType === ACCOUNT_TYPES.CASH;
}

// Prop-firm family: funded plus any evaluation. Unassigned, Inactive / Ignore
// and Simulation deliberately match neither this nor isCashType — a simulation
// account has no prop-firm contract to breach and no cash to report, so every
// consumer that branches on these two leaves it alone.
export function isPropAccountType(accountType) {
  const value = String(accountType || '').trim();
  return value === ACCOUNT_TYPES.FUNDED || value.startsWith('Evaluation');
}

// Simulated money. Kept as a predicate rather than a bare string comparison for
// the same reason isCashType exists: the branches that must not fire on it
// (drawdown ladder, profit targets, payout eligibility, desk capital) are spread
// across eight modules.
export function isSimulationAccountType(accountType) {
  return String(accountType || '').trim() === ACCOUNT_TYPES.SIMULATION;
}

export const ACCOUNT_STATUSES = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  RESERVE: 'Reserve',
  FAILED: 'Failed',
  PAYOUT_HOLD: 'Payout Hold',
};

export const PAYOUT_STATES = {
  NOT_REQUESTED: 'Not requested',
  REQUEST_PAYOUT: 'Request payout',
  PAYOUT_REQUESTED: 'Payout requested',
  PAYOUT_APPROVED: 'Payout approved',
  CLEAR_TO_TRADE: 'Clear to trade',
};

// Risk level is assigned manually by the team (not inferred). Empty = Unassigned.
export const RISK_LEVELS = ['Low', 'Medium', 'High'];

function nowIso() {
  return new Date().toISOString();
}

export function makeAccountAlias(accountName, connection = '') {
  const name = String(accountName || '');
  const label = String(connection || 'Account').trim() || 'Account';
  if (!name) return label;
  // Last four, like the tail of a card number: LTATAGREH506107949826 becomes
  // "Legends Trading - 9826", which is short enough to say out loud and does not
  // put a full prop-firm account number in front of whoever is looking.
  //
  // Short names are shown whole instead. A 6-character name has nothing to mask
  // — the tail reveals as much as the name does — and truncating it reads as
  // breakage rather than discretion: Sim101 became "Live - m101" in a
  // client-facing report, which looks like a bug to the client and to the CAM.
  if (name.length <= 8) return `${label} - ${name}`;
  // A nickname somebody typed is shown whole too. `Craig - Sub 1` was printed to
  // the client as `Live - ub 1`: the same "looks like breakage" the length rule
  // was added to stop, on a live funded account, four rows above a simulated one
  // that renders correctly.
  //
  // A space alone is NOT enough to call something a nickname, though. The masking
  // exists so a full prop-firm account number does not sit in front of whoever is
  // looking, and a CAM who types the firm in beside the number — `Apex 12345678`,
  // `Topstep Eval 50285301` — produces a name with both a space and the whole
  // number in it. Keyed off the number instead: a run of 5+ digits is an issued
  // identifier, never a nickname, so it keeps the last-four treatment however it
  // is spaced. `Craig - Sub 1` has no such run and is shown whole.
  if (/\s/.test(name) && !/\d{5}/.test(name)) return `${label} - ${name}`;
  return `${label} - ${name.slice(-4)}`;
}

/**
 * The type a never-before-seen account starts life with.
 *
 * Only a BRAND-NEW account can be seeded as Simulation, and only when the
 * classifier already recognises it (name matches NinjaTrader's Sim<number>, or
 * the platform said so). An account that already has a stored type keeps it —
 * `existing.accountType` wins in createDefaultAccount — so this can never
 * reclassify a row a CAM has touched, and the seeding is announced with a
 * `New simulation account` flag rather than happening silently.
 */
function defaultAccountTypeFor(account, existing) {
  if (existing?.accountType) return existing.accountType;
  const nature = classifyAccountNature(
    { ...existing, accountName: account.accountName },
    { accountName: account.accountName, isSimulated: account.isSimulated },
  ).nature;
  return nature === ACCOUNT_NATURES.SIMULATION
    ? ACCOUNT_TYPES.SIMULATION
    : ACCOUNT_TYPES.UNASSIGNED;
}

function createDefaultAccount(account, existing = {}) {
  return {
    accountName: account.accountName,
    alias: existing.alias || makeAccountAlias(account.accountName, account.connection),
    connection: account.connection || existing.connection || '',
    accountType: defaultAccountTypeFor(account, existing),
    // The CAM's explicit override of the automatic simulation detection.
    // '' means "no opinion recorded, let the signals decide" — it is NOT a vote
    // for live money, which is why it is empty rather than 'live'.
    simulationMode: existing.simulationMode || '',
    status: existing.status || ACCOUNT_STATUSES.ACTIVE,
    payoutState: existing.payoutState || PAYOUT_STATES.NOT_REQUESTED,
    startBalance: existing.startBalance ?? '',
    targetProfit: existing.targetProfit ?? '',
    maxDrawdownLimit: existing.maxDrawdownLimit ?? '',
    // Which plan the client bought. Not derivable from anything the platform
    // reports, and it is what sets the drawdown: Legends 50k is 2,000 on
    // Apprentice and 2,200 on Elite.
    propFirmPlan: existing.propFirmPlan || '',
    riskLevel: existing.riskLevel || '',
    algoStack: existing.algoStack || '',
    dailyLossLimit: existing.dailyLossLimit || '',
    bulletBotPassType: existing.bulletBotPassType || '',
    bulletBotDirection: existing.bulletBotDirection || '',
    notes: existing.notes || '',
    dateAdded: existing.dateAdded || nowIso().slice(0, 10),
    dateFailed: existing.dateFailed || '',
    dateFunded: existing.dateFunded || '',
    dateLastPayout: existing.dateLastPayout || '',
    payoutCount: existing.payoutCount ?? 0,
  };
}

/**
 * Flag ids must be UUIDs.
 *
 * A flag raised here is written straight to operational_flags, whose primary key
 * is a uuid, and the same id is what the CRM later sends back to resolve it. A
 * composite key like `Strategy disabled-FTDFYL1001-za9s0gd` read fine as a React
 * key but Postgres rejected it, so closing a freshly imported flag failed: the
 * optimistic update hid it, the next load brought it back, and only after a
 * reload — once the row carried a database-generated uuid — did closing stick.
 */
function newFlagId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Older WebViews and pre-19 Node have no randomUUID. Shape matters more than
  // entropy here: an id Postgres rejects is worse than a weaker random one.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function makeFlag({ type, severity = 'Warning', accountName = '', message }) {
  return {
    // Unique id so flags never collide as React keys (which made them vanish).
    // Recalculate preserves triage by matching on type|account|message instead,
    // so a stable id is not needed for that.
    id: newFlagId(),
    type,
    severity,
    accountName,
    message,
    status: 'Open',
  };
}

function groupStrategiesByAccount(strategies = []) {
  return strategies.reduce((map, strategy) => {
    if (!strategy.accountName) return map;
    if (!map[strategy.accountName]) map[strategy.accountName] = [];
    map[strategy.accountName].push(strategy);
    return map;
  }, {});
}

function shouldExpectStrategy(meta) {
  if (!meta) return false;
  if (meta.accountType === ACCOUNT_TYPES.IGNORE) return false;
  // A simulation account is run when the desk wants to test something and left
  // idle the rest of the time. 10 of the 11 Sim101s on the real book carried no
  // strategy at all on 2026-08-06; flagging each of those Critical every close
  // would bury the one client whose sim was actually running.
  if (meta.accountType === ACCOUNT_TYPES.SIMULATION) return false;
  if ([ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE, ACCOUNT_STATUSES.FAILED, ACCOUNT_STATUSES.PAYOUT_HOLD].includes(meta.status)) {
    return false;
  }
  return meta.accountType !== ACCOUNT_TYPES.UNASSIGNED;
}

function hasActiveStrategy(strategies = []) {
  return strategies.some((strategy) => strategy.enabled);
}

// A source that says null means "I have no value for this" — preserved as null
// rather than pretended to be zero. Only an absent legacy field defaults to 0.
// Both are candidates for derivation; the distinction only matters when there is
// no history to derive from.
function isMissing(value) {
  return value === undefined || value === null;
}

function withoutDerivation(value) {
  return value === undefined ? 0 : value;
}

/**
 * What of a derivation is worth keeping on the snapshot — and what is not.
 *
 * deriveStrategyPnl returns twenty fields, and `reconcileDailyImport` needs all
 * of them: `byStrategy` is what the join carries onto the roster rows, and
 * `reconciles`/`positionAgrees`/`unpricedPairs`/`unknownInstruments`/
 * `refusedBooks` are what decide `status` in the first place. NONE of that has
 * to be STORED, and storing it is not free. This object is written verbatim into
 * account_snapshots.derivation (jsonb, step 37) and read back by two things that
 * select '*': supabaseStore.loadTable on every CRM state load, and
 * server/export/clientExport.js, whose own header records the busiest CAM's
 * default pull at 4.06 MB against a 4 MiB ceiling enforced as a 413. It is over
 * that line already. account_snapshots is ~322 B a row of scalars; the full
 * derivation measured 606 B a row mean on a real ten-folder export — the blob
 * was about to be two thirds of the row it hangs off.
 *
 * So this is a projection, and it is drawn on one rule: keep what cannot be
 * recovered from another stored column, drop what can.
 *
 *   status         Kept. Nothing else records the account-day's verdict, and
 *                  algoContribution refuses to show a split without seeing
 *                  'exact' here. It now also carries the two refusals —
 *                  'refused' (a book that could not be priced) and
 *                  'no-reported-gross' (no column to check the total against) —
 *                  which is why the residual's REASONS below have to be kept
 *                  whole: 'refused' says an account was declined, and only
 *                  `residual.reasons` says whether that was a carried-in
 *                  position or an instrument missing from the multiplier table,
 *                  and those two have different fixes.
 *   reportedGross  Kept, and load-bearing: mapAccountSnapshot does NOT store
 *                  `grossRealizedPnlReported`, so this is the only surviving
 *                  copy of the raw 'Gross realized PnL' column, and it is the
 *                  basis the display re-checks the derived rows add up to.
 *   residual       Kept whole — the realized amount, the pair count and the
 *                  reasons. This is money the fills paired and could not credit
 *                  to any one strategy; nothing else stores it, and the point of
 *                  the feature is that it is surfaced rather than folded away.
 *   join           Kept, trimmed to `status`, `published`, `offRoster`,
 *                  `offRosterRealized` and — only when it is non-empty —
 *                  `ambiguousNames`. Off-roster money is derived money that
 *                  belongs to a strategy on no row of this account's grid, so no
 *                  strategy_snapshots row can carry it — exactly the money the
 *                  old one-directional join deleted in silence.
 *
 * WHY `ambiguousNames` IS HERE AND NOT PER ROW. It is the one per-row verdict
 * this blob could not otherwise answer. Step 37 originally shipped a
 * `strategy_snapshots.derived_realized_join` column carrying ROW_JOIN per roster
 * row; measured through mapStrategy on the real ten-folder export that was
 * 37.1 B on EVERY strategy row, and four of its five values are recoverable from
 * `derived_realized` plus `status`/`published` here (the table is in the ROW_JOIN
 * comment in joinDerivedStrategies.js). Only 'ambiguous-name' was not: a row
 * refused because its name matched several roster rows looks exactly like a row
 * refused for any other reason. So the names are kept ONCE per account-day, and
 * only on a day that had any — 0 of 40 account-days on that export, so 0 bytes
 * there — instead of a string on all 1,033 strategy rows of the busiest CAM's
 * pull. Same fact, same recoverable per-row answer, ~37 KiB less.
 *
 * Dropped, with where to find them instead: `byStrategy` (per row, in
 * strategy_snapshots.derived_realized — storing it here is the same figures a
 * second time); `join.unmatchedRoster` (the published rows whose
 * `derived_realized` is null), `join.matchedRows` (the published rows whose
 * `derived_realized` is not), `join.rosterRows` (count the account's
 * strategy_snapshots rows), `join.derivedRows` (`matchedRows` + `offRoster` on a
 * published day); `attributedTotal`, `derivedTotal`, `difference`,
 * `joinedTotal`, `balanced` (arithmetic over figures already stored); `pairs`,
 * `unpricedPairs`, `detachedPairs`, `openContracts`, `carriedInContracts`,
 * `unknownInstruments`, `refusedBooks`, `carryInBasis`, `orderingBasis`,
 * `positionAgrees`, `reconciles` (inputs to `status`, which is stored — and
 * re-derivable from the executions, which are stored too).
 *
 * `refusedBooks` is the one of those worth pausing on, because it names an
 * instrument and looks like information nothing else holds. It is not: the
 * instrument is on every execution row of the same close, and which KIND of
 * refusal it was is in `residual.reasons`, which is kept. Storing the array
 * would be a third copy of a fact already in two places.
 *
 * AND AN ACCOUNT THAT DID NOT TRADE STORES NOTHING AT ALL. A 'no-trades'
 * derivation is sixteen fields of zero and one string; it makes exactly the
 * claim a NULL makes, at 560 bytes a row instead of none. Nineteen of the forty
 * account-days on that export were in this state. `algoContribution` reads an
 * absent derivation and a 'no-trades' one identically — neither can produce a
 * derived day — so this is invisible to the display and worth ~10.6 KB per forty
 * snapshots stored.
 *
 * NOT A WEAKENING OF THE RECONCILIATION. Everything above is still computed, and
 * every refusal still fires on the full result: the join sees `byStrategy`, the
 * per-row columns are written from it, and `status` is decided before this
 * function is reached. This only decides what survives the trip to the database.
 */
export function storableDerivation(derivation) {
  if (!derivation) return null;
  // Nothing happened. A null says that at no cost, and says it identically.
  if (derivation.status === 'no-trades') return null;
  const join = derivation.join || null;
  return {
    status: derivation.status,
    reportedGross: derivation.reportedGross ?? null,
    residual: derivation.residual || { realized: 0, pairs: 0, reasons: {} },
    ...(join ? {
      join: {
        status: join.status,
        published: Boolean(join.published),
        offRoster: join.offRoster || [],
        offRosterRealized: join.offRosterRealized || 0,
        // Omitted entirely on the ordinary day, which is every day that had no
        // duplicate-named roster row. An empty array here would be four more
        // bytes on every stored account-day to say "nothing happened", which is
        // the same mistake as storing a 'no-trades' derivation.
        ...(join.ambiguousNames?.length ? { ambiguousNames: [...join.ambiguousNames] } : {}),
      },
    } : {}),
  };
}

function createSnapshot(account, strategies, derived = {}, derivation = null) {
  const reportedTrailing = account.trailingMaxDrawdown;
  const reportedWeekly = account.weeklyPnl;
  // A number the grid reported always wins; we only fill a genuine hole.
  const useDerivedTrailing = isMissing(reportedTrailing) && derived.trailing != null;
  const useDerivedWeekly = isMissing(reportedWeekly) && derived.weekly != null;

  return {
    accountName: account.accountName,
    connection: account.connection || '',
    grossRealizedPnl: account.grossRealizedPnl === undefined ? 0 : account.grossRealizedPnl,
    pnlSource: account.pnlSource || null,
    trailingMaxDrawdown: useDerivedTrailing
      ? derived.trailing.value
      : withoutDerivation(reportedTrailing),
    // 'derived' means we reconstructed it from stored closes and it is a lower
    // bound — an intraday peak we never saw would only make it worse.
    trailingSource: useDerivedTrailing ? 'derived' : (isMissing(reportedTrailing) ? null : 'reported'),
    trailingPeak: useDerivedTrailing ? derived.trailing.peak : null,
    trailingHasGaps: useDerivedTrailing ? derived.trailing.hasGaps : false,
    accountBalance: account.accountBalance === undefined ? 0 : account.accountBalance,
    weeklyPnl: useDerivedWeekly
      ? derived.weekly.value
      : withoutDerivation(reportedWeekly),
    weeklyPnlSource: useDerivedWeekly ? 'derived' : (isMissing(reportedWeekly) ? null : 'reported'),
    unrealizedPnl: account.unrealizedPnl === undefined ? 0 : account.unrealizedPnl,
    // The raw 'Gross realized PnL' column, kept because grossRealizedPnl above
    // prefers the NET 'Realized PnL' whenever the grid exported both. The
    // derivation reconciles against gross; nothing else reads this.
    grossRealizedPnlReported: account.grossRealizedPnlReported ?? null,
    // What the fills say each strategy made, and — just as important — what they
    // could not say. Null when the account had no fills in this close, and
    // trimmed to the part that has to survive a reload: see storableDerivation.
    derivation: storableDerivation(derivation),
    strategies,
  };
}

function snapshotToAccount(snapshot) {
  return {
    accountName: snapshot.accountName,
    connection: snapshot.connection,
    grossRealizedPnl: snapshot.grossRealizedPnl,
    grossRealizedPnlReported: snapshot.grossRealizedPnlReported ?? null,
    trailingMaxDrawdown: snapshot.trailingMaxDrawdown,
    accountBalance: snapshot.accountBalance,
    weeklyPnl: snapshot.weeklyPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
  };
}

// `history` is the client's previously stored closes. NinjaTrader's API exposes
// neither weekly PnL nor trailing drawdown — they exist only as Accounts grid
// columns — so an automatic capture arrives without them. Given the history we
// reconstruct both rather than losing the drawdown flags on automatic closes.
//
// `priorImports` is the same client's stored daily_imports WITH their executions
// and orders, and it is what separates this caller from the one-day verifier.
// A position opened yesterday and closed today can only be priced by carrying
// yesterday's open lots forward, and only a caller that holds yesterday can do
// it — see carryForwardLots.js. Pass nothing and the derivation refuses every
// carried-in book rather than guessing at a cost basis; that is a safe default,
// not a correct one, so any path that CAN supply the history should.
export function reconcileDailyImport({ clientId, date, registry = {}, parsed, history = [], priorImports = [] }) {
  const accountsByName = {};
  const snapshots = [];
  const flags = [];
  // Build case-insensitive registry lookup so CSV names always find their metadata
  const registryByLower = Object.fromEntries(Object.entries(registry || {}).map(([k, v]) => [k.toLowerCase(), v]));
  // NOTHING is filtered out here any more.
  //
  // This used to drop every account, strategy, order and execution whose name
  // started with "sim". It did keep simulated money out of desk capital, but it
  // also deleted the desk's work: on 2026-08-06 Craig Weschke's only trading
  // account was his Sim101 and `orders=40 -> kept 0, execs=15 -> kept 0`, so the
  // report the CRM generated for him read $0 on a day his CAM wrote a paragraph
  // about how the SIM session went. Simulated rows are now carried through and
  // separated at the end by splitSimulationRows.
  const sourceAccounts = parsed.accounts || [];
  const reportedStrategies = parsed.strategies || [];
  // Scoped to the day before anything else reads them. The AddOn hands over
  // whatever NinjaTrader has loaded, which on a first capture is months of
  // history, and every row of it arrives stamped with today's trading date.
  const orders = scopeOrdersToDay(parsed.orders || [], date);
  const orderStrategyById = Object.fromEntries(orders.map((order) => [order.id, order.strategyName || '']));
  const executions = scopeExecutionsToDay(parsed.executions || [], date)
    .map((execution) => ({
      ...execution,
      strategyName: orderStrategyById[execution.orderId] || '',
    }));
  // The platform's own simulator flag, keyed by lower-cased account name.
  // NinjaTrader exposes Options.Provider == Provider.Simulator and the collector
  // does not read it yet (NinjaTraderFacade.cs:318 takes only the connection
  // name), so this is empty on every path today and the classifier falls back to
  // the account name. Wired now so shipping the flag needs no change here.
  const platformFlags = Object.fromEntries(
    sourceAccounts
      .filter((account) => typeof account.isSimulated === 'boolean')
      .map((account) => [String(account.accountName || '').toLowerCase(), account.isSimulated]),
  );
  // Per-account, per-strategy P&L derived from the fills themselves. The
  // Strategies grid reports `realized` on only a minority of rows, so on most
  // accounts this is the only thing that can answer "which algo did that".
  //
  // It is carried in `derivedRealized`, ALONGSIDE the reported `realized`, never
  // over it. The two must stay distinguishable for good: one is what
  // NinjaTrader said, the other is what we worked out, and a reader who cannot
  // tell them apart cannot judge either. `derivedRealized` is populated only
  // where the account's whole day reconciles to Gross realized PnL with nothing
  // left unattributed AND the roster join itself balances — a partial split
  // presented as a whole one is the failure this feature exists to avoid. The
  // full picture, including the residual, the join report and why anything could
  // not be attributed, travels on the snapshot as `derivation`.
  //
  // CARRY-IN. The CRM stores every day's executions and orders per daily_import,
  // so a lot opened on one close and sold on the next CAN be paired here — the
  // one thing scripts/verify-derived-pnl.mjs can never do from a single folder.
  // The replay refuses rather than guesses when the chain is broken: an account
  // whose stored closes do not explain the position it opens today (a client who
  // skipped an upload) is marked unavailable and its carried-in books are then
  // refused exactly as they would be with no history at all.
  // Simulated rows are merged back in for the replay. A stored close keeps them
  // in a separate `simulation` bucket, and an account whose fills were split out
  // of `executions` would look to the replay as though it had traded nothing —
  // which would report a phantom gap on the one kind of account whose carry-in
  // nobody would think to check.
  const carryIn = carryForwardLots({
    dailyImports: (priorImports || []).map((entry) => ({ date: entry?.date, ...mergeSimulationRows(entry) })),
    date,
  });
  const derivationByAccount = deriveStrategyPnlByAccount({
    executions,
    orders,
    accounts: sourceAccounts,
    carryInByAccount: carryIn.byAccount,
  });
  // The join is BIDIRECTIONAL and reconciliation-checked — see
  // joinDerivedStrategies.js for the two failures the old one-directional
  // `find(...)?.realized ?? 0` produced end-to-end: a fabricated zero that
  // deleted an account's whole day, and one derived row copied onto two
  // same-named grid rows for double the money. Every account that has either a
  // roster or a derivation is joined, so a derived strategy with no grid row is
  // reported rather than dropped.
  const rosterByAccount = new Map();
  reportedStrategies.forEach((strategy, index) => {
    const key = String(strategy.accountName || '').trim();
    if (!rosterByAccount.has(key)) rosterByAccount.set(key, []);
    rosterByAccount.get(key).push({ strategy, index });
  });
  // Positions preserved: the joined array is the reported array, row for row.
  const strategies = new Array(reportedStrategies.length);
  const joinedDerivationByAccount = new Map();
  for (const key of new Set([...rosterByAccount.keys(), ...derivationByAccount.keys()])) {
    const derivation = derivationByAccount.get(key) || null;
    const roster = rosterByAccount.get(key) || [];
    const joined = joinDerivedStrategies({
      strategies: roster.map((entry) => entry.strategy),
      derivation,
    });
    joined.strategies.forEach((strategy, position) => {
      strategies[roster[position].index] = strategy;
    });
    // The join report travels on the snapshot beside the derivation that
    // produced it: `join.offRosterRealized` is money the fills attributed to a
    // strategy this account's grid never listed, and it must stay visible.
    if (derivation) joinedDerivationByAccount.set(key, { ...derivation, join: joined.join });
  }
  const strategiesByAccount = groupStrategiesByAccount(strategies);
  const seen = new Set();

  for (const account of sourceAccounts) {
    const existing = registry[account.accountName] || registryByLower[account.accountName.toLowerCase()];
    const meta = createDefaultAccount(account, existing);
    const strategies = strategiesByAccount[account.accountName] || [];
    // Classified from the STORED record, not from `meta`. createDefaultAccount
    // seeds a brand-new Sim101 with accountType 'Simulation', and classifying
    // that would report source 'accountType' — i.e. the code would cite its own
    // guess back as if a human had made it, and the `New simulation account`
    // flag below would never fire. `existing` is what the CAM actually recorded.
    const nature = classifyAccountNature(
      { ...(existing || {}), accountName: account.accountName },
      { accountName: account.accountName, isSimulated: account.isSimulated },
    );
    // Everything below that measures a prop-firm rule, a payout or a target is
    // about real money under contract. Simulated money is under no contract, and
    // an account whose nature is undetermined must not be told it breached a
    // limit we are not sure applies to it.
    const isRealMoney = nature.nature === ACCOUNT_NATURES.LIVE;

    accountsByName[account.accountName] = meta;

    // Only computed when the grid did not report the value, and only from closes
    // we already hold. `todayClose` appends the day being reconciled, which is
    // not in `history` yet.
    const todayClose = { date, snapshots: [{ accountName: account.accountName, accountBalance: account.accountBalance, grossRealizedPnl: account.grossRealizedPnl }] };
    const closes = [...history, todayClose];
    const derived = {
      // Trailing drawdown is a prop-firm constraint. A cash account has no
      // trailing rule to measure against, so deriving a distance-from-peak for
      // one would invent a number that means nothing. Neither does a simulator:
      // every real Sim101 on the book reports trailingMaxDrawdown = 0 on a
      // six-figure balance because there is no rule behind it.
      trailing: !isRealMoney
        || isCashType(meta.accountType)
        || account.trailingMaxDrawdown !== undefined && account.trailingMaxDrawdown !== null
        ? null
        : deriveTrailingDrawdown(closes, account.accountName, date, { startBalance: meta.startBalance }),
      weekly: account.weeklyPnl === undefined || account.weeklyPnl === null
        ? deriveWeeklyPnl(closes, account.accountName, date)
        : null,
    };
    snapshots.push(createSnapshot(
      account,
      strategies,
      derived,
      joinedDerivationByAccount.get(String(account.accountName || '').trim()),
    ));
    seen.add(account.accountName.toLowerCase());

    if (nature.nature === ACCOUNT_NATURES.UNDETERMINED) {
      // Reported, never bucketed. This account's balance is in neither the desk
      // total nor the simulated total until someone says which it is.
      flags.push(makeFlag({
        type: 'Account nature undetermined',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} is counted as neither real nor simulated because ${nature.reason}`,
      }));
    } else if (nature.nature === ACCOUNT_NATURES.SIMULATION && nature.heuristic) {
      // The heuristic announces itself. A reclassification a CAM cannot see is
      // exactly what the old silent name filter was, and it cost a client his
      // whole trading day on the report.
      flags.push(makeFlag({
        type: 'New simulation account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} is being reported as simulated because ${nature.reason}. Its balance and P&L are kept out of every real total. Confirm it on the account record, or mark it as live money if that is wrong.`,
      }));
    } else if (!existing) {
      flags.push(makeFlag({
        type: 'New account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} is new and needs manual classification.`,
      }));
    }

    if (
      isRealMoney &&
      meta.accountType === ACCOUNT_TYPES.UNASSIGNED &&
      meta.status !== ACCOUNT_STATUSES.RESERVE
    ) {
      flags.push(makeFlag({
        type: 'Unassigned account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} needs an account type before close.`,
      }));
    }

    if (isRealMoney && shouldExpectStrategy(meta) && !hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Expected strategy missing',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is active but has no enabled strategy in this close.`,
      }));
    }

    // Same reason: a cash account cannot breach a trailing limit it does not
    // have. Without this, a stale maxDrawdownLimit left on an account that was
    // later reclassified as cash keeps raising drawdown flags forever. A
    // simulation account is in the same position and one step worse — nobody
    // terminates a simulator, so "Account may be terminated" on one is a false
    // alarm that trains the desk to ignore the real ones.
    const ddLimit = !isRealMoney || isCashType(meta.accountType)
      ? Number.NaN
      : Number(meta.maxDrawdownLimit);
    // Use the snapshot's value, which may have been reconstructed above.
    const snapshot = snapshots[snapshots.length - 1];
    const rawDD = Number(snapshot.trailingMaxDrawdown || 0);
    // A reconstructed drawdown is a lower bound, so warn sooner on it: the real
    // figure can be worse than this and never better.
    const limits = drawdownThresholds(snapshot.trailingSource);
    const derivedNote = snapshot.trailingSource === 'derived'
      ? ' (estimated from stored closes - confirm with the prop firm)'
      : '';

    if (Number.isFinite(ddLimit) && ddLimit > 0) {
      // Model 1: configured limit - trailingMaxDrawdown is cumulative loss (negative number)
      const currentDD = Math.abs(rawDD);
      if (currentDD > 0) {
        const remaining = ddLimit - currentDD;
        if (remaining <= 0) {
          flags.push(makeFlag({
            type: 'Drawdown breached',
            severity: 'Critical',
            accountName: account.accountName,
            message: `${meta.alias} has exceeded its $${ddLimit.toLocaleString()} max drawdown limit. Account may be terminated.${derivedNote}`,
          }));
        } else if (remaining <= limits.critical) {
          flags.push(makeFlag({
            type: 'Drawdown near limit',
            severity: 'Critical',
            accountName: account.accountName,
            message: `${meta.alias} is $${Math.round(remaining)} from its $${ddLimit.toLocaleString()} max drawdown limit. Immediate action required.${derivedNote}`,
          }));
        } else if (remaining <= limits.warning) {
          flags.push(makeFlag({
            type: 'Drawdown approaching limit',
            severity: 'Warning',
            accountName: account.accountName,
            message: `${meta.alias} has $${Math.round(remaining)} remaining before its $${ddLimit.toLocaleString()} max drawdown limit.${derivedNote}`,
          }));
        }
      }
    } else if (isRealMoney && rawDD !== 0 && !isCashType(meta.accountType)) {
      // Model 2: no configured limit - trailingMaxDrawdown IS the remaining buffer (sign-based)
      // NT exports this as positive (buffer remaining); account dies when it hits 0 or goes negative
      if (rawDD <= 0) {
        flags.push(makeFlag({
          type: 'Drawdown breached',
          severity: 'Critical',
          accountName: account.accountName,
          message: `${meta.alias} trailing drawdown buffer is $${rawDD.toLocaleString()} - account limit reached or exceeded. Verify with prop firm immediately.`,
        }));
      } else if (rawDD <= limits.critical) {
        flags.push(makeFlag({
          type: 'Drawdown near limit',
          severity: 'Critical',
          accountName: account.accountName,
          message: `${meta.alias} has only $${Math.round(rawDD)} of trailing drawdown buffer remaining. Immediate action required.`,
        }));
      } else if (rawDD <= limits.warning) {
        flags.push(makeFlag({
          type: 'Drawdown approaching limit',
          severity: 'Warning',
          accountName: account.accountName,
          message: `${meta.alias} has $${Math.round(rawDD)} of trailing drawdown buffer remaining.`,
        }));
      }
    }

    // A simulator cannot pay out and cannot pass an evaluation, so a target
    // reached in one is not an event. Guarded by nature rather than by type
    // because a stale 'Funded' type left on an account the platform now reports
    // as simulated would otherwise queue a payout request against play money.
    const targetProfit = isRealMoney ? Number(meta.targetProfit) : Number.NaN;
    if (
      meta.accountType === ACCOUNT_TYPES.FUNDED &&
      Number.isFinite(targetProfit) && targetProfit > 0 &&
      Number(account.accountBalance) >= targetProfit &&
      meta.payoutState === PAYOUT_STATES.NOT_REQUESTED
    ) {
      flags.push(makeFlag({
        type: 'Payout eligible',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} reached its target profit. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Request payout.`,
      }));
    }

    if (
      [ACCOUNT_TYPES.EVALUATION_BULLET, ACCOUNT_TYPES.EVALUATION_STANDARD].includes(meta.accountType) &&
      meta.status === ACCOUNT_STATUSES.ACTIVE &&
      Number.isFinite(targetProfit) && targetProfit > 0 &&
      Number(account.accountBalance) >= targetProfit
    ) {
      flags.push(makeFlag({
        type: 'Evaluation target reached',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} reached its evaluation target. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Deactivate and confirm consistency with the prop firm to activate.`,
      }));
    }

    if (meta.status === ACCOUNT_STATUSES.PAYOUT_HOLD && hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Payout hold violation',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is in payout hold but has an enabled strategy.`,
      }));
    }

    if ([ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE, ACCOUNT_STATUSES.FAILED].includes(meta.status) && hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Unexpected strategy active',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is ${meta.status} but has an enabled strategy.`,
      }));
    }

    for (const strategy of strategies) {
      if (!strategy.enabled) {
        flags.push(makeFlag({
          type: 'Strategy disabled',
          severity: 'Warning',
          accountName: account.accountName,
          message: `${meta.alias} has ${strategy.strategyName || 'a strategy'} disabled.`,
        }));
      }
    }
  }

  for (const [accountName, meta] of Object.entries(registry || {})) {
    if (seen.has(accountName.toLowerCase())) continue;
    accountsByName[accountName] = meta;
    // A registered simulation account that did not report is not an operational
    // problem: a sim only appears in the grid while someone has it loaded. Before
    // this exemption a registered Sim101 could never stop flagging — the old name
    // filter dropped it before `seen.add()`, so this sweep fired on it every
    // single close and dragged the whole import to Needs review, forever. There
    // was no way to register a sim without permanently poisoning the flag queue.
    const isSimulated = classifyAccountNature(meta, { accountName }).nature === ACCOUNT_NATURES.SIMULATION;
    if (!isSimulated && meta.accountType !== ACCOUNT_TYPES.IGNORE && meta.status !== ACCOUNT_STATUSES.INACTIVE) {
      flags.push(makeFlag({
        type: 'Missing account',
        severity: 'Warning',
        accountName,
        message: `${meta.alias || accountName} existed before but did not appear in this close.`,
      }));
    }
  }

  // The separation, done once, at the boundary. `snapshots` / `strategies` /
  // `orders` / `executions` on the returned object hold LIVE-MONEY ROWS ONLY —
  // exactly what every existing consumer already assumed it was getting — and
  // everything else travels in `simulation`, which no money total reads.
  const split = splitSimulationRows({
    accounts: accountsByName,
    snapshots,
    strategies,
    orders,
    executions,
    platformFlags,
  });

  return {
    id: `${clientId}-${date}-${Date.now()}`,
    clientId,
    date,
    importedAt: nowIso(),
    status: flags.some((flag) => flag.severity === 'Critical' || flag.severity === 'Warning') ? 'Needs review' : 'Ready to close',
    accounts: accountsByName,
    snapshots: split.live.snapshots,
    strategies: split.live.strategies,
    orders: split.live.orders,
    executions: split.live.executions,
    simulation: split.simulation,
    flags,
    pnlSourceSummary: summarizePnlSources(split.live.snapshots),
  };
}

export function recalculateDailyImport({ dailyImport, registry = {} }) {
  // Feed the WHOLE close back in, simulated rows included. Passing only
  // `dailyImport.snapshots` would hand reconcile a close its simulation accounts
  // had vanished from, and the registry sweep would then report each of them as
  // a Missing account — the recalculation would invent flags out of the split it
  // is supposed to reproduce.
  const whole = mergeSimulationRows(dailyImport);
  const recalculated = reconcileDailyImport({
    clientId: dailyImport.clientId,
    date: dailyImport.date,
    registry,
    parsed: {
      accounts: whole.snapshots.map(snapshotToAccount),
      strategies: whole.strategies,
      orders: whole.orders,
      executions: whole.executions,
    },
  });

  // Recalculate only re-derives flags + status from the data already uploaded.
  // It must NOT replace the snapshots/accounts/strategies/orders/executions: the
  // rebuilt snapshots would drop their nested strategy detail whenever the
  // top-level detail arrays are empty (e.g. right after an upload, before a
  // reload), which is what made Recalculate look like it erased the import.
  // Carry each prior flag's triage (Acknowledged/Resolved + resolvedAt) onto the
  // regenerated flag so Recalculate keeps the operator's work instead of resetting
  // every flag to Open. Match on a reconstructed type|account|message key (not the
  // id) so it also matches flags reloaded from the DB, which carry a uuid id.
  const flagKey = (f) => `${f.type}|${f.accountName || 'client'}|${f.message || ''}`;
  const priorByKey = Object.fromEntries((dailyImport.flags || []).map((f) => [flagKey(f), f]));
  const flags = (recalculated.flags || []).map((flag) => {
    const prior = priorByKey[flagKey(flag)];
    return prior && prior.status && prior.status !== 'Open'
      ? { ...flag, status: prior.status, resolvedAt: prior.resolvedAt }
      : flag;
  });

  return {
    ...dailyImport,
    status: recalculated.status,
    flags,
  };
}
