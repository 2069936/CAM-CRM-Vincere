// One rank per algorithm, and one algorithm's record split by the thing that
// actually differs inside it: its CONFIGURATION.
//
// WHY THIS FILE EXISTS, PASS ONE. The Strategy Effectiveness Leaderboard sorted
// by total P&L. Every algorithm on this book loses, so total P&L ranked
// deployment size upside down: Spearman(total, account-days) = -0.807. The
// biggest deployment sorted LAST (Bullet Bot, 340 account-days over 117
// accounts, -$32,220) and a two-observation algorithm sorted FIRST (ARPD_PF, 2
// account-days, +$864). A desk manager reading that board top-down was reading a
// list of what the desk runs least, labelled "most effective".
//
// WHY IT WAS REWRITTEN, PASS TWO. The fix for that split the leaderboard into
// four boards, one per BUSINESS — Bullet Bot, other prop, cash, unclassified —
// and the algorithm detail view under it printed one performance block per
// board, telling the reader to "read the segment you are about to deploy into".
// On this book that reported OGX as #1 on cash at +$23.52 per account-day and as
// an unranked -$54.12 on ordinary prop, over the same closes, as if those were
// two behaviours of the algorithm. The desk manager rejected it and the book
// proves him right:
//
//   * OGX is strategy_version 2.4 on every account type, and PosSize is 1/1/0 on
//     70 of the 77 account-days it was measured on, in every one of them.
//   * OGX trades MNQ and only MNQ, wherever it runs.
//   * The closes overlap almost completely — 24 of them shared between cash and
//     prop, 3 cash-only, none prop-only. Not different market days either.
//
// So the account type explained nothing about how the algorithm behaved, and
// printing two means as two behaviours invited a deployment decision on a
// difference that was sample and noise. Pooled, OGX's dominant configuration
// reads -$9.52 per account-day with a 95% interval of -$45.51 to +$26.47 — one
// answer, and one that says plainly that it has not been shown to make money.
//
// WHY IT WAS CHANGED AGAIN, PASS THREE: ONE THING ON THIS LIST WAS NEVER A PEER
// OF THE OTHERS. The CAM settled it. "They are different categories. Bullet Bot
// usually runs on a single account and should not be running in combination. The
// other algorithms can run however they like: combined, alone, on prop-firm
// accounts, on evaluation accounts, on cash accounts, on all of them. The only
// accounts that run Bullet Bot are evaluation accounts... But Bullet Bot is a
// strategy for PASSING EVALUATIONS, and it has different results from using a
// stack of ordinary algorithms."
//
// So the two answer different questions. Of a stack you ask what it MAKES; of
// Bullet Bot you ask whether it PASSED. This ranking is ordered by a dollar per
// account-day, which answers the first and is close to meaningless for the
// second: an evaluation that passes on day two by making a small amount has
// succeeded completely, and the same figure on a funded stack is a mediocre
// week. Worse, the two figures are not even the same measurement. Bullet Bot is
// alone on the account-day on 99% of its account-days, so its mean is close to
// the whole account's day; OGX is stacked on nine of every ten of its, so its
// mean is a share of a day split with others. Ranked together, -$93.68 against
// -$11.98 compared a whole with a part and read as Bullet Bot performing worse
// when it was carrying more.
//
// SO THE PROGRAMME IS OFF THIS LIST AND ONTO ITS OWN PANEL, and the boundary is
// the ALGORITHM ITSELF being that programme — a named family, listed in
// algorithmProgrammes.js — NOT a solo-versus-stacked threshold. The ratio is the
// SYMPTOM the desk noticed; the programme is the reason. A threshold cannot be
// stated as a number anyone could say out loud: URGO runs alone on a third of
// its account-days and would sit in limbo under any line. Anything else that
// runs solo stays here, because an ordinary algorithm running alone is an
// ordinary algorithm having an ordinary day.
//
// IT IS NOT HIDDEN. It keeps a row where it used to sit, carrying its counts,
// what it is, and the panel that measures it — `ranking.programmes`.
//
// WHAT SEGMENTS AN ALGORITHM, AND WHAT DOES NOT.
//
//   * CONFIGURATION does. Under version 2.4 the book holds three parameter sets
//     for OGX, and profit targets and stop are what this desk versions and
//     swaps — strategyConfigDrift.js has treated ProfitTargetTicks and
//     StopLossTicks as the configuration's identity and PosSize as its risk
//     level since it was written. A configuration is a property of the RUN.
//   * ACCOUNT TYPE does not. It is a property of the ACCOUNT. It is kept, on the
//     detail view, as deployment context — where the algorithm runs and how much
//     of it runs there — in COUNTS ONLY, with no mean and no money per type, so
//     that no reader can come away believing one account type is better than
//     another for the same configuration. "No money per type" is meant
//     literally, and it reaches further than the deployment table: see the money
//     rule below.
//
// WHAT THE POOLING DOES AND DOES NOT ADD. A per-account-day mean is a rate that
// describes the algorithm: a tick of MNQ pays a cash account and a prop
// evaluation exactly the same, because what a prop firm simulates is the
// CAPITAL, not the tick value. That rate is pooled, and it is the only thing
// here that is.
//
// A DOLLAR IS NOT POOLED — AND IT IS NOT PUBLISHED PER POPULATION EITHER. The
// first version of this rework honoured half of that: it refused a pooled total
// and split each algorithm's money by business instead, cash beside prop, never
// added. That is a worse answer than it looks. The account-days behind each part
// are printed on the same screen, in the deployment table, so a dollar per
// business divided by the account-days that business contributed IS a P&L per
// account type. On this book that division returns +$23.52 on cash and -$54.12
// on ordinary prop — the exact pair the desk manager rejected — for an algorithm
// that is one version at one sizing on one contract everywhere it runs. A figure
// nobody prints but everybody can do in their head is still published.
//
// So NO POPULATION HERE CARRIES A DOLLAR. Not an algorithm, not one of its
// configurations, not one close of either: `finishStats` publishes counts, rates
// and intervals, with `moneyRefusal` where the money used to be, and
// `closeSeries` publishes a mean and an account-day count and no total. Money
// per business survives where it is an accounting fact rather than a verdict —
// on the `businesses` block, whose denominator is the whole desk across every
// algorithm and every configuration, which is the same statement deskMoney.js
// makes about balances.
//
// The only dollars this module states about anything smaller are on the roster:
// what an algorithm made ONE CLIENT and what it made ONE ACCOUNT. Those name
// whose money it is. They are never grouped by account type — the account row
// keeps its `segment` because that is a fact about the account, and the screen
// deliberately does not print it in the same row as the money.
//
// WHAT IT STILL REFUSES TO PRODUCE:
//
//   * No composite score. There was a 0-10 one, min-max normalised against the
//     largest deployment, so the scale itself moved when the desk added accounts.
//   * No rank without evidence. Fewer than 30 reported account-days or fewer
//     than 10 accounts and the row is listed with its counts and no rank.
//   * No sort by total P&L, and no dollar on a row at all to sort by.
//   * No trend measured in dollars. Two seven-day windows of summed P&L move
//     with how many accounts were deployed in each; the trend is a difference of
//     MEANS per account-day, in the unit the ranking is in.
//
// THE STATISTICS. The mean is per REPORTED account-day and the interval around
// it is clustered on the account, because the same account contributes many days
// and those days are not independent draws.

import { businessForSegment, segmentForAccount, BUSINESS_KEYS } from './operationsSegments';
import { PROGRAMME_BOUNDARY, isProgrammeFamily, programmeFor, thresholdRefusal } from './algorithmProgrammes';
import { DESK_BUSINESS_ORDER, bookCloses, deskBusinessColumns } from './deskMoney';
import { configKeyOf, shortConfigLabel } from './strategyConfigDrift';

/**
 * The evidence a row needs before it is given a rank.
 *
 * Both arms are needed and neither is enough. 30 account-days off one account is
 * one account's luck measured thirty times; 10 accounts seen twice each is not a
 * measurement of anything. The same gate decides whether a CONFIGURATION is
 * readable as a measurement — a configuration is not ranked against anything,
 * but a mean over four account-days is a number, not a result, whatever it is a
 * mean of.
 */
export const EVIDENCE_GATE = { minAccountDays: 30, minAccounts: 10 };

/** Two-sided 95%. Named rather than inlined so the interval's meaning is legible. */
const Z_95 = 1.959964;

/**
 * Field separator for composite keys.
 *
 * Not '/'. Parameter values contain slashes — a NinjaTrader time is written
 * `1/1/2020 4:45:00 PM` — and a '/' split has silently produced a wrong answer
 * three times in this codebase already. U+0001 cannot occur in the data.
 */
const FIELD = '\u0001';

const BUSINESS_NOTES = {
  [BUSINESS_KEYS.BULLET]: 'Accounts typed as bullet-bot evaluations — pass or fail inside days. '
    + 'An account type, not an algorithm: the ordinary algorithms running on these accounts hold '
    + 'their rows in the ranking above, and the Bullet Bot programme itself is measured on its '
    + 'own panel rather than ranked against them.',
  [BUSINESS_KEYS.PROP_OTHER]: 'Funded and standard-evaluation prop accounts, plus any account '
    + 'type this build has not been taught, so a new type is reported here rather than dropped.',
  [BUSINESS_KEYS.CASH]: 'Real client money. A dollar here is a dollar; a dollar on a prop '
    + 'account is movement against a plan size the firm simulates.',
  [BUSINESS_KEYS.UNCLASSIFIED]: 'Account-days on accounts nobody has classified yet. A '
    + 'classification backlog, not a business.',
};

const BUSINESS_KINDS = {
  [BUSINESS_KEYS.BULLET]: 'prop',
  [BUSINESS_KEYS.PROP_OTHER]: 'prop',
  [BUSINESS_KEYS.CASH]: 'cash',
  [BUSINESS_KEYS.UNCLASSIFIED]: 'backlog',
};

const CROSS_BUSINESS_REFUSAL = 'One coverage percentage across every business would add a cash '
  + 'desk’s real client money to a prop desk’s movement on a simulated plan size. Each business '
  + 'states its own instead, and no figure on this object spans two of them.';

const MONEY_PER_BUSINESS = 'Money is stated per business and never added — a cash dollar is real '
  + 'client money and a prop dollar is movement against a plan size the firm simulates — and it is '
  + 'stated for the DESK, below, over every algorithm and every configuration at once. It is not '
  + 'stated per algorithm and not per configuration. Beside the account-days on the same screen, an '
  + 'algorithm’s dollars per business are a P&L per account type holding its own denominator, which '
  + 'is the reading this desk rejected.';

/**
 * What sits where a population's money used to.
 *
 * Written as a refusal rather than as an omission because the omission is not
 * self-explanatory: "money per business, never added" looks like the careful
 * answer until you notice the deployment table under it supplies the
 * denominator, at which point the careful answer is the rejected one with an
 * extra division in it.
 */
// The two rejected per-account-type figures are named in the module header, in
// `rankingRefusals` and on the panel — but deliberately NOT in this string. It
// is carried on every row and on every configuration, and a book test asserts
// that neither figure appears anywhere in what the detail publishes. A refusal
// that quotes the number it refuses would be the one thing that made that guard
// unwritable.
const POPULATION_MONEY_REFUSAL = 'No dollar figure on this population — not one total, and not one '
  + 'per business either. The account-days it ran on are printed per account type just below, so a '
  + 'dollar per business stated here would divide straight into a P&L per account type, which is '
  + 'the reading this desk rejected: the account type is a property of the ACCOUNT, and the same '
  + 'version at the same sizing on the same contract does not become a different algorithm because '
  + 'of what the account is called. Money is per business on the desk’s own book below, where the '
  + 'denominator is the whole desk rather than this algorithm’s deployment.';

const RANK_UNIT_NOTE = 'Ranked by measured P&L per reported account-day, pooled over every '
  + 'account the algorithm ran on. The account type is not in this figure: it is a property of '
  + 'the account, and a tick pays a cash account and a prop evaluation the same.';

const INSTRUMENT_CAVEAT = 'Dollars per account-day are not normalised for contract size. An '
  + 'algorithm on NQ moves roughly ten times what one on MNQ does at the same position size, so '
  + 'the instrument and the sizing are printed beside every row and two rows on different '
  + 'contracts are not the same measurement.';

/**
 * What stands where a programme's row used to, on the ranking itself.
 *
 * Not a rank, not a mean, and not an omission either. The row is still printed —
 * with what the programme is, the account-days behind it and the panel that
 * measures it — because a reader who came to this table looking for Bullet Bot
 * and found nothing would conclude it had stopped running, or go looking for the
 * figure somewhere it could be compared with OGX's.
 */
const PROGRAMME_ROW_NOTE = 'Kept on this table, without a rank and without a mean, so that a '
  + 'reader looking for it finds where it is measured instead of finding nothing. Its counts are '
  + 'here; its results are on its own panel.';

function day(value) {
  return String(value || '').slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** `date` shifted by whole days, in the same YYYY-MM-DD form. UTC, so no DST edge. */
export function shiftDay(date, days) {
  const parsed = Date.parse(`${day(date)}T00:00:00Z`);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed + days * 86400000).toISOString().slice(0, 10);
}

/**
 * The measured P&L of one strategy row, or null when nothing measured it.
 *
 * Order of preference, best evidence first, and THERE IS NO THIRD SOURCE. This
 * used to fall through to the account's whole day divided evenly across whatever
 * was enabled, which its own comment called a fabrication.
 */
export function measuredSource(strategy) {
  if (!strategy) return null;
  if (strategy.derivedRealized != null) return 'derived';
  if (strategy.realized != null) return 'reported';
  return null;
}

export function measuredPnl(strategy) {
  // Branches off `measuredSource` rather than repeating its order of preference:
  // a second copy of this ladder is how a screen ends up labelling a derived
  // figure "reported by export" six months after one of the two moves.
  const source = measuredSource(strategy);
  if (source === 'derived') return Number(strategy.derivedRealized);
  if (source === 'reported') return Number(strategy.realized);
  return null;
}

/**
 * The configuration a strategy row is running, as this desk identifies one.
 *
 * VERSION PLUS THE PARAMETER IDENTITY, AND SIZING IS NOT IN IT.
 * strategyConfigDrift.js has drawn that line since it was written: profit
 * targets and the stop are what the team versions and swaps, PosSize is the risk
 * level a client is set to, and folding sizing in reports a client on a higher
 * risk setting as running a different version. Of 127 config-and-risk
 * combinations on a real book, 17 were only risk.
 *
 * Sizing is not thrown away — it scales the dollars directly, so it is counted
 * per configuration and stated on the screen, with a caveat where one
 * configuration carries more than one.
 *
 * Three sources, in order, so a row is never silently merged with a row whose
 * settings nobody read:
 *
 *   1. `params.profitTargets` + `params.stopLossTicks`, which is what the
 *      importer parses and what every row on the book carries.
 *   2. `configKeyOf(parametersRaw)` — the desk's own key, licence key and sizing
 *      already stripped — for an export that carries the raw string instead.
 *   3. Neither, in which case the row goes to a bucket named "configuration not
 *      stated" and is never merged with a stated one. `stated: false` is what
 *      the screen prints a refusal from.
 */
export function configurationOf(strategy) {
  const version = String(strategy?.strategyVersion || '').trim();
  const versionLabel = version ? `v${version} · ` : '';
  const params = strategy?.params || {};
  const targets = Array.isArray(params.profitTargets)
    ? params.profitTargets.filter((value) => value !== null && value !== undefined)
    : [];
  const stop = params.stopLossTicks;
  if (targets.length && stop !== null && stop !== undefined) {
    return {
      key: [version, targets.join('/'), String(stop)].join(FIELD),
      version,
      profitTargets: targets.map(Number),
      stopLossTicks: Number(stop),
      label: `${versionLabel}PT ${targets.join('/')} · SL ${stop}`,
      stated: true,
    };
  }
  const raw = strategy?.parametersRaw || '';
  const key = raw ? configKeyOf(raw) : null;
  if (key) {
    return {
      key: [version, key].join(FIELD),
      version,
      profitTargets: null,
      stopLossTicks: null,
      label: `${versionLabel}${shortConfigLabel(key, raw)}`,
      stated: true,
    };
  }
  return {
    key: [version, ''].join(FIELD),
    version,
    profitTargets: null,
    stopLossTicks: null,
    label: `${versionLabel}configuration not stated`,
    stated: false,
  };
}

/** The risk level, kept apart from the configuration. `''` where nothing said. */
export function sizingOf(strategy) {
  const sizes = strategy?.params?.posSizes;
  if (!Array.isArray(sizes) || !sizes.length) return '';
  return sizes.join('/');
}

/**
 * The mean of the observations with a 95% interval clustered on the account.
 *
 * Account-days off one account are not independent draws: an account that is
 * flat for eleven straight days contributes eleven observations that all say the
 * same thing. Treating them as eleven independent draws shrinks the interval by
 * roughly sqrt(11) and would let a row look separated from its neighbour on
 * evidence it does not have.
 *
 * `halfWidth` is null below two clusters: a variance over one account is not an
 * interval, it is a single observation with an arithmetic decoration.
 */
export function clusteredMean(observations) {
  const n = observations.length;
  if (!n) return null;
  const mean = observations.reduce((sum, o) => sum + o.value, 0) / n;
  const byCluster = new Map();
  for (const o of observations) {
    byCluster.set(o.cluster, (byCluster.get(o.cluster) || 0) + (o.value - mean));
  }
  const clusters = byCluster.size;
  if (clusters < 2) return { mean, clusters, n, halfWidth: null, low: null, high: null };
  let sumSquares = 0;
  for (const deviation of byCluster.values()) sumSquares += deviation * deviation;
  // The G/(G-1) finite-sample correction. With ten clusters the uncorrected
  // interval is 5% too narrow, and ten clusters is exactly what the gate lets
  // through.
  const variance = (clusters / (clusters - 1)) * (sumSquares / (n * n));
  const halfWidth = Z_95 * Math.sqrt(variance);
  return { mean, clusters, n, halfWidth, low: mean - halfWidth, high: mean + halfWidth };
}

/** A fresh accumulator for one measured population — an algorithm, or one of its
 * configurations. Identical shape for both, because they are the same
 * arithmetic over different populations and two copies of it would drift. */
function emptyStats() {
  return {
    observations: [],
    accounts: new Map(),
    clients: new Set(),
    unmeasuredAccountDays: 0,
    // Account-days on which this was the ONLY algorithm enabled on the account.
    // Counted over measured and unmeasured days alike, because it is a fact
    // about the account-day and not about whether anything measured it.
    //
    // It is evidence, never a rule. What it explains is why one row's mean and
    // another's are not the same measurement: a solo account-day's figure is
    // close to the whole account's day, a stacked one's is a share of a day
    // split with others. Nothing in this module branches on it.
    soloAccountDays: 0,
    upDays: 0,
    downDays: 0,
    flatDays: 0,
    byDate: [],
    // Deployment context: account-days and accounts per account-type segment.
    // COUNTS ONLY — there is deliberately no money field on this map, and there
    // is no money-per-business map beside it either. A per-business dollar and
    // this map, printed together, are a P&L per account type.
    bySegment: new Map(),
    sizing: new Map(),
    instruments: new Map(),
    roster: new Map(),
  };
}

function addObservation(stats, {
  accountKey, clientKey, date, business, segment, entry, snapshot, client, solo = false,
}) {
  stats.clients.add(clientKey);
  if (solo) stats.soloAccountDays += 1;
  if (!stats.accounts.has(accountKey)) stats.accounts.set(accountKey, 0);

  const deployed = stats.bySegment.get(segment)
    || { segment, business, accountDays: 0, accounts: new Set(), clients: new Set() };
  deployed.accountDays += 1;
  deployed.accounts.add(accountKey);
  deployed.clients.add(clientKey);
  stats.bySegment.set(segment, deployed);

  for (const size of entry.sizes) {
    stats.sizing.set(size, (stats.sizing.get(size) || 0) + 1);
  }
  for (const instrument of entry.instruments) {
    stats.instruments.set(instrument, (stats.instruments.get(instrument) || 0) + 1);
  }

  // The seat carries the account's TYPE and no business key. The type is a fact
  // about this one account and the roster is where the desk reads it; a
  // `business` beside a dollar is a bucket, and a bucket beside a dollar is the
  // per-account-type figure this module refuses. Nothing read it anyway.
  const seat = stats.roster.get(accountKey) || {
    accountKey,
    accountName: snapshot.accountName,
    clientKey,
    clientName: client?.name || '',
    segment,
    measuredPnl: 0,
    derivedPnl: 0,
    reportedPnl: 0,
    measuredAccountDays: 0,
    unmeasuredAccountDays: 0,
    daysDerived: 0,
    daysReported: 0,
    daysMixed: 0,
    firstDate: date,
    lastDate: date,
  };
  if (date < seat.firstDate) seat.firstDate = date;
  if (date > seat.lastDate) seat.lastDate = date;

  if (entry.measured) {
    stats.observations.push({ cluster: accountKey, value: entry.pnl });
    stats.accounts.set(accountKey, stats.accounts.get(accountKey) + entry.pnl);
    stats.byDate.push({ date, pnl: entry.pnl });
    if (entry.pnl > 0) stats.upDays += 1;
    else if (entry.pnl < 0) stats.downDays += 1;
    else stats.flatDays += 1;
    seat.measuredAccountDays += 1;
    seat.measuredPnl += entry.pnl;
    seat.derivedPnl += entry.derivedPnl;
    seat.reportedPnl += entry.reportedPnl;
    // An account-day is derived, reported, or both — never averaged into one
    // word. `mixed` is rare and is named rather than rounded to whichever source
    // happened to carry more of the money.
    if (entry.fromDerived && entry.fromReported) seat.daysMixed += 1;
    else if (entry.fromDerived) seat.daysDerived += 1;
    else seat.daysReported += 1;
  } else {
    stats.unmeasuredAccountDays += 1;
    seat.unmeasuredAccountDays += 1;
  }
  stats.roster.set(accountKey, seat);
}

function emptyEntry() {
  return {
    pnl: 0,
    measured: false,
    derivedPnl: 0,
    reportedPnl: 0,
    fromDerived: false,
    fromReported: false,
    sizes: new Set(),
    instruments: new Set(),
  };
}

function foldStrategy(entry, strategy, pnl) {
  if (pnl != null) {
    entry.pnl += pnl;
    entry.measured = true;
    // The two sources are summed apart and never blended. `derivedPnl +
    // reportedPnl === pnl` by construction. The flags are set separately from
    // the sums because 976 of the 1,402 measured observations on this book are
    // exactly $0: a source inferred from `derivedPnl !== 0` would call every
    // flat derived day "reported by export", which is most of the book.
    if (measuredSource(strategy) === 'derived') {
      entry.derivedPnl += pnl;
      entry.fromDerived = true;
    } else {
      entry.reportedPnl += pnl;
      entry.fromReported = true;
    }
  }
  const size = sizingOf(strategy);
  if (size) entry.sizes.add(size);
  const instrument = String(strategy?.instrument || '').trim();
  if (instrument) entry.instruments.add(instrument);
}

/**
 * Every (algorithm, account, close) the book measured, with the same arithmetic
 * repeated per configuration.
 *
 * ONE OBSERVATION PER ACCOUNT-DAY, not per strategy row. Two instances of the
 * same family enabled on one account on one day are one account-day and their
 * P&L is added; counting them twice prints 341 account-days where the desk has
 * 340, under a column headed "account-days".
 *
 * The configuration split folds the same account-day a second time, by (family,
 * configuration). An account-day running two configurations of one family is one
 * account-day for the algorithm and one for EACH configuration, so a
 * configuration's account-days can sum to more than the algorithm's. That is
 * counted rather than hidden — `splitAccountDays` on the detail — because the
 * alternative, assigning the account-day to whichever configuration held more of
 * the money, invents a fact about which one traded.
 *
 * THE ACCOUNT IS (client, account name), not the name alone. 53 of the 631
 * account names in this book are held by two different clients, `accountRegistry`
 * is per client, and every other figure on the Operations screen already counts
 * those as two accounts.
 */
function collectObservations(clients, { throughDate }) {
  const rows = new Map();
  // Per business: the account-days it covers and what the ACCOUNTS made on them,
  // so each business can say how much of its own money no algorithm claims.
  const coverage = new Map();
  const clientsSeen = new Set();
  const dates = new Set();
  // Account-days that carry no measured algorithm at all, per business.
  const unmeasured = new Map();
  // Closes that landed outside the four businesses — Ignored, orphan, simulated,
  // undetermined. Counted, never money.
  const reconciliation = new Map();

  for (const client of clients || []) {
    const registry = client?.accountRegistry || {};
    const clientKey = client?.id ?? client?.name ?? '';
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date) continue;
      if (throughDate && date > throughDate) continue;
      for (const snapshot of dailyImport?.snapshots || []) {
        // Fold this account-day's enabled strategies into one figure per family,
        // and one per (family, configuration).
        const perFamily = new Map();
        const perConfig = new Map();
        const configLabels = new Map();
        for (const strategy of snapshot.strategies || []) {
          if (!strategy?.enabled) continue;
          const algo = strategy.strategyFamily || strategy.strategyName || 'Unknown';
          const pnl = measuredPnl(strategy);
          const config = configurationOf(strategy);
          const familyEntry = perFamily.get(algo) || emptyEntry();
          foldStrategy(familyEntry, strategy, pnl);
          perFamily.set(algo, familyEntry);

          const configKey = `${algo}${FIELD}${config.key}`;
          configLabels.set(configKey, config);
          const configEntry = perConfig.get(configKey) || emptyEntry();
          foldStrategy(configEntry, strategy, pnl);
          perConfig.set(configKey, configEntry);
        }
        // An account-day with nothing enabled is not this panel's subject. It is
        // not counted anywhere here, including in the reconciliation line, whose
        // denominator has to be the same population as the ranking's.
        if (!perFamily.size) continue;

        const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
        const business = businessForSegment(segment);
        if (!business) {
          const seen = reconciliation.get(segment)
            || { segment, accountDays: 0, accounts: new Set() };
          seen.accountDays += 1;
          seen.accounts.add(`${clientKey} ${snapshot.accountName}`);
          reconciliation.set(segment, seen);
          continue;
        }
        const accountKey = `${clientKey} ${snapshot.accountName}`;

        dates.add(date);
        clientsSeen.add(clientKey);
        // One enabled family on this account-day. A property of the DAY, so the
        // configuration fold below is handed the same value: a configuration of
        // the only algorithm running is still on a solo account-day.
        const solo = perFamily.size === 1;
        let measuredHere = false;
        for (const [algo, entry] of perFamily) {
          const row = rows.get(algo) || {
            name: algo,
            stats: emptyStats(),
            configs: new Map(),
            // Account-days where this algorithm ran more than one configuration.
            splitAccountDays: 0,
          };
          if (entry.measured) measuredHere = true;
          addObservation(row.stats, {
            accountKey, clientKey, date, business, segment, entry, snapshot, client, solo,
          });
          rows.set(algo, row);
        }
        for (const [configKey, entry] of perConfig) {
          const [algo] = configKey.split(FIELD);
          const row = rows.get(algo);
          const config = configLabels.get(configKey);
          const held = row.configs.get(configKey)
            || { key: configKey, config, stats: emptyStats() };
          addObservation(held.stats, {
            accountKey, clientKey, date, business, segment, entry, snapshot, client, solo,
          });
          row.configs.set(configKey, held);
        }
        // Counted once per (algorithm, account-day) that carried two or more
        // configurations, which is what makes the configuration account-days sum
        // above the algorithm's.
        const configsPerFamily = new Map();
        for (const configKey of perConfig.keys()) {
          const [algo] = configKey.split(FIELD);
          configsPerFamily.set(algo, (configsPerFamily.get(algo) || 0) + 1);
        }
        for (const [algo, count] of configsPerFamily) {
          if (count > 1) rows.get(algo).splitAccountDays += 1;
        }

        const cover = coverage.get(business)
          || { accountDays: 0, accountPnl: 0, attributedPnl: 0 };
        if (measuredHere) {
          cover.accountDays += 1;
          cover.accountPnl += Number(snapshot.grossRealizedPnl || 0);
          for (const entry of perFamily.values()) {
            if (entry.measured) cover.attributedPnl += entry.pnl;
          }
          coverage.set(business, cover);
        } else {
          unmeasured.set(business, (unmeasured.get(business) || 0) + 1);
        }
      }
    }
  }

  return { rows, coverage, unmeasured, reconciliation, clientsSeen, dates };
}

function buildCoverage(cover, unmeasuredDays) {
  const accountDays = cover?.accountDays || 0;
  const accountPnl = round2(cover?.accountPnl || 0);
  const attributedPnl = round2(cover?.attributedPnl || 0);
  const unattributedPnl = round2(accountPnl - attributedPnl);
  return {
    accountDays,
    // What the ACCOUNTS in this business made over the very account-days the
    // ranking measures. The comparison the page owes its reader: an algorithm's
    // total reads as the account's day unless the gap is stated.
    accountPnl,
    attributedPnl,
    unattributedPnl,
    unattributedShare: accountPnl === 0 ? null : round2((unattributedPnl / accountPnl) * 100),
    shareRefusal: accountPnl === 0
      ? 'The accounts in this business netted exactly zero over the days it covers, so an '
        + 'unattributed share would divide by zero.'
      : null,
    unmeasuredAccountDays: unmeasuredDays || 0,
  };
}

const labelsByBusiness = () => new Map(deskBusinessColumns().map((column) => [column.key, column]));

/** Deployment context: where it runs, in COUNTS. There is no money here on
 * purpose — see the header. */
function deploymentOf(stats) {
  const totalDays = stats.observations.length + stats.unmeasuredAccountDays;
  const labels = labelsByBusiness();
  return [...stats.bySegment.values()]
    .map((row) => ({
      segment: row.segment,
      business: row.business,
      businessLabel: labels.get(row.business)?.label || row.business,
      accountDays: row.accountDays,
      accounts: row.accounts.size,
      clients: row.clients.size,
      share: totalDays ? Math.round((row.accountDays / totalDays) * 100) : null,
    }))
    .sort((a, b) => b.accountDays - a.accountDays || a.segment.localeCompare(b.segment));
}

function countedList(map) {
  return [...map.entries()]
    .map(([name, accountDays]) => ({ name, accountDays }))
    .sort((a, b) => b.accountDays - a.accountDays || a.name.localeCompare(b.name));
}

/**
 * The measured shape of one population — one algorithm, or one configuration of
 * one. Same function for both, so a configuration block and the row above it can
 * never be two different arithmetics.
 */
function finishStats(stats, { withholds = 'a result' } = {}) {
  const summary = clusteredMean(stats.observations);
  const accountDays = stats.observations.length;
  const accounts = stats.accounts.size;
  const decided = stats.upDays + stats.downDays;
  const profitable = [...stats.accounts.values()].filter((pnl) => pnl > 0).length;

  const reasons = [];
  if (accountDays < EVIDENCE_GATE.minAccountDays) {
    reasons.push(`${accountDays} reported account-day${accountDays === 1 ? '' : 's'}, `
      + `fewer than the ${EVIDENCE_GATE.minAccountDays} ${withholds} needs`);
  }
  if (accounts < EVIDENCE_GATE.minAccounts) {
    reasons.push(`${accounts} account${accounts === 1 ? '' : 's'}, fewer than the `
      + `${EVIDENCE_GATE.minAccounts} ${withholds} needs`);
  }

  return {
    // The figure the ranking is ordered by. Per REPORTED account-day, so the 976
    // account-days on this book that measured exactly 0 are in the denominator:
    // a flat day is a day the algorithm ran and made nothing, and dropping it
    // from the denominator flatters every algorithm that mostly sits still.
    meanPerAccountDay: accountDays ? round2(summary.mean) : null,
    ci: summary && summary.halfWidth != null
      ? {
        low: round2(summary.low),
        high: round2(summary.high),
        halfWidth: round2(summary.halfWidth),
        clusters: summary.clusters,
      }
      : null,
    ciRefusal: !accountDays
      ? 'Nothing measured this.'
      : (summary && summary.halfWidth == null
        ? 'One account. An interval needs at least two so the spread between accounts can show.'
        : null),
    accountDays,
    accounts,
    clients: stats.clients.size,
    // Three counts, all three printed. 976 of the 1,402 measured observations on
    // this book are exactly 0, and a table that showed only up and down days
    // could not tell a flat day from a day nobody reported.
    upDays: stats.upDays,
    downDays: stats.downDays,
    flatDays: stats.flatDays,
    // Account-days this ran on where neither the fills nor the grid said what it
    // made. In no figure above.
    unmeasuredAccountDays: stats.unmeasuredAccountDays,
    // Alone on the account-day, against sharing it. Printed as CONTEXT for the
    // mean and never as a rule: a solo account-day's figure is close to the
    // whole account's day and a stacked one's is a share of a day split with
    // others, which is why two means from different ends of this column are not
    // the same measurement. Nothing here is ranked, gated or excluded by it —
    // see algorithmProgrammes.js for why a threshold was refused.
    soloAccountDays: stats.soloAccountDays,
    stackedAccountDays: accountDays + stats.unmeasuredAccountDays - stats.soloAccountDays,
    soloShare: accountDays + stats.unmeasuredAccountDays
      ? Math.round((stats.soloAccountDays / (accountDays + stats.unmeasuredAccountDays)) * 100)
      : null,
    // Over DECIDED days only, and labelled that way wherever it is printed.
    winRate: decided ? Math.round((stats.upDays / decided) * 100) : null,
    decidedDays: decided,
    accountsProfitable: profitable,
    accountsProfitablePct: accounts ? Math.round((profitable / accounts) * 100) : null,
    // NO MONEY ON THIS OBJECT, AT ANY LEVEL. There is no `totalPnl`, and there
    // is no per-business list either. `totalPnl` is the defect everyone sees —
    // a key holding one number for an algorithm across the desk is a key the
    // next caller sums, which is how `total` came back on the desk-money rows
    // the first time. The per-business list was the defect nobody saw: it is
    // that same number split by account type, and `deployment` below hands the
    // reader the denominator to divide it by.
    moneyRefusal: POPULATION_MONEY_REFUSAL,
    // Where it is deployed, in counts. No mean and no money per account type.
    deployment: deploymentOf(stats),
    sizing: countedList(stats.sizing),
    instruments: countedList(stats.instruments),
    sufficient: reasons.length === 0,
    evidenceRefusal: reasons.length
      ? `${withholds === 'a rank' ? 'Not ranked' : 'Not read as a result'}: `
        + `${reasons.join('; ')}.`
      : null,
  };
}

function windowMean(byDate, from, to) {
  let sum = 0;
  let days = 0;
  for (const entry of byDate) {
    if (entry.date >= from && entry.date <= to) {
      sum += entry.pnl;
      days += 1;
    }
  }
  return { mean: days ? round2(sum / days) : null, days };
}

/**
 * The two seven-day windows, as MEANS per account-day rather than as sums.
 *
 * The sums were the same defect the leaderboard was built to remove, one column
 * to the left: a window's total moves with how many accounts were deployed in
 * it, so an algorithm rolled out to nine more accounts printed a "trend" without
 * behaving any differently. The difference of two means is in the unit the
 * ranking is in, and a window with no account-day in it refuses rather than
 * reading zero.
 */
function windowsFor(byDate, anchor) {
  const recentFrom = anchor ? shiftDay(anchor, -6) : '';
  const priorFrom = anchor ? shiftDay(anchor, -13) : '';
  const priorTo = anchor ? shiftDay(anchor, -7) : '';
  const recent = anchor ? windowMean(byDate, recentFrom, anchor) : { mean: null, days: 0 };
  const prior = anchor ? windowMean(byDate, priorFrom, priorTo) : { mean: null, days: 0 };
  const measurable = recent.days > 0 && prior.days > 0;
  const trend = measurable ? round2(recent.mean - prior.mean) : null;
  return {
    recentMeanPerAccountDay: recent.mean,
    recentAccountDays: recent.days,
    priorMeanPerAccountDay: prior.mean,
    priorAccountDays: prior.days,
    trend,
    // Three states, never two. `trend >= 0 ? up : down` printed an up arrow on
    // every row whose windows were both empty, which under a wall-clock anchor
    // was every row on the board.
    trendDirection: trend === null ? 'unknown' : (trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'),
    // A trend across two windows one of which measured nothing is not a trend,
    // and 0 is not "unchanged" when nothing was observed on one side.
    trendRefusal: measurable ? null
      : (recent.days === 0 && prior.days === 0
        ? `Neither the seven days to ${anchor} nor the seven before them measured this.`
        : `Only one of the two seven-day windows to ${anchor} measured this `
          + `(${recent.days} account-day${recent.days === 1 ? '' : 's'} in the recent one, `
          + `${prior.days} in the prior), so there is nothing to compare it with.`),
  };
}

/**
 * One entry per close the book holds up to the anchor, whether or not this
 * population was measured on it.
 *
 * A close nobody measured carries `mean: null` and `accountDays: 0`, NOT $0. The
 * two are different claims and a chart that draws them the same way says the
 * algorithm was flat on a day it did not run.
 *
 * A RATE AND A COUNT, AND NO TOTAL. There used to be a `pnl` here — the day's
 * money summed over every account-day of the close — and the panel printed it
 * under a column headed "Total on the day" carrying the tooltip that says every
 * dollar on this module is stated per business. It was not: one close is
 * whichever accounts happened to run that day, so that sum adds a cash dollar to
 * a prop dollar. It also got the SIGN wrong, twice, on the screen this book
 * opens: on 2026-07-30 OGX made +$7.00 on ordinary prop and -$285.50 on cash,
 * and both the algorithm's chart and its main configuration's printed the day as
 * -$278.50, a loss, on the two rows where the prop desk gained. The mean is a
 * rate and pools legitimately; the total was an accounting figure spanning two
 * kinds of dollar, so it is gone rather than restated per business — per
 * business it would be a P&L per account type per close.
 */
export function closeSeries(byDate, closes = [], anchor = '') {
  const byDay = new Map();
  for (const entry of byDate || []) {
    const seen = byDay.get(entry.date) || { pnl: 0, accountDays: 0 };
    seen.pnl += entry.pnl;
    seen.accountDays += 1;
    byDay.set(entry.date, seen);
  }
  return (closes || [])
    .filter((date) => !anchor || date <= anchor)
    .map((date) => {
      const seen = byDay.get(date);
      if (!seen) return { date, mean: null, accountDays: 0 };
      return {
        date,
        mean: round2(seen.pnl / seen.accountDays),
        accountDays: seen.accountDays,
      };
    });
}

/**
 * The ranking.
 *
 * ONE RANK PER ALGORITHM. It was four boards, one per business, and an algorithm
 * held a row on each of them: on this book OGX was #1 of four on cash and
 * unranked on ordinary prop at the same time, off the same closes and the same
 * configuration. The account type is not a property of the algorithm, and
 * splitting an algorithm's evidence by it both halved the evidence and produced
 * two answers where the desk needed one.
 *
 * `asOfDate` pins the ranking the way it pins the tiles: the history runs to
 * that close and the seven-day windows end on it. With nothing pinned the anchor
 * is the book's newest close — NOT `new Date()`, which is what the old board
 * used, and on 2026-08-20 over a book whose last close is 2026-07-30 that made
 * every window read zero and printed an up arrow on every row.
 *
 * `withDetail` keeps the per-account seats, the per-close series and the
 * per-configuration split on every finished row. It exists for
 * `buildAlgorithmDetail` below and for nothing else: the detail view must be the
 * ranking's own row, not a second measurement that happens to agree today.
 */
/**
 * A programme's row, with every ranked figure taken off it.
 *
 * WHAT IS DELIBERATELY ABSENT: `meanPerAccountDay`, its interval, the up/down/
 * flat counts, the win rate and the seven-day trend. Every one of them is a
 * reading of "what did it make per day", which is the question a stack answers
 * and the programme does not. Leaving one of them on the object is all it would
 * take for a panel to render it in a column beside OGX's, which is the mistake
 * this whole change exists to remove — the figure is stated once, in prose, in
 * `rankRefusal`, where it cannot be sorted.
 *
 * WHAT IS PRESENT: counts. Account-days, accounts, clients, where it is
 * deployed, what it trades, and how often it was alone on the account-day. Those
 * are facts about the deployment, not verdicts about it.
 */
function buildProgrammeRow(row, { topRanked }) {
  const programme = programmeFor(row.name);
  const totalDays = row.accountDays + row.unmeasuredAccountDays;
  const offType = (row.deployment || []).filter((entry) => entry.segment !== programme.segment);
  const compared = topRanked && topRanked.soloShare != null
    ? `${topRanked.name}, the row at the top of this table, was alone on `
      + `${topRanked.soloShare}% of its`
    : 'the ordinary algorithms share their account-days, so their means are a share of';
  return {
    name: row.name,
    programme: true,
    asks: programme.asks,
    what: programme.what,
    answeredBy: programme.answeredBy,
    answeredByNote: programme.answeredByNote,
    note: PROGRAMME_ROW_NOTE,
    // Counts only. Same fields, meaning the same thing, as on a ranking row.
    accountDays: row.accountDays,
    unmeasuredAccountDays: row.unmeasuredAccountDays,
    accounts: row.accounts,
    clients: row.clients,
    soloAccountDays: row.soloAccountDays,
    stackedAccountDays: row.stackedAccountDays,
    soloShare: row.soloShare,
    instruments: row.instruments,
    sizing: row.sizing,
    deployment: row.deployment,
    expectedSegment: programme.segment,
    // Account-days on accounts NOT typed for the programme. Not the same thing
    // as a breach of the CAM's rule — an untyped account has no type to
    // contradict — which is why the count is neutral here and the exceptions
    // are sorted out by standing in buildProgrammeAccountStanding, where each
    // one is named.
    offTypeAccountDays: offType.reduce((sum, entry) => sum + entry.accountDays, 0),
    offTypeSegments: offType.map((entry) => entry.segment),
    rankRefusal: `Not ranked here, and not because it did badly. ${row.name} was alone on the `
      + `account-day on ${row.soloAccountDays} of its ${totalDays} account-day`
      + `${totalDays === 1 ? '' : 's'} (${row.soloShare}%), so a per-account-day figure for it is `
      + `close to the whole account's day; ${compared} account-days, so the same figure there is a `
      + 'share of a day split with others. Ranking the two in one column compares a whole with a '
      + 'part. And the column asks the wrong question of it anyway: this is a programme for '
      + 'PASSING an evaluation, where passing on day two for a small amount is a complete success '
      + 'and the same amount on a funded stack is a mediocre week.',
    moneyRefusal: row.moneyRefusal,
  };
}

export function buildStrategyRanking(clients = [], { asOfDate = '', withDetail = false } = {}) {
  const list = clients || [];
  const book = bookCloses(list);
  const anchor = day(asOfDate) || book.latest || '';
  const { rows, coverage, unmeasured, reconciliation, clientsSeen, dates } =
    collectObservations(list, { throughDate: anchor });

  const finished = [];
  for (const row of rows.values()) {
    const out = {
      name: row.name,
      ...finishStats(row.stats, { withholds: 'a rank' }),
      ...windowsFor(row.stats.byDate, anchor),
    };
    out.ranked = out.sufficient;
    out.rankRefusal = out.evidenceRefusal;
    out.rank = null;
    if (withDetail) {
      out.roster = [...row.stats.roster.values()];
      out.series = closeSeries(row.stats.byDate, book.closes, anchor);
      out.splitAccountDays = row.splitAccountDays;
      out.configurations = [...row.configs.values()].map((held) => ({
        key: held.key,
        label: held.config.label,
        version: held.config.version,
        profitTargets: held.config.profitTargets,
        stopLossTicks: held.config.stopLossTicks,
        stated: held.config.stated,
        ...finishStats(held.stats),
        ...windowsFor(held.stats.byDate, anchor),
        roster: [...held.stats.roster.values()],
        series: closeSeries(held.stats.byDate, book.closes, anchor),
      }));
    }
    finished.push(out);
  }

  // The programmes come off the ranked population before anything is sorted.
  // They are not peers of the rows below and the column they were sorted in
  // asks a question they do not answer — see algorithmProgrammes.js. Their rows
  // survive, in `programmes`, carrying counts and no verdict.
  const rankable = finished.filter((row) => !isProgrammeFamily(row.name));
  const programmeSource = finished.filter((row) => isProgrammeFamily(row.name));

  // Ranked first, best mean first. Unranked after, most evidence first, so the
  // reader can see which rows are closest to earning a rank.
  const ranked = rankable.filter((row) => row.ranked)
    .sort((a, b) => b.meanPerAccountDay - a.meanPerAccountDay);
  ranked.forEach((row, index) => { row.rank = index + 1; });
  const unranked = rankable.filter((row) => !row.ranked)
    .sort((a, b) => b.accountDays - a.accountDays || a.name.localeCompare(b.name));

  const programmes = programmeSource
    .map((row) => buildProgrammeRow(row, { topRanked: ranked[0] || null }))
    .sort((a, b) => b.accountDays - a.accountDays || a.name.localeCompare(b.name));
  // The ordinary algorithm that runs alone most often, named so the refusal of a
  // solo-versus-stacked threshold carries this book's own counter-example
  // instead of an assertion.
  // Taken from the RANKED rows where there are any: a two-account-day row at
  // 50% is not a counter-example anybody would accept, and the point of the
  // sentence is that the line cannot be drawn anywhere defensible.
  const soloCandidates = (ranked.length ? ranked : rankable);
  const topSoloOrdinary = [...soloCandidates]
    .filter((row) => row.soloShare != null)
    .sort((a, b) => b.soloShare - a.soloShare
      || b.accountDays - a.accountDays
      || a.name.localeCompare(b.name))[0] || null;

  const labels = labelsByBusiness();
  const businesses = DESK_BUSINESS_ORDER
    .filter((key) => coverage.has(key) || unmeasured.has(key))
    .map((key) => ({
      key,
      label: labels.get(key)?.label || key,
      shortLabel: labels.get(key)?.shortLabel || key,
      kind: BUSINESS_KINDS[key],
      note: BUSINESS_NOTES[key],
      coverage: buildCoverage(coverage.get(key), unmeasured.get(key)),
    }));

  const closes = [...dates].sort();
  // Closes in the book up to the anchor, whether or not they carry an algorithm
  // split. The denominator: "13 closes" alone reads as the whole range.
  const closesToAnchor = book.closes.filter((date) => !anchor || date <= anchor);
  const reconciliationRows = [...reconciliation.values()]
    .map((entry) => ({
      segment: entry.segment,
      accountDays: entry.accountDays,
      accounts: entry.accounts.size,
    }))
    .sort((a, b) => b.accountDays - a.accountDays);

  return {
    basis: {
      anchor,
      requested: day(asOfDate) || null,
      firstClose: closes[0] || null,
      lastClose: closes[closes.length - 1] || null,
      closeCount: closes.length,
      closesToAnchor: closesToAnchor.length,
      latestCloseInBook: book.latest,
      closesAfterAnchor: book.closes.filter((date) => anchor && date > anchor).length,
      clients: clientsSeen.size,
      clientsInScope: list.length,
      label: closes.length
        ? `Every close from ${closes[0]} to ${closes[closes.length - 1]} that carries an algorithm`
          + ` split · ${closes.length} of ${closesToAnchor.length} closes`
          + ` · ${clientsSeen.size} of ${list.length} clients`
          + ` · seven-day windows end ${anchor}`
        : 'No close on this book carries an algorithm split.',
    },
    ranking: {
      rows: [...ranked, ...unranked],
      rankedCount: ranked.length,
      unrankedCount: unranked.length,
      // Off the ranked population, still on the page. Never spread into `rows`:
      // the whole point is that these two lists are not one list.
      programmes,
      programmeCount: programmes.length,
      programmeBoundary: PROGRAMME_BOUNDARY,
      thresholdRefusal: thresholdRefusal(topSoloOrdinary),
      unitNote: RANK_UNIT_NOTE,
      instrumentCaveat: INSTRUMENT_CAVEAT,
    },
    // Money, per business, exactly as deskMoney reports it. Never added, and no
    // row of the ranking above is scoped to one of these.
    businesses,
    moneyIsPerBusiness: MONEY_PER_BUSINESS,
    crossBusinessCoverageRefusal: CROSS_BUSINESS_REFUSAL,
    reconciliation: {
      rows: reconciliationRows,
      accountDays: reconciliationRows.reduce((sum, row) => sum + row.accountDays, 0),
      note: 'Closes on accounts marked Inactive / Ignore, with no account on record, or not real '
        + 'money. In no ranking row, in no total — counted here so the exclusion is visible.',
    },
    gate: {
      ...EVIDENCE_GATE,
      note: `A row needs ${EVIDENCE_GATE.minAccountDays} reported account-days AND `
        + `${EVIDENCE_GATE.minAccounts} accounts before it is given a rank. Below either it is `
        + 'listed with its counts and no position.',
    },
  };
}

/**
 * The figures this ranking will not produce, and why, in the shape the capital
 * panel's refusal list already uses.
 *
 * Written here rather than in the component: every one of them is a statement
 * about the arithmetic, and a refusal that lives in the markup is one that
 * survives a rewrite of the markup and nothing else.
 */
export function rankingRefusals(result) {
  const rows = result?.ranking?.rows || [];
  const unranked = result?.ranking?.unrankedCount || 0;
  const ranked = result?.ranking?.rankedCount || 0;
  const businesses = result?.businesses?.length || 0;
  const programmes = result?.ranking?.programmes || [];
  return [
    ...programmes.map((programme) => ({
      figure: `A rank for ${programme.name}, and a mean per account-day beside the rows above`,
      value: null,
      reason: `${programme.rankRefusal} It is not hidden: it keeps a row on this table with its `
        + `${programme.accountDays} measured account-day`
        + `${programme.accountDays === 1 ? '' : 's'} on ${programme.accounts} account`
        + `${programme.accounts === 1 ? '' : 's'}, and what it is measured on is `
        + `“${programme.answeredBy}”.`,
    })),
    {
      figure: 'A solo-versus-stacked threshold instead of a named programme',
      value: null,
      reason: result?.ranking?.thresholdRefusal || thresholdRefusal(null),
    },
    {
      figure: 'A separate ranking per account type',
      value: null,
      reason: 'There was one — four boards, one per business, with an algorithm holding a row on '
        + 'each. On this book that reported OGX as the best row on cash at +$23.52 per account-day '
        + 'and as an unranked -$54.12 on ordinary prop, over the same closes, running the same '
        + 'version 2.4 at the same 1/1/0 sizing on the same contract. The account type is a '
        + 'property of the account; it explained nothing about the algorithm and halved the '
        + `evidence behind both figures. There are ${rows.length} algorithms here and each has one `
        + 'rank.',
    },
    {
      figure: 'A rank ordered by total P&L',
      value: null,
      reason: 'Total P&L grows with deployment, and on a book where every algorithm loses it '
        + 'ranks deployment upside down: Spearman(total, account-days) = -0.807, the desk’s '
        + 'largest deployment sorted last and a two-observation algorithm sorted first. The money '
        + 'is still here, per business, and nothing is sorted by it.',
    },
    {
      figure: 'Any dollar on a ranking row — one total, or one per business',
      value: null,
      reason: MONEY_PER_BUSINESS + ' A row here carried that split — cash beside prop, never '
        + 'added — with the account-days of each business printed in the same cell. Divide one by '
        + 'the other and the account-type verdict this ranking was rebuilt to remove is back. The '
        + `desk’s own money is stated for each of the ${businesses} businesses under this table, `
        + 'across every algorithm at once, and no row carries a dollar of any kind.',
    },
    {
      figure: 'A composite effectiveness score',
      value: null,
      reason: 'The old one was 0-10, min-max normalised against the largest absolute total on '
        + 'the board, so the scale moved when the desk added accounts and a score could not be '
        + 'compared with the same score last week. Three measured columns that disagree with each '
        + 'other are more use than one number that hides the disagreement.',
    },
    {
      figure: `A rank for the ${unranked} row${unranked === 1 ? '' : 's'} below the evidence gate`,
      value: null,
      reason: `${ranked} row${ranked === 1 ? ' carries' : 's carry'} the `
        + `${EVIDENCE_GATE.minAccountDays} reported account-days and ${EVIDENCE_GATE.minAccounts} `
        + 'accounts a position is worth; the rest are listed with their counts and no position. A '
        + 'mean over two account-days is a number, not a measurement, and it used to be printed at '
        + 'the top of the page.',
    },
    {
      figure: 'A comparison between two algorithms on different contracts',
      value: null,
      reason: INSTRUMENT_CAVEAT,
    },
    {
      figure: 'One coverage percentage across every business',
      value: null,
      reason: CROSS_BUSINESS_REFUSAL,
    },
    {
      figure: 'What the unattributed money in each business belongs to',
      value: null,
      reason: 'The gap between what an account made and what its algorithms account for is not '
        + 'assigned. It used to be: the account’s day was divided evenly across whatever was '
        + 'enabled, which put a figure nobody measured into the ranking. Each business now states '
        + 'the size of its own gap and stops there.',
    },
  ];
}

// ---------------------------------------------------------------------------
// ONE ALGORITHM, SPLIT BY WHAT ACTUALLY DIFFERS INSIDE IT.
//
// The ranking answers "which algorithm". This answers "this algorithm" — opened
// from a ranking row, because that is where the desk is standing when the
// question arrives: a client is about to have something taken off and something
// else put on.
//
// THE SEGMENTATION IS THE CONFIGURATION. Two runs of the same algorithm with
// different profit targets are the comparison a CAM is actually making. Two runs
// on different account types are the same run seen through a property of the
// account, and the previous version of this view presented them as two
// behaviours.
//
// AND IT IS THE RANKING'S OWN ROW. `buildStrategyRanking(..., { withDetail: true })`
// is called and its rows are sliced; nothing here re-measures anything. A detail
// view with its own mean would disagree with the row it was opened from on the
// day one of the two changed, and the desk would have no way to tell which to
// believe.
// ---------------------------------------------------------------------------

const SERIES_NOTE = 'One bar per close the book holds, in the same unit the ranking is in: '
  + 'measured P&L per account-day. A close this was not measured on is a gap, not a zero. '
  + 'Nothing is fitted through the bars — a line drawn across three closes is a claim about a '
  + 'fourth that nothing here measured. And no dollar total on a close: the account-days behind '
  + 'one close can sit in two businesses, so their sum adds a cash dollar to a prop dollar, and '
  + 'splitting it per business would state a P&L per account type one close at a time.';

const ACCOUNT_TYPE_REFUSAL = 'No P&L and no mean per account type. The account type is a property '
  + 'of the ACCOUNT, not of the run: on this book OGX is one version at one sizing on one '
  + 'contract on every type it touches, and the closes overlap almost completely, so a figure per '
  + 'type differs only by sample. Printed as two means it read as two behaviours and invited a '
  + 'deployment decision on noise. What is below is where the algorithm runs and how much of it '
  + 'runs there, in account-days and accounts.\n\n'
  + 'This is a refusal to PUBLISH that figure, not a claim that you cannot arrive at it. The '
  + 'roster below names each account and what it made, and a CAM knows which of his own accounts '
  + 'are cash, so the arithmetic is available to anyone who wants it. Making it unavailable would '
  + 'cost the per-account money this page exists to show, and would still not stop a reader who '
  + 'knows the book. The reason not to trust the answer is the one above: at one version, one '
  + 'sizing and one contract, over closes that overlap, a difference between account types is '
  + 'sample and not strategy.';

const CONFIGURATION_NOTE = 'Configurations are named by the version plus the profit-target legs '
  + 'and the stop, in ticks — the identity this desk already uses on the configuration review. '
  + 'Position sizing is the risk level, not the version, so it is counted beside each '
  + 'configuration rather than folded into it.';

/** A client's or an account's seats folded into one displayable row. */
function foldSeats(seats, extra = {}) {
  const measuredAccountDays = seats.reduce((n, s) => n + s.measuredAccountDays, 0);
  const unmeasuredAccountDays = seats.reduce((n, s) => n + s.unmeasuredAccountDays, 0);
  const dates = seats.flatMap((s) => [s.firstDate, s.lastDate]).sort();
  return {
    ...extra,
    measuredAccountDays,
    unmeasuredAccountDays,
    accountDays: measuredAccountDays + unmeasuredAccountDays,
    daysDerived: seats.reduce((n, s) => n + s.daysDerived, 0),
    daysReported: seats.reduce((n, s) => n + s.daysReported, 0),
    daysMixed: seats.reduce((n, s) => n + s.daysMixed, 0),
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    // Kept apart, permanently. `measuredPnl` is what the ranking added up;
    // `derivedPnl` is the half the fills produced and `reportedPnl` the half
    // NinjaTrader's grid did, and they sum to it exactly.
    measuredPnl: measuredAccountDays ? round2(seats.reduce((n, s) => n + s.measuredPnl, 0)) : null,
    derivedPnl: measuredAccountDays ? round2(seats.reduce((n, s) => n + s.derivedPnl, 0)) : null,
    reportedPnl: measuredAccountDays ? round2(seats.reduce((n, s) => n + s.reportedPnl, 0)) : null,
    // The whole point of the null above. "How much has it made them" is
    // answerable only where something measured it; where nothing did, the answer
    // is that nobody knows, and the account-days it ran on are named instead of
    // being handed a share of the account's day.
    attributable: measuredAccountDays > 0,
    refusal: measuredAccountDays > 0 ? null
      : `This algorithm ran on ${unmeasuredAccountDays} account-day`
        + `${unmeasuredAccountDays === 1 ? '' : 's'} here and neither the fills nor the `
        + 'Strategies grid said what it made on any of them. Nothing is shown rather than a '
        + 'share of the account’s own day.',
    caveat: measuredAccountDays > 0 && unmeasuredAccountDays > 0
      ? `${unmeasuredAccountDays} further account-day${unmeasuredAccountDays === 1 ? '' : 's'} `
        + 'ran this with nothing measuring it. Not in the figure.'
      : null,
  };
}

/** Losses first would be the wrong order for a placement decision. Best first. */
function bySeatValue(a, b) {
  if (a.attributable !== b.attributable) return a.attributable ? -1 : 1;
  if (a.attributable) return b.measuredPnl - a.measuredPnl;
  return b.accountDays - a.accountDays;
}

/** A roster split into client rows and account rows, best first. */
function rosterOf(seats) {
  const byClient = new Map();
  for (const seat of seats || []) {
    if (!byClient.has(seat.clientKey)) byClient.set(seat.clientKey, []);
    byClient.get(seat.clientKey).push(seat);
  }
  const clientRows = [...byClient.values()].map((group) => foldSeats(group, {
    clientKey: group[0].clientKey,
    clientName: group[0].clientName,
    accounts: group.length,
    accountNames: group.map((s) => s.accountName).sort(),
  })).sort(bySeatValue);
  const accountRows = (seats || []).map((seat) => foldSeats([seat], {
    accountKey: seat.accountKey,
    accountName: seat.accountName,
    clientKey: seat.clientKey,
    clientName: seat.clientName,
    // The account type is on the ACCOUNT row, where it belongs: it says which
    // account this is, not how the algorithm behaved.
    segment: seat.segment,
  })).sort(bySeatValue);
  return { clients: clientRows, accounts: accountRows };
}

function buildConfiguration(entry) {
  const { clients: clientRows, accounts: accountRows } = rosterOf(entry.roster);
  const series = entry.series || [];
  const measuredCloses = series.filter((point) => point.accountDays > 0).length;
  const sizing = entry.sizing || [];
  return {
    ...entry,
    // `clients` and `accounts` stay the COUNTS finishStats produced — the same
    // fields, meaning the same thing, as on the ranking row. The rosters are
    // named separately: overwriting a count with the list behind it is how a
    // "16 clients" cell starts rendering an array's length by accident.
    clientRows,
    accountRows,
    seriesNote: SERIES_NOTE,
    measuredCloses,
    seriesRefusal: measuredCloses ? null
      : 'No close in this book measured this configuration, so there is nothing to chart. The '
        + 'account-days it ran on are counted in the evidence above.',
    // Sizing scales the dollars directly, so a configuration carrying two of
    // them is one version run at two risk levels and its mean is a blend of the
    // two. Named rather than normalised: this module does not know how many
    // contracts a leg opened, and dividing by a guess would be worse.
    sizingCaveat: sizing.length > 1
      ? `Run at ${sizing.length} position sizings — `
        + `${sizing.map((row) => `${row.name} on ${row.accountDays}`).join(', ')} account-days. `
        + 'Sizing is the risk level, not the version, so it is not part of this configuration’s '
        + 'identity; but it scales the P&L, so the mean above is a blend across it.'
      : null,
    clientsWithoutFigures: clientRows.filter((c) => !c.attributable).length,
    accountsWithoutFigures: accountRows.filter((a) => !a.attributable).length,
  };
}

/**
 * One algorithm's record, configuration by configuration.
 *
 * `algorithm` is the family name as it appears on a ranking row — the same
 * string the ranking prints, because the ranking row is the entry point.
 */
export function buildAlgorithmDetail(clients = [], { algorithm = '', asOfDate = '' } = {}) {
  const name = String(algorithm || '');
  const result = buildStrategyRanking(clients, { asOfDate, withDetail: true });
  const row = result.ranking.rows.find((candidate) => candidate.name === name) || null;
  const known = [...new Set(result.ranking.rows.map((candidate) => candidate.name))].sort();
  // Opened by name, a programme does not fall through to "nothing in this book
  // carries a row for it" — which would be the one reading that is false. It is
  // measured, richly, somewhere else, and the answer is the pointer there.
  const programme = (result.ranking.programmes || [])
    .find((candidate) => candidate.name === name) || null;

  if (!row) {
    return {
      algorithm: name,
      found: false,
      // Not a ranked algorithm and not an unknown one. A third state, because
      // the two existing ones are both wrong about it.
      programme,
      programmes: result.ranking.programmes || [],
      programmeBoundary: result.ranking.programmeBoundary,
      basis: result.basis,
      overall: null,
      configurations: [],
      configurationCount: 0,
      knownAlgorithms: known,
      businesses: result.businesses,
      moneyRefusal: POPULATION_MONEY_REFUSAL,
      moneyIsPerBusiness: result.moneyIsPerBusiness,
      accountTypeRefusal: ACCOUNT_TYPE_REFUSAL,
      configurationNote: CONFIGURATION_NOTE,
      gate: result.gate,
    };
  }

  // Ordered by EVIDENCE, never by mean. Ordering configurations by their means
  // would rank a four-account-day configuration against a seventy-account-day
  // one, which is the thing the gate exists to stop one level up.
  const configurations = (row.configurations || [])
    .map(buildConfiguration)
    .sort((a, b) => b.accountDays - a.accountDays
      || b.unmeasuredAccountDays - a.unmeasuredAccountDays
      || a.label.localeCompare(b.label));

  const { clients: clientRows, accounts: accountRows } = rosterOf(row.roster);
  const readable = configurations.filter((config) => config.sufficient);
  const series = row.series || [];

  return {
    algorithm: name,
    found: true,
    basis: result.basis,
    // The ranking's own row, untouched. Every figure the detail prints at the
    // top — mean, interval, evidence, rank, the seven-day windows — is this
    // object, so the two screens cannot disagree.
    overall: row,
    rank: row.rank,
    ranked: row.ranked,
    rankRefusal: row.rankRefusal,
    // Ordinary algorithms only. The programmes were never peers of this row and
    // are no longer counted as though they were — see algorithmProgrammes.js.
    peers: result.ranking.rows.length,
    rankedPeers: result.ranking.rankedCount,
    programme: null,
    programmes: result.ranking.programmes || [],
    programmeBoundary: result.ranking.programmeBoundary,
    series,
    seriesNote: SERIES_NOTE,
    measuredCloses: series.filter((point) => point.accountDays > 0).length,
    clientRows,
    accountRows,
    clientsWithoutFigures: clientRows.filter((c) => !c.attributable).length,
    configurations,
    configurationCount: configurations.length,
    configurationNote: CONFIGURATION_NOTE,
    readableConfigurations: readable.length,
    // Account-days on which this algorithm ran two configurations at once, so a
    // reader adding the configuration account-days up can see why they exceed
    // the algorithm's own count.
    splitAccountDays: row.splitAccountDays || 0,
    comparisonRefusal: readable.length >= 2 ? null
      : (configurations.length <= 1
        ? 'This algorithm runs one configuration on this book, so there is no comparison to make.'
        : `${readable.length} of the ${configurations.length} configurations below carries the `
          + `${EVIDENCE_GATE.minAccountDays} reported account-days and `
          + `${EVIDENCE_GATE.minAccounts} accounts this desk reads a result on. The others are `
          + 'listed with their counts and no verdict — naming a better configuration off four '
          + 'account-days is the mistake this page was rebuilt to stop.'),
    comparisonNote: readable.length >= 2
      ? 'Two or more configurations carry enough evidence to be read. Compare the intervals, not '
        + 'the means: two intervals that overlap have not been shown to differ, and even two that '
        + 'do not overlap are a conservative test on this kind of clustered data.'
      : null,
    // Where it runs, in counts, and why there is no money on it.
    deployment: row.deployment,
    accountTypeRefusal: ACCOUNT_TYPE_REFUSAL,
    // Where the money is not. The desk's money, per business, is on
    // `businesses` below and belongs to the desk, not to this algorithm.
    moneyRefusal: row.moneyRefusal,
    moneyIsPerBusiness: result.moneyIsPerBusiness,
    businesses: result.businesses,
    knownAlgorithms: known,
    gate: result.gate,
  };
}

/**
 * The figures the detail view will not produce, in the same shape the ranking
 * uses.
 *
 * Generated from the detail rather than hard-coded so the counts in it are the
 * counts on the screen beside it — a refusal that says "2 configurations" while
 * the page shows 3 is worse than no refusal at all.
 */
export function algorithmRefusals(detail) {
  const configurations = detail?.configurations || [];
  const unreadable = configurations.filter((config) => !config.sufficient);
  const noFigure = detail?.clientsWithoutFigures || 0;
  const algorithm = detail?.algorithm || 'this algorithm';
  return [
    {
      figure: `A performance figure per account type for ${algorithm}`,
      value: null,
      reason: ACCOUNT_TYPE_REFUSAL,
    },
    {
      figure: `Any dollar for ${algorithm} itself — one total, or one per business`,
      value: null,
      reason: (detail?.moneyRefusal || POPULATION_MONEY_REFUSAL)
        + ` It applies to ${algorithm} and to each of its `
        + `${configurations.length} configuration${configurations.length === 1 ? '' : 's'} alike, `
        + 'and to every close of either: the chart states a mean per account-day and an '
        + 'account-day count, and no total on the day.',
    },
    {
      figure: 'A verdict on a configuration below the evidence gate',
      value: null,
      reason: unreadable.length
        ? `${unreadable.map((config) => `${config.label} — ${config.evidenceRefusal}`).join(' ')}`
          + ' The counts are printed and no verdict is given, here exactly as on the ranking this '
          + 'was opened from.'
        : `Every configuration here clears ${EVIDENCE_GATE.minAccountDays} reported account-days `
          + `and ${EVIDENCE_GATE.minAccounts} accounts. The refusal is listed anyway because it is `
          + 'the rule, not an exception.',
    },
    {
      figure: 'A line fitted through the closes',
      value: null,
      reason: 'The chart is one bar per close and nothing joins them. A trend drawn through a '
        + 'handful of account-days reads as a track record, and the gate above exists precisely '
        + 'because a handful of account-days is not one.',
    },
    {
      figure: 'What a client made where no split is attributable',
      value: null,
      reason: noFigure
        ? `${noFigure} client row${noFigure === 1 ? '' : 's'} ran this algorithm on account-days `
          + 'that neither the fills nor the Strategies grid could put a figure on. Those rows show '
          + 'their account-days and no money. The account’s own day is never divided across '
          + 'whatever was enabled — that is the fabrication the ranking was built to remove.'
        : 'Every client row here carries measured account-days. Where one does not, it shows its '
          + 'account-days and no money rather than a share of the account’s own day.',
    },
    {
      figure: 'What the unattributed money in each business belongs to',
      value: null,
      reason: 'Each business states what its accounts made over the days it covers and what its '
        + 'algorithms account for. The gap is not assigned to this algorithm or to any other.',
    },
  ];
}
