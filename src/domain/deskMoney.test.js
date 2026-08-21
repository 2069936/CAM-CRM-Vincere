// The guards that stop the desk's money becoming one number again.
//
// Synthetic on purpose, so CI runs them on a clone that does not hold
// public/local-snapshot.json. The figures measured off the real book live in
// deskMoney.book.test.js, which is gated and therefore NOT pinned by CI — every
// rule that must never be broken is stated here, on made-up numbers chosen so
// that breaking the rule produces a specific wrong answer this file names.

import { describe, expect, it } from 'vitest';
import {
  DESK_BUSINESS,
  buildDeskMoney,
  buildDeskMoneyForMonth,
  buildDeskMoneyHistory,
  closeAsOf,
  deskBusinessColumns,
  deskRow,
  formatDeskReport,
  monthFor,
} from './deskMoney';

const snapshot = (accountName, gross, over = {}) => ({
  accountName,
  grossRealizedPnl: gross,
  weeklyPnl: over.weekly ?? gross,
  accountBalance: over.balance ?? 0,
});

function client({ id, registry, closes }) {
  return {
    id,
    name: id,
    accountRegistry: registry,
    dailyImports: closes.map(([date, snapshots]) => ({ date, snapshots })),
  };
}

const bullet = { accountType: 'Evaluation - Bullet Bot' };
const funded = { accountType: 'Funded' };
const evalStandard = { accountType: 'Evaluation - Standard' };
const cash = { accountType: 'Cash - Straight' };
const ignore = { accountType: 'Inactive / Ignore' };

/**
 * The day that made the case: Bullet Bot up, the ordinary algorithms down by
 * more, cash up by more again, and one ignored account losing money on the side.
 *
 * Under the old arithmetic this book reads +$50 and green. Bullet Bot made
 * $1,000, the ordinary prop algorithms lost $1,200, cash made $300, and $50 of
 * it was an account somebody marked Inactive / Ignore.
 */
function mixedDesk() {
  return [
    client({
      id: 'c1',
      registry: { B1: bullet, F1: funded, C1: cash, X1: ignore },
      closes: [['2026-07-30', [
        snapshot('B1', 1000, { balance: 150000 }),
        snapshot('F1', -1200, { balance: 50000 }),
        snapshot('C1', 300, { balance: 42000 }),
        snapshot('X1', -50, { balance: 9000 }),
      ]]],
    }),
    client({
      id: 'c2',
      registry: { U1: { accountType: 'Unassigned' } },
      closes: [['2026-07-30', [snapshot('U1', -25, { balance: 7000 })]]],
    }),
  ];
}

describe('buildDeskMoney — there is no desk total, in any form', () => {
  it('exposes no `total` key on the object or on any row', () => {
    // THE GUARD. Not a documentation problem: a key named `total` gets rendered
    // by the next caller who wants a headline, which is how three surfaces ended
    // up publishing three different figures for the same question. Reading it
    // must be undefined, not merely discouraged.
    const desk = buildDeskMoney(mixedDesk());

    expect(desk.total).toBeUndefined();
    expect(Object.keys(desk)).not.toContain('total');
    expect(Object.keys(desk)).not.toContain('dailyPnl');
    expect(Object.keys(desk)).not.toContain('weeklyPnl');
    for (const row of desk.rows) expect(Object.keys(row)).not.toContain('total');
  });

  it('never renders the netted figure that the four rows would produce', () => {
    // +1000 - 1200 + 300 - 25 = +75, and with the ignored account +25. Neither
    // may appear as a figure anywhere in the object or in the report text.
    const desk = buildDeskMoney(mixedDesk());
    const figures = desk.rows.flatMap((row) => [row.dailyPnl, row.weeklyPnl, row.balance]);

    expect(figures).not.toContain(75);
    expect(figures).not.toContain(25);
    expect(formatDeskReport(desk, { title: 'x' })).not.toContain('$75');
  });
});

describe('buildDeskMoney — the four rows are four businesses', () => {
  it('keeps Bullet Bot apart from the other prop algorithms', () => {
    // On the real book these two carried OPPOSITE signs on 9 of 13 non-zero
    // days. Folded together, +1000 and -1200 report as "prop -200" and the
    // reader is told the bullet bot lost money on a day it made $1,000.
    const desk = buildDeskMoney(mixedDesk());

    expect(deskRow(desk, DESK_BUSINESS.BULLET).dailyPnl).toBe(1000);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-1200);
    expect(desk.rows.map((row) => row.dailyPnl)).not.toContain(-200);
  });

  it('keeps cash apart from prop', () => {
    const desk = buildDeskMoney(mixedDesk());

    expect(deskRow(desk, DESK_BUSINESS.CASH).dailyPnl).toBe(300);
    // prop + cash = -900 + 300 = -600, and the sign of the day flips with it.
    expect(desk.rows.map((row) => row.dailyPnl)).not.toContain(-600);
  });

  it('gives unclassified accounts their own row rather than folding them anywhere', () => {
    // 51 accounts and -$4,894.44 on the real book. A classification backlog, not
    // a result: adding it to prop calls it a trading loss, adding it to cash
    // calls it client money, and hiding it makes 51 accounts vanish.
    const desk = buildDeskMoney(mixedDesk());
    const row = deskRow(desk, DESK_BUSINESS.UNCLASSIFIED);

    expect(row.dailyPnl).toBe(-25);
    expect(row.accounts).toBe(1);
    expect(row.kind).toBe('backlog');
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-1200);
  });

  it('puts Funded and the standard evaluations in the same row, apart from Bullet Bot', () => {
    const desk = buildDeskMoney([client({
      id: 'c1',
      registry: { F1: funded, E1: evalStandard, B1: bullet },
      closes: [['2026-07-30', [
        snapshot('F1', -100, { balance: 50000 }),
        snapshot('E1', -50, { balance: 50000 }),
        snapshot('B1', 900, { balance: 50000 }),
      ]]],
    })]);

    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-150);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).accounts).toBe(2);
    expect(deskRow(desk, DESK_BUSINESS.BULLET).dailyPnl).toBe(900);
    // The netted "prop +750" that folding them together would produce.
    expect(desk.rows.map((row) => row.dailyPnl)).not.toContain(750);
  });

  it('reports an account type it has never been taught instead of dropping it', () => {
    const desk = buildDeskMoney([client({
      id: 'c1',
      registry: { N1: { accountType: 'Evaluation - New Thing' } },
      closes: [['2026-07-30', [snapshot('N1', -400, { balance: 1000 })]]],
    })]);

    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-400);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).segments)
      .toContain('Evaluation - New Thing');
  });

  it('hands a table the same keys and labels the rows carry', () => {
    // The history table puts one business in each column across ten closes and
    // looks each one up by key. A column list written out by hand at the call
    // site renders an empty column for every day the moment a key changes, and
    // reports nothing while looking fine.
    const desk = buildDeskMoney(mixedDesk());

    expect(deskBusinessColumns().map((column) => column.key))
      .toEqual(desk.rows.map((row) => row.key));
    expect(deskBusinessColumns().map((column) => column.label))
      .toEqual(desk.rows.map((row) => row.label));
    for (const column of deskBusinessColumns()) {
      expect(desk.rows.find((row) => row.key === column.key)).toBeDefined();
    }
  });

  it('keeps the rows in a fixed order, so a column means the same thing every day', () => {
    // The history table puts one row in each column across ten closes. Sorting
    // by size would move a business between columns from day to day, which hides
    // exactly the change of sign the table exists to show.
    const desk = buildDeskMoney(mixedDesk());

    expect(desk.rows.map((row) => row.key)).toEqual([
      DESK_BUSINESS.BULLET, DESK_BUSINESS.PROP_OTHER, DESK_BUSINESS.CASH, DESK_BUSINESS.UNCLASSIFIED,
    ]);
  });
});

describe('buildDeskMoney — a prop balance is never capital', () => {
  it('refuses a balance on the prop rows and reports the plan size instead', () => {
    const desk = buildDeskMoney(mixedDesk());
    const bulletRow = deskRow(desk, DESK_BUSINESS.BULLET);

    expect(bulletRow.balance).toBeNull();
    expect(bulletRow.planSize).toBe(150000);
    expect(bulletRow.refusals.balance).toMatch(/plan size the firm simulates/);
  });

  it('gives cash a balance, because cash is the client’s real money', () => {
    const desk = buildDeskMoney(mixedDesk());
    const cashRow = deskRow(desk, DESK_BUSINESS.CASH);

    expect(cashRow.balance).toBe(42000);
    expect(cashRow.planSize).toBeNull();
    expect(cashRow.refusals.balance).toBeUndefined();
  });

  it('refuses a balance on unclassified too', () => {
    // 67 of the 68 unclassified accounts on the real book carry a prop-firm
    // connection. Calling their balance capital is the prop mistake under a
    // label nobody has set yet.
    const row = deskRow(buildDeskMoney(mixedDesk()), DESK_BUSINESS.UNCLASSIFIED);

    expect(row.balance).toBeNull();
    expect(row.refusals.balance).toMatch(/Not reported as capital/);
  });
});

describe('buildDeskMoney — ignored and orphan are a count, not money', () => {
  it('carries no money field at all on a reconciliation row', () => {
    // The gap between the old tile and the old history strip WAS these rows,
    // exactly, on every close. They are reported so the backlog is visible and
    // stripped of every money field so nothing downstream can add them back.
    const desk = buildDeskMoney(mixedDesk());
    const ignored = desk.reconciliation.rows.find((row) => row.key === 'ignored');

    expect(ignored.accounts).toBe(1);
    expect(ignored.dailyPnl).toBeUndefined();
    expect(ignored.weeklyPnl).toBeUndefined();
    expect(ignored.balance).toBeUndefined();
    expect(Object.keys(ignored).sort())
      .toEqual(['accounts', 'clients', 'key', 'label', 'note', 'segment']);
  });

  it('counts a close whose account is not on the registry', () => {
    const desk = buildDeskMoney([client({
      id: 'c1',
      registry: {},
      closes: [['2026-07-30', [snapshot('GONE', -300, { balance: 5000 })]]],
    })]);

    expect(desk.reconciliation.rows.find((row) => row.key === 'orphan').accounts).toBe(1);
    expect(desk.rows.every((row) => row.accounts === 0)).toBe(true);
  });

  it('omits a reconciliation row nobody has, rather than printing a zero', () => {
    const desk = buildDeskMoney([client({
      id: 'c1', registry: { C1: cash }, closes: [['2026-07-30', [snapshot('C1', 1)]]],
    })]);

    expect(desk.reconciliation.rows).toEqual([]);
    expect(desk.reconciliation.accounts).toBe(0);
  });
});

describe('buildDeskMoney — every figure states its date basis', () => {
  const staggered = () => [
    client({ id: 'fresh', registry: { C1: cash }, closes: [
      ['2026-07-29', [snapshot('C1', 10, { balance: 1000 })]],
      ['2026-07-30', [snapshot('C1', 20, { balance: 1020 })]],
    ] }),
    client({ id: 'stale', registry: { C2: cash }, closes: [
      ['2026-07-13', [snapshot('C2', -5, { balance: 500 })]],
    ] }),
    client({ id: 'silent', registry: { C3: cash }, closes: [] }),
  ];

  it('says how many dates the default view is drawn from and how many clients are behind', () => {
    // The default is not one day and never was: with no date pinned every
    // client contributes their LAST close whatever date that is. On the real
    // book that is 427 accounts from 8 different dates, injecting -$3,752.98 of
    // P&L from up to 17 days earlier into a figure printed under one heading.
    const desk = buildDeskMoney(staggered());

    expect(desk.basis.mode).toBe('latest-per-client');
    expect(desk.basis.dates).toEqual(['2026-07-13', '2026-07-30']);
    expect(desk.basis.dateCount).toBe(2);
    expect(desk.basis.latestClose).toBe('2026-07-30');
    expect(desk.basis.clientsOffLatestClose).toBe(1);
    expect(desk.basis.clientsWithoutClose).toBe(1);
    expect(desk.basis.singleDate).toBe(false);
    expect(desk.basis.label).toContain('2 dates');
    expect(desk.basis.label).toContain('1 of them last closed before 2026-07-30');
  });

  it('says which close it is on, and how many clients missed it, when a date is pinned', () => {
    const desk = buildDeskMoney(staggered(), { asOfDate: '2026-07-30' });

    expect(desk.basis.mode).toBe('close');
    expect(desk.basis.singleDate).toBe(true);
    expect(desk.basis.label).toBe('Close of 2026-07-30 · 1 of 3 clients reported');
    expect(deskRow(desk, DESK_BUSINESS.CASH).dailyPnl).toBe(20);
  });

  it('reads each client’s last close when nothing is pinned, and only that close', () => {
    const desk = buildDeskMoney(staggered());

    // 20 from the fresh client's 07-30 and -5 from the stale client's 07-13.
    // The fresh client's 07-29 close is NOT in it.
    expect(deskRow(desk, DESK_BUSINESS.CASH).dailyPnl).toBe(15);
  });

  it('answers with a stated absence when there is no close at all', () => {
    const desk = buildDeskMoney([client({ id: 'c1', registry: { C1: cash }, closes: [] })]);

    expect(desk.basis.label).toBe('No close in view.');
    expect(desk.basis.latestClose).toBeNull();
    expect(desk.rows.every((row) => row.dailyPnl === 0 && row.accounts === 0)).toBe(true);
  });
});

describe('buildDeskMoneyForMonth — the month keys off the page, not the wall clock', () => {
  const july = () => [client({
    id: 'c1',
    registry: { C1: cash, B1: bullet },
    closes: [
      ['2026-07-29', [snapshot('C1', 10, { weekly: 10, balance: 1000 }), snapshot('B1', 5, { weekly: 5, balance: 50000 })]],
      ['2026-07-30', [snapshot('C1', 20, { weekly: 30, balance: 1020 }), snapshot('B1', -5, { weekly: 0, balance: 49995 })]],
      ['2026-08-03', [snapshot('C1', 99, { weekly: 99, balance: 1119 })]],
    ],
  })];

  it('takes the month from the date on screen', () => {
    expect(monthFor(july(), '2026-07-30')).toBe('2026-07');
    // With nothing pinned it is the month of the newest close on the BOOK, not
    // the month the browser happens to be open in. `new Date()` rendered
    // "Monthly P&L (2026-08) $0.00" over a July book, with July unreachable.
    expect(monthFor(july(), '')).toBe('2026-08');
    expect(monthFor([], '')).toBe('');
  });

  it('adds every close in the month, per business', () => {
    const month = buildDeskMoneyForMonth(july(), { month: '2026-07' });

    expect(deskRow(month, DESK_BUSINESS.CASH).dailyPnl).toBe(30);
    expect(deskRow(month, DESK_BUSINESS.BULLET).dailyPnl).toBe(0);
    expect(month.basis.label).toBe('Every close in 2026-07 · 2 dates · 1 client');
  });

  it('refuses the weekly figure over a month instead of double-counting it', () => {
    // weeklyPnl is a Monday-to-Friday accumulator. Adding 10 + 30 across two
    // closes of the same week counts Tuesday's trades twice and reports 40 for a
    // week that made 30.
    const month = buildDeskMoneyForMonth(july(), { month: '2026-07' });
    const row = deskRow(month, DESK_BUSINESS.CASH);

    expect(row.weeklyPnl).toBeNull();
    expect(row.refusals.weeklyPnl).toMatch(/accumulator/);
  });

  it('refuses a balance over a month, because a balance is a level', () => {
    const row = deskRow(buildDeskMoneyForMonth(july(), { month: '2026-07' }), DESK_BUSINESS.CASH);

    expect(row.balance).toBeNull();
    expect(row.refusals.balance).toMatch(/level, not a flow/);
  });

  it('counts account closes over a month and says so, rather than calling them accounts', () => {
    // One cash account reporting on two closes is 2 account closes, not 2
    // accounts. On the real book the July figure rests on 1,234 Bullet Bot
    // account closes over a desk that holds 236 such accounts.
    const month = buildDeskMoneyForMonth(july(), { month: '2026-07' });

    expect(deskRow(month, DESK_BUSINESS.CASH).accounts).toBe(2);
    expect(month.basis.countNoun).toBe('account close');
    expect(buildDeskMoney(july()).basis.countNoun).toBe('account');
  });
});

describe('one computation, one answer', () => {
  it('gives the history strip exactly what the panel would show for that close', () => {
    // THE GUARD FOR ITEM 1. The tile, the strip and the clipboard text used to
    // be three loops; they disagreed by 3.1% on the day, 6.7% on the week, and
    // on one close they disagreed about the SIGN of the week. This is the
    // assertion that they are now one function called three times.
    const clients = mixedDesk();
    const [cell] = buildDeskMoneyHistory(clients, { limit: 10 });

    expect(cell.date).toBe('2026-07-30');
    expect(cell.desk).toEqual(buildDeskMoney(clients, { asOfDate: '2026-07-30' }));
  });

  it('walks the closes oldest first and honours the limit', () => {
    const clients = [client({
      id: 'c1',
      registry: { C1: cash },
      closes: [
        ['2026-07-13', [snapshot('C1', 1)]],
        ['2026-07-14', [snapshot('C1', 2)]],
        ['2026-07-15', [snapshot('C1', 3)]],
      ],
    })];

    expect(buildDeskMoneyHistory(clients, { limit: 2 }).map((cell) => cell.date))
      .toEqual(['2026-07-14', '2026-07-15']);
  });

  it('prints the clipboard text from the same rows, with the basis on it', () => {
    const desk = buildDeskMoney(mixedDesk());
    const month = buildDeskMoneyForMonth(mixedDesk(), { month: '2026-07' });
    const text = formatDeskReport(desk, { title: 'Desk daily report', month, openFlags: 3 });

    expect(text).toContain(desk.basis.label);
    expect(text).toContain('These lines are not added together.');
    expect(text).toContain('Bullet Bot: day +$1,000');
    expect(text).toContain('Other prop algos: day -$1,200');
    expect(text).toContain('Cash: day +$300');
    expect(text).toContain('cash held $42,000');
    expect(text).toContain('Marked Inactive / Ignore: 1 account');
    expect(text).toContain('Open flags: 3');
    // And the figure it must never print: one number for the desk.
    expect(text).not.toMatch(/Team daily P&L/);
  });

  it('prints each CAM through the same four businesses', () => {
    const desk = buildDeskMoney(mixedDesk());
    const text = formatDeskReport(desk, {
      title: 'Desk daily report',
      cams: [{ name: 'Maria', clients: 2, desk }],
    });

    expect(text).toContain('*Maria* (2 clients)');
    expect(text).toContain('Bullet Bot: +$1,000');
    expect(text).toContain('Prop algos: -$1,200');
  });
});

describe('closeAsOf', () => {
  it('returns the pinned close, the last close, or nothing — never a neighbour', () => {
    const subject = client({
      id: 'c1',
      registry: {},
      closes: [['2026-07-13', []], ['2026-07-30', []]],
    });

    expect(closeAsOf(subject, '2026-07-13').date).toBe('2026-07-13');
    expect(closeAsOf(subject, '').date).toBe('2026-07-30');
    expect(closeAsOf(subject, '2026-07-20')).toBeNull();
    expect(closeAsOf(null, '')).toBeNull();
  });
});
