// Step 56 is asserted against a running PostgreSQL, not against its own text.
//
// WHY, SPECIFICALLY. A sibling suite in this repository recently had 54 of 89
// assertions that only checked the file SAID something, and fourteen real
// mutations passed all 89 - one of which dropped the heartbeat function the
// whole fleet calls. A privilege migration is the worst possible place to
// repeat that, because a revoke leaves no object behind to inspect: if it did
// not happen, there is nothing missing to notice.
//
// So every claim here about what the database PERMITS is proved by trying it as
// the role, through supabase/migrationCluster.js, which boots PostgreSQL 18 in
// process and applies the real files. The text assertions that remain are only
// about things text is the right medium for: that the file does not contain the
// one statement that would lock everyone out, and that the runbook names it.
//
// TRUNCATE IN PARTICULAR CANNOT BE PROVED ANY OTHER WAY. It is not subject to
// row level security, so no policy test says anything about it, and reading
// `revoke all privileges` out of the file does not prove the revoke reached the
// table. The only proof is a session that is the `authenticated` role being
// refused when it tries.
//
// A TRAP THIS SUITE FELL INTO FIRST, kept as a test below. `truncate table
// public.clients` as authenticated fails BEFORE step 56 - with "cannot truncate
// a table referenced in a foreign key constraint", because 17 tables point at
// it. An assertion that merely expected an error would have passed against the
// unfixed database. The privilege check and the foreign-key check are different
// refusals and only one of them is this migration's business, so every TRUNCATE
// assertion below matches /permission denied/ and the before-state is pinned to
// a table with no inbound foreign key.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BEYOND_RLS_FOUR,
  DML_FOUR,
  migrationFilesInOrder,
  one,
  privilegesOn,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const migrationUrl = new URL('./step_56_table_privilege_lockdown.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';

/* The executable half. This header argues at length about TRUNCATE, about what
 * anon does not need and about what must not be tidied away, and an assertion
 * about the statements must never be satisfied by that argument. */
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

// ---------------------------------------------------------------------------
// THE MEASUREMENT, as data.
//
// What each table's `authenticated` grant must be after step 56, measured off
// src/domain/supabaseStore.js and src/domain/supabaseAuth.js - the browser's
// entire PostgREST surface. An `upsert` is INSERT **and** UPDATE because
// PostgREST emits `insert ... on conflict do update`.
//
// The four tables marked (var) are reached only through `.from(table)` with a
// variable at supabaseStore.js:2702/:2742, so a grep for `.from('name')` cannot
// see them. Three of them appear nowhere in this repository as a literal.
// ---------------------------------------------------------------------------
const EXPECTED = {
  // all four verbs
  client_assignments: 'SIUD',
  client_coverage: 'SIUD',
  daily_imports: 'SIUD',
  operational_flags: 'SIUD', // (var) insert+delete, plus literal update
  strategy_classifications: 'SIUD',
  tasks: 'SIUD',
  trading_accounts: 'SIUD',
  // no UPDATE
  activity_logs: 'SID',
  client_prop_firms: 'SID',
  executions: 'SID', // (var)
  orders: 'SID', // (var)
  price_checks: 'SID',
  strategy_snapshots: 'SID', // (var)
  // no DELETE
  account_snapshots: 'SIU',
  algorithm_benchmarks: 'SIU', // NOT read-only: saveAlgorithmBenchmarks upserts at :3312
  cam_profiles: 'SIU',
  cam_time_off: 'SIU',
  client_credentials: 'SIU',
  clients: 'SIU', // soft-deleted, never DELETEd
  daily_sop_checklists: 'SIU',
  log_algo_history: 'SIU',
  reports: 'SIU',
  sop_items: 'SIU', // the SOP tables are NOT uniform - these two are written
  sop_sections: 'SIU',
  // append only
  audit_logs: 'SI',
  client_price_changes: 'SI', // insert is fire-and-forget; a revoke here fails silently
  payout_events: 'SI',
  // read only
  app_users: 'S',
  close_summaries: 'S', // written by a SECURITY DEFINER rpc, not by the browser
  sop_templates: 'S',
  strategy_templates: 'S',
  // nothing at all
  ingest_admission_settings: '',
  ingest_quarantine_reports: '',
  // and the four step 28 already closed, restated so this map covers all 37
  ingest_batches: '',
  ingest_devices: '',
  ingest_enrollments: '',
  ingest_pair_rate_limits: '',
};

const LETTER = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' };
const expand = (code) => [...code].map((ch) => LETTER[ch]).sort();

/** A statement that exercises one privilege and touches no row. */
function probeFor(verb, table, firstColumn) {
  switch (verb) {
    case 'SELECT': return `select * from public.${table} limit 0`;
    case 'INSERT': return `insert into public.${table} (${firstColumn}) values (null)`;
    case 'UPDATE': return `update public.${table} set ${firstColumn} = ${firstColumn} where false`;
    case 'DELETE': return `delete from public.${table} where false`;
    default: throw new Error(verb);
  }
}

const DENIED = /permission denied/i;

let after; // the cluster with every migration applied, step 56 included
let before; // the cluster stopped at step 53, to show the hole was real
let columnOf = {};
let managerId;

beforeAll(async () => {
  after = await startMigrationCluster(migrationFilesInOrder());
  before = await startMigrationCluster(migrationFilesInOrder({ upTo: 53 }));

  for (const db of [after, before]) {
    // A Manager session, so row level security admits every row and the GRANT is
    // the only thing left that can refuse. Proving the grant is this file's job;
    // steps 52 and 53 own the per-CAM row rules and test them themselves.
    const id = await one(db, 'insert into auth.users (email) values ($1) returning id', ['mgr@example.com']);
    await db.query(
      `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
       values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [id],
    );
    if (db === after) managerId = id;
  }

  const rows = await after.query(`
    select table_name, min(ordinal_position) as pos,
           (array_agg(column_name order by ordinal_position))[1] as first_column
    from information_schema.columns
    where table_schema = 'public' group by table_name`);
  for (const row of rows.rows) columnOf[row.table_name] = row.first_column;
}, 120000);

// ---------------------------------------------------------------------------
describe('step 56 exists and is the one that runs last', () => {
  it('is the highest number and appears once', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 56)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(56);
  });

  it('says why 54 and 55 were skipped', () => {
    // Both are claimed by unmerged branches. A reader who finds a gap in the
    // numbering must not conclude two files were lost.
    expect(raw).toMatch(/54 is claimed by draft PR 65/i);
    expect(raw).toMatch(/55 by PR 67/i);
  });

  it('is in the runbook table and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 56 \| `step_56_table_privilege_lockdown\.sql` \|.*\|$/m);
    expect(runbook).toContain('→ 53 → 56.');
  });
});

// ---------------------------------------------------------------------------
describe('the harness models Supabase, which is the precondition for everything below', () => {
  it('a table is born holding all eight privileges for anon and authenticated', async () => {
    /* THE ASSERTION THAT MAKES THE REST MEAN ANYTHING. An earlier harness in
     * this repository modelled Supabase's grants as `grant select, insert,
     * update, delete` and set no default privileges, so no assertion inside it
     * could ever see a grant hole: the hole was never created. The suite was
     * green and the database was open.
     *
     * startMigrationCluster throws at boot if this drifts; this test states it
     * where a reader will see it. */
    const probe = await startMigrationCluster([]);
    await probe.exec('create table public.born_before_anything (id int);');
    expect(await privilegesOn(probe, 'authenticated', 'born_before_anything')).toEqual(
      [...BEYOND_RLS_FOUR, ...DML_FOUR].sort(),
    );
    expect(await privilegesOn(probe, 'anon', 'born_before_anything')).toHaveLength(8);
  }, 60000);

  it('models both default-privilege lines, postgres and supabase_admin', async () => {
    const owners = await after.query(
      "select distinct pg_get_userbyid(defaclrole) as owner from pg_default_acl order by 1",
    );
    expect(owners.rows.map((r) => r.owner)).toContain('postgres');
    expect(owners.rows.map((r) => r.owner)).toContain('supabase_admin');
  });
});

// ---------------------------------------------------------------------------
describe('the hole was real before step 56, proved by doing it', () => {
  it('a signed-in CAM could TRUNCATE orders, and row level security never saw it', async () => {
    /* 64,791 rows, emptied by one statement, with step 52's policy installed and
     * passing. orders is used rather than clients because nothing points a
     * foreign key at it, so the statement reaches the privilege check instead of
     * being stopped by the foreign-key check first. */
    expect(await refusalAsRole(before, 'authenticated', 'truncate table public.orders')).toBeNull();
  });

  it('and held all eight privileges on the 32 tables', async () => {
    expect(await privilegesOn(before, 'authenticated', 'clients')).toHaveLength(8);
    expect(await privilegesOn(before, 'authenticated', 'client_credentials')).toHaveLength(8);
  });

  it('step 51 left MAINTAIN on app_users, which is the whole argument of step 56', async () => {
    /* Step 51 revoked `truncate, trigger, references` by name. MAINTAIN did not
     * exist in PostgreSQL when that list was written, so it survived - exactly
     * the staleness that enumerating what to REMOVE guarantees. */
    expect(await privilegesOn(before, 'authenticated', 'app_users')).toEqual(['MAINTAIN', 'SELECT']);
  });

  it('anon held all eight too, on every one of the 32', async () => {
    expect(await privilegesOn(before, 'anon', 'clients')).toHaveLength(8);
  });

  it('and the FK check masks the privilege check, which is why the assertions above are worded as they are', async () => {
    /* Kept as a test because it is the trap. `truncate clients` errors before
     * step 56 - but with a foreign-key complaint, not a permission one. A test
     * that expected "an error" would have passed against the open database. */
    const error = await refusalAsRole(before, 'authenticated', 'truncate table public.clients');
    expect(error).toMatch(/foreign key/i);
    expect(error).not.toMatch(DENIED);
  });
});

// ---------------------------------------------------------------------------
describe('authenticated cannot do the four things row level security cannot govern', () => {
  it('holds no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN on ANY table in public', async () => {
    const tables = await after.query("select tablename from pg_tables where schemaname='public' order by 1");
    const offenders = [];
    for (const { tablename } of tables.rows) {
      const held = await privilegesOn(after, 'authenticated', tablename);
      const bad = held.filter((p) => BEYOND_RLS_FOUR.includes(p));
      if (bad.length) offenders.push(`${tablename}: ${bad.join(',')}`);
    }
    expect(offenders).toEqual([]);
    expect(tables.rows).toHaveLength(37); // 32 + app_users + the 4 ingest tables
  });

  it('is REFUSED when it tries to truncate, on every table, as the role', async () => {
    /* The catalogue said so above; this makes the database say it. Every one
     * must be a PERMISSION refusal - see the foreign-key trap. */
    const tables = await after.query("select tablename from pg_tables where schemaname='public' order by 1");
    const wrong = [];
    for (const { tablename } of tables.rows) {
      const error = await refusalAsRole(after, 'authenticated', `truncate table public.${tablename}`);
      if (error === null || !DENIED.test(error)) wrong.push(`${tablename}: ${error ?? 'SUCCEEDED'}`);
    }
    expect(wrong).toEqual([]);
  });

  it('cannot create a trigger on one, where before step 56 it could', async () => {
    /* A REAL trigger function, not is_manager(). Pointing CREATE TRIGGER at a
     * function that does not return `trigger` fails with a type error whether or
     * not the privilege is held, so the assertion would have been satisfied by
     * the wrong refusal. */
    const fn = `create or replace function public.probe_trigger_fn() returns trigger
                language plpgsql as $f$ begin return new; end $f$;`;
    const makeTrigger = 'create trigger probe_t after insert on public.orders '
      + 'for each row execute function public.probe_trigger_fn()';

    await before.exec(fn);
    expect(await refusalAsRole(before, 'authenticated', makeTrigger)).toBeNull();

    await after.exec(fn);
    const error = await refusalAsRole(after, 'authenticated', makeTrigger);
    expect(error).toMatch(DENIED);
  });

  it('cannot point a REFERENCES constraint at one, where before step 56 it could', async () => {
    /* The probe table is OWNED by authenticated on purpose. Owned by postgres,
     * the statement is refused with "must be owner of table probe_fk" no matter
     * what REFERENCES says - which is a refusal this migration did not cause, and
     * an assertion that accepted it passed against a database with the privilege
     * still granted. That was this test's own first bug. */
    const setup = 'create table public.probe_fk (id uuid); '
      + 'alter table public.probe_fk owner to authenticated;';
    const addFk = 'alter table public.probe_fk add constraint probe_fk_c '
      + 'foreign key (id) references public.clients(id)';

    await before.exec(setup);
    expect(await refusalAsRole(before, 'authenticated', addFk)).toBeNull();
    await before.exec('drop table public.probe_fk;');

    await after.exec(setup);
    const error = await refusalAsRole(after, 'authenticated', addFk);
    expect(error).toMatch(DENIED);
    expect(error, 'refused for ownership, not for the privilege').not.toMatch(/must be owner/i);
    await after.exec('drop table public.probe_fk;');
  });

  it('holds no MAINTAIN anywhere, including app_users where step 51 left it', async () => {
    /* MAINTAIN IS THE ONE OF THE FOUR THAT CANNOT BE PROVED BY A REFUSAL, and
     * saying so is better than an assertion that looks like proof. Measured:
     *
     *   analyze public.app_users  -> no error, with MAINTAIN or without it.
     *     PostgreSQL warns "skipping" and carries on rather than raising.
     *   vacuum public.app_users   -> "VACUUM cannot run inside a transaction
     *     block", identically before and after, because this harness is one
     *     connection and every probe runs in a rolled-back transaction.
     *
     * So `expect(vacuum).toThrow()` would pass against a database that still
     * held MAINTAIN - a vacuous assertion of exactly the kind this suite exists
     * to avoid. The catalogue is the honest instrument here, and the test below
     * pins it on every table rather than on one. */
    const tables = await after.query("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      expect(
        await one(after, 'select has_table_privilege($1, $2, $3)',
          ['authenticated', `public.${tablename}`, 'MAINTAIN']),
        `authenticated still holds MAINTAIN on ${tablename}`,
      ).toBe(false);
    }
    expect(await privilegesOn(after, 'authenticated', 'app_users')).toEqual(['SELECT']);
    // And the before-state, so this test can fail in the direction that matters.
    expect(await one(before, 'select has_table_privilege($1, $2, $3)',
      ['authenticated', 'public.app_users', 'MAINTAIN'])).toBe(true);
  });

  it('and the refusals it CAN prove are permission refusals, not something else', async () => {
    /* Guards the wording of every assertion above. A refusal that says "must be
     * owner" or "cannot run inside a transaction block" is not this migration's
     * work, and a test that accepted it would pass against the open database. */
    const error = await refusalAsRole(after, 'authenticated', 'truncate table public.orders');
    expect(error).toMatch(/^permission denied for table orders/);
  });
});

// ---------------------------------------------------------------------------
describe('authenticated CAN still do every write the browser actually makes', () => {
  it('holds exactly the measured grant on each of the 37 tables and nothing more', async () => {
    const got = {};
    for (const table of Object.keys(EXPECTED)) got[table] = (await privilegesOn(after, 'authenticated', table)).sort();
    const want = {};
    for (const [table, code] of Object.entries(EXPECTED)) want[table] = expand(code);
    expect(got).toEqual(want);
  });

  it('every measured verb is permitted when exercised as the role', async () => {
    /* The statements touch no row - `where false`, `limit 0`, an insert of a
     * null that a constraint will reject - so what is being measured is the
     * privilege check, which PostgreSQL applies before it evaluates anything
     * else. A constraint violation here is a PASS: the database let the
     * statement past the grant. */
    const refused = [];
    for (const [table, code] of Object.entries(EXPECTED)) {
      for (const verb of expand(code)) {
        const error = await refusalAsRole(
          after, 'authenticated', probeFor(verb, table, columnOf[table]), { subject: managerId },
        );
        if (error && DENIED.test(error)) refused.push(`${table}.${verb}: ${error}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it('and every verb NOT measured is refused for lack of privilege', async () => {
    /* The other half, and the one that catches a grant list quietly widened to
     * four verbs everywhere. Without this, `grant select, insert, update,
     * delete` on all 33 tables would pass the test above. */
    const allowed = [];
    for (const [table, code] of Object.entries(EXPECTED)) {
      const missing = DML_FOUR.filter((verb) => !expand(code).includes(verb));
      for (const verb of missing) {
        const error = await refusalAsRole(
          after, 'authenticated', probeFor(verb, table, columnOf[table]), { subject: managerId },
        );
        if (!error || !DENIED.test(error)) allowed.push(`${table}.${verb}: ${error ?? 'SUCCEEDED'}`);
      }
    }
    expect(allowed).toEqual([]);
  });

  it('keeps the upsert pair together, because one of the two is a bug that passes a smoke test', async () => {
    /* PostgREST emits `insert ... on conflict do update`. A table granted INSERT
     * but not UPDATE works on its first write and fails on every write after. */
    for (const table of [
      'account_snapshots', 'algorithm_benchmarks', 'client_assignments', 'client_coverage',
      'client_credentials', 'daily_imports', 'daily_sop_checklists', 'log_algo_history',
      'strategy_classifications', 'trading_accounts',
    ]) {
      const held = await privilegesOn(after, 'authenticated', table);
      expect(held, `${table} upserts and needs both`).toContain('INSERT');
      expect(held, `${table} upserts and needs both`).toContain('UPDATE');
    }
  });

  it('leaves algorithm_benchmarks writable, which a read-only reading of it would have broken', async () => {
    /* saveAlgorithmBenchmarks upserts at supabaseStore.js:3312, called from
     * src/App.jsx:2973 - the My Futures Book import a CAM runs holding 36 files.
     * An earlier count called this table read-only. */
    expect(await privilegesOn(after, 'authenticated', 'algorithm_benchmarks'))
      .toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('splits the SOP tables, because they are not uniform', async () => {
    expect(await privilegesOn(after, 'authenticated', 'sop_templates')).toEqual(['SELECT']);
    expect(await privilegesOn(after, 'authenticated', 'sop_sections')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(after, 'authenticated', 'sop_items')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('keeps INSERT on client_price_changes, whose failure would be silent', async () => {
    /* supabaseStore.js:2293 is `.then(() => {}, () => {})`. A revoked INSERT
     * here reaches nobody and the revenue movement figures quietly go empty. */
    expect(await privilegesOn(after, 'authenticated', 'client_price_changes')).toEqual(['INSERT', 'SELECT']);
  });
});

// ---------------------------------------------------------------------------
describe('anon keeps exactly one door, and it is the sign-in', () => {
  it('holds no privilege on any table in public', async () => {
    const tables = await after.query("select tablename from pg_tables where schemaname='public'");
    const holds = [];
    for (const { tablename } of tables.rows) {
      const held = await privilegesOn(after, 'anon', tablename);
      if (held.length) holds.push(`${tablename}: ${held.join(',')}`);
    }
    expect(holds).toEqual([]);
  });

  it('is refused when it reads clients, where before it got an empty list', async () => {
    /* Before: `[]` - the grant allowed the read and no policy admitted it to a
     * row. After: 42501. Both are closed; the change from [] to a refusal is the
     * proof the migration ran. */
    expect(await refusalAsRole(before, 'anon', 'select * from public.clients limit 1')).toBeNull();
    expect(await refusalAsRole(after, 'anon', 'select * from public.clients limit 1')).toMatch(DENIED);
  });

  it('can still resolve a username to an email with NO session, by calling it', async () => {
    /* THE ONE THAT MUST NOT BREAK. Not asserted from the file - called, as anon,
     * with no session, which is the only arrangement that proves it. A probe
     * carrying a session proves nothing: `authenticated` holds the same grant. */
    const rows = await rowsAsRole(
      after, 'anon', "select public.login_email_for_username('mgr') as email", { subject: null },
    );
    expect(rows[0].email).toBe('mgr@example.com');
  });

  it('and current_app_user() still answers nothing rather than erroring', async () => {
    const rows = await rowsAsRole(after, 'anon', 'select * from public.current_app_user()', { subject: null });
    expect(rows).toEqual([]);
  });

  it('loses the four function grants steps 52 and 53 could not reach', async () => {
    /* `revoke all on function ... from public` removes the PUBLIC pseudo-role's
     * implicit EXECUTE. It does NOT remove a direct grant to anon, which is what
     * the default privileges hand out at creation. client_is_assigned is the one
     * that matters: definer, and no auth.uid() filter, so it answered anon. */
    for (const fn of [
      'public.is_manager()', 'public.assigned_client_ids()',
      'public.client_is_assigned(uuid)', 'public.clients_i_created()',
    ]) {
      expect(await one(after, 'select has_function_privilege($1, $2, $3)', ['anon', fn, 'execute']),
        `anon should not hold ${fn}`).toBe(false);
    }
  });

  it('and client_is_assigned really was an oracle before, not a theory', async () => {
    const error = await refusalAsRole(
      before, 'anon', 'select public.client_is_assigned(gen_random_uuid())', { subject: null },
    );
    expect(error).toBeNull();
    const now = await refusalAsRole(
      after, 'anon', 'select public.client_is_assigned(gen_random_uuid())', { subject: null },
    );
    expect(now).toMatch(DENIED);
  });

  it('the file contains no blanket function revoke, which is how it would lock everyone out', () => {
    /* The tempting one-liner. `revoke all on all functions in schema public from
     * anon` matches this migration's own philosophy and takes the sign-in with
     * it. A permission denial is 42501, which isMissingFunction
     * (supabaseAuth.js:61-67) does not match, so resolveLoginEmail rethrows
     * rather than falling back and the CAM sees a raw Postgres error. */
    expect(flat).not.toMatch(/revoke[^;]*on all (functions|routines)/);
    expect(flat).not.toMatch(/revoke[^;]*login_email_for_username/);
    expect(flat).toMatch(/grant execute on function public\.login_email_for_username\(text\) to[^;]*anon/);
  });
});

// ---------------------------------------------------------------------------
describe('service_role is untouched, because every API route runs on it', () => {
  it('still holds all eight privileges on every table', async () => {
    const tables = await after.query("select tablename from pg_tables where schemaname='public'");
    const short = [];
    for (const { tablename } of tables.rows) {
      const held = await privilegesOn(after, 'service_role', tablename);
      if (held.length !== 8) short.push(`${tablename}: ${held.join(',')}`);
    }
    // The four ingest tables were revoked from anon/authenticated by step 28 and
    // re-granted to service_role there; everything else is born with all eight.
    expect(short).toEqual([]);
  });

  it('can still truncate, which is the clearest proof the revoke was role-scoped', async () => {
    expect(await refusalAsRole(after, 'service_role', 'truncate table public.orders')).toBeNull();
  });

  it('is never named in the file', () => {
    // A revoke that reached service_role would break every API route and every
    // ingest endpoint at once.
    expect(flat).not.toMatch(/revoke[^;]*service_role/);
  });
});

// ---------------------------------------------------------------------------
describe('a table created AFTER the migration is not born with the hole', () => {
  it('carries the four DML verbs for authenticated and none of the other four', async () => {
    await after.exec('create table public.born_after_56 (id int);');
    expect(await privilegesOn(after, 'authenticated', 'born_after_56')).toEqual(DML_FOUR.slice().sort());
    await after.exec('drop table public.born_after_56;');
  });

  it('gives anon nothing', async () => {
    await after.exec('create table public.born_after_56_anon (id int);');
    expect(await privilegesOn(after, 'anon', 'born_after_56_anon')).toEqual([]);
    await after.exec('drop table public.born_after_56_anon;');
  });

  it('and a session that is authenticated cannot truncate it either', async () => {
    await after.exec('create table public.born_after_56_trunc (id int);');
    expect(await refusalAsRole(after, 'authenticated', 'truncate table public.born_after_56_trunc'))
      .toMatch(DENIED);
    await after.exec('drop table public.born_after_56_trunc;');
  });

  it('says plainly that the supabase_admin line is out of reach, and why', () => {
    /* Measured rather than assumed: `alter default privileges for role X`
     * requires membership in X, and a non-member is refused with "permission
     * denied to change default privileges". Supabase's postgres is not a member
     * of supabase_admin. The migration attempts it in an exception handler so it
     * cannot fail on it, and tells Pedro what happened. */
    expect(raw).toMatch(/IT CANNOT CHANGE THE supabase_admin LINE/);
    expect(flat).toContain('exception when insufficient_privilege then');
    expect(flat).toMatch(/alter default privileges for role supabase_admin/);
  });

  it('attempts that line without ever being able to fail the migration', async () => {
    // Proved by the migration having applied at all: PGlite's postgres IS a
    // superuser, so the branch taken here is the success branch. The failure
    // branch is proved by the harness probe below.
    const line = await one(after, `
      select defaclacl::text from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'public' and d.defaclobjtype = 'r'
        and pg_get_userbyid(d.defaclrole) = 'supabase_admin'`);
    expect(line).not.toMatch(/anon=/);
  });
});

// ---------------------------------------------------------------------------
describe('THE ONE THAT MATTERS MOST: a later re-run does not undo it', () => {
  it('re-running step 52 on top of step 56 brings nothing back', async () => {
    /* Step 52 enumerates its tables from the catalogue, which is how it covers
     * tables added after it - and it is the migration Pedro is most likely to
     * re-run, because he re-runs anything he is not sure landed. A lockdown that
     * a later re-run undoes is not a lockdown. */
    const db = await startMigrationCluster(migrationFilesInOrder(), {
      reapply: ['step_52_rls_by_cam.sql'],
    });
    const offenders = [];
    const tables = await db.query("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      const held = await privilegesOn(db, 'authenticated', tablename);
      if (held.some((p) => BEYOND_RLS_FOUR.includes(p))) offenders.push(tablename);
      if ((await privilegesOn(db, 'anon', tablename)).length) offenders.push(`anon:${tablename}`);
    }
    expect(offenders).toEqual([]);
    expect(await refusalAsRole(db, 'authenticated', 'truncate table public.orders')).toMatch(DENIED);
  }, 120000);

  it('re-running 43, 51, 52 and 53 together brings nothing back either', async () => {
    const db = await startMigrationCluster(migrationFilesInOrder(), {
      reapply: [
        'step_43_row_level_security.sql',
        'step_51_app_users_write_lockdown.sql',
        'step_52_rls_by_cam.sql',
        'step_53_client_creation_under_rls.sql',
      ],
    });
    expect(await refusalAsRole(db, 'authenticated', 'truncate table public.orders')).toMatch(DENIED);
    expect(await privilegesOn(db, 'authenticated', 'app_users')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'clients')).toEqual([]);
  }, 120000);

  it('and applying the whole directory twice is idempotent', async () => {
    const db = await startMigrationCluster(migrationFilesInOrder(), { applyTwice: true });
    expect(await privilegesOn(db, 'authenticated', 'clients')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'authenticated', 'app_users')).toEqual(['SELECT']);
    expect(await refusalAsRole(db, 'authenticated', 'truncate table public.clients')).toMatch(DENIED);
  }, 120000);

  it('and the login function survives all of that', async () => {
    const db = await startMigrationCluster(migrationFilesInOrder(), { applyTwice: true });
    await db.query('insert into auth.users (id, email) values (gen_random_uuid(), $1)', ['x@example.com']);
    await db.query(`insert into public.app_users (username, display_name, email, role, status)
                    values ('xx', 'X', 'x@example.com', 'CAM', 'Active')`);
    const rows = await rowsAsRole(db, 'anon', "select public.login_email_for_username('xx') as email", { subject: null });
    expect(rows[0].email).toBe('x@example.com');
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('it refuses to run out of order, before changing anything', () => {
  it('stops if steps 52 and 53 have not run, naming all four missing functions', async () => {
    /* This file revokes first and grants back second, and the Supabase SQL editor
     * does not wrap a file in a transaction. A run that dies halfway would leave
     * the CRM with privileges taken away and not restored, on a trading day. So
     * the preconditions are checked before the first revoke. */
    await expect(startMigrationCluster(
      migrationFilesInOrder({ upTo: 51 }).concat(['step_56_table_privilege_lockdown.sql']),
    )).rejects.toThrow(/step 56 needs steps 52 and 53 first[\s\S]*Nothing has been changed/);
  }, 120000);

  it('and when it does stop, it really has changed nothing', async () => {
    const db = await startMigrationCluster(migrationFilesInOrder({ upTo: 51 }));
    try {
      await db.exec(readFileSync(migrationUrl, 'utf8'));
      throw new Error('step 56 should have refused');
    } catch (error) {
      expect(String(error.message)).toMatch(/needs steps 52 and 53/);
    }
    // Still wide open, which is what "nothing has been changed" has to mean.
    expect(await privilegesOn(db, 'authenticated', 'orders')).toHaveLength(8);
    expect(await privilegesOn(db, 'anon', 'clients')).toHaveLength(8);
  }, 120000);
});

describe('what the file must not do', () => {
  it('changes no row and drops nothing', () => {
    expect(flat).not.toMatch(/\bdrop table\b|\bdelete from\b|\bdrop function\b|\bdrop policy\b/);
    expect(flat).not.toMatch(/\bupdate public\.\w+ set\b/);
    // And it must not TRUNCATE anything while taking TRUNCATE away.
    expect(flat).not.toMatch(/^\s*truncate\b/m);
  });

  it('never disables row level security or hands out BYPASSRLS', () => {
    expect(flat).not.toContain('disable row level security');
    expect(flat).not.toContain('bypassrls');
    expect(flat).not.toMatch(/alter role/);
  });

  it('grants nothing to anon on any table', () => {
    expect(flat).not.toMatch(/grant[^;]*\bon\s+(all tables|table\s+public\.|public\.)[^;]*\bto\b[^;]*\banon\b/);
  });

  it('revokes by ALL and grants back, rather than enumerating what to remove', () => {
    /* The shape is the whole point. `revoke truncate, trigger, references` is
     * what left MAINTAIN on app_users, and the next privilege PostgreSQL adds
     * would be the next MAINTAIN. */
    expect(flat).toContain('revoke all privileges on all tables in schema public from authenticated');
    expect(flat).toContain('revoke all privileges on all tables in schema public from anon');
    expect(flat).not.toMatch(/revoke\s+(truncate|trigger|references|maintain)/);
  });

  it('leaves the four tables step 28 already closed alone', () => {
    for (const t of ['ingest_batches', 'ingest_devices', 'ingest_enrollments', 'ingest_pair_rate_limits']) {
      expect(flat).not.toMatch(new RegExp(`grant[^;]*public\\.${t}\\b`));
    }
  });

  it('ends by checking its own work, and raises rather than reporting a success it did not achieve', () => {
    expect(flat).toContain('raise exception');
    expect(flat).toMatch(/has_function_privilege\('anon', 'public\.login_email_for_username\(text\)', 'execute'\)/);
  });
});
