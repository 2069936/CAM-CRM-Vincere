import { buildAlgorithmLiveComparison } from './algorithmLiveComparison';
import { NO_CONNECTION_WORD } from './accountPill';
import { positionOfInstances } from './livePosition';

/* ────────────────────────────────────────────────────────────────────────────
 * THE ROLL CALL PER ALGORITHM, FOR THE TEAM CHAT.
 *
 * Pedro's words: the CAMs tell each other in the chat how each algorithm is
 * doing ("URGO -300", "how did BulletBot leave you?") and spot the odd one out.
 * He wants a per algorithm roll call: his own instances one by one with the
 * desk band, and a line ready to paste:
 *
 *   URGO: 3 accounts, -310 to -295, in line with the desk.
 *   BulletBot: 4 accounts, long on 3, short on 1, -140 to +60, 1 differs from the desk.
 *
 * EVERYTHING THAT COMPARES IS algorithmLiveComparison's, taken whole: the same
 * cycle for desk and client, the band of three usual spreads around the
 * median, the floors, "differs" as the only verdict word, null as not
 * measured. This module groups the viewer's instances by algorithm and root,
 * takes the range of their values, counts the directions the readings carry
 * (step 64, agent 1.2.1) and phrases the line. The connection comes from the
 * account tracker's samples, matched by the client's uuid first and its legacy
 * id second, because that is where a connection name lives.
 *
 * NOTHING IS SORTED BY P&L. Rows go differing first, then by how many
 * instances, then by name; inside a row the instances keep the comparison's
 * order (distance in the spread, then client and account). The range is a
 * reading of the row, not a ranking of it.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

export const ROLL_CALL_STATUS_WORDS = Object.freeze({
  in_line: 'in line with the desk',
  not_comparable: 'desk not comparable yet',
});

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whole dollars with the sign and no currency symbol: "-310", "+60", "0". Null reads "not measured". */
export function signedDollars(value) {
  const parsed = finiteOrNull(value);
  if (parsed === null) return 'not measured';
  const rounded = Math.round(parsed);
  if (rounded === 0) return '0';
  const digits = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `-${digits}` : `+${digits}`;
}

/* Whole dollars as the screen prints money elsewhere ("-$300", "$20"). Only
 * ever called with a measured number. */
function dollars(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function differsStatusWords(n) {
  return n === 1 ? '1 differs from the desk' : `${n} differ from the desk`;
}

function rangeWordsOf(range) {
  if (range.min === null) return 'not measured';
  if (range.min === range.max) return signedDollars(range.min);
  return `${signedDollars(range.min)} to ${signedDollars(range.max)}`;
}

function deskWordsOf(desk) {
  if (desk?.status !== 'compared') return 'Desk not comparable yet.';
  return `Desk median ${dollars(desk.median)} over ${plural(desk.nAccounts, 'account', 'accounts')} from ${plural(desk.nClients, 'client', 'clients')}, spread ${dollars(desk.spread ?? 0)}.`;
}

/* The tracker's samples for one client, by uuid first and legacy id second,
 * and the row's own client_id as a last resort. */
function samplesFor(tracker, client, clientId) {
  const byClient = tracker?.samplesByClientId instanceof Map ? tracker.samplesByClientId : null;
  if (!byClient) return [];
  return byClient.get(client?.uuid) || byClient.get(client?.id) || byClient.get(clientId) || [];
}

function connectionOf(samples, accountName) {
  const sample = samples.find((row) => row && row.accountName === accountName);
  const name = sample?.connectionName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function clientDirectory(clients) {
  const byId = new Map();
  for (const client of clients || []) {
    if (client?.id) byId.set(client.id, client);
    if (client?.uuid) byId.set(client.uuid, client);
  }
  return byId;
}

function instanceOf(account, { directory, tracker }) {
  const client = directory.get(account.clientId);
  const connectionName = connectionOf(samplesFor(tracker, client, account.clientId), account.accountName);
  const position = positionOfInstances(account.instances);
  return {
    clientId: account.clientId,
    clientName: account.clientName,
    accountName: account.accountName,
    connectionName,
    connectionWord: connectionName || NO_CONNECTION_WORD,
    hasConnection: Boolean(connectionName),
    realized: account.realized,
    unrealized: account.unrealized,
    value: account.value,
    status: account.status,
    differs: account.status === 'compared' && account.differs === true,
    distance: account.distance,
    spread: account.spread,
    position,
    positionWords: position.words,
    tradesWords: position.tradesWords,
  };
}

/**
 * The line the CAM pastes, built from a row of the roll call. Exported so the
 * button and the row carry the same text by construction.
 */
export function rollCallChatLine(row) {
  const parts = [plural(row.count, 'account', 'accounts')];
  const positions = row.positions || {};
  if (positions.long) parts.push(`long on ${positions.long}`);
  if (positions.short) parts.push(`short on ${positions.short}`);
  if (positions.flat) parts.push(`flat on ${positions.flat}`);
  parts.push(row.rangeWords);
  parts.push(row.statusWords);
  return `${row.chatName}: ${parts.join(', ')}.`;
}

function rowOf(entry, { directory, tracker }) {
  const instances = entry.accounts.map((account) => instanceOf(account, { directory, tracker }));
  const values = instances.map((instance) => instance.value).filter((value) => value !== null);
  const range = values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: null, max: null };
  const compared = instances.filter((instance) => instance.status === 'compared');
  const differing = compared.filter((instance) => instance.differs);
  const positions = { long: 0, short: 0, flat: 0, known: 0 };
  for (const instance of instances) {
    const direction = instance.position.direction;
    if (direction && direction in positions) positions[direction] += 1;
    if (direction) positions.known += 1;
  }
  let status;
  let statusWords;
  if (differing.length) {
    status = 'differs';
    statusWords = differsStatusWords(differing.length);
  } else if (compared.length) {
    status = 'in_line';
    statusWords = ROLL_CALL_STATUS_WORDS.in_line;
  } else {
    status = 'not_comparable';
    statusWords = ROLL_CALL_STATUS_WORDS.not_comparable;
  }
  const row = {
    key: `${entry.algorithm}|${entry.instrumentRoot}`,
    algorithm: entry.algorithm,
    instrumentRoot: entry.instrumentRoot,
    heading: `${entry.algorithm} ${entry.instrumentRoot}`,
    // The root is named only when the algorithm runs on more than one, so the
    // common line reads "URGO:" and never "URGO MNQ:".
    chatName: entry.alsoOn?.length ? `${entry.algorithm} ${entry.instrumentRoot}` : entry.algorithm,
    count: instances.length,
    countWords: plural(instances.length, 'account', 'accounts'),
    range,
    rangeWords: rangeWordsOf(range),
    measuredCount: values.length,
    positions,
    desk: entry.desk,
    deskWords: deskWordsOf(entry.desk),
    comparedCount: compared.length,
    differsCount: differing.length,
    status,
    statusWords,
    instances,
    chatLine: '',
  };
  row.chatLine = rollCallChatLine(row);
  return row;
}

/* Differing first, then by how many instances, then by name. Never by value. */
function compareRows(a, b) {
  const aDiffers = a.differsCount > 0;
  const bDiffers = b.differsCount > 0;
  if (aDiffers !== bDiffers) return aDiffers ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  return compareText(a.algorithm, b.algorithm) || compareText(a.instrumentRoot, b.instrumentRoot);
}

/* WHOSE CLIENTS THE ROLL CALL IS ABOUT, as the intro and the empty state say
 * it. A CAM reads its own book ("your clients"), a Manager inside a CAM's
 * workspace reads that book ("this book's clients"), and the Operations
 * Command Center reads every working client ("the desk's clients"). A scope
 * word, not free text, so a caller cannot hand the desk view a book's words. */
export const ROLL_CALL_SCOPE_WORDS = Object.freeze({
  mine: 'your clients',
  book: "this book's clients",
  desk: "the desk's clients",
});

/** The words for a scope; an unknown scope reads as the viewer's own book. */
export function rollCallScopeWords(scope) {
  return Object.hasOwn(ROLL_CALL_SCOPE_WORDS, scope) ? ROLL_CALL_SCOPE_WORDS[scope] : ROLL_CALL_SCOPE_WORDS.mine;
}

/**
 * The roll call the panel renders.
 *
 * @param {object} input
 * @param {object|null} input.live the loader's answer: {available, reason?, desk, rows, settings}, or null before a read.
 * @param {object[]} input.clients the viewer's clients, for names (matched by uuid or id).
 * @param {object|null} input.tracker the account tracker read, for the connection names.
 * @param {Date|number} [input.now]
 * @returns {{state: string, cycleStart: string|null, cycleAgeSeconds: number|null, settings: object|null, rows: object[]}}
 *   state is the comparison's ('ready', 'cycle_filling', 'no_complete_cycle',
 *   'no_readings', 'not_deployed'), 'not_configured' when there is no database,
 *   or 'unread' before the first answer. rows is empty unless ready.
 */
export function buildAlgorithmRollCall({ live = null, clients = [], tracker = null, now = new Date() } = {}) {
  if (!live) return { state: 'unread', cycleStart: null, cycleAgeSeconds: null, settings: null, rows: [] };
  if (live.available !== true) {
    return {
      state: live.reason === 'not_configured' ? 'not_configured' : 'not_deployed',
      cycleStart: null,
      cycleAgeSeconds: null,
      settings: null,
      rows: [],
    };
  }
  const comparison = buildAlgorithmLiveComparison({
    desk: live.desk,
    rows: live.rows,
    settings: live.settings,
    clients,
    now,
  });
  const base = {
    state: comparison.state,
    cycleStart: comparison.cycleStart,
    cycleAgeSeconds: comparison.cycleAgeSeconds,
    settings: comparison.settings,
    rows: [],
  };
  if (comparison.state !== 'ready') return base;
  const directory = clientDirectory(clients);
  const rows = (comparison.algorithms || [])
    // An algorithm only the desk runs has no instance of the viewer's: not a row.
    .filter((entry) => entry.accounts.length)
    .map((entry) => rowOf(entry, { directory, tracker }))
    .sort(compareRows);
  return { ...base, rows };
}
