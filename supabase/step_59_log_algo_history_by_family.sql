-- Step 59: the log history becomes a desk aggregate for a CAM, and a table only
-- a Manager reads.
--
-- WHY 59. 54 is claimed by draft PR 65, and 55 to 58 are merged (58 is the
-- close summaries scope). The run order is 56, 57, 58, 59, 60. Step 60 is the
-- other residual of step 52 and is independent of this file, and so is 58.
--
-- WHAT WAS WRONG, MEASURED. public.log_algo_history (step 27) holds one row per
-- account, per day, per algorithm family: the realized P&L the NinjaTrader log
-- import derived for that account. Step 43 gave it `authenticated full access`,
-- `for all using (true) with check (true)`, and steps 52 and 56 never changed
-- that: 52 narrows tables that carry a client_id, and this one carries an
-- account name instead. Exercised as the role on the migration cluster, with
-- every step through 57 applied and request.jwt.claim.sub set to a CAM that has
-- one client and is NOT assigned the other:
--
--   select account_name, family, realized_pnl   -> every row of every book,
--     APEX-B1-01  OGX  -1234.56                    including the other CAM's
--   update ... set realized_pnl = 99999          -> SUCCEEDED
--   insert ... on conflict do update             -> SUCCEEDED (the browser's
--                                                   own upsert shape)
--   the same select from a signed-in session with no app_users row at all
--                                                -> every row
--
-- The rows tie to a client: the import itself matches lower(account_name)
-- against trading_accounts.account_name to find the owner, so the same join
-- names the client for anyone who knows it. A CAM's own join comes back empty
-- for another book only because trading_accounts is narrowed; the P&L is not.
--
-- So a CAM read every other book's per account, per family results, and could
-- rewrite them: the card is labelled team-wide, so a falsified row moves the
-- figure every CAM and the Manager read.
--
-- SCOPE IT BY CLIENT, OR AGGREGATE IT. Aggregate, for three reasons:
--
--   * The one reader never shows a row. StackPlaybook's "Algo history (from
--     logs)" card runs aggregateLogFamilyHistory over the rows and renders one
--     line per family: total, Long, Short, accounts, days, round trips. The
--     browser downloaded every account's day to print seven numbers per family.
--     The Team Algo Performance panel and src/domain/algorithmTemperature.js do
--     not read this table at all; they read the closes, which step 52 already
--     scopes.
--   * Scoping by client empties the card's purpose. Step 27 kept this table
--     "independent of any client, so accounts that no longer exist still
--     contribute". An account no client holds can be scoped to nobody, so a
--     per client policy would hide every dead account from every CAM, and what
--     was left would be the CAM's own book, which the closes already show.
--   * The writer is already a Manager. The log import lives in Data Tools,
--     inside ManagerOverview, which renders only for a Manager session.
--
-- WHAT A CAM GETS INSTEAD. log_algo_history_by_family(), SECURITY DEFINER,
-- no parameters, one row per family. It applies step 57's rule for a desk
-- aggregate, so the desk has one rule and not two:
--
--   * A family is SHOWN to a CAM only when the accounts that ran it OUTSIDE
--     her book reach algorithm_live_settings.min_cohort_accounts AND come from
--     at least min_cohort_clients clients. Below that the family is listed as
--     withheld with every number NULL, counts included, because a count below
--     the floor is itself a reading about other books.
--   * "Her book" is step 57's set: assigned to her now, created by her
--     (clients_i_created), or enrolled with a code she issued
--     (ingest_enrollments.created_by).
--   * The figures shown are the whole desk's, her own accounts included. That
--     is the number the Manager sees, so the card means the same thing on both
--     screens.
--
-- WHO OWNS A ROW IS DECIDED WHEN IT IS WRITTEN, AND NEVER BY THE CALLER.
-- The first draft of this file decided it when the card was READ, matching
-- lower(account_name) against the trading_accounts of that moment, and counted
-- an account nobody held as its own owner. Step 52 lets a CAM rename and delete
-- the trading accounts of her own clients, and the browser offers both (the
-- account registry, deleteSupabaseTradingAccount). Measured on the migration
-- cluster as the role: a family of four of her accounts and ONE of another
-- CAM's was withheld; she renamed her four, they turned into four accounts
-- nobody holds, the floor was met, and the desk total minus her own figure
-- (which the log import writes into her client's activity) was the other
-- CAM's account to the cent. Deleting them did the same.
--
-- So each row now carries attributed_client_id, set by a trigger when the row
-- is inserted: the one client whose trading account had that name AT THAT
-- MOMENT, or NULL when no client or more than one did. The caller's payload
-- never sets it, an update never changes it once set (it only fills a NULL, the
-- same lookup a fresh insert makes), and only a Manager writes the table at
-- all. What a CAM does to her registry afterwards moves nothing.
--
-- The floor then counts only rows attributed to a client that still exists and
-- is outside her book:
--
--   * An account no client held when it was imported, or that two clients
--     held, is in the desk total and NEVER in the floor. It cannot be told
--     apart from one of her own accounts renamed or deleted before the import,
--     which is exactly what she would do to pad the floor. Dead accounts still
--     add to every figure; they just cannot be what lets a figure be shown.
--   * A client that no longer exists is not outside anyone's book. Nobody
--     signed in can delete a client, but the desk can, and the accounts of a
--     deleted client are still the ones its CAM knew.
--   * Renaming or deleting her accounts can only move rows OUT of the floor,
--     never into it, and the only rows she can attribute to anyone are rows
--     attributed to clients in her book.
--
-- The column is not called client_id on purpose: step 52 narrows every table
-- with a client_id column by a permissive "cam sees its own clients" policy,
-- and dropping every other permissive policy first, so a re-run of 52 would
-- replace the Manager policy below and hand each CAM read and write on her own
-- clients' rows. The test beside this file re-runs 52 on top.
--
-- The backfill below attributes the rows that exist when this runs by the
-- trading accounts of that moment. That is the one time the registry as a CAM
-- left it decides an attribution after the fact; a CAM who had renamed her
-- accounts before this file ran would get them counted as dead, which only
-- withholds more.
--
-- A Manager reads every row as before and gets every family from the function.
-- The figures are the ones aggregateLogFamilyHistory computes in the browser,
-- rounded to the cent; the test beside this file holds the two to the same
-- output on the same rows.
--
-- RESIDUAL RISK, stated rather than hidden. The figures are cumulative. A CAM
-- who reads the card before and after one upload, where the upload added a
-- single outside account's day for a family, reads that account-day's P&L as the
-- difference, without its name. Closing that needs noise or a time window, not
-- a policy, and it is the same shape as the one step 57 states for consecutive
-- cycles.
--
-- RESIDUAL RISK, the book changing hands. Her book is read when the card is
-- read, and only a Manager can take a client out of it since step 60. A client
-- that was only ASSIGNED to her (not created by her, not enrolled with her
-- code) and that a Manager moves to another CAM leaves her book, and its rows
-- then count as outside accounts whose history she knew. Clearing created_by
-- on a client she holds (step 53's update policy allows it) does the same to a
-- client she created, once a Manager moves it. Both need a Manager to act, and
-- step 57's desk median carries the same one.
--
-- A REPLACEMENT HOLDS HERE, unlike step 60's table. Nothing in this directory
-- writes a permissive policy on log_algo_history again: step 43 only touches a
-- table whose row level security is off, and step 52 only tables that carry a
-- client_id. So the old policy is dropped and one Manager policy takes its
-- place, and the test beside this file re-runs 43, 52 and 56 on top to prove
-- the table stays closed.
--
-- WHAT THIS DOES NOT CHANGE. The grants step 56 measured stay as they are
-- (select, insert, update): a Manager's import upserts through PostgREST and
-- needs all three, and the policy below is what decides who may use them. The
-- service role is BYPASSRLS and untouched, and its writes go through the same
-- trigger. No row is deleted; the one write is the backfill of the new column.
--
-- Idempotent: the policies are dropped by catalogue and recreated, the column
-- is added if missing, the backfill fills only NULLs (the lookup a fresh
-- import makes), the functions are create or replace, the trigger is dropped
-- and recreated, and the comments are replaced.

begin;

do $step59_guard$
begin
  if to_regprocedure('public.is_manager()') is null
    or to_regprocedure('public.assigned_client_ids()') is null
    or to_regprocedure('public.clients_i_created()') is null then
    raise exception 'step 59 needs step 52 (is_manager) and step 53 (clients_i_created): run them first';
  end if;
  if to_regclass('public.algorithm_live_settings') is null
    or to_regclass('public.ingest_enrollments') is null then
    raise exception 'step 59 needs step 57 (algorithm_live_settings) and step 28 (ingest_enrollments): run them first';
  end if;
  if to_regclass('public.log_algo_history') is null then
    raise exception 'step 59 needs step 27 (log_algo_history): run it first';
  end if;
end
$step59_guard$;

-- ---------------------------------------------------------------------------
-- The rows: a Manager reads and writes them, nobody else does.
--
-- Every PERMISSIVE policy is dropped by catalogue rather than by name, step
-- 52's rule: permissive policies are OR'd, so a leftover `using (true)` beside
-- the new one would grant everything again while the new one looked installed.
-- ---------------------------------------------------------------------------
do $step59_policies$
declare
  dead record;
begin
  for dead in
    select policyname from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'log_algo_history' and permissive = 'PERMISSIVE'
  loop
    execute format('drop policy %I on public.log_algo_history', dead.policyname);
  end loop;
end
$step59_policies$;

create policy "managers read and write the log history" on public.log_algo_history
  for all to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

comment on table public.log_algo_history is
  'Per account, per day, per algorithm family realized P&L from the NinjaTrader log import (step 27). Rows are read and written by a Manager only (step 59). A CAM reads the desk aggregate through log_algo_history_by_family(), which withholds a family whose accounts outside her book, by the client each row was attributed to when it was written, are under the algorithm_live_settings floors.';

-- ---------------------------------------------------------------------------
-- Who owns a row, fixed when it is written.
-- ---------------------------------------------------------------------------
alter table public.log_algo_history add column if not exists attributed_client_id uuid;

comment on column public.log_algo_history.attributed_client_id is
  'The one client whose trading account carried this account name when the row was imported, or NULL when no client or more than one did (step 59). Set by the log_algo_history_attribute trigger; a payload never sets it and an update never changes it once set. Not a foreign key, so deleting a client leaves the id, which then counts for nobody. Not named client_id, so step 52 does not narrow this table by it.';

-- The import's own match, lower(account_name), answered only when it is
-- unambiguous. Definer so the answer does not depend on which clients the
-- writer can see; nobody but the trigger calls it.
create or replace function public.log_algo_history_owner_of(p_account text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select case when count(distinct t.client_id) = 1 then (array_agg(t.client_id))[1] end
  from public.trading_accounts as t
  where nullif(p_account, '') is not null
    and lower(t.account_name) = lower(p_account);
$function$;

revoke all on function public.log_algo_history_owner_of(text) from public, anon, authenticated;

-- The rows already there, by the registry of this moment. Only NULLs, so a
-- re-run never moves an attribution already made.
update public.log_algo_history as h
   set attributed_client_id = public.log_algo_history_owner_of(h.account_name)
 where h.attributed_client_id is null
   and public.log_algo_history_owner_of(h.account_name) is not null;

create or replace function public.log_algo_history_attribute()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    new.attributed_client_id := public.log_algo_history_owner_of(new.account_name);
  elsif old.attributed_client_id is not null
    and lower(coalesce(new.account_name, '')) = lower(coalesce(old.account_name, '')) then
    new.attributed_client_id := old.attributed_client_id;
  else
    -- Still unattributed, or the row now names another account: the same
    -- lookup an insert makes, never the payload's value.
    new.attributed_client_id := public.log_algo_history_owner_of(new.account_name);
  end if;
  return new;
end;
$function$;

revoke all on function public.log_algo_history_attribute() from public, anon, authenticated;

drop trigger if exists log_algo_history_attribute on public.log_algo_history;
create trigger log_algo_history_attribute
  before insert or update on public.log_algo_history
  for each row execute function public.log_algo_history_attribute();

-- ---------------------------------------------------------------------------
-- log_algo_history_by_family: the card's seven numbers per family.
--
-- One row per family. status 'shown' carries the figures; status 'withheld'
-- carries the family name and NULL everywhere else.
-- ---------------------------------------------------------------------------
create or replace function public.log_algo_history_by_family()
returns table (
  family text,
  status text,
  total_pnl numeric,
  long_pnl numeric,
  short_pnl numeric,
  mixed_pnl numeric,
  round_trips bigint,
  accounts integer,
  days integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  v_manager boolean;
  v_mine uuid[];
  v_min_accounts integer := 5;
  v_min_owners integer := 3;
  v_settings record;
begin
  if auth.uid() is null then
    return;
  end if;

  v_manager := coalesce((select public.is_manager()), false);

  -- A signed-in session with no active CRM user behind it reads nothing, as it
  -- reads no row of any table under step 52.
  if not v_manager and not exists (
    select 1 from public.app_users as app_user
    where app_user.auth_user_id = auth.uid()
      and coalesce(app_user.status, 'Active') <> 'Inactive'
  ) then
    return;
  end if;

  if v_manager then
    v_mine := array[]::uuid[];
  else
    -- Step 57's set, word for word: every client the caller can influence.
    v_mine := array(
      select public.assigned_client_ids()
      union
      select public.clients_i_created()
      union
      select enrollment.client_id
      from public.ingest_enrollments as enrollment
      join public.app_users as app_user on app_user.id = enrollment.created_by
      where app_user.auth_user_id = auth.uid()
    );
  end if;

  -- The desk's one floor for an aggregate a CAM may read. Absent row, the
  -- defaults step 57 falls back to.
  select settings.min_cohort_accounts, settings.min_cohort_clients into v_settings
  from public.algorithm_live_settings as settings
  where settings.id;
  if found then
    v_min_accounts := v_settings.min_cohort_accounts;
    v_min_owners := v_settings.min_cohort_clients;
  end if;

  return query
  with history as (
    -- The browser's own reading of a row (logAlgoHistoryFromRow and
    -- aggregateLogFamilyHistory): an empty family is 'Unknown', an empty
    -- direction is 'Mixed', a missing P&L or round trip count is 0, a direction
    -- outside the three moves the total and no column, and an empty account
    -- name or date is not counted.
    select coalesce(nullif(h.family, ''), 'Unknown') as fam,
           coalesce(nullif(h.direction, ''), 'Mixed') as dir,
           coalesce(h.realized_pnl, 0) as pnl,
           coalesce(h.round_trips, 0) as trips,
           h.log_date as day,
           nullif(h.account_name, '') as account,
           h.attributed_client_id as owner
    from public.log_algo_history as h
  ),
  outside as (
    -- The accounts that ran each family on a client outside the caller's
    -- book, by the owner fixed when each row was written. A row nobody owned
    -- then, or whose client is gone, is not here: it is in the totals only.
    select distinct history.fam,
           lower(history.account) as account_key,
           history.owner
    from history
    join public.clients as client on client.id = history.owner
    where history.account is not null
      and not (history.owner = any (v_mine))
  ),
  floor_check as (
    select outside.fam,
           count(distinct outside.account_key) >= v_min_accounts
             and count(distinct outside.owner) >= v_min_owners as passes
    from outside
    group by outside.fam
  ),
  totals as (
    select history.fam,
           round(sum(history.pnl), 2) as total,
           round(coalesce(sum(history.pnl) filter (where history.dir = 'Long'), 0), 2) as long_total,
           round(coalesce(sum(history.pnl) filter (where history.dir = 'Short'), 0), 2) as short_total,
           round(coalesce(sum(history.pnl) filter (where history.dir = 'Mixed'), 0), 2) as mixed_total,
           sum(history.trips)::bigint as trips,
           count(distinct history.account)::integer as n_accounts,
           count(distinct history.day)::integer as n_days
    from history
    group by history.fam
  )
  select totals.fam,
         case when ok.shown then 'shown' else 'withheld' end,
         case when ok.shown then totals.total end,
         case when ok.shown then totals.long_total end,
         case when ok.shown then totals.short_total end,
         case when ok.shown then totals.mixed_total end,
         case when ok.shown then totals.trips end,
         case when ok.shown then totals.n_accounts end,
         case when ok.shown then totals.n_days end
  from totals
  left join floor_check on floor_check.fam = totals.fam
  cross join lateral (
    select v_manager or coalesce(floor_check.passes, false) as shown
  ) as ok
  order by ok.shown desc, totals.total desc nulls last, totals.fam;
end;
$function$;

comment on function public.log_algo_history_by_family() is
  'The NinjaTrader log history per algorithm family, as the Stack Playbook card shows it (step 59). A Manager gets every family. A CAM gets a family''s desk figures only when the accounts that ran it on clients outside her book, by attributed_client_id, meet the algorithm_live_settings floors; otherwise the family is withheld with every number NULL. Accounts no client held at import add to the figures and never to the floor.';

revoke all on function public.log_algo_history_by_family() from public, anon, authenticated;
grant execute on function public.log_algo_history_by_family() to authenticated;

-- The floors now govern two desk aggregates. Whoever edits them in the SQL
-- editor should know both move.
comment on table public.algorithm_live_settings is
  'Singleton tunables for the live per algorithm comparison (step 57). Edit in the SQL editor, for example: update public.algorithm_live_settings set min_cohort_accounts = 6, updated_at = now() where id; The CHECK constraints are the review. The floors count accounts and clients OUTSIDE the viewing CAM''s own book. min_cohort_accounts and min_cohort_clients also decide which families log_algo_history_by_family() shows a CAM (step 59). The cycle length is account_tracker_settings.sample_interval_seconds, not a column here.';

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 58 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 59 left % table(s) without row level security', n;
  end if;
end $$;
