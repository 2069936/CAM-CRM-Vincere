-- Step 45: a door on the ingest endpoint, and a stopwatch on what comes
-- through it.
--
-- WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
--
-- Every paired VPS captures at the same New York minute and its uploader loop
-- runs every ten seconds, so the fleet arrives together rather than spread out.
-- One upload writes roughly 90 rows across account_snapshots,
-- strategy_snapshots, orders, executions, daily_imports and operational_flags,
-- plus a storage object and its audit rows.
--
-- At today's single digit fleet that burst is about 900 rows and saturates
-- nothing. THIS IS NOT THE CAUSE OF THE SLOWNESS MEASURED ON 2026-09-17 AND
-- 18: that was all afternoon, on single row reads of a 202 row table taking up
-- to twenty seconds, with statement timeouts on a 14k row table and slow auth
-- and storage. That is a starved instance, not a 16:30 burst, and nothing in
-- this file would have helped it. The burst is a cliff at the desk's target of
-- 139 clients, which is where it is worth having a door before it arrives.
--
-- THE REASON A SERVER SIDE DOOR IS WORTH BUILDING AT ALL: every agent already
-- deployed (1.0.3, 1.0.4, 1.0.5) honours a 429 with Retry-After.
-- collector/src/Vincere.AutoExport.Agent/Crm/RetryPolicy.cs retries on 408,
-- 429, any 5xx and on 409 capture_processing, uses the Retry-After header when
-- present, caps the wait at two minutes, and tries up to six times inside one
-- upload call; after that the item stays queued and the ten second loop tries
-- again. Nothing is lost and no VPS has to be updated for this to work.
--
-- 'at_capacity' IS NOT 'busy', AND THE TWO ARE KEPT APART EVERYWHERE. 'busy'
-- means this capture is already being processed, which is a fact about one
-- capture. 'at_capacity' means the server is full, which is a fact about the
-- server. Folding them together would make the desk unable to tell a duplicate
-- upload from a shed one, which is the only measurement that says whether the
-- cap is set right.

begin;

-- THE CAP, IN A TABLE, SO IT CAN BE TUNED WITHOUT A DEPLOY.
--
-- One row. The cap is not a constant in a function body because the number
-- below is a judgement about an instance size, and the instance size changes
-- with a click while a function change needs this file to be edited, reviewed
-- and run again.
--
-- HOW THE DEFAULT OF 4 WAS CHOSEN. The project runs on a Supabase Micro, whose
-- Postgres is sized for about 60 connections with the pooler handing out a
-- small fraction of them. Every other thing the CRM does shares that pool: the
-- desk's own screens, the admin endpoints, auth and storage. One in flight
-- ingest is not one cheap statement, it is a storage write followed by a
-- multi statement persist that holds its connection for the whole of it, which
-- on the bad afternoon was measured in seconds rather than milliseconds.
--
-- Four leaves the large majority of the pool for the people using the app,
-- keeps roughly 360 rows in flight at once rather than the 12,510 a 139 machine
-- fleet would arrive with, and is still four times the throughput the desk
-- needs to absorb 139 uploads inside the 25 minutes between the capture and its
-- cutoff. It is deliberately a floor rather than a ceiling: raise it here when
-- the instance is bigger and the number is measured, not guessed.
create table if not exists public.ingest_admission_settings (
  -- Singleton by construction: one row, addressed without knowing its id.
  id boolean primary key default true,
  max_concurrent_ingests integer not null default 4,
  -- THE SPREAD, WHICH IS THE OTHER HALF OF THE DOOR. A constant Retry-After
  -- sends every machine that was turned away back at the same second, which
  -- reproduces the burst the door exists to break up. The floor is the shortest
  -- wait a turned away caller gets; the spread is how far apart two callers
  -- turned away in the same second can land.
  retry_after_floor_seconds integer not null default 20,
  retry_after_spread_seconds integer not null default 90,
  updated_at timestamptz not null default now(),
  constraint ingest_admission_settings_singleton check (id),
  constraint ingest_admission_settings_cap_check
    check (max_concurrent_ingests between 1 and 100),
  -- 120 SECONDS IS NOT ARBITRARY. RetryPolicy.MaximumDelay in the deployed
  -- agent caps the honoured Retry-After at two minutes, so a longer one is
  -- silently shortened and the server would be measuring a spread it is not
  -- getting. The constraint keeps the tuning inside what the fleet obeys.
  constraint ingest_admission_settings_retry_window_check
    check (retry_after_floor_seconds >= 1
      and retry_after_spread_seconds >= 1
      and retry_after_floor_seconds + retry_after_spread_seconds <= 120)
);

insert into public.ingest_admission_settings (id) values (true)
on conflict (id) do nothing;

-- WHAT THE DOOR AND THE STOPWATCH WRITE ON THE BATCH.
--
-- `admission_deferrals` counts how many times this capture was turned away
-- before it was let in. It lives on the batch rather than in an events table
-- because the shed and the upload it belongs to are the same fact, and because
-- a row per shed would add writes in exactly the minute the server said it was
-- full.
--
-- `stage_durations_ms` and `ingest_duration_ms` are the stopwatch. They are
-- written once, by the finalize path, so that the next time somebody asks
-- whether the ingest is slow there is an answer instead of an afternoon of
-- inference.
alter table public.ingest_batches
  add column if not exists admission_deferrals integer not null default 0,
  add column if not exists stage_durations_ms jsonb,
  add column if not exists ingest_duration_ms integer;

-- Named CHECK constraints do not converge through ADD COLUMN IF NOT EXISTS, so
-- they are dropped and recreated the way step 28 recreates its lifecycle check.
alter table public.ingest_batches
  drop constraint if exists ingest_batches_admission_deferrals_check;
alter table public.ingest_batches
  add constraint ingest_batches_admission_deferrals_check
  check (admission_deferrals >= 0);

alter table public.ingest_batches
  drop constraint if exists ingest_batches_ingest_duration_check;
alter table public.ingest_batches
  add constraint ingest_batches_ingest_duration_check
  check (ingest_duration_ms is null or ingest_duration_ms >= 0);

alter table public.ingest_batches
  drop constraint if exists ingest_batches_stage_durations_check;
alter table public.ingest_batches
  add constraint ingest_batches_stage_durations_check
  check (stage_durations_ms is null or jsonb_typeof(stage_durations_ms) = 'object');

-- The door counts live in flight work on every claim, so the count has to be an
-- index scan over a handful of rows rather than a scan of the batch table. The
-- partial index holds only the rows that are being processed right now, which
-- is at most the cap plus whatever leases are expiring.
create index if not exists idx_ingest_batches_in_flight
  on public.ingest_batches (processing_lease_expires_at)
  where status = 'processing';

-- HOW FULL THE SERVER IS, AND WHEN THIS CALLER SHOULD COME BACK.
--
-- Separated from the claim so both places that grant a lease ask the same
-- question in the same words, and so the answer can be read on its own when
-- somebody wants to know what the door would say right now.
--
-- The wait is derived from the device id and nothing else: two machines turned
-- away in the same second get different waits, and the same machine gets the
-- same wait every time, which is what makes the behaviour reproducible when it
-- is being diagnosed. `%` on a bigint cannot overflow the way abs() of the
-- smallest bigint can, so the sign is folded rather than stripped.
create or replace function public.ingest_admission_decision(
  p_device_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_settings public.ingest_admission_settings;
  v_in_flight integer;
  v_modulus integer;
  v_retry_after integer;
begin
  select settings.* into v_settings
  from public.ingest_admission_settings as settings
  where settings.id
  limit 1;
  if not found then
    -- No row means nobody has tuned anything. The door stays open rather than
    -- inventing a cap: a missing setting must never stop the desk collecting.
    return jsonb_build_object('full', false, 'retry_after_seconds', 0, 'in_flight', 0);
  end if;

  select count(*) into v_in_flight
  from public.ingest_batches as batch
  where batch.status = 'processing'
    and batch.processing_lease_expires_at is not null
    and batch.processing_lease_expires_at > p_now;

  if v_in_flight < v_settings.max_concurrent_ingests then
    return jsonb_build_object('full', false, 'retry_after_seconds', 0, 'in_flight', v_in_flight);
  end if;

  v_modulus := v_settings.retry_after_spread_seconds + 1;
  v_retry_after := v_settings.retry_after_floor_seconds
    + ((hashtextextended(p_device_id::text, 0) % v_modulus) + v_modulus) % v_modulus;
  return jsonb_build_object(
    'full', true,
    'retry_after_seconds', v_retry_after,
    'in_flight', v_in_flight
  );
end;
$function$;

revoke all on function public.ingest_admission_decision(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_admission_decision(uuid, timestamptz) to service_role;

-- claim_ingest_batch_v4: everything v3 does, plus the door.
--
-- THE DOOR IS FOR NEW WORK ONLY, and the order of the branches below is what
-- makes that true. A capture that already finished comes back 'terminal', one
-- already in flight comes back 'busy', one that failed comes back 'failed', and
-- all three answer before the door is consulted at all. A reprocess goes
-- through claim_ingest_batch_reprocess, which this file does not touch. What is
-- left is the two places that hand out a lease for work nobody is doing: a
-- capture whose row exists but is not owned, and a capture arriving for the
-- first time.
--
-- A SHED CAPTURE STILL GETS ITS ROW, in status 'received' with no lease. That
-- is deliberate: the row is what the retry claims a minute later, it is what
-- carries `admission_deferrals` so the desk can count what the door refused,
-- and it is indistinguishable from the row a released lease leaves behind,
-- which the claim already knows how to pick up.
create or replace function public.claim_ingest_batch_v4(
  p_device_id uuid,
  p_capture_id uuid,
  p_trading_date date,
  p_captured_at timestamptz,
  p_schema_version integer,
  p_storage_path text,
  p_content_sha256 text,
  p_byte_count bigint,
  p_row_counts jsonb,
  p_processing_token uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_client_id uuid;
  v_client public.clients;
  v_device public.ingest_devices;
  v_batch public.ingest_batches;
  v_now timestamptz := clock_timestamp();
  v_retry_after integer;
  v_admission jsonb;
begin
  if p_device_id is null or p_capture_id is null or p_trading_date is null
    or p_captured_at is null or p_schema_version is null or p_schema_version <= 0
    or nullif(btrim(p_storage_path), '') is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_byte_count is null or p_byte_count < 0
    or p_row_counts is null
    or not public.ingest_row_counts_are_nonnegative(p_row_counts)
    or p_processing_token is null
    or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid_batch_claim'
      using errcode = '22023';
  end if;

  -- Resolve the parent without a row lock, then use the same client -> device
  -- -> batch order as enrollment/revocation before trusting the relationship.
  select device.client_id into v_client_id
  from public.ingest_devices as device
  where device.id = p_device_id;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;
  select client.* into v_client
  from public.clients as client
  where client.id = v_client_id
  for update;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;
  select device.* into v_device
  from public.ingest_devices as device
  where device.id = p_device_id
  for update;
  if not found or v_device.client_id is distinct from v_client_id
    or v_device.status is distinct from 'active' or v_device.revoked_at is not null then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;
  if p_storage_path is distinct from
    (v_device.client_id::text || '/' || p_trading_date::text || '/' || p_capture_id::text || '.json.gz') then
    raise exception 'invalid_batch_claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text || ':' || p_capture_id::text, 0));

  select batch.* into v_batch
  from public.ingest_batches as batch
  where batch.device_id = p_device_id and batch.capture_id = p_capture_id
  for update;
  if found then
    if v_batch.trading_date is distinct from p_trading_date
      or v_batch.captured_at is distinct from p_captured_at
      or v_batch.schema_version is distinct from p_schema_version
      or v_batch.storage_path is distinct from p_storage_path
      or v_batch.content_sha256 is distinct from p_content_sha256
      or v_batch.byte_count is distinct from p_byte_count
      or v_batch.row_counts is distinct from p_row_counts then
      raise exception 'capture_metadata_conflict' using errcode = 'P0001';
    end if;

    if v_batch.status in ('processed', 'incomplete', 'late_closed_day', 'replaced') then
      return jsonb_build_object('outcome', 'terminal', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
    end if;
    if v_batch.status = 'failed' then
      return jsonb_build_object('outcome', 'failed', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
    end if;
    if v_batch.status = 'processing'
      and v_batch.processing_lease_expires_at is not null
      and v_batch.processing_lease_expires_at > v_now then
      v_retry_after := greatest(1, ceil(extract(epoch from (v_batch.processing_lease_expires_at - v_now)))::integer);
      return jsonb_build_object('outcome', 'busy', 'retry_after_seconds', v_retry_after, 'batch', to_jsonb(v_batch));
    end if;

    v_admission := public.ingest_admission_decision(p_device_id, v_now);
    if (v_admission ->> 'full')::boolean then
      update public.ingest_batches
      set admission_deferrals = admission_deferrals + 1
      where id = v_batch.id
      returning * into v_batch;
      return jsonb_build_object(
        'outcome', 'at_capacity',
        'retry_after_seconds', (v_admission ->> 'retry_after_seconds')::integer,
        'batch', to_jsonb(v_batch)
      );
    end if;

    update public.ingest_batches
    set status = 'processing',
        processing_token = p_processing_token,
        processing_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        processing_attempts = processing_attempts + 1
    where id = v_batch.id
    returning * into v_batch;
    return jsonb_build_object('outcome', 'owned', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
  end if;

  v_admission := public.ingest_admission_decision(p_device_id, v_now);
  if (v_admission ->> 'full')::boolean then
    insert into public.ingest_batches (
      capture_id, device_id, client_id, trading_date, captured_at, status,
      schema_version, storage_path, content_sha256, byte_count, row_counts,
      processing_token, processing_lease_expires_at, processing_attempts,
      admission_deferrals
    ) values (
      p_capture_id, p_device_id, v_device.client_id, p_trading_date, p_captured_at,
      'received', p_schema_version, p_storage_path, p_content_sha256,
      p_byte_count, p_row_counts, null, null, 0, 1
    ) returning * into v_batch;
    return jsonb_build_object(
      'outcome', 'at_capacity',
      'retry_after_seconds', (v_admission ->> 'retry_after_seconds')::integer,
      'batch', to_jsonb(v_batch)
    );
  end if;

  insert into public.ingest_batches (
    capture_id, device_id, client_id, trading_date, captured_at, status,
    schema_version, storage_path, content_sha256, byte_count, row_counts,
    processing_token, processing_lease_expires_at, processing_attempts
  ) values (
    p_capture_id, p_device_id, v_device.client_id, p_trading_date, p_captured_at,
    'processing', p_schema_version, p_storage_path, p_content_sha256,
    p_byte_count, p_row_counts, p_processing_token,
    v_now + make_interval(secs => p_lease_seconds), 1
  ) returning * into v_batch;
  return jsonb_build_object('outcome', 'owned', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
end;
$function$;

revoke all on function public.claim_ingest_batch_v4(
  uuid, uuid, date, timestamptz, integer, text, text, bigint, jsonb, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_ingest_batch_v4(
  uuid, uuid, date, timestamptz, integer, text, text, bigint, jsonb, uuid, integer
) to service_role;

-- V3 KEEPS ITS GRANT, and that is not an oversight. The server that is running
-- right now calls v3, and this migration is meant to be runnable before the
-- deploy that starts calling v4 and after it. Revoking v3 here would take
-- collection down for whichever of the two happens second.

-- finalize_ingest_batch_v3: the stopwatch, written where the batch is already
-- being closed.
--
-- A WRAPPER RATHER THAN A REWRITE. v2 owns the lease and ownership checks that
-- decide whether this caller may finalize at all; repeating them here would be
-- two copies of the rule that keeps a stale worker from closing somebody else's
-- batch. This calls v2, and only then writes the timings, so a bad finalize
-- fails exactly where it failed before and writes no timing at all.
--
-- THE FINALIZE STAGE IS MEASURED HERE AND NOWHERE ELSE, because the endpoint
-- cannot time the call that writes the timing. The other five stages arrive
-- from the endpoint in `p_stage_durations_ms`; this adds its own, and adds it
-- to the total, so `ingest_duration_ms` is the whole of what the upload cost
-- rather than everything except the last step.
create or replace function public.finalize_ingest_batch_v3(
  p_batch_id uuid,
  p_device_id uuid,
  p_client_id uuid,
  p_processing_token uuid,
  p_status text,
  p_daily_import_id uuid,
  p_captured_at timestamptz,
  p_success boolean,
  p_error_code text,
  p_completeness jsonb,
  p_row_counts jsonb,
  p_event_type text,
  p_stage_durations_ms jsonb,
  p_ingest_duration_ms integer
)
returns public.ingest_batches
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_started timestamptz := clock_timestamp();
  v_batch public.ingest_batches;
  v_stages jsonb;
  v_total integer;
  v_finalize_ms integer;
begin
  v_batch := public.finalize_ingest_batch_v2(
    p_batch_id, p_device_id, p_client_id, p_processing_token, p_status,
    p_daily_import_id, p_captured_at, p_success, p_error_code,
    p_completeness, p_row_counts, p_event_type
  );

  -- clock_timestamp() rather than now(): now() is the transaction's start and
  -- would read zero for every finalize ever measured.
  v_finalize_ms := greatest(0,
    (extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer);

  -- A measurement that arrives malformed is dropped, never stored and never
  -- raised. The batch is already closed correctly at this point and the desk
  -- would rather lose one stopwatch reading than lose the close it belongs to.
  v_stages := case
    when p_stage_durations_ms is null then null
    when jsonb_typeof(p_stage_durations_ms) = 'object' then p_stage_durations_ms
    else null
  end;
  v_stages := coalesce(v_stages, '{}'::jsonb)
    || jsonb_build_object('finalize', v_finalize_ms);
  v_total := case when p_ingest_duration_ms is null or p_ingest_duration_ms < 0
    then null else p_ingest_duration_ms + v_finalize_ms end;

  update public.ingest_batches
  set stage_durations_ms = v_stages,
      ingest_duration_ms = coalesce(v_total, ingest_duration_ms)
  where id = p_batch_id
  returning * into v_batch;
  return v_batch;
end;
$function$;

revoke all on function public.finalize_ingest_batch_v3(
  uuid, uuid, uuid, uuid, text, uuid, timestamptz, boolean, text, jsonb, jsonb, text, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.finalize_ingest_batch_v3(
  uuid, uuid, uuid, uuid, text, uuid, timestamptz, boolean, text, jsonb, jsonb, text, jsonb, integer
) to service_role;

-- V2 KEEPS ITS GRANT for the same reason v3 of the claim does: the deployed
-- server calls it today.

-- Row Level Security, in the shape step 28 gives every other auto collection
-- table and step 43 expects of everything else. Nothing in the browser reaches
-- this table; the service role does, and the endpoints run as it.
alter table public.ingest_admission_settings enable row level security;

do $admission_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ingest_admission_settings'
      and policyname = 'ingest_admission_settings deny browser direct access'
  ) then
    create policy "ingest_admission_settings deny browser direct access"
      on public.ingest_admission_settings
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end
$admission_policies$;

commit;

-- What this leaves: the new table has RLS and exactly one policy, and no table
-- in public is open. Same check steps 43 and 44 end with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 45 left % table(s) without row level security', n;
  end if;
end $$;
