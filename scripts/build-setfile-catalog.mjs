#!/usr/bin/env node
// Builds src/domain/data/setFileCatalog.json from the desk's NinjaTrader
// StrategyTemplate library.
//
// WHY THIS EXISTS
// The drift panel compares accounts to each other, so it can only ever answer
// "who is the odd one out". It cannot answer "what should this account be
// running", because it has no idea what a legitimate configuration looks like.
// The set files are that answer: every configuration the desk ships is one of
// these files. Matching the book against them names the version each account is
// on and — the point — surfaces accounts on no catalogued version at all.
//
// That output is a VERIFY list. The desk customises clients deliberately, and
// 41 of the 299 export values measured here have no catalogued counterpart on
// purpose. "Runs no catalogued version" is a question, not a fault.
//
// READ ONLY. Nothing here writes to the set-file directory.
//
// Usage:
//   node scripts/build-setfile-catalog.mjs [--set-files <dir>] [--out <file>] [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  normaliseSetFileValue,
  parseLiveParameters,
  parameterKey,
  PER_CLIENT_FIELDS,
  SIZING,
} from '../src/domain/setFileNormalise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const DEFAULT_SET_FILES = '/Users/pedro/Desktop/PEDRO/Trabajo/app/Vincere Trading 6.0/3 - Set Files';
const DEFAULT_OUT = path.join(REPO, 'src/domain/data/setFileCatalog.json');
const SNAPSHOT = path.join(REPO, 'public/local-snapshot.json');

/* ── Field classification ─────────────────────────────────────────────────── */

/**
 * NinjaTrader platform and chart settings, not algorithm configuration.
 *
 * Measured, not guessed: these are exactly the direct children of the strategy
 * element that occur in all 911 files (61 of them), minus LicenseKey and Name.
 * Every one of the 112 remaining direct children occurs in a subset of files —
 * they are the per-strategy parameters. None of these 59 names appears anywhere
 * in the 128 distinct `parameters_raw` strings on the real book, so excluding
 * them costs the matcher nothing and keeps `From`/`To` backtest windows and
 * chart brushes out of a configuration comparison.
 */
const PLATFORM_FIELDS = new Set([
  'AreLinesConfigurable', 'ArePlotsConfigurable', 'BacktestCommissionTemplate',
  'BarsPeriodParameter', 'BarsPeriodSerializable', 'BarsRequiredToTrade', 'BarsToLoad',
  'Calculate', 'calculate2', 'Category', 'ConnectionLossHandling', 'DaysToLoad',
  'DefaultQuantity', 'DisconnectDelaySeconds', 'Displacement', 'DisplayInDataBox',
  'DrawOnPricePanel', 'EntriesPerDirection', 'EntryHandling', 'ExitOnSessionCloseSeconds',
  'From', 'Gtd', 'IncludeCommission', 'IsAggregated', 'IsAutoScale', 'IsDataSeriesRequired',
  'IsExitOnSessionCloseStrategy', 'IsFillLimitOnTouch', 'IsOptimizeDataSeries', 'IsOverlay',
  'IsStableSession', 'IsTickReplay', 'IsTradingHoursBreakLineVisible', 'IsVisible',
  'IsWaitUntilFlat', 'Lines', 'MaximumBarsLookBack', 'NumberRestartAttempts',
  'OptimizationPeriod', 'OrderFillResolution', 'OrderFillResolutionType',
  'OrderFillResolutionValue', 'Panel', 'Plots', 'RestartsWithinMinutes', 'ScaleJustification',
  'SelectedValueSeries', 'SetOrderQuantity', 'ShowTransparentPlotsInDataBox', 'Slippage',
  'StartBehavior', 'StopTargetHandling', 'SupportsOptimizationGraph', 'Template', 'TestPeriod',
  'TimeInForce', 'To', 'TradingHoursSerializable', 'ZOrder',
]);

/**
 * Kept on the entry as metadata, never compared as a parameter.
 *
 * `Name` is the strategy build the file was saved from (`0 - URGO-4.5`) — useful
 * provenance, but the export carries it in its own `strategy_name` column, not
 * inside `parameters_raw`. `InstrumentOrInstrumentList` is the front-month
 * contract (`MNQ JUN26`); it rolls every quarter, so comparing it would report
 * the entire book as drifted the day the contract changes.
 */
const METADATA_FIELDS = new Set(['Name', 'InstrumentOrInstrumentList']);

/* ── Tiny XML reader ──────────────────────────────────────────────────────── */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, code) => {
    if (code[0] !== '#') return XML_ENTITIES[code] ?? whole;
    const value = code[1] === 'x' || code[1] === 'X'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  });
}

/**
 * The direct children of the strategy element, as name → text.
 *
 * A real parser would be nicer, but the repo ships no XML dependency and these
 * files are machine-written by NinjaTrader with a fixed shape. Depth matters:
 * `Name` occurs 2257 times across the library because every `<Plot>` has one, and
 * a flat tag scan would read a chart plot's label as the strategy's name.
 * Container children (`Lines`, `Plots`, `BarsPeriodSerializable`) are recorded as
 * present-but-not-a-leaf and land in PLATFORM_FIELDS anyway.
 */
function readStrategyElement(xml) {
  const TOKEN = /<([A-Za-z_][\w.]*)((?:\s[^>]*?)?)(\/?)>|<\/([A-Za-z_][\w.]*)>|<!--[\s\S]*?-->/g;
  const stack = [];
  const fields = new Map();
  let strategyType = null;
  let strategyElement = null;
  let openName = null;
  let openAt = 0;

  let token;
  while ((token = TOKEN.exec(xml))) {
    if (token[0].startsWith('<!--')) continue;

    if (token[4]) {
      // Closing tag. Capture text only for a direct child of the strategy element.
      if (openName && token[4] === openName && stack.length === 4) {
        fields.set(openName, decodeXml(xml.slice(openAt, token.index)));
      }
      if (token[4] === 'StrategyType' && stack.length === 2) {
        strategyType = decodeXml(xml.slice(openAt, token.index)).trim();
      }
      openName = null;
      stack.pop();
      continue;
    }

    const name = token[1];
    const selfClosing = token[3] === '/';

    if (stack.length === 2 && stack[0] === 'StrategyTemplate' && stack[1] === 'Strategy') {
      strategyElement = strategyElement ?? name;
    }
    if (stack.length === 3 && stack[0] === 'StrategyTemplate' && stack[1] === 'Strategy') {
      // `<Template />` and `<LicenseKey />` are self-closing: an empty string is
      // the value, not a missing field. Reading them as absent would make two
      // otherwise identical files differ by a field one of them "lacks".
      if (selfClosing) fields.set(name, '');
    }

    if (!selfClosing) {
      stack.push(name);
      openName = name;
      openAt = token.index + token[0].length;
      if (name === 'StrategyType') openAt = token.index + token[0].length;
    }
  }

  return { strategyType, strategyElement, fields };
}

/** `BarsPeriodSerializable/Value` — the chart interval the template was saved on. */
function readBarsPeriod(xml) {
  const block = xml.match(/<BarsPeriodSerializable>([\s\S]*?)<\/BarsPeriodSerializable>/);
  if (!block) return { barsPeriodValue: null, barsPeriodTypeSerialize: null };
  const value = block[1].match(/<Value>([^<]*)<\/Value>/);
  const type = block[1].match(/<BarsPeriodTypeSerialize>([^<]*)<\/BarsPeriodTypeSerialize>/);
  return {
    barsPeriodValue: value ? Number(value[1]) : null,
    barsPeriodTypeSerialize: type ? Number(type[1]) : null,
  };
}

/* ── Filename metadata ────────────────────────────────────────────────────── */

/**
 * `{n} - {CODE} ({INSTRUMENT}) - {timeframe} - {Risk} Risk - v{N} - Period {P}`
 *
 * Verified against all 911 filenames: 876 fit, 35 do not (17 `Default.xml`, 18
 * BulletBot files with an entirely different naming scheme). Both non-fitting
 * groups are real, shipped configurations, so they are catalogued with nulls
 * rather than dropped — see the `unparsedFilenames` block in the output.
 *
 * Tolerances the real filenames need and a strict pattern would reject:
 *   - `4.1 - URGO ...` and `1-L - Bullet Bot ...` — the leading index is not an integer
 *   - `3  - SYFY ...` and `OGX (MNQ) - 5 Min  - Medium Risk` — doubled spaces
 *   - `MST (YM) - 10 Minute -  Low Risk` — leading space inside the risk segment
 *   - `v1 (use if you want)` (URGO PL, 9 files) and `v6 (alt setup)` (PLPI, 12
 *     files) — a parenthesised note after the version, kept as `versionNote`
 * Risk really is only Low / Medium / High across all 876 — checked, not assumed.
 */
const FILENAME_PATTERN = new RegExp([
  '^\\s*(?<index>[\\w.]+)\\s*-\\s*',
  '(?<code>[^(]+?)\\s*',
  '\\((?<instrument>[^)]+)\\)\\s*-\\s*',
  '(?<timeframe>.+?)\\s*-\\s*',
  '(?<risk>\\w+)\\s+Risk\\s*-\\s*',
  'v(?<version>\\d+)\\s*(?:\\((?<versionNote>[^)]*)\\))?\\s*-\\s*',
  'Period\\s+(?<period>\\d+)\\s*$',
].join(''), 'i');

const TITLE_CASE = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

function parseFileName(baseName) {
  const stem = baseName.replace(/\.xml$/i, '');
  const match = stem.match(FILENAME_PATTERN);
  if (!match) return null;
  const g = match.groups;
  return {
    fileIndex: g.index,
    familyCode: g.code.replace(/\s+/g, ' ').trim(),
    instrument: g.instrument.replace(/\s+/g, ' ').trim().toUpperCase(),
    timeframe: g.timeframe.replace(/\s+/g, ' ').trim(),
    risk: TITLE_CASE(g.risk.trim()),
    version: Number(g.version),
    versionNote: g.versionNote ? g.versionNote.trim() : null,
    period: Number(g.period),
  };
}

/** `15 Min Candle` / `10 Minute` / `3 min` → 15 / 10 / 3. Null when unreadable. */
function timeframeMinutes(timeframe) {
  const match = String(timeframe || '').match(/(\d+)\s*min/i);
  return match ? Number(match[1]) : null;
}

/* ── Build ────────────────────────────────────────────────────────────────── */

function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function listSetFiles(root) {
  const out = [];
  for (const family of fs.readdirSync(root).sort()) {
    const dir = path.join(root, family);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.toLowerCase().endsWith('.xml')) out.push({ family, name, file: path.join(dir, name) });
    }
  }
  return out;
}

function buildCatalog(root) {
  const entries = [];
  const unparsedFilenames = [];
  const unreadableFiles = [];
  const parameterNamesSeen = new Map();
  const strippedPerClient = new Map();
  const unexpectedFields = new Map();

  for (const { family, name, file } of listSetFiles(root)) {
    let xml;
    try {
      xml = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    } catch (error) {
      unreadableFiles.push({ file: `${family}/${name}`, reason: String(error.message) });
      continue;
    }

    const { strategyType, strategyElement, fields } = readStrategyElement(xml);
    if (!strategyElement || !fields.size) {
      unreadableFiles.push({ file: `${family}/${name}`, reason: 'no strategy element found' });
      continue;
    }

    const meta = parseFileName(name);
    if (!meta) {
      unparsedFilenames.push({
        file: `${family}/${name}`,
        // Named, so the report says which shape failed rather than "35 files".
        reason: /^default\.xml$/i.test(name)
          ? 'family default template — carries no risk, version or period in its name'
          : 'filename does not use the {n} - CODE (INSTRUMENT) - timeframe - Risk - vN - Period P shape',
      });
    }

    const parameters = {};
    for (const [key, value] of fields) {
      if (PER_CLIENT_FIELDS.has(key)) {
        const bucket = strippedPerClient.get(key) || new Map();
        bucket.set(value, (bucket.get(value) || 0) + 1);
        strippedPerClient.set(key, bucket);
        continue;
      }
      if (PLATFORM_FIELDS.has(key) || METADATA_FIELDS.has(key)) continue;
      parameters[key] = normaliseSetFileValue(value);
      parameterNamesSeen.set(key, (parameterNamesSeen.get(key) || 0) + 1);
    }

    // A parameter carried by every single file is more likely platform chrome
    // that slipped the classification than a real setting. Surfaced, not fixed.
    for (const key of Object.keys(parameters)) {
      if (!unexpectedFields.has(key)) unexpectedFields.set(key, 0);
      unexpectedFields.set(key, unexpectedFields.get(key) + 1);
    }

    const { barsPeriodValue, barsPeriodTypeSerialize } = readBarsPeriod(xml);
    const instrumentContract = (fields.get('InstrumentOrInstrumentList') || '').trim() || null;

    entries.push({
      // No `id` field: it would be `file` minus `.xml` on all 911 rows, and the
      // loader derives it. 911 duplicated strings is 50 KB of bundle for nothing.
      file: `${family}/${name}`,
      family,
      familyCode: meta?.familyCode ?? null,
      strategyType: strategyType ? strategyType.split('.').pop() : null,
      instrument: meta?.instrument
        ?? (instrumentContract ? instrumentContract.split(/\s+/)[0].toUpperCase() : null),
      instrumentContract,
      timeframe: meta?.timeframe ?? null,
      timeframeMinutes: meta ? timeframeMinutes(meta.timeframe) : null,
      barsPeriodValue,
      barsPeriodTypeSerialize,
      risk: meta?.risk ?? null,
      version: meta?.version ?? null,
      versionNote: meta?.versionNote ?? null,
      period: meta?.period ?? null,
      isDefaultTemplate: /^default\.xml$/i.test(name),
      strategyLabel: (fields.get('Name') || '').trim() || null,
      parameters,
      // Two hashes because two questions. `configHash` answers "is this the same
      // file"; `versionHash` answers "is this the same version at another risk
      // level" — 17 of 127 config-and-risk combinations on the real book differ
      // by sizing alone, and reporting those as different versions is wrong.
      configHash: shortHash(parameterKey(parameters)),
      versionHash: shortHash(parameterKey(parameters, { omit: SIZING })),
    });
  }

  return {
    entries,
    unparsedFilenames,
    unreadableFiles,
    parameterNamesSeen,
    strippedPerClient,
    unexpectedFields,
  };
}

/* ── What the catalog cannot tell apart ───────────────────────────────────── */

/**
 * Two dimensions in the filenames turn out not to be configuration at all.
 *
 * Measured on the library: all 292 (family, instrument, risk, version) tuples
 * carry byte-identical parameters across Periods 0, 1 and 2 — the periods differ
 * only in the `From`/`To` backtest window, which is a platform field. And all 107
 * tuples that have a `_PF` twin are identical to that twin.
 *
 * The matcher has to know this or it will claim precision it does not have: a
 * live account whose parameters match `PLPI v1 Low` matches PLPI_PF v1 Low
 * equally well, and only the strategy NAME can separate them.
 */
function measureAmbiguity(entries) {
  const tuples = new Map();
  for (const entry of entries) {
    if (entry.period === null || entry.version === null) continue;
    const key = [entry.family, entry.instrument, entry.risk, entry.version].join('|');
    if (!tuples.has(key)) tuples.set(key, new Map());
    tuples.get(key).set(entry.period, entry.configHash);
  }

  let periodsIdentical = 0;
  const periodsDiffer = [];
  for (const [key, periods] of tuples) {
    if (new Set(periods.values()).size === 1) periodsIdentical += 1;
    else periodsDiffer.push(key);
  }

  let pfIdentical = 0;
  const pfDiffer = [];
  let pfNoTwin = 0;
  for (const [key, periods] of tuples) {
    const [family, instrument, risk, version] = key.split('|');
    if (family.endsWith('_PF')) continue;
    const twin = tuples.get([`${family}_PF`, instrument, risk, version].join('|'));
    if (!twin) { pfNoTwin += 1; continue; }
    if ([...periods.values()][0] === [...twin.values()][0]) pfIdentical += 1;
    else pfDiffer.push(key);
  }

  return {
    namedVariants: tuples.size,
    periodsIdentical,
    periodsDiffer,
    pfTwinsIdentical: pfIdentical,
    pfTwinsDiffer: pfDiffer,
    tuplesWithoutPfTwin: pfNoTwin,
  };
}

/* ── Reconciliation against the real book ─────────────────────────────────── */

/**
 * Compares the catalog's parameter vocabulary against the live export's.
 *
 * Not a test — a measurement. A field present on both sides but never reconcilable
 * is worse than a field that is openly missing, so anything the normaliser cannot
 * bring together is reported by name and count.
 */
function reconcile(entries, snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return null;

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const rows = snapshot?.tables?.strategy_snapshots || [];
  const raws = [...new Set(rows.map((row) => row.parameters_raw).filter(Boolean))];

  const live = new Map();
  let unparsed = 0;
  for (const raw of raws) {
    const parsed = parseLiveParameters(raw);
    if (!parsed) { unparsed += 1; continue; }
    for (const [name, value] of Object.entries(parsed)) {
      if (!live.has(name)) live.set(name, new Set());
      live.get(name).add(value);
    }
  }

  const catalogue = new Map();
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.parameters)) {
      if (!catalogue.has(name)) catalogue.set(name, new Set());
      catalogue.get(name).add(value);
    }
  }

  const shared = [...live.keys()].filter((name) => catalogue.has(name)).sort();
  const liveOnly = [...live.keys()].filter((name) => !catalogue.has(name)).sort();
  const catalogueOnly = [...catalogue.keys()].filter((name) => !live.has(name)).sort();

  let liveValues = 0;
  const unmatchedByField = [];
  for (const name of shared) {
    const known = catalogue.get(name);
    const missing = [...live.get(name)].filter((value) => !known.has(value));
    liveValues += live.get(name).size;
    if (missing.length) unmatchedByField.push({ name, missing: missing.sort() });
  }

  const families = new Map();
  for (const row of rows) {
    const key = row.strategy_family || '(none)';
    families.set(key, (families.get(key) || 0) + 1);
  }

  return {
    distinctRawStrings: raws.length,
    unparsedRawStrings: unparsed,
    sharedFields: shared,
    liveOnlyFields: liveOnly,
    catalogueOnlyFields: catalogueOnly,
    liveValues,
    unmatchedByField,
    unmatchedValues: unmatchedByField.reduce((sum, row) => sum + row.missing.length, 0),
    bookFamilies: [...families.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const setFilesRoot = argValue('--set-files', DEFAULT_SET_FILES);
const outFile = argValue('--out', DEFAULT_OUT);
const quiet = process.argv.includes('--quiet');
const say = quiet ? () => {} : (...args) => console.log(...args);

if (!fs.existsSync(setFilesRoot)) {
  console.error(`Set-file directory not found: ${setFilesRoot}`);
  process.exit(1);
}

const built = buildCatalog(setFilesRoot);
const { entries } = built;

const distinctConfigs = new Set(entries.map((entry) => entry.configHash));
const distinctVersions = new Set(entries.map((entry) => entry.versionHash));
const ambiguity = measureAmbiguity(entries);

/**
 * Parameter sets are stored once and referenced by index.
 *
 * The 911 files carry only 190 distinct parameter sets, so writing the map onto
 * every entry repeated each one 4.8 times on average — a 2569 KB JSON that Vite
 * bundles straight into the browser. Factoring it out gives the same data at
 * roughly a fifth of the size, and the redundancy it removes is precisely the
 * number this build is asked to measure.
 */
const configurations = [];
const configIndex = new Map();
for (const entry of entries) {
  if (!configIndex.has(entry.configHash)) {
    configIndex.set(entry.configHash, configurations.length);
    const parameterNames = Object.keys(entry.parameters).sort();
    configurations.push({
      configHash: entry.configHash,
      versionHash: entry.versionHash,
      parameterNames,
      parameters: Object.fromEntries(parameterNames.map((name) => [name, entry.parameters[name]])),
    });
  }
}
const slimEntries = entries.map(({ parameters, configHash, versionHash, ...rest }) => ({
  ...rest,
  config: configIndex.get(configHash),
}));

const catalog = {
  schemaVersion: 1,
  source: {
    // The path is deliberately not recorded: it is one desk machine's layout and
    // has no meaning in the repo.
    directoryName: path.basename(setFilesRoot),
    fileCount: entries.length + built.unreadableFiles.length,
  },
  counts: {
    entries: entries.length,
    families: new Set(entries.map((entry) => entry.family)).size,
    distinctConfigurations: distinctConfigs.size,
    distinctVersionIdentities: distinctVersions.size,
    filenamesNotMatchingPattern: built.unparsedFilenames.length,
  },
  // What a parameter match alone cannot decide. A matcher that ignores this
  // block will report one named version when several fit equally well.
  ambiguity,
  // Declared so the matcher never has to guess what it is allowed to compare.
  excludedFields: {
    perClient: [...PER_CLIENT_FIELDS].sort(),
    platform: [...PLATFORM_FIELDS].sort(),
    metadata: [...METADATA_FIELDS].sort(),
  },
  normalisation: [
    { rule: 'trim', note: 'surrounding whitespace; fixed 0 of 113 unmatched export values' },
    { rule: 'boolean-case', note: 'XML true/false vs export True/False; fixed 36 of 113' },
    { rule: 'datetime', note: 'XML 2020-01-01T16:45:00 vs export 1/1/2020 4:45:00 PM; fixed 37 of 113' },
    { rule: 'numeric', note: 'canonical number form; fixed 0 of 113, kept for the decimal ratio fields' },
  ],
  parameterVocabulary: [...built.parameterNamesSeen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files })),
  unparsedFilenames: built.unparsedFilenames,
  unreadableFiles: built.unreadableFiles,
  configurations,
  entries: slimEntries,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(catalog, null, 2)}\n`);

/* ── Report ───────────────────────────────────────────────────────────────── */

const bytes = fs.statSync(outFile).size;
say(`\nWrote ${path.relative(REPO, outFile)}  (${(bytes / 1024).toFixed(0)} KB)`);
say(`  files read            ${catalog.source.fileCount}`);
say(`  entries               ${entries.length}`);
say(`  unreadable            ${built.unreadableFiles.length}`);
say(`  filenames not parsed  ${built.unparsedFilenames.length}`);

const distinct = (pick) => [...new Set(entries.map(pick))]
  .filter((value) => value !== null && value !== undefined)
  .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

say('\nDISTINCT VALUES');
say(`  family      (${distinct((e) => e.family).length})  ${distinct((e) => e.family).join(', ')}`);
say(`  familyCode  (${distinct((e) => e.familyCode).length})  ${distinct((e) => e.familyCode).join(', ')}`);
say(`  instrument  (${distinct((e) => e.instrument).length})  ${distinct((e) => e.instrument).join(', ')}`);
say(`  timeframe   (${distinct((e) => e.timeframe).length})  ${distinct((e) => e.timeframe).join(' | ')}`);
say(`  risk        (${distinct((e) => e.risk).length})  ${distinct((e) => e.risk).join(', ')}`);
say(`  version     (${distinct((e) => e.version).length})  ${distinct((e) => e.version).join(', ')}`);
say(`  period      (${distinct((e) => e.period).length})  ${distinct((e) => e.period).join(', ')}`);
say(`  versionNote (${distinct((e) => e.versionNote).length})  ${distinct((e) => e.versionNote).join(' | ')}`);

say('\nFILENAMES THAT DID NOT PARSE');
for (const row of built.unparsedFilenames) say(`  ${row.file}  — ${row.reason}`);
if (!built.unparsedFilenames.length) say('  (none)');

say('\nPER-CLIENT / MACHINE-SPECIFIC VALUES STRIPPED');
for (const [field, values] of built.strippedPerClient) {
  for (const [value, count] of values) {
    say(`  ${field}  ${count} file(s)  ${JSON.stringify(value)}`);
  }
}
say('  Name -> strategyLabel metadata (never compared)');
say('  InstrumentOrInstrumentList -> instrumentContract metadata (rolls quarterly, never compared)');

say('\nDISTINCT CONFIGURATIONS');
say(`  ${entries.length} files carry ${distinctConfigs.size} distinct parameter sets`);
say(`  ${distinctVersions.size} distinct version identities (same, ignoring PosSize*)`);
const byConfig = new Map();
for (const entry of entries) {
  if (!byConfig.has(entry.configHash)) byConfig.set(entry.configHash, []);
  byConfig.get(entry.configHash).push(entry);
}
const groups = [...byConfig.values()];
const sizes = groups.map((group) => group.length).sort((a, b) => a - b);
say(`  ${groups.filter((group) => group.length > 1).length} of the ${groups.length} are carried by more than one file`);
say(`  files per configuration: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}`);

say('\nWHAT A PARAMETER MATCH CANNOT DECIDE');
say(`  ${ambiguity.namedVariants} named variants (family + instrument + risk + version)`);
say(`  Period:  ${ambiguity.periodsIdentical} of ${ambiguity.namedVariants} identical across Periods 0/1/2`
  + `${ambiguity.periodsDiffer.length ? `, ${ambiguity.periodsDiffer.length} differ: ${ambiguity.periodsDiffer.join(', ')}` : ' — Period is not a configuration'}`);
say(`  _PF:     ${ambiguity.pfTwinsIdentical} variants identical to their _PF twin`
  + `${ambiguity.pfTwinsDiffer.length ? `, ${ambiguity.pfTwinsDiffer.length} differ: ${ambiguity.pfTwinsDiffer.join(', ')}` : ' — _PF is not a configuration either'}`);
say(`           ${ambiguity.tuplesWithoutPfTwin} variants have no _PF twin`);
say('  => a match names a parameter set, not a single file. The strategy NAME is');
say('     what separates a prop-firm variant from its twin.');

say('\nSIZE');
say(`  ${configurations.length} configurations stored once, referenced by ${slimEntries.length} entries`);
say(`  ${(bytes / 1024).toFixed(0)} KB on disk`);

// Regression test for the whole job. The drift panel independently put 64 of 78
// URGO MNQ accounts on this exact configuration; if the catalog does not carry
// it, nothing downstream can be trusted.
const anchor = entries.find((entry) => entry.file === 'URGO/1 - URGO (MNQ) - 15 Min Candle - Low Risk - v1 - Period 0.xml');
say('\nANCHOR  URGO (MNQ) 15 Min Low Risk v1 Period 0');
if (!anchor) {
  say('  MISSING — the catalog is wrong');
  process.exitCode = 1;
} else {
  const expected = {
    family: 'URGO', instrument: 'MNQ', timeframe: '15 Min Candle', risk: 'Low', version: 1, period: 0,
    ProfitTargetTicks1: '400', ProfitTargetTicks2: '450', ProfitTargetTicks3: '500',
    StopLossTicks: '300', TrailByTicks: '200', CloseAllOpenTradeTime: '2020-01-01T16:45:00',
    PosSize1: '1', PosSize2: '1', PosSize3: '0',
  };
  let ok = true;
  for (const [key, want] of Object.entries(expected)) {
    const got = key in anchor ? anchor[key] : anchor.parameters[key];
    const pass = String(got) === String(want);
    ok = ok && pass;
    say(`  ${pass ? 'ok  ' : 'FAIL'} ${key.padEnd(22)} ${JSON.stringify(got)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`);
  }
  say(`  carries ${Object.keys(anchor.parameters).length} comparable parameters`);
  if (!ok) process.exitCode = 1;
}

const reconciliation = reconcile(entries, SNAPSHOT);
if (!reconciliation) {
  say('\nRECONCILIATION  skipped — public/local-snapshot.json not found');
} else {
  say('\nRECONCILIATION AGAINST THE REAL BOOK');
  say(`  distinct parameters_raw strings   ${reconciliation.distinctRawStrings}`);
  say(`  strings that did not parse        ${reconciliation.unparsedRawStrings}`);
  say(`  fields on both sides              ${reconciliation.sharedFields.length}`);
  say(`  fields only in the export         ${reconciliation.liveOnlyFields.length}  ${reconciliation.liveOnlyFields.join(', ')}`);
  say(`  fields only in the set files      ${reconciliation.catalogueOnlyFields.length}`);
  say(`  live values with no catalogued counterpart  ${reconciliation.unmatchedValues} of ${reconciliation.liveValues}`);
  for (const row of reconciliation.unmatchedByField) {
    say(`    ${row.name.padEnd(24)} ${JSON.stringify(row.missing)}`);
  }
  say('\n  BOOK FAMILIES vs CATALOG FAMILIES');
  const catalogFamilies = new Set(entries.map((entry) => entry.family));
  const codes = new Set(entries.map((entry) => entry.familyCode).filter(Boolean));
  for (const [family, count] of reconciliation.bookFamilies) {
    const key = family.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const hit = [...catalogFamilies, ...codes].some(
      (name) => name.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === key,
    );
    say(`    ${hit ? 'in catalog    ' : 'NOT CATALOGUED'}  ${family.padEnd(14)} ${count} strategy rows`);
  }
}

say('');
