import { describe, expect, it } from 'vitest';
import {
  buildChurnRetention,
  buildClientLifecycle,
  buildLifecycleRollup,
  clientAlgoUsage,
  clientCashMovement,
  clientStartDate,
  isChurnedClient,
} from './clientLifecycle';

function client(overrides = {}) {
  return {
    id: 'c1',
    name: 'Todd',
    profile: { stage: 'Active', startDate: '2026-01-10' },
    accountRegistry: {},
    dailyImports: [],
    ...overrides,
  };
}

describe('isChurnedClient', () => {
  it('is churn only when the stage was manually set to Inactive', () => {
    expect(isChurnedClient(client({ profile: { stage: 'Inactive' } }))).toBe(true);
    expect(isChurnedClient(client({ profile: { stage: 'Active' } }))).toBe(false);
    expect(isChurnedClient(client({ profile: { stage: 'At Risk' } }))).toBe(false);
  });

  it('does not treat a client with no closes as churned', () => {
    expect(isChurnedClient(client({ dailyImports: [] }))).toBe(false);
  });
});

describe('clientStartDate', () => {
  it('uses the recorded start date', () => {
    expect(clientStartDate(client())).toBe('2026-01-10');
  });

  it('falls back to the earliest account or close when there is no start date', () => {
    const c = client({
      profile: { stage: 'Active' },
      accountRegistry: { A1: { accountName: 'A1', dateAdded: '2026-02-01' } },
      dailyImports: [{ date: '2026-01-20', snapshots: [], strategies: [] }],
    });
    expect(clientStartDate(c)).toBe('2026-01-20');
  });
});

describe('buildClientLifecycle', () => {
  const c = client({
    accountRegistry: {
      EV1: {
        accountName: 'EV1', alias: 'Eval 1', accountType: 'Evaluation - Standard',
        connection: 'BlueSky', dateAdded: '2026-01-10', dateFunded: '2026-01-30', startBalance: 50000,
      },
      EV2: {
        accountName: 'EV2', alias: 'Eval 2', accountType: 'Evaluation - Standard',
        connection: 'Tradeify', dateAdded: '2026-01-10', dateFailed: '2026-01-25',
      },
      FN1: {
        accountName: 'FN1', alias: 'Funded 1', accountType: 'Funded', connection: 'BlueSky',
        dateAdded: '2026-01-30', dateFunded: '2026-01-30', startBalance: 50000,
        payoutHistory: [{ date: '2026-03-01', amount: 2000 }],
      },
      CA1: { accountName: 'CA1', alias: 'Cash 1', accountType: 'Cash - IRA' },
    },
    dailyImports: [
      {
        date: '2026-03-01',
        snapshots: [{ accountName: 'CA1', accountBalance: 15000, grossRealizedPnl: 250 }],
        strategies: [{ accountName: 'FN1', strategyFamily: 'URGO' }],
      },
    ],
  });

  const lifecycle = buildClientLifecycle(c, { camName: 'Peter' });

  it('counts evaluations, passes and failures', () => {
    expect(lifecycle.evaluationCount).toBe(3); // 2 evals + funded account carrying a dateFunded
    expect(lifecycle.passedCount).toBe(2);
    expect(lifecycle.failedCount).toBe(1);
  });

  it('measures how long an evaluation took to pass', () => {
    expect(lifecycle.avgDaysToPass).toBe(10); // EV1 20 days, FN1 0 days
  });

  it('groups funded accounts by prop firm', () => {
    const blueSky = lifecycle.propFirms.find((f) => f.firm === 'BlueSky');
    expect(blueSky.accounts).toBe(2);
  });

  it('totals payouts and time to first payout', () => {
    expect(lifecycle.payoutCount).toBe(1);
    expect(lifecycle.payoutTotal).toBe(2000);
    expect(lifecycle.avgDaysToFirstPayout).toBe(30);
  });

  it('tracks cash accounts separately from prop accounts', () => {
    expect(lifecycle.cashAccounts).toBe(1);
    expect(lifecycle.cashBalance).toBe(15000);
  });

  it('builds a chronological timeline', () => {
    const dates = lifecycle.events.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(lifecycle.events.some((e) => e.kind === 'payout')).toBe(true);
    expect(lifecycle.events.some((e) => e.kind === 'failed')).toBe(true);
  });

  it('carries the managing CAM', () => {
    expect(lifecycle.camName).toBe('Peter');
  });
});

describe('clientAlgoUsage / clientCashMovement', () => {
  it('ranks algos by how many account-days they ran', () => {
    const c = client({
      dailyImports: [
        { date: '2026-03-01', strategies: [{ accountName: 'A', strategyFamily: 'URGO' }, { accountName: 'B', strategyFamily: 'RBO' }] },
        { date: '2026-03-02', strategies: [{ accountName: 'A', strategyFamily: 'URGO' }] },
      ],
    });
    expect(clientAlgoUsage(c)[0]).toMatchObject({ family: 'URGO', days: 2, accounts: 1 });
  });

  it('only emits cash points for closes that carried a cash account', () => {
    const c = client({
      accountRegistry: { CA1: { accountName: 'CA1', accountType: 'Cash - Straight' }, F1: { accountName: 'F1', accountType: 'Funded' } },
      dailyImports: [
        { date: '2026-03-01', snapshots: [{ accountName: 'F1', accountBalance: 50000 }] },
        { date: '2026-03-02', snapshots: [{ accountName: 'CA1', accountBalance: 9000, grossRealizedPnl: -100 }] },
      ],
    });
    expect(clientCashMovement(c)).toEqual([{ date: '2026-03-02', balance: 9000, realized: -100 }]);
  });

  it('treats the legacy Cash type as cash', () => {
    const c = client({
      accountRegistry: { CA1: { accountName: 'CA1', accountType: 'Cash' } },
      dailyImports: [{ date: '2026-03-02', snapshots: [{ accountName: 'CA1', accountBalance: 500 }] }],
    });
    expect(clientCashMovement(c)).toHaveLength(1);
  });
});

describe('buildChurnRetention', () => {
  it('counts churn from manually marked clients only', () => {
    const clients = [
      client({ id: 'a', profile: { stage: 'Active' } }),
      client({ id: 'b', profile: { stage: 'Inactive' } }),
      client({ id: 'c', profile: { stage: 'Paused' } }),
      client({ id: 'd', profile: { stage: 'Inactive' } }),
    ];
    const result = buildChurnRetention(clients);
    expect(result.total).toBe(4);
    expect(result.churned).toBe(2);
    expect(result.active).toBe(2);
    expect(result.churnRate).toBe(0.5);
    expect(result.retentionRate).toBe(0.5);
    expect(result.churnedClients.map((c) => c.clientId)).toEqual(['b', 'd']);
  });

  it('handles an empty book without dividing by zero', () => {
    expect(buildChurnRetention([])).toMatchObject({ total: 0, churnRate: 0, retentionRate: 0 });
  });
});

describe('buildLifecycleRollup', () => {
  it('aggregates accounts, pass rate and churn across clients', () => {
    const clients = [
      client({
        id: 'a',
        accountRegistry: { E: { accountName: 'E', accountType: 'Evaluation - Standard', dateAdded: '2026-01-01', dateFunded: '2026-01-11' } },
      }),
      client({ id: 'b', profile: { stage: 'Inactive' }, accountRegistry: { E2: { accountName: 'E2', accountType: 'Evaluation - Standard', dateAdded: '2026-01-01' } } }),
    ];
    const rollup = buildLifecycleRollup(clients);
    expect(rollup.clients).toBe(2);
    expect(rollup.totalAccounts).toBe(2);
    expect(rollup.passedCount).toBe(1);
    expect(rollup.passRate).toBe(0.5);
    expect(rollup.churned).toBe(1);
    expect(rollup.retentionRate).toBe(0.5);
  });
});
