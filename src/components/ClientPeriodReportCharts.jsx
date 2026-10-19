import { axisLabel, dayLabel, fmtMoney, niceStep } from '../domain/clientPeriodReport';

/**
 * The client period report's charts: inline SVG, drawn to scale, no library.
 *
 * Inline because the sheet is posted to /api/report/pdf as markup and rendered
 * under a CSP that loads nothing but the build's own stylesheet; a chart drawn
 * by script would arrive in the PDF as an empty box. Every chart takes the
 * report's own records and draws only what they hold: a day without a close
 * is a labelled hole, never a bar of zero height and never a line bridged
 * across it.
 */

const HOLE_LABEL = {
  gap: 'gap',
  missing: 'not loaded',
  noAccounts: 'none',
};

function labelEvery(count) {
  if (count > 15) return 5;
  if (count > 10) return 2;
  return 1;
}

const r1 = (value) => Math.round(value * 10) / 10;

/** Realized P&L per day, every real money account combined. */
export function DailyPnlBars({ days = [] }) {
  const W = 520;
  const H = 220;
  const L = 52;
  const R = 10;
  const T = 12;
  const B = 30;
  const values = days.filter((entry) => entry.state === 'close').map((entry) => entry.realized);
  if (!values.length) {
    return <p className="cpr-chart-empty">No close in this period carries a figure.</p>;
  }
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep(max - min, 4);
  const top = Math.ceil(max / step) * step || step;
  const bottom = Math.floor(min / step) * step;
  const y = (value) => T + ((top - value) / (top - bottom)) * (H - T - B);
  const n = days.length;
  const slot = (W - L - R) / n;
  const barWidth = Math.max(3, Math.min(28, slot * 0.62));
  const every = labelEvery(n);
  const ticks = [];
  for (let value = bottom; value <= top + 1e-9; value += step) ticks.push(Math.round(value * 100) / 100);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Realized P&L per day">
      {ticks.map((value) => (
        <g key={`t${value}`}>
          <line className={value === 0 ? 'cpr-zero-line' : 'cpr-grid-line'} x1={L} x2={W - R} y1={r1(y(value))} y2={r1(y(value))} />
          <text x={L - 6} y={r1(y(value) + 3)} textAnchor="end">{axisLabel(value, step)}</text>
        </g>
      ))}
      {days.map((entry, index) => {
        const cx = L + slot * index + slot / 2;
        const label = index % every === 0 || index === n - 1
          ? <text x={r1(cx)} y={H - 10} textAnchor="middle">{dayLabel(entry.date)}</text>
          : null;
        if (entry.state !== 'close') {
          return (
            <g key={entry.date}>
              <text className="cpr-hole-label" x={r1(cx)} y={r1(y(0) - 4)} textAnchor="middle">{HOLE_LABEL[entry.state]}</text>
              {label}
            </g>
          );
        }
        const y0 = y(0);
        const y1 = y(entry.realized);
        return (
          <g key={entry.date}>
            <rect
              className={entry.realized >= 0 ? 'cpr-bar-pos' : 'cpr-bar-neg'}
              x={r1(cx - barWidth / 2)}
              y={r1(Math.min(y0, y1))}
              width={r1(barWidth)}
              height={r1(Math.max(1, Math.abs(y1 - y0)))}
              rx="1.5"
            >
              <title>{`${dayLabel(entry.date, { long: true })}: ${fmtMoney(entry.realized, { sign: true })}`}</title>
            </rect>
            {label}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The combined balance at each close, from the close before the period.
 *
 * One slot per day, so a gap takes the room a day takes and the line breaks
 * there: a straight segment across a missing close would draw a balance
 * nobody reported.
 */
export function CombinedBalanceLine({ points = [] }) {
  const W = 520;
  const H = 220;
  const L = 58;
  const R = 18;
  const T = 14;
  const B = 30;
  const values = points.filter((point) => point.value != null).map((point) => point.value);
  if (!values.length) {
    return <p className="cpr-chart-empty">No close in this period carries a balance.</p>;
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = niceStep(hi - lo, 4);
  const bottom = Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step === bottom ? bottom + step : Math.ceil(hi / step) * step;
  const y = (value) => T + ((top - value) / (top - bottom)) * (H - T - B);
  const x = (index) => L + (W - L - R) * (points.length === 1 ? 0.5 : index / (points.length - 1));
  const ticks = [];
  for (let value = bottom; value <= top + 1e-9; value += step) ticks.push(value);

  // Contiguous runs of reported points; each is its own path.
  const runs = [];
  let run = [];
  points.forEach((point, index) => {
    if (point.value == null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ ...point, index });
  });
  if (run.length) runs.push(run);
  const lastIndex = points.reduce((at, point, index) => (point.value != null ? index : at), -1);
  const every = labelEvery(points.length);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Combined balance at each close">
      {ticks.map((value) => (
        <g key={`t${value}`}>
          <line className="cpr-grid-line" x1={L} x2={W - R} y1={r1(y(value))} y2={r1(y(value))} />
          <text x={L - 6} y={r1(y(value) + 3)} textAnchor="end">{axisLabel(value, step)}</text>
        </g>
      ))}
      {runs.map((segment) => {
        const path = segment.map((point, i) => `${i ? 'L' : 'M'}${r1(x(point.index))} ${r1(y(point.value))}`).join(' ');
        const area = `${path} L${r1(x(segment[segment.length - 1].index))} ${r1(y(bottom))} L${r1(x(segment[0].index))} ${r1(y(bottom))} Z`;
        return (
          <g key={`run${segment[0].index}`}>
            <path className="cpr-area" d={area} />
            <path className="cpr-line" d={path} />
          </g>
        );
      })}
      {points.map((point, index) => {
        // The last label is anchored at its end so it cannot run off the chart.
        const label = index % every === 0 || index === points.length - 1
          ? <text x={r1(x(index))} y={H - 10} textAnchor={index === points.length - 1 && points.length > 1 ? 'end' : 'middle'}>{dayLabel(point.date)}</text>
          : null;
        if (point.value == null) {
          return (
            <g key={point.date}>
              <text className="cpr-hole-label" x={r1(x(index))} y={r1(y(bottom) - 6)} textAnchor="middle">{HOLE_LABEL[point.state] || 'gap'}</text>
              {label}
            </g>
          );
        }
        const last = index === lastIndex;
        return (
          <g key={point.date}>
            <circle className={last ? 'cpr-dot cpr-dot-last' : 'cpr-dot'} cx={r1(x(index))} cy={r1(y(point.value))} r={last ? 4 : 2.2}>
              <title>{`${dayLabel(point.date, { long: true })}${point.prior ? ' (close before the period)' : ''}: ${fmtMoney(point.value)}`}</title>
            </circle>
            {label}
          </g>
        );
      })}
    </svg>
  );
}

/** One account's balance at each close of the period, one slot per day. */
export function BalanceSparkline({ series = [] }) {
  const W = 90;
  const H = 24;
  const values = series.filter((value) => value != null);
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const x = (index) => (series.length === 1 ? W / 2 : 2 + (index * (W - 4)) / (series.length - 1));
  const y = (value) => H - 3 - ((value - lo) / span) * (H - 6);
  let path = '';
  let open = false;
  let last = null;
  series.forEach((value, index) => {
    if (value == null) {
      open = false;
      return;
    }
    path += `${open ? 'L' : 'M'}${r1(x(index))} ${r1(y(value))} `;
    open = true;
    last = { cx: r1(x(index)), cy: r1(y(value)) };
  });
  return (
    <svg className="cpr-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path className="cpr-line cpr-spark-line" d={path.trim()} />
      {last ? <circle className="cpr-dot-last" cx={last.cx} cy={last.cy} r="2.2" /> : null}
    </svg>
  );
}
