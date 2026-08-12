import { REASON_KINDS } from '../domain/reportReasons';

/**
 * The "what shaped this close" block of a client report.
 *
 * Opt-in through the existing report designer (`showReasons` in reportConfig.js
 * REPORT_FIELDS, off by default, per-CAM or per-client through the same scope
 * radio every other toggle uses).
 *
 * WHY IT EXISTS. Daniel Swanson's real 2026-08-11 PDF prints
 * `DAILY REALIZED PNL $0`, the word `BREACHED` beside two accounts, and an
 * enabled `Bullet Bot-1.1` on one of them. The two orders his desk placed that
 * day were both refused by the broker with
 * `Rejected: Your account is currently set to liquidation only due to Drawdown
 * level breached at end of day.` — a sentence that was in the import the report
 * was built from, and that the report had no place to put. The client read $0
 * with no way to tell "nothing happened" from "the firm stopped me".
 *
 * WHAT IT MUST NEVER DO.
 *
 *  1. Join the facts for the reader. Every bullet is one observation. The two
 *     Daniel accounts appear twice each — once as a refused order and once as a
 *     drawdown reading — instead of once as "breached, so nothing traded",
 *     because on this same day Todd Grehl has an account that is BOTH past its
 *     drawdown AND carrying only disabled strategies, and either sentence alone
 *     would be a guess about which one mattered.
 *  2. Rewrite the broker. The refusal text is printed verbatim in quotes and
 *     attributed to the platform. A paraphrase is the desk taking on a claim it
 *     did not make, on a page the client keeps.
 *  3. Let a missing source read as a clean bill. `reasons.unstated` renders in
 *     its own block with its own heading, and the section renders whenever
 *     EITHER list is non-empty — an empty reasons list beside an unavailable
 *     orders table must not print as an empty section.
 */
export default function ReportReasonsSection({ reasons }) {
  if (!reasons?.hasAnything) return null;

  return (
    <section className="report-section report-reasons">
      <h2>What shaped this close</h2>
      <p className="report-reasons-lead">
        Each line below is one thing the platform recorded on {reasons.date}, stated on its own.
      </p>

      {reasons.reasons.length ? (
        <ul className="report-reasons-list">
          {reasons.reasons.map((entry, index) => (
            <li key={`${entry.kind}-${entry.accountName || 'client'}-${index}`} className={`report-reason report-reason-${entry.kind}`}>
              <p className="report-reason-headline">{entry.headline}</p>
              {entry.detail ? <p className="report-reason-detail">{entry.detail}</p> : null}
              {(entry.quotes || []).map((quote) => (
                <blockquote key={quote.text} className="report-reason-quote">
                  <span className="report-reason-quote-label">
                    The platform’s reason{quote.count > 1 ? `, on ${quote.count} orders` : ''}:
                  </span>{' '}
                  “{quote.text}”
                </blockquote>
              ))}
            </li>
          ))}
        </ul>
      ) : null}

      {reasons.unstated.length ? (
        <div className="report-reasons-unstated">
          <h3>Not stated in this report</h3>
          <ul>
            {reasons.unstated.map((item) => (
              <li key={item.topic}>{item.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export { REASON_KINDS };
