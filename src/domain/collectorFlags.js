import { compareVersions, newYorkTradingClock } from './autoCollectionFleet.js';

/* ------------------------------------------------------------------------- *
 * WHAT IS WRONG WITH THIS CLIENT'S COLLECTION, SAID ON THE PROFILE AND SAID
 * AGAIN WHERE IT CAN BE FIXED.
 *
 * Two things were invisible on the client page.
 *
 * THE AGENT'S VERSION. The heartbeat already sets health_status to
 * 'update_required' and the status endpoint already returns both the device's
 * agent version and the current release, so the CRM has known this on every
 * request and shown it only on the fleet screen, which a CAM does not open.
 *
 * WHAT THE LAST CAPTURE CARRIED. The Connected light is heartbeat-only, and a
 * VPS whose NinjaTrader is closed still checks in every minute. On 2026-09-22,
 * 11 of the 79 clients that captured finished the day with zero trading
 * accounts in the snapshot. The machine was up. It collected nothing.
 *
 * DERIVED, NEVER STORED, WHICH IS WHAT MAKES IT UN-DISMISSABLE. There is no
 * acknowledged column and no dismiss button, because there is no row: the flag
 * is a function of the device, the release and the last batch, recomputed on
 * every load. It goes away when the thing it describes goes away, and not one
 * moment before. A CAM cannot clear it by clicking, and nobody has to remember
 * to raise it again next week.
 *
 * ONE MODULE, TWO SURFACES. The badge in the client header and the lines in
 * the Credentials and Notes card read the same array in the same order, so the
 * header can never claim a flag the card does not show, or stay quiet while
 * the card has something to say.
 * ------------------------------------------------------------------------- */

export const COLLECTOR_FLAG_SEVERITY = Object.freeze({ ALERT: 'alert', WARNING: 'warning' });

// The tab label itself, because that is what onSwitchTab takes. A code that
// had to be mapped to a label somewhere else is one more place for the badge
// and the card to drift apart.
export const COLLECTOR_FLAG_TAB = 'Credentials & Notes';

// A freshly paired VPS has collected nothing yet, and that is what a new
// install looks like, not a fault. The grace is generous on purpose: the
// screen a CAM uses to confirm an install must not go red while they are
// still looking at it.
export const PAIRING_GRACE_MS = 36 * 60 * 60 * 1000;

// How long after the scheduled capture time the desk waits before calling it
// missed. The agent's own window runs from its schedule time to a cutoff 30
// minutes later, and an upload is spread after that, so anything shorter would
// flag a machine that is still working.
export const MISSED_GRACE_MINUTES = 75;

function parseTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function scheduleMinuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function agentOutOfDate(device, release) {
  const installed = device?.agentVersion;
  const current = release?.version;
  if (!installed || !current) return null;
  // compareVersions returns a negative number when the left side is older.
  // Anything else, including a device running something NEWER than the
  // published release, is not a flag: that is a test machine, and telling a
  // CAM to downgrade it would be wrong.
  if (compareVersions(installed, current) >= 0) return null;
  return {
    id: 'agent_out_of_date',
    severity: COLLECTOR_FLAG_SEVERITY.WARNING,
    title: 'Collector needs updating',
    detail: `This VPS is running ${installed} and the current release is ${current}.`
      + ' Update it from this tab so the fixes in the newer build reach this client.',
    tab: COLLECTOR_FLAG_TAB,
  };
}

function collectingNothing(lastBatch) {
  const accounts = lastBatch?.rowCounts?.accounts;
  if (!Number.isInteger(accounts) || accounts > 0) return null;
  const when = lastBatch.tradingDate ? ` on ${lastBatch.tradingDate}` : '';
  return {
    id: 'collecting_nothing',
    severity: COLLECTOR_FLAG_SEVERITY.ALERT,
    title: 'Collected nothing on the last capture',
    detail: `The last capture${when} carried no trading accounts, so the VPS is checking in`
      + ' but NinjaTrader is closed or not connected to the broker. Open NinjaTrader on that'
      + ' machine, connect the broker, then run a test capture from this tab.',
    tab: COLLECTOR_FLAG_TAB,
  };
}

function missedToday(device, lastBatch, now) {
  const clock = newYorkTradingClock(now);
  if (!clock) return null;
  // Saturday and Sunday are 6 and 0; nothing is due.
  if (clock.weekday === 0 || clock.weekday === 6) return null;
  const scheduled = scheduleMinuteOfDay(device?.schedule?.time);
  if (scheduled === null) return null;
  if (clock.minuteOfDay < scheduled + MISSED_GRACE_MINUTES) return null;
  if (lastBatch?.tradingDate === clock.date) return null;
  return {
    id: 'missed_today',
    severity: COLLECTOR_FLAG_SEVERITY.ALERT,
    title: 'No capture today',
    detail: `The capture was due at ${device.schedule.time} New York and nothing has arrived`
      + ' for today. The tool should be running on that VPS right now.',
    tab: COLLECTOR_FLAG_TAB,
  };
}

/**
 * @param {object} status the /api/admin/ingest-status body
 * @param {Date|string|number} now
 * @returns {Array<{id: string, severity: string, title: string, detail: string, tab: string}>}
 */
export function collectorFlags(status, now = new Date()) {
  const device = status?.device || null;
  // No device is not a fault: the client has not been set up yet, and the card
  // already says so in its own words. A revoked device is a deliberate act and
  // is likewise not a fault to raise here.
  if (!device?.id || device.revokedAt) return [];

  const flags = [];
  const update = agentOutOfDate(device, status?.release);
  if (update) flags.push(update);

  // Everything below is about collection, and a machine that has just been
  // paired has not had a chance to collect anything.
  const pairedAt = parseTime(device.createdAt) ?? parseTime(device.lastSeenAt);
  const reference = parseTime(now instanceof Date ? now.toISOString() : now);
  const withinGrace = pairedAt !== null && reference !== null && reference - pairedAt < PAIRING_GRACE_MS;
  if (!withinGrace) {
    const nothing = collectingNothing(status?.lastBatch);
    if (nothing) flags.push(nothing);
    // One at a time. A machine that collected nothing yesterday and nothing
    // today has one problem, not two, and two red lines saying the same thing
    // is how a CAM learns to stop reading them.
    if (!nothing) {
      const missed = missedToday(device, status?.lastBatch, now);
      if (missed) flags.push(missed);
    }
  }

  // Alerts before warnings: "NinjaTrader is not collecting" outranks "there is
  // a newer build", and the badge shows the first one.
  return flags.sort((left, right) => (
    (left.severity === COLLECTOR_FLAG_SEVERITY.ALERT ? 0 : 1)
    - (right.severity === COLLECTOR_FLAG_SEVERITY.ALERT ? 0 : 1)
  ));
}

/** What the badge in the client header says, or null when there is nothing. */
export function collectorFlagBadge(flags = []) {
  if (!flags.length) return null;
  const [first] = flags;
  return {
    severity: first.severity,
    label: flags.length === 1 ? first.title : `${first.title} +${flags.length - 1}`,
    title: flags.map((flag) => flag.title).join(' · '),
    tab: first.tab,
    count: flags.length,
  };
}
