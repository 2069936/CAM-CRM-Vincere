import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, RefreshCw, X } from 'lucide-react';
import { formatCurrency, summarizeAccountRows } from '../domain/report';
import { PAYOUT_STATES } from '../domain/reconcile';

function drawdownDisplay(row) {
  const ddLimit = Number(row.meta?.maxDrawdownLimit);
  const rawDD = Number(row.trailingMaxDrawdown || 0);
  if (Number.isFinite(ddLimit) && ddLimit > 0) {
    const remaining = ddLimit - Math.abs(rawDD);
    if (remaining <= 0) return { label: 'BREACHED', tone: 'negative' };
    if (remaining <= 500) return { label: `${formatCurrency(remaining)} left`, tone: 'negative' };
    if (remaining <= 1200) return { label: `${formatCurrency(remaining)} left`, tone: 'warning' };
    return { label: `${formatCurrency(remaining)} left`, tone: '' };
  }
  if (rawDD === 0) return { label: '-', tone: '' };
  if (rawDD <= 0) return { label: 'BREACHED', tone: 'negative' };
  if (rawDD <= 500) return { label: `${formatCurrency(rawDD)} buffer`, tone: 'negative' };
  if (rawDD <= 1200) return { label: `${formatCurrency(rawDD)} buffer`, tone: 'warning' };
  return { label: `${formatCurrency(rawDD)} buffer`, tone: '' };
}

// Risk level is assigned manually per account (not inferred). Empty = Unassigned.
function manualRiskDisplay(level) {
  if (level === 'High') return { label: 'High', tone: 'negative' };
  if (level === 'Medium') return { label: 'Medium', tone: 'warning' };
  if (level === 'Low') return { label: 'Low', tone: 'positive' };
  return { label: '—', tone: 'muted' };
}

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
  const values = executions
    .map((item) => ({ ...item, priceValue: Number(item.price || 0) }))
    .filter((item) => Number.isFinite(item.priceValue) && item.priceValue > 0);
  if (!values.length) return <div className="sparkline-empty">No price data</div>;
  const min = Math.min(...values.map((item) => item.priceValue));
  const max = Math.max(...values.map((item) => item.priceValue));
  const spread = max - min || 1;
  const nodes = values.map((item, index) => {
    const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 220;
    const y = 54 - ((item.priceValue - min) / spread) * 44;
    return { ...item, x, y };
  });
  const points = nodes.map((node) => `${node.x},${node.y}`).join(' ');

  return (
    <svg className="sparkline" viewBox="0 0 220 64" role="img" aria-label="Execution price timeline">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {nodes.map((node, index) => (
        <circle className="chart-node" key={`${node.orderId || node.id || index}-${node.time}`} cx={node.x} cy={node.y} r="4">
          <title>{`${node.time || 'Execution'} · ${node.action || 'Trade'} ${node.quantity || 0} @ ${formatPrice(node.priceValue)} · ${node.entryExit || '-'}`}</title>
        </circle>
      ))}
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

function buildTradeStats(executions, strategies) {
  const exits = executions.filter((e) => e.entryExit === 'Exit' || e.entryExit === 'exit');
  const entries = executions.filter((e) => e.entryExit === 'Entry' || e.entryExit === 'entry');
  const roundTrips = exits.length;
  const grossRealized = strategies.reduce((sum, s) => sum + Number(s.realized || 0), 0);
  const avgPerTrip = roundTrips > 0 ? grossRealized / roundTrips : null;
  const prices = executions.map((e) => Number(e.price || 0)).filter((p) => p > 0);
  const priceRange = prices.length >= 2
    ? { min: Math.min(...prices), max: Math.max(...prices) }
    : null;
  return { roundTrips, entries: entries.length, grossRealized, avgPerTrip, priceRange, total: executions.length };
}

function AccountHistorySparkline({ accountName, dailyImports }) {
  const history = (dailyImports || []).slice(-14).map((di) => {
    const snap = (di.snapshots || []).find((s) => s.accountName?.toLowerCase() === accountName?.toLowerCase());
    return { date: di.date, pnl: snap ? Number(snap.grossRealizedPnl || 0) : null };
  }).filter((d) => d.pnl !== null);

  if (history.length < 2) return <p className="muted">Not enough history to display.</p>;

  const values = history.map((d) => d.pnl);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 280;
  const H = 48;
  const stepX = W / (history.length - 1);

  const pts = history.map((d, i) => {
    const x = i * stepX;
    const y = H - ((d.pnl - min) / range) * H;
    return [x, y];
  });

  const polyline = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const totalPnl = values.reduce((s, v) => s + v, 0);

  return (
    <div className="account-history-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ overflow: 'visible' }}>
        <polyline
          points={polyline}
          fill="none"
          stroke={totalPnl >= 0 ? 'var(--success)' : 'var(--error)'}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3} fill={history[i].pnl >= 0 ? 'var(--success)' : 'var(--error)'}>
            <title>{history[i].date}: {history[i].pnl >= 0 ? '+' : ''}{formatCurrency(history[i].pnl)}</title>
          </circle>
        ))}
      </svg>
      <div className="sparkline-labels">
        <small className="muted">{history[0]?.date}</small>
        <small className={totalPnl >= 0 ? 'positive' : 'negative'}>{totalPnl >= 0 ? '+' : ''}{formatCurrency(totalPnl)} total</small>
        <small className="muted">{history.at(-1)?.date}</small>
      </div>
    </div>
  );
}

function AccountDetail({ row, executions, colSpan = 7, dailyImports }) {
  const [expandedStrategy, setExpandedStrategy] = useState('');
  const accountExecutions = executions.filter((execution) => execution.accountName === row.accountName);
  const tradeStats = buildTradeStats(accountExecutions, row.strategies || []);
  return (
    <tr className="account-detail-row">
      <td colSpan={colSpan}>
        {tradeStats.total > 0 ? (
          <div className="trade-stats-bar">
            <div><span>Round trips</span><strong>{tradeStats.roundTrips}</strong></div>
            <div><span>Entries / Exits</span><strong>{tradeStats.entries} / {tradeStats.roundTrips}</strong></div>
            <div><span>Gross realized</span><strong className={tradeStats.grossRealized >= 0 ? 'positive' : 'negative'}>{formatCurrency(tradeStats.grossRealized)}</strong></div>
            {tradeStats.avgPerTrip !== null ? (
              <div><span>Avg / round trip</span><strong className={tradeStats.avgPerTrip >= 0 ? 'positive' : 'negative'}>{formatCurrency(tradeStats.avgPerTrip)}</strong></div>
            ) : null}
            {tradeStats.priceRange ? (
              <div><span>Price range</span><strong>{formatPrice(tradeStats.priceRange.min)} → {formatPrice(tradeStats.priceRange.max)}</strong></div>
            ) : null}
          </div>
        ) : null}
        <div className="account-detail">
          <div>
            <h4>Strategies</h4>
            {row.strategies?.length ? (
              <div className="strategy-detail-list">
                {row.strategies.map((strategy) => {
                  const key = `${row.accountName}-${strategy.strategyName}`;
                  const strategyExecutions = accountExecutions.filter((execution) => execution.strategyName === strategy.strategyName);
                  const settings = formatStrategySettings(strategy);
                  return (
                    <div className="strategy-detail" key={key}>
                      <button
                        className="strategy-detail-toggle"
                        onClick={() => setExpandedStrategy((current) => (current === key ? '' : key))}
                      >
                        <span>
                          <strong><ChevronDown className={expandedStrategy === key ? 'chevron open' : 'chevron'} size={14} /> {strategy.strategyName}</strong>
                          <small>{strategy.instrument} · {strategy.enabled ? 'Enabled' : 'Disabled'}{strategy.strategyFamily === 'Bullet Bot' && strategy.direction ? ` · ${strategy.direction}` : ''}</small>
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
          <div>
            <h4>Account history</h4>
            <AccountHistorySparkline accountName={row.accountName} dailyImports={dailyImports} />
          </div>
        </div>
      </td>
    </tr>
  );
}

const PAYOUT_STATE_OPTIONS = Object.values(PAYOUT_STATES);

function payoutStateTone(state) {
  if (state === PAYOUT_STATES.PAYOUT_APPROVED || state === PAYOUT_STATES.CLEAR_TO_TRADE) return 'success';
  if (state === PAYOUT_STATES.PAYOUT_REQUESTED) return 'warning';
  if (state === PAYOUT_STATES.REQUEST_PAYOUT) return 'danger';
  return 'muted';
}

function AccountTable({ title, rows, executions, mode, onUpdateAccount, dailyImports }) {
  const [expandedAccount, setExpandedAccount] = useState('');
  if (!rows.length) return null;
  const isCash = mode === 'cash';
  const isFunded = title === 'Funded';
  const isEval = title === 'Standard Evaluations' || title === 'Bullet Bot';
  const colSpan = isCash ? 5 : isFunded ? 10 : isEval ? 8 : 6;

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
              {(isFunded || isEval) ? <th>Balance</th> : null}
              {!isCash ? <th>Drawdown</th> : null}
              {isFunded ? <th>Target</th> : null}
              {isFunded ? <th>Payout</th> : null}
              {isFunded ? <th>Risk</th> : null}
              {isEval ? <th>Phase target</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.accountName}>
                <tr
                  className="clickable-row"
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
                  {(isFunded || isEval) ? <td>{formatCurrency(row.accountBalance)}</td> : null}
                  {!isCash ? (() => { const dd = drawdownDisplay(row); return <td className={dd.tone}>{dd.label}</td>; })() : null}
                  {isFunded ? (() => {
                    const target = Number(row.meta?.targetProfit || 0);
                    const balance = Number(row.accountBalance || 0);
                    if (!target) return <td className="muted" onClick={(e) => e.stopPropagation()}>-</td>;
                    // Progress from the starting balance, not from zero. A 50k account
                    // with a 54k target sits at 0% at 50k, negative below it.
                    const start = Number(row.meta?.startBalance || 0) || (balance >= 90000 ? 100000 : 50000);
                    const pct = target > start ? Math.round(((balance - start) / (target - start)) * 100) : 0;
                    const reached = balance >= target;
                    return (
                      <td className="target-cell" onClick={(e) => e.stopPropagation()}>
                        <div className="target-progress">
                          <div className="target-bar">
                            <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: reached ? 'var(--success)' : pct >= 80 ? 'var(--warning)' : 'var(--accent)' }} />
                          </div>
                          <small className={reached ? 'positive' : ''}>{pct}%</small>
                        </div>
                        <small className="muted">{formatCurrency(balance)} / {formatCurrency(target)}</small>
                      </td>
                    );
                  })() : null}
                  {isFunded ? (
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`payout-select payout-${payoutStateTone(row.meta?.payoutState)}`}
                        value={row.meta?.payoutState || PAYOUT_STATES.NOT_REQUESTED}
                        onChange={(e) => onUpdateAccount && onUpdateAccount(row.accountName, { payoutState: e.target.value })}
                      >
                        {PAYOUT_STATE_OPTIONS.map((opt) => <option key={opt}>{opt}</option>)}
                      </select>
                    </td>
                  ) : null}
                  {isFunded ? (() => { const r = manualRiskDisplay(row.meta?.riskLevel); return <td className={r.tone}>{r.label}</td>; })() : null}
                  {isEval ? (() => {
                    const target = Number(row.meta?.targetProfit || 0);
                    const start = Number(row.meta?.startBalance || 0);
                    const balance = Number(row.accountBalance || 0);
                    if (!target) return <td className="muted">-</td>;
                    const base = start || (target * 0.97);
                    const profit = balance - base;
                    const needed = target - base;
                    const pct = needed > 0 ? Math.min(100, Math.max(0, Math.round((profit / needed) * 100))) : 0;
                    const passed = balance >= target;
                    return (
                      <td className="target-cell">
                        <div className="target-progress">
                          <div className="target-bar">
                            <i style={{ width: `${pct}%`, background: passed ? 'var(--success)' : pct >= 80 ? 'var(--warning)' : 'var(--accent)' }} />
                          </div>
                          <small className={passed ? 'positive' : ''}>{passed ? '✓ Passed' : `${pct}%`}</small>
                        </div>
                        <small className="muted">{formatCurrency(profit)} / {formatCurrency(needed)}</small>
                      </td>
                    );
                  })() : null}
                </tr>
                {expandedAccount === row.accountName ? <AccountDetail row={row} executions={executions} colSpan={colSpan} dailyImports={dailyImports} /> : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Dashboard({ dailyImport, rows = [], title, mode, onBuildReport, onRecalculate, onResolveFlag, onBulkResolveFlags, onUpdateAccount, client }) {
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
  const enrichedRows = rows;
  // Show ALL open flags for the close, not only those on the active tab's accounts.
  // Flags are account-level, so a Funded-account flag used to be invisible on the
  // Evaluations/Cash tab — the header could say "3 flags" with an empty list and
  // no way to act on them. Each row shows its account so the CAM knows where it is.
  const flags = (dailyImport.flags || [])
    .filter((flag) => flag.status !== 'Acknowledged' && flag.status !== 'Resolved');
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
            {onBulkResolveFlags && flags.length ? (
              <button className="ghost-button" style={{fontSize:12}} title="Resolve all open flags" onClick={() => onBulkResolveFlags('Resolved')}>
                Resolve all
              </button>
            ) : null}
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
              <div className={flag.status === 'Resolved' ? 'flag resolved' : flag.status === 'Acknowledged' ? 'flag acknowledged' : `flag ${flag.severity.toLowerCase()}`} key={flag.id}>
                {flag.severity === 'Critical' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                <div>
                  <strong>{flag.type}
                    {flag.status === 'Resolved' ? <span className="flag-resolved-badge">Resolved</span> : null}
                    {flag.status === 'Acknowledged' ? <span className="flag-resolved-badge" style={{background:'var(--surface-3)',color:'var(--text-muted)'}}>Ack'd</span> : null}
                  </strong>
                  <span>{flag.message}</span>
                </div>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {onResolveFlag && flag.severity !== 'Critical' ? (
                    <button
                      className="ghost-button"
                      title="Acknowledge - seen, hide for now. Reappears on the next close if still true."
                      style={{ fontSize: 11, padding: '2px 6px' }}
                      onClick={() => onResolveFlag(flag.id, 'Acknowledged')}
                    >
                      Ack
                    </button>
                  ) : null}
                  {onResolveFlag ? (
                    <button className="ghost-button icon-only flag-resolve-btn" title="Resolve - dismiss this flag" onClick={() => onResolveFlag(flag.id, 'Resolved')}>
                      <X size={14} />
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="notice success"><CheckCircle2 size={16} /> No open flags for this close.</div>
        )}
      </section>

      {title === 'Evaluations' ? (
        <>
          <AccountTable title="Bullet Bot" rows={enrichedRows.filter((row) => row.meta?.accountType === 'Evaluation - Bullet Bot')} executions={dailyImport.executions || []} mode={mode} onUpdateAccount={onUpdateAccount} dailyImports={client?.dailyImports} />
          <AccountTable title="Standard Evaluations" rows={enrichedRows.filter((row) => row.meta?.accountType === 'Evaluation - Standard')} executions={dailyImport.executions || []} mode={mode} onUpdateAccount={onUpdateAccount} dailyImports={client?.dailyImports} />
        </>
      ) : (
        <AccountTable title={title} rows={enrichedRows} executions={dailyImport.executions || []} mode={mode} onUpdateAccount={onUpdateAccount} dailyImports={client?.dailyImports} />
      )}
    </div>
  );
}
