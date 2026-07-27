-- Step 33: link a CRM trading account to its Tradovate / NinjaTrader-web id.
--
-- Tradovate identifies an account by a numeric id (e.g. 1977234), not by the
-- NinjaTrader display name the CRM keys accounts on. Storing the id lets a
-- Tradovate CSV (or, later, an API pull) resolve to the right CRM account so its
-- realized P/L feeds that account's history. Set once per account by the CAM.

alter table public.trading_accounts
  add column if not exists tradovate_account_id text;

create index if not exists trading_accounts_tradovate_id_idx
  on public.trading_accounts(tradovate_account_id);
