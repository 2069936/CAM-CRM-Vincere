import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import {
  DailyImportClosedError,
  persistDailyImportWithClient,
  withLegacyDailyImportId,
} from './dailyImportPersistence';
import { normalizeSubscriptionPrice } from './subscriptionPrice';
import { normalizeClientTags } from './clientTags';
import { normalizeAccountFocus } from './clientAccountFocus';
import { mergeSimulationRows, splitSimulationRows } from './simulationAccounts';
import {
  attachClientIds,
  buildCloseSummaryRows,
  closeSummaryFromRow,
  closeSummaryToDb,
} from './closeSummary';
import { createRequestGate } from './supabaseRetry';

function pickId(row) {
  return row.legacy_key || row.id;
}

function byId(rows) {
  return Object.fromEntries((rows || []).map((row) => [row.id, row]));
}

function byLegacy(rows) {
  return Object.fromEntries((rows || []).map((row) => [pickId(row), row]));
}

function accountMetaFromRow(row) {
  return {
    id: row.id,
    accountName: row.account_name,
    alias: row.alias || row.account_name,
    connection: row.connection || '',
    accountType: row.account_type || 'Unassigned',
    status: row.status || 'Active',
    payoutState: row.payout_state || 'Not requested',
    targetProfit: row.target_profit ?? '',
    startBalance: row.start_balance ?? '',
    maxDrawdownLimit: row.max_drawdown_limit ?? '',
    propFirmPlan: row.prop_firm_plan || '',
    // '' means no opinion recorded (the automatic signals decide), NOT "live".
    // See simulationAccounts.js SIMULATION_MODES.
    simulationMode: row.simulation_mode || '',
    riskLevel: row.risk_level || '',
    bulletBotPassType: row.bullet_bot_pass_type || '',
    bulletBotDirection: row.bullet_bot_direction || '',
    algoStack: row.algo_stack || '',
    dailyLossLimit: row.daily_loss_limit || '',
    notes: row.notes || '',
    dateAdded: row.date_added || '',
    dateFunded: row.date_funded || '',
    dateFailed: row.date_failed || '',
    dateLastPayout: row.date_last_payout || '',
    payoutCount: row.payout_count || 0,
    tradovateAccountId: row.tradovate_account_id || '',
    payoutHistory: [],
  };
}

function strategyFromRow(row, accountById = {}) {
  const params = row.params_parsed && typeof row.params_parsed === 'object'
    ? row.params_parsed
    : {};
  return {
    id: row.id,
    strategyName: row.strategy_name || '',
    // The row points at an account and the mapped object dropped it, so
    // anything reading dailyImport.strategies saw rows belonging to nobody.
    // Per-account grouping — which family runs where, how many accounts a
    // configuration is on — came out empty against real data.
    accountName: accountById[row.trading_account_id]?.account_name || '',
    strategyFamily: row.strategy_family || '',
    strategyVersion: row.strategy_version || '',
    instrument: row.instrument || '',
    dataSeries: row.data_series || '',
    parametersRaw: row.parameters_raw || '',
    params,
    direction: row.direction || params.direction || '',
    enabled: Boolean(row.enabled),
    // `Number(row.realized || 0)` collapsed NULL into 0 on the way back, which
    // undid the whole reported/absent distinction on a reload: a strategy the
    // export said nothing about came back claiming it had made nothing. Absence
    // has to survive the round trip or the parse fix only holds until the page
    // is refreshed. A stored 0 is still a 0 — rows written before the
    // distinction existed carry one and cannot be told apart after the fact.
    realized: numberOrNull(row.realized),
    unrealized: numberOrNull(row.unrealized),
    // What the fills say, kept separate from what the export said, forever.
    // Null on every close stored before step 37 added the column, which reads as
    // "not derived" and makes the UI refuse a derived split rather than invent
    // one — the safe direction.
    // Why this row does or does not carry a figure is NOT read back per row,
    // because it is not stored per row: the account-day's verdict and its join
    // report live once on `account_snapshots.derivation`, which
    // `snapshotFromRow` below returns beside these strategies. A reader wanting
    // the per-row reason recovers it from the two together — see the ROW_JOIN
    // comment in joinDerivedStrategies.js for the mapping.
    derivedRealized: numberOrNull(row.derived_realized),
    // Whether the algorithm ran that day, and on what evidence. Step 47.
    //
    // Carried as null when the column is absent or the row has not been
    // backfilled, and strategyRan.js then falls back to the rule over whatever
    // the caller holds — which, at login, is the checkbox and the row's own
    // realized. That is the answer the product gave before this column existed,
    // so the code deploys safely ahead of the migration. The point of reading it
    // here is that it survives without the fills: the executions arrive in a
    // second pass (hydrateTradeHistory), and until then nothing else on the row
    // can say the day happened.
    ran: typeof row.ran === 'boolean' ? row.ran : null,
    ranBasis: row.ran_basis || '',
  };
}

function snapshotFromRow(row, strategiesBySnapshot, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.id,
    accountName: row.account_name,
    connection: row.connection || account?.connection || '',
    grossRealizedPnl: Number(row.gross_realized_pnl || 0),
    trailingMaxDrawdown: Number(row.trailing_max_drawdown || 0),
    accountBalance: Number(row.account_balance || 0),
    weeklyPnl: Number(row.weekly_pnl || 0),
    unrealizedPnl: Number(row.unrealized_pnl || 0),
    // The derivation report for this account-day, as reconcile produced it.
    // buildAlgoAccountHistory will not show a per-algo split without it: the
    // per-row figures alone cannot be checked, and an unverifiable figure that
    // looks like a measurement is the failure this whole feature exists to
    // avoid. Null on every close stored before step 37.
    derivation: row.derivation || null,
    meta: account ? accountMetaFromRow(account) : {},
    strategies: strategiesBySnapshot[row.id] || [],
  };
}

function executionFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.external_execution_id || row.id,
    accountName: account?.account_name || '',
    strategyName: row.strategy_name || '',
    instrument: row.instrument || '',
    action: row.action || '',
    quantity: Number(row.quantity || 0),
    price: Number(row.price || 0),
    time: row.time_text || '',
    entryExit: row.entry_exit || '',
    position: row.position || '',
    orderId: row.external_order_id || '',
    name: row.name || '',
    commission: Number(row.commission || 0),
    rate: Number(row.rate || 0),
    connection: row.connection || account?.connection || '',
  };
}

function orderFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.external_order_id || row.id,
    accountName: account?.account_name || '',
    strategyName: row.strategy_name || '',
    instrument: row.instrument || '',
    action: row.action || '',
    orderType: row.order_type || '',
    quantity: Number(row.quantity || 0),
    limit: Number(row.limit_price || 0),
    stop: Number(row.stop_price || 0),
    state: row.state || '',
    filled: Number(row.filled || 0),
    avgPrice: Number(row.avg_price || 0),
    remaining: Number(row.remaining || 0),
    name: row.name || '',
    time: row.time_text || '',
  };
}

function flagFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    accountName: account?.account_name || '',
    message: row.message,
    status: row.status || 'Open',
    resolvedAt: row.resolved_at || '',
  };
}

function taskFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.legacy_key || row.id,
    text: row.text,
    priority: row.priority || 'Normal',
    dueDate: row.due_date || '',
    accountName: account?.account_name || '',
    done: Boolean(row.done),
    doneAt: row.done_at || '',
    createdAt: row.created_at || '',
  };
}

function activityFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.legacy_key || row.id,
    type: row.type,
    text: row.text,
    accountName: account?.account_name || '',
    createdAt: row.created_at || '',
    logDate: row.log_date || '',
    logPnl: row.log_pnl != null ? Number(row.log_pnl) : null,
  };
}

function priceCheckFromRow(row) {
  return {
    id: row.id,
    date: row.check_date || '',
    instrument: row.instrument || '',
    time: row.time_label || '',
    checkTime: row.time_label || '',
    price: row.price ?? '',
    connection: row.connection_status || '',
    connectionStatus: row.connection_status || '',
    algos: row.algo_status || '',
    algoStatus: row.algo_status || '',
    notes: row.notes || '',
    checked: Boolean(row.checked),
  };
}

function timeOffFromRow(row, camIdByUuid) {
  return {
    id: row.id,
    camProfileId: camIdByUuid[row.cam_profile_id] || row.cam_profile_id,
    camUuid: row.cam_profile_id,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    kind: row.kind || 'Vacation',
    note: row.note || '',
    status: row.status || 'Pending',
    requestedAt: row.requested_at || '',
    decidedAt: row.decided_at || '',
    decisionNote: row.decision_note || '',
  };
}

function coverageFromRow(row, camIdByUuid, clientIdByUuid) {
  return {
    id: row.id,
    clientId: clientIdByUuid[row.client_id] || row.client_id,
    coveringCamId: camIdByUuid[row.covering_cam_profile_id] || row.covering_cam_profile_id,
    absentCamId: camIdByUuid[row.absent_cam_profile_id] || row.absent_cam_profile_id || '',
    timeOffId: row.time_off_id || '',
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    note: row.note || '',
  };
}

function propFirmFromRow(row) {
  const firmName = row.firm_name || '';
  return {
    id: row.id,
    name: firmName,
    firmName,
    connection: row.connection || 'Tradovate',
    login: row.login || '',
    password: row.password_encrypted || '',
    sortOrder: row.sort_order ?? 0,
  };
}

function reportError(label, error) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

/**
 * How many Supabase reads this tab may have in flight at once.
 *
 * Four, not "as many as there are pages". The previous code fired one count per
 * table and then every page of that table in a single Promise.all, so a load
 * left the browser as one burst — on the current book 117 requests, of which 31
 * were pages of `orders` and 16 pages of `operational_flags`. Twelve machines
 * doing that in quick succession is what the project started refusing, and
 * `orders` gains a page every trading day, so one tab reaches the same cliff on
 * its own eventually.
 *
 * The gate is shared by every table in a load — see createRequestGate — because
 * a per-table bound of four still leaves nineteen tables' worth in flight.
 */
export const READ_CONCURRENCY = 4;
const readGate = createRequestGate(READ_CONCURRENCY);

// ---------------------------------------------------------------------------
// LOAD WHAT THE SCREEN NEEDS, NOT THE DATABASE.
//
// Measured on production on 2026-09-22, a login fetched all eighteen CRM tables
// in full with `select *`: 148,011 rows over 178 round trips, about 105 MB of
// JSON, of which 37.8 MB was two columns of `strategy_snapshots` that two
// collapsed panels read and 40.5 MB was `orders` and `executions`, which no
// first screen reads at all. Eight people signing in at once is eight times
// that against one instance, which is why the CRM ran clean at 07:30 and hung
// at 09:00. The book doubles about every 39 days — `orders` went 30,955 on
// 20 Aug to 55,856 on 22 Sep — so this is a cliff that arrives on its own.
//
// FOUR RULES, in the order they matter.
//
//   1. COLUMNS. Every select below names its columns. `select *` ships every
//      column a migration has ever added to every row: `created_at` alone is
//      48 B across 82,437 `orders` and `executions` rows, 3.8 MB per login for
//      a timestamp nothing reads. `parameters_raw` and `params_parsed` are 82%
//      of a strategy row and leave the login entirely; `params_parsed` also
//      carries the machine LicenseKey, which has no business in a browser.
//      `client_credentials` and `client_prop_firms` leave for the same reason:
//      every CAM's tab held every client's passwords.
//
//   2. GRAIN. A login must stop being O(closes x accounts) and become
//      O(clients x accounts). The per-close money comes from `close_summaries`
//      (step 48), one row per close per segment, written by the ingest from the
//      same buildSegmentTotals the screen used to run in the browser. Full
//      per-account detail is fetched for each client's LATEST close only, which
//      is what the funded table, the evaluations table and the deviation alerts
//      read.
//
//   3. ROWS. Flags are fetched unresolved, plus anything closed in the last
//      fortnight so the queue keeps its receipts. A date window is deliberately
//      NOT used on that table: see camFlagQueue.js, where 1,102 of 1,699 open
//      rows sit behind the latest close and two CAMs have no open flag on any
//      latest close at all.
//
//   4. ON DEMAND. Opening a client fetches that client's credentials and prop
//      firm logins; opening a close fetches that close's orders, executions and
//      derivations; opening ConfigDriftPanel or SetFileMatchPanel fetches the
//      parameter columns for the day on screen. Each goes through the same
//      bounded gate as the login, because eight people opening three panels
//      must not reproduce the burst the bound exists to prevent.
//
// The bound itself is unchanged and is the 429 incident: see READ_CONCURRENCY.
// ---------------------------------------------------------------------------

/**
 * Columns that only exist where a migration has run.
 *
 * `select *` forgave a database that was one migration behind; an explicit
 * column list does not — PostgREST answers 42703 and the whole login fails. So
 * a select that names a column the database does not have drops that column and
 * runs again, and remembers the answer for the rest of the session. On a
 * database that is behind it costs up to READ_CONCURRENCY extra round trips per
 * absent column per table, and nothing at all on one that is not: `loadTable`
 * fires a table's pages through Promise.all before any of them has written to
 * `agreedColumns`, so the first pages each discover the missing column on their
 * own. The agreement is then made once and every later read of that table is
 * free. Said as a range rather than as "one, once" because the one-trip figure
 * was the intent and not the behaviour, and a cost stated too low is the kind
 * of comment that stops somebody measuring.
 *
 * This is the same promise MIGRATIONS_TO_RUN.md already makes for steps 31 to
 * 48 ON THE READ SIDE. It is not true of a write: an insert that names a column
 * the database does not have fails, and the runbook says which steps must be
 * run before the deploy for that reason.
 */
const MISSING_COLUMN = /column\s+"?(?:[a-z0-9_]+\.)?([a-z0-9_]+)"?\s+does not exist/i;

/** Column lists this session has already agreed with the database. */
const agreedColumns = new Map();

function columnsWithout(columns, name) {
  const kept = String(columns)
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column && column !== name);
  return kept.join(', ');
}

/**
 * One gated select, with the missing-column fallback above.
 *
 * `build` receives the PostgREST builder with the columns already applied and
 * returns it with the filters, ordering and range this particular read wants.
 */
async function selectRows(table, columns, build) {
  const key = `${table}|${columns}`;
  let wanted = agreedColumns.get(key) || columns;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await readGate(() => build(supabase.from(table).select(wanted)));
    if (!error) {
      agreedColumns.set(key, wanted);
      return data || [];
    }
    const missing = wanted === '*' ? null : (MISSING_COLUMN.exec(error.message || '')?.[1] || null);
    const next = missing ? columnsWithout(wanted, missing) : wanted;
    if (!missing || next === wanted) reportError(table, error);
    wanted = next;
  }
  throw new Error(`${table}: could not agree a column list with the database.`);
}

const PAGE_SIZE = 1000;

/**
 * Every row of a table, or of a filtered slice of one.
 *
 * Supabase/PostgREST caps an unbounded select at 1000 rows, so without
 * pagination a team with many accounts, snapshots or flags would silently load
 * only the first thousand of each — dropping whole clients and their history.
 * The count comes first so the pages can overlap; no more than
 * READ_CONCURRENCY of them are ever in flight, across all tables, and
 * Promise.all still resolves in page order.
 */
async function loadTable(table, { columns = '*', filter = null } = {}) {
  const applyFilter = (query) => (filter ? filter(query) : query);
  const { count, error: countError } = await readGate(() => applyFilter(supabase
    .from(table)
    .select('id', { count: 'exact', head: true })));
  reportError(`${table} count`, countError);

  const pageCount = Math.ceil(Number(count || 0) / PAGE_SIZE);
  if (!pageCount) return [];

  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, page) => {
      const from = page * PAGE_SIZE;
      return selectRows(table, columns, (query) => applyFilter(query)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1));
    }),
  );
  return pages.flat();
}

/**
 * Rows of a per-close table for a named set of closes.
 *
 * NO COUNT QUERY. `loadTable` pays one round trip to learn how many pages a
 * whole table has; a fetch scoped to sixty closes asks for a page and stops
 * when a short one comes back, which is one trip in every real case. On the
 * production book a client's latest close holds about 5 account rows, 6
 * strategy rows, 22 orders and 6 executions, so sixty closes is a few hundred
 * rows and one page.
 *
 * The ids are chunked because they travel in the URL. Sixty uuids is about
 * 2.3 KB of query string; all 206 of a manager's latest closes would be 7.6 KB
 * and is the kind of thing a proxy truncates without saying so.
 */
const IMPORT_CHUNK = 60;

async function loadRowsForImports(table, columns, importIds, { column = 'daily_import_id' } = {}) {
  const ids = [...new Set((importIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const chunks = [];
  for (let at = 0; at < ids.length; at += IMPORT_CHUNK) {
    chunks.push(ids.slice(at, at + IMPORT_CHUNK));
  }
  const results = await Promise.all(chunks.map(async (chunk) => {
    const all = [];
    for (let page = 0; ; page += 1) {
      const from = page * PAGE_SIZE;
      const rows = await selectRows(table, columns, (query) => query
        .in(column, chunk)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1));
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }));
  return results.flat();
}

/**
 * Table names the CRM state is built from, in the order buildCrmStateFromTables
 * destructures them. A local snapshot must supply the same set.
 *
 * `close_summaries` is last because it arrived last (step 48) and the
 * destructuring below is positional. A snapshot taken before it existed carries
 * no such table and buildCrmStateFromTables derives the rows from the closes it
 * has, so local mode reads the summary path rather than a path production no
 * longer uses.
 */
export const CRM_STATE_TABLES = [
  'cam_profiles', 'clients', 'client_assignments', 'trading_accounts',
  'payout_events', 'client_credentials', 'client_prop_firms', 'daily_imports',
  'account_snapshots', 'strategy_snapshots', 'orders', 'executions',
  'operational_flags', 'tasks', 'activity_logs', 'price_checks',
  'cam_time_off', 'client_coverage', 'close_summaries',
];

/**
 * Tables buildCrmStateFromTables can produce for itself from the others.
 *
 * A saved export taken before step 48 has no `close_summaries`, and asking a
 * reader to re-export before they can look at the book would be a worse answer
 * than deriving the rows from the closes the file already carries.
 */
export const DERIVABLE_STATE_TABLES = new Set(['close_summaries']);

/**
 * What a login asks each table for.
 *
 * Every entry is the list of columns something on a first screen reads, and
 * nothing else. The plan that produced these lists is column by column and
 * names the reader of each one; where a column is absent from a list, nothing
 * in src/ or server/ reads it off that table at login.
 */
export const LOGIN_COLUMNS = {
  cam_profiles: 'id, legacy_key, name, role_title, status, monthly_goal, can_manage_clients, '
    + 'client_order, report_config, start_date, email, phone, timezone, notes',
  clients: 'id, legacy_key, name, status, stage, deleted_at, pinned, pinned_note, notes, '
    // created_at is on this list because revenueHealth.js:114 reads
    // `client.freeSince || client.createdAt` and buildCrmStateFromTables never
    // mapped it, so on Supabase data every free client aged to `days: null`.
    // The one column this change ADDS to a login.
    + 'subscription_price, created_at, tags, account_focus, report_config, '
    + 'churn_reason, churn_note, churned_at, full_name, email, phone, timezone, country, '
    + 'start_date, preferred_channel, language, product_key, additional_emails, prop_firm, messenger',
  client_assignments: 'client_id, cam_profile_id',
  trading_accounts: 'id, client_id, account_name, alias, connection, account_type, status, '
    + 'simulation_mode, payout_state, target_profit, start_balance, max_drawdown_limit, '
    + 'prop_firm_plan, risk_level, bullet_bot_pass_type, bullet_bot_direction, algo_stack, '
    + 'daily_loss_limit, notes, date_added, date_funded, date_failed, date_last_payout, '
    + 'payout_count, tradovate_account_id',
  payout_events: 'id, trading_account_id, payout_date, amount, state, note',
  // The date picker, every close count and closeAsOf. `source_summary` is not
  // here: it is a jsonb the ClientExportDialog reads and nothing else, about
  // 0.3 MB of login, and it arrives with the client that is opened.
  daily_imports: 'id, legacy_key, client_id, trading_date, status, imported_at',
  operational_flags: 'id, daily_import_id, trading_account_id, type, severity, message, status, resolved_at',
  tasks: 'id, legacy_key, client_id, trading_account_id, text, priority, due_date, done, created_at',
  activity_logs: 'id, legacy_key, client_id, trading_account_id, type, text, created_at, log_date, log_pnl',
  price_checks: 'id, client_id, check_date, instrument, time_label, price, connection_status, algo_status, notes, checked',
  cam_time_off: 'id, cam_profile_id, start_date, end_date, kind, note, status, decision_note',
  client_coverage: 'id, client_id, covering_cam_profile_id, absent_cam_profile_id, time_off_id, start_date, end_date, note',
  close_summaries: 'daily_import_id, client_id, trading_date, segment, accounts, daily_pnl, '
    + 'weekly_pnl, balance, counted_in_total, account_names',
};

/**
 * The latest close, in full, minus the two columns that make it heavy.
 *
 * `parameters_raw` and `params_parsed` are 2,231 B of a 2,731 B strategy row.
 * They are fetched by the two panels that read them, for the day those panels
 * are showing. `derivation` is the same argument on account_snapshots: a jsonb
 * report per account-day that only the Stack Playbook's algo contribution
 * reads, so it arrives when a close is opened.
 */
export const LATEST_CLOSE_COLUMNS = {
  account_snapshots: 'id, daily_import_id, trading_account_id, account_name, connection, '
    + 'gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl, unrealized_pnl',
  strategy_snapshots: 'id, daily_import_id, account_snapshot_id, trading_account_id, strategy_name, '
    + 'strategy_family, strategy_version, instrument, data_series, direction, enabled, realized, '
    + 'unrealized, derived_realized, ran, ran_basis',
  executions: 'id, daily_import_id, trading_account_id, external_execution_id, external_order_id, '
    + 'strategy_name, instrument, action, quantity, price, time_text, entry_exit, position, name, '
    + 'commission, rate, connection',
};

/** What opening a close costs: the fills, and the derivation behind the split. */
export const CLOSE_DETAIL_COLUMNS = {
  orders: 'id, daily_import_id, trading_account_id, external_order_id, strategy_name, instrument, '
    + 'action, order_type, quantity, limit_price, stop_price, state, filled, avg_price, remaining, '
    + 'name, time_text',
  executions: LATEST_CLOSE_COLUMNS.executions,
  account_snapshots: `${LATEST_CLOSE_COLUMNS.account_snapshots}, derivation`,
  strategy_snapshots: LATEST_CLOSE_COLUMNS.strategy_snapshots,
};

/**
 * What ConfigDriftPanel and SetFileMatchPanel fetch when they are expanded.
 *
 * The whole strategy row, not just the two columns, because the panels are
 * shown for a day the login may not hold any strategy rows for at all: the
 * as-of picker moves and the login only carried each client's latest close.
 */
export const STRATEGY_PARAMETER_COLUMNS =
  `${LATEST_CLOSE_COLUMNS.strategy_snapshots}, parameters_raw, params_parsed`;

/**
 * Flags: unresolved, plus anything closed recently.
 *
 * `isFlagOpen` (camFlagQueue.js) is `status not in (Resolved, Acknowledged)`,
 * and on the book 68.8% of flag rows are closed — 10.7 MB of a login for rows
 * the queue cannot act on. The second half of the filter is not decoration:
 * the queue reports what it closed and when (`recentlyClosed`, `lastClosedOn`),
 * and a fetch of open rows alone would have emptied that section silently,
 * which is the class of bug this whole change is about.
 */
export const RECENTLY_CLOSED_FLAG_DAYS = 14;

function flagFilterFor(now = new Date()) {
  const since = new Date(now.getTime() - RECENTLY_CLOSED_FLAG_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  return (query) => query.or(`status.not.in.("Resolved","Acknowledged"),resolved_at.gte.${since}`);
}

/** Tables a login does not read at all, with the reason. */
export const NOT_AT_LOGIN = {
  orders: 'No first screen reads an order. 55,856 rows, 27.0 MB, 57 round trips.',
  executions: 'Only each client\'s latest close is read, for the deviation alerts and the traded basis.',
  client_credentials: 'Passwords. Credentials tab data, fetched when a client is opened.',
  client_prop_firms: 'Prop firm logins. Same rule as client_credentials.',
};

/**
 * One login.
 *
 * Three waves, because each needs the one before it: who the clients are, then
 * what hangs off them, then the detail of the closes the first screen renders.
 * Waves are not extra latency — every request inside one overlaps, under the
 * same bound — and the third wave is the one that could not exist before,
 * because "each client's latest close" is not a filter until `daily_imports`
 * has been read.
 *
 * `scopeToCamProfileId` narrows the whole login to one CAM's book: the clients
 * assigned to them plus any they are covering. On the production desk that is
 * 26 of 206 clients. A manager passes null and gets the book.
 */
export async function loadSupabaseCrmState({
  preferredCamProfileId = null,
  scopeToCamProfileId = null,
  now = new Date(),
} = {}) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  // Wave one: who exists, and whose book this is.
  //
  // `clients` IS NOT HERE, AND IT WAS. The scope is computed from three tables
  // — see clientScopeFor, which reads camRows, assignmentRows and coverageRows
  // and nothing else — so fetching the client table before it was known meant
  // every CAM's browser downloaded all 206 clients whole and filtered them in
  // memory afterwards. LOGIN_COLUMNS.clients carries full_name, email, phone,
  // additional_emails, messenger, notes, subscription_price, churn_reason and
  // churn_note, so that was the desk's whole contact list and its commercial
  // terms on the wire, for 180 books the CAM will never open. The same class
  // of exposure this change removes for credentials, one table over.
  const [camRows, assignmentRows, coverageRows] = await Promise.all([
    loadTable('cam_profiles', { columns: LOGIN_COLUMNS.cam_profiles }),
    loadTable('client_assignments', { columns: LOGIN_COLUMNS.client_assignments }),
    loadTable('client_coverage', { columns: LOGIN_COLUMNS.client_coverage }),
  ]);

  const scope = clientScopeFor({
    camRows, assignmentRows, coverageRows, scopeToCamProfileId,
  });
  // A filter over a named set of clients, or no filter at all for a manager.
  // Written once: every per-client table below takes the same narrowing, so a
  // CAM cannot end up with one table scoped and another not. The client table
  // itself keys on `id` rather than `client_id` and takes the same scope
  // through its own filter.
  const byClient = scope ? (query) => query.in('client_id', scope) : null;
  const byClientId = scope ? (query) => query.in('id', scope) : null;

  // Wave two: the clients themselves, and everything that hangs off them.
  const [
    clientRows, accountRows, payoutRows, importRows, flagRows, taskRows,
    activityRows, priceCheckRows, timeOffRows, summaryRows,
  ] = await Promise.all([
    loadTable('clients', { columns: LOGIN_COLUMNS.clients, filter: byClientId }),
    loadTable('trading_accounts', { columns: LOGIN_COLUMNS.trading_accounts, filter: byClient }),
    loadPayoutEvents(scope),
    loadTable('daily_imports', { columns: LOGIN_COLUMNS.daily_imports, filter: byClient }),
    loadTable('operational_flags', {
      columns: LOGIN_COLUMNS.operational_flags,
      filter: combineFilters(byClient, flagFilterFor(now)),
    }),
    loadTable('tasks', { columns: LOGIN_COLUMNS.tasks, filter: byClient }),
    loadTable('activity_logs', { columns: LOGIN_COLUMNS.activity_logs, filter: byClient }),
    loadTable('price_checks', { columns: LOGIN_COLUMNS.price_checks, filter: byClient }),
    loadTable('cam_time_off', { columns: LOGIN_COLUMNS.cam_time_off }),
    loadCloseSummaryRows(byClient),
  ]);

  // Wave three: each client's latest close, in full. This is the cohort every
  // per-account figure on both first screens is drawn from — the funded table,
  // the evaluations table, the deviation alerts, the traded basis — and it is
  // 206 closes rather than 2,585.
  const latestImportIds = latestImportIdPerClient(importRows);
  const [snapshotRows, strategyRows, executionRows] = await Promise.all([
    loadRowsForImports('account_snapshots', LATEST_CLOSE_COLUMNS.account_snapshots, latestImportIds),
    loadRowsForImports('strategy_snapshots', LATEST_CLOSE_COLUMNS.strategy_snapshots, latestImportIds),
    loadRowsForImports('executions', LATEST_CLOSE_COLUMNS.executions, latestImportIds),
  ]);

  return buildCrmStateFromTables({
    cam_profiles: camRows,
    clients: clientRows,
    client_assignments: assignmentRows,
    trading_accounts: accountRows,
    payout_events: payoutRows,
    client_credentials: [],
    client_prop_firms: [],
    daily_imports: importRows,
    account_snapshots: snapshotRows,
    strategy_snapshots: strategyRows,
    orders: [],
    executions: executionRows,
    operational_flags: flagRows,
    tasks: taskRows,
    activity_logs: activityRows,
    price_checks: priceCheckRows,
    cam_time_off: timeOffRows,
    client_coverage: coverageRows,
    close_summaries: summaryRows,
  }, {
    preferredCamProfileId,
    // The closes whose per-account rows are actually in hand, so nothing
    // downstream has to guess whether an empty array is an empty day.
    loadedCloseIds: latestImportIds,
    // Never derive summaries here. A login that computed them from the closes
    // it holds would produce them for 206 of 2,585 closes and silently report
    // a desk one twelfth its real size.
    deriveMissingSummaries: false,
  });
}

/** Two filters, applied one after the other. */
function combineFilters(first, second) {
  if (!first) return second;
  if (!second) return first;
  return (query) => second(first(query));
}

/**
 * The clients a login may read, or null for the whole book.
 *
 * Assignment plus coverage, and coverage is taken whatever its dates: a window
 * that lapses overnight would drop a client out of a CAM's sidebar mid-session,
 * and the twenty rows it costs to be safe are not worth the cleverness.
 * `effectiveClientIds` in App.jsx still applies the dates when it decides what
 * to SHOW; this only decides what to fetch.
 */
function clientScopeFor({ camRows, assignmentRows, coverageRows, scopeToCamProfileId }) {
  if (!scopeToCamProfileId) return null;
  const profile = (camRows || []).find((row) => (
    row.id === scopeToCamProfileId || row.legacy_key === scopeToCamProfileId
  ));
  // An unresolvable CAM reads the whole book rather than an empty one. A login
  // that silently returns no clients is the failure mode this change must not
  // introduce, and it is indistinguishable on screen from a CAM with no book.
  if (!profile) return null;
  const ids = new Set(
    (assignmentRows || [])
      .filter((row) => row.cam_profile_id === profile.id)
      .map((row) => row.client_id),
  );
  for (const row of coverageRows || []) {
    if (row.covering_cam_profile_id === profile.id && row.client_id) ids.add(row.client_id);
  }
  return [...ids];
}

/**
 * Payout events for a scope.
 *
 * `payout_events` keys on the trading account, not the client, so a CAM-scoped
 * login cannot filter it the way the others are filtered. It is 20 rows on the
 * production book; it is loaded whole and filtered on the way into the state by
 * the account registry, which already drops anything it cannot place.
 */
function loadPayoutEvents() {
  return loadTable('payout_events', { columns: LOGIN_COLUMNS.payout_events });
}

/**
 * The stored per-close money.
 *
 * Absent on a database where step 48 has not run, and that is not an error:
 * PostgREST answers PGRST205 for a table it has no schema cache entry for, the
 * rows come back empty, and buildDeskMoney falls back to whatever closes are
 * loaded — which is what the product did before this table existed.
 */
async function loadCloseSummaryRows(byClient) {
  try {
    return await loadTable('close_summaries', {
      columns: LOGIN_COLUMNS.close_summaries,
      filter: byClient,
    });
  } catch (error) {
    if (isMissingCloseSummaries(error)) return [];
    throw error;
  }
}

export function isMissingCloseSummaries(error) {
  const message = error?.message || '';
  return error?.code === 'PGRST205'
    || error?.code === '42P01'
    || (/close_summaries/i.test(message) && /(does not exist|schema cache)/i.test(message));
}

/** The newest close of each client, by uuid. */
export function latestImportIdPerClient(importRows = []) {
  const latest = new Map();
  for (const row of importRows || []) {
    if (!row?.client_id || !row?.id) continue;
    const current = latest.get(row.client_id);
    if (!current || String(row.trading_date || '') > String(current.trading_date || '')) {
      latest.set(row.client_id, row);
    }
  }
  return [...latest.values()].map((row) => row.id);
}

/**
 * Builds the CRM state from raw table rows.
 *
 * Split out from the fetch so the same mapping serves a local snapshot. Running
 * the app against a saved export otherwise means a second, parallel mapping
 * that drifts from this one — and a local view that quietly disagrees with
 * production is worse than no local view at all.
 */
export function buildCrmStateFromTables(tables = {}, {
  preferredCamProfileId = null,
  loadedCloseIds = null,
  deriveMissingSummaries = true,
} = {}) {
  const [
    camRows,
    clientRows,
    assignmentRows,
    accountRows,
    payoutRows,
    credentialRows,
    propFirmRows,
    importRows,
    snapshotRows,
    strategyRows,
    orderRows,
    executionRows,
    flagRows,
    taskRows,
    activityRows,
    priceCheckRows,
    timeOffRows,
    coverageRows,
    summaryRows,
  ] = CRM_STATE_TABLES.map((table) => tables[table] || []);

  // Which closes this caller actually fetched the per-account rows for. A
  // login names its 206; a local snapshot and every test that hands over a
  // whole table name none, which reads as "all of them" — the file holds the
  // book and there is nothing left to fetch.
  const loadedCloses = loadedCloseIds ? new Set(loadedCloseIds) : null;

  const visibleClientRows = (clientRows || []).filter((client) => (
    !client.deleted_at && client.status !== 'Inactive'
  ));
  // How many the rule above dropped. The Stack Playbook states it under its
  // team table: the hidden clients' account days (51 funded ones on the book,
  // every RBO_PF day among them) are not in any figure on that screen, and a
  // caption that says so is the only honest way to leave the rule as it is.
  const hiddenClientCount = (clientRows || []).length - visibleClientRows.length;
  const clientByUuid = byId(visibleClientRows);
  const accountByUuid = byId(accountRows);
  const accountByClient = {};
  const payoutsByAccount = {};
  const credentialsByClient = {};
  const propFirmsByClient = {};
  const importsByClient = {};
  const snapshotsByImport = {};
  const strategiesBySnapshot = {};
  const strategiesByImport = {};
  const ordersByImport = {};
  const executionsByImport = {};
  const flagsByImport = {};
  const tasksByClient = {};
  const activityByClient = {};
  const priceChecksByClient = {};

  for (const payout of payoutRows) {
    if (!payoutsByAccount[payout.trading_account_id]) payoutsByAccount[payout.trading_account_id] = [];
    payoutsByAccount[payout.trading_account_id].push({
      date: payout.payout_date,
      amount: Number(payout.amount || 0),
      state: payout.state || '',
      note: payout.note || '',
    });
  }

  for (const account of accountRows) {
    if (!accountByClient[account.client_id]) accountByClient[account.client_id] = [];
    accountByClient[account.client_id].push(account);
  }

  for (const credential of credentialRows) {
    credentialsByClient[credential.client_id] = credential;
  }

  for (const propFirm of propFirmRows) {
    if (!propFirmsByClient[propFirm.client_id]) propFirmsByClient[propFirm.client_id] = [];
    propFirmsByClient[propFirm.client_id].push(propFirmFromRow(propFirm));
  }

  for (const strategy of strategyRows) {
    const mapped = strategyFromRow(strategy, accountByUuid);
    if (strategy.account_snapshot_id) {
      if (!strategiesBySnapshot[strategy.account_snapshot_id]) strategiesBySnapshot[strategy.account_snapshot_id] = [];
      strategiesBySnapshot[strategy.account_snapshot_id].push(mapped);
    }
    if (!strategiesByImport[strategy.daily_import_id]) strategiesByImport[strategy.daily_import_id] = [];
    strategiesByImport[strategy.daily_import_id].push(mapped);
  }

  for (const snapshot of snapshotRows) {
    if (!snapshotsByImport[snapshot.daily_import_id]) snapshotsByImport[snapshot.daily_import_id] = [];
    snapshotsByImport[snapshot.daily_import_id].push(snapshotFromRow(snapshot, strategiesBySnapshot, accountByUuid));
  }

  for (const execution of executionRows) {
    if (!executionsByImport[execution.daily_import_id]) executionsByImport[execution.daily_import_id] = [];
    executionsByImport[execution.daily_import_id].push(executionFromRow(execution, accountByUuid));
  }

  for (const order of orderRows) {
    if (!ordersByImport[order.daily_import_id]) ordersByImport[order.daily_import_id] = [];
    ordersByImport[order.daily_import_id].push(orderFromRow(order, accountByUuid));
  }

  for (const flag of flagRows) {
    if (!flagsByImport[flag.daily_import_id]) flagsByImport[flag.daily_import_id] = [];
    flagsByImport[flag.daily_import_id].push(flagFromRow(flag, accountByUuid));
  }

  for (const dailyImport of importRows) {
    if (!importsByClient[dailyImport.client_id]) importsByClient[dailyImport.client_id] = [];
    importsByClient[dailyImport.client_id].push(dailyImport);
  }

  for (const task of taskRows) {
    if (!tasksByClient[task.client_id]) tasksByClient[task.client_id] = [];
    tasksByClient[task.client_id].push(taskFromRow(task, accountByUuid));
  }

  for (const activity of activityRows) {
    if (!activityByClient[activity.client_id]) activityByClient[activity.client_id] = [];
    activityByClient[activity.client_id].push(activityFromRow(activity, accountByUuid));
  }

  for (const check of priceCheckRows) {
    if (!priceChecksByClient[check.client_id]) priceChecksByClient[check.client_id] = [];
    priceChecksByClient[check.client_id].push(priceCheckFromRow(check));
  }

  const camProfiles = camRows.map((cam) => ({
    id: pickId(cam),
    name: cam.name,
    role: cam.role_title || 'CAM',
    status: cam.status || 'Active',
    live: Boolean(cam.live),
    monthlyGoal: Number(cam.monthly_goal || 0),
    canManageClients: Boolean(cam.can_manage_clients),
    reportConfig: cam.report_config && typeof cam.report_config === 'object' ? cam.report_config : {},
    startDate: cam.start_date || '',
    email: cam.email || '',
    phone: cam.phone || '',
    timezone: cam.timezone || '',
    notes: cam.notes || '',
    clientOrder: Array.isArray(cam.client_order) ? cam.client_order : [],
    clientIds: assignmentRows
      .filter((assignment) => assignment.cam_profile_id === cam.id && clientByUuid[assignment.client_id])
      .map((assignment) => pickId(clientByUuid[assignment.client_id])),
  }));

  const camByPublicId = byLegacy(camProfiles);
  const preferredCam = camByPublicId[preferredCamProfileId] || camProfiles[0] || null;

  const clients = visibleClientRows.map((client) => {
    const accounts = accountByClient[client.id] || [];
    const accountRegistry = {};
    for (const account of accounts) {
      const meta = accountMetaFromRow(account);
      meta.payoutHistory = payoutsByAccount[account.id] || [];
      accountRegistry[account.account_name] = meta;
    }

    const credential = credentialsByClient[client.id] || {};
    const dailyImports = (importsByClient[client.id] || [])
      .map((dailyImport) => {
        // account_snapshots stores one row per account per close whatever its
        // nature; the live/simulated/undetermined split is recomputed HERE, from
        // each account's current record. That is deliberate: a CAM who corrects
        // a misclassification fixes every close the client ever had, not only
        // the ones imported after the fix.
        //
        // Everything downstream reads `snapshots` and assumes real money, so
        // this must run before the object is handed out. It is the load-side
        // twin of the split in reconcile.js — the two ingestion directions, one
        // rule.
        const split = splitSimulationRows({
          accounts: accountRegistry,
          snapshots: snapshotsByImport[dailyImport.id] || [],
          strategies: strategiesByImport[dailyImport.id] || [],
          orders: ordersByImport[dailyImport.id] || [],
          executions: executionsByImport[dailyImport.id] || [],
        });
        return {
          id: dailyImport.legacy_key || dailyImport.id,
          uuid: dailyImport.id,
          clientId: pickId(client),
          date: dailyImport.trading_date,
          importedAt: dailyImport.imported_at,
          status: dailyImport.status,
          sourceSummary: dailyImport.source_summary || {},
          accounts: accountRegistry,
          snapshots: split.live.snapshots,
          strategies: split.live.strategies,
          orders: split.live.orders,
          executions: split.live.executions,
          simulation: split.simulation,
          flags: flagsByImport[dailyImport.id] || [],
          // NOT LOADED IS NOT EMPTY, per close.
          //
          //   snapshotsLoaded  the per-account rows for this close are in hand
          //   detailLoaded     so are the orders, the executions and the
          //                    per-account derivation report
          //   parametersLoaded so are parameters_raw and params_parsed
          //
          // A login sets the first on each client's latest close and none of
          // the others anywhere: it deliberately fetches no order, no
          // derivation and no parameter column. Every surface that would
          // otherwise print a zero reads these instead of measuring an empty
          // array — the distinction accountLifecycle.js and StackPlaybook.jsx
          // draw book-wide, recorded per close. With no `loadedCloseIds` the
          // caller holds whole tables (a local snapshot, a test) and all three
          // are true, because there is nothing left to fetch.
          snapshotsLoaded: !loadedCloses || loadedCloses.has(dailyImport.id),
          detailLoaded: !loadedCloses,
          parametersLoaded: !loadedCloses,
        };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    return {
      id: pickId(client),
      uuid: client.id,
      name: client.name,
      reportConfig: client.report_config && typeof client.report_config === 'object' ? client.report_config : {},
      status: client.status || 'Active',
      pinned: Boolean(client.pinned),
      pinnedNote: client.pinned_note || '',
      notes: client.notes || '',
      // Why they left, if anybody was asked. Step 39 adds the three columns; on
      // a database where it has not run — and on every export taken before it,
      // public/local-snapshot.json included — they are undefined and this reads
      // as the empty record, which src/domain/clientLifecycle.js reports as
      // "Not recorded" rather than inventing a reason.
      //
      // Deliberately NOT inside `profile`: updateProfile re-sends that object
      // whole on every edit of the contact card, so a churn field parked there
      // would ride along with a phone-number correction.
      churn: {
        reason: client.churn_reason || '',
        note: client.churn_note || '',
        at: client.churned_at ? String(client.churned_at).slice(0, 10) : '',
      },
      // Step 42 adds the column; where it has not run this is undefined and
      // normalizes to the empty list, so a client simply carries no tags rather
      // than the page failing to load.
      //
      // Top level, not inside `profile`, for the same reason `churn` is:
      // updateProfile re-sends that object whole on every contact-card edit,
      // and a tag parked there would ride along with a phone-number correction.
      tags: normalizeClientTags(client.tags),
      // Declared at onboarding, before any account exists to derive it from.
      // Step 42 adds the column; where it has not run this reads as empty.
      accountFocus: normalizeAccountFocus(client.account_focus),
      profile: {
        stage: client.stage || 'Active',
        fullName: client.full_name || client.name,
        email: client.email || '',
        phone: client.phone || '',
        timezone: client.timezone || '',
        country: client.country || '',
        startDate: client.start_date || '',
        preferredChannel: client.preferred_channel || '',
        language: client.language || '',
        productKey: client.product_key || '',
        additionalEmails: jsonArray(client.additional_emails),
        propFirm: client.prop_firm || '',
        messenger: client.messenger || '',
        subscriptionPrice: normalizeSubscriptionPrice(client.subscription_price),
      },
      credentials: {
        ip: credential.ip || '',
        username: credential.username || '',
        password: credential.password_encrypted || '',
        ntLogin: credential.nt_login || '',
        ntPassword: credential.nt_password_encrypted || '',
        firmLogin: credential.firm_login || '',
        firmPassword: credential.firm_password_encrypted || '',
        notes: credential.notes || '',
      },
      propFirms: (propFirmsByClient[client.id] || []).sort((a, b) => (
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      )),
      accountRegistry,
      dailyImports,
      activityLog: (activityByClient[client.id] || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      tasks: (tasksByClient[client.id] || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      priceChecks: priceChecksByClient[client.id] || [],
      priceChecksDate: '',
    };
  });

  const selectedClientId = preferredCam?.clientIds?.[0] || clients[0]?.id || null;

  /* THE DESK'S MONEY, PER CLOSE, WITHOUT THE CLOSE.
   *
   * On production these rows come from close_summaries (step 48), written by
   * the ingest from buildSegmentTotals over the close it has just reconciled.
   * Where the caller holds whole tables instead — a local snapshot, a book
   * test — they are derived here from the closes that were just built, by the
   * same function, so local mode exercises the path production uses rather
   * than a path production no longer has. A login passes
   * deriveMissingSummaries: false, because deriving them from the 206 closes a
   * login holds would report a desk one twelfth its real size.
   */
  const storedSummaries = (summaryRows || []).map(closeSummaryFromRow);
  const closeSummaries = storedSummaries.length || !deriveMissingSummaries
    ? storedSummaries
    : clients.flatMap((client) => (client.dailyImports || []).flatMap((dailyImport) => (
      buildCloseSummaryRows({
        accountRegistry: client.accountRegistry,
        dailyImport,
      }).map((row) => ({
        ...row,
        dailyImportId: dailyImport.uuid || dailyImport.id,
        clientUuid: client.uuid || client.id,
        date: dailyImport.date,
      }))
    )));

  // Map DB uuids to the app-level ids the rest of the state uses, so time off
  // and coverage reference CAMs and clients the same way everything else does.
  const camIdByUuid = Object.fromEntries((camRows || []).map((row) => [row.id, pickId(row)]));
  const clientIdByUuid = Object.fromEntries((clientRows || []).map((row) => [row.id, pickId(row)]));

  return {
    dataSource: 'supabase',
    accountManager: {
      id: preferredCam?.id || '',
      name: preferredCam?.name || 'Unassigned',
    },
    camProfiles,
    clients,
    hiddenClientCount,
    // One row per (close, segment). Read by deskMoney through
    // indexCloseSummaries, which drops any whose accounts have been
    // reclassified since it was written.
    closeSummaries: attachClientIds(closeSummaries, clientIdByUuid),
    timeOff: (timeOffRows || []).map((row) => timeOffFromRow(row, camIdByUuid)),
    coverage: (coverageRows || []).map((row) => coverageFromRow(row, camIdByUuid, clientIdByUuid)),
    selectedClientId,
  };
}

// ---------------------------------------------------------------------------
// WHAT A CLICK COSTS.
//
// Everything the login deliberately left behind, fetched when the screen that
// reads it is actually on screen. Each of these returns raw rows and has a
// merge beside it, for the same reason buildCrmStateFromTables is split out
// from the fetch: a second mapping of the same rows drifts from the first one,
// and a local snapshot that disagrees with production is worse than no local
// snapshot at all.
// ---------------------------------------------------------------------------

/**
 * The account uuid -> row map the row mappers expect.
 *
 * THE BUG THIS REPLACES. `mergeSupabaseTradeHistory` built this map out of
 * `client.accountRegistry` values, which are `accountMetaFromRow` output and
 * spell the name `accountName`. `orderFromRow` and `executionFromRow` read
 * `account?.account_name`. So every order and every execution that arrived
 * AFTER the dashboard shell — which was all of them, since the shell never
 * fetched either table — came back with `accountName: ''`. Anything that joins
 * a fill to an account by name (the quiet-accounts panel, the lifecycle
 * panel's liquidation rejects, the per-account report reasons) was reading an
 * empty string off every row it had not imported itself in that session.
 */
function accountRowsByUuid(state) {
  const rows = {};
  for (const client of state?.clients || []) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (!meta?.id) continue;
      rows[meta.id] = { account_name: meta.accountName || '', connection: meta.connection || '' };
    }
  }
  return rows;
}

/**
 * A refetched strategy row, with the parameters it was not asked for kept.
 *
 * `parametersIncluded` is the fetch saying whether it named the two parameter
 * columns. When it did, the fetched values win outright, including an empty one
 * — a row whose parameters really are blank has to be able to say so. When it
 * did not, the row already on screen is the only thing that knows them.
 */
function withHeldParameters(mapped, heldById, parametersIncluded) {
  if (parametersIncluded) return mapped;
  const held = heldById.get(mapped.id);
  if (!held) return mapped;
  const hasParams = held.params && Object.keys(held.params).length > 0;
  if (!held.parametersRaw && !hasParams) return mapped;
  return { ...mapped, parametersRaw: held.parametersRaw || '', params: held.params || {} };
}

/** The same rule for `derivation`, which only the close-detail fetch asks for. */
function withHeldDerivation(mapped, heldById) {
  if (mapped.derivation) return mapped;
  const held = heldById.get(mapped.id);
  return held?.derivation ? { ...mapped, derivation: held.derivation } : mapped;
}

function groupByImport(rows) {
  if (!rows) return null;
  const by = {};
  for (const row of rows) {
    if (!by[row.daily_import_id]) by[row.daily_import_id] = [];
    by[row.daily_import_id].push(row);
  }
  return by;
}

/**
 * Puts freshly fetched rows onto the closes they belong to.
 *
 * Any of the four row sets may be null, meaning "keep what this close already
 * has": the parameter fetch brings strategies and nothing else, the close
 * fetch brings all four.
 *
 * The simulation split is recomputed over the WHOLE close every time, live and
 * simulated rows together (mergeSimulationRows puts them back first). Assigning
 * fetched arrays straight onto `dailyImport.orders` is what put Craig's 40
 * simulated orders back into the live arrays the first time this merge was
 * written; the split is an application concern, recomputed from each account's
 * current record, and it has to be redone whenever the rows change.
 *
 * A NARROWER FETCH MUST NOT UNDO A WIDER ONE. Every fetch here names its own
 * columns, so a row arriving from one of them carries nothing about the columns
 * another asked for. Opening a close re-reads `strategy_snapshots` WITHOUT
 * `parameters_raw` and `params_parsed` — selecting any client fires
 * ensureCloseDetail, so this is automatic, not hypothetical — and the rebuilt
 * rows carried `parametersRaw: ''` and `params: {}` over the ones a panel had
 * already paid 1.23 MB for, while `parametersLoaded` and App.jsx's own cache
 * both went on saying "loaded". The three configuration panels then compared
 * over stripped rows and reported a finding. The same is true of `derivation`
 * on the account rows, which only the close-detail fetch asks for and which the
 * ranking window's fetch would otherwise blank.
 *
 * So each fetch says what it actually brought — `parametersIncluded` for the
 * two parameter columns, `snapshotRows` carrying `derivation` or not — and what
 * it did not bring is kept from the row already on screen. The markers follow
 * the same rule: `parametersLoaded` is set by a fetch that carried parameters
 * and by nothing else.
 */
export function applyCloseRows(state, {
  importIds = [],
  snapshotRows = null,
  strategyRows = null,
  orderRows = null,
  executionRows = null,
  markDetailLoaded = false,
  parametersIncluded = false,
} = {}) {
  const wanted = new Set((importIds || []).filter(Boolean));
  if (!wanted.size) return state;
  const accountByUuid = accountRowsByUuid(state);
  const snapshotsBy = groupByImport(snapshotRows);
  const strategiesBy = groupByImport(strategyRows);
  const ordersBy = groupByImport(orderRows);
  const executionsBy = groupByImport(executionRows);

  return {
    ...state,
    clients: (state.clients || []).map((client) => {
      const imports = client.dailyImports || [];
      if (!imports.some((entry) => wanted.has(entry.uuid || entry.id))) return client;
      return {
        ...client,
        dailyImports: imports.map((dailyImport) => {
          const importId = dailyImport.uuid || dailyImport.id;
          if (!wanted.has(importId)) return dailyImport;
          const whole = mergeSimulationRows(dailyImport);
          // What this close already holds, by row id, so a fetch that did not
          // ask for a column can put back what one that did already brought.
          const heldStrategies = new Map(
            (whole.strategies || []).filter((row) => row?.id).map((row) => [row.id, row]),
          );
          const heldSnapshots = new Map(
            (whole.snapshots || []).filter((row) => row?.id).map((row) => [row.id, row]),
          );

          const fetchedStrategies = strategiesBy
            ? (strategiesBy[importId] || []).map((row) => ({
              snapshotId: row.account_snapshot_id,
              mapped: withHeldParameters(strategyFromRow(row, accountByUuid), heldStrategies, parametersIncluded),
            }))
            : null;
          const strategiesBySnapshot = {};
          for (const entry of fetchedStrategies || []) {
            if (!entry.snapshotId) continue;
            if (!strategiesBySnapshot[entry.snapshotId]) strategiesBySnapshot[entry.snapshotId] = [];
            strategiesBySnapshot[entry.snapshotId].push(entry.mapped);
          }

          let snapshots;
          if (snapshotsBy) {
            snapshots = (snapshotsBy[importId] || [])
              .map((row) => withHeldDerivation(
                snapshotFromRow(row, strategiesBySnapshot, accountByUuid),
                heldSnapshots,
              ));
          } else if (fetchedStrategies) {
            // Strategies arrived without their snapshots (the parameter fetch).
            // Re-nest them so Dashboard.jsx's per-account strategy rows and the
            // panel's own flat list are the same objects.
            snapshots = whole.snapshots.map((snapshot) => ({
              ...snapshot,
              strategies: strategiesBySnapshot[snapshot.id] || snapshot.strategies || [],
            }));
          } else {
            snapshots = whole.snapshots;
          }

          const split = splitSimulationRows({
            accounts: client.accountRegistry || {},
            snapshots,
            strategies: fetchedStrategies ? fetchedStrategies.map((entry) => entry.mapped) : whole.strategies,
            orders: ordersBy ? (ordersBy[importId] || []).map((row) => orderFromRow(row, accountByUuid)) : whole.orders,
            executions: executionsBy
              ? (executionsBy[importId] || []).map((row) => executionFromRow(row, accountByUuid))
              : whole.executions,
          });

          return {
            ...dailyImport,
            snapshots: split.live.snapshots,
            strategies: split.live.strategies,
            orders: split.live.orders,
            executions: split.live.executions,
            simulation: split.simulation,
            // NOT LOADED IS NOT EMPTY. A close with no orders and a close whose
            // orders have not been fetched are the same empty array, and every
            // surface that reads fills has to be able to tell them apart — the
            // distinction accountLifecycle.js and StackPlaybook.jsx already draw
            // book-wide, now recorded per close.
            detailLoaded: markDetailLoaded ? true : Boolean(dailyImport.detailLoaded),
            // Set by a fetch that brought the per-account rows, and by nothing
            // else. Without it an opened close kept `snapshotsLoaded: false`
            // for the rest of the session, so refreshMerge's `carriesRows`
            // never fired for it and the next Refresh — or any edit on that
            // close — put the fills back and left the account table blank,
            // which is worse than blank. See refreshMerge.js.
            snapshotsLoaded: snapshotsBy ? true : Boolean(dailyImport.snapshotsLoaded),
            parametersLoaded: parametersIncluded ? true : Boolean(dailyImport.parametersLoaded),
          };
        }),
      };
    }),
  };
}

/**
 * Opening a close: its fills, and the per-account derivation behind the split.
 *
 * 0.018 MB and four round trips for one close, against the 40.5 MB and 85
 * round trips a login used to spend on every close in the book.
 */
export async function loadSupabaseCloseDetail(importIds = []) {
  if (!isSupabaseConfigured || !supabase) return null;
  const ids = [...new Set((importIds || []).filter(Boolean))];
  if (!ids.length) return { importIds: [], orders: [], executions: [], snapshots: [], strategies: [] };
  const [orders, executions, snapshots, strategies] = await Promise.all([
    loadRowsForImports('orders', CLOSE_DETAIL_COLUMNS.orders, ids),
    loadRowsForImports('executions', CLOSE_DETAIL_COLUMNS.executions, ids),
    loadRowsForImports('account_snapshots', CLOSE_DETAIL_COLUMNS.account_snapshots, ids),
    loadRowsForImports('strategy_snapshots', CLOSE_DETAIL_COLUMNS.strategy_snapshots, ids),
  ]);
  return { importIds: ids, orders, executions, snapshots, strategies };
}

export function mergeSupabaseCloseDetail(state, detail) {
  if (!detail) return state;
  return applyCloseRows(state, {
    importIds: detail.importIds,
    snapshotRows: detail.snapshots,
    strategyRows: detail.strategies,
    orderRows: detail.orders,
    executionRows: detail.executions,
    markDetailLoaded: true,
  });
}

/**
 * ConfigDriftPanel and SetFileMatchPanel, expanded.
 *
 * The whole strategy row for the closes on screen, parameter columns included.
 * 1.23 MB and two round trips for one day, against 30.9 MB on every login.
 */
export async function loadSupabaseStrategyParameters(importIds = []) {
  if (!isSupabaseConfigured || !supabase) return null;
  const ids = [...new Set((importIds || []).filter(Boolean))];
  if (!ids.length) return { importIds: [], strategies: [] };
  const strategies = await loadRowsForImports('strategy_snapshots', STRATEGY_PARAMETER_COLUMNS, ids);
  return { importIds: ids, strategies };
}

export function mergeSupabaseStrategyParameters(state, parameters) {
  if (!parameters) return state;
  return applyCloseRows(state, {
    importIds: parameters.importIds,
    strategyRows: parameters.strategies,
    snapshotRows: parameters.snapshots || null,
    parametersIncluded: true,
  });
}

/**
 * The ranking board, expanded: a window of closes, rows AND their accounts.
 *
 * WHY THE ACCOUNT ROWS ARE HERE AND THE PARAMETER FETCH ALONE WAS NOT ENOUGH.
 * buildStrategyRanking reads `dailyImport.snapshots` and then each snapshot's
 * `strategies`; a login holds the account rows of each client's LATEST close
 * only, so for every older close in the window `applyCloseRows` had nowhere to
 * nest the strategy rows it had just paid for and dropped them on the floor.
 * Measured on the book: strategy rows came back for 485 closes, 79 of which had
 * account rows, so 594 of 3,805 rows landed — 16 algorithms with 8 ranked
 * became 15 with 0, under a badge reading "One rank per algorithm".
 *
 * So the window asks for both, in one pass, under the same bound. It is the
 * most expensive thing a panel can ask for on this screen and it is behind a
 * collapsed panel for exactly that reason.
 */
export async function loadSupabaseRankingRows(importIds = []) {
  if (!isSupabaseConfigured || !supabase) return null;
  const ids = [...new Set((importIds || []).filter(Boolean))];
  if (!ids.length) return { importIds: [], strategies: [], snapshots: [] };
  const [snapshots, strategies] = await Promise.all([
    loadRowsForImports('account_snapshots', LATEST_CLOSE_COLUMNS.account_snapshots, ids),
    loadRowsForImports('strategy_snapshots', STRATEGY_PARAMETER_COLUMNS, ids),
  ]);
  return { importIds: ids, strategies, snapshots };
}

/**
 * Opening a client: the things a login has no business holding for 206 people.
 *
 * Passwords and prop firm logins, and the jsonb `source_summary` the export
 * dialog reads. A CAM's browser used to hold every client's NinjaTrader and
 * prop firm password on every screen, including the ones they do not own.
 */
export async function loadSupabaseClientDetail(clientId) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const [credentials, propFirms, imports] = await Promise.all([
    selectRows('client_credentials',
      'client_id, ip, username, password_encrypted, nt_login, nt_password_encrypted, '
      + 'firm_login, firm_password_encrypted, notes',
      (query) => query.eq('client_id', clientUuid)),
    selectRows('client_prop_firms',
      'id, client_id, firm_name, connection, login, password_encrypted, sort_order',
      (query) => query.eq('client_id', clientUuid).order('sort_order', { ascending: true })),
    selectRows('daily_imports', 'id, source_summary', (query) => query.eq('client_id', clientUuid)),
  ]);
  return { clientId, credentials: credentials[0] || {}, propFirms, imports };
}

export function mergeSupabaseClientDetail(state, detail) {
  if (!detail?.clientId) return state;
  const summaryByImport = Object.fromEntries(
    (detail.imports || []).map((row) => [row.id, row.source_summary || {}]),
  );
  return {
    ...state,
    clients: (state.clients || []).map((client) => {
      if (client.id !== detail.clientId && client.uuid !== detail.clientId) return client;
      const credential = detail.credentials || {};
      return {
        ...client,
        credentials: {
          ip: credential.ip || '',
          username: credential.username || '',
          password: credential.password_encrypted || '',
          ntLogin: credential.nt_login || '',
          ntPassword: credential.nt_password_encrypted || '',
          firmLogin: credential.firm_login || '',
          firmPassword: credential.firm_password_encrypted || '',
          notes: credential.notes || '',
        },
        propFirms: (detail.propFirms || []).map(propFirmFromRow),
        detailLoaded: true,
        dailyImports: (client.dailyImports || []).map((dailyImport) => {
          const summary = summaryByImport[dailyImport.uuid || dailyImport.id];
          return summary ? { ...dailyImport, sourceSummary: summary } : dailyImport;
        }),
      };
    }),
  };
}

/**
 * Every flag on one close, at every status.
 *
 * THE HAZARD THIS EXISTS FOR. recalculateDailyImport carries prior triage
 * forward by matching what the close already holds, so on a login that only
 * fetched unresolved flags a Recalculate would not see the Resolved ones and
 * would regenerate them as Open — the operator's work undone by a button that
 * says it only re-reads the numbers. Recalculate re-reads the close's flags
 * first. It is a per-close action and one round trip.
 */
export async function loadSupabaseCloseFlags(importId) {
  if (!isSupabaseConfigured || !supabase) return [];
  const importUuid = isUuid(importId) ? importId : await getDailyImportUuid(importId);
  const rows = await selectRows(
    'operational_flags',
    `${LOGIN_COLUMNS.operational_flags}, client_id`,
    (query) => query.eq('daily_import_id', importUuid).order('id', { ascending: true }),
  );
  return rows;
}

/** The close's flags in the shape the app holds them, whatever their status. */
export function closeFlagsFromRows(state, rows = []) {
  const accountByUuid = accountRowsByUuid(state);
  return (rows || []).map((row) => flagFromRow(row, accountByUuid));
}

// ---------------------------------------------------------------------------
// THE PER-CLOSE SUMMARY, WRITTEN AND REBUILT (supabase/step_48_close_summaries.sql)
//
// `replace_close_summaries` stores rows; it does not decide them. Which segment
// an account close belongs to is decided by `segmentForAccount`, in JavaScript,
// once — at ingest through dailyImportPersistence, and here when an account is
// reclassified. See the header of src/domain/closeSummary.js.
// ---------------------------------------------------------------------------

/** True when step 48 has not been run, so the RPC is not in the schema cache. */
function isMissingCloseSummaryWriter(error) {
  const message = error?.message || '';
  return error?.code === 'PGRST202'
    || error?.code === '42883'
    || isMissingCloseSummaries(error)
    || (/replace_close_summaries/i.test(message) && /(does not exist|schema cache|could not find)/i.test(message));
}

/**
 * Replace the stored summary of one or more closes.
 *
 * Returns false where step 48 has not run: the close itself is saved either
 * way, deskMoney falls back to whatever closes are loaded, and an upload must
 * not fail because a desk aggregate has nowhere to go. Any OTHER failure is
 * raised, because a close whose summary silently did not write is a day the
 * manager's first screen will quietly under-report, and this is the one moment
 * at which anybody can be told.
 */
export async function replaceSupabaseCloseSummaries(dailyImportIds = [], rows = []) {
  if (!isSupabaseConfigured || !supabase) return false;
  const ids = [...new Set((dailyImportIds || []).filter(Boolean))];
  if (!ids.length) return false;
  const { error } = await supabase.rpc('replace_close_summaries', {
    p_daily_import_ids: ids,
    p_rows: rows,
  });
  if (error) {
    if (isMissingCloseSummaryWriter(error)) return false;
    throw new Error(error.message);
  }
  return true;
}

/**
 * Rebuild every close summary a client has, from their accounts as they are NOW.
 *
 * THE DEFECT THIS ANSWERS. buildCrmStateFromTables recomputes the
 * live/simulated/cash/prop split from each account's CURRENT record on every
 * load, deliberately, so that a CAM correcting a misclassification fixes every
 * close the client ever had rather than only the ones imported afterwards. A
 * stored summary freezes the classification it was written under, which would
 * have re-created exactly the bug that rule exists to prevent — the 2026-08-06
 * close that reported Craig's day as $0 staying wrong forever.
 *
 * So a reclassification rebuilds. One client is about twelve closes and sixty
 * account rows on the production book: two reads and one write. The summary
 * rows also carry the account names they counted, so a reader can catch a close
 * this rebuild missed rather than trusting it — see indexCloseSummaries.
 */
export async function rebuildSupabaseCloseSummariesForClient(clientId) {
  if (!isSupabaseConfigured || !supabase) return 0;
  const clientUuid = await getClientUuid(clientId);
  const [accountRows, importRows] = await Promise.all([
    loadTable('trading_accounts', {
      columns: LOGIN_COLUMNS.trading_accounts,
      filter: (query) => query.eq('client_id', clientUuid),
    }),
    loadTable('daily_imports', {
      columns: 'id, client_id, trading_date',
      filter: (query) => query.eq('client_id', clientUuid),
    }),
  ]);
  if (!importRows.length) return 0;

  const accountRegistry = {};
  for (const account of accountRows) accountRegistry[account.account_name] = accountMetaFromRow(account);

  const importIds = importRows.map((row) => row.id);
  const snapshotRows = await loadRowsForImports(
    'account_snapshots',
    LATEST_CLOSE_COLUMNS.account_snapshots,
    importIds,
  );
  const accountByUuid = byId(accountRows);
  const snapshotsByImport = {};
  for (const row of snapshotRows) {
    if (!snapshotsByImport[row.daily_import_id]) snapshotsByImport[row.daily_import_id] = [];
    snapshotsByImport[row.daily_import_id].push(snapshotFromRow(row, {}, accountByUuid));
  }

  const rows = [];
  for (const dailyImport of importRows) {
    // Every snapshot of the close in one list, with no `simulation` container.
    // That is not a shortcut around the split: `segmentForAccount` asks
    // `classifyAccountNature` about each account before it asks what the
    // account is FOR, so a simulated close lands in the simulated segment from
    // this shape exactly as it does from a split one.
    const summary = buildCloseSummaryRows({
      accountRegistry,
      dailyImport: {
        clientId: clientUuid,
        date: dailyImport.trading_date,
        snapshots: snapshotsByImport[dailyImport.id] || [],
      },
    });
    for (const row of summary) {
      rows.push(closeSummaryToDb(row, {
        dailyImportId: dailyImport.id,
        clientId: clientUuid,
        tradingDate: dailyImport.trading_date,
      }));
    }
  }

  const written = await replaceSupabaseCloseSummaries(importIds, rows);
  return written ? rows.length : 0;
}

/** The fields that move an account between desk segments. */
const RECLASSIFYING_FIELDS = ['accountType', 'simulationMode'];

export function patchReclassifies(patch = {}) {
  return RECLASSIFYING_FIELDS.some((field) => field in patch);
}

export async function loadSupabaseDiagnostics() {
  if (!isSupabaseConfigured || !supabase) return { connected: false, tables: [] };
  const tableNames = [
    'cam_profiles',
    'app_users',
    'clients',
    'client_assignments',
    'trading_accounts',
    'daily_imports',
    'account_snapshots',
    'strategy_snapshots',
    'orders',
    'executions',
    'operational_flags',
    'sop_templates',
    'sop_sections',
    'sop_items',
    'tasks',
    'activity_logs',
    'client_credentials',
    'client_prop_firms',
    'daily_sop_checklists',
    'payout_events',
  ];

  const tables = await Promise.all(tableNames.map(async (table) => {
    const [{ count, error: countError }, { data, error: sampleError }] = await Promise.all([
      supabase.from(table).select('*', { count: 'exact', head: true }),
      supabase.from(table).select('*').limit(3),
    ]);
    const error = countError || sampleError;
    return {
      table,
      count: count || 0,
      sample: data || [],
      columns: data?.[0] ? Object.keys(data[0]) : [],
      ok: !error,
      error: error?.message || '',
    };
  }));

  return { connected: tables.every((table) => table.ok), tables };
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyToNull(value) {
  return value === '' || value == null ? null : value;
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function accountPatchToDb(patch = {}) {
  const mapped = {};
  const fieldMap = {
    alias: 'alias',
    connection: 'connection',
    accountType: 'account_type',
    simulationMode: 'simulation_mode',
    status: 'status',
    payoutState: 'payout_state',
    riskLevel: 'risk_level',
    bulletBotPassType: 'bullet_bot_pass_type',
    bulletBotDirection: 'bullet_bot_direction',
    algoStack: 'algo_stack',
    dailyLossLimit: 'daily_loss_limit',
    notes: 'notes',
    tradovateAccountId: 'tradovate_account_id',
  };

  for (const [appField, dbField] of Object.entries(fieldMap)) {
    if (appField in patch) mapped[dbField] = patch[appField] ?? '';
  }

  if ('startBalance' in patch) mapped.start_balance = numberOrNull(patch.startBalance);
  if ('targetProfit' in patch) mapped.target_profit = numberOrNull(patch.targetProfit);
  if ('maxDrawdownLimit' in patch) mapped.max_drawdown_limit = numberOrNull(patch.maxDrawdownLimit);
  if ('propFirmPlan' in patch) mapped.prop_firm_plan = String(patch.propFirmPlan || '') || null;
  if ('payoutCount' in patch) mapped.payout_count = numberOrNull(patch.payoutCount) || 0;
  if ('dateAdded' in patch) mapped.date_added = emptyToNull(patch.dateAdded);
  if ('dateFunded' in patch) mapped.date_funded = emptyToNull(patch.dateFunded);
  if ('dateFailed' in patch) mapped.date_failed = emptyToNull(patch.dateFailed);
  if ('dateLastPayout' in patch) mapped.date_last_payout = emptyToNull(patch.dateLastPayout);

  mapped.updated_at = new Date().toISOString();
  return mapped;
}

async function getClientUuid(clientId) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientId || ''));
  let query = supabase
    .from('clients')
    .select('id');
  query = isUuid ? query.eq('id', clientId) : query.eq('legacy_key', clientId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`Client not found: ${clientId}`);
  return data.id;
}

async function getCamProfileUuid(camProfileId) {
  let query = supabase
    .from('cam_profiles')
    .select('id');
  query = isUuid(camProfileId) ? query.eq('id', camProfileId) : query.eq('legacy_key', camProfileId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`CAM profile not found: ${camProfileId}`);
  return data.id;
}

function makeLegacyKey(prefix, value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || Date.now()}`;
}

function clientPatchToDb(patch = {}) {
  const mapped = {};
  if ('name' in patch) mapped.name = patch.name || '';
  if ('status' in patch) mapped.status = patch.status || 'Active';
  if ('pinned' in patch) mapped.pinned = Boolean(patch.pinned);
  if ('pinnedNote' in patch) mapped.pinned_note = patch.pinnedNote || '';
  if ('notes' in patch) mapped.notes = patch.notes || '';
  if ('reportConfig' in patch) mapped.report_config = patch.reportConfig && typeof patch.reportConfig === 'object' ? patch.reportConfig : {};
  if ('clientOrder' in patch) mapped.client_order = Array.isArray(patch.clientOrder) ? patch.clientOrder : [];
  if ('startDate' in patch) mapped.start_date = emptyToNull(patch.startDate);
  if ('email' in patch) mapped.email = patch.email || '';
  if ('phone' in patch) mapped.phone = patch.phone || '';
  if ('timezone' in patch) mapped.timezone = patch.timezone || '';
  if ('notes' in patch) mapped.notes = patch.notes || '';
  if ('profile' in patch) {
    const profile = patch.profile || {};
    if ('stage' in profile) mapped.stage = profile.stage || 'Active';
    if ('fullName' in profile) mapped.full_name = profile.fullName || '';
    if ('email' in profile) mapped.email = profile.email || '';
    if ('phone' in profile) mapped.phone = profile.phone || '';
    if ('timezone' in profile) mapped.timezone = profile.timezone || '';
    if ('country' in profile) mapped.country = profile.country || '';
    if ('startDate' in profile) mapped.start_date = profile.startDate || null;
    if ('preferredChannel' in profile) mapped.preferred_channel = profile.preferredChannel || '';
    if ('language' in profile) mapped.language = profile.language || '';
    if ('productKey' in profile) mapped.product_key = profile.productKey || '';
    if ('additionalEmails' in profile) mapped.additional_emails = cleanStringArray(profile.additionalEmails);
    if ('propFirm' in profile) mapped.prop_firm = profile.propFirm || '';
    if ('messenger' in profile) mapped.messenger = profile.messenger || '';
    if ('subscriptionPrice' in profile) mapped.subscription_price = normalizeSubscriptionPrice(profile.subscriptionPrice);
  }
  // Mapped only when a patch actually carries tags, so no other save touches
  // the column and, on a database where step 42 has not run, no other save can
  // fail because of it.
  if ('tags' in patch) mapped.tags = normalizeClientTags(patch.tags);
  if ('accountFocus' in patch) mapped.account_focus = normalizeAccountFocus(patch.accountFocus);
  // The churn classification, mapped only when a patch actually carries one.
  //
  // This is the whole reason `churn` is a top-level key rather than a profile
  // field: `'churn' in patch` is true only on the write that records a
  // client leaving, so no other save touches these columns and, on a database
  // where step 39 has not run, no other save can fail because of them.
  //
  // The three land in the same UPDATE as `stage` — the App sends one patch — so
  // a client cannot be filed as Inactive without the reason that was given for
  // it. That is the point of the manager's decision, not a nicety: the failure
  // he asked to be rid of is a churn count nobody can explain.
  if ('churn' in patch) {
    const churn = patch.churn || {};
    mapped.churn_reason = emptyToNull(churn.reason);
    mapped.churn_note = churn.note || '';
    mapped.churned_at = emptyToNull(churn.at);
  }
  mapped.updated_at = new Date().toISOString();
  return mapped;
}

function credentialsToDb(credentials = {}) {
  return {
    ip: credentials.ip || '',
    username: credentials.username || '',
    password_encrypted: credentials.password || '',
    nt_login: credentials.ntLogin || '',
    nt_password_encrypted: credentials.ntPassword || '',
    firm_login: credentials.firmLogin || '',
    firm_password_encrypted: credentials.firmPassword || '',
    notes: credentials.notes || '',
    updated_at: new Date().toISOString(),
  };
}

function propFirmToDb(propFirm = {}, clientUuid, index = 0) {
  const connection = propFirm.connection === 'Rithmic' ? 'Rithmic' : 'Tradovate';
  const firmName = propFirm.name || propFirm.firmName || '';
  return {
    client_id: clientUuid,
    firm_name: firmName,
    connection,
    login: propFirm.login || '',
    password_encrypted: propFirm.password || '',
    sort_order: index,
    updated_at: new Date().toISOString(),
  };
}

function hasPropFirmData(propFirm = {}) {
  return Boolean(
    String(propFirm.name || '').trim() ||
    String(propFirm.firmName || '').trim() ||
    String(propFirm.login || '').trim() ||
    String(propFirm.password || '').trim(),
  );
}

function priceCheckToDb(row = {}, clientUuid, fallbackDate) {
  return {
    client_id: clientUuid,
    check_date: row.date || fallbackDate,
    instrument: row.instrument || '',
    time_label: row.time || row.checkTime || '',
    price: numberOrNull(row.price),
    connection_status: row.connectionStatus || row.connection || '',
    algo_status: row.algoStatus || row.algos || '',
    notes: row.notes || '',
    checked: Boolean(row.checked),
    updated_at: new Date().toISOString(),
  };
}

async function getDailyImportUuid(importId) {
  let query = supabase
    .from('daily_imports')
    .select('id');
  query = isUuid(importId) ? query.eq('id', importId) : query.eq('legacy_key', importId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`Daily import not found: ${importId}`);
  return data.id;
}

async function getCurrentAppUserId() {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.rpc('current_app_user');
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id || null;
}

async function getTradingAccount(clientId, accountName) {
  const clientUuid = await getClientUuid(clientId);
  const { data, error } = await supabase
    .from('trading_accounts')
    .select('*')
    .eq('client_id', clientUuid)
    .ilike('account_name', accountName)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { clientUuid, account: data };
}

async function getOptionalTradingAccountId(clientId, accountName) {
  if (!accountName) return null;
  const { account } = await getTradingAccount(clientId, accountName);
  return account?.id || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export async function updateSupabaseTradingAccount(clientId, accountName, patch) {
  if (!isSupabaseConfigured || !supabase) return null;
  const { account } = await getTradingAccount(clientId, accountName);
  if (!account?.id) throw new Error(`Trading account not found: ${accountName}`);

  const { data, error } = await supabase
    .from('trading_accounts')
    .update(accountPatchToDb(patch))
    .eq('id', account.id)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // An account that has just changed type or simulation mode belongs to a
  // different desk segment on every close it ever reported on. The stored
  // summaries for this client are rebuilt from the record as it is now, which
  // is what keeps a correction retroactive — see
  // rebuildSupabaseCloseSummariesForClient.
  //
  // Awaited, so a refresh that follows this save reads the rebuilt rows rather
  // than racing them. Its FAILURE is swallowed: the classification itself is
  // saved, and a desk aggregate that could not be rebuilt must not be reported
  // to the CAM as a failed save. Nothing is silently wrong if it does fail —
  // every summary row names the accounts it counted, so the rows that did not
  // move are refused on the way back in and the figure says it is incomplete.
  if (patchReclassifies(patch)) {
    await rebuildSupabaseCloseSummariesForClient(clientId).catch(() => {});
  }
  return data;
}

export async function createSupabaseClient(name, camProfileId = null, stage = 'Active') {
  if (!isSupabaseConfigured || !supabase) return null;
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Client name is required.');

  const { data: client, error } = await supabase
    .from('clients')
    .insert({
      legacy_key: `${makeLegacyKey('client', trimmedName)}-${Date.now().toString(36)}`,
      name: trimmedName,
      status: 'Active',
      stage: stage || 'Active',
      full_name: trimmedName,
      notes: '',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  if (camProfileId) {
    const camUuid = await getCamProfileUuid(camProfileId);
    const { error: assignmentError } = await supabase
      .from('client_assignments')
      .upsert({
        client_id: client.id,
        cam_profile_id: camUuid,
        assignment_role: 'Owner',
      }, { onConflict: 'client_id,cam_profile_id' });
    if (assignmentError) throw new Error(assignmentError.message);
  }

  return {
    id: pickId(client),
    uuid: client.id,
    name: client.name,
    status: client.status || 'Active',
    /* THE FIELDS revenueHealth READS, WHERE IT READS THEM.
     *
     * revenueHealth.js is the panel the desk's own manager asked for, and it
     * reads client.subscriptionPrice, client.createdAt and client.deletedAt at
     * the top level. subscriptionPrice was mapped only into profile, so tierOf
     * fell to DEFAULT_SUBSCRIPTION_PRICE for everyone and the panel reported an
     * MRR of zero with every client unpriced, while the table it reads held 19
     * at $500 and 11 at $250. createdAt and deletedAt were not mapped at all,
     * so free client ageing answered null and a deleted client counted as live.
     * Measured on production 2026-09-22: 140 active clients, 30 of them priced,
     * $12,250 of MRR the panel was showing as nothing.
     *
     * profile keeps its copy: the client form edits that one, and
     * updateSupabaseClient writes back from profile. */
    subscriptionPrice: normalizeSubscriptionPrice(client.subscription_price),
    createdAt: client.created_at || '',
    deletedAt: client.deleted_at || null,
    pinned: Boolean(client.pinned),
    pinnedNote: client.pinned_note || '',
    notes: client.notes || '',
    profile: {
      stage: client.stage || 'Active',
      fullName: client.full_name || client.name,
      email: client.email || '',
      phone: client.phone || '',
      timezone: client.timezone || '',
      country: client.country || '',
      startDate: client.start_date || '',
      preferredChannel: client.preferred_channel || '',
      language: client.language || '',
      productKey: client.product_key || '',
      additionalEmails: jsonArray(client.additional_emails),
      propFirm: client.prop_firm || '',
      messenger: client.messenger || '',
    },
    credentials: {
      ip: '',
      username: '',
      password: '',
      ntLogin: '',
      ntPassword: '',
      firmLogin: '',
      firmPassword: '',
      notes: '',
    },
    propFirms: [],
    accountRegistry: {},
    dailyImports: [],
    activityLog: [],
    tasks: [],
    priceChecks: [],
    priceChecksDate: '',
  };
}

export async function createSupabaseCamProfile(name, roleTitle = 'CAM') {
  if (!isSupabaseConfigured || !supabase) return null;
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('CAM name is required.');

  const { data, error } = await supabase
    .from('cam_profiles')
    .insert({
      legacy_key: `${makeLegacyKey('am', trimmedName)}-${Date.now().toString(36)}`,
      name: trimmedName,
      role_title: roleTitle || 'CAM',
      status: 'Active',
      live: true,
      can_manage_clients: false,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return {
    id: pickId(data),
    name: data.name,
    role: data.role_title || 'CAM',
    status: data.status || 'Active',
    live: Boolean(data.live),
    canManageClients: Boolean(data.can_manage_clients),
    reportConfig: data.report_config && typeof data.report_config === 'object' ? data.report_config : {},
    clientIds: [],
  };
}

export async function requestSupabaseTimeOff(camProfileId, request = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const camUuid = await getCamProfileUuid(camProfileId);
  const { data, error } = await supabase
    .from('cam_time_off')
    .insert({
      cam_profile_id: camUuid,
      start_date: request.startDate,
      end_date: request.endDate || request.startDate,
      kind: request.kind || 'Vacation',
      note: request.note || '',
      status: 'Pending',
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function decideSupabaseTimeOff(timeOffId, status, { decidedBy = null, note = '' } = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const decidedByUuid = decidedBy ? await getCamProfileUuid(decidedBy).catch(() => null) : null;
  const { data, error } = await supabase
    .from('cam_time_off')
    .update({
      status,
      decided_at: new Date().toISOString(),
      decided_by: decidedByUuid,
      decision_note: note || '',
      updated_at: new Date().toISOString(),
    })
    .eq('id', timeOffId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The row a time-off write returns, in the shape state.timeOff holds.
 *
 * The uuid->app-id map only exists inside a full load, and a single write has
 * no reason to build one: the caller already knows whose request it is, because
 * it just made it. Passing `camProfileId` in is what lets an approval show as
 * approved without re-downloading cam_profiles to translate one uuid.
 */
export function timeOffEntryFromRow(row, camProfileId) {
  return timeOffFromRow(row || {}, { [row?.cam_profile_id]: camProfileId });
}

// Hand a set of clients to covering CAMs for one window. Replaces whatever was
// already arranged for that request, so re-distributing is not additive.
//
// Returns the saved rows already mapped into the shape state.coverage holds.
// The mapping is free here and nowhere else: this function resolved every app
// id to a uuid on the way in, so it is the one place that holds both halves
// without a second round trip. Returning raw rows is what forced callers to
// re-read the whole database to see a cover they had just arranged.
export async function replaceSupabaseCoverage(assignments = [], { timeOffId = null, absentCamId = null, startDate, endDate } = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  if (timeOffId) {
    const { error } = await supabase.from('client_coverage').delete().eq('time_off_id', timeOffId);
    if (error) throw new Error(error.message);
  }
  if (!assignments.length) return [];

  const absentUuid = absentCamId ? await getCamProfileUuid(absentCamId).catch(() => null) : null;
  const camIdByUuid = {};
  const clientIdByUuid = {};
  if (absentUuid) camIdByUuid[absentUuid] = absentCamId;
  const rows = [];
  for (const assignment of assignments) {
    const clientUuid = await getClientUuid(assignment.clientId);
    const coveringUuid = await getCamProfileUuid(assignment.coveringCamId);
    clientIdByUuid[clientUuid] = assignment.clientId;
    camIdByUuid[coveringUuid] = assignment.coveringCamId;
    rows.push({
      client_id: clientUuid,
      covering_cam_profile_id: coveringUuid,
      absent_cam_profile_id: absentUuid,
      time_off_id: timeOffId,
      start_date: startDate,
      end_date: endDate || startDate,
      note: assignment.note || '',
    });
  }
  const { data, error } = await supabase
    .from('client_coverage')
    .upsert(rows, { onConflict: 'client_id,covering_cam_profile_id,start_date,end_date' })
    .select();
  if (error) throw new Error(error.message);
  return (data || []).map((row) => coverageFromRow(row, camIdByUuid, clientIdByUuid));
}

export async function deleteSupabaseCoverage(coverageId) {
  if (!isSupabaseConfigured || !supabase) return null;
  const { error } = await supabase.from('client_coverage').delete().eq('id', coverageId);
  if (error) throw new Error(error.message);
  return true;
}

export async function updateSupabaseCamProfile(camProfileId, patch = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const camUuid = await getCamProfileUuid(camProfileId);
  const mapped = { updated_at: new Date().toISOString() };
  if ('monthlyGoal' in patch) mapped.monthly_goal = numberOrNull(patch.monthlyGoal) || 0;
  if ('name' in patch) mapped.name = patch.name || '';
  if ('role' in patch) mapped.role_title = patch.role || 'CAM';
  if ('status' in patch) mapped.status = patch.status || 'Active';
  if ('live' in patch) mapped.live = Boolean(patch.live);
  if ('canManageClients' in patch) mapped.can_manage_clients = Boolean(patch.canManageClients);
  if ('reportConfig' in patch) mapped.report_config = patch.reportConfig && typeof patch.reportConfig === 'object' ? patch.reportConfig : {};
  // cam_profiles.client_order (step_32_client_order.sql) is where the sidebar
  // drag order lives, and camProfileFromRow above reads it back — but this
  // mapping did not write it, so `updateSupabaseCamProfile(camId, { clientOrder })`
  // sent nothing but an updated_at and reported success. The order survived
  // until the next load and then vanished: the desk manager's "drags a client
  // to reorder the sidebar -> the client snaps back". The identically named key
  // in clientPatchToDb, which does map it, is on the CLIENTS table and is not
  // this one.
  if ('clientOrder' in patch) mapped.client_order = Array.isArray(patch.clientOrder) ? patch.clientOrder : [];

  const { data, error } = await supabase
    .from('cam_profiles')
    .update(mapped)
    .eq('id', camUuid)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSupabaseClient(clientId, patch = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const dbPatch = clientPatchToDb(patch);
  const credentialPatch = 'credentials' in patch ? credentialsToDb(patch.credentials || {}) : null;
  const propFirmPatch = 'propFirms' in patch ? (patch.propFirms || []) : null;

  /* THE PRICE BEFORE THE CHANGE, READ BEFORE THE CHANGE.
   *
   * New MRR, lost MRR and the free-to-paying conversion rate are all
   * differences between a before and an after, and neither was ever stored.
   * The audit trail for a client edit records `changedFields:
   * Object.keys(patch)` and nothing else: it knows the price was touched and
   * on what day, and has never known whether the client went from Free to $500
   * or the reverse. None of it can be reconstructed backwards, so the log
   * starts the day this ships and the dashboard reports how far back it
   * actually reaches.
   *
   * Read here rather than after the update, because after the update the old
   * value is gone. */
  let previousPrice = null;
  if ('subscription_price' in dbPatch) {
    const { data: before } = await supabase
      .from('clients')
      .select('subscription_price')
      .eq('id', clientUuid)
      .maybeSingle();
    previousPrice = before?.subscription_price ?? null;
  }

  const { data, error } = await supabase
    .from('clients')
    .update(dbPatch)
    .eq('id', clientUuid)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // Only on an actual move. Saving the contact card re-sends the whole profile,
  // so without this every phone-number correction would write a row saying the
  // price changed from $500 to $500 and the movement figures would be noise.
  if ('subscription_price' in dbPatch && dbPatch.subscription_price !== previousPrice) {
    // Deliberately not awaited into the failure path: the price change is
    // saved, and losing its history row must never surface as a failed save.
    await supabase
      .from('client_price_changes')
      .insert({
        client_id: clientUuid,
        previous_price: previousPrice,
        new_price: dbPatch.subscription_price,
      })
      .then(
        () => {},
        () => {},
      );
  }

  if (credentialPatch) {
    const { error: credentialError } = await supabase
      .from('client_credentials')
      .upsert({ client_id: clientUuid, ...credentialPatch }, { onConflict: 'client_id' });
    if (credentialError) throw new Error(credentialError.message);
  }

  if (propFirmPatch) {
    const { error: deleteError } = await supabase
      .from('client_prop_firms')
      .delete()
      .eq('client_id', clientUuid);
    if (deleteError) throw new Error(deleteError.message);

    const rows = propFirmPatch
      .filter(hasPropFirmData)
      .map((propFirm, index) => propFirmToDb(propFirm, clientUuid, index));
    if (rows.length) {
      const { error: insertError } = await supabase
        .from('client_prop_firms')
        .insert(rows);
      if (insertError) throw new Error(insertError.message);
    }
  }

  return data;
}

export async function softDeleteSupabaseClient(clientId) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const { data, error } = await supabase
    .from('clients')
    .update({
      status: 'Inactive',
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', clientUuid)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function transferSupabaseClient(clientId, toCamProfileId) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);

  const { error: deleteError } = await supabase
    .from('client_assignments')
    .delete()
    .eq('client_id', clientUuid)
    .eq('assignment_role', 'Owner');
  if (deleteError) throw new Error(deleteError.message);

  if (!toCamProfileId) return null;

  const camUuid = await getCamProfileUuid(toCamProfileId);
  const { data, error } = await supabase
    .from('client_assignments')
    .upsert({
      client_id: clientUuid,
      cam_profile_id: camUuid,
      assignment_role: 'Owner',
      assigned_at: new Date().toISOString(),
    }, { onConflict: 'client_id,cam_profile_id' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function replaceSupabasePriceChecks(clientId, rows = [], checkDate = null) {
  if (!isSupabaseConfigured || !supabase) return [];
  const clientUuid = await getClientUuid(clientId);
  const targetDate = checkDate || new Date().toISOString().slice(0, 10);

  const { error: deleteError } = await supabase
    .from('price_checks')
    .delete()
    .eq('client_id', clientUuid)
    .eq('check_date', targetDate);
  if (deleteError) throw new Error(deleteError.message);

  const dbRows = (rows || []).map((row) => priceCheckToDb(row, clientUuid, targetDate));
  if (!dbRows.length) return [];

  const { data, error } = await supabase
    .from('price_checks')
    .insert(dbRows)
    .select();
  if (error) throw new Error(error.message);
  return (data || []).map(priceCheckFromRow);
}

export async function upsertSupabaseTradingAccount(clientId, accountName, meta = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const row = {
    client_id: clientUuid,
    legacy_key: accountName,
    account_name: accountName,
    alias: meta.alias || accountName,
    connection: meta.connection || '',
    account_type: meta.accountType || 'Unassigned',
    simulation_mode: String(meta.simulationMode || '') || null,
    tradovate_account_id: meta.tradovateAccountId || null,
    status: meta.status || 'Active',
    payout_state: meta.payoutState || 'Not requested',
    start_balance: numberOrNull(meta.startBalance),
    target_profit: numberOrNull(meta.targetProfit),
    max_drawdown_limit: numberOrNull(meta.maxDrawdownLimit),
    prop_firm_plan: String(meta.propFirmPlan || '') || null,
    risk_level: meta.riskLevel || '',
    bullet_bot_pass_type: meta.bulletBotPassType || '',
    bullet_bot_direction: meta.bulletBotDirection || '',
    notes: meta.notes || '',
    date_added: emptyToNull(meta.dateAdded),
    date_funded: emptyToNull(meta.dateFunded),
    date_failed: emptyToNull(meta.dateFailed),
    date_last_payout: emptyToNull(meta.dateLastPayout),
    payout_count: numberOrNull(meta.payoutCount) || 0,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('trading_accounts')
    .upsert(row, { onConflict: 'client_id,account_name' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteSupabaseTradingAccount(clientId, accountName) {
  if (!isSupabaseConfigured || !supabase) return null;
  const { account } = await getTradingAccount(clientId, accountName);
  if (!account?.id) return null;
  const { error } = await supabase
    .from('trading_accounts')
    .delete()
    .eq('id', account.id);
  if (error) throw new Error(error.message);
  return true;
}

export async function insertSupabasePayoutEvent(clientId, accountName, entry) {
  if (!isSupabaseConfigured || !supabase) return null;
  const { account } = await getTradingAccount(clientId, accountName);
  if (!account?.id) throw new Error(`Trading account not found: ${accountName}`);

  const { data, error } = await supabase
    .from('payout_events')
    .insert({
      trading_account_id: account.id,
      payout_date: entry.date,
      amount: numberOrNull(entry.amount),
      state: entry.state || 'Payout approved',
      note: entry.note || '',
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function taskPatchToDb(patch = {}) {
  const mapped = {};
  if ('text' in patch) mapped.text = patch.text || '';
  if ('priority' in patch) mapped.priority = patch.priority || 'Normal';
  if ('dueDate' in patch) mapped.due_date = emptyToNull(patch.dueDate);
  if ('done' in patch) {
    mapped.done = Boolean(patch.done);
    mapped.done_at = patch.done ? (patch.doneAt || new Date().toISOString()) : null;
  }
  if ('doneAt' in patch && !('done' in patch)) mapped.done_at = emptyToNull(patch.doneAt);
  mapped.updated_at = new Date().toISOString();
  return mapped;
}

export async function insertSupabaseTask(clientId, task) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const accountId = await getOptionalTradingAccountId(clientId, task.accountName);
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      legacy_key: task.id || `task-${Date.now()}`,
      client_id: clientUuid,
      trading_account_id: accountId,
      text: task.text,
      priority: task.priority || 'Normal',
      due_date: emptyToNull(task.dueDate),
      done: Boolean(task.done),
      done_at: emptyToNull(task.doneAt),
      created_at: task.createdAt || new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSupabaseTask(taskId, patch) {
  if (!isSupabaseConfigured || !supabase) return null;
  let query = supabase.from('tasks').update(taskPatchToDb(patch));
  query = isUuid(taskId) ? query.eq('id', taskId) : query.eq('legacy_key', taskId);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteSupabaseTask(taskId) {
  if (!isSupabaseConfigured || !supabase) return null;
  let query = supabase.from('tasks').delete();
  query = isUuid(taskId) ? query.eq('id', taskId) : query.eq('legacy_key', taskId);
  const { error } = await query;
  if (error) throw new Error(error.message);
  return true;
}

export async function insertSupabaseActivity(clientId, entry) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const accountId = await getOptionalTradingAccountId(clientId, entry.accountName);
  const { data, error } = await supabase
    .from('activity_logs')
    .insert({
      legacy_key: entry.id || `act-${Date.now()}`,
      client_id: clientUuid,
      trading_account_id: accountId,
      type: entry.type || 'Note',
      text: entry.text || '',
      log_date: entry.logDate || null,
      log_pnl: entry.logPnl != null ? entry.logPnl : null,
      created_at: entry.createdAt || new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteSupabaseActivity(entryId) {
  if (!isSupabaseConfigured || !supabase) return null;
  let query = supabase.from('activity_logs').delete();
  query = isUuid(entryId) ? query.eq('id', entryId) : query.eq('legacy_key', entryId);
  const { error } = await query;
  if (error) throw new Error(error.message);
  return true;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function updateSupabaseOperationalFlag(flagId, status) {
  if (!isSupabaseConfigured || !supabase) return null;
  if (!UUID_PATTERN.test(String(flagId || ''))) {
    // Reject before the request rather than letting Postgres answer with
    // "invalid input syntax for type uuid", which named the column but not the
    // cause. An id in this shape means the flag was never written, so resolving
    // it would silently do nothing.
    throw new Error(
      'This flag has not been saved yet. Reload the page and try again.',
    );
  }
  const patch = {
    status,
    // 'Acknowledged' used to be on this list, because the Acknowledge button on
    // the client Dashboard and the CAM flag queue wrote it. Both are gone and
    // 'Resolved' is the only status the product now sends here. It is off the
    // list rather than left as a harmless extra: this is the one place that
    // decides a flag has been closed, and a status listed here reads as a status
    // this app writes.
    resolved_at: ['Resolved', 'Ignored'].includes(status) ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase
    .from('operational_flags')
    .update(patch)
    .eq('id', flagId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function replaceSupabaseOperationalFlags(clientId, importId, flags = [], status = 'Needs review') {
  if (!isSupabaseConfigured || !supabase) return [];
  const [clientUuid, importUuid] = await Promise.all([
    getClientUuid(clientId),
    getDailyImportUuid(importId),
  ]);

  const { data: accounts, error: accountError } = await supabase
    .from('trading_accounts')
    .select('id, account_name')
    .eq('client_id', clientUuid);
  if (accountError) throw new Error(accountError.message);

  const accountByName = Object.fromEntries((accounts || []).map((account) => [
    String(account.account_name || '').toLowerCase(),
    account,
  ]));

  const { error: deleteError } = await supabase
    .from('operational_flags')
    .delete()
    .eq('daily_import_id', importUuid);
  if (deleteError) throw new Error(deleteError.message);

  await updateSupabaseDailyImportStatus(importUuid, status);

  if (!flags.length) return [];
  const rows = flags.map((flag) => {
    const account = accountByName[String(flag.accountName || '').toLowerCase()];
    return {
      id: flag.id,
      daily_import_id: importUuid,
      client_id: clientUuid,
      trading_account_id: account?.id || null,
      type: flag.type,
      severity: flag.severity || 'Warning',
      message: flag.message || '',
      status: flag.status || 'Open',
      resolved_at: flag.resolvedAt || null,
    };
  });

  const { data, error } = await supabase
    .from('operational_flags')
    .insert(rows)
    .select('*, trading_accounts(account_name)');
  if (error) throw new Error(error.message);

  return (data || []).map((row) => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    accountName: row.trading_accounts?.account_name || '',
    message: row.message,
    status: row.status || 'Open',
  }));
}

export function createSupabaseDailyImportAdapter(client) {
  const deleteTables = new Set(['strategy_snapshots', 'orders', 'executions', 'operational_flags']);
  const insertTables = new Set(['strategy_snapshots', 'orders', 'executions', 'operational_flags']);
  const adapter = {
    // PostgREST cannot wrap these separate requests in one transaction. This
    // manual-upload-only browser compatibility adapter therefore runs work
    // directly. Its writability guard is a non-locking check: failures propagate,
    // but earlier requests cannot roll back and concurrent writes are not atomic.
    isAtomic: false,
    manualOnly: true,
    supportsDailyImportSourceColumns: false,
    transaction(work) {
      return work(adapter);
    },
    async guardDailyImportWritable(clientUuid, tradingDate) {
      const { data, error } = await client
        .from('daily_imports')
        .select('id, status')
        .eq('client_id', clientUuid)
        .eq('trading_date', tradingDate)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data?.status === 'Closed') throw new DailyImportClosedError(tradingDate);
      return data;
    },
    async upsertTradingAccounts(rows) {
      const { error } = await client
        .from('trading_accounts')
        .upsert(rows, { onConflict: 'client_id,account_name' });
      if (error) throw new Error(error.message);
    },
    async listTradingAccounts(clientUuid) {
      const { data, error } = await client
        .from('trading_accounts')
        .select('id, account_name')
        .eq('client_id', clientUuid);
      if (error) throw new Error(error.message);
      return data || [];
    },
    async upsertDailyImport(row) {
      const { data, error } = await client
        .from('daily_imports')
        .upsert(row, { onConflict: 'client_id,trading_date' })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    async deleteDailyImportRows(table, dailyImportId) {
      if (!deleteTables.has(table)) {
        throw new Error(`Unsupported daily import delete table: ${table}`);
      }
      const { error } = await client
        .from(table)
        .delete()
        .eq('daily_import_id', dailyImportId);
      if (error) throw new Error(error.message);
    },
    async upsertAccountSnapshots(rows) {
      const { data, error } = await client
        .from('account_snapshots')
        .upsert(rows, { onConflict: 'daily_import_id,account_name' })
        .select();
      if (error) throw new Error(error.message);
      return data || [];
    },
    async insertRows(table, rows) {
      if (!insertTables.has(table)) {
        throw new Error(`Unsupported daily import insert table: ${table}`);
      }
      const { error } = await client.from(table).insert(rows);
      if (error) throw new Error(error.message);
    },
    // The per (close, segment) money, already decided by buildSegmentTotals.
    // Through the RPC rather than a table write so the delete and the insert
    // are one statement: a close whose old rows were removed and whose new ones
    // were not written would read as a day the desk made nothing.
    async replaceCloseSummaries({ dailyImportId, rows }) {
      await replaceSupabaseCloseSummaries([dailyImportId], rows);
    },
  };
  return adapter;
}

export async function upsertSupabaseDailyImport(clientId, importResult) {
  if (!isSupabaseConfigured || !supabase) return null;
  if (!importResult?.date) throw new Error('Import date is required.');

  const clientUuid = await getClientUuid(clientId);
  return persistDailyImportWithClient({
    db: createSupabaseDailyImportAdapter(supabase),
    clientUuid,
    importResult: withLegacyDailyImportId(clientId, importResult),
  });
}

export async function updateSupabaseDailyImportStatus(importId, status) {
  if (!isSupabaseConfigured || !supabase) return null;
  let query = supabase
    .from('daily_imports')
    .update({ status, updated_at: new Date().toISOString() });
  query = isUuid(importId) ? query.eq('id', importId) : query.eq('legacy_key', importId);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Undo a day's upload: remove the whole close for (client, date). The child
// tables (snapshots, strategies, orders, executions, flags) all cascade on the
// daily_imports FK, so deleting the import row removes them too. The trading
// accounts themselves are the persistent registry and are left untouched.
export async function deleteSupabaseDailyImport(clientId, importId) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  let query = supabase.from('daily_imports').delete().eq('client_id', clientUuid);
  query = isUuid(importId) ? query.eq('id', importId) : query.eq('legacy_key', importId);
  const { error } = await query;
  if (error) throw new Error(error.message);
  return true;
}

export function reportFromRow(row = {}) {
  const content = row.content && typeof row.content === 'object' ? row.content : {};
  return {
    id: row.id,
    clientId: row.client_id,
    dailyImportId: row.daily_import_id || '',
    reportType: row.report_type || '',
    reportDate: row.report_date || '',
    content,
    title: content.title || content.summary?.clientName || row.report_type || 'Report',
    generatedByUserId: row.generated_by_user_id || '',
    createdAt: row.created_at || '',
  };
}

export async function createSupabaseReport(clientId, dailyImportId, reportType, content = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const clientUuid = await getClientUuid(clientId);
  const importUuid = dailyImportId ? await getDailyImportUuid(dailyImportId) : null;
  const generatedByUserId = await getCurrentAppUserId();
  const reportDate = content.reportDate || content.summary?.date || null;

  const { data, error } = await supabase
    .from('reports')
    .insert({
      client_id: clientUuid,
      daily_import_id: importUuid,
      report_type: reportType || 'daily_close',
      report_date: reportDate,
      content,
      generated_by_user_id: generatedByUserId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return reportFromRow(data);
}

/**
 * Every report row stored for ONE (client, close), newest first.
 *
 * Needed because `reports` has no unique key on (client_id, daily_import_id,
 * report_type) — neither cam_crm_schema.sql:282 nor step_11_report_history.sql
 * declares one — and ReportPanel INSERTS on every mount. Measured on the 610
 * rows in public/local-snapshot.json: 610 rows over 440 distinct (client,
 * import) pairs, 93 pairs duplicated, one pair holding 9 copies. So anything
 * that has to find what a CAM wrote on a day has to look across the whole
 * stack of rows for that day, not at the newest one.
 */
export async function loadSupabaseReportsForImport(clientId, dailyImportId, { reportType = 'daily_close', limit = 50 } = {}) {
  if (!isSupabaseConfigured || !supabase || !dailyImportId) return [];
  const clientUuid = await getClientUuid(clientId);
  const importUuid = await getDailyImportUuid(dailyImportId);
  let query = supabase
    .from('reports')
    .select('*')
    .eq('client_id', clientUuid)
    .eq('daily_import_id', importUuid);
  if (reportType) query = query.eq('report_type', reportType);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(reportFromRow);
}

/**
 * Replace one report row's `content` jsonb.
 *
 * The first UPDATE anywhere against this table: until now the only write was the
 * insert on panel mount, which is why nothing a CAM typed could ever survive.
 * `content` is `jsonb default '{}'` with no CHECK, so writing back a spread of
 * the row's own content plus one new key breaks no constraint and leaves the 610
 * existing rows readable — reportFromRow spreads content wholesale and only ever
 * looks at `content.title` / `content.summary?.clientName`.
 */
export async function updateSupabaseReportContent(reportId, content) {
  if (!isSupabaseConfigured || !supabase || !reportId) return null;
  const { data, error } = await supabase
    .from('reports')
    .update({ content })
    .eq('id', reportId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return reportFromRow(data);
}

export async function loadSupabaseReports(clientId, { limit = 10 } = {}) {
  if (!isSupabaseConfigured || !supabase) return [];
  const clientUuid = await getClientUuid(clientId);
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('client_id', clientUuid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(reportFromRow);
}

export function auditLogFromRow(row = {}) {
  const afterData = row.after_data && typeof row.after_data === 'object' ? row.after_data : {};
  const beforeData = row.before_data && typeof row.before_data === 'object' ? row.before_data : {};
  return {
    id: row.id,
    userId: row.user_id || '',
    userDisplayName: row.app_users?.display_name || row.app_users?.username || '',
    userEmail: row.app_users?.email || '',
    entityType: row.entity_type || '',
    entityId: row.entity_id || '',
    action: row.action || '',
    beforeData,
    afterData,
    createdAt: row.created_at || '',
  };
}

export async function createSupabaseAuditLog({
  entityType,
  entityId = null,
  action,
  beforeData = null,
  afterData = null,
} = {}) {
  if (!isSupabaseConfigured || !supabase || !entityType || !action) return null;
  const userId = await getCurrentAppUserId();
  const uuidEntityId = isUuid(entityId) ? entityId : null;
  const normalizedAfter = {
    ...(afterData && typeof afterData === 'object' ? afterData : {}),
    ...(!uuidEntityId && entityId ? { legacyEntityId: entityId } : {}),
  };
  const { data, error } = await supabase
    .from('audit_logs')
    .insert({
      user_id: userId,
      entity_type: entityType,
      entity_id: uuidEntityId,
      action,
      before_data: beforeData,
      after_data: Object.keys(normalizedAfter).length ? normalizedAfter : afterData,
    })
    .select('*, app_users(display_name, username, email)')
    .single();
  if (error) throw new Error(error.message);
  return auditLogFromRow(data);
}

export async function loadSupabaseAuditLogs({ limit = 50 } = {}) {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*, app_users(display_name, username, email)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(auditLogFromRow);
}

export async function loadSupabaseDailySop(camProfileId, checklistDate) {
  if (!isSupabaseConfigured || !supabase || !camProfileId || !checklistDate) return null;
  const camProfileUuid = await getCamProfileUuid(camProfileId);
  const { data, error } = await supabase
    .from('daily_sop_checklists')
    .select('*')
    .eq('cam_profile_id', camProfileUuid)
    .eq('checklist_date', checklistDate)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function loadSupabaseDailySopTemplate() {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data: template, error: templateError } = await supabase
    .from('sop_templates')
    .select('*')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (templateError) throw new Error(templateError.message);
  if (!template?.id) return null;

  const { data: sections, error: sectionError } = await supabase
    .from('sop_sections')
    .select('*')
    .eq('template_id', template.id)
    .eq('is_active', true)
    .order('display_order', { ascending: true });
  if (sectionError) throw new Error(sectionError.message);

  const sectionIds = (sections || []).map((section) => section.id);
  const { data: items, error: itemError } = sectionIds.length
    ? await supabase
      .from('sop_items')
      .select('*')
      .in('section_id', sectionIds)
      .eq('is_active', true)
      .order('display_order', { ascending: true })
    : { data: [], error: null };
  if (itemError) throw new Error(itemError.message);

  const itemsBySection = {};
  for (const item of items || []) {
    if (!itemsBySection[item.section_id]) itemsBySection[item.section_id] = [];
    itemsBySection[item.section_id].push({
      id: item.id,
      key: item.item_key,
      text: item.text,
      displayOrder: item.display_order,
    });
  }

  return {
    id: template.id,
    legacyKey: template.legacy_key,
    name: template.name,
    editableByRole: template.editable_by_role || 'Manager',
    sections: (sections || []).map((section) => ({
      id: section.id,
      key: section.section_key,
      title: section.title,
      time: section.time_label || '',
      emoji: section.emoji || '',
      displayOrder: section.display_order,
      items: itemsBySection[section.id] || [],
    })),
  };
}

export async function createSupabaseSopSection(templateId, section = {}) {
  if (!isSupabaseConfigured || !supabase || !templateId) return null;
  const { data, error } = await supabase
    .from('sop_sections')
    .insert({
      template_id: templateId,
      section_key: section.key || `section-${Date.now()}`,
      title: section.title || 'New section',
      time_label: section.time || '',
      emoji: section.emoji || '',
      display_order: Number(section.displayOrder || 0),
      is_active: true,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSupabaseSopSection(sectionId, patch = {}) {
  if (!isSupabaseConfigured || !supabase || !sectionId) return null;
  const mapped = { updated_at: new Date().toISOString() };
  if ('title' in patch) mapped.title = patch.title || '';
  if ('time' in patch) mapped.time_label = patch.time || '';
  if ('emoji' in patch) mapped.emoji = patch.emoji || '';
  if ('displayOrder' in patch) mapped.display_order = Number(patch.displayOrder || 0);
  if ('isActive' in patch) mapped.is_active = Boolean(patch.isActive);
  const { data, error } = await supabase
    .from('sop_sections')
    .update(mapped)
    .eq('id', sectionId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function createSupabaseSopItem(sectionId, item = {}) {
  if (!isSupabaseConfigured || !supabase || !sectionId) return null;
  const { data, error } = await supabase
    .from('sop_items')
    .insert({
      section_id: sectionId,
      item_key: item.key || `item-${Date.now()}`,
      text: item.text || 'New checklist item',
      display_order: Number(item.displayOrder || 0),
      is_active: true,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSupabaseSopItem(itemId, patch = {}) {
  if (!isSupabaseConfigured || !supabase || !itemId) return null;
  const mapped = { updated_at: new Date().toISOString() };
  if ('text' in patch) mapped.text = patch.text || '';
  if ('displayOrder' in patch) mapped.display_order = Number(patch.displayOrder || 0);
  if ('isActive' in patch) mapped.is_active = Boolean(patch.isActive);
  const { data, error } = await supabase
    .from('sop_items')
    .update(mapped)
    .eq('id', itemId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveSupabaseDailySop(camProfileId, checklistDate, checkedItems = {}, streak = {}, completedAt = null, templateId = null) {
  if (!isSupabaseConfigured || !supabase || !camProfileId || !checklistDate) return null;
  const camProfileUuid = await getCamProfileUuid(camProfileId);
  const row = {
    cam_profile_id: camProfileUuid,
    template_id: templateId || null,
    checklist_date: checklistDate,
    checked_items: checkedItems || {},
    streak_count: Number(streak.count || 0),
    streak_last_date: streak.lastDate || null,
    completed_at: completedAt || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('daily_sop_checklists')
    .upsert(row, { onConflict: 'cam_profile_id,checklist_date' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function strategyClassificationFromRow(row = {}) {
  return {
    id: row.id,
    key: row.match_key,
    family: row.family || '',
    signature: row.signature || null,
    version: row.version || '',
    riskLevel: row.risk_level || '',
    notes: row.notes || '',
  };
}

export async function loadStrategyClassifications() {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase
    .from('strategy_classifications')
    .select('*')
    .order('family', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(strategyClassificationFromRow);
}

export async function upsertStrategyClassification(classification = {}) {
  if (!isSupabaseConfigured || !supabase) return null;
  const row = {
    match_key: classification.key,
    family: classification.family || '',
    signature: classification.signature || null,
    version: classification.version || '',
    risk_level: classification.riskLevel || '',
    notes: classification.notes || '',
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('strategy_classifications')
    .upsert(row, { onConflict: 'match_key' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return strategyClassificationFromRow(data);
}

export async function deleteStrategyClassification(matchKey) {
  if (!isSupabaseConfigured || !supabase) return;
  const { error } = await supabase
    .from('strategy_classifications')
    .delete()
    .eq('match_key', matchKey);
  if (error) throw new Error(error.message);
}

function logAlgoHistoryFromRow(row = {}) {
  return {
    date: row.log_date || '',
    accountName: row.account_name || '',
    family: row.family || 'Unknown',
    direction: row.direction || 'Mixed',
    realizedPnl: Number(row.realized_pnl || 0),
    roundTrips: Number(row.round_trips || 0),
  };
}

export async function loadLogAlgoHistory() {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.from('log_algo_history').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(logAlgoHistoryFromRow);
}

export async function saveLogAlgoHistory(rows = []) {
  if (!isSupabaseConfigured || !supabase || !rows.length) return [];
  const payload = rows.map((r) => ({
    log_date: r.date || null,
    account_name: r.accountName || '',
    family: r.family || 'Unknown',
    direction: r.direction || 'Mixed',
    realized_pnl: r.realizedPnl || 0,
    round_trips: r.roundTrips || 0,
  }));
  const { data, error } = await supabase
    .from('log_algo_history')
    .upsert(payload, { onConflict: 'log_date,account_name,family' })
    .select();
  if (error) throw new Error(error.message);
  return (data || []).map(logAlgoHistoryFromRow);
}

// ---------------------------------------------------------------------------
// My Futures Book backtest series (supabase/step_44_algorithm_benchmarks.sql)
//
// These rows are BACKTESTS: one simulated account, the version the desk runs
// today re-run over history, downloaded from the vendor's portfolio page. They
// are not client money and they never share a table, a chart series or a total
// with anything read out of `account_snapshots`. Everything that keeps that
// true — the risk level in the key, the vendor's already-net Profit, the
// month-local drawdown — is decided in src/domain/algorithmBenchmark.js; this
// pair of functions only carries the rows across.
// ---------------------------------------------------------------------------

function algorithmBenchmarkFromRow(row = {}) {
  return {
    id: row.id,
    vendor: row.source_vendor || 'My Futures Book',
    algorithm: row.algorithm || '',
    version: row.version || '',
    instrument: row.instrument || '',
    riskLevel: row.risk_level || '',
    month: String(row.month || '').slice(0, 10),
    trades: Number(row.trades || 0),
    tradingDays: Number(row.trading_days || 0),
    contracts: Number(row.contracts || 0),
    grossProfit: Number(row.gross_profit || 0),
    commission: Number(row.commission || 0),
    netProfit: Number(row.net_profit || 0),
    // A rate the file had no trades to compute stays null: 0% would read as
    // "never won" rather than "nothing to divide".
    winRate: row.win_rate == null ? null : Number(row.win_rate),
    maxDrawdown: Number(row.max_drawdown || 0),
    commissionPerContract: row.commission_per_contract == null ? null : Number(row.commission_per_contract),
    sourceFile: row.source_file || '',
    importedAt: row.imported_at || null,
    // The month's own days, which is what makes this table readable by the
    // period report at all: the report asks which days inside one WEEK the
    // backtest closed a trade on, and a month cannot answer that.
    days: Array.isArray(row.days) ? row.days : [],
  };
}

// True when step 44 has not been run. PostgREST answers PGRST205 for a table
// missing from its schema cache, and the message names it before the cache is
// built. Callers use this to disable saving and say why, rather than showing a
// raw Postgres error to a CAM holding 36 files.
export function isMissingBenchmarkTable(error) {
  const message = error?.message || '';
  return error?.code === 'PGRST205'
    || error?.code === '42P01'
    || (/algorithm_benchmarks/i.test(message) && /(does not exist|schema cache)/i.test(message));
}

export async function loadAlgorithmBenchmarks({ riskLevel = '', from = '', to = '' } = {}) {
  if (!isSupabaseConfigured || !supabase) return [];
  let query = supabase.from('algorithm_benchmarks').select('*');
  if (riskLevel) query = query.eq('risk_level', riskLevel);
  if (from) query = query.gte('month', from);
  if (to) query = query.lte('month', to);
  const { data, error } = await query.order('month', { ascending: true });
  if (error) {
    if (isMissingBenchmarkTable(error)) return [];
    throw new Error(error.message);
  }
  return (data || []).map(algorithmBenchmarkFromRow);
}

/**
 * Write the monthly aggregates `benchmarkMonthlyRows` produced.
 *
 * Upserted on the table's own unique key (vendor, algorithm, version,
 * instrument, risk level, month), so re-importing next month's download replaces
 * the months it covers instead of adding a second copy of every year the desk
 * already holds, and a second vendor's rows sit beside My Futures Book's rather
 * than overwriting them.
 * `imported_at` and the importing user are rewritten on each import, because
 * the question a reader asks of a benchmark row is when it was pulled and by
 * whom, not when it was first seen.
 */
export async function saveAlgorithmBenchmarks(rows = []) {
  if (!isSupabaseConfigured || !supabase || !rows.length) return [];
  const importedByUserId = await getCurrentAppUserId();
  const importedAt = new Date().toISOString();
  const payload = rows.map((row) => ({
    source_vendor: row.vendor || 'My Futures Book',
    algorithm: row.algorithm || '',
    version: row.version || '',
    instrument: row.instrument || '',
    risk_level: row.riskLevel || '',
    month: row.month,
    trades: row.trades,
    trading_days: row.tradingDays,
    contracts: row.contracts,
    gross_profit: row.grossProfit,
    commission: row.commission,
    net_profit: row.netProfit,
    win_rate: row.winRate,
    commission_per_contract: row.commissionPerContract ?? null,
    max_drawdown: row.maxDrawdown,
    days: row.days || [],
    source_file: row.sourceFile || '',
    imported_at: importedAt,
    imported_by_user_id: importedByUserId,
  }));
  const { data, error } = await supabase
    .from('algorithm_benchmarks')
    // The table's own unique key, vendor first. Without the vendor a second
    // vendor's row for the same series and month would REPLACE the My Futures
    // Book row rather than sit beside it, which is the opposite of what the
    // `source_vendor` column was added for.
    .upsert(payload, { onConflict: 'source_vendor,algorithm,version,instrument,risk_level,month' })
    .select();
  if (error) throw new Error(error.message);
  return (data || []).map(algorithmBenchmarkFromRow);
}
