-- Step 42: tags a CAM puts on a client, and a record of what a price used to be.
--
-- TWO THINGS, ONE MIGRATION, BECAUSE THEY ANSWER ONE QUESTION TOGETHER.
--
-- Management asked for a revenue dashboard: MRR by tier, average revenue per
-- client, free clients and what they would be worth, new and lost MRR month
-- over month, and how many free clients ever convert.
--
-- Everything in the first half is computable from clients.subscription_price
-- as it stands today. Everything in the second half is not, and this is why:
-- the audit trail for a client edit records `changedFields: Object.keys(patch)`
-- (src/App.jsx). It knows the price was touched and on what day. It has never
-- known whether the client went from Free to $500 or from $500 to Free. New
-- MRR, lost MRR and the conversion rate are all differences between a before
-- and an after, and neither has ever been stored.
--
-- Nothing can be reconstructed backwards. The best available move is to start
-- recording, so `client_price_changes` begins empty on purpose and the
-- dashboard reports how far back it actually reaches rather than answering
-- zero for a period nobody recorded.
--
-- AND TAGS, WHICH ARE PART OF THE SAME ANSWER. When a prop firm keeps a client
-- by handing them three or six free months of CAM instead of a refund, that
-- client lands on the Free tier. They are indistinguishable from a client who
-- simply has not converted, and they mean the opposite: one is a retained
-- refund, the other is revenue nobody has collected. Counting them together
-- inflates the pipeline with people who were never going to pay this quarter.
-- `Refund save` is the tag that separates them, which is why it ships beside
-- the revenue work rather than after it.
--
-- Additive and idempotent. Nothing is dropped or rewritten.

begin;

-- ---------------------------------------------------------------------------
-- Tags
--
-- An array rather than a join table. The set is fixed at three, a client
-- carries all of them or none, and the only questions asked of it are "does
-- this client have X" and "count the clients with X", both of which an array
-- answers with one index. A join table would buy per-tag history nobody has
-- asked for at the cost of a second read on every client load.
--
-- The CHECK is what keeps the column countable. Free text becomes eleven
-- spellings of "at risk" inside a month and then nothing can be aggregated,
-- which is the whole reason for tagging.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists tags text[] not null default '{}'::text[];

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_tags_known_values'
  ) then
    alter table public.clients
      add constraint clients_tags_known_values
      check (tags <@ array['At risk', 'VIP', 'Refund save']::text[]);
  end if;
end $$;

-- Counting "how many clients are tagged X" is the point of the column, so the
-- containment operator gets an index rather than a sequential scan per tile.
create index if not exists clients_tags_idx on public.clients using gin (tags);

-- ---------------------------------------------------------------------------
-- Price history
--
-- One row per change, with both sides of it. `changed_by` is nullable because
-- a price can move through a back-office script that has no app user, and
-- losing the row would be worse than losing the attribution.
--
-- There is no unique key on (client_id, changed_at): a price genuinely can be
-- corrected twice in a minute, and refusing the second write would silently
-- drop the correction that mattered.
-- ---------------------------------------------------------------------------
create table if not exists public.client_price_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  previous_price text,
  new_price text not null,
  changed_by uuid references public.app_users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists client_price_changes_client_idx
  on public.client_price_changes (client_id, changed_at desc);
create index if not exists client_price_changes_at_idx
  on public.client_price_changes (changed_at desc);

alter table public.client_price_changes enable row level security;

-- Readable by any signed-in app user: the dashboard is a management view and
-- the rows carry no client identity beyond the id. Writes go through the same
-- path every other client edit does.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_price_changes'
      and policyname = 'client_price_changes_read'
  ) then
    create policy client_price_changes_read on public.client_price_changes
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_price_changes'
      and policyname = 'client_price_changes_insert'
  ) then
    create policy client_price_changes_insert on public.client_price_changes
      for insert to authenticated with check (true);
  end if;
end $$;

grant select, insert on public.client_price_changes to authenticated;

-- The first day the log can speak for. Everything before it is unknown, and the
-- dashboard says so rather than reporting a confident zero.
comment on table public.client_price_changes is
  'Before and after of every subscription_price change. Starts empty: the audit log recorded which field changed and never the values, so nothing before this table existed can be reconstructed.';

commit;
