import { useId, useState } from 'react';

/**
 * WHY THE REST OF THE REGISTRY HAS NO LIGHT.
 *
 * Pedro's words: show only the accounts expected to trade, and say in one
 * collapsed line why the others are not shown, so a CAM can tell a dead
 * account from a new one from a missing one. The same line under an overview
 * tile, under the client page strip and at the bottom of the desk drawer,
 * built from the bucket sentences (src/domain/accountBuckets.js, registryLights):
 *
 *   Show  Not shown: 3 look failed, breached on the close. 2 gone from the
 *         close for 6 closes. 1 retired: 1 Failed.
 *
 * Muted, folded: the names are behind the Show toggle (a button with
 * aria-expanded, never a button inside a button), each beside its reason word
 * and with what the close saw of it one hover away. Nothing at all when every
 * account is expected: a new account is expected and lit, so it is never here.
 */
export default function NotShownLine({ notShown = null, label = 'accounts not shown' }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!notShown || !notShown.count) return null;
  return (
    <div className="not-shown">
      <button
        type="button"
        className="not-shown-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${open ? 'Hide' : 'Show'} ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide' : 'Show'}
      </button>
      <span className="not-shown-words muted">{notShown.sentence}</span>
      {open ? (
        <ul id={listId} className="not-shown-list muted">
          {notShown.accounts.map((row) => (
            <li key={row.accountName} title={row.detail} data-reason={row.reason}>
              <span className="not-shown-name">{row.accountName}</span>
              {' '}
              <span className="not-shown-reason">{row.word}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
