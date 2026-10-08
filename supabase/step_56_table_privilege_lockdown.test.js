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
  applyFileCollectingNotices,
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
const TRUNCATE_STATEMENT = /\btruncate\s+(?!on\b)(?:table\b|only\b|public\.|%|"|'|[a-z_])/;

// ---------------------------------------------------------------------------
// THE MEASUREMENT, as data.
//
// What each table's `authenticated` grant must be after step 56, measured off
// src/domain/supabaseStore.js and src/domain/supabaseAuth.js - the browser's
// entire PostgREST surface. An `upsert` is INSERT **and** UPDATE because
// PostgREST emits `insert ... on conflict do update`.
//
// The four tables marked (var) are reached only through `.from(table)` with a
// variable in createSupabaseDailyImportAdapter, so a grep for `.from('name')` cannot
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
  algorithm_benchmarks: 'SIU', // NOT read-only: saveAlgorithmBenchmarks upserts
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
  /* STEP 55'S PAIR, AND THE REASON THIS WHOLE FILE CHANGED SHAPE. step 55 merged
   * between step 56 being written and step 56 being merged. Step 56's first draft
   * granted back through five hand-written per-table lists, which had never heard
   * of these two, so both came out of it holding nothing - and a four-verb loop
   * over the catalogue would have gone the other way and handed back the INSERT,
   * UPDATE and DELETE step 55 spent three rounds of review revoking. They are
   * read-only for the browser because a CAM able to write account_live_samples can
   * forge a green light on its own client. */
  account_live_samples: 'S',
  account_tracker_settings: 'S',
  /* STEP 57'S PAIR, read-only for the same reason: a CAM able to write
   * algorithm_live_samples could forge a strategy reading and move the desk
   * median every other CAM reads. */
  algorithm_live_samples: 'S',
  algorithm_live_settings: 'S',
  /* STEP 65'S SETTINGS ROW, read-only for the same reason: the thresholds are
   * edited in the SQL editor and a CAM must not be able to turn the auto fail
   * off from the browser. */
  account_observation_settings: 'S',
  // nothing at all
  ingest_admission_settings: '',
  ingest_quarantine_reports: '',
  // and the four step 28 already closed. Step 56 can only leave them alone by
  // NAMING them, because its catalogue default would open all four.
  ingest_batches: '',
  ingest_devices: '',
  ingest_enrollments: '',
  ingest_pair_rate_limits: '',
};

/* The tables step 56's exception table deliberately does NOT narrow: all four
 * verbs, measured. Derived rather than written twice, so this cannot disagree
 * with EXPECTED. */
const FULL_DML_TABLES = Object.entries(EXPECTED)
  .filter(([, code]) => code === 'SIUD').map(([table]) => table);

/* THE EXCEPTION TABLE, read out of the migration as a list of names.
 *
 * The only text-scrape in this file, and it is here to be cross-checked against
 * the live catalogue rather than believed: a row naming a table that does not
 * exist is a decision about nothing, and a dead row is how the next reader
 * concludes a table is locked down when nothing locked it down. The migration
 * raises a NOTICE for these; this is the half that fails. */
const EXCEPTION_ROWS = [...sql.matchAll(/^\s*\('(\w+)',\s*'([a-z, ]*)',/gm)]
  .map((match) => ({ table: match[1], privileges: match[2].trim() }));

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
describe('step 56 exists and is no longer the one that runs last', () => {
  it('appears once, and 57 now carries the highest-number claim', () => {
    /* Handed on the way 55 handed it here: the newest step's own test asserts
     * it is the highest, and leaving the claim behind would make every later
     * migration look like a break in this one. */
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 56)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThan(56);
  });

  it('says why 54 is skipped, and that 55 merged in between', () => {
    /* 54 is still claimed by an unmerged branch, so a reader who finds a gap in
     * the numbering must not conclude a file was lost. 55 is no longer a gap: it
     * merged after this file was written and before it could merge, which is the
     * whole reason this file's grant-back is a loop. */
    expect(raw).toMatch(/54 is claimed by draft PR 65/i);
    expect(raw).toMatch(/55 by PR 67/i);
    expect(raw).toMatch(/THE MIGRATION\s+-- AGAINST STALENESS WENT STALE|MIGRATION AGAINST STALENESS WENT STALE/);
  });

  it('is in the runbook table and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 56 \| `step_56_table_privilege_lockdown\.sql` \|.*\|$/m);
    // 55 is in the order now. It merged before this file did. And 57 follows.
    expect(runbook).toMatch(/→ 53 → 55 → 56(?: →|\.)/);
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
    /* A FLOOR AND NOT AN EQUALITY, and that is a fix rather than a loosening.
     *
     * This line read `toHaveLength(37)`. step 55 landed two tables and the number
     * became 39, so a migration with nothing to do with this one broke this
     * assertion - the same defect as the hand-written grant list it sat beside,
     * in the test instead of in the SQL. A count that has to be edited every time
     * a migration lands is not measuring anything; the loop above already
     * measured every table the catalogue has.
     *
     * The floor is still worth having. It is the guard against the shape where
     * this whole test passes because the query matched nothing - zero tables,
     * zero offenders, green. */
    expect(tables.rows.length).toBeGreaterThan(35);
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
  it('holds exactly the measured grant on each measured table and nothing more', async () => {
    const got = {};
    for (const table of Object.keys(EXPECTED)) got[table] = (await privilegesOn(after, 'authenticated', table)).sort();
    const want = {};
    for (const [table, code] of Object.entries(EXPECTED)) want[table] = expand(code);
    expect(got).toEqual(want);
  });

  it('and the map above covers every table in public, counted from the catalogue', async () => {
    /* THE ASSERTION THAT REPLACES `toHaveLength(37)`, and it does the job that
     * count was trying to do without being a number anybody has to edit.
     *
     * The map is checked for exactness above. This checks it is COMPLETE: every
     * base table the catalogue has is either in the map, or holds exactly the four
     * DML verbs - the catalogue default step 56 gives a table it has never heard
     * of. So a table added by step 57 needs no edit here and is still asserted:
     * it lands in the second branch, where the assertion is that it got the four
     * governed verbs and none of the four that are not. */
    const tables = await after.query(
      "select tablename from pg_tables where schemaname='public' order by 1",
    );
    const wrong = [];
    for (const { tablename } of tables.rows) {
      if (Object.hasOwn(EXPECTED, tablename)) continue;
      const held = await privilegesOn(after, 'authenticated', tablename);
      if (held.join(',') !== DML_FOUR.slice().sort().join(',')) wrong.push(`${tablename}: ${held.join(',')}`);
    }
    expect(wrong).toEqual([]);
    /* AND NOTHING IS ASSERTED ABOUT HOW MANY TOOK THE DEFAULT, on purpose. Today
     * it is none, because every table that exists is measured above. Asserting
     * that it stays none would be `toHaveLength(37)` again: the next migration to
     * land a table would fail this test for no reason of its own. The invariants
     * that must never move are asserted over the whole catalogue elsewhere in this
     * file, and they need no list. */
    expect(tables.rows.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED).length);
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
    /* saveAlgorithmBenchmarks (supabaseStore.js) upserts, called from the
     * My Futures Book import in src/App.jsx a CAM runs holding 36 files.
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
    /* updateSupabaseClient's price-change insert is `.then(() => {}, () => {})`. A revoked INSERT
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
// THE REGRESSION THAT JUST HAPPENED, AND THE ONE TEST THAT WOULD HAVE CAUGHT IT.
//
// Step 55 merged after this migration was written and before it could merge. The
// first draft granted back through five hand-written `grant ... on public.a,
// public.b, ...` statements, so the two new tables came out of it holding
// nothing; and the obvious fix - a loop granting the four DML verbs to
// everything - would have gone the other way and handed back the INSERT, UPDATE
// and DELETE step 55 spent three rounds of review revoking.
//
// Nothing in this suite could see either failure, because every assertion about
// per-table privileges was written against a map of the tables that existed when
// the map was written. So these tests are about a table step 56 has NEVER HEARD
// OF, created on the only side of this migration where it is dangerous: BEFORE
// it, which is where step 55's tables were.
// ---------------------------------------------------------------------------
describe('a table step 56 has never heard of, created BEFORE it runs', () => {
  let db;
  let notices;

  beforeAll(async () => {
    /* The step-55 scenario exactly: a table that exists when step 56 runs and is
     * named nowhere in it. `up_to: 55` then the table then the real file, because
     * startMigrationCluster cannot interleave and the interleaving is the point. */
    db = await startMigrationCluster(migrationFilesInOrder({ upTo: 55 }));
    await db.exec(`create table public.step_55_and_a_half (
      id uuid primary key default gen_random_uuid(),
      client_id uuid references public.clients(id) on delete cascade,
      note text);`);
    // Born with all eight, which is the hole, and the reason this matters at all.
    expect(await privilegesOn(db, 'authenticated', 'step_55_and_a_half')).toHaveLength(8);
    notices = await applyFileCollectingNotices(db, 'step_56_table_privilege_lockdown.sql');
  }, 120000);

  it('DOES NOT END UP WITH TRUNCATE, which is the whole episode in one assertion', async () => {
    /* Not the catalogue alone: the role is made to try it. TRUNCATE is not subject
     * to row level security, so no policy test in this repository says one word
     * about this table, and the grant is the only thing standing in the way. */
    const error = await refusalAsRole(db, 'authenticated', 'truncate table public.step_55_and_a_half');
    expect(error).toMatch(/^permission denied for table step_55_and_a_half/);
  });

  it('and none of the other three row level security cannot govern either', async () => {
    const held = await privilegesOn(db, 'authenticated', 'step_55_and_a_half');
    expect(held.filter((p) => BEYOND_RLS_FOUR.includes(p))).toEqual([]);
  });

  it('gives anon nothing on it', async () => {
    expect(await privilegesOn(db, 'anon', 'step_55_and_a_half')).toEqual([]);
    expect(await refusalAsRole(db, 'anon', 'select * from public.step_55_and_a_half limit 1'))
      .toMatch(DENIED);
  });

  it('gives authenticated the four verbs, the same four a table created AFTER gets', async () => {
    /* The deliberate half of the decision. An unlisted table could have been given
     * nothing instead, and that was rejected: section 5's `alter default
     * privileges` hands the four verbs to a table created after this file, so
     * giving an unlisted table nothing would make a table's privileges depend on
     * which side of this migration it happened to be created on. */
    expect(await privilegesOn(db, 'authenticated', 'step_55_and_a_half')).toEqual(DML_FOUR.slice().sort());
  });

  it('and the migration SAYS SO, by name, in a NOTICE', () => {
    /* The other half, and the reason the NOTICE is captured rather than described.
     * Granting in silence is how step 55 would have been undone: nothing in the
     * catalogue distinguishes a table nobody has decided about from a table
     * somebody decided should be read-only. So the file names them out loud.
     *
     * It is a NOTICE and not an exception deliberately - a migration that refused
     * to run until somebody edited it would be the hand-written list again, and
     * Pedro re-runs files he is not sure landed. */
    const named = notices.filter((n) => /step_55_and_a_half/.test(n));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/named in no exception row/i);
    expect(named[0]).toMatch(/exception table in step_56_table_privilege_lockdown\.sql/);
  });

  it('and does not warn that the loop disagreed with the exception table', () => {
    /* The migration checks its own loop row by row and raises a WARNING on a
     * mismatch. A clean run must produce none - which is also what proves the
     * check RAN: a deleted check and a passing check both say nothing, so the
     * assertion below pins the statement's presence and this one pins its silence. */
    expect(notices.filter((n) => /did not produce what the exception table says/.test(n)))
      .toEqual([]);
  });

  it('says nothing about the tables it HAS heard of, so the notice is signal', async () => {
    /* A notice that fires for all 39 tables every run is a notice nobody reads.
     * Every table that exists today is named in the exception table, which is why
     * the only name in it is the one this test invented. */
    const defaulted = notices.filter((n) => /named in no exception row/i.test(n));
    expect(defaulted).toHaveLength(1);
    for (const table of Object.keys(EXPECTED)) {
      expect(defaulted[0], `${table} is in the exception table and must not be named`)
        .not.toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the exception table, which is the only list left in the file', () => {
  it('grants back through a loop over the catalogue, not through a per-table list', () => {
    /* THE SHAPE, asserted so the five hand-written grant statements cannot come
     * back. The revoke already had no list; the grant-back is what went stale. */
    expect(flat).toMatch(/for r in[\s\S]*from pg_class c[\s\S]*loop/);
    expect(flat).toContain("format('grant %s on public.%i to authenticated'");
    // Not one `grant <verbs> on public.<table> to authenticated` left anywhere.
    expect(flat).not.toMatch(/grant\s+[a-z, ]*on\s+public\.\w+[^;]*to authenticated/);
  });

  it('checks its own loop, and says so rather than failing a trading day over it', () => {
    /* A TEXT ASSERTION, and the reason is in the migration beside the statement.
     * Raising there would roll back the DO block - the grants - while leaving the
     * committed `revoke all` above in place, which is exactly the "privileges taken
     * away and not restored" that section 0 exists to prevent. So the migration
     * warns and this file is where the same claim fails hard: the per-row assertion
     * below is the loud version. These two lines only guarantee the migration's own
     * half has not been quietly deleted. */
    expect(flat).toContain('raise warning');
    expect(flat).toMatch(/did not produce what the exception table says/);
    expect(flat).toMatch(/has_table_privilege\('authenticated', format\('public\.%i', e\.table_name\), p\)/);
  });

  it('reads as rows this test can see, so what follows is not asserted against a comment', () => {
    expect(EXCEPTION_ROWS.length).toBeGreaterThan(30);
    expect(EXCEPTION_ROWS.map((row) => row.table)).toContain('account_live_samples');
    expect(EXCEPTION_ROWS.map((row) => row.table)).toContain('ingest_batches');
  });

  it('names no table that does not exist, because a dead row is a decision about nothing', async () => {
    /* The migration raises a NOTICE for these and carries on - dropping a table
     * must not make an earlier migration unrunnable. This is the half that fails,
     * and it is the right place for it: nobody's desk depends on this file. */
    const real = new Set((await after.query(
      "select tablename from pg_tables where schemaname='public'",
    )).rows.map((row) => row.tablename));
    expect(EXCEPTION_ROWS.filter((row) => !real.has(row.table)).map((row) => row.table)).toEqual([]);
  });

  it('and every row produced exactly the privileges it claims', async () => {
    /* The migration checks this too and raises a WARNING rather than an exception,
     * because raising there would roll back the grants while leaving the committed
     * revoke in place - privileges taken away and not restored, on a trading day,
     * which is what section 0 exists to prevent. So the loud version is here. */
    const disagrees = [];
    for (const { table, privileges } of EXCEPTION_ROWS) {
      const want = privileges ? privileges.split(',').map((p) => p.trim().toUpperCase()).sort() : [];
      const held = await privilegesOn(after, 'authenticated', table);
      if (held.join(',') !== want.join(',')) disagrees.push(`${table}: wants ${want} holds ${held}`);
    }
    expect(disagrees).toEqual([]);
  });

  it('names every table that gets the four verbs too, so silence means "nobody decided"', () => {
    /* Without these seven rows, a table absent from the exception table could mean
     * either "four verbs on purpose" or "never heard of it", and the NOTICE above
     * would be worthless. */
    const four = EXCEPTION_ROWS
      .filter((row) => row.privileges === 'select, insert, update, delete')
      .map((row) => row.table).sort();
    expect(four).toEqual(FULL_DML_TABLES.slice().sort());
  });

  it('gives a reason on every row, and the reason names a migration or a file', () => {
    /* `decided_by` is the column that makes this list different from the one it
     * replaced: a per-table grant with no reason is a line nobody can safely
     * change. The six rows that grant NOTHING are the ones this matters most for,
     * because a loop with no exceptions opens all six. */
    const rows = [...sql.matchAll(/^\s*\('(\w+)',\s*'([a-z, ]*)',\s*'([^']+)'\)/gm)];
    expect(rows).toHaveLength(EXCEPTION_ROWS.length);
    for (const [, table, , reason] of rows) {
      expect(reason, `${table} must say what decided it`).toMatch(/step \d+|supabaseStore\.js/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('step 55 is not undone by the migration that runs after it', () => {
  /* The failure a careless fix would have shipped. step 55 revoked everything from
   * both browser roles on its two tables and granted SELECT back, because a CAM
   * able to write account_live_samples can forge a green light on its own client,
   * and a row it can delete is an account that vanishes from the screen that exists
   * to show it. step 56 runs after step 55, so step 56 wins. */
  for (const table of ['account_live_samples', 'account_tracker_settings']) {
    it(`${table} still holds exactly SELECT for authenticated, and nothing for anon`, async () => {
      expect(await privilegesOn(after, 'authenticated', table)).toEqual(['SELECT']);
      expect(await privilegesOn(after, 'anon', table)).toEqual([]);
    });

    it(`and a signed-in CAM is still refused every write on ${table}`, async () => {
      for (const statement of [
        `insert into public.${table} (${columnOf[table]}) values (null)`,
        `update public.${table} set ${columnOf[table]} = ${columnOf[table]} where false`,
        `delete from public.${table} where false`,
        `truncate table public.${table}`,
      ]) {
        expect(
          await refusalAsRole(after, 'authenticated', statement, { subject: managerId }),
          statement,
        ).toMatch(DENIED);
      }
    });
  }

  it('and the anon SELECT step 55 granted is gone from step 55 ITSELF, not only revoked later', () => {
    /* The two files disagreed: step 55 granted SELECT to anon and the invariant in
     * anon_keeps_the_login_function.test.js says no migration grants a table
     * privilege to anon. Settled by narrowing step 55 rather than by excusing it,
     * because this file's blanket revoke already made the grant dead - and a dead
     * grant is one a policy added later turns live by accident, which is the hazard
     * step 51 left on app_users. The evidence is in this file's header: the one
     * browser reader is behind a session, no policy admits anon to a row, and the
     * /database probe does not name either table. */
    const step55 = readFileSync(new URL('./step_55_account_live_samples.sql', import.meta.url), 'utf8')
      .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(step55).toContain('grant select on public.account_live_samples to authenticated;');
    expect(step55).toContain('grant select on public.account_tracker_settings to authenticated;');
    expect(step55).not.toMatch(/grant select on public\.account_\w+ to[^;]*anon/);
    // The revoke still names anon, which is what actually takes it away.
    expect(step55).toContain('revoke all on public.account_live_samples from anon, authenticated;');
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
    // And it must not TRUNCATE anything while taking TRUNCATE away. `flat` is
    // one line, so an anchored pattern could only ever see the file's first
    // token; this one finds the statement anywhere, static or built for
    // `execute`, and steps over the prose that names the privilege
    // ("can truncate,", 'truncate', "delete/truncate/") and `revoke truncate on`.
    expect(flat).not.toMatch(TRUNCATE_STATEMENT);
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
