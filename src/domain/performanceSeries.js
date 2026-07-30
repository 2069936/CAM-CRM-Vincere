// Performance series for the client report.
//
// The report has always shown numbers, never a shape. A CAM answering "how have
// I been doing?" had to read a table of days. These series turn the same data
// into the two questions clients actually ask: how much have I made since I
// started, and how consistent has it been.
//
// Nothing here reads balance as performance. A balance line rises when a client
// funds an account and falls when they take a payout, neither of which is
// trading. Cumulative P&L is the sum of what was earned, so deposits and
// withdrawals leave it alone.

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Capital the client had working at the start of a day.
 *
 * Derived from that same day's closing balance minus what the day earned,
 * rather than from the previous day's close. The two agree on an ordinary day,
 * but they differ exactly when it matters: if an account is opened today, its
 * balance is in today's close and the previous day knows nothing about it.
 * Using the previous close would divide today's P&L by a base that excludes
 * capital the client actually had, inflating the return.
 */
function capitalAtStartOfDay(day) {
  return numeric(day.balance) - numeric(day.dailyPnl);
}

/**
 * Chain-linked (time-weighted) return.
 *
 * The naive alternative — cumulative P&L over today's balance — reports a fall
 * whenever a client adds an account, because the denominator jumps while the
 * numerator does not. That prints a loss on the days a client is growing, which
 * is both wrong and the worst possible moment to be wrong.
 *
 * Compounding each day's return against the capital in play that day removes
 * the effect of money entering and leaving. It is the standard treatment for a
 * portfolio with contributions, and it is what makes a percentage comparable
 * between a 50k client and a 150k one.
 */
export function buildPerformanceSeries(history = []) {
  const days = (history || [])
    .filter((day) => day && day.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let cumulativePnl = 0;
  let growth = 1;
  let hasUsableCapital = false;

  const points = days.map((day) => {
    const dailyPnl = numeric(day.dailyPnl);
    const base = capitalAtStartOfDay(day);
    cumulativePnl += dailyPnl;

    // A non-positive base means no capital was working, so a percentage would
    // be a division by zero dressed up as a number. The day still counts in
    // dollars; it just cannot move the percentage.
    const dailyReturnPct = base > 0 ? (dailyPnl / base) * 100 : null;
    if (dailyReturnPct !== null) {
      growth *= 1 + dailyPnl / base;
      hasUsableCapital = true;
    }

    return {
      date: day.date,
      dailyPnl,
      cumulativePnl,
      capitalBase: base,
      dailyReturnPct,
      cumulativeReturnPct: hasUsableCapital ? (growth - 1) * 100 : null,
      accounts: numeric(day.accounts),
    };
  });

  return points;
}

/**
 * Headline figures shown above the charts.
 *
 * maxDrawdown is measured on cumulative P&L, not on balance: it answers "how
 * far below your best did you get" in money the client earned, which is the
 * drawdown a trader recognises.
 */
export function summarizePerformance(points = []) {
  if (!points.length) {
    return {
      netPnl: 0,
      returnPct: null,
      greenDays: 0,
      tradingDays: 0,
      bestDay: null,
      worstDay: null,
      maxDrawdown: 0,
    };
  }

  let peak = 0;
  let maxDrawdown = 0;
  let greenDays = 0;
  let bestDay = points[0];
  let worstDay = points[0];

  for (const point of points) {
    if (point.dailyPnl > 0) greenDays += 1;
    if (point.dailyPnl > bestDay.dailyPnl) bestDay = point;
    if (point.dailyPnl < worstDay.dailyPnl) worstDay = point;
    if (point.cumulativePnl > peak) peak = point.cumulativePnl;
    const drawdown = point.cumulativePnl - peak;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }

  const last = points[points.length - 1];
  return {
    netPnl: last.cumulativePnl,
    returnPct: last.cumulativeReturnPct,
    greenDays,
    tradingDays: points.length,
    bestDay,
    worstDay,
    maxDrawdown,
  };
}
