// The tracker against the close, per account, in words.
//
// Step 66 pins what the account tracker said just before each close was
// captured (tracker_close_readings): the reading in force at the capture plus a
// grace, how long it had held, whether a NinjaTrader restart was seen, the first
// reading after the cutoff, and the day's strategy readings. It never copies the
// close. This module joins that pinned tracker side to the close side the CRM
// already loads (account_snapshots, strategy_snapshots, the import's
// pnl_sources) and says, per account, one verdict word and one sentence.
//
// THE VERDICT IS COMPUTED HERE AND NOWHERE ELSE, at read time. A manual
// re-upload of the close or a tolerance edit in account_tracker_settings
// changes the verdict on the next read with no rebuild and no SQL.
//
// THE DISCIPLINE IS algorithmLiveComparison.js's:
//
//   * The words are the verdicts below and nothing stronger. "differs" is the
//     strongest; nothing here says wrong, worse or fraud. A tracker figure can
//     be session based or net of commissions and the desk has not verified
//     which, so both numbers always print and the tolerance absorbs the doubt.
//   * NULL IS NOT ZERO. A delta is null, never 0, when a side is missing.
//   * No dashes as punctuation in any sentence: a hyphen inside a word or a
//     minus sign on a number is fine, an em dash or en dash is not.
//   * Nothing is sorted by P&L. Rows that want attention come first, by how
//     strong the verdict is, then by account name.
//
// Pure: no React, no Supabase.

/** The nine verdicts, in the order they are decided. The first that applies wins. */
export const VERDICTS = Object.freeze([
  'tracker_only',
  'close_only',
  'after_close',
  'stale_reading',
  'tracker_no_figure',
  'matches',
  'settled_at_close',
  'tracker_reset',
  'differs',
]);

/** The three orthogonal flags. Any of them asks for attention on its own. */
export const FLAGS = Object.freeze(['strategies_differ', 'connection_differs', 'algo_moved']);

/** Verdicts that ask for a look even with no flag raised. */
export const ATTENTION_VERDICTS = Object.freeze(new Set([
  'differs', 'tracker_reset', 'tracker_only', 'close_only', 'stale_reading',
]));

/** The settings the comparison needs, and the values the migration ships. */
export const DEFAULT_SETTINGS = Object.freeze({
  toleranceDollars: 5,
  toleranceRatio: 0.02,
  staleSeconds: 1500,
  graceSeconds: 120,
  fallback: true,
});

/* Worst first. Lower is stronger. */
const RANK = Object.freeze({
  differs: 0,
  tracker_reset: 1,
  tracker_only: 2,
  close_only: 3,
  stale_reading: 4,
  after_close: 5,
  tracker_no_figure: 6,
  settled_at_close: 7,
  matches: 8,
});

export function verdictRank(verdict) {
  return Object.hasOwn(RANK, verdict) ? RANK[verdict] : RANK.matches + 1;
}

/* ── Small helpers ───────────────────────────────────────────────────────── */

function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  return Math.round(value * 100) / 100;
}

/** Rows arrive from PostgREST in snake_case and from the app in camelCase. */
function field(row, camel, snake) {
  if (!row) return undefined;
  if (row[camel] !== undefined) return row[camel];
  return row[snake];
}

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(value) {
  const number = finiteOrNull(value);
  return number === null ? 'no figure' : money.format(number);
}

/** Whole minutes between two instants, never negative. */
export function minutesBetween(fromValue, toValue) {
  const from = ms(fromValue);
  const to = ms(toValue);
  if (from === null || to === null) return null;
  return Math.max(0, Math.round((to - from) / 60000));
}

function minutesWord(minutes) {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function clock(value) {
  const at = ms(value);
  if (at === null) return 'an unknown time';
  const date = new Date(at);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/* ── Settings and tolerance ──────────────────────────────────────────────── */

/**
 * The settings a caller read, completed from the defaults where a field is
 * missing or not a number. `fallback: true` says the numbers printed are the
 * migration's defaults rather than what the database holds.
 */
export function resolveComparisonSettings(settings) {
  if (!settings) return { ...DEFAULT_SETTINGS };
  const pick = (key, allowZero) => {
    const value = finiteOrNull(settings[key]);
    if (value === null || value < 0 || (!allowZero && value === 0)) return DEFAULT_SETTINGS[key];
    return value;
  };
  return {
    toleranceDollars: pick('toleranceDollars', true),
    toleranceRatio: pick('toleranceRatio', true),
    staleSeconds: pick('staleSeconds', false),
    graceSeconds: pick('graceSeconds', true),
    fallback: Boolean(settings.fallback),
  };
}

/**
 * tol = max(dollars, ratio x |close|). The dollar half protects small figures
 * (two readings of a flat account), the ratio half protects large ones (a $5
 * gap on a $20,000 day is agreement). With no close figure only the dollar
 * half applies.
 */
export function matchTolerance(closeValue, settings) {
  const resolved = resolveComparisonSettings(settings);
  const close = finiteOrNull(closeValue);
  const ratioPart = close === null ? 0 : resolved.toleranceRatio * Math.abs(close);
  return cents(Math.max(resolved.toleranceDollars, ratioPart));
}

/* ── The close's own note about where its figures came from ─────────────── */

/**
 * One sentence per close, never per account: persist_auto_daily_import stores
 * pnl_sources as import level counts and account_snapshots carries no
 * per-account source, so "which accounts" cannot be said.
 */
export function closePnlSourceSentence(pnlSources) {
  if (!pnlSources || typeof pnlSources !== 'object') {
    return 'The close does not say where its realized figures came from.';
  }
  const count = (key) => Math.max(0, Math.trunc(finiteOrNull(pnlSources[key]) ?? 0));
  const realized = count('realized');
  const grossFallback = count('gross_fallback');
  const grossMissing = count('gross_missing_realized');
  const unavailable = count('unavailable');
  const unknown = count('unknown');
  const total = realized + grossFallback + grossMissing + unavailable + unknown;
  if (!total) return 'The close does not say where its realized figures came from.';
  const parts = [`The close carried a realized figure for ${realized} of ${total} accounts`];
  if (grossFallback) parts.push(`${grossFallback} used the gross figure instead`);
  if (grossMissing) parts.push(`${grossMissing} had a gross figure and no realized one`);
  if (unavailable) parts.push(`${unavailable} had neither`);
  if (unknown) parts.push(`${unknown} did not say`);
  return `${parts.join('; ')}.`;
}

/* ── Strategies: pinned tracker instances against the close's rows ──────── */

function strategyKey(name, instrument) {
  return `${lower(name)}\u0000${lower(instrument)}`;
}

function closeRan(row) {
  const ran = field(row, 'ran', 'ran');
  if (ran === true || ran === false) return ran;
  return field(row, 'enabled', 'enabled') === true;
}

/**
 * Matched by (strategy name, instrument), because strategy_snapshots carries no
 * NinjaTrader strategy id. Both sides spell the name the same way
 * ('0 - OGX-PF-2.4'), so the join is exact in practice; the help text says so.
 */
function compareStrategies({ reading, closeRows, settings, cutoffMs }) {
  const tracker = Array.isArray(reading?.strategies) ? reading.strategies : [];
  const closeByKey = new Map();
  for (const row of closeRows || []) {
    const name = field(row, 'strategyName', 'strategy_name');
    const instrument = field(row, 'instrument', 'instrument');
    if (!text(name)) continue;
    closeByKey.set(strategyKey(name, instrument), row);
  }
  const trackerKeys = new Set();
  const list = [];
  let moved = false;
  for (const instance of tracker) {
    const key = strategyKey(instance.strategyName, instance.instrument);
    trackerKeys.add(key);
    const closeRow = closeByKey.get(key) || null;
    const trackerRealized = finiteOrNull(instance.realizedPnl);
    const closeRealized = closeRow ? finiteOrNull(field(closeRow, 'realized', 'realized')) : null;
    const sampledMs = ms(instance.sampledAt);
    const readAfterCapture = cutoffMs !== null && sampledMs !== null && sampledMs > cutoffMs;
    const tolerance = matchTolerance(closeRealized, settings);
    const comparable = trackerRealized !== null && closeRealized !== null
      && !instance.restartedAt && !readAfterCapture;
    const gap = comparable ? cents(trackerRealized - closeRealized) : null;
    const instanceMoved = comparable && Math.abs(gap) > tolerance;
    moved = moved || instanceMoved;
    list.push({
      strategyId: instance.strategyId ?? null,
      strategyName: text(instance.strategyName),
      instrument: text(instance.instrument),
      algorithm: instance.algorithm ?? null,
      trackerRealized,
      trackerUnrealized: finiteOrNull(instance.unrealizedPnl),
      trackerSampledAt: instance.sampledAt ?? null,
      restartedAt: instance.restartedAt ?? null,
      readAfterCapture,
      inClose: Boolean(closeRow),
      closeRealized,
      closeRan: closeRow ? closeRan(closeRow) : null,
      gap,
      tolerance,
      moved: instanceMoved,
    });
  }
  const closeRanKeys = [...closeByKey.entries()].filter(([, row]) => closeRan(row)).map(([key]) => key);
  const trackerOnly = list.filter((item) => !item.inClose).map((item) => `${item.strategyName} on ${item.instrument}`);
  const closeOnly = closeRanKeys.filter((key) => !trackerKeys.has(key)).map((key) => {
    const row = closeByKey.get(key);
    return `${text(field(row, 'strategyName', 'strategy_name'))} on ${text(field(row, 'instrument', 'instrument'))}`;
  });
  // Only when the tracker carried strategies at all: an agent that does not
  // sample the Strategies tab says nothing, and nothing is not a difference.
  const differ = tracker.length > 0 && (trackerOnly.length > 0 || closeOnly.length > 0);
  return { list, moved, differ, trackerOnly, closeOnly };
}

/* ── One account ─────────────────────────────────────────────────────────── */

function trackerSide(reading) {
  if (!reading) return null;
  return {
    source: reading.source,
    realized: finiteOrNull(reading.realizedPnl),
    unrealized: finiteOrNull(reading.unrealizedPnl),
    total: finiteOrNull(reading.totalPnl),
    connected: reading.connected === true ? true : reading.connected === false ? false : null,
    status: reading.status ?? null,
    runState: reading.runState ?? null,
    strategyCount: finiteOrNull(reading.strategyCount),
    enabledStrategyCount: finiteOrNull(reading.enabledStrategyCount),
    connectionName: text(reading.connectionName) || null,
    sampledAt: reading.sampledAt ?? null,
    readingSince: reading.readingSince ?? null,
    nextSampledAt: reading.nextSampledAt ?? null,
    resetSeen: reading.resetSeen === true,
    deviceId: reading.deviceId ?? null,
  };
}

function closeSide(snapshot) {
  if (!snapshot) return null;
  return {
    id: field(snapshot, 'id', 'id') ?? null,
    realized: finiteOrNull(field(snapshot, 'grossRealizedPnl', 'gross_realized_pnl')),
    unrealized: finiteOrNull(field(snapshot, 'unrealizedPnl', 'unrealized_pnl')),
    // '' is how persist stores an absent connection, so '' is unknown here.
    connection: text(field(snapshot, 'connection', 'connection')) || null,
  };
}

function decide({ tracker, close, capturedAt, staleSeconds, tolerance }) {
  if (tracker && tracker.source !== 'none' && !close) {
    return ['tracker_only',
      `The tracker saw this account at ${clock(tracker.sampledAt)} but the close does not list it.`];
  }
  if (!tracker || tracker.source === 'none') {
    if (tracker?.nextSampledAt) {
      const minutes = minutesBetween(capturedAt, tracker.nextSampledAt);
      return ['after_close',
        `The first tracker reading was ${minutesWord(minutes)} after the capture, so there is nothing to compare.`];
    }
    if (!tracker) {
      return ['close_only',
        'The close lists this account but no tracker reading was pinned for it; the close changed after the comparison was made.'];
    }
    return ['close_only',
      'The close lists this account but the tracker never saw it before the capture. Either the account was not sampled that day, or its readings left the history before this close was compared.'];
  }
  const age = minutesBetween(tracker.sampledAt, capturedAt);
  const ageMs = (ms(capturedAt) ?? 0) - (ms(tracker.sampledAt) ?? 0);
  if (ageMs > staleSeconds * 1000) {
    return ['stale_reading',
      `The last tracker reading was ${minutesWord(age)} before the capture, older than the ${minutesWord(Math.round(staleSeconds / 60))} staleness horizon.`];
  }
  if (tracker.realized === null) {
    return ['tracker_no_figure', 'The tracker carried no realized figure for this account at the close.'];
  }
  const closeRealized = close.realized ?? 0;
  const delta = cents(tracker.realized - closeRealized);
  if (Math.abs(delta) <= tolerance) {
    return ['matches',
      `Tracker realized ${formatMoney(tracker.realized)} matches the close ${formatMoney(closeRealized)} within ${formatMoney(tolerance)}.`];
  }
  if (tracker.total !== null && Math.abs(cents(tracker.total - closeRealized)) <= tolerance) {
    return ['settled_at_close',
      `Tracker total ${formatMoney(tracker.total)} (realized ${formatMoney(tracker.realized)} plus open ${formatMoney(tracker.unrealized)}) matches the close ${formatMoney(closeRealized)} within ${formatMoney(tolerance)}: the open position settled at the close.`];
  }
  if (tracker.resetSeen) {
    return ['tracker_reset',
      `The tracker realized figure fell to zero during the day, which looks like a NinjaTrader restart; tracker ${formatMoney(tracker.realized)} against close ${formatMoney(closeRealized)}.`];
  }
  return ['differs',
    `Tracker realized ${formatMoney(tracker.realized)} differs from the close ${formatMoney(closeRealized)} by ${formatMoney(Math.abs(delta))}, beyond the ${formatMoney(tolerance)} tolerance.`];
}

function accountRow({ accountName, reading, snapshot, closeStrategies, settings, capturedAt, cutoffMs }) {
  const tracker = trackerSide(reading);
  const close = closeSide(snapshot);
  const staleSeconds = settings.staleSeconds;
  const tolerance = matchTolerance(close?.realized ?? null, settings);
  const [verdict, sentence] = decide({ tracker, close, capturedAt, staleSeconds, tolerance });

  const delta = tracker && close && tracker.realized !== null && close.realized !== null
    ? cents(tracker.realized - close.realized)
    : null;

  const flags = [];
  const notes = [];
  if (tracker?.connectionName && close?.connection
    && lower(tracker.connectionName) !== lower(close.connection)) {
    flags.push('connection_differs');
    notes.push(`Connection differs: tracker ${tracker.connectionName}, close ${close.connection}.`);
  }
  const strategies = compareStrategies({ reading, closeRows: close ? closeStrategies : [], settings, cutoffMs });
  if (close && strategies.differ) {
    flags.push('strategies_differ');
    const trackerSaid = strategies.trackerOnly.length ? `tracker ran ${strategies.trackerOnly.join(', ')} that the close does not show` : '';
    const closeSaid = strategies.closeOnly.length ? `the close shows ${strategies.closeOnly.join(', ')} that the tracker did not carry` : '';
    notes.push(`Strategies differ: ${[trackerSaid, closeSaid].filter(Boolean).join('; ')}.`);
  }
  if (close && strategies.moved) {
    flags.push('algo_moved');
    for (const item of strategies.list.filter((entry) => entry.moved)) {
      notes.push(`${item.strategyName} on ${item.instrument} moved: tracker ${formatMoney(item.trackerRealized)}, close ${formatMoney(item.closeRealized)}, beyond ${formatMoney(item.tolerance)}.`);
    }
  }

  return {
    accountName,
    connectionName: tracker?.connectionName ?? null,
    closeConnection: close?.connection ?? null,
    source: tracker?.source ?? null,
    verdict,
    sentence,
    notes,
    flags,
    attention: ATTENTION_VERDICTS.has(verdict) || flags.length > 0,
    tracker,
    close,
    delta,
    tolerance,
    strategies: strategies.list,
    strategyGap: { trackerOnly: strategies.trackerOnly, closeOnly: strategies.closeOnly },
  };
}

/* ── The comparison ─────────────────────────────────────────────────────── */

/**
 * @param {object} input
 * @param {object[]} input.readings tracker_close_readings rows of ONE daily
 *   import, mapped to camelCase by supabaseStore.mapTrackerCloseReading.
 * @param {object[]} input.accountSnapshots account_snapshots rows of that import.
 * @param {object[]} input.strategySnapshots strategy_snapshots rows of that import.
 * @param {object} [input.pnlSources] daily_imports.source_summary.pnl_sources.
 * @param {object} [input.settings] the five tunables, mapped; defaults otherwise.
 * @returns {{available: boolean, rows: object[], summary: object}}
 */
export function compareTrackerToClose({
  readings = [],
  accountSnapshots = [],
  strategySnapshots = [],
  pnlSources = null,
  settings = null,
} = {}) {
  const resolved = resolveComparisonSettings(settings);
  const pinned = (Array.isArray(readings) ? readings : []).filter((row) => row && text(row.accountName));
  const snapshots = (Array.isArray(accountSnapshots) ? accountSnapshots : [])
    .filter((row) => row && text(field(row, 'accountName', 'account_name')));

  // No pinned row is "this close has not been compared", an empty state the
  // screen names, never a list of close_only verdicts about every account.
  if (!pinned.length) {
    return {
      available: false,
      closeCapturedAt: null,
      closeTimeBasis: null,
      closeBatchId: null,
      comparedAt: null,
      cutoffAt: null,
      settings: resolved,
      pnlSourceSentence: closePnlSourceSentence(pnlSources),
      rows: [],
      summary: {
        accounts: 0,
        attention: 0,
        worst: null,
        byVerdict: Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])),
        byFlag: Object.fromEntries(FLAGS.map((flag) => [flag, 0])),
      },
    };
  }

  const header = pinned[0];
  const capturedAt = header.closeCapturedAt ?? null;
  const graceSeconds = finiteOrNull(header.graceSeconds) ?? resolved.graceSeconds;
  const capturedMs = ms(capturedAt);
  const cutoffMs = capturedMs === null ? null : capturedMs + graceSeconds * 1000;
  // Staleness is judged at read time against the current horizon, the way the
  // tracker screen judges "silent"; the pinned value is the fallback.
  const staleSeconds = settings && finiteOrNull(settings.staleSeconds) > 0
    ? resolved.staleSeconds
    : (finiteOrNull(header.staleSeconds) ?? resolved.staleSeconds);
  const effective = { ...resolved, staleSeconds };

  const strategiesBySnapshot = new Map();
  for (const row of Array.isArray(strategySnapshots) ? strategySnapshots : []) {
    const snapshotId = field(row, 'accountSnapshotId', 'account_snapshot_id');
    if (!snapshotId) continue;
    const list = strategiesBySnapshot.get(snapshotId) || [];
    list.push(row);
    strategiesBySnapshot.set(snapshotId, list);
  }

  const readingByKey = new Map(pinned.map((row) => [lower(row.accountName), row]));
  const snapshotByKey = new Map(snapshots.map((row) => [lower(field(row, 'accountName', 'account_name')), row]));
  const keys = new Set([...readingByKey.keys(), ...snapshotByKey.keys()]);

  const rows = [];
  for (const key of keys) {
    const reading = readingByKey.get(key) || null;
    const snapshot = snapshotByKey.get(key) || null;
    // A 'none' row for an account the close no longer lists says nothing about
    // anything: the account left in a re-upload. No row.
    if (!snapshot && (!reading || reading.source === 'none')) continue;
    const accountName = text(snapshot ? field(snapshot, 'accountName', 'account_name') : reading.accountName);
    const snapshotId = snapshot ? field(snapshot, 'id', 'id') : null;
    rows.push(accountRow({
      accountName,
      reading,
      snapshot,
      closeStrategies: snapshotId ? strategiesBySnapshot.get(snapshotId) || [] : [],
      settings: effective,
      capturedAt,
      cutoffMs,
    }));
  }
  rows.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    const rank = verdictRank(a.verdict) - verdictRank(b.verdict);
    if (rank) return rank;
    return a.accountName.localeCompare(b.accountName);
  });

  const byVerdict = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0]));
  const byFlag = Object.fromEntries(FLAGS.map((flag) => [flag, 0]));
  for (const row of rows) {
    byVerdict[row.verdict] += 1;
    for (const flag of row.flags) byFlag[flag] += 1;
  }
  const attention = rows.filter((row) => row.attention);

  return {
    available: true,
    closeCapturedAt: capturedAt,
    closeTimeBasis: header.closeTimeBasis ?? null,
    closeBatchId: header.closeBatchId ?? null,
    comparedAt: header.comparedAt ?? null,
    cutoffAt: cutoffMs === null ? null : new Date(cutoffMs).toISOString(),
    settings: effective,
    pnlSourceSentence: closePnlSourceSentence(pnlSources),
    rows,
    summary: {
      accounts: rows.length,
      attention: attention.length,
      worst: attention.length ? attention[0].verdict : (rows[0]?.verdict ?? null),
      byVerdict,
      byFlag,
    },
  };
}
