export const DAILY_IMPORT_CLOSED_CODE = 'daily_import_closed';

/**
 * @typedef {Object} DailyImportPersistenceAdapter
 * @property {boolean} [supportsDailyImportSourceColumns]
 * @property {(work: (tx: DailyImportPersistenceTransaction) => Promise<unknown>) => Promise<unknown>} transaction
 */

/**
 * Transaction-scoped persistence operations required by persistDailyImportWithClient.
 * A server adapter should make these operations atomic.
 *
 * @typedef {Object} DailyImportPersistenceTransaction
 * @property {(clientUuid: string, tradingDate: string) => Promise<Object|null>} findDailyImportByClientAndDate
 * @property {(rows: Object[]) => Promise<void>} upsertTradingAccounts
 * @property {(clientUuid: string) => Promise<Object[]>} listTradingAccounts
 * @property {(row: Object) => Promise<Object>} upsertDailyImport
 * @property {(table: string, dailyImportId: string) => Promise<void>} deleteDailyImportRows
 * @property {(rows: Object[]) => Promise<Object[]>} upsertAccountSnapshots
 * @property {(table: string, rows: Object[]) => Promise<void>} insertRows
 */

export class DailyImportClosedError extends Error {
  constructor(tradingDate) {
    super(`Daily import is closed for ${tradingDate}.`);
    this.name = 'DailyImportClosedError';
    this.code = DAILY_IMPORT_CLOSED_CODE;
    this.status = 409;
    this.statusCode = 409;
  }
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrLegacyZero(value) {
  if (value === null) return null;
  return numberOrNull(value) ?? 0;
}

function emptyToNull(value) {
  return value === '' || value == null ? null : value;
}

function indexByAccountName(rows) {
  return Object.fromEntries((rows || []).map((row) => [
    String(row.account_name || '').toLowerCase(),
    row,
  ]));
}

function accountIdFor(accountByName, accountName) {
  return accountByName[String(accountName || '').toLowerCase()]?.id || null;
}

function mapTradingAccount(meta, clientUuid) {
  return {
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
    payout_count: numberOrLegacyZero(meta.payoutCount),
    updated_at: new Date().toISOString(),
  };
}

function mapAccountSnapshot(snapshot, dailyImportId, accountByName) {
  return {
    daily_import_id: dailyImportId,
    trading_account_id: accountIdFor(accountByName, snapshot.accountName),
    account_name: snapshot.accountName || '',
    connection: snapshot.connection || '',
    gross_realized_pnl: numberOrLegacyZero(snapshot.grossRealizedPnl),
    trailing_max_drawdown: numberOrLegacyZero(snapshot.trailingMaxDrawdown),
    account_balance: numberOrLegacyZero(snapshot.accountBalance),
    weekly_pnl: numberOrLegacyZero(snapshot.weeklyPnl),
    unrealized_pnl: numberOrLegacyZero(snapshot.unrealizedPnl),
  };
}

function mapStrategy(strategy, dailyImportId, accountByName, snapshotByName) {
  const accountName = String(strategy.accountName || '').toLowerCase();
  return {
    daily_import_id: dailyImportId,
    trading_account_id: accountByName[accountName]?.id || null,
    account_snapshot_id: snapshotByName[accountName]?.id || null,
    strategy_name: strategy.strategyName || '',
    strategy_family: strategy.strategyFamily || '',
    strategy_version: strategy.strategyVersion || '',
    instrument: strategy.instrument || '',
    data_series: strategy.dataSeries || '',
    parameters_raw: strategy.parametersRaw || '',
    params_parsed: strategy.params || {},
    direction: strategy.direction || '',
    enabled: Boolean(strategy.enabled),
    realized: numberOrLegacyZero(strategy.realized),
    unrealized: numberOrLegacyZero(strategy.unrealized),
  };
}

function mapOrder(order, dailyImportId, accountByName) {
  return {
    daily_import_id: dailyImportId,
    trading_account_id: accountIdFor(accountByName, order.accountName),
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
}

function mapExecution(execution, dailyImportId, accountByName) {
  return {
    daily_import_id: dailyImportId,
    trading_account_id: accountIdFor(accountByName, execution.accountName),
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
}

function mapFlag(flag, dailyImportId, clientUuid, accountByName) {
  return {
    daily_import_id: dailyImportId,
    client_id: clientUuid,
    trading_account_id: accountIdFor(accountByName, flag.accountName),
    type: flag.type,
    severity: flag.severity || 'Warning',
    message: flag.message || '',
    status: flag.status || 'Open',
  };
}

function makeDailyImportRow({ clientUuid, importResult, sourceBatchId, supportsSourceColumns }) {
  const sourceSummary = {
    accounts: (importResult.snapshots || []).length,
    strategies: (importResult.strategies || []).length,
    orders: (importResult.orders || []).length,
    executions: (importResult.executions || []).length,
    flags: (importResult.flags || []).length,
  };
  if (sourceBatchId) {
    sourceSummary.source_type = 'automatic';
    sourceSummary.source_batch_id = sourceBatchId;
  }

  const row = {
    client_id: clientUuid,
    legacy_key: importResult.id || `${clientUuid}-${importResult.date}`,
    trading_date: importResult.date,
    imported_at: importResult.importedAt || new Date().toISOString(),
    status: importResult.status || 'Needs review',
    source_summary: sourceSummary,
    updated_at: new Date().toISOString(),
  };
  if (sourceBatchId && supportsSourceColumns) {
    row.source_type = 'automatic';
    row.source_batch_id = sourceBatchId;
  }
  return row;
}

/**
 * Persists one normalized daily import through a caller-provided database adapter.
 * The function does not import or access a global database client.
 *
 * @param {{
 *   db: DailyImportPersistenceAdapter,
 *   clientUuid: string,
 *   importResult: Object,
 *   sourceBatchId?: string,
 * }} options
 * @returns {Promise<Object>}
 */
export async function persistDailyImportWithClient({ db, clientUuid, importResult, sourceBatchId }) {
  if (!importResult?.date) throw new Error('Import date is required.');
  if (!String(clientUuid || '').trim()) throw new Error('Client UUID is required.');

  return db.transaction(async (tx) => {
    const existingImport = await tx.findDailyImportByClientAndDate(clientUuid, importResult.date);
    if (existingImport?.status === 'Closed') {
      throw new DailyImportClosedError(importResult.date);
    }

    const accountRows = Object.values(importResult.accounts || {})
      .map((meta) => mapTradingAccount(meta, clientUuid));
    if (accountRows.length) await tx.upsertTradingAccounts(accountRows);

    const accounts = await tx.listTradingAccounts(clientUuid);
    const accountByName = indexByAccountName(accounts);
    const dailyImport = await tx.upsertDailyImport(makeDailyImportRow({
      clientUuid,
      importResult,
      sourceBatchId,
      supportsSourceColumns: db.supportsDailyImportSourceColumns === true,
    }));

    const sections = [
      ['strategy_snapshots', importResult.strategies || []],
      ['orders', importResult.orders || []],
      ['executions', importResult.executions || []],
    ];
    for (const [table, rows] of sections) {
      if (rows.length) await tx.deleteDailyImportRows(table, dailyImport.id);
    }
    await tx.deleteDailyImportRows('operational_flags', dailyImport.id);

    const snapshotRows = (importResult.snapshots || [])
      .map((snapshot) => mapAccountSnapshot(snapshot, dailyImport.id, accountByName));
    const savedSnapshots = snapshotRows.length
      ? await tx.upsertAccountSnapshots(snapshotRows)
      : [];
    const snapshotByName = indexByAccountName(savedSnapshots);

    const strategyRows = (importResult.strategies || [])
      .map((strategy) => mapStrategy(strategy, dailyImport.id, accountByName, snapshotByName));
    if (strategyRows.length) await tx.insertRows('strategy_snapshots', strategyRows);

    const orderRows = (importResult.orders || [])
      .map((order) => mapOrder(order, dailyImport.id, accountByName));
    if (orderRows.length) await tx.insertRows('orders', orderRows);

    const executionRows = (importResult.executions || [])
      .map((execution) => mapExecution(execution, dailyImport.id, accountByName));
    if (executionRows.length) await tx.insertRows('executions', executionRows);

    const flagRows = (importResult.flags || [])
      .map((flag) => mapFlag(flag, dailyImport.id, clientUuid, accountByName));
    if (flagRows.length) await tx.insertRows('operational_flags', flagRows);

    return dailyImport;
  });
}
