/* WHAT THIS MIGRATION HAS TO KEEP TRUE - AND WHY MOST OF IT IS PROVED AGAINST A
 * RUNNING POSTGRES RATHER THAN AGAINST THE TEXT OF THE FILE.
 *
 * Every other migration test in this directory reads the SQL and asserts that it
 * SAYS something. That is cheap and it has caught real mistakes, and it cannot
 * catch a mistake in what the SQL DOES. A sibling suite in this repository
 * shipped 89 assertions of which 54 only checked for a string, and fourteen real
 * mutations passed all 89 - including one that dropped the heartbeat function the
 * whole fleet calls.
 *
 * So `@electric-sql/pglite` boots PostgreSQL 18 in process: no server, no port,
 * no Docker, about a second to start, and `npm ci` is the whole installation. The
 * assertions below then ASK THE DATABASE. Whether a CHECK refuses a bad hand
 * edit, whether an omitted account survives, whether an older sample can walk a
 * newer one backwards, whether a CAM can forge a green light - each of those is a
 * question about behaviour, and each is answered by doing it.
 *
 * (The same dependency and the same reasoning arrive with the unmerged step 54 on
 * dev/deep-export-service-floor, which added supabase/migrationCluster.js. This
 * file boots its own cluster instead of importing that one because step 55's
 * policies call step 52's helpers, which that harness's prerequisites do not
 * create. The devDependency line is byte-identical to the one on that branch, so
 * the two merge without a conflict.)
 *
 * WHAT IT CANNOT DO, said plainly so a green suite is not mistaken for the whole
 * story. PGlite is a single connection, so nothing here proves anything about two
 * reports from one machine genuinely racing; the `sampled_at` guard on the upsert
 * is proved by applying the two reports in the wrong order, which is the outcome
 * the race produces and not the race itself. Nothing here exercises PostgREST,
 * Supabase's own default grants, or the service role's BYPASSRLS - the
 * prerequisites below reproduce those by hand, which means they are an assumption
 * this file makes rather than a fact it proves.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_55_account_live_samples.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
// The executable half. This header argues at length about what it refuses and
// why, and no assertion about a statement may be satisfied by that argument.
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join(' ')
  .toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

function functionDefinition(name) {
  const match = raw.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`,
    'i',
  ));
  return match?.[0].toLowerCase().replace(/\s+/g, ' ') ?? '';
}

/* The objects step 55 references and does not create, in the shape production has
 * them: the three Supabase roles, Supabase's own default grants on public (which
 * is why step 51 had to REVOKE rather than simply not grant), `auth.uid()`, the
 * four tables the policies reach, and step 52's two helpers.
 *
 * THE DEFAULT PRIVILEGE LINE IS `grant all`, AND IT HAS TO BE, because that is
 * what Supabase sets and the difference is not cosmetic. This file previously
 * wrote `grant select, insert, update, delete`, which is the set a reader expects
 * "everything the browser could do" to mean, and it is four of eight. Measured on
 * the real project:
 *
 *   default privileges in schema public:
 *     anon=arwdDxtm/postgres   authenticated=arwdDxtm/postgres
 *
 * The letters are INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER,
 * MAINTAIN - and the same `alter default privileges ... grant all` reproduces that
 * ACL byte for byte on the PostgreSQL 18 this file boots. The missing four are the
 * dangerous ones, and TRUNCATE is the dangerous one of those: it is NOT SUBJECT TO
 * ROW LEVEL SECURITY AT ALL, so every policy step 52 and step 53 installed is a
 * statement about rows that a TRUNCATE never asks. It empties the table.
 *
 * A harness that models the world as safer than it is makes every assertion in it
 * a decoration: under the old four-privilege line no assertion in this file COULD
 * have seen a grant hole, because the hole was not granted in the first place.
 *
 * AND `service_role` IS ON THE LINE TOO, which it was not before and which is the
 * same failure in the other direction. Supabase's own statement names four roles -
 * `grant all on tables to postgres, anon, authenticated, service_role` - and with
 * service_role missing here it held NOTHING on the two new tables, so a revoke one
 * role too far was invisible to this file. It is not a hypothetical: the client
 * page's panel reads both tables through server/autoCollection/admin/
 * ingest-status.js:143,163, which runs on the service role. A migration that
 * revoked from `anon, authenticated, service_role` would have 500'd that route on
 * every load with this suite green. `postgres` is omitted only because PGlite runs
 * as that role already and granting a role to itself is a no-op. */
const PREREQUISITES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;

create schema if not exists auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null);
create table public.cam_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null);
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid,
  cam_profile_id uuid,
  role text,
  status text);
create table public.client_assignments (
  client_id uuid not null references public.clients(id) on delete cascade,
  cam_profile_id uuid not null references public.cam_profiles(id) on delete cascade);
create table public.ingest_devices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null default 'active',
  revoked_at timestamptz,
  last_seen_at timestamptz,
  agent_version text,
  schedule_timezone text not null default 'America/New_York');
alter table public.clients enable row level security;
alter table public.cam_profiles enable row level security;
alter table public.app_users enable row level security;
alter table public.client_assignments enable row level security;
alter table public.ingest_devices enable row level security;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.app_users u
    where u.auth_user_id = auth.uid() and u.role = 'Manager'
      and coalesce(u.status, 'Active') <> 'Inactive');
$$;
create or replace function public.assigned_client_ids() returns setof uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select a.client_id from public.client_assignments a
  join public.app_users u on u.cam_profile_id = a.cam_profile_id
  where u.auth_user_id = auth.uid() and coalesce(u.status, 'Active') <> 'Inactive';
$$;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.assigned_client_ids() to authenticated;
`;

const AUTH_GRAY = '11111111-1111-4111-8111-111111111111';
const AUTH_BIRCH = '22222222-2222-4222-8222-222222222222';
const AUTH_MANAGER = '33333333-3333-4333-8333-333333333333';

let db;
/** The two clients, each with its own CAM and its own paired VPS. */
const world = {};

/** One scalar, which is all most of these need. */
async function one(statement, params) {
  const { rows } = await db.query(statement, params);
  const row = rows[0];
  return row ? row[Object.keys(row)[0]] : undefined;
}

/** The refusal text instead of a throw, so a test can say which refusal it was. */
async function refusal(statement, params) {
  try {
    await db.query(statement, params);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

/* RELATIVE CLOCKS, NOT FIXED ONES. The function refuses a sample more than five
 * minutes in the future, so a literal timestamp in a test file starts failing
 * on its own at a particular hour of a particular day. Everything below is
 * expressed as "this many minutes ago". */
function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/* Ten minutes passing, without ten minutes passing. The throttle compares now
 * against the newest `reported_at` this device wrote, so backdating that column
 * is exactly what the clock moving on would do - and it leaves `sampled_at`
 * alone, which is the column every other assertion here is about. */
async function tenMinutesPass(deviceId) {
  await db.query(`update public.account_live_samples
    set reported_at = reported_at - interval '10 minutes' where device_id = $1`, [deviceId]);
}

/** One report, the way the route will call it. */
function report(deviceId, sampledAt, accounts) {
  return ['select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as out',
    [deviceId, sampledAt, JSON.stringify(accounts)]];
}

async function send(deviceId, sampledAt, accounts) {
  return one(...report(deviceId, sampledAt, accounts));
}

/** Everything a signed-in browser session does, as that session. */
async function asSession(authUserId, statement, params) {
  await db.exec('begin');
  try {
    await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', authUserId || '']);
    await db.exec('set local role authenticated');
    const { rows } = await db.query(statement, params);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error: String(error.message || error) };
  } finally {
    await db.exec('rollback');
  }
}

async function asAnon(statement, params) {
  await db.exec('begin');
  try {
    await db.exec('set local role anon');
    const { rows } = await db.query(statement, params);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error: String(error.message || error) };
  } finally {
    await db.exec('rollback');
  }
}

/* THE REFUSAL, OR THE SENTENCE THAT SAYS THERE WAS NONE.
 *
 * `attempt.error` is null when the statement went through, and `.toMatch(/.../)` on
 * null fails with `TypeError: .toMatch() expects to receive a string, but got
 * object` - which is a red test that tells the reader nothing. Measured against the
 * three-verb lockdown: four of the tests below failed with exactly that line and
 * not one of them said that a CAM had just emptied the table.
 *
 * With this, the same four read
 *
 *   AssertionError: gray truncates account_live_samples: expected
 *     '(no error - it went through)' to match /permission denied for table .../
 *
 * which is the defect, in the failure, in the words the migration header uses. */
function refusalOf(attempt) {
  return attempt.error ?? '(no error - it went through)';
}

/* THE SAME THING, COMMITTED, for the statements whose whole point is the effect.
 *
 * `asSession` and `asAnon` roll back, which is right for them: they assert on the
 * refusal text or on what a RETURNING clause handed back, and rolling back keeps
 * one test from leaking into the next.
 *
 * TRUNCATE has no RETURNING and nothing to inspect but the table afterwards, so
 * under a rollback "the rows are still there" is true whatever the database
 * decided - the assertion would be measuring the harness. Measured: the control
 * below, which GRANTS truncate back and expects the table to empty, read 1 row
 * instead of 0 under `asSession`, because the rollback had put the rows back. The
 * one place in this file where the proof has to survive the transaction. */
async function asRoleCommitting(role, statement, authUserId) {
  await db.exec('begin');
  try {
    if (authUserId !== undefined) {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', authUserId || '']);
    }
    await db.exec(`set local role ${role}`);
    await db.query(statement);
    return { error: null };
  } catch (error) {
    return { error: String(error.message || error) };
  } finally {
    // `reset` on the way out of each test is what keeps this from leaking.
    await db.exec('commit');
  }
}

/** Any role, by name, so "who may call this function" can be asked rather than read. */
async function asRole(role, statement, params) {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${role}`);
    const { rows } = await db.query(statement, params);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error: String(error.message || error) };
  } finally {
    await db.exec('rollback');
  }
}

/* EVERY COLUMN OF EVERY ROW OF ingest_devices, AS ONE STRING.
 *
 * A negative search for `record_ingest_heartbeat` or `last_seen_at` over the
 * migration text cannot see dynamic SQL, cannot see a trigger, and is vacuously
 * true on a file of nothing but comments - all three measured. `t::text` on the
 * whole row is the behavioural form of the same question: if anything about any
 * device changed, this string changes, whatever wrote it and however. */
async function heartbeatFingerprint() {
  return one(`select coalesce(string_agg(device::text, '|' order by device.id), '<no devices>')
    from public.ingest_devices as device`);
}

/* EVERY COLUMN OF EVERY ROW OF EVERY TABLE IN `public`, AS ONE STRING.
 *
 * This is the behavioural form of "the migration destroys no data", and it exists
 * because the textual form could not be fixed. The claim used to be
 * `expect(sql).not.toMatch(/truncate/)` - a bare substring, meant to say "this
 * migration truncates nothing". It cannot tell `revoke truncate` from
 * `truncate table`, so adding the revoke the two tables NEED turned the suite red
 * and a textual test stood in front of a security fix.
 *
 * Asked this way the word is irrelevant, which is the point: the question is not
 * whether a string appears in the file, it is whether the rows are still there
 * afterwards. And it is every table rather than the two new ones, because
 * `truncate public.ingest_devices` would pass a check scoped to this feature while
 * un-pairing the whole fleet. */
async function databaseFingerprint() {
  const { rows } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`);
  const parts = [];
  for (const { tablename } of rows) {
    parts.push(`${tablename}: ${await one(
      `select coalesce(string_agg(t::text, '|' order by t::text), '<empty>')
       from public.${tablename} as t`)}`);
  }
  return parts.join('\n');
}

/* WHAT A ROLE ACTUALLY HOLDS ON A TABLE, AS A COMPLEMENT RATHER THAN A LIST.
 *
 * Every privilege assertion in this file used to name the privileges it cared
 * about - INSERT, UPDATE, DELETE - and a named list can only ever be as complete
 * as the person writing it. Supabase grants EIGHT (`arwdDxtm`), the committed
 * revoke took three, and no assertion here could see the five that were left
 * because none of them was asked about.
 *
 * `aclexplode` is the other direction: it reports what IS granted, so the
 * assertion is `exactly SELECT` and there is no list to go stale. A ninth
 * privilege in a future PostgreSQL is covered the day it exists. */
async function privilegesHeldOn(role, table) {
  return one(
    `select coalesce(string_agg(distinct entry.privilege_type, ',' order by entry.privilege_type), '<none>')
     from pg_catalog.pg_class as rel, aclexplode(rel.relacl) as entry
     where rel.relname = $1 and rel.relnamespace = 'public'::regnamespace
       and entry.grantee = $2::regrole`, [table, role]);
}

/** The whole table emptied, so each behavioural test starts from nothing. */
async function reset() {
  await db.exec('delete from public.account_live_samples');
  await db.exec(`update public.account_tracker_settings
    set sample_interval_seconds = 600, stale_sample_seconds = 1500,
        min_report_interval_seconds = 60, max_accounts_per_report = 100,
        retention_days = 7, min_agent_version = null where id`);
}

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = await PGlite.create();
  await db.exec(PREREQUISITES);
  // Applied exactly as the file stands on disk, twice: re-running a step he is
  // not sure landed is how Pedro uses this directory.
  await db.exec(raw);
  await db.exec(raw);

  world.grayClient = await one("insert into public.clients (name) values ('Gray Elm') returning id");
  world.birchClient = await one("insert into public.clients (name) values ('Avery Birch') returning id");
  world.grayCam = await one("insert into public.cam_profiles (name) values ('Peter') returning id");
  world.birchCam = await one("insert into public.cam_profiles (name) values ('Quinn') returning id");
  await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
    [world.grayClient, world.grayCam]);
  await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
    [world.birchClient, world.birchCam]);
  await db.query(`insert into public.app_users (auth_user_id, cam_profile_id, role, status)
    values ($1, $2, 'CAM', 'Active')`, [AUTH_GRAY, world.grayCam]);
  await db.query(`insert into public.app_users (auth_user_id, cam_profile_id, role, status)
    values ($1, $2, 'CAM', 'Active')`, [AUTH_BIRCH, world.birchCam]);
  await db.query(`insert into public.app_users (auth_user_id, role, status)
    values ($1, 'Manager', 'Active')`, [AUTH_MANAGER]);
  world.grayDevice = await one(
    'insert into public.ingest_devices (client_id) values ($1) returning id', [world.grayClient]);
  world.birchDevice = await one(
    'insert into public.ingest_devices (client_id) values ($1) returning id', [world.birchClient]);
  world.revokedDevice = await one(
    `insert into public.ingest_devices (client_id, status, revoked_at)
     values ($1, 'revoked', now()) returning id`, [world.birchClient]);
}, 60_000);

afterAll(async () => { await db?.close?.(); });

/* ── The file, and the runbook it is read from ─────────────────────────────── */

describe('step 55 is no longer the one that runs last', () => {
  it('appears once, and 56 now carries the highest-number claim', () => {
    /* HANDED ON, the way step 52 handed it to 53 and 53 handed it here. The
     * `Math.max` assertion lives in the newest step's own test, because leaving it
     * behind makes every later migration look like a break in this one - and that
     * is exactly what happened: step 56 merged after this file and this assertion
     * failed, naming 55 as the highest when 56 was. A one-line change, and the
     * convention working rather than failing.
     *
     * 54 is still claimed by an unmerged draft whose own test asserts its number,
     * so the gap is deliberate and this header has to say so or somebody closes
     * it. */
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 55)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThan(55);
    expect(numbers).not.toContain(54);
    expect(raw).toMatch(/WHY 55 AND NOT 54/);
  });

  it('is in the runbook table, in the run order, and says what not running it costs', () => {
    expect(runbook).toMatch(/^\| 55 \| `step_55_account_live_samples\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 55 | `step_55_account_live_samples.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 53 | `step_53_client_creation_under_rls.sql`'));
    expect(runbook).toMatch(/→ 53 → 55(?: →|\.)/);
    expect(runbook).toContain('55 degrades gracefully');
  });

  it('adds without dropping or rewriting anything, as far as reading the file can tell', () => {
    expect(sql).toContain('create table if not exists public.account_live_samples');
    expect(sql).toContain('create table if not exists public.account_tracker_settings');

    /* AND `truncate` IS NOT IN THIS LIST ANY MORE, which is the whole lesson of
     * the group. It used to be `expect(sql).not.toMatch(/truncate/)`: a bare
     * substring standing in for "this migration truncates nothing". It cannot tell
     * `revoke truncate` from `truncate table`, and the two new tables NEED
     * `revoke truncate` - Supabase hands it to anon and authenticated on every new
     * table in public and TRUNCATE ignores row level security entirely. So the
     * correct security fix turned this assertion red:
     *
     *   AssertionError: expected ' begin; create table if not exists pu…'
     *     not to match /truncate/
     *   ❯ supabase/step_55_account_live_samples.test.js:315:21
     *
     * A textual test standing in front of a security fix. The answer is not a
     * cleverer regex - `/truncate\s+table/` would pass today and says nothing about
     * what the file DOES. The claim is "applying this file destroys no data", which
     * is a claim about behaviour, and it is now asked of a database with rows in it:
     * see 'DESTROYS NO DATA' below.
     *
     * THESE THREE ARE A CHEAP FIRST LOOK AND NOT THE GUARD, the same way the
     * heartbeat's three string checks are. All three pass on a file of nothing but
     * comments and none of them can see dynamic SQL. */
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/drop policy/);
    // No existing table is touched at all. The whole point of a new table with
    // its own function is that nothing already deployed has to change.
    expect(sql).not.toMatch(/alter table public\.ingest_(devices|batches)/);
    expect([...new Set([...sql.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]))].sort())
      .toEqual(['account_live_samples', 'account_tracker_settings']);
  });

  it('leaves the heartbeat alone, as far as reading the file can tell', () => {
    /* The whole reason the sample has its own endpoint, its own table and its
     * own function: the heartbeat's vocabulary is fixed on the server, every
     * deployed agent depends on it staying that way, and the heartbeat is the
     * only thing that says a machine is alive.
     *
     * AND THESE THREE LINES ARE NOT THE GUARD. They are a cheap first look. All
     * three pass on a file stripped to comments, none of them can see dynamic SQL
     * and none of them can see a trigger - and this repository has already watched
     * a string guard walk past a concatenated `drop function`. The guard is
     * "record_account_live_sample never writes a row of ingest_devices", asked of
     * a running Postgres further down. */
    expect(sql).not.toMatch(/record_ingest_heartbeat/);
    expect(sql).not.toMatch(/last_error_code/);
    expect(sql).not.toMatch(/health_status/);
  });

  it('calls step 52 helpers wrapped in a sub-select, never bare', () => {
    /* step_52_rls_by_cam.sql:52-60 measured this: bare, the function runs once
     * per row; wrapped, Postgres hoists it to an InitPlan and runs it once per
     * query. This table is small today, so the bare form would pass every
     * behavioural assertion in this file. Its own words: "a correctness
     * requirement wearing a performance costume." */
    for (const helper of ['is_manager', 'assigned_client_ids']) {
      const all = sql.match(new RegExp(`public\\.${helper}\\(\\)`, 'g')) || [];
      const wrapped = sql.match(new RegExp(`\\(select public\\.${helper}\\(\\)\\)`, 'g')) || [];
      expect(all.length, `${helper} is not called at all`).toBeGreaterThan(0);
      expect(wrapped.length, `${helper} is called bare somewhere`).toBe(all.length);
    }
    expect(sql).toContain('client_id in (select public.assigned_client_ids())');
  });

  it('derives run_state here and never takes it from the wire', () => {
    expect(sql).toMatch(/run_state text generated always as \(/);
    expect(sql).toContain('stored');
    const record = functionDefinition('record_account_live_sample');
    expect(record).not.toMatch(/'run_state'/);
    expect(record).not.toMatch(/\brun_state =/);
    expect(record).not.toMatch(/runstate/);
  });

  it('never takes a tunable from the environment', () => {
    // Pedro cannot set one in Vercel; a merge to main is the whole deployment.
    expect(sql).not.toMatch(/current_setting\('app\./);
    expect(raw).not.toMatch(/process\.env|AUTO_COLLECTION_[A-Z_]+/);
  });
});

/* ── What the tunables refuse, which is the only review a hand edit gets ───── */

describe('the settings singleton', () => {
  it('seeds exactly one row, and a second one is impossible', async () => {
    expect(await one('select count(*)::int from public.account_tracker_settings')).toBe(1);
    expect(await refusal('insert into public.account_tracker_settings (id) values (false)'))
      .toMatch(/account_tracker_settings_singleton/);
    expect(await refusal('insert into public.account_tracker_settings (id) values (true)'))
      .toMatch(/duplicate key|unique/i);
    expect(await one('select count(*)::int from public.account_tracker_settings')).toBe(1);
  });

  it('ships the inert defaults: ten minute samples and NO agent version named', async () => {
    const { rows } = await db.query(`select sample_interval_seconds, stale_sample_seconds,
      min_report_interval_seconds, max_accounts_per_report, retention_days, min_agent_version
      from public.account_tracker_settings where id`);
    expect(rows[0]).toEqual({
      sample_interval_seconds: 600,
      stale_sample_seconds: 1500,
      min_report_interval_seconds: 60,
      max_accounts_per_report: 100,
      retention_days: 7,
      // NULL is what makes the merge harmless: with no build named, no machine
      // is behind, and nothing says "update required" next to a client's name.
      min_agent_version: null,
    });
  });

  it('REFUSES a staleness horizon equal to the sample interval', async () => {
    /* The edit that looks obviously consistent and would make a correctly
     * sampling fleet flicker silent: every healthy sample sits exactly on the
     * boundary, so a slow close or one restart paints a live account dark. */
    expect(await refusal(
      'update public.account_tracker_settings set stale_sample_seconds = 600 where id',
    )).toMatch(/account_tracker_settings_stale_check/);
    expect(await refusal(
      'update public.account_tracker_settings set stale_sample_seconds = 1199 where id',
    )).toMatch(/account_tracker_settings_stale_check/);
    expect(await refusal(
      'update public.account_tracker_settings set stale_sample_seconds = 1200 where id',
    )).toBeNull();
    await reset();
  });

  it('REFUSES raising the interval without the horizon following it', async () => {
    // The pair cannot be edited into the bad state one column at a time either.
    expect(await refusal(
      'update public.account_tracker_settings set sample_interval_seconds = 900 where id',
    )).toMatch(/account_tracker_settings_stale_check/);
    expect(await refusal(`update public.account_tracker_settings
      set sample_interval_seconds = 900, stale_sample_seconds = 1800 where id`)).toBeNull();
    await reset();
  });

  it('REFUSES an interval that would hammer a trading machine', async () => {
    /* These VPSs run NinjaTrader against live prop firm accounts during market
     * hours and the read happens on NinjaTrader's own UI thread. The floor is
     * the guard-rail on the hand edit that would turn ~39 reads a session into
     * ~780. */
    expect(await refusal(
      'update public.account_tracker_settings set sample_interval_seconds = 30 where id',
    )).toMatch(/account_tracker_settings_interval_check/);
    expect(await refusal(
      'update public.account_tracker_settings set sample_interval_seconds = 299 where id',
    )).toMatch(/account_tracker_settings_interval_check/);
    expect(await refusal(
      'update public.account_tracker_settings set sample_interval_seconds = 7200 where id',
    )).toMatch(/account_tracker_settings_interval_check/);
    await reset();
  });

  it('REFUSES a throttle longer than the interval, which would refuse every sample', async () => {
    expect(await refusal(
      'update public.account_tracker_settings set min_report_interval_seconds = 601 where id',
    )).toMatch(/account_tracker_settings_throttle_check/);
    expect(await refusal(
      'update public.account_tracker_settings set min_report_interval_seconds = 0 where id',
    )).toMatch(/account_tracker_settings_throttle_check/);
    expect(await refusal(
      'update public.account_tracker_settings set min_report_interval_seconds = 600 where id',
    )).toBeNull();
    await reset();
  });

  it('REFUSES a version string compareVersions would silently misread', async () => {
    /* compareVersions (src/domain/autoCollectionFleet.js) reads a non-numeric
     * component as 0, so `v1.2.0` compares as 0.0.0 - below every agent in the
     * field - and the whole fleet is quietly told it is up to date while the
     * tracker is never expected of anybody. */
    for (const bad of ['v1.2.0', '1.2', '1.2.0-beta', 'latest', '', '1.2.0.1']) {
      expect(await refusal(
        'update public.account_tracker_settings set min_agent_version = $1 where id', [bad],
      ), `"${bad}" was accepted`).toMatch(/account_tracker_settings_agent_version_check/);
    }
    expect(await refusal(
      "update public.account_tracker_settings set min_agent_version = '1.2.0' where id",
    )).toBeNull();
    await reset();
  });

  it('REFUSES a retention window of zero days, which would sweep every sample it just took', async () => {
    expect(await refusal(
      'update public.account_tracker_settings set retention_days = 0 where id',
    )).toMatch(/account_tracker_settings_retention_check/);
    expect(await refusal(
      'update public.account_tracker_settings set retention_days = 91 where id',
    )).toMatch(/account_tracker_settings_retention_check/);
    await reset();
  });

  it('REFUSES a report cap outside what a terminal could hold', async () => {
    expect(await refusal(
      'update public.account_tracker_settings set max_accounts_per_report = 0 where id',
    )).toMatch(/account_tracker_settings_accounts_check/);
    expect(await refusal(
      'update public.account_tracker_settings set max_accounts_per_report = 501 where id',
    )).toMatch(/account_tracker_settings_accounts_check/);
    await reset();
  });
});

/* ── What the table itself refuses ────────────────────────────────────────── */

describe('the sample row', () => {
  beforeAll(reset);

  it('keys one row per account per device: a re-sample overwrites', async () => {
    await reset();
    const first = await send(world.grayDevice, minutesAgo(20), [
      { accountName: 'APEX-1', connected: true, totalPnl: 100 },
    ]);
    expect(first.recorded).toBe(1);
    await tenMinutesPass(world.grayDevice);
    await send(world.grayDevice, minutesAgo(10), [
      { accountName: 'APEX-1', connected: false, totalPnl: 250 },
    ]);
    const { rows } = await db.query(`select account_name, connected, total_pnl, sampled_at
      from public.account_live_samples where device_id = $1`, [world.grayDevice]);
    expect(rows).toHaveLength(1);
    expect(rows[0].connected).toBe(false);
    expect(Number(rows[0].total_pnl)).toBe(250);
    await reset();
  });

  it('NEVER lets an older sample overwrite a newer one', async () => {
    /* Two reports from one machine can be in flight at once - a retry that was
     * slow, a service restart - and a tracker whose only value is freshness
     * must not be walked backwards by the loser of that race. Applied in the
     * wrong order here, which is the outcome the race produces. */
    await reset();
    await send(world.grayDevice, minutesAgo(10), [
      { accountName: 'APEX-1', connected: true, totalPnl: 250 },
    ]);
    await tenMinutesPass(world.grayDevice);
    await send(world.grayDevice, minutesAgo(20), [
      { accountName: 'APEX-1', connected: false, totalPnl: 100 },
    ]);
    const { rows } = await db.query(`select total_pnl, connected, sampled_at
      from public.account_live_samples where device_id = $1`, [world.grayDevice]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_pnl)).toBe(250);
    expect(rows[0].connected).toBe(true);
    await reset();
  });

  it('KEEPS an account the next sample leaves out - the whole feature', async () => {
    /* Copying step 46's replace-whole here would delete the row at the exact
     * moment the account went dark, and "no row" on a screen is
     * indistinguishable from "this client has no accounts". The one state the
     * desk most needs to see would be the one state the table cannot hold. */
    await reset();
    const firstSeen = minutesAgo(20);
    await send(world.grayDevice, firstSeen, [
      { accountName: 'APEX-1', connected: true },
      { accountName: 'APEX-2', connected: true },
    ]);
    await tenMinutesPass(world.grayDevice);
    const second = await send(world.grayDevice, minutesAgo(10), [
      { accountName: 'APEX-1', connected: true },
    ]);
    expect(second.recorded).toBe(1);
    expect(second.removed).toBe(0);
    const names = (await db.query(`select account_name from public.account_live_samples
      where device_id = $1 order by account_name`, [world.grayDevice])).rows.map((r) => r.account_name);
    expect(names).toEqual(['APEX-1', 'APEX-2']);
    // And APEX-2 still carries the moment it was last seen, which is the only
    // thing that will say on screen how long it has been dark.
    expect(await one(`select sampled_at from public.account_live_samples
      where device_id = $1 and account_name = 'APEX-2'`, [world.grayDevice]))
      .toEqual(new Date(firstSeen));
    await reset();
  });

  it('sweeps a reading older than the retention window, and only for that device', async () => {
    await reset();
    // reported_at is backdated with sampled_at: a row written days ago was also
    // REPORTED days ago, and leaving it at now() would put the report below
    // that triggers the sweep inside the throttle window.
    await db.exec(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, reported_at)
      values ('${world.grayDevice}', '${world.grayClient}', 'OLD-1', false, now() - interval '8 days', now() - interval '8 days'),
             ('${world.grayDevice}', '${world.grayClient}', 'NEW-1', true, now() - interval '2 days', now() - interval '2 days')`);
    await db.exec(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, reported_at)
      values ('${world.birchDevice}', '${world.birchClient}', 'OTHER-OLD', false, now() - interval '9 days', now() - interval '9 days')`);
    const out = await send(world.grayDevice, new Date().toISOString(), [
      { accountName: 'NEW-2', connected: true },
    ]);
    expect(out.removed).toBe(1);
    const names = (await db.query('select account_name from public.account_live_samples order by account_name'))
      .rows.map((r) => r.account_name);
    // The other machine's aged row is untouched: a sweep is the reporting
    // device's own housekeeping and never reaches across the fleet.
    expect(names).toEqual(['NEW-1', 'NEW-2', 'OTHER-OLD']);
    await reset();
  });

  it('derives FOUR run states, and never folds two of them into one word', async () => {
    /* `unmeasured` is not `idle` - "nobody looked" and "the desk switched
     * everything off" lead to opposite actions - and `no_strategies` is neither of
     * those. This column shipped folding (0, 0) into `unmeasured`, so an account
     * the VPS HAD measured and found empty got the screen's sentence "the sample
     * carried no strategy count", which is false about a sample that carried
     * (0, 0). Not a rare row: the collector's own measurement is "14 at 09:21, 9 at
     * 16:30, 0 at 18:28", so every account on the fleet reports (0, 0) overnight. */
    await reset();
    await send(world.grayDevice, minutesAgo(20), [
      { accountName: 'R', connected: true, strategyCount: 3, enabledStrategyCount: 1 },
      { accountName: 'I', connected: true, strategyCount: 3, enabledStrategyCount: 0 },
      { accountName: 'N-none', connected: true, strategyCount: 0, enabledStrategyCount: 0 },
      { accountName: 'U-absent', connected: true },
    ]);
    const { rows } = await db.query(`select account_name, run_state
      from public.account_live_samples order by account_name`);
    expect(rows).toEqual([
      { account_name: 'I', run_state: 'idle' },
      { account_name: 'N-none', run_state: 'no_strategies' },
      { account_name: 'R', run_state: 'running' },
      { account_name: 'U-absent', run_state: 'unmeasured' },
    ]);
    // Four inputs, four words: asserted as a set so a future fold cannot pass by
    // being right about three of them.
    expect(new Set(rows.map((row) => row.run_state)).size).toBe(4);
    await reset();
  });

  it('tells a measured-and-empty account from an unmeasured one through the REAL rpc', async () => {
    /* Driven through record_account_live_sample rather than an insert, because the
     * question is whether the pair survives the wire the agent actually posts on:
     * StrategyLiveCount sends (0, 0) for a collection it read and found empty and
     * (null, null) for one it could not read, "so the wire says which of the two
     * happened", and until now the CRM threw that away. */
    await reset();
    await send(world.grayDevice, minutesAgo(5), [
      { accountName: 'MEASURED-EMPTY', connected: true, strategyCount: 0, enabledStrategyCount: 0 },
      { accountName: 'NOT-MEASURED', connected: true },
    ]);
    const { rows } = await db.query(`select account_name, strategy_count, enabled_strategy_count, run_state
      from public.account_live_samples order by account_name`);
    expect(rows).toEqual([
      { account_name: 'MEASURED-EMPTY', strategy_count: 0, enabled_strategy_count: 0, run_state: 'no_strategies' },
      { account_name: 'NOT-MEASURED', strategy_count: null, enabled_strategy_count: null, run_state: 'unmeasured' },
    ]);
    await reset();
  });

  it('RECOMPUTES run_state when an earlier copy of this file created the column with three words', async () => {
    /* `create table if not exists` does nothing when the table is there, so a
     * database that ran the three-word version of this file would keep printing the
     * false sentence forever and re-running the file - which is how Pedro checks
     * whether a step landed - would not fix it. The block after the table replaces
     * that one DERIVED column.
     *
     * Built here by putting the OLD expression back on the deployed table, with
     * rows in it, and then applying the file as it stands on disk. */
    await reset();
    await db.exec('alter table public.account_live_samples drop column run_state');
    await db.exec(`alter table public.account_live_samples
      add column run_state text generated always as (
        case
          when strategy_count is null or enabled_strategy_count is null then 'unmeasured'
          when strategy_count = 0 then 'unmeasured'
          when enabled_strategy_count > 0 then 'running'
          else 'idle'
        end
      ) stored`);
    const sampledAt = minutesAgo(12);
    await db.query(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, strategy_count, enabled_strategy_count, sampled_at)
      values ($1, $2, 'MEASURED-EMPTY', true, 0, 0, $3::timestamptz),
             ($1, $2, 'NOT-MEASURED', true, null, null, $3::timestamptz),
             ($1, $2, 'RUNNING', true, 4, 2, $3::timestamptz)`,
    [world.grayDevice, world.grayClient, sampledAt]);
    // The collapse, on the old column, before the file is applied: this is what a
    // database that ran the earlier copy is holding right now.
    expect((await db.query(`select run_state from public.account_live_samples
      where account_name in ('MEASURED-EMPTY', 'NOT-MEASURED') order by account_name`))
      .rows.map((row) => row.run_state)).toEqual(['unmeasured', 'unmeasured']);

    await db.exec(raw);

    const { rows } = await db.query(`select account_name, run_state, strategy_count, sampled_at
      from public.account_live_samples order by account_name`);
    expect(rows.map((row) => [row.account_name, row.run_state])).toEqual([
      ['MEASURED-EMPTY', 'no_strategies'],
      ['NOT-MEASURED', 'unmeasured'],
      ['RUNNING', 'running'],
    ]);
    // And the DATA is untouched: the column is derived, so replacing it recomputes
    // from the two integers the sample carried and loses nothing.
    expect(rows.map((row) => row.strategy_count)).toEqual([0, null, 4]);
    for (const row of rows) expect(row.sampled_at).toEqual(new Date(sampledAt));
    // Applying it a third time is a no-op: the guard sees the new word and stops.
    await db.exec(raw);
    expect(await one(`select run_state from public.account_live_samples
      where account_name = 'MEASURED-EMPTY'`)).toBe('no_strategies');
    expect(await one('select count(*)::int from public.account_live_samples')).toBe(3);
    await reset();
  });

  it('REFUSES a NaN or an absurd money value, which would poison every total on screen', async () => {
    /* numeric is unbounded and numeric accepts 'NaN', and both reach a sum on a
     * briefing card. One NaN here turns a client's whole live total into NaN. */
    for (const value of ["'NaN'", '1e13', '-1e13']) {
      expect(await refusal(`insert into public.account_live_samples
        (device_id, client_id, account_name, connected, sampled_at, total_pnl)
        values ($1, $2, 'BAD', true, now(), ${value})`, [world.grayDevice, world.grayClient]),
      `${value} was accepted`).toMatch(/account_live_samples_money_check/);
    }
    expect(await refusal(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, unrealized_pnl)
      values ($1, $2, 'BAD', true, now(), 'NaN')`, [world.grayDevice, world.grayClient]))
      .toMatch(/account_live_samples_money_check/);
    await reset();
  });

  it('REFUSES half a strategy count, which would read idle about an unmeasured account', async () => {
    expect(await refusal(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, strategy_count)
      values ($1, $2, 'HALF', true, now(), 3)`, [world.grayDevice, world.grayClient]))
      .toMatch(/account_live_samples_counts_check/);
    expect(await refusal(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, strategy_count, enabled_strategy_count)
      values ($1, $2, 'MORE', true, now(), 2, 3)`, [world.grayDevice, world.grayClient]))
      .toMatch(/account_live_samples_counts_check/);
    await reset();
  });

  it('REFUSES free text in the status word that reaches a screen', async () => {
    expect(await refusal(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, status)
      values ($1, $2, 'A', true, now(), '<script>x</script>')`, [world.grayDevice, world.grayClient]))
      .toMatch(/account_live_samples_status_check/);
    // An unknown word is a newer platform, not a reason to refuse: shape, not
    // vocabulary. This is the heartbeat's trap, deliberately not repeated.
    expect(await refusal(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at, status)
      values ($1, $2, 'A', true, now(), 'ConnectionLostReconnecting')`,
    [world.grayDevice, world.grayClient])).toBeNull();
    await reset();
  });

  it('REFUSES an untrimmed or empty account name, which would be a second row for one account', async () => {
    for (const name of ['', ' APEX-1', 'APEX-1 ', 'x'.repeat(65)]) {
      expect(await refusal(`insert into public.account_live_samples
        (device_id, client_id, account_name, connected, sampled_at)
        values ($1, $2, $3, true, now())`, [world.grayDevice, world.grayClient, name]),
      `"${name}" was accepted`).toMatch(/account_live_samples_account_name_check/);
    }
    await reset();
  });

  it('follows the device out when it is unpaired, and the client out when it is deleted', async () => {
    await reset();
    const client = await one("insert into public.clients (name) values ('Temp') returning id");
    const device = await one('insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
    await send(device, new Date().toISOString(), [{ accountName: 'T-1', connected: true }]);
    expect(await one('select count(*)::int from public.account_live_samples where device_id = $1', [device])).toBe(1);
    await db.query('delete from public.ingest_devices where id = $1', [device]);
    expect(await one('select count(*)::int from public.account_live_samples where device_id = $1', [device])).toBe(0);
    await db.query('delete from public.clients where id = $1', [client]);
    await reset();
  });
});

/* ── What the function refuses, and what it leaves behind when it does ────── */

describe('record_account_live_sample', () => {
  it('validates every item and writes NOTHING when one is malformed', async () => {
    await reset();
    await send(world.grayDevice, minutesAgo(20), [{ accountName: 'GOOD', connected: true }]);
    await tenMinutesPass(world.grayDevice);
    const malformed = [
      [{ accountName: 'A', connected: true }, { accountName: 'B' }],
      [{ accountName: 'A', connected: 'yes' }],
      [{ accountName: 42, connected: true }],
      [{ connected: true }],
      [{ accountName: 'A', connected: true, totalPnl: 'lots' }],
      [{ accountName: 'A', connected: true, status: 7 }],
      [{ accountName: ' A', connected: true }],
      [{ accountName: 'A', connected: true }, { accountName: 'A', connected: false }],
      'not an array',
      [[]],
    ];
    for (const accounts of malformed) {
      const text = await refusal(...report(world.grayDevice, minutesAgo(10), accounts));
      expect(text, `${JSON.stringify(accounts)} was accepted`).toMatch(/INVALID_ACCOUNT_SAMPLE/);
    }
    // And the row that was already there is exactly as it was: a refused report
    // is not a partial write.
    const { rows } = await db.query('select account_name, connected from public.account_live_samples');
    expect(rows).toEqual([{ account_name: 'GOOD', connected: true }]);
    await reset();
  });

  it('refuses a sample from the future and a sample with no clock at all', async () => {
    await reset();
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(await refusal(...report(world.grayDevice, future, [{ accountName: 'A', connected: true }])))
      .toMatch(/INVALID_ACCOUNT_SAMPLE/);
    expect(await refusal('select public.record_account_live_sample($1, null, $2::jsonb)',
      [world.grayDevice, JSON.stringify([{ accountName: 'A', connected: true }])]))
      .toMatch(/INVALID_ACCOUNT_SAMPLE/);
    // Five minutes of clock skew is tolerated, the way every other ingest
    // endpoint in this repository tolerates it.
    expect(await refusal(...report(world.grayDevice, new Date(Date.now() + 60_000).toISOString(),
      [{ accountName: 'A', connected: true }]))).toBeNull();
    await reset();
  });

  it('refuses more accounts than the settings allow, and the cap is the column', async () => {
    await reset();
    const many = (n) => Array.from({ length: n }, (_, i) => ({ accountName: `A-${i}`, connected: true }));
    expect(await refusal(...report(world.grayDevice, minutesAgo(20), many(101))))
      .toMatch(/INVALID_ACCOUNT_SAMPLE/);
    await db.exec('update public.account_tracker_settings set max_accounts_per_report = 5 where id');
    expect(await refusal(...report(world.grayDevice, minutesAgo(20), many(6))))
      .toMatch(/INVALID_ACCOUNT_SAMPLE/);
    expect(await refusal(...report(world.grayDevice, minutesAgo(20), many(5)))).toBeNull();
    await reset();
  });

  it('refuses a device that is not active, with the code the heartbeat uses', async () => {
    await reset();
    expect(await refusal(...report(world.revokedDevice, minutesAgo(20),
      [{ accountName: 'A', connected: true }]))).toMatch(/INVALID_INGEST_DEVICE/);
    expect(await refusal(...report('44444444-4444-4444-8444-444444444444', minutesAgo(20),
      [{ accountName: 'A', connected: true }]))).toMatch(/INVALID_INGEST_DEVICE/);
    expect(await one('select count(*)::int from public.account_live_samples')).toBe(0);
  });

  it('VALIDATES BEFORE IT THROTTLES, so a payload bug cannot hide inside the window', async () => {
    /* The order is the point. Throttling first would answer a broken agent with
     * "throttled, thank you" for as long as it kept retrying, and a payload bug
     * would be invisible on both ends at once. */
    await reset();
    await send(world.grayDevice, minutesAgo(20), [{ accountName: 'A', connected: true }]);
    const second = await send(world.grayDevice, minutesAgo(10), [{ accountName: 'A', connected: false }]);
    expect(second.throttled).toBe(true);
    expect(second.recorded).toBe(0);
    // Still connected: a throttled report is not a write.
    expect(await one('select connected from public.account_live_samples')).toBe(true);
    // And a malformed report inside the same window is still a 400, not a thank you.
    expect(await refusal(...report(world.grayDevice, minutesAgo(10), [{ accountName: 'A' }])))
      .toMatch(/INVALID_ACCOUNT_SAMPLE/);
    await reset();
  });

  it('hands the tunables back so the fleet is retunable from the SQL editor', async () => {
    await reset();
    await db.exec(`update public.account_tracker_settings
      set sample_interval_seconds = 900, stale_sample_seconds = 2400, min_agent_version = '1.2.0' where id`);
    const out = await send(world.grayDevice, minutesAgo(20), [{ accountName: 'A', connected: true }]);
    expect(out.sample_interval_seconds).toBe(900);
    expect(out.stale_sample_seconds).toBe(2400);
    expect(out.min_agent_version).toBe('1.2.0');
    await reset();
  });

  it('answers with the defaults rather than failing when the settings row is gone', async () => {
    await reset();
    await db.exec('delete from public.account_tracker_settings');
    try {
      const out = await send(world.grayDevice, minutesAgo(20), [{ accountName: 'A', connected: true }]);
      expect(out.recorded).toBe(1);
      expect(out.sample_interval_seconds).toBe(600);
    } finally {
      // Restored whatever happened above: every later test reads this row, and a
      // failure here must not look like a failure there.
      await db.exec('insert into public.account_tracker_settings (id) values (true) on conflict (id) do nothing');
      await reset();
    }
  });

  /* ── THE HEARTBEAT, ASKED OF THE DATABASE AND NOT OF THE FILE ──────────────
   *
   * THE DEFECT: "leaves the heartbeat alone" was three negative string checks and
   * nothing else, so a single line inside the function - `update
   * public.ingest_devices set last_seen_at = v_now where id = p_device_id;` -
   * passed all three and the whole 4024-test suite. Measured against real
   * Postgres: last_seen_at moved from 45 minutes stale, which the fleet view calls
   * Offline, to now, after one tracker sample. The tracker forged the one signal
   * that says a machine is alive, and the migration's own header says that signal
   * is the thing this whole feature exists to protect.
   *
   * SO THE INVARIANT IS BEHAVIOURAL AND IT IS ABOUT EVERY COLUMN, NOT last_seen_at.
   * Every row of ingest_devices, cast to text, before and after. A trigger, a
   * dynamic statement, a cascade, a second function called from inside - all of
   * them change that string and none of them changes a negative grep. */
  it('NEVER writes a row of ingest_devices, which is the only thing that says a machine is alive', async () => {
    await reset();
    // Backdated so that a write would be visible as a change AND as a change with
    // a consequence: the fleet view calls this machine Offline at ten minutes.
    await db.query(`update public.ingest_devices
      set last_seen_at = now() - interval '45 minutes' where id = $1`, [world.grayDevice]);
    const before = await heartbeatFingerprint();
    expect(before).not.toBe('<no devices>');

    const accepted = await send(world.grayDevice, minutesAgo(2), [
      { accountName: 'APEX-1', connected: true, totalPnl: 120, strategyCount: 2, enabledStrategyCount: 2 },
      { accountName: 'APEX-2', connected: false },
    ]);
    expect(accepted.recorded).toBe(2);
    expect(await heartbeatFingerprint()).toBe(before);

    // The throttled answer, which returns early and is the other path out of the
    // function, and a refused one, which raises and rolls back.
    const throttled = await send(world.grayDevice, minutesAgo(1), [{ accountName: 'APEX-1', connected: true }]);
    expect(throttled.throttled).toBe(true);
    expect(await heartbeatFingerprint()).toBe(before);

    await tenMinutesPass(world.grayDevice);
    expect(await refusal(`select public.record_account_live_sample($1, $2::timestamptz, '[{"accountName": 7}]'::jsonb)`,
      [world.grayDevice, minutesAgo(2)])).toMatch(/INVALID_ACCOUNT_SAMPLE/);
    expect(await heartbeatFingerprint()).toBe(before);

    // And the sweep, which is the only statement in the function that deletes.
    await db.query(`update public.account_live_samples
      set sampled_at = now() - interval '9 days', reported_at = now() - interval '9 days'
      where device_id = $1`, [world.grayDevice]);
    const swept = await send(world.grayDevice, minutesAgo(2), [{ accountName: 'APEX-3', connected: true }]);
    expect(swept.removed).toBe(2);
    expect(await heartbeatFingerprint()).toBe(before);

    // Said once in the strongest form: the machine is still as stale as it was, so
    // the fleet view still calls it Offline and the tracker has told it nothing.
    expect(await one(`select last_seen_at < now() - interval '40 minutes'
      from public.ingest_devices where id = $1`, [world.grayDevice])).toBe(true);
    await reset();
  });

  /* ── IDEMPOTENCE, WITH DATA IN THE TABLE ────────────────────────────────────
   *
   * THE DEFECT: beforeAll applies this file twice, but both times before any row
   * exists, so idempotence was only ever tested on an empty table. `delete from
   * public.account_live_samples;` before the COMMIT satisfies every assertion in
   * this file - it is not a drop, not a truncate, not a drop function, not a drop
   * policy - and the full suite stayed 4024 passed. Measured: 1 row before the
   * re-run, 0 rows after. Pedro re-runs steps he is not sure landed; this file's
   * own runbook entry says so. */
  /* ── DESTROYS NO DATA, ASKED OF A DATABASE WITH ROWS IN IT ──────────────────
   *
   * THIS IS THE REPLACEMENT FOR `expect(sql).not.toMatch(/truncate/)`, and it is
   * here because that assertion could not be repaired. It was a bare substring
   * meaning "this migration truncates nothing"; it cannot tell `revoke truncate`
   * from `truncate table`; the two new tables need `revoke truncate` because
   * Supabase grants TRUNCATE to anon and authenticated on every new table in
   * `public` and TRUNCATE is not subject to row level security; so writing the
   * correct security fix turned the suite red at that line.
   *
   * The claim it was reaching for is a claim about what applying the file DOES. So:
   * rows in every table, apply the file, every row still there. Now the word
   * `truncate` appearing in a revoke is irrelevant - which is the point - and a
   * `truncate table` placed anywhere in the file fails this instead, as does a
   * `delete from`, a dynamic `execute`, a destructive trigger, or a `drop table`
   * followed by a `create table` that a text search would read as additive.
   *
   * EVERY TABLE, not the two new ones. `truncate public.ingest_devices` un-pairs
   * the whole fleet and would pass any check scoped to this feature. */
  it('DESTROYS NO DATA: every row of every table in public survives applying the file', async () => {
    await reset();
    const firstSeen = minutesAgo(40);
    await send(world.grayDevice, firstSeen, [
      { accountName: 'KEEP-ME', connected: true, totalPnl: 250, strategyCount: 3, enabledStrategyCount: 1 },
      { accountName: 'GONE-DARK', connected: false },
    ]);
    await db.query(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at)
      values ($1, $2, 'BIRCH-KEEP', true, $3::timestamptz)`,
    [world.birchDevice, world.birchClient, firstSeen]);
    await db.exec(`update public.account_tracker_settings
      set sample_interval_seconds = 900, stale_sample_seconds = 2400, min_agent_version = '1.4.0' where id`);

    const before = await databaseFingerprint();
    // Every table has to have something in it, or "the rows survived" is vacuous
    // for the empty ones and a truncate there would go unnoticed.
    for (const line of before.split('\n')) expect(line, line).not.toMatch(/: <empty>$/);

    // Twice, exactly as it stands on disk. Pedro re-runs steps he is not sure landed.
    await db.exec(raw);
    await db.exec(raw);

    expect(await databaseFingerprint()).toBe(before);
    await reset();
  });

  it('PRESERVES the rows and their clocks when the file is applied again over data', async () => {
    await reset();
    const firstSeen = minutesAgo(40);
    await send(world.grayDevice, firstSeen, [
      { accountName: 'APEX-1', connected: true, totalPnl: 250, strategyCount: 3, enabledStrategyCount: 1 },
      { accountName: 'GONE-DARK', connected: false },
    ]);
    await db.query(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at)
      values ($1, $2, 'BIRCH-1', true, $3::timestamptz)`,
    [world.birchDevice, world.birchClient, firstSeen]);
    await db.exec(`update public.account_tracker_settings
      set sample_interval_seconds = 900, stale_sample_seconds = 2400, min_agent_version = '1.4.0' where id`);
    const rowsBefore = (await db.query(`select account_name, connected, total_pnl::text, run_state,
      sampled_at, reported_at, strategy_count from public.account_live_samples order by account_name`)).rows;
    expect(rowsBefore).toHaveLength(3);

    // Applied again, exactly as it stands on disk, twice, with data in the table.
    await db.exec(raw);
    await db.exec(raw);

    const rowsAfter = (await db.query(`select account_name, connected, total_pnl::text, run_state,
      sampled_at, reported_at, strategy_count from public.account_live_samples order by account_name`)).rows;
    expect(rowsAfter).toEqual(rowsBefore);
    // GONE-DARK is the row the desk most needs: an account that went dark is absent
    // from every later sample and its own sampled_at age is what says when it went.
    expect(rowsAfter.map((row) => row.account_name)).toEqual(['APEX-1', 'BIRCH-1', 'GONE-DARK']);
    expect(await one(`select sampled_at from public.account_live_samples
      where account_name = 'GONE-DARK'`)).toEqual(new Date(firstSeen));

    /* AND THE HAND EDITS SURVIVE, which is the other half of re-running: the
       settings row is a singleton Pedro types into, and a re-run that reset it
       would silently retune the whole fleet back to the defaults. */
    const settings = (await db.query(`select sample_interval_seconds, stale_sample_seconds,
      min_agent_version from public.account_tracker_settings`)).rows;
    expect(settings).toEqual([{
      sample_interval_seconds: 900, stale_sample_seconds: 2400, min_agent_version: '1.4.0',
    }]);
    await reset();
  });

  it('is security definer with a pinned search_path, and says so in the file', () => {
    const record = functionDefinition('record_account_live_sample');
    expect(record).toContain('security definer');
    expect(record).toContain('set search_path = pg_catalog, public');
    expect(sql).toMatch(/revoke all on function public\.record_account_live_sample\(uuid, timestamptz, jsonb\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.record_account_live_sample\(uuid, timestamptz, jsonb\) to service_role/);
    // No `for update` on the device row: there is no delete-what-is-absent to
    // serialise, and the lock would contend with the heartbeat every minute.
    expect(record).not.toMatch(/from public\.ingest_devices as device where device\.id = p_device_id for update/);
  });

  /* ── WHO MAY CALL IT, ASKED BY CALLING IT AS EACH ROLE ──────────────────────
   *
   * THE DEFECT: who may EXECUTE this function was asserted only as the text of the
   * REVOKE line and the GRANT line. Appending one more grant AFTER them -
   * `grant execute ... to authenticated;` - leaves both asserted strings in place
   * and the whole 4024-test suite green. Measured as CAM Gray under role
   * authenticated with that one extra grant in the file: the call returned
   * {"recorded":1,...} against ANOTHER client's device, the table then held
   * {"account_name":"FORGED-GREEN","connected":true,"run_state":"running",
   * "total_pnl":"999999"}, and the CAM read its own forgery back through the SELECT
   * policy.
   *
   * THE RESTRICTIVE DENIAL CANNOT STOP THAT, and that is why this is a separate
   * question from every other RLS assertion here: the function is SECURITY DEFINER,
   * so it runs as the owner and bypasses the policy entirely. The suite proved at
   * length that a CAM cannot INSERT into the table and never once asked whether a
   * CAM can CALL the thing that inserts on its behalf. */
  it('REFUSES the call to every browser-reachable role, asked by calling it', async () => {
    await reset();
    const call = `select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb)`;
    const forgery = JSON.stringify([{
      accountName: 'FORGED-GREEN', connected: true, totalPnl: 999999,
      strategyCount: 3, enabledStrategyCount: 3,
    }]);

    for (const role of ['anon', 'authenticated']) {
      const attempt = await asRole(role, call, [world.grayDevice, minutesAgo(2), forgery]);
      expect(attempt.error, role).toMatch(/permission denied for function record_account_live_sample/);
      expect(attempt.rows, role).toEqual([]);
    }
    // As a real signed-in CAM too, which is the shape that actually reaches
    // PostgREST: the session claim is set and the role is `authenticated`.
    const asCam = await asSession(AUTH_GRAY, call, [world.grayDevice, minutesAgo(2), forgery]);
    expect(asCam.error).toMatch(/permission denied for function record_account_live_sample/);
    // And against ANOTHER client's device, which is the forgery that was proved
    // reachable: still a refusal, and for the same reason.
    const crossClient = await asSession(AUTH_GRAY, call, [world.birchDevice, minutesAgo(2), forgery]);
    expect(crossClient.error).toMatch(/permission denied for function record_account_live_sample/);

    expect(await one('select count(*)::int from public.account_live_samples')).toBe(0);
    await reset();
  });

  it('IS callable by the service role, which is the only caller there is', async () => {
    /* The other half of the same question, because a REVOKE that went one line too
       far would leave the endpoint answering 500 on every report with a green
       suite: the route is the only caller and it holds this role. */
    await reset();
    const accepted = await asRole('service_role',
      'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as out',
      [world.grayDevice, minutesAgo(2), JSON.stringify([{ accountName: 'APEX-1', connected: true }])]);
    expect(accepted.error).toBeNull();
    expect(accepted.rows[0]?.out?.recorded).toBe(1);
    await reset();
  });

  it('and the catalogue agrees, which is what a later blanket grant would change', async () => {
    const signature = 'public.record_account_live_sample(uuid, timestamptz, jsonb)';
    expect(await one(`select has_function_privilege('anon', $1, 'EXECUTE')`, [signature])).toBe(false);
    expect(await one(`select has_function_privilege('authenticated', $1, 'EXECUTE')`, [signature])).toBe(false);
    expect(await one(`select has_function_privilege('service_role', $1, 'EXECUTE')`, [signature])).toBe(true);
    // PUBLIC too: the default on a new function is EXECUTE to PUBLIC, which is why
    // the REVOKE in the file names `public` first and is not merely tidy.
    expect(await one(`select has_function_privilege('public', $1, 'EXECUTE')`, [signature])).toBe(false);
  });
});

/* ── Row Level Security, asked of the database as each session ─────────────── */

describe('who can read and write a live sample', () => {
  beforeAll(async () => {
    await reset();
    await db.exec(`insert into public.account_live_samples
      (device_id, client_id, account_name, connected, sampled_at)
      values ('${world.grayDevice}', '${world.grayClient}', 'GRAY-1', true, now()),
             ('${world.birchDevice}', '${world.birchClient}', 'BIRCH-1', true, now())`);
  });

  it('every new table has row level security and the file says so', async () => {
    expect(await one(`select count(*)::int from pg_tables
      where schemaname = 'public' and not rowsecurity`)).toBe(0);
    expect(sql).toMatch(/raise exception 'step 55 left % table\(s\) without row level security'/);
  });

  it('a CAM sees its own client and no others', async () => {
    const gray = await asSession(AUTH_GRAY,
      'select account_name from public.account_live_samples order by account_name');
    expect(gray.error).toBeNull();
    expect(gray.rows.map((r) => r.account_name)).toEqual(['GRAY-1']);

    const birch = await asSession(AUTH_BIRCH,
      'select account_name from public.account_live_samples order by account_name');
    expect(birch.rows.map((r) => r.account_name)).toEqual(['BIRCH-1']);
  });

  it('a Manager sees the whole fleet', async () => {
    const manager = await asSession(AUTH_MANAGER,
      'select account_name from public.account_live_samples order by account_name');
    expect(manager.rows.map((r) => r.account_name)).toEqual(['BIRCH-1', 'GRAY-1']);
  });

  it('an unrecognised session and the anonymous key see nothing', async () => {
    const stranger = await asSession('99999999-9999-4999-8999-999999999999',
      'select account_name from public.account_live_samples');
    expect(stranger.rows).toEqual([]);
    expect(stranger.error, 'a stranger is filtered by the policy, not refused').toBeNull();
    /* THE TWO ROLES FAIL DIFFERENTLY AND THE DIFFERENCE IS THE POINT. A signed-in
     * session with no assigned clients is FILTERED - the grant lets the read
     * through and the policy admits no row. anon is REFUSED, because the grant is
     * gone: `expect(rows).toEqual([])` would have passed either way, which is how a
     * test comes to assert nothing. */
    const anon = await asAnon('select account_name from public.account_live_samples');
    expect(anon.rows).toEqual([]);
    expect(anon.error).toMatch(/permission denied for table account_live_samples/);
  });

  /* ── WHAT A SIGNED-IN SESSION CAN DO TO THIS TABLE, IN BOTH LAYERS ──────────
   *
   * There are two, they fail in different directions, and the committed suite
   * tested neither of them against DELETE.
   *
   *   THE GRANT. Supabase's default privileges hand `anon` and `authenticated`
   *   INSERT, UPDATE and DELETE on every new table in `public`, which is why step
   *   51 had to REVOKE. A revoked privilege RAISES, and it does not depend on any
   *   policy existing or naming the right verb.
   *
   *   THE POLICY. A RESTRICTIVE policy is what survives step 52 re-writing the
   *   permissive ones. It cannot make a DELETE raise - for DELETE, `using` is a
   *   filter, so `using (false)` means the statement affects nothing and says
   *   nothing - so it is proved on the EFFECT, with the grant put back inside the
   *   test to stand in for a later blanket grant.
   */
  it('a CAM CANNOT forge a green light on its own client: the privilege is gone', async () => {
    /* A read policy with no write denial is step 51's hole with a new table name:
     * a CAM talking to PostgREST with the publishable key could insert a row
     * claiming any of its accounts is connected and running. */
    for (const [verb, statement, params] of [
      ['insert', `insert into public.account_live_samples
          (device_id, client_id, account_name, connected, sampled_at)
          values ($1, $2, 'FORGED', true, now())`, [world.grayDevice, world.grayClient]],
      ['update', `update public.account_live_samples set connected = false
          where account_name = 'GRAY-1' returning account_name`, undefined],
      /* THE ONE THE SHIPPED FILE LET THROUGH. `with check (false)` refuses INSERT
       * and UPDATE because both make a new row for the check to refuse; a DELETE
       * makes none and was judged by `using`, which was `true`. */
      ['delete', `delete from public.account_live_samples
          where account_name = 'GRAY-1' returning account_name`, undefined],
    ]) {
      const attempt = await asSession(AUTH_GRAY, statement, params);
      expect(attempt.error, verb).toMatch(/permission denied for table account_live_samples/);
      const asAnonymous = await asAnon(statement, params);
      expect(asAnonymous.error, `${verb} as anon`).toMatch(/permission denied for table account_live_samples/);
    }
    // A Manager too: this is not about which clients a session can see.
    expect((await asSession(AUTH_MANAGER,
      `delete from public.account_live_samples returning account_name`)).error)
      .toMatch(/permission denied for table account_live_samples/);

    expect(await one('select count(*)::int from public.account_live_samples')).toBe(2);
    expect(await one("select connected from public.account_live_samples where account_name = 'GRAY-1'"))
      .toBe(true);
    expect(await one("select count(*)::int from public.account_live_samples where account_name = 'FORGED'"))
      .toBe(0);
    /* Asked of the catalogue as well, because that is the thing a later migration
     * or a blanket grant changes - AND ASKED AS A COMPLEMENT RATHER THAN A LIST.
     *
     * This loop used to name INSERT, UPDATE and DELETE. Supabase grants eight
     * (`arwdDxtm`), so naming three meant five privileges nothing in this file
     * could see, and four of them were still granted: TRUNCATE, TRIGGER,
     * REFERENCES, MAINTAIN. A named list is only ever as complete as the person
     * writing it, and step 51's own list already forgot MAINTAIN.
     *
     * So: exactly SELECT, and nothing else, with no list to go stale. SELECT has to
     * be there or the overview loses its one-request read of a whole book.
     *
     * AND NOTHING AT ALL FOR anon, which is a narrowing step 56 made to this file.
     * The draft granted SELECT to `anon, authenticated` by symmetry with the revoke
     * and without rechecking it - the same move that put step 51's wrong claim on
     * app_users. Rechecked: the one browser reader
     * (loadSupabaseAccountTracker, called from one effect that returns early
     * without a signed-in client list) always runs as `authenticated`, both SELECT
     * policies below are `to authenticated`, and the /database probe - the one read
     * that happens with no session - names neither table. So the anon grant
     * returned `200 []` and bought nothing, and a dead grant is one a policy added
     * later turns live by accident. */
    for (const table of ['account_live_samples', 'account_tracker_settings']) {
      expect(await privilegesHeldOn('authenticated', table), `authenticated on ${table}`).toBe('SELECT');
      expect(await privilegesHeldOn('anon', table), `anon on ${table}`).toBe('<none>');
    }
  });

  /* ── THE DELETE, AND WHY THE POLICY LAYER NEEDED A SECOND POLICY ─────────────
   *
   * THE DEFECT: the restrictive denial was a single `for all ... using (true) with
   * check (false)`, and `with check` does not govern DELETE. Every other
   * restrictive denial in this repository - step_28 (four of them), step_45:492,
   * step_46:268 - uses `using (false)`.
   *
   * IT ONLY BITES AFTER STEP 52 IS RE-RUN, which is exactly the scenario this
   * file's own header says to expect, because re-running is how step 52 picks up
   * tables added after it. Before the re-run there is no permissive DELETE policy
   * at all, so RLS filters every row out and a delete affects nothing - which is
   * why the committed baseline passed and proved nothing about this. Measured with
   * step 52's loop A policy installed verbatim and the grant present: INSERT
   * refused by name, UPDATE refused by name, and `delete ... returning
   * account_name` returned [{"account_name":"GRAY-1"}], committed, row gone.
   *
   * AND `using (false)` ON THE EXISTING POLICY IS NOT THE FIX: `using` is also what
   * SELECT is judged by, and the overview's whole read depends on it. Mutated that
   * way, three tests fail.
   *
   * THE GRANT IS PUT BACK INSIDE THIS TEST, deliberately. The point is to prove the
   * POLICY holds on its own, in the world where somebody has handed the write
   * privilege back - a later migration, a hand edit, a blanket grant - because
   * defence in depth that is only ever tested with the outer layer in place is not
   * tested at all. */
  it('the write denial is RESTRICTIVE and covers DELETE, which is what survives a re-run of step 52', async () => {
    /* Step 52's loop A gives every `client_id` table `for all to authenticated
     * using <predicate> with check <predicate>` - read AND WRITE - and drops only
     * PERMISSIVE policies on its way through. Reproduced by doing to this table
     * exactly that: drop every permissive policy, then install step 52's own. */
    const dropped = (await db.query(`select policyname from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'account_live_samples'
        and permissive = 'PERMISSIVE'`)).rows.map((row) => row.policyname);
    // The re-run really does take the read policy away and put its own back, which
    // is what makes this a faithful reproduction rather than an extra policy added
    // beside the shipped ones.
    expect(dropped).toEqual(['cam sees its own clients']);
    for (const name of dropped) {
      await db.exec(`drop policy "${name}" on public.account_live_samples`);
    }
    await db.exec(`create policy "cam sees its own clients"
      on public.account_live_samples for all to authenticated
      using ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))
      with check ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))`);
    await db.exec('grant insert, update, delete on public.account_live_samples to anon, authenticated');
    try {
      const inserted = await asSession(AUTH_GRAY,
        `insert into public.account_live_samples
          (device_id, client_id, account_name, connected, sampled_at)
          values ($1, $2, 'FORGED-AFTER-52', true, now())`, [world.grayDevice, world.grayClient]);
      expect(inserted.error).toMatch(/row-level security|violates/i);
      expect(inserted.error).toContain('account_live_samples deny browser writes');

      const updated = await asSession(AUTH_GRAY,
        `update public.account_live_samples set connected = false
         where account_name = 'GRAY-1' returning account_name`);
      expect(updated.error).toMatch(/row-level security|violates/i);

      /* THE DELETE, ASSERTED ON THE EFFECT, because a DELETE that RLS filters to
         nothing raises nothing either - the restrictive `using (false)` makes the
         row invisible to the statement. So the row is shown to be THERE and
         readable first, which is what separates "refused" from "matched nothing":
         the CAM can see GRAY-1 and still cannot remove it. */
      expect((await asSession(AUTH_GRAY,
        `select account_name from public.account_live_samples where account_name = 'GRAY-1'`))
        .rows.map((row) => row.account_name)).toEqual(['GRAY-1']);
      const deleted = await asSession(AUTH_GRAY,
        `delete from public.account_live_samples
         where account_name = 'GRAY-1' returning account_name`);
      expect(deleted.rows).toEqual([]);

      // Counted by the owner, because the harness rolls each session back and a
      // rollback would hide a successful delete behind a clean-looking table.
      expect(await one('select count(*)::int from public.account_live_samples')).toBe(2);
      expect(await one("select connected from public.account_live_samples where account_name = 'GRAY-1'"))
        .toBe(true);

      // And reading still works, which is what makes the re-run harmless.
      const read = await asSession(AUTH_GRAY, 'select account_name from public.account_live_samples');
      expect(read.rows.map((r) => r.account_name)).toEqual(['GRAY-1']);
    } finally {
      // The file itself puts the shipped policies and the REVOKE back, which is
      // also one more proof that re-running it is safe.
      await db.exec('drop policy "cam sees its own clients" on public.account_live_samples');
      await db.exec(raw);
    }
  });

  it('and the DELETE policy is what did the work there, not the grant that was handed back', async () => {
    /* The control for the test above: with the same permissive `for all` policy
       installed and the grant restored, removing the restrictive DELETE policy -
       which is the file as it shipped - lets the CAM delete its own client's row,
       committed. Run here so that the fix is known to be the thing that holds
       rather than something else in the file. */
    await db.exec(`drop policy "cam sees its own clients" on public.account_live_samples`);
    await db.exec(`create policy "cam sees its own clients"
      on public.account_live_samples for all to authenticated
      using ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))
      with check ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))`);
    await db.exec('grant insert, update, delete on public.account_live_samples to anon, authenticated');
    await db.exec('drop policy "account_live_samples deny browser deletes" on public.account_live_samples');
    try {
      const deleted = await asSession(AUTH_GRAY,
        `delete from public.account_live_samples
         where account_name = 'GRAY-1' returning account_name`);
      // The hole, reproduced: this is what the shipped file did.
      expect(deleted.rows.map((row) => row.account_name)).toEqual(['GRAY-1']);
    } finally {
      await db.exec(`drop policy "cam sees its own clients" on public.account_live_samples`);
      await db.exec(raw);
    }
    // And once the file has put its own policies back, the same delete does nothing.
    const again = await asSession(AUTH_GRAY,
      `delete from public.account_live_samples where account_name = 'GRAY-1' returning account_name`);
    expect(again.rows).toEqual([]);
    expect(await one('select count(*)::int from public.account_live_samples')).toBe(2);
  });

  it('nobody signed in can delete the tunables either, which is how every one of them reverts at once', async () => {
    /* account_tracker_settings has no `client_id`, so step 52's loop A never reaches
       it - but deleting the singleton makes the function fall back to the literals
       in its own body, silently retuning the whole fleet, and the gap is the same
       gap. Closed the same way rather than left to depend on a loop's exclusion
       list staying what it is. */
    for (const attempt of [
      await asSession(AUTH_GRAY, 'delete from public.account_tracker_settings returning id'),
      await asSession(AUTH_MANAGER, 'delete from public.account_tracker_settings returning id'),
      await asAnon('delete from public.account_tracker_settings returning id'),
    ]) {
      expect(attempt.error).toMatch(/permission denied for table account_tracker_settings/);
    }
    expect(await one('select count(*)::int from public.account_tracker_settings')).toBe(1);
  });

  /* ── TRUNCATE, TRIGGER, REFERENCES: THE THREE NOBODY THINKS OF ───────────────
   *
   * THE DEFECT: the lockdown was `revoke insert, update, delete` and stopped. There
   * are EIGHT privileges on a table and Supabase's default privileges grant all of
   * them - measured on this project, `anon=arwdDxtm/postgres` and
   * `authenticated=arwdDxtm/postgres` - so three verbs revoked left five, four of
   * them real: TRUNCATE, TRIGGER, REFERENCES, MAINTAIN. The ACL the shipped file
   * actually produced, with the default privileges modelled the way Supabase sets
   * them, was `anon=rDxtm/postgres,authenticated=rDxtm/postgres`.
   *
   * AND TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY. That is what makes this
   * different in kind from every other denial in this file rather than one more
   * verb on a list. The restrictive policies, step 52's policies, step 53's
   * policies - all of them are statements about which ROWS a session may touch, and
   * a TRUNCATE asks none of them. Measured against the shipped file, as a signed-in
   * CAM on its own assigned client, with all four restrictive policies in place:
   *
   *   gray truncates account_live_samples     -> (no error - it went through)
   *   rows in account_live_samples after:     <empty>
   *   gray truncates account_tracker_settings -> (no error - it went through)
   *   settings rows after:                    0
   *   anon truncates account_live_samples     -> (no error - it went through)
   *   gray creates a trigger on the table     -> (no error - it went through)
   *
   * So there is no second layer to fall back on here and the revoke is the whole of
   * the control - which is also why this is asked by DOING it as each role rather
   * than by reading a policy, because a policy test about TRUNCATE proves nothing
   * whatever it says. Step 51's header is the instruction: "may only SELECT" has to
   * be true rather than nearly true. */
  /* THE HARNESS ITSELF, WHICH NOTHING WAS DEFENDING.
   *
   * Every access-control assertion below is only worth what the PREREQUISITES
   * are worth, and a reviewer proved they were worth nothing by reverting that
   * one line to the narrower `grant select, insert, update, delete` an earlier
   * version carried. Not one test failed. The grant hole this whole describe
   * block exists to close had been wide open with the suite green for exactly
   * that reason: the model was kinder than the world, so no assertion could see
   * the difference.
   *
   * Fixing the prerequisites without pinning them moves the defect up one level
   * instead of closing it, which is what happened to the composition root a
   * round earlier. So the harness now asserts its own fidelity, against a string
   * measured on the real project rather than one anybody reasoned to:
   *
   *   select defaclacl from pg_default_acl ... on 2026-10-05 returned
   *   {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
   *    authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
   *
   * arwdDxtm is all eight: INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
   * REFERENCES, TRIGGER and MAINTAIN. The D is the one that ignores row level
   * security, and the m is the one step 51 missed on app_users, which still
   * carries MAINTAIN in production today. */
  describe('the model is not kinder than the world', () => {
    it('hands anon and authenticated every privilege by default, as Supabase does', async () => {
      const acl = await one(`select array_to_string(d.defaclacl, ' ')
        from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public' and d.defaclobjtype = 'r'`);
      expect(acl, 'the prerequisites no longer model Supabase default privileges').toBeTruthy();
      for (const role of ['anon', 'authenticated']) {
        expect(acl).toContain(`${role}=arwdDxtm/`);
      }
    });

    it('so a table created with no revoke is truncatable by a signed in user', async () => {
      /* The control for the lockdown below. If this ever stops being true the
       * revoke has become decoration and the tests that depend on it are
       * measuring nothing. */
      await db.exec('create table if not exists public.zz_model_control (id int)');
      const truncate = await one(
        `select has_table_privilege('authenticated', 'public.zz_model_control', 'TRUNCATE')`);
      const maintain = await one(
        `select has_table_privilege('authenticated', 'public.zz_model_control', 'MAINTAIN')`);
      await db.exec('drop table public.zz_model_control');
      expect(truncate).toBe(true);
      expect(maintain).toBe(true);
    });
  });

  describe('the three privileges that are not INSERT, UPDATE or DELETE', () => {
    beforeAll(reset);

    it('TRUNCATE is refused to both browser roles on both tables, and the rows are still there', async () => {
      await reset();
      await send(world.grayDevice, minutesAgo(5), [
        { accountName: 'GRAY-1', connected: true, totalPnl: 1024.31, strategyCount: 2, enabledStrategyCount: 2 },
      ]);
      await db.query(`insert into public.account_live_samples
        (device_id, client_id, account_name, connected, sampled_at)
        values ($1, $2, 'BIRCH-1', true, $3::timestamptz)`,
      [world.birchDevice, world.birchClient, minutesAgo(5)]);

      for (const table of ['account_live_samples', 'account_tracker_settings']) {
        // A CAM on its own client, a Manager who can see everything, and the
        // anonymous key: TRUNCATE does not consult a predicate, so "its own" is
        // not the question and all three have to be asked.
        for (const [who, attempt] of [
          ['gray', await asRoleCommitting('authenticated', `truncate table public.${table}`, AUTH_GRAY)],
          ['manager', await asRoleCommitting('authenticated', `truncate table public.${table}`, AUTH_MANAGER)],
          ['anon', await asRoleCommitting('anon', `truncate table public.${table}`)],
        ]) {
          expect(refusalOf(attempt), `${who} truncates ${table}`)
            .toMatch(new RegExp(`permission denied for table ${table}`));
        }
      }

      // The rows, which is what the privilege was going to take.
      expect(await one(`select string_agg(account_name, ',' order by account_name)
        from public.account_live_samples`)).toBe('BIRCH-1,GRAY-1');
      expect(await one('select count(*)::int from public.account_tracker_settings')).toBe(1);
      await reset();
    });

    /* THE CONTROL, and the reason it has to exist: defence in depth that is only
       ever tested behind the outer layer is not tested. Here it proves the opposite
       of what the DELETE control proves - that there is NO second layer. With
       TRUNCATE granted back and every restrictive policy left exactly as the file
       created it, the table empties. So the revoke is the thing holding, and no
       policy could be written that would hold instead. */
    it('and the revoke is the only thing holding: granted back, every policy is powerless', async () => {
      await reset();
      await send(world.grayDevice, minutesAgo(5), [
        { accountName: 'GRAY-1', connected: true, totalPnl: 1024.31, strategyCount: 2, enabledStrategyCount: 2 },
      ]);
      expect(await one('select count(*)::int from public.account_live_samples')).toBe(1);
      // The four restrictive denials are all still in place - unchanged, asserted.
      expect(await one(`select count(*)::int from pg_catalog.pg_policies
        where schemaname = 'public' and permissive = 'RESTRICTIVE'
          and tablename in ('account_live_samples', 'account_tracker_settings')`)).toBe(4);

      await db.exec('grant truncate on public.account_live_samples to authenticated');
      try {
        const attempt = await asRoleCommitting(
          'authenticated', 'truncate table public.account_live_samples', AUTH_GRAY);
        expect(attempt.error).toBe(null);
        // The hole, reproduced: RLS was never asked.
        expect(await one('select count(*)::int from public.account_live_samples')).toBe(0);
      } finally {
        await db.exec(raw);
      }
      // And once the file has run again, the same statement is refused.
      await send(world.grayDevice, minutesAgo(5), [
        { accountName: 'GRAY-1', connected: true, totalPnl: 1024.31, strategyCount: 2, enabledStrategyCount: 2 },
      ]);
      expect(refusalOf(await asRoleCommitting(
        'authenticated', 'truncate table public.account_live_samples', AUTH_GRAY)))
        .toMatch(/permission denied for table account_live_samples/);
      expect(await one('select count(*)::int from public.account_live_samples')).toBe(1);
      await reset();
    });

    it('TRIGGER is refused: no session can attach code to somebody else\'s write', async () => {
      /* Worse than any single write, which is step 51's reasoning for naming it.
         A trigger on this table runs as part of the ingest route's own upsert -
         inside the SECURITY DEFINER function, as the owner. */
      await db.exec(`create or replace function public.tracker_trigger_probe() returns trigger
        language plpgsql as $$ begin return new; end $$`);
      await db.exec('grant execute on function public.tracker_trigger_probe() to anon, authenticated');
      for (const table of ['account_live_samples', 'account_tracker_settings']) {
        const statement = `create trigger probe_${table} before insert on public.${table}
          for each row execute function public.tracker_trigger_probe()`;
        expect(refusalOf(await asSession(AUTH_GRAY, statement)), `gray triggers ${table}`)
          .toMatch(new RegExp(`permission denied for table ${table}`));
        expect(refusalOf(await asAnon(statement)), `anon triggers ${table}`)
          .toMatch(new RegExp(`permission denied for table ${table}`));
      }
      // Nothing attached, asked of the catalogue rather than inferred from the errors.
      expect(await one(`select count(*)::int from pg_catalog.pg_trigger
        where not tgisinternal and tgrelid in
          ('public.account_live_samples'::regclass, 'public.account_tracker_settings'::regclass)`)).toBe(0);
    });

    it('REFERENCES is refused: no foreign key can be pointed at these rows', async () => {
      /* "How a table nobody audits starts deciding whether a user can be deleted",
         in step 51's words. Here it would decide whether the retention sweep can
         remove a sample: a foreign key pointing at account_live_samples turns the
         sweep's bounded DELETE into a constraint violation the ingest route reports
         as a failed sample, every ten minutes, on a machine that is working.

         Granted CREATE on the schema inside the test, and rolled back with it, so
         that what is being measured is the REFERENCES privilege and not the fact
         that a browser role cannot create a table in `public` either. Without
         isolating it the refusal reads `permission denied for schema public` and
         proves nothing about this table. */
      for (const table of ['account_live_samples', 'account_tracker_settings']) {
        await db.exec('begin');
        try {
          await db.exec('grant create on schema public to authenticated');
          await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', AUTH_GRAY]);
          await db.exec('set local role authenticated');
          let error = null;
          try {
            await db.exec(`create table public.tracker_fk_probe (
              id integer primary key, points_at uuid references public.${table}(id))`);
          } catch (caught) { error = String(caught.message || caught); }
          expect(refusalOf({ error }), `gray points a foreign key at ${table}`)
            .toMatch(new RegExp(`permission denied for table ${table}`));
        } finally {
          await db.exec('rollback');
        }
      }
    });

    /* THE COMPLEMENT, SAID ONCE FOR BOTH TABLES. Not a list of privileges to deny -
       a list is what shipped and a list is what went stale - but "exactly SELECT",
       read back out of the ACL. A ninth privilege in a future PostgreSQL is covered
       by this the day it exists, which is the property the enumerated form could not
       have.
       AND EXACTLY NOTHING FOR anon, which step 56 narrowed: the grant below names
       only `authenticated` now. The note beside that line has the evidence - the one
       browser reader is behind a session, neither SELECT policy admits anon, and the
       /database probe names neither table - so the anon half returned `200 []` and
       bought nothing. Asserted as the complement in both directions, so putting
       `anon` back without arguing it fails here. */
    it('holds exactly SELECT and nothing else, which is the claim and not a list of denials', async () => {
      for (const table of ['account_live_samples', 'account_tracker_settings']) {
        expect(await privilegesHeldOn('authenticated', table), `authenticated on ${table}`).toBe('SELECT');
        expect(await privilegesHeldOn('anon', table), `anon on ${table}`).toBe('<none>');
      }
      /* AND THE SERVICE ROLE IS UNTOUCHED, which is the other way to break this and
         the reason `service_role` is on the prerequisites' default-privilege line.
         A revoke one role too far would 500 the client page on every load:
         server/autoCollection/admin/ingest-status.js:143,163 reads both tables
         directly on the service role. Asked as the complement again, so a revoke of
         any single privilege from it fails here rather than only the one named. */
      for (const table of ['account_live_samples', 'account_tracker_settings']) {
        expect(await privilegesHeldOn('service_role', table), `service_role on ${table}`)
          .toBe('DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE');
      }
    });

    it('and the file says the other thirty-two tables are a known gap, not an oversight', () => {
      /* Measured across the whole production database: `authenticated` can TRUNCATE
         32 of 37 tables, and the five it cannot are app_users and the four ingest
         tables. Not this file's to fix, and a reader who finds the revoke here and
         assumes the rest of the database is in the same shape would be wrong. */
      expect(raw).toMatch(/THE OTHER THIRTY-TWO TABLES/);
      expect(raw).toMatch(/TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY/);
    });
  });

  it('names both halves of the denial on both tables, as RESTRICTIVE and for the right verb', async () => {
    /* Read from the catalogue rather than from the file: a policy the file creates
       inside a guarded `do` block that silently did not run would still be in the
       text. Four policies, two per table, and the DELETE one must be RESTRICTIVE
       with a false qual - a PERMISSIVE one would add permission instead of
       removing it. */
    const { rows } = await db.query(`select tablename, policyname, permissive, cmd, qual, with_check,
      roles::text as roles
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename in ('account_live_samples', 'account_tracker_settings')
        and permissive = 'RESTRICTIVE'
      order by tablename, cmd`);
    expect(rows).toEqual([
      {
        tablename: 'account_live_samples',
        policyname: 'account_live_samples deny browser writes',
        permissive: 'RESTRICTIVE', cmd: 'ALL', qual: 'true', with_check: 'false',
        roles: '{anon,authenticated}',
      },
      {
        tablename: 'account_live_samples',
        policyname: 'account_live_samples deny browser deletes',
        permissive: 'RESTRICTIVE', cmd: 'DELETE', qual: 'false', with_check: null,
        roles: '{anon,authenticated}',
      },
      {
        tablename: 'account_tracker_settings',
        policyname: 'account_tracker_settings deny browser writes',
        permissive: 'RESTRICTIVE', cmd: 'ALL', qual: 'true', with_check: 'false',
        roles: '{anon,authenticated}',
      },
      {
        tablename: 'account_tracker_settings',
        policyname: 'account_tracker_settings deny browser deletes',
        permissive: 'RESTRICTIVE', cmd: 'DELETE', qual: 'false', with_check: null,
        roles: '{anon,authenticated}',
      },
    ]);
  });

  it('is NOT named ingest_*, because step 52 skips that family on purpose', () => {
    /* step_52_rls_by_cam.sql:155-158 excludes `table_name like 'ingest%'` from
     * its CAM-policy loop because "the ingest tables are already shut to the
     * browser by their own restrictive denials". A browser-readable
     * `ingest_account_samples` would make that comment false for the next
     * auditor and permanently opt this table out of step 52's self-healing. */
    expect(sql).not.toMatch(/create table if not exists public\.ingest_account/);
    expect(sql).toContain('create table if not exists public.account_live_samples');
  });

  it('lets any signed-in session read the tunables but not write them', async () => {
    // The screens need stale_sample_seconds to decide what "silent" means, and a
    // second copy of that number in JavaScript is a second thing to keep in step.
    const read = await asSession(AUTH_GRAY, 'select stale_sample_seconds from public.account_tracker_settings');
    expect(read.rows[0]?.stale_sample_seconds).toBe(1500);
    const written = await asSession(AUTH_GRAY,
      `update public.account_tracker_settings set sample_interval_seconds = 300
       where id returning sample_interval_seconds`);
    expect(written.error).toMatch(/permission denied for table account_tracker_settings/);
    expect(await one('select sample_interval_seconds from public.account_tracker_settings')).toBe(600);
    const anon = await asAnon('select stale_sample_seconds from public.account_tracker_settings');
    expect(anon.rows).toEqual([]);
  });
});
