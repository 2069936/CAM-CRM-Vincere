import { describe, expect, it } from 'vitest';
import {
  buildChurnRetention,
  buildClientLifecycle,
  buildLifecycleRollup,
  clientAlgoUsage,
  clientCashMovement,
  clientStartDate,
  isChurnedClient,
  partitionSidebarClients,
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

describe('partitionSidebarClients', () => {
  // The bug this exists for: a client was marked Inactive in the CRM and stayed
  // in the sidebar looking exactly like an active one, because the sidebar never
  // read profile.stage at all.
  const stages = ['Onboarding', 'Active', 'At Risk', 'Paused', 'Inactive'];
  const book = stages.map((stage, i) => client({ id: `c${i}`, name: stage, profile: { stage } }));

  it('moves Inactive out of the working list and leaves the other four in it', () => {
    const { working, former } = partitionSidebarClients(book);
    expect(working.map((c) => c.name)).toEqual(['Onboarding', 'Active', 'At Risk', 'Paused']);
    expect(former.map((c) => c.name)).toEqual(['Inactive']);
  });

  it('keeps At Risk in the working list', () => {
    // Asserted on its own because it is the one that would be tempting to sweep
    // up with the other non-Active stages, and the one where doing so is worst:
    // At Risk means the client needs MORE attention, so a CAM who stops seeing
    // it every morning is the failure this whole split was meant to avoid.
    const { working, former } = partitionSidebarClients([client({ profile: { stage: 'At Risk' } })]);
    expect(working).toHaveLength(1);
    expect(former).toHaveLength(0);
  });

  it('keeps Paused in the working list', () => {
    // A paused client is coming back and still has a restart date to chase. On
    // the real book that is 1 client out of 133 — burying one row saves no
    // scrolling and costs a lookup every time the CAM wonders where they went.
    const { working, former } = partitionSidebarClients([client({ profile: { stage: 'Paused' } })]);
    expect(working).toHaveLength(1);
    expect(former).toHaveLength(0);
  });

  it('treats a missing stage as working, never as former', () => {
    // A client row with no profile at all is a data gap, not a churn signal.
    // Defaulting the other way would delete people from the sidebar for having
    // an unfilled field.
    const { working, former } = partitionSidebarClients([
      { id: 'x', name: 'No profile' },
      client({ profile: {} }),
    ]);
    expect(working).toHaveLength(2);
    expect(former).toHaveLength(0);
  });

  it('agrees with the churn count the retention panel reports', () => {
    // One definition of "former client", not two. If these ever disagree the
    // sidebar is hiding someone the retention rate still counts as active, or
    // the other way round.
    const { former } = partitionSidebarClients(book);
    expect(former).toHaveLength(buildChurnRetention(book).churned);
  });

  it('preserves the order it was given on both sides', () => {
    // The caller has already applied the CAM's manual drag order or the urgency
    // sort. Partitioning must not quietly re-sort either group.
    const ordered = [
      client({ id: 'p1', profile: { stage: 'Active' } }),
      client({ id: 'p2', profile: { stage: 'Inactive' } }),
      client({ id: 'p3', profile: { stage: 'Active' } }),
      client({ id: 'p4', profile: { stage: 'Inactive' } }),
    ];
    const { working, former } = partitionSidebarClients(ordered);
    expect(working.map((c) => c.id)).toEqual(['p1', 'p3']);
    expect(former.map((c) => c.id)).toEqual(['p2', 'p4']);
  });

  it('returns two empty lists for no clients at all', () => {
    expect(partitionSidebarClients([])).toEqual({ working: [], former: [] });
    expect(partitionSidebarClients()).toEqual({ working: [], former: [] });
  });
});
