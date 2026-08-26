-- Step 37: the per-strategy P&L the CRM derives from the fills, and the report
-- that says how much of it may be believed.
--
-- WHY THESE COLUMNS EXIST.
--
-- NinjaTrader's Strategies grid populates `Realized` on a minority of rows —
-- 11 of 47 on the export this was built against, and 1824 of 2241 stored
-- account-days have every strategy at 0 while the account itself moved. So for
-- most accounts the only answer to "which algo did that" is the one the CRM
-- works out from the fills: FIFO per (account, instrument), each closed pair
-- credited to the strategy named on BOTH of its legs.
--
-- That answer was being computed at import time and then thrown away. There was
-- nowhere to put it, so a CAM saw a per-algo split before a reload and nothing
-- after one. These columns are that missing storage.
--
-- WHY NOT DEFAULT 0.
--
-- Every column here is nullable with NO default, and that is the entire point.
-- NULL means "not derived" — the fills never named this strategy, or the day did
-- not reconcile, or the join onto the roster refused. A default of 0 would turn
-- each of those into the claim "this strategy made nothing", which is a
-- measurement nobody took. That exact substitution is the bug this step is part
-- of fixing: a fabricated zero once absorbed an account's whole $100 day and the
-- screen reported the split as complete. See src/domain/joinDerivedStrategies.js.
--
-- Note the difference from `strategy_snapshots.realized`, which was created with
-- `default 0` long before the reported/absent distinction existed. Rows written
-- since carry NULL there when the grid reported nothing, and the app now reads
-- that NULL back as "not reported" instead of collapsing it to 0. Nothing is
-- migrated: a historical 0 in that column stays a 0, because we cannot tell
-- after the fact whether it was reported or defaulted.

-- ONE COLUMN ON strategy_snapshots, NOT THREE.
--
-- This step was drafted with three: `derived_realized`, plus
-- `derived_realized_status` (the account-day's verdict) and
-- `derived_realized_join` (why this row does or does not carry a figure). It has
-- not been run anywhere, so the shape was still free, and the last two are gone.
--
-- They were the same answer written once per roster row. `derived_realized_status`
-- was `account_snapshots.derivation.status` copied verbatim onto every strategy
-- row of that account-day — the blob below already stores it once, and the app
-- already reads it from there. `derived_realized_join` is a five-value enum whose
-- values are recoverable from what survives:
--
--   matched         derived_realized is not null
--   no-derived-row  derivation.join.published and derived_realized is null
--   ambiguous-name  strategy_name = any(derivation.join.ambiguousNames)
--   refused         derivation.status = 'exact' and not derivation.join.published,
--                   and the name is not one of the ambiguous ones
--   unavailable     derivation is null or derivation.status <> 'exact'
--
-- Only 'ambiguous-name' needed anything new, and it needed a per-account-day
-- array rather than a per-row string: `derivation.join.ambiguousNames`, written
-- only on a day that actually had a duplicate-named roster row. On the real
-- ten-folder export that is 0 of 40 account-days, so 0 bytes.
--
-- MEASURED through src/domain/dailyImportPersistence.js mapStrategy on that
-- export (47 strategy rows, 4 distinct (status, join) pairs across all of them):
--
--                              before   after
--   derived_realized            23.9     23.9   B/row
--   derived_realized_status     35.4        —
--   derived_realized_join       37.1        —
--   all step-37 columns         96.4     23.9   B/row
--
-- On the busiest CAM's 1,033-row export pull that is 97.3 KiB against 24.1 KiB.
-- It matters because server/export/clientExport.js dumps these tables wholesale
-- under a hard 4 MiB ceiling enforced as a 413, and its own header records that
-- CAM's default pull already at 4.06 MiB with the next-busiest at 95.2%. Nothing
-- computed or displayed changes: the panel reads `derived_realized` per row and
-- everything else from the account-day blob, and it did so before this trim too.

alter table public.strategy_snapshots
  add column if not exists derived_realized numeric;

comment on column public.strategy_snapshots.derived_realized is
  'Realized P&L worked out from this account''s own fills and joined onto this roster row. Written only when the account-day reconciled to Gross realized PnL with nothing unattributed AND the roster join itself balanced. NULL means not derived — never "derived zero". Kept beside `realized` (what NinjaTrader reported), never over it: one is a report, the other is a derivation, and a reader who cannot tell them apart cannot judge either. This is the ONLY derived column on this table: the account-day verdict and the per-row join reason are answerable from account_snapshots.derivation, which stores them once instead of once per roster row.';

alter table public.account_snapshots
  add column if not exists derivation jsonb;

comment on column public.account_snapshots.derivation is
  'What the fills said about this account-day that no other column records: `status` (exact | partial | unreconciled), `reportedGross` (the raw Gross realized PnL column, which nothing else stores, and the basis the app re-checks the derived rows add up to), `residual` (money paired but creditable to no single strategy, with its reasons), and a trimmed `join` report (`status`, `published`, any derived strategy that is on NO roster row together with what it was worth, and — only on a day that had one — `ambiguousNames`, the roster names a derived figure was refused for because it matched more than one row). This is the ONE place the account-day verdict is stored: it is not repeated on the strategy rows, and the per-row join reason is recovered from it plus strategy_snapshots.derived_realized rather than stored. The app refuses to display a per-algo split without it, so a close stored before this column existed simply shows no derived split — which is the safe direction. NULL means the derivation did not run, OR the account did not trade: a no-trades derivation makes exactly the claim NULL makes and is not stored. Deliberately NOT stored: the per-strategy figures (they are strategy_snapshots.derived_realized) and the arithmetic that produced `status` (re-derivable from the executions and orders of this same close). See src/domain/reconcile.js storableDerivation for the measured reason — the untrimmed blob was 606 bytes a row against 322 bytes of scalars, on a table two `select *` paths carry.';

-- WHAT THIS STEP DOES NOT COVER, stated so nobody assumes it does.
--
-- The automatic collector persists through public.persist_auto_daily_import
-- (step 28), which writes its own INSERT column lists in SQL and knows nothing
-- about these two columns. Auto-collected closes therefore store NULL derived
-- values and no derivation, and the CRM shows them no per-algo split at all.
-- That is safe — absent stays absent, and nothing fabricated reaches a screen —
-- but it is a gap: the derived split currently survives a reload only on the
-- manual upload path, which is also the only path where a CAM ever sees the
-- pre-reload version. Closing it means replacing that function with one that
-- carries `derivedRealized` and the snapshot's `derivation` — two columns, not
-- four, which is one more reason the trim above was worth doing before this step
-- ran — and while doing so fixing the same fabricated-zero it applies to
-- `realized` today:
--   coalesce(nullif(v_item ->> 'realized', '')::numeric, 0)
-- should be
--   case when v_item ? 'realized' then nullif(v_item ->> 'realized', '')::numeric else 0 end
-- so a reported absence stays absent there too, exactly as the JS mapper's
-- numberOrLegacyZero already does on the manual path.
