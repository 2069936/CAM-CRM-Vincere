/**
 * The seven charts of the desk period report. Inline SVG, no library, the same
 * idiom `AccountHistoryChart.jsx`, `PerformanceCharts.jsx` and
 * `AlgorithmDetailPanel.jsx` already use.
 *
 * THE HOUSE RULES, and every one of them is a defect this codebase has already
 * paid for once:
 *
 * 1. Colour comes from theme tokens only — no literal hex — so the paper and
 *    both themes render the same chart.
 * 2. Colour is never the only cue. Every bar sits above or below a DRAWN zero
 *    line and every value is also printed in the row beside it.
 * 3. `vector-effect="non-scaling-stroke"` on every stroked element, because the
 *    full-width strips use `preserveAspectRatio="none"` and an unqualified 2px
 *    stroke becomes a 40px wedge at that aspect.
 * 4. NOTHING THAT WAS NOT MEASURED IS DRAWN AS A ZERO. A close nobody reported
 *    draws the hollow tick `CloseSeries` uses, with a title that says it is not
 *    a zero. The ranking panel printed an up arrow on every row of an unmeasured
 *    board once; that is the shape of the mistake.
 * 5. Nothing is joined that should not be. Lines are drawn in exactly two
 *    places: the slope chart, which joins two windows on purpose and says so,
 *    and the benchmark curve, which is a genuinely continuous equity curve.
 *    Closes are bars.
 * 6. Every mark carries a `<title>` naming the row or date, the value AND the
 *    count behind the value, and every chart carries `role="img"` with an
 *    `aria-label` stating what it plots and over what window.
 * 7. Axes are labelled in the DOM around the SVG, not inside it, so they reflow
 *    and print.
 */

import { formatCurrency } from '../domain/report';

const money = (value) => (value === null || value === undefined
  ? 'not measured'
  : `${value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`);

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function Empty({ children }) {
  return <p className="muted chart-empty">{children}</p>;
}

/* ---------------------------------------------------------------- */
/* Chart 1 — accounts reporting per close.                           */

export function AccountsPerCloseChart({ rows = [], period }) {
  const drawn = rows.filter((row) => row.date >= period.from && row.date <= period.to);
  if (!drawn.length) return <Empty>No close inside this period.</Empty>;
  const peak = Math.max(...drawn.map((row) => row.accountsReporting || 0), 1);
  const slot = 100 / drawn.length;
  const half = slot * 0.32;

  return (
    <div className="period-chart">
      <svg
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Accounts reporting on each of the ${drawn.length} calendar days in `
          + `${period.label}, ${drawn.filter((row) => !row.noClose).length} of them carrying a close`}
        style={{ width: '100%', height: 120, display: 'block' }}
      >
        <line
          x1="0" y1="54" x2="100" y2="54"
          stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
        {drawn.map((row, index) => {
          const centre = slot * (index + 0.5);
          if (row.noClose) {
            return (
              <rect
                key={row.date}
                x={centre - half / 2}
                y={53}
                width={half}
                height={2}
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${row.date} — no close. Not a zero.`}</title>
              </rect>
            );
          }
          const height = Math.max((row.accountsReporting / peak) * 50, 0.8);
          return (
            <rect
              key={row.date}
              x={centre - half}
              y={54 - height}
              width={half * 2}
              height={height}
              fill="var(--accent)"
            >
              <title>
                {`${row.date}: ${plural(row.accountsReporting, 'account', 'accounts')} across `
                  + `${plural(row.clientsReporting, 'client', 'clients')}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="period-chart-axis">
        <span>{drawn[0].date}</span>
        <span className="muted">{`${peak} accounts at the fullest close`}</span>
        <span>{drawn[drawn.length - 1].date}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 2 — P&L per account close, one strip per business.          */

export function MoneyStrips({ byClose = [], businesses = [] }) {
  if (!byClose.length) return <Empty>No close inside this period.</Empty>;
  return (
    <div className="period-strips">
      {businesses.map((business) => {
        const points = byClose.map((close) => ({
          date: close.date,
          ...(close.businesses.find((entry) => entry.key === business.key) || {}),
        }));
        const peak = Math.max(
          ...points.map((point) => Math.abs(point.perAccountClose || 0)), 1,
        );
        const slot = 100 / points.length;
        const half = slot * 0.3;
        return (
          <div className="period-strip" key={business.key}>
            <span className="period-strip-label">{business.shortLabel}</span>
            <svg
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              role="img"
              aria-label={`P&L per account close for ${business.label} on each close in this `
                + 'period, a rate and never a total'}
              style={{ width: '100%', height: 56, display: 'block' }}
            >
              <line
                x1="0" y1="20" x2="100" y2="20"
                stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
              {points.map((point, index) => {
                const centre = slot * (index + 0.5);
                if (point.perAccountClose === null || point.perAccountClose === undefined) {
                  return (
                    <rect
                      key={point.date}
                      x={centre - half / 2} y={19} width={half} height={2}
                      fill="none" stroke="var(--text-muted)" strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>
                        {`${point.date} — ${business.shortLabel} has no account close on this `
                          + 'date. Not a zero.'}
                      </title>
                    </rect>
                  );
                }
                const height = Math.max((Math.abs(point.perAccountClose) / peak) * 18, 0.8);
                const up = point.perAccountClose >= 0;
                return (
                  <rect
                    key={point.date}
                    x={centre - half}
                    y={up ? 20 - height : 20}
                    width={half * 2}
                    height={height}
                    fill={up ? 'var(--success)' : 'var(--error)'}
                  >
                    <title>
                      {`${point.date}: ${money(point.perAccountClose)} per account close over `
                        + `${plural(point.accountCloses, 'account close', 'account closes')}`}
                    </title>
                  </rect>
                );
              })}
            </svg>
            <span className="period-strip-peak muted">{`peak ${money(peak)}`}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 3 — deployment over the period.                             */

export function DeploymentGrid({ rows = [], closes = [] }) {
  if (!rows.length || !closes.length) {
    return <Empty>No algorithm ran on any close inside this period.</Empty>;
  }
  return (
    <div className="period-grid">
      {rows.map((row) => {
        const byClose = row.accountsByClose || {};
        const busiest = Math.max(row.busiestClose || 0, 1);
        return (
          <div className="period-grid-row" key={row.algorithm}>
            <span className="period-grid-label">{row.algorithm}</span>
            <div className="period-grid-cells">
              {closes.map((date) => {
                const accounts = byClose[date] || 0;
                return (
                  <span
                    key={date}
                    className={accounts ? 'period-grid-cell on' : 'period-grid-cell off'}
                    style={{
                      background: accounts ? 'var(--accent)' : 'var(--surface-3)',
                      // Against this algorithm's own busiest close, never
                      // against another row's: a shared scale would paint a
                      // three-account algorithm invisible beside a
                      // hundred-account one and read as "not running".
                      opacity: accounts ? 0.25 + 0.75 * (accounts / busiest) : 0.4,
                    }}
                    title={accounts
                      ? `${row.algorithm} on ${date}: ${plural(accounts, 'account', 'accounts')}`
                      : `${row.algorithm} on ${date}: no account carried it. Not a zero.`}
                  />
                );
              })}
            </div>
            <span className="period-grid-count muted">
              {plural(row.accountDaysInPeriod, 'account day', 'account days')}
            </span>
          </div>
        );
      })}
      <p className="muted period-grid-legend">
        Shade is accounts carrying that algorithm on that close, relative to that algorithm’s own
        busiest close in this period. Shades are not comparable between rows.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 4 — mean per account day with its interval.                 */

export function IntervalChart({ rows = [] }) {
  const drawn = rows.filter((row) => row.ranked && row.meanPerAccountDay !== null);
  if (!drawn.length) return null;
  const values = drawn.flatMap((row) => [
    row.ci ? row.ci.low : row.meanPerAccountDay,
    row.ci ? row.ci.high : row.meanPerAccountDay,
    0,
  ]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (value) => ((value - min) / span) * 96 + 2;
  const rowHeight = 22;
  const height = drawn.length * rowHeight;

  return (
    <div className="period-chart">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Measured P&L per account day with its 95% interval for the ${drawn.length} `
          + 'algorithms that clear the evidence gate in this period'}
        style={{ width: '100%', height, display: 'block' }}
      >
        <line
          x1={x(0)} y1="0" x2={x(0)} y2={height}
          stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
        {drawn.map((row, index) => {
          const y = index * rowHeight + rowHeight / 2;
          const low = row.ci ? row.ci.low : row.meanPerAccountDay;
          const high = row.ci ? row.ci.high : row.meanPerAccountDay;
          const title = `${row.name}: ${money(row.meanPerAccountDay)} per account day`
            + (row.ci ? `, 95% interval ${money(row.ci.low)} to ${money(row.ci.high)}` : ', no interval: one account')
            + `, ${plural(row.accountDays, 'account day', 'account days')} over `
            + `${plural(row.accounts, 'account', 'accounts')}`;
          return (
            <g key={row.name}>
              {row.ci ? (
                <>
                  <line
                    x1={x(low)} y1={y} x2={x(high)} y2={y}
                    stroke="var(--text-muted)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                  >
                    <title>{title}</title>
                  </line>
                  <line
                    x1={x(low)} y1={y - 4} x2={x(low)} y2={y + 4}
                    stroke="var(--text-muted)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={x(high)} y1={y - 4} x2={x(high)} y2={y + 4}
                    stroke="var(--text-muted)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                  />
                </>
              ) : null}
              <circle
                cx={x(row.meanPerAccountDay)}
                cy={y}
                r="1.4"
                fill={row.meanPerAccountDay >= 0 ? 'var(--success)' : 'var(--error)'}
              >
                <title>{title}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="period-chart-axis">
        <span>{money(min)}</span>
        <span className="muted">$0 is the drawn line</span>
        <span>{money(max)}</span>
      </div>
      <ol className="period-chart-key">
        {drawn.map((row) => (
          <li key={row.name}>
            <strong>{row.name}</strong>
            <span>{money(row.meanPerAccountDay)} per account day</span>
            <span className="muted">
              {row.ci
                ? `95% ${money(row.ci.low)} to ${money(row.ci.high)}`
                : row.ciRefusal}
            </span>
            <span className="muted">
              {plural(row.accountDays, 'account day', 'account days')},{' '}
              {plural(row.accounts, 'account', 'accounts')}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 5 — where each algorithm moved.                             */

export function SlopeChart({ rows = [], periodLabel = '', priorLabel = '' }) {
  if (!rows.length) return null;
  const values = rows.flatMap((row) => [row.priorMean, row.periodMean, 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const y = (value) => 92 - ((value - min) / span) * 84;

  return (
    <div className="period-chart">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Measured P&L per account day in ${priorLabel} against ${periodLabel}, for the `
          + `${rows.length} algorithms that clear the evidence gate in both windows`}
        style={{ width: '100%', height: 220, display: 'block' }}
      >
        <line
          x1="0" y1={y(0)} x2="100" y2={y(0)}
          stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
        {rows.map((row) => {
          const down = row.periodMean < row.priorMean;
          const stroke = down ? 'var(--error)' : 'var(--success)';
          const title = `${row.algorithm}: ${money(row.priorMean)} to ${money(row.periodMean)} per `
            + `account day, ${row.priorAccountDays} then ${row.periodAccountDays} account days`;
          return (
            <g key={row.algorithm}>
              <line
                x1="14" y1={y(row.priorMean)} x2="86" y2={y(row.periodMean)}
                stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke"
              >
                <title>{title}</title>
              </line>
              <circle cx="14" cy={y(row.priorMean)} r="1.2" fill={stroke}>
                <title>{title}</title>
              </circle>
              <circle cx="86" cy={y(row.periodMean)} r="1.2" fill={stroke}>
                <title>{title}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="period-chart-axis">
        <span>{priorLabel}</span>
        <span className="muted">{`${money(min)} to ${money(max)} per account day · $0 is drawn`}</span>
        <span>{periodLabel}</span>
      </div>
      <ol className="period-chart-key">
        {rows.map((row) => (
          <li key={row.algorithm}>
            <strong>{row.algorithm}</strong>
            <span>{`${money(row.priorMean)} → ${money(row.periodMean)}`}</span>
            <span className="muted">
              {`${row.priorAccountDays} then ${row.periodAccountDays} account days`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 6 — average per account day by combination.                 */

export function ComboBarChart({ rows = [], limit = 12 }) {
  const drawn = rows.filter((row) => !row.lowSample).slice(0, limit);
  if (!drawn.length) return null;
  const peak = Math.max(...drawn.map((row) => Math.abs(row.avgPnl || 0)), 1);
  const rowHeight = 20;
  const height = drawn.length * rowHeight;
  const zero = 50;
  const width = (value) => (Math.abs(value) / peak) * 48;

  return (
    <div className="period-chart">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Average P&L per account day for the ${drawn.length} combinations that clear `
          + 'the sample gate in this period'}
        style={{ width: '100%', height, display: 'block' }}
      >
        <line
          x1={zero} y1="0" x2={zero} y2={height}
          stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
        {drawn.map((row, index) => {
          const w = Math.max(width(row.avgPnl), 0.4);
          const up = row.avgPnl >= 0;
          return (
            <rect
              key={row.key}
              x={up ? zero : zero - w}
              y={index * rowHeight + 4}
              width={w}
              height={rowHeight - 8}
              fill={up ? 'var(--success)' : 'var(--error)'}
            >
              <title>
                {`${row.key}: ${money(row.avgPnl)} per account day over `
                  + `${plural(row.days, 'account day', 'account days')} on `
                  + `${plural(row.accounts, 'account', 'accounts')}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="period-chart-axis">
        <span>{money(-peak)}</span>
        <span className="muted">$0 is the drawn line</span>
        <span>{money(peak)}</span>
      </div>
      <ol className="period-chart-key">
        {drawn.map((row) => (
          <li key={row.key}>
            <strong>{row.key}</strong>
            <span>{money(row.avgPnl)} per account day</span>
            <span className="muted">
              {plural(row.days, 'account day', 'account days')},{' '}
              {plural(row.accounts, 'account', 'accounts')}
            </span>
          </li>
        ))}
      </ol>
      <p className="muted">Low sample rows are in the table above and are not drawn here.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Chart 7 — benchmark cumulative net, each series in its own plot.   */

export function BenchmarkCurves({ curves = [], period }) {
  if (!curves.length) return null;
  return (
    <div className="period-benchmark-curves">
      {curves.map((curve) => {
        const values = curve.points.map((point) => point.cumulative);
        const min = Math.min(...values, 0);
        const max = Math.max(...values, 0);
        const span = max - min || 1;
        const y = (value) => 46 - ((value - min) / span) * 42;
        const x = (index) => (index / Math.max(curve.points.length - 1, 1)) * 100;
        const path = curve.points
          .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point.cumulative).toFixed(2)}`)
          .join(' ');
        const shadeFrom = curve.points.findIndex((point) => point.date >= period.from);
        const shadeTo = curve.points.length - 1;
        return (
          <figure className="period-benchmark-curve" key={curve.key}>
            <figcaption>
              <strong>
                {`${curve.algorithm} ${curve.version}, ${curve.instrument}, ${curve.riskLevel} risk`}
              </strong>
            </figcaption>
            <svg
              viewBox="0 0 100 50"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Cumulative net of the ${curve.algorithm} ${curve.riskLevel} risk `
                + `backtest from ${curve.from} to ${curve.to}, one simulated account`}
              style={{ width: '100%', height: 90, display: 'block' }}
            >
              {shadeFrom >= 0 ? (
                <rect
                  x={x(shadeFrom)}
                  y="0"
                  width={Math.max(x(shadeTo) - x(shadeFrom), 0.6)}
                  height="50"
                  fill="var(--surface-3)"
                  opacity="0.5"
                >
                  <title>{`${period.from} to ${period.to}, the period this report covers`}</title>
                </rect>
              ) : null}
              <line
                x1="0" y1={y(0)} x2="100" y2={y(0)}
                stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={path}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {`${curve.algorithm} ${curve.version}: cumulative net ${money(values[values.length - 1])} `
                    + `over ${plural(curve.points.length, 'trading day', 'trading days')} from `
                    + `${curve.from} to ${curve.to}`}
                </title>
              </path>
            </svg>
            <div className="period-chart-axis">
              <span>{curve.from}</span>
              <span className="muted">{`${money(min)} to ${money(max)} cumulative`}</span>
              <span>{curve.to}</span>
            </div>
            <p className="muted">{curve.basis}</p>
          </figure>
        );
      })}
    </div>
  );
}
