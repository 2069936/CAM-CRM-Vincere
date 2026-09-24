-- Step 49: the algorithm catalogue, and where each order's algorithm goes.
--
-- WHAT THIS IS FOR.
--
-- NinjaTrader records which strategy placed an order in Strategy2Order and
-- deletes it by cascade the moment that strategy leaves the workspace. Measured
-- on a real VPS on 2026-09-24: 29 surviving links against 18,827 orders across
-- seven months, on 5 of 129 accounts. The desk rotates algorithms constantly,
-- so it destroys its own attribution constantly. The trades survive; the label
-- does not.
--
-- Agent 1.0.9 recovers it on the machine by comparing the geometry a trade
-- exhibits - the contracts each scale-out leg takes, and how far the stop and
-- each profit target sit from the entry in ticks - against the strategy
-- templates that machine holds. That identified 55% of trades by algorithm and
-- 53% by version as well, with zero trades attributed to the wrong algorithm.
--
-- But it only runs when somebody takes a Deep Export of one machine. The CRM
-- already holds 59,264 orders from the whole desk with the columns that
-- comparison needs, and it is missing exactly one thing: the catalogue. This
-- puts it here once, so the same answer can be computed for every client
-- without asking anyone for an export.
--
-- Run against that machine's own book in the CRM's row shape, the result is
-- 53% of trades and 51% of orders named, 97% of them with the version as well.
-- That is the agent's figure, reached from columns the CRM already stores.
--
-- ONE TABLE, AND THE RESULT IS NOT A TABLE.
--
-- `strategy_templates` is reference data. A template is a property of the
-- ALGORITHM, not of a client or a machine: OGX v3 on MNQ at Medium risk is the
-- same configuration wherever it runs, so this does not grow with trading. The
-- desk's whole library - 886 template files, 13 algorithms - collapses to 278
-- rows here, because the variants that differ only in their session window
-- declare the same ladder. Measured, not estimated: of those 278 identities,
-- zero hold two different geometries, which is what makes the unique index
-- below safe. Under 200 kB for the table and its indexes.
--
-- The attribution itself is three columns on `orders`. A separate table would
-- repeat the order id 59,264 times to carry two short strings, and the join
-- would be paid on every read. The cost of that choice is that no HISTORY of
-- attribution is kept - a re-run overwrites - and that is deliberate.
-- Attribution is a function of the orders and the catalogue: if the method
-- improves, everything is recomputed rather than versioned.
--
-- Additive and idempotent. Nothing is dropped and nothing existing is
-- rewritten; the three new columns start null on every row.

begin;

create table if not exists public.strategy_templates (
  id uuid primary key default gen_random_uuid(),

  -- `RBO`, never `RBO_PF`. The _PF suffix is the same algorithm configured for
  -- a prop firm account, and the geometry is identical in every case measured,
  -- so folding it here is what lets a match answer one algorithm instead of
  -- refusing. Which variant ran is answered by the account's own type.
  family text not null,
  version text,
  risk text,
  instrument text not null,
  prop_firm boolean not null default false,

  -- The ladder. Each leg's size, and the distance of the stop and each profit
  -- target from the entry, in ticks, exactly as the template declares them.
  size_1 integer not null default 0,
  size_2 integer not null default 0,
  size_3 integer not null default 0,
  stop_ticks integer not null default 0,
  target_1_ticks integer not null default 0,
  target_2_ticks integer not null default 0,
  target_3_ticks integer not null default 0,

  -- Which export this row was read from, so a catalogue that disagrees with
  -- another machine's can be traced rather than argued about.
  source_machine_id uuid,
  source_export_at timestamptz,
  imported_at timestamptz not null default now(),
  imported_by_user_id uuid references public.app_users(id) on delete set null,

  constraint strategy_templates_family_present
    check (length(btrim(family)) > 0),
  constraint strategy_templates_instrument_present
    check (length(btrim(instrument)) > 0),
  constraint strategy_templates_risk_known
    check (risk is null or risk in ('Low', 'Medium', 'High')),
  -- A row with no geometry matches every trade, which is worse than no row.
  constraint strategy_templates_has_geometry
    check (stop_ticks > 0 or target_1_ticks > 0 or target_2_ticks > 0 or target_3_ticks > 0),
  constraint strategy_templates_sizes_are_counts
    check (size_1 >= 0 and size_2 >= 0 and size_3 >= 0),
  constraint strategy_templates_ticks_are_distances
    check (stop_ticks >= 0 and target_1_ticks >= 0 and target_2_ticks >= 0 and target_3_ticks >= 0)
);

-- A re-import replaces rather than doubles. The identity of a template is what
-- it IS, not where it was read from, so importing the same catalogue from a
-- second machine updates these rows instead of adding a second copy of the
-- whole desk's algorithm library.
create unique index if not exists strategy_templates_identity_key
  on public.strategy_templates (family, coalesce(version, ''), coalesce(risk, ''), instrument, prop_firm);

-- The matcher asks by instrument and geometry, never by name.
create index if not exists strategy_templates_match_idx
  on public.strategy_templates (instrument, stop_ticks, target_1_ticks, target_2_ticks, target_3_ticks);

-- WHERE THE ANSWER GOES. Null everywhere until something attributes it, and
-- null is the honest state: "nobody has worked this out" and "this could not be
-- worked out" are both absence, and neither is a claim about the order.
alter table public.orders
  add column if not exists attributed_family text,
  add column if not exists attributed_version text,
  add column if not exists attribution_basis text,
  add column if not exists attributed_at timestamptz;

-- Named CHECKs do not converge through ADD COLUMN IF NOT EXISTS.
alter table public.orders drop constraint if exists orders_attribution_basis_check;
alter table public.orders
  add constraint orders_attribution_basis_check
  check (attribution_basis is null or attribution_basis in ('record', 'inferred'));

-- A basis with no algorithm, or an algorithm with no basis, is a half-written
-- answer. Either both are there or neither is.
alter table public.orders drop constraint if exists orders_attribution_is_whole_check;
alter table public.orders
  add constraint orders_attribution_is_whole_check
  check ((attribution_basis is null and attributed_family is null)
      or (attribution_basis is not null and attributed_family is not null));

-- Reading "which orders has nobody answered yet" is the whole workflow, and it
-- is a minority of the table once this has run, so the index holds only those.
create index if not exists orders_unattributed_idx
  on public.orders (trading_account_id)
  where attribution_basis is null;

-- Row Level Security, in the shape step 43 gives everything else. Written here
-- rather than left to 43's enumeration because 43 has already run: a table
-- created afterwards carries its own policy or it ships open.
alter table public.strategy_templates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'strategy_templates'
      and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on public.strategy_templates
      for all to authenticated using (true) with check (true);
  end if;
end $$;

commit;

-- What this leaves: the new table has RLS and exactly one policy, and no table
-- in public is open. The same check steps 43 through 45 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 49 left % table(s) without row level security', n;
  end if;
end $$;
