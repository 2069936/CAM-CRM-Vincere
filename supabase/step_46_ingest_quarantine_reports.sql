-- Step 46: what each VPS holds in quarantine, as the VPS reports it.
--
-- WHAT THIS IS FOR.
--
-- A capture the CRM refuses leaves the agent's queue for queue\quarantine on
-- the VPS with a reason file beside it. Until agent 1.0.7 nothing on the
-- machine looked at that folder again and nothing here knew it existed: four
-- captures sat on a VPS for a week after the server side fault that refused
-- them had been fixed, and the only thing that could have said so was a person
-- with the path. The agent now reviews the folder once a day and sends the
-- inventory to POST /api/ingest/quarantine after every review. This is where
-- that inventory lands.
--
-- WHAT IT IS NOT. Not the heartbeat. The production heartbeat refuses any key
-- it does not know and record_ingest_heartbeat refuses any error code outside
-- its list, so an agent that put the quarantine on the heartbeat would silence
-- every heartbeat on the fleet until the CRM caught up. Its own endpoint, its
-- own table, its own function, and the heartbeat's vocabulary is untouched.
--
-- ONE ROW PER CAPTURE PER DEVICE, REPLACED WHOLE ON EVERY REPORT. The report is
-- the folder as it is right now, not a log of what happened to it: a capture
-- that leaves the folder leaves this table on the next report, a capture that
-- comes back keeps its row with the attempt count carried forward. The unique
-- key on (device_id, capture_id) is what makes a re report an upsert rather
-- than a second row.
--
-- `final` IS DERIVED, NOT SENT. The agent retries only the two 422 codes and
-- only under three attempts; everything else stays and waits for the desk.
-- The column repeats that rule here so the fleet view can rank a row as
-- needing attention without re deriving the agent's policy in JavaScript, and
-- so the rule lives in exactly one place on this side.

begin;

create table if not exists public.ingest_quarantine_reports (
  id uuid primary key default gen_random_uuid(),
  -- A report is a mirror of a folder on one machine and means nothing without
  -- it, which is why this cascades where ingest_batches restricts: a batch is
  -- evidence, a report is not.
  device_id uuid not null references public.ingest_devices(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  capture_id uuid not null,
  trading_date date not null,
  code text not null,
  attempts integer not null default 0,
  quarantined_at timestamptz not null,
  last_attempt_at timestamptz,
  reported_at timestamptz not null default now(),
  -- QuarantinePolicy in the agent: only snapshot_processing_failed and
  -- unsupported_schema_version are ever sent back, and only while attempts is
  -- under three. A row that is final will not move on its own.
  final boolean generated always as (
    attempts >= 3
    or code not in ('snapshot_processing_failed', 'unsupported_schema_version')
  ) stored,
  constraint ingest_quarantine_reports_device_capture_unique unique (device_id, capture_id),
  -- THE VOCABULARY. The six the CRM itself answers with (two 422s, a 400, a
  -- 413 and two 409s), the five the queue writes when a file on disk cannot
  -- be trusted, the one for a payload whose reason file is missing, the two
  -- the uploader writes on its own, and 'other' for a code this CRM has not
  -- met yet. The endpoint collapses an unknown code to 'other' rather than
  -- refusing the report, because a report refused for one word hides every
  -- other capture in it; that is the heartbeat's trap and this table does not
  -- repeat it.
  constraint ingest_quarantine_reports_code_check check (code in (
    'snapshot_processing_failed',
    'unsupported_schema_version',
    'snapshot_rejected',
    'payload_too_large',
    'capture_requires_replay',
    'capture_conflict',
    'queue_payload_corrupt',
    'queue_payload_mismatch',
    'queue_payload_changed',
    'queue_item_invalid',
    'capture_id_conflict',
    'receipt_invalid',
    'receipt_hash_mismatch',
    'quarantine_reason_invalid',
    'upload_failed',
    'unexpected_redirect',
    'tls_failure',
    'other'
  )),
  constraint ingest_quarantine_reports_attempts_check check (attempts between 0 and 10)
);

-- The client card asks by client, newest trading date first; the fleet view
-- asks by a list of devices, which the unique key already serves.
create index if not exists idx_ingest_quarantine_reports_client_date
  on public.ingest_quarantine_reports (client_id, trading_date desc);

-- record_ingest_quarantine_report: the folder, replaced whole.
--
-- EVERY ITEM IS CHECKED BEFORE ANY ROW MOVES. The function is one statement
-- from the caller's side, so a raise anywhere in it rolls back everything it
-- did; the loop below can therefore validate and upsert in one pass and still
-- leave the table exactly as it was when the report is malformed. The delete
-- at the end removes what the device no longer holds, which is how a capture
-- that was accepted after a retry, or replayed from here, leaves this table.
--
-- 22023 for a malformed report, P0001 for a device that is not active, the
-- same two codes the heartbeat function raises, so the endpoint maps them the
-- same way: 400 and 401.
create or replace function public.record_ingest_quarantine_report(
  p_device_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_device public.ingest_devices;
  v_now timestamptz := clock_timestamp();
  v_item jsonb;
  v_capture_id uuid;
  v_trading_date date;
  v_code text;
  v_attempts integer;
  v_quarantined_at timestamptz;
  v_last_attempt_at timestamptz;
  v_capture_ids uuid[] := array[]::uuid[];
  v_removed integer := 0;
begin
  if p_device_id is null
    or p_items is null
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) > 200 then
    raise exception 'INVALID_QUARANTINE_REPORT'
      using errcode = '22023';
  end if;

  -- Locked for the length of the replace, so two reports from the same device
  -- cannot interleave their deletes and upserts.
  select device.*
  into v_device
  from public.ingest_devices as device
  where device.id = p_device_id
  for update;

  if not found
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'INVALID_INGEST_DEVICE'
      using errcode = 'P0001';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      -- coalesce on every typeof: a missing key reads as SQL null, and a null
      -- in an OR chain is not true, so without it a missing field would pass.
      if jsonb_typeof(v_item) <> 'object'
        or coalesce(v_item ->> 'captureId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(v_item ->> 'tradingDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
        or coalesce(jsonb_typeof(v_item -> 'attempts'), '') <> 'number'
        or coalesce(jsonb_typeof(v_item -> 'quarantinedAt'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'lastAttemptAt'), 'null') not in ('string', 'null') then
        raise exception 'malformed item';
      end if;
      -- The casts raise on a date that does not exist or a timestamp that
      -- cannot be read, and the handler below turns any of that into the one
      -- public code.
      v_capture_id := (v_item ->> 'captureId')::uuid;
      v_trading_date := (v_item ->> 'tradingDate')::date;
      v_code := v_item ->> 'code';
      v_attempts := (v_item ->> 'attempts')::integer;
      v_quarantined_at := (v_item ->> 'quarantinedAt')::timestamptz;
      v_last_attempt_at := (v_item ->> 'lastAttemptAt')::timestamptz;
      if v_code is null
        or v_code not in (
          'snapshot_processing_failed',
          'unsupported_schema_version',
          'snapshot_rejected',
          'payload_too_large',
          'capture_requires_replay',
          'capture_conflict',
          'queue_payload_corrupt',
          'queue_payload_mismatch',
          'queue_payload_changed',
          'queue_item_invalid',
          'capture_id_conflict',
          'receipt_invalid',
          'receipt_hash_mismatch',
          'quarantine_reason_invalid',
          'upload_failed',
          'unexpected_redirect',
          'tls_failure',
          'other'
        )
        or v_attempts not between 0 and 10
        or v_quarantined_at > v_now + interval '5 minutes'
        or (v_last_attempt_at is not null and v_last_attempt_at > v_now + interval '5 minutes')
        -- The same capture twice in one report is not a report of a folder,
        -- where a file has one name.
        or v_capture_id = any (v_capture_ids) then
        raise exception 'malformed item';
      end if;
    exception when others then
      raise exception 'INVALID_QUARANTINE_REPORT'
        using errcode = '22023';
    end;

    v_capture_ids := v_capture_ids || v_capture_id;

    insert into public.ingest_quarantine_reports (
      device_id, client_id, capture_id, trading_date, code, attempts,
      quarantined_at, last_attempt_at, reported_at
    ) values (
      p_device_id, v_device.client_id, v_capture_id, v_trading_date, v_code, v_attempts,
      v_quarantined_at, v_last_attempt_at, v_now
    )
    on conflict (device_id, capture_id) do update
    set client_id = excluded.client_id,
        trading_date = excluded.trading_date,
        code = excluded.code,
        attempts = excluded.attempts,
        quarantined_at = excluded.quarantined_at,
        last_attempt_at = excluded.last_attempt_at,
        reported_at = excluded.reported_at;
  end loop;

  -- What the device no longer holds. An empty report clears the device.
  with removed as (
    delete from public.ingest_quarantine_reports as report
    where report.device_id = p_device_id
      and not (report.capture_id = any (v_capture_ids))
    returning 1
  )
  select count(*) into v_removed from removed;

  return jsonb_build_object(
    'device_id', p_device_id,
    'recorded', coalesce(array_length(v_capture_ids, 1), 0),
    'removed', v_removed
  );
end;
$function$;

revoke all on function public.record_ingest_quarantine_report(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_ingest_quarantine_report(uuid, jsonb) to service_role;

-- Row Level Security, in the shape step 28 gives every other auto collection
-- table. Nothing in the browser reaches this table; the ingest endpoint writes
-- it and the two admin endpoints read it, all as the service role.
alter table public.ingest_quarantine_reports enable row level security;

do $quarantine_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ingest_quarantine_reports'
      and policyname = 'ingest_quarantine_reports deny browser direct access'
  ) then
    create policy "ingest_quarantine_reports deny browser direct access"
      on public.ingest_quarantine_reports
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end
$quarantine_policies$;

commit;

-- What this leaves: the new table has RLS and exactly one policy, and no table
-- in public is open. Same check steps 43, 44 and 45 end with, for the same
-- reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 46 left % table(s) without row level security', n;
  end if;
end $$;
