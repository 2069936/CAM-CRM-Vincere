/* STEP 69, ASKED OF A RUNNING POSTGRES.
 *
 * The database is built from the files up to 68, a client, a device and a
 * batch in every state the function has to tell apart are seeded, and then 69
 * runs the way Pedro runs it. After that every verdict is the database's own:
 * what record_ingest_batch_error_detail returns AS THE SERVICE ROLE the ingest
 * route runs as, what it leaves on the row, what anon and authenticated are
 * told at the door, and the whole life of a refused close through the real
 * finalize_ingest_batch_v3 and the real replay claim, neither of which this
 * file changes.
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

const STEP = 'step_69_ingest_batch_error_detail.sql';
const SIGNATURE = 'public.record_ingest_batch_error_detail(uuid, text)';
const FINALIZE_V3 = 'public.finalize_ingest_batch_v3(uuid, uuid, uuid, uuid, text, uuid, timestamptz, boolean, text, jsonb, jsonb, text, jsonb, integer)';
const CALL = 'select public.record_ingest_batch_error_detail($1::uuid, $2::text) as written';
const DENIED = /permission denied for function record_ingest_batch_error_detail/;
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');

// What validationReasonSummary writes, in the shape it writes it.
const REASON = 'executions[*].accountName does not reference an account (APEX 4521 07); accounts[*].netLiquidation must be a number or null';

let db;
const world = {};

/** Runs one statement as the service role and KEEPS its effect, as the route's call does. */
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

async function record(batchId, detail) {
  return (await asService(CALL, [batchId, detail]))[0].written;
}

async function row(batchId) {
  return (await db.query(
    'select status, error_code, error_detail, processed_at, processing_token from public.ingest_batches where id = $1',
    [batchId])).rows[0];
}

async function seedBatch({ status, errorCode = null, detail = null, tradingDate = '2026-10-14' }) {
  const processing = status === 'processing';
  return one(db, `insert into public.ingest_batches
      (capture_id, device_id, client_id, trading_date, captured_at, schema_version, storage_path, content_sha256,
       byte_count, status, error_code, error_detail, processing_token, processing_lease_expires_at)
    values (gen_random_uuid(), $1, $2, $3, '2026-10-14T20:45:00Z', 1, 'test/' || gen_random_uuid()::text, 'sha', 10,
       $4, $5, $6, case when $7 then gen_random_uuid() end, case when $7 then clock_timestamp() + interval '5 minutes' end)
    returning id`,
  [world.device, world.client, tradingDate, status, errorCode, detail, processing]);
}

async function executeGrantees() {
  return column(db, `
    select case when grantee = 0 then 'public' else pg_get_userbyid(grantee) end
      from pg_proc, aclexplode(proacl)
     where oid = '${SIGNATURE}'::regprocedure and privilege_type = 'EXECUTE'
     order by 1`);
}

/** The finalize the route calls on a validation failure, as the service role, unchanged by 69. */
async function finalizeFailed(batchId, errorCode) {
  const { processing_token: token } = await row(batchId);
  return asService(`select (public.finalize_ingest_batch_v3(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'failed', null, '2026-10-14T20:45:00Z'::timestamptz, false, $5,
      '{}'::jsonb, '{}'::jsonb, 'ingest_batch_failed', '{"normalize": 3}'::jsonb, 40)).status`,
  [batchId, world.device, world.client, token, errorCode]);
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder({ upTo: 68 }));

  world.client = await one(db, "insert into public.clients (name) values ('Gray Elm') returning id");
  world.device = await one(db, 'insert into public.ingest_devices (client_id) values ($1) returning id', [world.client]);
  const managerAuth = await one(db, "insert into auth.users (email) values ('mgr@example.com') returning id");
  world.manager = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [managerAuth]);

  world.invalid = await seedBatch({ status: 'failed', errorCode: 'invalid_auto_import_snapshot' });
  world.unsupported = await seedBatch({ status: 'failed', errorCode: 'unsupported_schema_version' });
  world.otherCodes = {};
  for (const code of ['normalization_failed', 'reconciliation_failed', 'persistence_failed', 'storage_failed', 'ingest_failed']) {
    world.otherCodes[code] = await seedBatch({ status: 'failed', errorCode: code });
  }
  world.processed = await seedBatch({ status: 'processed' });
  world.incomplete = await seedBatch({ status: 'incomplete' });
  world.received = await seedBatch({ status: 'received' });
  world.processing = await seedBatch({ status: 'processing' });

  // BEFORE 69: the function does not exist, so the route had nowhere to put
  // the reason, and the finalize it calls leaves error_detail NULL.
  world.before = {
    fn: await one(db, `select to_regprocedure('${SIGNATURE}') is null`),
    details: await one(db, 'select count(*)::int from public.ingest_batches where error_detail is not null'),
  };

  world.notices = await applyFileCollectingNotices(db, STEP);
}, 120_000);

afterAll(async () => { await db?.close?.(); });

/* ── The order guard ─────────────────────────────────────────────────────── */

describe('the order guard', () => {
  it('refuses to run before step 45, says which, and leaves nothing behind', async () => {
    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 44 }));
    try {
      await expect(applyFileCollectingNotices(early, STEP))
        .rejects.toThrow(/step 69 needs step 45 \(finalize_ingest_batch_v3, ingest_batches\.error_detail\): run it first/);
      expect(await one(early, `select to_regprocedure('${SIGNATURE}') is null`)).toBe(true);
    } finally {
      await early.close();
    }
  }, 120_000);
});

/* ── What it writes, and where it refuses ───────────────────────────────── */

describe('before 69', () => {
  it('there was no function and no batch carried a reason', () => {
    expect(world.before).toEqual({ fn: true, details: 0 });
  });
});

describe('it writes the reason on a failed batch refused by the validator, and nowhere else', () => {
  it('invalid_auto_import_snapshot: written, and true', async () => {
    expect(await record(world.invalid, REASON)).toBe(true);
    expect(await row(world.invalid)).toMatchObject({ status: 'failed', error_code: 'invalid_auto_import_snapshot', error_detail: REASON });
  });

  it('unsupported_schema_version: written, and true', async () => {
    expect(await record(world.unsupported, 'schemaVersion must be 1')).toBe(true);
    expect((await row(world.unsupported)).error_detail).toBe('schemaVersion must be 1');
  });

  it('a second call replaces the first: the reason is the latest attempt\'s', async () => {
    expect(await record(world.invalid, 'schemaVersion must be 1; captureId is required')).toBe(true);
    expect((await row(world.invalid)).error_detail).toBe('schemaVersion must be 1; captureId is required');
    expect(await record(world.invalid, REASON)).toBe(true);
    expect((await row(world.invalid)).error_detail).toBe(REASON);
  });

  it('a failed batch with any other code: false, and the row untouched', async () => {
    for (const [code, id] of Object.entries(world.otherCodes)) {
      const before = await row(id);
      expect(await record(id, REASON), code).toBe(false);
      expect(await row(id), code).toEqual(before);
      expect(before.error_detail, code).toBeNull();
    }
  });

  it('a batch that is not failed: false, whatever its state, and the row untouched', async () => {
    for (const id of [world.processed, world.incomplete, world.received, world.processing]) {
      const before = await row(id);
      expect(await record(id, REASON)).toBe(false);
      expect(await row(id)).toEqual(before);
    }
  });

  it('the status is checked on its own: a validation code on a batch that is not failed is refused', async () => {
    // No RPC leaves this state (the replay claim clears the code), but a hand
    // edit in the SQL editor can; the code alone never decides.
    for (const status of ['processing', 'processed', 'incomplete', 'received', 'replaced', 'late_closed_day']) {
      const id = await seedBatch({ status, errorCode: 'invalid_auto_import_snapshot' });
      expect(await record(id, REASON), status).toBe(false);
      expect((await row(id)).error_detail, status).toBeNull();
      await db.query('delete from public.ingest_batches where id = $1', [id]);
    }
  });

  it('a batch that does not exist, and a null id: false, and nothing written anywhere', async () => {
    const before = await one(db, 'select count(*)::int from public.ingest_batches where error_detail is not null');
    expect(await record('00000000-0000-4000-8000-000000000000', REASON)).toBe(false);
    expect(await record(null, REASON)).toBe(false);
    expect(await one(db, 'select count(*)::int from public.ingest_batches where error_detail is not null')).toBe(before);
  });

  it('an empty, blank or null detail: false, and the reason already there is kept', async () => {
    for (const detail of [null, '', '   ', '\n\t\r ']) {
      expect(await record(world.invalid, detail), JSON.stringify(detail)).toBe(false);
      expect((await row(world.invalid)).error_detail).toBe(REASON);
    }
  });
});

describe('what it stores', () => {
  it('caps the detail at 2000 characters', async () => {
    expect(await record(world.unsupported, 'x'.repeat(5000))).toBe(true);
    expect((await row(world.unsupported)).error_detail).toBe('x'.repeat(2000));
    expect(await record(world.unsupported, 'y'.repeat(2000))).toBe(true);
    expect((await row(world.unsupported)).error_detail).toBe('y'.repeat(2000));
  });

  it('never leaves a trailing space where the cut fell', async () => {
    expect(await record(world.unsupported, `${'z'.repeat(1999)} tail`)).toBe(true);
    expect((await row(world.unsupported)).error_detail).toBe('z'.repeat(1999));
  });

  it('replaces control characters with spaces and trims the ends', async () => {
    const dirty = '\n\t accounts[*].cashValue\nmust be\ta number\u0007or null\r\u001b[31m\u007f;\u0085 orders[*].time is required ';
    expect(await record(world.unsupported, dirty)).toBe(true);
    const stored = (await row(world.unsupported)).error_detail;
    expect(stored).toBe('accounts[*].cashValue must be a number or null  [31m ;  orders[*].time is required');
    // Not one control character survives, measured by the database itself.
    expect(await one(db, `select error_detail ~ '[\\u0001-\\u001F\\u007F-\\u009F]' from public.ingest_batches where id = $1`, [world.unsupported])).toBe(false);
  });

  it('keeps letters beyond ASCII as they are', async () => {
    expect(await record(world.unsupported, 'orders[*].accountName does not reference an account (Niño Ölçer 01…)')).toBe(true);
    expect((await row(world.unsupported)).error_detail).toBe('orders[*].accountName does not reference an account (Niño Ölçer 01…)');
  });
});

/* ── The life of a refused close, through functions 69 does not change ───── */

describe('a refused close, from upload to replay', () => {
  it('the route finalizes it failed with the reason NULL, then records why', async () => {
    world.live = await seedBatch({ status: 'processing', tradingDate: '2026-10-13' });
    expect(await finalizeFailed(world.live, 'invalid_auto_import_snapshot')).toEqual([{ status: 'failed' }]);
    expect(await row(world.live)).toMatchObject({ status: 'failed', error_code: 'invalid_auto_import_snapshot', error_detail: null, processing_token: null });
    expect(await record(world.live, REASON)).toBe(true);
    expect((await row(world.live)).error_detail).toBe(REASON);
  });

  it('called before the finalize, while the batch is still processing, it writes nothing', async () => {
    const early = await seedBatch({ status: 'processing', tradingDate: '2026-10-12' });
    expect(await record(early, REASON)).toBe(false);
    await finalizeFailed(early, 'invalid_auto_import_snapshot');
    expect((await row(early)).error_detail).toBeNull();
  });

  it('a replay claim clears it, the replay that fails again records its own, and one that fails otherwise records none', async () => {
    const claim = async () => asService(
      'select public.claim_ingest_batch_reprocess($1, $2, gen_random_uuid(), 300, false, $3) ->> \'outcome\' as outcome',
      [world.live, world.manager, 'Record why it was rejected']);
    expect(await claim()).toEqual([{ outcome: 'owned' }]);
    expect(await row(world.live)).toMatchObject({ status: 'processing', error_code: null, error_detail: null });
    expect(await record(world.live, REASON)).toBe(false);

    await finalizeFailed(world.live, 'invalid_auto_import_snapshot');
    expect((await row(world.live)).error_detail).toBeNull();
    expect(await record(world.live, 'executions[*].accountName does not reference an account (APEX 4521 07)')).toBe(true);
    expect((await row(world.live)).error_detail).toBe('executions[*].accountName does not reference an account (APEX 4521 07)');

    expect(await claim()).toEqual([{ outcome: 'owned' }]);
    await finalizeFailed(world.live, 'ingest_failed');
    expect(await record(world.live, REASON)).toBe(false);
    expect(await row(world.live)).toMatchObject({ status: 'failed', error_code: 'ingest_failed', error_detail: null });
  });

  it('finalize_ingest_batch_v3 is the one step 45 left: same arguments, still service role only', async () => {
    expect(await one(db, `select to_regprocedure('${FINALIZE_V3}') is not null`)).toBe(true);
    expect(await refusalAsRole(db, 'authenticated', `select ${FINALIZE_V3.replace(/\(.*$/, '')}(null, null, null, null, null, null, null, null, null, null, null, null, null, null)`))
      .toMatch(/permission denied for function finalize_ingest_batch_v3/);
  });
});

/* ── Grants ──────────────────────────────────────────────────────────────── */

describe('grants: the service role, and nobody else', () => {
  it('the ACL names service_role and nobody else besides the owner', async () => {
    expect((await executeGrantees()).filter((role) => role !== 'postgres')).toEqual(['service_role']);
  });

  it('anon and authenticated are refused at the door, signed in or not', async () => {
    expect(await refusalAsRole(db, 'anon', CALL, { params: [world.invalid, 'forged'] })).toMatch(DENIED);
    expect(await refusalAsRole(db, 'authenticated', CALL, { params: [world.invalid, 'forged'] })).toMatch(DENIED);
    expect(await refusalAsRole(db, 'authenticated', CALL, { params: [world.invalid, 'forged'], subject: '11111111-1111-4111-8111-111111111111' })).toMatch(DENIED);
    expect((await row(world.invalid)).error_detail).toBe(REASON);
  });

  it('the service role executes it', async () => {
    expect(await refusalAsRole(db, 'service_role', CALL, { params: [world.invalid, REASON] })).toBeNull();
  });

  it('is security definer with search_path pinned to pg_catalog, public, and returns boolean', async () => {
    expect((await db.query(`select prosecdef, proconfig, prorettype::regtype::text as returns from pg_proc where oid = '${SIGNATURE}'::regprocedure`)).rows[0])
      .toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public'], returns: 'boolean' });
  });

  it('ingest_batches itself stays closed to anon and authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await refusalAsRole(db, role, 'select error_detail from public.ingest_batches limit 1'), role)
        .toMatch(/permission denied for table ingest_batches/);
    }
  });
});

/* ── Running it again ─────────────────────────────────────────────────────── */

describe('running it again', () => {
  it('changes no row, says nothing, and puts drifted grants back', async () => {
    await db.exec(`grant execute on function ${SIGNATURE} to anon, authenticated, public;
                   revoke execute on function ${SIGNATURE} from service_role;`);
    expect((await executeGrantees()).filter((role) => role !== 'postgres')).toEqual(['anon', 'authenticated', 'public']);
    const rows = (await db.query('select id, status, error_code, error_detail from public.ingest_batches order by id')).rows;

    const notices = await applyFileCollectingNotices(db, STEP);

    expect(notices).toEqual([]);
    expect((await db.query('select id, status, error_code, error_detail from public.ingest_batches order by id')).rows).toEqual(rows);
    expect((await executeGrantees()).filter((role) => role !== 'postgres')).toEqual(['service_role']);
    expect(await refusalAsRole(db, 'authenticated', CALL, { params: [world.invalid, 'forged'] })).toMatch(DENIED);
    expect(await record(world.invalid, REASON)).toBe(true);
  });

  it('a first run said nothing either', () => {
    expect(world.notices).toEqual([]);
  });
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 69 is here once, after the steps it builds on', () => {
  it('appears once, 70 now carries the highest-number claim, and 54 is still a deliberate gap', () => {
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 69)).toHaveLength(1);
    // Step 70's test now holds "the highest number"; this one only says 69 is
    // here once, after the steps it builds on.
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(69);
    expect(numbers).not.toContain(54);
    for (const merged of [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68]) expect(numbers).toContain(merged);
  });

  it('is in the runbook table after 68, in the run order after 68, and says what it records and when to reprocess', () => {
    expect(runbook).toMatch(/^\| 69 \| `step_69_ingest_batch_error_detail\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 69 | `step_69_ingest_batch_error_detail.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 68 | `step_68_flag_hygiene_manual_retire.sql`'));
    expect(runbook).toMatch(/→ 65 → 66 → 67 → 68 → 69(?: →|\.)/);
    expect(runbook).toContain('record_ingest_batch_error_detail');
    expect(runbook).toContain('Why it was rejected');
  });
});
