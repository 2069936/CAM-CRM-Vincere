import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

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
    configMatch: row.config_match || {},
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

function flagFromRow(row, accountById) {
  const account = accountById[row.trading_account_id] || null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    accountName: account?.account_name || '',
    message: row.message,
    status: row.status || 'Open',
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
  };
}

function priceCheckFromRow(row) {
  return {
    id: row.id,
    date: row.check_date || '',
    instrument: row.instrument || '',
    time: row.time_label || '',
    price: row.price ?? '',
    connectionStatus: row.connection_status || '',
    algoStatus: row.algo_status || '',
    notes: row.notes || '',
  };
}

function reportError(label, error) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function loadTable(table, columns = '*') {
  const { data, error } = await supabase.from(table).select(columns);
  reportError(table, error);
  return data || [];
}

export async function loadSupabaseCrmState({ preferredCamProfileId = 'am-pedro' } = {}) {
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
    importRows,
    snapshotRows,
    strategyRows,
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
    loadTable('daily_imports'),
    loadTable('account_snapshots'),
    loadTable('strategy_snapshots'),
    loadTable('executions'),
    loadTable('operational_flags'),
    loadTable('tasks'),
    loadTable('activity_logs'),
    loadTable('price_checks'),
  ]);

  const clientByUuid = byId(clientRows);
  const accountByUuid = byId(accountRows);
  const accountByClient = {};
  const payoutsByAccount = {};
  const credentialsByClient = {};
  const importsByClient = {};
  const snapshotsByImport = {};
  const strategiesBySnapshot = {};
  const strategiesByImport = {};
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
    clientIds: assignmentRows
      .filter((assignment) => assignment.cam_profile_id === cam.id)
      .map((assignment) => pickId(clientByUuid[assignment.client_id] || { id: assignment.client_id })),
  }));

  const camByPublicId = byLegacy(camProfiles);
  const preferredCam = camByPublicId[preferredCamProfileId] || camProfiles[0] || null;

  const clients = clientRows.map((client) => {
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
        orders: [],
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
        propFirm: client.prop_firm || '',
        messenger: client.messenger || '',
      },
      credentials: {
        ip: credential.ip || '',
        username: credential.username || '',
        password: credential.password_encrypted || '',
        ntLogin: credential.nt_login || '',
        firmLogin: credential.firm_login || '',
        firmPassword: credential.firm_password_encrypted || '',
        notes: credential.notes || '',
      },
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
    demoVersion: 0,
    dataSource: 'supabase',
    accountManager: {
      id: preferredCam?.id || 'am-pedro',
      name: preferredCam?.name || 'Pedro',
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
    'executions',
    'operational_flags',
    'sop_templates',
    'sop_sections',
    'sop_items',
    'tasks',
    'activity_logs',
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

function accountPatchToDb(patch = {}) {
  const mapped = {};
  const fieldMap = {
    alias: 'alias',
    connection: 'connection',
    accountType: 'account_type',
    status: 'status',
    payoutState: 'payout_state',
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
      status: 'Open',
      resolved_at: null,
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
