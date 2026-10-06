# Migrations to run for PR #10

Run these in Supabase (SQL editor or CLI) in order. All are additive and
idempotent, so re-running is safe. None drops or rewrites existing data. 47 and
48 each have a second step to run after the file, and both say so below.

| Step | File | What it adds | Feature it powers |
|---|---|---|---|
| 28 | `step_28_auto_collection.sql` | auto-collection tables, RPCs and the storage bucket | NinjaTrader auto-collector |
| 29 | `step_29_auto_collection_reprocess.sql` | reprocess / replay support | auto-collector |
| 30 | `step_30_auto_collection_pnl_audit.sql` | PnL source audit | auto-collector |
| 31 | `step_31_report_config.sql` | `report_config` on `cam_profiles` + `clients` | Report designer |
| 32 | `step_32_client_order.sql` | `client_order` on `cam_profiles` | Drag-and-drop sidebar order |
| 33 | `step_33_tradovate_account_id.sql` | `tradovate_account_id` on `trading_accounts` | Tradovate / NinjaTrader-web import |
| 34 | `step_34_cam_time_off_and_coverage.sql` | `cam_time_off`, `client_coverage`, CAM record fields | Time off and temporary client coverage |
| 35 | `step_35_prop_firm_plan.sql` | `prop_firm_plan` on `trading_accounts` | Drawdown limits that follow the plan an account was bought under |
| 36 | `step_36_simulation_accounts.sql` | the CAM's simulation/live override on `trading_accounts` | Simulated accounts kept out of desk capital without being discarded |
| 37 | `step_37_derived_strategy_pnl.sql` | `derived_realized` on `strategy_snapshots`; `derivation` on `account_snapshots` | Per-algo P&L derived from the fills |
| 38 | `step_38_flag_acknowledged_to_resolved.sql` | `acknowledged_before_step_38` on `operational_flags`, and the 460 `Acknowledged` rows set to `Resolved` | Retiring the Acknowledge action on flags |
| 39 | `step_39_client_churn_reason.sql` | `churn_reason`, `churn_note`, `churned_at` on `clients` | The churn drill-down, and the reason captured when a CAM marks a client Inactive |
| 41 | `step_41_heartbeat_ordering.sql` | replaces `record_ingest_heartbeat` without the invalid capture/success ordering rule | Collector heartbeats remain valid after a successful upload |
| 42 | `step_42_client_tags_and_price_history.sql` | `tags` and `account_focus` on `clients`, and the `client_price_changes` log | Client tags and the revenue movement figures |
| 43 | `step_43_row_level_security.sql` | Row Level Security on every table that lacked it, plus `login_email_for_username` | Closes the database to the publishable key that ships in the browser bundle |
| 44 | `step_44_algorithm_benchmarks.sql` | `algorithm_benchmarks`: the imported My Futures Book monthly backtest aggregates with each month's own days, keyed by vendor first, with its own RLS and policy | The My Futures Book backtest import in Data Tools, and the benchmark section of the desk period report, which reads the saved import instead of asking for the 36 files again |
| 45 | `step_45_ingest_admission_control.sql` | `ingest_admission_settings` with the tunable cap, `claim_ingest_batch_v4` with the `at_capacity` outcome and its per device retry spread, `finalize_ingest_batch_v3`, and `admission_deferrals` / `stage_durations_ms` / `ingest_duration_ms` on `ingest_batches` | The door that answers 429 with Retry-After when too many uploads are in flight at once, and the ingest timing line on the Auto Collection fleet view |
| 46 | `step_46_ingest_quarantine_reports.sql` | `ingest_quarantine_reports`: what each VPS holds in `queue\quarantine`, one row per capture with the code, the attempt count and whether the agent will retry it, plus `record_ingest_quarantine_report`, which replaces a device's inventory whole | The quarantine count and dates on the client card, the Quarantine state and chip on the Auto Collection fleet view, and the `POST /api/ingest/quarantine` report agent 1.0.7 sends after its daily review |
| 47 | `step_47_strategy_ran.sql` | `ran` and `ran_basis` on `strategy_snapshots`, the one close backfill behind `call public.backfill_strategy_ran_all();`, and `persist_auto_daily_import` replaced so the collector stores both | Whether an algorithm RAN that day, on every screen that used to ask the export time checkbox |
| 48 | `step_48_close_summaries.sql` | `close_summaries`: the desk money of one close per segment, written at ingest by `buildSegmentTotals`, plus `replace_close_summaries` and the Node backfill beside it | The manager's first screen reading about two rows a close instead of downloading 12,778 account rows and 14,514 strategy rows on every login |
| 49 | `step_49_strategy_templates.sql` | `strategy_templates`: the desk's own set files, keyed by family and version, and the catalogue the attribution engine reads | Naming the algorithm behind an order from the shape of the trade |
| 50 | `step_50_auto_collection_derived_pnl.sql` | `persist_auto_daily_import` replaced again so the COLLECTOR stores `strategy_snapshots.derived_realized` and `account_snapshots.derivation`, which step 37 added and only the manual path has ever written | A per-algorithm P&L on the 99% of the book that arrives automatically |
| 51 | `step_51_app_users_write_lockdown.sql` | `revoke insert, update, delete on app_users` from `authenticated` and `anon`; SELECT stays | Closing a CAM's ability to promote themselves to Manager by talking to PostgREST directly |
| 52 | `step_52_rls_by_cam.sql` | `is_manager()` and `assigned_client_ids()`, then a real policy on every table that reaches a client: 13 by `client_id`, 4 through `daily_imports`, `clients` by id and `payout_events` by account | Turning step 43's `using (true)` into a CAM seeing only the clients assigned to it |
| 53 | `step_53_client_creation_under_rls.sql` | `clients.created_by`, the `client_is_assigned` and `clients_i_created` helpers, and a third arm on three of step 52's policies | Letting a CAM create a client again: step 52 made the `RETURNING` on the insert unreadable to its own author |
| 55 | `step_55_account_live_samples.sql` | `account_live_samples`: the LAST sample of each account on each paired VPS, overwritten, with `run_state` derived from the strategy counts in four words — `running`, `idle`, `no_strategies` (the VPS looked and nothing is loaded) and `unmeasured` (nobody looked) — plus `account_tracker_settings` (the interval, the staleness horizon, the throttle, the retention window and the first agent version that samples) and `record_account_live_sample`, which upserts and never deletes what a sample omits | The account traffic light: which accounts are alive, which are running and roughly how the day is going, between the open and the 16:45 close. 54 is skipped on purpose — it is claimed by the unmerged deep-export draft |
| 56 | `step_56_table_privilege_lockdown.sql` | `revoke all privileges on all tables in schema public` from `anon` and `authenticated`, then grants back by a LOOP over the catalogue with one exception table for the tables that get less than the four DML verbs — every row naming what decided it; four function revokes steps 52 and 53 could not reach; and `alter default privileges` so the next table is not born with the hole | Taking away TRUNCATE, TRIGGER, REFERENCES and MAINTAIN, the four privileges row level security cannot govern — a signed-in CAM could empty 32 of the 37 tables and no policy would see it. Also narrows step 55's SELECT grant on the two tracker tables from `anon, authenticated` to `authenticated` |
| 57 | `step_57_algorithm_live_samples.sql` | `algorithm_live_samples`: the LAST reading of each NinjaTrader strategy instance (Strategies tab Realized plus Unrealized) on each paired VPS, overwritten, with the sample cycle it belongs to; `algorithm_live_settings` (the cohort floors, the cycle tolerance, the differs threshold, the report cap and the retention window); `record_algorithm_live_sample` for the ingest route; and `algorithm_live_desk()`, which returns the desk median per algorithm and instrument as aggregates only, leaving the caller's own clients out | Each algorithm today against the desk, on the CAM overview: the same cycle for desk and client, the sample size beside every figure, and no comparison when the cohort is too thin |
| 58 | `step_58_close_summaries_scope.sql` | `replace_close_summaries` recreated with a scope check in front of its delete: a Manager and the service role as before, anyone else only the closes of clients assigned to them, with every row carrying its own close's `client_id`, or the whole call is refused with 42501; `step_48_close_summaries.sql` now carries the same function so a re-run of 48 does not undo it | Closing a CAM's ability to replace or empty another CAM's close summaries through `/rpc/replace_close_summaries`, which since step 52 it could do to rows it cannot even read |
| 59 | `step_59_log_algo_history_by_family.sql` | step 43's `using (true)` policy on `log_algo_history` replaced by one for Managers, and `log_algo_history_by_family()`, which returns the card's seven numbers per family and withholds from a CAM every family run on fewer accounts, or fewer owners, outside her book than step 57's floors | A CAM no longer reads every book's per account, per family P&L, nor rewrites it. The Stack Playbook "Algo history (from logs)" card keeps its numbers |
| 60 | `step_60_client_handoff_manager_only.sql` | `my_cam_profile_id()` and four RESTRICTIVE policies on `client_assignments` beside step 53's permissive one: a CAM reads her own clients' rows, inserts only (a client she created that nobody holds, her own profile), and never updates or deletes | Only a Manager moves a client between books. Closes the handoff step 57 names as its residual, and a creator taking back a client a Manager moved away. 58 is skipped on purpose: it is claimed by PR 74 (close summaries scope), not merged when this was written |

## These three groups behave differently

**28–30 are required before the auto-collector works at all.** They create tables
and RPCs the ingest endpoints call directly, so without them every upload fails
with `snapshot_ingest_unavailable` and every pairing attempt fails with
`pairing_unavailable`. They do **not** degrade gracefully. The rest of the CRM is
unaffected either way — nothing else touches those tables.

`INGEST_TOKEN_PEPPER` is required alongside them for the same reason: device
authentication has nothing to hash without it.

**31–38 degrade gracefully.** Each feature reads its column as an empty default
when the column is missing, so the code can deploy before they run and the
feature simply stays dormant:

- No 31 → the report designer shows the default layout and can't save changes.
- No 32 → the sidebar keeps its pinned + urgency sort; drag order won't persist.
- No 33 → the Tradovate ID field shows but has nowhere to save.
- No 34 → time off and coverage are unavailable; everyone sees only their own
  clients, exactly as before.
- No 35 → an account runs on the tightest drawdown its firm sells at that size,
  because no plan can be recorded to say otherwise.
- No 36 → the simulation/live classification runs on its heuristic alone and a
  CAM's override has nowhere to save.
- No 37 → **the per-algo split does not survive a reload.** The derivation still
  runs at import and a CAM sees the split on the freshly imported close; after a
  refresh the columns it was read back from do not exist, so the panel shows the
  combination history and no per-algo figures. Nothing wrong is displayed —
  absent stays absent — but the feature is invisible to anyone who did not do the
  import themselves. This is the one of the four whose absence a user notices.
- No 38 → nothing on any screen changes, and that is the point. The Acknowledge
  button is gone from the code either way; the 460 flags already stored as
  `Acknowledged` keep reading as closed because `isFlagOpen` and every filter
  beside it still exclude that status by name. Running 38 moves those rows to
  `Resolved` in the database and records that it did; not running it leaves the
  data as it is with the product behaving identically. It is the one step here
  that is purely about the stored rows rather than about a feature.

**39 reads gracefully and writes loudly, which is not the same thing.** Its
*reads* behave like 31–38: on a database without the three columns, and on every
export taken before it ran, `buildCrmStateFromTables` reads them as absent, the
churn drill-down shows "Not recorded" against every departure, and no count
anywhere moves.

Its *write* does not degrade, on purpose. The columns are mapped only by the one
save that marks a client Inactive, and that save carries the new stage and the
reason in the **same** UPDATE — so on an un-migrated database that single action
fails with the usual "Could not save client" alert instead of quietly recording a
churn with no reason. Creating unexplained rows is the thing step 39 exists to
stop, so it refuses to create them rather than degrading into doing exactly that.
Nothing else about a client save is affected: names, emails, stages other than
Inactive, notes and everything else on the profile keep working untouched.

- No 39, and nobody marks anyone Inactive → indistinguishable from having run it.
- No 39, and a CAM marks a client Inactive → one alert, nothing saved, and the
  fix is this one file.

Step 37 adds **two** columns, one per table. It was drafted with two more on
`strategy_snapshots` — `derived_realized_status` and `derived_realized_join` —
and both were cut before the step was ever run, because each repeated the
account-day's own verdict on every roster row of that account while
`account_snapshots.derivation` already stored it once. Measured through the
shipped write mapper on a real export they were 72.5 of the 96.4 bytes a strategy
row was about to grow by, or ~73 KiB on the busiest CAM's 1,033-row export pull —
against the 4 MiB ceiling `server/export/clientExport.js` enforces as a 413 and
that pull is already over. Every per-row question they answered is answerable
from `derived_realized` plus `derivation`; the SQL file carries the mapping. If
you ran an earlier draft of this file, the two columns are inert and may be
dropped whenever convenient.

## Order

28 → 29 → 30 → 31 → 32 → 33 → 34 → 35 → 36 → 37 → 38 → 39 → 41 → 42 → 43 → 44 → 45 → 46 → 47 → 48 → 49 → 50 → 51 → 52 → 53 → 55 → 56 → 57 → 58 → 59 → 60. Steps 29 and 30 build
on 28, 34 references `cam_profiles` and `clients`, and 35–37 alter
`trading_accounts`, `strategy_snapshots` and `account_snapshots` — all of which
already exist. 35, 36, 37, 38 and 39 are independent of each other and of
everything above them; 38 touches only `operational_flags` and 39 only
`clients`.

**50 is not independent, and the order is not a formality for it.** It replaces
`persist_auto_daily_import` and writes the two columns 37 added, so it must run
after 37 for the columns to exist and after 47 for the function it replaces to
be the current one. Its body is 47's, copied verbatim except for the two INSERT
lists. A draft of this change written against a checkout that stopped at PR 15
carried step 28's body instead: applying that would have dropped `ran` and
`ran_basis` from every close written afterwards, silently, with no error. The
test beside it asserts both columns survive.

**51 is a revoke and nothing else, and it is safe to run at any time.** It
removes privileges the application never uses: the browser reads `app_users`
twice to sign in and writes it never, and every write goes through
`api/admin/users.js` on the service role, which grants do not constrain. SELECT
is deliberately untouched - revoking it locks every user out of the CRM.

**56 takes away the four privileges row level security cannot govern, and it is
numbered 56 because 54 and 55 were claimed by branches that had not merged.**
Draft PR 65 still holds step 54. PR 67 held step 55 and **has since merged** —
after 56 was written and before 56 could merge, which is the one thing worth
knowing about this file before reading it.

Every table in this database was born holding all eight privileges for `anon`
and for `authenticated`, because a Supabase project ships
`alter default privileges in schema public grant all on tables`. Nobody granted
them and nobody reviewed them. Four of the eight are not subject to row level
security at all:

- **TRUNCATE** empties a table in one statement without consulting a single
  policy. Verified by doing it as the `authenticated` role against a cluster
  carrying every migration in this directory: `truncate table public.orders`
  **succeeded**. Steps 52 and 53 would have watched a CAM empty `clients`,
  `trading_accounts`, `orders`, `executions` and `client_credentials`.
- **TRIGGER** attaches code that runs on somebody else's writes.
- **REFERENCES** lets an unaudited table decide whether a row may be deleted.
- **MAINTAIN** is PostgreSQL 17's addition, and it is the proof that this had to
  be done by revoking everything rather than by naming what to remove: step 51
  wrote `revoke truncate, trigger, references on app_users`, MAINTAIN did not
  exist yet, and `authenticated` still holds it on `app_users` today.

So 56 revokes everything from both browser roles and grants back only the verbs
the browser is measured to use — `anon` gets nothing at all — and then changes
the default privileges so the next table is not born with the hole.

**And the migration against staleness went stale, which is why its shape changed
before it merged.** The argument above is against enumerating what to REMOVE;
56's first draft then enumerated what to KEEP, in five hand-written
`grant ... on public.a, public.b, ...` statements naming 33 tables. That goes
stale the same way, one direction over — when a TABLE is added rather than when a
PRIVILEGE is. Step 55 landed two tables and both came out of 56 holding nothing,
while a test beside it asserted a hard-coded count of 37 against a schema that
now holds 39.

Both halves are now read from the catalogue. The revoke always was. The
grant-back is a loop over every base table in `public`, with one **exception
table** for the tables that get less than the four DML verbs — and every row in
it names the migration or the measurement that decided it. The exception table is
not a convenience: step 55 deliberately made its two tables read-only for the
browser, 56 runs after 55, so a four-verb loop with no exceptions would have
handed INSERT, UPDATE and DELETE straight back and 56 would have been the thing
that undid it. The same is true of the four `ingest%` tables step 28 closed and
the two steps 45 and 46 closed.

**A table in neither place gets the four DML verbs and 56 says its name in a
NOTICE.** The four verbs because that is exactly what a table created *after* 56
gets from the default privileges, so a table's privileges do not depend on which
side of 56 it was created on; the NOTICE because granting in silence is how step
55 would have been undone. It is not fatal — a migration that refused to run
until somebody edited it would be the hand-written list again. If you run 56 and
see a table name you did not expect in that NOTICE, it needs a row in the
exception table.

**56 also narrows one decision step 55 made.** Step 55 granted SELECT on
`account_live_samples` and `account_tracker_settings` to `anon, authenticated`;
step 55's own line now reads `to authenticated`. Nothing reads either table
without a session — the overview effect that reads them returns early until it
has a signed-in client list, both SELECT policies are `to authenticated`, and
`/database`'s 20-table probe names neither — so the anon half returned `200 []`
and bought nothing, and 56's blanket revoke took it anyway. The end state is
unchanged; what changed is that the two files now say the same thing.

**It is safe to run at any time and needs no deploy.** It removes privileges
nothing in this repository uses. The browser's entire PostgREST surface is
`src/domain/supabaseStore.js` and `src/domain/supabaseAuth.js`; everything under
`api/` and `server/` runs on the service role, which is BYPASSRLS and whose
grants 56 does not touch.

**Two things will look like breakage and are not.** The login screen will log
two console errors on every fresh tab, because `src/App.jsx:14032` and `:14051`
load `strategy_classifications` and `log_algo_history` from effects with no
session guard: today they get `200 []`, after 56 they get `42501` and the
existing `.catch(console.error)` prints it. Nothing user-visible changes. And
`/database` will report "Needs attention", because `DatabaseCheck` renders
before the `if (!session)` gate and its 20-table probe now gets `permission
denied` instead of a count of 0. That page only ever told the truth signed in.

**Verify it, SIGNED OUT.** A probe carrying an `Authorization` header proves
nothing: `authenticated` holds the same EXECUTE grant on the sign-in function,
so the test passes whether or not `anon` still has it. No header, that is the
whole point:

    curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/login_email_for_username" \
      -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" \
      -H "Content-Type: application/json" \
      -d '{"p_username":"<an active username>"}'
    # PASS: a quoted email string.
    # FAIL: 401/403, or {"code":"42501"} -> username sign-in is broken for everyone.

Then the negative, which must stay closed and should change shape:

    curl -s "$SUPABASE_URL/rest/v1/clients?select=id&limit=1" \
      -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY"
    # Before 56: []        the grant allowed the read, no policy admitted anon to a row.
    # After 56:  {"code":"42501", ... "permission denied for table clients"}
    # Both are closed. `[]` turning into 42501 is the proof the migration ran.

**If username sign-in ever fails after this, sign in with your email address.**
`src/domain/supabaseAuth.js:42` short-circuits before any network call when the
input contains `@`, so an email sign-in works with every `anon` privilege
revoked. The login field is labelled "Username" and mentions none of this. Then
restore the one grant:
`grant execute on function public.login_email_for_username(text) to anon;`

**One half of 56 may not apply, and it says so when it runs.** There are two
default-privilege lines, one owned by `postgres` and one owned by
`supabase_admin`. 56 changes the first and attempts the second inside an
exception handler, so it cannot fail on it. `alter default privileges for role
supabase_admin` requires membership in `supabase_admin`, and the SQL editor's
`postgres` is not a member — a non-member is refused with `permission denied to
change default privileges`. Watch for the NOTICE. If it says the
`supabase_admin` line was **not** changed, a table created *by* `supabase_admin`
is still born holding all eight; no migration in this directory creates tables
that way, and closing it needs a session as `supabase_admin`, which the SQL
editor does not give you. Everything else in 56 will have applied.

**47 is easier to run before the deploy, and no longer has to be.** It was
written as a must: the strategy insert named `ran` and `ran_basis`
unconditionally, so a deployed build against an un-migrated database refused
every write at the insert. That happened on 2026-09-23, the deploy landing
first, and the fix is in `createSupabaseDailyImportAdapter.insertRows`, which
now drops a column PostgREST says does not exist and retries, the way
`selectRows` has always done on the read side. What a close written before the
migration loses is the value of those two columns, which the migration's own
backfill puts back. What it keeps is the close.

The two paths were also not equally exposed, which the original wording missed.
The collector's uploads go through `persist_auto_daily_import_v3`, which reaches
the base function this migration replaces, so before it runs the old base
function ignores the two extra keys in the payload and the automatic closes land
unharmed. Only the manual import in the browser writes the columns by name.

39 is the same shape for one client save. 48 may run either side of the deploy
and already refuses quietly when its function is absent.

**43 closes everything that existed before it, and it is the one that cannot
wait.** It enables Row Level
Security on every table that did not have it, which on 2026-09-18 was all of
them except the auto collection tables, `client_forms` and `client_price_changes`.
Until it runs, the publishable key that ships inside the browser bundle can read
and write `clients`, `trading_accounts`, `account_snapshots`, `app_users`,
`reports`, `audit_logs` and `client_credentials` with no session at all; that was
verified from outside the app. It must run after 42 so the table 42 creates is
covered too. Signed in users keep exactly the access they have today, and the
server endpoints use the service role and are unaffected. The one browser read
that happens before a session, looking a username's email up to sign in, moves
into `login_email_for_username`; the app falls back to the old select when the
function is not there yet, so the code can deploy before the migration runs.

**44 creates a table after 43 has already run, so it carries its own RLS and its
own `authenticated full access` policy inline** rather than relying on 43's
enumeration, and it ends with the same "no table in public is open" check 43
does. Every table added from here on has to do the same; 43 cannot cover what
did not exist when it ran.

**44 degrades like 31–38.** Without it the My Futures Book import card in Data
Tools still parses the CSVs and still shows what it found — the algorithm, the
version, the instrument, the risk level, the date range and the trade count —
and the Save button is disabled with the title
**`Saving needs migration step 44. The parse above still shows what the files hold.`**
The desk period report's benchmark section then holds only the
files the reader drags into the sheet in that visit, which is what it held for
everybody before this table was read at all: empty rather than wrong. With the
step run it reads the saved import on open, so the manager does not re-upload
36 CSVs every visit. Nothing else on any screen changes; no other feature reads
`algorithm_benchmarks`.

**45 degrades gracefully, and it is the first step that has to survive being run
either side of its deploy.** It adds `claim_ingest_batch_v4` and
`finalize_ingest_batch_v3` and leaves `claim_ingest_batch_v3` and
`finalize_ingest_batch_v2` exactly as they are, granted and callable, because
the server that is running at the moment the migration executes is still calling
them. The new server asks for v4 first and falls back to v3 for the life of the
process when the database answers that no such function exists, the same way the
login lookup in 43 falls back to its old select.

So without it the collector behaves precisely as it does today: every upload is
accepted the moment it arrives, nothing is ever answered 429 at the door, and the
Auto Collection fleet view simply omits its ingest line rather than showing
zeroes. With it, uploads past the cap are answered 429 with a per device
Retry-After, the capture stays queued on the VPS and arrives a minute later, and
the fleet view gains one line for the selected day: accepted, shed at the door,
median and slowest ingest time. No VPS needs updating for any of that; the agents
already deployed honour 429 and Retry-After.

**46 degrades gracefully, in both directions, and the agent that fills it is
already written to expect its absence.** Agent 1.0.7 reviews its
quarantine folder once a day and then posts the inventory to
`POST /api/ingest/quarantine`. Against a CRM without this step's table the
endpoint answers 404 `not_found`, which is exactly what a CRM without the
endpoint at all answers, and the agent treats both the same way: one INFO line,
one attempt a day, nothing marked on the device. Nothing rides on the heartbeat,
so an un-migrated CRM sees every heartbeat it sees today.

Without it the client card and the fleet view read as they do today: no
quarantine line, no Quarantine state, no chip. With it, the client card says
"N captures in quarantine" with the trading dates beside the version line, the
fleet view ranks a row as needing attention when a capture in its quarantine
needs a person here, and the client drawer lists each capture with whether the
CRM holds it as a failed close (replay it from the failed closes panel) or never
stored it. What a resend gets from this CRM is the part to know: a failed close
it already holds is answered 409 `capture_requires_replay` at the door, before
storage or processing, and keeps being answered that way until the close is
replayed here. The agent sends such a capture again at every review, without a
cap, because the resend after the replay is what clears the VPS (the CRM then
answers duplicate and the queue completes it); until then the capture counts as
needing attention, and `attempts` on its row says how many trading days the
replay has waited. Every row is the VPS's own word: the agent reports after each
review and the function replaces the device's inventory whole, so a capture
that was accepted after a retry, or replayed here and then resent, leaves the
table on the next report and never before.

**55 degrades gracefully in both directions, and it is inert until you edit one
column.** The agent that fills it posts to `POST /api/ingest/accounts`, and
against a CRM without this step's table that endpoint answers 404 `not_found` —
the same answer a CRM without the endpoint at all gives — so deploy and
migration can happen in either order with no error line on a VPS. Nothing rides
on the heartbeat, so an un-migrated CRM sees every heartbeat it sees today.

Without it, the account tracker panel says it is not available and every other
screen reads exactly as it does now. With it and with no agent sampling yet —
which is the state on the day it is run — the panel says that no collector build
sends live samples, once, quietly, and claims no fault against any machine. That
is what `account_tracker_settings.min_agent_version` being NULL means: no build
is named, so no machine is behind. The day you set it to the tag that ships the
sampler is the day a machine below it starts reading "too old to sample", and
not before.

Everything tunable is a column on `account_tracker_settings`, because this fleet
cannot take an environment variable. Edit them in the SQL editor; the CHECK
constraints are the review that edit gets, and each one says in the file what
bad edit it is refusing. Two are worth knowing before you touch them.
`stale_sample_seconds` must be at least twice `sample_interval_seconds` — setting
both to 600 looks obviously consistent and would put every healthy sample
exactly on the boundary, so one slow close paints a live account silent.
`min_report_interval_seconds` cannot exceed `sample_interval_seconds` — a longer
throttle would refuse every report the fleet sends and the whole screen would
read silent while every machine was working perfectly.

One row per account per device, overwritten, and never a time series: ~700
accounts every ten minutes would be ~33,600 rows a day and ~8.4M in a year, and
there is no retention mechanism anywhere in this directory. A sample that leaves
an account out does **not** delete it — an account that goes dark is simply
absent from the next sample, and deleting its row at that moment would show
nothing where the one state the desk needs to see should be. Rows leave only by
the device-scoped sweep at the end of the function, on the
`retention_days` horizon.

**Nobody signed in may write to either table, and that is two layers rather than
one.** `revoke all from anon, authenticated` then `grant select` back — the way
step 51 closed `app_users`, but as a complement rather than a list — plus a
RESTRICTIVE policy per verb. The two fail in different directions and you want
both: a revoked privilege answers `permission denied for table` whatever any
policy says, and a RESTRICTIVE policy is what survives a re-run of 52, which
hands every `client_id` table a permissive `for all` with read AND write. SELECT
stays on both tables, or the overview loses its one-request read of the whole
book. DELETE needs its own policy, because `with check` does not govern DELETE: a
delete makes no new row for a check to refuse and is judged by `using` alone.

**And it is `revoke all`, not three named verbs, because TRUNCATE ignores row
level security.** Supabase's default privileges on `public` are `grant all` —
`anon=arwdDxtm/postgres`, `authenticated=arwdDxtm/postgres`, which is eight
privileges and not four. `revoke insert, update, delete` leaves TRUNCATE, TRIGGER,
REFERENCES and MAINTAIN, and a TRUNCATE consults no policy at all: it empties the
table in one statement. Measured before the fix — a signed-in CAM truncated both
tables, and so did the anonymous key. Naming the verbs is also what goes stale:
PostgreSQL 17 added MAINTAIN, so the six-verb form leaves `MAINTAIN,SELECT` behind,
which is what `app_users` carries today. `revoke all` then `grant select` says the
intended thing instead, needs no version-gated keyword, and leaves exactly
`anon=r/postgres,authenticated=r/postgres`.

**The same hole is open on 32 other tables, and 55 does not close them.**
Measured across the whole database: `authenticated` can TRUNCATE 32 of the 37
tables in `public`. The only five it cannot are `app_users` (step 51) and the four
`ingest%` tables. Step 55 closes it for its own two tables and no others — a known
gap, written down so nobody reads the careful revoke in 55 and assumes the rest of
the database matches. Closing the other 32 is its own migration and needs a
table-by-table reading of what each one's browser path actually requires; a blanket
statement written without that reading would take SELECT off something the CRM
reads and break a screen instead of protecting a table.

**Re-running 55 is safe with data in the table, and it will fix one thing if you
ran an earlier copy.** `run_state` shipped with three words and folded
"measured, nothing loaded" into "nobody measured", so a flat desk read as an
unmeasured one every morning before the open. `create table if not exists` does
nothing on a table that already exists, so the file replaces that one column —
and only that column, which is derived, so every value is recomputed from the two
strategy counts the sample carried and no data moves. It prints a NOTICE when it
does. Your hand edits to `account_tracker_settings` survive a re-run untouched.

**57 degrades gracefully in every order, and it needs 55 and 52 first.** The
file refuses to run without them and says so: "step 57 needs step 55
(account_tracker_settings) and step 52 (is_manager): run them first". It also
refuses on a database without step 53's `clients_i_created` or step 28's
`ingest_enrollments`, which the run order puts long before 55: a CAM's desk
figure leaves out every client she can influence, meaning the ones assigned to
her, the ones she created and the ones she enrolled a VPS for, whoever they are
assigned to today. It reads the cycle length from
`account_tracker_settings.sample_interval_seconds`, so there is one interval for
the whole fleet and not two.

The CRM may be deployed before you run it. Until you do, the agents that send
per strategy readings get 404 `strategy_sample_not_deployed` from
`POST /api/ingest/strategies`, stop asking for an hour, and keep posting their
accounts every cycle exactly as today; once you run the file, readings resume
within the hour. The overview panel says "Migration step 57 has not been run".
Agents older than 1.2.0 never call the route at all. The account tracker (step
55's route, function and table) is not touched by anything in this step.

Re-running step 56 BEFORE this file is applied prints the NOTICE "2 exception
row(s) name a table that is not in public: algorithm_live_samples,
algorithm_live_settings". That is expected: step 56 already names these two as
read only, so that whichever order the two files run in, a CAM never gets a
write on them. After 57 runs, the NOTICE goes away.

What it compares. One reading per strategy instance, Realized plus Unrealized as
the Strategies tab shows it, gross and counted since the instance was enabled.
Because that figure is marked to market, desk and client are only ever read from
the same cycle: the agent samples two seconds after each boundary of the
`sample_interval_seconds` grid (in UTC), and a reading taken more than
`cycle_tolerance_seconds` after the boundary, or from a machine whose clock is
off by more than that, is kept as the last reading but never compared. The
newest cycle is compared once it is `cycle_tolerance_seconds` old; until then
the panel says the cycle is still coming in. When you change the interval, for
one cycle the agents still on the old grid read as off cycle, and it heals on
the next account post.

Who sees what. A CAM reads its own clients' rows, as everywhere since step 52.
The desk figure comes only from `algorithm_live_desk()`, which leaves the
caller's own clients out, needs `min_cohort_accounts` accounts AND
`min_cohort_clients` clients outside that book before it returns anything, and
then returns a median and a spread rounded to whole dollars, never a minimum or
a maximum. Under the floor it returns no numbers and no counts. A Manager sees
the whole desk. Every tunable is a column on `algorithm_live_settings`; edit it
in the SQL editor and the CHECK constraints are the review.

Known limits, written down so nobody reads them as faults: after the close the
strategies are switched off and NinjaTrader removes them, so the comparison
stops at the last live cycle and the panel says how old it is. An instance
restarted during the day starts again at 0. The agent marks it as restarted,
and a marked row is never compared, when the instance is missing from a
reading or its run's real time trade count goes down between two readings.
It does NOT see a restart when the strategy is switched off and on before the
old run's first real time trade, when the new run has already made as many
trades as the old one by the next reading, on an add-on that cannot read the
count, or while the agent service itself is down. Such a row is compared with
a figure that counts only since it came back on, and the panel says so in its
basis line.

**58 replaces one function and nothing else, and it is safe to run at any
time.** Step 48's `replace_close_summaries` is SECURITY DEFINER, granted to
`authenticated`, and as written it checked nothing about its caller: it deleted
every summary row of the closes named and inserted whatever rows it was sent.
Since step 52 a CAM reads only its own clients, and since step 56 the browser
holds no write on `close_summaries` at all, so this function was the one way in
and it let any signed-in CAM replace or empty another CAM's summaries through
`/rpc/replace_close_summaries`. Measured on the migration cluster: a CAM that
could read 0 of another CAM's summary rows called it once and that client's Cash
row for the day read -99,999.00.

After 58 the function does what the table's own step 52 policy would allow. A
Manager and the service role (the ingest endpoints and
`scripts/backfill_close_summaries.mjs`) are unchanged. Anyone else may name only
closes of clients assigned to them, and every row must carry its own close's
`client_id`, or the whole call is refused with 42501 before anything is deleted.
The browser's two callers, an upload and a reclassification rebuild, already
send exactly that, so nothing a CAM does in the CRM changes and nothing needs
deploying. A refusal reaches the CAM as an error rather than being mistaken for
"step 48 has not run".

It needs 48 and 52 and refuses to run without them, saying which function is
missing, before it changes anything. `step_48_close_summaries.sql` now carries
the same function, character for character, so re-running 48 after 58 does not
put the unscoped body back; the test beside 58 fails if the two copies differ.
Re-running 48 also no longer brings back its first policy on the table,
`authenticated full access` with `using (true)`: 48 now creates it only on a
`close_summaries` that has no permissive policy yet, so after 52 it leaves
step 52's in place. Before this change a re-run of 48 after 52 put it back
beside step 52's, and every CAM read every client's summaries again. 58's own
closing check runs before its commit, so a database it refuses is left as it
was found.

Verify it in the SQL editor. The catalogue first, which changes nothing:

    select prosrc like '%assigned_client_ids%' as scoped
    from pg_proc where oid = 'public.replace_close_summaries(uuid[], jsonb)'::regprocedure;
    -- PASS: true

    select policyname, permissive, cmd from pg_policies
    where schemaname = 'public' and tablename = 'close_summaries';
    -- PASS: one row, 'cam sees its own clients' | PERMISSIVE | ALL.
    -- FAIL: 'authenticated full access' listed too means 48 was re-run after
    -- 52 under its old text. Drop that one policy and nothing else (re-running
    -- 52 would also undo 53's client policies):
    --   drop policy "authenticated full access" on public.close_summaries;

Then the behaviour, as a real CAM against a close of a client NOT assigned to
them. Find one:

    select u.username, u.auth_user_id, d.id as other_close
    from app_users u
    join daily_imports d on d.client_id not in (
      select a.client_id from client_assignments a where a.cam_profile_id = u.cam_profile_id)
    where u.role = 'CAM' and coalesce(u.status, 'Active') <> 'Inactive'
      and u.auth_user_id is not null
    limit 1;

and call it as that CAM, INSIDE A TRANSACTION THAT ROLLS BACK. The rollback is
the point: if 58 had not applied, this call would delete that close's summaries,
and the rollback is what puts them back.

    begin;
    select set_config('request.jwt.claim.sub', '<auth_user_id>', true);
    set local role authenticated;
    select public.replace_close_summaries(array['<other_close>']::uuid[], '[]'::jsonb);
    rollback;
    -- PASS: ERROR 42501 replace_close_summaries refused: 1 of the 1 closes named
    --       are not on a client assigned to you. Nothing was replaced.
    -- FAIL: a number. The old body is still installed; run 58.

**59 and 60 close the two holes step 52 left. Neither needs a deploy first and
neither depends on the other, or on 58 (PR 74's close summaries step, which was
open when these were written and may land on either side).** 59 reads step 57's
floors and refuses to run without 57, saying so; 60 needs only 52 and 53. Both
were measured before they were written, as the role on the migration cluster
with every step through 57 applied and `request.jwt.claim.sub` set to a CAM.

**59: the log history.** `log_algo_history` kept step 43's `for all using (true)`
through 52 and 56, because 52 narrows tables that carry a `client_id` and this
one carries an account name. Measured: a CAM read every row of every book (an
account belonging to another CAM's client, its family and its P&L), rewrote one
with the browser's own upsert, and a signed-in session with no CRM user behind
it read everything too. After 59 the rows are a Manager's alone, and a CAM gets
the card from `log_algo_history_by_family()`:

- A family is shown to a CAM when the accounts that ran it outside her book reach
  `min_cohort_accounts` AND come from `min_cohort_clients` owners, the two floors
  on `algorithm_live_settings` that step 57 already reads. One floor for every
  desk aggregate a CAM sees: editing it moves both screens. "Her book" is step
  57's: assigned to her, created by her, or enrolled with her code. An account no
  client holds counts as its own owner, so dead accounts still show.
- What is shown is the whole desk, her accounts included, so the figure is the
  Manager's. Under the floor the row reads "Withheld" with no numbers and no
  counts.
- Aggregated rather than scoped by client because the card exists for accounts
  that no longer belong to anyone, which a per client policy would hide from
  every CAM, and because the only reader never displays a row.

The deploy may land either side. Before 59 runs, the new build finds no function
(PGRST202) and aggregates the rows in the browser exactly as it did before.
After 59 runs and before the deploy, the old build's `select *` returns `[]` to a
CAM and the card is hidden for CAMs until the deploy; the Manager's card is
unchanged throughout. The load now waits for a session and reloads when the
signed-in user changes, so step 56's two console errors on the login screen
become one (`strategy_classifications`), and a Manager's history no longer stays
on screen for the next user of the same tab.

**60: who may move a client.** Step 53's assignment policy asked only whether
the session may touch the CLIENT, never which profile the row names, and its
verb was ALL. Measured: a CAM handed a client she holds to another CAM and
deleted her own row; and a CAM who created a client took it back after a
Manager moved it, reading first whom it had gone to and then deleting that CAM's
row. That handoff is the residual step 57's header names: a client assigned to
her but paired under someone else's code leaves every set
`algorithm_live_desk()` excludes for her, and the device on that VPS can then
post readings that count as the rest of the desk.

After 60 a CAM reads the assignment rows of her own clients, inserts exactly one
kind of row (a client she created that nobody holds yet, her own profile), and
never updates or deletes. That is everything the product asks of a CAM:
`createSupabaseClient` assigns the new client to the workspace's own CAM, and
`transferSupabaseClient` is wired only into the Manager overview. No screen
changes.

**60's policies are RESTRICTIVE and step 53's permissive one stays,** because 52
and 53 can both be re-run and each writes a permissive policy on this table (52's
loop drops every permissive policy first). A permissive fix in 60 would be undone
by either, silently. Re-running 52 or 53 after 60 is therefore safe. 60 refuses
to finish if the table has no permissive policy at all, since a restrictive policy
alone refuses every row, a Manager's included: run 53 first in that case.

**Verify both as a CAM, in the SQL editor,** inside a transaction that is rolled
back, with a CAM who holds at least one client (the insert below borrows one of
hers). `auth.uid()` reads the same setting PostgREST sets:

    begin;
    select set_config('request.jwt.claim.sub', '<a CAM''s auth user id>', true);
    set local role authenticated;
    select count(*) from public.log_algo_history;
    -- PASS: 0.  FAIL: any other number -> 59 did not apply.
    select family, status, accounts from public.log_algo_history_by_family();
    -- Each family 'shown' with its counts, or 'withheld' with NULLs.
    insert into public.client_assignments (client_id, cam_profile_id)
      select a.client_id, p.id
      from public.client_assignments a, public.cam_profiles p
      where a.cam_profile_id = public.my_cam_profile_id()
        and p.id <> a.cam_profile_id
      limit 1;
    -- PASS: new row violates row-level security policy
    --       "assignments: a cam assigns only a new client, to itself"
    -- FAIL: INSERT 0 1 -> 60 did not apply.  INSERT 0 0 -> she holds no client.
    rollback;

**47 reads gracefully and writes loudly, so run it BEFORE the deploy.**
Everything below about falling back to the rule is true of *reads* and false of
*writes*, which is the same split step 39 carries and for the same reason.

`mapStrategy` in `src/domain/dailyImportPersistence.js` puts `ran` and
`ran_basis` on every strategy row unconditionally, and the insert path has no
missing-column recovery: the fallback in `supabaseStore.selectRows` is on reads
only. So between a deploy of this branch and this file being run, every manual
upload, every batch import and every auto-collector close fails with PGRST204 on
`strategy_snapshots.ran`. That is the whole ingest, not a dormant feature.

Run 47 before the deploy. If it has already gone out the other way round, run
the file and the ingest recovers on the next attempt; nothing is lost, because a
close that failed at the door was never stored.

**47 also has a second statement to run.** The two columns answer "did this algorithm run that day", which the
product used to decide from `strategy_snapshots.enabled`: the state of a
checkbox at the moment the export was taken, on exports taken after the desk
switches the algos off. On the stored book 1,517 strategy rows are enabled and
2,528 ran, and 207 closes that carry no enabled row at all ran something.

Without it, every screen falls back to the rule over what it holds, which at
login is the checkbox and the row's own realized: the answers the product gave
before this step, unchanged. With it, the answer comes off the row and no longer
needs the day's fills to be loaded at all, which is what the panels are about to
be rebuilt on.

Run the file, then run the backfill, which is deliberately not part of it:

    call public.backfill_strategy_ran_all();

It answers a batch of at most 2,000 rows per transaction, taking closes whole so
none is left half answered, and commits between batches, because one UPDATE
across 14,514 rows would hold locks on all of them for as long as a starved
instance takes, and a procedure cannot commit inside the transaction that runs a
migration file. It is safe to run twice, safe to interrupt and safe
to resume: it looks only for rows where `ran is null`, and re-answering a close
that is already answered writes nothing. Some clients (including `psql -c`) wrap
every statement in a transaction, and the call then fails with `invalid
transaction termination`; from one of those, loop on the one batch function
instead until it returns 0:

    select public.backfill_strategy_ran(2000);

Measured over the stored book, seeded into a local Postgres with every migration
applied: 3,805 rows answered in 516 closes, 1,517 `enabled`, 1,011 `fills`, 0
`realized`, 1,277 `none`, and the second run wrote 0. Those answers are
identical, row for row, to the ones src/domain/strategyRan.js reaches in the
app.

**48 degrades gracefully, and it is the second one with a step to run after the
file.** Until the table is filled the app behaves exactly as it did: `deskMoney`
finds no summary for a close and falls back to the closes the session holds,
which after this change is each client's latest one. The manager's history strip
and month then read short, and the basis line under each figure says how many
closes it could not read. Nothing wrong is displayed; it is incomplete and it
says so.

Fill it once the migration has run:

    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
      node scripts/backfill_close_summaries.mjs

It reads one client at a time and replaces that client's rows in one call, so it
is safe to run twice, safe to interrupt and safe to resume. `--dry-run` reports
what it would write without writing it, and `--client <uuid>` does one client.

THE BACKFILL IS NOT SQL, AND THAT IS THE POINT. Which desk segment an account
close belongs to is decided by `segmentForAccount` in
`src/domain/operationsSegments.js` — it asks whether an account is simulated
before it asks what it is for, reads the CAM's explicit override, and reports an
account type nobody has taught it about under that type's own name rather than
folding it into Unclassified. Writing that again in PL/pgSQL would put the rule
in two languages, which is the defect `deskMoney.js` was created to end. So the
backfill imports the same module the ingest calls, and
`replace_close_summaries` stores what it decided and computes nothing.

A reclassification is retroactive, as it has always been: the split is
recomputed from each account's CURRENT record on every load, so
`updateSupabaseTradingAccount` rebuilds that client's summaries when an
account's type or simulation mode moves. Every stored row also names the
accounts it counted, so a row the rebuild missed is detected on the way back in
and refused rather than quietly under-reporting a day.

47 also replaces `persist_auto_daily_import` so that the automatic collector
stores both columns. The function is step 28's, reproduced with two columns
added to one INSERT; step 37's separate gap on that path (no `derived_realized`,
no `derivation`, and `realized` coalesced to 0) is untouched and still open.

Step 41 replaces only `record_ingest_heartbeat`. It removes both forms of the
invalid ordering rule between `last_success_at` and `last_capture_at`; either
timestamp may honestly be newer. The independent five-minute future-skew
checks remain in place. It does not rewrite stored device rows.

Step 39 adds columns and rewrites nothing. Every client already marked Inactive
keeps a null reason and a null date, which the app reports as "Not recorded"
rather than back-filling to `other` — `other` is an option a CAM can choose, and
a back-fill would make silence indistinguishable from an answer in the one column
that exists to be counted.

Step 38 is the only one that rewrites a column that already held something. 47
writes to existing rows too, but only into the two columns it adds in the same
file, so nothing that was there before it ran can be lost by it. 38 is
idempotent (a second run
finds no `Acknowledged` rows) and reversible in one statement, which
`step_38_flag_acknowledged_to_resolved.sql` spells out at the top.
