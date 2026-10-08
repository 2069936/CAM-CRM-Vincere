/* STEP 63, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 62, three paired machines are
 * seeded in the shapes the desk holds today (one whose NinjaTrader version this
 * database already knows, one that has never reported one, one revoked), the
 * defect is shown to exist BEFORE 63 by calling the RPC the way the route calls
 * it, and then 63 runs the way Pedro runs it. Every verdict afterwards is the
 * RPC's own: what it returned, what the device row holds, what the audit log
 * says, and what each role is allowed to execute.
 *
 * Nothing here asserts the text of the SQL. The sibling test for step 41 is
 * text only, and that is how a function the whole fleet calls could refuse a
 * null for five weeks with a green suite.
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

const STEP = 'step_63_heartbeat_without_ninjatrader_version.sql';
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

const SIGNATURE = 'public.record_ingest_heartbeat(uuid, text, text, text, timestamptz, timestamptz, text, text, bigint, bigint, boolean, text, integer)';

/* The eight codes the route lets through and the RPC must keep accepting. */
const STABLE_CODES = [
  'ninjatrader_not_running',
  'addon_unavailable',
  'capture_timeout',
  'capture_failed',
  'contract_mismatch',
  'queue_capacity_warning',
  'upload_failed',
  'configuration_error',
];

let db;
const world = {};

/** The RPC call exactly as createHeartbeatStore makes it, with the route's defaults. */
function args(deviceId, over = {}) {
  return {
    p_device_id: deviceId,
    p_agent_version: '1.2.0',
    p_addon_version: '1.0.0',
    p_ninjatrader_version: null,
    p_last_capture_at: null,
    p_last_success_at: null,
    p_last_error_code: null,
    p_last_error_message: null,
    p_queue_depth: 0,
    p_queue_bytes: 0,
    p_addon_available: true,
    p_health_status: 'online',
    p_min_interval_seconds: 30,
    ...over,
  };
}

const ORDER = [
  'p_device_id', 'p_agent_version', 'p_addon_version', 'p_ninjatrader_version',
  'p_last_capture_at', 'p_last_success_at', 'p_last_error_code', 'p_last_error_message',
  'p_queue_depth', 'p_queue_bytes', 'p_addon_available', 'p_health_status', 'p_min_interval_seconds',
];
const CASTS = {
  p_device_id: 'uuid', p_agent_version: 'text', p_addon_version: 'text', p_ninjatrader_version: 'text',
  p_last_capture_at: 'timestamptz', p_last_success_at: 'timestamptz', p_last_error_code: 'text',
  p_last_error_message: 'text', p_queue_depth: 'bigint', p_queue_bytes: 'bigint',
  p_addon_available: 'boolean', p_health_status: 'text', p_min_interval_seconds: 'integer',
};
const CALL = `select * from public.record_ingest_heartbeat(${
  ORDER.map((name, index) => `${name} => $${index + 1}::${CASTS[name]}`).join(', ')
})`;

/** Calls the RPC as the service role, which is the only caller it has. Returns the row. */
async function heartbeat(deviceId, over = {}) {
  const params = ORDER.map((name) => args(deviceId, over)[name]);
  try {
    await db.exec('begin');
    await db.exec('set local role service_role');
    const result = await db.query(CALL, params);
    await db.exec('commit');
    return result.rows[0];
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

/** Same call, but the refusal comes back as text (null when it was accepted). */
async function refusal(deviceId, over = {}) {
  const params = ORDER.map((name) => args(deviceId, over)[name]);
  return refusalAsRole(db, 'service_role', CALL, { params });
}

async function device(id) {
  return (await db.query(
    `select ninjatrader_version, agent_version, addon_version, health_status, last_error_code,
            last_seen_at, last_capture_at, last_success_at, metadata
       from public.ingest_devices where id = $1`, [id])).rows[0];
}

async function auditRows(id) {
  return (await db.query(
    `select action, after_data from public.audit_logs
      where entity_type = 'ingest_device' and entity_id = $1 order by created_at, action`, [id])).rows;
}

/** Pushes a device's last_seen_at into the past so the throttle cannot intervene. */
async function ageDevice(id, ago = '2 hours') {
  await db.query(
    `update public.ingest_devices set last_seen_at = clock_timestamp() - $2::interval where id = $1`, [id, ago]);
  return (await device(id)).last_seen_at;
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
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 62 }));

  world.client = await one(db, "insert into public.clients (name) values ('Gray Elm') returning id");
  // A machine this database already knows: it captured under agent 1.1.x and
  // reported 8.1.6.0, then was updated to 1.2.0 today and restarted.
  world.known = await one(db, `insert into public.ingest_devices
      (client_id, health_status, agent_version, addon_version, ninjatrader_version, last_seen_at)
    values ($1, 'online', '1.1.2', '1.0.0', '8.1.6.0', clock_timestamp() - interval '2 hours') returning id`,
  [world.client]);
  // A machine installed fresh with 1.2.0: paired, never captured, nothing known.
  world.fresh = await one(db, `insert into public.ingest_devices
      (client_id, last_seen_at)
    values ($1, clock_timestamp() - interval '2 hours') returning id`, [world.client]);
  // A revoked one, so the device check is proved to be where it was.
  world.revoked = await one(db, `insert into public.ingest_devices
      (client_id, status, revoked_at) values ($1, 'revoked', now()) returning id`, [world.client]);

  // THE DEFECT, BEFORE 63: the very call the route makes for the eight silent
  // machines, refused by the database as a malformed request.
  world.before = {
    knownNull: await refusal(world.known),
    freshNull: await refusal(world.fresh),
    knownRow: await device(world.known),
    definition: await functionDefinition(),
  };

  // THE DRIFT, INSTALLED ON PURPOSE. PostgreSQL keeps a function's ACL across
  // CREATE OR REPLACE, so in a clean replay a file that forgot its grants would
  // pass every grant assertion here by inheriting step 28's. That is the hole
  // step 56's rule exists for, and a test that cannot see it is decoration. So
  // the ACL is first put where a stray SQL editor session could leave it (anon
  // and authenticated granted, service_role revoked), and 63 has to put it back.
  await db.exec(`grant execute on function ${SIGNATURE} to anon, authenticated;
                 revoke execute on function ${SIGNATURE} from service_role;`);
  world.before.grantees = await executeGrantees();

  world.notices = await applyFileCollectingNotices(db, STEP);
  world.after = { definition: await functionDefinition() };
}, 120_000);

afterAll(async () => { await db?.close?.(); });

describe('before step 63, the refusal the route cannot get past', () => {
  it('a known machine restarting with no version yet is refused as malformed', () => {
    expect(world.before.knownNull).toMatch(/INVALID_HEARTBEAT_REQUEST/);
  });

  it('a fresh install is refused the same way, so it can never acquire a version', () => {
    expect(world.before.freshNull).toMatch(/INVALID_HEARTBEAT_REQUEST/);
  });

  it('and neither refusal moved last_seen_at', async () => {
    expect(world.before.knownRow.ninjatrader_version).toBe('8.1.6.0');
    expect(Date.now() - new Date(world.before.knownRow.last_seen_at).getTime()).toBeGreaterThan(60 * 60 * 1000);
  });

  it('the file replaced the function', () => {
    expect(world.after.definition).not.toBe(world.before.definition);
    expect(world.notices).toEqual([]);
  });
});

describe('a machine whose version this database already knows', () => {
  it('a null-version heartbeat is accepted, keeps 8.1.6.0 and moves last_seen_at', async () => {
    const before = await ageDevice(world.known);
    const row = await heartbeat(world.known, { p_ninjatrader_version: null });
    expect(row).toMatchObject({ device_id: world.known, health_status: 'online', throttled: false });
    const after = await device(world.known);
    expect(after.ninjatrader_version).toBe('8.1.6.0');
    expect(after.agent_version).toBe('1.2.0');
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(Date.now() - new Date(after.last_seen_at).getTime()).toBeLessThan(60 * 1000);
  });

  it('a later heartbeat that spells the version writes it (a newer NinjaTrader)', async () => {
    await ageDevice(world.known);
    await heartbeat(world.known, { p_ninjatrader_version: '8.1.7.0' });
    expect((await device(world.known)).ninjatrader_version).toBe('8.1.7.0');
  });

  it('and a null after that keeps the newer one, not the older', async () => {
    await ageDevice(world.known);
    await heartbeat(world.known, { p_ninjatrader_version: null });
    expect((await device(world.known)).ninjatrader_version).toBe('8.1.7.0');
  });

  it('a null-version heartbeat is "unchanged" for the throttle, exactly like one that spells it', async () => {
    await ageDevice(world.known);
    const first = await heartbeat(world.known, { p_ninjatrader_version: '8.1.7.0', p_queue_depth: 3, p_queue_bytes: 300 });
    expect(first.throttled).toBe(false);
    const seen = (await device(world.known)).last_seen_at;
    // Same heartbeat a few seconds later, version omitted: within the interval
    // and nothing changed, so the row is not rewritten.
    const second = await heartbeat(world.known, { p_ninjatrader_version: null, p_queue_depth: 3, p_queue_bytes: 300 });
    expect(second.throttled).toBe(true);
    expect((await device(world.known)).last_seen_at).toEqual(seen);
    // Something else changing still writes, version omitted or not.
    const third = await heartbeat(world.known, { p_ninjatrader_version: null, p_queue_depth: 4, p_queue_bytes: 300 });
    expect(third.throttled).toBe(false);
    expect((await device(world.known)).metadata.queueDepth).toBe(4);
    expect((await device(world.known)).ninjatrader_version).toBe('8.1.7.0');
  });
});

describe('a machine that has never reported a version', () => {
  it('its first heartbeat lands: online, last_seen_at now, column still null', async () => {
    const before = await ageDevice(world.fresh);
    const row = await heartbeat(world.fresh, { p_ninjatrader_version: null, p_queue_depth: 9, p_queue_bytes: 23481 });
    expect(row).toMatchObject({ device_id: world.fresh, health_status: 'online', throttled: false });
    const after = await device(world.fresh);
    expect(after.ninjatrader_version).toBeNull();
    expect(after.health_status).toBe('online');
    expect(after.agent_version).toBe('1.2.0');
    expect(after.metadata).toMatchObject({ queueDepth: 9, queueBytes: 23481, addonAvailable: true });
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('the first_online audit row was written, with the version honestly null', async () => {
    const rows = await auditRows(world.fresh);
    expect(rows.map((row) => row.action)).toEqual(['ingest_device.first_online']);
    expect(rows[0].after_data).toMatchObject({
      deviceId: world.fresh,
      clientId: world.client,
      agentVersion: '1.2.0',
      ninjaTraderVersion: null,
      healthStatus: 'online',
    });
  });

  it('the first capture of the day then fills the column through the next heartbeat', async () => {
    await ageDevice(world.fresh);
    await heartbeat(world.fresh, { p_ninjatrader_version: '8.1.6.0', p_last_capture_at: new Date().toISOString() });
    expect((await device(world.fresh)).ninjatrader_version).toBe('8.1.6.0');
  });

  it('a restart tomorrow (null again) does not erase what was learned', async () => {
    await ageDevice(world.fresh);
    await heartbeat(world.fresh, { p_ninjatrader_version: null });
    expect((await device(world.fresh)).ninjatrader_version).toBe('8.1.6.0');
  });

  it('a recovery audit row also carries the effective version', async () => {
    await ageDevice(world.fresh);
    await heartbeat(world.fresh, {
      p_ninjatrader_version: null, p_health_status: 'error', p_last_error_code: 'upload_failed',
    });
    expect((await device(world.fresh)).last_error_code).toBe('upload_failed');
    await ageDevice(world.fresh);
    await heartbeat(world.fresh, { p_ninjatrader_version: null });
    const recovered = (await auditRows(world.fresh)).filter((row) => row.action === 'ingest_device.recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].after_data).toMatchObject({ ninjaTraderVersion: '8.1.6.0', lastErrorCode: null });
  });
});

describe('what is still refused, exactly as before', () => {
  it('a NinjaTrader version that is not a version', async () => {
    for (const bad of ['not-a-version', '8.1.6.0-beta', '8', '', ' ', '<script>', '1'.repeat(40), '8.1.6.0.1']) {
      expect(await refusal(world.known, { p_ninjatrader_version: bad })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    }
    expect((await device(world.known)).ninjatrader_version).toBe('8.1.7.0');
  });

  it('the agent and add-on versions are still required and still validated', async () => {
    expect(await refusal(world.known, { p_agent_version: null })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_addon_version: null })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_agent_version: 'nope' })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_addon_version: '1.0.0-rc1' })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
  });

  it('the eight stable error codes pass with health error, and anything else fails', async () => {
    for (const code of STABLE_CODES) {
      await ageDevice(world.known);
      const row = await heartbeat(world.known, {
        p_health_status: 'error', p_last_error_code: code, p_last_error_message: `because ${code}`,
      });
      expect(row).toMatchObject({ health_status: 'error', throttled: false });
      expect((await device(world.known)).last_error_code).toBe(code);
    }
    for (const word of ['invalid_heartbeat', 'heartbeat_failed', 'ingest_at_capacity', 'UPLOAD_FAILED', '']) {
      expect(await refusal(world.known, { p_health_status: 'error', p_last_error_code: word }))
        .toMatch(/INVALID_HEARTBEAT_REQUEST/);
    }
    // Back to online for the tests that follow.
    await ageDevice(world.known);
    await heartbeat(world.known);
  });

  it('health status and error code must still agree, and the message is still bounded', async () => {
    expect(await refusal(world.known, { p_health_status: 'online', p_last_error_code: 'upload_failed' }))
      .toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_health_status: 'error', p_last_error_code: null }))
      .toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_health_status: 'pending' })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_last_error_message: 'x'.repeat(257) })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_last_error_message: 'line\nbreak' })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
  });

  it('the queue bounds, the future skew and the interval bounds', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(await refusal(world.known, { p_queue_depth: -1 })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_queue_bytes: null })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_last_capture_at: future })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_last_success_at: future })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_min_interval_seconds: 0 })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    expect(await refusal(world.known, { p_min_interval_seconds: 3601 })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
  });

  it('the order of the two timestamps is still free, the deadlock step 41 removed stays removed', async () => {
    const t = Date.now();
    const earlier = new Date(t - 60 * 1000).toISOString();
    const now = new Date(t).toISOString();
    expect(await refusal(world.known, { p_last_capture_at: earlier, p_last_success_at: now })).toBeNull();
    expect(await refusal(world.known, { p_last_capture_at: now, p_last_success_at: earlier })).toBeNull();
    expect(await refusal(world.known, { p_last_capture_at: now, p_last_success_at: null })).toBeNull();
  });

  it('a revoked device and an unknown device are still INVALID_INGEST_DEVICE', async () => {
    expect(await refusal(world.revoked)).toMatch(/INVALID_INGEST_DEVICE/);
    expect(await refusal('00000000-0000-4000-8000-000000000000')).toMatch(/INVALID_INGEST_DEVICE/);
  });
});

describe('grants: exactly the service role, and this file\'s own', () => {
  it('the drift installed before 63 was real: anon and authenticated held EXECUTE, service_role did not', () => {
    expect(world.before.grantees).toContain('anon');
    expect(world.before.grantees).toContain('authenticated');
    expect(world.before.grantees).not.toContain('service_role');
  });

  it('after 63 the ACL names service_role and nobody else, besides the owner', async () => {
    const grantees = await executeGrantees();
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('authenticated');
    expect(grantees).not.toContain('public');
    expect(grantees).toContain('service_role');
    expect(grantees.filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('anon and authenticated are refused at the door, service_role is not', async () => {
    for (const role of ['anon', 'authenticated']) {
      const params = ORDER.map((name) => args(world.known)[name]);
      expect(await refusalAsRole(db, role, CALL, { params })).toMatch(/permission denied for function record_ingest_heartbeat/);
    }
    await ageDevice(world.known);
    expect((await heartbeat(world.known)).throttled).toBe(false);
  });
});

describe('running it again', () => {
  it('is a no-op: same definition, same grants, same behaviour', async () => {
    const notices = await applyFileCollectingNotices(db, STEP);
    expect(notices).toEqual([]);
    expect(await functionDefinition()).toBe(world.after.definition);
    expect((await executeGrantees()).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    await ageDevice(world.fresh);
    await heartbeat(world.fresh, { p_ninjatrader_version: null });
    expect((await device(world.fresh)).ninjatrader_version).toBe('8.1.6.0');
  });

  it('step 41 run again on top brings the refusal back, and 63 run again removes it', async () => {
    // This is the hazard the runbook row names. Proved rather than asserted
    // from the text, so a future edit to 41 that carries the fix is free to
    // delete this test along with the warning.
    await applyFileCollectingNotices(db, 'step_41_heartbeat_ordering.sql');
    expect(await refusal(world.known, { p_ninjatrader_version: null })).toMatch(/INVALID_HEARTBEAT_REQUEST/);
    await applyFileCollectingNotices(db, STEP);
    await ageDevice(world.known);
    expect((await heartbeat(world.known, { p_ninjatrader_version: null })).throttled).toBe(false);
    expect((await device(world.known)).ninjatrader_version).toBe('8.1.7.0');
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 63 is numbered once, after 62', () => {
  it('appears once, and 54 is still a deliberate gap', () => {
    // Step 64's test now holds the "highest number" assertion; this one only
    // says 63 is here once and that nothing reused 54.
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 63)).toHaveLength(1);
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(63);
    expect(numbers).not.toContain(54);
    for (const merged of [58, 59, 60, 61, 62]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 62, and in the run order after 62', () => {
    expect(runbook).toMatch(/^\| 63 \| `step_63_heartbeat_without_ninjatrader_version\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 63 | `step_63_heartbeat_without_ninjatrader_version.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 62 | `step_62_payment_status.sql`'));
    expect(runbook).toMatch(/→ 61 → 62 → 63( →|\.)/);
  });
});
