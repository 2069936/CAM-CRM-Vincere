-- Step 56: the four privileges row level security cannot see.
--
-- WHY 54 IS SKIPPED, AND WHAT HAPPENED TO 55. step_54 is claimed by draft PR 65
-- (Deep Export) and is still unmerged; 55 by PR 67 (per-account live samples),
-- WHICH HAS SINCE MERGED. This file took 56 so that neither of them would have
-- to renumber, and that turned out to matter: 55 landed between this file being
-- written and this file being merged. Section 2 below is the whole story of what
-- that cost, and it is the most useful thing in this header - THE MIGRATION
-- AGAINST STALENESS WENT STALE, because it enumerated what to grant BACK.
--
-- AND IT NARROWS ONE DECISION STEP 55 MADE, by name rather than by side effect:
-- step 55 granted SELECT on account_live_samples and account_tracker_settings to
-- `anon, authenticated`. This file takes the anon half. The argument is in the
-- anon section below; the short version is that nothing reads either table
-- without a session and no policy admits anon to a row of either, so the grant
-- buys anon nothing and "grant back only what is needed" says it goes. step 55's
-- own line is edited to say `to authenticated`, so the files agree with each
-- other rather than one of them being silently overruled two steps later.
--
-- ===========================================================================
-- WHAT IS WRONG, MEASURED ON THIS PROJECT RATHER THAN INFERRED.
--
-- Default privileges in schema public:
--
--   {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--
-- and a second identical line owned by supabase_admin. `arwdDxtm` is all eight
-- privileges. The D is TRUNCATE and the m is MAINTAIN.
--
-- So every table any migration in this directory has ever created was BORN
-- holding all eight for anon and for authenticated. Nobody granted them and
-- nobody reviewed them. Per table, what `authenticated` holds right now:
--
--   all eight, on THIRTY TWO tables: account_snapshots, activity_logs,
--   algorithm_benchmarks, audit_logs, cam_profiles, cam_time_off,
--   client_assignments, client_coverage, client_credentials,
--   client_price_changes, client_prop_firms, clients, close_summaries,
--   daily_imports, daily_sop_checklists, executions,
--   ingest_admission_settings, ingest_quarantine_reports, log_algo_history,
--   operational_flags, orders, payout_events, price_checks, reports, sop_items,
--   sop_sections, sop_templates, strategy_classifications, strategy_snapshots,
--   strategy_templates, tasks, trading_accounts
--
--   SELECT plus MAINTAIN on app_users. Step 51 revoked by ENUMERATION -
--   `revoke truncate, trigger, references` - and MAINTAIN was not on its list,
--   because PostgreSQL 17 had not invented it when that list was written. It is
--   still there. That one leftover letter is the whole argument of this file.
--
--   nothing at all on ingest_batches, ingest_devices, ingest_enrollments and
--   ingest_pair_rate_limits. step_28 lines 356-359 revoked those explicitly.
--   They are left exactly as they are.
--
-- WHY THIS MATTERS MORE THAN ANYTHING ELSE IN THIS DATABASE.
--
-- Steps 52 and 53 gave every table real per-CAM row level security, and the
-- browser reaches PostgREST directly with the publishable key. All of that
-- governs ROWS.
--
-- TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY AT ALL. It empties the table
-- without consulting a single policy. Verified by doing it, as the
-- `authenticated` role, against a cluster carrying every migration in this
-- directory: `truncate table public.orders` SUCCEEDS. So a signed-in CAM can
-- destroy 32 tables including clients, trading_accounts, orders, executions and
-- client_credentials, and every policy steps 52 and 53 built watches it happen.
--
-- TRIGGER lets them attach code that runs on somebody else's writes.
-- REFERENCES lets an unaudited table decide whether a row can be deleted.
-- MAINTAIN allows VACUUM, ANALYZE, REINDEX, CLUSTER and REFRESH MATERIALIZED
-- VIEW on a table they do not own.
--
-- ===========================================================================
-- THE SHAPE: REVOKE ALL, THEN GRANT BACK WHAT IS USED.
--
-- NOT a list of privileges to remove. Enumerating what to remove is exactly
-- what left MAINTAIN on app_users for a year. Enumerating what to KEEP means a
-- ninth privilege invented in PostgreSQL 19 is absent by default rather than
-- present by default, and nobody has to remember this file exists.
--
-- The four DML verbs stay where the application uses them, because row level
-- security governs them per row and that is the design steps 52 and 53 built.
-- TRUNCATE, TRIGGER, REFERENCES and MAINTAIN go everywhere, with no per-table
-- judgement, because RLS governs none of them and nothing in this repository
-- needs them: not the browser, not the API, not any script.
--
-- WHICH VERB EACH TABLE KEEPS WAS MEASURED, NOT GUESSED. The browser's entire
-- PostgREST surface is two files, src/domain/supabaseStore.js and
-- src/domain/supabaseAuth.js. Everything under api/ and server/ runs on the
-- service role, which is BYPASSRLS and whose grants this file does not touch.
-- Four call sites use `.from(table)` with a VARIABLE, so grepping for
-- `.from('name')` cannot see them and an earlier count of 23 written tables
-- missed four:
--
--   deleteDailyImportRows `.delete()` and insertRows `.insert()` inside
--   createSupabaseDailyImportAdapter (supabaseStore.js) - the manual-import
--   re-upload, gated by its deleteTables/insertTables sets to
--   strategy_snapshots, orders, executions and operational_flags. Three of
--   those appear nowhere in this repository as a literal table name. Revoking
--   their DELETE or INSERT breaks every manual close re-upload, on a trading
--   day.
--
-- An `upsert` needs INSERT **and** UPDATE: PostgREST emits
-- `insert ... on conflict do update`. Twelve tables reach the database only
-- that way, so granting one of the two would leave each working on its first
-- write and failing on every write after - a bug that passes a smoke test.
--
-- ===========================================================================
-- anon GETS NOTHING, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE.
--
-- anon is the unauthenticated key and it ships inside the browser bundle, so
-- what it holds is public. The sign-in flow does run before a session exists,
-- which is the one thing that could make a table grant necessary:
-- src/domain/supabaseAuth.js resolveLoginEmail. Read end to end, it needs no
-- table:
--
--   :42  an input containing '@' is returned with no network call at all.
--   :44  otherwise it calls rpc('login_email_for_username'), which step 43
--        made `security definer` and granted to anon. A definer function does
--        not consult the caller's table privileges.
--   :51  the fallback `.from('app_users').select('email')` fires only when
--        isMissingFunction() is true (:61-67: PGRST202, 404, or /could not find
--        the function|does not exist/), so never once step 43 has run.
--
-- AND IT COULD NOT SUCCEED IF IT DID FIRE. EVERY permissive policy in schema
-- public names `to authenticated` - counted from the catalogue rather than from a
-- number written here, because a number written here is the defect section 2 is
-- about. Not one omits its TO clause, which would have defaulted to PUBLIC and
-- quietly included anon. The only policies naming anon are RESTRICTIVE denials:
-- the `using (false)` ones on the ingest tables, and the two step 55 added. So an
-- anon SELECT on app_users already returns zero rows, and supabaseAuth.js:57
-- throws 'Unknown username or email.'
--
-- WHICH IS ALSO THE WHOLE OF THE STEP 55 ARGUMENT, so it is settled here rather
-- than left as a disagreement between two files. step 55 wrote
--
--   grant select on public.account_live_samples    to anon, authenticated;
--   grant select on public.account_tracker_settings to anon, authenticated;
--
-- and this file asserts, in supabase/anon_keeps_the_login_function.test.js, that
-- NO migration grants a table privilege to anon. Both cannot be right. Four
-- things were checked rather than preferred, and all four say the anon half goes:
--
--   1. THE ONE BROWSER READER IS BEHIND A SESSION. loadSupabaseAccountTracker
--      (supabaseStore.js:889) is called from exactly one place, the overview
--      effect at App.jsx:10539-10563, and that effect returns early unless
--      `trackerScope` is non-empty - a list of client ids derived from
--      workingClients, which only exists after loadSupabaseCrmState has run for a
--      signed-in session. The panel is in the browser, and a browser showing it
--      holds a session, so it reads as `authenticated` and never as anon.
--   2. NO POLICY ADMITS anon TO A ROW OF EITHER. step_55:730 and :791 are both
--      `for select to authenticated`. The only anon-facing policies on those two
--      tables are step 55's own restrictive write and delete denials. So the
--      grant could not have returned a row even if something had used it: anon
--      got `200 []`, the same shape step 51 was wrong about on app_users.
--   3. NOTHING ELSE NAMES THEM FROM THE BROWSER KEY. loadSupabaseDiagnostics
--      (supabaseStore.js:1797) - the one read that does happen without a session,
--      because /database renders before App.jsx's session gate - probes twenty
--      tables and neither of these is among them. The reads in
--      server/autoCollection/ run on the service role.
--   4. AND THE GRANT WAS DEAD EITHER WAY, because this file's blanket
--      `revoke all privileges on all tables in schema public from anon` reaches
--      it. So the END STATE of the database does not depend on which answer is
--      taken; what depends on it is whether the two files say the same thing. A
--      grant that is dead today is one a policy added later turns live by
--      accident, which is exactly the hazard step 51 left on app_users.
--
-- So step 55's two lines become `to authenticated` and this file's invariant
-- holds as a property of the directory rather than as something step 56 cleans up
-- afterwards. THAT IS A CHANGE TO A SHIPPED DECISION and it is argued, not
-- assumed: step 55 is merged, Pedro may already have applied it, the statements
-- are idempotent, and re-running the edited file removes a privilege nothing uses
-- and takes nothing else. If it ever turns out that something DOES need to read
-- the tracker without a session, the fix is one `to anon, authenticated` in step
-- 55 plus an exception in that test, said out loud in both places.
--
-- STEP 51 IS WRONG ABOUT THIS AND IT IS CORRECTED HERE BY NAME. Its header
-- says, of SELECT on app_users, "Revoking SELECT would lock everyone out."
-- That is true of `authenticated`, which really does read its own row to sign
-- in and really does have a policy admitting it. It is false of `anon`, and it
-- got there by symmetry at step_51 lines 42 and 55 without being rechecked. A
-- protective comment that is load-bearing for one role and false for another is
-- more dangerous than no comment, because it stops the next person removing
-- something that should go.
--
-- ===========================================================================
-- WHAT THIS FILE MUST NOT DO: TAKE A FUNCTION GRANT.
--
-- There is no `revoke ... on all functions in schema public` here, and there
-- must never be one. It is the tempting one-liner that matches this file's own
-- philosophy, and it revokes EXECUTE on login_email_for_username from anon,
-- which locks every CAM who types a username out of the CRM. That is the one
-- failure worse than the hole being closed.
--
-- It fails loudly and unrecoverably rather than degrading, which is worth
-- knowing: a permission denial is code 42501 / status 403 / "permission denied
-- for function", and isMissingFunction (supabaseAuth.js:61-67) matches only
-- PGRST202, 404 and /does not exist/. It matches none of them, so
-- resolveLoginEmail RETHROWS instead of falling back, and the raw Postgres
-- message lands in the login form.
--
-- THE RECOVERY PATH, IF IT EVER HAPPENS: sign in with your EMAIL ADDRESS
-- instead of your username. supabaseAuth.js:42 short-circuits before any
-- network call, so an email sign-in works with every anon privilege revoked.
-- The login field is labelled "Username" and says nothing about this, so it is
-- written down here. Then restore:
--   grant execute on function public.login_email_for_username(text) to anon;
--
-- ===========================================================================
-- THE DEFAULT PRIVILEGES, AND THE HALF OF THEM THIS FILE CANNOT REACH.
--
-- Closing the tables that exist fixes today - however many there are, since
-- section 2 counts them from the catalogue rather than carrying a number. It does
-- not fix the next table:
-- `alter default privileges` is why strategy_templates, ingest_admission_settings
-- and ingest_quarantine_reports each hold all eight privileges while no caller
-- in this repository names them at all. They were born that way. So is whatever
-- step 57 creates.
--
-- There are TWO default-privilege lines, one owned by postgres and one owned by
-- supabase_admin. This file changes the one owned by the session that runs it,
-- which in the Supabase SQL editor is postgres.
--
-- IT CANNOT CHANGE THE supabase_admin LINE, and here is the measurement rather
-- than a guess: `alter default privileges for role supabase_admin ...` requires
-- membership in supabase_admin, and a session that is not a member is refused
-- with `permission denied to change default privileges`. Supabase's postgres is
-- not a superuser and is not a member of supabase_admin. The attempt is made
-- below inside an exception handler so this migration cannot fail on it, and it
-- raises a NOTICE saying what happened.
--
-- PEDRO: if that NOTICE says the supabase_admin line was NOT changed, a table
-- created BY supabase_admin - which is not how any migration in this directory
-- creates tables, but is how some Supabase dashboard actions do - will still be
-- born holding all eight. Closing it needs the Supabase support team, or a
-- session as supabase_admin, which the SQL editor does not give you. It is not
-- a hole this file can reach and it should not stop this file running.
--
-- THE OTHER OBJECT TYPE NOBODY HAS MEASURED. The quoted line above is
-- `defaclobjtype = 'r'` - tables. Nobody has looked at 'f' - FUNCTIONS. If the
-- function line also grants to anon, then every security definer function in
-- public is anon-callable AT BIRTH, and one of them answers:
-- public.client_is_assigned(uuid) is definer and does NOT filter on auth.uid(),
-- so it is a boolean oracle over client_assignments that bypasses RLS for an
-- unauthenticated caller holding the publishable key. The four targeted
-- function revokes below close it either way. Run this to see which it was:
--
--   select d.defaclobjtype, pg_get_userbyid(d.defaclrole) as granted_by,
--          n.nspname as schema, d.defaclacl
--   from pg_default_acl d
--   left join pg_namespace n on n.oid = d.defaclnamespace
--   order by 3, 1, 2;
--
-- ===========================================================================
-- TWO THINGS THAT WILL LOOK LIKE BREAKAGE AND ARE NOT.
--
-- 1. THE LOGIN SCREEN WILL LOG TWO CONSOLE ERRORS ON EVERY FRESH TAB.
--    src/App.jsx loads strategy_classifications and log_algo_history from two
--    `[]`-deps effects (loadStrategyClassifications, loadLogAlgoHistory) that
--    have no `if (!session) return;` guard -
--    only `if (!isSupabaseConfigured) return;` - so they fire while the login
--    form is on screen, as anon. Today they get `200 []`: the grant allows the
--    read and no policy admits anon to a row. After this migration they get
--    42501 and each effect's `.catch(console.error)` prints
--    `[CRM] Failed to load strategy classifications:`. No user-visible change,
--    and NOT because anything reloads them: nothing does, setStrategyClassifications
--    and setLogAlgoHistory have no other caller. It is because on a fresh sign-in
--    those reads already returned `200 []` as anon, so the slice was already
--    empty, and on a refresh the session is restored from sessionStorage before
--    the effects run, so they run as authenticated and load. The one-line
--    session guard in each effect is the right follow-up and is not a SQL
--    change.
--
-- 2. /database WILL GO RED. src/App.jsx renders DatabaseCheck on the
--    `/database` path BEFORE the `if (!session)` gate, and vercel.json rewrites everything
--    non-/api/ to index.html, so the page is publicly reachable with no
--    session. loadSupabaseDiagnostics (supabaseStore.js) probes 20 tables
--    and will report `permission denied for table ...` for each instead of a
--    count of 0. Errors are caught per table and rendered, never thrown, so
--    nothing crashes - the page reports "Needs attention". That page only ever
--    told the truth when signed in; now it tells it louder.
--
-- AND ONE DEAD POLICY, so nobody "fixes" it. clients is soft-deleted -
-- softDeleteSupabaseClient (supabaseStore.js) is an UPDATE setting status
-- and deleted_at - and the browser never issues a DELETE on it. DELETE is
-- therefore not granted back, which makes step_52's "cam deletes its own
-- clients" policy unreachable. That is correct and deliberate. Do not grant
-- DELETE on clients to make the policy live again.
--
-- A NEW VERB NEEDS A LINE IN THIS FILE. If a future feature adds a DELETE on
-- reports, or an UPDATE on orders, it will fail with 42501 - a permission
-- error, not an RLS denial - and the fix is a grant here, deliberately, rather
-- than four verbs everywhere by default. That is the cost of the shape and it
-- is paid knowingly.
--
-- Idempotent: revoke-then-grant reaches the same end state every time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Refuse to run out of order, BEFORE anything is changed.
--
-- This file revokes first and grants back second, so a run that dies halfway
-- leaves the CRM with privileges taken away and not restored - on a trading day.
-- The SQL editor does not wrap a file in a transaction, so "it failed" is not
-- the same as "nothing happened".
--
-- The things it needs: the tables it grants on, and the four functions it
-- revokes from anon, which steps 52 and 53 create. Checked up front so the
-- answer is "nothing has been changed yet" rather than a cryptic failure after
-- the revokes have landed.
-- ---------------------------------------------------------------------------
do $do$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing from (
    select unnest(array[
      'is_manager()', 'assigned_client_ids()',
      'client_is_assigned(uuid)', 'clients_i_created()'
    ]) as name) f
  where to_regprocedure('public.' || f.name) is null;
  if missing is not null then
    raise exception
      'step 56 needs steps 52 and 53 first: public.% not found. Nothing has been changed.',
      missing;
  end if;

  select string_agg(name, ', ') into missing from (
    select unnest(array['app_users', 'clients', 'orders', 'trading_accounts']) as name) t
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception
      'step 56 needs the base schema first: public.% not found. Nothing has been changed.',
      missing;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 1. anon. Revoke everything; grant nothing back.
--
-- `on all tables` covers VIEWS as well, which is intended: public holds one,
-- auth_mapping_status, and it joins app_users to auth.users to expose the
-- username, display name, email, role and last sign-in of every staff account.
-- step 43 took it away from anon and set security_invoker on it; nothing in
-- src/ reads it, so authenticated loses it here too.
-- ---------------------------------------------------------------------------
revoke all privileges on all tables in schema public from anon;

-- Restated rather than assumed. Nothing in this schema grants to the PUBLIC
-- pseudo-role today, and a `grant ... to public` added later would hand every
-- role including anon whatever it names.
revoke all privileges on all tables in schema public from public;

-- ---------------------------------------------------------------------------
-- 2. authenticated. Revoke by CATALOGUE, then grant back by CATALOGUE, with an
--    explicit EXCEPTION TABLE for the tables that get less than the four verbs.
--
-- THE MIGRATION AGAINST STALENESS WENT STALE. That is this file's own argument
-- arriving from the other side, and it is worth the space rather than a quiet
-- fix.
--
-- The argument at the top of this file is against enumerating what to REMOVE:
-- step 51 wrote `revoke truncate, trigger, references`, PostgreSQL 17 then
-- invented MAINTAIN, and app_users carries it today. The first draft of this
-- file answered that by enumerating what to KEEP - five
-- `grant ... on public.a, public.b, ... to authenticated` statements naming 33
-- tables. An enumeration of what to keep goes stale the same way, one direction
-- over: it goes stale when a TABLE is added rather than when a PRIVILEGE is.
--
-- AND IT DID, BEFORE THIS FILE COULD MERGE. step_55 - account_live_samples and
-- account_tracker_settings - merged after this file was written. The blanket
-- `revoke all privileges on all tables` above reached both, because it reads the
-- catalogue and holds no list. The five grant statements had never heard of
-- them, so neither came back out of this file at all; and the test beside this
-- file asserted `toHaveLength(37)` against a schema that now holds 39, so a
-- count had to be edited for a migration that had nothing to do with it. Both
-- halves of that are the same defect as step 51's, written by somebody who had
-- just spent a day explaining step 51's.
--
-- So the grant-back reads the catalogue too, and the only list left is the
-- exception table below: what each table gets and WHAT DECIDED IT.
--
-- WHY A BLANKET `grant select, insert, update, delete` ON EVERY TABLE WOULD HAVE
-- BEEN WORSE THAN THE STALE LIST, which is why the exception table is not a
-- convenience. step_55 deliberately made its two tables read-only for the
-- browser - `revoke all` then `grant select` - because a CAM able to write
-- account_live_samples can forge a green light on its own client, and a row it
-- can delete is an account that disappears from the screen that exists to show
-- it. This file runs AFTER step 55, so a four-verb loop with no exceptions would
-- hand INSERT, UPDATE and DELETE straight back and THIS FILE would be the thing
-- that undid a lockdown three rounds of review produced. The same is true of the
-- four ingest tables step_28 closed and the two steps 45 and 46 closed: all six
-- hold nothing today and a loop with no exceptions opens all six.
--
-- WHAT HAPPENS TO A TABLE IN NEITHER PLACE - the case that just bit. It gets the
-- four DML verbs, and this file SAYS SO BY NAME in a NOTICE rather than doing it
-- quietly. Both halves are deliberate.
--
--   THE FOUR VERBS, because that is exactly what section 5 below hands a table
--   created AFTER this file runs. If an unlisted table got nothing instead, then
--   whether a table was usable would depend on which side of this migration it
--   was created on - the database's answer would depend on the order its history
--   happened to take, which is the same objection section 6 makes to
--   information_schema. The four are the ones row level security governs, and
--   since step 44 every new table carries its own RLS and its own policy inline,
--   so "writable" still means "the rows a policy admits" - which for a table
--   with RLS and no policy is none. The four privileges this file exists to take
--   away are never granted, to any table, listed or not.
--
--   THE NOTICE, because granting silently is exactly how step 55 would have been
--   undone, and nothing in the catalogue tells a table nobody has decided about
--   from a table somebody decided should be read-only. The NOTICE names them, so
--   a person running this sees a name they did not expect. It is NOT fatal: a
--   migration that refused to run until somebody edited it would be the stale
--   list again wearing a different hat, and Pedro re-runs files he is not sure
--   landed.
--
-- THE CLEVER VERSION, REJECTED ON PURPOSE: read each table's CURRENT ACL and
-- keep whatever narrowing an earlier migration already made - before this file
-- runs every table holds all eight, so "narrower than eight" does mean somebody
-- decided. It works, and it makes this file's end state a function of the
-- database's history rather than of its own text: two clusters with different
-- pasts would end differently and neither could be predicted by reading this.
-- The exception table says the same thing where a person can read it.
--
-- WHY THE EXCEPTION TABLE LISTS THE SEVEN FULL-DML TABLES TOO, when the default
-- would give them the same thing: so that ABSENCE from it means "nobody has
-- decided", and not "four verbs, on purpose". Those are different facts and the
-- NOTICE above is only worth having if they can be told apart.
-- ---------------------------------------------------------------------------
revoke all privileges on all tables in schema public from authenticated;

do $do$
declare
  r record;
  took_the_default text[];
  stale text[];
  disagrees text;
begin
  -- A TEMP TABLE RATHER THAN A CTE, because three passes read this list - the
  -- grant loop, the stale-entry check and the self-check - and a CTE would mean
  -- writing it three times, which is how two of the three come to disagree. It
  -- is `on commit drop`, so it lives for this statement and leaves nothing
  -- behind; a re-run in the same SQL editor session starts from empty.
  create temp table step_56_exceptions (
    table_name text primary key,
    privileges text not null,
    decided_by text not null
  ) on commit drop;

  insert into step_56_exceptions (table_name, privileges, decided_by) values
    -- ALL FOUR VERBS: every one of the four is exercised by the browser.
    ('client_assignments',       'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    ('client_coverage',          'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    ('daily_imports',            'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    -- operational_flags is insert+delete through `.from(table)` in
    -- createSupabaseDailyImportAdapter and update through a literal.
    ('operational_flags',        'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    ('strategy_classifications', 'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    ('tasks',                    'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),
    ('trading_accounts',         'select, insert, update, delete', 'step 56, measured on supabaseStore.js'),

    -- NO UPDATE: appended to and removed from, never edited in place. executions,
    -- orders and strategy_snapshots are three of the four reached only through
    -- `.from(table)` with a VARIABLE in createSupabaseDailyImportAdapter - the manual
    -- close re-upload - so a grep for `.from('name')` cannot see them and
    -- revoking their DELETE or INSERT breaks every re-upload, on a trading day.
    ('activity_logs',            'select, insert, delete', 'step 56, measured on supabaseStore.js'),
    ('client_prop_firms',        'select, insert, delete', 'step 56, measured on supabaseStore.js'),
    ('executions',               'select, insert, delete', 'step 56, measured on createSupabaseDailyImportAdapter'),
    ('orders',                   'select, insert, delete', 'step 56, measured on createSupabaseDailyImportAdapter'),
    ('price_checks',             'select, insert, delete', 'step 56, measured on supabaseStore.js'),
    ('strategy_snapshots',       'select, insert, delete', 'step 56, measured on createSupabaseDailyImportAdapter'),

    -- NO DELETE: nothing in the browser deletes from these. account_snapshots
    -- loses its DELETE safely because deleteSupabaseDailyImport removes only the
    -- daily_imports row and the children go by ON DELETE CASCADE, which is a
    -- referential action and is not privilege-checked. clients is soft-deleted -
    -- softDeleteSupabaseClient (supabaseStore.js) is an UPDATE - which makes
    -- step_52's "cam deletes its own clients" policy unreachable. That is correct
    -- and deliberate: do NOT add delete here to make the policy live again.
    ('account_snapshots',        'select, insert, update', 'step 56, measured on supabaseStore.js'),
    -- NOT read-only: saveAlgorithmBenchmarks (supabaseStore.js) upserts,
    -- called from the My Futures Book import. An earlier count got this wrong.
    ('algorithm_benchmarks',     'select, insert, update', 'step 56, measured on saveAlgorithmBenchmarks'),
    ('cam_profiles',             'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('cam_time_off',             'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('client_credentials',       'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('clients',                  'select, insert, update', 'step 56, soft-deleted by softDeleteSupabaseClient'),
    ('daily_sop_checklists',     'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('log_algo_history',         'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('reports',                  'select, insert, update', 'step 56, measured on supabaseStore.js'),
    -- The SOP tables are NOT uniform. These two are written by the SOP editor;
    -- sop_templates below is seeded by migration and only read.
    ('sop_items',                'select, insert, update', 'step 56, measured on supabaseStore.js'),
    ('sop_sections',             'select, insert, update', 'step 56, measured on supabaseStore.js'),

    -- APPEND ONLY. client_price_changes has no reader in this repository and
    -- SELECT is kept anyway: step_42:125-127 says a management dashboard is meant
    -- to read it and :148 already grants exactly these two. Its insert at
    -- updateSupabaseClient (supabaseStore.js) is deliberately fire-and-forget - `.then(() => {},
    -- () => {})` - so a revoked INSERT would fail SILENTLY and the revenue
    -- movement figures would quietly go empty. That is the worst failure shape in
    -- this migration: no error reaches anyone.
    ('audit_logs',               'select, insert', 'step 56, measured on supabaseStore.js'),
    ('client_price_changes',     'select, insert', 'step 42:148, restated - a revoked insert here is SILENT'),
    ('payout_events',            'select, insert', 'step 56, measured on supabaseStore.js'),

    -- READ ONLY.
    ('app_users',                'select', 'step 51, in a shape that cannot go stale - every write is api/admin/users.js on the service role'),
    ('close_summaries',          'select', 'step 48:147-204, written by replace_close_summaries, which is SECURITY DEFINER'),
    ('sop_templates',            'select', 'step 56, seeded by migration and only read'),
    -- The one judgement call left in this file. No browser caller names
    -- strategy_templates, so "grant nothing" is defensible; SELECT is granted
    -- because step_52:49 and :264 deliberately left it the open policy, calling
    -- it desk reference a CAM may legitimately read. Revoking it would contradict
    -- a decision taken on purpose one migration ago while adding no safety, since
    -- a read is governed by that policy and cannot destroy anything.
    ('strategy_templates',       'select', 'step 52:49 and :264, desk reference a CAM may read'),
    -- STEP 55'S TWO TABLES, AND THE REASON THIS WHOLE SECTION IS A LOOP. Step 55
    -- decided these are read-only for the browser and argued it at length; this
    -- file runs after it and must not be the thing that widens them. Step 55
    -- granted its SELECT to `anon, authenticated`; step 56 narrows that to
    -- authenticated and the header says why.
    ('account_live_samples',     'select', 'step 55:714-717, read-only so a CAM cannot forge a green light'),
    ('account_tracker_settings', 'select', 'step 55:714-717, read-only - the screens read stale_sample_seconds'),
    -- STEP 57'S PAIR, the same decision for the same reason. Named here before
    -- step 57 exists, so a re-run of this file before 57 is applied prints the
    -- "names a table that is not in public" NOTICE for these two; that is
    -- expected, and the 57 runbook row says so.
    ('algorithm_live_samples',   'select', 'step 57, read-only so a CAM cannot forge a strategy reading'),
    ('algorithm_live_settings',  'select', 'step 57, read-only; the screens read the floors'),
    -- STEP 65'S SETTINGS ROW, the same decision again: the browser reads the
    -- thresholds and never writes them. Named before 65 exists for the same
    -- reason as 57's pair, and the same NOTICE on a re-run before 65 is applied.
    ('account_observation_settings', 'select', 'step 65, read-only; the screens read the thresholds'),

    -- NOTHING AT ALL. ingest_admission_settings and ingest_quarantine_reports
    -- each carry a restrictive `deny browser direct access` policy (step_45:490,
    -- step_46:266) and no permissive policy, so authenticated already reads no
    -- row of either; they held all eight anyway, because they were created after
    -- step 43 and born with them. The other four were revoked outright by
    -- step_28:356-359 and this file leaves them exactly as they are - WHICH IT
    -- CAN ONLY DO BY NAMING THEM, because the catalogue default would open all
    -- four.
    ('ingest_admission_settings', '', 'step 45:490, restrictive deny and no permissive policy'),
    ('ingest_quarantine_reports', '', 'step 46:266, restrictive deny and no permissive policy'),
    ('ingest_batches',            '', 'step 28:356-359, revoked outright'),
    ('ingest_devices',            '', 'step 28:356-359, revoked outright'),
    ('ingest_enrollments',        '', 'step 28:356-359, revoked outright'),
    ('ingest_pair_rate_limits',   '', 'step 28:356-359, revoked outright');

  -- THE LOOP. Every base table in public, read from the catalogue, with no list.
  for r in
    select c.relname::text as table_name,
           coalesce(e.privileges, 'select, insert, update, delete') as privileges,
           (e.table_name is not null) as decided
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join step_56_exceptions e on e.table_name = c.relname::text
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by 1
  loop
    if r.privileges <> '' then
      -- %s and not %I: the privilege list is a literal out of this file, and the
      -- table name goes through %I so a name needing quotes still works.
      execute format('grant %s on public.%I to authenticated', r.privileges, r.table_name);
    end if;
  end loop;

  -- THE TABLES NOBODY HAS DECIDED ABOUT, named rather than granted in silence.
  select array_agg(c.relname::text order by c.relname)
    into took_the_default
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join step_56_exceptions e on e.table_name = c.relname::text
  where n.nspname = 'public' and c.relkind in ('r', 'p') and e.table_name is null;

  if took_the_default is not null then
    raise notice
      'step 56: % table(s) are named in no exception row and took the catalogue '
      'default of select, insert, update, delete: %. None of them can TRUNCATE, '
      'TRIGGER, REFERENCE or MAINTAIN - that part needs no list. But if one of '
      'these was meant to be narrower than four verbs, it needs a row in the '
      'exception table in step_56_table_privilege_lockdown.sql, and this NOTICE '
      'is the only warning there is.',
      array_length(took_the_default, 1), array_to_string(took_the_default, ', ');
  end if;

  -- AN EXCEPTION ROW FOR A TABLE THAT NO LONGER EXISTS is a dead decision, and a
  -- dead row is how the next reader concludes a table is locked down when nothing
  -- locked it down. Not fatal - dropping a table must not make an earlier
  -- migration unrunnable - and the test beside this file fails on it instead.
  select array_agg(e.table_name order by e.table_name)
    into stale
  from step_56_exceptions e
  where to_regclass(format('public.%I', e.table_name)) is null;

  if stale is not null then
    raise notice
      'step 56: % exception row(s) name a table that is not in public: %. '
      'Each one is a decision about nothing; remove it.',
      array_length(stale, 1), array_to_string(stale, ', ');
  end if;

  -- THE LOOP CHECKING ITS OWN WORK, asked of the catalogue. A typo'd privilege
  -- string is otherwise invisible: `grant selct` raises, but a row that says
  -- `select, insert` where `select` was meant does not.
  --
  -- A WARNING AND NOT AN EXCEPTION, deliberately, and this is the one place in
  -- this file where that choice is not obvious. Raising here would roll back this
  -- DO block - the grants - while leaving the committed `revoke all` above in
  -- place, which is precisely the "privileges taken away and not restored, on a
  -- trading day" that section 0 exists to prevent. So the database keeps working
  -- and says what it disagrees with, and the hard version of this assertion lives
  -- in step_56_table_privilege_lockdown.test.js, which can fail as loudly as it
  -- likes because nobody's desk depends on it.
  select string_agg(format('%s wants [%s] and holds [%s]', e.table_name, want.list, got.list), '; '
                    order by e.table_name)
    into disagrees
  from step_56_exceptions e
  cross join lateral (
    select coalesce(string_agg(w, ',' order by w), '') as list
    from unnest(string_to_array(replace(e.privileges, ' ', ''), ',')) w
    where w <> ''
  ) want
  cross join lateral (
    select coalesce(string_agg(p, ',' order by p), '') as list
    from unnest(array['delete', 'insert', 'maintain', 'references',
                      'select', 'trigger', 'truncate', 'update']) p
    where has_table_privilege('authenticated', format('public.%I', e.table_name), p)
  ) got
  where to_regclass(format('public.%I', e.table_name)) is not null
    and want.list <> got.list;

  if disagrees is not null then
    raise warning
      'step 56: the grant loop did not produce what the exception table says: %. '
      'Every other privilege in this file is still as intended; this names the '
      'rows that are not.', disagrees;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 3. The four function grants steps 52 and 53 did not reach.
--
-- Both files wrote `revoke all on function ... from public`. That removes the
-- PUBLIC pseudo-role's implicit EXECUTE. It does NOT remove a DIRECT grant to
-- anon, and a direct grant to anon is what `alter default privileges ... on
-- functions` hands out at creation - the same mechanism as the table defect
-- above. Every other migration in this directory writes `from public, anon,
-- authenticated`; 32 such statements across 8 files. Steps 52 and 53 are the
-- only two that do not.
--
-- client_is_assigned is the one that matters: it is `security definer` and does
-- NOT filter on auth.uid(), so unlike the other three it returns a real answer
-- to a caller with no session.
-- ---------------------------------------------------------------------------
revoke all on function public.is_manager() from anon;
revoke all on function public.assigned_client_ids() from anon;
revoke all on function public.client_is_assigned(uuid) from anon;
revoke all on function public.clients_i_created() from anon;

-- ---------------------------------------------------------------------------
-- 4. The two anon function grants that MUST SURVIVE, written as grants rather
--    than as a comment so they are idempotent, self-documenting, and visible to
--    `grep "to anon" step_56*.sql`. A later reader must not mistake silence for
--    absence.
-- ---------------------------------------------------------------------------

-- Username sign-in calls this before a session exists
-- (src/domain/supabaseAuth.js:44). Take it away and every CAM who types a
-- username is locked out of the CRM. THIS IS THE ONE LINE THAT MUST NOT BE
-- TIDIED AWAY.
grant execute on function public.login_email_for_username(text) to anon;

-- Granted by step_1:147 and called by nothing in the app. It is `security
-- definer` but filters on auth.uid(), so without a session it answers nothing.
-- step_43:43-45 already made this argument once; it is restated here so the
-- reasoning does not have to be reconstructed a third time.
grant execute on function public.current_app_user() to anon;

-- ---------------------------------------------------------------------------
-- 5. Default privileges, so the NEXT table is not born with the hole.
--
-- anon: nothing, ever. authenticated: the four verbs row level security
-- governs, and none of the four it does not - the SAME four section 2's loop
-- gives a table it has never heard of, deliberately, so that a table's
-- privileges do not depend on which side of this migration it was created on. A
-- new table therefore arrives
-- readable and writable by a signed-in session but IMPOSSIBLE to truncate, and
-- since step 44 every new table carries its own RLS and its own policy inline,
-- so "readable" still means "the rows a policy admits" - which for a table with
-- RLS and no policy is none.
--
-- Note the shape: a KEEP list, like everything above. PostgreSQL 19's ninth
-- privilege will be absent here without anybody editing this file.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- The second line, owned by supabase_admin. Attempted, never fatal.
do $do$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke all on tables from anon';
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke all on tables from authenticated';
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'grant select, insert, update, delete on tables to authenticated';
  raise notice 'step 56: the supabase_admin default-privilege line WAS changed.';
exception when insufficient_privilege then
  raise notice 'step 56: the supabase_admin default-privilege line was NOT changed (%). '
    'This session is not a member of supabase_admin, which is expected in the '
    'Supabase SQL editor. Tables created BY supabase_admin will still be born '
    'holding all eight privileges; no migration in this directory creates '
    'tables that way. Everything else in step 56 has applied.', sqlerrm;
end
$do$;

-- step 51 put a note on app_users saying authenticated "may only SELECT" here.
-- That was true of the four DML verbs and false of MAINTAIN, which its revoke
-- list could not have named. Restated now that it is true.
comment on table public.app_users is
  'CRM logins. Since step 56 the authenticated role holds exactly SELECT here and anon holds nothing: a session reads its own row to sign in, and every write goes through api/admin/users.js on the service role. Step 51 removed insert/update/delete/truncate/trigger/references by enumeration and left MAINTAIN behind; step 56 revoked everything and granted SELECT back, which is the shape that cannot go stale.';

-- ---------------------------------------------------------------------------
-- 6. What this leaves. Fails loudly rather than reporting success it did not
--    achieve, which is the half step 51 had no way to check.
--
-- Read from pg_class with aclexplode rather than from
-- information_schema.role_table_grants: that view shows only privileges where
-- the grantor or grantee is a CURRENTLY ENABLED role, so what it reports depends
-- on who is running the migration. A check whose answer depends on the session
-- is not a check.
-- ---------------------------------------------------------------------------
do $do$
declare
  bad text;
begin
  -- Nothing beyond the four DML verbs, for either browser role, anywhere.
  select string_agg(format('%s:%s:%s', r.rolname, c.relname, a.privilege_type), ', ')
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'f')
    and r.rolname in ('anon', 'authenticated')
    and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if bad is not null then
    raise exception 'step 56 left a privilege row level security cannot govern: %', bad;
  end if;

  -- anon holds no table privilege at all. grantee 0 is the PUBLIC pseudo-role.
  select string_agg(format('%s:%s:%s',
           coalesce(r.rolname, 'PUBLIC'), c.relname, a.privilege_type), ', ')
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'f')
    and (r.rolname = 'anon' or a.grantee = 0);
  if bad is not null then
    raise exception 'step 56 left anon or PUBLIC holding: %', bad;
  end if;

  -- And the sign-in door is still open, which is the thing worth failing over.
  if not has_function_privilege('anon', 'public.login_email_for_username(text)', 'execute') then
    raise exception 'step 56 revoked the username sign-in function from anon; every CAM is locked out';
  end if;
end
$do$;
