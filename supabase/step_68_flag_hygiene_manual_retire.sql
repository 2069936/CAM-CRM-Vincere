-- Step 68: when a person retires an account in the CRM, its flags only a live
-- account can earn are resolved with it, and the ones already open on accounts
-- a person retired before this file are resolved once.
--
-- WHY 68. 67 is applied. 54 is still a deliberate gap. This file needs step 67
-- (live_account_flag_types, account_is_past_live_flags,
-- operational_flags.resolution_note, account_observation_settings
-- .resolve_flags_on_fail) and says so if it is missing.
--
-- THE GAP 67 LEFT, in its own header: "Accounts a person marks Failed AFTER
-- this file runs: no new flag of the five is created for them, but the ones
-- already open stay open until a CAM resolves them. Only the close's own
-- transition resolves automatically." And: "Open flags of the five on accounts
-- dead but not Failed (Inactive, Reserve, Inactive / Ignore, ...) are neither
-- backlog nor transition resolved." So a CAM who marks an account Failed,
-- Inactive or Reserve in the CRM, or sets its type to Inactive / Ignore, still
-- finds its Missing account, Strategy disabled, Expected strategy missing and
-- drawdown warnings in her queue the next morning, asking why a dead account
-- did not trade. This file closes both halves.
--
-- THE FIVE and DEAD are step 67's, read from its two functions
-- (live_account_flag_types, account_is_past_live_flags), so the trigger, the
-- backlog, the close and the generator cannot drift apart. Drawdown breached,
-- Marked Failed by the close, Unassigned account, New account and Evaluation
-- target reached are not touched by anything in this file.
--
-- ===========================================================================
-- WHAT THIS FILE ADDS.
--
--   1. account_observation_settings.retired_flag_backlog_resolved_at,
--      timestamptz, NULL until item 3 has run: its once only marker, in the
--      shape of step 67's flag_backlog_resolved_at.
--   2. THE TRANSITION, IN THE CRM: an AFTER UPDATE OF status, account_type
--      trigger on trading_accounts (trading_accounts_retire_resolves_flags).
--      When a row goes from alive to past the five BY ITS STATUS OR ITS TYPE
--      (account_is_past_live_flags on the old row and on the new one, with the
--      same observation on both sides, see below) and resolve_flags_on_fail is
--      on, the account's Open flags of the five are set Resolved,
--      resolved_at = now(), resolved_by_user_id = the app user signed in
--      (auth.uid(), NULL when nobody is, as in the SQL editor), and
--      resolution_note 'Account marked Failed in the CRM.' (or Inactive, or
--      Reserve), or 'Account set to Inactive or Ignore in the CRM.' when the
--      type did it. ONE audit row per account, only when something was
--      resolved (trading_account.flags_resolved_on_retire: count, types, flag
--      ids, previous and new status and type, the note), written as the same
--      person. The switch is step 67's: the same column turns off the close's
--      resolve and this one.
--   3. THE BACKLOG, ONCE: every Open flag of the five whose account's status
--      is Inactive or Reserve, or whose type is Inactive / Ignore, when this
--      file runs, is set Resolved with resolution_note 'Account already
--      Inactive or Reserve when step 68 ran.' and no person. One NOTICE says
--      how many per type, one audit row summarises it (entity_type
--      operational_flags, action flags.backlog_resolved_on_retired_accounts).
--      Failed accounts are step 67's backlog, and an account the closes only
--      call absent is left alone: absence is not death (step 65). It runs
--      regardless of the switch, and only once: an advisory lock serialises
--      two runs and the marker (item 1) makes the second resolve nothing.
--
-- THE OBSERVATION IN THE TRANSITION. The rule compares old and new with ONE
-- observation, the old row's, so only the status or the type can flip the
-- verdict (the browser cannot write observed_state; step 65's guard refuses
-- it). Two words matter:
--   * 'breached' counts, as it does everywhere. That is what keeps this
--     trigger out of the close's own transition: step 65's refresh writes
--     observed_state = 'breached' in one statement and status = 'Failed' in
--     the next, so when this trigger sees the status change the account is
--     already past the five by its observation, and step 67's resolve, with
--     its own note and its own audit row, is the only one.
--   * 'absent' does NOT count here. Absence is an observation and never a
--     death; an account the closes call absent is still the desk's until a
--     person says otherwise, and the person saying so is exactly this
--     transition. Step 65 measured 566 Active accounts whose last close was
--     more than 30 days old; retiring those is the cleanup this trigger
--     exists for, and reading 'absent' as already dead would skip them all.
--
-- ===========================================================================
-- HAZARDS KNOWN AND HOW THEY ARE HANDLED.
--
-- * A fault in the resolve never refuses the save. The resolve and its audit
--   row run in a block that, on any error, rolls back to its own start (both
--   halves, so no half resolve is left), raises a WARNING naming the account
--   and the fault, and lets the status change land. The CAM's status is the
--   decision; the flags are housekeeping.
-- * From one dead state to another (Failed to Inactive, Reserve to Inactive /
--   Ignore) is not a transition: a flag of the five Open on an account already
--   dead is a person's decision (she reopened it) or the switch was off, and
--   either way this trigger leaves it.
-- * A revive (dead to alive) does nothing. Flags resolved stay resolved; the
--   account earns the five again from its next close, as step 67 says.
-- * An Active account the closes call breached (the auto fail was off, or a
--   person revived it) is past the five already; a CAM marking it Failed is
--   not a transition here. Its five were not created while it read breached
--   (step 67's insert guard), so there is normally nothing open to resolve.
-- * The ingest paths upsert trading_accounts.status from their payload on
--   every close. The trigger's WHEN clause skips a row whose status and type
--   did not change, so a close costs one comparison per account. A stale tab
--   re-uploading a close with an old registry can still move a status; when
--   that is a retirement it resolves like any other, with the CAM who
--   uploaded as the person.
-- * The browser keeps the flags it loaded at login. After a CAM retires an
--   account, the tab still shows its five as Open until the next load; a CAM
--   resolving one of them there writes the same status again, which the note
--   guard of step 67 lets through without clearing the note.
--
-- UNDO, in the SQL editor, if the backlog has to be put back:
--   update public.operational_flags
--      set status = 'Open', resolved_at = null, resolved_by_user_id = null, resolution_note = null
--    where resolution_note = 'Account already Inactive or Reserve when step 68 ran.';
-- and the same with the four CRM notes for item 2. A flag a person reopened or
-- closed herself lost its note (step 67's guard), so neither reopens it.
--
-- IDEMPOTENT. `add column if not exists`, `create or replace` for the
-- function, `drop trigger if exists` then `create`, and the backlog guarded by
-- its marker under an advisory lock. A re-run restores the grants and the
-- trigger and changes no row. A re-run of 65 or 67 does not touch this
-- trigger.
--
-- GRANTS (step 56's rule: restate them). The trigger function: nothing for
-- anybody but the owner (it fires without EXECUTE). The two step 67 helpers it
-- calls are restated the same way. trading_accounts and operational_flags keep
-- select, insert, update, delete for authenticated and nothing for anon;
-- account_observation_settings keeps select for authenticated and nothing
-- else, and the new column inherits that. No new table, so step 56's exception
-- table is unchanged.
--
-- CHECK AFTERWARDS (read only):
--
--   select resolution_note, type, count(*) from public.operational_flags
--    where resolution_note is not null group by 1, 2 order by 1, 2;
--   select after_data from public.audit_logs
--    where action = 'flags.backlog_resolved_on_retired_accounts';
--   select count(*) from public.audit_logs
--    where action = 'trading_account.flags_resolved_on_retire';

do $step68_guard$
begin
  if to_regprocedure('public.live_account_flag_types()') is null
    or to_regprocedure('public.account_is_past_live_flags(text, text, text)') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'operational_flags' and column_name = 'resolution_note'
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'account_observation_settings' and column_name = 'resolve_flags_on_fail'
    ) then
    raise exception 'step 68 needs step 67 (live_account_flag_types, account_is_past_live_flags, operational_flags.resolution_note, account_observation_settings.resolve_flags_on_fail): run it first';
  end if;
end
$step68_guard$;

begin;

-- ---------------------------------------------------------------------------
-- 1. The one time backlog's marker, on step 65's singleton, which the browser
--    can read and cannot write. Not an audit row: a signed in CAM can insert
--    one of those (step 67's test proves it), and a forged row would skip the
--    backlog.
-- ---------------------------------------------------------------------------
alter table public.account_observation_settings
  add column if not exists retired_flag_backlog_resolved_at timestamptz;

comment on column public.account_observation_settings.retired_flag_backlog_resolved_at is
  'When step 68 resolved, once, the Open flags of the five live account types on accounts already Inactive, Reserve or Inactive / Ignore. NULL until it ran; set in the same transaction as the resolve, and a run that finds it set resolves nothing. Written only by the migration. Step 68.';

-- ---------------------------------------------------------------------------
-- 2. The transition in the CRM.
-- ---------------------------------------------------------------------------
create or replace function public.trading_accounts_retire_resolves_flags()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  -- One observation for both sides, the old row's, with absence read as
  -- alive: see THE OBSERVATION IN THE TRANSITION in the header.
  v_observed text := nullif(old.observed_state, 'absent');
  v_note text;
  v_person uuid;
  v_now timestamptz := now();
  v_count integer;
  v_types jsonb;
  v_ids jsonb;
begin
  if public.account_is_past_live_flags(old.status, old.account_type, v_observed)
    or not public.account_is_past_live_flags(new.status, new.account_type, v_observed) then
    return null;
  end if;

  -- The switch is step 67's. A missing settings row means somebody deleted
  -- it; the column default stands in, as it does in the refresh.
  if not coalesce(
       (select s.resolve_flags_on_fail from public.account_observation_settings as s where s.id),
       true) then
    return null;
  end if;

  -- The old row was alive by its status and its type, so a dead status on the
  -- new row is what moved it; otherwise the type did.
  v_note := case
    when new.status in ('Failed', 'Inactive', 'Reserve') then 'Account marked ' || new.status || ' in the CRM.'
    else 'Account set to Inactive or Ignore in the CRM.'
  end;

  begin
    -- The person: the app user signed in, read from the request PostgREST
    -- carries. Nobody in the SQL editor, the service role or a migration.
    select u.id into v_person
    from public.app_users as u
    where u.auth_user_id = auth.uid()
    order by u.id
    limit 1;

    with resolved as (
      update public.operational_flags as f
         set status = 'Resolved',
             resolved_at = v_now,
             resolved_by_user_id = v_person,
             resolution_note = v_note
       where f.trading_account_id = new.id
         and f.status = 'Open'
         and f.type = any (public.live_account_flag_types())
      returning f.id, f.type
    )
    select coalesce((select count(*)::integer from resolved), 0),
           coalesce((select jsonb_object_agg(per.type, per.n)
                       from (select x.type, count(*)::integer as n
                               from resolved as x group by x.type) as per), '{}'::jsonb),
           coalesce((select jsonb_agg(x.id order by x.id) from resolved as x), '[]'::jsonb)
      into v_count, v_types, v_ids;

    -- Nothing Open of the five (none ever, a CAM closed them, or the close
    -- already did): no row saying a resolve happened.
    if v_count > 0 then
      insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
      values (
        v_person,
        'trading_account',
        new.id,
        'trading_account.flags_resolved_on_retire',
        jsonb_build_object(
          'clientId', new.client_id,
          'accountName', new.account_name,
          'previousStatus', old.status,
          'newStatus', new.status,
          'previousAccountType', old.account_type,
          'accountType', new.account_type,
          'count', v_count,
          'types', v_types,
          'flagIds', v_ids,
          'note', v_note
        )
      );
    end if;
  exception when others then
    raise warning 'step 68: the flags of account % were left open after its status or type changed: % (%)',
      new.id, sqlerrm, sqlstate;
  end;

  return null;
end;
$function$;

comment on function public.trading_accounts_retire_resolves_flags() is
  'AFTER UPDATE OF status, account_type on trading_accounts: when the row goes from alive to past the five live account flags by its status or its type (account_is_past_live_flags on old and new, with the old observation on both sides and absent read as alive) and resolve_flags_on_fail is on, resolves its Open flags of the five (live_account_flag_types) as the signed in app user, with resolution_note Account marked <status> in the CRM. or Account set to Inactive or Ignore in the CRM., and writes one trading_account.flags_resolved_on_retire audit row when it resolved any. A fault is a WARNING and the save lands. Step 68.';

drop trigger if exists trading_accounts_retire_resolves_flags on public.trading_accounts;
create trigger trading_accounts_retire_resolves_flags
  after update of status, account_type on public.trading_accounts
  for each row
  when (old.status is distinct from new.status or old.account_type is distinct from new.account_type)
  execute function public.trading_accounts_retire_resolves_flags();

-- ---------------------------------------------------------------------------
-- 3. The backlog, once: Open flags of the five on accounts already Inactive,
--    Reserve or Inactive / Ignore.
-- ---------------------------------------------------------------------------
do $step68_backlog$
declare
  v_note constant text := 'Account already Inactive or Reserve when step 68 ran.';
  v_types text[] := public.live_account_flag_types();
  v_now timestamptz := now();
  v_total integer;
  v_accounts integer;
  v_counts jsonb;
begin
  -- Two runs of this file at once: the second waits here, then finds the
  -- first one's marker below and does nothing.
  perform pg_advisory_xact_lock(hashtext('step 68 flag backlog'));

  insert into public.account_observation_settings (id) values (true)
  on conflict (id) do nothing;

  if (select s.retired_flag_backlog_resolved_at from public.account_observation_settings as s where s.id) is not null then
    raise notice 'step 68: the flags on Inactive and Reserve accounts were already resolved by an earlier run, so nothing was resolved this time';
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
       and (t.status in ('Inactive', 'Reserve') or t.account_type = 'Inactive / Ignore')
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

  raise notice 'step 68: resolved % open flag(s) on % Inactive, Reserve or Inactive / Ignore account(s): Missing account %, Strategy disabled %, Expected strategy missing %, Drawdown approaching limit %, Drawdown near limit %',
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
    'flags.backlog_resolved_on_retired_accounts',
    jsonb_build_object(
      'total', v_total,
      'accounts', v_accounts,
      'types', v_counts,
      'note', v_note,
      'resolvedAt', v_now,
      'rule', 'Open flags of the five live account types on accounts whose status was Inactive or Reserve, or whose type was Inactive / Ignore, when step 68 ran.'
    )
  );

  update public.account_observation_settings
     set retired_flag_backlog_resolved_at = v_now,
         updated_at = v_now
   where id;
end
$step68_backlog$;

-- ---------------------------------------------------------------------------
-- 4. Grants and row level security, restated (step 56's rule).
-- ---------------------------------------------------------------------------
-- A trigger function fires without EXECUTE, and the helpers are reached from
-- security definer code, so nobody but the owner holds any of the three.
revoke all on function public.trading_accounts_retire_resolves_flags()
  from public, anon, authenticated, service_role;
revoke all on function public.live_account_flag_types()
  from public, anon, authenticated, service_role;
revoke all on function public.account_is_past_live_flags(text, text, text)
  from public, anon, authenticated, service_role;

revoke all privileges on table public.trading_accounts from anon;
revoke all privileges on table public.trading_accounts from public;
revoke all privileges on table public.trading_accounts from authenticated;
grant select, insert, update, delete on table public.trading_accounts to authenticated;
alter table public.trading_accounts enable row level security;

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
-- steps 43 to 67 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 68 left % table(s) without row level security', n;
  end if;
end $$;
