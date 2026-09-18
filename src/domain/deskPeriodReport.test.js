// The rules the desk period report must never break, on fixtures.
//
// UNGATED ON PURPOSE. This file reads no snapshot, so it runs on CI and on every
// clone. The figures measured off the real book live in
// deskPeriodReport.book.test.js, which vite.config.js drops on a clone without
// the book and which therefore pins nothing on CI.
//
// Every fixture here is built so that breaking the rule under test produces a
// SPECIFIC wrong answer this file names, rather than "a number changed".

import { describe, expect, it } from 'vitest';
import {
  MIN_CLOSES_FOR_MONEY_CHANGE,
  buildDeskPeriodReport,
  formatDeskPeriodReport,
  periodReportRefusals,
  splitElement,
} from './deskPeriodReport';
import { buildDeskMoney, buildDeskMoneyForRange, deskRow } from './deskMoney';
import { buildStrategyRanking } from './algorithmRanking';
import { resolvePeriod } from './deskPeriod';

/* ---------------------------------------------------------------- */
/* Fixtures.                                                         */

function strat(algo, {
  realized, version = '1.0', instrument = 'MNQ SEP26', enabled = true,
} = {}) {
  const row = {
    strategyFamily: algo,
    strategyVersion: version,
    instrument,
    enabled,
    params: { profitTargets: [100, 200, 300], stopLossTicks: 50, posSizes: [1, 1, 0] },
  };
  if (realized !== undefined) row.realized = realized;
  return row;
}

/**
 * `accountCount` accounts of one type, each carrying one algorithm on every one
 * of `dates`, each account day making `pnl`.
 */
function bulkClient({
  id = 'c1', algo = 'RBO', version = '1.0', accountType = 'Funded',
  accountCount = 12, dates = [], pnl = -100, importedAt = null, instrument = 'MNQ SEP26',
} = {}) {
  const accounts = Array.from({ length: accountCount }, (_, index) => `${id}-A${index + 1}`);
  const accountRegistry = {};
  for (const accountName of accounts) {
    accountRegistry[accountName] = { accountName, accountType, status: 'Active' };
  }
  return {
    id,
    name: id,
    accountRegistry,
    dailyImports: dates.map((date) => ({
      id: `${id}-${date}`,
      date,
      importedAt: importedAt ? importedAt(date) : `${date}T22:00:00Z`,
      snapshots: accounts.map((accountName) => ({
        accountName,
        grossRealizedPnl: pnl,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies: [strat(algo, { realized: pnl, version, instrument })],
      })),
      executions: [],
      flags: [],
    })),
  };
}

const WEEK_TWO = ['2026-07-27', '2026-07-28', '2026-07-30'];
const WEEK_ONE = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];

/** A book whose two weeks both clear the evidence gate on one algorithm. */
function twoWeekBook({ recentPnl = -200, priorPnl = -100 } = {}) {
  return [
    bulkClient({ id: 'c1', algo: 'RBO', accountCount: 12, dates: WEEK_ONE, pnl: priorPnl }),
    bulkClient({ id: 'c2', algo: 'RBO', accountCount: 12, dates: WEEK_TWO, pnl: recentPnl }),
  ];
}

const periodFor = (clients, options) => resolvePeriod(clients, options);
const build = (clients, options, extra = {}) =>
  buildDeskPeriodReport(clients, { period: periodFor(clients, options), ...extra });
const movementRow = (report, name) =>
  report.movement.rows.find((row) => row.algorithm === name) || null;
const rosterRow = (report, algorithm) =>
  report.roster.rows.find((row) => row.algorithm === algorithm) || null;

/* ---------------------------------------------------------------- */

describe('window boundaries are inclusive at both ends', () => {
  const clients = [bulkClient({ accountCount: 2, dates: ['2026-07-27', '2026-07-30', '2026-08-03'] })];

  it('holds the close on `from` and the close on `to`, and nothing outside them', () => {
    const report = build(clients, { kind: 'custom', from: '2026-07-27', to: '2026-07-30' });
    expect(report.coverage.rows.filter((row) => !row.noClose).map((row) => row.date))
      .toEqual(['2026-07-27', '2026-07-30']);
    expect(report.coverage.totals.closesInPeriod).toBe(2);
  });

  it('excludes a close one day past `to`, rather than rounding the week up', () => {
    const report = build(clients, { kind: 'custom', from: '2026-07-27', to: '2026-08-02' });
    expect(report.coverage.rows.filter((row) => !row.noClose).map((row) => row.date))
      .toEqual(['2026-07-27', '2026-07-30']);
  });

  it('gives a weekday with no close a row that says No close, never a zero', () => {
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    const missing = report.coverage.rows.filter((row) => row.noClose);
    expect(missing.map((row) => row.date)).toEqual(['2026-07-28', '2026-07-29', '2026-07-31']);
    for (const row of missing) {
      expect(row.accountsReporting).toBeNull();
      expect(row.clientsReporting).toBeNull();
      expect(row.accountDaysWithPnl).toBeNull();
    }
  });
});

describe('coverage', () => {
  const clients = [
    bulkClient({ id: 'big', accountCount: 10, dates: ['2026-07-27'] }),
    bulkClient({ id: 'small', accountCount: 1, dates: ['2026-07-27', '2026-07-30'] }),
  ];
  const report = build(clients, { kind: 'week', key: '2026-07-27' });

  it('counts account closes, not accounts: the same account is one per close it filed', () => {
    expect(report.coverage.totals.accountsReporting).toBe(11);
    expect(report.coverage.totals.accountCloses).toBe(12);
  });

  it('names the fullest and thinnest close and the factor between them', () => {
    expect(report.coverage.totals.fullestClose).toMatchObject({ date: '2026-07-27', accounts: 11 });
    expect(report.coverage.totals.thinnestClose).toMatchObject({ date: '2026-07-30', accounts: 1 });
    expect(report.coverage.totals.coverageRatio).toBe(11);
  });

  it('prints the coverage factor in the sentence under the table, from its own numbers', () => {
    expect(report.coverage.sentence).toContain('from 1 to 11 account rows per close, a factor of 11');
    expect(report.coverage.sentence).toContain('no two periods are compared in dollars');
  });

  it('excludes accounts marked Inactive / Ignore from every count', () => {
    const withIgnored = [
      bulkClient({ id: 'live', accountCount: 2, dates: ['2026-07-27'] }),
      bulkClient({ id: 'shelved', accountCount: 5, dates: ['2026-07-27'], accountType: 'Inactive / Ignore' }),
    ];
    const built = build(withIgnored, { kind: 'week', key: '2026-07-27' });
    expect(built.coverage.totals.accountCloses).toBe(2);
  });

  it('counts a close as late when its import landed on a later calendar date, and not otherwise', () => {
    const late = [bulkClient({
      id: 'late', accountCount: 1, dates: ['2026-07-27', '2026-07-30'],
      importedAt: (date) => (date === '2026-07-27' ? '2026-07-29T09:00:00Z' : `${date}T20:00:00Z`),
    })];
    const built = build(late, { kind: 'week', key: '2026-07-27' });
    expect(built.coverage.totals.closesThatArrivedLate).toBe(1);
    expect(built.coverage.rows.find((row) => row.date === '2026-07-27').arrivedLate).toBe(1);
    expect(built.coverage.rows.find((row) => row.date === '2026-07-30').arrivedLate).toBe(0);
  });

  it('counts a close that arrived after the period ended separately from one merely late', () => {
    const late = [bulkClient({
      id: 'late', accountCount: 1, dates: ['2026-07-27'],
      importedAt: () => '2026-08-10T09:00:00Z',
    })];
    const built = build(late, { kind: 'week', key: '2026-07-27' });
    expect(built.coverage.totals.closesThatArrivedLate).toBe(1);
    expect(built.coverage.totals.closesThatArrivedAfterThePeriod).toBe(1);
  });
});

describe('money over a range', () => {
  const clients = twoWeekBook();

  it('equals the sum of each close’s own desk money, per row', () => {
    const range = buildDeskMoneyForRange(clients, { from: '2026-07-27', to: '2026-07-30' });
    const each = WEEK_TWO.map((date) => buildDeskMoney(clients, { asOfDate: date }));
    const summed = each.reduce(
      (total, desk) => total + deskRow(desk, 'propOther').dailyPnl, 0,
    );
    expect(deskRow(range, 'propOther').dailyPnl).toBeCloseTo(summed, 2);
  });

  it('refuses the weekly column and the balance over a range, with the module’s own words', () => {
    const range = buildDeskMoneyForRange(clients, { from: '2026-07-27', to: '2026-07-30' });
    for (const row of range.rows) {
      expect(row.weeklyPnl).toBeNull();
      expect(row.balance).toBeNull();
      expect(row.refusals.weeklyPnl).toContain('counts the same trades once per close');
      expect(row.refusals.balance).toBeTruthy();
    }
  });

  it('calls its count an account close, because the same account is read once per close', () => {
    const range = buildDeskMoneyForRange(clients, { from: '2026-07-27', to: '2026-07-30' });
    expect(range.basis.countNoun).toBe('account close');
    expect(range.basis.label).toContain('Every close from 2026-07-27 to 2026-07-30');
  });

  it('states the change between two periods per account close and never as two totals', () => {
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    const row = report.money.rows.find((entry) => entry.key === 'propOther');
    expect(row.perAccountClose).toBe(-200);
    expect(row.priorPerAccountClose).toBe(-100);
    expect(row.change).toBe(-100);
  });

  it(`withholds the change under ${MIN_CLOSES_FOR_MONEY_CHANGE} account closes on either side`, () => {
    const thin = [
      bulkClient({ id: 'prior', accountCount: 12, dates: WEEK_ONE, pnl: -100 }),
      bulkClient({ id: 'thin', accountCount: 2, dates: ['2026-07-27'], pnl: -500 }),
    ];
    const report = build(thin, { kind: 'week', key: '2026-07-27' });
    const row = report.money.rows.find((entry) => entry.key === 'propOther');
    expect(row.perAccountClose).toBe(-500);
    expect(row.change).toBeNull();
    expect(row.changeRefusal).toContain('2 account closes in this period');
    expect(row.changeRefusal).toContain(String(MIN_CLOSES_FOR_MONEY_CHANGE));
  });

  it('says the period before holds no close rather than printing a change against nothing', () => {
    const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-20' });
    expect(report.period.priorEmpty).toBe(true);
    expect(report.money.prior).toBeNull();
    for (const row of report.money.rows) {
      expect(row.priorPerAccountClose).toBeNull();
      expect(row.change).toBeNull();
      expect(row.changeRefusal).toBe('The period before holds no close.');
    }
  });

  it('publishes no total across the four businesses, on the object or in the text', () => {
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    expect(report.money.desk.total).toBeUndefined();
    expect(Object.keys(report.money)).not.toContain('total');
    expect(report.money.rowsDoNotSum).toContain('never summed');
  });
});

describe('the ranking, scoped to the period', () => {
  const clients = twoWeekBook();

  it('counts only the account days inside the range when fromDate is set', () => {
    const scoped = buildStrategyRanking(clients, { fromDate: '2026-07-27', asOfDate: '2026-07-30' });
    const whole = buildStrategyRanking(clients, { asOfDate: '2026-07-30' });
    expect(scoped.ranking.rows[0].accountDays).toBe(36); // 12 accounts x 3 closes
    expect(whole.ranking.rows[0].accountDays).toBe(84); // plus 12 x 4 in the week before
  });

  it('names the range in the basis label rather than claiming every close', () => {
    const scoped = buildStrategyRanking(clients, { fromDate: '2026-07-27', asOfDate: '2026-07-30' });
    expect(scoped.basis.label).toContain('Closes from 2026-07-27 to 2026-07-30');
    expect(scoped.basis.label).not.toContain('Every close');
    expect(scoped.basis.fromDate).toBe('2026-07-27');
  });

  it('leaves every existing caller byte identical when fromDate and windows are absent', () => {
    const before = buildStrategyRanking(clients, { asOfDate: '2026-07-30' });
    const after = buildStrategyRanking(clients, { asOfDate: '2026-07-30', fromDate: '', windows: null });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(before.ranking.rows[0].trendRefusal || '').not.toContain('this period');
  });

  it('takes the two means over explicit window bounds and labels its refusal with them', () => {
    const windows = {
      recentFrom: '2026-07-27',
      recentTo: '2026-07-30',
      priorFrom: '2026-07-20',
      priorTo: '2026-07-26',
      recentLabel: 'this period',
      priorLabel: 'the period before',
    };
    const result = buildStrategyRanking(clients, { asOfDate: '2026-07-30', windows });
    const row = result.ranking.rows[0];
    expect(row.recentMeanPerAccountDay).toBe(-200);
    expect(row.priorMeanPerAccountDay).toBe(-100);
    expect(row.recentAccountDays).toBe(36);
    expect(row.priorAccountDays).toBe(48);

    const oneSided = buildStrategyRanking(
      [bulkClient({ accountCount: 12, dates: WEEK_TWO })],
      { asOfDate: '2026-07-30', windows },
    );
    expect(oneSided.ranking.rows[0].trendRefusal)
      .toBe('Only one of this period and the period before measured this '
        + '(36 account-days in this period, 0 in the period before), '
        + 'so there is nothing to compare it with.');
  });
});

describe('movement', () => {
  it('states the change when both windows clear the evidence gate', () => {
    const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-27' });
    const row = movementRow(report, 'RBO');
    expect(row.periodMean).toBe(-200);
    expect(row.priorMean).toBe(-100);
    expect(row.change).toBe(-100);
    expect(row.reading).toBe('Moved down');
    expect(row.drawable).toBe(true);
  });

  it('calls no change inside a tenth of the prior window’s magnitude', () => {
    const report = build(twoWeekBook({ recentPnl: -105, priorPnl: -100 }), { kind: 'week', key: '2026-07-27' });
    expect(movementRow(report, 'RBO').reading).toBe('No change shown');
  });

  it('reads a smaller loss as a move up, which a multiplicative bar would invert', () => {
    const report = build(twoWeekBook({ recentPnl: -50, priorPnl: -100 }), { kind: 'week', key: '2026-07-27' });
    const row = movementRow(report, 'RBO');
    expect(row.change).toBe(50);
    expect(row.reading).toBe('Moved up');
  });

  it('withholds the change when this period falls under the gate, and says which counts', () => {
    const thin = [
      bulkClient({ id: 'prior', accountCount: 12, dates: WEEK_ONE, pnl: -100 }),
      bulkClient({ id: 'thin', accountCount: 2, dates: WEEK_TWO, pnl: -900 }),
    ];
    const report = build(thin, { kind: 'week', key: '2026-07-27' });
    const row = movementRow(report, 'RBO');
    expect(row.periodMean).toBe(-900);
    expect(row.change).toBeNull();
    expect(row.drawable).toBe(false);
    expect(row.changeRefusal).toContain('6 account-days over 2 accounts here');
    expect(row.changeRefusal).toContain('48 over 12 then');
  });

  it('withholds the change when the period before falls under the gate', () => {
    const thin = [
      bulkClient({ id: 'prior', accountCount: 2, dates: WEEK_ONE, pnl: -100 }),
      bulkClient({ id: 'now', accountCount: 12, dates: WEEK_TWO, pnl: -200 }),
    ];
    const report = build(thin, { kind: 'week', key: '2026-07-27' });
    expect(movementRow(report, 'RBO').change).toBeNull();
  });

  it('carries the book to date as its own column and says it contains this period', () => {
    const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-27' });
    const row = movementRow(report, 'RBO');
    // 36 account days at -$200 and 48 at -$100, pooled.
    expect(row.bookAccountDays).toBe(84);
    expect(row.bookMean).toBeCloseTo(-142.86, 2);
    expect(report.movement.bookNote).toContain('CONTAINS this period');
  });

  it('draws nothing at all when the period before holds no close', () => {
    const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-20' });
    expect(report.movement.drawable).toEqual([]);
    expect(movementRow(report, 'RBO').changeRefusal).toBe('The period before holds no close.');
  });
});

describe('the roster', () => {
  const clients = [
    // Runs throughout.
    bulkClient({ id: 'alive', algo: 'URGO', version: '4.5', accountCount: 3, dates: [...WEEK_ONE, ...WEEK_TWO] }),
    // Ran inside the period and was gone by its last close.
    bulkClient({ id: 'stops', algo: 'SYFY', version: '1.4', accountCount: 1, dates: ['2026-07-22', '2026-07-27'] }),
    // First appears inside the period, still running on its last close.
    bulkClient({ id: 'starts', algo: 'MST', version: '3.3', accountCount: 1, dates: ['2026-07-28', '2026-07-30'] }),
    // In the book before the period and absent from it.
    bulkClient({ id: 'gone', algo: 'DJDR', version: '1.1', accountCount: 1, dates: ['2026-07-20'] }),
  ];
  const report = build(clients, { kind: 'week', key: '2026-07-27' });

  it('marks an algorithm carried on the last close as Running, and buckets it alive', () => {
    expect(rosterRow(report, 'URGO 4.5')).toMatchObject({ state: 'Running', bucket: 'alive' });
  });

  it('marks an algorithm that ran in the period and not on its last close as Stopped, bucket recent', () => {
    expect(rosterRow(report, 'SYFY 1.4')).toMatchObject({ state: 'Stopped', bucket: 'recent' });
  });

  it('marks an algorithm absent from the period as Not seen, bucket history', () => {
    expect(rosterRow(report, 'DJDR 1.1')).toMatchObject({ state: 'Not seen', bucket: 'history' });
  });

  it('never calls the history bucket retired: the note states the rule instead', () => {
    expect(report.roster.stateNote).toContain('no account in this population carried it inside');
    expect(report.roster.stateNote).toContain('does not mean retired');
  });

  it('marks a first appearance inside the period as New when the book has history before it', () => {
    expect(rosterRow(report, 'MST 3.3')).toMatchObject({ state: 'New, running', isNew: true });
    expect(report.roster.newMeasurable).toBe(true);
  });

  it('refuses New altogether when the period starts on the book’s first close', () => {
    const whole = build(clients, { kind: 'custom', from: '2026-07-20', to: '2026-07-30' });
    expect(whole.roster.newMeasurable).toBe(false);
    expect(whole.roster.rows.every((row) => row.isNew === false)).toBe(true);
    expect(whole.roster.newRefusal).toContain('the export begins here');
  });

  it('carries counts and dates only: no mean and no dollar reaches a roster row', () => {
    for (const row of report.roster.rows) {
      for (const key of Object.keys(row)) {
        expect(key).not.toMatch(/pnl|profit|mean|total/i);
      }
    }
  });

  it('separates a family from its prop-firm variant', () => {
    const both = [
      bulkClient({ id: 'a', algo: 'IFSP', version: '1.1', accountCount: 2, dates: WEEK_TWO }),
      bulkClient({ id: 'b', algo: 'IFSP_PF', version: '1.1', accountCount: 2, dates: WEEK_TWO }),
    ];
    const built = build(both, { kind: 'week', key: '2026-07-27' });
    expect(built.roster.rows.map((row) => row.algorithm).sort())
      .toEqual(['IFSP 1.1', 'IFSP_PF 1.1']);
  });

  it('reports instruments by contract root, not by contract month', () => {
    const named = [bulkClient({
      id: 'x', algo: 'OGX', version: '2.4', accountCount: 2, dates: WEEK_TWO, instrument: 'MNQ SEP26',
    })];
    const built = build(named, { kind: 'week', key: '2026-07-27' });
    expect(rosterRow(built, 'OGX 2.4').instruments.map((entry) => entry.name)).toEqual(['MNQ']);
  });
});

describe('splitElement', () => {
  it('splits a family from a dotted version, and leaves a spaced family whole', () => {
    expect(splitElement('URGO 4.5')).toEqual({ family: 'URGO', version: '4.5' });
    expect(splitElement('Bullet Bot 1.1')).toEqual({ family: 'Bullet Bot', version: '1.1' });
    expect(splitElement('Bullet Bot')).toEqual({ family: 'Bullet Bot', version: '' });
  });
});

describe('the sample gate', () => {
  it('leaves a combination under the gate ungated, unranked and never Best', () => {
    const clients = [
      bulkClient({ id: 'thin', algo: 'RBO', accountCount: 2, dates: ['2026-07-27'], pnl: 500 }),
      bulkClient({ id: 'fat', algo: 'URGO', accountCount: 4, dates: WEEK_TWO, pnl: -50 }),
    ];
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    const thin = report.stack.rows.find((row) => row.key === 'RBO 1.0');
    expect(thin.lowSample).toBe(true);
    expect(report.stack.best).toBeNull();
    expect(report.stack.bestNote).toContain('No combo with a positive average');
  });

  it('leaves an algorithm under the evidence gate unranked and keeps its counts', () => {
    const clients = [bulkClient({ id: 'thin', algo: 'RBO', accountCount: 3, dates: WEEK_TWO, pnl: -50 })];
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    const row = report.results.rows[0];
    expect(row.ranked).toBe(false);
    expect(row.rank).toBeNull();
    expect(row.accountDays).toBe(9);
    expect(row.rankRefusal).toContain('fewer than the 30');
    expect(report.results.noRankNote).toContain('30 reported account days and 10 accounts');
  });

  it('ranks the combination that clears the gate and records where it sat last period', () => {
    const clients = twoWeekBook();
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    const row = report.stack.rows.find((entry) => entry.key === 'RBO 1.0');
    expect(row.lowSample).toBe(false);
    expect(row.rankLastPeriod).toBe(1);
    expect(report.stack.rankNote).toContain('not a trend');
  });
});

describe('the benchmark is never mixed into a client figure', () => {
  const series = [{
    key: 'RBO|1.8|M2K|Low',
    algorithm: 'RBO',
    version: '1.8',
    instrument: 'M2K',
    riskLevel: 'Low',
    sourceFile: 'RBO_-_M2K_-_Low_Risk.csv',
    quantities: [2, 4, 6],
    firstDate: '2026-07-20',
    lastDate: '2026-07-30',
    basis: 'My Futures Book backtest. One simulated account, Low risk sizing, M2K, algorithm alone.',
    days: [
      { date: '2026-07-20', net: 100, trades: 2 },
      { date: '2026-07-27', net: -50, trades: 1 },
      { date: '2026-07-30', net: 25, trades: 3 },
    ],
  }];
  const clients = [bulkClient({ id: 'c', algo: 'RBO', version: '1.8', accountCount: 12, dates: WEEK_TWO, pnl: -200, instrument: 'M2K SEP26' })];
  const report = build(clients, { kind: 'week', key: '2026-07-27' }, { benchmarkSeries: series, benchmarkRisk: 'Low' });

  it('keeps every benchmark figure inside the benchmark block and out of results and roster', () => {
    const scan = JSON.stringify({
      results: report.results, roster: report.roster, movement: report.movement, money: report.money,
    });
    expect(scan).not.toContain('netProfit');
    expect(scan).not.toContain('My Futures Book backtest');
    expect(report.benchmark.rows[0].netProfit).toBe(-25);
  });

  it('names its own denominator: days with a trade, not account days', () => {
    const row = report.benchmark.rows[0];
    expect(row.daysWithATrade).toBe(2);
    expect(row.trades).toBe(4);
    expect(row.netPerDayWithATrade).toBe(-12.5);
    expect(row.basis).toContain('One simulated account');
  });

  it('reports the closes the two series hold in common and refuses the comparison below twenty', () => {
    const row = report.benchmark.coverage.rows.find((entry) => entry.algorithm === 'RBO');
    expect(row.commonCloses).toBe(2); // 07-27 and 07-30
    expect(row.comparable).toBe(false);
    expect(row.comparisonRefusal).toContain('fewer than the 20');
    expect(report.benchmark.coverage.refusal).toContain('No agreement figure is stated');
  });

  it('matches the version on the one field that means the same thing on both sides', () => {
    const row = report.benchmark.coverage.rows.find((entry) => entry.algorithm === 'RBO');
    expect(row.versionMatch).toBe('yes');
    expect(row.instrumentMatch).toBe('yes');
  });

  it('gives a prop-firm variant No series rather than its base family’s file', () => {
    const pf = [bulkClient({ id: 'pf', algo: 'RBO_PF', version: '1.8', accountCount: 2, dates: WEEK_TWO })];
    const built = build(pf, { kind: 'week', key: '2026-07-27' }, { benchmarkSeries: series });
    const row = built.benchmark.coverage.rows.find((entry) => entry.algorithm === 'RBO_PF');
    expect(row.hasSeries).toBe(false);
    expect(row.seriesNote).toContain('RBO has one');
  });

  it('lists a benchmarked algorithm this desk never ran', () => {
    expect(report.benchmark.coverage.neverDeployed).toEqual([]);
    const elsewhere = build(
      [bulkClient({ id: 'other', algo: 'URGO', accountCount: 2, dates: WEEK_TWO })],
      { kind: 'week', key: '2026-07-27' },
      { benchmarkSeries: series },
    );
    expect(elsewhere.benchmark.coverage.neverDeployed.map((row) => row.algorithm)).toEqual(['RBO']);
  });
});

describe('an empty period', () => {
  const clients = twoWeekBook();
  const report = build(clients, { kind: 'custom', from: '2026-09-01', to: '2026-09-07' });

  it('says so by name and reports no close, no account and no algorithm', () => {
    expect(report.period.empty).toBe(true);
    expect(report.period.emptyReason).toContain('The book runs from 2026-07-20 to 2026-07-30');
    expect(report.coverage.totals.closesInPeriod).toBe(0);
    expect(report.coverage.totals.accountCloses).toBe(0);
    expect(report.roster.rows.filter((row) => row.state !== 'Not seen')).toEqual([]);
  });

  it('still builds every block rather than throwing, so the page can state the emptiness', () => {
    expect(report.money.rows).toHaveLength(4);
    expect(report.results.rankedCount).toBe(0);
    expect(report.stack.rows).toEqual([]);
    expect(report.refusals.length).toBeGreaterThan(5);
  });
});

describe('the refusals', () => {
  const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-27' });

  it('interpolates the report’s own counts, so the list cannot drift from the page', () => {
    const entry = report.refusals.find((row) => row.figure.startsWith('A rank, a best combination'));
    expect(entry.reason).toContain(`${report.results.rankedCount} of `
      + `${report.results.rankedCount + report.results.unrankedCount} algorithms`);
    expect(entry.reason).toContain(`${report.stack.gatedCount} of ${report.stack.rows.length} combinations`);
  });

  it('carries the coverage factor into the period-against-period refusal', () => {
    const entry = report.refusals.find((row) => row.figure === 'A period against a period in dollars');
    expect(entry.reason).toContain(String(report.coverage.totals.thinnestClose.accounts));
    expect(entry.reason).toContain(String(report.coverage.totals.fullestClose.accounts));
  });

  it('refuses a desk total, a dollar per algorithm and a per-account-type figure by name', () => {
    const figures = report.refusals.map((row) => row.figure);
    expect(figures).toContain('One P&L for the desk over this period');
    expect(figures).toContain('A dollar for any algorithm');
    expect(figures).toContain('A performance figure per account type');
    expect(figures).toContain('A forecast, a projection, or a target');
    expect(figures).toContain('Targets crossed, payouts, time to funding and time to failure');
  });

  it('is regenerated from a report rather than stored beside it', () => {
    expect(periodReportRefusals(report).map((row) => row.figure))
      .toEqual(report.refusals.map((row) => row.figure));
  });
});

describe('the pasteable summary', () => {
  const series = [{
    key: 'RBO|1.0|M2K|Low',
    algorithm: 'RBO',
    version: '1.0',
    instrument: 'M2K',
    riskLevel: 'Low',
    quantities: [2],
    basis: 'My Futures Book backtest. One simulated account, Low risk sizing, M2K, algorithm alone.',
    days: [{ date: '2026-07-27', net: 9999, trades: 1 }],
  }];
  const report = build(twoWeekBook(), { kind: 'week', key: '2026-07-27' }, { benchmarkSeries: series });
  const text = formatDeskPeriodReport(report);

  it('carries no benchmark figure, because a pasted line loses the label that makes one legal', () => {
    expect(text).not.toContain('9,999');
    expect(text).not.toContain('9999');
    expect(text).not.toContain('Futures Book');
    expect(text).not.toContain('Backtest');
  });

  it('carries no total across businesses and states every rate per account close', () => {
    expect(text).toContain('per account close');
    expect(text).toContain('never added');
    expect(text).not.toMatch(/Desk total|Total P&L/i);
  });

  it('names the period, its coverage and what was refused for want of evidence', () => {
    expect(text).toContain('Week of 2026-07-27');
    expect(text).toContain('account closes over');
    expect(text).toContain('carry their counts and no verdict');
    expect(text).toContain('_Generated by Vincere CRM · Drive Insight_');
  });
});

describe('scope', () => {
  it('labels a CAM’s copy as their book and names which sections it narrows', () => {
    const clients = twoWeekBook();
    const report = buildDeskPeriodReport(clients.slice(0, 1), {
      period: resolvePeriod(clients, { kind: 'week', key: '2026-07-27' }),
      scope: { kind: 'cam', camName: 'Ana', camProfileId: 'cam-1', deskClientCount: 96 },
    });
    expect(report.scope.label).toBe('Your book, 1 of the desk’s 96 clients');
    expect(report.scope.scopedSections).toEqual(['coverage', 'money', 'changes']);
    expect(report.scope.deskWideNote).toContain('different measurement wearing the same label');
  });
});
