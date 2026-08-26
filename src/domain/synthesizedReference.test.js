import { describe, expect, it } from 'vitest';
import { BASIS, REFERENCE, buildSynthesizedReference } from './synthesizedReference';
import { MATCH, buildSetFileMatch } from './setFileMatch';

/**
 * `ZZZ` is a family the set-file library has no folder for, which is the only
 * way into this module. Same parameter shape as the real G4M export, timestamp
 * included: `1/1/2020 4:45:00 PM` is the value that has broken a '/' split in
 * this codebase three times, so every fixture here carries one.
 */
const params = ({
  pt = '80/120/160',
  sl = '80',
  size = '2/1/1',
  close = '4:45:00 PM',
  edge = 'False',
} = {}) => {
  const [pt1, pt2, pt3] = pt.split('/');
  const [s1, s2, s3] = size.split('/');
  return `False/41/1/1/2020 ${close}/${edge}/V-8F5D54-C32866C2-3DB348W/${s1}/${s2}/${s3}/`
    + `${pt1}/${pt2}/${pt3}/${sl}/True `
    + '(Backtest/BreakEvenAfterTicks/CloseAllOpenTradeTime/EdgeLeverage/LicenseKey/'
    + 'PosSize1/PosSize2/PosSize3/ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/'
    + 'StopLossTicks/TrailIsOn)';
};

const row = (accountName, opts) => ({
  strategyFamily: 'ZZZ',
  strategyName: '0 - ZZZ-1.0',
  instrument: 'MES SEP26',
  accountName,
  parametersRaw: opts === null ? '' : params(opts),
});

/** One account per client, so rows, accounts and clients are all the same count. */
const book = (rows) => rows.map((entry, index) => ({
  id: `c${index}`,
  name: `Client ${index}`,
  dailyImports: [{ date: '2026-08-03', strategies: [entry] }],
}));

const many = (count, opts) => Array.from({ length: count }, (unused, index) => row(`A${index}`, opts));

const only = (result) => {
  expect(result.cohorts).toHaveLength(1);
  return result.cohorts[0];
};

describe('what gets a reference at all', () => {
  it('refuses one for a cohort with no majority, and says so instead of saying nothing', () => {
    // 12 rows across 5 configurations, largest 4 — a 33% plurality. Reporting
    // the 4 as a reference would list the other 8 as departures from something
    // two thirds of the cohort does not run. This is the shape Bullet Bot's NQ
    // cohort has on the real book (134 rows, 16 configurations, largest 50).
    const cohort = only(buildSynthesizedReference(book([
      ...many(4, { close: '4:45:00 PM' }),
      ...many(3, { close: '4:30:00 PM' }),
      ...many(2, { close: '4:15:00 PM' }),
      ...many(2, { close: '3:45:00 PM' }),
      ...many(1, { close: '3:30:00 PM' }),
    ])));

    expect(cohort.status).toBe(REFERENCE.NO_MAJORITY);
    expect(cohort.reference).toBeNull();
    // The cohort is still reported, with the numbers that disqualified it.
    expect(cohort.rows).toBe(12);
    expect(cohort.distinctConfigurations).toBe(5);
    expect(cohort.largest).toEqual({ label: 'PT 80/120/160 · SL 80', rows: 4, share: 33 });
    // And nobody is listed against a norm that was never established.
    expect(cohort.outliers).toEqual([]);
    expect(cohort.variants).toEqual([]);
  });

  it('refuses one for a cohort too small for a majority to mean anything', () => {
    const cohort = only(buildSynthesizedReference(book([
      ...many(4, { close: '4:45:00 PM' }),
      ...many(1, { close: '4:30:00 PM' }),
    ])));

    expect(cohort.status).toBe(REFERENCE.COHORT_TOO_SMALL);
    expect(cohort.reference).toBeNull();
    expect(cohort.outliers).toEqual([]);
    // 4 of 5 is 80% and still not a norm. The share is reported, as the reason
    // it was rejected, never as a finding.
    expect(cohort.largest.share).toBe(80);
  });

  it('counts the cohorts it could NOT judge, and never reports that as zero', () => {
    // The number a panel is tempted to drop. `withReference` alone reads as the
    // whole section, and a cohort nobody could establish a norm for then becomes
    // indistinguishable from a cohort with nothing to report — which is the same
    // fabrication as "0 fields compared" printed for a measurement that never
    // ran. Two cohorts here: MES has a clean majority, MNQ is 12 rows across 5
    // configurations whose largest is 4.
    const spread = ['4:45:00 PM', '4:30:00 PM', '4:15:00 PM', '3:45:00 PM', '3:30:00 PM'];
    const fragmented = Array.from({ length: 12 }, (unused, index) => ({
      ...row(`F${index}`, { close: spread[index % spread.length] }),
      instrument: 'MNQ SEP26',
    }));
    const result = buildSynthesizedReference(book([...many(10), ...fragmented]));

    expect(result.totals).toMatchObject({
      cohorts: 2, withReference: 1, withoutReference: 1, rows: 22,
    });
    expect(result.cohorts.map((cohort) => cohort.status))
      .toEqual([REFERENCE.NO_MAJORITY, REFERENCE.OBSERVED]);
    // And the verify count covers only the cohort that produced a reference, so
    // it can never be read as a verdict on the one that did not.
    expect(result.totals.toVerifyRows).toBe(0);
    expect(result.totals.toVerifyAccounts).toBe(0);
  });

  it('separates "no majority" from "too small" from "nothing readable"', () => {
    const readable = only(buildSynthesizedReference(book(many(3))));
    const unreadable = only(buildSynthesizedReference(book([row('A0', null), row('A1', null)])));

    expect(readable.status).toBe(REFERENCE.COHORT_TOO_SMALL);
    expect(unreadable.status).toBe(REFERENCE.NOTHING_READABLE);
    // Three different reasons, three different sentences downstream. A bare
    // `continue` renders all three, and "no cohort at all", identically.
    expect(new Set([readable.reason, unreadable.reason]).size).toBe(2);
  });

  it('leaves a cohort alone the moment the library can answer ANY of its rows', () => {
    // "Every row of the cohort, or none of it." A cohort the library answers in
    // part has catalogued evidence available, and the catalogued answer is the
    // stronger one — a weaker second opinion printed beside it is the panel
    // disagreeing with itself.
    //
    // The mix is built the only way the book can produce one: same family, same
    // instrument GROUP, different instrument ROOT. `MES SEP26` resolves to the
    // catalogued root MES and matches SYFY's files; `MES.SEP26` resolves to no
    // root at all (catalogInstrumentOf requires a space, a dash or a digit after
    // the root, and `.` is none of them) and comes back NOT MEASURED with
    // `instrument-not-in-library`. Both group under the leading symbol MES, so
    // they are one cohort with 8 measured rows and 4 unmeasured ones.
    //
    // 0 mixed cohorts on today's book, so nothing real would reveal a gate that
    // only asked whether SOME row was unmeasured.
    const syfy = (index, instrument) => ({
      id: `s${index}`,
      name: `Client ${index}`,
      dailyImports: [{
        date: '2026-08-03',
        strategies: [{
          strategyFamily: 'SYFY',
          strategyName: '0 - SYFY-1.0',
          instrument,
          accountName: `S${index}`,
          parametersRaw: params(),
        }],
      }],
    });
    const mixed = [
      ...Array.from({ length: 8 }, (unused, index) => syfy(index, 'MES SEP26')),
      ...Array.from({ length: 4 }, (unused, index) => syfy(100 + index, 'MES.SEP26')),
    ];

    expect(buildSynthesizedReference(mixed).cohorts).toEqual([]);
    // And the 4 unmeasurable rows really are unmeasurable, so this stays a test
    // about the gate rather than about an empty book.
    const rows = buildSetFileMatch(mixed, {}).rows;
    expect(rows.filter((row) => row.classification === MATCH.NOT_MEASURED)).toHaveLength(4);
    expect(rows.filter((row) => row.classification !== MATCH.NOT_MEASURED)).toHaveLength(8);
  });

  it('leaves families the library DOES hold alone', () => {
    // Nothing here may second-guess a catalogued answer. A weaker reference
    // beside a stronger one is a panel disagreeing with itself.
    const result = buildSynthesizedReference(book(many(20)).concat(book(many(20)).map((client) => ({
      ...client,
      id: `${client.id}u`,
      dailyImports: [{
        date: '2026-08-03',
        strategies: [{
          strategyFamily: 'URGO', strategyName: '0 - URGO-4.5', instrument: 'MNQ SEP26',
          accountName: 'U1', parametersRaw: params(),
        }],
      }],
    }))));

    expect(result.cohorts.map((cohort) => cohort.family)).toEqual(['ZZZ']);
  });
});

describe('the reference itself', () => {
  const result = buildSynthesizedReference(book([
    ...many(20, { close: '4:45:00 PM' }),
    ...many(6, { close: '4:30:00 PM' }),
    ...many(2, { edge: 'True' }),
  ]));
  const cohort = only(result);

  it('states the evidence it rests on, not just the answer', () => {
    expect(cohort.status).toBe(REFERENCE.OBSERVED);
    expect(cohort.rows).toBe(28);
    expect(cohort.distinctConfigurations).toBe(3);
    expect(cohort.reference.rows).toBe(20);
    expect(cohort.reference.share).toBe(71);
    expect(cohort.reference.tally).toMatchObject({ accounts: 20, unnamedRows: 0 });
  });

  it('is labelled observed on the cohort, the reference and every group', () => {
    // The one thing that must survive every refactor of this file. A CAM has to
    // be able to tell a set-file answer from a derived one at the row they
    // landed on, not from a caveat three sections up.
    expect(cohort.basis).toBe(BASIS);
    expect(cohort.reference.basis).toBe(BASIS);
    for (const group of [...cohort.variants, ...cohort.outliers]) expect(group.basis).toBe(BASIS);
    // And it never carries the library's vocabulary.
    expect(JSON.stringify(cohort)).not.toMatch(/\.xml|Risk|configHash/);
  });

  it('carries the configuration itself, not only a label for it', () => {
    // buildConfigDrift computes the dominant configuration and throws the map
    // away, reporting `{label, count, share}`. A reference nobody can read the
    // parameters of is not a reference.
    expect(cohort.reference.parameters).toMatchObject({
      ProfitTargetTicks1: '80', StopLossTicks: '80',
      CloseAllOpenTradeTime: '2020-01-01T16:45:00',
      EdgeLeverage: 'false',
    });
  });

  it('states values in the set files\' dialect, so both sides of the panel read alike', () => {
    // The export writes `1/1/2020 4:45:00 PM` and `False`; the library writes
    // `2020-01-01T16:45:00` and `false`. Two dialects on one screen look like a
    // difference. 37 of 113 unmatched values across the real book were this.
    expect(cohort.reference.parameters.CloseAllOpenTradeTime).toBe('2020-01-01T16:45:00');
    expect(cohort.reference.parameters.Backtest).toBe('false');
  });

  it('holds position sizing out and names what it held out', () => {
    // Sizing is the risk level and the desk sets it per client, so a reference
    // including it would report a deliberate choice as a departure.
    expect(cohort.reference.parameters.PosSize1).toBeUndefined();
    expect(cohort.reference.excluded.sizing).toEqual(['PosSize1', 'PosSize2', 'PosSize3']);
    expect(cohort.reference.excluded.perClient).toContain('LicenseKey');
  });

  it('reports which fields the whole cohort agrees on and which it does not', () => {
    expect(cohort.reference.unanimousFields).toContain('StopLossTicks');
    expect(cohort.reference.varyingFields.map((field) => field.name))
      .toEqual(['CloseAllOpenTradeTime', 'EdgeLeverage']);
    expect(cohort.reference.varyingFields[0].values).toEqual([
      { value: '2020-01-01T16:45:00', rows: 22 },
      { value: '2020-01-01T16:30:00', rows: 6 },
    ]);
  });

  it('says whether the cohort agrees on the fields the desk uses to identify a version', () => {
    expect(cohort.reference.identity.unanimous).toBe(true);
    expect(cohort.reference.identity.values).toEqual({
      ProfitTargetTicks1: '80',
      ProfitTargetTicks2: '120',
      ProfitTargetTicks3: '160',
      StopLossTicks: '80',
    });
  });

  it('answers null, never true, when the export carries no version-identity field', () => {
    const thin = only(buildSynthesizedReference(book(Array.from({ length: 10 }, (unused, index) => ({
      strategyFamily: 'ZZZ', strategyName: '0 - ZZZ-1.0', instrument: 'MES SEP26',
      accountName: `A${index}`,
      parametersRaw: 'False/41 (Backtest/BreakEvenAfterTicks)',
    })))));

    // "Nothing was compared" and "the cohort agrees" are different claims.
    expect(thin.reference.identity.unanimous).toBeNull();
    expect(thin.reference.identity.values).toBeNull();
  });
});

describe('what a minority configuration is called', () => {
  it('calls a large minority a second configuration, not a departure', () => {
    // 6 of 28 is 21%, above the 15% floor. On the real book this is G4M's 11
    // accounts closing at 16:30 — 23% — and `Close all open trades → 16:30` is
    // the most recurring change on the whole book. Listing them as deviations
    // puts one desk decision on a review list eleven times.
    const cohort = only(buildSynthesizedReference(book([
      ...many(20, { close: '4:45:00 PM' }),
      ...many(6, { close: '4:30:00 PM' }),
      ...many(2, { edge: 'True' }),
    ])));

    expect(cohort.variants).toHaveLength(1);
    expect(cohort.variants[0].rows).toBe(6);
    expect(cohort.variants[0].share).toBe(21);
    expect(cohort.outliers).toHaveLength(1);
    expect(cohort.outliers[0].rows).toBe(2);
  });

  it('diffs a minority field by field against the reference', () => {
    const cohort = only(buildSynthesizedReference(book([
      ...many(20),
      ...many(2, { edge: 'True' }),
    ])));

    expect(cohort.outliers[0].changes)
      .toEqual([{ name: 'EdgeLeverage', from: 'false', to: 'true' }]);
  });

  it('does not split a cohort on position sizing alone', () => {
    const cohort = only(buildSynthesizedReference(book([
      ...many(20, { size: '2/1/1' }),
      ...many(4, { size: '3/3/2' }),
    ])));

    expect(cohort.distinctConfigurations).toBe(1);
    expect(cohort.outliers).toEqual([]);
    expect(cohort.variants).toEqual([]);
  });

  it('reports rows and accounts as two numbers when one account exports twice', () => {
    // `Avery Frost · BDG9159854231060` exports twice on this book, two
    // strategy_snapshots rows with byte-identical parameters, and one drift group
    // is 5 rows over 4 accounts because of it. A head printing the row count over
    // chips printing the account count is the stat that read 1900 against a
    // header that read 253, so both are computed and both are named.
    const twice = {
      id: 'dup',
      name: 'Dup Client',
      dailyImports: [{
        date: '2026-08-03',
        strategies: [row('D1', { edge: 'True' }), row('D1', { edge: 'True' })],
      }],
    };
    const result = buildSynthesizedReference([...book(many(20)), twice]);
    const cohort = only(result);

    expect(cohort.outliers[0].rows).toBe(2);
    expect(cohort.outliers[0].tally).toMatchObject({ accounts: 1, rows: 2, total: 1 });
    expect(result.totals.toVerifyRows).toBe(2);
    expect(result.totals.toVerifyAccounts).toBe(1);
  });

  it('reports a unanimous cohort as unanimous rather than as nothing', () => {
    const cohort = only(buildSynthesizedReference(book(many(12))));

    expect(cohort.status).toBe(REFERENCE.OBSERVED);
    expect(cohort.distinctConfigurations).toBe(1);
    expect(cohort.reference.share).toBe(100);
    expect(cohort.outliers).toEqual([]);
  });
});

describe('whether today\'s majority has been the majority all along', () => {
  /**
   * Two imports per client. The first is what every account used to run, the
   * second is what it runs now — so the history a caller reads back is 20 rows
   * over 10 accounts, not 10.
   */
  const withHistory = (before, after) => before.map((entry, index) => ({
    id: `c${index}`,
    name: `Client ${index}`,
    dailyImports: [
      { date: '2026-07-01', strategies: [entry] },
      { date: '2026-08-03', strategies: [after[index]] },
    ],
  }));

  it('says so when the configuration running today is new', () => {
    // Every account moved from 16:45 to 16:30 between the two imports. Today's
    // reference is unanimous and 0 rows of the earlier import carry it — which
    // is the one shape in this object worth interrupting a CAM for, and the one
    // the whole module cannot otherwise detect: a cohort that moved together
    // produces a reference that moved with it.
    const cohort = only(buildSynthesizedReference(withHistory(
      many(10, { close: '4:45:00 PM' }),
      many(10, { close: '4:30:00 PM' }),
    )));

    expect(cohort.reference.share).toBe(100);
    expect(cohort.history).toEqual({
      rows: 20,
      distinctConfigurations: 2,
      // 10, not 20: the reference carries half the history. A fallback to the
      // cohort total here would report a brand-new configuration as settled.
      referenceRows: 10,
      referenceShare: 50,
      // Tie on count, and the earlier configuration was seen first, so the
      // all-time majority is NOT what the cohort runs today.
      referenceIsAllTimeMajority: false,
    });
  });

  it('reports 0 history rows for a configuration that has never been imported before', () => {
    // Nine accounts on one configuration all along, one account that has just
    // switched — and the switch is what became today's cohort majority is not:
    // here the majority is the old one, so the interesting case is the other
    // side. 0 is a determined answer ("this configuration appears in no earlier
    // import"), never a stand-in for the cohort's own size.
    const before = many(10, { close: '4:45:00 PM' });
    const after = many(10, { close: '4:15:00 PM' });
    const cohort = only(buildSynthesizedReference(withHistory(before, after)));

    expect(cohort.history.rows).toBe(20);
    expect(cohort.history.referenceRows).toBe(10);
    expect(cohort.history.referenceShare).toBe(50);
    expect(cohort.history.referenceIsAllTimeMajority).toBe(false);
  });

  it('confirms stability when the majority has held across every import', () => {
    const cohort = only(buildSynthesizedReference(withHistory(
      many(10, { close: '4:45:00 PM' }),
      many(10, { close: '4:45:00 PM' }),
    )));

    expect(cohort.history.referenceRows).toBe(20);
    expect(cohort.history.referenceShare).toBe(100);
    expect(cohort.history.referenceIsAllTimeMajority).toBe(true);
  });
});

describe('a cohort whose builds do not carry the same settings', () => {
  // The reference states the settings the DOMINANT configuration carries; the
  // distribution is over every setting ANY configuration carries. They are 27
  // and 27 on G4M and they are not equal on 7 of the 15 cohorts on this book
  // whose configurations differ at all — DJDR YM SEP26 holds 26 on the dominant
  // and 33 in the union — so the two counts must be separately named or the
  // panel prints one under the other's name.
  const short = () => 'False/1/1/2020 4:45:00 PM/400/300 '
    + '(Backtest/CloseAllOpenTradeTime/ProfitTargetTicks1/StopLossTicks)';
  const long = () => 'False/1/1/2020 4:45:00 PM/400/300/True/2/5 '
    + '(Backtest/CloseAllOpenTradeTime/ProfitTargetTicks1/StopLossTicks/'
    + 'Martingale/MartingaleMultiplier/MaxMartingales)';
  const shaped = (index, raw) => ({
    id: `sh${index}`,
    name: `Shape ${index}`,
    dailyImports: [{
      date: '2026-08-03',
      strategies: [{
        strategyFamily: 'ZZZ',
        strategyName: '0 - ZZZ-1.0',
        instrument: 'MES SEP26',
        accountName: `S${index}`,
        parametersRaw: raw,
      }],
    }],
  });
  const cohort = only(buildSynthesizedReference([
    ...Array.from({ length: 14 }, (unused, index) => shaped(index, short())),
    ...Array.from({ length: 2 }, (unused, index) => shaped(100 + index, long())),
  ]));

  it('counts the reference\'s own settings and the compared settings separately', () => {
    expect(cohort.reference.fieldCount).toBe(4);
    expect(cohort.reference.comparedFieldCount).toBe(7);
  });

  it('makes the unanimous and varying counts add up to the compared total', () => {
    // The sentence a CAM reads is "N of M compared settings are identical and K
    // vary". N + K must be M, and against the reference's own 4 it was not.
    const unanimous = cohort.reference.unanimousFields.length;
    const varying = cohort.reference.varyingFields.length;
    expect(unanimous).toBe(4);
    expect(varying).toBe(3);
    expect(unanimous + varying).toBe(cohort.reference.comparedFieldCount);
  });

  it('records a setting the reference has no field for as null, not as missing', () => {
    // "The reference does not carry this" is a value in the distribution, and it
    // has to be distinguishable from a value of 0 or of ''.
    const martingale = cohort.reference.varyingFields.find((field) => field.name === 'Martingale');
    expect(martingale.values).toEqual([
      { value: null, rows: 14 },
      { value: 'true', rows: 2 },
    ]);
    expect(cohort.reference.parameters.Martingale).toBeUndefined();
  });
});

describe('rows nothing can be said about', () => {
  it('counts an unreadable export instead of shrinking the denominator silently', () => {
    const cohort = only(buildSynthesizedReference(book([
      ...many(9),
      row('A9', null),
    ])));

    expect(cohort.rows).toBe(9);
    expect(cohort.unreadableRows).toBe(1);
    // 9 of 9, and the tenth row is visible as a row nothing was measured on.
    expect(cohort.reference.share).toBe(100);
  });

  it('counts a row with no trading account without folding it into one', () => {
    const cohort = only(buildSynthesizedReference(book([
      ...many(9),
      row('', {}),
    ])));

    expect(cohort.rows).toBe(10);
    expect(cohort.accounts).toBe(9);
    expect(cohort.unnamedRows).toBe(1);
  });
});

