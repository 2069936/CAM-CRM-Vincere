import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_ORDER,
  bookLatestDateOf,
  buildLiveAccounts,
  buildLiveBook,
  periodOf,
} from './liveAccounts';
import { buildCrmStateFromTables } from './supabaseStore';

// Every count in the "real book" blocks was read off public/local-snapshot.json
// by rendering it, not by trusting the code. They are the point of this file:
// 595 live accounts, 121 running, 179 with no strategy row at all, and 158 rows
// whose numbers come from a close EARLIER than their client's most recent one.
// That last number is the bug this module exists to fix — those 158 accounts are
// exactly the rows a single header date would mislabel.

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

function fakeClient(overrides = {}) {
  return {
    id: 'c1',
    name: 'Test Client',
    accountRegistry: {},
    dailyImports: [],
    ...overrides,
  };
}

function close(date, snapshots, extra = {}) {
  return { id: `di-${date}`, date, snapshots, orders: [], executions: [], ...extra };
}

function accountSnapshot(accountName, strategies = [], numbers = {}) {
  return {
    accountName,
    grossRealizedPnl: 0,
    unrealizedPnl: 0,
    accountBalance: 50000,
    weeklyPnl: 0,
    trailingMaxDrawdown: 0,
    ...numbers,
    strategies,
  };
}

function strategy(strategyName, enabled, extra = {}) {
  return { strategyName, enabled, instrument: 'MNQ SEP26', realized: 0, unrealized: 0, ...extra };
}

describe('periodOf', () => {
  it('reads the period off the name prefix', () => {
    expect(periodOf('0 - URGO-4.5')).toBe(0);
    expect(periodOf('1 - OGX-PF-2.4')).toBe(1);
    expect(periodOf('2 - SYFY-1.4')).toBe(2);
  });

  it('tolerates the missing space around the dash', () => {
    // 4 rows on the real book are written this way. A stricter pattern drops
    // them into the unknown bucket and silently understates period 0.
    expect(periodOf('0-Bullet Bot-1.1')).toBe(0);
    expect(periodOf('  1-  RBO-1.8 ')).toBe(1);
  });

  it('returns null, never 0, when there is no prefix', () => {
    // 645 of 3805 strategy rows on the real book — 642 bare `Bullet Bot-1.1`
    // plus 3 `IFSP-PF-1.1`. Calling these period 0 would move 642 rows into a
    // group the set-file library says they cannot have come from.
    expect(periodOf('Bullet Bot-1.1')).toBeNull();
    expect(periodOf('IFSP-PF-1.1')).toBeNull();
    expect(periodOf('')).toBeNull();
    expect(periodOf(null)).toBeNull();
    expect(periodOf(undefined)).toBeNull();
  });

  it('does not mistake a version for a period', () => {
    expect(periodOf('1.1')).toBeNull();
    expect(periodOf('URGO-4.5')).toBeNull();
  });
});

describe('buildLiveAccounts — the calendar cannot empty it out', () => {
  it('shows the most recent close that exists, whatever the bound', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A one', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        close('2026-07-13', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])]),
        close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])]),
      ],
    });

    // The failing case in the workspace today: a date with no import at all.
    // getClientImportByDate returns null here and the whole screen empties.
    const view = buildLiveAccounts(client, { asOfDate: '' });
    expect(view.latestCloseDate).toBe('2026-07-30');
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0].asOfDate).toBe('2026-07-30');
  });

  it('treats asOfDate as a bound, not an exact match', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A one', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        close('2026-07-13', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])]),
        close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])]),
      ],
    });

    // 2026-07-20 has no close. Exact-match lookup gives null; a bound gives the
    // 13th, which is the honest answer to "how did this stand on the 20th".
    const view = buildLiveAccounts(client, { asOfDate: '2026-07-20' });
    expect(view.latestCloseDate).toBe('2026-07-13');
    expect(view.accounts[0].asOfDate).toBe('2026-07-13');
    expect(view.accounts[0].reported).toBe(true);
  });

  it('never reads the wall clock: a far-future bound is the same view', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A one', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])])],
    });
    expect(buildLiveAccounts(client, { asOfDate: '2099-01-01' })).toEqual(
      buildLiveAccounts(client, { asOfDate: '' }),
    );
  });
});

describe('buildLiveAccounts — the date is a property of the row', () => {
  it('gives each account the date of the last close it appeared in', () => {
    const client = fakeClient({
      accountRegistry: {
        FRESH: { alias: 'Fresh', accountType: 'Funded', status: 'Active' },
        STALE: { alias: 'Stale', accountType: 'Funded', status: 'Active' },
        NEVER: { alias: 'Never', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [
        close('2026-07-13', [
          accountSnapshot('FRESH', [strategy('0 - URGO-4.5', true)]),
          accountSnapshot('STALE', [strategy('1 - RBO-1.8', true)], { grossRealizedPnl: 250 }),
        ]),
        close('2026-07-30', [accountSnapshot('FRESH', [strategy('0 - URGO-4.5', true)])]),
      ],
    });

    const view = buildLiveAccounts(client);
    const byAlias = Object.fromEntries(view.accounts.map((row) => [row.alias, row]));

    expect(byAlias.Fresh.asOfDate).toBe('2026-07-30');
    expect(byAlias.Fresh.reported).toBe(true);
    expect(byAlias.Fresh.daysBehindClose).toBe(0);

    // The useful fact: not "nothing today" but "this one last closed 17 days ago",
    // with its numbers still shown and still stamped with the date they belong to.
    expect(byAlias.Stale.asOfDate).toBe('2026-07-13');
    expect(byAlias.Stale.reported).toBe(false);
    expect(byAlias.Stale.daysBehindClose).toBe(17);
    expect(byAlias.Stale.session.realized).toBe(250);

    expect(byAlias.Never.asOfDate).toBeNull();
    expect(byAlias.Never.reported).toBe(false);
    expect(byAlias.Never.session).toBeNull();
    expect(byAlias.Never.daysBehindClose).toBeNull();

    expect(view.asOfDates).toEqual(['2026-07-30', '2026-07-13']);
  });

  it('measures the client against the desk without consulting today', () => {
    const behind = fakeClient({
      id: 'behind',
      name: 'Behind',
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-13', [accountSnapshot('A1')])],
    });
    const current = fakeClient({
      id: 'current',
      name: 'Current',
      accountRegistry: { B1: { alias: 'B', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-30', [accountSnapshot('B1')])],
    });

    expect(bookLatestDateOf([behind, current])).toBe('2026-07-30');
    const book = buildLiveBook([behind, current]);
    expect(book.clients[0].daysBehindBook).toBe(17);
    expect(book.clients[1].daysBehindBook).toBe(0);
    expect(book.clients[0].accounts[0].daysBehindBook).toBe(17);
  });
});

describe('buildLiveAccounts — three run states, never two', () => {
  it('separates running, all-off and no-strategy-data', () => {
    const client = fakeClient({
      accountRegistry: {
        RUN: { alias: 'Run', accountType: 'Funded', status: 'Active' },
        OFF: { alias: 'Off', accountType: 'Funded', status: 'Active' },
        BLIND: { alias: 'Blind', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [
        close('2026-07-30', [
          accountSnapshot('RUN', [strategy('0 - URGO-4.5', true), strategy('0 - RBO-1.8', false)]),
          accountSnapshot('OFF', [strategy('0 - URGO-4.5', false)]),
          accountSnapshot('BLIND', []),
        ]),
      ],
    });

    const byAlias = Object.fromEntries(buildLiveAccounts(client).accounts.map((row) => [row.alias, row]));
    expect(byAlias.Run.runState).toBe('running');
    expect(byAlias.Run.enabledCount).toBe(1);
    expect(byAlias.Off.runState).toBe('idle');
    // The distinction the current UI cannot make: an account that reported a
    // balance and no strategy list is a job to chase, not a switched-off account.
    expect(byAlias.Blind.runState).toBe('unmeasured');
    expect(byAlias.Blind.groupKey).toBe('no-data');
    expect(byAlias.Blind.strategyCount).toBe(0);
  });

  it('carries a missing enabled flag as null rather than off', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', undefined)])]),
      ],
    });
    const row = buildLiveAccounts(client).accounts[0];
    expect(row.strategies[0].enabled).toBeNull();
    expect(row.unknownEnabledCount).toBe(1);
    expect(row.enabledCount).toBe(0);
    // Unknown does not promote to running, and does not read as idle either.
    expect(row.runState).toBe('idle');
  });
});

describe('buildLiveAccounts — traded is three-valued', () => {
  const registry = { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } };

  it('counts fills when the close carried executions', () => {
    const client = fakeClient({
      accountRegistry: registry,
      dailyImports: [
        close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])], {
          executions: [
            { accountName: 'a1', strategyName: '0 - URGO-4.5' },
            { accountName: 'A1', strategyName: '0 - URGO-4.5' },
            { accountName: 'OTHER', strategyName: '0 - URGO-4.5' },
          ],
        }),
      ],
    });
    const row = buildLiveAccounts(client).accounts[0];
    expect(row.fills).toBe(2);
    expect(row.traded).toBe(true);
  });

  it('says not-measured when the close shipped no execution list at all', () => {
    // 13 of the 84 live closes on the real book are like this. "0 fills" would
    // claim the account sat out a day nobody counted.
    const client = fakeClient({
      accountRegistry: registry,
      dailyImports: [close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])])],
    });
    const row = buildLiveAccounts(client).accounts[0];
    expect(row.fills).toBeNull();
    expect(row.traded).toBeNull();
    expect(row.workingOrders).toBeNull();
  });

  it('reads P&L movement as traded even with no fills counted', () => {
    const client = fakeClient({
      accountRegistry: registry,
      dailyImports: [
        close('2026-07-30', [
          accountSnapshot('A1', [strategy('0 - URGO-4.5', true)], { grossRealizedPnl: -513 }),
        ]),
      ],
    });
    expect(buildLiveAccounts(client).accounts[0].traded).toBe(true);
  });

  it('counts orders in a live state and ignores rejections', () => {
    const client = fakeClient({
      accountRegistry: registry,
      dailyImports: [
        close('2026-07-30', [accountSnapshot('A1', [strategy('0 - URGO-4.5', true)])], {
          orders: [
            { accountName: 'A1', state: 'Working' },
            { accountName: 'A1', state: 'Filled' },
            { accountName: 'A1', state: 'Rejected: Your account is currently set to liquidation only' },
            { accountName: 'OTHER', state: 'Working' },
          ],
        }),
      ],
    });
    expect(buildLiveAccounts(client).accounts[0].workingOrders).toBe(1);
  });
});

describe('buildLiveAccounts — the strategy rows are not a breakdown of the day', () => {
  it('states the gap instead of letting a $0 row stand next to a losing account', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [
        close('2026-07-30', [
          accountSnapshot('A1', [strategy('0 - B2X-2.5', false)], { grossRealizedPnl: -448 }),
        ]),
      ],
    });
    const row = buildLiveAccounts(client).accounts[0];
    expect(row.strategyRealized).toBe(0);
    expect(row.session.realized).toBe(-448);
    expect(row.realizedGap).toBe(-448);
  });

  it('reports no gap when there is nothing measured to compare', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-30', [accountSnapshot('A1', [])])],
    });
    const row = buildLiveAccounts(client).accounts[0];
    expect(row.strategyRealized).toBeNull();
    expect(row.realizedGap).toBeNull();
  });
});

describe('buildLiveAccounts — grouping', () => {
  it('groups by period and keeps mixed accounts whole', () => {
    const client = fakeClient({
      accountRegistry: {
        P0: { alias: 'P0', accountType: 'Funded', status: 'Active' },
        P1: { alias: 'P1', accountType: 'Funded', status: 'Active' },
        MIX: { alias: 'Mix', accountType: 'Funded', status: 'Active' },
        BARE: { alias: 'Bare', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [
        close('2026-07-30', [
          accountSnapshot('P0', [strategy('0 - URGO-4.5', true)]),
          accountSnapshot('P1', [strategy('1 - RBO-1.8', true)]),
          // 97 of 2280 account-days on the real book look like this: different
          // algos from different periods on one account.
          accountSnapshot('MIX', [strategy('0 - IFSP-1.1', true), strategy('2 - OGX-2.4', false)]),
          accountSnapshot('BARE', [strategy('Bullet Bot-1.1', true)]),
        ]),
      ],
    });

    const view = buildLiveAccounts(client);
    expect(view.groups.map((group) => group.key)).toEqual([
      'period-0',
      'period-1',
      'mixed',
      'unstated',
    ]);
    const mix = view.groups.find((group) => group.key === 'mixed');
    expect(mix.accounts[0].periods).toEqual([0, 2]);
    // The unprefixed group is its own bucket, not folded into period 0.
    const unstated = view.groups.find((group) => group.key === 'unstated');
    expect(unstated.accounts[0].periods).toEqual([]);
    expect(unstated.accounts[0].hasUnstatedPeriod).toBe(true);
    expect(view.groups.every((group) => GROUP_ORDER.includes(group.key))).toBe(true);
  });

  it('keeps a period the library has never shown rather than dropping it', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-30', [accountSnapshot('A1', [strategy('7 - NEW-1.0', true)])])],
    });
    const view = buildLiveAccounts(client);
    expect(view.groups.map((group) => group.key)).toEqual(['period-7']);
  });
});

describe('buildLiveAccounts — registry edges', () => {
  it('matches registry and platform names case-insensitively', () => {
    const client = fakeClient({
      accountRegistry: { abc123: { alias: 'Mixed case', accountType: 'Funded', status: 'Active' } },
      dailyImports: [close('2026-07-30', [accountSnapshot('ABC123', [strategy('0 - URGO-4.5', true)])])],
    });
    const view = buildLiveAccounts(client);
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0].alias).toBe('Mixed case');
    expect(view.accounts[0].reported).toBe(true);
  });

  it('keeps an account the platform reported but the registry does not hold', () => {
    // 21 accounts on the real book. Dropping them would hide live trading.
    const client = fakeClient({
      dailyImports: [close('2026-07-30', [accountSnapshot('GHOST', [strategy('0 - URGO-4.5', true)])])],
    });
    const view = buildLiveAccounts(client);
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0].inRegistry).toBe(false);
    expect(view.accounts[0].accountType).toBeNull();
  });

  it('sets aside stood-down accounts instead of deleting them', () => {
    const client = fakeClient({
      accountRegistry: {
        LIVE: { alias: 'Live', accountType: 'Funded', status: 'Active' },
        IGN: { alias: 'Ignored', accountType: 'Inactive / Ignore', status: 'Active' },
        DEAD: { alias: 'Failed', accountType: 'Funded', status: 'Failed' },
      },
      dailyImports: [close('2026-07-30', [accountSnapshot('LIVE'), accountSnapshot('IGN'), accountSnapshot('DEAD')])],
    });
    const view = buildLiveAccounts(client);
    expect(view.accounts.map((row) => row.alias)).toEqual(['Live']);
    expect(view.retiredCount).toBe(2);
    expect(view.retired.map((row) => row.retiredReason).sort()).toEqual([
      'Account failed',
      'Typed Inactive / Ignore',
    ]);
  });

  it('handles a client with no close at all without inventing zeros', () => {
    const client = fakeClient({
      accountRegistry: { A1: { alias: 'A', accountType: 'Funded', status: 'Active' } },
    });
    const view = buildLiveAccounts(client);
    expect(view.latestCloseDate).toBeNull();
    expect(view.accounts[0].session).toBeNull();
    expect(view.accounts[0].asOfDate).toBeNull();
    expect(view.accounts[0].traded).toBeNull();
    expect(view.accounts[0].runState).toBe('unmeasured');
  });
});

describe('the real book', () => {
  const book = buildLiveBook(clients);

  it('resolves a date from the data, and it is not today', () => {
    expect(book.bookLatestDate).toBe('2026-07-30');
    expect(book.clients).toHaveLength(96);
    // 12 clients hold registry accounts and have never filed a close.
    expect(book.clientsWithoutClose).toBe(12);
  });

  it('prints the whole book without a single empty client view', () => {
    expect(book.totals).toEqual({
      accounts: 595,
      reporting: 420,
      behind: 158,
      neverReported: 17,
      running: 121,
      // 121 accounts have a strategy enabled on the last close they appeared
      // in. Only 90 of those closes are their client's most recent one; the
      // other 31 were enabled and then went absent, by up to 17 days. The panel
      // prints the two separately because "running now" and "was running when
      // we last heard from it" are different jobs.
      runningOnLatestClose: 90,
      runningBehindLatestClose: 31,
      idle: 295,
      unmeasured: 179,
      strategyRows: 731,
      strategiesOn: 192,
      strategiesOff: 539,
      strategiesUnknown: 0,
      traded: 283,
      flat: 247,
      tradedUnknown: 65,
    });
    expect(book.retiredCount).toBe(123);
  });

  it('groups the book by period, with the unknowns held apart', () => {
    expect(book.groups.map((group) => [group.key, group.accounts.length])).toEqual([
      ['period-0', 226],
      ['period-1', 38],
      ['period-2', 3],
      ['mixed', 21],
      ['unstated', 128],
      ['no-data', 179],
    ]);
    // Everything in no-data is unmeasured and nothing else is. The two states
    // cannot bleed into each other.
    for (const group of book.groups) {
      const unmeasured = group.accounts.filter((row) => row.runState === 'unmeasured').length;
      expect(unmeasured).toBe(group.key === 'no-data' ? group.accounts.length : 0);
    }
  });

  it('would mislabel 158 accounts if it used one header date', () => {
    const behind = book.clients.flatMap((view) => view.accounts.filter((row) => row.asOfDate && !row.reported));
    expect(behind).toHaveLength(158);
    // Every one of them carries the date its numbers came from, and it is
    // strictly older than the client's most recent close.
    for (const row of behind) {
      expect(row.daysBehindClose).toBeGreaterThan(0);
      expect(row.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The worst gap on the book: an account 17 days behind its client's close.
    expect(Math.max(...behind.map((row) => row.daysBehindClose))).toBe(17);
  });

  it('finds the client whose accounts span the most dates', () => {
    const worst = [...book.clients].sort((a, b) => b.asOfDates.length - a.asOfDates.length)[0];
    expect(worst.clientName).toBe('Gray Elm');
    expect(worst.asOfDates).toHaveLength(8);
  });

  it('splits Harper Juniper across periods the way the desk runs it', () => {
    // The CAM's use case from the investigation: one client, accounts on two
    // different periods, invisible in today's UI because the chips strip the
    // prefix and `0 - URGO-4.5` and `1 - URGO-4.5` render identically.
    const view = book.clients.find((entry) => entry.clientName === 'Harper Juniper');
    const counts = Object.fromEntries(view.groups.map((group) => [group.key, group.accounts.length]));
    expect(counts['period-0']).toBe(7);
    expect(counts['period-1']).toBe(5);
    expect(view.latestCloseDate).toBe('2026-07-30');
    expect(view.asOfDates.length).toBeGreaterThan(1);
  });

  it('never reports a period of 0 for a name that has no prefix', () => {
    const rows = book.clients.flatMap((view) => view.accounts.flatMap((row) => row.strategies));
    expect(rows).toHaveLength(731);
    for (const row of rows) {
      if (row.period === null) expect(row.name).not.toMatch(/^\s*\d/);
      else expect(row.name).toMatch(/^\s*\d+\s*-/);
    }
    // 132 of the 731 live strategy rows (18%) carry no prefix, so 599 (82%)
    // have a determinable period. Not 731 — the honest denominator matters.
    const unstated = rows.filter((row) => row.period === null);
    expect(unstated).toHaveLength(132);
  });

  it('leaves every session number attached to a date, never floating', () => {
    for (const view of book.clients) {
      for (const row of view.accounts) {
        if (row.session) expect(row.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        else expect(row.asOfDate).toBeNull();
      }
    }
  });
  it('reconciles its own row count against the registry, so the stat above it can be read', () => {
    // The client workspace shows "Accounts (all time)" (registry rows) directly
    // above this panel. They disagree on 7 of 96 clients and the whole gap is
    // accounts that trade under a name the registry does not hold: 33 rows.
    expect(book.notInRegistry).toBe(33);
    expect(book.clientsWithOrphans).toBe(7);

    const grayElm = book.clients.find((view) => view.clientName === 'Gray Elm');
    expect(grayElm.registryAccounts).toBe(15);
    expect(grayElm.notInRegistry).toBe(5);
    expect(grayElm.accounts.length + grayElm.retiredCount).toBe(20);
    // The arithmetic the panel prints: 20 shown - 5 orphans = the 15 the stat
    // above it counts.
    expect(grayElm.accounts.length + grayElm.retiredCount - grayElm.notInRegistry)
      .toBe(grayElm.registryAccounts);
  });

  it('never sums a stale "running" into a fresh one', () => {
    // Vale Frost is the case that made this necessary: the header names
    // 2026-07-30 and the old count read "4 running", while all four of those
    // accounts last appeared on 2026-07-13 and every account that DID report on
    // the 30th is idle or unmeasured.
    const valeFrost = book.clients.find((view) => view.clientName === 'Vale Frost');
    expect(valeFrost.latestCloseDate).toBe('2026-07-30');
    expect(valeFrost.totals.running).toBe(4);
    expect(valeFrost.totals.runningOnLatestClose).toBe(0);
    expect(valeFrost.totals.runningBehindLatestClose).toBe(4);
    expect(valeFrost.runningBehindMaxDays).toBe(17);

    // Seven clients read entirely stale like this; the book-level intro says so.
    expect(book.clientsRunningAllStale).toBe(7);

    // The split is exhaustive and nothing is double counted.
    for (const view of book.clients) {
      expect(view.totals.runningOnLatestClose + view.totals.runningBehindLatestClose)
        .toBe(view.totals.running);
    }
  });

  it('reports "no stale runner" as null rather than a gap of zero days', () => {
    const clean = book.clients.filter((view) => view.totals.runningBehindLatestClose === 0);
    expect(clean.length).toBeGreaterThan(0);
    for (const view of clean) expect(view.runningBehindMaxDays).toBeNull();
  });
});
