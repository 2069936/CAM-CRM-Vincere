import { useState } from 'react';
import { AlertTriangle, CalendarClock, CalendarDays, Check, RotateCcw, Save, Users, X } from 'lucide-react';
import {
  TIME_OFF_STATUSES,
  buildCoverageDistribution,
  conflictingTimeOff,
  coverageDraftChanges,
  coverageForRequest,
  coversDate,
  isCurrentOrUpcoming,
  distributeClientsEvenly,
} from '../domain/camCoverage';

function fmtRange(request) {
  if (!request?.startDate) return '—';
  return request.endDate && request.endDate !== request.startDate
    ? `${request.startDate} → ${request.endDate}`
    : request.startDate;
}

/**
 * Per-CAM load for a distribution, base → after, in clients AND accounts.
 *
 * Accounts are here because count-fair is not fair. Splitting Reese Glen's 17
 * clients evenly across the real desk lands every CAM on 14 clients, and lands
 * 107 extra accounts on Avery Birch (30 → 137) against 0 on Marlow Cedar
 * (85 → 85). The client column alone says that split is level. It is not.
 *
 * Both figures count the same clients over the same window — the request's whole
 * window, not its first day. Sampling day one printed Ellis Glen as "13 → 14
 * clients" in one block and "14 → 17 clients" in the next, for windows that
 * share three days.
 */
function CoverageLoadStrip({ byCam }) {
  if (!byCam.length) return null;
  return (
    <ul className="coverage-load-strip">
      {byCam.map((row) => {
        const moved = row.totalClients !== row.baseClients;
        return (
          <li
            key={row.camProfileId}
            className={`coverage-load-chip${moved ? ' is-loaded' : ''}${row.blockedReason ? ' is-blocked' : ''}`}
          >
            <strong>{row.name}</strong>
            <span className="coverage-load-figure">
              {moved ? `${row.baseClients} → ${row.totalClients}` : row.totalClients} clients
            </span>
            <span className="coverage-load-figure muted">
              {moved ? `${row.baseAccounts} → ${row.totalAccounts}` : row.totalAccounts} accounts
            </span>
            {/* An account figure that had to skip a client is not the same claim
                as one that counted them all, and the table already says "not
                measured" in that row. Saying it here too stops the chip from
                presenting an understated total as a complete one. */}
            {row.totalUnmeasured > 0 ? (
              <span className="coverage-load-figure muted">
                (+{row.totalUnmeasured} not measured)
              </span>
            ) : null}
            {row.blockedReason ? <span className="badge danger">unavailable</span> : null}
          </li>
        );
      })}
    </ul>
  );
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

  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState({});

  function proposeEven() {
    // Seeded from baseClients, never totalClients: totalClients already carries
    // whatever this plan has assigned, so re-splitting off it would stack the
    // proposal on top of itself and hand everyone a second helping.
    const targets = preview.byCam.map((row) => ({
      camProfileId: row.camProfileId,
      totalClients: row.baseClients,
      away: row.away || Boolean(row.blockedReason),
    }));
    const proposal = distributeClientsEvenly(camClients.map((client) => client.id), targets);
    setPlan(Object.fromEntries(proposal.map((row) => [row.clientId, row.coveringCamId])));
  }

  const assignments = Object.entries(plan)
    .filter(([, coveringCamId]) => coveringCamId)
    .map(([clientId, coveringCamId]) => ({ clientId, coveringCamId }));
  const uncovered = camClients.length - assignments.length;
  // The same function the post-approval view uses, so the load the manager
  // judges before approving is the load they see afterwards.
  const preview = buildCoverageDistribution(request, {
    coverage, camProfiles, clients, timeOff, assignments, date: today,
  });

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

          <CoverageLoadStrip byCam={preview.byCam} />

          <div className="table-wrap">
            <table className="ops-table compact-table">
              <thead>
                <tr><th>Client</th><th>Accounts</th><th>Covered by</th></tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.clientId}>
                    <td>{row.clientName}</td>
                    <td>{row.accounts === null ? <span className="muted">not measured</span> : row.accounts}</td>
                    <td>
                      <select
                        value={plan[row.clientId] || ''}
                        onChange={(event) => setPlan((prev) => ({ ...prev, [row.clientId]: event.target.value }))}
                      >
                        <option value="">— nobody —</option>
                        {preview.byCam.map((cam) => (
                          <option key={cam.camProfileId} value={cam.camProfileId} disabled={Boolean(cam.blockedReason)}>
                            {cam.name} ({cam.totalClients} clients{cam.blockedReason ? ' · unavailable' : ''})
                          </option>
                        ))}
                      </select>
                      {row.blockedReason ? (
                        <span className="coverage-blocked">{row.coveringCamName} {row.blockedReason}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="timeoff-cover-actions">
            <button
              className="primary-button"
              disabled={preview.blocked > 0}
              onClick={() => onApprove(request, assignments)}
            >
              <Check size={14} /> Approve
              {assignments.length ? ` & assign ${assignments.length}` : ' with no cover'}
            </button>
            {preview.blocked > 0 ? (
              <span className="coverage-blocked">
                {preview.blocked} assignment{preview.blocked === 1 ? '' : 's'} go to a CAM who is away — change {preview.blocked === 1 ? 'it' : 'them'} first.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The distribution that was actually committed for an approved request, and the
 * controls to change it.
 *
 * This exists because approving used to be the end of the story: the request
 * dropped out of the pending list and the only coverage table on the page was
 * filtered `startDate <= today`, so cover arranged for a holiday three weeks out
 * rendered nothing at all. The manager got no confirmation, no way to check the
 * split was fair, and no way to move one client without denying and re-approving
 * the whole request.
 *
 * Edits go back through replaceSupabaseCoverage keyed on time_off_id, which
 * deletes this request's rows and re-inserts the new set — the same write the
 * approval makes, so a reassignment can never leave a stale duplicate behind.
 */
function ApprovedCoverageRow({
  request, camProfiles, clients, coverage, timeOff, today, onEditCoverage,
}) {
  const committed = buildCoverageDistribution(request, {
    coverage, camProfiles, clients, timeOff, date: today,
  });
  const [draft, setDraft] = useState(null);
  const [refusal, setRefusal] = useState(null);

  const plan = draft || Object.fromEntries(committed.rows.map((row) => [row.clientId, row.coveringCamId]));
  const assignments = Object.entries(plan)
    .filter(([, coveringCamId]) => coveringCamId)
    .map(([clientId, coveringCamId]) => ({ clientId, coveringCamId }));
  const shown = draft
    ? buildCoverageDistribution(request, { coverage, camProfiles, clients, timeOff, assignments, date: today })
    : committed;

  const changed = draft ? coverageDraftChanges(committed.rows, plan) : [];
  const dirty = changed.length > 0;

  function assign(clientId, coveringCamId) {
    // Refused here as well as disabled in the select: a CAM can be put on leave
    // between the render and the click, and "it silently did nothing" is the
    // worst of the three possible outcomes.
    const reason = coveringCamId
      ? shown.byCam.find((cam) => cam.camProfileId === coveringCamId)?.blockedReason
      : null;
    if (reason) {
      const name = camProfiles.find((cam) => cam.id === coveringCamId)?.name || 'That CAM';
      setRefusal(`${name} cannot cover these dates — ${reason}.`);
      return;
    }
    setRefusal(null);
    setDraft({ ...plan, [clientId]: coveringCamId });
  }

  const covered = shown.covered;
  const total = shown.clientsToCover;

  return (
    <details className="timeoff-approved" open>
      <summary>
        <strong>{committed.absentCamName}</strong>
        <span className="muted"> · {request.kind} · {fmtRange(request)}</span>
        <span className={`badge ${shown.uncovered ? 'warning' : 'success'}`}>
          {covered}/{total} covered
        </span>
        {dirty ? <span className="badge warning">unsaved changes</span> : null}
      </summary>

      {total === 0 ? (
        <p className="muted">
          {committed.absentCamName} has no clients on their book, so there was nothing to hand over.
        </p>
      ) : (
        <>
          <CoverageLoadStrip byCam={shown.byCam} />

          {refusal ? (
            <div className="notice error coverage-refusal">
              <AlertTriangle size={16} />
              <span>{refusal}</span>
            </div>
          ) : null}

          <div className="table-wrap">
            <table className="ops-table compact-table">
              <thead>
                <tr><th>Client</th><th>Accounts</th><th>Covered by</th><th>Dates</th><th /></tr>
              </thead>
              <tbody>
                {shown.rows.map((row) => (
                  <tr key={row.clientId}>
                    <td>{row.clientName}</td>
                    <td>{row.accounts === null ? <span className="muted">not measured</span> : row.accounts}</td>
                    <td>
                      <select
                        value={row.coveringCamId}
                        onChange={(event) => assign(row.clientId, event.target.value)}
                      >
                        <option value="">— nobody —</option>
                        {shown.byCam.map((cam) => (
                          <option
                            key={cam.camProfileId}
                            value={cam.camProfileId}
                            disabled={Boolean(cam.blockedReason)}
                          >
                            {cam.name} ({cam.totalClients} clients{cam.blockedReason ? ' · unavailable' : ''})
                          </option>
                        ))}
                      </select>
                      {row.blockedReason ? (
                        <span className="coverage-blocked">{row.coveringCamName} {row.blockedReason}</span>
                      ) : null}
                    </td>
                    <td className="muted">
                      {row.endDate && row.endDate !== row.startDate
                        ? `${row.startDate} → ${row.endDate}`
                        : row.startDate}
                    </td>
                    <td>
                      {row.coveringCamId ? (
                        <button
                          className="ghost-button icon-only"
                          title={`Remove ${row.coveringCamName} from ${row.clientName}`}
                          onClick={() => assign(row.clientId, '')}
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

          <div className="timeoff-cover-actions">
            <button
              className="primary-button"
              disabled={!dirty || shown.blocked > 0}
              onClick={() => { onEditCoverage?.(request, assignments); setDraft(null); setRefusal(null); }}
            >
              <Save size={14} /> Save cover
              {dirty ? ` (${assignments.length} client${assignments.length === 1 ? '' : 's'})` : ''}
            </button>
            <button
              className="ghost-button"
              disabled={!draft}
              onClick={() => { setDraft(null); setRefusal(null); }}
            >
              <RotateCcw size={14} /> Discard changes
            </button>
            {shown.uncovered > 0 ? (
              <span className="muted">
                {shown.uncovered} client{shown.uncovered === 1 ? '' : 's'} with nobody watching
              </span>
            ) : null}
          </div>
        </>
      )}
    </details>
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
  onEditCoverage,
}) {
  const pending = timeOff.filter((request) => request.status === TIME_OFF_STATUSES.PENDING);
  // coversDate, not a raw string compare: every other consumer of this data goes
  // through it, and it is the one place a malformed date fails closed instead of
  // matching everything. Two implementations of "is this window live" over the
  // same rows is how the two halves of this panel came to disagree.
  const activeCoverage = coverage.filter((entry) => coversDate(entry, today));
  // Approved requests whose window has not finished — the ones a manager can
  // still act on. An approval for dates three weeks out belongs here from the
  // moment it is made, which is exactly what the today-scoped coverage table
  // below cannot show.
  const liveApproved = timeOff
    .filter((request) => (
      request.status === TIME_OFF_STATUSES.APPROVED
      && isCurrentOrUpcoming(request, today)
    ))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const camName = (id) => camProfiles.find((profile) => profile.id === id)?.name || '—';

  return (
    <section className="panel" id="timeoff-coverage">
      <div className="panel-heading">
        <h3>Time off &amp; coverage</h3>
        <span className="muted">
          {pending.length} pending · {liveApproved.length} approved upcoming · {activeCoverage.length} covered today
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

      {liveApproved.length ? (
        <>
          <h4 className="timeoff-subhead">Approved — who is covering what</h4>
          <div className="timeoff-list">
            {liveApproved.map((request) => (
              <ApprovedCoverageRow
                // Remounts when the stored distribution changes, so an in-progress
                // draft is never left sitting on top of rows that have moved under it.
                key={`${request.id}:${coverageForRequest(coverage, request.id).map((e) => `${e.clientId}>${e.coveringCamId}`).sort().join(',')}`}
                request={request}
                camProfiles={camProfiles}
                clients={clients}
                coverage={coverage}
                timeOff={timeOff}
                today={today}
                onEditCoverage={onEditCoverage}
              />
            ))}
          </div>
        </>
      ) : null}

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

/**
 * The alert for time-off requests nobody has decided.
 *
 * There is no notification system in this app to hook into — no bell, no toast
 * queue, no aria-live region; `src/components/ui/alert.jsx` is scaffolding
 * nothing imports. So this is deliberately the smallest thing that works: the
 * same conditionally-rendered `.notice.warning` strip under the Operations
 * toolbar that already announces unassigned clients, plus a `badge warning` in
 * the status row. One request type does not justify a notification framework.
 *
 * Rendered only inside ManagerOverview, which only mounts for a manager
 * session. A CAM told "1 request pending" that only a manager can decide is
 * noise, so the CAM shell never receives this.
 */
export function PendingTimeOffNotice({ alert, camProfiles = [] }) {
  if (!alert?.pending) return null;
  const camName = (id) => camProfiles.find((profile) => profile.id === id)?.name || 'Unknown CAM';
  return (
    <div className="notice warning">
      <CalendarClock size={16} />
      <span>
        <strong>
          {alert.pending} time-off request{alert.pending !== 1 ? 's' : ''} waiting on you
        </strong>
        {' - '}
        {alert.requests.map((request) => {
          const end = request.endDate || request.startDate;
          const window = end && end !== request.startDate
            ? `${request.startDate} → ${end}`
            : request.startDate;
          return `${camName(request.camProfileId)} (${request.kind}, ${window})`;
        }).join(', ')}
        {'. Approve or deny in '}
        <a href="#timeoff-coverage">Time off &amp; coverage</a> below.
        {/* alert.expired is null when the day on screen could not be read. `null
            > 0` is false, so nothing is claimed either way — the count is simply
            left off rather than reported as 0. */}
        {alert.expired > 0 ? (
          <>
            {' '}
            <strong>
              {alert.expired} of them {alert.expired === 1 ? 'is' : 'are'} for dates that have already passed.
            </strong>
          </>
        ) : null}
      </span>
    </div>
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
