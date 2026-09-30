/**
 * The desk's per algorithm temperature panel: one row per REAL algorithm,
 * hottest at the top, selectable, with the curve of what was selected underneath.
 *
 * PRESENTATION ONLY. Every figure this file prints is read off
 * `buildAlgorithmTemperature` or `buildAlgorithmComposite`. Nothing here adds,
 * divides or compares two dollars to make a third. The one exception is chart
 * GEOMETRY, which is the shared lo/hi and the calendar to viewBox mapping, and
 * no reported number is derived from it: every value drawn is also printed in
 * the DOM beside the mark, off the domain result.
 *
 * THE HOUSE RULES THIS FOLLOWS, all of them from `DeskPeriodReportCharts.jsx:1`:
 *
 * 1. Hand rolled inline SVG, theme tokens only, no literal hex, no chart
 *    library. `recharts` is in package.json and imported by nothing; it is not
 *    the house style.
 * 2. Colour is never the only cue. Every curve's own total and its own deepest
 *    dip are printed in the key beside it, and the key is a real list in the
 *    DOM, not a tooltip. `DeskPeriodReportCharts.test.jsx` strips `title=`
 *    attributes before asserting, on the principle that a fact living only in a
 *    tooltip is a fact that is not on paper.
 * 3. `vector-effect="non-scaling-stroke"` on every stroked element, because
 *    `preserveAspectRatio="none"` would otherwise turn a 2px stroke into a
 *    wedge. No `<circle>` for the same reason: at this aspect an r=1.4 circle
 *    renders about 25px wide and 3px tall.
 * 4. NOTHING UNMEASURED IS DRAWN AS A ZERO. A row credited on no day has a null
 *    dip and a null heat, and it prints "not measured", never $0. That is why
 *    `money()` below returns a phrase for null instead of letting
 *    `formatCurrency` coerce it to $0.
 * 5. X IS CALENDAR TIME, not the ordinal of the credited date. Index X on a
 *    curve compresses calendar time invisibly and nothing on the chart
 *    discloses it, which `DeskPeriodReportCharts.jsx:576` records as a defect
 *    this repo already shipped once. `AccountHistoryChart.jsx` scales by index;
 *    that is a per close bar strip, and this is a curve.
 *
 * WHY THE PARTS GET THEIR OWN PLOTS INSTEAD OF ONE OVERLAY. There is no vetted
 * multi hue palette in this codebase: `--chart-1` through `--chart-5` exist in
 * index.css and are used by zero components, and a later block redefines all
 * five as greys, so five series drawn with them would be five indistinguishable
 * lines. Inventing a palette here to overlay N curves is a design decision this
 * panel does not need to make: `BenchmarkCurves` already puts each series in its
 * own plot for the same reason, and small multiples answer "which one is
 * carrying the stack" more directly than an overlay does. The part plots share
 * ONE scale with each other and with the composite, stated in the axis line,
 * because small multiples drawn on their own scales are a comparison that lies.
 *
 * NO DASHES IN ANY RENDERED STRING. `StackPlaybook.test.js` asserts that the
 * Team Algo Performance section's text matches neither `/[–—]/` nor `/\s-\s/`,
 * and this panel is going to be rendered inside it. That covers the copy written
 * here and the strings the domain module hands over, which are dash free for
 * this reason.
 *
 * The column is "Credited days" and not "Account days" deliberately: the team
 * combo table's own header is "Account days" and `StackPlaybook.test.js:128`
 * finds that table with `getByText('Account days')`, which throws on a second
 * match. The word is also the more honest one, since these are the days the
 * partition could credit to this algorithm and not the days it ran.
 */

import { useMemo, useState } from 'react';
import { formatCurrency } from '../domain/report';
import {
  COLD_BELOW,
  HEAT_DATES,
  HOT_ABOVE,
  UNMEASURED_TEMPERATURE,
  buildAlgorithmComposite,
} from '../domain/algorithmTemperature';

/* ---------------------------------------------------------------- */
/* Formatting. The only arithmetic in this file, and none of it makes */
/* a figure the domain did not already publish.                       */

// `formatCurrency(null)` returns $0, which is the zero versus unmeasured
// conflation house rule 4 forbids. Null is a phrase here, never a number.
const money = (value) => (value === null || value === undefined
  ? 'not measured'
  : `${value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`);

const signed = (value) => (value === null || value === undefined
  ? 'not measured'
  : `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`);

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// Two decimals, because on a plausible three algorithm selection this book's
// reduction is 0.08%, and a figure rounded to a whole percent would print that
// as 0% and read as "no comparison" rather than as "a rounding error".
const percent = (ratio) => `${(Number(ratio) * 100).toFixed(2)}%`;

// Three way. A flat figure is a real outcome and not a loss, and this panel has
// real zeros in it: one row of the stored book has a deepest dip of exactly
// $0.00. `AlgorithmDetailPanel.jsx:50` holds the same function, module local.
const moneyClass = (value) => {
  if (value === null || value === undefined) return 'muted';
  return value > 0 ? 'positive' : value < 0 ? 'negative' : 'muted';
};

const temperatureClass = (temperature) => {
  if (temperature === 'Hot') return 'positive';
  if (temperature === 'Cold') return 'negative';
  if (temperature === UNMEASURED_TEMPERATURE) return 'muted';
  return '';
};

const dayMs = (date) => Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);

/* ---------------------------------------------------------------- */
/* One cumulative curve. viewBox and geometry follow BenchmarkCurves. */

function Curve({ equity, lo, hi, from, to, color, width, label, shadeFrom, shadeTo, height }) {
  const startMs = dayMs(from);
  const timeSpan = Math.max(dayMs(to) - startMs, 1);
  const spread = hi - lo || 1;
  const x = (date) => {
    const at = dayMs(date);
    if (Number.isNaN(at)) return 0;
    return Math.min(Math.max(((at - startMs) / timeSpan) * 100, 0), 100);
  };
  const y = (value) => 46 - ((value - lo) / spread) * 42;

  // A curve credited on one date is a point, and a one point path draws
  // nothing. It gets a short level tick at its own date rather than a line
  // across the window, which would claim the value held for the whole of it.
  const path = equity.length === 1
    ? `M${(x(equity[0].date) - 1.5).toFixed(2)},${y(equity[0].cum).toFixed(2)} `
      + `L${(x(equity[0].date) + 1.5).toFixed(2)},${y(equity[0].cum).toFixed(2)}`
    : equity
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.date).toFixed(2)},${y(point.cum).toFixed(2)}`)
      .join(' ');

  const shadeX = shadeFrom ? x(shadeFrom) : null;
  const shadeW = shadeX === null ? 0 : Math.max(x(shadeTo) - shadeX, 0.6);

  return (
    <svg
      viewBox="0 0 100 50"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ width: '100%', height, display: 'block' }}
    >
      {shadeX === null ? null : (
        <rect x={shadeX} y="0" width={shadeW} height="50" fill="var(--error)" opacity="0.14">
          <title>{`The deepest fall on this curve runs ${shadeFrom} to ${shadeTo}`}</title>
        </rect>
      )}
      <line
        x1="0" y1={y(0)} x2="100" y2={y(0)}
        stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      <path d={path} fill="none" stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke">
        <title>{label}</title>
      </path>
    </svg>
  );
}

/* ---------------------------------------------------------------- */

export default function AlgorithmTemperaturePanel({
  result = null,
  selected = null,
  onToggleAlgorithm = null,
  fillsLoaded = true,
  bare = false,
}) {
  // Uncontrolled by default, controlled when the parent passes `selected`. The
  // immutable Set toggle is the idiom already at App.jsx:9833, copied rather
  // than reinvented. `null` is not a member sentinel the way it is on the single
  // select ranking panel: closing a row here means removing it from the Set.
  const [ownSelection, setOwnSelection] = useState(() => new Set());
  const controlled = selected != null;
  const selection = useMemo(() => {
    if (!controlled) return ownSelection;
    return selected instanceof Set ? selected : new Set(selected);
  }, [controlled, selected, ownSelection]);

  const toggle = (key) => {
    if (onToggleAlgorithm) {
      onToggleAlgorithm(key);
      return;
    }
    setOwnSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const composite = useMemo(
    () => buildAlgorithmComposite(result, selection),
    [result, selection],
  );

  const rows = result?.rows || [];
  const unsplit = result?.unsplit || null;
  const population = result?.population || null;
  const dipLabel = result?.dipLabel || 'Deepest dip inside this window';

  // The parts in the order the list shows them, so the key under the chart and
  // the rows above it read in the same order. `composite.parts` carries the
  // measured ones; the rows carry the curves.
  const partKeys = new Set(composite.parts.map((part) => part.key));
  const partRows = rows.filter((row) => partKeys.has(row.key));

  // Shared scale across the composite and every part, so the small multiples
  // are comparable with each other and with the curve above them. One scale per
  // plot would make a part that fell $200 look like one that fell $20,000.
  const plotted = [composite.equity, ...partRows.map((row) => row.equity)];
  const cums = plotted.flat().map((point) => point.cum);
  const lo = Math.min(...cums, 0);
  const hi = Math.max(...cums, 0);
  const dates = plotted.flat().map((point) => point.date).sort();
  const axisFrom = result?.window?.from || dates[0] || '';
  const axisTo = result?.window?.to || dates[dates.length - 1] || '';
  const hasCurve = composite.equity.length > 0;

  const Frame = bare ? 'div' : 'section';

  return (
    <Frame className={bare ? 'algo-temperature-panel' : 'panel algo-temperature-panel'}>
      <div className="panel-heading playbook-heading">
        <h3>Algorithm temperature</h3>
        <span className="badge muted">
          {`${plural(rows.length, 'algorithm', 'algorithms')}`}
          {population ? ` · ${plural(population.accounts, 'account', 'accounts')}` : ''}
          {population ? ` · ${plural(population.clients, 'client', 'clients')}` : ''}
        </span>
      </div>

      <p className="muted board-note">
        One row per algorithm, not per combination, ordered by heat with the hottest at the top.
        Heat is the sum of what the algorithm was credited over the last {HEAT_DATES} dates it was
        credited on, which on a sparse row are not the last {HEAT_DATES} closes of the window: the
        dates behind each figure are named in the row. Hot is above {signed(HOT_ABOVE)} and Cold
        below {signed(COLD_BELOW)}, the thresholds the client screen already uses.
      </p>
      <p className="muted board-note">
        An account day is credited to an algorithm only when exactly one ran, counted in the row as
        sole, or when every algorithm that ran carries its own figure and those figures add up to
        the close, counted in the row as measured. A day that cannot be partitioned is credited to
        nobody and is counted below. It is never divided equally.
        {population
          ? ` ${population.includedDays} of ${population.fundedDays} funded account days in this `
            + `window are credited here, and ${population.unknownDays} carry no algorithm at all `
            + `(${money(population.unknownPnl)}).`
          : ''}
      </p>
      {result ? (
        <p className="muted board-note">
          A row is marked Low sample under {result.minDays} credited days or under
          {' '}{result.minAccounts} accounts.
          {fillsLoaded
            ? ''
            : ' Fills are not loaded for every close in this window, so attribution is reading the '
              + 'strategy grid alone and these figures move when trade history finishes loading.'}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="muted chart-empty">
          No funded account day in this window carries an attributable algorithm. Widen the window
          or upload daily closes to populate.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="ops-table board-table">
              <thead>
                <tr>
                  <th scope="col">Algorithm</th>
                  <th scope="col">Heat</th>
                  <th scope="col">Temperature</th>
                  <th scope="col">Credited days</th>
                  <th scope="col">Accounts</th>
                  <th scope="col">Total P&amp;L</th>
                  <th scope="col">{dipLabel}</th>
                  <th scope="col">Sample</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = selection.has(row.key);
                  return (
                    <tr
                      key={row.key}
                      className={[row.lowSample ? 'board-unranked' : '', open ? 'board-row-open' : '']
                        .filter(Boolean).join(' ') || undefined}
                    >
                      <th scope="row">
                        <button
                          type="button"
                          className="board-open-algo"
                          aria-pressed={open}
                          onClick={() => toggle(row.key)}
                        >
                          <strong>{row.key}</strong>
                        </button>
                      </th>
                      <td className={moneyClass(row.heat)}>
                        {signed(row.heat)}
                        <small className="muted">
                          {row.heatDates.length
                            ? `over ${row.heatDates.join(', ')}`
                            : 'no credited date'}
                        </small>
                      </td>
                      <td>
                        <em className={temperatureClass(row.temperature)}>{row.temperature}</em>
                      </td>
                      <td className="board-days">
                        {row.days}
                        <small className="muted">
                          {`${row.attribution.soleDays} sole, ${row.attribution.measuredDays} measured`}
                        </small>
                        {row.attribution.unsplitDays ? (
                          <small className="muted">
                            {`${plural(row.attribution.unsplitDays, 'day', 'days')} it ran unsplit`}
                          </small>
                        ) : null}
                      </td>
                      <td>{row.accounts}</td>
                      <td className={moneyClass(row.unmeasured ? null : row.totalPnl)}>
                        {row.unmeasured ? 'not measured' : money(row.totalPnl)}
                      </td>
                      <td className={moneyClass(row.deepestDip)}>
                        {money(row.deepestDip)}
                        {row.deepestDip != null && row.deepestDip < 0 ? (
                          <small className="muted">
                            {row.deepestDipFrom
                              ? `${row.deepestDipFrom} to ${row.deepestDipTo}`
                              : `from the window opening to ${row.deepestDipTo}`}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {row.lowSample ? <span className="badge warning">Low sample</span> : null}
                        {row.unmeasured ? <span className="badge muted">Unmeasured</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ---- the selection, as a curve ---- */}
          {selection.size === 0 ? (
            <p className="muted chart-empty">
              Select one or more algorithms above to draw their combined curve and each of their
              own curves underneath.
            </p>
          ) : (
            <div className="period-chart algo-temperature-curves">
              {composite.unmeasuredKeys.length ? (
                <p className="muted board-note">
                  {`${composite.unmeasuredKeys.join(', ')}: `}
                  {composite.unmeasuredKeys.length === 1
                    ? 'credited on no account day in this window, so it is on no curve here. Every '
                      + 'account day it ran on could not be partitioned.'
                    : 'credited on no account day in this window, so they are on no curve here. '
                      + 'Every account day they ran on could not be partitioned.'}
                </p>
              ) : null}

              {!hasCurve ? (
                <p className="muted chart-empty">
                  Nothing in this selection was measured on any account day, so there is no curve to
                  draw. This is not a flat curve and it is not a zero.
                </p>
              ) : (
                <>
                  <div className="ahc-plot-head">
                    <span className="muted">
                      {`Combined credited P&L of ${plural(composite.parts.length, 'algorithm', 'algorithms')}`}
                    </span>
                    <strong className={moneyClass(composite.equity[composite.equity.length - 1].cum)}>
                      {money(composite.equity[composite.equity.length - 1].cum)}
                    </strong>
                  </div>
                  <Curve
                    equity={composite.equity}
                    lo={lo}
                    hi={hi}
                    from={axisFrom}
                    to={axisTo}
                    color="var(--accent)"
                    width="2"
                    height={110}
                    shadeFrom={composite.deepestDip < 0 ? (composite.deepestDipFrom || axisFrom) : null}
                    shadeTo={composite.deepestDipTo}
                    label={`Combined credited P&L of ${composite.parts.map((part) => part.key).join(', ')} `
                      + `from ${axisFrom} to ${axisTo}, over `
                      + `${plural(composite.equity.length, 'credited date', 'credited dates')}. `
                      + `${dipLabel}: ${money(composite.deepestDip)}.`}
                  />
                  <div className="period-chart-axis">
                    <span>{axisFrom}</span>
                    <span className="muted">
                      {`${dipLabel}: ${money(composite.deepestDip)}`}
                      {composite.deepestDip < 0
                        ? composite.deepestDipFrom
                          ? `, shaded, ${composite.deepestDipFrom} to ${composite.deepestDipTo}`
                          : `, shaded, from the window opening to ${composite.deepestDipTo}`
                        : ''}
                    </span>
                    <span>{axisTo}</span>
                  </div>
                  <div className="period-chart-axis">
                    <span className="muted">
                      {`Horizontal axis is calendar time from ${axisFrom} to ${axisTo}. `}
                      {`Vertical axis is ${money(lo)} to ${money(hi)} cumulative, and every plot `}
                      below shares it, so the curves are comparable with each other and with this
                      one.
                    </span>
                  </div>

                  {/* Each selected algorithm on its own plot. Not overlaid: see
                      the file header on why there is no palette for N series.
                      `period-benchmark-curves` is reused for the stacking and
                      the figcaption size, so this panel adds no stylesheet rule.
                      Note that the `break-inside: avoid` print rule on these
                      classes is written under a `.desk-period-report` ancestor,
                      which this panel does not have: on paper a plot here can
                      still be split across a page. */}
                  <div className="period-benchmark-curves algo-temperature-parts">
                    {partRows.map((row) => (
                      <figure className="period-benchmark-curve" key={row.key}>
                        <figcaption>
                          <strong>{row.key}</strong>
                          <span className={moneyClass(row.totalPnl)}>{` ${money(row.totalPnl)}`}</span>
                          <span className="muted">
                            {` over ${plural(row.days, 'credited day', 'credited days')}`}
                          </span>
                        </figcaption>
                        <Curve
                          equity={row.equity}
                          lo={lo}
                          hi={hi}
                          from={axisFrom}
                          to={axisTo}
                          color="var(--text-muted)"
                          width="1.5"
                          height={70}
                          shadeFrom={row.deepestDip < 0 ? (row.deepestDipFrom || axisFrom) : null}
                          shadeTo={row.deepestDipTo}
                          label={`${row.key} credited P&L from ${axisFrom} to ${axisTo}: `
                            + `${money(row.totalPnl)} over `
                            + `${plural(row.days, 'credited day', 'credited days')}. `
                            + `${dipLabel}: ${money(row.deepestDip)}.`}
                        />
                        <div className="period-chart-axis">
                          <span className="muted">{`${dipLabel} ${money(row.deepestDip)}`}</span>
                          <span className="muted">{row.temperature}</span>
                        </div>
                      </figure>
                    ))}
                  </div>

                  {/* Every drawn value, printed. Colour is never the only cue. */}
                  <ol className="period-chart-key">
                    <li>
                      <span><strong>Combined</strong></span>
                      <span>{money(composite.equity[composite.equity.length - 1].cum)}</span>
                      <span className="muted">
                        {`${dipLabel} ${money(composite.deepestDip)} over `}
                        {plural(composite.equity.length, 'credited date', 'credited dates')}
                      </span>
                    </li>
                    {composite.parts.map((part) => (
                      <li key={part.key}>
                        <span>{part.key}</span>
                        <span className={moneyClass(part.totalPnl)}>{money(part.totalPnl)}</span>
                        <span className="muted">{`${dipLabel} ${money(part.deepestDip)}`}</span>
                      </li>
                    ))}
                  </ol>

                  {/* ---- the comparison, and the sentence it may never travel without ---- */}
                  {composite.reduction === null ? (
                    <p className="muted board-note">
                      No algorithm in this selection fell below where it opened, so there is no
                      deepest fall to compare. That is not a reduction of 100%, it is no comparison.
                    </p>
                  ) : (
                    <p className="board-note">
                      <strong>
                        {`Combined ${money(composite.deepestDip)} against `}
                        {`${money(composite.sumOfPartDips)} for the sum of the parts, `}
                        {`${percent(composite.reduction)} lower.`}
                      </strong>
                      {` Measured over ${plural(composite.overlapDays, 'date', 'dates')} `}
                      on which more than one of the selected algorithms was credited.
                      {' '}
                      <span className="muted">{composite.caveat}</span>
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ---- what sat out, always visible while it is not zero ---- */}
      {unsplit && unsplit.days > 0 ? (
        <div className="board-block algo-temperature-unsplit">
          <div className="board-head">
            <h4>Not on any curve</h4>
            <span className="badge warning">
              {`${plural(unsplit.days, 'account day', 'account days')}, ${money(unsplit.pnl)}`}
            </span>
          </div>
          <p className="muted board-note">{unsplit.note}</p>
          <details className="board-refusals">
            <summary>{`Why ${plural(unsplit.days, 'day', 'days')} could not be partitioned`}</summary>
            <ul>
              {Object.entries(unsplit.reasons)
                .filter(([, bucket]) => bucket.days > 0)
                .map(([name, bucket]) => (
                  <li key={name}>
                    <strong>
                      {`${plural(bucket.days, 'account day', 'account days')}, ${money(bucket.pnl)}`}
                      {bucket.flatDays
                        ? `, of which ${plural(bucket.flatDays, 'day was', 'days were')} flat`
                        : ''}
                      .
                    </strong>
                    {` ${bucket.note}`}
                  </li>
                ))}
            </ul>
          </details>
        </div>
      ) : null}
    </Frame>
  );
}

export { AlgorithmTemperaturePanel };
