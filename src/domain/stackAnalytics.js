// Per-account history analytics for the Stack Playbook.
//
// The CRM stores months of daily imports but the Playbook only ever read "today".
// These helpers turn an account's stored daily snapshots into time series so we
// can chart the equity curve, the drawdown-buffer trajectory (and project days
// to breach), and win/loss streaks — all from data already persisted.

// Chronological per-account series: one point per day the account appears in an
// import. cumPnl is the running sum of daily realized PnL.
export function buildAccountEquitySeries(client, accountName) {
  const lower = String(accountName || '').toLowerCase();

  // CSV closes by date (carry balance + trailing).
  const csvByDate = new Map();
  for (const di of client?.dailyImports || []) {
    if (!di.date) continue;
    const snapshot = (di.snapshots || []).find(
      (s) => String(s.accountName || '').toLowerCase() === lower,
    );
    if (snapshot) csvByDate.set(di.date, snapshot);
  }

  // Log-derived PnL points backfill days with no CSV close (activity entries the
  // NinjaTrader log backfill saved). CSV always wins for a given date.
  const logByDate = new Map();
  for (const entry of client?.activityLog || []) {
    if (entry.logPnl == null || !entry.logDate) continue;
    if (String(entry.accountName || '').toLowerCase() !== lower) continue;
    if (csvByDate.has(entry.logDate)) continue;
    logByDate.set(entry.logDate, Number(entry.logPnl));
  }

  const dates = [...new Set([...csvByDate.keys(), ...logByDate.keys()])].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );

  const series = [];
  let cumPnl = 0;
  for (const date of dates) {
    const snapshot = csvByDate.get(date);
    const dayPnl = snapshot ? Number(snapshot.grossRealizedPnl || 0) : logByDate.get(date);
    cumPnl += dayPnl;
    series.push({
      date,
      dayPnl,
      cumPnl,
      balance: snapshot ? Number(snapshot.accountBalance || 0) : 0,
      trailing: snapshot ? Number(snapshot.trailingMaxDrawdown || 0) : 0,
      source: snapshot ? 'csv' : 'log',
    });
  }
  return series;
}

// The drawdown buffer for a point: configured limit minus used, or (when no limit
// is set) the trailing value itself IS the remaining buffer.
function bufferAt(point, ddLimit) {
  return ddLimit > 0 ? ddLimit - Math.abs(point.trailing) : point.trailing;
}

// Fit a line to the recent buffer trajectory and project days until it hits zero
// (breach). Returns null when there is not enough data or the buffer is not
// shrinking. Positive slope => growing/stable buffer => daysToBreach null.
export function projectDaysToBreach(series, ddLimit = 0, lookback = 7) {
  const pts = series
    .slice(-lookback)
    .map((p, i) => ({ i, buffer: bufferAt(p, ddLimit) }))
    .filter((p) => Number.isFinite(p.buffer));
  if (pts.length < 2) return null;
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.i, 0);
  const sumY = pts.reduce((s, p) => s + p.buffer, 0);
  const sumXY = pts.reduce((s, p) => s + p.i * p.buffer, 0);
  const sumXX = pts.reduce((s, p) => s + p.i * p.i, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom; // buffer change per day
  const current = pts[pts.length - 1].buffer;
  if (slope >= 0) return { slope, current, daysToBreach: null };
  return { slope, current, daysToBreach: Math.max(0, Math.round(current / -slope)) };
}

// Win rate + current/longest win & loss streaks over the series. Flat days
// (dayPnl === 0) are skipped so they neither extend nor break a streak.
export function buildAccountStreaks(series) {
  let curWin = 0;
  let curLoss = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let wins = 0;
  let tradingDays = 0;
  let lastSign = 0;
  for (const point of series) {
    if (point.dayPnl === 0) continue;
    tradingDays += 1;
    if (point.dayPnl > 0) {
      wins += 1;
      curWin += 1;
      curLoss = 0;
      longestWin = Math.max(longestWin, curWin);
      lastSign = 1;
    } else {
      curLoss += 1;
      curWin = 0;
      longestLoss = Math.max(longestLoss, curLoss);
      lastSign = -1;
    }
  }
  const currentStreak = lastSign > 0 ? curWin : lastSign < 0 ? -curLoss : 0;
  return {
    winRate: tradingDays ? Math.round((wins / tradingDays) * 100) : 0,
    currentStreak,
    longestWin,
    longestLoss,
    tradingDays,
  };
}

// The prop firm behind a snapshot's free-text `connection`. The book spells
// BluSky eleven ways and Legends eight; a heatmap with a column per spelling
// compares a firm against itself. Punctuation, case and spacing are dropped
// before the lookup, so "Blusky ", "BLUSKY" and "Blue Sky" are one key. A name
// the table does not know is kept as typed rather than guessed.
const FIRM_ALIASES = {
  blusky: 'BluSky', bluesky: 'BluSky', blsky: 'BluSky', bluesky1: 'BluSky',
  legends: 'Legends', legend: 'Legends', legendstrading: 'Legends', thelegends: 'Legends', thelegendstrading: 'Legends',
  lucid: 'Lucid', lucidtradovate: 'Lucid',
  tradeify: 'Tradeify', tradefify: 'Tradeify',
  mff: 'My Funded Futures', myff: 'My Funded Futures', myfundedfutures: 'My Funded Futures', fundedfutures: 'My Funded Futures',
  fundedff: 'My Funded Futures', fffamily: 'My Funded Futures', fundedfuturesfamily: 'My Funded Futures',
  apex: 'Apex',
  takeprofittrader: 'TakeProfitTrader', takept: 'TakeProfitTrader',
  bulenox: 'Bulenox',
  tradeday: 'Tradeday',
  tradovate: 'Tradovate',
  live: 'Live', live1: 'Live',
};

export function normalizeFirmName(connection) {
  const raw = String(connection || '').trim();
  if (!raw) return 'Unknown';
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return FIRM_ALIASES[key] || raw;
}

const fundedOnly = (meta) => meta?.accountType === 'Funded';

// Cross-tab combo (row) x prop firm (col) -> avg P&L per account day per cell.
// Different firms have different drawdown mechanics, so the best combo can be
// firm-dependent. comboFn(snapshot, executionsForAccount) maps an account day
// to a combo label, the same function the team table uses, and the population
// is the same one too: the heatmap used to average every account day of every
// type, evaluations and Bullet Bot included, two panels below a table that did
// not, and the two disagreed on every cell.
//
// `window` ({ from, to }, inclusive, YYYY-MM-DD) is the same resolved window the
// table runs on. Without it the heatmap stayed on all history while the caption
// claimed the table's population: on the book, "Last 7 days" left the table on
// 302 account days and the heatmap on 599. Omit it and the cross-tab covers
// every close, which is what the callers that have no window selector want.
export function buildComboByFirm(clients = [], comboFn = () => 'Unknown', { populationFilter = fundedOnly, normalizeFirm = normalizeFirmName, window = null } = {}) {
  const cells = {};
  const combos = new Set();
  const firms = new Set();
  const inRange = (date) => {
    if (!window) return true;
    const { from, to } = window;
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
  };
  for (const client of clients || []) {
    const registry = Object.fromEntries(
      Object.entries(client.accountRegistry || {}).map(([name, meta]) => [String(name).toLowerCase(), meta]),
    );
    for (const di of client.dailyImports || []) {
      if (!inRange(di.date)) continue;
      for (const snapshot of di.snapshots || []) {
        const name = String(snapshot.accountName || '').toLowerCase();
        if (populationFilter && !populationFilter(registry[name] || {}, snapshot)) continue;
        const executions = (di.executions || []).filter((e) => String(e.accountName || '').toLowerCase() === name);
        const combo = comboFn(snapshot, executions);
        if (!combo || combo === 'Unknown') continue;
        const firm = normalizeFirm(snapshot.connection);
        combos.add(combo);
        firms.add(firm);
        const key = `${combo}|${firm}`;
        if (!cells[key]) cells[key] = { pnl: 0, days: 0 };
        cells[key].pnl += Number(snapshot.grossRealizedPnl || 0);
        cells[key].days += 1;
      }
    }
  }
  const comboList = [...combos];
  const firmList = [...firms];
  return {
    combos: comboList,
    firms: firmList,
    matrix: comboList.map((combo) => ({
      combo,
      cells: firmList.map((firm) => {
        const c = cells[`${combo}|${firm}`];
        return { firm, avgPnl: c && c.days ? c.pnl / c.days : null, days: c ? c.days : 0 };
      }),
    })),
  };
}
