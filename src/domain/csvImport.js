import Papa from 'papaparse';

const HEADER_ALIASES = {
  accountname: 'accountName',
  accountdisplayname: 'accountDisplayName',
  action: 'action',
  avgprice: 'avgPrice',
  cashvalue: 'cashValue',
  commission: 'commission',
  connection: 'connection',
  connectionname: 'connectionName',
  connectionstatus: 'connectionStatus',
  dataseries: 'dataSeries',
  displayname: 'displayName',
  enabled: 'enabled',
  ex: 'entryExit',
  filled: 'filled',
  grossrealizedpnl: 'grossRealizedPnl',
  id: 'id',
  instrument: 'instrument',
  limit: 'limit',
  name: 'name',
  oco: 'oco',
  orderid: 'orderId',
  ordertype: 'orderType',
  position: 'position',
  price: 'price',
  parameters: 'parameters',
  quantity: 'quantity',
  rate: 'rate',
  realized: 'realized',
  realizedpnl: 'realizedPnl',
  remaining: 'remaining',
  state: 'state',
  stop: 'stop',
  strategy: 'strategy',
  strategyid: 'strategyId',
  strategyname: 'strategyName',
  tif: 'tif',
  time: 'time',
  trailingmaxdrawdown: 'trailingMaxDrawdown',
  type: 'orderType',
  unrealized: 'unrealized',
  unrealizedpnl: 'unrealizedPnl',
  weeklypnl: 'weeklyPnl',
  limitprice: 'limitPrice',
  stopprice: 'stopPrice',
  averagefillprice: 'averageFillPrice',
  executionid: 'executionId',
  marketposition: 'marketPosition',
};

const KNOWN_FAMILIES = [
  'ARPD',
  'B2X',
  'DJDR',
  'FSA',
  'IFSP',
  'MST',
  'OGX',
  'PLPI',
  'RBO',
  'SYFY',
  'TDC',
  'URGO',
];

export function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function canonicalHeader(header) {
  return HEADER_ALIASES[normalizeHeader(header)] || normalizeHeader(header);
}

export function detectNinjaTraderFileType(headers) {
  const keys = new Set(headers.map(canonicalHeader));
  if (keys.has('displayName') && keys.has('cashValue') && (keys.has('grossRealizedPnl') || keys.has('realizedPnl'))) return 'accounts';
  if ((keys.has('strategy') || keys.has('strategyName')) && (keys.has('accountDisplayName') || keys.has('accountName')) && keys.has('parameters')) return 'strategies';
  if (keys.has('state') && keys.has('orderType') && keys.has('filled') && keys.has('remaining')) return 'orders';
  if ((keys.has('entryExit') || keys.has('executionId')) && keys.has('orderId') && keys.has('price')) return 'executions';
  return 'unknown';
}

export function parseCurrency(value) {
  if (value == null || value === '') return 0;
  let clean = String(value).trim().replace(/[$,]/g, '');
  if (clean.startsWith('(') && clean.endsWith(')')) clean = `-${clean.slice(1, -1)}`;
  const parsed = Number.parseFloat(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBool(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function normalizeDirection(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(long|short|both)$/i.test(text)) return text[0].toUpperCase() + text.slice(1).toLowerCase();
  return text;
}

function inferDirection(parametersRaw) {
  const text = String(parametersRaw || '');
  const licenseAnchored = text.match(/\/V-[^/]+\/(Long|Short|Both)\//i);
  if (licenseAnchored) return normalizeDirection(licenseAnchored[1]);

  const keyList = text.match(/\(([^)]*MyTradeDirection[^)]*)\)$/i);
  if (!keyList) return '';

  const generic = text.match(/\/(Long|Short|Both)\//i);
  return generic ? normalizeDirection(generic[1]) : '';
}

function coalesceDateTokens(tokens) {
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const candidate = `${tokens[index]}/${tokens[index + 1]}/${tokens[index + 2]}`;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M$/i.test(candidate)) {
      result.push(candidate);
      index += 2;
    } else {
      result.push(tokens[index]);
    }
  }
  return result.map((token) => String(token || '').trim());
}

function parseParamNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberList(values) {
  return values.map(parseParamNumber).filter((value) => value != null);
}

export function parseStrategyParameters(parametersRaw) {
  const text = String(parametersRaw || '').trim();
  if (text.startsWith('{')) {
    try {
      const valuesByName = JSON.parse(text);
      if (valuesByName && typeof valuesByName === 'object' && !Array.isArray(valuesByName)) {
        return {
          parsed: true,
          valuesByName,
          direction: normalizeDirection(valuesByName.MyTradeDirection),
          posSizes: numberList([valuesByName.PosSize1, valuesByName.PosSize2, valuesByName.PosSize3, valuesByName.PositionSize]),
          profitTargets: numberList([valuesByName.ProfitTargetTicks1, valuesByName.ProfitTargetTicks2, valuesByName.ProfitTargetTicks3, valuesByName.ProfitTargetTicks]),
          stopLossTicks: parseParamNumber(valuesByName.StopLossTicks),
          tradeWindow: [valuesByName.TradeStartTime || valuesByName.TradeStart1 || '', valuesByName.TradeEndTime || valuesByName.TradeEnd1 || ''],
        };
      }
    } catch {
      // Fall through to NinjaTrader's slash-delimited parameter syntax.
    }
  }
  const match = text.match(/^(.*)\s+\(([^)]*)\)$/);
  if (!match) return { parsed: false };

  const names = match[2].split('/').map((name) => name.trim()).filter(Boolean);
  const values = coalesceDateTokens(match[1].split('/'));
  if (!names.length || values.length !== names.length) return { parsed: false };

  const valuesByName = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const direction = normalizeDirection(valuesByName.MyTradeDirection);
  const posSizes = numberList([
    valuesByName.PosSize1,
    valuesByName.PosSize2,
    valuesByName.PosSize3,
    valuesByName.PositionSize,
  ]);
  const profitTargets = numberList([
    valuesByName.ProfitTargetTicks1,
    valuesByName.ProfitTargetTicks2,
    valuesByName.ProfitTargetTicks3,
    valuesByName.ProfitTargetTicks,
  ]);

  return {
    parsed: true,
    valuesByName,
    direction,
    posSizes,
    profitTargets,
    stopLossTicks: parseParamNumber(valuesByName.StopLossTicks),
    tradeWindow: [valuesByName.TradeStartTime || valuesByName.TradeStart1 || '', valuesByName.TradeEndTime || valuesByName.TradeEnd1 || ''],
  };
}

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key || /^unnamed/i.test(key)) continue;
    normalized[canonicalHeader(key)] = value;
  }
  return normalized;
}

export function normalizeStrategyFamily(strategyName) {
  const cleaned = String(strategyName || '').replace(/^\d+\s*-\s*/, '').trim();
  if (/bullet\s*bot/i.test(cleaned)) return 'Bullet Bot';

  const pfMatch = cleaned.match(/^([A-Z0-9]+)-PF\b/i);
  if (pfMatch) return `${pfMatch[1].toUpperCase()}_PF`;

  const [prefix] = cleaned.split('-');
  const token = prefix.trim().toUpperCase();
  if (KNOWN_FAMILIES.includes(token)) return token;
  if (token.endsWith('PF') && KNOWN_FAMILIES.includes(token.replace(/PF$/, ''))) {
    return `${token.replace(/PF$/, '')}_PF`;
  }
  return token || 'Unknown';
}

export function parseStrategyVersion(strategyName) {
  const match = String(strategyName || '').match(/-\s*(\d+(?:\.\d+)+)\s*$/);
  return match ? match[1] : '';
}

function mapAccount(row) {
  const realizedPnl = parseCurrency(row.realizedPnl);
  const grossRealizedPnl = parseCurrency(row.grossRealizedPnl);
  return {
    connectionStatus: row.connectionStatus || '',
    connection: row.connection || row.connectionName || '',
    accountName: row.accountName || row.displayName || '',
    grossRealizedPnl: realizedPnl !== 0 ? realizedPnl : grossRealizedPnl,
    trailingMaxDrawdown: parseCurrency(row.trailingMaxDrawdown),
    accountBalance: parseCurrency(row.cashValue),
    weeklyPnl: parseCurrency(row.weeklyPnl),
    unrealizedPnl: parseCurrency(row.unrealizedPnl),
  };
}

function mapStrategy(row) {
  const parametersRaw = row.parameters || '';
  const params = parseStrategyParameters(parametersRaw);
  return {
    strategyName: row.strategy || row.strategyName || '',
    strategyFamily: normalizeStrategyFamily(row.strategy || row.strategyName),
    strategyVersion: parseStrategyVersion(row.strategy || row.strategyName),
    instrument: row.instrument || '',
    accountName: row.accountDisplayName || row.accountName || '',
    dataSeries: row.dataSeries || '',
    parametersRaw,
    params,
    direction: params.parsed && params.direction ? params.direction : inferDirection(parametersRaw),
    unrealized: parseCurrency(row.unrealized ?? row.unrealizedPnl),
    realized: parseCurrency(row.realized ?? row.realizedPnl),
    connection: row.connection || '',
    enabled: parseBool(row.enabled),
  };
}

function mapOrder(row) {
  return {
    instrument: row.instrument || '',
    action: row.action || '',
    orderType: row.orderType || '',
    quantity: parseCurrency(row.quantity),
    limit: parseCurrency(row.limit ?? row.limitPrice),
    stop: parseCurrency(row.stop ?? row.stopPrice),
    state: row.state || '',
    filled: parseCurrency(row.filled),
    avgPrice: parseCurrency(row.avgPrice ?? row.averageFillPrice),
    remaining: parseCurrency(row.remaining),
    name: row.name || '',
    strategyName: row.strategy || row.strategyName || '',
    strategyId: row.strategyId || '',
    accountName: row.accountDisplayName || row.accountName || '',
    id: row.id || row.orderId || '',
    time: row.time || '',
    tif: row.tif || '',
    oco: row.oco || '',
  };
}

function mapExecution(row) {
  return {
    instrument: row.instrument || '',
    action: row.action || '',
    quantity: parseCurrency(row.quantity),
    price: parseCurrency(row.price),
    time: row.time || '',
    id: row.id || row.executionId || '',
    entryExit: row.entryExit || '',
    position: row.position || row.marketPosition || '',
    orderId: row.orderId || '',
    strategyName: row.strategyName || '',
    name: row.name || '',
    commission: parseCurrency(row.commission),
    rate: parseCurrency(row.rate ?? row.fee),
    accountName: row.accountDisplayName || row.accountName || '',
    connection: row.connection || '',
  };
}

function mapByType(type, row) {
  if (type === 'accounts') return mapAccount(row);
  if (type === 'strategies') return mapStrategy(row);
  if (type === 'orders') return mapOrder(row);
  if (type === 'executions') return mapExecution(row);
  return row;
}

function keepRow(type, row) {
  if (type === 'accounts') return Boolean(row.accountName);
  if (type === 'strategies') return Boolean(row.accountName || row.strategyName);
  if (type === 'orders' || type === 'executions') return Boolean(row.accountName);
  return Object.values(row).some((value) => value !== '');
}

export const REQUIRED_UPLOAD_TYPES = ['accounts', 'strategies', 'orders', 'executions'];

// Summarize a set of parsed upload files so the UI can warn when the daily
// upload is incomplete (missing one of the four required NinjaTrader exports) or
// when a dropped file was not recognized. Computed from the per-file parsed
// array, the only layer that distinguishes an absent type from an unknown file.
export function summarizeUploadTypes(parsedFiles = []) {
  const foundTypes = [];
  const unknownFiles = [];
  for (const file of parsedFiles) {
    if (file?.type === 'unknown') unknownFiles.push(file.fileName || '');
    else if (file?.type && !foundTypes.includes(file.type)) foundTypes.push(file.type);
  }
  const missingTypes = REQUIRED_UPLOAD_TYPES.filter((type) => !foundTypes.includes(type));
  return {
    foundTypes,
    missingTypes,
    unknownFiles,
    isComplete: missingTypes.length === 0 && unknownFiles.length === 0,
  };
}

export function parseNinjaTraderCsvText(csvText, fileName = '') {
  const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const headers = result.meta.fields || [];
  const type = detectNinjaTraderFileType(headers);
  const rows = result.data
    .map(normalizeRow)
    .map((row) => mapByType(type, row))
    .filter((row) => keepRow(type, row));

  return {
    fileName,
    type,
    headers,
    rows,
    errors: result.errors,
  };
}

// NinjaTrader grid exports are named like "NinjaTrader Grid 2026-07-21 04-07 PM1.csv".
// Pull the export date from the name so a bulk drop can file each day under its own
// date instead of all under "today". Returns 'YYYY-MM-DD' or null when no valid date
// is present (the caller falls back to today).
export function parseNinjaTraderFileDate(fileName = '') {
  const match = String(fileName).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${month}-${day}`;
}

// Sortable recency for picking the most recent of several exports of the same grid for
// one day (e.g. a bad export followed by a good re-export). Uses the "HH-MM AM/PM" stamp
// in the name; files without a stamp sort earliest (return 0).
export function parseNinjaTraderFileTimeKey(fileName = '') {
  const match = String(fileName).match(/(\d{1,2})-(\d{2})\s*(AM|PM)/i);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (/PM/i.test(match[3])) hour += 12;
  return hour * 60 + Number(match[2]);
}
