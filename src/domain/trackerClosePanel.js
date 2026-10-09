import {
  ATTENTION_VERDICTS,
  VERDICTS,
  compareTrackerToClose,
  resolveComparisonSettings,
  verdictRank,
} from './trackerCloseComparison';
import { buildTrackerCloseFlag } from './trackerCloseFlag';
import { mergeSimulationRows } from './simulationAccounts';
import { cycleClock } from './algorithmLiveComparison';
import { getClientImportByDate } from './crmStateStore';
import { money } from './accountLiveDetail';
import { LIVE_SAMPLING_BUILD } from './fleetStatusLights';

/* ────────────────────────────────────────────────────────────────────────────
 * WHAT THE SCREEN PRINTS ABOUT THE TRACKER AND THE CLOSE.
 *
 * Pedro's words: compare what the tracker said during the day with the end of
 * day result and see what changed. trackerCloseComparison.js says the verdict;
 * this module turns one close's verdicts into the words and figures the client
 * page panel and the overview lines print, and names the state the panel is in
 * when there is nothing to compare yet.
 *
 * THE EMPTY STATES ARE REAL STATES, not errors. History started being written
 * the day step 66 ran and the first pinned readings arrive with that day's
 * 16:30 close; a manual upload is never pinned on its own. So "no close for
 * this date", "the close is still loading", "no tracker reading pinned for this
 * close" are each a sentence, and never a row of close_only verdicts.
 *
 * NULL IS NOT ZERO, the rule the whole live family is built on: a delta with a
 * side missing prints nothing, money that was not measured prints nothing, a
 * run in the history with no figure is not drawn.
 *
 * ONE CLOCK. Every "HH:MM" this module prints, the header's and the verdict
 * sentences' alike, goes through one formatter, `clock` (cycleClock, the
 * viewer's own clock, by default), handed to compareTrackerToClose too: the
 * header and the sentence under it never print one instant in two zones.
 *
 * A CLIENT WHOSE VPS DOES NOT SAMPLE IS NOT A QUESTION PER ACCOUNT. When every
 * row pinned for a close is source 'none' with no later reading, the tracker
 * never read that client at all: its machine runs an agent before
 * LIVE_SAMPLING_BUILD. That is one fact about the client ("no_tracker"), not
 * a close only verdict on each of its accounts; the overview folds those
 * clients into one line and counts only the clients with a tracker. A close
 * only account BESIDE tracked ones stays a row: there it is a real question.
 *
 * THE IDENTITY RULE: a client's `id` is its legacy key or its uuid, `uuid` is
 * the row id, the pinned rows carry the uuid; every lookup tries both.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The panel's states, in the order they are decided. */
export const PANEL_STATES = Object.freeze([
  'no_close', 'not_configured', 'not_deployed', 'reading', 'failed', 'reading_close', 'not_pinned', 'no_tracker', 'ready',
]);

/** One line per client on the overview: its states. A no_tracker client is
 * folded out of the lines into the overview's one `noTracker` line. */
export const OVERVIEW_LINE_STATES = Object.freeze(['ready', 'close_after_login', 'not_pinned', 'reading_close', 'no_close', 'no_tracker']);

/** What the client page panel says for a client whose VPS does not sample. */
export const NO_TRACKER_PANEL_SENTENCE = `This client's VPS does not sample yet, so there is no tracker reading to compare. It needs agent ${LIVE_SAMPLING_BUILD} or newer.`;

/** The overview's one folded line for those clients, or null for none. */
export function noTrackerSentence(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!n) return null;
  return n === 1
    ? `1 client has no tracker reading for this close. Its VPS does not sample yet, which needs agent ${LIVE_SAMPLING_BUILD} or newer.`
    : `${n} clients have no tracker reading for this close. Their VPS does not sample yet, which needs agent ${LIVE_SAMPLING_BUILD} or newer.`;
}

/* A pinned row that says the tracker never read the account, not before the
 * capture and not after it either. */
function unsampled(row) {
  return row?.source === 'none' && !row.nextSampledAt;
}

/** The verdict words, sentence case, as the chip prints them. */
export const CLOSE_VERDICT_WORDS = Object.freeze({
  tracker_only: 'Tracker only',
  close_only: 'Close only',
  after_close: 'After the close',
  stale_reading: 'Stale reading',
  tracker_no_figure: 'No tracker figure',
  matches: 'Matches',
  settled_at_close: 'Settled at the close',
  tracker_reset: 'Tracker reset',
  differs: 'Differs',
});

/* The count words of the overview line, by verdict: [singular, plural]. */
const COUNT_WORDS = Object.freeze({
  differs: ['differs', 'differ'],
  tracker_reset: ['tracker reset', 'tracker reset'],
  tracker_only: ['tracker only', 'tracker only'],
  close_only: ['close only', 'close only'],
  stale_reading: ['stale', 'stale'],
  after_close: ['after the close', 'after the close'],
  tracker_no_figure: ['with no tracker figure', 'with no tracker figure'],
  settled_at_close: ['settled at the close', 'settled at the close'],
  matches: ['matches', 'match'],
});

const FLAG_COUNT_WORDS = Object.freeze({
  algo_moved: ['algorithm moved', 'algorithms moved'],
  strategies_differ: ['with strategies that differ', 'with strategies that differ'],
  connection_differs: ['with a connection that differs', 'with a connection that differs'],
});

/* Tone of the verdict chip: a question is amber, agreement is green, "nothing
 * to compare" is muted. Never red: nothing here says wrong. */
const VERDICT_TONE = Object.freeze({
  differs: 'warning',
  tracker_reset: 'warning',
  tracker_only: 'warning',
  close_only: 'warning',
  stale_reading: 'warning',
  after_close: 'muted',
  tracker_no_figure: 'muted',
  settled_at_close: 'success',
  matches: 'success',
});

function keysOf(client) {
  return new Set([client?.uuid, client?.id].filter(Boolean));
}

function importKeysOf(dailyImport) {
  return new Set([dailyImport?.uuid, dailyImport?.id].filter(Boolean));
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Signed whole dollars: "+$140", "-$40", "$0". Null stays null. */
export function signedMoney(value) {
  const text = money(value);
  if (text === null) return null;
  return value > 0 ? `+${text}` : text;
}

function percentWords(ratio) {
  const percent = Number(ratio) * 100;
  const rounded = Math.round(percent * 100) / 100;
  return `${rounded}%`;
}

/** The start of a trading date in the browser's own day, as the history window. */
export function tradingDayStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(`${date}T00:00:00`);
  return Number.isFinite(start.getTime()) ? start.toISOString() : null;
}

/** The pinned rows of ONE close of ONE client, by uuid or by id on both. */
export function readingsForClose(readings, { client, dailyImport } = {}) {
  const clientKeys = keysOf(client);
  const importKeys = importKeysOf(dailyImport);
  if (!clientKeys.size || !importKeys.size) return [];
  return (Array.isArray(readings) ? readings : [])
    .filter((row) => row && clientKeys.has(row.clientId) && importKeys.has(row.dailyImportId));
}

/**
 * The close side as the comparison wants it: every account of the close,
 * simulation and undetermined rows put back (the tracker samples them too),
 * and the strategy rows flattened under their snapshot id, which the login
 * mapper drops from the flat list.
 */
export function closeSidesOf(dailyImport) {
  if (!dailyImport) return { accountSnapshots: [], strategySnapshots: [] };
  const whole = mergeSimulationRows(dailyImport);
  const accountSnapshots = (whole.snapshots || []).filter((row) => row && row.accountName);
  const strategySnapshots = accountSnapshots.flatMap((snapshot) => (Array.isArray(snapshot.strategies) ? snapshot.strategies : [])
    .map((strategy) => ({ ...strategy, accountSnapshotId: snapshot.id })));
  return { accountSnapshots, strategySnapshots };
}

/* ── The sparkline: the day's trail of one account, the capture marked ───── */

/**
 * A step path through the account's value runs. Null under two runs: a flat
 * day is one run and a line through one value says nothing. A run with no
 * figure is skipped, never drawn as zero.
 */
export function buildSparkline(runs, { capturedAt = null, width = 120, height = 24, clock = cycleClock } = {}) {
  const list = (Array.isArray(runs) ? runs : [])
    .map((run) => ({
      value: Number.isFinite(Number(run?.realizedPnl)) && run.realizedPnl !== null && run.realizedPnl !== '' ? Number(run.realizedPnl) : null,
      from: ms(run?.firstSampledAt),
      to: ms(run?.lastSampledAt),
    }))
    .filter((run) => run.value !== null && run.from !== null && run.to !== null)
    .sort((a, b) => a.from - b.from);
  if (list.length < 2) return null;
  const captured = ms(capturedAt);
  const tMin = list[0].from;
  const tMax = Math.max(...list.map((run) => run.to), captured ?? -Infinity);
  const span = Math.max(1, tMax - tMin);
  const values = list.map((run) => run.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const pad = 2;
  const x = (t) => Math.round(((t - tMin) / span) * width * 100) / 100;
  const y = (v) => {
    if (vMax === vMin) return Math.round((height / 2) * 100) / 100;
    return Math.round((pad + (1 - (v - vMin) / (vMax - vMin)) * (height - 2 * pad)) * 100) / 100;
  };
  const points = [];
  for (const run of list) {
    points.push(`${x(run.from)},${y(run.value)}`);
    points.push(`${x(run.to)},${y(run.value)}`);
  }
  const path = `M${points.join(' L')}`;
  return {
    width,
    height,
    path,
    captureX: captured === null ? null : x(captured),
    runs: list.length,
    min: vMin,
    max: vMax,
    words: `Tracker realized through the day, ${list.length} runs from ${clock(new Date(tMin))} to ${clock(new Date(list.at(-1).to))}, capture marked`,
  };
}

/* ── One row, decorated for the screen ───────────────────────────────────── */

/* A 'none' row is a stored absence: the close listed the account and the
 * tracker never saw it. It has a tracker object and no tracker side. */
function hasTrackerSide(row) {
  return Boolean(row.tracker) && row.tracker.source !== 'none';
}

function trackerWordsOf(row, clock) {
  if (!hasTrackerSide(row)) return null;
  const sampled = row.tracker.sampledAt ? clock(row.tracker.sampledAt) : null;
  const since = row.tracker.readingSince ? clock(row.tracker.readingSince) : null;
  let sampledWords = null;
  if (sampled && since) sampledWords = `sampled ${sampled}, held since ${since}`;
  else if (sampled) sampledWords = `sampled ${sampled}`;
  return {
    total: money(row.tracker.total),
    realized: money(row.tracker.realized),
    open: money(row.tracker.unrealized),
    sampled: sampledWords,
    connection: row.tracker.connectionName,
  };
}

function strategyWordsOf(row) {
  const seen = hasTrackerSide(row) ? row.strategies.length : null;
  const atClose = row.close
    ? row.strategies.filter((item) => item.inClose && item.closeRan).length + row.strategyGap.closeOnly.length
    : null;
  const seenWords = seen === null ? 'no tracker side' : `${seen} seen`;
  const closeWords = atClose === null ? 'no close side' : `${atClose} at close`;
  return `${seenWords}, ${closeWords}`;
}

function gapWordsOf(row) {
  if (!hasTrackerSide(row)) return 'no tracker side';
  if (!row.close) return 'no close side';
  const moved = row.strategies.filter((item) => item.moved).length;
  const parts = [];
  if (moved) parts.push(`${moved} moved`);
  if (row.strategyGap.trackerOnly.length) parts.push(`${row.strategyGap.trackerOnly.length} only in tracker`);
  if (row.strategyGap.closeOnly.length) parts.push(`${row.strategyGap.closeOnly.length} only at close`);
  return parts.length ? parts.join(', ') : 'none';
}

function strategyLineWords(item, clock) {
  if (item.restartedAt) return `Restarted at ${clock(item.restartedAt)}, not compared.`;
  if (item.readAfterCapture) return 'Read after the capture, not compared.';
  if (!item.inClose) return 'Not in the close.';
  if (item.closeRan === false) return 'Did not run at the close.';
  if (item.gap === null) return 'No figure on one side, not compared.';
  if (item.moved) return `Moved beyond ${money(item.tolerance)}.`;
  return `Within ${money(item.tolerance)}.`;
}

function decorateStrategy(item, clock) {
  return {
    ...item,
    key: `${item.strategyId ?? ''}|${item.strategyName}|${item.instrument}`,
    trackerWords: money(item.trackerRealized),
    closeWords: item.inClose ? money(item.closeRealized) : null,
    gapWords: signedMoney(item.gap),
    words: strategyLineWords(item, clock),
  };
}

function decorateRow(row, { historyByAccount, capturedAt, clock }) {
  const runs = historyByAccount.get(lower(row.accountName)) || [];
  return {
    ...row,
    verdictWord: CLOSE_VERDICT_WORDS[row.verdict] || row.verdict,
    tone: VERDICT_TONE[row.verdict] || 'muted',
    deltaWords: signedMoney(row.delta),
    trackerWords: trackerWordsOf(row, clock),
    closeWords: row.close ? money(row.close.realized) : null,
    strategiesWords: strategyWordsOf(row),
    gapWords: gapWordsOf(row),
    strategies: row.strategies.map((item) => decorateStrategy(item, clock)),
    spark: buildSparkline(runs, { capturedAt, clock }),
    flagDraft: buildTrackerCloseFlag(row),
  };
}

/* ── The client page panel ───────────────────────────────────────────────── */

function emptyPanel(state, extras = {}) {
  return {
    state,
    header: null,
    rows: [],
    summary: null,
    comparison: null,
    pnlSourceSentence: null,
    error: null,
    ...extras,
  };
}

function historyFor(history, client, dailyImport) {
  const byAccount = new Map();
  if (!history || history.available !== true || !Array.isArray(history.rows)) return byAccount;
  const clientKeys = keysOf(client);
  const dayStart = dailyImport?.date ? ms(`${dailyImport.date}T00:00:00`) : null;
  for (const run of history.rows) {
    if (!run || !clientKeys.has(run.clientId) || !run.accountName) continue;
    // A run that ended before the trading day started is yesterday's.
    if (dayStart !== null && ms(run.lastSampledAt) !== null && ms(run.lastSampledAt) < dayStart) continue;
    const key = lower(run.accountName);
    const list = byAccount.get(key) || [];
    list.push(run);
    byAccount.set(key, list);
  }
  return byAccount;
}

/**
 * Everything the client page panel prints for one close.
 *
 * @param {object} input
 * @param {object} input.client {id, uuid?, name}
 * @param {object|null} input.dailyImport the close on the date picker, or null.
 * @param {string} input.date the picker's date, for the sentence.
 * @param {object|null} input.answer loadSupabaseTrackerCloseReadings' answer, or null before the first read.
 * @param {object|null} [input.history] loadSupabaseAccountLiveSampleHistory's answer.
 * @param {string|null} [input.error] the last read's failure, if any.
 * @param {Function} [input.clock] value to "HH:MM", for the header and the
 *   verdict sentences alike; cycleClock (the viewer's clock) by default.
 */
export function buildTrackerClosePanel({
  client = null, dailyImport = null, date = '', answer = null, history = null, error = null, clock = cycleClock,
} = {}) {
  if (!dailyImport) return emptyPanel('no_close', { date, error });
  if (!answer) return emptyPanel(error ? 'failed' : 'reading', { date, dailyImport, error });
  if (answer.available === false) {
    return emptyPanel(answer.reason === 'not_configured' ? 'not_configured' : 'not_deployed', { date, dailyImport, error });
  }
  if (dailyImport.snapshotsLoaded === false) return emptyPanel('reading_close', { date, dailyImport, error });

  const readings = readingsForClose(answer.readings, { client, dailyImport });
  const sides = closeSidesOf(dailyImport);
  const comparison = compareTrackerToClose({
    readings,
    accountSnapshots: sides.accountSnapshots,
    strategySnapshots: sides.strategySnapshots,
    pnlSources: dailyImport.sourceSummary?.pnl_sources || null,
    settings: answer.settings || null,
    clock,
  });
  if (!comparison.available) {
    return emptyPanel('not_pinned', { date, dailyImport, error, pnlSourceSentence: comparison.pnlSourceSentence });
  }
  // Every pinned row says the tracker never read this client: one sentence
  // about its VPS, never a close only verdict on each account.
  if (readings.every(unsampled)) {
    return emptyPanel('no_tracker', { date, dailyImport, error, pnlSourceSentence: comparison.pnlSourceSentence });
  }

  const settings = resolveComparisonSettings(comparison.settings);
  const capturedClock = clock(comparison.closeCapturedAt);
  const comparedClock = clock(comparison.comparedAt);
  const toleranceWords = money(settings.toleranceDollars);
  const historyByAccount = historyFor(history, client, dailyImport);
  const rows = comparison.rows.map((row) => decorateRow(row, { historyByAccount, capturedAt: comparison.closeCapturedAt, clock }));
  /* When account_tracker_settings could not be read, the figures are the
   * migration's defaults: the header says "(default)" beside the tolerance and
   * its title says why, so nobody takes $5 for what the desk set. */
  const toleranceRule = `Tolerance per account is the larger of ${toleranceWords} and ${percentWords(settings.toleranceRatio)} of the close figure.`;

  return {
    state: 'ready',
    date,
    dailyImport,
    error,
    header: {
      capturedClock,
      comparedClock,
      basis: comparison.closeTimeBasis,
      toleranceWords,
      toleranceRule: settings.fallback
        ? `${toleranceRule} The database settings could not be read, so these are the defaults.`
        : toleranceRule,
      words: `Close captured ${capturedClock}, compared ${comparedClock}, tolerance ${toleranceWords}${settings.fallback ? ' (default)' : ''}`,
      fallback: settings.fallback,
    },
    comparison,
    pnlSourceSentence: comparison.pnlSourceSentence,
    rows,
    summary: comparison.summary,
  };
}

/** For the pills: lower case account name to verdict, attention rows only. */
export function closeVerdictsOf(view) {
  const map = new Map();
  if (!view || view.state !== 'ready') return map;
  for (const row of view.rows) {
    if (ATTENTION_VERDICTS.has(row.verdict)) map.set(lower(row.accountName), row.verdict);
  }
  return map;
}

/* ── The overview: one line per client ───────────────────────────────────── */

/** "2 differ, 1 tracker only, 5 match, 1 algorithm moved" from a summary. */
export function verdictCountWords(summary) {
  const parts = [];
  const byVerdict = summary?.byVerdict || {};
  for (const verdict of [...VERDICTS].sort((a, b) => verdictRank(a) - verdictRank(b))) {
    const count = Number(byVerdict[verdict]) || 0;
    if (!count) continue;
    const [one, many] = COUNT_WORDS[verdict];
    parts.push(`${count} ${count === 1 ? one : many}`);
  }
  const byFlag = summary?.byFlag || {};
  for (const flag of Object.keys(FLAG_COUNT_WORDS)) {
    const count = Number(byFlag[flag]) || 0;
    if (!count) continue;
    const [one, many] = FLAG_COUNT_WORDS[flag];
    parts.push(`${count} ${count === 1 ? one : many}`);
  }
  return parts.join(', ');
}

/* Worst first: a line that asks for a look ranks by its worst verdict; agreement,
 * then the lines that need a reload, a pin or a close, then by name. */
const LINE_RANK = Object.freeze({ close_after_login: 20, not_pinned: 21, reading_close: 22, no_close: 23 });

function lineRank(line) {
  if (line.state === 'ready') {
    if (line.summary.attention) return verdictRank(line.summary.worst);
    return 10;
  }
  return LINE_RANK[line.state] ?? 30;
}

function compareLines(left, right) {
  const rank = lineRank(left) - lineRank(right);
  if (rank) return rank;
  const attention = (right.summary?.attention || 0) - (left.summary?.attention || 0);
  if (attention) return attention;
  return String(left.clientName).localeCompare(String(right.clientName));
}

function clientLine(client, { today, answer, readingsByClient, clock }) {
  const clientKey = client.uuid || client.id;
  // importId is the close as the app names it (what a flag is added to);
  // importKey is its uuid (what a close's rows are loaded by).
  const base = { clientId: client.id, clientKey, clientName: client.name || String(client.id), summary: null, panel: null, importId: null, importKey: null };
  const todayImport = getClientImportByDate(client, today);
  const pinnedToday = (readingsByClient.get(client.uuid) || readingsByClient.get(client.id) || [])
    .filter((row) => row.tradingDate === today);
  if (!todayImport) {
    if (pinnedToday.length) {
      const comparedAt = pinnedToday[0].comparedAt || pinnedToday[0].closeCapturedAt;
      return { ...base, state: 'close_after_login', words: `Close compared at ${clock(comparedAt)}, after this session loaded. Reload to see it.`, pinnedToday: true };
    }
    return { ...base, state: 'no_close', words: 'No close yet today.', pinnedToday: false };
  }
  const panel = buildTrackerClosePanel({ client, dailyImport: todayImport, date: today, answer, clock });
  const ids = { importId: todayImport.id, importKey: todayImport.uuid || todayImport.id };
  if (panel.state === 'reading_close') return { ...base, ...ids, state: 'reading_close', words: 'Reading the close.', pinnedToday: pinnedToday.length > 0 };
  if (panel.state === 'no_tracker') return { ...base, ...ids, state: 'no_tracker', words: 'No tracker reading for this close.', pinnedToday: true };
  if (panel.state !== 'ready') return { ...base, ...ids, state: 'not_pinned', words: 'The tracker had no reading before this close.', pinnedToday: false };
  return { ...base, ...ids, state: 'ready', words: verdictCountWords(panel.summary), summary: panel.summary, panel, pinnedToday: true };
}

const NO_FOLD = Object.freeze({ count: 0, clients: [], sentence: null });

/**
 * The overview panel for a book: one line per client, worst first, the keys of
 * the clients whose close is pinned today (for the briefing chip), the
 * attention verdicts by client key (for the tiles' pills) and the closes whose
 * rows this session has not loaded (for the caller to ask for).
 *
 * THE CLIENTS WITH NO TRACKER READING are not lines: they are `noTracker`, one
 * folded line with their names, and they count neither as asking for a look
 * nor in `trackedClients`, the clients whose close the tracker did read.
 */
export function buildTrackerCloseOverview({ clients = [], today = '', answer = null, error = null, clock = cycleClock } = {}) {
  const list = (Array.isArray(clients) ? clients : []).filter((client) => client && client.id);
  const empty = {
    lines: [], pinnedClientKeys: new Set(), verdictsByClient: new Map(), unloadedImportIds: [], attentionClients: 0, trackedClients: 0, noTracker: NO_FOLD, error,
  };
  if (!answer) return { ...empty, state: error ? 'failed' : 'reading' };
  if (answer.available === false) return { ...empty, state: answer.reason === 'not_configured' ? 'not_configured' : 'not_deployed' };
  if (!list.length) return { ...empty, state: 'no_clients' };

  const readingsByClient = new Map();
  for (const row of Array.isArray(answer.readings) ? answer.readings : []) {
    if (!row?.clientId) continue;
    const rows = readingsByClient.get(row.clientId) || [];
    rows.push(row);
    readingsByClient.set(row.clientId, rows);
  }
  const every = list.map((client) => clientLine(client, { today, answer, readingsByClient, clock }));
  const lines = every.filter((line) => line.state !== 'no_tracker').sort(compareLines);
  const folded = every.filter((line) => line.state === 'no_tracker')
    .map(({ clientId, clientKey, clientName }) => ({ clientId, clientKey, clientName }))
    .sort((left, right) => String(left.clientName).localeCompare(String(right.clientName)));

  const pinnedClientKeys = new Set(folded.map((entry) => entry.clientKey));
  const verdictsByClient = new Map();
  const unloadedImportIds = [];
  for (const line of lines) {
    if (line.pinnedToday) pinnedClientKeys.add(line.clientKey);
    if (line.state === 'reading_close' && line.importKey) unloadedImportIds.push(line.importKey);
    if (line.state === 'ready') {
      const verdicts = closeVerdictsOf(line.panel);
      if (verdicts.size) {
        verdictsByClient.set(line.clientKey, verdicts);
        if (line.clientId !== line.clientKey) verdictsByClient.set(line.clientId, verdicts);
      }
    }
  }
  return {
    state: 'ready',
    error,
    lines,
    pinnedClientKeys,
    verdictsByClient,
    unloadedImportIds,
    attentionClients: lines.filter((line) => line.state === 'ready' && line.summary.attention > 0).length,
    trackedClients: lines.filter((line) => line.state === 'ready').length,
    noTracker: folded.length ? { count: folded.length, clients: folded, sentence: noTrackerSentence(folded.length) } : NO_FOLD,
  };
}
