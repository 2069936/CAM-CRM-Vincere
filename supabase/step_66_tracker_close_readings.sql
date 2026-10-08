-- Step 66: what the tracker said about each account just before the close was
-- captured, pinned when the close is finalized, so the two can be compared.
--
-- WHY 66. 63 and 64 (agent 1.2.1 position columns on algorithm_live_samples)
-- are applied. 65 (account observations) is in flight on another branch and
-- keeps its number. 54 stays a deliberate gap. The run order is 63, 64, 65, 66
-- and this file depends on neither 64 nor 65: it reads step 57's columns of
-- algorithm_live_samples only.
--
-- WHAT THIS IS FOR.
--
-- The desk has two readings of the same account on the same day and no way to
-- put them side by side. The account tracker (step 55) says what NinjaTrader
-- shows at 16:20; the close (persist_auto_daily_import) says what the day made
-- at 16:30. When they disagree the question is immediate: did a position settle
-- at the close, did NinjaTrader restart and zero its figure, did a strategy run
-- that the close does not show, is this account on a different connection than
-- the one the CRM thinks. Today nobody can ask, because step 55 keeps the LAST
-- sample only and by the time anybody looks the reading at the close is gone.
--
-- TWO TABLES, AND NEITHER COPIES THE CLOSE.
--
--   * account_live_sample_history: the samples the fleet already sends, kept as
--     RUN LENGTHS. A row is one value run of one account on one machine: the
--     reading, when it was first seen, when it was last seen, how many samples
--     said it. Ten minute samples of a flat account are one row; a day of
--     trading is a handful. Retention is short (history_retention_days, 5) and
--     device scoped, in the shape of step 55's own sweep. No agent change: the
--     trigger reads what record_account_live_sample already upserts.
--
--   * tracker_close_readings: one row per (close, account) holding the TRACKER
--     side only, plus the two clocks. It is written when a close batch is
--     finalized as processed or incomplete, from the history, picking the run in
--     force at the capture plus a short grace. The close side (account_snapshots,
--     strategy_snapshots) is never copied: the browser joins it at read time, so
--     a manual re-upload or a tolerance edit never leaves a stale verdict and
--     there is no rebuild to run. The verdict words live in
--     src/domain/trackerCloseComparison.js, not here.
--
-- WHY THE PIN IS A TRIGGER ON ingest_batches AND NOT A NEW FINALIZE FUNCTION.
-- finalize_ingest_batch (step 28) is the one UPDATE that moves a batch to
-- processed or incomplete, and it is reached from the daily route and from the
-- reprocess tool alike, through v2 and v3. Replacing a fourth copy of it would
-- be a fourth copy of the lease rules. An AFTER trigger on the transition sees
-- every path and changes none of them. `UPDATE OF status, daily_import_id` fires
-- even when the value is unchanged (measured on PostgreSQL 18), so the body
-- compares OLD and NEW itself.
--
-- A FAULT HERE NEVER FAILS A SAMPLE OR A CLOSE. Both triggers swallow every
-- error into a WARNING. The tracker's 503 rule and the close's finalize are the
-- desk's working day; this is a comparison beside them. The audit row carries
-- `historyRowsSeen` and `liveRowsSeen` so a silent history fault reads as
-- "live rows present, history empty" rather than "no sample arrived".
--
-- WHAT A MANUAL CLOSE GETS. Nothing automatic in this step. A close uploaded by
-- hand is written by the browser through PostgREST and never touches
-- ingest_batches, so no trigger fires. record_tracker_close_readings(import)
-- can be called for it by hand and then uses the client's machine schedule as
-- the capture time, with close_time_basis 'scheduled'.
--
-- Idempotent and additive: `if not exists` on the tables, the columns and the
-- constraints, `create or replace` on the functions, `drop trigger if exists`
-- before each trigger. No row of any existing table is rewritten.

-- ---------------------------------------------------------------------------
-- The order guard. This file reads step 55's two tables, step 57's readings,
-- step 28's batches and devices, calls step 52's two helpers in its policies,
-- and the browser half of the feature reads strategy_snapshots.ran (step 47).
-- ---------------------------------------------------------------------------
do $step66_guard$
begin
  if to_regclass('public.account_live_samples') is null
    or to_regclass('public.account_tracker_settings') is null
    or to_regprocedure('public.is_manager()') is null
    or to_regprocedure('public.assigned_client_ids()') is null then
    raise exception 'step 66 needs step 55 (account_live_samples) and step 52 (is_manager): run them first';
  end if;
  if to_regclass('public.algorithm_live_samples') is null
    or to_regclass('public.ingest_batches') is null
    or to_regclass('public.ingest_devices') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'strategy_snapshots' and column_name = 'ran'
    ) then
    raise exception 'step 66 needs step 57 (algorithm_live_samples), step 28 (ingest_batches) and step 47 (strategy_snapshots.ran): run them first';
  end if;
end
$step66_guard$;

begin;

-- ---------------------------------------------------------------------------
-- 1. The tunables, on step 55's singleton. No new settings table: one row of
-- desk tuning for the tracker, edited in the SQL editor, reviewed by its CHECKs.
-- Step 55's RPC selects `settings.*` into a rowtype and reads only its own six
-- columns, so these five are invisible to it; only this file's functions read
-- them, through coalesce, so a database whose settings row was deleted still
-- compares with the defaults below.
-- ---------------------------------------------------------------------------
alter table public.account_tracker_settings
  add column if not exists history_retention_days integer not null default 5,
  add column if not exists pre_close_grace_seconds integer not null default 120,
  add column if not exists close_match_tolerance_dollars numeric(12,2) not null default 5.00,
  add column if not exists close_match_tolerance_ratio numeric(6,4) not null default 0.0200,
  add column if not exists max_strategies_per_account integer not null default 50;

do $step66_settings_checks$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.account_tracker_settings'::regclass
      and conname = 'account_tracker_settings_history_retention_check') then
    alter table public.account_tracker_settings
      add constraint account_tracker_settings_history_retention_check
      check (history_retention_days between 1 and 30);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.account_tracker_settings'::regclass
      and conname = 'account_tracker_settings_grace_check') then
    alter table public.account_tracker_settings
      add constraint account_tracker_settings_grace_check
      check (pre_close_grace_seconds between 0 and 600);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.account_tracker_settings'::regclass
      and conname = 'account_tracker_settings_tolerance_dollars_check') then
    alter table public.account_tracker_settings
      add constraint account_tracker_settings_tolerance_dollars_check
      check (close_match_tolerance_dollars between 0 and 10000);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.account_tracker_settings'::regclass
      and conname = 'account_tracker_settings_tolerance_ratio_check') then
    alter table public.account_tracker_settings
      add constraint account_tracker_settings_tolerance_ratio_check
      check (close_match_tolerance_ratio between 0 and 1);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.account_tracker_settings'::regclass
      and conname = 'account_tracker_settings_strategies_per_account_check') then
    alter table public.account_tracker_settings
      add constraint account_tracker_settings_strategies_per_account_check
      check (max_strategies_per_account between 1 and 200);
  end if;
end
$step66_settings_checks$;

comment on column public.account_tracker_settings.history_retention_days is
  'How many days a value run stays in account_live_sample_history. Swept per machine on every accepted sample and per client on every comparison. 1 to 30.';
comment on column public.account_tracker_settings.pre_close_grace_seconds is
  'How long after the capture a reading may still count as the reading at the close. The cutoff is captured_at plus this. 0 to 600.';
comment on column public.account_tracker_settings.close_match_tolerance_dollars is
  'The dollar half of the match tolerance. The browser compares with max(dollars, ratio times the close figure). Tune with: update public.account_tracker_settings set close_match_tolerance_dollars = 10, updated_at = now() where id;';
comment on column public.account_tracker_settings.close_match_tolerance_ratio is
  'The ratio half of the match tolerance, as a fraction of the absolute close figure. 0 to 1.';
comment on column public.account_tracker_settings.max_strategies_per_account is
  'How many strategy readings are pinned beside one account at the close. 1 to 200.';

-- ---------------------------------------------------------------------------
-- 2. The history: one row per value run.
--
-- The reading columns are step 55's, with their checks restated so a hand
-- insert cannot hold what a sample could not. run_state is a plain column here,
-- copied from the sample's generated one, because a generated column cannot be
-- the thing a trigger copies into and the four words are the same.
-- ---------------------------------------------------------------------------
create table if not exists public.account_live_sample_history (
  -- BY DEFAULT, not ALWAYS, for step 57's reason: step 56's probe inserts a
  -- NULL into the first column and must be answered with permission denied.
  id bigint generated by default as identity primary key,
  device_id uuid not null references public.ingest_devices(id) on delete cascade,
  -- The RLS key, copied from the sample, which copied it from the device.
  client_id uuid not null references public.clients(id) on delete cascade,
  account_name text not null,
  connection_name text,
  connected boolean not null,
  status text,
  realized_pnl numeric,
  unrealized_pnl numeric,
  total_pnl numeric,
  strategy_count integer,
  enabled_strategy_count integer,
  run_state text not null,
  first_sampled_at timestamptz not null,
  last_sampled_at timestamptz not null,
  samples integer not null default 1,
  recorded_at timestamptz not null default now(),
  constraint account_live_sample_history_run_unique unique (device_id, account_name, first_sampled_at),
  constraint account_live_sample_history_account_name_check
    check (account_name = btrim(account_name) and length(account_name) between 1 and 64),
  constraint account_live_sample_history_connection_name_check
    check (connection_name is null
      or (connection_name = btrim(connection_name) and length(connection_name) between 1 and 64)),
  constraint account_live_sample_history_status_check
    check (status is null or status ~ '^[A-Za-z][A-Za-z0-9 _-]{0,31}$'),
  constraint account_live_sample_history_counts_check
    check ((strategy_count is null) = (enabled_strategy_count is null)
      and (strategy_count is null
        or (strategy_count >= 0
          and enabled_strategy_count >= 0
          and enabled_strategy_count <= strategy_count))),
  constraint account_live_sample_history_money_check
    check ((realized_pnl is null or abs(realized_pnl) <= 1e12)
      and (unrealized_pnl is null or abs(unrealized_pnl) <= 1e12)
      and (total_pnl is null or abs(total_pnl) <= 1e12)),
  constraint account_live_sample_history_run_state_check
    check (run_state in ('unmeasured', 'no_strategies', 'running', 'idle')),
  constraint account_live_sample_history_span_check
    check (last_sampled_at >= first_sampled_at),
  constraint account_live_sample_history_samples_check
    check (samples >= 1)
);

-- The comparison reads a client's runs around one day; the trigger reads the
-- latest run of one account on one machine; the sweep deletes by machine and age.
create index if not exists idx_account_live_sample_history_client
  on public.account_live_sample_history (client_id, last_sampled_at desc);
create index if not exists idx_account_live_sample_history_run
  on public.account_live_sample_history (device_id, account_name, first_sampled_at desc);
create index if not exists idx_account_live_sample_history_sweep
  on public.account_live_sample_history (device_id, last_sampled_at);

comment on table public.account_live_sample_history is
  'Run length history of account_live_samples: one row per value run of one account on one paired VPS, with the first and last sampled_at and the count of samples that said it. Written by a trigger on account_live_samples, best effort. Rows leave by the retention sweep (account_tracker_settings.history_retention_days) and by the cascades from clients and ingest_devices.';

-- ---------------------------------------------------------------------------
-- account_live_sample_history_record: the trigger body.
--
-- The latest run for (device, account) is extended when every compared field is
-- the same and the new reading is strictly newer; otherwise a new run opens.
-- reported_at is NOT a compared field, it moves on every upsert. An EQUAL
-- sampled_at is a no op: step 55's upsert accepts an equal sampled_at (its
-- guard is >=), so a retried report reaches this trigger with the row rewritten
-- and nothing newer in it, and counting it would inflate `samples` on every
-- retry. A strictly older reading never reaches here because the upsert
-- refuses it.
--
-- The whole body is one exception block. A history fault is a WARNING in the
-- log and the sample lands exactly as before this step existed.
--
-- v_latest is a RECORD, not the table's rowtype, on purpose. plpgsql resolves a
-- declared rowtype when it COMPILES the function, which is the first call of
-- each backend (every new PostgREST or Supavisor connection) and happens outside
-- the exception block below, so `v_latest public.account_live_sample_history`
-- would let a missing history table raise into step 55's RPC on a cold backend
-- while a warm one caught it. Field access on a record is resolved at run time,
-- inside the block. The fresh cluster test in step_66's test file is the witness.
-- ---------------------------------------------------------------------------
create or replace function public.account_live_sample_history_record()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_latest record;
  v_extended boolean := false;
  v_retention integer;
begin
  begin
    select run.* into v_latest
    from public.account_live_sample_history as run
    where run.device_id = new.device_id
      and run.account_name = new.account_name
    order by run.first_sampled_at desc
    limit 1;

    if found then
      if v_latest.last_sampled_at >= new.sampled_at then
        -- A replay, or the reported_at of an already recorded reading moving.
        return null;
      end if;
      if v_latest.client_id = new.client_id
        and v_latest.connection_name is not distinct from new.connection_name
        and v_latest.connected = new.connected
        and v_latest.status is not distinct from new.status
        and v_latest.realized_pnl is not distinct from new.realized_pnl
        and v_latest.unrealized_pnl is not distinct from new.unrealized_pnl
        and v_latest.total_pnl is not distinct from new.total_pnl
        and v_latest.strategy_count is not distinct from new.strategy_count
        and v_latest.enabled_strategy_count is not distinct from new.enabled_strategy_count then
        update public.account_live_sample_history
        set last_sampled_at = new.sampled_at,
            samples = samples + 1
        where id = v_latest.id;
        v_extended := true;
      end if;
    end if;

    if not v_extended then
      insert into public.account_live_sample_history (
        device_id, client_id, account_name, connection_name, connected, status,
        realized_pnl, unrealized_pnl, total_pnl, strategy_count, enabled_strategy_count,
        run_state, first_sampled_at, last_sampled_at, samples
      ) values (
        new.device_id, new.client_id, new.account_name, new.connection_name, new.connected, new.status,
        new.realized_pnl, new.unrealized_pnl, new.total_pnl, new.strategy_count, new.enabled_strategy_count,
        new.run_state, new.sampled_at, new.sampled_at, 1
      )
      on conflict (device_id, account_name, first_sampled_at) do nothing;
    end if;

    -- Device scoped, bounded by a settings column, in step 55's shape, and run
    -- on every accepted reading, extended or new, so a machine whose accounts
    -- sit flat all night still sweeps its own old runs. A missing settings row
    -- reads as the default.
    select settings.history_retention_days into v_retention
    from public.account_tracker_settings as settings
    where settings.id;
    delete from public.account_live_sample_history as run
    where run.device_id = new.device_id
      and run.last_sampled_at < clock_timestamp() - make_interval(days => coalesce(v_retention, 5));
  exception when others then
    raise warning 'step 66: account_live_sample_history_record skipped a sample for device % account %: % (%)',
      new.device_id, new.account_name, sqlerrm, sqlstate;
  end;
  return null;
end;
$function$;

revoke all on function public.account_live_sample_history_record() from public, anon, authenticated;

drop trigger if exists account_live_sample_history_record on public.account_live_samples;
create trigger account_live_sample_history_record
  after insert or update on public.account_live_samples
  for each row execute function public.account_live_sample_history_record();

-- ---------------------------------------------------------------------------
-- 3. The pinned readings: the tracker side of one close, per account.
--
-- No close money, no segment, no total. `source` says where the reading came
-- from: 'crm_history' is this file; 'agent_close' is reserved for the day the
-- agent embeds its last sample in the close itself; 'none' is an account the
-- close lists that the history never saw before the cutoff, kept as a row so
-- absence is a stored fact rather than a missing one.
-- ---------------------------------------------------------------------------
create table if not exists public.tracker_close_readings (
  id bigint generated by default as identity primary key,
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- The machine the reading came from, or NULL for a 'none' row without a batch.
  device_id uuid references public.ingest_devices(id) on delete set null,
  trading_date date not null,
  -- The close's spelling when the close lists it, the tracker's otherwise.
  account_name text not null,
  source text not null,
  connection_name text,
  connected boolean,
  status text,
  realized_pnl numeric,
  unrealized_pnl numeric,
  total_pnl numeric,
  strategy_count integer,
  enabled_strategy_count integer,
  run_state text,
  -- The reading's clock: the last sample of the picked run, capped at the cutoff.
  sampled_at timestamptz,
  -- When that run began: how long the reading had held.
  reading_since timestamptz,
  -- A connected account whose realized figure fell from far outside the dollar
  -- tolerance to inside it during the day: NinjaTrader restarted, most likely.
  reset_seen boolean not null default false,
  -- The first run that began after the cutoff, NULL when none did on that day.
  -- This is what makes "the first reading was after the capture" a stored fact.
  next_sampled_at timestamptz,
  -- [{strategyId, strategyName, algorithm, instrument, realizedPnl, unrealizedPnl, restartedAt, sampledAt}]
  strategies jsonb not null default '[]'::jsonb,
  close_batch_id uuid references public.ingest_batches(id) on delete set null,
  close_captured_at timestamptz not null,
  -- 'captured' from the batch, 'scheduled' from the machine's schedule when
  -- there is no batch (a manual close pinned by hand).
  close_time_basis text not null,
  grace_seconds integer not null,
  stale_seconds integer not null,
  compared_at timestamptz not null default now(),
  constraint tracker_close_readings_import_account_unique unique (daily_import_id, account_name),
  constraint tracker_close_readings_account_name_check
    check (account_name = btrim(account_name) and length(account_name) between 1 and 200),
  constraint tracker_close_readings_source_check
    check (source in ('crm_history', 'agent_close', 'none')),
  constraint tracker_close_readings_basis_check
    check (close_time_basis in ('captured', 'scheduled')),
  -- A reading has a clock and a connection state; an absence has neither.
  constraint tracker_close_readings_reading_check
    check ((source = 'none' and sampled_at is null and reading_since is null and connected is null)
      or (source <> 'none' and sampled_at is not null and reading_since is not null and connected is not null)),
  constraint tracker_close_readings_run_state_check
    check (run_state is null or run_state in ('unmeasured', 'no_strategies', 'running', 'idle')),
  constraint tracker_close_readings_counts_check
    check ((strategy_count is null) = (enabled_strategy_count is null)
      and (strategy_count is null
        or (strategy_count >= 0
          and enabled_strategy_count >= 0
          and enabled_strategy_count <= strategy_count))),
  constraint tracker_close_readings_money_check
    check ((realized_pnl is null or abs(realized_pnl) <= 1e12)
      and (unrealized_pnl is null or abs(unrealized_pnl) <= 1e12)
      and (total_pnl is null or abs(total_pnl) <= 1e12)),
  constraint tracker_close_readings_strategies_check
    check (jsonb_typeof(strategies) = 'array'),
  constraint tracker_close_readings_seconds_check
    check (grace_seconds >= 0 and stale_seconds > 0)
);

create index if not exists idx_tracker_close_readings_client
  on public.tracker_close_readings (client_id, trading_date desc);
create index if not exists idx_tracker_close_readings_import
  on public.tracker_close_readings (daily_import_id);

comment on table public.tracker_close_readings is
  'The tracker side of one close, per account, pinned by record_tracker_close_readings when a close batch is finalized as processed or incomplete. Holds the reading in force at the capture plus the grace, the strategy readings of the day, and the two clocks. Never the close money: the browser joins account_snapshots and strategy_snapshots at read time and src/domain/trackerCloseComparison.js says the verdict. Replaced wholesale per daily import on every comparison.';

-- ---------------------------------------------------------------------------
-- record_tracker_close_readings: the pin.
--
-- Clocks. captured_at comes from the finalized batch (basis 'captured'). With
-- no batch, from the client's latest active machine schedule, trading_date
-- plus schedule_time in schedule_timezone (basis 'scheduled'); with no machine
-- at all, 16:30 America/New_York, which is the column default. cutoff is
-- captured_at plus pre_close_grace_seconds. day_start is the trading date's
-- midnight in that zone, day_end one day on.
--
-- The pick, per account, case insensitively: the run with the greatest
-- first_sampled_at that is at or before the cutoff and whose last_sampled_at is
-- at or after day_start. sampled_at is least(last_sampled_at, cutoff): the
-- moment the reading is known to have held at or before the close. A run that
-- ended long before the cutoff is still the pick, and the browser calls it
-- stale against stale_sample_seconds.
--
-- The names are the union of the close's account_snapshots and the picked
-- readings, so an account the tracker saw and the close does not list is
-- pinned, and an account the close lists and the tracker never saw is a 'none'
-- row. Delete then insert, wholesale, so a second close of the same day or a
-- direct call replaces rather than accumulates.
--
-- Strategies are algorithm_live_samples sampled on the trading date, matched by
-- client and account name, capped at max_strategies_per_account, with their own
-- sampledAt so the browser can see when. That table keeps the last reading per
-- instance and sweeps at two days, so a close pinned a week later has none.
--
-- Everything is inside one exception block. A fault is a WARNING naming the
-- import and the error, the rows are not left half written, and the finalize
-- that fired the trigger succeeds exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.record_tracker_close_readings(p_daily_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_daily public.daily_imports;
  v_batch public.ingest_batches;
  v_device public.ingest_devices;
  v_settings public.account_tracker_settings;
  v_timezone text := 'America/New_York';
  v_schedule time := '16:30:00';
  v_captured_at timestamptz;
  v_basis text;
  v_grace integer;
  v_stale integer;
  v_tolerance numeric;
  v_max_strategies integer;
  v_history_retention integer;
  v_cutoff timestamptz;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_pinned integer := 0;
  v_in_close integer := 0;
  v_from_history integer := 0;
  v_without integer := 0;
  v_after_close integer := 0;
  v_resets integer := 0;
  v_strategies integer := 0;
  v_history_seen integer := 0;
  v_live_seen integer := 0;
  v_counts jsonb;
begin
  begin
    select daily.* into v_daily
    from public.daily_imports as daily
    where daily.id = p_daily_import_id;
    if not found then
      return jsonb_build_object('recorded', false, 'reason', 'no_daily_import', 'dailyImportId', p_daily_import_id);
    end if;

    select settings.* into v_settings
    from public.account_tracker_settings as settings
    where settings.id;
    v_grace := coalesce(v_settings.pre_close_grace_seconds, 120);
    v_stale := coalesce(v_settings.stale_sample_seconds, 1500);
    v_tolerance := coalesce(v_settings.close_match_tolerance_dollars, 5);
    v_max_strategies := coalesce(v_settings.max_strategies_per_account, 50);
    v_history_retention := coalesce(v_settings.history_retention_days, 5);

    -- The close batch: the one that finalized this import. After a second close
    -- the earlier batch still names the import with status 'replaced', so only
    -- a finished one counts, the import's own source batch first.
    select batch.* into v_batch
    from public.ingest_batches as batch
    where batch.daily_import_id = p_daily_import_id
      and batch.status in ('processed', 'incomplete')
    order by (batch.id is not distinct from v_daily.source_batch_id) desc,
             batch.processed_at desc nulls last,
             batch.captured_at desc
    limit 1;

    if found then
      v_captured_at := v_batch.captured_at;
      v_basis := 'captured';
      select device.* into v_device
      from public.ingest_devices as device
      where device.id = v_batch.device_id;
    else
      v_basis := 'scheduled';
      -- The client's latest active machine, the way ingest-status.js picks one.
      select device.* into v_device
      from public.ingest_devices as device
      where device.client_id = v_daily.client_id
        and device.status = 'active'
        and device.revoked_at is null
      order by device.created_at desc
      limit 1;
    end if;
    if v_device.id is not null then
      v_timezone := coalesce(v_device.schedule_timezone, v_timezone);
      v_schedule := coalesce(v_device.schedule_time, v_schedule);
    end if;
    if v_captured_at is null then
      v_captured_at := (v_daily.trading_date + v_schedule) at time zone v_timezone;
    end if;
    v_cutoff := v_captured_at + make_interval(secs => v_grace);
    v_day_start := v_daily.trading_date::timestamp at time zone v_timezone;
    v_day_end := v_day_start + interval '1 day';

    delete from public.tracker_close_readings where daily_import_id = p_daily_import_id;

    with candidates as (
      select run.*, lower(run.account_name) as key
      from public.account_live_sample_history as run
      where run.client_id = v_daily.client_id
        and run.last_sampled_at >= v_day_start
        and run.first_sampled_at <= v_cutoff
    ),
    names as (
      select named.key,
             coalesce(max(named.account_name) filter (where named.in_close), max(named.account_name)) as account_name,
             bool_or(named.in_close) as in_close
      from (
        select lower(btrim(snapshot.account_name)) as key, btrim(snapshot.account_name) as account_name, true as in_close
        from public.account_snapshots as snapshot
        where snapshot.daily_import_id = p_daily_import_id
          and btrim(snapshot.account_name) <> ''
        union all
        select candidate.key, candidate.account_name, false
        from candidates as candidate
      ) as named
      group by named.key
    ),
    picked as (
      select distinct on (candidate.key) candidate.*
      from candidates as candidate
      order by candidate.key, candidate.first_sampled_at desc, candidate.last_sampled_at desc
    ),
    nexts as (
      select lower(run.account_name) as key, min(run.first_sampled_at) as next_sampled_at
      from public.account_live_sample_history as run
      where run.client_id = v_daily.client_id
        and run.first_sampled_at > v_cutoff
        and run.first_sampled_at < v_day_end
      group by lower(run.account_name)
    ),
    resets as (
      select stepped.key,
             bool_or(stepped.connected
               and stepped.prev_realized is not null
               and stepped.realized_pnl is not null
               and abs(stepped.prev_realized) > 10 * v_tolerance
               and abs(stepped.realized_pnl) <= v_tolerance) as reset_seen
      from (
        select candidate.key, candidate.connected, candidate.realized_pnl,
               lag(candidate.realized_pnl) over (
                 partition by candidate.key
                 order by candidate.first_sampled_at, candidate.last_sampled_at) as prev_realized
        from candidates as candidate
      ) as stepped
      group by stepped.key
    ),
    instances as (
      select lower(live.account_name) as key,
             row_number() over (
               partition by lower(live.account_name)
               order by live.strategy_name, live.instrument, live.strategy_id) as ordinal,
             jsonb_build_object(
               'strategyId', live.strategy_id,
               'strategyName', live.strategy_name,
               'algorithm', live.algorithm,
               'instrument', live.instrument,
               'realizedPnl', live.realized_pnl,
               'unrealizedPnl', live.unrealized_pnl,
               'restartedAt', live.restarted_at,
               'sampledAt', live.sampled_at) as item
      from public.algorithm_live_samples as live
      where live.client_id = v_daily.client_id
        and live.sampled_at >= v_day_start
        and live.sampled_at < v_day_end
    ),
    strategies as (
      select instance.key, jsonb_agg(instance.item order by instance.ordinal) as strategies
      from instances as instance
      where instance.ordinal <= v_max_strategies
      group by instance.key
    )
    insert into public.tracker_close_readings (
      daily_import_id, client_id, device_id, trading_date, account_name, source,
      connection_name, connected, status, realized_pnl, unrealized_pnl, total_pnl,
      strategy_count, enabled_strategy_count, run_state,
      sampled_at, reading_since, reset_seen, next_sampled_at, strategies,
      close_batch_id, close_captured_at, close_time_basis, grace_seconds, stale_seconds, compared_at
    )
    select p_daily_import_id,
           v_daily.client_id,
           coalesce(pick.device_id, v_batch.device_id),
           v_daily.trading_date,
           named.account_name,
           case when pick.key is not null then 'crm_history' else 'none' end,
           pick.connection_name, pick.connected, pick.status,
           pick.realized_pnl, pick.unrealized_pnl, pick.total_pnl,
           pick.strategy_count, pick.enabled_strategy_count, pick.run_state,
           case when pick.key is not null then least(pick.last_sampled_at, v_cutoff) end,
           pick.first_sampled_at,
           coalesce(reset.reset_seen, false),
           next.next_sampled_at,
           coalesce(instance.strategies, '[]'::jsonb),
           v_batch.id, v_captured_at, v_basis, v_grace, v_stale, v_now
    from names as named
    left join picked as pick on pick.key = named.key
    left join nexts as next on next.key = named.key
    left join resets as reset on reset.key = named.key
    left join strategies as instance on instance.key = named.key;

    select count(*),
           count(*) filter (where pinned.source = 'crm_history'),
           count(*) filter (where pinned.source = 'none'),
           count(*) filter (where pinned.source = 'none' and pinned.next_sampled_at is not null),
           count(*) filter (where pinned.reset_seen),
           coalesce(sum(jsonb_array_length(pinned.strategies)), 0)
      into v_pinned, v_from_history, v_without, v_after_close, v_resets, v_strategies
    from public.tracker_close_readings as pinned
    where pinned.daily_import_id = p_daily_import_id;

    select count(*) into v_in_close
    from public.account_snapshots as snapshot
    where snapshot.daily_import_id = p_daily_import_id
      and btrim(snapshot.account_name) <> '';
    select count(*) into v_history_seen
    from public.account_live_sample_history as run
    where run.client_id = v_daily.client_id
      and run.last_sampled_at >= v_day_start
      and run.first_sampled_at <= v_cutoff;
    select count(*) into v_live_seen
    from public.account_live_samples as sample
    where sample.client_id = v_daily.client_id;

    -- The client's history, swept past the retention window. Cheap, bounded,
    -- and the second of the two places a run ever leaves.
    delete from public.account_live_sample_history as run
    where run.client_id = v_daily.client_id
      and run.last_sampled_at < v_now - make_interval(days => v_history_retention);

    v_counts := jsonb_build_object(
      'recorded', true,
      'clientId', v_daily.client_id,
      'dailyImportId', p_daily_import_id,
      'tradingDate', v_daily.trading_date,
      'closeBatchId', v_batch.id,
      'deviceId', v_device.id,
      'closeCapturedAt', v_captured_at,
      'closeTimeBasis', v_basis,
      'cutoffAt', v_cutoff,
      'graceSeconds', v_grace,
      'staleSeconds', v_stale,
      'accountsPinned', v_pinned,
      'accountsInClose', v_in_close,
      'accountsFromHistory', v_from_history,
      'accountsWithoutReading', v_without,
      'accountsReadAfterClose', v_after_close,
      'resetsSeen', v_resets,
      'strategiesPinned', v_strategies,
      'historyRowsSeen', v_history_seen,
      'liveRowsSeen', v_live_seen
    );

    -- One row per comparison, machine action, in finalize_ingest_batch's shape.
    -- entity_type 'daily_import' is new here: the thing compared is the close.
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (null, 'daily_import', p_daily_import_id, 'tracker_close_compared', v_counts - 'recorded');

    return v_counts;
  exception when others then
    raise warning 'step 66: tracker close comparison skipped for daily import %: % (%)',
      p_daily_import_id, sqlerrm, sqlstate;
    return jsonb_build_object(
      'recorded', false,
      'reason', 'error',
      'dailyImportId', p_daily_import_id,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end;
$function$;

revoke all on function public.record_tracker_close_readings(uuid) from public, anon, authenticated;
grant execute on function public.record_tracker_close_readings(uuid) to service_role;

comment on function public.record_tracker_close_readings(uuid) is
  'Pins the tracker side of one close into tracker_close_readings, replacing the import''s rows, and writes one audit_logs row (entity_type daily_import, action tracker_close_compared). Fired by the trigger on ingest_batches when a batch becomes processed or incomplete; callable by hand for a manual close, which then uses the machine schedule as the capture time. Never raises: a fault is a WARNING and {recorded: false}.';

-- ---------------------------------------------------------------------------
-- tracker_close_on_batch: the transition.
--
-- `UPDATE OF status, daily_import_id` fires on any UPDATE that names either
-- column, changed or not, so the body asks. finalize_ingest_batch sets both in
-- one statement, which is one firing per finalize; v2 and v3 then update other
-- columns, which fire nothing. claim ('processing'), persist ('replaced' on the
-- prior batch), release ('received') and finalize's own late_closed_day,
-- replaced and failed all return here without a pin.
-- ---------------------------------------------------------------------------
create or replace function public.tracker_close_on_batch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.status in ('processed', 'incomplete')
    and new.daily_import_id is not null
    and (tg_op = 'INSERT'
      or old.status is distinct from new.status
      or old.daily_import_id is distinct from new.daily_import_id) then
    perform public.record_tracker_close_readings(new.daily_import_id);
  end if;
  return null;
end;
$function$;

revoke all on function public.tracker_close_on_batch() from public, anon, authenticated;

drop trigger if exists tracker_close_on_batch on public.ingest_batches;
create trigger tracker_close_on_batch
  after insert or update of status, daily_import_id on public.ingest_batches
  for each row execute function public.tracker_close_on_batch();

-- ---------------------------------------------------------------------------
-- 4. Row level security and grants, step 55's shape, this file's own.
--
-- `revoke all` then `grant select`: a table born in public holds the DML verbs
-- for authenticated under step 56's default privileges and all eight under
-- Supabase's own, and this file must not depend on which. Both tables also
-- have a row in step 56's exception table, so a re-run of 56 grants SELECT and
-- nothing more. The write denials are RESTRICTIVE so they survive a re-run of
-- step 52, whose loop gives every client_id table a permissive `for all`.
-- ---------------------------------------------------------------------------
alter table public.account_live_sample_history enable row level security;
alter table public.tracker_close_readings enable row level security;

revoke all on public.account_live_sample_history from anon, authenticated;
revoke all on public.tracker_close_readings from anon, authenticated;
grant select on public.account_live_sample_history to authenticated;
grant select on public.tracker_close_readings to authenticated;

do $step66_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_sample_history'
      and policyname = 'cam sees its own clients'
  ) then
    create policy "cam sees its own clients"
      on public.account_live_sample_history
      for select
      to authenticated
      using ((select public.is_manager())
        or client_id in (select public.assigned_client_ids()));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_sample_history'
      and policyname = 'account_live_sample_history deny browser writes'
  ) then
    create policy "account_live_sample_history deny browser writes"
      on public.account_live_sample_history
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_sample_history'
      and policyname = 'account_live_sample_history deny browser deletes'
  ) then
    create policy "account_live_sample_history deny browser deletes"
      on public.account_live_sample_history
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'tracker_close_readings'
      and policyname = 'cam sees its own clients'
  ) then
    create policy "cam sees its own clients"
      on public.tracker_close_readings
      for select
      to authenticated
      using ((select public.is_manager())
        or client_id in (select public.assigned_client_ids()));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'tracker_close_readings'
      and policyname = 'tracker_close_readings deny browser writes'
  ) then
    create policy "tracker_close_readings deny browser writes"
      on public.tracker_close_readings
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'tracker_close_readings'
      and policyname = 'tracker_close_readings deny browser deletes'
  ) then
    create policy "tracker_close_readings deny browser deletes"
      on public.tracker_close_readings
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;
end
$step66_policies$;

commit;

-- What this leaves: two new tables, both with row level security, and no table
-- in public open. The same check steps 43 to 57 end with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 66 left % table(s) without row level security', n;
  end if;
end $$;
