/**
 * What a panel prints while it is waiting for its own data, and when it could
 * not get it.
 *
 * NOT LOADED IS NOT EMPTY. A panel whose rows have not arrived and a panel
 * whose question has no findings render the same nothing, and the difference is
 * the whole point of moving these fetches off the login: "every algorithm
 * cohort is running one configuration" is a claim, and printing it over data
 * that never arrived is the worst outcome this change could produce.
 *
 * The register is the one StackPlaybook.jsx already uses for the same
 * situation — say what is missing, say what the figures are doing without it,
 * and never print a zero in its place. An error says what failed and offers to
 * try again; it is not a failed save and must never read like one, which is the
 * distinction persistEdit draws on the write side.
 */
export default function PanelLoadState({ load, waiting, onRetry = null }) {
  const status = load?.status || 'loaded';
  if (status === 'error') {
    return (
      <p className="muted chart-empty">
        {load?.error || 'Could not load this panel.'}
        {onRetry ? (
          <>
            {' '}
            <button type="button" className="ghost-button" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : null}
      </p>
    );
  }
  return <p className="muted chart-empty">{waiting}</p>;
}
