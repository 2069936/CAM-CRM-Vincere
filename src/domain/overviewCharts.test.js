import { describe, expect, it } from 'vitest';
import {
  buildAlgoContribution,
  buildBookMix,
  buildFlagAging,
  buildTrailingBuffer,
  buildUploadCoverage,
  daysBetween,
  recentTradingDays,
} from './overviewCharts';

describe('buildTrailingBuffer', () => {
  const client = {
    accountRegistry: {
      'PROP-1': { alias: 'Apex 1', accountType: 'Funded', maxDrawdownLimit: 2500 },
      'PROP-2': { alias: 'Apex 2', accountType: 'Evaluation', maxDrawdownLimit: 2500 },
      'CASH-1': { alias: 'IRA', accountType: 'Cash - IRA', maxDrawdownLimit: 2500 },
    },
    dailyImports: [{
      date: '2026-07-27',
      snapshots: [
        { accountName: 'PROP-1', trailingMaxDrawdown: -300, trailingSource: 'reported' },
        { accountName: 'PROP-2', trailingMaxDrawdown: -2200, trailingSource: 'reported' },
        { accountName: 'CASH-1', trailingMaxDrawdown: -900, trailingSource: 'reported' },
      ],
    }],
  };

  it('leaves cash accounts out entirely', () => {
    // Trailing is a prop-firm rule. A cash account has none, so a buffer for it
    // would be a distance to a limit that does not exist — even though this
    // fixture deliberately leaves a stale maxDrawdownLimit on the record.
    const rows = buildTrailingBuffer(client);

    expect(rows.map((row) => row.accountName)).toEqual(['PROP-2', 'PROP-1']);
    expect(rows.some((row) => row.accountName === 'CASH-1')).toBe(false);
  });

  it('ranks the account closest to breaching first', () => {
    const rows = buildTrailingBuffer(client);

    expect(rows[0].alias).toBe('Apex 2');
    expect(rows[0].buffer).toBe(300);
    expect(rows[1].buffer).toBe(2200);
  });

  it('flags status against the reported thresholds', () => {
    const rows = buildTrailingBuffer(client);

    expect(rows[0].status).toBe('critical'); // 300 <= 500
    expect(rows[1].status).toBe('ok');
  });

  it('holds a derived figure to a wider threshold than a reported one', () => {
    // A derived trailing value is a lower bound: the real drawdown can only be
    // worse. Judging it on the reported thresholds would call an account safe
    // on evidence that cannot support it.
    const derived = {
      accountRegistry: { 'PROP-1': { accountType: 'Funded', maxDrawdownLimit: 2500 } },
      dailyImports: [{
        date: '2026-07-27',
        snapshots: [{ accountName: 'PROP-1', trailingMaxDrawdown: -700, trailingSource: 'derived' }],
      }],
    };
    const reported = {
      accountRegistry: { 'PROP-1': { accountType: 'Funded', maxDrawdownLimit: 2500 } },
      dailyImports: [{
        date: '2026-07-27',
        snapshots: [{ accountName: 'PROP-1', trailingMaxDrawdown: -700, trailingSource: 'reported' }],
      }],
    };

    // Same 1800 buffer, different verdict: 1800 is inside the derived
    // warning band (2400) but clear of the reported one (1200).
    expect(buildTrailingBuffer(derived)[0].status).toBe('warning');
    expect(buildTrailingBuffer(reported)[0].status).toBe('ok');
    expect(buildTrailingBuffer(derived)[0].isLowerBound).toBe(true);
  });

  it('skips accounts with no limit on record rather than assuming zero', () => {
    const noLimit = {
      accountRegistry: { 'PROP-1': { accountType: 'Funded', maxDrawdownLimit: '' } },
      dailyImports: [{
        date: '2026-07-27',
        snapshots: [{ accountName: 'PROP-1', trailingMaxDrawdown: -300 }],
      }],
    };

    // A zero limit would render every account as fully breached.
    expect(buildTrailingBuffer(noLimit)).toEqual([]);
  });

  it('uses the most recent import when none is named', () => {
    const twoDays = {
      accountRegistry: { 'PROP-1': { accountType: 'Funded', maxDrawdownLimit: 2500 } },
      dailyImports: [
        { date: '2026-07-27', snapshots: [{ accountName: 'PROP-1', trailingMaxDrawdown: -100 }] },
        { date: '2026-07-24', snapshots: [{ accountName: 'PROP-1', trailingMaxDrawdown: -2400 }] },
      ],
    };

    expect(buildTrailingBuffer(twoDays)[0].used).toBe(100);
  });
});

describe('buildAlgoContribution', () => {
  const client = {
    dailyImports: [{
      date: '2026-07-27',
      strategies: [
        { strategyName: 'RBO-1.8', accountName: 'A', realized: 439 },
        { strategyName: 'RBO-1.8', accountName: 'B', realized: 200 },
        { strategyName: 'IFSP-1.1', accountName: 'A', realized: -250 },
        { strategyName: '', accountName: 'A', realized: 999 },
      ],
    }],
  };

  it('sums a strategy across the accounts it ran on', () => {
    const rows = buildAlgoContribution(client);

    expect(rows[0]).toMatchObject({ name: 'RBO-1.8', realized: 639, accounts: 2 });
  });

  it('keeps losers, ordered from best to worst', () => {
    const rows = buildAlgoContribution(client);

    expect(rows.map((row) => row.name)).toEqual(['RBO-1.8', 'IFSP-1.1']);
    expect(rows[1].realized).toBe(-250);
  });

  it('ignores rows with no strategy name', () => {
    // An unnamed strategy would draw a bar nobody can act on.
    expect(buildAlgoContribution(client).some((row) => row.realized === 999)).toBe(false);
  });

  it('scales a losses-only day against its own worst bar', () => {
    const allRed = {
      dailyImports: [{
        date: '2026-07-27',
        strategies: [
          { strategyName: 'A', realized: -100 },
          { strategyName: 'B', realized: -400 },
        ],
      }],
    };
    const rows = buildAlgoContribution(allRed);

    expect(rows[1].share).toBe(100);
    expect(rows[0].share).toBe(25);
  });
});

describe('recentTradingDays', () => {
  it('skips weekends', () => {
    // 2026-07-27 is a Monday, so five trading days reach back to the Tuesday.
    expect(recentTradingDays('2026-07-27', 5)).toEqual([
      '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27',
    ]);
  });

  it('counts backwards from a weekend without including it', () => {
    expect(recentTradingDays('2026-07-25', 3)).toEqual([
      '2026-07-22', '2026-07-23', '2026-07-24',
    ]);
  });
});

describe('buildUploadCoverage', () => {
  const clients = [
    { id: 'c1', name: 'Full', dailyImports: [
      { date: '2026-07-23' }, { date: '2026-07-24' }, { date: '2026-07-27' },
    ] },
    { id: 'c2', name: 'Patchy', dailyImports: [{ date: '2026-07-27' }] },
  ];

  it('puts the client with the most gaps first', () => {
    const { rows } = buildUploadCoverage(clients, '2026-07-27', 3);

    expect(rows[0].clientName).toBe('Patchy');
    expect(rows[0].missed).toBe(2);
    expect(rows[1].missed).toBe(0);
  });

  it('never counts a weekend as a missed day', () => {
    const { days } = buildUploadCoverage(clients, '2026-07-27', 5);

    expect(days).not.toContain('2026-07-25');
    expect(days).not.toContain('2026-07-26');
  });

  it('ignores imports from outside the window', () => {
    const old = [{ id: 'c3', name: 'Old', dailyImports: [{ date: '2026-01-05' }] }];
    const { rows } = buildUploadCoverage(old, '2026-07-27', 3);

    expect(rows[0].missed).toBe(3);
  });
});

describe('buildBookMix', () => {
  it('counts accounts rather than clients', () => {
    // One client with eight funded accounts is not the same workload as eight
    // clients with one each, and a head count hides that.
    const rows = buildBookMix([
      { accountRegistry: { a: { accountType: 'Funded' }, b: { accountType: 'Funded' } } },
      { accountRegistry: { c: { accountType: 'Cash - IRA' } } },
    ]);

    expect(rows[0]).toMatchObject({ type: 'Funded', count: 2 });
    expect(rows[1]).toMatchObject({ type: 'Cash - IRA', count: 1 });
    expect(rows[0].share).toBeCloseTo(66.67, 1);
  });

  it('names unclassified accounts instead of dropping them', () => {
    const rows = buildBookMix([{ accountRegistry: { a: {} } }]);

    expect(rows[0].type).toBe('Unclassified');
  });
});

describe('buildFlagAging', () => {
  const camProfiles = [
    { id: 'cam-a', name: 'Ana', clientIds: ['c1'] },
    { id: 'cam-b', name: 'Beto', clientIds: ['c2'] },
  ];
  const clients = [
    { id: 'c1', dailyImports: [
      { date: '2026-07-27', flags: [{ status: 'Open' }, { status: 'Open' }, { status: 'Open' }, { status: 'Open' }, { status: 'Open' }] },
    ] },
    { id: 'c2', dailyImports: [
      { date: '2026-07-13', flags: [{ status: 'Open' }, { status: 'Open' }] },
    ] },
  ];

  it('ranks by the oldest open flag, not by how many there are', () => {
    // Five flags caught this morning is a working CAM. Two sitting for a
    // fortnight is the problem, and a straight count inverts that.
    const rows = buildFlagAging(clients, camProfiles, '2026-07-27');

    expect(rows[0].camName).toBe('Beto');
    expect(rows[0].total).toBe(2);
    expect(rows[0].oldestDays).toBe(14);
    expect(rows[1].camName).toBe('Ana');
    expect(rows[1].total).toBe(5);
  });

  it('buckets by age', () => {
    const rows = buildFlagAging(clients, camProfiles, '2026-07-27');

    expect(rows[0].buckets.rotten).toBe(2);
    expect(rows[1].buckets.today).toBe(5);
  });

  it('counts only open flags', () => {
    const resolved = [{ id: 'c1', dailyImports: [{
      date: '2026-07-27',
      flags: [{ status: 'Resolved' }, { status: 'Acknowledged' }, { status: 'Open' }],
    }] }];

    expect(buildFlagAging(resolved, camProfiles, '2026-07-27')[0].total).toBe(1);
  });

  it('attributes a client with no CAM to Unassigned rather than dropping it', () => {
    const orphan = [{ id: 'nobody', dailyImports: [{ date: '2026-07-27', flags: [{ status: 'Open' }] }] }];
    const rows = buildFlagAging(orphan, camProfiles, '2026-07-27');

    expect(rows[0].camName).toBe('Unassigned');
    expect(rows[0].total).toBe(1);
  });

  it('ignores flags dated after the day being viewed', () => {
    // The manager view can be scoped to a past date; a flag from later has not
    // happened yet from that vantage point.
    const future = [{ id: 'c1', dailyImports: [{ date: '2026-07-30', flags: [{ status: 'Open' }] }] }];

    expect(buildFlagAging(future, camProfiles, '2026-07-27')).toEqual([]);
  });
});

describe('daysBetween', () => {
  it('counts whole days and answers null for junk', () => {
    expect(daysBetween('2026-07-20', '2026-07-27')).toBe(7);
    expect(daysBetween('2026-07-27', '2026-07-27')).toBe(0);
    expect(daysBetween('not-a-date', '2026-07-27')).toBeNull();
  });

  it('is not thrown off by a daylight saving transition', () => {
    // 2026-03-08 is the US spring-forward. A local-time subtraction would give
    // 6.958 days here and round to the wrong side on some machines.
    expect(daysBetween('2026-03-06', '2026-03-13')).toBe(7);
  });
});
