// The same-day desk comparison, over fixtures.
//
// Ungated on purpose. Everything here is a rule — how small a group has to be
// before it cannot have a consensus, what counts as the desk's answer, which
// fields are never compared, and the three ways an account can be off — and a
// rule that only holds on one export is not a rule. The book-backed half, the
// figures that need 58 closes to be sayable at all, lives in
// deskConfigOutliers.book.test.js.

import { describe, expect, it } from 'vitest';
import {
  buildDeskConfigOutliers,
  deskDayImportIds,
  deskConfigDayFor,
  deskInstrumentOf,
  rowParameters,
  MIN_CONSENSUS_ACCOUNTS,
} from './deskConfigOutliers';

const DAY = '2026-09-21';

/** A NinjaTrader parameter string with whatever fields the test names. */
const params = (values) => {
  const names = Object.keys(values);
  return `${names.map((name) => values[name]).join('/')} (${names.join('/')})`;
};

const BASE = {
  Backtest: 'False',
  LicenseKey: 'V-8F5D54-C32866C2-3DB348W',
  StopLossTicks: '300',
  ProfitTargetTicks1: '400',
  MyTradeDirection: 'Both',
  TradeWindowIsOn: 'True',
};

const strategy = (accountName, overrides = {}, extra = {}) => ({
  strategyName: '0 - URGO-4.5',
  strategyFamily: 'URGO',
  strategyVersion: '4.5',
  instrument: 'MNQ SEP26',
  dataSeries: '15 Minute',
  accountName,
  parametersRaw: params({ ...BASE, ...overrides }),
  ...extra,
});

/** One client, one close on `date`, one strategy row per account. */
const client = (id, rows, date = DAY) => ({
  id,
  name: id,
  dailyImports: [{ id: `${id}-close`, uuid: `${id}-uuid`, date, strategies: rows }],
});

/** `count` clients each running one account on the desk's settings. */
const desk = (count, overrides = {}) => Array.from({ length: count }, (_, index) => client(
  `c${index}`,
  [strategy(`A${index}`, overrides)],
));

const groupOf = (result, family = 'URGO') => result.groups.find((group) => group.family === family);
const outlierFor = (group, accountName) => group.outliers
  .find((outlier) => outlier.accountName === accountName) || null;
const differenceFor = (group, accountName, field) => (outlierFor(group, accountName)?.differences || [])
  .find((difference) => difference.name === field) || null;

describe('a consensus needs three accounts', () => {
  it('refuses to rank a group of two and says why', () => {
    // Two accounts on different values are two readings, not a majority and a
    // deviation. Calling either of them the outlier is a coin toss.
    const result = buildDeskConfigOutliers(
      [client('a', [strategy('A0')]), client('b', [strategy('B0', { StopLossTicks: '250' })])],
      { date: DAY },
    );

    const group = groupOf(result);
    expect(group.accounts).toBe(2);
    expect(group.measured).toBe(false);
    expect(group.reason).toBe('too-few-accounts');
    expect(group.outliers).toEqual([]);
    expect(result.basis.compared).toBe(0);
    expect(result.basis.tooSmall).toBe(1);
  });

  it('still lists the group, because unmeasured is not absent', () => {
    // A group that was checked and found uniform, a group of two, and a group
    // that does not exist must not render identically.
    const result = buildDeskConfigOutliers(
      [client('a', [strategy('A0')]), client('b', [strategy('B0')])],
      { date: DAY },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].accountList.map((entry) => entry.accountName)).toEqual(['A0', 'B0']);
  });

  it('measures at three and finds the one account off the other two', () => {
    const result = buildDeskConfigOutliers(
      [
        client('a', [strategy('A0')]),
        client('b', [strategy('B0')]),
        client('c', [strategy('C0', { StopLossTicks: '250' })]),
      ],
      { date: DAY },
    );

    const group = groupOf(result);
    expect(group.accounts).toBe(MIN_CONSENSUS_ACCOUNTS);
    expect(group.measured).toBe(true);
    expect(group.outliers).toHaveLength(1);
    expect(group.outliers[0].accountName).toBe('C0');
  });
});

describe('per machine fields are never reported', () => {
  it('drops the licence key, which is per machine and differs on every row', () => {
    const clients = desk(8).map((entry, index) => ({
      ...entry,
      dailyImports: [{
        ...entry.dailyImports[0],
        strategies: [strategy(`A${index}`, { LicenseKey: `V-00000${index}-11111111-2222222` })],
      }],
    }));

    const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));
    expect(group.outliers).toEqual([]);
    expect(group.consensus.some((entry) => entry.name === 'LicenseKey')).toBe(false);
    expect(group.splitFields.some((entry) => entry.name === 'LicenseKey')).toBe(false);
  });

  it('drops Backtest even when one machine exported it the other way', () => {
    // The derived rule cannot see this one: Backtest is constant on 3,700 of
    // the book's 3,707 readable rows, so "a different value on every account"
    // never fires on it. It says how the export was taken, not what the account
    // was configured to trade.
    const clients = desk(8);
    clients[3].dailyImports[0].strategies = [strategy('A3', { Backtest: 'True' })];

    const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));
    expect(group.outliers).toEqual([]);
    expect(group.fields.ignored).toContainEqual({ name: 'Backtest', reason: 'per-machine' });
  });

  it('derives the rule for a field nobody has named, at scale', () => {
    // `Account` is not in this book's exports at all; the production one
    // carries it. Nothing is hard coded for it: a field with a different value
    // on every account of a group this size cannot have a consensus, whatever
    // it is called.
    const clients = desk(10).map((entry, index) => ({
      ...entry,
      dailyImports: [{
        ...entry.dailyImports[0],
        strategies: [strategy(`A${index}`, { Account: `APEX-${index}` })],
      }],
    }));

    const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));
    expect(group.fields.ignored).toContainEqual({ name: 'Account', reason: 'unique-per-account' });
    expect(group.outliers).toEqual([]);
  });

  it('does not call a setting an identifier in a small group', () => {
    // Three accounts holding three stops is an ordinary cohort of three. The
    // derived rule needs scale before "distinct on every account" means
    // anything, and without the floor it labelled StopLossTicks per machine on
    // a real three-account group.
    const result = buildDeskConfigOutliers(
      [
        client('a', [strategy('A0', { StopLossTicks: '300' })]),
        client('b', [strategy('B0', { StopLossTicks: '250' })]),
        client('c', [strategy('C0', { StopLossTicks: '200' })]),
      ],
      { date: DAY },
    );

    const group = groupOf(result);
    expect(group.fields.ignored).toEqual([{ name: 'Backtest', reason: 'per-machine' }]);
    // No consensus either: three readings over three accounts is a divided
    // group, which is a different sentence from a machine field.
    expect(group.splitFields.map((entry) => entry.name)).toContain('StopLossTicks');
    expect(group.outliers).toEqual([]);
  });
});

describe('a real disagreement is found', () => {
  const clients = [
    ...desk(9),
    client('odd', [strategy('ODD', { StopLossTicks: '315', TradeWindowIsOn: 'False' })]),
  ];
  const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));

  it('names the one account and the two settings', () => {
    expect(group.accounts).toBe(10);
    expect(group.outliers).toHaveLength(1);
    expect(group.outliers[0].accountName).toBe('ODD');
    expect(group.outliers[0].differences.map((entry) => entry.name))
      .toEqual(['StopLossTicks', 'TradeWindowIsOn']);
  });

  it('states the desk it is off, with its denominator', () => {
    const difference = differenceFor(group, 'ODD', 'StopLossTicks');
    expect(difference.state).toBe('different');
    expect(difference.value).toBe('315');
    expect(difference.consensus).toBe('300');
    expect(difference.consensusAccounts).toBe(9);
    expect(difference.population).toBe(10);
  });

  it('never calls the difference wrong', () => {
    // The shape carries no verdict field at all. A caller that wanted to print
    // one would have to invent it, which is the point.
    expect(Object.keys(group.outliers[0].differences[0]).sort()).toEqual([
      'consensus', 'consensusAccounts', 'distance', 'distancePct',
      'name', 'numeric', 'population', 'state', 'value',
    ]);
  });

  it('reads the parsed parameter map when the raw string is absent', () => {
    // `parameters_raw` and `params_parsed` are two renderings of one export.
    // A row that carries only the second is still comparable.
    const parsedOnly = client('parsed', [strategy('PARSED', {}, {
      parametersRaw: '',
      params: { valuesByName: { ...BASE, StopLossTicks: '275' } },
    })]);

    const result = buildDeskConfigOutliers([...desk(9), parsedOnly], { date: DAY });
    expect(differenceFor(groupOf(result), 'PARSED', 'StopLossTicks').value).toBe('275');
  });

  it('counts a row nobody can read rather than treating it as agreement', () => {
    const unreadable = client('bad', [strategy('BAD', {}, { parametersRaw: 'not a parameter list' })]);

    const group2 = groupOf(buildDeskConfigOutliers([...desk(9), unreadable], { date: DAY }));
    expect(group2.unreadable).toBe(1);
    expect(group2.accounts).toBe(9);
    expect(group2.outliers).toEqual([]);
  });
});

describe('the desk is not always agreed, and says so instead of ranking', () => {
  it('reports a field with no majority on the group and nobody against it', () => {
    // 11 Long and 9 Short. Under a plain "more than everybody else put
    // together" majority this listed 9 accounts for running Short, which on the
    // real book turned a 98 account group into 54 findings.
    const clients = [
      ...desk(11, { MyTradeDirection: 'Long' }),
      ...desk(9, { MyTradeDirection: 'Short' }).map((entry, index) => ({
        ...entry,
        id: `s${index}`,
      })),
    ];

    const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));
    expect(group.accounts).toBe(20);
    const split = group.splitFields.find((entry) => entry.name === 'MyTradeDirection');
    expect(split.reason).toBe('no-majority');
    expect(split.readings).toEqual([
      { value: 'Long', accounts: 11, share: 55 },
      { value: 'Short', accounts: 9, share: 45 },
    ]);
    expect(group.outliers).toEqual([]);
  });

  it('treats a reading a sixth of the desk runs as a second setting, not a deviation', () => {
    // 16 of 20 close at 16:45 and 4 at 16:30. The mode clears the consensus
    // floor, so the field has a desk answer, but four accounts on one alternative
    // is a session somebody chose.
    const clients = [
      ...desk(16, { CloseAllOpenTradeTime: '1/1/2020 4:45:00 PM' }),
      ...desk(4, { CloseAllOpenTradeTime: '1/1/2020 4:30:00 PM' })
        .map((entry, index) => ({ ...entry, id: `e${index}` })),
    ];

    const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));
    const entry = group.consensus.find((row) => row.name === 'CloseAllOpenTradeTime');
    expect(entry.value).toBe('2020-01-01T16:45:00');
    expect(entry.alsoInUse).toEqual([
      { value: '2020-01-01T16:30:00', accounts: 4, share: 20 },
    ]);
    expect(group.outliers).toEqual([]);
  });

  it('still reports a single account in a group of three', () => {
    // A share rule alone makes the odd account of a two-one split 33% and
    // therefore unreportable, which would silence the smallest groups entirely.
    const result = buildDeskConfigOutliers(
      [
        client('a', [strategy('A0')]),
        client('b', [strategy('B0')]),
        client('c', [strategy('C0', { TradeWindowIsOn: 'False' })]),
      ],
      { date: DAY },
    );

    expect(groupOf(result).outliers.map((entry) => entry.accountName)).toEqual(['C0']);
  });
});

describe('numeric distance', () => {
  const clients = [
    ...desk(9),
    client('low', [strategy('LOW', { StopLossTicks: '250', ProfitTargetTicks1: '30' })]),
  ];
  const group = groupOf(buildDeskConfigOutliers(clients, { date: DAY }));

  it('gives the value and how far it sits from the desk', () => {
    const stop = differenceFor(group, 'LOW', 'StopLossTicks');
    expect(stop.numeric).toBe(true);
    expect(stop.value).toBe('250');
    expect(stop.consensus).toBe('300');
    expect(stop.distance).toBe(-50);
    expect(stop.distancePct).toBeCloseTo(-16.666667, 5);
  });

  it('scales the distance to the setting, not to the tick', () => {
    // -50 on a 300 stop and -370 on a 400 target are both real and are not the
    // same size of question.
    const target = differenceFor(group, 'LOW', 'ProfitTargetTicks1');
    expect(target.distance).toBe(-370);
    expect(target.distancePct).toBeCloseTo(-92.5, 5);
  });

  it('reports no distance for a setting that is not a number', () => {
    const clients2 = [...desk(9), client('t', [strategy('T', { MyTradeDirection: 'Long' })])];
    const difference = differenceFor(groupOf(buildDeskConfigOutliers(clients2, { date: DAY })), 'T', 'MyTradeDirection');

    expect(difference.numeric).toBe(false);
    expect(difference.distance).toBeNull();
    expect(difference.distancePct).toBeNull();
  });

  it('does not divide by a desk value of zero', () => {
    const clients2 = [
      ...desk(9, { ProfitTargetTicks1: '0' }),
      client('t', [strategy('T', { ProfitTargetTicks1: '40' })]),
    ];
    const difference = differenceFor(groupOf(buildDeskConfigOutliers(clients2, { date: DAY })), 'T', 'ProfitTargetTicks1');

    expect(difference.distance).toBe(40);
    expect(difference.distancePct).toBeNull();
  });
});

describe('a field an account does not carry at all', () => {
  it('is reported as missing, not as a different value', () => {
    // `BreakEvenOffset: (blank) against 5` invites a CAM to go and set a field
    // that does not exist on that account's build.
    const withField = desk(9, { BreakEvenOffset: '5' });
    const without = client('bare', [strategy('BARE')]);

    const group = groupOf(buildDeskConfigOutliers([...withField, without], { date: DAY }));
    const difference = differenceFor(group, 'BARE', 'BreakEvenOffset');
    expect(difference.state).toBe('missing');
    expect(difference.value).toBeNull();
    expect(difference.consensus).toBe('5');
    expect(difference.distance).toBeNull();
  });

  it('is the other way round when the desk carries none and one account does', () => {
    const plain = desk(9);
    const extra = client('extra', [strategy('EXTRA', { Martingale: 'True' })]);

    const group = groupOf(buildDeskConfigOutliers([...plain, extra], { date: DAY }));
    const difference = differenceFor(group, 'EXTRA', 'Martingale');
    expect(difference.state).toBe('extra');
    expect(difference.value).toBe('true');
    expect(difference.consensus).toBeNull();
  });

  it('is a second build, not a finding, when a real share of the desk is on it', () => {
    // 25 of 37 IFSP accounts on the book carry day-of-week filters and 12 carry
    // none. That is two builds of one version, not twelve accounts missing a
    // setting.
    const withField = desk(14, { FridayFilter: 'True' });
    const without = desk(6).map((entry, index) => ({ ...entry, id: `n${index}` }));

    const group = groupOf(buildDeskConfigOutliers([...withField, ...without], { date: DAY }));
    const entry = group.consensus.find((row) => row.name === 'FridayFilter');
    expect(entry.alsoInUse).toEqual([{ value: null, accounts: 6, share: 30 }]);
    expect(group.outliers).toEqual([]);
  });

  it('reports every account when not one of them can be read on a field', () => {
    // Nothing can be the desk's reading here, and the honest answer is still
    // three accounts to look at rather than a field that quietly vanished.
    const pair = (id) => client(id, [
      strategy(id.toUpperCase(), { StopLossTicks: '300' }),
      strategy(id.toUpperCase(), { StopLossTicks: '250' }),
    ]);

    const group = groupOf(buildDeskConfigOutliers([pair('a'), pair('b'), pair('c')], { date: DAY }));
    expect(group.outliers).toHaveLength(3);
    for (const outlier of group.outliers) {
      const difference = outlier.differences.find((entry) => entry.name === 'StopLossTicks');
      expect(difference.state).toBe('inconsistent');
      expect(difference.consensus).toBeNull();
      expect(difference.population).toBe(0);
    }
  });

  it('reports an account whose own two rows disagree rather than picking one', () => {
    const twoRows = client('two', [
      strategy('TWO', { StopLossTicks: '300' }),
      strategy('TWO', { StopLossTicks: '250' }),
    ]);

    const group = groupOf(buildDeskConfigOutliers([...desk(9), twoRows], { date: DAY }));
    const difference = differenceFor(group, 'TWO', 'StopLossTicks');
    expect(difference.state).toBe('inconsistent');
    expect(difference.values).toEqual(['250', '300']);
    expect(difference.consensus).toBe('300');
  });
});

describe('what a group is', () => {
  it('is one day, and not the closes on either side of it', () => {
    // The whole point. A client's settings from a fortnight ago are not
    // evidence about what the desk was running this morning.
    const yesterday = client('old', [strategy('OLD', { StopLossTicks: '250' })], '2026-09-18');

    const result = buildDeskConfigOutliers([...desk(9), yesterday], { date: DAY });
    expect(groupOf(result).accounts).toBe(9);
    expect(result.basis.closes).toBe(9);
    expect(groupOf(result).outliers).toEqual([]);
  });

  it('reads one contract however the grid spelled it', () => {
    // `MNQ SEP26`, `MNQ 09-26` and `MNQU6` are one contract and all three are
    // in the book. Grouping on the raw string scattered 14 of 68 URGO accounts
    // into groups too small to have a consensus.
    const spellings = ['MNQ SEP26', 'MNQ 09-26', 'MNQU6'].map((instrument, index) => client(
      `i${index}`,
      [strategy(`I${index}`, {}, { instrument })],
    ));

    const result = buildDeskConfigOutliers(spellings, { date: DAY });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].instrument).toBe('MNQ 2026-09');
    expect(result.groups[0].spellings).toEqual(['MNQ 09-26', 'MNQ SEP26', 'MNQU6']);
  });

  it('keeps two contract months apart and says the other is there', () => {
    // An account still on August while the desk has rolled to September is the
    // "somebody is out of date" the whole panel exists for.
    const september = desk(4);
    const august = desk(3).map((entry, index) => ({
      ...entry,
      id: `aug${index}`,
      dailyImports: [{
        ...entry.dailyImports[0],
        strategies: [strategy(`AUG${index}`, {}, { instrument: 'MNQ AUG26' })],
      }],
    }));

    const result = buildDeskConfigOutliers([...september, ...august], { date: DAY });
    expect(result.groups.map((group) => group.instrument)).toEqual(['MNQ 2026-09', 'MNQ 2026-08']);
    expect(result.groups[1].contractPeers).toEqual([
      { contract: '2026-09', instrument: 'MNQ 2026-09', accounts: 4 },
    ]);
  });

  it('places a row that stated no data series on the busiest one, and counts it', () => {
    const stated = desk(4);
    const blank = client('blank', [strategy('BLANK', {}, { dataSeries: '' })]);

    const group = groupOf(buildDeskConfigOutliers([...stated, blank], { date: DAY }));
    expect(group.dataSeries).toBe('15 Minute');
    expect(group.accounts).toBe(5);
    expect(group.unstatedSeries).toBe(1);
  });

  it('keeps an account that stated a different data series in its own group', () => {
    const fifteen = desk(4);
    const oneMinute = client('fast', [strategy('FAST', {}, { dataSeries: '1 Minute' })]);

    const result = buildDeskConfigOutliers([...fifteen, oneMinute], { date: DAY });
    expect(result.groups.map((group) => group.dataSeries)).toEqual(['15 Minute', '1 Minute']);
    expect(result.groups[1].measured).toBe(false);
  });

  it('counts a row with no trading account rather than attributing it', () => {
    const nameless = client('none', [strategy('', { StopLossTicks: '250' })]);

    const group = groupOf(buildDeskConfigOutliers([...desk(9), nameless], { date: DAY }));
    expect(group.unnamed).toBe(1);
    expect(group.accounts).toBe(9);
    expect(group.outliers).toEqual([]);
  });
});

describe('deskInstrumentOf', () => {
  it('reads the three spellings of one contract as one', () => {
    expect(deskInstrumentOf('MNQ SEP26').label).toBe('MNQ 2026-09');
    expect(deskInstrumentOf('MNQ 09-26').label).toBe('MNQ 2026-09');
    expect(deskInstrumentOf('MNQU6').label).toBe('MNQ 2026-09');
  });

  it('does not read M2KU6 as root M', () => {
    // instrumentSpecs.js knows the desk's roots; a letters-then-digits rule
    // does not, and M2K contains a digit.
    expect(deskInstrumentOf('M2KU6')).toEqual({ root: 'M2K', contract: '2026-09', label: 'M2K 2026-09' });
  });

  it('keeps a string it cannot parse rather than inventing a contract', () => {
    expect(deskInstrumentOf('SOMETHING ODD').contract).toBe('');
    expect(deskInstrumentOf('').label).toBe('');
  });
});

describe('what the panel fetches', () => {
  it('asks for exactly the day, not for every client’s latest close', () => {
    const clients = [
      client('a', [strategy('A0')]),
      client('b', [strategy('B0')], '2026-09-18'),
    ];

    expect(deskDayImportIds(clients, DAY)).toEqual(['a-uuid']);
    expect(deskDayImportIds(clients, '')).toEqual([]);
  });

  it('shows the pinned day, or the book’s last close when nothing is pinned', () => {
    const clients = [client('a', [strategy('A0')]), client('b', [strategy('B0')], '2026-09-18')];

    expect(deskConfigDayFor(clients, '2026-09-18')).toBe('2026-09-18');
    expect(deskConfigDayFor(clients, '')).toBe(DAY);
    expect(deskConfigDayFor([], '')).toBe('');
  });

  it('says nothing at all without a day', () => {
    const result = buildDeskConfigOutliers(desk(9), { date: '' });
    expect(result.groups).toEqual([]);
    expect(result.reason).toBe('no-date');
  });
});

describe('rowParameters', () => {
  it('states both renderings in one dialect', () => {
    // `True` and `true`, `1/1/2020 4:45:00 PM` and `2020-01-01T16:45:00` are the
    // same value written two ways, and an account must not be reported as
    // differing from the desk on formatting.
    const fromRaw = rowParameters({ parametersRaw: params({ A: 'True', B: '1/1/2020 4:45:00 PM' }) });
    const fromParsed = rowParameters({ params: { valuesByName: { A: 'true', B: '2020-01-01T16:45:00' } } });

    expect(fromRaw).toEqual(fromParsed);
  });

  it('is null and not empty for a row nobody can read', () => {
    expect(rowParameters({ parametersRaw: '' })).toBeNull();
    expect(rowParameters({})).toBeNull();
    expect(rowParameters(null)).toBeNull();
  });
});
