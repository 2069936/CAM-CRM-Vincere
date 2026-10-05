-- Step 56: the four privileges row level security cannot see.
--
-- WHY 54 AND 55 ARE SKIPPED. step_54 is claimed by draft PR 65 (Deep Export)
-- and step_55 by PR 67 (per-account live samples). Neither is merged. This file
-- takes 56 so that whichever of them lands first does not have to renumber, and
-- so that no two unmerged branches claim one number.
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
--   supabaseStore.js:2702 `.delete()` and :2742 `.insert()` - the manual-import
--   re-upload, gated by the deleteTables/insertTables sets at :2651-2652 to
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
-- AND IT COULD NOT SUCCEED IF IT DID FIRE. Every one of the 23 permissive
-- policies in schema public names `to authenticated`; not one omits its TO
-- clause, which would have defaulted to PUBLIC and quietly included anon. The
-- only policies naming anon are the restrictive `using (false)` denials on the
-- ingest tables. So an anon SELECT on app_users already returns zero rows, and
-- supabaseAuth.js:57 throws 'Unknown username or email.'
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
-- Closing the 33 tables that exist fixes today. It does not fix the next table:
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
--    src/App.jsx:14032 and :14051 load strategy_classifications and
--    log_algo_history from effects that have no `if (!session) return;` guard -
--    only `if (!isSupabaseConfigured) return;` - so they fire while the login
--    form is on screen, as anon. Today they get `200 []`: the grant allows the
--    read and no policy admits anon to a row. After this migration they get
--    42501 and the `.catch(console.error)` at :14037 and :14056 prints
--    `[CRM] Failed to load strategy classifications:`. No user-visible change;
--    both slices are repopulated by the keyed load after sign-in. The one-line
--    session guard in each effect is the right follow-up and is not a SQL
--    change.
--
-- 2. /database WILL GO RED. src/App.jsx:15791 renders DatabaseCheck BEFORE the
--    `if (!session)` gate at :15793, and vercel.json rewrites everything
--    non-/api/ to index.html, so the page is publicly reachable with no
--    session. loadSupabaseDiagnostics (supabaseStore.js:1681) probes 20 tables
--    and will report `permission denied for table ...` for each instead of a
--    count of 0. Errors are caught per table and rendered, never thrown, so
--    nothing crashes - the page reports "Needs attention". That page only ever
--    told the truth when signed in; now it tells it louder.
--
-- AND ONE DEAD POLICY, so nobody "fixes" it. clients is soft-deleted -
-- softDeleteSupabaseClient (supabaseStore.js:2334) is an UPDATE setting status
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
-- 2. authenticated. Revoke everything, then grant back exactly what the
--    browser is measured to use. Six groups, each with its reason.
-- ---------------------------------------------------------------------------
revoke all privileges on all tables in schema public from authenticated;

-- All four verbs: every one is exercised.
grant select, insert, update, delete on
  public.client_assignments,
  public.client_coverage,
  public.daily_imports,
  public.operational_flags,
  public.strategy_classifications,
  public.tasks,
  public.trading_accounts
to authenticated;

-- No UPDATE: these are appended to and removed from, never edited in place.
-- executions, orders and strategy_snapshots are the three that appear only
-- behind `.from(table)` at supabaseStore.js:2702/:2742.
grant select, insert, delete on
  public.activity_logs,
  public.client_prop_firms,
  public.executions,
  public.orders,
  public.price_checks,
  public.strategy_snapshots
to authenticated;

-- No DELETE: nothing in the browser deletes from these. account_snapshots
-- loses its DELETE safely because deleteSupabaseDailyImport removes only the
-- daily_imports row and the children go by ON DELETE CASCADE, which is a
-- referential action and is not privilege-checked. clients is soft-deleted.
grant select, insert, update on
  public.account_snapshots,
  public.algorithm_benchmarks,
  public.cam_profiles,
  public.cam_time_off,
  public.client_credentials,
  public.clients,
  public.daily_sop_checklists,
  public.log_algo_history,
  public.reports,
  public.sop_items,
  public.sop_sections
to authenticated;

-- Append-only. client_price_changes has no reader in this repository, and
-- SELECT is kept anyway: step_42 lines 125-127 says a management dashboard is
-- meant to read it and :148 already grants exactly these two. Its insert at
-- supabaseStore.js:2293 is deliberately fire-and-forget - `.then(() => {},
-- () => {})` - so a revoked INSERT here would fail SILENTLY and the revenue
-- movement figures would quietly go empty. That is the worst failure shape in
-- this migration: no error reaches anyone.
grant select, insert on
  public.audit_logs,
  public.client_price_changes,
  public.payout_events
to authenticated;

-- Read only.
--   app_users        every write goes through api/admin/users.js on the service
--                    role; this restates step 51's intent in a shape that
--                    cannot go stale, and drops the MAINTAIN it left behind.
--   close_summaries  written by replace_close_summaries, which is SECURITY
--                    DEFINER (step_48:147-204) and so runs as its owner.
--                    Revoking the DML here does not break that write.
--   sop_templates    seeded by migration; the browser only reads it. Note that
--                    sop_sections and sop_items ARE written, above: "the SOP
--                    tables are desk reference" would break the SOP editor.
--   strategy_templates  the one judgement call in this file. No browser caller
--                    names it, so "grant nothing" is defensible. SELECT is
--                    granted because step_52:49 and :264 deliberately left it
--                    the open policy, calling it desk reference a CAM may
--                    legitimately read; revoking the grant would contradict a
--                    decision taken on purpose one migration ago while adding
--                    no safety, since a read is governed by that policy and
--                    cannot destroy anything. If the desk decides a CAM has no
--                    business reading the set-file catalogue, remove it here
--                    and say so in step 52 as well.
grant select on
  public.app_users,
  public.close_summaries,
  public.sop_templates,
  public.strategy_templates
to authenticated;

-- AND TWO TABLES GET NOTHING BACK: ingest_admission_settings and
-- ingest_quarantine_reports. Both carry a restrictive `deny browser direct
-- access` policy (step_45:490, step_46:266) and no permissive policy at all, so
-- authenticated already reads no row of either. They held all eight anyway,
-- because they were created after step 43 and born with them - which is the
-- clearest illustration in this database of why the default privileges below
-- matter. The four tables step_28 already closed - ingest_batches,
-- ingest_devices, ingest_enrollments, ingest_pair_rate_limits - are left alone.

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
-- 5. Default privileges, so table 38 is not born with the hole.
--
-- anon: nothing, ever. authenticated: the four verbs row level security
-- governs, and none of the four it does not. A new table therefore arrives
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
