-- Step 60: only a Manager moves a client between books.
--
-- WHY 60. 54 is claimed by draft PR 65, 55 to 58 are merged (58 is the close
-- summaries scope), and 59 is the log history aggregate beside this file.
-- The run order is 56, 57, 58, 59, 60; this file depends on none of 57, 58 or
-- 59.
--
-- WHAT WAS WRONG, MEASURED. Step 53 replaced step 52's client_assignments
-- policy with one `for all` policy whose USING and WITH CHECK both read:
--
--   you are a Manager
--   OR the client is assigned to you
--   OR you created the client
--
-- Every arm asks about the CLIENT and none asks about the PROFILE the row
-- names, and the verb is ALL. Exercised as the role on the migration cluster,
-- every step through 57 applied, request.jwt.claim.sub set to the CAM "Gray":
--
--   A. G1 is assigned to Gray (a client the desk created).
--        insert (G1, Birch)                 -> SUCCEEDED
--        delete (G1, Gray)                  -> SUCCEEDED, 1 row
--      G1 is now in Birch's book and out of Gray's, and no Manager was asked.
--
--   C. Gray creates F the way the browser does and assigns it to herself. A
--      Manager transfers F to Birch: Gray reads 0 rows of F, as step 53
--      intended. Then, still as Gray:
--        select the assignment rows of F    -> 1 row, naming Birch
--        insert (F, Gray)                   -> SUCCEEDED
--        delete (F, Birch)                  -> SUCCEEDED, 1 row
--      The creator arm never expires on this table. Step 53 made it expire on
--      clients (`and not client_is_assigned(id)`) and wrote that a bare
--      created_by check "would have allowed forever" exactly this; the
--      assignment policy carries the bare form, so the creator takes the client
--      back from the CAM a Manager gave it to, and removes her.
--
--   B. insert (B1, Gray) for a client she does not hold -> refused. The gate on
--      the client works; the gap is what she may do with one she holds.
--
-- WHY IT MATTERS BEYOND THE BOOK. Step 57's algorithm_live_desk() leaves a
-- CAM's own clients out of the desk figure. Its header names this as the
-- residual: a VPS paired under SOMEONE ELSE'S code, for a client assigned to
-- her, holds a device credential; she hands the client to another CAM (A
-- above) and the client is outside her book, so readings she posts with that
-- credential count as the rest of the desk. Measured on the cluster: G1 paired
-- under the Manager's enrollment code, handed to Birch by Gray, is in none of
-- the three sets algorithm_live_desk() leaves out for Gray.
--
-- WHAT THE PRODUCT ACTUALLY DOES WITH THIS TABLE, from the browser's code:
--
--   * createSupabaseClient inserts the client and then upserts ONE assignment,
--     to the workspace's CAM. In a CAM session that is her own profile: the
--     "Other CAMs" navigation renders only for a Manager, so a CAM never stands
--     in another CAM's workspace.
--   * transferSupabaseClient deletes the Owner row and upserts the new one. It
--     is wired only inside ManagerOverview, which renders only for a Manager.
--
-- So a CAM has one honest write here: assigning to herself a client she has
-- just created and nobody holds yet. Everything else a CAM can do today is a
-- handoff the product only offers a Manager. This file makes the database say
-- the same thing:
--
--   Manager  reads and writes every row, as before.
--   CAM      reads the rows of the clients assigned to her, and of a client she
--            created that nobody holds yet (the read is what lets the browser's
--            upsert pass: ON CONFLICT DO UPDATE applies the SELECT policy to the
--            new row).
--            inserts ONE kind of row: (a client she created that nobody holds,
--            her own profile).
--            updates nothing and deletes nothing.
--
-- THE CREATOR ARM NOW EXPIRES HERE TOO. `not client_is_assigned(client_id)` is
-- the same switch step 53 put on clients: true for the one statement between
-- the client insert and its first assignment, false from then on. It reads the
-- statement's snapshot, so the row being inserted does not count against
-- itself; the test beside this file runs the browser's exact upsert to prove it.
--
-- RESTRICTIVE, AND ADDED RATHER THAN SWAPPED, because steps 52 and 53 are both
-- re-runnable and both write a PERMISSIVE policy on this table. 52's loop drops
-- every permissive policy on a table with a client_id and creates its own `for
-- all`; 53 drops and recreates "cam sees its own clients" by name. A permissive
-- replacement here would be undone by re-running either, silently, and the
-- table would read as fixed. Restrictive policies are AND'd with whatever
-- permissive ones exist and neither file touches them, which is the reason step
-- 55 used them for its own tables. So step 53's policy stays as the gate on
-- WHICH CLIENTS a session may touch, and these four say what a CAM may DO
-- with them:
--
--   select  Manager, or assigned to you, or created by you and held by nobody.
--           The third arm is what the browser's upsert needs: ON CONFLICT DO
--           UPDATE applies the SELECT policy to the new row.
--   insert  Manager, or a row naming YOUR profile, for a client you created
--           that nobody holds yet.
--   update  Manager.
--   delete  Manager.
--
-- WHAT A CAM LOSES. Nothing the product offers her. A CAM who wants a client
-- moved asks a Manager, which the screen already requires. A CAM can no longer
-- remove herself from a client; neither can she today in the product.
--
-- RESIDUAL RISK, stated rather than hidden. "Held by nobody" is read when she
-- writes, and nothing records that a client was ever held. So a client she
-- created that is left with NO assignment row at all (a Manager removes the
-- Owner row without naming a new one) is hers to take again: the creator arm
-- on clients (step 53) shows it to her and the insert arm here accepts (that
-- client, her profile), with no Manager asked. Measured on the cluster in
-- review. A client a Manager moves to another CAM always has a row, so the
-- handoff in C above stays closed. Closing this one needs a record that the
-- client has been assigned before, which is a column and a later step.
--
-- WHY A HELPER FOR THE PROFILE. `my_cam_profile_id()` reads app_users as a
-- definer, the way assigned_client_ids() does, so this policy does not depend
-- on whatever policy app_users carries next, and an Inactive user resolves to
-- no profile, the reading step 52 gives a misconfiguration.
--
-- Idempotent: each policy is dropped by name and recreated, and the helper is
-- create or replace. No row is written or deleted, and step 53's permissive
-- policy is left exactly as it is.

begin;

do $step60_guard$
begin
  if to_regprocedure('public.is_manager()') is null
    or to_regprocedure('public.assigned_client_ids()') is null then
    raise exception 'step 60 needs step 52 (is_manager, assigned_client_ids): run it first';
  end if;
  if to_regprocedure('public.clients_i_created()') is null
    or to_regprocedure('public.client_is_assigned(uuid)') is null then
    raise exception 'step 60 needs step 53 (clients_i_created, client_is_assigned): run it first';
  end if;
end
$step60_guard$;

-- ---------------------------------------------------------------------------
-- The calling session's own CAM profile, or NULL.
-- ---------------------------------------------------------------------------
create or replace function public.my_cam_profile_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select u.cam_profile_id
  from public.app_users u
  where u.auth_user_id = auth.uid()
    and coalesce(u.status, 'Active') <> 'Inactive';
$function$;

comment on function public.my_cam_profile_id() is
  'The CAM profile of the calling session, NULL for anyone without one or with an Inactive user. Read by the step 60 client_assignments policy. Call it as (select public.my_cam_profile_id()) so it runs once per query.';

revoke all on function public.my_cam_profile_id() from public, anon, authenticated;
grant execute on function public.my_cam_profile_id() to authenticated;

-- ---------------------------------------------------------------------------
-- client_assignments: four restrictive policies beside step 53's permissive one.
-- ---------------------------------------------------------------------------
drop policy if exists "assignments: a cam reads only its own clients" on public.client_assignments;
create policy "assignments: a cam reads only its own clients" on public.client_assignments
  as restrictive
  for select to authenticated
  using (
    (select public.is_manager())
    or client_id in (select public.assigned_client_ids())
    or (client_id in (select public.clients_i_created()) and not public.client_is_assigned(client_id))
  );

drop policy if exists "assignments: a cam assigns only a new client, to itself" on public.client_assignments;
create policy "assignments: a cam assigns only a new client, to itself" on public.client_assignments
  as restrictive
  for insert to authenticated
  with check (
    (select public.is_manager())
    or (
      cam_profile_id = (select public.my_cam_profile_id())
      and client_id in (select public.clients_i_created())
      and not public.client_is_assigned(client_id)
    )
  );

drop policy if exists "assignments: only a manager updates" on public.client_assignments;
create policy "assignments: only a manager updates" on public.client_assignments
  as restrictive
  for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

-- DELETE needs its own policy: `with check` does not govern a delete, which
-- makes no new row and is judged by `using` alone.
drop policy if exists "assignments: only a manager deletes" on public.client_assignments;
create policy "assignments: only a manager deletes" on public.client_assignments
  as restrictive
  for delete to authenticated
  using ((select public.is_manager()));

-- A restrictive policy grants nothing on its own: without a permissive policy
-- beside it every row is refused, a Manager's included. Step 53's is the one
-- expected; refuse to finish on a table that has none rather than leave the
-- desk unable to assign anyone.
do $step60_permissive$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'client_assignments' and permissive = 'PERMISSIVE'
  ) then
    raise exception 'step 60 found no permissive policy on client_assignments: run step 53 first';
  end if;
end
$step60_permissive$;

commit;

-- What this leaves: no table in public without row level security, the check
-- steps 43 to 59 end with.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 60 left % table(s) without row level security', n;
  end if;
end $$;
