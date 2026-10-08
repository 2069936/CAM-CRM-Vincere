import { ACCOUNT_STATUSES } from './reconcile';
import {
  accountTrackerHeadline,
  classifyAccountSample,
  summarizeAccountTracker,
} from './autoCollectionFleet';
import { PILL_TONES, buildAccountPill } from './accountPill';

/* ────────────────────────────────────────────────────────────────────────────
 * THE STATUS LIGHT FOR A WHOLE BOOK, one tile per client, one dot per account.
 *
 * Pedro's words: the first thing on the CAM overview should be the "semáforo",
 * for every client at once, as a picture and not as sentences to read. The
 * sentences still exist (every dot carries one in its title, every tile says
 * its worst state in a word) but the glance comes first.
 *
 * WHAT THIS READS. The browser sees account_live_samples under step 55's SELECT
 * policy and nothing else: ingest_devices has been closed to the browser key
 * since step 28. So every dot here is classified by classifyAccountSample, the
 * sample-only half of the tracker, exactly as the Today's briefing chips and
 * the overview's live line are. The four device-side states (offline, paused,
 * revoked, collector too old) belong to the client page, which has the device.
 * This module never claims one of them.
 *
 * EVERY DOT IS A PILL. Pedro's words: the dot on the client page says more,
 * the account, what kind of connection it is, and whether it is active; the
 * overview's dots should say the same. So each dot here is built by
 * buildAccountPill, the same fields the client page strip renders, and the
 * component renders the same AccountPill. A click on a pill opens what the
 * account is running (AccountLiveDetail); a click on the tile's head opens the
 * client.
 *
 * WHICH ACCOUNTS GET A DOT. Every account the VPS has sampled, plus every
 * account on the client's registry that is still expected to trade (Active or
 * Payout Hold). A registered account nobody has sampled is a dot that says
 * "never sampled", because an account that is missing from a picture is
 * invisible and an account that is visibly unsampled is a question. Retired,
 * failed and reserve accounts are left out: nothing is expected of them, so a
 * light on them would be a false alarm every morning.
 *
 * WORST FIRST. A tile is tinted by its worst account, and the grid is sorted so
 * the clients that need a look are at the top left. The rank is a desk
 * judgement, written once here: an account that is not connected to its broker
 * beats one whose VPS has stopped sampling it, which beats a registered account
 * that has never been sampled, which beats a client nothing has sampled at all,
 * which beats a client where every account is live.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The collector build that first sends live samples. Named on the empty state
 * so the day step 55 is run says what to install, not just what is missing. */
export const LIVE_SAMPLING_BUILD = '1.2.0';

/* THE PALETTE, as words: the pill's own (src/domain/accountPill.js), the same
 * three colours AccountTrackerPanel uses on the client page: green for live,
 * amber for disconnected or silent, faded amber for never sampled. A tile
 * nothing has sampled is grey. Every tone has a word beside it on screen; the
 * tone is never the only encoding. */
export const DOT_TONES = PILL_TONES;

export const TONE_WORDS = Object.freeze({
  live: 'Live',
  attention: 'Disconnected or silent',
  faint: 'Never sampled',
  none: 'No sample for this client',
});

/* The rank, worst first. `none` is a client-level state (no sample for any of
 * its accounts), the others are account states. */
const STATE_RANK = Object.freeze({
  disconnected: 5,
  sample_stale: 4,
  never_sampled: 3,
  none: 2,
  live: 1,
});

export const LEGEND = Object.freeze([
  { tone: 'live', word: TONE_WORDS.live },
  { tone: 'attention', word: TONE_WORDS.attention },
  { tone: 'faint', word: TONE_WORDS.faint },
  { tone: 'none', word: TONE_WORDS.none },
]);

const EXPECTED_TO_TRADE = new Set([ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.PAYOUT_HOLD]);

function expectedAccountNames(client) {
  const registry = client?.accountRegistry;
  if (!registry || typeof registry !== 'object') return [];
  return Object.entries(registry)
    .filter(([name, meta]) => Boolean(name) && (!meta?.status || EXPECTED_TO_TRADE.has(meta.status)))
    .map(([name]) => name);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function agedWords(minutes) {
  if (!Number.isInteger(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* One dot is one pill (accountPill.js) plus its rank and its sample. sampleOnly:
 * this screen has no device, so a never sampled account gets the honest
 * sentence rather than the one that claims a paired and answering VPS. */
function buildDot(accountName, sample, inRegistry, { now, staleSeconds }) {
  const verdict = classifyAccountSample({ now, sample, staleSeconds });
  return {
    ...buildAccountPill({ accountName, sample, verdict, inRegistry, sampleOnly: true }),
    sample,
    rank: STATE_RANK[verdict.state] || STATE_RANK.never_sampled,
  };
}

/** One client's tile. Exported for the tests; the grid calls it per client. */
export function buildClientTile(client, samples, { now, staleSeconds }) {
  const list = (Array.isArray(samples) ? samples : []).filter((row) => row && row.accountName);
  const byName = new Map(list.map((row) => [row.accountName, row]));
  const registry = expectedAccountNames(client);
  const registrySet = new Set(registry);
  const names = [...new Set([...list.map((row) => row.accountName), ...registry])]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const dots = names.map((name) => buildDot(name, byName.get(name) || null, registrySet.has(name), { now, staleSeconds }));
  const summary = summarizeAccountTracker(list, { now, staleSeconds });
  const sampled = list.length > 0;

  let worst;
  if (!sampled) {
    worst = { state: 'none', tone: 'none', word: 'No sample yet', rank: STATE_RANK.none };
  } else {
    const top = dots.reduce((best, dot) => (dot.rank > best.rank ? dot : best), dots[0]);
    worst = top.state === 'live'
      ? { state: 'live', tone: 'live', word: 'All live', rank: STATE_RANK.live }
      : { state: top.state, tone: top.tone, word: top.label, rank: top.rank };
  }
  const attention = dots.filter((dot) => dot.rank >= STATE_RANK.never_sampled).length;
  const newest = summary.newestSampledAt ? toDate(summary.newestSampledAt) : null;
  const ageMinutes = newest ? Math.max(0, Math.floor((toDate(now).getTime() - newest.getTime()) / 60_000)) : null;
  const unsampledRegistry = dots.filter((dot) => dot.state === 'never_sampled').length;
  const words = sampled
    ? `${accountTrackerHeadline(summary).replace(/\.$/, '')}${unsampledRegistry ? `, ${unsampledRegistry} registered and never sampled` : ''}.`
    : (registry.length
      ? `${registry.length} account${registry.length === 1 ? '' : 's'} on the registry, none sampled. Either no VPS is paired with this client or it has not sampled yet.`
      : 'No account on the registry and none sampled.');
  return {
    clientId: client.id,
    // The key the rows carry: the uuid, or the id for a client without one.
    // What the strategies read for a pill's detail is scoped by.
    clientKey: client.uuid || client.id,
    clientName: client.name || String(client.id),
    dots,
    worst,
    attention,
    words,
    sampled,
    newestSampledAt: newest,
    ageMinutes,
    summary,
  };
}

/* Worst first; ties broken by how many accounts need a look, then by name so
 * the grid is stable between refreshes. */
export function compareTiles(left, right) {
  if (right.worst.rank !== left.worst.rank) return right.worst.rank - left.worst.rank;
  if (right.attention !== left.attention) return right.attention - left.attention;
  return String(left.clientName).localeCompare(String(right.clientName));
}

/**
 * The whole grid, and the one of four states it is in.
 *
 *   unavailable  step 55 has not been run (tracker === null).
 *   no_clients   nothing in the book to light.
 *   no_samples   the table exists and nothing has ever landed in it for this
 *                book: the day step 55 is run, before a collector that samples
 *                is installed.
 *   ready        tiles.
 *
 * @param {{clients: object[], tracker: {available?: boolean, staleSeconds?: number,
 *   minAgentVersion?: string|null, samplesByClientId?: Map<string, object[]>}|null,
 *   now: Date|number|string}} input
 */
export function buildFleetStatusLights({ clients = [], tracker = null, now = Date.now() } = {}) {
  const at = toDate(now) || new Date();
  const list = (Array.isArray(clients) ? clients : []).filter((client) => client && client.id);
  if (!tracker || tracker.available === false) return { kind: 'unavailable', tiles: [], summary: null, at };
  if (!list.length) return { kind: 'no_clients', tiles: [], summary: null, at };
  const staleSeconds = Number(tracker.staleSeconds) > 0 ? Number(tracker.staleSeconds) : 1500;
  const byClient = tracker.samplesByClientId instanceof Map ? tracker.samplesByClientId : new Map();
  const tiles = list
    // Samples are keyed by the row's uuid; `id` is the legacy key when there is one.
    .map((client) => buildClientTile(client, byClient.get(client.uuid) || byClient.get(client.id) || [], { now: at, staleSeconds }))
    .sort(compareTiles);
  const rows = tiles.flatMap((tile) => tile.summary.rows.map((row) => row.sample));
  if (!rows.length) {
    return {
      kind: 'no_samples',
      tiles,
      summary: null,
      at,
      minAgentVersion: tracker.minAgentVersion || null,
    };
  }
  const summary = summarizeAccountTracker(rows, { now: at, staleSeconds });
  const clientsSampled = tiles.filter((tile) => tile.sampled).length;
  const newest = summary.newestSampledAt ? toDate(summary.newestSampledAt) : null;
  const ageMinutes = newest ? Math.max(0, Math.floor((at.getTime() - newest.getTime()) / 60_000)) : null;
  return {
    kind: 'ready',
    tiles,
    summary,
    at,
    clientsSampled,
    clientsTotal: tiles.length,
    ageMinutes,
    words: fleetWords(summary, clientsSampled, tiles.length, ageMinutes),
  };
}

/** The one line over the grid. accountTrackerHeadline's words, then the reach. */
export function fleetWords(summary, clientsSampled, clientsTotal, ageMinutes) {
  const head = accountTrackerHeadline(summary).replace(/\.$/, '');
  const reach = `across ${clientsSampled} of ${clientsTotal} client${clientsTotal === 1 ? '' : 's'}`;
  return `${head}, ${reach}. Latest sample ${agedWords(ageMinutes)}.`;
}
