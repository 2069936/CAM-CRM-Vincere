-- Step 38: retire the 'Acknowledged' flag status.
--
-- WHY THIS STEP EXISTS.
--
-- A flag had two ways to be closed: Resolve, and Acknowledge ("seen, hide for
-- now"). The desk manager removed Acknowledge — one action, one meaning — and
-- the buttons went out of src/components/Dashboard.jsx, src/components/
-- CamFlagQueue.jsx and src/App.jsx along with every write path that could
-- produce the status.
--
-- That leaves the rows already carrying it. On the book this was written
-- against: 6,553 operational_flags, of which 1,952 Open, 4,141 Resolved and
--   460 Acknowledged  (409 Warning, 51 Critical)
-- spread across 51 clients. Those 460 are the decision this step is about, and
-- there were only two honest ways to go:
--
--   * TREAT THEM AS OPEN. Rejected. Every read path in the app has always
--     excluded Acknowledged exactly where it excludes Resolved — the CAM flag
--     queue, buildDailyReportSummary, the client badge, the manager's open-flag
--     table, the critical-flag tiles. Reopening them would put 460 items a CAM
--     has already looked at and closed back into the queue, and the CAM queue is
--     specifically the screen that reaches flags stranded behind a client's
--     latest close, so nothing else would ever take them out again. It would
--     invent work, and it would invent it out of work already done.
--
--   * TREAT THEM AS RESOLVED. Taken. It is what every screen in the product
--     already shows, so no count anywhere moves on the day this runs, and it is
--     what the CAM meant: he saw it and it needed nothing more.
--
-- WHAT KEEPS IT FROM BEING SILENT.
--
-- Collapsing 460 rows into a status they did not have is only defensible if it
-- can be seen and undone, so this step does not simply overwrite the column.
-- `acknowledged_before_step_38` records what each row was, which makes the set
-- addressable afterwards ("which of these were only ever acknowledged?") and
-- makes the whole step one UPDATE away from reversible:
--
--   update public.operational_flags
--      set status = 'Acknowledged'
--    where acknowledged_before_step_38;
--
-- resolved_at is NOT rewritten. Acknowledging already stamped it — see the
-- resolved_at patch in updateSupabaseOperationalFlag — so every one of these
-- rows already carries the moment the CAM closed it, and replacing that with
-- the time this migration happened to run would destroy the only timestamp
-- there is in the name of tidiness. Rows with a null resolved_at (an old
-- acknowledgement from before that patch, if any exist) are left null rather
-- than back-dated to now: absent stays absent.
--
-- WHY THE APP STILL EXCLUDES 'Acknowledged' AFTER THIS RUNS.
--
-- isFlagOpen and its siblings keep the `status !== 'Acknowledged'` check. This
-- step is additive and degrades gracefully like 31–37: the code can deploy
-- before it runs, and on a database where it has not run the 460 rows must still
-- read as closed. It also has to stay true of exports taken before today —
-- public/local-snapshot.json is one — which the test suite reads.

alter table public.operational_flags
  add column if not exists acknowledged_before_step_38 boolean not null default false;

comment on column public.operational_flags.acknowledged_before_step_38 is
  'True on rows that held status ''Acknowledged'' when step 38 retired that status and set them to ''Resolved''. Provenance only; nothing reads it at runtime.';

-- Idempotent: the second run finds no 'Acknowledged' rows and marks nothing.
-- The flag column is set in the same statement as the status, so a run that
-- fails half way cannot leave a row resolved without its provenance.
update public.operational_flags
   set status = 'Resolved',
       acknowledged_before_step_38 = true
 where status = 'Acknowledged';

-- The status column is free text with no CHECK constraint and this step does not
-- add one. Deliberate: a constraint here would be enforced against every writer
-- including ones that are not this app (the SQL editor, a backfill script), and
-- the failure mode of getting its allowed list wrong is a rejected write on a
-- CAM's flag resolution. The product-side guarantee is the one that matters and
-- it is pinned by test, not by DDL — see src/domain/flagStatusWrites.test.js,
-- which reads the source of every flag write path and fails if 'Acknowledged'
-- reappears in one.
