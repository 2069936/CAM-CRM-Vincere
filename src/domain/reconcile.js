export const ACCOUNT_TYPES = {
  UNASSIGNED: 'Unassigned',
  EVALUATION_BULLET: 'Evaluation - Bullet Bot',
  EVALUATION_STANDARD: 'Evaluation - Standard',
  FUNDED: 'Funded',
  CASH_IRA: 'Cash - IRA',
  CASH_STRAIGHT: 'Cash - Straight',
  // LEGACY. Rows written before the IRA/Straight split still store 'Cash' in
  // Supabase (trading_accounts.account_type is free text, no CHECK constraint),
  // so this key must stay: removing it would make every pre-split row fall
  // through to Unassigned behaviour.
  CASH: 'Cash',
  IGNORE: 'Inactive / Ignore',
};

// Every value that must behave like cash: no profit target, no drawdown limit,
// balance-only reporting. Branch on isCashType(), never on a single string.
export const CASH_ACCOUNT_TYPES = [
  ACCOUNT_TYPES.CASH_IRA,
  ACCOUNT_TYPES.CASH_STRAIGHT,
  ACCOUNT_TYPES.CASH,
];

export function isCashType(accountType) {
  return CASH_ACCOUNT_TYPES.includes(accountType);
}

export function isLegacyCashType(accountType) {
  return accountType === ACCOUNT_TYPES.CASH;
}

// Prop-firm family: funded plus any evaluation. Unassigned and Inactive / Ignore
// deliberately match neither this nor isCashType.
export function isPropAccountType(accountType) {
  const value = String(accountType || '').trim();
  return value === ACCOUNT_TYPES.FUNDED || value.startsWith('Evaluation');
}

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

// Risk level is assigned manually by the team (not inferred). Empty = Unassigned.
export const RISK_LEVELS = ['Low', 'Medium', 'High'];

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
    startBalance: existing.startBalance ?? '',
    targetProfit: existing.targetProfit ?? '',
    maxDrawdownLimit: existing.maxDrawdownLimit ?? '',
    riskLevel: existing.riskLevel || '',
    bulletBotPassType: existing.bulletBotPassType || '',
    bulletBotDirection: existing.bulletBotDirection || '',
    notes: existing.notes || '',
    dateAdded: existing.dateAdded || nowIso().slice(0, 10),
    dateFailed: existing.dateFailed || '',
    dateFunded: existing.dateFunded || '',
    dateLastPayout: existing.dateLastPayout || '',
    payoutCount: existing.payoutCount ?? 0,
  };
}

function makeFlag({ type, severity = 'Warning', accountName = '', message }) {
  return {
    // Unique id so flags never collide as React keys (which made them vanish).
    // Recalculate preserves triage by matching on type|account|message instead,
    // so a stable id is not needed for that.
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
  // Build case-insensitive registry lookup so CSV names always find their metadata
  const registryByLower = Object.fromEntries(Object.entries(registry || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sourceAccounts = (parsed.accounts || []).filter((account) => !isSimulatorAccount(account.accountName));
  const strategies = (parsed.strategies || []).filter((strategy) => !isSimulatorAccount(strategy.accountName));
  const orders = (parsed.orders || []).filter((order) => !isSimulatorAccount(order.accountName));
  const orderStrategyById = Object.fromEntries(orders.map((order) => [order.id, order.strategyName || '']));
  const executions = (parsed.executions || [])
    .filter((execution) => !isSimulatorAccount(execution.accountName))
    .map((execution) => ({
      ...execution,
      strategyName: orderStrategyById[execution.orderId] || '',
    }));
  const strategiesByAccount = groupStrategiesByAccount(strategies);
  const seen = new Set();

  for (const account of sourceAccounts) {
    const existing = registry[account.accountName] || registryByLower[account.accountName.toLowerCase()];
    const meta = createDefaultAccount(account, existing);
    const strategies = strategiesByAccount[account.accountName] || [];

    accountsByName[account.accountName] = meta;
    snapshots.push(createSnapshot(account, strategies));
    seen.add(account.accountName.toLowerCase());

    if (!existing) {
      flags.push(makeFlag({
        type: 'New account',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} is new and needs manual classification.`,
      }));
    }

    if (meta.accountType === ACCOUNT_TYPES.UNASSIGNED && meta.status !== ACCOUNT_STATUSES.RESERVE) {
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

    const ddLimit = Number(meta.maxDrawdownLimit);
    const rawDD = Number(account.trailingMaxDrawdown || 0);

    if (Number.isFinite(ddLimit) && ddLimit > 0) {
      // Model 1: configured limit - trailingMaxDrawdown is cumulative loss (negative number)
      const currentDD = Math.abs(rawDD);
      if (currentDD > 0) {
        const remaining = ddLimit - currentDD;
        if (remaining <= 0) {
          flags.push(makeFlag({
            type: 'Drawdown breached',
            severity: 'Critical',
            accountName: account.accountName,
            message: `${meta.alias} has exceeded its $${ddLimit.toLocaleString()} max drawdown limit. Account may be terminated.`,
          }));
        } else if (remaining <= 500) {
          flags.push(makeFlag({
            type: 'Drawdown near limit',
            severity: 'Critical',
            accountName: account.accountName,
            message: `${meta.alias} is $${Math.round(remaining)} from its $${ddLimit.toLocaleString()} max drawdown limit. Immediate action required.`,
          }));
        } else if (remaining <= 1200) {
          flags.push(makeFlag({
            type: 'Drawdown approaching limit',
            severity: 'Warning',
            accountName: account.accountName,
            message: `${meta.alias} has $${Math.round(remaining)} remaining before its $${ddLimit.toLocaleString()} max drawdown limit.`,
          }));
        }
      }
    } else if (rawDD !== 0) {
      // Model 2: no configured limit - trailingMaxDrawdown IS the remaining buffer (sign-based)
      // NT exports this as positive (buffer remaining); account dies when it hits 0 or goes negative
      if (rawDD <= 0) {
        flags.push(makeFlag({
          type: 'Drawdown breached',
          severity: 'Critical',
          accountName: account.accountName,
          message: `${meta.alias} trailing drawdown buffer is $${rawDD.toLocaleString()} - account limit reached or exceeded. Verify with prop firm immediately.`,
        }));
      } else if (rawDD <= 500) {
        flags.push(makeFlag({
          type: 'Drawdown near limit',
          severity: 'Critical',
          accountName: account.accountName,
          message: `${meta.alias} has only $${Math.round(rawDD)} of trailing drawdown buffer remaining. Immediate action required.`,
        }));
      } else if (rawDD <= 1200) {
        flags.push(makeFlag({
          type: 'Drawdown approaching limit',
          severity: 'Warning',
          accountName: account.accountName,
          message: `${meta.alias} has $${Math.round(rawDD)} of trailing drawdown buffer remaining.`,
        }));
      }
    }

    const targetProfit = Number(meta.targetProfit);
    if (
      meta.accountType === ACCOUNT_TYPES.FUNDED &&
      Number.isFinite(targetProfit) && targetProfit > 0 &&
      Number(account.accountBalance) >= targetProfit &&
      meta.payoutState === PAYOUT_STATES.NOT_REQUESTED
    ) {
      flags.push(makeFlag({
        type: 'Payout eligible',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} reached its target profit. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Request payout.`,
      }));
    }

    if (
      [ACCOUNT_TYPES.EVALUATION_BULLET, ACCOUNT_TYPES.EVALUATION_STANDARD].includes(meta.accountType) &&
      meta.status === ACCOUNT_STATUSES.ACTIVE &&
      Number.isFinite(targetProfit) && targetProfit > 0 &&
      Number(account.accountBalance) >= targetProfit
    ) {
      flags.push(makeFlag({
        type: 'Evaluation target reached',
        severity: 'Warning',
        accountName: account.accountName,
        message: `${meta.alias} reached its evaluation target. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Deactivate and confirm consistency with the prop firm to activate.`,
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

  for (const [accountName, meta] of Object.entries(registry || {})) {
    if (seen.has(accountName.toLowerCase())) continue;
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

  // Recalculate only re-derives flags + status from the data already uploaded.
  // It must NOT replace the snapshots/accounts/strategies/orders/executions: the
  // rebuilt snapshots would drop their nested strategy detail whenever the
  // top-level detail arrays are empty (e.g. right after an upload, before a
  // reload), which is what made Recalculate look like it erased the import.
  // Carry each prior flag's triage (Acknowledged/Resolved + resolvedAt) onto the
  // regenerated flag so Recalculate keeps the operator's work instead of resetting
  // every flag to Open. Match on a reconstructed type|account|message key (not the
  // id) so it also matches flags reloaded from the DB, which carry a uuid id.
  const flagKey = (f) => `${f.type}|${f.accountName || 'client'}|${f.message || ''}`;
  const priorByKey = Object.fromEntries((dailyImport.flags || []).map((f) => [flagKey(f), f]));
  const flags = (recalculated.flags || []).map((flag) => {
    const prior = priorByKey[flagKey(flag)];
    return prior && prior.status && prior.status !== 'Open'
      ? { ...flag, status: prior.status, resolvedAt: prior.resolvedAt }
      : flag;
  });

  return {
    ...dailyImport,
    status: recalculated.status,
    flags,
  };
}
