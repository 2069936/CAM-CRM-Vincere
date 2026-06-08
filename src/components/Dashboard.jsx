import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, RefreshCw } from 'lucide-react';
import { formatCurrency, summarizeAccountRows } from '../domain/report';
import { enrichStrategyWithSetMatch } from '../domain/xmlMatch';

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

function formatPrice(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
}

function formatStrategySettings(strategy) {
  if (!strategy.params?.parsed) return '';
  const parts = [];
  if (strategy.params.posSizes?.length) parts.push(`Contracts ${strategy.params.posSizes.join('/')}`);
  if (strategy.params.stopLossTicks != null) parts.push(`Stop ${strategy.params.stopLossTicks}t`);
  if (strategy.params.profitTargets?.length) parts.push(`Targets ${strategy.params.profitTargets.join('/')}t`);
  return parts.join(' · ');
}

function formatConfigMatch(match) {
  if (!match?.matched) return match?.reason || '';
  return [match.risk, match.setVersion, match.period ? `Period ${match.period}` : '', match.passType, match.direction].filter(Boolean).join(' · ');
}

function AccountDetail({ row, executions, colSpan = 7 }) {
  const [expandedStrategy, setExpandedStrategy] = useState('');
  const accountExecutions = executions.filter((execution) => execution.accountName === row.accountName);
  return (
    <tr className="account-detail-row">
      <td colSpan={colSpan}>
        <div className="account-detail">
          <div>
            <h4>Strategies</h4>
            {row.strategies?.length ? (
              <div className="strategy-detail-list">
                {row.strategies.map((strategy) => {
                  const key = `${row.accountName}-${strategy.strategyName}`;
                  const strategyExecutions = accountExecutions.filter((execution) => execution.strategyName === strategy.strategyName);
                  const settings = formatStrategySettings(strategy);
                  const configLabel = formatConfigMatch(strategy.configMatch);
                  return (
                    <div className="strategy-detail" key={key}>
                      <button
                        className="strategy-detail-toggle"
                        onClick={() => setExpandedStrategy((current) => (current === key ? '' : key))}
                      >
                        <span>
                          <strong><ChevronDown className={expandedStrategy === key ? 'chevron open' : 'chevron'} size={14} /> {strategy.strategyName}</strong>
                          <small>{strategy.instrument} · {strategy.enabled ? 'Enabled' : 'Disabled'}{strategy.strategyFamily === 'Bullet Bot' && strategy.direction ? ` · ${strategy.direction}` : ''}</small>
                          {configLabel ? <small>{configLabel}</small> : null}
                          {settings ? <small>{settings}</small> : null}
                        </span>
                        <span>
                          <small>Realized {formatCurrency(strategy.realized)} · Unrealized {formatCurrency(strategy.unrealized)}</small>
                          <small>{strategyExecutions.length} executions</small>
                        </span>
                      </button>
                      {expandedStrategy === key ? (
                        <div className="strategy-trades">
                          {strategyExecutions.length ? (
                            <table className="mini-table">
                              <thead><tr><th>Time</th><th>Action</th><th>Qty</th><th>Price</th><th>E/X</th><th>Name</th></tr></thead>
                              <tbody>
                                {strategyExecutions.map((execution) => (
                                  <tr key={`${execution.id || execution.orderId}-${execution.time}-${execution.name}`}>
                                    <td>{execution.time || '-'}</td>
                                    <td>{execution.action || '-'}</td>
                                    <td>{execution.quantity || 0}</td>
                                    <td>{formatPrice(execution.price)}</td>
                                    <td>{execution.entryExit || '-'}</td>
                                    <td>{execution.name || '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : <p className="muted">No trades attributed to this strategy today.</p>}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
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

function AccountTable({ title, rows, executions, mode }) {
  const [expandedAccount, setExpandedAccount] = useState('');
  if (!rows.length) return null;
  const isCash = mode === 'cash';
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
              {!isCash ? <th>Status</th> : null}
              <th>Strategies</th>
              <th>Daily PnL</th>
              <th>Weekly PnL</th>
              {isCash ? <th>Cash balance</th> : null}
              {!isCash ? <th>Drawdown</th> : null}
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
                    <strong><ChevronDown className={expandedAccount === row.accountName ? 'chevron open' : 'chevron'} size={14} /> {row.meta?.alias || row.accountName}</strong>
                    <small>{row.meta?.connection || row.connection || 'No connection'}</small>
                  </td>
                  {!isCash ? <td>{row.meta?.status || 'Active'}</td> : null}
                  <td>
                    {row.strategies?.length ? row.strategies.map((strategy) => (
                      <span className={strategy.enabled ? 'strategy enabled' : 'strategy'} key={`${row.accountName}-${strategy.strategyName}`}>
                        {strategy.strategyFamily || strategy.strategyName}{strategy.strategyVersion ? ` ${strategy.strategyVersion}` : ''}{strategy.strategyFamily === 'Bullet Bot' && strategy.direction ? ` · ${strategy.direction}` : ''}
                      </span>
                    )) : <span className="muted">None</span>}
                  </td>
                  <td className={row.grossRealizedPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.grossRealizedPnl)}</td>
                  <td className={row.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.weeklyPnl)}</td>
                  {isCash ? <td>{formatCurrency(row.accountBalance)}</td> : null}
                  {!isCash ? <td>{formatCurrency(row.trailingMaxDrawdown)}</td> : null}
                </tr>
                {expandedAccount === row.accountName ? <AccountDetail row={row} executions={executions} colSpan={isCash ? 5 : 6} /> : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Dashboard({ dailyImport, rows = [], title, mode, onBuildReport, onRecalculate, strategySetRecords = [] }) {
  if (!dailyImport) {
    return (
      <div className="empty-state">
        <FileText size={24} />
        <h3>No daily close for this date</h3>
        <p>Upload the four NinjaTrader files to create the client snapshot.</p>
      </div>
    );
  }

  const summary = summarizeAccountRows(rows);
  const enrichedRows = rows.map((row) => ({
    ...row,
    strategies: (row.strategies || []).map((strategy) => enrichStrategyWithSetMatch(strategy, strategySetRecords)),
  }));
  const relevantAccountNames = new Set(rows.map((row) => row.accountName));
  const flags = (dailyImport.flags || []).filter((flag) => !flag.accountName || relevantAccountNames.has(flag.accountName));
  const criticalFlags = flags.filter((flag) => flag.severity === 'Critical');
  const isCash = mode === 'cash';

  return (
    <div className="dashboard-stack">
      <div className="metric-grid">
        <Metric label={`${title} accounts`} value={summary.counts.accounts} />
        <Metric label="Daily/Gross PnL" value={formatCurrency(summary.totals.grossRealizedPnl)} tone={summary.totals.grossRealizedPnl >= 0 ? 'positive' : 'negative'} />
        <Metric label="Weekly PnL" value={formatCurrency(summary.totals.weeklyPnl)} tone={summary.totals.weeklyPnl >= 0 ? 'positive' : 'negative'} />
        {isCash ? <Metric label="Cash account balance" value={formatCurrency(summary.totals.aggregateBalance)} /> : null}
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
        {flags.length ? (
          <div className="flag-list">
            {flags.map((flag) => (
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

      {title === 'Evaluations' ? (
        <>
          <AccountTable title="Bullet Bot" rows={enrichedRows.filter((row) => row.meta?.accountType === 'Evaluation - Bullet Bot')} executions={dailyImport.executions || []} mode={mode} />
          <AccountTable title="Standard Evaluations" rows={enrichedRows.filter((row) => row.meta?.accountType === 'Evaluation - Standard')} executions={dailyImport.executions || []} mode={mode} />
        </>
      ) : (
        <AccountTable title={title} rows={enrichedRows} executions={dailyImport.executions || []} mode={mode} />
      )}
    </div>
  );
}
