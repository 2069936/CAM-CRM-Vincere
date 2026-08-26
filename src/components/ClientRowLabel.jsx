/**
 * The "name plus chips" cluster of a client row in a sidebar.
 *
 * The name and the chips used to share one <span>, and that span carried
 * `overflow: hidden; text-overflow: ellipsis` from `.client-link span`
 * (src/index.css:668). One ellipsing box means one run of text to cut, and the
 * name comes first in it, so the cut landed on the chips instead: a CAM
 * reported a sidebar row reading "Ca..." and another reading only "...".
 * ClientKindBadge's own `white-space: nowrap` (src/index.css:6947) could not
 * help — the chip was never what was being measured.
 *
 * So the name gets its own truncating box and everything handed in as children
 * is `flex: none` (src/index.css, `.client-row-label`). A name cut short is
 * still identifiable from its first characters; "Ca..." names no account mix at
 * all, and "..." names nothing.
 *
 * The measurements this has to survive: at the default 280px sidebar the name
 * column is 201.5px, and a worst-case row is a "Cash + Prop" chip (~72px) plus
 * a "Covering" pill (~62px) plus the last-contact dot (11px) plus an overdue
 * task count (~18px) — 163px of chips, leaving ~38px of name. Narrow, but the
 * chips stay readable, which is the half a CAM cannot reconstruct by hovering.
 *
 * `leading` is for anything that must paint BEFORE the name, and it exists for a
 * layout reason, not a styling one. `.client-link` is a 3-column grid
 * (16px | minmax(0,1fr) | auto) filled by auto-placement, so a row's Nth child
 * decides its column. Put a "NEW" badge in the row itself and it becomes child
 * two, shoving this label into the third — the `auto` track, which the grid
 * algorithm grows to its content before the 1fr track gets anything. Measured on
 * the real book at a 280px sidebar: the columns resolved to `16px 0px 213px`,
 * the 28px NEW badge rendered 10px wide, and the pin star resolved to width 0 —
 * invisible AND unclickable on precisely the rows with fresh data. Keeping the
 * badge inside the label keeps the row at [close dot, label, …] so the label
 * stays in the flexible track: 16px 191px 22px, badge 30px, star 16px.
 */
export default function ClientRowLabel({ name, className = '', leading = null, children = null }) {
  return (
    <span className={className ? `client-row-label ${className}` : 'client-row-label'}>
      {leading}
      <span className="client-row-name">{name}</span>
      {children}
    </span>
  );
}
