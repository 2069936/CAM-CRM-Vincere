-- Step 51: a CAM can no longer promote themselves.
--
-- WHAT IS WRONG.
--
-- `authenticated` holds INSERT, UPDATE and DELETE on public.app_users, and
-- step 43's policy for that table is `for all to authenticated using (true)
-- with check (true)`. RLS is enabled and passes everybody, so the grant is the
-- whole of the control, and the grant says yes.
--
-- A CAM signed into the CRM holds a `authenticated` session. The browser's
-- publishable key plus that session reach PostgREST directly, without the API.
-- One PATCH on their own app_users row changes `role` to Manager. Nothing in
-- api/admin/users.js is consulted, because nothing has to be.
--
-- THE API IS NOT THE ONLY PATH, which is the whole point. server/apiLib/
-- apiAuth.js authorises carefully - every id checked, denial beating storage
-- failure, the same message whether a client belongs to someone else or does
-- not exist - and it runs on the service role, which bypasses RLS entirely.
-- None of that care is reachable from a request that never calls it.
--
-- WHAT THIS DOES NOT TAKE.
--
-- SELECT stays. The browser reads app_users twice, both times to sign in:
-- src/domain/supabaseAuth.js fetchAppUserByAuthId reads the row for the signed
-- in user, and resolveLoginEmail falls back to reading one email by username on
-- a deployment where step 43's login_email_for_username is missing. Both are
-- reads. Neither writes. Revoking SELECT would lock everyone out.
--
-- The service role is unaffected: it is BYPASSRLS and its grants are separate,
-- so api/admin/users.js keeps creating, editing and deactivating users exactly
-- as it does today. That route is now the only way it happens, which is what
-- the header of api/admin/users.js already assumes.
--
-- Idempotent: `revoke` on a privilege already absent is a no-op. After this runs
-- both roles hold exactly SELECT, and service_role is untouched.

revoke insert, update, delete on public.app_users from authenticated;

-- The same reasoning applies to anon, which has no policy on this table and so
-- reaches nothing today. Restated rather than assumed, because a policy added
-- later would otherwise hand it whatever the grant still allows.
revoke insert, update, delete on public.app_users from anon;

-- AND THE THREE NOBODY THINKS OF, because "may only SELECT" has to be true and
-- not nearly true. TRUNCATE empties the table in one statement and is not an
-- INSERT, UPDATE or DELETE. TRIGGER attaches code that runs on somebody else's
-- write, which is worse than any single write. REFERENCES lets a foreign key
-- be pointed at these rows, which is how a table nobody audits starts deciding
-- whether a user can be deleted.
--
-- None is reachable through PostgREST today, which is exactly why they sat
-- there: the grant survived because no route exercised it. A grant that no
-- route needs is one a future route inherits by accident.
revoke truncate, trigger, references on public.app_users from authenticated;
revoke truncate, trigger, references on public.app_users from anon;

comment on table public.app_users is
  'CRM logins. Since step 51 the authenticated role may only SELECT here: a session reads its own row to sign in, and every write goes through api/admin/users.js on the service role. The row-level policy passes everybody, so the grant is the control.';
