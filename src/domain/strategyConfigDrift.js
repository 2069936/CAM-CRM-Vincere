// Finds accounts running a configuration almost nobody else runs.
//
// The strategy name does not identify a configuration. A real book held 110
// distinct entry/exit setups across 73 name-and-instrument pairs, and 44 of
// those pairs ran more than one. Most of that is legitimate — versions differ,
// and a client can be deliberately customised — but the shape that is worth a
// look is a large group on one setup and one or two accounts on another.
//
// Nothing here decides anything is wrong. A minority configuration is a
// question, not a fault, so the output is a review list and the wording
// everywhere is "verify", never "error". The alternative — flagging every
// difference — trains a CAM to dismiss the flag, which is worse than not having
// one.

import { strategyFamilyOf } from './strategyRiskProfile';

/**
 * NinjaTrader writes parameters as `v1/v2/.../vN (Name1/.../NameN)`, and the
 * licence key sits inside as a per-client value. Comparing raw strings makes
 * every client look unique, which is the opposite of the point.
 */
const LICENCE_KEY = /V-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]{6,8}W?/gi;

/** Position sizing is the risk level, not the configuration. */
const SIZING = /^PosSize\d*$/i;

/**
 * Field separator for a configuration key.
 *
 * Not '/'. Parameter VALUES contain slashes — CloseAllOpenTradeTime is written
 * `1/1/2020 4:45:00 PM` — so a key joined and split on '/' tears that value into
 * three and every configuration collapses to `CloseAllOpenTradeTime=1`. Two
 * setups differing only by their end-of-day close time then compared equal, and
 * the panel showed an outlier with an empty diff beside a majority whose label
 * read identically.
 *
 * This is the third time a '/' split has caused a silent wrong answer here: it
 * also broke the value/name alignment in the parameter parser and in the
 * redaction script. A separator that cannot occur in the data ends the class.
 */
const FIELD = '\u0001';

/**
 * Splits values on '/' without breaking the timestamps.
 *
 * Times are written `1/1/2020 4:45:00 PM`, so a naive split turns one value into
 * three; a real string gave 37 fragments against 31 names, and the mismatch made
 * the whole comparison silently fall back to hashing the raw text.
 */
function splitValues(text) {
  const parts = String(text).split('/');
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index + 2 < parts.length
      && /^\d{1,2}$/.test(parts[index])
      && /^\d{1,2}$/.test(parts[index + 1])
      && /^\d{4}\b/.test(parts[index + 2])) {
      out.push(`${parts[index]}/${parts[index + 1]}/${parts[index + 2]}`);
      index += 2;
    } else {
      out.push(parts[index]);
    }
  }
  return out;
}

/**
 * A configuration's identity: entry and exit settings, with sizing and the
 * licence key removed.
 *
 * Risk level changes how many contracts an algo opens and nothing else, so
 * including sizing reports a client on a higher risk setting as running a
 * different version. Of 127 config-and-risk combinations on a real book, 17 were
 * only risk.
 *
 * Two options, both defaulting to exactly what this file has always done, so the
 * drift panel's 10 rows are byte-for-byte unchanged:
 *
 *   `sizing` — this file's `/^PosSize\d*$/i` covers the 17 families that spell it
 *   that way and misses BulletBot's `PositionSize`, TendoCentinel's
 *   `Position{n}Size` and MotusTemplar's `ScaleInSize`. setFileNormalise.js
 *   carries all four spellings; a caller comparing against the desk's own rule
 *   passes that one instead of re-deriving it here.
 *
 *   `normaliseValue` — raw export values, so `1/1/2020 4:45:00 PM` stays in the
 *   NinjaTrader dialect while the set files say `2020-01-01T16:45:00`, and
 *   `True` would not equal `true`. Harmless while every value in a comparison
 *   comes from the same export, which is the drift panel's case; a caller whose
 *   output sits beside catalogued set-file values passes `normaliseSetFileValue`
 *   so both sides are stated in one dialect.
 */
export function configKeyOf(parametersRaw, { sizing = SIZING, normaliseValue = null } = {}) {
  const text = String(parametersRaw || '').trim();
  if (!text) return null;
  const match = text.match(/^([\s\S]*)\(([^()]*)\)\s*$/);
  if (!match) return text.replace(LICENCE_KEY, 'KEY');
  const values = splitValues(match[1].trim());
  const names = match[2].split('/').map((name) => name.trim());
  if (values.length !== names.length) return text.replace(LICENCE_KEY, 'KEY');

  const parts = [];
  names.forEach((name, index) => {
    if (sizing.test(name)) return;
    if (/licen[cs]e ?key/i.test(name)) return;
    parts.push(`${name}=${normaliseValue ? normaliseValue(values[index]) : values[index]}`);
  });
  // Sorted, because NinjaTrader does not guarantee an order and two strategies
  // with identical settings listed differently produced different keys. On a
  // real book that split one 83-account configuration into a 73 and a 10, and
  // the 10 was then reported as a deviation from itself — with an empty diff,
  // since nothing actually differed.
  return parts.sort().join(FIELD);
}

/** A short, stable label for a configuration nobody should have to read in full. */
export function shortConfigLabel(configKey, parametersRaw) {
  const text = String(parametersRaw || '');
  const match = text.match(/^([\s\S]*)\(([^()]*)\)\s*$/);
  if (match) {
    const values = splitValues(match[1].trim());
    const names = match[2].split('/').map((name) => name.trim());
    if (values.length === names.length) {
      const pick = (wanted) => {
        const index = names.findIndex((name) => name.toLowerCase() === wanted.toLowerCase());
        return index === -1 ? null : values[index];
      };
      const targets = ['ProfitTargetTicks1', 'ProfitTargetTicks2', 'ProfitTargetTicks3']
        .map(pick).filter((value) => value !== null);
      const stop = pick('StopLossTicks');
      if (targets.length && stop !== null) return `PT ${targets.join('/')} · SL ${stop}`;
    }
  }
  // Falls back to a stable fragment rather than an empty label: the caller still
  // needs to tell two configurations apart on screen.
  return String(configKey || '').slice(0, 28) || 'unreadable';
}

/**
 * What actually differs between two configurations.
 *
 * A fixed label — profit targets and stop — rendered the majority and an
 * outlier identically whenever they differed in some other parameter, which is
 * most of the time. Two rows reading `PT 400/450/500 · SL 300` above each other
 * tell a CAM nothing about what to check.
 *
 * Named parameters only. Configurations whose shapes do not line up cannot be
 * diffed field by field, and inventing a comparison there would be worse than
 * saying so.
 */
function toMap(key) {
  // A Map, not a plain object. Insertion order is the key's own sorted order for
  // a Map whatever the names look like; an object reorders any name that reads
  // as an array index, and `G4M1`/`URGO2`-style names are one convention away
  // from being bare digits.
  const map = new Map();
  for (const part of String(key || '').split(FIELD)) {
    const at = part.indexOf('=');
    if (at > 0) map.set(part.slice(0, at), part.slice(at + 1));
  }
  return map;
}

/**
 * A configuration key read back as `{name: value}`.
 *
 * The key is the only place the parsed configuration survives — buildConfigDrift
 * uses it internally and then discards it — so a caller that needs to state the
 * configuration itself, rather than a diff against it, had nothing to read. Same
 * parser as describeConfigDifference, so the two can never disagree about what a
 * key says. Sizing and the licence key are already gone: configKeyOf dropped them.
 */
export function configParametersOf(configKey) {
  return Object.fromEntries(toMap(configKey));
}

export function describeConfigDifference(dominantKey, outlierKey) {
  const from = toMap(dominantKey);
  const to = toMap(outlierKey);
  if (!from.size || !to.size) return [];

  const changes = [];
  for (const [name, value] of to) {
    const other = from.get(name);
    if (other === value) continue;
    // A parameter the majority does not carry at all was being skipped, so two
    // configurations that differ only by an added setting produced an empty
    // diff — and the panel fell back to a label identical to the majority's.
    changes.push({ name, from: other ?? null, to: value });
  }
  for (const [name, value] of from) {
    if (!to.has(name)) changes.push({ name, from: value, to: null });
  }
  return changes;
}

/**
 * Every (family, instrument) cohort on the book with its configurations counted
 * and ranked, majority first. No verdicts — the guards live in the callers.
 *
 * Extracted from buildConfigDrift rather than copied. buildConfigDrift throws
 * away everything it does not report: on the real book it sees 43 cohorts and
 * prints 10, and each of the 33 it drops leaves a bare `continue`. A cohort that
 * was checked and found uniform, a cohort of three accounts and a cohort that
 * does not exist all render identically — absent — which is the "cannot be
 * determined is null, never 0" rule broken one level up from the numbers.
 *
 * The three injection points exist because the second caller needs a different
 * reading of the SAME rows, not a different algorithm:
 *
 *   `familyOf` — the default is the strategy NAME. setFileMatch.js:363 prefers
 *   the import's own `strategy_family` column and falls back to the name, and
 *   the two disagree on spelling for five families: `IFSP_PF` in the column,
 *   `IFSP-PF` reconstructed from `0 - IFSP-PF-1.1`. Two panels spelling one
 *   family two ways is a bug the reader has to resolve.
 *
 *   `instrumentOf` — the default is the raw contract string, which splits one
 *   root three ways: G4M runs `MES SEP26` (43 rows), `MES 09-26` (3) and `MESU6`
 *   (1), and the catalog maps all three to `MES`. Regrouping the whole book on
 *   the root merges 43 cohorts into 19.
 *
 *   `imports` — 'latest' is every client's most recent import, which is what a
 *   CAM is looking at. 'all' walks every import up to the bound, which is how a
 *   caller asks whether today's majority has been the majority all along. Note
 *   what 'all' counts: strategy rows across imports, so a client who imports
 *   daily weighs more than one who imported once. It is a stability signal, not
 *   a population.
 *
 * Defaults reproduce buildConfigDrift's original behaviour exactly.
 */
export function buildConfigCohorts(clients = [], {
  asOfDate = '',
  imports = 'latest',
  familyOf = (strategy) => strategyFamilyOf(strategy?.strategyName),
  instrumentOf = (strategy) => String(strategy?.instrument || '').trim(),
  keyOf = (strategy) => configKeyOf(strategy?.parametersRaw),
} = {}) {
  const bound = String(asOfDate || '').slice(0, 10);
  const groups = new Map();

  for (const client of clients || []) {
    const inScope = (client?.dailyImports || [])
      .filter((entry) => entry?.date && (!bound || String(entry.date).slice(0, 10) <= bound))
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const walk = imports === 'all' ? inScope : inScope.slice(-1);
    if (!walk.length) continue;

    for (const daily of walk) {
      for (const strategy of daily.strategies || []) {
        const family = familyOf(strategy);
        const instrument = instrumentOf(strategy);
        if (!family || !instrument) continue;

        const groupKey = `${family}${FIELD}${instrument}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            key: groupKey, family, instrument, total: 0, unreadable: 0, configs: new Map(),
          });
        }
        const group = groups.get(groupKey);

        const configKey = keyOf(strategy);
        if (!configKey) {
          // Counted, never folded into a configuration. An export nobody can
          // parse is not evidence of running anything, and a cohort that
          // silently shrank by the rows it could not read reports a share whose
          // denominator the reader cannot see. 0 of 619 latest rows today.
          group.unreadable += 1;
          continue;
        }

        group.total += 1;
        if (!group.configs.has(configKey)) {
          group.configs.set(configKey, {
            configKey,
            label: shortConfigLabel(configKey, strategy.parametersRaw),
            // One raw export per configuration, kept so a caller can ask what
            // the export carried that the key does not — the sizing fields and
            // the licence key are dropped by configKeyOf and a caller naming
            // what it excluded has to be able to name them.
            sample: strategy.parametersRaw || '',
            count: 0,
            accounts: [],
          });
        }
        const config = group.configs.get(configKey);
        config.count += 1;
        config.accounts.push({
          clientId: client.id,
          clientName: client.name || client.id,
          accountName: strategy.accountName || '',
          strategyName: strategy.strategyName || '',
          // Neither of these was on the drift panel's account entries, so a
          // finding could not be joined to the set-file panel's per-row table
          // and a cohort merged from three contract strings could not say which
          // one an account is actually on.
          instrument: String(strategy?.instrument || '').trim(),
          importDate: daily.date || null,
        });
      }
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    // Majority first. A stable sort, so configurations of equal size keep the
    // order they were first seen in — the drift panel's row order depends on it.
    configs: [...group.configs.values()].sort((a, b) => b.count - a.count),
  }));
}

/**
 * Configurations running against the majority, per family and instrument.
 *
 * `minCohort` is the guard that keeps this honest. With three accounts split
 * two and one, calling the single account an outlier is noise — there is no
 * norm to deviate from yet. `outlierShare` is the other half: a group holding a
 * third of the cohort is a genuine second version, not a mistake.
 */
export function buildConfigDrift(clients = [], {
  asOfDate = '',
  minCohort = 8,
  outlierShare = 0.15,
  minDominantShare = 0.4,
} = {}) {
  const rows = [];
  for (const group of buildConfigCohorts(clients, { asOfDate })) {
    // Below the cohort floor there is no majority to deviate from, so nothing
    // here is reportable — not "no drift found", simply not measured.
    if (group.total < minCohort) continue;
    const configs = group.configs;
    const dominant = configs[0];
    // A single configuration means every account agrees.
    if (configs.length < 2) continue;

    // A group whose largest configuration holds a third of the cohort has no
    // norm — it is fragmented, and every small group in it looks like a
    // deviation from a majority that does not exist. A real book had a
    // twelve-account family whose biggest group was four; calling the singles
    // outliers there says nothing a manager can act on.
    if (dominant.count / group.total < minDominantShare) continue;

    const outliers = configs.slice(1).filter((config) => config.count / group.total <= outlierShare);
    if (!outliers.length) continue;

    rows.push({
      family: group.family,
      instrument: group.instrument,
      cohort: group.total,
      dominant: {
        label: dominant.label,
        count: dominant.count,
        share: Math.round((dominant.count / group.total) * 100),
      },
      // A second large group is a real version split, not drift. Reported so a
      // manager can see the cohort is divided rather than assuming one norm.
      versions: configs.filter((config) => config.count / group.total > outlierShare).length,
      outliers: outliers.map((config) => ({
        label: config.label,
        count: config.count,
        // What to look at. The label alone repeats the majority's whenever the
        // difference sits outside the fields it shows.
        changes: describeConfigDifference(dominant.configKey, config.configKey),
        accounts: config.accounts,
      })),
      outlierAccounts: outliers.reduce((sum, config) => sum + config.count, 0),
    });
  }

  return rows.sort((a, b) => b.outlierAccounts - a.outlierAccounts
    || a.family.localeCompare(b.family));
}
