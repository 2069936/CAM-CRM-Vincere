import { NO_CONNECTION_WORD, buildAccountPill } from './accountPill';
import { cycleClock } from './algorithmLiveComparison';
import { classifyAccountSample } from './autoCollectionFleet';
import { agedWords, expectedAccountNames } from './fleetStatusLights';

/* ────────────────────────────────────────────────────────────────────────────
 * ONE BULB PER CLIENT, FOR THE MANAGER'S DESK VIEW.
 *
 * Pedro's words: the semáforo on the Manager's view shows every client's
 * accounts at once and that is too much to read. One light per client instead:
 * is NinjaTrader up, are the connections active. Amber when some connections
 * are up and others that should be are not. A click on the client opens the
 * breakdown: the connections, under each its accounts, under each account what
 * it has been doing, the same information the tracker already carries.
 *
 * SIX STATES, FIVE COLOURS, EACH WITH A SENTENCE.
 *
 *   live           green   at least one fresh sample, every fresh account is
 *                          connected, and no device of the client reports an
 *                          error. "Live, 5 accounts connected on 2 connections."
 *   partly         amber   something is connected and something that should be
 *                          is not: a disconnected or silent account beside a
 *                          live one, or a device error beside live accounts.
 *                          "Partly live, 3 connected, 1 disconnected, 1 silent."
 *   silent         amber   every sample is stale and nothing says the connection
 *                          is lost: the sampler has not reported, which is all
 *                          the data shows. Before the open and after the close
 *                          this is every sampled client on the desk.
 *                          "Silent, no sample for 14 hours."
 *   off            red     evidence that nothing is up: the device reports
 *                          NinjaTrader not running, or a fresh sample says
 *                          disconnected and no fresh account is connected. The
 *                          only red on the screen. "Off, 2 accounts disconnected."
 *   never_sampled  brown   a VPS is paired and no account has ever been sampled.
 *   no_vps         grey    no device and no sample. Not a bulb: these clients
 *                          are one folded line under the grid.
 *
 * RED IS EVIDENCE, NOT ABSENCE. A stale sample only says the sampler has not
 * reported; painting it red claimed a lost connection the data did not show,
 * and did so for the whole desk twice a day. Red needs the heartbeat to say
 * NinjaTrader is down, or a fresh sample to say disconnected.
 *
 * WITH OR WITHOUT THE DEVICES. The browser cannot read ingest_devices; a
 * Manager reaches the fleet through /api/admin/ingest-fleet, a CAM is refused.
 * With the devices, "never sampled" means a paired VPS that has sent nothing
 * and "no VPS" means exactly that. Without them, the bulb is derived from the
 * samples and the registry alone, the way the tiles do it: registry accounts
 * and no sample is "never sampled", nothing at all is "no VPS". The view says
 * which of the two it is showing.
 *
 * THE HORIZON IS THE TRACKER'S. A sample is fresh or stale by the same
 * stale_sample_seconds classifyAccountSample reads for every pill; nothing here
 * has a clock threshold of its own.
 *
 * IDENTITY. Samples and devices carry the client's uuid; the app names a client
 * by its legacy key when it has one. Every lookup tries uuid, then id.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

export const BULB_STATES = Object.freeze(['off', 'partly', 'silent', 'never_sampled', 'live', 'no_vps']);

/* The colour, as a word. Red belongs to `off` and to nothing else: "differs
 * from the desk" stays amber on the pills, and partly and silent are amber
 * here (silent is drawn hollow, so the two amber bulbs read apart). */
export const BULB_TONES = Object.freeze({
  live: 'live',
  partly: 'partly',
  silent: 'silent',
  off: 'off',
  never_sampled: 'faint',
  no_vps: 'none',
});

export const BULB_WORDS = Object.freeze({
  live: 'Live',
  partly: 'Partly live',
  silent: 'Silent',
  off: 'Off',
  never_sampled: 'Never sampled',
  no_vps: 'No VPS paired',
});

/* Worst first: off, partly, silent, never sampled, live. no_vps is listed, not lit. */
const BULB_ORDER = Object.freeze({ off: 0, partly: 1, silent: 2, never_sampled: 3, live: 4, no_vps: 5 });

export const DESK_LEGEND = Object.freeze(['live', 'partly', 'silent', 'off', 'never_sampled', 'no_vps']
  .map((state) => ({ state, tone: BULB_TONES[state], word: BULB_WORDS[state] })));

/** The group under the connections for registry accounts nobody has sampled. */
export const NEVER_SAMPLED_GROUP = 'Never sampled';

/** The heartbeat error code that means NinjaTrader itself is down. */
export const NINJATRADER_DOWN = 'ninjatrader_not_running';

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function durationWords(minutes) {
  if (!Number.isInteger(minutes)) return 'a while';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** The heartbeat's error code in words. */
export function deviceErrorWords(code) {
  if (!code) return null;
  if (code === NINJATRADER_DOWN) return 'NinjaTrader not running';
  if (code === 'collector_error') return 'a collector error';
  return String(code).replace(/_/g, ' ');
}

/** The devices still paired: a revoked one is not a VPS of this client. */
export function pairedDevices(devices) {
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device && device.status !== 'revoked' && !device.revokedAt);
}

/* What the client's devices say, as four facts. With one device per client
 * (the fleet route hands back the newest) "online" and "error" are about the
 * same machine; with several, any error counts. */
function deviceSignals(devices) {
  const paired = pairedDevices(devices);
  const errored = paired.find((device) => device.healthStatus === 'error' || device.lastErrorCode);
  const error = errored ? (errored.lastErrorCode || 'collector_error') : null;
  return {
    paired: paired.length > 0,
    online: paired.some((device) => device.healthStatus === 'online'),
    error,
    errorWords: deviceErrorWords(error),
    ninjaDown: paired.some((device) => device.lastErrorCode === NINJATRADER_DOWN),
  };
}

function connectionWords(group) {
  if (group.neverSampled) return `${group.total} on the registry, no sample yet`;
  const head = `${group.live} of ${group.total} connected`;
  return group.silent ? `${head}, ${plural(group.silent, 'silent', 'silent')}` : head;
}

/**
 * The pills grouped by connection, alphabetical, "No connection name" last.
 * Pure over pills: anything with accountName, connectionName and state.
 */
export function groupByConnection(pills) {
  const groups = new Map();
  for (const pill of Array.isArray(pills) ? pills : []) {
    if (!pill || !pill.accountName) continue;
    const name = typeof pill.connectionName === 'string' && pill.connectionName.trim() ? pill.connectionName.trim() : NO_CONNECTION_WORD;
    const group = groups.get(name) || {
      key: name, name, hasName: name !== NO_CONNECTION_WORD, neverSampled: false,
      accounts: [], total: 0, live: 0, disconnected: 0, silent: 0,
    };
    group.accounts.push(pill);
    group.total += 1;
    if (pill.state === 'live') group.live += 1;
    if (pill.state === 'disconnected') group.disconnected += 1;
    if (pill.state === 'sample_stale') group.silent += 1;
    groups.set(name, group);
  }
  return [...groups.values()]
    .sort((left, right) => {
      if (left.hasName !== right.hasName) return left.hasName ? -1 : 1;
      return compareText(left.name, right.name);
    })
    .map((group) => ({
      ...group,
      accounts: [...group.accounts].sort((a, b) => compareText(a.accountName, b.accountName)),
      words: connectionWords(group),
    }));
}

function neverSampledGroup(pills) {
  if (!pills.length) return null;
  const group = {
    key: NEVER_SAMPLED_GROUP, name: NEVER_SAMPLED_GROUP, hasName: false, neverSampled: true,
    accounts: [...pills].sort((a, b) => compareText(a.accountName, b.accountName)),
    total: pills.length, live: 0, disconnected: 0, silent: 0,
  };
  return { ...group, words: connectionWords(group) };
}

function stateOf({ sampled, live, disconnected, silent, registry, device, deviceAware }) {
  if (!sampled) {
    if (deviceAware) {
      if (!device.paired) return 'no_vps';
      return device.ninjaDown ? 'off' : 'never_sampled';
    }
    return registry > 0 ? 'never_sampled' : 'no_vps';
  }
  if (live === 0) {
    // Nothing fresh and connected. Red only on evidence: the heartbeat says
    // NinjaTrader is down, or a fresh sample says disconnected. All stale is
    // silent, amber: the sampler has not reported, and that is all we know.
    if (device?.ninjaDown) return 'off';
    return disconnected > 0 ? 'off' : 'silent';
  }
  if (disconnected > 0 || silent > 0 || (device && device.error)) return 'partly';
  return 'live';
}

function sentenceOf(state, { counts, device, deviceAware, newestSampledAt, ageMinutes }) {
  switch (state) {
    case 'live':
      return `Live, ${plural(counts.live, 'account')} connected on ${plural(counts.connections, 'connection')}.`;
    case 'partly': {
      const parts = [`${counts.live} connected`];
      if (counts.disconnected) parts.push(`${counts.disconnected} disconnected`);
      if (counts.silent) parts.push(`${counts.silent} silent`);
      if (device?.error) parts.push(`VPS reports ${device.errorWords}`);
      return `Partly live, ${parts.join(', ')}.`;
    }
    case 'off': {
      if (device?.ninjaDown) {
        const since = newestSampledAt ? ` since ${cycleClock(newestSampledAt)}` : '';
        return `Off, NinjaTrader not running${since}.`;
      }
      if (!counts.silent) return `Off, ${plural(counts.disconnected, 'account')} disconnected.`;
      return `Off, ${counts.disconnected} disconnected, ${counts.silent} silent.`;
    }
    case 'silent': {
      const head = `Silent, no sample for ${durationWords(ageMinutes)}`;
      return device?.error ? `${head}, VPS reports ${device.errorWords}.` : `${head}.`;
    }
    case 'never_sampled':
      return deviceAware
        ? `Never sampled, VPS paired, ${plural(counts.registry, 'account')} on the registry.`
        : `Never sampled, ${plural(counts.registry, 'account')} on the registry and no sample yet.`;
    default:
      return 'No VPS paired and no sample.';
  }
}

/**
 * One client's bulb, with the breakdown under it.
 *
 * @param {object} client {id, uuid?, name, accountRegistry}
 * @param {object} input
 * @param {object[]} input.samples the client's last account samples (mapped rows).
 * @param {object[]|null} input.devices the client's devices in the fleet route's
 *   public shape ({status, healthStatus, lastSeenAt, lastErrorCode, revokedAt}),
 *   or null when the role cannot read them.
 * @param {boolean} input.deviceAware whether the devices were readable at all.
 * @param {Date|number|string} input.now
 * @param {number} input.staleSeconds the tracker's horizon.
 */
export function buildDeskClientLight(client, { samples = [], devices = null, deviceAware = false, now, staleSeconds = 1500 } = {}) {
  const at = toDate(now) || new Date();
  const list = (Array.isArray(samples) ? samples : []).filter((row) => row && row.accountName);
  const registry = expectedAccountNames(client);
  const registrySet = new Set(registry);
  const sampledNames = new Set(list.map((row) => row.accountName));

  const sampledPills = list.map((sample) => {
    const verdict = classifyAccountSample({ now: at, sample, staleSeconds });
    return {
      ...buildAccountPill({ accountName: sample.accountName, sample, verdict, inRegistry: registrySet.has(sample.accountName), sampleOnly: true }),
      sample,
    };
  });
  const neverPills = registry
    .filter((name) => !sampledNames.has(name))
    .map((accountName) => ({
      ...buildAccountPill({ accountName, sample: null, verdict: classifyAccountSample({ now: at, sample: null, staleSeconds }), inRegistry: true, sampleOnly: true }),
      sample: null,
    }));

  const connections = groupByConnection(sampledPills);
  const never = neverSampledGroup(neverPills);
  const groups = never ? [...connections, never] : connections;

  const counts = {
    sampled: list.length,
    live: sampledPills.filter((pill) => pill.state === 'live').length,
    disconnected: sampledPills.filter((pill) => pill.state === 'disconnected').length,
    silent: sampledPills.filter((pill) => pill.state === 'sample_stale').length,
    neverSampled: neverPills.length,
    registry: registry.length,
    connections: connections.length,
  };
  let newest = null;
  for (const row of list) {
    const stamp = toDate(row.sampledAt);
    if (stamp && (!newest || stamp > newest)) newest = stamp;
  }
  const ageMinutes = newest ? Math.max(0, Math.floor((at.getTime() - newest.getTime()) / 60_000)) : null;
  const device = deviceAware ? deviceSignals(devices) : null;
  const state = stateOf({ ...counts, device, deviceAware });
  const sentence = sentenceOf(state, { counts, device, deviceAware, newestSampledAt: newest, ageMinutes });
  const clientName = client.name || String(client.id);
  return {
    clientId: client.id,
    // The key the rows carry: the uuid, or the id for a client without one.
    clientKey: client.uuid || client.id,
    clientName,
    state,
    tone: BULB_TONES[state],
    word: BULB_WORDS[state],
    sentence,
    title: `${clientName}: ${sentence}`,
    counts,
    device,
    deviceAware,
    connections: groups,
    dots: [...sampledPills, ...neverPills],
    newestSampledAt: newest,
    ageMinutes,
  };
}

/** Off, partly, silent, never sampled, live; alphabetical inside each group. */
export function compareBulbs(left, right) {
  const order = (BULB_ORDER[left.state] ?? 9) - (BULB_ORDER[right.state] ?? 9);
  if (order !== 0) return order;
  return compareText(left.clientName, right.clientName);
}

/** The one line over the grid. */
export function deskWords(counts, ageMinutes) {
  return `${counts.live} live, ${counts.partly} partly live, ${counts.silent} silent, ${counts.off} off, `
    + `${counts.never_sampled} never sampled, ${counts.no_vps} without a VPS. `
    + `Latest sample ${agedWords(ageMinutes)}.`;
}

/**
 * The whole desk, and the one of four states it is in.
 *
 *   unavailable  step 55 has not been run (tracker === null or available false).
 *   no_clients   nothing in the desk to light.
 *   no_samples   nothing has sampled and no VPS is known to be paired.
 *   ready        bulbs, and the folded list of clients without a VPS.
 *
 * @param {{clients: object[], tracker: object|null, devices?: {available?: boolean,
 *   byClientId?: Map<string, object[]>}|null, now: Date|number|string}} input
 */
export function buildDeskClientLights({ clients = [], tracker = null, devices = null, now = Date.now() } = {}) {
  const at = toDate(now) || new Date();
  const list = (Array.isArray(clients) ? clients : []).filter((client) => client && client.id);
  if (!tracker || tracker.available === false) return { kind: 'unavailable', bulbs: [], hidden: [], at, deviceAware: false };
  if (!list.length) return { kind: 'no_clients', bulbs: [], hidden: [], at, deviceAware: false };
  const staleSeconds = Number(tracker.staleSeconds) > 0 ? Number(tracker.staleSeconds) : 1500;
  const byClient = tracker.samplesByClientId instanceof Map ? tracker.samplesByClientId : new Map();
  const deviceAware = Boolean(devices && devices.available === true && devices.byClientId instanceof Map);
  const devicesBy = deviceAware ? devices.byClientId : null;
  const all = list.map((client) => buildDeskClientLight(client, {
    // Rows are keyed by the uuid; `id` is the legacy key when there is one.
    samples: byClient.get(client.uuid) || byClient.get(client.id) || [],
    devices: deviceAware ? (devicesBy.get(client.uuid) || devicesBy.get(client.id) || []) : null,
    deviceAware,
    now: at,
    staleSeconds,
  }));
  const sampledAny = all.some((bulb) => bulb.counts.sampled > 0);
  const pairedAny = all.some((bulb) => bulb.device?.paired);
  if (!sampledAny && !pairedAny) {
    return { kind: 'no_samples', bulbs: [], hidden: [], at, deviceAware, clientsTotal: all.length, minAgentVersion: tracker.minAgentVersion || null };
  }
  const bulbs = all.filter((bulb) => bulb.state !== 'no_vps').sort(compareBulbs);
  const hidden = all.filter((bulb) => bulb.state === 'no_vps').sort((a, b) => compareText(a.clientName, b.clientName));
  const counts = { live: 0, partly: 0, silent: 0, off: 0, never_sampled: 0, no_vps: 0 };
  for (const bulb of all) counts[bulb.state] += 1;
  let newest = null;
  for (const bulb of all) if (bulb.newestSampledAt && (!newest || bulb.newestSampledAt > newest)) newest = bulb.newestSampledAt;
  const ageMinutes = newest ? Math.max(0, Math.floor((at.getTime() - newest.getTime()) / 60_000)) : null;
  return {
    kind: 'ready',
    bulbs,
    hidden,
    counts,
    at,
    deviceAware,
    clientsTotal: all.length,
    newestSampledAt: newest,
    ageMinutes,
    words: deskWords(counts, ageMinutes),
  };
}
