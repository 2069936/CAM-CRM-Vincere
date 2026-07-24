const ROW_SCHEMAS = {
  accounts: {
    required: ['accountName'],
    strings: ['connectionName', 'displayName', 'currency', 'status'],
    numbers: ['netLiquidation', 'cashValue', 'realizedPnl', 'grossRealizedPnl', 'unrealizedPnl', 'totalPnl', 'weeklyPnl', 'trailingMaxDrawdown', 'buyingPower', 'excessIntradayMargin', 'initialMargin', 'maintenanceMargin'],
  },
  strategies: {
    required: ['strategyId', 'strategyName', 'accountName', 'instrument', 'state', 'parameterCaptureStatus'],
    strings: ['strategyDisplayName', 'position', 'dataSeries', 'connectionName', 'parameterCaptureStatus'],
    numbers: ['quantity', 'averagePrice', 'realizedPnl', 'unrealizedPnl'],
    booleans: ['enabled', 'sync'],
    timestamps: ['startedAt'],
    objects: ['parameters'],
  },
  orders: {
    required: ['orderId', 'accountName', 'instrument', 'action', 'orderType', 'state'],
    strings: ['strategyId', 'strategyName', 'action', 'orderType', 'state', 'tif', 'oco', 'name', 'nativeId'],
    numbers: ['quantity', 'filled', 'remaining', 'limitPrice', 'stopPrice', 'averageFillPrice'],
    timestamps: ['time'],
  },
  executions: {
    required: ['executionId', 'accountName', 'instrument', 'action', 'time'],
    strings: ['orderId', 'strategyId', 'strategyName', 'instrument', 'action', 'marketPosition', 'entryExit', 'name', 'connectionName', 'nativeId'],
    numbers: ['quantity', 'price', 'commission', 'fee', 'rate', 'realizedPnl'],
    timestamps: ['time'],
  },
};

// Accept UTC or real-world numeric UTC offsets through the conservative ±14:00 limit.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  return ISO_TIMESTAMP.test(value) && isDate(value.slice(0, 10));
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function tradingDateInNewYork(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isScalarOrNull(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function validateRows(snapshot, section, errors) {
  const rows = snapshot[section];
  if (!Array.isArray(rows)) {
    errors.push(`${section} must be an array`);
    return;
  }

  const schema = ROW_SCHEMAS[section];
  rows.forEach((row, index) => {
    const path = `${section}[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path} must be an object`);
      return;
    }

    for (const key of schema.required) {
      if (!hasOwn(row, key) || typeof row[key] !== 'string' || !row[key].trim()) errors.push(`${path}.${key} is required`);
    }
    for (const key of schema.strings || []) {
      if (hasOwn(row, key) && row[key] !== null && typeof row[key] !== 'string') errors.push(`${path}.${key} must be a string or null`);
    }
    for (const key of schema.numbers || []) {
      if (!hasOwn(row, key) || (row[key] !== null && (typeof row[key] !== 'number' || !Number.isFinite(row[key])))) {
        errors.push(`${path}.${key} must be a number or null`);
      }
    }
    for (const key of schema.booleans || []) {
      if (!hasOwn(row, key) || (row[key] !== null && typeof row[key] !== 'boolean')) errors.push(`${path}.${key} must be a boolean or null`);
    }
    for (const key of schema.timestamps || []) {
      if (!hasOwn(row, key) || (row[key] !== null && !isIsoTimestamp(row[key]))) errors.push(`${path}.${key} must be an ISO-8601 timestamp with an offset or null`);
    }
    for (const key of schema.objects || []) {
      if (!hasOwn(row, key) || !isObject(row[key])) {
        errors.push(`${path}.${key} must be an object`);
      } else {
        for (const [parameter, value] of Object.entries(row[key])) {
          if (!isScalarOrNull(value)) errors.push(`${path}.${key}.${parameter} must be a scalar or null`);
        }
      }
    }
  });
}

export function validateAutoExportSnapshot(snapshot) {
  const errors = [];
  if (!isObject(snapshot)) return { ok: false, errors: ['snapshot must be an object'] };

  if (snapshot.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const key of ['captureId', 'timeZone']) {
    if (typeof snapshot[key] !== 'string' || !snapshot[key].trim()) errors.push(`${key} is required`);
  }
  if (!isIsoTimestamp(snapshot.capturedAt)) errors.push('capturedAt must be an ISO-8601 timestamp with an offset');
  if (!isDate(snapshot.tradingDate)) errors.push('tradingDate must be an ISO date');
  if (snapshot.timeZone !== 'America/New_York') errors.push('timeZone must be America/New_York');
  if (isIsoTimestamp(snapshot.capturedAt) && isDate(snapshot.tradingDate) && tradingDateInNewYork(snapshot.capturedAt) !== snapshot.tradingDate) {
    errors.push('tradingDate must match capturedAt in America/New_York');
  }
  if (!isObject(snapshot.source)) {
    errors.push('source must be an object');
  } else {
    for (const key of ['machineId', 'agentVersion', 'addonVersion', 'ninjaTraderVersion']) {
      if (typeof snapshot.source[key] !== 'string' || !snapshot.source[key].trim()) errors.push(`source.${key} is required`);
    }
  }

  for (const section of Object.keys(ROW_SCHEMAS)) validateRows(snapshot, section, errors);
  return { ok: errors.length === 0, errors };
}
