// The sheet, rendered over the real book.
//
// It reads public/local-snapshot.json, so vite.config.js drops it on every clone
// that does not hold the book and nothing here is pinned on CI. The rules are in
// DeskPeriodReportSheet.test.jsx. What is here is what needs 96 clients, 14
// closes and 17 algorithms to be sayable at all: that the page this desk will
// actually open says the things it must say, in the order it must say them, at
// the size the real data gives it.

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DeskPeriodReportSheet from './DeskPeriodReportSheet';
import { buildDeskPeriodReport } from '../domain/deskPeriodReport';
import { listPeriods, resolvePeriod } from '../domain/deskPeriod';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

function render(options) {
  const period = resolvePeriod(clients, options);
  const report = buildDeskPeriodReport(clients, {
    period, builtAt: '2026-09-18 14:22', builtBy: 'Pedro',
  });
  return {
    report,
    html: renderToStaticMarkup(
      <DeskPeriodReportSheet
        report={report}
        periods={listPeriods(clients, options.kind)}
        kind={options.kind}
        benchmarkRisk="Low"
      />,
    ),
  };
}

describe('the week the desk would be reporting on', () => {
  const { html, report } = render({ kind: 'week', key: '2026-07-27' });

  it('states the separation from My Futures Book before any figure', () => {
    expect(html).toContain('Not comparable to My Futures Book');
    expect(html.indexOf('Not comparable to My Futures Book'))
      .toBeLessThan(html.indexOf('How much of the desk this period holds'));
  });

  it('puts coverage before results, and results before the benchmark', () => {
    const coverage = html.indexOf('How much of the desk this period holds');
    const results = html.indexOf('Algorithm results in this period');
    const benchmark = html.indexOf('My Futures Book, measured separately');
    expect(coverage).toBeLessThan(results);
    expect(results).toBeLessThan(benchmark);
  });

  it('says out loud that the week is not complete, naming both causes', () => {
    expect(html).toContain('This period is not complete.');
    expect(html).toContain('2026-07-29, 2026-07-31');
  });

  it('renders the 3 closes it holds and the 2 weekdays it does not', () => {
    expect(html).toContain('3 closes of 5 weekdays');
    expect((html.match(/>No close</g) || [])).toHaveLength(2);
  });

  it('renders the five ranked algorithms and marks the rest Not ranked', () => {
    expect(report.results.rankedCount).toBe(5);
    expect((html.match(/Not ranked/g) || []).length).toBeGreaterThanOrEqual(7);
  });

  it('carries the desk’s money per account close and no total across businesses', () => {
    expect(html).toContain('P&amp;L per account close');
    expect(html).toContain('never summed');
    expect(html).not.toMatch(/>\s*Desk total\s*</);
  });

  it('holds no benchmark figure at all when no file has been imported, and says why', () => {
    expect(html).toContain('No My Futures Book file has been imported');
    expect(html).toContain('No agreement figure is stated');
    expect(report.benchmark.rows).toEqual([]);
    // The column headings and their basis clauses still render — a table that
    // vanished would take its own refusal with it — and every coverage row
    // reads `No series`.
    expect(html).toContain('Benchmark series in this period');
    expect(report.benchmark.coverage.rows.every((row) => !row.hasSeries)).toBe(true);
    // Twice per algorithm: once in the roster's own Benchmark column and once
    // in the coverage table, which is where a reader of either goes looking.
    expect((html.match(/>No series</g) || []).length)
      .toBe(report.benchmark.coverage.rows.length * 2);
  });

  it('is one sheet element, with every control outside it', () => {
    expect((html.match(/class="report-sheet"/g) || [])).toHaveLength(1);
    const sheet = html.slice(html.indexOf('class="report-sheet"'));
    expect(sheet).not.toContain('<select');
  });
});

describe('the whole month, which is the biggest page this book can produce', () => {
  const { html, report } = render({ kind: 'month', key: '2026-07' });

  it('renders 17 roster rows, 14 closes and 8 ranked algorithms without collapsing any of them', () => {
    expect(report.roster.rows).toHaveLength(17);
    expect(report.coverage.totals.closesInPeriod).toBe(14);
    expect(report.results.rankedCount).toBe(8);
    for (const row of report.roster.rows) {
      expect(html).toContain(row.algorithm);
    }
  });

  it('says the month has no month before it, on every column that would compare with one', () => {
    expect(html).toContain('The period before holds no close.');
    expect(report.period.priorEmpty).toBe(true);
  });

  it('prints the 50-fold coverage spread before any result', () => {
    expect(html).toContain('a factor of 50.57');
    expect(html.indexOf('a factor of 50.57'))
      .toBeLessThan(html.indexOf('Algorithm results in this period'));
  });

  it('caps the change table on screen and offers the rest rather than dropping them', () => {
    expect(report.changes.counts.decisions).toBe(239);
    expect(html).toContain('Show all 239 changes');
    expect(html).toContain('change in evidence, not a change somebody made');
  });

  it('stays under a megabyte of markup, so the PDF route can post it', () => {
    expect(html.length).toBeLessThan(1_000_000);
  });
});
