// Step 60, asked of the database rather than read off the file.
//
// Every assertion that matters runs AS THE ROLE on a cluster carrying every
// migration in this directory (supabase/migrationCluster.js, Supabase's real
// default privileges): `authenticated` with request.jwt.claim.sub set to the
// CAM who holds the client, a CAM who does not, a Manager, an Inactive CAM and
// a signed-in stranger, and `anon` with no subject. A second cluster stopped at
// 59 replays the same statements and they SUCCEED there, so each refusal below
// is this file's doing and not a test that could never have failed.
//
// The writes that make up an attack are COMMITTED between statements, the way
// two PostgREST requests are, because a handoff is an insert in one request
// and a delete in the next.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrationFilesInOrder,
  one,
  refusalAsRole,
  rowsAsRole,
  startMigrationCluster,
} from './migrationCluster.js';

const migrationUrl = new URL('./step_60_client_handoff_manager_only.sql', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(new URL('./MIGRATIONS_TO_RUN.md', import.meta.url), 'utf8');
const step53 = readFileSync(new URL('./step_53_client_creation_under_rls.sql', import.meta.url), 'utf8');
const step57 = readFileSync(new URL('./step_57_algorithm_live_samples.sql', import.meta.url), 'utf8');

// Any policy refusing the row, and then the one this file adds, which a
// restrictive policy names in its message. A handoff refused by step 53's own
// permissive check would match the first and not the second.
const RLS_REFUSED = /new row violates row-level security policy (".*" )?for table "client_assignments"/;
const BY_60 = /row-level security policy "assignments: a cam assigns only a new client, to itself"/;
const DENIED = /permission denied for table client_assignments/;

let after;
let before;
let world;
let beforeWorld;

/** Runs one statement as `role` with `subject` signed in and KEEPS its effect. */
async function committed(db, subject, statement, params, role = 'authenticated') {
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

/** The same, returning the refusal instead of throwing. Nothing is kept on refusal. */
async function attempt(db, subject, statement, params) {
  try {
    return { rows: await committed(db, subject, statement, params), error: null };
  } catch (error) {
    return { rows: [], error: String(error.message || error) };
  }
}

async function seed(db) {
  const authUser = (email) => one(db, 'insert into auth.users (email) values ($1) returning id', [email]);
  async function cam(name, status = 'Active') {
    const profile = await one(db, 'insert into public.cam_profiles (name) values ($1) returning id', [name]);
    const auth = await authUser(`${name.toLowerCase()}@example.com`);
    const appUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id, cam_profile_id)
      values ($1, $1, $2, 'CAM', $3, $4, $5) returning id`, [name.toLowerCase(), `${name.toLowerCase()}@example.com`, status, auth, profile]);
    return { profile, auth, appUser };
  }
  const w = { clients: {}, devices: {} };
  w.gray = await cam('Gray');
  w.birch = await cam('Birch');
  w.gone = await cam('Gone', 'Inactive');
  w.managerAuth = await authUser('mgr@example.com');
  w.managerUser = await one(db, `insert into public.app_users (username, display_name, email, role, status, auth_user_id)
    values ('mgr', 'Mgr', 'mgr@example.com', 'Manager', 'Active', $1) returning id`, [w.managerAuth]);
  w.strangerAuth = await authUser('stranger@example.com');
  return w;
}

/**
 * A client the desk created, assigned to `owner` (or nobody), with a device
 * paired through the real enrollment and pairing functions under a code the
 * Manager issued: not created by any CAM, not enrolled by any CAM.
 */
async function deskClient(db, w, key, owner) {
  w.clients[key] = await one(db,
    "insert into public.clients (name, status, product_key) values ($1, 'Active', $2) returning id", [`Client ${key}`, `pk-${key}`]);
  if (owner) {
    await db.query("insert into public.client_assignments (client_id, cam_profile_id, assignment_role) values ($1, $2, 'Owner')",
      [w.clients[key], owner.profile]);
  }
  await db.query(
    `select * from public.create_ingest_enrollment($1, $2, $3, now() + interval '1 hour', false, 'generated', null)`,
    [w.clients[key], `code-${key}`, w.managerUser]);
  w.devices[key] = await one(db,
    `select device_id from public.pair_ingest_device_v2($1, $2, $3, $4, '1.2.0', '1.2.0')`,
    [`code-${key}`, `machine-${key}`, `credential-${key}`, `pfx-${key}`]);
  return w.clients[key];
}

/** createSupabaseClient, statement for statement, as `cam`. Returns the new id. */
async function camCreatesClient(db, cam, name, assignTo = cam.profile) {
  const [client] = await committed(db, cam.auth,
    `insert into public.clients (legacy_key, name, status, stage, full_name, notes, updated_at)
     values ($1, $2, 'Active', 'Active', $2, '', now()) returning *`, [`client-${name}`, name]);
  // PostgREST's merge-duplicates upsert: every payload column in the SET list.
  const assigned = await attempt(db, cam.auth,
    `insert into public.client_assignments (client_id, cam_profile_id, assignment_role) values ($1, $2, 'Owner')
     on conflict (client_id, cam_profile_id) do update
       set client_id = excluded.client_id, cam_profile_id = excluded.cam_profile_id,
           assignment_role = excluded.assignment_role`, [client.id, assignTo]);
  return { id: client.id, assignError: assigned.error };
}

/** transferSupabaseClient, statement for statement, as `subject`. */
async function transfer(db, subject, clientId, toProfile) {
  await committed(db, subject,
    "delete from public.client_assignments where client_id = $1 and assignment_role = 'Owner'", [clientId]);
  return committed(db, subject,
    `insert into public.client_assignments (client_id, cam_profile_id, assignment_role, assigned_at)
     values ($1, $2, 'Owner', now())
     on conflict (client_id, cam_profile_id) do update
       set client_id = excluded.client_id, cam_profile_id = excluded.cam_profile_id,
           assignment_role = excluded.assignment_role, assigned_at = excluded.assigned_at
     returning *`, [clientId, toProfile]);
}

async function holders(db, clientId) {
  return (await db.query('select cam_profile_id from public.client_assignments where client_id = $1 order by 1', [clientId]))
    .rows.map((row) => row.cam_profile_id);
}

async function assignedTo(db, cam) {
  return (await rowsAsRole(db, 'authenticated', 'select public.assigned_client_ids() as id', { subject: cam.auth }))
    .map((row) => row.id);
}

beforeAll(async () => {
  after = await startMigrationCluster(migrationFilesInOrder(), { applyTwice: true });
  world = await seed(after);
  before = await startMigrationCluster(migrationFilesInOrder({ upTo: 59 }));
  beforeWorld = await seed(before);
}, 180_000);

afterAll(async () => {
  await after?.close?.();
  await before?.close?.();
});

/* ── The file and the runbook ─────────────────────────────────────────────── */

describe('step 60 is the one that runs last', () => {
  it('is the highest number and appears once, and 54 is still a deliberate gap', () => {
    /* The claim moves here from 58, the way 55 handed it to 56, 56 to 57 and
     * 57 to 58: the newest step's own test says it is the newest. 59 is this
     * PR's other file. */
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 60)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(60);
    expect(numbers).not.toContain(54);
  });

  it('is in the runbook table after 59 and ends the run order', () => {
    expect(runbook).toMatch(/^\| 60 \| `step_60_client_handoff_manager_only\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 60 | `step_60_client_handoff_manager_only.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 59 | `step_59_log_algo_history_by_family.sql`'));
    expect(runbook).toContain('→ 59 → 60.');
  });

  it('step 53 and step 57 say what closed the holes they describe', () => {
    // A reader who finds 53's assignment policy first must not take it for the
    // whole rule, and 57's stated residual is no longer open.
    expect(step53).toContain('NARROWED BY STEP 60');
    expect(step57).toContain('CLOSED BY\n-- STEP 60');
  });
});

/* ── The defect, on a cluster stopped at 58 ───────────────────────────────── */

describe('before step 60: a CAM moves clients between books', () => {
  it('A. hands a client she holds to another CAM and removes herself', async () => {
    const g = await deskClient(before, beforeWorld, 'BA', beforeWorld.gray);
    expect((await attempt(before, beforeWorld.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [g, beforeWorld.birch.profile])).error)
      .toBeNull();
    expect((await attempt(before, beforeWorld.gray.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning id', [g, beforeWorld.gray.profile])).rows)
      .toHaveLength(1);
    expect(await holders(before, g)).toEqual([beforeWorld.birch.profile]);
  });

  it('C. takes back a client she created after a Manager moved it, and removes the new holder', async () => {
    const created = await camCreatesClient(before, beforeWorld.gray, 'Before C');
    expect(created.assignError).toBeNull();
    await transfer(before, beforeWorld.managerAuth, created.id, beforeWorld.birch.profile);
    expect((await attempt(before, beforeWorld.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [created.id, beforeWorld.gray.profile])).error)
      .toBeNull();
    expect((await attempt(before, beforeWorld.gray.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning id', [created.id, beforeWorld.birch.profile])).rows)
      .toHaveLength(1);
    expect(await holders(before, created.id)).toEqual([beforeWorld.gray.profile]);
  });
});

/* ── After: what a CAM may still do ───────────────────────────────────────── */

describe('after step 60: the CAM flow the product has keeps working', () => {
  it('a CAM creates a client and assigns it to herself with the browser\'s exact statements', async () => {
    const created = await camCreatesClient(after, world.gray, 'Gray New');
    expect(created.assignError).toBeNull();
    expect(await holders(after, created.id)).toEqual([world.gray.profile]);
    expect(await assignedTo(after, world.gray)).toContain(created.id);
    // And reads it back, and its assignment row.
    const rows = await rowsAsRole(after, 'authenticated',
      'select cam_profile_id from public.client_assignments where client_id = $1', { subject: world.gray.auth, params: [created.id] });
    expect(rows).toEqual([{ cam_profile_id: world.gray.profile }]);
  });

  it('a CAM reads the assignment rows of the clients she holds and of no one else\'s', async () => {
    const mine = await deskClient(after, world, 'R1', world.gray);
    const theirs = await deskClient(after, world, 'R2', world.birch);
    const rows = await rowsAsRole(after, 'authenticated',
      'select client_id from public.client_assignments where client_id = any($1)', { subject: world.gray.auth, params: [[mine, theirs]] });
    expect(rows.map((row) => row.client_id)).toEqual([mine]);
  });
});

/* ── After: every handoff a CAM could make ────────────────────────────────── */

describe('after step 60: a CAM cannot move a client between books', () => {
  it('A. cannot hand a client she holds to another CAM', async () => {
    const g = await deskClient(after, world, 'A1', world.gray);
    expect((await attempt(after, world.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [g, world.birch.profile])).error)
      .toMatch(BY_60);
    expect(await holders(after, g)).toEqual([world.gray.profile]);
  });

  it('A. cannot remove herself from a client she holds', async () => {
    const g = await deskClient(after, world, 'A2', world.gray);
    const dropped = await attempt(after, world.gray.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning id', [g, world.gray.profile]);
    expect(dropped).toEqual({ rows: [], error: null });
    expect(await holders(after, g)).toEqual([world.gray.profile]);
    expect(await assignedTo(after, world.gray)).toContain(g);
  });

  it('A. cannot rewrite her row to name another CAM', async () => {
    const g = await deskClient(after, world, 'A3', world.gray);
    const moved = await attempt(after, world.gray.auth,
      'update public.client_assignments set cam_profile_id = $2 where client_id = $1 returning id', [g, world.birch.profile]);
    expect(moved.rows).toEqual([]);
    expect(await holders(after, g)).toEqual([world.gray.profile]);
  });

  it('cannot assign a client she just created to another CAM', async () => {
    const created = await camCreatesClient(after, world.gray, 'Gray For Birch', world.birch.profile);
    expect(created.assignError).toMatch(BY_60);
    expect(await holders(after, created.id)).toEqual([]);
  });

  it('B. cannot assign herself a client she does not hold', async () => {
    const b = await deskClient(after, world, 'B1', world.birch);
    expect((await attempt(after, world.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [b, world.gray.profile])).error)
      .toMatch(RLS_REFUSED);
  });

  it('C. cannot take back a client she created once a Manager moved it, nor see where it went', async () => {
    const created = await camCreatesClient(after, world.gray, 'Gray Moved');
    expect(created.assignError).toBeNull();
    const moved = await transfer(after, world.managerAuth, created.id, world.birch.profile);
    expect(moved).toHaveLength(1);
    expect(await rowsAsRole(after, 'authenticated',
      'select cam_profile_id from public.client_assignments where client_id = $1', { subject: world.gray.auth, params: [created.id] }))
      .toEqual([]);
    expect((await attempt(after, world.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [created.id, world.gray.profile])).error)
      .toMatch(BY_60);
    expect((await attempt(after, world.gray.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning id', [created.id, world.birch.profile])).rows)
      .toEqual([]);
    expect(await holders(after, created.id)).toEqual([world.birch.profile]);
  });

  it('the CAM who now holds it cannot hand it on either', async () => {
    const created = await camCreatesClient(after, world.gray, 'Gray To Birch');
    await transfer(after, world.managerAuth, created.id, world.birch.profile);
    expect((await attempt(after, world.birch.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [created.id, world.gray.profile])).error)
      .toMatch(BY_60);
    expect((await attempt(after, world.birch.auth,
      'delete from public.client_assignments where client_id = $1 returning id', [created.id])).rows).toEqual([]);
  });
});

/* ── The runbook's own check, run as a CAM ────────────────────────────────── */

describe('the verification the runbook gives Pedro', () => {
  it('its insert, as a CAM holding a client, is refused by this file\'s policy', async () => {
    /* Copied out of MIGRATIONS_TO_RUN.md rather than retyped, so the snippet
     * Pedro pastes is the one that was run. */
    const snippet = /insert into public\.client_assignments \(client_id, cam_profile_id\)\n[\s\S]*?limit 1;/.exec(runbook);
    expect(snippet, 'the runbook snippet moved').toBeTruthy();
    const statement = snippet[0].replace(/^ {4}/gm, '');
    await deskClient(after, world, 'V1', world.gray);
    expect((await attempt(after, world.gray.auth, statement)).error).toMatch(BY_60);
    expect(await holders(after, world.clients.V1)).toEqual([world.gray.profile]);
  });
});

/* ── After: the other roles ───────────────────────────────────────────────── */

describe('after step 60: Manager, Inactive CAM, stranger, anon', () => {
  it('a Manager still transfers, assigns, updates and deletes any row', async () => {
    const c = await deskClient(after, world, 'M1', world.gray);
    expect(await transfer(after, world.managerAuth, c, world.birch.profile)).toHaveLength(1);
    expect(await holders(after, c)).toEqual([world.birch.profile]);
    await committed(after, world.managerAuth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [c, world.gray.profile]);
    expect((await committed(after, world.managerAuth,
      "update public.client_assignments set assignment_role = 'Coverage' where client_id = $1 and cam_profile_id = $2 returning id",
      [c, world.gray.profile]))).toHaveLength(1);
    expect((await committed(after, world.managerAuth,
      'delete from public.client_assignments where client_id = $1 returning id', [c]))).toHaveLength(2);
  });

  it('an Inactive CAM cannot assign even a client she created', async () => {
    const created = await camCreatesClient(after, world.gone, 'Gone New', world.gone.profile);
    expect(created.assignError).toMatch(BY_60);
  });

  it('a signed-in stranger reads nothing and writes nothing', async () => {
    const c = await deskClient(after, world, 'S1', world.gray);
    expect(await rowsAsRole(after, 'authenticated', 'select * from public.client_assignments', { subject: world.strangerAuth }))
      .toEqual([]);
    expect(await refusalAsRole(after, 'authenticated',
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)',
      { subject: world.strangerAuth, params: [c, world.birch.profile] })).toMatch(RLS_REFUSED);
  });

  it('anon is refused at the grant', async () => {
    expect(await refusalAsRole(after, 'anon', 'select * from public.client_assignments', { subject: null })).toMatch(DENIED);
  });
});

/* ── The reason this mattered: step 57's desk figure ──────────────────────── */

describe('the ingest residual step 57 names', () => {
  /* A VPS paired under SOMEONE ELSE'S code for a client assigned to Gray: the
   * device credential lives on the machine. Handing the client to Birch put it
   * outside every set algorithm_live_desk() leaves out for Gray, so its
   * readings counted as the rest of the desk: with four genuine outside
   * accounts, hers made the fifth that met the floor. */
  const TEN_MINUTES = 600_000;

  async function readings(db, w, keys, ownKey) {
    await db.exec('delete from public.algorithm_live_samples');
    const cycle = new Date(Math.floor(Date.now() / TEN_MINUTES) * TEN_MINUTES - TEN_MINUTES);
    const sampled = new Date(cycle.getTime() + 2000);
    for (const [i, key] of [...keys, ownKey].entries()) {
      await db.query(
        `insert into public.algorithm_live_samples (device_id, client_id, account_name, strategy_id, strategy_name,
           algorithm, instrument, instrument_root, realized_pnl, unrealized_pnl, sampled_at, cycle_start)
         values ($1, $2, $3, $4, '0 - OGX_PF-1.0', 'OGX_PF', 'MNQ 12-26', 'MNQ', $5, 0, $6, $7)`,
        [w.devices[key], w.clients[key], `ACC-${key}`, `id-${key}`, -100 * (i + 1), sampled.toISOString(), cycle.toISOString()]);
    }
  }

  async function grayCohort(db, w) {
    const rows = await rowsAsRole(db, 'authenticated', 'select * from public.algorithm_live_desk()', { subject: w.gray.auth });
    return rows.find((row) => row.algorithm === 'OGX_PF' && row.instrument_root === 'MNQ');
  }

  async function scenario(db, w) {
    for (const key of ['O1', 'O2', 'O3']) await deskClient(db, w, key, w.birch);
    await deskClient(db, w, 'O4', null);
    // Assigned to Gray, paired under the MANAGER's code: not created by Gray,
    // not enrolled by her.
    await deskClient(db, w, 'P1', w.gray);
    expect(await one(db, 'select created_by from public.ingest_enrollments where client_id = $1', [w.clients.P1]))
      .toBe(w.managerUser);
    const handed = await attempt(db, w.gray.auth,
      'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [w.clients.P1, w.birch.profile]);
    const dropped = await attempt(db, w.gray.auth,
      'delete from public.client_assignments where client_id = $1 and cam_profile_id = $2 returning id', [w.clients.P1, w.gray.profile]);
    await readings(db, w, ['O1', 'O2', 'O3', 'O4'], 'P1');
    return { handed, dropped, cohort: await grayCohort(db, w) };
  }

  it('before 60: Gray hands the client away and her own readings meet the floor', async () => {
    const { handed, dropped, cohort } = await scenario(before, beforeWorld);
    expect(handed.error).toBeNull();
    expect(dropped.rows).toHaveLength(1);
    expect(cohort).toMatchObject({ status: 'compared', n_accounts: 5, n_clients: 5 });
  });

  it('after 60: the handoff is refused, the client stays in her book, and the cohort is thin', async () => {
    const { handed, dropped, cohort } = await scenario(after, world);
    expect(handed.error).toMatch(BY_60);
    expect(dropped.rows).toEqual([]);
    expect(await assignedTo(after, world.gray)).toContain(world.clients.P1);
    expect(cohort).toMatchObject({ status: 'thin', n_accounts: null });
  });
});

/* ── It stays closed when the files that wrote the old policy run again ───── */

describe('step 60 survives a re-run of steps 52 and 53', () => {
  async function rerunCluster(reapply) {
    const db = await startMigrationCluster(migrationFilesInOrder(), { reapply });
    const w = await seed(db);
    return { db, w };
  }

  it('re-running 52 then 53: the CAM flow works and the handoff is still refused', async () => {
    const { db, w } = await rerunCluster(['step_52_rls_by_cam.sql', 'step_53_client_creation_under_rls.sql']);
    try {
      const created = await camCreatesClient(db, w.gray, 'Rerun New');
      expect(created.assignError).toBeNull();
      expect((await attempt(db, w.gray.auth,
        'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [created.id, w.birch.profile])).error)
        .toMatch(BY_60);
      expect((await attempt(db, w.gray.auth,
        'delete from public.client_assignments where client_id = $1 returning id', [created.id])).rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 120_000);

  it('re-running 52 alone, whose loop drops every permissive policy on the table: still refused', async () => {
    const { db, w } = await rerunCluster(['step_52_rls_by_cam.sql']);
    try {
      const g = await deskClient(db, w, 'Q1', w.gray);
      expect((await attempt(db, w.gray.auth,
        'insert into public.client_assignments (client_id, cam_profile_id) values ($1, $2)', [g, w.birch.profile])).error)
        .toMatch(BY_60);
      expect((await attempt(db, w.gray.auth,
        'delete from public.client_assignments where client_id = $1 returning id', [g])).rows).toEqual([]);
      expect(await holders(db, g)).toEqual([w.gray.profile]);
    } finally {
      await db.close();
    }
  }, 120_000);
});

/* ── What the file says, read only where a behaviour cannot say it ────────── */

describe('the statements', () => {
  it('every policy it creates is restrictive, and it creates four', () => {
    const policies = [...sql.matchAll(/create policy[\s\S]*?;/gi)].map((m) => m[0].toLowerCase());
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(policy).toContain('on public.client_assignments');
      expect(policy).toContain('as restrictive');
    }
  });

  it('drops no permissive policy: step 53\'s stays as the gate on which clients', () => {
    expect(flat).not.toMatch(/drop policy if exists "cam sees its own clients"/);
    expect(flat).not.toMatch(/permissive = 'permissive' loop/);
  });

  it('the profile helper is a pinned security definer, callable only when signed in', () => {
    const body = /create or replace function public\.my_cam_profile_id\(\)[\s\S]*?\$function\$/i.exec(sql);
    expect(body).toBeTruthy();
    expect(body[0].toLowerCase()).toContain('security definer');
    expect(body[0].toLowerCase()).toContain('set search_path = pg_catalog, public');
    expect(flat).toContain('revoke all on function public.my_cam_profile_id() from public, anon, authenticated');
    expect(flat).toContain('grant execute on function public.my_cam_profile_id() to authenticated');
  });

  it('writes no row and drops no table', () => {
    const statements = flat.replace(/'(?:[^']|'')*'/g, "''");
    expect(statements).not.toMatch(/\bdrop table\b|\bdelete from\b|\btruncate\b/);
    expect(statements).not.toMatch(/\bupdate public\.\w+ set\b/);
  });
});
