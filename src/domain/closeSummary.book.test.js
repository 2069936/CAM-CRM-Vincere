// The stored per-close money, checked against the closes themselves, on the book.
//
// Gated: this file reads public/local-snapshot.json and is listed in
// vite.config.js localSnapshotTests, so it does NOT run on CI. The rules that
// must never break are in closeSummary.test.js, which is ungated. What is here
// is the claim a fixture cannot make: that over 96 clients, 485 closes and
// 3,100 account rows of real data, a desk figure read from summary rows and the
// same figure read from the rows themselves are the same object.
//
// WHY THAT IS THE WHOLE POINT. deskMoney.js exists because three surfaces on one
// screen each ran their own loop and disagreed by 3.1% on the day and 6.7% on
// the week, with the weekly figure sign-flipping between two of them on
// 2026-07-24. A stored summary is a fourth place that arithmetic could live.
// It is not one: `buildSegmentTotals` produces the rows and `buildSegmentTotals`
// adds them back up, so the only way these can diverge is if somebody writes a
// second segmentation — which is exactly the mutation this file fails on.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import {
  attachClientIds,
  buildCloseSummaryRows,
  closeSummaryFromRow,
  closeSummaryToDb,
  indexCloseSummaries,
} from './closeSummary';
import {
  buildDeskMoney,
  buildDeskMoneyForMonth,
  buildDeskMoneyHistory,
  bookCloses,
} from './deskMoney';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const state = buildCrmStateFromTables(snapshot.tables);
const { clients } = state;
const { latest } = bookCloses(clients);

/**
 * The book as a login holds it: every close's date, and none of its rows.
 *
 * This is the shape that matters. A manager's first screen renders the four
 * business rows, the reconciliation counts, ten closes of history and a month
 * out of this and nothing else, and until step 48 all of it came from 12,778
 * account rows and 14,514 strategy rows in the browser.
 */
const rows = [];
for (const client of clients) {
  for (const dailyImport of client.dailyImports) {
    for (const row of buildCloseSummaryRows({
      accountRegistry: client.accountRegistry,
      dailyImport,
    })) {
      rows.push(closeSummaryFromRow(closeSummaryToDb(row, {
        dailyImportId: dailyImport.uuid || dailyImport.id,
        clientId: client.uuid,
        tradingDate: dailyImport.date,
      })));
    }
  }
}
const summarised = clients.map((client) => ({
  ...client,
  dailyImports: client.dailyImports.map((dailyImport) => ({
    ...dailyImport,
    snapshots: [],
    strategies: [],
    orders: [],
    executions: [],
    simulation: { snapshots: [], strategies: [], orders: [], executions: [], undetermined: { snapshots: [] } },
    snapshotsLoaded: false,
    detailLoaded: false,
  })),
}));
const summaries = indexCloseSummaries(
  attachClientIds(rows, Object.fromEntries(clients.map((client) => [client.uuid, client.id]))),
  { registryByClientId: Object.fromEntries(clients.map((client) => [client.id, client.accountRegistry])) },
);

/** Money, to the cent, so a float's last bits are not mistaken for a figure. */
function toTheCent(segments) {
  return segments.map((row) => ({
    ...row,
    dailyPnl: Math.round(row.dailyPnl * 100) / 100,
    weeklyPnl: Math.round(row.weeklyPnl * 100) / 100,
    balance: Math.round(row.balance * 100) / 100,
  }));
}

describe('the summary against the book it came from', () => {
  it('is 913 rows over 485 closes, against 3,100 account rows and 3,805 strategy rows', () => {
    // 1.88 summary rows a close against 6.39 account rows plus 7.84 strategy
    // rows. That ratio is the argument for the table: the login stops growing
    // with the size of the book and starts growing with the number of closes.
    // Eight of the 913 are the marker rows of closes that carried no account
    // rows at all, which is how such a close says it was summarised.
    const closes = clients.reduce((total, client) => total + client.dailyImports.length, 0);
    expect(closes).toBe(485);
    expect(rows.length).toBe(913);
    expect(rows.filter((row) => row.accounts === 0)).toHaveLength(8);
    expect(rows.length / closes).toBeLessThan(2);
    expect(snapshot.tables.account_snapshots).toHaveLength(3100);
    expect(snapshot.tables.strategy_snapshots).toHaveLength(3805);
  });

  it('reads every close from its summary, with none stale', () => {
    // Nothing here has been reclassified since the rows were built one second
    // ago, so every close is readable. The staleness path is exercised in the
    // ungated sibling.
    expect(summaries.usable.size).toBe(485);
    expect(summaries.stale.size).toBe(0);
  });

  it('gives the same desk figure on the latest close as the account rows do', () => {
    // THE ASSERTION THIS FILE EXISTS FOR.
    const fromRows = buildDeskMoney(clients, { asOfDate: latest });
    const fromSummary = buildDeskMoney(summarised, { asOfDate: latest, summaries });
    expect(fromSummary.rows).toEqual(fromRows.rows);
    expect(fromSummary.reconciliation).toEqual(fromRows.reconciliation);
    // To the cent. The summary path rounds each close's own figures before
    // adding them, so the two differ in the last bits of a double and in
    // nothing else: -96904.94 against -96904.94000000002.
    expect(toTheCent(fromSummary.segments)).toEqual(toTheCent(fromRows.segments));
    expect(fromSummary.accountsSeen).toEqual(fromRows.accountsSeen);
  });

  it('gives the same figure on each client\'s own latest close', () => {
    // The default basis, and the one the headline tile actually renders: 427
    // accounts drawn from 8 different dates on the production book.
    const fromRows = buildDeskMoney(clients, {});
    const fromSummary = buildDeskMoney(summarised, { summaries });
    expect(fromSummary.rows).toEqual(fromRows.rows);
    expect(fromSummary.basis.label).toEqual(fromRows.basis.label);
    expect(fromSummary.basis.sources.summary).toBe(fromSummary.basis.clientsCounted);
    expect(fromSummary.basis.sources.loaded).toBe(0);
  });

  it('gives the same ten-close history strip', () => {
    const fromRows = buildDeskMoneyHistory(clients, { limit: 10 });
    const fromSummary = buildDeskMoneyHistory(summarised, { limit: 10, summaries });
    expect(fromSummary.map((cell) => cell.date)).toEqual(fromRows.map((cell) => cell.date));
    fromSummary.forEach((cell, index) => {
      expect({ date: cell.date, rows: cell.desk.rows })
        .toEqual({ date: cell.date, rows: fromRows[index].desk.rows });
    });
  });

  it('gives the same month, refusals and all', () => {
    const month = latest.slice(0, 7);
    const fromRows = buildDeskMoneyForMonth(clients, { month });
    const fromSummary = buildDeskMoneyForMonth(summarised, { month, summaries });
    expect(fromSummary.rows).toEqual(fromRows.rows);
    expect(fromSummary.reconciliation).toEqual(fromRows.reconciliation);
  });

  it('gives the same figure for every close on the book, one date at a time', () => {
    // Every close, not a sample: the one that disagrees is always the one with
    // an account nobody classified, and there are 51 of those here.
    const { closes } = bookCloses(clients);
    for (const date of closes) {
      const fromRows = buildDeskMoney(clients, { asOfDate: date });
      const fromSummary = buildDeskMoney(summarised, { asOfDate: date, summaries });
      expect({ date, rows: fromSummary.rows }).toEqual({ date, rows: fromRows.rows });
    }
  });
});
