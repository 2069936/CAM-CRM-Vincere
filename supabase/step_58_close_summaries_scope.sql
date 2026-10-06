-- Step 58: replace_close_summaries learns whose closes the caller may touch.
--
-- WHY 58. 54 is still claimed by draft PR 65 (the deep export requests), and
-- 55, 56 and 57 are merged. The run order is 56, 57, 58. The gap at 54 is
-- deliberate and nobody should close it.
--
-- WHAT IS WRONG.
--
-- Step 48 created `replace_close_summaries(uuid[], jsonb)` as SECURITY DEFINER
-- and granted it to `authenticated`. Its body deletes every close_summaries row
-- whose daily_import_id the caller names and inserts whatever rows the caller
-- sends: client, date, segment, daily_pnl, weekly_pnl, balance. It asked
-- nothing about who the caller was. That was harmless while step 43's
-- `using (true)` let every login write every row anyway.
--
-- Step 52 changed that. A CAM now sees and writes only the clients assigned to
-- it, and step 56 then took INSERT, UPDATE and DELETE on close_summaries away
-- from `authenticated` altogether, because this function was the one writer.
-- But a definer function runs as its owner and the owner is not subject to row
-- level security, so the one writer was the one hole. Measured on the migration
-- cluster with every step applied, signed in as a CAM with one client:
--
--   select count(*) from close_summaries     -> 0 of the other CAM's rows
--   select replace_close_summaries(
--     array['<the other CAM''s close>'],
--     '[{"segment":"Cash","daily_pnl":-99999,...}]')   -> 1
--
-- and the other CAM's Cash row for that day read -99,999.00 afterwards. A
-- CAM who cannot read a row could replace it, through the publishable key and
-- PostgREST's /rpc, with any figure, or empty a client's whole history by
-- naming its closes with no rows. That is the Manager's first screen.
--
-- WHAT THIS DOES.
--
-- Recreates the function with one check in front of the delete. The rest of
-- the body is step 48's, unchanged: the same delete, the same insert, the same
-- filter to the closes named.
--
--   Unscoped   a role row level security does not govern: the service role
--              (BYPASSRLS), which is how the ingest endpoints and
--              scripts/backfill_close_summaries.mjs call it, and a superuser.
--              Either could write the table directly, so refusing them here
--              would protect nothing.
--   Manager    every client, as everywhere since step 52 (`is_manager()`).
--   Anyone     every close named must belong to a client in
--   else       `assigned_client_ids()`, and every row that will be written
--              must carry the client_id of the close it names. Otherwise the
--              whole call is refused with 42501 and nothing is deleted.
--
-- That is the policy step 52 put on close_summaries itself, so the function now
-- does for a CAM exactly what the table would let that CAM do if it still held
-- the grant, and nothing more.
--
-- WHAT THE BROWSER SENDS, which is what this must keep working. Two callers in
-- src/domain/supabaseStore.js, both through replaceSupabaseCloseSummaries:
--
--   * an upload: the adapter's replaceCloseSummaries sends ONE close id, the
--     close just written, and rows from closeSummaryToDb whose client_id is the
--     client the upload is for (dailyImportPersistence.js writeCloseSummaries);
--   * a reclassification: rebuildSupabaseCloseSummariesForClient sends EVERY
--     close of one client, as the session can read them, with that client's id
--     on every row.
--
-- Both name only closes of a client the session can already see, and both put
-- the close's own client on every row, so neither can be refused by this check.
-- The test beside this file builds both payloads with the same closeSummaryToDb
-- and proves it.
--
-- HOW IT KNOWS WHO IS CALLING. Inside a security definer function current_user
-- is the owner, so it cannot say. The `role` setting can: PostgREST sets it for
-- each request to the role the JWT names, and entering a definer function does
-- not change it. A request cannot forge it because PostgREST gives a request no
-- way to run SET ROLE or set_config: it sets the role itself, from the JWT, and
-- exposes only the functions in the API schemas. Role membership is NOT the
-- guard. SET ROLE checks the session user, and on Supabase that is
-- authenticator, which is a member of service_role. So no function reachable
-- through /rpc may ever pass a name the caller controls to set_config('role')
-- or to SET ROLE: that function would let a CAM call this one as service_role.
-- 'none' means nobody switched role, a direct login, and then the login itself
-- is the caller and is judged by its own attributes. A caller who matches
-- nothing is scoped, never trusted.
--
-- WHY NOT `clients_i_created()`. Step 53 gave a CAM sight of a client it has
-- just created and nobody has been assigned yet. That arm is on `clients` and
-- `client_assignments` only. daily_imports and close_summaries carry step 52's
-- two arms, so a CAM cannot write a close for such a client in the first place,
-- and this function follows the table it writes. clients_i_created() on its own
-- would also be wider than step 53's arm: it has no "not yet assigned" gate, so
-- a CAM would keep write access to a client after it was transferred away.
--
-- WHY THE REFUSAL DOES NOT SAY "does not exist". replaceSupabaseCloseSummaries
-- swallows an error that names replace_close_summaries and says "does not
-- exist", "schema cache" or "could not find", because that is how PostgREST
-- reports step 48 not having run. A refusal worded that way would be dropped in
-- silence and the upload would look saved. So it says "refused". A close id that
-- is not in the table is refused with the same words as somebody else's, so the
-- answer does not tell a CAM whether another client's close id is real.
--
-- WHAT IT DOES NOT CHANGE. The grants (authenticated and service_role, never
-- anon) are restated, not changed. The service role path is untouched, and
-- server/apiLib/autoImportStore.js could not see a refusal anyway: it swallows
-- every error that mentions close_summaries. No table, policy or row changes.
-- Nothing needs deploying: it is safe to run at any time.
--
-- AND STEP 48 NOW CARRIES THE SAME BODY. Pedro re-runs a file he is not sure
-- landed, and step 48's `create or replace` would put the unscoped body back
-- in silence. So step_48_close_summaries.sql holds this exact function, and the
-- test beside this file fails if the two copies ever differ.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 0. Refuse to run out of order, before anything is changed.
--
-- The function needs step 48 (its table, and itself: replacing a function that
-- exists keeps its grants, creating one hands out whatever the default
-- privileges say) and step 52 (the two helpers the check calls).
-- ---------------------------------------------------------------------------
do $do$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing from (
    select unnest(array[
      'replace_close_summaries(uuid[], jsonb)', 'is_manager()', 'assigned_client_ids()'
    ]) as name) f
  where to_regprocedure('public.' || f.name) is null;
  if missing is null and to_regclass('public.close_summaries') is null then
    missing := 'close_summaries';
  end if;
  if missing is not null then
    raise exception
      'step 58 needs step 48 (replace_close_summaries) and step 52 (is_manager, assigned_client_ids) first: public.% not found. Nothing has been changed.',
      missing;
  end if;
end
$do$;

begin;

create or replace function public.replace_close_summaries(
  p_daily_import_ids uuid[],
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_written integer := 0;
  v_caller text;
  v_unscoped boolean;
  v_mine uuid[];
  v_refused integer;
begin
  if p_daily_import_ids is null or array_length(p_daily_import_ids, 1) is null then
    return 0;
  end if;

  -- WHO IS CALLING (step 58). current_user is this function's owner in here.
  -- The `role` setting is the role PostgREST set for the request, and a
  -- definer call does not change it; 'none' is a direct login.
  v_caller := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);

  -- A role row level security does not govern could write the table directly,
  -- so narrowing it here would protect nothing: the service role, which is how
  -- the ingest endpoints and the backfill call this, and a superuser.
  select r.rolsuper or r.rolbypassrls
    into v_unscoped
    from pg_catalog.pg_roles r
   where r.rolname = v_caller;

  -- Everyone else gets step 52's rule for close_summaries: a Manager every
  -- client, a CAM the clients assigned to it. Checked before the delete, and the
  -- whole call is refused rather than the part that is out of scope.
  if not coalesce(v_unscoped, false) and not public.is_manager() then
    v_mine := array(select public.assigned_client_ids());

    -- Every close named. One that does not exist is refused in the same words
    -- as one that belongs to somebody else.
    select count(*)
      into v_refused
      from unnest(p_daily_import_ids) as named(id)
      left join public.daily_imports d on d.id = named.id
     where d.client_id is null
        or not (d.client_id = any (v_mine));
    if v_refused > 0 then
      raise exception using
        errcode = '42501',
        message = format(
          'replace_close_summaries refused: %s of the %s closes named are not on a client assigned to you. Nothing was replaced.',
          v_refused, array_length(p_daily_import_ids, 1));
    end if;

    -- Every row that will be written carries its own close's client, so a close
    -- in scope cannot be used to file money under a client that is not.
    if jsonb_typeof(p_rows) = 'array' then
      select count(*)
        into v_refused
        from jsonb_array_elements(p_rows) as row_value
        join public.daily_imports d on d.id = (row_value ->> 'daily_import_id')::uuid
       where d.id = any (p_daily_import_ids)
         and (row_value ->> 'client_id')::uuid is distinct from d.client_id;
      if v_refused > 0 then
        raise exception using
          errcode = '42501',
          message = format(
            'replace_close_summaries refused: %s row(s) name a client other than the one their close belongs to. Nothing was replaced.',
            v_refused);
      end if;
    end if;
  end if;

  delete from public.close_summaries
   where daily_import_id = any (p_daily_import_ids);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  insert into public.close_summaries (
    daily_import_id, client_id, trading_date, segment, accounts,
    daily_pnl, weekly_pnl, balance, counted_in_total, account_names, updated_at
  )
  select
    (row_value ->> 'daily_import_id')::uuid,
    (row_value ->> 'client_id')::uuid,
    (row_value ->> 'trading_date')::date,
    row_value ->> 'segment',
    coalesce((row_value ->> 'accounts')::integer, 0),
    coalesce((row_value ->> 'daily_pnl')::numeric, 0),
    coalesce((row_value ->> 'weekly_pnl')::numeric, 0),
    coalesce((row_value ->> 'balance')::numeric, 0),
    coalesce((row_value ->> 'counted_in_total')::boolean, true),
    coalesce(
      (select array_agg(name_value #>> '{}')
         from jsonb_array_elements(
           case when jsonb_typeof(row_value -> 'account_names') = 'array'
                then row_value -> 'account_names'
                else '[]'::jsonb end
         ) as name_value),
      '{}'::text[]
    ),
    now()
  from jsonb_array_elements(p_rows) as row_value
  -- Only the closes this call named. A payload naming a close the caller did
  -- not ask to replace would insert rows nothing deleted first, and the
  -- duplicate would be caught by the unique index rather than by intent.
  where (row_value ->> 'daily_import_id')::uuid = any (p_daily_import_ids);

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- Restated, not changed: the browser (authenticated) and the ingest endpoints
-- (service_role), never anon. `create or replace` keeps the grants a function
-- already has; these lines say what they are.
revoke all on function public.replace_close_summaries(uuid[], jsonb)
  from public, anon;

grant execute on function public.replace_close_summaries(uuid[], jsonb)
  to authenticated, service_role;

-- What this leaves, checked rather than assumed, and checked BEFORE the
-- commit: a check that fails here takes the new function down with it, so a
-- database it refuses is left exactly as it was found.
do $do$
begin
  if has_function_privilege('anon', 'public.replace_close_summaries(uuid[], jsonb)', 'execute') then
    raise exception 'step 58 left replace_close_summaries executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.replace_close_summaries(uuid[], jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.replace_close_summaries(uuid[], jsonb)', 'execute') then
    raise exception 'step 58 took replace_close_summaries away from the browser or the ingest endpoints';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.replace_close_summaries(uuid[], jsonb)'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=pg_catalog, public']
      and prosrc like '%public.assigned_client_ids()%'
      and prosrc like '%public.is_manager()%'
      and prosrc like '%errcode = ''42501''%'
  ) then
    raise exception 'step 58 did not install the scoped replace_close_summaries';
  end if;
end
$do$;

commit;
