/* STEP 73, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 72, and then 73 runs the way
 * Pedro runs it. Every close below goes through the chain the ingest route
 * uses (claim_ingest_batch_v4, persist_auto_daily_import_v3,
 * finalize_ingest_batch_v3), so step 66's pin and this step's fill fire from
 * the finalize exactly as they do in production. The tracker is fed through
 * the two RPCs the agents call (record_account_live_sample,
 * record_algorithm_live_sample). The Manager's two replays go through step
 * 29's claim and its closed day replacement. Every verdict is the database's
 * own: what the close tables hold, which flags exist, what the functions
 * return and who may call them.
 *
 * Nothing here asserts the text of the SQL except the lines that read the
 * directory listing and the runbook, which have no other witness.
 *
 * THE CLOCK. The sample RPCs sweep old rows against the wall clock (step 55:
 * 7 days, step 57: 2 days, step 66's history: 5 days), so the trading day is
 * YESTERDAY in New York and every time is a New York clock time on it, as in
 * step 66's test.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFileCollectingNotices,
  column,
  migrationFilesInOrder,
  one,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const STEP = 'step_73_merge_daily_captures.sql';
const FILL_DAY = 'public.fill_day_from_tracker(date)';
const INTERNAL = [
  'public.persist_auto_daily_import(uuid, uuid, jsonb)',
  'public.fill_daily_import_from_tracker(uuid)',
  'public.write_close_merge_flag(uuid, uuid, uuid, text, text, text, jsonb)',
  'public.tracker_fill_on_batch()',
  'public.account_snapshots_source_guard()',
  'public.strategy_snapshots_source_guard()',
];
const NEW_KINDS = ['Capture lost activity', 'Tracker only account', 'Close below tracker'];
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const NY = 'America/New_York';

function nyDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
}
function shiftDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function offsetOn(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: NY, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${iso}T12:00:00Z`));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /([+-]\d{2}:\d{2})/.exec(name);
  return match ? match[1] : '+00:00';
}
const TODAY = nyDate(new Date());
const DAY = shiftDays(TODAY, -1);
/** An ISO instant for a New York clock time on the trading day. */
const at = (hhmm, iso = DAY) => `${iso}T${hhmm}:00${offsetOn(iso)}`;

let db;
const world = { clients: {}, imports: {} };

/* ── Builders, in the shapes reconcileDailyImport hands the RPC ─────────── */

const snap = (accountName, realized, over = {}) => ({
  accountName,
  connection: 'Northwind',
  grossRealizedPnl: realized,
  unrealizedPnl: 0,
  accountBalance: 50000 + realized,
  trailingMaxDrawdown: 2000,
  weeklyPnl: realized,
  ...over,
});
const fill = (accountName, id, over = {}) => ({
  id,
  orderId: `O-${id || 'x'}`,
  accountName,
  strategyName: '0 - OGX-PF-2.4',
  instrument: 'MNQ 12-26',
  action: 'Buy',
  quantity: 1,
  price: 21000,
  time: `${DAY} 10:00:00`,
  entryExit: 'Entry',
  position: '1L',
  name: 'Entry',
  commission: 0,
  rate: 1,
  connection: 'Northwind',
  ...over,
});
const order = (accountName, id, over = {}) => ({
  id,
  accountName,
  strategyName: '0 - OGX-PF-2.4',
  instrument: 'MNQ 12-26',
  action: 'Buy',
  orderType: 'Market',
  quantity: 1,
  limit: 0,
  stop: 0,
  state: 'Working',
  filled: 0,
  avgPrice: 0,
  remaining: 1,
  name: 'Entry',
  time: `${DAY} 10:00:00`,
  ...over,
});
const strat = (accountName, strategyName, instrument, realized, over = {}) => ({
  accountName,
  strategyName,
  strategyFamily: 'OGX_PF',
  instrument,
  realized,
  unrealized: 0,
  enabled: false,
  ran: true,
  ranBasis: 'fills',
  ...over,
});

/* ── The chain the ingest route runs ─────────────────────────────────────── */

async function newClient(name) {
  const client = await one(db, 'insert into public.clients (name) values ($1) returning id', [name]);
  const device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
  world.clients[name] = { client, device };
  return world.clients[name];
}

function payload({ snapshots = [], strategies = [], orders = [], executions = [], flags = [], extraAccounts = [] }) {
  const names = new Set([...snapshots, ...strategies, ...orders, ...executions].map((row) => row.accountName));
  for (const name of extraAccounts) names.add(name);
  return {
    id: randomUUID(),
    date: DAY,
    status: 'Needs review',
    accounts: Object.fromEntries([...names].map((name) => [name, { accountName: name }])),
    snapshots,
    strategies,
    orders,
    executions,
    flags,
    pnlSourceSummary: { realized: snapshots.length, gross_fallback: 0, gross_missing_realized: 0, unavailable: 0, unknown: 0 },
  };
}

async function claim(who, capturedAt, body) {
  const token = randomUUID();
  const capture = randomUUID();
  const rowCounts = {
    accounts: body.snapshots.length,
    strategies: body.strategies.length,
    orders: body.orders.length,
    executions: body.executions.length,
  };
  const claimed = (await db.query(
    `select public.claim_ingest_batch_v4($1, $2, $3::date, $4::timestamptz, 1, $5, $6, 10, $7::jsonb, $8, 120) as r`,
    [who.device, capture, DAY, capturedAt, `${who.client}/${DAY}/${capture}.json.gz`, 'a'.repeat(64),
      JSON.stringify(rowCounts), token])).rows[0].r;
  if (claimed.outcome !== 'owned') throw new Error(`claim: ${claimed.outcome}`);
  return { batchId: claimed.batch.id, token, rowCounts };
}

async function finalize(who, { batchId, token, rowCounts }, capturedAt, importId, status = 'processed') {
  const event = {
    processed: 'ingest_batch_processed',
    incomplete: 'ingest_batch_processed',
    failed: 'ingest_batch_failed',
    late_closed_day: 'ingest_batch_late_closed_day',
  }[status];
  await db.query(
    `select status from public.finalize_ingest_batch_v3(
       $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, '{}'::jsonb, $10::jsonb,
       $11, '{"storage": 1}'::jsonb, 5)`,
    [batchId, who.device, who.client, token, status, importId, capturedAt, status !== 'failed',
      status === 'failed' ? 'ingest_failed' : null, JSON.stringify(rowCounts), event],
  );
}

/** One close: claim, persist, finalize. */
async function capture(who, capturedAt, sections) {
  const body = payload(sections);
  const claimed = await claim(who, capturedAt, body);
  const persisted = (await db.query(
    'select public.persist_auto_daily_import_v3($1, $2, $3, $4::jsonb) as r',
    [who.client, claimed.batchId, claimed.token, JSON.stringify(body)])).rows[0].r;
  if (persisted.disposition !== 'persisted') throw new Error(`persist: ${persisted.disposition}`);
  const importId = persisted.daily_import.id;
  await finalize(who, claimed, capturedAt, importId);
  return { batchId: claimed.batchId, importId };
}

/* ── What the day holds ──────────────────────────────────────────────────── */

async function fillsOf(importId) {
  return (await db.query(
    `select t.account_name as account, e.external_execution_id as id, e.quantity::float8 as quantity,
            e.price::float8 as price, e.time_text as time
       from public.executions e left join public.trading_accounts t on t.id = e.trading_account_id
      where e.daily_import_id = $1 order by 1, 2, e.created_at`, [importId])).rows;
}

async function ordersOf(importId) {
  return (await db.query(
    `select t.account_name as account, o.external_order_id as id, o.state, o.filled::float8 as filled,
            o.avg_price::float8 as avg_price
       from public.orders o left join public.trading_accounts t on t.id = o.trading_account_id
      where o.daily_import_id = $1 order by 1, 2, o.created_at`, [importId])).rows;
}

async function strategiesOf(importId) {
  return (await db.query(
    `select t.account_name as account, s.strategy_name as name, s.strategy_family as family, s.instrument,
            s.realized::float8 as realized, s.derived_realized::float8 as derived, s.ran, s.ran_basis, s.source
       from public.strategy_snapshots s left join public.trading_accounts t on t.id = s.trading_account_id
      where s.daily_import_id = $1 order by 1, 2, 4, s.realized`, [importId])).rows;
}

async function snapshotsOf(importId) {
  return (await db.query(
    `select account_name as account, gross_realized_pnl::float8 as realized, unrealized_pnl::float8 as unrealized,
            account_balance::float8 as balance, trailing_max_drawdown::float8 as trailing, derivation,
            source, source_detail
       from public.account_snapshots where daily_import_id = $1 order by 1`, [importId])).rows;
}

async function flagsOf(importId) {
  return (await db.query(
    `select f.type, f.severity, f.status, f.message, f.details, f.resolution_note, t.account_name as account
       from public.operational_flags f left join public.trading_accounts t on t.id = f.trading_account_id
      where f.daily_import_id = $1 order by f.type, t.account_name`, [importId])).rows;
}

async function summaryOf(importId) {
  return one(db, 'select source_summary from public.daily_imports where id = $1', [importId]);
}

/* ── The tracker, through the agents' RPCs ───────────────────────────────── */

function reading(accountName, realized, over = {}) {
  return {
    accountName,
    connectionName: 'Northwind',
    connected: true,
    status: 'Connected',
    realizedPnl: realized,
    unrealizedPnl: 0,
    totalPnl: realized,
    strategyCount: 2,
    enabledStrategyCount: 2,
    ...over,
  };
}

async function sample(deviceId, sampledAt, accounts) {
  const reply = (await db.query(
    'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as r',
    [deviceId, sampledAt, JSON.stringify(accounts)])).rows[0].r;
  if (reply.throttled) throw new Error(`throttled at ${sampledAt}`);
  await db.query(
    "update public.account_live_samples set reported_at = reported_at - interval '1 hour' where device_id = $1",
    [deviceId]);
}

function strategyReading(accountName, strategyId, over = {}) {
  return {
    accountName,
    strategyId,
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: 0,
    unrealizedPnl: 0,
    restartedAt: null,
    ...over,
  };
}

async function strategySample(deviceId, sampledAt, items) {
  const reply = (await db.query(
    'select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb) as r',
    [deviceId, sampledAt, JSON.stringify(items)])).rows[0].r;
  if (reply.throttled) throw new Error(`strategies throttled at ${sampledAt}`);
  await db.query(
    "update public.algorithm_live_samples set reported_at = reported_at - interval '1 hour' where device_id = $1",
    [deviceId]);
}

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

async function executeGrantees(signature) {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

/* ── The world ───────────────────────────────────────────────────────────── */

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 72 }));
  world.before = {
    columns: await column(db, `select table_name || '.' || column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('source', 'source_detail', 'details')
        and table_name in ('account_snapshots', 'strategy_snapshots', 'operational_flags') order by 1`),
    fillDay: await one(db, `select to_regprocedure('${FILL_DAY}') is null`),
  };
  world.notices = await applyFileCollectingNotices(db, STEP);

  const managerAuth = await one(db, "insert into auth.users (email) values ('mgr@example.com') returning id");
  world.managerAuth = managerAuth;
  world.manager = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [managerAuth]);
}, 180_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 66, says which steps it needs, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 65 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 73 needs steps 29, 47, 50, 64, 66, 67 and 71 .*: run them first/);
      expect(await one(early, `select to_regprocedure('${FILL_DAY}') is null`)).toBe(true);
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'account_snapshots' and column_name = 'source'`)).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);
});

describe('before 73, and after it', () => {
  it('there was no source column, no details column and no fill function', () => {
    expect(world.before).toEqual({ columns: [], fillDay: true });
  });

  it('adds source (capture or tracker, default capture) on both snapshot tables, source_detail and details', async () => {
    const rows = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and column_name in ('source', 'source_detail', 'details')
        and table_name in ('account_snapshots', 'strategy_snapshots', 'operational_flags')
      order by table_name, column_name`)).rows;
    expect(rows.map((r) => [r.table_name, r.column_name, r.data_type, r.is_nullable, r.column_default])).toEqual([
      ['account_snapshots', 'source', 'text', 'NO', "'capture'::text"],
      ['account_snapshots', 'source_detail', 'jsonb', 'YES', null],
      ['operational_flags', 'details', 'jsonb', 'YES', null],
      ['strategy_snapshots', 'source', 'text', 'NO', "'capture'::text"],
    ]);
    const client = await one(db, "insert into public.clients (name) values ('Check') returning id");
    const daily = await one(db, "insert into public.daily_imports (client_id, trading_date) values ($1, '2020-01-02') returning id", [client]);
    await expect(db.query("insert into public.account_snapshots (daily_import_id, account_name, source) values ($1, 'X', 'guess')", [daily]))
      .rejects.toThrow(/account_snapshots_source_check/);
    await expect(db.query("insert into public.strategy_snapshots (daily_import_id, strategy_name, source) values ($1, 'X', 'guess')", [daily]))
      .rejects.toThrow(/strategy_snapshots_source_check/);
    await db.query('delete from public.clients where id = $1', [client]);
  });

  it('a first run said only that the checks and the triggers were not there to drop', () => {
    expect(world.notices).toEqual([
      'constraint "account_snapshots_source_check" of relation "account_snapshots" does not exist, skipping',
      'constraint "strategy_snapshots_source_check" of relation "strategy_snapshots" does not exist, skipping',
      'trigger "account_snapshots_source_guard" for relation "public.account_snapshots" does not exist, skipping',
      'trigger "strategy_snapshots_source_guard" for relation "public.strategy_snapshots" does not exist, skipping',
      'trigger "tracker_fill_on_batch" for relation "public.ingest_batches" does not exist, skipping',
    ]);
  });
});

/* ── Part 1: a later capture never erases what an earlier one stored ─────── */

describe('a later capture with fewer accounts', () => {
  let close;
  beforeAll(async () => {
    const who = await newClient('Merge');
    await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 100), snap('ACC 2', 50)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 100), strat('ACC 2', '1 - ALPHA-1.0', 'NQ 12-26', 50)],
      orders: [order('ACC 1', 'O1'), order('ACC 2', 'O2')],
      executions: [fill('ACC 1', 'E1'), fill('ACC 1', 'E2', { time: `${DAY} 11:00:00` }), fill('ACC 2', 'E3', { instrument: 'NQ 12-26' })],
    });
    close = await capture(who, at('16:30'), {
      // NinjaTrader restarted on ACC 1 at noon: E1 is gone from its memory.
      snapshots: [snap('ACC 1', 150)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 150)],
      orders: [order('ACC 1', 'O1', { state: 'Filled', filled: 1, avgPrice: 21012.25, remaining: 0 })],
      executions: [fill('ACC 1', 'E2', { time: `${DAY} 11:00:00` }), fill('ACC 1', 'E4', { time: `${DAY} 15:00:00` })],
    });
    world.imports.merge = close.importId;
  });

  it('keeps the other account\'s snapshot and takes the newer reading of the one it lists', async () => {
    const rows = await snapshotsOf(close.importId);
    expect(rows.map((r) => [r.account, r.realized, r.balance, r.source])).toEqual([
      ['ACC 1', 150, 50150, 'capture'],
      ['ACC 2', 50, 50050, 'capture'],
    ]);
  });

  it('keeps the other account\'s fills and every fill of the listed one, each once', async () => {
    expect((await fillsOf(close.importId)).map((r) => [r.account, r.id])).toEqual([
      ['ACC 1', 'E1'], ['ACC 1', 'E2'], ['ACC 1', 'E4'], ['ACC 2', 'E3'],
    ]);
  });

  it('keeps the other account\'s orders, and an order in both takes the newer capture\'s values', async () => {
    expect(await ordersOf(close.importId)).toEqual([
      { account: 'ACC 1', id: 'O1', state: 'Filled', filled: 1, avg_price: 21012.25 },
      { account: 'ACC 2', id: 'O2', state: 'Working', filled: 0, avg_price: 0 },
    ]);
  });

  it('keeps the other account\'s strategy and upserts the listed one', async () => {
    expect((await strategiesOf(close.importId)).map((r) => [r.account, r.name, r.realized, r.source])).toEqual([
      ['ACC 1', '0 - OGX-PF-2.4', 150, 'capture'],
      ['ACC 2', '1 - ALPHA-1.0', 50, 'capture'],
    ]);
  });

  it('records the merge on the day', async () => {
    expect((await summaryOf(close.importId)).merge).toEqual({
      mode: 'merge', accountsInCapture: 1, accountsKeptFromEarlier: 1, accountsHeldBack: 0,
    });
  });
});

describe('fills and orders without an id, and strategy twins', () => {
  let who;
  let importId;
  const twin = (over = {}) => fill('ACC 1', '', { orderId: '', time: `${DAY} 09:31:00`, ...over });
  beforeAll(async () => {
    who = await newClient('Twins');
    ({ importId } = await capture(who, at('12:00'), {
      snapshots: [snap('ACC 1', 10)],
      strategies: [
        strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 10),
        strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 20),
        strat('ACC 1', '2 - BETA-1.0', 'ES 12-26', 5),
      ],
      orders: [order('ACC 1', '', { time: `${DAY} 09:31:00` })],
      executions: [twin(), twin()],
    }));
  });

  it('match by multiplicity: the same two again add nothing, a third identical one is added', async () => {
    await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 10)],
      executions: [twin(), twin()],
    });
    expect(await fillsOf(importId)).toHaveLength(2);
    await capture(who, at('14:00'), {
      snapshots: [snap('ACC 1', 15)],
      executions: [twin(), twin(), twin()],
    });
    expect(await fillsOf(importId)).toHaveLength(3);
    await capture(who, at('15:00'), {
      snapshots: [snap('ACC 1', 15)],
      executions: [twin()],
    });
    expect(await fillsOf(importId)).toHaveLength(3);
  });

  it('an order without an id is matched by its fallback identity and takes the newer state', async () => {
    await capture(who, at('15:30'), {
      snapshots: [snap('ACC 1', 15)],
      orders: [order('ACC 1', '', { time: `${DAY} 09:31:00`, state: 'Filled', filled: 1 })],
    });
    expect(await ordersOf(importId)).toEqual([{ account: 'ACC 1', id: '', state: 'Filled', filled: 1, avg_price: 0 }]);
  });

  it('a strategy identity listed again is replaced as a group, an unlisted one keeps its row', async () => {
    await capture(who, at('16:30'), {
      snapshots: [snap('ACC 1', 40)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 40)],
    });
    expect((await strategiesOf(importId)).map((r) => [r.name, r.instrument, r.realized])).toEqual([
      ['0 - OGX-PF-2.4', 'MNQ 12-26', 40],
      ['2 - BETA-1.0', 'ES 12-26', 5],
    ]);
  });
});

describe('derived_realized follows the merged fills', () => {
  const derivation = { status: 'exact', reportedGross: 0 };

  it('a capture that did not carry a stored fill cannot keep its derived figures', async () => {
    const who = await newClient('Derived subset');
    const { importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 50, { derivation })],
      strategies: [
        strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', null, { derivedRealized: 50 }),
        strat('ACC 1', '2 - BETA-1.0', 'ES 12-26', null, { derivedRealized: 5 }),
      ],
      executions: [fill('ACC 1', 'E1')],
    });
    await capture(who, at('16:30'), {
      snapshots: [snap('ACC 1', 80, { derivation })],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', null, { derivedRealized: 30 })],
      executions: [fill('ACC 1', 'E2', { time: `${DAY} 14:00:00` })],
    });
    expect((await strategiesOf(importId)).map((r) => [r.name, r.derived])).toEqual([
      ['0 - OGX-PF-2.4', null],
      ['2 - BETA-1.0', null],
    ]);
    expect((await snapshotsOf(importId))[0].derivation).toBeNull();
  });

  it('a capture that carried the stored fills back keeps its figures; a row kept from earlier loses its own', async () => {
    const who = await newClient('Derived union');
    const { importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 50, { derivation })],
      strategies: [
        strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', null, { derivedRealized: 50 }),
        strat('ACC 1', '2 - BETA-1.0', 'ES 12-26', null, { derivedRealized: 5 }),
      ],
      executions: [fill('ACC 1', 'E1')],
    });
    await capture(who, at('16:30'), {
      snapshots: [snap('ACC 1', 80, { derivation: { ...derivation, reportedGross: 80 } })],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', null, { derivedRealized: 75 })],
      executions: [fill('ACC 1', 'E1', { fromStore: true }), fill('ACC 1', 'E2', { time: `${DAY} 14:00:00` })],
    });
    expect((await strategiesOf(importId)).map((r) => [r.name, r.derived])).toEqual([
      ['0 - OGX-PF-2.4', 75],
      ['2 - BETA-1.0', null],
    ]);
    expect((await snapshotsOf(importId))[0].derivation).toEqual({ status: 'exact', reportedGross: 80 });
    expect((await fillsOf(importId)).map((r) => r.id)).toEqual(['E1', 'E2']);
  });
});

describe('rule d: a capture that shows no activity where the day had some', () => {
  let who;
  let importId;
  beforeAll(async () => {
    who = await newClient('Lost');
    ({ importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 120), snap('ACC 2', 0)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 120)],
      orders: [order('ACC 1', 'O1', { state: 'Filled', filled: 1 })],
      executions: [fill('ACC 1', 'E1'), fill('ACC 1', 'E2', { action: 'Sell', time: `${DAY} 10:30:00` })],
    }));
    await capture(who, at('16:30'), {
      snapshots: [snap('ACC 1', 0, { accountBalance: 50000 }), snap('ACC 2', 0, { accountBalance: 49990 })],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 0)],
      // The stored fills coming back from the route do not count as the capture's own.
      executions: [fill('ACC 1', 'E1', { fromStore: true })],
      flags: [{ type: 'Strategy disabled', severity: 'Warning', accountName: 'ACC 1', message: 'ACC 1 has a strategy disabled.' }],
    });
  });

  it('keeps the stored snapshot, strategies, orders and fills of that account untouched', async () => {
    const rows = await snapshotsOf(importId);
    expect(rows.map((r) => [r.account, r.realized, r.balance])).toEqual([['ACC 1', 120, 50120], ['ACC 2', 0, 49990]]);
    expect((await strategiesOf(importId)).map((r) => [r.account, r.realized])).toEqual([['ACC 1', 120]]);
    expect(await ordersOf(importId)).toEqual([{ account: 'ACC 1', id: 'O1', state: 'Filled', filled: 1, avg_price: 0 }]);
    expect((await fillsOf(importId)).map((r) => r.id)).toEqual(['E1', 'E2']);
    expect((await summaryOf(importId)).merge.accountsHeldBack).toBe(1);
  });

  it('writes one Capture lost activity flag with both readings, and the import\'s own flags as before', async () => {
    const flags = await flagsOf(importId);
    expect(flags.map((f) => [f.type, f.account, f.severity, f.status])).toEqual([
      ['Capture lost activity', 'ACC 1', 'Warning', 'Open'],
      ['Strategy disabled', 'ACC 1', 'Warning', 'Open'],
    ]);
    const lost = flags[0];
    expect(lost.details).toMatchObject({
      accountName: 'ACC 1',
      stored: { realized: 120, balance: 50120, executions: 2, source: 'capture' },
      capture: { realized: 0, balance: 50000, executions: 0 },
    });
    expect(lost.message).toMatch(/^ACC 1 traded on \d{4}-\d{2}-\d{2}, but the capture at 16:30 New York showed no fills and \$0 realized\. The CRM kept what an earlier capture stored: 2 fill\(s\), \$120 realized, balance \$50,120\./);
  });

  it('a third capture that says the same rewrites the import\'s flags and leaves the merge flag alone, once', async () => {
    await capture(who, at('16:45'), {
      snapshots: [snap('ACC 1', 0, { accountBalance: 50000 }), snap('ACC 2', 0)],
      flags: [{ type: 'Strategy disabled', severity: 'Warning', accountName: 'ACC 1', message: 'ACC 1 has a strategy disabled.' }],
    });
    expect((await flagsOf(importId)).map((f) => f.type)).toEqual(['Capture lost activity', 'Strategy disabled']);
  });

  it('an account with a stored realized figure and no fills counts as activity too', async () => {
    const other = await newClient('Lost realized');
    const { importId: id } = await capture(other, at('13:00'), { snapshots: [snap('ACC 9', -45)] });
    await capture(other, at('16:30'), { snapshots: [snap('ACC 9', 0.004)] });
    expect((await snapshotsOf(id))[0].realized).toBe(-45);
    expect((await flagsOf(id)).map((f) => f.type)).toEqual(['Capture lost activity']);
  });
});

describe('flags a capture may and may not delete', () => {
  it('a Missing account flag is not written for an account the day still holds', async () => {
    const who = await newClient('Missing');
    const { importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 10), snap('ACC 2', 20)],
    });
    await db.query(`insert into public.operational_flags (daily_import_id, client_id, type, severity, message)
      values ($1, $2, 'Close below tracker', 'Critical', 'kept'), ($1, $2, 'Tracker only account', 'Warning', 'kept'),
             ($1, $2, 'Old import flag', 'Warning', 'goes')`, [importId, who.client]);
    await capture(who, at('16:30'), {
      snapshots: [snap('ACC 1', 15)],
      extraAccounts: ['ACC 3'],
      flags: [
        { type: 'Missing account', severity: 'Warning', accountName: 'ACC 2', message: 'ACC 2 existed before but did not appear in this close.' },
        { type: 'Missing account', severity: 'Warning', accountName: 'ACC 3', message: 'ACC 3 existed before but did not appear in this close.' },
      ],
    });
    expect((await flagsOf(importId)).map((f) => [f.type, f.account ?? null, f.message])).toEqual([
      ['Close below tracker', null, 'kept'],
      ['Missing account', 'ACC 3', 'ACC 3 existed before but did not appear in this close.'],
      ['Tracker only account', null, 'kept'],
    ]);
  });
});

/* ── Part 2: the tracker fills the hole ──────────────────────────────────── */

describe('the tracker fills an account the close lost', () => {
  let who;
  let importId;
  beforeAll(async () => {
    who = await newClient('Tracker');
    const d = who.device;
    await sample(d, at('10:00'), [reading('ACC IN', 0), reading('ACC GONE', 0), reading('ACC QUIET', 0)]);
    await sample(d, at('14:00'), [
      reading('ACC GONE', 250),
      reading('ACC GONE 2', 75),
      reading('ACC GONE 3', 100),
      reading('ACC ZERO', 80),
    ]);
    await strategySample(d, at('14:00'), [
      { ...strategyReading('ACC GONE', '100', { realizedPnl: 250 }), tradesThisRun: 3 },
      { ...strategyReading('ACC GONE', '101', { strategyName: '1 - ALPHA-1.0', algorithm: 'ALPHA', instrument: 'NQ 12-26', instrumentRoot: 'NQ' }), tradesThisRun: 0 },
    ]);
    // After the first close's cutoff and before the second's: the reading a
    // later close pins, which refreshes the provisional row.
    await sample(d, at('16:40'), [reading('ACC GONE 3', 180)]);

    ({ importId } = await capture(who, at('16:30'), {
      snapshots: [snap('ACC IN', 40), snap('ACC ZERO', 0)],
      executions: [fill('ACC IN', 'I1')],
    }));
    world.imports.tracker = importId;
  });

  it('pins first (step 66), then fills: a provisional snapshot from the reading, no balance, marked tracker', async () => {
    const rows = await snapshotsOf(importId);
    expect(rows.map((r) => [r.account, r.realized, r.unrealized, r.balance, r.trailing, r.source])).toEqual([
      ['ACC GONE', 250, 0, null, null, 'tracker'],
      ['ACC GONE 2', 75, 0, null, null, 'tracker'],
      ['ACC GONE 3', 100, 0, null, null, 'tracker'],
      ['ACC IN', 40, 0, 50040, 2000, 'capture'],
      ['ACC ZERO', 0, 0, 50000, 2000, 'capture'],
    ]);
    const gone = rows[0];
    expect(gone.source_detail).toMatchObject({
      origin: 'tracker_close_readings', totalPnl: 250, connected: true, status: 'Connected', captureBasis: 'captured',
    });
    expect(await one(db, `select count(*)::int from public.trading_accounts
      where client_id = $1 and account_name in ('ACC GONE', 'ACC GONE 2', 'ACC GONE 3')
        and account_type = 'Unassigned' and status = 'Active'`, [who.client])).toBe(3);
  });

  it('adds the strategy readings as tracker rows, so the money lands on the algorithm', async () => {
    const rows = (await strategiesOf(importId)).filter((r) => r.account === 'ACC GONE');
    expect(rows).toEqual([
      { account: 'ACC GONE', name: '0 - OGX-PF-2.4', family: 'OGX_PF', instrument: 'MNQ 12-26', realized: 250, derived: null, ran: true, ran_basis: 'realized', source: 'tracker' },
      { account: 'ACC GONE', name: '1 - ALPHA-1.0', family: 'ALPHA', instrument: 'NQ 12-26', realized: 0, derived: null, ran: null, ran_basis: null, source: 'tracker' },
    ]);
  });

  it('writes Tracker only account for each provisional account and Close below tracker for the empty one', async () => {
    const flags = await flagsOf(importId);
    expect(flags.map((f) => [f.type, f.account, f.severity, f.status])).toEqual([
      ['Close below tracker', 'ACC ZERO', 'Critical', 'Open'],
      ['Tracker only account', 'ACC GONE', 'Warning', 'Open'],
      ['Tracker only account', 'ACC GONE 2', 'Warning', 'Open'],
      ['Tracker only account', 'ACC GONE 3', 'Warning', 'Open'],
    ]);
    expect(flags[1].message).toMatch(/^ACC GONE is not in the close, but the tracker saw it trade on \d{4}-\d{2}-\d{2}: realized \$250, unrealized \$0, total \$250 at 14:00 New York\./);
    expect(flags[0].details).toMatchObject({ accountName: 'ACC ZERO', close: { realized: 0, executions: 0 }, tracker: { realizedPnl: 80 } });
    const audit = await one(db, `select after_data from public.audit_logs
      where entity_type = 'daily_import' and entity_id = $1 and action = 'tracker_fill_applied'`, [importId]);
    expect(audit).toMatchObject({ accountsFilled: 3, strategiesFilled: 2, flagsWritten: 4, flagsResolved: 0 });
  });

  it('a later close refreshes a provisional row from a strictly newer reading and adds nothing else', async () => {
    await capture(who, at('16:45'), {
      snapshots: [snap('ACC IN', 40), snap('ACC ZERO', 0)],
      executions: [fill('ACC IN', 'I1')],
    });
    const rows = await snapshotsOf(importId);
    expect(rows.filter((r) => r.source === 'tracker').map((r) => [r.account, r.realized])).toEqual([
      ['ACC GONE', 250], ['ACC GONE 2', 75], ['ACC GONE 3', 180],
    ]);
    expect((await flagsOf(importId))).toHaveLength(4);
    // Step 66's pin, as this file reproduces it: the provisional rows are not
    // accounts the close lists.
    const pinned = await one(db, `select after_data from public.audit_logs
      where entity_type = 'daily_import' and entity_id = $1 and action = 'tracker_close_compared'
      order by created_at desc limit 1`, [importId]);
    expect(pinned).toMatchObject({ accountsInClose: 2, accountsWithoutReading: 0 });
  });

  it('a real capture replaces the provisional rows, even one that shows nothing, and the flags follow', async () => {
    await capture(who, at('16:55'), {
      snapshots: [snap('ACC IN', 40), snap('ACC ZERO', 80), snap('ACC GONE', 260), snap('ACC GONE 2', 0)],
      strategies: [strat('ACC GONE', '0 - OGX-PF-2.4', 'MNQ 12-26', 260)],
      executions: [fill('ACC IN', 'I1'), fill('ACC ZERO', 'Z1'), fill('ACC GONE', 'G1')],
    });
    const rows = await snapshotsOf(importId);
    expect(rows.map((r) => [r.account, r.realized, r.source, r.source_detail])).toEqual([
      ['ACC GONE', 260, 'capture', null],
      ['ACC GONE 2', 0, 'capture', null],
      ['ACC GONE 3', 180, 'tracker', expect.objectContaining({ origin: 'tracker_close_readings' })],
      ['ACC IN', 40, 'capture', null],
      ['ACC ZERO', 80, 'capture', null],
    ]);
    const strategies = await strategiesOf(importId);
    expect(strategies.filter((r) => r.account === 'ACC GONE').map((r) => [r.name, r.realized, r.source]))
      .toEqual([['0 - OGX-PF-2.4', 260, 'capture']]);
    expect(strategies.filter((r) => r.account === 'ACC GONE 2')).toEqual([]);
    const flags = await flagsOf(importId);
    expect(flags.map((f) => [f.type, f.account, f.status, f.resolution_note])).toEqual([
      ['Close below tracker', 'ACC GONE 2', 'Open', null],
      ['Close below tracker', 'ACC ZERO', 'Resolved', 'A later capture showed this account trading.'],
      ['Tracker only account', 'ACC GONE', 'Resolved', 'A later capture included this account.'],
      ['Tracker only account', 'ACC GONE 2', 'Resolved', 'A later capture included this account.'],
      ['Tracker only account', 'ACC GONE 3', 'Open', null],
    ]);
  });
});

describe('fill_day_from_tracker', () => {
  let manual;
  let captureRowsBefore;
  beforeAll(async () => {
    // A close nobody pinned: written straight into the tables, the way a
    // manual upload lands, with no batch and so no trigger.
    const who = await newClient('Manual');
    const d = who.device;
    await sample(d, at('11:00'), [reading('ACC F', 90), reading('ACC M', 5)]);
    await strategySample(d, at('11:00'), [{ ...strategyReading('ACC F', '300', { realizedPnl: 90 }), tradesThisRun: 2 }]);
    // A run that begins after 17:00 New York: never the reading of this close.
    await sample(d, at('17:30'), [reading('ACC F', 500)]);
    manual = await one(db, `insert into public.daily_imports (client_id, trading_date, status, source_type)
      values ($1, $2, 'Needs review', 'manual') returning id`, [who.client, DAY]);
    const account = await one(db, `insert into public.trading_accounts (client_id, account_name, alias)
      values ($1, 'ACC M', 'ACC M') returning id`, [who.client]);
    await db.query(`insert into public.account_snapshots (daily_import_id, trading_account_id, account_name,
      gross_realized_pnl, account_balance) values ($1, $2, 'ACC M', 5, 25005)`, [manual, account]);
    captureRowsBefore = await capturedRows();
  });

  async function capturedRows() {
    return {
      snapshots: (await db.query(`select s.* from public.account_snapshots s
        join public.daily_imports d on d.id = s.daily_import_id
        where d.trading_date = $1 and s.source = 'capture' order by s.id`, [DAY])).rows,
      strategies: (await db.query(`select s.* from public.strategy_snapshots s
        join public.daily_imports d on d.id = s.daily_import_id
        where d.trading_date = $1 and s.source = 'capture' order by s.id`, [DAY])).rows,
      fills: await one(db, `select count(*)::int from public.executions e
        join public.daily_imports d on d.id = e.daily_import_id where d.trading_date = $1`, [DAY]),
    };
  }

  it('falls back to the history before 17:00 New York for a close nobody pinned, and says so', async () => {
    const summary = (await asService('select public.fill_day_from_tracker($1::date) as r', [DAY]))[0].r;
    expect(summary).toMatchObject({
      tradingDate: DAY, accountsFilled: 1, accountsRefreshed: 0, strategiesFilled: 1, flagsWritten: 1, failedImports: [],
    });
    expect(summary.dailyImports).toBe(await one(db, 'select count(*)::int from public.daily_imports where trading_date = $1', [DAY]));
    const rows = await snapshotsOf(manual);
    expect(rows.map((r) => [r.account, r.realized, r.source])).toEqual([['ACC F', 90, 'tracker'], ['ACC M', 5, 'capture']]);
    expect(rows[0].source_detail).toMatchObject({ origin: 'account_live_sample_history', captureBasis: 'assumed_17_00' });
    expect((await strategiesOf(manual)).map((r) => [r.account, r.realized, r.source])).toEqual([['ACC F', 90, 'tracker']]);
    expect((await flagsOf(manual)).map((f) => [f.type, f.account])).toEqual([['Tracker only account', 'ACC F']]);
  });

  it('is idempotent and never touched a capture row', async () => {
    const counts = async () => one(db, `select jsonb_build_object(
      'snapshots', (select count(*) from public.account_snapshots),
      'strategies', (select count(*) from public.strategy_snapshots),
      'flags', (select count(*) from public.operational_flags),
      'audits', (select count(*) from public.audit_logs))`);
    const before = await counts();
    const again = (await asService('select public.fill_day_from_tracker($1::date) as r', [DAY]))[0].r;
    expect(again).toMatchObject({ accountsFilled: 0, accountsRefreshed: 0, strategiesFilled: 0, flagsWritten: 0, flagsResolved: 0 });
    expect(await counts()).toEqual(before);
    expect(await capturedRows()).toEqual(captureRowsBefore);
  });

  it('answers only the service role', async () => {
    expect((await executeGrantees(FILL_DAY)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select public.fill_day_from_tracker($1::date)', { params: [DAY] }))
        .toMatch(/permission denied/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select public.fill_day_from_tracker(null)'))
      .toMatch(/invalid_trading_date/);
  });
});

/* ── The Manager's two replays ───────────────────────────────────────────── */

describe('the Manager replay', () => {
  const REASON = 'Replaying after the normalizer fix.';

  it('Reprocess batch lands a failed capture by merging, like the daily route', async () => {
    const who = await newClient('Replay');
    const { importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 10), snap('ACC 2', 20)],
      executions: [fill('ACC 1', 'E1'), fill('ACC 2', 'E2')],
    });
    const body = payload({ snapshots: [snap('ACC 1', 30)], executions: [fill('ACC 1', 'E3', { time: `${DAY} 15:00:00` })] });
    const failed = await claim(who, at('16:30'), body);
    await finalize(who, failed, at('16:30'), null, 'failed');
    const token = randomUUID();
    const claimed = (await asService('select public.claim_ingest_batch_reprocess($1, $2, $3, 300, false, $4) as r',
      [failed.batchId, world.manager, token, REASON]))[0].r;
    expect(claimed.outcome).toBe('owned');
    const persisted = (await asService('select public.persist_auto_daily_import_v3($1, $2, $3, $4::jsonb) as r',
      [who.client, failed.batchId, token, JSON.stringify(body)]))[0].r;
    expect(persisted.disposition).toBe('persisted');
    await finalize(who, { ...failed, token }, at('16:30'), importId);
    expect((await fillsOf(importId)).map((r) => [r.account, r.id])).toEqual([['ACC 1', 'E1'], ['ACC 1', 'E3'], ['ACC 2', 'E2']]);
    expect((await summaryOf(importId)).merge.mode).toBe('merge');
  });

  it('Replace closed day still replaces the sections it carries, as step 50 did, and keeps the new flag kinds', async () => {
    const who = await newClient('Closed');
    const { importId } = await capture(who, at('13:00'), {
      snapshots: [snap('ACC 1', 10), snap('ACC 2', 20)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 10), strat('ACC 2', '1 - ALPHA-1.0', 'NQ 12-26', 20)],
      executions: [fill('ACC 1', 'E1'), fill('ACC 2', 'E2')],
    });
    await db.query(`insert into public.operational_flags (daily_import_id, client_id, type, severity, message)
      values ($1, $2, 'Close below tracker', 'Critical', 'kept'), ($1, $2, 'Strategy disabled', 'Warning', 'goes')`,
    [importId, who.client]);
    await db.query("update public.daily_imports set status = 'Closed' where id = $1", [importId]);

    const body = payload({
      snapshots: [snap('ACC 1', 30)],
      strategies: [strat('ACC 1', '0 - OGX-PF-2.4', 'MNQ 12-26', 30)],
      executions: [fill('ACC 1', 'E3', { time: `${DAY} 15:00:00` })],
    });
    const late = await claim(who, at('16:30'), body);
    await expect(db.query('select public.persist_auto_daily_import_v3($1, $2, $3, $4::jsonb)',
      [who.client, late.batchId, late.token, JSON.stringify(body)])).rejects.toThrow(/daily_import_closed/);
    await finalize(who, late, at('16:30'), importId, 'late_closed_day');

    const token = randomUUID();
    const claimed = (await asService('select public.claim_ingest_batch_reprocess($1, $2, $3, 300, true, $4) as r',
      [late.batchId, world.manager, token, REASON]))[0].r;
    expect(claimed.outcome).toBe('owned');
    await asService('select public.persist_closed_auto_daily_import_replacement_v2($1, $2, $3, $4, $5, $6::jsonb)',
      [who.client, late.batchId, token, world.manager, REASON, JSON.stringify(body)]);

    expect((await fillsOf(importId)).map((r) => [r.account, r.id])).toEqual([['ACC 1', 'E3']]);
    expect((await strategiesOf(importId)).map((r) => [r.account, r.realized])).toEqual([['ACC 1', 30]]);
    // Step 50's upsert never removed an account row, and still does not.
    expect((await snapshotsOf(importId)).map((r) => [r.account, r.realized])).toEqual([['ACC 1', 30], ['ACC 2', 20]]);
    expect((await flagsOf(importId)).map((f) => f.type)).toEqual(['Close below tracker', 'Closed day automatically replaced']);
    expect((await summaryOf(importId)).merge.mode).toBe('replace');
    expect(await one(db, 'select status from public.daily_imports where id = $1', [importId])).toBe('Closed');
  });
});

/* ── The browser, and who may call what ──────────────────────────────────── */

describe('the browser and the grants', () => {
  it('a browser write is always a capture: an upload over a provisional row makes it one, and no tracker row can be forged', async () => {
    const importId = world.imports.tracker;
    const target = await one(db, `select id from public.account_snapshots
      where daily_import_id = $1 and account_name = 'ACC GONE 3'`, [importId]);
    expect(await one(db, 'select source from public.account_snapshots where id = $1', [target])).toBe('tracker');
    await db.exec('begin');
    try {
      await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', world.managerAuth]);
      await db.exec('set local role authenticated');
      await db.query("update public.account_snapshots set account_balance = 51000, source = 'tracker' where id = $1", [target]);
      await db.query(`insert into public.account_snapshots (daily_import_id, account_name, gross_realized_pnl, source)
        values ($1, 'ACC FORGED', 1, 'tracker')`, [importId]);
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
    expect((await db.query(`select account_name, source, source_detail from public.account_snapshots
      where daily_import_id = $1 and account_name in ('ACC GONE 3', 'ACC FORGED') order by 1`, [importId])).rows)
      .toEqual([
        { account_name: 'ACC FORGED', source: 'capture', source_detail: null },
        { account_name: 'ACC GONE 3', source: 'capture', source_detail: null },
      ]);
    const visible = await rowsAsRole(db, 'authenticated',
      'select source from public.account_snapshots where daily_import_id = $1 limit 1',
      { params: [importId], subject: world.managerAuth });
    expect(visible).toHaveLength(1);
  });

  it('nobody but the owner may call the merge, the fill of one close, the flag writer or the trigger functions', async () => {
    for (const signature of INTERNAL) {
      expect((await executeGrantees(signature)).filter((role) => role !== 'postgres'), signature).toEqual([]);
    }
  });

  it('every function this file defines is security definer except the two guards, with search_path pinned', async () => {
    const rows = (await db.query(`select p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1) order by 1`,
    [['persist_auto_daily_import', 'fill_daily_import_from_tracker', 'fill_day_from_tracker', 'write_close_merge_flag',
      'tracker_fill_on_batch', 'account_snapshots_source_guard', 'strategy_snapshots_source_guard']])).rows;
    expect(rows.map((r) => [r.proname, r.prosecdef])).toEqual([
      ['account_snapshots_source_guard', false],
      ['fill_daily_import_from_tracker', true],
      ['fill_day_from_tracker', true],
      ['persist_auto_daily_import', true],
      ['strategy_snapshots_source_guard', false],
      ['tracker_fill_on_batch', true],
      ['write_close_merge_flag', true],
    ]);
    for (const row of rows) expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public']);
  });

  it('the fill trigger fires after step 66\'s pin on the same transition', async () => {
    const triggers = await column(db, `select tgname from pg_trigger
      where tgrelid = 'public.ingest_batches'::regclass and tgname like 'tracker_%' order by tgname`);
    expect(triggers).toEqual(['tracker_close_on_batch', 'tracker_fill_on_batch']);
  });
});

/* ── Running it again ─────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('changes no row and says only that the columns exist', async () => {
    const counts = async () => one(db, `select jsonb_build_object(
      'snapshots', (select jsonb_agg(s order by s.id) from public.account_snapshots s),
      'strategies', (select count(*) from public.strategy_snapshots),
      'flags', (select jsonb_agg(f order by f.id) from public.operational_flags f),
      'audits', (select count(*) from public.audit_logs))`);
    const before = await counts();
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices).toEqual([
      'column "source" of relation "account_snapshots" already exists, skipping',
      'column "source_detail" of relation "account_snapshots" already exists, skipping',
      'column "source" of relation "strategy_snapshots" already exists, skipping',
      'column "details" of relation "operational_flags" already exists, skipping',
    ]);
    expect(await counts()).toEqual(before);
    expect((await executeGrantees(FILL_DAY)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('the three kinds are the words the browser knows', async () => {
    const { CLOSE_MERGE_FLAG_TYPES } = await import('../src/domain/databaseFlagTypes.js');
    expect(Object.values(CLOSE_MERGE_FLAG_TYPES).sort()).toEqual([...NEW_KINDS].sort());
    const written = await column(db, `select distinct type from public.operational_flags
      where type = any($1) and message <> 'kept' order by 1`, [NEW_KINDS]);
    expect(written).toEqual([...NEW_KINDS].sort());
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 73 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 73)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(73);
    expect(numbers).not.toContain(54);
  });

  it('is in the runbook table after 72, in the run order after 72, and names what it adds', () => {
    expect(runbook).toMatch(/^\| 73 \| `step_73_merge_daily_captures\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 73 | `step_73_merge_daily_captures.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 72 | `step_72_trading_exports.sql`'));
    expect(runbook).toMatch(/→ 71 → 72 → 73(?: →|\.)/);
    const row73 = runbook.split('\n').find((line) => line.startsWith('| 73 |'));
    for (const name of ['persist_auto_daily_import', 'fill_day_from_tracker', 'fill_daily_import_from_tracker',
      'tracker_fill_on_batch', 'source_detail', 'details', ...NEW_KINDS]) {
      expect(row73).toContain(name);
    }
  });
});
