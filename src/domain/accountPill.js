import { accountRunStateCopy } from './autoCollectionFleet';

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
 * Pure: no React.
 * ──────────────────────────────────────────────────────────────────────────── */

export const NO_CONNECTION_WORD = 'No connection name';

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

function titleOf({ accountName, label, connectionName, detail, run, differs }) {
  const connection = connectionName ? `Connection ${connectionName}.` : `${NO_CONNECTION_WORD}.`;
  const parts = [`${accountName}: ${label}.`, connection, detail];
  if (run) parts.push(`Strategies: ${run.label}.`);
  if (differs) parts.push(`${differs}.`);
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
 */
export function buildAccountPill({ accountName, sample = null, verdict, inRegistry = true, sampleOnly = true } = {}) {
  const state = verdict?.state || 'never_sampled';
  const label = verdict?.label || 'Never sampled';
  const showsRun = state === 'live' || state === 'disconnected';
  const run = showsRun ? accountRunStateCopy(verdict?.runState) : null;
  const connectionName = connectionOf(sample);
  const detail = sampleOnly && state === 'never_sampled' ? SAMPLE_ONLY_NEVER_SAMPLED : (verdict?.detail || '');
  return {
    accountName,
    connectionName,
    connectionWord: connectionName || NO_CONNECTION_WORD,
    hasConnection: Boolean(connectionName),
    inRegistry: inRegistry !== false,
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
    title: titleOf({ accountName, label, connectionName, detail, run, differs: null }),
  };
}

/**
 * The same pill with the amber marker: how many of its algorithms differ from
 * the desk in the current cycle. Colour, state and label are left alone.
 */
export function withDiffers(pill, count) {
  const differsCount = Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : 0;
  const words = differsWords(differsCount);
  const run = pill.runLabel ? { label: pill.runLabel } : null;
  return {
    ...pill,
    differsCount,
    differsWords: words,
    title: titleOf({
      accountName: pill.accountName,
      label: pill.label,
      connectionName: pill.connectionName,
      detail: pill.detail,
      run,
      differs: words,
    }),
  };
}
