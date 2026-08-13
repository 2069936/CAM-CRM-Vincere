import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildAccountLifecycle,
  buildAccountLifecycleStates,
  buildLifecycleByAlgo,
  LIFECYCLE_STATES,
  WITHHELD_REASONS,
} from './accountLifecycle';
import { buildCrmStateFromTables } from './supabaseStore';

describe('buildAccountLifecycle', () => {
  it('builds phases from algoHistory and marks the outcome', () => {
    const account = {
      accountName: 'A1',
      accountType: 'Funded',
      dateAdded: '2026-06-01',
      dateFunded: '2026-06-20',
      algoStack: 'URGO x2',
      algoHistory: [
        { date: '2026-06-10', from: 'URGO', to: 'URGO x2' },
      ],
    };
    const lc = buildAccountLifecycle(account, { asOf: '2026-06-25' });
    expect(lc.outcome).toBe('funded');
    expect(lc.daysAlive).toBe(24); // 06-01 -> 06-25
    expect(lc.phases).toHaveLength(2);
    expect(lc.phases[0]).toMatchObject({ algo: 'URGO', start: '2026-06-01', end: '2026-06-10', days: 9 });
    expect(lc.phases[1]).toMatchObject({ algo: 'URGO x2', end: '2026-06-25' });
    expect(lc.currentAlgo).toBe('URGO x2');
  });

  it('marks a failed account and stops the clock at death', () => {
    const lc = buildAccountLifecycle({ accountName: 'A2', accountType: 'Evaluation - Standard', dateAdded: '2026-06-01', dateFailed: '2026-06-03', algoStack: 'IFSP' }, { asOf: '2026-06-30' });
    expect(lc.outcome).toBe('failed');
    expect(lc.daysAlive).toBe(2); // dies 06-03, not 06-30
  });
});

describe('buildLifecycleByAlgo', () => {
  it('aggregates funded rate + lifespan by algo combo', () => {
    const clients = [{
      accountRegistry: {
        A1: { accountType: 'Funded', algoStack: 'URGO', dateAdded: '2026-06-01', dateFunded: '2026-06-15' },
        A2: { accountType: 'Evaluation - Standard', algoStack: 'URGO', dateAdded: '2026-06-01', dateFailed: '2026-06-05' },
        A3: { accountType: 'Funded', algoStack: 'IFSP', dateAdded: '2026-06-01', dateFunded: '2026-06-10' },
      },
    }];
    const rows = buildLifecycleByAlgo(clients, { asOf: '2026-06-20' });
    const urgo = rows.find((r) => r.combo === 'URGO');
    expect(urgo).toMatchObject({ accounts: 2, funded: 1, failed: 1, fundedRate: 50 });
    const ifsp = rows.find((r) => r.combo === 'IFSP');
    expect(ifsp.fundedRate).toBe(100);
    expect(rows[0].combo).toBe('IFSP'); // sorted by funded rate desc
  });
});

// ---------------------------------------------------------------------------
// buildAccountLifecycleStates — the evidence-driven half.
//
// Every case below is a defect this module exists to avoid, not a hypothetical:
// a 0 in the drawdown column read as a breach (89 accounts on the real book have
// been 0 on every close they ever had), an account retired because someone
// ticked a dropdown while it was still filling orders (25 such accounts traded
// on the most recent close), and an absence read as a death (6 accounts missed a
// close and came back).
// ---------------------------------------------------------------------------

function close(date, snapshots, { orders = [], executions = [] } = {}) {
  return { date, snapshots, orders, executions, strategies: [] };
}

function snap(accountName, { dd = 0, balance = 50000, pnl = 0 } = {}) {
  return {
    accountName,
    trailingMaxDrawdown: dd,
    accountBalance: balance,
    grossRealizedPnl: pnl,
    strategies: [],
  };
}

function clientWith(registry, closes) {
  return [{ id: 'c1', name: 'Test Client', accountRegistry: registry, dailyImports: closes }];
}

const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09'];

function find(view, accountName) {
  return view.accounts.find((row) => row.accountName === accountName);
}

describe('buildAccountLifecycleStates — drawdown readings', () => {
  it('never treats a 0 drawdown as a breach and reports it as never measured', () => {
    // reconcile.createSnapshot writes 0 when the grid carried no drawdown column,
    // and account_snapshots has no trailing_source column to tell that apart
    // afterwards. 585 of the 3,100 real rows are 0. A `<= 0` rule here would kill
    // 89 accounts that never had a reading at all.
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Standard', status: 'Active' } },
      dates.map((date) => close(date, [snap('A1', { dd: 0, pnl: 120 })])),
    ));
    const row = find(view, 'A1');
    expect(row.drawdown.value).toBeNull();
    expect(row.drawdown.breached).toBeNull();
    expect(row.state).toBe(LIFECYCLE_STATES.RUNNING);
    expect(row.suggestion).toBeNull();
    expect(row.evidenceLine).toContain('trailing buffer never reported');
  });

  it('treats a strictly negative buffer as finished and suggests a retire', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Active' } },
      [
        close(dates[0], [snap('A1', { dd: 2000, pnl: 0 })]),
        close(dates[1], [snap('A1', { dd: 858, pnl: -1142 })]),
        close(dates[2], [snap('A1', { dd: -263, pnl: -1122 })]),
      ],
    ));
    const row = find(view, 'A1');
    expect(row.state).toBe(LIFECYCLE_STATES.FINISHED);
    expect(row.suggestion.action).toBe('retire');
    expect(row.suggestion.kind).toBe('breached-and-trading');
    expect(row.drawdown.value).toBe(-263);
    expect(row.drawdown.censored).toBe(true);
    // The desk has not marked it, so the row has to say so rather than implying
    // the two sources agree.
    expect(row.suggestion.agreement).toContain('has NOT marked this Failed');
  });

  it('uses the configured limit when there is one, not the sign', () => {
    // Model 1, 14 of 764 accounts: the value is cumulative loss and the account
    // is done at the limit. A sign test would call -800 healthy against a 1,500
    // limit and -1,600 healthy too.
    const registry = {
      UNDER: { accountType: 'Funded', status: 'Active', maxDrawdownLimit: 1500 },
      OVER: { accountType: 'Funded', status: 'Active', maxDrawdownLimit: 1500 },
    };
    const view = buildAccountLifecycleStates(clientWith(registry, [
      close(dates[0], [snap('UNDER', { dd: -800 }), snap('OVER', { dd: -3000 })]),
    ]));
    expect(find(view, 'UNDER').drawdown.breached).toBe(false);
    expect(find(view, 'OVER').drawdown.breached).toBe(true);
    expect(find(view, 'OVER').state).toBe(LIFECYCLE_STATES.FINISHED);
  });

  it('never breaches a cash account, and says so as null rather than false', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { CASH: { accountType: 'Cash', status: 'Active' } },
      // The stray filled order belongs to another account and is only here so
      // the book counts as having trade history: without it "did this account
      // trade" is unanswerable and the honest answer is `unknown`, which the
      // test below covers on its own.
      [close(dates[0], [snap('CASH', { dd: -5000, balance: 120000 })], {
        orders: [{ accountName: 'SOMEONE-ELSE', filled: 1, state: 'Filled' }],
      })],
    ));
    const row = find(view, 'CASH');
    expect(row.drawdown.breached).toBeNull();
    expect(row.state).toBe(LIFECYCLE_STATES.QUIET);
    expect(row.suggestion).toBeNull();
  });

  it('does not retire an account that breached and got its buffer back', () => {
    // 1 of the 50 uncensored accounts that went negative on the real book
    // recovered a positive buffer. Reading "ever breached" as dead retires it.
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Active' } },
      [
        close(dates[0], [snap('A1', { dd: -100, pnl: -900 })]),
        close(dates[1], [snap('A1', { dd: 1200, pnl: 1400 })]),
      ],
    ));
    const row = find(view, 'A1');
    expect(row.drawdown.recovered).toBe(true);
    expect(row.state).toBe(LIFECYCLE_STATES.RUNNING);
    expect(row.suggestion).toBeNull();
  });
});

describe('buildAccountLifecycleStates — declared status versus the book', () => {
  it('withholds a Failed account that is still reporting, and counts it', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Failed' } },
      dates.map((date) => close(date, [snap('A1', { dd: 1567, pnl: 300 })])),
    ));
    const row = find(view, 'A1');
    expect(row.suggestion).toBeNull();
    expect(row.withheldReason).toBe(WITHHELD_REASONS.DECLARED_FAILED_STILL_REPORTING);
    expect(view.declared).toMatchObject({ failed: 1, failedSuggested: 0, failedStillTrading: 1 });
    expect(view.withheld.find((entry) => entry.reason === WITHHELD_REASONS.DECLARED_FAILED_STILL_REPORTING).count).toBe(1);
  });

  it('suggests a Failed account only once the closes have gone quiet too', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Failed' } },
      dates.map((date, index) => close(date, index === 0 ? [snap('A1', { dd: 2000 })] : [])),
    ));
    const row = find(view, 'A1');
    expect(row.state).toBe(LIFECYCLE_STATES.STALE);
    expect(row.suggestion.kind).toBe('declared-and-silent');
    expect(row.suggestion.confidence).toBe('declared, not observed');
  });

  it('never invents a failure date from the status', () => {
    // date_failed is set on 2 of 764 accounts. Nothing here fills it in.
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Funded', status: 'Failed' } },
      [close(dates[0], [snap('A1', { dd: 900 })])],
    ));
    expect(find(view, 'A1').dateFailed).toBeNull();
    expect(view.declared.failedWithDate).toBe(0);
  });
});

describe('buildAccountLifecycleStates — absence, and what it is not', () => {
  it('calls a long absence stale and refuses to call it a burn', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Standard', status: 'Active' } },
      dates.map((date, index) => close(date, index < 2 ? [snap('A1', { dd: 1800, pnl: 50 })] : [])),
    ));
    const row = find(view, 'A1');
    expect(row.state).toBe(LIFECYCLE_STATES.STALE);
    expect(row.closesSinceSeen).toBe(5);
    expect(row.suggestion).toBeNull();
    expect(row.withheldReason).toBe(WITHHELD_REASONS.STALE_ONLY);
  });

  it('records a skipped close that came back rather than ending the account there', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Standard', status: 'Active' } },
      dates.map((date, index) => close(date, index === 3 ? [] : [snap('A1', { dd: 1800, pnl: 50 })])),
    ));
    const row = find(view, 'A1');
    expect(row.skippedCloses).toBe(1);
    expect(row.state).toBe(LIFECYCLE_STATES.RUNNING);
  });

  it('reports an account that was never in a close as unknown, not as failed', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { GHOST: { accountType: 'Unassigned', status: 'Active' } },
      [close(dates[0], [])],
    ));
    const row = find(view, 'GHOST');
    expect(row.state).toBe(LIFECYCLE_STATES.UNKNOWN);
    expect(row.drawdown.value).toBeNull();
    expect(row.withheldReason).toBe(WITHHELD_REASONS.NEVER_REPORTED);
  });
});

describe('buildAccountLifecycleStates — supporting signals stay supporting', () => {
  it('never retires on a liquidation-only reject alone', () => {
    // 74% of the accounts with one and enough history to test reported again,
    // 32% traded again. It is a margin state, not a death.
    const reject = {
      accountName: 'A1',
      filled: 0,
      state: 'Rejected: Your account is currently set to liquidation only due to low net liquidating value. Please contact the Trade Desk for additional details.',
    };
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Funded', status: 'Active' } },
      [
        close(dates[0], [snap('A1', { dd: 1200, pnl: 0 })], { orders: [reject] }),
        close(dates[1], [snap('A1', { dd: 1200, pnl: 0 })]),
        close(dates[2], [snap('A1', { dd: 1200, pnl: 0 })]),
        close(dates[3], [snap('A1', { dd: 1200, pnl: 0 })]),
      ],
    ));
    const row = find(view, 'A1');
    expect(row.liquidationOnly.orders).toBe(1);
    expect(row.suggestion).toBeNull();
    expect(row.withheldReason).toBe(WITHHELD_REASONS.LIQUIDATION_ONLY);
  });

  it('says "not known" rather than "never traded" when the trade tables are not loaded', () => {
    // orders/executions load after the rest of the state, and both arrive as []
    // either way, so this can only be told apart book-wide. Saying "never traded"
    // for a few seconds after every load is a claim, not a hole.
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Funded', status: 'Active' } },
      dates.map((date) => close(date, [snap('A1', { dd: 1200, pnl: 0 })])),
    ));
    const row = find(view, 'A1');
    expect(row.tradeEvidence).toBe('unknown');
    expect(row.lastTradeDate).toBeNull();
    expect(row.state).toBe(LIFECYCLE_STATES.UNKNOWN);
    expect(row.evidenceLine).toContain('not known');
  });

  it('classifies an account with no registry row but never suggests retiring it', () => {
    const view = buildAccountLifecycleStates(clientWith(
      {},
      [close(dates[0], [snap('ORPHAN', { dd: -400, pnl: -900 })])],
    ));
    const row = find(view, 'ORPHAN');
    expect(row.registered).toBe(false);
    expect(row.state).toBe(LIFECYCLE_STATES.FINISHED);
    expect(row.suggestion).toBeNull();
    expect(row.withheldReason).toBe(WITHHELD_REASONS.NOT_IN_REGISTRY);
  });

  it('puts the four facts a CAM checks into one line', () => {
    const view = buildAccountLifecycleStates(clientWith(
      { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Failed' } },
      [
        close(dates[0], [snap('A1', { dd: 500, pnl: -1000 })]),
        close(dates[1], [snap('A1', { dd: -273, pnl: -900 })]),
      ],
    ));
    const line = find(view, 'A1').evidenceLine;
    expect(line).toContain('desk status Failed');
    expect(line).toContain('trailing buffer -$273 (2026-07-02)');
    expect(line).toContain('last reported 2026-07-02 (this close)');
    expect(line).toContain('last traded 2026-07-02 (this close)');
  });
});

describe('buildAccountLifecycleStates on the real book', () => {
  // public/local-snapshot.json, 96 visible clients (buildCrmStateFromTables
  // drops the 40 soft-deleted / Inactive ones), 718 accounts, closes to
  // 2026-07-30. These numbers are a regression fence: they were read off the
  // rendered list, account by account, not inferred from a passing assertion.
  const snapshot = JSON.parse(
    readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const { clients } = buildCrmStateFromTables(snapshot.tables);
  const view = buildAccountLifecycleStates(clients);

  it('places every account in exactly one state', () => {
    expect(view.asOf).toBe('2026-07-30');
    expect(view.accounts).toHaveLength(718);
    expect(view.counts).toEqual({
      running: 231, quiet: 155, finished: 181, stale: 113, unknown: 38,
    });
    const sum = Object.values(view.counts).reduce((total, count) => total + count, 0);
    expect(sum).toBe(view.accounts.length);
  });

  it('suggests 179 retires and says why the other 539 are not on the list', () => {
    expect(view.suggestions).toHaveLength(179);
    expect(view.withheldTotal).toBe(539);
    expect(view.suggestions.length + view.withheldTotal).toBe(view.accounts.length);
    const byKind = view.suggestions.reduce((tally, row) => ({
      ...tally, [row.suggestion.kind]: (tally[row.suggestion.kind] || 0) + 1,
    }), {});
    expect(byKind).toEqual({ 'breached-and-trading': 76, breached: 100, 'declared-and-silent': 3 });
    expect(Object.fromEntries(view.withheld.map((entry) => [entry.reason, entry.count]))).toEqual({
      'no-evidence': 347,
      'stale-only': 104,
      'not-in-registry': 33,
      'never-reported': 29,
      'liquidation-only': 14,
      'declared-failed-still-reporting': 6,
      'drawdown-never-reported': 6,
    });
  });

  it('splits the 47 Failed accounts by what the closes actually show', () => {
    expect(view.declared).toMatchObject({
      failed: 47,
      // date_failed is set on 2 of 764 rows book-wide and neither survives the
      // visible-client filter, so not one Failed account can be placed in time.
      failedWithDate: 0,
      failedSuggested: 41,
      failedStillTrading: 25,
      failedStillTradingSuggested: 21,
      failedStillTradingWithheld: 4,
    });
    expect(Math.round(view.declared.failedStillTradingBalance)).toBe(1219742);
    expect(Math.round(view.declared.failedStillTradingDailyPnl)).toBe(-30780);
  });

  it('never suggests a retire without a dated observation or a silence behind it', () => {
    for (const row of view.suggestions) {
      const observed = row.drawdown.breached === true && Boolean(row.drawdown.date);
      const declaredAndSilent = row.declaredFailed && row.closesSinceSeen >= 5;
      expect(observed || declaredAndSilent).toBe(true);
      expect(row.registered).toBe(true);
      expect(row.evidenceLine).toContain('desk status');
    }
  });

  it('leaves every still-reporting account the desk merely marked Failed alone', () => {
    const withheldFailed = view.accounts.filter(
      (row) => row.withheldReason === WITHHELD_REASONS.DECLARED_FAILED_STILL_REPORTING,
    );
    expect(withheldFailed).toHaveLength(6);
    for (const row of withheldFailed) {
      expect(row.drawdown.breached).not.toBe(true);
      expect(row.suggestion).toBeNull();
    }
  });
  it('dates its evidence to the last close it saw, never to the picker', () => {
    // The ops screen hands in its own date picker, and that picker is seeded
    // from the wall clock: on this book it opens on 2026-08-11 while the last
    // close is 2026-07-30. `asOf` used to echo the bound back, so the panel
    // rendered "closes to 2026-08-11" for twelve days that contain no close at
    // all — a measurement wearing a date it never reached.
    const bounded = buildAccountLifecycleStates(clients, { asOf: '2026-08-11' });
    expect(bounded.asOf).toBe('2026-07-30');
    expect(bounded.bound).toBe('2026-08-11');

    // The bound is a real filter, not decoration: cut it to mid-book and both
    // the date and the states move.
    const cut = buildAccountLifecycleStates(clients, { asOf: '2026-07-15' });
    expect(cut.asOf).toBe('2026-07-15');
    expect(cut.bound).toBe('2026-07-15');
    expect(cut.counts).not.toEqual(bounded.counts);

    // Unbounded, there is nothing to disclose.
    const open = buildAccountLifecycleStates(clients);
    expect(open.asOf).toBe('2026-07-30');
    expect(open.bound).toBeNull();
    // And moving the picker into the future changes nothing but the disclosure.
    expect(bounded.counts).toEqual(open.counts);
    expect(bounded.suggestions).toHaveLength(open.suggestions.length);
  });
});
