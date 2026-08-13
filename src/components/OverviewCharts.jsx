import { buildCamWorkload } from '../domain/camCoverage';
import {
  FLAG_AGE_BUCKETS,
  buildAlgoContribution,
  buildBookMix,
  buildFlagAging,
  buildTrailingBuffer,
  buildUploadCoverage,
} from '../domain/overviewCharts';

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function Empty({ children }) {
  return <p className="muted chart-empty">{children}</p>;
}

const STATUS_COLOR = {
  critical: 'var(--error)',
  warning: 'var(--warning)',
  ok: 'var(--success)',
};

/**
 * Room left before each prop account breaches its trailing limit.
 *
 * The bar fills as the account uses up its allowance, so a long bar is bad. It
 * reads the same way the limit does: the closer to the end, the closer to gone.
 */
export function TrailingBufferChart({ client, dailyImport = null, limit = 8 }) {
  const rows = buildTrailingBuffer(client, dailyImport);
  if (!rows.length) return <Empty>No prop accounts with a drawdown limit on record.</Empty>;
  const shown = rows.slice(0, limit);

  return (
    <div className="ov-chart">
      {shown.map((row) => (
        <div key={row.accountName} className="ov-row">
          <span className="ov-label" title={row.accountName}>{row.alias}</span>
          <span className="ov-track" role="img" aria-label={`${row.alias}: ${money(row.buffer)} of ${money(row.limit)} left`}>
            <span
              className="ov-fill"
              style={{ width: `${row.usedPct.toFixed(1)}%`, background: STATUS_COLOR[row.status] }}
            />
          </span>
          <span className={`ov-value ${row.status}`}>
            {money(row.buffer)}
            {row.isLowerBound ? <abbr title="Derived from stored closes: the real drawdown can only be worse."> ≤</abbr> : null}
          </span>
        </div>
      ))}
      {rows.length > limit ? (
        <p className="muted chart-empty">{rows.length - limit} more not shown.</p>
      ) : null}
    </div>
  );
}

/**
 * Realized P&L by algorithm, winners above losers.
 *
 * Bars grow from a centre line so a loss reads as a loss without depending on
 * the red/green difference alone.
 */
export function AlgoContributionChart({ client, dailyImport = null, limit = 10 }) {
  const rows = buildAlgoContribution(client, dailyImport);
  if (!rows.length) return <Empty>No strategy results for this day.</Empty>;
  const shown = rows.slice(0, limit);

  return (
    <div className="ov-chart">
      {shown.map((row) => {
        const negative = row.realized < 0;
        return (
          <div key={row.name} className="ov-row">
            <span className="ov-label" title={`${row.accounts} account${row.accounts === 1 ? '' : 's'}`}>
              {row.name}
            </span>
            <span className="ov-track diverging" role="img" aria-label={`${row.name}: ${money(row.realized)}`}>
              <span
                className="ov-fill"
                style={{
                  width: `${(row.share / 2).toFixed(1)}%`,
                  marginLeft: negative ? `${(50 - row.share / 2).toFixed(1)}%` : '50%',
                  background: negative ? 'var(--error)' : 'var(--success)',
                }}
              />
            </span>
            <span className={`ov-value ${negative ? 'negative' : 'positive'}`}>{money(row.realized)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Which clients were uploaded on each of the last trading days.
 *
 * Weekends are absent, not empty: a grey Saturday column would read as a gap on
 * a day nobody works.
 */
export function UploadCoverageGrid({ clients = [], today, days = 10, limit = 12 }) {
  const { days: window, rows } = buildUploadCoverage(clients, today, days);
  if (!rows.length) return <Empty>No clients to track yet.</Empty>;
  const shown = rows.slice(0, limit);
  const clean = rows.filter((row) => row.missed === 0).length;

  return (
    <div className="ov-chart">
      <p className="muted chart-empty">
        {clean} of {rows.length} clients uploaded every one of the last {window.length} trading days.
      </p>
      {shown.map((row) => (
        <div key={row.clientId} className="ov-row">
          <span className="ov-label">{row.clientName}</span>
          <span className="ov-cells" role="img" aria-label={`${row.clientName}: ${row.missed} of ${window.length} days missing`}>
            {row.cells.map((cell) => (
              <i
                key={cell.date}
                className={cell.uploaded ? 'ov-cell on' : 'ov-cell off'}
                title={`${cell.date}: ${cell.uploaded ? 'uploaded' : 'no upload'}`}
              />
            ))}
          </span>
          <span className={`ov-value ${row.missed ? 'negative' : ''}`}>
            {row.missed ? `${row.missed} missed` : 'complete'}
          </span>
        </div>
      ))}
      {rows.length > limit ? (
        <p className="muted chart-empty">{rows.length - limit} more not shown.</p>
      ) : null}
    </div>
  );
}

/** Account-type mix across a book, as one stacked bar. */
export function BookMixBar({ clients = [] }) {
  const rows = buildBookMix(clients);
  if (!rows.length) return <Empty>No accounts classified yet.</Empty>;
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="ov-chart">
      <span className="ov-track stacked" role="img" aria-label={`${total} accounts by type`}>
        {rows.map((row, index) => (
          <span
            key={row.type}
            className={`ov-seg seg-${index % 5}`}
            style={{ width: `${row.share.toFixed(1)}%` }}
            title={`${row.type}: ${row.count}`}
          />
        ))}
      </span>
      <ul className="ov-legend">
        {rows.map((row, index) => (
          <li key={row.type}>
            <i className={`ov-dot seg-${index % 5}`} aria-hidden="true" />
            {row.type} <strong>{row.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Open flags per CAM, split by how long they have been open.
 *
 * Ordered by the oldest flag rather than by count, because five caught this
 * morning is a working CAM and two left for a fortnight is the problem.
 */
export function FlagAgingChart({ clients = [], camProfiles = [], today }) {
  const rows = buildFlagAging(clients, camProfiles, today);
  if (!rows.length) return <Empty>No open flags. </Empty>;
  const peak = rows.reduce((max, row) => Math.max(max, row.total), 0) || 1;

  return (
    <div className="ov-chart">
      <ul className="ov-legend">
        {FLAG_AGE_BUCKETS.map((bucket, index) => (
          <li key={bucket.key}>
            <i className={`ov-dot age-${index}`} aria-hidden="true" />
            {bucket.label}
          </li>
        ))}
      </ul>
      {rows.map((row) => (
        <div key={row.camId} className="ov-row">
          <span className="ov-label">{row.camName}</span>
          <span
            className="ov-track stacked"
            role="img"
            aria-label={`${row.camName}: ${row.total} open, oldest ${row.oldestDays} days`}
          >
            {FLAG_AGE_BUCKETS.map((bucket, index) => (
              row.buckets[bucket.key] ? (
                <span
                  key={bucket.key}
                  className={`ov-seg age-${index}`}
                  style={{ width: `${((row.buckets[bucket.key] / peak) * 100).toFixed(1)}%` }}
                  title={`${bucket.label}: ${row.buckets[bucket.key]}`}
                />
              ) : null
            ))}
          </span>
          <span className={`ov-value ${row.oldestDays >= 14 ? 'negative' : ''}`}>
            {row.total} · {row.oldestDays}d
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Client load per CAM today, including anything picked up as coverage.
 *
 * Reuses the workload figure the manager already sees when distributing an
 * absent CAM's clients, so the chart and the distribution cannot disagree.
 */
export function CoverageLoadChart({ camProfiles = [], clients = [], coverage = [], timeOff = [], date }) {
  const rows = buildCamWorkload(camProfiles, clients, { coverage, timeOff, date })
    .slice()
    .sort((a, b) => b.totalClients - a.totalClients);
  if (!rows.length) return <Empty>No CAM profiles yet.</Empty>;
  const peak = rows.reduce((max, row) => Math.max(max, row.totalClients), 0) || 1;

  return (
    <div className="ov-chart">
      {rows.map((row) => (
        <div key={row.camProfileId} className="ov-row">
          <span className="ov-label">
            {row.name}
            {row.away ? <span className="badge muted ov-away">away</span> : null}
          </span>
          <span
            className="ov-track stacked"
            role="img"
            aria-label={`${row.name}: ${row.ownClients} own, ${row.coveringClients} covering`}
          >
            <span
              className="ov-seg seg-0"
              style={{ width: `${((row.ownClients / peak) * 100).toFixed(1)}%` }}
              title={`Own clients: ${row.ownClients}`}
            />
            {row.coveringClients ? (
              <span
                className="ov-seg seg-3"
                style={{ width: `${((row.coveringClients / peak) * 100).toFixed(1)}%` }}
                title={`Covering: ${row.coveringClients}`}
              />
            ) : null}
          </span>
          <span className="ov-value">
            {row.totalClients}
            {row.coveringClients ? <em> (+{row.coveringClients})</em> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
