import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* THE DOOR THAT WAS OPEN.
 *
 * Every table in this schema except the auto collection ones was readable and
 * writable by the publishable key that ships inside the browser bundle, with
 * no session: clients, trading_accounts, account_snapshots, app_users,
 * reports, audit_logs and client_credentials among them. Step 43 closes them.
 * These assertions pin the parts of that migration whose absence would leave
 * the door open again. */
const migrationUrl = new URL('./step_43_row_level_security.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const authUrl = new URL('../src/domain/supabaseAuth.js', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');
const auth = readFileSync(authUrl, 'utf8');

describe('step 43 closes the database to the browser key', () => {
  it('is documented after every table that existed when it was written', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 43 \| `step_43_row_level_security\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 43 | `step_43_row_level_security.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 42 | `step_42_client_tags_and_price_history.sql`'));
    // 43 ran after 42 so the table 42 creates is covered. It is no longer the
    // last step in the runbook and this assertion no longer requires it to be:
    // 44 adds a table after 43 has run, which 43's enumeration cannot reach, so
    // 44 carries its own RLS inline. step_44_algorithm_benchmarks.test.js is
    // where that obligation is pinned — the rule this file protects is "no
    // table in public is open", not "43 is last".
    expect(runbook).toMatch(/→ 42 → 43(\.| → 44\.)/);
  });

  it('enables row level security on every table that lacks it, by enumeration', () => {
    // Enumerated rather than listed, so a table added later is covered without
    // anyone remembering to add it here.
    expect(sql).toMatch(/from pg_tables where schemaname = 'public' and not rowsecurity/);
    expect(sql).toMatch(/alter table public\.%i enable row level security/);
  });

  it('gives signed in users what they had and anonymous callers nothing', () => {
    expect(sql).toMatch(/create policy "authenticated full access" on public\.%i for all to authenticated/);
    // No policy and no table grant hands anything to anon. The single
    // `to anon` in the file is the grant on the sign in function, asserted
    // below; a policy or a table grant would be the door reopening.
    expect(sql).not.toMatch(/create policy[^;]*to anon/);
    const anonGrants = sql.match(/grant [^;]*to [^;]*anon/g) || [];
    expect(anonGrants).toHaveLength(1);
    expect(anonGrants[0]).toContain('login_email_for_username');
  });

  it('stops views from handing rows back around the tables policies', () => {
    expect(sql).toMatch(/security_invoker = true/);
    expect(sql).toMatch(/revoke all on public\.%i from anon/);
  });

  it('replaces the one anonymous read with a function that answers only an email', () => {
    expect(sql).toMatch(/create or replace function public\.login_email_for_username\(p_username text\)/);
    expect(sql).toMatch(/returns text/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).toMatch(/grant execute on function public\.login_email_for_username\(text\) to anon, authenticated/);
    // Inactive users cannot be used to discover an address.
    expect(sql).toMatch(/coalesce\(status, 'active'\) <> 'inactive'/);
  });

  it('refuses to finish while any table is still open', () => {
    expect(sql).toMatch(/raise exception 'step 43 left % table\(s\) without row level security'/);
  });

  it('is idempotent: policies are created only when absent', () => {
    expect(sql).toMatch(/if not exists \( select 1 from pg_policies/);
    expect(sql).toMatch(/create or replace function/);
  });

  it('the sign in path asks the function first and keeps a fallback until every deployment has it', () => {
    expect(auth).toContain("supabase.rpc('login_email_for_username'");
    expect(auth).toMatch(/isMissingFunction/);
    expect(auth).toContain("from('app_users')");
  });
});
