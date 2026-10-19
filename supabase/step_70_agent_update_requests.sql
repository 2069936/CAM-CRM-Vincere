-- Step 70: a Manager asks a VPS to update its agent from the CRM, and the
-- agent says how it went.
--
-- WHY 70. 69 is applied. 54 is still a deliberate gap. This file needs step 28
-- (ingest_devices with status, revoked_at and agent_version; audit_logs) and
-- says so if it is missing. It replaces nothing: three new functions and six
-- new columns.
--
-- THE GAP. Every agent on the desk is updated by a person who opens the VPS
-- and runs install-agent.ps1 by hand. Agent 1.3.0 can update itself: it polls
-- /api/ingest/agent-update, and when the CRM hands it a directive it downloads
-- the release the CRM pins, checks it and installs it outside the capture
-- window. This file is where that request lives and where the agent's answer
-- lands.
--
-- WHAT THIS FILE ADDS, and only this:
--
--   Six nullable columns on public.ingest_devices, each with its own CHECK
--   (dropped and recreated under its name):
--     update_target_version  text         the version requested, x.y.z; NULL
--                                         when nothing is pending
--     update_requested_at    timestamptz  when it was requested
--     update_requested_by    uuid         the app user who requested it
--     update_state           text         requested, downloading, staged,
--                                         applying, failed, completed or
--                                         cancelled
--     update_state_at        timestamptz  when update_state last changed
--     update_error_code      text         the agent's code for a failure,
--                                         ^[a-z][a-z0-9_]{0,63}$
--   A request is PENDING while update_target_version is not NULL. completed
--   and cancelled clear it; requested_at and requested_by stay, as the record
--   of the last request.
--
--   public.request_agent_update(p_device_ids uuid[], p_target_version text,
--     p_actor uuid) returns integer. For each listed device that is active,
--     not revoked, and whose agent_version is NULL or numerically lower than
--     the target (1.10.0 is above 1.9.0), sets the target, state 'requested',
--     the two clocks and the actor, clears the error, and writes one
--     audit_logs row (ingest_device.update_requested). Returns how many it
--     set. A device already at or above the target is left alone.
--
--   public.cancel_agent_update(p_device_ids uuid[], p_actor uuid) returns
--     integer. For each listed device with a pending request, clears the
--     target and the error, state 'cancelled', and one audit row
--     (ingest_device.update_cancelled). Returns how many it cancelled.
--
--   public.record_agent_update_poll(p_device_id uuid, p_agent_version text,
--     p_state text, p_error_code text, p_target_version text) returns
--     table(target_version text, requested_at timestamptz). What the agent's
--     poll writes, through the device route. Validates every argument and
--     raises INVALID_AGENT_UPDATE_REQUEST otherwise; raises
--     INVALID_INGEST_DEVICE for a device that is missing, revoked or not
--     active. When a request is pending and the agent reports a version at or
--     above it, the request is complete: target cleared, state 'completed',
--     one audit row (ingest_device.update_completed). Otherwise, when a
--     request is pending, the agent reports a state, and the target it names
--     is the pending one, the state and error are stored, with state_at moved
--     only when either changes, and one audit row
--     (ingest_device.update_failed) on the way INTO failed, never for a
--     repeat. A state for any other target is ignored. Returns the pending
--     target and when it was requested, NULLs when none.
--
-- WHAT DECIDES THE DIRECTIVE IS NOT HERE. The route gives the agent a
-- directive only when the pending target is exactly the release the CRM pins
-- right now, the agent is below it, and the VPS's addon_version is at least
-- the release manifest's minimumAddonVersion when it names one; a request for
-- a release the CRM no longer pins stays pending and is never acted on until
-- it is cancelled or requested again. Which devices are requested at all
-- (never an agent older than 1.3.0, which has no updater) is the request
-- route's decision too, before it calls request_agent_update.
--
-- VERSIONS are compared as numbers, padded to four parts, so 1.2 and 1.2.0
-- are equal and 1.10.0 is above 1.9.0. An agent_version that is not a
-- version at all (only possible before step 28 validated it) reads as
-- unknown, like NULL.
--
-- GRANTS. EXECUTE on the three functions for service_role only, the role
-- both routes run as; revoked from public, anon and authenticated
-- explicitly, because a function in public is born executable by both (step
-- 56's header explains the default privilege that does it). ingest_devices
-- keeps nothing for anon or authenticated (steps 28 and 56); the new columns
-- inherit that.
--
-- RE-RUNNING THIS FILE changes no row. `add column if not exists` says
-- "skipping" for each column the second time, the constraints are dropped
-- and recreated under their names, the functions are replaced and their
-- grants restated.
--
-- CHECK AFTERWARDS (read only):
--
--   select id, agent_version, update_target_version, update_state,
--          update_state_at, update_error_code
--     from public.ingest_devices
--    where update_state is not null
--    order by update_state_at desc;

do $step70_guard$
begin
  if to_regclass('public.ingest_devices') is null
    or to_regclass('public.audit_logs') is null
    or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'ingest_devices'
           and column_name in ('status', 'revoked_at', 'agent_version', 'client_id')) <> 4 then
    raise exception 'step 70 needs step 28 (ingest_devices.status, revoked_at, agent_version; audit_logs): run it first';
  end if;
end
$step70_guard$;

begin;

alter table public.ingest_devices
  add column if not exists update_target_version text;
alter table public.ingest_devices
  add column if not exists update_requested_at timestamptz;
alter table public.ingest_devices
  add column if not exists update_requested_by uuid;
alter table public.ingest_devices
  add column if not exists update_state text;
alter table public.ingest_devices
  add column if not exists update_state_at timestamptz;
alter table public.ingest_devices
  add column if not exists update_error_code text;

alter table public.ingest_devices
  drop constraint if exists ingest_devices_update_target_version_check;
alter table public.ingest_devices
  add constraint ingest_devices_update_target_version_check
  check (update_target_version is null or update_target_version ~ '^\d+\.\d+\.\d+$');

alter table public.ingest_devices
  drop constraint if exists ingest_devices_update_state_check;
alter table public.ingest_devices
  add constraint ingest_devices_update_state_check
  check (update_state is null or update_state in (
    'requested', 'downloading', 'staged', 'applying', 'failed', 'completed', 'cancelled'));

alter table public.ingest_devices
  drop constraint if exists ingest_devices_update_error_code_check;
alter table public.ingest_devices
  add constraint ingest_devices_update_error_code_check
  check (update_error_code is null or update_error_code ~ '^[a-z][a-z0-9_]{0,63}$');

comment on column public.ingest_devices.update_target_version is
  'The agent version a Manager asked this VPS to update to, x.y.z. NULL when no request is pending. Step 70.';
comment on column public.ingest_devices.update_requested_at is
  'When the last update request was made. Kept after it completes or is cancelled. Step 70.';
comment on column public.ingest_devices.update_requested_by is
  'The app user (app_users.id) who made the last update request. Step 70.';
comment on column public.ingest_devices.update_state is
  'Where the last update request stands: requested, downloading, staged, applying, failed, completed or cancelled. Step 70.';
comment on column public.ingest_devices.update_state_at is
  'When update_state last changed. Step 70.';
comment on column public.ingest_devices.update_error_code is
  'The agent''s code for a failed update, ^[a-z][a-z0-9_]{0,63}$. NULL unless update_state is failed. Step 70.';

-- ---------------------------------------------------------------------------
-- request_agent_update

create or replace function public.request_agent_update(
  p_device_ids uuid[],
  p_target_version text,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_target integer[];
  v_count integer;
begin
  if p_device_ids is null
    or cardinality(p_device_ids) < 1
    or cardinality(p_device_ids) > 300
    or array_position(p_device_ids, null) is not null
    or p_target_version is null
    or p_target_version !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    or p_actor is null then
    raise exception 'INVALID_AGENT_UPDATE_REQUEST'
      using errcode = '22023';
  end if;

  -- Padded to four parts, so a two or four part agent version compares the
  -- way the route's compareCollectorVersions does.
  v_target := string_to_array(p_target_version, '.')::integer[] || array[0];

  -- Locked in one order, so two Managers updating overlapping sets wait for
  -- each other instead of deadlocking.
  perform 1
    from public.ingest_devices as device
   where device.id = any(p_device_ids)
   order by device.id
     for update;

  with updated as (
    update public.ingest_devices as device
       set update_target_version = p_target_version,
           update_requested_at = v_now,
           update_requested_by = p_actor,
           update_state = 'requested',
           update_state_at = v_now,
           update_error_code = null
     where device.id = any(p_device_ids)
       and device.status = 'active'
       and device.revoked_at is null
       and case
             when device.agent_version is null then true
             when device.agent_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$' then true
             else (string_to_array(device.agent_version, '.')::integer[]
                   || array_fill(0, array[4 - cardinality(string_to_array(device.agent_version, '.'))]))
                  < v_target
           end
    returning device.id, device.client_id, device.agent_version
  )
  insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
  select p_actor,
         'ingest_device',
         updated.id,
         'ingest_device.update_requested',
         jsonb_build_object(
           'clientId', updated.client_id,
           'deviceId', updated.id,
           'agentVersion', updated.agent_version,
           'targetVersion', p_target_version
         )
    from updated;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.request_agent_update(uuid[], text, uuid) from public, anon, authenticated;
grant execute on function public.request_agent_update(uuid[], text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- cancel_agent_update

create or replace function public.cancel_agent_update(
  p_device_ids uuid[],
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_device_ids is null
    or cardinality(p_device_ids) < 1
    or cardinality(p_device_ids) > 300
    or array_position(p_device_ids, null) is not null
    or p_actor is null then
    raise exception 'INVALID_AGENT_UPDATE_REQUEST'
      using errcode = '22023';
  end if;

  perform 1
    from public.ingest_devices as device
   where device.id = any(p_device_ids)
   order by device.id
     for update;

  -- The rows are locked above, so what `pending` reads is what the update
  -- below replaces: the audit row names the request that was cancelled.
  with pending as (
    select device.id, device.update_target_version, device.update_state
      from public.ingest_devices as device
     where device.id = any(p_device_ids)
       and device.update_target_version is not null
  ),
  cancelled as (
    update public.ingest_devices as device
       set update_target_version = null,
           update_state = 'cancelled',
           update_state_at = v_now,
           update_error_code = null
      from pending
     where device.id = pending.id
    returning device.id, device.client_id, pending.update_target_version, pending.update_state
  )
  insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
  select p_actor,
         'ingest_device',
         cancelled.id,
         'ingest_device.update_cancelled',
         jsonb_build_object(
           'clientId', cancelled.client_id,
           'deviceId', cancelled.id,
           'targetVersion', cancelled.update_target_version,
           'previousState', cancelled.update_state
         )
    from cancelled;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.cancel_agent_update(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.cancel_agent_update(uuid[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- record_agent_update_poll

create or replace function public.record_agent_update_poll(
  p_device_id uuid,
  p_agent_version text,
  p_state text,
  p_error_code text,
  p_target_version text
)
returns table (
  target_version text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_device public.ingest_devices;
  v_now timestamptz := clock_timestamp();
  v_agent integer[];
  v_target integer[];
begin
  if p_device_id is null
    or p_agent_version is null
    or p_agent_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    or (p_state is not null
        and p_state not in ('downloading', 'staged', 'applying', 'failed'))
    or (p_error_code is not null
        and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
    -- A failure names its code, and nothing else carries one.
    or (p_state is not distinct from 'failed' and p_error_code is null)
    or (p_state is distinct from 'failed' and p_error_code is not null)
    or (p_target_version is not null
        and p_target_version !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$') then
    raise exception 'INVALID_AGENT_UPDATE_REQUEST'
      using errcode = '22023';
  end if;

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

  if v_device.update_target_version is null then
    return query select null::text, null::timestamptz;
    return;
  end if;

  v_agent := string_to_array(p_agent_version, '.')::integer[]
    || array_fill(0, array[4 - cardinality(string_to_array(p_agent_version, '.'))]);
  v_target := string_to_array(v_device.update_target_version, '.')::integer[]
    || array_fill(0, array[4 - cardinality(string_to_array(v_device.update_target_version, '.'))]);

  if v_agent >= v_target then
    update public.ingest_devices
       set update_target_version = null,
           update_state = 'completed',
           update_state_at = v_now,
           update_error_code = null
     where id = p_device_id;

    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (
      null,
      'ingest_device',
      p_device_id,
      'ingest_device.update_completed',
      jsonb_build_object(
        'clientId', v_device.client_id,
        'deviceId', p_device_id,
        'agentVersion', p_agent_version,
        'targetVersion', v_device.update_target_version,
        'requestedAt', v_device.update_requested_at,
        'requestedBy', v_device.update_requested_by
      )
    );

    return query select null::text, null::timestamptz;
    return;
  end if;

  if p_state is not null
    and p_target_version = v_device.update_target_version
    and (v_device.update_state is distinct from p_state
         or v_device.update_error_code is distinct from p_error_code) then
    update public.ingest_devices
       set update_state = p_state,
           update_error_code = p_error_code,
           update_state_at = v_now
     where id = p_device_id;

    if p_state = 'failed' and v_device.update_state is distinct from 'failed' then
      insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
      values (
        null,
        'ingest_device',
        p_device_id,
        'ingest_device.update_failed',
        jsonb_build_object(
          'clientId', v_device.client_id,
          'deviceId', p_device_id,
          'agentVersion', p_agent_version,
          'targetVersion', v_device.update_target_version,
          'errorCode', p_error_code
        )
      );
    end if;
  end if;

  return query select v_device.update_target_version, v_device.update_requested_at;
end;
$function$;

revoke all on function public.record_agent_update_poll(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_agent_update_poll(uuid, text, text, text, text) to service_role;

commit;
