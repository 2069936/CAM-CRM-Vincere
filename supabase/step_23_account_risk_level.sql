-- Step 23: manual per-account risk level.
-- Risk level is assigned by the team (Low / Medium / High), not inferred. An
-- empty/NULL value means Unassigned. Kept out of the daily-import upsert so an
-- import never overwrites a manually-set value.

alter table public.trading_accounts
  add column if not exists risk_level text;
