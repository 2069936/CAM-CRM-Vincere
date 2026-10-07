/* STEP 61, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 57, the rows are seeded in the
 * shapes production holds (counted read only on 2026-10-06, see the step's
 * header), and then step 61 runs the way Pedro runs it. Every verdict is read
 * back AS THE ROLE that reads it in the app: `authenticated` with a real
 * request.jwt.claim.sub, so row level security decides what comes back exactly
 * as it does for the CAM in the browser.
 *
 * Nothing here asserts the text of the SQL. A test that passed because the file
 * mentions "start_balance / 5" would pass with the UPDATE commented out.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFileCollectingNotices,
  migrationFilesInOrder,
  one,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const STEP = 'step_61_target_profit_amount_to_balance.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

let db;
const world = {};

/* The accounts, by name. `want` is what the CAM must read after step 61. */
const GRAY_ACCOUNTS = [
  // The production Bullet Bot row: an amount beyond doubt.
  { name: 'BB-AMOUNT', type: 'Evaluation - Bullet Bot', start: 50000, target: 3000, want: 53000 },
  // The production Funded row above its start: already a balance.
  { name: 'FUND-SMALL', type: 'Funded', start: 6000, target: 8000, want: 8000 },
  // The six production Funded rows with no start: unreadable, left for the app.
  { name: 'FUND-NOSTART', type: 'Funded', start: null, target: 4000, want: 4000 },
  // An ordinary balance target, the shape of most of the 726.
  { name: 'FUND-OK', type: 'Funded', start: 50000, target: 54100, want: 54100 },
  // A balance typed below the start: wrong, but a balance, not an amount.
  { name: 'EVAL-TYPO', type: 'Evaluation - Standard', start: 50000, target: 45000, want: 45000 },
  // Just past a fifth of the start: not converted.
  { name: 'PAST-FIFTH', type: 'Funded', start: 50000, target: 10001, want: 10001 },
  // Exactly a fifth: converted.
  { name: 'AT-FIFTH', type: 'Funded', start: 50000, target: 10000, want: 60000 },
  // Nothing stored.
  { name: 'NO-TARGET', type: 'Funded', start: 50000, target: null, want: null },
];

const num = (value) => (value == null ? null : Number(value));

async function grayReads() {
  const rows = await rowsAsRole(db, 'authenticated',
    `select account_name, target_profit, target_profit_before_step_61
       from public.trading_accounts order by account_name`,
    { subject: world.gray.auth });
  return Object.fromEntries(rows.map((row) => [row.account_name, {
    target: num(row.target_profit),
    before: num(row.target_profit_before_step_61),
  }]));
}

async function managerReads(accountName) {
  const rows = await rowsAsRole(db, 'authenticated',
    'select target_profit, target_profit_before_step_61 from public.trading_accounts where account_name = $1',
    { subject: world.managerAuth, params: [accountName] });
  return rows.map((row) => ({ target: num(row.target_profit), before: num(row.target_profit_before_step_61) }));
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 57 }));

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
  async function clientOf(owner, name) {
    const id = await one(db, 'insert into public.clients (name) values ($1) returning id', [name]);
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [id, owner.profile]);
    return id;
  }
  async function account(clientId, { name, type, start, target }) {
    await db.query(`insert into public.trading_accounts (client_id, account_name, account_type, start_balance, target_profit)
      values ($1, $2, $3, $4, $5)`, [clientId, name, type, start, target]);
  }

  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [world.managerAuth]);

  world.grayClient = await clientOf(world.gray, 'Client G');
  for (const row of GRAY_ACCOUNTS) await account(world.grayClient, row);
  world.birchClient = await clientOf(world.birch, 'Client B');
  await account(world.birchClient, { name: 'BIRCH-AMOUNT', type: 'Evaluation - Bullet Bot', start: 50000, target: 3000 });

  // The premise, read by the CAM BEFORE the step: the amount is what she sees.
  world.before = Object.fromEntries((await rowsAsRole(db, 'authenticated',
    'select account_name, target_profit from public.trading_accounts',
    { subject: world.gray.auth })).map((row) => [row.account_name, { target: num(row.target_profit) }]));
  world.notices = await applyFileCollectingNotices(db, STEP);
}, 120_000);

afterAll(async () => { await db?.close?.(); });

describe('before step 61, the CAM reads the amount', () => {
  it('3,000 on a 50,000 start, which every reader calls passed', () => {
    expect(world.before['BB-AMOUNT'].target).toBe(3000);
  });
});

describe('step 61 converts only the amount beyond doubt', () => {
  it('the CAM reads each of her accounts as the step says it should', async () => {
    const after = await grayReads();
    for (const row of GRAY_ACCOUNTS) {
      expect({ name: row.name, target: after[row.name].target }).toEqual({ name: row.name, target: row.want });
    }
  });

  it('keeps the amount it replaced, and nothing on the rows it left alone', async () => {
    const after = await grayReads();
    for (const row of GRAY_ACCOUNTS) {
      const converted = row.want !== row.target;
      expect({ name: row.name, before: after[row.name].before })
        .toEqual({ name: row.name, before: converted ? row.target : null });
    }
  });

  it('is desk wide: another CAM\'s row is converted too, and the Manager reads it', async () => {
    expect(await managerReads('BIRCH-AMOUNT')).toEqual([{ target: 53000, before: 3000 }]);
    // And Gray still cannot see it: the new column opened no row to her.
    const gray = await rowsAsRole(db, 'authenticated',
      "select 1 from public.trading_accounts where account_name = 'BIRCH-AMOUNT'",
      { subject: world.gray.auth });
    expect(gray).toHaveLength(0);
  });

  it('says how many it converted', () => {
    expect(world.notices.filter((n) => n.startsWith('step 61:'))).toEqual([
      'step 61: converted 3 target(s) from a profit amount to a balance',
    ]);
  });
});

describe('running it again, undoing it, and writing after it', () => {
  it('a second run converts nothing and moves nothing', async () => {
    const first = await grayReads();
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((n) => n.startsWith('step 61:'))).toEqual([
      'step 61: converted 0 target(s) from a profit amount to a balance',
    ]);
    expect(await grayReads()).toEqual(first);
  });

  it('a CAM can still set her own target through the API role after the column exists', async () => {
    const refused = await refusalAsRole(db, 'authenticated',
      "update public.trading_accounts set target_profit = 54100 where account_name = 'FUND-NOSTART'",
      { subject: world.gray.auth });
    expect(refused).toBeNull();
  });

  it('the undo in the header puts back exactly what was there', async () => {
    const undo = /--\s+update public\.trading_accounts\n--\s+set target_profit = target_profit_before_step_61,\n--\s+target_profit_before_step_61 = null\n--\s+where target_profit_before_step_61 is not null;/
      .exec(readFileSync(new URL(STEP, import.meta.url), 'utf8'));
    expect(undo).not.toBeNull();
    await db.exec(undo[0].replace(/^--\s?/gm, ''));
    const back = await grayReads();
    for (const row of GRAY_ACCOUNTS) {
      expect({ name: row.name, target: back[row.name].target, before: back[row.name].before })
        .toEqual({ name: row.name, target: row.target, before: null });
    }
    // And the step, run once more, converts them again.
    await applyFileCollectingNotices(db, STEP);
    expect((await grayReads())['BB-AMOUNT']).toEqual({ target: 53000, before: 3000 });
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 61 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 61)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(61);
    // 58, 59 and 60 merged before this file; only 54 is still claimed by draft PR 65.
    expect(numbers).not.toContain(54);
    for (const merged of [58, 59, 60]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 60, and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 61 \| `step_61_target_profit_amount_to_balance\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 61 | `step_61_target_profit_amount_to_balance.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 60 | `step_60_client_handoff_manager_only.sql`'));
    expect(runbook).toMatch(/→ 59 → 60 → 61\./);
  });
});
