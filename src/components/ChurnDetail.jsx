import { useState } from 'react';
import { buildChurnDetail } from '../domain/clientLifecycle';

/**
 * The clients behind the churn number.
 *
 * The desk manager's complaint about the retention panel was that it "shows
 * counts and tells him almost nothing", and that clicking a churn figure should
 * land on the clients it is made of. This is where it lands: one row per client
 * who was marked Inactive, with whose book it was, when they left, and why.
 *
 * THIS PANEL OWNS ITS FILTERS, and that sentence is the whole reason they live
 * in useState here rather than being passed in. The drill-down deleted from the
 * Operations screen one round ago read the PAGE's as-of date — the same state
 * the header picker writes — so choosing a date "inside the panel" silently
 * re-pinned every KPI, roster and money figure above it, and the panel looked
 * inert because it was already full. A filter that belongs to a panel is state
 * that belongs to the panel. Nothing here reaches the page.
 *
 * The CAM column and the CAM filter appear only when the rows carry attribution
 * — buildChurnRetention fills camName only when it was given a map. Same rule as
 * DeviationAlertList: a CAM reading his own book already knows whose client it
 * is, a manager reading eight books does not, and an unattributed client prints
 * nothing rather than "Unassigned".
 */
export default function ChurnDetail({ churnedClients = [], onSelectClient = null }) {
  const [cam, setCam] = useState('');
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const detail = buildChurnDetail(churnedClients, { cam, reason, from, to });
  const showCam = detail.cams.length > 0;
  const filtered = Boolean(cam || reason || from || to);

  if (!detail.total) {
    return (
      <p className="muted churn-empty">
        No client here has been marked Inactive. Churn is recorded by hand — the
        Client stage selector on a client&apos;s Credentials &amp; Notes tab is the
        only thing that sets it — so an empty list means nobody has been
        classified, not that nobody left.
      </p>
    );
  }

  return (
    <div className="churn-detail">
      <div className="churn-filter-row">
        {showCam ? (
          <select value={cam} onChange={(e) => setCam(e.target.value)} aria-label="Filter by CAM">
            <option value="">All CAMs</option>
            {detail.cams.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : null}
        <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Filter by reason">
          <option value="">All reasons</option>
          {detail.reasons.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label} ({entry.count})
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Churned on or after"
          title="Churned on or after"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Churned on or before"
          title="Churned on or before"
        />
        {filtered ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => { setCam(''); setReason(''); setFrom(''); setTo(''); }}
          >
            Clear
          </button>
        ) : null}
        <span className="muted churn-count">
          {detail.rows.length} of {detail.total} churned
        </span>
      </div>

      {/*
        A date range cannot be satisfied by a client whose departure was never
        dated, so they drop out of a filtered view. Said out loud rather than
        left to be noticed: these are the clients marked Inactive before the
        reason and the date were captured at all, and silently shrinking the
        list around them is how a manager concludes the panel is broken.
      */}
      {detail.undatedHidden ? (
        <p className="muted churn-note-line">
          {detail.undatedHidden === 1
            ? '1 churned client carries no churn date and cannot match a date range.'
            : `${detail.undatedHidden} churned clients carry no churn date and cannot match a date range.`}
          {' '}Clear the dates to see {detail.undatedHidden === 1 ? 'it' : 'them'}.
        </p>
      ) : null}

      {detail.rows.length ? (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Client</th>
                {showCam ? <th>CAM</th> : null}
                <th>Churned</th>
                <th>Reason</th>
                <th>Note</th>
                <th>Client since</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => (
                <tr key={row.clientId}>
                  <td>
                    {onSelectClient ? (
                      <button
                        type="button"
                        className="ghost-button"
                        data-action="open-client"
                        data-client-id={row.clientId}
                        onClick={() => onSelectClient(row.clientId)}
                      >
                        {row.clientName}
                      </button>
                    ) : (
                      row.clientName
                    )}
                  </td>
                  {showCam ? <td>{row.camName || <span className="muted">—</span>}</td> : null}
                  <td>{row.churnedAt || <span className="muted">—</span>}</td>
                  <td className={row.recorded ? '' : 'muted'}>{row.reasonLabel}</td>
                  <td>{row.reasonNote || <span className="muted">—</span>}</td>
                  <td>{row.startedAt || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted churn-empty">No churned client matches these filters.</p>
      )}
    </div>
  );
}
