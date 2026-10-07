// Step 59, asked of the database rather than read off the file.
//
// Every assertion that matters here runs AS THE ROLE: `authenticated` with
// request.jwt.claim.sub set to a specific CAM, a Manager, an Inactive CAM or a
// signed-in stranger, and `anon` with no subject, against a cluster carrying
// every migration in this directory (supabase/migrationCluster.js, Supabase's
// real default privileges). A second cluster stopped at 58 shows the defect
// existing, so a green "after" cannot be a test that would have passed anyway.
//
// The loader the browser runs, loadLogAlgoHistory, is exercised against the
// same cluster through a small PostgREST-shaped adapter, so the card's rows
// are proved from the database's answer and not from a hand-written fixture.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFileCollectingNotices,
  migrationFilesInOrder,
  one,
  privilegesOn,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';
import { aggregateLogFamilyHistory } from '../src/domain/ninjaTraderLog.js';
import { loadLogAlgoHistory, logAlgoHistoryFromRow } from '../src/domain/supabaseStore.js';

const migrationUrl = new URL('./step_59_log_algo_history_by_family.sql', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

const RLS_REFUSED = /new row violates row-level security policy for table "log_algo_history"/;
const DENIED = /permission denied for (table|function)/;

let after;
let before;
const world = { clients: {} };

/** Runs one statement as `role` with `subject` signed in and KEEPS its effect. */
async function committedAsRole(db, role, subject, statement, params) {
  await db.exec('begin');
  try {
    await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', subject]);
    await db.exec(`set local role ${role}`);
    const result = await db.query(statement, params);
    await db.exec('commit');
    return result.rows;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

/**
 * The two calls loadLogAlgoHistory makes, answered by the cluster as the role.
 *
 * Each row goes through to_jsonb, because that is what PostgREST sends: a date
 * as 'YYYY-MM-DD' and a numeric as a JSON number, where PGlite on its own hands
 * back a Date object and a string. Errors come back the way supabase-js gets
 * them, `{ code, message }` with the SQLSTATE as the code, which is what the
 * loader branches on.
 */
function asPostgrest(db, subject, role = 'authenticated') {
  async function run(statement) {
    try {
      const rows = await rowsAsRole(db, role, statement, { subject });
      return { data: rows.map((row) => row.row), error: null };
    } catch (error) {
      return { data: null, error: { code: error.code, message: String(error.message || error) } };
    }
  }
  return {
    rpc: (name) => run(`select to_jsonb(r) as row from public.${name}() r`),
    from: (table) => ({ select: () => run(`select to_jsonb(t) as row from public.${table} t`) }),
  };
}

async function seed(db) {
  const authUser = (email) => one(db, 'insert into auth.users (email) values ($1) returning id', [email]);
  async function cam(name, status = 'Active') {
    const profile = await one(db, 'insert into public.cam_profiles (name) values ($1) returning id', [name]);
    const auth = await authUser(`${name.toLowerCase()}@example.com`);
    const appUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id, cam_profile_id)
      values ($1, $1, $2, 'CAM', $3, $4, $5) returning id`, [name.toLowerCase(), `${name.toLowerCase()}@example.com`, status, auth, profile]);
    return { profile, auth, appUser };
  }
  const w = { clients: {} };
  w.gray = await cam('Gray');
  w.birch = await cam('Birch');
  w.ash = await cam('Ash');
  w.gone = await cam('Gone', 'Inactive');
  w.managerAuth = await authUser('mgr@example.com');
  w.managerUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [w.managerAuth]);
  w.strangerAuth = await authUser('stranger@example.com');

  async function client(key, owner, accounts) {
    w.clients[key] = await one(db,
      "insert into public.clients (name, status, product_key) values ($1, 'Active', $2) returning id", [`Client ${key}`, `pk-${key}`]);
    if (owner) {
      await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [w.clients[key], owner.profile]);
    }
    for (const account of accounts) {
      await db.query('insert into public.trading_accounts (client_id, account_name) values ($1, $2)', [w.clients[key], account]);
    }
  }
  await client('G1', w.gray, ['G1-A']);
  await client('B1', w.birch, ['B1-A', 'B1-B', 'B1-C', 'B1-D', 'B1-E']);
  await client('B2', w.birch, ['B2-A']);
  await client('B3', w.birch, ['B3-A']);
  await client('A1', w.ash, ['A1-A']);
  // Registered, assigned to nobody.
  await client('U1', null, ['U1-A']);
  // Held by Gone, whose user is Inactive.
  await client('X1', w.gone, ['X1-A']);
  return w;
}

/** Steps 53 and 28 put these two in Gray's book whoever holds them today. */
async function seedGraysOtherClients(db, w) {
  // CR: Gray creates it through the browser's own statements, assigns it to
  // herself, and a Manager then moves it to Birch.
  const [created] = await committedAsRole(db, 'authenticated', w.gray.auth,
    "insert into public.clients (name, status, stage) values ('Client CR', 'Active', 'Active') returning id");
  w.clients.CR = created.id;
  await committedAsRole(db, 'authenticated', w.gray.auth,
    `insert into public.client_assignments (client_id, cam_profile_id, assignment_role) values ($1, $2, 'Owner')
     on conflict (client_id, cam_profile_id) do update set assignment_role = excluded.assignment_role`,
    [w.clients.CR, w.gray.profile]);
  await db.query('insert into public.trading_accounts (client_id, account_name) values ($1, $2)', [w.clients.CR, 'CR-A']);
  // EN: the desk created it and gave it to Gray, Gray enrolled its VPS, and a
  // Manager then moved it to Birch.
  w.clients.EN = await one(db,
    "insert into public.clients (name, status, product_key) values ('Client EN', 'Active', 'pk-EN') returning id");
  await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [w.clients.EN, w.gray.profile]);
  await db.query('insert into public.trading_accounts (client_id, account_name) values ($1, $2)', [w.clients.EN, 'EN-A']);
  await db.query(
    `select * from public.create_ingest_enrollment($1, 'code-EN', $2, now() + interval '1 hour', false, 'generated', null)`,
    [w.clients.EN, w.gray.appUser]);
  for (const key of ['CR', 'EN']) {
    await committedAsRole(db, 'authenticated', w.managerAuth,
      "delete from public.client_assignments where client_id = $1 and assignment_role = 'Owner'", [w.clients[key]]);
    await committedAsRole(db, 'authenticated', w.managerAuth,
      "insert into public.client_assignments (client_id, cam_profile_id, assignment_role) values ($1, $2, 'Owner')",
      [w.clients[key], w.birch.profile]);
  }
}

// Family -> [account, date, direction, realized, round trips]. Each family is
// built to sit on one side of the floor (5 accounts and 3 clients outside the
// caller's book, the defaults) for a named CAM and not for another. A DEAD-
// account is one no client holds: it adds to every figure and never to the
// floor.
const HISTORY = {
  // Outside Gray: B1-A B2-A B3-A A1-A U1-A, five accounts on five clients,
  // plus two dead accounts in the figures.
  OGX: [
    ['U1-A', '2026-10-03', 'Long', 12, 1],
    ['G1-A', '2026-10-01', 'Long', 100, 3], ['B1-A', '2026-10-01', 'Long', -200.25, 4],
    ['B2-A', '2026-10-01', 'Short', 50.5, 1], ['B3-A', '2026-10-02', 'Mixed', 25, 2],
    ['A1-A', '2026-10-02', 'Long', 10, 1], ['DEAD-1', '2026-10-02', 'Short', -5.75, null],
    // An empty direction is Mixed to the browser, an unknown one moves only the total.
    ['DEAD-2', '2026-10-02', null, 7, 1], ['DEAD-2', '2026-10-03', 'Flat', 3, 1],
  ],
  // Five accounts, ONE client: the account floor met and the owner floor not.
  BulletBot: [
    ['B1-A', '2026-10-01', 'Long', 400, 2], ['B1-B', '2026-10-01', 'Long', 410, 2],
    ['B1-C', '2026-10-01', 'Short', -90, 2], ['B1-D', '2026-10-01', 'Long', 15, 1],
    ['B1-E', '2026-10-01', 'Long', 20, 1], ['G1-A', '2026-10-01', 'Short', -1, 1],
  ],
  // Accounts nobody holds: no owner, so they never meet the floor for a CAM.
  DeadOnly: [
    ['DEAD-3', '2026-09-01', 'Long', 1, 1], ['DEAD-4', '2026-09-01', 'Long', 2, 1],
    ['DEAD-5', '2026-09-01', 'Long', 3, 1], ['DEAD-6', '2026-09-01', 'Short', 4, 1],
    ['DEAD-7', '2026-09-02', 'Short', 5, 1],
  ],
  // Two accounts. Withheld from every CAM.
  Thin: [['B2-A', '2026-10-01', 'Long', -1234.56, 5], ['DEAD-8', '2026-10-01', 'Long', 3, 1]],
  // Four outside Gray once her ASSIGNED G1 is left out; five outside Ash.
  Assigned: [
    ['G1-A', '2026-10-01', 'Long', 1, 1], ['B2-A', '2026-10-01', 'Long', 1, 1],
    ['B3-A', '2026-10-01', 'Long', 1, 1], ['U1-A', '2026-10-01', 'Long', 1, 1],
    ['X1-A', '2026-10-01', 'Long', 1, 1], ['DEAD-11', '2026-10-01', 'Long', 1, 1],
  ],
  // Same shape with the client Gray CREATED, now held by Birch.
  Created: [
    ['CR-A', '2026-10-01', 'Long', 1, 1], ['B2-A', '2026-10-01', 'Long', 1, 1],
    ['B3-A', '2026-10-01', 'Long', 1, 1], ['U1-A', '2026-10-01', 'Long', 1, 1],
    ['X1-A', '2026-10-01', 'Long', 1, 1],
  ],
  // Same shape with the client Gray ENROLLED, now held by Birch.
  Enrolled: [
    ['EN-A', '2026-10-01', 'Long', 1, 1], ['B2-A', '2026-10-01', 'Long', 1, 1],
    ['B3-A', '2026-10-01', 'Long', 1, 1], ['U1-A', '2026-10-01', 'Long', 1, 1],
    ['X1-A', '2026-10-01', 'Long', 1, 1],
  ],
  // An empty family is Unknown to the browser.
  '': [['DEAD-12', null, 'Long', 9, 1], ['', '2026-10-01', 'Short', 1, null]],
};

async function seedHistory(db) {
  for (const [family, rows] of Object.entries(HISTORY)) {
    for (const [account, date, direction, pnl, trips] of rows) {
      await db.query(`insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
        values ($1, $2, $3, $4, $5, $6)`, [date, account, family, direction, pnl, trips]);
    }
  }
}

async function familiesFor(db, subject) {
  const rows = await rowsAsRole(db, 'authenticated', 'select * from public.log_algo_history_by_family()', { subject });
  return Object.fromEntries(rows.map((row) => [row.family, row]));
}

beforeAll(async () => {
  after = await startMigrationCluster(migrationFilesInOrder(), { applyTwice: true });
  Object.assign(world, await seed(after));
  await seedGraysOtherClients(after, world);
  await seedHistory(after);

  before = await startMigrationCluster(migrationFilesInOrder({ upTo: 58 }));
  world.before = await seed(before);
  await seedHistory(before);
}, 180_000);

afterAll(async () => {
  await after?.close?.();
  await before?.close?.();
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 59 exists and is no longer the one that runs last', () => {
  it('appears once, 60 carries the highest-number claim, and 54 is still a gap', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 59)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThan(59);
    expect(numbers).not.toContain(54);
  });

  it('is in the runbook table after 57 and in the run order', () => {
    expect(runbook).toMatch(/^\| 59 \| `step_59_log_algo_history_by_family\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 59 | `step_59_log_algo_history_by_family.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 57 | `step_57_algorithm_live_samples.sql`'));
    expect(runbook).toContain('→ 59 → 60');
  });
});

/* ── The defect, on a cluster stopped at 58 ───────────────────────────────── */

describe('before step 59: every CAM reads and rewrites every book', () => {
  it('a CAM reads another CAM\'s account, family and P&L', async () => {
    const rows = await rowsAsRole(before, 'authenticated',
      "select account_name, realized_pnl from public.log_algo_history where account_name = 'B2-A' and family = 'Thin'",
      { subject: world.before.gray.auth });
    expect(rows).toEqual([{ account_name: 'B2-A', realized_pnl: '-1234.56' }]);
  });

  it('a CAM overwrites another CAM\'s row with the browser\'s own upsert', async () => {
    const rows = await rowsAsRole(before, 'authenticated',
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
       values ('2026-10-01', 'B2-A', 'Thin', 'Long', 0, 0)
       on conflict (log_date, account_name, family) do update set realized_pnl = excluded.realized_pnl
       returning realized_pnl`, { subject: world.before.gray.auth });
    expect(rows).toEqual([{ realized_pnl: '0' }]);
  });

  it('a signed-in session with no CRM user reads every row', async () => {
    const [{ n }] = await rowsAsRole(before, 'authenticated',
      'select count(*)::int as n from public.log_algo_history', { subject: world.before.strangerAuth });
    expect(n).toBeGreaterThan(30);
  });

  it('and the browser loader falls back to that read while the function does not exist', async () => {
    const families = await loadLogAlgoHistory({ client: asPostgrest(before, world.before.gray.auth) });
    expect(families.find((row) => row.family === 'Thin')).toMatchObject({ withheld: false, totalPnl: -1231.56, accounts: 2 });
  });
});

/* ── The rows: a Manager's alone ──────────────────────────────────────────── */

describe('after step 59: the rows', () => {
  it('a CAM reads none, not even the rows of her own accounts', async () => {
    for (const cam of [world.gray, world.birch, world.ash]) {
      const [{ n }] = await rowsAsRole(after, 'authenticated',
        'select count(*)::int as n from public.log_algo_history', { subject: cam.auth });
      expect(n).toBe(0);
    }
  });

  it('a CAM cannot change a row: the update finds nothing, the insert and the upsert are refused', async () => {
    const updated = await rowsAsRole(after, 'authenticated',
      "update public.log_algo_history set realized_pnl = 99999 where account_name = 'B2-A' returning id",
      { subject: world.gray.auth });
    expect(updated).toEqual([]);
    expect(await refusalAsRole(after, 'authenticated',
      "insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl) values ('2026-10-09', 'B2-A', 'OGX', 'Long', 5)",
      { subject: world.gray.auth })).toMatch(RLS_REFUSED);
    expect(await refusalAsRole(after, 'authenticated',
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
       values ('2026-10-01', 'B2-A', 'Thin', 'Long', 0, 0)
       on conflict (log_date, account_name, family) do update set realized_pnl = excluded.realized_pnl`,
      { subject: world.gray.auth })).toMatch(RLS_REFUSED);
    expect(await one(after,
      "select realized_pnl from public.log_algo_history where account_name = 'B2-A' and family = 'Thin'")).toBe('-1234.56');
  });

  it('a signed-in stranger and an Inactive CAM read none', async () => {
    for (const subject of [world.strangerAuth, world.gone.auth]) {
      const [{ n }] = await rowsAsRole(after, 'authenticated',
        'select count(*)::int as n from public.log_algo_history', { subject });
      expect(n).toBe(0);
    }
  });

  it('anon is refused at the grant, as step 56 left it', async () => {
    expect(await refusalAsRole(after, 'anon', 'select * from public.log_algo_history', { subject: null })).toMatch(DENIED);
  });

  it('a Manager reads every row and the import\'s upsert, RETURNING included, still works', async () => {
    const [{ n }] = await rowsAsRole(after, 'authenticated',
      'select count(*)::int as n from public.log_algo_history', { subject: world.managerAuth });
    expect(n).toBe(Object.values(HISTORY).flat().length);
    const rows = await rowsAsRole(after, 'authenticated',
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
       values ('2026-10-01', 'B2-A', 'Thin', 'Long', -1300, 5), ('2026-10-05', 'NEW-1', 'OGX', 'Long', 1, 1)
       on conflict (log_date, account_name, family) do update
         set direction = excluded.direction, realized_pnl = excluded.realized_pnl, round_trips = excluded.round_trips
       returning account_name, realized_pnl`, { subject: world.managerAuth });
    expect(rows).toHaveLength(2);
  });

  it('keeps step 56\'s grants: the policy decides, not a revoke a re-run of 56 would undo', async () => {
    expect(await privilegesOn(after, 'authenticated', 'log_algo_history')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(after, 'anon', 'log_algo_history')).toEqual([]);
    const policies = await after.query(
      "select policyname, permissive, cmd from pg_policies where schemaname = 'public' and tablename = 'log_algo_history'");
    expect(policies.rows).toEqual([
      { policyname: 'managers read and write the log history', permissive: 'PERMISSIVE', cmd: 'ALL' },
    ]);
  });
});

/* ── The aggregate ────────────────────────────────────────────────────────── */

describe('after step 59: log_algo_history_by_family()', () => {
  it('gives a Manager every family, with the numbers the browser computed from the rows', async () => {
    /* The parity that lets the card keep its meaning: the same rows through the
     * browser's mapper and aggregateLogFamilyHistory, against the function. */
    const rows = (await after.query('select to_jsonb(t) as row from public.log_algo_history t')).rows.map((r) => r.row);
    const browser = aggregateLogFamilyHistory(rows.map(logAlgoHistoryFromRow));
    const database = await loadLogAlgoHistory({ client: asPostgrest(after, world.managerAuth) });
    const byFamily = (list) => [...list].sort((a, b) => a.family.localeCompare(b.family));
    expect(database.every((row) => row.withheld === false)).toBe(true);
    expect(byFamily(database)).toEqual(byFamily(browser).map((row) => ({ ...row, withheld: false })));
    expect(database.map((row) => row.family)).toContain('Unknown');
  });

  it('shows a CAM the family run on enough accounts outside her book, as the desk figure', async () => {
    const gray = await familiesFor(after, world.gray.auth);
    const manager = await familiesFor(after, world.managerAuth);
    expect(gray.OGX.status).toBe('shown');
    // Her own G1-A and the two dead accounts are in the total: the number is
    // the Manager's, not "the rest".
    expect(gray.OGX).toEqual(manager.OGX);
    expect(gray.OGX.accounts).toBe(8);
  });

  it('withholds a family run only on accounts no client held when they were imported', async () => {
    // Indistinguishable from her own accounts renamed before the import, so
    // they never make the floor; the Manager still reads the family.
    for (const cam of [world.gray, world.birch, world.ash]) {
      expect((await familiesFor(after, cam.auth)).DeadOnly.status).toBe('withheld');
    }
    expect((await familiesFor(after, world.managerAuth)).DeadOnly).toMatchObject({ status: 'shown', accounts: 5 });
  });

  it('withholds a family whose outside accounts all belong to one client', async () => {
    for (const cam of [world.gray, world.ash]) {
      expect((await familiesFor(after, cam.auth)).BulletBot.status).toBe('withheld');
    }
    expect((await familiesFor(after, world.managerAuth)).BulletBot.status).toBe('shown');
  });

  it('withholds EVERY number of a withheld family, the counts included', async () => {
    const thin = (await familiesFor(after, world.gray.auth)).Thin;
    expect(thin).toEqual({
      family: 'Thin', status: 'withheld', total_pnl: null, long_pnl: null, short_pnl: null,
      mixed_pnl: null, round_trips: null, accounts: null, days: null,
    });
  });

  it('leaves out the clients ASSIGNED to the caller when counting', async () => {
    expect((await familiesFor(after, world.gray.auth)).Assigned.status).toBe('withheld');
    expect((await familiesFor(after, world.ash.auth)).Assigned.status).toBe('shown');
  });

  it('leaves out a client the caller CREATED, though a Manager moved it to Birch', async () => {
    expect(await one(after, 'select cam_profile_id from public.client_assignments where client_id = $1',
      [world.clients.CR])).toBe(world.birch.profile);
    expect((await familiesFor(after, world.gray.auth)).Created.status).toBe('withheld');
    expect((await familiesFor(after, world.ash.auth)).Created.status).toBe('shown');
  });

  it('leaves out a client the caller ENROLLED, though a Manager moved it to Birch', async () => {
    expect((await familiesFor(after, world.gray.auth)).Enrolled.status).toBe('withheld');
    expect((await familiesFor(after, world.ash.auth)).Enrolled.status).toBe('shown');
  });

  it('reads its floors from algorithm_live_settings, the desk\'s one floor', async () => {
    await after.query('update public.algorithm_live_settings set min_cohort_accounts = 7 where id');
    try {
      expect((await familiesFor(after, world.gray.auth)).OGX.status).toBe('withheld');
      expect((await familiesFor(after, world.managerAuth)).OGX.status).toBe('shown');
    } finally {
      await after.query('update public.algorithm_live_settings set min_cohort_accounts = 5 where id');
    }
    expect((await familiesFor(after, world.gray.auth)).OGX.status).toBe('shown');
  });

  it('answers nothing to a stranger or an Inactive CAM, and refuses anon at the grant', async () => {
    for (const subject of [world.strangerAuth, world.gone.auth]) {
      expect(await rowsAsRole(after, 'authenticated', 'select * from public.log_algo_history_by_family()', { subject }))
        .toEqual([]);
    }
    expect(await refusalAsRole(after, 'anon', 'select * from public.log_algo_history_by_family()', { subject: null }))
      .toMatch(DENIED);
  });

  it('reaches the card through the browser\'s loader with nulls, never zeros, for a withheld family', async () => {
    const families = await loadLogAlgoHistory({ client: asPostgrest(after, world.gray.auth) });
    expect(families.find((row) => row.family === 'Thin')).toEqual({
      family: 'Thin', withheld: true, totalPnl: null, roundTrips: null,
      byDirection: { Long: null, Short: null, Mixed: null }, accounts: null, days: null,
    });
    expect(families.find((row) => row.family === 'OGX')).toMatchObject({ withheld: false, accounts: 8 });
  });
});

/* ── A CAM moving her own accounts out of her book ────────────────────────── */

describe('after step 59: a CAM cannot move her own accounts outside her book', () => {
  /* The attack the first draft of this file let through. Who owns a row was
   * decided when the card was READ, by matching the account name against the
   * trading_accounts of today, and step 52 lets a CAM rename and delete the
   * trading accounts of her own clients (the account registry and
   * deleteSupabaseTradingAccount do it from the browser). Renamed or deleted,
   * her accounts counted as accounts nobody holds, one owner each, so four of
   * hers and ONE of Birch's met the floor, and the desk total minus her own
   * figure, which the log import writes into her client's activity, was
   * Birch's account to the cent.
   *
   * Every family below is four of Gray's accounts and one account of another
   * book, so it must stay withheld from Gray whatever she does to her own
   * registry, and every action is hers, as the role, committed. */
  const MINE = [10, 20, 30, 40];
  const OUTSIDE = { RenameAfter: ['B2-A', -777.77], DeleteAfter: ['B3-A', -555.55], ClientAfter: ['A1-A', -333.33] };

  async function graysClient(key, accounts) {
    world.clients[key] = await one(after,
      "insert into public.clients (name, status, product_key) values ($1, 'Active', $2) returning id", [`Client ${key}`, `pk-${key}`]);
    await after.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
      [world.clients[key], world.gray.profile]);
    for (const account of accounts) {
      await after.query('insert into public.trading_accounts (client_id, account_name) values ($1, $2)', [world.clients[key], account]);
    }
  }

  /** The Manager's import, as the role, in the browser's own upsert shape. */
  async function managerImports(family, rows) {
    for (const [account, pnl] of rows) {
      await committedAsRole(after, 'authenticated', world.managerAuth,
        `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
         values ('2026-10-04', $1, $2, 'Long', $3, 1)
         on conflict (log_date, account_name, family) do update
           set direction = excluded.direction, realized_pnl = excluded.realized_pnl, round_trips = excluded.round_trips`,
        [account, family, pnl]);
    }
  }

  const accountsOf = (key) => MINE.map((_, i) => `${key}-${String.fromCharCode(65 + i)}`);
  const hers = (key) => accountsOf(key).map((account, i) => [account, MINE[i]]);

  beforeAll(async () => {
    for (const family of Object.keys(OUTSIDE)) {
      const key = `L${family[0]}`;
      if (key === 'LC') {
        // Split over two of her clients, so that if a deleted client still
        // counted as an owner, hers would be two of the three owners needed.
        await graysClient('LC', accountsOf('LC').slice(0, 2));
        await graysClient('LK', accountsOf('LC').slice(2));
      } else {
        await graysClient(key, accountsOf(key));
      }
      await managerImports(family, [...hers(key), OUTSIDE[family]]);
    }
    await graysClient('LE', accountsOf('LE'));
    await graysClient('LS', ['LS-A', 'LS-B', 'LS-C', 'LS-D']);
  }, 60_000);

  it('each family starts withheld from Gray and shown to the Manager', async () => {
    const gray = await familiesFor(after, world.gray.auth);
    const manager = await familiesFor(after, world.managerAuth);
    for (const family of Object.keys(OUTSIDE)) {
      expect(gray[family].status).toBe('withheld');
      expect(manager[family].status).toBe('shown');
    }
  });

  it('renaming her trading accounts after the import leaves the family withheld', async () => {
    const renamed = await committedAsRole(after, 'authenticated', world.gray.auth,
      "update public.trading_accounts set account_name = account_name || '-renamed' where client_id = $1 returning id",
      [world.clients.LR]);
    expect(renamed).toHaveLength(4);
    expect((await familiesFor(after, world.gray.auth)).RenameAfter).toMatchObject({ status: 'withheld', total_pnl: null });
  });

  it('deleting her trading accounts after the import leaves the family withheld', async () => {
    const deleted = await committedAsRole(after, 'authenticated', world.gray.auth,
      'delete from public.trading_accounts where client_id = $1 returning id', [world.clients.LD]);
    expect(deleted).toHaveLength(4);
    expect((await familiesFor(after, world.gray.auth)).DeleteAfter).toMatchObject({ status: 'withheld', total_pnl: null });
  });

  it('a deleted client\'s accounts do not become outside accounts either', async () => {
    // Nobody signed in can delete a client (step 56 left authenticated no
    // DELETE on clients), but the desk can from the SQL editor, and the accounts
    // of a client that no longer exists are still the ones Gray knew.
    for (const subject of [world.gray.auth, world.managerAuth]) {
      expect(await refusalAsRole(after, 'authenticated', 'delete from public.clients where id = $1',
        { subject, params: [world.clients.LC] })).toMatch(DENIED);
    }
    const deleted = await after.query('delete from public.clients where id = any ($1) returning id',
      [[world.clients.LC, world.clients.LK]]);
    expect(deleted.rows).toHaveLength(2);
    expect((await familiesFor(after, world.gray.auth)).ClientAfter).toMatchObject({ status: 'withheld', total_pnl: null });
  });

  it('renaming them BEFORE the import does not make them outside accounts either', async () => {
    // The import then finds no holder for her four names. An account nobody
    // held when it was imported is in the desk total and never in the floor.
    await committedAsRole(after, 'authenticated', world.gray.auth,
      "update public.trading_accounts set account_name = 'elsewhere-' || account_name where client_id = $1",
      [world.clients.LE]);
    await managerImports('RenameBefore', [...hers('LE'), ['U1-A', -111.11]]);
    expect((await familiesFor(after, world.gray.auth)).RenameBefore).toMatchObject({ status: 'withheld', total_pnl: null });
    expect((await familiesFor(after, world.managerAuth)).RenameBefore.status).toBe('shown');
  });

  it('a name two clients hold, one of them hers, never counts as the other one\'s account', async () => {
    // The desk registered LS-A on a client nobody holds, with the lowest id
    // there is, so "pick one holder" would pick the outside one.
    const low = '00000000-0000-0000-0000-000000000001';
    await after.query("insert into public.clients (id, name, status, product_key) values ($1, 'Client LOW', 'Active', 'pk-low')", [low]);
    await after.query("insert into public.trading_accounts (client_id, account_name) values ($1, 'ls-a')", [low]);
    await managerImports('Shared', [['LS-A', 5], ['B2-A', 1], ['B3-A', 1], ['A1-A', 1], ['X1-A', 1]]);
    expect((await familiesFor(after, world.gray.auth)).Shared.status).toBe('withheld');
    // The same four outside accounts with a fifth that is plainly outside are shown.
    await managerImports('Shared', [['U1-A', 1]]);
    expect((await familiesFor(after, world.gray.auth)).Shared.status).toBe('shown');
  });

  it('a family with enough accounts of other books is still shown after all of it', async () => {
    expect((await familiesFor(after, world.gray.auth)).OGX.status).toBe('shown');
  });
});

/* ── The owner of a row is fixed when it is written ───────────────────────── */

describe('after step 59: who owns a row is the database\'s answer, made once', () => {
  const ownerOf = async (account, family) => one(after,
    'select attributed_client_id from public.log_algo_history where account_name = $1 and family = $2', [account, family]);

  it('a payload naming another owner is ignored, on insert and on update', async () => {
    await committedAsRole(after, 'authenticated', world.managerAuth,
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips, attributed_client_id)
       values ('2026-10-04', 'LS-B', 'Payload', 'Long', 1, 1, $1)`, [world.clients.B2]);
    expect(await ownerOf('LS-B', 'Payload')).toBe(world.clients.LS);
    await committedAsRole(after, 'authenticated', world.managerAuth,
      "update public.log_algo_history set attributed_client_id = $1 where account_name = 'LS-B' and family = 'Payload'",
      [world.clients.B2]);
    expect(await ownerOf('LS-B', 'Payload')).toBe(world.clients.LS);
  });

  it('matches the registry the way the import does, ignoring case', async () => {
    await committedAsRole(after, 'authenticated', world.managerAuth,
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
       values ('2026-10-04', 'ls-c', 'Payload', 'Long', 1, 1)`);
    expect(await ownerOf('ls-c', 'Payload')).toBe(world.clients.LS);
  });

  it('a re-import after she renamed her accounts keeps the owner the first import found', async () => {
    // LR's accounts were renamed by Gray in the attack above; the log still
    // carries the old names, and the Manager uploads the same day again.
    await committedAsRole(after, 'authenticated', world.managerAuth,
      `insert into public.log_algo_history (log_date, account_name, family, direction, realized_pnl, round_trips)
       values ('2026-10-04', 'LR-A', 'RenameAfter', 'Long', 11, 1)
       on conflict (log_date, account_name, family) do update set realized_pnl = excluded.realized_pnl`);
    expect(await ownerOf('LR-A', 'RenameAfter')).toBe(world.clients.LR);
    expect((await familiesFor(after, world.gray.auth)).RenameAfter.status).toBe('withheld');
  });
});

/* ── The rows already there when the file runs ────────────────────────────── */

describe('step 59 on a database that already holds history', () => {
  it('attributes every existing row by the registry of that moment, and a re-run moves none', async () => {
    // The cluster stopped at 58, its rows written with no owner, then this file.
    await applyFileCollectingNotices(before, 'step_59_log_algo_history_by_family.sql');
    const mismatched = `select count(*)::int as n from public.log_algo_history h
      left join public.trading_accounts t on lower(t.account_name) = lower(h.account_name)
      where h.attributed_client_id is distinct from t.client_id`;
    expect(await one(before, mismatched)).toBe(0);
    expect(await one(before, 'select count(*)::int from public.log_algo_history where attributed_client_id is not null'))
      .toBeGreaterThan(20);
    expect((await familiesFor(before, world.before.gray.auth)).OGX.status).toBe('shown');
    expect((await familiesFor(before, world.before.gray.auth)).Thin.status).toBe('withheld');

    // Gray renames her account, the file runs again: G1-A keeps its owner.
    await committedAsRole(before, 'authenticated', world.before.gray.auth,
      "update public.trading_accounts set account_name = 'moved' where account_name = 'G1-A'");
    await applyFileCollectingNotices(before, 'step_59_log_algo_history_by_family.sql');
    expect(await one(before,
      "select count(distinct attributed_client_id)::int from public.log_algo_history where account_name = 'G1-A'")).toBe(1);
    expect(await one(before,
      "select bool_and(attributed_client_id = $1) from public.log_algo_history where account_name = 'G1-A'",
      [world.before.clients.G1])).toBe(true);
  }, 60_000);
});

/* ── It stays closed when earlier files are run again ─────────────────────── */

describe('step 59 survives a re-run of the files that wrote the old policy', () => {
  it('re-running 43, 52 and 56 on top leaves a CAM reading no row', async () => {
    const db = await startMigrationCluster(migrationFilesInOrder(), {
      reapply: [
        'step_43_row_level_security.sql',
        'step_52_rls_by_cam.sql',
        'step_56_table_privilege_lockdown.sql',
      ],
    });
    try {
      const w = await seed(db);
      await seedHistory(db);
      const [{ n }] = await rowsAsRole(db, 'authenticated',
        'select count(*)::int as n from public.log_algo_history', { subject: w.gray.auth });
      expect(n).toBe(0);
      expect((await familiesFor(db, w.gray.auth)).Thin.status).toBe('withheld');
    } finally {
      await db.close();
    }
  }, 120_000);
});

/* ── What the file says, read only where a behaviour cannot say it ────────── */

describe('the statements', () => {
  it('the function is a pinned security definer, and nobody but authenticated may call it', () => {
    const body = /create or replace function public\.log_algo_history_by_family\(\)[\s\S]*?\$function\$/i.exec(sql);
    expect(body).toBeTruthy();
    expect(body[0].toLowerCase()).toContain('security definer');
    expect(body[0].toLowerCase()).toContain('set search_path = pg_catalog, public');
    expect(flat).toContain('revoke all on function public.log_algo_history_by_family() from public, anon, authenticated');
    expect(flat).toContain('grant execute on function public.log_algo_history_by_family() to authenticated');
  });

  it('deletes no row, drops no table, and its one update fills the new column', () => {
    // String literals out first: the settings table's comment carries an
    // example `update ... set` for Pedro, which is text and not a statement.
    const statements = flat.replace(/'(?:[^']|'')*'/g, "''");
    expect(statements).not.toMatch(/\bdrop table\b|\bdelete from\b|\btruncate\b/);
    const updates = statements.match(/\bupdate public\.[^;]*;/g) || [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/^update public\.log_algo_history as h set attributed_client_id = .* where h\.attributed_client_id is null/);
  });
});
