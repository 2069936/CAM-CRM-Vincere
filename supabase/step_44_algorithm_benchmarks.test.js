import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { benchmarkMonthlyRows, buildBenchmarkSeries, parseBenchmarkCsv } from '../src/domain/algorithmBenchmark';

/* WHAT THIS TABLE IS FOR, AND WHAT IT MUST NEVER BECOME.
 *
 * `algorithm_benchmarks` holds backtests: one simulated account, the version
 * the desk runs today re-run over history, downloaded from the vendor. The one
 * way this table does damage is by being read as if it held client results, so
 * the assertions below pin the three things that keep it honest — the risk
 * level cannot be aggregated away, the vendor's already-net Profit cannot be
 * stored as gross, and a re-import replaces rather than doubles — plus the RLS
 * that step 43 cannot apply to a table created after it ran. */
const migrationUrl = new URL('./step_44_algorithm_benchmarks.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 44 stores the My Futures Book backtests', () => {
  it('is documented in the runbook, after the migration that closed the database', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 44 \| `step_44_algorithm_benchmarks\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 44 | `step_44_algorithm_benchmarks.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 43 | `step_43_row_level_security.sql`'));
    // The tail of the order line moves every time a step is added; what 44
    // pins is its own place in it, immediately after 43.
    expect(runbook).toMatch(/→ 43 → 44(?: →|\.)/);
  });

  it('says in the runbook what the desk loses by not running it, like every step before it', () => {
    expect(runbook).toContain('Saving needs migration step 44.');
    expect(runbook).toContain('44 degrades like 31–38.');
  });

  it('creates the table without dropping or rewriting anything', () => {
    expect(sql).toContain('create table if not exists public.algorithm_benchmarks');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/delete from/);
    expect(sql).not.toMatch(/truncate/);
  });

  it('carries every column the import writes, and the provenance of each row', () => {
    for (const column of [
      'source_vendor',
      'algorithm',
      'version',
      'instrument',
      'risk_level',
      'month',
      'trades',
      'trading_days',
      'contracts',
      'gross_profit',
      'commission',
      'net_profit',
      'win_rate',
      'max_drawdown',
      'commission_per_contract',
      'source_file',
      'imported_at',
      'imported_by_user_id',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('references public.app_users(id) on delete set null');
  });

  it('replaces a re-import instead of doubling it', () => {
    // Without this unique index the desk's next monthly download adds a second
    // copy of every historical month and no screen looks wrong.
    // `source_vendor` leads the key. Without it a second vendor's row for the
    // same series and month replaces the My Futures Book row instead of sitting
    // beside it, which is the opposite of what the column was added for.
    expect(sql).toMatch(
      /create unique index if not exists \w+ on public\.algorithm_benchmarks \(source_vendor, algorithm, version, instrument, risk_level, month\)/,
    );
  });

  it('refuses a row whose gross is not its net plus the commission already deducted', () => {
    // The vendor's `Profit` column is ALREADY net of its `Commission` column.
    // A writer that stored Profit as gross would double-count commission on
    // every figure drawn from these rows; it fails here instead.
    expect(sql).toMatch(/check \(abs\(gross_profit - \(net_profit \+ commission\)\) < 0\.01\)/);
  });

  it('keeps the risk level a named value that cannot be aggregated away', () => {
    // The same algorithm over identical history reads a win rate up to 19.8
    // points apart depending only on which risk file was opened, so the risk
    // level is part of the key and part of the domain.
    expect(sql).toMatch(/check \(risk_level in \('low', 'medium', 'high'\)\)/);
    expect(sql).toMatch(/\(source_vendor, algorithm, version, instrument, risk_level, month\)/);
  });

  it('pins a month to the first of the month, and the rest of the arithmetic to a magnitude', () => {
    expect(sql).toMatch(/check \(month = date_trunc\('month', month\)::date\)/);
    expect(sql).toMatch(/check \(win_rate is null or \(win_rate >= 0 and win_rate <= 1\)\)/);
    expect(sql).toMatch(/check \(max_drawdown >= 0\)/);
    expect(sql).toMatch(/check \(trades > 0 and trading_days > 0 and trading_days <= trades\)/);
  });

  it('closes the new table to the browser key itself, because step 43 has already run', () => {
    expect(sql).toContain('alter table public.algorithm_benchmarks enable row level security');
    expect(sql).toMatch(
      /create policy "authenticated full access" on public\.algorithm_benchmarks for all to authenticated using \(true\) with check \(true\)/,
    );
    // Nothing is handed to anon, by policy or by grant.
    expect(sql).not.toMatch(/to anon/);
    expect(sql).toMatch(/if not exists \( select 1 from pg_policies/);
    expect(sql).toMatch(/raise exception 'step 44 left % table\(s\) without row level security'/);
  });
});

describe('the table and the module that fills it agree', () => {
  const fixture = readFileSync(
    new URL('../test/fixtures/algorithm-benchmark/RBO_-_M2K_-_Low_Risk.sample.csv', import.meta.url),
    'utf8',
  );
  const rows = benchmarkMonthlyRows(
    buildBenchmarkSeries([parseBenchmarkCsv(fixture, 'RBO_-_M2K_-_Low_Risk.sample.csv')]),
  );

  it('produces rows this table would accept', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['Low', 'Medium', 'High']).toContain(row.riskLevel);
      expect(row.month).toMatch(/^\d{4}-\d{2}-01$/);
      expect(row.trades).toBeGreaterThan(0);
      expect(row.tradingDays).toBeGreaterThan(0);
      expect(row.tradingDays).toBeLessThanOrEqual(row.trades);
      expect(row.winRate).toBeGreaterThanOrEqual(0);
      expect(row.winRate).toBeLessThanOrEqual(1);
      expect(row.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(row.commission).toBeGreaterThanOrEqual(0);
      expect(Math.abs(row.grossProfit - (row.netProfit + row.commission))).toBeLessThan(0.01);
    }
  });

  it('produces one row per key the unique index names', () => {
    const keys = rows.map((row) =>
      [row.algorithm, row.version, row.instrument, row.riskLevel, row.month].join('|'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
