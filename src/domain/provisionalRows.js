/* A ROW THE TRACKER WROTE, NOT THE CLOSE (step 73).
 *
 * When an account traded but the close does not list it (it was disconnected
 * when the 16:30 capture ran, which the AddOn reads as "not relevant"), the
 * database fills the hole from the tracker's reading of the day: an
 * account_snapshot with the realized and unrealized P&L the tracker saw, one
 * strategy row per strategy reading, no fills and no balance. Those rows carry
 * `source: 'tracker'` and are PROVISIONAL: a later capture that lists the
 * account replaces them.
 *
 * Everything that lists a day's accounts says so in the same words, so
 * nobody reads a provisional row as a full close. Every other row, including
 * one read from a database where step 73 has not run, is a capture.
 */

export const TRACKER_SOURCE = 'tracker';
export const CAPTURE_SOURCE = 'capture';

/** The marker, in the words every screen uses. */
export const FROM_TRACKER_LABEL = 'From the tracker, no fills';

/** The stored `source` column, read back: 'tracker' or 'capture', never anything else. */
export function sourceFromRow(value) {
  return value === TRACKER_SOURCE ? TRACKER_SOURCE : CAPTURE_SOURCE;
}

/** Whether a snapshot or strategy row is a provisional one from the tracker. */
export function isFromTracker(row) {
  return row?.source === TRACKER_SOURCE;
}

/** A count of provisional rows in one line, for a table cell: "2 accounts from the tracker, no fills". */
export function fromTrackerCountLabel(count) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? 'account' : 'accounts'} from the tracker, no fills`;
}
