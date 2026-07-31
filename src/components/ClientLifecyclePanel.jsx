import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

function pct(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}
function days(value) {
  return value === null || value === undefined ? '—' : `${value}d`;
}
function money(value) {
  return `$${Math.round(Number(value || 0)).toLocaleString()}`;
}

function Stat({ label, value, tone }) {
  return (
    <div className="lifecycle-stat">
      <span className="lifecycle-stat-label">{label}</span>
      <strong className={tone ? `lifecycle-stat-value ${tone}` : 'lifecycle-stat-value'}>
        {value}
      </strong>
    </div>
  );
}

const EVENT_TONE = {
  start: 'var(--accent)',
  'account-added': 'var(--text-muted)',
  funded: 'var(--success)',
  failed: 'var(--error)',
  payout: 'var(--success)',
};

/** One client's full story: stats, prop firms, algos, and a dated timeline. */
export function ClientLifecyclePanel({ lifecycle, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!lifecycle) return null;
  const events = open ? lifecycle.events : lifecycle.events.slice(-6);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Client lifecycle</h3>
        <span className="muted">
          {lifecycle.startedAt ? `Since ${lifecycle.startedAt}` : 'No start date'}
          {lifecycle.daysWithUs !== null ? ` · ${lifecycle.daysWithUs}d` : ''}
          {lifecycle.camName ? ` · CAM ${lifecycle.camName}` : ''}
          {lifecycle.churned ? ' · Churned' : ''}
        </span>
      </div>

      <div className="lifecycle-stats">
        <Stat label="Accounts (all time)" value={lifecycle.totalAccounts} />
        <Stat label="Evaluations" value={lifecycle.evaluationCount} />
        <Stat
          label="Passed"
          value={`${lifecycle.passedCount} (${pct(lifecycle.passRate)})`}
          tone={lifecycle.passedCount ? 'positive' : ''}
        />
        <Stat label="Avg days to pass" value={days(lifecycle.avgDaysToPass)} />
        <Stat label="Funded now" value={lifecycle.fundedCount} />
        <Stat label="Payouts" value={`${lifecycle.payoutCount} · ${money(lifecycle.payoutTotal)}`} />
        <Stat label="Avg days to payout" value={days(lifecycle.avgDaysToFirstPayout)} />
        {lifecycle.cashAccounts ? (
          <Stat label="Cash balance" value={money(lifecycle.cashBalance)} />
        ) : null}
      </div>

      {lifecycle.propFirms.length ? (
        <p className="muted lifecycle-line">
          <strong>Prop firms:</strong>{' '}
          {lifecycle.propFirms
            .map((f) => `${f.firm} (${f.accounts})`)
            .join(' · ')}
        </p>
      ) : null}

      {lifecycle.algos.length ? (
        <p className="muted lifecycle-line">
          <strong>Algos used most:</strong>{' '}
          {lifecycle.algos.slice(0, 5).map((a) => `${a.family} (${a.days})`).join(' · ')}
        </p>
      ) : null}

      {lifecycle.events.length ? (
        <>
          <ol className="lifecycle-timeline">
            {events.map((event, i) => (
              <li key={`${event.date}-${i}`} className="lifecycle-event">
                <span
                  className="lifecycle-event-dot"
                  style={{ background: EVENT_TONE[event.kind] || 'var(--text-muted)' }}
                />
                <span className="lifecycle-event-date">{event.date}</span>
                <span className="lifecycle-event-label">{event.label}</span>
              </li>
            ))}
          </ol>
          {lifecycle.events.length > 6 ? (
            <button className="ghost-button" onClick={() => setOpen((v) => !v)}>
              <ChevronDown className={open ? 'chevron open' : 'chevron'} size={14} />
              {open ? 'Show recent only' : `Show all ${lifecycle.events.length} events`}
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">
          No dated history yet. Fill in Date Added / Date Funded on the accounts to build the timeline.
        </p>
      )}
    </section>
  );
}

/** Many clients rolled up: CAM book or whole team. */
export function LifecycleRollupPanel({ rollup, title = 'Lifecycle & retention' }) {
  if (!rollup) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        <span className="muted">{rollup.clients} clients</span>
      </div>
      <div className="lifecycle-stats">
        <Stat label="Retention" value={pct(rollup.retentionRate)} tone={rollup.retentionRate >= 0.9 ? 'positive' : 'negative'} />
        <Stat label="Churned" value={rollup.churned} tone={rollup.churned ? 'negative' : ''} />
        <Stat label="Accounts (all time)" value={rollup.totalAccounts} />
        <Stat label="Evaluations" value={rollup.evaluationCount} />
        <Stat label="Pass rate" value={pct(rollup.passRate)} />
        <Stat label="Avg days to pass" value={days(rollup.avgDaysToPass)} />
        <Stat label="Funded now" value={rollup.fundedCount} />
        <Stat label="Payouts" value={`${rollup.payoutCount} · ${money(rollup.payoutTotal)}`} />
        <Stat label="Avg days to payout" value={days(rollup.avgDaysToFirstPayout)} />
        {rollup.cashAccounts ? <Stat label="Cash balance" value={money(rollup.cashBalance)} /> : null}
      </div>
      {rollup.propFirms.length ? (
        <p className="muted lifecycle-line">
          <strong>Prop firms:</strong>{' '}
          {rollup.propFirms.slice(0, 6).map((f) => `${f.firm} (${f.accounts})`).join(' · ')}
        </p>
      ) : null}
      {rollup.algos.length ? (
        <p className="muted lifecycle-line">
          <strong>Algos used most:</strong>{' '}
          {rollup.algos.slice(0, 6).map((a) => `${a.family} (${a.days})`).join(' · ')}
        </p>
      ) : null}
      {rollup.churnedClients.length ? (
        <p className="muted lifecycle-line">
          <strong>Churned:</strong>{' '}
          {rollup.churnedClients.map((c) => c.clientName).join(' · ')}
        </p>
      ) : null}
    </section>
  );
}

export default ClientLifecyclePanel;
