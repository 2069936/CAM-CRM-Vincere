/* ────────────────────────────────────────────────────────────────────────────
 * THE FLAGS THE DATABASE WRITES ITSELF, by type, and what each one asks.
 *
 * Every other flag type in operational_flags is written by reconcile.js while
 * a close is imported. These five are written by refresh_account_observations
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

/** The hint for a flag type, or undefined for a type reconcile.js writes. */
export function databaseFlagHint(type) {
  return DATABASE_FLAG_HINTS[type];
}
