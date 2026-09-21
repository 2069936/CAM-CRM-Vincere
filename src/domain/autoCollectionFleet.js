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
