-- Step 26: structured per-day PnL on activity entries.
-- The NinjaTrader log backfill derives realized PnL per account per date from
-- executions (no balances). Storing that date + amount lets the Stack Playbook
-- equity curves include log-backfilled days, not just CSV closes.

alter table public.activity_logs
  add column if not exists log_date date,
  add column if not exists log_pnl numeric;
