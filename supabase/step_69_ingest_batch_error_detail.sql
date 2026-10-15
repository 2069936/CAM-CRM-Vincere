-- Step 69: a close the CRM refuses as an invalid snapshot says why, on the
-- batch, where the failed closes panel can read it.
--
-- WHY 69. 68 is applied. 54 is still a deliberate gap. This file needs step 45
-- (finalize_ingest_batch_v3, the finalize the ingest route calls) and step 28
-- (ingest_batches.error_detail) and says so if either is missing.
--
-- THE GAP. Automatic closes were refused at the normalize stage with
-- error_code invalid_auto_import_snapshot: 2 on 2026-10-08, 6 on 10-09, 1 on
-- 10-13 and 4 on 10-14. The validator that refused them knows exactly which
-- rule each row broke (AutoImportValidationError.errors in
-- src/domain/autoImport.js), and the route kept none of it: it finalizes the
-- batch with the code alone. ingest_batches.error_detail has existed since
-- step 28 and has never been written: finalize_ingest_batch sets it NULL and
-- step 29's replay claim clears it. Nobody could say why those closes were
-- refused without downloading the snapshot and running the validator by hand.
--
-- WHAT THIS FILE ADDS, and only this:
--
--   public.record_ingest_batch_error_detail(p_batch_id uuid, p_detail text)
--   returns boolean. Security definer, search_path pinned. It sets
--   error_detail on ONE batch and returns true, only when that batch exists,
--   its status is 'failed' and its error_code is invalid_auto_import_snapshot
--   or unsupported_schema_version, the two codes the validator writes.
--   Anything else (a batch still processing, processed, or failed for a
--   database or storage reason) returns false and changes nothing. The detail
--   has its control characters replaced by spaces, is trimmed, and is cut to
--   2000 characters; an empty detail returns false and writes nothing.
--
-- WHAT WRITES THE TEXT. The ingest route (server/autoCollection/ingest
-- /daily.js) and the replay (server/autoCollection/admin/ingest-reprocess.js)
-- call it right after the finalize that marks the batch failed, with
-- validationReasonSummary (src/domain/autoImportValidationReason.js): the
-- unique rules broken, the first twelve, joined with "; ", and "(+N more)".
-- A rule names a field path and, in one rule, an account name; never a
-- balance, a price or free text. Best effort: if this function is missing or
-- fails, the route logs it and answers exactly as before.
--
-- WHAT IS NOT CHANGED. finalize_ingest_batch_v3 and everything under it: the
-- finalize still sets error_detail NULL and the replay claim still clears it,
-- so a replay starts clean and a detail is only ever the latest attempt's.
-- No table, column, policy or trigger is added; ingest_batches keeps nothing
-- for anon or authenticated (step 56).
--
-- GRANTS. EXECUTE for service_role only, the role both routes run as;
-- revoked from public, anon and authenticated explicitly, because a function
-- in public is born executable by both (step 56's header explains the
-- default privilege that does it).
--
-- RE-RUNNING THIS FILE changes nothing: create or replace, and the grants
-- restated. It touches no rows.
--
-- CHECK AFTERWARDS (read only):
--
--   select id, trading_date, error_code, error_detail from public.ingest_batches
--    where status = 'failed' and error_code in ('invalid_auto_import_snapshot', 'unsupported_schema_version')
--    order by received_at desc limit 20;

do $step69_guard$
begin
  if to_regprocedure('public.finalize_ingest_batch_v3(uuid, uuid, uuid, uuid, text, uuid, timestamptz, boolean, text, jsonb, jsonb, text, jsonb, integer)') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'ingest_batches' and column_name = 'error_detail'
    ) then
    raise exception 'step 69 needs step 45 (finalize_ingest_batch_v3, ingest_batches.error_detail): run it first';
  end if;
end
$step69_guard$;

begin;

create or replace function public.record_ingest_batch_error_detail(p_batch_id uuid, p_detail text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_detail text;
  v_written integer;
begin
  if p_batch_id is null or p_detail is null then
    return false;
  end if;

  -- Control characters (C0, DEL and C1) become spaces, then trim, then cut,
  -- then trim again so the cut never leaves a trailing space.
  v_detail := btrim(left(btrim(regexp_replace(p_detail, '[\u0001-\u001F\u007F-\u009F]', ' ', 'g')), 2000));
  if v_detail = '' then
    return false;
  end if;

  update public.ingest_batches
     set error_detail = v_detail
   where id = p_batch_id
     and status = 'failed'
     and error_code in ('invalid_auto_import_snapshot', 'unsupported_schema_version');
  get diagnostics v_written = row_count;
  return v_written > 0;
end;
$function$;

revoke all on function public.record_ingest_batch_error_detail(uuid, text) from public, anon, authenticated;
grant execute on function public.record_ingest_batch_error_detail(uuid, text) to service_role;

commit;
