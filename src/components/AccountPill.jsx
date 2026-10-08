/**
 * THE PILL: ONE ACCOUNT, THE THREE THINGS PEDRO WANTS TO READ ON IT, AS A BUTTON.
 *
 * The dot, the account name, the connection name and the state in words, the
 * same on the client page strip and on the overview tiles, built from the same
 * fields (src/domain/accountPill.js) so the two cannot drift. A click opens the
 * account's detail (what it is running, held against the desk); the pill says
 * so with aria-expanded and the caller decides what "open" renders.
 *
 * EVERY COLOUR HAS WORDS BESIDE IT. The dot carries the state's colour, the
 * `.account-pill-state` span carries the state's word, and the sentence is one
 * hover away in the title. The amber corner marker for an algorithm that
 * differs from the desk is read out by a visually hidden span; it is never the
 * pill's colour and it is never red.
 *
 * "No connection name" is a normal state, printed muted, and the pill keeps
 * the account's colour.
 */
export default function AccountPill({
  pill,
  expanded = false,
  onToggle = null,
  controls = null,
}) {
  const classes = [
    'account-pill',
    `tracker-${pill.state}`,
    `tone-${pill.tone}`,
    pill.differsCount > 0 ? 'differs' : null,
    expanded ? 'expanded' : null,
  ].filter(Boolean).join(' ');
  const body = (
    <>
      <span className="account-pill-dot" aria-hidden="true">
        {pill.differsCount > 0 ? <span className="account-pill-mark" /> : null}
      </span>
      <span className="account-pill-name">{pill.accountName}</span>
      <span className={`account-pill-connection${pill.hasConnection ? '' : ' absent'}`}>{pill.connectionWord}</span>
      <span className="account-pill-state">{pill.label}</span>
      {pill.runLabel ? <span className="account-pill-run">{pill.runLabel}</span> : null}
      {pill.differsWords ? <span className="sr-only">{pill.differsWords}</span> : null}
    </>
  );
  return (
    <li className={classes} data-account={pill.accountName} data-state={pill.state}>
      {typeof onToggle === 'function' ? (
        <button
          type="button"
          className="account-pill-button"
          aria-expanded={expanded}
          aria-controls={expanded && controls ? controls : undefined}
          title={pill.title}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <div className="account-pill-button" title={pill.title}>{body}</div>
      )}
    </li>
  );
}
