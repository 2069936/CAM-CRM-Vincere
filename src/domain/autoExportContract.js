const ROW_SCHEMAS = {
  accounts: {
    required: ['accountName'],
    strings: ['connectionName', 'displayName', 'currency', 'status'],
    numbers: ['netLiquidation', 'cashValue', 'realizedPnl', 'grossRealizedPnl', 'unrealizedPnl', 'totalPnl', 'weeklyPnl', 'buyingPower', 'excessIntradayMargin', 'initialMargin', 'maintenanceMargin'],
  },
  strategies: {
    required: ['strategyId', 'strategyName', 'accountName', 'instrument', 'state', 'parameterCaptureStatus'],
    strings: ['strategyDisplayName', 'position', 'parameterCaptureStatus'],
    numbers: ['quantity', 'averagePrice', 'realizedPnl', 'unrealizedPnl'],
    booleans: ['enabled'],
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
    strings: ['orderId', 'strategyId', 'strategyName', 'instrument', 'action', 'marketPosition', 'nativeId'],
    numbers: ['quantity', 'price', 'commission', 'fee', 'realizedPnl'],
    timestamps: ['time'],
  },
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isScalarOrNull(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
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
      if (!hasOwn(row, key) || typeof row[key] !== 'string') errors.push(`${path}.${key} is required`);
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
    if (typeof snapshot[key] !== 'string') errors.push(`${key} is required`);
  }
  if (!isIsoTimestamp(snapshot.capturedAt)) errors.push('capturedAt must be an ISO-8601 timestamp with an offset');
  if (!isDate(snapshot.tradingDate)) errors.push('tradingDate must be an ISO date');
  if (!isObject(snapshot.source)) {
    errors.push('source must be an object');
  } else {
    for (const key of ['machineId', 'agentVersion', 'addonVersion', 'ninjaTraderVersion']) {
      if (typeof snapshot.source[key] !== 'string') errors.push(`source.${key} is required`);
    }
  }

  for (const section of Object.keys(ROW_SCHEMAS)) validateRows(snapshot, section, errors);
  return { ok: errors.length === 0, errors };
}
