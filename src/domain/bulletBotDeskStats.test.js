import { describe, it, expect, vi } from 'vitest';
import { buildBulletBotDeskStats, classifyOutcome, resolveDirection, STREAKS_UNAVAILABLE } from './bulletBotDeskStats';

const BULLET = 'Evaluation - Bullet Bot';

// day = { date, balance, direction, realized, traded }
function makeClient({ id, name = id, accounts = [] }) {
  const registry = {};
  for (const account of accounts) {
    registry[account.name] = {
      accountName: account.name,
      accountType: account.type ?? BULLET,
      status: account.status ?? 'Active',
      alias: account.name,
      ...(account.target === undefined ? {} : { targetProfit: account.target }),
      ...(account.startBalance === undefined ? {} : { startBalance: account.startBalance }),
      ...(account.column === undefined ? {} : { bulletBotDirection: account.column }),
    };
  }

  const dates = [...new Set(accounts.flatMap((a) => (a.days || []).map((d) => d.date)))].sort();
  const dailyImports = dates.map((date) => ({
    date,
    accounts: registry,
    executions: accounts.flatMap((a) => ((a.days || []).find((d) => d.date === date)?.traded
      ? [{ accountName: a.name }] : [])),
    snapshots: accounts.flatMap((a) => {
      const day = (a.days || []).find((d) => d.date === date);
      if (!day) return [];
      return [{
        accountName: a.name,
        accountBalance: day.balance,
        strategies: day.direction
          ? [{ strategyFamily: 'Bullet Bot', strategyName: 'Bullet Bot-1.1', direction: day.direction, realized: day.realized ?? 0 }]
          : [],
      }];
    }),
  }));

  return { id, name, accountRegistry: registry, dailyImports };
}

const d = (n) => `2026-07-${String(n).padStart(2, '0')}`;

describe('buildBulletBotDeskStats — direction', () => {
  const clients = [makeClient({
    id: 'c1',
    name: 'Client One',
    accounts: [
      { name: 'L1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Long' }, { date: d(5), balance: 53500, direction: 'Long' }] },
      { name: 'S1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Short' }] },
      { name: 'X1', target: 53000, days: [{ date: d(1), balance: 50000 }] },
      { name: 'A1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Long' }, { date: d(2), balance: 50100, direction: 'Short' }] },
    ],
  })];

  it('keeps unknown and ambiguous as buckets instead of dropping them', () => {
    const stats = buildBulletBotDeskStats(clients);
    expect(stats.direction.long.accounts).toBe(1);
    expect(stats.direction.short.accounts).toBe(1);
    expect(stats.direction.unknown.accounts).toBe(1);
    expect(stats.direction.ambiguous.accounts).toBe(1);
    const sum = ['long', 'short', 'unknown', 'ambiguous']
      .reduce((total, key) => total + stats.direction[key].accounts, 0);
    expect(sum).toBe(stats.direction.overall.accounts);
  });

  it('reports an account running both directions as Ambiguous, not as whichever came first', () => {
    expect(resolveDirection({ directionsSeen: ['Long', 'Short'] })).toBe('Ambiguous');
    expect(resolveDirection({ directionsSeen: ['Short'] })).toBe('Short');
  });

  it('falls back to the bullet_bot_direction column only when no strategy row carries one', () => {
    expect(resolveDirection({ directionsSeen: [], directionColumn: 'Short' })).toBe('Short');
    // The column loses: it disagrees with the strategy rows on 2 of the 11
    // accounts that have it on the real book.
    expect(resolveDirection({ directionsSeen: ['Long'], directionColumn: 'Short' })).toBe('Long');
    expect(resolveDirection({ directionsSeen: [], directionColumn: '' })).toBe('Unknown');
  });
});

// Every direction value must land in a bucket. An unmapped one used to reach
// addToBucket as buckets[undefined] and throw a TypeError, which took the whole
// desk panel down rather than mislabelling a single account.
describe('buildBulletBotDeskStats — unmapped directions', () => {
  it("puts a strategy row NinjaTrader wrote as 'Both' in the ambiguous bucket", () => {
    // 'Both' is real: 60 strategy_snapshots rows carry it today, all from
    // non-Bullet-Bot families, so resolveDirection never returns it on the
    // current book. One Bullet Bot row in a future import is all it takes.
    const clients = [makeClient({
      id: 'c1',
      name: 'Client One',
      accounts: [
        { name: 'BOTH1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Both' }] },
        { name: 'L1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Long' }] },
      ],
    })];

    let stats;
    expect(() => { stats = buildBulletBotDeskStats(clients); }).not.toThrow();
    expect(resolveDirection({ directionsSeen: ['Both'] })).toBe('Both');
    // 'Both' says "not one direction", which is what the ambiguous bucket means.
    expect(stats.direction.ambiguous.accounts).toBe(1);
    expect(stats.direction.unknown.accounts).toBe(0);
    expect(stats.direction.long.accounts).toBe(1);
    expect(stats.direction.overall.accounts).toBe(2);
  });

  it('routes a direction the bucket map has never seen into unknown instead of crashing', async () => {
    // Constructed directly, because no input to buildBulletBotAccountRecords can
    // produce a novel direction until normalizeDirection learns a new one — which
    // is precisely how 'Both' arrived. The fallback is the guarantee that the
    // next new spelling costs one mislabelled account, not the panel.
    vi.resetModules();
    vi.doMock('./bulletBotStats', () => ({
      buildBulletBotAccountRecords: () => ([{
        clientId: 'c1',
        clientName: 'Client One',
        accountName: 'NEW1',
        directionsSeen: ['Diagonal'],
        directionColumn: 'Unknown',
        target: 53000,
        targetSource: 'account',
        status: 'Active',
        passed: false,
        censored: false,
        fired: false,
        observedDays: 1,
        daysToPass: null,
      }]),
    }));

    try {
      const { buildBulletBotDeskStats: build } = await import('./bulletBotDeskStats');
      let stats;
      expect(() => { stats = build([{ id: 'c1' }]); }).not.toThrow();
      expect(stats.accounts[0].resolvedDirection).toBe('Diagonal');
      expect(stats.direction.unknown.accounts).toBe(1);
      expect(stats.direction.ambiguous.accounts).toBe(0);
      expect(stats.direction.overall.accounts).toBe(1);
    } finally {
      vi.doUnmock('./bulletBotStats');
      vi.resetModules();
    }
  });
});

describe('buildBulletBotDeskStats — outcomes', () => {
  it('takes failure from the account status, never from having traded', () => {
    const clients = [makeClient({
      id: 'c1',
      accounts: [
        { name: 'T1', target: 53000, status: 'Active', days: [{ date: d(1), balance: 50000, direction: 'Long', realized: 900, traded: true }] },
        { name: 'F1', target: 53000, status: 'Failed', days: [{ date: d(1), balance: 40000, direction: 'Long' }] },
      ],
    })];
    const stats = buildBulletBotDeskStats(clients);
    expect(stats.direction.long.traded).toBe(1);
    expect(stats.direction.long.failed).toBe(1);
    // The traded account is still open. A panel that prints `traded` under the
    // word "fired" says the opposite.
    expect(stats.direction.long.running).toBe(1);
  });

  it('calls a targetless account unscorable and keeps it out of the rate', () => {
    const clients = [makeClient({
      id: 'c1',
      accounts: [
        { name: 'P1', target: 53000, days: [{ date: d(1), balance: 53500, direction: 'Short' }] },
        // No target and a balance nowhere near a standard size: nothing to infer.
        { name: 'U1', days: [{ date: d(1), balance: 8000, direction: 'Short' }] },
      ],
    })];
    const stats = buildBulletBotDeskStats(clients, { minDirectionCohort: 1 });
    expect(stats.direction.short.unscorable).toBe(1);
    expect(stats.direction.short.scorable).toBe(1);
    expect(stats.direction.short.passRate).toBe(1);
    expect(stats.cohort.unscorable).toBe(1);
  });

  it('never returns 0 for a rate it cannot support', () => {
    const clients = [makeClient({
      id: 'c1',
      accounts: [{ name: 'S1', target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Short' }] }],
    })];
    const stats = buildBulletBotDeskStats(clients);
    expect(stats.direction.short.accounts).toBe(1);
    expect(stats.direction.short.passRate).toBeNull();
    expect(stats.direction.short.passed).toBe(0);
  });

  it('classifies in precedence order', () => {
    expect(classifyOutcome({ passed: true, status: 'Failed', target: 53000 })).toBe('passed');
    expect(classifyOutcome({ passed: false, status: 'Failed', target: 0 })).toBe('failed');
    expect(classifyOutcome({ passed: false, status: 'Active', target: 0 })).toBe('unscorable');
    expect(classifyOutcome({ passed: false, status: 'Reserve', target: 53000 })).toBe('reserve');
    expect(classifyOutcome({ passed: false, status: 'Active', target: 53000 })).toBe('running');
  });

  it('counts an account that both reached target and is marked Failed once, and reports the conflict', () => {
    const clients = [makeClient({
      id: 'c1',
      accounts: [{ name: 'C1', target: 53000, status: 'Failed', days: [{ date: d(1), balance: 50000, direction: 'Long' }, { date: d(3), balance: 53200, direction: 'Long' }] }],
    })];
    const stats = buildBulletBotDeskStats(clients);
    expect(stats.direction.overall.passed).toBe(1);
    expect(stats.direction.overall.failed).toBe(0);
    expect(stats.cohort.conflicts).toBe(1);
  });

  it('includes accounts that have a status but never appear in an import', () => {
    const client = makeClient({ id: 'c1', accounts: [{ name: 'GHOST', status: 'Failed', days: [] }] });
    const stats = buildBulletBotDeskStats([client]);
    expect(stats.cohort.accounts).toBe(1);
    expect(stats.cohort.unobserved).toBe(1);
    expect(stats.direction.overall.failed).toBe(1);
  });
});

describe('buildBulletBotDeskStats — inferred targets', () => {
  const clients = [makeClient({
    id: 'c1',
    accounts: [{ name: 'N1', days: [{ date: d(1), balance: 50200, direction: 'Long' }, { date: d(4), balance: 53400, direction: 'Long' }] }],
  })];

  it('scores an account with no target_profit using the standard 50k Bullet Bot plan', () => {
    const stats = buildBulletBotDeskStats(clients, { minDirectionCohort: 1 });
    expect(stats.cohort.inferredTargets).toBe(1);
    expect(stats.direction.long.passed).toBe(1);
    expect(stats.direction.long.scorable).toBe(1);
  });

  it('leaves the account unscorable when inference is switched off', () => {
    const stats = buildBulletBotDeskStats(clients, { inferTargets: false, minDirectionCohort: 1 });
    expect(stats.direction.long.unscorable).toBe(1);
    expect(stats.direction.long.passed).toBe(0);
    expect(stats.direction.long.passRate).toBeNull();
  });
});

describe('buildBulletBotDeskStats — days to pass', () => {
  function passingClient(id, dayOffsets) {
    return makeClient({
      id,
      accounts: dayOffsets.map((offset, index) => ({
        name: `${id}-${index}`,
        target: 53000,
        days: [
          { date: d(1), balance: 50000, direction: 'Short' },
          { date: d(1 + offset), balance: 53500, direction: 'Short' },
        ],
      })),
    });
  }

  it('reports a median with its sample size and the full distribution', () => {
    const stats = buildBulletBotDeskStats([passingClient('c1', [2, 4, 4, 9, 13])], { minDaysSample: 5 });
    expect(stats.daysToPass.n).toBe(5);
    expect(stats.daysToPass.median).toBe(4);
    expect(stats.daysToPass.distribution).toEqual([
      { days: 2, accounts: 1 },
      { days: 4, accounts: 2 },
      { days: 9, accounts: 1 },
      { days: 13, accounts: 1 },
    ]);
    // A mean would read 6.4d here, which no account took.
    expect(stats.daysToPass.mean).toBeUndefined();
  });

  it('excludes accounts already at target on the first day instead of calling them 0 days', () => {
    const censored = makeClient({
      id: 'c2',
      accounts: [{ name: 'INSTANT', target: 53000, days: [{ date: d(1), balance: 53800, direction: 'Short' }] }],
    });
    const stats = buildBulletBotDeskStats([passingClient('c1', [2, 4, 4, 9, 13]), censored], { minDaysSample: 5 });
    expect(stats.direction.overall.passed).toBe(6);
    expect(stats.direction.overall.passedCensored).toBe(1);
    expect(stats.daysToPass.n).toBe(5);
    expect(stats.daysToPass.censored).toBe(1);
    expect(stats.daysToPass.median).toBe(4);
  });

  it('returns null and says why when too few accounts carry both dates', () => {
    const stats = buildBulletBotDeskStats([passingClient('c1', [2, 4])]);
    expect(stats.daysToPass).toBeNull();
    expect(stats.unavailable.daysToPass).toContain('2 accounts');
  });

  it('withholds quartiles under 8 observations', () => {
    const stats = buildBulletBotDeskStats([passingClient('c1', [2, 4, 4, 9, 13])], { minDaysSample: 5 });
    expect(stats.daysToPass.iqr).toBeNull();
    const wider = buildBulletBotDeskStats([passingClient('c1', [1, 2, 3, 4, 5, 6, 7, 8])], { minDaysSample: 5 });
    expect(wider.daysToPass.iqr).toEqual([2.75, 6.25]);
  });
});

describe('buildBulletBotDeskStats — per-client ranking', () => {
  const clients = [
    makeClient({
      id: 'big',
      name: 'Big Book',
      accounts: [
        ...[0, 1, 2, 3].map((i) => ({ name: `B${i}`, target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Short' }, { date: d(3), balance: 53500, direction: 'Short' }] })),
        ...[4, 5, 6, 7, 8, 9].map((i) => ({ name: `B${i}`, target: 53000, days: [{ date: d(1), balance: 50000, direction: 'Short' }] })),
      ],
    }),
    makeClient({
      id: 'tiny',
      name: 'Tiny Book',
      accounts: [0, 1].map((i) => ({ name: `T${i}`, target: 53000, days: [{ date: d(1), balance: 53500, direction: 'Long' }] })),
    }),
    makeClient({
      id: 'burner',
      name: 'Burner',
      accounts: [0, 1, 2, 3, 4].map((i) => ({ name: `F${i}`, target: 53000, status: 'Failed', days: [{ date: d(1), balance: 41000, direction: 'Long' }] })),
    }),
  ];

  it('ranks by count and carries the rate alongside', () => {
    const stats = buildBulletBotDeskStats(clients);
    const [first, second] = stats.ranking.byPasses;
    expect(first.clientName).toBe('Big Book');
    expect(first.passed).toBe(4);
    expect(first.passRate).toBeCloseTo(0.4);
    expect(second.clientName).toBe('Tiny Book');
    expect(second.passed).toBe(2);
  });

  it('withholds the rate for a cohort too small to carry one', () => {
    const stats = buildBulletBotDeskStats(clients);
    const tiny = stats.ranking.byPasses.find((row) => row.clientId === 'tiny');
    // 2 of 2 is two accounts, not a 100% pass rate.
    expect(tiny.scorable).toBe(2);
    expect(tiny.passRate).toBeNull();
  });

  it('ranks failures separately and by status', () => {
    const stats = buildBulletBotDeskStats(clients);
    expect(stats.ranking.byFailures[0].clientName).toBe('Burner');
    expect(stats.ranking.byFailures[0].failed).toBe(5);
    expect(stats.ranking.byFailures[0].failRate).toBe(1);
    expect(stats.ranking.byFailures.some((row) => row.clientId === 'big')).toBe(false);
  });
});

describe('buildBulletBotDeskStats — refusals', () => {
  it('returns null for streaks and says why', () => {
    const stats = buildBulletBotDeskStats([makeClient({
      id: 'c1',
      accounts: [{ name: 'A', target: 53000, status: 'Failed', days: [{ date: d(1), balance: 40000, direction: 'Long' }] }],
    })]);
    expect(stats.streaks).toBeNull();
    expect(stats.unavailable.streaks).toBe(STREAKS_UNAVAILABLE);
    expect(stats.unavailable.streaks).toMatch(/date_failed is set on 1 of 244/);
  });

  it('handles an empty book without throwing', () => {
    expect(() => buildBulletBotDeskStats([])).not.toThrow();
    expect(() => buildBulletBotDeskStats(undefined)).not.toThrow();
    const stats = buildBulletBotDeskStats([]);
    expect(stats.cohort.accounts).toBe(0);
    expect(stats.direction.overall.passRate).toBeNull();
    expect(stats.daysToPass).toBeNull();
  });

  it('ignores accounts that are not Bullet Bot evaluations', () => {
    const stats = buildBulletBotDeskStats([makeClient({
      id: 'c1',
      accounts: [{ name: 'FUNDED', type: 'Funded', target: 107300, days: [{ date: d(1), balance: 110000, direction: 'Long' }] }],
    })]);
    expect(stats.cohort.accounts).toBe(0);
  });
});
