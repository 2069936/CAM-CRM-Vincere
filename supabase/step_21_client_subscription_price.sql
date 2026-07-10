-- Step 21: CAM subscription price per client (management request).
-- Run after step_20_cam_client_permissions.sql.
--
-- Tracks each client's CAM subscription tier. Allowed values are enforced in
-- app code (src/domain/subscriptionPrice.js): '$500', '$250', 'Free',
-- 'Undetermined'. Stored as text (values include non-numeric labels).
-- Default 'Undetermined' so existing rows and new clients start unset.

alter table public.clients
  add column if not exists subscription_price text default 'Undetermined';

update public.clients
set subscription_price = 'Undetermined'
where subscription_price is null;

alter table public.clients
  alter column subscription_price set default 'Undetermined';

select
  column_name,
  data_type,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'clients'
  and column_name = 'subscription_price'
order by ordinal_position;
