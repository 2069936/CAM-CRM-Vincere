// The rules behind the desk's per algorithm temperature panel, on synthetic
// fixtures, so CI runs them.
//
// EVERY FIXTURE IN THIS FILE IS SYNTHETIC, and that is deliberate rather than
// convenient. The guards that matter here are the three attribution cases and the
// refusal to divide an account day between the algorithms that ran on it, and
// vite.config.js records what happened the last time guards of exactly that kind
// lived in a suite gated on the production book: both mutations that break them
// passed a full CI run, because the book is absent on CI and the suite was never
// executed. So this file reads no fixture, stays off `localSnapshotTests`, and
// runs on every clone.
//
// THE FIGURES THE MODULE HEADER QUOTES ABOUT THE BOOK ARE PINNED IN THE SIBLING,
// `algorithmTemperature.book.test.js`, which is on that list and therefore runs
// nowhere but here. That split is the `.book.test.js` convention and it is not
// cosmetic: a header sentence explaining a client-facing -$53,417.10 was wrong
// about 72 of the 115 days it described while all 36 tests in this file passed,
// because nothing re-measured the book. Rules here, measurements there.
//
// AND NOTHING IN THIS FILE READS A SOURCE FILE. Every string asserted below is a
// runtime value off the result, so no assertion here can pass by matching a
// comment. The labels are pinned by mutation instead: renaming DEEPEST_DIP_LABEL
// to the prop firm's word, dropping `unsplit.note`, emptying ATTRIBUTION_CASES,
// publishing the fall as `maxDrawdown` again or reading an unmeasured row as
// Stable each fail at least one test here.

import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_CASES,
  COLD_BELOW,
  DEEPEST_DIP_LABEL,
  DEFAULT_OPTIONS,
  HEAT_DATES,
  HOT_ABOVE,
  RECONCILE_TOLERANCE,
  REDUCTION_REFUSALS,
  UNMEASURED_TEMPERATURE,
  UNSPLIT_NOTE,
  UNSPLIT_REASONS,
  buildAlgorithmComposite,
  buildAlgorithmTemperature,
  curveOf,
  temperatureOf,
} from './algorithmTemperature';
import { MIN_ACCOUNTS, MIN_DAYS, comboKeyFromDay, dayAlgoRows, executionsForAccount } from './comboPerformance';

const strategy = (family, version, { enabled = true, realized = 0, derivedRealized = null } = {}) => ({
  strategyName: `0 - ${family.replace('_PF', '-PF')}-${version}`,
  strategyFamily: family,
  strategyVersion: version,
  enabled,
  realized,
  derivedRealized,
});

const execution = (accountName, strategyName) => ({ accountName, strategyName, quantity: 1 });

// One client, one account, one close per entry of `days`. Each day is
// `{ date, pnl, strategies, executions }`; strategies default to URGO 4.5
// enabled so a bare `{ date, pnl }` is an ordinary solo URGO day.
function client({ id = 'c1', accountName = 'ACC1', accountType = 'Funded', status = 'Active', dateFailed = '', days = [] } = {}) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType, status, dateFailed },
    },
    dailyImports: days.map(({ date, pnl = 0, strategies = [strategy('URGO', '4.5')], executions = [] }) => ({
      date,
      accounts: {},
      snapshots: [{ accountName, grossRealizedPnl: pnl, strategies }],
      executions: executions.map((name) => execution(accountName, name)),
    })),
  };
}

const june = (day) => `2026-06-${String(day).padStart(2, '0')}`;
const ALL = { window: { preset: 'all' } };
const row = (result, key) => result.rows.find((r) => r.key === key) || null;
const build = (clients, options = {}) => buildAlgorithmTemperature(clients, { ...ALL, ...options });

// Ten clients, one account and one close each, all running `family` alone, so the
// row clears MIN_DAYS and MIN_ACCOUNTS and can be reasoned about as gated.
const crowd = (family, pnl, date = june(1)) => Array.from({ length: 10 }, (_, i) => client({
  id: `crowd${i}`,
  accountName: `CROWD${i}`,
  days: [{ date, pnl, strategies: [strategy(family, '1.0')] }],
}));

describe('the three attribution cases', () => {
  it('credits each algorithm its own figure on a day where every figure reconciles with the account', () => {
    const day = {
      date: june(1),
      pnl: 300,
      strategies: [
        strategy('G4M', '1.2', { realized: 500 }),
        strategy('OGX', '2.4', { realized: -50 }),
        strategy('URGO', '4.5', { realized: -150 }),
      ],
    };
    const result = build([client({ days: [day] })]);

    expect(row(result, 'G4M').totalPnl).toBeCloseTo(500, 2);
    expect(row(result, 'OGX').totalPnl).toBeCloseTo(-50, 2);
    expect(row(result, 'URGO').totalPnl).toBeCloseTo(-150, 2);
    expect(row(result, 'G4M').attribution).toEqual({ measuredDays: 1, soleDays: 0, unsplitDays: 0 });
    expect(result.reconciliation).toMatchObject({ tolerance: RECONCILE_TOLERANCE, checkedDays: 1, reconciledDays: 1 });
    expect(result.unsplit.days).toBe(0);
    expect(result.population.includedDays).toBe(1);
  });

  it('credits a sole algorithm the whole account day, not the figure its own row reported', () => {
    // On the 166 solo days of the production book the account's gross equals the
    // strategy's realized on 108 of them. Crediting the account day is exact on
    // all 166; crediting the row would lose the difference on the other 58.
    const result = build([client({ days: [{ date: june(1), pnl: 100, strategies: [strategy('URGO', '4.5', { realized: 999 })] }] })]);
    const urgo = row(result, 'URGO');
    expect(urgo.totalPnl).toBeCloseTo(100, 2);
    expect(urgo.totalPnl).not.toBeCloseTo(999, 2);
    expect(urgo.attribution).toEqual({ measuredDays: 0, soleDays: 1, unsplitDays: 0 });
    // A sole day needs no reconciliation, so it is not in that denominator.
    expect(result.reconciliation).toMatchObject({ checkedDays: 0, reconciledDays: 0 });
  });

  it('refuses to split a day whose figures do not add up to the account, and never divides it equally', () => {
    const result = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [strategy('G4M', '1.2', { realized: 100 }), strategy('URGO', '4.5', { realized: 100 })],
    }] })]);

    // The temptation is $150 each, which sums correctly and states two figures
    // nothing measured. Crediting both the whole $300 is the other failure and
    // sums to $600.
    expect(row(result, 'G4M').totalPnl).toBe(0);
    expect(row(result, 'URGO').totalPnl).toBe(0);
    expect(row(result, 'G4M').days).toBe(0);
    expect(row(result, 'G4M').attribution.unsplitDays).toBe(1);
    expect(result.unsplit.days).toBe(1);
    expect(result.unsplit.pnl).toBeCloseTo(300, 2);
    expect(result.unsplit.dates).toEqual([{ date: june(1), days: 1, pnl: 300 }]);
    expect(result.reconciliation).toMatchObject({ checkedDays: 1, reconciledDays: 0 });
    expect(result.population.includedDays).toBe(0);
  });

  it('refuses a day on which one of the algorithms that ran can never have a figure', () => {
    // A family named on this account's fills with no grid row at all: the fills
    // say it ran and nothing says what it made, so the day is not partitionable
    // however complete the other algorithm's figure looks.
    const result = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [strategy('G4M', '1.2', { realized: 300 })],
      executions: ['0 - OGX-2.4'],
    }] })]);

    expect(result.rows.map((r) => r.key).sort()).toEqual(['G4M', 'OGX']);
    expect(row(result, 'G4M').totalPnl).toBe(0);
    expect(row(result, 'OGX').attribution.unsplitDays).toBe(1);
    expect(result.unsplit.days).toBe(1);
    // Nothing was checked: there was no complete set of figures to check.
    expect(result.reconciliation).toMatchObject({ checkedDays: 0, reconciledDays: 0 });
  });

  it('does not call a flat day measured just because zero equals zero', () => {
    // Two algorithms reporting nothing on a day the account did not move is an
    // unreported day, not agreement. Accepting it would put a false flat day in
    // every denominator and two $0 points on two curves.
    const result = build([client({ days: [{
      date: june(1),
      pnl: 0,
      strategies: [strategy('G4M', '1.2'), strategy('URGO', '4.5')],
    }] })]);

    expect(result.unsplit.days).toBe(1);
    expect(result.unsplit.pnl).toBe(0);
    expect(row(result, 'G4M').series).toEqual([]);
    expect(result.reconciliation).toMatchObject({ checkedDays: 1, reconciledDays: 0 });
  });

  it('treats an absent realized as absent and a reported zero on a live row as measured', () => {
    // `realized == null` means the export said nothing; `realized === 0` on an
    // enabled row means the grid was watching and saw nothing. Only the second is
    // a measurement, and testing truthiness cannot tell them apart.
    const absent = build([client({ days: [{
      date: june(1),
      pnl: 500,
      strategies: [strategy('G4M', '1.2', { realized: 500 }), strategy('URGO', '4.5', { realized: null })],
    }] })]);
    expect(absent.unsplit.days).toBe(1);

    const reportedZero = build([client({ days: [{
      date: june(1),
      pnl: 500,
      strategies: [strategy('G4M', '1.2', { realized: 500 }), strategy('URGO', '4.5', { realized: 0 })],
    }] })]);
    expect(reportedZero.unsplit.days).toBe(0);
    expect(row(reportedZero, 'URGO').totalPnl).toBe(0);
    expect(row(reportedZero, 'URGO').days).toBe(1);
  });

  it('does not read a switched off row\'s zero as a measurement', () => {
    // The grid zeroes a row it has switched off; it does not measure it. This row
    // is still attributed, because its family is on the fills, and it still has
    // no figure, so the day cannot be partitioned.
    const result = build([client({ days: [{
      date: june(1),
      pnl: 500,
      strategies: [
        strategy('G4M', '1.2', { realized: 500 }),
        strategy('URGO', '4.5', { enabled: false, realized: 0 }),
      ],
      executions: ['0 - URGO-4.5'],
    }] })]);

    expect(row(result, 'URGO').attribution.unsplitDays).toBe(1);
    expect(result.unsplit.days).toBe(1);
  });

  it('prefers a derived figure over the reported one on a measured day', () => {
    const result = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [
        strategy('G4M', '1.2', { realized: 1, derivedRealized: 200 }),
        strategy('URGO', '4.5', { realized: 2, derivedRealized: 100 }),
      ],
    }] })]);
    expect(row(result, 'G4M').totalPnl).toBeCloseTo(200, 2);
    expect(row(result, 'URGO').totalPnl).toBeCloseTo(100, 2);
    expect(result.reconciliation.reconciledDays).toBe(1);
  });

  it('accepts a split that misses the account day by cents and refuses one that misses it by a dollar', () => {
    const near = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [strategy('G4M', '1.2', { realized: 150 }), strategy('URGO', '4.5', { realized: 149.5 })],
    }] })]);
    expect(near.reconciliation.reconciledDays).toBe(1);
    expect(near.reconciliation.residualPnl).toBeCloseTo(-0.5, 2);

    const far = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [strategy('G4M', '1.2', { realized: 150 }), strategy('URGO', '4.5', { realized: 149 })],
    }] })]);
    expect(far.reconciliation.reconciledDays).toBe(0);
    expect(far.unsplit.days).toBe(1);
  });

  it('counts a day with no attributable algorithm as unknown rather than unsplit', () => {
    // Nothing ran that anything can name. That is a different statement from
    // "several ran and the money cannot be divided", and the panel says both.
    const result = build([client({ days: [{ date: june(1), pnl: -40, strategies: [] }] })]);
    expect(result.rows).toEqual([]);
    expect(result.unsplit.days).toBe(0);
    expect(result.population).toMatchObject({ unknownDays: 1, includedDays: 0 });
    expect(result.population.unknownPnl).toBeCloseTo(-40, 2);
  });
});

describe('the partition adds up, and never twice', () => {
  it('reconstructs a three algorithm day exactly once when all three are selected', () => {
    const result = build([client({ days: [{
      date: june(1),
      pnl: 300,
      strategies: [
        strategy('G4M', '1.2', { realized: 500 }),
        strategy('OGX', '2.4', { realized: -50 }),
        strategy('URGO', '4.5', { realized: -150 }),
      ],
    }] })]);

    const composite = buildAlgorithmComposite(result, ['G4M', 'OGX', 'URGO']);
    expect(composite.series).toEqual([{ date: june(1), pnl: 300 }]);
    expect(composite.parts.reduce((total, part) => total + part.totalPnl, 0)).toBeCloseTo(300, 2);
    // Crediting each algorithm the whole day would give $900 here, and every fall
    // measured on that curve would be three times too deep.
    expect(composite.series[0].pnl).not.toBeCloseTo(900, 2);
    expect(composite.overlapDays).toBe(1);
  });

  it('keeps the funded money whole across the rows, the unknown days and the unsplit bucket', () => {
    const book = [
      client({ id: 'sole', accountName: 'S1', days: [{ date: june(1), pnl: 120 }, { date: june(2), pnl: -80 }] }),
      client({ id: 'measured', accountName: 'M1', days: [{ date: june(1), pnl: 300, strategies: [
        strategy('G4M', '1.2', { realized: 500 }), strategy('OGX', '2.4', { realized: -200 }),
      ] }] }),
      client({ id: 'unsplit', accountName: 'U1', days: [{ date: june(2), pnl: -500, strategies: [
        strategy('G4M', '1.2', { realized: -100 }), strategy('B2X', '2.5', { realized: -100 }),
      ] }] }),
      client({ id: 'unknown', accountName: 'K1', days: [{ date: june(2), pnl: -7, strategies: [] }] }),
    ];
    const result = build(book);
    const { population, unsplit, reconciliation } = result;

    expect(population.fundedDays).toBe(5);
    expect(population.includedPnl + population.unknownPnl + unsplit.pnl).toBeCloseTo(population.fundedPnl, 2);
    const credited = result.rows.reduce((total, r) => total + r.totalPnl, 0);
    expect(credited).toBeCloseTo(population.includedPnl + reconciliation.residualPnl, 2);
    expect(reconciliation.residualPnl).toBeCloseTo(0, 2);
    expect(unsplit.days).toBe(1);
    expect(unsplit.pnl).toBeCloseTo(-500, 2);
  });

  it('sums a date across accounts into one series point while counting both account days', () => {
    const twoAccounts = {
      id: 'two',
      accountRegistry: {
        A1: { accountName: 'A1', accountType: 'Funded', status: 'Active', dateFailed: '' },
        A2: { accountName: 'A2', accountType: 'Funded', status: 'Active', dateFailed: '' },
      },
      dailyImports: [{
        date: june(1),
        accounts: {},
        executions: [],
        snapshots: [
          { accountName: 'A1', grossRealizedPnl: 100, strategies: [strategy('URGO', '4.5')] },
          { accountName: 'A2', grossRealizedPnl: -30, strategies: [strategy('URGO', '4.5')] },
        ],
      }],
    };
    const urgo = row(build([twoAccounts]), 'URGO');
    expect(urgo.series).toEqual([{ date: june(1), pnl: 70 }]);
    expect(urgo).toMatchObject({ days: 2, accounts: 2, clients: 1 });
  });
});

describe('temperature and ordering', () => {
  it('puts the warmest row first, not the loudest one', () => {
    // Sorting by magnitude listed OGX at -$405 Cold above G4M at +$360 Hot on the
    // client screen, because 405 is more than 360. Hottest means warmest.
    const result = build([
      client({ id: 'cold', accountName: 'C1', days: [{ date: june(1), pnl: -405, strategies: [strategy('OGX', '2.4')] }] }),
      client({ id: 'hot', accountName: 'H1', days: [{ date: june(1), pnl: 360, strategies: [strategy('G4M', '1.2')] }] }),
    ]);
    expect(result.rows.map((r) => r.key)).toEqual(['G4M', 'OGX']);
    expect(result.rows.map((r) => r.temperature)).toEqual(['Hot', 'Cold']);
  });

  it('breaks a tie on the key so the order does not depend on which client loaded first', () => {
    const result = build([
      client({ id: 'z', accountName: 'Z1', days: [{ date: june(1), pnl: 0, strategies: [strategy('URGO', '4.5')] }] }),
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: 0, strategies: [strategy('B2X', '2.5')] }] }),
    ]);
    expect(result.rows.map((r) => r.heat)).toEqual([0, 0]);
    expect(result.rows.map((r) => r.key)).toEqual(['B2X', 'URGO']);
  });

  it('sums the last three credited trading dates and names them', () => {
    // The client screen's "last three" is the last three (snapshot, strategy)
    // pairs it walked, which for one family on four accounts spans four accounts
    // inside one close. Here the unit is three dates, and the row says which.
    const result = build([client({ days: [1, 2, 3, 4, 5].map((d) => ({ date: june(d), pnl: d * 100 })) })]);
    const urgo = row(result, 'URGO');
    expect(HEAT_DATES).toBe(3);
    expect(urgo.heat).toBeCloseTo(300 + 400 + 500, 2);
    expect(urgo.heatDates).toEqual([june(3), june(4), june(5)]);
    expect(urgo.totalPnl).toBeCloseTo(1500, 2);
  });

  it('holds the thresholds the client screen already uses, on the boundary as well', () => {
    expect(HOT_ABOVE).toBe(250);
    expect(COLD_BELOW).toBe(-250);
    expect(temperatureOf(251)).toBe('Hot');
    expect(temperatureOf(250)).toBe('Stable');
    expect(temperatureOf(-250)).toBe('Stable');
    expect(temperatureOf(-251)).toBe('Cold');
    expect(temperatureOf(0)).toBe('Stable');
  });

  it('flags a thin row against the same gate the combo table beside it states', () => {
    const thin = build([client({ days: [{ date: june(1), pnl: 1000, strategies: [strategy('OGX', '2.4')] }] })]);
    expect(row(thin, 'OGX')).toMatchObject({ days: 1, accounts: 1, lowSample: true });

    const gated = build(crowd('G4M', 10));
    expect(row(gated, 'G4M')).toMatchObject({ days: 10, accounts: 10, lowSample: false });
    expect(gated.minDays).toBe(MIN_DAYS);
    expect(gated.minAccounts).toBe(MIN_ACCOUNTS);

    // Heat orders the table, so the one day row still sorts above the gated one
    // and nothing here crowns it. The screen has `lowSample` to say so.
    const both = build([...crowd('G4M', 10), client({ id: 'lucky', accountName: 'L1', days: [{ date: june(1), pnl: 1000, strategies: [strategy('OGX', '2.4')] }] })]);
    expect(both.rows.map((r) => r.key)).toEqual(['OGX', 'G4M']);
    expect(both.rows.map((r) => r.lowSample)).toEqual([true, false]);
  });

  it('rolls versions of one family into one row by default and separates them when asked', () => {
    const days = [{ date: june(1), pnl: 100, strategies: [strategy('URGO', '4.5')] }, { date: june(2), pnl: 50, strategies: [strategy('URGO', '2.0')] }];
    const byFamily = build([client({ days })]);
    expect(byFamily.level).toBe('family');
    expect(byFamily.rows.map((r) => r.key)).toEqual(['URGO']);
    expect(row(byFamily, 'URGO').days).toBe(2);

    const byVersion = build([client({ days })], { level: 'version' });
    expect(byVersion.rows.map((r) => r.key).sort()).toEqual(['URGO 2.0', 'URGO 4.5']);
    expect(row(byVersion, 'URGO 4.5').family).toBe('URGO');
  });

  it('starts from family level, where the combo table starts from version level', () => {
    expect(DEFAULT_OPTIONS).toEqual({
      basis: 'traded',
      level: 'family',
      window: { preset: 30, from: null, to: null },
      minDays: 10,
      minAccounts: 3,
      includeFailed: true,
    });
  });
});

describe('the deepest dip inside the window', () => {
  it('measures the fall from the curve\'s own peak and reports it as a negative number', () => {
    const result = build([client({ days: [
      { date: june(1), pnl: 200 }, { date: june(2), pnl: -50 }, { date: june(3), pnl: -100 }, { date: june(4), pnl: 20 },
    ] })]);
    const urgo = row(result, 'URGO');
    expect(urgo.equity).toEqual([
      { date: june(1), cum: 200, peak: 200, dip: 0 },
      { date: june(2), cum: 150, peak: 200, dip: -50 },
      { date: june(3), cum: 50, peak: 200, dip: -150 },
      { date: june(4), cum: 70, peak: 200, dip: -130 },
    ]);
    expect(urgo.deepestDip).toBeCloseTo(-150, 2);
    expect(urgo.deepestDipFrom).toBe(june(1));
    expect(urgo.deepestDipTo).toBe(june(3));
  });

  it('reports the whole loss on a curve that only ever falls, because the window opened at zero', () => {
    // This is most of the production book, and it is the reason the peak is
    // seeded at 0 rather than at the first point's value: the window opens with
    // the algorithm having contributed nothing, so the first day's loss is a real
    // fall from where the curve began. Seeding from the first point would report
    // -$100 here and call the other -$200 no fall at all.
    const result = build([client({ days: [1, 2, 3].map((d) => ({ date: june(d), pnl: -100 })) })]);
    const urgo = row(result, 'URGO');
    expect(urgo.totalPnl).toBeCloseTo(-300, 2);
    expect(urgo.deepestDip).toBeCloseTo(-300, 2);
    expect(urgo.deepestDip).toBeCloseTo(urgo.totalPnl, 2);
    // The fall runs from the curve's origin, which has no date of its own.
    expect(urgo.deepestDipFrom).toBe('');
    expect(urgo.deepestDipTo).toBe(june(3));
  });

  it('calls one winning trading date a fall of zero, which is the answer and not a gap', () => {
    const result = build([client({ days: [{ date: june(1), pnl: 750 }] })]);
    const urgo = row(result, 'URGO');
    expect(urgo).toMatchObject({ days: 1, deepestDip: 0, deepestDipFrom: '', deepestDipTo: '' });
    expect(urgo.avgPnl).toBeCloseTo(750, 2);
    expect(urgo.equity).toEqual([{ date: june(1), cum: 750, peak: 750, dip: 0 }]);
  });

  it('calls one losing trading date a fall of that loss, by the same rule as the long one', () => {
    // The two readings of a single date cannot both hold. Under a peak seeded at
    // the curve's own origin a lone losing date fell by its loss, exactly as a
    // three day slide falls by its total; under a peak seeded at the first
    // point's value a lone date always reads 0 and the three day slide reads
    // -$200 of its -$300. One date is not a special case here, and this is the
    // pair that says which rule is running.
    const result = build([client({ days: [{ date: june(1), pnl: -750 }] })]);
    const urgo = row(result, 'URGO');
    expect(urgo).toMatchObject({ days: 1, deepestDip: -750, deepestDipFrom: '', deepestDipTo: june(1) });
    expect(urgo.deepestDip).toBeCloseTo(urgo.totalPnl, 2);
    expect(urgo.equity).toEqual([{ date: june(1), cum: -750, peak: 0, dip: -750 }]);
  });

  it('measures an empty curve without dividing by anything', () => {
    expect(curveOf([])).toEqual({ equity: [], deepestDip: 0, deepestDipFrom: '', deepestDipTo: '' });
    expect(curveOf()).toMatchObject({ deepestDip: 0 });
  });
});

describe('the composite against the sum of its parts', () => {
  const hedged = [
    client({ id: 'a', accountName: 'A1', days: [
      { date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] },
      { date: june(2), pnl: 100, strategies: [strategy('G4M', '1.2')] },
    ] }),
    client({ id: 'b', accountName: 'B1', days: [
      { date: june(1), pnl: 100, strategies: [strategy('OGX', '2.4')] },
      { date: june(2), pnl: -100, strategies: [strategy('OGX', '2.4')] },
    ] }),
  ];

  it('adds the selected algorithms day by day and measures the fall of that curve', () => {
    const result = build(hedged);
    const composite = buildAlgorithmComposite(result, ['G4M', 'OGX']);
    expect(composite.series).toEqual([{ date: june(1), pnl: 0 }, { date: june(2), pnl: 0 }]);
    expect(composite.deepestDip).toBe(0);
    expect(composite.parts).toEqual([
      { key: 'G4M', deepestDip: -100, totalPnl: 0 },
      { key: 'OGX', deepestDip: -100, totalPnl: 0 },
    ]);
    expect(composite.sumOfPartDips).toBeCloseTo(-200, 2);
    expect(composite.overlapDays).toBe(2);
    expect(composite.overlapDates).toEqual([june(1), june(2)]);
    // A perfect hedge is the shape that used to print "100.00% lower": the
    // denominator is -$200, the numerator is 0, and 1 - (0 / -200) is 1. The
    // curve did not fall, so there is no fall to be a reduction of.
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
  });

  it('carries the caveat about what the sum of the parts is not, every time', () => {
    // `reduction` is the figure that ends up in a document a client pays for, and
    // it invites one reading: that the combined curve fell less than "the
    // portfolio" would have. There is no such portfolio, and the denominator is
    // a sum over whatever was selected.
    //
    // The sentence used to end "the sum grows with every algorithm added and this
    // reduction grows with it", and the book falsifies both halves: a real row can
    // have a dip of exactly 0, and the reduction falls at 6 of the 13 nesting
    // steps over the stored book. What is asserted here is the half that holds,
    // and the two tests below pin the arithmetic behind it.
    const composite = buildAlgorithmComposite(build(hedged), ['G4M', 'OGX']);
    expect(composite.caveat).toContain('not a portfolio anyone held');
    expect(composite.caveat).toContain('never shrinks as algorithms are added');
    expect(composite.caveat).toContain('belongs to the selection');
    expect(composite.caveat).not.toMatch(/grows with it/);
    expect(composite.caveat).toContain('over these dates');
    // Rendered inside a section asserted against dashes of every kind.
    expect(composite.caveat).not.toMatch(/[–—]/);
    expect(composite.caveat).not.toMatch(/\s-\s/);
  });

  it('refuses a reduction when nothing fell, rather than calling it a hundred percent', () => {
    // TWO algorithms, not one: the old version of this test selected a single
    // flat row, which the module now refuses as `singleAlgorithm` before the
    // denominator is ever looked at, so it passed while saying nothing about the
    // case its name promises. Here the selection is comparable in every other
    // respect and it is the curves that never fell.
    const flat = build([
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: 0, strategies: [strategy('G4M', '1.2')] }] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(1), pnl: 0, strategies: [strategy('OGX', '2.4')] }] }),
    ]);
    const composite = buildAlgorithmComposite(flat, ['G4M', 'OGX']);
    expect(composite.parts).toHaveLength(2);
    expect(composite.overlapDays).toBe(1);
    expect(composite.sumOfPartDips).toBe(0);
    expect(composite.deepestDip).toBe(0);
    // 1 - (0 / 0) is NaN and 1 - (0 / -200) is 1. Neither is printable.
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
    expect(composite.caveat).toBeTruthy();
  });

  it('ignores a selected key no row answers to, instead of adding an empty part', () => {
    // NOT because a 0 part would move the reduction: adding 0 to a sum of negative
    // dips changes neither the sum nor the ratio, and an earlier version of this
    // comment claimed otherwise. There is simply nothing there to be a part of
    // anything, and `parts` is what the screen lists.
    const result = build(hedged);
    const composite = buildAlgorithmComposite(result, ['G4M', 'NOT_AN_ALGO']);
    expect(composite.parts.map((p) => p.key)).toEqual(['G4M']);
    expect(composite.sumOfPartDips).toBeCloseTo(-100, 2);
    // And what is left is one algorithm, so there is no comparison either: the
    // refusal names the selection that survived, not the key that was dropped.
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('singleAlgorithm');
  });

  it('leaves the denominator alone when a real part never fell, and says why it can move anyway', () => {
    // The shape the book has and the fixtures did not: a row that WAS credited,
    // on a winning day, so its `deepestDip` is exactly 0. On the stored book that
    // is ARPD_PF, +$430 on one account day.
    //
    // Two things have to hold at once, and the caveat's old wording had them
    // backwards. Adding such a part cannot move the DENOMINATOR, because 0 added
    // to a sum of dips is that sum. It can still move the reduction, because its
    // winning day lifts the COMPOSITE's own curve, which is the numerator. So the
    // figure is not monotone in the number of algorithms selected, and nothing
    // printed beside it may claim a direction.
    // Three accounts on ONE date, so each algorithm is SOLE on its own account day
    // and the composite adds them on that date rather than inside one close. The
    // base selection is TWO fallen algorithms rather than one, because a selection
    // of one is refused outright and there would be no `before` figure to move.
    const withAWinner = build([
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: -1000, strategies: [strategy('G4M', '1.2')] }] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(1), pnl: 400, strategies: [strategy('WINR', '1.0')] }] }),
      client({ id: 'c', accountName: 'C1', days: [{ date: june(1), pnl: -200, strategies: [strategy('OGX', '2.4')] }] }),
    ]);
    const winner = withAWinner.rows.find((r) => r.key === 'WINR');
    expect(winner.deepestDip).toBe(0);
    expect(winner.totalPnl).toBeCloseTo(400, 2);

    const alone = buildAlgorithmComposite(withAWinner, ['G4M', 'OGX']);
    const both = buildAlgorithmComposite(withAWinner, ['G4M', 'OGX', 'WINR']);
    expect(alone.reduction).toBeCloseTo(0, 6);
    expect(both.sumOfPartDips).toBeCloseTo(alone.sumOfPartDips, 6);
    // The numerator moved, so the reduction did, upward, on a part that added
    // nothing to the thing it is divided by.
    expect(both.deepestDip).toBeGreaterThan(alone.deepestDip);
    expect(both.reduction).toBeGreaterThan(alone.reduction);
    expect(both.reduction).toBeCloseTo(1 / 3, 6);
  });

  it('never lets the sum of the parts shrink as parts are added, which is the half the caveat claims', () => {
    // The one direction that IS a theorem rather than an observation: every dip is
    // negative or zero, so a wider selection's sum is never closer to zero.
    const result = build(hedged);
    const keys = result.rows.map((r) => r.key);
    let previous = 0;
    for (let n = 1; n <= keys.length; n += 1) {
      const sum = buildAlgorithmComposite(result, keys.slice(0, n)).sumOfPartDips;
      expect(sum).toBeLessThanOrEqual(previous + 1e-9);
      previous = sum;
    }
  });

  it('counts no overlap between algorithms that never traded on the same date', () => {
    const apart = build([
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] }] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(2), pnl: -100, strategies: [strategy('OGX', '2.4')] }] }),
    ]);
    const composite = buildAlgorithmComposite(apart, ['G4M', 'OGX']);
    expect(composite.overlapDays).toBe(0);
    expect(composite.series).toEqual([{ date: june(1), pnl: -100 }, { date: june(2), pnl: -100 }]);
    expect(composite.deepestDip).toBeCloseTo(-200, 2);
    // And the comparison is refused rather than published beside the count: the
    // curves are laid end to end, so neither ever offset the other.
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('noSharedDate');
  });

  it('takes the selection as a Set as well as an array', () => {
    const result = build(hedged);
    expect(buildAlgorithmComposite(result, new Set(['G4M'])).parts.map((p) => p.key)).toEqual(['G4M']);
  });
});

describe('when there is no comparison to make, and the panel has to say which', () => {
  // Two algorithms on the same two dates whose combined curve DOES fall, so a
  // reduction is published here and every refusal below is a refusal of
  // something this fixture can otherwise produce.
  const hedgedBook = [
    client({ id: 'a', accountName: 'A1', days: [
      { date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] },
      { date: june(2), pnl: 50, strategies: [strategy('G4M', '1.2')] },
    ] }),
    client({ id: 'b', accountName: 'B1', days: [
      { date: june(1), pnl: 20, strategies: [strategy('OGX', '2.4')] },
      { date: june(2), pnl: -100, strategies: [strategy('OGX', '2.4')] },
    ] }),
  ];

  // THE REPRODUCED DEFECT, in the shape the real book has it. Rank 1 and rank 2
  // of the panel's default view, ARPD_PF and DJDR, are both credited on exactly
  // one account day, 2026-07-13: ARPD_PF won $430 on it and DJDR lost $25.50.
  // Selecting the top two rows, which is two clicks from a cold open, rendered
  // "Combined $0 against -$26 for the sum of the parts, 100.00% lower."
  const topTwo = build([
    client({ id: 'a', accountName: 'A1', days: [{ date: june(13), pnl: 430, strategies: [strategy('ARPD_PF', '1.1')] }] }),
    client({ id: 'b', accountName: 'B1', days: [{ date: june(13), pnl: -25.5, strategies: [strategy('DJDR', '1.0')] }] }),
  ]);

  it('refuses the comparison when the combined curve never fell, instead of printing 100%', () => {
    const composite = buildAlgorithmComposite(topTwo, ['ARPD_PF', 'DJDR']);
    // Everything the old guard checked is fine here: two real parts, a shared
    // date, and a denominator that is not zero. It is the NUMERATOR that is 0.
    expect(composite.parts).toHaveLength(2);
    expect(composite.overlapDays).toBe(1);
    expect(composite.sumOfPartDips).toBeCloseTo(-25.5, 2);
    expect(composite.deepestDip).toBe(0);

    expect(composite.reduction).toBeNull();
    expect(composite.reduction).not.toBe(1);
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
    expect(composite.reductionNote).toBe(REDUCTION_REFUSALS.compositeNeverFell);
    // Nothing for a screen to format as a percentage, and no basis sentence for
    // a figure that does not exist.
    expect(composite.reductionBasis).toBeNull();
  });

  it('refuses a fall of a float residue, which is 100% lower exactly like a fall of nothing', () => {
    // Three ordinary cent sized figures on one date. 0.3 - 0.1 - 0.2 is
    // -2.8e-17 in binary, so the combined curve "falls" by less than an atom
    // against a sum of parts of -$0.30, and 1 - (-2.8e-17 / -0.3) is
    // 0.9999999999999999. The screen would print "Combined $0 against -$0 for
    // the sum of the parts, 100.00% lower", which is the reported defect again
    // with rounding standing in for a winning day.
    const residue = build([
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: 0.3, strategies: [strategy('WINR', '1.0')] }] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(1), pnl: -0.1, strategies: [strategy('G4M', '1.2')] }] }),
      client({ id: 'c', accountName: 'C1', days: [{ date: june(1), pnl: -0.2, strategies: [strategy('OGX', '2.4')] }] }),
    ]);
    const composite = buildAlgorithmComposite(residue, ['WINR', 'G4M', 'OGX']);
    expect(composite.parts).toHaveLength(3);
    expect(composite.overlapDays).toBe(1);
    expect(composite.deepestDip).toBeLessThan(0);
    expect(composite.deepestDip).toBeGreaterThan(-0.005);
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
  });

  it('refuses a selection of one algorithm, which is a curve compared against itself', () => {
    const one = buildAlgorithmComposite(build([
      client({ days: [1, 2, 3].map((d) => ({ date: june(d), pnl: -100 })) }),
    ]), ['URGO']);
    // The composite IS the part, so the old arithmetic gave exactly 0.00% and the
    // panel printed it as a measured result "over 0 dates".
    expect(one.parts).toHaveLength(1);
    expect(one.deepestDip).toBeCloseTo(one.sumOfPartDips, 6);
    expect(one.reduction).toBeNull();
    expect(one.reductionRefusal).toBe('singleAlgorithm');
    expect(one.reductionNote).toBe(REDUCTION_REFUSALS.singleAlgorithm);
  });

  it('refuses algorithms that never shared a date even when the arithmetic gives a large figure', () => {
    // Not merely the 0.00% case. Interleaved dates make the combined curve look
    // like it halved the fall while neither algorithm was ever running on a day
    // the other one was: -$50 on the 1st and the 3rd for G4M, +$200 on the 2nd
    // for OGX, and 1 - (-50 / -100) is 50%.
    const interleaved = build([
      client({ id: 'a', accountName: 'A1', days: [
        { date: june(1), pnl: -50, strategies: [strategy('G4M', '1.2')] },
        { date: june(3), pnl: -50, strategies: [strategy('G4M', '1.2')] },
      ] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(2), pnl: 200, strategies: [strategy('OGX', '2.4')] }] }),
    ]);
    const composite = buildAlgorithmComposite(interleaved, ['G4M', 'OGX']);
    expect(composite.deepestDip).toBeCloseTo(-50, 2);
    expect(composite.sumOfPartDips).toBeCloseTo(-100, 2);
    expect(composite.overlapDays).toBe(0);
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('noSharedDate');
    expect(composite.reductionNote).toBe(REDUCTION_REFUSALS.noSharedDate);
  });

  it('refuses an empty selection without inventing a curve', () => {
    const composite = buildAlgorithmComposite(build(hedgedBook), []);
    expect(composite.parts).toEqual([]);
    expect(composite.series).toEqual([]);
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('noSelection');
    expect(composite.reductionNote).toBe(REDUCTION_REFUSALS.noSelection);
  });

  it('separates a selection nothing measured from a selection of nothing', () => {
    // Both refuse, and they are two different sentences: one says nothing is
    // selected, the other says what is selected was credited on no day and its
    // money is in the unsplit bucket. A panel printing "select an algorithm"
    // over the second one is telling a CAM to do what they just did.
    const allUnsplit = build([client({ days: [1, 2].map((d) => ({
      date: june(d),
      pnl: -1000,
      strategies: [strategy('G4M', '1.2', { realized: -100 }), strategy('URGO', '4.5', { realized: -100 })],
    })) })]);
    const composite = buildAlgorithmComposite(allUnsplit, ['G4M', 'URGO']);
    expect(composite.parts).toEqual([]);
    expect(composite.unmeasuredKeys).toEqual(['G4M', 'URGO']);
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('allUnmeasured');
    expect(composite.reductionRefusal).not.toBe('noSelection');
    expect(composite.reductionNote).toBe(REDUCTION_REFUSALS.allUnmeasured);
  });

  it('publishes a figure or a refusal and never both, so nothing can print the one it prefers', () => {
    const measured = buildAlgorithmComposite(build(hedgedBook), ['G4M', 'OGX']);
    expect(measured.reduction).not.toBeNull();
    expect(measured.reductionRefusal).toBeNull();
    expect(measured.reductionNote).toBeNull();
    expect(measured.reductionBasis).toBeTruthy();

    for (const keys of [[], ['G4M'], ['NOPE'], ['G4M', 'NOPE']]) {
      const refused = buildAlgorithmComposite(build(hedgedBook), keys);
      expect(refused.reduction).toBeNull();
      expect(Object.keys(REDUCTION_REFUSALS)).toContain(refused.reductionRefusal);
      expect(refused.reductionNote).toBe(REDUCTION_REFUSALS[refused.reductionRefusal]);
      expect(refused.reductionBasis).toBeNull();
    }
  });

  it('carries a sentence per refusal, written for the screen rather than for a log', () => {
    // The same contract `UNSPLIT_REASONS` holds: the module names the cause and
    // supplies the words, so no screen writes a reason of its own. Rendered in
    // the Stack Playbook, which is asserted against dashes of every kind.
    expect(Object.keys(REDUCTION_REFUSALS)).toEqual([
      'noSelection', 'allUnmeasured', 'singleAlgorithm', 'noSharedDate', 'compositeNeverFell',
    ]);
    for (const note of Object.values(REDUCTION_REFUSALS)) {
      expect(note.length).toBeGreaterThan(40);
      expect(note).not.toMatch(/[–—]/);
      expect(note).not.toMatch(/\s-\s/);
    }
    // The wording the panel already uses for the case it did refuse, so the two
    // branches cannot drift into two different sentences for one refusal.
    expect(REDUCTION_REFUSALS.compositeNeverFell).toContain('not a reduction of 100%');
  });

  it('says which dates the figure covers, and they are not the overlap dates', () => {
    // THE SECOND HALF OF THE SAME DEFECT. Both the composite's dip and the sum of
    // the parts' dips are measured over EVERY date any selected algorithm was
    // credited on. The panel printed "measured over N dates on which more than
    // one of the selected algorithms was credited", which is the overlap count:
    // on the real book it said 4 where the comparison spanned 12.
    const staggered = build([
      client({ id: 'a', accountName: 'A1', days: [
        { date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] },
        { date: june(2), pnl: 50, strategies: [strategy('G4M', '1.2')] },
        { date: june(3), pnl: -100, strategies: [strategy('G4M', '1.2')] },
      ] }),
      client({ id: 'b', accountName: 'B1', days: [
        { date: june(3), pnl: 200, strategies: [strategy('OGX', '2.4')] },
        { date: june(4), pnl: -300, strategies: [strategy('OGX', '2.4')] },
        { date: june(5), pnl: 50, strategies: [strategy('OGX', '2.4')] },
      ] }),
    ]);
    const composite = buildAlgorithmComposite(staggered, ['G4M', 'OGX']);
    expect(composite.reduction).toBeCloseTo(1 / 3, 6);

    // Five dates carry the comparison and exactly one of them carries both.
    expect(composite.reductionDateCount).toBe(5);
    expect(composite.reductionDates).toEqual([june(1), june(2), june(3), june(4), june(5)]);
    expect(composite.overlapDays).toBe(1);
    expect(composite.overlapDates).toEqual([june(3)]);
    expect(composite.reductionDateCount).toBe(composite.series.length);

    // And the module says so in words, so the sentence beside the percentage is
    // not the screen's guess about which dates it covers.
    expect(composite.reductionBasis).toBe(
      'Measured over 5 dates on which at least one selected algorithm was credited, '
      + 'not only the 1 date on which more than one of them was.',
    );
    expect(composite.reductionBasis).not.toMatch(/[–—]/);
    expect(composite.reductionBasis).not.toMatch(/\s-\s/);
  });

  it('counts the comparison\'s dates in singular and plural, because the panel prints the string', () => {
    const oneDate = buildAlgorithmComposite(build([
      client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] }] }),
      client({ id: 'b', accountName: 'B1', days: [{ date: june(1), pnl: -200, strategies: [strategy('OGX', '2.4')] }] }),
    ]), ['G4M', 'OGX']);
    expect(oneDate.reductionDateCount).toBe(1);
    expect(oneDate.reductionBasis).toBe(
      'Measured over 1 date on which at least one selected algorithm was credited, '
      + 'not only the 1 date on which more than one of them was.',
    );
  });
});

describe('robustness', () => {
  it('measures an empty book without inventing a window or a row', () => {
    const result = buildAlgorithmTemperature([]);
    expect(result.rows).toEqual([]);
    expect(result.unsplit).toMatchObject({ days: 0, pnl: 0, dates: [] });
    expect(result.population).toMatchObject({
      fundedDays: 0, fundedPnl: 0, avgPnlPerAccountDay: 0, includedDays: 0, unknownDays: 0, accounts: 0, clients: 0,
    });
    expect(result.window).toMatchObject({ from: '', to: '', anchor: '' });
    expect(result.reconciliation).toMatchObject({ checkedDays: 0, reconciledDays: 0, residualPnl: 0 });
  });

  it('survives the shapes a half loaded book arrives in', () => {
    expect(() => buildAlgorithmTemperature()).not.toThrow();
    expect(() => buildAlgorithmTemperature([{ id: 'c1' }])).not.toThrow();
    expect(() => buildAlgorithmTemperature([{ id: 'c1', dailyImports: [{ date: june(1) }] }])).not.toThrow();
    expect(buildAlgorithmComposite(null, ['G4M']).parts).toEqual([]);
    expect(buildAlgorithmComposite(undefined).reduction).toBeNull();
  });

  it('runs every accumulator over the window only', () => {
    const result = buildAlgorithmTemperature([client({ days: [1, 2, 3, 4, 5, 6].map((d) => ({ date: june(d), pnl: 10 })) })], { window: { preset: 3 } });
    expect(result.window).toMatchObject({ preset: 3, from: june(4), to: june(6) });
    const urgo = row(result, 'URGO');
    expect(urgo.days).toBe(3);
    expect(urgo.series.map((p) => p.date)).toEqual([june(4), june(5), june(6)]);
    expect(result.population.fundedDays).toBe(3);
  });

  it('keeps a Failed account\'s own days unless the caller asks for the old population', () => {
    const failed = client({ status: 'Failed', days: [1, 2, 3].map((d) => ({ date: june(d), pnl: -100 })) });
    expect(row(build([failed]), 'URGO').days).toBe(3);
    expect(build([failed]).population.failedAccountDays).toBe(3);
    expect(build([failed], { includeFailed: false }).rows).toEqual([]);
  });

  it('leaves an account that is not funded out of every figure', () => {
    const evaluation = client({ accountType: 'Evaluation', days: [{ date: june(1), pnl: -100 }] });
    const result = build([evaluation]);
    expect(result.rows).toEqual([]);
    expect(result.population.fundedDays).toBe(0);
  });
});

describe('why a day sat out, named per day rather than asserted in prose', () => {
  // One account day of each refusal shape, on four accounts so the window holds
  // all of them. These three shapes are not interchangeable and the panel has to
  // name the one that actually applied: this file's header used to explain the
  // whole refused population with the third sentence, and on the stored book the
  // third shape is 43 of the 115 refused days while the second is 72 of them.
  const refusals = [
    client({ id: 'missing', accountName: 'MF1', days: [{
      date: june(1),
      pnl: -300,
      strategies: [strategy('G4M', '1.2', { realized: -300 })],
      executions: ['0 - OGX-2.4'],
    }] }),
    client({ id: 'zeros', accountName: 'UZ1', days: [{
      date: june(1),
      pnl: -200,
      strategies: [strategy('G4M', '1.2'), strategy('URGO', '4.5')],
    }] }),
    client({ id: 'zerosflat', accountName: 'UF1', days: [{
      date: june(1),
      pnl: 0,
      strategies: [strategy('G4M', '1.2'), strategy('URGO', '4.5')],
    }] }),
    client({ id: 'mismatch', accountName: 'MM1', days: [{
      date: june(1),
      pnl: -500,
      strategies: [strategy('G4M', '1.2', { realized: -100 }), strategy('URGO', '4.5', { realized: -100 })],
    }] }),
  ];

  it('separates a missing figure from figures that are all zero from figures that do not add up', () => {
    const { unsplit, reconciliation } = build(refusals);

    expect(unsplit.days).toBe(4);
    expect(unsplit.reasons.missingFigure).toMatchObject({ days: 1, pnl: -300 });
    expect(unsplit.reasons.unreported).toMatchObject({ days: 2, pnl: -200, flatDays: 1 });
    expect(unsplit.reasons.mismatched).toMatchObject({ days: 1, pnl: -500 });
    // Only the last two were ever checked: a day with no complete set of figures
    // never reaches the tolerance.
    expect(reconciliation).toMatchObject({ checkedDays: 3, reconciledDays: 0, refusedDays: 3 });
  });

  it('accounts for every day and every dollar that sat out under exactly one reason', () => {
    const { unsplit } = build(refusals);
    const reasons = Object.values(unsplit.reasons);
    expect(reasons.reduce((total, reason) => total + reason.days, 0)).toBe(unsplit.days);
    expect(reasons.reduce((total, reason) => total + reason.pnl, 0)).toBeCloseTo(unsplit.pnl, 2);
  });

  it('says a flat day\'s zeros did add up to the account and was refused anyway', () => {
    // 28 of the 115 refused days on the stored book are this shape: every figure
    // exactly $0 against an account day of exactly $0, which reconciles to the
    // cent and is still refused, because nothing measured it. Calling these
    // "figures that did not add up" names the wrong cause.
    const { unsplit, reconciliation } = build([refusals[2]]);
    expect(unsplit.reasons.unreported).toMatchObject({ days: 1, flatDays: 1, pnl: 0 });
    expect(unsplit.reasons.mismatched.days).toBe(0);
    expect(reconciliation).toMatchObject({ checkedDays: 1, reconciledDays: 0, refusedDays: 1 });
  });

  it('carries the reason\'s own wording with the count, so the panel does not write a cause', () => {
    const { unsplit } = build(refusals);
    expect(unsplit.reasons.missingFigure.note).toBe(UNSPLIT_REASONS.missingFigure);
    expect(unsplit.reasons.unreported.note).toBe(UNSPLIT_REASONS.unreported);
    expect(unsplit.reasons.mismatched.note).toBe(UNSPLIT_REASONS.mismatched);
    expect(UNSPLIT_REASONS.unreported).toContain('unreported day');
    expect(UNSPLIT_REASONS.mismatched).toContain('do not add up');
    expect(UNSPLIT_REASONS.missingFigure).toContain('no figure');
    // Rendered in the same section as the caveat, which is asserted against
    // dashes of every kind.
    for (const note of Object.values(UNSPLIT_REASONS)) {
      expect(note).not.toMatch(/[–—]/);
      expect(note).not.toMatch(/\s-\s/);
    }
  });

  it('carries the refusal note on the bucket itself', () => {
    const { unsplit } = build(refusals);
    expect(unsplit.note).toBe(UNSPLIT_NOTE);
    expect(UNSPLIT_NOTE).toContain('never divided equally');
    expect(UNSPLIT_NOTE).toContain('invents which');
  });
});

describe('the words this panel publishes for its own fall', () => {
  const names = (value, out = new Set()) => {
    if (Array.isArray(value)) {
      for (const entry of value) names(entry, out);
      return out;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        out.add(key);
        names(entry, out);
      }
      return out;
    }
    return out;
  };

  const book = [
    client({ id: 'a', accountName: 'A1', days: [{ date: june(1), pnl: -100, strategies: [strategy('G4M', '1.2')] }] }),
    client({ id: 'b', accountName: 'B1', days: [{ date: june(2), pnl: 40, strategies: [strategy('OGX', '2.4')] }] }),
  ];

  it('publishes no field a screen could wire straight into a prop firm drawdown column', () => {
    // "Drawdown" on every other panel in this product is how close a prop account
    // is to being killed by its firm (Dashboard.jsx prints `trailingMaxDrawdown`
    // under that header). A field here called `maxDrawdown` is read as that
    // quantity by a screen that never opens this file, which is the whole
    // confusion the wording below exists to prevent.
    const result = build(book);
    const composite = buildAlgorithmComposite(result, ['G4M', 'OGX']);
    const published = [...names(result), ...names(composite)];

    expect(published.filter((name) => /drawdown/i.test(name))).toEqual([]);
    // And it is not passing by publishing nothing: the fall is there under the
    // product's own word for it.
    expect(published).toContain('deepestDip');
    expect(published).toContain('deepestDipFrom');
    expect(published).toContain('deepestDipTo');
    expect(published).toContain('dip');
    expect(published).toContain('sumOfPartDips');
  });

  it('publishes the wording beside the figure, so no screen has to invent one', () => {
    const result = build(book);
    expect(result.dipLabel).toBe(DEEPEST_DIP_LABEL);
    expect(buildAlgorithmComposite(result, ['G4M']).dipLabel).toBe(DEEPEST_DIP_LABEL);
  });

  it('uses the wording this product already renders for this exact quantity', () => {
    // PerformanceCharts.jsx prints "Deepest dip" over summarizePerformance's
    // `maxDrawdown`, which is the same measurement as this one: the peak to
    // trough fall of a cumulative P&L curve seeded at zero, signed negative.
    // A third wording for one quantity is how the "4.44% lower" this module
    // measures over the stored book's ten gated rows gets quoted against the
    // wrong denominator. That figure is measured in
    // algorithmTemperature.book.test.js; the 51% an earlier version of this
    // comment used came from a production query nothing here can run.
    expect(DEEPEST_DIP_LABEL).toBe('Deepest dip inside this window');
    expect(DEEPEST_DIP_LABEL.startsWith('Deepest dip')).toBe(true);
    expect(DEEPEST_DIP_LABEL.toLowerCase()).not.toContain('drawdown');
  });

  it('names the three cases it tries and the order it tries them in', () => {
    expect(ATTRIBUTION_CASES).toEqual(['sole', 'measured', 'unsplit']);

    // The order is live, not decorative. A solo day whose one row reports a
    // figure that disagrees with the account day is credited the ACCOUNT day:
    // if the measured case were tried first it would be checked against the
    // tolerance and refused, and 56 of the 166 solo days on the stored book that
    // carry a figure at all disagree by more than a dollar.
    const solo = build([client({ days: [{ date: june(1), pnl: 100, strategies: [strategy('URGO', '4.5', { realized: 999 })] }] })]);
    expect(row(solo, 'URGO')).toMatchObject({ totalPnl: 100, days: 1 });
    expect(solo.unsplit.days).toBe(0);
    expect(solo.reconciliation.checkedDays).toBe(0);
  });
});

describe('an algorithm nothing here could measure', () => {
  // The failing input as reported: one funded account, five closes, each one
  // -$1,000 with G4M and URGO both carrying a figure of -$100. Figures present
  // on every algorithm, never reconciling, so all five days go to UNSPLIT and
  // both rows are credited nothing at all.
  const allUnsplit = build([client({ days: [1, 2, 3, 4, 5].map((d) => ({
    date: june(d),
    pnl: -1000,
    strategies: [strategy('G4M', '1.2', { realized: -100 }), strategy('URGO', '4.5', { realized: -100 })],
  })) })]);

  it('does not read it as Stable with a fall of zero', () => {
    const g4m = row(allUnsplit, 'G4M');
    expect(g4m).toMatchObject({
      days: 0,
      series: [],
      heatDates: [],
      unmeasured: true,
      temperature: UNMEASURED_TEMPERATURE,
      deepestDip: null,
      heat: null,
      attribution: { measuredDays: 0, soleDays: 0, unsplitDays: 5 },
    });
    // The two claims this row used to publish. "Stable" is the same instrument
    // the client screen's Hot/Cold/Stable badge uses, and $0.00 under the
    // deepest dip label would tell a CAM an algorithm that ran on five days the
    // desk lost $5,000 never fell.
    expect(g4m.temperature).not.toBe('Stable');
    expect(g4m.deepestDip).not.toBe(0);
    expect(UNMEASURED_TEMPERATURE).not.toBe('Stable');
    expect(allUnsplit.unsplit).toMatchObject({ days: 5, pnl: -5000 });
  });

  it('sorts below every row that was measured, however cold they are', () => {
    // Heat orders this table and an unmeasured row has no heat: leaving it at 0
    // lands it among the rows whose three dates happened to sum near nothing.
    const mixed = build([
      client({ id: 'cold', accountName: 'C1', days: [{ date: june(1), pnl: -9000, strategies: [strategy('B2X', '2.5')] }] }),
      client({ id: 'unsplit', accountName: 'U1', days: [{
        date: june(1),
        pnl: -1000,
        strategies: [strategy('G4M', '1.2', { realized: -100 }), strategy('URGO', '4.5', { realized: -100 })],
      }] }),
    ]);
    expect(mixed.rows.map((r) => r.key)).toEqual(['B2X', 'G4M', 'URGO']);
    expect(mixed.rows.map((r) => r.unmeasured)).toEqual([false, true, true]);
  });

  it('is not counted as a part that never fell when it is selected', () => {
    const composite = buildAlgorithmComposite(allUnsplit, ['G4M', 'URGO']);
    expect(composite.parts).toEqual([]);
    expect(composite.unmeasuredKeys).toEqual(['G4M', 'URGO']);
    expect(composite.sumOfPartDips).toBe(0);
    expect(composite.reduction).toBeNull();
    // Named apart from an empty selection: the rows exist, they were selected,
    // and nothing here measured them.
    expect(composite.reductionRefusal).toBe('allUnmeasured');
  });

  it('keeps a measured selection\'s reduction off an unmeasured row\'s zero', () => {
    // TWO measured rows beside the unmeasured one, so the reduction is published
    // and the assertion is about what the denominator holds rather than about the
    // refusal that a single measured part would have produced.
    const mixed = build([
      client({ id: 'fell', accountName: 'F1', days: [{ date: june(1), pnl: -400, strategies: [strategy('B2X', '2.5')] }] }),
      client({ id: 'fell2', accountName: 'F2', days: [{ date: june(1), pnl: -300, strategies: [strategy('SYFY', '1.0')] }] }),
      client({ id: 'unsplit', accountName: 'U1', days: [{
        date: june(1),
        pnl: -1000,
        strategies: [strategy('G4M', '1.2', { realized: -100 }), strategy('URGO', '4.5', { realized: -100 })],
      }] }),
    ]);
    const composite = buildAlgorithmComposite(mixed, ['B2X', 'SYFY', 'G4M']);
    expect(composite.parts.map((p) => p.key)).toEqual(['SYFY', 'B2X']);
    expect(composite.unmeasuredKeys).toEqual(['G4M']);
    // -$700 and not -$700 plus a zero for the row nothing measured.
    expect(composite.sumOfPartDips).toBeCloseTo(-700, 2);
    expect(composite.reduction).toBeCloseTo(0, 6);
    expect(composite.reductionRefusal).toBeNull();
  });
});

describe('one door to the identity rule', () => {
  const day = {
    date: june(1),
    pnl: 300,
    strategies: [
      strategy('IFSP', '1.1', { realized: 100 }),
      strategy('IFSP_PF', '1.1', { realized: 100 }),
      strategy('OGX', '2.4', { realized: 100 }),
    ],
  };

  it('resolves the day through the same call the combo table beside it uses', () => {
    // comboPerformance.js states that `dayAlgoRows(...).map(e => e.key)` equals
    // `comboKeyFromDay(...).elements` and that this file pins it. It does now.
    const built = client({ days: [day] });
    const [dailyImport] = built.dailyImports;
    const [snapshot] = dailyImport.snapshots;
    const executions = executionsForAccount(dailyImport, snapshot.accountName);
    const options = { basis: 'traded', level: 'family' };

    expect(dayAlgoRows(snapshot, executions, options).map((entry) => entry.key))
      .toEqual(comboKeyFromDay(snapshot, executions, options).elements);
  });

  it('keeps IFSP_PF a different algorithm from IFSP', () => {
    // Keying rows off `strategyFamily || strategyName`, which two screens in
    // this codebase still do, folds these two into one row. The stored book has
    // both, and OGX against OGX_PF as well.
    const result = build([client({ days: [day] })]);
    expect(result.rows.map((r) => r.key).sort()).toEqual(['IFSP', 'IFSP_PF', 'OGX']);
    expect(row(result, 'IFSP').totalPnl).toBeCloseTo(100, 2);
    expect(row(result, 'IFSP_PF').totalPnl).toBeCloseTo(100, 2);
  });
});
