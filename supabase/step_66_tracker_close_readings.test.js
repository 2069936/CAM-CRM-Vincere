/* STEP 66, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from every file in this directory, applied twice, the
 * way Pedro re-runs a step he is not sure landed. Then a fleet is played
 * against it through the two RPCs the agents already call
 * (record_account_live_sample, record_algorithm_live_sample) and a close is
 * finalized through the same chain the ingest route uses
 * (claim_ingest_batch_v4, persist_auto_daily_import_v3, finalize_ingest_batch_v3).
 * Every verdict below is the database's own: what the history table holds, what
 * the pinned readings say, what the audit log says, what each role may do.
 *
 * Nothing here asserts the text of the SQL, except the three lines that read
 * the directory listing and the runbook, which have no other witness.
 *
 * THE CLOCK. The two sample RPCs sweep rows older than their retention windows
 * (7 days for account samples, 2 days for strategy readings) and this file's own
 * history sweep is 5 days, so a fixture with a fixed date would start failing a
 * few days after it was written. The trading day is therefore YESTERDAY in New
 * York, and every clock time below is a New York clock time on that day, with
 * the offset computed for that date. Nothing reads the wall clock for a verdict.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const STEP = 'step_66_tracker_close_readings.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

const DENIED = /permission denied/i;
const NY = 'America/New_York';

/* ── The trading day: yesterday in New York, every time a New York time ──── */

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
const PRIOR = shiftDays(TODAY, -2);
/** An ISO instant for a New York clock time on a given day. */
const at = (iso, hhmm) => `${iso}T${hhmm}:00${offsetOn(iso)}`;
const ms = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());
const num = (value) => (value === null || value === undefined ? null : Number(value));

let db;
const world = { clients: {}, devices: {}, auth: {}, imports: {}, batches: {} };

/* ── Helpers that speak to the database the way the fleet and the route do ── */

function account(over = {}) {
  return {
    accountName: 'ACC 01',
    connectionName: 'Northwind',
    connected: true,
    status: 'Connected',
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    strategyCount: 2,
    enabledStrategyCount: 2,
    ...over,
  };
}

/**
 * One account report from one machine, through step 55's RPC. The throttle
 * compares now against reported_at, so after each accepted report the clock is
 * moved on by ageing reported_at. That ageing is itself an UPDATE with an
 * unchanged sampled_at, which the history trigger must read as a replay and
 * ignore; the explicit replay test below proves that rule on its own.
 */
async function sample(deviceId, sampledAt, accounts, { onNotice } = {}) {
  const result = await db.query(
    'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as r',
    [deviceId, sampledAt, JSON.stringify(accounts)],
    onNotice ? { onNotice } : undefined,
  );
  const reply = result.rows[0].r;
  if (reply.throttled) throw new Error(`throttled at ${sampledAt}`);
  await db.query(
    "update public.account_live_samples set reported_at = reported_at - interval '1 hour' where device_id = $1",
    [deviceId],
  );
  return reply;
}

function strategyItem(over = {}) {
  return {
    accountName: 'ACC 01',
    strategyId: '100',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: 120.5,
    unrealizedPnl: 0,
    restartedAt: null,
    ...over,
  };
}

/** One strategy report, through step 57's RPC; the clock moves on the same way. */
async function strategies(deviceId, sampledAt, items) {
  const result = await db.query(
    'select public.record_algorithm_live_sample($1, $2::timestamptz, $3::jsonb) as r',
    [deviceId, sampledAt, JSON.stringify(items)],
  );
  const reply = result.rows[0].r;
  if (reply.throttled) throw new Error(`strategies throttled at ${sampledAt}`);
  await db.query(
    "update public.algorithm_live_samples set reported_at = reported_at - interval '1 hour' where device_id = $1",
    [deviceId],
  );
  return reply;
}

async function historyRuns(deviceId, accountName) {
  return (await db.query(
    `select account_name, connection_name, connected, status, realized_pnl, unrealized_pnl, total_pnl,
            strategy_count, enabled_strategy_count, run_state, first_sampled_at, last_sampled_at, samples
       from public.account_live_sample_history
      where device_id = $1 and ($2::text is null or account_name = $2)
      order by account_name, first_sampled_at`,
    [deviceId, accountName ?? null])).rows;
}

async function readings(importId) {
  return (await db.query(
    `select r.*, r.trading_date::text as trading_date_text
       from public.tracker_close_readings as r where daily_import_id = $1 order by lower(account_name)`,
    [importId])).rows;
}

async function reading(importId, name) {
  return (await readings(importId)).find((row) => row.account_name.toLowerCase() === name.toLowerCase());
}

async function comparisons(importId) {
  return (await db.query(
    `select action, after_data, created_at from public.audit_logs
      where entity_type = 'daily_import' and entity_id = $1 order by created_at`, [importId])).rows;
}

function snapshot(accountName, grossRealizedPnl, over = {}) {
  return { accountName, connection: 'Northwind', grossRealizedPnl, unrealizedPnl: 0, ...over };
}

function closeStrategy(accountName, strategyName, instrument, realized) {
  return { accountName, strategyName, instrument, realized, unrealized: 0, enabled: false, ran: true, ranBasis: 'fills' };
}

/**
 * A close, the way server/autoCollection/ingest/daily.js makes one: claim the
 * capture, persist the import, finalize the batch. Returns what finalize said
 * and every NOTICE or WARNING raised while it ran.
 */
async function closeDay({ conn = db, client, device, day = DAY, capturedAt, snapshots, closeStrategies = [], status = 'processed' }) {
  const capture = randomUUID();
  const token = randomUUID();
  const rowCounts = { accounts: snapshots.length, strategies: closeStrategies.length, orders: 0, executions: 0 };
  const claimed = (await conn.query(
    `select public.claim_ingest_batch_v4($1, $2, $3::date, $4::timestamptz, 1, $5, $6, 10, $7::jsonb, $8, 120) as r`,
    [device, capture, day, capturedAt, `${client}/${day}/${capture}.json.gz`, 'a'.repeat(64),
      JSON.stringify(rowCounts), token])).rows[0].r;
  if (claimed.outcome !== 'owned') throw new Error(`claim: ${claimed.outcome}`);
  const batchId = claimed.batch.id;
  const importResult = {
    id: randomUUID(),
    date: day,
    status: 'Needs review',
    snapshots,
    strategies: closeStrategies,
    orders: [],
    executions: [],
    flags: [],
    pnlSourceSummary: { realized: snapshots.length, gross_fallback: 0, gross_missing_realized: 0, unavailable: 0, unknown: 0 },
  };
  const persisted = (await conn.query(
    'select public.persist_auto_daily_import_v3($1, $2, $3, $4::jsonb) as r',
    [client, batchId, token, JSON.stringify(importResult)])).rows[0].r;
  if (persisted.disposition !== 'persisted') throw new Error(`persist: ${persisted.disposition}`);
  const importId = persisted.daily_import.id;
  const notices = [];
  const finalized = await conn.query(
    `select status, daily_import_id, processed_at from public.finalize_ingest_batch_v3(
       $1, $2, $3, $4, $5, $6, $7::timestamptz, true, null, '{}'::jsonb, $8::jsonb,
       'ingest_batch_processed', '{"storage": 1}'::jsonb, 5)`,
    [batchId, device, client, token, status, importId, capturedAt, JSON.stringify(rowCounts)],
    { onNotice: (notice) => notices.push(`${notice.severity}: ${notice.message}`) },
  );
  return { batchId, importId, status: finalized.rows[0].status, notices };
}

async function refusal(sqlText, params) {
  try {
    await db.query(sqlText, params);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

async function functionDefinition(signature) {
  return one(db, `select pg_get_functiondef('${signature}'::regprocedure)`);
}

async function executeGrantees(signature) {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

async function settings() {
  return (await db.query(`select history_retention_days, pre_close_grace_seconds, close_match_tolerance_dollars,
    close_match_tolerance_ratio, max_strategies_per_account, stale_sample_seconds, retention_days
    from public.account_tracker_settings where id`)).rows[0];
}

async function resetSettings() {
  await db.exec(`update public.account_tracker_settings
    set history_retention_days = 5, pre_close_grace_seconds = 120, close_match_tolerance_dollars = 5,
        close_match_tolerance_ratio = 0.02, max_strategies_per_account = 50 where id`);
}

/* ── The world ───────────────────────────────────────────────────────────── */

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

  // Gray holds Client A, Birch holds Client B, Client C is nobody's.
  for (const [key, owner] of [['A', world.gray], ['B', world.birch], ['C', null]]) {
    world.clients[key] = await one(db, 'insert into public.clients (name) values ($1) returning id', [`Client ${key}`]);
    if (owner) {
      await db.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
        [world.clients[key], owner.profile]);
    }
  }
  world.devices.A = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clients.A]);
  world.devices.C = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clients.C]);
  // Client B has three machines: the first paired, a later one on its own
  // schedule, and a revoked one paired last. The scheduled fallback must pick
  // the later ACTIVE one, never the revoked one, and must read its schedule.
  world.devices.B1 = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [world.clients.B]);
  world.devices.B2 = await one(db,
    `insert into public.ingest_devices (client_id, schedule_time, created_at)
     values ($1, '16:15:00', clock_timestamp() + interval '1 second') returning id`, [world.clients.B]);
  world.devices.B3 = await one(db,
    `insert into public.ingest_devices (client_id, status, revoked_at, created_at)
     values ($1, 'revoked', now(), clock_timestamp() + interval '2 seconds') returning id`, [world.clients.B]);
  // Step 28 reads EITHER mark as revoked (status <> 'active' or revoked_at set,
  // its own device check), so the fallback must skip a machine that carries only
  // one of the two, even when it is the latest paired.
  world.devices.B4 = await one(db,
    `insert into public.ingest_devices (client_id, status, created_at)
     values ($1, 'revoked', clock_timestamp() + interval '3 seconds') returning id`, [world.clients.B]);
  world.devices.B5 = await one(db,
    `insert into public.ingest_devices (client_id, revoked_at, created_at)
     values ($1, now(), clock_timestamp() + interval '4 seconds') returning id`, [world.clients.B]);

  /* CLIENT A'S DAY, as the VPS reported it. Chronological, because the RPC
   * refuses to walk a reading backwards. ACC 06 is a flat night: the same
   * reading the evening before and again in the morning. ACC 07 was last seen
   * the day before and never today. */
  const a = world.devices.A;
  await sample(a, at(PRIOR, '15:00'), [account({ accountName: 'ACC 07', realizedPnl: 3, totalPnl: 3 })]);
  await sample(a, at(PRIOR, '18:00'), [account({ accountName: 'ACC 06', strategyCount: 0, enabledStrategyCount: 0 })]);
  await sample(a, at(DAY, '09:00'), [account({ accountName: 'ACC 06', strategyCount: 0, enabledStrategyCount: 0 })]);
  await sample(a, at(DAY, '16:00'), [account({ accountName: 'ACC 03', realizedPnl: 55, totalPnl: 55 })]);
  await sample(a, at(DAY, '16:10'), [account({ realizedPnl: 100, totalPnl: 100 })]);
  await sample(a, at(DAY, '16:20'), [account({ realizedPnl: 120.5, totalPnl: 120.5 })]);
  await sample(a, at(DAY, '16:30'), [account({ realizedPnl: 120.5, totalPnl: 120.5 })]);
  await strategies(a, at(DAY, '16:30'), [
    strategyItem(),
    strategyItem({ strategyId: '101', strategyName: '1 - ALPHA-1.0', algorithm: 'ALPHA', instrument: 'NQ 12-26', instrumentRoot: 'NQ', realizedPnl: 0 }),
  ]);
  // A third instance read TODAY, after the trading day ended. algorithm_live_samples
  // keeps the latest reading per instance, so a hand pin of yesterday's import
  // run today would find it; the day's upper bound must leave it out.
  await strategies(a, at(TODAY, '00:01'), [
    strategyItem({ strategyId: '102', strategyName: '2 - BETA-1.0', algorithm: 'BETA', instrument: 'ES 12-26', instrumentRoot: 'ES', realizedPnl: 9 }),
  ]);
  await sample(a, at(DAY, '16:32'), [account({ accountName: 'ACC 05', realizedPnl: 7, totalPnl: 7 })]);
  await sample(a, at(DAY, '16:40'), [
    account({ realizedPnl: 130, totalPnl: 130 }),
    account({ accountName: 'ACC 02', realizedPnl: 12, totalPnl: 12 }),
    // ACC 03 says its 16:00 reading again, so that one run straddles the cutoff:
    // the pinned clock must be capped at the cutoff, not the run's last sample.
    account({ accountName: 'ACC 03', realizedPnl: 55, totalPnl: 55 }),
  ]);

  /* CLIENT B'S DAY: a NinjaTrader restart at noon. */
  const b = world.devices.B1;
  await sample(b, at(DAY, '10:00'), [account({ accountName: 'ACC 11', realizedPnl: 500, totalPnl: 500 })]);
  await sample(b, at(DAY, '12:00'), [account({ accountName: 'ACC 11', realizedPnl: 0, totalPnl: 0 })]);
  await sample(b, at(DAY, '14:00'), [account({ accountName: 'ACC 11', realizedPnl: 20, totalPnl: 20 })]);
}, 180_000);

afterAll(async () => { await db?.close?.(); });

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 66 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 66)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(66);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 65, in the run order after 65, and says how it degrades', () => {
    expect(runbook).toMatch(/^\| 66 \| `step_66_tracker_close_readings\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 66 | `step_66_tracker_close_readings.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 65 | `step_65_account_observations.sql`'));
    expect(runbook).toMatch(/→ 63 → 64 → 65 → 66(?: →|\.)/);
    expect(runbook).toContain('66 degrades gracefully');
  });

  it('refuses to run before steps 55 and 52, and says which', async () => {
    await expect(startMigrationCluster(
      migrationFilesInOrder({ upTo: 53 }).concat([STEP]),
    )).rejects.toThrow(/step 66 needs step 55 \(account_live_samples\) and step 52 \(is_manager\): run them first/);
  }, 120_000);

  it('refuses to run before step 57, and leaves nothing behind when it does', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 56 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 66 needs step 57 \(algorithm_live_samples\)/);
      await early.exec('rollback');
      expect(await one(early, "select to_regclass('public.tracker_close_readings')::text")).toBeNull();
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_name = 'account_tracker_settings' and column_name = 'pre_close_grace_seconds'`)).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── The tunables ────────────────────────────────────────────────────────── */

describe('the five tunables on account_tracker_settings', () => {
  it('ship with the designed defaults, beside step 55\'s own', async () => {
    const row = await settings();
    expect(num(row.history_retention_days)).toBe(5);
    expect(num(row.pre_close_grace_seconds)).toBe(120);
    expect(num(row.close_match_tolerance_dollars)).toBe(5);
    expect(num(row.close_match_tolerance_ratio)).toBe(0.02);
    expect(num(row.max_strategies_per_account)).toBe(50);
    expect(num(row.stale_sample_seconds)).toBe(1500);
    expect(num(row.retention_days)).toBe(7);
  });

  it('refuse a hand edit outside each range, by a named constraint', async () => {
    const cases = [
      ['history_retention_days', 0, 'account_tracker_settings_history_retention_check'],
      ['history_retention_days', 31, 'account_tracker_settings_history_retention_check'],
      ['pre_close_grace_seconds', -1, 'account_tracker_settings_grace_check'],
      ['pre_close_grace_seconds', 601, 'account_tracker_settings_grace_check'],
      ['close_match_tolerance_dollars', -0.01, 'account_tracker_settings_tolerance_dollars_check'],
      ['close_match_tolerance_dollars', 10000.01, 'account_tracker_settings_tolerance_dollars_check'],
      ['close_match_tolerance_ratio', -0.001, 'account_tracker_settings_tolerance_ratio_check'],
      ['close_match_tolerance_ratio', 1.001, 'account_tracker_settings_tolerance_ratio_check'],
      ['max_strategies_per_account', 0, 'account_tracker_settings_strategies_per_account_check'],
      ['max_strategies_per_account', 201, 'account_tracker_settings_strategies_per_account_check'],
    ];
    for (const [columnName, value, constraint] of cases) {
      expect(await refusal(`update public.account_tracker_settings set ${columnName} = $1 where id`, [value]),
        `${columnName} = ${value}`).toMatch(new RegExp(constraint));
    }
    // And the edges are accepted.
    expect(await refusal('update public.account_tracker_settings set history_retention_days = 30, pre_close_grace_seconds = 0, close_match_tolerance_dollars = 0, close_match_tolerance_ratio = 1, max_strategies_per_account = 200 where id')).toBeNull();
    await resetSettings();
  });

  it('a tolerance change is one UPDATE, the way the runbook says', async () => {
    expect(await refusal('update public.account_tracker_settings set close_match_tolerance_dollars = 10, updated_at = now() where id')).toBeNull();
    expect(num((await settings()).close_match_tolerance_dollars)).toBe(10);
    await resetSettings();
  });
});

/* ── The history ─────────────────────────────────────────────────────────── */

describe('account_live_sample_history: one row per value run', () => {
  const name = 'ACC 21';
  let c;
  beforeAll(() => { c = world.devices.C; });

  it('two equal readings are one run with two samples; a changed figure opens a new run', async () => {
    await sample(c, at(DAY, '10:00'), [account({ accountName: name, realizedPnl: 1, totalPnl: 1 })]);
    await sample(c, at(DAY, '10:10'), [account({ accountName: name, realizedPnl: 1, totalPnl: 1 })]);
    let runs = await historyRuns(c, name);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ samples: 2, run_state: 'running' });
    expect(ms(runs[0].first_sampled_at)).toBe(ms(at(DAY, '10:00')));
    expect(ms(runs[0].last_sampled_at)).toBe(ms(at(DAY, '10:10')));

    await sample(c, at(DAY, '10:20'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2 })]);
    runs = await historyRuns(c, name);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => [num(run.realized_pnl), run.samples])).toEqual([[1, 2], [2, 1]]);
  });

  it('a replay with the same sampled_at is a no op, whatever values it carries', async () => {
    /* Step 55's upsert accepts an EQUAL sampled_at (its guard is >=), so a retried
     * report reaches this trigger with the row rewritten and nothing newer in it.
     * Counting it would inflate `samples` on every retry. */
    const before = await historyRuns(c, name);
    await sample(c, at(DAY, '10:20'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2 })]);
    expect(await historyRuns(c, name)).toEqual(before);
    await sample(c, at(DAY, '10:20'), [account({ accountName: name, realizedPnl: 999, totalPnl: 999 })]);
    expect(await historyRuns(c, name)).toEqual(before);
  });

  it('a changed connection name or a changed strategy count is a new run, even with the same money', async () => {
    await sample(c, at(DAY, '10:30'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2, connectionName: 'Northwind B' })]);
    await sample(c, at(DAY, '10:40'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2, connectionName: 'Northwind B', strategyCount: 2, enabledStrategyCount: 1 })]);
    const runs = await historyRuns(c, name);
    expect(runs).toHaveLength(4);
    expect(runs[2]).toMatchObject({ connection_name: 'Northwind B', samples: 1, run_state: 'running' });
    expect(runs[3]).toMatchObject({ connection_name: 'Northwind B', enabled_strategy_count: 1, samples: 1, run_state: 'running' });
  });

  it('every compared field opens a new run on its own, and reported_at is not one of them', async () => {
    /* One field at a time, so a comparison quietly dropped from the trigger is
     * seen: realized and total move together in every other fixture here, and a
     * trigger that forgot realized_pnl would still open a run through total_pnl. */
    const base = { accountName: 'ACC 24', realizedPnl: 10, unrealizedPnl: 1, totalPnl: 11, strategyCount: 3, enabledStrategyCount: 2 };
    const changes = [
      { connectionName: 'Northwind B' },
      { connected: false },
      { status: 'ConnectionLost' },
      { realizedPnl: 20 },
      { unrealizedPnl: 2 },
      { totalPnl: 12 },
      { strategyCount: 4, enabledStrategyCount: 2 },
      { enabledStrategyCount: 3 },
    ];
    let minute = 0;
    const clockAt = () => at(DAY, `12:${String(minute).padStart(2, '0')}`);
    await sample(c, clockAt(), [account(base)]);
    expect(await historyRuns(c, 'ACC 24')).toHaveLength(1);
    let current = { ...base };
    for (const change of changes) {
      minute += 1;
      current = { ...current, ...change };
      await sample(c, clockAt(), [account(current)]);
      const runs = await historyRuns(c, 'ACC 24');
      expect(runs, JSON.stringify(change)).toHaveLength(1 + changes.indexOf(change) + 1);
      expect(runs.at(-1).samples).toBe(1);
    }
    // The same reading again, a minute later: the last run extends, no new one.
    minute += 1;
    await sample(c, clockAt(), [account(current)]);
    const runs = await historyRuns(c, 'ACC 24');
    expect(runs).toHaveLength(1 + changes.length);
    expect(runs.at(-1).samples).toBe(2);
  });

  it('run_state is copied from the sample, in step 55\'s four words', async () => {
    await sample(c, at(DAY, '10:50'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2, connectionName: 'Northwind B', strategyCount: 0, enabledStrategyCount: 0 })]);
    await sample(c, at(DAY, '11:00'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2, connectionName: 'Northwind B', strategyCount: null, enabledStrategyCount: null })]);
    await sample(c, at(DAY, '11:10'), [account({ accountName: name, realizedPnl: 2, totalPnl: 2, connectionName: 'Northwind B', strategyCount: 3, enabledStrategyCount: 0 })]);
    const runs = await historyRuns(c, name);
    expect(runs.slice(-3).map((run) => run.run_state)).toEqual(['no_strategies', 'unmeasured', 'idle']);
  });

  it('a report that omits the account leaves its history alone', async () => {
    const before = await historyRuns(c, name);
    await sample(c, at(DAY, '11:20'), [account({ accountName: 'ACC 22', realizedPnl: 0 })]);
    expect(await historyRuns(c, name)).toEqual(before);
    expect(await historyRuns(c, 'ACC 22')).toHaveLength(1);
  });

  it('a run older than history_retention_days leaves on the next sample from that machine, a younger one stays', async () => {
    await db.query(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at, samples)
      values ($1, $2, 'ACC 98', true, 'running', clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days', 1),
             ($1, $2, 'ACC 97', true, 'running', clock_timestamp() - interval '3 days', clock_timestamp() - interval '3 days', 1)`,
    [c, world.clients.C]);
    await sample(c, at(DAY, '11:30'), [account({ accountName: 'ACC 22', realizedPnl: 0 })]);
    const names = await column(db,
      'select distinct account_name from public.account_live_sample_history where device_id = $1 order by 1', [c]);
    expect(names).toContain('ACC 97');
    expect(names).not.toContain('ACC 98');
  });

  it('a history fault never refuses the sample: the RPC records, a WARNING is raised', async () => {
    const notices = [];
    const before = await one(db, 'select count(*)::int from public.account_live_sample_history where device_id = $1', [c]);
    try {
      await db.exec('begin');
      await db.exec('alter table public.account_live_sample_history add constraint step66_test_boom check (false) not valid');
      const reply = (await db.query(
        'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as r',
        [c, at(DAY, '11:40'), JSON.stringify([account({ accountName: 'ACC 23', realizedPnl: 4, totalPnl: 4 })])],
        { onNotice: (notice) => notices.push(`${notice.severity}: ${notice.message}`) })).rows[0].r;
      expect(reply).toMatchObject({ recorded: 1, throttled: false });
      expect(await one(db, "select count(*)::int from public.account_live_samples where device_id = $1 and account_name = 'ACC 23'", [c])).toBe(1);
      expect(await one(db, 'select count(*)::int from public.account_live_sample_history where device_id = $1', [c])).toBe(before);
    } finally {
      await db.exec('rollback');
    }
    expect(notices.filter((n) => /^WARNING: step 66: account_live_sample_history_record skipped/.test(n))).toHaveLength(1);
    expect(notices[0]).toContain('ACC 23');
    expect(notices[0]).toContain('step66_test_boom');
  });

  it('the history checks restate step 55\'s own, so a hand insert cannot hold what a sample could not', async () => {
    expect(await refusal(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
      values ($1, $2, ' padded ', true, 'running', now(), now())`, [c, world.clients.C]))
      .toMatch(/account_live_sample_history_account_name_check/);
    expect(await refusal(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
      values ($1, $2, 'ACC 99', true, 'elsewhere', now(), now())`, [c, world.clients.C]))
      .toMatch(/account_live_sample_history_run_state_check/);
    expect(await refusal(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
      values ($1, $2, 'ACC 99', true, 'running', now(), now() - interval '1 second')`, [c, world.clients.C]))
      .toMatch(/account_live_sample_history_span_check/);
    expect(await refusal(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at, strategy_count)
      values ($1, $2, 'ACC 99', true, 'running', now(), now(), 1)`, [c, world.clients.C]))
      .toMatch(/account_live_sample_history_counts_check/);
  });
});

/* ── The close pin, through the route's own chain ───────────────────────── */

describe('a close finalized as processed pins the tracker side', () => {
  beforeAll(async () => {
    const closed = await closeDay({
      client: world.clients.A,
      device: world.devices.A,
      capturedAt: at(DAY, '16:31'),
      snapshots: [
        snapshot('ACC 01', 120.5),
        snapshot('ACC 02', 12),
        snapshot('ACC 04', 0),
        // The close spells it in lower case; the tracker said 'ACC 06'.
        snapshot('acc 06', 0),
        snapshot('ACC 07', 3),
      ],
      closeStrategies: [
        closeStrategy('ACC 01', '0 - OGX-PF-2.4', 'MNQ 12-26', 120.5),
        closeStrategy('ACC 01', '1 - ALPHA-1.0', 'NQ 12-26', 0),
      ],
    });
    world.imports.A = closed.importId;
    world.batches.A1 = closed.batchId;
    world.firstClose = closed;
  }, 60_000);

  it('the finalize itself succeeded and raised nothing', () => {
    expect(world.firstClose.status).toBe('processed');
    expect(world.firstClose.notices).toEqual([]);
  });

  it('one row per account in the union of the close and the readings, with the close\'s spelling', async () => {
    const rows = await readings(world.imports.A);
    expect(rows.map((row) => row.account_name)).toEqual(['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04', 'ACC 05', 'acc 06', 'ACC 07']);
    expect(rows.map((row) => row.source)).toEqual([
      'crm_history', 'none', 'crm_history', 'none', 'crm_history', 'crm_history', 'none',
    ]);
    for (const row of rows) {
      expect(row.client_id).toBe(world.clients.A);
      expect(row.close_batch_id).toBe(world.batches.A1);
      expect(row.close_time_basis).toBe('captured');
      expect(ms(row.close_captured_at)).toBe(ms(at(DAY, '16:31')));
      expect(row.grace_seconds).toBe(120);
      expect(row.stale_seconds).toBe(1500);
      expect(row.trading_date_text).toBe(DAY);
    }
  });

  it('picks the run in force at the cutoff: 16:20 held to 16:30 is the reading, not 16:40', async () => {
    const row = await reading(world.imports.A, 'ACC 01');
    expect(num(row.realized_pnl)).toBe(120.5);
    expect(num(row.total_pnl)).toBe(120.5);
    expect(row.connected).toBe(true);
    expect(row.connection_name).toBe('Northwind');
    expect(row.run_state).toBe('running');
    expect(row.device_id).toBe(world.devices.A);
    // sampled_at is the last sample of that run, which is before the cutoff.
    expect(ms(row.sampled_at)).toBe(ms(at(DAY, '16:30')));
    expect(ms(row.reading_since)).toBe(ms(at(DAY, '16:20')));
    expect(row.reset_seen).toBe(false);
  });

  it('next_sampled_at is the first run that starts after the cutoff, so after_close is a stored fact', async () => {
    expect(ms((await reading(world.imports.A, 'ACC 01')).next_sampled_at)).toBe(ms(at(DAY, '16:40')));
    const late = await reading(world.imports.A, 'ACC 02');
    expect(late.source).toBe('none');
    expect(late.sampled_at).toBeNull();
    expect(late.connected).toBeNull();
    expect(late.realized_pnl).toBeNull();
    expect(ms(late.next_sampled_at)).toBe(ms(at(DAY, '16:40')));
    const never = await reading(world.imports.A, 'ACC 04');
    expect(never.source).toBe('none');
    expect(never.next_sampled_at).toBeNull();
  });

  it('a reading inside the grace window counts, an account the close does not list is still pinned', async () => {
    const grace = await reading(world.imports.A, 'ACC 05');
    expect(grace.source).toBe('crm_history');
    expect(num(grace.realized_pnl)).toBe(7);
    expect(ms(grace.sampled_at)).toBe(ms(at(DAY, '16:32')));
    const trackerOnly = await reading(world.imports.A, 'ACC 03');
    expect(trackerOnly.source).toBe('crm_history');
    expect(num(trackerOnly.realized_pnl)).toBe(55);
    // Its run is 16:00 to 16:40 and straddles the 16:33 cutoff: the pinned clock
    // is the cutoff, the moment the reading is known to have held, never 16:40.
    expect(ms(trackerOnly.reading_since)).toBe(ms(at(DAY, '16:00')));
    expect(ms(trackerOnly.sampled_at)).toBe(ms(at(DAY, '16:33')));
    expect(trackerOnly.next_sampled_at).toBeNull();
  });

  it('a flat night is one run that reaches into the day; a run that ended yesterday is not a reading', async () => {
    const flat = await reading(world.imports.A, 'acc 06');
    expect(flat.source).toBe('crm_history');
    expect(ms(flat.reading_since)).toBe(ms(at(PRIOR, '18:00')));
    expect(ms(flat.sampled_at)).toBe(ms(at(DAY, '09:00')));
    expect(flat.run_state).toBe('no_strategies');
    const gone = await reading(world.imports.A, 'ACC 07');
    expect(gone.source).toBe('none');
    expect(gone.next_sampled_at).toBeNull();
  });

  it('the strategies of the day are pinned beside the account, in the designed keys', async () => {
    const row = await reading(world.imports.A, 'ACC 01');
    expect(row.strategies).toHaveLength(2);
    expect(row.strategies[0]).toMatchObject({
      strategyId: '100', strategyName: '0 - OGX-PF-2.4', algorithm: 'OGX_PF', instrument: 'MNQ 12-26',
      realizedPnl: 120.5, unrealizedPnl: 0, restartedAt: null,
    });
    expect(ms(row.strategies[0].sampledAt)).toBe(ms(at(DAY, '16:30')));
    expect(row.strategies[1]).toMatchObject({ strategyName: '1 - ALPHA-1.0', realizedPnl: 0 });
    // The instance read today, after the day ended, is not one of the day's.
    expect(row.strategies.map((item) => item.strategyId)).toEqual(['100', '101']);
    expect((await reading(world.imports.A, 'ACC 02')).strategies).toEqual([]);
  });

  it('writes one audit row per comparison, with camelCase counts that tell a history gap from a silent fleet', async () => {
    const rows = await comparisons(world.imports.A);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('tracker_close_compared');
    expect(rows[0].after_data).toMatchObject({
      clientId: world.clients.A,
      dailyImportId: world.imports.A,
      tradingDate: DAY,
      closeBatchId: world.batches.A1,
      deviceId: world.devices.A,
      closeTimeBasis: 'captured',
      graceSeconds: 120,
      staleSeconds: 1500,
      accountsPinned: 7,
      accountsInClose: 5,
      accountsFromHistory: 4,
      accountsWithoutReading: 3,
      accountsReadAfterClose: 1,
      resetsSeen: 0,
      strategiesPinned: 2,
      historyRowsSeen: 5,
      liveRowsSeen: 6,
    });
    expect(ms(rows[0].after_data.closeCapturedAt)).toBe(ms(at(DAY, '16:31')));
    expect(ms(rows[0].after_data.cutoffAt)).toBe(ms(at(DAY, '16:33')));
    expect(await one(db, "select user_id from public.audit_logs where entity_type = 'daily_import' and entity_id = $1", [world.imports.A])).toBeNull();
    expect(JSON.stringify(rows[0].after_data)).not.toMatch(/[—–]/);
  });
});

describe('record_tracker_close_readings called directly', () => {
  beforeEach(async () => { await resetSettings(); });
  afterAll(async () => { await resetSettings(); });

  it('replaces the import\'s rows wholesale and writes another audit row: idempotent, never duplicated', async () => {
    const before = await readings(world.imports.A);
    const reply = await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    expect(reply).toMatchObject({ recorded: true, accountsPinned: 7, closeTimeBasis: 'captured' });
    const after = await readings(world.imports.A);
    expect(after).toHaveLength(7);
    expect(after.map((row) => row.account_name)).toEqual(before.map((row) => row.account_name));
    expect(after.map((row) => row.id)).not.toEqual(before.map((row) => row.id));
    const stable = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'compared_at'].includes(key)));
    for (let i = 0; i < after.length; i += 1) {
      expect(ms(after[i].compared_at)).toBeGreaterThan(ms(before[i].compared_at));
      expect(stable(after[i])).toEqual(stable(before[i]));
    }
    expect(await comparisons(world.imports.A)).toHaveLength(2);
  });

  it('the grace moves the cutoff: at zero the 16:32 account is not a reading at all, at ten minutes the 16:40 runs are', async () => {
    /* ACC 05 is not in the close and, at a 16:31 cutoff, has no run that began
     * in time, so it is in neither half of the union and has no row: the union is
     * the close's accounts plus the PICKED readings, not every account the
     * tracker ever saw. */
    await db.exec('update public.account_tracker_settings set pre_close_grace_seconds = 0 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    let rows = await readings(world.imports.A);
    expect(rows.map((row) => row.account_name)).toEqual(['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04', 'acc 06', 'ACC 07']);
    expect(rows.every((row) => row.grace_seconds === 0)).toBe(true);
    // The 16:30 reading of ACC 01 is still in force at a 16:31 cutoff.
    expect(ms(rows[0].sampled_at)).toBe(ms(at(DAY, '16:30')));
    expect(ms(rows[0].next_sampled_at)).toBe(ms(at(DAY, '16:40')));
    // ACC 03's straddling run is capped at the new cutoff.
    expect(ms(rows[2].sampled_at)).toBe(ms(at(DAY, '16:31')));

    /* Ten minutes of grace reach the 16:40 runs: ACC 02 becomes a reading, ACC
     * 01's pick moves to its 16:40 run and nothing follows it. */
    await db.exec('update public.account_tracker_settings set pre_close_grace_seconds = 600 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    rows = await readings(world.imports.A);
    expect(rows.map((row) => row.account_name)).toEqual(['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04', 'ACC 05', 'acc 06', 'ACC 07']);
    expect(rows[0]).toMatchObject({ source: 'crm_history', next_sampled_at: null });
    expect(num(rows[0].realized_pnl)).toBe(130);
    expect(ms(rows[0].sampled_at)).toBe(ms(at(DAY, '16:40')));
    expect(rows[1].source).toBe('crm_history');
    expect(num(rows[1].realized_pnl)).toBe(12);
    expect(ms(rows[1].sampled_at)).toBe(ms(at(DAY, '16:40')));
    expect(ms(rows[1].reading_since)).toBe(ms(at(DAY, '16:40')));
    // And with the cutoff past 16:40, ACC 03's clock is its real last sample.
    expect(ms(rows[2].sampled_at)).toBe(ms(at(DAY, '16:40')));
  });

  it('a run that begins exactly at the cutoff second is the reading, not the next one', async () => {
    /* ACC 05's run begins at 16:32:00. One minute of grace on the 16:31 capture
     * puts the cutoff on that very second: a run in force AT the cutoff is the
     * pick, its clock is the cutoff, and it is not "the first run after the
     * cutoff", so next_sampled_at stays null. */
    await db.exec('update public.account_tracker_settings set pre_close_grace_seconds = 60 where id');
    const reply = await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    expect(ms(reply.cutoffAt)).toBe(ms(at(DAY, '16:32')));
    const boundary = await reading(world.imports.A, 'ACC 05');
    expect(boundary).toMatchObject({ source: 'crm_history', next_sampled_at: null });
    expect(num(boundary.realized_pnl)).toBe(7);
    expect(ms(boundary.reading_since)).toBe(ms(at(DAY, '16:32')));
    expect(ms(boundary.sampled_at)).toBe(ms(at(DAY, '16:32')));
    // ACC 01 is untouched: the 16:30 reading, and its 16:40 run is still after the cutoff.
    const first = await reading(world.imports.A, 'ACC 01');
    expect(ms(first.sampled_at)).toBe(ms(at(DAY, '16:30')));
    expect(ms(first.next_sampled_at)).toBe(ms(at(DAY, '16:40')));
  });

  it('caps the pinned strategies at max_strategies_per_account', async () => {
    await db.exec('update public.account_tracker_settings set max_strategies_per_account = 1 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    const row = await reading(world.imports.A, 'ACC 01');
    expect(row.strategies).toHaveLength(1);
    expect(row.strategies[0].strategyName).toBe('0 - OGX-PF-2.4');
    await db.exec('update public.account_tracker_settings set max_strategies_per_account = 50 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.A]);
    expect((await reading(world.imports.A, 'ACC 01')).strategies).toHaveLength(2);
  });

  it('without a batch it uses the client\'s latest ACTIVE machine schedule, basis scheduled', async () => {
    world.imports.B = await one(db,
      'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clients.B, DAY]);
    await db.query(`insert into public.account_snapshots (daily_import_id, account_name, connection, gross_realized_pnl)
      values ($1, 'ACC 11', 'Northwind', 20), ($1, 'ACC 12', '', 0)`, [world.imports.B]);
    const reply = await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.B]);
    expect(reply).toMatchObject({ recorded: true, closeTimeBasis: 'scheduled', accountsPinned: 2 });
    const rows = await readings(world.imports.B);
    expect(rows.map((row) => row.account_name)).toEqual(['ACC 11', 'ACC 12']);
    for (const row of rows) {
      expect(row.close_time_basis).toBe('scheduled');
      expect(row.close_batch_id).toBeNull();
      // Device B2's own 16:15, not the 16:30 default, in New York.
      expect(ms(row.close_captured_at)).toBe(ms(at(DAY, '16:15')));
    }
    const audit = (await comparisons(world.imports.B))[0].after_data;
    expect(audit).toMatchObject({ closeTimeBasis: 'scheduled', closeBatchId: null, deviceId: world.devices.B2 });
    expect(ms(audit.cutoffAt)).toBe(ms(at(DAY, '16:17')));
  });

  it('reset_seen: a connected account whose realized fell from far outside the tolerance to inside it', async () => {
    const row = await reading(world.imports.B, 'ACC 11');
    expect(row.source).toBe('crm_history');
    expect(row.reset_seen).toBe(true);
    expect(num(row.realized_pnl)).toBe(20);
    expect(ms(row.sampled_at)).toBe(ms(at(DAY, '14:00')));
    expect(row.device_id).toBe(world.devices.B1);
    expect((await reading(world.imports.B, 'ACC 12')).reset_seen).toBe(false);
    expect((await comparisons(world.imports.B))[0].after_data.resetsSeen).toBe(1);
  });

  it('a fall that stays outside the tolerance is not a reset', async () => {
    // 500 to 0 is a reset at a $5 tolerance (500 > 50, 0 <= 5). At $60 it is
    // not: 500 is not beyond ten times the tolerance, so nothing "fell to zero".
    await db.exec('update public.account_tracker_settings set close_match_tolerance_dollars = 60 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.B]);
    expect((await reading(world.imports.B, 'ACC 11')).reset_seen).toBe(false);
    await db.exec('update public.account_tracker_settings set close_match_tolerance_dollars = 5 where id');
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.B]);
    expect((await reading(world.imports.B, 'ACC 11')).reset_seen).toBe(true);
  });

  it('an unknown import is answered, not raised', async () => {
    const reply = await one(db, "select public.record_tracker_close_readings('00000000-0000-4000-8000-000000000000')");
    expect(reply).toMatchObject({ recorded: false, reason: 'no_daily_import' });
  });

  it('a deleted settings row falls back to the defaults, as step 55\'s RPC does', async () => {
    try {
      await db.exec('begin');
      await db.exec('delete from public.account_tracker_settings');
      const reply = await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.B]);
      expect(reply).toMatchObject({ recorded: true, graceSeconds: 120, staleSeconds: 1500 });
      const notices = [];
      const sampled = (await db.query(
        'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as r',
        [world.devices.B1, at(DAY, '15:00'), JSON.stringify([account({ accountName: 'ACC 11', realizedPnl: 21, totalPnl: 21 })])],
        { onNotice: (notice) => notices.push(notice.message) })).rows[0].r;
      expect(sampled.recorded).toBe(1);
      expect(notices).toEqual([]);
      expect(await historyRuns(world.devices.B1, 'ACC 11')).toHaveLength(4);
    } finally {
      await db.exec('rollback');
    }
  });
});

describe('a second close of the same day', () => {
  beforeAll(async () => {
    world.secondClose = await closeDay({
      client: world.clients.A,
      device: world.devices.A,
      capturedAt: at(DAY, '16:45'),
      snapshots: [snapshot('ACC 01', 130), snapshot('ACC 02', 12), snapshot('ACC 04', 0)],
    });
    world.batches.A2 = world.secondClose.batchId;
  }, 60_000);

  it('is the same import, the prior batch is replaced, and the finalize raised nothing', async () => {
    expect(world.secondClose.importId).toBe(world.imports.A);
    expect(world.secondClose.status).toBe('processed');
    expect(world.secondClose.notices).toEqual([]);
    expect(await one(db, 'select status from public.ingest_batches where id = $1', [world.batches.A1])).toBe('replaced');
  });

  it('replaces the pinned rows: the later cutoff picks the 16:40 run, and the 16:40 account is now a reading', async () => {
    /* persist_auto_daily_import upserts account_snapshots and never deletes the
     * ones a later payload omits (step 50), so the close still lists acc 06 and
     * ACC 07 and the union still has seven names. The pin follows the table. */
    const rows = await readings(world.imports.A);
    expect(rows.map((row) => row.account_name)).toEqual(['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04', 'ACC 05', 'acc 06', 'ACC 07']);
    for (const row of rows) {
      expect(row.close_batch_id).toBe(world.batches.A2);
      expect(ms(row.close_captured_at)).toBe(ms(at(DAY, '16:45')));
    }
    const first = rows[0];
    expect(num(first.realized_pnl)).toBe(130);
    expect(ms(first.reading_since)).toBe(ms(at(DAY, '16:40')));
    expect(ms(first.sampled_at)).toBe(ms(at(DAY, '16:40')));
    expect(first.next_sampled_at).toBeNull();
    const second = rows[1];
    expect(second.source).toBe('crm_history');
    expect(num(second.realized_pnl)).toBe(12);
    expect(ms(second.reading_since)).toBe(ms(at(DAY, '16:40')));
  });

  it('the replaced transition itself pinned nothing: one more audit row, from the finalize', async () => {
    /* Had persist's `replaced` on the prior batch fired a comparison, it would
     * have run with no finished batch for the import (the new one was still
     * processing) and left a row with basis scheduled and no batch id. So the
     * count is exact and every row names a batch and the captured basis. */
    const rows = await comparisons(world.imports.A);
    expect(rows).toHaveLength(8);
    expect(rows.at(-1).after_data).toMatchObject({ closeBatchId: world.batches.A2, accountsPinned: 7, accountsInClose: 5, accountsReadAfterClose: 0 });
    // The first finalize, then the six direct calls above, all against batch A1.
    expect(rows.filter((row) => row.after_data.closeBatchId === world.batches.A1)).toHaveLength(7);
    expect(rows.filter((row) => row.after_data.closeBatchId === world.batches.A2)).toHaveLength(1);
    expect(rows.every((row) => row.after_data.closeTimeBasis === 'captured' && row.after_data.closeBatchId)).toBe(true);
  });
});

describe('what fires nothing', () => {
  it('a claim (processing) and a failed finalize write no reading and no comparison', async () => {
    const capture = randomUUID();
    const token = randomUUID();
    const rowCounts = { accounts: 0, strategies: 0, orders: 0, executions: 0 };
    const claimed = (await db.query(
      `select public.claim_ingest_batch_v4($1, $2, $3::date, $4::timestamptz, 1, $5, $6, 10, $7::jsonb, $8, 120) as r`,
      [world.devices.C, capture, DAY, at(DAY, '16:31'), `${world.clients.C}/${DAY}/${capture}.json.gz`,
        'b'.repeat(64), JSON.stringify(rowCounts), token])).rows[0].r;
    expect(claimed.outcome).toBe('owned');
    const notices = [];
    const failed = await db.query(
      `select status from public.finalize_ingest_batch_v3($1, $2, $3, $4, 'failed', null, $5::timestamptz, false,
         'capture_failed', '{}'::jsonb, $6::jsonb, 'ingest_batch_failed', '{}'::jsonb, 1)`,
      [claimed.batch.id, world.devices.C, world.clients.C, token, at(DAY, '16:31'), JSON.stringify(rowCounts)],
      { onNotice: (notice) => notices.push(notice.message) });
    expect(failed.rows[0].status).toBe('failed');
    expect(notices).toEqual([]);
    expect(await one(db, 'select count(*)::int from public.tracker_close_readings where client_id = $1', [world.clients.C])).toBe(0);
    expect(await one(db, `select count(*)::int from public.audit_logs
      where entity_type = 'daily_import' and action = 'tracker_close_compared'
        and after_data ->> 'clientId' = $1`, [world.clients.C])).toBe(0);
  });

  it('a late capture for a day already closed (claim, then finalize late_closed_day with the import, never persisting) pins nothing', async () => {
    /* The route's shape when the day was closed before the capture arrived: the
     * batch is claimed and finalized with the existing import's id, and no
     * persist runs in between. The transition names an import, so a trigger
     * that forgot to ask the status would pin here. */
    const importId = await one(db,
      'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [world.clients.C, PRIOR]);
    const capture = randomUUID();
    const token = randomUUID();
    const rowCounts = { accounts: 1, strategies: 0, orders: 0, executions: 0 };
    const claimed = (await db.query(
      `select public.claim_ingest_batch_v4($1, $2, $3::date, $4::timestamptz, 1, $5, $6, 10, $7::jsonb, $8, 120) as r`,
      [world.devices.C, capture, PRIOR, at(PRIOR, '16:31'), `${world.clients.C}/${PRIOR}/${capture}.json.gz`,
        'c'.repeat(64), JSON.stringify(rowCounts), token])).rows[0].r;
    expect(claimed.outcome).toBe('owned');
    const notices = [];
    const finalized = await db.query(
      `select status, daily_import_id from public.finalize_ingest_batch_v3($1, $2, $3, $4, 'late_closed_day', $5, $6::timestamptz, true,
         null, '{}'::jsonb, $7::jsonb, 'ingest_batch_late_closed_day', '{}'::jsonb, 1)`,
      [claimed.batch.id, world.devices.C, world.clients.C, token, importId, at(PRIOR, '16:31'), JSON.stringify(rowCounts)],
      { onNotice: (notice) => notices.push(notice.message) });
    expect(finalized.rows[0]).toMatchObject({ status: 'late_closed_day', daily_import_id: importId });
    expect(notices).toEqual([]);
    expect(await one(db, 'select count(*)::int from public.tracker_close_readings where daily_import_id = $1', [importId])).toBe(0);
    expect(await comparisons(importId)).toEqual([]);
  });

  it('a hand UPDATE that sets processed again on a processed batch does not compare again', async () => {
    const before = await comparisons(world.imports.A);
    await db.query("update public.ingest_batches set status = 'processed' where id = $1", [world.batches.A2]);
    expect(await comparisons(world.imports.A)).toHaveLength(before.length);
  });
});

describe('a comparison fault never fails the finalize', () => {
  it('the batch is processed, a WARNING names the import and the fault, no partial rows are left', async () => {
    let closed;
    try {
      await db.exec('begin');
      await db.exec('alter table public.tracker_close_readings add constraint step66_test_boom check (false) not valid');
      closed = await closeDay({
        client: world.clients.C,
        device: world.devices.C,
        capturedAt: at(DAY, '16:31'),
        snapshots: [snapshot('ACC 21', 2)],
      });
      expect(closed.status).toBe('processed');
      expect(await one(db, 'select status from public.ingest_batches where id = $1', [closed.batchId])).toBe('processed');
      expect(await one(db, 'select count(*)::int from public.tracker_close_readings where daily_import_id = $1', [closed.importId])).toBe(0);
      expect(await comparisons(closed.importId)).toEqual([]);
    } finally {
      await db.exec('rollback');
    }
    const warnings = closed.notices.filter((n) => n.startsWith('WARNING: step 66: tracker close comparison skipped'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(closed.importId);
    expect(warnings[0]).toContain('step66_test_boom');
    expect(warnings[0]).not.toMatch(/[—–]/);
  });
});

describe('a close finalized as incomplete pins the tracker side the same way', () => {
  /* daily.js and ingest-reprocess.js both finalize a partial capture as
   * 'incomplete', with a daily import, and the trigger names both transitions.
   * Client C is the fixture: its history is written above and nothing has
   * pinned it yet (the failed finalize carried no import, the fault was rolled
   * back), so the import is new and its one audit row is exact. */
  beforeAll(async () => {
    await sample(world.devices.C, at(DAY, '16:20'), [account({ accountName: 'ACC 25', realizedPnl: 42, totalPnl: 42 })]);
    world.incompleteClose = await closeDay({
      client: world.clients.C,
      device: world.devices.C,
      capturedAt: at(DAY, '16:31'),
      snapshots: [snapshot('ACC 25', 42)],
      status: 'incomplete',
    });
    world.imports.C = world.incompleteClose.importId;
  }, 60_000);

  it('the finalize answered incomplete, the batch holds it, and nothing was raised', async () => {
    expect(world.incompleteClose.status).toBe('incomplete');
    expect(world.incompleteClose.notices).toEqual([]);
    expect(await one(db, 'select status from public.ingest_batches where id = $1', [world.incompleteClose.batchId])).toBe('incomplete');
  });

  it('the 16:20 reading is pinned with basis captured and the batch id, and one audit row names the batch', async () => {
    const row = await reading(world.imports.C, 'ACC 25');
    expect(row).toMatchObject({
      source: 'crm_history', connected: true, close_time_basis: 'captured', close_batch_id: world.incompleteClose.batchId,
    });
    expect(num(row.realized_pnl)).toBe(42);
    expect(ms(row.sampled_at)).toBe(ms(at(DAY, '16:20')));
    expect(ms(row.close_captured_at)).toBe(ms(at(DAY, '16:31')));
    const rows = await readings(world.imports.C);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((each) => each.close_batch_id === world.incompleteClose.batchId && each.close_time_basis === 'captured')).toBe(true);
    const audit = await comparisons(world.imports.C);
    expect(audit).toHaveLength(1);
    expect(audit[0].after_data).toMatchObject({
      closeBatchId: world.incompleteClose.batchId, closeTimeBasis: 'captured', accountsInClose: 1,
    });
  });
});

/* ── A cold backend ─────────────────────────────────────────────────────── */

describe('a cold backend: a step 66 table is gone before its trigger function ever ran', () => {
  /* plpgsql resolves a declared rowtype when it COMPILES a function, which is
   * the first call of each backend and happens outside the function's own
   * exception block. Every new PostgREST or Supavisor connection is such a
   * backend. The shared cluster above is warm, its functions ran during the
   * fixture, so a fault of that kind is invisible to it: these two ask a cluster
   * whose trigger functions have never run, with the table dropped first. */
  async function coldWorld() {
    const cold = await startMigrationCluster(migrationFilesInOrder());
    const client = await one(cold, "insert into public.clients (name) values ('Client D') returning id");
    const device = await one(cold, 'insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
    return { cold, client, device };
  }

  it('the history table dropped before the first sample: the RPC records, one WARNING names the device and 42P01', async () => {
    const { cold, device } = await coldWorld();
    try {
      await cold.exec('drop table public.account_live_sample_history');
      const notices = [];
      const reply = (await cold.query(
        'select public.record_account_live_sample($1, $2::timestamptz, $3::jsonb) as r',
        [device, at(DAY, '10:00'), JSON.stringify([account({ realizedPnl: 1, totalPnl: 1 })])],
        { onNotice: (notice) => notices.push(`${notice.severity}: ${notice.message}`) })).rows[0].r;
      expect(reply).toMatchObject({ recorded: 1, throttled: false });
      expect(await one(cold,
        "select count(*)::int from public.account_live_samples where device_id = $1 and account_name = 'ACC 01'", [device])).toBe(1);
      const warnings = notices.filter((n) => n.startsWith('WARNING: step 66: account_live_sample_history_record skipped'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(device);
      expect(warnings[0]).toContain('42P01');
      expect(warnings[0]).not.toMatch(/[—–]/);
    } finally {
      await cold.close();
    }
  }, 120_000);

  it('the readings table dropped before the first close: the finalize is processed, one WARNING names the import and 42P01', async () => {
    const { cold, client, device } = await coldWorld();
    try {
      await cold.exec('drop table public.tracker_close_readings');
      const closed = await closeDay({ conn: cold, client, device, capturedAt: at(DAY, '16:31'), snapshots: [snapshot('ACC 01', 1)] });
      expect(closed.status).toBe('processed');
      expect(await one(cold, 'select status from public.ingest_batches where id = $1', [closed.batchId])).toBe('processed');
      const warnings = closed.notices.filter((n) => n.startsWith('WARNING: step 66: tracker close comparison skipped'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(closed.importId);
      expect(warnings[0]).toContain('42P01');
    } finally {
      await cold.close();
    }
  }, 120_000);
});

/* ── Privileges ──────────────────────────────────────────────────────────── */

describe('who holds what', () => {
  for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
    it(`${table}: authenticated holds exactly SELECT, anon holds nothing, service_role keeps its birth grants`, async () => {
      expect(await privilegesOn(db, 'authenticated', table)).toEqual(['SELECT']);
      expect(await privilegesOn(db, 'anon', table)).toEqual([]);
      expect(await one(db, `
        select coalesce(string_agg(distinct entry.privilege_type, ',' order by entry.privilege_type), '<none>')
          from pg_catalog.pg_class as rel, aclexplode(rel.relacl) as entry
         where rel.relname = $1 and rel.relnamespace = 'public'::regnamespace
           and entry.grantee = 'authenticated'::regrole`, [table])).toBe('SELECT');
      expect(await privilegesOn(db, 'service_role', table)).toHaveLength(8);
    });

    it(`${table}: a signed-in Manager is refused every write, TRUNCATE included`, async () => {
      const first = table === 'tracker_close_readings' ? 'compared_at' : 'recorded_at';
      for (const statement of [
        `insert into public.${table} default values`,
        `update public.${table} set ${first} = now() where false`,
        `delete from public.${table} where false`,
        `truncate table public.${table}`,
      ]) {
        expect(await refusalAsRole(db, 'authenticated', statement, { subject: world.managerAuth }), statement)
          .toMatch(DENIED);
      }
      expect(await refusalAsRole(db, 'anon', `select * from public.${table}`)).toMatch(DENIED);
    });
  }

  it('record_tracker_close_readings is executable by the service role and nobody else, besides the owner', async () => {
    const grantees = await executeGrantees('public.record_tracker_close_readings(uuid)');
    expect(grantees.filter((role) => role !== 'postgres')).toEqual(['service_role']);
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select public.record_tracker_close_readings($1)',
        { params: [world.imports.A], subject: world.managerAuth })).toMatch(/permission denied for function record_tracker_close_readings/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select public.record_tracker_close_readings($1)', { params: [world.imports.A] })).toBeNull();
  });

  it('the two trigger functions are not callable by either browser role', async () => {
    for (const signature of ['public.account_live_sample_history_record()', 'public.tracker_close_on_batch()']) {
      const grantees = await executeGrantees(signature);
      expect(grantees).not.toContain('anon');
      expect(grantees).not.toContain('authenticated');
      expect(grantees).not.toContain('public');
    }
  });

  it('calls step 52 helpers wrapped in a sub-select, never bare', () => {
    // The order guard names both helpers inside to_regprocedure('...') string
    // literals, which are not calls; everything else must be wrapped.
    const sql = readFileSync(new URL(`./${STEP}`, import.meta.url), 'utf8')
      .split('\n').filter((line) => !line.trimStart().startsWith('--')).join(' ').toLowerCase().replace(/\s+/g, ' ')
      .replace(/to_regprocedure\('[^']*'\)/g, '');
    for (const helper of ['is_manager', 'assigned_client_ids']) {
      const all = sql.match(new RegExp(`public\\.${helper}\\(\\)`, 'g')) || [];
      const wrapped = sql.match(new RegExp(`\\(select public\\.${helper}\\(\\)\\)`, 'g')) || [];
      expect(all.length, `${helper} is not called at all`).toBeGreaterThan(0);
      expect(wrapped.length, `${helper} is called bare somewhere`).toBe(all.length);
    }
  });
});

describe('the lockdown is the file\'s own, not borrowed from step 56', () => {
  it('applied with step 56 left out, both tables still hold exactly SELECT for authenticated', async () => {
    const early = await startMigrationCluster(
      migrationFilesInOrder({ upTo: 57 }).filter((name) => !name.startsWith('step_56_')).concat([STEP]));
    try {
      for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
        expect(await privilegesOn(early, 'authenticated', table), table).toEqual(['SELECT']);
        expect(await privilegesOn(early, 'anon', table), table).toEqual([]);
      }
      expect(await refusalAsRole(early, 'anon', 'select public.record_tracker_close_readings(gen_random_uuid())')).toMatch(DENIED);
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
    for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
      expect(await privilegesOn(rerun, 'authenticated', table)).toEqual(['SELECT']);
      expect(await privilegesOn(rerun, 'anon', table)).toEqual([]);
    }
  });

  it('step 56 names both tables in its exception table, so its loop grants SELECT alone', async () => {
    const step56 = readFileSync(new URL('./step_56_table_privilege_lockdown.sql', import.meta.url), 'utf8');
    expect(step56).toMatch(/^\s*\('account_live_sample_history',\s*'select',/m);
    expect(step56).toMatch(/^\s*\('tracker_close_readings',\s*'select',/m);
    const notices = await applyFileCollectingNotices(rerun, 'step_56_table_privilege_lockdown.sql');
    expect(notices.filter((n) => /not in public|did not produce what the exception table says/.test(n))).toEqual([]);
    expect(notices.filter((n) => /took the catalogue default/.test(n))).toEqual([]);
  });

  it('and the restrictive denials hold even with the write privileges handed back', async () => {
    const client = await one(rerun, "insert into public.clients (name) values ('Own') returning id");
    const profile = await one(rerun, "insert into public.cam_profiles (name) values ('Own CAM') returning id");
    await rerun.query('insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [client, profile]);
    const auth = await one(rerun, "insert into auth.users (email) values ('own@example.com') returning id");
    await rerun.query(`insert into public.app_users (username, display_name, role, status, auth_user_id, cam_profile_id)
      values ('own', 'Own', 'CAM', 'Active', $1, $2)`, [auth, profile]);
    const device = await one(rerun, 'insert into public.ingest_devices (client_id) values ($1) returning id', [client]);
    const importId = await one(rerun,
      'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [client, DAY]);
    await rerun.query(`insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
      values ($1, $2, 'A', true, 'running', now(), now())`, [device, client]);
    await rerun.query(`insert into public.tracker_close_readings
      (daily_import_id, client_id, trading_date, account_name, source, close_captured_at, close_time_basis, grace_seconds, stale_seconds)
      values ($1, $2, $3, 'A', 'none', now(), 'scheduled', 120, 1500)`, [importId, client, DAY]);

    async function asOwnCamWithVerbs(table, sqlText) {
      try {
        await rerun.exec('begin');
        await rerun.exec(`grant insert, update, delete on public.${table} to authenticated`);
        await rerun.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', auth]);
        await rerun.exec('set local role authenticated');
        const result = await rerun.query(sqlText);
        return { rows: result.rows, error: null };
      } catch (error) {
        return { rows: [], error: String(error.message || error) };
      } finally {
        await rerun.exec('rollback');
      }
    }
    for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
      const policies = await rerun.query('select permissive, cmd from pg_policies where tablename = $1', [table]);
      expect(policies.rows.some((row) => row.permissive === 'PERMISSIVE' && row.cmd === 'ALL'), table).toBe(true);
      expect((await asOwnCamWithVerbs(table, `update public.${table} set account_name = 'B' returning 1`)).rows).toEqual([]);
      expect((await asOwnCamWithVerbs(table, `delete from public.${table} returning 1`)).rows).toEqual([]);
      expect(await one(rerun, `select count(*)::int from public.${table}`)).toBe(1);
    }
    expect((await asOwnCamWithVerbs('account_live_sample_history', `insert into public.account_live_sample_history
      (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
      values ('${device}', '${client}', 'B', true, 'running', now(), now())`)).error).toMatch(/row-level security/);
  });
});

/* ── Row level security ─────────────────────────────────────────────────── */

describe('who reads which rows', () => {
  it('a CAM sees its own clients\' pinned readings and history, and no others', async () => {
    const pinned = await rowsAsRole(db, 'authenticated',
      'select distinct client_id from public.tracker_close_readings', { subject: world.gray.auth });
    expect(pinned.map((row) => row.client_id)).toEqual([world.clients.A]);
    const history = await rowsAsRole(db, 'authenticated',
      'select distinct client_id from public.account_live_sample_history', { subject: world.gray.auth });
    expect(history.map((row) => row.client_id)).toEqual([world.clients.A]);
    const birch = await rowsAsRole(db, 'authenticated',
      'select distinct client_id from public.tracker_close_readings', { subject: world.birch.auth });
    expect(birch.map((row) => row.client_id)).toEqual([world.clients.B]);
  });

  it('a Manager sees every client', async () => {
    const pinned = await rowsAsRole(db, 'authenticated',
      'select distinct client_id from public.tracker_close_readings order by 1', { subject: world.managerAuth });
    // A and B from the closes above, C from the one finalized as incomplete.
    expect(pinned.map((row) => row.client_id).sort()).toEqual([world.clients.A, world.clients.B, world.clients.C].sort());
    const history = await rowsAsRole(db, 'authenticated',
      'select distinct client_id from public.account_live_sample_history', { subject: world.managerAuth });
    expect(history).toHaveLength(3);
  });

  it('a stranger with a session and no profile reads nothing', async () => {
    const stranger = await one(db, "insert into auth.users (email) values ('stranger@example.com') returning id");
    expect(await rowsAsRole(db, 'authenticated', 'select 1 from public.tracker_close_readings', { subject: stranger })).toEqual([]);
    expect(await rowsAsRole(db, 'authenticated', 'select 1 from public.account_live_sample_history', { subject: stranger })).toEqual([]);
  });

  it('on a database that ran each file once, a CAM sees its own client and not another CAM\'s, in both tables', async () => {
    /* The cluster above applies the directory twice, and the second pass of step
     * 52 replaces every permissive policy on a client_id table with its own
     * predicate. That heals a broken policy in this file, so a database that ran
     * 66 once, which is the one Pedro will have, is asked separately. */
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
        const importId = await one(once,
          'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [client, DAY]);
        await once.query(`insert into public.account_live_sample_history
          (device_id, client_id, account_name, connected, run_state, first_sampled_at, last_sampled_at)
          values ($1, $2, 'A', true, 'running', now(), now())`, [device, client]);
        await once.query(`insert into public.tracker_close_readings
          (daily_import_id, client_id, trading_date, account_name, source, close_captured_at, close_time_basis, grace_seconds, stale_seconds)
          values ($1, $2, $3, 'A', 'none', now(), 'scheduled', 120, 1500)`, [importId, client, DAY]);
      }
      for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
        const rows = await rowsAsRole(once, 'authenticated', `select client_id from public.${table}`, { subject: auth });
        expect(rows.map((row) => row.client_id), table).toEqual([mine]);
        expect(await one(once, `select count(*)::int from public.${table}`)).toBe(2);
      }
    } finally {
      await once.close();
    }
  }, 120_000);

  it('anyone signed in reads the new tunables through step 55\'s settings policy', async () => {
    const rows = await rowsAsRole(db, 'authenticated',
      'select pre_close_grace_seconds, close_match_tolerance_dollars from public.account_tracker_settings',
      { subject: world.gray.auth });
    expect(rows).toHaveLength(1);
    expect(num(rows[0].pre_close_grace_seconds)).toBe(120);
  });
});

/* ── Running it again ───────────────────────────────────────────────────── */

describe('running it again', () => {
  it('is a no-op: no notice, same definitions, same grants, rows and hand edits intact', async () => {
    await db.exec('update public.account_tracker_settings set close_match_tolerance_dollars = 12.5 where id');
    const definitions = {};
    for (const signature of ['public.record_tracker_close_readings(uuid)', 'public.account_live_sample_history_record()', 'public.tracker_close_on_batch()']) {
      definitions[signature] = await functionDefinition(signature);
    }
    const rowsBefore = await readings(world.imports.A);
    const historyBefore = await one(db, 'select count(*)::int from public.account_live_sample_history');

    /* THE DRIFT, INSTALLED ON PURPOSE, step 63's way. PostgreSQL keeps a
     * function's ACL across CREATE OR REPLACE and a table's across every
     * `if not exists`, and this harness's default privileges hand a new
     * function EXECUTE for service_role at birth, so a file that forgot its
     * grants would pass every grant assertion above by inheritance. The ACLs
     * are first put where a stray SQL editor session could leave them, and the
     * re-run has to put them back. */
    await db.exec(`
      revoke execute on function public.record_tracker_close_readings(uuid) from service_role;
      grant execute on function public.record_tracker_close_readings(uuid) to anon, authenticated;
      grant execute on function public.account_live_sample_history_record() to anon;
      grant execute on function public.tracker_close_on_batch() to authenticated;
      grant insert, update, delete, truncate on public.tracker_close_readings to authenticated;
      grant select on public.account_live_sample_history to anon;`);
    expect((await executeGrantees('public.record_tracker_close_readings(uuid)'))).not.toContain('service_role');

    const notices = await applyFileCollectingNotices(db, STEP);
    // `if not exists` says "already exists, skipping" for each table, column and
    // index, which is the re-run working. Nothing else may be said: no WARNING
    // from either trigger, no self-check disagreeing.
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.filter((notice) => !/already exists, skipping$/.test(notice))).toEqual([]);
    for (const [signature, definition] of Object.entries(definitions)) {
      expect(await functionDefinition(signature), signature).toBe(definition);
    }
    expect((await executeGrantees('public.record_tracker_close_readings(uuid)')).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    for (const signature of ['public.account_live_sample_history_record()', 'public.tracker_close_on_batch()']) {
      const grantees = await executeGrantees(signature);
      expect(grantees, signature).not.toContain('anon');
      expect(grantees, signature).not.toContain('authenticated');
    }
    for (const table of ['account_live_sample_history', 'tracker_close_readings']) {
      expect(await privilegesOn(db, 'authenticated', table), table).toEqual(['SELECT']);
      expect(await privilegesOn(db, 'anon', table), table).toEqual([]);
    }
    expect(await readings(world.imports.A)).toEqual(rowsBefore);
    expect(await one(db, 'select count(*)::int from public.account_live_sample_history')).toBe(historyBefore);
    expect(num((await settings()).close_match_tolerance_dollars)).toBe(12.5);
    expect(await one(db, `select count(*)::int from pg_trigger where tgname in ('account_live_sample_history_record', 'tracker_close_on_batch') and not tgisinternal`)).toBe(2);
    await resetSettings();
  });

  it('and the triggers still fire after the re-run', async () => {
    await sample(world.devices.C, at(DAY, '12:00'), [account({ accountName: 'ACC 22', realizedPnl: 9, totalPnl: 9 })]);
    expect(await historyRuns(world.devices.C, 'ACC 22')).toHaveLength(2);
    const before = (await comparisons(world.imports.B)).length;
    await one(db, 'select public.record_tracker_close_readings($1)', [world.imports.B]);
    expect(await comparisons(world.imports.B)).toHaveLength(before + 1);
  });
});
