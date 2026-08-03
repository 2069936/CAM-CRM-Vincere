import Papa from 'papaparse';

const HEADER_ALIASES = {
  accountdisplayname: 'accountName',
  accountname: 'accountName',
  action: 'action',
  avgprice: 'averageFillPrice',
  cashvalue: 'cashValue',
  commission: 'commission',
  connection: 'connectionName',
  connectionname: 'connectionName',
  connectionstatus: 'status',
  dataseries: 'dataSeries',
  displayname: 'displayName',
  enabled: 'enabled',
  ex: 'entryExit',
  filled: 'filled',
  grossrealizedpnl: 'grossRealizedPnl',
  id: 'id',
  instrument: 'instrument',
  limit: 'limitPrice',
  name: 'name',
  oco: 'oco',
  orderid: 'orderId',
  parameters: 'parametersRaw',
  position: 'marketPosition',
  price: 'price',
  quantity: 'quantity',
  rate: 'rate',
  realized: 'realizedPnl',
  realizedpnl: 'realizedPnl',
  remaining: 'remaining',
  state: 'state',
  stop: 'stopPrice',
  strategy: 'strategyName',
  sync: 'sync',
  tif: 'tif',
  time: 'time',
  totalpnl: 'totalPnl',
  trailingmaxdrawdown: 'trailingMaxDrawdown',
  type: 'orderType',
  unrealized: 'unrealizedPnl',
  unrealizedpnl: 'unrealizedPnl',
  weeklypnl: 'weeklyPnl',
};

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function canonicalHeader(value) {
  const normalized = normalizeHeader(value);
  return HEADER_ALIASES[normalized] || normalized;
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key && !/^unnamed/i.test(key))
      .map(([key, value]) => [canonicalHeader(key), value]),
  );
}

function parseNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  let cleaned = String(value).trim().replace(/[$,]/g, '');
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = `-${cleaned.slice(1, -1)}`;
  }
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function keyPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function buildManualRowKey(type, row) {
  if (type === 'accounts') return keyPart(row.accountName);
  if (type === 'strategies') {
    return [row.accountName, row.strategyName || row.strategyDisplayName, row.instrument]
      .map(keyPart).join('|');
  }
  if (type === 'orders') {
    return keyPart(row.orderId) || [row.accountName, row.nativeId].map(keyPart).join('|');
  }
  if (type === 'executions') {
    return keyPart(row.executionId) || [
      row.accountName, row.orderId, row.time, row.quantity, row.price,
    ].map(keyPart).join('|');
  }
  return '';
}

function isMissing(value) {
  return value == null || value === '';
}

function normalizedComparable(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  return value;
}

export function compareFieldValues(apiValue, gridValue) {
  if (Object.is(apiValue, gridValue)) return 'exact';
  if (isMissing(apiValue)) return 'missing-api';
  if (isMissing(gridValue)) return 'missing-grid';
  if (Object.is(normalizedComparable(apiValue), normalizedComparable(gridValue))) {
    return 'normalized-match';
  }
  return 'value-mismatch';
}

const SECTION_NAMES = ['accounts', 'strategies', 'orders', 'executions'];

function increment(summary, status) {
  summary[status] = (summary[status] || 0) + 1;
}

export function compareProbeSnapshot(snapshot, normalizedFiles) {
  const summary = {};
  const sections = {};

  for (const section of SECTION_NAMES) {
    const apiRows = Array.isArray(snapshot?.[section]) ? snapshot[section] : [];
    const gridRows = normalizedFiles
      .filter((file) => file.type === section)
      .flatMap((file) => file.rows || []);
    const apiByKey = new Map(apiRows.map((row) => [buildManualRowKey(section, row), row]));
    const gridByKey = new Map(gridRows.map((row) => [buildManualRowKey(section, row), row]));
    const keys = [...new Set([...apiByKey.keys(), ...gridByKey.keys()])].sort();

    const rows = keys.map((key) => {
      const apiRow = apiByKey.get(key);
      const gridRow = gridByKey.get(key);
      if (!apiRow) {
        increment(summary, 'missing-api-row');
        return { key, rowStatus: 'missing-api-row', fields: [] };
      }
      if (!gridRow) {
        increment(summary, 'missing-grid-row');
        return { key, rowStatus: 'missing-grid-row', fields: [] };
      }

      const fieldNames = [...new Set([...Object.keys(apiRow), ...Object.keys(gridRow)])].sort();
      const fields = fieldNames.map((field) => {
        const status = compareFieldValues(apiRow[field], gridRow[field]);
        increment(summary, status);
        return { field, apiValue: apiRow[field] ?? null, gridValue: gridRow[field] ?? null, status };
      });
      return { key, rowStatus: 'matched', fields };
    });
    sections[section] = { apiRowCount: apiRows.length, gridRowCount: gridRows.length, rows };
  }

  return { sections, summary };
}

function markdownValue(value) {
  if (value == null) return 'null';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderComparisonMarkdown(report) {
  const lines = ['# NinjaTrader probe comparison', '', '## Summary', '', '| Status | Count |', '| --- | ---: |'];
  for (const [status, count] of Object.entries(report.summary || {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${status} | ${count} |`);
  }
  for (const [section, data] of Object.entries(report.sections || {})) {
    lines.push('', `## ${section[0].toUpperCase()}${section.slice(1)}`, '');
    lines.push(`API rows: ${data.apiRowCount}; grid rows: ${data.gridRowCount}.`, '');
    lines.push('| Row key | Field | API | Grid | Status |', '| --- | --- | --- | --- | --- |');
    for (const row of data.rows || []) {
      if (row.rowStatus !== 'matched') {
        lines.push(`| ${markdownValue(row.key)} | — | — | — | ${row.rowStatus} |`);
        continue;
      }
      for (const field of row.fields || []) {
        lines.push(`| ${markdownValue(row.key)} | ${markdownValue(field.field)} | ${markdownValue(field.apiValue)} | ${markdownValue(field.gridValue)} | ${field.status} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function detectTypes(headers) {
  const keys = new Set(headers);
  const matches = [];
  if (keys.has('displayName') && keys.has('cashValue')
    && (keys.has('realizedPnl') || keys.has('grossRealizedPnl'))) matches.push('accounts');
  if (keys.has('strategyName') && keys.has('accountName') && keys.has('parametersRaw')) {
    matches.push('strategies');
  }
  if (keys.has('state') && keys.has('orderType') && keys.has('filled') && keys.has('remaining')) {
    matches.push('orders');
  }
  if (keys.has('entryExit') && keys.has('orderId') && keys.has('price')) matches.push('executions');
  return matches;
}

function mapRow(type, row) {
  if (type === 'accounts') {
    return {
      accountName: row.accountName || row.displayName || '',
      connectionName: row.connectionName || '',
      displayName: row.displayName || '',
      cashValue: parseNumber(row.cashValue),
      realizedPnl: parseNumber(row.realizedPnl),
      grossRealizedPnl: parseNumber(row.grossRealizedPnl),
      unrealizedPnl: parseNumber(row.unrealizedPnl),
      totalPnl: parseNumber(row.totalPnl),
      weeklyPnl: parseNumber(row.weeklyPnl),
      trailingMaxDrawdown: parseNumber(row.trailingMaxDrawdown),
      status: row.status || '',
    };
  }
  if (type === 'strategies') {
    return {
      strategyId: row.strategyId || null,
      strategyName: row.strategyName || '',
      accountName: row.accountName || '',
      instrument: row.instrument || '',
      state: row.state || '',
      realizedPnl: parseNumber(row.realizedPnl),
      unrealizedPnl: parseNumber(row.unrealizedPnl),
      enabled: parseBoolean(row.enabled),
      sync: parseBoolean(row.sync),
      dataSeries: row.dataSeries || '',
      parametersRaw: row.parametersRaw || '',
    };
  }
  if (type === 'orders') {
    return {
      orderId: row.orderId || row.id || '',
      accountName: row.accountName || '',
      strategyName: row.strategyName || '',
      instrument: row.instrument || '',
      action: row.action || '',
      orderType: row.orderType || '',
      quantity: parseNumber(row.quantity),
      filled: parseNumber(row.filled),
      remaining: parseNumber(row.remaining),
      limitPrice: parseNumber(row.limitPrice),
      stopPrice: parseNumber(row.stopPrice),
      averageFillPrice: parseNumber(row.averageFillPrice),
      state: row.state || '',
      time: row.time || '',
      tif: row.tif || '',
      oco: row.oco || '',
      name: row.name || '',
    };
  }
  if (type === 'executions') {
    return {
      executionId: row.executionId || row.id || '',
      orderId: row.orderId || '',
      accountName: row.accountName || '',
      instrument: row.instrument || '',
      action: row.action || '',
      quantity: parseNumber(row.quantity),
      price: parseNumber(row.price),
      time: row.time || '',
      marketPosition: row.marketPosition || '',
      entryExit: row.entryExit || '',
      name: row.name || '',
      commission: parseNumber(row.commission),
      rate: parseNumber(row.rate),
      connectionName: row.connectionName || '',
    };
  }
  return row;
}

export function selectDailyPnl(account) {
  if (account.realizedPnl != null && account.realizedPnl !== 0) {
    return { value: account.realizedPnl, source: 'realized' };
  }
  if (account.grossRealizedPnl != null && account.grossRealizedPnl !== 0) {
    return { value: account.grossRealizedPnl, source: 'gross_fallback' };
  }
  return { value: account.realizedPnl ?? account.grossRealizedPnl ?? 0, source: 'realized' };
}

export function normalizeManualGridFile(csvText, fileName = '') {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const headers = (parsed.meta.fields || []).map(canonicalHeader);
  const matches = detectTypes(headers);
  const type = matches.length === 1 ? matches[0] : 'unknown';
  const rows = type === 'unknown' ? [] : parsed.data.map(normalizeRow).map((row) => mapRow(type, row));
  const classificationErrors = matches.length > 1
    ? [{ code: 'ambiguous_grid_type', message: `Headers match multiple grid types: ${matches.join(', ')}` }]
    : matches.length === 0
      ? [{ code: 'unknown_grid_type', message: 'Headers do not match a supported NinjaTrader grid.' }]
      : [];

  return {
    fileName,
    type,
    headers: parsed.meta.fields || [],
    rows,
    errors: [...parsed.errors, ...classificationErrors],
  };
}
