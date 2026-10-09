/* STEP 67, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 66, fictional books are seeded
 * in the shapes production holds (Open flags of the five live account types on
 * a live account, on Failed accounts of two CAMs, on an Inactive and a Reserve
 * account, a flag naming no account, the other five types a Failed account
 * carries, a flag a CAM resolved weeks ago), and then 67 runs the way Pedro
 * runs it: once, with the one time resolve. After that every verdict is the
 * database's own: what the flags say, what the audit log says, what a CAM reads
 * AS THE ROLE she reads it with, and what the generator writes when the real
 * persist RPC and the real reconcile run against accounts in every dead state.
 *
 * Nothing here asserts the text of the SQL except the advisory lock (a single
 * connection cannot race two refreshes) and the lines that read the directory
 * listing and the runbook, which have no other witness.
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
import {
  LIVE_ACCOUNT_FLAG_TYPES,
  accountIsPastLiveFlags,
  closeReadingBreach,
  observedStateInClose,
  reconcileDailyImport,
} from '../src/domain/reconcile.js';
import { createAutoImportStore } from '../server/apiLib/autoImportStore.js';
import { LOGIN_COLUMNS, accountMetaFromRow, closeFlagsFromRows } from '../src/domain/supabaseStore.js';
import { buildCamFlagQueue } from '../src/domain/camFlagQueue.js';

const STEP = 'step_67_flag_hygiene.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const DENIED = /permission denied/i;

const FIVE = [
  'Missing account',
  'Strategy disabled',
  'Expected strategy missing',
  'Drawdown approaching limit',
  'Drawdown near limit',
];
// What a Failed account carries that is NOT one of the five, and must survive.
const KEPT = ['Drawdown breached', 'Marked Failed by the close', 'Unassigned account', 'New account', 'Evaluation target reached'];

const CLOSE_NOTE = 'Account marked Failed by the close.';
const BACKLOG_NOTE = 'Account already Failed when step 67 ran.';
const DASH = /[‒-―−]| - /;

const REFRESH = 'public.refresh_account_observations(uuid)';
const HELPERS = [
  'public.live_account_flag_types()',
  'public.account_is_past_live_flags(text, text, text)',
  'public.account_observation_in_close(text, boolean, boolean)',
  'public.operational_flags_live_account_guard()',
];
// Security INVOKER on purpose, like step 65's observed columns guard: it reads
// current_user to tell the browser from the database.
const NOTE_GUARD = 'public.operational_flags_resolution_note_guard()';
// What a signed in CAM could write before 67 ran, to fool a guard that read the
// audit log: the backlog's own action, by hand.
const FORGED = { forgedByHand: true };

let db;
const world = { a: {}, b: {}, g: {}, gCloses: [], t: {}, tCloses: {} };

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

function shiftDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function flagsOfAccount(accountId) {
  return (await db.query(
    `select id, type, status, message, resolution_note, resolved_by_user_id,
            resolved_at is not null as resolved,
            to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as resolved_at
       from public.operational_flags where trading_account_id = $1 order by type, message`, [accountId])).rows;
}

async function openTypes(accountId) {
  return column(db, `select type from public.operational_flags
    where trading_account_id = $1 and status = 'Open' order by type, message`, [accountId]);
}

async function auditRows(action) {
  return (await db.query(
    'select user_id, entity_type, entity_id, after_data from public.audit_logs where action = $1 order by created_at, id',
    [action])).rows;
}

async function executeGrantees(signature) {
  const roles = await column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
  return roles.filter((role) => role !== 'postgres');
}

async function functionDefinition(signature) {
  return one(db, `select pg_get_functiondef('${signature}'::regprocedure)`);
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

/** The automatic close's persist, called the way v3 reaches it: as its owner. */
async function persist(clientId, deviceId, importResult, { onNotice } = {}) {
  const batch = await one(db,
    `insert into public.ingest_batches (capture_id, device_id, client_id, trading_date, captured_at, schema_version, storage_path, content_sha256, byte_count)
     values (gen_random_uuid(), $1, $2, $3, clock_timestamp(), 1, 'test/' || gen_random_uuid()::text, 'sha', 10) returning id`,
    [deviceId, clientId, importResult.date]);
  const result = await db.query('select (public.persist_auto_daily_import($1, $2, $3::jsonb)).id as id',
    [clientId, batch, JSON.stringify(importResult)], onNotice ? { onNotice } : undefined);
  return result.rows[0].id;
}

/** server/apiLib/autoImportStore.js reading trading_accounts out of this cluster. */
function storeOverCluster() {
  return createAutoImportStore({
    from(table) {
      return {
        select() {
          return {
            async eq(name, value) {
              const rows = (await db.query(`select * from public.${table} where ${name} = $1 order by account_name`, [value])).rows;
              return { data: rows, error: null };
            },
          };
        },
      };
    },
  });
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 66 }));

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
  async function account(clientId, name, { type = 'Funded', status = 'Active', limit = null } = {}) {
    return one(db,
      `insert into public.trading_accounts (client_id, account_name, account_type, status, max_drawdown_limit)
       values ($1, $2, $3, $4, $5) returning id`,
      [clientId, name, type, status, limit]);
  }
  async function close(clientId, day) {
    return one(db, 'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [clientId, day]);
  }
  world.account = account;
  world.close = close;
  world.clientOf = clientOf;

  // The UTC day, because resolved_at reaches the browser as an ISO string in
  // UTC and the queue reads its first ten characters.
  world.today = await one(db, "select (now() at time zone 'UTC')::date::text");
  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [world.managerAuth]);

  /* ── The backlog, seeded BEFORE 67 exists ────────────────────────────── */
  const A = world.a;
  A.client = await clientOf(world.gray, 'Client A');
  A.day = shiftDays(world.today, -3);
  A.close = await close(A.client, A.day);
  A.live = await account(A.client, 'A 01');
  A.failed = await account(A.client, 'A 02', { status: 'Failed' });
  A.inactive = await account(A.client, 'A 03', { status: 'Inactive' });
  A.reserve = await account(A.client, 'A 04', { status: 'Reserve' });
  const seed = (accountId, type, message, extra = {}) => seedFlag({ close: A.close, client: A.client, account: accountId, type, message, ...extra });
  for (const type of FIVE) await seed(A.live, type, `A 01 ${type}.`);
  await seed(A.failed, 'Missing account', 'A 02 existed before but did not appear in this close.');
  await seed(A.failed, 'Missing account', 'A 02 existed before but did not appear in this close, again.');
  for (const type of FIVE.slice(1)) await seed(A.failed, type, `A 02 ${type}.`);
  for (const type of KEPT) await seed(A.failed, type, `A 02 ${type}.`);
  A.oldResolved = await seed(A.failed, 'Missing account', 'A 02 resolved by a CAM weeks ago.', {
    status: 'Resolved', resolvedAt: '2026-09-01T12:00:00Z',
  });
  await seed(A.inactive, 'Missing account', 'A 03 existed before but did not appear in this close.');
  await seed(A.reserve, 'Strategy disabled', 'A 04 has a strategy disabled.');
  A.orphan = await seed(null, 'Missing account', 'A flag that names no account.');

  const B = world.b;
  B.client = await clientOf(world.birch, 'Client B');
  B.close = await close(B.client, A.day);
  B.failed = await account(B.client, 'B 01', { status: 'Failed' });
  for (const message of ['B 01 has RBO disabled.', 'B 01 has IFSP disabled.']) {
    await seedFlag({ close: B.close, client: B.client, account: B.failed, type: 'Strategy disabled', message });
  }
  await seedFlag({ close: B.close, client: B.client, account: B.failed, type: 'Drawdown near limit', message: 'B 01 near.' });

  // A CAM writes the backlog's audit row by hand before 67 exists. RLS lets
  // her; the backlog must not take it for its own.
  world.forged = await committed(world.gray.auth,
    `insert into public.audit_logs (user_id, entity_type, entity_id, action, after_data)
     values (null, 'operational_flags', null, 'flags.backlog_resolved_on_failed_accounts', $1::jsonb)
     returning id`, [JSON.stringify(FORGED)]);

  world.before = {
    column: await column(db, `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'operational_flags' and column_name = 'resolution_note'`),
    openOnFailed: await one(db, `select count(*)::int from public.operational_flags f
      join public.trading_accounts t on t.id = f.trading_account_id
      where t.status = 'Failed' and f.status = 'Open' and f.type = any ($1::text[])`, [FIVE]),
  };
  world.notices = await applyFileCollectingNotices(db, STEP);
  world.backlogAt = await one(db, `select to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    from public.operational_flags where resolution_note = $1 limit 1`, [BACKLOG_NOTE]);
  world.markerAt = await one(db, `select to_char(flag_backlog_resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    from public.account_observation_settings where id`);
  world.definition = await functionDefinition(REFRESH);
}, 180_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 65, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 64 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 67 needs step 65 \(refresh_account_observations, account_observation_settings, trading_accounts\.observed_state\): run it first/);
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'operational_flags' and column_name = 'resolution_note'`)).toBe(0);
      expect(await one(early, "select to_regprocedure('public.live_account_flag_types()') is null")).toBe(true);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── The one time resolve ────────────────────────────────────────────────── */

describe('the backlog: Open flags of the five on Failed accounts, resolved once', () => {
  it('before 67 there was no note column, and nine such flags across two CAMs', () => {
    expect(world.before.column).toEqual([]);
    expect(world.before.openOnFailed).toBe(9);
  });

  it('says how many per type in one NOTICE', () => {
    expect(world.notices.filter((notice) => notice.startsWith('step 67:'))).toEqual([
      'step 67: resolved 9 open flag(s) on 2 Failed account(s): Missing account 2, Strategy disabled 3, Expected strategy missing 1, Drawdown approaching limit 1, Drawdown near limit 2',
    ]);
  });

  it('resolves exactly the five on the Failed accounts, with the backlog note, no person, and the message as it was', async () => {
    const rows = [...await flagsOfAccount(world.a.failed), ...await flagsOfAccount(world.b.failed)]
      .filter((row) => FIVE.includes(row.type) && row.id !== world.a.oldResolved);
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row, row.message).toMatchObject({
        status: 'Resolved', resolved: true, resolved_by_user_id: null, resolution_note: BACKLOG_NOTE,
      });
      expect(row.message).toMatch(/^(A|B) 0[12] /);
    }
    expect(new Set(rows.map((row) => row.resolved_at))).toEqual(new Set([world.backlogAt]));
  });

  it('leaves the other five types on a Failed account Open', async () => {
    expect(await openTypes(world.a.failed)).toEqual([...KEPT].sort());
  });

  it('leaves a flag a CAM resolved weeks ago exactly as it was', async () => {
    const row = (await flagsOfAccount(world.a.failed)).find((flag) => flag.id === world.a.oldResolved);
    expect(row).toMatchObject({ status: 'Resolved', resolution_note: null });
    expect(row.resolved_at).toMatch(/^2026-09-01 12:00:00/);
  });

  it('touches no account that is not Failed: live, Inactive, Reserve, and a flag naming no account', async () => {
    expect(await openTypes(world.a.live)).toEqual([...FIVE].sort());
    expect(await openTypes(world.a.inactive)).toEqual(['Missing account']);
    expect(await openTypes(world.a.reserve)).toEqual(['Strategy disabled']);
    expect(await one(db, 'select status from public.operational_flags where id = $1', [world.a.orphan])).toBe('Open');
  });

  it('a backlog audit row a CAM wrote by hand before 67 ran does not stop it: the guard is the settings marker', async () => {
    expect(world.forged).toHaveLength(1);
    expect((await auditRows('flags.backlog_resolved_on_failed_accounts')).filter((row) => row.after_data.forgedByHand))
      .toEqual([{ user_id: null, entity_type: 'operational_flags', entity_id: null, after_data: FORGED }]);
    expect(world.markerAt).toBe(world.backlogAt);
  });

  it('a CAM reads the marker and cannot write it', async () => {
    expect(await refusalAsRole(db, 'authenticated',
      'update public.account_observation_settings set flag_backlog_resolved_at = null where id', { subject: world.gray.auth }))
      .toMatch(DENIED);
    expect(await one(db, 'select flag_backlog_resolved_at is not null from public.account_observation_settings')).toBe(true);
  });

  it('writes ONE summary audit row with the counts per type and no person', async () => {
    expect((await auditRows('flags.backlog_resolved_on_failed_accounts')).filter((row) => !row.after_data.forgedByHand)).toEqual([{
      user_id: null,
      entity_type: 'operational_flags',
      entity_id: null,
      after_data: {
        total: 9,
        accounts: 2,
        types: {
          'Missing account': 2,
          'Strategy disabled': 3,
          'Expected strategy missing': 1,
          'Drawdown approaching limit': 1,
          'Drawdown near limit': 2,
        },
        note: BACKLOG_NOTE,
        resolvedAt: expect.any(String),
        rule: 'Open flags of the five live account types on accounts whose status was Failed when step 67 ran.',
      },
    }]);
  });

  it('is addressable afterwards by its note, which is how the header undoes it', async () => {
    expect(await one(db, 'select count(*)::int from public.operational_flags where resolution_note = $1', [BACKLOG_NOTE])).toBe(9);
  });

  it('a second run resolves nothing, writes no second summary, and says so', async () => {
    // A flag that became eligible after the first run: Open on a live account,
    // and then a person marks the account Failed. The backlog is once.
    const late = await world.account(world.a.client, 'A 05');
    const lateFlag = await seedFlag({ close: world.a.close, client: world.a.client, account: late, type: 'Missing account', message: 'A 05 late.' });
    await db.query("update public.trading_accounts set status = 'Failed' where id = $1", [late]);
    const resolvedBefore = await one(db, "select count(*)::int from public.operational_flags where status = 'Resolved'");
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((notice) => notice.startsWith('step 67:'))).toEqual([
      'step 67: the flags on Failed accounts were already resolved by an earlier run, so nothing was resolved this time',
    ]);
    expect(await one(db, "select count(*)::int from public.operational_flags where status = 'Resolved'")).toBe(resolvedBefore);
    expect(await one(db, 'select status from public.operational_flags where id = $1', [lateFlag])).toBe('Open');
    expect((await auditRows('flags.backlog_resolved_on_failed_accounts')).filter((row) => !row.after_data.forgedByHand)).toHaveLength(1);
    expect(await one(db, `select to_char(flag_backlog_resolved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      from public.account_observation_settings where id`)).toBe(world.markerAt);
  });

});

/* ── The generator, at the database ──────────────────────────────────────── */

describe('a dead account does not get the five, whoever inserts them', () => {
  beforeAll(async () => {
    const G = world.g;
    G.client = await world.clientOf(world.gray, 'Client G');
    G.live = await world.account(G.client, 'G 01');
    G.never = await world.account(G.client, 'G 02');
    G.hold = await world.account(G.client, 'G 03', { status: 'Payout Hold' });
    G.failed = await world.account(G.client, 'G 04', { status: 'Failed' });
    G.inactive = await world.account(G.client, 'G 05', { status: 'Inactive' });
    G.reserve = await world.account(G.client, 'G 06', { status: 'Reserve' });
    G.ignore = await world.account(G.client, 'G 07', { type: 'Inactive / Ignore' });
    G.breached = await world.account(G.client, 'G 08');
    G.absent = await world.account(G.client, 'G 09');
    // Six closes so G 09 is absent for real (seen once, then missing five),
    // and a breach observed on G 08 while the auto fail is off, so it reads
    // Active and breached: the stale tab shape step 65's header names.
    await setting('auto_fail_on_breach', false);
    for (let n = 0; n < 6; n += 1) {
      const id = await world.close(G.client, shiftDays(world.today, n - 12));
      world.gCloses.push(id);
      await snapshot(id, G.live, 'G 01', 2000);
      await snapshot(id, G.hold, 'G 03', 2000);
      await snapshot(id, G.breached, 'G 08', n === 5 ? -10 : 500);
      if (n === 0) await snapshot(id, G.absent, 'G 09', 2000);
    }
    await setting('auto_fail_on_breach', true);
    G.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [G.client]);
  });

  const DEAD_KEYS = ['failed', 'inactive', 'reserve', 'ignore', 'breached', 'absent'];
  const LIVE_KEYS = ['live', 'never', 'hold'];

  it('the fixture holds every state the rule names, read from the database', async () => {
    const rows = (await db.query(`select account_name, status, account_type, observed_state
      from public.trading_accounts where client_id = $1 order by account_name`, [world.g.client])).rows;
    expect(rows.map((row) => [row.account_name, row.status, row.observed_state])).toEqual([
      ['G 01', 'Active', 'seen'],
      ['G 02', 'Active', 'never_seen'],
      ['G 03', 'Payout Hold', 'seen'],
      ['G 04', 'Failed', 'never_seen'],
      ['G 05', 'Inactive', 'never_seen'],
      ['G 06', 'Reserve', 'never_seen'],
      ['G 07', 'Active', 'never_seen'],
      ['G 08', 'Active', 'breached'],
      ['G 09', 'Active', 'absent'],
    ]);
  });

  it('the list and the rule are the same in SQL and in reconcile.js, account by account', async () => {
    expect(await one(db, 'select public.live_account_flag_types()')).toEqual([...LIVE_ACCOUNT_FLAG_TYPES]);
    const registry = await storeOverCluster().loadRegistry(world.g.client);
    const rows = (await db.query(`select account_name,
        public.account_is_past_live_flags(status, account_type, observed_state) as past
      from public.trading_accounts where client_id = $1 order by account_name`, [world.g.client])).rows;
    for (const row of rows) {
      expect(accountIsPastLiveFlags(registry[row.account_name]), row.account_name).toBe(row.past);
    }
    expect(rows.filter((row) => row.past).map((row) => row.account_name)).toEqual(['G 04', 'G 05', 'G 06', 'G 07', 'G 08', 'G 09']);
  });

  it('a CAM inserting Open flags of the five: none lands on a dead account, all land on a live one', async () => {
    await committed(world.gray.auth,
      `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status)
       select $1, $2, t.id, k.type, 'Warning', 'cam ' || t.account_name || ' ' || k.type, 'Open'
         from public.trading_accounts as t, unnest($3::text[]) as k(type)
        where t.client_id = $2`,
      [world.gCloses[5], world.g.client, FIVE]);
    for (const key of DEAD_KEYS) {
      expect(await openTypes(world.g[key]), key).toEqual([]);
    }
    for (const key of LIVE_KEYS) {
      expect(await openTypes(world.g[key]), key).toEqual([...FIVE].sort());
    }
  });

  it('Drawdown breached and the other types still land on every dead account', async () => {
    await committed(world.gray.auth,
      `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status)
       select $1, $2, t.id, k.type, 'Critical', 'cam ' || t.account_name || ' ' || k.type, 'Open'
         from public.trading_accounts as t, unnest(array['Drawdown breached', 'Unexpected strategy active']) as k(type)
        where t.client_id = $2 and t.account_name in ('G 04', 'G 05', 'G 06', 'G 07', 'G 08', 'G 09')`,
      [world.gCloses[5], world.g.client]);
    for (const key of DEAD_KEYS) {
      expect(await openTypes(world.g[key]), key).toEqual(['Drawdown breached', 'Unexpected strategy active']);
    }
  });

  it('a flag of the five inserted already Resolved (Recalculate carrying a CAM\'s triage) is history and lands', async () => {
    await committed(world.gray.auth,
      `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status, resolved_at)
       values ($1, $2, $3, 'Strategy disabled', 'Warning', 'triaged before the account failed', 'Resolved', now())`,
      [world.gCloses[5], world.g.client, world.g.failed]);
    expect((await flagsOfAccount(world.g.failed)).filter((flag) => flag.type === 'Strategy disabled'))
      .toEqual([expect.objectContaining({ status: 'Resolved', resolution_note: null })]);
  });

  it('the real persist RPC with a payload that still carries the five (an old build): only the live accounts keep them', async () => {
    const names = ['G 01', 'G 02', 'G 03', 'G 04', 'G 05', 'G 06', 'G 07', 'G 08', 'G 09'];
    const flags = names.flatMap((name) => [
      ...FIVE.map((type) => ({ type, severity: 'Warning', accountName: name, message: `rpc ${name} ${type}` })),
      { type: 'Drawdown breached', severity: 'Critical', accountName: name, message: `rpc ${name} breached` },
    ]);
    const closeId = await persist(world.g.client, world.g.device, {
      date: shiftDays(world.today, -5), status: 'Needs review', accounts: {}, snapshots: [], flags,
    });
    const stored = (await db.query(`select t.account_name, f.type from public.operational_flags as f
      join public.trading_accounts as t on t.id = f.trading_account_id
      where f.daily_import_id = $1 order by 1, 2`, [closeId])).rows;
    const byAccount = (name) => stored.filter((row) => row.account_name === name).map((row) => row.type);
    for (const name of ['G 01', 'G 02', 'G 03']) {
      expect(byAccount(name), name).toEqual(['Drawdown breached', ...[...FIVE].sort()].sort());
    }
    for (const name of ['G 04', 'G 05', 'G 06', 'G 07', 'G 08', 'G 09']) {
      expect(byAccount(name), name).toEqual(['Drawdown breached']);
    }
  });

  it('end to end: the registry the ingest reads, reconcile, the persist RPC; the five only where the account is alive', async () => {
    // The close the agent would send: three accounts reported, six missing.
    // G 01 is live with a near limit buffer and a strategy that did not run;
    // G 04 (Failed) and G 08 (Active, still reading breached) report exactly
    // the same. G 08's reading here is clear: the refresh will call it seen at
    // this commit, so on this close it is alive and keeps the three. G 04 is
    // dead by its status, whatever it reads.
    const { registry } = await storeOverCluster().loadRegistryForIngest(world.g.client);
    const reported = ['G 01', 'G 04', 'G 08'];
    const importResult = reconcileDailyImport({
      clientId: world.g.client,
      date: shiftDays(world.today, -4),
      registry,
      parsed: {
        accounts: reported.map((accountName) => ({
          accountName, connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0, trailingMaxDrawdown: 300,
        })),
        strategies: reported.map((accountName) => ({ accountName, strategyName: '1 - IFSP', enabled: false })),
        orders: [],
        executions: [],
      },
    });
    const generated = importResult.flags.map((flag) => `${flag.accountName}|${flag.type}`).sort();
    const alive = [
      'G 01|Drawdown near limit',
      'G 01|Expected strategy missing',
      'G 01|Strategy disabled',
      'G 02|Missing account',
      'G 03|Missing account',
      'G 08|Drawdown near limit',
      'G 08|Expected strategy missing',
      'G 08|Strategy disabled',
    ];
    expect(generated.filter((key) => FIVE.some((type) => key.endsWith(`|${type}`)))).toEqual(alive);
    const closeId = await persist(world.g.client, world.g.device, importResult);
    const stored = (await db.query(`select t.account_name || '|' || f.type as key from public.operational_flags as f
      join public.trading_accounts as t on t.id = f.trading_account_id
      where f.daily_import_id = $1 and f.type = any ($2::text[]) order by 1`, [closeId, FIVE])).rows.map((row) => row.key);
    expect(stored).toEqual(alive);
    expect((await db.query('select status, observed_state from public.trading_accounts where id = $1', [world.g.breached])).rows)
      .toEqual([{ status: 'Active', observed_state: 'seen' }]);
  });
});

/* ── Read as of the close ─────────────────────────────────────────────────── */

describe('an account that comes back is alive on the close it comes back in', () => {
  const REPORTED = { connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0 };
  const near = (accountName) => ({ accountName, ...REPORTED, trailingMaxDrawdown: 300 });
  const idle = (accountName) => ({ accountName, strategyName: '1 - IFSP', enabled: false });
  const fiveOf = (flags) => flags
    .filter((flag) => FIVE.includes(flag.type))
    .map((flag) => `${flag.accountName}|${flag.type}`)
    .sort();
  const THREE = (name) => [`${name}|Drawdown near limit`, `${name}|Expected strategy missing`, `${name}|Strategy disabled`];

  async function storedFive(closeId) {
    return column(db, `select t.account_name || '|' || f.type from public.operational_flags as f
      join public.trading_accounts as t on t.id = f.trading_account_id
      where f.daily_import_id = $1 and f.type = any ($2::text[]) order by 1`, [closeId, FIVE]);
  }

  async function observed(clientId) {
    return (await db.query(`select account_name, status, observed_state, closes_missed
      from public.trading_accounts where client_id = $1 order by account_name`, [clientId])).rows
      .map((row) => [row.account_name, row.status, row.observed_state, row.closes_missed]);
  }

  /** Six closes: the first one seen, every one seen, and a breach on the last with the auto fail off. */
  async function sixCloses(clientId, ids, { firstOnly, every, breachLast = [] }) {
    await setting('auto_fail_on_breach', false);
    try {
      for (let n = 0; n < 6; n += 1) {
        const id = await world.close(clientId, shiftDays(world.today, n - 20));
        for (const name of firstOnly) if (n === 0) await snapshot(id, ids[name], name, 2000);
        for (const name of every) await snapshot(id, ids[name], name, 2000);
        for (const name of breachLast) await snapshot(id, ids[name], name, n === 5 ? -10 : 500);
      }
    } finally {
      await setting('auto_fail_on_breach', true);
    }
  }

  beforeAll(async () => {
    const RET = {};
    world.ret = RET;
    RET.client = await world.clientOf(world.gray, 'Client RET');
    RET.ids = {};
    for (const name of ['RET 01', 'RET 02', 'RET 03', 'RET 04']) RET.ids[name] = await world.account(RET.client, name);
    // RET 01 and RET 03 seen once then missing five closes (absent); RET 02
    // seen on every close; RET 04 on every close, breached on the last one
    // while the auto fail was off (Active, reading breached).
    await sixCloses(RET.client, RET.ids, { firstOnly: ['RET 01', 'RET 03'], every: ['RET 02'], breachLast: ['RET 04'] });
    RET.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [RET.client]);

    const MAN = {};
    world.man = MAN;
    MAN.client = await world.clientOf(world.gray, 'Client MAN');
    MAN.ids = {};
    for (const name of ['MAN 01', 'MAN 02']) MAN.ids[name] = await world.account(MAN.client, name);
    await sixCloses(MAN.client, MAN.ids, { firstOnly: ['MAN 01'], every: ['MAN 02'] });
  });

  it('the fixture, read from the database: two absent, one seen, one Active and still breached', async () => {
    expect(await observed(world.ret.client)).toEqual([
      ['RET 01', 'Active', 'absent', 5],
      ['RET 02', 'Active', 'seen', 0],
      ['RET 03', 'Active', 'absent', 5],
      ['RET 04', 'Active', 'breached', 0],
    ]);
    expect(await observed(world.man.client)).toEqual([
      ['MAN 01', 'Active', 'absent', 5],
      ['MAN 02', 'Active', 'seen', 0],
    ]);
  });

  it('the automatic route: the registry the ingest reads, reconcile and the persist RPC give the returning account what the steady one gets', async () => {
    // RET 01 comes back, RET 02 never left, both 300 from the edge with IFSP
    // switched off and nothing run. RET 03 is still missing. RET 04 reports
    // no drawdown at all (0 is not a measurement), so its stored breach stands.
    const RET = world.ret;
    const { registry } = await storeOverCluster().loadRegistryForIngest(RET.client);
    expect(['RET 01', 'RET 03'].map((name) => registry[name].observedState)).toEqual(['absent', 'absent']);
    const importResult = reconcileDailyImport({
      clientId: RET.client,
      date: shiftDays(world.today, -14),
      registry,
      parsed: {
        accounts: [near('RET 01'), near('RET 02'), { accountName: 'RET 04', ...REPORTED, trailingMaxDrawdown: 0 }],
        strategies: [idle('RET 01'), idle('RET 02'), idle('RET 04')],
        orders: [],
        executions: [],
      },
    });
    const severities = Object.fromEntries(importResult.flags
      .filter((flag) => flag.accountName === 'RET 01' && FIVE.includes(flag.type))
      .map((flag) => [flag.type, flag.severity]));
    expect(severities).toEqual({ 'Drawdown near limit': 'Critical', 'Expected strategy missing': 'Critical', 'Strategy disabled': 'Warning' });
    expect(fiveOf(importResult.flags)).toEqual([...THREE('RET 01'), ...THREE('RET 02')]);

    // The payload also carries the five for RET 04, as a build before this
    // fix would: the guard reads the close's snapshot and keeps them out.
    const payload = {
      ...importResult,
      flags: [
        ...importResult.flags,
        ...FIVE.map((type) => ({ type, severity: 'Warning', accountName: 'RET 04', message: `old build RET 04 ${type}` })),
      ],
    };
    const closeId = await persist(RET.client, RET.device, payload);
    expect(await storedFive(closeId)).toEqual([...THREE('RET 01'), ...THREE('RET 02')]);
    expect(await observed(RET.client)).toEqual([
      ['RET 01', 'Active', 'seen', 0],
      ['RET 02', 'Active', 'seen', 0],
      ['RET 03', 'Active', 'absent', 6],
      ['RET 04', 'Active', 'breached', 0],
    ]);
  });

  it('an absent account still missing from the close gets no Missing account, generated or stored', async () => {
    const stored = await column(db, `select f.type from public.operational_flags as f
      where f.trading_account_id = $1`, [world.ret.ids['RET 03']]);
    expect(stored).toEqual([]);
  });

  it('the manual upload: the tab\'s registry says absent, the CAM\'s requests store the returning account\'s three', async () => {
    const MAN = world.man;
    const rows = await rowsAsRole(db, 'authenticated',
      'select * from public.trading_accounts where client_id = $1 order by account_name', { subject: world.gray.auth, params: [MAN.client] });
    const registry = Object.fromEntries(rows.map((row) => [row.account_name, accountMetaFromRow(row)]));
    expect(registry['MAN 01'].observedState).toBe('absent');
    const day = shiftDays(world.today, -14);
    const result = reconcileDailyImport({
      clientId: MAN.client,
      date: day,
      registry,
      parsed: { accounts: [near('MAN 01'), near('MAN 02')], strategies: [idle('MAN 01'), idle('MAN 02')], orders: [], executions: [] },
    });
    expect(fiveOf(result.flags)).toEqual([...THREE('MAN 01'), ...THREE('MAN 02')]);

    // The close row, the snapshots (the deferred refresh commits with them),
    // then the flags: three requests, each committed as the CAM.
    const [{ id: closeId }] = await committed(world.gray.auth,
      'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [MAN.client, day]);
    await committed(world.gray.auth,
      `insert into public.account_snapshots (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, account_balance)
       values ($1, $2, 'MAN 01', 300, 50000), ($1, $3, 'MAN 02', 300, 50000)`, [closeId, MAN.ids['MAN 01'], MAN.ids['MAN 02']]);
    for (const flag of result.flags) {
      await committed(world.gray.auth,
        `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status)
         values ($1, $2, $3, $4, $5, $6, 'Open')`,
        [closeId, MAN.client, MAN.ids[flag.accountName] || null, flag.type, flag.severity, flag.message]);
    }
    expect(await storedFive(closeId)).toEqual([...THREE('MAN 01'), ...THREE('MAN 02')]);
    expect(await observed(MAN.client)).toEqual([
      ['MAN 01', 'Active', 'seen', 0],
      ['MAN 02', 'Active', 'seen', 0],
    ]);
  });

  it('the rule as of a close is the same in SQL and in reconcile.js, case by case', async () => {
    const cases = [];
    for (const stored of ['seen', 'breached', 'absent', 'never_seen', null]) {
      for (const inClose of [false, true]) {
        for (const closeBreach of [true, false, null]) cases.push([stored, inClose, closeBreach]);
      }
    }
    const sql = await column(db, `select public.account_observation_in_close(c.stored, c.in_close, c.breach)
      from jsonb_to_recordset($1::jsonb) as c(n integer, stored text, in_close boolean, breach boolean)
      order by c.n`, [JSON.stringify(cases.map(([stored, in_close, breach], n) => ({ n, stored, in_close, breach })))]);
    expect(sql).toEqual(cases.map(([stored, inClose, closeBreach]) => observedStateInClose(stored, { inClose, closeBreach })));

    const readings = [];
    for (const trailing of [null, 0, 300, -0.5, -10, -1999, -2000, -2100]) {
      for (const type of ['Funded', 'Cash - IRA', 'Cash', 'Simulation']) {
        for (const limit of [null, 0, 2000]) readings.push([trailing, type, limit]);
      }
    }
    const breaches = await column(db, `select public.account_observation_breach(c.reading, c.type, c.lim)
      from jsonb_to_recordset($1::jsonb) as c(n integer, reading numeric, type text, lim numeric)
      order by c.n`, [JSON.stringify(readings.map(([reading, type, lim], n) => ({ n, reading, type, lim })))]);
    expect(breaches).toEqual(readings.map(([trailing, type, limit]) => closeReadingBreach(trailing, type, limit)));
  });
});

/* ── The transition to Failed ────────────────────────────────────────────── */

describe('the close that marks an account Failed resolves its five, and nothing else', () => {
  beforeAll(async () => {
    const T = world.t;
    T.client = await world.clientOf(world.gray, 'Client T');
    T.flipping = await world.account(T.client, 'T 01');
    T.bystander = await world.account(T.client, 'T 02');
    T.switchedOff = await world.account(T.client, 'T 03');
    // Flips in the same close as T 01 with none of the five open: one kept
    // type and one of the five a CAM already closed.
    T.bare = await world.account(T.client, 'T 04');
    world.tCloses.first = await world.close(T.client, shiftDays(world.today, -2));
    for (const [id, name] of [[T.flipping, 'T 01'], [T.bystander, 'T 02'], [T.switchedOff, 'T 03'], [T.bare, 'T 04']]) {
      await snapshot(world.tCloses.first, id, name, 500);
    }
    const seed = (accountId, type, message, extra = {}) => seedFlag({ close: world.tCloses.first, client: T.client, account: accountId, type, message, ...extra });
    for (const type of FIVE) await seed(T.flipping, type, `T 01 ${type}.`);
    for (const type of KEPT) await seed(T.flipping, type, `T 01 ${type}.`);
    T.oldResolved = await seed(T.flipping, 'Strategy disabled', 'T 01 closed by a CAM.', { status: 'Resolved', resolvedAt: '2026-09-02T09:00:00Z' });
    for (const type of FIVE) await seed(T.bystander, type, `T 02 ${type}.`);
    for (const type of FIVE) await seed(T.switchedOff, type, `T 03 ${type}.`);
    await seed(T.bare, 'Unassigned account', 'T 04 Unassigned account.');
    await seed(T.bare, 'Strategy disabled', 'T 04 closed by a CAM.', { status: 'Resolved', resolvedAt: '2026-09-03T09:00:00Z' });
    T.fiveIds = await column(db, `select id from public.operational_flags
      where trading_account_id = $1 and status = 'Open' and type = any ($2::text[]) order by id`, [T.flipping, FIVE]);

    // The breaching close, as one autocommitted statement: the deferred
    // refresh runs at its commit. Anything it RAISEs is collected.
    world.tCloses.second = await world.close(T.client, shiftDays(world.today, -1));
    T.notices = [];
    await db.query(
      `insert into public.account_snapshots (daily_import_id, trading_account_id, account_name, trailing_max_drawdown, account_balance)
       values ($1, $2, 'T 01', -10, 49000), ($1, $3, 'T 02', 500, 50000), ($1, $4, 'T 04', -10, 49000)`,
      [world.tCloses.second, T.flipping, T.bystander, T.bare],
      { onNotice: (notice) => T.notices.push(notice.message) });
  });

  it('the account is Failed by step 65\'s rule, with its own audit row and flag', async () => {
    expect(await one(db, 'select status from public.trading_accounts where id = $1', [world.t.flipping])).toBe('Failed');
    expect((await auditRows('trading_account.auto_failed')).filter((row) => row.entity_id === world.t.flipping)).toHaveLength(1);
    expect((await flagsOfAccount(world.t.flipping)).filter((flag) => flag.type === 'Marked Failed by the close' && flag.status === 'Open'))
      .toHaveLength(2);
  });

  it('its Open flags of the five are Resolved with the close\'s note and no person, the message untouched', async () => {
    const five = (await flagsOfAccount(world.t.flipping)).filter((flag) => FIVE.includes(flag.type) && flag.id !== world.t.oldResolved);
    expect(five).toHaveLength(5);
    for (const flag of five) {
      expect(flag, flag.type).toMatchObject({
        status: 'Resolved', resolved: true, resolved_by_user_id: null, resolution_note: CLOSE_NOTE, message: `T 01 ${flag.type}.`,
      });
    }
  });

  it('leaves Drawdown breached, Marked Failed by the close, Unassigned account, New account and Evaluation target reached Open', async () => {
    expect(await openTypes(world.t.flipping)).toEqual([...KEPT, 'Marked Failed by the close'].sort());
  });

  it('leaves a flag a CAM already closed, and another account\'s flags, alone', async () => {
    const old = (await flagsOfAccount(world.t.flipping)).find((flag) => flag.id === world.t.oldResolved);
    expect(old).toMatchObject({ status: 'Resolved', resolution_note: null });
    expect(old.resolved_at).toMatch(/^2026-09-02 09:00:00/);
    expect(await openTypes(world.t.bystander)).toEqual([...FIVE].sort());
  });

  it('writes one audit row for the account with the count, the types and the flag ids', async () => {
    expect((await auditRows('trading_account.flags_resolved_on_fail')).filter((row) => row.entity_id === world.t.flipping)).toEqual([{
      user_id: null,
      entity_type: 'trading_account',
      entity_id: world.t.flipping,
      after_data: {
        clientId: world.t.client,
        accountName: 'T 01',
        count: 5,
        types: Object.fromEntries(FIVE.map((type) => [type, 1])),
        flagIds: world.t.fiveIds,
        note: CLOSE_NOTE,
      },
    }]);
  });

  it('an account that flips with none of the five open gets its auto fail row and no resolve row, and its flags are untouched', async () => {
    expect(await one(db, 'select status from public.trading_accounts where id = $1', [world.t.bare])).toBe('Failed');
    expect((await auditRows('trading_account.auto_failed')).filter((row) => row.entity_id === world.t.bare)).toHaveLength(1);
    expect((await auditRows('trading_account.flags_resolved_on_fail')).filter((row) => row.entity_id === world.t.bare)).toEqual([]);
    expect((await flagsOfAccount(world.t.bare)).map((flag) => [flag.type, flag.status, flag.resolution_note])).toEqual([
      ['Marked Failed by the close', 'Open', null],
      ['Strategy disabled', 'Resolved', null],
      ['Unassigned account', 'Open', null],
    ]);
  });

  it('raises no NOTICE: the refresh runs at the commit of every close', () => {
    expect(world.t.notices).toEqual([]);
  });

  it('a refresh after the transition resolves nothing more and audits nothing more', async () => {
    const before = await auditRows('trading_account.flags_resolved_on_fail');
    await one(db, 'select public.refresh_account_observations($1)', [world.t.client]);
    expect(await auditRows('trading_account.flags_resolved_on_fail')).toEqual(before);
    expect(await openTypes(world.t.bystander)).toEqual([...FIVE].sort());
  });

  it('with resolve_flags_on_fail off the account is still Failed, and its flags stay Open with no audit row', async () => {
    await setting('resolve_flags_on_fail', false);
    try {
      const closeId = await world.close(world.t.client, world.today);
      await snapshot(closeId, world.t.switchedOff, 'T 03', -10);
      expect(await one(db, 'select status from public.trading_accounts where id = $1', [world.t.switchedOff])).toBe('Failed');
      expect((await auditRows('trading_account.auto_failed')).filter((row) => row.entity_id === world.t.switchedOff)).toHaveLength(1);
      expect(await openTypes(world.t.switchedOff)).toEqual([...FIVE, 'Marked Failed by the close'].sort());
      expect((await auditRows('trading_account.flags_resolved_on_fail')).filter((row) => row.entity_id === world.t.switchedOff)).toEqual([]);
    } finally {
      await setting('resolve_flags_on_fail', true);
    }
  });

  it('through the real persist RPC: the breaching close\'s own five are not created, so nothing is resolved and no resolve row is written', async () => {
    const R = {};
    R.client = await world.clientOf(world.gray, 'Client R');
    R.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [R.client]);
    R.account = await world.account(R.client, 'R 01', { type: 'Evaluation - Standard' });
    const closeId = await persist(R.client, R.device, {
      date: world.today,
      status: 'Needs review',
      accounts: { 'R 01': { accountName: 'R 01', alias: 'R 01', accountType: 'Evaluation - Standard', status: 'Active' } },
      snapshots: [{ accountName: 'R 01', trailingMaxDrawdown: -20, accountBalance: 49000 }],
      flags: [
        { type: 'Strategy disabled', severity: 'Warning', accountName: 'R 01', message: 'R 01 has RBO disabled.' },
        { type: 'Expected strategy missing', severity: 'Critical', accountName: 'R 01', message: 'R 01 ran nothing.' },
        { type: 'Drawdown breached', severity: 'Critical', accountName: 'R 01', message: 'R 01 breached.' },
      ],
    });
    expect(await one(db, 'select status from public.trading_accounts where id = $1', [R.account])).toBe('Failed');
    const rows = (await db.query(`select type, status, resolution_note from public.operational_flags
      where daily_import_id = $1 order by type`, [closeId])).rows;
    // The payload carried them (an old build, or a tab that loaded the
    // registry first); the guard read this close's breach at insert.
    expect(rows).toEqual([
      { type: 'Drawdown breached', status: 'Open', resolution_note: null },
      { type: 'Marked Failed by the close', status: 'Open', resolution_note: null },
    ]);
    expect((await auditRows('trading_account.auto_failed')).filter((row) => row.entity_id === R.account)).toHaveLength(1);
    expect((await auditRows('trading_account.flags_resolved_on_fail')).filter((row) => row.entity_id === R.account)).toEqual([]);
  });
});

/* ── The words ───────────────────────────────────────────────────────────── */

describe('the words this file writes', () => {
  it('no note, NOTICE or audit text uses a dash as punctuation', async () => {
    const texts = [
      CLOSE_NOTE, BACKLOG_NOTE, ...world.notices,
      ...(await column(db, `select after_data::text from public.audit_logs
        where action in ('flags.backlog_resolved_on_failed_accounts', 'trading_account.flags_resolved_on_fail')`)),
      ...(await column(db, 'select distinct resolution_note from public.operational_flags where resolution_note is not null')),
    ];
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(text, text).not.toMatch(DASH);
    expect(await column(db, 'select distinct resolution_note from public.operational_flags where resolution_note is not null order by 1'))
      .toEqual([CLOSE_NOTE, BACKLOG_NOTE].sort());
  });
});

/* ── What a CAM reads ────────────────────────────────────────────────────── */

describe('a CAM still reads her own flags, and a resolved one reads Resolved in the queue', () => {
  async function loginRows(subject, clientId) {
    const since = shiftDays(world.today, -14);
    const rows = await rowsAsRole(db, 'authenticated',
      `select ${LOGIN_COLUMNS.operational_flags} from public.operational_flags
        where client_id = $1 and (status not in ('Resolved', 'Acknowledged') or resolved_at >= $2::date)`,
      { subject, params: [clientId, since] });
    // PostgREST sends a timestamptz as an ISO string; PGlite hands back a Date.
    return rows.map((row) => ({ ...row, resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null }));
  }

  it('the login query shape returns the backlog rows Resolved, with resolved_at, to the CAM who owns them', async () => {
    const rows = await loginRows(world.gray.auth, world.a.client);
    const failed = rows.filter((row) => row.trading_account_id === world.a.failed && FIVE.includes(row.type));
    expect(failed).toHaveLength(6);
    for (const row of failed) expect(row).toMatchObject({ status: 'Resolved', resolved_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it('another CAM reads none of them', async () => {
    expect(await loginRows(world.birch.auth, world.a.client)).toEqual([]);
  });

  it('the queue built from those rows: the five are receipts, not work; the kept types are still work', async () => {
    const rows = await loginRows(world.gray.auth, world.a.client);
    const state = {
      clients: [{
        accountRegistry: {
          'A 01': { id: world.a.live, accountName: 'A 01' },
          'A 02': { id: world.a.failed, accountName: 'A 02' },
          'A 03': { id: world.a.inactive, accountName: 'A 03' },
          'A 04': { id: world.a.reserve, accountName: 'A 04' },
        },
      }],
    };
    const flags = closeFlagsFromRows(state, rows);
    const queue = buildCamFlagQueue(
      [{ id: world.a.client, name: 'Client A', dailyImports: [{ id: world.a.close, date: world.a.day, flags }] }],
      { today: world.today },
    );
    const work = queue.groups.flatMap((group) => group.rows).map((row) => `${row.accountName}|${row.type}`);
    expect(work.filter((key) => key.startsWith('A 02|')).sort()).toEqual(KEPT.map((type) => `A 02|${type}`).sort());
    const receipts = queue.recentlyClosed.filter((row) => row.accountName === 'A 02');
    expect(receipts.map((row) => row.type).sort()).toEqual(['Missing account', ...FIVE].sort());
    for (const row of receipts) expect(row).toMatchObject({ status: 'Resolved', closedOn: world.today });
    expect(work.filter((key) => key.startsWith('A 01|')).sort()).toEqual(FIVE.map((type) => `A 01|${type}`).sort());
  });

  it('a CAM can still resolve and reopen a flag herself: the guard is on insert only', async () => {
    const id = await one(db, "select id from public.operational_flags where trading_account_id = $1 and type = 'Missing account'", [world.a.live]);
    await committed(world.gray.auth, "update public.operational_flags set status = 'Resolved', resolved_at = now() where id = $1", [id]);
    await committed(world.gray.auth, "update public.operational_flags set status = 'Open', resolved_at = null where id = $1", [id]);
    expect(await one(db, 'select status from public.operational_flags where id = $1', [id])).toBe('Open');
  });

  it('on a dead account too: reopening one of the five the close resolved is a decision, and it lands, without the close\'s note', async () => {
    const id = await one(db, `select id from public.operational_flags
      where trading_account_id = $1 and type = 'Strategy disabled' and resolution_note = $2`, [world.t.flipping, CLOSE_NOTE]);
    expect(await one(db, 'select status from public.trading_accounts where id = $1', [world.t.flipping])).toBe('Failed');
    await committed(world.gray.auth, "update public.operational_flags set status = 'Open', resolved_at = null where id = $1", [id]);
    expect((await db.query('select status, resolution_note from public.operational_flags where id = $1', [id])).rows)
      .toEqual([{ status: 'Open', resolution_note: null }]);
    // Closed again by her: a person's resolve, so no note comes back.
    await committed(world.gray.auth, "update public.operational_flags set status = 'Resolved', resolved_at = now() where id = $1", [id]);
    expect((await db.query('select status, resolution_note from public.operational_flags where id = $1', [id])).rows)
      .toEqual([{ status: 'Resolved', resolution_note: null }]);
  });

  it('the note is the database\'s: a CAM can neither stamp it on her flag nor insert a flag carrying it', async () => {
    const id = await one(db, "select id from public.operational_flags where trading_account_id = $1 and type = 'Missing account'", [world.a.live]);
    expect(await refusalAsRole(db, 'authenticated',
      "update public.operational_flags set status = 'Resolved', resolved_at = now(), resolution_note = $2 where id = $1",
      { subject: world.gray.auth, params: [id, CLOSE_NOTE] })).toMatch(/resolution_note is written by the database/);
    expect(await refusalAsRole(db, 'authenticated',
      `insert into public.operational_flags (daily_import_id, client_id, trading_account_id, type, severity, message, status, resolved_at, resolution_note)
       values ($1, $2, $3, 'New account', 'Warning', 'stamped', 'Resolved', now(), $4)`,
      { subject: world.gray.auth, params: [world.a.close, world.a.client, world.a.live, BACKLOG_NOTE] }))
      .toMatch(/resolution_note is written by the database/);
    expect((await db.query('select status, resolution_note from public.operational_flags where id = $1', [id])).rows)
      .toEqual([{ status: 'Open', resolution_note: null }]);
  });

  it('a CAM reads the switch on the settings row, and cannot write it', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select resolve_flags_on_fail from public.account_observation_settings', { subject: world.gray.auth });
    expect(rows).toEqual([{ resolve_flags_on_fail: true }]);
    expect(await refusalAsRole(db, 'authenticated',
      'update public.account_observation_settings set resolve_flags_on_fail = false where id', { subject: world.managerAuth }))
      .toMatch(DENIED);
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: exact, and this file\'s own', () => {
  it('refresh_account_observations: service_role and nobody else', async () => {
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
  });

  it('the five new functions: nobody but the owner', async () => {
    for (const signature of [...HELPERS, NOTE_GUARD]) expect(await executeGrantees(signature), signature).toEqual([]);
  });

  it('every function this file defines has search_path pinned; all but the note guard are security definer', async () => {
    for (const signature of [REFRESH, ...HELPERS]) {
      const row = (await db.query(`select prosecdef, proconfig from pg_proc where oid = '${signature}'::regprocedure`)).rows[0];
      expect(row, signature).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] });
    }
    expect((await db.query(`select prosecdef, proconfig from pg_proc where oid = '${NOTE_GUARD}'::regprocedure`)).rows[0])
      .toEqual({ prosecdef: false, proconfig: ['search_path=pg_catalog, public'] });
  });

  it('anon and authenticated are refused the refresh at the door; the service role may call it', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select public.refresh_account_observations($1)',
        { subject: world.gray.auth, params: [world.a.client] })).toMatch(/permission denied for function refresh_account_observations/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select public.refresh_account_observations($1)', { params: [world.a.client] })).toBeNull();
  });

  it('operational_flags keeps the four verbs for authenticated and nothing for anon; the settings row keeps SELECT', async () => {
    expect((await privilegesOn(db, 'authenticated', 'operational_flags')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(await privilegesOn(db, 'anon', 'operational_flags')).toEqual([]);
    expect(await privilegesOn(db, 'authenticated', 'account_observation_settings')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'account_observation_settings')).toEqual([]);
  });

  it('the grants are the file\'s own: drift installed on purpose, 67 puts it back', async () => {
    await db.exec(`revoke execute on function ${REFRESH} from service_role;
                   grant execute on function ${REFRESH} to anon, authenticated;
                   grant execute on function public.live_account_flag_types() to authenticated;
                   grant truncate on public.operational_flags to authenticated;`);
    expect(await executeGrantees(REFRESH)).toEqual(['anon', 'authenticated']);
    await applyFileCollectingNotices(db, STEP);
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
    expect(await executeGrantees('public.live_account_flag_types()')).toEqual([]);
    expect((await privilegesOn(db, 'authenticated', 'operational_flags')).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('the refresh still takes the per client advisory lock step 65 put first', () => {
    // A single connection cannot race two refreshes, so this one is read off
    // the definition the database holds.
    const body = world.definition.slice(world.definition.indexOf('begin'));
    expect(body).toMatch(/^begin\s+--[^\n]*\n\s+--[^\n]*\n\s+perform pg_advisory_xact_lock\(hashtext\(p_client_id::text\)\);/);
  });
});

/* ── Running it again, and 65 again under it ─────────────────────────────── */

describe('running it again', () => {
  it('keeps the definition, keeps the switch where Pedro put it, and changes no flag', async () => {
    await setting('resolve_flags_on_fail', false);
    const flags = (await db.query('select id, status, resolution_note, resolved_at from public.operational_flags order by id')).rows;
    await applyFileCollectingNotices(db, STEP);
    expect(await functionDefinition(REFRESH)).toBe(world.definition);
    expect(await one(db, 'select resolve_flags_on_fail from public.account_observation_settings')).toBe(false);
    expect((await db.query('select id, status, resolution_note, resolved_at from public.operational_flags order by id')).rows).toEqual(flags);
    await setting('resolve_flags_on_fail', true);
  });

  it('a re-run of 65 puts its own refresh back (no resolve), and 67 again restores this one', async () => {
    await applyFileCollectingNotices(db, 'step_65_account_observations.sql');
    expect(await functionDefinition(REFRESH)).not.toContain('flags_resolved_on_fail');
    expect(await executeGrantees(REFRESH)).toEqual(['service_role']);
    await applyFileCollectingNotices(db, STEP);
    expect(await functionDefinition(REFRESH)).toBe(world.definition);
    expect((await auditRows('flags.backlog_resolved_on_failed_accounts')).filter((row) => !row.after_data.forgedByHand)).toHaveLength(1);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 67 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 67)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(67);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 66, in the run order after 66, and says what it resolves and how to switch it off', () => {
    expect(runbook).toMatch(/^\| 67 \| `step_67_flag_hygiene\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 67 | `step_67_flag_hygiene.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 66 | `step_66_tracker_close_readings.sql`'));
    expect(runbook).toMatch(/→ 63 → 64 → 65 → 66 → 67(?: →|\.)/);
    expect(runbook).toContain('67 resolves flags once');
    expect(runbook).toContain('set resolve_flags_on_fail = false');
    expect(runbook).toContain('run 67 again after any re-run of 65');
  });
});
