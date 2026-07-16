import { useState } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Info, ArrowRight, Clock, ChevronDown } from 'lucide-react';
import { ACCOUNT_TYPES, ACCOUNT_STATUSES } from '../domain/reconcile';
import { buildAccountEquitySeries } from '../domain/stackAnalytics';
import { buildRiskScalingCurve, estimateMaxSafeMultiplier, parseComboRisk } from '../domain/riskScaling';
import AccountHistoryChart from './AccountHistoryChart';

const ALGO_STACKS = ['', 'URGO', 'IFSP', 'URGO + IFSP', 'URGO x2', 'IFSP x2', 'Custom'];
const DLL_OPTIONS = ['', 'None', '$300', '$400', '$500', '$600', '$700', '$800', '$1,000'];

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));
}

function mergeRegCi(importAccounts, clientRegistry) {
  const merged = { ...(importAccounts || {}), ...(clientRegistry || {}) };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]));
}
function ciMeta(reg, name) { return reg[(name || '').toLowerCase()] || {}; }

// Normalize algo combo string from strategy names in a snapshot
function comboFromStrategies(strategies = []) {
  const active = strategies
    .filter((s) => s.enabled)
    .map((s) => {
      const name = (s.strategyFamily || s.strategyName || '').toUpperCase();
      if (name.includes('URGO')) return 'URGO';
      if (name.includes('IFSP')) return 'IFSP';
      if (name.includes('BULLET')) return 'Bullet';
      return name.slice(0, 8) || 'Unknown';
    })
    .sort();
  const unique = [...new Set(active)];
  return unique.join(' + ') || 'Unknown';
}

// Aggregate algo combo performance across ALL clients' historical closes
// Calendar days that `date` (YYYY-MM-DD) falls before `anchor`. 0 = same day.
// Date-based so the "recent window" is aligned across clients regardless of how
// many imports each has — the positional last-N-rows approach misaligned them.
function daysBefore(anchor, date) {
  if (!anchor || !date) return Infinity;
  const a = new Date(`${anchor}T00:00:00Z`).getTime();
  const d = new Date(`${date}T00:00:00Z`).getTime();
  return Math.round((a - d) / 86400000);
}

// Latest import date across a set of clients — the window anchor.
function latestImportDate(clients) {
  let anchor = '';
  for (const client of clients || []) {
    for (const di of client.dailyImports || []) {
      if ((di.date || '') > anchor) anchor = di.date || '';
    }
  }
  return anchor;
}

export function buildAlgoComboPerformance(allClients = [], { windowDays = 7 } = {}) {
  const combos = {};
  const anchor = latestImportDate(allClients);

  for (const client of allClients) {
    const rawReg = client.accountRegistry || {};
    const registry = Object.fromEntries(Object.entries(rawReg).map(([k, v]) => [k.toLowerCase(), v]));

    for (const di of client.dailyImports || []) {
      const age = daysBefore(anchor, di.date); // days this close is before the anchor
      const isRecent = age >= 0 && age < windowDays;
      const isPrior = age >= windowDays && age < windowDays * 2;

      for (const snap of di.snapshots || []) {
        const meta = registry[(snap.accountName || '').toLowerCase()] || {};
        if (meta.accountType !== ACCOUNT_TYPES.FUNDED) continue;
        if (meta.status === ACCOUNT_STATUSES.FAILED || meta.status === ACCOUNT_STATUSES.INACTIVE) continue;

        const combo = comboFromStrategies(snap.strategies || []);
        if (combo === 'Unknown' || combo === '') continue;

        if (!combos[combo]) {
          combos[combo] = {
            combo,
            totalPnl: 0,
            days: 0,
            winDays: 0,
            recentPnl: 0,
            recentDays: 0,
            priorPnl: 0,
            priorDays: 0,
            accountSet: new Set(),
            clientSet: new Set(),
          };
        }

        const pnl = Number(snap.grossRealizedPnl || 0);
        const entry = combos[combo];
        entry.totalPnl += pnl;
        entry.days += 1;
        if (pnl > 0) entry.winDays += 1;
        entry.accountSet.add(`${client.id}::${snap.accountName}`);
        entry.clientSet.add(client.id);
        if (isRecent) { entry.recentPnl += pnl; entry.recentDays += 1; }
        if (isPrior)  { entry.priorPnl += pnl; entry.priorDays += 1; }
      }
    }
  }

  return Object.values(combos)
    .map((c) => {
      const avgPnl = c.days ? c.totalPnl / c.days : 0;
      const recentAvg = c.recentDays ? c.recentPnl / c.recentDays : null;
      const priorAvg  = c.priorDays  ? c.priorPnl  / c.priorDays  : null;
      let trend = 'stable';
      if (recentAvg !== null && priorAvg !== null) {
        if (recentAvg > priorAvg * 1.1) trend = 'up';
        else if (recentAvg < priorAvg * 0.9) trend = 'down';
      }
      return {
        combo: c.combo,
        avgPnl,
        winRate: c.days ? Math.round((c.winDays / c.days) * 100) : 0,
        totalDays: c.days,
        accounts: c.accountSet.size,
        clients: c.clientSet.size,
        trend,
        recentAvg,
        priorAvg,
        recentDays: c.recentDays,
      };
    })
    .sort((a, b) => b.avgPnl - a.avgPnl);
}

// For a specific client's funded accounts, compare their combo vs team avg and suggest better option
function buildClientComboInsights(client, dailyImport, comboPerf, { windowDays = 7 } = {}) {
  if (!client || !comboPerf.length) return [];
  const registry = mergeRegCi(dailyImport?.accounts, client.accountRegistry);
  const snapshots = dailyImport?.snapshots || [];
  const perfByCombo = Object.fromEntries(comboPerf.map((c) => [c.combo, c]));
  const best = comboPerf[0];
  // Anchor the account window at the close being viewed, not the array tail.
  const anchor = dailyImport?.date || latestImportDate([client]);

  return snapshots
    .filter((s) => {
      const meta = ciMeta(registry, s.accountName);
      return meta.accountType === ACCOUNT_TYPES.FUNDED &&
        meta.status !== ACCOUNT_STATUSES.FAILED &&
        meta.status !== ACCOUNT_STATUSES.INACTIVE;
    })
    .map((s) => {
      const meta = ciMeta(registry, s.accountName);
      const currentCombo = comboFromStrategies(s.strategies || []);
      const teamData = perfByCombo[currentCombo];
      const sNameLower = (s.accountName || '').toLowerCase();
      // Sum the account's PnL over the real date window and divide by the days
      // that actually had data (not a hard-coded 7).
      let sum = 0;
      let daysWithData = 0;
      for (const di of client.dailyImports || []) {
        const age = daysBefore(anchor, di.date);
        if (age < 0 || age >= windowDays) continue;
        const snap = (di.snapshots || []).find((x) => x.accountName?.toLowerCase() === sNameLower);
        if (snap) { sum += Number(snap.grossRealizedPnl || 0); daysWithData += 1; }
      }
      const accountAvg = daysWithData ? sum / daysWithData : 0;
      const teamAvg = teamData?.recentAvg ?? teamData?.avgPnl ?? null;
      const delta = teamAvg !== null ? accountAvg - teamAvg : null;
      const suggestion = best.combo !== currentCombo && best.avgPnl > (teamData?.avgPnl || 0) * 1.15
        ? best.combo
        : null;

      return {
        accountName: s.accountName,
        alias: meta.alias || s.accountName,
        currentCombo,
        accountAvg,
        accountDays: daysWithData,
        teamAvg,
        delta,
        suggestion,
        bestCombo: best.combo,
        bestAvg: best.avgPnl,
        teamData,
      };
    });
}

function TrendIcon({ trend }) {
  if (trend === 'up')   return <TrendingUp  size={14} className="positive" />;
  if (trend === 'down') return <TrendingDown size={14} className="negative" />;
  return <Minus size={14} className="muted" />;
}

function IncomeProjection({ currentFunded }) {
  const [avgPerAccount, setAvgPerAccount] = useState(800);
  const [targetMonthly, setTargetMonthly] = useState(10000);
  const accountsNeeded = avgPerAccount > 0 ? Math.ceil(targetMonthly / avgPerAccount) : '-';
  const currentMonthly = currentFunded * avgPerAccount;
  const gap = targetMonthly - currentMonthly;
  return (
    <div className="income-projection">
      <div className="income-inputs">
        <div>
          <label>Avg monthly P&amp;L per funded account</label>
          <input type="number" value={avgPerAccount} min={100} step={100} onChange={(e) => setAvgPerAccount(Number(e.target.value))} />
        </div>
        <div>
          <label>Monthly income target</label>
          <input type="number" value={targetMonthly} min={1000} step={1000} onChange={(e) => setTargetMonthly(Number(e.target.value))} />
        </div>
      </div>
      <div className="income-results">
        <div className="income-result-card"><span>Accounts needed</span><strong>{accountsNeeded}</strong></div>
        <div className="income-result-card"><span>Current funded</span><strong>{currentFunded}</strong></div>
        <div className="income-result-card"><span>Projected monthly</span><strong className={currentMonthly >= targetMonthly ? 'positive' : ''}>{fmt(currentMonthly)}</strong></div>
        <div className="income-result-card">
          <span>{gap > 0 ? 'Gap to target' : 'Surplus'}</span>
          <strong className={gap <= 0 ? 'positive' : 'warning'}>{fmt(Math.abs(gap))}</strong>
        </div>
      </div>
      {gap > 0 && currentFunded > 0
        ? <p className="income-note muted">Need {accountsNeeded - currentFunded} more funded account{accountsNeeded - currentFunded !== 1 ? 's' : ''} to reach {fmt(targetMonthly)}/mo.</p>
        : gap <= 0 && currentFunded > 0
          ? <p className="income-note positive">On track - {currentFunded} funded accounts generating ~{fmt(currentMonthly)}/mo.</p>
          : null}
    </div>
  );
}

export default function StackPlaybook({ client, dailyImport, onUpdateAccount, allClients = [] }) {
  const registryCi = mergeRegCi(dailyImport?.accounts, client?.accountRegistry);
  const snapshots = dailyImport?.snapshots || [];

  const funded = Object.values(registryCi).filter(
    (a) => a.accountType === ACCOUNT_TYPES.FUNDED &&
      a.status !== ACCOUNT_STATUSES.FAILED &&
      a.status !== ACCOUNT_STATUSES.INACTIVE,
  );

  const [localStack, setLocalStack] = useState({});
  const [localDll, setLocalDll] = useState({});
  const [changeNotes, setChangeNotes] = useState({});
  const [historyOpen, setHistoryOpen] = useState(true);
  const [riskOpen, setRiskOpen] = useState(false);
  const [windowDays, setWindowDays] = useState(30);

  // Funded + evaluation accounts get a full-history chart (cash accounts are
  // tracked by cash balance, not trajectory).
  const chartAccounts = Object.values(registryCi).filter(
    (a) =>
      (a.accountType === ACCOUNT_TYPES.FUNDED || String(a.accountType || '').startsWith('Evaluation')) &&
      a.status !== ACCOUNT_STATUSES.FAILED &&
      a.status !== ACCOUNT_STATUSES.INACTIVE,
  );

  function updateStack(accountName, value) {
    const prev = ciMeta(registryCi, accountName)?.algoStack || '';
    if (value === prev) return;
    setLocalStack((s) => ({ ...s, [accountName]: value }));
    const today = new Date().toISOString().slice(0, 10);
    const note = changeNotes[accountName] || '';
    const existing = ciMeta(registryCi, accountName)?.algoHistory || [];
    const newEntry = { date: today, from: prev || '-', to: value || '-', note };
    onUpdateAccount?.(accountName, { algoStack: value, algoHistory: [...existing, newEntry] });
    setChangeNotes((n) => ({ ...n, [accountName]: '' }));
  }
  function updateDll(accountName, value) {
    setLocalDll((prev) => ({ ...prev, [accountName]: value }));
    onUpdateAccount?.(accountName, { dailyLossLimit: value });
  }

  // Build team intelligence using ALL clients
  const teamClients = allClients.length ? allClients : (client ? [client] : []);
  const comboPerf = buildAlgoComboPerformance(teamClients, { windowDays });
  const clientInsights = buildClientComboInsights(client, dailyImport, comboPerf, { windowDays });
  const riskCurves = buildRiskScalingCurve(comboPerf);

  const hasSuggestions = clientInsights.some((i) => i.suggestion);
  const totalTeamAccounts = comboPerf.reduce((s, c) => s + c.accounts, 0);

  return (
    <div className="stack-playbook">

      {/* ── Account history ────────────────────────────────── */}
      {chartAccounts.length ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setHistoryOpen((v) => !v)}>
            <ChevronDown className={historyOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Account history</h3>
            <span className="muted">Equity curve + drawdown buffer over every close</span>
            <span className="count">{chartAccounts.length}</span>
          </button>
          {historyOpen ? (
            <div className="ahc-list">
              {chartAccounts.map((account) => {
                const series = buildAccountEquitySeries(client, account.accountName);
                const ddLimit = Number(account.maxDrawdownLimit || 0);
                const snap = snapshots.find((s) => s.accountName?.toLowerCase() === account.accountName.toLowerCase());
                const mult = parseComboRisk(comboFromStrategies(snap?.strategies || [])).multiplier;
                const last = series[series.length - 1];
                const buffer = last ? (ddLimit > 0 ? ddLimit - Math.abs(last.trailing) : last.trailing) : 0;
                const safe = estimateMaxSafeMultiplier(series, buffer, mult);
                return (
                  <div className="ahc-account" key={account.accountName}>
                    <div className="ahc-account-head">
                      <strong>{account.alias || account.accountName}</strong>
                      <small className="muted">{account.accountType}{account.connection ? ` · ${account.connection}` : ''}</small>
                      {safe ? (
                        <small className={safe.safeLevel < mult ? 'negative' : 'muted'}>
                          buffer supports ~{safe.safeLevel}x{mult ? ` (running ${mult}x)` : ''}
                        </small>
                      ) : null}
                    </div>
                    <AccountHistoryChart series={series} ddLimit={ddLimit} alias={account.alias || account.accountName} />
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Risk scaling (combo × contract level) ──────────── */}
      {riskCurves.some((c) => c.hasScaling) ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setRiskOpen((v) => !v)}>
            <ChevronDown className={riskOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Risk scaling</h3>
            <span className="muted">How PnL scales with contract level per algo — the level with the best per-contract return wins</span>
          </button>
          {riskOpen ? (
            <div className="risk-scaling-list">
              {riskCurves.filter((c) => c.hasScaling).map((curve) => (
                <div className="risk-curve" key={curve.base}>
                  <div className="risk-curve-head">
                    <strong>{curve.base}</strong>
                    {curve.bestEfficiency ? (
                      <small className="muted">Best per-contract-unit: <b>{curve.bestEfficiency.combo}</b> ({fmt(curve.bestEfficiency.riskNormalizedPnl)}/unit)</small>
                    ) : null}
                  </div>
                  <div className="table-wrap">
                    <table className="ops-table">
                      <thead>
                        <tr>
                          <th>Level</th>
                          <th>Avg P&amp;L / day</th>
                          <th>Per contract-unit</th>
                          <th>Win rate</th>
                          <th>Accounts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {curve.levels.map((l) => (
                          <tr key={l.combo} className={l === curve.bestEfficiency ? 'row-highlight' : ''}>
                            <td><strong>{l.riskLevel}x</strong> <span className="muted">{l.combo}</span></td>
                            <td className={l.avgPnl >= 0 ? 'positive' : 'negative'}>{l.avgPnl >= 0 ? '+' : ''}{fmt(l.avgPnl)}</td>
                            <td>{fmt(l.riskNormalizedPnl)}</td>
                            <td>{l.winRate}%</td>
                            <td>{l.accounts}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <p className="muted" style={{ fontSize: 12, padding: '4px 0 0' }}>
                Risk level ≈ contract multiplier (each level roughly doubles contracts). "Per contract-unit" normalizes PnL by the multiplier so levels compare fairly — a higher raw PnL at 2x is only better if it beats 1x per unit.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Team Intel ─────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-heading">
          <h3>Team Algo Performance</h3>
          <span className="badge muted">{teamClients.length} clients · {totalTeamAccounts} account-runs</span>
          <select
            className="window-select"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            title="Trend / recent-average window"
          >
            {[7, 30, 60, 90, 180].map((d) => <option key={d} value={d}>{`Last ${d}d`}</option>)}
          </select>
        </div>
        {comboPerf.length === 0 ? (
          <p className="muted" style={{ padding: '12px 0' }}>No strategy data across clients yet - upload daily closes to populate.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              <Info size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Aggregated from every client running each algo combination. Use this to evaluate what's working across the portfolio - not a per-client guarantee.
            </p>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Combo</th>
                    <th>Avg P&amp;L / day</th>
                    <th>Win rate</th>
                    <th>Trend ({windowDays}d)</th>
                    <th>Last {windowDays}d avg</th>
                    <th>Accounts</th>
                    <th>Clients</th>
                    <th>Total days</th>
                  </tr>
                </thead>
                <tbody>
                  {comboPerf.map((row, i) => (
                    <tr key={row.combo} className={i === 0 ? 'row-highlight' : ''}>
                      <td>
                        <strong>{row.combo}</strong>
                        {i === 0 ? <span className="badge success" style={{ marginLeft: 6 }}>Best</span> : null}
                      </td>
                      <td className={row.avgPnl >= 0 ? 'positive' : 'negative'}>
                        {row.avgPnl >= 0 ? '+' : ''}{fmt(row.avgPnl)}
                      </td>
                      <td>{row.winRate}%</td>
                      <td style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <TrendIcon trend={row.trend} />
                        <span className={row.trend === 'up' ? 'positive' : row.trend === 'down' ? 'negative' : 'muted'}>
                          {row.trend}
                        </span>
                      </td>
                      <td className={row.recentAvg != null ? (row.recentAvg >= 0 ? 'positive' : 'negative') : 'muted'}>
                        {row.recentAvg != null ? `${row.recentAvg >= 0 ? '+' : ''}${fmt(row.recentAvg)}` : '-'}
                      </td>
                      <td>{row.accounts}</td>
                      <td>{row.clients}</td>
                      <td className="muted">{row.totalDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* ── Client Config vs Team ───────────────────────────── */}
      {clientInsights.length > 0 ? (
        <section className={`panel ${hasSuggestions ? 'playbook-has-suggestions' : ''}`}>
          <div className="panel-heading">
            <h3>Client Config vs Team Avg</h3>
            {hasSuggestions
              ? <span className="badge warning"><AlertTriangle size={12} /> Consider updating</span>
              : <span className="badge success">On best combos</span>}
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Current combo</th>
                  <th>This acct {windowDays}d avg</th>
                  <th>Team avg (same combo)</th>
                  <th>vs Team</th>
                  <th>Insight</th>
                </tr>
              </thead>
              <tbody>
                {clientInsights.map((row) => (
                  <tr key={row.accountName}>
                    <td><strong>{row.alias}</strong></td>
                    <td><span className="badge muted">{row.currentCombo}</span></td>
                    <td className={row.accountAvg >= 0 ? 'positive' : 'negative'}>
                      {row.accountAvg >= 0 ? '+' : ''}{fmt(row.accountAvg)}
                    </td>
                    <td className="muted">
                      {row.teamAvg != null ? `${row.teamAvg >= 0 ? '+' : ''}${fmt(row.teamAvg)}` : '-'}
                    </td>
                    <td className={row.delta == null ? 'muted' : row.delta >= 0 ? 'positive' : 'negative'}>
                      {row.delta != null ? `${row.delta >= 0 ? '+' : ''}${fmt(row.delta)}` : '-'}
                    </td>
                    <td>
                      {row.suggestion ? (
                        <span className="playbook-suggestion">
                          <ArrowRight size={12} />
                          Consider <strong>{row.suggestion}</strong> - team avg {fmt(row.bestAvg)}/day
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>On best known combo</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, padding: '8px 0 0' }}>
            Suggestions are based on team aggregate data - market conditions vary. Use as insight, not instruction.
          </p>
        </section>
      ) : null}

      {/* ── Per-account config editor ───────────────────────── */}
      {funded.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <h3>Account Configuration</h3>
            <span className="badge muted">Set algo stack + DLL · changes are logged automatically</span>
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Live combo</th>
                  <th>Drawdown buffer</th>
                  <th>Assign algo stack</th>
                  <th>Change note</th>
                  <th>Daily Loss Limit</th>
                </tr>
              </thead>
              <tbody>
                {funded.map((account) => {
                  const snap = snapshots.find((s) => s.accountName?.toLowerCase() === account.accountName?.toLowerCase());
                  const liveCombo = snap ? comboFromStrategies(snap.strategies || []) : '-';
                  const buffer = snap ? Number(snap.trailingMaxDrawdown || 0) : null;
                  const stackVal = localStack[account.accountName] ?? (account.algoStack || '');
                  const dllVal   = localDll[account.accountName]   ?? (account.dailyLossLimit || '');
                  const noteVal  = changeNotes[account.accountName] || '';
                  return (
                    <tr key={account.accountName}>
                      <td>
                        <strong>{account.alias || account.accountName}</strong>
                        <small>{account.accountName}</small>
                      </td>
                      <td><span className="badge muted">{liveCombo}</span></td>
                      <td>
                        {buffer !== null
                          ? buffer <= 0
                            ? <span className="negative">BREACHED</span>
                            : <span className={buffer < 1200 ? 'warning' : ''}>${buffer.toLocaleString()}</span>
                          : <span className="muted">-</span>}
                      </td>
                      <td>
                        <select value={stackVal} onChange={(e) => updateStack(account.accountName, e.target.value)}>
                          {ALGO_STACKS.map((opt) => <option key={opt} value={opt}>{opt || 'Not set'}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          className="algo-note-input"
                          placeholder="Why changing? (optional)"
                          value={noteVal}
                          onChange={(e) => setChangeNotes((n) => ({ ...n, [account.accountName]: e.target.value }))}
                        />
                      </td>
                      <td>
                        <select value={dllVal} onChange={(e) => updateDll(account.accountName, e.target.value)}>
                          {DLL_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt || 'None'}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Algo Change History ─────────────────────────────── */}
      {(() => {
        const allHistory = funded.flatMap((account) =>
          (account.algoHistory || []).map((h) => ({ ...h, alias: account.alias || account.accountName }))
        ).sort((a, b) => b.date.localeCompare(a.date));

        if (!allHistory.length) return null;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>Algo Change History</h3>
              <Clock size={15} />
              <span className="badge muted">{allHistory.length} change{allHistory.length !== 1 ? 's' : ''} logged</span>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr><th>Date</th><th>Account</th><th>From</th><th>To</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {allHistory.map((h, i) => (
                    <tr key={i}>
                      <td className="muted">{h.date}</td>
                      <td><strong>{h.alias}</strong></td>
                      <td className="muted">{h.from}</td>
                      <td><span className="badge muted">{h.to}</span></td>
                      <td className="muted">{h.note || <em>-</em>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {/* ── Income Projection ──────────────────────────────── */}
      <section className="panel">
        <div className="panel-heading">
          <h3>Income Projection</h3>
          <span className="badge muted">How many accounts to hit monthly target?</span>
        </div>
        <IncomeProjection currentFunded={funded.length} />
      </section>

    </div>
  );
}
