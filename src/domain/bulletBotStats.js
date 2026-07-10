// Bullet Bot performance over time.
//
// Runs on the app's stored client history (dailyImports -> snapshots ->
// strategies), which already links a BulletBot strategy to its trading account
// via the strategies import. (The raw NinjaTrader log cannot attribute Bullet
// Bot fills on its own: strategy events key the account as e.g. "388413837"
// while orders/executions key it as "LTD…", and the log never links the two.)
//
// Definitions (confirmed with ops):
//   fired  — the account actually traded (had executions or non-zero realized).
//   passed — accountBalance reached targetProfit (same rule as a funded payout).
//   direction — the Bullet Bot strategy's configured Long / Short.

import { ACCOUNT_TYPES } from './reconcile';

function normalizeDirection(value) {
  const v = String(value || '').toLowerCase();
  if (v.startsWith('long')) return 'Long';
  if (v.startsWith('short')) return 'Short';
  if (v.startsWith('both')) return 'Both';
  return 'Unknown';
}

// Merge per-account metadata the same way camOverview does: import row first,
// user-configured registry (accountType, targetProfit, alias) takes precedence.
function accountMetaFor(client, dailyImport, accountName) {
  const lower = String(accountName || '').toLowerCase();
  const fromImport = Object.entries(dailyImport?.accounts || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  const fromRegistry = Object.entries(client?.accountRegistry || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  return { ...fromImport, ...fromRegistry };
}

function daysBetween(from, to) {
  const t1 = Date.parse(from);
  const t2 = Date.parse(to);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}

function isBulletBotStrategy(strategy) {
  return /bullet\s*bot/i.test(strategy.strategyFamily || strategy.strategyName || '');
}

function summarize(rows) {
  const passed = rows.filter((r) => r.passed);
  const daysValues = passed.map((r) => r.daysToPass).filter((d) => d != null);
  return {
    accounts: rows.length,
    fired: rows.filter((r) => r.fired).length,
    passed: passed.length,
    passRate: rows.length ? passed.length / rows.length : 0,
    avgDaysToPass: daysValues.length ? daysValues.reduce((a, b) => a + b, 0) / daysValues.length : null,
  };
}

export function buildBulletBotStats(clients = []) {
  const accounts = new Map();

  for (const client of clients || []) {
    const imports = [...(client.dailyImports || [])]
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    for (const dailyImport of imports) {
      for (const snapshot of dailyImport.snapshots || []) {
        const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
        if (meta.accountType !== ACCOUNT_TYPES.EVALUATION_BULLET) continue;

        const key = `${client.id}:${snapshot.accountName}`;
        let record = accounts.get(key);
        if (!record) {
          record = {
            clientId: client.id,
            clientName: client.name,
            accountName: snapshot.accountName,
            alias: meta.alias || snapshot.accountName,
            direction: 'Unknown',
            target: Number(meta.targetProfit) || 0,
            firstDate: dailyImport.date,
            passDate: null,
            fired: false,
          };
          accounts.set(key, record);
        }

        const bbStrategy = (snapshot.strategies || []).find(isBulletBotStrategy);
        if (bbStrategy && record.direction === 'Unknown') {
          record.direction = normalizeDirection(bbStrategy.direction);
        }

        const traded = (dailyImport.executions || []).some((e) => e.accountName === snapshot.accountName)
          || (snapshot.strategies || []).some((s) => Number(s.realized || 0) !== 0);
        if (traded) record.fired = true;

        const target = Number(meta.targetProfit) || record.target;
        if (target > 0) record.target = target;
        if (target > 0 && !record.passDate && Number(snapshot.accountBalance) >= target) {
          record.passDate = dailyImport.date;
        }
      }
    }
  }

  const list = [...accounts.values()].map((r) => ({
    ...r,
    passed: Boolean(r.passDate),
    daysToPass: r.passDate ? daysBetween(r.firstDate, r.passDate) : null,
  }));

  return {
    accounts: list,
    overall: summarize(list),
    long: summarize(list.filter((r) => r.direction === 'Long')),
    short: summarize(list.filter((r) => r.direction === 'Short')),
  };
}
