-- Step 39: why a client left, recorded when they are marked Inactive.
--
-- WHY THIS STEP EXISTS.
--
-- Churn in this CRM is manual and always has been: a client is churned when
-- somebody sets their stage to Inactive (src/domain/clientLifecycle.js,
-- isChurnedClient). The stage was the whole record. The retention panel could
-- therefore say how many had left and nothing whatever about why, which is the
-- state the desk manager described as telling him almost nothing.
--
-- His instruction was that the reason be a short list of options rather than
-- free text, "so the reasons can be counted later. Free text that nobody can
-- aggregate is how this question gets asked again in three months." Hence three
-- columns and not one:
--
--   churn_reason  the option. One of the codes in CHURN_REASONS
--                 (src/domain/clientLifecycle.js). This is the countable half.
--   churn_note    the sentence a CAM may add beside it. Never aggregated,
--                 never required, and never a substitute for the option.
--   churned_at    the day the classification was made, which is what the
--                 manager's drill-down filters on.
--
-- ALL THREE ARE NULLABLE, AND THAT IS THE POINT.
--
-- Every client marked Inactive before this ran has no reason, and must not be
-- given one. `default 'other'` would have been the tidy choice and it would have
-- been a lie in a countable column: 'other' is an option a CAM can pick, meaning
-- "none of these fit", and back-filling it would make silence indistinguishable
-- from an answer. The app renders the absent case as "Not recorded" and counts
-- it as its own bucket, so the number of unexplained departures is visible and
-- can be watched fall rather than being papered over on day one.
--
-- (On the book this was written against there are zero such rows to back-fill:
-- 96 clients, 95 Active and 1 Paused, nobody Inactive. The rule matters anyway —
-- the CSV intake path can set a stage, and any client classified between this
-- deploy and this migration is exactly such a row.)
--
-- churned_at is a date, not a timestamptz. The whole CRM works in trading days:
-- start_date is a date, the drill-down's filters are <input type="date">, and a
-- churn recorded at 23:40 in Bogotá is not a different day's churn in London.
--
-- HOW THIS ONE DEGRADES, WHICH IS NOT LIKE 31–38.
--
-- READS degrade gracefully, as they do everywhere else: on a database without
-- these columns, and on every export taken before today — public/local-snapshot
-- .json included, which the test suite reads — buildCrmStateFromTables reads
-- them as absent and the panel shows "Not recorded". Nothing breaks and no count
-- moves.
--
-- The WRITE does not degrade, and deliberately so. src/domain/supabaseStore.js
-- maps these columns only when a patch carries `churn`, which is only the save
-- that marks a client Inactive, and that save carries the stage in the SAME
-- UPDATE. So on an un-migrated database that one action fails loudly instead of
-- succeeding and dropping the reason on the floor — which would create precisely
-- the unexplained rows this step exists to stop. Every other client save is
-- untouched and works exactly as before.
--
-- Run it before deploying, and marking a client Inactive keeps working. Deploy
-- first and it is one alert and one statement away from working.
--
-- Reversal, should the decision be undone:
--
--   alter table public.clients
--     drop column if exists churn_reason,
--     drop column if exists churn_note,
--     drop column if exists churned_at;

alter table public.clients
  add column if not exists churn_reason text,
  add column if not exists churn_note text,
  add column if not exists churned_at date;

comment on column public.clients.churn_reason is
  'Why this client was marked Inactive, as one of the codes in CHURN_REASONS (src/domain/clientLifecycle.js). Null means no reason was ever recorded, which is NOT the same as the ''other'' option and must not be back-filled to it.';
comment on column public.clients.churn_note is
  'Optional free text a CAM may add beside churn_reason. Never aggregated. Redacted by scripts/redact-export.mjs; churn_reason is kept because it is an enum.';
comment on column public.clients.churned_at is
  'The day the client was classified Inactive. Null on rows classified before step 39; absent stays absent rather than being back-dated to the day this ran.';

-- No CHECK constraint on churn_reason, for the same reason step 38 added none to
-- operational_flags.status: a constraint is enforced against every writer
-- including the SQL editor and any backfill, and the failure mode of a wrong
-- allow-list is a rejected churn classification — the exact write this step is
-- here to make possible. The allowed set is a product-side guarantee, pinned by
-- src/domain/clientLifecycle.test.js and by the dialog that is the only thing
-- that writes it.
--
-- No DEFAULT and no NOT NULL for the reason above them both.
