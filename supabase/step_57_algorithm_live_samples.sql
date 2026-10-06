-- Step 57: what each algorithm instance has made today, read live, so a client
-- can be put beside the rest of the desk running the same algorithm.
--
-- WHY 57. 54 is claimed by draft PR 65 (the deep export requests), and 55 and 56
-- are merged. The run order is 55, 56, 57. The gap at 54 is deliberate and
-- nobody should close it.
--
-- WHAT THIS IS FOR. Pedro, in his words: if OGX is at -500 on the desk, he wants
-- to see that one client is at -1200 instead, and what that client's settings
-- are, and use that as the feedback loop. The number is the one the NinjaTrader
-- Strategies tab shows for one strategy instance: Realized plus Unrealized. It
-- is gross, it counts since the instance was enabled, and it is marked to market,
-- so it moves with the price even when nobody trades.
--
-- THAT LAST FACT IS THE WHOLE DESIGN. Two readings taken minutes apart are not
-- comparable, because the market moved between them. So every reading carries
-- the CYCLE it belongs to, and the desk figure is only ever computed over one
-- cycle: desk and client from the same ten minute boundary, never from two
-- clocks.
--
--   * The cycle length is account_tracker_settings.sample_interval_seconds
--     (step 55). There is one tunable and not two: the agent already learns that
--     value from the /api/ingest/accounts reply, so the CRM's cycle and the
--     agent's cadence cannot disagree for longer than one cycle. A second
--     cycle_seconds column would be a second clock that can disagree with it.
--   * The grid is floor(unix epoch / interval) * interval, in UTC, so every
--     machine computes the same boundaries with no time zone involved.
--   * The agent samples at boundary + 2 s. The CRM derives the cycle from the
--     machine's own sampled_at and stores it only when the reading was taken
--     near the boundary AND the machine's clock agrees with this database
--     within the tolerance. Anything else is stored as the last reading with
--     cycle_start NULL, "off cycle", and is never compared.
--
-- ONE ROW PER INSTANCE, OVERWRITTEN. Not a time series, in step 55's words and
-- for step 55's reason: Pedro asked for a tracker, the least data. The key is
-- (device, account, NinjaTrader strategy id), which survives a contract roll
-- (14 of 16 measured ids kept their id while the instrument string changed).
--
-- AND BECAUSE IT IS OVERWRITTEN, THE COMPARED CYCLE IS THE NEWEST ONE, AND ONLY
-- ONCE IT IS COMPLETE. The first draft of this design read "the latest complete
-- cycle" as max(cycle_start) among complete cycles. With last-reading storage
-- that is wrong for about ninety seconds after every boundary: the moment the
-- first machine posts the new cycle, its rows LEAVE the previous one, so the
-- previous cycle is being drained while the new one fills, and a median over it
-- is a median over whoever has not posted yet. So the desk function takes the
-- newest cycle there is, and while that cycle is still inside its tolerance it
-- answers "filling" and compares nothing. Half a desk is never compared.
--
-- WHO MAY SEE WHAT. Since step 52 a CAM sees only its own clients' rows, so a
-- CAM cannot compute a desk median from rows, and must not be able to. The desk
-- figure comes from algorithm_live_desk(), a SECURITY DEFINER function that
-- returns aggregates only and:
--
--   * leaves the CALLER'S OWN CLIENTS OUT of the aggregate. A floor on the total
--     cohort size does not protect: measured on the last close, 9 of 58 (cohort,
--     CAM) pairs have fewer than 3 clients outside the CAM's own book, so a CAM
--     subtracting its own known values from a desk figure could isolate another
--     CAM's client. With its own clients excluded there is nothing to subtract.
--   * applies the floor to accounts AND to distinct clients OUTSIDE the
--     caller's book, both taken from algorithm_live_settings.
--   * returns NO numbers at all for a cohort under the floor, counts included,
--     because a count below the floor is itself a reading about other books.
--   * returns a median and a robust spread only, rounded to whole dollars:
--     never a minimum, a maximum or a quantile.
--   * takes no parameters: only the current cycle can be asked about.
--
-- WHAT "THE CALLER'S OWN CLIENTS" MEANS. Not only the clients assigned to her
-- now. The browser has no write path into either table, but the ingest route is
-- a write path a CAM can reach: she may create a client (step 52), assign it to
-- herself (step 53), take an enrollment code for it, pair a VPS with that code
-- and so hold a device credential, and then delete her own assignment row,
-- which step 53's policy lets her do. Counted by assigned_client_ids() alone,
-- that client's readings became "the rest of the desk": two of them met the
-- floor on their own, and values placed on both sides of one real account made
-- the median that account's value to the dollar. So the set left out for a CAM
-- is every client she can influence: assigned to her now, created by her
-- (clients_i_created), or enrolled with a code she issued
-- (ingest_enrollments.created_by), whoever it is assigned to today. The cost is
-- that a client she once enrolled and that has since moved to another CAM's
-- book never counts in her desk figure; it still counts for everyone else.
--
-- What this does not close, stated: a CAM who reads the device credential off
-- a VPS paired under SOMEONE ELSE'S code, for a client assigned to her, can
-- still hand that client to another CAM (step 53 checks only that the client
-- is assigned to her when she writes the assignment) and then post as it. That
-- needs the credential lifted from the machine, and it is a hole in step 53's
-- assignment policy, raised separately rather than patched here. CLOSED BY
-- STEP 60 for a handoff the CAM makes herself: she can no longer write an
-- assignment for another profile or delete one, so a client assigned to her
-- stays in her book until a Manager moves it. NOT closed for a Manager's
-- legitimate move: when a Manager moves a client that was paired under someone
-- else's code, its device credential still posts readings, and they count as
-- the desk for the CAM who held it before.
--
-- RESIDUAL RISK, stated rather than hidden: across consecutive cycles, a median
-- that moves when one outside account enters or leaves the cohort bounds that
-- account's value. That is small next to the existing leak in log_algo_history,
-- which keeps step 43's full access for every CAM and shows per-account,
-- per-family P&L desk-wide. CLOSED BY STEP 59, which hands a CAM that history
-- only as family aggregates under these same floors, counting each row for the
-- client it was attributed to when it was written.
--
-- EVERY TUNABLE IS A COLUMN, edited in the SQL editor, because Pedro cannot set
-- an environment variable in Vercel. The CHECK constraints are the only review a
-- hand edit gets.
--
-- HARMLESS ON ITS OWN, in every order. The /api/ingest/strategies route answers
-- 404 strategy_sample_not_deployed while this file has not run, which the agent
-- reads as "try again in an hour", and the account tracker (step 55's route,
-- function and table) is not touched by anything here. The screen says the
-- migration has not been run. Idempotent: every statement is create if not
-- exists, create or replace, or guarded, so running it twice is safe.

begin;

-- ---------------------------------------------------------------------------
-- The order guard. This file reads step 55's interval and calls step 52's two
-- helpers; without them the desk function would be created and fail on its
-- first call, on a trading day, instead of here.
-- ---------------------------------------------------------------------------
do $step57_guard$
begin
  if to_regclass('public.account_tracker_settings') is null
    or to_regprocedure('public.is_manager()') is null
    or to_regprocedure('public.assigned_client_ids()') is null then
    raise exception 'step 57 needs step 55 (account_tracker_settings) and step 52 (is_manager): run them first';
  end if;
  -- The desk function also leaves out the clients the caller created (step 53)
  -- and the ones she enrolled (step 28). Both are in the run order long before
  -- 55, so this only fires on a database assembled out of order.
  if to_regprocedure('public.clients_i_created()') is null
    or to_regclass('public.ingest_enrollments') is null then
    raise exception 'step 57 needs step 53 (clients_i_created) and step 28 (ingest_enrollments): run them first';
  end if;
end
$step57_guard$;

-- ---------------------------------------------------------------------------
-- The tunables, a singleton in the shape of account_tracker_settings.
-- ---------------------------------------------------------------------------
create table if not exists public.algorithm_live_settings (
  id boolean primary key default true,
  -- THE FLOOR, counted OUTSIDE the caller's own book. Five accounts and three
  -- clients by default. Under it the cohort is listed and never compared.
  min_cohort_accounts integer not null default 5,
  min_cohort_clients integer not null default 3,
  -- How far after a boundary a reading may be taken and still belong to that
  -- cycle, and how far the machine's clock may disagree with this database.
  -- Also how long a new cycle is left to fill before it is compared.
  cycle_tolerance_seconds integer not null default 90,
  -- An account "differs" when its distance from the median is at least this
  -- many times the cohort's usual spread.
  differs_at_spread numeric(4,1) not null default 3.0,
  -- The smallest spread a cohort is credited with, in dollars, so a cohort that
  -- agrees to the cent does not turn a $5 difference into a finding.
  min_spread_dollars integer not null default 50,
  max_strategies_per_report integer not null default 200,
  -- A reading older than this leaves the table. Two days keeps yesterday's
  -- last cycle on screen on the next morning and nothing more.
  retention_days integer not null default 2,
  updated_at timestamptz not null default now(),
  constraint algorithm_live_settings_singleton check (id),
  -- Three is the smallest cohort with a median that is not one of two people.
  constraint algorithm_live_settings_accounts_check
    check (min_cohort_accounts between 3 and 200),
  -- A client floor above the account floor could never be met.
  constraint algorithm_live_settings_clients_check
    check (min_cohort_clients between 2 and 100
      and min_cohort_clients <= min_cohort_accounts),
  constraint algorithm_live_settings_tolerance_check
    check (cycle_tolerance_seconds between 10 and 300),
  constraint algorithm_live_settings_spread_check
    check (differs_at_spread between 1 and 20),
  constraint algorithm_live_settings_min_spread_check
    check (min_spread_dollars between 1 and 100000),
  constraint algorithm_live_settings_report_check
    check (max_strategies_per_report between 1 and 1000),
  constraint algorithm_live_settings_retention_check
    check (retention_days between 1 and 14)
);

insert into public.algorithm_live_settings (id) values (true)
on conflict (id) do nothing;

comment on table public.algorithm_live_settings is
  'Singleton tunables for the live per algorithm comparison (step 57). Edit in the SQL editor, for example: update public.algorithm_live_settings set min_cohort_accounts = 6, updated_at = now() where id; The CHECK constraints are the review. The floors count accounts and clients OUTSIDE the viewing CAM''s own book. The cycle length is account_tracker_settings.sample_interval_seconds, not a column here.';

-- ---------------------------------------------------------------------------
-- The last reading of each strategy instance.
-- ---------------------------------------------------------------------------
create table if not exists public.algorithm_live_samples (
  -- BY DEFAULT, not ALWAYS: an ALWAYS identity answers an insert that names
  -- the column with "cannot insert a non-DEFAULT value" BEFORE the privilege
  -- check, which would let step 56's per-verb probe read a refusal as
  -- something other than "permission denied". Only the service role writes.
  id bigint generated by default as identity primary key,
  device_id uuid not null references public.ingest_devices(id) on delete cascade,
  -- Copied from the device, as step 55 does, so the RLS predicate and the
  -- screen's query key on it without reaching into ingest_devices.
  client_id uuid not null references public.clients(id) on delete cascade,
  account_name text not null,
  -- NinjaTrader's own instance id: stable across days and contract rolls.
  strategy_id text not null,
  strategy_name text not null,
  -- familyFromStrategyName, computed by the route in JavaScript so this
  -- database never holds a second copy of the product's one family rule.
  algorithm text not null,
  instrument text not null,
  -- instrumentRoot, also from the route. MNQ and NQ are ten times apart, so the
  -- root is part of the cohort.
  instrument_root text not null,
  -- NULL IS NOT MEASURED, never zero. A machine on an add-on that cannot read
  -- the Strategies tab sends the instance with both parts null.
  realized_pnl numeric(16,2),
  unrealized_pnl numeric(16,2),
  -- Set by the agent when the instance was live earlier today, disappeared, and
  -- came back: NinjaTrader restarts the figure at 0 then, so the row counts
  -- only since this moment and is never compared.
  restarted_at timestamptz,
  sampled_at timestamptz not null,
  -- The cycle this reading belongs to, or NULL when it was off cycle.
  cycle_start timestamptz,
  reported_at timestamptz not null default now(),
  constraint algorithm_live_samples_instance_unique unique (device_id, account_name, strategy_id),
  constraint algorithm_live_samples_account_check
    check (account_name = btrim(account_name) and length(account_name) between 1 and 200),
  constraint algorithm_live_samples_strategy_id_check
    check (strategy_id = btrim(strategy_id) and length(strategy_id) between 1 and 64),
  constraint algorithm_live_samples_strategy_name_check
    check (strategy_name = btrim(strategy_name) and length(strategy_name) between 1 and 200),
  constraint algorithm_live_samples_algorithm_check
    check (algorithm = btrim(algorithm) and length(algorithm) between 1 and 200),
  constraint algorithm_live_samples_instrument_check
    check (instrument = btrim(instrument) and length(instrument) between 1 and 64),
  constraint algorithm_live_samples_root_check
    check (instrument_root = btrim(instrument_root) and length(instrument_root) between 1 and 16),
  -- abs() <= 1e12 also refuses NaN, which compares above every number.
  constraint algorithm_live_samples_money_check
    check ((realized_pnl is null or abs(realized_pnl) <= 1e12)
      and (unrealized_pnl is null or abs(unrealized_pnl) <= 1e12)),
  constraint algorithm_live_samples_restart_check
    check (restarted_at is null or restarted_at <= sampled_at),
  constraint algorithm_live_samples_cycle_check
    check (cycle_start is null or cycle_start <= sampled_at)
);

create index if not exists idx_algorithm_live_samples_cohort
  on public.algorithm_live_samples (cycle_start, algorithm, instrument_root);
create index if not exists idx_algorithm_live_samples_client
  on public.algorithm_live_samples (client_id);

comment on table public.algorithm_live_samples is
  'The LAST reading of each NinjaTrader strategy instance on each paired VPS (Strategies tab Realized and Unrealized), overwritten, never a time series. About 10 to 14 rows per VPS per cycle. cycle_start is the sample cycle the reading belongs to, NULL when off cycle. Rows leave by the retention sweep in record_algorithm_live_sample and by the cascades from clients and ingest_devices.';

-- ---------------------------------------------------------------------------
-- algorithm_live_cycle: which cycle a reading belongs to, or NULL.
--
-- A separate immutable function so the rule can be tested at its boundaries
-- with a fixed "now" instead of the wall clock. Two conditions, both needed:
--   (i)  the reading was taken within the tolerance after the boundary, and
--   (ii) the machine's clock agrees with this database within the tolerance,
--        in either direction.
-- ---------------------------------------------------------------------------
create or replace function public.algorithm_live_cycle(
  p_sampled_at timestamptz,
  p_now timestamptz,
  p_cycle_seconds integer,
  p_tolerance_seconds integer
)
returns timestamptz
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select case
    when p_sampled_at is null or p_now is null
      or p_cycle_seconds is null or p_cycle_seconds <= 0
      or p_tolerance_seconds is null or p_tolerance_seconds < 0 then null
    when p_sampled_at - boundary.start <= make_interval(secs => p_tolerance_seconds)
      and abs(extract(epoch from (p_now - p_sampled_at))) <= p_tolerance_seconds
      then boundary.start
    else null
  end
  from (
    select to_timestamp(
      (floor(extract(epoch from p_sampled_at) / p_cycle_seconds) * p_cycle_seconds)::double precision
    ) as start
  ) as boundary;
$function$;

revoke all on function public.algorithm_live_cycle(timestamptz, timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.algorithm_live_cycle(timestamptz, timestamptz, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- record_algorithm_live_sample: one machine's readings, upserted.
--
-- Validates EVERY item before writing anything, and before the throttle, as
-- step 55 does: a malformed payload must not be answered "throttled" while a
-- broken agent retries inside the window. The post is atomic.
--
-- `recorded` counts the rows the upsert actually wrote, from RETURNING. A row
-- refused because the stored reading is newer is not counted.
-- ---------------------------------------------------------------------------
create or replace function public.record_algorithm_live_sample(
  p_device_id uuid,
  p_sampled_at timestamptz,
  p_strategies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_settings public.algorithm_live_settings;
  v_cycle_seconds integer;
  v_min_report_seconds integer;
  v_device public.ingest_devices;
  v_now timestamptz := clock_timestamp();
  v_item jsonb;
  v_keys text[] := array[]::text[];
  v_key text;
  v_text text;
  v_restarted timestamptz;
  v_last_reported timestamptz;
  v_cycle timestamptz;
  v_recorded integer := 0;
begin
  select settings.* into v_settings
  from public.algorithm_live_settings as settings
  where settings.id;

  if not found then
    -- The seed is in this file, so a missing row means somebody deleted it. A
    -- reading is not worth a refused report: the column defaults stand in.
    v_settings.min_cohort_accounts := 5;
    v_settings.min_cohort_clients := 3;
    v_settings.cycle_tolerance_seconds := 90;
    v_settings.differs_at_spread := 3.0;
    v_settings.min_spread_dollars := 50;
    v_settings.max_strategies_per_report := 200;
    v_settings.retention_days := 2;
  end if;

  select tracker.sample_interval_seconds, tracker.min_report_interval_seconds
    into v_cycle_seconds, v_min_report_seconds
  from public.account_tracker_settings as tracker
  where tracker.id;
  v_cycle_seconds := coalesce(v_cycle_seconds, 600);
  v_min_report_seconds := coalesce(v_min_report_seconds, 60);

  if p_device_id is null
    or p_sampled_at is null
    or p_sampled_at > v_now + interval '5 minutes'
    or p_strategies is null
    or jsonb_typeof(p_strategies) <> 'array'
    or jsonb_array_length(p_strategies) > v_settings.max_strategies_per_report then
    raise exception 'INVALID_STRATEGY_SAMPLE'
      using errcode = '22023';
  end if;

  select device.* into v_device
  from public.ingest_devices as device
  where device.id = p_device_id;

  if not found
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'INVALID_INGEST_DEVICE'
      using errcode = 'P0001';
  end if;

  -- PASS ONE: validate everything, write nothing.
  for v_item in select value from jsonb_array_elements(p_strategies) loop
    begin
      if jsonb_typeof(v_item) <> 'object'
        or coalesce(jsonb_typeof(v_item -> 'accountName'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'strategyId'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'strategyName'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'algorithm'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'instrument'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'instrumentRoot'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'realizedPnl'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'unrealizedPnl'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'restartedAt'), 'null') not in ('string', 'null') then
        raise exception 'malformed item';
      end if;

      foreach v_key in array array['accountName', 'strategyName', 'algorithm'] loop
        v_text := v_item ->> v_key;
        if v_text is distinct from btrim(v_text) or length(v_text) not between 1 and 200 then
          raise exception 'malformed item';
        end if;
      end loop;
      foreach v_key in array array['strategyId', 'instrument'] loop
        v_text := v_item ->> v_key;
        if v_text is distinct from btrim(v_text) or length(v_text) not between 1 and 64 then
          raise exception 'malformed item';
        end if;
      end loop;
      v_text := v_item ->> 'instrumentRoot';
      if v_text is distinct from btrim(v_text) or length(v_text) not between 1 and 16 then
        raise exception 'malformed item';
      end if;

      if abs(coalesce((v_item ->> 'realizedPnl')::numeric, 0)) > 1e12
        or abs(coalesce((v_item ->> 'unrealizedPnl')::numeric, 0)) > 1e12 then
        raise exception 'malformed item';
      end if;

      v_restarted := (v_item ->> 'restartedAt')::timestamptz;
      if v_restarted is not null
        and (v_restarted > p_sampled_at or v_restarted < p_sampled_at - interval '1 day') then
        raise exception 'malformed item';
      end if;

      -- The same instance twice would make the upsert's outcome depend on the
      -- order of the array.
      v_key := (v_item ->> 'accountName') || chr(31) || (v_item ->> 'strategyId');
      if v_key = any (v_keys) then
        raise exception 'malformed item';
      end if;
    exception when others then
      raise exception 'INVALID_STRATEGY_SAMPLE'
        using errcode = '22023';
    end;
    v_keys := v_keys || v_key;
  end loop;

  -- THE THROTTLE, after validation and before any write.
  select max(sample.reported_at) into v_last_reported
  from public.algorithm_live_samples as sample
  where sample.device_id = p_device_id;

  if v_last_reported is not null
    and v_now < v_last_reported + make_interval(secs => v_min_report_seconds) then
    return jsonb_build_object('recorded', 0, 'throttled', true, 'cycleStart', null);
  end if;

  v_cycle := public.algorithm_live_cycle(
    p_sampled_at, v_now, v_cycle_seconds, v_settings.cycle_tolerance_seconds);

  -- PASS TWO: the upsert. An older reading never overwrites a newer one.
  with written as (
    insert into public.algorithm_live_samples as sample (
      device_id, client_id, account_name, strategy_id, strategy_name, algorithm,
      instrument, instrument_root, realized_pnl, unrealized_pnl, restarted_at,
      sampled_at, cycle_start, reported_at
    )
    select
      p_device_id,
      v_device.client_id,
      item ->> 'accountName',
      item ->> 'strategyId',
      item ->> 'strategyName',
      item ->> 'algorithm',
      item ->> 'instrument',
      item ->> 'instrumentRoot',
      (item ->> 'realizedPnl')::numeric,
      (item ->> 'unrealizedPnl')::numeric,
      (item ->> 'restartedAt')::timestamptz,
      p_sampled_at,
      v_cycle,
      v_now
    from jsonb_array_elements(p_strategies) as item
    on conflict (device_id, account_name, strategy_id) do update
    set client_id = excluded.client_id,
        strategy_name = excluded.strategy_name,
        algorithm = excluded.algorithm,
        instrument = excluded.instrument,
        instrument_root = excluded.instrument_root,
        realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl,
        restarted_at = excluded.restarted_at,
        sampled_at = excluded.sampled_at,
        cycle_start = excluded.cycle_start,
        reported_at = excluded.reported_at
    where excluded.sampled_at >= sample.sampled_at
    returning 1
  )
  select count(*) into v_recorded from written;

  -- THE ONLY SWEEP. Device scoped and bounded by a settings column.
  delete from public.algorithm_live_samples as sample
  where sample.device_id = p_device_id
    and sample.sampled_at < v_now - make_interval(days => v_settings.retention_days);

  return jsonb_build_object('recorded', v_recorded, 'throttled', false, 'cycleStart', v_cycle);
end;
$function$;

revoke all on function public.record_algorithm_live_sample(uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_algorithm_live_sample(uuid, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- algorithm_live_desk: the desk figure, as aggregates only.
--
-- One row per (algorithm, instrument_root) of the compared cycle, with
-- status 'compared' and the numbers, or status 'thin' and every number NULL.
-- Plus, when there is a cycle but no cohort to show, ONE marker row with a NULL
-- algorithm, so the screen can tell "nothing outside your book this cycle" and
-- "the cycle is still filling" from "no cycle at all":
--   status 'filling'    the newest cycle is still inside its tolerance;
--   status 'no_cohort'  the newest cycle is complete and nothing outside the
--                       caller's book ran in it.
--
-- The CALLER'S OWN CLIENTS are left out of every aggregate and the floor counts
-- what is left. A Manager has no own book here and sees the whole desk.
-- ---------------------------------------------------------------------------
create or replace function public.algorithm_live_desk()
returns table (
  algorithm text,
  instrument_root text,
  cycle_start timestamptz,
  scope text,
  status text,
  n_accounts integer,
  n_clients integer,
  median numeric,
  spread numeric,
  n_flat integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  v_settings public.algorithm_live_settings;
  v_manager boolean;
  v_mine uuid[];
  v_cycle timestamptz;
  v_scope text;
  v_any boolean := false;
begin
  if auth.uid() is null then
    return;
  end if;

  v_manager := coalesce((select public.is_manager()), false);

  -- A signed-in session with no active CRM user behind it reads nothing, the
  -- same as it reads no row of any table under step 52.
  if not v_manager and not exists (
    select 1 from public.app_users as app_user
    where app_user.auth_user_id = auth.uid()
      and coalesce(app_user.status, 'Active') <> 'Inactive'
  ) then
    return;
  end if;

  if v_manager then
    v_mine := array[]::uuid[];
    v_scope := 'desk';
  else
    -- EVERY CLIENT THE CALLER CAN INFLUENCE, not only the ones assigned to her
    -- now. An assignment is a row a CAM can delete herself (step 53), so a
    -- client she created, or one whose VPS she paired with a code she issued,
    -- stays in her book here whoever it is assigned to today. See the header.
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
    v_scope := 'rest_of_desk';
  end if;

  select settings.* into v_settings
  from public.algorithm_live_settings as settings
  where settings.id;
  if not found then
    v_settings.min_cohort_accounts := 5;
    v_settings.min_cohort_clients := 3;
    v_settings.cycle_tolerance_seconds := 90;
  end if;

  -- THE NEWEST CYCLE, over every row and not only the caller's. See the header
  -- for why it is not "the newest complete one".
  select max(sample.cycle_start) into v_cycle
  from public.algorithm_live_samples as sample
  where sample.cycle_start is not null;

  if v_cycle is null then
    return;
  end if;

  if v_cycle + make_interval(secs => v_settings.cycle_tolerance_seconds) > now() then
    algorithm := null;
    instrument_root := null;
    cycle_start := v_cycle;
    scope := v_scope;
    status := 'filling';
    n_accounts := null;
    n_clients := null;
    median := null;
    spread := null;
    n_flat := null;
    return next;
    return;
  end if;

  for algorithm, instrument_root, status, n_accounts, n_clients, median, spread, n_flat in
    with account_values as (
      select sample.algorithm as algo,
             sample.instrument_root as root,
             sample.client_id as client,
             sample.account_name as account,
             sum(sample.realized_pnl + sample.unrealized_pnl) as value,
             bool_or(sample.realized_pnl is null
               or sample.unrealized_pnl is null
               or sample.restarted_at is not null) as unusable
      from public.algorithm_live_samples as sample
      where sample.cycle_start = v_cycle
        and sample.client_id <> all (v_mine)
      group by sample.algorithm, sample.instrument_root, sample.client_id, sample.account_name
    ),
    usable as (
      select * from account_values where not account_values.unusable
    ),
    cohort as (
      select usable.algo, usable.root,
             count(*)::integer as accounts,
             count(distinct usable.client)::integer as clients,
             percentile_cont(0.5) within group (order by usable.value::double precision) as med,
             count(*) filter (where usable.value = 0)::integer as flat
      from usable
      group by usable.algo, usable.root
    ),
    deviation as (
      select usable.algo, usable.root,
             percentile_cont(0.5) within group (
               order by abs(usable.value::double precision - cohort.med)) as mad
      from usable
      join cohort on cohort.algo = usable.algo and cohort.root = usable.root
      group by usable.algo, usable.root
    )
    select cohort.algo,
           cohort.root,
           case when ok.passes then 'compared' else 'thin' end,
           case when ok.passes then cohort.accounts end,
           case when ok.passes then cohort.clients end,
           case when ok.passes then round(cohort.med::numeric, 0) end,
           case when ok.passes then round(deviation.mad::numeric, 0) end,
           case when ok.passes then cohort.flat end
    from cohort
    join deviation on deviation.algo = cohort.algo and deviation.root = cohort.root
    cross join lateral (
      select cohort.accounts >= v_settings.min_cohort_accounts
         and cohort.clients >= v_settings.min_cohort_clients as passes
    ) as ok
    order by cohort.algo, cohort.root
  loop
    cycle_start := v_cycle;
    scope := v_scope;
    v_any := true;
    return next;
  end loop;

  if not v_any then
    algorithm := null;
    instrument_root := null;
    cycle_start := v_cycle;
    scope := v_scope;
    status := 'no_cohort';
    n_accounts := null;
    n_clients := null;
    median := null;
    spread := null;
    n_flat := null;
    return next;
  end if;
end;
$function$;

revoke all on function public.algorithm_live_desk() from public, anon, authenticated;
grant execute on function public.algorithm_live_desk() to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants, step 55's pattern.
--
-- `revoke all` then `grant select`: Supabase hands every new table in public all
-- eight privileges for anon and authenticated, and TRUNCATE is not subject to
-- row level security at all, so the revoke is the whole control for it. This
-- file does not rely on step 56 having changed the default privileges first.
--
-- The write denials are RESTRICTIVE so they survive a re-run of step 52, whose
-- loop gives every client_id table a permissive `for all` with read AND write,
-- and DELETE needs its own policy because `with check` does not govern it.
-- ---------------------------------------------------------------------------
alter table public.algorithm_live_samples enable row level security;
alter table public.algorithm_live_settings enable row level security;

revoke all on public.algorithm_live_samples from anon, authenticated;
revoke all on public.algorithm_live_settings from anon, authenticated;
grant select on public.algorithm_live_samples to authenticated;
grant select on public.algorithm_live_settings to authenticated;

do $algorithm_live_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_samples'
      and policyname = 'cam sees its own clients'
  ) then
    create policy "cam sees its own clients"
      on public.algorithm_live_samples
      for select
      to authenticated
      using ((select public.is_manager())
        or client_id in (select public.assigned_client_ids()));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_samples'
      and policyname = 'algorithm_live_samples deny browser writes'
  ) then
    create policy "algorithm_live_samples deny browser writes"
      on public.algorithm_live_samples
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_samples'
      and policyname = 'algorithm_live_samples deny browser deletes'
  ) then
    create policy "algorithm_live_samples deny browser deletes"
      on public.algorithm_live_samples
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;

  -- The floors name no client, and the screen prints them.
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_settings'
      and policyname = 'anyone signed in reads the algorithm live settings'
  ) then
    create policy "anyone signed in reads the algorithm live settings"
      on public.algorithm_live_settings
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_settings'
      and policyname = 'algorithm_live_settings deny browser writes'
  ) then
    create policy "algorithm_live_settings deny browser writes"
      on public.algorithm_live_settings
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_live_settings'
      and policyname = 'algorithm_live_settings deny browser deletes'
  ) then
    create policy "algorithm_live_settings deny browser deletes"
      on public.algorithm_live_settings
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;
end
$algorithm_live_policies$;

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 55 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 57 left % table(s) without row level security', n;
  end if;
end $$;
