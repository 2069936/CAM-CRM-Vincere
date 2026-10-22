-- Step 73: a later capture of a day never erases what an earlier one stored,
-- and the holes a capture leaves are filled, provisionally and visibly, from
-- what the tracker saw during the day.
--
-- WHY 73. 72 is the highest step today. 54 is still a deliberate gap. This
-- file needs step 29 (ingest_batches.reprocess_mode), step 47
-- (strategy_snapshots.ran), step 50 (the persist body it replaces, with
-- strategy_snapshots.derived_realized and account_snapshots.derivation),
-- step 66 (tracker_close_readings and account_live_sample_history), step 67
-- (operational_flags.resolution_note and account_is_past_live_flags) and
-- step 71 (account_observation_money), and says so if any of them is
-- missing. It adds no table, so step 56's exception table is unchanged.
--
-- THE PROBLEM, measured on production on 2026-10-22. The daily close capture
-- runs at 16:30 New York and a VPS outage coincided with it: 33 machines sent
-- their close, and 75 accounts that traded that day were not in it, because
-- the AddOn drops an account that is disconnected at capture time
-- (AccountRelevance.IsRelevant returns isConnected). Two things made that
-- worse than a missing row:
--
--   * PERSISTENCE WAS DESTRUCTIVE. persist_auto_daily_import (step 50's body,
--     the latest definition until this file) upserted account_snapshots per
--     account, which was fine, but whenever the new capture's section was not
--     empty it DELETED every strategy_snapshots, orders and executions row of
--     the day and inserted only the new capture's rows, and it always deleted
--     the day's operational_flags. A later capture that held fewer accounts
--     wiped the fills of all the others, while their account rows stayed: a
--     day that read as traded with no trades under it. There was no merge by
--     execution id (executions.external_execution_id has no unique key).
--   * NOTHING FILLED THE HOLE. The tracker samples every account every ten
--     minutes (account_live_samples, step 55; its runs in
--     account_live_sample_history, step 66) and every strategy instance
--     (algorithm_live_samples, step 57), and step 66 pins the reading in force
--     at the close into tracker_close_readings. The browser can then SAY
--     "tracker only" (src/domain/trackerCloseComparison.js), but nothing put
--     the money anywhere, and a flag existed only when a CAM pressed the
--     button (src/domain/trackerCloseFlag.js).
--
-- ===========================================================================
-- PART 1. THE MERGE. persist_auto_daily_import is replaced with the same
-- signature, the same return shape and the same grants, so v2, v3 and the
-- closed day replacement call it exactly as before. For an existing
-- daily_import of the same client and date:
--
--   a. An account absent from the new capture keeps everything: its
--      account_snapshot, its strategy rows, its orders and its executions.
--   b. For an account present in the new capture (present = named by any of
--      the four sections of the payload):
--        * executions are MERGED. A fill is identified by
--          external_execution_id within (daily import, trading account); one
--          without an id by (instrument, action, quantity, price, time_text,
--          external_order_id). A fill the day does not hold yet is inserted; a
--          fill it holds is refreshed with the newer capture's values (fills
--          do not change, so this only ever restates them, and it is what makes
--          a replay after a normalizer fix correct the stored copy); a stored
--          fill the new capture lacks is KEPT, because a NinjaTrader restart
--          loses the earlier fills from memory and the next capture simply does
--          not list them. Identical twins (two fills with the same fallback
--          identity) are matched by multiplicity, k-th to k-th, so neither side
--          can multiply or swallow them. Each row of either side is reduced
--          to ONE text key (its trading account and external id, or the
--          fallback columns with NULL as a sentinel and every number in its
--          canonical trim_scale form) and the two sides meet on (key, k): an
--          equality the planner hashes. The first draft paired them with IS
--          NOT DISTINCT FROM, which cannot be hashed, and 8,000 fills took
--          about ten seconds under the client's row lock against 0.4 for step
--          50's replace; the test beside this file times it against step 50
--          in the same run.
--        * A NORMAL REPLAY CANNOT REMOVE A STORED FILL. A fill the day holds
--          stays even when the capture being replayed no longer carries it,
--          so a normalizer fix that moves a fill to another account or gives
--          it another id leaves the old copy beside the new one. Only Replace
--          closed day (rule f) deletes and rewrites the day's fills, and it
--          needs the day to be Closed first. That is deliberate: a merge
--          cannot tell a fill that was wrong from one NinjaTrader forgot.
--        * orders are merged by external_order_id the same way (fallback:
--          instrument, action, order_type, quantity, limit_price, stop_price,
--          time_text, name), and an order present in both takes the NEWER
--          capture's values, because state, filled, avg_price and remaining
--          move during the day.
--        * strategy rows are upserted per (account, lower(strategy_name),
--          lower(instrument)). strategy_snapshots has no unique key and a
--          roster can list two instances of one strategy on one instrument
--          (step 50 calls them twins), so the stored rows of an identity the
--          new capture lists are replaced AS A GROUP by the new capture's rows
--          of that identity, in the payload's order. A strategy the new capture
--          does not list keeps its stored row.
--        * the account_snapshot is upserted (the newer capture wins: balances
--          and drawdowns move during the day), as before.
--   c. derived_realized stays consistent with the merged fills. It is computed
--      in JavaScript (src/domain/deriveStrategyPnl.js through
--      reconcileDailyImport) before this RPC, from the fills the payload
--      carries. Porting a 1,100 line FIFO with its refusal rules to SQL was not
--      the small option, so the work is split:
--        * the JavaScript reads the day's stored fills, orders and strategy
--          rows for the accounts in the new capture
--          (server/apiLib/autoImportStore.js loadStoredFills,
--          src/domain/storedFills.js) and hands reconcileDailyImport the
--          UNION, so the derivation it attaches is the union's, and it covers
--          the strategies an earlier capture listed and this one does not.
--          Those rows travel in the payload marked "fromStore": true. A fill or
--          an order merges onto itself here; a strategy row is never inserted,
--          it brings the stored row of its identity (k-th to k-th) its new
--          derived_realized, ran and ran_basis, in place. The daily route and
--          the normal Manager replay do this; the closed day replacement does
--          not (it replaces, see f). If the read fails, the daily route answers
--          503 and releases the batch, the retry convention it uses for a
--          database that timed out on the persist, so the capture lands later
--          in full instead of now with blanked figures; a normal replay fails
--          and can be pressed again.
--        * this function then enforces the invariant whatever the caller did,
--          as a safety net: for a present account whose stored fills include
--          one the payload did not carry (an older build, a race), the
--          derivation it attached saw a subset, so derived_realized on that
--          account's capture rows and account_snapshots.derivation are set to
--          NULL. And on an account whose fill set grew in this merge, a strategy
--          row kept from an earlier capture that the payload neither replaced
--          nor sent back loses its derived_realized: it was worked out over
--          fewer fills. NULL is step 37's "not derived", which every reader
--          falls back from; a figure over a subset of the day is never left
--          standing.
--   d. THE CAPTURE THAT LOST ACTIVITY. If the stored state of an account shows
--      activity (a stored execution for it that day, or a stored CAPTURE
--      snapshot with abs(realized) > 0.005) and the new capture shows none (no
--      execution of its own for the account, the "fromStore" ones do not count,
--      and abs(realized) <= 0.005), that account's snapshot, strategies,
--      orders and executions are NOT touched: the stored rows stay and a
--      'Capture lost activity' flag (Warning) names both readings in its
--      message and in operational_flags.details, one per close and account. A
--      tracker row (Part 2) is not stored activity, so a real capture always
--      replaces it, even one that shows nothing.
--   e. operational_flags: the three kinds this file introduces, 'Capture lost
--      activity', 'Tracker only account' and 'Close below tracker', are never
--      deleted by a capture. Otherwise a merge deletes and writes again only
--      what the capture speaks for: the flags of the accounts it lists (step
--      65's refresh relies on that rewrite) and the client level flags, with
--      no account, that the import regenerates. An account the capture does
--      not list, or one rule d holds back, keeps its flags as it keeps its
--      rows, and a payload flag for it is added only when the day holds no
--      flag of that type for it yet, so a second capture stacks no copy. A
--      'Missing account' flag of the payload is not written for an account
--      the day still holds a snapshot of, because after the merge "did not
--      appear in this close" is no longer true. Replace closed day deletes
--      every flag but the three kinds, as step 50 deleted every flag.
--   f. THE MANAGER REPLAY. Two paths reach this function from the Manager's
--      Auto Collection screen (server/autoCollection/admin/ingest-reprocess.js
--      and ingest-reprocess-failed.js, step 29):
--        * "Reprocess batch" (and the bulk replay of failed batches) runs a
--          stored capture through persist_auto_daily_import_v3, the daily
--          route's own call, to land a capture that failed or was cut short.
--          It now MERGES like the daily route, which is a change and is
--          deliberate: what it relied on was v2's rule that an older capture is
--          superseded, which is untouched, and with replace semantics a
--          replayed capture holding fewer accounts would wipe the others' fills,
--          the defect this file exists to end.
--        * "Replace closed day" (persist_closed_auto_daily_import_replacement,
--          typed REPLACE, reprocess_mode 'closed_day') is the path that
--          intentionally rebuilds a day from a stored batch, and it KEEPS
--          step 50's replace semantics exactly: strategies, orders and
--          executions are deleted and rewritten whenever the snapshot's section
--          is not empty, and rule d does not apply. It is recognised by both of
--          its own markers, the batch's reprocess_mode 'closed_day' (set by
--          claim_ingest_batch_reprocess) and the day's status 'Manager
--          replacement in progress' (set by step 29 just before it calls this
--          function), so no caller changes and a re-run of 29 or 30 cannot
--          turn it into a merge. The differences: it too leaves the three new
--          flag kinds alone, and its account lookup takes the oldest registry
--          row of a case variant like every other path in this function
--          (step 50's unordered `select into` took any).
--   g. The MANUAL browser upload (src/domain/dailyImportPersistence.js) is not
--      changed and STILL REPLACES: it deletes the close's strategy rows,
--      orders, executions and flags whenever its own sections are not empty,
--      tracker rows and the three new flag kinds included. Its upsert of an
--      account does not name `source`, so a guard trigger (below) sets
--      `source` back to 'capture' on every browser write: a CAM's upload over
--      a tracker row is a capture, and the browser can never write a tracker
--      row.
--
-- daily_imports.source_summary gains a "merge" object on every automatic
-- capture: mode (merge or replace), accountsInCapture, accountsKeptFromEarlier
-- and accountsHeldBack (rule d). Nothing reads it yet; it is the trace a
-- person reads when a day looks wrong.
--
-- ===========================================================================
-- PART 2. THE TRACKER FILLS THE HOLE, PROVISIONALLY.
--
--   account_snapshots.source and strategy_snapshots.source, text not null
--   default 'capture', check in ('capture', 'tracker'). A 'tracker' row is
--   PROVISIONAL: built from the tracker's reading, with no fills and no
--   balance. account_snapshots.source_detail (jsonb) says which reading:
--   origin, sampledAt, deviceId, connected, status, totalPnl (the snapshot has
--   no total column), captureTime and captureBasis. operational_flags.details
--   (jsonb) carries the readings behind the three new flag kinds.
--
--   fill_daily_import_from_tracker(daily_import_id) runs at every finalize (a
--   new trigger, tracker_fill_on_batch, on the same transition as step 66's
--   tracker_close_on_batch; PostgreSQL fires triggers of one event in name
--   order, and "close" sorts before "fill", so the pin is always in place
--   first), and the service role may call it for a close uploaded by hand,
--   which no finalize reaches. For one close:
--
--     ACTIVITY, AND ONLY WHILE CONNECTED. The tracker samples disconnected
--     accounts too, and a disconnected account keeps showing whatever
--     realized NinjaTrader last held for it, which may be yesterday's; the
--     AddOn leaves such an account out of the close on purpose. So an account
--     counts as having traded only when at least one CONNECTED run of
--     account_live_sample_history on the trading date, begun at or before
--     the close's capture time, read abs(realized) > 0.005. A strategy
--     reading is not evidence on its own: it can be frozen just the same.
--
--     THE READING, and which source wins:
--       1. the last CONNECTED run of that account on any of the client's
--          machines on the trading date that began at or before the capture
--          time. That is the money, never a disconnected reading after it.
--          The capture time is the finalized batch's captured_at, else a
--          pinned close_captured_at whose basis is 'captured', else 17:00 New
--          York on the trading date. source_detail.origin says
--          account_live_sample_history.
--       2. only when the history no longer holds the day for the account (it
--          keeps five days): the pinned reading of tracker_close_readings,
--          which step 66 keeps for good, and only if it was taken while the
--          account was connected and read activity. origin says
--          tracker_close_readings.
--       Strategy readings: the pinned row's strategies; when it has none, the
--       algorithm_live_samples of that account sampled on the trading date
--       (swept after two days).
--
--     WHICH ACCOUNTS. Only one the client's registry holds: the fill NEVER
--     creates a trading_accounts row, because the tracker sees every account
--     on the machine and only the close or a person decides what the desk
--     tracks; an unknown one is counted as skippedUnknown. Not one that step
--     67's account_is_past_live_flags calls dead by its status or its type
--     (Failed, Inactive, Reserve, Inactive / Ignore), counted as
--     skippedNotLive; its observation is passed as NULL, because "absent" and
--     "breached" are what earlier closes said and an account the tracker saw
--     trade today is not absent from it. Simulation accounts ARE filled: the
--     desk keeps a client's simulation day, and the reports set it apart.
--
--     a. A live registry account with activity and NO account_snapshot in the
--        close gets a provisional one: realized and unrealized from the
--        reading, total in source_detail, balance, trailing drawdown and
--        weekly P&L NULL, derivation NULL, source 'tracker', on the registry
--        row the close would use (lower(account_name), the oldest of a case
--        variant). One provisional strategy row per strategy reading, source
--        'tracker': strategy_family the reading's algorithm (computed by the
--        route with the product's one family rule), realized and unrealized
--        from the reading, derived_realized NULL (no fills), ran true with
--        ran_basis 'realized' when its realized is non zero and NULL
--        otherwise. The period reports then attribute the money to the
--        algorithm as they do a reported realized. One 'Tracker only account'
--        flag (Warning).
--     b. A later real capture that lists the account replaces the provisional
--        rows (Part 1: the upsert sets source 'capture', the tracker strategy
--        rows of a present account are deleted), even when it shows nothing,
--        and the next fill resolves the 'Tracker only account' flag with the
--        note 'A later capture included this account.'.
--     c. A live account IN the close with no execution and abs(realized) <=
--        0.005 while its reading shows activity gets a 'Close below tracker' flag
--        (Critical: the day's money for it is probably missing and there was
--        nothing stored to keep). Resolved by a later fill, with the note 'A
--        later capture showed this account trading.', once the close holds a
--        fill or a realized figure for it.
--     d. A provisional row is refreshed (money, source_detail and its tracker
--        strategy rows) when a later reading is strictly newer and its pin did
--        not see a NinjaTrader reset (reset_seen), so an intraday close's
--        reading gives way to the 16:30 one and a post restart zero never
--        overwrites a figure. A capture row is never written by this function.
--
--   It writes one audit_logs row (entity_type daily_import, action
--   tracker_fill_applied, the counts) when it changed anything, and never
--   raises: a fault is a WARNING and the finalize that fired it succeeds as
--   before, like step 66's pin.
--
--   fill_day_from_tracker(trading_date) returns jsonb {tradingDate,
--   dailyImports, accountsFilled, accountsRefreshed, strategiesFilled,
--   flagsWritten, flagsResolved, skippedUnknown, skippedNotLive,
--   failedImports}: the same fill for every
--   daily_import of that date, Closed ones included (it is run by hand, after
--   review). Idempotent: a second run adds nothing, because an account that
--   already has a snapshot gets none, a tracker row is refreshed only by a
--   strictly newer reading and a flag is written once per close, account and
--   kind. It only reads what is still there: tracker_close_readings are
--   pinned for good, account_live_sample_history keeps 5 days and
--   algorithm_live_samples 2. For 2026-10-22, after review:
--
--     select public.fill_day_from_tracker('2026-10-22');
--
-- WHAT THE BROWSER SHOWS. A provisional row is marked "From the tracker, no
-- fills" on the close's account table, the daily report panel, the client
-- period report (which takes no balance from such a day) and the desk period
-- report's coverage; the three flags reach the CAM flag queue, the
-- client page and the Manager overview like every other flag, with a hover in
-- src/domain/databaseFlagTypes.js; and the tracker comparison keeps calling an
-- account with only a tracker row "tracker only".
--
-- KNOWN AND LEFT. The per close desk summaries (close_summaries, step 48) are
-- still computed in JavaScript from the capture in hand, so an account kept
-- from an earlier capture, and a provisional row, is not in them until the
-- client's summaries are rebuilt. Recalculate in the browser rewrites a
-- close's flags from reconcile.js and so drops the three new kinds, as it
-- drops steps 65 and 71's today. An older capture that arrives after a newer
-- one is still superseded by v2 and not merged.
--
-- STEP 66'S PIN IS REPRODUCED HERE, with one change. It reads "the close's
-- accounts" from account_snapshots, and after a fill the provisional rows are
-- in that table too: a later pin would count them as accounts the close lists
-- and pin a 'none' row for one whose reading a narrower cutoff no longer
-- finds. record_tracker_close_readings is therefore step 66's body verbatim
-- with `source = 'capture'` on its two reads of account_snapshots; same
-- signature, same grants, same never-raises contract.
--
-- GRANTS. fill_day_from_tracker and fill_daily_import_from_tracker: EXECUTE
-- for service_role only, revoked from public, anon and authenticated, and
-- record_tracker_close_readings keeps step 66's (the same).
-- persist_auto_daily_import keeps step 28's reach (nobody; v2, v3 and the
-- replacement are security definer). write_close_merge_flag and the trigger
-- functions: the owner only. Every function is security definer except the
-- two guards, with search_path pinned to pg_catalog, public. The new columns
-- inherit their tables' grants and policies; selects that list columns are
-- unaffected, and the app reads `source` where it shows the marker.
--
-- RE-RUNNING THIS FILE changes no row: `add column if not exists`, the checks
-- dropped and recreated under their names, `create or replace` for the
-- functions and `drop trigger if exists` before each trigger. A re-run of
-- step 47 or 50 puts back the destructive body, and a re-run of 66 puts back
-- the pin that counts provisional rows; run 73 again after any of them.
--
-- CHECK AFTERWARDS (read only):
--
--   select source, count(*) from public.account_snapshots group by 1;
--   select type, status, count(*) from public.operational_flags
--    where type in ('Capture lost activity', 'Tracker only account', 'Close below tracker')
--    group by 1, 2 order by 1, 2;
--   select entity_id, after_data from public.audit_logs
--    where action = 'tracker_fill_applied' order by created_at desc limit 20;
--   select d.trading_date, count(*) as provisional_accounts,
--          count(distinct d.client_id) as clients
--     from public.account_snapshots s
--     join public.daily_imports d on d.id = s.daily_import_id
--    where s.source = 'tracker' and d.trading_date >= current_date - 7
--    group by 1 order by 1;

do $step73_guard$
begin
  if to_regclass('public.tracker_close_readings') is null
    or to_regclass('public.account_live_sample_history') is null
    or to_regclass('public.algorithm_live_samples') is null
    or to_regprocedure('public.account_observation_money(numeric)') is null
    or to_regprocedure('public.account_is_past_live_flags(text, text, text)') is null
    or (select count(*) from information_schema.columns
         where table_schema = 'public'
           and ((table_name = 'ingest_batches' and column_name = 'reprocess_mode')
             or (table_name = 'strategy_snapshots' and column_name in ('ran', 'derived_realized'))
             or (table_name = 'account_snapshots' and column_name = 'derivation')
             or (table_name = 'operational_flags' and column_name = 'resolution_note'))) <> 5 then
    raise exception 'step 73 needs steps 29, 47, 50, 66, 67 and 71 (ingest_batches.reprocess_mode, strategy_snapshots.ran and derived_realized, account_snapshots.derivation, tracker_close_readings, account_live_sample_history, operational_flags.resolution_note and account_is_past_live_flags, account_observation_money): run them first';
  end if;
end
$step73_guard$;

begin;

-- ---------------------------------------------------------------------------
-- 1. Where a row came from.
--
-- NOT NULL DEFAULT 'capture': every row written before this file is a capture,
-- and PostgreSQL 11 and later store the default without rewriting the table.
-- The checks are dropped and recreated under their names, step 72's shape,
-- and added NOT VALID: adding one is then instant, and the scan of the two
-- largest tables of the close happens in VALIDATE CONSTRAINT after the commit
-- at the end of this file, under a lock that lets the desk keep reading and
-- writing, instead of inside this transaction under the ALTER's.
-- ---------------------------------------------------------------------------
alter table public.account_snapshots
  add column if not exists source text not null default 'capture',
  add column if not exists source_detail jsonb;

alter table public.account_snapshots
  drop constraint if exists account_snapshots_source_check;
alter table public.account_snapshots
  add constraint account_snapshots_source_check
  check (source in ('capture', 'tracker')) not valid;

alter table public.strategy_snapshots
  add column if not exists source text not null default 'capture';

alter table public.strategy_snapshots
  drop constraint if exists strategy_snapshots_source_check;
alter table public.strategy_snapshots
  add constraint strategy_snapshots_source_check
  check (source in ('capture', 'tracker')) not valid;

alter table public.operational_flags
  add column if not exists details jsonb;

comment on column public.account_snapshots.source is
  'capture: written from a close (automatic or uploaded). tracker: PROVISIONAL, built by fill_daily_import_from_tracker from the tracker''s reading of an account that traded and is missing from the close; realized and unrealized only, no fills, no balance. A later capture that lists the account replaces it. Step 73.';
comment on column public.account_snapshots.source_detail is
  'For a tracker row, the reading it came from: origin (tracker_close_readings or account_live_sample_history), sampledAt, deviceId, connected, status, totalPnl, captureTime and captureBasis. NULL on a capture row. Step 73.';
comment on column public.strategy_snapshots.source is
  'capture or tracker, as account_snapshots.source. A tracker row is one strategy reading of a provisional account: realized and unrealized from the tracker, derived_realized NULL. Step 73.';
comment on column public.operational_flags.details is
  'The readings behind a flag the database writes, as jsonb: both readings of a Capture lost activity flag, the tracker reading of a Tracker only account or Close below tracker flag. NULL on every other flag. Step 73.';

-- ---------------------------------------------------------------------------
-- 2. A browser write is always a capture.
--
-- Security INVOKER on purpose, step 65's guard shape: current_user is anon or
-- authenticated for the browser, postgres inside the security definer
-- functions, service_role for the API routes. The manual upload upserts an
-- account without naming `source`, so without this a CAM's upload over a
-- provisional row would keep calling it 'tracker'; and nobody in the browser
-- may write a tracker row.
-- ---------------------------------------------------------------------------
create or replace function public.account_snapshots_source_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if current_user in ('anon', 'authenticated') then
    new.source := 'capture';
    new.source_detail := null;
  end if;
  return new;
end;
$function$;

create or replace function public.strategy_snapshots_source_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if current_user in ('anon', 'authenticated') then
    new.source := 'capture';
  end if;
  return new;
end;
$function$;

revoke all on function public.account_snapshots_source_guard() from public, anon, authenticated, service_role;
revoke all on function public.strategy_snapshots_source_guard() from public, anon, authenticated, service_role;

drop trigger if exists account_snapshots_source_guard on public.account_snapshots;
create trigger account_snapshots_source_guard
  before insert or update on public.account_snapshots
  for each row execute function public.account_snapshots_source_guard();

drop trigger if exists strategy_snapshots_source_guard on public.strategy_snapshots;
create trigger strategy_snapshots_source_guard
  before insert or update on public.strategy_snapshots
  for each row execute function public.strategy_snapshots_source_guard();

-- ---------------------------------------------------------------------------
-- 3. One flag per close, account and kind.
--
-- The three kinds this file writes are evidence for a CAM, so a second capture
-- or a second fill never stacks a second copy: an Open one has its words and
-- readings brought up to date, a Resolved one is the CAM's decision and is
-- left alone. Returns 1 when it inserted, 0 otherwise. Owner only.
-- ---------------------------------------------------------------------------
create or replace function public.write_close_merge_flag(
  p_daily_import_id uuid,
  p_client_id uuid,
  p_trading_account_id uuid,
  p_type text,
  p_severity text,
  p_message text,
  p_details jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.operational_flags;
begin
  select flag.* into v_existing
  from public.operational_flags as flag
  where flag.daily_import_id = p_daily_import_id
    and flag.type = p_type
    and flag.trading_account_id is not distinct from p_trading_account_id
  order by flag.created_at, flag.id
  limit 1;
  if found then
    if coalesce(v_existing.status, 'Open') = 'Open'
      and (v_existing.message is distinct from p_message
        or v_existing.details is distinct from p_details
        or v_existing.severity is distinct from p_severity) then
      update public.operational_flags
      set message = p_message, details = p_details, severity = p_severity
      where id = v_existing.id;
    end if;
    return 0;
  end if;
  insert into public.operational_flags (
    daily_import_id, client_id, trading_account_id, type, severity, message, status, details
  ) values (
    p_daily_import_id, p_client_id, p_trading_account_id, p_type, p_severity, p_message, 'Open', p_details
  );
  return 1;
end;
$function$;

revoke all on function public.write_close_merge_flag(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. persist_auto_daily_import, merging.
--
-- Step 50's body where nothing changed (the checks, the locks, the superseded
-- batch, the registry upsert, the daily_imports upsert, the column lists), and
-- the rules in the header where it did. The replace branch is step 50's
-- section code verbatim apart from `source` on the snapshot upsert.
-- ---------------------------------------------------------------------------
create or replace function public.persist_auto_daily_import(
  p_client_id uuid,
  p_source_batch_id uuid,
  p_import_result jsonb
)
returns public.daily_imports
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  v_client public.clients;
  v_batch public.ingest_batches;
  v_daily public.daily_imports;
  v_prior_batch public.ingest_batches;
  v_date date;
  v_item jsonb;
  v_account_name text;
  v_account_id uuid;
  v_snapshot_id uuid;
  v_had_day boolean := false;
  v_replace boolean := false;
  -- lower(btrim(account name)) of the accounts rule d holds back.
  v_kept text[] := '{}';
  -- The accounts the new capture names, minus the ones held back, as keys and ids.
  v_present_keys text[] := '{}';
  v_present_ids uuid[] := '{}';
  -- Present accounts with a stored fill the payload did not carry, and accounts
  -- that gained a fill in this merge.
  v_unseen_ids uuid[] := '{}';
  v_grown_ids uuid[] := '{}';
  v_kept_from_earlier integer := 0;
  v_touched integer := 0;
  -- lower(account name) -> the registry id every row of the payload resolves to.
  v_account_ids jsonb := '{}'::jsonb;
  -- Stored strategy rows the fromStore rows refreshed, and the rows this
  -- capture inserted: neither loses its derived figure to the safety net.
  v_refreshed_strategy_ids uuid[] := '{}';
  v_inserted_strategy_ids uuid[] := '{}';
  v_protected constant text[] := array['Capture lost activity', 'Tracker only account', 'Close below tracker'];
  v_capture jsonb;
  v_stored public.account_snapshots;
  v_stored_fills integer;
  v_label text;
  v_capture_time text;
begin
  if p_client_id is null
    or p_source_batch_id is null
    or jsonb_typeof(p_import_result) <> 'object'
    or nullif(p_import_result ->> 'date', '') is null then
    raise exception 'invalid_auto_daily_import'
      using errcode = '22023';
  end if;

  begin
    v_date := (p_import_result ->> 'date')::date;
  exception when others then
    raise exception 'invalid_auto_daily_import'
      using errcode = '22023';
  end;

  select client.* into v_client
  from public.clients as client
  where client.id = p_client_id
  for update;
  if not found then
    raise exception 'invalid_auto_daily_import'
      using errcode = 'P0002';
  end if;

  select batch.* into v_batch
  from public.ingest_batches as batch
  where batch.id = p_source_batch_id
  for update;
  if not found
    or v_batch.client_id is distinct from p_client_id
    or v_batch.trading_date is distinct from v_date
    or v_batch.status not in ('received', 'processing') then
    raise exception 'invalid_auto_daily_import'
      using errcode = '22023';
  end if;

  select daily.* into v_daily
  from public.daily_imports as daily
  where daily.client_id = p_client_id
    and daily.trading_date = v_date
  for update;
  v_had_day := found;
  if v_had_day and v_daily.status is not distinct from 'Closed' then
    raise exception 'daily_import_closed'
      using errcode = 'P0001', detail = v_daily.id::text;
  end if;

  -- THE ONE PATH THAT STILL REPLACES (header, rule f): the Manager's typed
  -- "Replace closed day", recognised by both of its own markers.
  v_replace := v_had_day
    and v_daily.status is not distinct from 'Manager replacement in progress'
    and v_batch.reprocess_mode is not distinct from 'closed_day';

  if v_had_day
    and v_daily.source_batch_id is not null
    and v_daily.source_batch_id is distinct from p_source_batch_id then
    select prior.* into v_prior_batch
    from public.ingest_batches as prior
    where prior.id = v_daily.source_batch_id
      and prior.client_id = p_client_id
    for update;
    update public.ingest_batches
    set status = 'replaced',
        daily_import_id = v_daily.id,
        processing_token = null,
        processing_lease_expires_at = null,
        processed_at = coalesce(processed_at, clock_timestamp())
    where id = v_daily.source_batch_id
      and client_id = p_client_id
      and status in ('processed', 'incomplete', 'processing');
    if found and v_prior_batch.status = 'processing' then
      insert into public.audit_logs (
        user_id, entity_type, entity_id, action, after_data
      ) values (
        null,
        'ingest_batch',
        v_prior_batch.id,
        'ingest_batch_superseded',
        jsonb_build_object(
          'clientId', p_client_id,
          'deviceId', v_prior_batch.device_id,
          'batchId', v_prior_batch.id,
          'replacementBatchId', p_source_batch_id,
          'dailyImportId', v_daily.id,
          'status', 'replaced',
          'rowCounts', v_prior_batch.row_counts,
          'errorCode', null
        )
      );
    end if;
    update public.ingest_batches
    set replaces_batch_id = v_daily.source_batch_id
    where id = p_source_batch_id;
  end if;

  for v_account_name, v_item in
    select entry.key, entry.value
    from jsonb_each(coalesce(p_import_result -> 'accounts', '{}'::jsonb)) as entry
  loop
    insert into public.trading_accounts (
      client_id, legacy_key, account_name, alias, connection, account_type,
      status, payout_state, start_balance, target_profit, max_drawdown_limit,
      risk_level, bullet_bot_pass_type, bullet_bot_direction, algo_stack,
      daily_loss_limit, notes, date_added, date_funded, date_failed,
      date_last_payout, payout_count, updated_at
    ) values (
      p_client_id,
      coalesce(nullif(v_item ->> 'accountName', ''), v_account_name),
      coalesce(nullif(v_item ->> 'accountName', ''), v_account_name),
      coalesce(nullif(v_item ->> 'alias', ''), v_account_name),
      coalesce(v_item ->> 'connection', ''),
      coalesce(nullif(v_item ->> 'accountType', ''), 'Unassigned'),
      coalesce(nullif(v_item ->> 'status', ''), 'Active'),
      coalesce(nullif(v_item ->> 'payoutState', ''), 'Not requested'),
      nullif(v_item ->> 'startBalance', '')::numeric,
      nullif(v_item ->> 'targetProfit', '')::numeric,
      nullif(v_item ->> 'maxDrawdownLimit', '')::numeric,
      coalesce(v_item ->> 'riskLevel', ''),
      coalesce(v_item ->> 'bulletBotPassType', ''),
      coalesce(v_item ->> 'bulletBotDirection', ''),
      coalesce(v_item ->> 'algoStack', ''),
      coalesce(v_item ->> 'dailyLossLimit', ''),
      coalesce(v_item ->> 'notes', ''),
      nullif(v_item ->> 'dateAdded', '')::date,
      nullif(v_item ->> 'dateFunded', '')::date,
      nullif(v_item ->> 'dateFailed', '')::date,
      nullif(v_item ->> 'dateLastPayout', '')::date,
      coalesce(nullif(v_item ->> 'payoutCount', '')::integer, 0),
      clock_timestamp()
    )
    on conflict (client_id, account_name) do update set
      alias = excluded.alias,
      connection = excluded.connection,
      account_type = excluded.account_type,
      status = excluded.status,
      payout_state = excluded.payout_state,
      start_balance = excluded.start_balance,
      target_profit = excluded.target_profit,
      max_drawdown_limit = excluded.max_drawdown_limit,
      risk_level = excluded.risk_level,
      bullet_bot_pass_type = excluded.bullet_bot_pass_type,
      bullet_bot_direction = excluded.bullet_bot_direction,
      algo_stack = excluded.algo_stack,
      daily_loss_limit = excluded.daily_loss_limit,
      notes = excluded.notes,
      date_added = excluded.date_added,
      date_funded = excluded.date_funded,
      date_failed = excluded.date_failed,
      date_last_payout = excluded.date_last_payout,
      payout_count = excluded.payout_count,
      updated_at = excluded.updated_at;
  end loop;

  -- ONE ACCOUNT LOOKUP FOR THE WHOLE PAYLOAD. Every name any section or flag
  -- carries is resolved once, the way the persistence always meant it: the
  -- client's registry row whose lower(account_name) matches, the oldest when a
  -- case variant exists twice. Every insert and every merge below reads this
  -- map, so a snapshot, its strategies, its fills and its flags can never land
  -- on two different registry rows, and no statement looks an account up once
  -- per fill.
  select coalesce(jsonb_object_agg(named.key, account.id) filter (where account.id is not null), '{}'::jsonb)
    into v_account_ids
  from (
    select distinct lower(coalesce(item.value ->> 'accountName', '')) as key
    from (
      select value from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'strategies', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'orders', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'executions', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'flags', '[]'::jsonb))
    ) as item(value)
  ) as named
  left join lateral (
    select candidate.id
    from public.trading_accounts as candidate
    where candidate.client_id = p_client_id
      and lower(candidate.account_name) = named.key
    order by candidate.created_at, candidate.id
    limit 1
  ) as account on true
  where named.key <> '';

  -- RULE D, decided against the stored day BEFORE anything of it is written.
  -- Stored activity: a stored fill of the account, or a stored CAPTURE
  -- snapshot with a realized figure. The new capture shows none: no fill of its
  -- own for the account (the "fromStore" fills the route added are the stored
  -- ones coming back) and abs(realized) <= 0.005. Each side is reduced to one
  -- set of account keys first and the sets are joined, so the cost is the
  -- size of the day, not the accounts times the fills.
  if v_had_day and not v_replace then
    with captured as (
      select lower(btrim(coalesce(item.value ->> 'accountName', ''))) as key,
             nullif(item.value ->> 'grossRealizedPnl', '')::numeric as realized
      from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb)) as item(value)
    ),
    own_fills as (
      select distinct lower(btrim(coalesce(fill.value ->> 'accountName', ''))) as key
      from jsonb_array_elements(coalesce(p_import_result -> 'executions', '[]'::jsonb)) as fill(value)
      where coalesce(fill.value ->> 'fromStore', '') <> 'true'
    ),
    stored_fills as (
      select distinct lower(btrim(account.account_name)) as key
      from public.executions as stored
      join public.trading_accounts as account on account.id = stored.trading_account_id
      where stored.daily_import_id = v_daily.id
    ),
    stored_realized as (
      select distinct lower(btrim(snapshot.account_name)) as key
      from public.account_snapshots as snapshot
      where snapshot.daily_import_id = v_daily.id
        and snapshot.source = 'capture'
        and abs(coalesce(snapshot.gross_realized_pnl, 0)) > 0.005
    )
    select coalesce(array_agg(distinct captured.key), '{}')
      into v_kept
    from captured
    left join own_fills on own_fills.key = captured.key
    left join stored_fills on stored_fills.key = captured.key
    left join stored_realized on stored_realized.key = captured.key
    where captured.key <> ''
      and abs(coalesce(captured.realized, 0)) <= 0.005
      and own_fills.key is null
      and (stored_fills.key is not null or stored_realized.key is not null);

    select count(*)::integer into v_kept_from_earlier
    from public.account_snapshots as snapshot
    left join (
      select distinct lower(btrim(coalesce(item.value ->> 'accountName', ''))) as key
      from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb)) as item(value)
    ) as captured on captured.key = lower(btrim(snapshot.account_name))
    where snapshot.daily_import_id = v_daily.id
      and captured.key is null;
  end if;

  insert into public.daily_imports (
    client_id, legacy_key, trading_date, imported_at, status, source_summary,
    source_type, source_batch_id, updated_at
  ) values (
    p_client_id,
    coalesce(nullif(p_import_result ->> 'id', ''), p_client_id::text || '-' || v_date::text),
    v_date,
    coalesce(nullif(p_import_result ->> 'importedAt', '')::timestamptz, clock_timestamp()),
    coalesce(nullif(p_import_result ->> 'status', ''), 'Needs review'),
    jsonb_build_object(
      'accounts', jsonb_array_length(coalesce(p_import_result -> 'snapshots', '[]'::jsonb)),
      'strategies', jsonb_array_length(coalesce(p_import_result -> 'strategies', '[]'::jsonb)),
      'orders', jsonb_array_length(coalesce(p_import_result -> 'orders', '[]'::jsonb)),
      'executions', jsonb_array_length(coalesce(p_import_result -> 'executions', '[]'::jsonb)),
      'flags', jsonb_array_length(coalesce(p_import_result -> 'flags', '[]'::jsonb)),
      'source_type', 'automatic',
      'source_batch_id', p_source_batch_id,
      'merge', jsonb_build_object(
        'mode', case when v_replace then 'replace' else 'merge' end,
        'accountsInCapture', jsonb_array_length(coalesce(p_import_result -> 'snapshots', '[]'::jsonb)),
        'accountsKeptFromEarlier', v_kept_from_earlier,
        'accountsHeldBack', cardinality(v_kept)
      )
    ),
    'automatic', p_source_batch_id, clock_timestamp()
  )
  on conflict (client_id, trading_date) do update set
    legacy_key = excluded.legacy_key,
    imported_at = excluded.imported_at,
    status = excluded.status,
    source_summary = excluded.source_summary,
    source_type = excluded.source_type,
    source_batch_id = excluded.source_batch_id,
    updated_at = excluded.updated_at
  returning * into v_daily;

  -- The accounts this capture speaks for, in any of its four sections, minus
  -- the ones rule d holds back: their keys, and their registry ids.
  select coalesce(array_agg(distinct named.key), '{}'),
         coalesce(array_agg(distinct (v_account_ids ->> lower(named.name))::uuid)
           filter (where v_account_ids ? lower(named.name)), '{}')
    into v_present_keys, v_present_ids
  from (
    select lower(btrim(coalesce(item.value ->> 'accountName', ''))) as key,
           coalesce(item.value ->> 'accountName', '') as name
    from (
      select value from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'strategies', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'orders', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_import_result -> 'executions', '[]'::jsonb))
    ) as item(value)
  ) as named
  where named.key <> ''
    and not (named.key = any(v_kept));

  for v_item in select value from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb))
  loop
    v_account_name := coalesce(v_item ->> 'accountName', '');
    -- Rule d: the stored snapshot of a held back account stays as it is.
    continue when lower(btrim(v_account_name)) = any(v_kept);
    v_account_id := (v_account_ids ->> lower(v_account_name))::uuid;
    insert into public.account_snapshots (
      daily_import_id, trading_account_id, account_name, connection,
      gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl,
      unrealized_pnl, derivation, source, source_detail
    ) values (
      v_daily.id, v_account_id, v_account_name, coalesce(v_item ->> 'connection', ''),
      coalesce(nullif(v_item ->> 'grossRealizedPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'trailingMaxDrawdown', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'accountBalance', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'weeklyPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'unrealizedPnl', '')::numeric, 0),
      case when jsonb_typeof(v_item -> 'derivation') = 'object'
        then v_item -> 'derivation' else null end,
      'capture', null
    ) on conflict (daily_import_id, account_name) do update set
      trading_account_id = excluded.trading_account_id,
      connection = excluded.connection,
      gross_realized_pnl = excluded.gross_realized_pnl,
      trailing_max_drawdown = excluded.trailing_max_drawdown,
      account_balance = excluded.account_balance,
      weekly_pnl = excluded.weekly_pnl,
      unrealized_pnl = excluded.unrealized_pnl,
      derivation = excluded.derivation,
      -- Capture beats tracker: a provisional row stops being one here.
      source = 'capture',
      source_detail = null;
  end loop;

  if v_replace then
    -- ---------------------------------------------------------------------
    -- Step 50's sections: the closed day replacement replaces. The only
    -- change is the account lookup, which reads the map above like every
    -- other path (the oldest registry row of a case variant).
    -- ---------------------------------------------------------------------
    if jsonb_array_length(coalesce(p_import_result -> 'strategies', '[]'::jsonb)) > 0 then
      delete from public.strategy_snapshots where daily_import_id = v_daily.id;
      for v_item in select value from jsonb_array_elements(p_import_result -> 'strategies')
      loop
        v_account_name := coalesce(v_item ->> 'accountName', '');
        v_account_id := (v_account_ids ->> lower(v_account_name))::uuid;
        select snapshot.id into v_snapshot_id
        from public.account_snapshots as snapshot
        where snapshot.daily_import_id = v_daily.id
          and lower(snapshot.account_name) = lower(v_account_name)
        order by snapshot.created_at, snapshot.id
        limit 1;
        insert into public.strategy_snapshots (
          daily_import_id, trading_account_id, account_snapshot_id, strategy_name,
          strategy_family, strategy_version, instrument, data_series,
          parameters_raw, params_parsed, direction, enabled, ran, ran_basis,
          realized, unrealized, derived_realized
        ) values (
          v_daily.id, v_account_id, v_snapshot_id, coalesce(v_item ->> 'strategyName', ''),
          coalesce(v_item ->> 'strategyFamily', ''), coalesce(v_item ->> 'strategyVersion', ''),
          coalesce(v_item ->> 'instrument', ''), coalesce(v_item ->> 'dataSeries', ''),
          coalesce(v_item ->> 'parametersRaw', ''), coalesce(v_item -> 'params', '{}'::jsonb),
          coalesce(v_item ->> 'direction', ''), coalesce((v_item ->> 'enabled')::boolean, false),
          nullif(v_item ->> 'ran', '')::boolean,
          nullif(v_item ->> 'ranBasis', ''),
          case when v_item ? 'realized'
            then nullif(v_item ->> 'realized', '')::numeric else 0 end,
          coalesce(nullif(v_item ->> 'unrealized', '')::numeric, 0),
          nullif(v_item ->> 'derivedRealized', '')::numeric
        );
      end loop;
    end if;

    if jsonb_array_length(coalesce(p_import_result -> 'orders', '[]'::jsonb)) > 0 then
      delete from public.orders where daily_import_id = v_daily.id;
      for v_item in select value from jsonb_array_elements(p_import_result -> 'orders')
      loop
        v_account_id := (v_account_ids ->> lower(coalesce(v_item ->> 'accountName', '')))::uuid;
        insert into public.orders (
          daily_import_id, trading_account_id, external_order_id, strategy_name,
          instrument, action, order_type, quantity, limit_price, stop_price,
          state, filled, avg_price, remaining, name, time_text
        ) values (
          v_daily.id, v_account_id, coalesce(v_item ->> 'id', ''), coalesce(v_item ->> 'strategyName', ''),
          coalesce(v_item ->> 'instrument', ''), coalesce(v_item ->> 'action', ''), coalesce(v_item ->> 'orderType', ''),
          nullif(v_item ->> 'quantity', '')::numeric, nullif(v_item ->> 'limit', '')::numeric,
          nullif(v_item ->> 'stop', '')::numeric, coalesce(v_item ->> 'state', ''),
          nullif(v_item ->> 'filled', '')::numeric, nullif(v_item ->> 'avgPrice', '')::numeric,
          nullif(v_item ->> 'remaining', '')::numeric, coalesce(v_item ->> 'name', ''), coalesce(v_item ->> 'time', '')
        );
      end loop;
    end if;

    if jsonb_array_length(coalesce(p_import_result -> 'executions', '[]'::jsonb)) > 0 then
      delete from public.executions where daily_import_id = v_daily.id;
      for v_item in select value from jsonb_array_elements(p_import_result -> 'executions')
      loop
        v_account_id := (v_account_ids ->> lower(coalesce(v_item ->> 'accountName', '')))::uuid;
        insert into public.executions (
          daily_import_id, trading_account_id, external_execution_id,
          external_order_id, strategy_name, instrument, action, quantity, price,
          time_text, entry_exit, position, name, commission, rate, connection
        ) values (
          v_daily.id, v_account_id, coalesce(v_item ->> 'id', ''), coalesce(v_item ->> 'orderId', ''),
          coalesce(v_item ->> 'strategyName', ''), coalesce(v_item ->> 'instrument', ''),
          coalesce(v_item ->> 'action', ''), nullif(v_item ->> 'quantity', '')::numeric,
          nullif(v_item ->> 'price', '')::numeric, coalesce(v_item ->> 'time', ''),
          coalesce(v_item ->> 'entryExit', ''), coalesce(v_item ->> 'position', ''),
          coalesce(v_item ->> 'name', ''), nullif(v_item ->> 'commission', '')::numeric,
          nullif(v_item ->> 'rate', '')::numeric, coalesce(v_item ->> 'connection', '')
        );
      end loop;
    end if;
  else
    -- ---------------------------------------------------------------------
    -- STRATEGIES, merged per (account, strategy name, instrument).
    --
    -- The payload carries two kinds of row. The capture's own: what it goes
    -- in. And rows marked "fromStore": a strategy the day already holds for
    -- an account this capture names that the capture does not list, sent
    -- back by the route so the derivation covers it over the union of fills
    -- (src/domain/storedFills.js). Those are never inserted; they bring the
    -- stored row its new derived_realized, ran and ran_basis.
    --
    -- First one DELETE. What goes: every tracker row of a present account
    -- (capture beats tracker), and every capture row whose identity the
    -- capture's own rows list (the group is replaced as a group, so twins can
    -- neither multiply nor be dropped). Everything else stays.
    --
    -- A stored row's account is its trading account, or the snapshot it hangs
    -- from when that is unresolved, the way step 65 attributes orphans.
    -- ---------------------------------------------------------------------
    with listed as (
      select distinct
             lower(btrim(coalesce(item.value ->> 'accountName', ''))) || chr(31)
               || lower(btrim(coalesce(item.value ->> 'strategyName', ''))) || chr(31)
               || lower(btrim(coalesce(item.value ->> 'instrument', ''))) as identity
      from jsonb_array_elements(coalesce(p_import_result -> 'strategies', '[]'::jsonb)) as item(value)
      where coalesce(item.value ->> 'fromStore', '') <> 'true'
        and not (lower(btrim(coalesce(item.value ->> 'accountName', ''))) = any(v_kept))
    ),
    stored as (
      select held.id,
             held.source,
             coalesce(lower(btrim(account.account_name)), lower(btrim(snapshot.account_name)), '') as account_key,
             coalesce(lower(btrim(account.account_name)), lower(btrim(snapshot.account_name)), '') || chr(31)
               || lower(btrim(coalesce(held.strategy_name, ''))) || chr(31)
               || lower(btrim(coalesce(held.instrument, ''))) as identity
      from public.strategy_snapshots as held
      left join public.trading_accounts as account on account.id = held.trading_account_id
      left join public.account_snapshots as snapshot on snapshot.id = held.account_snapshot_id
      where held.daily_import_id = v_daily.id
    )
    delete from public.strategy_snapshots as target
    using stored
    left join listed on listed.identity = stored.identity
    where target.id = stored.id
      and ((stored.source = 'tracker' and stored.account_key = any(v_present_keys))
        or (stored.source <> 'tracker' and listed.identity is not null));

    -- The fromStore rows, onto the stored rows they came from: the k-th row
    -- of an identity group meets the k-th stored row of it.
    with incoming as (
      select item.value as v,
             row_number() over (partition by identity.value order by item.ordinality) as k,
             identity.value as identity
      from jsonb_array_elements(coalesce(p_import_result -> 'strategies', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      cross join lateral (
        select lower(btrim(coalesce(item.value ->> 'accountName', ''))) || chr(31)
          || lower(btrim(coalesce(item.value ->> 'strategyName', ''))) || chr(31)
          || lower(btrim(coalesce(item.value ->> 'instrument', ''))) as value
      ) as identity
      where coalesce(item.value ->> 'fromStore', '') = 'true'
        and not (lower(btrim(coalesce(item.value ->> 'accountName', ''))) = any(v_kept))
    ),
    held as (
      select stored.id,
             row_number() over (partition by stored.identity order by stored.created_at, stored.id) as k,
             stored.identity
      from (
        select kept.id, kept.created_at,
               coalesce(lower(btrim(account.account_name)), lower(btrim(snapshot.account_name)), '') || chr(31)
                 || lower(btrim(coalesce(kept.strategy_name, ''))) || chr(31)
                 || lower(btrim(coalesce(kept.instrument, ''))) as identity
        from public.strategy_snapshots as kept
        left join public.trading_accounts as account on account.id = kept.trading_account_id
        left join public.account_snapshots as snapshot on snapshot.id = kept.account_snapshot_id
        where kept.daily_import_id = v_daily.id
          and kept.source = 'capture'
      ) as stored
    ),
    refreshed as (
      update public.strategy_snapshots as target
      set derived_realized = nullif(incoming.v ->> 'derivedRealized', '')::numeric,
          ran = nullif(incoming.v ->> 'ran', '')::boolean,
          ran_basis = nullif(incoming.v ->> 'ranBasis', '')
      from incoming
      join held on held.identity = incoming.identity and held.k = incoming.k
      where target.id = held.id
      returning target.id
    )
    select coalesce(array_agg(refreshed.id), '{}') into v_refreshed_strategy_ids from refreshed;

    for v_item in select value from jsonb_array_elements(coalesce(p_import_result -> 'strategies', '[]'::jsonb))
    loop
      v_account_name := coalesce(v_item ->> 'accountName', '');
      continue when lower(btrim(v_account_name)) = any(v_kept)
        or coalesce(v_item ->> 'fromStore', '') = 'true';
      v_account_id := (v_account_ids ->> lower(v_account_name))::uuid;
      select snapshot.id into v_snapshot_id
      from public.account_snapshots as snapshot
      where snapshot.daily_import_id = v_daily.id
        and lower(snapshot.account_name) = lower(v_account_name)
      order by snapshot.created_at, snapshot.id
      limit 1;
      insert into public.strategy_snapshots (
        daily_import_id, trading_account_id, account_snapshot_id, strategy_name,
        strategy_family, strategy_version, instrument, data_series,
        parameters_raw, params_parsed, direction, enabled, ran, ran_basis,
        realized, unrealized, derived_realized, source
      ) values (
        v_daily.id, v_account_id, v_snapshot_id, coalesce(v_item ->> 'strategyName', ''),
        coalesce(v_item ->> 'strategyFamily', ''), coalesce(v_item ->> 'strategyVersion', ''),
        coalesce(v_item ->> 'instrument', ''), coalesce(v_item ->> 'dataSeries', ''),
        coalesce(v_item ->> 'parametersRaw', ''), coalesce(v_item -> 'params', '{}'::jsonb),
        coalesce(v_item ->> 'direction', ''), coalesce((v_item ->> 'enabled')::boolean, false),
        nullif(v_item ->> 'ran', '')::boolean,
        nullif(v_item ->> 'ranBasis', ''),
        case when v_item ? 'realized'
          then nullif(v_item ->> 'realized', '')::numeric else 0 end,
        coalesce(nullif(v_item ->> 'unrealized', '')::numeric, 0),
        nullif(v_item ->> 'derivedRealized', '')::numeric,
        'capture'
      )
      returning id into v_snapshot_id;
      v_inserted_strategy_ids := v_inserted_strategy_ids || v_snapshot_id;
    end loop;

    -- ---------------------------------------------------------------------
    -- ORDERS, merged. Each row of either side gets ONE text key: its trading
    -- account and its external order id, or, without an id, the fallback
    -- columns with NULL written as a sentinel and every number in its
    -- canonical form (trim_scale, so 1.50 and 1.5 are one key). Each side is
    -- numbered within its key so the k-th payload row meets the k-th stored
    -- row, and the two meet on (key, k): an equality the planner can hash,
    -- which IS NOT DISTINCT FROM is not. A pair takes the payload's values
    -- (the newer capture wins), an unpaired payload row is inserted, an
    -- unpaired stored row stays.
    -- ---------------------------------------------------------------------
    with incoming as (
      select item.ordinality as ord,
             item.value as v,
             (v_account_ids ->> lower(coalesce(item.value ->> 'accountName', '')))::uuid as account_id
      from jsonb_array_elements(coalesce(p_import_result -> 'orders', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not (lower(btrim(coalesce(item.value ->> 'accountName', ''))) = any(v_kept))
    ),
    incoming_keyed as (
      select incoming.*,
             coalesce(incoming.account_id::text, '~') || chr(31)
               || case when nullif(incoming.v ->> 'id', '') is not null
                    then 'i' || chr(31) || (incoming.v ->> 'id')
                    else 'f' || chr(31) || coalesce(incoming.v ->> 'instrument', '')
                      || chr(31) || coalesce(incoming.v ->> 'action', '')
                      || chr(31) || coalesce(incoming.v ->> 'orderType', '')
                      || chr(31) || coalesce(trim_scale(nullif(incoming.v ->> 'quantity', '')::numeric)::text, '~')
                      || chr(31) || coalesce(trim_scale(nullif(incoming.v ->> 'limit', '')::numeric)::text, '~')
                      || chr(31) || coalesce(trim_scale(nullif(incoming.v ->> 'stop', '')::numeric)::text, '~')
                      || chr(31) || coalesce(incoming.v ->> 'time', '')
                      || chr(31) || coalesce(incoming.v ->> 'name', '')
                  end as key
      from incoming
    ),
    incoming_numbered as (
      select incoming_keyed.*,
             row_number() over (partition by incoming_keyed.key order by incoming_keyed.ord) as k
      from incoming_keyed
    ),
    stored_numbered as (
      select keyed.row_id,
             keyed.key,
             row_number() over (partition by keyed.key order by keyed.created_at, keyed.row_id) as k
      from (
        select held.id as row_id,
               held.created_at,
               coalesce(held.trading_account_id::text, '~') || chr(31)
                 || case when nullif(held.external_order_id, '') is not null
                      then 'i' || chr(31) || held.external_order_id
                      else 'f' || chr(31) || coalesce(held.instrument, '')
                        || chr(31) || coalesce(held.action, '')
                        || chr(31) || coalesce(held.order_type, '')
                        || chr(31) || coalesce(trim_scale(held.quantity)::text, '~')
                        || chr(31) || coalesce(trim_scale(held.limit_price)::text, '~')
                        || chr(31) || coalesce(trim_scale(held.stop_price)::text, '~')
                        || chr(31) || coalesce(held.time_text, '')
                        || chr(31) || coalesce(held.name, '')
                    end as key
        from public.orders as held
        where held.daily_import_id = v_daily.id
      ) as keyed
    ),
    pairs as (
      select incoming.ord, stored.row_id
      from incoming_numbered as incoming
      join stored_numbered as stored on stored.key = incoming.key and stored.k = incoming.k
    ),
    refreshed as (
      update public.orders as target
      set external_order_id = coalesce(incoming.v ->> 'id', ''),
          strategy_name = coalesce(incoming.v ->> 'strategyName', ''),
          instrument = coalesce(incoming.v ->> 'instrument', ''),
          action = coalesce(incoming.v ->> 'action', ''),
          order_type = coalesce(incoming.v ->> 'orderType', ''),
          quantity = nullif(incoming.v ->> 'quantity', '')::numeric,
          limit_price = nullif(incoming.v ->> 'limit', '')::numeric,
          stop_price = nullif(incoming.v ->> 'stop', '')::numeric,
          state = coalesce(incoming.v ->> 'state', ''),
          filled = nullif(incoming.v ->> 'filled', '')::numeric,
          avg_price = nullif(incoming.v ->> 'avgPrice', '')::numeric,
          remaining = nullif(incoming.v ->> 'remaining', '')::numeric,
          name = coalesce(incoming.v ->> 'name', ''),
          time_text = coalesce(incoming.v ->> 'time', '')
      from pairs
      join incoming_numbered as incoming on incoming.ord = pairs.ord
      where target.id = pairs.row_id
      returning target.id
    ),
    added as (
      insert into public.orders (
        daily_import_id, trading_account_id, external_order_id, strategy_name,
        instrument, action, order_type, quantity, limit_price, stop_price,
        state, filled, avg_price, remaining, name, time_text
      )
      select v_daily.id, incoming.account_id, coalesce(incoming.v ->> 'id', ''),
             coalesce(incoming.v ->> 'strategyName', ''),
             coalesce(incoming.v ->> 'instrument', ''), coalesce(incoming.v ->> 'action', ''),
             coalesce(incoming.v ->> 'orderType', ''),
             nullif(incoming.v ->> 'quantity', '')::numeric, nullif(incoming.v ->> 'limit', '')::numeric,
             nullif(incoming.v ->> 'stop', '')::numeric, coalesce(incoming.v ->> 'state', ''),
             nullif(incoming.v ->> 'filled', '')::numeric, nullif(incoming.v ->> 'avgPrice', '')::numeric,
             nullif(incoming.v ->> 'remaining', '')::numeric, coalesce(incoming.v ->> 'name', ''),
             coalesce(incoming.v ->> 'time', '')
      from incoming_numbered as incoming
      left join pairs on pairs.ord = incoming.ord
      where pairs.ord is null
      order by incoming.ord
      returning id
    )
    select (select count(*) from refreshed) + (select count(*) from added) into v_touched;

    -- ---------------------------------------------------------------------
    -- EXECUTIONS, merged the same way: one key per row, from the external
    -- execution id or the fallback (instrument, action, quantity, price,
    -- time_text, order id). The same statement reports the two facts
    -- derived_realized depends on.
    -- ---------------------------------------------------------------------
    with incoming as (
      select item.ordinality as ord,
             item.value as v,
             (v_account_ids ->> lower(coalesce(item.value ->> 'accountName', '')))::uuid as account_id
      from jsonb_array_elements(coalesce(p_import_result -> 'executions', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not (lower(btrim(coalesce(item.value ->> 'accountName', ''))) = any(v_kept))
    ),
    incoming_keyed as (
      select incoming.*,
             coalesce(incoming.account_id::text, '~') || chr(31)
               || case when nullif(incoming.v ->> 'id', '') is not null
                    then 'i' || chr(31) || (incoming.v ->> 'id')
                    else 'f' || chr(31) || coalesce(incoming.v ->> 'instrument', '')
                      || chr(31) || coalesce(incoming.v ->> 'action', '')
                      || chr(31) || coalesce(trim_scale(nullif(incoming.v ->> 'quantity', '')::numeric)::text, '~')
                      || chr(31) || coalesce(trim_scale(nullif(incoming.v ->> 'price', '')::numeric)::text, '~')
                      || chr(31) || coalesce(incoming.v ->> 'time', '')
                      || chr(31) || coalesce(incoming.v ->> 'orderId', '')
                  end as key
      from incoming
    ),
    incoming_numbered as (
      select incoming_keyed.*,
             row_number() over (partition by incoming_keyed.key order by incoming_keyed.ord) as k
      from incoming_keyed
    ),
    stored_numbered as (
      select keyed.row_id,
             keyed.account_id,
             keyed.key,
             row_number() over (partition by keyed.key order by keyed.created_at, keyed.row_id) as k
      from (
        select held.id as row_id,
               held.trading_account_id as account_id,
               held.created_at,
               coalesce(held.trading_account_id::text, '~') || chr(31)
                 || case when nullif(held.external_execution_id, '') is not null
                      then 'i' || chr(31) || held.external_execution_id
                      else 'f' || chr(31) || coalesce(held.instrument, '')
                        || chr(31) || coalesce(held.action, '')
                        || chr(31) || coalesce(trim_scale(held.quantity)::text, '~')
                        || chr(31) || coalesce(trim_scale(held.price)::text, '~')
                        || chr(31) || coalesce(held.time_text, '')
                        || chr(31) || coalesce(held.external_order_id, '')
                    end as key
        from public.executions as held
        where held.daily_import_id = v_daily.id
      ) as keyed
    ),
    pairs as (
      select incoming.ord, stored.row_id
      from incoming_numbered as incoming
      join stored_numbered as stored on stored.key = incoming.key and stored.k = incoming.k
    ),
    refreshed as (
      update public.executions as target
      set external_order_id = coalesce(incoming.v ->> 'orderId', ''),
          strategy_name = coalesce(incoming.v ->> 'strategyName', ''),
          instrument = coalesce(incoming.v ->> 'instrument', ''),
          action = coalesce(incoming.v ->> 'action', ''),
          quantity = nullif(incoming.v ->> 'quantity', '')::numeric,
          price = nullif(incoming.v ->> 'price', '')::numeric,
          time_text = coalesce(incoming.v ->> 'time', ''),
          entry_exit = coalesce(incoming.v ->> 'entryExit', ''),
          position = coalesce(incoming.v ->> 'position', ''),
          name = coalesce(incoming.v ->> 'name', ''),
          commission = nullif(incoming.v ->> 'commission', '')::numeric,
          rate = nullif(incoming.v ->> 'rate', '')::numeric,
          connection = coalesce(incoming.v ->> 'connection', '')
      from pairs
      join incoming_numbered as incoming on incoming.ord = pairs.ord
      where target.id = pairs.row_id
      returning target.id
    ),
    added as (
      insert into public.executions (
        daily_import_id, trading_account_id, external_execution_id,
        external_order_id, strategy_name, instrument, action, quantity, price,
        time_text, entry_exit, position, name, commission, rate, connection
      )
      select v_daily.id, incoming.account_id, coalesce(incoming.v ->> 'id', ''),
             coalesce(incoming.v ->> 'orderId', ''),
             coalesce(incoming.v ->> 'strategyName', ''), coalesce(incoming.v ->> 'instrument', ''),
             coalesce(incoming.v ->> 'action', ''), nullif(incoming.v ->> 'quantity', '')::numeric,
             nullif(incoming.v ->> 'price', '')::numeric, coalesce(incoming.v ->> 'time', ''),
             coalesce(incoming.v ->> 'entryExit', ''), coalesce(incoming.v ->> 'position', ''),
             coalesce(incoming.v ->> 'name', ''), nullif(incoming.v ->> 'commission', '')::numeric,
             nullif(incoming.v ->> 'rate', '')::numeric, coalesce(incoming.v ->> 'connection', '')
      from incoming_numbered as incoming
      left join pairs on pairs.ord = incoming.ord
      where pairs.ord is null
      order by incoming.ord
      returning trading_account_id
    )
    select
      coalesce((
        select array_agg(distinct stored.account_id)
        from stored_numbered as stored
        left join pairs on pairs.row_id = stored.row_id
        where pairs.row_id is null
          and stored.account_id = any(v_present_ids)
      ), '{}'),
      coalesce((
        select array_agg(distinct added.trading_account_id)
        from added
        where added.trading_account_id is not null
      ), '{}'),
      (select count(*) from refreshed)
      into v_unseen_ids, v_grown_ids, v_touched;

    -- ---------------------------------------------------------------------
    -- RULE C, the safety net. A present account with a stored fill the
    -- payload did not carry: the derivation the payload brought saw a subset
    -- of the day, so neither it nor the per strategy figures it produced
    -- stand. An account that gained fills: a strategy row kept from an earlier
    -- capture that the payload neither replaced nor brought back as fromStore
    -- was derived over fewer fills than the day now holds. With the route
    -- sending the day's fills and strategies back, neither happens; this is
    -- what holds when it could not.
    -- ---------------------------------------------------------------------
    update public.strategy_snapshots as target
    set derived_realized = null
    where target.daily_import_id = v_daily.id
      and target.source = 'capture'
      and target.derived_realized is not null
      and (
        target.trading_account_id = any(v_unseen_ids)
        or (target.trading_account_id = any(v_grown_ids)
          and not (target.id = any(v_refreshed_strategy_ids))
          and not (target.id = any(v_inserted_strategy_ids)))
      );

    update public.account_snapshots as snapshot
    set derivation = null
    where snapshot.daily_import_id = v_daily.id
      and snapshot.trading_account_id = any(v_unseen_ids)
      and snapshot.derivation is not null;
  end if;

  -- -------------------------------------------------------------------------
  -- FLAGS (rule e).
  --
  -- Never the three kinds this file introduces. Replace closed day deletes
  -- every other flag of the day, as step 50 did. A merge deletes only what
  -- it writes again: the flags of the accounts this capture speaks for, and
  -- the client level ones (no account) the import regenerates. An account the
  -- capture does not list, or one rule d holds back, keeps its flags, as it
  -- keeps its rows; a payload flag for it is added only when the day holds no
  -- flag of that type for it yet, so a second capture never stacks a copy.
  -- -------------------------------------------------------------------------
  if v_replace then
    delete from public.operational_flags
    where daily_import_id = v_daily.id
      and not (type = any(v_protected));
  else
    delete from public.operational_flags
    where daily_import_id = v_daily.id
      and not (type = any(v_protected))
      and (trading_account_id is null or trading_account_id = any(v_present_ids));
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_import_result -> 'flags', '[]'::jsonb))
  loop
    v_account_id := (v_account_ids ->> lower(coalesce(v_item ->> 'accountName', '')))::uuid;
    if not v_replace then
      -- After a merge the day may still hold an account this capture did not
      -- list, and "did not appear in this close" would then be false.
      continue when coalesce(v_item ->> 'type', '') = 'Missing account'
        and exists (
          select 1
          from public.account_snapshots as snapshot
          where snapshot.daily_import_id = v_daily.id
            and lower(btrim(snapshot.account_name)) = lower(btrim(coalesce(v_item ->> 'accountName', '')))
        );
      continue when v_account_id is not null
        and not (v_account_id = any(v_present_ids))
        and exists (
          select 1
          from public.operational_flags as flag
          where flag.daily_import_id = v_daily.id
            and flag.trading_account_id = v_account_id
            and flag.type = coalesce(v_item ->> 'type', 'Import review')
        );
    end if;
    insert into public.operational_flags (
      daily_import_id, client_id, trading_account_id, type, severity,
      message, status, resolved_at, resolved_by_user_id
    ) values (
      v_daily.id, p_client_id, v_account_id, coalesce(v_item ->> 'type', 'Import review'),
      coalesce(v_item ->> 'severity', 'Warning'), coalesce(v_item ->> 'message', ''),
      coalesce(v_item ->> 'status', 'Open'), nullif(v_item ->> 'resolvedAt', '')::timestamptz,
      nullif(v_item ->> 'resolvedByUserId', '')::uuid
    );
  end loop;

  -- Rule d's flag, one per close and account, with both readings.
  v_capture_time := to_char(v_batch.captured_at at time zone 'America/New_York', 'HH24:MI');
  foreach v_account_name in array v_kept
  loop
    select item.value into v_capture
    from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb)) as item(value)
    where lower(btrim(coalesce(item.value ->> 'accountName', ''))) = v_account_name
    limit 1;
    select snapshot.* into v_stored
    from public.account_snapshots as snapshot
    where snapshot.daily_import_id = v_daily.id
      and lower(btrim(snapshot.account_name)) = v_account_name
    order by (snapshot.source = 'capture') desc, snapshot.created_at, snapshot.id
    limit 1;
    v_account_id := (v_account_ids ->> lower(coalesce(v_capture ->> 'accountName', '')))::uuid;
    select coalesce(nullif(btrim(account.alias), ''), account.account_name) into v_label
    from public.trading_accounts as account
    where account.id = v_account_id;
    select count(*)::integer into v_stored_fills
    from public.executions as stored
    where stored.daily_import_id = v_daily.id
      and stored.trading_account_id = v_account_id;
    perform public.write_close_merge_flag(
      v_daily.id, p_client_id, v_account_id,
      'Capture lost activity', 'Warning',
      format('%s traded on %s, but the capture at %s New York showed no fills and %s realized. The CRM kept what an earlier capture stored: %s fill(s), %s realized, balance %s. The account was most likely disconnected when the capture ran.',
        coalesce(v_label, v_capture ->> 'accountName'), v_date,
        coalesce(v_capture_time, 'an unknown time'),
        coalesce(public.account_observation_money(nullif(v_capture ->> 'grossRealizedPnl', '')::numeric), '$0'),
        v_stored_fills,
        coalesce(public.account_observation_money(v_stored.gross_realized_pnl), '$0'),
        coalesce(public.account_observation_money(v_stored.account_balance), 'not recorded')),
      jsonb_build_object(
        'accountName', coalesce(v_stored.account_name, v_capture ->> 'accountName'),
        'stored', jsonb_build_object(
          'realized', v_stored.gross_realized_pnl,
          'unrealized', v_stored.unrealized_pnl,
          'balance', v_stored.account_balance,
          'executions', v_stored_fills,
          'source', v_stored.source),
        'capture', jsonb_build_object(
          'realized', nullif(v_capture ->> 'grossRealizedPnl', '')::numeric,
          'unrealized', nullif(v_capture ->> 'unrealizedPnl', '')::numeric,
          'balance', nullif(v_capture ->> 'accountBalance', '')::numeric,
          'executions', 0,
          'batchId', p_source_batch_id,
          'capturedAt', v_batch.captured_at)));
  end loop;

  return v_daily;
end;
$function$;

comment on function public.persist_auto_daily_import(uuid, uuid, jsonb) is
  'Persists one automatically collected daily import. Since step 73 a later capture MERGES into the day: accounts it does not list keep every row and every flag; for the accounts it lists, fills and orders merge by external id (fallback identity without one; an order in both takes the newer values), strategy rows are upserted per (account, strategy name, instrument) and rows sent back fromStore refresh the stored row''s derived figure, and an account whose stored rows show activity while the capture shows none keeps its rows with a Capture lost activity flag. derived_realized is NULLed where the payload did not see the whole merged fill set. A merge cannot remove a stored fill. The Manager''s closed day replacement still replaces (step 50 semantics). Flags of the three step 73 kinds are never deleted by a capture.';

-- Step 28's reach, restated: nobody calls this directly. The endpoint calls v3,
-- which calls v2, which calls this, and the closed day replacement calls it;
-- all are security definer, so the chain needs no grant at the bottom.
revoke all on function public.persist_auto_daily_import(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. fill_daily_import_from_tracker: Part 2 for one close.
-- ---------------------------------------------------------------------------
create or replace function public.fill_daily_import_from_tracker(p_daily_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_tz constant text := 'America/New_York';
  v_daily public.daily_imports;
  v_batch public.ingest_batches;
  v_captured_at timestamptz;
  v_capture_basis text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  r record;
  v_account_id uuid;
  v_snapshot_id uuid;
  v_detail jsonb;
  v_fill_keys text[] := '{}';
  v_skipped_unknown integer := 0;
  v_skipped_not_live integer := 0;
  v_filled integer := 0;
  v_refreshed integer := 0;
  v_strategies integer := 0;
  v_flags integer := 0;
  v_resolved integer := 0;
  v_count integer;
  v_result jsonb;
begin
  begin
    -- The day's row lock: a capture of the same day waits for this, and this
    -- waits for it, so the two never interleave.
    select daily.* into v_daily
    from public.daily_imports as daily
    where daily.id = p_daily_import_id
    for update;
    if not found then
      return jsonb_build_object('filled', false, 'reason', 'no_daily_import', 'dailyImportId', p_daily_import_id);
    end if;

    -- THE CAPTURE TIME: the finalized batch, step 66's choice of it; else a
    -- pin that knew it; else 17:00 New York on the trading date.
    select batch.* into v_batch
    from public.ingest_batches as batch
    where batch.daily_import_id = p_daily_import_id
      and batch.status in ('processed', 'incomplete')
    order by (batch.id is not distinct from v_daily.source_batch_id) desc,
             batch.processed_at desc nulls last,
             batch.captured_at desc
    limit 1;
    if found and v_batch.captured_at is not null then
      v_captured_at := v_batch.captured_at;
      v_capture_basis := 'captured';
    end if;
    if v_captured_at is null then
      select max(pin.close_captured_at) into v_captured_at
      from public.tracker_close_readings as pin
      where pin.daily_import_id = p_daily_import_id
        and pin.close_time_basis = 'captured';
      if v_captured_at is not null then
        v_capture_basis := 'pinned';
      end if;
    end if;
    if v_captured_at is null then
      v_captured_at := (v_daily.trading_date + time '17:00') at time zone v_tz;
      v_capture_basis := 'assumed_17_00';
    end if;
    v_day_start := v_daily.trading_date::timestamp at time zone v_tz;
    v_day_end := v_day_start + interval '1 day';

    -- The accounts this close already holds a fill for, once, as keys.
    select coalesce(array_agg(distinct lower(btrim(account.account_name))), '{}')
      into v_fill_keys
    from public.executions as fill
    join public.trading_accounts as account on account.id = fill.trading_account_id
    where fill.daily_import_id = p_daily_import_id;

    for r in
      with runs as (
        -- The history of the day up to the capture: every run that began at
        -- or before it and was still running on the trading date.
        select lower(btrim(run.account_name)) as key,
               run.account_name,
               run.device_id,
               run.connection_name,
               run.connected,
               run.status,
               run.realized_pnl,
               run.unrealized_pnl,
               run.total_pnl,
               run.first_sampled_at,
               least(run.last_sampled_at, v_captured_at) as sampled_at
        from public.account_live_sample_history as run
        where run.client_id = v_daily.client_id
          and run.last_sampled_at >= v_day_start
          and run.first_sampled_at <= v_captured_at
      ),
      traded as (
        -- ACTIVE: at least one CONNECTED run of the day with a realized
        -- figure. A disconnected account keeps showing whatever NinjaTrader
        -- last held for it, so a disconnected reading is never evidence.
        select distinct runs.key
        from runs
        where runs.connected
          and abs(coalesce(runs.realized_pnl, 0)) > 0.005
      ),
      last_connected as (
        select distinct on (runs.key) runs.*
        from runs
        where runs.connected
        order by runs.key, runs.first_sampled_at desc, runs.sampled_at desc
      ),
      pinned as (
        select lower(btrim(pin.account_name)) as key,
               pin.account_name,
               pin.device_id,
               pin.connection_name,
               pin.connected,
               pin.status,
               pin.realized_pnl,
               pin.unrealized_pnl,
               pin.total_pnl,
               pin.sampled_at,
               pin.reset_seen,
               pin.strategies
        from public.tracker_close_readings as pin
        where pin.daily_import_id = p_daily_import_id
          and pin.source <> 'none'
      ),
      chosen as (
        -- 1. The history holds the day: the money of the last connected run,
        --    for an account one of whose connected runs showed activity.
        select last_connected.key,
               last_connected.account_name,
               'account_live_sample_history'::text as origin,
               last_connected.device_id,
               last_connected.connection_name,
               last_connected.connected,
               last_connected.status,
               last_connected.realized_pnl,
               last_connected.unrealized_pnl,
               last_connected.total_pnl,
               last_connected.sampled_at,
               coalesce(pinned.reset_seen, false) as reset_seen,
               coalesce(pinned.strategies, '[]'::jsonb) as strategies
        from last_connected
        join traded on traded.key = last_connected.key
        left join pinned on pinned.key = last_connected.key
        union all
        -- 2. The history no longer holds the day for this account (it keeps
        --    five days): the pinned reading, and only one taken while the
        --    account was connected and showing activity.
        select pinned.key,
               pinned.account_name,
               'tracker_close_readings'::text,
               pinned.device_id,
               pinned.connection_name,
               pinned.connected,
               pinned.status,
               pinned.realized_pnl,
               pinned.unrealized_pnl,
               pinned.total_pnl,
               pinned.sampled_at,
               pinned.reset_seen,
               pinned.strategies
        from pinned
        where pinned.connected
          and abs(coalesce(pinned.realized_pnl, 0)) > 0.005
          and not exists (select 1 from runs where runs.key = pinned.key)
      ),
      live as (
        select lower(btrim(sample.account_name)) as key,
               jsonb_agg(jsonb_build_object(
                 'strategyId', sample.strategy_id,
                 'strategyName', sample.strategy_name,
                 'algorithm', sample.algorithm,
                 'instrument', sample.instrument,
                 'realizedPnl', sample.realized_pnl,
                 'unrealizedPnl', sample.unrealized_pnl,
                 'restartedAt', sample.restarted_at,
                 'sampledAt', sample.sampled_at)
                 order by sample.strategy_name, sample.instrument, sample.strategy_id) as strategies
        from public.algorithm_live_samples as sample
        where sample.client_id = v_daily.client_id
          and sample.sampled_at >= v_day_start
          and sample.sampled_at < v_day_end
        group by lower(btrim(sample.account_name))
      )
      select chosen.key,
             chosen.account_name,
             chosen.origin,
             chosen.device_id,
             chosen.connection_name,
             chosen.connected,
             chosen.status,
             chosen.realized_pnl,
             chosen.unrealized_pnl,
             chosen.total_pnl,
             chosen.sampled_at,
             chosen.reset_seen,
             -- The pin's strategy readings (kept for good), else the latest
             -- of the day while algorithm_live_samples still holds them.
             case when jsonb_typeof(chosen.strategies) = 'array' and jsonb_array_length(chosen.strategies) > 0
               then chosen.strategies
               else coalesce(live.strategies, '[]'::jsonb)
             end as strategy_readings,
             account.id as account_id,
             coalesce(nullif(btrim(account.alias), ''), account.account_name) as label,
             account.status as account_status,
             account.account_type,
             snapshot.id as snapshot_id,
             snapshot.source as snapshot_source,
             snapshot.gross_realized_pnl as close_realized,
             snapshot.source_detail as snapshot_detail,
             snapshot.trading_account_id as snapshot_account_id
      from chosen
      left join live on live.key = chosen.key
      left join lateral (
        select candidate.*
        from public.trading_accounts as candidate
        where candidate.client_id = v_daily.client_id
          and lower(candidate.account_name) = lower(chosen.account_name)
        order by candidate.created_at, candidate.id
        limit 1
      ) as account on true
      left join lateral (
        select candidate.*
        from public.account_snapshots as candidate
        where candidate.daily_import_id = p_daily_import_id
          and lower(btrim(candidate.account_name)) = chosen.key
        order by (candidate.source = 'capture') desc, candidate.created_at, candidate.id
        limit 1
      ) as snapshot on true
      order by chosen.key
    loop
      -- NEVER A NEW REGISTRY ROW. An account the client's registry does not
      -- hold is not filled: the tracker sees every account on the machine,
      -- and only the close (or a person) decides what the desk tracks.
      if r.account_id is null and r.snapshot_id is null then
        v_skipped_unknown := v_skipped_unknown + 1;
        continue;
      end if;
      -- Not live by its status or its type (Failed, Inactive, Reserve,
      -- Inactive / Ignore): step 67's own rule. The observation is passed as
      -- NULL on purpose: "absent" and "breached" are what earlier closes said,
      -- and an account the tracker saw trade today is not absent from it.
      -- Simulation accounts are live here; the reports keep them apart.
      if r.account_id is not null
        and public.account_is_past_live_flags(r.account_status, r.account_type, null) then
        v_skipped_not_live := v_skipped_not_live + 1;
        continue;
      end if;
      v_account_id := r.account_id;

      v_detail := jsonb_build_object(
        'origin', r.origin,
        'sampledAt', r.sampled_at,
        'deviceId', r.device_id,
        'connected', r.connected,
        'status', r.status,
        'realizedPnl', r.realized_pnl,
        'unrealizedPnl', r.unrealized_pnl,
        'totalPnl', r.total_pnl,
        'captureTime', v_captured_at,
        'captureBasis', v_capture_basis
      );

      if r.snapshot_id is null then
        -- a. The provisional account, on the registry row the close would use.
        v_snapshot_id := null;
        insert into public.account_snapshots (
          daily_import_id, trading_account_id, account_name, connection,
          gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl,
          unrealized_pnl, derivation, source, source_detail
        ) values (
          p_daily_import_id, v_account_id, r.account_name, coalesce(r.connection_name, ''),
          r.realized_pnl, null, null, null,
          r.unrealized_pnl, null, 'tracker', v_detail
        )
        on conflict (daily_import_id, account_name) do nothing
        returning id into v_snapshot_id;
        continue when v_snapshot_id is null;
        v_filled := v_filled + 1;

        insert into public.strategy_snapshots (
          daily_import_id, trading_account_id, account_snapshot_id, strategy_name,
          strategy_family, strategy_version, instrument, data_series,
          parameters_raw, params_parsed, direction, enabled, ran, ran_basis,
          realized, unrealized, derived_realized, source
        )
        select p_daily_import_id, v_account_id, v_snapshot_id,
               coalesce(strategy.value ->> 'strategyName', ''),
               coalesce(strategy.value ->> 'algorithm', ''), '',
               coalesce(strategy.value ->> 'instrument', ''), '', '', '{}'::jsonb, '', false,
               case when abs(coalesce(reading.realized, 0)) > 0.005 then true end,
               case when abs(coalesce(reading.realized, 0)) > 0.005 then 'realized' end,
               reading.realized,
               reading.unrealized,
               null,
               'tracker'
        from jsonb_array_elements(r.strategy_readings) with ordinality as strategy(value, ordinality)
        cross join lateral (
          select case when jsonb_typeof(strategy.value -> 'realizedPnl') = 'number'
                   then (strategy.value ->> 'realizedPnl')::numeric end as realized,
                 case when jsonb_typeof(strategy.value -> 'unrealizedPnl') = 'number'
                   then (strategy.value ->> 'unrealizedPnl')::numeric end as unrealized
        ) as reading
        order by strategy.ordinality;
        get diagnostics v_count = row_count;
        v_strategies := v_strategies + v_count;

        v_flags := v_flags + public.write_close_merge_flag(
          p_daily_import_id, v_daily.client_id, v_account_id,
          'Tracker only account', 'Warning',
          format('%s is not in the close, but the tracker saw it trade on %s: realized %s, unrealized %s, total %s at %s New York, its last reading while connected. Its row in this close comes from the tracker, with no fills and no balance, until a capture lists it.',
            coalesce(r.label, r.account_name), v_daily.trading_date,
            coalesce(public.account_observation_money(r.realized_pnl), 'not reported'),
            coalesce(public.account_observation_money(r.unrealized_pnl), 'not reported'),
            coalesce(public.account_observation_money(r.total_pnl), 'not reported'),
            to_char(r.sampled_at at time zone v_tz, 'HH24:MI')),
          jsonb_build_object('accountName', r.account_name, 'tracker', v_detail,
            'strategies', jsonb_array_length(r.strategy_readings)));

      elsif r.snapshot_source = 'tracker' then
        -- d. A provisional row gives way to a strictly newer reading, never to
        -- one taken after a NinjaTrader reset.
        continue when r.reset_seen
          or r.sampled_at is null
          or (r.snapshot_detail ->> 'sampledAt') is null
          or r.sampled_at <= (r.snapshot_detail ->> 'sampledAt')::timestamptz;
        update public.account_snapshots
        set gross_realized_pnl = r.realized_pnl,
            unrealized_pnl = r.unrealized_pnl,
            connection = coalesce(r.connection_name, connection),
            source_detail = v_detail
        where id = r.snapshot_id;
        delete from public.strategy_snapshots
        where daily_import_id = p_daily_import_id
          and account_snapshot_id = r.snapshot_id
          and source = 'tracker';
        insert into public.strategy_snapshots (
          daily_import_id, trading_account_id, account_snapshot_id, strategy_name,
          strategy_family, strategy_version, instrument, data_series,
          parameters_raw, params_parsed, direction, enabled, ran, ran_basis,
          realized, unrealized, derived_realized, source
        )
        select p_daily_import_id, coalesce(r.snapshot_account_id, v_account_id), r.snapshot_id,
               coalesce(strategy.value ->> 'strategyName', ''),
               coalesce(strategy.value ->> 'algorithm', ''), '',
               coalesce(strategy.value ->> 'instrument', ''), '', '', '{}'::jsonb, '', false,
               case when abs(coalesce(reading.realized, 0)) > 0.005 then true end,
               case when abs(coalesce(reading.realized, 0)) > 0.005 then 'realized' end,
               reading.realized,
               reading.unrealized,
               null,
               'tracker'
        from jsonb_array_elements(r.strategy_readings) with ordinality as strategy(value, ordinality)
        cross join lateral (
          select case when jsonb_typeof(strategy.value -> 'realizedPnl') = 'number'
                   then (strategy.value ->> 'realizedPnl')::numeric end as realized,
                 case when jsonb_typeof(strategy.value -> 'unrealizedPnl') = 'number'
                   then (strategy.value ->> 'unrealizedPnl')::numeric end as unrealized
        ) as reading
        order by strategy.ordinality;
        v_refreshed := v_refreshed + 1;
        perform public.write_close_merge_flag(
          p_daily_import_id, v_daily.client_id, coalesce(r.snapshot_account_id, v_account_id),
          'Tracker only account', 'Warning',
          format('%s is not in the close, but the tracker saw it trade on %s: realized %s, unrealized %s, total %s at %s New York, its last reading while connected. Its row in this close comes from the tracker, with no fills and no balance, until a capture lists it.',
            coalesce(r.label, r.account_name), v_daily.trading_date,
            coalesce(public.account_observation_money(r.realized_pnl), 'not reported'),
            coalesce(public.account_observation_money(r.unrealized_pnl), 'not reported'),
            coalesce(public.account_observation_money(r.total_pnl), 'not reported'),
            to_char(r.sampled_at at time zone v_tz, 'HH24:MI')),
          jsonb_build_object('accountName', r.account_name, 'tracker', v_detail,
            'strategies', jsonb_array_length(r.strategy_readings)));

      else
        -- c. In the close with nothing in it, while the tracker saw a trade.
        continue when r.key = any(v_fill_keys) or abs(coalesce(r.close_realized, 0)) > 0.005;
        v_flags := v_flags + public.write_close_merge_flag(
          p_daily_import_id, v_daily.client_id, coalesce(r.snapshot_account_id, v_account_id),
          'Close below tracker', 'Critical',
          format('%s is in the close with no fills and %s realized, but the tracker read realized %s, total %s at %s New York on %s, its last reading while connected. The day''s money for it is probably missing from the close.',
            coalesce(r.label, r.account_name),
            coalesce(public.account_observation_money(r.close_realized), '$0'),
            coalesce(public.account_observation_money(r.realized_pnl), 'not reported'),
            coalesce(public.account_observation_money(r.total_pnl), 'not reported'),
            to_char(r.sampled_at at time zone v_tz, 'HH24:MI'),
            v_daily.trading_date),
          jsonb_build_object('accountName', r.account_name, 'tracker', v_detail,
            'close', jsonb_build_object('realized', r.close_realized, 'executions', 0)));
      end if;
    end loop;

    -- b. and c., undone by a later capture.
    update public.operational_flags as flag
    set status = 'Resolved',
        resolved_at = clock_timestamp(),
        resolved_by_user_id = null,
        resolution_note = 'A later capture included this account.'
    where flag.daily_import_id = p_daily_import_id
      and flag.type = 'Tracker only account'
      and coalesce(flag.status, 'Open') = 'Open'
      and exists (
        select 1
        from public.account_snapshots as snapshot
        where snapshot.daily_import_id = p_daily_import_id
          and snapshot.trading_account_id = flag.trading_account_id
          and snapshot.source = 'capture'
      );
    get diagnostics v_count = row_count;
    v_resolved := v_resolved + v_count;

    update public.operational_flags as flag
    set status = 'Resolved',
        resolved_at = clock_timestamp(),
        resolved_by_user_id = null,
        resolution_note = 'A later capture showed this account trading.'
    where flag.daily_import_id = p_daily_import_id
      and flag.type = 'Close below tracker'
      and coalesce(flag.status, 'Open') = 'Open'
      and (
        exists (
          select 1 from public.executions as fill
          where fill.daily_import_id = p_daily_import_id
            and fill.trading_account_id = flag.trading_account_id
        )
        or exists (
          select 1 from public.account_snapshots as snapshot
          where snapshot.daily_import_id = p_daily_import_id
            and snapshot.trading_account_id = flag.trading_account_id
            and snapshot.source = 'capture'
            and abs(coalesce(snapshot.gross_realized_pnl, 0)) > 0.005
        )
      );
    get diagnostics v_count = row_count;
    v_resolved := v_resolved + v_count;

    v_result := jsonb_build_object(
      'filled', true,
      'dailyImportId', p_daily_import_id,
      'clientId', v_daily.client_id,
      'tradingDate', v_daily.trading_date,
      'captureTime', v_captured_at,
      'captureBasis', v_capture_basis,
      'accountsFilled', v_filled,
      'accountsRefreshed', v_refreshed,
      'strategiesFilled', v_strategies,
      'flagsWritten', v_flags,
      'flagsResolved', v_resolved,
      'skippedUnknown', v_skipped_unknown,
      'skippedNotLive', v_skipped_not_live
    );

    if v_filled + v_refreshed + v_flags + v_resolved > 0 then
      insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
      values (null, 'daily_import', p_daily_import_id, 'tracker_fill_applied', v_result - 'filled');
    end if;

    return v_result;
  exception when others then
    raise warning 'step 73: tracker fill skipped for daily import %: % (%)',
      p_daily_import_id, sqlerrm, sqlstate;
    return jsonb_build_object(
      'filled', false,
      'reason', 'error',
      'dailyImportId', p_daily_import_id,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end;
$function$;

comment on function public.fill_daily_import_from_tracker(uuid) is
  'Part 2 of step 73 for one close: a provisional account_snapshot (source tracker) and strategy rows for every account the tracker saw trade that the close does not hold, a Tracker only account flag for each, a Close below tracker flag for an account in the close with no fills and no realized while the tracker saw activity, and the resolution of both when a later capture answers them. Activity means a CONNECTED run of the day with a realized figure; the money is the last connected run before the capture time (the pinned reading only when the history no longer holds the day). Only live registry accounts, simulation included; never creates a registry row (skippedUnknown, skippedNotLive). Never writes a capture row, never raises (a fault is a WARNING and {filled: false}). Fired after every finalize by tracker_fill_on_batch; for many closes at once, fill_day_from_tracker.';

-- The service role may call it for one close, as it may step 66's pin: a
-- close uploaded by hand is never finalized, so nothing fires it there.
revoke all on function public.fill_daily_import_from_tracker(uuid) from public, anon, authenticated;
grant execute on function public.fill_daily_import_from_tracker(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Step 66's pin, reading the close's CAPTURE rows only.
--
-- record_tracker_close_readings takes "the close's accounts" from
-- account_snapshots. After a fill, the provisional rows of the accounts the
-- close lost are in that table too, and a later pin would call them accounts
-- the close lists: counted in accountsInClose, preferred for the spelling, and
-- pinned as 'none' when a narrower cutoff no longer finds their reading. So
-- the function is reproduced from step 66 verbatim except for `source =
-- 'capture'` on its two reads of account_snapshots, the same signature,
-- grants and never-raises contract. A re-run of 66 puts the old reads back;
-- run 73 again after it.
-- ---------------------------------------------------------------------------
create or replace function public.record_tracker_close_readings(p_daily_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_daily public.daily_imports;
  v_batch public.ingest_batches;
  v_device public.ingest_devices;
  v_settings public.account_tracker_settings;
  v_timezone text := 'America/New_York';
  v_schedule time := '16:30:00';
  v_captured_at timestamptz;
  v_basis text;
  v_grace integer;
  v_stale integer;
  v_tolerance numeric;
  v_max_strategies integer;
  v_history_retention integer;
  v_cutoff timestamptz;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_pinned integer := 0;
  v_in_close integer := 0;
  v_from_history integer := 0;
  v_without integer := 0;
  v_after_close integer := 0;
  v_resets integer := 0;
  v_strategies integer := 0;
  v_history_seen integer := 0;
  v_live_seen integer := 0;
  v_counts jsonb;
begin
  begin
    select daily.* into v_daily
    from public.daily_imports as daily
    where daily.id = p_daily_import_id;
    if not found then
      return jsonb_build_object('recorded', false, 'reason', 'no_daily_import', 'dailyImportId', p_daily_import_id);
    end if;

    select settings.* into v_settings
    from public.account_tracker_settings as settings
    where settings.id;
    v_grace := coalesce(v_settings.pre_close_grace_seconds, 120);
    v_stale := coalesce(v_settings.stale_sample_seconds, 1500);
    v_tolerance := coalesce(v_settings.close_match_tolerance_dollars, 5);
    v_max_strategies := coalesce(v_settings.max_strategies_per_account, 50);
    v_history_retention := coalesce(v_settings.history_retention_days, 5);

    -- The close batch: the one that finalized this import. After a second close
    -- the earlier batch still names the import with status 'replaced', so only
    -- a finished one counts, the import's own source batch first.
    select batch.* into v_batch
    from public.ingest_batches as batch
    where batch.daily_import_id = p_daily_import_id
      and batch.status in ('processed', 'incomplete')
    order by (batch.id is not distinct from v_daily.source_batch_id) desc,
             batch.processed_at desc nulls last,
             batch.captured_at desc
    limit 1;

    if found then
      v_captured_at := v_batch.captured_at;
      v_basis := 'captured';
      select device.* into v_device
      from public.ingest_devices as device
      where device.id = v_batch.device_id;
    else
      v_basis := 'scheduled';
      -- The client's latest active machine, the way ingest-status.js picks one.
      select device.* into v_device
      from public.ingest_devices as device
      where device.client_id = v_daily.client_id
        and device.status = 'active'
        and device.revoked_at is null
      order by device.created_at desc
      limit 1;
    end if;
    if v_device.id is not null then
      v_timezone := coalesce(v_device.schedule_timezone, v_timezone);
      v_schedule := coalesce(v_device.schedule_time, v_schedule);
    end if;
    if v_captured_at is null then
      v_captured_at := (v_daily.trading_date + v_schedule) at time zone v_timezone;
    end if;
    v_cutoff := v_captured_at + make_interval(secs => v_grace);
    v_day_start := v_daily.trading_date::timestamp at time zone v_timezone;
    v_day_end := v_day_start + interval '1 day';

    delete from public.tracker_close_readings where daily_import_id = p_daily_import_id;

    with candidates as (
      select run.*, lower(run.account_name) as key
      from public.account_live_sample_history as run
      where run.client_id = v_daily.client_id
        and run.last_sampled_at >= v_day_start
        and run.first_sampled_at <= v_cutoff
    ),
    names as (
      select named.key,
             coalesce(max(named.account_name) filter (where named.in_close), max(named.account_name)) as account_name,
             bool_or(named.in_close) as in_close
      from (
        select lower(btrim(snapshot.account_name)) as key, btrim(snapshot.account_name) as account_name, true as in_close
        from public.account_snapshots as snapshot
        where snapshot.daily_import_id = p_daily_import_id
          and btrim(snapshot.account_name) <> ''
          -- Step 73: a provisional row is the tracker's own reading written
          -- back, never the close's.
          and snapshot.source = 'capture'
        union all
        select candidate.key, candidate.account_name, false
        from candidates as candidate
      ) as named
      group by named.key
    ),
    picked as (
      select distinct on (candidate.key) candidate.*
      from candidates as candidate
      order by candidate.key, candidate.first_sampled_at desc, candidate.last_sampled_at desc
    ),
    nexts as (
      select lower(run.account_name) as key, min(run.first_sampled_at) as next_sampled_at
      from public.account_live_sample_history as run
      where run.client_id = v_daily.client_id
        and run.first_sampled_at > v_cutoff
        and run.first_sampled_at < v_day_end
      group by lower(run.account_name)
    ),
    resets as (
      select stepped.key,
             bool_or(stepped.connected
               and stepped.prev_realized is not null
               and stepped.realized_pnl is not null
               and abs(stepped.prev_realized) > 10 * v_tolerance
               and abs(stepped.realized_pnl) <= v_tolerance) as reset_seen
      from (
        select candidate.key, candidate.connected, candidate.realized_pnl,
               lag(candidate.realized_pnl) over (
                 partition by candidate.key
                 order by candidate.first_sampled_at, candidate.last_sampled_at) as prev_realized
        from candidates as candidate
      ) as stepped
      group by stepped.key
    ),
    instances as (
      select lower(live.account_name) as key,
             row_number() over (
               partition by lower(live.account_name)
               order by live.strategy_name, live.instrument, live.strategy_id) as ordinal,
             jsonb_build_object(
               'strategyId', live.strategy_id,
               'strategyName', live.strategy_name,
               'algorithm', live.algorithm,
               'instrument', live.instrument,
               'realizedPnl', live.realized_pnl,
               'unrealizedPnl', live.unrealized_pnl,
               'restartedAt', live.restarted_at,
               'sampledAt', live.sampled_at) as item
      from public.algorithm_live_samples as live
      where live.client_id = v_daily.client_id
        and live.sampled_at >= v_day_start
        and live.sampled_at < v_day_end
    ),
    strategies as (
      select instance.key, jsonb_agg(instance.item order by instance.ordinal) as strategies
      from instances as instance
      where instance.ordinal <= v_max_strategies
      group by instance.key
    )
    insert into public.tracker_close_readings (
      daily_import_id, client_id, device_id, trading_date, account_name, source,
      connection_name, connected, status, realized_pnl, unrealized_pnl, total_pnl,
      strategy_count, enabled_strategy_count, run_state,
      sampled_at, reading_since, reset_seen, next_sampled_at, strategies,
      close_batch_id, close_captured_at, close_time_basis, grace_seconds, stale_seconds, compared_at
    )
    select p_daily_import_id,
           v_daily.client_id,
           coalesce(pick.device_id, v_batch.device_id),
           v_daily.trading_date,
           named.account_name,
           case when pick.key is not null then 'crm_history' else 'none' end,
           pick.connection_name, pick.connected, pick.status,
           pick.realized_pnl, pick.unrealized_pnl, pick.total_pnl,
           pick.strategy_count, pick.enabled_strategy_count, pick.run_state,
           case when pick.key is not null then least(pick.last_sampled_at, v_cutoff) end,
           pick.first_sampled_at,
           coalesce(reset.reset_seen, false),
           next.next_sampled_at,
           coalesce(instance.strategies, '[]'::jsonb),
           v_batch.id, v_captured_at, v_basis, v_grace, v_stale, v_now
    from names as named
    left join picked as pick on pick.key = named.key
    left join nexts as next on next.key = named.key
    left join resets as reset on reset.key = named.key
    left join strategies as instance on instance.key = named.key;

    select count(*),
           count(*) filter (where pinned.source = 'crm_history'),
           count(*) filter (where pinned.source = 'none'),
           count(*) filter (where pinned.source = 'none' and pinned.next_sampled_at is not null),
           count(*) filter (where pinned.reset_seen),
           coalesce(sum(jsonb_array_length(pinned.strategies)), 0)
      into v_pinned, v_from_history, v_without, v_after_close, v_resets, v_strategies
    from public.tracker_close_readings as pinned
    where pinned.daily_import_id = p_daily_import_id;

    select count(*) into v_in_close
    from public.account_snapshots as snapshot
    where snapshot.daily_import_id = p_daily_import_id
      and btrim(snapshot.account_name) <> ''
      and snapshot.source = 'capture';
    select count(*) into v_history_seen
    from public.account_live_sample_history as run
    where run.client_id = v_daily.client_id
      and run.last_sampled_at >= v_day_start
      and run.first_sampled_at <= v_cutoff;
    select count(*) into v_live_seen
    from public.account_live_samples as sample
    where sample.client_id = v_daily.client_id;

    -- The client's history, swept past the retention window. Cheap, bounded,
    -- and the second of the two places a run ever leaves.
    delete from public.account_live_sample_history as run
    where run.client_id = v_daily.client_id
      and run.last_sampled_at < v_now - make_interval(days => v_history_retention);

    v_counts := jsonb_build_object(
      'recorded', true,
      'clientId', v_daily.client_id,
      'dailyImportId', p_daily_import_id,
      'tradingDate', v_daily.trading_date,
      'closeBatchId', v_batch.id,
      'deviceId', v_device.id,
      'closeCapturedAt', v_captured_at,
      'closeTimeBasis', v_basis,
      'cutoffAt', v_cutoff,
      'graceSeconds', v_grace,
      'staleSeconds', v_stale,
      'accountsPinned', v_pinned,
      'accountsInClose', v_in_close,
      'accountsFromHistory', v_from_history,
      'accountsWithoutReading', v_without,
      'accountsReadAfterClose', v_after_close,
      'resetsSeen', v_resets,
      'strategiesPinned', v_strategies,
      'historyRowsSeen', v_history_seen,
      'liveRowsSeen', v_live_seen
    );

    -- One row per comparison, machine action, in finalize_ingest_batch's shape.
    -- entity_type 'daily_import' is new here: the thing compared is the close.
    insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
    values (null, 'daily_import', p_daily_import_id, 'tracker_close_compared', v_counts - 'recorded');

    return v_counts;
  exception when others then
    raise warning 'step 66: tracker close comparison skipped for daily import %: % (%)',
      p_daily_import_id, sqlerrm, sqlstate;
    return jsonb_build_object(
      'recorded', false,
      'reason', 'error',
      'dailyImportId', p_daily_import_id,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end;
$function$;

revoke all on function public.record_tracker_close_readings(uuid) from public, anon, authenticated;
grant execute on function public.record_tracker_close_readings(uuid) to service_role;

comment on function public.record_tracker_close_readings(uuid) is
  'Pins the tracker side of one close into tracker_close_readings, replacing the import''s rows (since step 73 the close''s accounts are its capture rows, never the provisional tracker rows), and writes one audit_logs row (entity_type daily_import, action tracker_close_compared). Fired by the trigger on ingest_batches when a batch becomes processed or incomplete; callable by hand for a manual close, which then uses the machine schedule as the capture time. Never raises: a fault is a WARNING and {recorded: false}.';

-- ---------------------------------------------------------------------------
-- 7. The trigger: after step 66's pin, on the same transition.
--
-- Its own trigger rather than a fifth line in step 66's function, so a re-run
-- of 66 cannot drop it. PostgreSQL fires the AFTER triggers of one event in
-- name order, and tracker_close_on_batch sorts before tracker_fill_on_batch,
-- so the pin it reads is the one just written.
-- ---------------------------------------------------------------------------
create or replace function public.tracker_fill_on_batch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.status in ('processed', 'incomplete')
    and new.daily_import_id is not null
    and (tg_op = 'INSERT'
      or old.status is distinct from new.status
      or old.daily_import_id is distinct from new.daily_import_id) then
    perform public.fill_daily_import_from_tracker(new.daily_import_id);
  end if;
  return null;
end;
$function$;

revoke all on function public.tracker_fill_on_batch() from public, anon, authenticated, service_role;

drop trigger if exists tracker_fill_on_batch on public.ingest_batches;
create trigger tracker_fill_on_batch
  after insert or update of status, daily_import_id on public.ingest_batches
  for each row execute function public.tracker_fill_on_batch();

-- ---------------------------------------------------------------------------
-- 8. fill_day_from_tracker: Part 2 for every close of one date, by hand.
-- ---------------------------------------------------------------------------
create or replace function public.fill_day_from_tracker(p_trading_date date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_import record;
  v_one jsonb;
  v_imports integer := 0;
  v_filled integer := 0;
  v_refreshed integer := 0;
  v_strategies integer := 0;
  v_flags integer := 0;
  v_resolved integer := 0;
  v_skipped_unknown integer := 0;
  v_skipped_not_live integer := 0;
  v_failed uuid[] := '{}';
begin
  if p_trading_date is null then
    raise exception 'invalid_trading_date' using errcode = '22023';
  end if;

  for v_import in
    select daily.id
    from public.daily_imports as daily
    where daily.trading_date = p_trading_date
    order by daily.client_id, daily.id
  loop
    v_imports := v_imports + 1;
    v_one := public.fill_daily_import_from_tracker(v_import.id);
    if coalesce((v_one ->> 'filled')::boolean, false) then
      v_filled := v_filled + coalesce((v_one ->> 'accountsFilled')::integer, 0);
      v_refreshed := v_refreshed + coalesce((v_one ->> 'accountsRefreshed')::integer, 0);
      v_strategies := v_strategies + coalesce((v_one ->> 'strategiesFilled')::integer, 0);
      v_flags := v_flags + coalesce((v_one ->> 'flagsWritten')::integer, 0);
      v_resolved := v_resolved + coalesce((v_one ->> 'flagsResolved')::integer, 0);
      v_skipped_unknown := v_skipped_unknown + coalesce((v_one ->> 'skippedUnknown')::integer, 0);
      v_skipped_not_live := v_skipped_not_live + coalesce((v_one ->> 'skippedNotLive')::integer, 0);
    else
      v_failed := v_failed || v_import.id;
    end if;
  end loop;

  return jsonb_build_object(
    'tradingDate', p_trading_date,
    'dailyImports', v_imports,
    'accountsFilled', v_filled,
    'accountsRefreshed', v_refreshed,
    'strategiesFilled', v_strategies,
    'flagsWritten', v_flags,
    'flagsResolved', v_resolved,
    'skippedUnknown', v_skipped_unknown,
    'skippedNotLive', v_skipped_not_live,
    'failedImports', to_jsonb(v_failed)
  );
end;
$function$;

comment on function public.fill_day_from_tracker(date) is
  'Applies step 73''s tracker fill (fill_daily_import_from_tracker) to every daily_import of one trading date, Closed ones included, and returns {tradingDate, dailyImports, accountsFilled, accountsRefreshed, strategiesFilled, flagsWritten, flagsResolved, failedImports}. Idempotent: a second run adds nothing. Never writes a capture row. Service role only.';

revoke all on function public.fill_day_from_tracker(date) from public, anon, authenticated;
grant execute on function public.fill_day_from_tracker(date) to service_role;

commit;

-- The two checks, validated outside the transaction: SHARE UPDATE EXCLUSIVE,
-- which blocks neither the browser's reads nor the ingest's writes. Each is its
-- own statement and commits on its own; a re-run validates them again.
alter table public.account_snapshots validate constraint account_snapshots_source_check;
alter table public.strategy_snapshots validate constraint strategy_snapshots_source_check;

-- What this leaves: no new table, and no table in public open. The same check
-- steps 43 to 72 end with, for the same reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 73 left % table(s) without row level security', n;
  end if;
end $$;
