// Tradovate / NinjaTrader-web CSV importer.
//
// NinjaTrader's web platform runs on Tradovate, and its exports (Orders, Fills,
// Position History, Performance) are a different shape from the desktop grid
// files the daily upload reads. What makes them valuable is that Tradovate
// reports realized P/L per closed trade directly — no reconstruction from
// executions and no instrument point-value table needed.
//
// The trade-off: these exports do NOT carry the NinjaTrader strategy/algo name,
// so this is account-level history, not per-algo. Account is Tradovate's numeric
// id, which has to be mapped to a CRM account by the caller.

const MONEY_RE = /^\$?\(?-?\$?([\d,]+(?:\.\d+)?)\)?$/;

// Tradovate writes negatives as "$(200.00)" in Performance and "-200.00" in
// Position History. Handle both, plus plain numbers.
export function parseTradovateMoney(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const negative = raw.includes('(') || raw.trimStart().startsWith('-');
  const match = raw.match(MONEY_RE);
  if (!match) {
    const n = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isNaN(n) ? 0 : n;
  }
  const n = Number(match[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return 0;
  return negative ? -n : n;
}

// MNQM6 -> MNQ, M2KU6 -> M2K, NGN6 -> NG. Strip the contract month letter and
// year digit(s) so trades roll up by instrument root.
export function tradovateInstrumentRoot(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  const match = s.match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return match ? match[1] : s;
}

// Tradovate timestamps look like "06/01/2026 09:17:47" (MM/DD/YYYY). Return the
// local ISO date (YYYY-MM-DD) without a timezone shift.
export function tradovateDate(value) {
  const raw = String(value || '').trim();
  const md = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (md) return `${md[3]}-${md[1]}-${md[2]}`;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : '';
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseRows(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
  return { headers, rows };
}

export function detectTradovateFileType(headers = []) {
  const set = new Set(headers.map((h) => String(h).trim()));
  // Performance: symbol, buy/sell fill ids, pnl, duration.
  if (set.has('symbol') && set.has('pnl') && set.has('duration')) return 'performance';
  // Position History: paired positions with P/L and a contract.
  if (set.has('Position ID') && set.has('P/L') && set.has('Contract')) return 'positionHistory';
  // Fills: individual fills.
  if (set.has('Fill ID') || (set.has('Fill Price') && set.has('Timestamp'))) return 'fills';
  // Orders.
  if (set.has('Order ID') && (set.has('Order Type') || set.has('Type')) && set.has('Status')) return 'orders';
  return 'unknown';
}

// Normalize the two P/L-bearing exports to one trade shape. Orders/Fills carry
// no realized P/L, so they are recognized but not summarized here.
export function parseTradovateCsv(csvText) {
  const { headers, rows } = parseRows(csvText);
  const type = detectTradovateFileType(headers);

  if (type === 'performance') {
    const trades = rows
      .filter((r) => r.symbol)
      .map((r) => ({
        account: '',
        symbol: r.symbol,
        instrument: tradovateInstrumentRoot(r.symbol),
        qty: Number(r.qty || 0),
        pnl: parseTradovateMoney(r.pnl),
        date: tradovateDate(r.soldTimestamp || r.boughtTimestamp),
        boughtAt: r.boughtTimestamp || '',
        soldAt: r.soldTimestamp || '',
        duration: r.duration || '',
      }));
    return { type, trades };
  }

  if (type === 'positionHistory') {
    const trades = rows
      .filter((r) => r.Contract)
      .map((r) => ({
        account: r.Account || '',
        symbol: r.Contract,
        instrument: r.Product || tradovateInstrumentRoot(r.Contract),
        qty: Number(r['Paired Qty'] || 0),
        pnl: parseTradovateMoney(r['P/L']),
        date: r['Trade Date'] || tradovateDate(r.Timestamp),
        boughtAt: r['Bought Timestamp'] || '',
        soldAt: r['Sold Timestamp'] || '',
        duration: '',
      }));
    return { type, trades };
  }

  return { type, trades: [] };
}

function parseDurationSeconds(text) {
  const raw = String(text || '');
  let total = 0;
  const h = raw.match(/(\d+)\s*h/);
  const m = raw.match(/(\d+)\s*min/);
  const s = raw.match(/(\d+)\s*sec/);
  if (h) total += Number(h[1]) * 3600;
  if (m) total += Number(m[1]) * 60;
  if (s) total += Number(s[1]);
  return total;
}

// Per-day realized P/L and win rate, oldest first — this is what feeds an
// equity curve or a history panel.
export function summarizeTradovateByDay(trades = []) {
  const byDate = new Map();
  for (const t of trades) {
    if (!t.date) continue;
    const day = byDate.get(t.date) || { date: t.date, realizedPnl: 0, trades: 0, wins: 0, losses: 0 };
    day.realizedPnl += t.pnl;
    day.trades += 1;
    if (t.pnl > 0) day.wins += 1;
    else if (t.pnl < 0) day.losses += 1;
    byDate.set(t.date, day);
  }
  return [...byDate.values()]
    .map((d) => ({ ...d, winRate: d.trades ? d.wins / d.trades : 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function summarizeTradovateByInstrument(trades = []) {
  const byInstr = new Map();
  for (const t of trades) {
    const key = t.instrument || t.symbol || 'Unknown';
    const row = byInstr.get(key) || { instrument: key, realizedPnl: 0, trades: 0, wins: 0 };
    row.realizedPnl += t.pnl;
    row.trades += 1;
    if (t.pnl > 0) row.wins += 1;
    byInstr.set(key, row);
  }
  return [...byInstr.values()]
    .map((r) => ({ ...r, winRate: r.trades ? r.wins / r.trades : 0 }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
}

// Whole-file rollup for one account's export.
export function summarizeTradovateAccount(trades = []) {
  const realizedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const durations = trades.map((t) => parseDurationSeconds(t.duration)).filter((n) => n > 0);
  const byDay = summarizeTradovateByDay(trades);
  const account = trades.find((t) => t.account)?.account || '';
  return {
    account,
    realizedPnl,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    avgDurationSec: durations.length
      ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length)
      : null,
    tradingDays: byDay.length,
    firstDate: byDay[0]?.date || '',
    lastDate: byDay[byDay.length - 1]?.date || '',
    byDay,
    byInstrument: summarizeTradovateByInstrument(trades),
  };
}
