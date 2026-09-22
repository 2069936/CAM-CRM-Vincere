import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RAN_BASES } from '../src/domain/strategyRan.js';

/* WHAT THIS MIGRATION HAS TO KEEP TRUE.
 *
 * It stores an answer the product used to recompute, so the assertions below
 * pin the three things that makes it an answer rather than a guess: the columns
 * are nullable with no default (an unanswered row must not claim the algorithm
 * was idle), the backfill runs one close per transaction and can be run twice,
 * and the SQL copy of the family rule is the JS one character for character
 * except where Postgres has no non-capturing group. The fourth is that the
 * automatic collector's own writer takes the answer off the payload instead of
 * reaching its own, because two writers reaching two answers is how a desk ends
 * up with one number on two screens.
 */
const migrationUrl = new URL('./step_47_strategy_ran.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const familyUrl = new URL('../src/domain/strategyFamily.js', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');
const familySource = readFileSync(familyUrl, 'utf8');

function routineDefinition(kind, name) {
  const match = raw.match(new RegExp(
    `create\\s+or\\s+replace\\s+${kind}\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$${kind === 'procedure' ? 'procedure' : 'function'}\\$\\s*;`,
    'i',
  ));
  return match?.[0] ?? '';
}

const flat = (text) => text.toLowerCase().replace(/\s+/g, ' ');

describe('step 47 stores whether a strategy ran', () => {
  it('is documented in the runbook, after the migration before it', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 47 \| `step_47_strategy_ran\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 47 | `step_47_strategy_ran.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 46 | `step_46_ingest_quarantine_reports.sql`'));
    expect(runbook).toMatch(/→ 46 → 47(?: →|\.)/);
  });

  it('says in the runbook what the desk loses by not running it, and how to finish it', () => {
    expect(runbook).toContain('47 degrades gracefully');
    // The backfill is a second statement and the runbook is where an operator
    // finds that out. Both forms: the procedure, and the loop for a client that
    // wraps every statement in a transaction.
    expect(runbook).toContain('call public.backfill_strategy_ran_all();');
    expect(runbook).toContain('select public.backfill_strategy_ran(2000);');
  });

  it('adds two columns and drops nothing', () => {
    expect(sql).toContain('add column if not exists ran boolean');
    expect(sql).toContain('add column if not exists ran_basis text');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop column/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/drop index/);
  });

  it('leaves an unanswered row saying nothing, rather than saying it did not trade', () => {
    // No default and no not-null on either column. A default of false is the
    // claim "this algorithm did not trade" made about every row nobody has
    // looked at yet, which is step 37's fabricated zero in another column.
    expect(sql).not.toMatch(/add column if not exists ran boolean [^;]*default/);
    expect(sql).not.toMatch(/add column if not exists ran boolean [^;]*not null/);
    expect(sql).not.toMatch(/add column if not exists ran_basis text [^;]*default/);
    expect(sql).not.toMatch(/add column if not exists ran_basis text [^;]*not null/);
    expect(raw).toMatch(/comment on column public\.strategy_snapshots\.ran is/);
    expect(raw).toMatch(/comment on column public\.strategy_snapshots\.ran_basis is/);
  });

  it('indexes what a screen filters on, and leaves the table\'s RLS as step 43 set it', () => {
    expect(sql).toContain('create index if not exists idx_strategy_snapshots_import_ran on public.strategy_snapshots (daily_import_id) where ran');
    // Enabling RLS on a table with no policy would lock the app out of its own
    // strategy rows, so the re-assertion is guarded on the policy existing.
    expect(sql).toContain("select 1 from pg_policies where schemaname = 'public' and tablename = 'strategy_snapshots'");
    expect(sql).toContain('execute \'alter table public.strategy_snapshots enable row level security\'');
    expect(sql).not.toMatch(/drop policy/);
    expect(sql).not.toMatch(/create policy/);
  });

  it('carries the same four answers the product does', () => {
    const answers = routineDefinition('function', 'recompute_strategy_ran');
    for (const basis of RAN_BASES) {
      expect(flat(answers)).toContain(`'${basis}'`);
    }
    expect(RAN_BASES).toEqual(['enabled', 'fills', 'realized', 'none']);
    // The rule, in the order the evidence ranks: the checkbox, then the fills,
    // then a non-zero realized on a row the grid had switched off.
    expect(flat(answers)).toMatch(
      /when strategy\.enabled is true then 'enabled' when fills\.family is not null then 'fills' when strategy\.realized is not null and strategy\.realized <> 0 then 'realized' else 'none' end/,
    );
    // `ran` is never stored independently of the evidence for it.
    expect(flat(answers)).toContain("set ran = (answered.basis <> 'none'), ran_basis = answered.basis");
  });

  it('matches the fills the way the app does, per account', () => {
    const answers = flat(routineDefinition('function', 'recompute_strategy_ran'));
    // Both sides of the join take their account from trading_account_id, which
    // is where supabaseStore's row mappers take the account name from. A row
    // with no account matches no fills here because it matched none there.
    expect(answers).toContain('execution.trading_account_id is not null');
    expect(answers).toContain('on fills.trading_account_id = strategy.trading_account_id');
    expect(answers).toContain('and fills.family = coalesce( nullif(strategy.strategy_family, \'\'), public.strategy_family_key(strategy.strategy_name) )');
    // distinct, so two fills of one family cannot multiply a strategy row.
    expect(answers).toContain('with fills as ( select distinct');
  });

  it('is the JS family rule, not a second one', () => {
    // strategyFamilyOf is the only place these two live in the product. If
    // either changes, this fails and the SQL has to follow it.
    const patterns = [...familySource.matchAll(/replace\((\/[^/]+\/[a-z]*),/g)].map((m) => m[1]);
    expect(patterns).toEqual(['/^\\d+\\s*-\\s*/', '/\\s*-\\s*\\d+(?:\\.\\d+)+\\s*$/']);
    const family = routineDefinition('function', 'strategy_family_key');
    // Same two, as Postgres spells them: no delimiters, and no non-capturing
    // group, which Postgres does not have.
    for (const pattern of patterns) {
      const body = pattern.replace(/^\//, '').replace(/\/[a-z]*$/, '').replace(/\(\?:/g, '(');
      expect(family).toContain(`'${body}'`);
    }
    // And the `-PF` -> `_PF` half of familyFromStrategyName.
    expect(flat(family)).toContain("when base.family ~ '^[a-za-z0-9]+-[pp][ff]$' then upper(regexp_replace(base.family, '-[pp][ff]$', '_pf'))");
  });

  it('backfills one close at a time and commits between them', () => {
    const procedure = routineDefinition('procedure', 'backfill_strategy_ran_all');
    expect(flat(procedure)).toContain('v_written := public.backfill_strategy_ran(p_max_rows);');
    expect(flat(procedure)).toContain('exit when v_written = 0;');
    expect(flat(procedure)).toContain('commit;');
    // A routine carrying a SET clause may not commit ("invalid transaction
    // termination"), so this one must not grow one. Everything in it is
    // schema-qualified instead.
    expect(procedure).not.toMatch(/set\s+search_path/i);
    const batch = flat(routineDefinition('function', 'backfill_strategy_ran'));
    // It only ever looks at rows nobody has answered, which is what makes a
    // second run write nothing.
    expect(batch).toContain('where strategy.ran is null');
    expect(batch).toContain('exit when v_total >= greatest(coalesce(p_max_rows, 2000), 1);');
    expect(batch).toContain('exit when v_import is null;');
    expect(batch).toContain('exit when v_written = 0;');
  });

  it('writes only the rows whose answer changes, so a second pass is free', () => {
    expect(flat(routineDefinition('function', 'recompute_strategy_ran'))).toContain(
      "and (strategy.ran is distinct from (answered.basis <> 'none') or strategy.ran_basis is distinct from answered.basis)",
    );
  });

  it('keeps the backfill off every role that is not the service role', () => {
    for (const routine of [
      'function public.strategy_family_key(text)',
      'function public.recompute_strategy_ran(uuid)',
      'function public.backfill_strategy_ran(integer)',
      'procedure public.backfill_strategy_ran_all(integer)',
    ]) {
      expect(sql).toContain(`revoke all on ${routine} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on ${routine} to service_role`);
    }
  });

  it('makes the collector store the answer the ingest reached, not one of its own', () => {
    const persist = routineDefinition('function', 'persist_auto_daily_import');
    expect(persist).not.toBe('');
    const body = flat(persist);
    expect(body).toContain('parameters_raw, params_parsed, direction, enabled, ran, ran_basis, realized, unrealized');
    expect(body).toContain("nullif(v_item ->> 'ran', '')::boolean");
    expect(body).toContain("nullif(v_item ->> 'ranbasis', '')");
    // It takes the answer off the payload. If this function ever decides one
    // for itself, the automatic path and the manual path can disagree about the
    // same close.
    expect(body).not.toContain('strategy_family_key');
    expect(body).not.toContain("then 'fills'");
    // A payload written by an older CRM carries neither key, and NULL is the
    // honest answer for it: no coalesce to false anywhere near these two.
    expect(body).not.toMatch(/coalesce\(\(v_item ->> 'ran'\)/);
  });

  it('leaves step 37\'s gap on that path exactly where it was', () => {
    // Reproducing a 300-line function is an invitation to fix other things in
    // it. The derived columns are a different measurement and they are not
    // touched here; the file says so and this keeps it honest.
    const persist = flat(routineDefinition('function', 'persist_auto_daily_import'));
    expect(persist).not.toContain('derived_realized');
    expect(persist).not.toContain('derivation');
    expect(persist).toContain("coalesce(nullif(v_item ->> 'realized', '')::numeric, 0)");
  });
});
