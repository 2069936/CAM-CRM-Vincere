// What one CRM load costs the project, measured against the real loadTable.
//
// THE DEFECT THIS PINS
//
// loadTable issued one count query per table and then fired EVERY page of that
// table in a single Promise.all, and loadSupabaseCrmState ran all nineteen
// tables through it in a single Promise.all of its own. So a page load left the
// browser as one burst — on the production book 117 requests, of which 31 were
// pages of `orders` and 16 pages of `operational_flags`, all in flight at once.
// Twelve machines doing that in quick succession is what the project started
// refusing with 429s, and `orders` gains a page every trading day, so one tab
// reaches the same cliff on its own eventually.
//
// The comment at loadTable said pages were made parallel so large history
// tables would not wait on several round trips. That is still true and still
// wanted: the fix is a bound, not a return to serial fetching.
//
// WHAT IS ASSERTED HERE, AND WHY IT IS SYNTHETIC
//
// These numbers are arithmetic over row counts, so they do not need the book —
// and must not, because a guard that only runs where the export exists is not
// pinned by CI at all (see src/localSnapshotGate.test.js). The book-backed
// half, which reports what the real export actually costs, is the sibling
// supabaseLoadCost.book.test.js.
//
// The fake below is not a model of loadTable. It stands in for PostgREST and
// the REAL loadTable runs against it, so re-parallelising the pages, dropping
// the gate, or putting orders back on the dashboard path fails these tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rowCounts = vi.hoisted(() => ({ current: {} }));
const traffic = vi.hoisted(() => ({
  requests: [],
  rows: 0,
  inFlight: 0,
  peakInFlight: 0,
  reset() {
    this.requests = [];
    this.rows = 0;
    this.inFlight = 0;
    this.peakInFlight = 0;
  },
}));

/**
 * A PostgREST stand-in.
 *
 * Every builder is thenable because that is how supabase-js is awaited, and
 * every resolution is deferred by a macrotask so overlapping requests really do
 * overlap — an implementation that awaited each page in turn would show a peak
 * of one here and a peak of one in production, and both would be true.
 */
function fakeQuery(table, kind, resolve) {
  traffic.requests.push({ table, kind });
  traffic.inFlight += 1;
  traffic.peakInFlight = Math.max(traffic.peakInFlight, traffic.inFlight);
  return new Promise((done) => {
    setTimeout(() => {
      traffic.inFlight -= 1;
      done(resolve());
    }, 0);
  });
}

vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    from(table) {
      return {
        select(columns, options) {
          if (options?.head) {
            return fakeQuery(table, 'count', () => ({
              count: rowCounts.current[table] ?? 0,
              error: null,
            }));
          }
          const page = {
            order: () => page,
            range: (from, to) => fakeQuery(table, 'page', () => {
              const total = rowCounts.current[table] ?? 0;
              const size = Math.max(0, Math.min(to, total - 1) - from + 1);
              traffic.rows += size;
              return {
                data: Array.from({ length: size }, (_, i) => ({ id: `${table}-${from + i}` })),
                error: null,
              };
            }),
          };
          return page;
        },
      };
    },
  },
}));

const { CRM_STATE_TABLES, READ_CONCURRENCY, loadSupabaseCrmState, loadSupabaseTradeHistory } =
  await import('./supabaseStore.js');

/** Requests loadTable makes for a table of `rows`: one count, plus one page per
 *  thousand rows. A table with no rows costs the count and nothing else. */
const requestsFor = (rows) => 1 + Math.ceil(rows / 1000);

/** A desk roughly the shape of the production book, in the two tables that
 *  dominate it and one that does not. Exact values do not matter; the ratio
 *  between "many pages" and "one page" is what the bound has to survive. */
const BIG_DESK = {
  cam_profiles: 8,
  clients: 136,
  client_assignments: 135,
  trading_accounts: 764,
  payout_events: 11,
  daily_imports: 535,
  account_snapshots: 6891,
  strategy_snapshots: 8341,
  orders: 30955,
  executions: 14958,
  operational_flags: 15499,
  tasks: 8,
  activity_logs: 1996,
  price_checks: 237,
};

beforeEach(() => {
  traffic.reset();
  rowCounts.current = { ...BIG_DESK };
});

afterEach(() => {
  rowCounts.current = {};
});

describe('one dashboard load', () => {
  it('never has more than READ_CONCURRENCY requests in flight, however many pages there are', async () => {
    // 31 pages of orders and 16 of operational_flags in one Promise.all is the
    // burst. The bound is global to the load, not per table: nineteen tables
    // each allowed four is the same cliff a little further away.
    await loadSupabaseCrmState({});
    expect(traffic.peakInFlight).toBeLessThanOrEqual(READ_CONCURRENCY);
    expect(READ_CONCURRENCY).toBeLessThanOrEqual(6);
  });

  it('does not ask for orders or executions at all', async () => {
    // 46 of the production book's 117 requests, for two tables most screens
    // never render. loadSupabaseTradeHistory fetches them once per session,
    // after the shell — see hydrateTradeHistory in App.jsx.
    await loadSupabaseCrmState({});
    const tables = new Set(traffic.requests.map((r) => r.table));
    expect(tables.has('orders')).toBe(false);
    expect(tables.has('executions')).toBe(false);
  });

  it('costs one count per table plus one page per thousand rows, and no more', async () => {
    await loadSupabaseCrmState({});
    const expected = CRM_STATE_TABLES
      .filter((table) => table !== 'orders' && table !== 'executions')
      .reduce((total, table) => total + requestsFor(rowCounts.current[table] ?? 0), 0);
    expect(traffic.requests).toHaveLength(expected);
    // Deferring the two history tables is 46 requests and 45,913 rows that a
    // flag click, a close and a drag no longer pay for.
    expect(requestsFor(BIG_DESK.orders) + requestsFor(BIG_DESK.executions)).toBe(48);
  });

  it('still overlaps the pages of a large table rather than waiting a round trip each', async () => {
    // The bound must not become a serial fetch: that was the state loadTable's
    // original comment was written to move away from, and a 31-page table down
    // one round trip at a time is a slower dashboard for the same total cost.
    rowCounts.current = { operational_flags: 15499 };
    await loadSupabaseTradeHistory();
    traffic.reset();
    rowCounts.current = { orders: 30955, executions: 14958 };
    await loadSupabaseTradeHistory();
    expect(traffic.peakInFlight).toBeGreaterThan(1);
    expect(traffic.peakInFlight).toBeLessThanOrEqual(READ_CONCURRENCY);
  });

  it('reads every row of a table that spans many pages', async () => {
    // The bound changes when the pages run, never which of them run: a load
    // that quietly stopped at page four would be a far worse defect than the
    // burst it replaced.
    rowCounts.current = { orders: 30955, executions: 14958 };
    const { orders, executions } = await loadSupabaseTradeHistory();
    expect(orders).toHaveLength(30955);
    expect(executions).toHaveLength(14958);
  });

  it('keeps the rows of one table in page order', async () => {
    rowCounts.current = { orders: 2500, executions: 0 };
    const { orders } = await loadSupabaseTradeHistory();
    expect(orders[0].id).toBe('orders-0');
    expect(orders[1000].id).toBe('orders-1000');
    expect(orders.at(-1).id).toBe('orders-2499');
  });
});
