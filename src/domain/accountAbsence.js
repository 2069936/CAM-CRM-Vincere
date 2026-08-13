// "It exists and it did not report" — the taxonomy, shared.
//
// This file was lifted out of server/export/absentAccounts.js unchanged (that
// module now imports it and re-exports the two constants, so its payload legend
// and its tests are byte-identical). It moved because the client daily report
// needs the SAME five-way split for one client on one close, and the export's
// buildAbsenceIndex cannot serve it: that function takes raw snake_case
// PostgREST rows and the report holds the converted CRM client shape, so calling
// it from the report would mean un-converting rows the browser never had.
//
// What is shared is the part that is a POLICY rather than a query: which five
// things "absent" can mean, and how the earliest date an account can be shown to
// have existed is decided. Both were measured on the real book and getting
// either wrong invents absences that were never there.

/**
 * Why an account is not in a day's `accounts` array.
 *
 * Five, not one, because they call for five different actions: chase the
 * collector, chase the client, look at the account, look at nothing, or look at
 * the calendar. Collapsing them into "absent" would put "registered yesterday"
 * next to "breached and stopped" in the same bucket.
 */
export const ABSENCE_REASONS = {
  NEVER_REPORTED_IN_RANGE: 'never-reported-in-range',
  NOT_YET_REPORTING: 'not-yet-reporting',
  ABSENT_STILL_LIVE: 'absent-still-live',
  ABSENT_FINISHED: 'absent-finished',
  NOT_YET_REGISTERED: 'not-yet-registered',
};

/** Desk-facing prose. Emitted once as the export payload's legend. */
export const ABSENCE_REASON_TEXT = {
  'never-reported-in-range': 'Registered and existed on this day, and filed no snapshot on ANY day of the exported range. Recently wired up, or never wired up at all — this is not evidence that it stopped, because there is nothing it stopped from.',
  'not-yet-reporting': 'Existed on this day and had not filed yet as of this day, but it does file later inside the range. Its first close is still ahead of this date; absence here is a start-up gap, not a stop.',
  'absent-still-live': 'Filed on an earlier day of the range, did not file on this one, and the lifecycle evidence as of this day says it is still live (running / quiet / stale / not enough to say). THIS is "it exists and it did not work today".',
  'absent-finished': 'Filed on an earlier day of the range, did not file on this one, and its last trailing-drawdown reading on or before this day is a breach under its own model (src/domain/accountLifecycle.js). Absence here is the expected end of an account, not a gap to chase.',
  'not-yet-registered': 'Excluded from the absence counts for this day: the earliest date this account can be shown to have existed is AFTER this day, so it could not have filed. Listing it as absent would invent an absence.',
};

/** Where an account's earliest provable existence date came from. */
export const EXISTS_FROM_BASIS = {
  DATE_ADDED: 'date_added',
  FIRST_OBSERVED_REPORT: 'first-observed-report',
  UNKNOWN: 'unknown',
};

export function isoDay(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function nameKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * How an account's start date is decided, and why created_at is not in it.
 *
 * MEASURED ON THE REAL BOOK, because getting this wrong in the manufacturing
 * direction is the worst outcome available here — a bad rule makes every
 * historical day look like a desk that stopped working.
 *
 *   - trading_accounts.created_at is populated on 764 of 764, and is worthless
 *     as a birth date: every value falls in 2026-07-01..2026-07-30 and 573 of
 *     them land on just three days (242 on 07-13, 229 on 07-15, 102 on 07-22).
 *     It is the CRM migration timestamp. 246 of the 720 accounts that ever
 *     appear in a close were "created" AFTER the first close they appear in.
 *   - trading_accounts.date_added is populated on 764 of 764 and is much closer
 *     to a real date, but it is a desk-entry date and it lags: 229 of those 720
 *     accounts carry a date_added LATER than the first close they reported in
 *     (worst gap 3 days). Used alone it contradicts the book 237 times.
 *
 * So neither column alone is trustworthy, and the rule is the earlier of the two
 * things that CAN be evidence:
 *
 *     existsFrom = min(date_added, first date this account was actually observed)
 *
 * An observed close is proof of existence that no column can override. Sweeping
 * the whole book this scores 0 contradictions against 237 for date_added and 339
 * for created_at, and it excludes 374 of 1,583 candidate absences (24%) as
 * not-yet-existing.
 *
 * When neither is available the account is excluded from the absence counts and
 * listed separately with basis 'unknown', never counted as absent. Omitting an
 * absence understates a problem; inventing one manufactures a crisis on every
 * day before the account existed. On this book that case is 0 accounts.
 */
export function existsFrom(dateAdded, firstObservedDate) {
  const added = isoDay(dateAdded);
  const observed = isoDay(firstObservedDate);
  if (added && observed) {
    return added <= observed
      ? { date: added, basis: EXISTS_FROM_BASIS.DATE_ADDED }
      // date_added is later than a close this account is IN. The close wins.
      : { date: observed, basis: EXISTS_FROM_BASIS.FIRST_OBSERVED_REPORT };
  }
  if (added) return { date: added, basis: EXISTS_FROM_BASIS.DATE_ADDED };
  if (observed) return { date: observed, basis: EXISTS_FROM_BASIS.FIRST_OBSERVED_REPORT };
  return { date: null, basis: EXISTS_FROM_BASIS.UNKNOWN };
}
