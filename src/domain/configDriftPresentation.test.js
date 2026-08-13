import { describe, expect, it } from 'vitest';
import {
  buildDriftView,
  buildNoteFor,
  countAccounts,
  describeChangeRow,
  describeParameter,
  formatClockValue,
  formatParameterValue,
  headlineFor,
  recurringChangeOf,
  rollUpAccounts,
  totalsOf,
} from './configDriftPresentation';

// Values below are copied out of public/local-snapshot.json, not invented. The
// panel was wrong for a week while its tests passed, so anything asserted here
// is a string that a real strategy_snapshots row actually carries.

describe('formatClockValue', () => {
  it('strips the sentinel date every timestamp on the book carries', () => {
    // All 86 timestamp values the panel printed had the date 1/1/2020. It is a
    // NinjaTrader TimeSpan-as-DateTime placeholder, so 13 of the 63 characters
    // in the widest chip were a date that never varies.
    expect(formatClockValue('1/1/2020 4:45:00 PM')).toBe('16:45');
    expect(formatClockValue('1/1/2020 4:30:00 PM')).toBe('16:30');
    expect(formatClockValue('1/1/2020 3:45:00 PM')).toBe('15:45');
    expect(formatClockValue('1/1/2020 4:50:00 PM')).toBe('16:50');
    expect(formatClockValue('1/1/2020 9:35:00 AM')).toBe('09:35');
    expect(formatClockValue('1/1/2020 12:00:00 PM')).toBe('12:00');
    expect(formatClockValue('1/1/2020 8:00:00 AM')).toBe('08:00');
  });

  it('keeps seconds when they are not zero', () => {
    expect(formatClockValue('1/1/2020 4:45:30 PM')).toBe('16:45:30');
  });

  it('declines any value that is not the sentinel, rather than guessing', () => {
    // A real date is content. Stripping it would delete the only information in
    // the value; returning null lets the caller print the string untouched.
    expect(formatClockValue('7/30/2026 4:45:00 PM')).toBeNull();
    expect(formatClockValue('1/1/2021 4:45:00 PM')).toBeNull();
    expect(formatClockValue('1/1/2020 13:00:00 PM')).toBeNull();
    expect(formatClockValue('300')).toBeNull();
    expect(formatClockValue('True')).toBeNull();
    expect(formatClockValue(null)).toBeNull();
    expect(formatClockValue('')).toBeNull();
  });
});

describe('describeParameter', () => {
  it('names the parameters that occur on the book', () => {
    expect(describeParameter('StopLossTicks').label).toBe('Stop loss');
    expect(describeParameter('CloseAllOpenTradeTime').label).toBe('Close all open trades');
    expect(describeParameter('BreakEvenIsOn').label).toBe('Break-even');
    expect(describeParameter('MondayFilter').label).toBe('Monday filter');
    expect(describeParameter('ProfitTargetTicks3').label).toBe('Profit target 3');
  });

  it('falls through to the raw name rather than guessing at one', () => {
    // URGO2 and URGO4 are the strategy name plus a digit and mean nothing to a
    // reader. EdgeLeverage is opaque and its risk direction is unknowable from
    // this data. All three stay raw and are flagged unmapped so the UI can show
    // them as system names.
    for (const name of ['URGO2', 'URGO4', 'EdgeLeverage']) {
      const meta = describeParameter(name);
      expect(meta.label).toBe(name);
      expect(meta.mapped).toBe(false);
    }
    expect(describeParameter('SomeParameterAddedNextYear').label)
      .toBe('SomeParameterAddedNextYear');
  });

  it('claims only the unit the raw name states', () => {
    // BreakEvenOffset and TrailFrequency are plausibly ticks and neither name
    // says so, which is exactly why neither gets the word.
    expect(describeParameter('StopLossTicks').unit).toBe('ticks');
    expect(describeParameter('EntryOrderTickOffset').unit).toBe('ticks');
    expect(describeParameter('ReEntryWaitBars').unit).toBe('bars');
    expect(describeParameter('BreakEvenOffset').unit).toBeNull();
    expect(describeParameter('TrailFrequency').unit).toBeNull();
    expect(describeParameter('MaxDailyEntries').unit).toBeNull();
  });

  it('ranks every unmapped name last so one can never lead a summary', () => {
    expect(describeParameter('URGO2').rank)
      .toBeGreaterThan(describeParameter('SundayFilter').rank);
  });
});

describe('formatParameterValue', () => {
  it('reads True/False as on/off only for a parameter known to be a toggle', () => {
    expect(formatParameterValue('BreakEvenIsOn', 'False')).toBe('off');
    expect(formatParameterValue('LimitDailyEntries', 'True')).toBe('on');
    expect(formatParameterValue('MondayFilter', 'True')).toBe('on');
    // Unmapped: nothing establishes that this False is a toggle, so it is left
    // exactly as the strategy wrote it.
    expect(formatParameterValue('EdgeLeverage', 'False')).toBe('False');
  });

  it('formats a clock from the value shape, not the parameter name', () => {
    // The value proves what it is; no one has to know what the name means.
    expect(formatParameterValue('CloseAllOpenTradeTime', '1/1/2020 4:45:00 PM')).toBe('16:45');
    expect(formatParameterValue('WhateverNewTimeParam', '1/1/2020 9:30:00 AM')).toBe('09:30');
  });

  it('leaves numbers alone and passes a missing side through as null', () => {
    expect(formatParameterValue('StopLossTicks', '300')).toBe('300');
    expect(formatParameterValue('ProfitTargetTicks1', '43')).toBe('43');
    expect(formatParameterValue('Martingale', null)).toBeNull();
  });
});

describe('describeChangeRow', () => {
  it('names the two sides instead of leaving them to an arrow', () => {
    const row = describeChangeRow({
      name: 'CloseAllOpenTradeTime',
      from: '1/1/2020 4:45:00 PM',
      to: '1/1/2020 4:30:00 PM',
    });
    expect(row.cohort).toBe('16:45');
    expect(row.here).toBe('16:30');
    expect(row.absentHere).toBe(false);
    expect(row.absentInCohort).toBe(false);
  });

  it('marks a missing cohort side rather than rendering it as blank', () => {
    // describeConfigDifference sets from: null when the majority has no such
    // parameter, and JSX renders null as nothing — the old panel painted
    // `Martingale  → False` with an empty left side, indistinguishable from a
    // value it failed to read. Three of these exist on the book, all IFSP-PF.
    const row = describeChangeRow({ name: 'MartingaleMultiplier', from: null, to: '2' });
    expect(row.absentInCohort).toBe(true);
    expect(row.cohort).toBeNull();
    expect(row.here).toBe('2');
  });

  it('marks a parameter the outlier build does not carry', () => {
    const row = describeChangeRow({ name: 'FridayFilter', from: 'True', to: null });
    expect(row.absentHere).toBe(true);
    expect(row.cohort).toBe('on');
  });
});

describe('headlineFor', () => {
  const IFSP_NG_AUG26_TIGHT_STOP = [
    // Harper Juniper + Reese Knoll, 19 changes. Alphabetical order put
    // BreakEvenAfterTicks first and buried the stop behind "+16 more".
    { name: 'BreakEvenAfterTicks', from: '45', to: '36' },
    { name: 'BreakEvenOffset', from: '5', to: '3' },
    { name: 'CloseAllOpenTradeTime', from: '1/1/2020 4:50:00 PM', to: '1/1/2020 4:30:00 PM' },
    { name: 'StopLossTicks', from: '33', to: '25' },
    { name: 'ProfitTargetTicks1', from: '43', to: '35' },
    { name: 'FridayFilter', from: 'True', to: null },
  ];

  it('leads with the stop, which alphabetical order hid on all 8 of them', () => {
    expect(headlineFor(IFSP_NG_AUG26_TIGHT_STOP, 2))
      .toBe('Stop loss: 25 ticks on these 2 accounts, 33 in the cohort.');
  });

  it('says which side is which for a single account too', () => {
    expect(headlineFor([{ name: 'StopLossTicks', from: '100', to: '115' }], 1))
      .toBe('Stop loss: 115 ticks on this account, 100 in the cohort.');
  });

  it('states a clock difference in both directions without an arrow', () => {
    // The same parameter runs both ways inside one screenful: URGO's group
    // closes earlier than its cohort, ARPD's closes later. Neither sentence
    // depends on the reader knowing which side of an arrow is which.
    const urgo = [{ name: 'CloseAllOpenTradeTime', from: '1/1/2020 4:45:00 PM', to: '1/1/2020 4:30:00 PM' }];
    const arpd = [{ name: 'CloseAllOpenTradeTime', from: '1/1/2020 3:45:00 PM', to: '1/1/2020 4:30:00 PM' }];
    expect(headlineFor(urgo, 9))
      .toBe('Close all open trades: 16:30 on these 9 accounts, 16:45 in the cohort.');
    expect(headlineFor(arpd, 2))
      .toBe('Close all open trades: 16:30 on these 2 accounts, 15:45 in the cohort.');
  });

  it('collapses the seven weekday filters into the one fact they are', () => {
    // IFSP NG AUG26, 6 accounts, whose entire diff is this. The old panel spent
    // its three visible slots on FridayFilter, MondayFilter and SaturdayFilter
    // and said nothing.
    const changes = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      .map((day) => ({ name: `${day}Filter`, from: 'True', to: null }));
    expect(headlineFor(changes, 6))
      .toBe("This build has no day-of-week filters; the cohort's build has 7.");
  });

  it('describes a dropped block as a build difference, never as a deletion', () => {
    // Indigo Glen on URGO MNQ SEP26.
    const changes = [
      { name: 'EdgeLeverage', from: 'False', to: null },
      { name: 'LimitDailyEntries', from: 'True', to: null },
      { name: 'MaxDailyEntries', from: '1', to: null },
    ];
    const headline = headlineFor(changes, 1);
    expect(headline).toContain('does not carry 3 settings');
    expect(headline).not.toContain('absent');
    expect(headline).not.toContain('removed');
  });

  it('never hands a CAM a sentence built out of an unnamed parameter', () => {
    // URGO2 and URGO4 carry no information. Rule of this codebase: decline
    // rather than invent precision.
    const headline = headlineFor([
      { name: 'URGO2', from: '2', to: '4' },
      { name: 'URGO4', from: '3', to: '2' },
    ], 1);
    expect(headline).not.toContain('URGO2');
    expect(headline).toContain('2 settings differ from the cohort');
    expect(headline).toContain('none of them a named risk control');
  });

  it('declines when the configurations could not be compared', () => {
    expect(headlineFor([], 1)).toContain('could not be compared');
  });
});

describe('buildNoteFor', () => {
  it('surfaces the martingale build that ranking cannot reach', () => {
    // Noel Dune, IFSP-PF NG SEP26. Its top-ranked value change is a stop of 33
    // against 30 — the least interesting of its 22 differences — while the fact
    // worth reading is that the build has martingale fields the cohort's has
    // none of. Both must appear, so this is a second line, not a contest.
    const note = buildNoteFor([
      { name: 'StopLossTicks', from: '30', to: '33' },
      { name: 'Martingale', from: null, to: 'False' },
      { name: 'MartingaleMultiplier', from: null, to: '2' },
      { name: 'MaxMartingales', from: null, to: '5' },
    ]);
    expect(note).toContain('Different build');
    expect(note).toContain('Martingale multiplier');
    expect(note).toContain('Max martingales');
  });

  it('says nothing when the headline already said it', () => {
    // A group whose only differences are presence differences gets the build
    // statement as its headline; repeating it here would be noise.
    expect(buildNoteFor([{ name: 'FridayFilter', from: 'True', to: null }])).toBeNull();
    expect(buildNoteFor([{ name: 'StopLossTicks', from: '33', to: '25' }])).toBeNull();
    expect(buildNoteFor([])).toBeNull();
  });
});

describe('rollUpAccounts', () => {
  it('lists one client once, with its account numbers', () => {
    // Avery Frost owns all five accounts in one IFSP NG SEP26 group. The old
    // line repeated the client name for each and then truncated at four.
    const rolled = rollUpAccounts([
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'GCAGFHHCDJGHACC87597' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'GEEDGECE834817265192' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'CCBBFKGGC099921210' },
    ]);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].clientName).toBe('Avery Frost');
    expect(rolled[0].accounts).toHaveLength(3);
  });

  it('collapses the same account listed twice inside one group', () => {
    // Two strategy_snapshots rows, same account, same instrument, byte-identical
    // parameters_raw. It rendered as `Avery Frost · BDG9159854231060 — Avery
    // Frost · BDG9159854231060`, which reads as two accounts to go and check.
    const rolled = rollUpAccounts([
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'BDG9159854231060' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'BDG9159854231060' },
    ]);
    expect(rolled[0].accounts).toEqual(['BDG9159854231060']);
    expect(rolled[0].rows).toBe(2);
  });

  it('counts unidentifiable rows instead of merging or inventing them', () => {
    // Devon North's strategies carry trading_account_id = null, so both rows
    // painted as a bare client name — two identical, unactionable entries. Two
    // rows that cannot be resolved are not one account.
    const rolled = rollUpAccounts([
      { clientId: 'c2', clientName: 'Devon North', accountName: '' },
      { clientId: 'c2', clientName: 'Devon North', accountName: '' },
    ]);
    expect(rolled[0].unnamedRows).toBe(2);
    expect(rolled[0].accounts).toEqual([]);
  });

  it('puts the client with the most rows first', () => {
    const rolled = rollUpAccounts([
      { clientId: 'c1', clientName: 'Brook Frost', accountName: '3726888' },
      { clientId: 'c2', clientName: 'Harper Juniper', accountName: 'CHFFEK662499200806' },
      { clientId: 'c2', clientName: 'Harper Juniper', accountName: 'JFC111771' },
    ]);
    expect(rolled.map((client) => client.clientName)).toEqual(['Harper Juniper', 'Brook Frost']);
  });
});

describe('countAccounts', () => {
  it('does not head a group "5 accounts" above a list of four', () => {
    // Avery Frost on IFSP NG SEP26: outlier.count is 5 because
    // BDG9159854231060 has two strategy_snapshots rows with byte-identical
    // parameters_raw. The account list under it can only ever show 4.
    const tally = countAccounts([
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'GCAGFHHCDJGHACC87597' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'BDG9159854231060' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'BDG9159854231060' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'GEEDGECE834817265192' },
      { clientId: 'c1', clientName: 'Avery Frost', accountName: 'CCBBFKGGC099921210' },
    ]);
    expect(tally.rows).toBe(5);
    expect(tally.accounts).toBe(4);
    expect(tally.total).toBe(4);
  });

  it('counts an unidentifiable row as its own thing to go and look at', () => {
    // Devon North's two rows carry trading_account_id = null. They are not one
    // account, and asserting they are two would be inventing precision.
    const tally = countAccounts([
      { clientId: 'c2', clientName: 'Devon North', accountName: '' },
      { clientId: 'c2', clientName: 'Devon North', accountName: '' },
      { clientId: 'c3', clientName: 'Sage North', accountName: '1973572' },
    ]);
    expect(tally.accounts).toBe(1);
    expect(tally.unnamedRows).toBe(2);
    expect(tally.total).toBe(3);
  });

  it('keeps two clients with the same account number apart', () => {
    const tally = countAccounts([
      { clientId: 'c1', clientName: 'Kai Moss', accountName: '1121557' },
      { clientId: 'c2', clientName: 'Devon Glen', accountName: '1121557' },
    ]);
    expect(tally.accounts).toBe(2);
  });
});

describe('totalsOf', () => {
  it('counts strategy rows and accounts as two different things', () => {
    // The old headline called 72 strategy rows "72 accounts". They are 42
    // distinct client-and-account pairs on the real book, because 21 accounts
    // appear in more than one algorithm row and Harper Juniper appears in 7 of
    // the 10 — a two-thirds overstatement of the only number on the panel.
    const rows = [
      {
        outliers: [{
          accounts: [
            { clientId: 'c1', clientName: 'Kai Moss', accountName: '1121557' },
            { clientId: 'c2', clientName: 'Devon North', accountName: '' },
          ],
        }],
      },
      {
        outliers: [{
          accounts: [
            { clientId: 'c1', clientName: 'Kai Moss', accountName: '1121557' },
          ],
        }],
      },
    ];
    const totals = totalsOf(rows);
    expect(totals.strategyRows).toBe(3);
    expect(totals.accounts).toBe(1);
    expect(totals.unnamedRows).toBe(1);
    expect(totals.clients).toBe(2);
    expect(totals.algorithms).toBe(2);
  });
});

describe('buildDriftView', () => {
  const change = (name, from, to) => ({ name, from, to });
  const holders = (n, prefix) => Array.from({ length: n }, (_, index) => ({
    clientId: `${prefix}${index}`, clientName: `Client ${prefix}${index}`, accountName: `ACC${prefix}${index}`,
  }));
  const row = (family, instrument, outliers) => ({
    family,
    instrument,
    cohort: 40,
    dominant: { label: 'PT 43/53/73 · SL 33', count: 30, share: 75 },
    versions: 1,
    outlierAccounts: outliers.reduce((sum, outlier) => sum + outlier.count, 0),
    outliers,
  });

  it('gives colliding labels distinct keys', () => {
    // key={outlier.label} collided on 6 of the 8 visible rows: URGO MNQ SEP26
    // had 5 groups and 3 distinct labels. Two configurations sharing a
    // PT/SL label is the exact failure describeConfigDifference exists to fix.
    const view = buildDriftView([row('IFSP', 'NG AUG26', [
      { label: 'PT 43/53/73 · SL 33', count: 6, changes: [change('MaxDailyEntries', '3', '2')], accounts: holders(6, 'a') },
      { label: 'PT 43/53/73 · SL 33', count: 4, changes: [change('MaxDailyEntries', '3', '1')], accounts: holders(4, 'b') },
    ])]);
    const keys = view.rows[0].groups.map((group) => group.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('flags a group whose label matches the cohort so the row is not read as a duplicate', () => {
    const view = buildDriftView([row('IFSP', 'NG AUG26', [
      { label: 'PT 43/53/73 · SL 33', count: 6, changes: [change('MaxDailyEntries', '3', '2')], accounts: holders(6, 'a') },
      { label: 'PT 35/45/65 · SL 25', count: 2, changes: [change('StopLossTicks', '33', '25')], accounts: holders(2, 'b') },
    ])]);
    const byLabel = Object.fromEntries(view.rows[0].groups.map((g) => [g.label, g.sameLabelAsCohort]));
    expect(byLabel['PT 43/53/73 · SL 33']).toBe(true);
    expect(byLabel['PT 35/45/65 · SL 25']).toBe(false);
  });

  it('orders groups by what costs money, not by how many accounts hold it', () => {
    // The domain sorts outliers by account count, which put URGO's 9-account
    // 15-minute close-time difference above its 1-account 9-parameter one.
    const view = buildDriftView([row('URGO', 'MNQ SEP26', [
      {
        label: 'PT 400/450/500 · SL 300',
        count: 9,
        changes: [change('CloseAllOpenTradeTime', '1/1/2020 4:45:00 PM', '1/1/2020 4:30:00 PM')],
        accounts: holders(9, 'a'),
      },
      {
        label: 'PT 415/425/500 · SL 315',
        count: 1,
        changes: [change('StopLossTicks', '300', '315')],
        accounts: holders(1, 'b'),
      },
    ])]);
    expect(view.rows[0].groups.map((group) => group.count)).toEqual([1, 9]);
  });

  it('keeps the rows past the limit instead of dropping them', () => {
    // limit 8 hid IFSP-PF NG SEP26 — 1 account, 22 changes, a build carrying
    // martingale settings — behind a dead "2 more not shown." The largest
    // configuration distance on the book was the row the panel discarded.
    const rows = Array.from({ length: 10 }, (_, index) => row(`F${index}`, 'NG AUG26', [
      { label: 'PT 1/2/3 · SL 4', count: 1, changes: [change('StopLossTicks', '33', '25')], accounts: holders(1, `r${index}`) },
    ]));
    const view = buildDriftView(rows, { limit: 8 });
    expect(view.rows).toHaveLength(8);
    expect(view.rest).toHaveLength(2);
    expect(view.rest[0].groups[0].changes).toHaveLength(1);
  });
});

describe('recurringChangeOf', () => {
  const groupWithClose = (count, cohortTime) => ({
    count,
    changes: [describeChangeRow({
      name: 'CloseAllOpenTradeTime',
      from: cohortTime,
      to: '1/1/2020 4:30:00 PM',
    })],
  });

  it('states the fact once that the panel was repeating fourteen times', () => {
    const view = [
      { key: 'URGO|MNQ SEP26', groups: [groupWithClose(9, '1/1/2020 4:45:00 PM')] },
      { key: 'OGX|MNQ SEP26', groups: [groupWithClose(5, '1/1/2020 4:50:00 PM')] },
      { key: 'ARPD|MGC DEC26', groups: [groupWithClose(2, '1/1/2020 3:45:00 PM')] },
    ];
    const recurring = recurringChangeOf(view);
    expect(recurring.label).toBe('Close all open trades');
    expect(recurring.value).toBe('16:30');
    expect(recurring.groups).toBe(3);
    expect(recurring.accounts).toBe(16);
    expect(recurring.algorithms).toBe(3);
    // The cohort side takes three values, so there is no single "the cohort
    // runs X" to state. Reporting the set is the only honest form.
    expect(recurring.cohortValues).toEqual(['15:45', '16:45', '16:50']);
  });

  it('declines a pattern too thin to be one', () => {
    // Rule of this codebase: a cohort too small to support a claim gets null,
    // not a number. Two groups out of twenty is a coincidence.
    const filler = Array.from({ length: 18 }, (_, index) => ({
      key: `F${index}|NG`,
      groups: [{ count: 1, changes: [describeChangeRow({ name: 'StopLossTicks', from: `${index}`, to: `${index + 1}` })] }],
    }));
    const view = [
      { key: 'URGO|MNQ SEP26', groups: [groupWithClose(9, '1/1/2020 4:45:00 PM')] },
      { key: 'OGX|MNQ SEP26', groups: [groupWithClose(5, '1/1/2020 4:50:00 PM')] },
      ...filler,
    ];
    expect(recurringChangeOf(view)).toBeNull();
    expect(recurringChangeOf([])).toBeNull();
  });

  it('ignores presence differences, which have no value to agree on', () => {
    const view = Array.from({ length: 4 }, (_, index) => ({
      key: `F${index}|NG`,
      groups: [{ count: 2, changes: [describeChangeRow({ name: 'FridayFilter', from: 'True', to: null })] }],
    }));
    expect(recurringChangeOf(view)).toBeNull();
  });
});
