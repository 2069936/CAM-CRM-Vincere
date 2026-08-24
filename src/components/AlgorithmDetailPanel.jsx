import { ArrowDownRight, ArrowUpRight, CalendarDays, Minus } from "lucide-react";
import { formatCurrency } from "../domain/report";
import { algorithmRefusals } from "../domain/algorithmRanking";
import BusinessCoverageLine from "./BusinessCoverageLine";

/**
 * One algorithm, opened from a ranking row.
 *
 * WHAT THIS SCREEN IS FOR. The desk manager is not browsing. He is standing on a
 * specific client, about to take one algorithm off and put another on.
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS WRONG. It printed one performance block
 * per BUSINESS and told the reader to "read the segment you are about to deploy
 * into". On this book that reported OGX as the best row on cash at +$23.52 per
 * account-day and as an unranked -$54.12 on ordinary prop — the same version at
 * the same sizing on the same contract, over closes that overlap almost
 * completely. Two means presented as two behaviours, when the only thing that
 * differed was which accounts happened to be in each sample.
 *
 * WHAT IT DOES NOW. It segments by CONFIGURATION — version plus the profit
 * targets and stop, which is the identity this desk already uses on the
 * configuration review. That is a property of the RUN, and it is the comparison
 * a CAM is actually making. The account type is still here, as CONTEXT: where
 * the algorithm is deployed and how much of it runs there, in account-days and
 * accounts, with no money and no mean per type, so no reader can take one type
 * as better than another for the same configuration.
 *
 * WHAT IT STILL DOES NOT DO:
 *
 *   * It computes nothing. Every figure is the ranking row the panel was opened
 *     from, handed through `buildAlgorithmDetail` untouched.
 *   * It draws no line through the closes. Bars, one per close, gaps where
 *     nothing was measured.
 *   * It shows no money for a client whose account-days nothing could attribute.
 *   * IT PRINTS NO DOLLAR FOR THE ALGORITHM OR FOR A CONFIGURATION AT ALL — not
 *     a total, not a list per business, and not a total on a close. It used to
 *     print the list, on the honest-looking grounds that a cash dollar and a
 *     prop dollar were never added into one. But the deployment table sits three
 *     inches below it with the account-days of each business in it, so the
 *     reader who divides is reading exactly the +$23.52-on-cash the desk
 *     manager threw out. The only dollars on this screen are per CLIENT and per
 *     ACCOUNT — whose money it is — and the desk's own, per business, in the
 *     coverage lines at the bottom, where the denominator is the whole desk.
 *   * It does not print an account type in the same row as a dollar. The
 *     account roster carries the account and what it made; the account types are
 *     in the deployment table, in counts, which is the same rule one aggregation
 *     step further out.
 */

function moneyClass(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "muted";
}

/** The mean and interval, stated in the same words the ranking uses. */
function HeadlineStat({ row }) {
  if (row.meanPerAccountDay === null) {
    return (
      <div className="algo-detail-stat">
        <span>Mean P&amp;L per reported account-day</span>
        <span className="desk-refusal" title={row.ciRefusal}>
          nothing measured
        </span>
      </div>
    );
  }
  return (
    <div className="algo-detail-stat">
      <span>Mean P&amp;L per reported account-day</span>
      <strong className={moneyClass(row.meanPerAccountDay)}>
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
    </div>
  );
}

function TrendStat({ row, anchor }) {
  if (row.trendRefusal) {
    return (
      <div className="algo-detail-stat">
        <span>Trend</span>
        <span className="desk-refusal" title={row.trendRefusal}>
          not measured
        </span>
      </div>
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
    <div className="algo-detail-stat">
      <span>Trend</span>
      <strong className={tone}>
        <Icon size={12} />{" "}
        {row.trendDirection === "flat" ? "level" : formatCurrency(Math.abs(row.trend))}
      </strong>
      <small className="muted">
        per account-day, vs the seven days before {anchor}
      </small>
    </div>
  );
}

/** Every measured column, in one grid. Shared by the algorithm and each of its
 * configurations, because they are the same arithmetic over different
 * populations and two copies of this markup would drift. */
function StatsGrid({ row, anchor }) {
  return (
    <div className="algo-detail-stats">
      <HeadlineStat row={row} />
      <div className="algo-detail-stat">
        <span>Evidence</span>
        <strong>
          {row.accountDays} account-day{row.accountDays === 1 ? "" : "s"}
        </strong>
        <small className="muted">
          {row.accounts} account{row.accounts === 1 ? "" : "s"} · {row.clients} client
          {row.clients === 1 ? "" : "s"}
          {row.unmeasuredAccountDays ? ` · ${row.unmeasuredAccountDays} unmeasured` : ""}
        </small>
      </div>
      <div className="algo-detail-stat">
        <span>Days up / down / flat</span>
        <strong className="board-days">
          <span className="positive">{row.upDays}</span> /{" "}
          <span className="negative">{row.downDays}</span> /{" "}
          <span className="muted">{row.flatDays}</span>
        </strong>
        <small className="muted">
          {row.winRate === null
            ? "no decided day"
            : `${row.winRate}% of ${row.decidedDays} decided days up`}
        </small>
      </div>
      <div className="algo-detail-stat">
        <span>Accounts in profit</span>
        <strong>
          {row.accountsProfitablePct === null ? "-" : `${row.accountsProfitablePct}%`}
        </strong>
        <small className="muted">
          {row.accountsProfitable} of {row.accounts}
        </small>
      </div>
      <div className="algo-detail-stat">
        <span>Per account-day, seven days to {anchor}</span>
        {row.recentMeanPerAccountDay === null ? (
          <span
            className="desk-refusal"
            title={`No account-day in the seven days to ${anchor} measured this.`}
          >
            not measured
          </span>
        ) : (
          <>
            <strong className={moneyClass(row.recentMeanPerAccountDay)}>
              {formatCurrency(row.recentMeanPerAccountDay)}
            </strong>
            <small className="muted">
              over {row.recentAccountDays} account-day{row.recentAccountDays === 1 ? "" : "s"}
            </small>
          </>
        )}
      </div>
      <TrendStat row={row} anchor={anchor} />
    </div>
  );
}

/**
 * Where the money used to be, and why it is not there.
 *
 * This was a list of dollars, one per business, never added — the careful answer
 * to "a cash dollar is not a prop dollar". It was still the rejected answer: the
 * deployment table below prints the account-days of each business, so the list
 * published a P&L per account type with the division left to the reader. On this
 * book it read -$1,569.50 over 29 prop account-days and +$1,105.50 over 47 cash
 * ones, which is -$54.12 and +$23.52 — the two figures the desk manager threw
 * out — spelled differently.
 *
 * The refusal is rendered rather than the omission being left silent: a screen
 * that simply stops showing something teaches nobody why it stopped, and the
 * list looked correct enough to be built once already.
 */
function MoneyRefusal({ refusal }) {
  if (!refusal) return null;
  return <p className="muted algo-detail-note desk-refusal">{refusal}</p>;
}

/**
 * Where it runs, in counts.
 *
 * NO MONEY COLUMN, AND NO MEAN. That is the whole point of this table: the
 * account type is a property of the account, and a P&L per account type reads as
 * a verdict on the account type. The refusal is printed above it rather than
 * left to a comment nobody sees.
 */
function DeploymentTable({ deployment, refusal, caption }) {
  if (!deployment?.length) return null;
  return (
    <div className="algo-deployment">
      <p className="muted algo-detail-note desk-refusal">{refusal}</p>
      <div className="table-wrap">
        <table className="ops-table algo-detail-table">
          <caption className="algo-detail-caption">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Account type</th>
              <th scope="col">Business</th>
              <th scope="col">Account-days</th>
              <th scope="col">Accounts</th>
              <th scope="col">Clients</th>
              <th scope="col" title="This account type's share of the account-days the algorithm ran on. A deployment weight, not a result.">
                Share of deployment
              </th>
            </tr>
          </thead>
          <tbody>
            {deployment.map((entry) => (
              <tr key={entry.segment}>
                <th scope="row">{entry.segment}</th>
                <td className="muted">{entry.businessLabel}</td>
                <td>{entry.accountDays}</td>
                <td>{entry.accounts}</td>
                <td>{entry.clients}</td>
                <td className="muted">{entry.share === null ? "-" : `${entry.share}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * One bar per close, in the unit the ranking is in.
 *
 * A close nothing measured is drawn as a hollow tick on the zero line, never as
 * a zero-height bar: "the algorithm made nothing" and "the algorithm did not
 * run" are different claims and this book has 976 measured zeroes.
 *
 * Nothing joins the bars. The gate refuses to read a result off four
 * account-days; a line through four points would hand them a shape they have not
 * earned.
 *
 * AND NO TOTAL ON THE DAY. There was a column of them, and the same figure in
 * every bar's tooltip, under the tooltip that promised every dollar was stated
 * per business. A close is whichever accounts ran that day, so the sum added a
 * cash dollar to a prop dollar; on 2026-07-30 it printed OGX's day as -$278.50
 * on a chart whose prop account-days made +$7.00, twice over — once on the
 * algorithm's chart and once on its main configuration's. The bar height and the
 * column are a MEAN per account-day, which is the unit the whole page is in.
 */
function CloseSeries({ series, note, refusal, measuredCloses }) {
  if (refusal) {
    return <p className="muted algo-detail-series-refusal desk-refusal">{refusal}</p>;
  }
  const measured = series.filter((point) => point.accountDays > 0);
  const peak = Math.max(...measured.map((point) => Math.abs(point.mean)), 1);
  const slot = 100 / Math.max(series.length, 1);
  const half = slot * 0.34;

  return (
    <div className="algo-detail-series">
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img"
        aria-label={`Measured P&L per account-day for each of the ${series.length} closes in the book, ${measured.length} of them measured`}
      >
        <line className="algo-detail-zero" x1="0" y1="30" x2="100" y2="30" />
        {series.map((point, index) => {
          const centre = slot * (index + 0.5);
          if (!point.accountDays) {
            return (
              <rect
                key={point.date}
                className="algo-detail-gap"
                x={centre - half / 2}
                y={29}
                width={half}
                height={2}
              >
                <title>{`${point.date} — not measured on this close. Not a zero.`}</title>
              </rect>
            );
          }
          const height = Math.max((Math.abs(point.mean) / peak) * 28, 0.8);
          return (
            <rect
              key={point.date}
              className={point.mean >= 0 ? "algo-detail-bar-up" : "algo-detail-bar-down"}
              x={centre - half}
              y={point.mean >= 0 ? 30 - height : 30}
              width={half * 2}
              height={height}
            >
              <title>
                {`${point.date} — ${formatCurrency(point.mean)} per account-day over ${point.accountDays} account-day${point.accountDays === 1 ? "" : "s"}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="algo-detail-series-ends">
        <span>{series[0]?.date}</span>
        <span>
          {measuredCloses} of {series.length} closes measured
        </span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
      <p className="muted algo-detail-note">{note}</p>
      <details className="algo-detail-closes">
        <summary>Close by close</summary>
        <div className="table-wrap">
          <table className="ops-table algo-detail-table">
            <thead>
              <tr>
                <th scope="col">Close</th>
                <th scope="col">Per account-day</th>
                <th scope="col">Account-days</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.date} className={point.accountDays ? undefined : "board-unranked"}>
                  <th scope="row">{point.date}</th>
                  {point.accountDays ? (
                    <>
                      <td className={moneyClass(point.mean)}>{formatCurrency(point.mean)}</td>
                      <td>{point.accountDays}</td>
                    </>
                  ) : (
                    <td colSpan={2}>
                      <span
                        className="desk-refusal"
                        title="A close this was not measured on. Not a zero."
                      >
                        not measured on this close
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** The source split, never one word covering two different kinds of evidence. */
function SourceCell({ row }) {
  if (!row.attributable) return <td className="muted">—</td>;
  const parts = [];
  if (row.daysDerived) parts.push(`derived ${row.daysDerived}d`);
  if (row.daysReported) parts.push(`reported ${row.daysReported}d`);
  if (row.daysMixed) parts.push(`both ${row.daysMixed}d`);
  return (
    <td className="muted algo-detail-source">
      <span
        title={`Derived from the account's own fills: ${formatCurrency(row.derivedPnl)}. Read off NinjaTrader's Strategies grid: ${formatCurrency(row.reportedPnl)}. The two are never blended into one figure.`}
      >
        {parts.join(" · ") || "—"}
      </span>
    </td>
  );
}

function MoneyCell({ row }) {
  if (!row.attributable) {
    return (
      <td>
        <span className="desk-refusal" title={row.refusal}>
          not attributable
        </span>
      </td>
    );
  }
  return (
    <td className={moneyClass(row.measuredPnl)}>
      {formatCurrency(row.measuredPnl)}
      <small className="muted">
        over {row.measuredAccountDays} account-day{row.measuredAccountDays === 1 ? "" : "s"}
      </small>
      {row.caveat ? (
        <small className="desk-refusal" title={row.caveat}>
          {row.unmeasuredAccountDays} not measured
        </small>
      ) : null}
    </td>
  );
}

function RosterTables({ clients, accounts, caption }) {
  return (
    <>
      <div className="table-wrap">
        <table className="ops-table algo-detail-table">
          <caption className="algo-detail-caption">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Accounts</th>
              <th
                scope="col"
                title="What this algorithm made this client. Derived where the account's fills settled it, reported where NinjaTrader's grid did, and refused where neither could."
              >
                What it made them
              </th>
              <th scope="col">Source</th>
              <th scope="col">Seen</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((row) => (
              <tr key={row.clientKey}>
                <th scope="row">
                  <strong>{row.clientName || "Unnamed client"}</strong>
                  <small className="muted">{row.accountNames.join(", ")}</small>
                </th>
                <td>{row.accounts}</td>
                <MoneyCell row={row} />
                <SourceCell row={row} />
                <td className="muted">
                  {row.firstDate === row.lastDate
                    ? row.firstDate
                    : `${row.firstDate} → ${row.lastDate}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        THE ACCOUNT TYPE IS NOT A COLUMN HERE, AND ITS ABSENCE IS THE SAME RULE
        AS THE DEPLOYMENT TABLE'S. A type printed in the same row as a dollar is
        a P&L per account type once a reader groups the rows — 24 of them for OGX
        — and the panel refuses that figure two blocks up. The types are in the
        deployment table, in counts; the accounts are here, with what the
        algorithm made each of them, which is the question a CAM standing on a
        client is actually asking. `segment` is still on the row object: it is a
        fact about the account and the domain keeps it. It is not printed beside
        the money.
      */}
      <details className="algo-detail-accounts">
        <summary>
          Account by account · {accounts.length} account
          {accounts.length === 1 ? "" : "s"}
        </summary>
        <div className="table-wrap">
          <table className="ops-table algo-detail-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Client</th>
                <th scope="col">What it made</th>
                <th scope="col">Source</th>
                <th scope="col">Seen</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((row) => (
                <tr key={row.accountKey}>
                  <th scope="row">{row.accountName}</th>
                  <td className="muted">{row.clientName || "Unnamed client"}</td>
                  <MoneyCell row={row} />
                  <SourceCell row={row} />
                  <td className="muted">
                    {row.firstDate === row.lastDate
                      ? row.firstDate
                      : `${row.firstDate} → ${row.lastDate}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/** One configuration: version, targets and stop, with its own evidence. */
function ConfigurationBlock({ configuration, anchor }) {
  return (
    <div className="board-block algo-detail-segment algo-configuration">
      <div className="board-head">
        <h4>{configuration.label}</h4>
        {configuration.sufficient ? (
          <span className="badge muted">
            reads as a result · {configuration.accountDays} account-days on{" "}
            {configuration.accounts} accounts
          </span>
        ) : (
          <span className="desk-refusal" title={configuration.evidenceRefusal}>
            not enough evidence to read
          </span>
        )}
      </div>
      {configuration.sufficient ? null : (
        <p className="muted board-note desk-refusal">{configuration.evidenceRefusal}</p>
      )}
      {configuration.stated ? null : (
        <p className="muted board-note desk-refusal">
          These account-days carry no readable parameter set, so they are held apart rather than
          merged into a configuration somebody did read.
        </p>
      )}

      <p className="muted board-note">
        <strong>Position sizing:</strong>{" "}
        {configuration.sizing.length
          ? configuration.sizing
              .map((entry) => `${entry.name} on ${entry.accountDays} account-day${entry.accountDays === 1 ? "" : "s"}`)
              .join(" · ")
          : "not stated on this export"}
        {" · "}
        <strong>Contract:</strong>{" "}
        {configuration.instruments.length
          ? configuration.instruments
              .map((entry) => `${entry.name} on ${entry.accountDays}`)
              .join(" · ")
          : "not stated"}
      </p>
      {configuration.sizingCaveat ? (
        <p className="muted board-note desk-refusal">{configuration.sizingCaveat}</p>
      ) : null}

      <StatsGrid row={configuration} anchor={anchor} />
      <MoneyRefusal refusal={configuration.moneyRefusal} />
      <CloseSeries
        series={configuration.series}
        note={configuration.seriesNote}
        refusal={configuration.seriesRefusal}
        measuredCloses={configuration.measuredCloses}
      />
      <DeploymentTable
        deployment={configuration.deployment}
        refusal={
          "Where this configuration runs, in counts. No P&L and no mean per account type: the "
          + "type is a property of the account, not of the run."
        }
        caption="Account types this configuration is deployed on"
      />
      <RosterTables
        clients={configuration.clientRows}
        accounts={configuration.accountRows}
        caption="The clients running this configuration, best first"
      />
    </div>
  );
}

export default function AlgorithmDetailPanel({ detail, onClose = null }) {
  if (!detail?.algorithm) return null;
  const refusals = algorithmRefusals(detail);

  return (
    <section className="panel algo-detail-panel">
      <div className="panel-heading">
        <h3>Algorithm · {detail.algorithm}</h3>
        <span className="badge muted">
          {detail.found
            ? `${detail.configurationCount} configuration${detail.configurationCount === 1 ? "" : "s"} · ${detail.ranked ? `#${detail.rank} of ${detail.rankedPeers} ranked` : "no rank"}`
            : "not in the ranking"}
        </span>
        {onClose ? (
          <button className="ghost-button" type="button" onClick={() => onClose()}>
            Close
          </button>
        ) : null}
      </div>

      {!detail.found ? (
        <p className="muted" style={{ padding: "12px 0" }}>
          Nothing in this book carries a row for <strong>{detail.algorithm}</strong>. Nothing is
          shown rather than an empty page of zeroes — the algorithms this book measured are{" "}
          {detail.knownAlgorithms.join(", ") || "none"}.
        </p>
      ) : (
        <>
          <p className="desk-basis">
            <CalendarDays size={13} /> {detail.basis.label}
          </p>
          <p className="muted desk-basis-note">{detail.configurationNote}</p>
          <p className="muted desk-basis-note">{detail.moneyIsPerBusiness}</p>

          <div className="board-block algo-detail-segment algo-detail-overall">
            <div className="board-head">
              <h4>Across every account it ran on</h4>
              {detail.ranked ? (
                <span className="badge muted">
                  #{detail.rank} of {detail.rankedPeers} ranked
                </span>
              ) : (
                <span className="desk-refusal" title={detail.rankRefusal}>
                  not ranked
                </span>
              )}
            </div>
            {detail.ranked ? null : (
              <p className="muted board-note desk-refusal">{detail.rankRefusal}</p>
            )}
            <StatsGrid row={detail.overall} anchor={detail.basis.anchor} />
            <MoneyRefusal refusal={detail.moneyRefusal} />
            <CloseSeries
              series={detail.series}
              note={detail.seriesNote}
              refusal={detail.measuredCloses ? null
                : "No close in this book measured this algorithm, so there is nothing to chart."}
              measuredCloses={detail.measuredCloses}
            />
            <DeploymentTable
              deployment={detail.deployment}
              refusal={detail.accountTypeRefusal}
              caption="Account types this algorithm is deployed on"
            />
            <RosterTables
              clients={detail.clientRows}
              accounts={detail.accountRows}
              caption="Every client running it, best first"
            />
          </div>

          <div className="board-block algo-configurations">
            <div className="board-head">
              <h4>
                {detail.configurationCount} configuration
                {detail.configurationCount === 1 ? "" : "s"}, most evidence first
              </h4>
              <span className="badge muted">
                {detail.readableConfigurations} read as a result
              </span>
            </div>
            {detail.comparisonRefusal ? (
              <p className="muted board-note desk-refusal">{detail.comparisonRefusal}</p>
            ) : (
              <p className="muted board-note">{detail.comparisonNote}</p>
            )}
            {detail.splitAccountDays ? (
              <p className="muted board-note">
                {detail.splitAccountDays} account-day
                {detail.splitAccountDays === 1 ? "" : "s"} ran more than one configuration of this
                algorithm at once and are counted under each, which is why the configuration
                account-days below add to more than the {detail.overall.accountDays} above.
              </p>
            ) : null}
            {detail.configurations.map((configuration) => (
              <ConfigurationBlock
                key={configuration.key}
                configuration={configuration}
                anchor={detail.basis.anchor}
              />
            ))}
          </div>

          <div className="board-block">
            <div className="board-head">
              <h4>What each business does not see</h4>
              <span className="badge muted">the desk’s money, per business</span>
            </div>
            {/* The one place on this page where a dollar carries a business
                label. These are the DESK's account-days across every algorithm
                and every configuration, so dividing them answers a question
                about the desk's cash book, not about how this algorithm behaves
                on a cash account. */}
            <p className="muted board-note">
              The only dollars on this page carrying a business are these, and they are the
              desk&rsquo;s: every algorithm and every configuration on those account-days, not{" "}
              {detail.algorithm}&rsquo;s share of them. {detail.algorithm} is one of the algorithms
              inside each figure and is not separated out of it, for the reason printed beside its
              own blocks above.
            </p>
            {detail.businesses.map((business) => (
              <BusinessCoverageLine
                key={business.key}
                coverage={business.coverage}
                lead={`What ${business.label} does not see`}
              />
            ))}
          </div>

          <details className="board-refusals">
            <summary>{refusals.length} figures this view will not produce, and why</summary>
            <ul className="capital-events">
              {refusals.map((entry) => (
                <li key={entry.figure}>
                  <strong>{entry.figure}</strong>
                  <span className="muted">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

export { AlgorithmDetailPanel };
