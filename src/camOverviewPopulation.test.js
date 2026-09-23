import { describe, expect, it } from 'vitest';
import { buildCamFundedRows } from './App.jsx';
import { ACCOUNT_STATUSES } from './domain/reconcile';
import { isChurnedClient } from './domain/clientLifecycle';

/* ------------------------------------------------------------------------- *
 * WHO A NUMBER ON THE CAM OVERVIEW COUNTS, AND OVER WHAT DAY.
 *
 * A CAM asked whether the Funded accounts panel was every funded account they
 * had ever had or the ones they have now, because clients they had marked
 * Inactive were still in it. It was neither, and nothing in the suite noticed:
 * the panel was built inline inside a render, so nothing could reach it.
 *
 * Two defects, both pinned here. The churn filter that was never applied, and
 * a status filter that matched nothing because it tested an account TYPE as if
 * it were a status.
 * ------------------------------------------------------------------------- */

function account(name, overrides = {}) {
  return {
    accountName: name,
    accountType: 'Funded',
    status: ACCOUNT_STATUSES.ACTIVE,
    maxDrawdownLimit: 2000,
    targetProfit: 3000,
    ...overrides,
  };
}

function client(id, { stage = 'Active', accounts = [], closes = [] } = {}) {
  return {
    id,
    name: `Client ${id}`,
    profile: { stage },
    accountRegistry: Object.fromEntries(accounts.map((a) => [a.accountName, a])),
    dailyImports: closes,
  };
}

function close(date, snapshots) {
  return { date, snapshots };
}

const LIVE_CLOSE = close('2026-09-23', [
  { accountName: 'A-1', grossRealizedPnl: 250, dailyNetPnl: -100, weeklyPnl: 900 },
]);

describe('the funded accounts panel', () => {
  it('drops retired accounts, which the old filter never could', () => {
    // It tested `status !== "Ignore"`. ACCOUNT_STATUSES has no such member:
    // "Inactive / Ignore" is an account TYPE. So the clause matched nothing and
    // every retired Funded account sat in the table on every CAM's book.
    const book = [client('c1', {
      accounts: [
        account('A-1'),
        account('A-2', { status: ACCOUNT_STATUSES.INACTIVE }),
        account('A-3', { status: ACCOUNT_STATUSES.FAILED }),
        account('A-4', { status: ACCOUNT_STATUSES.RESERVE }),
        account('A-5', { status: ACCOUNT_STATUSES.PAYOUT_HOLD }),
      ],
      closes: [LIVE_CLOSE],
    })];
    const names = buildCamFundedRows(book).map((row) => row.account.accountName);
    // Reserve and Payout Hold stay: they are live accounts in a particular
    // state, not retired ones.
    expect(names.sort()).toEqual(['A-1', 'A-4', 'A-5']);
  });

  it('counts only the clients it was given, so a churned one can be kept out', () => {
    // The panel took the CAM's whole book; the page's own working list sat two
    // hundred lines below the figures that needed it. The builder is pure now,
    // so the caller decides and the test can show both answers.
    const book = [
      client('live', { accounts: [account('A-1')], closes: [LIVE_CLOSE] }),
      client('gone', { stage: 'Inactive', accounts: [account('B-1')], closes: [close('2026-06-12', [
        { accountName: 'B-1', grossRealizedPnl: -40, dailyNetPnl: -1800, weeklyPnl: 0 },
      ])] }),
    ];
    expect(buildCamFundedRows(book)).toHaveLength(2);
    const working = book.filter((c) => !isChurnedClient(c));
    expect(buildCamFundedRows(working).map((r) => r.account.accountName)).toEqual(['A-1']);
  });

  it('carries the day each row was priced on, because it is not always today', () => {
    // Every number to the right of the client's name comes off that client's
    // last close. For a desk that has uploaded, that is today; for one that has
    // not, it is some Friday in July, and the column said "Today P&L" over all
    // of it.
    const june = close('2026-06-12', [
      { accountName: 'B-1', grossRealizedPnl: -40, dailyNetPnl: -1800, weeklyPnl: 0 },
    ]);
    const rows = buildCamFundedRows([
      client('a', { accounts: [account('A-1')], closes: [LIVE_CLOSE] }),
      client('b', { accounts: [account('B-1')], closes: [june] }),
    ]);
    expect(rows.map((row) => row.readDate)).toEqual(['2026-09-23', '2026-06-12']);
  });

  it('is why a stale row used to sort to the top of the risk list', () => {
    // The table orders by drawdown buffer ascending. A retired or departed
    // account with a thin buffer measured months ago outranked every live
    // account a CAM could still act on.
    const rows = buildCamFundedRows([
      client('a', { accounts: [account('A-1')], closes: [LIVE_CLOSE] }),
    ]);
    expect(rows[0].bufferPct).toBe(95);
    expect(rows[0].buffer).toBe(1900);
  });

  it('says nothing rather than guessing when a client has never closed', () => {
    const rows = buildCamFundedRows([
      client('new', { accounts: [account('N-1')], closes: [] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ readDate: null, todayPnl: null, buffer: null, bufferPct: null });
  });

  it('survives a book with pieces missing', () => {
    for (const book of [[], [{}], [{ accountRegistry: null }], [{ dailyImports: null }]]) {
      expect(() => buildCamFundedRows(book)).not.toThrow();
    }
    expect(buildCamFundedRows()).toEqual([]);
  });
});
