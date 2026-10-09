import { cycleClock } from './algorithmLiveComparison';

/* ────────────────────────────────────────────────────────────────────────────
 * SINCE WHEN AN ACCOUNT HAS BEEN DISCONNECTED.
 *
 * A pill that says "Disconnected" says what is true now and nothing about how
 * long. Step 66 keeps the tracker's history as runs (account_live_sample_history:
 * one row per stretch of identical readings per device and account, with
 * first_sampled_at and last_sampled_at), so the start of the stretch is on the
 * table: "Disconnected since 09:40".
 *
 * WHICH RUN. A new run opens whenever any reading changes (the connection, the
 * status, the money, the strategy counts), so one disconnected stretch can be
 * several runs. Per device, the latest run is taken, and if it is not connected
 * the walk goes back while the runs before it are not connected either; the
 * start is the earliest first_sampled_at of that unbroken stretch. Two devices
 * sampling one account: the one whose latest run is the most recent speaks, and
 * if that run is connected nothing is said.
 *
 * WHEN THE STRETCH STARTED BEFORE TODAY. A clock without a day would read as
 * this morning, so it is not printed. The words say what is known instead:
 * disconnected since before the first run the client's VPS opened today
 * ("Disconnected since before 06:30"), or "since before today" when nothing
 * opened today.
 *
 * Nothing is said at all when the history is not deployed, could not be read,
 * or holds no row for the account. Times are the viewer's own clock, by
 * cycleClock, the formatter the panels already use.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

function ms(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The start of the viewer's day holding `now`: the window the history is read for. */
export function historyWindowStart(now) {
  const at = ms(now);
  const date = new Date(at === null ? Date.now() : at);
  date.setHours(0, 0, 0, 0);
  return date;
}

function byTime(left, right) {
  return (ms(left.firstSampledAt) ?? 0) - (ms(right.firstSampledAt) ?? 0)
    || (ms(left.lastSampledAt) ?? 0) - (ms(right.lastSampledAt) ?? 0);
}

/**
 * The start of the unbroken disconnected stretch for one account, over every
 * device that sampled it, or null when the latest run is connected or there
 * is nothing to read.
 *
 * @param {object[]} runs this account's history rows (mapped), any device.
 * @returns {number|null} epoch milliseconds.
 */
export function disconnectedStretchStart(runs) {
  const byDevice = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || ms(run.firstSampledAt) === null) continue;
    const key = run.deviceId || '';
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key).push(run);
  }
  let speaker = null;
  for (const list of byDevice.values()) {
    const ordered = [...list].sort(byTime);
    const latest = ordered[ordered.length - 1];
    const lastAt = ms(latest.lastSampledAt) ?? ms(latest.firstSampledAt);
    if (!speaker || lastAt > speaker.lastAt) speaker = { ordered, lastAt };
  }
  if (!speaker) return null;
  const { ordered } = speaker;
  let index = ordered.length - 1;
  if (ordered[index].connected === true) return null;
  let start = ms(ordered[index].firstSampledAt);
  while (index > 0 && ordered[index - 1].connected !== true) {
    index -= 1;
    start = Math.min(start, ms(ordered[index].firstSampledAt));
  }
  return start;
}

/**
 * The words for one stretch start.
 *
 * @param {number|null} start epoch ms of the stretch's first sample.
 * @param {{dayStart: number, firstToday: number|null}} day the viewer's day and
 *   the first run the client's VPS opened in it.
 */
export function disconnectedSinceWords(start, { dayStart, firstToday = null }) {
  if (start === null || start === undefined) return null;
  // cycleClock reads a Date or a string, never a bare number.
  if (start >= dayStart) return `Disconnected since ${cycleClock(new Date(start))}`;
  return firstToday !== null && firstToday !== undefined
    ? `Disconnected since before ${cycleClock(new Date(firstToday))}`
    : 'Disconnected since before today';
}

/**
 * "Disconnected since" for every account the history can speak about.
 *
 * @param {object|null} history loadSupabaseAccountLiveSampleHistory's answer:
 *   {available, rows} or null when it could not be read.
 * @param {{now: Date|number|string}} options the tracker's clock.
 * @returns {Map<string, Map<string, string>>} the rows' client key (uuid) to
 *   account name to words. Empty when there is nothing to say.
 */
export function disconnectedSinceByClient(history, { now } = {}) {
  const result = new Map();
  if (!history || history.available !== true || !Array.isArray(history.rows)) return result;
  const dayStart = historyWindowStart(now).getTime();
  const clients = new Map();
  for (const row of history.rows) {
    if (!row || !row.clientId || !row.accountName) continue;
    if (!clients.has(row.clientId)) clients.set(row.clientId, []);
    clients.get(row.clientId).push(row);
  }
  for (const [clientId, rows] of clients) {
    let firstToday = null;
    for (const row of rows) {
      const first = ms(row.firstSampledAt);
      if (first !== null && first >= dayStart && (firstToday === null || first < firstToday)) firstToday = first;
    }
    const accounts = new Map();
    for (const row of rows) {
      if (!accounts.has(row.accountName)) accounts.set(row.accountName, []);
      accounts.get(row.accountName).push(row);
    }
    const words = new Map();
    for (const [accountName, runs] of accounts) {
      const said = disconnectedSinceWords(disconnectedStretchStart(runs), { dayStart, firstToday });
      if (said) words.set(accountName, said);
    }
    if (words.size) result.set(clientId, words);
  }
  return result;
}
