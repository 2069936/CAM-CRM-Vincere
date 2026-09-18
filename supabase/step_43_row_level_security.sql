-- Step 43: Row Level Security on every table the CRM keeps.
--
-- THE DOOR THAT WAS OPEN.
--
-- The publishable key ships inside the frontend bundle; that is how Supabase
-- works and it is fine, because Row Level Security is supposed to decide what
-- that key can see. On this project only the auto collection tables and two
-- newer tables had RLS. Everything else, clients, trading_accounts,
-- account_snapshots, app_users, reports, audit_logs, client_credentials, could
-- be read and written by anyone holding the URL, with no session at all. That
-- was verified from outside the app on 2026-09-18.
--
-- WHAT THIS DOES. Enables RLS on every table in public that does not have it
-- yet and gives signed in users (the authenticated role) exactly what they had:
-- full read and write. The CRM's own permission model lives in the app and in
-- the server endpoints, which use the service role and bypass RLS; nothing
-- they do changes. What changes is that the publishable key alone now sees no
-- rows and writes nothing.
--
-- WHAT IT LEAVES ALONE. Tables that already have RLS keep their own policies
-- (the ingest tables deny the browser on purpose). Views get security_invoker
-- so they stop bypassing the tables' policies, and lose their anon grant.
--
-- THE ONE ANONYMOUS PATH. Signing in by username looks the email up in
-- app_users before there is a session. That read moves into
-- login_email_for_username, a security definer function that returns the
-- email for one username and nothing else, callable by anon.
--
-- Idempotent: safe to run again.

do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and not rowsecurity
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t.tablename
        and policyname = 'authenticated full access'
    ) then
      execute format(
        'create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)',
        t.tablename);
    end if;
  end loop;
end $$;

-- Views run as their owner by default and would hand the rows back to anon
-- regardless of the tables' policies. security_invoker makes them obey the
-- caller's policies; the anon grant is removed as well.
do $$
declare
  v record;
begin
  for v in select viewname from pg_views where schemaname = 'public' loop
    execute format('alter view public.%I set (security_invoker = true)', v.viewname);
    execute format('revoke all on public.%I from anon', v.viewname);
  end loop;
end $$;

-- Username sign in: the only thing the browser needs before a session exists.
create or replace function public.login_email_for_username(p_username text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select email
  from public.app_users
  where lower(username) = lower(btrim(coalesce(p_username, '')))
    and coalesce(status, 'Active') <> 'Inactive'
  limit 1
$$;

revoke all on function public.login_email_for_username(text) from public;
grant execute on function public.login_email_for_username(text) to anon, authenticated;

-- What this leaves: no table in public without RLS.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 43 left % table(s) without row level security', n;
  end if;
end $$;
