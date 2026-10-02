// A real PostgreSQL, in process, so a test can call the function instead of
// reading the file.
//
// WHY THIS EXISTS. Every migration test in this directory asserts the TEXT of
// the SQL. That is cheap and it has caught real mistakes, but it cannot catch a
// mistake in what the SQL DOES, and this repo has now shipped four tests that
// passed against a comment rather than against a behaviour. The fourth was the
// window gate in step 54: changing `v_minute < window_end_minute` to `<=` opens
// the quiet window a full minute wider, which is a real behaviour change -
// 18:00:00 and 18:00:59 flip from 'none' to 'offered' - and all fifty-three
// assertions in step_54_deep_export_requests.test.js passed against it.
//
// So: `@electric-sql/pglite` is PostgreSQL 18 compiled to WebAssembly. It needs
// no server, no cluster, no port and no Docker, it starts in about a second, and
// it runs plpgsql, `at time zone`, `gen_random_uuid`, `hashtextextended` and the
// advisory locks. `npm ci` is the whole installation, so these assertions run on
// a laptop and in CI identically - which is the only reason a behavioural test
// is worth writing here rather than in a shell script somebody has to remember.
//
// WHAT IT CANNOT DO, stated so nobody mistakes a green suite for the whole
// story: PGlite is a single connection, so nothing here proves anything about
// two sessions racing. Lock order, deadlocks and simultaneous beats are proved
// against a real multi-process cluster with a synchronised barrier, and the
// evidence for that lives in the pull request rather than in this file.
//
// The prerequisites below are the objects step 54 references and does not
// create, built to the shape the real project has them in: the three Supabase
// roles, a `storage` schema with the two tables and the bucket step 28 created
// with only (id, name, public), and `clients` / `app_users` / `ingest_devices`.
// RLS is on for each of them, because every migration in this directory ends by
// counting public tables that do not have it.

import { readFileSync } from 'node:fs';

const PREREQUISITES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

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

-- step_28 created this one with id, name and public and nothing else. If a later
-- migration touches this row we want to be able to see that it did.
insert into storage.buckets (id, name, public)
values ('ninjatrader-imports', 'ninjatrader-imports', false);
create policy "imports service only" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'ninjatrader-imports')
  with check (bucket_id <> 'ninjatrader-imports');

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null);
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null);
create table public.ingest_devices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null default 'active',
  revoked_at timestamptz,
  schedule_timezone text not null default 'America/New_York');
alter table public.clients enable row level security;
alter table public.app_users enable row level security;
alter table public.ingest_devices enable row level security;
`;

/**
 * Boots an empty PostgreSQL, creates the objects the migrations expect to find
 * already there, and applies each named migration in order, exactly as the file
 * stands on disk.
 *
 * @param {string[]} migrationFileNames names relative to this directory.
 * @param {{ applyTwice?: boolean }} [options] applyTwice runs the whole list a
 *   second time, which is how Pedro would re-run a step he is not sure landed.
 */
export async function startMigrationCluster(migrationFileNames, options = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(PREREQUISITES);
  const passes = options.applyTwice ? 2 : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    for (const name of migrationFileNames) {
      const sql = readFileSync(new URL(name, import.meta.url), 'utf8');
      await db.exec(sql);
    }
  }
  return db;
}

/** The scalar in the first column of the first row, which is all most of these need. */
export async function one(db, sql, params) {
  const result = await db.query(sql, params);
  const row = result.rows[0];
  return row ? row[Object.keys(row)[0]] : undefined;
}

/**
 * Runs a statement and returns the error text instead of throwing, so a test can
 * assert that the database refused something and say which refusal it was.
 */
export async function refusal(db, sql, params) {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}
