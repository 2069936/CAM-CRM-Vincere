// Client lifecycle: the whole story of a client, not just today's close.
//
// When they started -> how many accounts they have run -> how many evaluations
// they took and how many passed (and how long that took) -> which accounts got
// funded, with which prop firms and at what size -> which algos they leaned on
// -> how long to first payout and what they withdrew -> how their cash balance
// moved -> and whether they are still with us.
//
// Everything is derived from data the CRM already stores: the persistent account
// registry (dateAdded / dateFunded / dateFailed / dateLastPayout / payoutHistory)
// plus the daily imports (snapshots and strategies). Nothing here needs a new
// upload step from the CAM.
//
// CHURN is deliberately manual: a client counts as churned only when someone
// sets their stage to Inactive. Inferring churn from "no activity" would mark a
// client dead just because their CAM stopped uploading closes.
import { ACCOUNT_TYPES, ACCOUNT_STATUSES, isCashType } from './reconcile';

export const CLIENT_STAGE_INACTIVE = 'Inactive';

function toDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86400000);
}

function average(values) {
  const nums = values.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);
}

export function isChurnedClient(client) {
  // Manual only. profile.stage is what the Client stage selector writes;
  // client.status === 'Inactive' is the soft-delete path, counted separately.
  return client?.profile?.stage === CLIENT_STAGE_INACTIVE;
}

// Earliest date we can prove the client existed: their recorded start date, or
// the first account they ever had, or their first uploaded close.
export function clientStartDate(client) {
  const candidates = [toDate(client?.profile?.startDate)];
  for (const meta of Object.values(client?.accountRegistry || {})) {
    candidates.push(toDate(meta?.dateAdded));
  }
  const firstImport = (client?.dailyImports || [])[0];
  candidates.push(toDate(firstImport?.date));
  const valid = candidates.filter(Boolean).sort();
  return valid[0] || '';
}

// Which algos the client actually ran, counted by how many (account, day) pairs
// each strategy family appeared in across every close we hold.
export function clientAlgoUsage(client) {
  const counts = new Map();
  for (const dailyImport of client?.dailyImports || []) {
    for (const strategy of dailyImport?.strategies || []) {
      const family = strategy.strategyFamily || strategy.strategyName || '';
      if (!family) continue;
      const entry = counts.get(family) || { family, days: 0, accounts: new Set() };
      entry.days += 1;
      if (strategy.accountName) entry.accounts.add(strategy.accountName);
      counts.set(family, entry);
    }
  }
  return [...counts.values()]
    .map((entry) => ({ family: entry.family, days: entry.days, accounts: entry.accounts.size }))
    .sort((a, b) => b.days - a.days || a.family.localeCompare(b.family));
}

// Cash balance over time, one point per close that carried a cash account.
export function clientCashMovement(client) {
  const registry = client?.accountRegistry || {};
  const points = [];
  for (const dailyImport of client?.dailyImports || []) {
    let balance = 0;
    let realized = 0;
    let found = false;
    for (const snapshot of dailyImport?.snapshots || []) {
      const meta = registry[snapshot.accountName] || {};
      if (!isCashType(meta.accountType)) continue;
      found = true;
      balance += Number(snapshot.accountBalance || 0);
      realized += Number(snapshot.grossRealizedPnl || 0);
    }
    if (found) points.push({ date: dailyImport.date, balance, realized });
  }
  return points;
}

// One account's contribution to the story.
function accountStory(meta) {
  const passedAt = toDate(meta.dateFunded);
  const failedAt = toDate(meta.dateFailed);
  const bornAt = toDate(meta.dateAdded);
  const isEvaluation = String(meta.accountType || '').startsWith('Evaluation');
  const payouts = Array.isArray(meta.payoutHistory) ? meta.payoutHistory : [];
  const payoutTotal = payouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const firstPayoutAt = payouts
    .map((p) => toDate(p.date))
    .filter(Boolean)
    .sort()[0] || toDate(meta.dateLastPayout);
  return {
    accountName: meta.accountName || '',
    alias: meta.alias || meta.accountName || '',
    accountType: meta.accountType || ACCOUNT_TYPES.UNASSIGNED,
    status: meta.status || ACCOUNT_STATUSES.ACTIVE,
    propFirm: meta.connection || '',
    startBalance: Number(meta.startBalance || 0),
    bornAt,
    passedAt,
    failedAt,
    isEvaluation,
    isFunded: meta.accountType === ACCOUNT_TYPES.FUNDED || Boolean(passedAt),
    isCash: isCashType(meta.accountType),
    daysToPass: passedAt ? daysBetween(bornAt, passedAt) : null,
    daysToFirstPayout: firstPayoutAt && passedAt ? daysBetween(passedAt, firstPayoutAt) : null,
    payoutCount: payouts.length || Number(meta.payoutCount || 0) || 0,
    payoutTotal,
    firstPayoutAt,
    lastPayoutAt: toDate(meta.dateLastPayout),
  };
}

/**
 * Full lifecycle for one client.
 * @param client the client object from state
 * @param opts.camName the CAM currently managing them (state has no back-ref)
 */
export function buildClientLifecycle(client, { camName = '' } = {}) {
  const registry = client?.accountRegistry || {};
  const accounts = Object.values(registry).filter(Boolean).map(accountStory);

  const evaluations = accounts.filter((a) => a.isEvaluation || a.passedAt);
  const passed = evaluations.filter((a) => a.passedAt);
  const failed = evaluations.filter((a) => a.failedAt && !a.passedAt);
  const funded = accounts.filter((a) => a.isFunded);
  const cash = accounts.filter((a) => a.isCash);

  const propFirms = new Map();
  for (const account of funded) {
    const firm = account.propFirm || 'Unknown';
    const entry = propFirms.get(firm) || { firm, accounts: 0, startBalance: 0, payoutTotal: 0 };
    entry.accounts += 1;
    entry.startBalance += account.startBalance;
    entry.payoutTotal += account.payoutTotal;
    propFirms.set(firm, entry);
  }

  const payoutAccounts = accounts.filter((a) => a.payoutCount > 0);
  const cashMovement = clientCashMovement(client);

  // Timeline of everything that happened, oldest first.
  const events = [];
  const startedAt = clientStartDate(client);
  if (startedAt) events.push({ date: startedAt, kind: 'start', label: 'Client started' });
  for (const account of accounts) {
    if (account.bornAt) {
      events.push({ date: account.bornAt, kind: 'account-added', label: `${account.alias} added`, accountName: account.accountName });
    }
    if (account.passedAt) {
      events.push({ date: account.passedAt, kind: 'funded', label: `${account.alias} funded${account.propFirm ? ` (${account.propFirm})` : ''}`, accountName: account.accountName });
    }
    if (account.failedAt) {
      events.push({ date: account.failedAt, kind: 'failed', label: `${account.alias} failed`, accountName: account.accountName });
    }
    for (const payout of Array.isArray(registry[account.accountName]?.payoutHistory) ? registry[account.accountName].payoutHistory : []) {
      const date = toDate(payout.date);
      if (date) {
        events.push({ date, kind: 'payout', label: `${account.alias} payout $${Number(payout.amount || 0).toLocaleString()}`, accountName: account.accountName });
      }
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  const churned = isChurnedClient(client);

  return {
    clientId: client?.id || '',
    clientName: client?.name || '',
    camName,
    startedAt,
    churned,
    stage: client?.profile?.stage || '',
    daysWithUs: startedAt ? daysBetween(startedAt, new Date().toISOString().slice(0, 10)) : null,

    totalAccounts: accounts.length,
    evaluationCount: evaluations.length,
    passedCount: passed.length,
    failedCount: failed.length,
    passRate: evaluations.length ? passed.length / evaluations.length : null,
    avgDaysToPass: average(passed.map((a) => a.daysToPass)),

    fundedCount: funded.length,
    fundedStartBalance: funded.reduce((sum, a) => sum + a.startBalance, 0),
    propFirms: [...propFirms.values()].sort((a, b) => b.accounts - a.accounts),

    payoutCount: accounts.reduce((sum, a) => sum + a.payoutCount, 0),
    payoutTotal: accounts.reduce((sum, a) => sum + a.payoutTotal, 0),
    avgDaysToFirstPayout: average(payoutAccounts.map((a) => a.daysToFirstPayout)),

    cashAccounts: cash.length,
    cashBalance: cashMovement.length ? cashMovement[cashMovement.length - 1].balance : 0,
    cashMovement,

    algos: clientAlgoUsage(client),
    accounts,
    events,
  };
}

/**
 * Churn and retention across a set of clients.
 * Churn is manual (stage === 'Inactive'), so this is a straight count, not a
 * time-decayed model. Retention is simply the complement.
 */
export function buildChurnRetention(clients = []) {
  const total = clients.length;
  const churnedClients = clients.filter(isChurnedClient);
  const churned = churnedClients.length;
  const active = total - churned;
  return {
    total,
    active,
    churned,
    churnRate: total ? churned / total : 0,
    retentionRate: total ? active / total : 0,
    churnedClients: churnedClients.map((client) => ({
      clientId: client.id,
      clientName: client.name,
      startedAt: clientStartDate(client),
    })),
  };
}

/** Roll lifecycles up across many clients (CAM view / team view). */
export function buildLifecycleRollup(clients = []) {
  const lifecycles = clients.map((client) => buildClientLifecycle(client));
  const evaluationCount = lifecycles.reduce((sum, l) => sum + l.evaluationCount, 0);
  const passedCount = lifecycles.reduce((sum, l) => sum + l.passedCount, 0);
  const firmTotals = new Map();
  for (const lifecycle of lifecycles) {
    for (const firm of lifecycle.propFirms) {
      const entry = firmTotals.get(firm.firm) || { firm: firm.firm, accounts: 0, payoutTotal: 0 };
      entry.accounts += firm.accounts;
      entry.payoutTotal += firm.payoutTotal;
      firmTotals.set(firm.firm, entry);
    }
  }
  const algoTotals = new Map();
  for (const lifecycle of lifecycles) {
    for (const algo of lifecycle.algos) {
      const entry = algoTotals.get(algo.family) || { family: algo.family, days: 0, accounts: 0 };
      entry.days += algo.days;
      entry.accounts += algo.accounts;
      algoTotals.set(algo.family, entry);
    }
  }
  return {
    clients: lifecycles.length,
    totalAccounts: lifecycles.reduce((sum, l) => sum + l.totalAccounts, 0),
    evaluationCount,
    passedCount,
    passRate: evaluationCount ? passedCount / evaluationCount : null,
    avgDaysToPass: average(lifecycles.map((l) => l.avgDaysToPass)),
    fundedCount: lifecycles.reduce((sum, l) => sum + l.fundedCount, 0),
    payoutCount: lifecycles.reduce((sum, l) => sum + l.payoutCount, 0),
    payoutTotal: lifecycles.reduce((sum, l) => sum + l.payoutTotal, 0),
    avgDaysToFirstPayout: average(lifecycles.map((l) => l.avgDaysToFirstPayout)),
    cashAccounts: lifecycles.reduce((sum, l) => sum + l.cashAccounts, 0),
    cashBalance: lifecycles.reduce((sum, l) => sum + l.cashBalance, 0),
    propFirms: [...firmTotals.values()].sort((a, b) => b.accounts - a.accounts),
    algos: [...algoTotals.values()].sort((a, b) => b.days - a.days),
    ...buildChurnRetention(clients),
  };
}
