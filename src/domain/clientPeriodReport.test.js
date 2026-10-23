// The client period report, on fixtures worked out by hand.
//
// UNGATED: no snapshot is read. The fixture (clientPeriodReportFixtures.
// test-helpers.js) is one fictional client over the week of 2026-10-12 with no
// close on the Monday, accounts the report must leave out carrying money that
// would show if it leaked, a simulated account, an evaluation account, and an
// internal flag on every close that must never reach the client.

import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_DAYS,
  accountTypeLabel,
  axisLabel,
  bufferAtClose,
  buildClientPeriodReport,
  closesNeedingDetail,
  dayLabel,
  defaultAnchor,
  fmtMoney,
  fmtShort,
  niceStep,
  periodText,
  resolveClientPeriodWindow,
  shiftAnchor,
  stampText,
} from './clientPeriodReport';
import { buildDailyReportSummary } from './report';
import {
  AS_OF, BUILT_AT, CLOSES, GAP, PRIOR, periodClient,
} from './clientPeriodReportFixtures.test-helpers';

function weekOf(client, anchor = '2026-10-16') {
  return resolveClientPeriodWindow(client, { kind: 'week', anchor });
}

function build(options = {}, { asOf = AS_OF, window = null } = {}) {
  const client = periodClient(options);
  return {
    client,
    report: buildClientPeriodReport(client, {
      window: window || weekOf(client),
      asOf,
      builtAt: BUILT_AT,
      accountManager: 'Peter',
    }),
  };
}

const algo = (report, key) => report.algorithms.rows.find((row) => row.key === key);
const account = (report, alias) => report.accounts.rows.find((row) => row.alias === alias);

/** A one-client book for the cases the main fixture does not reach. */
function mini(days) {
  const registry = {
    A1: { accountName: 'A1', alias: 'Main', accountType: 'Funded', status: 'Active', connection: 'Apex' },
    E1: { accountName: 'E1', alias: 'Eval', accountType: 'Evaluation - Standard', status: 'Active', connection: 'Apex' },
  };
  return {
    id: 'mini',
    name: 'Mini',
    accountRegistry: registry,
    dailyImports: Object.entries(days).map(([date, accounts]) => {
      const snapshots = [];
      const executions = [];
      for (const [name, spec] of Object.entries(accounts)) {
        const strategies = (spec.strategies || []).map(([family, realized, enabled = true]) => ({
          accountName: name,
          strategyName: `0 - ${family}-1.0`,
          strategyFamily: family,
          strategyVersion: '1.0',
          instrument: 'MNQ DEC26',
          enabled,
          realized,
        }));
        for (const [family, count] of spec.fills || []) {
          for (let i = 0; i < count; i += 1) {
            executions.push({ id: `${date}${name}${family}${i}`, accountName: name, strategyName: `0 - ${family}-1.0`, instrument: 'MNQ DEC26' });
          }
        }
        snapshots.push({
          id: `${date}-${name}`,
          accountName: name,
          grossRealizedPnl: spec.realized || 0,
          accountBalance: spec.balance ?? 50000,
          trailingMaxDrawdown: spec.trailing || 0,
          strategies: spec.source ? strategies.map((strategy) => ({ ...strategy, source: spec.source })) : strategies,
          ...(spec.source ? { source: spec.source } : {}),
        });
      }
      return {
        id: `mini-${date}`,
        uuid: `uuid-mini-${date}`,
        date,
        accounts: registry,
        snapshots,
        strategies: snapshots.flatMap((snapshot) => snapshot.strategies),
        orders: [],
        executions,
        simulation: { snapshots: [], strategies: [], orders: [], executions: [], undetermined: { snapshots: [] } },
        flags: [],
        snapshotsLoaded: true,
        detailLoaded: true,
      };
    }),
  };
}

describe('the window', () => {
  const client = periodClient();

  it('is Monday to Sunday around the anchor, with the close before it', () => {
    expect(weekOf(client)).toMatchObject({
      kind: 'week', from: '2026-10-12', to: '2026-10-18', priorDate: PRIOR, title: 'Weekly performance report',
    });
  });

  it('runs two and four weeks back from the anchor week, and a calendar month', () => {
    expect(resolveClientPeriodWindow(client, { kind: 'twoWeeks', anchor: '2026-10-14' }))
      .toMatchObject({ from: '2026-10-05', to: '2026-10-18', title: 'Two week performance report' });
    expect(resolveClientPeriodWindow(client, { kind: 'fourWeeks', anchor: '2026-10-14' }))
      .toMatchObject({ from: '2026-09-21', to: '2026-10-18', title: 'Four week performance report' });
    expect(resolveClientPeriodWindow(client, { kind: 'month', anchor: '2026-10-14' }))
      .toMatchObject({ from: '2026-10-01', to: '2026-10-31', priorDate: '', title: 'Monthly performance report' });
  });

  it('puts a custom range in order and holds it to the longest the PDF route takes', () => {
    expect(resolveClientPeriodWindow(client, { kind: 'custom', from: '2026-10-16', to: '2026-10-13' }))
      .toMatchObject({ from: '2026-10-13', to: '2026-10-16', clipped: false, priorDate: PRIOR });
    const long = resolveClientPeriodWindow(client, { kind: 'custom', from: '2026-01-01', to: '2026-12-31' });
    expect(long.clipped).toBe(true);
    expect(long.to).toBe('2026-04-02');
    expect(MAX_CUSTOM_DAYS).toBe(92);
  });

  it('builds around the selected date when it has a close, and the latest close otherwise', () => {
    expect(defaultAnchor(client, '2026-10-14')).toBe('2026-10-14');
    // The wall clock's today, which has no close.
    expect(defaultAnchor(client, '2026-10-19')).toBe('2026-10-16');
    expect(defaultAnchor({ dailyImports: [] }, '2026-10-19')).toBe('2026-10-19');
  });

  it('steps by its own length', () => {
    expect(shiftAnchor(weekOf(client), -1)).toBe('2026-10-09');
    expect(shiftAnchor(resolveClientPeriodWindow(client, { kind: 'fourWeeks', anchor: '2026-10-16' }), 1)).toBe('2026-11-13');
    expect(shiftAnchor(resolveClientPeriodWindow(client, { kind: 'month', anchor: '2026-10-16' }), -1)).toBe('2026-09-01');
  });
});

describe('closesNeedingDetail', () => {
  it('asks for every window close missing its rows or its fills, and for the close before it when its rows are missing', () => {
    const client = periodClient({ unloaded: [PRIOR, '2026-10-15'], noFills: ['2026-10-16'] });
    expect(closesNeedingDetail(client, weekOf(client))).toEqual([
      `uuid-jordan-${PRIOR}`,
      'uuid-jordan-2026-10-15',
      'uuid-jordan-2026-10-16',
    ]);
  });

  it('does not ask for the fills of the close before the window, only its balances', () => {
    const client = periodClient({ noFills: [PRIOR] });
    expect(closesNeedingDetail(client, weekOf(client))).toEqual([]);
  });

  it('asks for nothing when every close is held whole', () => {
    const client = periodClient();
    expect(closesNeedingDetail(client, weekOf(client))).toEqual([]);
  });
});

describe('coverage, first', () => {
  it('counts what the report is built from', () => {
    const { report } = build();
    expect(report.coverage).toMatchObject({
      tradingDays: 5,
      closes: 4,
      loadedCloses: 4,
      gaps: [GAP],
      missingRows: [],
      missingFills: [],
      accounts: 3,
      accountsEveryClose: 3,
      evaluationAccounts: 1,
      algorithms: 2,
      algorithmAccountDays: 16,
      unsplitAccountDays: 0,
      fills: 28,
    });
  });

  it('names a weekday without a close as a gap, in a sentence', () => {
    const { report } = build();
    expect(report.coverage.sentences[0])
      .toBe('No close on Mon, Oct 12. That day is a gap in every chart and table, never a zero.');
  });

  it('says so when every trading day has a close', () => {
    const { report } = build({}, { window: resolveClientPeriodWindow(periodClient(), { kind: 'custom', from: '2026-10-13', to: '2026-10-16' }) });
    expect(report.coverage.gaps).toEqual([]);
    expect(report.coverage.sentences[0]).toBe('Every trading day in the period has a close.');
  });
});

describe('a weekday without a close is a gap, never a zero', () => {
  const { report } = build();

  it('is a day with no figure in the record', () => {
    expect(report.days[0]).toEqual({ date: GAP, state: 'gap', realized: null, balance: null, fills: null });
    expect(report.days.map((entry) => entry.date)).toEqual([GAP, ...CLOSES]);
  });

  it('breaks the balance line rather than bridging it', () => {
    const gap = report.balanceLine.find((point) => point.date === GAP);
    expect(gap.value).toBeNull();
  });

  it('is a hatched cell, not a quiet one, for every algorithm', () => {
    for (const row of report.algorithms.rows) {
      expect(row.cells[0]).toEqual({ date: GAP, state: 'noClose' });
    }
  });

  it('is not counted in the summary', () => {
    expect(report.summary.closes).toBe(4);
    expect(report.summary.daysWithGain + report.summary.daysWithLoss + report.summary.daysFlat).toBe(4);
  });
});

describe('the money, the daily report\'s way', () => {
  const { client, report } = build();

  it('adds up the realized P&L of the counted accounts', () => {
    expect(report.days.slice(1).map((entry) => entry.realized)).toEqual([400, -100, 280, 170]);
    expect(report.summary.realized).toBe(750);
    expect(report.accounts.totals.realized).toBe(750);
  });

  it('prints for each close exactly what the daily report printed for it', () => {
    for (const dailyImport of client.dailyImports.filter((entry) => CLOSES.includes(entry.date))) {
      const daily = buildDailyReportSummary(client, dailyImport).totals.grossRealizedPnl;
      expect(report.days.find((entry) => entry.date === dailyImport.date).realized).toBe(daily);
    }
  });

  it('names the best and the worst day', () => {
    expect(report.summary.best).toEqual({ date: '2026-10-13', realized: 400 });
    expect(report.summary.worst).toEqual({ date: '2026-10-14', realized: -100 });
    expect(report.summary).toMatchObject({ daysWithGain: 3, daysWithLoss: 1, daysFlat: 0, closesWithTrades: 4 });
  });

  it('sums the combined balance at each close', () => {
    expect(report.balanceLine.map((point) => point.value)).toEqual([125000, null, 125400, 125300, 125580, 125750]);
    expect(report.balanceLine[0]).toMatchObject({ date: PRIOR, prior: true });
  });
});

describe('the start balance', () => {
  it('is the balance at the close before the period when it was loaded', () => {
    const { report } = build();
    expect(report.start).toEqual({ basis: 'prior', date: PRIOR });
    expect(account(report, 'Funded 01')).toMatchObject({ start: 50000, startSource: 'prior', end: 50700, change: 700, realized: 700 });
    expect(report.summary).toMatchObject({ balanceStart: 125000, balanceEnd: 125750, balanceChange: 750 });
    expect(report.notes.find((note) => note.term === 'Start').text).toContain('at the close before the period, Fri, Oct 9, 2026');
  });

  it('falls back to the first close in the period, and says why, when the close before it was not loaded', () => {
    const { report } = build({ unloaded: [PRIOR] });
    expect(report.start).toEqual({ basis: 'first', date: '2026-10-13' });
    expect(account(report, 'Funded 01')).toMatchObject({ start: 50300, startSource: 'first', change: 400 });
    expect(report.summary.balanceStart).toBe(125400);
    // No prior point on the line: a close that was not read is not a balance.
    expect(report.balanceLine[0].date).toBe(GAP);
    expect(report.notes.find((note) => note.term === 'Start').text)
      .toContain('could not be loaded');
  });

  it('falls back to the first close, and says why, when there is no close before the period at all', () => {
    const { report } = build({ withoutPrior: true });
    expect(report.start.basis).toBe('first');
    expect(report.notes.find((note) => note.term === 'Start').text)
      .toContain('there is no close on record before it');
  });
});

describe('each algorithm\'s own numbers', () => {
  const { report } = build();

  it('credits each algorithm the trades it placed, on every account day', () => {
    expect(algo(report, 'NSTAR 2.1')).toMatchObject({
      instruments: ['MNQ'],
      accounts: 2,
      accountDays: 8,
      measuredAccountDays: 8,
      unsplitAccountDays: 0,
      daysTraded: 4,
      // Oct 14 is a loss: -250 on Funded 01 and +100 on Funded 02.
      daysWithGain: 3,
      fills: 18,
      realized: 550,
      perAccountDay: 68.75,
    });
    expect(algo(report, 'BRKOUT 1.4')).toMatchObject({
      instruments: ['MES'],
      accounts: 2,
      accountDays: 8,
      measuredAccountDays: 8,
      unsplitAccountDays: 0,
      daysTraded: 4,
      daysWithGain: 4,
      fills: 10,
      realized: 210,
    });
    expect(report.algorithms.unsplit).toEqual({ accountDays: 0, realized: 0 });
  });

  it('reports what the algorithms did not place as account charges, never shared out', () => {
    // Funded 01 on Oct 14: an account day of -200, its algorithms' own trades
    // -190. The -10 is the firm's fees.
    expect(report.algorithms.charges).toEqual({ accountDays: 1, realized: -10 });
    expect(report.algorithms.unnamedFills).toBe(0);
    const note = report.notes.find((entry) => entry.term === 'Fees and other account charges');
    expect(note.text).toContain('-$10.00');
    expect(report.notes.find((entry) => entry.term === 'Not split')).toBeUndefined();
  });

  it('adds back up to the accounts: every dollar is an algorithm\'s, an account charge, or nobody\'s', () => {
    const credited = report.algorithms.rows.reduce((total, row) => total + row.realized, 0);
    expect(credited + report.algorithms.charges.realized + report.algorithms.unsplit.realized
      + report.algorithms.unattributed.realized)
      .toBe(report.summary.realized);
  });

  it('credits an algorithm that was loaded and placed no fill exactly zero, not an unsplit day', () => {
    const shared = mini({
      '2026-10-13': {
        A1: {
          realized: -410.52,
          strategies: [['ONE', -403], ['TWO', null]],
          fills: [['ONE', 4]],
        },
      },
    });
    const one = buildClientPeriodReport(shared, { window: weekOf(shared), asOf: AS_OF });
    expect(algo(one, 'ONE 1.0')).toMatchObject({ realized: -403, unsplitAccountDays: 0 });
    expect(algo(one, 'TWO 1.0')).toMatchObject({ realized: 0, unsplitAccountDays: 0, daysTraded: 0 });
    expect(one.algorithms.charges).toEqual({ accountDays: 1, realized: -7.52 });
  });

  it('credits a sole algorithm its own trades too, with the fees on the charges row', () => {
    const alone = mini({
      '2026-10-13': { A1: { realized: 279.74, strategies: [['ONE', 283.5]], fills: [['ONE', 2]] } },
    });
    const one = buildClientPeriodReport(alone, { window: weekOf(alone), asOf: AS_OF });
    expect(algo(one, 'ONE 1.0').realized).toBe(283.5);
    expect(one.algorithms.charges).toEqual({ accountDays: 1, realized: -3.76 });
  });

  it('is ordered by name, never by result', () => {
    expect(report.algorithms.rows.map((row) => row.key)).toEqual(['BRKOUT 1.4', 'NSTAR 2.1']);
  });

  it('never lists an algorithm that ran only on an account the report does not count', () => {
    const keys = report.algorithms.rows.map((row) => row.key);
    expect(keys).not.toContain('MEANREV 3.0');
    expect(keys).not.toContain('GHOST 9.9');
  });

  it('draws each day as gain, loss, quiet, not loaded or no close', () => {
    expect(algo(report, 'NSTAR 2.1').cells.map((cell) => cell.state))
      .toEqual(['noClose', 'gain', 'loss', 'gain', 'gain']);
    expect(algo(report, 'NSTAR 2.1').cells[1]).toMatchObject({ realized: 350, fills: 4, accounts: 2 });
    expect(report.algorithms.heatMax).toBe(350);

    const quiet = mini({
      '2026-10-13': { A1: { realized: 120, strategies: [['ONE', 120]], fills: [['ONE', 2]] } },
      '2026-10-14': { A1: { realized: 0, strategies: [['ONE', 0]] } },
      '2026-10-15': { A1: { realized: -40, strategies: [['TWO', -40]], fills: [['TWO', 2]] } },
      '2026-10-16': { A1: { realized: 0, strategies: [] } },
    });
    const small = buildClientPeriodReport(quiet, { window: weekOf(quiet), asOf: AS_OF });
    // This book's first close is Tuesday, so Monday is before its history and
    // not a gap.
    expect(algo(small, 'ONE 1.0').cells.map((cell) => cell.state))
      .toEqual(['gain', 'quiet', 'notLoaded', 'notLoaded']);
    expect(algo(small, 'TWO 1.0').cells.map((cell) => cell.state))
      .toEqual(['notLoaded', 'notLoaded', 'loss', 'notLoaded']);
  });
});

describe('running at the last close', () => {
  it('lists the algorithms loaded on the counted accounts at the last close, with their accounts', () => {
    const { report } = build();
    expect(report.running).toEqual({
      date: '2026-10-16',
      chips: [
        { key: 'BRKOUT 1.4', instruments: ['MES'], accounts: ['Cash 04', 'Funded 01'] },
        { key: 'NSTAR 2.1', instruments: ['MNQ'], accounts: ['Funded 01', 'Funded 02'] },
      ],
    });
  });
});

describe('simulated money', () => {
  it('reaches no figure but its own row', () => {
    const { client, report } = build();
    expect(report.simulation).toEqual({
      accounts: [{ name: 'Sim101', realized: 3108, balance: 103885, date: '2026-10-16' }],
      totals: { realized: 3108, balance: 103885 },
    });
    // The same client with nothing simulated produces the same report, figure
    // for figure, everywhere but the simulation row and its footnote.
    const withoutSim = {
      ...client,
      dailyImports: client.dailyImports.map((dailyImport) => ({
        ...dailyImport,
        simulation: { snapshots: [], strategies: [], orders: [], executions: [], undetermined: { snapshots: [] } },
      })),
    };
    const plain = buildClientPeriodReport(withoutSim, { window: weekOf(client), asOf: AS_OF, builtAt: BUILT_AT, accountManager: 'Peter' });
    const strip = (built) => Object.fromEntries(
      Object.entries(built).filter(([key]) => key !== 'simulation' && key !== 'notes'),
    );
    expect(strip(plain)).toEqual(strip(report));
    expect(plain.simulation).toBeNull();
    expect(plain.notes.some((note) => note.term.includes('Simulated'))).toBe(false);
    expect(report.notes.some((note) => note.term === '*Simulated funds, not real money.')).toBe(true);
  });

  it('names an account whose nature is undetermined and counts it nowhere', () => {
    const { report } = build({ undetermined: true });
    expect(report.undetermined).toEqual(['Practice 1']);
    expect(report.summary.realized).toBe(750);
  });
});

describe('who is in the report', () => {
  it('leaves out Inactive / Ignore and an account that failed before the period, and counts them', () => {
    const { report } = build();
    const aliases = report.accounts.rows.map((row) => row.alias);
    expect(aliases).toEqual(['Funded 01', 'Funded 02', 'Cash 04']);
    expect(report.accounts.excluded).toEqual({ ignored: 1, retired: 1 });
    expect(JSON.stringify(report)).not.toContain('Old funded');
    expect(JSON.stringify(report)).not.toContain('Parked');
  });

  it('keeps an account that failed inside the period up to the close it failed on', () => {
    const { report } = build({ failsOn: '2026-10-14' });
    expect(account(report, 'Funded 05')).toMatchObject({
      start: 48000, end: 47000, endDate: '2026-10-14', endIsLastClose: false, realized: -800,
    });
    expect(report.summary.realized).toBe(-50);
    expect(report.accounts.excluded.retired).toBe(1);
  });

  it('lists evaluation accounts with their own subtotal and counts them nowhere else', () => {
    const { report } = build();
    expect(report.evaluations.rows.map((row) => row.alias)).toEqual(['Evaluation 03']);
    expect(report.evaluations.totals).toEqual({ start: 50000, end: 50100, realized: 100, change: 100 });
    expect(report.accounts.totals.realized).toBe(750);
  });

  it('gives a close no figure when none of the counted accounts reported on it', () => {
    const onlyEval = mini({
      '2026-10-13': { A1: { realized: 100, strategies: [['ONE', 100]], fills: [['ONE', 2]] } },
      '2026-10-14': { E1: { realized: 500, strategies: [['ONE', 500]], fills: [['ONE', 2]] } },
    });
    const report = buildClientPeriodReport(onlyEval, { window: weekOf(onlyEval, '2026-10-14'), asOf: AS_OF });
    const oct14 = report.days.find((entry) => entry.date === '2026-10-14');
    expect(oct14).toMatchObject({ state: 'noAccounts', realized: null });
    expect(report.summary.realized).toBe(100);
    expect(report.coverage.sentences.join(' ')).toContain('None of the counted accounts reported on Wed, Oct 14');
  });
});

describe('what was not loaded is named as missing', () => {
  it('reports a close without its account rows as missing, not as a zero', () => {
    const { report } = build({ unloaded: ['2026-10-15'] });
    const oct15 = report.days.find((entry) => entry.date === '2026-10-15');
    expect(oct15).toEqual({ date: '2026-10-15', state: 'missing', realized: null, balance: null, fills: null });
    expect(report.coverage).toMatchObject({ closes: 4, loadedCloses: 3, missingRows: ['2026-10-15'] });
    expect(report.summary.realized).toBe(470);
    expect(algo(report, 'NSTAR 2.1').cells[3]).toEqual({ date: '2026-10-15', state: 'missing' });
    expect(report.coverage.sentences.join(' '))
      .toContain('That close is missing from every figure, not counted as zero.');
  });

  it('reports fills that were not loaded as not loaded, never as no fills', () => {
    const { report } = build({ noFills: ['2026-10-16'] });
    const oct16 = report.days.find((entry) => entry.date === '2026-10-16');
    expect(oct16).toMatchObject({ fills: null, accountsTraded: null, realized: 170 });
    expect(report.coverage.fills).toBeNull();
    expect(algo(report, 'NSTAR 2.1').fills).toBeNull();
    expect(report.coverage.sentences.join(' ')).toContain('Fills were not loaded for Fri, Oct 16');
  });
});

describe('the period as of today', () => {
  it('leaves out the days that have not happened and today without its close, and says the period is in progress', () => {
    // Thursday, with Thursday's close in.
    const client = periodClient();
    const thursday = { ...client, dailyImports: client.dailyImports.filter((entry) => entry.date <= '2026-10-15') };
    const report = buildClientPeriodReport(thursday, { window: weekOf(client), asOf: '2026-10-15' });
    expect(report.days.map((entry) => entry.date)).toEqual([GAP, '2026-10-13', '2026-10-14', '2026-10-15']);
    expect(report.window.inProgress).toBe(true);
    expect(report.coverage.tradingDays).toBe(4);
    expect(report.coverage.sentences.join(' '))
      .toContain('This period is still in progress. It holds the closes through Thu, Oct 15.');

    // Thursday, before Thursday's close: the day is still open, not a gap.
    const morning = { ...client, dailyImports: client.dailyImports.filter((entry) => entry.date <= '2026-10-14') };
    const noToday = buildClientPeriodReport(morning, { window: weekOf(client), asOf: '2026-10-15' });
    expect(noToday.window.pending).toEqual(['2026-10-15']);
    expect(noToday.coverage.gaps).toEqual([GAP]);
    expect(noToday.days.map((entry) => entry.date)).toEqual([GAP, '2026-10-13', '2026-10-14']);
  });

  it('is not in progress on the weekend after its last trading day', () => {
    const { report } = build({}, { asOf: '2026-10-17' });
    expect(report.window.inProgress).toBe(false);
    expect(report.coverage.sentences.join(' ')).not.toContain('in progress');
  });

  it('does not call the days before the client\'s first close gaps', () => {
    const client = periodClient({ withoutPrior: true });
    const report = buildClientPeriodReport(
      { ...client, dailyImports: client.dailyImports.filter((entry) => entry.date >= '2026-10-14') },
      { window: weekOf(client), asOf: AS_OF },
    );
    expect(report.window.beforeFirst).toEqual([GAP, '2026-10-13']);
    expect(report.coverage.gaps).toEqual([]);
    expect(report.coverage.sentences.join(' ')).toContain('The first close on record for this client is Wed, Oct 14.');
  });
});

describe('the buffer to the limit', () => {
  const { client, report } = build();

  it('is the limit less the loss where a limit is on record', () => {
    expect(account(report, 'Funded 01').buffer).toEqual({ value: 1900, limit: 2500, reason: 'limit on record' });
  });

  it('is the reported buffer, beside the plan\'s limit where the plan is on record', () => {
    expect(account(report, 'Funded 02').buffer).toEqual({ value: 1800, limit: 2000, reason: 'plan on record' });
  });

  it('is n/a on a cash account and on a reading of exactly zero, and never takes a guessed plan', () => {
    expect(account(report, 'Cash 04').buffer.value).toBeNull();
    expect(bufferAtClose({ accountName: 'X', trailing: 0, meta: { accountType: 'Funded' } }, client))
      .toEqual({ value: null, limit: null, reason: 'not reported' });
    // A Lucid account with no plan on record: the tightest Lucid rule is a
    // guess and is not printed as its limit.
    expect(bufferAtClose(
      { accountName: 'LUC-1002', trailing: 1500, meta: { accountType: 'Funded', connection: 'Lucid', startBalance: 50000 } },
      client,
    )).toEqual({ value: 1500, limit: null, reason: 'reported' });
  });
});

describe('client facing', () => {
  it('carries no flag, no desk wording and no internal finding anywhere in the output', () => {
    for (const options of [{}, { unloaded: ['2026-10-15'] }, { noFills: ['2026-10-16'] }, { failsOn: '2026-10-14', undetermined: true }]) {
      const text = JSON.stringify(build(options).report);
      expect(text).not.toMatch(/flag|desk|misalign|outlier|drift|internal|look(s)? failed|best algorithm|worst algorithm/i);
    }
  });

  it('carries no em or en dash, and prints account types without the stored separators', () => {
    const text = JSON.stringify(build({ failsOn: '2026-10-14', undetermined: true }).report);
    expect(text).not.toMatch(/[–—]/);
    for (const type of ['Evaluation - Bullet Bot', 'Evaluation - Standard', 'Cash - IRA', 'Cash - Straight', 'Cash', 'Funded', 'Unassigned', '']) {
      expect(accountTypeLabel(type)).not.toContain(' - ');
    }
    expect(accountTypeLabel('Evaluation - Bullet Bot')).toBe('Bullet Bot evaluation');
  });

  it('states the header the way the client reads it', () => {
    const { report } = build();
    expect(report.header).toEqual({
      firm: 'Vincere Trading',
      title: 'Weekly performance report',
      clientName: 'Jordan Ellis',
      accountManager: 'Peter',
      periodText: 'Mon, Oct 12 to Fri, Oct 16, 2026',
      builtAt: 'Oct 19, 2026, 9:40 am ET',
      lastClose: 'Fri, Oct 16',
    });
  });
});

describe('formatting', () => {
  it('prints money with cents and a sign only when asked', () => {
    expect(fmtMoney(1234.5)).toBe('$1,234.50');
    expect(fmtMoney(1234.5, { sign: true })).toBe('+$1,234.50');
    expect(fmtMoney(-80)).toBe('-$80.00');
    expect(fmtMoney(0, { sign: true })).toBe('$0.00');
    expect(fmtMoney(null)).toBe('');
    expect(fmtShort(1200)).toBe('$1.2k');
    expect(fmtShort(-480)).toBe('-$480');
    expect(fmtShort(12500)).toBe('$13k');
  });

  it('labels an axis with the precision its step needs', () => {
    expect(niceStep(750, 4)).toBe(200);
    expect(niceStep(0, 4)).toBe(0.25);
    expect(axisLabel(125200, 200)).toBe('$125.2k');
    expect(axisLabel(126000, 1000)).toBe('$126k');
    expect(axisLabel(-500, 500)).toBe('-$500');
  });

  it('names days and periods across a year end', () => {
    expect(dayLabel('2026-10-12', { long: true })).toBe('Mon, Oct 12');
    expect(periodText('2026-12-28', '2027-01-08')).toBe('Mon, Dec 28, 2026 to Fri, Jan 8, 2027');
    expect(stampText('2026-07-01T20:05:00Z')).toBe('Jul 1, 2026, 4:05 pm ET');
  });
});

/* A PROVISIONAL DAY (step 73): the close lost the account and the tracker's
 * reading stands in, realized only, no fills, no balance. The store reads the
 * missing balance as 0, which must never print as an emptied account. */
describe('an account the tracker filled in', () => {
  function report(days) {
    const client = mini(days);
    return buildClientPeriodReport(client, {
      window: { from: '2026-10-12', to: '2026-10-18', kind: 'week' },
      asOf: '2026-10-19',
      builtAt: BUILT_AT,
    });
  }

  it('keeps its money and its algorithm, says which days came from the tracker, and takes no balance from them', () => {
    const built = report({
      '2026-10-13': { A1: { realized: 100, balance: 50100, strategies: [['NSTAR', 100]], fills: [['NSTAR', 2]] } },
      '2026-10-14': { A1: { realized: 250, balance: 0, trailing: 0, strategies: [['NSTAR', 250, false]], source: 'tracker' } },
      '2026-10-15': { A1: { realized: 50, balance: 50400, strategies: [['NSTAR', 50]], fills: [['NSTAR', 2]] } },
    });
    const main = account(built, 'Main');
    expect(main).toMatchObject({ realized: 400, end: 50400, endDate: '2026-10-15', trackerDates: ['2026-10-14'] });
    expect(main.series).toEqual(expect.arrayContaining([50100, null, 50400]));
    const tracked = built.days.find((entry) => entry.date === '2026-10-14');
    expect(tracked).toMatchObject({ state: 'close', realized: 250, fills: 0, accountsTraded: 1, traded: true });
    const nstar = built.algorithms.rows.find((row) => row.family === 'NSTAR');
    expect(nstar.realized).toBe(400);
  });

  it('an account seen only through the tracker has no balance figures at all, and is left out of the balance totals', () => {
    const built = report({
      '2026-10-13': {
        A1: { realized: 100, balance: 50100 },
        E1: { realized: 0, balance: 50000 },
      },
      '2026-10-14': {
        A1: { realized: 30, balance: 0, source: 'tracker' },
        E1: { realized: 0, balance: 50000 },
      },
    });
    const main = account(built, 'Main');
    expect(main).toMatchObject({ realized: 130, end: 50100, endDate: '2026-10-13', endIsLastClose: false, trackerDates: ['2026-10-14'] });
    const onlyTracked = report({ '2026-10-14': { A1: { realized: 30, balance: 0, source: 'tracker' } } });
    expect(account(onlyTracked, 'Main')).toMatchObject({ start: null, end: null, change: null, realized: 30 });
    expect(onlyTracked.accounts.totals).toMatchObject({ start: 0, end: 0, realized: 30 });
  });
});
