import { useMemo } from "react";
import {
  buildAccountTypeMismatch,
  accountTypeMismatchRefusals,
  buildProgrammeAccountStanding,
  programmeStandingRefusals,
} from "../domain/accountTypeAlgorithm";

/**
 * Accounts whose type names an algorithm they are not running.
 *
 * SAME REGISTER AS THE CONFIGURATION REVIEW ABOVE IT, deliberately: a list to
 * verify, never a fault list. A client can be moved onto another algorithm on
 * purpose and the evaluation account keeps the name it was opened under, so
 * nothing here says "wrong". What it does say is that the label and the rows
 * disagree, which is a thing only the CAM who moved the client can settle.
 *
 * IT IS NOT A PERFORMANCE PANEL. No P&L, no mean, no ranking. The board that
 * used to carry this collision — an account type called "Evaluation - Bullet
 * Bot" rendered as a performance board named after an algorithm — is exactly
 * what made "OGX on the Bullet Bot board" read as OGX being a Bullet Bot
 * strategy. The finding survives the board; the verdict does not.
 *
 * THE UNIT IS THE ACCOUNT. A still-true condition is re-imported every close, so
 * the strategy-row count grows with how long it has been true. The rows are
 * shown as ageing evidence, never as the headline.
 *
 * TWO FINDINGS, NOT ONE. The second block is the desk's own rule checked against
 * the book: the CAM says the only accounts that run Bullet Bot are evaluation
 * accounts, so a LIVE account of another type running it is an exception and
 * there should be none. It is separate from the first because it starts from the
 * programme rather than from the label, and because its four groups are four
 * different things — an exception, a retired account, an untyped account and a
 * close with no account row. The one-lump version of that count is several times
 * larger than the work it describes.
 */
/**
 * One programme, measured against the rule the desk states about it.
 *
 * The four groups are printed as four, permanently. Folding them into one
 * "running where it is not typed for" number is what the line above this block
 * already does for the labelling question, and it is the wrong shape for a rule:
 * it makes eight accounts somebody has to look at read as forty-odd.
 */
function ProgrammeStanding({ finding }) {
  return (
    <div className="programme-standing">
      <p className="drift-intro">
        <strong>{finding.anomalyAccounts}</strong> live account
        {finding.anomalyAccounts === 1 ? "" : "s"} of another type
        {finding.anomalyAccounts === 1 ? " is" : " are"} running{" "}
        <strong>{finding.family}</strong>, of the {finding.accounts} account
        {finding.accounts === 1 ? "" : "s"} this book has seen it on
        {finding.anomalyAccounts
          ? ` — across ${finding.anomalyClients} client${finding.anomalyClients === 1 ? "" : "s"}`
          : ""}
        .{" "}
        <span
          className="muted"
          title="A still-true condition is re-imported on every close, so this row count grows with how long it has been true. The accounts are the work."
        >
          ({finding.anomalyRows} strategy row{finding.anomalyRows === 1 ? "" : "s"} behind them)
        </span>
      </p>
      <p className="drift-ask">{finding.rule}</p>
      <p className="drift-key muted">{finding.ask}</p>
      <p className="drift-key muted">{finding.notASegment}</p>
      <p className="drift-key muted">{finding.population}</p>

      <ul className="programme-standing-groups">
        {finding.byStanding.map((group) => (
          <li key={group.standing}>
            <strong>
              {group.accounts} {group.standing}
            </strong>{" "}
            <span className="muted">
              {group.segments
                .map((row) => `${row.accounts} ${row.segment.toLowerCase()}`)
                .join(", ")}
              {" — "}
              {group.note}
            </span>
          </li>
        ))}
      </ul>

      {finding.anomalyAccounts ? (
        <div className="table-wrap">
          <table className="ops-table type-mismatch-table">
            <caption className="algo-detail-caption">
              The exceptions, longest-standing first
            </caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Client</th>
                <th scope="col">Typed as</th>
                <th scope="col" title="Closes on which this account carried a row of the programme.">
                  Closes
                </th>
                <th scope="col">Seen</th>
              </tr>
            </thead>
            <tbody>
              {finding.anomalies.map((row) => (
                <tr key={row.accountKey}>
                  <th scope="row">{row.accountName}</th>
                  <td className="muted">{row.clientName || "Unnamed client"}</td>
                  <td>
                    {row.segment}
                    <small className="muted">
                      {row.rows} row{row.rows === 1 ? "" : "s"}
                      {row.enabledRows ? `, ${row.enabledRows} enabled` : ", none enabled"}
                    </small>
                  </td>
                  <td>{row.closes}</td>
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
      ) : (
        <p className="muted chart-empty">
          Every live account running {finding.family} is an evaluation account, which is what the
          rule says. The groups above are counted anyway, so that the day one stops being true the
          panel says so rather than going quiet.
        </p>
      )}
    </div>
  );
}

export default function AccountTypeMismatchPanel({ clients = [], asOfDate = "" }) {
  const finding = useMemo(
    () => buildAccountTypeMismatch(clients, { asOfDate }),
    [clients, asOfDate],
  );
  const standings = useMemo(
    () => buildProgrammeAccountStanding(clients, { asOfDate }),
    [clients, asOfDate],
  );
  const refusals = accountTypeMismatchRefusals(finding);
  const standingRefusals = programmeStandingRefusals(standings);

  const elsewhere = finding.elsewhere.filter((entry) => entry.accounts > 0);

  // Clean labelling does not silence the second finding: the rule about where
  // the programme runs is checked on every book, and a panel that goes quiet
  // because half of it found nothing tells the reader nothing was checked.
  const mismatchClean = !finding.accounts && !elsewhere.length;

  return (
    <div className="type-mismatch">
      {mismatchClean ? (
        <p className="muted chart-empty">
          Every account whose type names an algorithm is running that algorithm, and that algorithm
          runs nowhere else. {finding.typedAccountsSeen} such account
          {finding.typedAccountsSeen === 1 ? "" : "s"} were read.
        </p>
      ) : (
        <>
      <p className="drift-intro">
        <strong>{finding.accounts}</strong> account{finding.accounts === 1 ? "" : "s"} of the{" "}
        {finding.typedAccountsSeen} typed for an algorithm are running a different one — across{" "}
        {finding.clients} client{finding.clients === 1 ? "" : "s"}.{" "}
        <span
          className="muted"
          title="A still-true condition is re-imported on every close, so this row count grows with how long it has been true. The accounts are the work."
        >
          ({finding.strategyRows} strategy row{finding.strategyRows === 1 ? "" : "s"} behind them)
        </span>
      </p>
      <p className="drift-ask">{finding.ask}</p>
      <p className="drift-key muted">{finding.notASegment}</p>
      <p className="drift-key muted">{finding.population}</p>

      {finding.accounts ? (
        <>
          <p className="drift-list-note muted">
            <strong>{finding.swapped}</strong> of them carry no row of the algorithm they are named
            for at all — the shape that reads as an algorithm swapped without the type being
            updated. The other {finding.alongside} run it alongside something else.
          </p>

          <p className="type-mismatch-families">
            {finding.families.map((family, index) => (
              <span key={family.name}>
                {index ? " · " : ""}
                <strong>{family.name}</strong>{" "}
                <span className="muted">
                  {family.accounts} account{family.accounts === 1 ? "" : "s"}
                </span>
              </span>
            ))}
          </p>

          <div className="table-wrap">
            <table className="ops-table type-mismatch-table">
              <caption className="algo-detail-caption">
                Longest-running first, and the accounts with none of their own algorithm on top
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Client</th>
                  <th scope="col">Typed as</th>
                  <th scope="col">Running</th>
                  <th scope="col" title="Closes on which this account carried a strategy row. How long the disagreement has been on the book.">
                    Closes
                  </th>
                  <th scope="col">Seen</th>
                </tr>
              </thead>
              <tbody>
                {finding.rows.map((row) => (
                  <tr key={row.accountKey} className={row.runsExpected ? undefined : "board-unranked"}>
                    <th scope="row">{row.accountName}</th>
                    <td className="muted">{row.clientName || "Unnamed client"}</td>
                    <td className="muted">
                      {row.segment}
                      {row.runsExpected ? (
                        <small className="muted">
                          running {row.expected} too, on {row.expectedRows} row
                          {row.expectedRows === 1 ? "" : "s"}
                        </small>
                      ) : (
                        <small className="desk-refusal" title={`No ${row.expected} row on this account in the closes read.`}>
                          no {row.expected} row at all
                        </small>
                      )}
                    </td>
                    <td>
                      {row.others.map((family) => (
                        <span key={family.name} className="type-mismatch-family">
                          <strong>{family.name}</strong>{" "}
                          <span className="muted">
                            {family.rows} row{family.rows === 1 ? "" : "s"}
                            {family.enabledRows
                              ? `, ${family.enabledRows} enabled`
                              : ", none enabled"}
                          </span>
                        </span>
                      ))}
                    </td>
                    <td>{row.closes}</td>
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
        </>
      ) : null}

      {elsewhere.map((entry) => (
        <p className="type-mismatch-elsewhere muted" key={entry.family}>
          <strong>The same question from the other side.</strong> {entry.family} is also running on{" "}
          {entry.accounts} account{entry.accounts === 1 ? "" : "s"} that are not typed for it —{" "}
          {entry.rows
            .map(
              (bucket) =>
                `${bucket.accounts} ${bucket.segment.toLowerCase()} (${bucket.rows} row${bucket.rows === 1 ? "" : "s"})`,
            )
            .join(", ")}
          . Whether the type or the algorithm is the stale one is the same question as above.
        </p>
      ))}

      <details className="board-refusals">
        <summary>{refusals.length} figures this finding will not produce, and why</summary>
        <ul className="capital-events">
          {refusals.map((row) => (
            <li key={row.figure}>
              <strong>{row.figure}</strong>
              <span className="muted">{row.reason}</span>
            </li>
          ))}
        </ul>
      </details>
        </>
      )}

      {/* The second finding, in the same register and on the same unit: the
          desk's own rule about where the programme runs, checked against the
          book. Beside the labelling question above rather than inside it —
          that one starts from what an account is called, this one starts from
          the programme and asks whether the rule holds. */}
      {standings.length ? (
        <div className="programme-standing-block">
          <h5>{standings.map((row) => row.family).join(", ")} against the rule it runs under</h5>
          {standings.map((standing) => (
            <ProgrammeStanding key={standing.family} finding={standing} />
          ))}
          <details className="board-refusals">
            <summary>
              {standingRefusals.length} figures this second finding will not produce, and why
            </summary>
            <ul className="capital-events">
              {standingRefusals.map((row) => (
                <li key={row.figure}>
                  <strong>{row.figure}</strong>
                  <span className="muted">{row.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export { AccountTypeMismatchPanel };
