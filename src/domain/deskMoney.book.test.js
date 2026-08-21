// What the desk's money reads on the real book, figure by figure.
//
// Gated: this file reads public/local-snapshot.json and is listed in
// vite.config.js localSnapshotTests, so it does NOT run on CI. The rules that
// must never break are in deskMoney.test.js, which is ungated. What is here is
// the arithmetic against 96 clients, 764 accounts and 14 closes — the part a
// synthetic fixture cannot check, because the defect these figures document was
// never visible on a fixture.
//
// THE NUMBERS THIS FILE PINS, and where they came from:
//
//   Three answers to "team daily P&L" were on screen at once. The tile summed
//   each client's last close after a segment filter (-$169,926.90 / 427), the
//   history strip summed the same closes with NO filter (-$172,979.64 / 333 on
//   its last cell), and the clipboard text summed them with no filter over a
//   wider cohort again (-$175,206.02 / 457). All three are reconstructed below
//   from the four business rows, so that if the decomposition ever stops adding
//   back to them, this file says so.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DESK_BUSINESS,
  buildDeskMoney,
  buildDeskMoneyForMonth,
  buildDeskMoneyHistory,
  deskRow,
  formatDeskReport,
  monthFor,
} from './deskMoney';
import { buildCapitalDetail } from './capitalDetail';
import { SEGMENTS } from './operationsSegments';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

const LATEST_CLOSE = '2026-07-30';
const round2 = (value) => Math.round(value * 100) / 100;
const sumOf = (desk, field) => round2(desk.rows.reduce((sum, row) => sum + row[field], 0));

describe('the desk on its default view — each client’s latest close', () => {
  const desk = buildDeskMoney(clients);

  it('decomposes the old headline into four rows that add back to it exactly', () => {
    expect(deskRow(desk, DESK_BUSINESS.BULLET).dailyPnl).toBe(-96487.98);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-42200.94);
    expect(deskRow(desk, DESK_BUSINESS.CASH).dailyPnl).toBe(-26343.54);
    expect(deskRow(desk, DESK_BUSINESS.UNCLASSIFIED).dailyPnl).toBe(-4894.44);

    // The tile's old figure, reconstructed. It is checked here and printed
    // nowhere: it is a cash desk's real client money added to a prop desk's
    // simulated plan-size result, with Bullet Bot netted against the ordinary
    // algorithms inside it.
    expect(sumOf(desk, 'dailyPnl')).toBe(-169926.9);
    expect(desk.rows.reduce((sum, row) => sum + row.accounts, 0)).toBe(427);
  });

  it('reconstructs the clipboard text’s old figure as the rows plus the reconciliation', () => {
    // -$175,206.02 over 457 accounts was the third answer, and the whole of its
    // gap against the tile was accounts marked Inactive / Ignore plus closes
    // whose account is no longer on record.
    const ignoredAndOrphan = desk.segments
      .filter((row) => row.segment === SEGMENTS.IGNORED || row.segment === SEGMENTS.ORPHAN);

    expect(round2(sumOf(desk, 'dailyPnl')
      + ignoredAndOrphan.reduce((sum, row) => sum + row.dailyPnl, 0))).toBe(-175206.02);
    expect(desk.accountsSeen).toBe(457);
    expect(desk.reconciliation.rows.map((row) => [row.key, row.accounts]))
      .toEqual([['ignored', 9], ['orphan', 21]]);
    expect(desk.reconciliation.accounts).toBe(30);
  });

  it('carries the week per business, where the old strip and tile disagreed on sign', () => {
    expect(deskRow(desk, DESK_BUSINESS.BULLET).weeklyPnl).toBe(-95354.14);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).weeklyPnl).toBe(-91821.92);
    expect(deskRow(desk, DESK_BUSINESS.CASH).weeklyPnl).toBe(-44336.56);
    expect(deskRow(desk, DESK_BUSINESS.UNCLASSIFIED).weeklyPnl).toBe(-609.51);
    expect(sumOf(desk, 'weeklyPnl')).toBe(-232122.13);
  });

  it('states that the default view is eight different dates, not one day', () => {
    // 13 clients last closed 2026-07-13, seventeen days before the newest close
    // on the book, and their P&L and their balances were inside a figure printed
    // under a single heading.
    expect(desk.basis.mode).toBe('latest-per-client');
    expect(desk.basis.dateCount).toBe(8);
    expect(desk.basis.dates).toEqual([
      '2026-07-13', '2026-07-14', '2026-07-22', '2026-07-23',
      '2026-07-24', '2026-07-27', '2026-07-28', LATEST_CLOSE,
    ]);
    expect(desk.basis.latestClose).toBe(LATEST_CLOSE);
    expect(desk.basis.clientsInScope).toBe(96);
    expect(desk.basis.clientsCounted).toBe(84);
    expect(desk.basis.clientsWithoutClose).toBe(12);
    expect(desk.basis.clientsOnLatestClose).toBe(58);
    expect(desk.basis.clientsOffLatestClose).toBe(26);
    expect(desk.basis.label).toBe(
      'Latest close per client across 8 dates · 84 clients'
      + ' · 26 of them last closed before 2026-07-30',
    );
  });

  it('shows cash a balance and refuses one to the $18.7m of prop plan size', () => {
    // $30,287,682.82 of the old $32,244,234.16 "capital held" was plan size the
    // prop firm simulates. Here the two prop rows carry $18,696,559.91 of it on
    // the closes in view, under a name no renderer will print as capital.
    expect(deskRow(desk, DESK_BUSINESS.CASH).balance).toBe(1897596);
    expect(deskRow(desk, DESK_BUSINESS.BULLET).balance).toBeNull();
    expect(deskRow(desk, DESK_BUSINESS.BULLET).planSize).toBe(8420175.8);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).planSize).toBe(10276384.11);
    expect(deskRow(desk, DESK_BUSINESS.UNCLASSIFIED).balance).toBeNull();
  });

  it('counts the clients behind each business without adding them up', () => {
    expect(deskRow(desk, DESK_BUSINESS.BULLET).clients).toBe(42);
    expect(deskRow(desk, DESK_BUSINESS.PROP_OTHER).clients).toBe(49);
    expect(deskRow(desk, DESK_BUSINESS.CASH).clients).toBe(22);
    expect(deskRow(desk, DESK_BUSINESS.UNCLASSIFIED).clients).toBe(9);
    // 42 + 49 + 22 + 9 = 122 against 84 clients on the book: the counts overlap
    // and are never summed.
    expect(desk.rows.reduce((sum, row) => sum + row.clients, 0)).toBeGreaterThan(84);
  });
});

describe('the two days the old headline had the sign wrong', () => {
  const history = Object.fromEntries(
    buildDeskMoneyHistory(clients, { limit: 14 }).map((cell) => [cell.date, cell.desk]),
  );

  it('2026-07-21: the tile read green at +$605.79 while the prop desk lost $5,505.46', () => {
    const day = history['2026-07-21'];
    const bullet = deskRow(day, DESK_BUSINESS.BULLET).dailyPnl;
    const other = deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl;

    expect(bullet).toBe(-6590.26);
    expect(other).toBe(1084.8);
    expect(round2(bullet + other)).toBe(-5505.46);
    expect(deskRow(day, DESK_BUSINESS.CASH).dailyPnl).toBe(6111.25);
    // Cash carried the day, and adding the two flipped the colour of the tile.
    expect(sumOf(day, 'dailyPnl')).toBe(605.79);
  });

  it('2026-07-16: the tile read red at -$5,890.50 while prop MADE $1,647.50', () => {
    const day = history['2026-07-16'];
    const bullet = deskRow(day, DESK_BUSINESS.BULLET).dailyPnl;
    const other = deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl;

    expect(bullet).toBe(4805);
    expect(other).toBe(-3157.5);
    expect(round2(bullet + other)).toBe(1647.5);
    expect(deskRow(day, DESK_BUSINESS.CASH).dailyPnl).toBe(-7538);
    expect(sumOf(day, 'dailyPnl')).toBe(-5890.5);
  });

  it('2026-07-13: "prop -$5,070.50" was +$14,861.50 netted against -$19,932.00', () => {
    const day = history['2026-07-13'];

    expect(deskRow(day, DESK_BUSINESS.BULLET).dailyPnl).toBe(14861.5);
    expect(deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-19932);
    expect(round2(14861.5 - 19932)).toBe(-5070.5);
  });

  it('has Bullet Bot and the other prop algos on opposite signs on most closes', () => {
    // "Non-zero" means both businesses traded: 2026-07-25 carried 7 closes and
    // Bullet Bot did nothing on it, so it cannot be a day the two disagreed.
    const days = Object.values(history)
      .filter((day) => deskRow(day, DESK_BUSINESS.BULLET).dailyPnl !== 0
        && deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl !== 0);
    const opposed = days.filter((day) => {
      const bullet = deskRow(day, DESK_BUSINESS.BULLET).dailyPnl;
      const other = deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl;
      return (bullet > 0) !== (other > 0);
    });

    expect(days).toHaveLength(13);
    expect(opposed).toHaveLength(9);
  });

  it('makes Bullet Bot 71.0% of what prop did on the newest close', () => {
    const day = history[LATEST_CLOSE];
    const bullet = deskRow(day, DESK_BUSINESS.BULLET).dailyPnl;
    const other = deskRow(day, DESK_BUSINESS.PROP_OTHER).dailyPnl;

    expect(bullet).toBe(-96904.94);
    expect(other).toBe(-39595.64);
    expect(Math.round((bullet / (bullet + other)) * 1000) / 10).toBe(71);
  });
});

describe('the history strip and the panel are the same computation', () => {
  it('gives the newest cell exactly what the panel pinned to that date gives', () => {
    const cell = buildDeskMoneyHistory(clients, { limit: 10 }).at(-1);

    expect(cell.date).toBe(LATEST_CLOSE);
    expect(cell.desk).toEqual(buildDeskMoney(clients, { asOfDate: LATEST_CLOSE }));
  });

  it('recovers the strip’s old last cell as the rows plus the reconciliation money', () => {
    // -$172,979.64 over 333 accounts, and the whole of its gap against the
    // tile's -$169,926.90 was Ignored + Orphan — on every one of the 14 closes,
    // residual $0.00.
    const day = buildDeskMoney(clients, { asOfDate: LATEST_CLOSE });
    const leftOut = day.segments
      .filter((row) => row.segment === SEGMENTS.IGNORED || row.segment === SEGMENTS.ORPHAN)
      .reduce((sum, row) => sum + row.dailyPnl, 0);

    expect(round2(sumOf(day, 'dailyPnl') + leftOut)).toBe(-172979.64);
    expect(day.rows.reduce((sum, row) => sum + row.accounts, 0) + day.reconciliation.accounts)
      .toBe(333);
  });

  it('decomposes the tile-versus-strip gap to Ignored + Orphan on every close, residual $0.00', () => {
    for (const cell of buildDeskMoneyHistory(clients, { limit: 14 })) {
      const unfiltered = cell.desk.segments
        .reduce((sum, row) => sum + row.dailyPnl, 0);
      const rows = cell.desk.rows.reduce((sum, row) => sum + row.dailyPnl, 0);
      const reconciliationMoney = cell.desk.segments
        .filter((row) => !row.countedInTotal)
        .reduce((sum, row) => sum + row.dailyPnl, 0);

      expect(Math.abs(unfiltered - rows - reconciliationMoney)).toBeLessThan(0.005);
    }
  });

  it('prints the clipboard text from the same object, basis line and all', () => {
    const desk = buildDeskMoney(clients);
    const text = formatDeskReport(desk, { title: 'Desk daily report' });

    expect(text).toContain('Latest close per client across 8 dates');
    expect(text).toContain('Bullet Bot: day -$96,488 · week -$95,354 · 168 accounts');
    expect(text).toContain('Other prop algos: day -$42,201');
    expect(text).toContain('Cash: day -$26,344 · week -$44,337 · 47 accounts · cash held $1,897,596');
    expect(text).toContain('Unclassified: day -$4,894');
    expect(text).toContain('Marked Inactive / Ignore: 9 accounts');
    expect(text).toContain('No account on record: 21 accounts');
    // The three figures the three old surfaces printed, none of which may appear.
    for (const wrong of ['$169,927', '$172,980', '$175,206']) {
      expect(text).not.toContain(wrong);
    }
  });
});

describe('the month, keyed off the page rather than the wall clock', () => {
  const month = buildDeskMoneyForMonth(clients, { month: monthFor(clients, '') });

  it('reports July from the newest close on the book, not the browser’s month', () => {
    expect(monthFor(clients, '')).toBe('2026-07');
    expect(monthFor(clients, '2026-07-13')).toBe('2026-07');
    expect(month.basis.label).toBe('Every close in 2026-07 · 14 dates · 84 clients');
  });

  it('splits July’s -$375,696.25 into four businesses and -$8,385.58 of reconciliation', () => {
    // The old monthly tile applied NO segment filter, so accounts marked
    // Inactive / Ignore and closes with no account on record were 2.2% of it,
    // and cash — real client money — was 26.0% of a figure printed as one number.
    expect(deskRow(month, DESK_BUSINESS.BULLET).dailyPnl).toBe(-97888.52);
    expect(deskRow(month, DESK_BUSINESS.PROP_OTHER).dailyPnl).toBe(-166205.23);
    expect(deskRow(month, DESK_BUSINESS.CASH).dailyPnl).toBe(-97810.32);
    expect(deskRow(month, DESK_BUSINESS.UNCLASSIFIED).dailyPnl).toBe(-5406.6);
    expect(sumOf(month, 'dailyPnl')).toBe(-367310.67);

    const leftOut = month.segments
      .filter((row) => !row.countedInTotal)
      .reduce((sum, row) => sum + row.dailyPnl, 0);
    expect(round2(leftOut)).toBe(-8385.58);
    expect(round2(sumOf(month, 'dailyPnl') + leftOut)).toBe(-375696.25);
    expect((-97810.32 / -375696.25) * 100).toBeCloseTo(26, 1);
  });

  it('counts account closes, not accounts, and refuses the week and the balance', () => {
    expect(month.basis.countNoun).toBe('account close');
    expect(deskRow(month, DESK_BUSINESS.BULLET).accounts).toBe(1234);
    expect(deskRow(month, DESK_BUSINESS.CASH).accounts).toBe(294);
    for (const row of month.rows) {
      expect(row.weeklyPnl).toBeNull();
      expect(row.balance).toBeNull();
    }
  });
});

describe('desk money and the capital panel answer with the same cash', () => {
  it('agrees on the cash cross-section of the newest close', () => {
    // Two modules, two code paths — deskMoney reads the close, buildCapitalDetail
    // reads each account's balance series — and they must land on the same real
    // client money for the same date. This is the check that the capital panel
    // and the desk rows cannot drift.
    const pinned = buildDeskMoney(clients, { asOfDate: LATEST_CLOSE });
    const detail = buildCapitalDetail(clients);
    const cashBlock = detail.segments.find((block) => block.segment === SEGMENTS.CASH);

    expect(deskRow(pinned, DESK_BUSINESS.CASH).balance).toBe(1369035.6);
    expect(cashBlock.held.atLatestClose.capital).toBe(1369035.6);
    expect(cashBlock.held.atLatestClose.accounts)
      .toBe(deskRow(pinned, DESK_BUSINESS.CASH).accounts);
  });

  it('publishes no capital figure for the desk, and gives prop its movement instead', () => {
    const detail = buildCapitalDetail(clients);

    expect(detail.desk.held.capital).toBeNull();
    // The three movement figures the audit asked for, in place of a plan size
    // printed as capital.
    const netOf = (segment) => detail.segments
      .find((block) => block.segment === segment).movement.tradingPnl.net;
    expect(netOf(SEGMENTS.EVAL_BULLET)).toBe(-118038.8);
    expect(netOf(SEGMENTS.FUNDED)).toBe(-100961.28);
    expect(netOf(SEGMENTS.EVAL_STANDARD)).toBe(-26605.32);
    // And cash keeps its balance.
    expect(detail.segments.find((block) => block.segment === SEGMENTS.CASH).held.capital)
      .toBe(1897596);
  });
});
