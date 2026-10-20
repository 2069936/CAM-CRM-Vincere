/* STEP 72, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 71, a client, a Manager and
 * devices in the states the functions have to tell apart are seeded, and then
 * 72 runs the way Pedro runs it. After that every verdict is the database's
 * own: what the six functions return AS THE SERVICE ROLE the routes run as,
 * what they leave on the rows and in audit_logs, what anon and authenticated
 * are told at the door, what the CHECK constraints refuse, and what the
 * bucket and its policy let the browser see.
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
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const STEP = 'step_72_trading_exports.sql';
const REQUEST = 'public.request_trading_exports(uuid[], date, date, text[], uuid)';
const CANCEL = 'public.cancel_trading_exports(uuid[], uuid)';
const CLAIM = 'public.claim_trading_export(uuid, text)';
const BEGIN = 'public.begin_trading_export_upload(uuid, uuid, text, bigint)';
const COMPLETE = 'public.complete_trading_export(uuid, uuid, text, text, bigint, jsonb, date, date, text)';
const CLOSE = 'public.close_trading_exports(uuid[], uuid, text)';
const DEVICE_CHECK = 'public.trading_export_active_device(uuid)';
const FUNCTIONS = [REQUEST, CANCEL, CLAIM, BEGIN, COMPLETE, CLOSE, DEVICE_CHECK];

const REQUEST_CALL = 'select public.request_trading_exports($1::uuid[], $2::date, $3::date, $4::text[], $5::uuid) as count';
const CANCEL_CALL = 'select * from public.cancel_trading_exports($1::uuid[], $2::uuid)';
const CLAIM_CALL = 'select * from public.claim_trading_export($1::uuid, $2::text)';
const BEGIN_CALL = 'select public.begin_trading_export_upload($1::uuid, $2::uuid, $3::text, $4::bigint) as path';
const COMPLETE_CALL = 'select public.complete_trading_export($1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::jsonb, $7::date, $8::date, $9::text) as status';
const CLOSE_CALL = 'select * from public.close_trading_exports($1::uuid[], $2::uuid, $3::text)';

const ALL = ['executions', 'orders', 'strategies', 'trades'];
const SHA = 'a'.repeat(64);
const COUNTS = { executions: 2140, orders: 900, strategies: 12, trades: 610 };
const INVALID = /INVALID_TRADING_EXPORT_REQUEST/;
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

let db;
const world = {};

/** Runs one statement as the service role and KEEPS its effect, as the routes' calls do. */
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

async function refusedAsService(statement, params) {
  return refusalAsRole(db, 'service_role', statement, { params });
}

async function request(ids, { from = null, to = null, datasets = ALL, actor = world.manager } = {}) {
  return (await asService(REQUEST_CALL, [ids, from, to, datasets, actor]))[0].count;
}

async function claim(deviceId, agentVersion = '1.4.0') {
  return (await asService(CLAIM_CALL, [deviceId, agentVersion]))[0] || null;
}

async function beginUpload(deviceId, requestId, { sha = SHA, size = 831488 } = {}) {
  return (await asService(BEGIN_CALL, [deviceId, requestId, sha, size]))[0].path;
}

async function complete(deviceId, requestId, {
  status = 'ready', sha = SHA, size = 831488, counts = COUNTS, from = '2026-07-01', to = '2026-10-19', code = null,
} = {}) {
  return (await asService(COMPLETE_CALL, [deviceId, requestId, status, sha, size, counts === null ? null : JSON.stringify(counts), from, to, code]))[0].status;
}

async function fail(deviceId, requestId, code = 'disk_full') {
  return complete(deviceId, requestId, { status: 'failed', sha: null, size: null, counts: null, from: null, to: null, code });
}

async function rowsOf(deviceId) {
  return (await db.query(
    'select * from public.trading_export_requests where device_id = $1 order by requested_at, id', [deviceId])).rows;
}

async function row(id) {
  return (await db.query('select * from public.trading_export_requests where id = $1', [id])).rows[0];
}

async function auditRows(id) {
  return (await db.query(
    `select user_id, action, after_data from public.audit_logs
      where entity_type = 'trading_export' and entity_id = $1
      order by created_at, action`, [id])).rows;
}

async function seedDevice({ agentVersion = '1.4.0', status = 'active', revoked = false, client = world.client } = {}) {
  return one(db, `insert into public.ingest_devices (client_id, agent_version, status, revoked_at)
    values ($1, $2, $3, case when $4 then now() end) returning id`,
  [client, agentVersion, status, revoked]);
}

/** A request, straight in, for the tests that need a row in a given state. */
async function seedRequest(deviceId, fields = {}) {
  const columns = { device_id: deviceId, client_id: world.client, requested_by: world.manager, ...fields };
  const names = Object.keys(columns);
  return one(db, `insert into public.trading_export_requests (${names.join(', ')})
    values (${names.map((_, index) => `$${index + 1}`).join(', ')}) returning id`, Object.values(columns));
}

async function executeGrantees(signature) {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 71 }));

  world.client = await one(db, "insert into public.clients (name) values ('Gray Elm') returning id");
  world.otherClient = await one(db, "insert into public.clients (name) values ('Blue Oak') returning id");
  const managerAuth = await one(db, "insert into auth.users (email) values ('mgr@example.com') returning id");
  world.manager = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [managerAuth]);

  world.before = {
    table: await one(db, "select to_regclass('public.trading_export_requests') is null"),
    bucket: await one(db, "select count(*)::int from storage.buckets where id = 'trading-exports'"),
    functions: await column(db, `select to_regprocedure(x) is null from unnest(array['${FUNCTIONS.join("','")}']) as x`),
  };

  world.notices = await applyFileCollectingNotices(db, STEP);

  world.fresh = await seedDevice();
  world.second = await seedDevice();
  world.ten = await seedDevice({ agentVersion: '1.10.0' });
  world.revoked = await seedDevice({ status: 'revoked', revoked: true });
  world.revokedAtOnly = await seedDevice({ revoked: true });
  world.revokedStatusOnly = await seedDevice({ status: 'revoked' });
  world.poller = await seedDevice();
  world.stranger = await seedDevice({ client: world.otherClient });
  world.uploader = await seedDevice();
  world.closer = await seedDevice();
  world.checks = await seedDevice();
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 28, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 27 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 72 needs step 28 \(ingest_devices\.status, revoked_at, agent_version, client_id; audit_logs; storage\.buckets\): run it first/);
      expect(await one(early, "select to_regclass('public.trading_export_requests') is null")).toBe(true);
      expect(await one(early, `select to_regprocedure('${REQUEST}') is null`)).toBe(true);
      expect(await one(early, "select count(*)::int from storage.buckets where id = 'trading-exports'")).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);
});

describe('before 72, and after it', () => {
  it('there was no table, no bucket and none of the seven functions', () => {
    expect(world.before).toEqual({ table: true, bucket: 0, functions: FUNCTIONS.map(() => true) });
  });

  it('after it, the table has the columns the contract names, with these types and nullability', async () => {
    const rows = (await db.query(`select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'trading_export_requests' order by ordinal_position`)).rows;
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['device_id', 'uuid', 'NO'],
      ['client_id', 'uuid', 'NO'],
      ['requested_by', 'uuid', 'YES'],
      ['requested_at', 'timestamp with time zone', 'NO'],
      ['from_date', 'date', 'YES'],
      ['to_date', 'date', 'YES'],
      ['datasets', 'ARRAY', 'NO'],
      ['status', 'text', 'NO'],
      ['error_code', 'text', 'YES'],
      ['storage_path', 'text', 'YES'],
      ['byte_size', 'bigint', 'YES'],
      ['sha256', 'text', 'YES'],
      ['row_counts', 'jsonb', 'YES'],
      ['covered_from', 'date', 'YES'],
      ['covered_to', 'date', 'YES'],
      ['started_at', 'timestamp with time zone', 'YES'],
      ['completed_at', 'timestamp with time zone', 'YES'],
      ['expires_at', 'timestamp with time zone', 'YES'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });

  it('has the indexes for the device and its status, the client, the newest first list and the expiry sweep', async () => {
    const indexes = await column(db, `select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'trading_export_requests' order by 1`);
    expect(indexes).toEqual([
      'trading_export_requests_client',
      'trading_export_requests_device_status',
      'trading_export_requests_expiry',
      'trading_export_requests_newest',
      'trading_export_requests_one_open',
      'trading_export_requests_pkey',
    ]);
  });

  it('the bucket is private, holds at most 25 MiB per object, and only application/gzip', async () => {
    expect((await db.query("select id, name, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'trading-exports'")).rows)
      .toEqual([{ id: 'trading-exports', name: 'trading-exports', public: false, file_size_limit: 26214400, allowed_mime_types: ['application/gzip'] }]);
  });
});

/* ── request_trading_exports ─────────────────────────────────────────────── */

describe('request_trading_exports', () => {
  it('creates one requested row for an active device, with the actor, and one audit row', async () => {
    expect(await request([world.fresh], { from: '2026-07-01', to: '2026-10-19', datasets: ['trades', 'executions'] })).toBe(1);
    const [created] = await rowsOf(world.fresh);
    expect(created).toMatchObject({
      client_id: world.client, requested_by: world.manager, status: 'requested',
      datasets: ['executions', 'trades'], error_code: null, storage_path: null, started_at: null,
    });
    expect(created.from_date).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(created.to_date).toEqual(new Date('2026-10-19T00:00:00.000Z'));
    expect(await auditRows(created.id)).toEqual([{
      user_id: world.manager,
      action: 'trading_export.requested',
      after_data: { clientId: world.client, deviceId: world.fresh, from: '2026-07-01', to: '2026-10-19', datasets: ['executions', 'trades'] },
    }]);
  });

  it('does not ask a device twice while its export is open, and counts only what it created', async () => {
    expect(await request([world.fresh, world.second])).toBe(1);
    expect(await rowsOf(world.fresh)).toHaveLength(1);
    expect((await rowsOf(world.second)).map((r) => r.datasets)).toEqual([ALL]);
  });

  it('touches only active devices that are not revoked, and counts a duplicate id once', async () => {
    expect(await request([world.revoked, world.revokedAtOnly, world.revokedStatusOnly, world.ten, world.ten,
      '00000000-0000-4000-8000-000000000000'])).toBe(1);
    for (const id of [world.revoked, world.revokedAtOnly, world.revokedStatusOnly]) expect(await rowsOf(id)).toEqual([]);
    expect(await rowsOf(world.ten)).toHaveLength(1);
  });

  it.each([
    ['a null list', { ids: null }],
    ['an empty list', { ids: [] }],
    ['a null element', { ids: [null] }],
    ['301 ids', { ids: Array.from({ length: 301 }, () => '00000000-0000-4000-8000-000000000000') }],
    ['a null actor', { actor: null }],
    ['no datasets', { datasets: [] }],
    ['null datasets', { datasets: null }],
    ['an unknown dataset', { datasets: ['fills'] }],
    ['a dataset twice', { datasets: ['orders', 'orders'] }],
    ['a null dataset', { datasets: ['orders', null] }],
    ['from after to', { from: '2026-10-20', to: '2026-10-19' }],
  ])('refuses %s with INVALID_TRADING_EXPORT_REQUEST and writes nothing', async (_label, over) => {
    const input = { ids: [world.checks], actor: world.manager, datasets: ALL, from: null, to: null, ...over };
    expect(await refusedAsService(REQUEST_CALL, [input.ids, input.from, input.to, input.datasets, input.actor])).toMatch(INVALID);
    expect(await rowsOf(world.checks)).toEqual([]);
  });

  it('300 ids is the most it takes, and from equal to to is a range of one day', async () => {
    const ids = [world.checks, ...Array.from({ length: 299 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)];
    expect(await request(ids, { from: '2026-10-19', to: '2026-10-19' })).toBe(1);
    await db.query('delete from public.audit_logs where entity_id in (select id from public.trading_export_requests where device_id = $1)', [world.checks]);
    await db.query('delete from public.trading_export_requests where device_id = $1', [world.checks]);
  });
});

/* ── claim_trading_export ────────────────────────────────────────────────── */

describe('claim_trading_export', () => {
  it('with nothing open: no rows, and nothing written', async () => {
    expect(await claim(world.poller)).toBeNull();
    expect(await rowsOf(world.poller)).toEqual([]);
  });

  it('hands out a requested one as building, with started_at and one audit row; from null stays null with no prior export', async () => {
    await request([world.poller]);
    const [requested] = await rowsOf(world.poller);
    expect(await claim(world.poller, '1.4.2')).toEqual({ request_id: requested.id, export_from: null, export_to: null, export_datasets: ALL });
    const building = await row(requested.id);
    expect(building.status).toBe('building');
    expect(building.started_at).toBeInstanceOf(Date);
    expect(building.updated_at).toEqual(building.started_at);
    expect(await auditRows(requested.id)).toEqual([
      expect.objectContaining({ action: 'trading_export.requested' }),
      { user_id: null, action: 'trading_export.started', after_data: { clientId: world.client, deviceId: world.poller, agentVersion: '1.4.2', from: null, to: null } },
    ]);
    world.pollerRequest = requested.id;
  });

  it('a poll after an agent restart gets the same building request, and writes nothing', async () => {
    const before = await row(world.pollerRequest);
    expect((await claim(world.poller)).request_id).toBe(world.pollerRequest);
    expect(await row(world.pollerRequest)).toEqual(before);
    expect((await auditRows(world.pollerRequest)).filter((r) => r.action === 'trading_export.started')).toHaveLength(1);
  });

  it('does not hand out an uploading one again', async () => {
    await beginUpload(world.poller, world.pollerRequest);
    expect(await claim(world.poller)).toBeNull();
  });

  it('resolves from null to the end of the last export that reached ready, even expired, and keeps an explicit from', async () => {
    expect(await complete(world.poller, world.pollerRequest, { from: '2026-07-01', to: '2026-09-30' })).toBe('ready');
    await request([world.poller]);
    expect((await claim(world.poller)).export_from).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    const second = (await rowsOf(world.poller))[1];
    expect(await fail(world.poller, second.id)).toBe('failed');
    // An expired export still counts: it was delivered.
    await db.query("update public.trading_export_requests set status = 'expired' where id = $1", [world.pollerRequest]);
    await request([world.poller], { from: '2026-01-01' });
    expect((await claim(world.poller)).export_from).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    const third = (await rowsOf(world.poller))[2];
    expect(await fail(world.poller, third.id)).toBe('failed');
    // A failed export is not a delivered one: the end of the expired one still decides.
    await request([world.poller]);
    expect((await claim(world.poller)).export_from).toEqual(new Date('2026-09-30T00:00:00.000Z'));
  });

  it('refuses a device that is missing, revoked or not active', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', world.revoked, world.revokedAtOnly, world.revokedStatusOnly]) {
      expect(await refusedAsService(CLAIM_CALL, [id, '1.4.0'])).toMatch(/INVALID_INGEST_DEVICE/);
    }
  });

  it.each([[null], ['latest'], ['1'], ['1.4.0.0.1']])('refuses the agent version %j', async (version) => {
    expect(await refusedAsService(CLAIM_CALL, [world.poller, version])).toMatch(INVALID);
  });
});

/* ── begin_trading_export_upload and complete_trading_export ─────────────── */

describe('the upload and the completion', () => {
  beforeAll(async () => {
    await request([world.uploader]);
    world.upload = (await claim(world.uploader)).request_id;
  });

  it('refuses another device\'s request exactly like one that does not exist', async () => {
    expect(await refusedAsService(BEGIN_CALL, [world.stranger, world.upload, SHA, 100])).toMatch(/TRADING_EXPORT_NOT_FOUND/);
    expect(await refusedAsService(BEGIN_CALL, [world.uploader, '00000000-0000-4000-8000-000000000000', SHA, 100])).toMatch(/TRADING_EXPORT_NOT_FOUND/);
    expect(await refusedAsService(COMPLETE_CALL, [world.stranger, world.upload, 'failed', null, null, null, null, null, 'x'])).toMatch(/TRADING_EXPORT_NOT_FOUND/);
    expect((await row(world.upload)).status).toBe('building');
  });

  it('refuses a ready report before any upload began', async () => {
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, world.upload, 'ready', SHA, 100, JSON.stringify(COUNTS), null, null, null]))
      .toMatch(/TRADING_EXPORT_CLOSED/);
  });

  it.each([
    ['a size of 0', SHA, 0],
    ['a size above 25 MiB', SHA, 26214401],
    ['a null size', SHA, null],
    ['an upper case digest', 'A'.repeat(64), 100],
    ['a short digest', 'a'.repeat(63), 100],
  ])('the upload refuses %s', async (_label, sha, size) => {
    expect(await refusedAsService(BEGIN_CALL, [world.uploader, world.upload, sha, size])).toMatch(INVALID);
  });

  it('records the digest, the size and the path, and moves to uploading; a retry replaces them', async () => {
    const path = await beginUpload(world.uploader, world.upload, { sha: 'b'.repeat(64), size: 26214400 });
    expect(path).toBe(`deep-exports/${world.client}/${world.upload}.jsonl.gz`);
    expect(await row(world.upload)).toMatchObject({ status: 'uploading', storage_path: path, sha256: 'b'.repeat(64), byte_size: 26214400 });
    await beginUpload(world.uploader, world.upload);
    expect(await row(world.upload)).toMatchObject({ status: 'uploading', sha256: SHA, byte_size: 831488 });
  });

  it('refuses a ready report whose digest or size is not what the upload declared', async () => {
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, world.upload, 'ready', 'c'.repeat(64), 831488, JSON.stringify(COUNTS), null, null, null]))
      .toMatch(/TRADING_EXPORT_MISMATCH/);
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, world.upload, 'ready', SHA, 831487, JSON.stringify(COUNTS), null, null, null]))
      .toMatch(/TRADING_EXPORT_MISMATCH/);
  });

  it.each([
    ['ready without counts', ['ready', SHA, 831488, null, null, null, null]],
    ['ready without a digest', ['ready', null, 831488, COUNTS, null, null, null]],
    ['ready with an error code', ['ready', SHA, 831488, COUNTS, null, null, 'x']],
    ['failed without a code', ['failed', null, null, null, null, null, null]],
    ['a code in capitals', ['failed', null, null, null, null, null, 'Disk_full']],
    ['a code of 65 characters', ['failed', null, null, null, null, null, `a${'b'.repeat(64)}`]],
    ['an unknown status', ['cancelled', null, null, null, null, null, null]],
    ['counts with an extra key', ['ready', SHA, 831488, { ...COUNTS, accounts: 1 }, null, null, null]],
    ['counts missing a key', ['ready', SHA, 831488, { executions: 1, orders: 1, strategies: 1 }, null, null, null]],
    ['a negative count', ['ready', SHA, 831488, { ...COUNTS, trades: -1 }, null, null, null]],
    ['a fractional count', ['ready', SHA, 831488, { ...COUNTS, trades: 1.5 }, null, null, null]],
    ['a count as text', ['ready', SHA, 831488, { ...COUNTS, trades: '1' }, null, null, null]],
    ['covered days backwards', ['ready', SHA, 831488, COUNTS, '2026-10-20', '2026-10-19', null]],
  ])('the completion refuses %s', async (_label, [status, sha, size, counts, from, to, code]) => {
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, world.upload, status, sha, size, counts === null ? null : JSON.stringify(counts), from, to, code]))
      .toMatch(INVALID);
    expect((await row(world.upload)).status).toBe('uploading');
  });

  it('ready: sets the counts, the covered days, completed_at and expires_at 14 days later, and one audit row', async () => {
    expect(await complete(world.uploader, world.upload)).toBe('ready');
    const ready = await row(world.upload);
    expect(ready).toMatchObject({ status: 'ready', row_counts: COUNTS, error_code: null, byte_size: 831488, sha256: SHA });
    expect(ready.covered_from).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(ready.covered_to).toEqual(new Date('2026-10-19T00:00:00.000Z'));
    expect(ready.expires_at.getTime() - ready.completed_at.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect((await auditRows(world.upload)).filter((r) => r.action === 'trading_export.ready')).toEqual([{
      user_id: null,
      action: 'trading_export.ready',
      after_data: {
        clientId: world.client, deviceId: world.uploader, byteSize: 831488, sha256: SHA,
        rowCounts: COUNTS, coveredFrom: '2026-07-01', coveredTo: '2026-10-19',
      },
    }]);
    world.readyRow = ready;
  });

  it('the same ready report again changes nothing and answers ready', async () => {
    expect(await complete(world.uploader, world.upload)).toBe('ready');
    expect(await row(world.upload)).toEqual(world.readyRow);
    expect((await auditRows(world.upload)).filter((r) => r.action === 'trading_export.ready')).toHaveLength(1);
  });

  it('a ready export cannot be failed, uploaded again, or claimed', async () => {
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, world.upload, 'failed', null, null, null, null, null, 'late']))
      .toMatch(/TRADING_EXPORT_CLOSED/);
    expect(await refusedAsService(BEGIN_CALL, [world.uploader, world.upload, SHA, 100])).toMatch(/TRADING_EXPORT_CLOSED/);
    expect(await claim(world.uploader)).toBeNull();
  });

  it('failed: from building, records the code and completed_at, one audit row, and the same report again is a no-op', async () => {
    await request([world.uploader]);
    const failing = (await claim(world.uploader)).request_id;
    expect(await fail(world.uploader, failing, 'database_locked')).toBe('failed');
    const failed = await row(failing);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'database_locked', storage_path: null });
    expect(failed.completed_at).toBeInstanceOf(Date);
    expect(await fail(world.uploader, failing, 'database_locked')).toBe('failed');
    expect(await row(failing)).toEqual(failed);
    expect((await auditRows(failing)).filter((r) => r.action === 'trading_export.failed')).toEqual([{
      user_id: null,
      action: 'trading_export.failed',
      after_data: { clientId: world.client, deviceId: world.uploader, previousStatus: 'building', errorCode: 'database_locked' },
    }]);
    expect(await refusedAsService(COMPLETE_CALL, [world.uploader, failing, 'failed', null, null, null, null, null, 'other_code']))
      .toMatch(/TRADING_EXPORT_CLOSED/);
  });

  it('refuses a device that is missing, revoked or not active, before looking at the request', async () => {
    for (const id of [world.revoked, world.revokedAtOnly]) {
      expect(await refusedAsService(BEGIN_CALL, [id, world.upload, SHA, 100])).toMatch(/INVALID_INGEST_DEVICE/);
      expect(await refusedAsService(COMPLETE_CALL, [id, world.upload, 'failed', null, null, null, null, null, 'x'])).toMatch(/INVALID_INGEST_DEVICE/);
    }
  });
});

/* ── cancel_trading_exports and close_trading_exports ────────────────────── */

describe('cancel and close', () => {
  it('cancels open requests, returns the path an upload reached, leaves a ready one alone, and audits each', async () => {
    await request([world.closer]);
    const uploading = (await claim(world.closer)).request_id;
    await beginUpload(world.closer, uploading);
    const [secondOpen] = await rowsOf(world.second);
    expect(secondOpen.status).toBe('requested');
    const result = await asService(CANCEL_CALL, [[uploading, world.upload, secondOpen.id], world.manager]);
    expect(result).toEqual([
      { request_id: uploading, object_path: `deep-exports/${world.client}/${uploading}.jsonl.gz` },
      { request_id: secondOpen.id, object_path: null },
    ].sort((a, b) => a.request_id.localeCompare(b.request_id)));
    expect((await row(uploading)).status).toBe('cancelled');
    expect((await row(secondOpen.id)).status).toBe('cancelled');
    expect((await row(world.upload)).status).toBe('ready');
    expect((await auditRows(uploading)).filter((r) => r.action === 'trading_export.cancelled')).toEqual([{
      user_id: world.manager,
      action: 'trading_export.cancelled',
      after_data: { clientId: world.client, deviceId: world.closer, previousStatus: 'uploading' },
    }]);
    expect((await auditRows(world.upload)).filter((r) => r.action === 'trading_export.cancelled')).toEqual([]);
    // Cancelling again finds nothing open.
    expect(await asService(CANCEL_CALL, [[uploading], world.manager])).toEqual([]);
    // A cancelled request accepts nothing more from the agent.
    expect(await refusedAsService(COMPLETE_CALL, [world.closer, uploading, 'ready', SHA, 831488, JSON.stringify(COUNTS), null, null, null]))
      .toMatch(/TRADING_EXPORT_CLOSED/);
    expect(await refusedAsService(BEGIN_CALL, [world.closer, uploading, SHA, 100])).toMatch(/TRADING_EXPORT_CLOSED/);
    expect(await claim(world.closer)).toBeNull();
  });

  it('after a cancel the device can be asked again', async () => {
    expect(await request([world.closer])).toBe(1);
    await asService(CANCEL_CALL, [[(await rowsOf(world.closer)).at(-1).id], world.manager]);
  });

  it.each([
    ['a null list', null, 'manager'],
    ['an empty list', [], 'manager'],
    ['a null element', [null], 'manager'],
    ['301 ids', Array.from({ length: 301 }, () => '00000000-0000-4000-8000-000000000000'), 'manager'],
    ['a null actor', ['00000000-0000-4000-8000-000000000000'], null],
  ])('cancel refuses %s', async (_label, ids, actor) => {
    expect(await refusedAsService(CANCEL_CALL, [ids, actor === 'manager' ? world.manager : actor])).toMatch(INVALID);
  });

  it('expired: only a ready export whose expires_at has passed, with no actor, one audit row', async () => {
    expect(await asService(CLOSE_CALL, [[world.upload], null, 'expired'])).toEqual([]);
    expect((await row(world.upload)).status).toBe('ready');
    await db.query("update public.trading_export_requests set expires_at = now() - interval '1 minute' where id = $1", [world.upload]);
    expect(await asService(CLOSE_CALL, [[world.upload], null, 'expired'])).toEqual([{ request_id: world.upload }]);
    expect((await row(world.upload)).status).toBe('expired');
    expect((await auditRows(world.upload)).filter((r) => r.action === 'trading_export.expired')).toEqual([
      expect.objectContaining({ user_id: null, after_data: expect.objectContaining({ clientId: world.client, deviceId: world.uploader, byteSize: 831488 }) }),
    ]);
    // A second pass finds nothing ready.
    expect(await asService(CLOSE_CALL, [[world.upload], null, 'expired'])).toEqual([]);
  });

  it('deleted: a ready export at once, with the actor; never one that is not ready', async () => {
    await request([world.closer]);
    const id = (await claim(world.closer)).request_id;
    await beginUpload(world.closer, id);
    expect(await asService(CLOSE_CALL, [[id], world.manager, 'deleted'])).toEqual([]);
    await complete(world.closer, id);
    expect(await asService(CLOSE_CALL, [[id], world.manager, 'deleted'])).toEqual([{ request_id: id }]);
    expect((await row(id)).status).toBe('expired');
    expect((await auditRows(id)).filter((r) => r.action === 'trading_export.deleted').map((r) => r.user_id)).toEqual([world.manager]);
  });

  it.each([
    ['a deletion without an actor', ['00000000-0000-4000-8000-000000000000'], null, 'deleted'],
    ['an unknown reason', ['00000000-0000-4000-8000-000000000000'], null, 'purged'],
    ['an empty list', [], null, 'expired'],
  ])('close refuses %s', async (_label, ids, actor, reason) => {
    expect(await refusedAsService(CLOSE_CALL, [ids, actor, reason])).toMatch(INVALID);
  });
});

/* ── The constraints ─────────────────────────────────────────────────────── */

describe('the CHECK constraints and the index refuse what no function writes', () => {
  beforeAll(async () => {
    world.checkRow = await seedRequest(world.checks, { status: 'cancelled' });
  });

  it.each([
    ['status', "'pending'", /trading_export_requests_status_check/],
    ['status', "'Ready'", /trading_export_requests_status_check/],
    ['error_code', "'Disk'", /trading_export_requests_error_code_check/],
    ['error_code', "''", /trading_export_requests_error_code_check/],
    ['error_code', "'disk_full'", /trading_export_requests_failed_code_check/],
    ['status', "'failed'", /trading_export_requests_failed_code_check/],
    ['sha256', "'ABC'", /trading_export_requests_sha256_check/],
    ['sha256', `'${'A'.repeat(64)}'`, /trading_export_requests_sha256_check/],
    ['byte_size', '0', /trading_export_requests_byte_size_check/],
    ['byte_size', '26214401', /trading_export_requests_byte_size_check/],
    ['datasets', "'{}'::text[]", /trading_export_requests_datasets_check/],
    ['datasets', "array['fills']", /trading_export_requests_datasets_check/],
    ['datasets', "array['orders', null]", /trading_export_requests_datasets_check/],
    ['datasets', "array['orders','orders','orders','orders','orders']", /trading_export_requests_datasets_check/],
    ['from_date', "'2026-10-20', to_date = '2026-10-19'", /trading_export_requests_dates_check/],
    ['covered_from', "'2026-10-20', covered_to = '2026-10-19'", /trading_export_requests_covered_check/],
    ['storage_path', "'deep-exports/elsewhere.jsonl.gz'", /trading_export_requests_storage_path_check/],
    ['row_counts', '\'{"executions":1,"orders":1,"strategies":1}\'', /trading_export_requests_row_counts_check/],
    ['row_counts', '\'{"executions":1,"orders":1,"strategies":1,"trades":1,"accounts":1}\'', /trading_export_requests_row_counts_check/],
    ['row_counts', '\'{"executions":-1,"orders":1,"strategies":1,"trades":1}\'', /trading_export_requests_row_counts_check/],
    ['row_counts', '\'{"executions":1.5,"orders":1,"strategies":1,"trades":1}\'', /trading_export_requests_row_counts_check/],
    ['row_counts', '\'{"executions":"1","orders":1,"strategies":1,"trades":1}\'', /trading_export_requests_row_counts_check/],
    ['row_counts', "'[]'", /trading_export_requests_row_counts_check/],
    ['status', "'ready'", /trading_export_requests_ready_check/],
  ])('%s = %s', async (columnName, value, message) => {
    await expect(db.query(`update public.trading_export_requests set ${columnName} = ${value} where id = $1`, [world.checkRow]))
      .rejects.toThrow(message);
  });

  it('accepts what the functions write, and NULL where it is allowed', async () => {
    await db.query('begin');
    try {
      await db.query(`update public.trading_export_requests set
          status = 'failed', error_code = 'a', sha256 = $2, byte_size = 26214400, datasets = array['trades'],
          from_date = '2026-10-19', to_date = '2026-10-19', covered_from = null, covered_to = '2026-10-19',
          storage_path = 'deep-exports/' || client_id::text || '/' || id::text || '.jsonl.gz',
          row_counts = '{"executions":0,"orders":0,"strategies":0,"trades":999999999999999}'
        where id = $1`, [world.checkRow, SHA]);
    } finally {
      await db.query('rollback');
    }
  });

  it('holds at most one open request per device', async () => {
    await seedRequest(world.checks, { status: 'requested' });
    await expect(seedRequest(world.checks, { status: 'building' })).rejects.toThrow(/trading_export_requests_one_open/);
    await db.query("update public.trading_export_requests set status = 'cancelled' where device_id = $1", [world.checks]);
  });
});

/* ── Grants, row level security, the bucket ──────────────────────────────── */

describe('grants: the service role, and nobody else', () => {
  it.each(FUNCTIONS.map((signature) => [signature]))('%s: the ACL names service_role and nobody else besides the owner', async (signature) => {
    expect((await executeGrantees(signature)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('anon and authenticated are refused at the door of every function, signed in or not, and nothing changes', async () => {
    const before = (await db.query('select * from public.trading_export_requests order by id')).rows;
    const calls = [
      [REQUEST_CALL, [[world.checks], null, null, ALL, world.manager], /permission denied for function request_trading_exports/],
      [CANCEL_CALL, [[world.checkRow], world.manager], /permission denied for function cancel_trading_exports/],
      [CLAIM_CALL, [world.checks, '1.4.0'], /permission denied for function claim_trading_export/],
      [BEGIN_CALL, [world.checks, world.checkRow, SHA, 1], /permission denied for function begin_trading_export_upload/],
      [COMPLETE_CALL, [world.checks, world.checkRow, 'failed', null, null, null, null, null, 'x'], /permission denied for function complete_trading_export/],
      [CLOSE_CALL, [[world.checkRow], null, 'expired'], /permission denied for function close_trading_exports/],
      ['select public.trading_export_active_device($1::uuid)', [world.checks], /permission denied for function trading_export_active_device/],
    ];
    for (const [statement, params, denied] of calls) {
      expect(await refusalAsRole(db, 'anon', statement, { params })).toMatch(denied);
      expect(await refusalAsRole(db, 'authenticated', statement, { params })).toMatch(denied);
      expect(await refusalAsRole(db, 'authenticated', statement, { params, subject: '11111111-1111-4111-8111-111111111111' })).toMatch(denied);
    }
    expect((await db.query('select * from public.trading_export_requests order by id')).rows).toEqual(before);
  });

  it('each is security definer with search_path pinned to pg_catalog, public', async () => {
    const rows = (await db.query(`select oid::regprocedure::text as signature, prosecdef, proconfig
      from pg_proc where oid in (${FUNCTIONS.map((signature) => `'${signature}'::regprocedure`).join(', ')})
      order by 1`)).rows;
    expect(rows).toHaveLength(7);
    for (const fn of rows) expect(fn, fn.signature).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] });
  });

  it('the table has row level security on and gives anon and authenticated no privilege at all', async () => {
    expect(await one(db, "select relrowsecurity from pg_class where oid = 'public.trading_export_requests'::regclass")).toBe(true);
    expect(await privilegesOn(db, 'anon', 'trading_export_requests')).toEqual([]);
    expect(await privilegesOn(db, 'authenticated', 'trading_export_requests')).toEqual([]);
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select id from public.trading_export_requests limit 1'), role)
        .toMatch(/permission denied for table trading_export_requests/);
      expect(await refusalAsRole(db, role, 'truncate public.trading_export_requests'), role)
        .toMatch(/permission denied for table trading_export_requests/);
    }
    expect(await refusalAsRole(db, 'service_role', 'select id from public.trading_export_requests limit 1')).toBeNull();
  });

  it('a grant made by mistake still reads no row: the restrictive policy denies the browser', async () => {
    await db.exec('begin');
    try {
      await db.exec('grant select on public.trading_export_requests to authenticated');
      await db.exec('create policy "open by mistake" on public.trading_export_requests for select to authenticated using (true)');
      await db.exec('set local role authenticated');
      expect((await db.query('select id from public.trading_export_requests')).rows).toEqual([]);
    } finally {
      await db.exec('rollback');
    }
  });

  it('the bucket\'s objects are invisible to the browser even under a policy that opens every bucket', async () => {
    await db.exec("insert into storage.buckets (id, name, public) values ('elsewhere', 'elsewhere', false) on conflict do nothing");
    await db.query("insert into storage.objects (bucket_id, name) values ('trading-exports', $1), ('elsewhere', 'x.txt')",
      [`deep-exports/${world.client}/${world.checkRow}.jsonl.gz`]);
    await db.exec('create policy "every bucket" on storage.objects for all to anon, authenticated using (true) with check (true)');
    // Supabase grants both roles usage on the storage schema; the harness models
    // only the objects table, so the usage is lent for this test and taken back.
    await db.exec('grant usage on schema storage to anon, authenticated');
    try {
      for (const role of ['anon', 'authenticated']) {
        expect((await rowsAsRole(db, role, 'select bucket_id from storage.objects order by 1')).map((r) => r.bucket_id), role)
          .toEqual(['elsewhere']);
        expect(await refusalAsRole(db, role, "insert into storage.objects (bucket_id, name) values ('trading-exports', 'y.jsonl.gz')"), role)
          .toMatch(/row-level security/);
      }
    } finally {
      await db.exec('drop policy "every bucket" on storage.objects');
      await db.exec('revoke usage on schema storage from anon, authenticated');
    }
  });
});

/* ── Running it again ─────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('changes no row, says it skipped what exists, puts drifted grants back and the bucket back to private', async () => {
    for (const signature of FUNCTIONS) {
      await db.exec(`grant execute on function ${signature} to anon, authenticated, public;
                     revoke execute on function ${signature} from service_role;`);
    }
    await db.exec('grant select on public.trading_export_requests to authenticated');
    await db.exec("update storage.buckets set public = true, file_size_limit = null, allowed_mime_types = null where id = 'trading-exports'");
    const rows = (await db.query('select * from public.trading_export_requests order by id')).rows;
    const audits = await one(db, 'select count(*)::int from public.audit_logs');

    const notices = await applyFileCollectingNotices(db, STEP);

    expect(notices).toEqual([
      'relation "trading_export_requests" already exists, skipping',
      'relation "trading_export_requests_one_open" already exists, skipping',
      'relation "trading_export_requests_device_status" already exists, skipping',
      'relation "trading_export_requests_client" already exists, skipping',
      'relation "trading_export_requests_newest" already exists, skipping',
      'relation "trading_export_requests_expiry" already exists, skipping',
    ]);
    expect((await db.query('select * from public.trading_export_requests order by id')).rows).toEqual(rows);
    expect(await one(db, 'select count(*)::int from public.audit_logs')).toBe(audits);
    for (const signature of FUNCTIONS) {
      expect((await executeGrantees(signature)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    }
    expect(await privilegesOn(db, 'authenticated', 'trading_export_requests')).toEqual([]);
    expect((await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'trading-exports'")).rows)
      .toEqual([{ public: false, file_size_limit: 26214400, allowed_mime_types: ['application/gzip'] }]);
    expect(await one(db, "select count(*)::int from pg_policies where policyname in ('trading_export_requests deny browser direct access', 'trading-exports deny browser direct access')")).toBe(2);
  });

  it('a first run said only that the constraints were not there to drop', () => {
    expect(world.notices).toHaveLength(11);
    for (const notice of world.notices) {
      expect(notice).toMatch(/^constraint "trading_export_requests_[a-z0-9_]+_check" of relation "trading_export_requests" does not exist, skipping$/);
    }
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 72 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 72)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(72);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 71, in the run order after 71, and names its table, bucket and functions', () => {
    expect(runbook).toMatch(/^\| 72 \| `step_72_trading_exports\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 72 | `step_72_trading_exports.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 71 | `step_71_confirmed_failure.sql`'));
    expect(runbook).toMatch(/→ 69 → 70 → 71 → 72(?: →|\.)/);
    const row72 = runbook.split('\n').find((line) => line.startsWith('| 72 |'));
    for (const name of ['trading_export_requests', 'trading-exports', 'request_trading_exports', 'cancel_trading_exports',
      'claim_trading_export', 'begin_trading_export_upload', 'complete_trading_export', 'close_trading_exports',
      'trading_export_active_device']) {
      expect(row72).toContain(name);
    }
  });
});
