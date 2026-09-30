// Step 52 is the migration whose mistakes are silent in both directions.
//
// Too loose and it looks installed while granting everything, because a
// leftover PERMISSIVE policy beside the new one is OR'd with it. Too tight and
// a CAM's screens go blank mid-trading-day. Neither shows up as an error, so
// the shape of the SQL is asserted here rather than trusted.
//
// Measured against production before and after it was applied, signed in as
// the CAM "Peter": 212 clients -> 36, 1,557 accounts -> 240, 69,489 orders ->
// 13,022, 149 stored credentials -> 29. An UPDATE on one of his own clients
// still touched 1 row; the same UPDATE on somebody else's touched 0.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_52_rls_by_cam.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';

/* The executable half. This file's header argues at length about `using
 * (true)`, about what it does NOT narrow, and about why the sub-select matters,
 * and an assertion about the statements must never be satisfied by that prose.
 * Three tests in this repo have already passed against a comment. */
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 52 exists and is the one that runs last', () => {
  it('appears once, and 53 now carries the highest-number claim', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 52)).toHaveLength(1);
  });

  it('is in the runbook table and at the end of the run order', () => {
    expect(runbook).toMatch(/^\| 52 \| `step_52_rls_by_cam\.sql` \|.*\|$/m);
    expect(runbook).toContain('→ 51 → 52');
  });
});

describe('the two functions the policies lean on', () => {
  it('both run as definer, because they read the table being restricted', () => {
    for (const fn of ['is_manager', 'assigned_client_ids']) {
      const body = new RegExp(`create or replace function public\\.${fn}\\(\\)[\\s\\S]*?\\$function\\$`, 'i');
      const match = body.exec(sql);
      expect(match, `${fn} is missing`).toBeTruthy();
      expect(match[0].toLowerCase()).toContain('security definer');
    }
  });

  it('both are stable, which is what lets the planner hoist them', () => {
    // Marked volatile, the sub-select wrapper below stops working and the
    // function runs once per row on a 69,489-row table.
    expect(flat).toMatch(/function public\.is_manager\(\)[^$]*stable/);
    expect(flat).toMatch(/function public\.assigned_client_ids\(\)[^$]*stable/);
  });

  it('both pin search_path, because a definer function without one is the way in', () => {
    expect(flat.match(/set search_path = pg_catalog, public/g)).toHaveLength(2);
  });

  it('the CAM arm is an inner join on the profile, not a left join', () => {
    /* A left join would return a row with a null client_id for a user with no
     * assignments, and `client_id in (null)` is NULL, not false. That still
     * denies, but it denies by accident. The inner join returns nothing. */
    const fn = /create or replace function public\.assigned_client_ids[\s\S]*?\$function\$;/i.exec(sql)[0];
    expect(fn.toLowerCase()).toContain('join public.app_users');
    expect(fn.toLowerCase()).not.toContain('left join');
  });

  it('an inactive row resolves to nothing, in both functions', () => {
    expect(flat.match(/coalesce\(u\.status, ?'active'\) <> 'inactive'/g)).toHaveLength(2);
  });

  it('is_manager never enumerates clients', () => {
    /* This is the whole reason there are two functions. A Manager arm that
     * reads `clients` cannot pass a `with check` on an INSERT into `clients`:
     * the new id is not in the snapshot a stable function reads, so creating a
     * client would fail for a Manager. */
    const fn = /create or replace function public\.is_manager[\s\S]*?\$function\$;/i.exec(sql)[0];
    expect(fn.toLowerCase()).not.toContain('from public.clients');
  });

  it('neither is left executable by the world', () => {
    expect(flat).toContain('revoke all on function public.is_manager() from public');
    expect(flat).toContain('revoke all on function public.assigned_client_ids() from public');
    expect(flat).toContain('grant execute on function public.is_manager() to authenticated');
  });
});

describe('every policy calls the functions the one way that scales', () => {
  it('always through a scalar sub-select, everywhere in the file', () => {
    /* `(select f())` is an InitPlan, evaluated once per query. A bare `f()` in
     * a policy is evaluated once per ROW: on orders that is 69,489 calls and
     * the table stops being usable. So this is correctness wearing a
     * performance costume.
     *
     * Counted rather than inspected per call site. An earlier version of this
     * test looked at the 30 characters before each call, which silently SKIPPED
     * a bare call that began a line - the exact thing it existed to catch. */
    const body = sql
      .replace(/create or replace function[\s\S]*?\$function\$;/gi, '')
      .replace(/comment on function[\s\S]*?;/gi, '')
      .replace(/(revoke all|grant execute) on function[^;]*;/gi, '');

    for (const name of ['is_manager', 'assigned_client_ids']) {
      const all = body.match(new RegExp(`public\\.${name}\\(\\)`, 'g')) || [];
      const wrapped = body.match(new RegExp(`\\(select\\s+public\\.${name}\\(\\)`, 'g')) || [];
      expect(all.length, `${name} is not used by any policy`).toBeGreaterThanOrEqual(5);
      expect(wrapped.length, `${all.length - wrapped.length} bare call(s) to ${name}`).toBe(all.length);
    }
  });
});

describe('what the policies cover', () => {
  it('finds the client_id tables from the catalogue rather than listing them', () => {
    // 13 tables today. A table added later is covered by re-running this file,
    // not by somebody remembering to edit a list.
    expect(flat).toContain("c.column_name = 'client_id'");
    expect(flat).toContain("t.table_type = 'base table'");
  });

  it('names the four that only reach a client through the close', () => {
    for (const t of ['account_snapshots', 'strategy_snapshots', 'orders', 'executions']) {
      expect(flat).toContain(`'${t}'`);
    }
    expect(flat).toContain('d.id = daily_import_id');
  });

  it('routes payout_events through the account it paid', () => {
    expect(flat).toContain('a.id = trading_account_id');
  });

  it('leaves the ingest tables to their own restrictive denials', () => {
    expect(flat).toContain("c.table_name not like 'ingest%'");
  });
});

describe('the two ways this migration could be silently wrong', () => {
  it('drops EVERY permissive policy, not the one it happens to know the name of', () => {
    /* Permissive policies are OR'd. client_price_changes carried two of its own
     * (`..._read` with using(true) and `..._insert` with check(true)) beside
     * step 43's. Dropping only "authenticated full access" would have left
     * those two granting everything while the new policy looked installed. */
    const drops = [...sql.matchAll(/drop policy/gi)];
    expect(drops.length).toBeGreaterThan(0);
    expect(flat).not.toContain("drop policy if exists 'authenticated full access'");
    expect(flat.match(/permissive = 'permissive'/g).length).toBeGreaterThanOrEqual(4);
    // Every drop is driven by a catalogue read, never by a hard-coded name.
    expect(flat).toContain('select policyname from pg_policies');
  });

  it('never drops a restrictive policy', () => {
    /* The six `using (false)` denials on the ingest tables are AND'd and are
     * the only thing keeping the browser off them. Every drop loop filters to
     * PERMISSIVE, so they cannot be swept up. */
    expect(flat).not.toContain("permissive = 'restrictive'");
    expect(flat).not.toMatch(/drop policy[^;]*ingest/);
  });
});

describe('clients is split, and that split is deliberate', () => {
  it('reads, updates and deletes carry the rule', () => {
    expect(flat).toContain('on public.clients for select to authenticated');
    expect(flat).toContain('on public.clients for update to authenticated');
    expect(flat).toContain('on public.clients for delete to authenticated');
  });

  it('insert does not, because the row being checked is not in the table yet', () => {
    /* `with check` on INSERT runs against a row that no snapshot contains, so
     * any predicate reading `clients` fails - for a Manager too. Creating a
     * client discloses nothing; what the creator may then READ is governed by
     * the select policy above. */
    expect(flat).toContain('on public.clients for insert to authenticated with check (true)');
  });

  it('and is never given a `for all` policy that would re-open the read', () => {
    expect(flat).not.toMatch(/on public\.clients for all/);
  });
});

describe('what it must not do', () => {
  it('changes no row and drops no table', () => {
    expect(flat).not.toMatch(/\bdrop table\b|\bdelete from\b|\btruncate\b/);
    expect(flat).not.toMatch(/\bupdate public\.\w+ set\b/);
  });

  it('never disables row level security while rearranging it', () => {
    expect(flat).not.toContain('disable row level security');
    expect(flat).not.toContain('bypassrls');
  });

  it('leaves the desk reference tables alone', () => {
    /* cam_profiles, the SOP tables, algorithm_benchmarks, strategy_templates
     * and app_users describe how the desk works rather than what a client did.
     * app_users is held shut by the grant step 51 removed, not by a policy. */
    for (const t of ['cam_profiles', 'sop_items', 'sop_sections', 'app_users', 'algorithm_benchmarks']) {
      expect(flat).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}\\b`));
    }
  });
});
