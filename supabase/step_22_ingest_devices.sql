-- Step 22: Auto-import (NinjaTrader watcher) ingest identity + device binding.
-- Run after step_21_client_subscription_price.sql.
--
-- The watcher executable on each client VPS authenticates the daily import with
-- that client's product_key (the per-client Whop key already stored on the
-- client record). The first upload binds the source machine; later uploads must
-- come from the same machine, so a leaked product_key alone cannot push data
-- from a different VPS. See src/domain/ingestAuth.js.

-- product_key must be unique so it can act as the per-client ingest identity.
create unique index if not exists idx_clients_product_key_unique
  on public.clients(product_key)
  where product_key is not null and product_key <> '';

-- Binds a client's product_key to the machine (VPS) that uploads its data.
create table if not exists public.ingest_devices (
  id uuid primary key default gen_random_uuid(),
  product_key text not null unique,
  client_id uuid not null references public.clients(id) on delete cascade,
  machine_id text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_ingest_devices_client
  on public.ingest_devices(client_id);

select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'ingest_devices'
order by ordinal_position;
