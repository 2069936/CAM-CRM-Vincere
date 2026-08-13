// What the reasons section is allowed to SAY, asserted on the derivation.
//
// Every fixture below is a real shape out of the 11 unredacted client exports
// for 2026-08-11:
//   - Daniel Swanson: 5 accounts, 2 orders, 0 executions, $0 realized. Both
//     orders came back `Rejected: Your account is currently set to liquidation
//     only due to Drawdown level breached at end of day.` on the two accounts
//     his report prints as BREACHED, one of which also carries an ENABLED
//     Bullet Bot-1.1. He is the whole reason the section exists.
//   - Craig Weschke: two cash accounts, 6 strategy rows across them and 0
//     enabled, and a 17-row orders grid in which every row belongs to his
//     Sim101 — so the live orders array is empty while the orders ARE on file.
//   - David Wilson: an accounts grid with no `Trailing max drawdown` column at
//     all, so both his snapshots come back with nothing to read.

import { describe, expect, it } from 'vitest';
import { EVIDENCE, REASON_KINDS, buildReportReasons } from './reportReasons';
import { ACCOUNT_TYPES } from './reconcile';

const REJECT = 'Rejected: Your account is currently set to liquidation only due to Drawdown level breached at end of day. Please contact the Trade Desk for additional details.';

function snapshot(accountName, over = {}) {
  return {
    accountName,
    connection: 'Legends',
    accountBalance: 50000,
    grossRealizedPnl: 0,
    weeklyPnl: 0,
    unrealizedPnl: 0,
    trailingMaxDrawdown: 2000,
    strategies: [],
    ...over,
  };
}

function registryOf(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.accountName, {
    alias: entry.accountName,
    accountType: ACCOUNT_TYPES.FUNDED,
    status: 'Active',
    dateAdded: '2026-08-01',
    ...entry,
  }]));
}

function clientWith({ registry = {}, closes = [] }) {
  const client = { id: 'c1', name: 'Daniel Swanson', accountRegistry: registry, dailyImports: closes };
  return client;
}

function kinds(out) {
  return out.reasons.map((entry) => entry.kind);
}

function of(out, kind) {
  return out.reasons.filter((entry) => entry.kind === kind);
}

describe('orders the platform refused', () => {
  const registry = registryOf([{ accountName: 'A1095' }, { accountName: 'A2574' }, { accountName: 'A1319' }]);
  const close = {
    date: '2026-08-11',
    snapshots: [
      snapshot('A1095', { trailingMaxDrawdown: -273.04, strategies: [{ strategyName: 'Bullet Bot-1.1', enabled: true }] }),
      snapshot('A2574', { trailingMaxDrawdown: -73.04, weeklyPnl: -942 }),
      snapshot('A1319'),
    ],
    orders: [
      { accountName: 'A1095', state: REJECT, filled: 0, id: 'o1' },
      { accountName: 'A2574', state: REJECT, filled: 0, id: 'o2' },
    ],
    executions: [],
    strategies: [],
  };

  it('quotes the platform verbatim and names the account', () => {
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    const rejected = of(out, REASON_KINDS.ORDERS_REJECTED);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((entry) => entry.accountName).sort()).toEqual(['A1095', 'A2574']);
    // The broker's sentence, with only its own `Rejected:` label removed. Not
    // paraphrased: a paraphrase is the desk taking on a claim it did not make.
    expect(rejected[0].quotes[0].text).toBe(
      'Your account is currently set to liquidation only due to Drawdown level breached at end of day. Please contact the Trade Desk for additional details.',
    );
    expect(out.counts.rejectedOrders).toBe(2);
  });

  it('never says nothing traded BECAUSE the account was breached', () => {
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    const text = out.reasons.map((entry) => `${entry.headline} ${entry.detail || ''}`).join(' ');
    expect(text).not.toMatch(/because|therefore|so nothing|as a result|caused/i);
    // The refusal and the drawdown reading are two separate observations about
    // the same account, deliberately not joined.
    expect(kinds(out).filter((kind) => kind === REASON_KINDS.ORDERS_REJECTED)).toHaveLength(2);
    expect(kinds(out).filter((kind) => kind === REASON_KINDS.ACCOUNT_STOPPED)).toHaveLength(2);
  });

  it('does not claim a strategy was off when the account carries an enabled one', () => {
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.STRATEGIES_ALL_OFF)).toHaveLength(0);
  });
});

describe('the difference between "no rejects" and "we do not have the orders"', () => {
  const registry = registryOf([{ accountName: 'A1' }]);

  it('says nothing about rejects, and says so, when no order row exists anywhere', () => {
    const close = { date: '2026-08-11', snapshots: [snapshot('A1')], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(out.evidence.orders).toBe(EVIDENCE.UNAVAILABLE);
    expect(of(out, REASON_KINDS.ORDERS_REJECTED)).toHaveLength(0);
    const unstated = out.unstated.find((item) => item.topic === 'rejected-orders');
    expect(unstated).toBeTruthy();
    expect(unstated.text).toMatch(/not the same as saying none was/);
    // The section must still render: a hole that renders as an empty section is
    // indistinguishable from a clean day.
    expect(out.hasAnything).toBe(true);
  });

  it('counts a simulation-only orders grid as evidence (Craig Weschke, 17 sim orders)', () => {
    // splitSimulationRows leaves `orders` empty and `simulation.orders` full, so
    // probing only the live array called his orders "not on file" on a client
    // whose orders we hold.
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('A1')],
      orders: [],
      executions: [],
      strategies: [],
      simulation: { orders: Array.from({ length: 17 }, (unused, i) => ({ accountName: 'Sim101', id: `s${i}` })), executions: [] },
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(out.evidence.orders).toBe(EVIDENCE.OBSERVED);
    expect(out.unstated.find((item) => item.topic === 'rejected-orders')).toBeUndefined();
  });

  it('an earlier close carrying orders proves the tables are loaded', () => {
    const monday = { date: '2026-08-10', snapshots: [snapshot('A1')], orders: [{ accountName: 'A1', state: 'Filled', filled: 1 }], executions: [], strategies: [] };
    const tuesday = { date: '2026-08-11', snapshots: [snapshot('A1')], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [monday, tuesday] }), tuesday);
    expect(out.evidence.orders).toBe(EVIDENCE.OBSERVED);
  });
});

describe('strategies assigned and none switched on', () => {
  const registry = registryOf([
    { accountName: 'Craig - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
    { accountName: 'Craig - Sub 1', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
  ]);
  const rows = (names) => names.map((strategyName) => ({ strategyName, enabled: false }));

  it('fires per account on a flat account, with the assigned names', () => {
    const close = {
      date: '2026-08-11',
      snapshots: [
        snapshot('Craig - Main', { strategies: rows(['0 - SYFY-1.4', '0 - IFSP-1.1', '0 - OGX-2.4']) }),
        snapshot('Craig - Sub 1', { strategies: rows(['0 - G4M-3.4']) }),
      ],
      orders: [{ accountName: 'Sim101', state: 'Filled', filled: 1 }],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    const off = of(out, REASON_KINDS.STRATEGIES_ALL_OFF);
    expect(off).toHaveLength(2);
    expect(off[0].headline).toContain('3 strategies are assigned');
    expect(off[0].detail).toContain('0 - SYFY-1.4, 0 - IFSP-1.1, 0 - OGX-2.4');
    expect(off[1].headline).toContain('1 strategy is assigned');
  });

  it('does not fire on an account with no strategy row at all', () => {
    // A dash under STRATEGIES has two causes and only one of them is a reason.
    // 855 of the 3,100 snapshot rows on the book (28%) carry no strategy row.
    const close = { date: '2026-08-11', snapshots: [snapshot('Craig - Main')], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.STRATEGIES_ALL_OFF)).toHaveLength(0);
  });

  it('does not fire on an account that traded anyway', () => {
    // The gate is what keeps this off half of every client's days: 261 of 535
    // imports on the book have every strategy row disabled.
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('Craig - Main', { grossRealizedPnl: 425, strategies: rows(['0 - URGO-4.5']) })],
      orders: [],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.STRATEGIES_ALL_OFF)).toHaveLength(0);
  });

  it('will not call an unstated `enabled` "switched off"', () => {
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('Craig - Main', { strategies: [{ strategyName: 'X', enabled: null }, { strategyName: 'Y', enabled: false }] })],
      orders: [],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.STRATEGIES_ALL_OFF)).toHaveLength(0);
  });

  it('picks up rows that are only on the import-level array', () => {
    // The window recalculateDailyImport documents: right after an upload the
    // flat array is populated and the nested one is not.
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('Craig - Main')],
      orders: [],
      executions: [],
      strategies: [{ accountName: 'Craig - Main', strategyName: '0 - OGX-2.4', enabled: false }],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.STRATEGIES_ALL_OFF)).toHaveLength(1);
  });
});

describe('a trailing drawdown of exactly 0', () => {
  const registry = registryOf([{ accountName: 'TOF131933' }, { accountName: 'TOF131934' }]);

  it('is reported as not measured, never as a breach and never as a buffer', () => {
    // David Wilson's accounts grid has no Trailing max drawdown column at all.
    // reconcile.js:348 reads `rawDD <= 0` as a breach; anything reusing that
    // rule declares these two dead.
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('TOF131933', { trailingMaxDrawdown: 0 }), snapshot('TOF131934', { trailingMaxDrawdown: null })],
      orders: [{ accountName: 'TOF131934', state: 'Filled', filled: 1 }],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(of(out, REASON_KINDS.ACCOUNT_STOPPED)).toHaveLength(0);
    const unstated = out.unstated.find((item) => item.topic === 'trailing-drawdown');
    expect(unstated.text).toContain('TOF131933');
    expect(unstated.text).toContain('TOF131934');
    expect(unstated.text).toMatch(/Not measured is not the same as no buffer left/);
  });

  it('says nothing about a cash account, which has no trailing rule to be inside', () => {
    const cash = registryOf([{ accountName: 'Live - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT }]);
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('Live - Main', { trailingMaxDrawdown: 0 })],
      orders: [{ accountName: 'Live - Main', state: 'Filled', filled: 1 }],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry: cash, closes: [close] }), close);
    expect(out.unstated.find((item) => item.topic === 'trailing-drawdown')).toBeUndefined();
    expect(of(out, REASON_KINDS.ACCOUNT_STOPPED)).toHaveLength(0);
  });
});

describe('registered accounts that did not report', () => {
  it('splits absences by reason and names the accounts', () => {
    const registry = registryOf([
      { accountName: 'REPORTS' },
      { accountName: 'WASHERE' },
      { accountName: 'NEVERSEEN' },
      { accountName: 'SHELVED', accountType: ACCOUNT_TYPES.IGNORE },
      { accountName: 'Sim101', accountType: ACCOUNT_TYPES.SIMULATION },
      { accountName: 'TOMORROW', dateAdded: '2026-08-12' },
    ]);
    const monday = { date: '2026-08-10', snapshots: [snapshot('REPORTS'), snapshot('WASHERE')], orders: [], executions: [], strategies: [] };
    const tuesday = { date: '2026-08-11', snapshots: [snapshot('REPORTS')], orders: [{ accountName: 'REPORTS', state: 'Filled', filled: 1 }], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [monday, tuesday] }), tuesday);

    const absent = of(out, REASON_KINDS.ACCOUNTS_ABSENT);
    expect(absent).toHaveLength(1);
    expect(absent[0].count).toBe(2);
    expect(absent[0].detail).toContain('WASHERE (last reported 2026-08-10)');
    expect(absent[0].detail).toContain('NEVERSEEN');
    // Counted apart, never in the headline: a shelf of retired accounts and a
    // simulator sitting idle are expected absences, and 84 of 764 accounts on
    // the book are Inactive / Ignore.
    expect(absent[0].detail).not.toContain('SHELVED');
    expect(absent[0].detail).not.toContain('Sim101');
    expect(out.counts.absentCountedApart).toEqual({ ignore: 1, simulation: 1, notYetRegistered: 1 });
  });

  it('never invents an absence for an account that did not exist yet', () => {
    const registry = registryOf([{ accountName: 'LATE', dateAdded: '2026-08-20' }]);
    const close = { date: '2026-08-11', snapshots: [], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    expect(out.counts.absent).toBe(0);
    expect(kinds(out)).toEqual([]);
  });

  it('an observed close beats a later date_added', () => {
    // 229 of the 720 accounts that ever appear in a close carry a date_added
    // LATER than the first close they reported in. The close wins.
    const registry = registryOf([{ accountName: 'BACKDATED', dateAdded: '2026-08-30' }, { accountName: 'OTHER' }]);
    const monday = { date: '2026-08-10', snapshots: [snapshot('BACKDATED'), snapshot('OTHER')], orders: [], executions: [], strategies: [] };
    const tuesday = { date: '2026-08-11', snapshots: [snapshot('OTHER')], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [monday, tuesday] }), tuesday);
    expect(of(out, REASON_KINDS.ACCOUNTS_ABSENT)[0].detail).toContain('BACKDATED');
  });

  it('a close with no account rows at all is ONE fact about collection', () => {
    // 12 of the 535 imports on the book carry 0 snapshot rows. Counting that as
    // N absent accounts reads as a desk-wide shutdown.
    const registry = registryOf([{ accountName: 'A' }, { accountName: 'B' }, { accountName: 'C' }]);
    const monday = { date: '2026-08-10', snapshots: [snapshot('A'), snapshot('B'), snapshot('C')], orders: [], executions: [], strategies: [] };
    const tuesday = { date: '2026-08-11', snapshots: [], orders: [], executions: [], strategies: [] };
    const out = buildReportReasons(clientWith({ registry, closes: [monday, tuesday] }), tuesday);
    expect(kinds(out)).toEqual([REASON_KINDS.NOTHING_COLLECTED]);
    expect(of(out, REASON_KINDS.NOTHING_COLLECTED)[0].headline).toContain('No account data reached us');
    expect(of(out, REASON_KINDS.ACCOUNTS_ABSENT)).toHaveLength(0);
  });
});

describe('stopped versus idle', () => {
  const registry = registryOf([{ accountName: 'BREACHED' }, { accountName: 'FINE1' }, { accountName: 'FINE2' }]);

  it('names the stopped account and counts the rest as reporting normally', () => {
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('BREACHED', { trailingMaxDrawdown: -263.04 }), snapshot('FINE1'), snapshot('FINE2')],
      orders: [{ accountName: 'BREACHED', state: 'Cancelled', filled: 0 }],
      executions: [],
      strategies: [],
    };
    const out = buildReportReasons(clientWith({ registry, closes: [close] }), close);
    const stopped = of(out, REASON_KINDS.ACCOUNT_STOPPED);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].accountName).toBe('BREACHED');
    expect(stopped[0].headline).toContain('past its trailing drawdown');
    expect(stopped[0].headline).toContain('2026-08-11');
    const idle = of(out, REASON_KINDS.ACCOUNTS_IDLE);
    expect(idle).toHaveLength(1);
    expect(idle[0].count).toBe(2);
  });

  it('says nothing at all about a clean quiet day', () => {
    // The contrast line is a qualifier on something material, never a finding.
    // "3 of your accounts did not trade" standing alone reads as an accusation.
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('FINE1'), snapshot('FINE2')],
      orders: [{ accountName: 'FINE1', state: 'Filled', filled: 1 }],
      executions: [],
      strategies: [],
    };
    const bothReport = registryOf([{ accountName: 'FINE1' }, { accountName: 'FINE2' }]);
    const out = buildReportReasons(clientWith({ registry: bothReport, closes: [close] }), close);
    expect(kinds(out)).toEqual([]);
    expect(out.unstated).toEqual([]);
    expect(out.hasAnything).toBe(false);
  });

  it('reads the close it was asked about, not the latest one on file', () => {
    // An account that breached on the 11th was not breached on the 10th, and a
    // report re-opened for the 10th must not backdate it.
    const monday = { date: '2026-08-10', snapshots: [snapshot('BREACHED', { trailingMaxDrawdown: 500 })], orders: [{ accountName: 'BREACHED', state: 'Filled', filled: 1 }], executions: [], strategies: [] };
    const tuesday = { date: '2026-08-11', snapshots: [snapshot('BREACHED', { trailingMaxDrawdown: -263.04 })], orders: [], executions: [], strategies: [] };
    const client = clientWith({ registry, closes: [monday, tuesday] });
    expect(of(buildReportReasons(client, monday), REASON_KINDS.ACCOUNT_STOPPED)).toHaveLength(0);
    expect(of(buildReportReasons(client, tuesday), REASON_KINDS.ACCOUNT_STOPPED)).toHaveLength(1);
  });
});
