-- CAM CRM demo seed data
-- Run after cam_crm_schema.sql.
-- This resets the CAM CRM public tables listed below. Do not run against production data.

truncate table
  public.audit_logs,
  public.reports,
  public.payout_events,
  public.price_checks,
  public.client_credentials,
  public.activity_logs,
  public.tasks,
  public.operational_flags,
  public.executions,
  public.orders,
  public.strategy_snapshots,
  public.account_snapshots,
  public.daily_imports,
  public.trading_accounts,
  public.client_assignments,
  public.clients,
  public.app_users,
  public.cam_profiles
restart identity cascade;

insert into public.cam_profiles (legacy_key, name, role_title, status, live)
values
  ('am-pedro', 'Pedro', 'Senior CAM', 'Active', true),
  ('am-amanda', 'Amanda', 'CAM', 'Active', true),
  ('am-juan', 'Juan Pablo', 'CAM', 'Active', true),
  ('am-ed', 'Ed', 'CAM', 'Active', true),
  ('am-sarah', 'Sarah', 'Junior CAM', 'Training', true);

insert into public.app_users (legacy_key, username, display_name, email, role, cam_profile_id)
values
  ('user-manager', 'manager', 'Manager', 'manager@vinceretrading.com', 'Manager', null),
  ('user-pedro', 'pedro', 'Pedro', 'pedro@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-pedro')),
  ('user-amanda', 'amanda', 'Amanda', 'amanda@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-amanda')),
  ('user-juan', 'juan', 'Juan Pablo', 'juan@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-juan')),
  ('user-ed', 'ed', 'Ed', 'ed@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-ed')),
  ('user-sarah', 'sarah', 'Sarah', 'sarah@vinceretrading.com', 'CAM', (select id from public.cam_profiles where legacy_key = 'am-sarah'));

insert into public.clients (legacy_key, name, status, notes, full_name, email, phone, timezone, prop_firm, messenger)
values
  ('client-rome', 'Rome', 'Active', 'Rome demo account set for manager review.', 'Rome (demo)', 'rome@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@rome_trading'),
  ('client-todd', 'Todd', 'Active', 'Todd demo account set for manager review.', 'Todd (demo)', 'todd@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@todd_trading'),
  ('client-amanda', 'Amanda Capital', 'Active', 'Amanda Capital demo account set for manager review.', 'Amanda Capital (demo)', 'amanda.capital@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@amanda_capital_trading'),
  ('client-blanco', 'Blanco Family', 'Active', 'Blanco Family demo account set for manager review.', 'Blanco Family (demo)', 'blanco.family@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@blanco_family_trading'),
  ('client-ed', 'Ed - Vincere Trading', 'Active', 'Ed - Vincere Trading demo account set for manager review.', 'Ed - Vincere Trading (demo)', 'ed.-.vincere.trading@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@ed_-_vincere_trading_trading'),
  ('client-sarah-training', 'Sarah Training Pool', 'Active', 'Sarah Training Pool demo account set for manager review.', 'Sarah Training Pool (demo)', 'sarah.training.pool@vinceretrading.com', '+1 (312) 555-0100', 'America/Chicago', 'Apex Trader Funding', '@sarah_training_pool_trading');

insert into public.client_assignments (client_id, cam_profile_id, assignment_role)
values
  ((select id from public.clients where legacy_key = 'client-rome'), (select id from public.cam_profiles where legacy_key = 'am-pedro'), 'Owner'),
  ((select id from public.clients where legacy_key = 'client-todd'), (select id from public.cam_profiles where legacy_key = 'am-pedro'), 'Owner'),
  ((select id from public.clients where legacy_key = 'client-blanco'), (select id from public.cam_profiles where legacy_key = 'am-pedro'), 'Owner'),
  ((select id from public.clients where legacy_key = 'client-amanda'), (select id from public.cam_profiles where legacy_key = 'am-amanda'), 'Owner'),
  ((select id from public.clients where legacy_key = 'client-blanco'), (select id from public.cam_profiles where legacy_key = 'am-juan'), 'Backup'),
  ((select id from public.clients where legacy_key = 'client-ed'), (select id from public.cam_profiles where legacy_key = 'am-ed'), 'Owner'),
  ((select id from public.clients where legacy_key = 'client-sarah-training'), (select id from public.cam_profiles where legacy_key = 'am-sarah'), 'Owner');

create temporary table seed_accounts (
  client_key text,
  account_name text,
  alias text,
  connection text,
  account_type text,
  account_status text,
  payout_state text,
  target_profit numeric,
  start_balance numeric,
  max_drawdown_limit numeric,
  bullet_bot_pass_type text,
  bullet_bot_direction text,
  notes text,
  date_added date,
  date_funded date,
  date_failed date,
  date_last_payout date,
  payout_count integer
) on commit drop;

insert into seed_accounts values
  ('client-rome','ROME5298','Live - 5298','Live','Cash','Active','Not requested',null,null,null,null,null,'Cash account: daily, weekly, balance only.','2026-01-15',null,null,null,0),
  ('client-rome','ROME7045','BlueSky - 7045','BlueSky','Funded','Active','Not requested',52000,50000,2500,null,null,null,'2026-02-10','2026-02-24',null,'2026-05-12',2),
  ('client-rome','ROME8801','Lucid - 8801','Lucid','Evaluation - Standard','Active','Not requested',53000,50000,2000,null,null,null,'2026-05-20',null,null,null,0),
  ('client-rome','ROME9002','Tradovate - 9002','Tradovate','Funded','Active','Not requested',52500,50000,4000,null,null,null,'2026-04-01','2026-04-15',null,null,0),
  ('client-todd','TODD5505','BlueSky - 5505','BlueSky','Funded','Payout Hold','Payout requested',52000,50000,2500,null,null,null,'2026-03-05','2026-03-18',null,'2026-04-20',1),
  ('client-todd','TODD7712','Apex - 7712','Apex','Evaluation - Bullet Bot','Active','Not requested',null,null,1000,'1 Day Pass','Long',null,'2026-06-20',null,null,null,0),
  ('client-todd','TODD7713','Apex - 7713','Apex','Evaluation - Bullet Bot','Failed','Not requested',null,null,1500,'3 Day Pass','Short',null,'2026-06-15',null,'2026-06-24',null,0),
  ('client-amanda','AMAN1024','MFF - 1024','My Funded Futures','Funded','Active','Clear to trade',102000,100000,4000,null,null,null,'2026-01-08','2026-01-22',null,'2026-06-01',3),
  ('client-amanda','AMAN2048','Lucid - 2048','Lucid','Evaluation - Standard','Reserve','Not requested',null,null,2000,null,null,null,'2026-06-01',null,null,null,0),
  ('client-amanda','AMAN9090','Tradeify - 9090','Tradeify','Unassigned','Active','Not requested',null,null,null,null,null,null,'2026-06-22',null,null,null,0),
  ('client-blanco','BLAN3301','Legends - 3301','The Legends Trading','Funded','Active','Not requested',153000,150000,6000,null,null,null,'2026-01-05','2026-01-20',null,'2026-05-28',4),
  ('client-blanco','BLAN3302','Legends - 3302','The Legends Trading','Evaluation - Standard','Active','Not requested',103000,100000,3000,null,null,null,'2026-05-10',null,null,null,0),
  ('client-ed','ED6100','Cash - 6100','Live','Cash','Active','Not requested',null,null,null,null,null,null,'2026-02-01',null,null,null,0),
  ('client-ed','ED6200','BlueSky - 6200','BlueSky','Funded','Inactive','Not requested',null,null,2500,null,null,null,'2026-03-15','2026-04-02','2026-06-10',null,0),
  ('client-sarah-training','SARH4101','Apex - 4101','Apex','Evaluation - Standard','Active','Not requested',53000,50000,2000,null,null,null,'2026-06-10',null,null,null,0),
  ('client-sarah-training','SARH4102','Lucid - 4102','Lucid','Funded','Active','Clear to trade',52000,50000,2500,null,null,null,'2026-04-20','2026-05-05',null,'2026-06-05',1),
  ('client-sarah-training','SARH4103','BlueSky - 4103','BlueSky','Evaluation - Bullet Bot','Reserve','Not requested',null,null,1200,'2 Day Pass','',null,'2026-06-18',null,null,null,0);

insert into public.trading_accounts (
  client_id, legacy_key, account_name, alias, connection, account_type, status, payout_state,
  target_profit, start_balance, max_drawdown_limit, bullet_bot_pass_type, bullet_bot_direction,
  notes, date_added, date_funded, date_failed, date_last_payout, payout_count
)
select
  c.id, sa.account_name, sa.account_name, sa.alias, sa.connection, sa.account_type, sa.account_status, sa.payout_state,
  sa.target_profit, sa.start_balance, sa.max_drawdown_limit, sa.bullet_bot_pass_type, sa.bullet_bot_direction,
  sa.notes, sa.date_added, sa.date_funded, sa.date_failed, sa.date_last_payout, sa.payout_count
from seed_accounts sa
join public.clients c on c.legacy_key = sa.client_key;

insert into public.client_credentials (client_id, ip, username, password_encrypted, nt_login, firm_login, firm_password_encrypted)
select id, '', '', '', '', '', ''
from public.clients;

insert into public.payout_events (trading_account_id, payout_date, amount, state, note)
values
  ((select id from public.trading_accounts where account_name = 'ROME7045'), '2026-03-28', 1800, 'Payout approved', 'First payout'),
  ((select id from public.trading_accounts where account_name = 'ROME7045'), '2026-05-12', 2100, 'Payout approved', 'Second payout'),
  ((select id from public.trading_accounts where account_name = 'TODD5505'), '2026-04-20', 1600, 'Payout approved', 'First payout'),
  ((select id from public.trading_accounts where account_name = 'AMAN1024'), '2026-03-10', 2500, 'Payout approved', 'First payout'),
  ((select id from public.trading_accounts where account_name = 'AMAN1024'), '2026-04-22', 3200, 'Payout approved', 'Second payout'),
  ((select id from public.trading_accounts where account_name = 'AMAN1024'), '2026-06-01', 2800, 'Payout approved', 'Third payout'),
  ((select id from public.trading_accounts where account_name = 'BLAN3301'), '2026-02-15', 3000, 'Payout approved', 'First payout'),
  ((select id from public.trading_accounts where account_name = 'BLAN3301'), '2026-03-22', 3500, 'Payout approved', 'Second payout'),
  ((select id from public.trading_accounts where account_name = 'BLAN3301'), '2026-04-30', 4000, 'Payout approved', 'Third payout'),
  ((select id from public.trading_accounts where account_name = 'BLAN3301'), '2026-05-28', 4200, 'Payout approved', 'Fourth payout'),
  ((select id from public.trading_accounts where account_name = 'SARH4102'), '2026-06-05', 1500, 'Payout approved', 'First payout');

create temporary table seed_snapshot_base (
  client_key text,
  account_name text,
  connection text,
  gross_realized_pnl numeric,
  weekly_pnl numeric,
  account_balance numeric,
  trailing_max_drawdown numeric
) on commit drop;

insert into seed_snapshot_base values
  ('client-rome','ROME5298','Live',640,1820,28450,0),
  ('client-rome','ROME7045','BlueSky',180,320,50500,-1200),
  ('client-rome','ROME8801','Lucid',-330,-577,49670,-1600),
  ('client-rome','ROME9002','Tradovate',0,860,51840,-650),
  ('client-todd','TODD5505','BlueSky',-430,-341,51980,-2200),
  ('client-todd','TODD7712','Apex',0,0,50000,-500),
  ('client-todd','TODD7713','Apex',-1200,-1200,48800,-3000),
  ('client-amanda','AMAN1024','My Funded Futures',220,980,100850,-3100),
  ('client-amanda','AMAN2048','Lucid',0,0,50000,-400),
  ('client-amanda','AMAN9090','Tradeify',0,0,50000,0),
  ('client-blanco','BLAN3301','The Legends Trading',140,410,150620,-4400),
  ('client-blanco','BLAN3302','The Legends Trading',-90,210,99910,-1900),
  ('client-ed','ED6100','Live',720,2140,41200,0),
  ('client-ed','ED6200','BlueSky',0,-120,50000,-800),
  ('client-sarah-training','SARH4101','Apex',310,760,50310,-870),
  ('client-sarah-training','SARH4102','Lucid',-70,-140,49930,-1200),
  ('client-sarah-training','SARH4103','BlueSky',0,0,50000,-300);

insert into public.daily_imports (client_id, legacy_key, trading_date, imported_by_user_id, imported_at, status, source_summary)
select
  c.id,
  c.legacy_key || '-' || (current_date - gs.days_back)::text,
  current_date - gs.days_back,
  (select id from public.app_users where legacy_key = 'user-pedro'),
  (current_date - gs.days_back) + time '22:00',
  case when gs.days_back = 0 then 'Needs review' else 'Closed' end,
  jsonb_build_object('seed', true, 'daysBack', gs.days_back)
from public.clients c
cross join generate_series(6, 0, -1) as gs(days_back);

insert into public.account_snapshots (
  daily_import_id, trading_account_id, account_name, connection,
  gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl, unrealized_pnl
)
select
  di.id,
  ta.id,
  b.account_name,
  b.connection,
  case
    when gs.days_back = 0 then b.gross_realized_pnl
    else round((b.gross_realized_pnl * (0.62 + ((6 - gs.days_back) * 0.08))) + case when ((6 - gs.days_back) % 2 = 0) then 35 else -45 end)
  end,
  b.trailing_max_drawdown,
  case
    when gs.days_back = 0 then b.account_balance
    else b.account_balance + round((b.gross_realized_pnl * (0.62 + ((6 - gs.days_back) * 0.08))) + case when ((6 - gs.days_back) % 2 = 0) then 35 else -45 end)
  end,
  case
    when gs.days_back = 0 then b.weekly_pnl
    else round((b.weekly_pnl * (0.62 + ((6 - gs.days_back) * 0.08))) + (case when ((6 - gs.days_back) % 2 = 0) then 35 else -45 end * ((6 - gs.days_back) + 1)))
  end,
  0
from seed_snapshot_base b
join public.clients c on c.legacy_key = b.client_key
join public.trading_accounts ta on ta.client_id = c.id and ta.account_name = b.account_name
cross join generate_series(6, 0, -1) as gs(days_back)
join public.daily_imports di on di.client_id = c.id and di.trading_date = current_date - gs.days_back;

create temporary table seed_strategy_base (
  account_name text,
  strategy_name text,
  strategy_family text,
  strategy_version text,
  instrument text,
  enabled boolean,
  realized numeric,
  direction text,
  pos_sizes jsonb,
  profit_targets jsonb,
  stop_loss_ticks numeric
) on commit drop;

insert into seed_strategy_base values
  ('ROME5298','2 - OGX-PF-2.4','OGX_PF','2.4','MNQ JUN26',true,220,'Both','[2,2,1]','[100,125,175]',90),
  ('ROME7045','2 - RBO-PF-1.8','RBO_PF','1.8','M2K JUN26',true,180,'Both','[2,2,2]','[155,175,250]',105),
  ('ROME8801','2 - IFSP-1.1','IFSP','1.1','GC AUG26',true,-330,'Both','[3,3,2]','[125,150,200]',100),
  ('ROME9002','2 - OGX-PF-2.4','OGX_PF','2.4','MNQ JUN26',true,220,'Both','[2,2,2]','[155,175,250]',105),
  ('TODD5505','2 - RBO-PF-1.8','RBO_PF','1.8','M2K JUN26',true,-430,'Both','[2,2,2]','[155,175,250]',105),
  ('TODD7712','0 - Bullet Bot-1.1','Bullet Bot','1.1','NQ JUN26',true,0,'Long','[4]','[155]',125),
  ('TODD7713','1 - Bullet Bot-1.1','Bullet Bot','1.1','NQ JUN26',true,-1200,'Short','[1]','[155]',125),
  ('AMAN1024','2 - OGX-PF-2.4','OGX_PF','2.4','MNQ JUN26',true,220,'Both','[2,2,1]','[100,125,175]',90),
  ('BLAN3301','2 - RBO-PF-1.8','RBO_PF','1.8','M2K JUN26',true,180,'Both','[2,2,2]','[155,175,250]',105),
  ('BLAN3302','2 - IFSP-1.1','IFSP','1.1','GC AUG26',true,-330,'Both','[3,3,2]','[125,150,200]',100),
  ('ED6100','2 - OGX-PF-2.4','OGX_PF','2.4','MNQ JUN26',true,220,'Both','[2,2,1]','[100,125,175]',90),
  ('ED6200','2 - RBO-PF-1.8','RBO_PF','1.8','M2K JUN26',true,180,'Both','[2,2,2]','[155,175,250]',105),
  ('SARH4101','2 - B2X-1.3','B2X','1.3','MGC AUG26',true,310,'Both','[2,2,2]','[110,135,190]',95),
  ('SARH4102','2 - URGO-2.0','URGO','2.0','MES JUN26',true,-70,'Both','[1,1,1]','[95,120,160]',80);

insert into public.strategy_snapshots (
  daily_import_id, trading_account_id, account_snapshot_id,
  strategy_name, strategy_family, strategy_version, instrument, direction,
  enabled, realized, unrealized, params_parsed
)
select
  di.id,
  ta.id,
  aps.id,
  sb.strategy_name,
  sb.strategy_family,
  sb.strategy_version,
  sb.instrument,
  sb.direction,
  sb.enabled,
  case
    when gs.days_back = 0 then sb.realized
    else round((sb.realized * (0.62 + ((6 - gs.days_back) * 0.08))) + case when ((6 - gs.days_back) % 2 = 0) then 35 else -45 end)
  end,
  0,
  jsonb_build_object(
    'parsed', true,
    'direction', sb.direction,
    'posSizes', sb.pos_sizes,
    'profitTargets', sb.profit_targets,
    'stopLossTicks', sb.stop_loss_ticks
  )
from seed_strategy_base sb
join public.trading_accounts ta on ta.account_name = sb.account_name
join public.clients c on c.id = ta.client_id
cross join generate_series(6, 0, -1) as gs(days_back)
join public.daily_imports di on di.client_id = c.id and di.trading_date = current_date - gs.days_back
join public.account_snapshots aps on aps.daily_import_id = di.id and aps.account_name = sb.account_name;

create temporary table seed_executions (
  account_name text,
  strategy_name text,
  base_price numeric,
  down boolean
) on commit drop;

insert into seed_executions values
  ('ROME5298','2 - OGX-PF-2.4',19020,false),
  ('ROME7045','2 - RBO-PF-1.8',2950,false),
  ('ROME8801','2 - IFSP-1.1',3350,true),
  ('TODD5505','2 - RBO-PF-1.8',2948,true),
  ('TODD7712','0 - Bullet Bot-1.1',19000,false),
  ('TODD7713','1 - Bullet Bot-1.1',18980,true),
  ('AMAN1024','2 - OGX-PF-2.4',19030,false),
  ('BLAN3301','2 - RBO-PF-1.8',2954,false),
  ('BLAN3302','2 - IFSP-1.1',3354,true),
  ('ED6100','2 - OGX-PF-2.4',19040,false),
  ('ED6200','2 - RBO-PF-1.8',2958,false),
  ('SARH4101','2 - B2X-1.3',3210,false),
  ('SARH4102','2 - URGO-2.0',6120,true);

insert into public.executions (
  daily_import_id, trading_account_id, external_order_id, strategy_name,
  action, quantity, price, time_text, entry_exit, name
)
select di.id, ta.id, se.account_name || '-E1', se.strategy_name, 'Buy', 2, se.base_price, '9:35 AM', 'Entry', 'Entry'
from seed_executions se
join public.trading_accounts ta on ta.account_name = se.account_name
join public.daily_imports di on di.client_id = ta.client_id and di.trading_date = current_date
union all
select di.id, ta.id, se.account_name || '-X1', se.strategy_name, 'Sell', 2, case when se.down then se.base_price - 8 else se.base_price + 11 end, '10:22 AM', 'Exit', 'Exit'
from seed_executions se
join public.trading_accounts ta on ta.account_name = se.account_name
join public.daily_imports di on di.client_id = ta.client_id and di.trading_date = current_date;

insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status)
values
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-rome' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME8801'), 'Drawdown near limit', 'Critical', 'Lucid - 8801 is $400 from its $2,000 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 2000 - 1600 = 400. Immediate action required.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-rome' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME8801'), 'Strategy underperforming peers', 'Warning', 'Lucid - 8801 is below peer average for IFSP 1.1. Calculation: daily realized is compared against same-family instances and flagged when below mean minus 1.5 standard deviations.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-todd' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Drawdown near limit', 'Critical', 'BlueSky - 5505 is $300 from its $2,500 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 2500 - 2200 = 300. Immediate action required.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-todd' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Payout hold violation', 'Critical', 'BlueSky - 5505 is in payout hold but still has an enabled strategy. Calculation: status = Payout Hold and active strategy count > 0.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-todd' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD7713'), 'Bullet Bot failed', 'Critical', 'Apex - 7713 hit failed status after Bullet Bot loss. Calculation: account status manually set to Failed and daily PnL is negative.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-amanda' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-amanda'), (select id from public.trading_accounts where account_name='AMAN9090'), 'Unassigned account', 'Warning', 'Tradeify - 9090 needs account type classification. Calculation: accountType = Unassigned after import.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-amanda' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-amanda'), (select id from public.trading_accounts where account_name='AMAN2048'), 'Expected strategy missing', 'Critical', 'Lucid - 2048 is reserved and has no enabled strategy. Calculation: status reserve excludes expectation, so this is a demo review item for account rotation.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-blanco' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-blanco'), (select id from public.trading_accounts where account_name='BLAN3302'), 'Drawdown approaching limit', 'Warning', 'Legends - 3302 has $1,100 remaining before its $3,000 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 3000 - 1900 = 1100.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-ed' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-ed'), (select id from public.trading_accounts where account_name='ED6200'), 'Unexpected strategy active', 'Critical', 'BlueSky - 6200 is inactive but has an enabled strategy. Calculation: status in Inactive/Reserve/Failed and active strategy count > 0.', 'Open'),
  ((select di.id from public.daily_imports di join public.clients c on c.id = di.client_id where c.legacy_key='client-sarah-training' and di.trading_date=current_date), (select id from public.clients where legacy_key='client-sarah-training'), (select id from public.trading_accounts where account_name='SARH4103'), 'Rotation reserve', 'Warning', 'BlueSky - 4103 is reserved for Bullet Bot rotation and should stay flat until assigned. Calculation: account status = Reserve and enabled strategy count = 0.', 'Open');

insert into public.activity_logs (legacy_key, client_id, trading_account_id, type, text, created_at)
values
  ('act-rome-1', (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME8801'), 'Call', 'Called client. Reviewed IFSP underperformance on Lucid-8801. Client wants to leave strategy running through end of week before switching. Agreed to monitor daily.', now()),
  ('act-rome-2', (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME9002'), 'Note', 'Tradovate-9002 showing $0 P&L despite OGX_PF enabled. Checked VPS - connection dropped around 9:15am. Strategy was flat all day. VPS rebooted and confirmed reconnected.', now() - interval '1 day'),
  ('act-rome-3', (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME7045'), 'Payout', 'BlueSky-7045 second payout approved: $2,500. Client confirmed receipt. Account cleared to trade.', now() - interval '10 days'),
  ('act-rome-4', (select id from public.clients where legacy_key='client-rome'), null, 'Call', 'Onboarding call. Explained evaluation rules, drawdown limits, and daily reporting schedule. Client prefers evening updates via WhatsApp.', now() - interval '74 days'),
  ('act-todd-1', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Alert', 'CRITICAL: BlueSky-5505 drawdown at $300 remaining. Disabled RBO_PF strategy immediately. Client notified via WhatsApp. Waiting for payout approval before re-enabling.', now()),
  ('act-todd-2', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Payout', 'BlueSky-5505 payout requested: $1,980. Submitted to prop firm portal. Account moved to Payout Hold status. Strategy disabled.', now() - interval '4 days'),
  ('act-todd-3', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD7713'), 'Note', 'Apex-7713 (Bullet Bot Short) hit max loss on gap up open. Account marked Failed. Will open new eval next cycle.', now() - interval '9 days'),
  ('act-todd-4', (select id from public.clients where legacy_key='client-todd'), null, 'Call', 'Weekly review call with client. Discussed Bullet Bot performance - Long side profitable, Short side underperforming. Client approved switching Short to reserve after this eval.', now() - interval '14 days');

insert into public.tasks (legacy_key, client_id, trading_account_id, text, due_date, priority, done, created_at)
values
  ('task-rome-1', (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME7045'), 'Request payout for BlueSky-7045 - second payout cycle approved, submit to firm portal by end of week.', '2026-06-26', 'High', false, now() - interval '1 day'),
  ('task-rome-2', (select id from public.clients where legacy_key='client-rome'), (select id from public.trading_accounts where account_name='ROME9002'), 'Verify Tradovate-9002 strategy reconnected and running after VPS reboot. Confirm no missed sessions.', null, 'Normal', false, now() - interval '2 days'),
  ('task-rome-3', (select id from public.clients where legacy_key='client-rome'), null, 'Onboarding complete - review IFSP performance with client next Monday after full week of data.', '2026-06-29', 'Low', false, now() - interval '3 days'),
  ('task-todd-1', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Monitor BlueSky-5505 drawdown - only $300 remaining. If no payout approval by Friday, call prop firm directly.', '2026-06-26', 'High', false, now() - interval '1 day'),
  ('task-todd-2', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD5505'), 'Process BlueSky-5505 payout request - confirm submission to prop firm portal, track approval status.', '2026-06-25', 'High', false, now() - interval '2 days'),
  ('task-todd-3', (select id from public.clients where legacy_key='client-todd'), null, 'Open new Apex evaluation (Short side) for next Bullet Bot cycle after Apex-7713 failed.', '2026-07-01', 'Normal', false, now() - interval '3 days'),
  ('task-todd-4', (select id from public.clients where legacy_key='client-todd'), (select id from public.trading_accounts where account_name='TODD7712'), 'Review Apex-7712 Long side Bullet Bot results after eval passes - determine if strategy performance justifies full funding.', null, 'Low', true, now() - interval '14 days');

