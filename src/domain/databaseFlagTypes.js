/* ────────────────────────────────────────────────────────────────────────────
 * THE FLAGS THE DATABASE WRITES ITSELF, by type, and what each one asks.
 *
 * Most flag types in operational_flags are written by reconcile.js while a
 * close is imported. These five are written by refresh_account_observations
 * (supabase/step_65 and step_71) when a close lands, and by the trigger on
 * account_live_samples (step 71) when the tracker samples an account. The
 * browser never generates them; it shows them, and the CAM flag queue says in
 * a hover what each one means.
 *
 * Since step 71 a breach on the close is a SUSPICION, not a death: the close
 * marks an account Failed only when later closes confirm it (missing from the
 * closes, or not trading while its algorithm trades on other clients'
 * accounts), and it sets back an account it failed that trades afterwards.
 *
 * The step 71 cluster test reads the types the database actually wrote and
 * compares them with this list, so the two languages cannot drift apart.
 * ──────────────────────────────────────────────────────────────────────────── */

export const DATABASE_FLAG_TYPES = Object.freeze({
  MARKED_FAILED: 'Marked Failed by the close',
  BREACH_SUSPECTED: 'Breach suspected',
  REACTIVATED: 'Reactivated by the close',
  FAILED_ACCOUNT_TRADED: 'Failed account traded',
  STRATEGIES_STILL_LOADED: 'Strategies still loaded',
});

/** One sentence per type, for the hover on a flag group's heading. */
export const DATABASE_FLAG_HINTS = Object.freeze({
  [DATABASE_FLAG_TYPES.MARKED_FAILED]:
    'The close marked this account Failed. Since step 71 that needs a breach confirmed by later closes: missing from them, or not trading while its algorithm traded on other clients\' accounts.',
  [DATABASE_FLAG_TYPES.BREACH_SUSPECTED]:
    'The latest trailing reading is past the drawdown rule. The account stays as it is until later closes confirm the breach.',
  [DATABASE_FLAG_TYPES.REACTIVATED]:
    'The close had marked this account Failed and it traded afterwards, so the close set its status back.',
  [DATABASE_FLAG_TYPES.FAILED_ACCOUNT_TRADED]:
    'This account is marked Failed and traded after its failure date. Nothing was changed: a person decides.',
  [DATABASE_FLAG_TYPES.STRATEGIES_STILL_LOADED]:
    'This account is Failed and has not traded since, but NinjaTrader still shows strategies enabled on it.',
});

/* THE THREE A CLOSE WRITES WHEN IT MERGES OR THE TRACKER FILLS IT (step 73).
 *
 * Kept apart from the five above on purpose: those are the account
 * observation flags, and the step 71 cluster test holds that list to exactly
 * what refresh_account_observations writes. These are written by
 * persist_auto_daily_import, when a later capture showed nothing for an
 * account the day had seen trade, and by fill_daily_import_from_tracker, when
 * the tracker saw an account trade that the close lacks or holds empty. A
 * capture never deletes them; a later capture resolves the two tracker ones. */
export const CLOSE_MERGE_FLAG_TYPES = Object.freeze({
  CAPTURE_LOST_ACTIVITY: 'Capture lost activity',
  TRACKER_ONLY_ACCOUNT: 'Tracker only account',
  CLOSE_BELOW_TRACKER: 'Close below tracker',
});

export const CLOSE_MERGE_FLAG_HINTS = Object.freeze({
  [CLOSE_MERGE_FLAG_TYPES.CAPTURE_LOST_ACTIVITY]:
    'A later capture showed no fills and no realized for an account that had traded, most likely because it was disconnected, so the CRM kept what the earlier capture stored.',
  [CLOSE_MERGE_FLAG_TYPES.TRACKER_ONLY_ACCOUNT]:
    'The close does not list this account but the tracker saw it trade, so its row comes from the tracker, with no fills and no balance, until a capture lists it.',
  [CLOSE_MERGE_FLAG_TYPES.CLOSE_BELOW_TRACKER]:
    'The close lists this account with no fills and no realized, but the tracker saw it trade that day, so its money is probably missing from the close.',
});

/** The hint for a flag type, or undefined for a type reconcile.js writes. */
export function databaseFlagHint(type) {
  return DATABASE_FLAG_HINTS[type] ?? CLOSE_MERGE_FLAG_HINTS[type];
}
