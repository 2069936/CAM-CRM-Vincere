-- Step 71: a breach on the close is a suspicion, not a death. The close marks
-- an account Failed only when later closes confirm it, sets back the accounts
-- it failed by mistake, and tells the CAM when a Failed account still has its
-- strategies loaded in NinjaTrader.
--
-- WHY 71. 70 (agent update requests, on feat/agent-update-crm) is the step this
-- branch is based on, so this file takes the next number. 54 is still a
-- deliberate gap. This file needs step 65 (the refresh, the settings row and
-- the observation columns), step 67 (live_account_flag_types and
-- operational_flags.resolution_note, which the refresh it replaces already
-- uses), step 55 (account_live_samples) and step 47 (strategy_family_key), and
-- says which is missing before it changes anything. 68's trigger stays as it is
-- and never meets the close's own transitions (see HAZARDS).
--
-- THE PROBLEM, measured on production on 2026-10-19 (read only). Step 65 marked
-- 355 accounts Failed by itself, on the breach alone. 13 of them had non zero
-- realized P&L on later closes, some for weeks: one traded on 10 of its 20 later
-- closes, reading -1524 while it traded. None of the 13 had max_drawdown_limit
-- set, so model 2 (reading < 0 is a breach) read an ordinary distance from the
-- peak as a dead account. src/domain/report.js leaves a Failed account out of
-- its client's report from the day after it failed, so those accounts' real
-- trades vanished from their clients' reports. Separately, one account that
-- really is dead (balance frozen, zero P&L for weeks) still has its strategies
-- loaded in NinjaTrader, and nothing told the CAM to remove them.
--
-- DECISIONS ALREADY MADE by the desk owner (do not reopen): a breach observation
-- alone no longer fails anything; the failure needs confirmation from the
-- closes after the breach; an account the CRM failed and that traded afterwards
-- goes back to the status it had; an account a PERSON failed is never set back,
-- it gets a flag. The reading rule itself (account_observation_reading,
-- account_observation_breach, the run of breached readings) is step 65's and
-- does not change: src/domain/accountLifecycle.js and accountBuckets.js read
-- the same rule and the two languages still cannot disagree.
--
-- ===========================================================================
-- THE RULE, as refresh_account_observations now applies it, once per client
-- whenever a close lands (and once per client at the end of this file).
--
--   1. THE OBSERVATION is step 65's, written exactly as before: observed_state,
--      last_close_seen_on, closes_missed, breached_on, breach_reading.
--
--   2. BREACH SUSPECTED. When an account BECOMES breached in a refresh (its
--      stored state was not 'breached' before it) and its status is Active or
--      Payout Hold, the close writes ONE flag, type 'Breach suspected'
--      (Warning), on the close that breached, saying the reading and that the
--      account is marked Failed only if it stops trading while its algorithm
--      keeps trading elsewhere, or disappears from the closes. If the same
--      refresh already confirms the failure (3), the suspicion is not written:
--      the failure flag says it all. The flag's id is kept on the row
--      (breach_flag_id), so a re-import that deletes it (both ingest paths
--      delete every flag of a close before writing it again, and a day is
--      captured twice) gets it written again while the account is still Active
--      or Payout Hold and still breached: step 65's auto_fail_flag_id
--      convention. A flag a CAM resolved is a row and is left alone.
--
--   3. CONFIRMED FAILURE, only when auto_fail_on_breach is true. An Active or
--      Payout Hold account whose latest measured reading is a breach (observed
--      'breached', so breached_on is the first close of the current run) is
--      marked Failed when the client's last confirm_closes closes ON OR AFTER
--      breached_on (the most recent closes of the client, consecutive; fewer
--      than confirm_closes such closes confirms nothing) say one of:
--        a. ABSENT: the account is in none of them. A close that lists no
--           account at all is not counted as an absence (see INTERPRETATIONS).
--        b. PEERS TRADED: on every one of them the account is present and did
--           not trade (gross_realized_pnl 0 or null on its snapshot) AND on
--           that same trading_date at least confirm_peer_accounts distinct
--           accounts of OTHER clients traded (gross_realized_pnl <> 0) while
--           carrying a strategy_snapshot of a strategy family this account
--           carries on that close. An account with no strategy row on a close
--           cannot meet b on that close.
--      Then: status Failed, date_failed = coalesce(date_failed, breached_on)
--      as step 65 did, the automation's marker on the row (auto_failed_at,
--      auto_failed_prior_status, auto_failed_date_set, auto_failed_through),
--      an audit row 'trading_account.auto_failed' whose after_data names the
--      condition (confirmedBy 'absent' or 'peers_traded'), the dates, the
--      families and the peer counts, a flag 'Marked Failed by the close'
--      naming that evidence (step 65's type, flood rule and auto_fail_flag_id),
--      step 67's resolve of the five live account flags, and the account's
--      open 'Breach suspected' flag resolved. The confirmation fires once per
--      run of breached readings: an account the close already failed in this
--      run and that a person (or a stale tab) set back is left as the person
--      left it, as step 65 honoured a human revive. Only the close's own
--      reactivation (4) lets the same run confirm again.
--
--   4. REACTIVATION, only when auto_reactivate is true. A Failed account that
--      the close failed (auto_failed_at not null) and that no person has
--      changed since (status still Failed, no later human audit row changing
--      its status, see below) and that has a close after the failure with
--      gross_realized_pnl <> 0 goes back to auto_failed_prior_status;
--      date_failed is set back to NULL only if the automation wrote it
--      (auto_failed_date_set, and the date still the one it wrote); the marker
--      is cleared; an audit row 'trading_account.auto_reactivated' says which
--      close proved the account alive; its open 'Marked Failed by the close'
--      flag is resolved; and a flag 'Reactivated by the close' (Warning) says
--      "<alias> was marked Failed by the CRM on <date> but traded on <date>. It
--      is <status> again." and then either "Its drawdown limit is not set, so
--      check it." or "Its drawdown limit is set to $N, so check it.".
--      A Failed account the close did NOT fail (a person did, or the marker is
--      gone because a person changed the status) that trades after its
--      date_failed is never set back: it gets ONE flag 'Failed account traded'
--      (Warning), "<alias> is marked Failed but traded on <date>. Check it.",
--      and nothing else changes. With auto_reactivate off, an account the close
--      failed gets that same flag instead of being set back.
--
--   5. STRATEGIES STILL LOADED. A Failed account (any origin) with a
--      date_failed, whose latest account_live_samples row (same client,
--      account_name case insensitive, newest sampled_at on any machine) shows
--      enabled_strategy_count > 0 or run_state 'running', and that has had no
--      close with gross_realized_pnl <> 0 after date_failed, gets ONE open flag
--      'Strategies still loaded' (Warning) on the client's latest close:
--      "<alias> failed on <date> and has had no trades since, but its
--      strategies are still loaded in NinjaTrader. Remove them." The database
--      resolves it, with a resolution_note saying why, as soon as the condition
--      stops holding: the latest sample shows no enabled strategy (or there is
--      no sample any more), the account is no longer Failed, or it traded.
--      Evaluated by failed_account_strategies_check(client, account), which
--      the refresh calls for the whole client at every close AND a new AFTER
--      INSERT OR UPDATE trigger on account_live_samples calls for the one
--      account a sample names, so the tracker's own ingest
--      (record_account_live_sample, unchanged) raises and resolves it within a
--      sample interval. The trigger is cheap: one lookup of the account by
--      client and name, and nothing more unless the account is Failed or has
--      the flag open. A fault in it is a WARNING and never refuses a sample.
--
-- WHAT COUNTS AS "A PERSON CHANGED IT". Two witnesses, either is enough:
--   * The audit row the app writes. src/App.jsx persistAccountUpdate saves a
--     status (AccountManager, the bulk Mark Failed, the flag queue's "Failed,
--     mark it Failed") and then writes audit_logs action 'account.update',
--     entity_type 'trading_account', entity_id NULL (the app passes the account
--     NAME, which createSupabaseAuditLog does not store as an id) and
--     after_data {clientId, accountName, patch}, where clientId is the client's
--     legacy_key or its uuid. A row like that later than auto_failed_at whose
--     patch has a status key, matched by client and account name, case and
--     whitespace insensitive, is a person changing the status. So is step 68's
--     'trading_account.flags_resolved_on_retire' row for the account. Read by
--     account_status_changed_by_person(account, since).
--   * The guard. The app writes that audit row AFTER the save and swallows a
--     failure to write it, so it can be missing. The observed columns guard
--     (step 65's, redefined here) therefore clears the automation's marker
--     whenever the BROWSER changes the status of the row, the way step 67's
--     note guard clears the database's resolution_note when a person changes a
--     flag's status: from then on the row is the person's. The refresh also
--     clears a marker left on a row whose status is no longer Failed.
--
-- ===========================================================================
-- INTERPRETATIONS this file had to make, each one narrow:
--
--   * THE PRIOR STATUS OF A STEP 65 FAILURE IS RECORDED, IN after_data. The
--     spec said those rows hold no prior status and to read before_data, else
--     'Active'. Step 65 wrote before_data NULL and the prior status as
--     after_data.previousStatus ('Active' or 'Payout Hold'). The backfill reads
--     before_data.status first, then after_data.previousStatus, then 'Active',
--     so an account step 65 took from Payout Hold goes back to Payout Hold.
--   * auto_failed_date_set FOR A STEP 65 FAILURE is inferred: step 65's audit
--     does not say what date_failed was before, so it is true when date_failed
--     equals the breach date the audit recorded (the date step 65 would have
--     written) and false otherwise. A person who had typed exactly the breach
--     date before step 65 ran would have it cleared on reactivation; that is
--     the cost of the inference, and it is the only way to tell.
--   * A FOURTH MARKER COLUMN, auto_failed_through. Reactivation needs "a trade
--     after the failure", and for a failure confirmed by (b) the account may
--     well have traded between breached_on (= date_failed) and the closes that
--     confirmed it. Read literally ("a close after date_failed with P&L"),
--     those trades would set the account back in the same refresh that failed
--     it, and the next refresh would fail it again, forever. So the marker
--     keeps the last trade the close had already weighed when it failed the
--     account (its last close with P&L on or after breached_on, or breached_on
--     itself), and reactivation needs a trade on a close after
--     greatest(date_failed, auto_failed_through). For a step 65 failure the
--     close weighed nothing after the breach, so auto_failed_through is the
--     breach date and the rule is exactly "after date_failed" for the 13.
--   * ONE MORE POINTER COLUMN, breach_flag_id, for the re-import rule in 2.
--   * AN EMPTY CLOSE IS NOT AN ABSENCE. A close carrying no account snapshot at
--     all (a failed or partial import) would make every breached account of
--     the client "absent"; condition a counts a close only if it lists at
--     least one account.
--   * THE FAMILY OF A STRATEGY ROW is strategy_family, or, when that is empty,
--     strategy_family_key(strategy_name): step 47's own identity rule, the one
--     recompute_strategy_ran matches fills with. A strategy row belongs to an
--     account snapshot through account_snapshot_id, or, when that is NULL,
--     through the same close and trading_account_id. A snapshot belongs to an
--     account when it points at it, or names it (case and whitespace
--     insensitive) and points at nothing: step 67's live guard's reading.
--   * A PEER is counted once per account: by trading_account_id, or by client
--     and lower(btrim(account_name)) for a snapshot that points at nothing.
--   * DATES IN MESSAGES. "marked Failed by the CRM on <date>" is the failure
--     date the close used (the breach date in its audit row), "traded on
--     <date>" is the LATEST close with P&L after the failure; the audit row
--     also carries the first one and the count.
--   * A Failed account with NO date_failed has no "after" to read, so neither
--     'Failed account traded' nor 'Strategies still loaded' is raised for it.
--     Most accounts a person marked Failed before the app stamped the date are
--     in that shape; the lifecycle panel already calls them out.
--
-- ===========================================================================
-- WHAT THIS FILE ADDS.
--
--   1. account_observation_settings: confirm_closes (2, 1 to 10),
--      confirm_peer_accounts (3, 1 to 50), auto_reactivate (true). The value
--      of auto_fail_on_breach is NOT touched: the owner has turned it off by
--      hand, the confirmed failure (3) is gated by it, and the runbook says how
--      to turn it back on.
--   2. trading_accounts: auto_failed_at, auto_failed_prior_status (CHECK
--      Active or Payout Hold), auto_failed_date_set, auto_failed_through (the
--      four set and cleared together, CHECK), breach_flag_id. Written by the
--      database only: the observed columns guard (step 65's) now covers them,
--      and clears the four when the browser changes the status.
--   3. Helpers, owner only: account_observation_money (step 65's dollar
--      format, once), auto_failed_flag_message (the failure flag's words, built
--      from the audit row so a re-written flag says the same thing),
--      account_status_changed_by_person.
--   4. failed_account_strategies_check(client, account), EXECUTE for the
--      service role, and the trigger account_live_samples_failed_strategies.
--   5. refresh_account_observations, replaced with the same signature and the
--      same grants: step 67's body with 2, 3 and 4 in place of step 65's auto
--      fail. The triggers that call it are step 65's and are not touched.
--   6. The marker on the accounts step 65 already failed, once: every Failed
--      account whose latest 'trading_account.auto_failed' audit row nobody has
--      overridden since (no person changed its status, the close did not set
--      it back) gets auto_failed_at (the audit row's time),
--      auto_failed_prior_status, auto_failed_date_set and auto_failed_through
--      as INTERPRETATIONS says.
--   7. The recompute: every client with a close, once, like step 65's
--      backfill. On production this is what sets back the 13 (auto_reactivate
--      is true by default), writes their audit rows and flags, flags Failed
--      accounts a person failed that traded after their date, and raises the
--      'Strategies still loaded' flag on the frozen account. With
--      auto_fail_on_breach off, as the owner has it now, nothing is newly
--      failed. One NOTICE says what it did.
--
-- ===========================================================================
-- HAZARDS KNOWN AND HOW THEY ARE HANDLED.
--
-- * A re-run of 65 or 67 puts their refresh back (the breach alone fails the
--   account again) and 65's guard back (the new columns unguarded). Run 71
--   again after any re-run of 65 or 67. A re-run of 71 marks nothing twice.
-- * A stale browser tab re-uploading a close writes its in memory registry's
--   status (step 65's hazard). In one direction it sets a Failed account back
--   to Active: the marker is cleared by the guard and the account reads Active
--   and breached ("looks failed" in accountBuckets.js), and the close does not
--   fail it again in the same run. In the other, a tab loaded before a
--   reactivation writes Failed again: the account then reads as failed by a
--   person, so it is never set back by the close, and the 'Failed account
--   traded' flag is what tells the CAM. Neither direction is guarded, for step
--   65's reason: a human status must stay writable.
-- * Step 68's trigger (AFTER UPDATE OF status) never meets the close's
--   transitions: a confirmed failure happens while the account already reads
--   breached, which 68 reads as already past the five, and a reactivation is
--   a revive, which 68 ignores. Step 67's resolve inside the refresh stays the
--   only resolve on a failure, with its own note.
-- * The sample trigger runs inside record_account_live_sample. It takes the
--   client's refresh lock with pg_try_advisory_xact_lock and skips when a
--   refresh holds it (the refresh evaluates the same accounts itself), runs
--   with lock_timeout 500ms so a wait on a close being written times out
--   before the deadlock detector could pick the close, resolves with FOR
--   UPDATE SKIP LOCKED, and swallows every error into a WARNING.
-- * No NOTICE is raised inside the refresh: it runs at the commit of every
--   close and step 66's test asserts the finalize says nothing.
--
-- UNDO, in the SQL editor, for one account the close set back by mistake: set
-- its status to Failed in the CRM (a person's failure is never set back). To
-- stop reactivation everywhere:
--   update public.account_observation_settings
--      set auto_reactivate = false, updated_at = now() where id;
--
-- IDEMPOTENT. `add column if not exists`, constraints dropped and recreated
-- under their own names, `create or replace` for the functions, `drop trigger
-- if exists` then `create`, the marker backfill only on rows without a marker,
-- and a recompute whose writes are all transitions or one-flag-per-account
-- rules, so a second run fails, sets back and flags nothing new.
--
-- GRANTS (step 56's rule: restated). refresh_account_observations and
-- failed_account_strategies_check: EXECUTE for service_role, nothing for
-- public, anon or authenticated, as step 65 had the refresh. The helpers and
-- the trigger functions: nobody but the owner. trading_accounts and
-- operational_flags keep select, insert, update, delete for authenticated and
-- nothing for anon; account_observation_settings and account_live_samples keep
-- SELECT for authenticated and nothing else. No new table, so step 56's
-- exception table is unchanged.
--
-- CHECK AFTERWARDS (read only):
--
--   select action, count(*) from public.audit_logs
--    where action in ('trading_account.auto_failed', 'trading_account.auto_reactivated')
--    group by 1;
--   select type, status, count(*) from public.operational_flags
--    where type in ('Breach suspected', 'Reactivated by the close',
--                   'Failed account traded', 'Strategies still loaded')
--    group by 1, 2 order by 1, 2;
--   select confirm_closes, confirm_peer_accounts, auto_reactivate, auto_fail_on_breach
--     from public.account_observation_settings;

do $step71_guard$
begin
  if to_regprocedure('public.refresh_account_observations(uuid)') is null
    or to_regprocedure('public.live_account_flag_types()') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'operational_flags' and column_name = 'resolution_note'
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'account_observation_settings' and column_name = 'resolve_flags_on_fail'
    ) then
    raise exception 'step 71 needs step 67 (refresh_account_observations, live_account_flag_types, operational_flags.resolution_note, account_observation_settings.resolve_flags_on_fail): run it first';
  end if;
  if to_regclass('public.account_live_samples') is null
    or to_regprocedure('public.strategy_family_key(text)') is null then
    raise exception 'step 71 needs step 55 (account_live_samples) and step 47 (strategy_family_key): run them first';
  end if;
end
$step71_guard$;

begin;

-- ---------------------------------------------------------------------------
-- 1. The tunables, on step 65's singleton. auto_fail_on_breach is not touched.
-- ---------------------------------------------------------------------------
alter table public.account_observation_settings
  add column if not exists confirm_closes integer not null default 2,
  add column if not exists confirm_peer_accounts integer not null default 3,
  add column if not exists auto_reactivate boolean not null default true;

alter table public.account_observation_settings
  drop constraint if exists account_observation_settings_confirm_closes_check;
alter table public.account_observation_settings
  add constraint account_observation_settings_confirm_closes_check
  check (confirm_closes between 1 and 10);

alter table public.account_observation_settings
  drop constraint if exists account_observation_settings_confirm_peer_accounts_check;
alter table public.account_observation_settings
  add constraint account_observation_settings_confirm_peer_accounts_check
  check (confirm_peer_accounts between 1 and 50);

comment on column public.account_observation_settings.auto_fail_on_breach is
  'Whether the close marks a breached account Failed once later closes confirm it (step 71): missing from the last confirm_closes closes, or not trading on them while at least confirm_peer_accounts accounts of other clients traded its algorithm. Since step 71 a breach alone never fails an account. Off: nothing is marked Failed, the observation and the Breach suspected flag are still written, and reactivation (auto_reactivate) still runs.';
comment on column public.account_observation_settings.confirm_closes is
  'How many of the client''s most recent closes on or after breached_on must confirm a breach before the close marks the account Failed (step 71). 1 to 10.';
comment on column public.account_observation_settings.confirm_peer_accounts is
  'How many distinct accounts of OTHER clients must have traded (gross_realized_pnl <> 0) the same strategy family on the same trading date for a breached account that did not trade to count as stopped while its algorithm kept trading (step 71). 1 to 50.';
comment on column public.account_observation_settings.auto_reactivate is
  'Whether the close sets back an account it marked Failed itself when the account trades on a later close (step 71). Off: such an account gets a Failed account traded flag instead. An account a person marked Failed is never set back either way.';
comment on table public.account_observation_settings is
  'Singleton tunables for the account observations (steps 65, 67, 71). Edit in the SQL editor, for example: update public.account_observation_settings set auto_fail_on_breach = true, updated_at = now() where id; The CHECK constraints are the review. stale_closes and confirm_closes are counted in closes of the client, not days.';

-- ---------------------------------------------------------------------------
-- 2. What the automation did, on the registry row, so it can be undone.
-- ---------------------------------------------------------------------------
alter table public.trading_accounts
  add column if not exists breach_flag_id uuid,
  add column if not exists auto_failed_at timestamptz,
  add column if not exists auto_failed_prior_status text,
  add column if not exists auto_failed_date_set boolean,
  add column if not exists auto_failed_through date;

alter table public.trading_accounts
  drop constraint if exists trading_accounts_auto_failed_prior_status_check;
alter table public.trading_accounts
  add constraint trading_accounts_auto_failed_prior_status_check
  check (auto_failed_prior_status is null or auto_failed_prior_status in ('Active', 'Payout Hold'));

-- The four are one fact: set together when the close fails an account, cleared
-- together when it sets the account back or a person takes the row over.
alter table public.trading_accounts
  drop constraint if exists trading_accounts_auto_failed_marker_check;
alter table public.trading_accounts
  add constraint trading_accounts_auto_failed_marker_check
  check ((auto_failed_at is null) = (auto_failed_prior_status is null)
    and (auto_failed_at is null) = (auto_failed_date_set is null)
    and (auto_failed_at is null) = (auto_failed_through is null));

comment on column public.trading_accounts.auto_failed_at is
  'When the close marked this account Failed (step 71, or the step 65 audit row''s time for an account step 65 failed). NULL when the current status is not the close''s doing: never failed by the close, set back by it, or taken over by a person (the guard clears it when the browser changes the status). Written by the database only.';
comment on column public.trading_accounts.auto_failed_prior_status is
  'The status the account had before the close marked it Failed (Active or Payout Hold), which reactivation restores. Set and cleared with auto_failed_at. Step 71.';
comment on column public.trading_accounts.auto_failed_date_set is
  'True when the close wrote date_failed because it was empty, so reactivation sets it back to NULL; false when a date was already there and was kept. Inferred for step 65''s failures (true when date_failed equals the breach date its audit row recorded). Set and cleared with auto_failed_at. Step 71.';
comment on column public.trading_accounts.auto_failed_through is
  'The last trade the close had already weighed when it failed the account: its last close with realized P&L on or after breached_on, or breached_on when there was none (and for every step 65 failure, which read the breach and nothing after it). Reactivation needs a trade on a close after greatest(date_failed, auto_failed_through), so a trade the close already weighed cannot undo its own failure. Set and cleared with auto_failed_at. Step 71.';
comment on column public.trading_accounts.breach_flag_id is
  'The Breach suspected flag the close wrote for the current run of breached readings. Deliberately not a foreign key: a re-import deletes every flag of a close, and the dangling id is how the next refresh knows to write it again while the account is still Active or Payout Hold and still breached (step 65''s auto_fail_flag_id convention). Step 71.';

-- ---------------------------------------------------------------------------
-- 3. The guard, step 65's, with the five new columns, and the marker cleared
--    when a person (the browser) changes the status.
--
-- Security INVOKER on purpose, as in step 65: current_user is 'authenticated'
-- or 'anon' for the browser, postgres for the refresh and the ingest RPCs,
-- service_role for the API routes.
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
      or new.auto_fail_flag_id is not null
      or new.breach_flag_id is not null
      or new.auto_failed_at is not null
      or new.auto_failed_prior_status is not null
      or new.auto_failed_date_set is not null
      or new.auto_failed_through is not null then
      raise exception using
        errcode = '42501',
        message = 'observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading, observed_at, auto_fail_flag_id, breach_flag_id, auto_failed_at, auto_failed_prior_status, auto_failed_date_set and auto_failed_through are written by the close (refresh_account_observations), not by the browser.';
    end if;
    return new;
  end if;
  if new.observed_state is distinct from old.observed_state
    or new.last_close_seen_on is distinct from old.last_close_seen_on
    or new.closes_missed is distinct from old.closes_missed
    or new.breached_on is distinct from old.breached_on
    or new.breach_reading is distinct from old.breach_reading
    or new.observed_at is distinct from old.observed_at
    or new.auto_fail_flag_id is distinct from old.auto_fail_flag_id
    or new.breach_flag_id is distinct from old.breach_flag_id
    or new.auto_failed_at is distinct from old.auto_failed_at
    or new.auto_failed_prior_status is distinct from old.auto_failed_prior_status
    or new.auto_failed_date_set is distinct from old.auto_failed_date_set
    or new.auto_failed_through is distinct from old.auto_failed_through then
    raise exception using
      errcode = '42501',
      message = 'observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading, observed_at, auto_fail_flag_id, breach_flag_id, auto_failed_at, auto_failed_prior_status, auto_failed_date_set and auto_failed_through are written by the close (refresh_account_observations), not by the browser.';
  end if;
  -- STEP 71. A person changing the status takes the row from the close: the
  -- close's marker goes, so the close never sets back what a person decided.
  -- The app's audit row says the same thing, but it is written after the save
  -- and a failure to write it is swallowed; this is the witness that cannot
  -- be missing.
  if new.status is distinct from old.status and old.auto_failed_at is not null then
    new.auto_failed_at := null;
    new.auto_failed_prior_status := null;
    new.auto_failed_date_set := null;
    new.auto_failed_through := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trading_accounts_observed_columns_guard on public.trading_accounts;
create trigger trading_accounts_observed_columns_guard
  before insert or update on public.trading_accounts
  for each row execute function public.trading_accounts_observed_columns_guard();

-- ---------------------------------------------------------------------------
-- 4. Helpers.
-- ---------------------------------------------------------------------------

-- Step 65's dollar format, once: "-$1,524", "$1,500.5", "$0".
create or replace function public.account_observation_money(p_amount numeric)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select case
    when p_amount is null then null
    else case when p_amount < 0 then '-' else '' end
      || '$' || rtrim(rtrim(to_char(abs(round(p_amount, 2)), 'FM999,999,999,999,990.00'), '0'), '.')
  end;
$function$;

comment on function public.account_observation_money(numeric) is
  'A dollar amount in the words the account flags use: -$1,524, $1,500.5. Step 65''s format, kept in one place. Step 71.';

-- The words of a 'Marked Failed by the close' flag, built from the audit row
-- the close wrote, so a flag a re-import deleted is written again with the
-- same words. An audit row without confirmedBy is step 65's and gets step 65's
-- sentence exactly (its flag keeps its identity, type|account|message).
-- Nothing here casts a value it has not checked: a signed in CAM can insert an
-- audit row, and a malformed one must not make a close fail.
create or replace function public.auto_failed_flag_message(p_label text, p_audit jsonb, p_limit numeric)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  with parts as (
    select
      coalesce(p_label, '') as label,
      coalesce(p_audit ->> 'breachedOn', 'an unknown date') as breached_on,
      case when (p_audit ->> 'reading') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then public.account_observation_money((p_audit ->> 'reading')::numeric)
        else 'not recorded' end as reading,
      case when p_limit is not null and p_limit > 0
        then ' against a ' || public.account_observation_money(p_limit) || ' limit'
        else '' end as limit_words,
      coalesce(p_audit ->> 'previousStatus', 'Active') as previous,
      p_audit ->> 'confirmedBy' as confirmed_by,
      case when jsonb_typeof(p_audit -> 'closes') = 'array'
        then (select array_agg(x.value order by x.value) from jsonb_array_elements_text(p_audit -> 'closes') as x)
      end as closes,
      case when jsonb_typeof(p_audit -> 'families') = 'array'
        then (select string_agg(x.value, ', ' order by x.value) from jsonb_array_elements_text(p_audit -> 'families') as x)
      end as families,
      case when (p_audit ->> 'minPeerAccounts') ~ '^[0-9]+$' then p_audit ->> 'minPeerAccounts' end as peers
  ),
  worded as (
    select p.*,
           case
             when coalesce(cardinality(p.closes), 0) = 0 then 'the last closes'
             when cardinality(p.closes) = 1 then 'the last close (' || p.closes[1] || ')'
             else 'the last ' || cardinality(p.closes) || ' closes (' || array_to_string(p.closes, ', ') || ')'
           end as closes_words
    from parts as p
  )
  select case
    when w.confirmed_by is null then
      format('%s breached on %s: trailing reading %s%s, status was %s. Change the status on the account if the prop firm says otherwise.',
             w.label, w.breached_on, w.reading, w.limit_words, w.previous)
    when w.confirmed_by = 'absent' then
      format('%s breached on %s: trailing reading %s%s, and it has been missing from %s. Status was %s. Change the status on the account if the prop firm says otherwise.',
             w.label, w.breached_on, w.reading, w.limit_words, w.closes_words, w.previous)
    else
      format('%s breached on %s: trailing reading %s%s, and on %s it did not trade while %s traded on at least %s accounts of other clients. Status was %s. Change the status on the account if the prop firm says otherwise.',
             w.label, w.breached_on, w.reading, w.limit_words, w.closes_words,
             coalesce(w.families, 'its algorithm'), coalesce(w.peers, 'several'), w.previous)
  end
  from worded as w;
$function$;

comment on function public.auto_failed_flag_message(text, jsonb, numeric) is
  'The message of a Marked Failed by the close flag, from the trading_account.auto_failed audit row: step 65''s sentence for a step 65 row, the confirming evidence (missing from the closes, or not trading while its algorithm traded on other clients'' accounts) for a step 71 row. Step 71.';

-- Whether a person changed the account's status after p_since: the app's
-- 'account.update' audit row with a status in its patch (matched by client and
-- account name, the app stores no account id), or step 68's record of a person
-- retiring the account. See WHAT COUNTS AS "A PERSON CHANGED IT".
create or replace function public.account_status_changed_by_person(p_account_id uuid, p_since timestamptz)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.trading_accounts as t
    join public.clients as c on c.id = t.client_id
    join public.audit_logs as a
      on a.created_at > p_since
     and a.entity_type = 'trading_account'
     and (
       (a.action = 'account.update'
        and jsonb_typeof(a.after_data -> 'patch') = 'object'
        and (a.after_data -> 'patch') ? 'status'
        and (a.entity_id = t.id
             or (lower(btrim(a.after_data ->> 'accountName')) = lower(btrim(t.account_name))
                 and (a.after_data ->> 'clientId') in (t.client_id::text, c.legacy_key))))
       or (a.action = 'trading_account.flags_resolved_on_retire' and a.entity_id = t.id)
     )
    where t.id = p_account_id
  );
$function$;

comment on function public.account_status_changed_by_person(uuid, timestamptz) is
  'Whether a person changed the status of a trading account after a moment: an account.update audit row (what src/App.jsx persistAccountUpdate writes: entity_id NULL, after_data clientId and accountName, a patch with a status key) or a trading_account.flags_resolved_on_retire row (step 68) later than it. NULL since means never. Step 71.';

-- ---------------------------------------------------------------------------
-- 5. Strategies still loaded on a Failed account.
-- ---------------------------------------------------------------------------
create or replace function public.failed_account_strategies_check(p_client_id uuid, p_account_name text default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_type constant text := 'Strategies still loaded';
  v_latest_close uuid;
  v_now timestamptz := now();
  v_changed integer := 0;
  v_rows integer;
  v_holds boolean;
  v_note text;
  r record;
begin
  if p_client_id is null then
    return 0;
  end if;
  -- The refresh's lock: one writer of a client's account flags at a time.
  -- Re-entrant inside the refresh and inside the sample trigger, which took it
  -- with a try.
  perform pg_advisory_xact_lock(hashtext(p_client_id::text));

  -- A flag needs a close to stand on: camFlagQueue.js walks dailyImports[].flags.
  select d.id into v_latest_close
  from public.daily_imports as d
  where d.client_id = p_client_id
  order by d.trading_date desc, d.id desc
  limit 1;

  for r in
    select t.id, t.status, t.date_failed,
           coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
           sample.account_name is not null as sampled,
           sample.run_state,
           sample.enabled_strategy_count,
           exists (
             select 1
             from public.daily_imports as d
             join public.account_snapshots as s on s.daily_import_id = d.id
             where d.client_id = t.client_id
               and t.date_failed is not null
               and d.trading_date > t.date_failed
               and coalesce(s.gross_realized_pnl, 0) <> 0
               and (s.trading_account_id = t.id
                    or (s.trading_account_id is null
                        and lower(btrim(s.account_name)) = lower(btrim(t.account_name))))
           ) as traded_since,
           exists (
             select 1 from public.operational_flags as f
             where f.trading_account_id = t.id and f.type = v_type and f.status = 'Open'
           ) as has_open,
           -- A CAM who resolved it for this failure has answered it: a flag a
           -- person resolved is a row, and it is left alone (step 65).
           exists (
             select 1
             from public.operational_flags as f
             join public.daily_imports as fd on fd.id = f.daily_import_id
             where f.trading_account_id = t.id
               and f.type = v_type
               and f.status <> 'Open'
               and f.resolution_note is null
               and t.date_failed is not null
               and fd.trading_date >= t.date_failed
           ) as person_resolved
    from public.trading_accounts as t
    left join lateral (
      select s.account_name, s.run_state, s.enabled_strategy_count
      from public.account_live_samples as s
      where s.client_id = t.client_id
        and lower(s.account_name) = lower(btrim(t.account_name))
      order by s.sampled_at desc, s.reported_at desc, s.id
      limit 1
    ) as sample on true
    where t.client_id = p_client_id
      and (p_account_name is null or lower(btrim(t.account_name)) = lower(btrim(p_account_name)))
      and (t.status = 'Failed'
           or exists (
             select 1 from public.operational_flags as f
             where f.trading_account_id = t.id and f.type = v_type and f.status = 'Open'))
    order by t.account_name, t.id
  loop
    v_holds := r.status = 'Failed'
      and r.date_failed is not null
      and r.sampled
      and (coalesce(r.enabled_strategy_count, 0) > 0 or r.run_state = 'running')
      and not r.traded_since;

    if v_holds then
      if not r.has_open and not r.person_resolved and v_latest_close is not null then
        insert into public.operational_flags (
          daily_import_id, client_id, trading_account_id, type, severity, message, status
        ) values (
          v_latest_close,
          p_client_id,
          r.id,
          v_type,
          'Warning',
          format('%s failed on %s and has had no trades since, but its strategies are still loaded in NinjaTrader. Remove them.',
                 r.label, to_char(r.date_failed, 'YYYY-MM-DD')),
          'Open'
        );
        v_changed := v_changed + 1;
      end if;
    elsif r.has_open then
      v_note := case
        when r.status is distinct from 'Failed' then 'Account is no longer Failed.'
        when r.traded_since then 'Account traded after it failed.'
        when r.date_failed is null then 'Account has no failure date any more.'
        when not r.sampled then 'NinjaTrader no longer reports the account.'
        else 'NinjaTrader shows no strategy enabled on the account.'
      end;
      update public.operational_flags as f
         set status = 'Resolved',
             resolved_at = v_now,
             resolved_by_user_id = null,
             resolution_note = v_note
       where f.id in (
         select open_flag.id from public.operational_flags as open_flag
         where open_flag.trading_account_id = r.id
           and open_flag.type = v_type
           and open_flag.status = 'Open'
         for update skip locked);
      get diagnostics v_rows = row_count;
      v_changed := v_changed + v_rows;
    end if;
  end loop;

  return v_changed;
end;
$function$;

comment on function public.failed_account_strategies_check(uuid, text) is
  'Raises one Strategies still loaded flag (on the client''s latest close) for each Failed account of a client, or the one named, whose latest account_live_samples row shows a strategy enabled or running while the account has had no trade since date_failed, and resolves the open one with a resolution_note when that stops being true. Returns the number of flags written. Called by refresh_account_observations and by the trigger on account_live_samples; callable by the service role. Step 71.';

-- The tracker's own ingest calls it, through the sample it writes. Cheap: one
-- lookup by client and name; the check only runs for a Failed account or one
-- with the flag open. Never refuses a sample (step 66's rule for its trigger
-- on the same table).
create or replace function public.account_live_samples_failed_strategies()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set lock_timeout = '500ms'
as $function$
begin
  begin
    if exists (
      select 1
      from public.trading_accounts as t
      where t.client_id = new.client_id
        and lower(btrim(t.account_name)) = lower(new.account_name)
        and (t.status = 'Failed'
             or exists (
               select 1 from public.operational_flags as f
               where f.trading_account_id = t.id
                 and f.type = 'Strategies still loaded'
                 and f.status = 'Open'))
    ) then
      -- A refresh of this client holds the lock: it evaluates this account
      -- itself, so this sample has nothing to add.
      if pg_try_advisory_xact_lock(hashtext(new.client_id::text)) then
        perform public.failed_account_strategies_check(new.client_id, new.account_name);
      end if;
    end if;
  exception when others then
    raise warning 'step 71: the strategies check skipped a sample for client % account %: % (%)',
      new.client_id, new.account_name, sqlerrm, sqlstate;
  end;
  return null;
end;
$function$;

comment on function public.account_live_samples_failed_strategies() is
  'AFTER INSERT OR UPDATE on account_live_samples: runs failed_account_strategies_check for the account a sample names when it is Failed or has a Strategies still loaded flag open, so the tracker''s ingest raises and resolves that flag. Skips when a refresh of the client holds its lock; a fault is a WARNING and the sample lands. Step 71.';

drop trigger if exists account_live_samples_failed_strategies on public.account_live_samples;
create trigger account_live_samples_failed_strategies
  after insert or update on public.account_live_samples
  for each row execute function public.account_live_samples_failed_strategies();

-- ---------------------------------------------------------------------------
-- 6. The refresh. Step 67's body with step 65's auto fail replaced by the
--    rule in the header. Everything not marked STEP 71 is step 65's or 67's.
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
  v_resolve_on_fail boolean;
  v_total integer;
  v_latest_close uuid;
  v_now timestamptz := now();
  v_touched integer := 0;
  v_new_state text;
  -- STEP 71: the tunables, and what this call did.
  v_confirm integer;
  v_peer_floor integer;
  v_reactivate boolean;
  v_became uuid[] := '{}';
  v_reactivated uuid[] := '{}';
  v_prior text;
  v_failed_on text;
  v_date_cleared boolean;
  v_audit jsonb;
  v_message text;
  -- The accounts this call marked Failed, kept for the flag decision after the
  -- loop: up to three get a flag each, more get one flag naming them all.
  v_failed_ids uuid[] := '{}';
  v_failed_names text[] := '{}';
  v_failed_dates date[] := '{}';
  v_failed_messages text[] := '{}';
  v_failed_closes uuid[] := '{}';
  v_flag_id uuid;
  v_count integer;
  i integer;
  r record;
  -- STEP 67: what one account's transition resolved.
  v_resolved_count integer;
  v_resolved_types jsonb;
  v_resolved_ids jsonb;
begin
  -- Two refreshes of one client committing in the same window would both read
  -- old_state before the row lock and both write the same audit rows and flags:
  -- one client at a time.
  perform pg_advisory_xact_lock(hashtext(p_client_id::text));

  if p_client_id is null then
    return 0;
  end if;

  select settings.* into v_settings
  from public.account_observation_settings as settings
  where settings.id;
  -- The seed is step 65's, so a missing row means somebody deleted it. The
  -- column defaults stand in rather than the refresh refusing a close.
  v_stale := coalesce(v_settings.stale_closes, 5);
  v_auto_fail := coalesce(v_settings.auto_fail_on_breach, true);
  v_resolve_on_fail := coalesce(v_settings.resolve_flags_on_fail, true);
  v_confirm := coalesce(v_settings.confirm_closes, 2);
  v_peer_floor := coalesce(v_settings.confirm_peer_accounts, 3);
  v_reactivate := coalesce(v_settings.auto_reactivate, true);

  select count(*)::integer into v_total
  from public.daily_imports as d
  where d.client_id = p_client_id;

  select d.id into v_latest_close
  from public.daily_imports as d
  where d.client_id = p_client_id
  order by d.trading_date desc, d.id desc
  limit 1;

  -- -------------------------------------------------------------------------
  -- THE OBSERVATION, step 65's, unchanged. STEP 71 only remembers which
  -- accounts became breached in this refresh while Active or Payout Hold.
  -- -------------------------------------------------------------------------
  for r in
    with closes as (
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
           case when lm.breached then rs.reading end as breach_reading
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

    -- STEP 71: no status moves here any more. The transition is remembered
    -- for the Breach suspected flag, written below once the confirmation has
    -- had its say.
    if v_new_state = 'breached'
      and r.old_state is distinct from 'breached'
      and r.status in ('Active', 'Payout Hold') then
      v_became := array_append(v_became, r.id);
    end if;
  end loop;

  -- STEP 71: the close's marker means something only while the row is Failed.
  -- A row the automatic ingest replayed as Active, or that a person moved by a
  -- path the guard does not see, loses it here.
  update public.trading_accounts
     set auto_failed_at = null,
         auto_failed_prior_status = null,
         auto_failed_date_set = null,
         auto_failed_through = null
   where client_id = p_client_id
     and auto_failed_at is not null
     and status is distinct from 'Failed';

  -- -------------------------------------------------------------------------
  -- STEP 71: REACTIVATION. An account the close failed, that nobody has
  -- changed since, that traded on a close after the failure.
  -- -------------------------------------------------------------------------
  if v_reactivate then
    for r in
      select t.id, t.account_name,
             coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
             t.date_failed, t.max_drawdown_limit, t.auto_failed_at,
             t.auto_failed_prior_status, t.auto_failed_date_set, t.auto_failed_through,
             ev.first_traded_on, ev.last_traded_on, ev.traded_closes, ev.last_close_id,
             (select a.after_data ->> 'breachedOn'
                from public.audit_logs as a
               where a.entity_type = 'trading_account' and a.entity_id = t.id
                 and a.action = 'trading_account.auto_failed'
               order by a.created_at desc, a.id desc
               limit 1) as failed_on
      from public.trading_accounts as t
      cross join lateral (
        select min(d.trading_date) as first_traded_on,
               max(d.trading_date) as last_traded_on,
               count(distinct d.id)::integer as traded_closes,
               (array_agg(d.id order by d.trading_date desc, d.id desc))[1] as last_close_id
        from public.daily_imports as d
        join public.account_snapshots as s on s.daily_import_id = d.id
        where d.client_id = t.client_id
          and d.trading_date > greatest(t.date_failed, t.auto_failed_through)
          and coalesce(s.gross_realized_pnl, 0) <> 0
          and (s.trading_account_id = t.id
               or (s.trading_account_id is null
                   and lower(btrim(s.account_name)) = lower(btrim(t.account_name))))
      ) as ev
      where t.client_id = p_client_id
        and t.status = 'Failed'
        and t.auto_failed_at is not null
        and ev.last_traded_on is not null
        and not public.account_status_changed_by_person(t.id, t.auto_failed_at)
      order by t.account_name, t.id
    loop
      v_prior := case
        when r.auto_failed_prior_status in ('Active', 'Payout Hold') then r.auto_failed_prior_status
        else 'Active'
      end;
      v_failed_on := coalesce(r.failed_on, to_char(r.date_failed, 'YYYY-MM-DD'), to_char(r.auto_failed_at, 'YYYY-MM-DD'));
      -- Only the date the close wrote goes, and only if it is still that date.
      v_date_cleared := coalesce(r.auto_failed_date_set, false)
        and r.date_failed is not null
        and to_char(r.date_failed, 'YYYY-MM-DD') = coalesce(r.failed_on, to_char(r.date_failed, 'YYYY-MM-DD'));

      update public.trading_accounts
         set status = v_prior,
             date_failed = case when v_date_cleared then null else date_failed end,
             auto_failed_at = null,
             auto_failed_prior_status = null,
             auto_failed_date_set = null,
             auto_failed_through = null,
             updated_at = v_now
       where id = r.id;

      insert into public.audit_logs (user_id, entity_type, entity_id, action, before_data, after_data)
      values (
        null,
        'trading_account',
        r.id,
        'trading_account.auto_reactivated',
        jsonb_build_object(
          'status', 'Failed',
          'dateFailed', r.date_failed,
          'autoFailedAt', r.auto_failed_at,
          'autoFailedThrough', r.auto_failed_through,
          'autoFailedDateSet', r.auto_failed_date_set
        ),
        jsonb_build_object(
          'clientId', p_client_id,
          'accountName', r.account_name,
          'status', v_prior,
          'dateFailed', case when v_date_cleared then null else r.date_failed end,
          'dateFailedCleared', v_date_cleared,
          'failedOn', v_failed_on,
          'tradedOn', r.last_traded_on,
          'firstTradedOn', r.first_traded_on,
          'tradedCloses', r.traded_closes
        )
      );

      -- The close's own failure flag is answered by the close.
      update public.operational_flags
         set status = 'Resolved',
             resolved_at = v_now,
             resolved_by_user_id = null,
             resolution_note = 'Account traded after the close marked it Failed, so the close set it back.'
       where trading_account_id = r.id
         and type = 'Marked Failed by the close'
         and status = 'Open';

      insert into public.operational_flags (
        daily_import_id, client_id, trading_account_id, type, severity, message, status
      ) values (
        r.last_close_id,
        p_client_id,
        r.id,
        'Reactivated by the close',
        'Warning',
        format('%s was marked Failed by the CRM on %s but traded on %s. It is %s again. %s',
               r.label, v_failed_on, to_char(r.last_traded_on, 'YYYY-MM-DD'), v_prior,
               case
                 when r.max_drawdown_limit is not null and r.max_drawdown_limit > 0 then
                   format('Its drawdown limit is set to %s, so check it.', public.account_observation_money(r.max_drawdown_limit))
                 else 'Its drawdown limit is not set, so check it.'
               end),
        'Open'
      );

      v_reactivated := array_append(v_reactivated, r.id);
    end loop;
  end if;

  -- -------------------------------------------------------------------------
  -- STEP 71: THE CONFIRMED FAILURE. Active or Payout Hold, still breached, and
  -- the client's last confirm_closes closes on or after breached_on say
  -- absent, or present, not trading, while the algorithm traded on at least
  -- confirm_peer_accounts accounts of other clients.
  -- -------------------------------------------------------------------------
  if v_auto_fail then
    for r in
      with candidates as (
        select t.id, t.account_name, lower(btrim(t.account_name)) as name_key,
               coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
               t.status, t.date_failed, t.breached_on, t.breach_reading, t.max_drawdown_limit
        from public.trading_accounts as t
        where t.client_id = p_client_id
          and t.status in ('Active', 'Payout Hold')
          and t.observed_state = 'breached'
          and t.breached_on is not null
          -- Once per run of breached readings: a person (or a stale tab) who
          -- set back what the close failed in this run is left alone, unless
          -- the close itself set it back since.
          and not exists (
            select 1
            from public.audit_logs as a
            where a.entity_type = 'trading_account' and a.entity_id = t.id
              and a.action = 'trading_account.auto_failed'
              and a.after_data ->> 'breachedOn' = to_char(t.breached_on, 'YYYY-MM-DD')
              and not exists (
                select 1
                from public.audit_logs as b
                where b.entity_type = 'trading_account' and b.entity_id = t.id
                  and b.action = 'trading_account.auto_reactivated'
                  and b.created_at >= a.created_at))
      ),
      ranked as (
        select c.id as account_id, d.id as close_id, d.trading_date,
               row_number() over (partition by c.id order by d.trading_date desc, d.id desc) as rn
        from candidates as c
        join public.daily_imports as d
          on d.client_id = p_client_id
         and d.trading_date >= c.breached_on
      ),
      win as (
        select * from ranked where rn <= v_confirm
      ),
      own as (
        -- The account's snapshots on the window's closes.
        select w.account_id, w.close_id, s.id as snapshot_id, s.gross_realized_pnl
        from win as w
        join candidates as c on c.id = w.account_id
        join public.account_snapshots as s on s.daily_import_id = w.close_id
        where s.trading_account_id = c.id
           or (s.trading_account_id is null and lower(btrim(s.account_name)) = c.name_key)
      ),
      own_families as (
        -- The strategy families this account carries on each window close.
        select o.account_id, o.close_id,
               array_agg(distinct f.family order by f.family) as families
        from own as o
        join public.strategy_snapshots as ss
          on ss.daily_import_id = o.close_id
         and (ss.account_snapshot_id = o.snapshot_id
              or (ss.account_snapshot_id is null and ss.trading_account_id = o.account_id))
        cross join lateral (
          select coalesce(nullif(btrim(ss.strategy_family), ''), public.strategy_family_key(ss.strategy_name)) as family
        ) as f
        where f.family is not null
        group by o.account_id, o.close_id
      ),
      per_close as (
        select w.account_id, w.close_id, w.trading_date,
               exists (select 1 from public.account_snapshots as listed
                        where listed.daily_import_id = w.close_id) as listed,
               exists (select 1 from own as o
                        where o.account_id = w.account_id and o.close_id = w.close_id) as present,
               exists (select 1 from own as o
                        where o.account_id = w.account_id and o.close_id = w.close_id
                          and coalesce(o.gross_realized_pnl, 0) <> 0) as traded,
               fam.families
        from win as w
        left join own_families as fam on fam.account_id = w.account_id and fam.close_id = w.close_id
      ),
      judged as (
        select p.*,
               case when p.families is null then 0 else (
                 select count(distinct coalesce(ps.trading_account_id::text,
                                                pd.client_id::text || ':' || lower(btrim(ps.account_name))))::integer
                 from public.daily_imports as pd
                 join public.account_snapshots as ps on ps.daily_import_id = pd.id
                 where pd.client_id <> p_client_id
                   and pd.trading_date = p.trading_date
                   and coalesce(ps.gross_realized_pnl, 0) <> 0
                   and exists (
                     select 1
                     from public.strategy_snapshots as pss
                     where pss.daily_import_id = pd.id
                       and (pss.account_snapshot_id = ps.id
                            or (pss.account_snapshot_id is null
                                and ps.trading_account_id is not null
                                and pss.trading_account_id = ps.trading_account_id))
                       and coalesce(nullif(btrim(pss.strategy_family), ''), public.strategy_family_key(pss.strategy_name))
                           = any (p.families))
               ) end as peers
        from per_close as p
      ),
      verdict as (
        select j.account_id,
               count(*)::integer as closes,
               bool_and(j.listed and not j.present) as absent,
               bool_and(j.present and not j.traded and j.peers >= v_peer_floor) as peers_traded,
               array_agg(to_char(j.trading_date, 'YYYY-MM-DD') order by j.trading_date) as dates,
               array_agg(j.peers order by j.trading_date) as peer_counts,
               min(j.peers)::integer as min_peers,
               (array_agg(j.close_id order by j.trading_date desc, j.close_id desc))[1] as last_close_id
        from judged as j
        group by j.account_id
      )
      select c.id, c.account_name, c.label, c.status, c.date_failed, c.breached_on,
             c.breach_reading, c.max_drawdown_limit,
             v.absent, v.dates, v.peer_counts, v.min_peers, v.last_close_id,
             coalesce(
               (select array_agg(distinct fam.family order by fam.family)
                  from judged as j2
                  cross join lateral unnest(j2.families) as fam(family)
                 where j2.account_id = c.id),
               '{}'::text[]) as families,
             coalesce(
               (select max(d.trading_date)
                  from public.daily_imports as d
                  join public.account_snapshots as s on s.daily_import_id = d.id
                 where d.client_id = p_client_id
                   and d.trading_date >= c.breached_on
                   and coalesce(s.gross_realized_pnl, 0) <> 0
                   and (s.trading_account_id = c.id
                        or (s.trading_account_id is null and lower(btrim(s.account_name)) = c.name_key))),
               c.breached_on) as last_traded_on
      from candidates as c
      join verdict as v on v.account_id = c.id
      where v.closes = v_confirm
        and (v.absent or v.peers_traded)
      order by c.account_name, c.id
    loop
      v_audit := jsonb_build_object(
        'clientId', p_client_id,
        'accountName', r.account_name,
        'breachedOn', r.breached_on,
        'reading', r.breach_reading,
        'previousStatus', r.status,
        'confirmedBy', case when r.absent then 'absent' else 'peers_traded' end,
        'confirmedOn', r.dates[cardinality(r.dates)],
        'closes', to_jsonb(r.dates),
        'confirmCloses', v_confirm,
        'lastTradedOn', r.last_traded_on,
        'dateFailed', coalesce(r.date_failed, r.breached_on),
        'dateFailedSet', r.date_failed is null
      ) || case when r.absent then '{}'::jsonb else jsonb_build_object(
        'families', to_jsonb(r.families),
        'peerAccounts', to_jsonb(r.peer_counts),
        'minPeerAccounts', r.min_peers,
        'peerAccountsRequired', v_peer_floor
      ) end;

      update public.trading_accounts
         set status = 'Failed',
             date_failed = coalesce(date_failed, r.breached_on),
             auto_failed_at = v_now,
             auto_failed_prior_status = r.status,
             auto_failed_date_set = (date_failed is null),
             auto_failed_through = r.last_traded_on,
             updated_at = v_now
       where id = r.id;

      insert into public.audit_logs (user_id, entity_type, entity_id, action, before_data, after_data)
      values (
        null,
        'trading_account',
        r.id,
        'trading_account.auto_failed',
        jsonb_build_object('status', r.status, 'dateFailed', r.date_failed),
        v_audit
      );

      -- STEP 67: THE FLAGS ONLY A LIVE ACCOUNT CAN EARN, RESOLVED WITH IT.
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

      -- The suspicion is answered: the closes confirmed it.
      update public.operational_flags
         set status = 'Resolved',
             resolved_at = v_now,
             resolved_by_user_id = null,
             resolution_note = 'Breach confirmed: the close marked the account Failed.'
       where trading_account_id = r.id
         and type = 'Breach suspected'
         and status = 'Open';

      v_failed_ids := array_append(v_failed_ids, r.id);
      v_failed_names := array_append(v_failed_names, r.label);
      v_failed_dates := array_append(v_failed_dates, r.breached_on);
      v_failed_messages := array_append(v_failed_messages,
        public.auto_failed_flag_message(r.label, v_audit, r.max_drawdown_limit));
      v_failed_closes := array_append(v_failed_closes, r.last_close_id);
    end loop;
  end if;

  -- -------------------------------------------------------------------------
  -- STEP 71: BREACH SUSPECTED. On the transition into breached, for an account
  -- still Active or Payout Hold after the confirmation; and again when the
  -- flag the close wrote for this run was deleted by a re-import.
  -- -------------------------------------------------------------------------
  for r in
    select t.id,
           coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
           t.status, t.breached_on, t.breach_reading, t.max_drawdown_limit, t.breach_flag_id,
           (select d.id from public.daily_imports as d
             where d.client_id = p_client_id and d.trading_date = t.breached_on
             order by d.id limit 1) as breached_close_id,
           (select f.id from public.operational_flags as f
             where f.trading_account_id = t.id and f.type = 'Breach suspected' and f.status = 'Open'
             order by f.created_at, f.id limit 1) as open_flag_id
    from public.trading_accounts as t
    where t.client_id = p_client_id
      and t.status in ('Active', 'Payout Hold')
      and t.observed_state = 'breached'
      and t.breached_on is not null
      and (t.id = any (v_became)
           or (t.breach_flag_id is not null
               and not exists (select 1 from public.operational_flags as f where f.id = t.breach_flag_id)))
    order by t.account_name, t.id
  loop
    if r.open_flag_id is not null then
      -- One open flag per account: point at the one there is.
      if r.breach_flag_id is distinct from r.open_flag_id then
        update public.trading_accounts set breach_flag_id = r.open_flag_id where id = r.id;
      end if;
      continue;
    end if;
    if r.breached_close_id is null then
      continue;
    end if;
    insert into public.operational_flags (
      daily_import_id, client_id, trading_account_id, type, severity, message, status
    ) values (
      r.breached_close_id,
      p_client_id,
      r.id,
      'Breach suspected',
      'Warning',
      format('%s read %s%s on %s, past its drawdown rule. %s',
             r.label,
             public.account_observation_money(r.breach_reading),
             case when r.max_drawdown_limit is not null and r.max_drawdown_limit > 0
               then ' against a ' || public.account_observation_money(r.max_drawdown_limit) || ' limit'
               else '' end,
             to_char(r.breached_on, 'YYYY-MM-DD'),
             case
               when v_auto_fail then
                 format('It stays %s: the CRM marks it Failed only if, %s, it stops trading while its algorithm keeps trading on at least %s accounts of other clients, or it disappears from the closes.',
                        r.status,
                        case when v_confirm = 1 then 'on the next close' else format('for %s closes in a row', v_confirm) end,
                        v_peer_floor)
               else format('It stays %s, and the CRM is not marking accounts Failed by itself right now, so check it with the prop firm.', r.status)
             end),
      'Open'
    )
    returning id into v_flag_id;
    update public.trading_accounts set breach_flag_id = v_flag_id where id = r.id;
  end loop;

  -- -------------------------------------------------------------------------
  -- THE FLAG THE CLOSE DELETED (step 65). An account the close marked Failed
  -- remembers its flag's id; when that id points at no row any more and the
  -- account is still Failed by the close and still breached, the flag is
  -- written again with the words its audit row gives. A flag a CAM resolved is
  -- still a row, so it is not. STEP 71: only while the close's marker is on
  -- the row, and with the confirming close's date for a step 71 failure.
  -- -------------------------------------------------------------------------
  for r in
    select t.id, t.account_name, t.breached_on, t.breach_reading, t.max_drawdown_limit,
           coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
           audit.after_data
    from public.trading_accounts as t
    left join lateral (
      select a.after_data
      from public.audit_logs as a
      where a.entity_type = 'trading_account' and a.entity_id = t.id
        and a.action = 'trading_account.auto_failed'
      order by a.created_at desc, a.id desc
      limit 1
    ) as audit on true
    where t.client_id = p_client_id
      and t.observed_state = 'breached'
      and t.status = 'Failed'
      and t.auto_failed_at is not null
      and t.auto_fail_flag_id is not null
      and not exists (select 1 from public.operational_flags as f where f.id = t.auto_fail_flag_id)
      and not (t.id = any (v_failed_ids))
    order by t.account_name, t.id
  loop
    v_failed_ids := array_append(v_failed_ids, r.id);
    v_failed_dates := array_append(v_failed_dates, r.breached_on);
    if r.after_data ? 'confirmedBy' then
      v_failed_names := array_append(v_failed_names, r.label);
      v_failed_messages := array_append(v_failed_messages,
        public.auto_failed_flag_message(r.label, r.after_data, r.max_drawdown_limit));
      v_failed_closes := array_append(v_failed_closes,
        (select d.id from public.daily_imports as d
          where d.client_id = p_client_id
            and to_char(d.trading_date, 'YYYY-MM-DD') = coalesce(r.after_data ->> 'confirmedOn', to_char(r.breached_on, 'YYYY-MM-DD'))
          order by d.id limit 1));
    else
      -- Step 65's failure: step 65's words, account name, breach date and
      -- reading (the row's, as step 65's own rewrite read them), so the flag
      -- keeps its identity.
      v_failed_names := array_append(v_failed_names, r.account_name);
      v_failed_messages := array_append(v_failed_messages,
        public.auto_failed_flag_message(
          r.account_name,
          coalesce(r.after_data, '{}'::jsonb)
            || jsonb_build_object('breachedOn', to_char(r.breached_on, 'YYYY-MM-DD'),
                                  'reading', r.breach_reading),
          r.max_drawdown_limit));
      v_failed_closes := array_append(v_failed_closes,
        (select d.id from public.daily_imports as d
          where d.client_id = p_client_id and d.trading_date = r.breached_on
          order by d.id limit 1));
    end if;
  end loop;

  -- THE FLAG FOR THE CAM (step 65's flood rule). One to three failures in one
  -- refresh get a flag each, on the close that confirmed them; more get ONE
  -- flag per client naming them all, on the latest close. Each account keeps
  -- the id of the flag that names it.
  v_count := coalesce(array_length(v_failed_ids, 1), 0);
  if v_count between 1 and 3 then
    for i in 1 .. v_count loop
      insert into public.operational_flags (
        daily_import_id, client_id, trading_account_id, type, severity, message, status
      ) values (
        coalesce(v_failed_closes[i], v_latest_close),
        p_client_id,
        v_failed_ids[i],
        'Marked Failed by the close',
        'Warning',
        v_failed_messages[i],
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
      format('The close marked %s accounts Failed: %s. They breached %s. The audit log has the closes that confirmed each one. Change the status on an account if the prop firm says otherwise.',
             v_count,
             array_to_string(v_failed_names, ', '),
             case
               when (select min(d) from unnest(v_failed_dates) as d) = (select max(d) from unnest(v_failed_dates) as d)
                 then 'on ' || to_char((select min(d) from unnest(v_failed_dates) as d), 'YYYY-MM-DD')
               else 'between ' || to_char((select min(d) from unnest(v_failed_dates) as d), 'YYYY-MM-DD')
                 || ' and ' || to_char((select max(d) from unnest(v_failed_dates) as d), 'YYYY-MM-DD')
             end),
      'Open'
    )
    returning id into v_flag_id;
    update public.trading_accounts set auto_fail_flag_id = v_flag_id where id = any (v_failed_ids);
  end if;

  -- -------------------------------------------------------------------------
  -- STEP 71: A FAILED ACCOUNT THAT TRADED, and the close did not set it back:
  -- a person failed it, a person has changed it since, or auto_reactivate is
  -- off. One flag per failure; nothing else changes.
  -- -------------------------------------------------------------------------
  for r in
    select t.id,
           coalesce(nullif(btrim(t.alias), ''), t.account_name) as label,
           ev.last_traded_on, ev.last_close_id
    from public.trading_accounts as t
    cross join lateral (
      select max(d.trading_date) as last_traded_on,
             (array_agg(d.id order by d.trading_date desc, d.id desc))[1] as last_close_id
      from public.daily_imports as d
      join public.account_snapshots as s on s.daily_import_id = d.id
      where d.client_id = t.client_id
        and d.trading_date > case
          when t.auto_failed_at is not null then greatest(t.date_failed, t.auto_failed_through)
          else t.date_failed
        end
        and coalesce(s.gross_realized_pnl, 0) <> 0
        and (s.trading_account_id = t.id
             or (s.trading_account_id is null
                 and lower(btrim(s.account_name)) = lower(btrim(t.account_name))))
    ) as ev
    where t.client_id = p_client_id
      and t.status = 'Failed'
      and t.date_failed is not null
      and ev.last_traded_on is not null
      and not exists (
        select 1
        from public.operational_flags as f
        join public.daily_imports as fd on fd.id = f.daily_import_id
        where f.trading_account_id = t.id
          and f.type = 'Failed account traded'
          and fd.trading_date > t.date_failed
          and (f.status = 'Open' or f.resolution_note is null))
    order by t.account_name, t.id
  loop
    insert into public.operational_flags (
      daily_import_id, client_id, trading_account_id, type, severity, message, status
    ) values (
      r.last_close_id,
      p_client_id,
      r.id,
      'Failed account traded',
      'Warning',
      format('%s is marked Failed but traded on %s. Check it.', r.label, to_char(r.last_traded_on, 'YYYY-MM-DD')),
      'Open'
    );
  end loop;

  -- STEP 71: STRATEGIES STILL LOADED on a Failed account, raised and resolved.
  perform public.failed_account_strategies_check(p_client_id, null);

  -- STEP 71: the database's own flags, resolved when what they say stops being
  -- true (step 67's convention: resolved_at now, no person, a note).
  update public.operational_flags as f
     set status = 'Resolved',
         resolved_at = v_now,
         resolved_by_user_id = null,
         resolution_note = case
           when t.observed_state is distinct from 'breached' then 'Breach cleared: a later reading was not a breach.'
           else 'Account is no longer Active or Payout Hold.'
         end
    from public.trading_accounts as t
   where t.id = f.trading_account_id
     and t.client_id = p_client_id
     and f.type = 'Breach suspected'
     and f.status = 'Open'
     and (t.observed_state is distinct from 'breached'
          or coalesce(t.status, '') not in ('Active', 'Payout Hold'));

  update public.operational_flags as f
     set status = 'Resolved',
         resolved_at = v_now,
         resolved_by_user_id = null,
         resolution_note = 'Account is no longer Failed.'
    from public.trading_accounts as t
   where t.id = f.trading_account_id
     and t.client_id = p_client_id
     and f.type = 'Failed account traded'
     and f.status = 'Open'
     and t.status is distinct from 'Failed';

  return v_touched;
end;
$function$;

comment on function public.refresh_account_observations(uuid) is
  'Recomputes observed_state, last_close_seen_on, closes_missed, breached_on, breach_reading and observed_at for every trading account of one client from every close of that client (step 65). Since step 71 a breach alone moves no status: an account that becomes breached while Active or Payout Hold gets a Breach suspected flag; it is marked Failed (date_failed, the close''s marker, an audit row naming the evidence, a flag, step 67''s resolve of the five) only when auto_fail_on_breach is on and the client''s last confirm_closes closes on or after breached_on show it missing, or not trading while at least confirm_peer_accounts accounts of other clients traded its strategy family; an account the close failed that trades afterwards is set back to its prior status when auto_reactivate is on (audit row and flag); a Failed account a person failed that trades gets a Failed account traded flag; Strategies still loaded is raised and resolved. Returns the number of account rows written. Called by the step 65 triggers; callable by the service role. Steps 65, 67 and 71.';

-- ---------------------------------------------------------------------------
-- 7. The close's marker on the accounts step 65 already failed, once.
-- ---------------------------------------------------------------------------
do $step71_markers$
declare
  v_marked integer;
  v_prior_from_after integer;
begin
  with latest as (
    select distinct on (a.entity_id)
           a.entity_id as account_id, a.created_at, a.before_data, a.after_data
    from public.audit_logs as a
    where a.entity_type = 'trading_account'
      and a.action = 'trading_account.auto_failed'
      and a.entity_id is not null
    order by a.entity_id, a.created_at desc, a.id desc
  ),
  marked as (
    update public.trading_accounts as t
       set auto_failed_at = l.created_at,
           auto_failed_prior_status = case
             when jsonb_typeof(l.before_data) = 'object'
               and l.before_data ->> 'status' in ('Active', 'Payout Hold') then l.before_data ->> 'status'
             when l.after_data ->> 'previousStatus' in ('Active', 'Payout Hold') then l.after_data ->> 'previousStatus'
             else 'Active'
           end,
           auto_failed_date_set = case
             when jsonb_typeof(l.before_data) = 'object' and l.before_data ? 'dateFailed'
               then jsonb_typeof(l.before_data -> 'dateFailed') = 'null'
             else t.date_failed is not null
               and to_char(t.date_failed, 'YYYY-MM-DD')
                   = coalesce(l.after_data ->> 'breachedOn', to_char(t.breached_on, 'YYYY-MM-DD'))
           end,
           auto_failed_through = coalesce(
             (select d.trading_date from public.daily_imports as d
               where d.client_id = t.client_id
                 and to_char(d.trading_date, 'YYYY-MM-DD') = l.after_data ->> 'breachedOn'
               order by d.id limit 1),
             t.breached_on,
             t.date_failed,
             l.created_at::date)
      from latest as l
     where t.id = l.account_id
       and t.status = 'Failed'
       and t.auto_failed_at is null
       -- The close has not set it back since, and no person has changed it.
       and not exists (
         select 1 from public.audit_logs as b
         where b.entity_type = 'trading_account' and b.entity_id = t.id
           and b.action = 'trading_account.auto_reactivated'
           and b.created_at >= l.created_at)
       and not public.account_status_changed_by_person(t.id, l.created_at)
    returning t.id, (l.before_data ->> 'status') is null as prior_from_after
  )
  select count(*)::integer, count(*) filter (where prior_from_after)::integer
    into v_marked, v_prior_from_after
  from marked;

  raise notice 'step 71: % account(s) the close had already marked Failed now carry its marker (% with the prior status read from the audit row''s after_data)',
    v_marked, v_prior_from_after;
end
$step71_markers$;

-- ---------------------------------------------------------------------------
-- 8. Grants and row level security, restated (step 56's rule).
-- ---------------------------------------------------------------------------
revoke all on function public.refresh_account_observations(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_account_observations(uuid) to service_role;

revoke all on function public.failed_account_strategies_check(uuid, text)
  from public, anon, authenticated;
grant execute on function public.failed_account_strategies_check(uuid, text) to service_role;

-- Reached from security definer code, or fired as triggers: nobody but the
-- owner, not even the service role (step 65 did the same for its helpers).
revoke all on function public.account_observation_money(numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.auto_failed_flag_message(text, jsonb, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.account_status_changed_by_person(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.account_live_samples_failed_strategies()
  from public, anon, authenticated, service_role;
revoke all on function public.trading_accounts_observed_columns_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.account_observation_reading(numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.account_observation_breach(numeric, text, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.account_observations_trigger()
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

revoke all on public.account_live_samples from anon, authenticated;
grant select on public.account_live_samples to authenticated;
alter table public.account_live_samples enable row level security;

-- ---------------------------------------------------------------------------
-- 9. The recompute: every client with at least one close, once, like step
--    65's backfill. This is what sets back the accounts step 65 failed that
--    traded afterwards and raises the flags.
-- ---------------------------------------------------------------------------
do $step71_recompute$
declare
  v_client uuid;
  v_clients integer := 0;
  v_rows integer := 0;
  v_failed integer;
  v_reactivated integer;
  v_suspected integer;
  v_traded integer;
  v_loaded integer;
begin
  select count(*)::integer into v_failed from public.audit_logs where action = 'trading_account.auto_failed';
  select count(*)::integer into v_reactivated from public.audit_logs where action = 'trading_account.auto_reactivated';
  select count(*)::integer into v_suspected from public.operational_flags where type = 'Breach suspected';
  select count(*)::integer into v_traded from public.operational_flags where type = 'Failed account traded';
  select count(*)::integer into v_loaded from public.operational_flags where type = 'Strategies still loaded';

  for v_client in
    select distinct d.client_id from public.daily_imports as d order by 1
  loop
    v_rows := v_rows + public.refresh_account_observations(v_client);
    v_clients := v_clients + 1;
  end loop;

  raise notice 'step 71: refreshed % account(s) across % client(s): % set back to their status before the close failed them, % marked Failed, % Breach suspected, % Failed account traded and % Strategies still loaded flag(s) written',
    v_rows, v_clients,
    (select count(*)::integer from public.audit_logs where action = 'trading_account.auto_reactivated') - v_reactivated,
    (select count(*)::integer from public.audit_logs where action = 'trading_account.auto_failed') - v_failed,
    (select count(*)::integer from public.operational_flags where type = 'Breach suspected') - v_suspected,
    (select count(*)::integer from public.operational_flags where type = 'Failed account traded') - v_traded,
    (select count(*)::integer from public.operational_flags where type = 'Strategies still loaded') - v_loaded;
end
$step71_recompute$;

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 70 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 71 left % table(s) without row level security', n;
  end if;
end $$;
