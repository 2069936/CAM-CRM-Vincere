/* STEP 71, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 70 and a fictional book is
 * seeded the way production got where it is: closes land through step 65's
 * triggers while step 67's refresh still fails an account on the breach alone,
 * so accounts are failed by the close and then trade on (the 13), a Payout
 * Hold account is failed, an account with a date already on it is failed, one
 * is frozen with its strategies still loaded in NinjaTrader, a person fails one
 * that then trades, a person re-confirms one the close failed, a person
 * revives one, and the owner turns auto_fail_on_breach off by hand before one
 * more breach lands. Then 71 runs the way Pedro runs it, with the setting
 * still off. After that, new closes land (peer clients trading the same
 * algorithm, an account that keeps trading on a negative reading, a dead one,
 * an absent one, one whose algorithm traded nowhere, one with too few peers)
 * and every verdict is the database's own.
 *
 * Nothing here asserts the text of the SQL except the try lock (a single
 * connection cannot race a sample against a refresh) and the lines that read
 * the directory listing and the runbook, which have no other witness.
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
  startMigrationCluster,
} from './migrationCluster.js';
import { DATABASE_FLAG_TYPES } from '../src/domain/databaseFlagTypes.js';

const STEP = 'step_71_confirmed_failure.sql';
const sql = readFileSync(new URL(STEP, import.meta.url), 'utf8');
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const DENIED = /permission denied/i;
const GUARDED = /written by the close \(refresh_account_observations\), not by the browser/;
const DASH = /[‒-―−]| - /;

const REFRESH = 'public.refresh_account_observations(uuid)';
const CHECK = 'public.failed_account_strategies_check(uuid, text)';
const OWNER_ONLY = [
  'public.account_observation_money(numeric)',
  'public.auto_failed_flag_message(text, jsonb, numeric)',
  'public.account_status_changed_by_person(uuid, timestamptz)',
  'public.account_live_samples_failed_strategies()',
  'public.trading_accounts_observed_columns_guard()',
  'public.account_observation_reading(numeric)',
  'public.account_observation_breach(numeric, text, numeric)',
  'public.account_observations_trigger()',
];

/* Phase A: the closes step 65 and 67 saw. Phase B: the ones after 71. */
const A = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'];
const E = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];

let db;
const world = { acc: {}, closes: {}, peers: {}, clients: {} };

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

/** Runs one statement as the service role and KEEPS its effect. */
async function asService(statement, params) {
  await db.exec('begin');
  try {
    await db.exec('set local role service_role');
    const result = await db.query(statement, params);
    await db.exec('commit');
    return result.rows;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function account(clientId, name, { type = 'Evaluation - Standard', status = 'Active', limit = null, dateFailed = null, alias = null } = {}) {
  return one(db,
    `insert into public.trading_accounts (client_id, account_name, alias, account_type, status, max_drawdown_limit, date_failed)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [clientId, name, alias, type, status, limit, dateFailed]);
}

/**
 * One close landing the way the browser lands one: the daily_imports row, its
 * snapshots and their strategy rows in one transaction, so step 65's deferred
 * triggers run the refresh once, at commit.
 *
 * rows: [{ id, name, trailing, pnl, strategies: [{ family, name, byAccount }] }]
 * A strategy with byAccount true carries no account_snapshot_id, only the
 * trading account, which is the other way a row belongs to an account.
 */
async function landClose(clientId, day, rows = []) {
  await db.exec('begin');
  try {
    const closeId = await one(db,
      'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [clientId, day]);
    for (const row of rows) {
      const snapshotId = await one(db,
        `insert into public.account_snapshots
           (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, gross_realized_pnl, account_balance)
         values ($1, $2, $3, $4, $5, 50000) returning id`,
        [closeId, row.id ?? null, row.name, row.trailing ?? 1000, row.pnl ?? 0]);
      for (const strategy of row.strategies || []) {
        await db.query(
          `insert into public.strategy_snapshots
             (daily_import_id, trading_account_id, account_snapshot_id, strategy_name, strategy_family)
           values ($1, $2, $3, $4, $5)`,
          [closeId, row.id ?? null, strategy.byAccount ? null : snapshotId,
            strategy.name ?? `${strategy.family} - 1.0.0`, strategy.family ?? '']);
      }
    }
    await db.exec('commit');
    return closeId;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function refresh(clientId) {
  return one(db, 'select public.refresh_account_observations($1)', [clientId]);
}

async function setting(name, value) {
  await db.query(`update public.account_observation_settings set ${name} = $1, updated_at = now() where id`, [value]);
}

async function row(accountId) {
  return (await db.query(
    `select account_name, status, date_failed::text as date_failed, observed_state,
            breached_on::text as breached_on, breach_reading::text as breach_reading,
            auto_failed_at is not null as marked, auto_failed_prior_status,
            auto_failed_date_set, auto_failed_through::text as auto_failed_through,
            auto_fail_flag_id, breach_flag_id
       from public.trading_accounts where id = $1`, [accountId])).rows[0];
}

/** The same row before 71 ran, when the marker columns do not exist yet. */
async function rowBefore71(accountId) {
  return (await db.query(
    `select account_name, status, date_failed::text as date_failed, observed_state,
            breached_on::text as breached_on, breach_reading::text as breach_reading
       from public.trading_accounts where id = $1`, [accountId])).rows[0];
}

async function flagsOf(accountId, type = null) {
  return (await db.query(
    `select f.id, f.type, f.severity, f.status, f.message, f.resolution_note, f.resolved_by_user_id,
            d.trading_date::text as close_date
       from public.operational_flags as f
       left join public.daily_imports as d on d.id = f.daily_import_id
      where f.trading_account_id = $1 and ($2::text is null or f.type = $2)
      order by f.created_at, f.type, f.message`, [accountId, type])).rows;
}

async function openFlags(accountId, type) {
  return (await flagsOf(accountId, type)).filter((flag) => flag.status === 'Open');
}

async function auditsOf(accountId, action) {
  return (await db.query(
    `select user_id, before_data, after_data from public.audit_logs
      where entity_type = 'trading_account' and entity_id = $1 and action = $2
      order by created_at, id`, [accountId, action])).rows;
}

async function countAudits(action) {
  return one(db, 'select count(*)::int from public.audit_logs where action = $1', [action]);
}

async function executeGrantees(signature) {
  const roles = await column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
  return roles.filter((role) => role !== 'postgres');
}

/** The audit row the app writes after a status save (src/App.jsx persistAccountUpdate). */
async function appAudit(subject, appUserId, clientKey, accountName, patch) {
  await committed(subject,
    `insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
     values ($1, 'trading_account', null, 'account.update', $2::jsonb)`,
    [appUserId, JSON.stringify({ clientId: clientKey, accountName, patch, legacyEntityId: accountName })]);
}

/** What a CAM's save of the account does in the browser: an UPDATE as authenticated. */
async function browserSave(accountId, set, params = []) {
  await committed(world.gray.auth, `update public.trading_accounts set ${set} where id = $1`, [accountId, ...params]);
}

async function sample(accountName, { strategies = 3, enabled = 2, minutes = 0 } = {}) {
  await db.query(
    `insert into public.account_live_samples
       (device_id, client_id, account_name, connected, strategy_count, enabled_strategy_count, sampled_at)
     values ($1, $2, $3, true, $4, $5, now() - interval '3 hours' + make_interval(mins => $6))
     on conflict (device_id, account_name) do update set
       strategy_count = excluded.strategy_count,
       enabled_strategy_count = excluded.enabled_strategy_count,
       sampled_at = excluded.sampled_at`,
    [world.device, world.clients.maple, accountName, strategies, enabled, minutes]);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 70 }));

  const grayProfile = await one(db, "insert into public.cam_profiles (name) values ('Gray') returning id");
  const grayAuth = await one(db, "insert into auth.users (email) values ('gray@example.com') returning id");
  const grayUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id, cam_profile_id)
    values ('gray', 'Gray', 'gray@example.com', 'CAM', 'Active', $1, $2) returning id`, [grayAuth, grayProfile]);
  world.gray = { profile: grayProfile, auth: grayAuth, user: grayUser };

  async function client(name, legacyKey = null) {
    const id = await one(db, 'insert into public.clients (name, legacy_key) values ($1, $2) returning id', [name, legacyKey]);
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [id, grayProfile]);
    return id;
  }

  /* ── Maple Lane: the book step 65 failed, before 71 ─────────────────────── */
  const M = await client('Maple Lane', 'maple-lane');
  world.clients.maple = M;
  const acc = world.acc;
  acc.falseFail = await account(M, 'MP 01', { alias: 'Maple One' });
  acc.holdFail = await account(M, 'MP 02', { type: 'Funded', status: 'Payout Hold', limit: 1500 });
  acc.datedDead = await account(M, 'MP 03', { dateFailed: '2026-01-15' });
  acc.datedTrades = await account(M, 'MP 04', { dateFailed: '2026-01-15' });
  acc.frozen = await account(M, 'MP 05');
  acc.humanFailed = await account(M, 'MP 06');
  acc.humanConfirmed = await account(M, 'MP 07');
  acc.revivedByPerson = await account(M, 'MP 08');
  acc.breachedWhileOff = await account(M, 'MP 09');

  world.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [M]);

  // Three breaches per close at most, so step 65 writes one flag per account.
  const a = (index, rows) => landClose(M, A[index], rows);
  world.closes.A0 = await a(0, [
    { id: acc.falseFail, name: 'MP 01', trailing: 500, pnl: 100 },
    { id: acc.holdFail, name: 'MP 02', trailing: -800, pnl: 50 },
    { id: acc.datedDead, name: 'MP 03', trailing: 300, pnl: 90 },
    { id: acc.datedTrades, name: 'MP 04', trailing: 300, pnl: 40 },
    { id: acc.frozen, name: 'MP 05', trailing: 200, pnl: 50 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 20 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: 900, pnl: 20 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: 900, pnl: 20 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: 900, pnl: 20 },
  ]);
  world.closes.A1 = await a(1, [
    { id: acc.falseFail, name: 'MP 01', trailing: -1524, pnl: -900 },
    { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: -800 },
    { id: acc.datedDead, name: 'MP 03', trailing: 250, pnl: 60 },
    { id: acc.datedTrades, name: 'MP 04', trailing: 250, pnl: 10 },
    { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: -220 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 15 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: 900, pnl: 15 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: 900, pnl: 15 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: 900, pnl: 15 },
  ]);
  world.closes.A2 = await a(2, [
    { id: acc.falseFail, name: 'MP 01', trailing: -1200, pnl: 300 },
    { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: 0 },
    { id: acc.datedDead, name: 'MP 03', trailing: -50, pnl: -100 },
    { id: acc.datedTrades, name: 'MP 04', trailing: -30, pnl: -80 },
    { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: 0 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 25 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: 900, pnl: 25 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: 900, pnl: 25 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: 900, pnl: 25 },
  ]);
  // A person marks MP 06 Failed, dated, the way the app saves it and audits it.
  await browserSave(acc.humanFailed, "status = 'Failed', date_failed = '2026-09-23'");
  await appAudit(world.gray.auth, grayUser, 'maple-lane', 'MP 06', { status: 'Failed', dateFailed: '2026-09-23' });

  world.closes.A3 = await a(3, [
    { id: acc.falseFail, name: 'MP 01', trailing: -1100, pnl: 0 },
    { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: 200 },
    { id: acc.datedDead, name: 'MP 03', trailing: -50, pnl: 0 },
    { id: acc.datedTrades, name: 'MP 04', trailing: -30, pnl: 35 },
    { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: 0 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 0 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: -40, pnl: -300 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: -40, pnl: -300 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: 900, pnl: 10 },
  ]);
  // A person answers MP 07's flag with "Failed, mark it Failed": the same
  // status saved again, and the app's audit row. And revives MP 08.
  await browserSave(acc.humanConfirmed, "status = 'Failed', date_failed = '2026-09-24'");
  await appAudit(world.gray.auth, grayUser, 'maple-lane', 'MP 07', { status: 'Failed', dateFailed: '2026-09-24' });
  await browserSave(acc.revivedByPerson, "status = 'Active'");
  await appAudit(world.gray.auth, grayUser, 'maple-lane', 'MP 08', { status: 'Active' });

  world.closes.A4 = await a(4, [
    { id: acc.falseFail, name: 'MP 01', trailing: -1000, pnl: 150 },
    { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: 0 },
    { id: acc.datedDead, name: 'MP 03', trailing: -50, pnl: 0 },
    { id: acc.datedTrades, name: 'MP 04', trailing: -30, pnl: 0 },
    { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: 0 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 60 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: -40, pnl: 70 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: -40, pnl: 0 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: 900, pnl: 10 },
  ]);

  // The owner turns the auto fail off by hand, and one more breach lands.
  await setting('auto_fail_on_breach', false);
  world.closes.A5 = await a(5, [
    { id: acc.falseFail, name: 'MP 01', trailing: -900, pnl: 80 },
    { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: 0 },
    { id: acc.datedDead, name: 'MP 03', trailing: -50, pnl: 0 },
    { id: acc.datedTrades, name: 'MP 04', trailing: -30, pnl: 0 },
    { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: 0 },
    { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 0 },
    { id: acc.humanConfirmed, name: 'MP 07', trailing: -40, pnl: 0 },
    { id: acc.revivedByPerson, name: 'MP 08', trailing: -40, pnl: 0 },
    { id: acc.breachedWhileOff, name: 'MP 09', trailing: -5, pnl: -60 },
  ]);

  // The frozen account's strategies, still loaded and running in NinjaTrader.
  await sample('MP 05', { strategies: 3, enabled: 2 });

  world.before = {
    rows: Object.fromEntries(await Promise.all(Object.entries(acc).map(async ([key, id]) => [key, await rowBefore71(id)]))),
    columns: await column(db, `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'trading_accounts' and column_name like 'auto_failed%' order by 1`),
    autoFailed: await countAudits('trading_account.auto_failed'),
    flagsMarked: (await flagsOf(acc.falseFail, 'Marked Failed by the close')),
    datedDeadFlag: (await flagsOf(acc.datedDead, 'Marked Failed by the close'))[0],
  };

  world.notices = await applyFileCollectingNotices(db, STEP);
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── Before 71: the book as step 65 and 67 left it ─────────────────────────── */

describe('before step 71', () => {
  it('step 65 had failed every breach on the breach alone, the 13 shape among them', () => {
    const before = world.before.rows;
    for (const key of ['falseFail', 'holdFail', 'datedDead', 'datedTrades', 'frozen', 'humanConfirmed']) {
      expect(before[key].status, key).toBe('Failed');
    }
    expect(before.falseFail).toMatchObject({ date_failed: '2026-09-22', observed_state: 'breached', breach_reading: '-1524' });
    expect(before.revivedByPerson).toMatchObject({ status: 'Active', observed_state: 'breached' });
    expect(before.breachedWhileOff).toMatchObject({ status: 'Active', observed_state: 'breached', breached_on: '2026-09-28' });
    expect(world.before.columns).toEqual([]);
    expect(world.before.autoFailed).toBe(7);
    expect(world.before.flagsMarked).toHaveLength(1);
  });
});

/* ── What 71 did when it ran ──────────────────────────────────────────────── */

describe('running 71 with auto_fail_on_breach off, as the owner has it', () => {
  it('says what it marked and what the recompute did, and leaves the setting as it was', async () => {
    expect(world.notices.filter((notice) => notice.startsWith('step 71:'))).toEqual([
      "step 71: 5 account(s) the close had already marked Failed now carry its marker (5 with the prior status read from the audit row's after_data)",
      'step 71: refreshed 9 account(s) across 1 client(s): 3 set back to their status before the close failed them, 0 marked Failed, 0 Breach suspected, 2 Failed account traded and 1 Strategies still loaded flag(s) written',
    ]);
    expect((await db.query(
      'select auto_fail_on_breach, confirm_closes, confirm_peer_accounts, auto_reactivate from public.account_observation_settings',
    )).rows).toEqual([{ auto_fail_on_breach: false, confirm_closes: 2, confirm_peer_accounts: 3, auto_reactivate: true }]);
  });

  it('a step 65 failure that traded on later closes is set back: Active, its date cleared, audited, flagged', async () => {
    expect(await row(world.acc.falseFail)).toMatchObject({
      status: 'Active', date_failed: null, observed_state: 'breached', breached_on: '2026-09-22', marked: false,
    });
    const audits = await auditsOf(world.acc.falseFail, 'trading_account.auto_reactivated');
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBeNull();
    expect(audits[0].before_data).toMatchObject({ status: 'Failed', dateFailed: '2026-09-22', autoFailedThrough: '2026-09-22', autoFailedDateSet: true });
    expect(audits[0].after_data).toEqual({
      clientId: world.clients.maple, accountName: 'MP 01', status: 'Active', dateFailed: null, dateFailedCleared: true,
      failedOn: '2026-09-22', tradedOn: '2026-09-28', firstTradedOn: '2026-09-23', tradedCloses: 3,
    });
    const flags = await flagsOf(world.acc.falseFail, 'Reactivated by the close');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: 'Warning', status: 'Open', close_date: '2026-09-28' });
    expect(flags[0].message).toBe('Maple One was marked Failed by the CRM on 2026-09-22 but traded on 2026-09-28. It is Active again. Its drawdown limit is not set, so check it.');
  });

  it('the close resolves its own failure flag on that account, with a note', async () => {
    const [marked] = await flagsOf(world.acc.falseFail, 'Marked Failed by the close');
    expect(marked).toMatchObject({
      status: 'Resolved', resolved_by_user_id: null,
      resolution_note: 'Account traded after the close marked it Failed, so the close set it back.',
    });
  });

  it('a Payout Hold account goes back to Payout Hold: the prior status is read from step 65\'s after_data', async () => {
    expect(await row(world.acc.holdFail)).toMatchObject({ status: 'Payout Hold', date_failed: null, marked: false });
    const [flag] = await flagsOf(world.acc.holdFail, 'Reactivated by the close');
    expect(flag.message).toBe('MP 02 was marked Failed by the CRM on 2026-09-22 but traded on 2026-09-24. It is Payout Hold again. Its drawdown limit is set to $1,500, so check it.');
  });

  it('a date that was already on the row is kept when the account is set back', async () => {
    expect(await row(world.acc.datedTrades)).toMatchObject({ status: 'Active', date_failed: '2026-01-15', marked: false });
    expect((await auditsOf(world.acc.datedTrades, 'trading_account.auto_reactivated'))[0].after_data)
      .toMatchObject({ dateFailed: '2026-01-15', dateFailedCleared: false, failedOn: '2026-09-23', tradedOn: '2026-09-24' });
  });

  it('trades BEFORE the breach do not set an account back, whatever older date_failed it carries', async () => {
    // MP 03 traded on 2026-09-21 and 22, after its 2026-01-15 date and before
    // its 2026-09-23 breach, and never after: it stays Failed, marked.
    expect(await row(world.acc.datedDead)).toMatchObject({
      status: 'Failed', date_failed: '2026-01-15', marked: true,
      auto_failed_prior_status: 'Active', auto_failed_date_set: false, auto_failed_through: '2026-09-23',
    });
    expect(await auditsOf(world.acc.datedDead, 'trading_account.auto_reactivated')).toEqual([]);
    expect(await flagsOf(world.acc.datedDead, 'Failed account traded')).toEqual([]);
  });

  it('the frozen account stays Failed, carries the marker, and is told to remove its strategies', async () => {
    expect(await row(world.acc.frozen)).toMatchObject({
      status: 'Failed', date_failed: '2026-09-22', marked: true,
      auto_failed_prior_status: 'Active', auto_failed_date_set: true, auto_failed_through: '2026-09-22',
    });
    const flags = await openFlags(world.acc.frozen, 'Strategies still loaded');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: 'Warning', close_date: '2026-09-28' });
    expect(flags[0].message).toBe('MP 05 failed on 2026-09-22 and has had no trades since, but its strategies are still loaded in NinjaTrader. Remove them.');
  });

  it('an account a person failed that traded afterwards gets one flag and nothing else', async () => {
    expect(await row(world.acc.humanFailed)).toMatchObject({ status: 'Failed', date_failed: '2026-09-23', marked: false });
    const [flag, ...more] = await flagsOf(world.acc.humanFailed, 'Failed account traded');
    expect(more).toEqual([]);
    expect(flag).toMatchObject({ status: 'Open', severity: 'Warning', close_date: '2026-09-25' });
    expect(flag.message).toBe('MP 06 is marked Failed but traded on 2026-09-25. Check it.');
    expect(await auditsOf(world.acc.humanFailed, 'trading_account.auto_reactivated')).toEqual([]);
  });

  it('a step 65 failure a person re-saved as Failed (the app\'s audit row) is the person\'s: no marker, flag only', async () => {
    expect(await row(world.acc.humanConfirmed)).toMatchObject({ status: 'Failed', marked: false });
    expect((await flagsOf(world.acc.humanConfirmed, 'Failed account traded')).map((flag) => flag.message))
      .toEqual(['MP 07 is marked Failed but traded on 2026-09-25. Check it.']);
  });

  it('an account a person revived, and one breached while the auto fail was off, stay Active with no new flag', async () => {
    for (const key of ['revivedByPerson', 'breachedWhileOff']) {
      expect(await row(world.acc[key]), key).toMatchObject({ status: 'Active', observed_state: 'breached', marked: false });
      expect(await flagsOf(world.acc[key], 'Breach suspected'), key).toEqual([]);
    }
  });

  it('no flag and no audit text written by 71 carries a dash as punctuation', async () => {
    const texts = await column(db, `select type || ' ' || message || ' ' || coalesce(resolution_note, '') from public.operational_flags
      where type in ('Breach suspected', 'Reactivated by the close', 'Failed account traded', 'Strategies still loaded')
         or resolution_note is not null`);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.replace(/-\$/g, '$')).not.toMatch(DASH);
  });
});

/* ── After 71: closes keep landing ────────────────────────────────────────── */

describe('after 71, with the auto fail back on: a breach is suspected first and confirmed by the closes', () => {
  beforeAll(async () => {
    await setting('auto_fail_on_breach', true);

    // Four other clients trading on every close of the week. IFSP is traded by
    // exactly three of their accounts (one through strategy_family_key, one
    // through a strategy row that names only the trading account), BOLT by two
    // accounts in three rows, QUIET by nobody.
    const peer = async (name) => {
      const id = await one(db, 'insert into public.clients (name) values ($1) returning id', [name]);
      world.peers[name] = id;
      return id;
    };
    const pa = await peer('Peer A');
    const pb = await peer('Peer B');
    const pc = await peer('Peer C');
    const pd = await peer('Peer D');
    const PA1 = await account(pa, 'PA 01');
    const PA2 = await account(pa, 'PA 02');
    const PB1 = await account(pb, 'PB 01');
    const PB2 = await account(pb, 'PB 02');
    const PC2 = await account(pc, 'PC 02');
    const PD1 = await account(pd, 'PD 01');
    for (const day of E) {
      await landClose(pa, day, [
        { id: PA1, name: 'PA 01', pnl: 100, strategies: [{ family: 'IFSP' }] },
        { id: PA2, name: 'PA 02', pnl: 50, strategies: [{ family: 'BOLT', name: 'BOLT - 1.0.0' }, { family: 'BOLT', name: 'BOLT - 1.1.0' }] },
      ]);
      await landClose(pb, day, [
        { id: PB1, name: 'PB 01', pnl: -40, strategies: [{ family: 'IFSP', byAccount: true }] },
        { id: PB2, name: 'PB 02', pnl: 30, strategies: [{ family: 'BOLT' }] },
      ]);
      await landClose(pc, day, [
        // An orphan: no registry row, the family only in the strategy name.
        { id: null, name: 'PC 01', pnl: 20, strategies: [{ family: '', name: '3 - IFSP - 2.1.0' }] },
        { id: PC2, name: 'PC 02', pnl: 0, strategies: [{ family: 'QUIET' }] },
      ]);
      await landClose(pd, day, [
        // Carries IFSP and did not trade: not a peer.
        { id: PD1, name: 'PD 01', pnl: 0, strategies: [{ family: 'IFSP' }] },
      ]);
    }

    const M = world.clients.maple;
    const acc = world.acc;
    acc.keepsTrading = await account(M, 'MP 10');
    acc.dead = await account(M, 'MP 11');
    acc.absent = await account(M, 'MP 12');
    acc.quietAlgo = await account(M, 'MP 13');
    acc.fewPeers = await account(M, 'MP 14');
    acc.boltBuddy = await account(M, 'MP 15');
    acc.noStrategies = await account(M, 'MP 16');
    acc.tradedBetween = await account(M, 'MP 21');

    // The accounts 71 found, as they go on: the ones it set back keep trading
    // on negative readings, the Failed ones sit at zero, MP 08 and MP 09 are
    // gone from the closes.
    const carried = (pnl) => [
      { id: acc.falseFail, name: 'MP 01', trailing: -800, pnl: pnl ? 10 : 0 },
      { id: acc.holdFail, name: 'MP 02', trailing: -1600, pnl: pnl ? 5 : 0 },
      { id: acc.datedDead, name: 'MP 03', trailing: -50, pnl: 0 },
      { id: acc.datedTrades, name: 'MP 04', trailing: -30, pnl: pnl ? 7 : 0 },
      { id: acc.frozen, name: 'MP 05', trailing: -20, pnl: 0 },
      { id: acc.humanFailed, name: 'MP 06', trailing: 900, pnl: 0 },
      { id: acc.humanConfirmed, name: 'MP 07', trailing: -40, pnl: 0 },
      { id: acc.boltBuddy, name: 'MP 15', trailing: 700, pnl: 25, strategies: [{ family: 'BOLT' }] },
    ];
    const ifsp = [{ family: 'IFSP' }];
    const plan = [
      // E1: seven breaches land.
      [
        { id: acc.keepsTrading, name: 'MP 10', trailing: -300, pnl: -300, strategies: ifsp },
        { id: acc.dead, name: 'MP 11', trailing: -50, pnl: -400, strategies: ifsp },
        { id: acc.absent, name: 'MP 12', trailing: -10, pnl: -100, strategies: ifsp },
        { id: acc.quietAlgo, name: 'MP 13', trailing: -10, pnl: -100, strategies: [{ family: 'QUIET' }] },
        { id: acc.fewPeers, name: 'MP 14', trailing: -10, pnl: -100, strategies: [{ family: 'BOLT' }] },
        { id: acc.noStrategies, name: 'MP 16', trailing: -10, pnl: -100 },
        { id: acc.tradedBetween, name: 'MP 21', trailing: -10, pnl: -100, strategies: ifsp },
      ],
      // E2: MP 10 and MP 21 trade, the rest sit, MP 12 is missing.
      [
        { id: acc.keepsTrading, name: 'MP 10', trailing: -180, pnl: 120, strategies: ifsp },
        { id: acc.dead, name: 'MP 11', trailing: -50, pnl: 0, strategies: ifsp },
        { id: acc.quietAlgo, name: 'MP 13', trailing: -10, pnl: 0, strategies: [{ family: 'QUIET' }] },
        { id: acc.fewPeers, name: 'MP 14', trailing: -10, pnl: 0, strategies: [{ family: 'BOLT' }] },
        { id: acc.noStrategies, name: 'MP 16', trailing: -10, pnl: 0 },
        { id: acc.tradedBetween, name: 'MP 21', trailing: -10, pnl: 20, strategies: ifsp },
      ],
      // E3
      [
        { id: acc.keepsTrading, name: 'MP 10', trailing: -150, pnl: 30, strategies: ifsp },
        { id: acc.dead, name: 'MP 11', trailing: -50, pnl: 0, strategies: ifsp },
        { id: acc.quietAlgo, name: 'MP 13', trailing: -10, pnl: 0, strategies: [{ family: 'QUIET' }] },
        { id: acc.fewPeers, name: 'MP 14', trailing: -10, pnl: 0, strategies: [{ family: 'BOLT' }] },
        { id: acc.noStrategies, name: 'MP 16', trailing: -10, pnl: 0 },
        { id: acc.tradedBetween, name: 'MP 21', trailing: -10, pnl: 0, strategies: ifsp },
      ],
      // E4
      [
        { id: acc.keepsTrading, name: 'MP 10', trailing: -100, pnl: 15, strategies: ifsp },
        { id: acc.dead, name: 'MP 11', trailing: -50, pnl: 0, strategies: ifsp },
        { id: acc.quietAlgo, name: 'MP 13', trailing: -10, pnl: 0, strategies: [{ family: 'QUIET' }] },
        { id: acc.fewPeers, name: 'MP 14', trailing: -10, pnl: 0, strategies: [{ family: 'BOLT' }] },
        { id: acc.noStrategies, name: 'MP 16', trailing: -10, pnl: 0 },
        { id: acc.tradedBetween, name: 'MP 21', trailing: -10, pnl: 0, strategies: ifsp },
      ],
    ];
    world.after = {};
    for (const [index, day] of E.entries()) {
      world.closes[`E${index + 1}`] = await landClose(M, day, [...carried(true), ...plan[index]]);
      world.after[`E${index + 1}`] = Object.fromEntries(await Promise.all(
        ['dead', 'absent', 'breachedWhileOff', 'tradedBetween', 'keepsTrading', 'falseFail', 'revivedByPerson']
          .map(async (key) => [key, (await row(acc[key])).status])));
    }
  }, 120_000);

  it('turning the auto fail back on confirms the account that breached while it was off, once it is missing from two closes', async () => {
    expect(world.after.E1.breachedWhileOff).toBe('Active');
    expect(world.after.E2.breachedWhileOff).toBe('Failed');
    const [audit] = await auditsOf(world.acc.breachedWhileOff, 'trading_account.auto_failed');
    expect(audit.after_data).toMatchObject({
      confirmedBy: 'absent', closes: ['2026-10-05', '2026-10-06'], breachedOn: '2026-09-28', confirmedOn: '2026-10-06',
    });
    const [flag] = await openFlags(world.acc.breachedWhileOff, 'Marked Failed by the close');
    expect(flag.close_date).toBe('2026-10-06');
    expect(flag.message).toBe('MP 09 breached on 2026-09-28: trailing reading -$5, and it has been missing from the last 2 closes (2026-10-05, 2026-10-06). Status was Active. Change the status on the account if the prop firm says otherwise.');
  });

  it('a model 2 account that keeps trading on a negative reading stays Active, with one Breach suspected flag', async () => {
    for (const day of ['E1', 'E2', 'E3', 'E4']) expect(world.after[day].keepsTrading, day).toBe('Active');
    expect(await row(world.acc.keepsTrading)).toMatchObject({ status: 'Active', observed_state: 'breached', breached_on: '2026-10-05', marked: false });
    const flags = await flagsOf(world.acc.keepsTrading, 'Breach suspected');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: 'Warning', status: 'Open', close_date: '2026-10-05' });
    expect(flags[0].message).toBe('MP 10 read -$300 on 2026-10-05, past its drawdown rule. It stays Active: the CRM marks it Failed only if, for 2 closes in a row, it stops trading while its algorithm keeps trading on at least 3 accounts of other clients, or it disappears from the closes.');
    expect(await auditsOf(world.acc.keepsTrading, 'trading_account.auto_failed')).toEqual([]);
    expect((await row(world.acc.keepsTrading)).breach_flag_id).toBe(flags[0].id);
  });

  it('an account the close set back keeps trading on its negative reading and stays Active', async () => {
    for (const day of ['E1', 'E2', 'E3', 'E4']) expect(world.after[day].falseFail, day).toBe('Active');
    expect(await auditsOf(world.acc.falseFail, 'trading_account.auto_failed')).toHaveLength(1);
  });

  it('a dead account whose algorithm traded on three other clients\' accounts is failed after two quiet closes, not one', async () => {
    expect(world.after.E2.dead).toBe('Active');
    expect(world.after.E3.dead).toBe('Failed');
    expect(await row(world.acc.dead)).toMatchObject({
      status: 'Failed', date_failed: '2026-10-05', marked: true,
      auto_failed_prior_status: 'Active', auto_failed_date_set: true, auto_failed_through: '2026-10-05',
    });
    const [audit, ...more] = await auditsOf(world.acc.dead, 'trading_account.auto_failed');
    expect(more).toEqual([]);
    expect(audit.before_data).toEqual({ status: 'Active', dateFailed: null });
    expect(audit.after_data).toEqual({
      clientId: world.clients.maple, accountName: 'MP 11', breachedOn: '2026-10-05', reading: -50, previousStatus: 'Active',
      confirmedBy: 'peers_traded', confirmedOn: '2026-10-07', closes: ['2026-10-06', '2026-10-07'], confirmCloses: 2,
      lastTradedOn: '2026-10-05', dateFailed: '2026-10-05', dateFailedSet: true,
      families: ['IFSP'], peerAccounts: [3, 3], minPeerAccounts: 3, peerAccountsRequired: 3,
    });
    const [flag] = await openFlags(world.acc.dead, 'Marked Failed by the close');
    expect(flag.close_date).toBe('2026-10-07');
    expect(flag.message).toBe('MP 11 breached on 2026-10-05: trailing reading -$50, and on the last 2 closes (2026-10-06, 2026-10-07) it did not trade while IFSP traded on at least 3 accounts of other clients. Status was Active. Change the status on the account if the prop firm says otherwise.');
    expect((await row(world.acc.dead)).auto_fail_flag_id).toBe(flag.id);
  });

  it('its Breach suspected flag is resolved by the close that confirmed it', async () => {
    const [suspected] = await flagsOf(world.acc.dead, 'Breach suspected');
    expect(suspected).toMatchObject({
      status: 'Resolved', resolved_by_user_id: null, resolution_note: 'Breach confirmed: the close marked the account Failed.',
    });
  });

  it('an account missing from two closes after its breach is failed as absent', async () => {
    expect(world.after.E2.absent).toBe('Active');
    expect(world.after.E3.absent).toBe('Failed');
    expect((await auditsOf(world.acc.absent, 'trading_account.auto_failed'))[0].after_data)
      .toMatchObject({ confirmedBy: 'absent', closes: ['2026-10-06', '2026-10-07'], lastTradedOn: '2026-10-05' });
    expect((await openFlags(world.acc.absent, 'Marked Failed by the close'))[0].message)
      .toBe('MP 12 breached on 2026-10-05: trailing reading -$10, and it has been missing from the last 2 closes (2026-10-06, 2026-10-07). Status was Active. Change the status on the account if the prop firm says otherwise.');
  });

  it('an account whose algorithm traded nowhere those days, one with two peers, and one with no strategy row stay Active', async () => {
    for (const key of ['quietAlgo', 'fewPeers', 'noStrategies']) {
      expect(await row(world.acc[key]), key).toMatchObject({ status: 'Active', observed_state: 'breached', marked: false });
      expect(await auditsOf(world.acc[key], 'trading_account.auto_failed'), key).toEqual([]);
      expect(await openFlags(world.acc[key], 'Breach suspected'), key).toHaveLength(1);
    }
  });

  it('trades between the breach and the confirming closes do not set the account back: no flip flop', async () => {
    expect(world.after.E3.tradedBetween).toBe('Active');
    expect(world.after.E4.tradedBetween).toBe('Failed');
    expect(await row(world.acc.tradedBetween)).toMatchObject({ status: 'Failed', date_failed: '2026-10-05', auto_failed_through: '2026-10-06' });
    await refresh(world.clients.maple);
    await refresh(world.clients.maple);
    expect((await row(world.acc.tradedBetween)).status).toBe('Failed');
    expect(await auditsOf(world.acc.tradedBetween, 'trading_account.auto_reactivated')).toEqual([]);
    expect(await auditsOf(world.acc.tradedBetween, 'trading_account.auto_failed')).toHaveLength(1);
  });

  it('a person who revived what step 65 failed is not overruled by the close in the same run of readings', async () => {
    for (const day of ['E1', 'E2', 'E3', 'E4']) expect(world.after[day].revivedByPerson, day).toBe('Active');
  });

  it('a close landing raises no NOTICE', async () => {
    const notices = [];
    const M = world.clients.maple;
    await db.exec(`begin;
      insert into public.daily_imports (client_id, trading_date) values ('${M}', '2026-10-09');
      delete from public.daily_imports where client_id = '${M}' and trading_date = '2026-10-09';
      commit;`, { onNotice: (notice) => notices.push(notice.message) });
    expect(notices).toEqual([]);
  });
});

describe('the flags the close wrote, when a re-import deletes them', () => {
  it('Breach suspected is written again, with the same words, for the accounts still Active and breached', async () => {
    const before = (await flagsOf(world.acc.keepsTrading, 'Breach suspected'))[0];
    // What a re-import of the E1 close does to its flags, in one statement.
    await db.query('delete from public.operational_flags where daily_import_id = $1', [world.closes.E1]);
    expect(await flagsOf(world.acc.keepsTrading, 'Breach suspected')).toEqual([]);
    await refresh(world.clients.maple);
    const after = await flagsOf(world.acc.keepsTrading, 'Breach suspected');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'Open', message: before.message, close_date: '2026-10-05' });
    expect((await row(world.acc.keepsTrading)).breach_flag_id).toBe(after[0].id);
    for (const key of ['quietAlgo', 'fewPeers', 'noStrategies']) expect(await openFlags(world.acc[key], 'Breach suspected'), key).toHaveLength(1);
    // The Failed ones lost a resolved row and get nothing back.
    expect(await flagsOf(world.acc.dead, 'Breach suspected')).toEqual([]);
  });

  it('a Breach suspected flag a CAM resolved is a row, so it is not written again', async () => {
    const [flag] = await openFlags(world.acc.quietAlgo, 'Breach suspected');
    await committed(world.gray.auth, "update public.operational_flags set status = 'Resolved', resolved_at = now() where id = $1", [flag.id]);
    await refresh(world.clients.maple);
    expect(await openFlags(world.acc.quietAlgo, 'Breach suspected')).toEqual([]);
  });

  it('a Marked Failed by the close flag of a step 71 failure is written again with the evidence', async () => {
    const [before] = await openFlags(world.acc.absent, 'Marked Failed by the close');
    await db.query('delete from public.operational_flags where id = $1', [before.id]);
    await refresh(world.clients.maple);
    const [after, ...more] = await openFlags(world.acc.absent, 'Marked Failed by the close');
    expect(more).toEqual([]);
    expect(after).toMatchObject({ message: before.message, close_date: before.close_date });
    expect(await auditsOf(world.acc.absent, 'trading_account.auto_failed')).toHaveLength(1);
  });

  it('and one of step 65\'s, still the close\'s, gets step 65\'s own words back', async () => {
    const original = world.before.datedDeadFlag;
    expect(original.message).toBe('MP 03 breached on 2026-09-23: trailing reading -$50, status was Active. Change the status on the account if the prop firm says otherwise.');
    await db.query('delete from public.operational_flags where id = $1', [original.id]);
    await refresh(world.clients.maple);
    const [again] = await flagsOf(world.acc.datedDead, 'Marked Failed by the close');
    expect(again).toMatchObject({ status: 'Open', message: original.message, close_date: '2026-09-23' });
  });
});

describe('who decides: the close, or a person', () => {
  beforeAll(async () => {
    // Maple Two: four accounts breach on E1 and are missing from E2 and E3, so
    // the close fails all four at once.
    const M2 = await one(db, "insert into public.clients (name) values ('Maple Two') returning id");
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [M2, world.gray.profile]);
    world.clients.maple2 = M2;
    const acc = world.acc;
    const filler = await account(M2, 'MQ 01');
    acc.revivedAfter = await account(M2, 'MP 17');
    acc.reconfirmed = await account(M2, 'MP 18');
    acc.guardCleared = await account(M2, 'MP 19');
    acc.comesBack = await account(M2, 'MP 20');
    const keep = { id: filler, name: 'MQ 01', trailing: 900, pnl: 5 };
    await landClose(M2, E[0], [
      keep,
      { id: acc.revivedAfter, name: 'MP 17', trailing: -5, pnl: -50 },
      { id: acc.reconfirmed, name: 'MP 18', trailing: -5, pnl: -50 },
      { id: acc.guardCleared, name: 'MP 19', trailing: -5, pnl: -50 },
      { id: acc.comesBack, name: 'MP 20', trailing: -5, pnl: -50 },
    ]);
    await landClose(M2, E[1], [keep]);
    await landClose(M2, E[2], [keep]);
    world.m2AfterE3 = Object.fromEntries(await Promise.all(
      ['revivedAfter', 'reconfirmed', 'guardCleared', 'comesBack'].map(async (key) => [key, await row(acc[key])])));

    // The person's turn. MP 17 revived, audited. MP 18 saved Failed again with
    // the flag queue's button, audited. MP 19 moved Active then Failed and the
    // app's audit write was lost. MP 20 nobody touches.
    await browserSave(acc.revivedAfter, "status = 'Active'");
    await appAudit(world.gray.auth, world.gray.user, M2, 'MP 17', { status: 'Active' });
    await browserSave(acc.reconfirmed, "status = 'Failed', date_failed = '2026-10-05'");
    await appAudit(world.gray.auth, world.gray.user, M2, 'mp 18 ', { status: 'Failed', dateFailed: '2026-10-05' });
    await browserSave(acc.guardCleared, "status = 'Active'");
    world.guardAfterActive = await row(acc.guardCleared);
    await browserSave(acc.guardCleared, "status = 'Failed'");
    world.guardAfterFailed = await row(acc.guardCleared);

    await landClose(M2, E[3], [
      keep,
      { id: acc.reconfirmed, name: 'MP 18', trailing: -5, pnl: 50 },
      { id: acc.guardCleared, name: 'MP 19', trailing: -5, pnl: 60 },
      { id: acc.comesBack, name: 'MP 20', trailing: -5, pnl: 40 },
    ]);
  }, 120_000);

  it('four failures in one refresh get one flag naming them, and each keeps its id', async () => {
    for (const [key, value] of Object.entries(world.m2AfterE3)) {
      expect(value, key).toMatchObject({ status: 'Failed', marked: true, date_failed: '2026-10-05' });
    }
    const summary = (await db.query(
      `select message, trading_account_id from public.operational_flags
        where client_id = $1 and type = 'Marked Failed by the close'`, [world.clients.maple2])).rows;
    expect(summary).toEqual([{
      trading_account_id: null,
      message: 'The close marked 4 accounts Failed: MP 17, MP 18, MP 19, MP 20. They breached on 2026-10-05. The audit log has the closes that confirmed each one. Change the status on an account if the prop firm says otherwise.',
    }]);
    expect(new Set(Object.values(world.m2AfterE3).map((value) => value.auto_fail_flag_id)).size).toBe(1);
  });

  it('the browser cannot write the marker, and saving a status takes the row from the close', async () => {
    for (const set of ['auto_failed_at = null', "auto_failed_prior_status = 'Payout Hold'", 'auto_failed_date_set = false',
      "auto_failed_through = '2026-01-01'", 'breach_flag_id = gen_random_uuid()']) {
      expect(await refusalAsRole(db, 'authenticated', `update public.trading_accounts set ${set} where id = $1`,
        { subject: world.gray.auth, params: [world.acc.dead] }), set).toMatch(GUARDED);
    }
    expect(await refusalAsRole(db, 'authenticated',
      "insert into public.trading_accounts (client_id, account_name, auto_failed_at) values ($1, 'MP 99', now())",
      { subject: world.gray.auth, params: [world.clients.maple] })).toMatch(GUARDED);
    expect(world.guardAfterActive).toMatchObject({ status: 'Active', marked: false, auto_failed_prior_status: null, auto_failed_through: null });
    expect(world.guardAfterFailed).toMatchObject({ status: 'Failed', marked: false });
  });

  it('an account the close failed that trades again is set back to Active, its date cleared', async () => {
    expect(await row(world.acc.comesBack)).toMatchObject({ status: 'Active', date_failed: null, marked: false });
    const [flag] = await flagsOf(world.acc.comesBack, 'Reactivated by the close');
    expect(flag.message).toBe('MP 20 was marked Failed by the CRM on 2026-10-05 but traded on 2026-10-08. It is Active again. Its drawdown limit is not set, so check it.');
    expect((await auditsOf(world.acc.comesBack, 'trading_account.auto_reactivated'))[0].after_data)
      .toMatchObject({ tradedOn: '2026-10-08', failedOn: '2026-10-05', dateFailedCleared: true });
  });

  it('a person reviving what the close failed is not overruled while the run of readings lasts', async () => {
    expect(await row(world.acc.revivedAfter)).toMatchObject({ status: 'Active', observed_state: 'breached', marked: false });
    expect(await auditsOf(world.acc.revivedAfter, 'trading_account.auto_failed')).toHaveLength(1);
  });

  it('a person who saved Failed again (the app\'s audit row, name in other case) is never set back: flag only', async () => {
    expect(await row(world.acc.reconfirmed)).toMatchObject({ status: 'Failed', marked: true });
    expect(await auditsOf(world.acc.reconfirmed, 'trading_account.auto_reactivated')).toEqual([]);
    expect((await flagsOf(world.acc.reconfirmed, 'Failed account traded')).map((flag) => flag.message))
      .toEqual(['MP 18 is marked Failed but traded on 2026-10-08. Check it.']);
  });

  it('a person who moved the status with no audit row written is never set back either: the guard took the marker', async () => {
    expect(await row(world.acc.guardCleared)).toMatchObject({ status: 'Failed', marked: false });
    expect(await auditsOf(world.acc.guardCleared, 'trading_account.auto_reactivated')).toEqual([]);
    expect((await flagsOf(world.acc.guardCleared, 'Failed account traded')).map((flag) => flag.message))
      .toEqual(['MP 19 is marked Failed but traded on 2026-10-08. Check it.']);
  });

  it('the Failed account traded flag is written once, and resolved when the account is no longer Failed', async () => {
    await refresh(world.clients.maple2);
    expect(await flagsOf(world.acc.guardCleared, 'Failed account traded')).toHaveLength(1);
    await browserSave(world.acc.guardCleared, "status = 'Active'");
    await refresh(world.clients.maple2);
    expect((await flagsOf(world.acc.guardCleared, 'Failed account traded'))[0]).toMatchObject({
      status: 'Resolved', resolution_note: 'Account is no longer Failed.',
    });
  });
});

describe('the settings', () => {
  async function smallBook(name, accounts) {
    const id = await one(db, 'insert into public.clients (name) values ($1) returning id', [name]);
    const ids = {};
    for (const accountName of accounts) ids[accountName] = await account(id, accountName);
    return { id, ids };
  }

  it('auto_reactivate off: a confirmed failure that trades gets a flag, and turning it on sets it back', async () => {
    const elm = await smallBook('Elm', ['EL 01', 'EL 02']);
    const keep = { id: elm.ids['EL 02'], name: 'EL 02', trailing: 900, pnl: 5 };
    await landClose(elm.id, E[0], [keep, { id: elm.ids['EL 01'], name: 'EL 01', trailing: -5, pnl: -50 }]);
    await landClose(elm.id, E[1], [keep]);
    await landClose(elm.id, E[2], [keep]);
    expect((await row(elm.ids['EL 01'])).status).toBe('Failed');
    await setting('auto_reactivate', false);
    try {
      await landClose(elm.id, E[3], [keep, { id: elm.ids['EL 01'], name: 'EL 01', trailing: -5, pnl: 75 }]);
      expect(await row(elm.ids['EL 01'])).toMatchObject({ status: 'Failed', marked: true });
      expect((await openFlags(elm.ids['EL 01'], 'Failed account traded')).map((flag) => flag.message))
        .toEqual(['EL 01 is marked Failed but traded on 2026-10-08. Check it.']);
    } finally {
      await setting('auto_reactivate', true);
    }
    await refresh(elm.id);
    expect(await row(elm.ids['EL 01'])).toMatchObject({ status: 'Active', marked: false });
    expect((await flagsOf(elm.ids['EL 01'], 'Failed account traded'))[0])
      .toMatchObject({ status: 'Resolved', resolution_note: 'Account is no longer Failed.' });
  });

  it('auto_fail_on_breach off: the suspicion says so and nothing is failed; on again, the next refresh confirms it', async () => {
    const fir = await smallBook('Fir', ['FR 01', 'FR 02']);
    const keep = { id: fir.ids['FR 02'], name: 'FR 02', trailing: 900, pnl: 5 };
    await setting('auto_fail_on_breach', false);
    try {
      await landClose(fir.id, E[0], [keep, { id: fir.ids['FR 01'], name: 'FR 01', trailing: -5, pnl: -50 }]);
      await landClose(fir.id, E[1], [keep]);
      await landClose(fir.id, E[2], [keep]);
      expect(await row(fir.ids['FR 01'])).toMatchObject({ status: 'Active', observed_state: 'breached' });
      expect((await openFlags(fir.ids['FR 01'], 'Breach suspected')).map((flag) => flag.message))
        .toEqual(['FR 01 read -$5 on 2026-10-05, past its drawdown rule. It stays Active, and the CRM is not marking accounts Failed by itself right now, so check it with the prop firm.']);
    } finally {
      await setting('auto_fail_on_breach', true);
    }
    await refresh(fir.id);
    expect((await row(fir.ids['FR 01'])).status).toBe('Failed');
    expect((await flagsOf(fir.ids['FR 01'], 'Breach suspected'))[0].resolution_note).toBe('Breach confirmed: the close marked the account Failed.');
  });

  it('confirm_closes 1: one quiet close after the breach is enough', async () => {
    const cedar = await smallBook('Cedar', ['CD 01']);
    const ifsp = [{ family: 'IFSP' }];
    await landClose(cedar.id, E[0], [{ id: cedar.ids['CD 01'], name: 'CD 01', trailing: -5, pnl: -50, strategies: ifsp }]);
    await landClose(cedar.id, E[1], [{ id: cedar.ids['CD 01'], name: 'CD 01', trailing: -5, pnl: 0, strategies: ifsp }]);
    expect((await row(cedar.ids['CD 01'])).status).toBe('Active');
    await setting('confirm_closes', 1);
    try {
      await refresh(cedar.id);
    } finally {
      await setting('confirm_closes', 2);
    }
    expect((await row(cedar.ids['CD 01'])).status).toBe('Failed');
    expect((await auditsOf(cedar.ids['CD 01'], 'trading_account.auto_failed'))[0].after_data)
      .toMatchObject({ closes: ['2026-10-06'], confirmCloses: 1, confirmedBy: 'peers_traded' });
    // Five, not three: for Cedar, Maple Lane is another client, and MP 10 and
    // MP 21 traded IFSP on 2026-10-06 beside the three peer accounts.
    expect((await openFlags(cedar.ids['CD 01'], 'Marked Failed by the close'))[0].message)
      .toBe('CD 01 breached on 2026-10-05: trailing reading -$5, and on the last close (2026-10-06) it did not trade while IFSP traded on at least 5 accounts of other clients. Status was Active. Change the status on the account if the prop firm says otherwise.');
  });

  it('confirm_closes 3: two quiet closes are not enough, the third is, and the suspicion says three', async () => {
    const dogwood = await smallBook('Dogwood', ['DW 01']);
    const ifsp = [{ family: 'IFSP' }];
    const quiet = { id: dogwood.ids['DW 01'], name: 'DW 01', trailing: -5, pnl: 0, strategies: ifsp };
    await setting('confirm_closes', 3);
    try {
      await landClose(dogwood.id, E[0], [{ ...quiet, pnl: -50 }]);
      await landClose(dogwood.id, E[1], [quiet]);
      await landClose(dogwood.id, E[2], [quiet]);
      expect((await row(dogwood.ids['DW 01'])).status).toBe('Active');
      await landClose(dogwood.id, E[3], [quiet]);
    } finally {
      await setting('confirm_closes', 2);
    }
    expect((await row(dogwood.ids['DW 01'])).status).toBe('Failed');
    expect((await auditsOf(dogwood.ids['DW 01'], 'trading_account.auto_failed'))[0].after_data)
      .toMatchObject({ closes: ['2026-10-06', '2026-10-07', '2026-10-08'], confirmCloses: 3 });
    expect((await flagsOf(dogwood.ids['DW 01'], 'Breach suspected'))[0].message)
      .toContain('only if, for 3 closes in a row, it stops trading');
  });

  it('a breach read on a quiet close is not confirmed by that close alone: the window needs confirm_closes closes', async () => {
    const hazel = await smallBook('Hazel', ['HZ 01']);
    const ifsp = [{ family: 'IFSP' }];
    await landClose(hazel.id, E[0], [{ id: hazel.ids['HZ 01'], name: 'HZ 01', trailing: 300, pnl: 40, strategies: ifsp }]);
    // The reading goes negative on a day it made nothing, while IFSP traded on
    // other clients' accounts: one close on or after the breach, not two.
    await landClose(hazel.id, E[1], [{ id: hazel.ids['HZ 01'], name: 'HZ 01', trailing: -5, pnl: 0, strategies: ifsp }]);
    expect(await row(hazel.ids['HZ 01'])).toMatchObject({ status: 'Active', observed_state: 'breached', breached_on: '2026-10-06' });
    await landClose(hazel.id, E[2], [{ id: hazel.ids['HZ 01'], name: 'HZ 01', trailing: -5, pnl: 0, strategies: ifsp }]);
    expect((await row(hazel.ids['HZ 01'])).status).toBe('Failed');
    expect((await auditsOf(hazel.ids['HZ 01'], 'trading_account.auto_failed'))[0].after_data)
      .toMatchObject({ closes: ['2026-10-06', '2026-10-07'], lastTradedOn: '2026-10-06' });
  });

  it('a close with no account on it is not an absence', async () => {
    const gum = await smallBook('Gum', ['GM 01', 'GM 02']);
    const keep = { id: gum.ids['GM 02'], name: 'GM 02', trailing: 900, pnl: 5 };
    await landClose(gum.id, E[0], [keep, { id: gum.ids['GM 01'], name: 'GM 01', trailing: -5, pnl: -50 }]);
    await landClose(gum.id, E[1], []);
    await landClose(gum.id, E[2], [keep]);
    expect((await row(gum.ids['GM 01'])).status).toBe('Active');
    await landClose(gum.id, E[3], [keep]);
    expect((await row(gum.ids['GM 01'])).status).toBe('Failed');
  });

  it('the new settings are bounded by their CHECKs, and the defaults are 2, 3, true', async () => {
    for (const [statement, constraint] of [
      ['update public.account_observation_settings set confirm_closes = 0 where id', 'account_observation_settings_confirm_closes_check'],
      ['update public.account_observation_settings set confirm_closes = 11 where id', 'account_observation_settings_confirm_closes_check'],
      ['update public.account_observation_settings set confirm_peer_accounts = 0 where id', 'account_observation_settings_confirm_peer_accounts_check'],
      ['update public.account_observation_settings set confirm_peer_accounts = 51 where id', 'account_observation_settings_confirm_peer_accounts_check'],
    ]) {
      expect(await refusalAsRole(db, 'postgres', statement), statement).toMatch(new RegExp(constraint));
    }
    expect(await refusalAsRole(db, 'postgres', 'update public.account_observation_settings set confirm_closes = 10, confirm_peer_accounts = 50 where id')).toBeNull();
    expect((await db.query(`select column_name, column_default from information_schema.columns
      where table_name = 'account_observation_settings' and column_name in ('confirm_closes', 'confirm_peer_accounts', 'auto_reactivate')
      order by 1`)).rows).toEqual([
      { column_name: 'auto_reactivate', column_default: 'true' },
      { column_name: 'confirm_closes', column_default: '2' },
      { column_name: 'confirm_peer_accounts', column_default: '3' },
    ]);
  });

  it('the marker columns hold one fact: set together, a prior status that is a live one', async () => {
    expect(await refusalAsRole(db, 'postgres', 'update public.trading_accounts set auto_failed_at = now() where id = $1', { params: [world.acc.keepsTrading] }))
      .toMatch(/trading_accounts_auto_failed_marker_check/);
    expect(await refusalAsRole(db, 'postgres', "update public.trading_accounts set auto_failed_prior_status = 'Failed' where id = $1", { params: [world.acc.dead] }))
      .toMatch(/trading_accounts_auto_failed_prior_status_check/);
  });
});

/* ── Strategies still loaded ─────────────────────────────────────────────── */

describe('a Failed account with its strategies still loaded', () => {
  const NOTE_NONE = 'NinjaTrader shows no strategy enabled on the account.';

  it('a sample showing nothing enabled resolves the flag, through the trigger on the sample', async () => {
    await sample('MP 05', { strategies: 3, enabled: 0, minutes: 10 });
    const flags = await flagsOf(world.acc.frozen, 'Strategies still loaded');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ status: 'Resolved', resolved_by_user_id: null, resolution_note: NOTE_NONE });
  });

  it('the tracker\'s own ingest RPC loading them again raises a new one on the latest close', async () => {
    await db.query("update public.account_live_samples set reported_at = now() - interval '1 hour' where device_id = $1", [world.device]);
    const [result] = await asService('select public.record_account_live_sample($1, now(), $2::jsonb) as r', [
      world.device, JSON.stringify([{ accountName: 'MP 05', connected: true, strategyCount: 3, enabledStrategyCount: 1 }]),
    ]);
    expect(result.r).toMatchObject({ recorded: 1, throttled: false });
    const open = await openFlags(world.acc.frozen, 'Strategies still loaded');
    expect(open).toHaveLength(1);
    expect(open[0].close_date).toBe('2026-10-08');
  });

  it('one open flag per account: the next sample and the next close write nothing more', async () => {
    await sample('MP 05', { strategies: 3, enabled: 3, minutes: 30 });
    await refresh(world.clients.maple);
    expect(await openFlags(world.acc.frozen, 'Strategies still loaded')).toHaveLength(1);
  });

  it('a sample of an Active account, running, raises nothing', async () => {
    await sample('MP 10', { strategies: 2, enabled: 2 });
    expect(await flagsOf(world.acc.keepsTrading, 'Strategies still loaded')).toEqual([]);
  });

  it('resolved when the account is no longer Failed, and raised again when a person fails it again', async () => {
    await browserSave(world.acc.frozen, "status = 'Active'");
    await refresh(world.clients.maple);
    expect((await flagsOf(world.acc.frozen, 'Strategies still loaded')).at(-1))
      .toMatchObject({ status: 'Resolved', resolution_note: 'Account is no longer Failed.' });
    await browserSave(world.acc.frozen, "status = 'Failed'");
    await sample('MP 05', { strategies: 3, enabled: 2, minutes: 40 });
    expect(await openFlags(world.acc.frozen, 'Strategies still loaded')).toHaveLength(1);
  });

  it('a flag a CAM resolved is her answer: the next running sample does not raise it again', async () => {
    const [open] = await openFlags(world.acc.frozen, 'Strategies still loaded');
    await committed(world.gray.auth, "update public.operational_flags set status = 'Resolved', resolved_at = now() where id = $1", [open.id]);
    await sample('MP 05', { strategies: 3, enabled: 2, minutes: 50 });
    await refresh(world.clients.maple);
    expect(await openFlags(world.acc.frozen, 'Strategies still loaded')).toEqual([]);
  });

  it('the trigger takes the client lock with a try, so a sample never waits on a refresh', () => {
    expect(sql).toMatch(/if pg_try_advisory_xact_lock\(hashtext\(new\.client_id::text\)\) then/);
    expect(sql).toMatch(/set lock_timeout = '500ms'/);
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: the same as step 65\'s, and this file\'s own', () => {
  it('refresh_account_observations and failed_account_strategies_check: service_role and nobody else', async () => {
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
    expect(await executeGrantees(CHECK)).toEqual(['service_role']);
  });

  it('the helpers and trigger functions: nobody but the owner', async () => {
    for (const signature of OWNER_ONLY) expect(await executeGrantees(signature), signature).toEqual([]);
  });

  it('anon and authenticated are refused at the door', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select public.refresh_account_observations($1)',
        { subject: world.gray.auth, params: [world.clients.maple] })).toMatch(/permission denied for function refresh_account_observations/);
      expect(await refusalAsRole(db, role, 'select public.failed_account_strategies_check($1, null)',
        { subject: world.gray.auth, params: [world.clients.maple] })).toMatch(/permission denied for function failed_account_strategies_check/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select public.failed_account_strategies_check($1, null)', { params: [world.clients.maple] })).toBeNull();
  });

  it('the tables keep their grants: settings and samples SELECT only, accounts and flags the four verbs, anon nothing', async () => {
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'authenticated', 'account_live_samples')).toEqual(['SELECT']);
    expect((await privilegesOn(db, 'authenticated', 'trading_accounts')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect((await privilegesOn(db, 'authenticated', 'operational_flags')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    for (const table of ['account_observation_settings', 'account_live_samples', 'trading_accounts', 'operational_flags']) {
      expect(await privilegesOn(db, 'anon', table), table).toEqual([]);
    }
    expect(await refusalAsRole(db, 'authenticated', 'update public.account_observation_settings set auto_reactivate = false where id',
      { subject: world.gray.auth })).toMatch(DENIED);
  });

  it('drift installed on purpose is put back by running 71 again', async () => {
    await db.exec(`revoke execute on function ${REFRESH} from service_role;
                   grant execute on function ${REFRESH} to anon, authenticated;
                   grant execute on function ${CHECK} to anon;
                   grant execute on function public.auto_failed_flag_message(text, jsonb, numeric) to authenticated;`);
    await applyFileCollectingNotices(db, STEP);
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
    expect(await executeGrantees(CHECK)).toEqual(['service_role']);
    expect(await executeGrantees('public.auto_failed_flag_message(text, jsonb, numeric)')).toEqual([]);
  });
});

/* ── Running it again ────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('marks nothing, sets back nothing, fails nothing and writes no flag', async () => {
    const accounts = (await db.query(
      `select id, status, date_failed, observed_state, breached_on, auto_failed_at, auto_failed_through
         from public.trading_accounts order by id`)).rows;
    const flags = (await db.query('select id, type, status, message from public.operational_flags order by id')).rows;
    const audits = await one(db, "select count(*)::int from public.audit_logs where action like 'trading_account.auto%'");
    const notices = await applyFileCollectingNotices(db, STEP);
    const ours = notices.filter((notice) => notice.startsWith('step 71:'));
    expect(ours[0]).toBe("step 71: 0 account(s) the close had already marked Failed now carry its marker (0 with the prior status read from the audit row's after_data)");
    expect(ours[1]).toMatch(/^step 71: refreshed \d+ account\(s\) across \d+ client\(s\): 0 set back to their status before the close failed them, 0 marked Failed, 0 Breach suspected, 0 Failed account traded and 0 Strategies still loaded flag\(s\) written$/);
    expect(notices.filter((notice) => !notice.startsWith('step 71:'))
      .every((notice) => /already exists, skipping$/.test(notice))).toBe(true);
    expect((await db.query(
      `select id, status, date_failed, observed_state, breached_on, auto_failed_at, auto_failed_through
         from public.trading_accounts order by id`)).rows).toEqual(accounts);
    expect((await db.query('select id, type, status, message from public.operational_flags order by id')).rows).toEqual(flags);
    expect(await one(db, "select count(*)::int from public.audit_logs where action like 'trading_account.auto%'")).toBe(audits);
  });

  it('a first run said only that the constraints and the trigger were not there to drop, then what it did', () => {
    expect(world.notices.filter((notice) => !notice.startsWith('step 71:'))).toEqual([
      'constraint "account_observation_settings_confirm_closes_check" of relation "account_observation_settings" does not exist, skipping',
      'constraint "account_observation_settings_confirm_peer_accounts_check" of relation "account_observation_settings" does not exist, skipping',
      'constraint "trading_accounts_auto_failed_prior_status_check" of relation "trading_accounts" does not exist, skipping',
      'constraint "trading_accounts_auto_failed_marker_check" of relation "trading_accounts" does not exist, skipping',
      'trigger "account_live_samples_failed_strategies" for relation "public.account_live_samples" does not exist, skipping',
    ]);
  });
});

/* ── The browser's list of the database's flag types ─────────────────────── */

describe('the flag types the database writes are the ones the browser names', () => {
  it('every type a close wrote here is in src/domain/databaseFlagTypes.js, and every one there is written by a step', async () => {
    const written = await column(db, `select distinct type from public.operational_flags
      where type in ('Marked Failed by the close', 'Breach suspected', 'Reactivated by the close', 'Failed account traded', 'Strategies still loaded')
      order by 1`);
    expect(written).toEqual(Object.values(DATABASE_FLAG_TYPES).sort());
    for (const type of Object.values(DATABASE_FLAG_TYPES)) expect(sql, type).toContain(`'${type}'`);
  });
});

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 67, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 66 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 71 needs step 67 \(refresh_account_observations, live_account_flag_types, operational_flags\.resolution_note, account_observation_settings\.resolve_flags_on_fail\): run it first/);
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_name = 'trading_accounts' and column_name like 'auto_failed%'`)).toBe(0);
      expect(await one(early, `select to_regprocedure('${CHECK}') is null`)).toBe(true);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 71 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 71)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(71);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 70, in the run order after 70, and says how to turn the auto fail back on', () => {
    expect(runbook).toMatch(/^\| 71 \| `step_71_confirmed_failure\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 71 | `step_71_confirmed_failure.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 70 | `step_70_agent_update_requests.sql`'));
    expect(runbook).toMatch(/→ 68 → 69 → 70 → 71(?: →|\.)/);
    const row71 = runbook.split('\n').find((line) => line.startsWith('| 71 |'));
    expect(row71).toContain('update public.account_observation_settings set auto_fail_on_breach = true, updated_at = now() where id;');
    expect(row71).toContain('recomputes every client');
    for (const name of ['confirm_closes', 'confirm_peer_accounts', 'auto_reactivate', 'failed_account_strategies_check']) expect(row71).toContain(name);
  });
});
