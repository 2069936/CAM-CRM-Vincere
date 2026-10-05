-- Step 55: the last thing each account said about itself, for the tracker.
--
-- WHY 55 AND NOT 54. Step 54 is claimed by the unmerged draft on
-- dev/deep-export-service-floor (`step_54_deep_export_requests.sql`, where a
-- request for a deep export waits for the machine to come for it). That branch
-- is reviewed and numbered and renumbering it would invalidate its own test,
-- which asserts its number. So this file takes 55 and the gap is deliberate: a
-- database that runs 53 then 55 is correct, and nobody should close the hole.
--
-- WHAT THIS IS FOR.
--
-- The daily close answers "what happened today" at 16:45. Nothing answers "what
-- is happening now". A CAM opening the CRM at 11:00 reads a briefing card that
-- says `$0 today` for every client, because the close has not happened, and a
-- live accounts panel whose numbers come from the last close - which on this
-- book can be twelve days old (src/components/LiveAccountsPanel.jsx:7-13). The
-- desk's own question, which is asked out loud every morning, is smaller than
-- any of that: which accounts are alive, which are running, and roughly how the
-- day is going.
--
-- So the agent samples its accounts every ten minutes and posts them to
-- POST /api/ingest/accounts. This is where that sample lands.
--
-- ONE ROW PER ACCOUNT PER DEVICE, OVERWRITTEN. Not a time series. The traffic
-- light wants the last reading, and the day's trail is a later decision that
-- can be taken without this table changing shape. The arithmetic matters: ~700
-- accounts sampled every ten minutes is ~33,600 rows a day and ~8.4M in a year,
-- and this repository has no retention mechanism anywhere - no pg_cron, no TTL,
-- no prune; every daily capture ever uploaded is still here. Last sample only
-- is a few hundred rows, flat, forever. The unique key on
-- (device_id, account_name) is what makes a re-sample an upsert.
--
-- WHAT IT IS NOT. Not the heartbeat. `heartbeat.js` refuses any key outside
-- HEARTBEAT_KEYS with a 400 and `record_ingest_heartbeat` refuses any error code
-- outside its list, so an agent that put accounts on the heartbeat would silence
-- every heartbeat on the fleet until the CRM caught up - and the heartbeat is
-- the only thing that says a machine is alive, which is the very traffic light
-- this is for. Step 46 wrote that lesson down and this file repeats it: own
-- endpoint, own table, own function, heartbeat vocabulary untouched.
--
-- IT NEVER DELETES WHAT A SAMPLE OMITS, and this is the one place where copying
-- step 46 would have destroyed the feature. Step 46 replaces a device's
-- inventory whole, because a report is a mirror of a folder and a file that
-- left the folder must leave the table. A sample is not a mirror: the AddOn's
-- relevance filter drops an account it considers irrelevant, so an account that
-- goes dark can simply be ABSENT from the next sample. Replace-whole would
-- delete its row at the exact moment it went dark - green, then nothing, which
-- on screen is indistinguishable from "this client has no accounts". The one
-- state the desk most needs to see would be the one state the table cannot
-- hold. So: upsert only, and let the row's own `sampled_at` age say it is dark.
-- Rows still leave, by the bounded device-scoped sweep at the end of the
-- function, on a horizon that is a settings column rather than a constant.
--
-- AN OLDER SAMPLE NEVER OVERWRITES A NEWER ONE. The upsert is conditional on
-- `excluded.sampled_at >= account_live_samples.sampled_at`. Two reports from one
-- device can be in flight at once (a retry that was slow, a service restart),
-- and a tracker whose whole value is freshness must not be walked backwards by
-- the loser of that race. Same discipline as `record_ingest_heartbeat`'s
-- greatest() on last_capture_at.
--
-- `run_state` IS DERIVED HERE, NOT SENT. src/domain/liveAccounts.js:268-269
-- already decides this from a close - running, idle, unmeasured, three states
-- and three words - and step 47 measured why the third one has to exist: across
-- 84 closes on 2026-09-21, 45 of the 46 strategies that actually produced fills
-- carry `enabled = false`, because the close is taken after the desk switches
-- the algos off. A mid-day sample is the only honest reading of `enabled` the
-- desk can get. The column repeats the rule here so the screen does not ship a
-- second copy of it, exactly as step 46 stores `final`.
--
-- IT HAS A FOURTH WORD THAT THE CLOSE DOES NOT NEED, `no_strategies`. A close
-- cannot tell "measured and empty" from "not measured", because by 16:45 the
-- desk has switched the algos off and NinjaTrader has removed them from the
-- account, so every account is empty. A MID-DAY sample can tell them apart and
-- the collector already does: StrategyLiveCount returns (0, 0) for a collection
-- it read and found empty, and (null, null) for one it could not read. Folding
-- those together is what this file shipped with, and the sentence the screen
-- prints for `unmeasured` - "the sample carried no strategy count" - is false
-- about a sample that carried (0, 0). See the column.
--
-- WHY THE BROWSER MAY READ THIS TABLE AND THE INGEST TABLES ARE SHUT.
-- The CAM Overview asks about every client at once. Through a serverless route
-- that is one invocation per client - 37 per refresh on one CAM's book, against
-- a project capped at 12 functions - and through PostgREST under the step 52
-- predicate it is one request and no invocations. So this table deliberately
-- sits OUTSIDE the `ingest%` family: step 52's catalogue loop skips those names
-- because "the ingest tables are already shut to the browser by their own
-- restrictive denials", and a browser-readable `ingest_*` table would make that
-- comment false for the next auditor and permanently opt the table out of step
-- 52's self-healing loop.
--
-- AND WHY A RESTRICTIVE WRITE DENIAL IS NOT OPTIONAL. Step 52's loop A gives
-- every `client_id` table `for all to authenticated using <predicate> with
-- check <predicate>` - read AND WRITE for a CAM's own clients. Re-running step
-- 52 after this file, which is how that migration is designed to pick up tables
-- added later, would therefore hand a CAM the ability to INSERT a row here and
-- paint any of its own accounts green. The restrictive denial below survives
-- that re-run, because step 52 drops only PERMISSIVE policies. It is the thing
-- that makes the traffic light unforgeable, and step 51 exists because exactly
-- this was once possible on app_users.
--
-- AND IT TAKES TWO POLICIES, NOT ONE, BECAUSE `with check` DOES NOT GOVERN
-- DELETE. A single `as restrictive for all ... using (true) with check (false)`
-- refuses INSERT and UPDATE - both of those produce a new row for the check to
-- refuse - and lets DELETE through, because a DELETE has no new row and is
-- judged by `using` alone. Proved in a real Postgres with step 52's loop A
-- policy installed verbatim after this file: INSERT and UPDATE were both refused
-- by name, and `delete ... returning account_name` returned the row and the row
-- was gone. `using (false)` on the `for all` policy is NOT the fix, because
-- `using` is also what SELECT is judged by, and the overview's whole read
-- depends on it. So there is a second restrictive policy below, `for delete`,
-- with `using (false)` - the form step_28, step_45:492 and step_46:268 all use.
--
-- A deletable row is the same wound as a replace-whole upsert, arriving by a
-- different door: an account that goes dark becomes an ABSENT row, and absent on
-- a screen is indistinguishable from "this client has no accounts". The one
-- state the desk most needs to see would be the one state a CAM could erase.
--
-- AND NEITHER A POLICY NOR A DELETE DENIAL REACHES TRUNCATE. Supabase's default
-- privileges on `public` are `grant all` - measured, `anon=arwdDxtm/postgres` and
-- `authenticated=arwdDxtm/postgres` - and TRUNCATE is not subject to row level
-- security at all. Every policy above and below is a statement about which ROWS a
-- session may touch; a TRUNCATE asks none of them and empties the table. So the
-- lockdown further down is `revoke all` then `grant select`, and the revoke is the
-- WHOLE of the control for TRUNCATE, TRIGGER and REFERENCES rather than one layer
-- of two. See the long note beside it for what was measured.
--
-- THE SAME HOLE IS OPEN ON THIRTY-TWO OTHER TABLES, and this file does not close
-- it. Measured across the production database: `authenticated` can TRUNCATE 32 of
-- 37 tables, and the only five it cannot are `app_users` (step 51 revoked it there)
-- and the four `ingest%` tables. Step 55 closes it for its own two tables and no
-- others. That is a KNOWN GAP, not an oversight, and it is written down here so the
-- next reader does not infer from the careful revoke below that the rest of the
-- database is in the same shape. Closing the other 32 is its own migration: it
-- needs a table-by-table reading of what each one's browser path actually requires,
-- and a blanket statement written without that reading would take SELECT off
-- something the CRM reads and break a screen instead of protecting a table.
--
-- EVERY TUNABLE IS A COLUMN, NOT AN ENVIRONMENT VARIABLE. Pedro cannot set one
-- in Vercel; a merge to main is the whole deployment. So the interval, the
-- staleness horizon, the throttle, the retention window and the first agent
-- version that samples are columns on a singleton he edits in the SQL editor.
-- That makes the CHECK constraints the only review a hand edit gets, which is
-- why each one below says what it is protecting and what the bad edit is.
--
-- HARMLESS BEFORE ANY AGENT SENDS ANYTHING. `min_agent_version` seeds NULL,
-- which means "no build samples yet". Nothing on any screen claims a fault for
-- a machine that is not sampling; the panel says, once and quietly, that no
-- collector build sends live samples yet. The day Pedro sets that column is the
-- day a machine below it starts reading "too old to sample", and not before.
--
-- Idempotent. Additive. Back-fills nothing, and drops nothing except one DERIVED
-- column, named and guarded below: a database that ran an earlier copy of this
-- file has a three-word `run_state`, and the block after the table replaces it so
-- that re-running the file actually fixes the sentence it was printing. Every
-- value in that column is recomputed from the two integers the sample carried, so
-- there is no data in it to lose.

begin;

-- ---------------------------------------------------------------------------
-- The tunables.
--
-- Singleton by construction, in the shape step 45 gave ingest_admission_settings
-- (`id boolean primary key default true` plus a CHECK that it is true): one row,
-- addressable without knowing its id, and a second one impossible.
-- ---------------------------------------------------------------------------
create table if not exists public.account_tracker_settings (
  id boolean primary key default true,
  -- HOW OFTEN A MACHINE SHOULD SAMPLE, in seconds, handed back to the agent in
  -- the reply to every report so the fleet is retunable from the SQL editor
  -- without a redeploy.
  --
  -- WHY THE FLOOR IS 300 AND NOT 1. These VPSs run NinjaTrader against live
  -- prop firm accounts during market hours, and the capture runs on
  -- NinjaTrader's own WPF dispatcher - the Control Center UI thread - holding
  -- the platform's `Account.All` and `account.Strategies` locks while it reads
  -- (collector NinjaTraderFacade.cs:94-96, :30, whose own comment warns that
  -- holding a platform lock on the dispatcher thread "is how a capture stops
  -- being something that merely fails and starts being something that can stall
  -- the terminal it is reading"). The agent's written budget for a convenience
  -- read is ONE extra intraday capture a day, never retried
  -- (CaptureScheduler.cs:123-212). Ten minutes is already ~39 reads a session.
  -- A hand edit to 30 seconds would be ~780, and the thing it would interfere
  -- with is the desk's live trading. The floor is the guard-rail on that edit.
  sample_interval_seconds integer not null default 600,
  -- WHEN A SAMPLE STOPS COUNTING AS CURRENT, which is what paints an account
  -- "silent" on the screen.
  --
  -- WHY IT IS NOT 600. The fleet view marks a device offline after ten minutes
  -- without a heartbeat (src/domain/autoCollectionFleet.js:206) at a ONE minute
  -- beat - a 10x margin. Reusing that vocabulary is right; reusing that number
  -- here is not. A ten minute horizon against a ten minute interval puts every
  -- healthy sample on the boundary, so ordinary jitter - a slow close, one
  -- addon_unavailable, a service restart - paints a live account silent. 1500
  -- is one whole missed sample plus five minutes of slack.
  stale_sample_seconds integer not null default 1500,
  -- The server side throttle, in the shape record_ingest_heartbeat's
  -- p_min_interval_seconds takes (step 41). A buggy agent in a tight loop costs
  -- one short read-only transaction per report instead of a write storm during
  -- market hours.
  min_report_interval_seconds integer not null default 60,
  max_accounts_per_report integer not null default 100,
  -- HOW LONG A SILENT ACCOUNT'S LAST READING STAYS. This is the only way a row
  -- ever leaves this table, and it is a window rather than a job because the
  -- row has to outlive the thing it is reporting: an account that went dark on
  -- Friday must still be on the screen on Monday morning, saying when it went.
  retention_days integer not null default 7,
  -- THE FIRST AGENT BUILD THAT SAMPLES, or NULL for "none does yet".
  --
  -- NULL is the shipping value and it is what makes this migration inert: with
  -- no version named, no machine is behind, and the screen says the neutral
  -- true thing instead of putting "update required" next to thirty client
  -- names on the day this merges. Pedro sets it once, by hand, when the agent
  -- that samples is actually on a tag.
  min_agent_version text,
  updated_at timestamptz not null default now(),
  constraint account_tracker_settings_singleton check (id),
  constraint account_tracker_settings_interval_check
    check (sample_interval_seconds between 300 and 3600),
  -- THE EDIT THIS CONSTRAINT EXISTS TO REFUSE is setting both of these to the
  -- same number, which reads as obviously consistent and would make a correctly
  -- sampling fleet flicker silent. The horizon must clear one whole missed
  -- sample, so it is at least twice the interval.
  constraint account_tracker_settings_stale_check
    check (stale_sample_seconds >= sample_interval_seconds * 2
      and stale_sample_seconds <= 86400),
  -- A throttle longer than the interval would refuse every sample the fleet
  -- sends and the whole screen would read silent while every machine was
  -- working perfectly. Bounded by the interval itself, not by a constant, so
  -- the pair cannot be edited into that state one column at a time.
  constraint account_tracker_settings_throttle_check
    check (min_report_interval_seconds between 1 and sample_interval_seconds),
  constraint account_tracker_settings_accounts_check
    check (max_accounts_per_report between 1 and 500),
  constraint account_tracker_settings_retention_check
    check (retention_days between 1 and 90),
  -- A version is compared component by component by compareVersions in
  -- src/domain/autoCollectionFleet.js, which reads a non-numeric part as 0. So
  -- `1.2` would compare equal to `1.2.0` and `v1.2.0` would compare as 0.0.0 -
  -- below every agent in the field, which silently tells the whole fleet it is
  -- up to date and the tracker is simply never expected of anybody. Three
  -- numeric components or nothing.
  constraint account_tracker_settings_agent_version_check
    check (min_agent_version is null or min_agent_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

insert into public.account_tracker_settings (id) values (true)
on conflict (id) do nothing;

comment on table public.account_tracker_settings is
  'Singleton tunables for the account tracker. Edited by hand in the SQL editor; the CHECK constraints are the review. min_agent_version NULL means no collector build samples yet, which is the inert state.';

-- ---------------------------------------------------------------------------
-- The last sample.
-- ---------------------------------------------------------------------------
create table if not exists public.account_live_samples (
  id uuid primary key default gen_random_uuid(),
  -- A sample is what one machine saw and means nothing without it, so this
  -- cascades, the way step 46's report does and unlike ingest_batches, which
  -- restricts because a batch is evidence.
  device_id uuid not null references public.ingest_devices(id) on delete cascade,
  -- Denormalised from the device, for the same reason step 46 does it: this is
  -- the column every policy and every screen query keys on, and resolving it
  -- through the device on every read would put ingest_devices - which the
  -- browser cannot see - in the middle of the browser's own query.
  client_id uuid not null references public.clients(id) on delete cascade,
  account_name text not null,
  connection_name text,
  -- THE TRAFFIC LIGHT READS THIS, not `status`. A boolean cannot be a word the
  -- CRM has not met, and "is this account connected to its broker" is the
  -- question the desk is actually asking.
  connected boolean not null,
  -- NinjaTrader's own ConnectionStatus, verbatim, for the tooltip. Shape-checked
  -- rather than enumerated: an unknown word here is a newer platform, and a
  -- sample refused for one word would hide every other account in it, which is
  -- the heartbeat's trap. Shape-checked and NOT free text, because this reaches
  -- a screen from a machine the CRM does not control.
  status text,
  realized_pnl numeric,
  unrealized_pnl numeric,
  total_pnl numeric,
  -- The two integers that answer "which are running", and the pair carries THREE
  -- facts, not two. NULL means the sample did not carry a count at all - nobody
  -- looked. (0, 0) means the VPS looked and the account has no strategies loaded.
  -- Anything else is a count. The collector is explicit about this and says so in
  -- StrategyLiveCount: `Tally` returns (0, 0) for a collection it read
  -- successfully and found empty, "so the wire says which of the two happened".
  -- run_state below keeps all three apart; it used to fold the first two together.
  strategy_count integer,
  enabled_strategy_count integer,
  -- The machine's own clock at the moment it read the accounts. Every staleness
  -- judgement on every screen is made from THIS, never from reported_at: a
  -- report that spent twelve minutes inside a retry must not arrive looking
  -- fresh.
  sampled_at timestamptz not null,
  reported_at timestamptz not null default now(),
  /* FOUR STATES, FOUR WORDS, BECAUSE THE PAIR OF COUNTS CARRIES FOUR FACTS.
   *
   * The first three are src/domain/liveAccounts.js:268-269's own vocabulary,
   * printed from a close. `unmeasured` is not `idle`: 121 of 457 accounts on this
   * book carry no strategy row at all, and "nobody looked" and "the desk switched
   * everything off" lead to opposite actions.
   *
   * THE FOURTH ONE IS NEW HERE AND IT IS NOT AN EDGE CASE. This column shipped
   * with `strategy_count = 0` folded into `unmeasured`, so an account the VPS HAD
   * measured and found empty read the same as an account nobody had measured -
   * and the sentence the screen prints for `unmeasured` is "the sample carried no
   * strategy count", which is FALSE about a sample that carried (0, 0). It is not
   * a rare row either: the agent's own measurement on one machine in one day is
   * "14 at 09:21, 9 at 16:30, 0 at 18:28", because NinjaTrader removes a
   * strategy from the account when it is disabled. Every account on the fleet
   * reports (0, 0) overnight and before the open, so a genuinely flat desk read
   * "2 with no strategy count" on the briefing card every morning.
   *
   * `idle` is not the answer either: its sentence is "strategies are loaded and
   * every one of them is switched off", and nothing is loaded. Four facts, four
   * words, four sentences, each true of exactly one of them. */
  run_state text generated always as (
    case
      when strategy_count is null or enabled_strategy_count is null then 'unmeasured'
      when strategy_count = 0 then 'no_strategies'
      when enabled_strategy_count > 0 then 'running'
      else 'idle'
    end
  ) stored,
  constraint account_live_samples_device_account_unique unique (device_id, account_name),
  constraint account_live_samples_account_name_check
    check (account_name = btrim(account_name) and length(account_name) between 1 and 64),
  constraint account_live_samples_connection_name_check
    check (connection_name is null
      or (connection_name = btrim(connection_name) and length(connection_name) between 1 and 64)),
  constraint account_live_samples_status_check
    check (status is null or status ~ '^[A-Za-z][A-Za-z0-9 _-]{0,31}$'),
  -- The pair is sent together or not at all. Half a count reaches run_state as a
  -- NULL on one side, which answers `unmeasured` - "nobody looked" - about an
  -- account somebody did look at, or, if the NULL were on the other side,
  -- `no_strategies` about an account that has them. The pair is the measurement.
  constraint account_live_samples_counts_check
    check ((strategy_count is null) = (enabled_strategy_count is null)
      and (strategy_count is null
        or (strategy_count >= 0
          and enabled_strategy_count >= 0
          and enabled_strategy_count <= strategy_count))),
  -- NUMERIC IS UNBOUNDED AND NUMERIC ACCEPTS 'NaN'. Both of those reach a sum
  -- on a screen. `abs(x) <= 1e12` refuses NaN too, because every comparison
  -- against NaN is false, and one NaN in this table would turn a client's whole
  -- live total into NaN on the briefing card. A trillion is already four orders
  -- of magnitude past anything this desk trades.
  constraint account_live_samples_money_check
    check ((realized_pnl is null or abs(realized_pnl) <= 1e12)
      and (unrealized_pnl is null or abs(unrealized_pnl) <= 1e12)
      and (total_pnl is null or abs(total_pnl) <= 1e12))
);

-- ---------------------------------------------------------------------------
-- THE ONE THING IN THIS FILE THAT CHANGES A COLUMN THAT MAY ALREADY EXIST, and
-- it is here because `create table if not exists` does NOTHING when the table is
-- there. An earlier copy of step 55 created run_state with three arms and folded
-- "measured and empty" into "nobody measured". A database that ran that copy
-- would keep printing the false sentence forever, and re-running the file - which
-- is how Pedro checks whether a step landed - would not fix it.
--
-- SO IT REPLACES ONE DERIVED COLUMN AND NOTHING ELSE. run_state holds no data:
-- every value in it is computed from strategy_count and enabled_strategy_count,
-- which ARE the data and are not touched. Dropping and re-adding it recomputes
-- each row from what the sample actually carried, so nothing is lost and nothing
-- is guessed. The column moves to the end of the column order, which no caller
-- notices: the function, the browser read and every test name their columns.
--
-- GUARDED THREE WAYS so it can only fire on the thing it is for - the table must
-- exist, run_state must exist and be stored-generated, and its expression must
-- not already mention the new word. After it has fired once, re-running is a
-- no-op, which is the whole point.
-- ---------------------------------------------------------------------------
do $account_tracker_run_state$
declare
  v_expression text;
begin
  select pg_catalog.pg_get_expr(def.adbin, def.adrelid)
    into v_expression
  from pg_catalog.pg_attrdef as def
  join pg_catalog.pg_attribute as att
    on att.attrelid = def.adrelid and att.attnum = def.adnum
  where def.adrelid = 'public.account_live_samples'::regclass
    and att.attname = 'run_state'
    and att.attgenerated = 's'
    and not att.attisdropped;

  if v_expression is not null and position('no_strategies' in v_expression) = 0 then
    alter table public.account_live_samples drop column run_state;
    alter table public.account_live_samples
      add column run_state text generated always as (
        case
          when strategy_count is null or enabled_strategy_count is null then 'unmeasured'
          when strategy_count = 0 then 'no_strategies'
          when enabled_strategy_count > 0 then 'running'
          else 'idle'
        end
      ) stored;
    raise notice 'step 55 recomputed run_state: an earlier copy of this file folded a measured-and-empty account into unmeasured';
  end if;
end
$account_tracker_run_state$;

-- The screens ask by client: the overview reads every assigned client's rows in
-- one request, the client workspace reads one client's.
create index if not exists idx_account_live_samples_client
  on public.account_live_samples (client_id, account_name);

comment on table public.account_live_samples is
  'The LAST sample of each account on each paired VPS, overwritten. Not a time series. Rows leave three ways and this list is the whole of it: the retention sweep in record_account_live_sample, the cascade from public.clients, and the cascade from public.ingest_devices. The cascades are right, a client or a device that no longer exists has no accounts to track, and they are named here because the first version of this comment said rows leave ONLY by the sweep, which a reviewer disproved by deleting a client as a CAM and watching the rows go with it. A sample that omits an account never deletes it, because an account that goes dark is absent from the sample and absence is the signal.';

-- ---------------------------------------------------------------------------
-- record_account_live_sample: the reading, upserted.
--
-- TWO PASSES, AND THE ORDER IS THE POINT. Every item is validated before any
-- row moves and before the throttle is consulted. Validating after the throttle
-- would answer a malformed payload with "throttled, thank you" for as long as a
-- broken agent kept retrying inside the window, which is how a payload bug
-- becomes invisible. The function is one statement from the caller's side, so a
-- raise anywhere in it rolls the whole thing back.
--
-- NO `for update` ON THE DEVICE ROW. Step 46 takes it because its delete and
-- its upserts must not interleave; there is no delete-what-is-absent here, so
-- there is nothing to serialise and the lock would only contend with
-- record_ingest_heartbeat, which takes the same row every sixty seconds. The
-- per-row upsert does its own locking and the sampled_at guard makes the
-- outcome of a race deterministic rather than merely safe.
--
-- 22023 for a malformed sample, P0001 for a device that is not active: the same
-- two codes the heartbeat and the quarantine functions raise, so the endpoint
-- maps them the same way, 400 and 401.
-- ---------------------------------------------------------------------------
create or replace function public.record_account_live_sample(
  p_device_id uuid,
  p_sampled_at timestamptz,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_device public.ingest_devices;
  v_settings public.account_tracker_settings;
  v_now timestamptz := clock_timestamp();
  v_item jsonb;
  v_names text[] := array[]::text[];
  v_name text;
  v_last_reported timestamptz;
  v_recorded integer := 0;
  v_removed integer := 0;
begin
  select settings.* into v_settings
  from public.account_tracker_settings as settings
  where settings.id;

  if not found then
    -- The seed insert is in this file, so a missing row means somebody deleted
    -- it. A tracker sample is not worth a refused report, so the defaults in
    -- the column definitions above stand in rather than raising.
    v_settings.sample_interval_seconds := 600;
    v_settings.stale_sample_seconds := 1500;
    v_settings.min_report_interval_seconds := 60;
    v_settings.max_accounts_per_report := 100;
    v_settings.retention_days := 7;
    v_settings.min_agent_version := null;
  end if;

  if p_device_id is null
    or p_sampled_at is null
    or p_sampled_at > v_now + interval '5 minutes'
    or p_accounts is null
    or jsonb_typeof(p_accounts) <> 'array'
    or jsonb_array_length(p_accounts) > v_settings.max_accounts_per_report then
    raise exception 'INVALID_ACCOUNT_SAMPLE'
      using errcode = '22023';
  end if;

  select device.* into v_device
  from public.ingest_devices as device
  where device.id = p_device_id;

  if not found
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'INVALID_INGEST_DEVICE'
      using errcode = 'P0001';
  end if;

  -- PASS ONE: validate everything, write nothing.
  for v_item in select value from jsonb_array_elements(p_accounts) loop
    begin
      -- coalesce on every typeof: a missing key reads as SQL null, and a null
      -- in an OR chain is not true, so without it a missing field would pass.
      if jsonb_typeof(v_item) <> 'object'
        or coalesce(jsonb_typeof(v_item -> 'accountName'), '') <> 'string'
        or coalesce(jsonb_typeof(v_item -> 'connected'), '') <> 'boolean'
        or coalesce(jsonb_typeof(v_item -> 'connectionName'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(v_item -> 'status'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(v_item -> 'realizedPnl'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'unrealizedPnl'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'totalPnl'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'strategyCount'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(v_item -> 'enabledStrategyCount'), 'null') not in ('number', 'null') then
        raise exception 'malformed item';
      end if;
      v_name := v_item ->> 'accountName';
      if v_name is distinct from btrim(v_name)
        or length(v_name) not between 1 and 64
        -- The same account twice is not a sample of a terminal, where an
        -- account has one name, and it would make the upsert's outcome depend
        -- on array order.
        or v_name = any (v_names) then
        raise exception 'malformed item';
      end if;
    exception when others then
      raise exception 'INVALID_ACCOUNT_SAMPLE'
        using errcode = '22023';
    end;
    v_names := v_names || v_name;
  end loop;

  -- THE THROTTLE, after validation and before any write. A read-only answer, so
  -- a machine sampling far too often costs one index lookup rather than a write
  -- storm in the minute the market is moving.
  select max(sample.reported_at) into v_last_reported
  from public.account_live_samples as sample
  where sample.device_id = p_device_id;

  if v_last_reported is not null
    and v_now < v_last_reported + make_interval(secs => v_settings.min_report_interval_seconds) then
    return jsonb_build_object(
      'device_id', p_device_id,
      'recorded', 0,
      'removed', 0,
      'throttled', true,
      'sample_interval_seconds', v_settings.sample_interval_seconds,
      'stale_sample_seconds', v_settings.stale_sample_seconds,
      'min_agent_version', v_settings.min_agent_version
    );
  end if;

  -- PASS TWO: the upsert.
  for v_item in select value from jsonb_array_elements(p_accounts) loop
    insert into public.account_live_samples (
      device_id, client_id, account_name, connection_name, connected, status,
      realized_pnl, unrealized_pnl, total_pnl,
      strategy_count, enabled_strategy_count, sampled_at, reported_at
    ) values (
      p_device_id,
      v_device.client_id,
      v_item ->> 'accountName',
      v_item ->> 'connectionName',
      (v_item ->> 'connected')::boolean,
      v_item ->> 'status',
      (v_item ->> 'realizedPnl')::numeric,
      (v_item ->> 'unrealizedPnl')::numeric,
      (v_item ->> 'totalPnl')::numeric,
      (v_item ->> 'strategyCount')::integer,
      (v_item ->> 'enabledStrategyCount')::integer,
      p_sampled_at,
      v_now
    )
    on conflict (device_id, account_name) do update
    set client_id = excluded.client_id,
        connection_name = excluded.connection_name,
        connected = excluded.connected,
        status = excluded.status,
        realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl,
        total_pnl = excluded.total_pnl,
        strategy_count = excluded.strategy_count,
        enabled_strategy_count = excluded.enabled_strategy_count,
        sampled_at = excluded.sampled_at,
        reported_at = excluded.reported_at
    -- An older reading never overwrites a newer one. Without this, the loser of
    -- a race between two in-flight reports from one machine walks the tracker
    -- backwards, and freshness is the only thing this table sells.
    where excluded.sampled_at >= public.account_live_samples.sampled_at;
    v_recorded := v_recorded + 1;
  end loop;

  -- THE ONLY WAY A ROW LEAVES. Device-scoped and bounded by a settings column,
  -- so an account that goes dark stays on the screen for the window the desk
  -- chose and the table still cannot grow without limit. Deliberately NOT a
  -- delete of what this sample omitted: see the header.
  with swept as (
    delete from public.account_live_samples as sample
    where sample.device_id = p_device_id
      and sample.sampled_at < v_now - make_interval(days => v_settings.retention_days)
    returning 1
  )
  select count(*) into v_removed from swept;

  return jsonb_build_object(
    'device_id', p_device_id,
    'recorded', v_recorded,
    'removed', v_removed,
    'throttled', false,
    'sample_interval_seconds', v_settings.sample_interval_seconds,
    'stale_sample_seconds', v_settings.stale_sample_seconds,
    'min_agent_version', v_settings.min_agent_version
  );
end;
$function$;

revoke all on function public.record_account_live_sample(uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_account_live_sample(uuid, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- READ: step 52's predicate, verbatim, including the sub-select wrappers. Step
-- 52's own header calls an unwrapped call "a correctness requirement wearing a
-- performance costume": wrapped, Postgres hoists it to an InitPlan and runs it
-- once per query; bare, it runs once per row. This table is small today, so the
-- bare form would pass every test and every reading.
--
-- WRITE: nobody signed in, ever. Only the ingest route, on the service role,
-- which is BYPASSRLS. RESTRICTIVE so that it is AND'd with whatever permissive
-- policy exists - including the `for all ... with check <predicate>` one a
-- re-run of step 52 will install here, which would otherwise let a CAM insert
-- a row claiming any of its own accounts is green.
--
-- Step 53's `clients_i_created` arm is not needed: a client with no paired VPS
-- has no device, and a client with no device has no samples.
-- ---------------------------------------------------------------------------
alter table public.account_live_samples enable row level security;
alter table public.account_tracker_settings enable row level security;

-- ---------------------------------------------------------------------------
-- AND THE GRANT, WHICH IS A SECOND LAYER AND NOT A RESTATEMENT OF THE FIRST.
--
-- Supabase's default privileges on `public` are `grant all`, not the four verbs a
-- reader expects. Measured on this project:
--
--   default privileges in schema public:
--     anon=arwdDxtm/postgres   authenticated=arwdDxtm/postgres
--
-- a INSERT, r SELECT, w UPDATE, d DELETE, D TRUNCATE, x REFERENCES, t TRIGGER,
-- m MAINTAIN. Eight, and `revoke insert, update, delete` - which is what this file
-- shipped with - takes three. So both new tables handed `anon` and `authenticated`
-- TRUNCATE, TRIGGER, REFERENCES and MAINTAIN, and TRUNCATE is the one that matters:
--
--   TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY AT ALL. Every policy below, and
--   every policy step 52 and step 53 installed, is a statement about which ROWS a
--   session may touch. A TRUNCATE asks none of them. It empties the table. So the
--   restrictive denials are not a second layer here, the way they are for DELETE -
--   there IS no second layer for TRUNCATE, and the revoke is the whole of it.
--
-- Measured against this file as it shipped, with the default privileges set the way
-- Supabase sets them, as a signed-in CAM on its own assigned client:
--
--   account_live_samples ACL: anon=rDxtm/postgres,authenticated=rDxtm/postgres
--   gray truncates account_live_samples     -> (no error - it went through)
--   rows in account_live_samples after:     <empty>
--   gray truncates account_tracker_settings -> (no error - it went through)
--   settings rows after:                    0
--   anon truncates account_live_samples     -> (no error - it went through)
--   gray creates a trigger on the table     -> (no error - it went through)
--
-- That is step 51's lesson arriving a fourth time. Its header is the instruction:
-- "may only SELECT" has to be TRUE and not NEARLY TRUE.
--
-- AND IT IS `revoke all` RATHER THAN THE SIX VERBS NAMED, which is a deliberate
-- departure from step 51's form and the reason is step 51 itself. Enumerating
-- leaves whatever the list forgot, and the list already forgot one: PostgreSQL 17
-- added MAINTAIN, so `revoke insert, update, delete, truncate, trigger, references`
-- leaves `MAINTAIN,SELECT` behind - measured - and app_users carries that today.
-- `revoke all` then `grant select` says the intended thing instead of a list that
-- has to be revisited every time PostgreSQL adds a letter, needs no version-gated
-- keyword to be written here, and leaves an ACL that can be ASSERTED as a
-- complement - exactly SELECT and nothing else - rather than one privilege at a
-- time. After this file: anon=r/postgres,authenticated=r/postgres.
--
-- THE OTHER THIRTY-TWO TABLES. This closes the hole for these two only. Measured
-- across the whole production database: `authenticated` can TRUNCATE 32 of 37
-- tables, and the only five it cannot are app_users (step 51) and the four ingest
-- tables. That is a known gap and not an oversight, and it is not this file's to
-- close - a blanket revoke across every existing table is its own migration with
-- its own reading of what each table's browser path actually needs. Whoever reads
-- this next: the gap is real, it is measured, and it is still open.
--
-- The two layers below still fail in different directions, which is why both are
-- here for the verbs RLS does reach:
--
--   * A RESTRICTIVE policy cannot make a DELETE RAISE. For DELETE, `using` is a
--     FILTER: `using (false)` means no row is visible to delete, so the statement
--     affects nothing and says nothing. Correct, and silent. A revoked privilege
--     answers `permission denied for table account_live_samples`, which is a thing
--     a person can see in a log.
--   * A revoked privilege is not conditional on any policy existing, being
--     RESTRICTIVE, or naming the right verb - the three things that went wrong
--     here once already.
--
-- SELECT STAYS, on both tables, and that is the whole point of the pair: the CAM
-- Overview reads account_live_samples directly under step 52's predicate - one
-- PostgREST request for a whole book, no serverless invocations - and the screens
-- read stale_sample_seconds so that the number is not copied into JavaScript.
-- Revoking SELECT would take the feature away. It is granted back on the line
-- after the revoke, and the order matters: the other way round grants nothing.
--
-- The service role is unaffected: its grants are separate and it is BYPASSRLS, so
-- the ingest route keeps writing exactly as before. The function is SECURITY
-- DEFINER and runs as the owner, so its own upsert and its retention sweep are
-- unaffected too.
--
-- Idempotent: revoking a privilege that is already absent is a no-op, and the
-- grant that follows is the same grant every time.
-- ---------------------------------------------------------------------------
revoke all on public.account_live_samples from anon, authenticated;
revoke all on public.account_tracker_settings from anon, authenticated;
grant select on public.account_live_samples to anon, authenticated;
grant select on public.account_tracker_settings to anon, authenticated;

do $account_tracker_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_samples'
      and policyname = 'cam sees its own clients'
  ) then
    create policy "cam sees its own clients"
      on public.account_live_samples
      for select
      to authenticated
      using ((select public.is_manager())
        or client_id in (select public.assigned_client_ids()));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_samples'
      and policyname = 'account_live_samples deny browser writes'
  ) then
    create policy "account_live_samples deny browser writes"
      on public.account_live_samples
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  /* AND THE SECOND HALF OF THAT DENIAL, which cannot be folded into the policy
     above. `with check (false)` refuses INSERT and UPDATE because both produce a
     new row for the check to refuse; a DELETE produces none and is judged by
     `using` alone, which has to stay `true` there because `using` is also what
     SELECT is judged by. So DELETE gets its own restrictive policy with
     `using (false)`, the form step_28, step_45 and step_46 all use.

     Without it, the first re-run of step 52 - which is how that migration picks
     up tables added after it - installs a permissive `for all` with step 52's
     predicate as its `using`, and a CAM can delete its own clients' rows. An
     account that goes dark is already an absent row in the next sample; a CAM
     able to make a row absent is a CAM able to erase the one state this table
     exists to hold. */
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_live_samples'
      and policyname = 'account_live_samples deny browser deletes'
  ) then
    create policy "account_live_samples deny browser deletes"
      on public.account_live_samples
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;

  -- The settings row is desk tuning and names no client, so it is readable by
  -- anyone signed in - the same category step 52 leaves open for cam_profiles
  -- and the SOP tables. The screens need stale_sample_seconds to decide what
  -- "silent" means, and a second copy of that number in JavaScript is a second
  -- thing to keep in step with the fleet.
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_tracker_settings'
      and policyname = 'anyone signed in reads the tracker settings'
  ) then
    create policy "anyone signed in reads the tracker settings"
      on public.account_tracker_settings
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_tracker_settings'
      and policyname = 'account_tracker_settings deny browser writes'
  ) then
    create policy "account_tracker_settings deny browser writes"
      on public.account_tracker_settings
      as restrictive
      for all
      to anon, authenticated
      using (true)
      with check (false);
  end if;

  /* The same second half for the tunables. This table has no `client_id`, so
     step 52's loop A never reaches it - but deleting the singleton is how every
     tunable on this feature reverts to the literals in the function body at
     once, silently, and the gap is the same gap, so it is closed the same way
     rather than left to depend on a loop's exclusion list staying what it is. */
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'account_tracker_settings'
      and policyname = 'account_tracker_settings deny browser deletes'
  ) then
    create policy "account_tracker_settings deny browser deletes"
      on public.account_tracker_settings
      as restrictive
      for delete
      to anon, authenticated
      using (false);
  end if;
end
$account_tracker_policies$;

commit;

-- What this leaves: two new tables, both with row level security, and no table
-- in public open. The same check steps 43, 44, 45 and 46 end with, for the same
-- reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 55 left % table(s) without row level security', n;
  end if;
end $$;
