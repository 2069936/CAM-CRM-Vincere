import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, RefreshCw } from 'lucide-react';
import { buildDailyReportSummary, formatCurrency } from '../domain/report';

function Metric({ label, value, tone }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone || ''}>{value}</strong>
    </div>
  );
}

function MiniTimeline({ executions }) {
  if (!executions.length) return <div className="sparkline-empty">No executions timeline</div>;
  const values = executions.map((item) => Number(item.price || 0)).filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return <div className="sparkline-empty">No price data</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 220;
    const y = 54 - ((value - min) / spread) * 44;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg className="sparkline" viewBox="0 0 220 64" role="img" aria-label="Execution price timeline">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AccountDetail({ row, executions }) {
  const accountExecutions = executions.filter((execution) => execution.accountName === row.accountName);
  return (
    <tr className="account-detail-row">
      <td colSpan="7">
        <div className="account-detail">
          <div>
            <h4>Strategies</h4>
            {row.strategies?.length ? (
              <div className="strategy-detail-list">
                {row.strategies.map((strategy) => (
                  <div className="strategy-detail" key={`${row.accountName}-${strategy.strategyName}`}>
                    <strong>{strategy.strategyName}</strong>
                    <span>{strategy.instrument} · {strategy.enabled ? 'Enabled' : 'Disabled'}{strategy.direction ? ` · ${strategy.direction}` : ''}</span>
                    <span>Realized {formatCurrency(strategy.realized)} · Unrealized {formatCurrency(strategy.unrealized)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No strategies linked to this account in this close.</p>}
          </div>
          <div>
            <h4>Daily movement</h4>
            <MiniTimeline executions={accountExecutions} />
            <small>{accountExecutions.length} executions</small>
          </div>
        </div>
      </td>
    </tr>
  );
}

function AccountTable({ title, rows, executions }) {
  const [expandedAccount, setExpandedAccount] = useState('');
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
              <Fragment key={row.accountName}>
                <tr
                  className="clickable-row"
                  key={row.accountName}
                  onClick={() => setExpandedAccount((current) => (current === row.accountName ? '' : row.accountName))}
                >
                  <td>
                    <strong><ChevronDown className={expandedAccount === row.accountName ? 'chevron open' : 'chevron'} size={14} /> {row.meta.alias || row.accountName}</strong>
                    <small>{row.meta.connection || row.connection || 'No connection'}</small>
                  </td>
                  <td>{row.meta.status || 'Active'}</td>
                  <td>
                    {row.strategies?.length ? row.strategies.map((strategy) => (
                      <span className={strategy.enabled ? 'strategy enabled' : 'strategy'} key={`${row.accountName}-${strategy.strategyName}`}>
                        {strategy.strategyFamily || strategy.strategyName}{strategy.direction ? ` · ${strategy.direction}` : ''}
                      </span>
                    )) : <span className="muted">None</span>}
                  </td>
                  <td className={row.grossRealizedPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.grossRealizedPnl)}</td>
                  <td className={row.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.weeklyPnl)}</td>
                  <td>{formatCurrency(row.trailingMaxDrawdown)}</td>
                  <td>{formatCurrency(row.accountBalance)}</td>
                </tr>
                {expandedAccount === row.accountName ? <AccountDetail row={row} executions={executions} /> : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Dashboard({ client, dailyImport, onBuildReport, onRecalculate }) {
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
          <div className="inline-actions">
            <button className="secondary-button" onClick={onRecalculate}>
              <RefreshCw size={16} /> Recalculate
            </button>
            <button className="secondary-button" onClick={onBuildReport}>
              <FileText size={16} /> Build Daily Report
            </button>
          </div>
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

      <AccountTable title="Evaluations" rows={report.grouped.evaluations} executions={dailyImport.executions || []} />
      <AccountTable title="Funded" rows={report.grouped.funded} executions={dailyImport.executions || []} />
      <AccountTable title="Cash Accounts" rows={report.grouped.cash} executions={dailyImport.executions || []} />
    </div>
  );
}
