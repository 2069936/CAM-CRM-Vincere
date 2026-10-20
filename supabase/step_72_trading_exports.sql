-- Step 72: a Manager asks a VPS for a slim trading export from the CRM, the
-- agent builds it and uploads it straight to private storage, and the Manager
-- downloads it from the CRM.
--
-- WHY 72. 71 is the highest step today. 54 is still a deliberate gap. This
-- file needs step 28 (ingest_devices with status, revoked_at, agent_version
-- and client_id; audit_logs; storage.buckets) and says so if it is missing.
-- It replaces nothing: one new table, one new bucket, seven new functions.
--
-- THE GAP. The desk wants the trading history of many clients' NinjaTrader
-- machines to study how the company's algorithms behave. Today the only way
-- is the Deep Export button in the agent window on each VPS: someone logs into
-- the machine, presses it, and copies a zip of several MB that holds logs,
-- workspaces and the whole database. Agent 1.4.0 and later builds a SLIM export
-- instead (orders, fills, strategy configurations and per trade geometry, for
-- a date range) when the CRM asks for one, and uploads it through a signed
-- upload URL, so the bytes never pass through Vercel. This file is where the
-- request lives, where the agent's progress lands and where the file is kept.
--
-- WHAT THIS FILE ADDS, and only this:
--
--   public.trading_export_requests, one row per export asked of one VPS:
--     id            uuid         the request, and the name of its file
--     device_id     uuid         the VPS (ingest_devices.id)
--     client_id     uuid         its client when the request was made
--     requested_by  uuid         the app user who asked, NULL if since removed
--     requested_at  timestamptz
--     from_date     date         NULL: since the end of this device's last
--                                ready export, resolved when the agent asks
--     to_date       date         NULL: today, on the VPS
--     datasets      text[]       a non empty subset of executions, orders,
--                                strategies, trades, in that order
--     status        text         requested, building, uploading, ready,
--                                failed, cancelled or expired
--     error_code    text         the agent's code for a failure,
--                                ^[a-z][a-z0-9_]{0,63}$; set exactly when
--                                status is failed
--     storage_path  text         deep-exports/<client_id>/<id>.jsonl.gz in the
--                                bucket trading-exports, set when the upload
--                                starts
--     byte_size     bigint       1 to 26214400 (25 MiB), the gzip's size
--     sha256        text         the gzip's SHA-256, 64 lower case hex
--     row_counts    jsonb        {executions, orders, strategies, trades},
--                                each a whole number, all four keys and no
--                                other
--     covered_from  date         the days the file really holds, as the
--     covered_to    date         agent reports them
--     started_at    timestamptz  when the agent first picked it up
--     completed_at  timestamptz  when it became ready or failed
--     expires_at    timestamptz  completed_at + 14 days, for a ready one
--     updated_at    timestamptz  when the row last changed
--   Each rule is a named CHECK, dropped and recreated under its name. At most
--   ONE OPEN request per device (requested, building or uploading), held by a
--   unique partial index. Indexes for the device and its status, the client,
--   the newest first list and the expiry sweep.
--
--   The bucket "trading-exports": private, file size limit 26214400, allowed
--   mime type application/gzip only, and a restrictive storage policy that
--   keeps anon and authenticated out of it whatever else is granted on
--   storage.objects (step 28's shape for ninjatrader-imports).
--
--   Six functions, the state machine, and a seventh they share,
--   trading_export_active_device(device_id), which returns the device row or
--   raises INVALID_INGEST_DEVICE. Every one of the six raises
--   INVALID_TRADING_EXPORT_REQUEST (22023) for an argument outside its rules;
--   the three the agent's routes call raise INVALID_INGEST_DEVICE for a device
--   that is missing, revoked or not active, TRADING_EXPORT_NOT_FOUND for a
--   request that is not this device's (the same answer as one that does not
--   exist), and TRADING_EXPORT_CLOSED for one whose status does not allow the
--   step.
--
--     request_trading_exports(device_ids uuid[], from date, to date,
--       datasets text[], actor uuid) returns integer. 1 to 300 ids. One
--       requested row for each listed device that is active, not revoked and
--       has no open request; one audit row each. Returns how many. Which agent
--       versions can act on a request (1.4.0 and later) is the route's
--       decision, before it calls this, as step 70's request route decides it.
--     cancel_trading_exports(request_ids uuid[], actor uuid) returns
--       table(request_id, object_path). Each listed request that is open
--       becomes cancelled; one audit row each. Ready, failed, cancelled and
--       expired ones are left alone. object_path is set when the agent had
--       started uploading, so the route can remove what landed.
--     claim_trading_export(device_id uuid, agent_version text) returns
--       table(request_id, export_from, export_to, export_datasets). The
--       oldest open request of this device that is requested (it becomes
--       building, started_at set, one audit row) or building or uploading
--       (a poll after an agent restart gets the same one back, nothing is
--       written, and the agent uploads again). export_from is from_date, or
--       when that is NULL the covered_to of this device's last export that
--       reached ready (ready, or expired since), or NULL when there is none:
--       full history. The end day itself is included again, because the last
--       export may have been built in the middle of it. No rows when there
--       is nothing to do.
--     begin_trading_export_upload(device_id uuid, request_id uuid,
--       sha256 text, byte_size bigint) returns text. For this device's own
--       request in building or uploading: records the digest and the size the
--       agent is about to upload, sets uploading and the storage path, and
--       returns the path. Asking again (a retry) replaces the digest and size.
--     complete_trading_export(device_id uuid, request_id uuid, status text,
--       sha256 text, byte_size bigint, row_counts jsonb, covered_from date,
--       covered_to date, error_code text) returns text. ready: only from
--       uploading, and only with the digest and the size the upload declared
--       (the route has already found the object at the path with that size);
--       sets ready, completed_at, expires_at = completed_at + 14 days,
--       row_counts and the covered days. failed: from building or uploading,
--       records error_code. One audit row either way. The same answer again
--       (a retry after a lost response) changes nothing and returns the
--       status. Returns the status.
--     close_trading_exports(request_ids uuid[], actor uuid, reason text)
--       returns table(request_id). reason 'expired': each listed ready
--       request whose expires_at has passed becomes expired (actor may be
--       NULL: nobody did it, time did). reason 'deleted': each listed ready
--       request becomes expired at once (actor required). One audit row each.
--       The route removes the object from storage BEFORE calling this, so a
--       failure in between leaves a row that is still ready and can be
--       closed again, never an object nobody points at.
--
--   Audit rows: entity_type 'trading_export', entity_id the request, actions
--   trading_export.requested, .started, .ready, .failed, .cancelled,
--   .expired, .deleted. The Manager route writes trading_export.downloaded
--   itself, after it signs the download URL.
--
-- WHAT DECIDES WHO IS ASKED IS NOT HERE. The request route asks only devices
-- whose agent is 1.4.0 or later (FIRST_SLIM_EXPORT_AGENT in
-- src/domain/tradingExport.js, the same constant the Data lab page reads) and
-- counts the others as needing the VPS. The size limit is also the route's
-- first (413 export_too_large before anything is written), and the CHECK and
-- the bucket's own limit say it again.
--
-- GRANTS. trading_export_requests keeps nothing for anon or authenticated, the
-- way ingest_devices does after step 56: row level security on, every
-- privilege revoked, and a restrictive policy that denies the browser even if
-- a later file grants something by mistake. It is named in step 56's exception
-- table with no privileges, so a re-run of 56 leaves it closed. EXECUTE on the
-- seven functions for service_role only, the role every route runs as; revoked
-- from public, anon and authenticated explicitly, because a function in public
-- is born executable by both (step 56's header explains the default privilege
-- that does it).
--
-- RE-RUNNING THIS FILE changes no row. The table and the indexes say
-- "already exists, skipping", the constraints are dropped and recreated under
-- their names, the functions are replaced and their grants restated, the bucket
-- is put back to private with its limits, and the policies are created only
-- when missing.
--
-- CHECK AFTERWARDS (read only):
--
--   select id, device_id, client_id, status, from_date, to_date, datasets,
--          byte_size, row_counts, covered_from, covered_to, error_code,
--          requested_at, completed_at, expires_at
--     from public.trading_export_requests
--    order by requested_at desc
--    limit 50;
--
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'trading-exports';

do $step72_guard$
begin
  if to_regclass('public.ingest_devices') is null
    or to_regclass('public.audit_logs') is null
    or to_regclass('storage.buckets') is null
    or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'ingest_devices'
           and column_name in ('status', 'revoked_at', 'agent_version', 'client_id')) <> 4 then
    raise exception 'step 72 needs step 28 (ingest_devices.status, revoked_at, agent_version, client_id; audit_logs; storage.buckets): run it first';
  end if;
end
$step72_guard$;

begin;

create table if not exists public.trading_export_requests (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.ingest_devices(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  requested_by uuid references public.app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  from_date date,
  to_date date,
  datasets text[] not null default array['executions', 'orders', 'strategies', 'trades']::text[],
  status text not null default 'requested',
  error_code text,
  storage_path text,
  byte_size bigint,
  sha256 text,
  row_counts jsonb,
  covered_from date,
  covered_to date,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_status_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_status_check
  check (status in ('requested', 'building', 'uploading', 'ready', 'failed', 'cancelled', 'expired'));

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_error_code_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_error_code_check
  check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$');

-- A failure names its code, and nothing else carries one.
alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_failed_code_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_failed_code_check
  check ((status = 'failed') = (error_code is not null));

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_sha256_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_sha256_check
  check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_byte_size_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_byte_size_check
  check (byte_size is null or byte_size between 1 and 26214400);

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_datasets_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_datasets_check
  check (cardinality(datasets) between 1 and 4
    and array_position(datasets, null) is null
    and datasets <@ array['executions', 'orders', 'strategies', 'trades']::text[]);

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_dates_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_dates_check
  check (from_date is null or to_date is null or from_date <= to_date);

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_covered_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_covered_check
  check (covered_from is null or covered_to is null or covered_from <= covered_to);

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_storage_path_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_storage_path_check
  check (storage_path is null
    or storage_path = 'deep-exports/' || client_id::text || '/' || id::text || '.jsonl.gz');

alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_row_counts_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_row_counts_check
  check (row_counts is null or (
    jsonb_typeof(row_counts) = 'object'
    and row_counts ?& array['executions', 'orders', 'strategies', 'trades']
    and (row_counts - array['executions', 'orders', 'strategies', 'trades']) = '{}'::jsonb
    and jsonb_typeof(row_counts -> 'executions') = 'number' and (row_counts ->> 'executions') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(row_counts -> 'orders') = 'number' and (row_counts ->> 'orders') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(row_counts -> 'strategies') = 'number' and (row_counts ->> 'strategies') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(row_counts -> 'trades') = 'number' and (row_counts ->> 'trades') ~ '^[0-9]{1,15}$'));

-- A ready export has everything the download needs.
alter table public.trading_export_requests
  drop constraint if exists trading_export_requests_ready_check;
alter table public.trading_export_requests
  add constraint trading_export_requests_ready_check
  check (status <> 'ready' or (
    storage_path is not null and byte_size is not null and sha256 is not null
    and row_counts is not null and completed_at is not null and expires_at is not null));

-- One open request per device: the agent works on one export at a time, and a
-- second request for the same machine would wait behind the first anyway.
create unique index if not exists trading_export_requests_one_open
  on public.trading_export_requests (device_id)
  where status in ('requested', 'building', 'uploading');

create index if not exists trading_export_requests_device_status
  on public.trading_export_requests (device_id, status, requested_at);

create index if not exists trading_export_requests_client
  on public.trading_export_requests (client_id, requested_at desc);

create index if not exists trading_export_requests_newest
  on public.trading_export_requests (requested_at desc);

create index if not exists trading_export_requests_expiry
  on public.trading_export_requests (expires_at)
  where status = 'ready';

comment on table public.trading_export_requests is
  'Slim trading exports a Manager asked of a VPS: orders, fills, strategy configurations and per trade geometry for a date range, built by agent 1.4.0 and later and kept in the private bucket trading-exports for 14 days. Service role only. Step 72.';

-- ---------------------------------------------------------------------------
-- Row level security and grants: the browser holds nothing.

alter table public.trading_export_requests enable row level security;

revoke all on table public.trading_export_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.trading_export_requests to service_role;

do $step72_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'trading_export_requests'
      and policyname = 'trading_export_requests deny browser direct access'
  ) then
    create policy "trading_export_requests deny browser direct access"
      on public.trading_export_requests
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end
$step72_policies$;

-- ---------------------------------------------------------------------------
-- The private bucket. The restrictive policy is ANDed with any permissive
-- policy on storage.objects for anon and authenticated, so even a broad one
-- cannot open this bucket. The service role bypasses it, as every route does.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trading-exports', 'trading-exports', false, 26214400, array['application/gzip'])
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $step72_storage_policy$
begin
  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'trading-exports deny browser direct access'
  ) then
    create policy "trading-exports deny browser direct access"
      on storage.objects
      as restrictive
      for all
      to anon, authenticated
      using (bucket_id <> 'trading-exports')
      with check (bucket_id <> 'trading-exports');
  end if;
end
$step72_storage_policy$;

-- ---------------------------------------------------------------------------
-- request_trading_exports

create or replace function public.request_trading_exports(
  p_device_ids uuid[],
  p_from date,
  p_to date,
  p_datasets text[],
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_datasets text[];
  v_count integer;
begin
  if p_device_ids is null
    or cardinality(p_device_ids) < 1
    or cardinality(p_device_ids) > 300
    or array_position(p_device_ids, null) is not null
    or p_actor is null
    or p_datasets is null
    or cardinality(p_datasets) < 1
    or cardinality(p_datasets) > 4
    or array_position(p_datasets, null) is not null
    or not (p_datasets <@ array['executions', 'orders', 'strategies', 'trades']::text[])
    or (select count(distinct dataset) from unnest(p_datasets) as dataset) <> cardinality(p_datasets)
    or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  -- The datasets in the order the contract lists them, whatever order they came in.
  v_datasets := array(
    select dataset
      from unnest(array['executions', 'orders', 'strategies', 'trades']::text[]) with ordinality as listed(dataset, position)
     where dataset = any(p_datasets)
     order by position);

  -- Locked in one order, so two Managers asking for overlapping sets wait for
  -- each other instead of deadlocking, and "has no open request" below is
  -- still true when the insert lands.
  perform 1
    from public.ingest_devices as device
   where device.id = any(p_device_ids)
   order by device.id
     for update;

  with created as (
    insert into public.trading_export_requests (
      device_id, client_id, requested_by, requested_at, from_date, to_date,
      datasets, status, updated_at)
    select device.id, device.client_id, p_actor, v_now, p_from, p_to,
           v_datasets, 'requested', v_now
      from public.ingest_devices as device
     where device.id = any(p_device_ids)
       and device.status = 'active'
       and device.revoked_at is null
       and not exists (
         select 1
           from public.trading_export_requests as open_request
          where open_request.device_id = device.id
            and open_request.status in ('requested', 'building', 'uploading'))
    returning trading_export_requests.id, trading_export_requests.device_id, trading_export_requests.client_id
  )
  insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
  select p_actor,
         'trading_export',
         created.id,
         'trading_export.requested',
         jsonb_build_object(
           'clientId', created.client_id,
           'deviceId', created.device_id,
           'from', p_from,
           'to', p_to,
           'datasets', to_jsonb(v_datasets)
         )
    from created;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.request_trading_exports(uuid[], date, date, text[], uuid) from public, anon, authenticated;
grant execute on function public.request_trading_exports(uuid[], date, date, text[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- cancel_trading_exports

create or replace function public.cancel_trading_exports(
  p_request_ids uuid[],
  p_actor uuid
)
returns table (
  request_id uuid,
  object_path text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_request_ids is null
    or cardinality(p_request_ids) < 1
    or cardinality(p_request_ids) > 300
    or array_position(p_request_ids, null) is not null
    or p_actor is null then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  perform 1
    from public.trading_export_requests as request
   where request.id = any(p_request_ids)
   order by request.id
     for update;

  -- The rows are locked above, so what `open_requests` reads is what the
  -- update replaces: the audit row names the status that was cancelled.
  return query
  with open_requests as (
    select request.id, request.status
      from public.trading_export_requests as request
     where request.id = any(p_request_ids)
       and request.status in ('requested', 'building', 'uploading')
  ),
  cancelled as (
    update public.trading_export_requests as request
       set status = 'cancelled',
           updated_at = v_now
      from open_requests
     where request.id = open_requests.id
    returning request.id, request.device_id, request.client_id, request.storage_path, open_requests.status as previous_status
  ),
  audited as (
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    select p_actor,
           'trading_export',
           cancelled.id,
           'trading_export.cancelled',
           jsonb_build_object(
             'clientId', cancelled.client_id,
             'deviceId', cancelled.device_id,
             'previousStatus', cancelled.previous_status
           )
      from cancelled
    returning 1
  )
  select cancelled.id, cancelled.storage_path
    from cancelled
   order by cancelled.id;
end;
$function$;

revoke all on function public.cancel_trading_exports(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.cancel_trading_exports(uuid[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The device check the three agent functions share.

create or replace function public.trading_export_active_device(p_device_id uuid)
returns public.ingest_devices
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_device public.ingest_devices;
begin
  select device.*
    into v_device
    from public.ingest_devices as device
   where device.id = p_device_id;

  if not found
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'INVALID_INGEST_DEVICE'
      using errcode = 'P0001';
  end if;
  return v_device;
end;
$function$;

revoke all on function public.trading_export_active_device(uuid) from public, anon, authenticated;
grant execute on function public.trading_export_active_device(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- claim_trading_export

create or replace function public.claim_trading_export(
  p_device_id uuid,
  p_agent_version text
)
returns table (
  request_id uuid,
  export_from date,
  export_to date,
  export_datasets text[]
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.trading_export_requests;
  v_from date;
begin
  if p_device_id is null
    or p_agent_version is null
    or p_agent_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$' then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  perform public.trading_export_active_device(p_device_id);

  select request.*
    into v_request
    from public.trading_export_requests as request
   where request.device_id = p_device_id
     -- uploading too: an agent that restarted in the middle of an upload
     -- gets its request back and uploads again (the signed URL overwrites),
     -- instead of leaving it stranded until a Manager cancels it.
     and request.status in ('requested', 'building', 'uploading')
   order by request.requested_at, request.id
   limit 1
     for update;

  if not found then
    return;
  end if;

  v_from := v_request.from_date;
  if v_from is null then
    select prior.covered_to
      into v_from
      from public.trading_export_requests as prior
     where prior.device_id = p_device_id
       and prior.id <> v_request.id
       and prior.status in ('ready', 'expired')
       and prior.covered_to is not null
     order by prior.completed_at desc nulls last, prior.covered_to desc
     limit 1;
  end if;

  if v_request.status = 'requested' then
    update public.trading_export_requests
       set status = 'building',
           started_at = v_now,
           updated_at = v_now
     where id = v_request.id;

    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (
      null,
      'trading_export',
      v_request.id,
      'trading_export.started',
      jsonb_build_object(
        'clientId', v_request.client_id,
        'deviceId', p_device_id,
        'agentVersion', p_agent_version,
        'from', v_from,
        'to', v_request.to_date
      )
    );
  end if;

  return query select v_request.id, v_from, v_request.to_date, v_request.datasets;
end;
$function$;

revoke all on function public.claim_trading_export(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_trading_export(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- begin_trading_export_upload

create or replace function public.begin_trading_export_upload(
  p_device_id uuid,
  p_request_id uuid,
  p_sha256 text,
  p_byte_size bigint
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.trading_export_requests;
  v_path text;
begin
  if p_device_id is null
    or p_request_id is null
    or p_sha256 is null
    or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_byte_size is null
    or p_byte_size < 1
    or p_byte_size > 26214400 then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  perform public.trading_export_active_device(p_device_id);

  select request.*
    into v_request
    from public.trading_export_requests as request
   where request.id = p_request_id
     and request.device_id = p_device_id
     for update;

  if not found then
    raise exception 'TRADING_EXPORT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if v_request.status not in ('building', 'uploading') then
    raise exception 'TRADING_EXPORT_CLOSED'
      using errcode = 'P0001';
  end if;

  v_path := 'deep-exports/' || v_request.client_id::text || '/' || v_request.id::text || '.jsonl.gz';

  update public.trading_export_requests
     set status = 'uploading',
         storage_path = v_path,
         sha256 = p_sha256,
         byte_size = p_byte_size,
         updated_at = v_now
   where id = v_request.id;

  return v_path;
end;
$function$;

revoke all on function public.begin_trading_export_upload(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.begin_trading_export_upload(uuid, uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- complete_trading_export

create or replace function public.complete_trading_export(
  p_device_id uuid,
  p_request_id uuid,
  p_status text,
  p_sha256 text,
  p_byte_size bigint,
  p_row_counts jsonb,
  p_covered_from date,
  p_covered_to date,
  p_error_code text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.trading_export_requests;
begin
  if p_device_id is null
    or p_request_id is null
    or p_status is null
    or p_status not in ('ready', 'failed')
    or (p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$')
    or (p_byte_size is not null and (p_byte_size < 1 or p_byte_size > 26214400))
    or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
    or (p_covered_from is not null and p_covered_to is not null and p_covered_from > p_covered_to)
    -- A failure names its code, and nothing else carries one.
    or ((p_status = 'failed') <> (p_error_code is not null))
    or (p_status = 'ready' and (p_sha256 is null or p_byte_size is null or p_row_counts is null)) then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;
  if p_row_counts is not null and not (
    jsonb_typeof(p_row_counts) = 'object'
    and p_row_counts ?& array['executions', 'orders', 'strategies', 'trades']
    and (p_row_counts - array['executions', 'orders', 'strategies', 'trades']) = '{}'::jsonb
    and jsonb_typeof(p_row_counts -> 'executions') = 'number' and (p_row_counts ->> 'executions') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(p_row_counts -> 'orders') = 'number' and (p_row_counts ->> 'orders') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(p_row_counts -> 'strategies') = 'number' and (p_row_counts ->> 'strategies') ~ '^[0-9]{1,15}$'
    and jsonb_typeof(p_row_counts -> 'trades') = 'number' and (p_row_counts ->> 'trades') ~ '^[0-9]{1,15}$') then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  perform public.trading_export_active_device(p_device_id);

  select request.*
    into v_request
    from public.trading_export_requests as request
   where request.id = p_request_id
     and request.device_id = p_device_id
     for update;

  if not found then
    raise exception 'TRADING_EXPORT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- The same answer again, after a response the agent never read: nothing
  -- changes and the agent is told what it already said.
  if p_status = 'ready'
    and v_request.status = 'ready'
    and v_request.sha256 = p_sha256
    and v_request.byte_size = p_byte_size then
    return 'ready';
  end if;
  if p_status = 'failed'
    and v_request.status = 'failed'
    and v_request.error_code = p_error_code then
    return 'failed';
  end if;

  if p_status = 'ready' then
    if v_request.status <> 'uploading' then
      raise exception 'TRADING_EXPORT_CLOSED'
        using errcode = 'P0001';
    end if;
    -- The file is the one the upload declared, or it is not this request's.
    if v_request.sha256 is distinct from p_sha256
      or v_request.byte_size is distinct from p_byte_size then
      raise exception 'TRADING_EXPORT_MISMATCH'
        using errcode = 'P0001';
    end if;

    update public.trading_export_requests
       set status = 'ready',
           row_counts = p_row_counts,
           covered_from = p_covered_from,
           covered_to = p_covered_to,
           completed_at = v_now,
           expires_at = v_now + interval '14 days',
           updated_at = v_now
     where id = v_request.id;

    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (
      null,
      'trading_export',
      v_request.id,
      'trading_export.ready',
      jsonb_build_object(
        'clientId', v_request.client_id,
        'deviceId', p_device_id,
        'byteSize', p_byte_size,
        'sha256', p_sha256,
        'rowCounts', p_row_counts,
        'coveredFrom', p_covered_from,
        'coveredTo', p_covered_to
      )
    );
    return 'ready';
  end if;

  if v_request.status not in ('building', 'uploading') then
    raise exception 'TRADING_EXPORT_CLOSED'
      using errcode = 'P0001';
  end if;

  update public.trading_export_requests
     set status = 'failed',
         error_code = p_error_code,
         completed_at = v_now,
         updated_at = v_now
   where id = v_request.id;

  insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
  values (
    null,
    'trading_export',
    v_request.id,
    'trading_export.failed',
    jsonb_build_object(
      'clientId', v_request.client_id,
      'deviceId', p_device_id,
      'previousStatus', v_request.status,
      'errorCode', p_error_code
    )
  );
  return 'failed';
end;
$function$;

revoke all on function public.complete_trading_export(uuid, uuid, text, text, bigint, jsonb, date, date, text) from public, anon, authenticated;
grant execute on function public.complete_trading_export(uuid, uuid, text, text, bigint, jsonb, date, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- close_trading_exports

create or replace function public.close_trading_exports(
  p_request_ids uuid[],
  p_actor uuid,
  p_reason text
)
returns table (
  request_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_request_ids is null
    or cardinality(p_request_ids) < 1
    or cardinality(p_request_ids) > 300
    or array_position(p_request_ids, null) is not null
    or p_reason is null
    or p_reason not in ('expired', 'deleted')
    or (p_reason = 'deleted' and p_actor is null) then
    raise exception 'INVALID_TRADING_EXPORT_REQUEST'
      using errcode = '22023';
  end if;

  perform 1
    from public.trading_export_requests as request
   where request.id = any(p_request_ids)
   order by request.id
     for update;

  return query
  with closed as (
    update public.trading_export_requests as request
       set status = 'expired',
           updated_at = v_now
     where request.id = any(p_request_ids)
       and request.status = 'ready'
       and (p_reason = 'deleted' or request.expires_at <= v_now)
    returning request.id, request.device_id, request.client_id, request.expires_at, request.byte_size
  ),
  audited as (
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    select p_actor,
           'trading_export',
           closed.id,
           'trading_export.' || p_reason,
           jsonb_build_object(
             'clientId', closed.client_id,
             'deviceId', closed.device_id,
             'expiresAt', closed.expires_at,
             'byteSize', closed.byte_size
           )
      from closed
    returning 1
  )
  select closed.id
    from closed
   order by closed.id;
end;
$function$;

revoke all on function public.close_trading_exports(uuid[], uuid, text) from public, anon, authenticated;
grant execute on function public.close_trading_exports(uuid[], uuid, text) to service_role;

commit;

-- What this leaves: one new table with row level security, and no table in
-- public open. The same check steps 43 to 66 end with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 72 left % table(s) without row level security', n;
  end if;
end $$;
