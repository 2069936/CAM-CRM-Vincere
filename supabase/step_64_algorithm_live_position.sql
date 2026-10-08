-- Step 64: the position travels with the per strategy reading, so the desk can
-- see which way BulletBot fired without asking in the team chat.
--
-- WHY 64. 63 is applied. 54 is still claimed by draft PR 65 and the gap stays.
-- 64 needs 57 (the table and the function it replaces) and refuses to run
-- without it; it depends on nothing after 57.
--
-- WHAT WAS MISSING. The CAMs tell each other during the day how each algorithm
-- is doing and whether BulletBot went long or short. The CRM shows the first
-- half since step 57 (Realized plus Unrealized per live instance) and cannot
-- show the second: BulletBot decides its direction each day, so no catalogue
-- row knows it. Agent 1.2.1 reads it off the strategy's own Position object
-- and posts it with the reading; this step gives it somewhere to land.
--
-- WHAT THIS ADDS, and only this:
--
--   * Three nullable columns on public.algorithm_live_samples:
--       market_position   text     'long', 'short' or 'flat', null when not read
--       position_quantity integer  contracts held, 0 when flat, 0 to 100000
--       trades_this_run   integer  real time trades this run, 0 to 1000000
--     each with its own CHECK constraint, dropped and recreated under its name.
--     NULL IS "NOT READ", never flat and never zero: a 1.2.0 agent sends none
--     of them, an add-on that could not read the position sends null, and the
--     screen says so instead of inventing a flat position.
--
--   * public.record_algorithm_live_sample replaced WITH THE SAME SIGNATURE
--     (uuid, timestamptz, jsonb). The three values ride inside each item of
--     p_strategies, the way every other per instance field does, so the route's
--     call does not change, PostgREST resolves the one function it always did,
--     and there is no overload and nothing to drop. PASS ONE validates the three
--     keys when present (the word, whole numbers, the bounds); PASS TWO writes
--     them on insert and on the upsert's update. A reading without them clears
--     the columns, because the row is the LATEST reading, not a merge: if the
--     position could not be read this cycle, the screen must not show the last
--     cycle's as if it were current.
--
--   * The function's grants restated per step 56's rule: nothing for public,
--     anon or authenticated, EXECUTE for the service role the ingest route runs
--     as. The table's grants and policies are untouched: the new columns inherit
--     the table's SELECT for authenticated and step 57's "cam sees its own
--     clients" policy decides the rows, as before.
--
-- COMPATIBILITY, in every order:
--   * Agent 1.2.0 against this step: its items carry no position keys, the
--     function reads them as null, nothing else changes.
--   * Agent 1.2.1 against step 57 (this file not yet run): the function ignores
--     keys it does not know, so the post lands and the three values are dropped
--     until 64 runs. The CRM route accepts them either way.
--   * Deploy order for the desk: merge the CRM, run this file, THEN install
--     1.2.1. The agent works in the other order too; it just reports positions
--     to a database that cannot keep them yet.
--
-- IDEMPOTENT. `add column if not exists` (it says "skipping" the second time),
-- constraints dropped and recreated under their names, `create or replace
-- function`, revoke then grant. RE-RUNNING STEP 57 after this is NOT a no-op:
-- 57 carries the old function body, which writes none of the three columns, so
-- the values would be dropped again until 64 is run again after it. The
-- runbook says so beside the row.
--
-- CHECK AFTERWARDS (read only), once a 1.2.1 agent has posted:
--
--   select account_name, strategy_name, market_position, position_quantity,
--          trades_this_run, sampled_at
--     from public.algorithm_live_samples
--    order by sampled_at desc limit 20;

begin;

do $step64_guard$
begin
  if to_regclass('public.algorithm_live_samples') is null
    or to_regprocedure('public.record_algorithm_live_sample(uuid, timestamptz, jsonb)') is null then
    raise exception 'step 64 needs step 57 (algorithm_live_samples): run it first';
  end if;
end
$step64_guard$;

alter table public.algorithm_live_samples
  add column if not exists market_position text;
alter table public.algorithm_live_samples
  add column if not exists position_quantity integer;
alter table public.algorithm_live_samples
  add column if not exists trades_this_run integer;

alter table public.algorithm_live_samples
  drop constraint if exists algorithm_live_samples_market_position_check;
alter table public.algorithm_live_samples
  add constraint algorithm_live_samples_market_position_check
  check (market_position is null or market_position in ('long', 'short', 'flat'));

alter table public.algorithm_live_samples
  drop constraint if exists algorithm_live_samples_position_quantity_check;
alter table public.algorithm_live_samples
  add constraint algorithm_live_samples_position_quantity_check
  check (position_quantity is null or position_quantity between 0 and 100000);

alter table public.algorithm_live_samples
  drop constraint if exists algorithm_live_samples_trades_this_run_check;
alter table public.algorithm_live_samples
  add constraint algorithm_live_samples_trades_this_run_check
  check (trades_this_run is null or trades_this_run between 0 and 1000000);

comment on column public.algorithm_live_samples.market_position is
  'Position.MarketPosition as the add-on read it: long, short or flat. NULL is not read (an agent before 1.2.1, or a position the add-on could not read), never flat. Step 64.';
comment on column public.algorithm_live_samples.position_quantity is
  'Position.Quantity, the contracts the instance holds, 0 when flat. NULL is not read. Step 64.';
comment on column public.algorithm_live_samples.trades_this_run is
  'The real time trades this run of the instance has completed, as the add-on read it. Restarts at 0 on a re-enable. NULL is not read. Step 64.';

-- ---------------------------------------------------------------------------
-- record_algorithm_live_sample: step 57's function with the three position
-- keys validated and written. Everything else is step 57's, line for line: the
-- settings fallback, the top level checks, the device check, the two passes,
-- the throttle, the cycle, the sweep and the return shape.
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
  v_number numeric;
  v_restarted timestamptz;
  v_last_reported timestamptz;
  v_cycle timestamptz;
  v_recorded integer := 0;
begin
  select settings.* into v_settings
  from public.algorithm_live_settings as settings
  where settings.id;

  if not found then
    -- The seed is in step 57, so a missing row means somebody deleted it. A
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
        or coalesce(jsonb_typeof(v_item -> 'restartedAt'), 'null') not in ('string', 'null')
        -- The position keys (step 64): absent and null read the same, present
        -- must be the right kind.
        or coalesce(jsonb_typeof(v_item -> 'marketPosition'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(v_item -> 'positionQuantity'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'tradesThisRun'), 'null') not in ('number', 'null') then
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

      -- The position (step 64). The route lower cases the word; SQL takes only
      -- the three words the column's CHECK takes, so a refusal here is the same
      -- refusal the table would give, one layer earlier and for the whole post.
      v_text := v_item ->> 'marketPosition';
      if v_text is not null and v_text not in ('long', 'short', 'flat') then
        raise exception 'malformed item';
      end if;
      v_number := (v_item ->> 'positionQuantity')::numeric;
      if v_number is not null
        and (v_number <> trunc(v_number) or v_number not between 0 and 100000) then
        raise exception 'malformed item';
      end if;
      v_number := (v_item ->> 'tradesThisRun')::numeric;
      if v_number is not null
        and (v_number <> trunc(v_number) or v_number not between 0 and 1000000) then
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

  -- PASS TWO: the upsert. An older reading never overwrites a newer one. The
  -- position columns are written from the item, null when it carries none:
  -- the row is the latest reading, not a merge with the last one.
  with written as (
    insert into public.algorithm_live_samples as sample (
      device_id, client_id, account_name, strategy_id, strategy_name, algorithm,
      instrument, instrument_root, realized_pnl, unrealized_pnl, restarted_at,
      market_position, position_quantity, trades_this_run,
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
      item ->> 'marketPosition',
      ((item ->> 'positionQuantity')::numeric)::integer,
      ((item ->> 'tradesThisRun')::numeric)::integer,
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
        market_position = excluded.market_position,
        position_quantity = excluded.position_quantity,
        trades_this_run = excluded.trades_this_run,
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

-- Step 56's rule: the function carries its own grants. PostgreSQL keeps the
-- existing ACL across CREATE OR REPLACE, so these restate the end state rather
-- than trusting what step 57 left: nothing for public, anon or authenticated,
-- EXECUTE for the service role the ingest route runs as.
revoke all on function public.record_algorithm_live_sample(uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_algorithm_live_sample(uuid, timestamptz, jsonb) to service_role;

commit;
