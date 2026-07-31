// Scatter geometry. Circles must not be squashed, so this chart keeps the
// default preserveAspectRatio ("meet") rather than the stretch-to-fit
// `preserveAspectRatio="none"` the line charts use: a bubble that reads as an
// ellipse would imply a second dimension that is not in the data.
const W = 640;
const H = 380;
const PAD = { top: 26, right: 18, bottom: 48, left: 54 };
// Data sits inside the axes by this much so the largest bubble cannot spill
// over the tick labels.
const INSET = 22;
const R_MIN = 4.5;
const R_MAX = 20;
const LABEL_LINE = 12;

function fmtFills(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtRatio(value) {
  return value == null || !Number.isFinite(value) ? '—' : Number(value).toFixed(2);
}

function fmtTicks(value) {
  return value == null || !Number.isFinite(value) ? '—' : String(value);
}

function fmtPct(value) {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

/**
 * Colour restates the vertical position instead of introducing a second scale.
 *
 * Exposure itself has no absolute threshold worth colouring against — it is a
 * ratio of a rate to a ratio — whereas 1:1 is a real line: below it the stop is
 * wider than the target. Banding on reward:risk means the colour and the y axis
 * can never disagree, and the raw figures still travel in each dot's title.
 */
function ratioColor(rewardRisk) {
  if (rewardRisk < 1) return 'var(--error)';
  if (rewardRisk < 2) return 'var(--warning)';
  return 'var(--success)';
}

function dotTitle(row) {
  const bits = [
    `${row.accounts} account${row.accounts === 1 ? '' : 's'}`,
    `${row.strategies} parameter set${row.strategies === 1 ? '' : 's'}`,
    `${fmtFills(row.fillsPerDay)} fills a day, peak ${fmtFills(row.maxFillsPerDay)}`,
    `${fmtRatio(row.rewardRisk)} reward:risk (${fmtTicks(row.targetTicks)} target / ${fmtTicks(row.stopTicks)} stop ticks)`,
    `exposure ${fmtRatio(row.exposure)}`,
  ];
  if (row.reEntryPct != null) bits.push(`re-entry on in ${fmtPct(row.reEntryPct)}`);
  if (row.windowPct != null) bits.push(`trade window on in ${fmtPct(row.windowPct)}`);
  return `${row.family} — ${bits.join(', ')}`;
}

/** Why a family has no reward:risk, so the fallback list explains itself. */
function missingReason(row) {
  if (row.stopTicks == null && row.targetTicks == null) return 'no stop or target on record';
  if (row.stopTicks == null) return 'no stop on record';
  if (row.targetTicks == null) return 'no target on record';
  return 'stop of zero ticks';
}

/**
 * Strategy families placed by how hard they trade against how much they ask for.
 *
 * Both axes run backwards on purpose. Plotted the conventional way — fills
 * rising to the right, reward:risk rising upward — the dangerous combination
 * (trades constantly, targets less than it risks) lands in the bottom-right,
 * the last corner the eye reaches. Reversing both is a 180° rotation of that
 * plot, which puts the high-exposure corner top-left where reading starts. The
 * cost is that a reversed axis is easy to misread, so every tick carries its
 * number, both axis titles state their direction in words, and the corner is
 * labelled rather than left to be inferred.
 *
 * Bubble area — not radius — is proportional to the number of accounts running
 * the family, because area is what the eye actually compares. The floor at
 * R_MIN breaks that proportion for one- and two-account families, which is a
 * deliberate trade: a dot sized honestly against a 60-account family would be
 * sub-pixel and simply vanish.
 *
 * Families with no reward:risk cannot be given a y position. They are listed
 * under the plot instead of being pinned to zero, which would place them in the
 * worst corner of the chart on the strength of a missing parameter.
 */
export default function StrategyRiskScatter({ rows = [], limit = 14 }) {
  const all = Array.isArray(rows) ? rows : [];
  if (!all.length) {
    return <p className="muted chart-empty">No strategy parameters on record yet.</p>;
  }

  const plottable = all.filter(
    (row) => Number.isFinite(row?.rewardRisk) && row.rewardRisk > 0 && Number.isFinite(row?.fillsPerDay),
  );
  const unplotted = all.filter((row) => !plottable.includes(row));
  const shown = plottable.slice(0, limit);
  const trimmed = plottable.length - shown.length;

  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y0 = PAD.top;
  const y1 = H - PAD.bottom;
  const dx0 = x0 + INSET;
  const dx1 = x1 - INSET;
  const dy0 = y0 + INSET;
  const dy1 = y1 - INSET;

  // Domains start at zero: both quantities have a real floor there, and a
  // clipped baseline would exaggerate the spread between families.
  const xMax = Math.max(1, ...shown.map((row) => row.fillsPerDay)) * 1.1;
  // Force enough headroom that the 1:1 line is always on the canvas, even when
  // every family sits comfortably above it.
  const yMax = Math.max(1.25, Math.max(...shown.map((row) => row.rewardRisk), 0) * 1.12);
  const maxAccounts = Math.max(1, ...shown.map((row) => row.accounts || 0));

  // Reversed on both axes — see the component note.
  const X = (fills) => dx1 - (Math.min(fills, xMax) / xMax) * (dx1 - dx0);
  const Y = (ratio) => dy0 + (Math.min(ratio, yMax) / yMax) * (dy1 - dy0);
  const radius = (accounts) => Math.max(R_MIN, R_MAX * Math.sqrt(Math.max(accounts || 0, 0) / maxAccounts));

  const fractions = [0, 0.25, 0.5, 0.75, 1];
  const oneToOneY = Y(1);

  // Place each label beside its dot, flipping to the inside near the right edge
  // so it cannot run off the canvas, then push overlapping labels apart.
  const marks = shown.map((row) => {
    const cx = X(row.fillsPerDay);
    const cy = Y(row.rewardRisk);
    const r = radius(row.accounts);
    const flip = cx > x0 + (x1 - x0) * 0.62;
    return {
      row,
      cx,
      cy,
      r,
      color: ratioColor(row.rewardRisk),
      anchor: flip ? 'end' : 'start',
      labelX: flip ? cx - r - 5 : cx + r + 5,
      labelY: cy + 3.5,
    };
  });
  marks
    .slice()
    .sort((a, b) => a.labelY - b.labelY)
    .reduce((prev, mark) => {
      if (prev != null && mark.labelY - prev < LABEL_LINE) mark.labelY = prev + LABEL_LINE;
      mark.labelY = Math.min(mark.labelY, y1 - 2);
      return mark.labelY;
    }, null);

  // The domain hands these over sorted by exposure, but the summary asserts
  // which family is worst, so it derives that rather than trusting the order.
  const worst = shown.reduce(
    (max, row) => (max == null || (row.exposure ?? -Infinity) > (max.exposure ?? -Infinity) ? row : max),
    null,
  );
  const belowParity = shown.filter((row) => row.rewardRisk < 1).length;
  const summary = [
    `Reward to risk against median fills per account-day for ${shown.length} strategy famil${shown.length === 1 ? 'y' : 'ies'}.`,
    'Both axes run backwards, so the busiest families with the thinnest edge sit in the top left.',
    worst
      ? `Highest exposure is ${worst.family} at ${fmtFills(worst.fillsPerDay)} fills a day on ${fmtRatio(worst.rewardRisk)} reward to risk across ${worst.accounts} account${worst.accounts === 1 ? '' : 's'}.`
      : '',
    belowParity ? `${belowParity} famil${belowParity === 1 ? 'y risks' : 'ies risk'} more than they target.` : '',
    unplotted.length ? `${unplotted.length} more have no reward to risk and are listed below the plot.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="ov-chart">
      {shown.length ? (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={summary}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          >
            <title>{summary}</title>

            {/* Everything at or under 1:1 risks more than it targets. */}
            <rect x={x0} y={y0} width={x1 - x0} height={Math.max(0, oneToOneY - y0)} fill="var(--error)" opacity="0.06" />

            {fractions.map((f) => (
              <line
                key={`gx-${f}`}
                x1={X(f * xMax)} x2={X(f * xMax)} y1={y0} y2={y1}
                stroke="var(--border)" strokeWidth="1" opacity="0.35" vectorEffect="non-scaling-stroke"
              />
            ))}
            {fractions.map((f) => (
              <line
                key={`gy-${f}`}
                x1={x0} x2={x1} y1={Y(f * yMax)} y2={Y(f * yMax)}
                stroke="var(--border)" strokeWidth="1" opacity="0.35" vectorEffect="non-scaling-stroke"
              />
            ))}

            <line
              x1={x0} x2={x1} y1={oneToOneY} y2={oneToOneY}
              stroke="var(--error)" strokeWidth="1" strokeDasharray="4 4" opacity="0.8" vectorEffect="non-scaling-stroke"
            />
            <text x={x1 - 4} y={oneToOneY - 5} textAnchor="end" fontSize="10" fill="var(--error)">
              1 : 1
            </text>

            {/* Sits above the plot rect, not inside it: a family with a very
                thin edge lands hard against the top and would be covered by a
                caption placed in the corner it is meant to describe. */}
            <text x={x0} y={y0 - 9} fontSize="11" fontWeight="600" fill="var(--error)">
              ↖ high exposure — busiest, thinnest edge
            </text>

            <line x1={x0} x2={x1} y1={y1} y2={y1} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <line x1={x0} x2={x0} y1={y0} y2={y1} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

            {fractions.map((f) => (
              <text key={`tx-${f}`} x={X(f * xMax)} y={y1 + 15} textAnchor="middle" fontSize="10" fill="var(--muted)">
                {fmtFills(f * xMax)}
              </text>
            ))}
            {fractions.map((f) => (
              <text key={`ty-${f}`} x={x0 - 7} y={Y(f * yMax) + 3.5} textAnchor="end" fontSize="10" fill="var(--muted)">
                {(f * yMax).toFixed(1)}
              </text>
            ))}

            <text x={(x0 + x1) / 2} y={H - 12} textAnchor="middle" fontSize="11" fill="var(--muted)">
              Median fills per account-day — more to the left
            </text>
            <text
              x={15} y={(y0 + y1) / 2} textAnchor="middle" fontSize="11" fill="var(--muted)"
              transform={`rotate(-90 15 ${(y0 + y1) / 2})`}
            >
              Reward : risk — thinner toward the top
            </text>

            {/* Half-transparent fills with a matching ring so families that land
                on the same spot stay countable instead of hiding each other. */}
            {marks.map((mark) => (
              <circle
                key={`dot-${mark.row.family}`}
                cx={mark.cx} cy={mark.cy} r={mark.r}
                fill={mark.color} fillOpacity="0.5"
                stroke={mark.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke"
              >
                <title>{dotTitle(mark.row)}</title>
              </circle>
            ))}
            {marks.map((mark) => (
              <text
                key={`label-${mark.row.family}`}
                x={mark.labelX} y={mark.labelY} textAnchor={mark.anchor}
                fontSize="11" fill="var(--muted)" style={{ pointerEvents: 'none' }}
              >
                {mark.row.family}
              </text>
            ))}
          </svg>

          <ul className="ov-legend">
            <li>
              <i className="ov-dot" style={{ background: 'var(--error)' }} aria-hidden="true" />
              under 1:1
            </li>
            <li>
              <i className="ov-dot" style={{ background: 'var(--warning)' }} aria-hidden="true" />
              1:1 to 2:1
            </li>
            <li>
              <i className="ov-dot" style={{ background: 'var(--success)' }} aria-hidden="true" />
              2:1 or better
            </li>
            <li>bubble area = accounts running it</li>
          </ul>
        </>
      ) : (
        <p className="muted chart-empty">
          No family has both a stop and a target on record, so nothing can be placed on the reward:risk axis.
        </p>
      )}

      {trimmed > 0 ? <p className="muted chart-empty">{trimmed} more not shown.</p> : null}

      {unplotted.length ? (
        <>
          <p className="muted chart-empty">
            No reward:risk — not on the plot rather than pinned to zero, which would read as the worst ratio there is:
          </p>
          {unplotted.map((row) => (
            <div key={`np-${row.family}`} className="ov-row">
              <span className="ov-label" title={row.family}>{row.family}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {missingReason(row)} · {row.accounts} account{row.accounts === 1 ? '' : 's'} ·{' '}
                {fmtFills(row.fillsPerDay)} fills a day
              </span>
              <span className="ov-value warning">{fmtTicks(row.stopTicks)} / {fmtTicks(row.targetTicks)}</span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
