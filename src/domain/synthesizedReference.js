// A reference configuration derived from the accounts themselves, for the
// families the desk's set-file library does not hold.
//
// setFileMatch.js answers "what is this account running" against 911 files the
// desk WROTE. For G4M it cannot answer at all: 47 of the 619 latest strategy
// rows run a family with no folder in the library, and the panel correctly
// refuses to say anything about them. This module is the fallback, and the whole
// design problem is that the fallback is a weaker kind of evidence than the
// thing it stands in for.
//
//   A set file is what the desk DECIDED.
//   An observed reference is only what the accounts HAPPEN to do.
//
// They can be the same thing and there is no way to measure whether they are. If
// every account in a cohort drifted the same way, the majority moved with them,
// the observed reference is the drifted configuration, and this module will
// report — confidently, with a large sample and a high share — that everything
// agrees. That failure is silent by construction and cannot be detected from the
// book. It can only be labelled, so every object this module returns carries
// `basis: 'OBSERVED'` and nothing here ever produces a set-file name, a version
// number or a risk level. Those are claims only the library can make.
//
// What that buys, stated plainly: this module can find an account that departs
// from its cohort. It can never find a cohort that departs from the desk.
//
// Second design rule, from the same place: a guard is a finding. buildConfigDrift
// drops a cohort it cannot judge with a bare `continue` — 33 of the 43 cohorts on
// the real book — so "checked and uniform", "too small to judge", "too
// fragmented to have a norm" and "does not exist" all render as absence. Here
// every in-scope cohort comes back with a status and a reason, and a cohort with
// no majority returns `reference: null`, never a majority-of-a-fragment.
//
// What this reports on today's book, in full: ONE cohort. G4M on MES — 47 rows,
// 46 accounts, 36 clients — with a reference 35 rows deep (74%) across 3
// configurations, 25 of its 27 compared settings identical on every row, and the
// four version-identity fields unanimous. Out of it come two statements of
// different kinds: one account to verify (EdgeLeverage false → true, 1 row) and
// one second configuration the cohort runs (CloseAllOpenTradeTime 16:45 → 16:30,
// 11 accounts, 23%). Not a long list, and that is the result: applied honestly to
// the only family the library cannot reach, the answer is one account.

import { countAccounts } from './configDriftPresentation';
import {
  MATCH,
  VERSION_IDENTITY,
  bookFamilyOf,
  buildSetFileMatch,
  instrumentGroupOf,
} from './setFileMatch';
import {
  FIELD,
  PER_CLIENT_FIELDS,
  SIZING,
  normaliseSetFileValue,
  parseLiveParameters,
} from './setFileNormalise';
import {
  buildConfigCohorts,
  configKeyOf,
  configParametersOf,
  describeConfigDifference,
} from './strategyConfigDrift';

/**
 * The one word that separates this module's output from setFileMatch's.
 *
 * On every cohort, on the reference, and on every configuration group under it —
 * not once at the top. A CAM reads a panel by landing on a row, and a caveat
 * three sections above the row is a caveat that was not read.
 */
export const BASIS = 'OBSERVED';

export const REFERENCE = Object.freeze({
  /** A majority large enough to state. Still observed, never catalogued. */
  OBSERVED: 'OBSERVED',
  /** No configuration holds enough of the cohort to be a norm. NOT "all fine". */
  NO_MAJORITY: 'NO_MAJORITY',
  /** Too few rows for a majority to mean anything. NOT "all fine" either. */
  COHORT_TOO_SMALL: 'COHORT_TOO_SMALL',
  /** No row in the cohort exported parameters anyone can parse. */
  NOTHING_READABLE: 'NOTHING_READABLE',
});

/**
 * How this module reads a strategy row, in one place.
 *
 * Every extractor here is setFileMatch's own, imported rather than re-derived.
 * A reference built on a different reading of the same rows would be a second
 * opinion about which accounts are in a cohort, which is exactly the bug that
 * has the drift panel spelling `IFSP-PF` where the set-file panel spells
 * `IFSP_PF` for the same 15 accounts.
 *
 * `normaliseSetFileValue` on the values, and setFileNormalise's four-spelling
 * SIZING on the names, because this output sits in the same panel as catalogued
 * matches: a reference quoting `1/1/2020 4:45:00 PM` beside a set file quoting
 * `2020-01-01T16:45:00` states the same instant twice in two dialects and looks
 * like a difference.
 */
const READING = Object.freeze({
  familyOf: (strategy) => bookFamilyOf(strategy),
  instrumentOf: (strategy) => instrumentGroupOf(strategy?.instrument),
  keyOf: (strategy) => configKeyOf(strategy?.parametersRaw, {
    sizing: SIZING,
    normaliseValue: normaliseSetFileValue,
  }),
});

const cohortKey = (family, instrument) => `${family}${FIELD}${instrument}`;

/**
 * The cohorts the library cannot speak to at all.
 *
 * Gated on the classification, never on a family name. `family-not-in-library`
 * is 47 of 47 NOT MEASURED rows today and all of them are G4M, but the other two
 * reasons — `no-file-for-instrument` and `instrument-not-in-library` — are the
 * same gap seen from the instrument side and they are 0 rows only because all 18
 * Bullet Bot files carry no instrument and stay candidates for every contract.
 * A family with instrumented files rolling onto a new contract lands there, and
 * hard-coding `G4M` would mean writing this module again when it does.
 *
 * Every row of the cohort, or none of it. A cohort where the library answers
 * some rows and not others has catalogued evidence available, and the catalogued
 * answer is the stronger one — it is not this module's business to supply a
 * weaker second opinion beside it. 0 mixed cohorts today: family attribution and
 * instrument root are both constant within a cohort by construction.
 */
function uncoveredCohorts(result) {
  const map = new Map();
  for (const row of result?.rows || []) {
    if (!row.bookFamily) continue;
    const key = cohortKey(row.bookFamily, instrumentGroupOf(row.instrument));
    if (!map.has(key)) {
      map.set(key, {
        key,
        family: row.bookFamily,
        instrument: instrumentGroupOf(row.instrument),
        instrumentCatalogued: Boolean(row.instrumentRoot),
        rows: 0,
        notMeasured: 0,
        reasons: new Set(),
      });
    }
    const entry = map.get(key);
    entry.rows += 1;
    if (row.classification === MATCH.NOT_MEASURED) {
      entry.notMeasured += 1;
      if (row.reason) entry.reasons.add(row.reason);
    }
  }
  return new Map([...map].filter(([, entry]) => entry.rows > 0 && entry.notMeasured === entry.rows));
}

/**
 * What every field in the cohort is set to, and on how many rows.
 *
 * The share of a whole configuration is one number; this is the other one a CAM
 * needs, because a cohort of 3 configurations can be 25 fields unanimous and 2
 * fields split — which is what G4M is — and "74% converge" alone reads as a
 * quarter of the book being unaccounted for.
 *
 * `null` is a value here: a configuration that does not carry a field at all is
 * different from one that carries it empty, and both occur across builds.
 */
function fieldDistribution(configs) {
  const maps = configs.map((config) => ({
    rows: config.count,
    parameters: configParametersOf(config.configKey),
  }));
  const names = new Set();
  for (const entry of maps) for (const name of Object.keys(entry.parameters)) names.add(name);

  return [...names].sort().map((name) => {
    const counts = new Map();
    for (const entry of maps) {
      const value = Object.prototype.hasOwnProperty.call(entry.parameters, name)
        ? entry.parameters[name]
        : null;
      counts.set(value, (counts.get(value) || 0) + entry.rows);
    }
    const values = [...counts]
      .map(([value, rows]) => ({ value, rows }))
      .sort((a, b) => b.rows - a.rows);
    return { name, values, unanimous: values.length === 1 };
  });
}

/**
 * Whether the cohort agrees on the fields the DESK says identify a version.
 *
 * setFileMatch.js's own VERSION_IDENTITY, not a rule invented here. It is what
 * separates NEAR from NONE for catalogued families, and it is the strongest
 * thing an observed reference can say about itself: a cohort unanimous on
 * ProfitTargetTicks1/2/3 and StopLossTicks is one version with settings adjusted,
 * however many configurations it splits into. G4M is unanimous on all four across
 * all 47 latest rows and all 254 rows ever imported.
 *
 * `unanimous: null` when the export carries none of those fields — never `false`,
 * which reads as "the cohort disagrees", and never `true`, which claims an
 * agreement nothing measured.
 */
function identityOf(fields, parameters) {
  const identity = fields.filter((field) => VERSION_IDENTITY.test(field.name));
  return {
    fields: identity.map((field) => field.name),
    unanimous: identity.length ? identity.every((field) => field.unanimous) : null,
    values: identity.length
      ? Object.fromEntries(identity.map((field) => [field.name, parameters[field.name] ?? null]))
      : null,
  };
}

/**
 * The fields the reference deliberately says nothing about.
 *
 * Named rather than merely omitted. Position sizing is the risk level and the
 * desk sets it per client — G4M runs `PosSize1=2, PosSize2=1, PosSize3=1` on 45
 * of 47 rows with two one-offs — so a reference that included it would report
 * two accounts as departing on a field the desk varies on purpose. A reader who
 * is not told which fields were held out cannot tell that from a clean bill.
 */
function excludedFieldsOf(configs) {
  const sizing = new Set();
  for (const config of configs) {
    const live = parseLiveParameters(config.sample);
    if (!live) continue;
    for (const name of Object.keys(live)) if (SIZING.test(name)) sizing.add(name);
  }
  return {
    sizing: [...sizing].sort(),
    // setFileNormalise's own list, not a copy of it. configKeyOf drops these by
    // name pattern and parseLiveParameters has already stripped them from the
    // sample, so nothing here can count them — which is exactly why a hardcoded
    // `['LicenseKey']` would go on printing that name after the desk's rule
    // stopped saying it. "Excluded" has to be a complete list to be worth
    // printing, so it is read from the one place that decides it.
    perClient: [...PER_CLIENT_FIELDS].sort(),
  };
}

/** One configuration under the reference: how many, who, and what differs. */
function describeConfiguration(key, dominant, config, cohortRows) {
  return {
    key,
    basis: BASIS,
    label: config.label,
    rows: config.count,
    tally: countAccounts(config.accounts),
    share: Math.round((config.count / cohortRows) * 100),
    // Drift-shaped `{name, from, to}`, so configDriftPresentation's
    // describeChangeRow / headlineFor / buildNoteFor render it with no adapter.
    changes: describeConfigDifference(dominant.configKey, config.configKey),
    accounts: config.accounts,
  };
}

/**
 * Whether today's majority has been the majority all along.
 *
 * The nearest thing available to a check on the reference itself. It cannot show
 * that the cohort matches what the desk decided — nothing in the book can — but
 * a configuration that has held the majority across every import is at least not
 * a change that happened last week, and one that appears in 6% of the history is
 * a cohort that has just moved.
 *
 * `rows` counts strategy rows across imports, so a client importing daily weighs
 * more than one who imported once: G4M's 47 latest rows are 254 rows of history
 * over the same ~46 accounts. A stability signal, not a population, and named so.
 */
function historyOf(cohort, referenceKey) {
  if (!cohort || !cohort.total) return null;
  const carrying = cohort.configs.find((config) => config.configKey === referenceKey);
  // The `0` cannot fire: `imports: 'all'` walks every import up to the bound and
  // `imports: 'latest'` walks the last one, so the history cohort is a superset
  // of the cohort the reference came from and always carries it. Kept because 0
  // is what the branch would MEAN if it ever did — "this configuration appears
  // in no import on record" — rather than a fallback to the cohort's own size,
  // which would report a change made this morning as a settled state.
  const rows = carrying ? carrying.count : 0;
  return {
    rows: cohort.total,
    distinctConfigurations: cohort.configs.length,
    referenceRows: rows,
    referenceShare: Math.round((rows / cohort.total) * 100),
    // False means the cohort's all-time majority is NOT what it runs today,
    // which is the one shape in this object that is worth interrupting a CAM for.
    referenceIsAllTimeMajority: cohort.configs[0]?.configKey === referenceKey,
  };
}

function describeCohort(cohort, covered, history, guards) {
  const { minCohort, outlierShare, minDominantShare } = guards;
  const configs = cohort.configs;
  const rows = cohort.total;
  const everyAccount = configs.flatMap((config) => config.accounts);
  const tally = countAccounts(everyAccount);

  const base = {
    key: cohort.key,
    basis: BASIS,
    family: cohort.family,
    instrument: cohort.instrument,
    // False means the library holds no template for this symbol either, so the
    // cohort's contract is a second gap on top of the family's.
    instrumentCatalogued: covered.instrumentCatalogued,
    whyUncovered: [...covered.reasons].sort(),
    rows,
    accounts: tally.accounts,
    unnamedRows: tally.unnamedRows,
    clients: new Set(everyAccount.map((account) => account.clientId)).size,
    // Rows whose export nobody could parse. Not folded into the cohort and not
    // silently dropped: they are outside every share below, and a reader has to
    // be able to see that the denominator is smaller than the family's row count.
    unreadableRows: cohort.unreadable,
    distinctConfigurations: configs.length,
    configurationRows: configs.map((config) => config.count),
    status: null,
    reason: null,
    reference: null,
    /** Configurations too big to be departures — the cohort is split. */
    variants: [],
    /** Configurations small enough to be worth a look. Never called errors. */
    outliers: [],
    history: null,
  };

  if (!configs.length) {
    return { ...base, status: REFERENCE.NOTHING_READABLE, reason: 'no-readable-parameters' };
  }

  const dominant = configs[0];
  const largest = {
    label: dominant.label,
    rows: dominant.count,
    share: Math.round((dominant.count / rows) * 100),
  };

  if (rows < minCohort) {
    // Not "nothing to report". A cohort of five split three and two has a
    // majority in the arithmetic and no norm in the world, and stating the three
    // as a reference would let two accounts be listed against a standard that is
    // one client's preference.
    return {
      ...base, status: REFERENCE.COHORT_TOO_SMALL, reason: `fewer-than-${minCohort}-rows`, largest,
    };
  }

  if (dominant.count / rows < minDominantShare) {
    // The case the whole module has to get right, and it reaches 0 of the 1
    // cohort in scope today — G4M is the least fragmented family on the book.
    // The shape is real all the same, from a catalogued cohort: Bullet Bot's NQ
    // 134 rows hold 16 configurations whose biggest is 50, a 37% plurality. A
    // reference built from those 50 rows would list the other 84 accounts as
    // departing from a configuration five sixths of the cohort does not run.
    // Covered by fixture rather than by the book, because a branch that only
    // fires on data nobody has yet is a branch nothing checks.
    return { ...base, status: REFERENCE.NO_MAJORITY, reason: `largest-below-${minDominantShare}`, largest };
  }

  const parameters = configParametersOf(dominant.configKey);
  const fields = fieldDistribution(configs);
  const rest = configs.slice(1)
    .map((config, index) => describeConfiguration(
      `${cohort.key}${FIELD}${index + 1}`, dominant, config, rows,
    ));

  return {
    ...base,
    status: REFERENCE.OBSERVED,
    reason: null,
    largest,
    reference: {
      basis: BASIS,
      label: dominant.label,
      parameters,
      // Two counts, because they are two different numbers and printing one of
      // them under the other's name is how a panel contradicts itself on one
      // screen. `fieldCount` is what the reference itself states;
      // `comparedFieldCount` is the union across every configuration in the
      // cohort, which is what `fields`, `unanimousFields` and `varyingFields`
      // are computed over.
      //
      // They are equal on G4M (27 and 27) and they are NOT equal on 7 of the 15
      // cohorts on this book whose configurations differ in shape: DJDR YM SEP26
      // and SYFY MES SEP26 hold 26 fields on the dominant configuration and 33
      // in the union, IFSP-PF NG SEP26 holds 33 and 36. Using `fieldCount` as
      // the denominator there printed "4 of the 4 compared settings are
      // identical on every row and 3 vary" — a sentence whose two halves do not
      // add up to its own total — above a table of 7 rows headed "4 settings".
      fieldCount: Object.keys(parameters).length,
      comparedFieldCount: fields.length,
      // The evidence, in the three numbers a reader needs to weigh it: how many
      // converge, what share that is, and how many configurations exist. The
      // third is what stops the first two reading as a verdict — 35 of 47 at 74%
      // means something different across 3 configurations than across 16.
      rows: dominant.count,
      tally: countAccounts(dominant.accounts),
      share: Math.round((dominant.count / rows) * 100),
      accounts: dominant.accounts,
      fields,
      unanimousFields: fields.filter((field) => field.unanimous).map((field) => field.name),
      varyingFields: fields.filter((field) => !field.unanimous),
      identity: identityOf(fields, parameters),
      excluded: excludedFieldsOf(configs),
    },
    // Above the outlier share is a second version, not a departure. G4M's 11
    // accounts flattening at 16:30 instead of 16:45 are 23% of the cohort, and
    // `Close all open trades → 16:30` is already the single most recurring change
    // on the whole book — 14 of 29 drift groups, 44 accounts, 7 of 10 algorithms.
    // Listing them as deviations would put the desk's own decision on a review
    // list eleven times.
    variants: rest.filter((config) => config.rows / rows > outlierShare),
    outliers: rest.filter((config) => config.rows / rows <= outlierShare),
    history: historyOf(history, dominant.configKey),
  };
}

/**
 * Observed references for every cohort the set-file library cannot measure.
 *
 * `match` is the already-built set-file result when the caller has one — the
 * panel does — so the two sections of that panel are gated on literally the same
 * classifications rather than on two computations that could disagree.
 *
 * The guards are buildConfigDrift's, at its values, on purpose: a second panel
 * flagging accounts the drift panel does not would be two desks' worth of
 * standards on one screen. They are declared in the result so a reader can see
 * what a cohort was measured against.
 */
export function buildSynthesizedReference(clients = [], {
  asOfDate = '',
  minCohort = 8,
  outlierShare = 0.15,
  minDominantShare = 0.4,
  match = null,
} = {}) {
  const bound = String(asOfDate || '').slice(0, 10);
  const result = match || buildSetFileMatch(clients, { asOfDate: bound });
  const uncovered = uncoveredCohorts(result);

  const latest = buildConfigCohorts(clients, { asOfDate: bound, imports: 'latest', ...READING });
  const history = new Map(
    buildConfigCohorts(clients, { asOfDate: bound, imports: 'all', ...READING })
      .map((cohort) => [cohort.key, cohort]),
  );

  const guards = { minCohort, outlierShare, minDominantShare };
  const cohorts = latest
    .filter((cohort) => uncovered.has(cohort.key))
    .map((cohort) => describeCohort(cohort, uncovered.get(cohort.key), history.get(cohort.key), guards))
    .sort((a, b) => b.rows - a.rows || a.family.localeCompare(b.family));

  const referenced = cohorts.filter((cohort) => cohort.status === REFERENCE.OBSERVED);
  return {
    asOfDate: bound || null,
    basis: BASIS,
    guards,
    cohorts,
    totals: {
      cohorts: cohorts.length,
      // A cohort with a reference and a cohort without are both reported. The
      // second number is the one a panel is tempted to drop, and dropping it is
      // how "we could not establish a norm here" turns into "nothing found here".
      withReference: referenced.length,
      withoutReference: cohorts.length - referenced.length,
      rows: cohorts.reduce((sum, cohort) => sum + cohort.rows, 0),
      accounts: cohorts.reduce((sum, cohort) => sum + cohort.accounts, 0),
      // Minority configurations across every cohort that has a reference. Never
      // called errors, and never summed with the variants: those are a cohort
      // being split, which is a different question.
      //
      // Rows AND accounts, both named, because they are not the same number and
      // this panel has been bitten by the difference before: one drift group on
      // this book is 5 strategy rows over 4 accounts (`Avery Frost ·
      // BDG9159854231060` exports twice with byte-identical parameters). A head
      // reading "5 to verify" over chips reading "4 accounts" is the same defect
      // as the stat that read 1900 against a header that read 253. G4M's outlier
      // is 1 and 1 today, so nothing on the current book would reveal it.
      toVerifyRows: referenced.reduce(
        (sum, cohort) => sum + cohort.outliers.reduce((n, config) => n + config.rows, 0), 0,
      ),
      toVerifyAccounts: referenced.reduce(
        (sum, cohort) => sum + cohort.outliers.reduce((n, config) => n + config.tally.total, 0), 0,
      ),
      variantRows: referenced.reduce(
        (sum, cohort) => sum + cohort.variants.reduce((n, config) => n + config.rows, 0), 0,
      ),
      variantAccounts: referenced.reduce(
        (sum, cohort) => sum + cohort.variants.reduce((n, config) => n + config.tally.total, 0), 0,
      ),
    },
  };
}
