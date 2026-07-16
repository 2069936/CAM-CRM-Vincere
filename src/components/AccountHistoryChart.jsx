import { projectDaysToBreach, buildAccountStreaks } from '../domain/stackAnalytics';

function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));
}

// Single-series SVG line over a full-width viewBox. vector-effect keeps the 2px
// stroke crisp regardless of horizontal scaling, so we can stretch to container
// width without distorting the mark. baseline draws a dashed reference line.
function MiniLine({ series, pick, color, fill, baseline = null, title }) {
  const w = 600;
  const h = 90;
  const pad = 8;
  const values = series.map(pick);
  const lo = Math.min(...values, baseline != null ? baseline : Infinity);
  const hi = Math.max(...values, baseline != null ? baseline : -Infinity);
  const spread = hi - lo || 1;
  const X = (i) => pad + (series.length === 1 ? 0 : (i / (series.length - 1)) * (w - 2 * pad));
  const Y = (v) => pad + (1 - (v - lo) / spread) * (h - 2 * pad);
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(pick(p)).toFixed(1)}`).join(' ');
  const areaPts = `${pad},${h - pad} ${pts} ${w - pad},${h - pad}`;
  const last = series[series.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={title} style={{ width: '100%', height: 74, display: 'block' }}>
      <title>{title}</title>
      {baseline != null ? (
        <line x1={pad} x2={w - pad} y1={Y(baseline)} y2={Y(baseline)} stroke="var(--error)" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity="0.75" />
      ) : null}
      {fill ? <polyline points={areaPts} fill={fill} stroke="none" /> : null}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(series.length - 1)} cy={Y(pick(last))} r="3.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Colour the buffer line by how close it is to breach (status, not identity).
function bufferColor(buffer) {
  if (buffer <= 500) return 'var(--error)';
  if (buffer <= 1200) return 'var(--warning)';
  return 'var(--success)';
}

export default function AccountHistoryChart({ series = [], ddLimit = 0, alias = 'Account' }) {
  if (series.length < 2) {
    return <div className="muted" style={{ fontSize: 12 }}>Not enough history yet for {alias} — needs at least two closes.</div>;
  }

  const streaks = buildAccountStreaks(series);
  const finalCum = series[series.length - 1].cumPnl;
  const buffer = (p) => (ddLimit > 0 ? ddLimit - Math.abs(p.trailing) : p.trailing);
  const currentBuffer = buffer(series[series.length - 1]);
  const breach = projectDaysToBreach(series, ddLimit);
  const hasBuffer = series.some((p) => Number.isFinite(buffer(p)) && buffer(p) !== 0);

  const start = series[0].date;
  const end = series[series.length - 1].date;

  // Consistency strip: last 60 trading days as green/red cells, intensity by size.
  const strip = series.slice(-60);
  const maxAbsDay = Math.max(1, ...strip.map((p) => Math.abs(p.dayPnl)));

  return (
    <div className="account-history-chart">
      <div className="ahc-charts">
        <div className="ahc-plot">
          <div className="ahc-plot-head">
            <span className="muted">Cumulative PnL</span>
            <strong className={finalCum >= 0 ? 'positive' : 'negative'}>{money(finalCum)}</strong>
          </div>
          <MiniLine
            series={series}
            pick={(p) => p.cumPnl}
            color="var(--accent)"
            fill="rgba(var(--accent-rgb), 0.12)"
            baseline={0}
            title={`${alias} cumulative PnL ${start} to ${end}: ${money(finalCum)}`}
          />
        </div>

        {hasBuffer ? (
          <div className="ahc-plot">
            <div className="ahc-plot-head">
              <span className="muted">Drawdown buffer</span>
              <strong style={{ color: bufferColor(currentBuffer) }}>{money(currentBuffer)}</strong>
            </div>
            <MiniLine
              series={series}
              pick={buffer}
              color={bufferColor(currentBuffer)}
              baseline={0}
              title={`${alias} drawdown buffer, breach at 0. Current ${money(currentBuffer)}`}
            />
          </div>
        ) : null}
      </div>

      <div className="ahc-consistency" aria-label="Daily result history">
        {strip.map((p, i) => {
          const color = p.dayPnl > 0 ? 'var(--success)' : p.dayPnl < 0 ? 'var(--error)' : 'var(--surface-3)';
          const opacity = p.dayPnl === 0 ? 0.4 : 0.35 + 0.65 * (Math.abs(p.dayPnl) / maxAbsDay);
          return (
            <span
              key={`${p.date}-${i}`}
              className="ahc-cell"
              title={`${p.date}: ${money(p.dayPnl)}`}
              style={{ background: color, opacity }}
            />
          );
        })}
      </div>

      <div className="ahc-stats">
        <span>Win rate <strong>{streaks.winRate}%</strong></span>
        <span>
          Streak{' '}
          <strong className={streaks.currentStreak >= 0 ? 'positive' : 'negative'}>
            {streaks.currentStreak > 0 ? `${streaks.currentStreak}W` : streaks.currentStreak < 0 ? `${-streaks.currentStreak}L` : '-'}
          </strong>
        </span>
        <span className="muted">Best {streaks.longestWin}W · {streaks.longestLoss}L</span>
        {breach?.daysToBreach != null ? (
          <span className={breach.daysToBreach <= 5 ? 'negative' : ''}>
            ~{breach.daysToBreach}d to breach
          </span>
        ) : hasBuffer ? (
          <span className="muted">buffer stable</span>
        ) : null}
        <span className="muted">{streaks.tradingDays} trading days</span>
      </div>
    </div>
  );
}
