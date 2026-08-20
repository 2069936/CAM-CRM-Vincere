// The book-backed half of accountLifecycle's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so
// vite.config.js drops it on every clone that does not hold the export. A test
// that only runs here is not a test CI can hold anyone to, and the synthetic
// half of this suite was being dropped alongside it for no reason at all. The
// rules live in accountLifecycle.test.js, which runs everywhere; the NUMBERS
// live here, where the book is.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildAccountLifecycleStates, WITHHELD_REASONS } from './accountLifecycle';
import { buildCrmStateFromTables } from './supabaseStore';

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
