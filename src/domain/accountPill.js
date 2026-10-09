import { accountRunStateCopy } from './autoCollectionFleet';
import { ATTENTION_VERDICTS } from './trackerCloseComparison';

/* ────────────────────────────────────────────────────────────────────────────
 * THE PILL: ONE ACCOUNT, THE THREE THINGS PEDRO WANTS TO READ ON IT.
 *
 * Pedro's words, from the client page he likes best: the dot says the account,
 * what kind of connection it is, and whether it is active. The overview's tiles
 * used to carry a dot and a run word and nothing else; now both screens render
 * the same pill, and the fields of that pill are built once, here, from a
 * verdict and a sample, so the two cannot drift.
 *
 * WHAT IT TAKES. Either classifier's verdict (classifyAccountSample on the
 * overview, which has no device; classifyAccountTracker on the client page,
 * which has one) and the account's sample row, which is where the connection
 * name lives. It never classifies: the state is the verdict's.
 *
 * "NO CONNECTION NAME" IS A NORMAL STATE. account_live_samples.connection_name
 * is filled on every production row today, and an add-on that sends a sample
 * without one has still sent a sample. The pill says so in muted words and
 * keeps the account's colour.
 *
 * THE AMBER MARKER IS NEVER THE COLOUR. An algorithm that differs from the desk
 * is a question about where to look, not a fault, and it is added to a pill as
 * a count and a sentence by withDiffers; the tone, the state and the label are
 * untouched by it, and nothing here is ever red.
 *
 * TWO MORE THINGS A TITLE CAN SAY, and every builder below keeps them, because
 * withDiffers and withCloseDiffers rebuild the title and a field they did not
 * pass on would be silently dropped. `marked`: the registry retired this
 * account (or the close says it looks failed) and it is still running, an
 * amber badge in words ("Marked Failed") with its sentence in the title.
 * `sinceWords`: "Disconnected since 09:40", from the tracker's history, on a
 * disconnected pill only; the pill's own word stays "Disconnected".
 *
 * Pure: no React.
 * ──────────────────────────────────────────────────────────────────────────── */

export const NO_CONNECTION_WORD = 'No connection name';

/* THE WORD FOR A NEW ACCOUNT NOBODY HAS SAMPLED. The registry says it was added
 * within new_account_days and no close has seen it yet (accountBuckets.js); a
 * pill that read "Never sampled" about it would make a fresh account look like
 * a dead one, which is the thing Pedro asked the lights to stop doing. Same
 * state, same faint colour, a different word and a sentence that says since when. */
export const NEW_NOT_SAMPLED_WORD = 'New, not sampled yet';

/* THE SECOND AMBER MARKER (step 66): the tracker and the close disagree about
 * this account on today's close. Pedro's orange pill. A badge in words on the
 * pill, never its colour, never red, and only for a verdict that asks for a
 * look (trackerCloseComparison's ATTENTION_VERDICTS); agreement and "nothing to
 * compare" leave the pill alone. */
export const CLOSE_DIFFERS_WORD = 'Close differs';

const CLOSE_VERDICT_SAID = Object.freeze({
  differs: 'the realized figures differ',
  tracker_reset: 'a tracker reset was seen',
  tracker_only: 'tracker only',
  close_only: 'close only',
  stale_reading: 'the tracker reading was stale',
});

/* THE PALETTE, as words. Green for live, amber for disconnected or silent,
 * faded amber for never sampled, grey for anything only the device can say
 * (offline, paused, revoked, not installed, collector too old, not sampling
 * yet). Every tone has a word beside it on screen; the tone is never the only
 * encoding. */
export const PILL_TONES = Object.freeze({
  live: 'live',
  disconnected: 'attention',
  sample_stale: 'attention',
  never_sampled: 'faint',
});

/* The overview's never_sampled sentence. classifyAccountSample's default claims
 * a paired and answering VPS, which a screen without the device cannot know. */
const SAMPLE_ONLY_NEVER_SAMPLED = 'No live sample of this account has arrived. Open the client to see whether a VPS is paired.';

function connectionOf(sample) {
  const name = sample?.connectionName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** "1 algorithm differs from the desk", "2 algorithms differ from the desk", or null. */
export function differsWords(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n === 1 ? '1 algorithm differs from the desk' : `${n} algorithms differ from the desk`;
}

/* The title is rebuilt from the pill's own fields every time, so whatever one
 * builder adds (the desk marker, the close badge, the marker for a retired
 * account still running, since when it is disconnected) survives the others. */
function titleOf({
  accountName, label, connectionName, detail, runLabel = null, differsWords: differs = null,
  closeDiffersWords: close = null, markedWords = null, sinceWords = null, state = null,
}) {
  const connection = connectionName ? `Connection ${connectionName}.` : `${NO_CONNECTION_WORD}.`;
  // A disconnected pill says since when in its head; any other keeps its label
  // and carries the since sentence after it.
  const since = sinceWords && state === 'disconnected' ? sinceWords : null;
  const parts = [`${accountName}: ${since || label}.`];
  if (sinceWords && !since) parts.push(`${sinceWords}.`);
  if (markedWords) parts.push(`${markedWords}.`);
  parts.push(connection, detail);
  if (runLabel) parts.push(`Strategies: ${runLabel}.`);
  if (differs) parts.push(`${differs}.`);
  if (close) parts.push(`${close}.`);
  return parts.filter(Boolean).join(' ');
}

/**
 * The fields both screens render for one account.
 *
 * @param {object} input
 * @param {string} input.accountName
 * @param {object|null} input.sample the account's last sample, or null.
 * @param {object} input.verdict from classifyAccountSample or classifyAccountTracker.
 * @param {boolean} [input.inRegistry=true]
 * @param {boolean} [input.sampleOnly=true] true when the caller has no device
 *   (the overview), so a never sampled account gets the honest sentence rather
 *   than the one that claims a paired VPS. The client page passes false.
 * @param {boolean} [input.isNew=false] the registry says this account is new
 *   (added within new_account_days, never in a close). A never sampled pill then
 *   reads "New, not sampled yet" and its sentence opens with `newWords`.
 * @param {string|null} [input.newWords=null] "Added 3 days ago, not seen in a close yet."
 * @param {{word: string, words: string}|null} [input.marked=null] the registry
 *   retired this account (or the close says it looks failed) and it is still
 *   running: the badge word and its sentence (accountBuckets.stillRunningWords).
 */
export function buildAccountPill({
  accountName, sample = null, verdict, inRegistry = true, sampleOnly = true, isNew = false, newWords = null,
  marked = null,
} = {}) {
  const state = verdict?.state || 'never_sampled';
  const fresh = Boolean(isNew) && state === 'never_sampled';
  const label = fresh ? NEW_NOT_SAMPLED_WORD : (verdict?.label || 'Never sampled');
  const showsRun = state === 'live' || state === 'disconnected';
  const run = showsRun ? accountRunStateCopy(verdict?.runState) : null;
  const connectionName = connectionOf(sample);
  const base = sampleOnly && state === 'never_sampled' ? SAMPLE_ONLY_NEVER_SAMPLED : (verdict?.detail || '');
  const detail = fresh && newWords ? `${newWords} ${base}`.trim() : base;
  const pill = {
    accountName,
    connectionName,
    connectionWord: connectionName || NO_CONNECTION_WORD,
    hasConnection: Boolean(connectionName),
    inRegistry: inRegistry !== false,
    isNew: fresh,
    state,
    tone: PILL_TONES[state] || 'none',
    label,
    runLabel: run ? run.label : null,
    runDetail: run ? run.detail : null,
    runState: run ? run.runState : null,
    detail,
    ageMinutes: verdict?.ageMinutes ?? null,
    sampledAt: verdict?.sampledAt ?? null,
    differsCount: 0,
    differsWords: null,
    closeDiffers: false,
    closeVerdict: null,
    closeDiffersWords: null,
    marked: Boolean(marked?.word),
    markedWord: marked?.word || null,
    markedWords: marked?.words || null,
    sinceWords: null,
  };
  return { ...pill, title: titleOf(pill) };
}

/**
 * The same pill with the amber marker: how many of its algorithms differ from
 * the desk in the current cycle. Colour, state and label are left alone.
 */
export function withDiffers(pill, count) {
  const differsCount = Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : 0;
  const next = { ...pill, differsCount, differsWords: differsWords(differsCount) };
  return { ...next, title: titleOf(next) };
}

/** "Close differs: tracker only", or null for a verdict that asks for nothing. */
export function closeDiffersWords(verdict) {
  if (!verdict || !ATTENTION_VERDICTS.has(verdict)) return null;
  return `${CLOSE_DIFFERS_WORD}: ${CLOSE_VERDICT_SAID[verdict] || String(verdict).replace(/_/g, ' ')}`;
}

/**
 * The same pill with the "Close differs" badge, when today's verdict for the
 * account asks for attention. Colour, state, label and the desk marker are
 * left alone; any other verdict returns the pill untouched.
 */
export function withCloseDiffers(pill, verdict) {
  const words = closeDiffersWords(verdict);
  if (!words) return pill;
  const next = { ...pill, closeDiffers: true, closeVerdict: verdict, closeDiffersWords: words };
  return { ...next, title: titleOf(next) };
}

/**
 * The same pill with since when it has been disconnected ("Disconnected since
 * 09:40"), read from the tracker's history. Only a disconnected pill takes it;
 * any other pill, or no words, returns the pill untouched. The visible word
 * stays "Disconnected": the time is in the title and in the detail.
 */
export function withDisconnectedSince(pill, words) {
  if (!words || pill?.state !== 'disconnected') return pill;
  const next = { ...pill, sinceWords: words };
  return { ...next, title: titleOf(next) };
}
