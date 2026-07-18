-- Step 27: team-wide algo history derived from NinjaTrader logs.
-- Keeps per-account-day realized PnL by algo family + direction from log
-- executions, independent of any client, so accounts that no longer exist still
-- contribute to bullet-bot / algo historical performance. Upsert-keyed by
-- (log_date, account_name, family) so re-uploading a log does not double count.

create table if not exists public.log_algo_history (
  id uuid primary key default gen_random_uuid(),
  log_date date,
  account_name text,
  family text,
  direction text,
  realized_pnl numeric,
  round_trips integer,
  created_at timestamptz default now(),
  unique (log_date, account_name, family)
);
create index if not exists log_algo_history_family_idx on public.log_algo_history(family);
