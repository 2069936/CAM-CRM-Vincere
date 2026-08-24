import { formatCurrency } from "../domain/report";

/**
 * How much of one business's own money no algorithm claims.
 *
 * ONE COPY, RENDERED IN TWO PLACES. The ranking panel and the algorithm detail
 * view need the identical statement — nearly half the money on the account-days
 * the ranking covers is attributed to no algorithm at all, and a page that omits
 * it reads as a full accounting of the desk — and a second, slightly reworded
 * copy is how the two screens end up disagreeing about what "coverage" means.
 *
 * The percentage is deliberately per business and never across them. `coverage`
 * is the object `buildCoverage` produces, so its `shareRefusal` arrives already
 * written: a business whose accounts netted exactly zero gets a refusal rather
 * than a division by zero.
 */
export default function BusinessCoverageLine({ coverage, lead = "What this business does not see" }) {
  if (!coverage) return null;
  return (
    <p className="muted board-coverage">
      <strong>{lead}:</strong> over the {coverage.accountDays} account-day
      {coverage.accountDays === 1 ? "" : "s"} it covers, the accounts themselves made{" "}
      {formatCurrency(coverage.accountPnl)} and the algorithms on them account for{" "}
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

export { BusinessCoverageLine };
