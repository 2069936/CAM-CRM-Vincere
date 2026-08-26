// The book-backed half of liveAccounts's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so
// vite.config.js drops it on every clone that does not hold the export. A test
// that only runs here is not a test CI can hold anyone to, and the synthetic
// half of this suite was being dropped alongside it for no reason at all. The
// rules live in liveAccounts.test.js, which runs everywhere; the NUMBERS
// live here, where the book is.

// Every count below was read off public/local-snapshot.json by rendering it,
// not by trusting the code: 595 live accounts, 121 running, 179 with no strategy
// row at all, and 158 rows whose numbers come from a close EARLIER than their
// client's most recent one. That last figure is the reason the date is a
// property of the row — those are exactly the rows a single header date would
// mislabel.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLiveBook } from './liveAccounts';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

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
