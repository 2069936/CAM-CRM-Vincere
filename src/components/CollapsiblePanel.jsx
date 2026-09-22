import { useEffect, useRef, useState } from 'react';
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
 * Called once, on the first expansion, and not again when the panel is
 * collapsed and re-opened: the second expansion has the data already, and
 * re-firing would be two fetches for one click on a slow instance. The caller
 * still decides whether a fetch is needed at all — every one of them is cached
 * by id in App.jsx — so `onOpen` is a nudge, never a command. A panel opened by
 * `defaultOpen` fires it on mount, because it is open and its data is wanted.
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
  const opened = useRef(false);
  // In an effect, not in the render body: `onOpen` sets state in App.jsx, and
  // setting another component's state while this one renders is the warning
  // React prints and the double fetch it hides.
  useEffect(() => {
    if (!open || opened.current) return;
    opened.current = true;
    if (onOpen) onOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
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
