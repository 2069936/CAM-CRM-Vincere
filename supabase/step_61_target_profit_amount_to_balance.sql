-- Step 61: the evaluation target stored as a profit AMOUNT, put back as the
-- BALANCE every reader compares it against.
--
-- WHY 61. 54 is claimed by draft PR 65, 58 by PR 74, and 59 and 60 by PR 75,
-- none of them merged. 61 is the next number nobody holds. It depends on none
-- of them and none of them touches trading_accounts.target_profit, so it can
-- run at any point after 57, before or after any of those.
--
-- WHY A MIGRATION AND NOT A NOTE. trading_accounts.target_profit is an absolute
-- BALANCE: 54,100 on a 50k that passes at 54,100 (src/domain/accountTargets.js
-- carries the argument). Until PR 78 the plan picker in the account registry
-- wrote the firm's published profit AMOUNT into it (3,000 on a 50k), and every
-- reader asks `balance >= target`, so such a row reads as passed on the day the
-- account opens. PR 78 fixes the writer. The rows it already wrote stay wrong
-- until something rewrites them, and that is a data change in production, which
-- in this repo is a numbered file Pedro runs and a test can replay (step 38 is
-- the precedent).
--
-- WHAT PRODUCTION HOLDS. Counted read only on 2026-10-06: of 726 trading
-- accounts with a positive target, 8 hold a value under 10,000, and
-- prop_firm_plan is empty on all 726.
--
--   1 Evaluation - Bullet Bot, target 3,000, start 50,000, balance 53,000.
--     CONVERTED to 53,000, which is exactly the Bullet Bot 50k target in
--     accountTargets.js.
--   1 Funded, target 8,000, start 6,000.
--     LEFT ALONE. It is above its start, so it already reads as a balance.
--   6 Funded, target 4,000, start NULL.
--     LEFT ALONE. With no start, nothing says whether 4,000 is a balance on a
--     small account or an amount on a 50k one, and a migration that guessed
--     would be inventing the number it claims to recover. The app refuses them
--     instead (src/domain/storedTarget.js): every progress cell shows "Target
--     not set" and no flag or alert calls them reached. A CAM fixes them by
--     setting Start Bal $ or the target balance in the registry.
--
-- WHAT COUNTS AS AN AMOUNT BEYOND DOUBT. All four, on the stored row:
--
--   * target_profit > 0
--   * start_balance > 0                 a start is on record
--   * target_profit < start_balance     a balance target below its own start
--                                       is passed by an account that made
--                                       nothing
--   * target_profit <= start_balance / 5
--                                       an amount, not a balance typed a little
--                                       low. Every published profit target is
--                                       6 to 8 percent of its size; a fifth
--                                       leaves room and still refuses 45,000 on
--                                       a 50,000 start, which is a balance with a
--                                       typo, not an amount, and is left for the
--                                       app to refuse.
--
-- The new value is start_balance + target_profit: the amount is the profit to
-- make from the start, so the balance that passes is the two added. The account
-- type is not part of the test. A cash or simulation account has no target in
-- any reader, so converting one changes nothing anybody sees.
--
-- SELF-DISARMING, so running it twice is safe. A converted row sits above its
-- start and no longer matches, so a second run converts nothing. If somebody
-- later types an amount into a row this step already converted, a re-run
-- converts it again and the provenance column records that newer amount.
--
-- PROVENANCE AND THE UNDO. Each converted row keeps what it held in
-- target_profit_before_step_61; every other row has NULL there. Nothing reads it
-- at runtime. To undo:
--
--   update public.trading_accounts
--      set target_profit = target_profit_before_step_61,
--          target_profit_before_step_61 = null
--    where target_profit_before_step_61 is not null;
--
-- CHECK AFTERWARDS (read only). The first should return 1 on today's
-- production, the second 0:
--
--   select count(*) from public.trading_accounts
--    where target_profit_before_step_61 is not null;
--   select count(*) from public.trading_accounts
--    where target_profit > 0 and start_balance > 0
--      and target_profit < start_balance
--      and target_profit <= start_balance / 5;

begin;

alter table public.trading_accounts
  add column if not exists target_profit_before_step_61 numeric;

comment on column public.trading_accounts.target_profit_before_step_61 is
  'The profit AMOUNT step 61 found in target_profit and converted to a balance (start_balance + amount). NULL on every row step 61 did not touch. Provenance only; nothing reads it at runtime.';

do $step61$
declare
  converted integer;
begin
  update public.trading_accounts
     set target_profit_before_step_61 = target_profit,
         target_profit = start_balance + target_profit,
         updated_at = now()
   where target_profit > 0
     and start_balance > 0
     and target_profit < start_balance
     and target_profit <= start_balance / 5;
  get diagnostics converted = row_count;
  raise notice 'step 61: converted % target(s) from a profit amount to a balance', converted;

  -- Inside the transaction, so a failure here leaves nothing half done.
  if exists (
    select 1 from public.trading_accounts
     where target_profit > 0
       and start_balance > 0
       and target_profit < start_balance
       and target_profit <= start_balance / 5
  ) then
    raise exception 'step 61: a target that is an amount is still stored after the conversion';
  end if;
end
$step61$;

commit;
