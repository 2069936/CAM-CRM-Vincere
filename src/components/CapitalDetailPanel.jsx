import { useMemo } from 'react';
import { buildCapitalDetail } from '../domain/capitalDetail';

/**
 * The detail behind a capital tile: what the desk holds, how it is composed, and
 * which of its movements the data can actually name.
 *
 * Every caveat is inline, next to the number it applies to, never in a footnote.
 * The reason is that on this book the caveats are larger than the findings: one
 * movement is nameable across 36 days and 584 accounts, held capital is summed
 * across 13 different as-of dates, and no account in view has a payout recorded
 * against it. A reader who scrolls past a footnote has been misled by a page
 * that was technically correct.
 */
export default function CapitalDetailPanel({ clients = [], segment = null, asOfDate = '' }) {
  const detail = useMemo(
    () => buildCapitalDetail(clients, { segment, asOfDate }),
    [clients, segment, asOfDate],
  );

  const block = detail.selected;
  const title = segment || 'The whole desk';
  const isDesk = !segment;

  if (!detail.asOfDate) {
    return (
      <p className="muted chart-empty">
        No close has been imported yet, so there is no balance to report. This is not zero capital —
        it is no observation.
      </p>
    );
  }

  // A segment name the book does not carry. buildCapitalDetail answers with an
  // empty block, and rendering that block prints "$0 · 0 accounts · 0 current",
  // which is a claim that this segment holds nothing rather than an admission
  // that nothing was found under that name. Segment names come from segmentFor()
  // on both sides, so this only fires if a caller invents one — and it must say
  // so instead of inventing a zero.
  if (segment && !detail.segments.some((row) => row.segment === segment)) {
    return (
      <p className="muted chart-empty">
        No account on the book is classified as <code>{segment}</code>, so there is nothing to
        report here. This is an unrecognised segment name, not a segment holding $0.
      </p>
    );
  }

  return (
    <div className="capital-panel">
      <header className="capital-head">
        <h4>{title}</h4>
        <span className="muted">
          Closes {detail.closes[0]} to {detail.asOfDate} · {detail.closes.length} imported
        </span>
      </header>

      <HeldCapital block={block} asOfDate={detail.asOfDate} />
      {/* isDesk decides the axis, and it has to be passed: without it the desk
          view falls through to composition.byStatus, which is empty on the desk
          block (statuses are tallied per segment), so "How it is composed" —
          the seven-segment split that is the whole reason to open the desk
          view — renders nothing at all. */}
      <Composition block={block} isDesk={isDesk} />
      <Movements block={block} detail={detail} />
      <Timeline block={block} />
      <Declined rows={detail.declined} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function money(value) {
  if (value === null || value === undefined) return '—';
  return `$${Math.round(Number(value)).toLocaleString('en-US')}`;
}

function signed(value) {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(Number(value));
  return `${rounded < 0 ? '−' : '+'}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** A figure and, always, how many accounts it rests on. */
function Figure({ label, value, rests, tone = '', caveat = null }) {
  return (
    <div className="capital-figure">
      <span className="capital-figure-label">{label}</span>
      <strong className={tone ? `capital-figure-value ${tone}` : 'capital-figure-value'}>
        {value}
      </strong>
      <span className="capital-rests">{rests}</span>
      {caveat ? <span className="capital-caveat">{caveat}</span> : null}
    </div>
  );
}

/** Marks a number that was derived rather than read from a record. */
function Derived({ children }) {
  return (
    <span
      className="capital-derived"
      title="Derived from balances, not read from a recorded transaction. No deposit, withdrawal or transfer amount exists anywhere in the schema."
    >
      {children}
    </span>
  );
}

function HeldCapital({ block, asOfDate }) {
  const { held } = block;
  const carried = held.accounts - held.atLatestClose.accounts;

  return (
    <section className="capital-section">
      <div className="capital-figures">
        <Figure
          label="Capital held"
          value={money(held.capital)}
          rests={plural(held.accounts, 'account')}
          caveat={held.asOfDates.length > 1 ? (
            <>
              Not one date. Each account&apos;s last observed balance, landing on{' '}
              {held.asOfDates.length} different closes — {carried} of {held.accounts} accounts did
              not report on {asOfDate} and their balance is carried forward, not refreshed.
            </>
          ) : null}
        />
        <Figure
          label={`Reported on ${asOfDate}`}
          value={money(held.atLatestClose.capital)}
          rests={plural(held.atLatestClose.accounts, 'account')}
          caveat="The clean cross-section: one close, no carried-forward balances."
        />
      </div>

      <ul className="capital-staleness">
        <li><em>{held.staleness.current}</em> current</li>
        <li><em>{held.staleness.withinThreeDays}</em> 1–3 days old</li>
        <li><em>{held.staleness.withinSevenDays}</em> 4–7 days old</li>
        <li className={held.staleness.older ? 'capital-warn' : ''}>
          <em>{held.staleness.older}</em> more than a week old
        </li>
        {held.accountsWithoutBalance ? (
          <li
            className="capital-warn"
            title="These accounts have never appeared in a close. They are excluded from the total rather than counted as zero — a zero would be a claim about a balance nobody has seen."
          >
            <em>{held.accountsWithoutBalance}</em> no balance on record — excluded, not counted as $0
          </li>
        ) : null}
      </ul>

      {held.asOfDates.length > 1 ? (
        <details className="capital-rest">
          <summary>Which close each dollar comes from</summary>
          <div className="capital-table-wrap">
            <table className="capital-table">
              <thead>
                <tr>
                  <th scope="col">Close</th>
                  <th scope="col">Accounts</th>
                  <th scope="col">Capital</th>
                </tr>
              </thead>
              <tbody>
                {held.asOfDates.map((row) => (
                  <tr key={row.date}>
                    <th scope="row">{row.date}</th>
                    <td>{row.accounts}</td>
                    <td>{money(row.capital)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Composition({ block, isDesk }) {
  const { composition, held } = block;
  // The desk breaks down by segment; a segment breaks down by account status.
  // A cash account and a bullet-bot evaluation are different businesses, so
  // "Active / Failed / Reserve" is the wrong axis for the desk.
  const rows = isDesk && composition.bySegment.length
    ? composition.bySegment.map((row) => ({ ...row, label: row.segment }))
    : composition.byStatus.map((row) => ({ ...row, label: row.status }));
  if (!rows.length) return null;

  return (
    <section className="capital-section">
      <h5>How it is composed</h5>
      {isDesk ? (
        <p className="capital-note">
          Accounts marked Inactive / Ignore, and closes whose account is no longer on record, are
          reported separately rather than folded in — open their own tile to see them.
        </p>
      ) : composition.shareOfDesk !== null ? (
        <p className="capital-note">{composition.shareOfDesk}% of the desk total.</p>
      ) : (
        <p className="capital-note">
          Not part of the desk total — this segment is reported on its own so the capital is visible
          rather than hidden.
        </p>
      )}
      <ul className="capital-bars">
        {rows.map((row) => (
          <li key={row.label}>
            <span className="capital-bar-label">{row.label}</span>
            <span className="capital-bar-track">
              <span
                className="capital-bar-fill"
                style={{ width: `${held.capital ? Math.max(1, (row.capital / held.capital) * 100) : 0}%` }}
              />
            </span>
            <span className="capital-bar-value">
              {money(row.capital)} <em>{plural(row.accounts, 'account')}</em>
            </span>
          </li>
        ))}
      </ul>

      {composition.largest.length ? (
        <details className="capital-rest">
          <summary>The largest {composition.largest.length} accounts in this segment</summary>
          <div className="capital-table-wrap">
            <table className="capital-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Client</th>
                  <th scope="col">Balance</th>
                  <th scope="col">As of</th>
                </tr>
              </thead>
              <tbody>
                {composition.largest.map((row) => (
                  <tr key={`${row.clientName}-${row.accountName}`}>
                    <th scope="row"><code>{row.accountName}</code></th>
                    <td>{row.clientName}</td>
                    <td>{money(row.balance)}</td>
                    <td>
                      {row.asOf}
                      {row.staleDays > 0 ? (
                        <em className={row.staleDays > 7 ? 'capital-warn' : ''}>
                          {' '}{row.staleDays}d old
                        </em>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Movements({ block, detail }) {
  const { movement, coverage, held } = block;
  const skipped = coverage.pairsSkipped;
  const notLookedAt = skipped.gap + skipped.closeDistrusted
    + skipped.accumulatorBlanked + skipped.staleRow;

  return (
    <section className="capital-section">
      <h5>How it moved</h5>

      <p className="capital-note">
        A balance change is only a capital movement if trading does not account for it. What trading
        accounts for is read from <code>weekly_pnl</code>, the net accumulator —{' '}
        <span title="gross_realized_pnl is gross of commissions. The balance moves by net, so the difference between them fires on every commissioned trading day. On the real book that would have raised roughly 580 movements that never happened.">
          not from <code>gross_realized_pnl</code>
        </span>.
      </p>

      <div className="capital-figures">
        <Figure
          label="Trading P&L, net"
          value={signed(movement.tradingPnl?.net)}
          tone={movement.tradingPnl && movement.tradingPnl.net < 0 ? 'capital-negative' : ''}
          rests={movement.tradingPnl
            ? `${plural(movement.tradingPnl.accounts, 'account')} of ${held.accounts} · ${movement.tradingPnl.pairs} close-pairs`
            : 'no comparable pair of closes'}
          caveat={movement.tradingPnl && movement.tradingPnl.coverageShare < 0.5 ? (
            <>
              This rests on {Math.round(movement.tradingPnl.coverageShare * 100)}% of the segment.
              True for those accounts; not a segment total.
            </>
          ) : null}
        />
        <Figure
          label="Money in"
          value="Not recorded"
          rests="no field for it exists"
          caveat="No deposit, withdrawal, funding-fee or transfer amount is stored in any table. This is silence, not zero."
        />
        <Figure
          label="Paid out"
          value={movement.payouts?.recorded ? money(movement.payouts.recorded.amount) : 'Unrecorded'}
          rests={movement.payouts?.recorded
            ? `${plural(movement.payouts.recorded.accounts, 'account')} · ${movement.payouts.recorded.events} approved events`
            : `${plural(movement.payouts?.accountsWithoutHistory ?? 0, 'account')} with no payout on record`}
          caveat={movement.payouts?.recorded ? (
            <>
              Entered by a person, so it is authoritative — {movement.payouts.recorded.firstDate} to{' '}
              {movement.payouts.recorded.lastDate}, {movement.payouts.eventsInsideWindow} of them
              inside the imported closes.{' '}
              {movement.payouts.accountsWithoutHistory
                ? `The other ${movement.payouts.accountsWithoutHistory} accounts have no payout history recorded, which is not the same as never having been paid.`
                : ''}
            </>
          ) : (
            'No payout has been recorded against any account here. That is an empty record, not a payout of $0.'
          )}
        />
        <Figure
          label="Funded"
          value={movement.funded?.accountsWithFundedDate
            ? plural(movement.funded.accountsWithFundedDate, 'account')
            : 'No date recorded'}
          rests={`of ${plural(movement.funded?.accounts ?? 0, 'account')}`}
          caveat="Counted, never given a dollar figure: start_balance is the plan size the prop firm simulates, not money the desk put in."
        />
      </div>

      {movement.transfers.length ? (
        <div className="capital-found">
          <strong>{plural(movement.transfers.length, 'movement')} identified.</strong>
          <ul className="capital-events">
            {movement.transfers.map((transfer) => (
              <li key={`${transfer.date}-${transfer.from.accountName}`}>
                <span className="capital-event-date">{transfer.date}</span>
                <span>
                  <Derived>{money(transfer.amount)}</Derived> moved from{' '}
                  <code>{transfer.from.accountName}</code> to <code>{transfer.to.accountName}</code>,
                  both {transfer.clientName}&apos;s.
                </span>
                <span className="muted">
                  Named only because the two balances cancel to the cent on the same close and the
                  accounts share a client. No trading loss produces a matching gain elsewhere.
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {movement.unexplained.length ? (
        <div className="capital-unexplained">
          <strong>
            {plural(movement.unexplained.length, 'balance change')} across{' '}
            {plural(movement.unexplainedTotals.accounts, 'account')} that trading does not account
            for — and that this panel will not classify.
          </strong>
          <p className="capital-note">
            A withdrawal and a trading loss the accumulator missed look identical here. Booking
            either one as the other is worse than leaving it open, so they are listed as they are:{' '}
            {signed(movement.unexplainedTotals.in)} unaccounted in,{' '}
            {signed(movement.unexplainedTotals.out)} out.
          </p>
          <div className="capital-table-wrap">
            <table className="capital-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Between</th>
                  <th scope="col">Balance moved</th>
                  <th scope="col">Trading explains</th>
                  <th scope="col">Unaccounted for</th>
                </tr>
              </thead>
              <tbody>
                {movement.unexplained.map((row) => (
                  <tr key={`${row.key}-${row.to}`}>
                    <th scope="row">
                      <code>{row.accountName}</code>
                      <em>{row.clientName}</em>
                    </th>
                    <td>{row.from} → {row.to}</td>
                    <td>{signed(row.moved)}</td>
                    <td>{signed(row.explainedByTrading)}</td>
                    <td className={row.amount < 0 ? 'capital-negative' : 'capital-positive'}>
                      {signed(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="capital-note">
          Every comparable pair of closes reconciles against the accumulator. No unexplained balance
          change here.
        </p>
      )}

      <p className="capital-coverage">
        Rests on {coverage.pairsReconciled} of {coverage.pairsCompared} comparable close-pairs across{' '}
        {plural(coverage.accountsWithComparablePairs, 'account')}.{' '}
        {coverage.accountsNotComparable ? (
          <span title="One close, or closes too far apart to compare. A single observation cannot show a movement.">
            {coverage.accountsNotComparable} accounts have no comparable pair at all.
          </span>
        ) : null}{' '}
        {notLookedAt ? (
          <span>
            {notLookedAt} further pairs were not examined:{' '}
            {skipped.gap ? `${skipped.gap} straddle a gap of more than three days` : ''}
            {skipped.gap && (skipped.accumulatorBlanked || skipped.staleRow || skipped.closeDistrusted) ? ', ' : ''}
            {skipped.accumulatorBlanked ? `${skipped.accumulatorBlanked} had the weekly accumulator blanked to zero mid-week` : ''}
            {skipped.accumulatorBlanked && (skipped.staleRow || skipped.closeDistrusted) ? ', ' : ''}
            {skipped.staleRow ? `${skipped.staleRow} repeat an earlier close verbatim` : ''}
            {skipped.staleRow && skipped.closeDistrusted ? ', ' : ''}
            {skipped.closeDistrusted ? `${skipped.closeDistrusted} fall on a close whose whole cohort failed to reconcile` : ''}
            .
          </span>
        ) : null}
      </p>

      {detail.distrustedCloses.length ? (
        <p className="capital-warn capital-note">
          {plural(detail.distrustedCloses.length, 'close')} were skipped entirely because not one
          account on them reconciled:{' '}
          {detail.distrustedCloses.map((row) => `${row.date} (${row.reconciled}/${row.pairs})`).join(', ')}.
        </p>
      ) : null}

      {movement.grossToBalanceGap ? <GrossGap gap={movement.grossToBalanceGap} /> : null}
    </section>
  );
}

/**
 * The gap between gross P&L and what reached the balance.
 *
 * Shown as four counts, never as one total. It is a per-contract commission on
 * some accounts and exactly nothing on more of them, and adding those together
 * produces a number that describes neither.
 */
function GrossGap({ gap }) {
  return (
    <details className="capital-rest">
      <summary>
        Gross P&amp;L against what reached the balance — {gap.pairs} close-pairs,{' '}
        {plural(gap.accounts, 'account')}
      </summary>
      <ul className="capital-events">
        <li>
          <strong>{money(gap.cost.amount)}</strong> over {gap.cost.pairs} pairs where the balance
          moved less than gross. On some accounts this is exactly a round turn per contract —{' '}
          <code>$3.76</code> on one cash account, every gap an exact multiple of it.
        </li>
        <li>
          <strong>{gap.exact.pairs} pairs</strong> where gross and the balance agree to the cent, so
          no cost is visible in the data at all for those accounts.
        </li>
        <li>
          <strong>{gap.against.pairs + gap.balanceFrozen.pairs} pairs</strong> run the other way or
          report a P&amp;L against a balance that did not move — import artefacts, not costs.
        </li>
        <li className="muted">
          No total is given. Those are three different things and summing them would describe none
          of them.
        </li>
      </ul>
    </details>
  );
}

/**
 * The chart is cumulative net P&L, not capital.
 *
 * A capital line is not comparable between two closes that saw different
 * accounts, and coverage here swings from 11% to 60% between consecutive
 * closes — the line would show a collapse that is only an upload schedule.
 * Cumulative P&L is a flow: an account that does not report contributes zero
 * rather than dropping out of the level.
 */
function Timeline({ block }) {
  const points = block.timeline;
  if (points.length < 2) {
    return (
      <section className="capital-section">
        <h5>Over time</h5>
        <p className="capital-note">
          Only {plural(points.length, 'close')} imported. A movement needs two.
        </p>
      </section>
    );
  }

  const values = points.map((point) => point.cumulativeNetPnl);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (index) => (index / (points.length - 1)) * 100;
  const y = (value) => 100 - ((value - min) / span) * 100;
  const line = points.map((point, index) => `${x(index)},${y(point.cumulativeNetPnl)}`).join(' ');
  const last = points[points.length - 1];

  return (
    <section className="capital-section">
      <h5>Over time</h5>
      <p className="capital-note">
        Cumulative net P&amp;L, not capital. The capital level is not comparable between two closes
        that saw different accounts — coverage below swings between{' '}
        {Math.round(Math.min(...points.map((point) => point.coverage ?? 0)) * 100)}% and{' '}
        {Math.round(Math.max(...points.map((point) => point.coverage ?? 0)) * 100)}% of this
        segment — so plotting it would draw a collapse that is only an upload schedule.
      </p>

      <div className="capital-chart">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Cumulative net P&L">
          {min < 0 && max > 0 ? (
            <line x1="0" y1={y(0)} x2="100" y2={y(0)} className="capital-zero" vectorEffect="non-scaling-stroke" />
          ) : null}
          <polyline points={line} className="capital-line" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="capital-chart-ends">
          <span>{points[0].date}</span>
          <span className={last.cumulativeNetPnl < 0 ? 'capital-negative' : 'capital-positive'}>
            {signed(last.cumulativeNetPnl)}
          </span>
          <span>{last.date}</span>
        </div>
      </div>

      <div className="capital-table-wrap">
        <table className="capital-table">
          <thead>
            <tr>
              <th scope="col">Close</th>
              <th scope="col">
                Accounts
                <em>reporting</em>
              </th>
              <th scope="col">Balances seen</th>
              <th scope="col">Net P&amp;L</th>
              <th scope="col">Unaccounted</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date} className={point.trusted ? '' : 'capital-distrusted'}>
                <th scope="row">{point.date}</th>
                <td>
                  {point.accounts}
                  {point.coverage !== null ? <em> {Math.round(point.coverage * 100)}%</em> : null}
                </td>
                <td>{money(point.capitalObserved)}</td>
                <td className={point.netPnl < 0 ? 'capital-negative' : ''}>
                  {point.netPnlAccounts ? signed(point.netPnl) : '—'}
                  {point.netPnlAccounts ? <em> {point.netPnlAccounts} acct</em> : null}
                </td>
                <td>
                  {point.unexplainedAccounts
                    ? <span className="capital-warn">{signed(point.unexplainedAmount)}</span>
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="capital-note muted">
        &ldquo;Balances seen&rdquo; is only the accounts that reported on that close, so it rises and
        falls with who uploaded. It is not the desk&apos;s capital on that day.
      </p>
    </section>
  );
}

function Declined({ rows }) {
  if (!rows.length) return null;
  return (
    <details className="capital-rest capital-declined">
      <summary>{rows.length} figures this panel will not produce, and why</summary>
      <ul className="capital-events">
        {rows.map((row) => (
          <li key={row.figure}>
            <strong>{row.figure}</strong>
            <span className="muted">{row.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export { CapitalDetailPanel };
