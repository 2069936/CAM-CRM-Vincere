import { describe, expect, it } from 'vitest';
import { buildStrategyRiskProfile, strategyFamilyOf } from './strategyRiskProfile';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

// The URGO/B2X parameter set as NinjaTrader exports it: 31 names, three of the
// values a `1/1/2020 4:45:00 PM` timestamp.
const URGO_NAMES = [
  'Backtest', 'BreakEvenAfterTicks', 'BreakEvenIsOn', 'BreakEvenOffset',
  'CloseAllOpenTrades', 'CloseAllOpenTradeTime', 'EdgeLeverage', 'LicenseKey',
  'LimitDailyEntries', 'MaxDailyEntries', 'MyTradeDirection', 'PosSize1',
  'PosSize2', 'PosSize3', 'ProfitTargetTicks1', 'ProfitTargetTicks2',
  'ProfitTargetTicks3', 'ReEntryIsOn', 'ReEntryWaitBars', 'StartTrailAfterTicks',
  'StopLossTicks', 'TradeEndTime', 'TradeStartTime', 'TradeWindowIsOn',
  'TrailByTicks', 'TrailFrequency', 'TrailIsOn', 'URGO1', 'URGO2', 'URGO3', 'URGO4',
];

const URGO_VALUES = {
  Backtest: 'False',
  BreakEvenAfterTicks: '30',
  BreakEvenIsOn: 'False',
  BreakEvenOffset: '2',
  CloseAllOpenTrades: 'True',
  CloseAllOpenTradeTime: '1/1/2020 4:45:00 PM',
  EdgeLeverage: 'False',
  LicenseKey: 'V-C0E19E-F6089795-EF0841W',
  LimitDailyEntries: 'True',
  MaxDailyEntries: '4',
  MyTradeDirection: 'Both',
  PosSize1: '1',
  PosSize2: '1',
  PosSize3: '0',
  ProfitTargetTicks1: '120',
  ProfitTargetTicks2: '150',
  ProfitTargetTicks3: '200',
  ReEntryIsOn: 'True',
  ReEntryWaitBars: '2',
  StartTrailAfterTicks: '127',
  StopLossTicks: '60',
  TradeEndTime: '1/1/2020 11:30:00 AM',
  TradeStartTime: '1/1/2020 10:00:00 AM',
  TradeWindowIsOn: 'True',
  TrailByTicks: '70',
  TrailFrequency: '15',
  TrailIsOn: 'True',
  URGO1: '38',
  URGO2: '5',
  URGO3: '22',
  URGO4: '5',
};

// Bullet Bot, verbatim from a real strategies export: a different set of names
// for the same ideas — TradeWindow1IsOn, one unnumbered ProfitTargetTicks, and
// no re-entry switch at all.
const BULLET_NAMES = [
  'Backtest', 'EntryOrderTickOffset', 'LicenseKey', 'MyTradeDirection',
  'PositionSize', 'ProfitTargetTicks', 'RangeEnd', 'RangeStart', 'StopLossTicks',
  'TradeEnd1', 'TradeStart1', 'TradeWindow1IsOn',
];

const BULLET_VALUES = {
  Backtest: 'False',
  EntryOrderTickOffset: '10',
  LicenseKey: 'V-C0E19E-F6089795-EF0841W',
  MyTradeDirection: 'Short',
  PositionSize: '2',
  ProfitTargetTicks: '155',
  RangeEnd: '1/1/2020 9:29:30 AM',
  RangeStart: '1/1/2020 9:27:00 AM',
  StopLossTicks: '110',
  TradeEnd1: '1/1/2020 9:30:20 AM',
  TradeStart1: '1/1/2020 9:27:00 AM',
  TradeWindow1IsOn: 'True',
};

function parameters(names, defaults, overrides = {}) {
  const values = { ...defaults, ...overrides };
  return `${names.map((name) => values[name]).join('/')} (${names.join('/')})`;
}

const urgoParams = (overrides) => parameters(URGO_NAMES, URGO_VALUES, overrides);
const bulletParams = (overrides) => parameters(BULLET_NAMES, BULLET_VALUES, overrides);

/** One client, one day, spelled out so each test can say only what it is about. */
function book({ id = 'c1', date = '2026-07-27', strategies = [], executions = [] } = {}) {
  return [{ id, dailyImports: [{ date, strategies, executions }] }];
}

const urgoRow = (accountName, overrides) => ({
  strategyName: '1 - URGO-4.5',
  accountName,
  parametersRaw: urgoParams(overrides),
  enabled: true,
  realized: 0,
});

const fills = (count, accountName, strategyName = '1 - URGO-4.5') => (
  Array.from({ length: count }, () => ({ strategyName, accountName, time: '7/27/2026 10:15:00 AM' }))
);

const familyRow = (rows, family) => rows.find((row) => row.family === family);

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('parameter splitting', () => {
  it('reads a 31-name set whose values naively split into 37 fragments', () => {
    // The exact shape that broke this before: three timestamps, two extra
    // fragments each. A naive split does not fail loudly — every value after
    // the first date lands under the wrong name, so the stop reads as a trail
    // frequency and the number still looks like a number.
    const raw = urgoParams();
    const [valuePart, namePart] = raw.split(' (');

    expect(URGO_NAMES).toHaveLength(31);
    expect(valuePart.split('/')).toHaveLength(37);
    expect(namePart.slice(0, -1).split('/')).toHaveLength(31);

    const [row] = buildStrategyRiskProfile(book({ strategies: [urgoRow('A')] }));

    expect(row.stopTicks).toBe(60);
    expect(row.targetTicks).toBe(120);
    expect(row.rewardRisk).toBe(2);
  });

  it('does not mistake a four-digit tick value for a year', () => {
    // PosSize2/PosSize3/ProfitTargetTicks1 of `1/0/1200` is three values, not a
    // date. Coalescing on the year alone swallows all three, the counts stop
    // matching, and a whole family drops out of the ranking.
    const [row] = buildStrategyRiskProfile(
      book({ strategies: [urgoRow('A', { ProfitTargetTicks1: '1200' })] }),
    );

    expect(row.stopTicks).toBe(60);
    expect(row.targetTicks).toBe(1200);
  });

  it('drops a set whose values and names do not line up rather than zipping by index', () => {
    const aligned = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: 'X-1.0', accountName: 'A', parametersRaw: '60/120 (StopLossTicks/ProfitTargetTicks1)' }],
    }));
    const ragged = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: 'X-1.0', accountName: 'A', parametersRaw: '60/120/extra (StopLossTicks/ProfitTargetTicks1)' }],
    }));

    expect(aligned[0].stopTicks).toBe(60);
    // Same numbers in the string; a zip by index would still report 60 here.
    expect(ragged[0].stopTicks).toBeNull();
    expect(ragged[0].rewardRisk).toBeNull();
  });

  it('reads the unnumbered ProfitTargetTicks a family writes instead of ProfitTargetTicks1', () => {
    // Bullet Bot writes one target where URGO writes three. Reading only the
    // numbered name leaves Bullet Bot with no reward to weigh its stop against,
    // and a family with no reward:risk drops out of the ranking entirely.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: '0 - Bullet Bot-1.1', accountName: 'A', parametersRaw: bulletParams() }],
      executions: fills(2, 'A', '0 - Bullet Bot-1.1'),
    }));

    expect(row.targetTicks).toBe(155);
    expect(row.stopTicks).toBe(110);
    expect(row.exposure).not.toBeNull();
  });

  it('reports a family with no parameters at all rather than dropping it', () => {
    const [row] = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: '1 - URGO-4.5', accountName: 'A', parametersRaw: '' }],
      executions: fills(3, 'A'),
    }));

    expect(row.family).toBe('URGO');
    expect(row.accounts).toBe(1);
    expect(row.fillsPerDay).toBe(3);
    expect(row.stopTicks).toBeNull();
    expect(row.exposure).toBeNull();
  });
});

describe('strategyFamilyOf', () => {
  it('strips the grid index and the version but keeps -PF', () => {
    expect(strategyFamilyOf('0 - OGX-PF-2.4')).toBe('OGX-PF');
    expect(strategyFamilyOf('1-URGO-4.5')).toBe('URGO');
    expect(strategyFamilyOf('0 - Bullet Bot-1.1')).toBe('Bullet Bot');
    expect(strategyFamilyOf('URGO')).toBe('URGO');
  });

  it('keeps -PF apart from the family it is named after', () => {
    // OGX-PF runs under prop-firm rules OGX does not. Folding the two together
    // would average a stop across two different products.
    expect(strategyFamilyOf('0 - OGX-PF-2.4')).not.toBe(strategyFamilyOf('0 - OGX-2.4'));
    expect(strategyFamilyOf('0 - OGX-2.4')).toBe('OGX');
  });

  it('leaves a trailing number alone when it is not a version', () => {
    // csvImport reads a version as digits with a dot in them. Stripping any
    // trailing -N as well would fold a family genuinely called B2X-4 into B2X
    // and average two products' stops together.
    expect(strategyFamilyOf('2 - B2X-4')).toBe('B2X-4');
    expect(strategyFamilyOf('2 - B2X-2.5')).toBe('B2X');
  });

  it('has nothing to say about an unnamed strategy', () => {
    expect(strategyFamilyOf('')).toBeNull();
    expect(strategyFamilyOf(null)).toBeNull();
  });

  it('gathers every version of a family into one row', () => {
    const rows = buildStrategyRiskProfile(book({
      strategies: [
        { strategyName: '0 - OGX-PF-2.4', accountName: 'A', parametersRaw: urgoParams() },
        { strategyName: '1 - OGX-PF-3.0', accountName: 'A', parametersRaw: urgoParams() },
        { strategyName: '2 - OGX-PF-3.0', accountName: 'B', parametersRaw: urgoParams() },
      ],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe('OGX-PF');
    expect(rows[0].strategies).toBe(3);
    // A runs two versions of it and is still one account.
    expect(rows[0].accounts).toBe(2);
  });
});

describe('trade window', () => {
  it('reads TradeWindowIsOn and TradeWindow1IsOn as the same switch', () => {
    // Keying on the literal name reads one family and reports the other as
    // having no trade window — which in the output is indistinguishable from a
    // strategy that trades around the clock.
    const rows = buildStrategyRiskProfile(book({
      strategies: [
        urgoRow('A'),
        { strategyName: '0 - Bullet Bot-1.1', accountName: 'B', parametersRaw: bulletParams() },
      ],
    }));

    expect(familyRow(rows, 'URGO').windowPct).toBe(100);
    expect(familyRow(rows, 'Bullet Bot').windowPct).toBe(100);
  });

  it('counts the share of parameter sets with the window on', () => {
    const rows = buildStrategyRiskProfile(book({
      strategies: [
        urgoRow('A'),
        urgoRow('B', { TradeWindowIsOn: 'False' }),
        urgoRow('C', { TradeWindowIsOn: 'False' }),
        urgoRow('D', { TradeWindowIsOn: 'False' }),
      ],
    }));

    expect(rows[0].windowPct).toBe(25);
  });

  it('answers null, not zero, for a family whose export never carried the switch', () => {
    // Bullet Bot has no ReEntryIsOn. "No re-entry" and "we cannot tell" are
    // different claims and only one of them is supported.
    const rows = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: '0 - Bullet Bot-1.1', accountName: 'A', parametersRaw: bulletParams() }],
    }));

    expect(rows[0].reEntryPct).toBeNull();
    expect(rows[0].windowPct).toBe(100);
  });

  it('does not read an unparseable switch as off', () => {
    // "Off" is a claim about the setting. A blank column is not evidence for
    // it, and a chart cannot tell an honest 0% from a manufactured one.
    const rows = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { TradeWindowIsOn: '' })],
    }));

    expect(rows[0].windowPct).toBeNull();
    expect(rows[0].reEntryPct).toBe(100);   // the set itself parsed fine
  });

  it('counts re-entry across the parameter sets that carry it', () => {
    const rows = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), urgoRow('B', { ReEntryIsOn: 'False' })],
    }));

    expect(rows[0].reEntryPct).toBe(50);
  });
});

describe('fills per day', () => {
  const twoAccountsTwoDays = [{
    id: 'c1',
    dailyImports: [
      {
        date: '2026-07-27',
        strategies: [urgoRow('A'), urgoRow('B')],
        executions: [...fills(1, 'A'), ...fills(1, 'B')],
      },
      {
        date: '2026-07-28',
        strategies: [urgoRow('A'), urgoRow('B')],
        executions: [...fills(2, 'A'), ...fills(10, 'B')],
      },
    ],
  }];

  it('takes the median across (account, day) pairs, not the total', () => {
    // Pairs are 1, 1, 2 and 10: median 1.5, mean 3.5, total 14. Only the median
    // survives one account having a wild day.
    const [row] = buildStrategyRiskProfile(twoAccountsTwoDays);

    expect(row.fillsPerDay).toBe(1.5);
    expect(row.maxFillsPerDay).toBe(10);
  });

  it('does not let one busy account stand in for the family', () => {
    // Both accounts ran it; only one traded. A count of executions alone says
    // 4 fills a day, which is true of no account here.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), urgoRow('B')],
      executions: fills(4, 'A'),
    }));

    expect(row.fillsPerDay).toBe(2);
    expect(row.maxFillsPerDay).toBe(4);
  });

  it('keeps two clients running the same account name apart', () => {
    // Every book has a Sim101. Merging them on the display name folds two
    // account-days into one and doubles the fill count on it.
    const rows = buildStrategyRiskProfile([
      { id: 'c1', dailyImports: [{ date: '2026-07-27', strategies: [urgoRow('Sim101')], executions: fills(2, 'Sim101') }] },
      { id: 'c2', dailyImports: [{ date: '2026-07-27', strategies: [urgoRow('Sim101')], executions: fills(2, 'Sim101') }] },
    ]);

    expect(rows[0].accounts).toBe(2);
    expect(rows[0].fillsPerDay).toBe(2);
    expect(rows[0].maxFillsPerDay).toBe(2);
  });

  it('scores the same book whichever import route it arrived by', () => {
    // Enabled is optional on the Strategies grid, and parseBool reads an absent
    // column as false — indistinguishable from a genuinely parked strategy. The
    // auto path passes it through as undefined. Excluding disabled rows from
    // the median therefore scored one book three different ways depending on
    // which columns a CAM had switched on that morning.
    //
    // A configured strategy that did not fire is a measured zero for that
    // account-day. That is a defensible number; one whose meaning depends on a
    // grid setting is not.
    const asDisabled = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), { ...urgoRow('B'), enabled: false }],
      executions: fills(4, 'A'),
    }));
    const asEnabled = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), urgoRow('B')],
      executions: fills(4, 'A'),
    }));
    const asUndefined = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), { ...urgoRow('B'), enabled: undefined }],
      executions: fills(4, 'A'),
    }));

    expect(asDisabled[0].fillsPerDay).toBe(2);
    expect(asEnabled[0].fillsPerDay).toBe(2);
    expect(asUndefined[0].fillsPerDay).toBe(2);
    expect(asDisabled[0].accounts).toBe(2);
  });

  it('counts a fill whose strategy the grid never listed', () => {
    // A fill is proof the thing ran. Requiring a matching strategy row would
    // discard real trading because a grid export was taken after a shutdown.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [],
      executions: fills(3, 'A'),
    }));

    expect(row.family).toBe('URGO');
    expect(row.strategies).toBe(0);
    expect(row.fillsPerDay).toBe(3);
  });
});

describe('reward:risk', () => {
  it('answers null for a stop of zero rather than dividing by it', () => {
    // A zero stop is a stop that was never exported. Dividing by it gives
    // Infinity, which sorts to the top of a risk ranking forever.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { StopLossTicks: '0' })],
      executions: fills(6, 'A'),
    }));

    expect(row.stopTicks).toBe(0);          // read, not lost
    expect(row.targetTicks).toBe(120);
    expect(row.rewardRisk).toBeNull();
    expect(row.fillsPerDay).toBe(6);        // exposure is null despite real fills
    expect(row.exposure).toBeNull();
  });

  it('answers null for a missing stop rather than assuming one', () => {
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { StopLossTicks: '' })],
      executions: fills(6, 'A'),
    }));

    expect(row.stopTicks).toBeNull();
    expect(row.rewardRisk).toBeNull();
    expect(row.exposure).toBeNull();
  });

  it('answers null when there is no target to weigh the stop against', () => {
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { ProfitTargetTicks1: '0' })],
    }));

    expect(row.stopTicks).toBe(60);
    expect(row.rewardRisk).toBeNull();
    expect(row.exposure).toBeNull();
  });

  it('rounds to two decimals', () => {
    // Bullet Bot: 155 / 110 = 1.4090909…
    const [row] = buildStrategyRiskProfile(book({
      strategies: [{ strategyName: '0 - Bullet Bot-1.1', accountName: 'A', parametersRaw: bulletParams() }],
      executions: fills(3, 'A', '0 - Bullet Bot-1.1'),
    }));

    expect(row.rewardRisk).toBe(1.41);
    expect(row.exposure).toBe(2.13);        // 3 / 1.41
  });

  it('takes the median stop and target across parameter sets, not the first or the widest', () => {
    // One client left a backtest configuration on a live account with a
    // 400-tick stop. A mean or a max lets that single row set the number the
    // whole family is judged by.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [
        urgoRow('A', { StopLossTicks: '40', ProfitTargetTicks1: '100' }),
        urgoRow('B', { StopLossTicks: '60', ProfitTargetTicks1: '120' }),
        urgoRow('C', { StopLossTicks: '400', ProfitTargetTicks1: '400' }),
      ],
    }));

    expect(row.stopTicks).toBe(60);         // mean 166.67, max 400, first 40
    expect(row.targetTicks).toBe(120);      // mean 206.67, max 400, first 100
    expect(row.rewardRisk).toBe(2);
  });
});

describe('ranking', () => {
  it('puts the most exposed family first', () => {
    // Same reward:risk of 2, different rates of fire.
    const rows = buildStrategyRiskProfile(book({
      strategies: [
        urgoRow('A'),
        { strategyName: '0 - OGX-PF-2.4', accountName: 'B', parametersRaw: urgoParams() },
      ],
      executions: [...fills(2, 'A'), ...fills(8, 'B', '0 - OGX-PF-2.4')],
    }));

    expect(rows.map((row) => row.family)).toEqual(['OGX-PF', 'URGO']);
    expect(rows[0].exposure).toBe(4);
    expect(rows[1].exposure).toBe(1);
  });

  it('sinks a family whose reward:risk could not be read, however busy it is', () => {
    // An unrankable family sorting as if its exposure were zero is honest; one
    // sorting to the top on a missing column is not, and neither belongs above
    // a family we can actually measure.
    const rows = buildStrategyRiskProfile(book({
      strategies: [
        urgoRow('A'),
        { strategyName: '0 - Bullet Bot-1.1', accountName: 'B', parametersRaw: bulletParams({ StopLossTicks: '0' }) },
      ],
      executions: [...fills(2, 'A'), ...fills(50, 'B', '0 - Bullet Bot-1.1')],
    }));

    expect(rows.map((row) => row.family)).toEqual(['URGO', 'Bullet Bot']);
    expect(rows[1].fillsPerDay).toBe(50);
    expect(rows[1].exposure).toBeNull();
  });

  it('ignores rows with no strategy name', () => {
    const rows = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), { strategyName: '', accountName: 'B', parametersRaw: urgoParams() }],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0].strategies).toBe(1);
  });

  it('returns nothing for an empty book', () => {
    expect(buildStrategyRiskProfile([])).toEqual([]);
    expect(buildStrategyRiskProfile()).toEqual([]);
  });
});

describe('asOfDate', () => {
  const twoDays = [{
    id: 'c1',
    dailyImports: [
      { date: '2026-07-27', strategies: [urgoRow('A')], executions: fills(2, 'A') },
      {
        date: '2026-07-28',
        strategies: [urgoRow('A', { StopLossTicks: '10' }), { strategyName: '0 - Bullet Bot-1.1', accountName: 'B', parametersRaw: bulletParams() }],
        executions: fills(20, 'A'),
      },
    ],
  }];

  it('ignores imports filed after the day being viewed', () => {
    const rows = buildStrategyRiskProfile(twoDays, { asOfDate: '2026-07-27' });

    expect(rows.map((row) => row.family)).toEqual(['URGO']);
    expect(rows[0].stopTicks).toBe(60);      // not the median of 60 and 10
    expect(rows[0].fillsPerDay).toBe(2);
    expect(rows[0].maxFillsPerDay).toBe(2);
  });

  it('counts everything on record when no date is given', () => {
    const rows = buildStrategyRiskProfile(twoDays);

    expect(rows.map((row) => row.family).sort()).toEqual(['Bullet Bot', 'URGO']);
    expect(familyRow(rows, 'URGO').stopTicks).toBe(35);
    expect(familyRow(rows, 'URGO').maxFillsPerDay).toBe(20);
    // Two days of the same account is one account, and two account-days.
    expect(familyRow(rows, 'URGO').accounts).toBe(1);
    expect(familyRow(rows, 'URGO').fillsPerDay).toBe(11);
  });
});

describe('figures that must not be invented', () => {
  it('never produces an infinite exposure from a thin edge', () => {
    // rewardRisk was rounded to two decimals before being used as a divisor.
    // Any ratio under 0.005 became exactly 0 — not null, so the guard never
    // fired — and dividing by it gave Infinity, which sorted to the very top of
    // the risk ranking this guard exists to protect.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { StopLossTicks: '1000', ProfitTargetTicks1: '4' })],
      executions: fills(1, 'A'),
    }));

    expect(row.rewardRisk).toBe(0);
    expect(Number.isFinite(row.exposure)).toBe(true);
    expect(row.exposure).toBeCloseTo(250, 0);
  });

  it('computes exposure from the unrounded ratio', () => {
    // At a ratio of 0.014 the rounded divisor (0.01) overstates exposure by
    // 40%, and always in the same direction, so the row that looks worst is the
    // one whose number is least accurate.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A', { StopLossTicks: '500', ProfitTargetTicks1: '7' })],
      executions: fills(10, 'A'),
    }));

    expect(row.exposure).toBeCloseTo(714.29, 1);
    expect(row.exposure).not.toBeCloseTo(1000, 0);
  });

  it('reports a family nobody ran as unknown, not as the safest', () => {
    // median over zero account-days was defaulting to 0, and a finite 0 plots
    // as the calmest family on the chart. The honest answer is that it was
    // never observed.
    const [row] = buildStrategyRiskProfile([{
      id: 'c1',
      dailyImports: [{ date: '2026-07-27', strategies: [], executions: [] }],
    }, {
      id: 'c2',
      dailyImports: [{
        date: '2026-07-27',
        strategies: [{ strategyName: '0 - GHOST-1.0', accountName: '', parametersRaw: '' }],
        executions: [],
      }],
    }]);

    expect(row === undefined || row.fillsPerDay === null).toBe(true);
    expect(row === undefined || row.maxFillsPerDay === null).toBe(true);
  });

  it('reports the busiest day as unknown too when nothing was observed', () => {
    // maxFillsPerDay defaulting to 0 says "its busiest day saw no trades",
    // which is a claim. The truth is that no day was ever seen.
    const [row] = buildStrategyRiskProfile([{
      id: 'c1',
      dailyImports: [{
        date: '2026-07-27',
        strategies: [{ strategyName: '0 - GHOST-1.0', accountName: '', parametersRaw: '' }],
        executions: [],
      }],
    }]);

    expect(row.family).toBe('GHOST');
    expect(row.maxFillsPerDay).toBeNull();
    expect(row.fillsPerDay).toBeNull();
    expect(row.exposure).toBeNull();
  });

  it('does not let an unattributable fill masquerade as a quiet day', () => {
    // Account display name is optional on the Executions grid. Bucketing fills
    // with no account under one empty key put them beside the real per-account
    // pairs, and the median found the zeros: a row reading 0 fills a day next
    // to a maximum of 9.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), urgoRow('B'), urgoRow('C')],
      executions: fills(9, ''),
    }));

    expect(row.unattributedFills).toBe(9);
    expect(row.fillsPerDay).toBe(0);
    expect(row.maxFillsPerDay).toBe(0);
    // The contradiction the old shape allowed.
    expect(row.maxFillsPerDay).toBeLessThanOrEqual(row.unattributedFills + row.fillsPerDay + 9);
  });

  it('carries the sample size behind every median', () => {
    // A median over one parameter set and one over five hundred were
    // byte-identical, and the chart printed the family's row count beside both
    // as though it were the n.
    const [row] = buildStrategyRiskProfile(book({
      strategies: [urgoRow('A'), { ...urgoRow('B'), parametersRaw: 'garbage' }],
      executions: fills(2, 'A'),
    }));

    expect(row.stopSamples).toBe(1);
    expect(row.strategyRows).toBe(2);
    expect(row.parameterSets).toBe(1);
    expect(row.accountDays).toBeGreaterThan(0);
  });

  it('counts distinct configurations, not rows repeated across days', () => {
    // One unchanged config imported for 200 days counted as 200 "parameter
    // sets", so a family on one account for a year outranked one on thirty
    // accounts imported once, on the only breadth figure the caller gets.
    const [row] = buildStrategyRiskProfile([{
      id: 'c1',
      dailyImports: [
        { date: '2026-07-27', strategies: [urgoRow('A')], executions: [] },
        { date: '2026-07-28', strategies: [urgoRow('A')], executions: [] },
        { date: '2026-07-29', strategies: [urgoRow('A')], executions: [] },
      ],
    }]);

    expect(row.parameterSets).toBe(1);
    expect(row.strategyRows).toBe(3);
    expect(row.accounts).toBe(1);
  });
});
