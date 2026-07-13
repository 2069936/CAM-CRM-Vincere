import Papa from 'papaparse';

const HEADER_ALIASES = {
  accountdisplayname: 'accountDisplayName',
  action: 'action',
  avgprice: 'avgPrice',
  cashvalue: 'cashValue',
  commission: 'commission',
  connection: 'connection',
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
  position: 'position',
  price: 'price',
  parameters: 'parameters',
  quantity: 'quantity',
  rate: 'rate',
  realized: 'realized',
  realizedpnl: 'grossRealizedPnl',
  remaining: 'remaining',
  state: 'state',
  stop: 'stop',
  strategy: 'strategy',
  tif: 'tif',
  time: 'time',
  trailingmaxdrawdown: 'trailingMaxDrawdown',
  type: 'orderType',
  unrealized: 'unrealized',
  unrealizedpnl: 'unrealizedPnl',
  weeklypnl: 'weeklyPnl',
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
  if (keys.has('displayName') && keys.has('cashValue') && keys.has('grossRealizedPnl')) return 'accounts';
  if (keys.has('strategy') && keys.has('accountDisplayName') && keys.has('parameters')) return 'strategies';
  if (keys.has('state') && keys.has('orderType') && keys.has('filled') && keys.has('remaining')) return 'orders';
  if (keys.has('entryExit') && keys.has('orderId') && keys.has('price')) return 'executions';
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
  return {
    connectionStatus: row.connectionStatus || '',
    connection: row.connection || '',
    accountName: row.displayName || '',
    grossRealizedPnl: parseCurrency(row.grossRealizedPnl),
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
    strategyName: row.strategy || '',
    strategyFamily: normalizeStrategyFamily(row.strategy),
    strategyVersion: parseStrategyVersion(row.strategy),
    instrument: row.instrument || '',
    accountName: row.accountDisplayName || '',
    dataSeries: row.dataSeries || '',
    parametersRaw,
    params,
    direction: params.parsed && params.direction ? params.direction : inferDirection(parametersRaw),
    unrealized: parseCurrency(row.unrealized),
    realized: parseCurrency(row.realized),
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
    limit: parseCurrency(row.limit),
    stop: parseCurrency(row.stop),
    state: row.state || '',
    filled: parseCurrency(row.filled),
    avgPrice: parseCurrency(row.avgPrice),
    remaining: parseCurrency(row.remaining),
    name: row.name || '',
    strategyName: row.strategy || '',
    accountName: row.accountDisplayName || '',
    id: row.id || '',
    time: row.time || '',
  };
}

function mapExecution(row) {
  return {
    instrument: row.instrument || '',
    action: row.action || '',
    quantity: parseCurrency(row.quantity),
    price: parseCurrency(row.price),
    time: row.time || '',
    id: row.id || '',
    entryExit: row.entryExit || '',
    position: row.position || '',
    orderId: row.orderId || '',
    name: row.name || '',
    commission: parseCurrency(row.commission),
    rate: parseCurrency(row.rate),
    accountName: row.accountDisplayName || '',
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
