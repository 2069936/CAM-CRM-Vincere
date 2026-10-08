/* STEP 65, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 64, two fictional books are
 * seeded in the shapes production holds (an account seen every close, one that
 * skipped four closes and one that skipped five, one never seen, a model 1
 * account exactly at its limit and one just under, a model 2 account at -1 and
 * one whose reading is 0, a breach followed by a recovery, a cash and a
 * simulation account reading negative, a Reserve and an Inactive account that
 * breached, an orphan snapshot that names a registry account with other case
 * and whitespace, a Payout Hold account, an account with a date_failed already
 * on it, and a second client where five accounts breach at once), and then 65
 * runs the way Pedro runs it: once, with the backfill. After that every verdict
 * is the database's own, read back AS THE ROLE that reads it in the app where
 * the question is about who may read or write what.
 *
 * Nothing here asserts the text of the SQL. The breach rule, the absence rule,
 * the auto fail, the flag flood rule, the deferred trigger and the grants are
 * each proved by making the database do the thing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFileCollectingNotices,
  column,
  migrationFilesInOrder,
  one,
  privilegesOn,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const STEP = 'step_65_account_observations.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const DENIED = /permission denied/i;
const GUARDED = /written by the close \(refresh_account_observations\), not by the browser/;

const REFRESH = 'public.refresh_account_observations(uuid)';
const HELPERS = [
  'public.account_observation_reading(numeric)',
  'public.account_observation_breach(numeric, text, numeric)',
  'public.account_observations_trigger()',
  'public.trading_accounts_observed_columns_guard()',
];

/* Client A's seven closes before 65 runs, then the ones the triggers see. */
const DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];
const D8 = '2026-10-07';
const D9 = '2026-10-08';

let db;
const world = { accounts: {}, closes: {}, nw: {}, nwCloses: {} };

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

/** One account's observation, with the dates as text so the assertions read. */
async function observed(accountId) {
  return (await db.query(
    `select account_name, status, date_failed::text as date_failed, observed_state,
            last_close_seen_on::text as last_close_seen_on, closes_missed,
            breached_on::text as breached_on, breach_reading::text as breach_reading,
            observed_at is not null as observed
       from public.trading_accounts where id = $1`, [accountId])).rows[0];
}

async function flagsOf(clientId) {
  return (await db.query(
    `select type, severity, status, message, daily_import_id, trading_account_id
       from public.operational_flags where client_id = $1 order by created_at, message`, [clientId])).rows;
}

async function auditsOf(accountId) {
  return (await db.query(
    `select action, user_id, after_data from public.audit_logs
      where entity_type = 'trading_account' and entity_id = $1 order by created_at`, [accountId])).rows;
}

async function autoFailAudits() {
  return one(db, "select count(*)::int from public.audit_logs where action = 'trading_account.auto_failed'");
}

async function flagCount() {
  return one(db, "select count(*)::int from public.operational_flags where type = 'Marked Failed by the close'");
}

/** Every role holding EXECUTE on a function, straight from the ACL, owner left out. */
async function executeGrantees(signature) {
  const roles = await column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
  return roles.filter((role) => role !== 'postgres');
}

async function refreshDefinition() {
  return one(db, `select pg_get_functiondef('${REFRESH}'::regprocedure)`);
}

/** The rule, probed directly: the breach helper on one reading. */
async function breach(trailing, accountType, limit) {
  return one(db, 'select public.account_observation_breach($1::numeric, $2, $3::numeric)', [trailing, accountType, limit]);
}

async function refresh(clientId) {
  return one(db, 'select public.refresh_account_observations($1)', [clientId]);
}

async function snapshot(closeId, accountId, accountName, trailing) {
  await db.query(
    `insert into public.account_snapshots (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, account_balance)
     values ($1, $2, $3, $4, 50000)
     on conflict (daily_import_id, account_name) do update set
       trading_account_id = excluded.trading_account_id,
       trailing_max_drawdown = excluded.trailing_max_drawdown`,
    [closeId, accountId, accountName, trailing]);
}

async function accountsOfClientsWithCloses() {
  return one(db, `select count(*)::int from public.trading_accounts t
    where exists (select 1 from public.daily_imports d where d.client_id = t.client_id)`);
}

async function clientsWithCloses() {
  return one(db, 'select count(distinct client_id)::int from public.daily_imports');
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 64 }));

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
  async function account(clientId, name, { type = 'Evaluation - Standard', status = 'Active', limit = null, dateFailed = null, dateAdded = null } = {}) {
    return one(db,
      `insert into public.trading_accounts (client_id, account_name, account_type, status, max_drawdown_limit, date_failed, date_added)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clientId, name, type, status, limit, dateFailed, dateAdded]);
  }
  async function close(clientId, day) {
    return one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [clientId, day]);
  }

  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [world.managerAuth]);

  /* ── Client A: one account per shape the rule has to get right ───────── */
  world.clientA = await clientOf(world.gray, 'Client A');
  const A = world.accounts;
  A.seen = await account(world.clientA, 'ACC 01');
  A.absent4 = await account(world.clientA, 'ACC 02');
  A.absent5 = await account(world.clientA, 'ACC 03');
  A.never = await account(world.clientA, 'ACC 04', { type: 'Funded', dateAdded: '2026-01-10' });
  A.m1AtLimit = await account(world.clientA, 'ACC 05', { type: 'Funded', limit: 1500 });
  A.m1Under = await account(world.clientA, 'ACC 06', { type: 'Funded', limit: 1500 });
  A.m2Negative = await account(world.clientA, 'ACC 07', { type: 'Evaluation - Bullet Bot' });
  A.zeroLast = await account(world.clientA, 'ACC 08');
  A.zeroOnly = await account(world.clientA, 'ACC 09');
  A.recovered = await account(world.clientA, 'ACC 10');
  A.cash = await account(world.clientA, 'ACC 11', { type: 'Cash - IRA' });
  A.simulation = await account(world.clientA, 'ACC 12', { type: 'Simulation' });
  A.reserve = await account(world.clientA, 'ACC 13', { status: 'Reserve' });
  A.inactive = await account(world.clientA, 'ACC 14', { status: 'Inactive' });
  A.orphan = await account(world.clientA, 'ACC 15');
  A.payoutHold = await account(world.clientA, 'ACC 16', { status: 'Payout Hold' });
  A.dated = await account(world.clientA, 'ACC 17', { dateFailed: '2026-01-15' });
  A.offSetting = await account(world.clientA, 'ACC 18');
  A.upsert = await account(world.clientA, 'ACC 19');

  for (const day of DAYS) world.closes[day] = await close(world.clientA, day);
  const c = (day) => world.closes[day];
  for (const [index, day] of DAYS.entries()) {
    const last = index === DAYS.length - 1;
    await snapshot(c(day), A.seen, 'ACC 01', 2000);
    if (index <= 2) await snapshot(c(day), A.absent4, 'ACC 02', 1500);
    if (index <= 1) await snapshot(c(day), A.absent5, 'ACC 03', 1500);
    await snapshot(c(day), A.m1AtLimit, 'ACC 05', last ? -1500 : -800);
    await snapshot(c(day), A.m1Under, 'ACC 06', last ? -1499 : -800);
    await snapshot(c(day), A.m2Negative, 'ACC 07', last ? -1 : 858);
    await snapshot(c(day), A.zeroLast, 'ACC 08', last ? 0 : 500);
    await snapshot(c(day), A.zeroOnly, 'ACC 09', 0);
    await snapshot(c(day), A.recovered, 'ACC 10', index === 2 ? -263 : (index < 2 ? 300 : 400));
    await snapshot(c(day), A.cash, 'ACC 11', -500);
    await snapshot(c(day), A.simulation, 'ACC 12', -500);
    await snapshot(c(day), A.reserve, 'ACC 13', last ? -5 : 100);
    await snapshot(c(day), A.inactive, 'ACC 14', last ? -5 : 100);
    // No trading_account_id, other case, surrounding whitespace: the orphan
    // shape 41 rows on the book have, naming an account the registry holds.
    await snapshot(c(day), null, ' acc 15 ', 100);
    await snapshot(c(day), A.payoutHold, 'ACC 16', 100);
    await snapshot(c(day), A.dated, 'ACC 17', 100);
    await snapshot(c(day), A.offSetting, 'ACC 18', 100);
    await snapshot(c(day), A.upsert, 'ACC 19', 100);
  }

  /* ── Northwind: five breaches landing in one refresh ─────────────────── */
  world.northwind = await clientOf(world.birch, 'Northwind');
  for (const n of [1, 2, 3, 4, 5]) {
    world.nw[n] = await account(world.northwind, `NW 0${n}`, { type: 'Evaluation - Bullet Bot' });
  }
  world.nw.cash = await account(world.northwind, 'NW 06', { type: 'Cash' });
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-06']) world.nwCloses[day] = await close(world.northwind, day);
  for (const day of Object.keys(world.nwCloses)) {
    const id = world.nwCloses[day];
    for (const n of [1, 2, 3, 4, 5]) {
      // NW 01 breaches a close earlier than the other four, so the summary
      // flag has a range to print.
      const breached = day === '2026-10-06' || (n === 1 && day === '2026-10-02');
      await snapshot(id, world.nw[n], `NW 0${n}`, breached ? -10 : 200);
    }
    await snapshot(id, world.nw.cash, 'NW 06', -10);
  }

  /* ── Client C: registered, no close at all ───────────────────────────── */
  world.clientC = await clientOf(world.gray, 'Client C');
  world.accounts.noClose = await account(world.clientC, 'C 01');

  world.before = {
    columns: await column(db, `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'trading_accounts' and column_name like 'observed%'`),
    audits: await autoFailAudits(),
  };
  world.notices = await applyFileCollectingNotices(db, STEP);
  world.after = { definition: await refreshDefinition() };
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── Before and the backfill ─────────────────────────────────────────────── */

describe('before step 65', () => {
  it('trading_accounts had no observation columns and no account had ever been auto failed', () => {
    expect(world.before.columns).toEqual([]);
    expect(world.before.audits).toBe(0);
  });
});

describe('the backfill, once, over every client with a close', () => {
  it('says how many accounts and clients it refreshed: Client A and Northwind, not Client C', () => {
    expect(world.notices.filter((n) => n.startsWith('step 65:'))).toEqual([
      'step 65: refreshed 25 account(s) across 2 client(s)',
    ]);
  });

  it('an account in every close is seen, missed 0, with the latest close as its date', async () => {
    expect(await observed(world.accounts.seen)).toMatchObject({
      status: 'Active', observed_state: 'seen', last_close_seen_on: '2026-10-06', closes_missed: 0,
      breached_on: null, breach_reading: null, observed: true,
    });
  });

  it('four closes missed is still seen, five is absent, and neither touches the status', async () => {
    expect(await observed(world.accounts.absent4)).toMatchObject({
      status: 'Active', observed_state: 'seen', last_close_seen_on: '2026-09-30', closes_missed: 4,
    });
    expect(await observed(world.accounts.absent5)).toMatchObject({
      status: 'Active', observed_state: 'absent', last_close_seen_on: '2026-09-29', closes_missed: 5,
    });
  });

  it('never seen: no date, closes_missed is the client close count, status untouched', async () => {
    expect(await observed(world.accounts.never)).toMatchObject({
      status: 'Active', observed_state: 'never_seen', last_close_seen_on: null, closes_missed: 7, date_failed: null,
    });
  });

  it('a client with no close leaves its account never_seen, 0 missed and not yet observed', async () => {
    expect(await observed(world.accounts.noClose)).toMatchObject({
      observed_state: 'never_seen', closes_missed: 0, last_close_seen_on: null, observed: false,
    });
  });

  it('model 1 at the limit is breached and marked Failed with the breach date; just under is seen', async () => {
    expect(await observed(world.accounts.m1AtLimit)).toMatchObject({
      status: 'Failed', date_failed: '2026-10-06', observed_state: 'breached',
      breached_on: '2026-10-06', breach_reading: '-1500', closes_missed: 0,
    });
    expect(await observed(world.accounts.m1Under)).toMatchObject({
      status: 'Active', date_failed: null, observed_state: 'seen', breached_on: null, breach_reading: null,
    });
  });

  it('model 2 at -1 is breached and marked Failed; a 0 reading is unmeasured, so the last measured 500 decides', async () => {
    expect(await observed(world.accounts.m2Negative)).toMatchObject({
      status: 'Failed', date_failed: '2026-10-06', observed_state: 'breached', breached_on: '2026-10-06', breach_reading: '-1',
    });
    expect(await observed(world.accounts.zeroLast)).toMatchObject({
      status: 'Active', observed_state: 'seen', breached_on: null, last_close_seen_on: '2026-10-06',
    });
    expect(await observed(world.accounts.zeroOnly)).toMatchObject({
      status: 'Active', observed_state: 'seen', breached_on: null, breach_reading: null,
    });
  });

  it('a breach followed by a healthy reading is cleared: seen, no breach date, still Active', async () => {
    expect(await observed(world.accounts.recovered)).toMatchObject({
      status: 'Active', date_failed: null, observed_state: 'seen', breached_on: null, breach_reading: null,
    });
  });

  it('cash and simulation never breach, even reading negative on every close', async () => {
    for (const key of ['cash', 'simulation']) {
      expect(await observed(world.accounts[key])).toMatchObject({
        status: 'Active', observed_state: 'seen', breached_on: null, breach_reading: null, date_failed: null,
      });
    }
  });

  it('a Reserve and an Inactive account that breached are observed as breached and left alone', async () => {
    expect(await observed(world.accounts.reserve)).toMatchObject({
      status: 'Reserve', observed_state: 'breached', breached_on: '2026-10-06', date_failed: null,
    });
    expect(await observed(world.accounts.inactive)).toMatchObject({
      status: 'Inactive', observed_state: 'breached', breached_on: '2026-10-06', date_failed: null,
    });
    expect(await auditsOf(world.accounts.reserve)).toEqual([]);
    expect(await auditsOf(world.accounts.inactive)).toEqual([]);
  });

  it('an orphan snapshot naming the account in other case and whitespace counts as seen', async () => {
    expect(await observed(world.accounts.orphan)).toMatchObject({
      observed_state: 'seen', last_close_seen_on: '2026-10-06', closes_missed: 0,
    });
  });
});

describe('the auto fail, as the backfill fired it on Client A', () => {
  it('wrote one audit row per account, by the machine, naming the client, the account, the date, the reading and the previous status', async () => {
    const rows = await auditsOf(world.accounts.m1AtLimit);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('trading_account.auto_failed');
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].after_data).toEqual({
      clientId: world.clientA, accountName: 'ACC 05', breachedOn: '2026-10-06', reading: -1500, previousStatus: 'Active',
    });
    expect((await auditsOf(world.accounts.m2Negative))[0].after_data).toMatchObject({
      accountName: 'ACC 07', reading: -1, previousStatus: 'Active',
    });
  });

  it('two accounts flipped, so each got its own flag, on the close that breached, with the reading and the old status', async () => {
    const flags = await flagsOf(world.clientA);
    expect(flags).toHaveLength(2);
    for (const flag of flags) {
      expect(flag).toMatchObject({ type: 'Marked Failed by the close', severity: 'Warning', status: 'Open', daily_import_id: world.closes['2026-10-06'] });
      expect(flag.message).toContain('Change the status on the account if the prop firm says otherwise.');
    }
    const m1 = flags.find((flag) => flag.trading_account_id === world.accounts.m1AtLimit);
    expect(m1.message).toBe('ACC 05 breached on 2026-10-06: trailing reading -$1,500 against a $1,500 limit, status was Active. Change the status on the account if the prop firm says otherwise.');
    const m2 = flags.find((flag) => flag.trading_account_id === world.accounts.m2Negative);
    expect(m2.message).toBe('ACC 07 breached on 2026-10-06: trailing reading -$1, status was Active. Change the status on the account if the prop firm says otherwise.');
  });

  it('no flag text and no audit text carries a dash as punctuation', async () => {
    const texts = [
      ...(await flagsOf(world.clientA)).map((flag) => `${flag.type} ${flag.message}`),
      ...(await flagsOf(world.northwind)).map((flag) => `${flag.type} ${flag.message}`),
      ...(await column(db, "select action from public.audit_logs where action like 'trading_account.%'")),
    ];
    for (const text of texts) {
      // A minus sign in front of a dollar figure is a number, not punctuation.
      expect(text.replace(/-\$/g, '$')).not.toMatch(/[—–]| - /);
    }
  });
});

describe('the flood rule, as the backfill fired it on Northwind', () => {
  it('five accounts flipped at once: five audit rows, five Failed, one flag naming them all on the latest close', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(await observed(world.nw[n])).toMatchObject({ status: 'Failed', observed_state: 'breached' });
      expect(await auditsOf(world.nw[n])).toHaveLength(1);
    }
    const flags = await flagsOf(world.northwind);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      type: 'Marked Failed by the close', severity: 'Warning', status: 'Open',
      daily_import_id: world.nwCloses['2026-10-06'], trading_account_id: null,
    });
    expect(flags[0].message).toBe('The close marked 5 accounts Failed: NW 01, NW 02, NW 03, NW 04, NW 05. They breached between 2026-10-02 and 2026-10-06. Change the status on an account if the prop firm says otherwise.');
  });

  it('the one that breached earlier carries its own first breach date, and the cash account was not touched', async () => {
    expect(await observed(world.nw[1])).toMatchObject({ breached_on: '2026-10-02', date_failed: '2026-10-02' });
    expect(await observed(world.nw[2])).toMatchObject({ breached_on: '2026-10-06', date_failed: '2026-10-06' });
    expect(await observed(world.nw.cash)).toMatchObject({ status: 'Active', observed_state: 'seen', breached_on: null });
  });

  it('the boundary, when a close lands it: exactly three flipped get a flag each, exactly four get the one flag naming them', async () => {
    // A third fictional book, registered after 65 ran, so every verdict here is
    // the trigger's and not the backfill's. Each close lands the way the
    // browser lands one: the daily_imports row and its snapshots in one
    // transaction, the refresh once at commit.
    world.clientE = await one(db, "insert into public.clients (name) values ('Client E') returning id");
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [world.clientE, world.birch.profile]);
    const E = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      E[n] = await one(db,
        "insert into public.trading_accounts (client_id, account_name, account_type, status) values ($1, $2, 'Evaluation - Bullet Bot', 'Active') returning id",
        [world.clientE, `E 0${n}`]);
    }
    const audits = await autoFailAudits();

    await db.exec('begin');
    const first = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientE, '2026-10-05']);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await snapshot(first, E[n], `E 0${n}`, n <= 3 ? -10 : 200);
    await db.exec('commit');

    for (const n of [1, 2, 3]) {
      expect(await observed(E[n])).toMatchObject({ status: 'Failed', observed_state: 'breached', breached_on: '2026-10-05' });
      expect(await auditsOf(E[n])).toHaveLength(1);
    }
    for (const n of [4, 5, 6, 7]) expect(await observed(E[n])).toMatchObject({ status: 'Active', observed_state: 'seen' });
    expect(await autoFailAudits()).toBe(audits + 3);
    const each = await flagsOf(world.clientE);
    expect(each).toHaveLength(3);
    expect(each.map((flag) => flag.trading_account_id).sort()).toEqual([E[1], E[2], E[3]].sort());
    for (const flag of each) expect(flag).toMatchObject({ type: 'Marked Failed by the close', severity: 'Warning', status: 'Open', daily_import_id: first });
    expect(each.find((flag) => flag.trading_account_id === E[3]).message)
      .toBe('E 03 breached on 2026-10-05: trailing reading -$10, status was Active. Change the status on the account if the prop firm says otherwise.');

    await db.exec('begin');
    const second = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientE, '2026-10-06']);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await snapshot(second, E[n], `E 0${n}`, -10);
    await db.exec('commit');

    for (const n of [4, 5, 6, 7]) {
      expect(await observed(E[n])).toMatchObject({ status: 'Failed', observed_state: 'breached', breached_on: '2026-10-06' });
      expect(await auditsOf(E[n])).toHaveLength(1);
    }
    // The three that breached on the first close stayed breached: no second transition, no second audit row.
    for (const n of [1, 2, 3]) expect(await auditsOf(E[n])).toHaveLength(1);
    expect(await autoFailAudits()).toBe(audits + 7);
    const flags = await flagsOf(world.clientE);
    expect(flags).toHaveLength(4);
    const summary = flags.filter((flag) => flag.daily_import_id === second);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ type: 'Marked Failed by the close', severity: 'Warning', status: 'Open', trading_account_id: null });
    expect(summary[0].message).toBe('The close marked 4 accounts Failed: E 04, E 05, E 06, E 07. They breached on 2026-10-06. Change the status on an account if the prop firm says otherwise.');
    const ids = await column(db, 'select distinct auto_fail_flag_id from public.trading_accounts where id in ($1, $2, $3, $4)', [E[4], E[5], E[6], E[7]]);
    expect(ids).toHaveLength(1);
  });
});

/* ── The rule at its edges ───────────────────────────────────────────────── */

describe('the breach rule, probed one reading at a time', () => {
  it('0, null, NaN and infinity are not measurements: null, never false', async () => {
    for (const unmeasured of [0, null, 'NaN', 'Infinity', '-Infinity']) {
      expect(await breach(unmeasured, 'Evaluation - Standard', null), String(unmeasured)).toBeNull();
      expect(await breach(unmeasured, 'Funded', 1500), String(unmeasured)).toBeNull();
    }
  });

  it('model 2: strictly negative breaches, positive does not', async () => {
    expect(await breach(-1, 'Evaluation - Standard', null)).toBe(true);
    expect(await breach(-0.01, 'Evaluation - Bullet Bot', null)).toBe(true);
    expect(await breach(1, 'Evaluation - Standard', null)).toBe(false);
    expect(await breach(858, 'Funded', null)).toBe(false);
  });

  it('model 1: the configured limit decides, not the sign, and the limit itself is reached', async () => {
    expect(await breach(-1500, 'Funded', 1500)).toBe(true);
    expect(await breach(-1600, 'Funded', 1500)).toBe(true);
    expect(await breach(1500, 'Funded', 1500)).toBe(true);
    expect(await breach(-1499, 'Funded', 1500)).toBe(false);
    expect(await breach(-800, 'Funded', 1500)).toBe(false);
  });

  it('a limit of 0, or a negative one, is no limit: model 2 applies', async () => {
    expect(await breach(-800, 'Funded', 0)).toBe(true);
    expect(await breach(-800, 'Funded', -1500)).toBe(true);
    expect(await breach(800, 'Funded', 0)).toBe(false);
  });

  it('cash (all three spellings) and simulation never breach, with or without a limit', async () => {
    for (const type of ['Cash', 'Cash - IRA', 'Cash - Straight', 'Simulation', ' Simulation ']) {
      expect(await breach(-5000, type, null), type).toBeNull();
      expect(await breach(-5000, type, 1500), type).toBeNull();
    }
  });
});

describe('the absence threshold is the setting', () => {
  it('stale_closes 4 turns four missed closes into absent, and 5 turns it back; the status never moves', async () => {
    await db.exec('update public.account_observation_settings set stale_closes = 4 where id');
    await refresh(world.clientA);
    expect(await observed(world.accounts.absent4)).toMatchObject({ observed_state: 'absent', closes_missed: 4, status: 'Active' });
    await db.exec('update public.account_observation_settings set stale_closes = 5 where id');
    await refresh(world.clientA);
    expect(await observed(world.accounts.absent4)).toMatchObject({ observed_state: 'seen', closes_missed: 4, status: 'Active' });
  });

  it('the settings row is one, bounded, and the defaults are 5, true, 14', async () => {
    const { rows } = await db.query('select stale_closes, auto_fail_on_breach, new_account_days from public.account_observation_settings');
    expect(rows).toEqual([{ stale_closes: 5, auto_fail_on_breach: true, new_account_days: 14 }]);
    expect(await refusalAsRole(db, 'postgres', 'insert into public.account_observation_settings (id) values (false)'))
      .toMatch(/account_observation_settings_singleton/);
    expect(await refusalAsRole(db, 'postgres', 'update public.account_observation_settings set stale_closes = 0 where id'))
      .toMatch(/account_observation_settings_stale_check/);
    expect(await refusalAsRole(db, 'postgres', 'update public.account_observation_settings set stale_closes = 31 where id'))
      .toMatch(/account_observation_settings_stale_check/);
    expect(await refusalAsRole(db, 'postgres', 'update public.account_observation_settings set new_account_days = 91 where id'))
      .toMatch(/account_observation_settings_new_days_check/);
    expect(await refusalAsRole(db, 'postgres', 'update public.account_observation_settings set new_account_days = 0 where id'))
      .toBeNull();
  });
});

/* ── The triggers ────────────────────────────────────────────────────────── */

describe('a close landing refreshes the client, at commit', () => {
  it('inside the transaction nothing has moved; at commit every account of the client is recomputed', async () => {
    const auditsBefore = await autoFailAudits();
    await db.exec('begin');
    world.closes[D8] = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientA, D8]);
    await snapshot(world.closes[D8], world.accounts.seen, 'ACC 01', 1700);
    await snapshot(world.closes[D8], world.accounts.payoutHold, 'ACC 16', -5);
    await snapshot(world.closes[D8], world.accounts.dated, 'ACC 17', -5);
    await snapshot(world.closes[D8], world.accounts.offSetting, 'ACC 18', 100);
    await snapshot(world.closes[D8], world.accounts.upsert, 'ACC 19', 100);
    const mid = await observed(world.accounts.seen);
    const midHold = await observed(world.accounts.payoutHold);
    await db.exec('commit');
    expect(mid).toMatchObject({ last_close_seen_on: '2026-10-06' });
    expect(midHold).toMatchObject({ status: 'Payout Hold', observed_state: 'seen' });

    expect(await observed(world.accounts.seen)).toMatchObject({ observed_state: 'seen', last_close_seen_on: D8, closes_missed: 0 });
    // The fifth missed close: four was seen, five is absent.
    expect(await observed(world.accounts.absent4)).toMatchObject({ observed_state: 'absent', closes_missed: 5, status: 'Active' });
    expect(await observed(world.accounts.absent5)).toMatchObject({ observed_state: 'absent', closes_missed: 6 });
    expect(await observed(world.accounts.never)).toMatchObject({ observed_state: 'never_seen', closes_missed: 8 });
    expect(await autoFailAudits()).toBe(auditsBefore + 2);
  });

  it('a Payout Hold account that breached is marked Failed, and the audit says what it was', async () => {
    expect(await observed(world.accounts.payoutHold)).toMatchObject({
      status: 'Failed', date_failed: D8, observed_state: 'breached', breached_on: D8, breach_reading: '-5',
    });
    const rows = await auditsOf(world.accounts.payoutHold);
    expect(rows).toHaveLength(1);
    expect(rows[0].after_data).toMatchObject({ previousStatus: 'Payout Hold', breachedOn: D8, reading: -5 });
  });

  it('a date_failed already on the row is kept, the status still moves', async () => {
    expect(await observed(world.accounts.dated)).toMatchObject({
      status: 'Failed', date_failed: '2026-01-15', observed_state: 'breached', breached_on: D8,
    });
    expect(await auditsOf(world.accounts.dated)).toHaveLength(1);
  });

  it('two flipped in that refresh, so two more flags on the new close, and still one per account', async () => {
    const flags = (await flagsOf(world.clientA)).filter((flag) => flag.daily_import_id === world.closes[D8]);
    expect(flags).toHaveLength(2);
    expect(flags.map((flag) => flag.trading_account_id).sort()).toEqual([world.accounts.payoutHold, world.accounts.dated].sort());
    const hold = flags.find((flag) => flag.trading_account_id === world.accounts.payoutHold);
    expect(hold.message).toBe(`ACC 16 breached on ${D8}: trailing reading -$5, status was Payout Hold. Change the status on the account if the prop firm says otherwise.`);
  });

  it('a second import of the same date (the upsert path) refreshes too, and a breach landing that way fails the account', async () => {
    expect(await observed(world.accounts.upsert)).toMatchObject({ status: 'Active', observed_state: 'seen', last_close_seen_on: D8 });
    const flagsBefore = await flagCount();
    await snapshot(world.closes[D8], world.accounts.upsert, 'ACC 19', -1);
    expect(await observed(world.accounts.upsert)).toMatchObject({
      status: 'Failed', date_failed: D8, observed_state: 'breached', breached_on: D8, breach_reading: '-1',
    });
    expect(await auditsOf(world.accounts.upsert)).toHaveLength(1);
    expect(await flagCount()).toBe(flagsBefore + 1);
  });

  it('an orphan snapshot in upper case and padded, no trading_account_id, counts as seen: the snapshot side is lowered too', async () => {
    // The seed's orphan rows read ' acc 15 ' against the registry's 'ACC 15',
    // which proves the registry side is lowered; this one is the other way
    // round, on the close ACC 15 had missed until now.
    expect(await observed(world.accounts.orphan)).toMatchObject({ observed_state: 'seen', last_close_seen_on: '2026-10-06', closes_missed: 1 });
    await snapshot(world.closes[D8], null, ' ACC 15 ', 100);
    expect(await observed(world.accounts.orphan)).toMatchObject({ observed_state: 'seen', last_close_seen_on: D8, closes_missed: 0 });
  });

  it('a refresh that changes nothing fires nothing: the same audit and flag counts after calling it again', async () => {
    const audits = await autoFailAudits();
    const flags = await flagCount();
    const states = (await db.query('select id, status, observed_state, closes_missed, breached_on from public.trading_accounts where client_id = $1 order by id', [world.clientA])).rows;
    expect(await refresh(world.clientA)).toBe(19);
    expect(await autoFailAudits()).toBe(audits);
    expect(await flagCount()).toBe(flags);
    expect((await db.query('select id, status, observed_state, closes_missed, breached_on from public.trading_accounts where client_id = $1 order by id', [world.clientA])).rows).toEqual(states);
  });

  it('a close deleted recomputes the client: the account that breached only there goes back to seen, its status stays', async () => {
    // A Manager removing a wrong import is the one way a close leaves the book.
    const extra = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientA, '2026-10-09']);
    await snapshot(extra, world.accounts.seen, 'ACC 01', 1650);
    expect(await observed(world.accounts.seen)).toMatchObject({ last_close_seen_on: '2026-10-09' });
    await db.query('delete from public.daily_imports where id = $1', [extra]);
    expect(await observed(world.accounts.seen)).toMatchObject({ last_close_seen_on: D8, closes_missed: 0 });
  });

  it('a close with no snapshot behind it still refreshes the client: every account seen before missed one more, its date kept', async () => {
    // The daily_imports row alone, nothing in account_snapshots: only the
    // trigger on daily_imports itself can have queued this refresh.
    expect(await observed(world.accounts.seen)).toMatchObject({ last_close_seen_on: D8, closes_missed: 0 });
    expect(await observed(world.accounts.upsert)).toMatchObject({ last_close_seen_on: D8, closes_missed: 0 });
    const empty = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientA, '2026-10-09']);
    expect(await one(db, 'select count(*)::int from public.account_snapshots where daily_import_id = $1', [empty])).toBe(0);
    expect(await observed(world.accounts.seen)).toMatchObject({ observed_state: 'seen', last_close_seen_on: D8, closes_missed: 1 });
    expect(await observed(world.accounts.upsert)).toMatchObject({ observed_state: 'breached', last_close_seen_on: D8, closes_missed: 1 });
    expect(await observed(world.accounts.never)).toMatchObject({ observed_state: 'never_seen', closes_missed: 9 });
    // Taken off the book again, so the closes the rest of this file counts stay as they were.
    await db.query('delete from public.daily_imports where id = $1', [empty]);
    expect(await observed(world.accounts.seen)).toMatchObject({ last_close_seen_on: D8, closes_missed: 0 });
  });
});

describe('with auto_fail_on_breach off', () => {
  it('the observation is still written, the status is not, and nothing is audited or flagged', async () => {
    await db.exec('update public.account_observation_settings set auto_fail_on_breach = false where id');
    const audits = await autoFailAudits();
    const flags = await flagCount();
    world.closes[D9] = await one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clientA, D9]);
    await snapshot(world.closes[D9], world.accounts.seen, 'ACC 01', 1600);
    await snapshot(world.closes[D9], world.accounts.offSetting, 'ACC 18', -50);
    expect(await observed(world.accounts.offSetting)).toMatchObject({
      status: 'Active', date_failed: null, observed_state: 'breached', breached_on: D9, breach_reading: '-50',
    });
    expect(await autoFailAudits()).toBe(audits);
    expect(await flagCount()).toBe(flags);
  });

  it('turning it back on does not fail an account whose breach was already observed: the transition is what fires', async () => {
    await db.exec('update public.account_observation_settings set auto_fail_on_breach = true where id');
    const audits = await autoFailAudits();
    await refresh(world.clientA);
    expect(await observed(world.accounts.offSetting)).toMatchObject({ status: 'Active', observed_state: 'breached' });
    expect(await autoFailAudits()).toBe(audits);
  });
});

describe('the automatic ingest path, through the real persist RPC', () => {
  /* The hazard this file's header names: persist_auto_daily_import writes the
   * snapshots in a loop and THEN deletes every flag of the close before
   * inserting the payload's. A flag written at the snapshot statement would be
   * deleted by the same call. Proved here by calling the real function, the one
   * v3 and v2 delegate to, as its owner. */
  async function payload(status) {
    return {
      date: D8,
      status: 'Needs review',
      accounts: { 'D 01': { accountName: 'D 01', alias: 'D 01', accountType: 'Evaluation - Standard', status } },
      snapshots: [{ accountName: 'D 01', trailingMaxDrawdown: -20, accountBalance: 49000 }],
      flags: [{ type: 'Import review', severity: 'Warning', message: 'The payload flag.' }],
    };
  }
  async function persist(status) {
    const batch = await one(db,
      `insert into public.ingest_batches (capture_id, device_id, client_id, trading_date, captured_at, schema_version, storage_path, content_sha256, byte_count)
       values (gen_random_uuid(), $1, $2, $3, clock_timestamp(), 1, 'test/' || gen_random_uuid()::text, 'sha', 10) returning id`,
      [world.device, world.clientD, D8]);
    return one(db, 'select (public.persist_auto_daily_import($1, $2, $3::jsonb)).id', [world.clientD, batch, JSON.stringify(await payload(status))]);
  }

  it('a breach in the payload fails the account and the flag survives the RPC deleting the close flags', async () => {
    world.clientD = await one(db, "insert into public.clients (name) values ('Client D') returning id");
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [world.clientD, world.gray.profile]);
    world.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clientD]);
    world.accounts.rpc = await one(db,
      `insert into public.trading_accounts (client_id, account_name, account_type, status) values ($1, 'D 01', 'Evaluation - Standard', 'Active') returning id`,
      [world.clientD]);
    const closeId = await persist('Active');
    expect(await observed(world.accounts.rpc)).toMatchObject({
      status: 'Failed', date_failed: D8, observed_state: 'breached', breached_on: D8, breach_reading: '-20',
    });
    const flags = await flagsOf(world.clientD);
    expect(flags.map((flag) => flag.type).sort()).toEqual(['Import review', 'Marked Failed by the close']);
    expect(flags.find((flag) => flag.type === 'Marked Failed by the close')).toMatchObject({
      daily_import_id: closeId, trading_account_id: world.accounts.rpc,
    });
    expect(await auditsOf(world.accounts.rpc)).toHaveLength(1);
  });

  it('a second capture of the same day deletes the close flags and the refresh writes the auto fail flag again, once', async () => {
    // The real path: the registry is read fresh at ingest, so the payload
    // carries the Failed this file wrote. The RPC deletes every flag of the
    // close before writing the payload's; the deferred refresh runs after that
    // and finds the remembered flag id pointing at nothing.
    const before = (await flagsOf(world.clientD)).find((flag) => flag.type === 'Marked Failed by the close');
    const flagIdBefore = await one(db, 'select auto_fail_flag_id from public.trading_accounts where id = $1', [world.accounts.rpc]);
    expect(flagIdBefore).not.toBeNull();
    const audits = await autoFailAudits();
    await persist('Failed');
    const after = (await flagsOf(world.clientD)).filter((flag) => flag.type === 'Marked Failed by the close');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ trading_account_id: world.accounts.rpc, daily_import_id: before.daily_import_id, status: 'Open' });
    expect(after[0].message).toBe(before.message);
    expect(await one(db, 'select auto_fail_flag_id from public.trading_accounts where id = $1', [world.accounts.rpc])).not.toBe(flagIdBefore);
    expect(await autoFailAudits()).toBe(audits);
    expect(await observed(world.accounts.rpc)).toMatchObject({ status: 'Failed', observed_state: 'breached' });
  });

  it('a flag the CAM resolved is a row, so it is not written again', async () => {
    await committed(world.gray.auth,
      "update public.operational_flags set status = 'Resolved', resolved_at = now() where client_id = $1 and type = 'Marked Failed by the close'",
      [world.clientD]);
    await refresh(world.clientD);
    const flags = (await flagsOf(world.clientD)).filter((flag) => flag.type === 'Marked Failed by the close');
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe('Resolved');
  });

  it('a replay whose payload still says Active (the stale registry hazard) is accepted and NOT re-failed: it reads Active and breached', async () => {
    // A hand built payload that still says Active is the stale browser tab
    // shape, and the header says what happens: the status is the payload's, the
    // observation stays breached, nothing fires, and no flag is written for an
    // account that is not Failed.
    const audits = await autoFailAudits();
    await persist('Active');
    expect(await observed(world.accounts.rpc)).toMatchObject({ status: 'Active', observed_state: 'breached', breached_on: D8 });
    expect(await autoFailAudits()).toBe(audits);
    expect((await flagsOf(world.clientD)).filter((flag) => flag.type === 'Marked Failed by the close')).toHaveLength(0);
    await db.query("update public.trading_accounts set status = 'Failed' where id = $1", [world.accounts.rpc]);
  });

  it('the one flag naming several accounts is written again the same way when a re-import deletes it', async () => {
    const summary = (await flagsOf(world.northwind))[0];
    // What a re-import of that close does to its flags, in one statement.
    await db.query('delete from public.operational_flags where daily_import_id = $1', [summary.daily_import_id]);
    expect(await flagsOf(world.northwind)).toHaveLength(0);
    const audits = await autoFailAudits();
    await refresh(world.northwind);
    const flags = await flagsOf(world.northwind);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ trading_account_id: null, daily_import_id: world.nwCloses['2026-10-06'] });
    expect(flags[0].message).toBe(summary.message);
    expect(await autoFailAudits()).toBe(audits);
    const ids = await column(db, 'select distinct auto_fail_flag_id from public.trading_accounts where client_id = $1 and status = $2', [world.northwind, 'Failed']);
    expect(ids).toHaveLength(1);
  });
});

/* ── Who reads what, who writes what ─────────────────────────────────────── */

describe('reading the observation columns', () => {
  const COLUMNS = 'account_name, observed_state, closes_missed, breached_on::text as breached_on';

  it('a CAM reads them on her own clients and sees nothing of another CAM\'s', async () => {
    const gray = await rowsAsRole(db, 'authenticated',
      `select ${COLUMNS} from public.trading_accounts where client_id = $1 and account_name in ('ACC 03', 'ACC 05') order by 1`,
      { subject: world.gray.auth, params: [world.clientA] });
    expect(gray).toEqual([
      { account_name: 'ACC 03', observed_state: 'absent', closes_missed: 7, breached_on: null },
      { account_name: 'ACC 05', observed_state: 'breached', closes_missed: 2, breached_on: '2026-10-06' },
    ]);
    const birchOnA = await rowsAsRole(db, 'authenticated',
      'select 1 from public.trading_accounts where client_id = $1', { subject: world.birch.auth, params: [world.clientA] });
    expect(birchOnA).toHaveLength(0);
  });

  it('a Manager reads every client\'s', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      `select observed_state, count(*)::int as n from public.trading_accounts group by 1 order by 1`,
      { subject: world.managerAuth });
    expect(rows.map((row) => row.observed_state).sort()).toEqual(['absent', 'breached', 'never_seen', 'seen']);
    expect(rows.reduce((sum, row) => sum + row.n, 0)).toBe(await one(db, 'select count(*)::int from public.trading_accounts'));
  });

  it('a CAM reads the settings, anon does not', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select stale_closes, auto_fail_on_breach, new_account_days from public.account_observation_settings',
      { subject: world.gray.auth });
    expect(rows).toEqual([{ stale_closes: 5, auto_fail_on_breach: true, new_account_days: 14 }]);
    expect(await refusalAsRole(db, 'anon', 'select * from public.account_observation_settings')).toMatch(DENIED);
  });
});

describe('the browser cannot write the observation columns', () => {
  it('a CAM updating observed_state, or any of the six, on her own account is refused, and nothing moved', async () => {
    const before = await observed(world.accounts.seen);
    for (const set of [
      "observed_state = 'breached'",
      "last_close_seen_on = '2026-01-01'",
      'closes_missed = 99',
      "breached_on = '2026-01-01'",
      'breach_reading = -1',
      'observed_at = now()',
    ]) {
      const error = await refusalAsRole(db, 'authenticated',
        `update public.trading_accounts set ${set} where id = $1`, { subject: world.gray.auth, params: [world.accounts.seen] });
      expect(error, set).toMatch(GUARDED);
    }
    expect(await observed(world.accounts.seen)).toEqual(before);
  });

  it('a Manager is refused the same way: it is the browser role, not the person', async () => {
    expect(await refusalAsRole(db, 'authenticated',
      "update public.trading_accounts set observed_state = 'seen' where id = $1",
      { subject: world.managerAuth, params: [world.accounts.absent5] })).toMatch(GUARDED);
  });

  it('every other column still saves from the browser, including the status and date_failed a human sets', async () => {
    const rows = await committed(world.gray.auth,
      `update public.trading_accounts set notes = 'checked', status = 'Active', date_failed = null
        where id = $1 returning notes, status, date_failed, observed_state`, [world.accounts.m2Negative]);
    expect(rows).toEqual([{ notes: 'checked', status: 'Active', date_failed: null, observed_state: 'breached' }]);
    // A human revive is honoured: the next refresh sees the breach already
    // observed and does not fail it again.
    const audits = await autoFailAudits();
    await refresh(world.clientA);
    expect(await observed(world.accounts.m2Negative)).toMatchObject({ status: 'Active', observed_state: 'breached' });
    expect(await autoFailAudits()).toBe(audits);
    await committed(world.gray.auth, "update public.trading_accounts set status = 'Failed', date_failed = '2026-10-06' where id = $1", [world.accounts.m2Negative]);
  });

  it('a browser insert that names an observation is refused; a plain insert lands never_seen and is counted at commit', async () => {
    for (const named of ["observed_state) values ($1, 'ACC 20', 'seen')", "auto_fail_flag_id) values ($1, 'ACC 20', gen_random_uuid())"]) {
      expect(await refusalAsRole(db, 'authenticated',
        `insert into public.trading_accounts (client_id, account_name, ${named}`,
        { subject: world.gray.auth, params: [world.clientA] }), named).toMatch(GUARDED);
    }
    const rows = await committed(world.gray.auth,
      "insert into public.trading_accounts (client_id, account_name) values ($1, 'ACC 20') returning id, observed_state, closes_missed, observed_at",
      [world.clientA]);
    expect(rows[0]).toMatchObject({ observed_state: 'never_seen', closes_missed: 0, observed_at: null });
    // The insert queued a refresh; at commit the new row learned how many closes
    // its client already has.
    expect(await observed(rows[0].id)).toMatchObject({ observed_state: 'never_seen', closes_missed: 9, observed: true });
  });

  it('the browser upsert the manual import makes (every column but the six) still goes through', async () => {
    const rows = await committed(world.gray.auth,
      `insert into public.trading_accounts (client_id, account_name, alias, status, date_failed, updated_at)
       values ($1, 'ACC 01', 'ACC 01', 'Active', null, now())
       on conflict (client_id, account_name) do update set alias = excluded.alias, status = excluded.status, updated_at = excluded.updated_at
       returning observed_state, last_close_seen_on::text as last_close_seen_on`, [world.clientA]);
    expect(rows).toEqual([{ observed_state: 'seen', last_close_seen_on: D9 }]);
  });

  it('the service role may call the refresh; anon and authenticated are refused at the door', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select public.refresh_account_observations($1)',
        { subject: world.gray.auth, params: [world.clientA] })).toMatch(/permission denied for function refresh_account_observations/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select public.refresh_account_observations($1)', { params: [world.clientA] })).toBeNull();
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: exact, and this file\'s own', () => {
  it('refresh_account_observations: service_role and nobody else', async () => {
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
  });

  it('the helpers and trigger functions: nobody but the owner', async () => {
    for (const signature of HELPERS) {
      expect(await executeGrantees(signature), signature).toEqual([]);
    }
  });

  it('account_observation_settings: authenticated holds exactly SELECT, anon nothing, TRUNCATE refused, RLS on', async () => {
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'account_observation_settings')).toEqual([]);
    for (const statement of [
      'insert into public.account_observation_settings default values',
      'update public.account_observation_settings set updated_at = now() where id',
      'delete from public.account_observation_settings where id',
      'truncate table public.account_observation_settings',
    ]) {
      expect(await refusalAsRole(db, 'authenticated', statement, { subject: world.managerAuth }), statement).toMatch(DENIED);
    }
    expect(await one(db, "select relrowsecurity from pg_class where oid = 'public.account_observation_settings'::regclass")).toBe(true);
  });

  it('trading_accounts keeps the four verbs for authenticated and nothing for anon', async () => {
    expect((await privilegesOn(db, 'authenticated', 'trading_accounts')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'anon', 'trading_accounts')).toEqual([]);
    expect(await refusalAsRole(db, 'authenticated', 'truncate table public.trading_accounts', { subject: world.managerAuth })).toMatch(DENIED);
  });

  it('they survive step 56 being run again on top, and 65 again after it', async () => {
    await applyFileCollectingNotices(db, 'step_56_table_privilege_lockdown.sql');
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'account_observation_settings')).toEqual([]);
    await applyFileCollectingNotices(db, STEP);
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
  });

  it('the service_role grant is the file\'s own, not the birth privilege: drift installed on purpose, 65 puts it back', async () => {
    // Supabase (and this harness) hands every new function EXECUTE for
    // service_role at birth, so an assertion made right after the first run
    // cannot tell a GRANT line from its absence. The ACL is first put where a
    // stray SQL editor session could leave it, and 65 has to restore it.
    await db.exec(`revoke execute on function ${REFRESH} from service_role;
                   grant execute on function ${REFRESH} to anon, authenticated;`);
    expect(await executeGrantees(REFRESH)).toEqual(['anon', 'authenticated']);
    await applyFileCollectingNotices(db, STEP);
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
  });
});

/* ── Running it again ────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('refreshes the same accounts, marks nothing, writes no second flag or audit row, keeps the definition', async () => {
    const audits = await autoFailAudits();
    const flags = await flagCount();
    const states = (await db.query('select id, status, date_failed, observed_state, closes_missed, breached_on from public.trading_accounts order by id')).rows;
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((n) => n.startsWith('step 65:'))).toEqual([
      `step 65: refreshed ${await accountsOfClientsWithCloses()} account(s) across ${await clientsWithCloses()} client(s)`,
    ]);
    expect(await autoFailAudits()).toBe(audits);
    expect(await flagCount()).toBe(flags);
    expect((await db.query('select id, status, date_failed, observed_state, closes_missed, breached_on from public.trading_accounts order by id')).rows).toEqual(states);
    expect(await refreshDefinition()).toBe(world.after.definition);
    expect(await one(db, 'select count(*)::int from public.account_observation_settings')).toBe(1);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 65 is numbered once, after 64', () => {
  it('appears once, and 54 is still a deliberate gap', () => {
    // Step 66's test now holds the "highest number" assertion; this one only
    // says 65 is here once and that nothing reused 54.
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 65)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(65);
    expect(numbers).not.toContain(54);
    for (const merged of [58, 59, 60, 61, 62, 63, 64]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 64, and in the run order after 64', () => {
    expect(runbook).toMatch(/^\| 65 \| `step_65_account_observations\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 65 | `step_65_account_observations.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 64 | `step_64_algorithm_live_position.sql`'));
    expect(runbook).toMatch(/→ 63 → 64 → 65( →|\.)/);
    expect(runbook).toContain('Step 65');
  });
});
