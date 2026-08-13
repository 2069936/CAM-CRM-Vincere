// Tells a simulation account apart from an account holding real money, and
// keeps the two apart everywhere downstream.
//
// WHY THIS EXISTS, with the figures that forced it.
//
// Until now `reconcile.js` dropped any account whose name started with "sim"
// before anything was built. That kept simulated money out of desk capital —
// verified: 11 real client folders carry a Sim101 holding $1,099,590 between
// them and NOT ONE of those dollars reached a snapshot — but it also deleted the
// work. On 2026-08-06 Craig Weschke's Sim101 was the only account in his book
// that traded: 40 orders, 15 executions, 5 strategies (2 enabled), realized
// -$1,297.9999999. All of it was discarded, so the report the desk sent him read
// `DAILY REALIZED PNL $0` and `ACCOUNTS 2` on a day his CAM had hand-written a
// note about how the SIM session went. 100% of that client's trading day was
// thrown away by a filter with no UI trace.
//
// So the rule is separation, not deletion: simulated rows survive, they travel
// in their own container, and no total that means money is allowed to touch
// them.
//
// WHAT CAN ACTUALLY BE RECOGNISED, measured against the 11 unredacted exports:
//   - name prefix "sim"       11/11. The only signal that works today.
//   - connection name          useless. Sim101's connection reads BlueSky,
//                              BluSky, Blusky, Legends, Legends Trading, Live —
//                              real prop-firm names, 9 of 11 resolve to a real
//                              firm through normalizePropFirm.
//   - account_type             did not exist for simulation until this commit.
//   - a platform flag          the best signal and not captured yet: NinjaTrader
//                              exposes Options.Provider == Provider.Simulator
//                              and the collector never reads it. Supported here
//                              as `isSimulated` for when it ships.
//
// INTENT IS NOT IN THE DATA AND CANNOT BE DERIVED. All 11 are named Sim101 and
// 10 of them sit at NinjaTrader's stock $100,000 with no strategies, no orders
// and no executions. A deliberate multi-session SIM engagement that has not
// traded yet is indistinguishable from an untouched default install. That is why
// the name test is a HEURISTIC that announces itself (`reason` below, rendered
// to the CAM) and why an explicit registry setting always wins over it.

/** The nature of the money in an account. Never inferred as a silent default. */
export const ACCOUNT_NATURES = {
  LIVE: 'live',
  SIMULATION: 'simulation',
  // Signals disagree, or the name looks like a simulator but does not match the
  // platform's own naming. Counted as neither real nor simulated, and said so.
  UNDETERMINED: 'undetermined',
};

/**
 * The explicit, CAM-set override. Stored on trading_accounts.simulation_mode.
 *
 * AUTO ('' / null) is not a third opinion, it is the absence of one: the ladder
 * below runs. The two named values end the ladder immediately, which is what
 * makes every heuristic here correctable.
 */
export const SIMULATION_MODES = {
  AUTO: '',
  SIMULATION: 'simulation',
  LIVE: 'live',
};

/**
 * account_type value for a simulation account.
 *
 * Declared HERE rather than imported from reconcile.js so this module stays a
 * leaf: reconcile.js imports the classifier, and a cycle between the two would
 * put ACCOUNT_TYPES in its temporal dead zone on whichever module happened to
 * load first.
 */
export const SIMULATION_ACCOUNT_TYPE = 'Simulation';

/**
 * account_type values that assert the account holds real money.
 *
 * Mirrors reconcile.js ACCOUNT_TYPES minus Simulation, Unassigned and
 * Inactive / Ignore — the three that assert nothing about the money. The
 * duplication is deliberate (see above) and guarded: simulationAccounts.test.js
 * asserts this list equals reconcile's ACCOUNT_TYPES exactly, so adding a type
 * there without deciding about it here fails the suite.
 *
 * 'Cash' is the legacy pre-split value and must stay for the same reason it
 * stays in reconcile.js:16 — account_type is free text with no CHECK constraint
 * and rows written before the IRA/Straight split still store it.
 */
export const MONEY_ACCOUNT_TYPES = [
  'Evaluation - Bullet Bot',
  'Evaluation - Standard',
  'Funded',
  'Cash - IRA',
  'Cash - Straight',
  'Cash',
];

/**
 * NinjaTrader's own simulation account naming: Sim101, Sim102, ...
 *
 * Anchored and digits-only on purpose. All 11 simulation accounts on the real
 * book are exactly `Sim101`. The loose `startsWith('sim')` test this replaces
 * also matched `Simmons - Main` and `Simon 01`, and because the old code deleted
 * what it matched, a real account named that way lost every close it ever had
 * with no flag, no warning and no count.
 */
const PLATFORM_SIM_NAME = /^sim[\s_-]*\d+$/i;

/**
 * Names that look like a simulator but are not the platform's naming.
 *
 * These resolve to UNDETERMINED, never to SIMULATION. A simulation a client
 * renamed `Practice` and a live account somebody labelled `Practice` produce the
 * same string, and guessing either way is how money gets misreported.
 *
 * Note what is NOT here: `Simmons - Main` and `Simon 01`. The old
 * `startsWith('sim')` filter matched and silently deleted both; they now fall
 * through to LIVE, which is what they are. Making them undetermined would trade
 * one wrong answer for another.
 *
 * 0 of the 62 distinct account names in the 11 real exports and 0 of the 764
 * rows in the redacted book match this, so nothing on today's data moves because
 * of it.
 */
const AMBIGUOUS_NAME = /^sim$|^sim[^a-z0-9]|\b(?:demo|practice|simulator|simulated|simulation)\b/i;

/**
 * The platform's naming with something ELSE attached: `Sim101 - backup`,
 * `Sim101a`, `Sim 1 copy`.
 *
 * These used to fall all the way through to LIVE, because PLATFORM_SIM_NAME is
 * anchored at both ends and AMBIGUOUS_NAME's `^sim[^a-z0-9]` cannot fire on a
 * name whose fourth character is a digit. So a duplicated or annotated Sim101 —
 * the shape a desk produces the moment it runs two SIM sessions, or copies one
 * to keep a record — was counted as real desk capital at NinjaTrader's stock
 * $100,000, with no flag and nothing on any surface to say so.
 *
 * UNDETERMINED rather than SIMULATION: `Sim101 - backup` is almost certainly a
 * simulator, but `Sim500 Funded` could genuinely be a live account somebody
 * numbered that way, and the whole point of this module is that a guess about
 * which bucket money belongs in gets reported instead of made.
 */
const PLATFORM_SIM_NAME_WITH_SUFFIX = /^sim[\s_-]*\d/i;

/**
 * Characters that are invisible on every surface a human reads.
 *
 * `Sim101` and `Sim101` with a zero-width space glued to the end are the same
 * account to anyone looking at the NinjaTrader grid or at this CRM, and the
 * second one was being classified as real desk capital. Zero-width space,
 * zero-width non-joiner and joiner, the
 * word joiner and the BOM all survive String.trim(), which strips only
 * whitespace, so they have to be removed explicitly before any name is matched.
 * They are stripped for MATCHING only — every message still quotes the name as
 * it was stored, so a CAM searching for it can still find it.
 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function matchable(value) {
  return text(value).replace(INVISIBLE, '').trim();
}

function nameSignal(accountName) {
  const name = text(accountName);
  const match = matchable(accountName);
  if (!match) return null;
  if (PLATFORM_SIM_NAME.test(match)) {
    return {
      nature: ACCOUNT_NATURES.SIMULATION,
      reason: `the account is named ${name}, which is NinjaTrader's Sim<number> simulation naming`,
    };
  }
  if (AMBIGUOUS_NAME.test(match)) {
    return {
      nature: ACCOUNT_NATURES.UNDETERMINED,
      reason: `the name ${name} reads like a simulator but is not NinjaTrader's Sim<number> naming, so it could equally be a real account`,
    };
  }
  if (PLATFORM_SIM_NAME_WITH_SUFFIX.test(match)) {
    return {
      nature: ACCOUNT_NATURES.UNDETERMINED,
      reason: `the name ${name} starts with NinjaTrader's Sim<number> simulation naming but does not end there, so it could be a copy of a simulator or a real account numbered that way`,
    };
  }
  return null;
}

/**
 * Resolve what kind of money an account holds.
 *
 * Ladder, strongest first. Every rung records WHY, because a reclassification
 * nobody can check is worse than no reclassification: "treated as simulation
 * because the account is named Sim101" is auditable, a silent bucket change is
 * not.
 *
 * @param {object} meta      registry metadata (accountType, simulationMode, alias)
 * @param {object} context   { accountName, isSimulated } — isSimulated is the
 *                           platform's own flag, null/undefined when the
 *                           collector did not report one (it does not yet).
 * @returns {{nature: string, source: string, heuristic: boolean, reason: string,
 *            conflict: null|{declared: string, observed: string}}}
 */
export function classifyAccountNature(meta = {}, context = {}) {
  const accountName = context.accountName || meta?.accountName || '';
  const isSimulated = context.isSimulated;

  const mode = lower(meta?.simulationMode);
  if (mode === SIMULATION_MODES.LIVE) {
    return decided(ACCOUNT_NATURES.LIVE, 'registry', false,
      'the account record is set to live money, which overrides every automatic signal');
  }
  if (mode === SIMULATION_MODES.SIMULATION) {
    return decided(ACCOUNT_NATURES.SIMULATION, 'registry', false,
      'the account record is set to simulation');
  }

  const accountType = text(meta?.accountType);
  const declared = accountType === SIMULATION_ACCOUNT_TYPE
    ? ACCOUNT_NATURES.SIMULATION
    : MONEY_ACCOUNT_TYPES.includes(accountType)
      ? ACCOUNT_NATURES.LIVE
      : null;

  const observed = isSimulated === true
    ? ACCOUNT_NATURES.SIMULATION
    : isSimulated === false
      ? ACCOUNT_NATURES.LIVE
      : null;

  const named = nameSignal(accountName);
  const namedDecisive = named && named.nature !== ACCOUNT_NATURES.UNDETERMINED ? named.nature : null;

  // The name is only consulted when the platform has said nothing. Provider ==
  // Simulator is the platform's statement about its own account, so a name that
  // disagrees with it is a naming choice, not a contradiction worth reporting.
  // The account RECORD is a different matter: that is a human determination, and
  // a human record disagreeing with the machine is exactly the kind of
  // contradiction that must not be resolved by whichever branch runs first.
  const votes = [
    declared ? { nature: declared, source: 'accountType', heuristic: false, reason: `the account record says its type is ${accountType}` } : null,
    observed ? { nature: observed, source: 'platform', heuristic: false, reason: isSimulated ? 'the trading platform reported this account as a simulator account' : 'the trading platform reported this account as a live account' } : null,
    !observed && namedDecisive ? { nature: namedDecisive, source: 'name', heuristic: true, reason: named.reason } : null,
  ].filter(Boolean);

  if (!votes.length) {
    // Nothing decided. An ambiguous name is the one case where "no signal" is
    // not the same as "real money", so it is reported as undetermined instead of
    // falling into the live bucket by default.
    if (named) {
      return decided(ACCOUNT_NATURES.UNDETERMINED, 'name', true, named.reason);
    }
    return decided(ACCOUNT_NATURES.LIVE, 'default', false,
      'no simulation signal on the name, the account record or the platform');
  }

  const natures = new Set(votes.map((vote) => vote.nature));
  if (natures.size > 1) {
    // Two sources that both claim to know, disagreeing. Picking a winner here
    // would hide the contradiction inside a total; the CAM resolves it with the
    // explicit setting, which is the only thing that ends this branch.
    const parts = votes.map((vote) => vote.reason);
    return {
      nature: ACCOUNT_NATURES.UNDETERMINED,
      source: 'conflict',
      heuristic: false,
      reason: `signals disagree — ${parts.join('; ')}. Set the account's simulation setting to resolve it.`,
      conflict: {
        declared: declared || null,
        observed: observed || null,
        named: namedDecisive || null,
      },
    };
  }

  const winner = votes[0];
  return {
    nature: winner.nature,
    source: winner.source,
    // Heuristic only when the NAME is the sole thing that decided it.
    heuristic: votes.every((vote) => vote.heuristic),
    reason: winner.reason,
    conflict: null,
  };
}

function decided(nature, source, heuristic, reason) {
  return { nature, source, heuristic, reason, conflict: null };
}

/** Convenience: is this account simulated? Undetermined is NOT simulated. */
export function isSimulationAccount(meta, context) {
  return classifyAccountNature(meta, context).nature === ACCOUNT_NATURES.SIMULATION;
}

/** Convenience: does this account hold real money? Undetermined is NOT live. */
export function isLiveMoneyAccount(meta, context) {
  return classifyAccountNature(meta, context).nature === ACCOUNT_NATURES.LIVE;
}

/**
 * A short, honest label for a nature. Currency formatting alone never carries
 * the fact that a figure is not money, so every surface pairs the number with
 * one of these.
 */
export const NATURE_LABELS = {
  [ACCOUNT_NATURES.SIMULATION]: 'Simulated',
  [ACCOUNT_NATURES.UNDETERMINED]: 'Nature undetermined',
  [ACCOUNT_NATURES.LIVE]: 'Live money',
};

function emptyTotals() {
  return { accounts: 0, balance: 0, dailyPnl: 0, weeklyPnl: 0 };
}

function addSnapshot(totals, snapshot) {
  totals.accounts += 1;
  totals.balance += Number(snapshot?.accountBalance || 0);
  totals.dailyPnl += Number(snapshot?.grossRealizedPnl || 0);
  totals.weeklyPnl += Number(snapshot?.weeklyPnl || 0);
}

function emptySide() {
  return {
    accounts: {},
    snapshots: [],
    strategies: [],
    orders: [],
    executions: [],
    totals: emptyTotals(),
  };
}

/**
 * Split one close into live rows, simulated rows and undetermined rows.
 *
 * Separation by CONSTRUCTION, not by filtering at each consumer. Every existing
 * surface reads `dailyImport.snapshots`; leaving simulated rows in there and
 * asking twenty aggregators to remember to exclude them is the failure mode this
 * whole feature exists to end — one forgotten reducer and $1,099,590 of play
 * money lands in desk capital. So the live arrays keep exactly the rows they
 * hold today, and everything else moves into its own container.
 *
 * @param {{accounts?: object, snapshots?: Array, strategies?: Array,
 *          orders?: Array, executions?: Array,
 *          platformFlags?: object}} close
 * @returns {{live: object, simulation: object, natureByAccount: object}}
 */
export function splitSimulationRows(close = {}) {
  const registry = close.accounts || {};
  const platformFlags = close.platformFlags || {};

  // Registry keys and CSV account names disagree on case throughout this
  // codebase (reconcile.js builds its own lower-cased lookup for the same
  // reason), so every lookup here goes through the lower-cased name.
  const metaByLower = {};
  for (const [name, meta] of Object.entries(registry)) {
    metaByLower[lower(name)] = { name, meta };
  }

  const natureByAccount = {};
  const classify = (accountName) => {
    const key = lower(accountName);
    if (natureByAccount[key]) return natureByAccount[key];
    const entry = metaByLower[key];
    const meta = entry?.meta || {};
    const flag = Object.prototype.hasOwnProperty.call(platformFlags, key)
      ? platformFlags[key]
      : undefined;
    const result = {
      accountName: entry?.name || accountName,
      alias: meta.alias || entry?.name || accountName,
      accountType: meta.accountType || '',
      ...classifyAccountNature(meta, { accountName: entry?.name || accountName, isSimulated: flag }),
    };
    natureByAccount[key] = result;
    return result;
  };

  // Classify every account the registry knows about, even one with no rows in
  // this close, so the caller can flag a heuristic match on an idle account.
  for (const name of Object.keys(registry)) classify(name);

  const live = { snapshots: [], strategies: [], orders: [], executions: [] };
  const simulation = emptySide();
  const undetermined = emptySide();

  const sideFor = (accountName) => {
    const nature = classify(accountName).nature;
    if (nature === ACCOUNT_NATURES.SIMULATION) return simulation;
    if (nature === ACCOUNT_NATURES.UNDETERMINED) return undetermined;
    return null;
  };

  for (const snapshot of close.snapshots || []) {
    const side = sideFor(snapshot?.accountName);
    if (!side) { live.snapshots.push(snapshot); continue; }
    side.snapshots.push(snapshot);
    addSnapshot(side.totals, snapshot);
  }

  for (const key of ['strategies', 'orders', 'executions']) {
    for (const row of close[key] || []) {
      const side = sideFor(row?.accountName);
      (side ? side[key] : live[key]).push(row);
    }
  }

  for (const [key, entry] of Object.entries(natureByAccount)) {
    const meta = metaByLower[key]?.meta;
    if (!meta) continue;
    if (entry.nature === ACCOUNT_NATURES.SIMULATION) simulation.accounts[entry.accountName] = meta;
    else if (entry.nature === ACCOUNT_NATURES.UNDETERMINED) undetermined.accounts[entry.accountName] = meta;
  }

  const classifications = Object.values(natureByAccount)
    .filter((entry) => entry.nature !== ACCOUNT_NATURES.LIVE)
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  const accountsInClose = (close.snapshots || []).length;

  return {
    natureByAccount,
    live,
    simulation: {
      ...simulation,
      undetermined,
      classifications,
      // Every count carries its denominator: "1 of 3 accounts in this close",
      // never a bare "1".
      denominator: {
        // Accounts that reported a close, whatever their nature.
        accountsInClose,
        // Accounts on the client's record, including ones that did not report.
        accountsOnRecord: Object.keys(registry).length,
      },
      // A close is only "simulation-free" when we could determine that for every
      // account in it. Undetermined rows make that unanswerable, so it is null.
      hasSimulation: undetermined.snapshots.length
        ? null
        : simulation.snapshots.length > 0,
    },
  };
}

/**
 * Everything that must be written to the database for one close: live rows plus
 * simulated rows plus undetermined rows.
 *
 * The split is an APPLICATION-LAYER concern. account_snapshots stores one row
 * per account per close regardless of nature, and the split is recomputed on
 * load from the account's own record — so a CAM correcting a misclassification
 * fixes every close at once instead of only the ones imported after the fix.
 */
export function mergeSimulationRows(importResult = {}) {
  const sim = importResult.simulation || {};
  const und = sim.undetermined || {};
  const join = (key) => [
    ...(importResult[key] || []),
    ...(sim[key] || []),
    ...(und[key] || []),
  ];
  return {
    snapshots: join('snapshots'),
    strategies: join('strategies'),
    orders: join('orders'),
    executions: join('executions'),
  };
}

/** Counts for a source_summary / UI line, each with its denominator. */
export function summarizeSimulationSplit(simulation) {
  if (!simulation) return null;
  const und = simulation.undetermined || emptySide();
  return {
    simulatedAccounts: simulation.totals.accounts,
    simulatedBalance: round2(simulation.totals.balance),
    simulatedDailyPnl: round2(simulation.totals.dailyPnl),
    simulatedWeeklyPnl: round2(simulation.totals.weeklyPnl),
    undeterminedAccounts: und.totals.accounts,
    undeterminedBalance: round2(und.totals.balance),
    ofAccountsInClose: simulation.denominator?.accountsInClose ?? 0,
    simulatedOrders: (simulation.orders || []).length,
    simulatedExecutions: (simulation.executions || []).length,
    simulatedStrategies: (simulation.strategies || []).length,
  };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
