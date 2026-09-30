-- Step 52: the database learns which clients a CAM may see.
--
-- WHAT IS WRONG.
--
-- step 43 enabled row level security on every table and then gave 30 of them
-- the same policy: `for all to authenticated using (true) with check (true)`.
-- RLS is on and passes everybody. Any of the 10 logins reads and writes the
-- whole book: every client of every CAM, their accounts, their closes, their
-- credentials.
--
-- The split the desk believes in is real, but it lives in the browser.
-- src/domain/supabaseStore.js adds `.in('id', scope)` to its queries, which is
-- a filter the caller chooses rather than a rule the caller obeys. The same
-- session sending the same request without that clause receives all 144
-- clients, and PostgREST is reachable directly with the publishable key.
--
-- This step moves the rule into the database, where omitting it is not one of
-- the caller's options.
--
-- WHO SEES WHAT.
--
--   Manager  every client.                       app_users.role = 'Manager'
--   CAM      the clients assigned to its profile, through client_assignments.
--
-- Those are the only two roles app_users has held. A row with neither resolves
-- to nothing rather than to everything: an unrecognised role is a
-- misconfiguration, and the safe reading of a misconfiguration is no access.
--
-- TWO FUNCTIONS, NOT ONE, and this is the part that bit the first draft.
--
-- The obvious shape is one function returning "the client ids this session may
-- see", with a Manager getting `select id from clients`. That breaks INSERT on
-- clients: `with check` runs against a row that is not in the table yet, a
-- `stable` function reads the statement's snapshot, so the new id is not in its
-- own result and a Manager cannot create a client. Asking `is_manager()`
-- separately never consults the table being written, so it survives the insert
-- and skips a 144-row scan on every Manager query as well.
--
-- THREE SHAPES OF TABLE, because they reach a client three different ways.
--
--   A. A `client_id` column. Enumerated from the catalogue by the loop below
--      rather than listed here, so a table added later is covered by re-running
--      this migration instead of by somebody remembering.
--   B. A `daily_import_id`, one join from the client: account_snapshots,
--      strategy_snapshots, orders, executions. These are the big ones, 64,791
--      orders and 31,525 executions, so the shape of the expression is not
--      cosmetic.
--   C. Desk reference that belongs to no client: cam_profiles, the SOP tables,
--      algorithm_benchmarks, strategy_templates, app_users. Those keep the open
--      policy deliberately. A CAM reading the desk's own playbook is not a
--      leak, and app_users is already held shut by the grant step 51 removed.
--
-- WHY `(select f())` AND NEVER `f()`.
--
-- Wrapped in a scalar sub-select, Postgres evaluates the function once per
-- query as an InitPlan instead of once per row. On orders that is one lookup
-- against 64,791. Both functions are `stable` so the planner is allowed to do
-- it. Without the wrapper the orders table becomes unusable, so this is a
-- correctness requirement wearing a performance costume.
--
-- WHY EVERY PERMISSIVE POLICY GETS DROPPED FIRST.
--
-- Permissive policies are OR'd. A leftover `using (true)` sitting beside the
-- new one grants everything again and the new policy looks installed while
-- doing nothing. So the loops below drop every PERMISSIVE policy on each table
-- they touch, by catalogue rather than by name. RESTRICTIVE policies are left
-- alone: the six `using (false)` denials on the ingest tables are AND'd, and
-- they are there on purpose.
--
-- WHAT THIS DOES NOT CHANGE.
--
-- The service role is BYPASSRLS, so every API route and every ingest endpoint
-- behaves exactly as it does today. This reaches the browser's own path, which
-- is the path that had no rule at all.
--
-- SUPERSEDED IN PART BY STEP 53. The `clients` select and update policies and
-- the `client_assignments` policy below are replaced there, each gaining a
-- third arm for the client a CAM has just created. This file left a CAM unable
-- to create a client at all: the browser's insert ends in RETURNING, RETURNING
-- applies the SELECT policy, and a brand new client is assigned to nobody. The
-- rest of this file stands.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Is this session a Manager?
--
-- `security definer` because it reads app_users, and the caller is the role
-- being restricted. search_path is pinned: a definer function without one is
-- how a definer function becomes the way in.
-- ---------------------------------------------------------------------------
create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.app_users u
    where u.auth_user_id = auth.uid()
      and u.role = 'Manager'
      and coalesce(u.status, 'Active') <> 'Inactive'
  );
$function$;

-- ---------------------------------------------------------------------------
-- The clients assigned to this session's CAM profile.
--
-- CAM assignments only. A Manager's "everything" is answered by is_manager()
-- above, not by enumerating clients here.
-- ---------------------------------------------------------------------------
create or replace function public.assigned_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select a.client_id
  from public.client_assignments a
  join public.app_users u on u.cam_profile_id = a.cam_profile_id
  where u.auth_user_id = auth.uid()
    and coalesce(u.status, 'Active') <> 'Inactive';
$function$;

comment on function public.is_manager() is
  'True when the calling session is an active Manager. Read by the step 52 policies. Call it as (select public.is_manager()) inside a policy so it runs once per query rather than once per row.';
comment on function public.assigned_client_ids() is
  'The client ids assigned to the calling session CAM profile, empty for anyone else. Read by the step 52 policies. Call it as (select public.assigned_client_ids()) so it runs once per query.';

revoke all on function public.is_manager() from public;
revoke all on function public.assigned_client_ids() from public;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.assigned_client_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- A. Every table that names a client directly.
-- ---------------------------------------------------------------------------
do $do$
declare
  target record;
  dead record;
  predicate constant text :=
    '((select public.is_manager()) or client_id in (select public.assigned_client_ids()))';
begin
  for target in
    select c.table_name as name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'client_id'
      and t.table_type = 'BASE TABLE'
      -- The ingest tables are already shut to the browser by their own
      -- restrictive denials. Narrowing them further would be noise.
      and c.table_name not like 'ingest%'
    order by c.table_name
  loop
    for dead in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = target.name and permissive = 'PERMISSIVE'
    loop
      execute format('drop policy %I on public.%I', dead.policyname, target.name);
    end loop;
    execute format(
      'create policy %I on public.%I for all to authenticated using %s with check %s',
      'cam sees its own clients', target.name, predicate, predicate);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------------
-- B. The four that reach a client through the close they belong to.
-- ---------------------------------------------------------------------------
do $do$
declare
  target text;
  dead record;
  predicate constant text := '((select public.is_manager()) or exists ('
    || 'select 1 from public.daily_imports d where d.id = daily_import_id '
    || 'and d.client_id in (select public.assigned_client_ids())))';
begin
  foreach target in array array['account_snapshots', 'strategy_snapshots', 'orders', 'executions']
  loop
    for dead in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = target and permissive = 'PERMISSIVE'
    loop
      execute format('drop policy %I on public.%I', dead.policyname, target);
    end loop;
    execute format(
      'create policy %I on public.%I for all to authenticated using %s with check %s',
      'cam sees its own closes', target, predicate, predicate);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------------
-- C. clients itself, which names its id rather than a client_id.
--
-- Split, because reading and creating are not the same question. A CAM may only
-- read the clients assigned to it, but the row being INSERTed has no assignment
-- yet and cannot be checked against one; the check would fail for a Manager
-- too, since the new id is not in the snapshot the predicate reads. Creating a
-- client is not a disclosure, and what the creator may then READ is still
-- governed by the policy above, so INSERT is left open and the other three
-- verbs carry the rule.
-- ---------------------------------------------------------------------------
do $do$
declare
  dead record;
begin
  for dead in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'clients' and permissive = 'PERMISSIVE'
  loop
    execute format('drop policy %I on public.clients', dead.policyname);
  end loop;
end
$do$;

create policy "cam sees its own clients" on public.clients
  for select to authenticated
  using ((select public.is_manager()) or id in (select public.assigned_client_ids()));

create policy "cam updates its own clients" on public.clients
  for update to authenticated
  using ((select public.is_manager()) or id in (select public.assigned_client_ids()))
  with check ((select public.is_manager()) or id in (select public.assigned_client_ids()));

create policy "cam deletes its own clients" on public.clients
  for delete to authenticated
  using ((select public.is_manager()) or id in (select public.assigned_client_ids()));

create policy "anyone signed in may create a client" on public.clients
  for insert to authenticated
  with check (true);

-- ---------------------------------------------------------------------------
-- D. payout_events, which reaches a client through the account it paid.
-- ---------------------------------------------------------------------------
do $do$
declare
  dead record;
  predicate constant text := '((select public.is_manager()) or exists ('
    || 'select 1 from public.trading_accounts a where a.id = trading_account_id '
    || 'and a.client_id in (select public.assigned_client_ids())))';
begin
  for dead in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'payout_events' and permissive = 'PERMISSIVE'
  loop
    execute format('drop policy %I on public.payout_events', dead.policyname);
  end loop;
  execute format(
    'create policy %I on public.payout_events for all to authenticated using %s with check %s',
    'cam sees its own payouts', predicate, predicate);
end
$do$;

-- The desk's reference tables keep the policy they have: cam_profiles, the SOP
-- tables, algorithm_benchmarks and strategy_templates describe how the desk
-- works rather than what a client did, and app_users is held by the grant
-- step 51 took away rather than by a policy.
