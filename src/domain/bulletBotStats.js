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
//
// WARNING on `fired`. It means "this account traded", NOT "this account blew
// up". On the real book the two are nowhere near each other: 147 records are
// fired, while only 29 Bullet Bot accounts carry status 'Failed', and 13 of the
// 22 accounts that reached target are also flagged fired — i.e. the same
// account is counted as fired and passed. Anything that wants the failure count
// must read status, not this flag. buildBulletBotDeskStats does exactly that and
// renames the concepts (traded / failed) so a manager cannot misread them.

import { ACCOUNT_TYPES } from './reconcile';
import { inferStartingBalance, targetForAccount } from './accountTargets';

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

function blankRecord(client, meta, accountName, firstDate) {
  return {
    clientId: client.id,
    clientName: client.name,
    accountName,
    alias: meta.alias || accountName,
    direction: 'Unknown',
    target: 0,
    firstDate,
    passDate: null,
    fired: false,
    // Everything below is additive for buildBulletBotDeskStats. The legacy
    // return shape above is untouched: StackPlaybook reads overall/long/short.
    targetSource: null,
    status: meta.status || '',
    dateAdded: meta.dateAdded || '',
    dateFailed: meta.dateFailed || '',
    // The bullet_bot_direction column, kept separate because it loses to the
    // strategy rows: it is populated on 11 of 244 accounts and disagrees with
    // the strategy rows on 3 of those 11.
    directionColumn: normalizeDirection(meta.bulletBotDirection),
    // Every direction the strategy rows show for this account over time. 7 real
    // accounts carry both Long and Short rows, which the first-row-wins
    // `direction` field silently reports as whichever came first.
    directionsSeen: [],
    firstBalance: null,
    lastDate: firstDate,
    observedDays: 0,
  };
}

/**
 * Per-account Bullet Bot records — the shared walk behind both the StackPlaybook
 * summary and the desk-level module.
 *
 * Defaults reproduce the original behaviour exactly (236 records, 22 passed,
 * 147 fired on the real book) so buildBulletBotStats keeps returning what
 * StackPlaybook has always rendered. The desk module opts into the two fixes:
 *
 *   inferTargets — 95 of 244 Bullet Bot accounts have no target_profit, so they
 *     can never satisfy `balance >= target` and land in the pass-rate
 *     denominator as if they had failed. 89 of them sit within ±20% of 50,000
 *     on their first snapshot, which accountTargets already knows means a 53,000
 *     target. Without this the panel understates every pass rate by ~40%.
 *   includeUnobserved — 4 Bullet Bot accounts have no account_snapshots row at
 *     all. They still carry a status in the book of record, so a desk-level
 *     failure count that skips them is wrong by construction.
 */
export function buildBulletBotAccountRecords(clients = [], {
  inferTargets = false,
  includeUnobserved = false,
} = {}) {
  const accounts = new Map();
  // Case-insensitive key: accountMetaFor already matches the registry
  // case-insensitively, so keying the record on the raw snapshot spelling could
  // split one account into two records fed by the same registry row.
  const keyFor = (client, accountName) => `${client.id}:${String(accountName || '').toLowerCase()}`;

  for (const client of clients || []) {
    const imports = [...(client.dailyImports || [])]
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    for (const dailyImport of imports) {
      for (const snapshot of dailyImport.snapshots || []) {
        const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
        if (meta.accountType !== ACCOUNT_TYPES.EVALUATION_BULLET) continue;

        const key = keyFor(client, snapshot.accountName);
        let record = accounts.get(key);
        if (!record) {
          record = blankRecord(client, meta, snapshot.accountName, dailyImport.date);
          record.firstBalance = Number(snapshot.accountBalance);
          record.target = Number(meta.targetProfit) || 0;
          if (record.target > 0) {
            record.targetSource = 'account';
          } else if (inferTargets) {
            // start_balance is set on 93 of 244, so the first observed balance
            // is the fallback the other 151 need.
            const size = inferStartingBalance(Number(meta.startBalance) || Number(snapshot.accountBalance));
            const inferred = size != null ? targetForAccount(ACCOUNT_TYPES.EVALUATION_BULLET, size) : null;
            if (inferred) {
              record.target = inferred;
              record.targetSource = 'inferred';
            }
          }
          accounts.set(key, record);
        }
        record.lastDate = dailyImport.date;
        record.observedDays += 1;

        const bbStrategy = (snapshot.strategies || []).find(isBulletBotStrategy);
        if (bbStrategy) {
          const seen = normalizeDirection(bbStrategy.direction);
          if (record.direction === 'Unknown') record.direction = seen;
          if (seen !== 'Unknown' && !record.directionsSeen.includes(seen)) record.directionsSeen.push(seen);
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

    if (includeUnobserved) {
      for (const [accountName, meta] of Object.entries(client?.accountRegistry || {})) {
        if (meta?.accountType !== ACCOUNT_TYPES.EVALUATION_BULLET) continue;
        const key = keyFor(client, accountName);
        if (accounts.has(key)) continue;
        const record = blankRecord(client, meta, accountName, '');
        record.lastDate = '';
        record.target = Number(meta.targetProfit) || 0;
        if (record.target > 0) record.targetSource = 'account';
        accounts.set(key, record);
      }
    }
  }

  return [...accounts.values()].map((r) => ({
    ...r,
    passed: Boolean(r.passDate),
    daysToPass: r.passDate ? daysBetween(r.firstDate, r.passDate) : null,
    // Already at or above target the first day we ever saw the account: the
    // pass is real, its duration is not. 9 of the 22 passes are like this, and
    // averaging their zeros in is what drags avgDaysToPass (5.36) below both
    // long (6.0) and short (8.33) — a mean lower than every one of its parts.
    censored: Boolean(r.passDate) && r.passDate === r.firstDate,
  }));
}

export function buildBulletBotStats(clients = []) {
  const list = buildBulletBotAccountRecords(clients);

  return {
    accounts: list,
    overall: summarize(list),
    long: summarize(list.filter((r) => r.direction === 'Long')),
    short: summarize(list.filter((r) => r.direction === 'Short')),
  };
}
