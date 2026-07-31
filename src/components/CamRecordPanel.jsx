import { TIME_OFF_STATUSES } from '../domain/camCoverage';

function Stat({ label, value, tone }) {
  return (
    <div className="lifecycle-stat">
      <span className="lifecycle-stat-label">{label}</span>
      <strong className={tone ? `lifecycle-stat-value ${tone}` : 'lifecycle-stat-value'}>{value}</strong>
    </div>
  );
}

const STATUS_TONE = {
  [TIME_OFF_STATUSES.APPROVED]: 'success',
  [TIME_OFF_STATUSES.PENDING]: 'warning',
  [TIME_OFF_STATUSES.DENIED]: 'muted',
  [TIME_OFF_STATUSES.CANCELLED]: 'muted',
};

function range(entry) {
  if (!entry?.startDate) return '—';
  return entry.endDate && entry.endDate !== entry.startDate
    ? `${entry.startDate} → ${entry.endDate}`
    : entry.startDate;
}

/**
 * A CAM's standing record — what they carry and their time off. The client side
 * has a lifecycle because a client has a story with a beginning and an end; a
 * CAM is better described by what is true of them right now.
 */
export default function CamRecordPanel({ record, title = 'My record' }) {
  if (!record) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        <span className="muted">
          {record.name}
          {record.away ? ' · away today' : ''}
          {record.covering ? ` · covering ${record.covering}` : ''}
        </span>
      </div>

      <div className="lifecycle-stats">
        <Stat label="Clients" value={record.clients} />
        <Stat label="Accounts" value={record.accounts} />
        {record.covering ? <Stat label="Covering" value={record.covering} tone="positive" /> : null}
        <Stat label="Days off taken" value={record.approvedDaysOff} />
        {record.pendingRequests ? (
          <Stat label="Pending requests" value={record.pendingRequests} tone="negative" />
        ) : null}
        <Stat label="Next time off" value={record.nextTimeOff ? range(record.nextTimeOff) : '—'} />
      </div>

      {record.timeOff.length ? (
        <div className="table-wrap">
          <table className="ops-table compact-table">
            <thead>
              <tr><th>Dates</th><th>Reason</th><th>Status</th><th>Note</th></tr>
            </thead>
            <tbody>
              {record.timeOff.map((entry) => (
                <tr key={entry.id}>
                  <td>{range(entry)}</td>
                  <td>{entry.kind}</td>
                  <td>
                    <span className={`badge ${STATUS_TONE[entry.status] || 'muted'}`}>{entry.status}</span>
                  </td>
                  <td className="muted">{entry.decisionNote || entry.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No time off requested yet.</p>
      )}
    </section>
  );
}
