import { describe, expect, it, vi } from 'vitest';
import { createHandler, normalizeClientIds, resolveRange } from '../../export/clientExport.js';
import { createFakeSupabase } from './fakeSupabase.js';

const CAM_PROFILE = '11111111-1111-4111-8111-111111111111';
const OTHER_CAM = '22222222-2222-4222-8222-222222222222';
const MINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const MINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ACCOUNT_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const IMPORT_1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const IMPORT_2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const IMPORT_3 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';

// Two sessions inside the range and one before it, on a Monday/Tuesday pair so
// the week-to-date accumulator has something to accumulate.
function fixture() {
  return {
    clients: [
      { id: MINE_A, name: 'Client A', status: 'Active', product_key: 'WHOP-SECRET-A' },
      { id: MINE_B, name: 'Client B', status: 'Active', product_key: 'WHOP-SECRET-B' },
      { id: THEIRS, name: 'Client T', status: 'Active', product_key: 'WHOP-SECRET-T' },
    ],
    client_assignments: [
      { id: 'as1', client_id: MINE_A, cam_profile_id: CAM_PROFILE },
      { id: 'as2', client_id: MINE_B, cam_profile_id: CAM_PROFILE },
      { id: 'as3', client_id: THEIRS, cam_profile_id: OTHER_CAM },
    ],
    trading_accounts: [
      { id: ACCOUNT_A, client_id: MINE_A, account_name: 'ACC-1', account_type: 'Funded', status: 'Active', start_balance: 50000 },
      { id: 'acc-t', client_id: THEIRS, account_name: 'ACC-T', account_type: 'Cash', status: 'Active' },
    ],
    daily_imports: [
      { id: IMPORT_1, client_id: MINE_A, trading_date: '2026-07-20', status: 'Closed', source_summary: { orders: 12, executions: 5 } },
      { id: IMPORT_2, client_id: MINE_A, trading_date: '2026-07-21', status: 'Needs review', source_summary: { orders: 3, executions: 1 } },
      { id: IMPORT_3, client_id: MINE_A, trading_date: '2026-06-01', status: 'Closed', source_summary: {} },
    ],
    account_snapshots: [
      { id: 'sn1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, account_name: 'ACC-1', gross_realized_pnl: 250, account_balance: 50250, weekly_pnl: 250, unrealized_pnl: 0 },
      // No trading_account_id: 41 of 3,100 real snapshots are in this state.
      { id: 'sn2', daily_import_id: IMPORT_1, trading_account_id: null, account_name: 'ORPHAN', gross_realized_pnl: -50, account_balance: 1000, weekly_pnl: null, unrealized_pnl: 0 },
      { id: 'sn3', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, account_name: 'ACC-1', gross_realized_pnl: -100, account_balance: 50150, weekly_pnl: 150, unrealized_pnl: 0 },
      { id: 'sn-old', daily_import_id: IMPORT_3, trading_account_id: ACCOUNT_A, account_name: 'ACC-1', gross_realized_pnl: 999, account_balance: 49000, weekly_pnl: 999, unrealized_pnl: 0 },
    ],
    strategy_snapshots: [
      { id: 'st1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet' },
    ],
    orders: [{ id: 'o1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, external_order_id: 'X1' }],
    executions: [{ id: 'e1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A }],
    operational_flags: [
      { id: 'f1', daily_import_id: IMPORT_1, client_id: MINE_A, type: 'Risk', severity: 'Critical', message: 'm', created_at: '2026-07-20T20:00:00Z' },
      { id: 'f2', daily_import_id: null, client_id: MINE_A, type: 'Ops', severity: 'Warning', message: 'loose', created_at: '2026-07-21T09:00:00Z' },
      { id: 'f3', daily_import_id: null, client_id: MINE_A, type: 'Ops', severity: 'Warning', message: 'out of range', created_at: '2026-05-01T09:00:00Z' },
    ],
    tasks: [{ id: 't1', client_id: MINE_A, text: 'call', due_date: null }],
    activity_logs: [
      { id: 'a1', client_id: MINE_A, type: 'Note', text: 'n', log_date: null, created_at: '2026-07-21T10:00:00Z' },
      { id: 'a2', client_id: MINE_A, type: 'Note', text: 'old', log_date: null, created_at: '2026-05-01T10:00:00Z' },
    ],
    price_checks: [{ id: 'p1', client_id: MINE_A, check_date: '2026-07-21', instrument: 'ES' }],
    payout_events: [{ id: 'pe1', trading_account_id: ACCOUNT_A, payout_date: '2026-07-21', amount: 1000 }],
    reports: [{ id: 'r1', client_id: MINE_A, daily_import_id: IMPORT_1, report_type: 'daily_close', report_date: '2026-07-20', content: { message: 'sent', summary: { huge: 'x'.repeat(500) } } }],
    client_credentials: [{ id: 'cc1', client_id: MINE_A, password_encrypted: 'must-not-leak' }],
    client_prop_firms: [{ id: 'cp1', client_id: MINE_A, login: 'must-not-leak' }],
    audit_logs: [],
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ actor, tables = fixture(), ...options } = {}) {
  const inserts = [];
  const admin = createFakeSupabase(tables, { inserts, ...(options.missingTables ? { missingTables: options.missingTables } : {}) });
  const handler = createHandler({
    createClients: () => ({ admin, auth: {} }),
    authorize: vi.fn(async () => actor),
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    ...(options.maxRowsPerTable ? { maxRowsPerTable: options.maxRowsPerTable } : {}),
  });
  return { handler, inserts, admin };
}

const CAM = { id: 'user-cam', role: 'CAM', cam_profile_id: CAM_PROFILE };
const MANAGER = { id: 'user-manager', role: 'Manager', cam_profile_id: null };

async function post(handler, body) {
  const res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body }, res);
  return res;
}

describe('client export authorization', () => {
  it('refuses a CAM every client that is not theirs, not just the first', async () => {
    const { handler } = setup({ actor: CAM });
    const res = await post(handler, { clientIds: [MINE_A, THEIRS], from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Client assignment required.' });
    expect(JSON.stringify(res.body)).not.toContain('Client T');
  });

  it('refuses a CAM a client that does not exist with the identical message', async () => {
    const { handler } = setup({ actor: CAM });
    const denied = await post(handler, { clientIds: [THEIRS] });
    const ghost = await post(handler, { clientIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] });
    expect(ghost.statusCode).toBe(denied.statusCode);
    expect(ghost.body).toEqual(denied.body);
  });

  it('lets a Manager reach any client', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [THEIRS], from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(200);
    expect(res.body.scope.includedClients).toEqual([{ id: THEIRS, name: 'Client T' }]);
  });

  it('gives a CAM exactly their assigned clients when none are named', async () => {
    const { handler } = setup({ actor: CAM });
    const res = await post(handler, { from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(200);
    expect(res.body.scope.selection).toBe('assigned');
    expect(res.body.scope.clientIds.sort()).toEqual([MINE_A, MINE_B].sort());
    expect(res.body.tables.clients.map((row) => row.id)).not.toContain(THEIRS);
  });

  it('refuses a CAM with no assignments at all', async () => {
    const { handler } = setup({ actor: { id: 'u', role: 'CAM', cam_profile_id: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz' } });
    const res = await post(handler, {});
    expect(res.statusCode).toBe(403);
  });

  it('only accepts POST', async () => {
    const { handler } = setup({ actor: CAM });
    const res = response();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('client export payload', () => {
  it('never carries credentials, prop-firm rows or the collector product key', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    const serialized = JSON.stringify({ tables: res.body.tables, series: res.body.series });
    expect(serialized).not.toMatch(/must-not-leak|WHOP-SECRET/);
    expect(res.body.tables.client_credentials).toBeUndefined();
    expect(res.body.tables.client_prop_firms).toBeUndefined();
    expect(res.body.tables.clients[0]).not.toHaveProperty('product_key');
    expect(res.body.excludedTables).toEqual(['client_credentials', 'client_prop_firms']);
  });

  it('keeps reports.content.message and drops the re-rendered summary', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.body.tables.reports[0].content).toEqual({ message: 'sent' });
  });

  it('scopes every table to the range', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.body.rowCounts).toMatchObject({
      daily_imports: 2,
      account_snapshots: 3,
      // f1 hangs off an import, f2 is loose but inside the created_at window,
      // f3 is loose and outside it.
      operational_flags: 2,
      activity_logs: 1,
      price_checks: 1,
      payout_events: 1,
    });
    expect(res.body.tables.daily_imports.map((row) => row.trading_date)).not.toContain('2026-06-01');
  });

  it('omits trade history unless asked, and says where the counts came from', async () => {
    const { handler } = setup({ actor: MANAGER });
    const without = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(without.body.tables.orders).toBeUndefined();
    expect(without.body.omittedTables.map((entry) => entry.table)).toContain('orders');
    const day = without.body.series[0].days[0];
    expect(day.counts).toMatchObject({ orders: 12, executions: 5, countedFrom: 'daily_imports.source_summary' });

    const withTrades = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21', includeTradeHistory: true });
    expect(withTrades.body.rowCounts.orders).toBe(1);
    expect(withTrades.body.series[0].days[0].counts.countedFrom).toBe('exported_rows');
  });

  it('tolerates a table that is not in the schema', async () => {
    const { handler } = setup({ actor: MANAGER, missingTables: ['price_checks'] });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(200);
    expect(res.body.skippedTables).toEqual([{ table: 'price_checks', reason: expect.stringContaining('Could not find the table') }]);
    expect(res.body.tables.price_checks).toBeUndefined();
  });

  it('declares a truncation instead of returning a short payload silently', async () => {
    const { handler, inserts } = setup({ actor: MANAGER, maxRowsPerTable: 2 });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncation.map((entry) => entry.table)).toContain('account_snapshots');
    expect(res.body.rowCounts.account_snapshots).toBe(2);
    expect(inserts[0].row.after_data.truncated).toBe(true);
  });

  it('states the gross/net ambiguity of gross_realized_pnl in the envelope', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    const caveat = res.body.caveats.find((entry) => entry.field === 'account_snapshots.gross_realized_pnl');
    expect(caveat.basis).toBe('mixed-gross-and-net');
    expect(caveat.note).toMatch(/net of commissions/);
    expect(caveat.note).toMatch(/csvImport\.js:244/);
    expect(res.body.series[0].summary.pnlBasis).toBe('mixed-gross-and-net');
  });

  it('audits who, which clients, which range and how many rows', async () => {
    const { handler, inserts } = setup({ actor: CAM });
    await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('audit_logs');
    expect(inserts[0].row).toMatchObject({
      user_id: 'user-cam',
      entity_type: 'client_data_export',
      action: 'client_data_export.create',
    });
    expect(inserts[0].row.after_data).toMatchObject({
      selection: 'explicit',
      clientIds: [MINE_A],
      clientCount: 1,
      range: { from: '2026-07-20', to: '2026-07-21', days: 2, source: 'request' },
      truncated: false,
    });
    expect(inserts[0].row.after_data.totalRows).toBeGreaterThan(0);
  });

  it('emits a client with no sessions rather than dropping it', async () => {
    const { handler } = setup({ actor: CAM });
    const res = await post(handler, { from: '2026-07-20', to: '2026-07-21' });
    const quiet = res.body.series.find((entry) => entry.clientId === MINE_B);
    expect(quiet).toMatchObject({ clientName: 'Client B', days: [], summary: null });
  });
});

describe('client export continuity series', () => {
  it('reports P&L per account per day, the day total and week to date', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    const [monday, tuesday] = res.body.series[0].days;

    expect(monday.date).toBe('2026-07-20');
    expect(monday.accounts).toHaveLength(2);
    expect(monday.accounts[0]).toMatchObject({ accountName: 'ACC-1', accountType: 'Funded', realizedPnl: 250 });
    // The snapshot with no trading_account_id survives with a null reference.
    expect(monday.accounts[1]).toMatchObject({ accountName: 'ORPHAN', tradingAccountId: null, accountType: null });
    expect(monday.totals.realizedPnl).toBe(200);
    expect(monday.week).toMatchObject({ weekStart: '2026-07-20', toDateDerivedInRange: 200, startsBeforeRange: false });

    expect(tuesday.totals.realizedPnl).toBe(-100);
    expect(tuesday.week.toDateDerivedInRange).toBe(100);
    expect(tuesday.cumulative.pnl).toBe(100);
  });

  it('keeps a missing weekly accumulator null instead of collapsing it to zero', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    const monday = res.body.series[0].days[0];
    expect(monday.accounts[1].weeklyPnlReported).toBeNull();
    // One account reported 250 and the other reported nothing, so the day's
    // reported accumulator is 250 rather than 250 + a fabricated 0.
    expect(monday.week.toDateReported).toBe(250);
  });

  it('counts positive, negative and unreviewed sessions', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.body.series[0].summary).toMatchObject({
      sessions: 2,
      positiveSessions: 1,
      negativeSessions: 1,
      flatSessions: 0,
      daysWithoutPnl: 0,
      closedSessions: 1,
      netPnl: 100,
    });
  });

  it('flags a week that began before the exported range', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-21', to: '2026-07-21' });
    expect(res.body.series[0].days[0].week).toMatchObject({
      weekStart: '2026-07-20',
      startsBeforeRange: true,
    });
  });
});

describe('range resolution', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it('defaults to the last 30 days and says so', () => {
    expect(resolveRange({}, now)).toEqual({
      from: '2026-06-23', to: '2026-07-22', days: 30, source: 'default', defaultRangeDays: 30,
    });
  });

  it('completes a half-open range from either end', () => {
    expect(resolveRange({ from: '2026-07-01' }, now)).toMatchObject({ from: '2026-07-01', to: '2026-07-22', source: 'partial-default-to' });
    expect(resolveRange({ to: '2026-07-10' }, now)).toMatchObject({ from: '2026-06-11', to: '2026-07-10', source: 'partial-default-from' });
  });

  it('rejects a reversed, malformed or oversized range', () => {
    expect(() => resolveRange({ from: '2026-07-10', to: '2026-07-01' }, now)).toThrow(/after/);
    expect(() => resolveRange({ from: '10/07/2026', to: '2026-07-01' }, now)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange({ from: '2026-02-30', to: '2026-07-01' }, now)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange({ from: '2026-01-01', to: '2026-07-01' }, now)).toThrow(/maximum is 92/);
  });
});

describe('client id validation', () => {
  it('treats an absent or empty list as "all my clients"', () => {
    expect(normalizeClientIds(undefined)).toBeNull();
    expect(normalizeClientIds([])).toBeNull();
  });

  it('rejects anything that is not a uuid, and de-duplicates', () => {
    expect(() => normalizeClientIds('all')).toThrow(/array/);
    expect(() => normalizeClientIds(['not-a-uuid'])).toThrow(/uuids/);
    expect(normalizeClientIds([MINE_A, MINE_A.toUpperCase()])).toEqual([MINE_A]);
  });

  it('refuses more clients than one export may carry', () => {
    const many = Array.from({ length: 61 }, (_, index) => (
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
    ));
    expect(() => normalizeClientIds(many)).toThrow(/maximum is 60/);
  });
});

// A session the desk closed with no account_snapshots behind it. This is not a
// hypothetical: 12 of the 535 daily_imports on public/local-snapshot.json are in
// exactly this state, and 9 clients on the book have no other kind of session, so
// their whole summary is built out of days whose P&L was never measured.
const IMPORT_BARE = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';

function fixtureWithBareSession() {
  const tables = fixture();
  tables.daily_imports.push({
    id: IMPORT_BARE, client_id: MINE_A, trading_date: '2026-07-22', status: 'Closed', source_summary: {},
  });
  return tables;
}

describe('client export undetermined sessions', () => {
  it('leaves a session with no snapshots null rather than reporting a flat day', async () => {
    const { handler } = setup({ actor: MANAGER, tables: fixtureWithBareSession() });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-22', to: '2026-07-22' });
    const [day] = res.body.series[0].days;

    expect(day.accounts).toEqual([]);
    // Every one of these is a figure nobody measured. A 0 here tells the analysis
    // the client traded and broke even, which is the one reading that is wrong in
    // both directions at once.
    expect(day.totals.realizedPnl).toBeNull();
    expect(day.totals.unrealizedPnl).toBeNull();
    expect(day.totals.accountBalance).toBeNull();
    expect(day.week.toDateReported).toBeNull();
    expect(day.week.toDateDerivedInRange).toBeNull();
  });

  it('excludes undetermined days from the positive/negative/flat denominator', async () => {
    const { handler } = setup({ actor: MANAGER, tables: fixtureWithBareSession() });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-22' });
    const { summary } = res.body.series[0];

    // Three sessions, two of them measured (+250-50 and -100) and one not.
    expect(summary.sessions).toBe(3);
    expect(summary.daysWithoutPnl).toBe(1);
    expect(summary.positiveSessions + summary.negativeSessions + summary.flatSessions)
      .toBe(summary.sessions - summary.daysWithoutPnl);
    expect(summary.flatSessions).toBe(0);
  });

  it('reports no net P&L at all when every session in the range is undetermined', async () => {
    const { handler } = setup({ actor: MANAGER, tables: fixtureWithBareSession() });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-22', to: '2026-07-22' });
    const { summary } = res.body.series[0];

    expect(summary.sessions).toBe(1);
    expect(summary.daysWithoutPnl).toBe(1);
    expect(summary.netPnl).toBeNull();
    expect(summary.maxDrawdown).toBeNull();
  });
});

describe('client export paging', () => {
  // The page size is 1000 and the fixtures elsewhere hold single-figure row
  // counts, so nothing else in this file ever runs the paging loop twice. On the
  // real book a 36-day pull for the busiest CAM reads 4,356 orders, which is five
  // pages: a page boundary that overlaps or skips by one row is invisible until
  // the payload is counted.
  it('reads every row exactly once across page boundaries', async () => {
    const tables = fixture();
    tables.orders = Array.from({ length: 2500 }, (_, index) => ({
      id: `ord-${String(index).padStart(5, '0')}`,
      daily_import_id: IMPORT_1,
      trading_account_id: ACCOUNT_A,
      external_order_id: `X${index}`,
    }));
    const { handler } = setup({ actor: MANAGER, tables });
    const res = await post(handler, {
      clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21', includeTradeHistory: true,
    });

    expect(res.body.truncated).toBe(false);
    expect(res.body.rowCounts.orders).toBe(2500);
    expect(new Set(res.body.tables.orders.map((row) => row.id)).size).toBe(2500);
    // The per-day count is read back off the same rows, so a duplicated page
    // would inflate the session's order count as well as the table.
    expect(res.body.series[0].days[0].counts.orders).toBe(2500);
  });
});

// Everything below was written from an adversarial pass over the endpoint,
// running the real requireClientAssignments/listAssignedClientIds against the
// redacted copy of the book rather than against fixtures. Each case is a hole
// that was open, or a claim that needed proving rather than asserting.
describe('client export hardening', () => {
  it('rejects a value that merely coerces to a uuid', async () => {
    const { handler } = setup({ actor: CAM });
    // String([x]) is x, so `[[uuid]]` used to pass validation. It authorized the
    // same id it fetched so it was never a bypass, but the contract is "a
    // string that is a uuid", not "anything with a toString".
    const res = await post(handler, { clientIds: [[MINE_A]] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('client uuids only');
  });

  it('rejects a falsy-but-present date instead of silently defaulting the range', async () => {
    const { handler } = setup({ actor: CAM });
    // `if (from && !rawFrom)` let 0 and false through: the caller asked for a
    // range and got the default window back without an error.
    for (const from of [0, false]) {
      const res = await post(handler, { clientIds: [MINE_A], from, to: '2026-07-21' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('Invalid "from" date');
    }
  });

  it('fetches the set that was authorized, not the set that was requested', async () => {
    // requireClientAssignments is what decides; resolveScope must not fall back
    // to the caller's own list. A stub that clears fewer ids than it was given
    // is a denial, never a quiet narrowing to the cleared ones.
    const inserts = [];
    const admin = createFakeSupabase(fixture(), { inserts });
    const handler = createHandler({
      createClients: () => ({ admin, auth: {} }),
      authorize: vi.fn(async () => CAM),
      authorizeMany: vi.fn(async () => [MINE_A]),
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const res = await post(handler, { clientIds: [MINE_A, MINE_B] });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Client assignment required.' });
  });

  it('writes an audit row when an export is refused, not only when it succeeds', async () => {
    // audit_logs is the only detection surface here: no rate limit, no WAF. A
    // caller walking client uuids one at a time used to leave nothing behind.
    const { handler, inserts } = setup({ actor: CAM });
    const res = await post(handler, { clientIds: [THEIRS], from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(403);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.action).toBe('client_data_export.denied');
    expect(inserts[0].row.user_id).toBe('user-cam');
    expect(inserts[0].row.after_data.requestedClientIds).toEqual([THEIRS]);
    expect(inserts[0].row.after_data.range).toMatchObject({ from: '2026-07-20', to: '2026-07-21' });
    // The response still says nothing about which id failed.
    expect(res.body).toEqual({ error: 'Client assignment required.' });
  });

  it('shares one row budget across tables instead of a per-table ceiling that bounds nothing', async () => {
    // 60,000 x 14 tables is 840,000 rows. Replaying the book's densities over
    // the limits this endpoint permits reaches 263,280 of them and 103 MB.
    const tables = fixture();
    tables.orders = Array.from({ length: 400 }, (_, index) => ({
      id: `ord-${String(index).padStart(4, '0')}`, daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A,
    }));
    tables.executions = Array.from({ length: 400 }, (_, index) => ({
      id: `exe-${String(index).padStart(4, '0')}`, daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A,
    }));
    const inserts = [];
    const admin = createFakeSupabase(tables, { inserts });
    const handler = createHandler({
      createClients: () => ({ admin, auth: {} }),
      authorize: vi.fn(async () => MANAGER),
      maxTotalRows: 300,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const res = await post(handler, {
      clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21', includeTradeHistory: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.totalRows).toBeLessThanOrEqual(300);
    expect(res.body.truncated).toBe(true);
    // Truncation names the request budget, not a per-table ceiling nobody hit.
    expect(res.body.truncation.some((entry) => entry.scope === 'request')).toBe(true);
    expect(res.body.limits.maxTotalRows).toBe(300);
    // Every table that was cut short is named. Silence here would read
    // downstream as "the client did not trade".
    expect(res.body.truncation.map((entry) => entry.table)).toContain('orders');
  });

  it('refuses a payload larger than a single response can carry, with the measured size', async () => {
    // Vercel caps a serverless response at 4.5 MB. The busiest CAM's default
    // 30-day pull with trade history is 6.92 MB, so this endpoint's own
    // headline case returned an opaque platform 500 after paying for every read.
    const tables = fixture();
    tables.orders = Array.from({ length: 400 }, (_, index) => ({
      id: `ord-${String(index).padStart(4, '0')}`,
      daily_import_id: IMPORT_1,
      trading_account_id: ACCOUNT_A,
      notes: 'x'.repeat(200),
    }));
    const inserts = [];
    const admin = createFakeSupabase(tables, { inserts });
    const handler = createHandler({
      createClients: () => ({ admin, auth: {} }),
      authorize: vi.fn(async () => MANAGER),
      maxResponseBytes: 50000,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const res = await post(handler, {
      clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21', includeTradeHistory: true,
    });

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toContain('over the');
    expect(res.body.error).toContain('with trade history');
    // Refused, so no success row — but the attempt is still on the record.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.action).toBe('client_data_export.denied');
    expect(inserts[0].row.after_data.reason).toBe('response_too_large');
  });

  it('records the measured response size on the success path', async () => {
    const { handler, inserts } = setup({ actor: CAM });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(200);
    expect(inserts[0].row.action).toBe('client_data_export.create');
    expect(inserts[0].row.after_data.responseBytes).toBeGreaterThan(0);
  });

  it('leaves bestDay and worstDay null when no session had a determinable P&L', async () => {
    // buildPerformanceSeries needs a number, so an undetermined day enters it as
    // 0. Reporting that 0 back as bestDay.pnl dresses a day nobody measured as a
    // measured flat day, next to daysWithoutPnl saying the opposite.
    const tables = fixture();
    tables.account_snapshots = [];
    const { handler } = setup({ actor: CAM, tables });
    const res = await post(handler, { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' });

    const summary = res.body.series[0].summary;
    expect(summary.daysWithoutPnl).toBe(2);
    expect(summary.bestDay).toBeNull();
    expect(summary.worstDay).toBeNull();
    expect(summary.netPnl).toBeNull();
  });

  it('accepts a client id whose uuid version nibble is not 4', async () => {
    // The regex used to pin version 1-5 and variant 8/9/a/b. Every id on the
    // real book is gen_random_uuid() v4, but a nil uuid or a v7 is a legitimate
    // value in a uuid column and would have 400'd on a client that exists.
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(normalizeClientIds([nil])).toEqual([nil]);
  });
});
