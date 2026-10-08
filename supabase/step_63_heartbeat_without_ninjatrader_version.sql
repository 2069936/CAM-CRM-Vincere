-- Step 63: a heartbeat without a NinjaTrader version is a heartbeat, not a
-- malformed request.
--
-- WHY 63. 62 is applied. 54 is still claimed by draft PR 65 and the gap stays.
--
-- THE DEFECT, which the route believed it had fixed and had only moved one
-- layer down. The agent does not know the NinjaTrader version until the add-on
-- has told it, and the add-on tells it at the first successful CAPTURE and
-- nowhere else: CaptureAndQueueWorkflow calls CollectorState.RecordEnvironment
-- with snapshot.Source.NinjaTraderVersion, the account and strategy sample
-- replies carry no version at all, and CollectorState lives in memory. So a
-- fresh install, and every service restart after it (an update, a reboot),
-- sends ninjaTraderVersion null in each heartbeat until the 16:30 close has
-- been captured.
--
-- Agents up to 1.1.x never exposed this, because Program.cs passed the literal
-- "8.1.0" for every machine on the desk. Agent 1.2.0 (PR 68, 2026-10-05) sends
-- null instead, honestly. The route has passed null through since 2026-09-02
-- (nullableCollectorVersion in server/autoCollection/ingest/heartbeat.js), and
-- the RPC, last defined by step 41 on 2026-08-31, still has
--
--     or p_ninjatrader_version is null
--
-- in its validation block. The route turns that refusal into a 400, the agent
-- records heartbeat_failed, and last_seen_at freezes at the restart. Observed
-- 2026-10-08: eight VPS updated to 1.2.0 post account samples every ten minutes
-- and have not had a heartbeat land for over an hour. PR 83, which stopped the
-- route refusing a heartbeat over an unknown error code, did not recover them,
-- which is what put this line in front of everything else.
--
-- WHAT CHANGES, and only this:
--
--   * p_ninjatrader_version may be null. A non null value must still be a
--     version string; the regex is unchanged. The column is displayed, and
--     relaxing "not known yet" must not relax "known and wrong".
--   * The stored ingest_devices.ninjatrader_version is KEPT when the heartbeat
--     carries null (coalesce). The first value a device ever reports is the
--     first one stored; until then the column stays null, which is the truth.
--     Nothing a heartbeat says can erase a version this database has seen.
--   * The "unchanged" test the throttle relies on compares the stored value
--     with the EFFECTIVE one, so a null-version heartbeat from a machine whose
--     version is known is as unchanged as it would be with the version spelled
--     out, and is throttled the same way.
--   * The two audit rows (first_online, recovered) record the effective version.
--
-- Every other check is identical to step 41: agent and add-on versions still
-- required and still validated, the eight stable error codes, the message
-- bound, the queue bounds, the five minute future skew, the three health
-- statuses and their pairing with the error code, the interval bounds, the
-- device status check, the throttle and the two audit rows.
--
-- GRANTS, restated per step 56's rule: a replaced function carries its own.
-- Nothing in the browser calls this; only the ingest route on the service role.
--
-- RE-RUNNING THIS FILE is a no-op. RE-RUNNING STEP 41 after it is NOT: 41
-- carries the old body and would bring the refusal back. If 41 is ever run
-- again, run 63 again after it. The runbook says so beside the row.

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
  v_effective_ninjatrader_version text;
  v_unchanged boolean;
  v_first_online boolean;
  v_recovered boolean;
begin
  if p_device_id is null
    or p_agent_version is null
    or p_addon_version is null
    or p_agent_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    or p_addon_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$'
    -- Null is "not known yet", the normal state of a new install or a machine
    -- restarted before today's capture. A value must still be a version.
    or (p_ninjatrader_version is not null
        and p_ninjatrader_version !~ '^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$')
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
  -- What the heartbeat says if it says anything, otherwise what this database
  -- already knows. Null only while neither has ever had a value.
  v_effective_ninjatrader_version :=
    coalesce(p_ninjatrader_version, v_device.ninjatrader_version);

  v_unchanged :=
    v_device.agent_version is not distinct from p_agent_version
    and v_device.addon_version is not distinct from p_addon_version
    and v_device.ninjatrader_version is not distinct from v_effective_ninjatrader_version
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
      ninjatrader_version = v_effective_ninjatrader_version,
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
        'ninjaTraderVersion', v_effective_ninjatrader_version,
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
        'ninjaTraderVersion', v_effective_ninjatrader_version,
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

-- Step 56's rule: the function carries its own grants. PostgreSQL keeps the
-- existing ACL across CREATE OR REPLACE, so these restate the end state rather
-- than trusting what step 28 left: nothing for public, anon or authenticated,
-- EXECUTE for the service role the ingest route runs as.
revoke all on function public.record_ingest_heartbeat(
  uuid, text, text, text, timestamptz, timestamptz, text, text,
  bigint, bigint, boolean, text, integer
) from public, anon, authenticated;
grant execute on function public.record_ingest_heartbeat(
  uuid, text, text, text, timestamptz, timestamptz, text, text,
  bigint, bigint, boolean, text, integer
) to service_role;
