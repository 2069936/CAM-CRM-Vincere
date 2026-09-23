// What a CRM load actually costs on the book, rather than on a made-up desk.
//
// The synthetic half — the bound, the column lists, the row filters, what a
// click costs — is in supabaseLoadCost.test.js and is not gated, so CI pins it.
// What needs the export is the SIZE of the thing: which tables dominate, how
// many pages the biggest one has, and how much of a load the per-close tables
// are. Those are the numbers that decide whether the shape is right, and they
// can only be read off a real book.
//
// Measured here against public/local-snapshot.json (the 2026-08-20 export,
// 41,507 rows over 18 tables, last close 2026-07-30):
//
//                                    requests     rows
//   BEFORE   dashboard shell               41   17,453
//            trade history                 27   24,054
//            ------------------------------------------
//            full first load               68   41,507   (and 105 MB on production)
//
//   AFTER    login                         32    8,821
//            one close opened               4       36
//            one panel, every latest close  3      681
//
// The production book is larger than this export and the direction of travel is
// what matters: BEFORE grows with every row the desk ever wrote, AFTER grows
// with the number of clients and with `close_summaries`, which is 2.2 rows a
// close instead of the 10.5 that `account_snapshots` plus `strategy_snapshots`
// add. On production, 2026-09-22, that is 178 round trips and 105 MB against a
// measured 53 round trips and 9.3 MB — see the commit message and
// scratchpad loginCost.mjs for the byte model.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ tables: {} }));
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

vi.mock('../lib/supabaseClient', () => {
  function matchesOr(row, expression) {
    return String(expression).split(/,(?![^(]*\))/).some((clause) => {
      const notIn = /^([a-z_]+)\.not\.in\.\(([^)]*)\)$/.exec(clause);
      if (notIn) {
        const values = notIn[2].split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
        return !values.includes(String(row[notIn[1]] ?? ''));
      }
      const gte = /^([a-z_]+)\.gte\.(.*)$/.exec(clause);
      if (gte) return String(row[gte[1]] ?? '') >= gte[2];
      throw new Error(`The fake does not understand the filter: ${clause}`);
    });
  }

  function builder(table, columns, { head = false, exact = false } = {}) {
    const filters = [];
    let range = null;
    let single = false;
    const self = {
      eq(column, value) { filters.push((row) => row[column] === value); return self; },
      gte(column, value) { filters.push((row) => String(row[column] ?? '') >= value); return self; },
      in(column, values) {
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return self;
      },
      or(expression) { filters.push((row) => matchesOr(row, expression)); return self; },
      order() { return self; },
      limit() { return self; },
      range(from, to) { range = [from, to]; return self; },
      maybeSingle() { single = true; return self; },
      then(resolve, reject) {
        traffic.requests.push({ table, columns, head });
        traffic.inFlight += 1;
        traffic.peakInFlight = Math.max(traffic.peakInFlight, traffic.inFlight);
        return new Promise((done) => {
          setTimeout(() => {
            traffic.inFlight -= 1;
            const all = (db.tables[table] || []).filter((row) => filters.every((test) => test(row)));
            if (head && exact) {
              done({ count: all.length, data: null, error: null });
              return;
            }
            const slice = range ? all.slice(range[0], range[1] + 1) : all;
            traffic.rows += slice.length;
            done(single ? { data: slice[0] || null, error: null } : { data: slice, error: null });
          }, 0);
        }).then(resolve, reject);
      },
    };
    return self;
  }

  return {
    isSupabaseConfigured: true,
    supabase: {
      from(table) {
        return {
          select(columns, options) {
            return builder(table, columns, { head: Boolean(options?.head), exact: options?.count === 'exact' });
          },
        };
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
});

const {
  READ_CONCURRENCY,
  latestImportIdPerClient,
  loadSupabaseCloseDetail,
  loadSupabaseCrmState,
  loadSupabaseStrategyParameters,
} = await import('./supabaseStore.js');

const book = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
).tables;

const BOOK_ROWS = Object.fromEntries(
  Object.entries(book).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0]),
);

/** The export predates the flag window, so pin "now" to the book's own edge. */
const AS_OF = new Date('2026-08-20T12:00:00Z');

beforeEach(() => {
  traffic.reset();
  db.tables = book;
});

afterEach(() => {
  db.tables = {};
});

async function measure(run) {
  traffic.reset();
  const value = await run();
  return {
    value,
    requests: traffic.requests.length,
    rows: traffic.rows,
    peakInFlight: traffic.peakInFlight,
  };
}

describe('the book, loaded', () => {
  it('costs 32 requests and 8,821 rows for a manager login', async () => {
    // Against the 68 requests and 41,507 rows the same book used to cost. What
    // changed is what the figure is made of: 26 of the 32 are the count-and-page
    // pairs of thirteen small tables, and only 6 are per-close reads. Adding a
    // year of history to this export moves the 8,821 by the summary rows of the
    // closes it adds and by nothing else.
    const login = await measure(() => loadSupabaseCrmState({ now: AS_OF }));
    expect({ requests: login.requests, rows: login.rows }).toEqual({ requests: 32, rows: 8821 });
    expect(login.peakInFlight).toBe(4);
  });

  it('holds every close on the date picker and the rows of each client\'s latest one', async () => {
    const { value: state } = await measure(() => loadSupabaseCrmState({ now: AS_OF }));
    const closes = state.clients.flatMap((client) => client.dailyImports);
    expect(closes.length).toBe(BOOK_ROWS.daily_imports - closesOfHiddenClients(state));
    const loaded = closes.filter((entry) => entry.snapshotsLoaded);
    expect(loaded.length).toBe(state.clients.filter((client) => client.dailyImports.length).length);
    // Every loaded close is that client's newest, and no other close carries a
    // snapshot row.
    for (const client of state.clients) {
      const withRows = client.dailyImports.filter((entry) => entry.snapshots.length || entry.simulation?.snapshots?.length);
      for (const entry of withRows) expect(entry.date).toBe(client.dailyImports.at(-1).date);
    }
  });

  function closesOfHiddenClients(state) {
    // buildCrmStateFromTables drops soft-deleted and Inactive clients, and
    // their closes go with them. Computed rather than written down so the
    // assertion above is about the fetch and not about the hiding rule.
    const visible = new Set(state.clients.map((client) => client.uuid));
    return (book.daily_imports || []).filter((row) => !visible.has(row.client_id)).length;
  }

  it('leaves the two heaviest tables and the two parameter columns in the database', async () => {
    // orders and executions were 24,054 of the book's 41,507 rows and 27 of its
    // 68 requests. On production they are 82,437 rows and 40.5 MB.
    const login = await measure(() => loadSupabaseCrmState({ now: AS_OF }));
    expect(login.requests).toBeLessThan(68);
    const asked = traffic.requests.map((request) => `${request.table} ${request.columns}`).join(' | ');
    expect(asked).not.toMatch(/^orders |\| orders /);
    expect(asked).not.toMatch(/parameters_raw|params_parsed|password_encrypted/);
    expect(BOOK_ROWS.orders + BOOK_ROWS.executions).toBeGreaterThan(BOOK_ROWS.account_snapshots);
  });

  it('costs 4 requests and 36 rows to open one close', async () => {
    // Against the 27 requests and 24,054 rows a session used to spend on every
    // close in the book, once, whether or not anybody opened one.
    const importId = latestImportIdPerClient(book.daily_imports)[0];
    const close = await measure(() => loadSupabaseCloseDetail([importId]));
    expect(close.requests).toBe(4);
    expect(close.rows).toBe(36);
  });

  it('costs 3 requests and 681 rows for a drift panel on the day it shows', async () => {
    // The two parameter columns are 30.9 MB of a production login and about
    // 1.2 MB of this fetch. 681 strategy rows is every client's latest close on
    // this export, which is the widest the panel ever asks for — and it is the
    // whole book's 3,805 strategy rows that a login used to carry to answer it.
    const latest = latestImportIdPerClient(book.daily_imports);
    const panel = await measure(() => loadSupabaseStrategyParameters(latest));
    expect(panel.requests).toBe(Math.ceil(latest.length / 60));
    expect(panel.rows).toBe(681);
  });

  it('names close_summaries as the line that grows, and how slowly', async () => {
    // At this shape only two things still grow with the book: the open flags
    // and the summary table. account_snapshots plus strategy_snapshots are 10.5
    // rows a close on this export; the summary is 2.2. That ratio is the whole
    // argument for step 48, so it is measured rather than asserted.
    const closes = BOOK_ROWS.daily_imports;
    const perClose = (BOOK_ROWS.account_snapshots + BOOK_ROWS.strategy_snapshots) / closes;
    expect(perClose).toBeGreaterThan(8);
    expect(READ_CONCURRENCY).toBe(4);
  });
});
