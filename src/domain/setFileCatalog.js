// The desk's set-file library, as data the CRM can look things up in.
//
// The drift panel compares accounts to each other, so it answers "who is the odd
// one out" and nothing else. It cannot say what an account SHOULD be running,
// because it has never seen a legitimate configuration — only a popular one. The
// 911 StrategyTemplate files are the desk's source of truth: every configuration
// the desk ships is one of them.
//
// What this module is for is naming the version an account is on, and — the
// reason it exists — surfacing accounts on no catalogued version at all. That is
// a VERIFY list. The desk customises clients on purpose: of the 299 parameter
// values on the real book, 40 have no catalogued counterpart and most of those
// are deliberate. "Runs no catalogued version" is a question, not a fault, and
// any wording that implies otherwise trains a CAM to dismiss the panel.
//
// Built by scripts/build-setfile-catalog.mjs. Do not hand-edit the JSON.
//
// Pure: state in, plain data out. Nothing here reads a clock or touches I/O.

import raw from './data/setFileCatalog.json';
import {
  normaliseSetFileValue,
  parseLiveParameters,
  parameterKey,
  SIZING,
  FIELD,
} from './setFileNormalise';

export { normaliseSetFileValue, parameterKey, SIZING, FIELD };

/* ── Loading ──────────────────────────────────────────────────────────────── */

/**
 * Entries carry an index into a shared configuration table rather than their own
 * parameter map: the 911 files hold only 190 distinct parameter sets, so inlining
 * them repeated each set 4.8 times and made the JSON 2569 KB instead of 944 KB.
 * Rehydration shares the frozen configuration object between entries, which is
 * safe because nothing downstream may mutate a catalog row.
 */
function hydrate(catalog) {
  const configurations = (catalog.configurations || []).map((config) => Object.freeze({
    configHash: config.configHash,
    versionHash: config.versionHash,
    parameterNames: Object.freeze([...config.parameterNames]),
    parameters: Object.freeze({ ...config.parameters }),
  }));

  const entries = (catalog.entries || []).map((entry) => {
    const config = configurations[entry.config] ?? null;
    return Object.freeze({
      ...entry,
      // `id` is not stored — it is `file` without the extension on all 911 rows,
      // and 911 duplicated strings is 50 KB of bundle for no information.
      id: String(entry.file || '').replace(/\.xml$/i, ''),
      configHash: config?.configHash ?? null,
      versionHash: config?.versionHash ?? null,
      parameterNames: config?.parameterNames ?? Object.freeze([]),
      // Recorded per entry so a matcher can compute intersection size instead of
      // assuming it. Files carry between 19 and 50 comparable parameters — a
      // match on 8 of 31 fields is not the claim a match on 31 of 31 is.
      parameterCount: config ? config.parameterNames.length : 0,
      parameters: config?.parameters ?? Object.freeze({}),
    });
  });

  return Object.freeze({
    schemaVersion: catalog.schemaVersion ?? null,
    source: catalog.source ?? null,
    counts: catalog.counts ?? null,
    ambiguity: catalog.ambiguity ?? null,
    excludedFields: catalog.excludedFields ?? null,
    normalisation: catalog.normalisation ?? [],
    parameterVocabulary: catalog.parameterVocabulary ?? [],
    unparsedFilenames: catalog.unparsedFilenames ?? [],
    unreadableFiles: catalog.unreadableFiles ?? [],
    configurations: Object.freeze(configurations),
    entries: Object.freeze(entries),
  });
}

const CATALOG = hydrate(raw);

/** The whole catalog, including its own provenance and its declared blind spots. */
export function getSetFileCatalog() {
  return CATALOG;
}

/** Every catalogued set file. */
export function setFileEntries() {
  return CATALOG.entries;
}

/**
 * What the catalog admits it cannot decide.
 *
 * Measured, not assumed: all 292 (family, instrument, risk, version) variants are
 * byte-identical across Periods 0/1/2, and all 107 variants that have a `_PF`
 * twin are identical to that twin. A parameter match therefore names a parameter
 * set, never a single file — callers that render one filename are overstating.
 */
export function setFileAmbiguity() {
  return CATALOG.ambiguity;
}

/* ── Family and instrument resolution ─────────────────────────────────────── */

/**
 * The book and the library spell the same family differently.
 *
 * Measured against the snapshot: the book's `strategy_family` values are
 * `Bullet Bot`, `FSA`, `MST` and `G4M`, while the library's folders are
 * `BulletBot`, `FossaAssassin`, `MotusTemplar` and — for G4M — nothing at all.
 * The drift panel's `strategyFamilyOf` produces a third spelling again
 * (`OGX-PF` from `0 - OGX-PF-2.4`, where the snapshot column says `OGX_PF`).
 * Three spellings of one family is three chances to silently find no set files
 * and report the whole family as uncatalogued.
 */
const FAMILY_ALIASES = new Map([
  ['BULLETBOT', 'BulletBot'],
  ['FSA', 'FossaAssassin'],
  ['FOSSAASSASSIN', 'FossaAssassin'],
  ['MST', 'MotusTemplar'],
  ['MOTUSTEMPLAR', 'MotusTemplar'],
  ['TDC', 'TendoCentinel'],
  ['TENDOCENTINEL', 'TendoCentinel'],
]);

const squash = (text) => String(text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/**
 * Folder names first, short codes second — and a code never overwrites a folder.
 *
 * One pass that wrote both keys per entry was wrong on half the library. `OGX`
 * and `OGX_PF` both carry familyCode `OGX`, so the `_PF` folder's entries came
 * later and clobbered the key `OGX`, and `resolveCatalogFamily('OGX')` answered
 * `OGX_PF`. Measured on the real book: 6 of the 17 book families — OGX, RBO,
 * IFSP, ARPD, SYFY, DJDR, 293 of the 619 latest strategy rows — were being
 * matched against the prop-firm folder and would have been told they run a
 * prop-firm file. The parameters are identical between twins (all 107 measured),
 * so nothing mismatched; only the NAME was wrong, which is the one thing that
 * separates a `_PF` variant from its twin.
 */
const FAMILY_BY_KEY = new Map();
for (const entry of CATALOG.entries) FAMILY_BY_KEY.set(squash(entry.family), entry.family);
for (const entry of CATALOG.entries) {
  if (!entry.familyCode) continue;
  const key = squash(entry.familyCode);
  if (!FAMILY_BY_KEY.has(key)) FAMILY_BY_KEY.set(key, entry.family);
}

/**
 * A book family name as the catalog's folder name, or null when the library has
 * no such family.
 *
 * Null, never a nearest guess. `G4M` runs on 257 strategy rows and has no set
 * files at all; answering `OGX` because it is the closest string would put a
 * quarter of the book on someone else's algorithm.
 */
export function resolveCatalogFamily(family) {
  const key = squash(family);
  if (!key) return null;
  if (FAMILY_BY_KEY.has(key)) return FAMILY_BY_KEY.get(key);

  // `OGX-PF` / `OGX_PF` / `OGXPF` all squash to OGXPF; the folder is `OGX_PF`.
  const alias = FAMILY_ALIASES.get(key);
  if (alias) return alias;
  if (key.endsWith('PF')) {
    const base = FAMILY_ALIASES.get(key.slice(0, -2)) ?? FAMILY_BY_KEY.get(key.slice(0, -2));
    if (base) {
      const withSuffix = `${base}_PF`;
      if (FAMILY_BY_KEY.has(squash(withSuffix))) return FAMILY_BY_KEY.get(squash(withSuffix));
    }
  }
  return null;
}

/**
 * Every root symbol the library knows, longest first.
 *
 * Longest-first matters: `M2K` contains a digit, so a "letters then digits" rule
 * reads `M2KU6` as root `M` and `MNQU6` as root `MNQ` — two different answers to
 * the same question. Matching against the catalog's own seven symbols
 * (M2K, MES, MGC, MNQ, NG, PL, YM) is data, not a guess about ticker grammar.
 */
const INSTRUMENT_ROOTS = [...new Set(
  CATALOG.entries.map((entry) => entry.instrument).filter(Boolean),
)].sort((a, b) => b.length - a.length);

/**
 * A live instrument (`MNQ SEP26`, `MNQ 09-26`, `MNQU6`) as a catalogued root
 * symbol, or null.
 *
 * Null when no catalogued symbol matches — `NQ JUN26` is the full-size contract
 * and the library holds no full-size templates, so it belongs to nothing here.
 * Returning `MNQ` because it looks similar would be a wrong answer wearing a
 * confident face.
 */
export function catalogInstrumentOf(instrument) {
  const text = String(instrument || '').trim().toUpperCase();
  if (!text) return null;
  for (const root of INSTRUMENT_ROOTS) {
    if (text === root) return root;
    // The remainder must start a new token: a space, a dash, or the contract
    // month code. Without the boundary `NQ SEP26` would match root `NG`... it
    // would not, but `M2K` would match inside a hypothetical `XM2K`, and a
    // silent prefix match is exactly the class of bug this file exists to avoid.
    if (text.startsWith(root) && /^[\s\-0-9A-Z]/.test(text.slice(root.length))) return root;
  }
  return null;
}

/* ── Lookups ──────────────────────────────────────────────────────────────── */

function groupBy(entries, keyOf) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  for (const [key, list] of map) map.set(key, Object.freeze(list));
  return map;
}

const BY_FAMILY = groupBy(CATALOG.entries, (entry) => entry.family);
const BY_FAMILY_INSTRUMENT = groupBy(
  CATALOG.entries,
  (entry) => (entry.instrument ? `${entry.family}|${entry.instrument}` : null),
);

const EMPTY = Object.freeze([]);

/**
 * Every set file for a family, accepting any of the three spellings in use.
 *
 * An empty array means the library has no such family — which is a real answer
 * (`G4M`), not an error.
 */
export function setFilesForFamily(family) {
  const resolved = resolveCatalogFamily(family);
  if (!resolved) return EMPTY;
  return BY_FAMILY.get(resolved) ?? EMPTY;
}

/**
 * Every set file for a family on a given instrument.
 *
 * The instrument may be a live contract (`MNQ SEP26`) or a root (`MNQ`).
 *
 * Note what this deliberately does NOT return: the 17 `Default.xml` templates
 * carry no instrument in their filename and 10 of them carry no contract in the
 * XML either, so their `instrument` is null and they are absent here. They are
 * still reachable through setFilesForFamily. Every Default was measured to be
 * byte-identical to its family's Low Risk v1, so nothing is lost — but inferring
 * an instrument from that would be inference, and the field would then be a
 * guess rather than a reading.
 */
export function setFilesForFamilyInstrument(family, instrument) {
  const resolved = resolveCatalogFamily(family);
  if (!resolved) return EMPTY;
  const root = catalogInstrumentOf(instrument);
  if (!root) return EMPTY;
  return BY_FAMILY_INSTRUMENT.get(`${resolved}|${root}`) ?? EMPTY;
}

/** A set file by its catalog id (`URGO/1 - URGO (MNQ) - ... - Period 0`) or path. */
const BY_ID = new Map(CATALOG.entries.flatMap((entry) => [[entry.id, entry], [entry.file, entry]]));
export function setFileById(id) {
  return BY_ID.get(String(id || '')) ?? null;
}

/* ── Live parameters in the same shape ────────────────────────────────────── */

/**
 * A live `parameters_raw` string as the same canonical name → value map the
 * catalog stores, or null.
 *
 * Null, never `{}`. "This account exported nothing readable" and "this account
 * exported an empty set" are different answers and must render differently. All
 * 3707 non-empty strings in the snapshot parse, so a null here is a genuine
 * signal rather than routine.
 *
 * LicenseKey is dropped on the way in — it is per-client and never part of any
 * comparison. In the redacted snapshot it already reads `KEY`, which would
 * otherwise mismatch every catalogued file on every account.
 */
export function normaliseLiveParameters(parametersRaw) {
  return parseLiveParameters(parametersRaw);
}

/**
 * Which parameter names a live export and a catalogued entry actually share.
 *
 * The XML is a superset — the library's files carry between 19 and 50 comparable
 * parameters while an export carries around 31 — so the overlap has to be
 * measured per pair, never assumed. 14 export fields (`EdgeLeverage`,
 * `LimitDailyEntries`, `MaxDailyEntries`, the six `FSA*` and four `G4M*` fields)
 * exist in no set file at all, so no entry can ever be compared on them.
 *
 * `shared` is the honest denominator for any "matched N of M fields" claim.
 */
export function sharedParameterNames(liveParameters, entry) {
  const live = liveParameters || {};
  const names = entry?.parameterNames || [];
  const shared = names.filter((name) => Object.prototype.hasOwnProperty.call(live, name));
  return {
    shared,
    liveOnly: Object.keys(live).filter((name) => !names.includes(name)).sort(),
    catalogOnly: names.filter((name) => !Object.prototype.hasOwnProperty.call(live, name)),
  };
}
