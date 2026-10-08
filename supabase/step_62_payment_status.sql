-- Step 62: where each client stands with their CAM payment, as its own column.
--
-- WHY 62. 61 is the last number applied. 54 is still claimed by draft PR 65 and
-- is never reused. 62 depends on nothing after 56 and touches only clients, so
-- it can run at any point after 56.
--
-- WHAT WAS WRONG. clients.subscription_price (step 21) is text and the app
-- fixed its options to '$500', '$250', 'Free' and 'Undetermined'. The desk's
-- own sheet ("CAM Clients Payment Status") holds six amounts ($500, $400,
-- $375, $333, $250, $183) and five groups: paying, free, undetermined, paused
-- (payment failed or free expired) and idle, plus a Cancelled tab. A client at
-- $400 could only be filed as Undetermined, and a paused or cancelled client
-- had nowhere to go at all. Counted read only on 2026-10-08: 97 clients
-- Undetermined, 20 at $500, 18 at $250, 13 Free.
--
-- WHAT THIS ADDS.
--
--   * clients.payment_status text not null default 'undetermined', with a
--     CHECK on the six values. subscription_price stays, for every reader that
--     already has it, and from now on holds any whole dollar amount as '$N'
--     (src/domain/subscriptionPrice.js is the one normalizer), 'Free', or
--     'Undetermined'. The amount only means something while payment_status is
--     'paying'; the app writes 'Undetermined' into subscription_price when a
--     client pauses, idles or cancels, so the price log (step 42) records the
--     money that stopped.
--
--   * A BACKFILL from the column that was already there: '$N' -> paying,
--     'Free' -> free, anything else stays undetermined. Only rows still at the
--     default are touched, so a re-run after a CAM has filed somebody as paused
--     does not put them back to paying.
--
--   * ITS OWN GRANTS, per step 56. The table already holds select, insert and
--     update for authenticated and nothing for anon; a new column inherits
--     table privileges, but this file restates them rather than relying on 56
--     having run, because the rule since 56 is that no table's privileges
--     depend on migration order. The browser updates clients from the client
--     form and from the payment sheet importer, both as the signed-in user,
--     through step 53's "cam updates its own clients" policy; nothing here
--     widens that. Row level security stays on. No DELETE: clients are
--     soft-deleted (step 56's exception table says why).
--
-- IDEMPOTENT. `add column if not exists`, the constraint dropped and recreated
-- under its own name, a backfill that matches nothing the second time, and
-- revoke-then-grant that reaches the same end state every time.
--
-- CHECK AFTERWARDS (read only). On today's production the first should return
-- 38 (20 + 18), the second 13, the third 97, the fourth 0:
--
--   select count(*) from public.clients where payment_status = 'paying';
--   select count(*) from public.clients where payment_status = 'free';
--   select count(*) from public.clients where payment_status = 'undetermined';
--   select count(*) from public.clients
--    where payment_status = 'undetermined'
--      and (subscription_price ~ '^\$[0-9]+$' or subscription_price = 'Free');

begin;

alter table public.clients
  add column if not exists payment_status text not null default 'undetermined';

alter table public.clients
  drop constraint if exists clients_payment_status_check;
alter table public.clients
  add constraint clients_payment_status_check
  check (payment_status in ('paying', 'free', 'undetermined', 'paused', 'idle', 'cancelled'));

comment on column public.clients.payment_status is
  'Where the client stands with the CAM subscription: paying, free, undetermined, paused, idle or cancelled. The amount, while paying, is subscription_price as $N. Step 62.';

do $step62$
declare
  filed integer;
begin
  update public.clients
     set payment_status = case
           when subscription_price ~ '^\$[0-9]+$' then 'paying'
           when subscription_price = 'Free' then 'free'
           else 'undetermined'
         end
   where payment_status = 'undetermined'
     and (subscription_price ~ '^\$[0-9]+$' or subscription_price = 'Free');
  get diagnostics filed = row_count;
  raise notice 'step 62: filed % client(s) from subscription_price', filed;
end
$step62$;

-- The grants, restated for this table (step 56's rule: never by migration
-- order). anon gets nothing; authenticated reads, creates and updates, and
-- row level security decides which rows.
revoke all privileges on table public.clients from anon;
revoke all privileges on table public.clients from public;
revoke all privileges on table public.clients from authenticated;
grant select, insert, update on table public.clients to authenticated;
alter table public.clients enable row level security;

commit;
