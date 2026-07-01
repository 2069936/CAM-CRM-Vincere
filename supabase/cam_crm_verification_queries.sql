-- CAM CRM verification and starter queries
-- Run after cam_crm_schema.sql and cam_crm_seed_demo.sql.

-- 1) Smoke counts. Expected after seed:
-- cam_profiles: 5
-- app_users: 6
-- clients: 6
-- trading_accounts: 17
-- daily_imports: 42
-- account_snapshots: 119
-- strategy_snapshots: 98
-- operational_flags: 10
select 'cam_profiles' as table_name, count(*) from public.cam_profiles
union all select 'app_users', count(*) from public.app_users
union all select 'clients', count(*) from public.clients
union all select 'client_assignments', count(*) from public.client_assignments
union all select 'trading_accounts', count(*) from public.trading_accounts
union all select 'daily_imports', count(*) from public.daily_imports
union all select 'account_snapshots', count(*) from public.account_snapshots
union all select 'strategy_snapshots', count(*) from public.strategy_snapshots
union all select 'executions', count(*) from public.executions
union all select 'operational_flags', count(*) from public.operational_flags
union all select 'tasks', count(*) from public.tasks
union all select 'activity_logs', count(*) from public.activity_logs
union all select 'payout_events', count(*) from public.payout_events
order by table_name;

-- 2) Clients assigned to one CAM.
select
  cp.name as cam_name,
  ca.assignment_role,
  c.name as client_name,
  c.status,
  c.stage
from public.client_assignments ca
join public.cam_profiles cp on cp.id = ca.cam_profile_id
join public.clients c on c.id = ca.client_id
where cp.legacy_key = 'am-pedro'
order by c.name;

-- 3) Latest import per client.
select distinct on (c.id)
  c.name as client_name,
  di.trading_date,
  di.status,
  count(f.id) filter (where f.status = 'Open') as open_flags
from public.clients c
join public.daily_imports di on di.client_id = c.id
left join public.operational_flags f on f.daily_import_id = di.id
group by c.id, c.name, di.id, di.trading_date, di.status
order by c.id, di.trading_date desc;

-- 4) Manager overview rollup by CAM.
with latest_imports as (
  select distinct on (client_id)
    id,
    client_id,
    trading_date,
    status
  from public.daily_imports
  order by client_id, trading_date desc
),
cam_clients as (
  select
    cp.id as cam_id,
    cp.name as cam_name,
    c.id as client_id,
    c.name as client_name
  from public.cam_profiles cp
  join public.client_assignments ca on ca.cam_profile_id = cp.id
  join public.clients c on c.id = ca.client_id
)
select
  cc.cam_name,
  count(distinct cc.client_id) as clients,
  count(distinct aps.trading_account_id) as accounts,
  coalesce(sum(aps.gross_realized_pnl), 0) as daily_pnl,
  coalesce(sum(aps.weekly_pnl), 0) as weekly_pnl,
  count(distinct f.id) filter (where f.status = 'Open') as open_flags
from cam_clients cc
left join latest_imports li on li.client_id = cc.client_id
left join public.account_snapshots aps on aps.daily_import_id = li.id
left join public.operational_flags f on f.daily_import_id = li.id
group by cc.cam_name
order by weekly_pnl desc;

-- 5) Client workspace rows for one client/date.
select
  c.name as client_name,
  di.trading_date,
  di.status as close_status,
  ta.alias,
  ta.account_name,
  ta.account_type,
  ta.status as account_status,
  ta.payout_state,
  aps.gross_realized_pnl,
  aps.weekly_pnl,
  aps.account_balance,
  aps.trailing_max_drawdown
from public.clients c
join public.daily_imports di on di.client_id = c.id
join public.account_snapshots aps on aps.daily_import_id = di.id
left join public.trading_accounts ta on ta.id = aps.trading_account_id
where c.legacy_key = 'client-rome'
  and di.trading_date = current_date
order by ta.account_type, ta.alias;

-- 6) Strategy drill-down for one account.
select
  c.name as client_name,
  ta.alias,
  ss.strategy_name,
  ss.strategy_family,
  ss.strategy_version,
  ss.instrument,
  ss.enabled,
  ss.realized,
  ss.params_parsed
from public.strategy_snapshots ss
join public.trading_accounts ta on ta.id = ss.trading_account_id
join public.clients c on c.id = ta.client_id
join public.daily_imports di on di.id = ss.daily_import_id
where ta.account_name = 'ROME8801'
  and di.trading_date = current_date;

-- 7) Executions attributed to strategy.
select
  ta.alias,
  e.strategy_name,
  e.time_text,
  e.action,
  e.quantity,
  e.price,
  e.entry_exit,
  e.name
from public.executions e
join public.trading_accounts ta on ta.id = e.trading_account_id
join public.daily_imports di on di.id = e.daily_import_id
where ta.account_name = 'ROME8801'
  and di.trading_date = current_date
order by e.created_at, e.time_text;

-- 8) Open operational flags queue.
select
  f.severity,
  f.type,
  c.name as client_name,
  ta.alias,
  f.message,
  f.status
from public.operational_flags f
join public.clients c on c.id = f.client_id
left join public.trading_accounts ta on ta.id = f.trading_account_id
where f.status = 'Open'
order by
  case f.severity when 'Critical' then 0 when 'Warning' then 1 else 2 end,
  c.name,
  ta.alias;

-- 9) Payout pipeline.
select
  c.name as client_name,
  ta.alias,
  ta.account_name,
  ta.payout_state,
  ta.payout_count,
  ta.date_last_payout,
  coalesce(sum(pe.amount), 0) as lifetime_payout
from public.trading_accounts ta
join public.clients c on c.id = ta.client_id
left join public.payout_events pe on pe.trading_account_id = ta.id
where ta.payout_state <> 'Not requested'
   or exists (select 1 from public.payout_events p where p.trading_account_id = ta.id)
group by c.name, ta.alias, ta.account_name, ta.payout_state, ta.payout_count, ta.date_last_payout
order by c.name, ta.alias;

-- 10) Hard smoke assertions. This returns rows only if something is wrong.
with expected(table_name, expected_count) as (
  values
    ('cam_profiles', 5),
    ('app_users', 6),
    ('clients', 6),
    ('trading_accounts', 17),
    ('daily_imports', 42),
    ('account_snapshots', 119),
    ('strategy_snapshots', 98),
    ('operational_flags', 10)
),
actual(table_name, actual_count) as (
  select 'cam_profiles', count(*) from public.cam_profiles
  union all select 'app_users', count(*) from public.app_users
  union all select 'clients', count(*) from public.clients
  union all select 'trading_accounts', count(*) from public.trading_accounts
  union all select 'daily_imports', count(*) from public.daily_imports
  union all select 'account_snapshots', count(*) from public.account_snapshots
  union all select 'strategy_snapshots', count(*) from public.strategy_snapshots
  union all select 'operational_flags', count(*) from public.operational_flags
)
select
  e.table_name,
  e.expected_count,
  a.actual_count
from expected e
join actual a using (table_name)
where e.expected_count <> a.actual_count;

