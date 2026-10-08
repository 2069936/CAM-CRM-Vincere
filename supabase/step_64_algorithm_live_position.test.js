/* STEP 64, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 63 and seeded with two CAMs, a
 * Manager and their machines. BEFORE 64 the function is shown to accept a 1.2.1
 * shaped item and drop its position, which is the compatibility the rollout
 * relies on. Then 64 runs the way Pedro runs it, after the function's grants
 * have been pushed out of place on purpose, and every verdict afterwards is the
 * database's own: what the columns hold, what a CAM and a Manager can read,
 * what each role may execute, what the constraints refuse, and what a re-run
 * of 57 on top does.
 *
 * The route's own normaliser feeds the shared fixture into the real function,
 * so a key renamed on either side fails here.
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
import { normalizeStrategySampleBody } from '../server/autoCollection/ingest/strategies.js';

const STEP = 'step_64_algorithm_live_position.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const SIGNATURE = 'public.record_algorithm_live_sample(uuid, timestamptz, jsonb)';
const DENIED = /permission denied/i;
const POSITION_COLUMNS = ['market_position', 'position_quantity', 'trades_this_run'];

let db;
const world = { clients: {}, devices: {} };

function iso(date) {
  return date.toISOString();
}

/** One item as the route hands it to the function, with the position of a 1.2.1 agent. */
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
    marketPosition: 'long',
    positionQuantity: 2,
    tradesThisRun: 7,
    ...overrides,
  };
}

/** The same item as a 1.2.0 agent's route would build it: no position keys at all. */
function item120(overrides = {}) {
  const row = item(overrides);
  for (const key of ['marketPosition', 'positionQuantity', 'tradesThisRun']) delete row[key];
  return row;
}

/** One report through the real function, the way the route calls it. */
async function send(client, strategies, sampledAt = iso(new Date(Date.now() - 10_000))) {
  return one(db,
    'select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb) as out',
    [world.devices[client], sampledAt, JSON.stringify(strategies)]);
}

async function refusalOfSend(deviceId, strategies, sampledAt = iso(new Date(Date.now() - 10_000))) {
  try {
    await db.query('select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb)',
      [deviceId, sampledAt, JSON.stringify(strategies)]);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

async function storedRows(client) {
  return (await db.query(
    `select account_name, strategy_id, realized_pnl, market_position, position_quantity, trades_this_run
       from public.algorithm_live_samples where device_id = $1 order by account_name, strategy_id`,
    [world.devices[client]])).rows;
}

async function resetSamples() {
  await db.exec('delete from public.algorithm_live_samples');
}

/** The throttle compares now against reported_at; moving it back is the clock moving on. */
async function timePasses(client) {
  await db.query(`update public.algorithm_live_samples
    set reported_at = reported_at - interval '10 minutes' where device_id = $1`, [world.devices[client]]);
}

async function positionColumns() {
  return (await db.query(
    `select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'algorithm_live_samples'
        and column_name = any($1) order by column_name`, [POSITION_COLUMNS])).rows;
}

async function constraints() {
  return (await db.query(
    `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'public.algorithm_live_samples'::regclass
        and conname like 'algorithm_live_samples_%'
          and (conname like '%market_position%' or conname like '%position_quantity%' or conname like '%trades_this_run%')
      order by conname`)).rows;
}

async function functionDefinition() {
  return one(db, `select pg_get_functiondef('${SIGNATURE}'::regprocedure)`);
}

/** Every role holding EXECUTE on the function, straight from the ACL. */
async function executeGrantees() {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${SIGNATURE}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 63 }));

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

  for (const [key, owner] of [['G1', world.gray], ['B1', world.birch]]) {
    world.clients[key] = await one(db, 'insert into public.clients (name) values ($1) returning id', [`Client ${key}`]);
    await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
      [world.clients[key], owner.profile]);
    world.devices[key] = await one(db,
      'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clients[key]]);
  }
  world.revokedDevice = await one(db,
    `insert into public.ingest_devices (client_id, status, revoked_at)
     values ($1, 'revoked', now()) returning id`, [world.clients.B1]);

  // Quick cycles so a reading taken a few seconds ago is never throttled by
  // the previous test's; the throttle itself is step 57's business.
  await db.exec('update public.account_tracker_settings set min_report_interval_seconds = 60 where id');

  // BEFORE 64: a 1.2.1 agent's item, with the position, against step 57's
  // function. It must land and the position must simply be dropped: that is
  // what a VPS updated before Pedro runs this file does.
  world.before = {
    columns: await positionColumns(),
    accepted: await send('G1', [item()]),
    definition: await functionDefinition(),
  };
  world.before.stored = (await db.query(
    'select realized_pnl from public.algorithm_live_samples where device_id = $1', [world.devices.G1])).rows;
  await resetSamples();

  // THE DRIFT, INSTALLED ON PURPOSE. PostgreSQL keeps a function's ACL across
  // CREATE OR REPLACE, so a file that forgot its grants would pass every grant
  // assertion here by inheriting step 57's. The ACL is first put where a stray
  // SQL editor session could leave it, and 64 has to put it back.
  await db.exec(`grant execute on function ${SIGNATURE} to anon, authenticated;
                 revoke execute on function ${SIGNATURE} from service_role;`);
  world.before.grantees = await executeGrantees();

  world.notices = await applyFileCollectingNotices(db, STEP);
  world.after = { definition: await functionDefinition() };
}, 120_000);

afterAll(async () => { await db?.close?.(); });

describe('before step 64, a 1.2.1 agent already lands and loses only its position', () => {
  it('the columns did not exist', () => {
    expect(world.before.columns).toEqual([]);
  });

  it('the item with the position keys was accepted by step 57\'s function and stored without them', () => {
    expect(world.before.accepted).toMatchObject({ recorded: 1, throttled: false });
    expect(world.before.stored).toHaveLength(1);
    expect(Number(world.before.stored[0].realized_pnl)).toBe(-412.5);
  });

  it('the file replaced the function and said nothing beyond "skipping" on a first run', () => {
    // `drop constraint if exists` says "does not exist, skipping" the first
    // time; `add column if not exists` says "already exists, skipping" the
    // second. Both are the file being idempotent, not a warning.
    expect(world.after.definition).not.toBe(world.before.definition);
    expect(world.notices.filter((n) => !/skipping/.test(n))).toEqual([]);
    expect(world.notices.filter((n) => /does not exist, skipping/.test(n))).toHaveLength(3);
  });
});

describe('the three columns', () => {
  it('exist, nullable, as text and two integers', async () => {
    expect(await positionColumns()).toEqual([
      { column_name: 'market_position', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'position_quantity', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'trades_this_run', data_type: 'integer', is_nullable: 'YES' },
    ]);
  });

  it('each carries its own CHECK, under its own name', async () => {
    const rows = await constraints();
    expect(rows.map((row) => row.conname)).toEqual([
      'algorithm_live_samples_market_position_check',
      'algorithm_live_samples_position_quantity_check',
      'algorithm_live_samples_trades_this_run_check',
    ]);
    expect(rows[0].definition).toMatch(/'long'.*'short'.*'flat'/);
    expect(rows[1].definition).toMatch(/0.*100000/);
    expect(rows[2].definition).toMatch(/0.*1000000/);
  });

  it('refuse a word that is not one of the three and a count out of bounds, whoever writes', async () => {
    let seq = 0;
    const insert = (columns, values) => db.query(`insert into public.algorithm_live_samples (device_id, client_id,
      account_name, strategy_id, strategy_name, algorithm, instrument, instrument_root, sampled_at, ${columns})
      values ($1, $2, 'C', $3, '0 - OGX-1.0', 'OGX', 'MNQ 12-26', 'MNQ', now(), ${values})`,
    [world.devices.G1, world.clients.G1, `c${seq += 1}`]);
    for (const [columns, values] of [
      ['market_position', "'Long'"],
      ['market_position', "'sideways'"],
      ['market_position', "''"],
      ['position_quantity', '-1'],
      ['position_quantity', '100001'],
      ['trades_this_run', '-1'],
      ['trades_this_run', '1000001'],
    ]) {
      await expect(insert(columns, values), `${columns} = ${values}`).rejects.toThrow(/check constraint/);
    }
    await insert('market_position, position_quantity, trades_this_run', "'short', 3, 12");
    await insert('market_position, position_quantity, trades_this_run', "'flat', 0, 0");
    await insert('market_position, position_quantity, trades_this_run', "'long', 100000, 1000000");
    expect(await one(db, 'select count(*)::int from public.algorithm_live_samples')).toBe(3);
    await resetSamples();
  });
});

describe('record_algorithm_live_sample, same signature, position inside the items', () => {
  beforeAll(resetSamples);

  it('is still the one function of that name, and resolves by argument names the way PostgREST calls it', async () => {
    expect(await one(db,
      "select count(*)::int from pg_proc where proname = 'record_algorithm_live_sample' and pronamespace = 'public'::regnamespace")).toBe(1);
    expect(await one(db, "select pg_get_function_identity_arguments('" + SIGNATURE + "'::regprocedure)"))
      .toBe('p_device_id uuid, p_sampled_at timestamp with time zone, p_strategies jsonb');
    const out = await one(db, `select public.record_algorithm_live_sample(
        p_device_id => $1, p_sampled_at => $2::timestamptz, p_strategies => $3::jsonb) as out`,
    [world.devices.G1, iso(new Date(Date.now() - 10_000)), JSON.stringify([item({ strategyId: 'named' })])]);
    expect(out).toMatchObject({ recorded: 1, throttled: false });
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'long', position_quantity: 2, trades_this_run: 7 });
    await resetSamples();
  });

  it('a 1.2.0 item (no position keys) lands and the three columns are null', async () => {
    await resetSamples();
    const out = await send('G1', [item120(), item120({ strategyId: '2' })]);
    expect(out).toMatchObject({ recorded: 2, throttled: false });
    const rows = await storedRows('G1');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ market_position: null, position_quantity: null, trades_this_run: null });
      expect(Number(row.realized_pnl)).toBe(-412.5);
    }
  });

  it('a 1.2.1 item stores the word, the contracts and the run count; an explicit null stays null', async () => {
    await resetSamples();
    const out = await send('G1', [
      item(),
      item({ strategyId: '2', marketPosition: 'short', positionQuantity: 1, tradesThisRun: 0 }),
      item({ strategyId: '3', marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 12 }),
      item({ strategyId: '4', marketPosition: null, positionQuantity: null, tradesThisRun: null }),
      item({ strategyId: '5', marketPosition: 'long', positionQuantity: null, tradesThisRun: 3 }),
    ]);
    expect(out.recorded).toBe(5);
    const rows = await storedRows('G1');
    expect(rows.map((row) => [row.strategy_id, row.market_position, row.position_quantity, row.trades_this_run])).toEqual([
      ['123456789', 'long', 2, 7],
      ['2', 'short', 1, 0],
      ['3', 'flat', 0, 12],
      ['4', null, null, null],
      ['5', 'long', null, 3],
    ]);
  });

  it('takes exactly what the route forwards: the shared fixture through the route\'s normaliser', async () => {
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
    const out = await send('G1', normalized.strategies, normalized.sampledAt);
    expect(out.recorded).toBe(2);
    const rows = await storedRows('G1');
    expect(rows[0]).toMatchObject({ strategy_id: '123456789', market_position: 'long', position_quantity: 2, trades_this_run: 7 });
    expect(rows[1]).toMatchObject({ strategy_id: '123456790', market_position: null, position_quantity: null, trades_this_run: null });
  });

  it('the route\'s upper case word reaches SQL lower case, and SQL alone takes only the three words', async () => {
    await resetSamples();
    const normalized = normalizeStrategySampleBody({
      schemaVersion: 1,
      sampledAt: new Date(Date.now() - 10_000).toISOString(),
      strategies: [{ accountName: 'SIM-FIXTURE-1', strategyId: '1', strategyName: '0 - OGX-PF-2.4',
        instrument: 'MNQ 12-26', marketPosition: 'SHORT', positionQuantity: 4, tradesThisRun: 1 }],
    });
    expect(normalized.strategies[0].marketPosition).toBe('short');
    await send('G1', normalized.strategies, normalized.sampledAt);
    expect((await storedRows('G1'))[0].market_position).toBe('short');
    // Straight at the function, a word the column would refuse is refused for the whole post.
    for (const word of ['Long', 'SHORT', 'sideways', '', ' flat']) {
      expect(await refusalOfSend(world.devices.G1, [item({ strategyId: 'w', marketPosition: word })]), word)
        .toMatch(/INVALID_STRATEGY_SAMPLE/);
    }
  });

  it('a later reading without a position clears it: the row is the latest reading, not a merge', async () => {
    await resetSamples();
    await send('G1', [item()]);
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'long', position_quantity: 2, trades_this_run: 7 });
    await timePasses('G1');
    await send('G1', [item120()], iso(new Date(Date.now() - 5_000)));
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: null, position_quantity: null, trades_this_run: null });
    await timePasses('G1');
    await send('G1', [item({ marketPosition: 'short', positionQuantity: 1, tradesThisRun: 8 })], iso(new Date(Date.now() - 2_000)));
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'short', position_quantity: 1, trades_this_run: 8 });
  });

  it('an older reading never walks a newer position back', async () => {
    await resetSamples();
    await send('G1', [item({ marketPosition: 'short', positionQuantity: 1, tradesThisRun: 9 })], iso(new Date(Date.now() - 5_000)));
    await timePasses('G1');
    const out = await send('G1', [item({ marketPosition: 'long', positionQuantity: 2, tradesThisRun: 7 })], iso(new Date(Date.now() - 60_000)));
    expect(out.recorded).toBe(0);
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'short', position_quantity: 1, trades_this_run: 9 });
  });

  it('refuses a post with one bad position value and writes NOTHING from it', async () => {
    await resetSamples();
    const bad = [
      { marketPosition: 1 },
      { marketPosition: true },
      { marketPosition: 'Long' },
      { positionQuantity: -1 },
      { positionQuantity: 100001 },
      { positionQuantity: 1.5 },
      { positionQuantity: '2' },
      { tradesThisRun: -1 },
      { tradesThisRun: 1000001 },
      { tradesThisRun: 2.5 },
      { tradesThisRun: '7' },
    ];
    for (const override of bad) {
      const refusal = await refusalOfSend(world.devices.G1, [item({ strategyId: 'good' }), item(override)]);
      expect(refusal, JSON.stringify(override)).toMatch(/INVALID_STRATEGY_SAMPLE/);
    }
    expect(await storedRows('G1')).toEqual([]);
    // And exactly at the edges it is taken.
    const out = await send('G1', [item({ positionQuantity: 100000, tradesThisRun: 1000000 }), item({ strategyId: 'z', positionQuantity: 0, tradesThisRun: 0 })]);
    expect(out.recorded).toBe(2);
  });

  it('step 57\'s own refusals are where they were', async () => {
    await resetSamples();
    expect(await refusalOfSend(world.revokedDevice, [item()])).toMatch(/INVALID_INGEST_DEVICE/);
    expect(await refusalOfSend(world.devices.G1, [item()], iso(new Date(Date.now() + 10 * 60_000)))).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await refusalOfSend(world.devices.G1, [item(), item({ realizedPnl: 1 })])).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await refusalOfSend(world.devices.G1, [item({ strategyId: '' })])).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await refusalOfSend(world.devices.G1, [item({ unrealizedPnl: 2e12 })])).toMatch(/INVALID_STRATEGY_SAMPLE/);
    expect(await storedRows('G1')).toEqual([]);
  });
});

describe('who reads the position', () => {
  beforeAll(async () => {
    await resetSamples();
    await send('G1', [item()]);
    await send('B1', [item({ accountName: 'SIM-FIXTURE-2', marketPosition: 'short', positionQuantity: 1, tradesThisRun: 3 })]);
  });

  it('a CAM reads the new columns on her own clients\' rows and nobody else\'s', async () => {
    const select = 'select client_id, market_position, position_quantity, trades_this_run from public.algorithm_live_samples order by account_name';
    const gray = await rowsAsRole(db, 'authenticated', select, { subject: world.gray.auth });
    expect(gray).toEqual([{ client_id: world.clients.G1, market_position: 'long', position_quantity: 2, trades_this_run: 7 }]);
    const birch = await rowsAsRole(db, 'authenticated', select, { subject: world.birch.auth });
    expect(birch).toEqual([{ client_id: world.clients.B1, market_position: 'short', position_quantity: 1, trades_this_run: 3 }]);
  });

  it('a Manager reads every row', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select market_position from public.algorithm_live_samples order by market_position', { subject: world.managerAuth });
    expect(rows.map((row) => row.market_position)).toEqual(['long', 'short']);
  });

  it('anon reads nothing, and the table still holds exactly SELECT for authenticated', async () => {
    expect(await refusalAsRole(db, 'anon', 'select market_position from public.algorithm_live_samples')).toMatch(DENIED);
    expect(await privilegesOn(db, 'authenticated', 'algorithm_live_samples')).toEqual(['SELECT']);
    expect(await privilegesOn(db, 'anon', 'algorithm_live_samples')).toEqual([]);
  });

  it('a CAM still cannot write a position, hers or anyone\'s', async () => {
    for (const statement of [
      "update public.algorithm_live_samples set market_position = 'short' where true",
      'delete from public.algorithm_live_samples where true',
    ]) {
      expect(await refusalAsRole(db, 'authenticated', statement, { subject: world.gray.auth }), statement).toMatch(DENIED);
    }
  });
});

describe('grants: exactly the service role, and this file\'s own', () => {
  it('the drift installed before 64 was real: anon and authenticated held EXECUTE, service_role did not', () => {
    expect(world.before.grantees).toContain('anon');
    expect(world.before.grantees).toContain('authenticated');
    expect(world.before.grantees).not.toContain('service_role');
  });

  it('after 64 the ACL names service_role and nobody else, besides the owner', async () => {
    const grantees = await executeGrantees();
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('authenticated');
    expect(grantees).not.toContain('public');
    expect(grantees.filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('anon and authenticated are refused at the door, service_role is not', async () => {
    const call = 'select public.record_algorithm_live_sample($1, now(), $2::jsonb)';
    const params = [world.devices.G1, JSON.stringify([item({ strategyId: 'role' })])];
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, call, { params, subject: world.gray.auth }))
        .toMatch(/permission denied for function record_algorithm_live_sample/);
    }
    await resetSamples();
    expect(await refusalAsRole(db, 'service_role', call, { params })).toBeNull();
  });
});

describe('running it again, and running 57 again on top', () => {
  it('64 again is a no-op: the columns say they exist, the definition and the grants do not move', async () => {
    const before = { definition: await functionDefinition(), constraints: await constraints() };
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices.filter((n) => !/already exists, skipping/.test(n))).toEqual([]);
    expect(notices.filter((n) => /already exists, skipping/.test(n))).toHaveLength(3);
    expect(await functionDefinition()).toBe(before.definition);
    expect(await constraints()).toEqual(before.constraints);
    expect((await executeGrantees()).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    await resetSamples();
    await send('G1', [item()]);
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'long', position_quantity: 2, trades_this_run: 7 });
  });

  it('57 run again on top keeps the columns but stops filling them, and 64 run again after it fills them', async () => {
    // The hazard the runbook row names, proved rather than read from the text.
    await applyFileCollectingNotices(db, 'step_57_algorithm_live_samples.sql');
    expect(await positionColumns()).toHaveLength(3);
    await resetSamples();
    await send('G1', [item()]);
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: null, position_quantity: null, trades_this_run: null });
    await applyFileCollectingNotices(db, STEP);
    await resetSamples();
    await send('G1', [item()]);
    expect((await storedRows('G1'))[0]).toMatchObject({ market_position: 'long', position_quantity: 2, trades_this_run: 7 });
  });

  it('refuses to run on a database without step 57, and says which', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 56 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 64 needs step 57 \(algorithm_live_samples\): run it first/);
      await early.exec('rollback');
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 64 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 64)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(64);
    expect(numbers).not.toContain(54);
    for (const merged of [58, 59, 60, 61, 62, 63]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 63, and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 64 \| `step_64_algorithm_live_position\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 64 | `step_64_algorithm_live_position.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 63 | `step_63_heartbeat_without_ninjatrader_version.sql`'));
    expect(runbook).toMatch(/→ 62 → 63 → 64\./);
    expect(runbook).toContain('Step 64');
  });
});
