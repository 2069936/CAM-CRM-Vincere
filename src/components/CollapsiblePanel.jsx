import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A panel that stays collapsed until asked for.
 *
 * The Operations Command Center renders several full rosters on one page — open
 * flags, every funded account, every evaluation account, the client roster —
 * which together ran to well over a thousand rows. Anything that can grow with
 * the size of the book gets wrapped in this so the page opens as a short list of
 * headings with counts, and the manager expands only what they came for.
 */
export default function CollapsiblePanel({
  title,
  count = null,
  badges = null,
  defaultOpen = false,
  tone = '',
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
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
