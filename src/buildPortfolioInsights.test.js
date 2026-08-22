import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPortfolioInsights } from './App';
import { groupInsights } from './domain/insightFeed';

const TODAY = '2026-06-25'; // Thursday

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`)); });
afterEach(() => { vi.useRealTimers(); });

function makeImport(date, pnls, trailingDD = 0) {
  return {
    id: `di-${date}`,
    date,
    accounts: {},
    snapshots: pnls.map(([name, pnl, bal]) => ({
      accountName: name,
      grossRealizedPnl: pnl,
      accountBalance: bal,
      trailingMaxDrawdown: trailingDD,
    })),
    flags: [],
  };
}

// ── Drawdown Velocity ─────────────────────────────────────────────────────────

describe('Drawdown Velocity insight', () => {
  it('fires warning when model-2 buffer depletes ~100/day and will breach in ≤5 days', () => {
    // buffer today = 400, depleting at ~100/day → ~4 days → warning
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', alias: 'Apex' } },
      dailyImports: [
        makeImport('2026-06-18', [['ACC1', -100, 49100]], 900),
        makeImport('2026-06-19', [['ACC1', -100, 49000]], 800),
        makeImport('2026-06-20', [['ACC1', -100, 48900]], 700),
        makeImport('2026-06-23', [['ACC1', -100, 48800]], 600),
        makeImport('2026-06-24', [['ACC1', -100, 48700]], 500),
        makeImport(TODAY,        [['ACC1', -100, 48600]], 400),
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const dv = insights.filter(i => i.type === 'Drawdown Velocity');
    expect(dv.length).toBeGreaterThanOrEqual(1);
    expect(['warning', 'critical']).toContain(dv[0].severity);
  });

  it('does not fire when buffer is growing', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        makeImport('2026-06-20', [['ACC1', 100, 50200]], 500),
        makeImport('2026-06-23', [['ACC1', 100, 50300]], 600),
        makeImport(TODAY,        [['ACC1', 100, 50400]], 700),
      ],
    };
    expect(buildPortfolioInsights([client]).filter(i => i.type === 'Drawdown Velocity')).toHaveLength(0);
  });
});

// ── Payout Opportunity ────────────────────────────────────────────────────────

describe('Payout Opportunity insight', () => {
  it('fires info-green when funded balance reaches target', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [makeImport(TODAY, [['MFF1', 3200, 53200]])],
    };
    const insights = buildPortfolioInsights([client]);
    const po = insights.filter(i => i.type === 'Payout Opportunity');
    expect(po.length).toBeGreaterThanOrEqual(1);
    expect(po[0].severity).toBe('info-green');
  });

  it('fires info (not info-green) when account is near but not at target', () => {
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [makeImport(TODAY, [['MFF1', 2800, 52800]])], // 96% of target
    };
    const insights = buildPortfolioInsights([client]);
    const po = insights.filter(i => i.type === 'Payout Opportunity');
    expect(po.length).toBeGreaterThanOrEqual(1);
    expect(po[0].severity).toBe('info');
  });
});

// ── Strategy Cooling ──────────────────────────────────────────────────────────

describe('Strategy Cooling insight', () => {
  it('fires warning when algo was profitable then turned consistently negative', () => {
    const strat = [{ strategyFamily: 'RBO', strategyName: '0-RBO-1.8', enabled: true }];
    function snap(name, pnl) { return { accountName: name, grossRealizedPnl: pnl, accountBalance: 50000 + pnl, strategies: strat }; }
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        { id: 'd1', date: '2026-06-10', accounts: {}, snapshots: [snap('ACC1', 200)], flags: [] },
        { id: 'd2', date: '2026-06-11', accounts: {}, snapshots: [snap('ACC1', 150)], flags: [] },
        { id: 'd3', date: '2026-06-12', accounts: {}, snapshots: [snap('ACC1', 180)], flags: [] },
        { id: 'd4', date: '2026-06-13', accounts: {}, snapshots: [snap('ACC1', -200)], flags: [] },
        { id: 'd5', date: '2026-06-16', accounts: {}, snapshots: [snap('ACC1', -180)], flags: [] },
        { id: 'd6', date: '2026-06-17', accounts: {}, snapshots: [snap('ACC1', -160)], flags: [] },
        { id: 'd7', date: '2026-06-18', accounts: {}, snapshots: [snap('ACC1', -140)], flags: [] },
        { id: 'd8', date: TODAY,        accounts: {}, snapshots: [snap('ACC1', -120)], flags: [] },
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const sc = insights.filter(i => i.type === 'Strategy Cooling');
    expect(sc.length).toBeGreaterThanOrEqual(1);
    expect(sc[0].severity).toBe('warning');
  });

  it('does not fire when account has fewer than 6 data points', () => {
    const strat = [{ strategyFamily: 'RBO', enabled: true }];
    function snap(name, pnl) { return { accountName: name, grossRealizedPnl: pnl, accountBalance: 50000, strategies: strat }; }
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        { id: 'd1', date: '2026-06-20', accounts: {}, snapshots: [snap('ACC1', -100)], flags: [] },
        { id: 'd2', date: TODAY,        accounts: {}, snapshots: [snap('ACC1', -100)], flags: [] },
      ],
    };
    expect(buildPortfolioInsights([client]).filter(i => i.type === 'Strategy Cooling')).toHaveLength(0);
  });
});

// ── Sort order ────────────────────────────────────────────────────────────────

describe('insight sort order', () => {
  it('returns critical insights before warnings before info', () => {
    // Use payout (info-green) + consistency warning (from >50% best-day ratio) on same client
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [
        { id: 'd1', date: '2026-06-20', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 100, accountBalance: 50100 }], flags: [] },
        { id: 'd2', date: '2026-06-21', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 100, accountBalance: 50200 }], flags: [] },
        { id: 'd3', date: '2026-06-22', accounts: {}, snapshots: [{ accountName: 'MFF1', grossRealizedPnl: 700, accountBalance: 53200 }], flags: [] },
        makeImport(TODAY, [['MFF1', 0, 53200]]),
      ],
    };
    const insights = buildPortfolioInsights([client]);
    const severityOrder = { critical: 0, warning: 1, 'info-green': 2, info: 3 };
    for (let i = 1; i < insights.length; i++) {
      expect(severityOrder[insights[i].severity] ?? 4).toBeGreaterThanOrEqual(severityOrder[insights[i - 1].severity] ?? 4);
    }
  });
});

// ── What every rule has to hand the panel ────────────────────────────────────

describe('every rule states its numbers as facts, not only as prose', () => {
  // The panel lays signals out in a table, one column per fact label, so a rule
  // that emits only a sentence renders as a row of empty cells with the numbers
  // trapped in a title attribute. src/insightFeed.book.test.js checks this over
  // the 134 signals the real book produces, and is dropped on a clone that does
  // not carry it — so the rule is checked here, on fixtures, once per rule.

  const rules = {
    'Drawdown Velocity': () => [{
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', maxDrawdownLimit: 1000 } },
      dailyImports: [
        makeImport('2026-06-18', [['ACC1', -100, 49100]], 600),
        makeImport('2026-06-19', [['ACC1', -100, 49000]], 700),
        makeImport('2026-06-23', [['ACC1', -100, 48800]], 800),
        makeImport(TODAY, [['ACC1', -100, 48600]], 900),
      ],
    }],
    'Consistency Rule': () => [{
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        makeImport('2026-06-20', [['ACC1', 10, 50010]]),
        makeImport('2026-06-23', [['ACC1', 10, 50020]]),
        makeImport(TODAY, [['ACC1', 900, 50920]]),
      ],
    }],
    'Payout Opportunity': () => [{
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' },
      },
      dailyImports: [makeImport(TODAY, [['MFF1', 3200, 53200]])],
    }],
    'Missing Close': () => [{
      id: 'c1', name: 'Pedro',
      accountRegistry: { ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [makeImport('2026-06-10', [['ACC1', 100, 50100]])],
    }],
  };

  for (const [type, book] of Object.entries(rules)) {
    it(`gives every ${type} signal facts and a magnitude`, () => {
      const fired = buildPortfolioInsights(book()).filter((item) => item.type === type);
      expect(fired.length).toBeGreaterThan(0);
      for (const item of fired) {
        expect(Array.isArray(item.facts)).toBe(true);
        expect(item.facts.length).toBeGreaterThan(0);
        for (const fact of item.facts) {
          expect(typeof fact.label).toBe('string');
          expect(fact.label.length).toBeGreaterThan(0);
          // Strings, already formatted by the producer. A raw number here would
          // render as itself with no currency, no unit and no percent sign.
          expect(typeof fact.value).toBe('string');
          expect(fact.value.length).toBeGreaterThan(0);
        }
        // The number the group is ordered by. Missing it does not throw, it just
        // sorts the signal last inside its severity — silently.
        expect(Number.isFinite(item.urgency)).toBe(true);
        // The sentence is kept as well as the facts, never instead of them.
        expect(item.message).toBeTruthy();
      }
    });
  }

  it('states the days since the last close on a Missing Close, which is all that differs', () => {
    // The rule's message is one sentence for every client it fires on. Without
    // the date and the gap, 84 rows on the real book were the same row 84 times.
    const fired = buildPortfolioInsights(rules['Missing Close']()).filter(
      (item) => item.type === 'Missing Close',
    );
    expect(fired).toHaveLength(1);
    expect(fired[0].facts).toEqual([
      { label: 'Last close', value: '2026-06-10' },
      { label: 'Calendar days ago', value: '15', tone: 'bad' },
    ]);
    // 2026-06-10 to 2026-06-25 is 15 days, and the sign matters: a flipped
    // subtraction sorts the client who has been silent longest to the bottom.
    expect(fired[0].urgency).toBe(15);
  });
});

describe('the magnitude points the same way for every rule', () => {
  // `urgency` is "higher is worse", and each rule computes it from a different
  // quantity — days until a buffer breaches, a share of gains, days of silence.
  // Two of those are naturally the wrong way round, so the sign is a decision
  // each rule makes and a decision each rule can get backwards. Getting it
  // backwards does not throw and does not change a count: it puts the account
  // breaching tomorrow at the bottom of a list of twenty-one, under the one
  // breaching next week.

  function velocityClient(id, dailyLoss) {
    // A 1000-tick limit, drawdown growing by `dailyLoss` a day, 400 of buffer
    // left today. Bigger daily loss = sooner breach.
    const dd = (day) => 600 + dailyLoss * day;
    return {
      id, name: id,
      accountRegistry: { [`${id}-A`]: { accountName: `${id}-A`, accountType: 'Funded', status: 'Active', maxDrawdownLimit: 1000 } },
      dailyImports: [
        makeImport('2026-06-18', [[`${id}-A`, -dailyLoss, 49000]], dd(0)),
        makeImport('2026-06-19', [[`${id}-A`, -dailyLoss, 49000]], dd(1)),
        makeImport('2026-06-23', [[`${id}-A`, -dailyLoss, 49000]], dd(2)),
        makeImport(TODAY, [[`${id}-A`, -dailyLoss, 49000]], dd(3)),
      ],
    };
  }

  it('works the account closest to breaching first, not last', () => {
    // 90/day burns the 400 of buffer in one trading day, 60/day in three. Both
    // are inside the rule's 5-day window, so both fire and the pair can be
    // ordered against each other.
    const soon = velocityClient('soon', 90);
    const later = velocityClient('later', 60);
    const insights = buildPortfolioInsights([later, soon]);
    const velocity = insights.filter((item) => item.type === 'Drawdown Velocity');
    expect(velocity).toHaveLength(2);

    const group = groupInsights(velocity).groups[0];
    const projections = group.items.map((item) => -item.urgency);
    expect(projections[0]).toBeLessThan(projections[1]);
    expect(group.items[0].clientName).toBe('soon');
  });

  it('works the client silent longest first, not last', () => {
    const stale = {
      id: 'stale', name: 'stale',
      accountRegistry: { A: { accountName: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [makeImport('2026-05-01', [['A', 10, 50010]])],
    };
    const fresh = {
      id: 'fresh', name: 'fresh',
      accountRegistry: { B: { accountName: 'B', accountType: 'Funded', status: 'Active' } },
      dailyImports: [makeImport('2026-06-22', [['B', 10, 50010]])],
    };
    const missing = buildPortfolioInsights([fresh, stale])
      .filter((item) => item.type === 'Missing Close');
    expect(missing).toHaveLength(2);

    const group = groupInsights(missing).groups[0];
    expect(group.items.map((item) => item.clientName)).toEqual(['stale', 'fresh']);
  });

  it('works the account nearest its payout target first', () => {
    const near = {
      id: 'near', name: 'near',
      accountRegistry: { N: { accountName: 'N', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' } },
      dailyImports: [makeImport(TODAY, [['N', 2900, 52900]])],
    };
    const far = {
      id: 'far', name: 'far',
      accountRegistry: { F: { accountName: 'F', accountType: 'Funded', status: 'Active', targetProfit: 53000, startBalance: 50000, payoutState: 'Not requested' } },
      // Both clear the rule's 90%-of-target threshold, so the ordering is what
      // is being tested and not the firing.
      dailyImports: [makeImport(TODAY, [['F', 2750, 52750]])],
    };
    const payout = buildPortfolioInsights([far, near])
      .filter((item) => item.type === 'Payout Opportunity');
    expect(payout.length).toBeGreaterThanOrEqual(2);

    const group = groupInsights(payout).groups[0];
    const ordered = group.items.map((item) => item.clientName);
    expect(ordered.indexOf('near')).toBeLessThan(ordered.indexOf('far'));
  });
});
