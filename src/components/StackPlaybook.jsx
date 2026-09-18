import { useState } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Info, ArrowRight, Clock, ChevronDown } from 'lucide-react';
import { ACCOUNT_TYPES, ACCOUNT_STATUSES, RISK_LEVELS } from '../domain/reconcile';
import { groupStrategiesBySignature, detectVersionMismatches, classifyStrategy } from '../domain/strategyClassification';
import { aggregateLogFamilyHistory } from '../domain/ninjaTraderLog';
import { buildAccountLifecycle } from '../domain/accountLifecycle';
import { buildAccountEquitySeries, buildComboByFirm } from '../domain/stackAnalytics';
import { buildBulletBotDeskStats } from '../domain/bulletBotDeskStats';
import {
  buildClientComboInsights,
  buildComboPerformance,
  comboKeyFromDay,
  executionsForAccount,
  isFundedPopulation,
  MIN_ACCOUNTS,
  MIN_DAYS,
  NOTE_NO_GATE,
} from '../domain/comboPerformance';
import BulletBotDeskPanel from './BulletBotDeskPanel';
import { buildRiskScalingCurve, estimateMaxSafeMultiplier, parseComboRisk } from '../domain/riskScaling';
import AccountHistoryChart from './AccountHistoryChart';
import AlgoContributionPanel from './AlgoContributionPanel';

const ALGO_STACKS = ['', 'URGO', 'IFSP', 'URGO + IFSP', 'URGO x2', 'IFSP x2', 'Custom'];
const DLL_OPTIONS = ['', 'None', '$300', '$400', '$500', '$600', '$700', '$800', '$1,000'];

const WINDOW_PRESETS = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
  ['all', 'All history'],
  ['custom', 'Custom range'],
];
const LEVELS = [['version', 'By version'], ['family', 'By family']];
const BASES = [['traded', 'Traded (enabled or filled)'], ['enabled', 'Enabled at export']];

// A trading month, for the income projection: 21 closes.
const CLOSES_PER_MONTH = 21;

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));
}
const signed = (n) => `${Number(n || 0) >= 0 ? '+' : ''}${fmt(n)}`;
const pct = (ratio) => (ratio == null ? 'n/a' : `${Math.round(ratio * 100)}%`);

function mergeRegCi(importAccounts, clientRegistry) {
  const merged = { ...(importAccounts || {}), ...(clientRegistry || {}) };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]));
}
function ciMeta(reg, name) { return reg[(name || '').toLowerCase()] || {}; }

// The combo an account ran on one close, keyed the way the team table keys it.
function comboOn(dailyImport, snapshot, keying) {
  if (!snapshot) return '-';
  return comboKeyFromDay(snapshot, executionsForAccount(dailyImport, snapshot.accountName), keying).key;
}

// Combo-change events for an account, aligned to its equity series index (same
// sorted-by-date, snapshot-present ordering as buildAccountEquitySeries), so the
// changes can be marked on the curve: did the change help?
function comboChangesFor(client, accountName, keying) {
  const lower = String(accountName || '').toLowerCase();
  const imports = [...(client?.dailyImports || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const points = [];
  for (const di of imports) {
    const snap = (di.snapshots || []).find((s) => s.accountName?.toLowerCase() === lower);
    if (!snap) continue;
    points.push({ date: di.date || '', combo: comboOn(di, snap, keying) });
  }
  const changes = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].combo !== points[i - 1].combo) {
      changes.push({ index: i, date: points[i].date, from: points[i - 1].combo || '-', to: points[i].combo || '-' });
    }
  }
  return changes;
}

// The aggregator this component used to own, kept under its old name and its
// old semantics (enabled at export, family keys, current-status population, all
// history, with the recent and prior N-day averages beside it) for
// StackPlaybook.test.js until that suite moves. Nothing on screen reads it.
export function buildAlgoComboPerformance(allClients = [], { windowDays = 7 } = {}) {
  const legacy = { basis: 'enabled', level: 'family', includeFailed: false };
  const all = buildComboPerformance(allClients, { ...legacy, window: { preset: 'all' } });
  if (!all.rows.length) return [];
  const { anchor } = all.window;
  const shift = (days) => {
    const ms = new Date(`${anchor}T00:00:00Z`).getTime() - days * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  };
  const recent = buildComboPerformance(allClients, { ...legacy, window: { preset: windowDays } });
  const prior = buildComboPerformance(allClients, { ...legacy, window: { from: shift(windowDays * 2 - 1), to: shift(windowDays) } });
  const rowIn = (perf, key) => perf.rows.find((row) => row.key === key) || null;
  return all.rows
    .map((row) => {
      const recentRow = rowIn(recent, row.key);
      const priorRow = rowIn(prior, row.key);
      const recentAvg = recentRow ? recentRow.avgPnl : null;
      const priorAvg = priorRow ? priorRow.avgPnl : null;
      let trend = 'stable';
      if (recentAvg !== null && priorAvg !== null) {
        const bar = 0.1 * Math.abs(priorAvg);
        if (recentAvg - priorAvg > bar) trend = 'up';
        else if (recentAvg - priorAvg < -bar) trend = 'down';
      }
      return {
        combo: row.key,
        avgPnl: row.avgPnl,
        winRate: row.days ? Math.round((row.winDays / row.days) * 100) : 0,
        totalDays: row.days,
        accounts: row.accounts,
        clients: row.clients,
        trend,
        recentAvg,
        priorAvg,
        recentDays: recentRow ? recentRow.days : 0,
      };
    })
    .sort((a, b) => b.avgPnl - a.avgPnl);
}

function TrendIcon({ trend }) {
  if (trend === 'up')   return <TrendingUp  size={14} className="positive" />;
  if (trend === 'down') return <TrendingDown size={14} className="negative" />;
  return <Minus size={14} className="muted" />;
}

// bookMonthly is what the selected window says a funded account makes in a
// month of closes. It is the starting value, and it keeps following the window
// until the user types a figure of their own; the old +$800 was a constant that
// the book has never once supported.
function IncomeProjection({ currentFunded, bookMonthly }) {
  const [typed, setTyped] = useState(null);
  const [targetMonthly, setTargetMonthly] = useState(10000);
  const avgPerAccount = typed ?? bookMonthly;
  const accountsNeeded = avgPerAccount > 0 ? Math.ceil(targetMonthly / avgPerAccount) : '-';
  const currentMonthly = currentFunded * avgPerAccount;
  const gap = targetMonthly - currentMonthly;
  return (
    <div className="income-projection">
      <div className="income-inputs">
        <div>
          <label>Assumed monthly P&amp;L per funded account (book: {fmt(bookMonthly)} per account over the selected window)</label>
          <input type="number" value={avgPerAccount} step={100} onChange={(e) => setTyped(Number(e.target.value))} />
        </div>
        <div>
          <label>Monthly income target</label>
          <input type="number" value={targetMonthly} min={1000} step={1000} onChange={(e) => setTargetMonthly(Number(e.target.value))} />
        </div>
      </div>
      <div className="income-results">
        <div className="income-result-card"><span>Accounts needed</span><strong>{accountsNeeded}</strong></div>
        <div className="income-result-card"><span>Funded accounts with data in range</span><strong>{currentFunded}</strong></div>
        <div className="income-result-card"><span>Projected monthly</span><strong className={currentMonthly >= targetMonthly ? 'positive' : ''}>{fmt(currentMonthly)}</strong></div>
        <div className="income-result-card">
          <span>{gap > 0 ? 'Gap to target' : 'Surplus'}</span>
          <strong className={gap <= 0 ? 'positive' : 'warning'}>{fmt(Math.abs(gap))}</strong>
        </div>
      </div>
      {avgPerAccount <= 0
        ? <p className="income-note muted">At {fmt(avgPerAccount)} per account per month no number of accounts reaches the target.</p>
        : gap > 0 && currentFunded > 0
          ? <p className="income-note muted">Need {accountsNeeded - currentFunded} more funded account{accountsNeeded - currentFunded !== 1 ? 's' : ''} to reach {fmt(targetMonthly)}/mo.</p>
          : gap <= 0 && currentFunded > 0
            ? <p className="income-note positive">On track: {currentFunded} funded accounts generating about {fmt(currentMonthly)}/mo.</p>
            : null}
    </div>
  );
}

export default function StackPlaybook({ client, dailyImport, onUpdateAccount, allClients = [], hiddenClientCount = 0, classifications = [], onClassify, logAlgoHistory = [] }) {
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
  const [classOpen, setClassOpen] = useState(false);
  const [bbOpen, setBbOpen] = useState(false);
  const [heatOpen, setHeatOpen] = useState(false);
  const [logHistOpen, setLogHistOpen] = useState(false);
  const [classDraft, setClassDraft] = useState({});
  // The team table's window, grouping and attribution. The window applies to
  // every column; the old select moved only the trend pair.
  const [windowPreset, setWindowPreset] = useState(30);
  const [windowFrom, setWindowFrom] = useState('');
  const [windowTo, setWindowTo] = useState('');
  const [level, setLevel] = useState('version');
  const [basis, setBasis] = useState('traded');
  const keying = { basis, level };

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
  const perf = buildComboPerformance(teamClients, {
    ...keying,
    window: windowPreset === 'custom'
      ? { preset: 'custom', from: windowFrom || null, to: windowTo || null }
      : { preset: windowPreset },
    hiddenClientCount,
  });
  const comboPerf = perf.rows;
  const clientInsights = buildClientComboInsights(client, dailyImport, perf, keying);
  const riskCurves = buildRiskScalingCurve(comboPerf.map((row) => ({ combo: row.key, avgPnl: row.avgPnl, winRate: Math.round((row.winRate ?? 0) * 100), accounts: row.accounts })));
  // Desk-wide, despite living in one client's tab: this card has always been fed
  // teamClients. It used to run buildBulletBotStats, which answered the same
  // question with different arithmetic — 236 accounts against 240, 22 passes
  // against 37, and a 9% rate whose denominator contained 86 accounts carrying
  // no profit target at all, so they could never satisfy balance >= target and
  // counted as failures. Two desk-wide Bullet Bot totals in one app is the
  // reason a manager stops trusting either. Same component, same numbers, both
  // places.
  const bbStats = buildBulletBotDeskStats(teamClients);
  const comboFirm = buildComboByFirm(teamClients, (snap, execs) => comboKeyFromDay(snap, execs, keying).key, {
    populationFilter: (meta) => isFundedPopulation(meta),
  });
  const logAlgoAgg = aggregateLogFamilyHistory(logAlgoHistory);
  const sigGroups = groupStrategiesBySignature(teamClients);
  const classByKey = Object.fromEntries(classifications.map((c) => [c.key, c]));
  const mismatches = detectVersionMismatches(teamClients, classifications);

  function saveClassification(group) {
    if (!onClassify) return;
    const existing = classByKey[group.key] || {};
    const draft = classDraft[group.key] || {};
    onClassify({
      key: group.key,
      family: group.family,
      signature: group.signature,
      version: draft.version ?? existing.version ?? '',
      riskLevel: draft.riskLevel ?? existing.riskLevel ?? '',
    });
  }

  const hasSuggestions = clientInsights.some((i) => i.suggestion);
  const { population, window: perfWindow } = perf;
  const bookMonthly = Math.round(population.avgPnlPerAccountDay * CLOSES_PER_MONTH);
  // Funded accounts of this client with at least one close inside the window:
  // the registry count included Reserve rows and accounts with no close at all.
  const fundedWithData = funded.filter((account) => {
    const name = String(account.accountName || '').toLowerCase();
    return (client?.dailyImports || []).some((di) => (
      di.date >= (perfWindow.from || '') && di.date <= (perfWindow.to || '') &&
      (di.snapshots || []).some((snap) => String(snap.accountName || '').toLowerCase() === name)
    ));
  });

  function selectWindow(value) {
    const preset = value === 'all' || value === 'custom' ? value : Number(value);
    if (preset === 'custom') {
      // Prefill with the range the current preset resolves to, clamped to the
      // closes the book actually holds.
      setWindowFrom(perfWindow.from > perfWindow.firstClose ? perfWindow.from : perfWindow.firstClose);
      setWindowTo(perfWindow.to || perfWindow.lastClose);
    }
    setWindowPreset(preset);
  }

  return (
    <div className="stack-playbook">

      {/* ── Account history ────────────────────────────────── */}
      {chartAccounts.length ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setHistoryOpen((v) => !v)}>
            <ChevronDown className={historyOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Account history</h3>
            <span className="muted">Equity curve + trailing over every close</span>
            <span className="count">{chartAccounts.length}</span>
          </button>
          {historyOpen ? (
            <div className="ahc-list">
              {chartAccounts.map((account) => {
                const series = buildAccountEquitySeries(client, account.accountName);
                const ddLimit = Number(account.maxDrawdownLimit || 0);
                const snap = snapshots.find((s) => s.accountName?.toLowerCase() === account.accountName.toLowerCase());
                const mult = parseComboRisk(comboOn(dailyImport, snap, keying)).multiplier;
                const last = series[series.length - 1];
                const buffer = last ? (ddLimit > 0 ? ddLimit - Math.abs(last.trailing) : last.trailing) : 0;
                const safe = estimateMaxSafeMultiplier(series, buffer, mult);
                const stratVersions = (snap?.strategies || [])
                  .filter((st) => st.enabled)
                  .map((st) => {
                    const c = classifyStrategy(st, classifications);
                    return c.matched ? `${st.strategyFamily} ${c.version}` : `${st.strategyFamily || st.strategyName || 'Algo'}?`;
                  });
                const lc = buildAccountLifecycle(account, { asOf: last?.date || dailyImport?.date || '' });
                return (
                  <div className="ahc-account" key={account.accountName}>
                    <div className="ahc-account-head">
                      <strong>{account.alias || account.accountName}</strong>
                      <small className="muted">{account.accountType}{account.connection ? ` · ${account.connection}` : ''}</small>
                      {stratVersions.length ? <small className="muted">{stratVersions.join(' · ')}</small> : null}
                      {safe ? (
                        <small className={safe.safeLevel < mult ? 'negative' : 'muted'}>
                          trailing supports ~{safe.safeLevel}x{mult ? ` (running ${mult}x)` : ''}
                        </small>
                      ) : null}
                      <small
                        className={lc.outcome === 'funded' ? 'positive' : lc.outcome === 'failed' ? 'negative' : 'muted'}
                        title={lc.phases.map((p) => `${p.algo}: ${p.days ?? '?'}d`).join(' -> ')}
                      >
                        {lc.outcome}{lc.daysAlive != null ? ` · ${lc.daysAlive}d alive` : ''}{lc.phases.length > 1 ? ` · ${lc.phases.length} algo phases` : ''}
                      </small>
                    </div>
                    <AccountHistoryChart series={series} ddLimit={ddLimit} alias={account.alias || account.accountName} comboChanges={comboChangesFor(client, account.accountName, keying)} />
                    <AlgoContributionPanel client={client} accountName={account.accountName} />
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

      {/* ── Strategy classification ────────────────────────── */}
      {sigGroups.length ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setClassOpen((v) => !v)}>
            <ChevronDown className={classOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Strategy classification</h3>
            <span className="muted">Assign a version + risk to each parameter signature</span>
            <span className="count">{sigGroups.length}</span>
          </button>
          {classOpen ? (
            <div className="strat-class-list">
              {mismatches.length ? (
                <div className="notice warning">
                  <AlertTriangle size={14} /> Version drift: {mismatches.map((m) => `${m.family} (${m.variantCount})`).join(', ')} — more than one parameter signature running for the same algo.
                </div>
              ) : null}
              <div className="table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Algo</th>
                      <th>Instruments</th>
                      <th>Usage</th>
                      <th>Name ver.</th>
                      <th>Version</th>
                      <th>Risk</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sigGroups.map((g) => {
                      const cls = classByKey[g.key] || {};
                      const draft = classDraft[g.key] || {};
                      const versionVal = draft.version ?? cls.version ?? '';
                      const riskVal = draft.riskLevel ?? cls.riskLevel ?? '';
                      const dirty =
                        (draft.version !== undefined && draft.version !== (cls.version || '')) ||
                        (draft.riskLevel !== undefined && draft.riskLevel !== (cls.riskLevel || ''));
                      return (
                        <tr key={g.key} className={cls.version ? 'row-highlight' : ''}>
                          <td><strong>{g.family}</strong></td>
                          <td className="muted">{g.instruments.join(', ') || '-'}</td>
                          <td className="muted">{g.accountCount} acct · {g.clientCount} cl</td>
                          <td className="muted">{g.nameVersions.join(', ') || '-'}</td>
                          <td>
                            <input
                              type="text"
                              placeholder="e.g. v1"
                              value={versionVal}
                              style={{ width: 72 }}
                              onChange={(e) => setClassDraft((d) => ({ ...d, [g.key]: { ...d[g.key], version: e.target.value } }))}
                            />
                          </td>
                          <td>
                            <select
                              value={riskVal}
                              onChange={(e) => setClassDraft((d) => ({ ...d, [g.key]: { ...d[g.key], riskLevel: e.target.value } }))}
                            >
                              {['', ...RISK_LEVELS].map((r) => <option key={r} value={r}>{r || '-'}</option>)}
                            </select>
                          </td>
                          <td>
                            <button className="ghost-button" disabled={!dirty || !onClassify} onClick={() => saveClassification(g)}>Save</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: 12, padding: '4px 0 0' }}>
                Accounts running the same algo with the same parameters share a signature. Select the version you run — the biggest pools sort first. Risk is set per version and replaces the old inference.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Bullet Bot ─────────────────────────────────────── */}
      {bbStats.cohort.accounts ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setBbOpen((v) => !v)}>
            <ChevronDown className={bbOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Bullet Bot</h3>
            <span className="muted">Whole desk · pass rate and days-to-pass by direction</span>
            <span className="count">{bbStats.cohort.accounts}</span>
          </button>
          {bbOpen ? <BulletBotDeskPanel clients={teamClients} /> : null}
        </section>
      ) : null}

      {/* ── Combo × Prop firm heatmap (B5) ─────────────────── */}
      {comboFirm.combos.length && comboFirm.firms.length > 1 ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setHeatOpen((v) => !v)}>
            <ChevronDown className={heatOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Combo × Prop firm</h3>
            <span className="muted">Avg P&amp;L per account day by combo and prop firm, same population as the table above</span>
          </button>
          {heatOpen ? (() => {
            const maxAbs = Math.max(1, ...comboFirm.matrix.flatMap((r) => r.cells.map((c) => Math.abs(c.avgPnl || 0))));
            return (
              <div className="table-wrap">
                <table className="ops-table heatmap-table">
                  <thead>
                    <tr>
                      <th>Combo</th>
                      {comboFirm.firms.map((f) => <th key={f}>{f}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {comboFirm.matrix.map((row) => (
                      <tr key={row.combo}>
                        <td><strong>{row.combo}</strong></td>
                        {row.cells.map((c) => {
                          if (c.avgPnl == null) return <td key={c.firm} className="muted">-</td>;
                          const alpha = 0.15 + 0.55 * (Math.abs(c.avgPnl) / maxAbs);
                          const bg = c.avgPnl >= 0 ? `rgba(var(--success-rgb), ${alpha})` : `rgba(var(--error-rgb), ${alpha})`;
                          return (
                            <td key={c.firm} style={{ background: bg }} title={`${c.days} account days`}>
                              {c.avgPnl >= 0 ? '+' : ''}{fmt(c.avgPnl)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })() : null}
        </section>
      ) : null}

      {/* ── Algo history from logs (team-wide, dead accounts incl.) ── */}
      {logAlgoAgg.length ? (
        <section className="panel">
          <button className="registry-toggle" onClick={() => setLogHistOpen((v) => !v)}>
            <ChevronDown className={logHistOpen ? 'chevron open' : 'chevron'} size={16} />
            <h3>Algo history (from logs)</h3>
            <span className="muted">Team-wide realized PnL by algo + direction, incl. accounts no longer active</span>
          </button>
          {logHistOpen ? (
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Algo</th>
                    <th>Realized</th>
                    <th>Long</th>
                    <th>Short</th>
                    <th>Accounts</th>
                    <th>Days</th>
                    <th>Round trips</th>
                  </tr>
                </thead>
                <tbody>
                  {logAlgoAgg.map((row) => (
                    <tr key={row.family}>
                      <td><strong>{row.family}</strong></td>
                      <td className={row.totalPnl >= 0 ? 'positive' : 'negative'}>{row.totalPnl >= 0 ? '+' : ''}{fmt(row.totalPnl)}</td>
                      <td className={row.byDirection.Long >= 0 ? 'positive' : 'negative'}>{fmt(row.byDirection.Long)}</td>
                      <td className={row.byDirection.Short >= 0 ? 'positive' : 'negative'}>{fmt(row.byDirection.Short)}</td>
                      <td className="muted">{row.accounts}</td>
                      <td className="muted">{row.days}</td>
                      <td className="muted">{row.roundTrips}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 12, padding: '4px 0 0' }}>
                Derived from NinjaTrader logs (executions x contract value) — realized PnL only, no balances. Includes accounts that no longer exist; no client assignment needed. Upload logs in Data Tools to grow it.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Team Intel ─────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-heading playbook-heading">
          <h3>Team Algo Performance</h3>
          <span className="badge muted">{comboPerf.length} combos · {population.accounts} accounts · {population.clients} clients</span>
          <select
            className="window-select"
            value={String(windowPreset)}
            onChange={(e) => selectWindow(e.target.value)}
            title="Applies to every column in this panel"
            aria-label="Window"
          >
            {WINDOW_PRESETS.map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
          </select>
          {windowPreset === 'custom' ? (
            <span className="playbook-range">
              <input
                type="date"
                aria-label="From"
                value={windowFrom}
                min={perfWindow.firstClose}
                max={windowTo || perfWindow.lastClose}
                onChange={(e) => setWindowFrom(e.target.value)}
              />
              <span className="muted">to</span>
              <input
                type="date"
                aria-label="To"
                value={windowTo}
                min={windowFrom || perfWindow.firstClose}
                max={perfWindow.lastClose}
                onChange={(e) => setWindowTo(e.target.value)}
              />
            </span>
          ) : null}
          <span className="playbook-toggles">
            <span className="muted">Grouping</span>
            {LEVELS.map(([value, label]) => (
              <button key={value} type="button" className="ghost-button" aria-pressed={level === value} onClick={() => setLevel(value)}>{label}</button>
            ))}
            <span className="muted">Attribution</span>
            {BASES.map(([value, label]) => (
              <button key={value} type="button" className="ghost-button" aria-pressed={basis === value} onClick={() => setBasis(value)}>{label}</button>
            ))}
          </span>
        </div>
        <p className="muted playbook-basis" style={{ fontSize: 13, marginBottom: 8 }}>
          Client account results while the combo was running. Not the algorithm's own track record. Not comparable to My Futures Book.
        </p>
        {comboPerf.length === 0 ? (
          <p className="muted" style={{ padding: '12px 0' }}>No funded account day in this window carries an attributable algo. Widen the window or upload daily closes to populate.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              <Info size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Client account results while the combo was running. {population.includedDays} of {population.fundedDays} funded account days in range; {population.unknownDays} days with no algo attributable ({fmt(population.unknownPnl)}); {population.failedAccountDays} days from accounts now marked Failed are included; {population.hiddenClients} inactive clients are not loaded. P&amp;L is realized net of commission where the grid reported it, gross otherwise. One account day is one observation, unweighted. Not the algorithm's own track record. Not comparable to My Futures Book.
            </p>
            {(() => {
              const gated = comboPerf.filter((row) => !row.lowSample).slice(0, 8);
              if (!gated.length) return null;
              const maxAbs = Math.max(...gated.map((c) => Math.abs(c.avgPnl)), 1);
              return (
                <div className="combo-bars">
                  {gated.map((row) => (
                    <div className="combo-bar-row" key={row.key}>
                      <span className="combo-bar-label" title={row.key}>{row.key}</span>
                      <div className="combo-bar-track">
                        <i style={{ width: `${(Math.abs(row.avgPnl) / maxAbs) * 100}%`, background: row.avgPnl >= 0 ? 'var(--success)' : 'var(--error)' }} />
                      </div>
                      <span className={row.avgPnl >= 0 ? 'positive' : 'negative'}>{signed(row.avgPnl)}</span>
                      <span className="muted">{pct(row.winRate)} win</span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {perf.best ? null : (
              <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                No combo passes the sample gate ({MIN_DAYS} account days and {MIN_ACCOUNTS} accounts)
                {comboPerf.some((row) => !row.lowSample) ? ' with a positive average, so no row is marked Best.' : '.'}
              </p>
            )}
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th title="Algorithm families and versions attributed to the account day">Combo</th>
                    <th title="First and last close with this combo inside the selected window">Range</th>
                    <th title="Number of account days, one per funded account per close">Account days</th>
                    <th title="Account days with nonzero P&L">Traded days</th>
                    <th title="Distinct funded accounts with at least one day on this combo in range">Accounts</th>
                    <th title="Distinct clients with at least one such account">Clients</th>
                    <th title="Total P&L divided by account days. Realized net of commission where reported, gross otherwise. Unweighted.">Avg P&amp;L per account day</th>
                    <th title="Total P&L divided by traded days">Avg P&amp;L per traded day</th>
                    <th title="Share of traded days with positive P&L; flat days excluded">Win rate on traded days</th>
                    <th title="Account days with zero P&L">Flat days</th>
                    <th title="First half of the window vs second half, at least 5 account days each; otherwise n/a">Trend in window</th>
                    <th title={`OK, or Low sample when under ${MIN_DAYS} account days or ${MIN_ACCOUNTS} accounts`}>Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {comboPerf.map((row) => (
                    <tr key={row.key} className={row === perf.best ? 'row-highlight' : row.lowSample ? 'row-muted' : ''}>
                      <td className="playbook-combo-cell">
                        <strong>{row.key}</strong>
                        {row === perf.best ? <span className="badge success" style={{ marginLeft: 6 }}>Best</span> : null}
                        {row.lowSample ? <span className="badge muted" style={{ marginLeft: 6 }}>Low sample</span> : null}
                      </td>
                      <td className="muted playbook-range-cell">{row.firstDate} to {row.lastDate}</td>
                      <td>{row.days}</td>
                      <td>{row.tradedDays}</td>
                      <td>{row.accounts}</td>
                      <td>{row.clients}</td>
                      <td className={row.avgPnl >= 0 ? 'positive' : 'negative'}>{signed(row.avgPnl)}</td>
                      <td className={row.avgTradedPnl == null ? 'muted' : row.avgTradedPnl >= 0 ? 'positive' : 'negative'}>
                        {row.avgTradedPnl == null ? 'n/a' : signed(row.avgTradedPnl)}
                      </td>
                      <td>{pct(row.winRate)}</td>
                      <td className="muted">{row.flatDays}</td>
                      <td style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <TrendIcon trend={row.trend} />
                        <span className={row.trend === 'up' ? 'positive' : row.trend === 'down' ? 'negative' : 'muted'}>
                          {row.trend}
                        </span>
                      </td>
                      <td className={row.lowSample ? 'muted' : ''}>{row.lowSample ? 'Low sample' : 'OK'}</td>
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
              ? <span className="badge warning"><AlertTriangle size={12} /> Suggestions available</span>
              : <span className="badge muted">No suggestion passes the gate</span>}
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Combo on this close</th>
                  <th>This account on this combo, avg per account day</th>
                  <th>Team on this combo, avg per account day</th>
                  <th>Difference</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {clientInsights.map((row) => (
                  <tr key={row.accountName}>
                    <td><strong>{row.alias}</strong></td>
                    <td><span className="badge muted">{row.currentKey}</span></td>
                    <td className={row.accountAvg == null ? 'muted' : row.accountAvg >= 0 ? 'positive' : 'negative'}>
                      {row.accountAvg == null ? 'n/a' : signed(row.accountAvg)}
                      <small className="muted" style={{ display: 'block' }}>{row.accountDaysOnCombo} of {row.accountDaysTotal} days in range</small>
                    </td>
                    <td className="muted">
                      {row.teamAvg == null ? 'n/a' : signed(row.teamAvg)}
                      {row.teamRow ? <small className="muted" style={{ display: 'block' }}>{row.teamRow.days} account days, {row.teamRow.accounts} accounts</small> : null}
                    </td>
                    <td className={row.delta == null ? 'muted' : row.delta >= 0 ? 'positive' : 'negative'}>
                      {row.delta == null ? 'n/a' : signed(row.delta)}
                    </td>
                    <td>
                      {row.suggestion ? (
                        <span className="playbook-suggestion">
                          <ArrowRight size={12} />
                          Consider <strong>{row.best.key}</strong>: team avg {fmt(row.best.avgPnl)} per account day over {row.best.days} days on {row.best.accounts} accounts
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>{row.note || NOTE_NO_GATE}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, padding: '8px 0 0' }}>
            Team figures are client account results, not the algorithm's own track record.
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
                  <th>Trailing</th>
                  <th>Assign algo stack</th>
                  <th>Change note</th>
                  <th>Daily Loss Limit</th>
                </tr>
              </thead>
              <tbody>
                {funded.map((account) => {
                  const snap = snapshots.find((s) => s.accountName?.toLowerCase() === account.accountName?.toLowerCase());
                  const liveCombo = comboOn(dailyImport, snap, keying);
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
        <IncomeProjection currentFunded={fundedWithData.length} bookMonthly={bookMonthly} />
      </section>

    </div>
  );
}
