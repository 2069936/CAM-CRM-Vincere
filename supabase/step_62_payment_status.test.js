/* STEP 62, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 61, clients are seeded with the
 * subscription_price values production holds (and the two shapes it should
 * not: null and a word nobody can price), and then step 62 runs the way Pedro
 * runs it. Every verdict is read back AS THE ROLE that reads it in the app:
 * `authenticated` with a real request.jwt.claim.sub, so row level security
 * decides what comes back exactly as it does for the CAM in the browser.
 *
 * Nothing here asserts the text of the SQL. A test that passed because the file
 * mentions "grant select, insert, update" would pass with the GRANT commented
 * out.
 */

import { readFileSync, readdirSync } from 'node:fs';
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

const STEP = 'step_62_payment_status.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

let db;
const world = { clients: {} };

/* Gray's clients, by name. `want` is the status the CAM must read after 62. */
const GRAY_CLIENTS = [
  { name: 'Pays 500', price: '$500', want: 'paying' },
  // The shape the fixed option list never allowed and the sheet holds anyway.
  { name: 'Pays 400', price: '$400', want: 'paying' },
  { name: 'Free one', price: 'Free', want: 'free' },
  { name: 'Unset', price: 'Undetermined', want: 'undetermined' },
  // Step 21 set a default, but a row written around it can still hold null.
  { name: 'Nulled', price: null, want: 'undetermined' },
  // A word nobody can price stays undetermined rather than becoming paying.
  { name: 'Odd', price: 'premium', want: 'undetermined' },
];

/** Runs one statement as `role` with `subject` signed in and KEEPS its effect. */
async function committed(subject, statement, params, role = 'authenticated') {
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

async function grayReads() {
  const rows = await rowsAsRole(db, 'authenticated',
    'select name, payment_status, subscription_price from public.clients order by name',
    { subject: world.gray.auth });
  return Object.fromEntries(rows.map((row) => [row.name, { status: row.payment_status, price: row.subscription_price }]));
}

async function everyRow() {
  return (await db.query('select id, name, payment_status, subscription_price from public.clients order by name')).rows;
}

async function columnExists() {
  return one(db, `select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'clients' and column_name = 'payment_status')`);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 61 }));

  async function authUser(email) {
    return one(db, 'insert into auth.users (email) values ($1) returning id', [email]);
  }
  async function cam(name) {
    const profile = await one(db, 'insert into public.cam_profiles (name) values ($1) returning id', [name]);
    const auth = await authUser(`${name.toLowerCase()}@example.com`);
    await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id, cam_profile_id)
      values ($1, $1, $2, 'CAM', 'Active', $3, $4)`, [name.toLowerCase(), `${name.toLowerCase()}@example.com`, auth, profile]);
    return { profile, auth };
  }
  async function clientOf(owner, name, price) {
    const id = await one(db, 'insert into public.clients (name, subscription_price) values ($1, $2) returning id', [name, price]);
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [id, owner.profile]);
    world.clients[name] = id;
    return id;
  }

  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [world.managerAuth]);

  for (const row of GRAY_CLIENTS) await clientOf(world.gray, row.name, row.price);
  await clientOf(world.birch, 'Birch client', '$250');

  world.columnBefore = await columnExists();
  world.notices = await applyFileCollectingNotices(db, STEP);
}, 120_000);

afterAll(async () => { await db?.close?.(); });

describe('before step 62', () => {
  it('clients has no payment_status column', () => {
    expect(world.columnBefore).toBe(false);
  });
});

describe('step 62 files every client from the price it already had', () => {
  it('the CAM reads each of her clients as the step says it should', async () => {
    const after = await grayReads();
    for (const row of GRAY_CLIENTS) {
      expect({ name: row.name, status: after[row.name].status }).toEqual({ name: row.name, status: row.want });
    }
  });

  it('leaves subscription_price exactly as it was', async () => {
    const after = await grayReads();
    for (const row of GRAY_CLIENTS) {
      expect({ name: row.name, price: after[row.name].price }).toEqual({ name: row.name, price: row.price });
    }
  });

  it('is desk wide: another CAM\'s client is filed too, the Manager reads it, Gray does not', async () => {
    const manager = await rowsAsRole(db, 'authenticated',
      "select payment_status from public.clients where name = 'Birch client'",
      { subject: world.managerAuth });
    expect(manager).toEqual([{ payment_status: 'paying' }]);
    const gray = await rowsAsRole(db, 'authenticated',
      "select 1 from public.clients where name = 'Birch client'",
      { subject: world.gray.auth });
    expect(gray).toHaveLength(0);
  });

  it('says how many it filed: the three priced rows of Gray\'s plus Birch\'s', () => {
    expect(world.notices.filter((n) => n.startsWith('step 62:'))).toEqual([
      'step 62: filed 4 client(s) from subscription_price',
    ]);
  });

  it('a new client starts undetermined without anybody saying so', async () => {
    const [row] = await committed(world.gray.auth,
      "insert into public.clients (name) values ('Newcomer') returning payment_status", []);
    expect(row.payment_status).toBe('undetermined');
    await db.query("delete from public.clients where name = 'Newcomer'");
  });
});

describe('running it again is a no-op', () => {
  it('files nothing and moves nothing, including a status a CAM has since changed', async () => {
    // A CAM paused a paying client but the old price column still says $500,
    // the way a row edited before the app learned the rule would. A re-run
    // must not put them back to paying.
    await committed(world.gray.auth,
      "update public.clients set payment_status = 'paused' where name = 'Pays 500'", []);
    const first = await everyRow();
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((n) => n.startsWith('step 62:'))).toEqual([
      'step 62: filed 0 client(s) from subscription_price',
    ]);
    expect(await everyRow()).toEqual(first);
    expect((await grayReads())['Pays 500']).toEqual({ status: 'paused', price: '$500' });
    await committed(world.gray.auth,
      "update public.clients set payment_status = 'paying' where name = 'Pays 500'", []);
  });
});

describe('what the browser can do with the two columns', () => {
  it('a CAM updates the status and the amount of her own client, and reads it back', async () => {
    const rows = await committed(world.gray.auth,
      `update public.clients set payment_status = 'paying', subscription_price = '$375'
        where id = $1 returning payment_status, subscription_price`, [world.clients['Pays 400']]);
    expect(rows).toEqual([{ payment_status: 'paying', subscription_price: '$375' }]);
    expect((await grayReads())['Pays 400']).toEqual({ status: 'paying', price: '$375' });
  });

  it('a CAM cannot touch another CAM\'s client: the update reaches no row', async () => {
    const rows = await committed(world.gray.auth,
      `update public.clients set payment_status = 'cancelled', subscription_price = 'Undetermined'
        where id = $1 returning id`, [world.clients['Birch client']]);
    expect(rows).toHaveLength(0);
    const birch = await rowsAsRole(db, 'authenticated',
      'select payment_status, subscription_price from public.clients where id = $1',
      { subject: world.birch.auth, params: [world.clients['Birch client']] });
    expect(birch).toEqual([{ payment_status: 'paying', subscription_price: '$250' }]);
  });

  it('a Manager files any client', async () => {
    const rows = await committed(world.managerAuth,
      "update public.clients set payment_status = 'idle', subscription_price = 'Undetermined' where id = $1 returning payment_status",
      [world.clients['Birch client']]);
    expect(rows).toEqual([{ payment_status: 'idle' }]);
    await committed(world.managerAuth,
      "update public.clients set payment_status = 'paying', subscription_price = '$250' where id = $1",
      [world.clients['Birch client']]);
  });

  it('refuses a status that is not one of the six', async () => {
    const error = await refusalAsRole(db, 'authenticated',
      "update public.clients set payment_status = 'whatever' where id = $1",
      { subject: world.gray.auth, params: [world.clients['Pays 500']] });
    expect(error).toMatch(/clients_payment_status_check/);
  });

  it('anon can do nothing with clients', async () => {
    for (const statement of [
      'select payment_status from public.clients',
      "update public.clients set payment_status = 'paying'",
      "insert into public.clients (name) values ('x')",
    ]) {
      expect(await refusalAsRole(db, 'anon', statement, { subject: null })).toMatch(/permission denied for table clients/);
    }
  });

  it('authenticated holds exactly select, insert and update, and cannot TRUNCATE', async () => {
    expect((await privilegesOn(db, 'authenticated', 'clients')).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'anon', 'clients')).toEqual([]);
    expect(await refusalAsRole(db, 'authenticated', 'truncate table public.clients', { subject: world.gray.auth }))
      .toMatch(/permission denied/);
    expect(await one(db, "select relrowsecurity from pg_class where oid = 'public.clients'::regclass")).toBe(true);
  });

  it('the grants are this file\'s own: they survive step 56 being run again on top', async () => {
    await applyFileCollectingNotices(db, 'step_56_table_privilege_lockdown.sql');
    expect((await privilegesOn(db, 'authenticated', 'clients')).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    await applyFileCollectingNotices(db, STEP);
    expect((await privilegesOn(db, 'authenticated', 'clients')).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'anon', 'clients')).toEqual([]);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 62 is numbered once, after 61', () => {
  it('appears once, and 54 is still a deliberate gap', () => {
    // Step 63's test now holds the "highest number" assertion; this one only
    // says 62 is here once and that nothing reused 54.
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 62)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(62);
    expect(numbers).not.toContain(54);
    for (const merged of [58, 59, 60, 61]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 61, and in the run order after 61', () => {
    expect(runbook).toMatch(/^\| 62 \| `step_62_payment_status\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 62 | `step_62_payment_status.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 61 | `step_61_target_profit_amount_to_balance.sql`'));
    expect(runbook).toMatch(/→ 60 → 61 → 62( →|\.)/);
  });
});
