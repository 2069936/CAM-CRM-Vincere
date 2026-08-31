-- Drop the rule that a heartbeat is malformed when its last successful upload is
-- newer than its last capture.
--
-- It is not malformed. An upload finishes after the capture it carries, so
-- last_success_at later than last_capture_at is the ordinary order, and the
-- reverse is ordinary too once a capture has happened since the last
-- acknowledged upload. Neither says anything is wrong.
--
-- Live evidence, 2026-08-31: a VPS paired, captured, queued its snapshot, and
-- then every heartbeat was refused. The agent recorded `heartbeat_failed` on
-- itself and re-sent it, which its own validator rejected as an unknown code, so
-- the failure could never clear. The CRM showed the machine as never paired
-- while it was in fact working. That client-side deadlock is fixed separately;
-- this removes the same false rule from the database, which would otherwise
-- have refused every heartbeat sent after the first upload the agent completed.
--
-- The future-skew guards stay. A timestamp more than five minutes ahead of the
-- server is a clock problem worth refusing; an ordering between two honest
-- timestamps is not.

create or replace function public.record_ingest_heartbeat(
  p_device_id uuid,
  p_agent_version text,
  p_addon_version text,
  p_ninjatrader_version text,
  p_last_capture_at timestamptz,
  p_last_success_at timestamptz,
  p_last_error_code text,
  p_last_error_message text,
  p_queue_depth bigint,
  p_queue_bytes bigint,
  p_addon_available boolean,
  p_health_status text,
  p_min_interval_seconds integer
)
returns table (
  device_id uuid,
  health_status text,
  throttled boolean,
  schedule_time time without time zone,
  schedule_timezone text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  v_device public.ingest_devices;
  v_now timestamptz := clock_timestamp();
  v_effective_capture_at timestamptz;
  v_effective_success_at timestamptz;
  v_unchanged boolean;
  v_first_online boolean;
  v_recovered boolean;
begin
  if p_device_id is null
    or p_agent_version is null
    or p_addon_version is null
    or p_agent_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    or p_addon_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    or p_ninjatrader_version is null
    or p_ninjatrader_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    or (p_last_error_code is not null and p_last_error_code not in (
      'ninjatrader_not_running',
      'addon_unavailable',
      'capture_timeout',
      'capture_failed',
      'contract_mismatch',
      'queue_capacity_warning',
      'upload_failed',
      'configuration_error'
    ))
    or (p_last_error_message is not null and (
      char_length(p_last_error_message) > 256
      or p_last_error_message ~ '[[:cntrl:]]'
    ))
    or p_queue_depth is null or not (p_queue_depth >= 0)
    or p_queue_depth > 9007199254740991
    or p_queue_bytes is null or not (p_queue_bytes >= 0)
    or p_queue_bytes > 9007199254740991
    or (p_last_capture_at is not null
        and p_last_capture_at > v_now + interval '5 minutes')
    or (p_last_success_at is not null
        and p_last_success_at > v_now + interval '5 minutes')
    or p_health_status is null
    or p_health_status not in ('online', 'error', 'update_required')
    or (p_health_status = 'online' and p_last_error_code is not null)
    or (p_health_status = 'error' and p_last_error_code is null)
    or p_min_interval_seconds is null
    or p_min_interval_seconds not between 1 and 3600 then
    raise exception 'INVALID_HEARTBEAT_REQUEST'
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

  v_effective_capture_at := case
    when v_device.last_capture_at is null then p_last_capture_at
    when p_last_capture_at is null then v_device.last_capture_at
    else greatest(v_device.last_capture_at, p_last_capture_at)
  end;
  v_effective_success_at := case
    when v_device.last_success_at is null then p_last_success_at
    when p_last_success_at is null then v_device.last_success_at
    else greatest(v_device.last_success_at, p_last_success_at)
  end;

  v_unchanged :=
    v_device.agent_version is not distinct from p_agent_version
    and v_device.addon_version is not distinct from p_addon_version
    and v_device.ninjatrader_version is not distinct from p_ninjatrader_version
    and v_device.last_capture_at is not distinct from v_effective_capture_at
    and v_device.last_success_at is not distinct from v_effective_success_at
    and v_device.last_error_code is not distinct from p_last_error_code
    and v_device.health_status is not distinct from p_health_status
    and (v_device.metadata ->> 'lastErrorMessage') is not distinct from p_last_error_message
    and (v_device.metadata -> 'queueDepth') is not distinct from to_jsonb(p_queue_depth)
    and (v_device.metadata -> 'queueBytes') is not distinct from to_jsonb(p_queue_bytes)
    and (v_device.metadata -> 'addonAvailable') is not distinct from to_jsonb(p_addon_available);

  if v_unchanged
    and v_device.last_seen_at is not null
    and v_now < v_device.last_seen_at + make_interval(secs => p_min_interval_seconds) then
    return query
    select v_device.id,
           v_device.health_status,
           true,
           v_device.schedule_time,
           v_device.schedule_timezone;
    return;
  end if;

  v_first_online := v_device.health_status = 'pending';
  v_recovered := v_device.last_error_code is not null and p_last_error_code is null;

  update public.ingest_devices
  set agent_version = p_agent_version,
      addon_version = p_addon_version,
      ninjatrader_version = p_ninjatrader_version,
      last_seen_at = v_now,
      last_capture_at = v_effective_capture_at,
      last_success_at = v_effective_success_at,
      last_error_code = p_last_error_code,
      last_error_at = case
        when p_last_error_code is null then null
        when last_error_code is distinct from p_last_error_code then v_now
        else coalesce(last_error_at, v_now)
      end,
      health_status = p_health_status,
      metadata = (coalesce(metadata, '{}'::jsonb)
                    - 'lastErrorMessage'
                    - 'queueDepth'
                    - 'queueBytes'
                    - 'addonAvailable')
                 || jsonb_strip_nulls(jsonb_build_object(
                      'lastErrorMessage', p_last_error_message,
                      'queueDepth', p_queue_depth,
                      'queueBytes', p_queue_bytes,
                      'addonAvailable', p_addon_available
                    ))
  where id = p_device_id;

  if v_first_online then
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (
      null,
      'ingest_device',
      p_device_id,
      'ingest_device.first_online',
      jsonb_build_object(
        'clientId', v_device.client_id,
        'deviceId', p_device_id,
        'healthStatus', p_health_status,
        'agentVersion', p_agent_version,
        'addonVersion', p_addon_version,
        'ninjaTraderVersion', p_ninjatrader_version,
        'lastErrorCode', p_last_error_code
      )
    );
  end if;

  if v_recovered then
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (
      null,
      'ingest_device',
      p_device_id,
      'ingest_device.recovered',
      jsonb_build_object(
        'clientId', v_device.client_id,
        'deviceId', p_device_id,
        'healthStatus', p_health_status,
        'agentVersion', p_agent_version,
        'addonVersion', p_addon_version,
        'ninjaTraderVersion', p_ninjatrader_version,
        'lastErrorCode', p_last_error_code
      )
    );
  end if;

  return query
  select p_device_id,
         p_health_status,
         false,
         v_device.schedule_time,
         v_device.schedule_timezone;
end;
$function$;
