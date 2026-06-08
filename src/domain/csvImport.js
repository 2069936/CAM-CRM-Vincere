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

  const [prefix] = cleaned.split('-');
  const token = prefix.trim().toUpperCase();
  if (KNOWN_FAMILIES.includes(token)) return token;
  if (token.endsWith('PF') && KNOWN_FAMILIES.includes(token.replace(/PF$/, ''))) {
    return `${token.replace(/PF$/, '')}_PF`;
  }
  return token || 'Unknown';
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
  return {
    strategyName: row.strategy || '',
    strategyFamily: normalizeStrategyFamily(row.strategy),
    instrument: row.instrument || '',
    accountName: row.accountDisplayName || '',
    dataSeries: row.dataSeries || '',
    parametersRaw: row.parameters || '',
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
