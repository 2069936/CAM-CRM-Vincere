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
import { describe, expect, it } from 'vitest';

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

  it('expires a request past its TTL instead of offering it to a machine that just came back', () => {
    expect(claim.toLowerCase()).toContain("set status = 'expired'");
    expect(claim.toLowerCase()).toContain('request.expires_at <= v_now');
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
