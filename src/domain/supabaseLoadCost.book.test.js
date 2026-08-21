// What a CRM load actually costs on the book, rather than on a made-up desk.
//
// The synthetic half of this — the bound itself, and the arithmetic that says a
// table of N rows costs 1 + ceil(N/1000) requests — is in
// supabaseLoadCost.test.js and is not gated, so CI pins it. What needs the
// export is the size of the thing: which tables dominate, how many pages the
// biggest one has today, and how much of a load the two trade-history tables
// are. Those are the numbers that decide whether a bound of four is the right
// bound, and they can only be read off a real book.
//
// Measured here against public/local-snapshot.json:
//
//                    requests   rows
//   dashboard shell        41   17,453
//   trade history          27   24,054   (once per session, after the shell)
//   ------------------------------------
//   full first load        68   41,507
//
// Before the fix, all 68 were one burst with 27 requests in flight at the peak,
// AND all 68 ran again on every single edit, because reloadSupabaseState sat
// behind eighteen call sites and called hydrateTradeHistory at the end of
// itself. An edit now costs one request.
//
// The desk manager's incident was reported against the live project, which is
// larger than this export — he measured 117 requests and 86,484 rows, with
// orders at 31 pages. The shape is the same and the direction of travel is the
// same: orders is the largest table here too, and it gains a page every trading
// day whether or not anyone opens twelve tabs.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

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

const { READ_CONCURRENCY, loadSupabaseCrmState, loadSupabaseTradeHistory } =
  await import('./supabaseStore.js');

const book = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
).tables;

const BOOK_ROWS = Object.fromEntries(
  Object.entries(book).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0]),
);

async function measure(run) {
  traffic.reset();
  rowCounts.current = BOOK_ROWS;
  await run();
  return {
    requests: traffic.requests.length,
    rows: traffic.rows,
    peakInFlight: traffic.peakInFlight,
  };
}

describe('the book, loaded', () => {
  it('costs 41 requests and 17,453 rows for the dashboard shell', async () => {
    const shell = await measure(() => loadSupabaseCrmState({}));
    expect(shell).toEqual({ requests: 41, rows: 17453, peakInFlight: 4 });
  });

  it('costs a further 27 requests and 24,054 rows for trade history, once per session', async () => {
    const history = await measure(() => loadSupabaseTradeHistory());
    expect(history).toEqual({ requests: 27, rows: 24054, peakInFlight: 4 });
  });

  it('keeps the peak in flight at four however big the book gets', async () => {
    // The number that mattered. The same load through the old loadTable put 27
    // requests in flight at once on this export and 98 on the production book;
    // twelve machines doing that together is the saturation.
    const full = await measure(async () => {
      await loadSupabaseCrmState({});
      await loadSupabaseTradeHistory();
    });
    expect(full.requests).toBe(68);
    expect(full.rows).toBe(41507);
    // The literal, not READ_CONCURRENCY: `toBe(READ_CONCURRENCY)` passes for
    // any value the constant takes, so raising the bound to eight would have
    // left this test green while claiming four in its own name.
    expect(full.peakInFlight).toBe(4);
    expect(READ_CONCURRENCY).toBe(4);
  });

  it('shows orders and executions to be more than half the rows and a third of the requests', async () => {
    // The case for deferring them off the dashboard path, stated in the numbers
    // rather than in an adjective. If this ratio ever collapses, the deferral
    // is buying less than it costs in complexity and should be revisited.
    const shell = await measure(() => loadSupabaseCrmState({}));
    const history = await measure(() => loadSupabaseTradeHistory());
    expect(history.rows / (shell.rows + history.rows)).toBeGreaterThan(0.5);
    expect(history.requests / (shell.requests + history.requests)).toBeGreaterThan(0.33);
  });

  it('names orders as the table that grows into the cliff', async () => {
    // 17 pages today on this export, 31 on the live project, and one more every
    // trading day. It is the reason a bound is needed even for a desk that
    // never opens a second tab.
    const orderPages = Math.ceil(BOOK_ROWS.orders / 1000);
    expect(orderPages).toBeGreaterThanOrEqual(16);
    expect(BOOK_ROWS.orders).toBeGreaterThan(BOOK_ROWS.operational_flags);
    expect(BOOK_ROWS.orders).toBeGreaterThan(BOOK_ROWS.account_snapshots);
  });
});
