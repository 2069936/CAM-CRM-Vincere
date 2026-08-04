import { buildBulletBotDeskStats } from '../domain/bulletBotDeskStats';

/**
 * Bullet Bot across the whole desk: direction, per-client tallies, days to pass.
 *
 * Written to be un-misreadable rather than pretty. Three things on this book are
 * easy to get wrong from a card, so each has a rule here:
 *   - "traded" is never called "fired" and never sits next to the failure count.
 *     147 accounts traded; 27 failed. The old card printed the first number
 *     under the word "fired".
 *   - Every denominator is on screen. A pass rate whose cohort is smaller than
 *     the account count means accounts were excluded, and the manager has to see
 *     that rather than infer it.
 *   - A rate the data cannot support renders as "—", never as 0%.
 */

function percent(rate) {
  return rate == null ? null : `${Math.round(rate * 1000) / 10}%`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * One direction. The pass rate bar is drawn on an absolute 0–100 scale, not
 * scaled to the biggest bucket: Long at 6.7% next to Short at 17.2% has to look
 * like a third of it, and a bar normalised to the leader makes every leader look
 * complete.
 */
function DirectionCard({ bucket, primary = false }) {
  const rate = percent(bucket.passRate);
  return (
    <div className={primary ? 'bbdesk-card bbdesk-card-primary' : 'bbdesk-card'}>
      <div className="bbdesk-card-head">
        <strong>{bucket.label}</strong>
        <span className="muted">{plural(bucket.accounts, 'account')}</span>
      </div>

      {rate ? (
        <div className="bbdesk-rate">
          <span className="bbdesk-rate-value">{rate}</span>
          <div className="combo-bar-track">
            <i style={{ width: `${Math.min(100, bucket.passRate * 100)}%`, background: 'var(--accent)' }} />
          </div>
        </div>
      ) : (
        <div className="bbdesk-rate">
          <span className="bbdesk-rate-value muted" title={`Only ${bucket.scorable} scorable accounts — too few for a rate.`}>—</span>
        </div>
      )}

      <dl className="bbdesk-facts">
        <div>
          <dt>Passed</dt>
          <dd>
            <strong>{bucket.passed}</strong>
            <span className="muted"> of {bucket.scorable} scorable</span>
          </dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>
            <strong>{bucket.failed}</strong>
            <span className="muted"> marked Failed</span>
          </dd>
        </div>
        <div>
          <dt>Still running</dt>
          <dd>
            <strong>{bucket.running}</strong>
            {bucket.reserve ? <span className="muted"> + {bucket.reserve} reserve</span> : null}
          </dd>
        </div>
        <div>
          <dt title="Had executions or non-zero realised P&L inside the imported window. Trading is not failing, and it is not passing either: on this book 147 accounts traded, 27 are marked Failed, and 19 of the accounts that reached target also traded.">
            Traded
          </dt>
          <dd>
            <strong>{bucket.traded}</strong>
            <span className="muted"> took a trade</span>
          </dd>
        </div>
        {bucket.unscorable ? (
          <div>
            <dt title="No profit target on the account and no Failed status, so neither a pass nor a fail can be claimed. Excluded from the rate.">
              Unscorable
            </dt>
            <dd><strong>{bucket.unscorable}</strong><span className="muted"> no target</span></dd>
          </div>
        ) : null}
      </dl>

      {bucket.passed ? (
        <p className="muted bbdesk-note">
          {bucket.passedObserved} seen crossing the target
          {bucket.passedCensored
            ? `, ${bucket.passedCensored} already above it the first day we saw the account`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

function RankTable({ title, rows, field, rateField, minCohort, limit }) {
  const shown = rows.slice(0, limit);
  if (!shown.length) {
    return (
      <div className="bbdesk-rank">
        <h5>{title}</h5>
        <p className="muted chart-empty">Nobody yet.</p>
      </div>
    );
  }
  return (
    <div className="bbdesk-rank">
      <h5>{title}</h5>
      <div className="table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>{field === 'passed' ? 'Passes' : 'Failures'}</th>
              <th>Rate</th>
              <th>Scorable</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.clientId}>
                <td>{row.clientName}</td>
                <td><strong>{row[field]}</strong></td>
                <td>
                  {row[rateField] == null ? (
                    <span className="muted" title={`${row.scorable} scorable account${row.scorable === 1 ? '' : 's'} — under ${minCohort}, so a percentage here would be noise.`}>—</span>
                  ) : percent(row[rateField])}
                </td>
                <td className="muted">
                  {row.scorable}
                  {row.unscorable ? <span title={`${row.unscorable} more account(s) have no target and cannot be scored.`}> (+{row.unscorable}?)</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit ? (
        <p className="muted chart-empty">{rows.length - limit} more not shown.</p>
      ) : null}
    </div>
  );
}

/**
 * Days-to-pass as a distribution. The mean is deliberately absent: the sample
 * runs 1 to 15 days with a lump at 9 and another at 14, and one number over that
 * shape describes no account that exists.
 */
function DaysToPass({ days, reason }) {
  if (!days) {
    return (
      <div className="bbdesk-days">
        <h5>Days to pass</h5>
        <p className="muted chart-empty">Not reported. {reason}</p>
      </div>
    );
  }
  const peak = Math.max(...days.distribution.map((d) => d.accounts));
  return (
    <div className="bbdesk-days">
      <h5>Days to pass</h5>
      <div className="bbdesk-days-head">
        <span className="bbdesk-rate-value">{days.median}d</span>
        <span className="muted">
          median of {plural(days.n, 'account')}
          {days.iqr ? ` · middle half ${days.iqr[0]}–${days.iqr[1]}d` : ''}
          {` · range ${days.min}–${days.max}d`}
        </span>
      </div>
      <div className="bbdesk-hist">
        {days.distribution.map((bin) => (
          <div className="bbdesk-hist-row" key={bin.days}>
            <span className="muted">{bin.days}d</span>
            <div className="combo-bar-track">
              <i style={{ width: `${(bin.accounts / peak) * 100}%`, background: 'var(--accent)' }} />
            </div>
            <span className="muted">{bin.accounts}</span>
          </div>
        ))}
      </div>
      {days.censored ? (
        <p className="muted bbdesk-note">
          {days.censored} further {days.censored === 1 ? 'pass' : 'passes'}
          {' '}excluded: those accounts were already at or above target the first day they appear,
          so their duration is unknown, not zero. Counting them as 0 days is what pulls a mean below every value in it.
        </p>
      ) : null}
      <p className="muted bbdesk-note">
        Measured from the first daily import the account appears in — not date_funded (empty on every
        Bullet Bot account) and not date_added (a bulk backfill: 14 distinct values across 244 accounts,
        which puts 4 passes before the account was supposedly opened).
      </p>
    </div>
  );
}

export default function BulletBotDeskPanel({ clients = [], limit = 8, options = undefined }) {
  const stats = buildBulletBotDeskStats(clients, options);
  const { cohort, direction, ranking, daysToPass, unavailable } = stats;

  if (!cohort.accounts) {
    return <p className="muted chart-empty">No Bullet Bot evaluation accounts on the book.</p>;
  }

  return (
    <div className="bbdesk-panel">
      <p className="muted chart-empty">
        {plural(cohort.accounts, 'Bullet Bot account')} across {plural(cohort.clients, 'client')}.
        {' '}{direction.overall.passed} reached target, {direction.overall.failed} are marked Failed,
        {' '}{direction.overall.running + direction.overall.reserve} still open.
        {cohort.unscorable
          ? ` ${plural(cohort.unscorable, 'account')} carry no target and no outcome, so they are excluded from every rate rather than counted as failures.`
          : ''}
        {cohort.inferredTargets
          ? ` ${cohort.inferredTargets} targets were inferred from the standard 50k Bullet Bot plan (53,000) because the account row has none.`
          : ''}
      </p>

      <h5>Long against Short</h5>
      <div className="bbdesk-versus">
        <DirectionCard bucket={direction.long} primary />
        <DirectionCard bucket={direction.short} primary />
      </div>

      {cohort.unattributedPasses ? (
        <div className="notice">
          <span>
            <strong>{cohort.unattributedPasses} of {direction.overall.passed} passes belong to neither column.</strong>{' '}
            {direction.unknown.passed
              ? `${direction.unknown.passed} are on accounts whose strategy rows were already gone when we first saw them — and all ${direction.unknown.passedCensored} of those were already above target on day one, which is why the direction is unknown. `
              : ''}
            {direction.ambiguous.passed
              ? `${direction.ambiguous.passed} ran Long on some days and Short on others. `
              : ''}
            Long against Short therefore compares what happened inside the imported window only.
          </span>
        </div>
      ) : null}

      <div className="bbdesk-versus bbdesk-versus-secondary">
        <DirectionCard bucket={direction.unknown} />
        <DirectionCard bucket={direction.ambiguous} />
      </div>

      <h5>Per client</h5>
      <div className="bbdesk-ranks">
        <RankTable
          title="Most passes"
          rows={ranking.byPasses}
          field="passed"
          rateField="passRate"
          minCohort={ranking.minClientCohort}
          limit={limit}
        />
        <RankTable
          title="Most failures"
          rows={ranking.byFailures}
          field="failed"
          rateField="failRate"
          minCohort={ranking.minClientCohort}
          limit={limit}
        />
      </div>
      <p className="muted chart-empty">
        Count and rate are both here because they are different facts: 4 passes out of 8 accounts and
        4 out of 40 rank the same on count. Rates are withheld below {ranking.minClientCohort} scorable
        accounts — two accounts both passing is two accounts, not a 100% pass rate.
      </p>

      <h5>Streaks</h5>
      <div className="bbdesk-streaks">
        <div className="bbdesk-streak">
          <dt>Current run</dt>
          <dd className="muted">—</dd>
        </div>
        <div className="bbdesk-streak">
          <dt>Longest run</dt>
          <dd className="muted">—</dd>
        </div>
      </div>
      <p className="muted chart-empty">{unavailable.streaks}</p>

      <DaysToPass days={daysToPass} reason={unavailable.daysToPass} />

      {cohort.conflicts ? (
        <p className="muted chart-empty">
          {plural(cohort.conflicts, 'account')} both reached target and carries status Failed. Counted
          as a pass here — the balance is an observed event, the status is typed by hand — and reported
          rather than absorbed.
        </p>
      ) : null}
    </div>
  );
}
