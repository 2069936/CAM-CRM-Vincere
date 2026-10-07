-- Step 53: step 52 made it impossible for a CAM to create a client.
--
-- WHAT BROKE, AND WHY THE ERROR POINTS AT THE WRONG THING.
--
-- Production, from a CAM session, on the New Client form:
--
--   Could not save client "...": new row violates row-level security policy
--   for table "clients"
--
-- That message names the WITH CHECK on INSERT, and step 52's INSERT policy on
-- clients is `with check (true)`. It cannot be the thing refusing. Measured
-- against production as the CAM "Peter", the same statement twice:
--
--   insert into clients (...)                      -> OK
--   insert into clients (...) returning id         -> 42501, the message above
--
-- The INSERT is fine. The RETURNING is not. PostgreSQL applies the SELECT
-- policy to a row a statement hands back, and src/domain/supabaseStore.js
-- createSupabaseClient ends in `.insert({...}).select().single()`, which is
-- exactly that. A client a CAM has just created carries no assignment yet, so
-- the SELECT policy refuses to let them read back the row they just wrote, and
-- Postgres reports it with the INSERT wording.
--
-- The very next statement was going to fail for the same reason: the flow then
-- upserts client_assignments for the new client, and step 52 gates that on
-- `client_id in assigned_client_ids()`, which is false for a client whose only
-- assignment is the one being created. A chicken and egg on both halves.
--
-- WHY A TRIGGER CANNOT FIX IT. The obvious repair is an AFTER INSERT trigger
-- that assigns the new client to its creator, so that by the time RETURNING
-- looks, the assignment exists. Tried against production: it does not work, and
-- the reason is worth writing down. `assigned_client_ids()` is STABLE, which is
-- what lets a policy hoist it out of the row loop, and a stable function reads
-- the statement's snapshot. A row inserted during the same statement is not in
-- that snapshot. No trigger can be seen by the policy that runs above it.
--
-- WHAT THIS DOES INSTEAD. clients gains `created_by`, defaulted to auth.uid().
-- It is a column ON THE ROW, so a policy reads it off the row being returned
-- without consulting any snapshot, which is the one thing a trigger could not
-- offer. The SELECT and UPDATE policies gain a third arm:
--
--   you are a Manager
--   OR the client is assigned to you
--   OR YOU CREATED IT AND IT IS NOT ASSIGNED TO ANYONE YET
--
-- The third arm closes itself. The moment the client is assigned - which the
-- creating flow does one statement later - `client_is_assigned` turns true and
-- the row is governed by the ordinary rule again. So a CAM cannot keep sight of
-- a client after it is transferred away, which a bare `created_by = auth.uid()`
-- would have allowed forever.
--
-- Existing rows keep `created_by` null and nothing widens backwards: 212 rows
-- at the time of writing, all null, and `null = auth.uid()` is null, not true.
--
-- WHY TWO MORE SECURITY DEFINER FUNCTIONS, which is not decoration. Writing
-- the third arm inline as `not exists (select 1 from client_assignments ...)`
-- and the client_assignments arm as `client_id in (select id from clients ...)`
-- makes each policy query the other's table, so each triggers the other's
-- policy. Applied to production in a transaction, that is:
--
--   ERROR: 42P17: infinite recursion detected in policy for relation "clients"
--
-- A security definer function does not evaluate policies, so routing both
-- directions through one breaks the cycle. Both are pinned to a search_path for
-- the usual reason.
--
-- VERIFIED against production before being applied, inside a transaction that
-- was rolled back, as the CAM "Peter":
--
--   insert + returning : OK          (was 42501)
--   the assignment     : OK          (was going to be 42501)
--   clients visible    : 37, his 36 plus the new one
--   somebody else's    : 0           unchanged, nothing leaked
--
-- NARROWED BY STEP 60. The client_assignments policy at the bottom of this file
-- gates on the CLIENT and never on the profile a row names, and its creator arm
-- has no expiry, so a CAM could hand a client she holds to another CAM, delete
-- her own row, or take back a client she created after a Manager moved it.
-- Step 60 leaves this policy in place and adds restrictive ones beside it, so a
-- re-run of this file does not reopen that. Do not widen the policy below
-- thinking it is the whole rule for the table.
--
-- Idempotent.

alter table public.clients add column if not exists created_by uuid default auth.uid();

comment on column public.clients.created_by is
  'The auth user that inserted the row, defaulted from auth.uid(). Read by the step 53 policies so a CAM can read back a client it has just created, before any assignment exists. Null on every row written before step 53 and on anything the service role inserts, which is deliberate: null matches nobody.';

-- ---------------------------------------------------------------------------
-- Is this client assigned to anyone at all?
--
-- Definer so that a policy on clients may ask it without evaluating the policy
-- on client_assignments, which would recurse.
-- ---------------------------------------------------------------------------
create or replace function public.client_is_assigned(p_client uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (select 1 from public.client_assignments a where a.client_id = p_client);
$function$;

-- ---------------------------------------------------------------------------
-- The clients this session created. The other direction of the same cycle.
-- ---------------------------------------------------------------------------
create or replace function public.clients_i_created()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select c.id from public.clients c
  where c.created_by is not null and c.created_by = auth.uid();
$function$;

revoke all on function public.client_is_assigned(uuid) from public;
revoke all on function public.clients_i_created() from public;
grant execute on function public.client_is_assigned(uuid) to authenticated;
grant execute on function public.clients_i_created() to authenticated;

-- ---------------------------------------------------------------------------
-- clients: read and write gain the creator arm.
-- ---------------------------------------------------------------------------
drop policy if exists "cam sees its own clients" on public.clients;
create policy "cam sees its own clients" on public.clients
  for select to authenticated
  using (
    (select public.is_manager())
    or id in (select public.assigned_client_ids())
    or (created_by = (select auth.uid()) and not public.client_is_assigned(id))
  );

drop policy if exists "cam updates its own clients" on public.clients;
create policy "cam updates its own clients" on public.clients
  for update to authenticated
  using (
    (select public.is_manager())
    or id in (select public.assigned_client_ids())
    or (created_by = (select auth.uid()) and not public.client_is_assigned(id))
  )
  with check (
    (select public.is_manager())
    or id in (select public.assigned_client_ids())
    or (created_by = (select auth.uid()) and not public.client_is_assigned(id))
  );

-- DELETE is deliberately NOT widened. Creating a client you cannot yet see is a
-- flow the product has; deleting one is not, and a CAM deleting a client that
-- is not theirs has no honest reading.

-- ---------------------------------------------------------------------------
-- client_assignments: you may assign a client you created.
--
-- Not "you may assign any client to yourself", which would let a CAM take any
-- client on the desk by writing one row. The gate stays on the CLIENT.
-- ---------------------------------------------------------------------------
drop policy if exists "cam sees its own clients" on public.client_assignments;
create policy "cam sees its own clients" on public.client_assignments
  for all to authenticated
  using (
    (select public.is_manager())
    or client_id in (select public.assigned_client_ids())
    or client_id in (select public.clients_i_created())
  )
  with check (
    (select public.is_manager())
    or client_id in (select public.assigned_client_ids())
    or client_id in (select public.clients_i_created())
  );
