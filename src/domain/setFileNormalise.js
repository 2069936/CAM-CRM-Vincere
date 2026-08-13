// One canonical form for a parameter value, whichever side it came from.
//
// The desk's set files and the NinjaTrader export describe the same settings in
// two different dialects. Measured on the real book — 911 set files against the
// 128 distinct `parameters_raw` strings in the snapshot — 113 of the 299 export
// values across the 83 shared fields had no counterpart in the XML when compared
// as raw text. 73 of those 113 were pure formatting. Without this module every
// account mismatches every set file and the catalog says nothing.
//
// Both sides go through the SAME function. A normaliser applied to only one side
// is a normaliser that will drift.

/**
 * Field separator for a configuration key.
 *
 * Not '/'. Parameter VALUES contain slashes — `CloseAllOpenTradeTime` is written
 * `1/1/2020 4:45:00 PM` — and a '/' split has silently produced a wrong answer
 * three times in this codebase. See the long note in strategyConfigDrift.js.
 */
export const FIELD = '';

/**
 * Position sizing is the risk level, not the version.
 *
 * Four spellings, because the library uses four. Measured across all 911 files,
 * the fields whose name is a contract count are:
 *   PosSize1/2/3    — 17 families
 *   PositionSize    — BulletBot, values 1 / 2 / 4 (the "1 Mini" / "4 Mini" in the
 *                     filename), also carried by the export
 *   Position1/2/3Size — TendoCentinel, values {1,2} / {1} / {0,1}
 *   ScaleInSize     — MotusTemplar, constant 1 today, also in the export
 * `/^PosSize\d*$/` matched only the first, so the desk's own rule — sizing is
 * the risk level — silently stopped applying to four families.
 *
 * Widening this cannot make a match rate look better: EXACT requires zero
 * differences of ANY kind, so reclassifying a difference as sizing never turns
 * a non-match into a match. It changes which candidate wins a tie, whether a
 * difference is described as a risk level, and what `versionHash` ignores.
 *
 * Measured impact on today's book: none. 0 of the 619 latest rows differ from
 * their closest file on any of the four added spellings, and the Bullet Bot
 * library ships each of its 18 plans at exactly one PositionSize, so there is no
 * pair of files that this merges today. It is a gap that has not bitten yet —
 * TendoCentinel has 0 rows on the book, and its three Position*Size fields are
 * the same Low/Medium/High axis under another name.
 */
export const SIZING = /^(PosSize\d*|PositionSize|Position\d+Size|ScaleInSize)$/i;

/**
 * Values that identify a client or a machine rather than a configuration.
 *
 * Every one of the 911 set files carries a LicenseKey, and all 911 are
 * placeholders — 829 read `Update License Key` and 82 are empty elements — so
 * nothing secret is in the library today. It is still stripped: the catalog
 * lives in the repo, and a file re-saved from a live NinjaTrader install would
 * carry a real key into the next build.
 */
export const PER_CLIENT_FIELDS = new Set(['LicenseKey']);

/* ── Value normalisation ──────────────────────────────────────────────────── */

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * `2020-01-01T16:45:00` (XML) and `1/1/2020 4:45:00 PM` (export) are the same
 * instant. Measured: normalising datetimes alone took the unmatched-value count
 * from 113 to 76 — 37 of the 113. Nine fields carry times (CloseAllOpenTradeTime,
 * CloseAllTime, CloseAllTradesTime, RangeStart, RangeEnd, TradeStart1, TradeEnd1,
 * TradeStartTime, TradeEndTime) and every one of them mismatched on format alone.
 *
 * The date part is always 1 Jan 2020 in this library — NinjaTrader stores a
 * time-of-day as a full DateTime — but it is normalised rather than dropped, so
 * a file that ever carries a real date is not silently flattened onto every other.
 */
function normaliseDateTime(text) {
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}`;

  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if (!us) return null;
  let hour = Number(us[4]);
  const meridiem = (us[7] || '').toUpperCase();
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  // Month/day order is US: `1/1/2020` is unambiguous here, and every value in
  // the book uses 1/1, so no dd/mm reading is possible to get wrong.
  return `${us[3]}-${pad2(Number(us[1]))}-${pad2(Number(us[2]))}T${pad2(hour)}:${us[5]}:${us[6] || '00'}`;
}

/**
 * Canonical form of a single parameter value.
 *
 * Rules, each measured against the real book (unmatched export values out of 299,
 * LicenseKey excluded):
 *   baseline (raw text)              113
 *   + trim                           113   fixed 0 — no padded values in either source
 *   + boolean case                    77   fixed 36 — XML writes `true`, export `True`
 *   + datetime format                 76   fixed 37 — see normaliseDateTime
 *   + boolean AND datetime            40   fixed 73 of 113
 *   + numeric canonical form          40   fixed 0 — kept, see below
 *
 * The surviving 40 are the point of the exercise: real values no catalogued file
 * carries. They are NOT normalisation failures and must not be normalised away.
 *
 * Numeric canonicalisation fixes nothing on today's book and is kept anyway:
 * the ratio fields (ProfitTarget1Ratio 1.5 / 1.35 / 1.58, ProfitTarget2Ratio 1.8)
 * are the only decimals in the library and only one account currently runs that
 * family, so `1.8` vs `1.80` has not had the chance to bite yet. It cannot make
 * two different numbers compare equal, so the cost of keeping it is zero.
 */
export function normaliseSetFileValue(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';

  if (/^(true|false)$/i.test(text)) return text.toLowerCase();

  const when = normaliseDateTime(text);
  if (when !== null) return when;

  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return String(number);
  }

  return text;
}

/* ── Live export parsing ──────────────────────────────────────────────────── */

/**
 * Splits the value list on '/' without tearing the timestamps apart.
 *
 * A real URGO string gave 37 fragments against 31 names before this guard: every
 * value after the first date landed under the wrong name, so a stop read as a
 * trail frequency. The year must be followed by a time — `^\d{4}` alone also
 * matches a 1200-tick target, and `1/0/1200` would be swallowed into a fake date.
 */
function splitValues(text) {
  const parts = String(text).split('/');
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index + 2 < parts.length
      && /^\d{1,2}$/.test(parts[index])
      && /^\d{1,2}$/.test(parts[index + 1])
      && /^\d{4}\s+\d{1,2}:\d{2}/.test(parts[index + 2])) {
      out.push(`${parts[index]}/${parts[index + 1]}/${parts[index + 2]}`);
      index += 2;
    } else {
      out.push(parts[index]);
    }
  }
  return out;
}

/**
 * `v1/v2/.../vN (Name1/.../NameN)` as a canonical name → value map, or null.
 *
 * Null, never `{}`. "This account exported no readable parameters" and "this
 * account exported an empty parameter set" are different answers, and the second
 * one does not occur: all 3707 non-empty strings in the snapshot parse, and all
 * 128 distinct ones line up name-for-value.
 *
 * A set whose counts do not match is dropped whole rather than zipped by index.
 * A half-read set produces numbers that look plausible under the wrong name.
 */
export function parseLiveParameters(parametersRaw) {
  const text = String(parametersRaw || '').trim();
  if (!text) return null;

  const match = text.match(/^([\s\S]*)\(([^()]*)\)\s*$/);
  if (!match) return null;

  const values = splitValues(match[1].trim());
  const names = match[2].split('/').map((name) => name.trim());
  if (values.length !== names.length) return null;

  const parameters = {};
  names.forEach((name, index) => {
    if (!name) return;
    if (PER_CLIENT_FIELDS.has(name)) return;
    parameters[name] = normaliseSetFileValue(values[index]);
  });
  return Object.keys(parameters).length ? parameters : null;
}

/* ── Comparison keys ──────────────────────────────────────────────────────── */

/**
 * Stable key over a normalised parameter map.
 *
 * `omit` drops fields from the key without dropping them from the map — the
 * caller wants both "same configuration" and "same configuration at the same
 * sizing", and of 127 config-and-risk combinations on the real book 17 differed
 * by sizing alone.
 */
export function parameterKey(parameters, { omit = null } = {}) {
  const names = Object.keys(parameters || {})
    .filter((name) => !(omit && omit.test(name)))
    .sort();
  return names.map((name) => `${name}=${parameters[name]}`).join(FIELD);
}
