import { ArrowDownRight, ArrowUpRight, CalendarDays, Minus } from "lucide-react";
import { formatCurrency } from "../domain/report";
import { rankingRefusals } from "../domain/algorithmRanking";
import BusinessCoverageLine from "./BusinessCoverageLine";

/**
 * The algorithm ranking.
 *
 * ONE RANK PER ALGORITHM. This panel used to render four boards, one per
 * business, with an algorithm holding a row on each. On this book that printed
 * OGX as the best row on cash and as an unranked row on ordinary prop at the
 * same time, over the same closes and the same configuration, and the desk read
 * it as two behaviours of one algorithm. The account type is a property of the
 * account; it is not in the ranking figure and it never was a behaviour.
 *
 * MONEY IS STILL PER BUSINESS AND IS STILL NEVER ADDED — AND IT IS NO LONGER ON
 * A ROW. The first cut of this table kept the split as a column: each row listed
 * what the algorithm made in each business it runs in, side by side, with no
 * total. That column printed the account-days of each business in the same cell
 * as the dollars, so it published the account-type verdict as a division: on
 * this book OGX's cell read -$1,569.50 over 29 prop account-days and +$1,105.50
 * over 47 cash ones, which is the -$54.12 and the +$23.52 the desk manager
 * rejected. There is no dollar on a row now. The money, per business, is in the
 * four coverage lines under the table, where it belongs to the DESK across every
 * algorithm at once and no algorithm's rate can be read out of it.
 *
 * There is no headline figure and no composite score here for the same reason
 * there is none on the desk-money panel: the moment one exists, it is what gets
 * read.
 */

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

/**
 * The trend, as a difference of MEANS per account-day.
 *
 * It was a difference of window totals, which moves with how many accounts were
 * deployed in each window — the same defect that made total P&L rank deployment
 * upside down, one column to the left. Four states: up, down, level, and a
 * refusal where one of the two windows measured nothing.
 */
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
        per account-day, vs the seven days before {anchor}
      </small>
    </td>
  );
}

/**
 * The algorithm name, what it trades, and the way into its own record.
 *
 * The instrument is on the row because the ranking is in dollars per account-day
 * and dollars per account-day are not normalised for contract size: an algorithm
 * on NQ moves about ten times what one on MNQ does. With no handler wired the
 * name stays plain text rather than becoming a button that does nothing.
 */
function AlgorithmCell({ row, selected, onSelect }) {
  const instruments = row.instruments.map((entry) => entry.name);
  const shown = instruments.slice(0, 2).join(", ");
  const meta = (
    <small className="muted" title={instruments.length > 2 ? instruments.join(", ") : undefined}>
      {row.clients} client{row.clients === 1 ? "" : "s"}
      {shown ? ` · ${shown}` : ""}
      {instruments.length > 2 ? ` +${instruments.length - 2}` : ""}
    </small>
  );
  if (!onSelect) {
    return (
      <th scope="row">
        <strong>{row.name}</strong>
        {meta}
      </th>
    );
  }
  return (
    <th scope="row">
      <button
        type="button"
        className="board-open-algo"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : row.name)}
        title={`Open ${row.name} — every configuration it runs, where it is deployed, and what it made in each business`}
      >
        <strong>{row.name}</strong>
      </button>
      {meta}
    </th>
  );
}

function RankingTable({ ranking, anchor, selectedAlgorithm, onSelectAlgorithm }) {
  return (
    <div className="table-wrap">
      <table className="ops-table board-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Algorithm</th>
            <th
              scope="col"
              title={ranking.unitNote}
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
            <th scope="col">Trend</th>
          </tr>
        </thead>
        <tbody>
          {ranking.rows.map((row) => (
            <tr
              key={row.name}
              className={[
                row.rank ? "" : "board-unranked",
                selectedAlgorithm === row.name ? "board-row-open" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined}
            >
              <RankCell row={row} />
              <AlgorithmCell
                row={row}
                selected={selectedAlgorithm === row.name}
                onSelect={onSelectAlgorithm}
              />
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
                  <span className="desk-refusal" title="No day here moved either way, so there is no decided day to take a share of.">
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
              <TrendCell row={row} anchor={anchor} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AlgorithmRankingPanel({
  result,
  selectedAlgorithm = null,
  onSelectAlgorithm = null,
}) {
  const refusals = rankingRefusals(result);
  if (!result?.ranking?.rows?.length) {
    return (
      <section className="panel strategy-boards-panel">
        <div className="panel-heading">
          <h3>Algorithm ranking</h3>
          <span className="badge muted">One rank per algorithm</span>
        </div>
        <p className="muted" style={{ padding: "12px 0" }}>
          No close on this book carries a per-algorithm split, so there is nothing to rank. The
          table is left empty rather than filled by dividing each account&rsquo;s day across
          whatever was running.
        </p>
      </section>
    );
  }

  const { ranking } = result;

  return (
    <section className="panel strategy-boards-panel">
      <div className="panel-heading">
        <h3>Algorithm ranking</h3>
        <span className="badge muted">
          {ranking.rankedCount} ranked · {ranking.unrankedCount} without a rank
        </span>
      </div>
      <p className="desk-basis">
        <CalendarDays size={13} /> {result.basis.label}
      </p>
      <p className="muted desk-basis-note">{ranking.unitNote}</p>
      <p className="muted desk-basis-note">{result.moneyIsPerBusiness}</p>
      <p className="muted desk-basis-note">{ranking.instrumentCaveat}</p>
      <p className="muted desk-basis-note">{result.gate.note}</p>
      {onSelectAlgorithm ? (
        <p className="muted desk-basis-note">
          Select an algorithm to open its own record: every configuration it runs, the evidence
          behind each, where it is deployed and what it made in each business. It opens per
          CONFIGURATION, because two runs with different profit targets are the comparison a CAM
          is actually making — and not per account type, which is a property of the account and
          says nothing about how the algorithm behaved.
        </p>
      ) : null}

      <RankingTable
        ranking={ranking}
        anchor={result.basis.anchor}
        selectedAlgorithm={selectedAlgorithm}
        onSelectAlgorithm={onSelectAlgorithm}
      />

      <div className="board-block">
        <div className="board-head">
          <h4>What the ranking does not see, business by business</h4>
          <span className="badge muted">{result.businesses.length} businesses · never added</span>
        </div>
        {/* The only dollars on this panel. They are the desk's, over every
            algorithm in the table at once; no row above is scoped to one of
            these, which is what stops a business figure being read as one
            algorithm's performance on one account type. */}
        <p className="muted board-note">{result.crossBusinessCoverageRefusal}</p>
        {result.businesses.map((business) => (
          <div className="algo-business" key={business.key}>
            <BusinessCoverageLine
              coverage={business.coverage}
              lead={`What ${business.label} does not see`}
            />
            <p className="muted board-note">{business.note}</p>
          </div>
        ))}
      </div>

      {result.reconciliation.rows.length ? (
        <p className="muted desk-reconciliation">
          <strong>In no ranking row:</strong>{" "}
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
        <summary>{refusals.length} figures this ranking will not produce, and why</summary>
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

export { AlgorithmRankingPanel };
