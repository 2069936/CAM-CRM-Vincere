import { useState } from 'react';
import { CalendarDays, Check, Users, X } from 'lucide-react';
import {
  TIME_OFF_STATUSES,
  buildCamWorkload,
  conflictingTimeOff,
  distributeClientsEvenly,
} from '../domain/camCoverage';

function fmtRange(request) {
  if (!request?.startDate) return '—';
  return request.endDate && request.endDate !== request.startDate
    ? `${request.startDate} → ${request.endDate}`
    : request.startDate;
}

/**
 * Approving time off and arranging cover are one action, so a request is never
 * approved leaving clients unwatched. The manager sees who else is already off
 * those days and how loaded everyone is before choosing.
 */
function ApprovalRow({ request, camProfiles, clients, coverage, timeOff, today, onApprove, onDeny }) {
  const cam = camProfiles.find((profile) => profile.id === request.camProfileId);
  const camClients = (cam?.clientIds || [])
    .map((id) => clients.find((client) => client.id === id))
    .filter(Boolean);
  const conflicts = conflictingTimeOff(timeOff, request);
  const workload = buildCamWorkload(
    camProfiles.filter((profile) => profile.id !== request.camProfileId),
    clients,
    { coverage, timeOff, date: request.startDate || today },
  );

  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState({});

  function proposeEven() {
    const proposal = distributeClientsEvenly(camClients.map((client) => client.id), workload);
    setPlan(Object.fromEntries(proposal.map((row) => [row.clientId, row.coveringCamId])));
  }

  const assignments = Object.entries(plan)
    .filter(([, coveringCamId]) => coveringCamId)
    .map(([clientId, coveringCamId]) => ({ clientId, coveringCamId }));
  const uncovered = camClients.length - assignments.length;

  return (
    <div className="timeoff-request">
      <div className="timeoff-request-head">
        <div>
          <strong>{cam?.name || 'Unknown CAM'}</strong>
          <span className="muted"> · {request.kind} · {fmtRange(request)}</span>
          {request.note ? <p className="muted timeoff-note">{request.note}</p> : null}
        </div>
        <div className="timeoff-request-actions">
          <button className="secondary-button" onClick={() => { setOpen((v) => !v); if (!open) proposeEven(); }}>
            <Users size={14} /> {open ? 'Hide cover' : 'Approve & cover'}
          </button>
          <button className="ghost-button" onClick={() => onDeny(request)}>
            <X size={14} /> Deny
          </button>
        </div>
      </div>

      {conflicts.length ? (
        <div className="notice warning timeoff-conflict">
          Also off then: {conflicts.map((c) => camProfiles.find((p) => p.id === c.camProfileId)?.name || '?').join(', ')}
        </div>
      ) : null}

      {open ? (
        <div className="timeoff-cover">
          <div className="timeoff-cover-head">
            <span className="muted">
              {camClients.length} client{camClients.length === 1 ? '' : 's'} to cover
              {uncovered > 0 ? ` · ${uncovered} still unassigned` : ''}
            </span>
            <button className="ghost-button" onClick={proposeEven}>Split evenly</button>
          </div>

          <div className="table-wrap">
            <table className="ops-table compact-table">
              <thead>
                <tr><th>Client</th><th>Covered by</th></tr>
              </thead>
              <tbody>
                {camClients.map((client) => (
                  <tr key={client.id}>
                    <td>{client.name}</td>
                    <td>
                      <select
                        value={plan[client.id] || ''}
                        onChange={(event) => setPlan((prev) => ({ ...prev, [client.id]: event.target.value }))}
                      >
                        <option value="">— nobody —</option>
                        {workload.map((row) => (
                          <option key={row.camProfileId} value={row.camProfileId} disabled={row.away}>
                            {row.name} ({row.totalClients} clients{row.away ? ' · away' : ''})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="timeoff-cover-actions">
            <button
              className="primary-button"
              onClick={() => onApprove(request, assignments)}
            >
              <Check size={14} /> Approve
              {assignments.length ? ` & assign ${assignments.length}` : ' with no cover'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function TimeOffPanel({
  camProfiles = [],
  clients = [],
  timeOff = [],
  coverage = [],
  today,
  onApprove,
  onDeny,
  onEndCoverage,
}) {
  const pending = timeOff.filter((request) => request.status === TIME_OFF_STATUSES.PENDING);
  const activeCoverage = coverage.filter((entry) => (
    entry.startDate <= today && (entry.endDate || entry.startDate) >= today
  ));
  const camName = (id) => camProfiles.find((profile) => profile.id === id)?.name || '—';

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Time off &amp; coverage</h3>
        <span className="muted">
          {pending.length} pending · {activeCoverage.length} covered today
        </span>
      </div>

      {pending.length ? (
        <div className="timeoff-list">
          {pending.map((request) => (
            <ApprovalRow
              key={request.id}
              request={request}
              camProfiles={camProfiles}
              clients={clients}
              coverage={coverage}
              timeOff={timeOff}
              today={today}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          ))}
        </div>
      ) : (
        <p className="muted">No time off waiting on a decision.</p>
      )}

      {activeCoverage.length ? (
        <>
          <h4 className="timeoff-subhead">Covered right now</h4>
          <div className="table-wrap">
            <table className="ops-table compact-table">
              <thead>
                <tr><th>Client</th><th>Covered by</th><th>Instead of</th><th>Until</th><th /></tr>
              </thead>
              <tbody>
                {activeCoverage.map((entry) => (
                  <tr key={entry.id}>
                    <td>{clients.find((client) => client.id === entry.clientId)?.name || entry.clientId}</td>
                    <td><span className="badge success">{camName(entry.coveringCamId)}</span></td>
                    <td className="muted">{camName(entry.absentCamId)}</td>
                    <td>{entry.endDate || entry.startDate}</td>
                    <td>
                      {onEndCoverage ? (
                        <button
                          className="ghost-button icon-only"
                          title="End this cover now"
                          onClick={() => onEndCoverage(entry)}
                        >
                          <X size={13} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The request form a CAM uses to ask for time off. */
export function TimeOffRequestForm({ onSubmit, kinds = [] }) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [kind, setKind] = useState(kinds[0] || 'Vacation');
  const [note, setNote] = useState('');

  return (
    <form
      className="timeoff-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!startDate) return;
        onSubmit({ startDate, endDate: endDate || startDate, kind, note });
        setStartDate('');
        setEndDate('');
        setNote('');
      }}
    >
      <label>
        <span>From</span>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
      </label>
      <label>
        <span>To</span>
        <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>
      <label>
        <span>Reason</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
      <label className="timeoff-form-note">
        <span>Note (optional)</span>
        <input value={note} placeholder="Anything the manager should know" onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="primary-button" type="submit" disabled={!startDate}>
        <CalendarDays size={14} /> Request time off
      </button>
    </form>
  );
}
