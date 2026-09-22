-- Step 47: whether a strategy RAN that day, stored on the row.
--
-- WHY THIS EXISTS.
--
-- `strategy_snapshots.enabled` is the state of a checkbox at the moment the
-- export was taken, and the exports are taken after the desk switches the algos
-- off. On 2026-09-21, across 84 closes: 438 strategy rows, 543 executions, 46
-- distinct (close, strategy) pairs produced fills, and 45 of those 46 carry
-- `enabled = false`. Measured over the stored book (3,805 strategy rows across
-- 516 closes), the two answers part company on 220 closes: 1,517 rows are
-- enabled, 2,528 ran, and 261 closes carry no enabled row at all while 207 of
-- them ran something.
--
-- Every screen that asked the checkbox was therefore reading the export clock
-- and calling it a quiet desk. The rule that answers it properly has existed in
-- src/domain/comboPerformance.js since the Stack Playbook was built, and only
-- the Stack Playbook used it. It now lives in src/domain/strategyRan.js, the
-- ingest applies it while the day's fills are in hand, and these two columns
-- are where the answer is kept so that a reader does not have to load 13.5 MB
-- of executions to ask a yes or no question.
--
-- THE RULE, one row against its own account's fills, strongest evidence first:
--
--   enabled   the grid still had it switched on when the export was taken
--   fills     that account's fills name its family that day
--   realized  the grid reported a non-zero realized on a row it had switched off
--   none      none of the above
--
-- `ran` is `ran_basis <> 'none'`. Both are nullable with no default, and that
-- is deliberate: NULL means nobody has answered this row yet, which is what
-- every row says until the backfill below runs, and the app falls back to the
-- answer it gave before this step existed. A default of false would be the
-- claim "this algorithm did not trade" made about rows nobody has looked at,
-- which is the substitution step 37 exists to refuse.
--
-- NO CHECK CONSTRAINT ON ran_basis, for step 38's reason: a constraint here is
-- enforced against every writer including ones that are not this app, and the
-- cost of getting its allowed list wrong is a rejected write on a close. The
-- four values are the product's, pinned by test (src/domain/strategyRan.js
-- exports RAN_BASES and validates on the way in: an unrecognised value reads as
-- "no stored answer" and the rule is applied instead, so junk degrades into
-- today's behaviour rather than onto a screen).
--
-- WHY THE BACKFILL IS A SECOND STATEMENT.
--
-- There are 14,514 strategy rows on production and the instance they sit on has
-- answered one-row reads in twenty seconds while eight people were signing in.
-- One UPDATE over the table would hold row locks on all 14,514 for as long as
-- that takes. So the backfill is a loop over ONE CLOSE AT A TIME with a COMMIT
-- between closes, and a procedure cannot COMMIT inside the transaction that is
-- running this file. Run the file, then run:
--
--   call public.backfill_strategy_ran_all();
--
-- It is safe to run twice, safe to interrupt, and safe to resume: it only ever
-- looks for rows where `ran is null`, and re-answering a close writes nothing
-- when the answer has not changed. If your client wraps every statement in a
-- transaction, call the one-batch function in a loop instead, until it returns
-- 0:  select public.backfill_strategy_ran(2000);

alter table public.strategy_snapshots
  add column if not exists ran boolean;

alter table public.strategy_snapshots
  add column if not exists ran_basis text;

comment on column public.strategy_snapshots.ran is
  'Did this algorithm run on this close. NOT `enabled`, which is the state of a checkbox at export time on exports taken after the desk switches the algos off: on the stored book 1,517 rows are enabled and 2,528 ran. Written at ingest by src/domain/strategyRan.js, which decides it from the row''s own account fills, and read back by every screen that asks whether an algorithm worked that day. NULL means nobody has answered this row yet — never "it did not trade"; readers fall back to the rule over whatever evidence they hold.';

comment on column public.strategy_snapshots.ran_basis is
  'Why `ran` says what it says: enabled (the grid still had it switched on), fills (this account''s fills name its family that day), realized (the grid reported a non-zero realized on a row it had switched off), or none. Stored because the evidence is the difference between "the desk was flat" and "the export ran late", and a screen that cannot say which cannot be argued with. Derived figures are not a basis: step 37''s `derived_realized` is worked out FROM the fills, so a row carrying one is already answered `fills`.';

-- What the screens filter on: the rows of a close that ran. 2,528 of the book's
-- 3,805 rows, so the partial index is about two thirds of the table — it earns
-- its place when the per-close fetch replaces the whole-table login read, which
-- is the fetch this column exists to make possible.
create index if not exists idx_strategy_snapshots_import_ran
  on public.strategy_snapshots (daily_import_id) where ran;

-- RLS: strategy_snapshots has had it since step 43, with the `authenticated
-- full access` policy. Columns inherit the table's policy, so there is nothing
-- to open and nothing here closes. Re-asserted rather than assumed, and only
-- where the policy that makes it survivable is already there: enabling RLS on a
-- table with no policy would lock the app out of its own strategy rows.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'strategy_snapshots'
  ) then
    execute 'alter table public.strategy_snapshots enable row level security';
  end if;
end $$;

-- THE FAMILY OF A STRATEGY NAME, in SQL, for the backfill only.
--
-- This mirrors familyFromStrategyName in src/domain/strategyRan.js, which is
-- strategyFamilyOf (drop the grid index prefix, drop the trailing version)
-- followed by `-PF` -> `_PF`. Two copies of an identity rule is how IFSP_PF
-- ended up folded into IFSP on one screen and kept apart on another, so this
-- one is bounded on purpose: it answers ONLY the rows that already exist, once,
-- and every row written from today on carries the JS answer instead. The two
-- regexes are the JS ones, differing only where Postgres has no non-capturing
-- group: step 47's test reads them out of strategyFamily.js and fails if either
-- side changes without the other.
--
-- Checked against the JS on the stored book: the function reproduces
-- `strategy_snapshots.strategy_family` on all 3,805 rows, and answers the same
-- as familyFromStrategyName on all 39 distinct strategy and fill names in it,
-- plus the shapes that break a naive regex (a two-digit grid index, a lower
-- case `-pf`, a three-part version, a family with a space in it, a name with
-- no version at all, and the empty string).
create or replace function public.strategy_family_key(p_strategy_name text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select case
    when base.family = '' then null
    when base.family ~ '^[A-Za-z0-9]+-[Pp][Ff]$' then upper(regexp_replace(base.family, '-[Pp][Ff]$', '_PF'))
    else base.family
  end
  from (
    select btrim(regexp_replace(
      regexp_replace(btrim(coalesce(p_strategy_name, '')), '^\d+\s*-\s*', ''),
      '\s*-\s*\d+(\.\d+)+\s*$', ''
    )) as family
  ) as base;
$function$;

-- ONE CLOSE, ANSWERED. Returns the number of rows it wrote.
--
-- The fills are matched per ACCOUNT, by trading_account_id, which is exactly
-- how the app matches them: src/domain/supabaseStore.js gives both a strategy
-- row and an execution their account name from that column, so a row with no
-- account (61 of the book's 3,805) matches no fills here and matched none in
-- the app either. A close is a few dozen rows, so this locks a few dozen rows.
--
-- Writing only what changes is what makes it re-runnable: a second pass over an
-- answered close updates nothing and reports 0.
create or replace function public.recompute_strategy_ran(p_daily_import_id uuid)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_written integer;
begin
  with fills as (
    select distinct
      execution.trading_account_id,
      public.strategy_family_key(execution.strategy_name) as family
    from public.executions as execution
    where execution.daily_import_id = p_daily_import_id
      and execution.trading_account_id is not null
      and public.strategy_family_key(execution.strategy_name) is not null
  ),
  answered as (
    select
      strategy.id,
      case
        when strategy.enabled is true then 'enabled'
        when fills.family is not null then 'fills'
        when strategy.realized is not null and strategy.realized <> 0 then 'realized'
        else 'none'
      end as basis
    from public.strategy_snapshots as strategy
    left join fills
      on fills.trading_account_id = strategy.trading_account_id
     and fills.family = coalesce(
       nullif(strategy.strategy_family, ''),
       public.strategy_family_key(strategy.strategy_name)
     )
    where strategy.daily_import_id = p_daily_import_id
  )
  update public.strategy_snapshots as strategy
     set ran = (answered.basis <> 'none'),
         ran_basis = answered.basis
    from answered
   where strategy.id = answered.id
     and (strategy.ran is distinct from (answered.basis <> 'none')
       or strategy.ran_basis is distinct from answered.basis);
  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- ONE BATCH of closes, bounded by rows written. Returns what it wrote, so a
-- caller loops until it returns 0.
create or replace function public.backfill_strategy_ran(p_max_rows integer default 2000)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_import uuid;
  v_written integer;
  v_total integer := 0;
begin
  loop
    exit when v_total >= greatest(coalesce(p_max_rows, 2000), 1);
    select strategy.daily_import_id into v_import
      from public.strategy_snapshots as strategy
     where strategy.ran is null
     limit 1;
    exit when v_import is null;
    v_written := public.recompute_strategy_ran(v_import);
    -- Cannot happen: every row of the close is in the update's own CTE and a
    -- NULL `ran` is distinct from both true and false, so an unanswered close
    -- always writes. Kept so that a future change cannot turn this into a loop
    -- that asks for the same close forever.
    exit when v_written = 0;
    v_total := v_total + v_written;
  end loop;
  return v_total;
end;
$function$;

-- THE BACKFILL. One close per transaction, for as long as there are unanswered
-- rows. `call public.backfill_strategy_ran_all();` — not from inside a
-- transaction block, because it commits between batches, which is the whole
-- point of it.
-- NO `set search_path` ON THIS ONE, and it is not an oversight: Postgres
-- refuses transaction control inside a routine that carries a SET clause
-- ("invalid transaction termination"), so a procedure that commits cannot have
-- one. Every name below is schema-qualified instead, and the procedure is not
-- security definer, so it runs as whoever calls it with nothing elevated.
create or replace procedure public.backfill_strategy_ran_all(p_max_rows integer default 2000)
language plpgsql
as $procedure$
declare
  v_written integer;
begin
  loop
    v_written := public.backfill_strategy_ran(p_max_rows);
    exit when v_written = 0;
    commit;
  end loop;
end;
$procedure$;

revoke all on function public.strategy_family_key(text) from public, anon, authenticated;
revoke all on function public.recompute_strategy_ran(uuid) from public, anon, authenticated;
revoke all on function public.backfill_strategy_ran(integer) from public, anon, authenticated;
revoke all on procedure public.backfill_strategy_ran_all(integer) from public, anon, authenticated;
grant execute on function public.strategy_family_key(text) to service_role;
grant execute on function public.recompute_strategy_ran(uuid) to service_role;
grant execute on function public.backfill_strategy_ran(integer) to service_role;
grant execute on procedure public.backfill_strategy_ran_all(integer) to service_role;

-- THE AUTOMATIC COLLECTOR'S OWN WRITER.
--
-- public.persist_auto_daily_import (step 28) writes its INSERT column lists in
-- SQL, so an auto-collected close would store NULL in both new columns and the
-- desk would get the stored answer on manually uploaded closes only. The
-- function is reproduced below EXACTLY as step 28 left it, except for the two
-- columns on the strategy insert. It takes the answer off the payload, where
-- reconcile.js put it, rather than recomputing it here: one rule, one writer,
-- and the JS one can see a row whose account never resolved.
--
-- What this does NOT fix, so nobody reads it as fixed: step 37's gap is still
-- open on this path. `derived_realized` and `account_snapshots.derivation` are
-- still not written here, and `realized` is still coalesced to 0 when the
-- payload reports nothing. Both are named in step_37_derived_strategy_pnl.sql
-- with the exact change they need. They are a different measurement from this
-- one and they belong in their own step.

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
  if found and v_daily.status is not distinct from 'Closed' then
    raise exception 'daily_import_closed'
      using errcode = 'P0001', detail = v_daily.id::text;
  end if;

  if found
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
      'source_batch_id', p_source_batch_id
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

  for v_item in select value from jsonb_array_elements(coalesce(p_import_result -> 'snapshots', '[]'::jsonb))
  loop
    v_account_name := coalesce(v_item ->> 'accountName', '');
    select id into v_account_id from public.trading_accounts
      where client_id = p_client_id and lower(account_name) = lower(v_account_name);
    insert into public.account_snapshots (
      daily_import_id, trading_account_id, account_name, connection,
      gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl,
      unrealized_pnl
    ) values (
      v_daily.id, v_account_id, v_account_name, coalesce(v_item ->> 'connection', ''),
      coalesce(nullif(v_item ->> 'grossRealizedPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'trailingMaxDrawdown', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'accountBalance', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'weeklyPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'unrealizedPnl', '')::numeric, 0)
    ) on conflict (daily_import_id, account_name) do update set
      trading_account_id = excluded.trading_account_id,
      connection = excluded.connection,
      gross_realized_pnl = excluded.gross_realized_pnl,
      trailing_max_drawdown = excluded.trailing_max_drawdown,
      account_balance = excluded.account_balance,
      weekly_pnl = excluded.weekly_pnl,
      unrealized_pnl = excluded.unrealized_pnl;
  end loop;

  if jsonb_array_length(coalesce(p_import_result -> 'strategies', '[]'::jsonb)) > 0 then
    delete from public.strategy_snapshots where daily_import_id = v_daily.id;
    for v_item in select value from jsonb_array_elements(p_import_result -> 'strategies')
    loop
      v_account_name := coalesce(v_item ->> 'accountName', '');
      select id into v_account_id from public.trading_accounts
        where client_id = p_client_id and lower(account_name) = lower(v_account_name);
      select id into v_snapshot_id from public.account_snapshots
        where daily_import_id = v_daily.id and lower(account_name) = lower(v_account_name);
      insert into public.strategy_snapshots (
        daily_import_id, trading_account_id, account_snapshot_id, strategy_name,
        strategy_family, strategy_version, instrument, data_series,
        parameters_raw, params_parsed, direction, enabled, ran, ran_basis,
        realized, unrealized
      ) values (
        v_daily.id, v_account_id, v_snapshot_id, coalesce(v_item ->> 'strategyName', ''),
        coalesce(v_item ->> 'strategyFamily', ''), coalesce(v_item ->> 'strategyVersion', ''),
        coalesce(v_item ->> 'instrument', ''), coalesce(v_item ->> 'dataSeries', ''),
        coalesce(v_item ->> 'parametersRaw', ''), coalesce(v_item -> 'params', '{}'::jsonb),
        coalesce(v_item ->> 'direction', ''), coalesce((v_item ->> 'enabled')::boolean, false),
        -- The answer the JS rule reached over this close's own fills, carried
        -- on the payload. NOT recomputed here: one rule, one writer. A payload
        -- without it stores NULL, which every reader falls back from.
        nullif(v_item ->> 'ran', '')::boolean,
        nullif(v_item ->> 'ranBasis', ''),
        coalesce(nullif(v_item ->> 'realized', '')::numeric, 0),
        coalesce(nullif(v_item ->> 'unrealized', '')::numeric, 0)
      );
    end loop;
  end if;

  if jsonb_array_length(coalesce(p_import_result -> 'orders', '[]'::jsonb)) > 0 then
    delete from public.orders where daily_import_id = v_daily.id;
    for v_item in select value from jsonb_array_elements(p_import_result -> 'orders')
    loop
      select id into v_account_id from public.trading_accounts
        where client_id = p_client_id and lower(account_name) = lower(coalesce(v_item ->> 'accountName', ''));
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
      select id into v_account_id from public.trading_accounts
        where client_id = p_client_id and lower(account_name) = lower(coalesce(v_item ->> 'accountName', ''));
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

  delete from public.operational_flags where daily_import_id = v_daily.id;
  for v_item in select value from jsonb_array_elements(coalesce(p_import_result -> 'flags', '[]'::jsonb))
  loop
    select id into v_account_id from public.trading_accounts
      where client_id = p_client_id and lower(account_name) = lower(coalesce(v_item ->> 'accountName', ''));
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

  return v_daily;
end;
$function$;

-- The reach it had when step 28 finished with it, restated rather than assumed:
-- nobody calls this directly. The endpoint calls v3, which calls v2, which calls
-- this, and all three are security definer, so the chain works with no grant at
-- the bottom of it. `create or replace` keeps whatever privileges the function
-- already had, which on a database where step 28 ran is exactly this.
revoke all on function public.persist_auto_daily_import(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
