// The book-backed half of the desk period report suite.
//
// It reads public/local-snapshot.json, so vite.config.js drops it on every clone
// that does not hold the book and NOTHING HERE IS PINNED ON CI. The rules live
// in deskPeriodReport.test.js and deskPeriod.test.js, which are ungated. What is
// here is what needs 96 clients and 14 closes to be sayable at all: that the
// report's four questions get the answers this book actually holds, and that the
// numbers on the page are the numbers the modules under it produce.
//
// Every figure below was computed from the book by calling this repository's own
// modules and cross-checked against an independent day-level scan of the raw
// tables — the one in the branch's working notes, which reproduces
// `buildComboPerformance` exactly (896 funded account days, -$132,506.55, 599
// attributed, 297 Unknown). Those scripts were scratch work; this file is the
// reproducible record of what they found.
//
// THE BOOK IS ONE MONTH, THREE WEEKS AND FOURTEEN CLOSES, and that is the first
// thing the report has to be able to say out loud: there is no prior month to
// compare the month with, two of the last week's five weekdays hold no close at
// all, and coverage inside a single week moves by a factor of forty-eight.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDeskPeriodReport } from './deskPeriodReport';
import { listPeriods, resolvePeriod } from './deskPeriod';
import { buildBenchmarkSeries, parseBenchmarkCsv } from './algorithmBenchmark';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

// The committed 40-line sample of the desk's own download, so the benchmark
// blocks below are exercised without the 36 full files, which stay out of the
// repository.
const sampleSeries = buildBenchmarkSeries([parseBenchmarkCsv(
  readFileSync(
    new URL('../../test/fixtures/algorithm-benchmark/RBO_-_M2K_-_Low_Risk.sample.csv', import.meta.url),
    'utf8',
  ),
  'RBO_-_M2K_-_Low_Risk.sample.csv',
)]);

const reportFor = (options, extra = {}) => buildDeskPeriodReport(clients, {
  period: resolvePeriod(clients, options),
  ...extra,
});

const rosterRow = (report, algorithm) =>
  report.roster.rows.find((row) => row.algorithm === algorithm) || null;
const rankRow = (report, name) =>
  report.results.rows.find((row) => row.name === name) || null;
const movementRow = (report, name) =>
  report.movement.rows.find((row) => row.algorithm === name) || null;

const WEEK_27 = { kind: 'week', key: '2026-07-27' };
const WEEK_20 = { kind: 'week', key: '2026-07-20' };
const WEEK_13 = { kind: 'week', key: '2026-07-13' };
const MONTH = { kind: 'month', key: '2026-07' };

describe('what periods this book holds', () => {
  it('holds one month, 2026-07, and no month before it to compare it with', () => {
    const months = listPeriods(clients, 'month');
    expect(months.map((month) => month.key)).toEqual(['2026-07']);
    expect(months[0].closeCount).toBe(14);
    expect(resolvePeriod(clients, MONTH).priorEmpty).toBe(true);
  });

  it('holds three ISO weeks, of 5, 6 and 3 closes', () => {
    const weeks = listPeriods(clients, 'week');
    expect(weeks.map((week) => [week.key, week.closeCount]))
      .toEqual([['2026-07-27', 3], ['2026-07-20', 6], ['2026-07-13', 5]]);
  });

  it('runs 2026-07-13 to 2026-07-30 and holds no close on two weekdays inside that span', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-07-13', to: '2026-07-30' });
    expect([period.bookFirstClose, period.bookLastClose]).toEqual(['2026-07-13', '2026-07-30']);
    expect(period.closes).toHaveLength(14);
    // 07-31 is a Friday too, and it is outside a range that ends on the 30th.
    expect(period.missingWeekdays).toEqual(['2026-07-29']);
    expect(resolvePeriod(clients, { kind: 'custom', from: '2026-07-13', to: '2026-07-31' })
      .missingWeekdays).toEqual(['2026-07-29', '2026-07-31']);
  });

  it('holds one Saturday close, which is inside its week and outside its weekdays', () => {
    const period = resolvePeriod(clients, WEEK_20);
    expect(period.weekendCloses).toEqual(['2026-07-25']);
    expect(period.closes).toHaveLength(6);
    expect(period.weekdays).toBe(5);
  });
});

describe('coverage, Week of 2026-07-27', () => {
  const report = reportFor(WEEK_27);

  it('is partial on both counts and names both', () => {
    expect(report.period.partial).toBe(true);
    expect(report.period.partialReasons.join(' '))
      .toContain("It runs to 2026-08-02 and the book's newest close is 2026-07-30.");
    expect(report.period.partialReasons.join(' ')).toContain('2026-07-29, 2026-07-31');
  });

  it('holds 3 closes, 61 clients, 376 accounts and 960 account closes', () => {
    expect(report.coverage.totals.closesInPeriod).toBe(3);
    expect(report.coverage.totals.clientsReporting).toBe(61);
    expect(report.coverage.totals.accountsReporting).toBe(376);
    expect(report.coverage.totals.accountCloses).toBe(960);
  });

  it('gives the two weekdays with no close a No close row rather than a zero', () => {
    const missing = report.coverage.rows.filter((row) => row.noClose);
    expect(missing.map((row) => row.date)).toEqual(['2026-07-29', '2026-07-31']);
    expect(missing.every((row) => row.accountsReporting === null)).toBe(true);
  });

  it('is the book’s evenest week: 312 to 326 account rows, a factor of 1.04', () => {
    expect(report.coverage.totals.fullestClose)
      .toMatchObject({ date: '2026-07-30', accounts: 326 });
    expect(report.coverage.totals.thinnestClose)
      .toMatchObject({ date: '2026-07-28', accounts: 312 });
    expect(report.coverage.totals.coverageRatio).toBe(1.04);
  });
});

describe('coverage, Week of 2026-07-20', () => {
  const report = reportFor(WEEK_20);

  it('runs from 7 account rows to 338, a factor of 48, inside one week', () => {
    expect(report.coverage.totals.fullestClose)
      .toMatchObject({ date: '2026-07-23', accounts: 338, clients: 62 });
    expect(report.coverage.totals.thinnestClose)
      .toMatchObject({ date: '2026-07-25', accounts: 7, clients: 1 });
    expect(report.coverage.totals.coverageRatio).toBe(48.29);
  });

  it('prints that factor in the sentence the reader is given before any result', () => {
    expect(report.coverage.sentence)
      .toContain('from 7 to 338 account rows per close, a factor of 48.29');
  });
});

describe('closes that arrived late', () => {
  it('finds 45 of the month’s closes imported at least a day after their trading date', () => {
    expect(reportFor(MONTH).coverage.totals.closesThatArrivedLate).toBe(45);
  });

  it('finds 2 of Week of 2026-07-13’s closes landing after that week ended', () => {
    const report = reportFor(WEEK_13);
    expect(report.coverage.totals.closesThatArrivedLate).toBe(34);
    expect(report.coverage.totals.closesThatArrivedAfterThePeriod).toBe(2);
  });
});

describe('the prior period, where there is none', () => {
  const report = reportFor(WEEK_13);

  it('is empty for the book’s first week and every money column says so', () => {
    expect(report.period.priorEmpty).toBe(true);
    expect(report.money.prior).toBeNull();
    for (const row of report.money.rows) {
      expect(row.priorPerAccountClose).toBeNull();
      expect(row.changeRefusal).toBe('The period before holds no close.');
    }
  });

  it('is empty for the month, so the monthly report has no comparison column at all', () => {
    const month = reportFor(MONTH);
    expect(month.period.priorEmpty).toBe(true);
    expect(month.movement.drawable).toEqual([]);
    expect(movementRow(month, 'URGO').changeRefusal).toBe('The period before holds no close.');
  });
});

describe('results, Week of 2026-07-27', () => {
  const report = reportFor(WEEK_27);

  it('ranks 5 of 12 algorithms and leaves the rest with their counts and no position', () => {
    expect(report.results.rankedCount).toBe(5);
    expect(report.results.unrankedCount).toBe(7);
    expect(report.results.rows.filter((row) => row.ranked).map((row) => row.name))
      .toEqual(['G4M', 'URGO', 'IFSP', 'RBO', 'B2X']);
  });

  it('clears the gate for URGO and refuses it for OGX, with OGX’s counts kept', () => {
    expect(rankRow(report, 'URGO')).toMatchObject({ ranked: true, accountDays: 69, accounts: 42 });
    const ogx = rankRow(report, 'OGX');
    expect(ogx.ranked).toBe(false);
    expect(ogx.accountDays).toBe(17);
    expect(ogx.rankRefusal).toContain('17 reported account-days');
  });

  it('publishes no dollar keyed to a single algorithm anywhere in results or movement', () => {
    // The same guard algorithmRanking.book.test.js applies to the detail view:
    // a key holding one number for an algorithm is a key the next caller sums,
    // which is how `total` came back on the desk-money rows the first time.
    // `accountsProfitable` and `accountsProfitablePct` are COUNTS of accounts,
    // named apart here so the scan can stay on names and not on values.
    const counts = new Set(['accountsProfitable', 'accountsProfitablePct']);
    const scan = (value, path = '') => {
      if (!value || typeof value !== 'object') return;
      for (const [key, held] of Object.entries(value)) {
        if (!counts.has(key) && /total|pnl|profit/i.test(key) && typeof held === 'number') {
          throw new Error(`${path}.${key} carries a number: ${held}`);
        }
        scan(held, `${path}.${key}`);
      }
    };
    expect(() => scan(report.results, 'results')).not.toThrow();
    expect(() => scan(report.movement, 'movement')).not.toThrow();
    // `roster.counts` is a block of counts by construction; the rows are where
    // a money field could hide, so the scan is pointed at them.
    expect(() => scan(report.roster.rows, 'roster.rows')).not.toThrow();
  });

  it('keeps Bullet Bot off the ranking and on its own row with its counts', () => {
    expect(rankRow(report, 'Bullet Bot')).toBeNull();
    const month = reportFor(MONTH);
    expect(month.results.programmes.map((row) => [row.name, row.accountDays, row.accounts]))
      .toEqual([['Bullet Bot', 337, 115]]);
    expect(month.results.programmes[0].rankRefusal).toContain('Not ranked here');
  });
});

describe('results, over the whole month', () => {
  const report = reportFor(MONTH);

  it('ranks 8 algorithms once a full month of this desk’s coverage is in the window', () => {
    expect(report.results.rankedCount).toBe(8);
    expect(report.results.rows.filter((row) => row.ranked).map((row) => row.name))
      .toEqual(['ARPD', 'OGX', 'URGO', 'B2X', 'IFSP', 'G4M', 'RBO', 'SYFY']);
  });

  it('measures every ranked algorithm as losing money per account day', () => {
    for (const row of report.results.rows.filter((entry) => entry.ranked)) {
      expect(row.meanPerAccountDay).toBeLessThan(0);
    }
  });
});

describe('movement, Week of 2026-07-27 against Week of 2026-07-20', () => {
  const report = reportFor(WEEK_27);

  it('compares two windows only where both clear the gate, and names the counts where not', () => {
    expect(report.movement.drawable.map((row) => row.algorithm).sort())
      .toEqual(['B2X', 'G4M', 'IFSP', 'RBO', 'URGO']);
    const arpd = movementRow(report, 'ARPD');
    expect(arpd.change).toBeNull();
    expect(arpd.changeRefusal).toContain('19 account-days over 12 accounts here, 23 over 11 then');
  });

  it('finds URGO and B2X crossing from a positive mean to a negative one', () => {
    expect(movementRow(report, 'URGO')).toMatchObject({
      priorMean: 29.24, periodMean: -52.64, change: -81.88, crossedIntoLoss: true, reading: 'Moved down',
    });
    expect(movementRow(report, 'B2X')).toMatchObject({
      priorMean: 32.38, periodMean: -146.63, crossedIntoLoss: true, reading: 'Moved down',
    });
  });

  it('carries the book to date beside them and states that it contains this period', () => {
    const urgo = movementRow(report, 'URGO');
    expect(urgo.bookMean).toBe(-22.04);
    expect(urgo.bookAccountDays).toBe(216);
    expect(report.movement.bookNote).toContain('CONTAINS this period');
  });

  it('finds four of the five comparable algorithms moved down', () => {
    const down = report.movement.drawable.filter((row) => row.reading === 'Moved down');
    expect(down.map((row) => row.algorithm).sort()).toEqual(['B2X', 'IFSP', 'RBO', 'URGO']);
  });
});

describe('the roster', () => {
  it('marks 15 algorithms Running on 2026-07-30 over the whole month', () => {
    const report = reportFor(MONTH);
    expect(report.roster.counts.running).toBe(15);
    expect(report.roster.lastClose).toBe('2026-07-30');
    expect(rosterRow(report, 'URGO 4.5').state).toBe('Running');
    expect(rosterRow(report, 'Bullet Bot 1.1').state).toBe('Running');
  });

  it('marks SYFY_PF 1.4 and ARPD_PF 1.1 Stopped over the whole month, with their last dates', () => {
    const report = reportFor(MONTH);
    expect(rosterRow(report, 'SYFY_PF 1.4')).toMatchObject({ state: 'Stopped', lastSeen: '2026-07-24' });
    expect(rosterRow(report, 'ARPD_PF 1.1')).toMatchObject({ state: 'Stopped', lastSeen: '2026-07-28' });
  });

  it('refuses New over the month, because the month starts on the book’s first close', () => {
    const report = reportFor(MONTH);
    expect(report.roster.newMeasurable).toBe(false);
    expect(report.roster.counts.new).toBe(0);
    expect(report.roster.newRefusal).toContain('2026-07-13');
  });

  it('reports MST 3.3 and FSA 2.2, first seen 07-22 and 07-23, as running on the last close', () => {
    const report = reportFor(MONTH);
    expect(rosterRow(report, 'MST 3.3')).toMatchObject({
      state: 'Running', firstSeen: '2026-07-22', lastSeen: '2026-07-30', accountsInPeriod: 1,
    });
    expect(rosterRow(report, 'FSA 2.2')).toMatchObject({
      state: 'Running', firstSeen: '2026-07-23', accountsInPeriod: 1,
    });
  });

  it('publishes the coverage of the close its states are decided on, and warns when it is thin', () => {
    const thin = reportFor(WEEK_20);
    expect(thin.roster.lastClose).toBe('2026-07-25');
    expect(thin.roster.lastCloseAccounts).toBe(7);
    expect(thin.roster.lastCloseShareOfFullest).toBe(2);
    expect(thin.roster.thinLastCloseNote).toContain('2% of the 338');
    const even = reportFor(WEEK_27);
    expect(even.roster.thinLastClose).toBe(false);
  });

  it('names one version per family on this book, prop-firm variants kept apart', () => {
    const report = reportFor(MONTH);
    const names = report.roster.rows.map((row) => row.algorithm);
    expect(names).toContain('IFSP 1.1');
    expect(names).toContain('IFSP_PF 1.1');
    expect(new Set(names.map((name) => name.split(' ').slice(0, -1).join(' '))).size)
      .toBe(names.length);
  });
});

describe('the stack', () => {
  it('finds ARPD + URGO best in Week of 2026-07-20, at +$121.67 over 10 account days on 7 accounts', () => {
    const report = reportFor(WEEK_20);
    expect(report.stack.best.key).toBe('ARPD 1.1 + URGO 4.5');
    expect(report.stack.best.avgPnl).toBeCloseTo(121.67, 2);
    expect(report.stack.best.days).toBe(10);
    expect(report.stack.best.accounts).toBe(7);
  });

  it('finds the same combination fifth and losing in the week after, from 6 of the same accounts', () => {
    const report = reportFor(WEEK_27);
    const row = report.stack.rows.find((entry) => entry.key === 'ARPD 1.1 + URGO 4.5');
    expect(row.avgPnl).toBeCloseTo(-257.12, 2);
    expect(row.days).toBe(12);
    expect(row.accounts).toBe(6);
    expect(row.rankLastPeriod).toBe(1);
    expect(report.stack.rankNote).toContain('not a trend');
  });

  it('crowns nothing in Week of 2026-07-27 and Week of 2026-07-13, and says which refusal it is', () => {
    for (const options of [WEEK_27, WEEK_13]) {
      const report = reportFor(options);
      expect(report.stack.best).toBeNull();
      expect(report.stack.bestNote).toBe('No combo with a positive average passes the sample gate');
      expect(report.stack.gatedCount).toBeGreaterThan(0);
    }
  });

  it('measures the same funded population comboPerformance measures, over the whole month', () => {
    const report = reportFor(MONTH);
    expect(report.stack.perf.population.fundedDays).toBe(896);
    expect(report.stack.perf.population.includedDays).toBe(599);
    expect(report.stack.perf.population.unknownDays).toBe(297);
    expect(report.stack.perf.population.fundedPnl).toBeCloseTo(-132506.55, 2);
  });
});

describe('money', () => {
  const report = reportFor(WEEK_27);

  it('states four businesses, never a total, each per account close', () => {
    expect(report.money.rows.map((row) => [row.key, row.accounts, row.perAccountClose]))
      .toEqual([
        ['bulletBot', 413, -259.28],
        ['propOther', 412, -207.61],
        ['cash', 101, -467.68],
        ['unclassified', 19, -199.64],
      ]);
    expect(report.money.desk.rows.some((row) => row.key === 'total')).toBe(false);
  });

  it('compares with the week before per account close and never in totals', () => {
    const cash = report.money.rows.find((row) => row.key === 'cash');
    expect(cash.priorPerAccountClose).toBe(-116.88);
    expect(cash.change).toBe(-350.8);
    expect(cash.priorAccountCloses).toBe(126);
  });

  it('refuses a balance over the range on every row, with the module’s own words', () => {
    for (const row of report.money.rows) {
      expect(row.balance).toBeNull();
      expect(row.refusals.balance).toBeTruthy();
    }
  });
});

describe('the benchmark, against the committed sample', () => {
  const report = reportFor(MONTH, { benchmarkSeries: sampleSeries, benchmarkRisk: 'Low' });

  it('reads the sample as one RBO 1.8 series on M2K at Low risk', () => {
    expect(sampleSeries).toHaveLength(1);
    expect(sampleSeries[0]).toMatchObject({
      algorithm: 'RBO', version: '1.8', instrument: 'M2K', riskLevel: 'Low',
    });
  });

  it('joins it to the desk’s RBO on name and version, and on nothing else', () => {
    const row = report.benchmark.coverage.rows.find((entry) => entry.algorithm === 'RBO');
    expect(row.hasSeries).toBe(true);
    expect(row.versionMatch).toBe('yes');
    expect(row.instrumentsHere).toEqual(['M2K']);
    expect(row.instrumentsThere).toEqual(['M2K']);
  });

  it('refuses every agreement figure: the sample ends in 2020 and the book starts in 2026', () => {
    const row = report.benchmark.coverage.rows.find((entry) => entry.algorithm === 'RBO');
    expect(row.commonCloses).toBe(0);
    expect(row.comparable).toBe(false);
    expect(report.benchmark.coverage.comparableCount).toBe(0);
    expect(report.benchmark.coverage.refusal).toContain('No agreement figure is stated');
  });

  it('gives every prop-firm variant No series rather than the base family’s file', () => {
    const pf = report.benchmark.coverage.rows.filter((row) => row.algorithm.endsWith('_PF'));
    expect(pf.length).toBeGreaterThan(0);
    for (const row of pf) {
      expect(row.hasSeries).toBe(false);
    }
    expect(report.benchmark.coverage.rows.find((row) => row.algorithm === 'RBO_PF').seriesNote)
      .toContain('RBO has one');
  });

  it('keeps every benchmark dollar out of the client blocks of the same report', () => {
    const scan = JSON.stringify({
      coverage: report.coverage,
      money: report.money,
      roster: report.roster,
      results: report.results,
      movement: report.movement,
      stack: report.stack,
    });
    expect(scan).not.toContain('netProfit');
    expect(scan).not.toContain('My Futures Book');
    expect(scan).not.toContain('Backtest');
  });

  it('says so plainly when no file has been imported at all', () => {
    const none = reportFor(MONTH);
    expect(none.benchmark.imported).toBe(false);
    expect(none.benchmark.emptyReason).toContain('No My Futures Book file has been imported');
    expect(none.benchmark.rows).toEqual([]);
  });
});

describe('what the whole report costs and what it stamps', () => {
  it('records the book’s bounds, the closes it saw and the newest import inside the period', () => {
    const report = reportFor(WEEK_27);
    expect(report.stamp.bookFirstClose).toBe('2026-07-13');
    expect(report.stamp.bookLastClose).toBe('2026-07-30');
    expect(report.stamp.closesInPeriod).toBe(3);
    expect(report.stamp.accountCloses).toBe(960);
    expect(report.stamp.latestImportedAt).toBeTruthy();
    expect(report.stamp.moduleVersions).toEqual({
      comboPerformance: 'traded/version', evidenceGate: '30/10', sampleGate: '10/3',
    });
  });

  it('builds a whole month of this book in under four seconds', () => {
    const started = Date.now();
    reportFor(MONTH);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
