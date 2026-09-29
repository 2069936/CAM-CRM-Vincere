-- Step 50: the automatic collector stores the per-algo split it already computes.
--
-- WHAT IS WRONG.
--
-- step 37 added `strategy_snapshots.derived_realized` and
-- `account_snapshots.derivation`, and the MANUAL upload path has written them
-- ever since (src/domain/dailyImportPersistence.js, mapStrategy /
-- mapAccountSnapshot). The AUTOMATIC path never did: persist_auto_daily_import
-- writes its own INSERT column lists in SQL and those two columns were never on
-- them, so every auto-collected close stores NULL and the CRM shows it no
-- per-algo split at all. step 37 recorded this as a known gap; this step closes
-- it.
--
-- The collector is the normal route into the book, so the gap is most of the
-- book. MEASURED on production 2026-09-29: 16,916 strategy rows, of which only
-- 747 carry a derived figure. A per-algorithm trade frequency cannot be
-- computed from that: the only usable denominator is the account-days that had
-- exactly one algorithm loaded, where the account's own P&L is that
-- algorithm's. Everything stacked is unattributable.
--
-- NOTHING NEW IS COMPUTED HERE.
--
-- Both paths call reconcileDailyImport (src/domain/reconcile.js), which already
-- attaches `derivation` to each snapshot and `derivedRealized` to each strategy
-- row, and server/autoCollection/ingest/daily.js hands that same importResult
-- straight to this function. The values have been arriving in the payload and
-- being dropped on the floor. This step stops dropping them.
--
-- WHY THE WHOLE FUNCTION IS REPRODUCED.
--
-- The changes are inside the two INSERT statements in the account and strategy
-- loops, so they cannot be layered on with a wrapper the way step 30 wrapped v2
-- in v3. A wrapper would have to UPDATE ... FROM the same payload after the
-- fact, and that is not safe here: strategy_snapshots has no unique key over
-- (daily_import_id, account, strategy_name), and duplicate-named roster rows on
-- one account do occur - step 37 carries `derivation.join.ambiguousNames` for
-- exactly that case. The INSERT loop preserves the payload's array order; an
-- UPDATE join does not, so it could credit a figure to the wrong twin.
--
-- WHY 50 AND NOT 40, WHICH IS WHERE THIS WAS FIRST WRITTEN.
--
-- The first draft of this change was written against a checkout that stopped at
-- PR 15, where 39 was the last step and `persist_auto_daily_import` was still
-- step 28's. Applying it would have silently reverted step 47: that draft's
-- body has no `ran` and no `ran_basis`, so every close written after it would
-- have stopped populating the two columns 16,891 rows now carry, with no error
-- anywhere. The body below is step 47's, current on main, copied verbatim
-- except where commented. Slot 40 was retired on 2026-08-31 in bb35ff3 and the
-- run order has read 39 -> 41 ever since.
--
-- Idempotent and additive: `create or replace`, no data rewritten. Closes
-- imported before this runs keep their NULLs, which stay honest - nothing was
-- derived for them at write time. Re-running a past batch through
-- public.replay_ingest_batch (step 29) routes through this same function and
-- will populate them.

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
      unrealized_pnl, derivation
    ) values (
      v_daily.id, v_account_id, v_account_name, coalesce(v_item ->> 'connection', ''),
      coalesce(nullif(v_item ->> 'grossRealizedPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'trailingMaxDrawdown', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'accountBalance', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'weeklyPnl', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'unrealizedPnl', '')::numeric, 0),
      -- What the fills said about this account-day. NULL means the derivation
      -- did not run OR the account did not trade - never "derived nothing".
      -- The manual path stores this as mapAccountSnapshot's `derivation`; the
      -- payload is identical on both paths because both call
      -- reconcileDailyImport, so this simply stops discarding it.
      case when jsonb_typeof(v_item -> 'derivation') = 'object'
        then v_item -> 'derivation' else null end
    ) on conflict (daily_import_id, account_name) do update set
      trading_account_id = excluded.trading_account_id,
      connection = excluded.connection,
      gross_realized_pnl = excluded.gross_realized_pnl,
      trailing_max_drawdown = excluded.trailing_max_drawdown,
      account_balance = excluded.account_balance,
      weekly_pnl = excluded.weekly_pnl,
      unrealized_pnl = excluded.unrealized_pnl,
      derivation = excluded.derivation;
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
        realized, unrealized, derived_realized
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
        -- A REPORTED ABSENCE STAYS ABSENT. The old form collapsed a present-
        -- but-empty `realized` to 0, which is the fabricated zero step 37
        -- names: 0 is the claim "this strategy made nothing", and NinjaTrader
        -- leaves this blank on most rows. Absent from the payload still means
        -- 0, matching numberOrLegacyZero on the manual path exactly.
        case when v_item ? 'realized'
          then nullif(v_item ->> 'realized', '')::numeric else 0 end,
        coalesce(nullif(v_item ->> 'unrealized', '')::numeric, 0),
        -- Derived from this account's own fills, stored BESIDE `realized`,
        -- never over it: one is a report, the other a derivation. NULL where
        -- the fills could not name this row - never "derived zero".
        nullif(v_item ->> 'derivedRealized', '')::numeric
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

comment on function public.persist_auto_daily_import(uuid, uuid, jsonb) is
  'Persists one automatically collected daily import. Since step 50 it also stores the per-algo split the reconciliation already produced: strategy_snapshots.derived_realized and account_snapshots.derivation, the same two values the manual upload path has written since step 37. NULL in either means not derived - never derived zero.';

-- The reach it had when step 28 finished with it, restated rather than assumed:
-- nobody calls this directly. The endpoint calls v3, which calls v2, which calls
-- this, and all three are security definer, so the chain works with no grant at
-- the bottom of it. `create or replace` keeps whatever privileges the function
-- already had, which on a database where step 28 ran is exactly this.
revoke all on function public.persist_auto_daily_import(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
