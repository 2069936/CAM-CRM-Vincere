-- Step 24: client acknowledgement forms (upload + verify).
--
-- Prepares storage + metadata for the "upload the filled acknowledgement form
-- and keep it on file" half of the Credentials & Notes -> Forms section. The
-- download-blank-template half needs none of this (it is a static asset in
-- public/templates/). This migration is NOT yet wired to any frontend code; run
-- it when the upload feature is built.
--
-- Coordinate with Natanel: this is the project's FIRST use of Supabase Storage,
-- so it introduces a bucket + storage RLS policies. Confirm the private bucket
-- exists (create it in the dashboard if the insert below is not permitted).

-- 1) Private bucket for client forms (dashboard: Storage -> New bucket, private).
insert into storage.buckets (id, name, public)
values ('client-forms', 'client-forms', false)
on conflict (id) do nothing;

-- 2) Storage policies: signed-in (authenticated) users may read/write objects in
--    the client-forms bucket. RLS is otherwise not enabled in this project yet,
--    so tighten these later if per-client scoping is required.
--
--    GUARDED, because the runbook's own first line says every file here is safe
--    to re-run and this one was not: a bare `create policy` on an existing
--    policy raises, so a second pass over supabase/ in order died here with
--    `policy "client-forms authenticated read" for table "objects" already
--    exists`. Same shape as the guard step 48 uses. `create policy` has no
--    `if not exists` clause, which is why this is a do block and not a flag.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'client-forms authenticated read'
  ) then
    create policy "client-forms authenticated read"
      on storage.objects for select
      to authenticated
      using (bucket_id = 'client-forms');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'client-forms authenticated write'
  ) then
    create policy "client-forms authenticated write"
      on storage.objects for insert
      to authenticated
      with check (bucket_id = 'client-forms');
  end if;
end $$;

-- 3) Metadata columns on client_credentials so the tab can show "on file"
--    status without listing storage. Thread these through credentialsToDb and
--    the load mapping in src/domain/supabaseStore.js when wiring the UI.
alter table public.client_credentials
  add column if not exists acknowledgement_form_path text,
  add column if not exists acknowledgement_form_name text,
  add column if not exists acknowledgement_form_uploaded_at timestamptz;
