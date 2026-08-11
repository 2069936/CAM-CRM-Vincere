import { CheckCircle2, Clock3 } from 'lucide-react';
import {
  buildCamFlagQueue,
  flagActivityEntry,
  flagGroupActivityEntry,
  flagResolutionPlan,
} from '../domain/camFlagQueue';

/**
 * The CAM's own flag queue: every open flag they hold, closable from here.
 *
 * Until now a CAM could see flags and not close them. CamOverview counts them
 * in a tile and prints the top one on each briefing card, and clicking the card
 * navigates away; the only Resolve buttons in the app are the manager's table
 * and the client Dashboard, and the Dashboard's handler reads the client and
 * the import from `selectedClient`/`dailyImport`, so it only ever closes flags
 * on the day the date picker happens to be showing. With the real book (last
 * close 2026-07-30, "today" 2026-08-11) that picker opens on a day with no
 * import at all, so the handler returns on its first line and the button does
 * nothing until the CAM finds the flag's own date by hand.
 *
 * Every button here sends (clientId, importId, flagId) taken from the row, so
 * what gets closed is the flag that was clicked and not whatever is on screen.
 *
 * No component state on purpose. Grouping uses <details>, so the whole
 * component is a pure function of its props and a test can call it, find a
 * button and fire its onClick without a DOM — which is how the ids a click
 * actually sends are asserted rather than assumed.
 */
export default function CamFlagQueue({
  clients = [],
  today = null,
  queue = null,
  onResolveFlag,
  onLogClientActivity = null,
  onSelectClient = null,
  defaultOpenGroups = 3,
}) {
  // A date is always available, so age is always measurable: the fallback is
  // the real clock, never a silent 0.
  const asOfDate = today || new Date().toISOString().slice(0, 10);
  const model = queue || buildCamFlagQueue(clients, { today: asOfDate });
  const { totals, groups, buckets } = model;

  /**
   * Fire an activity write without letting it become an unhandled rejection.
   *
   * App.jsx wires `onLogClientActivity` to `persistActivity`, whose catch block
   * alerts AND rethrows. Every existing caller ignores the returned promise, so
   * a failed Supabase insert already surfaces twice — once as the alert and once
   * as an unhandled rejection. One click here can fire a whole group's worth, so
   * the promise is swallowed at this boundary; the alert is still the user's
   * signal and the flag write itself has its own error path.
   */
  function logActivity(clientId, entry) {
    if (!onLogClientActivity || !entry) return;
    try {
      const result = onLogClientActivity(clientId, entry);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Already reported by the handler itself.
    }
  }

  function applyRow(row, status) {
    if (!onResolveFlag) return;
    // One call per open occurrence. A problem still open on eleven closes has
    // eleven rows in operational_flags with eleven different uuids, and
    // updateSupabaseOperationalFlag patches one uuid per call. Closing only the
    // newest is what leaves 597 historical copies Open in Postgres and keeps
    // the all-history counter reading 1,952 for a book with 253 live problems.
    for (const call of flagResolutionPlan(row, status)) {
      onResolveFlag(call.clientId, call.importId, call.flagId, call.status);
    }
    logActivity(row.clientId, flagActivityEntry(row, status));
  }

  function applyGroup(group, status) {
    if (!onResolveFlag) return;
    for (const row of group.rows) {
      for (const call of flagResolutionPlan(row, status)) {
        onResolveFlag(call.clientId, call.importId, call.flagId, call.status);
      }
    }
    // One summary line per group, the same shape handleBulkResolveFlags writes
    // for a whole import. Nineteen separate "flag resolved" entries for one
    // click would bury the client's log under the tool that made them.
    logActivity(group.clientId, flagGroupActivityEntry(group, status));
  }

  if (!totals.rows) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h3>Open flags · my clients</h3>
          <span className="badge success">0 open</span>
        </div>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          Nothing open across {clients.length} client{clients.length === 1 ? '' : 's'}
          {model.latestClose ? ` up to ${model.latestClose}` : ''}.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" data-testid="cam-flag-queue">
      <div className="panel-heading">
        <h3>Open flags · my clients</h3>
        <span className={`badge ${totals.critical ? 'danger' : 'warning'}`}>
          {totals.rows} open{totals.critical ? ` · ${totals.critical} critical` : ''}
        </span>
      </div>

      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
        {totals.rows} problem{totals.rows === 1 ? '' : 's'} across {totals.clients} client
        {totals.clients === 1 ? '' : 's'}, held in {totals.occurrences} flag record
        {totals.occurrences === 1 ? '' : 's'} — the same problem is written again into every
        close it survives, so the record count is always the larger number.
        {' '}
        {totals.behindLatestClose > 0 ? (
          <strong>
            {totals.behindLatestClose} of them are no longer on their client&apos;s latest close,
            so nothing else in the app can reach them.
          </strong>
        ) : null}
      </p>

      <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
        <Clock3 size={12} /> Age counted to {model.asOf || 'today'}
        {model.latestClose ? `, latest close in the book ${model.latestClose}` : ''} ·{' '}
        {buckets.map((bucket) => `${bucket.label} ${bucket.rows}`).join(' · ')}
        {totals.oldestDays === null ? ' · oldest not measured' : ` · oldest ${totals.oldestDays}d`}
      </p>

      {groups.map((group, index) => (
        <details
          key={group.key}
          className="flag-queue-group"
          open={index < defaultOpenGroups}
          style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}
        >
          <summary style={{ cursor: 'pointer' }}>
            <strong>{group.type}</strong>{' '}
            {onSelectClient ? (
              <button
                type="button"
                className="link-button"
                data-action="open-client"
                data-client-id={group.clientId}
                onClick={(event) => {
                  event.preventDefault();
                  onSelectClient(group.clientId);
                }}
              >
                {group.clientName}
              </button>
            ) : (
              <span>{group.clientName}</span>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              {' '}· {group.total} flag{group.total === 1 ? '' : 's'}
              {group.critical ? ` · ${group.critical} critical` : ''}
              {' '}· oldest {group.oldestDays === null ? 'not measured' : `${group.oldestDays}d`}
              {' '}· raised {group.firstSeen}
              {group.lastSeen !== group.firstSeen ? ` → ${group.lastSeen}` : ''}
              {group.behindLatestClose
                ? ` · ${group.behindLatestClose} behind the ${group.clientLatestClose} close`
                : ''}
            </span>
          </summary>

          {/* The button says how many rows AND how many records, because they
              differ by a factor of seven at the top of this book: Oakley Larch's
              "Missing account" group is 14 problems held in 98 flag rows, so one
              click fires 98 patches. A button labelled "Resolve all 14" that
              writes 98 times is understating what it does by 84 writes. */}
          <div style={{ display: 'flex', gap: 8, margin: '6px 0', alignItems: 'center' }}>
            <button
              type="button"
              className="resolve-button"
              data-action="resolve-group"
              data-group-key={group.key}
              data-write-calls={group.occurrences}
              style={{ fontSize: 11, whiteSpace: 'nowrap' }}
              onClick={() => applyGroup(group, 'Resolved')}
            >
              <CheckCircle2 size={13} /> Resolve all {group.total}
            </button>
            <button
              type="button"
              className="resolve-button"
              data-action="acknowledge-group"
              data-group-key={group.key}
              data-write-calls={group.occurrences}
              style={{ fontSize: 11, whiteSpace: 'nowrap' }}
              onClick={() => applyGroup(group, 'Acknowledged')}
            >
              Acknowledge all {group.total}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              {group.occurrences === group.total
                ? `${group.occurrences} flag record${group.occurrences === 1 ? '' : 's'}`
                : `writes ${group.occurrences} flag records — these ${group.total} problems are held on ${group.occurrences} rows across the closes they survived`}
            </span>
          </div>

          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Account</th>
                  <th>Flag</th>
                  <th>Age</th>
                  <th>From</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr
                    key={row.key}
                    data-row-key={row.key}
                    style={
                      row.severity === 'Critical'
                        ? { background: 'var(--red-dim, rgba(239,68,68,.06))' }
                        : undefined
                    }
                  >
                    <td>
                      <span className={`badge ${row.severity === 'Critical' ? 'danger' : 'warning'}`}>
                        {row.severity}
                      </span>
                    </td>
                    <td className="muted">{row.accountName || '—'}</td>
                    <td>{row.message || row.type}</td>
                    <td className="muted">
                      {/* null is "could not be dated", not "raised today". */}
                      {row.ageDays === null ? 'not measured' : `${row.ageDays}d`}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {row.clientName} · {row.firstSeen}
                      {row.lastSeen !== row.firstSeen ? ` → ${row.lastSeen}` : ''}
                      {row.occurrences.length > 1 ? ` · ${row.occurrences.length} records` : ''}
                      {row.onLatestClose ? '' : ` · behind ${row.clientLatestClose}`}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="resolve-button"
                        data-action="resolve-row"
                        data-row-key={row.key}
                        data-client-id={row.clientId}
                        style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                        onClick={() => applyRow(row, 'Resolved')}
                      >
                        <CheckCircle2 size={13} /> Resolve
                      </button>{' '}
                      <button
                        type="button"
                        className="resolve-button"
                        data-action="acknowledge-row"
                        data-row-key={row.key}
                        data-client-id={row.clientId}
                        style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                        onClick={() => applyRow(row, 'Acknowledged')}
                      >
                        Acknowledge
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}

      {/*
        The closing receipt, with the window it was measured over printed beside
        the count.

        It used to read "0 flags were closed in the last 7 days", which on this
        book is a true zero for a window that does not touch the data: "today" is
        2026-08-11, the last close is 2026-07-30, and 2,970 flags were closed in
        the seven days up to that close. A bare 0 there reads as "nobody works
        this queue" — the same "0 fields compared" mistake as a measurement that
        never ran. The window and the book's own last resolution are both named
        so the two readings cannot be confused.
      */}
      <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        Nothing here is deleted. Resolving writes status and resolved_at onto the flag and an
        entry into the client&apos;s activity log, so a closed flag can still be read back —{' '}
        {totals.recentlyClosed} flag{totals.recentlyClosed === 1 ? '' : 's'} closed
        {model.closedWindow?.from
          ? ` between ${model.closedWindow.from} and ${model.closedWindow.to}`
          : ' on this book'}
        .{' '}
        {!totals.recentlyClosed && model.lastClosedOn ? (
          <>
            That window is empty, but the queue is not untouched: {model.closedTotal} flag
            {model.closedTotal === 1 ? ' is' : 's are'} already closed on this book and the most
            recent one is dated {model.lastClosedOn}, {' '}
            {model.latestClose === model.lastClosedOn
              ? 'the last close on file'
              : `against a last close of ${model.latestClose}`}. The window is measured from
            today; the data stops earlier.
          </>
        ) : null}
        {!totals.recentlyClosed && !model.lastClosedOn && model.closedTotal ? (
          <>
            {model.closedTotal} flag{model.closedTotal === 1 ? ' is' : 's are'} closed on this book
            but none carries a resolved_at date, so when they were closed is not measured — it is
            not that nothing was closed.
          </>
        ) : null}
      </p>
    </section>
  );
}
