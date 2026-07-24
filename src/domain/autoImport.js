import { normalizeStrategyFamily, parseStrategyVersion } from './csvImport.js';
import { validateAutoExportSnapshot } from './autoExportContract.js';

const SECTION_NAMES = ['accounts', 'strategies', 'orders', 'executions'];

export class AutoImportValidationError extends Error {
  constructor(code, errors) {
    super(errors.join('; ') || code);
    this.name = 'AutoImportValidationError';
    this.code = code;
    this.errors = errors;
  }
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDirection(value) {
  const text = trimText(value);
  if (/^(long|short|both)$/i.test(text)) return `${text[0].toUpperCase()}${text.slice(1).toLowerCase()}`;
  return text;
}

function parseParamNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberList(values) {
  return values.map(parseParamNumber).filter((value) => value != null);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function mapParameters(parameters) {
  const valuesByName = { ...parameters };
  const direction = normalizeDirection(valuesByName.MyTradeDirection);
  return {
    parsed: true,
    valuesByName,
    direction,
    posSizes: numberList([
      valuesByName.PosSize1,
      valuesByName.PosSize2,
      valuesByName.PosSize3,
      valuesByName.PositionSize,
    ]),
    profitTargets: numberList([
      valuesByName.ProfitTargetTicks1,
      valuesByName.ProfitTargetTicks2,
      valuesByName.ProfitTargetTicks3,
      valuesByName.ProfitTargetTicks,
    ]),
    stopLossTicks: parseParamNumber(valuesByName.StopLossTicks),
    tradeWindow: [
      valuesByName.TradeStartTime || valuesByName.TradeStart1 || '',
      valuesByName.TradeEndTime || valuesByName.TradeEnd1 || '',
    ],
  };
}

export function selectDailyPnl({ realizedPnl, grossRealizedPnl }) {
  if (realizedPnl === null) {
    if (grossRealizedPnl === null) return { value: null, source: 'unavailable' };
    return { value: grossRealizedPnl, source: 'gross_missing_realized' };
  }
  if (realizedPnl !== 0) return { value: realizedPnl, source: 'realized' };
  if (grossRealizedPnl !== null && grossRealizedPnl !== 0) return { value: grossRealizedPnl, source: 'gross_fallback' };
  return { value: 0, source: 'realized' };
}

function duplicateErrors(snapshot) {
  const errors = [];
  const duplicateBy = (section, field, comparable = (value) => value) => {
    const firstIndex = new Map();
    snapshot[section].forEach((row, index) => {
      const key = comparable(trimText(row[field]));
      if (firstIndex.has(key)) {
        errors.push(`${section}[${index}].${field} duplicates ${section}[${firstIndex.get(key)}].${field}`);
      } else {
        firstIndex.set(key, index);
      }
    });
  };

  duplicateBy('accounts', 'accountName', (value) => value.toLowerCase());
  duplicateBy('strategies', 'strategyId');
  duplicateBy('orders', 'orderId');
  duplicateBy('executions', 'executionId');
  return errors;
}

function accountReferenceErrors(snapshot) {
  const accountsByLower = new Set(snapshot.accounts.map((account) => trimText(account.accountName).toLowerCase()));
  const errors = [];
  for (const section of ['strategies', 'orders', 'executions']) {
    snapshot[section].forEach((row, index) => {
      if (!accountsByLower.has(trimText(row.accountName).toLowerCase())) {
        errors.push(`${section}[${index}].accountName does not reference an account`);
      }
    });
  }
  return errors;
}

function canonicalAccountName(accountName, accountNamesByLower) {
  return accountNamesByLower.get(trimText(accountName).toLowerCase()) || trimText(accountName);
}

function mapAccount(row) {
  const pnl = selectDailyPnl(row);
  return {
    connectionStatus: row.status,
    connection: trimText(row.connectionName),
    accountName: trimText(row.accountName),
    grossRealizedPnl: pnl.value,
    selectedPnl: pnl.value,
    realizedPnl: row.realizedPnl,
    rawRealizedPnl: row.realizedPnl,
    rawGrossRealizedPnl: row.grossRealizedPnl,
    pnlSource: pnl.source,
    trailingMaxDrawdown: row.trailingMaxDrawdown,
    accountBalance: row.cashValue,
    weeklyPnl: row.weeklyPnl,
    unrealizedPnl: row.unrealizedPnl,
  };
}

function mapStrategy(row, connectionByAccount, accountNamesByLower) {
  const params = mapParameters(row.parameters);
  const accountName = canonicalAccountName(row.accountName, accountNamesByLower);
  return {
    id: trimText(row.strategyId),
    strategyName: trimText(row.strategyName),
    strategyFamily: normalizeStrategyFamily(row.strategyName),
    strategyVersion: parseStrategyVersion(row.strategyName),
    instrument: trimText(row.instrument),
    accountName,
    dataSeries: trimText(row.dataSeries),
    parametersRaw: stableJson(row.parameters),
    params,
    direction: params.direction,
    unrealized: row.unrealizedPnl,
    realized: row.realizedPnl,
    connection: trimText(row.connectionName) || connectionByAccount.get(accountName) || '',
    enabled: row.enabled,
    sync: row.sync,
    state: row.state,
    position: row.position,
    averagePrice: row.averagePrice,
    startedAt: row.startedAt,
    parameterCaptureStatus: row.parameterCaptureStatus,
  };
}

function mapOrder(row, accountNamesByLower) {
  return {
    instrument: trimText(row.instrument),
    action: trimText(row.action),
    orderType: trimText(row.orderType),
    quantity: row.quantity,
    limit: row.limitPrice,
    stop: row.stopPrice,
    state: trimText(row.state),
    filled: row.filled,
    avgPrice: row.averageFillPrice,
    remaining: row.remaining,
    name: row.name || '',
    strategyName: row.strategyName || '',
    strategyId: trimText(row.strategyId),
    accountName: canonicalAccountName(row.accountName, accountNamesByLower),
    id: trimText(row.orderId),
    time: row.time,
    tif: row.tif,
    oco: row.oco,
    nativeId: row.nativeId,
  };
}

function mapExecution(row, accountNamesByLower) {
  return {
    instrument: trimText(row.instrument),
    action: trimText(row.action),
    quantity: row.quantity,
    price: row.price,
    time: row.time,
    id: trimText(row.executionId),
    entryExit: trimText(row.entryExit),
    position: row.marketPosition || '',
    orderId: trimText(row.orderId),
    name: row.name || '',
    strategyId: trimText(row.strategyId),
    strategyName: row.strategyName || '',
    commission: row.commission,
    fee: row.fee,
    rate: row.rate,
    realizedPnl: row.realizedPnl,
    accountName: canonicalAccountName(row.accountName, accountNamesByLower),
    connection: trimText(row.connectionName),
    nativeId: row.nativeId,
  };
}

function validationError(snapshot) {
  const validation = validateAutoExportSnapshot(snapshot);
  const errors = [...validation.errors];
  if (validation.ok) errors.push(...duplicateErrors(snapshot), ...accountReferenceErrors(snapshot));
  if (!errors.length) return null;

  const unsupported = snapshot && typeof snapshot === 'object'
    && Object.prototype.hasOwnProperty.call(snapshot, 'schemaVersion')
    && snapshot.schemaVersion !== 1;
  return new AutoImportValidationError(unsupported ? 'unsupported_schema_version' : 'invalid_auto_import_snapshot', errors);
}

export function normalizeAutoImportSnapshot(snapshot) {
  const error = validationError(snapshot);
  if (error) throw error;

  const accountNamesByLower = new Map(snapshot.accounts.map((account) => {
    const accountName = trimText(account.accountName);
    return [accountName.toLowerCase(), accountName];
  }));
  const connectionByAccount = new Map(snapshot.accounts.map((account) => [trimText(account.accountName), trimText(account.connectionName)]));
  const parsed = {
    accounts: snapshot.accounts.map(mapAccount),
    strategies: snapshot.strategies.map((row) => mapStrategy(row, connectionByAccount, accountNamesByLower)),
    orders: snapshot.orders.map((row) => mapOrder(row, accountNamesByLower)),
    executions: snapshot.executions.map((row) => mapExecution(row, accountNamesByLower)),
  };
  const sectionCounts = Object.fromEntries(SECTION_NAMES.map((section) => [section, snapshot[section].length]));
  const emptySections = SECTION_NAMES.filter((section) => sectionCounts[section] === 0);
  const accountPnl = Object.fromEntries(parsed.accounts.map((account) => [account.accountName, {
    realizedPnl: account.rawRealizedPnl,
    grossRealizedPnl: account.rawGrossRealizedPnl,
    selectedPnl: account.selectedPnl,
    pnlSource: account.pnlSource,
  }]));

  return {
    date: snapshot.tradingDate,
    parsed,
    metadata: {
      captureId: snapshot.captureId,
      capturedAt: snapshot.capturedAt,
      timeZone: snapshot.timeZone,
      source: snapshot.source,
      sectionCounts,
      missingSections: [],
      emptySections,
      isComplete: emptySections.length === 0,
      accountPnl,
    },
  };
}
