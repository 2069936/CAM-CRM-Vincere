const NEW_YORK_TIME_ZONE = 'America/New_York';
const WEEKDAY_NUMBER = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const RECEIVED_BATCH_STATES = new Set(['received', 'processing', 'processed', 'late_closed_day', 'replaced']);

const STATUS_COPY = Object.freeze({
  pending: ['Pending', 'The scheduled capture time has not arrived.'],
  expected: ['Expected', 'Waiting within the normal upload grace period.'],
  received: ['Received', "Today's batch is available."],
  deferred: ['Held at the door', 'The CRM was full and asked this VPS to come back. Nothing is stored yet; the agent retries on its own.'],
  late: ['Late', "Today's batch has not arrived."],
  incomplete: ['Incomplete', 'The latest batch is missing required sections or rows.'],
  offline: ['Offline', 'The VPS has stopped reporting heartbeats.'],
  failed: ['Failed', 'The collector reported an operational error.'],
  revoked: ['Revoked', 'Automatic collection access was revoked.'],
  paused: ['Paused', 'Automatic collection is intentionally paused for this VPS.'],
  update_required: ['Update required', 'The Windows collector must be updated.'],
  not_installed: ['Not installed', 'No VPS is paired with this client.'],
  not_expected: ['Weekend', 'No regular weekday capture is expected.'],
  quarantine: ['Quarantine', 'The VPS holds captures the CRM refused.'],

  /* THE ACCOUNT LEVEL, one layer down from the machine. Added here rather than in
   * a second module so there is one vocabulary and one voice, and so a reader
   * comparing a machine's sentence with an account's finds them side by side.
   *
   * SIX NEW WORDS, AND EACH IS A DIFFERENT THING TO DO. An account that is
   * disconnected, an account whose VPS cannot be reached, an account whose
   * collector is too old to sample and an account nobody has ever sampled are
   * four different facts, and a light that merges any two of them is worse than
   * no light: the desk acts on the sentence, not on the colour. */
  tracker_off: ['Not sampling yet', 'No collector build sends live samples yet, so nothing here is live.'],
  tracker_unsupported: ['Collector too old to sample', 'This VPS runs a collector build from before live sampling. Its daily close is unaffected.'],
  never_sampled: ['Never sampled', 'This VPS is paired and answering, and no live sample of this account has ever arrived.'],
  sample_stale: ['Silent', 'The VPS is answering heartbeats but has stopped sampling this account.'],
  disconnected: ['Disconnected', 'The VPS is sampling and this account is not connected to its broker.'],
  live: ['Live', 'Sampled within the last few minutes.'],
});

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function newYorkTradingClock(value) {
  const date = validDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    weekday: WEEKDAY_NUMBER[fields.weekday],
    minuteOfDay: Number(fields.hour) * 60 + Number(fields.minute),
  };
}

function scheduleMinute(value = '16:45:00') {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value));
  if (!match) return 16 * 60 + 45;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : 16 * 60 + 45;
}

function versionParts(value) {
  return String(value || '').split('.').map((part) => Number(part));
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function result(state, detail = STATUS_COPY[state][1]) {
  const [label] = STATUS_COPY[state];
  return { state, label, detail };
}

/* WHAT THE VPS HOLDS THAT THE CRM REFUSED.
 *
 * Every capture in queue\quarantine on a VPS is one the desk cannot see from
 * here unless the agent says so, and since 1.0.7 it does, after every daily
 * review. The rows arrive through step 46 and this is the one place their
 * shape for a screen is decided: how many, which of them a person here has
 * to act on, and for each one whether this CRM holds it as a batch.
 *
 * FINAL comes from the row, where step 46 derives it from the agent's own
 * rule. It is never recomputed here: a second copy of the policy would be a
 * second thing to keep in step with the machine.
 *
 * STORED is matched by capture id against the batches the CRM holds. A 422
 * was refused after the storage stage ran, so the raw snapshot is here and a
 * replay from the failed closes panel is the whole fix. A 400, a 413 and every
 * queue level code never reached storage, and saying so is what keeps the
 * desk from looking for a batch that does not exist.
 *
 * WHAT A RESEND GETS. This CRM answers a resend of a close it holds as failed
 * with 409 capture_requires_replay, at the door, and keeps answering that
 * until the close is replayed here. The agent sends such a capture again at
 * every review, without a cap, because the resend after the replay is what
 * clears the VPS (the CRM then answers duplicate). So a capture carrying that
 * code is not final and still needs a person here, which is why attention is
 * counted from the captures and not from `final` alone.
 */
const CAPPED_QUARANTINE_CODES = new Set(['snapshot_processing_failed', 'unsupported_schema_version']);
const AWAITING_REPLAY_CODE = 'capture_requires_replay';
const QUARANTINE_MAX_ATTEMPTS = 3;
const STORED_TERMINAL_STATES = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);

function processedHere(item) {
  return STORED_TERMINAL_STATES.has(item?.stored?.status);
}

/* Whether a person on this side has to act for the capture to leave the VPS.
 * A capture this CRM has already processed needs nothing here: the agent's
 * next resend clears it, or the VPS keeps a file of a day this side is not
 * missing. A final capture needs a look. A close the CRM holds as failed
 * needs the replay, and the agent's resend only clears the VPS afterwards. */
export function quarantineNeedsDesk(item = {}) {
  if (processedHere(item)) return false;
  return item.final === true || item.code === AWAITING_REPLAY_CODE;
}

export function summarizeQuarantine(items = []) {
  const sorted = [...items]
    .filter((item) => item && typeof item === 'object')
    .sort((left, right) => String(right.tradingDate || '').localeCompare(String(left.tradingDate || ''))
      || String(right.quarantinedAt || '').localeCompare(String(left.quarantinedAt || '')));
  return {
    count: sorted.length,
    final: sorted.filter((item) => item.final === true).length,
    attention: sorted.filter(quarantineNeedsDesk).length,
    items: sorted,
  };
}

/* The four kinds a capture can be, counted once each, for the sentences the
 * chip, the drawer and the client card build. `stored` is known on the fleet
 * view and absent on the client card, where nothing is processed here. */
export function quarantineCounts(quarantine) {
  const items = Array.isArray(quarantine?.items) ? quarantine.items : [];
  const counts = { count: Number(quarantine?.count) || items.length, processed: 0, final: 0, awaitingReplay: 0, retrying: 0 };
  for (const item of items) {
    if (processedHere(item)) counts.processed += 1;
    else if (item.final === true) counts.final += 1;
    else if (item.code === AWAITING_REPLAY_CODE) counts.awaitingReplay += 1;
    else counts.retrying += 1;
  }
  return counts;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function quarantineHeadline(quarantine) {
  const counts = quarantineCounts(quarantine);
  if (!counts.count) return '';
  const head = `${plural(counts.count, 'capture')} in quarantine on the VPS.`;
  const parts = [];
  const { final, awaitingReplay, retrying, processed } = counts;
  if (final) parts.push(`${final} ${final === 1 ? 'is' : 'are'} final and ${final === 1 ? 'needs' : 'need'} action here`);
  if (awaitingReplay) parts.push(`${awaitingReplay} ${awaitingReplay === 1 ? 'waits' : 'wait'} for a replay here and ${awaitingReplay === 1 ? 'is' : 'are'} sent again by the agent until then`);
  if (retrying) parts.push(`${retrying} will be retried by the agent at its next daily review`);
  if (processed) parts.push(`${processed} already processed here`);
  return parts.length ? `${head} ${parts.join('; ')}.` : head;
}

/* One sentence per capture, for the client drawer: what this CRM holds of
 * it and what the agent will do. The code stays beside it verbatim so the
 * desk can name it on the VPS. `label` is the short form for the row and
 * `note` the one for a tooltip. */
export function describeQuarantineItem(item = {}) {
  const attempts = Number.isInteger(item.attempts) ? item.attempts : 0;
  const capped = CAPPED_QUARANTINE_CODES.has(item.code);
  let label;
  let note;
  let agent;
  if (processedHere(item)) {
    label = 'Processed here';
    note = 'processed here';
    agent = item.final
      ? 'The agent will not send it again; the VPS keeps a file of a day this side is not missing.'
      : 'The agent sends it again at its next daily review, and the answer clears it from the VPS.';
  } else if (item.final) {
    label = 'Final on the VPS';
    note = 'final';
    agent = capped ? `The agent retried it ${QUARANTINE_MAX_ATTEMPTS} times and will not again.` : 'The agent will not retry it.';
  } else if (item.code === AWAITING_REPLAY_CODE) {
    label = 'Waiting for a replay here';
    note = 'sent again until replayed here';
    agent = `The agent sends it again at its next daily review${attempts ? `, ${attempts} ${attempts === 1 ? 'time' : 'times'} so far` : ''}; the answer will not change until the close is replayed here, and the resend after that clears it from the VPS.`;
  } else {
    label = 'Agent will retry';
    note = `attempt ${attempts + 1} of ${QUARANTINE_MAX_ATTEMPTS} next`;
    agent = `The agent retries it at its next daily review, attempt ${attempts + 1} of ${QUARANTINE_MAX_ATTEMPTS}.`;
  }
  let storage;
  if (!item.stored) storage = 'Never stored here. Only the VPS has this capture.';
  else if (item.stored.status === 'failed') storage = 'Stored here as a failed close. Reprocess it from the failed closes panel.';
  else if (STORED_TERMINAL_STATES.has(item.stored.status)) storage = 'Already processed here. Nothing is missing from this side.';
  else storage = 'Stored here and still being processed.';
  return { label, note, storage, agent };
}

export function classifyFleetRow({
  now,
  device,
  todayBatch,
  releaseVersion,
  quarantine = null,
  schedule = device?.schedule,
  graceMinutes = 15,
  offlineMinutes = 10,
} = {}) {
  const current = validDate(now);
  const clock = newYorkTradingClock(current);
  if (!current || !clock) return result('failed');

  if (!device) return result('not_installed');
  if (device.status === 'revoked' || device.revokedAt) return result('revoked');
  if (device.status !== 'active') return result('paused');
  if (device.healthStatus === 'update_required'
    || (releaseVersion && device.agentVersion && compareVersions(device.agentVersion, releaseVersion) < 0)) {
    return result('update_required');
  }
  // A capture the door turned away is not a collector failure and not a
  // received day. The agent reports ingest_at_capacity while it waits, and
  // the batch row sits in 'received' with a deferral count and no storage
  // object behind it. Both read as their own state, before the generic
  // failure and received checks below can claim them.
  if (device.lastErrorCode === 'ingest_at_capacity') return result('deferred');
  if (device.healthStatus === 'error' || device.lastErrorCode) return result('failed');
  if (todayBatch?.status === 'received' && Number(todayBatch.admissionDeferrals) > 0) return result('deferred');
  if (todayBatch?.status === 'incomplete' || todayBatch?.status === 'failed') return result('incomplete');

  const lastSeen = validDate(device.lastSeenAt);
  if (!lastSeen || current.getTime() - lastSeen.getTime() > offlineMinutes * 60_000) return result('offline');
  const weekend = clock.weekday === 0 || clock.weekday === 6;
  const todayReceived = Boolean(todayBatch) && RECEIVED_BATCH_STATES.has(todayBatch.status);
  const scheduledAt = scheduleMinute(schedule?.time);
  // Today's batch missing past the grace period is the newer fact and keeps
  // its word; the row's chip still says what the folder holds.
  if (!weekend && !todayReceived && clock.minuteOfDay > scheduledAt + graceMinutes) return result('late');
  // Older than today and the one thing on this row a person may have to act
  // on, so it outranks a day that arrived and a day that is still to come.
  if (Number(quarantine?.count) > 0) return result('quarantine', quarantineHeadline(quarantine));
  if (weekend) return result('not_expected');
  if (todayReceived) return result('received');
  if (clock.minuteOfDay < scheduledAt) return result('pending');
  return result('expected');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE ACCOUNT TRAFFIC LIGHT.
 *
 * WHAT IT IS FOR. Everything above answers "did today's close arrive". Nothing
 * answers "what is happening now". Between the open and 16:45 the CRM says `$0
 * today` on every briefing card, because the close has not happened, and the
 * live accounts panel reads from the last close, which on this book can be
 * twelve days old. The desk's own morning question is smaller than any of that:
 * which accounts are alive, which are running, and roughly how the day is going.
 *
 * Step 55 stores the last sample of each account. These two functions are the
 * only place its shape for a screen is decided.
 *
 * TWO FUNCTIONS, BECAUSE THE TWO SURFACES KNOW DIFFERENT THINGS, and pretending
 * otherwise is how the four states get merged.
 *
 *   classifyAccountSample  what the SAMPLE ALONE says. The browser reads
 *     account_live_samples directly under step 52's predicate - one PostgREST
 *     request for a whole book, no serverless invocations - and it cannot read
 *     ingest_devices, which step 28 shut to the browser key. So from a sample
 *     row alone there are four honest answers and no more: live, disconnected,
 *     silent, and nothing-ever-arrived.
 *
 *   classifyAccountTracker  the same question with the DEVICE in hand. Only
 *     /api/admin/ingest-status has that, and it is per client, which is exactly
 *     right for the client workspace and exactly wrong for a 37-client overview.
 *     With the device it can also separate "the collector is too old to sample"
 *     from "paired, answering, and this account has never been sampled" from
 *     "the machine has stopped answering at all" - three facts that look
 *     identical from the sample table, because all three are an absent row.
 *
 * WHAT IT DELIBERATELY DOES NOT INHERIT FROM THE MACHINE.
 *
 *   `failed`. device.lastErrorCode paints a fleet row Failed, and reading it
 *   here would paint every account on a machine red for a capture fault that
 *   says nothing about whether the account is sampling. If the machine really
 *   cannot be reached, `offline` and `sample_stale` say so from evidence. The
 *   tracker must not write those device fields either, and it does not: that is
 *   the whole reason it has its own endpoint and its own table.
 *
 *   `not_expected`. The weekend is about the daily batch. A machine still beats
 *   and still samples on Saturday, and "no capture expected" would be false
 *   about a live account.
 *
 *   `update_required`. The header badge and the collector card already say the
 *   collector must be updated, with a sentence about the collector. Here the
 *   precise sentence is tracker_unsupported's, which names the sampling and says
 *   the daily close is unaffected - because it is, and a CAM reading "update
 *   required" twice learns to read it never.
 *
 * ATTENTION IS COUNTED NARROWLY, from what the tracker uniquely knows:
 * disconnected, silent, never_sampled. not_installed, revoked, paused, offline
 * and the two tracker_* states are fleet facts the fleet view and the collector
 * card already raise, and counting them twice is how a count stops being read.
 * ──────────────────────────────────────────────────────────────────────────── */

/* FOUR WORDS, AND THE FOURTH IS WHY THIS IS NOT A COPY OF THE CLOSE'S THREE.
 *
 * The first three are src/domain/liveAccounts.js:268-269's, because it is the
 * same question. `unmeasured` is not `idle`: "nobody looked" and "the desk
 * switched everything off" lead to opposite actions, and 121 of 457 accounts on
 * this book carry no strategy row at all.
 *
 * `no_strategies` IS THE ONE A CLOSE CANNOT HAVE. By 16:45 the desk has switched
 * the algos off and NinjaTrader has removed them from the account, so every
 * account looks empty and "measured and empty" is not a distinction a close can
 * draw. A mid-day sample can, and step 55 now stores it: (0, 0) is a
 * measurement, (null, null) is not, and the collector's StrategyLiveCount
 * deliberately sends the pair so the wire says which happened.
 *
 * This file shipped with those two folded into `unmeasured`, so an account the
 * VPS HAD measured and found empty got the sentence "the sample carried no
 * strategy count" - which is false about a sample that carried (0, 0), and false
 * about every account on the fleet overnight and before the open. Four facts,
 * four sentences, each true of exactly one of them. */
const ACCOUNT_RUN_STATES = Object.freeze({
  running: ['running', 'strategies are enabled on this account right now'],
  idle: ['all off', 'strategies are loaded and every one of them is switched off'],
  no_strategies: ['none loaded', 'the VPS read this account and it has no strategies loaded at all. Measured, and nothing to run.'],
  unmeasured: ['no strategy data', 'the sample carried no strategy count. Not measured - not zero.'],
});

export const ACCOUNT_TRACKER_ATTENTION_STATES = Object.freeze(
  new Set(['disconnected', 'sample_stale', 'never_sampled']),
);

/* EVERY STATE classifyAccountTracker CAN RETURN, enumerated here so the agreement
 * test can be exhaustive BY CONSTRUCTION rather than by somebody remembering.
 *
 * This list exists because of how the two-screens defect was fixed the first time.
 * The version-gate case was found, a test was written that rendered that row
 * through both screens at six row shapes and six versions - and `offline` and
 * `revoked`, which have the same shape and the same bug, were simply not among the
 * cases it tried. They shipped broken behind a green test named for the invariant
 * they violate.
 *
 * A state added to classifyAccountTracker and not to the agreement test now fails
 * that test by name. That is the only version of this that does not depend on the
 * next person noticing. */
export const ACCOUNT_TRACKER_STATES = Object.freeze([
  'not_installed',
  'revoked',
  'paused',
  'tracker_off',
  'offline',
  'tracker_unsupported',
  'never_sampled',
  'sample_stale',
  'disconnected',
  'live',
]);

/** The three words and the tooltip behind them, for whichever panel is asking. */
export function accountRunStateCopy(runState) {
  const [label, detail] = ACCOUNT_RUN_STATES[runState] || ACCOUNT_RUN_STATES.unmeasured;
  return { runState: ACCOUNT_RUN_STATES[runState] ? runState : 'unmeasured', label, detail };
}

function trackerResult(state, extra = {}) {
  const [label, detail] = STATUS_COPY[state];
  return {
    state,
    label,
    detail: extra.detail || detail,
    attention: ACCOUNT_TRACKER_ATTENTION_STATES.has(state),
    ageMinutes: extra.ageMinutes ?? null,
    sampledAt: extra.sampledAt ?? null,
    runState: extra.runState ?? null,
  };
}

function minutesBetween(later, earlier) {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 60_000));
}

/* `new Date(null)` IS THE EPOCH, NOT AN INVALID DATE, and validDate above
 * therefore accepts a null as 1 January 1970. For a heartbeat that accident
 * lands on the right answer, because a 56-year-old beat reads offline either
 * way. Here it is the difference between "this account has never been sampled"
 * and "the VPS stopped sampling it 29 million minutes ago", which is the
 * difference between a true sentence and a ridiculous one. */
function sampleClock(value) {
  if (value instanceof Date) return validDate(value);
  if (typeof value !== 'string' || value.trim() === '') return null;
  return validDate(value);
}

function agedSentence(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * What one sample row says on its own.
 *
 * `staleSeconds` comes from account_tracker_settings and is never a constant
 * here. The fleet view's ten minutes is a heartbeat threshold at a one minute
 * beat - a 10x margin - and reusing that NUMBER against a ten minute sample
 * interval would put every healthy sample on the boundary, so one slow close
 * paints a live account silent. Step 55's CHECK keeps the stored value at least
 * twice the interval; this is only the reader.
 *
 * @param {{now: Date|string|number, sample: object|null, staleSeconds: number}} input
 */
export function classifyAccountSample({ now, sample = null, staleSeconds = 1500 } = {}) {
  const current = validDate(now);
  if (!current) return trackerResult('never_sampled');
  if (!sample) return trackerResult('never_sampled');
  const sampledAt = sampleClock(sample.sampledAt);
  // A row with an unreadable clock is a row that cannot be aged, and a tracker
  // that cannot age a reading has nothing to say about it.
  if (!sampledAt) return trackerResult('never_sampled');
  const ageMinutes = minutesBetween(current, sampledAt);
  const runState = accountRunStateCopy(sample.runState).runState;
  const horizon = Number.isFinite(Number(staleSeconds)) && Number(staleSeconds) > 0
    ? Number(staleSeconds) : 1500;
  const shared = { ageMinutes, sampledAt: sample.sampledAt, runState };
  if (current.getTime() - sampledAt.getTime() > horizon * 1000) {
    return trackerResult('sample_stale', {
      ...shared,
      detail: `The VPS last sampled this account ${agedSentence(ageMinutes)}.`,
    });
  }
  if (sample.connected !== true) {
    return trackerResult('disconnected', {
      ...shared,
      // The platform's own word stays beside the sentence rather than replacing
      // it, so the desk reads what to do AND can name the state on the VPS.
      detail: sample.status
        ? `${STATUS_COPY.disconnected[1]} NinjaTrader reports it as ${sample.status}.`
        : STATUS_COPY.disconnected[1],
    });
  }
  return trackerResult('live', { ...shared, detail: `Sampled ${agedSentence(ageMinutes)}.` });
}

/**
 * The same question with the device in hand, which is the only way the four
 * states stay four.
 *
 * THE BUG THIS ORDER EXISTS TO MAKE IMPOSSIBLE. The version gate used to be the
 * FIRST question, above the sample, so with min_agent_version NULL - the value
 * step 55 ships with, and the whole of its inertness mechanism - this screen and
 * the CAM Overview said contradictory things about the same row in the same
 * minute. Measured: one row, device agentVersion 1.6.0, heartbeat 20 seconds old,
 * sample 2 minutes old, connected, running, $1,024.31. This screen: "Not sampling
 * yet - No collector build sends live samples yet, so nothing here is live."
 * The overview: "Live - Sampled 2 minutes ago", tone running, "$1,024 across the
 * 1 account that reported a figure." And this screen was the one that was wrong.
 *
 * SO THE READING IS TAKEN FIRST, through the same classifyAccountSample the
 * overview runs, and the two tracker_* sentences - both of which are claims about
 * the ABSENCE of sampling - can only be reached when there is no reading to
 * falsify them. The gate is evaluated in exactly ONE line below and nowhere else
 * in this file.
 *
 * @param {object} input
 * @param {Date|string|number} input.now
 * @param {object|null|undefined} input.device the ingest-status device, or null
 *   when no VPS is paired with this client.
 * @param {object|null} input.sample this account's row from account_live_samples.
 * @param {boolean} input.deviceHasSamples whether ANY account on this device has
 *   a row, which is what separates "this account has never been sampled" from
 *   "this machine has never sampled anything".
 */
export function classifyAccountTracker({
  now,
  device = null,
  sample = null,
  deviceHasSamples = false,
  trackerMinAgentVersion = null,
  staleSeconds = 1500,
  offlineMinutes = 10,
} = {}) {
  const current = validDate(now);
  if (!current) return trackerResult('never_sampled');

  /* THE READING, TAKEN THROUGH THE SAME FUNCTION THE OVERVIEW RUNS, before any
   * question that could talk over it. `never_sampled` out of there means there is
   * nothing readable to age - no row at all, or a row whose clock cannot be read -
   * so `reading` is null exactly when this screen has nothing of its own to show
   * and the device has to answer instead. */
  const verdict = classifyAccountSample({ now, sample, staleSeconds });
  const reading = verdict.state === 'never_sampled' ? null : verdict;

  /* AND THE READING'S OWN FACTS TRAVEL WITH EVERY STATE, WHICH IS A SEPARATE
   * THING FROM WHICH STATE IS CHOSEN.
   *
   * THE DEFECT: `offline` and `revoked` were returned as `trackerResult('offline')`
   * with no extra, so `ageMinutes`, `sampledAt` and `runState` all came back null -
   * while AccountTrackerPanel's row reads the money straight off `sample.totalPnl`
   * on a different path. One row, a 2-minute-old sample carrying $1,024.31 and a
   * 40-minute-old heartbeat, printed `$1,024` and `never` on the SAME LINE, and
   * the overview printed "Sampled 2 minutes ago" for it.
   *
   * `state`, `label` and `detail` are the client page's to decide, and it is
   * RIGHT that they differ: the machine not answering outranks the reading it left
   * behind, and that extra fact is what having the device is for. But when the
   * sample was read is a property OF THE SAMPLE. It does not become unknown
   * because the machine has since gone quiet, and a screen holding the row cannot
   * answer "never" about a row it is printing money from.
   *
   * So the device-level states below carry the reading's three facts and override
   * only the words. The states that mean there is no reading pass nothing, because
   * for them null is the true answer - and they are reachable only when `reading`
   * is null anyway, which the agreement test asserts for every state rather than
   * trusting this comment. */
  const readingFacts = reading
    ? { ageMinutes: reading.ageMinutes, sampledAt: reading.sampledAt, runState: reading.runState }
    : {};

  if (!device) return trackerResult('not_installed', readingFacts);
  if (device.status === 'revoked' || device.revokedAt) return trackerResult('revoked', readingFacts);
  if (device.status !== 'active') return trackerResult('paused', readingFacts);

  /* ── THE VERSION GATE, EVALUATED HERE AND IN NO OTHER LINE OF THIS FILE ──
   *
   * Its sentence is "No collector build sends live samples yet", so the one thing
   * that can falsify it is evidence that a collector IS sampling - this account's
   * own reading, or a reading for any other account on this machine. With either
   * of those in hand the gate has nothing to say and does not get to speak. That
   * is the whole of the fix: the gate used to be the FIRST question, so a fresh
   * row sitting in the table could not reach the screen and the client page said
   * "nothing here is live" about a row the overview was printing as Live with
   * $1,024 against it.
   *
   * ABOVE `offline` DELIBERATELY, AND ONLY WHEN NOTHING IS SAMPLING. On the day
   * step 55 is run, a machine that is also dark and also behind the release still
   * reads "Not sampling yet", because "fix the VPS and the light comes on" would
   * be false - nothing is expected of any machine until Pedro names a build. Once
   * something IS expected, a dark machine is the honest explanation for a missing
   * reading and `offline` says so below. */
  const samplingSeen = Boolean(reading) || deviceHasSamples === true;
  if (!samplingSeen && !trackerMinAgentVersion) return trackerResult('tracker_off');

  /* THE MACHINE NOT ANSWERING OUTRANKS THE READING IT LEFT BEHIND, which is the
   * one place the client page deliberately says more than the overview can: a
   * 40-minute-old heartbeat beside a 2-minute-old sample reads "The VPS has
   * stopped reporting heartbeats" here and "Sampled 2 minutes ago" there. Both
   * true, neither contradicting the other, and the extra fact is what having the
   * device is for. */
  const lastSeen = validDate(device.lastSeenAt);
  if (!lastSeen || current.getTime() - lastSeen.getTime() > offlineMinutes * 60_000) {
    return trackerResult('offline', readingFacts);
  }

  if (reading) return reading;

  /* NO READING FOR THIS ACCOUNT, AND THE MACHINE IS SAMPLING OTHERS - which on
   * the collector side is what an account dropped by the relevance filter looks
   * like. Asked before the version, because a machine that is sending readings
   * demonstrably runs a build that samples, and "runs a collector build from
   * before live sampling" would be false about it. */
  if (deviceHasSamples) {
    return trackerResult('never_sampled', {
      detail: 'This VPS is sampling other accounts and has never sent this one.',
    });
  }

  /* A build IS named - the gate above returned otherwise - and this machine has
   * sent nothing at all. An agent that has never said its version is treated as
   * old, not as new: the collector's own csproj left <Version> undeclared until
   * 1.1.3, so a build from last quarter and one from today are indistinguishable
   * on this field, and assuming new would claim a machine can sample when it
   * cannot. */
  if (!device.agentVersion
    || compareVersions(device.agentVersion, trackerMinAgentVersion) < 0) {
    return trackerResult('tracker_unsupported');
  }
  return trackerResult('never_sampled');
}

/**
 * One client's accounts, rolled up for the overview card.
 *
 * Counted from the rows the browser can see, which is why it takes a verdict
 * per row rather than a device: see the two-functions note above.
 */
export function summarizeAccountTracker(samples = [], { now, staleSeconds = 1500 } = {}) {
  const rows = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample && typeof sample === 'object')
    .map((sample) => ({ sample, verdict: classifyAccountSample({ now, sample, staleSeconds }) }));
  const summary = {
    total: rows.length,
    live: 0,
    disconnected: 0,
    silent: 0,
    running: 0,
    idle: 0,
    no_strategies: 0,
    unmeasured: 0,
    attention: 0,
    totalPnl: null,
    measuredPnl: 0,
    newestSampledAt: null,
    rows,
  };
  for (const { sample, verdict } of rows) {
    if (verdict.state === 'live') summary.live += 1;
    if (verdict.state === 'disconnected') summary.disconnected += 1;
    if (verdict.state === 'sample_stale') summary.silent += 1;
    if (verdict.attention) summary.attention += 1;
    /* RUN STATES ARE COUNTED FOR LIVE ACCOUNTS ONLY, and the two exclusions are
     * different arguments.
     *
     * A SILENT account's last known "running" is a claim about a machine that
     * has stopped answering, and the desk would read it as now.
     *
     * A DISCONNECTED account's strategies may well be enabled, and the row shows
     * that - but they cannot trade, and "N of M running" is the number Pedro
     * reads to see what the desk is doing. Counting it here would overstate
     * exactly that. It is already counted once, as disconnected.
     *
     * So running + idle + unmeasured is `live`, not `total`, and anything else
     * is in its own count. */
    if (verdict.state === 'live') {
      summary[verdict.runState] = (summary[verdict.runState] || 0) + 1;
    }
    /* Tested against null rather than coerced with Number(), which turns a null
     * into a zero: an account that reported no P&L would be counted as an
     * account that made nothing, and `measuredPnl` exists so the screen can say
     * how many of the accounts the figure is actually about. */
    const pnl = sample.totalPnl;
    if (typeof pnl === 'number' && Number.isFinite(pnl) && verdict.state !== 'sample_stale') {
      summary.totalPnl = (summary.totalPnl ?? 0) + pnl;
      summary.measuredPnl += 1;
    }
    const sampledAt = sampleClock(sample.sampledAt);
    if (sampledAt && (!summary.newestSampledAt || sampledAt > summary.newestSampledAt)) {
      summary.newestSampledAt = sampledAt;
    }
  }
  return summary;
}

/** The one line the overview card and the panel header both print. */
export function accountTrackerHeadline(summary) {
  if (!summary || !summary.total) return '';
  const parts = [];
  if (summary.running) parts.push(`${summary.running} running`);
  if (summary.idle) parts.push(`${summary.idle} all off`);
  /* Said separately from `not measured`, because they were one number until step
   * 55 grew a fourth run state and the merged number made a flat desk read as an
   * unmeasured one every morning before the open. */
  if (summary.no_strategies) parts.push(`${summary.no_strategies} with nothing loaded`);
  if (summary.unmeasured) parts.push(`${summary.unmeasured} not measured`);
  if (summary.disconnected) parts.push(`${summary.disconnected} disconnected`);
  if (summary.silent) parts.push(`${summary.silent} silent`);
  const head = `${summary.total} account${summary.total === 1 ? '' : 's'} sampled`;
  return parts.length ? `${head}: ${parts.join(', ')}.` : `${head}.`;
}

/* WHAT THE INGEST COST TODAY, IN ONE LINE.
 *
 * The question "is the upload slow?" was answered for two days by reading a
 * Supabase dashboard after the fact and inferring. Step 45 stores the time each
 * upload took on its own batch row, and the fleet view already loads every one
 * of the selected day's batches to decide each client's status, so this reads
 * numbers that are already in memory rather than asking the database anything
 * new.
 *
 * ACCEPTED counts uploads the CRM took in and stored: the four terminal success
 * states. A batch still sitting in 'received' has not been accepted yet and a
 * 'failed' one was not accepted at all, so neither is counted here.
 *
 * SHED counts door firings, not machines: a capture turned away three times
 * before it got in contributes three. That is the number that says whether the
 * cap is set right, which a count of distinct machines would not.
 *
 * MEDIAN AND SLOWEST come from the batches that carry a measurement. Before the
 * migration runs there are none, and every field but the two counts is null
 * rather than zero: nothing measured is not the same as measured as fast.
 *
 * SLOWEST STAGE is where the slowest upload spent its time, so the line can say
 * "mostly persist" instead of leaving the reader to open the SQL editor, which
 * is the exact activity this line exists to end.
 */
const ACCEPTED_BATCH_STATES = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);

export function summarizeIngestDay(batches = []) {
  let accepted = 0;
  let shed = 0;
  const durations = [];
  let slowest = null;
  for (const batch of batches) {
    if (ACCEPTED_BATCH_STATES.has(batch?.status)) accepted += 1;
    // Tested directly rather than through Number(), which turns a null into a
    // zero: a batch with no measurement would have counted as an upload that
    // took no time at all, which is the one reading this line must never give.
    const deferrals = batch?.admissionDeferrals;
    if (Number.isInteger(deferrals) && deferrals > 0) shed += deferrals;
    const duration = batch?.ingestDurationMs;
    if (Number.isInteger(duration) && duration >= 0) {
      durations.push(duration);
      if (!slowest || duration > slowest.ms) slowest = { ms: duration, stages: batch.stageDurationsMs || null };
    }
  }
  durations.sort((left, right) => left - right);
  const middle = Math.floor(durations.length / 2);
  let slowestStage = null;
  if (slowest?.stages) {
    const [name, ms] = Object.entries(slowest.stages).sort((a, b) => b[1] - a[1])[0] || [];
    if (name && Number.isInteger(ms)) slowestStage = { name, ms };
  }
  return {
    accepted,
    shed,
    measured: durations.length,
    // The lower of the two middles on an even count, rather than their mean: a
    // median that is one of the uploads actually seen is one somebody can go
    // and look at.
    medianMs: durations.length ? durations[durations.length % 2 ? middle : middle - 1] : null,
    slowestMs: durations.length ? durations[durations.length - 1] : null,
    slowestStage,
  };
}

const ATTENTION_STATES = new Set(['late', 'incomplete', 'offline', 'failed', 'update_required']);

export function summarizeFleet(rows = []) {
  return rows.reduce((summary, row) => {
    const state = row.operationalStatus?.state || row.state || 'failed';
    summary.total += 1;
    summary[state] = (summary[state] || 0) + 1;
    // A quarantine the agent will clear on its own is not the desk's problem
    // yet; one holding a capture only a person here can move is, whatever
    // the row says about today. Counted from the quarantine itself rather
    // than from the state, so a row held at the door this afternoon does not
    // drop out of the count for as long as the deferral lasts, and a row
    // already counted for being late is counted once.
    if (ATTENTION_STATES.has(state) || Number(row.quarantine?.attention) > 0) summary.attention += 1;
    return summary;
  }, { total: 0, attention: 0 });
}
