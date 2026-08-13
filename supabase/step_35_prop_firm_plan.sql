-- Which plan a prop account was bought under.
--
-- Firm and account size are derivable from data the CRM already holds: the
-- connection names the firm, and the earliest balance on record gives the size.
-- The plan is not. It is a purchase decision, and it is the plan that sets the
-- limits — Legends sells a 50k at 2,000 drawdown on Apprentice and 2,200 on
-- Elite, and Lucid's 100k is 3,000 on Pro but 3,500 on Direct.
--
-- Nullable on purpose. An account whose plan nobody has named runs on the
-- tightest drawdown that firm sells at that size, which is the survivable
-- error; a default here would make a guess look like a record.

alter table public.trading_accounts
  add column if not exists prop_firm_plan text;

comment on column public.trading_accounts.prop_firm_plan is
  'Plan name as sold by the prop firm (Apprentice, Elite, Flex, Rapid...). Null means unknown; the app falls back to the tightest published drawdown for that firm and size.';
