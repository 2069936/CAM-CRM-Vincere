import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A panel that stays collapsed until asked for.
 *
 * The Operations Command Center renders several full rosters on one page — open
 * flags, every funded account, every evaluation account, the client roster —
 * which together ran to well over a thousand rows. Anything that can grow with
 * the size of the book gets wrapped in this so the page opens as a short list of
 * headings with counts, and the manager expands only what they came for.
 *
 * `onOpen` is how a panel asks for its own data.
 *
 * Collapsing a panel used to save rendering and nothing else: the rows it did
 * not show had already been downloaded, so ConfigDriftPanel's 30.9 MB of
 * strategy parameters were on every login whether or not anybody expanded it.
 * A panel that fetches when it is expanded needs one signal, and this is it.
 *
 * FIRED WHENEVER IT CHANGES WHILE THE PANEL IS OPEN, NOT ONCE PER MOUNT.
 *
 * It used to be guarded by a ref that was never reset, so it fired on the first
 * expansion and never again. The ids these panels need are date-dependent: move
 * the as-of picker with a configuration panel open and the panel needs a
 * different day's closes, but nothing re-asked and the panel's load state still
 * said "loaded". It then compared over rows that were never fetched and printed
 * its finding — "Every algorithm cohort with a clear majority is running one
 * configuration", "Nothing on <date> sits off the desk" — which is the one
 * outcome PanelLoadState and panelLoad.js exist to prevent.
 *
 * So the effect depends on `onOpen`'s identity, and its callers are useCallbacks
 * keyed on the id set they would ask for. A caller whose identity changes every
 * render would be a fetch every render; a caller keyed on its ids fires when,
 * and only when, the panel needs different closes. The caller still decides
 * whether a fetch is needed at all — every one of them is cached by id in
 * App.jsx and a second call for ids already in hand is free — so `onOpen` is a
 * nudge, never a command. A panel opened by `defaultOpen` fires it on mount,
 * because it is open and its data is wanted.
 */
export default function CollapsiblePanel({
  title,
  count = null,
  badges = null,
  defaultOpen = false,
  tone = '',
  onOpen = null,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  // In an effect, not in the render body: `onOpen` sets state in App.jsx, and
  // setting another component's state while this one renders is the warning
  // React prints and the double fetch it hides.
  useEffect(() => {
    if (!open || !onOpen) return;
    onOpen();
  }, [open, onOpen]);
  return (
    <section className={tone ? `panel ${tone}` : 'panel'}>
      <div className="panel-heading">
        <button
          className="collapse-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <ChevronDown className={open ? 'chevron open' : 'chevron'} size={16} />
          <h3>{title}</h3>
          {count !== null ? (
            <span className="collapse-count">{count}</span>
          ) : null}
        </button>
        {badges}
      </div>
      {open ? children : null}
    </section>
  );
}
