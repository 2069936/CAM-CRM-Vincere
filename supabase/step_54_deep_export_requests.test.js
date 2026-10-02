// Step 54 is the one whose mistakes nobody would see for weeks.
//
// Everything it creates is dormant: no route calls it, no agent knows it exists,
// and a mistake in it therefore produces no error anywhere until the routes land
// on top of it and start behaving strangely on one machine out of thirty. The
// shape of the SQL is asserted here rather than trusted, in the way step 45's and
// step 52's tests assert theirs, and for the same reason - these are the files
// where a silent wrong answer is cheaper to write than a loud one.
//
// Six properties carry the whole design and each has a test below:
//   - the probe comes before the settings read, the lock and the writes, because
//     the cost of this feature on an ordinary day is one index probe per machine
//     per minute and nothing else;
//   - the window gate returns 'none' and does NOT burn an offer, which is what
//     lets a request sit through a trading afternoon for free;
//   - a live lease held by somebody else is 'busy', never a second offer;
//   - the ack is rejected unless the row is offered, belongs to this device and
//     the lease token matches, so a replay cannot be a second accept;
//   - a deferral releases the lease and leaves offer_count alone, so a busy
//     machine can decline all week without being failed;
//   - storage_path is coalesced, so a re-offer reuses the path and `upsert:
//     false` stays meaningful.
//
// AND THE ONE THING THIS FILE IS NOT ALLOWED TO DO: touch
// record_ingest_heartbeat. It is `returns table (...)`, so widening it means
// dropping and recreating the function the whole fleet calls once a minute. There
// is a test for the absence.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { one, refusal, startMigrationCluster } from './migrationCluster.js';

const migrationUrl = new URL('./step_54_deep_export_requests.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';

/* The executable half. This file's header argues at length about pulling rather
 * than pushing, about why the claim is a separate function, and about what a
 * deferral is not - and an assertion about the statements must never be satisfied
 * by that prose. Three tests in this repo have already passed against a comment. */
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

const claim = (() => {
  const match = /create or replace function public\.claim_deep_export_request\(([\s\S]*?)\$function\$;/i.exec(sql);
  return match ? match[0] : '';
})();
const finalize = (() => {
  const match = /create or replace function public\.finalize_deep_export_request\(([\s\S]*?)\$function\$;/i.exec(sql);
  return match ? match[0] : '';
})();

describe('step 54 is the one that runs last', () => {
  it('is the highest number and appears once', () => {
    /* 47 WAS ALREADY TAKEN, which is the mistake this assertion would have
     * caught: the accepted design calls this migration step_47, and
     * step_47_strategy_ran.sql has existed since PR #10's runbook was written.
     * Two files claiming one number means whichever ran second looked like it had
     * run. */
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 54)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(54);
  });

  it('is in the runbook table and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 54 \| `step_54_deep_export_requests\.sql` \|.*\|$/m);
    expect(runbook).toContain('→ 53 → 54.');
  });

  it('runs as one transaction, like step 46', () => {
    expect(flat.trimStart().startsWith('begin;')).toBe(true);
    expect(flat).toContain('commit;');
  });
});

describe('what it must not touch', () => {
  it('does not redefine record_ingest_heartbeat, or drop any function', () => {
    /* The reason is in the header: it is `returns table (...)`, so a widened
     * version has to be dropped and recreated, and that is the one function every
     * machine in the fleet calls once a minute. A bug inside it is fleet silence,
     * which step 46 already paid to learn. */
    expect(flat).not.toContain('record_ingest_heartbeat');
    expect(flat).not.toContain('drop function');
  });

  it('does not alter ingest_devices, ingest_batches or clients', () => {
    // The request lives in its own table, not in ingest_devices.metadata, where
    // record_ingest_heartbeat rewrites four keys on every beat and the throttle
    // reads the same four back.
    expect(flat).not.toMatch(/alter table public\.ingest_(devices|batches)/);
    expect(flat).not.toMatch(/alter table public\.clients/);
  });

  it('touches no existing bucket', () => {
    expect(flat).not.toContain("'ninjatrader-imports'");
  });
});

describe('every tunable is a column, because the alternative is not available', () => {
  it('the settings table exists and is a singleton on step 45\'s model', () => {
    expect(flat).toContain('create table if not exists public.ingest_deep_export_settings (');
    expect(flat).toContain('id boolean primary key default true');
    expect(flat).toContain('constraint ingest_deep_export_settings_singleton check (id)');
    expect(flat).toContain('insert into public.ingest_deep_export_settings (id) values (true) on conflict (id) do nothing');
  });

  it('carries all five decisions, each with the decided default', () => {
    // 5. the quiet window: 17:15-18:00 New York, any time at weekends, and a
    //    manager-only run now beside it.
    expect(flat).toContain('window_start_minute integer not null default 1035');
    expect(flat).toContain('window_end_minute integer not null default 1080');
    expect(flat).toContain('weekend_any_time boolean not null default true');
    expect(flat).toContain('run_now_requires_manager boolean not null default true');
    // 4. a machine offline: 72 hours, then it says so.
    expect(flat).toContain('request_ttl_hours integer not null default 72');
    // 2 and 3. a CAM may request (off for stage 1), only a manager may download.
    expect(flat).toContain('cam_may_request boolean not null default false');
    expect(flat).toContain('download_requires_manager boolean not null default true');
    // 1. newest 3 per device, nothing past 30 days.
    expect(flat).toContain('retain_per_device integer not null default 3');
    expect(flat).toContain('retain_days integer not null default 30');
  });

  it('1035 and 1080 really are 17:15 and 18:00', () => {
    // The one place the window is a number rather than a time, so the arithmetic
    // is worth stating once in a test rather than trusting twice in a comment.
    expect(17 * 60 + 15).toBe(1035);
    expect(18 * 60).toBe(1080);
  });

  it('the lease is shorter than the signed upload token it has to fit inside', () => {
    // The token's two hours are fixed by the storage SDK and not configurable.
    // A lease longer than the token means a machine holding a claim on a URL that
    // has already died.
    expect(flat).toContain('lease_seconds integer not null default 5400');
    expect(5400).toBeLessThan(2 * 60 * 60);
    expect(flat).toContain('check (lease_seconds between 300 and 7200)');
  });

  it('bounds every number it reads, so a bad UPDATE is refused at the door', () => {
    /* This table is edited by hand in the SQL editor, which is the whole point of
     * it, so the constraints are the only review a change gets. */
    expect(flat).toContain('and window_end_minute > window_start_minute');
    expect(flat).toContain('check (request_ttl_hours between 1 and 720)');
    expect(flat).toContain('check (max_offers between 1 and 50)');
    expect(flat).toContain('check (retain_per_device between 1 and 50 and retain_days between 1 and 3650)');
    expect(flat).toContain('check (max_bytes between 1048576 and 536870912');
  });

  it('nothing in the file reads process.env or a GUC instead', () => {
    expect(flat).not.toContain('current_setting');
  });
});

describe('the request row, and the index that makes it one', () => {
  it('one open request per device is a unique index and not a route', () => {
    /* Step 28 settles the same race for enrollments with the same partial index.
     * Two managers clicking in the same second is a race, and a unique index is
     * the only place to settle it. */
    expect(flat).toContain('create unique index if not exists idx_deep_export_one_open_per_device on public.ingest_deep_export_requests(device_id) where status in (\'open\', \'offered\')');
  });

  it('keeps who asked twice, because created_by is set null on delete', () => {
    expect(flat).toContain('created_by uuid references public.app_users(id) on delete set null');
    expect(flat).toContain("created_by_email text not null check (created_by_email <> '')");
  });

  it('requires a reason, bounded', () => {
    expect(flat).toContain('reason text not null check (char_length(reason) between 3 and 200)');
  });

  it('names the whole life of a request on one row', () => {
    for (const column of [
      'status', 'expires_at', 'offered_at', 'offer_count', 'deferral_count',
      'last_deferral_code', 'lease_token', 'lease_expires_at', 'storage_path',
      'uploaded_at', 'content_sha256', 'byte_count', 'duration_ms',
      'warning_count', 'failure_code', 'revoked_at', 'revoked_by', 'created_at',
    ]) {
      expect(flat, `${column} is missing from the request row`).toContain(column);
    }
  });

  it('counts deferrals apart from offers, which is the point of having both', () => {
    expect(flat).toContain('offer_count integer not null default 0 check (offer_count >= 0)');
    expect(flat).toContain('deferral_count integer not null default 0 check (deferral_count >= 0)');
  });

  it('cannot be created already expired', () => {
    expect(flat).toContain('check (expires_at > created_at)');
  });
});

describe('claim_deep_export_request, in the order its steps have to be in', () => {
  it('exists, returns jsonb, runs as definer and pins search_path', () => {
    expect(claim).toBeTruthy();
    expect(claim.toLowerCase()).toContain('returns jsonb');
    expect(claim.toLowerCase()).toContain('security definer');
    expect(claim.toLowerCase()).toContain('set search_path = pg_catalog, public');
  });

  it('probes the partial index BEFORE the settings read, the lock and any write', () => {
    /* THE COST OF THE WHOLE FEATURE IS THIS ORDERING. Thirty machines beating
     * once a minute is 43,200 calls a day, essentially all of which have nothing
     * to collect. If the settings read or the advisory lock came first, every one
     * of those would take a row lock on a table the desk also uses. */
    const body = claim.toLowerCase();
    const probe = body.indexOf('if not exists (');
    const settings = body.indexOf('from public.ingest_deep_export_settings');
    const lock = body.indexOf('pg_advisory_xact_lock');
    const sweep = body.indexOf('update public.ingest_deep_export_requests');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(settings);
    expect(probe).toBeLessThan(lock);
    expect(probe).toBeLessThan(sweep);
    // And the probe reads the index, which means those two statuses and no others.
    const probeStatement = body.slice(probe, body.indexOf(')', body.indexOf('outcome', probe)));
    expect(probeStatement).toContain("status in ('open', 'offered')");
  });

  it('walks client -> device -> request with for update, in that order', () => {
    const body = claim.toLowerCase();
    const client = body.indexOf('from public.clients as client');
    const device = body.indexOf('from public.ingest_devices as device\n  where device.id = p_device_id\n  for update');
    const request = body.indexOf('from public.ingest_deep_export_requests as request\n  where request.device_id = p_device_id');
    expect(client).toBeGreaterThan(-1);
    expect(device).toBeGreaterThan(client);
    expect(request).toBeGreaterThan(device);
    expect((body.match(/for update/g) || []).length).toBe(3);
  });

  it('refuses a device that is not active or has been revoked', () => {
    expect(claim.toLowerCase()).toContain("v_device.status is distinct from 'active'");
    expect(claim.toLowerCase()).toContain('v_device.revoked_at is not null');
  });

  it('writes nothing before the advisory lock, which is the lock order', () => {
    /* THE SHAPE OF A DEADLOCK THAT HAPPENED. The expiry used to sit above the
     * lock, and an expiry is an UPDATE: tuple lock first, advisory lock second,
     * against a finalize that takes them the other way round. 33 of 40
     * synchronised rounds aborted with 40P01 and 15 of them lost a finished
     * export. This assertion is a reminder, not the proof - the proof is
     * scripts/race-deep-export-lock-order.sh, run against a real cluster. */
    const body = claim.toLowerCase();
    const lock = body.indexOf('pg_advisory_xact_lock');
    for (const write of ['update public.', 'insert into public.', 'delete from public.']) {
      const first = body.indexOf(write);
      if (first === -1) continue;
      expect(first, `a ${write.trim()} happens before the advisory lock`).toBeGreaterThan(lock);
    }
  });

  it('expires on two clocks, so a live lease is not collected and a dead one is', () => {
    /* The behaviour is asserted by running the function further down this file.
     * This is here because the predicate is the whole fix and it is one line. */
    expect(claim.toLowerCase()).toContain("set status = 'expired'");
    expect(claim.toLowerCase()).toContain('v_request.expires_at <= v_now');
    expect(claim.toLowerCase()).toContain('v_request.lease_expires_at <= v_now');
  });

  it('the window gate returns none and never touches offer_count', () => {
    /* THIS IS THE ONE THAT MAKES max_offers = 5 SAFE. If an out-of-window beat
     * burned an offer, a request made at 10am would be dead by lunchtime having
     * never been attempted once. */
    const gate = /if v_request\.run_mode <> 'now' then([\s\S]*?)end if;/i.exec(claim);
    expect(gate, 'the window gate is missing').toBeTruthy();
    expect(gate[1]).toContain("'outcome', 'none'");
    expect(gate[1].toLowerCase()).not.toContain('offer_count');
    expect(gate[1].toLowerCase()).not.toContain('update');
  });

  it('reads the window in the DEVICE\'s timezone, not the server\'s', () => {
    expect(claim.toLowerCase()).toContain('at time zone');
    expect(claim.toLowerCase()).toContain('v_device.schedule_timezone');
  });

  it('treats Saturday and Sunday as the weekend by isodow', () => {
    expect(claim.toLowerCase()).toContain('extract(isodow from v_local)::integer >= 6');
  });

  it("run_mode 'now' is the only thing that skips the window", () => {
    expect(claim).toContain("if v_request.run_mode <> 'now' then");
  });

  it('answers busy on a live lease held by another token, with a retry-after', () => {
    const body = claim.toLowerCase();
    expect(body).toContain('v_request.lease_expires_at > v_now');
    expect(body).toContain('v_request.lease_token is distinct from p_lease_token');
    expect(body).toContain("'outcome', 'busy'");
    expect(body).toContain('retry_after_seconds');
  });

  it('fails visibly at the offer limit, recording the real reason', () => {
    expect(claim.toLowerCase()).toContain('v_request.offer_count >= v_settings.max_offers');
    expect(claim.toLowerCase()).toContain("coalesce(nullif(btrim(v_request.last_deferral_code), ''), 'offer_limit')");
  });

  it('coalesces storage_path, so a re-offer cannot move the object', () => {
    /* `upsert: false` on the signed upload URL is only one-shot if the path is
     * stable across re-offers. A path recomputed per offer would make the storage
     * layer's own guarantee vacuous. */
    expect(claim.toLowerCase()).toContain('v_storage_path := coalesce(');
    expect(claim).toContain("v_request.client_id::text || '/' || v_request.id::text || '.zip'");
  });

  it('hands the agent the limits it is expected to obey', () => {
    expect(claim.toLowerCase()).toContain("'max_bytes', v_settings.max_bytes");
    expect(claim.toLowerCase()).toContain("'min_free_disk_bytes', v_settings.min_free_disk_bytes");
  });

  it('is granted to service_role and to nobody else', () => {
    expect(flat).toContain('revoke all on function public.claim_deep_export_request(uuid, uuid, integer, timestamptz) from public, anon, authenticated');
    expect(flat).toContain('grant execute on function public.claim_deep_export_request(uuid, uuid, integer, timestamptz) to service_role');
  });
});

describe('finalize_deep_export_request, and why a replay is not a second accept', () => {
  it('exists, runs as definer and pins search_path', () => {
    expect(finalize).toBeTruthy();
    expect(finalize.toLowerCase()).toContain('security definer');
    expect(finalize.toLowerCase()).toContain('set search_path = pg_catalog, public');
  });

  it('accepts exactly three outcomes', () => {
    expect(finalize.toLowerCase()).toContain("p_outcome not in ('uploaded', 'deferred', 'failed')");
  });

  it('takes the same advisory lock as the claim, on the same key', () => {
    const key = "pg_advisory_xact_lock(hashtextextended(p_device_id::text || ':deep-export', 0))";
    expect(claim).toContain(key);
    expect(finalize).toContain(key);
  });

  it('rejects unless the row is offered, is this device\'s, and the token matches', () => {
    const body = finalize.toLowerCase();
    expect(body).toContain('v_request.device_id is distinct from p_device_id');
    expect(body).toContain("v_request.status is distinct from 'offered'");
    expect(body).toContain('v_request.lease_token is distinct from p_lease_token');
    expect(body).toContain('deep_export_not_claimable');
  });

  it('a revoked request therefore cannot be acked, which is what makes the stop button work', () => {
    /* There is no separate check for 'revoked' and there must not be one: revoke
     * sets status, and the single `status is distinct from 'offered'` test is what
     * makes a mid-flight stop actually stop. A second statement of it is a second
     * thing to forget. */
    expect(finalize.toLowerCase()).not.toContain("= 'revoked'");
    expect(flat).toContain("'revoked'");
  });

  it('a deferral releases the lease, counts itself, and leaves offer_count alone', () => {
    const deferral = /elsif p_outcome = 'deferred' then([\s\S]*?)else/i.exec(finalize);
    expect(deferral, 'the deferral branch is missing').toBeTruthy();
    expect(deferral[1]).toContain("status = 'open'");
    expect(deferral[1]).toContain('deferral_count = deferral_count + 1');
    expect(deferral[1]).toContain('lease_token = null');
    expect(deferral[1].toLowerCase()).not.toContain('offer_count');
  });

  it('every terminal branch releases the lease', () => {
    expect((finalize.match(/lease_token = null/g) || []).length).toBe(3);
    expect((finalize.match(/lease_expires_at = null/g) || []).length).toBe(3);
  });

  it('an upload must carry a real digest and a positive size', () => {
    expect(finalize).toContain("p_content_sha256 !~ '^[0-9a-f]{64}$'");
    expect(finalize.toLowerCase()).toContain('p_byte_count <= 0');
  });

  it('refuses a package larger than the desk\'s own limit', () => {
    expect(finalize.toLowerCase()).toContain('p_byte_count > v_settings.max_bytes');
    expect(finalize).toContain('deep_export_too_large');
  });

  it('checks a code for SHAPE and not against a list', () => {
    /* An ack rejected because the CRM has not heard of a failure code is the worst
     * failure mode available: the request stays offered, the lease expires, it is
     * re-offered, and five rounds later it fails as offer_limit with the real
     * reason discarded. */
    expect(finalize).toContain("v_code !~ '^[a-z][a-z0-9_]{0,59}$'");
    expect(finalize.toLowerCase()).not.toContain("'window_closed'");
    expect(finalize.toLowerCase()).not.toContain("'database_missing'");
  });

  it('insists on a code for the two outcomes that mean something went wrong', () => {
    expect(finalize.toLowerCase()).toContain("p_outcome in ('deferred', 'failed') and v_code is null");
  });

  it('is granted to service_role and to nobody else', () => {
    expect(flat).toContain('from public, anon, authenticated');
    expect(flat).toContain('grant execute on function public.finalize_deep_export_request( uuid, uuid, uuid, text, text, bigint, integer, integer, text, timestamptz ) to service_role');
  });
});

describe('the bucket, which inherits nothing', () => {
  it('is its own bucket and it is private', () => {
    expect(flat).toContain("values ('ninjatrader-deep-exports', 'ninjatrader-deep-exports', false, 536870912, array['application/zip'])");
    expect(flat).toContain('set name = excluded.name, public = false');
  });

  it('states its own size and mime limits, because the existing bucket states neither', () => {
    /* step_28 created `ninjatrader-imports` with only id, name and public, so it
     * inherits a project-wide ceiling written down nowhere in this repository. For
     * a 3 KB JSON that did not matter; for a package up to a quarter of a
     * gigabyte it is the whole question. */
    expect(flat).toContain('file_size_limit');
    expect(flat).toContain('allowed_mime_types');
  });

  it('is a backstop above the agent\'s own refusal, not equal to it', () => {
    // Equal limits turn an off-by-one into an opaque storage error instead of a
    // readable failure code.
    expect(536870912).toBeGreaterThan(268435456);
  });

  it('carries its own copy of step 28\'s restrictive policy, because that one names its bucket literally', () => {
    expect(flat).toContain('create policy "ninjatrader-deep-exports deny browser direct access" on storage.objects as restrictive for all to anon, authenticated');
    expect(flat).toContain("using (bucket_id <> 'ninjatrader-deep-exports')");
    expect(flat).toContain("with check (bucket_id <> 'ninjatrader-deep-exports')");
  });

  it('creates the policy only when it is absent, so a second run is a no-op', () => {
    expect(flat).toContain("where schemaname = 'storage' and tablename = 'objects' and policyname = 'ninjatrader-deep-exports deny browser direct access'");
  });
});

describe('row level security, which step 43 cannot have covered', () => {
  it('both tables have it enabled and their privileges revoked', () => {
    expect(flat).toContain('alter table public.ingest_deep_export_requests enable row level security');
    expect(flat).toContain('alter table public.ingest_deep_export_settings enable row level security');
    expect(flat).toContain('revoke all on table public.ingest_deep_export_requests from public, anon, authenticated');
    expect(flat).toContain('revoke all on table public.ingest_deep_export_settings from public, anon, authenticated');
  });

  it('each has exactly one restrictive deny-the-browser policy', () => {
    expect((flat.match(/as restrictive for all to anon, authenticated using \(false\) with check \(false\)/g) || []).length).toBe(2);
  });

  it('ends with the same no-open-table check steps 43 to 46 end with', () => {
    expect(flat).toContain("select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity");
    expect(flat).toContain('step 54 left % table(s) without row level security');
  });

  it('runs that check AFTER the commit, so a failure does not roll the migration back', () => {
    // Steps 43 to 46 all do this: the check is a report on what was left, not a
    // condition of the work landing.
    expect(flat.indexOf('and not rowsecurity')).toBeGreaterThan(flat.indexOf('commit;'));
  });
});

/* ===========================================================================
 * AND NOW THE HALF THAT RUNS THE SQL.
 *
 * Everything above asserts the text of the file. That is cheap, it is fast, and
 * it is not enough: the window gate's upper bound was changed from `<` to `<=`
 * - which opens the quiet window a full minute wider, measured against a real
 * database - and every one of the fifty-three assertions above passed. This repo
 * has now shipped four tests that passed against a comment, and the answer is
 * not a fifth assertion about an operator. It is to call the function.
 *
 * `startMigrationCluster` boots PostgreSQL 18 in process (PGlite, WebAssembly;
 * `npm ci` is the whole installation), creates the objects step 54 expects to
 * find, and applies the migration file as it stands on disk - twice, because
 * Pedro re-runs a step he is not sure landed. Every assertion below is on what
 * the function ANSWERED and what the row says afterwards.
 *
 * WHAT IS NOT PROVED HERE. PGlite is one connection, so nothing below says
 * anything about two sessions racing. Lock order, deadlocks and simultaneous
 * beats are proved against a real multi-process cluster by
 * scripts/race-deep-export-lock-order.sh, which needs a server and is run by
 * hand.
 * ======================================================================== */

const CLIENT = '11111111-1111-1111-1111-111111111111';
const OTHER_CLIENT = '22222222-2222-2222-2222-222222222222';
const MANAGER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-0000-0000-0000-000000000001';
const REQUEST = 'cccccccc-0000-0000-0000-000000000001';
const WORKER = 'bbbb0001-0000-0000-0000-000000000001';
const SOMEBODY_ELSE = 'bbbb0002-0000-0000-0000-000000000002';
const DIGEST = '0'.repeat(64);

let db;

beforeAll(async () => {
  db = await startMigrationCluster(['./step_54_deep_export_requests.sql'], { applyTwice: true });
  await db.exec(`
    insert into public.clients (id, name) values ('${CLIENT}', 'Desk Client A');
    insert into public.clients (id, name) values ('${OTHER_CLIENT}', 'Desk Client B');
    insert into public.app_users (id, email) values ('${MANAGER}', 'manager@desk');
    insert into public.ingest_devices (id, client_id) values ('${DEVICE}', '${CLIENT}');
  `);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

/** One request on the device, in whatever state the scenario needs it in. */
async function placeRequest(fields = {}) {
  await db.exec('delete from public.ingest_deep_export_requests;');
  const row = {
    id: REQUEST,
    device_id: DEVICE,
    client_id: CLIENT,
    created_by: MANAGER,
    created_by_email: 'manager@desk',
    reason: 'the desk would like this machine’s package',
    run_mode: 'window',
    expires_at: '2027-01-01 00:00:00+00',
    ...fields,
  };
  const columns = Object.keys(row);
  await db.query(
    `insert into public.ingest_deep_export_requests (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    columns.map((column) => row[column]),
  );
}

/** A heartbeat. Returns exactly what the function returned. */
function beat(leaseToken, now, leaseSeconds = 5400) {
  return one(
    db,
    'select public.claim_deep_export_request($1::uuid, $2::uuid, $3::integer, $4::timestamptz)',
    [DEVICE, leaseToken, leaseSeconds, now],
  );
}

/** The machine's answer. Returns the error text rather than throwing. */
async function ack(leaseToken, outcome, now, extra = {}) {
  const {
    sha = outcome === 'uploaded' ? DIGEST : null,
    bytes = outcome === 'uploaded' ? 7_200_000 : null,
    code = outcome === 'uploaded' ? null : 'disk_low',
    requestId = REQUEST,
  } = extra;
  try {
    return await one(
      db,
      `select public.finalize_deep_export_request(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::bigint, null, null, $7::text, $8::timestamptz)`,
      [DEVICE, requestId, leaseToken, outcome, sha, bytes, code, now],
    );
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

async function requestRow() {
  const result = await db.query(
    `select status, offer_count, deferral_count, last_deferral_code, failure_code,
            lease_token::text as lease_token, lease_expires_at::text as lease_expires_at,
            storage_path, uploaded_at::text as uploaded_at, byte_count
     from public.ingest_deep_export_requests where id = $1`,
    [REQUEST],
  );
  return result.rows[0];
}

describe('the window gate, called at the minute it turns', () => {
  /* THE TEST THAT WAS MISSING. 1035 and 1080 are read off the settings row and
   * compared as integers, and the only question that matters about them is which
   * end is inclusive. The two 18:00 rows below are the whole point: with the
   * upper bound written `<=` instead of `<` they answer 'offered', and no
   * assertion about the text of the file notices. */
  const boundary = [
    ['2026-10-02 11:02:00-04', 'none', 'mid-session, hours before the window'],
    ['2026-10-02 17:14:59-04', 'none', 'the last second before it opens'],
    ['2026-10-02 17:15:00-04', 'offered', 'the minute it opens, inclusive'],
    ['2026-10-02 17:59:59-04', 'offered', 'the last second inside it'],
    ['2026-10-02 18:00:00-04', 'none', 'the end minute itself is OUTSIDE'],
    ['2026-10-02 18:00:59-04', 'none', 'and so is the rest of that minute'],
    ['2026-10-02 18:01:00-04', 'none', 'and after it'],
    ['2026-10-03 03:00:00-04', 'offered', 'Saturday at three in the morning'],
    ['2026-10-04 23:30:00-04', 'offered', 'Sunday night'],
  ];

  for (const [instant, expected, why] of boundary) {
    it(`${instant} -> ${expected} (${why})`, async () => {
      await placeRequest();
      const answer = await beat(WORKER, instant);
      expect(answer.outcome, why).toBe(expected);
      const row = await requestRow();
      // AND IT BURNS NOTHING WHEN IT SAYS NO. This is what makes max_offers = 5
      // safe: a request made at ten in the morning must still have all five
      // attempts when the window finally opens.
      expect(Number(row.offer_count)).toBe(expected === 'offered' ? 1 : 0);
      expect(row.status).toBe(expected === 'offered' ? 'offered' : 'open');
    });
  }

  it('converts into the device’s own zone, so the window follows daylight saving', async () => {
    /* 17:15 New York is -04 in October and -05 in January. If the conversion
     * were dropped, or an offset hardcoded, exactly one of these three would be
     * wrong. */
    await placeRequest({ expires_at: '2027-06-01 00:00:00+00' });
    expect((await beat(WORKER, '2027-01-15 17:15:00-05')).outcome).toBe('offered');
    await placeRequest({ expires_at: '2026-12-01 00:00:00+00' });
    expect((await beat(WORKER, '2026-07-15 17:15:00-04')).outcome).toBe('offered');
    await placeRequest({ expires_at: '2027-06-01 00:00:00+00' });
    // The same wall-clock offset in January is 16:15 in New York, which is before
    // the window and inside the trading session.
    expect((await beat(WORKER, '2027-01-15 17:15:00-04')).outcome).toBe('none');
  });

  it('a run_mode of now is the only thing that ignores all of that', async () => {
    await placeRequest({ run_mode: 'now' });
    const answer = await beat(WORKER, '2026-10-02 11:02:00-04');
    expect(answer.outcome).toBe('offered');
    expect(answer.request.run_mode).toBe('now');
  });

  it('a window moved by an UPDATE moves the answer, because it is a column and not a constant', async () => {
    /* The whole reason every tunable is a column: Pedro cannot set an
     * environment variable, so changing the quiet window has to be one UPDATE in
     * the SQL editor. If the function read a constant this would not move. */
    await db.exec('update public.ingest_deep_export_settings set window_start_minute = 660, window_end_minute = 700;');
    try {
      await placeRequest();
      expect((await beat(WORKER, '2026-10-02 11:02:00-04')).outcome).toBe('offered');
      await placeRequest();
      expect((await beat(WORKER, '2026-10-02 17:30:00-04')).outcome).toBe('none');
    } finally {
      await db.exec('update public.ingest_deep_export_settings set window_start_minute = 1035, window_end_minute = 1080;');
    }
  });
});

describe('the TTL and the lease are two different clocks', () => {
  /* WHY THERE ARE TWO. `expires_at` answers "did any machine ever come for
   * this?" - it is the reason the CRM can say "the VPS never came" instead of
   * leaving a manager watching a spinner. `lease_expires_at` answers "is a
   * machine working on it right now?". An earlier draft of this file expired any
   * open or offered request whose TTL had passed, with no exemption for a live
   * lease, so a machine that spent twenty minutes building a 7.2 MB package and
   * uploaded it was told the request had expired - with the ZIP already at
   * storage_path and `upsert: false` making that path unusable again. */
  const LIVE_LEASE = {
    status: 'offered',
    created_at: '2026-09-29 17:20:00-04',
    expires_at: '2026-10-02 17:20:00-04',
    offered_at: '2026-10-02 17:16:00-04',
    offer_count: 1,
    lease_token: WORKER,
    lease_expires_at: '2026-10-02 18:46:00-04',
    storage_path: `${CLIENT}/${REQUEST}.zip`,
  };

  it('does NOT expire a request whose TTL passed while the lease is still live', async () => {
    await placeRequest(LIVE_LEASE);
    // The machine's own next beat, one minute after the TTL ran out, while its
    // export is still running.
    const answer = await beat(WORKER, '2026-10-02 17:21:00-04');
    expect(answer.outcome).not.toBe('none');
    const row = await requestRow();
    expect(row.status).toBe('offered');
    expect(row.lease_token).toBe(WORKER);
  });

  it('and the ack that follows it is ACCEPTED, which is the whole point', async () => {
    await placeRequest(LIVE_LEASE);
    await beat(WORKER, '2026-10-02 17:21:00-04');
    const answer = await ack(WORKER, 'uploaded', '2026-10-02 17:40:00-04');
    expect(answer.error, 'a finished, uploaded export was refused').toBeUndefined();
    expect(answer.outcome).toBe('uploaded');
    const row = await requestRow();
    expect(row.status).toBe('uploaded');
    expect(Number(row.byte_count)).toBe(7_200_000);
  });

  it('a beat from ANOTHER worker does not expire it either, it is told busy', async () => {
    await placeRequest(LIVE_LEASE);
    const answer = await beat(SOMEBODY_ELSE, '2026-10-02 17:21:00-04');
    expect(answer.outcome).toBe('busy');
    expect(answer.retry_after_seconds).toBeGreaterThan(0);
    expect((await requestRow()).status).toBe('offered');
  });

  it('but a lease that ALSO expired is a machine that died, and that IS collected', async () => {
    /* The other half of the rule, and the reason this is not simply "never
     * expire an offered request". A dead lease past the TTL is a VPS that went
     * away mid-export; leaving the row open forever is the wedge the lease
     * exists to prevent. */
    await placeRequest({ ...LIVE_LEASE, lease_expires_at: '2026-10-02 17:19:00-04' });
    const answer = await beat(SOMEBODY_ELSE, '2026-10-02 17:21:00-04');
    expect(answer.outcome).toBe('none');
    const row = await requestRow();
    expect(row.status).toBe('expired');
    expect(row.lease_token).toBeNull();
  });

  it('a dead lease INSIDE the TTL is re-offered instead, at the same storage path', async () => {
    await placeRequest({
      ...LIVE_LEASE,
      expires_at: '2026-10-05 17:20:00-04',
      lease_expires_at: '2026-10-02 17:19:00-04',
    });
    const answer = await beat(SOMEBODY_ELSE, '2026-10-02 17:21:00-04');
    expect(answer.outcome).toBe('offered');
    const row = await requestRow();
    expect(row.status).toBe('offered');
    expect(Number(row.offer_count)).toBe(2);
    expect(row.lease_token).toBe(SOMEBODY_ELSE);
    expect(row.storage_path).toBe(`${CLIENT}/${REQUEST}.zip`);
  });

  it('a re-offer keeps the moment the request was FIRST handed to a machine', async () => {
    /* `offered_at` answers "when did a machine first get told about this", which
     * is the only question it is useful for, and a re-offer must not restamp it.
     * Found by mutation: `offered_at = coalesce(offered_at, v_now)` changed to
     * `offered_at = v_now` moved the recorded moment from 2026-10-01 17:30 to
     * 2026-10-02 17:20 against a real database, and every other assertion in this
     * file passed. */
    await placeRequest({
      status: 'offered',
      created_at: '2026-10-01 17:00:00-04',
      expires_at: '2026-10-04 17:00:00-04',
      offered_at: '2026-10-01 17:30:00-04',
      offer_count: 1,
      lease_token: WORKER,
      lease_expires_at: '2026-10-01 19:00:00-04',
      storage_path: `${CLIENT}/${REQUEST}.zip`,
    });
    const answer = await beat(SOMEBODY_ELSE, '2026-10-02 17:20:00-04');
    expect(answer.outcome).toBe('offered');
    const offeredAt = await one(
      db,
      `select (offered_at at time zone 'America/New_York')::text
       from public.ingest_deep_export_requests where id = $1`,
      [REQUEST],
    );
    expect(offeredAt).toBe('2026-10-01 17:30:00');
  });

  it('a re-offer READS storage_path rather than recomputing it', async () => {
    /* THE MUTANT THIS IS FOR, and the honest caveat with it. Replacing
     * `coalesce(v_request.storage_path, <recompute>)` with
     * `coalesce(null, <recompute>)` produced a byte-identical row in every
     * scenario above, because nothing in stage 1 ever writes a path other than
     * the one the recompute produces - so the two expressions agree today, and
     * no assertion that exercises only the agreeing case can tell whether the
     * column is read at all.
     *
     * The property the design states is stronger than that coincidence: the path
     * is set once on the first offer and never changed, and that is the whole
     * reason `upsert: false` on the signed upload URL means anything. So this
     * places a path the recompute would NOT produce - one UPDATE in the SQL
     * editor away, and what any later re-pathing or prune would leave behind -
     * and asserts the re-offer hands back what the row says. */
    await placeRequest({
      status: 'offered',
      created_at: '2026-10-01 17:00:00-04',
      expires_at: '2026-10-04 17:00:00-04',
      offered_at: '2026-10-01 17:30:00-04',
      offer_count: 1,
      lease_token: WORKER,
      lease_expires_at: '2026-10-01 19:00:00-04',
      storage_path: `${CLIENT}/legacy/already-handed-out.zip`,
    });
    const answer = await beat(SOMEBODY_ELSE, '2026-10-02 17:20:00-04');
    expect(answer.outcome).toBe('offered');
    expect(answer.request.storage_path).toBe(`${CLIENT}/legacy/already-handed-out.zip`);
    expect((await requestRow()).storage_path).toBe(`${CLIENT}/legacy/already-handed-out.zip`);
  });

  it('an open request nobody ever answered expires with its offers unspent', async () => {
    /* The case the TTL was written for: a VPS off for a fortnight must not come
     * back and immediately build a package nobody remembers asking for. */
    await placeRequest({
      created_at: '2026-09-24 17:20:00-04',
      expires_at: '2026-09-27 17:20:00-04',
    });
    const answer = await beat(WORKER, '2026-10-02 17:20:00-04');
    expect(answer.outcome).toBe('none');
    const row = await requestRow();
    expect(row.status).toBe('expired');
    expect(Number(row.offer_count)).toBe(0);
  });

  it('expiring frees the device, so the desk can ask again', async () => {
    await placeRequest({
      created_at: '2026-09-24 17:20:00-04',
      expires_at: '2026-09-27 17:20:00-04',
    });
    await beat(WORKER, '2026-10-02 17:20:00-04');
    const second = await refusal(
      db,
      `insert into public.ingest_deep_export_requests
         (device_id, client_id, created_by_email, reason, expires_at)
       values ($1, $2, 'manager@desk', 'asking again', '2027-01-01 00:00:00+00')`,
      [DEVICE, CLIENT],
    );
    expect(second).toBeNull();
  });
});

describe('a beat carrying the token it was already given', () => {
  /* DEFECT: the comment here used to say such a beat "is answered below with its
   * own offer, unchanged", and the code then fell through to the offer UPDATE,
   * which is not unchanged - it burnt an offer and stamped a new lease. Measured
   * against a database: offer_count climbed 1, 2, 3, 4, 5 on six beats one
   * minute apart and the row went to `failed / offer_limit` while the export was
   * still running, after which the machine's honest ack was refused. With
   * max_offers = 5 and a one minute heartbeat that is every export longer than
   * five minutes. */
  it('six beats one minute apart neither burn an offer nor move the deadline', async () => {
    await placeRequest({
      run_mode: 'now',
      created_at: '2026-10-02 17:40:00-04',
      expires_at: '2026-10-05 17:40:00-04',
    });
    const first = await beat(WORKER, '2026-10-02 17:50:00-04');
    expect(first.outcome).toBe('offered');
    const after = await requestRow();
    expect(Number(after.offer_count)).toBe(1);

    for (const minute of ['17:51', '17:52', '17:53', '17:54', '17:55']) {
      const answer = await beat(WORKER, `2026-10-02 ${minute}:00-04`);
      expect(answer.outcome, `the beat at ${minute} was treated as a new job`).toBe('held');
      const row = await requestRow();
      expect(Number(row.offer_count), `the beat at ${minute} burnt an offer`).toBe(1);
      expect(row.lease_expires_at, `the beat at ${minute} moved the deadline`).toBe(after.lease_expires_at);
      expect(row.lease_token).toBe(WORKER);
      expect(row.storage_path).toBe(after.storage_path);
      expect(row.status).toBe('offered');
    }
  });

  it('and the export that was still running is acked successfully afterwards', async () => {
    await placeRequest({
      run_mode: 'now',
      created_at: '2026-10-02 17:40:00-04',
      expires_at: '2026-10-05 17:40:00-04',
    });
    await beat(WORKER, '2026-10-02 17:50:00-04');
    for (const minute of ['17:51', '17:52', '17:53', '17:54']) {
      await beat(WORKER, `2026-10-02 ${minute}:00-04`);
    }
    const answer = await ack(WORKER, 'uploaded', '2026-10-02 17:54:30-04');
    expect(answer.error).toBeUndefined();
    expect(answer.outcome).toBe('uploaded');
  });

  it('the held answer hands back the same job, so a worker can re-read its orders', async () => {
    await placeRequest({ run_mode: 'now' });
    const offered = await beat(WORKER, '2026-10-02 11:00:00-04');
    const held = await beat(WORKER, '2026-10-02 11:01:00-04');
    expect(held.outcome).toBe('held');
    expect(held.request.id).toBe(offered.request.id);
    expect(held.request.storage_path).toBe(offered.request.storage_path);
    expect(held.request.lease_token).toBe(offered.request.lease_token);
    expect(held.request.lease_expires_at).toBe(offered.request.lease_expires_at);
    expect(held.request.offer_count).toBe(offered.request.offer_count);
    /* The two payloads are built by two separate jsonb_build_object calls, which
     * is the one cost of answering 'held' with its own word. A field added to the
     * offer and forgotten in the held answer would leave a worker that restarted
     * mid-run without something every other worker is given, so the key sets are
     * pinned equal here rather than trusted to stay that way. */
    expect(Object.keys(held.request).sort()).toEqual(Object.keys(offered.request).sort());
    expect(Object.keys(held.request.window).sort()).toEqual(Object.keys(offered.request.window).sort());
  });

  it('stops being held the second the lease runs out, and is re-offered instead', async () => {
    /* The lease comparison is `> v_now`, so a lease that expires exactly on this
     * beat is dead and the request is reclaimed. A worker whose export really
     * outlived its lease loses it - which is the only way a dead VPS ever
     * releases a request, and why the same-token beat above must not quietly
     * renew the deadline. */
    await placeRequest({ run_mode: 'now' });
    const offered = await beat(WORKER, '2026-10-02 11:00:00-04', 300);
    expect(offered.outcome).toBe('offered');
    expect((await beat(WORKER, '2026-10-02 11:04:59-04', 300)).outcome).toBe('held');
    const expired = await beat(WORKER, '2026-10-02 11:05:00-04', 300);
    expect(expired.outcome).toBe('offered');
    const row = await requestRow();
    expect(Number(row.offer_count)).toBe(2);
    expect(row.storage_path).toBe(offered.request.storage_path);
  });

  it('is answered even outside the quiet window, because the run is already going', async () => {
    /* The window decides whether to START a run. A machine already running one
     * at 18:05 must not be told 'none' and left wondering whether the job was
     * taken away. */
    await placeRequest();
    expect((await beat(WORKER, '2026-10-02 17:50:00-04')).outcome).toBe('offered');
    expect((await beat(WORKER, '2026-10-02 18:05:00-04')).outcome).toBe('held');
    expect(Number((await requestRow()).offer_count)).toBe(1);
  });
});

describe('the rest of the life of a request, run rather than read', () => {
  it('a replayed ack is a refusal and not a second accept', async () => {
    await placeRequest({ run_mode: 'now' });
    await beat(WORKER, '2026-10-02 11:00:00-04');
    expect((await ack(WORKER, 'uploaded', '2026-10-02 11:20:00-04')).outcome).toBe('uploaded');
    const replay = await ack(WORKER, 'uploaded', '2026-10-02 11:21:00-04');
    expect(replay.error).toContain('deep_export_not_claimable');
  });

  it('an ack with a token the worker was never given is refused', async () => {
    await placeRequest({ run_mode: 'now' });
    await beat(WORKER, '2026-10-02 11:00:00-04');
    const wrong = await ack(SOMEBODY_ELSE, 'uploaded', '2026-10-02 11:20:00-04');
    expect(wrong.error).toContain('deep_export_not_claimable');
    expect((await requestRow()).status).toBe('offered');
  });

  it('a revoked request cannot be acked, which is what makes the stop button work', async () => {
    await placeRequest({ run_mode: 'now' });
    await beat(WORKER, '2026-10-02 11:00:00-04');
    await db.exec(`update public.ingest_deep_export_requests
                   set status = 'revoked', revoked_at = now() where id = '${REQUEST}';`);
    const stopped = await ack(WORKER, 'uploaded', '2026-10-02 11:20:00-04');
    expect(stopped.error).toContain('deep_export_not_claimable');
  });

  it('a deferral releases the lease, counts itself, and spends no offer', async () => {
    await placeRequest({ run_mode: 'now' });
    await beat(WORKER, '2026-10-02 11:00:00-04');
    const answer = await ack(WORKER, 'deferred', '2026-10-02 11:01:00-04', { code: 'disk_low' });
    expect(answer.outcome).toBe('deferred');
    const row = await requestRow();
    expect(row.status).toBe('open');
    expect(Number(row.deferral_count)).toBe(1);
    expect(Number(row.offer_count)).toBe(1);
    expect(row.lease_token).toBeNull();
    expect(row.last_deferral_code).toBe('disk_low');
  });

  it('a machine that defers five times fails with the REAL reason, not offer_limit', async () => {
    await placeRequest({ run_mode: 'now' });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const answer = await beat(WORKER, `2026-10-02 11:0${attempt}:00-04`);
      expect(answer.outcome, `offer ${attempt}`).toBe('offered');
      await ack(WORKER, 'deferred', `2026-10-02 11:0${attempt}:30-04`, { code: 'disk_low' });
    }
    const sixth = await beat(WORKER, '2026-10-02 11:06:00-04');
    expect(sixth.outcome).toBe('none');
    const row = await requestRow();
    expect(row.status).toBe('failed');
    expect(Number(row.offer_count)).toBe(5);
    expect(row.failure_code).toBe('disk_low');
  });

  it('an upload bigger than the desk’s own limit is refused', async () => {
    await placeRequest({ run_mode: 'now' });
    await beat(WORKER, '2026-10-02 11:00:00-04');
    const toobig = await ack(WORKER, 'uploaded', '2026-10-02 11:20:00-04', { bytes: 268_435_457 });
    expect(toobig.error).toContain('deep_export_too_large');
  });

  it('two open requests on one device is the index’s refusal and not a route’s', async () => {
    await placeRequest();
    const second = await refusal(
      db,
      `insert into public.ingest_deep_export_requests
         (device_id, client_id, created_by_email, reason, expires_at)
       values ($1, $2, 'manager@desk', 'asking twice', '2027-01-01 00:00:00+00')`,
      [DEVICE, CLIENT],
    );
    expect(second).toContain('idx_deep_export_one_open_per_device');
  });

  it('a revoked device is refused outright, but only once the probe has matched', async () => {
    /* The probe comes first, so a revoked machine with nothing waiting for it is
     * answered 'none' like every other machine - it never reaches the ownership
     * chain. The refusal is for a revoked machine that DOES have a request. */
    const revoked = 'dddddddd-0000-0000-0000-0000000000ff';
    await db.exec(`insert into public.ingest_devices (id, client_id, status, revoked_at)
                   values ('${revoked}', '${OTHER_CLIENT}', 'revoked', now())
                   on conflict (id) do nothing;`);
    await db.exec('delete from public.ingest_deep_export_requests;');
    expect(await one(
      db,
      `select public.claim_deep_export_request('${revoked}'::uuid, $1::uuid, 5400, now())`,
      [WORKER],
    )).toEqual({ outcome: 'none' });

    await db.query(
      `insert into public.ingest_deep_export_requests
         (device_id, client_id, created_by_email, reason, expires_at)
       values ($1, $2, 'manager@desk', 'asked before the device was revoked', '2027-01-01 00:00:00+00')`,
      [revoked, OTHER_CLIENT],
    );
    const refused = await refusal(
      db,
      `select public.claim_deep_export_request('${revoked}'::uuid, $1::uuid, 5400, now())`,
      [WORKER],
    );
    expect(refused).toContain('invalid_ingest_device');
  });

  it('an ordinary beat on an ordinary day writes nothing at all', async () => {
    await db.exec('delete from public.ingest_deep_export_requests;');
    const answer = await beat(WORKER, '2026-10-02 11:00:00-04');
    expect(answer).toEqual({ outcome: 'none' });
    expect(Number(await one(db, 'select count(*) from public.ingest_deep_export_requests'))).toBe(0);
  });
});
