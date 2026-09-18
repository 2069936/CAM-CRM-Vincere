-- Step 44: the My Futures Book backtest series, stored where the period report
-- can read them.
--
-- WHAT THIS TABLE HOLDS, AND WHAT IT IS NOT.
--
-- One row per algorithm x version x instrument x risk level x calendar month,
-- imported from the NinjaTrader trade lists the desk downloads from its own
-- portfolio page on myfuturesbook.com. Every one of those files is a BACKTEST
-- of the version the desk runs today, re-run over history, on ONE simulated
-- account. It is not client money, it did not happen in anyone's account, and
-- no row here may be summed with, ranked against, or charted beside a figure
-- taken from `account_snapshots`. `docs/stack-playbook-spec.md` section 3
-- states that rule; this table exists so the rule has something to point at.
--
-- FOUR THINGS ABOUT THE COLUMNS, EACH OF THEM A TRAP THAT WAS CHECKED ON ALL
-- 68,146 TRADES OF THE REAL DOWNLOAD RATHER THAN ASSUMED.
--
-- 1. `net_profit` is the sum of the file's `Profit` column, which is ALREADY
--    NET of the separate `Commission` column. `gross_profit` is therefore
--    net + commission, and the CHECK below pins that relation so a future
--    writer cannot quietly store the vendor's Profit as "gross". Commission
--    is charged per contract at a rate that belongs to the instrument: measured
--    over the desk's 36 files it is $1.30 a contract per round turn on the
--    micros (M2K, MNQ, MES), $1.80 on MGC, $4.36 on YM and $4.80 on NG and PL.
--    It is measured per row rather than written into the schema as one number
--    that would be wrong for eleven of the twelve algorithms.
--
-- 2. `risk_level` is part of the unique key and can never be aggregated away.
--    A larger base size splits one exit into more scale-out legs and every leg
--    is its own trade, so the win rate moves with the risk level over
--    identical history: IFSP reads 48.66% Low, 61.26% Medium, 68.46% High. A
--    query that sums three risk levels is asking about the files, not about
--    the algorithm.
--
-- 3. The risk level is NOT one contract. `Qty` varies inside a single file as
--    the strategy scales (ARPD MGC Low holds 1, 2 and 4; RBO M2K High reaches
--    36), which is why `contracts` is stored: the dollars in a row are only
--    comparable with another row that traded the same sizes, and that is
--    within one file over time, not across files.
--
-- 4. `max_drawdown` is peak to trough on the trade-closed equity curve INSIDE
--    that month, with the curve reset to zero at the month's start. Months do
--    not add up to a year and a month's figure is not a fragment of the
--    all-history drawdown. `src/domain/algorithmBenchmark.js` owns that
--    arithmetic; this table stores its output.
--
-- Additive and idempotent: nothing is dropped, nothing is rewritten, and a
-- re-import of the same file replaces its months through the unique key rather
-- than adding a second copy.

begin;

create table if not exists public.algorithm_benchmarks (
  id uuid primary key default gen_random_uuid(),
  -- Named rather than assumed: if a second vendor is ever imported, the rows
  -- that came from My Futures Book stay identifiable without reading file names.
  source_vendor text not null default 'My Futures Book',
  algorithm text not null,
  version text not null,
  instrument text not null,
  risk_level text not null,
  -- Always the first of the month. The CHECK makes that true rather than
  -- conventional, so `where month = date '2026-07-01'` cannot miss rows a
  -- different writer stored on the 31st.
  month date not null,
  trades integer not null,
  trading_days integer not null,
  contracts integer not null,
  gross_profit numeric(14, 2) not null,
  commission numeric(14, 2) not null,
  net_profit numeric(14, 2) not null,
  -- A fraction in [0,1], not a percentage, and null only when there are no
  -- trades — which the trades CHECK below makes unreachable. Stored so the
  -- report never recomputes a rate from a sum it did not keep.
  win_rate numeric(6, 5),
  -- Positive magnitude. 0 means the curve never fell inside the month, which
  -- is a measurement, not a missing value.
  max_drawdown numeric(14, 2) not null,
  -- Measured for this month as commission / contracts, not assumed: the rate is
  -- a property of the instrument, not of the vendor. Over the desk's 36 files it
  -- is $1.30 a contract per round turn on the micros (M2K, MNQ, MES), $1.80 on
  -- MGC, $4.36 on YM and $4.80 on NG and PL. Null only when a month traded no
  -- contracts, which the trades check makes unreachable.
  commission_per_contract numeric(8, 4),
  source_file text not null,
  imported_at timestamptz not null default now(),
  imported_by_user_id uuid references public.app_users(id) on delete set null,

  constraint algorithm_benchmarks_month_is_first_of_month
    check (month = date_trunc('month', month)::date),
  constraint algorithm_benchmarks_risk_level_known
    check (risk_level in ('Low', 'Medium', 'High')),
  constraint algorithm_benchmarks_trades_positive
    check (trades > 0 and trading_days > 0 and trading_days <= trades),
  constraint algorithm_benchmarks_win_rate_is_a_fraction
    check (win_rate is null or (win_rate >= 0 and win_rate <= 1)),
  constraint algorithm_benchmarks_drawdown_is_a_magnitude
    check (max_drawdown >= 0),
  constraint algorithm_benchmarks_commission_is_a_cost
    check (commission >= 0),
  -- The one arithmetic claim this table makes about itself: the vendor's
  -- Profit is net, so gross is net plus the commission already deducted. A
  -- writer that stored Profit as gross would double-count the commission on
  -- every chart drawn from these rows, and would fail here instead.
  constraint algorithm_benchmarks_gross_is_net_plus_commission
    check (abs(gross_profit - (net_profit + commission)) < 0.01)
);

-- Re-import replaces. Without this a desk that downloads the 36 files again
-- next month doubles every historical month it already holds, and nothing on
-- the page would look wrong.
create unique index if not exists algorithm_benchmarks_series_month_key
  on public.algorithm_benchmarks (algorithm, version, instrument, risk_level, month);

-- The report reads one risk level across algorithms for a period.
create index if not exists algorithm_benchmarks_period_idx
  on public.algorithm_benchmarks (risk_level, month desc);

-- Row Level Security, in the shape step 43 applies to every other table.
--
-- Written out here rather than left to step 43's enumeration because 43 has
-- already run by the time this migration does: a table created afterwards
-- carries its own policy or it ships open. Signed-in users get what they have
-- everywhere else; the publishable key in the browser bundle gets nothing.
alter table public.algorithm_benchmarks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'algorithm_benchmarks'
      and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on public.algorithm_benchmarks
      for all to authenticated using (true) with check (true);
  end if;
end $$;

commit;

-- What this leaves: the new table has RLS and exactly one policy, and no table
-- in public is open. Same check step 43 ends with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 44 left % table(s) without row level security', n;
  end if;
end $$;
