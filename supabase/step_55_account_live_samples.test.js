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
 * four tables the policies reach, and step 52's two helpers. */
const PREREQUISITES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

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

describe('step 55 is the one that runs last', () => {
  it('appears once, is the highest number, and skips 54 on purpose', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 55)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(55);
    // 54 is claimed by an unmerged draft whose own test asserts its number, so
    // the gap is deliberate and the header has to say so or somebody closes it.
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

  it('adds without dropping or rewriting anything', () => {
    expect(sql).toContain('create table if not exists public.account_live_samples');
    expect(sql).toContain('create table if not exists public.account_tracker_settings');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/drop policy/);
    // No existing table is touched at all. The whole point of a new table with
    // its own function is that nothing already deployed has to change.
    expect(sql).not.toMatch(/alter table public\.ingest_(devices|batches)/);
    expect([...new Set([...sql.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]))].sort())
      .toEqual(['account_live_samples', 'account_tracker_settings']);
  });

  it('leaves the heartbeat alone', () => {
    // The whole reason the sample has its own endpoint, its own table and its
    // own function: the heartbeat's vocabulary is fixed on the server, every
    // deployed agent depends on it staying that way, and the heartbeat is the
    // only thing that says a machine is alive.
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

  it('derives the three run states, and never folds unmeasured into idle', async () => {
    await reset();
    await send(world.grayDevice, minutesAgo(20), [
      { accountName: 'R', connected: true, strategyCount: 3, enabledStrategyCount: 1 },
      { accountName: 'I', connected: true, strategyCount: 3, enabledStrategyCount: 0 },
      { accountName: 'U-none', connected: true, strategyCount: 0, enabledStrategyCount: 0 },
      { accountName: 'U-absent', connected: true },
    ]);
    const { rows } = await db.query(`select account_name, run_state
      from public.account_live_samples order by account_name`);
    expect(rows).toEqual([
      { account_name: 'I', run_state: 'idle' },
      { account_name: 'R', run_state: 'running' },
      { account_name: 'U-absent', run_state: 'unmeasured' },
      { account_name: 'U-none', run_state: 'unmeasured' },
    ]);
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

  it('is security definer with a pinned search_path, and reachable only by the service role', () => {
    const record = functionDefinition('record_account_live_sample');
    expect(record).toContain('security definer');
    expect(record).toContain('set search_path = pg_catalog, public');
    expect(sql).toMatch(/revoke all on function public\.record_account_live_sample\(uuid, timestamptz, jsonb\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.record_account_live_sample\(uuid, timestamptz, jsonb\) to service_role/);
    // No `for update` on the device row: there is no delete-what-is-absent to
    // serialise, and the lock would contend with the heartbeat every minute.
    expect(record).not.toMatch(/from public\.ingest_devices as device where device\.id = p_device_id for update/);
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
    const anon = await asAnon('select account_name from public.account_live_samples');
    expect(anon.rows).toEqual([]);
  });

  it('a CAM CANNOT forge a green light on its own client', async () => {
    /* A read policy with no restrictive write denial is step 51's hole with a
     * new table name: a CAM talking to PostgREST with the publishable key could
     * insert a row claiming any of its accounts is connected and running. */
    const inserted = await asSession(AUTH_GRAY,
      `insert into public.account_live_samples
        (device_id, client_id, account_name, connected, sampled_at)
        values ($1, $2, 'FORGED', true, now())`, [world.grayDevice, world.grayClient]);
    expect(inserted.error).toMatch(/row-level security|violates/i);

    /* UPDATE and DELETE do not raise, and that is worth knowing rather than
     * guessing at: there is no PERMISSIVE policy for either verb, so RLS
     * filters every row out and the statement affects nothing and says nothing.
     * The assertion has to be about the effect. */
    const updated = await asSession(AUTH_GRAY,
      `update public.account_live_samples set connected = false
       where account_name = 'GRAY-1' returning account_name`);
    expect(updated.rows).toEqual([]);

    const deleted = await asSession(AUTH_GRAY,
      `delete from public.account_live_samples
       where account_name = 'GRAY-1' returning account_name`);
    expect(deleted.rows).toEqual([]);

    expect(await one('select count(*)::int from public.account_live_samples')).toBe(2);
    expect(await one("select connected from public.account_live_samples where account_name = 'GRAY-1'"))
      .toBe(true);
    expect(await one("select count(*)::int from public.account_live_samples where account_name = 'FORGED'"))
      .toBe(0);
  });

  it('the write denial is RESTRICTIVE, which is what survives a re-run of step 52', async () => {
    /* Step 52's loop A gives every `client_id` table `for all to authenticated
     * using <predicate> with check <predicate>` - read AND WRITE - and drops
     * only PERMISSIVE policies on its way through. So the only thing standing
     * between a CAM and a forged row after that re-run is this policy's
     * RESTRICTIVE-ness. Proved by installing step 52's own policy here and
     * asking again. */
    await db.exec(`create policy "cam sees its own clients re-run"
      on public.account_live_samples for all to authenticated
      using ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))
      with check ((select public.is_manager()) or client_id in (select public.assigned_client_ids()))`);
    try {
      const inserted = await asSession(AUTH_GRAY,
        `insert into public.account_live_samples
          (device_id, client_id, account_name, connected, sampled_at)
          values ($1, $2, 'FORGED-AFTER-52', true, now())`, [world.grayDevice, world.grayClient]);
      expect(inserted.error).toMatch(/row-level security|violates/i);
      // And reading still works, which is what makes the re-run harmless.
      const read = await asSession(AUTH_GRAY, 'select account_name from public.account_live_samples');
      expect(read.rows.map((r) => r.account_name)).toEqual(['GRAY-1']);
    } finally {
      await db.exec('drop policy "cam sees its own clients re-run" on public.account_live_samples');
    }
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
    expect(written.rows).toEqual([]);
    expect(await one('select sample_interval_seconds from public.account_tracker_settings')).toBe(600);
    const anon = await asAnon('select stale_sample_seconds from public.account_tracker_settings');
    expect(anon.rows).toEqual([]);
  });
});
