// Weekly PnL and trailing drawdown, derived from the closes we already store.
//
// A fallback, not the primary source. NinjaTrader's *documented* AccountItem
// list has 25 members and mentions neither, but a real 8.1.7.2 install reports
// 31 — including WeeklyProfitLoss and TrailingMaxDrawdown. The collector reads
// them from there when present, so this runs only when a value is genuinely
// absent: an install whose enum lacks the member, a connection that does not
// answer for it, or a manual CSV exported without the column enabled.
//
// The two are NOT equally trustworthy, and the difference matters:
//
//   Weekly PnL is exact. It is the sum of realized PnL over the trading week,
//   and we hold every day of it.
//
//   Trailing drawdown is a LOWER BOUND. It measures how far an account has
//   fallen from its peak, and we only see end-of-day balances. If a prop firm
//   trails from the intraday high, the real peak was higher than any close we
//   recorded, so the real drawdown is worse than what we compute — never better.
//   Everything downstream must treat it as "at least this bad", which is why it
//   is reported with a source and why callers widen their thresholds for it.

const MS_PER_DAY = 86400000;

function toDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

/** Monday of the week containing the date. Closes are Mon-Fri, so a
 *  Sunday-start futures week would sum identically. */
export function weekStart(date) {
  const day = toDate(date);
  if (!day) return '';
  const parsed = new Date(`${day}T12:00:00Z`);
  const weekday = parsed.getUTCDay();            // 0 = Sunday
  const backToMonday = weekday === 0 ? 6 : weekday - 1;
  return new Date(parsed.getTime() - backToMonday * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

// A null balance or PnL means the source had no value, not zero. Deriving from
// it would manufacture a confident-looking 0 — the exact failure this module
// exists to avoid — so those points are treated as absent.
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotFor(dailyImport, accountName) {
  const wanted = String(accountName || '').toLowerCase();
  return (dailyImport?.snapshots || []).find(
    (snapshot) => String(snapshot.accountName || '').toLowerCase() === wanted,
  ) || null;
}

/**
 * Realized PnL for the account across the trading week ending on the given date.
 * Exact — every day of the week is one of our own closes.
 */
export function deriveWeeklyPnl(dailyImports = [], accountName, asOfDate) {
  const day = toDate(asOfDate);
  const start = weekStart(day);
  if (!day || !start) return null;

  let total = 0;
  let days = 0;
  for (const dailyImport of dailyImports) {
    const date = toDate(dailyImport?.date);
    if (!date || date < start || date > day) continue;
    const snapshot = snapshotFor(dailyImport, accountName);
    if (!snapshot) continue;
    const pnl = numeric(snapshot.grossRealizedPnl);
    if (pnl === null) continue;
    total += pnl;
    days += 1;
  }
  if (!days) return null;
  return { value: total, source: 'derived', daysCounted: days, weekStart: start };
}

/**
 * How far the account has fallen from its highest recorded balance.
 *
 * Returns the same shape the Accounts grid reports (drawdown from peak, as a
 * positive number), plus the evidence behind it so a caller can judge how much
 * to trust it: the peak used, when it happened, how many closes it is based on,
 * and whether the history has holes.
 *
 * `startBalance` seeds the peak, so an account that only ever lost money still
 * measures from where it began rather than from its best bad day.
 */
export function deriveTrailingDrawdown(dailyImports = [], accountName, asOfDate, { startBalance = null } = {}) {
  const day = toDate(asOfDate);
  if (!day) return null;

  const balances = [];
  for (const dailyImport of dailyImports) {
    const date = toDate(dailyImport?.date);
    if (!date || date > day) continue;
    const snapshot = snapshotFor(dailyImport, accountName);
    if (!snapshot) continue;
    const balance = numeric(snapshot.accountBalance);
    if (balance === null) continue;
    balances.push({ date, balance });
  }
  if (!balances.length) return null;
  balances.sort((a, b) => a.date.localeCompare(b.date));

  const current = balances[balances.length - 1];
  if (current.date !== day) return null;   // no close for the day being asked about

  let peak = Number(startBalance) > 0 ? Number(startBalance) : balances[0].balance;
  let peakDate = balances[0].date;
  for (const point of balances) {
    if (point.balance > peak) {
      peak = point.balance;
      peakDate = point.date;
    }
  }

  // Gaps matter: a peak could have happened on a day we never received.
  const firstDate = balances[0].date;
  const spanDays = Math.round(
    (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${firstDate}T12:00:00Z`)) / MS_PER_DAY,
  );
  const weekdaysInSpan = countWeekdays(firstDate, day);
  const hasGaps = balances.length < weekdaysInSpan;

  return {
    // Positive = how far below the peak, matching the grid's reading.
    value: Math.max(0, peak - current.balance),
    source: 'derived',
    peak,
    peakDate,
    closesUsed: balances.length,
    spanDays,
    hasGaps,
    // An intraday peak we never saw would only make the real drawdown larger.
    isLowerBound: true,
  };
}

function countWeekdays(fromDate, toDateValue) {
  const start = Date.parse(`${fromDate}T12:00:00Z`);
  const end = Date.parse(`${toDateValue}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  let count = 0;
  for (let time = start; time <= end; time += MS_PER_DAY) {
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/**
 * Thresholds for acting on a drawdown number, widened when it is derived.
 *
 * A derived drawdown is a lower bound, so warning at the same level as a
 * reported one would warn too late on an account that is actually closer to its
 * limit than we can see. Doubling the margins costs a few early warnings and
 * buys not missing a real one.
 *
 * The widening exists because we do not know whether a firm trails from the
 * intraday high or from the daily close. Recording that per firm would make the
 * derivation exact where the basis is end-of-day, and honest about being
 * impossible where it is not — see docs/prop-firm-rules-catalog.md.
 */
export function drawdownThresholds(source) {
  return source === 'derived'
    ? { critical: 1000, warning: 2400 }
    : { critical: 500, warning: 1200 };
}
