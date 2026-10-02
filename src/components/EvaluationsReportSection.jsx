import { EVALUATION_PROGRESS } from '../domain/evaluationReport';
import { formatCurrency } from '../domain/report';

/**
 * The evaluations block of a client report.
 *
 * Opt-in through the existing report designer (`showEvaluations` in
 * reportConfig.js REPORT_FIELDS, off by default, per-CAM or per-client through
 * the same scope radio every other toggle uses). Rendered only when
 * `report.evaluations` is non-null — a client who holds no challenge account gets
 * no section rather than a section full of zeros.
 *
 * WHY IT EXISTS. Evaluations had no switch of their own and no section of their
 * own: they were one group inside the per-account table, so a CAM who wanted to
 * put them on a client's report had to show every other pool with them, and
 * nothing on the page said what kind of money they hold. The chat message has
 * printed them as their own block since report.js:150. The paper had not.
 *
 * WHAT IT MUST NEVER DO, and this sentence is SimulationReportSection's: its
 * figures are never added to `report.totals` and never appear in the segment tile
 * row. Two totals on one page that could be mistaken for each other is the
 * defect, not the layout. The separation here is structural — its own bordered
 * block, its own heading, its own subtotal labelled "Challenge-capital total",
 * and "challenge capital" attached to every figure it prints — and it sits below
 * the money and the charts so nothing above it can be read as including it.
 *
 * WHAT IT CARRIES THAT THE SIMULATION BLOCK DOES NOT: progress toward the
 * target, because an evaluation can be reached and the desk is paid to reach
 * them. "Reached", never "passed" — the firm decides a pass, on rules this CRM
 * does not hold.
 */
export default function EvaluationsReportSection({ evaluations }) {
  if (!evaluations) return null;

  const { counts, coverage, totals } = evaluations;
  const hasRows = evaluations.hasRows;

  return (
    <section className="report-section report-evaluations">
      <header className="report-evaluations-head">
        <h2>{evaluations.label}</h2>
        {/* Only when there IS something in the block. A chip over an empty block
            labels nothing, and SimulationReportSection learned that the hard way
            in the other direction. */}
        {hasRows ? <span className="eval-chip">Challenge capital</span> : null}
      </header>
      <p className="report-evaluations-note">{evaluations.note}</p>

      {hasRows ? (
        <>
          <div className="report-evaluations-totals">
            <div>
              <span>Challenge accounts</span>
              {/* Every count carries its denominator. */}
              <strong>
                {counts.accounts} of {counts.ofAccountsReported}
              </strong>
            </div>
            <div>
              <span>Challenge balance</span>
              <strong>{formatCurrency(totals.aggregateBalance)} challenge capital</strong>
            </div>
            <div>
              <span>Challenge daily P&amp;L</span>
              <strong className={totals.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                {formatCurrency(totals.grossRealizedPnl)} challenge capital
              </strong>
            </div>
            <div>
              <span>Reached their target</span>
              <strong>
                {counts.reached} of {counts.accounts}
              </strong>
            </div>
          </div>

          <p className="report-evaluations-activity">
            {counts.traded ? (
              <>
                {counts.traded} of {counts.accounts} challenge account
                {counts.accounts === 1 ? '' : 's'} traded in this close.
                {counts.idle ? (
                  <>
                    {' '}
                    {/* "Idle" and "flat" are different facts, and the simulation
                        block already draws this distinction for the same reason:
                        on the book's latest closes 164 of 203 evaluation rows ran
                        no strategy at all, and reporting those as a $0 day would
                        be a different claim from the true one. The sentence says
                        what ran, and does NOT claim the balance stood still —
                        fees and adjustments move a balance no algorithm touched. */}
                    No algorithm ran on the other {counts.idle}, so a $0 line below means nothing
                    traded rather than a day that ended level.
                  </>
                ) : null}
              </>
            ) : (
              <>
                No challenge account traded in this close: no algorithm ran on any of them, so a $0
                line below means nothing traded rather than a day that ended level.
              </>
            )}
            {counts.failed ? (
              <>
                {' '}
                {counts.failed} of them {counts.failed === 1 ? 'is' : 'are'} recorded as failed and{' '}
                {counts.failed === 1 ? 'is' : 'are'} shown because this close is the one it broke on.
              </>
            ) : null}
          </p>

          {/*
            HOW EMPTY THE PROGRESS COLUMN IS, printed above it rather than left to
            the blanks. The pattern is bulletBotDeskStats.buildColumnCoverage: a
            figure drawn from a partly-filled column is stated with its
            denominator and with how much of the column was filled, because the
            desk that owns Target $ and Start Bal $ reads the panel, not the
            comment. The inferred count is named in words for the same reason
            BulletBotDeskPanel names it: a target nobody typed must not read like
            one somebody confirmed.
          */}
          <p className="report-evaluations-coverage muted">
            Progress shown on {coverage.progressShown} of {coverage.ofAccounts} account
            {coverage.ofAccounts === 1 ? '' : 's'}: {coverage.targetStored} target
            {coverage.targetStored === 1 ? '' : 's'} on record
            {coverage.targetInferred
              ? `, ${coverage.targetInferred} taken from the standard target for the account's type and size`
              : ''}
            {coverage.targetMissing
              ? `, ${coverage.targetMissing} with no target on record and none derivable`
              : ''}
            {coverage.targetNotAboveStart
              ? `, ${coverage.targetNotAboveStart} whose recorded target is not above the starting balance`
              : ''}
            .
          </p>

          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Algorithms that ran</th>
                  <th scope="col">Daily P&amp;L (challenge capital)</th>
                  <th scope="col">Balance (challenge capital)</th>
                  <th scope="col">Target</th>
                  <th scope="col">Progress to target</th>
                  <th scope="col">Buffer reported</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.accounts.map((row) => (
                  <tr key={row.accountName}>
                    <td>
                      <strong>{row.meta?.alias || row.accountName}</strong>
                      <br />
                      <small>{row.meta?.connection || row.connection || ''}</small>
                    </td>
                    <td>
                      <small>{row.ranStrategies.join(', ') || '-'}</small>
                    </td>
                    <td className={row.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                      {formatCurrency(row.grossRealizedPnl)}
                    </td>
                    <td>{formatCurrency(row.accountBalance)}</td>
                    <td>
                      {row.progress.target ? (
                        <>
                          {formatCurrency(row.progress.target)}
                          {row.progress.targetSource === 'inferred' ? (
                            <>
                              <br />
                              <small className="muted">standard for its type and size</small>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <small className="muted">not on record</small>
                      )}
                    </td>
                    <td>
                      <EvaluationProgressCell progress={row.progress} />
                    </td>
                    <td>
                      {row.reportedBuffer !== null ? (
                        formatCurrency(row.reportedBuffer)
                      ) : row.pastDrawdown ? (
                        // A negative trailing figure is not a negative buffer.
                        // App.jsx's drawdownLabel has always rendered this case
                        // as BREACHED; the word is softer here because this is
                        // the page the client reads, and the fact is the same.
                        <small className="report-negative">Past its drawdown</small>
                      ) : (
                        // The platform reported no trailing figure for this
                        // account on this close. The rules table would supply
                        // one for 93% of them, and on every one of those it
                        // would be the tightest plan that firm sells rather
                        // than this account's own — see evaluationReport.js.
                        <small className="muted">not reported</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">
                    Challenge-capital total ({counts.accounts} of {counts.ofAccountsReported} accounts
                    reported)
                  </th>
                  <td />
                  <td className={totals.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                    {formatCurrency(totals.grossRealizedPnl)}
                  </td>
                  <td>{formatCurrency(totals.aggregateBalance)}</td>
                  <td />
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="report-evaluations-footnote muted">
            Not included in the daily or weekly figures above. A challenge account's profit is the
            prop firm's capital, and reaching a target is confirmed by the firm, not by this report.
          </p>
        </>
      ) : null}

      {counts.notReported && hasRows ? (
        <p className="report-evaluations-absent muted">
          {counts.notReported} further evaluation account{counts.notReported === 1 ? '' : 's'} on
          record reported no close on this date.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One progress cell. A percentage where a percentage is true, and a sentence
 * where it is not.
 *
 * The existing "Progress to target" table computes `(balance - start) / (target
 * - start)` with `start` defaulting to 0, which printed >=90% for 70 of the 233
 * rows it drew on the book's latest closes — every one of them an account whose
 * Start Bal $ is blank, sitting untouched at its opening balance. A bar is only
 * honest when both ends of it are known, so each way of not knowing says which.
 */
function EvaluationProgressCell({ progress }) {
  if (progress.state === EVALUATION_PROGRESS.REACHED) {
    return (
      <span className="report-eval-reached" title="The prop firm confirms a pass; this is the balance reaching the target.">
        Target reached
      </span>
    );
  }
  if (progress.state === EVALUATION_PROGRESS.BELOW) {
    return (
      <div className="report-progress">
        <span className="report-progress-bar" style={{ width: `${progress.percent}%` }} />
        <span className="report-progress-label">{progress.percent}%</span>
      </div>
    );
  }
  if (progress.state === EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START) {
    return (
      <small className="muted">
        The target on record is not above this account&apos;s starting balance, so a percentage
        cannot be shown.
      </small>
    );
  }
  if (progress.state === EVALUATION_PROGRESS.NO_START) {
    return (
      <small className="muted">
        No starting balance on record and no earlier close to take one from, so a percentage cannot
        be shown.
      </small>
    );
  }
  return (
    <small className="muted">
      No target on record for this account, so a percentage cannot be shown.
    </small>
  );
}
