import { openPositionsAt } from './openPositions.js';
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

/* NAMES THE ACCOUNT, AND NAMES IT ONCE.
 *
 * This used to report one error per offending row, saying only
 * "strategies[0].accountName does not reference an account". A CAM handed that
 * about a file they cannot open learns nothing: not which account, and not
 * whether it is one account or forty rows of the same one. On a real close a
 * single dropped account produces hundreds of those lines.
 *
 * The cause it is usually reporting is a capture that read the account list
 * more than once while a connection was reconnecting, so the close carried rows
 * for an account the accounts section had already dropped. The account name is
 * the one fact that identifies which one flapped.
 *
 * Row indexes are kept for the first few, because "which row" is still what you
 * want when the name itself looks right and the mismatch is whitespace. */
const REFERENCE_ERROR_ROW_SAMPLE = 3;

function accountReferenceErrors(snapshot) {
  const accountsByLower = new Set(snapshot.accounts.map((account) => trimText(account.accountName).toLowerCase()));
  const errors = [];
  for (const section of ['strategies', 'orders', 'executions']) {
    const offending = new Map();
    snapshot[section].forEach((row, index) => {
      const name = trimText(row.accountName);
      if (accountsByLower.has(name.toLowerCase())) return;
      if (!offending.has(name)) offending.set(name, []);
      offending.get(name).push(index);
    });
    for (const [name, indexes] of offending) {
      const shown = indexes.slice(0, REFERENCE_ERROR_ROW_SAMPLE).join(', ');
      const more = indexes.length > REFERENCE_ERROR_ROW_SAMPLE
        ? ` and ${indexes.length - REFERENCE_ERROR_ROW_SAMPLE} more`
        : '';
      errors.push(
        `${section}[${shown}]${more}.accountName does not reference an account`
        + ` (${name === '' ? 'blank' : name})`,
      );
    }
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
    // The gross figure under the name the derivation looks for, so an
    // automatically collected close reconciles the same way a manually uploaded
    // one does. `grossRealizedPnl` above is selectDailyPnl's blend and prefers
    // the commission-NETTED realized figure; FIFO reproduces gross, so gating on
    // the blend would reject nearly every account on this path only.
    grossRealizedPnlReported: row.grossRealizedPnl ?? null,
    pnlSource: pnl.source,
    trailingMaxDrawdown: row.trailingMaxDrawdown,
    // Left undefined when the collector did not report it. Do NOT default this
    // to false: false asserts "this is live money" and would outrank the Sim<n>
    // name test, putting simulated balances back into the desk total on every
    // automatically collected client.
    isSimulated: typeof row.isSimulated === 'boolean' ? row.isSimulated : undefined,
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

/* NINJATRADER LISTS A STRATEGY TWICE, AND THAT USED TO COST THE WHOLE DAY.
 *
 * On 2026-09-14 the desk enabled RBO on one of Todd Grehl's accounts in the
 * morning. Every capture that day, including the 16:30 close, carried the
 * strategy twice under the same strategyId: NinjaTrader keeps the previous
 * instance in account.Strategies beside the live one for a while after an
 * enable, the first with no position and the second with the real one. The
 * duplicate check here read that as a corrupt file, the CRM answered 422, the
 * agent quarantined all four captures, and the first RBO day never reached
 * anyone. The same thing took Yousef Asaad's close on 2026-09-17.
 *
 * A duplicate strategy row is NinjaTrader's state, not our data going wrong,
 * and strategies carry no money. So the strategies section is repaired before
 * validation: one row per strategyId, keeping the one that knows its position
 * (or the later one when neither does), and a strategy row whose account is
 * not in the accounts section is dropped rather than fatal, for the same
 * reason: the accounts, orders and executions are what the close is made of.
 * What was dropped is written into the metadata so it can be seen, and
 * orders and executions stay as strict as they were: a duplicate execution
 * or an execution on an unknown account is still a refusal. */
function strategyRowScore(row) {
  const position = trimText(row.position);
  const state = trimText(row.state).toLowerCase();
  return (position && position.toLowerCase() !== 'null' ? 2 : 0) + (/realtime|active|running/.test(state) ? 1 : 0);
}

function repairStrategies(snapshot) {
  // A close with no accounts at all is not a close with a flapping strategy
  // row; it is a capture that lost its account list. Left unrepaired, the
  // reference check below refuses it as before, so it can never replace a
  // real close of the same day with an empty one.
  if (snapshot.accounts.length === 0 && snapshot.strategies.length > 0) {
    return { snapshot, repairs: null };
  }
  const accountsByLower = new Set(snapshot.accounts.map((account) => trimText(account.accountName).toLowerCase()));
  const keptByStrategyId = new Map();
  const duplicateStrategyIds = new Set();
  const unknownAccounts = new Set();
  const order = [];
  let unknownAccountRowsDropped = 0;
  let duplicateRowsDropped = 0;
  for (const row of snapshot.strategies) {
    const accountName = trimText(row.accountName);
    if (!accountsByLower.has(accountName.toLowerCase())) {
      unknownAccounts.add(accountName === '' ? '(blank)' : accountName);
      unknownAccountRowsDropped += 1;
      continue;
    }
    const key = trimText(row.strategyId);
    const current = keptByStrategyId.get(key);
    if (!current) {
      keptByStrategyId.set(key, row);
      order.push(key);
      continue;
    }
    duplicateStrategyIds.add(key);
    duplicateRowsDropped += 1;
    // The later row wins a tie: NinjaTrader appends the live instance after
    // the one it is retiring.
    if (strategyRowScore(row) >= strategyRowScore(current)) keptByStrategyId.set(key, row);
  }
  const repairs = {
    strategies: {
      duplicateRowsDropped,
      duplicateStrategyIds: [...duplicateStrategyIds],
      unknownAccountRowsDropped,
      unknownAccounts: [...unknownAccounts],
    },
  };
  const repaired = duplicateRowsDropped || unknownAccountRowsDropped
    ? { ...snapshot, strategies: order.map((key) => keptByStrategyId.get(key)) }
    : snapshot;
  return { snapshot: repaired, repairs };
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

export function normalizeAutoImportSnapshot(rawSnapshot) {
  const structural = validateAutoExportSnapshot(rawSnapshot);
  let snapshot = rawSnapshot;
  let repairs = null;
  if (structural.ok) ({ snapshot, repairs } = repairStrategies(rawSnapshot));
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
      repairs,
      /* A CLOSE TAKEN WHILE THE TRADES WERE STILL OPEN IS NOT A CLOSE.
       *
       * On 2026-09-08 the scheduled capture fired at 16:30:00 and reported
       * -$2,064 for the day. The real number was -$1,319: $745 of it was still
       * unrealized on three accounts whose closing fills landed at 16:32. A
       * capture from the same machine at 18:28 matched the manual export to
       * the dollar.
       *
       * The capture ran two minutes before the desk finished flattening, so
       * moving it later is the cure and it was moved. This is the guard for
       * the day three minutes of margin is not enough, because the failure is
       * silent: asking the snapshot whether anything was still open is not a
       * guess about the clock. */
      openPositions: openPositionsAt(snapshot),
      accountPnl,
    },
  };
}
