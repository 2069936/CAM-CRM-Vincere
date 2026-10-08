-- Step 65: the registry learns from the close. An account that breached is
-- marked Failed by the database itself, an absent account is called absent, a
-- never seen account is called never seen, and a CAM can read why on the row.
--
-- WHY 65. 63 and 64 are applied. 64 (columns on algorithm_live_samples) landed
-- in another PR while this file was being written, so this one took 65 and
-- neither had to renumber, the way 56 took its number past 55. 54 is still a
-- deliberate gap. This file needs step 52 (the policy helpers) and nothing
-- after it; 64 and 65 touch different tables and run in either order.
--
-- THE PROBLEM, in Pedro's words. The registry (trading_accounts) carries
-- accounts that already failed at the prop firm but still read status Active,
-- so they light up as "never sampled" on the live tracker and pile up on the
-- client page; a CAM cannot tell a dead account from a new one from a missing
-- one. Production on 2026-10-08: 1364 Active rows, and of the 1090 expected to
-- trade, 566 last appeared in a close more than 30 days ago and 33 never
-- appeared at all; of 767 with a measured trailing reading, 281 read negative.
--
-- THE CRM ALREADY KNOWS HOW TO TELL. src/domain/accountLifecycle.js reads the
-- trailing drawdown of each close and decides breached / stale / never seen,
-- but only in the browser, over the LATEST close of each client (the login
-- carries nothing older), so absence over several closes cannot be computed
-- there, and nothing ever writes the conclusion anywhere. This file moves that
-- rule into the database, where every close of every client is, and makes the
-- database write the conclusion on the registry row whenever a close lands.
--
-- DECISION ALREADY MADE (do not reopen): a breach observed on a close marks the
-- account Failed by itself, with the date, an audit row and a flag for the CAM,
-- because the prop firm fails an account at breach and there is nothing to
-- confirm. Absence and never seen are observations only, never a status
-- change: six accounts on this book skipped a close and came back, so absence
-- is a state and never a death by itself.
--
-- ===========================================================================
-- THE RULE, exactly as src/domain/accountLifecycle.js has it (readingOf,
-- breachOf), so the two languages cannot disagree:
--
--   reading   = account_snapshots.trailing_max_drawdown. NULL, exactly 0, NaN
--               and infinity are "not measured" (reconcile.createSnapshot
--               writes 0 when the grid carried no drawdown column, and the
--               ingest stores a JSON null as 0). Not measured is never a breach
--               and never a measurement.
--   cash      = account_type exactly 'Cash', 'Cash - IRA' or 'Cash - Straight'
--               (reconcile.isCashType, exact string membership). Never
--               breaches: the answer is NULL, not false.
--   simulation= btrim(account_type) = 'Simulation'. Never breaches either.
--   model 1   = max_drawdown_limit > 0 on the registry row: the reading is
--               cumulative loss and abs(reading) >= limit is a breach.
--   model 2   = everything else: the reading IS the remaining buffer and
--               reading < 0 is a breach. Strictly negative; 0 never gets here.
--   the latest measured reading decides. A breach followed by a healthy
--               reading is a recovery, not a death: breached_on is the first
--               close of the CURRENT run of breached readings, and a later
--               non breached reading clears it.
--   absence   is counted in CLOSES of the client, not calendar days, to match
--               staleCloses 5 in the browser: closes_missed is the number of
--               the client's closes after the last one the account appeared in.
--
-- WHAT THIS FILE ADDS.
--
--   1. Seven columns on trading_accounts: observed_state ('seen', 'breached',
--      'absent', 'never_seen'), last_close_seen_on, closes_missed, breached_on,
--      breach_reading, observed_at, and auto_fail_flag_id (the flag the close
--      wrote when it failed the account, see the hazards below). Written by the
--      database only; the browser reads them and a trigger refuses a browser
--      write to them.
--   2. account_observation_settings, one row: stale_closes (5),
--      auto_fail_on_breach (true), new_account_days (14). Edited in the SQL
--      editor, read by the browser. To turn the auto fail off:
--        update public.account_observation_settings
--           set auto_fail_on_breach = false, updated_at = now() where id;
--   3. refresh_account_observations(client) recomputes every account of one
--      client from every close of that client and writes the seven columns. When
--      an account's state BECOMES 'breached' (it was not before this refresh)
--      and its status is Active or Payout Hold and the setting is on, it sets
--      status Failed, date_failed = coalesce(date_failed, breached_on) (never
--      overwrites a date), writes an audit row (trading_account.auto_failed)
--      and a flag for the CAM. Reserve, Inactive and already Failed rows are
--      never touched; a cleared breach never moves a status back.
--   4. Triggers that call the refresh whenever a close lands (account_snapshots
--      inserted, updated or deleted; daily_imports inserted, deleted or moved)
--      and when a registry row is inserted, so a new account does not sit at
--      the column defaults until the next close.
--   5. A backfill: every client with at least one close, once.
--
-- ===========================================================================
-- WHY THE TRIGGERS ARE DEFERRED CONSTRAINT TRIGGERS AND NOT STATEMENT LEVEL.
--
-- The automatic path (persist_auto_daily_import, step 50 body) writes the
-- snapshots in a loop and THEN runs `delete from operational_flags where
-- daily_import_id = <this close>` before inserting the payload's flags. A
-- statement level trigger on account_snapshots fires at the end of each
-- INSERT, inside that loop, so a flag it wrote for this close would be deleted
-- a few statements later by the same RPC, and the CAM would never see why the
-- account went Failed. The manual path (browser upsert) deletes the close's
-- flags BEFORE upserting the snapshots, so there the order is the other way.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at COMMIT, after
-- every statement of the transaction, on both paths. PostgreSQL only allows
-- constraint triggers FOR EACH ROW, so a close of thirty accounts queues thirty
-- firings; the trigger function remembers which clients it has refreshed in
-- this transaction (a transaction local setting, account_observations.refreshed)
-- and the second to thirtieth firing cost one string comparison. The other
-- options were weighed and rejected: a flag with daily_import_id NULL would
-- never reach the CAM flag queue (camFlagQueue.js walks dailyImports[].flags);
-- replacing persist_auto_daily_import a fourth time to move its delete would be
-- undone by a re-run of 47 or 50 and is 350 lines to carry for one statement.
--
-- The dedupe assumes the triggers fire deferred. Nothing in this repository
-- runs `set constraints all immediate`; if something ever does, the refresh
-- would run on the first row of a close and skip the rest, so do not.
--
-- RECURSION. The refresh writes trading_accounts (UPDATE only), audit_logs and
-- operational_flags, and reads daily_imports and account_snapshots. The
-- deferred triggers are on account_snapshots and daily_imports, which the
-- refresh never writes, and on trading_accounts for INSERT only, which the
-- refresh never does, so no refresh can queue another. The guard trigger on
-- trading_accounts is BEFORE INSERT OR UPDATE and only inspects the row.
--
-- THE FLAG A RE-IMPORT DELETES. Both paths delete every flag of a close before
-- writing that close's flags again, and a day is captured more than once (an
-- intraday read, then the 16:30 close). So the flag this file writes for a
-- breach would be gone after the second capture of the same day, and the auto
-- fail fires on the transition only, so nothing would put it back. Each account
-- the close failed therefore keeps the id of its flag (auto_fail_flag_id), and
-- the refresh writes the flag again when that id points at no row while the
-- account is still Failed and still breached. A flag a CAM resolved is still a
-- row, so it is left alone. The test beside this file drives the real
-- persist_auto_daily_import twice on one date to prove both halves.
--
-- ===========================================================================
-- HAZARDS KNOWN AND HOW THEY ARE HANDLED.
--
-- * Both ingest paths rewrite trading_accounts.status and date_failed from the
--   payload before writing snapshots. The automatic path's payload carries the
--   status read fresh from the database at ingest, so it PRESERVES a Failed
--   this file set. The manual browser path writes the browser's in memory
--   registry (loaded at login), so a stale tab re-uploading a close can flip a
--   database set Failed back to Active and null its date_failed. That is
--   accepted here, not guarded: AccountManager.jsx has a date input for
--   date_failed, so a trigger refusing to clear it would make a typo permanent,
--   and a human reviving an account (status Active again because the prop firm
--   says otherwise) must stay possible. What happens instead: the observation
--   stays 'breached', the auto fail does not fire again (it fires on the
--   transition into breached only), and src/domain/accountBuckets.js files an
--   Active account with observed_state 'breached' under "looks failed" so a CAM
--   sees it on the next look. A human revive is honoured for the same reason.
--
-- * Snapshot rows carry trading_account_id resolved by lowercase name within
--   the client at insert time; 41 rows on the book are null (orphans). The
--   refresh matches by trading_account_id first and by account name second,
--   case and whitespace insensitive (lower(btrim()), the browser's nameKey),
--   so an orphan that names a registry account still counts as seen.
--
-- * The observation columns are protected from the browser by a BEFORE
--   trigger, not by column privileges: a column level REVOKE cannot narrow a
--   table level UPDATE grant, so protecting seven columns that way would mean
--   revoking UPDATE on the table and granting it back column by column, a list
--   that goes stale with every column anybody adds (step 56's own argument).
--   The trigger refuses when current_user is anon or authenticated; the refresh
--   (security definer, owned by postgres), the ingest RPCs (same) and the
--   service role pass. Step 52's "cam sees its own clients" policy still
--   decides which ROWS a CAM reads and updates.
--
-- IDEMPOTENT. `add column if not exists`, constraints dropped and recreated
-- under their own names, `create or replace` for the functions, `drop trigger
-- if exists` then `create`, policies created only when absent, the settings
-- row inserted `on conflict do nothing`, and a backfill whose only side effect
-- beyond rewriting the derived columns (same values the second time) is the
-- auto fail, which fires on the transition into breached only, so a second run
-- marks nothing and writes no second flag or audit row.
--
-- GRANTS (step 56's rule: every new table, column and function restates its
-- own). trading_accounts keeps select, insert, update, delete for authenticated
-- and nothing for anon; the new columns inherit that and the guard trigger
-- narrows the writes. account_observation_settings: select for authenticated,
-- nothing for anon, no browser write through two restrictive policies.
-- refresh_account_observations: execute for service_role, nothing for public,
-- anon or authenticated (the triggers reach it as postgres). The helpers and
-- trigger functions: nothing for anybody but the owner. Step 56's exception
-- table gains a row for the settings table so a re-run of 56 does not widen it
-- to four verbs.
--
-- CHECK AFTERWARDS (read only). The NOTICE at the end says how many accounts
-- and clients were refreshed; on production the second query should be near
-- 281 and the third near 760:
--
--   select observed_state, count(*) from public.trading_accounts group by 1;
--   select count(*) from public.audit_logs where action = 'trading_account.auto_failed';
--   select count(*) from public.trading_accounts where observed_state = 'absent';

begin;

do $step65_guard$
begin
  -- Step 52's helpers decide which rows a CAM reads; the policies below and
  -- the tests beside this file assume them. Said out loud rather than failing
  -- on a policy that quietly admits nobody.
  if to_regprocedure('public.is_manager()') is null
    or to_regprocedure('public.assigned_client_ids()') is null then
    raise exception 'step 65 needs step 52 (is_manager, assigned_client_ids): run it first';
  end if;
end
$step65_guard$;

-- ---------------------------------------------------------------------------
-- 1. The observation, on the registry row.
-- ---------------------------------------------------------------------------
alter table public.trading_accounts
  add column if not exists observed_state text not null default 'never_seen',
  add column if not exists last_close_seen_on date,
  add column if not exists closes_missed integer not null default 0,
  add column if not exists breached_on date,
  add column if not exists breach_reading numeric,
  add column if not exists observed_at timestamptz,
  add column if not exists auto_fail_flag_id uuid;

alter table public.trading_accounts
  drop constraint if exists trading_accounts_observed_state_check;
alter table public.trading_accounts
  add constraint trading_accounts_observed_state_check
  check (observed_state in ('seen', 'breached', 'absent', 'never_seen'));

alter table public.trading_accounts
  drop constraint if exists trading_accounts_closes_missed_check;
alter table public.trading_accounts
  add constraint trading_accounts_closes_missed_check
  check (closes_missed >= 0);

comment on column public.trading_accounts.observed_state is
  'What the closes say about this account (step 65): seen (in the latest close), breached (latest measured trailing reading is a breach), absent (missing from at least stale_closes closes), never_seen (in no close of this client). Written by refresh_account_observations, never by the browser.';
comment on column public.trading_accounts.last_close_seen_on is
  'Trading date of the latest close of this client that carried a snapshot of this account. NULL when never seen. Step 65.';
comment on column public.trading_accounts.closes_missed is
  'How many of the client''s closes came after last_close_seen_on: 0 when seen in the latest close, the client''s close count when never seen. Counted in closes, not days, to match the browser''s staleCloses. Step 65.';
comment on column public.trading_accounts.breached_on is
  'Trading date of the first close of the current run of breached trailing readings, or NULL when the latest measured reading is not a breach (a later healthy reading clears it). Step 65.';
comment on column public.trading_accounts.breach_reading is
  'The trailing_max_drawdown read on the breached_on close: cumulative loss under model 1 (max_drawdown_limit > 0), remaining buffer under model 2. NULL when breached_on is NULL. Step 65.';
comment on column public.trading_accounts.observed_at is
  'When refresh_account_observations last wrote the observation columns of this row. NULL until the first close of the client lands or the step 65 backfill runs. Step 65.';
comment on column public.trading_accounts.auto_fail_flag_id is
  'The operational_flags row the close wrote when it marked this account Failed (its own flag, or the one flag naming several accounts). NULL means the close never failed this account. Deliberately not a foreign key: a re-import of a close deletes every flag of that close, and the dangling id is how the next refresh knows to write the flag again. Step 65.';

-- ---------------------------------------------------------------------------
-- 2. The tunables, a singleton in the shape of account_tracker_settings.
-- ---------------------------------------------------------------------------
create table if not exists public.account_observation_settings (
  id boolean primary key default true,
  -- HOW MANY OF THE CLIENT'S CLOSES AN ACCOUNT MAY MISS before it is called
  -- absent. 5, the browser's staleCloses: sweeping the real book, "absent for at
  -- least N closes" gives 220 accounts at N=1, 148 at 5, 17 at 8, and six
  -- accounts skipped a close and came back, so no value makes absence a death.
  stale_closes integer not null default 5,
  -- WHETHER A BREACH OBSERVED ON A CLOSE MARKS THE ACCOUNT FAILED by itself.
  -- Off, the observation is still written (observed_state 'breached') and the
  -- status is left alone; src/domain/accountBuckets.js then files such an
  -- account under "looks failed".
  auto_fail_on_breach boolean not null default true,
  -- HOW MANY DAYS AFTER date_added an account that has never appeared in a
  -- close is still "new" rather than "registered and never seen". Read by the
  -- browser only; nothing in this file branches on it.
  new_account_days integer not null default 14,
  updated_at timestamptz not null default now(),
  constraint account_observation_settings_singleton check (id),
  constraint account_observation_settings_stale_check
    check (stale_closes between 1 and 30),
  constraint account_observation_settings_new_days_check
    check (new_account_days between 0 and 90)
);

insert into public.account_observation_settings (id) values (true)
on conflict (id) do nothing;

comment on table public.account_observation_settings is
  'Singleton tunables for the account observations (step 65). Edit in the SQL editor, for example: update public.account_observation_settings set auto_fail_on_breach = false, updated_at = now() where id; The CHECK constraints are the review. stale_closes is counted in closes of the client, not days.';

-- ---------------------------------------------------------------------------
-- 3a. The reading and the breach, as two pure functions, so the rule above is
--     one expression the tests can probe at its edges and the refresh reuses.
-- ---------------------------------------------------------------------------
create or replace function public.account_observation_reading(p_trailing numeric)
returns numeric
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select case
    when p_trailing is null then null
    when p_trailing = 0 then null
    when p_trailing::text in ('NaN', 'Infinity', '-Infinity') then null
    else p_trailing
  end;
$function$;

comment on function public.account_observation_reading(numeric) is
  'The trailing drawdown of one snapshot as a measurement, or NULL when it is not one: NULL, exactly 0, NaN and infinity mean the grid reported no drawdown, never a buffer of zero. Mirrors readingOf in src/domain/accountLifecycle.js. Step 65.';

create or replace function public.account_observation_breach(
  p_trailing numeric,
  p_account_type text,
  p_max_drawdown_limit numeric
)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select case
    when public.account_observation_reading(p_trailing) is null then null
    when p_account_type in ('Cash', 'Cash - IRA', 'Cash - Straight') then null
    when btrim(coalesce(p_account_type, '')) = 'Simulation' then null
    when p_max_drawdown_limit is not null and p_max_drawdown_limit > 0
      then abs(public.account_observation_reading(p_trailing)) >= p_max_drawdown_limit
    else public.account_observation_reading(p_trailing) < 0
  end;
$function$;

comment on function public.account_observation_breach(numeric, text, numeric) is
  'Whether one trailing reading is a breach under the account''s model: NULL when not measured or when the account is cash or simulation (they cannot breach), model 1 (limit > 0) abs(reading) >= limit, model 2 reading < 0. Mirrors breachOf in src/domain/accountLifecycle.js. Step 65.';

-- Nobody calls these but the refresh, which is security definer, so not even
-- the service role needs them (step 50 did the same for persist_auto_daily_import).
revoke all on function public.account_observation_reading(numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.account_observation_breach(numeric, text, numeric)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. The refresh: one client, every account, every close.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_account_observations(p_client_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_settings public.account_observation_settings;
  v_stale integer;
  v_auto_fail boolean;
  v_total integer;
  v_latest_close uuid;
  v_now timestamptz := now();
  v_touched integer := 0;
  v_new_state text;
  v_money text;
  v_limit text;
  -- The accounts this call marked Failed, kept for the flag decision after the
  -- loop: up to three get a flag each, more get one flag naming them all.
  v_failed_ids uuid[] := '{}';
  v_failed_names text[] := '{}';
  v_failed_dates date[] := '{}';
  v_failed_readings numeric[] := '{}';
  v_failed_previous text[] := '{}';
  v_failed_limits numeric[] := '{}';
  v_failed_closes uuid[] := '{}';
  v_flag_id uuid;
  v_count integer;
  i integer;
  r record;
begin
  if p_client_id is null then
    return 0;
  end if;

  select settings.* into v_settings
  from public.account_observation_settings as settings
  where settings.id;
  -- The seed is in this file, so a missing row means somebody deleted it. The
  -- column defaults stand in rather than the refresh refusing a close.
  v_stale := coalesce(v_settings.stale_closes, 5);
  v_auto_fail := coalesce(v_settings.auto_fail_on_breach, true);

  select count(*)::integer into v_total
  from public.daily_imports as d
  where d.client_id = p_client_id;

  select d.id into v_latest_close
  from public.daily_imports as d
  where d.client_id = p_client_id
  order by d.trading_date desc, d.id desc
  limit 1;

  for r in
    with closes as (
      -- The client's closes in order. idx is 1 based, so "closes after the
      -- last one seen" is total minus idx.
      select d.id, d.trading_date,
             row_number() over (order by d.trading_date, d.id)::integer as idx
      from public.daily_imports as d
      where d.client_id = p_client_id
    ),
    accounts as (
      select t.id, t.account_name, lower(btrim(t.account_name)) as name_key,
             t.account_type, t.max_drawdown_limit, t.status, t.date_failed,
             t.observed_state as old_state
      from public.trading_accounts as t
      where t.client_id = p_client_id
    ),
    matched as (
      -- Every snapshot of this client's closes, attributed to one of this
      -- client's accounts: by trading_account_id when it points at one of
      -- them, otherwise by name, case and whitespace insensitive. A snapshot
      -- that matches neither is an orphan and counts for nobody.
      select c.idx, c.id as close_id, c.trading_date, s.id as snapshot_id,
             coalesce(
               (select a.id from accounts as a where a.id = s.trading_account_id),
               (select a.id from accounts as a
                 where a.name_key = lower(btrim(s.account_name))
                 order by a.account_name, a.id
                 limit 1)
             ) as account_id,
             s.trailing_max_drawdown as raw
      from closes as c
      join public.account_snapshots as s on s.daily_import_id = c.id
    ),
    judged as (
      select m.account_id, m.idx, m.close_id, m.trading_date, m.snapshot_id,
             public.account_observation_reading(m.raw) as reading,
             public.account_observation_breach(m.raw, a.account_type, a.max_drawdown_limit) as breached
      from matched as m
      join accounts as a on a.id = m.account_id
    ),
    seen as (
      select j.account_id, max(j.idx) as last_idx
      from judged as j
      group by j.account_id
    ),
    last_measured as (
      -- The latest close with a measurement decides; unmeasured closes after
      -- it change nothing.
      select distinct on (j.account_id) j.account_id, j.breached
      from judged as j
      where j.reading is not null
      order by j.account_id, j.idx desc, j.snapshot_id desc
    ),
    last_clear as (
      select j.account_id, max(j.idx) as clear_idx
      from judged as j
      where j.breached = false
      group by j.account_id
    ),
    run_start as (
      -- The first breached close after the last non breached one: where the
      -- current run of breaches began.
      select distinct on (j.account_id) j.account_id, j.trading_date, j.close_id, j.reading
      from judged as j
      left join last_clear as lc on lc.account_id = j.account_id
      where j.breached = true
        and (lc.clear_idx is null or j.idx > lc.clear_idx)
      order by j.account_id, j.idx asc, j.snapshot_id asc
    )
    select a.id, a.account_name, a.status, a.date_failed, a.old_state, a.max_drawdown_limit,
           (select c.trading_date from closes as c where c.idx = s.last_idx) as last_seen_on,
           case when s.last_idx is null then v_total else v_total - s.last_idx end as closes_missed,
           case when lm.breached then rs.trading_date end as breached_on,
           case when lm.breached then rs.reading end as breach_reading,
           case when lm.breached then rs.close_id end as breached_close_id
    from accounts as a
    left join seen as s on s.account_id = a.id
    left join last_measured as lm on lm.account_id = a.id
    left join run_start as rs on rs.account_id = a.id
    order by a.account_name, a.id
  loop
    v_new_state := case
      when r.breached_on is not null then 'breached'
      when r.last_seen_on is not null and r.closes_missed >= v_stale then 'absent'
      when r.last_seen_on is not null then 'seen'
      else 'never_seen'
    end;

    update public.trading_accounts
       set observed_state = v_new_state,
           last_close_seen_on = r.last_seen_on,
           closes_missed = r.closes_missed,
           breached_on = r.breached_on,
           breach_reading = r.breach_reading,
           observed_at = v_now
     where id = r.id;
    v_touched := v_touched + 1;

    -- THE AUTO FAIL. On the transition into breached only, and only for an
    -- account the desk still expects to trade. Reserve, Inactive and Failed
    -- rows are left exactly as they are; a cleared breach never moves a status
    -- back; a date already on the row is never overwritten.
    if v_auto_fail
      and v_new_state = 'breached'
      and r.old_state is distinct from 'breached'
      and r.status in ('Active', 'Payout Hold') then
      update public.trading_accounts
         set status = 'Failed',
             date_failed = coalesce(date_failed, r.breached_on),
             updated_at = v_now
       where id = r.id;

      insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
      values (
        null,
        'trading_account',
        r.id,
        'trading_account.auto_failed',
        jsonb_build_object(
          'clientId', p_client_id,
          'accountName', r.account_name,
          'breachedOn', r.breached_on,
          'reading', r.breach_reading,
          'previousStatus', r.status
        )
      );

      v_failed_ids := array_append(v_failed_ids, r.id);
      v_failed_names := array_append(v_failed_names, r.account_name);
      v_failed_dates := array_append(v_failed_dates, r.breached_on);
      v_failed_readings := array_append(v_failed_readings, r.breach_reading);
      v_failed_previous := array_append(v_failed_previous, r.status);
      v_failed_limits := array_append(v_failed_limits, r.max_drawdown_limit);
      v_failed_closes := array_append(v_failed_closes, r.breached_close_id);
    end if;
  end loop;

  -- THE FLAG THE CLOSE DELETED. Both ingest paths delete every flag of a close
  -- before writing that close's flags again, so a second capture of the same
  -- day (the intraday read, then the 16:30 close) takes the flag this file wrote
  -- with it, and the auto fail does not fire twice to put it back. An account
  -- this file marked Failed remembers its flag's id; when that id points at no
  -- row any more and the account is still Failed and still breached, the flag
  -- is written again. A flag a CAM resolved is still a row, so it is not.
  for r in
    select t.id, t.account_name, t.breached_on, t.breach_reading, t.max_drawdown_limit,
           (select d.id from public.daily_imports as d
             where d.client_id = p_client_id and d.trading_date = t.breached_on
             order by d.id limit 1) as breached_close_id,
           coalesce(
             (select a.after_data ->> 'previousStatus' from public.audit_logs as a
               where a.entity_type = 'trading_account' and a.entity_id = t.id
                 and a.action = 'trading_account.auto_failed'
               order by a.created_at desc limit 1),
             'Active') as previous_status
    from public.trading_accounts as t
    where t.client_id = p_client_id
      and t.observed_state = 'breached'
      and t.status = 'Failed'
      and t.auto_fail_flag_id is not null
      and not exists (select 1 from public.operational_flags as f where f.id = t.auto_fail_flag_id)
      and not (t.id = any (v_failed_ids))
    order by t.account_name, t.id
  loop
    v_failed_ids := array_append(v_failed_ids, r.id);
    v_failed_names := array_append(v_failed_names, r.account_name);
    v_failed_dates := array_append(v_failed_dates, r.breached_on);
    v_failed_readings := array_append(v_failed_readings, r.breach_reading);
    v_failed_previous := array_append(v_failed_previous, r.previous_status);
    v_failed_limits := array_append(v_failed_limits, r.max_drawdown_limit);
    v_failed_closes := array_append(v_failed_closes, r.breached_close_id);
  end loop;

  -- THE FLAG FOR THE CAM. One or two breaches landing with a close are the day
  -- to day case and get a flag each, on the close that breached, so the queue
  -- shows them under that date. More than three in one refresh (the backfill
  -- flips about 281 across the book) get ONE flag per client naming them all,
  -- on the latest close, instead of a flood; the audit rows stay one per
  -- account either way. Each account keeps the id of the flag that names it.
  v_count := coalesce(array_length(v_failed_ids, 1), 0);
  if v_count between 1 and 3 then
    for i in 1 .. v_count loop
      v_money := case when v_failed_readings[i] < 0 then '-' else '' end
        || '$' || rtrim(rtrim(to_char(abs(round(v_failed_readings[i], 2)), 'FM999,999,999,999,990.00'), '0'), '.');
      v_limit := case
        when v_failed_limits[i] is not null and v_failed_limits[i] > 0 then
          ' against a $' || rtrim(rtrim(to_char(round(v_failed_limits[i], 2), 'FM999,999,999,999,990.00'), '0'), '.') || ' limit'
        else ''
      end;
      insert into public.operational_flags (
        daily_import_id, client_id, trading_account_id, type, severity, message, status
      ) values (
        v_failed_closes[i],
        p_client_id,
        v_failed_ids[i],
        'Marked Failed by the close',
        'Warning',
        format('%s breached on %s: trailing reading %s%s, status was %s. Change the status on the account if the prop firm says otherwise.',
               v_failed_names[i], v_failed_dates[i], v_money, v_limit, v_failed_previous[i]),
        'Open'
      )
      returning id into v_flag_id;
      update public.trading_accounts set auto_fail_flag_id = v_flag_id where id = v_failed_ids[i];
    end loop;
  elsif v_count > 3 then
    insert into public.operational_flags (
      daily_import_id, client_id, trading_account_id, type, severity, message, status
    ) values (
      v_latest_close,
      p_client_id,
      null,
      'Marked Failed by the close',
      'Warning',
      format('The close marked %s accounts Failed: %s. They breached %s. Change the status on an account if the prop firm says otherwise.',
             v_count,
             array_to_string(v_failed_names, ', '),
             case
               when (select min(d) from unnest(v_failed_dates) as d) = (select max(d) from unnest(v_failed_dates) as d)
                 then 'on ' || (select min(d) from unnest(v_failed_dates) as d)::text
               else 'between ' || (select min(d) from unnest(v_failed_dates) as d)::text
                 || ' and ' || (select max(d) from unnest(v_failed_dates) as d)::text
             end),
      'Open'
    )
    returning id into v_flag_id;
    update public.trading_accounts set auto_fail_flag_id = v_flag_id where id = any (v_failed_ids);
  end if;

  return v_touched;
end;
$function$;

comment on function public.refresh_account_observations(uuid) is
  'Recomputes observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading and observed_at for every trading account of one client from every close of that client, and marks an account Failed (with date_failed, an audit row and a flag) when its state becomes breached while Active or Payout Hold and auto_fail_on_breach is on. Returns the number of account rows written. Called by the step 65 triggers and the backfill; callable by the service role. Step 65.';

revoke all on function public.refresh_account_observations(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_account_observations(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3c. The trigger that queues the refresh: once per client per transaction.
-- ---------------------------------------------------------------------------
create or replace function public.account_observations_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_clients uuid[] := '{}';
  v_client uuid;
  v_xid text := pg_current_xact_id()::text;
  v_marker text;
  v_done text;
begin
  if tg_table_name = 'trading_accounts' then
    -- A new registry row, so it does not sit at the column defaults (never
    -- seen, 0 missed) until the next close while its client already has nine.
    v_clients := array_append(v_clients, new.client_id);
  elsif tg_table_name = 'daily_imports' then
    if tg_op in ('INSERT', 'UPDATE') then
      v_clients := array_append(v_clients, new.client_id);
    end if;
    if tg_op = 'DELETE' then
      v_clients := array_append(v_clients, old.client_id);
    elsif tg_op = 'UPDATE' then
      if old.client_id is distinct from new.client_id then
        v_clients := array_append(v_clients, old.client_id);
      end if;
    end if;
  else
    if tg_op in ('INSERT', 'UPDATE') then
      select d.client_id into v_client from public.daily_imports as d where d.id = new.daily_import_id;
      v_clients := array_append(v_clients, v_client);
    end if;
    if tg_op = 'DELETE' then
      -- A cascaded delete has already removed the close by the time this fires
      -- at commit; the daily_imports trigger covers that case and this finds
      -- nothing, which is right.
      select d.client_id into v_client from public.daily_imports as d where d.id = old.daily_import_id;
      v_clients := array_append(v_clients, v_client);
    elsif tg_op = 'UPDATE' then
      if old.daily_import_id is distinct from new.daily_import_id then
        select d.client_id into v_client from public.daily_imports as d where d.id = old.daily_import_id;
        v_clients := array_append(v_clients, v_client);
      end if;
    end if;
  end if;

  -- Deferred to commit, so every firing of this transaction runs here one
  -- after another, and the first for a client does the work. The marker is
  -- transaction local AND carries the transaction id, so a value a pooled
  -- session kept from an earlier transaction can never skip a refresh.
  v_marker := coalesce(current_setting('account_observations.refreshed', true), '');
  v_done := case when split_part(v_marker, '|', 1) = v_xid then split_part(v_marker, '|', 2) else '' end;
  foreach v_client in array v_clients loop
    if v_client is null then
      continue;
    end if;
    if position(',' || v_client::text || ',' in ',' || v_done || ',') > 0 then
      continue;
    end if;
    perform public.refresh_account_observations(v_client);
    v_done := case when v_done = '' then v_client::text else v_done || ',' || v_client::text end;
    perform set_config('account_observations.refreshed', v_xid || '|' || v_done, true);
  end loop;
  return null;
end;
$function$;

revoke all on function public.account_observations_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists account_observations_on_snapshot on public.account_snapshots;
create constraint trigger account_observations_on_snapshot
  after insert or update or delete on public.account_snapshots
  deferrable initially deferred
  for each row execute function public.account_observations_trigger();

drop trigger if exists account_observations_on_close on public.daily_imports;
create constraint trigger account_observations_on_close
  after insert or delete or update of trading_date, client_id on public.daily_imports
  deferrable initially deferred
  for each row execute function public.account_observations_trigger();

-- INSERT only. The refresh itself updates trading_accounts, and an UPDATE
-- event here would queue a refresh from inside a refresh.
drop trigger if exists account_observations_on_account on public.trading_accounts;
create constraint trigger account_observations_on_account
  after insert on public.trading_accounts
  deferrable initially deferred
  for each row execute function public.account_observations_trigger();

-- ---------------------------------------------------------------------------
-- 3d. The guard: the seven columns are the close's, not the browser's.
--
-- Security INVOKER on purpose, so current_user is the role that issued the
-- write: 'authenticated' or 'anon' for the browser (PostgREST sets it with
-- SET ROLE), postgres for the refresh and the ingest RPCs (security definer,
-- owned by postgres), service_role for the API routes.
-- ---------------------------------------------------------------------------
create or replace function public.trading_accounts_observed_columns_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.observed_state is distinct from 'never_seen'
      or new.last_close_seen_on is not null
      or new.closes_missed is distinct from 0
      or new.breached_on is not null
      or new.breach_reading is not null
      or new.observed_at is not null
      or new.auto_fail_flag_id is not null then
      raise exception using
        errcode = '42501',
        message = 'observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading, observed_at and auto_fail_flag_id are written by the close (refresh_account_observations), not by the browser.';
    end if;
  elsif new.observed_state is distinct from old.observed_state
    or new.last_close_seen_on is distinct from old.last_close_seen_on
    or new.closes_missed is distinct from old.closes_missed
    or new.breached_on is distinct from old.breached_on
    or new.breach_reading is distinct from old.breach_reading
    or new.observed_at is distinct from old.observed_at
    or new.auto_fail_flag_id is distinct from old.auto_fail_flag_id then
    raise exception using
      errcode = '42501',
      message = 'observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading, observed_at and auto_fail_flag_id are written by the close (refresh_account_observations), not by the browser.';
  end if;
  return new;
end;
$function$;

revoke all on function public.trading_accounts_observed_columns_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trading_accounts_observed_columns_guard on public.trading_accounts;
create trigger trading_accounts_observed_columns_guard
  before insert or update on public.trading_accounts
  for each row execute function public.trading_accounts_observed_columns_guard();

-- ---------------------------------------------------------------------------
-- 4. Grants and row level security, restated (step 56's rule).
-- ---------------------------------------------------------------------------
revoke all privileges on table public.trading_accounts from anon;
revoke all privileges on table public.trading_accounts from public;
revoke all privileges on table public.trading_accounts from authenticated;
grant select, insert, update, delete on table public.trading_accounts to authenticated;
alter table public.trading_accounts enable row level security;

alter table public.account_observation_settings enable row level security;
revoke all on public.account_observation_settings from anon, authenticated;
grant select on public.account_observation_settings to authenticated;

do $account_observation_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_observation_settings'
      and policyname = 'anyone signed in reads the account observation settings'
  ) then
    create policy "anyone signed in reads the account observation settings"
      on public.account_observation_settings
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_observation_settings'
      and policyname = 'account_observation_settings deny browser writes'
  ) then
    create policy "account_observation_settings deny browser writes"
      on public.account_observation_settings
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_observation_settings'
      and policyname = 'account_observation_settings deny browser deletes'
  ) then
    create policy "account_observation_settings deny browser deletes"
      on public.account_observation_settings
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;
end
$account_observation_policies$;

-- ---------------------------------------------------------------------------
-- 5. The backfill: every client with at least one close, once.
-- ---------------------------------------------------------------------------
do $step65_backfill$
declare
  v_client uuid;
  v_clients integer := 0;
  v_rows integer := 0;
begin
  for v_client in
    select distinct d.client_id from public.daily_imports as d order by 1
  loop
    v_rows := v_rows + public.refresh_account_observations(v_client);
    v_clients := v_clients + 1;
  end loop;
  raise notice 'step 65: refreshed % account(s) across % client(s)', v_rows, v_clients;
end
$step65_backfill$;

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 60 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 65 left % table(s) without row level security', n;
  end if;
end $$;
