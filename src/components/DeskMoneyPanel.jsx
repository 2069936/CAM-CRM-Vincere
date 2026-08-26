import { CalendarDays, ChevronDown } from "lucide-react";
import { formatCurrency } from "../domain/report";

// The id of the panel a business row opens, so aria-expanded has something to
// point at: the detail cannot render inside the table and lands further down the
// document, which a screen reader cannot associate on its own.
export const CAPITAL_DETAIL_ID = "manager-capital-detail";

/**
 * A drill-down control for ONE segment inside a business row.
 *
 * Declared at module scope, NOT inside DeskMoneyPanel. A component defined in a
 * render body gets a new function identity every render, React treats that as a
 * different element type, and the whole subtree is unmounted and remounted — so
 * the button the user just pressed is destroyed, focus falls back to <body>, and
 * a keyboard user loses their place on every toggle.
 *
 * The value handed back is the long domain segment name, never the short label.
 * buildCapitalDetail keys its blocks off segmentFor(), the same function
 * buildSegmentTotals uses, so "Evaluations - Bullet Bot" matches and "Bullet Bot"
 * (what the row prints) would match nothing and silently open a segment reading
 * $0.
 */
function SegmentDrillButton({ segment, open, onToggleSegment }) {
  if (!onToggleSegment) return <span className="desk-segment-chip">{segment}</span>;
  return (
    <button
      type="button"
      className={open ? "desk-segment-chip open" : "desk-segment-chip"}
      aria-expanded={open}
      aria-controls={open ? CAPITAL_DETAIL_ID : undefined}
      title={open ? `Hide capital detail for ${segment}` : `Capital detail for ${segment}`}
      onClick={() => onToggleSegment(open ? null : segment)}
    >
      <ChevronDown className={open ? "chevron open" : "chevron"} size={11} />
      {segment}
    </button>
  );
}

/** A money cell that prints a refusal instead of a number when there is one. */
function DeskFigure({ value, refusal, alternative = null, signed = true }) {
  if (value !== null && value !== undefined) {
    return (
      <span className={signed ? (value >= 0 ? "positive" : "negative") : undefined}>
        {formatCurrency(value)}
      </span>
    );
  }
  return (
    <span className="desk-refusal" title={refusal || undefined}>
      {alternative || "not reported"}
    </span>
  );
}

function DeskRows({ desk, weekly = true, openSegment = null, onToggleSegment = null }) {
  return (
    <div className="table-wrap">
      <table className="ops-table desk-money-table">
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col">{weekly ? "Daily P&L" : "P&L over the month"}</th>
            {weekly ? <th scope="col">Weekly P&amp;L</th> : null}
            <th scope="col">
              {desk.basis.countNoun === "account" ? "Accounts" : "Account closes"}
            </th>
            <th scope="col">Clients</th>
            <th scope="col">Balance</th>
          </tr>
        </thead>
        <tbody>
          {desk.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <strong title={row.note}>{row.label}</strong>
                {row.segments.length ? (
                  <small className="desk-segment-chips">
                    {row.segments.map((segment) => (
                      <SegmentDrillButton
                        key={segment}
                        segment={segment}
                        open={openSegment === segment}
                        onToggleSegment={onToggleSegment}
                      />
                    ))}
                  </small>
                ) : (
                  <small className="muted">no account in this business today</small>
                )}
              </th>
              <td><DeskFigure value={row.dailyPnl} /></td>
              {weekly ? (
                <td>
                  <DeskFigure value={row.weeklyPnl} refusal={row.refusals.weeklyPnl} />
                </td>
              ) : null}
              <td>{row.accounts}</td>
              <td>{row.clients}</td>
              <td>
                <DeskFigure
                  value={row.balance}
                  signed={false}
                  refusal={row.refusals.balance}
                  alternative={row.planSize !== null
                    ? `plan size ${formatCurrency(row.planSize)} — not capital`
                    : "not capital"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the desk made, as four rows that are never added together.
 *
 * THERE IS NO HEADLINE NUMBER ON THIS PANEL, and that is the feature. There used
 * to be one — "Team daily P&L -$169,926.90" — and it was a cash desk's real
 * client money added to a prop desk's simulated plan-size result, with Bullet Bot
 * netted against the ordinary algorithms inside it. It got the SIGN wrong twice
 * in fourteen days: on 2026-07-21 it printed green at +$605.79 while the prop
 * desk had lost $5,505.46 and cash carried it; on 2026-07-16 it printed red at
 * -$5,890.50 while prop MADE $1,647.50.
 *
 * Unclassified is its own row rather than folded anywhere, because 51 accounts
 * and -$4,894.44 is a classification backlog and not a result. Ignored and orphan
 * closes are counted underneath as reconciliation, with no money against them.
 */
export default function DeskMoneyPanel({ desk, month = null, openSegment = null, onToggleSegment = null }) {
  return (
    <section className="panel desk-money-panel">
      <div className="panel-heading">
        <h3>Desk money</h3>
        <span className="badge muted">Four businesses · no total</span>
      </div>
      <p className="desk-basis">
        <CalendarDays size={13} /> {desk.basis.label}
      </p>
      <p className="muted desk-basis-note">{desk.rowsDoNotSum}</p>
      <DeskRows
        desk={desk}
        openSegment={openSegment}
        onToggleSegment={onToggleSegment}
      />
      {desk.reconciliation.rows.length ? (
        <p className="muted desk-reconciliation">
          <strong>Reconciliation, not money:</strong>{" "}
          {desk.reconciliation.rows
            .map((row) => `${row.accounts} ${row.label.toLowerCase()}`)
            .join(" · ")}
          . {desk.reconciliation.note} They used to be inside the headline: the difference between
          the old tile and the old history strip was exactly these accounts, on all 14 closes.
        </p>
      ) : null}
      {month ? (
        <div className="desk-month">
          <h4>Month to date</h4>
          <p className="desk-basis">
            <CalendarDays size={13} /> {month.basis.label}
          </p>
          <DeskRows desk={month} weekly={false} />
          <p className="muted desk-basis-note">
            Weekly P&amp;L and balances are refused over a month: the weekly column is a
            Monday-to-Friday accumulator and a balance is a level, so adding either across every
            close in the month counts the same money once per close.
          </p>
        </div>
      ) : null}
    </section>
  );
}
