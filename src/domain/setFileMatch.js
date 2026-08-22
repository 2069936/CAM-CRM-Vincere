// Names the catalogued version each account is running, and — the point —
// surfaces the accounts running no catalogued version at all.
//
// The drift panel compares accounts to each other, so the only question it can
// answer is "who is the odd one out". It has never seen a legitimate
// configuration, only a popular one. The 911 set files are the desk's source of
// truth, and setFileCatalog.js holds them: matching the book against them turns
// "this account is unusual" into "this account runs URGO (MNQ) 15 Min Candle,
// Low Risk, v1" or into "nothing in the library carries these profit targets".
//
// This is a VERIFY list, never an error list. The desk customises clients on
// purpose — 188 of the 619 latest strategy rows on the real book sit on a
// catalogued version with one or two management settings changed, and most of
// that is deliberate. Wording that implies fault trains a CAM to dismiss the
// panel, which is worse than not having one.
//
// Three things this file will not do:
//   - claim a match it cannot measure. Every match carries the size of the field
//     intersection it was decided on. 11 of 31 is not the claim 31 of 31 is.
//   - pick one of several equally good answers. That is AMBIGUOUS, and it names
//     all of them plus the fields that would separate them.
//   - call an unmeasurable account uncatalogued. A family with no folder in the
//     library is NOT MEASURED — 47 G4M rows on this book — and an export too
//     thin to compare is UNDETERMINED. Neither is "runs no catalogued version".
//
// Pure: state in, plain data out. Nothing here reads a clock or touches I/O.

import {
  catalogInstrumentOf,
  getSetFileCatalog,
  normaliseLiveParameters,
  resolveCatalogFamily,
  setFilesForFamily,
  sharedParameterNames,
} from './setFileCatalog';
import { FIELD, SIZING } from './setFileNormalise';
import { strategyFamilyOf } from './strategyFamily';

/* ── Classes ──────────────────────────────────────────────────────────────── */

export const MATCH = Object.freeze({
  /** Every shared field agrees with exactly one catalogued configuration. */
  EXACT: 'EXACT',
  /** More than one catalogued version fits equally well. Not a failure. */
  AMBIGUOUS: 'AMBIGUOUS',
  /** On a catalogued version's targets and stop, with other settings changed. */
  NEAR: 'NEAR',
  /** No catalogued version carries this account's targets and stop. */
  NONE: 'NONE',
  /** Too few shared fields to make any claim. Distinct from NONE. */
  UNDETERMINED: 'UNDETERMINED',
  /** The library holds nothing to compare against. Distinct from NONE. */
  NOT_MEASURED: 'NOT_MEASURED',
});

/**
 * The fields the desk states are the version's identity.
 *
 * Established on this book, not derived here: ProfitTargetTicks1/2/3 and
 * StopLossTicks identify the version, PosSize1/2/3 is the risk level. The
 * un-numbered `ProfitTargetTicks` is Bullet Bot's spelling — its 18 files carry
 * one target rather than three scale-out legs, and 20 of the book's 138 Bullet
 * Bot rows differ from their closest file in that one field alone.
 *
 * This is what separates NEAR from NONE. An account whose targets and stop match
 * a catalogued file IS on that version, whatever else was adjusted; an account
 * whose targets no file carries is not on any version, however many session
 * times happen to agree. A plain "fewer than N fields differ" rule cannot tell
 * those apart: on the real book it would have called `PT 200/400/500` against a
 * catalogued `PT 40/50/70` a near miss because the other 28 fields agreed.
 */
export const VERSION_IDENTITY = /^(ProfitTargetTicks\d*|StopLossTicks)$/;

/* ── Candidate selection ──────────────────────────────────────────────────── */

/**
 * The set files an account could possibly be running.
 *
 * Restricted to the family's own folder, which is what makes a `_PF` answer
 * meaningful: every one of the 107 prop-firm variants is parameter-identical to
 * its twin, so the parameters cannot tell `PLPI v1 Low` from `PLPI_PF v1 Low`.
 * The strategy's own family attribution can, and it is the only thing that can.
 *
 * Files with no instrument in the catalog are always candidates. All 18 Bullet
 * Bot files are in that state — they follow a different naming scheme with no
 * symbol at all — and so is MotusTemplar/Default.xml, and dropping them would
 * leave 138 rows of this book with nothing to compare against.
 */
function candidateEntries(catalogFamily, instrumentRoot) {
  const files = setFilesForFamily(catalogFamily);
  if (!files.length) return [];
  return files.filter((entry) => entry.instrument === null
    || (instrumentRoot !== null && entry.instrument === instrumentRoot));
}

/**
 * Candidates collapsed to distinct parameter sets.
 *
 * 911 files hold 190 distinct configurations — every one of them carried by
 * between 2 and 12 files — because Periods 0/1/2 are byte-identical (all 292
 * named variants measured) and so are the `_PF` twins. Comparing per file would
 * report the same answer up to six times and would invite the panel to print one
 * filename as though the period were determined. It is not.
 */
function groupByConfiguration(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.configHash)) {
      groups.set(entry.configHash, {
        configHash: entry.configHash,
        versionHash: entry.versionHash,
        entry,
        files: [],
      });
    }
    groups.get(entry.configHash).files.push(entry);
  }
  return [...groups.values()];
}

/* ── Comparison ───────────────────────────────────────────────────────────── */

function compare(live, group) {
  const { shared, liveOnly, catalogOnly } = sharedParameterNames(live, group.entry);
  const differences = [];
  let identityCompared = 0;
  let identityDiffs = 0;
  let sizingDiffs = 0;
  let otherDiffs = 0;

  for (const name of shared) {
    const identity = VERSION_IDENTITY.test(name);
    if (identity) identityCompared += 1;
    const catalogValue = group.entry.parameters[name];
    const liveValue = live[name];
    if (catalogValue === liveValue) continue;
    const sizing = SIZING.test(name);
    if (identity) identityDiffs += 1;
    else if (sizing) sizingDiffs += 1;
    else otherDiffs += 1;
    differences.push({ name, catalogValue, liveValue, identity, sizing });
  }

  return {
    group,
    comparedFields: shared.length,
    identityCompared,
    identityDiffs,
    sizingDiffs,
    otherDiffs,
    differences,
    liveOnly,
    catalogOnly,
  };
}

/**
 * Closest first: version identity, then everything else, then sizing, then the
 * candidate that could be compared on more fields.
 *
 * Identity leads because it is the desk's own definition of a version. Sizing
 * comes after the rest because two accounts differing only in PosSize are the
 * same version at different risk — of 127 config-and-risk combinations on the
 * real book, 17 differed by sizing alone.
 */
function byCloseness(a, b) {
  return a.identityDiffs - b.identityDiffs
    || a.otherDiffs - b.otherDiffs
    || a.sizingDiffs - b.sizingDiffs
    || b.comparedFields - a.comparedFields;
}

const sameCloseness = (a, b) => a.identityDiffs === b.identityDiffs
  && a.otherDiffs === b.otherDiffs
  && a.sizingDiffs === b.sizingDiffs
  && a.comparedFields === b.comparedFields;

/* ── Naming a matched configuration ───────────────────────────────────────── */

const RISK_ORDER = { Low: 0, Medium: 1, High: 2 };

/**
 * What a matched parameter set is called, without overstating which file it is.
 *
 * A parameter match names a configuration, never a single file: the periods are
 * identical, so `Period 0` is not a finding, it is one of three filenames for
 * the same settings. The variants are listed and the periods are listed beside
 * them; a caller that prints one filename as the answer is claiming a precision
 * the library does not have.
 *
 * `risk` and `version` are null when the files carrying this configuration do
 * not agree on one — null, never a pick. The 17 `Default.xml` templates carry no
 * risk and no version in their filenames at all, so a configuration reachable
 * only through a Default has risk null for a real reason.
 */
function describeMatch(result) {
  const { group } = result;
  const variants = new Map();
  for (const file of group.files) {
    const key = [file.family, file.instrument, file.timeframe, file.risk, file.version, file.versionNote]
      .map((part) => (part === null || part === undefined ? '' : String(part)))
      .join(FIELD);
    if (!variants.has(key)) {
      variants.set(key, {
        family: file.family,
        instrument: file.instrument,
        timeframe: file.timeframe,
        risk: file.risk,
        version: file.version,
        versionNote: file.versionNote,
        isDefaultTemplate: file.isDefaultTemplate,
        strategyLabel: file.strategyLabel,
        periods: [],
        files: [],
      });
    }
    const variant = variants.get(key);
    if (file.period !== null && !variant.periods.includes(file.period)) variant.periods.push(file.period);
    variant.files.push(file.file);
  }

  const list = [...variants.values()].sort((a, b) => (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9)
    || (a.version ?? 0) - (b.version ?? 0));
  for (const variant of list) {
    variant.periods.sort((a, b) => a - b);
    variant.files.sort();
  }

  for (const variant of list) variant.label = variantLabel(variant);

  // Named variants only. A `Default.xml` carries no risk and no version in its
  // filename, and 16 of the 17 were measured byte-identical to their family's
  // Low Risk v1 — so a configuration reachable through both is Low Risk v1 that
  // is ALSO shipped as the family default, not a configuration with no risk
  // level. Counting the Default's nulls as disagreement would erase the name.
  const named = list.filter((variant) => variant.risk !== null || variant.version !== null);
  const risks = new Set(named.map((variant) => variant.risk));
  const versions = new Set(named.map((variant) => variant.version));

  return {
    configHash: group.configHash,
    versionHash: group.versionHash,
    family: list[0].family,
    instrument: list[0].instrument,
    timeframe: list[0].timeframe,
    // Null when the named files disagree — a configuration carried by two named
    // variants has no single risk level, and picking one would invent it.
    risk: risks.size === 1 ? [...risks][0] : null,
    version: versions.size === 1 ? [...versions][0] : null,
    versionNote: list[0].versionNote,
    label: labelOf(list),
    variants: list,
    // The library also ships this exact configuration as the family default.
    alsoDefaultTemplate: list.some((variant) => variant.isDefaultTemplate) && named.length > 0,
    periods: [...new Set(list.flatMap((variant) => variant.periods))].sort((a, b) => a - b),
    fileCount: group.files.length,
    // How many comparable parameters the FILE carries, against how many of them
    // the live export actually shares. Files carry between 19 and 50.
    parameterCount: group.entry.parameterCount,
    comparedFields: result.comparedFields,
  };
}

/**
 * A file's own name, without the folder, the extension or the period.
 *
 * The period is dropped because the three period files of a variant are
 * byte-identical (292 of 292 variants measured), so printing `- Period 0` names
 * one of three interchangeable files as though the choice meant something.
 */
function fileLabel(path) {
  return String(path || '')
    .replace(/^.*\//, '')
    .replace(/\.xml$/i, '')
    .replace(/\s*-\s*Period\s*\d+$/i, '')
    .trim();
}

/**
 * What one named variant is called.
 *
 * 35 of the 911 filenames do not follow the desk's `{n} - {FAMILY} ({INSTRUMENT})
 * - {timeframe} - {Risk} Risk - v{N} - Period {P}` shape: 18 Bullet Bot files on
 * an entirely different scheme and 17 `Default.xml`. Built from the parsed
 * fields, those come out as the bare word `BulletBot` — the same label for six
 * different trading plans, which is worse than no label. They fall back to the
 * filename, which is the only name they have and is a reading, not a guess.
 */
function variantLabel(variant) {
  const parts = [variant.family];
  if (variant.instrument) parts.push(`(${variant.instrument})`);
  if (variant.timeframe) parts.push(`· ${variant.timeframe}`);
  if (variant.risk) parts.push(`· ${variant.risk} Risk`);
  if (variant.version !== null) parts.push(`· v${variant.version}`);
  if (variant.versionNote) parts.push(`(${variant.versionNote})`);
  if (variant.risk === null && variant.version === null) {
    return variant.isDefaultTemplate
      ? `${parts.join(' ')} · Default template`
      : fileLabel(variant.files[0]);
  }
  return parts.join(' ');
}

/**
 * The configuration's name. Every named variant carrying it, not just the first
 * — two names for one parameter set is a fact about the library.
 */
function labelOf(variants) {
  const named = variants.filter((variant) => variant.risk !== null || variant.version !== null);
  const list = named.length ? named : variants;
  return list.map((variant) => variant.label).join('  ·  ');
}

/**
 * Which fields would tell two equally good matches apart.
 *
 * Named, because "ambiguous" without them is not actionable. A field the live
 * export does not carry is the usual answer — that is exactly why the two
 * versions could not be separated — and it is flagged, because the fix differs:
 * a field outside the export needs a wider export, a field inside it needs a
 * human to read the two values.
 */
function separatingFields(results, live) {
  const names = new Set();
  for (const result of results) for (const name of result.group.entry.parameterNames) names.add(name);

  const fields = [];
  for (const name of [...names].sort()) {
    const values = results.map((result) => {
      const parameters = result.group.entry.parameters;
      // null is "this configuration does not carry the field at all", which is
      // itself a difference — the files carry between 19 and 50 parameters.
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : null;
    });
    if (new Set(values).size < 2) continue;
    const inLiveExport = Object.prototype.hasOwnProperty.call(live || {}, name);
    fields.push({
      name,
      values,
      inLiveExport,
      liveValue: inLiveExport ? live[name] : null,
    });
  }
  return fields;
}

/* ── Naming a row's family and contract ───────────────────────────────────── */

/**
 * What family the BOOK says this row is.
 *
 * The import's own attribution first, the strategy name second. The snapshot
 * column says `OGX_PF`; strategyFamilyOf reads `0 - OGX-PF-2.4` as `OGX-PF`.
 * Both resolve, but the column is what the importer decided and the name is a
 * reconstruction of it.
 *
 * Exported because a second module grouping the same rows must group them the
 * same way. It did not, and the two panels then spelled five families two ways —
 * `IFSP_PF` here against `IFSP-PF` there — for the same accounts.
 */
export function bookFamilyOf(strategy) {
  return String(strategy?.strategyFamily || '').trim()
    || strategyFamilyOf(strategy?.strategyName) || '';
}

/**
 * The contract a row is grouped under: the catalogued root when the library has
 * one, the leading symbol otherwise.
 *
 * The fallback is a display grouping only — `NQ SEP26` is the full-size contract
 * Bullet Bot runs and the library holds no full-size template, which is a fact
 * about the library, not about NQ. Callers that need to know the difference read
 * `catalogInstrumentOf` directly.
 *
 * One root, not three strings: G4M runs `MES SEP26` (43 rows), `MES 09-26` (3)
 * and `MESU6` (1), and all three are MES.
 */
export function instrumentGroupOf(instrument) {
  return catalogInstrumentOf(instrument) || leadingSymbol(instrument) || '(none)';
}

/* ── One strategy row ─────────────────────────────────────────────────────── */

/**
 * Classifies one strategy row against the catalog.
 *
 * The order of the refusals matters. "No folder for this family" (47 G4M rows),
 * "no file for this instrument", "nothing readable in the export" and "too few
 * shared fields" are four different answers, and every one of them is a
 * different sentence to a CAM. Collapsing any of them into "runs no catalogued
 * version" would be the panel asserting something it did not measure.
 */
export function matchStrategyRow(strategy, { minSharedFields = 8, nearMaxFields = 4 } = {}) {
  const bookFamily = bookFamilyOf(strategy);
  const instrument = String(strategy?.instrument || '').trim();
  const catalogFamily = resolveCatalogFamily(bookFamily);
  const instrumentRoot = catalogInstrumentOf(instrument);

  const base = {
    bookFamily: bookFamily || null,
    catalogFamily,
    instrument: instrument || null,
    instrumentRoot,
    classification: MATCH.NOT_MEASURED,
    reason: null,
    match: null,
    matches: [],
    differences: [],
    separating: [],
    comparedFields: null,
    identityCompared: null,
    liveFieldCount: null,
    liveOnly: [],
    catalogOnly: [],
    candidateConfigurations: 0,
    candidateFiles: 0,
  };

  if (!catalogFamily) {
    // Not "uncatalogued" — unmeasurable. G4M runs 47 of this book's latest rows
    // and has no folder in the library at all.
    return { ...base, reason: bookFamily ? 'family-not-in-library' : 'no-family-on-row' };
  }

  const live = normaliseLiveParameters(strategy?.parametersRaw);
  if (!live) {
    // Nothing readable. 0 of 619 latest rows on this book, so this is a guard
    // rather than a routine path — but an unreadable export is not evidence of
    // anything, least of all of running an uncatalogued version.
    return { ...base, classification: MATCH.UNDETERMINED, reason: 'no-readable-parameters' };
  }
  const liveFieldCount = Object.keys(live).length;

  const entries = candidateEntries(catalogFamily, instrumentRoot);
  if (!entries.length) {
    return {
      ...base,
      liveFieldCount,
      reason: instrumentRoot ? 'no-file-for-instrument' : 'instrument-not-in-library',
    };
  }

  const results = groupByConfiguration(entries).map((group) => compare(live, group));
  const comparable = results.filter((result) => result.comparedFields >= minSharedFields);
  const widest = results.reduce((best, result) => (result.comparedFields > best.comparedFields ? result : best), results[0]);

  if (!comparable.length) {
    // "Not enough shared fields to tell" is not "no catalogued version matches".
    // 0 of 619 rows on this book — the thinnest real intersection is 11 fields,
    // on Bullet Bot — so this guard is for a future export, not for today's.
    return {
      ...base,
      classification: MATCH.UNDETERMINED,
      reason: 'too-few-shared-fields',
      liveFieldCount,
      comparedFields: widest.comparedFields,
      identityCompared: widest.identityCompared,
      liveOnly: widest.liveOnly,
      catalogOnly: widest.catalogOnly,
      candidateConfigurations: results.length,
      candidateFiles: entries.length,
    };
  }

  const ranked = comparable.slice().sort(byCloseness);
  const best = ranked[0];
  const shape = {
    ...base,
    liveFieldCount,
    comparedFields: best.comparedFields,
    identityCompared: best.identityCompared,
    liveOnly: best.liveOnly,
    catalogOnly: best.catalogOnly,
    candidateConfigurations: results.length,
    candidateFiles: entries.length,
  };

  const perfect = ranked.filter((result) => result.differences.length === 0);
  if (perfect.length) {
    const versions = new Set(perfect.map((result) => result.group.versionHash));
    const configurations = new Set(perfect.map((result) => result.group.configHash));
    if (configurations.size > 1) {
      // Several catalogued configurations agree on every field this export
      // carries. Naming one would be a coin toss presented as an answer.
      return {
        ...shape,
        classification: MATCH.AMBIGUOUS,
        matches: perfect.map(describeMatch),
        separating: separatingFields(perfect, live),
        // Two configurations at one version identity differ only in sizing, so
        // the version is known and the risk level is not. That is a materially
        // smaller ambiguity and the caller has to be able to say which it is.
        ambiguity: versions.size === 1 ? 'risk-level' : 'version',
      };
    }
    return { ...shape, classification: MATCH.EXACT, match: describeMatch(perfect[0]), matches: [describeMatch(perfect[0])] };
  }

  const tied = ranked.filter((result) => sameCloseness(result, best));
  // Version identity decides NEAR against NONE. When the export carries none of
  // the identity fields the rule has nothing to stand on, so it falls back to a
  // field count — declared, because a count is a much weaker claim.
  const onVersion = best.identityCompared > 0
    ? best.identityDiffs === 0
    : best.differences.length <= nearMaxFields;

  return {
    ...shape,
    classification: onVersion ? MATCH.NEAR : MATCH.NONE,
    // `match` is the closest catalogued configuration in both cases. For NONE it
    // is not a claim about what the account runs — it is the nearest thing in
    // the library, so a CAM can see how far off the book this configuration is.
    match: describeMatch(best),
    matches: tied.map(describeMatch),
    differences: best.differences,
    separating: tied.length > 1 ? separatingFields(tied, live) : [],
    identityConfirmed: best.identityCompared > 0 && best.identityDiffs === 0,
    // Every difference is sizing: the account is on this version at a position
    // size the library does not carry. 0 of 619 rows today; kept because the
    // desk sizes clients individually and this is the shape that produces.
    sizingOnly: best.differences.length > 0 && best.differences.every((difference) => difference.sizing),
  };
}

/* ── The book ─────────────────────────────────────────────────────────────── */

function latestImport(client, bound) {
  const imports = (client?.dailyImports || [])
    .filter((entry) => entry?.date && (!bound || String(entry.date).slice(0, 10) <= bound))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return imports[imports.length - 1] || null;
}

function emptyTally() {
  return {
    rows: 0,
    [MATCH.EXACT]: 0,
    [MATCH.AMBIGUOUS]: 0,
    [MATCH.NEAR]: 0,
    [MATCH.NONE]: 0,
    [MATCH.UNDETERMINED]: 0,
    [MATCH.NOT_MEASURED]: 0,
    accounts: new Set(),
    clients: new Set(),
    unnamedRows: 0,
    comparedFields: [],
  };
}

function record(tally, row) {
  tally.rows += 1;
  tally[row.classification] += 1;
  tally.clients.add(row.clientId);
  if (row.accountName) tally.accounts.add(`${row.clientId}${FIELD}${row.accountName}`);
  // A row with no trading account on the import cannot be resolved to an
  // account. Counted, never folded in: two unidentifiable rows are not one
  // account and they are not two either.
  else tally.unnamedRows += 1;
  if (row.comparedFields !== null) tally.comparedFields.push(row.comparedFields);
}

function finishTally(tally, extra = {}) {
  const measured = tally.rows - tally[MATCH.NOT_MEASURED];
  const compared = tally.comparedFields;
  return {
    rows: tally.rows,
    accounts: tally.accounts.size,
    unnamedRows: tally.unnamedRows,
    clients: tally.clients.size,
    exact: tally[MATCH.EXACT],
    ambiguous: tally[MATCH.AMBIGUOUS],
    near: tally[MATCH.NEAR],
    none: tally[MATCH.NONE],
    undetermined: tally[MATCH.UNDETERMINED],
    notMeasured: tally[MATCH.NOT_MEASURED],
    // The denominator for every "N of M" a manager reads. Rows the library
    // cannot speak to are not in it — reporting 312 of 619 when 47 of those 619
    // have no library family at all is a worse number than reporting 312 of 572.
    measuredRows: measured,
    // On a catalogued version, exactly or with settings adjusted. AMBIGUOUS rows
    // are on one of several catalogued versions, so they are on a version too —
    // counted here, and named separately so nobody reads them as decided.
    onCatalogedVersion: tally[MATCH.EXACT] + tally[MATCH.AMBIGUOUS]
      + (extra.nearOnVersion ?? tally[MATCH.NEAR]),
    // The honest denominator of every match claim in this group.
    fieldsCompared: compared.length
      ? { min: Math.min(...compared), max: Math.max(...compared), median: median(compared) }
      : null,
  };
}

/**
 * Numeric order when every value is a number, text order otherwise.
 *
 * A plain sort renders eight Bullet Bot targets as `110, 125, 140, 30, 60, 70,
 * 82, 90` — a list of ticks in dictionary order, which reads as noise.
 */
function sortValues(values) {
  const numeric = values.every((value) => /^-?\d+(?:\.\d+)?$/.test(String(value)));
  return values.slice().sort((a, b) => (numeric
    ? Number(a) - Number(b)
    : String(a).localeCompare(String(b))));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The difference the whole family shares, if there is one.
 *
 * This is the finding a per-account list cannot show. On the real book 43 of the
 * 54 RBO rows differ from their closest file in exactly `BreakEvenOffset` and
 * `EntryOrderTickOffset`, and 35 of 37 ARPD rows in exactly `BreakEvenOffset`
 * and `CloseAllOpenTradeTime`. Forty-three accounts customised the same two
 * settings the same way is not forty-three customisations — it is one question
 * about whether the library is behind the book, and it should be asked once.
 *
 * Declines below 3 rows or half the family's differing rows: a coincidence
 * stated as a pattern is worse than saying nothing.
 */
function recurringDifferenceOf(rows) {
  const differing = rows.filter((row) => row.differences.length);
  if (differing.length < 3) return null;

  const counts = new Map();
  for (const row of differing) {
    // Joined with FIELD, never '/'. Values here include `1/1/2020 4:45:00 PM`,
    // and a '/' split has silently produced a wrong answer three times here.
    const key = row.differences.map((difference) => difference.name).sort().join(FIELD);
    if (!counts.has(key)) {
      counts.set(key, {
        names: row.differences.map((difference) => difference.name).sort(),
        rows: 0,
        values: new Map(),
      });
    }
    const entry = counts.get(key);
    entry.rows += 1;
    for (const difference of row.differences) {
      if (!entry.values.has(difference.name)) {
        entry.values.set(difference.name, { catalogValues: new Set(), liveValues: new Set() });
      }
      const field = entry.values.get(difference.name);
      field.catalogValues.add(difference.catalogValue);
      field.liveValues.add(difference.liveValue);
    }
  }
  const top = [...counts.values()].sort((a, b) => b.rows - a.rows)[0];
  if (top.rows < 3 || top.rows / differing.length < 0.5) return null;

  const changes = top.names.map((name) => {
    const field = top.values.get(name);
    return {
      name,
      catalogValues: sortValues([...field.catalogValues]),
      liveValues: sortValues([...field.liveValues]),
    };
  });
  return {
    names: top.names,
    rows: top.rows,
    ofDiffering: differing.length,
    changes,
    // Whether "the same setting" also means "to the same value". It does for
    // RBO (43 rows, BreakEvenOffset 50 → 25 on every one) and it does NOT for
    // Bullet Bot, where 20 rows differ in ProfitTargetTicks and run eight
    // different targets between them — 110, 70, 125, 60, 30, 90, 140, 82.
    // Rendering one row's values as the group's would have shown nine of those
    // twenty accounts a number they do not run.
    sameValues: changes.every((change) => change.catalogValues.length === 1
      && change.liveValues.length === 1),
  };
}

/**
 * Every account's latest strategy row, classified, plus the roll-ups a manager
 * reads instead of the rows.
 *
 * `minSharedFields` is the floor under any claim. 8 is a judgement, and it is
 * declared: on this book the thinnest real intersection is 11 fields, so nothing
 * is currently filtered by it. `nearMaxFields` only applies when the export
 * carries no profit target and no stop, which happens on 0 of 619 rows.
 */
export function buildSetFileMatch(clients = [], {
  asOfDate = '',
  minSharedFields = 8,
  nearMaxFields = 4,
} = {}) {
  const bound = String(asOfDate || '').slice(0, 10);
  const rows = [];

  for (const client of clients || []) {
    const latest = latestImport(client, bound);
    if (!latest) continue;
    for (const strategy of latest.strategies || []) {
      const match = matchStrategyRow(strategy, { minSharedFields, nearMaxFields });
      rows.push({
        key: [client.id, strategy.accountName || '', strategy.strategyName || '', strategy.instrument || '', rows.length].join(FIELD),
        clientId: client.id,
        clientName: client.name || client.id,
        accountName: strategy.accountName || '',
        strategyName: strategy.strategyName || '',
        importDate: latest.date || null,
        ...match,
      });
    }
  }

  const families = new Map();
  const instruments = new Map();
  const total = emptyTally();
  let nearOnVersion = 0;

  for (const row of rows) {
    record(total, row);
    if (row.classification === MATCH.NEAR && row.identityConfirmed) nearOnVersion += 1;

    const familyKey = row.bookFamily || '(no family on row)';
    if (!families.has(familyKey)) {
      families.set(familyKey, {
        family: familyKey,
        catalogFamily: row.catalogFamily,
        tally: emptyTally(),
        rows: [],
        nearOnVersion: 0,
      });
    }
    const family = families.get(familyKey);
    record(family.tally, row);
    family.rows.push(row);
    if (row.classification === MATCH.NEAR && row.identityConfirmed) family.nearOnVersion += 1;

    const instrumentKey = instrumentGroupOf(row.instrument);
    if (!instruments.has(instrumentKey)) {
      instruments.set(instrumentKey, {
        instrument: instrumentKey,
        catalogued: Boolean(row.instrumentRoot),
        tally: emptyTally(),
        nearOnVersion: 0,
      });
    }
    const instrument = instruments.get(instrumentKey);
    record(instrument.tally, row);
    if (row.classification === MATCH.NEAR && row.identityConfirmed) instrument.nearOnVersion += 1;
  }

  const familyRows = [...families.values()].map((family) => ({
    family: family.family,
    catalogFamily: family.catalogFamily,
    // A family with no folder in the library is NOT MEASURED. Its accounts are
    // not uncatalogued, and a roll-up that shows them as "0 of 47 on a
    // catalogued version" says the opposite of what was measured.
    measured: Boolean(family.catalogFamily),
    ...finishTally(family.tally, { nearOnVersion: family.nearOnVersion }),
    recurring: recurringDifferenceOf(family.rows),
    // `rows` is a COUNT everywhere in this result — finishTally sets it — so the
    // per-row matches get their own name. Spreading the tally and then assigning
    // the array over `rows` silently turned a number into an array, and the
    // panel's roll-up printed `137 ([object Object],[object Object]...)`.
    strategyRows: family.rows,
  })).sort((a, b) => b.rows - a.rows || a.family.localeCompare(b.family));

  const instrumentRows = [...instruments.values()].map((instrument) => ({
    instrument: instrument.instrument,
    catalogued: instrument.catalogued,
    ...finishTally(instrument.tally, { nearOnVersion: instrument.nearOnVersion }),
  })).sort((a, b) => b.rows - a.rows || a.instrument.localeCompare(b.instrument));

  const catalog = getSetFileCatalog();
  return {
    asOfDate: bound || null,
    rows,
    families: familyRows,
    instruments: instrumentRows,
    totals: finishTally(total, { nearOnVersion }),
    // What the panel must not overstate, carried with the result rather than
    // written into the panel: periods are identical and `_PF` twins are
    // identical, so a parameter match names a configuration, not a file.
    catalogProvenance: {
      files: catalog.counts?.entries ?? null,
      families: catalog.counts?.families ?? null,
      distinctConfigurations: catalog.counts?.distinctConfigurations ?? null,
      distinctVersionIdentities: catalog.counts?.distinctVersionIdentities ?? null,
      ambiguity: catalog.ambiguity,
    },
    // Families the book runs that the library does not hold. Named, so nobody
    // has to infer them from an absence.
    notMeasuredFamilies: familyRows.filter((family) => !family.measured)
      .map((family) => ({ family: family.family, rows: family.rows, accounts: family.accounts })),
  };
}

/** The leading symbol of a contract string, for grouping only. Never matched on. */
function leadingSymbol(instrument) {
  const match = String(instrument || '').trim().toUpperCase().match(/^[A-Z0-9]+/);
  return match ? match[0] : null;
}
