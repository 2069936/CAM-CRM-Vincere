-- Preserve the selected Realized/Gross PnL policy as aggregate, redacted audit evidence.
-- Run after step_29_auto_collection_reprocess.sql.
begin;

create or replace function public.normalize_auto_pnl_source_summary(p_summary jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $function$
declare
  v_key text;
  v_value numeric;
begin
  if jsonb_typeof(p_summary) is distinct from 'object' then
    raise exception 'invalid_pnl_source_summary' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_summary)
  loop
    if v_key not in ('realized', 'gross_fallback', 'gross_missing_realized', 'unavailable', 'unknown')
      or jsonb_typeof(p_summary -> v_key) is distinct from 'number' then
      raise exception 'invalid_pnl_source_summary' using errcode = '22023';
    end if;
    v_value := (p_summary ->> v_key)::numeric;
    if v_value < 0 or v_value > 1000000 or trunc(v_value) <> v_value then
      raise exception 'invalid_pnl_source_summary' using errcode = '22023';
    end if;
  end loop;
  return jsonb_build_object(
    'realized', coalesce((p_summary ->> 'realized')::bigint, 0),
    'gross_fallback', coalesce((p_summary ->> 'gross_fallback')::bigint, 0),
    'gross_missing_realized', coalesce((p_summary ->> 'gross_missing_realized')::bigint, 0),
    'unavailable', coalesce((p_summary ->> 'unavailable')::bigint, 0),
    'unknown', coalesce((p_summary ->> 'unknown')::bigint, 0)
  );
end;
$function$;

revoke all on function public.normalize_auto_pnl_source_summary(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.persist_auto_daily_import_v3(
  p_client_id uuid,
  p_source_batch_id uuid,
  p_processing_token uuid,
  p_import_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_result jsonb;
  v_daily public.daily_imports;
  v_pnl_sources jsonb;
begin
  v_result := public.persist_auto_daily_import_v2(
    p_client_id, p_source_batch_id, p_processing_token, p_import_result
  );
  if v_result ->> 'disposition' is distinct from 'persisted' then
    return v_result;
  end if;

  v_pnl_sources := public.normalize_auto_pnl_source_summary(p_import_result -> 'pnlSourceSummary');
  update public.daily_imports
  set source_summary = coalesce(source_summary, '{}'::jsonb)
      || jsonb_build_object('pnl_sources', v_pnl_sources),
      updated_at = clock_timestamp()
  where id = (v_result #>> '{daily_import,id}')::uuid
    and client_id = p_client_id
    and source_batch_id = p_source_batch_id
  returning * into v_daily;
  if not found then
    raise exception 'invalid_auto_daily_import' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.audit_logs
    where entity_type = 'ingest_batch' and entity_id = p_source_batch_id
      and action = 'auto_pnl_source_summary_recorded'
  ) then
    insert into public.audit_logs(user_id, entity_type, entity_id, action, after_data)
    values (null, 'ingest_batch', p_source_batch_id, 'auto_pnl_source_summary_recorded',
      jsonb_build_object('batchId', p_source_batch_id, 'dailyImportId', v_daily.id,
        'pnlSources', v_pnl_sources));
  end if;
  return jsonb_set(v_result, '{daily_import}', to_jsonb(v_daily), true);
end;
$function$;

revoke all on function public.persist_auto_daily_import_v3(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_auto_daily_import_v3(uuid, uuid, uuid, jsonb)
  to service_role;
revoke execute on function public.persist_auto_daily_import_v2(uuid, uuid, uuid, jsonb)
  from service_role;

create or replace function public.persist_closed_auto_daily_import_replacement_v2(
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
  v_result jsonb;
  v_daily public.daily_imports;
  v_pnl_sources jsonb;
begin
  v_result := public.persist_closed_auto_daily_import_replacement(
    p_client_id, p_source_batch_id, p_processing_token, p_actor_id, p_reason, p_import_result
  );
  v_pnl_sources := public.normalize_auto_pnl_source_summary(p_import_result -> 'pnlSourceSummary');
  update public.daily_imports
  set source_summary = coalesce(source_summary, '{}'::jsonb)
      || jsonb_build_object('pnl_sources', v_pnl_sources),
      updated_at = clock_timestamp()
  where id = (v_result #>> '{daily_import,id}')::uuid
    and client_id = p_client_id
    and source_batch_id = p_source_batch_id
  returning * into v_daily;
  if not found then
    raise exception 'invalid_closed_day_replacement' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.audit_logs
    where entity_type = 'ingest_batch' and entity_id = p_source_batch_id
      and action = 'auto_pnl_source_summary_recorded'
  ) then
    insert into public.audit_logs(user_id, entity_type, entity_id, action, after_data)
    values (p_actor_id, 'ingest_batch', p_source_batch_id, 'auto_pnl_source_summary_recorded',
      jsonb_build_object('batchId', p_source_batch_id, 'dailyImportId', v_daily.id,
        'pnlSources', v_pnl_sources, 'closedDayReplacement', true));
  end if;
  return jsonb_set(v_result, '{daily_import}', to_jsonb(v_daily), true);
end;
$function$;

revoke all on function public.persist_closed_auto_daily_import_replacement_v2(
  uuid, uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_closed_auto_daily_import_replacement_v2(
  uuid, uuid, uuid, uuid, text, jsonb
) to service_role;
revoke execute on function public.persist_closed_auto_daily_import_replacement(
  uuid, uuid, uuid, uuid, text, jsonb
) from service_role;

commit;
