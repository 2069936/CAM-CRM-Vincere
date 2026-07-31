import { buildPerformanceSeries, summarizePerformance } from '../domain/performanceSeries';

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function percent(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value) >= 0 ? '' : '-'}${Math.abs(Number(value)).toFixed(1)}%`;
}

const W = 600;
const H = 130;
const PAD = 10;

function scaleX(index, count) {
  if (count <= 1) return W / 2;
  return PAD + (index / (count - 1)) * (W - 2 * PAD);
}

// Zero is always in range. A cumulative curve that never dips below its own
// floor would otherwise render its worst day at the very bottom of the box and
// read as a collapse.
function scaleFactory(values) {
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const spread = hi - lo || 1;
  return {
    y: (value) => PAD + (1 - (value - lo) / spread) * (H - 2 * PAD),
    lo,
    hi,
  };
}

/**
 * Cumulative P&L, in dollars or as a chain-linked return.
 *
 * Same curve either way — the unit is the only difference, which is why this is
 * one chart with a switch rather than two charts that would sit next to each
 * other telling the same story twice.
 */
export function CumulativePnlChart({ points, asPercent = false }) {
  const usable = asPercent
    ? points.filter((point) => point.cumulativeReturnPct !== null)
    : points;
  if (usable.length < 2) {
    return <p className="muted chart-empty">Not enough history to chart yet.</p>;
  }

  const pick = (point) => (asPercent ? point.cumulativeReturnPct : point.cumulativePnl);
  const values = usable.map(pick);
  const scale = scaleFactory(values);
  const pts = usable
    .map((point, index) => `${scaleX(index, usable.length).toFixed(1)},${scale.y(pick(point)).toFixed(1)}`)
    .join(' ');
  const zeroY = scale.y(0);
  const last = usable[usable.length - 1];
  const positive = pick(last) >= 0;
  const stroke = positive ? 'var(--success)' : 'var(--error)';
  const label = asPercent
    ? `Cumulative return, ending at ${percent(pick(last))}`
    : `Cumulative profit and loss, ending at ${money(pick(last))}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ width: '100%', height: 132, display: 'block' }}
    >
      <title>{label}</title>
      <line
        x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY}
        stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={`${PAD},${zeroY} ${pts} ${W - PAD},${zeroY}`}
        fill={stroke} opacity="0.12" stroke="none"
      />
      <polyline
        points={pts} fill="none" stroke={stroke} strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={scaleX(usable.length - 1, usable.length)} cy={scale.y(pick(last))}
        r="3.5" fill={stroke} vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * One bar per trading day, coloured by sign.
 *
 * Colour is not the only cue: every bar sits above or below the zero line, so
 * the shape reads without relying on the red/green difference.
 */
export function DailyPnlChart({ points }) {
  if (!points.length) {
    return <p className="muted chart-empty">Not enough history to chart yet.</p>;
  }

  const values = points.map((point) => point.dailyPnl);
  const scale = scaleFactory(values);
  const zeroY = scale.y(0);
  const slot = (W - 2 * PAD) / points.length;
  const barWidth = Math.max(2, Math.min(18, slot * 0.62));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Daily profit and loss across ${points.length} trading days`}
      style={{ width: '100%', height: 132, display: 'block' }}
    >
      <title>{`Daily profit and loss across ${points.length} trading days`}</title>
      {points.map((point, index) => {
        const y = scale.y(point.dailyPnl);
        const top = Math.min(y, zeroY);
        const height = Math.max(1, Math.abs(y - zeroY));
        const x = PAD + slot * index + (slot - barWidth) / 2;
        return (
          <rect
            key={point.date}
            x={x} y={top} width={barWidth} height={height} rx="2"
            fill={point.dailyPnl >= 0 ? 'var(--success)' : 'var(--error)'}
          >
            <title>{`${point.date}: ${money(point.dailyPnl)}`}</title>
          </rect>
        );
      })}
      <line
        x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY}
        stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function PerformanceCharts({
  history = [],
  showCumulative = true,
  showDaily = true,
  asPercent = false,
}) {
  if (!showCumulative && !showDaily) return null;
  const points = buildPerformanceSeries(history);
  if (points.length < 2) return null;
  const summary = summarizePerformance(points);
  const percentUnavailable = asPercent && summary.returnPct === null;

  return (
    <section className="report-section report-performance">
      <h4>Performance</h4>
      <div className="report-performance-summary">
        <div>
          <span>Net P&amp;L</span>
          <strong className={summary.netPnl >= 0 ? 'positive' : 'negative'}>
            {money(summary.netPnl)}
          </strong>
        </div>
        {summary.returnPct !== null ? (
          <div>
            <span>Return on capital</span>
            <strong className={summary.returnPct >= 0 ? 'positive' : 'negative'}>
              {percent(summary.returnPct)}
            </strong>
          </div>
        ) : null}
        <div>
          <span>Green days</span>
          <strong>{summary.greenDays} / {summary.tradingDays}</strong>
        </div>
        <div>
          <span>Deepest dip</span>
          <strong className={summary.maxDrawdown < 0 ? 'negative' : ''}>
            {money(summary.maxDrawdown)}
          </strong>
        </div>
      </div>

      {showCumulative ? (
        <div className="report-chart">
          <span className="report-chart-label">
            {asPercent && !percentUnavailable ? 'Cumulative return' : 'Cumulative P&L'}
          </span>
          {percentUnavailable ? (
            // Say so rather than silently falling back to dollars under a
            // heading that promises a percentage.
            <p className="muted chart-empty">
              No capital on record for these days, so a percentage cannot be shown.
            </p>
          ) : (
            <CumulativePnlChart points={points} asPercent={asPercent} />
          )}
        </div>
      ) : null}

      {showDaily ? (
        <div className="report-chart">
          <span className="report-chart-label">Daily P&amp;L</span>
          <DailyPnlChart points={points} />
        </div>
      ) : null}
    </section>
  );
}
