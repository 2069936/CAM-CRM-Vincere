// A real PostgreSQL, in process, so a test can ASK THE DATABASE instead of
// reading the file.
//
// WHY THIS EXISTS. Every migration test in this directory asserts the TEXT of
// the SQL. That is cheap and it has caught real mistakes, but it cannot catch a
// mistake in what the SQL DOES, and this repo has shipped several tests that
// passed against a comment rather than against a behaviour.
//
// `@electric-sql/pglite` is PostgreSQL 18 compiled to WebAssembly. It needs no
// server, no cluster, no port and no Docker, it starts in about a second, and it
// runs plpgsql, policies, `set role`, GRANT/REVOKE and the privilege catalogues.
// `npm ci` is the whole installation, so these assertions run on a laptop and in
// CI identically.
//
// ---------------------------------------------------------------------------
// THE LESSON THIS FILE WAS REWRITTEN TO CARRY.
//
// An earlier harness modelled Supabase's grants as
//
//     grant select, insert, update, delete on <table> to anon, authenticated
//
// and set no default privileges at all. Supabase does neither. A real Supabase
// project ships `alter default privileges in schema public grant all on tables`,
// so every table a migration creates is BORN holding all eight privileges -
// including TRUNCATE, TRIGGER, REFERENCES and MAINTAIN - for anon and for
// authenticated.
//
// The consequence is not academic. Under the old prerequisites no assertion in
// the file could ever see a grant hole, because the hole was never created. The
// suite was green and the database was open. A harness kinder than the world
// makes every test inside it decoration.
//
// So this file installs the default privileges Supabase installs, and then
// PROVES IT DID, at boot, against the ACL string measured on Pedro's own
// project. `assertSupabaseGrantFidelity` runs on every start and throws rather
// than letting a test pass under prerequisites that cannot fail. The constant
// below is the measurement, character for character.
// ---------------------------------------------------------------------------
//
// WHAT IT CANNOT DO, stated so nobody mistakes a green suite for the whole
// story:
//
//   * PGlite is a single connection. Nothing here proves anything about two
//     sessions racing, lock order or deadlocks.
//   * Its `postgres` IS a superuser. On Supabase it is not, and `supabase_admin`
//     is. That difference is the whole of the second default-privilege line, so
//     where it matters a probe switches role explicitly rather than trusting the
//     ambient one. See `canAlterDefaultPrivilegesForRole`.
//   * It has no GoTrue and no PostgREST. `auth.uid()` is modelled by the same
//     `request.jwt.claim.sub` setting PostgREST sets, which is how the real
//     policies read it, but no HTTP layer is exercised.

import { readFileSync, readdirSync } from 'node:fs';

/**
 * Every migration in this directory, in the order Pedro runs them.
 *
 * Read from the directory rather than listed, so a step added tomorrow is
 * applied by these tests without anybody remembering to add it - which is the
 * same reason step 52 enumerates its tables from the catalogue. `up_to` stops
 * the list early, which is how a test shows a defect existing BEFORE the
 * migration that closes it.
 *
 * cam_crm_schema.sql is first and is not a step: it is the base schema the
 * numbered files alter.
 */
export function migrationFilesInOrder({ upTo = Infinity } = {}) {
  const steps = readdirSync(new URL('./', import.meta.url))
    .map((name) => ({ name, n: Number((/^step_(\d+)_.*\.sql$/.exec(name) || [])[1]) }))
    .filter((entry) => Number.isFinite(entry.n) && entry.n <= upTo)
    .sort((a, b) => a.n - b.n)
    .map((entry) => entry.name);
  return ['cam_crm_schema.sql', ...steps];
}

/**
 * What `authenticated` holds on a table born in a real Supabase `public`.
 *
 * Measured on Pedro's project. `arwdDxtm` is all eight privileges: a=INSERT
 * r=SELECT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES t=TRIGGER m=MAINTAIN.
 * The D and the m are the two nobody enumerates, and the m is the one step 51
 * missed.
 */
export const SUPABASE_BORN_TABLE_ACL =
  '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}';

/** The eight, spelled out, in the order `aclexplode` reports them sorted. */
export const ALL_EIGHT = [
  'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE',
];

/** The four row-level-security governs. Everything else RLS does not see. */
export const DML_FOUR = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * The four RLS cannot govern, which is why they are the point of step 56.
 *
 * TRUNCATE empties a table without consulting a single policy. TRIGGER attaches
 * code to somebody else's write. REFERENCES lets an unaudited table decide
 * whether a row may be deleted. MAINTAIN is PostgreSQL 17's addition and is the
 * proof that enumerating what to remove goes stale.
 */
export const BEYOND_RLS_FOUR = ['TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN'];

// ---------------------------------------------------------------------------
// The objects the migrations expect to find already there.
//
// Everything here models something a real Supabase project has before the first
// migration in this directory runs. Where a shape is guessed rather than
// measured it says so on the line.
// ---------------------------------------------------------------------------
const PREREQUISITES = `
-- The three roles PostgREST authenticates as. service_role is BYPASSRLS, which
-- is why every API route and every ingest endpoint is unaffected by any policy
-- or grant these migrations write.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- supabase_admin owns the SECOND default-privilege line. It exists here so a
-- test can prove what step 56 can and cannot reach.
create role supabase_admin nologin superuser;
create role supabase_auth_admin nologin;

grant usage on schema public to anon, authenticated, service_role;

-- GoTrue's schema. Only three columns of auth.users are read by these
-- migrations (id, email_confirmed_at, last_sign_in_at, via auth_mapping_status);
-- the rest are here so the shape is not misleading to read.
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  phone text,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

-- PostgREST sets request.jwt.claim.sub per request and auth.uid() reads it.
-- Same contract the real policies rely on, so a test can BE a given CAM.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

-- Storage. step 24 makes a bucket and step 28 makes another, and step 43's view
-- loop must not trip over the schema being absent.
create schema if not exists storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now());
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now());
alter table storage.objects enable row level security;
grant select, insert on storage.objects to anon, authenticated;

-- ===========================================================================
-- THE LINE THE OLD HARNESS DID NOT HAVE, AND THE REASON THIS FILE EXISTS.
--
-- A real Supabase project sets these when it is created. Every table any
-- migration in this directory creates therefore carries all eight privileges
-- for anon and authenticated from birth, granted by nobody and reviewed by
-- nobody. This is the mechanism behind the defect step 56 closes, and a harness
-- that omits it cannot see that defect.
--
-- TWO lines, not one: one owned by postgres, one owned by supabase_admin. Both
-- were measured on Pedro's project. Which of them a SQL-editor session can
-- change is what decides whether step 56's default-privileges half is complete,
-- so both are modelled and a test asks.
-- ===========================================================================
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public
  grant all on tables to anon, authenticated, service_role;

-- The sequence and function lines are the same mechanism one object type over.
--
-- NOT MEASURED, and this matters. Pedro's measurement covered defaclobjtype
-- 'r' (tables) only. Nobody has looked at 'f'. A standard Supabase project does
-- set the function line, so it is modelled here - which is the HARSHER
-- assumption, and therefore the safe one: it makes every security-definer
-- function in public anon-callable at birth, so a test can prove whether step
-- 56 needs to close that. If the real project turns out not to have the 'f'
-- line, step 56's function revokes are belt-and-braces rather than a repair,
-- and nothing else about step 56 changes. The query that settles it is in
-- step_56's header.
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
`;

/**
 * Boots PostgreSQL, installs the prerequisites, proves the prerequisites model
 * Supabase, then applies each named migration in order exactly as it stands on
 * disk.
 *
 * @param {string[]} migrationFileNames names relative to this directory.
 * @param {{ applyTwice?: boolean, reapply?: string[] }} [options]
 *   `applyTwice` runs the whole list a second time, which is how Pedro would
 *   re-run a step he is not sure landed. `reapply` runs a named subset again
 *   AFTER the list, which is how you prove a lockdown survives somebody
 *   re-running an earlier migration on top of it.
 */
export async function startMigrationCluster(migrationFileNames, options = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(PREREQUISITES);
  await assertSupabaseGrantFidelity(db);

  const passes = options.applyTwice ? 2 : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    for (const name of migrationFileNames) await applyFile(db, name);
  }
  for (const name of options.reapply || []) await applyFile(db, name);
  return db;
}

/**
 * THE ONLY PLACE THIS HARNESS IS ALLOWED TO DEVIATE FROM THE FILES, and every
 * entry has to earn it in a comment.
 *
 * This is not a convenience hatch. Each one below is a point where the files in
 * this directory CANNOT be replayed from empty on real PostgreSQL either - they
 * describe the history of a database that was built by a path, not by a clean
 * replay - and the deviation reproduces what that path left behind. If a fixup
 * is ever added here to make a test pass, the test is worthless; the rule is
 * that a fixup may only restate something independently verifiable.
 */
const HISTORY_FIXUPS = {
  // ONE root cause, in both directions: step_1 and step_7 define
  // public.auth_mapping_status with incompatible column lists, and PostgreSQL
  // only lets `create or replace view` ADD columns at the END.
  //
  //   step_1 has cam_profile_key in position 7.
  //   step_7 has app.status in position 7 and cam_profile_key in 8.
  //
  // So step_7 after step_1 raises
  //   cannot change name of view column "cam_profile_key" to "status"
  // and step_1 again after step_7 raises
  //   cannot drop columns from view
  // on ANY PostgreSQL, not only here - both verified on PostgreSQL 18 by running
  // them. The two files cannot be replayed in sequence, and they cannot be
  // replayed twice. That is a real defect in this directory rather than a
  // limitation of this harness, and it is pre-existing: step 56 neither causes
  // it nor depends on it.
  //
  // Dropping the view first is safe because the view is a hand-check helper that
  // nothing in the application reads - step 43 sets security_invoker on it and
  // revokes it from anon, and src/ never names it. Each file then recreates it
  // in its own shape, which is what the real project would hold after whichever
  // of the two ran last.
  'step_1_auth_setup.sql': 'drop view if exists public.auth_mapping_status;',
  'step_7_user_management.sql': 'drop view if exists public.auth_mapping_status;',
};

async function applyFile(db, name) {
  const fixup = HISTORY_FIXUPS[name];
  if (fixup) await db.exec(fixup);
  const sql = readFileSync(new URL(name, import.meta.url), 'utf8');
  try {
    await db.exec(sql);
  } catch (error) {
    try { await db.exec('rollback'); } catch { /* not in a transaction */ }
    // The name of the file that failed, in front of the database's own message,
    // with the original kept as `cause` so the SQLSTATE is not lost.
    throw new Error(`${name}: ${String(error.message || error)}`, { cause: error });
  }
}

/** The fixups, exported so a test can assert the list has not grown quietly. */
export const DECLARED_HISTORY_FIXUPS = Object.keys(HISTORY_FIXUPS);

/**
 * Applies one migration file and returns what it said on the way through.
 *
 * WHY A NOTICE IS WORTH CAPTURING. Step 56 grants the four DML verbs to a table
 * it has never been told about and RAISES A NOTICE naming it, deliberately,
 * rather than refusing to run - a migration that had to be edited every time a
 * table landed would be the stale list it exists to replace. That makes the
 * NOTICE the whole of the warning, and a warning nothing asserts is a comment.
 *
 * PGlite passes `onNotice` straight through from the wire protocol, so this is
 * the real NOTICE the Supabase SQL editor would print, not a reconstruction.
 *
 * @param {object} db a cluster from startMigrationCluster.
 * @param {string} name a migration file name in this directory.
 * @returns {Promise<string[]>} every NOTICE and WARNING message, in order.
 */
export async function applyFileCollectingNotices(db, name) {
  const notices = [];
  const fixup = HISTORY_FIXUPS[name];
  if (fixup) await db.exec(fixup);
  const sql = readFileSync(new URL(name, import.meta.url), 'utf8');
  await db.exec(sql, { onNotice: (notice) => notices.push(String(notice.message || '')) });
  return notices;
}

/**
 * THE HARNESS VALIDATING ITSELF.
 *
 * Creates a throwaway table and demands that it was born with exactly the ACL
 * string measured on Pedro's project. If this throws, the prerequisites have
 * drifted away from Supabase and NOTHING asserted against this cluster means
 * anything - a grant test cannot fail against a database that never had the
 * grant. Called on every boot, deliberately not optional.
 */
export async function assertSupabaseGrantFidelity(db) {
  await db.exec('create table public.__fidelity_probe (id int);');
  const acl = await one(db, "select relacl::text from pg_class where relname = '__fidelity_probe'");
  await db.exec('drop table public.__fidelity_probe;');
  if (acl !== SUPABASE_BORN_TABLE_ACL) {
    throw new Error(
      'migrationCluster prerequisites no longer model Supabase.\n'
      + `  a table born here holds: ${acl}\n`
      + `  Pedro's project gives:   ${SUPABASE_BORN_TABLE_ACL}\n`
      + 'Every grant assertion against this cluster is void until that matches.',
    );
  }
  return acl;
}

/** The scalar in the first column of the first row, which is all most need. */
export async function one(db, sql, params) {
  const result = await db.query(sql, params);
  const row = result.rows[0];
  return row ? row[Object.keys(row)[0]] : undefined;
}

/** Every value of the first column, as an array. */
export async function column(db, sql, params) {
  const result = await db.query(sql, params);
  if (!result.rows.length) return [];
  const key = Object.keys(result.rows[0])[0];
  return result.rows.map((row) => row[key]);
}

/**
 * What a role actually holds on a table, asked of the catalogue.
 *
 * `has_table_privilege` rather than reading relacl by hand, because it resolves
 * the PUBLIC pseudo-role and role membership - "can this role do this", which is
 * the question, rather than "is there an ACL entry", which is not.
 */
export async function privilegesOn(db, role, table) {
  const held = [];
  for (const priv of ALL_EIGHT) {
    const yes = await one(db, 'select has_table_privilege($1, $2, $3)', [role, `public.${table}`, priv]);
    if (yes) held.push(priv);
  }
  return held;
}

/**
 * Runs a statement AS a role, in a transaction that is always rolled back, and
 * returns the error text instead of throwing.
 *
 * This is the only way to prove a privilege claim. `has_table_privilege` reads
 * the catalogue; this one makes the database refuse, which is what the CAM in
 * the browser would experience. TRUNCATE in particular must be proved this way:
 * it is not subject to row level security, so no policy test says anything about
 * it.
 *
 * @param {string|null} subject a uuid for request.jwt.claim.sub, so the row
 *   level security policies see a specific signed-in user.
 * @returns {Promise<string|null>} null when it succeeded, the error otherwise.
 */
export async function refusalAsRole(db, role, sql, { params, subject } = {}) {
  let out = null;
  try {
    await db.exec('begin');
    if (subject !== undefined) {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', subject ?? '']);
    }
    await db.exec(`set local role ${role}`);
    await db.query(sql, params);
  } catch (error) {
    out = String(error.message || error);
  } finally {
    try { await db.exec('rollback'); } catch { /* already gone */ }
  }
  return out;
}

/** Same, but returns the rows a role could read. Throws if the role is refused. */
export async function rowsAsRole(db, role, sql, { params, subject } = {}) {
  try {
    await db.exec('begin');
    if (subject !== undefined) {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', subject ?? '']);
    }
    await db.exec(`set local role ${role}`);
    const result = await db.query(sql, params);
    return result.rows;
  } finally {
    try { await db.exec('rollback'); } catch { /* already gone */ }
  }
}

/**
 * Can the session change ANOTHER role's default privileges?
 *
 * The question step 56's header has to answer for Pedro, and it is a property of
 * role membership rather than of this harness: `alter default privileges for
 * role X` requires membership in X. PGlite's postgres is a superuser and so can;
 * Supabase's postgres is not. The probe therefore runs as a deliberately
 * non-superuser, non-member role, which is the shape Supabase's SQL editor has.
 */
export async function canAlterDefaultPrivilegesForRole(db, owner) {
  await db.exec('create role probe_not_a_member nologin;');
  const error = await refusalAsRole(
    db, 'probe_not_a_member',
    `alter default privileges for role ${owner} in schema public grant all on tables to anon`,
  );
  await db.exec('drop role probe_not_a_member;');
  return { allowed: error === null, error };
}
