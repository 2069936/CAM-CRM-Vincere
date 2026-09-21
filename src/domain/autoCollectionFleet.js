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
 * shape for a screen is decided: how many, how many the agent will never send
 * again on its own, and for each one whether this CRM holds it as a batch.
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
 */
const RETRYABLE_QUARANTINE_CODES = new Set(['snapshot_processing_failed', 'unsupported_schema_version']);
const QUARANTINE_MAX_ATTEMPTS = 3;
const STORED_TERMINAL_STATES = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);

export function summarizeQuarantine(items = []) {
  const sorted = [...items]
    .filter((item) => item && typeof item === 'object')
    .sort((left, right) => String(right.tradingDate || '').localeCompare(String(left.tradingDate || ''))
      || String(right.quarantinedAt || '').localeCompare(String(left.quarantinedAt || '')));
  return {
    count: sorted.length,
    final: sorted.filter((item) => item.final === true).length,
    items: sorted,
  };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function quarantineHeadline(quarantine) {
  const count = Number(quarantine?.count) || 0;
  if (!count) return '';
  const final = Number(quarantine?.final) || 0;
  const retrying = count - final;
  const head = `${plural(count, 'capture')} in quarantine on the VPS.`;
  const parts = [];
  if (final) parts.push(`${final} ${final === 1 ? 'is' : 'are'} final and ${final === 1 ? 'needs' : 'need'} action here`);
  if (retrying) parts.push(`${retrying} will be retried by the agent at its next daily review`);
  return `${head} ${parts.join('; ')}.`;
}

/* One sentence per capture, for the client drawer: what this CRM holds of
 * it and what the agent will do. The code stays beside it verbatim so the
 * desk can name it on the VPS. */
export function describeQuarantineItem(item = {}) {
  const attempts = Number.isInteger(item.attempts) ? item.attempts : 0;
  const retryable = RETRYABLE_QUARANTINE_CODES.has(item.code);
  let agent;
  if (!item.final) agent = `The agent retries it at its next daily review, attempt ${attempts + 1} of ${QUARANTINE_MAX_ATTEMPTS}.`;
  else if (retryable) agent = `The agent retried it ${QUARANTINE_MAX_ATTEMPTS} times and will not again.`;
  else agent = 'The agent will not retry it.';
  let storage;
  if (!item.stored) storage = 'Never stored here. Only the VPS has this capture.';
  else if (item.stored.status === 'failed') storage = 'Stored here as a failed close. Reprocess it from the failed closes panel.';
  else if (STORED_TERMINAL_STATES.has(item.stored.status)) storage = 'Already processed here. Nothing is missing from this side.';
  else storage = 'Stored here and still being processed.';
  return { storage, agent };
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

export function summarizeFleet(rows = []) {
  return rows.reduce((summary, row) => {
    const state = row.operationalStatus?.state || row.state || 'failed';
    summary.total += 1;
    summary[state] = (summary[state] || 0) + 1;
    if (['late', 'incomplete', 'offline', 'failed', 'update_required'].includes(state)) summary.attention += 1;
    // A quarantine the agent will clear on its own is not the desk's problem
    // yet. One holding a capture it will never send again is.
    if (state === 'quarantine' && Number(row.quarantine?.final) > 0) summary.attention += 1;
    return summary;
  }, { total: 0, attention: 0 });
}
