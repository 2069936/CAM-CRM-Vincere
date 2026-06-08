import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { buildDailyReportSummary, formatCurrency } from '../domain/report';

function Metric({ label, value, tone }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone || ''}>{value}</strong>
    </div>
  );
}

function AccountTable({ title, rows }) {
  if (!rows.length) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        <span className="count">{rows.length}</span>
      </div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>Strategies</th>
              <th>Daily PnL</th>
              <th>Weekly PnL</th>
              <th>Drawdown</th>
              <th>Aggregate balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.accountName}>
                <td>
                  <strong>{row.meta.alias || row.accountName}</strong>
                  <small>{row.meta.connection || row.connection || 'No connection'}</small>
                </td>
                <td>{row.meta.status || 'Active'}</td>
                <td>
                  {row.strategies?.length ? row.strategies.map((strategy) => (
                    <span className={strategy.enabled ? 'strategy enabled' : 'strategy'} key={`${row.accountName}-${strategy.strategyName}`}>
                      {strategy.strategyFamily || strategy.strategyName}
                    </span>
                  )) : <span className="muted">None</span>}
                </td>
                <td className={row.grossRealizedPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.grossRealizedPnl)}</td>
                <td className={row.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.weeklyPnl)}</td>
                <td>{formatCurrency(row.trailingMaxDrawdown)}</td>
                <td>{formatCurrency(row.accountBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Dashboard({ client, dailyImport, onBuildReport }) {
  if (!dailyImport) {
    return (
      <div className="empty-state">
        <FileText size={24} />
        <h3>No daily close for this date</h3>
        <p>Upload the four NinjaTrader files to create the client snapshot.</p>
      </div>
    );
  }

  const report = buildDailyReportSummary(client, dailyImport);
  const criticalFlags = report.flags.filter((flag) => flag.severity === 'Critical');

  return (
    <div className="dashboard-stack">
      <div className="metric-grid">
        <Metric label="Accounts" value={report.counts.accounts} />
        <Metric label="Daily/Gross PnL" value={formatCurrency(report.totals.grossRealizedPnl)} tone={report.totals.grossRealizedPnl >= 0 ? 'positive' : 'negative'} />
        <Metric label="Weekly PnL" value={formatCurrency(report.totals.weeklyPnl)} tone={report.totals.weeklyPnl >= 0 ? 'positive' : 'negative'} />
        <Metric label="Aggregate balance" value={formatCurrency(report.totals.aggregateBalance)} />
      </div>

      <section className={criticalFlags.length ? 'panel danger-panel' : 'panel'}>
        <div className="panel-heading">
          <h3>Action required</h3>
          <button className="secondary-button" onClick={onBuildReport}>
            <FileText size={16} /> Build Daily Report
          </button>
        </div>
        {report.flags.length ? (
          <div className="flag-list">
            {report.flags.map((flag) => (
              <div className={`flag ${flag.severity.toLowerCase()}`} key={flag.id}>
                {flag.severity === 'Critical' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                <div>
                  <strong>{flag.type}</strong>
                  <span>{flag.message}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="notice success"><CheckCircle2 size={16} /> No open flags for this close.</div>
        )}
      </section>

      <AccountTable title="Evaluations" rows={report.grouped.evaluations} />
      <AccountTable title="Funded" rows={report.grouped.funded} />
      <AccountTable title="Cash Accounts" rows={report.grouped.cash} />
    </div>
  );
}
