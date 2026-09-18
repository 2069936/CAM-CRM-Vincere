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
    expect(text).toContain('Never added');
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
  const clients = twoWeekBook();
  const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-27' });

  it('labels a CAM’s copy as their book and names which sections it narrows', () => {
    const report = buildDeskPeriodReport(clients.slice(0, 1), {
      period,
      deskClients: clients,
      scope: { kind: 'cam', camName: 'Ana', camProfileId: 'cam-1', deskClientCount: 96 },
    });
    expect(report.scope.label).toBe('Your book, 1 of the desk’s 96 clients');
    expect(report.scope.scopedSections).toEqual(['coverage', 'money', 'changes']);
    expect(report.scope.pooledSections)
      .toEqual(['roster', 'results', 'movement', 'stack', 'benchmark']);
    expect(report.scope.deskWideNote).toContain('different measurement wearing the same label');
  });

  it('MEASURES the pooled sections over the desk and the scoped ones over the CAM', () => {
    // The claim and the measurement, checked against each other. The version
    // this replaces computed the roster, the results, the movement, the stack
    // and the benchmark over the CAM's own clients and printed "the roster, the
    // results, the movement, the stack and the benchmark are desk wide for
    // everybody" underneath. The old suite asserted `scopedSections` and
    // `deskWideNote` — the CLAIM — and nothing asserted the measurement, so it
    // passed.
    const mine = clients.slice(0, 1);
    const scoped = buildDeskPeriodReport(mine, {
      period,
      deskClients: clients,
      scope: { kind: 'cam', camName: 'Ana', camProfileId: 'cam-1', deskClientCount: clients.length },
    });
    const deskWide = buildDeskPeriodReport(clients, { period });
    const own = buildDeskPeriodReport(mine, { period });

    // Pooled: identical to the desk-wide report, not to the one-client report.
    expect(scoped.results.rows.map((row) => [row.name, row.accountDays]))
      .toEqual(deskWide.results.rows.map((row) => [row.name, row.accountDays]));
    expect(scoped.roster.rows.map((row) => [row.algorithm, row.accountDaysInPeriod]))
      .toEqual(deskWide.roster.rows.map((row) => [row.algorithm, row.accountDaysInPeriod]));
    expect(scoped.stack.rows.map((row) => [row.key, row.days]))
      .toEqual(deskWide.stack.rows.map((row) => [row.key, row.days]));
    expect(scoped.movement.rows.map((row) => [row.algorithm, row.periodAccountDays]))
      .toEqual(deskWide.movement.rows.map((row) => [row.algorithm, row.periodAccountDays]));
    expect(scoped.results.rows.map((row) => row.accountDays))
      .not.toEqual(own.results.rows.map((row) => row.accountDays));

    // Scoped: identical to the one-client report, not to the desk's.
    expect(scoped.coverage.totals.accountCloses).toBe(own.coverage.totals.accountCloses);
    expect(scoped.coverage.totals.accountCloses)
      .toBeLessThan(deskWide.coverage.totals.accountCloses);
    expect(scoped.money.rows.map((row) => [row.key, row.accounts]))
      .toEqual(own.money.rows.map((row) => [row.key, row.accounts]));
    expect(scoped.changes.counts.total).toBe(own.changes.counts.total);
  });

  it('refuses the desk-wide sentence when it was handed no desk-wide list', () => {
    // A caller that forgets `deskClients` on a CAM shell must not be able to
    // print "desk wide for everybody" over one CAM's eight clients.
    const report = buildDeskPeriodReport(clients.slice(0, 1), {
      period,
      scope: { kind: 'cam', camName: 'Ana', camProfileId: 'cam-1', deskClientCount: 96 },
    });
    expect(report.scope.pooledIsDeskWide).toBe(false);
    expect(report.scope.deskWideNote).toContain('computed over this book alone');
    expect(report.scope.deskWideNote).toContain('not the desk’s figures');
    expect(report.scope.deskWideNote).not.toContain('desk wide for everybody');
  });
});

/* ---------------------------------------------------------------- */
/* What the pre-merge review found, pinned so it cannot come back.   */

describe('the closes-of-weekdays line has one set on each side', () => {
  // 2026-07-25 is a Saturday, and this book holds a close on it. The header
  // printed `closesInPeriod` over `period.weekdays`: "6 closes of 5 weekdays",
  // a numerator counting Saturdays over a denominator that does not.
  const clients = [bulkClient({
    id: 'c1',
    accountCount: 4,
    dates: ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25'],
  })];
  const report = build(clients, { kind: 'week', key: '2026-07-20' });

  it('states the weekday closes over the weekdays and the weekend close apart', () => {
    expect(report.coverage.totals.closesInPeriod).toBe(6);
    expect(report.coverage.totals.weekdayCloses).toBe(5);
    expect(report.coverage.totals.weekendCloses).toBe(1);
    expect(report.coverage.totals.weekendCloseDates).toEqual(['2026-07-25']);
    expect(report.coverage.totals.closesSentence)
      .toBe('5 of 5 weekdays hold a close, plus 1 weekend close (2026-07-25)');
    expect(report.coverage.totals.closesSentence).not.toContain('6 closes of 5');
  });

  it('puts the same sentence in the pasted summary, never a second arithmetic', () => {
    expect(formatDeskPeriodReport(report)).toContain(report.coverage.totals.closesSentence);
  });

  it('drops the weekend clause when the period holds no weekend close', () => {
    const weekdaysOnly = [bulkClient({
      id: 'c1', accountCount: 4, dates: ['2026-07-27', '2026-07-28', '2026-07-30'],
    })];
    const built = build(weekdaysOnly, { kind: 'week', key: '2026-07-27' });
    expect(built.coverage.totals.closesSentence).toBe('3 of 5 weekdays hold a close');
  });
});

describe('the roster decides Running on a close that represents the desk', () => {
  // The exact shape of the real book's week of 2026-07-20: five full closes and
  // a Saturday close carrying one client. Deciding the states on "whichever
  // date sorts last" marked twelve algorithms Stopped, one of them after 212
  // account days that week, while the results table below ranked five of them.
  const full = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  const clients = [
    bulkClient({ id: 'desk', algo: 'RBO', accountCount: 40, dates: full }),
    bulkClient({ id: 'saturday', algo: 'URGO', accountCount: 2, dates: ['2026-07-25'] }),
  ];
  const report = build(clients, { kind: 'week', key: '2026-07-20' });

  it('decides on the last close carrying at least half the fullest, not on the Saturday', () => {
    expect(report.period.closes[report.period.closes.length - 1]).toBe('2026-07-25');
    expect(report.roster.lastClose).toBe('2026-07-25');
    expect(report.roster.stateClose).toBe('2026-07-24');
    expect(report.roster.stateCloseIsLastClose).toBe(false);
  });

  it('never marks an algorithm Stopped that ran on hundreds of account days that period', () => {
    const rbo = rosterRow(report, 'RBO 1.0');
    expect(rbo.accountDaysInPeriod).toBe(200);
    expect(rbo.state).toBe('Running');
    for (const row of report.roster.rows) {
      if (row.state === 'Stopped') expect(row.accountDaysInPeriod).toBeLessThan(50);
    }
  });

  it('says which close decided and why, in the note and in the state sentence', () => {
    expect(report.roster.stateNote).toContain('Running is decided on 2026-07-24');
    expect(report.roster.thinLastCloseNote)
      .toContain('Running and Stopped are decided on 2026-07-24, not on 2026-07-25');
    expect(report.roster.thinLastCloseNote).toContain('2 account rows');
  });

  it('walks back past every thin close, however many of them there are', () => {
    const lumpy = [
      bulkClient({ id: 'big', algo: 'RBO', accountCount: 40, dates: ['2026-07-20'] }),
      bulkClient({ id: 'tiny', algo: 'URGO', accountCount: 1, dates: ['2026-07-21', '2026-07-22'] }),
    ];
    const built = build(lumpy, { kind: 'week', key: '2026-07-20' });
    expect(built.roster.lastClose).toBe('2026-07-22');
    expect(built.roster.stateClose).toBe('2026-07-20');
    expect(built.roster.stateCloseAccounts).toBe(40);
    expect(built.roster.stateCloseShareOfFullest).toBe(100);
  });

  it('keeps `lastClose` on the object for the coverage section, which asks a different question', () => {
    expect(report.coverage.totals.lastClose).toBe('2026-07-25');
    expect(report.roster.lastClose).toBe('2026-07-25');
  });
});

describe('the results table and the roster attribute the same way', () => {
  // A day the algorithm traded with its grid checkbox already switched off:
  // the fills name it, the grid reports realized 0. Under the export-time flag
  // the day vanishes from the ranking while the roster counts it, and the two
  // sit six rows apart under one "Account days" header.
  function switchedOffDay(date, accountName) {
    return {
      accountName,
      grossRealizedPnl: -300,
      weeklyPnl: 0,
      accountBalance: 50000,
      strategies: [strat('RBO', { realized: 0, enabled: false })],
      _date: date,
    };
  }
  const dates = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'];
  const accounts = Array.from({ length: 12 }, (_, index) => `A${index + 1}`);
  const clients = [{
    id: 'c1',
    name: 'c1',
    accountRegistry: Object.fromEntries(
      accounts.map((name) => [name, { accountName: name, accountType: 'Funded', status: 'Active' }]),
    ),
    dailyImports: dates.map((date) => ({
      id: `c1-${date}`,
      date,
      importedAt: `${date}T22:00:00Z`,
      // Two closes enabled, two switched off but traded, on every account.
      snapshots: accounts.map((accountName) => (date <= '2026-07-28'
        ? {
          accountName,
          grossRealizedPnl: -300,
          weeklyPnl: 0,
          accountBalance: 50000,
          strategies: [strat('RBO', { realized: -300 })],
        }
        : switchedOffDay(date, accountName))),
      executions: date <= '2026-07-28' ? [] : accounts.map((accountName) => ({
        accountName, strategyName: '0 - RBO-1.0', instrument: 'MNQ SEP26', quantity: 1,
      })),
      flags: [],
    })),
  }];
  const report = build(clients, { kind: 'week', key: '2026-07-27' });
  const row = report.results.rows.find((entry) => entry.name === 'RBO');

  it('counts every day the algorithm ran, on both tables, and they agree', () => {
    expect(rosterRow(report, 'RBO 1.0').accountDaysInPeriod).toBe(48);
    expect(row.accountDays + row.unmeasuredAccountDays).toBe(48);
  });

  it('measures only the days something stated what it made, and says so', () => {
    // The 24 switched-off days report `realized: 0`, which is the grid zeroing a
    // row it turned off rather than a flat day. Counting that 0 as a
    // measurement would put 24 false flat days into the denominator.
    expect(row.accountDays).toBe(24);
    expect(row.unmeasuredAccountDays).toBe(24);
    expect(row.flatDays).toBe(0);
    expect(row.meanPerAccountDay).toBe(-300);
    expect(report.results.measuredAccountDays).toBe(24);
    expect(report.results.ranAccountDays).toBe(48);
    expect(report.results.measuredShare).toBe(50);
  });

  it('names the attribution on the basis, so the column header cannot be the only claim', () => {
    expect(report.results.attribution).toBe('traded');
    expect(report.results.basis.label).toContain('Traded attribution');
    expect(report.results.basis.label).not.toContain('Enabled at export');
  });

  it('carries the gap into the refusals table', () => {
    const refusal = report.refusals.find(
      (entry) => entry.figure === 'A mean over every account day an algorithm ran on',
    );
    expect(refusal.value).toBe('24 of 48 account days measured');
    expect(refusal.reason).toContain('REPORTED account days');
  });

  it('counts the measured and unmeasured days per business, with no money on the object', () => {
    const business = report.results.businesses.find((entry) => entry.measuredAccountDays > 0);
    expect(business.measuredAccountDays).toBe(24);
    expect(business.unmeasuredAccountDays).toBe(24);
    expect(business.ranAccountDays).toBe(48);
    expect(Object.keys(business).join(' ')).not.toMatch(/pnl|profit|total/i);
  });
});

describe('the combination changes measure the two combinations, not the two halves of a week', () => {
  const dates = [
    '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24',
    '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
  ];
  // One account, three combinations: RBO to 2026-07-20, URGO to 2026-07-27,
  // then G4M. The two changes are a week apart and each has plenty of its own
  // closes either side, but only inside the whole book, never inside one week.
  const algoFor = (date) => (date < '2026-07-20' ? 'RBO' : (date < '2026-07-27' ? 'URGO' : 'G4M'));
  const pnlFor = (date) => (date < '2026-07-20' ? -100 : (date < '2026-07-27' ? -500 : -20));
  const clients = [{
    id: 'c1',
    name: 'c1',
    accountRegistry: { A1: { accountName: 'A1', accountType: 'Funded', status: 'Active' } },
    dailyImports: dates.map((date) => ({
      id: `c1-${date}`,
      date,
      importedAt: `${date}T22:00:00Z`,
      snapshots: [{
        accountName: 'A1',
        grossRealizedPnl: pnlFor(date),
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies: [strat(algoFor(date), { realized: pnlFor(date) })],
      }],
      executions: [],
      flags: [],
    })),
  }];
  const week = build(clients, { kind: 'week', key: '2026-07-20' });
  const change = week.changes.rows[0];

  it('prints a comparison on a weekly report at all', () => {
    // Clipped to the period, "5 account days before and 5 after" is
    // arithmetically impossible on a week that holds at most six closes, so
    // the column printed a refusal on every row of a 103-row table.
    expect(week.changes.rows).toHaveLength(1);
    expect(change.date).toBe('2026-07-20');
    expect(change.perAccountDayBefore).toBe(-100);
    expect(change.perAccountDayAfter).toBe(-500);
    expect(change.sidesRefusal).toBeNull();
  });

  it('takes each side from this account’s own closes, which run outside the week', () => {
    expect(change.beforeFrom).toBe('2026-07-13');
    expect(change.beforeTo).toBe('2026-07-17');
    expect(change.afterFrom).toBe('2026-07-20');
    expect(change.afterTo).toBe('2026-07-24');
    expect(change.outsidePeriod).toBe(true);
    expect(change.sidesWindow).toContain('may run outside this period');
  });

  it('cuts the after side at the account’s next change, not at the end of the period', () => {
    // Run to the end of the period, the after side of this change would carry
    // the four G4M days as well, and the cell is labelled "each side of the
    // change".
    expect(change.afterDays).toBe(5);
    expect(change.accountDaysSince).toBe(5);
    expect(change.nextChangeDate).toBe('2026-07-27');
    expect(change.endsAtNextChange).toBe(true);
  });

  it('bounds the before side at the previous change on the same account', () => {
    const month = build(clients, { kind: 'month', key: '2026-07' });
    const second = month.changes.rows.find((row) => row.date === '2026-07-27');
    expect(second.beforeFrom).toBe('2026-07-20');
    expect(second.perAccountDayBefore).toBe(-500);
    expect(second.perAccountDayAfter).toBe(-20);
  });

  it('counts the change accounts over the changes it lists, not over the gaps it does not', () => {
    const month = build(clients, { kind: 'month', key: '2026-07' });
    expect(month.changes.counts.decisions).toBe(2);
    expect(month.changes.counts.decisionAccounts).toBe(1);
    expect(month.changes.counts.decisionAccounts)
      .toBeLessThanOrEqual(month.changes.counts.accounts);
  });

  it('diffs one point per trading date, so a second import for a date is not a change', () => {
    const doubled = [{
      ...clients[0],
      dailyImports: [
        ...clients[0].dailyImports,
        // A re-import of 2026-07-21 landing later, same combination.
        {
          ...clients[0].dailyImports[6],
          id: 'c1-2026-07-21-again',
          importedAt: '2026-07-22T09:00:00Z',
        },
      ],
    }];
    const built = build(doubled, { kind: 'month', key: '2026-07' });
    expect(built.changes.counts.total).toBe(2);
  });
});

describe('the book to date is not compared with a period that contains the whole book', () => {
  const clients = twoWeekBook();

  it('withholds the column with its reason rather than printing a column of zeros', () => {
    const report = build(clients, { kind: 'custom', from: '2026-07-01', to: '2026-07-30' });
    expect(report.movement.bookIsThisPeriod).toBe(true);
    for (const row of report.movement.rows) {
      expect(row.againstBook).toBeNull();
      expect(row.againstBookRefusal).toContain('this same measurement over these same days');
    }
    expect(report.movement.bookNote).toContain('the very same set of closes');
    expect(report.refusals.map((entry) => entry.figure))
      .toContain('This period against the book to date');
  });

  it('still compares when the book starts before the period', () => {
    const report = build(clients, { kind: 'week', key: '2026-07-27' });
    expect(report.movement.bookIsThisPeriod).toBe(false);
  });
});

describe('the stack caption counts the population it names', () => {
  const clients = [
    bulkClient({ id: 'c1', algo: 'RBO', accountCount: 6, dates: ['2026-07-27', '2026-07-28'] }),
    // Funded accounts whose grid names nothing and whose fills name nothing:
    // in the funded population, attributed on no day.
    {
      id: 'c2',
      name: 'c2',
      accountRegistry: {
        B1: { accountName: 'B1', accountType: 'Funded', status: 'Active' },
        B2: { accountName: 'B2', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: ['2026-07-27', '2026-07-28'].map((date) => ({
        id: `c2-${date}`,
        date,
        importedAt: `${date}T22:00:00Z`,
        snapshots: ['B1', 'B2'].map((accountName) => ({
          accountName, grossRealizedPnl: -10, weeklyPnl: 0, accountBalance: 50000, strategies: [],
        })),
        executions: [],
        flags: [],
      })),
    },
  ];
  const report = build(clients, { kind: 'week', key: '2026-07-27' });

  it('states attributed accounts AGAINST the funded population, never one as the other', () => {
    expect(report.stack.population.fundedAccounts).toBe(8);
    expect(report.stack.population.accounts).toBe(6);
    expect(report.stack.population.fundedClients).toBe(2);
    expect(report.stack.population.clients).toBe(1);
    expect(report.stack.populationNote).toContain('6 of 8 accounts');
    expect(report.stack.populationNote).toContain('1 of 2 clients attributed');
    expect(report.stack.populationNote).toContain('12 attributed of 16 funded account days');
  });
});

describe('the summary is the page and the pasted line reading one object', () => {
  const clients = twoWeekBook();
  const report = build(clients, { kind: 'week', key: '2026-07-27' });

  it('answers the three questions before the first denominator table', () => {
    expect(report.summary.closesSentence).toBe(report.coverage.totals.closesSentence);
    expect(report.summary.coverageLine).toContain('account closes over');
    expect(report.summary.money.map((row) => row.key))
      .toEqual(report.money.rows.map((row) => row.key));
    expect(report.summary.ranked.map((row) => row.name))
      .toEqual(report.results.rows.filter((row) => row.ranked).map((row) => row.name));
    expect(report.summary.stateClose).toBe(report.roster.stateClose);
  });

  it('prints every ranked mean with both account-day counts, on the page and in the paste', () => {
    const row = report.summary.ranked[0];
    expect(row.accountDays).toBe(
      report.results.rows.find((entry) => entry.name === row.name).accountDays,
    );
    expect(row.ranAccountDays).toBeGreaterThanOrEqual(row.accountDays);
    expect(formatDeskPeriodReport(report))
      .toContain(`${row.accountDays} measured of ${row.ranAccountDays} account days it ran`);
  });

  it('carries no benchmark figure and no total across businesses into the paste', () => {
    const text = formatDeskPeriodReport(report);
    expect(text).not.toContain('Futures Book');
    expect(text).not.toMatch(/Desk total|Total P&L/i);
  });
});
