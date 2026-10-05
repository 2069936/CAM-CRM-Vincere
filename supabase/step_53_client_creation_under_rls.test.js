// Step 53 exists because step 52 shipped with a hole its own tests could not
// see, and the shape of that hole is worth keeping in a test.
//
// Step 52's clients policies were asserted against the SQL file. They were
// exactly what the file said, and what the file said was wrong in a way no
// reading of it revealed: `insert ... with check (true)` passes, and then
// RETURNING applies the SELECT policy to the row, and a client a CAM has just
// created is assigned to nobody. The CRM's own insert ends in
// `.insert({...}).select().single()`, so every New Client form in a CAM session
// answered:
//
//   new row violates row-level security policy for table "clients"
//
// which names the INSERT check that was not the thing refusing.
//
// Measured against production as the CAM "Peter", before: `insert` alone
// succeeded and `insert ... returning id` raised 42501. After: the insert, the
// assignment and a following update all succeed, he sees 37 clients where he
// saw 36, and a client belonging to another CAM still reads 0.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_53_client_creation_under_rls.sql', import.meta.url);
const step52Url = new URL('./step_52_rls_by_cam.sql', import.meta.url);
const storeUrl = new URL('../src/domain/supabaseStore.js', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';

// The executable half. This header argues at length about RETURNING, triggers
// and recursion, and an assertion about the statements must never be satisfied
// by that argument.
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 53 exists and is no longer the one that runs last', () => {
  it('appears once, and 56 now carries the highest-number claim', () => {
    /* Handed on the way step 52 handed it here: the Math.max assertion moves to
     * the newest step's own test, because leaving it behind makes every later
     * migration look like a break in this one.
     *
     * It has now moved twice in a day, 53 to 55 to 56, and both moves were a
     * rebase conflict. That is the convention working rather than failing: two
     * migrations landing hours apart both want to be the newest, and git makes
     * them say which one is. 54 is still claimed by an unmerged branch, which
     * is why the numbers on disk skip it. */
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 53)).toHaveLength(1);
  });

  it('is in the runbook table and in the run order', () => {
    expect(runbook).toMatch(/^\| 53 \| `step_53_client_creation_under_rls\.sql` \|.*\|$/m);
    // No trailing period: the arrow continues past 53 now.
    expect(runbook).toContain('→ 52 → 53');
  });
});

describe('the column the whole repair rests on', () => {
  it('is added to clients and defaults to auth.uid()', () => {
    /* A COLUMN and not a lookup, on purpose. A policy reads it straight off the
     * row being returned, with no snapshot in the way. That is the one thing a
     * trigger could not offer - see the next test. */
    expect(flat).toContain('alter table public.clients add column if not exists created_by uuid default auth.uid()');
  });

  it('adds the column IF NOT EXISTS, so a second run is a no-op', () => {
    expect(flat).toContain('if not exists created_by');
  });

  it('never back-fills it', () => {
    /* Every row written before this step keeps a null, and `null = auth.uid()`
     * is null rather than true. Back-filling would hand old rows to whoever the
     * back-fill named, which is the opposite of what step 52 was for. */
    expect(flat).not.toMatch(/update public\.clients set created_by/);
    expect(flat).not.toMatch(/\bdefault gen_random_uuid\b/);
  });

  it('does not try to fix this with a trigger', () => {
    /* A trigger that assigns the new client cannot work and the header says
     * why: assigned_client_ids() is STABLE, so it reads the statement's
     * snapshot, and a row written during that statement is not in it. This was
     * tried against production before the column was chosen. */
    expect(flat).not.toContain('create trigger');
    expect(flat).not.toContain('returns trigger');
  });
});

describe('the third arm, and the fact that it closes itself', () => {
  const arm = 'created_by = (select auth.uid()) and not public.client_is_assigned(id)';

  it('is on select and on update', () => {
    expect(flat.match(new RegExp(arm.replace(/[()]/g, '\\$&'), 'g') || [])).not.toBeNull();
    const selectPolicy = /create policy "cam sees its own clients" on public\.clients[\s\S]*?;/i.exec(sql)[0];
    const updatePolicy = /create policy "cam updates its own clients" on public\.clients[\s\S]*?;/i.exec(sql)[0];
    expect(selectPolicy.toLowerCase().replace(/\s+/g, ' ')).toContain(arm);
    expect(updatePolicy.toLowerCase().replace(/\s+/g, ' ')).toContain(arm);
  });

  it('is NOT a bare created_by check, which would never expire', () => {
    /* `created_by = auth.uid()` alone lets the creator keep sight of a client
     * after it is transferred to another CAM, forever. The assignment test is
     * what makes the arm switch itself off one statement later. */
    expect(flat).not.toMatch(/created_by = \(select auth\.uid\(\)\)\s*\)/);
    expect(flat).toContain('not public.client_is_assigned(id)');
  });

  it('is not extended to delete', () => {
    // Creating a client you cannot yet see is a flow this product has. Deleting
    // one that is not yours is not.
    const del = /create policy[^;]*on public\.clients\s+for delete[\s\S]*?;/i.exec(sql);
    expect(del).toBeNull();
    expect(flat).not.toMatch(/for delete[^;]*client_is_assigned/);
  });
});

describe('the two helpers exist to break a cycle, not to decorate', () => {
  it('both are security definer with a pinned search_path', () => {
    for (const fn of ['client_is_assigned', 'clients_i_created']) {
      const body = new RegExp(`create or replace function public\\.${fn}\\([^)]*\\)[\\s\\S]*?\\$function\\$`, 'i');
      const match = body.exec(sql);
      expect(match, `${fn} is missing`).toBeTruthy();
      const text = match[0].toLowerCase();
      expect(text).toContain('security definer');
      expect(text).toContain('stable');
      expect(text).toContain('set search_path = pg_catalog, public');
    }
  });

  it('the clients policy reaches client_assignments ONLY through the helper', () => {
    /* Inline, each policy queries the other's table, each triggers the other's
     * policy, and Postgres answers:
     *   ERROR: 42P17: infinite recursion detected in policy for relation "clients"
     * That was raised by production, in a transaction, before this shape was
     * chosen. A definer function evaluates no policies, so it breaks the cycle. */
    const clientsPolicies = [...sql.matchAll(/create policy[^;]*on public\.clients\b[\s\S]*?;/gi)]
      .map((m) => m[0].toLowerCase());
    expect(clientsPolicies.length).toBeGreaterThan(0);
    for (const policy of clientsPolicies) {
      expect(policy).not.toContain('from public.client_assignments');
    }
  });

  it('and the client_assignments policy reaches clients only through the other helper', () => {
    const assignmentPolicies = [...sql.matchAll(/create policy[^;]*on public\.client_assignments\b[\s\S]*?;/gi)]
      .map((m) => m[0].toLowerCase());
    expect(assignmentPolicies.length).toBeGreaterThan(0);
    for (const policy of assignmentPolicies) {
      expect(policy).not.toContain('from public.clients');
      expect(policy).toContain('public.clients_i_created()');
    }
  });

  it('neither helper is left executable by the world', () => {
    expect(flat).toContain('revoke all on function public.client_is_assigned(uuid) from public');
    expect(flat).toContain('revoke all on function public.clients_i_created() from public');
    expect(flat).toContain('grant execute on function public.client_is_assigned(uuid) to authenticated');
    expect(flat).toContain('grant execute on function public.clients_i_created() to authenticated');
  });
});

describe('what the assignment policy must not become', () => {
  it('gates on the CLIENT, never on the profile being assigned to', () => {
    /* "You may assign any client to yourself" would let a CAM take every client
     * on the desk by writing one row, which is a bigger hole than the one step
     * 52 closed. The gate stays on which clients you may touch. */
    const policy = /create policy[^;]*on public\.client_assignments\b[\s\S]*?;/i.exec(sql)[0].toLowerCase();
    expect(policy).toContain('client_id in (select public.clients_i_created())');
    expect(policy).not.toMatch(/cam_profile_id\s*=\s*\(?\s*select/);
  });
});

describe('the thing that actually broke, asserted against the source', () => {
  it('the browser really does end its client insert in RETURNING', () => {
    /* Checked rather than remembered. If this ever stops being true the third
     * arm may be removable, and whoever reads this test will know why it was
     * added. `.select()` after `.insert()` is PostgREST for RETURNING. */
    const store = readFileSync(storeUrl, 'utf8');
    const insert = /\.from\('clients'\)\s*\.insert\(\{[\s\S]*?\}\)([\s\S]{0,60})/.exec(store);
    expect(insert, 'the client insert moved').toBeTruthy();
    expect(insert[1]).toContain('.select()');
  });

  it('step 52 now says which of its policies this one replaced', () => {
    // A reader who finds step 52 first must not implement its version again.
    const step52 = readFileSync(step52Url, 'utf8');
    expect(step52).toContain('SUPERSEDED IN PART BY STEP 53');
  });
});

describe('what it must not do', () => {
  it('changes no row and drops no table', () => {
    expect(flat).not.toMatch(/\bdrop table\b|\bdelete from\b|\btruncate\b/);
    expect(flat).not.toMatch(/\bupdate public\.\w+ set\b/);
  });

  it('never disables row level security while repairing it', () => {
    expect(flat).not.toContain('disable row level security');
    expect(flat).not.toContain('bypassrls');
  });

  it('does not widen any table step 52 narrowed beyond clients and assignments', () => {
    /* Policy and table statements only, matched from their own keywords.
     * Scanning for "on public." instead counts `grant execute ON FUNCTION
     * public.clients_i_created()` as a table, and worse, the `on` in
     * "function" matches too. That was this test's own first bug. */
    const touched = [
      ...[...sql.matchAll(/(?:create|drop) policy[^;]*?\bon public\.(\w+)/gi)].map((m) => m[1]),
      ...[...sql.matchAll(/alter table public\.(\w+)/gi)].map((m) => m[1]),
    ];
    expect(touched.length).toBeGreaterThan(3);
    expect([...new Set(touched)].sort()).toEqual(['client_assignments', 'clients']);
  });
});
