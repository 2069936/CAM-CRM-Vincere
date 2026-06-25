import { useState } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Info, ArrowRight, Clock } from 'lucide-react';
import { ACCOUNT_TYPES, ACCOUNT_STATUSES } from '../domain/reconcile';

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
export function buildAlgoComboPerformance(allClients = []) {
  const combos = {};

  for (const client of allClients) {
    const rawReg = client.accountRegistry || {};
    const registry = Object.fromEntries(Object.entries(rawReg).map(([k, v]) => [k.toLowerCase(), v]));
    const imports = client.dailyImports || [];
    const n = imports.length;

    for (let i = 0; i < n; i++) {
      const di = imports[i];
      const isRecent7 = i >= n - 7;
      const isPrior7 = i >= n - 14 && i < n - 7;

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
            recent7Pnl: 0,
            recent7Days: 0,
            prior7Pnl: 0,
            prior7Days: 0,
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
        if (isRecent7) { entry.recent7Pnl += pnl; entry.recent7Days += 1; }
        if (isPrior7)  { entry.prior7Pnl += pnl; entry.prior7Days += 1; }
      }
    }
  }

  return Object.values(combos)
    .map((c) => {
      const avgPnl = c.days ? c.totalPnl / c.days : 0;
      const recent7Avg = c.recent7Days ? c.recent7Pnl / c.recent7Days : null;
      const prior7Avg  = c.prior7Days  ? c.prior7Pnl  / c.prior7Days  : null;
      let trend = 'stable';
      if (recent7Avg !== null && prior7Avg !== null) {
        if (recent7Avg > prior7Avg * 1.1) trend = 'up';
        else if (recent7Avg < prior7Avg * 0.9) trend = 'down';
      }
      return {
        combo: c.combo,
        avgPnl,
        winRate: c.days ? Math.round((c.winDays / c.days) * 100) : 0,
        totalDays: c.days,
        accounts: c.accountSet.size,
        clients: c.clientSet.size,
        trend,
        recent7Avg,
        prior7Avg,
      };
    })
    .sort((a, b) => b.avgPnl - a.avgPnl);
}

// For a specific client's funded accounts, compare their combo vs team avg and suggest better option
function buildClientComboInsights(client, dailyImport, comboPerf) {
  if (!client || !comboPerf.length) return [];
  const registry = mergeRegCi(dailyImport?.accounts, client.accountRegistry);
  const snapshots = dailyImport?.snapshots || [];
  const perfByCombo = Object.fromEntries(comboPerf.map((c) => [c.combo, c]));
  const best = comboPerf[0];

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
      const accountPnl7 = (client.dailyImports || [])
        .slice(-7)
        .reduce((sum, di) => {
          const snap = (di.snapshots || []).find((x) => x.accountName?.toLowerCase() === sNameLower);
          return sum + Number(snap?.grossRealizedPnl || 0);
        }, 0);
      const accountAvg7 = accountPnl7 / 7;
      const teamAvg7 = teamData?.recent7Avg ?? teamData?.avgPnl ?? null;
      const delta = teamAvg7 !== null ? accountAvg7 - teamAvg7 : null;
      const suggestion = best.combo !== currentCombo && best.avgPnl > (teamData?.avgPnl || 0) * 1.15
        ? best.combo
        : null;

      return {
        accountName: s.accountName,
        alias: meta.alias || s.accountName,
        currentCombo,
        accountAvg7,
        teamAvg7,
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
  const accountsNeeded = avgPerAccount > 0 ? Math.ceil(targetMonthly / avgPerAccount) : '—';
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
          ? <p className="income-note positive">On track — {currentFunded} funded accounts generating ~{fmt(currentMonthly)}/mo.</p>
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

  function updateStack(accountName, value) {
    const prev = ciMeta(registryCi, accountName)?.algoStack || '';
    if (value === prev) return;
    setLocalStack((s) => ({ ...s, [accountName]: value }));
    const today = new Date().toISOString().slice(0, 10);
    const note = changeNotes[accountName] || '';
    const existing = ciMeta(registryCi, accountName)?.algoHistory || [];
    const newEntry = { date: today, from: prev || '—', to: value || '—', note };
    onUpdateAccount?.(accountName, { algoStack: value, algoHistory: [...existing, newEntry] });
    setChangeNotes((n) => ({ ...n, [accountName]: '' }));
  }
  function updateDll(accountName, value) {
    setLocalDll((prev) => ({ ...prev, [accountName]: value }));
    onUpdateAccount?.(accountName, { dailyLossLimit: value });
  }

  // Build team intelligence using ALL clients
  const teamClients = allClients.length ? allClients : (client ? [client] : []);
  const comboPerf = buildAlgoComboPerformance(teamClients);
  const clientInsights = buildClientComboInsights(client, dailyImport, comboPerf);

  const hasSuggestions = clientInsights.some((i) => i.suggestion);
  const totalTeamAccounts = comboPerf.reduce((s, c) => s + c.accounts, 0);

  return (
    <div className="stack-playbook">

      {/* ── Team Intel ─────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-heading">
          <h3>Team Algo Performance</h3>
          <span className="badge muted">{teamClients.length} clients · {totalTeamAccounts} account-runs · all history</span>
        </div>
        {comboPerf.length === 0 ? (
          <p className="muted" style={{ padding: '12px 0' }}>No strategy data across clients yet — upload daily closes to populate.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              <Info size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Aggregated from every client running each algo combination. Use this to evaluate what's working across the portfolio — not a per-client guarantee.
            </p>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Combo</th>
                    <th>Avg P&amp;L / day</th>
                    <th>Win rate</th>
                    <th>Trend (7d)</th>
                    <th>Last 7d avg</th>
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
                      <td className={row.recent7Avg != null ? (row.recent7Avg >= 0 ? 'positive' : 'negative') : 'muted'}>
                        {row.recent7Avg != null ? `${row.recent7Avg >= 0 ? '+' : ''}${fmt(row.recent7Avg)}` : '—'}
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
                  <th>This acct 7d avg</th>
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
                    <td className={row.accountAvg7 >= 0 ? 'positive' : 'negative'}>
                      {row.accountAvg7 >= 0 ? '+' : ''}{fmt(row.accountAvg7)}
                    </td>
                    <td className="muted">
                      {row.teamAvg7 != null ? `${row.teamAvg7 >= 0 ? '+' : ''}${fmt(row.teamAvg7)}` : '—'}
                    </td>
                    <td className={row.delta == null ? 'muted' : row.delta >= 0 ? 'positive' : 'negative'}>
                      {row.delta != null ? `${row.delta >= 0 ? '+' : ''}${fmt(row.delta)}` : '—'}
                    </td>
                    <td>
                      {row.suggestion ? (
                        <span className="playbook-suggestion">
                          <ArrowRight size={12} />
                          Consider <strong>{row.suggestion}</strong> — team avg {fmt(row.bestAvg)}/day
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
            Suggestions are based on team aggregate data — market conditions vary. Use as insight, not instruction.
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
                  const liveCombo = snap ? comboFromStrategies(snap.strategies || []) : '—';
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
                          : <span className="muted">—</span>}
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
                      <td className="muted">{h.note || <em>—</em>}</td>
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
