import { summarizePnlSources } from './pnlSourceSummary.js';
// Extension explicit: this module is now on the import chain of a Vercel
// serverless function (server/export/absentAccounts.js -> accountLifecycle ->
// here), and plain Node ESM does not resolve './tradingDayScope'. The other two
// specifiers on this line's neighbours already carried it.
import { scopeExecutionsToDay, scopeOrdersToDay } from './tradingDayScope.js';
import { deriveTrailingDrawdown, deriveWeeklyPnl, drawdownThresholds } from './derivedAccountMetrics.js';
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

function createSnapshot(account, strategies, derived = {}) {
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
    strategies,
  };
}

function snapshotToAccount(snapshot) {
  return {
    accountName: snapshot.accountName,
    connection: snapshot.connection,
    grossRealizedPnl: snapshot.grossRealizedPnl,
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
export function reconcileDailyImport({ clientId, date, registry = {}, parsed, history = [] }) {
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
  const strategies = parsed.strategies || [];
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
    snapshots.push(createSnapshot(account, strategies, derived));
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
