import { describe, expect, it } from 'vitest';
import { buildConfigDrift, configKeyOf, shortConfigLabel } from './strategyConfigDrift';

const params = ({ pt = '400/450/500', sl = '300', size = '1/1/0', key = 'V-8F5D54-C32866C2-3DB348W' } = {}) => {
  const [pt1, pt2, pt3] = pt.split('/');
  const [s1, s2, s3] = size.split('/');
  return `False/30/${key}/${s1}/${s2}/${s3}/${pt1}/${pt2}/${pt3}/${sl}/1/1/2020 2:00:00 PM/True `
    + '(Backtest/BreakEvenAfterTicks/LicenseKey/PosSize1/PosSize2/PosSize3/'
    + 'ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/StopLossTicks/TradeEndTime/TrailIsOn)';
};

const client = (id, rows) => ({
  id, name: id,
  dailyImports: [{ date: '2026-08-03', strategies: rows }],
});

const row = (account, opts) => ({
  strategyName: '0 - URGO-4.5', instrument: 'MNQ SEP26',
  accountName: account, parametersRaw: params(opts),
});

describe('configKeyOf', () => {
  it('ignores the licence key, which is per client', () => {
    // Comparing raw strings made every client look unique — 580 groups where
    // there were 128 configurations.
    const a = configKeyOf(params({ key: 'V-AAAAAA-BBBBBBBB-CCCCCCC' }));
    const b = configKeyOf(params({ key: 'V-111111-22222222-3333333' }));

    expect(a).toBe(b);
  });

  it('ignores position sizing, which is risk level and not configuration', () => {
    // Of 127 config-and-risk combinations on a real book, 17 differed only by
    // contract count. Counting those as different versions reports a client on
    // a higher risk setting as running something else.
    expect(configKeyOf(params({ size: '1/1/0' }))).toBe(configKeyOf(params({ size: '3/2/1' })));
  });

  it('separates a genuine entry or exit change', () => {
    expect(configKeyOf(params({ pt: '400/450/500' }))).not.toBe(configKeyOf(params({ pt: '390/440/485' })));
    expect(configKeyOf(params({ sl: '300' }))).not.toBe(configKeyOf(params({ sl: '250' })));
  });

  it('does not break on the timestamps inside the parameter list', () => {
    // Times are written 1/1/2020 4:45:00 PM. A naive split on "/" turned one
    // value into three and threw the names out of alignment.
    const key = configKeyOf(params());

    expect(key).toContain('StopLossTicks=300');
    expect(key).toContain('TradeEndTime=1/1/2020 2:00:00 PM');
  });

  it('answers null for nothing rather than inventing a key', () => {
    expect(configKeyOf('')).toBeNull();
    expect(configKeyOf(null)).toBeNull();
  });
});

describe('shortConfigLabel', () => {
  it('names a configuration by the numbers a CAM recognises', () => {
    expect(shortConfigLabel('x', params({ pt: '400/450/500', sl: '300' }))).toBe('PT 400/450/500 · SL 300');
  });

  it('still labels a configuration it cannot parse', () => {
    // A blank label leaves two configurations indistinguishable on screen.
    expect(shortConfigLabel('SomeKey=1/Other=2', 'unparseable')).not.toBe('');
  });
});

describe('buildConfigDrift', () => {
  const cohort = (majority, odd) => [
    ...Array.from({ length: majority }, (_, i) => client(`maj${i}`, [row(`A${i}`)])),
    ...Array.from({ length: odd }, (_, i) => client(`odd${i}`, [row(`B${i}`, { pt: '30/60/90' })])),
  ];

  it('reports the small group running against a clear majority', () => {
    const rows = buildConfigDrift(cohort(20, 2));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ family: 'URGO', instrument: 'MNQ SEP26', cohort: 22, outlierAccounts: 2 });
    expect(rows[0].dominant.count).toBe(20);
    expect(rows[0].outliers[0].label).toBe('PT 30/60/90 · SL 300');
    expect(rows[0].outliers[0].accounts[0].clientName).toBe('odd0');
  });

  it('says nothing when the cohort is too small to have a norm', () => {
    // Two against one is not a deviation, it is three accounts. Flagging it
    // teaches a CAM to dismiss the flag.
    expect(buildConfigDrift(cohort(2, 1))).toEqual([]);
  });

  it('treats a second large group as a version split, not drift', () => {
    // Half and half is two versions in use. Calling either an outlier would be
    // an opinion about which is correct, which this cannot know.
    const rows = buildConfigDrift(cohort(10, 10));

    expect(rows).toEqual([]);
  });

  it('counts the versions in use when it does report drift', () => {
    const rows = buildConfigDrift([
      ...cohort(12, 2),
      ...Array.from({ length: 6 }, (_, i) => client(`v2_${i}`, [row(`C${i}`, { pt: '390/440/485' })])),
    ]);

    expect(rows[0].versions).toBe(2);   // the 12 and the 6
    expect(rows[0].outlierAccounts).toBe(2);
  });

  it('does not treat a risk-level change as drift', () => {
    const rows = buildConfigDrift([
      ...Array.from({ length: 18 }, (_, i) => client(`m${i}`, [row(`A${i}`, { size: '1/1/0' })])),
      client('high', [row('B1', { size: '3/3/2' })]),
    ]);

    expect(rows).toEqual([]);
  });

  it('reads the client’s latest close, not an old one', () => {
    const drifted = {
      id: 'c1', name: 'c1',
      dailyImports: [
        { date: '2026-08-01', strategies: [row('A1', { pt: '30/60/90' })] },
        { date: '2026-08-03', strategies: [row('A1')] },
      ],
    };
    const rows = buildConfigDrift([...cohort(15, 0), drifted]);

    expect(rows).toEqual([]);   // it was fixed on the latest close
  });

  it('respects an as-of date', () => {
    // Both the cohort and the drifted client need a close on the as-of date;
    // otherwise the cohort is filtered out and the run measures nothing, which
    // is a different outcome from finding no drift.
    const onBothDays = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`, name: `m${i}`,
      dailyImports: [
        { date: '2026-08-01', strategies: [row(`A${i}`)] },
        { date: '2026-08-03', strategies: [row(`A${i}`)] },
      ],
    }));
    const drifted = {
      id: 'c1', name: 'c1',
      dailyImports: [
        { date: '2026-08-01', strategies: [row('Z1', { pt: '30/60/90' })] },
        { date: '2026-08-03', strategies: [row('Z1')] },
      ],
    };

    // On the 1st it was running something nobody else ran.
    expect(buildConfigDrift([...onBothDays, drifted], { asOfDate: '2026-08-01' })[0].outlierAccounts).toBe(1);
    // By the 3rd it matched, so there is nothing to review.
    expect(buildConfigDrift([...onBothDays, drifted], { asOfDate: '2026-08-03' })).toEqual([]);
  });
});

describe('a group with no majority', () => {
  const spread = (counts) => counts.flatMap((n, index) =>
    Array.from({ length: n }, (_, i) => client(`g${index}_${i}`, [
      row(`A${index}${i}`, { pt: `${100 + index * 10}/200/300` }),
    ])));

  it('says nothing when the biggest configuration is a third of the cohort', () => {
    // A real book held a twelve-account family whose largest group was four.
    // Calling the singles deviations there names a majority that does not exist.
    expect(buildConfigDrift(spread([4, 3, 3, 1, 1]))).toEqual([]);
  });

  it('still reports drift once a real majority exists', () => {
    const rows = buildConfigDrift(spread([16, 1, 1]));

    expect(rows).toHaveLength(1);
    expect(rows[0].dominant.share).toBe(89);   // 16 of 18
    expect(rows[0].outlierAccounts).toBe(2);
  });
});
