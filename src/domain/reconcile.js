export const ACCOUNT_TYPES = {
  UNASSIGNED: 'Unassigned',
  EVALUATION_BULLET: 'Evaluation - Bullet Bot',
  EVALUATION_STANDARD: 'Evaluation - Standard',
  FUNDED: 'Funded',
  CASH: 'Cash',
  IGNORE: 'Inactive / Ignore',
};

export const ACCOUNT_STATUSES = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  RESERVE: 'Reserve',
  FAILED: 'Failed',
  PAYOUT_HOLD: 'Payout Hold',
};

export const PAYOUT_STATES = {
  NOT_REQUESTED: 'Not requested',
  REQUEST_PAYOUT: 'Request payout',
  PAYOUT_REQUESTED: 'Payout requested',
  PAYOUT_APPROVED: 'Payout approved',
  CLEAR_TO_TRADE: 'Clear to trade',
};

function nowIso() {
  return new Date().toISOString();
}

export function makeAccountAlias(accountName, connection = '') {
  const suffix = String(accountName || '').slice(-4);
  const label = String(connection || 'Account').trim() || 'Account';
  return suffix ? `${label} - ${suffix}` : label;
}

function createDefaultAccount(account, existing = {}) {
  return {
    accountName: account.accountName,
    alias: existing.alias || makeAccountAlias(account.accountName, account.connection),
    connection: account.connection || existing.connection || '',
    accountType: existing.accountType || ACCOUNT_TYPES.UNASSIGNED,
    status: existing.status || ACCOUNT_STATUSES.ACTIVE,
    payoutState: existing.payoutState || PAYOUT_STATES.NOT_REQUESTED,
    targetProfit: existing.targetProfit ?? '',
    bulletBotPassType: existing.bulletBotPassType || '',
    notes: existing.notes || '',
  };
}

function makeFlag({ type, severity = 'Warning', accountName = '', message }) {
  return {
    id: `${type}-${accountName || 'client'}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    severity,
    accountName,
    message,
    status: 'Open',
  };
}

function groupStrategiesByAccount(strategies = []) {
  return strategies.reduce((map, strategy) => {
    if (!strategy.accountName) return map;
    if (!map[strategy.accountName]) map[strategy.accountName] = [];
    map[strategy.accountName].push(strategy);
    return map;
  }, {});
}

function shouldExpectStrategy(meta) {
  if (!meta) return false;
  if (meta.accountType === ACCOUNT_TYPES.IGNORE) return false;
  if ([ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE, ACCOUNT_STATUSES.FAILED, ACCOUNT_STATUSES.PAYOUT_HOLD].includes(meta.status)) {
    return false;
  }
  return meta.accountType !== ACCOUNT_TYPES.UNASSIGNED;
}

function hasActiveStrategy(strategies = []) {
  return strategies.some((strategy) => strategy.enabled);
}

function isSimulatorAccount(accountName) {
  return String(accountName || '').trim().toLowerCase().startsWith('sim');
}

function createSnapshot(account, strategies) {
  return {
    accountName: account.accountName,
    connection: account.connection || '',
    grossRealizedPnl: account.grossRealizedPnl || 0,
    trailingMaxDrawdown: account.trailingMaxDrawdown || 0,
    accountBalance: account.accountBalance || 0,
    weeklyPnl: account.weeklyPnl || 0,
    unrealizedPnl: account.unrealizedPnl || 0,
    strategies,
  };
}

function snapshotToAccount(snapshot) {
  return {
    accountName: snapshot.accountName,
    connection: snapshot.connection,
    grossRealizedPnl: snapshot.grossRealizedPnl,
    trailingMaxDrawdown: snapshot.trailingMaxDrawdown,
    accountBalance: snapshot.accountBalance,
    weeklyPnl: snapshot.weeklyPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
  };
}

export function reconcileDailyImport({ clientId, date, registry = {}, parsed }) {
  const accountsByName = {};
  const snapshots = [];
  const flags = [];
  const sourceAccounts = (parsed.accounts || []).filter((account) => !isSimulatorAccount(account.accountName));
  const strategies = (parsed.strategies || []).filter((strategy) => !isSimulatorAccount(strategy.accountName));
  const orders = (parsed.orders || []).filter((order) => !isSimulatorAccount(order.accountName));
  const executions = (parsed.executions || []).filter((execution) => !isSimulatorAccount(execution.accountName));
  const strategiesByAccount = groupStrategiesByAccount(strategies);
  const seen = new Set();

  for (const account of sourceAccounts) {
    const existing = registry[account.accountName];
    const meta = createDefaultAccount(account, existing);
    const strategies = strategiesByAccount[account.accountName] || [];

    accountsByName[account.accountName] = meta;
    snapshots.push(createSnapshot(account, strategies));
    seen.add(account.accountName);

    if (!existing) {
      flags.push(makeFlag({
        type: 'New account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} is new and needs manual classification.`,
      }));
    }

    if (meta.accountType === ACCOUNT_TYPES.UNASSIGNED) {
      flags.push(makeFlag({
        type: 'Unassigned account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} needs an account type before close.`,
      }));
    }

    if (shouldExpectStrategy(meta) && !hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Expected strategy missing',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is active but has no enabled strategy in this close.`,
      }));
    }

    if (meta.status === ACCOUNT_STATUSES.PAYOUT_HOLD && hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Payout hold violation',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is in payout hold but has an enabled strategy.`,
      }));
    }

    if ([ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE, ACCOUNT_STATUSES.FAILED].includes(meta.status) && hasActiveStrategy(strategies)) {
      flags.push(makeFlag({
        type: 'Unexpected strategy active',
        severity: 'Critical',
        accountName: account.accountName,
        message: `${meta.alias} is ${meta.status} but has an enabled strategy.`,
      }));
    }

    for (const strategy of strategies) {
      if (!strategy.enabled) {
        flags.push(makeFlag({
          type: 'Strategy disabled',
          severity: 'Warning',
          accountName: account.accountName,
          message: `${meta.alias} has ${strategy.strategyName || 'a strategy'} disabled.`,
        }));
      }
    }
  }

  for (const [accountName, meta] of Object.entries(registry)) {
    if (seen.has(accountName)) continue;
    accountsByName[accountName] = meta;
    if (meta.accountType !== ACCOUNT_TYPES.IGNORE && meta.status !== ACCOUNT_STATUSES.INACTIVE) {
      flags.push(makeFlag({
        type: 'Missing account',
        severity: 'Warning',
        accountName,
        message: `${meta.alias || accountName} existed before but did not appear in this close.`,
      }));
    }
  }

  return {
    id: `${clientId}-${date}-${Date.now()}`,
    clientId,
    date,
    importedAt: nowIso(),
    status: flags.some((flag) => flag.severity === 'Critical' || flag.severity === 'Warning') ? 'Needs review' : 'Ready to close',
    accounts: accountsByName,
    snapshots,
    strategies,
    orders,
    executions,
    flags,
  };
}

export function recalculateDailyImport({ dailyImport, registry = {} }) {
  const recalculated = reconcileDailyImport({
    clientId: dailyImport.clientId,
    date: dailyImport.date,
    registry,
    parsed: {
      accounts: (dailyImport.snapshots || []).map(snapshotToAccount),
      strategies: dailyImport.strategies || [],
      orders: dailyImport.orders || [],
      executions: dailyImport.executions || [],
    },
  });

  return {
    ...dailyImport,
    status: recalculated.status,
    accounts: recalculated.accounts,
    snapshots: recalculated.snapshots,
    flags: recalculated.flags,
  };
}
