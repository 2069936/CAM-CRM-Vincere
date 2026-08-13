-- Step 36: telling a simulation account apart from real money.
--
-- WHY A COLUMN AND NOT A RULE.
--
-- Intent is not recorded anywhere in the platform data and cannot be derived
-- from it. All 11 simulation accounts across the 11 unredacted client exports
-- are named `Sim101`, and 10 of them sit at NinjaTrader's stock $100,000 with no
-- strategies, no orders and no executions. A deliberate multi-session SIM
-- engagement that has not traded yet is byte-for-byte indistinguishable from an
-- untouched default install; a client who idly placed one trade on their own
-- Sim101 is indistinguishable from a desk engagement. The only separator visible
-- in the data is activity, and activity is not intent.
--
-- Nothing else works either. The connection name is useless: Sim101 reports
-- BlueSky / BluSky / Blusky / Legends / Legends Trading / Live across the 11
-- folders, and 9 of them resolve to a real prop firm. Absence of a prop firm
-- fails on the same 9 and also matches 53 real cash accounts.
--
-- So the app classifies with a heuristic (NinjaTrader's Sim<number> naming, plus
-- the platform's own simulator flag once the collector reads it) and this column
-- is the CAM's override of that heuristic.
--
-- NULL means "no opinion recorded" — the automatic signals decide. It is NOT a
-- vote for live money, which is why it is nullable rather than defaulted:
-- a default of 'live' would silently re-arm the classification for all 764
-- existing rows and turn an absence of information into an assertion.

alter table public.trading_accounts
  add column if not exists simulation_mode text;

alter table public.trading_accounts
  drop constraint if exists trading_accounts_simulation_mode_check;

-- account_type is deliberately free text with no CHECK constraint (see
-- reconcile.js:16 — pre-split rows still store the legacy 'Cash'). This column
-- is new, so it has no legacy values to protect and can be constrained.
alter table public.trading_accounts
  add constraint trading_accounts_simulation_mode_check
  check (simulation_mode is null or simulation_mode in ('simulation', 'live'));

comment on column public.trading_accounts.simulation_mode is
  'CAM override of the automatic simulation detection. ''simulation'' = simulated funds, keep out of every real total. ''live'' = real money despite a simulator-looking name. NULL = no opinion recorded; the app classifies from account_type, the platform flag, then the Sim<number> naming, and reports the reason it used.';

-- No data migration. Every one of the 764 existing trading_accounts rows carries
-- one of the six historical account_type values (Evaluation - Bullet Bot 244,
-- Funded 193, Unassigned 115, Inactive / Ignore 84, Evaluation - Standard 75,
-- Cash 53) and none of them is a simulation account: of 3,100 account_snapshots
-- exactly ONE sits at 100,000 and it carries trailing_max_drawdown 2500 on
-- connection 'Bluesky 1' — a real 100k prop evaluation, not a Sim101 (every real
-- Sim101 reports a trailing drawdown of 0). Simulation accounts were dropped at
-- reconcile and never reached the database at all, so there is nothing here to
-- reclassify and no existing row changes behaviour because this column exists.
