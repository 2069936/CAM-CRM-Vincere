// The harness validating itself, because the last one did not.
//
// PR 67 built a cluster harness whose prerequisites modelled Supabase's grants
// as `grant select, insert, update, delete` and set no default privileges at
// all. Supabase does neither: it ships `alter default privileges in schema
// public grant all on tables`, so every table is born holding all eight
// privileges for anon and authenticated.
//
// The consequence was that no assertion in that file could ever see a grant
// hole - the hole was never created - and the privilege defect step 56 closes
// sat in production with the suite green. A harness kinder than the world makes
// every test inside it decoration.
//
// So the prerequisites are asserted here against the string measured on Pedro's
// own project, and the list of places the harness is allowed to deviate from the
// files is pinned so it cannot grow quietly.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_EIGHT,
  BEYOND_RLS_FOUR,
  DECLARED_HISTORY_FIXUPS,
  DML_FOUR,
  SUPABASE_BORN_TABLE_ACL,
  assertSupabaseGrantFidelity,
  migrationFilesInOrder,
  one,
  privilegesOn,
  startMigrationCluster,
} from './migrationCluster.js';

const source = readFileSync(new URL('./migrationCluster.js', import.meta.url), 'utf8');

describe('the prerequisites model Supabase, not something easier', () => {
  it('sets default privileges granting ALL on tables, not the four DML verbs', () => {
    /* The exact mistake being guarded. `grant select, insert, update, delete`
     * here would hide every TRUNCATE, TRIGGER, REFERENCES and MAINTAIN hole in
     * this database from every test that runs against this cluster. */
    expect(source).toMatch(
      /alter default privileges in schema public\s*\n?\s*grant all on tables to anon, authenticated, service_role/,
    );
    expect(source).not.toMatch(/grant select, insert, update, delete on tables/);
  });

  it('a table born here carries the exact ACL measured on Pedro project', async () => {
    const db = await startMigrationCluster([]);
    const acl = await assertSupabaseGrantFidelity(db);
    expect(acl).toBe(SUPABASE_BORN_TABLE_ACL);
    expect(acl).toContain('anon=arwdDxtm/postgres');
    expect(acl).toContain('authenticated=arwdDxtm/postgres');
  }, 60000);

  it('and arwdDxtm really is all eight, including the D and the m', async () => {
    /* Spelled out because the whole migration turns on two letters nobody
     * reads: D is TRUNCATE and m is MAINTAIN. */
    const db = await startMigrationCluster([]);
    await db.exec('create table public.eight (id int);');
    const held = await privilegesOn(db, 'authenticated', 'eight');
    expect(held).toEqual(ALL_EIGHT.slice().sort());
    expect(held).toContain('TRUNCATE');
    expect(held).toContain('MAINTAIN');
    expect(BEYOND_RLS_FOUR).toEqual(['TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN']);
    expect([...DML_FOUR].sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  }, 60000);

  it('refuses to boot if the prerequisites ever stop matching', async () => {
    /* The guard is not advisory. If somebody weakens the default privileges, the
     * cluster throws at boot rather than letting a suite pass against a database
     * that never had the grant. */
    const db = await startMigrationCluster([]);
    await db.exec('alter default privileges in schema public revoke truncate on tables from authenticated;');
    await expect(assertSupabaseGrantFidelity(db)).rejects.toThrow(/no longer model Supabase/);
  }, 60000);

  it('models both default-privilege lines, because only one of them is reachable', async () => {
    const db = await startMigrationCluster([]);
    const owners = await db.query(
      'select distinct pg_get_userbyid(defaclrole) as owner from pg_default_acl order by 1',
    );
    expect(owners.rows.map((row) => row.owner).sort()).toEqual(['postgres', 'supabase_admin']);
  }, 60000);

  it('creates service_role with BYPASSRLS, or every policy test would be a lie', async () => {
    const db = await startMigrationCluster([]);
    expect(await one(db, "select rolbypassrls from pg_roles where rolname = 'service_role'")).toBe(true);
    expect(await one(db, "select rolbypassrls from pg_roles where rolname = 'authenticated'")).toBe(false);
    expect(await one(db, "select rolbypassrls from pg_roles where rolname = 'anon'")).toBe(false);
  }, 60000);
});

describe('what the harness is allowed to change about the files', () => {
  it('deviates from them in exactly two declared places, both the same defect', () => {
    /* Pinned so a fixup cannot be added to make a failing test pass. Both
     * entries are the step_1 / step_7 auth_mapping_status column clash, which
     * breaks on any PostgreSQL in both directions and is pre-existing. */
    expect(DECLARED_HISTORY_FIXUPS).toEqual([
      'step_1_auth_setup.sql',
      'step_7_user_management.sql',
    ]);
  });

  it('and the fixups only drop a view nothing reads', () => {
    const fixupBlock = /const HISTORY_FIXUPS = \{[\s\S]*?\n\};/.exec(source)[0];
    const statements = [...fixupBlock.matchAll(/'([^']*;)'/g)].map((m) => m[1]);
    expect(statements.length).toBe(2);
    for (const statement of statements) {
      expect(statement).toBe('drop view if exists public.auth_mapping_status;');
    }
  });
});

describe('the file list is read from the directory, not remembered', () => {
  it('starts with the base schema and runs the steps in numeric order', () => {
    const files = migrationFilesInOrder();
    expect(files[0]).toBe('cam_crm_schema.sql');
    const numbers = files.slice(1).map((name) => Number(/^step_(\d+)/.exec(name)[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toContain(56);
    // The newest step on disk, counted here independently of the function under
    // test, rather than a number every migration would have to come back and
    // edit. Which step that is belongs to the newest step's own test.
    const onDisk = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.at(-1)).toBe(Math.max(...onDisk));
    expect(numbers).toHaveLength(onDisk.length);
  });

  it('stops where it is told, so a test can show a defect before the fix', () => {
    const files = migrationFilesInOrder({ upTo: 53 });
    expect(files).toContain('step_53_client_creation_under_rls.sql');
    expect(files).not.toContain('step_56_table_privilege_lockdown.sql');
  });

  it('picks up a step added tomorrow without anybody editing this file', () => {
    /* The same reason step 52 enumerates its tables from the catalogue: a list
     * somebody has to remember to extend is a list that goes stale. */
    expect(source).toMatch(/readdirSync\(new URL\('\.\/', import\.meta\.url\)\)/);
  });
});

describe('the honesty notes are present, because a green suite is not the whole story', () => {
  it('says it is a single connection and proves nothing about races', () => {
    expect(source).toMatch(/single connection/i);
  });

  it('says its postgres is a superuser and Supabase\'s is not', () => {
    expect(source).toMatch(/postgres` IS a superuser/);
  });

  it('marks the function default-privilege line as modelled rather than measured', () => {
    /* Pedro's measurement covered defaclobjtype 'r'. Nobody has looked at 'f'.
     * The harness assumes the harsher case and says so. */
    expect(source).toMatch(/NOT MEASURED/);
    expect(source).toMatch(/defaclobjtype/);
  });
});
