import { useMemo } from "react";
import { buildAccountTypeMismatch, accountTypeMismatchRefusals } from "../domain/accountTypeAlgorithm";

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
 */
export default function AccountTypeMismatchPanel({ clients = [], asOfDate = "" }) {
  const finding = useMemo(
    () => buildAccountTypeMismatch(clients, { asOfDate }),
    [clients, asOfDate],
  );
  const refusals = accountTypeMismatchRefusals(finding);

  const elsewhere = finding.elsewhere.filter((entry) => entry.accounts > 0);

  if (!finding.accounts && !elsewhere.length) {
    return (
      <p className="muted chart-empty">
        Every account whose type names an algorithm is running that algorithm, and that algorithm
        runs nowhere else. {finding.typedAccountsSeen} such account
        {finding.typedAccountsSeen === 1 ? "" : "s"} were read.
      </p>
    );
  }

  return (
    <div className="type-mismatch">
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
    </div>
  );
}

export { AccountTypeMismatchPanel };
