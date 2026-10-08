# Tracker against the close: verification (step 66)

## What step 66 adds

`supabase/step_66_tracker_close_readings.sql` adds two tables and five tunables,
and changes no agent, no ingest route and no row of any existing table.

- `account_live_sample_history`: the account tracker's samples kept as value
  runs. A trigger on `account_live_samples` extends the latest run of an account
  when the reading is unchanged and strictly newer, opens a new run otherwise,
  and ignores a replay with the same `sampled_at`. Rows older than
  `history_retention_days` (5) leave on the next sample from that machine.
- `tracker_close_readings`: the tracker side of each close, one row per account,
  pinned by a trigger on `ingest_batches` when a batch becomes `processed` or
  `incomplete`, through `record_tracker_close_readings(daily_import_id)`. The
  close money is never copied; the browser joins `account_snapshots` and
  `strategy_snapshots` at read time and `src/domain/trackerCloseComparison.js`
  says the verdict.
- One `audit_logs` row per comparison: `entity_type = 'daily_import'`,
  `action = 'tracker_close_compared'`, camelCase counts in `after_data`.

The client page and the overview badge arrive in later PRs. Until then both
tables fill quietly and the queries below are how to read them.

## Verification status

Verified on the PGlite migration cluster (PostgreSQL 18 in process, every
migration in `supabase/` applied twice), through the same RPCs the agents and
the ingest route call. No Supabase credentials were available in this task, so
nothing below claims live catalog evidence. The two read only queries at the end
are how Pedro confirms it on the project after running the file.

## Local verification

Run from the repository root:

```bash
npx vitest run supabase/step_66_tracker_close_readings.test.js
npx vitest run supabase/step_55_account_live_samples.test.js supabase/step_56_table_privilege_lockdown.test.js supabase/step_57_algorithm_live_samples.test.js supabase/step_63_heartbeat_without_ninjatrader_version.test.js
npx vitest run src/domain/trackerCloseComparison.test.js src/domain/supabaseStore.trackerClose.test.js
npx eslint supabase/step_66_tracker_close_readings.test.js src/domain/trackerCloseComparison.js src/domain/trackerCloseComparison.test.js src/domain/supabaseStore.trackerClose.test.js src/domain/autoExportContract.test.js
npm test
npm run build
```

What the cluster test proves, each by doing it against the database:

- the five tunables ship with their defaults and each refuses an edit outside its
  range by a named CHECK;
- two equal readings are one run with two samples, a changed figure, connection
  name or strategy count opens a new run, `run_state` is copied in step 55's four
  words, a replay with the same `sampled_at` is a no op whatever it carries, an
  omitted account is left alone, a run older than the retention window leaves on
  the next sample and a younger one stays;
- a history fault (a CHECK that always fails, installed in a rolled back
  transaction) leaves the sample recorded and raises one WARNING naming the
  device, the account and the fault;
- on a cold backend, a cluster applied once whose trigger functions have never
  run, the history table dropped before the first sample leaves the sample
  recorded with one WARNING naming the device and `42P01`, and the readings table
  dropped before the first close leaves the finalize `processed` with one WARNING
  naming the import and `42P01`. plpgsql resolves a declared rowtype when it
  compiles the function, outside its exception block, so the warm shared cluster
  cannot see that fault; `v_latest` is declared `record` for this reason;
- a close finalized through `claim_ingest_batch_v4`, `persist_auto_daily_import_v3`
  and `finalize_ingest_batch_v3` pins one row per account in the union of the
  close and the readings, with the close's spelling; the pick is the run in
  force at the cutoff (16:20 held to 16:30 over a 16:40 run at a 16:31 capture
  with two minutes of grace), `next_sampled_at` is the first run after the
  cutoff, a reading inside the grace counts, a flat night from the evening before
  is one run reaching into the day, a run that ended yesterday is not a reading,
  the day's strategy readings are pinned in the designed keys, a strategy
  reading dated today, after the trading day ended, is not one of them, and one
  audit row carries the counts;
- `record_tracker_close_readings` called directly replaces the rows wholesale
  and writes another audit row; the grace moves the cutoff; a run that begins
  exactly at the cutoff second is the reading and not the next one; the
  strategies cap holds; without a batch the capture time is the client's latest ACTIVE machine's
  own schedule with basis `scheduled`; `reset_seen` is true for a connected
  account whose realized fell from beyond ten times the tolerance to inside it
  and false when the fall stays outside; an unknown import is answered, not
  raised; a deleted settings row falls back to the defaults;
- a second close of the same day replaces the pinned rows and the prior batch's
  `replaced` transition pins nothing; a claim and a failed finalize pin nothing;
  a hand UPDATE that sets `processed` again on a processed batch does not
  compare again;
- a comparison fault (the same always failing CHECK) leaves the batch
  `processed`, raises one WARNING naming the import and the fault, and leaves no
  partial rows;
- `authenticated` holds exactly SELECT on both tables (asked of `aclexplode`),
  `anon` nothing, a Manager is refused every write including TRUNCATE,
  `record_tracker_close_readings` is executable by `service_role` alone, the two
  trigger functions by neither browser role; the lockdown holds with step 56 left
  out and after re-running 56 and 52 on top; a CAM reads only its own clients'
  rows, a Manager all, a stranger none;
- re-running the file is a no op: same definitions, same grants, rows and hand
  edits intact, triggers still firing.

## After running step 66 on the project

Run the file once in the SQL editor, any time between closes. History begins
with the next account sample; the next close pins the first readings.

Two read only queries, and what to expect.

1. The same evening, the history should show a handful of runs per account for
   the day, and a flat account as one row:

   ```sql
   select account_name, run_state, realized_pnl, total_pnl, samples,
          first_sampled_at at time zone 'America/New_York' as first_ny,
          last_sampled_at  at time zone 'America/New_York' as last_ny
   from public.account_live_sample_history
   where client_id = '<client uuid>'
     and last_sampled_at >= (current_date::timestamp at time zone 'America/New_York')
   order by account_name, first_sampled_at;
   ```

   Expect `samples` to add up to the number of reports the machine sent while
   the reading held; a quiet overnight account shows one row with many samples.

2. After the next close, one pinned row per account and one audit row:

   ```sql
   select r.account_name, r.source, r.realized_pnl, r.total_pnl,
          r.sampled_at at time zone 'America/New_York' as sampled_ny,
          r.reading_since at time zone 'America/New_York' as since_ny,
          r.next_sampled_at at time zone 'America/New_York' as next_ny,
          r.reset_seen, jsonb_array_length(r.strategies) as strategies,
          r.close_time_basis, r.close_captured_at at time zone 'America/New_York' as captured_ny,
          s.gross_realized_pnl as close_realized, s.connection as close_connection
   from public.tracker_close_readings as r
   left join public.account_snapshots as s
     on s.daily_import_id = r.daily_import_id and lower(s.account_name) = lower(r.account_name)
   where r.trading_date = current_date
   order by r.client_id, r.account_name;

   select created_at, entity_id as daily_import_id, after_data
   from public.audit_logs
   where entity_type = 'daily_import' and action = 'tracker_close_compared'
   order by created_at desc
   limit 20;
   ```

   Expect `source = 'crm_history'` with `sampled_ny` a few minutes before
   `captured_ny` for every account the tracker sampled that day, `source = 'none'`
   for the accounts it did not, `close_time_basis = 'captured'` on an automatic
   close, and in `after_data` `accountsPinned`, `accountsFromHistory`,
   `historyRowsSeen` and `liveRowsSeen`. `liveRowsSeen` above zero with
   `historyRowsSeen` at zero means the history trigger is not writing: look for
   `step 66: account_live_sample_history_record skipped` in the Postgres logs.

Tuning without a deploy:

```sql
update public.account_tracker_settings
set close_match_tolerance_dollars = 10, updated_at = now()
where id;
```

A manual close is not pinned automatically in this step (it never touches
`ingest_batches`). To pin one by hand:

```sql
select public.record_tracker_close_readings('<daily_import_id>');
```

It returns `{recorded: true, ...counts}` or `{recorded: false, reason}` and never
raises; the capture time is then the client's latest active machine schedule,
`close_time_basis = 'scheduled'`.

## Evidence

Recorded on 2026-10-08, on the PGlite migration cluster from the repository root
(no live Supabase run):

- `supabase/step_66_tracker_close_readings.test.js`: 62 tests passed.
- `supabase/step_55_account_live_samples.test.js`, `step_56_table_privilege_lockdown.test.js`,
  `step_57_algorithm_live_samples.test.js`, `step_63_heartbeat_without_ninjatrader_version.test.js`:
  213 tests passed with step 66 in the directory and its two rows in step 56's
  exception table.
- `src/domain/trackerCloseComparison.test.js` and `src/domain/supabaseStore.trackerClose.test.js`:
  50 tests passed.
- The full vitest suite passed; `npm run build` passed.
- Targeted ESLint on the new and edited files: no findings.
- Mutation testing: 38 mutations (23 in the SQL, 12 in the domain module, 3 in
  the store loaders), every one killed by at least one test. Three first
  survived and the tests were strengthened until they did not: a run that
  straddles the cutoff (the clock cap), a revoked machine that carries only one
  of its two revocation marks (the scheduled fallback), and a `42P01` whose
  message names none of our tables (the missing table guard). The table is in
  the pull request body.
