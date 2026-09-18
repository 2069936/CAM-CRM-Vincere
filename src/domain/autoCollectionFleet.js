const NEW_YORK_TIME_ZONE = 'America/New_York';
const WEEKDAY_NUMBER = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const RECEIVED_BATCH_STATES = new Set(['received', 'processing', 'processed', 'late_closed_day', 'replaced']);

const STATUS_COPY = Object.freeze({
  pending: ['Pending', 'The scheduled capture time has not arrived.'],
  expected: ['Expected', 'Waiting within the normal upload grace period.'],
  received: ['Received', "Today's batch is available."],
  late: ['Late', "Today's batch has not arrived."],
  incomplete: ['Incomplete', 'The latest batch is missing required sections or rows.'],
  offline: ['Offline', 'The VPS has stopped reporting heartbeats.'],
  failed: ['Failed', 'The collector reported an operational error.'],
  revoked: ['Revoked', 'Automatic collection access was revoked.'],
  paused: ['Paused', 'Automatic collection is intentionally paused for this VPS.'],
  update_required: ['Update required', 'The Windows collector must be updated.'],
  not_installed: ['Not installed', 'No VPS is paired with this client.'],
  not_expected: ['Weekend', 'No regular weekday capture is expected.'],
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

function result(state) {
  const [label, detail] = STATUS_COPY[state];
  return { state, label, detail };
}

export function classifyFleetRow({
  now,
  device,
  todayBatch,
  releaseVersion,
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
  if (device.healthStatus === 'error' || device.lastErrorCode) return result('failed');
  if (todayBatch?.status === 'incomplete' || todayBatch?.status === 'failed') return result('incomplete');

  const lastSeen = validDate(device.lastSeenAt);
  if (!lastSeen || current.getTime() - lastSeen.getTime() > offlineMinutes * 60_000) return result('offline');
  if (clock.weekday === 0 || clock.weekday === 6) return result('not_expected');
  if (todayBatch && RECEIVED_BATCH_STATES.has(todayBatch.status)) return result('received');

  const scheduledAt = scheduleMinute(schedule?.time);
  if (clock.minuteOfDay < scheduledAt) return result('pending');
  if (clock.minuteOfDay <= scheduledAt + graceMinutes) return result('expected');
  return result('late');
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
 */
const ACCEPTED_BATCH_STATES = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);

export function summarizeIngestDay(batches = []) {
  let accepted = 0;
  let shed = 0;
  const durations = [];
  for (const batch of batches) {
    if (ACCEPTED_BATCH_STATES.has(batch?.status)) accepted += 1;
    // Tested directly rather than through Number(), which turns a null into a
    // zero: a batch with no measurement would have counted as an upload that
    // took no time at all, which is the one reading this line must never give.
    const deferrals = batch?.admissionDeferrals;
    if (Number.isInteger(deferrals) && deferrals > 0) shed += deferrals;
    const duration = batch?.ingestDurationMs;
    if (Number.isInteger(duration) && duration >= 0) durations.push(duration);
  }
  durations.sort((left, right) => left - right);
  const middle = Math.floor(durations.length / 2);
  return {
    accepted,
    shed,
    measured: durations.length,
    // The lower of the two middles on an even count, rather than their mean: a
    // median that is one of the uploads actually seen is one somebody can go
    // and look at.
    medianMs: durations.length ? durations[durations.length % 2 ? middle : middle - 1] : null,
    slowestMs: durations.length ? durations[durations.length - 1] : null,
  };
}

export function summarizeFleet(rows = []) {
  return rows.reduce((summary, row) => {
    const state = row.operationalStatus?.state || row.state || 'failed';
    summary.total += 1;
    summary[state] = (summary[state] || 0) + 1;
    if (['late', 'incomplete', 'offline', 'failed', 'update_required'].includes(state)) summary.attention += 1;
    return summary;
  }, { total: 0, attention: 0 });
}
