// The stored per-close money, and the one rule it must never break.
//
// THE DEFECT THIS PINS. deskMoney.js exists because three surfaces on one
// screen each ran their own loop over the closes and disagreed: 3.1% apart on
// the day, 6.7% on the week, and on 2026-07-24 the weekly figure sign-flipped
// between two of them. A stored summary is a fourth place the same arithmetic
// could live, and the whole design rests on it not being one: the rows are
// produced by `buildSegmentTotals`, the same function the screen used to run,
// and reading them back has to give the same object the screen would have
// produced from the rows themselves.
//
// So the first test here is the one that matters: a desk figure built from
// summaries and the same figure built from the closes are DEEP EQUAL, field by
// field, refusals and basis included. The book-backed version of it, over 96
// clients and 485 closes, is the sibling closeSummary.book.test.js.

import { describe, expect, it } from 'vitest';
import {
  attachClientIds,
  buildCloseSummaryRows,
  closeSummaryFromRow,
  closeSummaryToDb,
  indexCloseSummaries,
} from './closeSummary';
import { buildDeskMoney, buildDeskMoneyForMonth, buildDeskMoneyHistory } from './deskMoney';
import { SEGMENTS } from './operationsSegments';

const account = (name, accountType, extra = {}) => ({
  id: `acct-${name}`, accountName: name, alias: name, accountType, ...extra,
});

const snapshot = (accountName, dailyPnl, weeklyPnl, balance) => ({
  accountName,
  grossRealizedPnl: dailyPnl,
  weeklyPnl,
  accountBalance: balance,
});

/**
 * A client holding all four businesses plus a simulated account, so the
 * comparison below covers a counted segment, an excluded one and the client
 * union that must never be added across rows.
 */
function makeClient({ id = 'c1', dates = ['2026-09-21', '2026-09-22'] } = {}) {
  const accountRegistry = {
    'BB-1': account('BB-1', 'Evaluation - Bullet Bot'),
    'FUND-1': account('FUND-1', 'Funded'),
    'CASH-1': account('CASH-1', 'Cash'),
    'NEW-1': account('NEW-1', 'Unassigned'),
    'SIM-1': account('SIM-1', 'Simulation'),
    'IGN-1': account('IGN-1', 'Ignore'),
  };
  return {
    id,
    name: `Client ${id}`,
    uuid: `uuid-${id}`,
    accountRegistry,
    dailyImports: dates.map((date, index) => ({
      id: `${id}-${date}`,
      uuid: `import-${id}-${date}`,
      clientId: id,
      date,
      snapshots: [
        snapshot('BB-1', 100 + index, 250, 50000),
        snapshot('FUND-1', -40.5, -120, 150000),
        snapshot('CASH-1', 12.25, 30, 9000),
        snapshot('NEW-1', 3, 3, 1000),
        // An account with no registry row: the close outlived the account.
        snapshot('GONE-1', -7, -7, 500),
      ],
      simulation: {
        snapshots: [snapshot('SIM-1', 999, 999, 1000000)],
        undetermined: { snapshots: [] },
      },
      strategies: [],
      orders: [],
      executions: [],
    })),
  };
}

/** The same client, with every close reachable only through its summary rows. */
function summarisedBook(clients) {
  const rows = [];
  for (const client of clients) {
    for (const dailyImport of client.dailyImports) {
      for (const row of buildCloseSummaryRows({
        accountRegistry: client.accountRegistry,
        dailyImport,
      })) {
        rows.push(closeSummaryFromRow(closeSummaryToDb(row, {
          dailyImportId: dailyImport.uuid,
          clientId: client.uuid,
          tradingDate: dailyImport.date,
        })));
      }
    }
  }
  const stripped = clients.map((client) => ({
    ...client,
    dailyImports: client.dailyImports.map((dailyImport) => ({
      ...dailyImport,
      snapshots: [],
      simulation: { snapshots: [], undetermined: { snapshots: [] } },
      snapshotsLoaded: false,
    })),
  }));
  const registryByClientId = Object.fromEntries(clients.map((c) => [c.id, c.accountRegistry]));
  const clientIdByUuid = Object.fromEntries(clients.map((c) => [c.uuid, c.id]));
  const summaries = indexCloseSummaries(attachClientIds(rows, clientIdByUuid), { registryByClientId });
  return { clients: stripped, summaries, rows };
}

describe('a close reduced to its segments', () => {
  it('produces one row per segment, and no total', () => {
    const client = makeClient();
    const rows = buildCloseSummaryRows({
      accountRegistry: client.accountRegistry,
      dailyImport: client.dailyImports[0],
    });
    const bySegment = Object.fromEntries(rows.map((row) => [row.segment, row]));
    expect(Object.keys(bySegment).sort()).toEqual([
      SEGMENTS.CASH,
      SEGMENTS.EVAL_BULLET,
      SEGMENTS.FUNDED,
      SEGMENTS.ORPHAN,
      SEGMENTS.SIMULATION,
      SEGMENTS.UNCLASSIFIED,
    ].sort());
    // There is no total here and there must never be one. See the header of
    // operationsSegments.js: a desk total adds real client cash to a prop
    // firm's simulated plan size and got the sign wrong twice in fourteen days.
    for (const row of rows) expect(row).not.toHaveProperty('total');
    expect(bySegment[SEGMENTS.SIMULATION].countedInTotal).toBe(false);
    expect(bySegment[SEGMENTS.ORPHAN].countedInTotal).toBe(false);
    expect(bySegment[SEGMENTS.CASH].countedInTotal).toBe(true);
  });

  it('names the accounts it counted, so a reclassification is detectable', () => {
    const client = makeClient();
    const rows = buildCloseSummaryRows({
      accountRegistry: client.accountRegistry,
      dailyImport: client.dailyImports[0],
    });
    const cash = rows.find((row) => row.segment === SEGMENTS.CASH);
    expect(cash.accountNames).toEqual(['CASH-1']);
    const orphan = rows.find((row) => row.segment === SEGMENTS.ORPHAN);
    expect(orphan.accountNames).toEqual(['GONE-1']);
  });

  it('counts the simulated close and keeps it out of the businesses', () => {
    const client = makeClient();
    const rows = buildCloseSummaryRows({
      accountRegistry: client.accountRegistry,
      dailyImport: client.dailyImports[0],
    });
    const sim = rows.find((row) => row.segment === SEGMENTS.SIMULATION);
    expect(sim.accounts).toBe(1);
    expect(sim.balance).toBe(1000000);
    expect(sim.countedInTotal).toBe(false);
  });
});

describe('the summary and the close give one answer', () => {
  it('produces a deep-equal desk figure from stored rows and from the snapshots', () => {
    // THE TEST THIS FILE EXISTS FOR. If these ever diverge, the desk has two
    // answers to "what did the team make today" again.
    const clients = [makeClient({ id: 'c1' }), makeClient({ id: 'c2' })];
    const { clients: stripped, summaries } = summarisedBook(clients);

    const fromRows = buildDeskMoney(clients, { asOfDate: '2026-09-22' });
    const fromSummary = buildDeskMoney(stripped, { asOfDate: '2026-09-22', summaries });

    expect(fromSummary.rows).toEqual(fromRows.rows);
    expect(fromSummary.reconciliation).toEqual(fromRows.reconciliation);
    expect(fromSummary.accountsSeen).toEqual(fromRows.accountsSeen);
    expect(fromSummary.segments).toEqual(fromRows.segments);
    expect(fromSummary.basis.label).toEqual(fromRows.basis.label);
  });

  it('agrees over a month and over the history strip', () => {
    const clients = [makeClient({ id: 'c1' }), makeClient({ id: 'c2' })];
    const { clients: stripped, summaries } = summarisedBook(clients);

    expect(buildDeskMoneyForMonth(stripped, { month: '2026-09', summaries }).rows)
      .toEqual(buildDeskMoneyForMonth(clients, { month: '2026-09' }).rows);

    const strip = buildDeskMoneyHistory(stripped, { limit: 10, summaries });
    const reference = buildDeskMoneyHistory(clients, { limit: 10 });
    expect(strip.map((cell) => cell.date)).toEqual(reference.map((cell) => cell.date));
    strip.forEach((cell, index) => expect(cell.desk.rows).toEqual(reference[index].desk.rows));
  });

  it('keeps the refusals the month carries', () => {
    // `weeklyAdditive: false` and `balanceComparable: false` have to survive
    // into the summary consumer, or the month re-grows the double count the
    // refusals exist for.
    const clients = [makeClient()];
    const { clients: stripped, summaries } = summarisedBook(clients);
    const month = buildDeskMoneyForMonth(stripped, { month: '2026-09', summaries });
    for (const row of month.rows) {
      expect(row.weeklyPnl).toBeNull();
      expect(row.refusals.weeklyPnl).toMatch(/Monday-to-Friday/);
    }
  });

  it('says how many closes it read from a summary and how many it walked', () => {
    const clients = [makeClient()];
    const { clients: stripped, summaries } = summarisedBook(clients);
    const desk = buildDeskMoney(stripped, { asOfDate: '2026-09-22', summaries });
    expect(desk.basis.sources).toEqual({
      summary: 1, loaded: 0, unreadable: 0, staleSummaries: 0,
    });
    expect(desk.basis.complete).toBe(true);
  });
});

describe('a close nobody can read is not a close that made nothing', () => {
  it('counts it rather than reporting a zero', () => {
    const clients = [makeClient()];
    const { clients: stripped, summaries } = summarisedBook(clients);
    // Drop the summary for the close on screen: no stored rows, no snapshots.
    summaries.usable.delete('import-c1-2026-09-22');
    const desk = buildDeskMoney(stripped, { asOfDate: '2026-09-22', summaries });
    expect(desk.basis.sources.unreadable).toBe(1);
    expect(desk.basis.complete).toBe(false);
    expect(desk.accountsSeen).toBe(0);
  });
});

describe('a reclassified account makes its stored rows stale', () => {
  it('refuses the close rather than reporting it under the old segment', () => {
    // buildCrmStateFromTables recomputes the split from each account's CURRENT
    // record on every load, deliberately, so a CAM correcting a
    // misclassification fixes every close the client ever had. A stored summary
    // freezes the classification, and this is what catches it.
    const clients = [makeClient()];
    const { rows } = summarisedBook(clients);
    const registryByClientId = {
      c1: { ...clients[0].accountRegistry, 'CASH-1': account('CASH-1', 'Funded') },
    };
    const summaries = indexCloseSummaries(
      attachClientIds(rows, { 'uuid-c1': 'c1' }),
      { registryByClientId },
    );
    expect(summaries.usable.size).toBe(0);
    expect(summaries.stale.size).toBe(2);
  });

  it('does not call an orphan close stale', () => {
    // An account deleted or renamed underneath its closes segments to ORPHAN
    // both when the row was written and now: segmentForAccount answers that
    // from the absence itself, so the row is still readable.
    const clients = [makeClient()];
    const { rows } = summarisedBook(clients);
    const summaries = indexCloseSummaries(
      attachClientIds(rows, { 'uuid-c1': 'c1' }),
      { registryByClientId: { c1: clients[0].accountRegistry } },
    );
    expect(summaries.stale.size).toBe(0);
    expect(summaries.usable.size).toBe(2);
  });
});

describe('the stored shape', () => {
  it('round-trips through the database column names', () => {
    const client = makeClient();
    const [row] = buildCloseSummaryRows({
      accountRegistry: client.accountRegistry,
      dailyImport: client.dailyImports[0],
    });
    const stored = closeSummaryToDb(row, {
      dailyImportId: 'import-1', clientId: 'uuid-c1', tradingDate: '2026-09-21',
    });
    expect(Object.keys(stored).sort()).toEqual([
      'account_names', 'accounts', 'balance', 'client_id', 'counted_in_total',
      'daily_pnl', 'daily_import_id', 'segment', 'trading_date', 'weekly_pnl',
    ].sort());
    const back = closeSummaryFromRow(stored);
    expect(back.segment).toBe(row.segment);
    expect(back.dailyPnl).toBe(row.dailyPnl);
    expect(back.countedInTotal).toBe(row.countedInTotal);
    expect(back.accountNames).toEqual(row.accountNames);
  });

  it('reads counted_in_total off the row and never re-derives it', () => {
    // The writer evaluated EXCLUDED_FROM_TOTAL; re-deriving it from the segment
    // name on the way back would be the second implementation this whole design
    // refuses. A row stored under an older rule still says what it meant.
    const back = closeSummaryFromRow({ segment: SEGMENTS.CASH, counted_in_total: false });
    expect(back.countedInTotal).toBe(false);
  });
});
