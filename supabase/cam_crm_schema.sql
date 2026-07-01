-- CAM CRM Supabase schema
-- Run this first in Supabase SQL Editor.

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

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  legacy_key text unique,
  name text not null,
  status text default 'Active',
  stage text default 'Active',
  pinned boolean default false,
  pinned_note text,
  notes text,
  full_name text,
  email text,
  phone text,
  timezone text,
  prop_firm text,
  messenger text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create table if not exists public.client_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  cam_profile_id uuid not null references public.cam_profiles(id) on delete cascade,
  assignment_role text default 'Owner',
  assigned_at timestamptz default now(),
  unique (client_id, cam_profile_id)
);

create table if not exists public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  legacy_key text,
  account_name text not null,
  alias text,
  connection text,
  account_type text default 'Unassigned',
  status text default 'Active',
  payout_state text default 'Not requested',
  start_balance numeric,
  target_profit numeric,
  max_drawdown_limit numeric,
  bullet_bot_pass_type text,
  bullet_bot_direction text,
  algo_stack text,
  daily_loss_limit text,
  notes text,
  date_added date,
  date_funded date,
  date_failed date,
  date_last_payout date,
  payout_count integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (client_id, account_name)
);

create table if not exists public.daily_imports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  legacy_key text unique,
  trading_date date not null,
  imported_by_user_id uuid references public.app_users(id) on delete set null,
  imported_at timestamptz default now(),
  status text default 'Needs review',
  source_summary jsonb default '{}'::jsonb,
  raw_file_batch_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (client_id, trading_date)
);

create table if not exists public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  account_name text not null,
  connection text,
  gross_realized_pnl numeric default 0,
  trailing_max_drawdown numeric default 0,
  account_balance numeric default 0,
  weekly_pnl numeric default 0,
  unrealized_pnl numeric default 0,
  created_at timestamptz default now(),
  unique (daily_import_id, account_name)
);

create table if not exists public.strategy_snapshots (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  account_snapshot_id uuid references public.account_snapshots(id) on delete cascade,
  strategy_name text,
  strategy_family text,
  strategy_version text,
  instrument text,
  data_series text,
  parameters_raw text,
  params_parsed jsonb default '{}'::jsonb,
  direction text,
  enabled boolean default false,
  realized numeric default 0,
  unrealized numeric default 0,
  config_match jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  external_order_id text,
  strategy_name text,
  instrument text,
  action text,
  order_type text,
  quantity numeric,
  limit_price numeric,
  stop_price numeric,
  state text,
  filled numeric,
  avg_price numeric,
  remaining numeric,
  name text,
  time_text text,
  created_at timestamptz default now()
);

create table if not exists public.executions (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  external_execution_id text,
  external_order_id text,
  strategy_name text,
  instrument text,
  action text,
  quantity numeric,
  price numeric,
  time_text text,
  entry_exit text,
  position text,
  name text,
  commission numeric,
  rate numeric,
  connection text,
  created_at timestamptz default now()
);

create table if not exists public.operational_flags (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid references public.daily_imports(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  type text not null,
  severity text not null default 'Warning',
  message text not null,
  status text default 'Open',
  resolved_by_user_id uuid references public.app_users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  legacy_key text unique,
  client_id uuid not null references public.clients(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  text text not null,
  priority text default 'Normal',
  due_date date,
  done boolean default false,
  done_at timestamptz,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  legacy_key text unique,
  client_id uuid not null references public.clients(id) on delete cascade,
  trading_account_id uuid references public.trading_accounts(id) on delete set null,
  type text not null,
  text text not null,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.client_credentials (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique not null references public.clients(id) on delete cascade,
  ip text,
  username text,
  password_encrypted text,
  nt_login text,
  firm_login text,
  firm_password_encrypted text,
  notes text,
  updated_at timestamptz default now()
);

create table if not exists public.price_checks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  check_date date not null,
  instrument text,
  time_label text,
  price numeric,
  connection_status text,
  algo_status text,
  notes text,
  checked_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.payout_events (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete cascade,
  payout_date date not null,
  amount numeric,
  state text,
  note text,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  daily_import_id uuid references public.daily_imports(id) on delete set null,
  report_type text not null,
  report_date date,
  content jsonb default '{}'::jsonb,
  generated_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.app_users(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_clients_name on public.clients(name);
create index if not exists idx_client_assignments_cam on public.client_assignments(cam_profile_id);
create index if not exists idx_client_assignments_client on public.client_assignments(client_id);
create index if not exists idx_trading_accounts_client on public.trading_accounts(client_id);
create index if not exists idx_daily_imports_client_date on public.daily_imports(client_id, trading_date desc);
create index if not exists idx_account_snapshots_import on public.account_snapshots(daily_import_id);
create index if not exists idx_strategy_snapshots_import on public.strategy_snapshots(daily_import_id);
create index if not exists idx_orders_import_order_id on public.orders(daily_import_id, external_order_id);
create index if not exists idx_executions_import_order_id on public.executions(daily_import_id, external_order_id);
create index if not exists idx_flags_client_status on public.operational_flags(client_id, status);
create index if not exists idx_tasks_client_done on public.tasks(client_id, done);
create index if not exists idx_activity_client_created on public.activity_logs(client_id, created_at desc);

