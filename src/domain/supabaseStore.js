import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { normalizeSubscriptionPrice } from './subscriptionPrice';

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
    payoutHistory: [],
  };
}

function strategyFromRow(row) {
  const params = row.params_parsed && typeof row.params_parsed === 'object'
    ? row.params_parsed
    : {};
  return {
    id: row.id,
    strategyName: row.strategy_name || '',
    strategyFamily: row.strategy_family || '',
    strategyVersion: row.strategy_version || '',
    instrument: row.instrument || '',
    dataSeries: row.data_series || '',
    parametersRaw: row.parameters_raw || '',
    params,
    direction: row.direction || params.direction || '',
    enabled: Boolean(row.enabled),
    realized: Number(row.realized || 0),
    unrealized: Number(row.unrealized || 0),
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

// Supabase/PostgREST caps an unbounded select at 1000 rows. Without pagination a
// team with many accounts (including dead ones), snapshots, orders or executions
// would silently load only the first 1000 rows of each table — dropping whole
// clients, their assignments, or their history. Page through with a stable order
// (id) so every table loads in full.
async function loadTable(table, columns = '*') {
  const pageSize = 1000;
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    reportError(table, error);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

export async function loadSupabaseCrmState({ preferredCamProfileId = null } = {}) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

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
  ] = await Promise.all([
    loadTable('cam_profiles'),
    loadTable('clients'),
    loadTable('client_assignments'),
    loadTable('trading_accounts'),
    loadTable('payout_events'),
    loadTable('client_credentials'),
    loadTable('client_prop_firms'),
    loadTable('daily_imports'),
    loadTable('account_snapshots'),
    loadTable('strategy_snapshots'),
    loadTable('orders'),
    loadTable('executions'),
    loadTable('operational_flags'),
    loadTable('tasks'),
    loadTable('activity_logs'),
    loadTable('price_checks'),
  ]);

  const visibleClientRows = (clientRows || []).filter((client) => (
    !client.deleted_at && client.status !== 'Inactive'
  ));
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
    const mapped = strategyFromRow(strategy);
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
      .map((dailyImport) => ({
        id: dailyImport.legacy_key || dailyImport.id,
        clientId: pickId(client),
        date: dailyImport.trading_date,
        importedAt: dailyImport.imported_at,
        status: dailyImport.status,
        sourceSummary: dailyImport.source_summary || {},
        accounts: accountRegistry,
        snapshots: snapshotsByImport[dailyImport.id] || [],
        strategies: strategiesByImport[dailyImport.id] || [],
        orders: ordersByImport[dailyImport.id] || [],
        executions: executionsByImport[dailyImport.id] || [],
        flags: flagsByImport[dailyImport.id] || [],
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    return {
      id: pickId(client),
      name: client.name,
      status: client.status || 'Active',
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

  return {
    dataSource: 'supabase',
    accountManager: {
      id: preferredCam?.id || '',
      name: preferredCam?.name || 'Unassigned',
    },
    camProfiles,
    clients,
    selectedClientId,
  };
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
    status: 'status',
    payoutState: 'payout_state',
    riskLevel: 'risk_level',
    bulletBotPassType: 'bullet_bot_pass_type',
    bulletBotDirection: 'bullet_bot_direction',
    algoStack: 'algo_stack',
    dailyLossLimit: 'daily_loss_limit',
    notes: 'notes',
  };

  for (const [appField, dbField] of Object.entries(fieldMap)) {
    if (appField in patch) mapped[dbField] = patch[appField] ?? '';
  }

  if ('startBalance' in patch) mapped.start_balance = numberOrNull(patch.startBalance);
  if ('targetProfit' in patch) mapped.target_profit = numberOrNull(patch.targetProfit);
  if ('maxDrawdownLimit' in patch) mapped.max_drawdown_limit = numberOrNull(patch.maxDrawdownLimit);
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
    name: client.name,
    status: client.status || 'Active',
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
    clientIds: [],
  };
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

  const { data, error } = await supabase
    .from('clients')
    .update(dbPatch)
    .eq('id', clientUuid)
    .select()
    .single();
  if (error) throw new Error(error.message);

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
    status: meta.status || 'Active',
    payout_state: meta.payoutState || 'Not requested',
    start_balance: numberOrNull(meta.startBalance),
    target_profit: numberOrNull(meta.targetProfit),
    max_drawdown_limit: numberOrNull(meta.maxDrawdownLimit),
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

export async function updateSupabaseOperationalFlag(flagId, status) {
  if (!isSupabaseConfigured || !supabase) return null;
  const patch = {
    status,
    resolved_at: ['Resolved', 'Acknowledged', 'Ignored'].includes(status) ? new Date().toISOString() : null,
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

export async function upsertSupabaseDailyImport(clientId, importResult) {
  if (!isSupabaseConfigured || !supabase) return null;
  if (!importResult?.date) throw new Error('Import date is required.');

  const clientUuid = await getClientUuid(clientId);
  const accountRows = Object.values(importResult.accounts || {});
  if (accountRows.length) {
    const accountUpserts = accountRows.map((meta) => ({
      client_id: clientUuid,
      legacy_key: meta.accountName || meta.alias || `account-${Date.now()}`,
      account_name: meta.accountName,
      alias: meta.alias || meta.accountName,
      connection: meta.connection || '',
      account_type: meta.accountType || 'Unassigned',
      status: meta.status || 'Active',
      payout_state: meta.payoutState || 'Not requested',
      start_balance: numberOrNull(meta.startBalance),
      target_profit: numberOrNull(meta.targetProfit),
      max_drawdown_limit: numberOrNull(meta.maxDrawdownLimit),
      bullet_bot_pass_type: meta.bulletBotPassType || '',
      bullet_bot_direction: meta.bulletBotDirection || '',
      notes: meta.notes || '',
      date_added: emptyToNull(meta.dateAdded),
      date_funded: emptyToNull(meta.dateFunded),
      date_failed: emptyToNull(meta.dateFailed),
      date_last_payout: emptyToNull(meta.dateLastPayout),
      payout_count: numberOrNull(meta.payoutCount) || 0,
      updated_at: new Date().toISOString(),
    }));
    const { error: accountError } = await supabase
      .from('trading_accounts')
      .upsert(accountUpserts, { onConflict: 'client_id,account_name' });
    if (accountError) throw new Error(accountError.message);
  }

  const { data: accounts, error: accountsError } = await supabase
    .from('trading_accounts')
    .select('id, account_name')
    .eq('client_id', clientUuid);
  if (accountsError) throw new Error(accountsError.message);
  const accountByName = Object.fromEntries((accounts || []).map((account) => [
    String(account.account_name || '').toLowerCase(),
    account,
  ]));

  const { data: dailyImport, error: importError } = await supabase
    .from('daily_imports')
    .upsert({
      client_id: clientUuid,
      legacy_key: importResult.id || `${clientId}-${importResult.date}`,
      trading_date: importResult.date,
      imported_at: importResult.importedAt || new Date().toISOString(),
      status: importResult.status || 'Needs review',
      source_summary: {
        accounts: (importResult.snapshots || []).length,
        strategies: (importResult.strategies || []).length,
        orders: (importResult.orders || []).length,
        executions: (importResult.executions || []).length,
        flags: (importResult.flags || []).length,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_id,trading_date' })
    .select()
    .single();
  if (importError) throw new Error(importError.message);

  // Re-uploading a close replaces its detail rows. Guard against a partial or
  // mis-parsed file silently wiping a good prior close for this date: only clear a
  // detail table when the new file actually carries rows for it — an empty section
  // (e.g. the orders export missing) keeps the previous data instead of deleting
  // it. account_snapshots is handled separately below via upsert (not delete), so
  // a file with fewer accounts updates only those and never blanks the rest.
  // Flags are derived, so they are always refreshed to reflect the latest close.
  const childRowCounts = {
    strategy_snapshots: (importResult.strategies || []).length,
    orders: (importResult.orders || []).length,
    executions: (importResult.executions || []).length,
  };
  const childTables = ['strategy_snapshots', 'orders', 'executions', 'operational_flags'];
  for (const table of childTables) {
    if (table !== 'operational_flags' && !childRowCounts[table]) continue;
    const { error } = await supabase.from(table).delete().eq('daily_import_id', dailyImport.id);
    if (error) throw new Error(error.message);
  }

  const snapshotRows = (importResult.snapshots || []).map((snapshot) => {
    const account = accountByName[String(snapshot.accountName || '').toLowerCase()];
    return {
      daily_import_id: dailyImport.id,
      trading_account_id: account?.id || null,
      account_name: snapshot.accountName || '',
      connection: snapshot.connection || '',
      gross_realized_pnl: numberOrNull(snapshot.grossRealizedPnl) || 0,
      trailing_max_drawdown: numberOrNull(snapshot.trailingMaxDrawdown) || 0,
      account_balance: numberOrNull(snapshot.accountBalance) || 0,
      weekly_pnl: numberOrNull(snapshot.weeklyPnl) || 0,
      unrealized_pnl: numberOrNull(snapshot.unrealizedPnl) || 0,
    };
  });

  let snapshotByName = {};
  if (snapshotRows.length) {
    // Upsert (not delete+insert) on the (daily_import_id, account_name) unique
    // constraint so re-uploading a date with fewer accounts updates only those
    // and leaves the other accounts' snapshots for the day intact — never zeros.
    const { data, error } = await supabase
      .from('account_snapshots')
      .upsert(snapshotRows, { onConflict: 'daily_import_id,account_name' })
      .select();
    if (error) throw new Error(error.message);
    snapshotByName = Object.fromEntries((data || []).map((snapshot) => [
      String(snapshot.account_name || '').toLowerCase(),
      snapshot,
    ]));
  }

  const strategyRows = (importResult.strategies || []).map((strategy) => {
    const account = accountByName[String(strategy.accountName || '').toLowerCase()];
    const snapshot = snapshotByName[String(strategy.accountName || '').toLowerCase()];
    return {
      daily_import_id: dailyImport.id,
      trading_account_id: account?.id || null,
      account_snapshot_id: snapshot?.id || null,
      strategy_name: strategy.strategyName || '',
      strategy_family: strategy.strategyFamily || '',
      strategy_version: strategy.strategyVersion || '',
      instrument: strategy.instrument || '',
      data_series: strategy.dataSeries || '',
      parameters_raw: strategy.parametersRaw || '',
      params_parsed: strategy.params || {},
      direction: strategy.direction || '',
      enabled: Boolean(strategy.enabled),
      realized: numberOrNull(strategy.realized) || 0,
      unrealized: numberOrNull(strategy.unrealized) || 0,
    };
  });
  if (strategyRows.length) {
    const { error } = await supabase.from('strategy_snapshots').insert(strategyRows);
    if (error) throw new Error(error.message);
  }

  const orderRows = (importResult.orders || []).map((order) => {
    const account = accountByName[String(order.accountName || '').toLowerCase()];
    return {
      daily_import_id: dailyImport.id,
      trading_account_id: account?.id || null,
      external_order_id: order.id || '',
      strategy_name: order.strategyName || '',
      instrument: order.instrument || '',
      action: order.action || '',
      order_type: order.orderType || '',
      quantity: numberOrNull(order.quantity),
      limit_price: numberOrNull(order.limit),
      stop_price: numberOrNull(order.stop),
      state: order.state || '',
      filled: numberOrNull(order.filled),
      avg_price: numberOrNull(order.avgPrice),
      remaining: numberOrNull(order.remaining),
      name: order.name || '',
      time_text: order.time || '',
    };
  });
  if (orderRows.length) {
    const { error } = await supabase.from('orders').insert(orderRows);
    if (error) throw new Error(error.message);
  }

  const executionRows = (importResult.executions || []).map((execution) => {
    const account = accountByName[String(execution.accountName || '').toLowerCase()];
    return {
      daily_import_id: dailyImport.id,
      trading_account_id: account?.id || null,
      external_execution_id: execution.id || '',
      external_order_id: execution.orderId || '',
      strategy_name: execution.strategyName || '',
      instrument: execution.instrument || '',
      action: execution.action || '',
      quantity: numberOrNull(execution.quantity),
      price: numberOrNull(execution.price),
      time_text: execution.time || '',
      entry_exit: execution.entryExit || '',
      position: execution.position || '',
      name: execution.name || '',
      commission: numberOrNull(execution.commission),
      rate: numberOrNull(execution.rate),
      connection: execution.connection || '',
    };
  });
  if (executionRows.length) {
    const { error } = await supabase.from('executions').insert(executionRows);
    if (error) throw new Error(error.message);
  }

  const flagRows = (importResult.flags || []).map((flag) => {
    const account = accountByName[String(flag.accountName || '').toLowerCase()];
    return {
      daily_import_id: dailyImport.id,
      client_id: clientUuid,
      trading_account_id: account?.id || null,
      type: flag.type,
      severity: flag.severity || 'Warning',
      message: flag.message || '',
      status: flag.status || 'Open',
    };
  });
  if (flagRows.length) {
    const { error } = await supabase.from('operational_flags').insert(flagRows);
    if (error) throw new Error(error.message);
  }

  return dailyImport;
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
