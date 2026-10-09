/* ────────────────────────────────────────────────────────────────────────────
 * THE COLUMN DEFAULTS OF account_observation_settings (step 65), ALONE.
 *
 * supabaseStore.js maps the settings row and needs these three numbers for a
 * database that has not run step 65 or a column that is missing. They lived in
 * accountBuckets.js, so supabaseStore.js imported accountBuckets.js, which
 * imports autoCollectionFleet.js; and supabaseStore.js is in the daily email
 * bundle's graph (supabase/functions/daily-report-email/_bundle.js). The
 * bundler keeps every top level Object.freeze of a module it reaches, so the
 * Edge Function carried both modules' frozen tables, unused, in a process that
 * runs with a service role. Here, with no import at all, the bundle reaches
 * nothing else. accountBuckets.js re-exports them under the same name.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The column defaults of account_observation_settings, for a database that
 * has not run step 65 or a read that failed. */
export const ACCOUNT_OBSERVATION_DEFAULTS = Object.freeze({
  staleCloses: 5,
  autoFailOnBreach: true,
  newAccountDays: 14,
});
