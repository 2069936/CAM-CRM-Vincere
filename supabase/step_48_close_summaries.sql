-- Step 48: the desk's money per close per segment, so a login stops downloading
-- the book to add it up.
--
-- WHY THIS TABLE EXISTS.
--
-- Measured on production on 2026-09-22, one login fetched all eighteen CRM
-- tables in full: 148,011 rows, 178 round trips, about 105 MB of JSON. Eight
-- people signing in at once is eight times that against one instance, which is
-- why the CRM ran clean at 07:30 and hung at 09:00, and the book doubles about
-- every 39 days — `orders` went 30,955 on 20 Aug to 55,856 on 22 Sep.
--
-- Most of that download exists to answer one question per close: what did each
-- kind of account do. The manager's first screen renders the four business rows
-- (Bullet Bot, other prop, cash, unclassified), the reconciliation counts, the
-- ten-close history strip and the month, and every one of them is
-- `buildSegmentTotals` walking `account_snapshots` — 12,778 rows on production,
-- 4.9 per close, to produce about 2.2 numbers per close. This table is those
-- 2.2 numbers. It moves the login from O(closes x accounts) to O(closes x
-- segments), which is what stops the monthly doubling; the per-account detail
-- is still fetched in full, for the one close per client that the funded table,
-- the evaluations table and the deviation alerts actually read.
--
-- THE THING THIS MIGRATION DELIBERATELY DOES NOT DO: SEGMENT.
--
-- There is no trigger here, no view, and no SQL that decides which segment an
-- account close belongs to. `segmentForAccount` in
-- src/domain/operationsSegments.js decides that, once, and both ingest paths
-- (the browser upload through dailyImportPersistence.js, and the collector
-- through the same file on the server) call it and send the answer here.
-- `replace_close_summaries` below stores rows; it computes nothing.
--
-- That is not tidiness. deskMoney.js exists because three surfaces on one
-- screen each had their own loop and disagreed by 3.1% on the day and 6.7% on
-- the week, with the weekly figure sign-flipping between two of them on
-- 2026-07-24. A segmentation rule written a second time in PL/pgSQL is that
-- defect with a longer fuse: it would agree on the day it was written and
-- drift the first time somebody teaches the JavaScript about a new account
-- type. The backfill is a Node script for the same reason — see
-- scripts/backfill_close_summaries.mjs — so the rows that already exist are
-- decided by the same function as the rows written from today on.
--
-- AND THERE IS NO TOTAL COLUMN, AT ANY GRAIN.
--
-- operationsSegments.js refuses one in thirty lines of comment: a desk total
-- adds real client cash to a prop firm's simulated plan size and nets Bullet
-- Bot against the ordinary algorithms, and it got the SIGN wrong twice in
-- fourteen days. A `total` column here would be that same figure coming back
-- through a table instead of through a function, which is how the deleted one
-- came back the first time. `counted_in_total` says whether a row is part of
-- the desk's businesses at all (Ignored, orphan, simulated and undetermined
-- closes are counted and never added); it is not a total and cannot be summed
-- into one without deciding to.
--
-- WHY `account_names` IS ON THE ROW.
--
-- `buildCrmStateFromTables` recomputes the live/simulated/cash/prop split from
-- each account's CURRENT record on every load, deliberately, so that a CAM
-- correcting a misclassification fixes every close the client ever had rather
-- than only the ones imported afterwards. A stored summary freezes the
-- classification it was written under and would re-create exactly the bug that
-- rule prevents. Two things stop it. `updateSupabaseTradingAccount` rebuilds
-- the client's summaries when an account's type or simulation mode moves; and
-- every row names the accounts it counted, so a reader holding
-- `trading_accounts` can re-ask `segmentForAccount` for each of them and refuse
-- a row whose answer has moved. A refused row is not a wrong figure: the close
-- reads as not summarised and the screen says so.
--
-- Additive and idempotent: nothing is dropped, nothing is rewritten, and a
-- re-upload of the same close replaces its rows through the unique key rather
-- than adding a second copy.

begin;

create table if not exists public.close_summaries (
  id uuid primary key default gen_random_uuid(),
  daily_import_id uuid not null references public.daily_imports(id) on delete cascade,
  -- Denormalised from the close, on purpose. Every read of this table is per
  -- client or per client-set (a CAM's login is scoped to 26 of 206 clients),
  -- and joining 5,687 summary rows to 2,585 closes to answer that is a join
  -- the browser would be paying for on every login.
  client_id uuid not null references public.clients(id) on delete cascade,
  trading_date date not null,
  -- One of src/domain/operationsSegments.js SEGMENTS, verbatim, INCLUDING an
  -- account type nobody has taught segmentFor() about — that function returns
  -- the unknown type under its own name rather than folding it into
  -- Unclassified, so a new account type is reported instead of vanishing. No
  -- CHECK for that reason: a constraint here would reject the close that first
  -- carried a new type, which is the opposite of reporting it.
  segment text not null,
  accounts integer not null default 0,
  daily_pnl numeric(16, 2) not null default 0,
  -- A Monday-to-Friday accumulator, not a daily figure. Stored per close
  -- because the close carries it; deskMoney refuses to add it across a month
  -- and says why on the row.
  weekly_pnl numeric(16, 2) not null default 0,
  -- A level, not a flow, and only capital on the cash segment. A prop balance
  -- is the plan size the firm simulates. deskMoney decides which of those a
  -- reader is allowed to see; this column is the arithmetic behind both.
  balance numeric(16, 2) not null default 0,
  -- EXCLUDED_FROM_TOTAL, as the writer evaluated it. Stored rather than derived
  -- from `segment` on the way back, so the rule lives in one place and a row
  -- written under an older rule still says what it meant.
  counted_in_total boolean not null default true,
  -- The accounts this row counted, so a later reclassification is detectable
  -- rather than silent. See the header.
  account_names text[] not null default '{}',
  updated_at timestamptz not null default now(),

  constraint close_summaries_accounts_is_a_count check (accounts >= 0)
);

-- One row per segment per close. A re-upload replaces; two copies of a close's
-- Cash row would double the desk's cash and nothing on the page would look
-- wrong.
create unique index if not exists close_summaries_import_segment_key
  on public.close_summaries (daily_import_id, segment);

-- The login's own read: a client's closes, or a date range across the desk.
create index if not exists close_summaries_client_date_idx
  on public.close_summaries (client_id, trading_date desc);

create index if not exists close_summaries_date_idx
  on public.close_summaries (trading_date desc);

comment on table public.close_summaries is
  'The desk money of one close, per segment, written at ingest by src/domain/closeSummary.js from buildSegmentTotals. Read at login instead of account_snapshots: 2.2 rows a close against 4.9. There is no total column and there must not be one — see src/domain/operationsSegments.js.';

comment on column public.close_summaries.segment is
  'One of operationsSegments.SEGMENTS verbatim, including an unrecognised account type under its own name. Decided in JavaScript by segmentForAccount and stored here; nothing in SQL derives it, because a second segmentation is two desk answers on one screen.';

comment on column public.close_summaries.account_names is
  'The accounts counted into this row when it was written. The split is recomputed from each account''s CURRENT record on every load, so a reclassification makes a stored row wrong; naming the accounts is what lets a reader detect that and refuse the row instead of quietly under-reporting a day.';

/*
 * Replace the stored summary of one or more closes, atomically.
 *
 * Takes the rows already decided by buildSegmentTotals and writes them. The
 * delete and the insert are one statement for a reason: a close whose old rows
 * were removed and whose new ones were not written reads as a day on which the
 * desk made nothing, which is the failure mode this whole table has to avoid.
 *
 * `p_rows` is the jsonb array closeSummaryToDb produces. A close named in
 * `p_daily_import_ids` with no rows in `p_rows` is emptied, which is correct:
 * a re-upload that removed every account from a close should leave no money
 * behind it.
 */
create or replace function public.replace_close_summaries(
  p_daily_import_ids uuid[],
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_written integer := 0;
begin
  if p_daily_import_ids is null or array_length(p_daily_import_ids, 1) is null then
    return 0;
  end if;

  delete from public.close_summaries
   where daily_import_id = any (p_daily_import_ids);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  insert into public.close_summaries (
    daily_import_id, client_id, trading_date, segment, accounts,
    daily_pnl, weekly_pnl, balance, counted_in_total, account_names, updated_at
  )
  select
    (row_value ->> 'daily_import_id')::uuid,
    (row_value ->> 'client_id')::uuid,
    (row_value ->> 'trading_date')::date,
    row_value ->> 'segment',
    coalesce((row_value ->> 'accounts')::integer, 0),
    coalesce((row_value ->> 'daily_pnl')::numeric, 0),
    coalesce((row_value ->> 'weekly_pnl')::numeric, 0),
    coalesce((row_value ->> 'balance')::numeric, 0),
    coalesce((row_value ->> 'counted_in_total')::boolean, true),
    coalesce(
      (select array_agg(name_value #>> '{}')
         from jsonb_array_elements(
           case when jsonb_typeof(row_value -> 'account_names') = 'array'
                then row_value -> 'account_names'
                else '[]'::jsonb end
         ) as name_value),
      '{}'::text[]
    ),
    now()
  from jsonb_array_elements(p_rows) as row_value
  -- Only the closes this call named. A payload naming a close the caller did
  -- not ask to replace would insert rows nothing deleted first, and the
  -- duplicate would be caught by the unique index rather than by intent.
  where (row_value ->> 'daily_import_id')::uuid = any (p_daily_import_ids);

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- Reached by the browser (an authenticated CAM saving an upload) and by the
-- ingest endpoints (service_role). `security definer` because it writes a table
-- whose policy is `to authenticated`, and the collector's service client is not
-- an authenticated user.
revoke all on function public.replace_close_summaries(uuid[], jsonb)
  from public, anon;

grant execute on function public.replace_close_summaries(uuid[], jsonb)
  to authenticated, service_role;

-- Row Level Security, in the shape step 43 applies to every other table.
--
-- Written out here rather than left to step 43's enumeration because 43 has
-- already run by the time this migration does: a table created afterwards
-- carries its own policy or it ships open. Signed-in users get what they have
-- everywhere else; the publishable key in the browser bundle gets nothing.
alter table public.close_summaries enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'close_summaries'
      and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on public.close_summaries
      for all to authenticated using (true) with check (true);
  end if;
end $$;

commit;

-- What this leaves: the new table has RLS and exactly one policy, and no table
-- in public is open. Same check step 44 ends with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 48 left % table(s) without row level security', n;
  end if;
end $$;

-- THE BACKFILL IS NOT IN THIS FILE, and that is the point.
--
-- Run it after this migration:
--
--   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
--     node scripts/backfill_close_summaries.mjs
--
-- It reads `trading_accounts` and `account_snapshots` one client at a time,
-- runs the SAME src/domain/closeSummary.js the ingest runs, and calls
-- `replace_close_summaries` above. Safe to run twice, safe to interrupt, and
-- safe to resume: it replaces a client's rows wholesale and a second run writes
-- the same rows again.
--
-- Until it has run, the table is empty and every screen behaves exactly as it
-- did before: deskMoney finds no summary for a close and falls back to the
-- closes the session holds, which is the login's 206 latest ones. The manager's
-- history strip and month will read short, and the basis line on each figure
-- says how many closes it could not read. Nothing is wrong on screen; it is
-- incomplete and it says so.
