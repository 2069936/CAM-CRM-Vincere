/* STEP 57, ASKED OF A RUNNING POSTGRES.
 *
 * Every assertion that matters here is about behaviour: who may read a row, who
 * may call which function, which cycle the desk figure is taken from, whether a
 * CAM's own clients move the median it is shown, and whether a thin cohort says
 * anything at all. So the whole directory is applied, twice, to the PGlite
 * cluster in migrationCluster.js, which boots with Supabase's real default
 * privileges (every new table born holding all eight for anon and
 * authenticated). A harness kinder than the world would make the grant tests
 * below decoration.
 *
 * The only text read from the files is the runbook row and the numbering
 * handover, which are facts about the files and nothing else.
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
import { normalizeStrategySampleBody } from '../server/autoCollection/ingest/strategies.js';

const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const DENIED = /permission denied/i;
const TEN_MINUTES = 600_000;

let db;
const world = { clients: {}, devices: {} };

/** A boundary of the default 600 s grid, `back` whole cycles before now. */
function boundary(back = 1) {
  return new Date(Math.floor(Date.now() / TEN_MINUTES) * TEN_MINUTES - back * TEN_MINUTES);
}

function iso(date) {
  return date.toISOString();
}

/** One reading, written as the owner so a test can place it in any cycle. */
let instanceSeq = 0;
async function reading({
  client,
  account = 'ACC-1',
  algorithm = 'OGX_PF',
  root = 'MNQ',
  realized = 0,
  unrealized = 0,
  restartedAt = null,
  cycle,
  strategyId = null,
}) {
  instanceSeq += 1;
  const sampled = new Date((cycle ? cycle.getTime() : Date.now() - 300_000) + 2000);
  await db.query(
    `insert into public.algorithm_live_samples (
       device_id, client_id, account_name, strategy_id, strategy_name, algorithm,
       instrument, instrument_root, realized_pnl, unrealized_pnl, restarted_at,
       sampled_at, cycle_start)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [world.devices[client], world.clients[client], account, strategyId || `id-${instanceSeq}`,
      `0 - ${algorithm}-1.0`, algorithm, `${root} 12-26`, root, realized, unrealized,
      restartedAt, iso(sampled), cycle ? iso(cycle) : null],
  );
}

async function resetSamples() {
  await db.exec('delete from public.algorithm_live_samples');
  await db.exec(`update public.algorithm_live_settings
    set min_cohort_accounts = 5, min_cohort_clients = 3, cycle_tolerance_seconds = 90,
        differs_at_spread = 3.0, min_spread_dollars = 50, max_strategies_per_report = 200,
        retention_days = 2 where id`);
  await db.exec(`update public.account_tracker_settings
    set sample_interval_seconds = 600, stale_sample_seconds = 1500,
        min_report_interval_seconds = 60 where id`);
}

async function desk(subject) {
  return rowsAsRole(db, 'authenticated',
    `select * from public.algorithm_live_desk()
     order by algorithm nulls first, instrument_root`, { subject });
}

function cohort(rows, algorithm = 'OGX_PF', root = 'MNQ') {
  return rows.find((row) => row.algorithm === algorithm && row.instrument_root === root);
}

/** One report through the real function, the way the route calls it. */
async function send(client, sampledAt, strategies) {
  const out = await one(db,
    'select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb) as out',
    [world.devices[client], sampledAt, JSON.stringify(strategies)]);
  return out;
}

async function refusalOfSend(deviceId, sampledAt, strategies) {
  try {
    await db.query('select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb)',
      [deviceId, sampledAt, JSON.stringify(strategies)]);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

function item(overrides = {}) {
  return {
    accountName: 'SIM-FIXTURE-1',
    strategyId: '123456789',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -412.5,
    unrealizedPnl: 37.5,
    restartedAt: null,
    ...overrides,
  };
}

/** The throttle compares now against reported_at; moving it back is the clock moving on. */
async function timePasses(client) {
  await db.query(`update public.algorithm_live_samples
    set reported_at = reported_at - interval '10 minutes' where device_id = $1`, [world.devices[client]]);
}

async function storedRows(client) {
  return (await db.query(
    `select account_name, strategy_id, realized_pnl, unrealized_pnl, restarted_at, sampled_at, cycle_start
     from public.algorithm_live_samples where device_id = $1 order by account_name, strategy_id`,
    [world.devices[client]])).rows;
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder(), { applyTwice: true });

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
  world.gray = await cam('Gray');
  world.birch = await cam('Birch');
  world.managerAuth = await authUser('mgr@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1)`, [world.managerAuth]);
  world.inactiveAuth = await authUser('gone@example.com');
  await db.query(`insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('gone', 'Gone', 'gone@example.com', 'CAM', 'Inactive', $1)`, [world.inactiveAuth]);
  world.strangerAuth = await authUser('stranger@example.com');

  // Gray owns G1..G3, Birch owns B1..B4, U1 and U2 are nobody's.
  for (const [key, owner] of [
    ['G1', world.gray], ['G2', world.gray], ['G3', world.gray],
    ['B1', world.birch], ['B2', world.birch], ['B3', world.birch], ['B4', world.birch],
    ['U1', null], ['U2', null],
  ]) {
    world.clients[key] = await one(db, 'insert into public.clients (name) values ($1) returning id', [`Client ${key}`]);
    if (owner) {
      await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
        [world.clients[key], owner.profile]);
    }
    world.devices[key] = await one(db,
      'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clients[key]]);
  }
  world.revokedDevice = await one(db,
    `insert into public.ingest_devices (client_id, status, revoked_at)
     values ($1, 'revoked', now()) returning id`, [world.clients.B1]);
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 57 exists and is no longer the one that runs last', () => {
  it('appears once, 61 now carries the highest-number claim, and 54 is still a deliberate gap', () => {
    /* Handed on the way 56 handed it here: the newest step's own test asserts
     * it is the highest. */
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 57)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThan(57);
    expect(numbers).not.toContain(54);
  });

  it('is in the runbook table, in the run order after 56, and says how it degrades', () => {
    expect(runbook).toMatch(/^\| 57 \| `step_57_algorithm_live_samples\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 57 | `step_57_algorithm_live_samples.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 56 | `step_56_table_privilege_lockdown.sql`'));
    expect(runbook).toMatch(/→ 55 → 56 → 57(?: →|\.)/);
    expect(runbook).toContain('57 degrades gracefully');
  });

  it('refuses to run before steps 55 and 52, and says which', async () => {
    await expect(startMigrationCluster(
      migrationFilesInOrder({ upTo: 53 }).concat(['step_57_algorithm_live_samples.sql']),
    )).rejects.toThrow(/step 57 needs step 55 \(account_tracker_settings\) and step 52 \(is_manager\): run them first/);
  }, 120_000);

  it('refuses to run without what it leaves a CAM\'s influenced clients out by, and says which', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 56 }));
    try {
      await early.exec('drop function public.clients_i_created() cascade');
      await expect(applyFileCollectingNotices(early, 'step_57_algorithm_live_samples.sql'))
        .rejects.toThrow(/step 57 needs step 53 \(clients_i_created\) and step 28 \(ingest_enrollments\): run them first/);
      // The file is one transaction, so the refusal leaves nothing behind.
      await early.exec('rollback');
      expect(await one(early, "select to_regclass('public.algorithm_live_samples')::text")).toBeNull();
    } finally {
      await early.close();
    }
  }, 120_000);
});

describe('step 56 re-run before 57 is applied', () => {
  it('names the two tables it does not find yet, and nothing disagrees', async () => {
    /* The runbook row tells Pedro this NOTICE is expected. It is asserted here so
     * the sentence in the runbook stays true, and so a re-run of 56 on a database
     * without 57 is proved not to error on the missing tables. */
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 56 }));
    try {
      const notices = await applyFileCollectingNotices(early, 'step_56_table_privilege_lockdown.sql');
      const stale = notices.filter((n) => /not in public/.test(n));
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain('algorithm_live_samples, algorithm_live_settings');
      expect(notices.filter((n) => /did not produce what the exception table says/.test(n))).toEqual([]);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── Privileges ──────────────────────────────────────────────────────────── */

describe('who holds what', () => {
  for (const table of ['algorithm_live_samples', 'algorithm_live_settings']) {
    it(`${table}: authenticated holds exactly SELECT, anon holds nothing`, async () => {
      expect(await privilegesOn(db, 'authenticated', table)).toEqual(['SELECT']);
      expect(await privilegesOn(db, 'anon', table)).toEqual([]);
    });

    it(`${table}: a signed-in CAM is refused every write, TRUNCATE included`, async () => {
      for (const statement of [
        `insert into public.${table} default values`,
        `update public.${table} set updated_at = now() where false`.replace(
          'updated_at', table === 'algorithm_live_samples' ? 'reported_at' : 'updated_at'),
        `delete from public.${table} where false`,
        `truncate table public.${table}`,
      ]) {
        expect(await refusalAsRole(db, 'authenticated', statement, { subject: world.gray.auth }), statement)
          .toMatch(DENIED);
      }
    });
  }

  it('the ingest function and the cycle rule are refused to both browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role,
        "select public.record_algorithm_live_sample(gen_random_uuid(), now(), '[]'::jsonb)",
        { subject: world.gray.auth })).toMatch(DENIED);
      expect(await refusalAsRole(db, role,
        'select public.algorithm_live_cycle(now(), now(), 600, 90)',
        { subject: world.gray.auth })).toMatch(DENIED);
    }
    expect(await refusalAsRole(db, 'service_role',
      'select public.algorithm_live_cycle(now(), now(), 600, 90)')).toBeNull();
  });

  it('the desk function is callable signed in and refused to anon', async () => {
    expect(await refusalAsRole(db, 'authenticated', 'select * from public.algorithm_live_desk()',
      { subject: world.gray.auth })).toBeNull();
    expect(await refusalAsRole(db, 'anon', 'select * from public.algorithm_live_desk()')).toMatch(DENIED);
  });

  it('anon cannot read a row even through the settings singleton', async () => {
    expect(await refusalAsRole(db, 'anon', 'select * from public.algorithm_live_settings')).toMatch(DENIED);
  });
});

describe('the lockdown is the file\'s own, not borrowed from step 56', () => {
  it('applied straight after 55, before 56 has changed the default privileges, it still leaves exactly SELECT', async () => {
    /* A new table in public is born with all eight privileges for anon and
     * authenticated. Step 56 changed that default, but a migration must not
     * depend on running after it: this file revokes and grants for itself. */
    const early = await startMigrationCluster(
      migrationFilesInOrder({ upTo: 55 }).concat(['step_57_algorithm_live_samples.sql']));
    try {
      for (const table of ['algorithm_live_samples', 'algorithm_live_settings']) {
        expect(await privilegesOn(early, 'authenticated', table), table).toEqual(['SELECT']);
        expect(await privilegesOn(early, 'anon', table), table).toEqual([]);
      }
      expect(await refusalAsRole(early, 'anon', 'select * from public.algorithm_live_desk()')).toMatch(DENIED);
      expect(await refusalAsRole(early, 'anon',
        "select public.record_algorithm_live_sample(gen_random_uuid(), now(), '[]'::jsonb)")).toMatch(DENIED);
    } finally {
      await early.close();
    }
  }, 120_000);
});

describe('a re-run of step 56 and step 52 widens nothing', () => {
  let rerun;
  beforeAll(async () => {
    rerun = await startMigrationCluster(migrationFilesInOrder(), {
      reapply: ['step_56_table_privilege_lockdown.sql', 'step_52_rls_by_cam.sql'],
    });
  }, 120_000);
  afterAll(async () => { await rerun?.close?.(); });

  it('both tables are still SELECT only, and anon still holds nothing', async () => {
    for (const table of ['algorithm_live_samples', 'algorithm_live_settings']) {
      expect(await privilegesOn(rerun, 'authenticated', table)).toEqual(['SELECT']);
      expect(await privilegesOn(rerun, 'anon', table)).toEqual([]);
    }
  });

  it('and the restrictive denials hold even with the write privileges handed back', async () => {
    /* The second layer, proved on its own. Step 52's re-run installs a permissive
     * `for all` with read AND write on every client_id table; grant the verbs
     * back for the duration of one transaction and the denials are the only
     * thing between a CAM and a forged reading of its own client. */
    const client = await one(rerun, "insert into public.clients (name) values ('Own') returning id");
    const profile = await one(rerun, "insert into public.cam_profiles (name) values ('Own CAM') returning id");
    await rerun.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [client, profile]);
    const auth = await one(rerun, "insert into auth.users (email) values ('own@example.com') returning id");
    await rerun.query(`insert into public.app_users (username, display_name, role, status, auth_user_id, cam_profile_id)
      values ('own', 'Own', 'CAM', 'Active', $1, $2)`, [auth, profile]);
    const device = await one(rerun, 'insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
    await rerun.query(`insert into public.algorithm_live_samples (device_id, client_id, account_name, strategy_id,
      strategy_name, algorithm, instrument, instrument_root, realized_pnl, unrealized_pnl, sampled_at)
      values ($1, $2, 'A', '1', '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', 1, 1, now())`, [device, client]);

    const policies = await rerun.query(`select policyname, permissive, cmd from pg_policies
      where tablename = 'algorithm_live_samples' order by policyname`);
    expect(policies.rows.some((row) => row.permissive === 'PERMISSIVE' && row.cmd === 'ALL')).toBe(true);

    async function asOwnCamWithVerbs(sql) {
      try {
        await rerun.exec('begin');
        await rerun.exec('grant insert, update, delete on public.algorithm_live_samples to authenticated');
        await rerun.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', auth]);
        await rerun.exec('set local role authenticated');
        const result = await rerun.query(sql);
        return { rows: result.rows, error: null };
      } catch (error) {
        return { rows: [], error: String(error.message || error) };
      } finally {
        await rerun.exec('rollback');
      }
    }
    expect((await asOwnCamWithVerbs(`insert into public.algorithm_live_samples (device_id, client_id, account_name,
      strategy_id, strategy_name, algorithm, instrument, instrument_root, sampled_at)
      values ('${device}', '${client}', 'B', '2', '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', now())`)).error)
      .toMatch(/row-level security/);
    expect((await asOwnCamWithVerbs(
      'update public.algorithm_live_samples set realized_pnl = 999999 returning 1')).rows).toEqual([]);
    expect((await asOwnCamWithVerbs(
      'delete from public.algorithm_live_samples returning 1')).rows).toEqual([]);
    expect(await one(rerun, 'select count(*)::int from public.algorithm_live_samples')).toBe(1);
  });
});

/* ── Row level security ─────────────────────────────────────────────────── */

describe('who reads which rows', () => {
  beforeAll(async () => {
    await resetSamples();
    const cycle = boundary(1);
    await reading({ client: 'G1', cycle });
    await reading({ client: 'B1', cycle });
    await reading({ client: 'U1', cycle });
  });

  it('a CAM sees its own clients and no others', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select client_id from public.algorithm_live_samples', { subject: world.gray.auth });
    expect(rows.map((row) => row.client_id)).toEqual([world.clients.G1]);
  });

  it('a Manager sees every row', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select client_id from public.algorithm_live_samples', { subject: world.managerAuth });
    expect(rows).toHaveLength(3);
  });

  it('anyone signed in reads the floors, and nobody can change them', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select min_cohort_accounts, min_cohort_clients from public.algorithm_live_settings',
      { subject: world.gray.auth });
    expect(rows).toEqual([{ min_cohort_accounts: 5, min_cohort_clients: 3 }]);
  });
});

describe('who reads which rows, on a database that ran each file once', () => {
  /* The cluster above applies the directory twice, and the second pass of step
   * 52 replaces every permissive policy on a client_id table with its own
   * predicate. That heals a broken policy in this file, so a database that ran
   * 57 once, which is the one Pedro will have, is asked separately. */
  it('a CAM sees its own client and not another CAM\'s', async () => {
    const once = await startMigrationCluster(migrationFilesInOrder());
    try {
      const mine = await one(once, "insert into public.clients (name) values ('Mine') returning id");
      const theirs = await one(once, "insert into public.clients (name) values ('Theirs') returning id");
      const profile = await one(once, "insert into public.cam_profiles (name) values ('Solo') returning id");
      await once.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [mine, profile]);
      const auth = await one(once, "insert into auth.users (email) values ('solo@example.com') returning id");
      await once.query(`insert into public.app_users (username, display_name, role, status, auth_user_id, cam_profile_id)
        values ('solo', 'Solo', 'CAM', 'Active', $1, $2)`, [auth, profile]);
      for (const client of [mine, theirs]) {
        const device = await one(once, 'insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
        await once.query(`insert into public.algorithm_live_samples (device_id, client_id, account_name, strategy_id,
          strategy_name, algorithm, instrument, instrument_root, sampled_at)
          values ($1, $2, 'A', '1', '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', now())`, [device, client]);
      }
      const rows = await rowsAsRole(once, 'authenticated',
        'select client_id from public.algorithm_live_samples', { subject: auth });
      expect(rows.map((row) => row.client_id)).toEqual([mine]);
    } finally {
      await once.close();
    }
  }, 120_000);
});

/* ── The settings ───────────────────────────────────────────────────────── */

describe('the settings singleton', () => {
  async function editRefused(set) {
    try {
      await db.exec('begin');
      await db.exec(`update public.algorithm_live_settings set ${set} where id`);
      return null;
    } catch (error) {
      return String(error.message || error);
    } finally {
      await db.exec('rollback');
    }
  }

  it('ships the defaults the design names', async () => {
    const row = (await db.query('select * from public.algorithm_live_settings')).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      min_cohort_accounts: 5,
      min_cohort_clients: 3,
      cycle_tolerance_seconds: 90,
      min_spread_dollars: 50,
      max_strategies_per_report: 200,
      retention_days: 2,
    });
    expect(Number(row[0].differs_at_spread)).toBe(3);
  });

  it('refuses the hand edits that would make the floors meaningless', async () => {
    expect(await editRefused('min_cohort_accounts = 2')).toMatch(/check constraint/);
    expect(await editRefused('min_cohort_clients = 1')).toMatch(/check constraint/);
    expect(await editRefused('min_cohort_accounts = 4, min_cohort_clients = 5')).toMatch(/check constraint/);
    expect(await editRefused('cycle_tolerance_seconds = 5')).toMatch(/check constraint/);
    expect(await editRefused('retention_days = 0')).toMatch(/check constraint/);
    expect(await editRefused('min_cohort_accounts = 6, min_cohort_clients = 4')).toBeNull();
  });

  it('refuses a second row', async () => {
    expect(await editRefused('id = false')).toMatch(/check constraint|singleton/);
  });
});

/* ── The cycle rule ─────────────────────────────────────────────────────── */

describe('algorithm_live_cycle', () => {
  const at = (iso8601) => iso8601;
  async function cycleOf(sampled, now, interval = 600, tolerance = 90) {
    const value = await one(db,
      'select public.algorithm_live_cycle($1::timestamptz, $2::timestamptz, $3, $4) as c',
      [sampled, now, interval, tolerance]);
    return value === null ? null : new Date(value).toISOString();
  }
  const B = '2026-10-06T14:10:00.000Z';

  it('takes a reading on the boundary and up to the tolerance after it', async () => {
    expect(await cycleOf(at('2026-10-06T14:10:00Z'), at('2026-10-06T14:10:00Z'))).toBe(B);
    expect(await cycleOf(at('2026-10-06T14:11:30Z'), at('2026-10-06T14:11:30Z'))).toBe(B);
    expect(await cycleOf(at('2026-10-06T10:10:02.5-04:00'), at('2026-10-06T14:10:05Z'))).toBe(B);
  });

  it('refuses a reading one second past the tolerance', async () => {
    expect(await cycleOf(at('2026-10-06T14:11:31Z'), at('2026-10-06T14:11:31Z'))).toBeNull();
  });

  it('refuses a machine whose clock is off by more than the tolerance, in either direction', async () => {
    expect(await cycleOf(at('2026-10-06T14:10:02Z'), at('2026-10-06T14:11:33Z'))).toBeNull();
    expect(await cycleOf(at('2026-10-06T14:10:02Z'), at('2026-10-06T14:08:31Z'))).toBeNull();
    expect(await cycleOf(at('2026-10-06T14:10:02Z'), at('2026-10-06T14:11:32Z'))).toBe(B);
  });

  it('follows the interval: the same reading is on cycle at 300 and off it at 600', async () => {
    expect(await cycleOf(at('2026-10-06T14:15:30Z'), at('2026-10-06T14:15:30Z'), 300))
      .toBe('2026-10-06T14:15:00.000Z');
    expect(await cycleOf(at('2026-10-06T14:15:30Z'), at('2026-10-06T14:15:30Z'), 600)).toBeNull();
  });
});

/* ── record_algorithm_live_sample ───────────────────────────────────────── */

describe('record_algorithm_live_sample', () => {
  beforeAll(resetSamples);

  /* With a 300 s interval and a 300 s tolerance every reading taken in the last
   * few seconds is on cycle, and its cycle is a pure function of sampled_at:
   * deterministic without pinning the wall clock. */
  async function deterministicCycles() {
    await db.exec('update public.account_tracker_settings set sample_interval_seconds = 300 where id');
    await db.exec('update public.algorithm_live_settings set cycle_tolerance_seconds = 300 where id');
  }

  it('stores the fixture and says which cycle it landed in', async () => {
    await resetSamples();
    await deterministicCycles();
    const sampled = new Date(Date.now() - 10_000);
    const out = await send('G1', iso(sampled), [
      item(),
      item({ strategyId: '123456790', strategyName: '1 - ALPHA-1.2', algorithm: 'ALPHA',
        instrument: 'NQ 12-26', instrumentRoot: 'NQ', realizedPnl: null, unrealizedPnl: null,
        restartedAt: iso(new Date(sampled.getTime() - 20 * 60_000)) }),
    ]);
    const expected = new Date(Math.floor(sampled.getTime() / 300_000) * 300_000);
    expect(out.recorded).toBe(2);
    expect(out.throttled).toBe(false);
    expect(new Date(out.cycleStart).toISOString()).toBe(expected.toISOString());
    const rows = await storedRows('G1');
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].realized_pnl)).toBe(-412.5);
    // NULL IS NOT MEASURED, never zero.
    expect(rows[1].realized_pnl).toBeNull();
    expect(rows[1].unrealized_pnl).toBeNull();
    expect(rows[1].restarted_at).not.toBeNull();
  });

  it('takes exactly what the route forwards: the wire keys and the SQL keys are one contract', async () => {
    /* The route's own normaliser, fed the contract fixture with today's clock,
     * straight into the real function. A key renamed on either side fails here. */
    await resetSamples();
    const sampled = new Date(Date.now() - 10_000);
    const body = {
      schemaVersion: 1,
      sampledAt: sampled.toISOString(),
      strategies: [
        { accountName: 'SIM-FIXTURE-1', strategyId: '123456789', strategyName: '0 - OGX-PF-2.4',
          instrument: 'MNQ 12-26', realizedPnl: -412.5, unrealizedPnl: 37.5, restartedAt: null,
          marketPosition: 'long', positionQuantity: 2, tradesThisRun: 7 },
        { accountName: 'SIM-FIXTURE-1', strategyId: '123456790', strategyName: '1 - ALPHA-1.2',
          instrument: 'NQ 12-26', realizedPnl: null, unrealizedPnl: null,
          restartedAt: new Date(sampled.getTime() - 20 * 60_000).toISOString(),
          marketPosition: null, positionQuantity: null, tradesThisRun: null },
      ],
    };
    const normalized = normalizeStrategySampleBody(body);
    const out = await send('G1', normalized.sampledAt, normalized.strategies);
    expect(out.recorded).toBe(2);
    const rows = (await db.query(`select algorithm, instrument_root from public.algorithm_live_samples
      where device_id = $1 order by strategy_id`, [world.devices.G1])).rows;
    expect(rows).toEqual([
      { algorithm: 'OGX_PF', instrument_root: 'MNQ' },
      { algorithm: 'ALPHA', instrument_root: 'NQ' },
    ]);
  });

  it('stores an off cycle reading with no cycle at all', async () => {
    await resetSamples();
    // Default 600/90: a reading 200 s old is outside the clock tolerance.
    const out = await send('G1', iso(new Date(Date.now() - 200_000)), [item()]);
    expect(out.recorded).toBe(1);
    expect(out.cycleStart).toBeNull();
    expect((await storedRows('G1'))[0].cycle_start).toBeNull();
  });

  it('keeps one row per instance across posts, and never walks a newer one back', async () => {
    await resetSamples();
    await deterministicCycles();
    const newer = new Date(Date.now() - 10_000);
    await send('G1', iso(newer), [item({ realizedPnl: -100 })]);
    await timePasses('G1');
    const older = new Date(Date.now() - 60_000);
    const out = await send('G1', iso(older), [
      item({ realizedPnl: -999 }),
      item({ strategyId: '555', realizedPnl: 5 }),
    ]);
    // Only the new instance was written; the stale reading of the known one was not.
    expect(out.recorded).toBe(1);
    const rows = await storedRows('G1');
    expect(rows).toHaveLength(2);
    const known = rows.find((row) => row.strategy_id === '123456789');
    expect(Number(known.realized_pnl)).toBe(-100);
    expect(new Date(known.sampled_at).toISOString()).toBe(newer.toISOString());

    await timePasses('G1');
    const newest = new Date(Date.now() - 5_000);
    const again = await send('G1', iso(newest), [item({ realizedPnl: -150 })]);
    expect(again.recorded).toBe(1);
    expect(await one(db, 'select count(*)::int from public.algorithm_live_samples where device_id = $1',
      [world.devices.G1])).toBe(2);
    expect(Number((await storedRows('G1')).find((row) => row.strategy_id === '123456789').realized_pnl)).toBe(-150);
  });

  it('throttles a second post inside the window and writes nothing', async () => {
    await resetSamples();
    await send('G1', iso(new Date(Date.now() - 10_000)), [item({ realizedPnl: 1 })]);
    const out = await send('G1', iso(new Date(Date.now() - 5_000)), [item({ realizedPnl: 2 })]);
    expect(out).toEqual({ recorded: 0, throttled: true, cycleStart: null });
    expect(Number((await storedRows('G1'))[0].realized_pnl)).toBe(1);
  });

  it('refuses a post with one bad item and writes NOTHING from it', async () => {
    await resetSamples();
    const now = Date.now();
    const sampled = iso(new Date(now - 10_000));
    const bad = [
      { strategyId: '' },
      { strategyId: ' 12' },
      { accountName: 'x'.repeat(201) },
      { instrumentRoot: 'X'.repeat(17) },
      { realizedPnl: '12' },
      { unrealizedPnl: 2e12 },
      { restartedAt: iso(new Date(now)) },
      { restartedAt: iso(new Date(now - 26 * 3600_000)) },
      { restartedAt: 'yesterday' },
      { algorithm: undefined },
    ];
    for (const override of bad) {
      const refusal = await refusalOfSend(world.devices.G1, sampled,
        [item({ strategyId: 'good' }), item(override)]);
      expect(refusal, JSON.stringify(override)).toMatch(/INVALID_STRATEGY_SAMPLE/);
    }
    expect(await storedRows('G1')).toEqual([]);
  });

  it('refuses the same instance twice in one post', async () => {
    await resetSamples();
    expect(await refusalOfSend(world.devices.G1, iso(new Date(Date.now() - 10_000)),
      [item(), item({ realizedPnl: 1 })])).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await storedRows('G1')).toEqual([]);
  });

  it('refuses more instances than the settings allow, and the cap is the column', async () => {
    await resetSamples();
    await db.exec('update public.algorithm_live_settings set max_strategies_per_report = 2 where id');
    const three = ['1', '2', '3'].map((id) => item({ strategyId: id }));
    const sampled = iso(new Date(Date.now() - 10_000));
    expect(await refusalOfSend(world.devices.G1, sampled, three)).toMatch(/INVALID_STRATEGY_SAMPLE/);
    await db.exec('update public.algorithm_live_settings set max_strategies_per_report = 3 where id');
    expect((await send('G1', sampled, three)).recorded).toBe(3);
  });

  it('refuses a revoked device and a reading from the future', async () => {
    await resetSamples();
    expect(await refusalOfSend(world.revokedDevice, iso(new Date()), [item()]))
      .toMatch(/INVALID_INGEST_DEVICE/);
    expect(await refusalOfSend(world.devices.G1, iso(new Date(Date.now() + 10 * 60_000)), [item()]))
      .toMatch(/INVALID_STRATEGY_SAMPLE/);
  });

  it('sweeps this device\'s readings past the retention window and nobody else\'s', async () => {
    await resetSamples();
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const client of ['G1', 'B1']) {
      await db.query(`insert into public.algorithm_live_samples (device_id, client_id, account_name, strategy_id,
        strategy_name, algorithm, instrument, instrument_root, sampled_at, reported_at)
        values ($1, $2, 'OLD', 'old', '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', $3, $3)`,
      [world.devices[client], world.clients[client], iso(old)]);
    }
    await send('G1', iso(new Date(Date.now() - 10_000)), [item()]);
    expect((await storedRows('G1')).map((row) => row.account_name)).toEqual(['SIM-FIXTURE-1']);
    expect((await storedRows('B1')).map((row) => row.account_name)).toEqual(['OLD']);
  });

  it('never touches the account tracker: its rows survive a strategy post and a refused one', async () => {
    await resetSamples();
    await db.exec('delete from public.account_live_samples');
    const sampled = iso(new Date(Date.now() - 10_000));
    await one(db, 'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb)', [
      world.devices.G1, sampled,
      JSON.stringify([{ accountName: 'SIM-FIXTURE-1', connected: true, realizedPnl: 1, unrealizedPnl: 2, totalPnl: 3 }]),
    ]);
    const fingerprint = () => one(db,
      "select coalesce(string_agg(t::text, '|' order by t::text), '<empty>') from public.account_live_samples as t");
    const before = await fingerprint();
    expect(before).not.toBe('<empty>');
    await send('G1', sampled, [item()]);
    expect(await refusalOfSend(world.devices.G1, sampled, [item({ strategyId: '' })])).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await fingerprint()).toBe(before);
  });

  it('refuses NaN and absurd money at the table, whoever writes', async () => {
    for (const value of ["'NaN'", '2e12']) {
      await expect(db.query(`insert into public.algorithm_live_samples (device_id, client_id, account_name,
        strategy_id, strategy_name, algorithm, instrument, instrument_root, realized_pnl, sampled_at)
        values ($1, $2, 'N', 'n', '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', ${value}, now())`,
      [world.devices.G1, world.clients.G1])).rejects.toThrow(/check constraint|overflow/);
    }
  });
});

/* ── algorithm_live_desk ─────────────────────────────────────────────────── */

describe('algorithm_live_desk', () => {
  /* The outside cohort Gray sees: five accounts from five of Birch's and the
   * unassigned clients, median -500, median absolute deviation 20. */
  async function outsideCohort(cycle, { clients = ['B1', 'B2', 'B3', 'B4', 'U1'] } = {}) {
    const values = [-500, -450, -520, -600, -480];
    for (let i = 0; i < values.length; i += 1) {
      await reading({ client: clients[i], account: `OUT-${i}`, realized: values[i], cycle });
    }
  }

  beforeAll(resetSamples);

  it('answers nothing to a session with no user, an unknown user, or an inactive one', async () => {
    await resetSamples();
    await outsideCohort(boundary(1));
    expect(await desk(null)).toEqual([]);
    expect(await desk(world.strangerAuth)).toEqual([]);
    expect(await desk(world.inactiveAuth)).toEqual([]);
    expect((await desk(world.gray.auth)).length).toBeGreaterThan(0);
  });

  it('answers nothing when there is no cycle at all', async () => {
    await resetSamples();
    await reading({ client: 'B1', cycle: null });
    expect(await desk(world.gray.auth)).toEqual([]);
    expect(await desk(world.managerAuth)).toEqual([]);
  });

  it('gives a CAM the rest of the desk: its own clients do not move the median', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await outsideCohort(cycle);
    await reading({ client: 'G1', account: 'MINE', realized: 1_000_000, cycle });
    const row = cohort(await desk(world.gray.auth));
    expect(row).toMatchObject({
      scope: 'rest_of_desk', status: 'compared', n_accounts: 5, n_clients: 5, n_flat: 0,
    });
    expect(Number(row.median)).toBe(-500);
    expect(Number(row.spread)).toBe(20);
    expect(new Date(row.cycle_start).toISOString()).toBe(cycle.toISOString());

    const managerRow = cohort(await desk(world.managerAuth));
    expect(managerRow).toMatchObject({ scope: 'desk', status: 'compared', n_accounts: 6, n_clients: 6 });
    expect(Number(managerRow.median)).toBe(-490);
  });

  it('counts the floor OUTSIDE the book, accounts and clients separately', async () => {
    await resetSamples();
    const cycle = boundary(1);
    // Five accounts from TWO outside clients: enough accounts, too few clients.
    await outsideCohort(cycle, { clients: ['B1', 'B1', 'B2', 'B2', 'B2'] });
    const thin = cohort(await desk(world.gray.auth));
    expect(thin.status).toBe('thin');

    // A third outside client makes it compared.
    await db.exec('delete from public.algorithm_live_samples');
    await outsideCohort(cycle, { clients: ['B1', 'B1', 'B2', 'B2', 'B3'] });
    expect(cohort(await desk(world.gray.auth))).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 3 });

    // And the floor is the column.
    await db.exec('update public.algorithm_live_settings set min_cohort_accounts = 6 where id');
    expect(cohort(await desk(world.gray.auth)).status).toBe('thin');
    await db.exec('update public.algorithm_live_settings set min_cohort_accounts = 5, min_cohort_clients = 2 where id');
    await db.exec('delete from public.algorithm_live_samples');
    await outsideCohort(cycle, { clients: ['B1', 'B1', 'B2', 'B2', 'B2'] });
    expect(cohort(await desk(world.gray.auth)).status).toBe('compared');
  });

  it('withholds every number of a thin cohort, counts included', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await reading({ client: 'B1', account: 'T1', realized: -100, cycle });
    await reading({ client: 'B2', account: 'T2', realized: -200, cycle });
    expect(cohort(await desk(world.gray.auth))).toMatchObject({
      status: 'thin', n_accounts: null, n_clients: null, median: null, spread: null, n_flat: null,
    });
  });

  it('the measured differencing case: seven accounts, three of them the caller\'s', async () => {
    await resetSamples();
    const cycle = boundary(1);
    for (const [i, client] of ['G1', 'G2', 'G3', 'B1', 'B2', 'B3', 'U1'].entries()) {
      await reading({ client, account: `D-${i}`, realized: -100 * (i + 1), cycle });
    }
    expect(cohort(await desk(world.gray.auth))).toMatchObject({ status: 'thin', median: null });
    expect(cohort(await desk(world.managerAuth))).toMatchObject({ status: 'compared', n_accounts: 7 });
  });

  it('leaves out restarted accounts and accounts with a part not measured', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await outsideCohort(cycle);
    const restartedAt = iso(new Date(cycle.getTime() - 30 * 60_000));
    await reading({ client: 'U2', account: 'RESTARTED', realized: 90_000, restartedAt, cycle });
    // One instance measured and one not: the whole account is unusable.
    await reading({ client: 'U2', account: 'HALF', realized: 70_000, cycle });
    await reading({ client: 'U2', account: 'HALF', realized: null, unrealized: 10, cycle });
    const row = cohort(await desk(world.managerAuth));
    expect(row.n_accounts).toBe(5);
    expect(Number(row.median)).toBe(-500);
  });

  it('sums the instances of one account into one value', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await outsideCohort(cycle);
    await db.exec("delete from public.algorithm_live_samples where account_name = 'OUT-4'");
    await reading({ client: 'U1', account: 'OUT-4', realized: -300, cycle });
    await reading({ client: 'U1', account: 'OUT-4', realized: -100, unrealized: -100, cycle });
    const row = cohort(await desk(world.managerAuth));
    expect(row.n_accounts).toBe(5);
    // -500 summed from two instances keeps the median at -500.
    expect(Number(row.median)).toBe(-500);
    expect(Number(row.spread)).toBe(20);
  });

  it('reads only the newest cycle: an older cycle and an off cycle row are left out', async () => {
    await resetSamples();
    const current = boundary(1);
    await outsideCohort(current);
    await reading({ client: 'U2', account: 'OLD-CYCLE', realized: 1_000_000, cycle: boundary(2) });
    await reading({ client: 'U2', account: 'OFF-CYCLE', realized: 1_000_000, cycle: null });
    const row = cohort(await desk(world.managerAuth));
    expect(row.n_accounts).toBe(5);
    expect(Number(row.median)).toBe(-500);
    expect(new Date(row.cycle_start).toISOString()).toBe(current.toISOString());
  });

  it('never compares a cycle still filling, and never falls back to the one it is draining', async () => {
    await resetSamples();
    await outsideCohort(boundary(1));
    // One machine has already posted a cycle that started ten seconds ago.
    const filling = new Date(Date.now() - 10_000);
    await db.query(`insert into public.algorithm_live_samples (device_id, client_id, account_name, strategy_id,
      strategy_name, algorithm, instrument, instrument_root, realized_pnl, unrealized_pnl, sampled_at, cycle_start)
      values ($1, $2, 'NEW', 'new', '0 - OGX-1.0', 'OGX_PF', 'MNQ 12-26', 'MNQ', 1, 1, $3, $3)`,
    [world.devices.U2, world.clients.U2, iso(filling)]);
    const rows = await desk(world.managerAuth);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ algorithm: null, status: 'filling', median: null, n_accounts: null });

    // Once the tolerance has passed, the same cycle is compared.
    await db.exec('update public.algorithm_live_settings set cycle_tolerance_seconds = 10 where id');
    await db.query("update public.algorithm_live_samples set cycle_start = cycle_start - interval '20 seconds', sampled_at = sampled_at - interval '20 seconds' where account_name = 'NEW'");
    const later = await desk(world.managerAuth);
    expect(later.every((row) => row.status !== 'filling')).toBe(true);
    expect(cohort(later).status).toBe('thin');
  });

  it('says there is a cycle when nothing outside the caller\'s book ran in it', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await reading({ client: 'G1', account: 'ONLY-MINE', realized: -10, cycle });
    const rows = await desk(world.gray.auth);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ algorithm: null, status: 'no_cohort', scope: 'rest_of_desk' });
    expect(new Date(rows[0].cycle_start).toISOString()).toBe(cycle.toISOString());
  });

  it('keeps instruments apart: MNQ and NQ are two cohorts', async () => {
    await resetSamples();
    const cycle = boundary(1);
    await outsideCohort(cycle);
    await reading({ client: 'U2', account: 'NQ-1', root: 'NQ', realized: -5000, cycle });
    const rows = await desk(world.managerAuth);
    expect(cohort(rows, 'OGX_PF', 'MNQ')).toMatchObject({ n_accounts: 5 });
    expect(cohort(rows, 'OGX_PF', 'NQ')).toMatchObject({ status: 'thin' });
  });

  it('rounds to whole dollars and counts the flat accounts', async () => {
    await resetSamples();
    const cycle = boundary(1);
    for (const [i, client] of ['B1', 'B2', 'B3', 'B4', 'U1'].entries()) {
      await reading({ client, account: `F-${i}`, realized: [0, 0, 0, 10.4, -7.25][i], cycle });
    }
    const row = cohort(await desk(world.gray.auth));
    expect(row.n_flat).toBe(3);
    expect(Number(row.median)).toBe(0);
    expect(Number.isInteger(Number(row.spread))).toBe(true);
  });
});

/* ── A CAM cannot fill the outside cohort with clients she controls ───────── */

describe('algorithm_live_desk against a CAM who controls clients outside her book', () => {
  /* THE ATTACK, replayed through the real policies and the real functions. A CAM
   * may create a client (step 52), assign it to herself (step 53's
   * clients_i_created arm), get an enrollment code for it (the route checks only
   * the assignment), pair a VPS with that code and so hold a device credential,
   * and then delete her own assignment row (step 53's `for all` policy lets
   * her). Left out of her book only by assigned_client_ids(), those clients'
   * readings counted as the rest of the desk: with two of them she met the floor
   * on her own and, placing her values on both sides of one real account, made
   * the median that account's value to the dollar.
   *
   * SINCE STEP 60 SHE CANNOT DROP THE ROW HERSELF. Only a Manager deletes or
   * hands off an assignment now, so the clients below leave her book the one
   * way that remains, a Manager moving them, and the exclusion this describe
   * tests is exactly what still matters after that: a client she created or
   * enrolled stays hers whoever holds it. Each step first asserts her own
   * attempt is refused, so the replay still says which hole step 60 closed. */

  /** Runs one statement as `role` with `subject` signed in, and KEEPS its effect. */
  async function committedAsRole(role, subject, sql, params) {
    await db.exec('begin');
    try {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', subject]);
      await db.exec(`set local role ${role}`);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  }

  async function appUserOf(auth) {
    return one(db, 'select id from public.app_users where auth_user_id = $1', [auth]);
  }

  /** A CAM creates a client through the browser, and assigns it to herself. */
  async function camCreatesClient(cam, key) {
    const [created] = await committedAsRole('authenticated', cam.auth,
      "insert into public.clients (name, status, product_key) values ($1, 'Active', $2) returning id",
      [`Client ${key}`, `pk-${key}`]);
    await committedAsRole('authenticated', cam.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
      [created.id, cam.profile]);
    world.clients[key] = created.id;
    return created.id;
  }

  /** The enrollment route's call, then the pairing route's: a live device credential. */
  async function enrollAndPair(key, createdByAppUser) {
    await db.query(
      `select * from public.create_ingest_enrollment($1, $2, $3, now() + interval '1 hour', false, 'generated', null)`,
      [world.clients[key], `code-${key}`, createdByAppUser]);
    world.devices[key] = await one(db,
      `select device_id from public.pair_ingest_device_v2($1, $2, $3, $4, '1.2.0', '1.2.0')`,
      [`code-${key}`, `machine-${key}`, `credential-${key}`, `pfx-${key}`]);
  }

  /** Her own delete finds nothing since step 60; a Manager's removes the row. */
  async function assignmentLeavesHerBook(cam, key) {
    const own = await committedAsRole('authenticated', cam.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning client_id',
      [world.clients[key], cam.profile]);
    expect(own).toHaveLength(0);
    const dropped = await committedAsRole('authenticated', world.managerAuth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning client_id',
      [world.clients[key], cam.profile]);
    expect(dropped).toHaveLength(1);
  }

  async function grayAssigned() {
    return (await rowsAsRole(db, 'authenticated', 'select public.assigned_client_ids() as id',
      { subject: world.gray.auth })).map((row) => row.id);
  }

  it('the full chain: her two paired clients do not count, so one other account is never the median', async () => {
    await resetSamples();
    const grayUser = await appUserOf(world.gray.auth);
    for (const key of ['F1', 'F2']) {
      await camCreatesClient(world.gray, key);
      await enrollAndPair(key, grayUser);
      await assignmentLeavesHerBook(world.gray, key);
    }
    expect(await grayAssigned()).not.toContain(world.clients.F1);

    // The paired device is live: the real ingest function takes its reading.
    expect((await send('F1', iso(new Date()), [item()])).recorded).toBe(1);
    await resetSamples();

    // Birch's client B3, one account, that nobody else outside Gray's book runs.
    const cycle = boundary(1);
    await reading({ client: 'B3', account: 'TARGET', realized: -1234.56, cycle });
    await reading({ client: 'F1', account: 'X1', realized: -900_000_000, cycle });
    await reading({ client: 'F1', account: 'X2', realized: -900_000_000, cycle });
    await reading({ client: 'F2', account: 'Y1', realized: 900_000_000, cycle });
    await reading({ client: 'F2', account: 'Y2', realized: 900_000_000, cycle });

    // The readings are in the cycle: the manager's desk has all five.
    expect(cohort(await desk(world.managerAuth))).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 3 });
    expect(Number(cohort(await desk(world.managerAuth)).median)).toBe(-1235);

    // Gray's outside cohort is the one real account, so it says nothing.
    const gray = cohort(await desk(world.gray.auth));
    expect(gray).toMatchObject({ status: 'thin', n_accounts: null, median: null });

    // Handing them to another CAM does not put them outside her book either.
    // Since step 60 only a Manager can: Gray's own attempt is refused.
    for (const key of ['F1', 'F2']) {
      await expect(committedAsRole('authenticated', world.gray.auth,
        'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
        [world.clients[key], world.birch.profile]))
        .rejects.toThrow(/row-level security policy "assignments: a cam assigns only a new client, to itself"/);
      await committedAsRole('authenticated', world.managerAuth,
        'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
        [world.clients[key], world.birch.profile]);
    }
    expect(cohort(await desk(world.gray.auth))).toMatchObject({ status: 'thin', median: null });
  });

  /* Four genuine outside accounts and one from the client under test: the floor
   * of five is met only if that client is counted as outside. */
  async function fourOutsidePlus(key) {
    await resetSamples();
    const cycle = boundary(1);
    for (const [i, client] of ['B1', 'B2', 'B4', 'U1'].entries()) {
      await reading({ client, account: `REAL-${i}`, realized: -500 - 10 * i, cycle });
    }
    await reading({ client: key, account: 'PLACED', realized: -480, cycle });
    return cohort(await desk(world.gray.auth));
  }

  /* Birch's view: four clients outside her book and the client under test. */
  async function fiveOutsideBirch(key) {
    await resetSamples();
    const cycle = boundary(1);
    for (const [i, client] of ['G1', 'G2', 'U1', 'U2', key].entries()) {
      await reading({ client, account: `FOR-BIRCH-${i}`, realized: -100 * (i + 1), cycle });
    }
    return cohort(await desk(world.birch.auth));
  }

  it('a client she created stays hers, even paired under someone else\'s code', async () => {
    await camCreatesClient(world.gray, 'F3');
    await enrollAndPair('F3', await appUserOf(world.managerAuth));
    await assignmentLeavesHerBook(world.gray, 'F3');
    expect(await grayAssigned()).not.toContain(world.clients.F3);
    expect(await fourOutsidePlus('F3')).toMatchObject({ status: 'thin', n_accounts: null });
    // The same five, with an outside client in place of hers, are compared.
    expect(await fourOutsidePlus('B3')).toMatchObject({ status: 'compared', n_accounts: 5 });
    // And it is left out of GRAY's figure only: Birch did not create it.
    expect(await fiveOutsideBirch('F3')).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 5 });
  });

  it('a client she enrolled stays hers, even one she did not create', async () => {
    // A client the desk created and assigned to Gray, enrolled by Gray, which
    // she then drops from her own book.
    world.clients.E1 = await one(db,
      "insert into public.clients (name, status, product_key) values ('Client E1', 'Active', 'pk-E1') returning id");
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
      [world.clients.E1, world.gray.profile]);
    await enrollAndPair('E1', await appUserOf(world.gray.auth));
    await assignmentLeavesHerBook(world.gray, 'E1');
    expect(await grayAssigned()).not.toContain(world.clients.E1);
    expect(await fourOutsidePlus('E1')).toMatchObject({ status: 'thin', n_accounts: null });

    // It is left out of GRAY's figure only. For Birch, who neither created nor
    // enrolled it, it is the rest of the desk like any other client.
    expect(await fiveOutsideBirch('E1')).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 5 });
  });

  it('a manager still sees every one of those clients in the desk figure', async () => {
    await resetSamples();
    const cycle = boundary(1);
    for (const [i, client] of ['F1', 'F2', 'F3', 'E1', 'B1'].entries()) {
      await reading({ client, account: `M-${i}`, realized: -100 * (i + 1), cycle });
    }
    expect(cohort(await desk(world.managerAuth))).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 5 });
  });
});
