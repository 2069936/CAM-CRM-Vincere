/* STEP 70, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 69, a client, a Manager and
 * devices in every state the three functions have to tell apart are seeded,
 * and then 70 runs the way Pedro runs it. After that every verdict is the
 * database's own: what request_agent_update, cancel_agent_update and
 * record_agent_update_poll return AS THE SERVICE ROLE the routes run as, what
 * they leave on the device rows and in audit_logs, what anon and
 * authenticated are told at the door, and what the CHECK constraints refuse.
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
  refusalAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const STEP = 'step_70_agent_update_requests.sql';
const REQUEST = 'public.request_agent_update(uuid[], text, uuid)';
const CANCEL = 'public.cancel_agent_update(uuid[], uuid)';
const POLL = 'public.record_agent_update_poll(uuid, text, text, text, text)';
const REQUEST_CALL = 'select public.request_agent_update($1::uuid[], $2::text, $3::uuid) as count';
const CANCEL_CALL = 'select public.cancel_agent_update($1::uuid[], $2::uuid) as count';
const POLL_CALL = 'select * from public.record_agent_update_poll($1::uuid, $2::text, $3::text, $4::text, $5::text)';
const INVALID = /INVALID_AGENT_UPDATE_REQUEST/;
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

async function request(ids, target, actor = world.manager) {
  return (await asService(REQUEST_CALL, [ids, target, actor]))[0].count;
}

async function cancel(ids, actor = world.manager) {
  return (await asService(CANCEL_CALL, [ids, actor]))[0].count;
}

async function poll(deviceId, { agentVersion = '1.3.0', state = null, errorCode = null, targetVersion = null } = {}) {
  return (await asService(POLL_CALL, [deviceId, agentVersion, state, errorCode, targetVersion]))[0];
}

async function refusedAsService(statement, params) {
  return refusalAsRole(db, 'service_role', statement, { params });
}

async function device(id) {
  return (await db.query(
    `select agent_version, update_target_version, update_requested_at, update_requested_by,
            update_state, update_state_at, update_error_code
       from public.ingest_devices where id = $1`, [id])).rows[0];
}

async function auditRows(id) {
  return (await db.query(
    `select user_id, action, after_data from public.audit_logs
      where entity_type = 'ingest_device' and entity_id = $1
        and action like 'ingest_device.update_%'
      order by created_at, action`, [id])).rows;
}

async function seedDevice({ agentVersion = '1.2.2', status = 'active', revoked = false } = {}) {
  return one(db, `insert into public.ingest_devices (client_id, agent_version, status, revoked_at)
    values ($1, $2, $3, case when $4 then now() end) returning id`,
  [world.client, agentVersion, status, revoked]);
}

/** Puts a device back to "nothing requested", so each test starts from a known row. */
async function reset(id, agentVersion = '1.2.2') {
  await db.query(`update public.ingest_devices
    set agent_version = $2, update_target_version = null, update_requested_at = null, update_requested_by = null,
        update_state = null, update_state_at = null, update_error_code = null
    where id = $1`, [id, agentVersion]);
}

async function executeGrantees(signature) {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${signature}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 69 }));

  world.client = await one(db, "insert into public.clients (name) values ('Gray Elm') returning id");
  const managerAuth = await one(db, "insert into auth.users (email) values ('mgr@example.com') returning id");
  world.manager = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [managerAuth]);

  world.before = {
    columns: await column(db, `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'ingest_devices' and column_name like 'update\\_%' order by 1`),
    functions: await column(db, `select to_regprocedure(x) is null from unnest(array['${REQUEST}', '${CANCEL}', '${POLL}']) as x`),
  };

  world.notices = await applyFileCollectingNotices(db, STEP);

  world.old = await seedDevice({ agentVersion: '1.2.2' });
  world.nine = await seedDevice({ agentVersion: '1.9.0' });
  world.ten = await seedDevice({ agentVersion: '1.10.0' });
  world.current = await seedDevice({ agentVersion: '1.3.1' });
  world.newer = await seedDevice({ agentVersion: '1.4.0' });
  world.unknown = await seedDevice({ agentVersion: null });
  world.twoPart = await seedDevice({ agentVersion: '1.3' });
  world.fourPart = await seedDevice({ agentVersion: '1.3.0.9' });
  world.revoked = await seedDevice({ agentVersion: '1.2.2', status: 'revoked', revoked: true });
  world.revokedAtOnly = await seedDevice({ agentVersion: '1.2.2', revoked: true });
  world.revokedStatusOnly = await seedDevice({ agentVersion: '1.2.2', status: 'revoked' });
  // Its own device, so the poll's audit rows are the only ones on it.
  world.poller = await seedDevice({ agentVersion: '1.2.2' });
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 28, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 27 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 70 needs step 28 \(ingest_devices\.status, revoked_at, agent_version; audit_logs\): run it first/);
      expect(await one(early, `select to_regprocedure('${REQUEST}') is null`)).toBe(true);
      expect(await one(early, `select count(*)::int from information_schema.columns
        where table_name = 'ingest_devices' and column_name like 'update\\_%'`)).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);
});

describe('before 70', () => {
  it('there were no update columns and none of the three functions', () => {
    expect(world.before).toEqual({ columns: [], functions: [true, true, true] });
  });

  it('after it, the six columns exist, all nullable', async () => {
    expect((await db.query(`select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'ingest_devices' and column_name like 'update\\_%' order by 1`)).rows)
      .toEqual([
        { column_name: 'update_error_code', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'update_requested_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { column_name: 'update_requested_by', data_type: 'uuid', is_nullable: 'YES' },
        { column_name: 'update_state', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'update_state_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { column_name: 'update_target_version', data_type: 'text', is_nullable: 'YES' },
      ]);
  });
});

/* ── request_agent_update ────────────────────────────────────────────────── */

describe('request_agent_update', () => {
  it('sets the request on an outdated active device, returns 1 and writes one audit row with the actor', async () => {
    expect(await request([world.old], '1.3.1')).toBe(1);
    const row = await device(world.old);
    expect(row).toMatchObject({
      update_target_version: '1.3.1', update_requested_by: world.manager,
      update_state: 'requested', update_error_code: null,
    });
    expect(row.update_requested_at).toBeInstanceOf(Date);
    expect(row.update_state_at).toEqual(row.update_requested_at);
    expect(await auditRows(world.old)).toEqual([{
      user_id: world.manager,
      action: 'ingest_device.update_requested',
      after_data: { clientId: world.client, deviceId: world.old, agentVersion: '1.2.2', targetVersion: '1.3.1' },
    }]);
  });

  it('compares versions as numbers: 1.9.0 is below 1.10.0, and 1.10.0 is not below 1.9.0', async () => {
    expect(await request([world.nine], '1.10.0')).toBe(1);
    expect((await device(world.nine)).update_target_version).toBe('1.10.0');
    expect(await request([world.ten], '1.9.0')).toBe(0);
    expect(await device(world.ten)).toMatchObject({ update_target_version: null, update_state: null });
    expect(await auditRows(world.ten)).toEqual([]);
  });

  it('skips a device already at or above the target', async () => {
    expect(await request([world.current, world.newer], '1.3.1')).toBe(0);
    for (const id of [world.current, world.newer]) {
      expect(await device(id)).toMatchObject({ update_target_version: null, update_state: null, update_requested_at: null });
      expect(await auditRows(id)).toEqual([]);
    }
  });

  it('reads 1.3 as 1.3.0 and 1.3.0.9 as above 1.3.0, the way the route compares', async () => {
    expect(await request([world.twoPart], '1.3.0')).toBe(0);
    expect(await request([world.fourPart], '1.3.0')).toBe(0);
    expect(await request([world.twoPart], '1.3.1')).toBe(1);
    expect(await request([world.fourPart], '1.3.1')).toBe(1);
    await reset(world.twoPart, '1.3');
    await reset(world.fourPart, '1.3.0.9');
  });

  it('treats an unknown agent version as eligible', async () => {
    expect(await request([world.unknown], '1.3.1')).toBe(1);
    expect((await device(world.unknown)).update_target_version).toBe('1.3.1');
    await reset(world.unknown, null);
  });

  it('touches only active devices that are not revoked', async () => {
    // status is 'active' or 'revoked' (step 28's CHECK), so "not active" is a
    // revoked status, with or without revoked_at; and revoked_at alone counts.
    expect(await request([world.revoked, world.revokedStatusOnly, world.revokedAtOnly], '1.3.1')).toBe(0);
    for (const id of [world.revoked, world.revokedStatusOnly, world.revokedAtOnly]) {
      expect(await device(id)).toMatchObject({ update_target_version: null, update_state: null });
      expect(await auditRows(id)).toEqual([]);
    }
  });

  it('counts only what it set across a mixed list, and a duplicate id once', async () => {
    await reset(world.old);
    await reset(world.nine, '1.9.0');
    const before = await one(db, "select count(*)::int from public.audit_logs where action = 'ingest_device.update_requested'");
    expect(await request([world.old, world.old, world.nine, world.current, world.revoked,
      '00000000-0000-4000-8000-000000000000'], '1.3.1')).toBe(1);
    // world.nine (1.9.0) is above 1.3.1; world.old is the one.
    expect(await one(db, "select count(*)::int from public.audit_logs where action = 'ingest_device.update_requested'")).toBe(before + 1);
  });

  it('requesting again replaces the target and starts the state over', async () => {
    await asService(POLL_CALL, [world.old, '1.2.2', 'failed', 'download_failed', '1.3.1']);
    expect(await device(world.old)).toMatchObject({ update_state: 'failed', update_error_code: 'download_failed' });
    expect(await request([world.old], '1.3.2')).toBe(1);
    expect(await device(world.old)).toMatchObject({ update_target_version: '1.3.2', update_state: 'requested', update_error_code: null });
    await reset(world.old);
  });

  it.each([
    ['a null list', null, '1.3.1', 'manager'],
    ['an empty list', [], '1.3.1', 'manager'],
    ['a null element', [null], '1.3.1', 'manager'],
    ['301 ids', Array.from({ length: 301 }, () => '00000000-0000-4000-8000-000000000000'), '1.3.1', 'manager'],
    ['a null target', ['device'], null, 'manager'],
    ['a two part target', ['device'], '1.3', 'manager'],
    ['a four part target', ['device'], '1.3.1.0', 'manager'],
    ['a word for a target', ['device'], 'latest', 'manager'],
    ['a target with a trailing newline', ['device'], '1.3.1\n', 'manager'],
    ['a six digit part', ['device'], '1.3.100000', 'manager'],
    ['a null actor', ['device'], '1.3.1', null],
  ])('refuses %s with INVALID_AGENT_UPDATE_REQUEST and writes nothing', async (_label, ids, target, actor) => {
    const list = ids === null ? null : ids.map((id) => (id === 'device' ? world.old : id));
    expect(await refusedAsService(REQUEST_CALL, [list, target, actor === 'manager' ? world.manager : actor])).toMatch(INVALID);
    expect(await device(world.old)).toMatchObject({ update_target_version: null, update_state: null });
  });

  it('300 ids is the most it takes', async () => {
    const ids = [world.old, ...Array.from({ length: 299 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)];
    expect(await request(ids, '1.3.1')).toBe(1);
    await reset(world.old);
  });
});

/* ── record_agent_update_poll ────────────────────────────────────────────── */

describe('record_agent_update_poll', () => {
  it('with nothing pending: returns nulls and writes nothing, whatever the agent reports', async () => {
    const before = await device(world.poller);
    expect(await poll(world.poller, { agentVersion: '1.2.2' })).toEqual({ target_version: null, requested_at: null });
    expect(await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'download_failed', targetVersion: '1.3.1' }))
      .toEqual({ target_version: null, requested_at: null });
    expect(await device(world.poller)).toEqual(before);
    expect(await auditRows(world.poller)).toEqual([]);
  });

  it('with a request pending: returns the target and when it was requested', async () => {
    await request([world.poller], '1.3.1');
    const { update_requested_at: requestedAt } = await device(world.poller);
    expect(await poll(world.poller, { agentVersion: '1.2.2' })).toEqual({ target_version: '1.3.1', requested_at: requestedAt });
    expect((await device(world.poller)).update_state).toBe('requested');
  });

  it('records a state for the pending target, moving state_at only when the state changes', async () => {
    const requested = await device(world.poller);
    await poll(world.poller, { agentVersion: '1.2.2', state: 'downloading', targetVersion: '1.3.1' });
    const downloading = await device(world.poller);
    expect(downloading).toMatchObject({ update_state: 'downloading', update_error_code: null, update_target_version: '1.3.1' });
    expect(downloading.update_state_at.getTime()).toBeGreaterThan(requested.update_state_at.getTime());
    await poll(world.poller, { agentVersion: '1.2.2', state: 'downloading', targetVersion: '1.3.1' });
    expect((await device(world.poller)).update_state_at).toEqual(downloading.update_state_at);
    await poll(world.poller, { agentVersion: '1.2.2', state: 'staged', targetVersion: '1.3.1' });
    expect((await device(world.poller)).update_state).toBe('staged');
    await poll(world.poller, { agentVersion: '1.2.2', state: 'applying', targetVersion: '1.3.1' });
    expect((await device(world.poller)).update_state).toBe('applying');
  });

  it('ignores a state for any other target, and a poll that reports no state', async () => {
    const before = await device(world.poller);
    await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'download_failed', targetVersion: '1.3.0' });
    await poll(world.poller, { agentVersion: '1.2.2', state: 'downloading', targetVersion: null });
    await poll(world.poller, { agentVersion: '1.2.2' });
    expect(await device(world.poller)).toEqual(before);
    expect((await auditRows(world.poller)).map((row) => row.action)).toEqual(['ingest_device.update_requested']);
  });

  it('writes the failed audit row once, on the way into failed, and again only after leaving it', async () => {
    await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'download_failed', targetVersion: '1.3.1' });
    await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'download_failed', targetVersion: '1.3.1' });
    await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'hash_mismatch', targetVersion: '1.3.1' });
    expect(await device(world.poller)).toMatchObject({ update_state: 'failed', update_error_code: 'hash_mismatch', update_target_version: '1.3.1' });
    let failed = (await auditRows(world.poller)).filter((row) => row.action === 'ingest_device.update_failed');
    expect(failed).toEqual([{
      user_id: null,
      action: 'ingest_device.update_failed',
      after_data: { clientId: world.client, deviceId: world.poller, agentVersion: '1.2.2', targetVersion: '1.3.1', errorCode: 'download_failed' },
    }]);
    await poll(world.poller, { agentVersion: '1.2.2', state: 'downloading', targetVersion: '1.3.1' });
    expect(await device(world.poller)).toMatchObject({ update_state: 'downloading', update_error_code: null });
    await poll(world.poller, { agentVersion: '1.2.2', state: 'failed', errorCode: 'install_failed', targetVersion: '1.3.1' });
    failed = (await auditRows(world.poller)).filter((row) => row.action === 'ingest_device.update_failed');
    expect(failed.map((row) => row.after_data.errorCode)).toEqual(['download_failed', 'install_failed']);
  });

  it('completes the request when the agent reports the target or above: clears it, says completed, audits once', async () => {
    const before = await device(world.poller);
    expect(await poll(world.poller, { agentVersion: '1.3.1' })).toEqual({ target_version: null, requested_at: null });
    const after = await device(world.poller);
    expect(after).toMatchObject({
      update_target_version: null, update_state: 'completed', update_error_code: null,
      update_requested_at: before.update_requested_at, update_requested_by: world.manager,
    });
    expect(after.update_state_at.getTime()).toBeGreaterThan(before.update_state_at.getTime());
    const completed = (await auditRows(world.poller)).filter((row) => row.action === 'ingest_device.update_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      user_id: null,
      after_data: { clientId: world.client, deviceId: world.poller, agentVersion: '1.3.1', targetVersion: '1.3.1', requestedBy: world.manager },
    });
    // A second poll at the new version finds nothing pending and writes nothing.
    expect(await poll(world.poller, { agentVersion: '1.3.1' })).toEqual({ target_version: null, requested_at: null });
    expect(await device(world.poller)).toEqual(after);
    expect((await auditRows(world.poller)).filter((row) => row.action === 'ingest_device.update_completed')).toHaveLength(1);
    await reset(world.poller);
  });

  it('completes on a version above the target too, numerically (1.10.0 is above 1.9.0)', async () => {
    await reset(world.nine, '1.8.0');
    expect(await request([world.nine], '1.9.0')).toBe(1);
    expect(await poll(world.nine, { agentVersion: '1.10.0' })).toEqual({ target_version: null, requested_at: null });
    expect((await device(world.nine)).update_state).toBe('completed');
    await reset(world.nine, '1.9.0');
  });

  it('does not complete on a version below the target, numerically (1.9.0 is below 1.10.0)', async () => {
    expect(await request([world.nine], '1.10.0')).toBe(1);
    expect((await poll(world.nine, { agentVersion: '1.9.0' })).target_version).toBe('1.10.0');
    expect((await device(world.nine)).update_state).toBe('requested');
    expect(await poll(world.nine, { agentVersion: '1.9.0', state: 'failed', errorCode: 'install_failed', targetVersion: '1.10.0' }))
      .toMatchObject({ target_version: '1.10.0' });
    // A state reported with the version that completes it is not stored: the
    // completion wins, and the failure is not audited.
    expect(await poll(world.nine, { agentVersion: '1.10.0', state: 'failed', errorCode: 'install_failed', targetVersion: '1.10.0' }))
      .toEqual({ target_version: null, requested_at: null });
    expect(await device(world.nine)).toMatchObject({ update_state: 'completed', update_error_code: null });
    await reset(world.nine, '1.9.0');
  });

  it('refuses a device that is missing, revoked or not active', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', world.revoked, world.revokedAtOnly, world.revokedStatusOnly]) {
      expect(await refusedAsService(POLL_CALL, [id, '1.2.2', null, null, null])).toMatch(/INVALID_INGEST_DEVICE/);
    }
  });

  it.each([
    ['a null device', { device: null }],
    ['a null agent version', { agentVersion: null }],
    ['an agent version that is a word', { agentVersion: 'latest' }],
    ['a one part agent version', { agentVersion: '1' }],
    ['a five part agent version', { agentVersion: '1.2.3.4.5' }],
    ['an unknown state', { state: 'requested' }],
    ['a completed state from the agent', { state: 'completed' }],
    ['failed without a code', { state: 'failed', errorCode: null, targetVersion: '1.3.1' }],
    ['a code without failed', { state: 'downloading', errorCode: 'download_failed', targetVersion: '1.3.1' }],
    ['a code with no state', { state: null, errorCode: 'download_failed' }],
    ['a code in capitals', { state: 'failed', errorCode: 'Download_failed', targetVersion: '1.3.1' }],
    ['a code starting with a digit', { state: 'failed', errorCode: '1_failed', targetVersion: '1.3.1' }],
    ['a code of 65 characters', { state: 'failed', errorCode: `a${'b'.repeat(64)}`, targetVersion: '1.3.1' }],
    ['a two part target', { state: 'downloading', targetVersion: '1.3' }],
    ['a word for a target', { state: 'downloading', targetVersion: 'next' }],
  ])('refuses %s with INVALID_AGENT_UPDATE_REQUEST', async (_label, over) => {
    const input = { device: world.poller, agentVersion: '1.2.2', state: null, errorCode: null, targetVersion: null, ...over };
    expect(await refusedAsService(POLL_CALL, [input.device, input.agentVersion, input.state, input.errorCode, input.targetVersion]))
      .toMatch(INVALID);
  });

  it('a code of 64 characters is accepted', async () => {
    expect(await refusedAsService(POLL_CALL, [world.poller, '1.2.2', 'failed', `a${'b'.repeat(63)}`, '1.3.1'])).toBeNull();
  });
});

/* ── cancel_agent_update ─────────────────────────────────────────────────── */

describe('cancel_agent_update', () => {
  it('clears a pending request, says cancelled, audits it with what was cancelled, and returns the count', async () => {
    await reset(world.old);
    await request([world.old], '1.3.1');
    await poll(world.old, { agentVersion: '1.2.2', state: 'failed', errorCode: 'download_failed', targetVersion: '1.3.1' });
    const before = await device(world.old);
    expect(await cancel([world.old, world.current])).toBe(1);
    const after = await device(world.old);
    expect(after).toMatchObject({
      update_target_version: null, update_state: 'cancelled', update_error_code: null,
      update_requested_at: before.update_requested_at, update_requested_by: world.manager,
    });
    expect(after.update_state_at.getTime()).toBeGreaterThan(before.update_state_at.getTime());
    expect((await auditRows(world.old)).filter((row) => row.action === 'ingest_device.update_cancelled')).toEqual([{
      user_id: world.manager,
      action: 'ingest_device.update_cancelled',
      after_data: { clientId: world.client, deviceId: world.old, targetVersion: '1.3.1', previousState: 'failed' },
    }]);
  });

  it('leaves a device with nothing pending alone, and counts 0', async () => {
    const before = await device(world.current);
    expect(await cancel([world.current, world.old])).toBe(0);
    expect(await device(world.current)).toEqual(before);
    expect((await auditRows(world.old)).filter((row) => row.action === 'ingest_device.update_cancelled')).toHaveLength(1);
  });

  it('after a cancel the poll returns nothing and gives no state a place to land', async () => {
    expect(await poll(world.old, { agentVersion: '1.2.2', state: 'downloading', targetVersion: '1.3.1' }))
      .toEqual({ target_version: null, requested_at: null });
    expect((await device(world.old)).update_state).toBe('cancelled');
  });

  it.each([
    ['a null list', null, 'manager'],
    ['an empty list', [], 'manager'],
    ['a null element', [null], 'manager'],
    ['301 ids', Array.from({ length: 301 }, () => '00000000-0000-4000-8000-000000000000'), 'manager'],
    ['a null actor', ['00000000-0000-4000-8000-000000000000'], null],
  ])('refuses %s with INVALID_AGENT_UPDATE_REQUEST', async (_label, ids, actor) => {
    expect(await refusedAsService(CANCEL_CALL, [ids, actor === 'manager' ? world.manager : actor])).toMatch(INVALID);
  });
});

/* ── The constraints ─────────────────────────────────────────────────────── */

describe('the CHECK constraints refuse what no function writes', () => {
  it.each([
    ['update_target_version', '1.3', /ingest_devices_update_target_version_check/],
    ['update_target_version', 'v1.3.1', /ingest_devices_update_target_version_check/],
    ['update_target_version', '1.3.1.0', /ingest_devices_update_target_version_check/],
    ['update_state', 'pending', /ingest_devices_update_state_check/],
    ['update_state', 'Requested', /ingest_devices_update_state_check/],
    ['update_error_code', 'Bad', /ingest_devices_update_error_code_check/],
    ['update_error_code', '', /ingest_devices_update_error_code_check/],
    ['update_error_code', `a${'b'.repeat(64)}`, /ingest_devices_update_error_code_check/],
  ])('%s = %j', async (columnName, value, message) => {
    await expect(db.query(`update public.ingest_devices set ${columnName} = $2 where id = $1`, [world.old, value]))
      .rejects.toThrow(message);
  });

  it.each([
    ['update_target_version', '10.20.30'],
    ['update_state', 'requested'], ['update_state', 'downloading'], ['update_state', 'staged'],
    ['update_state', 'applying'], ['update_state', 'failed'], ['update_state', 'completed'], ['update_state', 'cancelled'],
    ['update_error_code', 'a'], ['update_error_code', 'hash_mismatch_2'],
  ])('%s = %j is accepted, and so is NULL', async (columnName, value) => {
    await db.query('begin');
    try {
      await db.query(`update public.ingest_devices set ${columnName} = $2 where id = $1`, [world.old, value]);
      await db.query(`update public.ingest_devices set ${columnName} = null where id = $1`, [world.old]);
    } finally {
      await db.query('rollback');
    }
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: the service role, and nobody else', () => {
  it.each([[REQUEST], [CANCEL], [POLL]])('%s: the ACL names service_role and nobody else besides the owner', async (signature) => {
    expect((await executeGrantees(signature)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('anon and authenticated are refused at the door, signed in or not, and nothing changes', async () => {
    const before = await device(world.old);
    const calls = [
      [REQUEST_CALL, [[world.old], '1.3.1', world.manager], /permission denied for function request_agent_update/],
      [CANCEL_CALL, [[world.old], world.manager], /permission denied for function cancel_agent_update/],
      [POLL_CALL, [world.old, '1.2.2', null, null, null], /permission denied for function record_agent_update_poll/],
    ];
    for (const [statement, params, denied] of calls) {
      expect(await refusalAsRole(db, 'anon', statement, { params })).toMatch(denied);
      expect(await refusalAsRole(db, 'authenticated', statement, { params })).toMatch(denied);
      expect(await refusalAsRole(db, 'authenticated', statement, { params, subject: '11111111-1111-4111-8111-111111111111' })).toMatch(denied);
    }
    expect(await device(world.old)).toEqual(before);
  });

  it('the service role executes all three', async () => {
    expect(await refusalAsRole(db, 'service_role', REQUEST_CALL, { params: [[world.old], '1.3.1', world.manager] })).toBeNull();
    expect(await refusalAsRole(db, 'service_role', CANCEL_CALL, { params: [[world.old], world.manager] })).toBeNull();
    expect(await refusalAsRole(db, 'service_role', POLL_CALL, { params: [world.old, '1.2.2', null, null, null] })).toBeNull();
  });

  it('each is security definer with search_path pinned to pg_catalog, public, and returns what the routes read', async () => {
    const rows = (await db.query(`select oid::regprocedure::text as signature, prosecdef, proconfig,
        pg_get_function_result(oid) as returns
      from pg_proc where oid in ('${REQUEST}'::regprocedure, '${CANCEL}'::regprocedure, '${POLL}'::regprocedure)
      order by 1`)).rows;
    expect(rows).toEqual([
      { signature: 'cancel_agent_update(uuid[],uuid)', prosecdef: true, proconfig: ['search_path=pg_catalog, public'], returns: 'integer' },
      { signature: 'record_agent_update_poll(uuid,text,text,text,text)', prosecdef: true, proconfig: ['search_path=pg_catalog, public'], returns: 'TABLE(target_version text, requested_at timestamp with time zone)' },
      { signature: 'request_agent_update(uuid[],text,uuid)', prosecdef: true, proconfig: ['search_path=pg_catalog, public'], returns: 'integer' },
    ]);
  });

  it('ingest_devices itself stays closed to anon and authenticated, new columns included', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select update_target_version from public.ingest_devices limit 1'), role)
        .toMatch(/permission denied for table ingest_devices/);
    }
  });
});

/* ── Running it again ─────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('changes no row, only says it skipped the six columns, and puts drifted grants back', async () => {
    await reset(world.old);
    await request([world.old], '1.3.1');
    for (const signature of [REQUEST, CANCEL, POLL]) {
      await db.exec(`grant execute on function ${signature} to anon, authenticated, public;
                     revoke execute on function ${signature} from service_role;`);
    }
    const rows = (await db.query('select * from public.ingest_devices order by id')).rows;
    const audits = await one(db, 'select count(*)::int from public.audit_logs');

    const notices = await applyFileCollectingNotices(db, STEP);

    expect(notices).toHaveLength(6);
    for (const notice of notices) expect(notice).toMatch(/column "update_[a-z_]+" of relation "ingest_devices" already exists, skipping/);
    expect((await db.query('select * from public.ingest_devices order by id')).rows).toEqual(rows);
    expect(await one(db, 'select count(*)::int from public.audit_logs')).toBe(audits);
    for (const signature of [REQUEST, CANCEL, POLL]) {
      expect((await executeGrantees(signature)).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    }
    expect(await refusalAsRole(db, 'authenticated', POLL_CALL, { params: [world.old, '1.2.2', null, null, null] }))
      .toMatch(/permission denied for function record_agent_update_poll/);
    expect((await poll(world.old, { agentVersion: '1.2.2' })).target_version).toBe('1.3.1');
  });

  it('a first run said only that the three constraints were not there to drop', () => {
    expect(world.notices).toEqual([
      'constraint "ingest_devices_update_target_version_check" of relation "ingest_devices" does not exist, skipping',
      'constraint "ingest_devices_update_state_check" of relation "ingest_devices" does not exist, skipping',
      'constraint "ingest_devices_update_error_code_check" of relation "ingest_devices" does not exist, skipping',
    ]);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 70 is here once, after the steps it builds on', () => {
  it('appears once, 71 now carries the highest-number claim, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 70)).toHaveLength(1);
    // Step 71's test now holds "the highest number"; this one only says 70 is
    // here once, after the steps it builds on.
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(70);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 69, in the run order after 69, and names its three functions', () => {
    expect(runbook).toMatch(/^\| 70 \| `step_70_agent_update_requests\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 70 | `step_70_agent_update_requests.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 69 | `step_69_ingest_batch_error_detail.sql`'));
    expect(runbook).toMatch(/→ 66 → 67 → 68 → 69 → 70(?: →|\.)/);
    for (const name of ['request_agent_update', 'cancel_agent_update', 'record_agent_update_poll']) expect(runbook).toContain(name);
  });
});
