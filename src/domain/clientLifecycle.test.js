import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHURN_REASONS,
  CHURN_REASON_UNRECORDED,
  CLIENT_STAGES,
  CLIENT_STAGE_DEFAULT,
  CLIENT_STAGE_INACTIVE,
  CLIENT_STAGE_OTHER,
  buildChurnDetail,
  buildChurnRetention,
  buildClientLifecycle,
  buildLifecycleRollup,
  churnReasonLabel,
  clientAlgoUsage,
  clientCashMovement,
  clientChurnRecord,
  clientStartDate,
  isChurnedClient,
  partitionSidebarClients,
  pipelineColumns,
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

/* ── The churn number, opened ─────────────────────────────────────────────── */

// The desk manager's three instructions about this panel, each pinned by the
// case that would break it:
//
//   1. clicking a churn number must reach the clients it is made of;
//   2. the detail must say which CAM and when, and filter by both;
//   3. a reason is recorded at classification, from a list, and a client who
//      was never asked keeps NO reason — "absent is a real state and the panel
//      must show it as such, not as 'Other'".
//
// Synthetic fixtures, so CI pins all of it. The same guards run against the real
// book in clientLifecycle.book.test.js, which is gated and therefore does not.

// A churned client carries `churn` only when something was recorded. A client
// marked Inactive before step 39 has no such key at all, which is the shape the
// "absent stays absent" cases below stand on.
const churned = (id, { reason, note, at, name } = {}) => client({
  id,
  name: name || id,
  profile: { stage: 'Inactive', startDate: '2026-01-10' },
  ...(reason || note || at ? { churn: { reason, note, at } } : {}),
});

describe('clientChurnRecord', () => {
  it('reports a recorded reason as recorded, with its label and note', () => {
    const record = clientChurnRecord(churned('a', {
      reason: 'cost', note: 'Wanted a cheaper stack.', at: '2026-06-02',
    }));
    expect(record).toEqual({
      recorded: true,
      reasonCode: 'cost',
      reasonLabel: 'Cost of the service',
      reasonNote: 'Wanted a cheaper stack.',
      churnedAt: '2026-06-02',
    });
  });

  it('reports no reason as unrecorded, and never as Other', () => {
    // THE assertion of this block, and the manager's instruction word for word.
    // 'other' is an option a CAM can choose, meaning "none of these fit".
    // Nobody having been asked is a different fact, and the desk should be able
    // to count it and watch it fall.
    const record = clientChurnRecord(churned('b'));
    expect(record.recorded).toBe(false);
    expect(record.reasonCode).toBe(CHURN_REASON_UNRECORDED);
    expect(record.reasonCode).not.toBe('other');
    expect(record.reasonLabel).toBe('Not recorded');
    expect(record.reasonLabel).not.toBe('Other');
    expect(record.churnedAt).toBe('');
  });

  it('keeps an unknown stored code as itself rather than folding it into Other', () => {
    // A row written by a hand-run UPDATE, or by a build older than a list
    // change. Printing it as one of the seven would invent an agreement with a
    // CAM who never gave that answer.
    expect(churnReasonLabel('left-for-mars')).toBe('left-for-mars');
    expect(clientChurnRecord(churned('c', { reason: 'left-for-mars' })).recorded).toBe(true);
  });

  it('reads churn from client.churn and not from the profile', () => {
    // Not cosmetic. The profile object is re-sent whole by every edit of the
    // contact card, so a churn field living there would be written back by
    // somebody correcting a phone number — and on a database without step 39
    // that turns every profile save into a failed write instead of only the
    // classification. A churn value parked on the profile must do nothing.
    // Spelled with the SAME keys clientChurnRecord reads, which is the whole
    // point: a decoy that says `churnReason` instead of `reason` is satisfied by
    // a fallback of `client.churn || client.profile`, and that fallback is
    // exactly the shortcut this rule forbids.
    const decoy = client({
      profile: { stage: 'Inactive', reason: 'cost', note: 'Wanted a cheaper stack.', at: '2026-06-02' },
    });
    expect(clientChurnRecord(decoy).recorded).toBe(false);
    expect(clientChurnRecord(decoy).reasonNote).toBe('');
    expect(clientChurnRecord(decoy).churnedAt).toBe('');
  });

  it('ignores a churn date that is not a date', () => {
    expect(clientChurnRecord(churned('d', { at: 'last summer' })).churnedAt).toBe('');
  });
});

describe('CHURN_REASONS', () => {
  it('is a short list of stable codes with distinct labels', () => {
    // Short is the requirement: a list nobody reads to the end is free text with
    // extra clicks. Codes are what gets stored, so the wording can be rewritten
    // without rewriting rows.
    expect(CHURN_REASONS.length).toBeLessThanOrEqual(8);
    expect(new Set(CHURN_REASONS.map((r) => r.code)).size).toBe(CHURN_REASONS.length);
    expect(new Set(CHURN_REASONS.map((r) => r.label)).size).toBe(CHURN_REASONS.length);
    for (const reason of CHURN_REASONS) {
      expect(reason.code).toMatch(/^[a-z][a-z-]*$/);
      expect(reason.label.length).toBeGreaterThan(0);
    }
  });

  it('does not offer the unrecorded bucket as something a CAM can choose', () => {
    // It is observed, never selected. Offering it would give a CAM a way to
    // record "I decline to say", which is the reason-less row wearing a badge.
    expect(CHURN_REASONS.map((r) => r.code)).not.toContain(CHURN_REASON_UNRECORDED);
  });
});

describe('buildChurnRetention rows', () => {
  it('carries what the drill-down needs on every row', () => {
    const rows = buildChurnRetention(
      [churned('b', { name: 'Bea', reason: 'cost', at: '2026-06-02' })],
      { camNameByClientId: { b: 'Oakley Ash' } },
    ).churnedClients;
    expect(rows[0]).toMatchObject({
      clientId: 'b',
      clientName: 'Bea',
      camName: 'Oakley Ash',
      startedAt: '2026-01-10',
      reasonCode: 'cost',
      reasonLabel: 'Cost of the service',
      churnedAt: '2026-06-02',
    });
  });

  it('leaves attribution empty rather than guessing it', () => {
    // Same rule as DeviationAlertList. A CAM reading his own book knows whose
    // client it is; an unassigned client on the manager's view gets nothing
    // rather than "Unassigned", which the roster already reports in red.
    const noMap = buildChurnRetention([churned('b')]).churnedClients;
    expect(noMap[0].camName).toBe('');
    const wrongMap = buildChurnRetention([churned('b')], {
      camNameByClientId: { someone_else: 'Reese Glen' },
    }).churnedClients;
    expect(wrongMap[0].camName).toBe('');
  });

  it('changes no count when the CAM map is passed', () => {
    const book = [churned('b'), client({ id: 'a' })];
    const without = buildChurnRetention(book);
    const with_ = buildChurnRetention(book, { camNameByClientId: { b: 'Oakley Ash' } });
    expect(with_.churned).toBe(without.churned);
    expect(with_.retentionRate).toBe(without.retentionRate);
    expect(buildLifecycleRollup(book, { camNameByClientId: { b: 'Oakley Ash' } }).churned)
      .toBe(buildLifecycleRollup(book).churned);
  });

  it('carries the map through the roll-up, which is how the panel is fed', () => {
    // The manager's screen never calls buildChurnRetention: it renders a
    // LifecycleRollupPanel over buildLifecycleRollup, which spreads this in. The
    // map is threaded through three functions to reach one column, and dropped
    // at any of them the column empties with every count still correct — so it
    // is pinned at each hop rather than only where it is built.
    const book = [churned('b', { name: 'Bea' }), client({ id: 'a' })];
    const rollup = buildLifecycleRollup(book, { camNameByClientId: { b: 'Oakley Ash' } });
    expect(rollup.churnedClients.map((row) => row.camName)).toEqual(['Oakley Ash']);
    expect(buildChurnDetail(rollup.churnedClients).cams).toEqual(['Oakley Ash']);
    // And withheld when it is withheld, so a CAM's own page draws no column.
    expect(buildLifecycleRollup(book).churnedClients.map((row) => row.camName)).toEqual(['']);
  });
});

describe('buildChurnDetail', () => {
  const rows = () => buildChurnRetention([
    churned('b1', { name: 'Bea', reason: 'cost', at: '2026-06-02' }),
    churned('b2', { name: 'Cal', reason: 'cost', at: '2026-07-20' }),
    churned('b3', { name: 'Dee', reason: 'unresponsive', at: '2026-07-02' }),
    churned('b4', { name: 'Eli' }),
  ], {
    camNameByClientId: { b1: 'Oakley Ash', b2: 'Oakley Ash', b3: 'Reese Glen', b4: 'Reese Glen' },
  }).churnedClients;

  it('returns every churned client when nothing is filtered', () => {
    const detail = buildChurnDetail(rows());
    expect(detail.rows).toHaveLength(4);
    expect(detail.total).toBe(4);
    expect(detail.scoped).toBe(4);
    expect(detail.undatedHidden).toBe(0);
  });

  it('sorts newest departure first and puts the undated last', () => {
    // A client whose departure was never dated is not filed as "left longest
    // ago", and — the half this actually catches — not filed as the freshest
    // news on the desk either. Both would be claims nobody made.
    expect(buildChurnDetail(rows()).rows.map((r) => r.clientName))
      .toEqual(['Cal', 'Dee', 'Bea', 'Eli']);
  });

  it('filters by CAM', () => {
    const detail = buildChurnDetail(rows(), { cam: 'Oakley Ash' });
    expect(detail.rows.map((r) => r.clientName)).toEqual(['Cal', 'Bea']);
    expect(detail.total).toBe(4);
    expect(detail.scoped).toBe(2);
  });

  it('filters by churn date, inclusive at both ends', () => {
    expect(buildChurnDetail(rows(), { from: '2026-07-02', to: '2026-07-20' }).rows.map((r) => r.clientName))
      .toEqual(['Cal', 'Dee']);
    expect(buildChurnDetail(rows(), { from: '2026-07-20' }).rows.map((r) => r.clientName))
      .toEqual(['Cal']);
    expect(buildChurnDetail(rows(), { to: '2026-06-02' }).rows.map((r) => r.clientName))
      .toEqual(['Bea']);
  });

  it('filters by reason, including by the unrecorded bucket', () => {
    expect(buildChurnDetail(rows(), { reason: 'cost' }).rows.map((r) => r.clientName))
      .toEqual(['Cal', 'Bea']);
    // "Show me the ones nobody explained" is a question the desk needs to be
    // able to ask, which is why absent gets a bucket rather than a blank.
    expect(buildChurnDetail(rows(), { reason: CHURN_REASON_UNRECORDED }).rows.map((r) => r.clientName))
      .toEqual(['Eli']);
  });

  it('combines the CAM and date filters rather than letting one win', () => {
    const detail = buildChurnDetail(rows(), { cam: 'Oakley Ash', from: '2026-07-01' });
    expect(detail.rows.map((r) => r.clientName)).toEqual(['Cal']);
  });

  it('counts a client with no churn date out loud instead of dropping it silently', () => {
    // A range cannot be satisfied by a row with no date, so Eli leaves the list
    // the moment a date is set. Shrinking the list around him with nothing said
    // is how a manager concludes the panel is broken — which is the complaint
    // this whole change answers.
    const detail = buildChurnDetail(rows(), { from: '2026-01-01' });
    expect(detail.rows.map((r) => r.clientName)).toEqual(['Cal', 'Dee', 'Bea']);
    expect(detail.undatedHidden).toBe(1);
    expect(detail.dateFiltered).toBe(true);
    // And it is not reported when no range is on, because nothing is hidden.
    expect(buildChurnDetail(rows()).undatedHidden).toBe(0);
  });

  it('counts the reasons over the CAM/date scope but not over the reason filter', () => {
    // The breakdown is a legend and a control at once: each option says how many
    // rows picking it would leave. Counting it AFTER the reason filter would
    // make every option read as the whole list, which is useless as a legend.
    const all = buildChurnDetail(rows());
    expect(all.reasons).toEqual([
      { code: 'cost', label: 'Cost of the service', count: 2 },
      { code: CHURN_REASON_UNRECORDED, label: 'Not recorded', count: 1 },
      { code: 'unresponsive', label: 'Stopped responding', count: 1 },
    ]);
    const picked = buildChurnDetail(rows(), { reason: 'cost' });
    expect(picked.reasons).toEqual(all.reasons);
    expect(picked.rows).toHaveLength(2);

    const scoped = buildChurnDetail(rows(), { cam: 'Reese Glen' });
    expect(scoped.reasons).toEqual([
      { code: CHURN_REASON_UNRECORDED, label: 'Not recorded', count: 1 },
      { code: 'unresponsive', label: 'Stopped responding', count: 1 },
    ]);
  });

  it('offers only the CAMs the rows actually carry', () => {
    expect(buildChurnDetail(rows()).cams).toEqual(['Oakley Ash', 'Reese Glen']);
    // With no attribution there is nothing to filter by, which is what tells the
    // CAM's own page not to draw a column of his own name.
    const bare = buildChurnRetention([churned('b1')]).churnedClients;
    expect(buildChurnDetail(bare).cams).toEqual([]);
  });

  it('never mutates the rows it was handed', () => {
    // It sorts, and the array it sorts must not be the caller's — that array is
    // the rollup's own churnedClients, reordered on every render otherwise.
    //
    // Honest about what this pins: today the two filters inside already hand the
    // sort a fresh array, so no single-line change makes this fail and the
    // `.slice()` beside the sort is belt and braces. It is a contract test, not
    // a mutation-checked guard, and it is the thing that starts failing the day
    // somebody short-circuits a filter to return `rows` itself.
    const source = rows();
    const order = source.map((r) => r.clientId);
    buildChurnDetail(source, { from: '2026-01-01' });
    buildChurnDetail(source);
    expect(source.map((r) => r.clientId)).toEqual(order);
  });

  it('survives no rows and junk filters', () => {
    expect(buildChurnDetail([]).rows).toEqual([]);
    expect(buildChurnDetail(undefined).total).toBe(0);
    // A half-typed date from an <input type="date"> is not a range.
    expect(buildChurnDetail(rows(), { from: '2026-0' }).rows).toHaveLength(4);
    expect(buildChurnDetail(rows(), { from: '2026-0' }).dateFiltered).toBe(false);
  });
});

describe('one definition of churned', () => {
  const SOURCE = readFileSync(new URL('./clientLifecycle.js', import.meta.url), 'utf8');

  it('compares a stage to Inactive in exactly one place', () => {
    // The sidebar's Former clients section, the retention rate and this
    // drill-down are all the same set, and the way they stop being the same set
    // is a second copy of `stage === 'Inactive'` somewhere. isChurnedClient is
    // the only one; CLIENT_STAGE_INACTIVE is the only literal.
    const literals = SOURCE.split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .filter((line) => line.includes("'Inactive'"));
    expect(literals).toHaveLength(1);
    expect(literals[0]).toContain('export const CLIENT_STAGE_INACTIVE');
    expect((SOURCE.match(/CLIENT_STAGE_INACTIVE/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('routes the drill-down, the rollup and the sidebar through it', () => {
    const book = [
      churned('gone', { reason: 'cost', at: '2026-06-02' }),
      client({ id: 'here' }),
    ];
    const rollup = buildLifecycleRollup(book);
    expect(rollup.churned).toBe(1);
    expect(partitionSidebarClients(book).former.map((c) => c.id)).toEqual(['gone']);
    expect(buildChurnDetail(rollup.churnedClients).rows.map((r) => r.clientId)).toEqual(['gone']);
    expect(buildClientLifecycle(book[0]).churn.reasonCode).toBe('cost');
  });
});

describe('the pipeline board’s lanes', () => {
  const at = (id, stage) => ({ ...client({ id }), profile: { stage } });

  it('gives every known stage a lane, empty or not', () => {
    // An empty "At Risk" column is information, and a board whose columns come
    // and go with the data cannot be read at a glance.
    const { columns } = pipelineColumns([at('a', 'Active')]);
    expect(columns.map((column) => column.stage)).toEqual(CLIENT_STAGES);
    expect(columns.every((column) => column.known)).toBe(true);
  });

  it('places every client in exactly one lane', () => {
    const book = [at('a', 'Active'), at('b', 'Paused'), at('c', 'Active')];
    const { columns, placed } = pipelineColumns(book);
    expect(placed).toBe(book.length);
    const ids = columns.flatMap((column) => column.clients.map((entry) => entry.id));
    expect(ids.slice().sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('treats a client with no stage as Active, the same as everything else does', () => {
    const { columns } = pipelineColumns([{ ...client({ id: 'a' }), profile: {} }]);
    const active = columns.find((column) => column.stage === CLIENT_STAGE_DEFAULT);
    expect(active.clients.map((entry) => entry.id)).toEqual(['a']);
  });

  it('gives an unrecognised stage a lane instead of dropping the client', () => {
    // THIS IS THE POINT OF THE FUNCTION. The board used to render a column per
    // name in a private list of five and bucket into the same list, so a client
    // at any other stage got a bucket that was never rendered — gone from the
    // board, with no count anywhere disagreeing. Today's book is 95 Active and 1
    // Paused, so nothing on it can show this.
    const book = [at('a', 'Active'), at('b', 'Dormant'), at('c', 'Trial')];
    const { columns, placed, unknown } = pipelineColumns(book);

    expect(placed).toBe(3);
    expect(unknown).toBe(2);
    const other = columns.at(-1);
    expect(other.stage).toBe(CLIENT_STAGE_OTHER);
    expect(other.known).toBe(false);
    expect(other.clients.map((entry) => entry.id)).toEqual(['b', 'c']);
  });

  it('adds no Other lane when there is nobody in it', () => {
    const { columns, unknown } = pipelineColumns([at('a', 'Active')]);
    expect(unknown).toBe(0);
    expect(columns.map((column) => column.stage)).not.toContain(CLIENT_STAGE_OTHER);
  });

  it('reconciles the total, the lanes and the roster to the same number', () => {
    // The board prints `placed` against the client count on the same page, so
    // the three have to agree: the sum of the lanes, the total returned, and the
    // book that went in. They agree here because nobody is dropped — swapping
    // this for `clients.length` alone is an equivalent change today, and it stops
    // being one the moment a lane is removed, which is why the lane check above
    // and this one are both named.
    const book = [at('a', 'Active'), at('b', 'Nonsense'), at('c', 'Paused')];
    const { columns, placed, unknown } = pipelineColumns(book);
    const inLanes = columns.reduce((sum, column) => sum + column.clients.length, 0);
    expect(placed).toBe(inLanes);
    expect(placed).toBe(book.length);
    expect(unknown).toBe(columns.find((column) => !column.known).clients.length);
  });

  it('holds the stages in the order the desk works them', () => {
    expect(CLIENT_STAGES).toEqual(['Onboarding', 'Active', 'At Risk', 'Paused', 'Inactive']);
    expect(CLIENT_STAGES).toContain(CLIENT_STAGE_DEFAULT);
    expect(CLIENT_STAGES.at(-1)).toBe(CLIENT_STAGE_INACTIVE);
  });
});

describe('one list of client stages', () => {
  const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

  it('holds no second copy of the list, in either shape it took', () => {
    // Three copies once: the Client stage selector wrote <option> elements, the
    // "Add new client" form held an array literal, and the pipeline board had
    // its own STAGES. Only the board could lose a client if they drifted, and
    // losing one is silent.
    //
    // The shapes are checked, and only against the three names that mean
    // nothing else in App.jsx. "Active" and "Inactive" are also a USER status
    // and an account status, "At Risk" is also a health-score label; a name
    // banned outright would be a rule about the wrong thing. Onboarding, At Risk
    // and Paused are enough — a stage list cannot be rebuilt without them.
    expect(APP).not.toMatch(/<option>(Onboarding|At Risk|Paused)<\/option>/);
    for (const stage of ['"Onboarding",', '"At Risk",', '"Paused",']) {
      expect(APP).not.toContain(stage);
    }
    // Both selectors read the one list.
    expect((APP.match(/CLIENT_STAGES\.map/g) || []).length).toBe(2);
    // And the default a new client starts at is named, not typed.
    expect(APP).toContain('stage: CLIENT_STAGE_NEW');
  });

  it('buckets the board through pipelineColumns rather than inline', () => {
    expect(APP).toContain('pipelineColumns(clients)');
  });
});
