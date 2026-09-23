// What one CRM load costs the project, measured against the real loaders.
//
// THE DEFECT THIS PINS, FIRST VERSION
//
// loadTable issued one count query per table and then fired EVERY page of that
// table in a single Promise.all, and loadSupabaseCrmState ran all nineteen
// tables through it in a single Promise.all of its own. So a page load left the
// browser as one burst — on the production book 117 requests, all in flight at
// once. Twelve machines doing that in quick succession is what the project
// started refusing with 429s. That fix was a bound, not a return to serial
// fetching, and the bound assertions below have not changed: they are the 429
// incident and they now apply to the panel fetches too.
//
// THE DEFECT THIS PINS, SECOND VERSION
//
// A bounded burst is still a burst of the whole database. Measured on
// production on 2026-09-22, a login fetched all eighteen tables in full with
// `select *`: 148,011 rows, 178 round trips, about 105 MB of JSON, and it
// doubles about every 39 days. 37.8 MB of it was `parameters_raw` and
// `params_parsed`, read by two collapsed panels. 40.5 MB was `orders` and
// `executions`, which no first screen reads. 10.7 MB was flags the queue cannot
// act on. Every client's passwords were in every CAM's tab.
//
// So the assertion that used to read "does not ask for orders or executions at
// all" now has siblings: which COLUMNS a login asks for, which ROWS, and what a
// click costs instead. A change that puts any of it back on the login fails
// here.
//
// WHAT IS ASSERTED HERE, AND WHY IT IS SYNTHETIC
//
// These numbers are arithmetic over row counts, so they do not need the book —
// and must not, because a guard that only runs where the export exists is not
// pinned by CI at all (see src/localSnapshotGate.test.js). The book-backed
// half, which reports what the real export costs, is the sibling
// supabaseLoadCost.book.test.js.
//
// The fake below is not a model of the loaders. It stands in for PostgREST —
// it applies the filters, it pages, and it answers with rows of the right
// shape — and the REAL loaders run against it.

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

/**
 * A PostgREST stand-in.
 *
 * Every builder is thenable because that is how supabase-js is awaited, and
 * every resolution is deferred by a macrotask so overlapping requests really do
 * overlap — an implementation that awaited each page in turn would show a peak
 * of one here and a peak of one in production, and both would be true.
 *
 * The filters are applied for real. A test that counted requests but ignored
 * `.in()` and `.or()` would pass just as happily for a login that fetched every
 * row and threw most of them away, which is the thing being fixed.
 */
vi.mock('../lib/supabaseClient', () => {
  function matchesOr(row, expression) {
    // The only two shapes this codebase emits, both from the flag filter.
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
      not(column, operator, value) {
        if (operator !== 'in') throw new Error(`The fake does not understand not.${operator}`);
        const set = new Set(String(value).replace(/^\(|\)$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, '')));
        filters.push((row) => !set.has(String(row[column] ?? '')));
        return self;
      },
      or(expression) { filters.push((row) => matchesOr(row, expression)); return self; },
      order() { return self; },
      limit() { return self; },
      range(from, to) { range = [from, to]; return self; },
      maybeSingle() { single = true; return self; },
      then(resolve, reject) {
        traffic.requests.push({ table, columns, head, filtered: filters.length > 0 });
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
            // THE FAKE PROJECTS, because half of what is asserted here is
            // which COLUMNS a fetch names. A fake that answered whole rows
            // whatever the select said would hand a login the parameter
            // columns it had just been measured for NOT asking about, and the
            // merge that has to put back what a narrower fetch did not carry
            // would never see a row without them.
            const project = (row) => {
              if (!columns || columns === '*') return row;
              const names = String(columns).split(',').map((name) => name.trim()).filter(Boolean);
              const out = {};
              for (const name of names) if (name in row) out[name] = row[name];
              return out;
            };
            const slice = (range ? all.slice(range[0], range[1] + 1) : all).map(project);
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
      rpc() {
        traffic.requests.push({ table: 'rpc', columns: '', head: false, filtered: false });
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

const {
  CLOSE_DETAIL_COLUMNS,
  READ_CONCURRENCY,
  STRATEGY_PARAMETER_COLUMNS,
  latestImportIdPerClient,
  loadSupabaseClientDetail,
  loadSupabaseCloseDetail,
  loadSupabaseCloseFlags,
  loadSupabaseCrmState,
  loadSupabaseRankingRows,
  loadSupabaseStrategyParameters,
  mergeSupabaseStrategyParameters,
  applyCloseRows,
} = await import('./supabaseStore.js');

/* ── A desk shaped like the production book, 2026-09-22 ────────────────────
 *
 * 206 clients, 8 CAMs, 2,585 closes. The per-close tables are generated at the
 * production ratios (4.9 account rows, 5.6 strategy rows, 21.6 orders and 10.3
 * executions per close) so that "each client's latest close" is a real slice of
 * a real shape rather than a number written down here.
 */
const CLIENTS = 206;
const CAMS = 8;
const CLOSES_PER_CLIENT = 12;
const PER_CLOSE = {
  account_snapshots: 5,
  strategy_snapshots: 6,
  orders: 22,
  executions: 10,
  operational_flags: 10,
  close_summaries: 2,
};
/** 3 of every 10 flag rows are still open; the rest are closed, most long ago. */
const FLAG_STATUS = ['Open', 'Open', 'Open', 'Resolved', 'Resolved', 'Resolved', 'Resolved', 'Resolved', 'Resolved', 'Acknowledged'];

function makeBook() {
  const tables = Object.fromEntries([
    'cam_profiles', 'clients', 'client_assignments', 'trading_accounts', 'payout_events',
    'client_credentials', 'client_prop_firms', 'daily_imports', 'account_snapshots',
    'strategy_snapshots', 'orders', 'executions', 'operational_flags', 'tasks',
    'activity_logs', 'price_checks', 'cam_time_off', 'client_coverage', 'close_summaries',
  ].map((table) => [table, []]));

  for (let cam = 0; cam < CAMS; cam += 1) {
    tables.cam_profiles.push({ id: `cam-${cam}`, legacy_key: `am-${cam}`, name: `CAM ${cam}` });
  }
  for (let index = 0; index < CLIENTS; index += 1) {
    const id = `client-${index}`;
    tables.clients.push({ id, legacy_key: `c-${index}`, name: `Client ${index}`, status: 'Active' });
    tables.client_assignments.push({ id: `a-${index}`, client_id: id, cam_profile_id: `cam-${index % CAMS}` });
    for (let account = 0; account < 7; account += 1) {
      tables.trading_accounts.push({
        id: `acct-${index}-${account}`, client_id: id, account_name: `ACC-${index}-${account}`,
        account_type: 'Funded', status: 'Active',
      });
    }
    for (let close = 0; close < CLOSES_PER_CLIENT; close += 1) {
      const importId = `imp-${index}-${close}`;
      const tradingDate = `2026-09-${String(close + 1).padStart(2, '0')}`;
      tables.daily_imports.push({
        id: importId, legacy_key: importId, client_id: id, trading_date: tradingDate, status: 'Closed',
      });
      for (const [table, perClose] of Object.entries(PER_CLOSE)) {
        for (let row = 0; row < perClose; row += 1) {
          const entry = {
            id: `${table}-${importId}-${row}`,
            daily_import_id: importId,
            client_id: id,
            trading_account_id: `acct-${index}-${row % 7}`,
            account_name: `ACC-${index}-${row % 7}`,
            trading_date: tradingDate,
          };
          if (table === 'operational_flags') {
            entry.status = FLAG_STATUS[(index + close + row) % FLAG_STATUS.length];
            // Closed a long time ago, so the fortnight window does not keep it.
            entry.resolved_at = entry.status === 'Open' ? null : '2026-01-05';
          }
          if (table === 'close_summaries') entry.segment = row ? 'Cash' : 'Funded';
          if (table === 'strategy_snapshots') {
            // Nested onto an account row by id, the way the real tables are, so
            // a merge that fetches strategies without their snapshots has
            // somewhere to put them and one that fetches both can be checked.
            entry.account_snapshot_id = `account_snapshots-${importId}-${row % PER_CLOSE.account_snapshots}`;
            entry.strategy_name = `ALGO-${row}`;
            entry.strategy_family = `ALGO${row}`;
            entry.enabled = row % 2 === 0;
            // The two columns that are 82% of a strategy row and 30.9 MB of a
            // login. Only the parameter fetch names them.
            entry.parameters_raw = `BarsPeriod=${20 + row};StopLossTicks=${300 + row}`;
            entry.params_parsed = { BarsPeriod: String(20 + row), LicenseKey: 'LIC-XXXX' };
          }
          if (table === 'account_snapshots') entry.derivation = { rows: row };
          tables[table].push(entry);
        }
      }
    }
    tables.client_credentials.push({ id: `cred-${index}`, client_id: id, password_encrypted: 'secret' });
    tables.client_prop_firms.push({ id: `pf-${index}`, client_id: id, password_encrypted: 'secret' });
  }
  return tables;
}

const BOOK = makeBook();
const TOTAL_CLOSES = CLIENTS * CLOSES_PER_CLIENT;
const LATEST_CLOSES = CLIENTS;

beforeEach(() => {
  traffic.reset();
  db.tables = BOOK;
});

afterEach(() => {
  db.tables = {};
});

const requestsTo = (table) => traffic.requests.filter((request) => request.table === table);
/** The columns a table's PAGE requests named; the count query always asks for `id`. */
const columnsAskedOf = (table) => requestsTo(table)
  .filter((request) => !request.head)
  .map((request) => String(request.columns || ''));

describe('one login', () => {
  it('never has more than READ_CONCURRENCY requests in flight, however many pages there are', async () => {
    // The 429 incident, unchanged. The bound is global to the load, not per
    // table: nineteen tables each allowed four is the same cliff a little
    // further away.
    await loadSupabaseCrmState({});
    expect(traffic.peakInFlight).toBeLessThanOrEqual(READ_CONCURRENCY);
    expect(READ_CONCURRENCY).toBeLessThanOrEqual(6);
  });

  it('does not ask for an order at all', async () => {
    // 55,856 rows and 27.0 MB on production, for a table no first screen reads.
    // deskMoney.js and operationsSegments.js contain no reference to `.orders`;
    // report.js counts `sim?.orders.length` for the simulation block and
    // nothing else.
    await loadSupabaseCrmState({});
    expect(requestsTo('orders')).toHaveLength(0);
  });

  it('asks for executions only on each client\'s latest close', async () => {
    // The one fill dependency a first screen has: camOverview.js builds the
    // execution drift alerts off each client's latest import, and that runs on
    // the CAM overview and, through deskDeviation, on the manager's. On
    // production that is about 1,330 rows, not 26,581.
    const state = await loadSupabaseCrmState({});
    const fetched = traffic.rows;
    expect(requestsTo('executions').length).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(TOTAL_CLOSES * PER_CLOSE.executions);
    const loaded = state.clients.flatMap((client) => client.dailyImports)
      .filter((entry) => entry.executions.length);
    expect(loaded).toHaveLength(LATEST_CLOSES);
  });

  it('asks for no parameter column, no password and no derivation', async () => {
    // 30.9 MB of strategy parameters, every client's NinjaTrader and prop firm
    // password, and a jsonb derivation report per account-day. The first two
    // are also a privacy change: params_parsed carries the machine LicenseKey.
    await loadSupabaseCrmState({});
    const everySelect = traffic.requests.map((request) => String(request.columns || '')).join(' | ');
    expect(everySelect).not.toMatch(/parameters_raw/);
    expect(everySelect).not.toMatch(/params_parsed/);
    expect(everySelect).not.toMatch(/password_encrypted/);
    expect(everySelect).not.toMatch(/derivation/);
    expect(requestsTo('client_credentials')).toHaveLength(0);
    expect(requestsTo('client_prop_firms')).toHaveLength(0);
  });

  it('names its columns rather than asking for every one', async () => {
    // `select *` ships every column a migration has ever added. The star is
    // allowed nowhere on the login path — not even on a small table, because a
    // small table is where the next unread column lands.
    await loadSupabaseCrmState({});
    const stars = traffic.requests.filter((request) => request.columns === '*');
    expect(stars).toEqual([]);
  });

  it('leaves the closed flags in the database', async () => {
    // 68.8% of flag rows on production are Resolved or Acknowledged, and the
    // queue cannot act on one of them. The filter is `not in`, plus anything
    // closed in the last fortnight so the queue keeps its receipts.
    const state = await loadSupabaseCrmState({});
    const statuses = new Set(
      state.clients.flatMap((client) => client.dailyImports).flatMap((entry) => entry.flags)
        .map((flag) => flag.status),
    );
    expect([...statuses].sort()).toEqual(['Open']);
    expect(columnsAskedOf('operational_flags').every((columns) => columns.includes('status'))).toBe(true);
    expect(requestsTo('operational_flags').every((request) => request.filtered)).toBe(true);
  });

  it('reads each client\'s latest close and no other', async () => {
    const state = await loadSupabaseCrmState({});
    const closes = state.clients.flatMap((client) => client.dailyImports);
    // Every close is still on the date picker; only the newest carries rows.
    expect(closes).toHaveLength(TOTAL_CLOSES);
    expect(closes.filter((entry) => entry.snapshotsLoaded)).toHaveLength(LATEST_CLOSES);
    expect(closes.filter((entry) => entry.snapshots.length)).toHaveLength(LATEST_CLOSES);
    for (const client of state.clients) {
      const loaded = client.dailyImports.filter((entry) => entry.snapshotsLoaded);
      expect(loaded.map((entry) => entry.date)).toEqual([client.dailyImports.at(-1).date]);
    }
    // And "latest" is decided by the trading date, not by the order the rows
    // came back in: a close uploaded late for an earlier day must not become
    // the one the funded table and the deviation alerts are drawn from.
    const latest = new Set(latestImportIdPerClient(BOOK.daily_imports));
    expect(latest.size).toBe(CLIENTS);
    for (const client of state.clients) {
      expect(latest.has(client.dailyImports.at(-1).uuid)).toBe(true);
    }
  });

  it('says of every close that its fills and parameters are NOT loaded', async () => {
    // Not loaded is not empty, and this is where the difference is recorded.
    // A close reporting `orders: []` because nobody fetched them and a close
    // that genuinely traded nothing are the same array otherwise, which is the
    // confusion accountLifecycle.js and StackPlaybook.jsx already have to work
    // around book-wide.
    const state = await loadSupabaseCrmState({});
    const closes = state.clients.flatMap((client) => client.dailyImports);
    expect(closes.some((entry) => entry.detailLoaded)).toBe(false);
    expect(closes.some((entry) => entry.parametersLoaded)).toBe(false);
  });

  it('costs one count per table plus one page per thousand rows, and a page per chunk of closes', async () => {
    await loadSupabaseCrmState({});
    // Wave one and two: one count and one page per thousand rows.
    const paged = (rows) => 1 + Math.ceil(rows / 1000);
    const expected = paged(CAMS)                                  // cam_profiles
      + paged(CLIENTS)                                            // clients
      + paged(CLIENTS)                                            // client_assignments
      + paged(0)                                                  // client_coverage (none in this book)
      + paged(CLIENTS * 7)                                        // trading_accounts
      + paged(0)                                                  // payout_events
      + paged(TOTAL_CLOSES)                                       // daily_imports
      + paged(Math.round(TOTAL_CLOSES * PER_CLOSE.operational_flags * 0.3)) // open flags only
      + paged(0)                                                  // tasks
      + paged(0)                                                  // activity_logs
      + paged(0)                                                  // price_checks
      + paged(0)                                                  // cam_time_off
      + paged(TOTAL_CLOSES * PER_CLOSE.close_summaries)           // close_summaries
      // Wave three: no count query at all, one page per chunk of 60 closes,
      // for each of the three per-close tables a first screen reads.
      + 3 * Math.ceil(LATEST_CLOSES / 60);
    expect(traffic.requests).toHaveLength(expected);
  });

  it('still overlaps the pages of a large table rather than waiting a round trip each', async () => {
    // The bound must not become a serial fetch: that was the state loadTable's
    // original comment was written to move away from, and a many-page table
    // down one round trip at a time is a slower login for the same total cost.
    await loadSupabaseCrmState({});
    expect(traffic.peakInFlight).toBeGreaterThan(1);
    expect(traffic.peakInFlight).toBeLessThanOrEqual(READ_CONCURRENCY);
  });

  it('reads every row of a table that spans many pages', async () => {
    // The bound and the column list change WHEN and WHAT, never WHICH rows: a
    // login that quietly stopped at page four would be a far worse defect than
    // the burst it replaced.
    const state = await loadSupabaseCrmState({});
    expect(state.clients).toHaveLength(CLIENTS);
    expect(state.clients.flatMap((client) => client.dailyImports)).toHaveLength(TOTAL_CLOSES);
    expect(state.closeSummaries).toHaveLength(TOTAL_CLOSES * PER_CLOSE.close_summaries);
  });

  it('scopes a CAM login to their own book', async () => {
    // 26 of 206 clients on the production desk, and every per-client table
    // narrowed with it. A CAM who cannot open the manager screen has no use for
    // the other seven books and should not be paying to download them.
    traffic.reset();
    const own = await measure(() => loadSupabaseCrmState({ scopeToCamProfileId: 'cam-3' }));
    const whole = await measure(() => loadSupabaseCrmState({}));
    expect(own.rows * CAMS).toBeLessThan(whole.rows * 2);
    const state = await loadSupabaseCrmState({ scopeToCamProfileId: 'cam-3' });
    const mine = BOOK.client_assignments.filter((row) => row.cam_profile_id === 'cam-3');
    expect(state.clients).toHaveLength(mine.length);
    for (const client of state.clients) {
      expect(Number(client.legacyIndex ?? client.id.split('-')[1]) % CAMS).toBe(3);
    }
  });

  it('asks the database for a CAM\'s own client rows, rather than filtering 206 in the browser', async () => {
    // WAVE ONE USED TO FETCH `clients` WHOLE and apply the scope afterwards in
    // memory. clientScopeFor reads cam_profiles, client_assignments and
    // client_coverage and nothing else, so the client table never had to be
    // there — and LOGIN_COLUMNS.clients carries full_name, email, phone,
    // additional_emails, messenger, notes, subscription_price, churn_reason
    // and churn_note. That is the desk's whole contact list and its commercial
    // terms on the wire of a CAM who will never open 180 of those books, which
    // is the same class of exposure this change removes for credentials.
    traffic.reset();
    await loadSupabaseCrmState({ scopeToCamProfileId: 'cam-3' });
    const mine = BOOK.client_assignments.filter((row) => row.cam_profile_id === 'cam-3');
    expect(requestsTo('clients').every((request) => request.filtered)).toBe(true);
    const fetched = traffic.requests
      .filter((request) => request.table === 'clients' && !request.head)
      .length;
    expect(fetched).toBeGreaterThan(0);
    const state = await loadSupabaseCrmState({ scopeToCamProfileId: 'cam-3' });
    expect(state.clients).toHaveLength(mine.length);
  });

  it('still reads every client row for a manager', async () => {
    traffic.reset();
    const state = await loadSupabaseCrmState({});
    expect(requestsTo('clients').every((request) => !request.filtered)).toBe(true);
    expect(state.clients).toHaveLength(CLIENTS);
  });

  it('reads the whole book for a CAM profile it cannot resolve', async () => {
    // A login that silently returns no clients is indistinguishable on screen
    // from a CAM with no book, and it is the failure this scoping must not
    // introduce.
    const state = await loadSupabaseCrmState({ scopeToCamProfileId: 'cam-does-not-exist' });
    expect(state.clients).toHaveLength(CLIENTS);
  });
});

async function measure(run) {
  traffic.reset();
  await run();
  return { requests: traffic.requests.length, rows: traffic.rows, peakInFlight: traffic.peakInFlight };
}

describe('what a click costs instead', () => {
  it('fetches one close\'s orders, executions, snapshots and strategies when it is opened', async () => {
    const cost = await measure(() => loadSupabaseCloseDetail(['imp-4-2']));
    // Four tables, one chunk each, no count query.
    expect(cost.requests).toBe(4);
    expect(cost.rows).toBe(
      PER_CLOSE.orders + PER_CLOSE.executions + PER_CLOSE.account_snapshots + PER_CLOSE.strategy_snapshots,
    );
    expect(columnsAskedOf('account_snapshots')[0]).toContain('derivation');
    expect(columnsAskedOf('strategy_snapshots')[0]).not.toContain('parameters_raw');
    expect(CLOSE_DETAIL_COLUMNS.orders).not.toContain('created_at');
  });

  it('puts the fetched rows on the close and marks it loaded', async () => {
    const state = await loadSupabaseCrmState({});
    const client = state.clients[4];
    const target = client.dailyImports[2];
    const detail = await loadSupabaseCloseDetail([target.uuid]);
    const { mergeSupabaseCloseDetail } = await import('./supabaseStore.js');
    const merged = mergeSupabaseCloseDetail(state, detail);
    const loaded = merged.clients[4].dailyImports[2];
    expect(loaded.orders).toHaveLength(PER_CLOSE.orders);
    expect(loaded.executions).toHaveLength(PER_CLOSE.executions);
    expect(loaded.detailLoaded).toBe(true);
    // The account each fill belongs to comes back with it. The previous merge
    // read `account_name` off objects that spell it `accountName`, so every
    // order and execution fetched after the shell carried an empty account.
    expect(loaded.orders.every((order) => order.accountName.startsWith('ACC-4-'))).toBe(true);
    expect(loaded.executions.every((fill) => fill.accountName.startsWith('ACC-4-'))).toBe(true);
    // Other closes are untouched, including the one the login loaded.
    expect(merged.clients[4].dailyImports.at(-1).snapshotsLoaded).toBe(true);
    expect(merged.clients[5].dailyImports[2].orders).toHaveLength(0);
  });

  it('fetches the parameter columns only when a panel asks, and only for its own day', async () => {
    const days = ['imp-1-11', 'imp-2-11', 'imp-3-11'];
    const cost = await measure(() => loadSupabaseStrategyParameters(days));
    expect(cost.requests).toBe(1);
    expect(cost.rows).toBe(days.length * PER_CLOSE.strategy_snapshots);
    expect(STRATEGY_PARAMETER_COLUMNS).toContain('parameters_raw');
    expect(STRATEGY_PARAMETER_COLUMNS).toContain('params_parsed');
    expect(columnsAskedOf('strategy_snapshots')[0]).toBe(STRATEGY_PARAMETER_COLUMNS);
  });

  it('keeps the parameters a panel already paid for when the close is opened', async () => {
    // THE PATH IS AUTOMATIC, NOT HYPOTHETICAL: selecting any client fires
    // ensureCloseDetail for the open close. CLOSE_DETAIL_COLUMNS.strategy_snapshots
    // deliberately omits parameters_raw and params_parsed, so the rebuilt rows
    // carried `parametersRaw: ''` and `params: {}` over rows a panel had just
    // fetched — while `parametersLoaded` was set true by the same merge and
    // App.jsx's parameterCache still said "loaded", so nothing refetched. The
    // three configuration panels then compared over stripped rows and reported
    // a finding.
    const state = await loadSupabaseCrmState({});
    const client = state.clients[4];
    const target = client.dailyImports.at(-1);
    const withParameters = mergeSupabaseStrategyParameters(
      state,
      await loadSupabaseStrategyParameters([target.uuid]),
    );
    const before = withParameters.clients[4].dailyImports.at(-1);
    expect(before.parametersLoaded).toBe(true);
    expect(before.strategies[0].parametersRaw).toBeTruthy();

    const { mergeSupabaseCloseDetail } = await import('./supabaseStore.js');
    const after = mergeSupabaseCloseDetail(
      withParameters,
      await loadSupabaseCloseDetail([target.uuid]),
    ).clients[4].dailyImports.at(-1);

    expect(after.strategies[0].parametersRaw).toBe(before.strategies[0].parametersRaw);
    expect(after.parametersLoaded).toBe(true);
    expect(after.detailLoaded).toBe(true);
  });

  it('does not claim the parameters are loaded when the fetch did not ask for them', () => {
    // `parametersLoaded` was `strategiesBy ? true : ...`, so ANY fetch that
    // carried strategy rows marked the close as holding its parameters. Only a
    // fetch that named the two columns may set it.
    const base = {
      clients: [{
        id: 'c1',
        accountRegistry: {},
        dailyImports: [{ id: 'imp', uuid: 'imp', date: '2026-07-30', snapshots: [], strategies: [] }],
      }],
    };
    const merged = applyCloseRows(base, {
      importIds: ['imp'],
      strategyRows: [{ id: 's1', daily_import_id: 'imp', strategy_name: 'URGO' }],
    });

    expect(merged.clients[0].dailyImports[0].parametersLoaded).toBe(false);
  });

  it('marks an opened close as holding its account rows', async () => {
    // `applyCloseRows` set detailLoaded and parametersLoaded and never
    // snapshotsLoaded, so an opened close stayed `snapshotsLoaded: false` for
    // the session. refreshMerge's carry-forward is gated on exactly that field,
    // so the next Refresh put the close's fills back and left its account table
    // blank, which is worse than blank.
    const state = await loadSupabaseCrmState({});
    const target = state.clients[4].dailyImports[2];
    expect(target.snapshotsLoaded).toBe(false);
    const { mergeSupabaseCloseDetail } = await import('./supabaseStore.js');
    const merged = mergeSupabaseCloseDetail(state, await loadSupabaseCloseDetail([target.uuid]));

    expect(merged.clients[4].dailyImports[2].snapshotsLoaded).toBe(true);
  });

  it('fetches the ranking window\'s account rows beside its strategy rows', async () => {
    // The board reads dailyImport.snapshots and then each snapshot's
    // strategies. A login holds the account rows of each client's LATEST close
    // only, so the strategy rows a 60-day window paid for had nowhere to nest
    // on every older close and were dropped: 594 of 3,805 on the book, a board
    // of 15 algorithms with none ranked.
    const days = ['imp-1-2', 'imp-2-2'];
    const cost = await measure(() => loadSupabaseRankingRows(days));
    expect(cost.requests).toBe(2);
    expect(cost.rows).toBe(
      days.length * (PER_CLOSE.strategy_snapshots + PER_CLOSE.account_snapshots),
    );
    const state = await loadSupabaseCrmState({});
    const older = state.clients[1].dailyImports[2];
    expect(older.snapshots).toHaveLength(0);
    const merged = mergeSupabaseStrategyParameters(
      state,
      await loadSupabaseRankingRows([older.uuid]),
    ).clients[1].dailyImports[2];

    expect(merged.snapshots).toHaveLength(PER_CLOSE.account_snapshots);
    expect(merged.snapshots.some((snapshot) => snapshot.strategies.length > 0)).toBe(true);
    expect(merged.snapshotsLoaded).toBe(true);
    expect(merged.parametersLoaded).toBe(true);
  });

  it('keeps an opened close\'s derivation when a narrower fetch re-reads its account rows', async () => {
    // `derivation` is a jsonb the close-detail fetch asks for and nothing else
    // does. The ranking window re-reads the same account rows without it, and a
    // straight rebuild would blank the per-algo split on a close somebody has
    // open. Same rule as the parameter columns, one table over.
    const state = await loadSupabaseCrmState({});
    const target = state.clients[4].dailyImports.at(-1);
    const { mergeSupabaseCloseDetail } = await import('./supabaseStore.js');
    const opened = mergeSupabaseCloseDetail(state, await loadSupabaseCloseDetail([target.uuid]));
    expect(opened.clients[4].dailyImports.at(-1).snapshots[0].derivation).toBeTruthy();

    const after = mergeSupabaseStrategyParameters(
      opened,
      await loadSupabaseRankingRows([target.uuid]),
    ).clients[4].dailyImports.at(-1);

    expect(after.snapshots[0].derivation).toBeTruthy();
  });

  it('fetches one client\'s credentials when that client is opened', async () => {
    const cost = await measure(() => loadSupabaseClientDetail('c-7'));
    // One lookup of the client uuid, then credentials, prop firms and the
    // export dialog's source_summary.
    expect(cost.requests).toBe(4);
    expect(requestsTo('client_credentials').every((request) => request.filtered)).toBe(true);
    expect(cost.rows).toBeLessThan(CLOSES_PER_CLIENT + 5);
  });

  it('re-reads a close\'s flags at every status before a Recalculate', async () => {
    // recalculateDailyImport carries prior triage forward by matching what the
    // close holds. On a login that fetched only unresolved flags it would not
    // see the Resolved ones and would regenerate them as Open — the operator's
    // work undone by a button that says it only re-reads the numbers.
    const rows = await loadSupabaseCloseFlags('imp-9-3');
    const statuses = new Set(rows.map((row) => row.status));
    expect(statuses.size).toBeGreaterThan(1);
    expect([...statuses]).toContain('Resolved');
  });
});

describe('a database that is one migration behind', () => {
  it('drops the column it does not have and loads the rest', async () => {
    // `select *` forgave this; an explicit column list does not, and a login
    // that failed outright on a database missing `ran` would break the promise
    // MIGRATIONS_TO_RUN.md makes for every step from 31 to 48.
    const withoutRan = {
      ...BOOK,
      strategy_snapshots: BOOK.strategy_snapshots.map((row) => ({ ...row })),
    };
    db.tables = withoutRan;
    const { supabase } = await import('../lib/supabaseClient');
    const realFrom = supabase.from;
    let refusals = 0;
    supabase.from = (table) => {
      const source = realFrom(table);
      if (table !== 'strategy_snapshots') return source;
      return {
        select(columns, options) {
          if (String(columns).includes('ran_basis')) {
            refusals += 1;
            return {
              in: () => ({ order: () => ({ range: () => Promise.resolve({
                data: null,
                error: { code: '42703', message: 'column strategy_snapshots.ran_basis does not exist' },
              }) }) }),
            };
          }
          return source.select(columns, options);
        },
      };
    };
    try {
      const state = await loadSupabaseCrmState({});
      expect(refusals).toBeGreaterThan(0);
      expect(state.clients.at(-1).dailyImports.at(-1).strategies).toHaveLength(PER_CLOSE.strategy_snapshots);
    } finally {
      supabase.from = realFrom;
    }
  });
});
