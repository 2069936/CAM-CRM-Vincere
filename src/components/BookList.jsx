/**
 * A list whose length is the size of the book.
 *
 * The desk manager's report was about the client pipeline — "106 clients render
 * as one row that extends forever" — and his instruction was to make it collapse
 * or stack, and to do the same to every other view that lists every client. On
 * the export in the repo the pipeline is 95 of 96 clients in a single Active
 * column beside four that hold one card between them: about seven thousand
 * pixels of one lane, with the other four ending in the first screenful.
 *
 * THE TREATMENT, and it is deliberately one treatment rather than a decision per
 * panel: a list that grows with the book gets a fixed height and its own scroll,
 * states its total, and says out loud that it scrolls. Nothing is dropped, no
 * "top 10", no ordering invented to decide which ten. Every client is still
 * rendered and still reachable.
 *
 * The last part is not decoration. This codebase has twice shipped a list that
 * looked complete and was not — a `+N more` rendered as a plain span with no
 * expansion, hiding 192 of 267 configuration differences, and a drill-down whose
 * rows past a limit were dropped outright. A bounded box with no affordance
 * looks exactly like a truncated one, so the note is what separates "there is
 * more, scroll" from "that is all of them".
 */
export default function BookList({
  items = [],
  children,
  keyOf = (item, index) => index,
  noun = 'client',
  nounPlural = null,
  empty = null,
  /**
   * How many entries fit before the box starts scrolling. Only decides when the
   * note is worth printing — the height is CSS, and the box scrolls whether or
   * not anyone was told. Passed per caller because a pipeline card and a
   * checkbox are not the same height.
   */
  fits = 8,
  className = '',
  tone = '',
}) {
  const plural = nounPlural || `${noun}s`;
  const total = items.length;

  if (!total) {
    return <div className={`book-list book-list-empty ${className}`.trim()}>{empty}</div>;
  }

  return (
    <div className={`book-list ${className}`.trim()}>
      <div className={`book-list-body ${tone}`.trim()}>
        {items.map((item, index) => (
          <div className="book-list-item" key={keyOf(item, index)}>
            {children(item, index)}
          </div>
        ))}
      </div>
      {total > fits ? (
        <p className="book-list-note muted">
          All {total} {total === 1 ? noun : plural} are here — the list scrolls.
        </p>
      ) : null}
    </div>
  );
}
