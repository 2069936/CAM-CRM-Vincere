import { reconcileDailyImport } from './reconcile.js';
import { parseNinjaTraderFileDate, parseNinjaTraderFileTimeKey } from './csvImport.js';

const TYPES = ['accounts', 'strategies', 'orders', 'executions'];

// Group already-parsed NinjaTrader files by the export date in their filename (falling
// back to fallbackDate when a name carries no date). If the same grid is exported more
// than once for a day, keep only the most recent one by the time stamp in the name, so a
// bad export followed by a good re-export doesn't double-count. Returns
// { [date]: { accounts, strategies, orders, executions } }.
export function groupParsedFilesByDate(parsedFiles = [], fallbackDate) {
  const chosen = {}; // `${date}|${type}` -> { date, type, rows, recency }
  for (const file of parsedFiles) {
    if (!file || !file.type || file.type === 'unknown') continue;
    const date = parseNinjaTraderFileDate(file.fileName) || fallbackDate;
    if (!date) continue;
    const recency = parseNinjaTraderFileTimeKey(file.fileName);
    const key = `${date}|${file.type}`;
    if (!chosen[key] || recency >= chosen[key].recency) {
      chosen[key] = { date, type: file.type, rows: file.rows || [], recency };
    }
  }
  const byDate = {};
  for (const { date, type, rows } of Object.values(chosen)) {
    if (!byDate[date]) byDate[date] = { accounts: [], strategies: [], orders: [], executions: [] };
    byDate[date][type] = rows;
  }
  return byDate;
}

// Build a full multi-day import plan from parsed files. For each date found, match
// clients by the account names present that day and reconcile each client's close for
// that date. The caller confirms and persists the per-(date, client) results.
export function buildBatchImportPlan({ parsedFiles = [], clients = [], fallbackDate }) {
  const byDate = groupParsedFilesByDate(parsedFiles, fallbackDate);
  const dates = Object.keys(byDate).sort();
  const registeredNamesLower = new Set(clients.flatMap((client) =>
    Object.keys(client.accountRegistry || {}).map((name) => name.toLowerCase())));

  const groups = dates.map((date) => {
    const grouped = byDate[date];
    const accountNamesLower = new Set(
      (grouped.accounts || []).map((a) => String(a.accountName || '').toLowerCase()),
    );

    const clientMatches = clients
      .map((client) => {
        const myAccounts = Object.keys(client.accountRegistry || {}).filter((an) =>
          accountNamesLower.has(an.toLowerCase()),
        );
        if (!myAccounts.length) return null;
        const mine = new Set(myAccounts.map((a) => a.toLowerCase()));
        const filtered = {};
        for (const type of TYPES) {
          filtered[type] = (grouped[type] || []).filter((row) =>
            mine.has(String(row.accountName || '').toLowerCase()),
          );
        }
        try {
          const result = reconcileDailyImport({
            clientId: client.id,
            date,
            registry: client.accountRegistry,
            parsed: filtered,
          });
          return { clientId: client.id, clientName: client.name, result, accountCount: myAccounts.length };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const unmatched = [...new Set((grouped.accounts || []).map((a) => a.accountName))].filter(
      (an) => !registeredNamesLower.has(String(an).toLowerCase()),
    );

    return { date, clientMatches, unmatched, accountsInFile: accountNamesLower.size };
  });

  return {
    dates: groups,
    datesCount: dates.length,
    filesLoaded: parsedFiles.length,
    totalMatches: groups.reduce((n, g) => n + g.clientMatches.length, 0),
  };
}
