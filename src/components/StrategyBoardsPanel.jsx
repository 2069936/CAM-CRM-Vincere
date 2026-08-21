import { ArrowDownRight, ArrowUpRight, CalendarDays, Minus } from "lucide-react";
import { formatCurrency } from "../domain/report";
import { boardRefusals } from "../domain/strategyBoards";

/**
 * The rank cell.
 *
 * An unranked row prints a dash with the reason on it rather than a number, and
 * it is not silently dropped: the desk still needs to see that ARPD_PF exists
 * and that two account-days is all there is behind it.
 */
function RankCell({ row }) {
  if (row.rank) return <td className="muted board-rank">{row.rank}</td>;
  return (
    <td className="board-rank">
      <span className="desk-refusal" title={row.rankRefusal}>
        no rank
      </span>
    </td>
  );
}

/**
 * The mean and its interval.
 *
 * The interval is on the same cell as the figure it belongs to, never in a
 * column of its own two columns away, because the only question it answers is
 * "how much of this number is evidence".
 */
function MeanCell({ row }) {
  if (row.meanPerAccountDay === null) {
    return (
      <td>
        <span className="desk-refusal" title={row.ciRefusal}>
          nothing measured
        </span>
      </td>
    );
  }
  return (
    <td className="board-mean">
      <strong className={row.meanPerAccountDay >= 0 ? "positive" : "negative"}>
        {formatCurrency(row.meanPerAccountDay)}
      </strong>
      {row.ci ? (
        <small
          className="muted"
          title={`95% interval, clustered on ${row.ci.clusters} accounts. Account-days off one account are not independent draws.`}
        >
          95% CI {formatCurrency(row.ci.low)} to {formatCurrency(row.ci.high)}
        </small>
      ) : (
        <small className="desk-refusal" title={row.ciRefusal}>
          no interval
        </small>
      )}
    </td>
  );
}

/** Up, down or flat — three states, so nothing prints an up arrow for zero. */
function TrendCell({ row, anchor }) {
  if (row.trendRefusal) {
    return (
      <td>
        <span className="desk-refusal" title={row.trendRefusal}>
          not measured
        </span>
      </td>
    );
  }
  const Icon =
    row.trendDirection === "up"
      ? ArrowUpRight
      : row.trendDirection === "down"
        ? ArrowDownRight
        : Minus;
  const tone =
    row.trendDirection === "up"
      ? "positive"
      : row.trendDirection === "down"
        ? "negative"
        : "muted";
  return (
    <td className={tone}>
      <Icon size={12} />{" "}
      {row.trendDirection === "flat"
        ? "level"
        : formatCurrency(Math.abs(row.trend))}
      <small className="muted">
        vs the seven days before {anchor}
      </small>
    </td>
  );
}

function BoardTable({ board, anchor }) {
  return (
    <div className="table-wrap">
      <table className="ops-table board-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Algorithm</th>
            <th
              scope="col"
              title="Total measured P&L divided by the account-days the export actually reported, including the days it reported as exactly zero. This is what the board is ordered by."
            >
              Mean P&amp;L per reported account-day
            </th>
            <th scope="col" title="What the rank gate reads: reported account-days, and the accounts they came from.">
              Evidence
            </th>
            <th scope="col" title="Up, down, and reported flat. A flat day is a day the algorithm ran and made exactly nothing, which is not the same as a day nobody reported.">
              Days up / down / flat
            </th>
            <th scope="col" title="Up days as a share of decided days. Flat days are excluded from this figure and counted in the column to the left.">
              Win rate, decided days
            </th>
            <th scope="col" title="Accounts whose total for this algorithm is above zero, out of the accounts it ran on.">
              Accounts in profit
            </th>
            <th scope="col" className="board-exposure" title={board.totalPnlNote}>
              Total P&amp;L — exposure, not rank
            </th>
            <th scope="col">P&amp;L, seven days to {anchor}</th>
            <th scope="col">Trend</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((row) => (
            <tr key={row.name} className={row.rank ? undefined : "board-unranked"}>
              <RankCell row={row} />
              <th scope="row">
                <strong>{row.name}</strong>
                <small className="muted">
                  {row.clients} client{row.clients === 1 ? "" : "s"}
                </small>
              </th>
              <MeanCell row={row} />
              <td>
                {row.accountDays} account-day{row.accountDays === 1 ? "" : "s"}
                <small className="muted">
                  {row.accounts} account{row.accounts === 1 ? "" : "s"}
                  {row.unmeasuredAccountDays
                    ? ` · ${row.unmeasuredAccountDays} unmeasured`
                    : ""}
                </small>
              </td>
              <td className="board-days">
                <span className="positive">{row.upDays}</span> /{" "}
                <span className="negative">{row.downDays}</span> /{" "}
                <span className="muted">{row.flatDays}</span>
              </td>
              <td>
                {row.winRate === null ? (
                  <span className="desk-refusal" title="No day on this board moved either way, so there is no decided day to take a share of.">
                    no decided day
                  </span>
                ) : (
                  <>
                    {row.winRate}%
                    <small className="muted">of {row.decidedDays} decided</small>
                  </>
                )}
              </td>
              <td>
                {row.accountsProfitablePct === null ? (
                  <span className="muted">-</span>
                ) : (
                  <>
                    {row.accountsProfitablePct}%
                    <small className="muted">
                      {row.accountsProfitable} of {row.accounts}
                    </small>
                  </>
                )}
              </td>
              <td className={`board-exposure ${row.totalPnl >= 0 ? "positive" : "negative"}`}>
                {formatCurrency(row.totalPnl)}
              </td>
              <td className={row.recentPnl >= 0 ? "positive" : "negative"}>
                {formatCurrency(row.recentPnl)}
                <small className="muted">
                  {row.recentAccountDays} account-day
                  {row.recentAccountDays === 1 ? "" : "s"}
                </small>
              </td>
              <TrendCell row={row} anchor={anchor} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How much of the board's own money no algorithm on it claims. */
function CoverageLine({ board }) {
  const { coverage } = board;
  return (
    <p className="muted board-coverage">
      <strong>What this board does not see:</strong> over the {coverage.accountDays} account-day
      {coverage.accountDays === 1 ? "" : "s"} it covers, the accounts themselves made{" "}
      {formatCurrency(coverage.accountPnl)} and the algorithms above account for{" "}
      {formatCurrency(coverage.attributedPnl)}.{" "}
      {coverage.unattributedShare === null ? (
        <span className="desk-refusal" title={coverage.shareRefusal}>
          A share of that is not reportable.
        </span>
      ) : (
        <>
          {formatCurrency(coverage.unattributedPnl)} — {Math.abs(coverage.unattributedShare)}% of
          it — is in no algorithm&rsquo;s total, and is not assigned to one.
        </>
      )}
      {coverage.unmeasuredAccountDays
        ? ` A further ${coverage.unmeasuredAccountDays} account-day${coverage.unmeasuredAccountDays === 1 ? "" : "s"} ran an algorithm nothing measured at all.`
        : ""}
    </p>
  );
}

/**
 * The algorithm boards.
 *
 * ONE BOARD PER BUSINESS, AND THEY ARE NOT ONE BOARD SPLIT IN THREE. The panel
 * this replaced ranked fifteen algorithms in a single list ordered by total P&L
 * — which, on a book where everything loses, is a list of what the desk runs
 * least. A cash algorithm, a Bullet-Bot evaluation and a funded prop account
 * were the same row type, and 30.0% of the money being ranked was not prop money
 * at all.
 *
 * There is no headline figure and no composite score here for the same reason
 * there is none on the desk-money panel: the moment one exists, it is what gets
 * read.
 */
export default function StrategyBoardsPanel({ result }) {
  const refusals = boardRefusals(result);
  if (!result?.boards?.length) {
    return (
      <section className="panel strategy-boards-panel">
        <div className="panel-heading">
          <h3>Algorithm boards</h3>
          <span className="badge muted">One board per business</span>
        </div>
        <p className="muted" style={{ padding: "12px 0" }}>
          No close on this book carries a per-algorithm split, so there is nothing to rank. The
          board is left empty rather than filled by dividing each account&rsquo;s day across
          whatever was running.
        </p>
      </section>
    );
  }

  return (
    <section className="panel strategy-boards-panel">
      <div className="panel-heading">
        <h3>Algorithm boards</h3>
        <span className="badge muted">
          {result.boards.length} businesses · ranked by mean per account-day
        </span>
      </div>
      <p className="desk-basis">
        <CalendarDays size={13} /> {result.basis.label}
      </p>
      <p className="muted desk-basis-note">{result.boardsDoNotCompare}</p>
      <p className="muted desk-basis-note">{result.gate.note}</p>

      {result.boards.map((board) => (
        <div className="board-block" key={board.key}>
          <div className="board-head">
            <h4>{board.label}</h4>
            <span className="badge muted">
              {board.rankedCount} ranked · {board.unrankedCount} without a rank
            </span>
          </div>
          <p className="muted board-note">{board.note}</p>
          <BoardTable board={board} anchor={result.basis.anchor} />
          <CoverageLine board={board} />
        </div>
      ))}

      {result.reconciliation.rows.length ? (
        <p className="muted desk-reconciliation">
          <strong>On no board:</strong>{" "}
          {result.reconciliation.rows
            .map(
              (row) =>
                `${row.accountDays} account-day${row.accountDays === 1 ? "" : "s"} on ${row.accounts} ${row.segment.toLowerCase()} account${row.accounts === 1 ? "" : "s"}`,
            )
            .join(" · ")}
          . {result.reconciliation.note}
        </p>
      ) : null}

      <details className="board-refusals">
        <summary>{refusals.length} figures these boards will not produce, and why</summary>
        <ul className="capital-events">
          {refusals.map((row) => (
            <li key={row.figure}>
              <strong>{row.figure}</strong>
              <span className="muted">{row.reason}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export { StrategyBoardsPanel };
