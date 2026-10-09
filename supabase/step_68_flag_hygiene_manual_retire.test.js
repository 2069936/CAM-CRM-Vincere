/* STEP 68, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 67, fictional books are seeded in
 * the shapes production holds after 67 (Open flags of the five live account
 * types on accounts a person already marked Inactive or Reserve, on an account
 * typed Inactive / Ignore, on an account the closes only call absent, on a live
 * one, on a Payout Hold one, on a Failed one, a flag naming no account, the
 * kept types, a flag a CAM resolved weeks ago), and then 68 runs the way Pedro
 * runs it: once, with the one time resolve. After that every verdict is the
 * database's own: what the flags say, what the audit log says, and what a CAM's
 * status save does AS THE ROLE the browser saves it with, under row level
 * security, in every transition the trigger has to tell apart.
 *
 * Nothing here asserts the text of the SQL except the lines that read the
 * directory listing and the runbook, which have no other witness.
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

const STEP = 'step_68_flag_hygiene_manual_retire.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const DENIED = /permission denied/i;

const FIVE = [
  'Missing account',
  'Strategy disabled',
  'Expected strategy missing',
  'Drawdown approaching limit',
  'Drawdown near limit',
];
// What a retired account carries that is NOT one of the five, and must survive.
const KEPT = ['Drawdown breached', 'Marked Failed by the close', 'Unassigned account', 'New account', 'Evaluation target reached'];

const BACKLOG_NOTE = 'Account already Inactive or Reserve when step 68 ran.';
const CLOSE_NOTE = 'Account marked Failed by the close.';
const TYPE_NOTE = 'Account set to Inactive or Ignore in the CRM.';
const crmNote = (status) => `Account marked ${status} in the CRM.`;
const RETIRE = 'trading_account.flags_resolved_on_retire';
const ON_FAIL = 'trading_account.flags_resolved_on_fail';
const BACKLOG = 'flags.backlog_resolved_on_retired_accounts';
const DASH = /[‒-―−]| - /;

const TRIGGER_FN = 'public.trading_accounts_retire_resolves_flags()';
// Step 67's, called by this file and restated by it.
const HELPERS = ['public.live_account_flag_types()', 'public.account_is_past_live_flags(text, text, text)'];
const FORGED = { forgedByHand: true };

let db;
const world = { k: {}, l: {}, m: {}, c: {} };

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

/**
 * The browser's status save (supabaseStore.updateSupabaseTradingAccount): one
 * PATCH of the fields the CAM changed plus updated_at, read back with
 * `.select().single()`, as the signed in CAM.
 */
async function crmSave(subject, accountId, set, params = []) {
  return committed(subject,
    `update public.trading_accounts set ${set}, updated_at = now() where id = $1 returning id, status, account_type`,
    [accountId, ...params]);
}

function shiftDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function flagsOfAccount(accountId) {
  return (await db.query(
    `select id, type, status, message, resolution_note, resolved_by_user_id,
            resolved_at is not null as resolved,
            to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as resolved_at
       from public.operational_flags where trading_account_id = $1 order by type, message`, [accountId])).rows;
}

async function openTypes(accountId) {
  return column(db, `select type from public.operational_flags
    where trading_account_id = $1 and status = 'Open' order by type, message`, [accountId]);
}

async function openFiveIds(accountId) {
  return column(db, `select id from public.operational_flags
    where trading_account_id = $1 and status = 'Open' and type = any ($2::text[]) order by id`, [accountId, FIVE]);
}

async function auditRows(action, entityId) {
  const rows = (await db.query(
    'select user_id, entity_type, entity_id, after_data from public.audit_logs where action = $1 order by created_at, id',
    [action])).rows;
  return entityId === undefined ? rows : rows.filter((row) => row.entity_id === entityId);
}

async function executeGrantees(signature) {
  const roles = await column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
  return roles.filter((role) => role !== 'postgres');
}

async function setting(column_, value) {
  await db.query(`update public.account_observation_settings set ${column_} = $1, updated_at = now() where id`, [value]);
}

async function seedFlag({ close, client, account, type, message, status = 'Open', resolvedAt = null }) {
  return one(db,
    `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status, resolved_at)
     values ($1, $2, $3, $4, 'Warning', $5, $6, $7) returning id`,
    [close, client, account, type, message, status, resolvedAt]);
}

async function snapshot(closeId, accountId, accountName, trailing) {
  await db.query(
    `insert into public.account_snapshots (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, account_balance)
     values ($1, $2, $3, $4, 50000)
     on conflict (daily_import_id, account_name) do update set trailing_max_drawdown = excluded.trailing_max_drawdown`,
    [closeId, accountId, accountName, trailing]);
}

async function accountRow(accountId) {
  return (await db.query('select status, account_type, observed_state from public.trading_accounts where id = $1', [accountId])).rows[0];
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 67 }));

  async function authUser(email) {
    return one(db, 'insert into auth.users (email) values ($1) returning id', [email]);
  }
  async function cam(name) {
    const profile = await one(db, 'insert into public.cam_profiles (name) values ($1) returning id', [name]);
    const auth = await authUser(`${name.toLowerCase()}@example.com`);
    const appUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id, cam_profile_id)
      values ($1, $1, $2, 'CAM', 'Active', $3, $4) returning id`, [name.toLowerCase(), `${name.toLowerCase()}@example.com`, auth, profile]);
    return { profile, auth, appUser };
  }
  async function clientOf(owner, name) {
    const id = await one(db, 'insert into public.clients (name) values ($1) returning id', [name]);
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [id, owner.profile]);
    return id;
  }
  async function account(clientId, name, { type = 'Funded', status = 'Active' } = {}) {
    return one(db,
      `insert into public.trading_accounts (client_id, account_name, account_type, status)
       values ($1, $2, $3, $4) returning id`,
      [clientId, name, type, status]);
  }
  async function close(clientId, day) {
    return one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [clientId, day]);
  }
  world.account = account;
  world.close = close;
  world.clientOf = clientOf;

  world.today = await one(db, "select (now() at time zone 'UTC')::date::text");
  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  world.managerAppUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [world.managerAuth]);

  /* ── The backlog, seeded BEFORE 68 exists ────────────────────────────── */
  // Every flag is written while its account is alive, as production wrote
  // them: step 67's insert guard would drop an Open flag of the five on an
  // account already retired. Then a person retires the account, which before
  // 68 left the flags Open.
  const K = world.k;
  K.client = await clientOf(world.gray, 'Client K');
  K.first = await close(K.client, shiftDays(world.today, -12));
  K.live = await account(K.client, 'K 01');
  K.inactive = await account(K.client, 'K 02');
  K.reserve = await account(K.client, 'K 03');
  K.ignore = await account(K.client, 'K 04');
  K.absent = await account(K.client, 'K 05');
  K.failed = await account(K.client, 'K 06');
  K.hold = await account(K.client, 'K 07', { status: 'Payout Hold' });
  await snapshot(K.first, K.absent, 'K 05', 2000);
  const seed = (accountId, type, message, extra = {}) => seedFlag({ close: K.first, client: K.client, account: accountId, type, message, ...extra });
  for (const type of FIVE) await seed(K.live, type, `K 01 ${type}.`);
  await seed(K.inactive, 'Missing account', 'K 02 existed before but did not appear in this close.');
  await seed(K.inactive, 'Missing account', 'K 02 existed before but did not appear in this close, again.');
  for (const type of FIVE.slice(1)) await seed(K.inactive, type, `K 02 ${type}.`);
  for (const type of KEPT) await seed(K.inactive, type, `K 02 ${type}.`);
  K.oldResolved = await seed(K.inactive, 'Missing account', 'K 02 resolved by a CAM weeks ago.', {
    status: 'Resolved', resolvedAt: '2026-09-01T12:00:00Z',
  });
  await seed(K.reserve, 'Strategy disabled', 'K 03 has RBO disabled.');
  await seed(K.reserve, 'Strategy disabled', 'K 03 has IFSP disabled.');
  await seed(K.reserve, 'Drawdown near limit', 'K 03 near.');
  await seed(K.ignore, 'Expected strategy missing', 'K 04 ran nothing.');
  await seed(K.ignore, 'Drawdown approaching limit', 'K 04 approaching.');
  await seed(K.absent, 'Missing account', 'K 05 existed before but did not appear in this close.');
  await seed(K.failed, 'Missing account', 'K 06 existed before but did not appear in this close.');
  await seed(K.hold, 'Drawdown near limit', 'K 07 near.');
  K.orphan = await seed(null, 'Missing account', 'A flag that names no account.');
  // Five more closes without K 05: the closes now call it absent, and nothing
  // else about it changed. Absence is not death.
  for (let n = 1; n <= 5; n += 1) await close(K.client, shiftDays(world.today, n - 12));
  await db.query("update public.trading_accounts set status = 'Inactive' where id = $1", [K.inactive]);
  await db.query("update public.trading_accounts set status = 'Reserve' where id = $1", [K.reserve]);
  await db.query("update public.trading_accounts set account_type = 'Inactive / Ignore' where id = $1", [K.ignore]);
  // Failed by a person after 67 ran: 67's to resolve, not this file's.
  await db.query("update public.trading_accounts set status = 'Failed' where id = $1", [K.failed]);

  const L = world.l;
  L.client = await clientOf(world.birch, 'Client L');
  L.close = await close(L.client, shiftDays(world.today, -3));
  L.reserve = await account(L.client, 'L 01');
  L.both = await account(L.client, 'L 02');
  await seedFlag({ close: L.close, client: L.client, account: L.reserve, type: 'Missing account', message: 'L 01 missing.' });
  await seedFlag({ close: L.close, client: L.client, account: L.reserve, type: 'Drawdown near limit', message: 'L 01 near.' });
  await seedFlag({ close: L.close, client: L.client, account: L.both, type: 'Strategy disabled', message: 'L 02 has RBO disabled.' });
  await db.query("update public.trading_accounts set status = 'Reserve' where id = $1", [L.reserve]);
  // Inactive AND typed Inactive / Ignore: one account, its flag counted once.
  await db.query("update public.trading_accounts set status = 'Inactive', account_type = 'Inactive / Ignore' where id = $1", [L.both]);

  // A CAM writes the backlog's audit row by hand before 68 exists. Row level
  // security lets her; the backlog must not take it for its own.
  world.forged = await committed(world.gray.auth,
    `insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
     values (null, 'operational_flags', null, '${BACKLOG}', $1::jsonb)
     returning id`, [JSON.stringify(FORGED)]);

  world.before = {
    trigger: await one(db, "select count(*)::int from pg_trigger where tgname = 'trading_accounts_retire_resolves_flags'"),
    open: await one(db, `select count(*)::int from public.operational_flags f
      join public.trading_accounts t on t.id = f.trading_account_id
      where (t.status in ('Inactive', 'Reserve') or t.account_type = 'Inactive / Ignore')
        and f.status = 'Open' and f.type = any ($1::text[])`, [FIVE]),
  };
  world.notices = await applyFileCollectingNotices(db, STEP);
  world.backlogAt = await one(db, `select to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
    from public.operational_flags where resolution_note = $1 limit 1`, [BACKLOG_NOTE]);
  world.markerAt = await one(db, `select to_char(retired_flag_backlog_resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
    from public.account_observation_settings where id`);
}, 180_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 67, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 66 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 68 needs step 67 \(live_account_flag_types, account_is_past_live_flags, operational_flags\.resolution_note, account_observation_settings\.resolve_flags_on_fail\): run it first/);
      expect(await one(early, `select to_regprocedure('${TRIGGER_FN}') is null`)).toBe(true);
      expect(await one(early, "select count(*)::int from pg_trigger where tgname = 'trading_accounts_retire_resolves_flags'")).toBe(0);
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'account_observation_settings'
          and column_name = 'retired_flag_backlog_resolved_at'`)).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── The one time resolve ────────────────────────────────────────────────── */

describe('the backlog: Open flags of the five on accounts already Inactive, Reserve or Inactive / Ignore, resolved once', () => {
  it('before 68 there was no trigger, and fourteen such flags across two CAMs', () => {
    expect(world.before.trigger).toBe(0);
    expect(world.before.open).toBe(14);
  });

  it('the fixture, read from the database: every state the rule has to tell apart', async () => {
    const rows = (await db.query(`select account_name, status, account_type, observed_state
      from public.trading_accounts where client_id = $1 order by account_name`, [world.k.client])).rows;
    expect(rows.map((row) => [row.account_name, row.status, row.account_type, row.observed_state])).toEqual([
      ['K 01', 'Active', 'Funded', 'never_seen'],
      ['K 02', 'Inactive', 'Funded', 'never_seen'],
      ['K 03', 'Reserve', 'Funded', 'never_seen'],
      ['K 04', 'Active', 'Inactive / Ignore', 'never_seen'],
      ['K 05', 'Active', 'Funded', 'absent'],
      ['K 06', 'Failed', 'Funded', 'never_seen'],
      ['K 07', 'Payout Hold', 'Funded', 'never_seen'],
    ]);
  });

  it('says how many per type in one NOTICE', () => {
    expect(world.notices.filter((notice) => notice.startsWith('step 68:'))).toEqual([
      'step 68: resolved 14 open flag(s) on 5 Inactive, Reserve or Inactive / Ignore account(s): Missing account 3, Strategy disabled 4, Expected strategy missing 2, Drawdown approaching limit 2, Drawdown near limit 3',
    ]);
  });

  it('resolves exactly the five on those accounts, with the backlog note, no person, one moment, and the message as it was', async () => {
    const accounts = [world.k.inactive, world.k.reserve, world.k.ignore, world.l.reserve, world.l.both];
    const rows = [];
    for (const id of accounts) rows.push(...await flagsOfAccount(id));
    const five = rows.filter((row) => FIVE.includes(row.type) && row.id !== world.k.oldResolved);
    expect(five).toHaveLength(14);
    for (const row of five) {
      expect(row, row.message).toMatchObject({
        status: 'Resolved', resolved: true, resolved_by_user_id: null, resolution_note: BACKLOG_NOTE,
      });
      expect(row.message).toMatch(/^(K|L) 0[1-4] /);
    }
    expect(new Set(five.map((row) => row.resolved_at))).toEqual(new Set([world.backlogAt]));
  });

  it('leaves the kept types Open on a retired account', async () => {
    expect(await openTypes(world.k.inactive)).toEqual([...KEPT].sort());
  });

  it('leaves a flag a CAM resolved weeks ago exactly as it was', async () => {
    const row = (await flagsOfAccount(world.k.inactive)).find((flag) => flag.id === world.k.oldResolved);
    expect(row).toMatchObject({ status: 'Resolved', resolution_note: null });
    expect(row.resolved_at).toMatch(/^2026-09-01 12:00:00/);
  });

  it('touches no account that is alive by its status and type: live, Payout Hold, and the one the closes only call absent', async () => {
    expect(await openTypes(world.k.live)).toEqual([...FIVE].sort());
    expect(await openTypes(world.k.hold)).toEqual(['Drawdown near limit']);
    expect(await openTypes(world.k.absent)).toEqual(['Missing account']);
  });

  it('leaves a Failed account to step 67, and a flag naming no account alone', async () => {
    expect(await openTypes(world.k.failed)).toEqual(['Missing account']);
    expect(await one(db, 'select status from public.operational_flags where id = $1', [world.k.orphan])).toBe('Open');
  });

  it('writes ONE summary audit row with the counts per type and no person', async () => {
    expect((await auditRows(BACKLOG)).filter((row) => !row.after_data.forgedByHand)).toEqual([{
      user_id: null,
      entity_type: 'operational_flags',
      entity_id: null,
      after_data: {
        total: 14,
        accounts: 5,
        types: {
          'Missing account': 3,
          'Strategy disabled': 4,
          'Expected strategy missing': 2,
          'Drawdown approaching limit': 2,
          'Drawdown near limit': 3,
        },
        note: BACKLOG_NOTE,
        resolvedAt: expect.any(String),
        rule: 'Open flags of the five live account types on accounts whose status was Inactive or Reserve, or whose type was Inactive / Ignore, when step 68 ran.',
      },
    }]);
  });

  it('a backlog audit row a CAM wrote by hand before 68 ran does not stop it: the guard is the settings marker', async () => {
    expect(world.forged).toHaveLength(1);
    expect((await auditRows(BACKLOG)).filter((row) => row.after_data.forgedByHand))
      .toEqual([{ user_id: null, entity_type: 'operational_flags', entity_id: null, after_data: FORGED }]);
    expect(world.markerAt).toBe(world.backlogAt);
  });

  it('a CAM reads the marker and cannot write it', async () => {
    expect(await refusalAsRole(db, 'authenticated',
      'update public.account_observation_settings set retired_flag_backlog_resolved_at = null where id', { subject: world.gray.auth }))
      .toMatch(DENIED);
    expect(await one(db, 'select retired_flag_backlog_resolved_at is not null from public.account_observation_settings')).toBe(true);
  });

  it('is addressable afterwards by its note, which is how the header undoes it', async () => {
    expect(await one(db, 'select count(*)::int from public.operational_flags where resolution_note = $1', [BACKLOG_NOTE])).toBe(14);
  });
});

/* ── The CRM's own transition ────────────────────────────────────────────── */

describe('a CAM retiring an account in the CRM resolves its five, and nothing else', () => {
  /** A fresh account on client M with the five and the kept types Open. */
  async function retiring(name, { status = 'Active', type = 'Funded', five = FIVE, kept = KEPT } = {}) {
    const id = await world.account(world.m.client, name, { status, type });
    for (const t of five) await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: t, message: `${name} ${t}.` });
    for (const t of kept) await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: t, message: `${name} ${t}.` });
    return id;
  }

  async function expectRetired(accountId, { name, note, by, previousStatus, newStatus, previousAccountType = 'Funded', accountType = 'Funded', ids }) {
    const five = (await flagsOfAccount(accountId)).filter((flag) => FIVE.includes(flag.type));
    expect(five).toHaveLength(5);
    for (const flag of five) {
      expect(flag, flag.type).toMatchObject({
        status: 'Resolved', resolved: true, resolved_by_user_id: by, resolution_note: note, message: `${name} ${flag.type}.`,
      });
    }
    expect(new Set(five.map((flag) => flag.resolved_at)).size).toBe(1);
    expect(await openTypes(accountId)).toEqual([...KEPT].sort());
    expect(await auditRows(RETIRE, accountId)).toEqual([{
      user_id: by,
      entity_type: 'trading_account',
      entity_id: accountId,
      after_data: {
        clientId: world.m.client,
        accountName: name,
        previousStatus,
        newStatus,
        previousAccountType,
        accountType,
        count: 5,
        types: Object.fromEntries(FIVE.map((type) => [type, 1])),
        flagIds: ids,
        note,
      },
    }]);
  }

  beforeAll(async () => {
    world.m.client = await world.clientOf(world.gray, 'Client M');
    world.m.close = await world.close(world.m.client, shiftDays(world.today, -2));
    world.m.bystander = await retiring('M 00');
  });

  it('Active to Failed: the browser\'s save lands under row level security, and the five are hers', async () => {
    const id = await retiring('M 01');
    const ids = await openFiveIds(id);
    const saved = await crmSave(world.gray.auth, id, "status = 'Failed', date_failed = $2", [world.today]);
    expect(saved).toEqual([{ id, status: 'Failed', account_type: 'Funded' }]);
    await expectRetired(id, {
      name: 'M 01', note: crmNote('Failed'), by: world.gray.appUser, previousStatus: 'Active', newStatus: 'Failed', ids,
    });
  });

  it('Active to Inactive', async () => {
    const id = await retiring('M 02');
    const ids = await openFiveIds(id);
    expect(await crmSave(world.gray.auth, id, "status = 'Inactive'")).toHaveLength(1);
    await expectRetired(id, {
      name: 'M 02', note: crmNote('Inactive'), by: world.gray.appUser, previousStatus: 'Active', newStatus: 'Inactive', ids,
    });
  });

  it('Active to Reserve', async () => {
    const id = await retiring('M 03');
    const ids = await openFiveIds(id);
    expect(await crmSave(world.gray.auth, id, "status = 'Reserve'")).toHaveLength(1);
    await expectRetired(id, {
      name: 'M 03', note: crmNote('Reserve'), by: world.gray.appUser, previousStatus: 'Active', newStatus: 'Reserve', ids,
    });
  });

  it('the type to Inactive / Ignore, the status left Active', async () => {
    const id = await retiring('M 04');
    const ids = await openFiveIds(id);
    expect(await crmSave(world.gray.auth, id, "account_type = 'Inactive / Ignore'"))
      .toEqual([{ id, status: 'Active', account_type: 'Inactive / Ignore' }]);
    await expectRetired(id, {
      name: 'M 04', note: TYPE_NOTE, by: world.gray.appUser, previousStatus: 'Active', newStatus: 'Active',
      accountType: 'Inactive / Ignore', ids,
    });
  });

  it('Payout Hold to Failed', async () => {
    const id = await retiring('M 05', { status: 'Payout Hold' });
    const ids = await openFiveIds(id);
    expect(await crmSave(world.gray.auth, id, "status = 'Failed'")).toHaveLength(1);
    await expectRetired(id, {
      name: 'M 05', note: crmNote('Failed'), by: world.gray.appUser, previousStatus: 'Payout Hold', newStatus: 'Failed', ids,
    });
  });

  it('an account the closes only call absent is alive until a person says otherwise: marking it Inactive resolves', async () => {
    // K 05 is the backlog's absent account, still Active, its Missing account
    // still Open. Absence is not death, so the CAM's word is the transition.
    expect(await accountRow(world.k.absent)).toEqual({ status: 'Active', account_type: 'Funded', observed_state: 'absent' });
    const ids = await openFiveIds(world.k.absent);
    expect(ids).toHaveLength(1);
    expect(await crmSave(world.gray.auth, world.k.absent, "status = 'Inactive'")).toHaveLength(1);
    expect((await flagsOfAccount(world.k.absent)).map((flag) => [flag.status, flag.resolution_note, flag.resolved_by_user_id]))
      .toEqual([['Resolved', crmNote('Inactive'), world.gray.appUser]]);
    expect((await auditRows(RETIRE, world.k.absent)).map((row) => row.after_data))
      .toEqual([expect.objectContaining({ previousStatus: 'Active', newStatus: 'Inactive', count: 1, flagIds: ids })]);
  });

  it('a Manager\'s save names the Manager; the SQL editor (nobody signed in) names nobody', async () => {
    const byManager = await retiring('M 06');
    await crmSave(world.managerAuth, byManager, "status = 'Inactive'");
    expect(new Set((await flagsOfAccount(byManager)).filter((flag) => FIVE.includes(flag.type)).map((flag) => flag.resolved_by_user_id)))
      .toEqual(new Set([world.managerAppUser]));
    expect((await auditRows(RETIRE, byManager)).map((row) => row.user_id)).toEqual([world.managerAppUser]);

    const byEditor = await retiring('M 07');
    await db.query("update public.trading_accounts set status = 'Reserve', updated_at = now() where id = $1", [byEditor]);
    const five = (await flagsOfAccount(byEditor)).filter((flag) => FIVE.includes(flag.type));
    expect(five.map((flag) => [flag.status, flag.resolution_note, flag.resolved_by_user_id]))
      .toEqual(FIVE.map(() => ['Resolved', crmNote('Reserve'), null]));
    expect((await auditRows(RETIRE, byEditor)).map((row) => row.user_id)).toEqual([null]);
  });

  it('another CAM cannot save the account at all, so nothing is resolved', async () => {
    const id = await retiring('M 08');
    expect(await crmSave(world.birch.auth, id, "status = 'Failed'")).toEqual([]);
    expect(await accountRow(id)).toMatchObject({ status: 'Active' });
    expect(await openTypes(id)).toEqual([...FIVE, ...KEPT].sort());
    expect(await auditRows(RETIRE, id)).toEqual([]);
  });

  it('never touches another account\'s flags', async () => {
    expect(await openTypes(world.m.bystander)).toEqual([...FIVE, ...KEPT].sort());
    expect(await auditRows(RETIRE, world.m.bystander)).toEqual([]);
  });

  it('a flag a CAM already closed keeps her resolve: its time, its person, no note', async () => {
    const id = await retiring('M 09', { five: [] });
    const closed = await seedFlag({
      close: world.m.close, client: world.m.client, account: id, type: 'Strategy disabled', message: 'M 09 closed by a CAM.',
      status: 'Resolved', resolvedAt: '2026-09-03T09:00:00Z',
    });
    await crmSave(world.gray.auth, id, "status = 'Inactive'");
    const row = (await flagsOfAccount(id)).find((flag) => flag.id === closed);
    expect(row).toMatchObject({ status: 'Resolved', resolution_note: null, resolved_by_user_id: null });
    expect(row.resolved_at).toMatch(/^2026-09-03 09:00:00/);
    // Nothing of the five was Open: the kept types stay, and no audit row says
    // a resolve happened that did not.
    expect(await openTypes(id)).toEqual([...KEPT].sort());
    expect(await auditRows(RETIRE, id)).toEqual([]);
  });
});

describe('what is not a retirement', () => {
  async function withFive(name, opts = {}) {
    const id = await world.account(world.m.client, name, opts);
    for (const t of FIVE) await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: t, message: `${name} ${t}.` });
    return id;
  }

  it('with resolve_flags_on_fail off the status is saved and the flags stay Open, with no audit row', async () => {
    const id = await withFive('N 01');
    await setting('resolve_flags_on_fail', false);
    try {
      expect(await crmSave(world.gray.auth, id, "status = 'Inactive'")).toEqual([{ id, status: 'Inactive', account_type: 'Funded' }]);
      expect(await openTypes(id)).toEqual([...FIVE].sort());
      expect(await auditRows(RETIRE, id)).toEqual([]);
    } finally {
      await setting('resolve_flags_on_fail', true);
    }
  });

  it('a revive does nothing; the account alive again earns flags, and retiring it again resolves only those', async () => {
    const id = await withFive('N 02');
    await crmSave(world.gray.auth, id, "status = 'Failed'");
    const resolvedBefore = await flagsOfAccount(id);
    expect(await auditRows(RETIRE, id)).toHaveLength(1);

    expect(await crmSave(world.gray.auth, id, "status = 'Active', date_failed = null")).toHaveLength(1);
    expect(await flagsOfAccount(id)).toEqual(resolvedBefore);
    expect(await auditRows(RETIRE, id)).toHaveLength(1);

    const fresh = await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: 'Missing account', message: 'N 02 missing after the revive.' });
    expect(await openTypes(id)).toEqual(['Missing account']);
    await crmSave(world.gray.auth, id, "status = 'Reserve'");
    expect(await openTypes(id)).toEqual([]);
    const audits = await auditRows(RETIRE, id);
    expect(audits).toHaveLength(2);
    expect(audits[1].after_data).toMatchObject({ previousStatus: 'Active', newStatus: 'Reserve', count: 1, flagIds: [fresh] });
  });

  it('from one dead status to another is not a transition: a flag a CAM reopened on a Failed account stays her decision', async () => {
    const id = await withFive('N 03');
    await crmSave(world.gray.auth, id, "status = 'Failed'");
    const reopened = await one(db, "select id from public.operational_flags where trading_account_id = $1 and type = 'Strategy disabled'", [id]);
    await committed(world.gray.auth, "update public.operational_flags set status = 'Open', resolved_at = null, resolved_by_user_id = null where id = $1", [reopened]);
    await crmSave(world.gray.auth, id, "status = 'Inactive'");
    await crmSave(world.gray.auth, id, "account_type = 'Inactive / Ignore'");
    expect((await db.query('select status, resolution_note from public.operational_flags where id = $1', [reopened])).rows)
      .toEqual([{ status: 'Open', resolution_note: null }]);
    expect(await auditRows(RETIRE, id)).toHaveLength(1);
  });

  it('a save that does not change the status or the type, or changes another column, does nothing', async () => {
    const id = await withFive('N 04');
    await crmSave(world.gray.auth, id, "status = 'Active', account_type = 'Funded'");
    await crmSave(world.gray.auth, id, "notes = 'called the trader'");
    expect(await openTypes(id)).toEqual([...FIVE].sort());
    expect(await auditRows(RETIRE, id)).toEqual([]);
  });

  it('a close that makes an account absent resolves nothing: absence is not death', async () => {
    const client = await world.clientOf(world.gray, 'Client P');
    const id = await world.account(client, 'P 01');
    const first = await world.close(client, shiftDays(world.today, -20));
    await snapshot(first, id, 'P 01', 2000);
    await seedFlag({ close: first, client, account: id, type: 'Strategy disabled', message: 'P 01 has RBO disabled.' });
    for (let n = 1; n <= 5; n += 1) await world.close(client, shiftDays(world.today, n - 20));
    expect(await accountRow(id)).toEqual({ status: 'Active', account_type: 'Funded', observed_state: 'absent' });
    expect(await openTypes(id)).toEqual(['Strategy disabled']);
    expect(await auditRows(RETIRE, id)).toEqual([]);
  });

  it('step 65\'s guard still refuses a CAM writing the observation, and the status save beside it still lands', async () => {
    const id = await withFive('N 05');
    expect(await refusalAsRole(db, 'authenticated',
      "update public.trading_accounts set status = 'Inactive', observed_state = 'absent' where id = $1",
      { subject: world.gray.auth, params: [id] }))
      .toMatch(/written by the close \(refresh_account_observations\), not by the browser/);
    expect(await openTypes(id)).toEqual([...FIVE].sort());
    expect(await auditRows(RETIRE, id)).toEqual([]);
    expect(await crmSave(world.gray.auth, id, "status = 'Inactive'")).toHaveLength(1);
    expect(await openTypes(id)).toEqual([]);
  });
});

/* ── The close and the CRM in one transaction ─────────────────────────────── */

describe('the close path and this trigger in one transaction write one resolve, never two', () => {
  beforeAll(async () => {
    const C = world.c;
    C.client = await world.clientOf(world.gray, 'Client C');
    C.byClose = await world.account(C.client, 'C 01');
    C.byCam = await world.account(C.client, 'C 02');
    C.first = await world.close(C.client, shiftDays(world.today, -2));
    await snapshot(C.first, C.byClose, 'C 01', 500);
    await snapshot(C.first, C.byCam, 'C 02', 500);
    for (const [id, name] of [[C.byClose, 'C 01'], [C.byCam, 'C 02']]) {
      for (const type of [...FIVE, ...KEPT]) await seedFlag({ close: C.first, client: C.client, account: id, type, message: `${name} ${type}.` });
    }
    C.closeIds = await openFiveIds(C.byClose);
    C.camIds = await openFiveIds(C.byCam);
    C.second = await world.close(C.client, shiftDays(world.today, -1));
  });

  it('the close fails the account first: the refresh resolves with its own note and row, this trigger adds nothing', async () => {
    const C = world.c;
    // One statement, autocommitted: step 65's deferred refresh runs at its
    // commit, marks the account Failed (this trigger fires on that update) and
    // then resolves the five as step 67 does.
    await snapshot(C.second, C.byClose, 'C 01', -10);
    expect(await accountRow(C.byClose)).toEqual({ status: 'Failed', account_type: 'Funded', observed_state: 'breached' });
    const five = (await flagsOfAccount(C.byClose)).filter((flag) => FIVE.includes(flag.type));
    expect(five.map((flag) => [flag.status, flag.resolution_note])).toEqual(FIVE.map(() => ['Resolved', CLOSE_NOTE]));
    expect(await auditRows(ON_FAIL, C.byClose)).toEqual([expect.objectContaining({ after_data: expect.objectContaining({ count: 5, flagIds: C.closeIds }) })]);
    expect(await auditRows(RETIRE, C.byClose)).toEqual([]);
  });

  it('and the CAM saving Failed again on that account afterwards changes nothing', async () => {
    await crmSave(world.gray.auth, world.c.byClose, "status = 'Failed', date_failed = $2", [world.today]);
    expect(await auditRows(RETIRE, world.c.byClose)).toEqual([]);
    expect(await auditRows(ON_FAIL, world.c.byClose)).toHaveLength(1);
  });

  it('the CAM fails the account first, in the transaction that carries the breaching close: hers is the one resolve', async () => {
    const C = world.c;
    await db.exec('begin');
    try {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', world.gray.auth]);
      await db.exec('set local role authenticated');
      await db.query(
        `insert into public.account_snapshots (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, account_balance)
         values ($1, $2, 'C 02', -10, 49000)`, [C.second, C.byCam]);
      await db.query("update public.trading_accounts set status = 'Failed', updated_at = now() where id = $1", [C.byCam]);
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
    // The refresh ran at that commit: it reads the breach, finds the account
    // already Failed, and so neither fails it nor resolves anything.
    expect(await accountRow(C.byCam)).toEqual({ status: 'Failed', account_type: 'Funded', observed_state: 'breached' });
    const five = (await flagsOfAccount(C.byCam)).filter((flag) => FIVE.includes(flag.type));
    expect(five.map((flag) => [flag.status, flag.resolution_note, flag.resolved_by_user_id]))
      .toEqual(FIVE.map(() => ['Resolved', crmNote('Failed'), world.gray.appUser]));
    expect((await auditRows(RETIRE, C.byCam)).map((row) => row.after_data.flagIds)).toEqual([C.camIds]);
    expect(await auditRows(ON_FAIL, C.byCam)).toEqual([]);
    expect(await auditRows('trading_account.auto_failed', C.byCam)).toEqual([]);
    expect(await openTypes(C.byCam)).toEqual([...KEPT].sort());
  });
});

/* ── A fault never refuses the save ──────────────────────────────────────── */

describe('a fault in the resolve never refuses the CAM\'s status save', () => {
  it('the status lands, the flags stay Open, no half resolve is left, and a WARNING names the account', async () => {
    const id = await world.account(world.m.client, 'F 01');
    for (const t of FIVE) await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: t, message: `F 01 ${t}.` });
    const notices = [];
    let saved;
    await db.exec('begin');
    try {
      // Every audit insert fails in this transaction, after the flags update.
      await db.exec('alter table public.audit_logs add constraint step68_test_boom check (false) not valid');
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', world.gray.auth]);
      await db.exec('set local role authenticated');
      saved = (await db.query(
        "update public.trading_accounts set status = 'Inactive', updated_at = now() where id = $1 returning status",
        [id], { onNotice: (notice) => notices.push(`${notice.severity}: ${notice.message}`) })).rows;
      await db.exec('reset role');
      expect(await one(db, 'select status from public.trading_accounts where id = $1', [id])).toBe('Inactive');
      expect(await openTypes(id)).toEqual([...FIVE].sort());
      expect(await one(db, 'select count(*)::int from public.operational_flags where trading_account_id = $1 and resolution_note is not null', [id])).toBe(0);
    } finally {
      await db.exec('rollback');
    }
    expect(saved).toEqual([{ status: 'Inactive' }]);
    expect(notices.filter((n) => n.startsWith('WARNING: step 68:'))).toHaveLength(1);
    expect(notices[0]).toContain(id);
    expect(notices[0]).toContain('step68_test_boom');
  });
});

/* ── The words ───────────────────────────────────────────────────────────── */

describe('the words this file writes', () => {
  it('no note, NOTICE or audit text uses a dash as punctuation', async () => {
    const texts = [
      BACKLOG_NOTE, TYPE_NOTE, ...['Failed', 'Inactive', 'Reserve'].map(crmNote), ...world.notices,
      ...(await column(db, `select after_data::text from public.audit_logs
        where action in ('${BACKLOG}', '${RETIRE}') and not (after_data ? 'forgedByHand')`)),
      ...(await column(db, 'select distinct resolution_note from public.operational_flags where resolution_note is not null')),
    ];
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) expect(text, text).not.toMatch(DASH);
    expect(await column(db, 'select distinct resolution_note from public.operational_flags where resolution_note is not null order by 1'))
      .toEqual([CLOSE_NOTE, BACKLOG_NOTE, TYPE_NOTE, ...['Failed', 'Inactive', 'Reserve'].map(crmNote)].sort());
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: exact, and this file\'s own', () => {
  it('the trigger function and the two helpers it calls: nobody but the owner', async () => {
    for (const signature of [TRIGGER_FN, ...HELPERS]) expect(await executeGrantees(signature), signature).toEqual([]);
  });

  it('a CAM cannot call the trigger function at the door', async () => {
    expect(await refusalAsRole(db, 'authenticated', `select ${TRIGGER_FN.replace('()', '')}()`, { subject: world.gray.auth }))
      .toMatch(/permission denied for function trading_accounts_retire_resolves_flags/);
  });

  it('the trigger function is security definer with search_path pinned, and fires after an update of status or type, per row', async () => {
    expect((await db.query(`select prosecdef, proconfig from pg_proc where oid = '${TRIGGER_FN}'::regprocedure`)).rows[0])
      .toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] });
    expect(await column(db, `select pg_get_triggerdef(oid) from pg_trigger
      where tgrelid = 'public.trading_accounts'::regclass and tgname = 'trading_accounts_retire_resolves_flags'`))
      .toEqual([expect.stringMatching(/AFTER UPDATE OF status, account_type ON public\.trading_accounts FOR EACH ROW WHEN .* EXECUTE FUNCTION (?:public\.)?trading_accounts_retire_resolves_flags\(\)$/)]);
  });

  it('the three tables keep their verbs: four for authenticated on accounts and flags, SELECT on the settings, nothing for anon', async () => {
    for (const table of ['trading_accounts', 'operational_flags']) {
      expect((await privilegesOn(db, 'authenticated', table)).sort(), table).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(await privilegesOn(db, 'anon', table), table).toEqual([]);
    }
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'account_observation_settings')).toEqual([]);
  });

  it('the grants are the file\'s own: drift installed on purpose, 68 puts it back', async () => {
    await db.exec(`grant execute on function ${TRIGGER_FN} to anon, authenticated, service_role;
                   grant execute on function public.account_is_past_live_flags(text, text, text) to authenticated;
                   grant truncate on public.trading_accounts to authenticated;
                   grant update on public.account_observation_settings to authenticated;`);
    expect(await executeGrantees(TRIGGER_FN)).toEqual(['anon', 'authenticated', 'service_role']);
    await applyFileCollectingNotices(db, STEP);
    for (const signature of [TRIGGER_FN, ...HELPERS]) expect(await executeGrantees(signature), signature).toEqual([]);
    expect((await privilegesOn(db, 'authenticated', 'trading_accounts')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
  });
});

/* ── Running it again, and 67 again under it ─────────────────────────────── */

describe('running it again', () => {
  it('resolves nothing, writes no second summary, keeps the marker, and says so', async () => {
    // A flag a CAM reopens on a retired account after 68 ran is her decision;
    // the backlog is once and does not take it back.
    const reopened = await one(db, `select id from public.operational_flags
      where trading_account_id = $1 and resolution_note = $2 limit 1`, [world.k.inactive, BACKLOG_NOTE]);
    await committed(world.gray.auth, "update public.operational_flags set status = 'Open', resolved_at = null where id = $1", [reopened]);
    const flags = (await db.query('select id, status, resolution_note, resolved_at from public.operational_flags order by id')).rows;
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((notice) => notice.startsWith('step 68:'))).toEqual([
      'step 68: the flags on Inactive and Reserve accounts were already resolved by an earlier run, so nothing was resolved this time',
    ]);
    expect((await db.query('select id, status, resolution_note, resolved_at from public.operational_flags order by id')).rows).toEqual(flags);
    expect(await one(db, 'select status from public.operational_flags where id = $1', [reopened])).toBe('Open');
    expect((await auditRows(BACKLOG)).filter((row) => !row.after_data.forgedByHand)).toHaveLength(1);
    expect(await one(db, `select to_char(retired_flag_backlog_resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
      from public.account_observation_settings where id`)).toBe(world.markerAt);
    expect(await one(db, "select count(*)::int from pg_trigger where tgname = 'trading_accounts_retire_resolves_flags'")).toBe(1);
  });

  it('a re-run of 67 keeps this trigger, and the next CRM retirement still resolves', async () => {
    await applyFileCollectingNotices(db, 'step_67_flag_hygiene.sql');
    expect(await one(db, "select count(*)::int from pg_trigger where tgname = 'trading_accounts_retire_resolves_flags'")).toBe(1);
    const id = await world.account(world.m.client, 'R 01');
    await seedFlag({ close: world.m.close, client: world.m.client, account: id, type: 'Missing account', message: 'R 01 missing.' });
    await crmSave(world.gray.auth, id, "status = 'Reserve'");
    expect(await openTypes(id)).toEqual([]);
    expect(await auditRows(RETIRE, id)).toHaveLength(1);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 68 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 68)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(68);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 67, in the run order after 67, and says what it resolves and how to switch it off', () => {
    expect(runbook).toMatch(/^\| 68 \| `step_68_flag_hygiene_manual_retire\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 68 | `step_68_flag_hygiene_manual_retire.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 67 | `step_67_flag_hygiene.sql`'));
    expect(runbook).toMatch(/→ 64 → 65 → 66 → 67 → 68(?: →|\.)/);
    expect(runbook).toContain('68 resolves flags when a person retires an account');
    expect(runbook).toContain('set resolve_flags_on_fail = false');
    expect(runbook).toContain(BACKLOG_NOTE);
  });
});
