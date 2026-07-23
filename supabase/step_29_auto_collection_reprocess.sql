-- Controlled Manager replay and explicit closed-day replacement.
-- Run after step_28_auto_collection.sql.
begin;

alter table public.ingest_batches
  add column if not exists reprocess_mode text;
alter table public.ingest_batches
  drop constraint if exists ingest_batches_reprocess_mode_check;
alter table public.ingest_batches
  add constraint ingest_batches_reprocess_mode_check
  check (reprocess_mode is null or reprocess_mode in ('normal', 'closed_day'));

create or replace function public.claim_ingest_batch_reprocess(
  p_batch_id uuid,
  p_actor_id uuid,
  p_processing_token uuid,
  p_lease_seconds integer,
  p_confirm_closed_day boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.app_users;
  v_client public.clients;
  v_device public.ingest_devices;
  v_batch public.ingest_batches;
  v_daily public.daily_imports;
  v_now timestamptz := clock_timestamp();
  v_retry integer;
begin
  if p_batch_id is null or p_actor_id is null or p_processing_token is null
    or p_lease_seconds not between 30 and 600
    or length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception 'invalid_batch_reprocess' using errcode = '22023';
  end if;

  select app_user.* into v_actor from public.app_users as app_user
  where app_user.id = p_actor_id for update;
  if not found or v_actor.role is distinct from 'Manager' or v_actor.status is distinct from 'Active' then
    raise exception 'manager_permission_required' using errcode = '42501';
  end if;

  select batch.* into v_batch from public.ingest_batches as batch where batch.id = p_batch_id;
  if not found then raise exception 'batch_not_found' using errcode = 'P0002'; end if;
  select client.* into v_client from public.clients as client where client.id = v_batch.client_id for update;
  if not found then raise exception 'batch_not_found' using errcode = 'P0002'; end if;
  select device.* into v_device from public.ingest_devices as device where device.id = v_batch.device_id for update;
  if not found or v_device.client_id is distinct from v_client.id then
    raise exception 'invalid_batch_reprocess' using errcode = 'P0001';
  end if;
  select batch.* into v_batch from public.ingest_batches as batch where batch.id = p_batch_id for update;

  if p_confirm_closed_day then
    select daily.* into v_daily from public.daily_imports as daily
    where daily.client_id = v_batch.client_id
      and daily.trading_date = v_batch.trading_date and daily.status = 'Closed';
    if not found then raise exception 'closed_day_required' using errcode = 'P0001'; end if;
  end if;

  if v_batch.status in ('processed', 'replaced') then
    return jsonb_build_object('outcome', 'terminal', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
  end if;
  if v_batch.status = 'processing' and v_batch.processing_lease_expires_at > v_now then
    v_retry := greatest(1, ceil(extract(epoch from (v_batch.processing_lease_expires_at - v_now)))::integer);
    return jsonb_build_object('outcome', 'busy', 'retry_after_seconds', v_retry, 'batch', to_jsonb(v_batch));
  end if;
  if v_batch.status not in ('failed', 'incomplete', 'late_closed_day', 'processing')
    or (v_batch.status = 'late_closed_day' and p_confirm_closed_day is not true) then
    raise exception 'batch_not_replayable' using errcode = 'P0001';
  end if;

  update public.ingest_batches set
    status = 'processing', processing_token = p_processing_token,
    processing_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    processing_attempts = processing_attempts + 1, error_code = null, error_detail = null,
    reprocess_mode = case when p_confirm_closed_day then 'closed_day' else 'normal' end
  where id = p_batch_id returning * into v_batch;

  insert into public.audit_logs(user_id, entity_type, entity_id, action, after_data)
  values (p_actor_id, 'ingest_batch', p_batch_id, 'ingest_batch_reprocess_started',
    jsonb_build_object('clientId', v_batch.client_id, 'deviceId', v_batch.device_id,
      'batchId', v_batch.id, 'tradingDate', v_batch.trading_date,
      'closedDayReplacement', p_confirm_closed_day, 'reason', btrim(p_reason),
      'processingAttempt', v_batch.processing_attempts));
  return jsonb_build_object('outcome', 'owned', 'retry_after_seconds', 0, 'batch', to_jsonb(v_batch));
end;
$function$;

revoke all on function public.claim_ingest_batch_reprocess(uuid, uuid, uuid, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_ingest_batch_reprocess(uuid, uuid, uuid, integer, boolean, text) to service_role;

create or replace function public.persist_closed_auto_daily_import_replacement(
  p_client_id uuid,
  p_source_batch_id uuid,
  p_processing_token uuid,
  p_actor_id uuid,
  p_reason text,
  p_import_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.app_users;
  v_client public.clients;
  v_device public.ingest_devices;
  v_batch public.ingest_batches;
  v_daily public.daily_imports;
  v_prior_batch_id uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception 'invalid_closed_day_replacement' using errcode = '22023';
  end if;
  select app_user.* into v_actor from public.app_users as app_user where app_user.id = p_actor_id for update;
  if not found or v_actor.role is distinct from 'Manager' or v_actor.status is distinct from 'Active' then
    raise exception 'manager_permission_required' using errcode = '42501';
  end if;
  select batch.* into v_batch from public.ingest_batches as batch where batch.id = p_source_batch_id;
  if not found then raise exception 'processing_lease_lost' using errcode = 'P0001'; end if;
  select client.* into v_client from public.clients as client where client.id = p_client_id for update;
  if not found then raise exception 'processing_lease_lost' using errcode = 'P0001'; end if;
  select device.* into v_device from public.ingest_devices as device where device.id = v_batch.device_id for update;
  if not found or v_device.client_id is distinct from p_client_id then
    raise exception 'processing_lease_lost' using errcode = 'P0001';
  end if;
  select batch.* into v_batch from public.ingest_batches as batch where batch.id = p_source_batch_id for update;
  if not found or v_batch.client_id is distinct from p_client_id
    or v_batch.status is distinct from 'processing'
    or v_batch.processing_token is distinct from p_processing_token
    or v_batch.processing_lease_expires_at <= clock_timestamp() then
    raise exception 'processing_lease_lost' using errcode = 'P0001';
  end if;
  select daily.* into v_daily from public.daily_imports as daily
  where daily.client_id = p_client_id and daily.trading_date = v_batch.trading_date for update;
  if not found or v_daily.status is distinct from 'Closed' then
    raise exception 'closed_day_required' using errcode = 'P0001';
  end if;
  v_prior_batch_id := v_daily.source_batch_id;
  if v_prior_batch_id is not distinct from p_source_batch_id then
    return jsonb_build_object('daily_import', to_jsonb(v_daily), 'prior_batch_id', v_prior_batch_id, 'already_applied', true);
  end if;

  -- Temporarily make the row writable only inside this transaction. Any error
  -- rolls the status and all replacement writes back atomically.
  update public.daily_imports set status = 'Manager replacement in progress' where id = v_daily.id;
  v_daily := public.persist_auto_daily_import(p_client_id, p_source_batch_id, p_import_result);
  update public.daily_imports set status = 'Closed', imported_by_user_id = p_actor_id,
    updated_at = clock_timestamp() where id = v_daily.id returning * into v_daily;

  insert into public.operational_flags(daily_import_id, client_id, type, severity, message, status)
  values (v_daily.id, p_client_id, 'Closed day automatically replaced', 'Critical',
    'A Manager explicitly replaced a closed day from an immutable automatic snapshot. Review the audit log.', 'Open');
  insert into public.audit_logs(user_id, entity_type, entity_id, action, after_data)
  values (p_actor_id, 'ingest_batch', p_source_batch_id, 'closed_day_auto_snapshot_replaced',
    jsonb_build_object('clientId', p_client_id, 'batchId', p_source_batch_id,
      'priorBatchId', v_prior_batch_id, 'dailyImportId', v_daily.id,
      'tradingDate', v_batch.trading_date, 'reason', btrim(p_reason)));
  return jsonb_build_object('daily_import', to_jsonb(v_daily), 'prior_batch_id', v_prior_batch_id);
end;
$function$;

revoke all on function public.persist_closed_auto_daily_import_replacement(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.persist_closed_auto_daily_import_replacement(uuid, uuid, uuid, uuid, text, jsonb) to service_role;

commit;
