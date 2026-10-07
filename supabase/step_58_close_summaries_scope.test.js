// Step 58 is asserted by calling the function, as the role, on a database that
// holds every migration in this directory.
//
// WHAT IT CLOSES. Step 48's replace_close_summaries is SECURITY DEFINER and
// granted to `authenticated`, and as first written it checked nothing about its
// caller. Since step 52 a CAM reads only its own clients, so on the migration
// cluster a CAM that could see 0 of another CAM's summary rows called it once
// and that CAM's Cash row for the day read -99,999.00. The tests below make
// that call again, as that CAM, with that CAM's request.jwt.claim.sub, and
// require the database to refuse it.
//
// WHY THE ROW ASSERTIONS ARE NOT DECORATION. A refused call is one statement
// that raised, so PostgreSQL has rolled back whatever it did either way, and
// "the rows are still there" can look like it proves nothing. It proves the
// thing that matters, because the failure it guards against is not a raise
// after the delete: it is no raise at all. With the check removed the same call
// returns 1 and the rows below change, which is what the mutation run for this
// PR did to every test in the defect block.
//
// THE PAYLOADS ARE THE BROWSER'S OWN. Every legitimate call below builds its rows
// with buildCloseSummaryRows and closeSummaryToDb from src/domain/closeSummary.js,
// in the two shapes src/domain/supabaseStore.js sends: one close after an upload,
// every close of one client after a reclassification. A check that refused
// either would break the CRM, and only a payload built by the same code proves
// it does not.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCloseSummaryRows, closeSummaryToDb } from '../src/domain/closeSummary.js';
import {
  migrationFilesInOrder,
  one,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

/* The browser's PostgREST client, replaced so the real
 * replaceSupabaseCloseSummaries can be handed the error the real database
 * raised. Nothing else in this file touches it. */
const rpcAnswer = vi.hoisted(() => ({ current: { data: 0, error: null } }));
vi.mock('../src/lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: { rpc: async () => rpcAnswer.current },
}));
const { replaceSupabaseCloseSummaries } = await import('../src/domain/supabaseStore.js');

const migrationUrl = new URL('./step_58_close_summaries_scope.sql', import.meta.url);
const step48Url = new URL('./step_48_close_summaries.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const runbook = readFileSync(runbookUrl, 'utf8');

const FUNCTION = /create or replace function public\.replace_close_summaries\([\s\S]*?\$function\$;/;
const REFUSED = /^replace_close_summaries refused: /;

let db;
const world = {};

/** Rows for one close, built the way an upload builds them. */
function uploadRows(dailyImportId, clientId, tradingDate, cashPnl) {
  return buildCloseSummaryRows({
    accountRegistry: { 'CASH-1': { accountType: 'Cash' }, 'FUND-1': { accountType: 'Funded' } },
    dailyImport: {
      clientId,
      date: tradingDate,
      snapshots: [
        { accountName: 'CASH-1', grossRealizedPnl: cashPnl, weeklyPnl: 300, accountBalance: 25000 },
        { accountName: 'FUND-1', grossRealizedPnl: -40, weeklyPnl: -80, accountBalance: 50000 },
      ],
    },
  }).map((row) => closeSummaryToDb(row, { dailyImportId, clientId, tradingDate }));
}

/**
 * Calls replace_close_summaries AS a role, with a real request.jwt.claim.sub,
 * then reads close_summaries back AS postgres inside the same transaction, so
 * the read sees what the call left and is not filtered by the caller's policy.
 * Always rolled back, so every test starts from the same world.
 *
 * @param {string|null|undefined} subject the auth uid; null sets it empty, and
 *   undefined leaves it unset, which is how the service role arrives.
 */
async function callAs(role, subject, ids, rows) {
  let error = null;
  let returned;
  await db.exec('begin');
  try {
    if (subject !== undefined) {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [subject ?? '']);
    }
    await db.exec(`set local role ${role}`);
    await db.exec('savepoint call');
    try {
      returned = await one(db, 'select public.replace_close_summaries($1::uuid[], $2::jsonb) as n',
        [ids, jsonArgument(rows)]);
    } catch (caught) {
      error = caught;
      await db.exec('rollback to savepoint call');
    }
    await db.exec('reset role');
    return { error, returned, summaries: await summaries() };
  } finally {
    await db.exec('rollback');
  }
}

/**
 * p_rows as PostgREST would hand it over: null is SQL NULL (a body with
 * "p_rows": null), a string is sent as the jsonb text it already is (so the
 * jsonb literal `null` and `{}` can be sent), and anything else is serialised.
 */
function jsonArgument(rows) {
  if (rows === null) return null;
  return typeof rows === 'string' ? rows : JSON.stringify(rows);
}

/** Every stored row, as `client/close/segment=pnl`, in a stable order. */
async function summaries() {
  const { rows } = await db.query(`
    select c.name as client, d.trading_date::text as day, s.segment, s.daily_pnl::float8 as pnl,
           s.client_id = d.client_id as filed_under_its_close
    from public.close_summaries s
    join public.daily_imports d on d.id = s.daily_import_id
    join public.clients c on c.id = s.client_id
    order by c.name, d.trading_date, s.segment`);
  return rows.map((row) => `${row.client}/${row.day}/${row.segment}=${row.pnl}${row.filed_under_its_close ? '' : ' MISFILED'}`);
}

const SEEDED = [
  'Ash/2026-10-01/Cash=300',
  'Birch/2026-10-01/Cash=1234.5',
  'Gray/2026-10-01/Cash=100',
  'Gray/2026-10-02/Cash=200',
];

async function seedWorld(target) {
  const auth = (email) => one(target, 'insert into auth.users (email) values ($1) returning id', [email]);
  const ids = {
    peter: await auth('peter@example.com'),
    quinn: await auth('quinn@example.com'),
    manager: await auth('manager@example.com'),
    gone: await auth('gone@example.com'),
    stranger: await auth('stranger@example.com'),
    idle: await auth('idle@example.com'),
  };
  const client = (name) => one(target, 'insert into public.clients (name) values ($1) returning id', [name]);
  ids.gray = await client('Gray');
  ids.ash = await client('Ash');
  ids.birch = await client('Birch');
  const cam = (name) => one(target, 'insert into public.cam_profiles (name) values ($1) returning id', [name]);
  const peterCam = await cam('Peter');
  const quinnCam = await cam('Quinn');
  const goneCam = await cam('Gone');
  /* An Active CAM with no client at all: everything it can read is a leak. */
  const idleCam = await cam('Idle');
  Object.assign(ids, { peterCam, quinnCam });
  await target.query(
    `insert into public.client_assignments (client_id, cam_profile_id)
     values ($1, $4), ($2, $4), ($3, $5), ($1, $6)`,
    [ids.gray, ids.ash, ids.birch, peterCam, quinnCam, goneCam]);
  await target.query(
    `insert into public.app_users (username, display_name, role, status, auth_user_id, cam_profile_id) values
       ('peter', 'Peter', 'CAM', 'Active', $1, $2),
       ('quinn', 'Quinn', 'CAM', 'Active', $3, $4),
       ('gone', 'Gone', 'CAM', 'Inactive', $5, $6),
       ('boss', 'Boss', 'Manager', 'Active', $7, null),
       ('idle', 'Idle', 'CAM', 'Active', $8, $9)`,
    [ids.peter, peterCam, ids.quinn, quinnCam, ids.gone, goneCam, ids.manager, ids.idle, idleCam]);

  const close = (clientId, day) => one(target,
    'insert into public.daily_imports (client_id, trading_date) values ($1, $2) returning id', [clientId, day]);
  ids.grayMon = await close(ids.gray, '2026-10-01');
  ids.grayTue = await close(ids.gray, '2026-10-02');
  ids.ashMon = await close(ids.ash, '2026-10-01');
  ids.birchMon = await close(ids.birch, '2026-10-01');
  for (const [importId, clientId, day, pnl] of [
    [ids.grayMon, ids.gray, '2026-10-01', 100],
    [ids.grayTue, ids.gray, '2026-10-02', 200],
    [ids.ashMon, ids.ash, '2026-10-01', 300],
    [ids.birchMon, ids.birch, '2026-10-01', 1234.5],
  ]) {
    await target.query(
      `insert into public.close_summaries (daily_import_id, client_id, trading_date, segment, daily_pnl)
       values ($1, $2, $3, 'Cash', $4)`, [importId, clientId, day, pnl]);
  }
  return ids;
}

beforeAll(async () => {
  db = await startMigrationCluster(migrationFilesInOrder());
  Object.assign(world, await seedWorld(db));
}, 120_000);

afterAll(async () => { await db?.close?.(); });

// ---------------------------------------------------------------------------
describe('step 58 is no longer the one that runs last', () => {
  it('appears once, a later step follows it, and 54 is still a deliberate gap', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 58)).toHaveLength(1);
    // 59 and 60 (PR 75) landed after this file; the highest-number claim moved to 60.
    expect(Math.max(...numbers)).toBeGreaterThan(58);
    expect(numbers).not.toContain(54);
    expect(raw).toMatch(/54 is still claimed by draft PR 65/);
  });

  it('is in the runbook table and in the run order', () => {
    expect(runbook).toMatch(/^\| 58 \| `step_58_close_summaries_scope\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 58 | `step_58_close_summaries_scope.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 57 | `step_57_algorithm_live_samples.sql`'));
    expect(runbook).toContain('→ 56 → 57 → 58 →');
  });

  it('refuses to run before step 48 and step 52, and changes nothing when it does', async () => {
    await expect(startMigrationCluster(
      migrationFilesInOrder({ upTo: 47 }).concat(['step_58_close_summaries_scope.sql']),
    )).rejects.toThrow(/step 58 needs step 48 \(replace_close_summaries\) and step 52[\s\S]*replace_close_summaries\(uuid\[\], jsonb\)[\s\S]*Nothing has been changed/);

    const early = await startMigrationCluster(migrationFilesInOrder({ upTo: 51 }));
    try {
      const before = await one(early,
        "select md5(prosrc) from pg_proc where oid = 'public.replace_close_summaries(uuid[], jsonb)'::regprocedure");
      await expect(early.exec(readFileSync(migrationUrl, 'utf8')))
        .rejects.toThrow(/public\.is_manager\(\), assigned_client_ids\(\) not found\. Nothing has been changed/);
      expect(await one(early,
        "select md5(prosrc) from pg_proc where oid = 'public.replace_close_summaries(uuid[], jsonb)'::regprocedure"))
        .toBe(before);
    } finally {
      await early.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
describe('its own closing check is part of the same transaction', () => {
  it('a failed check leaves the function that was there before, not a new one', async () => {
    /* The check refuses a database where anon can execute the function. Step 58
     * revokes anon's grant itself, so the one way left to make the check fire
     * is a membership step 58 does not touch: anon made a member of
     * authenticated. If the check ran after the commit, the new body would
     * already be installed when it complained. */
    const before = await startMigrationCluster(migrationFilesInOrder({ upTo: 57 }));
    const body = "select md5(prosrc) from pg_proc where oid = 'public.replace_close_summaries(uuid[], jsonb)'::regprocedure";
    try {
      await before.exec(`
        create or replace function public.replace_close_summaries(p_daily_import_ids uuid[], p_rows jsonb)
        returns integer language plpgsql security definer set search_path = pg_catalog, public
        as $marker$ begin return -1; end; $marker$;
        grant authenticated to anon;`);
      const marker = await one(before, body);
      await expect(before.exec(readFileSync(migrationUrl, 'utf8')))
        .rejects.toThrow(/step 58 left replace_close_summaries executable by anon/);
      await before.exec('rollback').catch(() => {});
      expect(await one(before, body)).toBe(marker);
    } finally {
      await before.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
describe('the defect: a CAM writing summaries of a client it cannot read', () => {
  it('cannot read the other CAM\'s summaries in the first place, which is the rule being enforced', async () => {
    /* Step 52's policy on the table: Quinn reads Birch's one row and none of
     * Gray's or Ash's. The function must not let Quinn write what this hides. */
    const seen = await rowsAsRole(db, 'authenticated',
      'select client_id from public.close_summaries', { subject: world.quinn });
    expect(seen.map((row) => row.client_id)).toEqual([world.birch]);
    expect(await rowsAsRole(db, 'authenticated',
      'select client_id from public.close_summaries', { subject: world.idle })).toEqual([]);
  });

  it('refuses a forged figure on another CAM\'s close, and the figure stays', async () => {
    /* The measured attack, verbatim: Quinn (Birch's CAM) names Gray's Monday
     * close and sends a Cash row of -99,999. Before step 58 this returned 1. */
    const forged = [{
      daily_import_id: world.grayMon, client_id: world.gray, trading_date: '2026-10-01',
      segment: 'Cash', daily_pnl: -99999,
    }];
    const result = await callAs('authenticated', world.quinn, [world.grayMon], forged);
    expect(result.error?.message).toMatch(REFUSED);
    expect(result.error?.code).toBe('42501');
    expect(result.summaries).toEqual(SEEDED);
  });

  it('refuses to empty another CAM\'s client by naming its closes with no rows', async () => {
    const result = await callAs('authenticated', world.quinn, [world.grayMon, world.grayTue], []);
    expect(result.error?.message).toMatch(REFUSED);
    expect(result.summaries).toEqual(SEEDED);
  });

  it('refuses the emptying however p_rows arrives: SQL null, jsonb null, an object, an empty array', async () => {
    /* PostgREST hands a body with "p_rows": null to the function as SQL NULL,
     * so this is one request from the browser's publishable key. The delete
     * runs before the rows are looked at, so a check that only ran when rows
     * were sent would let either CAM below wipe Gray's whole history. */
    for (const subject of [world.quinn, world.idle]) {
      for (const rows of [null, 'null', '{}', []]) {
        const label = `${subject === world.quinn ? 'quinn' : 'idle'} ${JSON.stringify(rows)}`;
        const result = await callAs('authenticated', subject, [world.grayMon, world.grayTue], rows);
        expect(result.error?.message, label).toMatch(REFUSED);
        expect(result.error?.code, label).toBe('42501');
        expect(result.summaries, label).toEqual(SEEDED);
      }
    }
  });

  it('refuses the WHOLE call when one close is mine and one is not, deleting neither', async () => {
    const result = await callAs('authenticated', world.quinn, [world.birchMon, world.grayMon],
      uploadRows(world.birchMon, world.birch, '2026-10-01', 5));
    expect(result.error?.message).toMatch(/refused: 1 of the 2 closes named/);
    expect(result.summaries).toEqual(SEEDED);
  });

  it('refuses a close that does not exist in the same words, so the answer is no oracle', async () => {
    const missing = await callAs('authenticated', world.quinn, ['00000000-0000-4000-8000-000000000000'], []);
    const theirs = await callAs('authenticated', world.quinn, [world.grayMon], []);
    expect(missing.error?.message).toMatch(REFUSED);
    expect(missing.error?.message).toBe(theirs.error?.message);
  });

  it('refuses a row that files money under another CAM\'s client through my own close', async () => {
    /* Peter's own close, so the first check passes; the row names Birch. Without
     * the second check Birch would gain a Cash row filed under Gray's day. */
    const rows = uploadRows(world.grayMon, world.birch, '2026-10-01', 777);
    const result = await callAs('authenticated', world.peter, [world.grayMon], rows);
    expect(result.error?.message).toMatch(/refused: 2 row\(s\) name a client other than the one their close belongs to/);
    expect(result.summaries).toEqual(SEEDED);
  });

  it('refuses it even when both clients are mine, because the row must match its close', async () => {
    const rows = uploadRows(world.grayMon, world.ash, '2026-10-01', 777);
    const result = await callAs('authenticated', world.peter, [world.grayMon], rows);
    expect(result.error?.message).toMatch(REFUSED);
    expect(result.summaries).toEqual(SEEDED);
  });

  it('refuses a signed-in user with no CAM profile, one with no subject, and an Inactive CAM', async () => {
    for (const subject of [world.stranger, null, world.gone]) {
      const result = await callAs('authenticated', subject, [world.grayMon], []);
      expect(result.error?.message, String(subject)).toMatch(REFUSED);
      expect(result.summaries).toEqual(SEEDED);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a client handed to another CAM leaves its creator\'s reach', () => {
  it('the CAM that created a client cannot write its closes once a Manager gives it to another CAM', async () => {
    /* Step 53 lets a CAM see a client it created while nobody owns it, through
     * clients_i_created(). Widening this function's scope with that helper
     * would keep the creator's write after a transfer, because the helper has
     * no "not yet assigned" gate. This walks the real sequence, each step as
     * the role that takes it, in one transaction that is rolled back. */
    /* A statement that raises leaves the role switched; the savepoint in
     * refusalOf undoes that along with the statement. */
    const as = async (subject, sql, params) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [subject]);
      await db.exec('set local role authenticated');
      const { rows } = await db.query(sql, params);
      await db.exec('reset role');
      return rows;
    };
    const refusalOf = async (subject, sql, params) => {
      await db.exec('savepoint attempt');
      try {
        await as(subject, sql, params);
        await db.exec('release savepoint attempt');
        return null;
      } catch (caught) {
        await db.exec('rollback to savepoint attempt');
        return caught;
      }
    };
    const replace = 'select public.replace_close_summaries($1::uuid[], $2::jsonb) as n';
    const elmRows = async () => (await db.query(
      `select segment, daily_pnl::float8 as pnl from public.close_summaries
        where client_id = $1 order by segment`, [elm])).rows
      .map((row) => `${row.segment}=${row.pnl}`);
    let elm;

    await db.exec('begin');
    try {
      /* Peter creates Elm and assigns it to himself, as createSupabaseClient
       * does, then uploads a close and saves its summary. */
      const [created] = await as(world.peter,
        'insert into public.clients (name) values ($1) returning id, created_by', ['Elm']);
      elm = created.id;
      expect(created.created_by).toBe(world.peter);
      await as(world.peter,
        `insert into public.client_assignments (client_id, cam_profile_id, assignment_role)
         values ($1, $2, 'Owner')`, [elm, world.peterCam]);
      const [{ id: elmClose }] = await as(world.peter,
        "insert into public.daily_imports (client_id, trading_date) values ($1, '2026-10-01') returning id", [elm]);
      const [{ n: written }] = await as(world.peter, replace,
        [[elmClose], JSON.stringify(uploadRows(elmClose, elm, '2026-10-01', 50))]);
      expect(written).toBe(2);
      expect(await elmRows()).toEqual(['Cash=50', 'Funded=-40']);

      /* A Manager hands Elm to Quinn. */
      await as(world.manager,
        'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2',
        [elm, world.peterCam]);
      await as(world.manager,
        `insert into public.client_assignments (client_id, cam_profile_id, assignment_role)
         values ($1, $2, 'Owner')`, [elm, world.quinnCam]);
      expect(await as(world.peter, 'select client_id from public.close_summaries where client_id = $1', [elm]))
        .toEqual([]);

      /* Peter, its creator, can no longer forge or empty it. */
      for (const rows of [uploadRows(elmClose, elm, '2026-10-01', -99999), [], null]) {
        const error = await refusalOf(world.peter, replace, [[elmClose], jsonArgument(rows)]);
        expect(error?.message, JSON.stringify(rows)).toMatch(REFUSED);
        expect(error?.code).toBe('42501');
        expect(await elmRows()).toEqual(['Cash=50', 'Funded=-40']);
      }

      /* Quinn, its owner now, can: the refusal above is about Peter, not Elm. */
      expect(await refusalOf(world.quinn, replace,
        [[elmClose], JSON.stringify(uploadRows(elmClose, elm, '2026-10-01', 70))])).toBeNull();
      expect(await elmRows()).toEqual(['Cash=70', 'Funded=-40']);
    } finally {
      await db.exec('rollback');
    }
  });
});

// ---------------------------------------------------------------------------
describe('every legitimate caller still works', () => {
  it('a CAM saving an upload of its own client: one close, the browser\'s rows', async () => {
    /* writeCloseSummaries in src/domain/dailyImportPersistence.js: the close
     * just written, and closeSummaryToDb with the upload's own client. */
    const rows = uploadRows(world.grayMon, world.gray, '2026-10-01', 120.5);
    const result = await callAs('authenticated', world.peter, [world.grayMon], rows);
    expect(result.error).toBeNull();
    expect(result.returned).toBe(2);
    expect(result.summaries).toEqual([
      'Ash/2026-10-01/Cash=300',
      'Birch/2026-10-01/Cash=1234.5',
      'Gray/2026-10-01/Cash=120.5',
      'Gray/2026-10-01/Funded=-40',
      'Gray/2026-10-02/Cash=200',
    ]);
  });

  it('a CAM reclassifying an account: every close of the client in one call', async () => {
    /* rebuildSupabaseCloseSummariesForClient: every close of the client the
     * session can read, with that client on every row. */
    const rows = [
      ...uploadRows(world.grayMon, world.gray, '2026-10-01', 11),
      ...uploadRows(world.grayTue, world.gray, '2026-10-02', 22),
    ];
    const result = await callAs('authenticated', world.peter, [world.grayMon, world.grayTue], rows);
    expect(result.error).toBeNull();
    expect(result.returned).toBe(4);
    expect(result.summaries).toEqual([
      'Ash/2026-10-01/Cash=300',
      'Birch/2026-10-01/Cash=1234.5',
      'Gray/2026-10-01/Cash=11',
      'Gray/2026-10-01/Funded=-40',
      'Gray/2026-10-02/Cash=22',
      'Gray/2026-10-02/Funded=-40',
    ]);
  });

  it('a Manager, on any client', async () => {
    const result = await callAs('authenticated', world.manager, [world.birchMon],
      uploadRows(world.birchMon, world.birch, '2026-10-01', 9));
    expect(result.error).toBeNull();
    expect(result.returned).toBe(2);
    expect(result.summaries).toContain('Birch/2026-10-01/Cash=9');
    expect(result.summaries).not.toContain('Birch/2026-10-01/Cash=1234.5');
  });

  it('the service role, the way the ingest endpoints call it: no subject, one close', async () => {
    /* server/apiLib/autoImportStore.js, through admin.rpc on the service role
     * key. No request.jwt.claim.sub at all. */
    const result = await callAs('service_role', undefined, [world.birchMon],
      uploadRows(world.birchMon, world.birch, '2026-10-01', 42));
    expect(result.error).toBeNull();
    expect(result.returned).toBe(2);
    expect(result.summaries).toContain('Birch/2026-10-01/Cash=42');
  });

  it('the service role, the way the backfill calls it: every close of a client', async () => {
    const rows = [
      ...uploadRows(world.grayMon, world.gray, '2026-10-01', 1),
      ...uploadRows(world.grayTue, world.gray, '2026-10-02', 2),
    ];
    const result = await callAs('service_role', undefined, [world.grayMon, world.grayTue], rows);
    expect(result.error).toBeNull();
    expect(result.returned).toBe(4);
  });

  it('an empty list writes nothing for anyone, as before', async () => {
    for (const subject of [world.quinn, world.stranger]) {
      const result = await callAs('authenticated', subject, [], null);
      expect(result.error).toBeNull();
      expect(result.returned).toBe(0);
      expect(result.summaries).toEqual(SEEDED);
    }
  });
});

// ---------------------------------------------------------------------------
describe('who may call it at all', () => {
  it('anon cannot execute it', async () => {
    const error = await refusalAsRole(db, 'anon',
      `select public.replace_close_summaries(array['${world.grayMon}']::uuid[], '[]'::jsonb)`,
      { subject: null });
    expect(error).toMatch(/permission denied for function replace_close_summaries/);
  });

  it('the catalogue agrees: authenticated and service_role, never anon', async () => {
    const holds = (role) => one(db,
      "select has_function_privilege($1, 'public.replace_close_summaries(uuid[], jsonb)', 'execute')", [role]);
    expect(await holds('anon')).toBe(false);
    expect(await holds('authenticated')).toBe(true);
    expect(await holds('service_role')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the browser reports a refusal instead of reading it as step 48 not having run', () => {
  it('replaceSupabaseCloseSummaries throws the database\'s own refusal', async () => {
    /* It swallows an error that names replace_close_summaries and says "does
     * not exist", "schema cache" or "could not find", because that is how
     * PostgREST reports a database without step 48. A refusal in those words
     * would leave a CAM believing a summary was saved. */
    const { error } = await callAs('authenticated', world.quinn, [world.grayMon], []);
    expect(error?.message).toMatch(REFUSED);
    rpcAnswer.current = { data: null, error: { code: error.code, message: error.message } };
    await expect(replaceSupabaseCloseSummaries([world.grayMon], [])).rejects.toThrow(error.message);

    /* The control, so the line above is not passing because everything throws:
     * the missing-function answer is still swallowed. */
    rpcAnswer.current = {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.replace_close_summaries in the schema cache' },
    };
    await expect(replaceSupabaseCloseSummaries([world.grayMon], [])).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a later re-run does not undo it', () => {
  it('step 48 carries the same function, character for character', () => {
    /* Re-running a file he is not sure landed is how Pedro uses this directory,
     * and step 48's `create or replace` would otherwise put the unscoped body
     * back without a word. */
    const here = FUNCTION.exec(raw)?.[0];
    const there = FUNCTION.exec(readFileSync(step48Url, 'utf8'))?.[0];
    expect(here).toBeTruthy();
    expect(there).toBe(here);
  });

  it('everything applied twice and step 48 run again on top: still refused, still working', async () => {
    const again = await startMigrationCluster(migrationFilesInOrder(), {
      applyTwice: true,
      reapply: ['step_48_close_summaries.sql'],
    });
    try {
      const ids = await seedWorld(again);
      const saved = db;
      db = again;
      try {
        const attack = await callAs('authenticated', ids.quinn, [ids.grayMon], []);
        expect(attack.error?.message).toMatch(REFUSED);
        expect(attack.summaries).toEqual(SEEDED);
        /* And the READ stays scoped. Step 48 also creates the table's first
         * policy, `using (true)`, which step 52 removes; recreated beside step
         * 52's it is OR'd with it and every CAM reads every row again. */
        const read = (subject) => rowsAsRole(again, 'authenticated',
          'select client_id from public.close_summaries', { subject });
        expect(await read(ids.idle)).toEqual([]);
        expect((await read(ids.quinn)).map((row) => row.client_id)).toEqual([ids.birch]);
        const upload = await callAs('authenticated', ids.peter, [ids.grayMon],
          uploadRows(ids.grayMon, ids.gray, '2026-10-01', 5));
        expect(upload.error).toBeNull();
        expect(upload.returned).toBe(2);
        expect(await refusalAsRole(again, 'anon',
          `select public.replace_close_summaries(array['${ids.grayMon}']::uuid[], '[]'::jsonb)`,
          { subject: null })).toMatch(/permission denied/);
      } finally {
        db = saved;
      }
    } finally {
      await again.close();
    }
  }, 180_000);
});
