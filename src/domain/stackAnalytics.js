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
  const imports = [...(client?.dailyImports || [])].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );
  const series = [];
  let cumPnl = 0;
  for (const di of imports) {
    const snapshot = (di.snapshots || []).find(
      (s) => String(s.accountName || '').toLowerCase() === lower,
    );
    if (!snapshot) continue;
    const dayPnl = Number(snapshot.grossRealizedPnl || 0);
    cumPnl += dayPnl;
    series.push({
      date: di.date || '',
      dayPnl,
      cumPnl,
      balance: Number(snapshot.accountBalance || 0),
      trailing: Number(snapshot.trailingMaxDrawdown || 0),
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
