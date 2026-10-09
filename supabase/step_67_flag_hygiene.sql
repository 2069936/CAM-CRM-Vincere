-- Step 67: a dead account stops raising the flags only a live account can earn,
-- the close resolves them when it marks an account Failed, and the backlog
-- already open on Failed accounts is resolved once.
--
-- WHY 67. 65 and 66 are applied. 54 is still a deliberate gap. This file needs
-- step 65 (refresh_account_observations, account_observation_settings and the
-- observation columns on trading_accounts) and says so if it is missing.
--
-- THE PROBLEM, measured on production on 2026-10-09 (read only, sizing):
-- operational_flags held 6,808 Open flags and 2,758 of them pointed at an
-- account whose status was Failed. By type, across the book: Missing account
-- 3,330, Strategy disabled 901, Expected strategy missing 557 (Critical),
-- Drawdown approaching limit 306, Drawdown near limit 85 (Critical). One close
-- alone created 160 Missing account flags and the Manager overview's open count
-- went from 32 to 270. Step 65 now marks a breached account Failed by itself,
-- which made the noise worse: the account is dead and the close keeps asking a
-- CAM why it did not trade.
--
-- THE FIVE. Missing account, Strategy disabled, Expected strategy missing,
-- Drawdown approaching limit and Drawdown near limit only mean something on an
-- account the desk still expects to trade. Drawdown breached is NOT one of
-- them: it is the evidence of the breach, and it is kept everywhere. Marked
-- Failed by the close (step 65), Unassigned account, New account and Evaluation
-- target reached are not touched by anything in this file.
--
-- DEAD, for the five: status Failed, Inactive or Reserve, or type Inactive /
-- Ignore, or observed_state breached or absent (step 65). Payout Hold is alive.
-- src/domain/reconcile.js holds the same list (LIVE_ACCOUNT_FLAG_TYPES) and
-- the same rule (accountIsPastLiveFlags); the test beside this file compares
-- them, so the two languages cannot drift.
--
-- ===========================================================================
-- WHAT THIS FILE ADDS.
--
--   1. account_observation_settings.resolve_flags_on_fail, boolean, default
--      true: the switch for item 4. To turn it off:
--        update public.account_observation_settings
--           set resolve_flags_on_fail = false, updated_at = now() where id;
--   2. operational_flags.resolution_note, text, nullable: why a flag was
--      closed when no person closed it. NULL on every row a CAM resolves.
--      Appending to message instead would change the flag's identity
--      (type|account|message is how Recalculate carries triage and how the CAM
--      queue groups a flag across days), so the note has its own column, in the
--      shape of step 38's provenance column.
--   3. THE GENERATOR, AT THE DATABASE: a BEFORE INSERT trigger on
--      operational_flags that drops an Open row of the five for a dead
--      account. The generator itself is JavaScript (reconcileDailyImport) and
--      is gated in the same PR; this is what makes the rule hold whatever the
--      caller had in memory. Two cases need it:
--        * the manual upload is separate PostgREST requests, and step 65's
--          refresh commits with the snapshot request BEFORE the flag insert
--          request, so the close that breaches an account has already marked
--          it Failed (and resolved its flags) when the browser inserts that
--          close's flags; without this, the five come back Open on it;
--        * a browser tab holding a registry loaded before an account failed
--          computes the five as if it were alive.
--      A dropped row is not an error, nothing is raised: the close lands with
--      every other flag. Only Open rows are dropped; a row inserted already
--      Resolved (Recalculate carrying a CAM's triage forward) is history and
--      goes in. Only INSERT: a person reopening a flag is a decision.
--   4. THE TRANSITION: refresh_account_observations is redefined with step
--      65's body plus this. When the close marks an account Failed (the step
--      65 auto fail, on the transition into breached only) and the switch is
--      on, its Open flags of the five are set Resolved, resolved_at = now(),
--      resolved_by_user_id NULL, resolution_note 'Account marked Failed by the
--      close.', and ONE audit row per account that had any
--      (trading_account.flags_resolved_on_fail, after_data with the count,
--      the types and the flag ids). On the automatic route the payload's
--      flags are inserted before the deferred refresh runs at commit, so the
--      five the breaching close itself raised are resolved in the same
--      transaction. No NOTICE is raised in the refresh: it runs at the commit
--      of every close (the step 66 test asserts finalize says nothing).
--   5. THE BACKLOG, ONCE: every Open flag of the five whose trading_account_id
--      points at an account whose status is Failed when this file runs is set
--      Resolved the same way, with resolution_note 'Account already Failed
--      when step 67 ran.' (not the close's note: many of these accounts were
--      failed by a person, and the two sets stay addressable apart). One
--      NOTICE says how many per type and one audit row summarises it
--      (entity_type operational_flags, action
--      flags.backlog_resolved_on_failed_accounts). It runs regardless of the
--      switch, and only once: a second run finds the audit row and resolves
--      nothing. Flags with trading_account_id NULL name no account and are
--      left alone.
--
-- ===========================================================================
-- HAZARDS KNOWN AND HOW THEY ARE HANDLED.
--
-- * A re-run of step 65 puts step 65's refresh body back and item 4 stops
--   until this file is run again. Run 67 again after any re-run of 65; the
--   backlog does not run twice, the switch keeps its value.
-- * The resolved rows carry resolved_at = the moment this ran, so the login
--   (unresolved flags plus a fortnight of recently closed ones) keeps reading
--   them for 14 days, as it reads them today while they are Open, and then
--   stops. The CAM flag queue's closing line ("N flags closed between ...")
--   counts them for 7 days. Nothing is deleted.
-- * Accounts a person marks Failed AFTER this file runs: no new flag of the
--   five is created for them (items 3 and the JavaScript gate), but the ones
--   already open stay open until a CAM resolves them. Only the close's own
--   transition resolves automatically.
-- * A Failed account a person revives (status Active again) gets the five
--   again from its next close, unless its closes still say breached or absent.
--
-- UNDO, in the SQL editor, if the backlog has to be put back:
--   update public.operational_flags
--      set status = 'Open', resolved_at = null, resolution_note = null
--    where resolution_note = 'Account already Failed when step 67 ran.';
-- and the same with 'Account marked Failed by the close.' for item 4.
--
-- IDEMPOTENT. `add column if not exists`, `create or replace` for the
-- functions, `drop trigger if exists` then `create`, and the backlog guarded by
-- its own audit row. A re-run restores the grants and the refresh body and
-- changes no row.
--
-- GRANTS (step 56's rule: restate them). refresh_account_observations:
-- execute for service_role, nothing for public, anon or authenticated, as step
-- 65 had it. The three new functions: nothing for anybody but the owner (the
-- callers are security definer). operational_flags keeps select, insert,
-- update, delete for authenticated and nothing for anon, and the new column
-- inherits that; account_observation_settings keeps select for authenticated
-- and nothing else. No new table, so step 56's exception table is unchanged.
--
-- CHECK AFTERWARDS (read only):
--
--   select resolution_note, type, count(*) from public.operational_flags
--    where resolution_note is not null group by 1, 2 order by 1, 2;
--   select after_data from public.audit_logs
--    where action = 'flags.backlog_resolved_on_failed_accounts';
--   select resolve_flags_on_fail from public.account_observation_settings;

do $step67_guard$
begin
  if to_regprocedure('public.refresh_account_observations(uuid)') is null
    or to_regclass('public.account_observation_settings') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'trading_accounts' and column_name = 'observed_state'
    ) then
    raise exception 'step 67 needs step 65 (refresh_account_observations, account_observation_settings, trading_accounts.observed_state): run it first';
  end if;
end
$step67_guard$;

begin;

-- ---------------------------------------------------------------------------
-- 1. The switch, on step 65's singleton.
-- ---------------------------------------------------------------------------
alter table public.account_observation_settings
  add column if not exists resolve_flags_on_fail boolean not null default true;

comment on column public.account_observation_settings.resolve_flags_on_fail is
  'Whether the close resolves an account''s Open Missing account, Strategy disabled, Expected strategy missing, Drawdown approaching limit and Drawdown near limit flags when it marks the account Failed (step 67). Off: the account is still marked Failed, the flags stay Open. To turn it off: update public.account_observation_settings set resolve_flags_on_fail = false, updated_at = now() where id;';

-- ---------------------------------------------------------------------------
-- 2. Why a flag was closed when no person closed it.
-- ---------------------------------------------------------------------------
alter table public.operational_flags
  add column if not exists resolution_note text;

comment on column public.operational_flags.resolution_note is
  'Why the database resolved this flag, when it was not a person: ''Account marked Failed by the close.'' (the close failed the account, step 67) or ''Account already Failed when step 67 ran.'' (the one time backlog). NULL on every flag a CAM resolves and on every open flag. Provenance only; the message is left as it was so the flag keeps its identity.';

-- ---------------------------------------------------------------------------
-- 3. The five and the rule, once each, so the trigger, the refresh, the
--    backlog and the test read the same thing.
-- ---------------------------------------------------------------------------
create or replace function public.live_account_flag_types()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select array[
    'Missing account',
    'Strategy disabled',
    'Expected strategy missing',
    'Drawdown approaching limit',
    'Drawdown near limit'
  ]::text[];
$function$;

comment on function public.live_account_flag_types() is
  'The five flag types that only mean something on an account the desk still expects to trade. Drawdown breached is deliberately not one of them. Mirrors LIVE_ACCOUNT_FLAG_TYPES in src/domain/reconcile.js. Step 67.';

create or replace function public.account_is_past_live_flags(
  p_status text,
  p_account_type text,
  p_observed_state text
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(p_status in ('Failed', 'Inactive', 'Reserve'), false)
      or coalesce(p_account_type = 'Inactive / Ignore', false)
      or coalesce(p_observed_state in ('breached', 'absent'), false);
$function$;

comment on function public.account_is_past_live_flags(text, text, text) is
  'Whether an account is past the five live account flags: status Failed, Inactive or Reserve, type Inactive / Ignore, or observed_state breached or absent. Payout Hold is alive; NULLs are no evidence. Mirrors accountIsPastLiveFlags in src/domain/reconcile.js. Step 67.';

-- ---------------------------------------------------------------------------
-- 4. The generator, at the database: an Open row of the five for a dead
--    account is not created.
-- ---------------------------------------------------------------------------
create or replace function public.operational_flags_live_account_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_status text;
  v_type text;
  v_observed text;
begin
  if new.trading_account_id is null
    or coalesce(new.status, 'Open') <> 'Open'
    or not (new.type = any (public.live_account_flag_types())) then
    return new;
  end if;

  select t.status, t.account_type, t.observed_state
    into v_status, v_type, v_observed
  from public.trading_accounts as t
  where t.id = new.trading_account_id;

  if found and public.account_is_past_live_flags(v_status, v_type, v_observed) then
    -- Not created, and not an error: the rest of the close's flags land.
    return null;
  end if;
  return new;
end;
$function$;

comment on function public.operational_flags_live_account_guard() is
  'BEFORE INSERT on operational_flags: drops an Open flag of the five live account types (live_account_flag_types) whose trading account is past them (account_is_past_live_flags). Covers the manual upload, whose flag insert lands after the refresh that failed the account, and a browser holding a stale registry. Rows inserted already closed pass. Step 67.';

drop trigger if exists operational_flags_live_account_guard on public.operational_flags;
create trigger operational_flags_live_account_guard
  before insert on public.operational_flags
  for each row execute function public.operational_flags_live_account_guard();

-- ---------------------------------------------------------------------------
-- 5. The refresh: step 65's body, plus the resolve on the transition to
--    Failed. Everything that is not marked STEP 67 below is step 65's, line
--    for line.
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
  -- STEP 67: the switch, and what one account's transition resolved.
  v_resolve_on_fail boolean;
  v_resolved_count integer;
  v_resolved_types jsonb;
  v_resolved_ids jsonb;
begin
  -- Two refreshes of one client committing in the same window would both read old_state
  -- before the row lock and both write the auto fail audit row and flag: one client at a time.
  perform pg_advisory_xact_lock(hashtext(p_client_id::text));

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
  -- STEP 67. The default stands in the same way.
  v_resolve_on_fail := coalesce(v_settings.resolve_flags_on_fail, true);

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

      -- STEP 67: THE FLAGS ONLY A LIVE ACCOUNT CAN EARN, RESOLVED WITH IT.
      -- Open rows of the five on this account, from any close, including the
      -- ones the close being committed has just inserted. Nothing else: not
      -- Drawdown breached, not Marked Failed by the close, not Unassigned
      -- account, New account or Evaluation target reached, and not a flag a
      -- CAM already closed. One audit row for the account, only when there
      -- was something to resolve.
      if v_resolve_on_fail then
        with resolved as (
          update public.operational_flags as f
             set status = 'Resolved',
                 resolved_at = v_now,
                 resolved_by_user_id = null,
                 resolution_note = 'Account marked Failed by the close.'
           where f.trading_account_id = r.id
             and f.status = 'Open'
             and f.type = any (public.live_account_flag_types())
          returning f.id, f.type
        )
        select coalesce((select count(*)::integer from resolved), 0),
               coalesce((select jsonb_object_agg(per.type, per.n)
                           from (select x.type, count(*)::integer as n
                                   from resolved as x group by x.type) as per), '{}'::jsonb),
               coalesce((select jsonb_agg(x.id order by x.id) from resolved as x), '[]'::jsonb)
          into v_resolved_count, v_resolved_types, v_resolved_ids;

        if v_resolved_count > 0 then
          insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
          values (
            null,
            'trading_account',
            r.id,
            'trading_account.flags_resolved_on_fail',
            jsonb_build_object(
              'clientId', p_client_id,
              'accountName', r.account_name,
              'count', v_resolved_count,
              'types', v_resolved_types,
              'flagIds', v_resolved_ids,
              'note', 'Account marked Failed by the close.'
            )
          );
        end if;
      end if;

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
  'Recomputes observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading and observed_at for every trading account of one client from every close of that client, and marks an account Failed (with date_failed, an audit row and a flag) when its state becomes breached while Active or Payout Hold and auto_fail_on_breach is on. Since step 67 that transition also resolves the account''s Open flags of the five live account types (live_account_flag_types) with resolution_note ''Account marked Failed by the close.'' and one audit row (trading_account.flags_resolved_on_fail), unless resolve_flags_on_fail is off. Returns the number of account rows written. Called by the step 65 triggers; callable by the service role. Steps 65 and 67.';

-- ---------------------------------------------------------------------------
-- 6. The backlog, once: Open flags of the five on accounts already Failed.
-- ---------------------------------------------------------------------------
do $step67_backlog$
declare
  v_note constant text := 'Account already Failed when step 67 ran.';
  v_types text[] := public.live_account_flag_types();
  v_now timestamptz := now();
  v_total integer;
  v_accounts integer;
  v_counts jsonb;
begin
  -- Two runs of this file at once: the second waits here, then sees the
  -- first one's audit row below and does nothing.
  perform pg_advisory_xact_lock(hashtext('step 67 flag backlog'));

  if exists (
    select 1 from public.audit_logs as a
    where a.entity_type = 'operational_flags'
      and a.action = 'flags.backlog_resolved_on_failed_accounts'
  ) then
    raise notice 'step 67: the flags on Failed accounts were already resolved by an earlier run, so nothing was resolved this time';
    return;
  end if;

  with resolved as (
    update public.operational_flags as f
       set status = 'Resolved',
           resolved_at = v_now,
           resolved_by_user_id = null,
           resolution_note = v_note
      from public.trading_accounts as t
     where t.id = f.trading_account_id
       and t.status = 'Failed'
       and f.status = 'Open'
       and f.type = any (v_types)
    returning f.type, f.trading_account_id
  ),
  per_type as (
    select k.type, count(x.type)::integer as n
    from unnest(v_types) as k(type)
    left join resolved as x on x.type = k.type
    group by k.type
  )
  select (select count(*)::integer from resolved),
         (select count(distinct x.trading_account_id)::integer from resolved as x),
         (select jsonb_object_agg(p.type, p.n) from per_type as p)
    into v_total, v_accounts, v_counts;

  raise notice 'step 67: resolved % open flag(s) on % Failed account(s): Missing account %, Strategy disabled %, Expected strategy missing %, Drawdown approaching limit %, Drawdown near limit %',
    v_total, v_accounts,
    v_counts ->> 'Missing account',
    v_counts ->> 'Strategy disabled',
    v_counts ->> 'Expected strategy missing',
    v_counts ->> 'Drawdown approaching limit',
    v_counts ->> 'Drawdown near limit';

  insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
  values (
    null,
    'operational_flags',
    null,
    'flags.backlog_resolved_on_failed_accounts',
    jsonb_build_object(
      'total', v_total,
      'accounts', v_accounts,
      'types', v_counts,
      'note', v_note,
      'resolvedAt', v_now,
      'rule', 'Open flags of the five live account types on accounts whose status was Failed when step 67 ran.'
    )
  );
end
$step67_backlog$;

-- ---------------------------------------------------------------------------
-- 7. Grants and row level security, restated (step 56's rule).
-- ---------------------------------------------------------------------------
revoke all on function public.refresh_account_observations(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_account_observations(uuid) to service_role;

-- Nobody calls these but the trigger, the refresh and the backlog, all of
-- them security definer, so not even the service role needs them (step 65 did
-- the same for its two helpers).
revoke all on function public.live_account_flag_types()
  from public, anon, authenticated, service_role;
revoke all on function public.account_is_past_live_flags(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.operational_flags_live_account_guard()
  from public, anon, authenticated, service_role;

revoke all privileges on table public.operational_flags from anon;
revoke all privileges on table public.operational_flags from public;
revoke all privileges on table public.operational_flags from authenticated;
grant select, insert, update, delete on table public.operational_flags to authenticated;
alter table public.operational_flags enable row level security;

revoke all on public.account_observation_settings from anon, authenticated;
grant select on public.account_observation_settings to authenticated;
alter table public.account_observation_settings enable row level security;

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 66 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 67 left % table(s) without row level security', n;
  end if;
end $$;
