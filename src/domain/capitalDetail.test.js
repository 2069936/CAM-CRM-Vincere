import { describe, expect, it } from 'vitest';
import { MONEY_KINDS, buildCapitalDetail } from './capitalDetail';
import { SEGMENTS } from './operationsSegments';

// A client shaped the way buildCrmStateFromTables produces it: a registry keyed
// by account name and one daily import per close.
function makeClient({ id, name = id, registry = {}, closes = [] }) {
  return {
    id,
    name,
    accountRegistry: registry,
    dailyImports: closes.map(({ date, snapshots }) => ({
      date,
      snapshots: snapshots.map((snapshot) => ({
        accountName: snapshot.account,
        accountBalance: snapshot.balance,
        grossRealizedPnl: snapshot.gross ?? 0,
        weeklyPnl: snapshot.weekly ?? 0,
      })),
    })),
  };
}

const cash = (extra = {}) => ({ accountType: 'Cash', status: 'Active', ...extra });
const funded = (extra = {}) => ({ accountType: 'Funded', status: 'Active', ...extra });

/** A week that reconciles, so the close-level trust gate does not fire. */
function healthyCohort(prefix, count, dates) {
  return Array.from({ length: count }, (unused, index) => makeClient({
    id: `${prefix}${index}`,
    registry: { [`A${index}`]: funded() },
    closes: dates.map((date, step) => ({
      date,
      snapshots: [{ account: `A${index}`, balance: 50000 + step * 100, gross: 100, weekly: step * 100 }],
    })),
  }));
}

describe('buildCapitalDetail — which arithmetic decides a movement', () => {
  it('reconciles a commissioned day instead of calling the commission a movement', () => {
    // The real trap. Account 1071787 on 2026-07-15: gross 307.50, the balance
    // moved 303.74, and the 3.76 difference is one round turn. Under the brief's
    // proposed `balance delta == gross` this fires as a $3.76 money movement, and
    // it would fire on roughly 580 close-pairs on the real book.
    const clients = [
      ...healthyCohort('bulk', 10, ['2026-07-13', '2026-07-14', '2026-07-15']),
      makeClient({
        id: 'c1',
        registry: { '1071787': cash() },
        closes: [
          { date: '2026-07-14', snapshots: [{ account: '1071787', balance: 38981.18, gross: 24.5, weekly: -752.42 }] },
          { date: '2026-07-15', snapshots: [{ account: '1071787', balance: 39284.92, gross: 307.5, weekly: -448.68 }] },
        ],
      }),
    ];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.movement.unexplained).toEqual([]);
    expect(detail.desk.coverage.pairsReconciled).toBe(detail.desk.coverage.pairsCompared);
    const gap = detail.desk.movement.grossToBalanceGap;
    expect(gap.cost.pairs).toBe(1);
    expect(gap.cost.amount).toBe(3.76);
    // No single "commissions paid" number. The four kinds never get summed.
    expect(gap.total).toBeNull();
  });

  it('reads the new week from the accumulator itself when a pair crosses Monday', () => {
    // weekly_pnl restarts on Monday. Comparing Monday's accumulator against
    // Friday's would report the whole of Friday's week as a movement.
    const clients = [
      ...healthyCohort('bulk', 10, ['2026-07-16', '2026-07-17', '2026-07-20']),
      makeClient({
        id: 'c1',
        registry: { A: cash() },
        closes: [
          { date: '2026-07-17', snapshots: [{ account: 'A', balance: 147435.98, gross: -859, weekly: -3972.03 }] },
          { date: '2026-07-20', snapshots: [{ account: 'A', balance: 147725.74, gross: 342, weekly: 289.76 }] },
        ],
      }),
    ];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.movement.unexplained).toEqual([]);
    // Per segment, never netted: `desk.movement.tradingPnl` is null by design.
    expect(detail.desk.movement.tradingPnl).toBeNull();
    expect(detail.desk.movement.tradingPnlBySegment
      .reduce((sum, row) => sum + row.pairs, 0)).toBe(detail.desk.coverage.pairsCompared);
  });

  it('does not compare two closes more than three days apart', () => {
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash() },
      closes: [
        { date: '2026-07-13', snapshots: [{ account: 'A', balance: 52321.4, gross: 0, weekly: 1536.28 }] },
        { date: '2026-07-22', snapshots: [{ account: 'A', balance: 40000, gross: 0, weekly: 0 }] },
      ],
    })];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.movement.unexplained).toEqual([]);
    expect(detail.desk.coverage.pairsSkipped.gap).toBe(1);
    expect(detail.desk.coverage.pairsCompared).toBe(0);
  });
});

describe('buildCapitalDetail — the one movement it will name', () => {
  const consolidation = () => [makeClient({
    id: 'ellis',
    name: 'Ellis Pine',
    registry: { 2837222: cash({ status: 'Inactive' }), 9199785: cash() },
    closes: [
      {
        date: '2026-07-20',
        snapshots: [
          { account: '2837222', balance: 98219.8, gross: 0, weekly: 0 },
          { account: '9199785', balance: 147725.74, gross: 342, weekly: 324.76 },
        ],
      },
      {
        date: '2026-07-21',
        snapshots: [
          { account: '2837222', balance: 0, gross: 0, weekly: 0 },
          { account: '9199785', balance: 247037.22, gross: 1111, weekly: 1416.44 },
        ],
      },
    ],
  })];

  it('names an offsetting same-client pair as a transfer and drops it from unexplained', () => {
    const detail = buildCapitalDetail(consolidation());

    expect(detail.desk.movement.transfers).toHaveLength(1);
    const [transfer] = detail.desk.movement.transfers;
    expect(transfer.amount).toBe(98219.8);
    expect(transfer.date).toBe('2026-07-21');
    expect(transfer.from.accountName).toBe('2837222');
    expect(transfer.to.accountName).toBe('9199785');
    expect(transfer.clientName).toBe('Ellis Pine');
    // Derived, and the field says so — there is no transfer record in the schema.
    expect(transfer.evidence).toBe('offsetting-balances');
    expect(detail.desk.movement.unexplained).toEqual([]);
  });

  it('survives a Monday accumulator of 0 on both sides of the drain', () => {
    // The blanked-accumulator guard must not swallow this. 2837222 sat at
    // weekly 0 on Monday 2026-07-20 and Tuesday 07-21 because it was not
    // trading; a guard keyed on "weekly is 0" instead of "weekly fell to 0
    // mid-week" throws away the only real movement on the book.
    const detail = buildCapitalDetail(consolidation());

    expect(detail.desk.coverage.pairsSkipped.accumulatorBlanked).toBe(0);
    expect(detail.desk.movement.transfers).toHaveLength(1);
  });

  it('refuses to pair equal and opposite amounts belonging to different clients', () => {
    // 1,536.28 is a routine bullet-bot daily P&L on the real book and turns up
    // across dozens of accounts in the same week. Matching on the amount alone
    // invents a transfer between two clients who have nothing to do with each
    // other.
    const clients = [
      makeClient({
        id: 'a',
        registry: { A1: cash() },
        closes: [
          { date: '2026-07-22', snapshots: [{ account: 'A1', balance: 50000, gross: 0, weekly: 0 }] },
          { date: '2026-07-23', snapshots: [{ account: 'A1', balance: 51536.28, gross: 0, weekly: 0 }] },
        ],
      }),
      makeClient({
        id: 'b',
        registry: { B1: cash() },
        closes: [
          { date: '2026-07-22', snapshots: [{ account: 'B1', balance: 50000, gross: 0, weekly: 0 }] },
          { date: '2026-07-23', snapshots: [{ account: 'B1', balance: 48463.72, gross: 0, weekly: 0 }] },
        ],
      }),
    ];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.movement.transfers).toEqual([]);
    expect(detail.desk.movement.unexplained).toHaveLength(2);
    expect(detail.desk.movement.unexplained.every((row) => row.direction)).toBe(true);
  });
});

describe('buildCapitalDetail — what it declines to explain', () => {
  it('lists a movement it cannot tell apart from a trading loss without labelling it', () => {
    const clients = [
      ...healthyCohort('bulk', 10, ['2026-07-27', '2026-07-28']),
      makeClient({
        id: 'c1',
        name: 'Marlow Iris',
        registry: { X: { accountType: 'Evaluation - Bullet Bot', status: 'Failed' } },
        closes: [
          { date: '2026-07-27', snapshots: [{ account: 'X', balance: 50000, gross: 0, weekly: 0 }] },
          { date: '2026-07-28', snapshots: [{ account: 'X', balance: 47405, gross: 0, weekly: 0 }] },
        ],
      }),
    ];

    const detail = buildCapitalDetail(clients);
    const [row] = detail.desk.movement.unexplained;

    expect(row.amount).toBe(-2595);
    expect(row.direction).toBe('out');
    expect(row.accountName).toBe('X');
    expect(row.clientName).toBe('Marlow Iris');
    // No classification field exists on purpose. Nothing in this module may
    // decide this was a withdrawal.
    expect(row.classification).toBeUndefined();
    expect(detail.declined.some((item) => item.figure.startsWith('What the unexplained'))).toBe(true);
  });

  it('skips a close whose cohort does not reconcile at all rather than inventing movements', () => {
    // The seed block, 2026-06-25 to 07-01: 17 accounts a day, closes stamped
    // Saturday and Sunday, and 0 of 17 pairs reconciling on every date. Left
    // unguarded it produces 102 phantom movements.
    const clients = Array.from({ length: 17 }, (unused, index) => makeClient({
      id: `seed${index}`,
      registry: { [`S${index}`]: funded() },
      closes: [
        { date: '2026-06-25', snapshots: [{ account: `S${index}`, balance: 50000, gross: 40, weekly: 1163 }] },
        { date: '2026-06-26', snapshots: [{ account: `S${index}`, balance: 49971, gross: 131, weekly: 1184 }] },
        { date: '2026-06-29', snapshots: [{ account: `S${index}`, balance: 50102, gross: -29, weekly: 1525 }] },
      ],
    }));

    const detail = buildCapitalDetail(clients);

    expect(detail.distrustedCloses.map((row) => row.date)).toEqual(['2026-06-26', '2026-06-29']);
    expect(detail.distrustedCloses[0].reconciled).toBe(0);
    expect(detail.distrustedCloses[0].pairs).toBe(17);
    expect(detail.desk.movement.unexplained).toEqual([]);
    expect(detail.desk.coverage.pairsSkipped.closeDistrusted).toBe(34);
  });

  it('leaves a thin close alone instead of declaring it broken', () => {
    // Two accounts disagreeing is not a broken import. Below the cohort floor
    // there is nothing to conclude either way.
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash(), B: cash() },
      closes: [
        {
          date: '2026-07-27',
          snapshots: [
            { account: 'A', balance: 1000, gross: 0, weekly: 0 },
            { account: 'B', balance: 2000, gross: 0, weekly: 0 },
          ],
        },
        {
          date: '2026-07-28',
          snapshots: [
            { account: 'A', balance: 900, gross: 0, weekly: 0 },
            { account: 'B', balance: 1900, gross: 0, weekly: 0 },
          ],
        },
      ],
    })];

    const detail = buildCapitalDetail(clients);

    expect(detail.distrustedCloses).toEqual([]);
    expect(detail.desk.movement.unexplained).toHaveLength(2);
  });

  it('skips a mid-week accumulator that was blanked to zero', () => {
    // 22 accounts on 2026-07-24 and 2 on 07-30 had weekly_pnl written as 0 while
    // the balance was live. The delta is not computable there.
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash() },
      closes: [
        { date: '2026-07-23', snapshots: [{ account: 'A', balance: 45081.56, gross: -428.04, weekly: 1029.96 }] },
        { date: '2026-07-24', snapshots: [{ account: 'A', balance: 43392.84, gross: 0, weekly: 0 }] },
      ],
    })];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.coverage.pairsSkipped.accumulatorBlanked).toBe(1);
    expect(detail.desk.movement.unexplained).toEqual([]);
  });

  it('skips a close that repeats an earlier week verbatim', () => {
    const clients = [makeClient({
      id: 'c1',
      registry: { A: funded() },
      closes: [
        { date: '2026-07-13', snapshots: [{ account: 'A', balance: 50553, gross: 0, weekly: -856.8 }] },
        { date: '2026-07-22', snapshots: [{ account: 'A', balance: 50553, gross: 0, weekly: -856.8 }] },
        { date: '2026-07-23', snapshots: [{ account: 'A', balance: 51040.8, gross: 0, weekly: 487.8 }] },
      ],
    })];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.coverage.pairsSkipped.staleRow).toBe(1);
    expect(detail.desk.movement.unexplained).toEqual([]);
  });
});

describe('buildCapitalDetail — capital held', () => {
  const clients = [makeClient({
    id: 'c1',
    name: 'Wren Glen',
    registry: {
      F1: funded(),
      C1: cash(),
      NEVER: funded(),
      IGN: { accountType: 'Inactive / Ignore', status: 'Active' },
    },
    closes: [
      {
        date: '2026-07-22',
        snapshots: [
          { account: 'F1', balance: 50000, gross: 0, weekly: 0 },
          { account: 'C1', balance: 30000, gross: 0, weekly: 0 },
          { account: 'IGN', balance: 9000, gross: 0, weekly: 0 },
          { account: 'GONE', balance: 7000, gross: 0, weekly: 0 },
        ],
      },
      {
        date: '2026-07-23',
        snapshots: [{ account: 'F1', balance: 50000, gross: 0, weekly: 0 }],
      },
    ],
  })];

  it('never counts an account with no close as zero capital', () => {
    // 44 accounts on the real book have never appeared in a snapshot. A zero for
    // each of them would be a claim about a balance nobody has ever seen.
    const detail = buildCapitalDetail(clients);
    const fundedBlock = detail.segments.find((block) => block.segment === SEGMENTS.FUNDED);

    expect(fundedBlock.held.accounts).toBe(1);
    expect(fundedBlock.held.accountsWithoutBalance).toBe(1);
    // A prop pool has no capital. The observed balance is its plan size.
    expect(fundedBlock.held.capital).toBeNull();
    expect(fundedBlock.held.planSize).toBe(50000);
    expect(fundedBlock.held.balanceObserved).toBe(50000);
  });

  it('refuses to call a prop balance capital, and says why in the block', () => {
    // The desk manager's whole point: a prop-firm account balance is a plan size
    // the firm simulates. On the real book it was 93.93% of a $32,244,234.16
    // figure the screen headed "Capital held".
    const detail = buildCapitalDetail(clients);
    const fundedBlock = detail.segments.find((block) => block.segment === SEGMENTS.FUNDED);
    const cashBlock = detail.segments.find((block) => block.segment === SEGMENTS.CASH);

    expect(fundedBlock.moneyKind).toBe(MONEY_KINDS.PROP_PLAN_SIZE);
    expect(fundedBlock.held.capital).toBeNull();
    expect(fundedBlock.held.capitalRefusal).toMatch(/plan size/i);
    // What a prop pool IS entitled to: its movement.
    expect(fundedBlock.movement.tradingPnl).not.toBeNull();

    // Cash is the one kind that keeps a balance, and it keeps it as capital.
    expect(cashBlock.moneyKind).toBe(MONEY_KINDS.CLIENT_CASH);
    expect(cashBlock.held.capital).toBe(30000);
    expect(cashBlock.held.capitalRefusal).toBeNull();
    expect(cashBlock.held.planSize).toBeNull();
  });

  it('carries a stale balance forward and says how stale it is', () => {
    const detail = buildCapitalDetail(clients);

    expect(detail.asOfDate).toBe('2026-07-23');
    // The desk holds no capital figure at all — see the guard below. Staleness
    // and the per-close account counts survive, because those are counts.
    expect(detail.desk.held.capital).toBeNull();
    expect(detail.desk.held.atLatestClose.accounts).toBe(1);
    expect(detail.desk.held.staleness).toEqual({
      current: 1, withinThreeDays: 1, withinSevenDays: 0, older: 0,
    });
    expect(detail.desk.held.asOfDates).toHaveLength(2);
    expect(detail.desk.held.asOfDates.every((row) => row.balance === undefined)).toBe(true);
  });

  it('produces no desk capital figure, in any field, under any name', () => {
    // THE GUARD FOR ITEM 5. The desk used to publish $32,244,234.16 of "capital
    // held" over 584 accounts, 93.93% of which was prop plan size and at most
    // $1,956,551.34 of which was money anyone could withdraw. There is no
    // defensible whole here, so there is no number: cash keeps a balance, prop
    // gets its movement, and the two are never added.
    const detail = buildCapitalDetail(clients);

    expect(detail.desk.held.capital).toBeNull();
    expect(detail.desk.held.planSize).toBeNull();
    expect(detail.desk.held.atLatestClose.capital).toBeNull();
    expect(detail.desk.held.balanceObserved).toBe(0);
    expect(detail.desk.movement.tradingPnl).toBeNull();
    expect(detail.desk.held.capitalRefusal).toMatch(/no defensible total|must not be added/i);
    // And every timeline money column with it: one line for the desk would add
    // the cash desk's result to the prop desk's.
    for (const point of detail.desk.timeline) {
      expect(point.netPnl).toBeNull();
      expect(point.cumulativeNetPnl).toBeNull();
      expect(point.balanceObserved).toBeNull();
    }
    expect(detail.desk.timelineRefusal).toMatch(/Open a segment/);
  });

  it('gives no segment a share of a desk total, because there is none', () => {
    const detail = buildCapitalDetail(clients);

    for (const block of detail.segments) {
      expect(block.composition.shareOfDesk).toBeUndefined();
      expect(Object.keys(block.composition)).not.toContain('shareOfDesk');
    }
  });

  it('keeps ignored and orphan capital out of the desk total and gives them no share of it', () => {
    const detail = buildCapitalDetail(clients);
    const ignored = detail.segments.find((block) => block.segment === SEGMENTS.IGNORED);
    const orphan = detail.segments.find((block) => block.segment === SEGMENTS.ORPHAN);

    // Still counted, still visible, still not capital and not in any roll-up.
    expect(ignored.held.balanceObserved).toBe(9000);
    expect(orphan.held.balanceObserved).toBe(7000);
    expect(ignored.held.capital).toBeNull();
    expect(orphan.held.capital).toBeNull();
    expect(ignored.countedInTotal).toBe(false);
    expect(detail.desk.composition.bySegment.map((row) => row.segment))
      .not.toContain(SEGMENTS.IGNORED);
  });

  it('does not merge two clients who use the same account name', () => {
    // 101 account names on the real book belong to more than one client.
    // CCDAKCEHCAFDGB52196 is two different accounts holding 52,520.24 each.
    const shared = [
      makeClient({
        id: 'kai',
        registry: { CCDAKCEHCAFDGB52196: funded() },
        closes: [{ date: '2026-07-22', snapshots: [{ account: 'CCDAKCEHCAFDGB52196', balance: 52520.24 }] }],
      }),
      makeClient({
        id: 'oakley',
        registry: { CCDAKCEHCAFDGB52196: { accountType: 'Unassigned', status: 'Active' } },
        closes: [{ date: '2026-07-22', snapshots: [{ account: 'CCDAKCEHCAFDGB52196', balance: 52520.24 }] }],
      }),
    ];

    const detail = buildCapitalDetail(shared);

    expect(detail.desk.held.accounts).toBe(2);
    // Two accounts, two segments, and no one number across them.
    expect(detail.desk.composition.bySegment
      .reduce((sum, row) => sum + row.balance, 0)).toBe(105040.48);
    expect(detail.desk.held.capital).toBeNull();
    expect(detail.desk.movement.unexplained).toEqual([]);
  });

  it('reports how much of a segment its P&L figure actually rests on', () => {
    const detail = buildCapitalDetail(clients);
    const fundedBlock = detail.segments.find((block) => block.segment === SEGMENTS.FUNDED);

    expect(fundedBlock.movement.tradingPnl.accounts).toBe(1);
    expect(fundedBlock.movement.tradingPnl.coverageShare).toBe(1);
  });
});

describe('buildCapitalDetail — recorded facts versus silence', () => {
  const withPayout = () => [makeClient({
    id: 'c1',
    registry: {
      P1: funded({
        payoutHistory: [
          { date: '2026-04-30', amount: 4000, state: 'Payout approved' },
          { date: '2026-05-28', amount: 4200, state: 'Payout approved' },
          { date: '2026-06-20', amount: 900, state: 'Payout requested' },
        ],
      }),
      P2: funded(),
      C1: cash(),
    },
    closes: [{
      date: '2026-07-22',
      snapshots: [
        { account: 'P1', balance: 50000 },
        { account: 'P2', balance: 50000 },
        { account: 'C1', balance: 10000 },
      ],
    }],
  })];

  it('treats a recorded payout as authoritative and keeps a request out of it', () => {
    const detail = buildCapitalDetail(withPayout());
    const fundedBlock = detail.segments.find((block) => block.segment === SEGMENTS.FUNDED);

    expect(fundedBlock.movement.payouts.recorded).toEqual({
      amount: 8200, events: 2, accounts: 1, firstDate: '2026-04-30', lastDate: '2026-05-28',
    });
    expect(fundedBlock.movement.payouts.pending).toEqual({ amount: 900, events: 1 });
    expect(fundedBlock.movement.payouts.accountsWithHistory).toBe(1);
    expect(fundedBlock.movement.payouts.accountsWithoutHistory).toBe(1);
    // None of them falls inside the observed closes, so none can be tied to a
    // balance drop.
    expect(fundedBlock.movement.payouts.eventsInsideWindow).toBe(0);
  });

  it('says a segment with no payout record has none recorded rather than zero', () => {
    // The distinction this codebase exists to protect. On the state the CRM
    // actually renders, 0 of 601 accounts carry a payout — every payout_events
    // row belongs to a soft-deleted client — and "$0 paid out" would be false.
    const detail = buildCapitalDetail(withPayout());
    const cashBlock = detail.segments.find((block) => block.segment === SEGMENTS.CASH);

    expect(cashBlock.movement.payouts.recorded).toBeNull();
    expect(cashBlock.movement.payouts.recorded).not.toBe(0);
    expect(cashBlock.movement.payouts.accountsWithoutHistory).toBe(1);
  });

  it('never puts a dollar figure on funding, and never invents money in', () => {
    const detail = buildCapitalDetail([makeClient({
      id: 'c1',
      registry: { F1: funded({ dateFunded: '2026-01-20', startBalance: 50000 }) },
      closes: [{ date: '2026-07-22', snapshots: [{ account: 'F1', balance: 53000 }] }],
    })]);
    const fundedBlock = detail.segments.find((block) => block.segment === SEGMENTS.FUNDED);

    expect(fundedBlock.movement.funded.accountsWithFundedDate).toBe(1);
    expect(fundedBlock.movement.funded.firstDate).toBe('2026-01-20');
    // start_balance is the prop firm's simulated plan size, not desk money.
    expect(fundedBlock.movement.funded.amount).toBeNull();
    expect(fundedBlock.movement.moneyIn).toBeNull();
    expect(detail.declined.some((row) => row.figure.startsWith('Money in'))).toBe(true);
    expect(detail.declined.every((row) => row.value === null)).toBe(true);
  });
});

describe('buildCapitalDetail — the timeline', () => {
  it('carries the account count behind every point on the line', () => {
    // 2026-07-13 carried 438 snapshots and 07-14 carried 75. A capital line
    // without the coverage under it reads as a collapse that never happened.
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash(), B: cash() },
      closes: [
        {
          date: '2026-07-13',
          snapshots: [
            { account: 'A', balance: 10000, gross: 0, weekly: 0 },
            { account: 'B', balance: 20000, gross: 0, weekly: 0 },
          ],
        },
        { date: '2026-07-14', snapshots: [{ account: 'A', balance: 10500, gross: 500, weekly: 500 }] },
      ],
    })];

    const detail = buildCapitalDetail(clients);

    expect(detail.desk.timeline).toHaveLength(2);
    expect(detail.desk.timeline[0]).toMatchObject({ date: '2026-07-13', accounts: 2 });
    expect(detail.desk.timeline[1]).toMatchObject({ date: '2026-07-14', accounts: 1 });
    expect(detail.desk.timeline[1].coverage).toBe(0.5);

    // The money is on the SEGMENT's timeline, where it is one kind of money.
    const cashBlock = detail.segments.find((block) => block.segment === SEGMENTS.CASH);
    expect(cashBlock.timeline[0]).toMatchObject({
      date: '2026-07-13', accounts: 2, balanceObserved: 30000, netPnl: 0, cumulativeNetPnl: 0,
    });
    expect(cashBlock.timeline[1]).toMatchObject({
      date: '2026-07-14', accounts: 1, balanceObserved: 10500, netPnl: 500, cumulativeNetPnl: 500,
    });
  });

  it('honours an as-of bound and reports the close it actually landed on', () => {
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash() },
      closes: [
        { date: '2026-07-22', snapshots: [{ account: 'A', balance: 10000, gross: 0, weekly: 0 }] },
        { date: '2026-07-23', snapshots: [{ account: 'A', balance: 11000, gross: 1000, weekly: 1000 }] },
        { date: '2026-07-24', snapshots: [{ account: 'A', balance: 90000, gross: 0, weekly: 1000 }] },
      ],
    })];

    const detail = buildCapitalDetail(clients, { asOfDate: '2026-07-23' });

    expect(detail.asOfDate).toBe('2026-07-23');
    expect(detail.requestedAsOf).toBe('2026-07-23');
    expect(detail.segments.find((block) => block.segment === SEGMENTS.CASH).held.capital)
      .toBe(11000);
    expect(detail.desk.movement.unexplained).toEqual([]);
  });

  it('returns the requested segment as `selected`, and the desk when none is asked for', () => {
    const clients = [makeClient({
      id: 'c1',
      registry: { A: cash(), F: funded() },
      closes: [{
        date: '2026-07-22',
        snapshots: [{ account: 'A', balance: 10000 }, { account: 'F', balance: 50000 }],
      }],
    })];

    expect(buildCapitalDetail(clients, { segment: SEGMENTS.CASH }).selected.held.capital).toBe(10000);
    // The desk is `selected` when no segment is asked for, and it has no capital
    // figure — the $60,000 that used to be here was $10,000 of client cash added
    // to $50,000 of a prop firm's simulated plan size.
    expect(buildCapitalDetail(clients).selected.held.capital).toBeNull();
    // A segment nobody holds returns an empty block, not a crash and not a
    // borrowed total from another segment.
    const missing = buildCapitalDetail(clients, { segment: SEGMENTS.EVAL_BULLET });
    expect(missing.selected.held.balanceObserved).toBe(0);
    expect(missing.selected.held.accounts).toBe(0);
  });

  it('survives an empty book without claiming anything', () => {
    const detail = buildCapitalDetail([]);

    expect(detail.asOfDate).toBeNull();
    expect(detail.segments).toEqual([]);
    expect(detail.desk.held.capital).toBeNull();
    expect(detail.desk.held.balanceObserved).toBe(0);
    expect(detail.desk.held.accounts).toBe(0);
    expect(detail.desk.movement.tradingPnl).toBeNull();
    expect(detail.desk.movement.payouts).toBeNull();
  });
});
