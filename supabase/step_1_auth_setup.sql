-- Step 1: Supabase Auth mapping for CAM CRM
--
-- Important:
-- 1) Create Auth users first in Supabase Dashboard:
--    Authentication -> Users -> Add user
-- 2) Use the same emails listed in this file.
-- 3) Then run this SQL in Supabase SQL Editor.
--
-- Recommended demo Auth users:
-- manager@vinceretrading.com  / demo123456
-- pedro@vinceretrading.com    / pedro123456
-- amanda@vinceretrading.com   / amanda123456
-- juan@vinceretrading.com     / juan123456
-- ed@vinceretrading.com       / ed123456
-- sarah@vinceretrading.com    / sarah123456

create extension if not exists "pgcrypto";

create table if not exists public.cam_profiles (
  id uuid primary key default gen_random_uuid(),
  legacy_key text unique,
  name text not null,
  role_title text,
  status text default 'Active',
  monthly_goal numeric default 0,
  live boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  legacy_key text unique,
  auth_user_id uuid unique,
  username text unique not null,
  display_name text not null,
  email text,
  role text not null check (role in ('Manager', 'CAM')),
  cam_profile_id uuid references public.cam_profiles(id) on delete set null,
  last_active_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.app_users add column if not exists auth_user_id uuid;
alter table public.app_users add column if not exists email text;
alter table public.app_users add column if not exists last_active_at timestamptz;

create unique index if not exists idx_app_users_auth_user_id_unique
  on public.app_users(auth_user_id)
  where auth_user_id is not null;

create unique index if not exists idx_app_users_email_unique
  on public.app_users(lower(email))
  where email is not null;

-- Ensure CAM profiles exist.
insert into public.cam_profiles (legacy_key, name, role_title, status, live)
values
  ('am-pedro', 'Pedro', 'Senior CAM', 'Active', true),
  ('am-amanda', 'Amanda', 'CAM', 'Active', true),
  ('am-juan', 'Juan Pablo', 'CAM', 'Active', true),
  ('am-ed', 'Ed', 'CAM', 'Active', true),
  ('am-sarah', 'Sarah', 'Junior CAM', 'Training', true)
on conflict (legacy_key) do update set
  name = excluded.name,
  role_title = excluded.role_title,
  status = excluded.status,
  live = excluded.live,
  updated_at = now();

-- Ensure public app profiles exist.
insert into public.app_users (legacy_key, username, display_name, email, role, cam_profile_id)
values
  ('user-manager', 'manager', 'Manager', 'manager@vinceretrading.com', 'Manager', null),
  ('user-pedro', 'pedro', 'Pedro', 'pedro@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-pedro')),
  ('user-amanda', 'amanda', 'Amanda', 'amanda@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-amanda')),
  ('user-juan', 'juan', 'Juan Pablo', 'juan@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-juan')),
  ('user-ed', 'ed', 'Ed', 'ed@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-ed')),
  ('user-sarah', 'sarah', 'Sarah', 'sarah@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-sarah'))
on conflict (legacy_key) do update set
  username = excluded.username,
  display_name = excluded.display_name,
  email = excluded.email,
  role = excluded.role,
  cam_profile_id = excluded.cam_profile_id,
  updated_at = now();

-- Link public.app_users to Supabase Auth users by email.
-- This only works after Auth users are created.
update public.app_users app
set
  auth_user_id = auth.id,
  updated_at = now()
from auth.users auth
where lower(auth.email) = lower(app.email)
  and app.auth_user_id is distinct from auth.id;

-- Helper view for checking auth mapping.
create or replace view public.auth_mapping_status as
select
  app.id,
  app.legacy_key,
  app.username,
  app.display_name,
  app.email,
  app.role,
  cp.legacy_key as cam_profile_key,
  cp.name as cam_profile_name,
  app.auth_user_id,
  case when app.auth_user_id is null then false else true end as linked_to_auth,
  auth.email_confirmed_at,
  auth.last_sign_in_at
from public.app_users app
left join public.cam_profiles cp on cp.id = app.cam_profile_id
left join auth.users auth on auth.id = app.auth_user_id
order by
  case app.role when 'Manager' then 0 else 1 end,
  app.display_name;

-- Helper function for frontend/RLS later.
create or replace function public.current_app_user()
returns table (
  id uuid,
  auth_user_id uuid,
  username text,
  display_name text,
  email text,
  role text,
  cam_profile_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    app.id,
    app.auth_user_id,
    app.username,
    app.display_name,
    app.email,
    app.role,
    app.cam_profile_id
  from public.app_users app
  where app.auth_user_id = auth.uid()
  limit 1;
$$;

grant execute on function public.current_app_user() to anon, authenticated;

-- Verification 1: all app users and auth link status.
select * from public.auth_mapping_status;

-- Verification 2: should return zero rows after all Auth users are created and linked.
select
  legacy_key,
  username,
  email,
  role
from public.app_users
where auth_user_id is null
order by username;

