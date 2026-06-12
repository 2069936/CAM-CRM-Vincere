import { Fragment, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Lock,
  Plus,
  Upload,
  Users,
} from 'lucide-react';
import AccountManager from './components/AccountManager';
import Dashboard from './components/Dashboard';
import UploadArea from './components/UploadArea';
import {
  addClient,
  addCamProfile,
  appendDailyImport,
  createDemoState,
  exportFileName,
  getClientImportByDate,
  loadDemoState,
  parseImportedState,
  replaceDailyImport,
  saveDemoState,
  selectClient,
  todayIsoDate,
  updateClientDetails,
  updateImportStatus,
  upsertAccountMeta,
} from './domain/demoStore';
import { buildCamOverview } from './domain/camOverview';
import { recalculateDailyImport, reconcileDailyImport } from './domain/reconcile';
import { buildDailyReportSummary, formatCurrency } from './domain/report';

const STATIC_TABS = ['Credentials & Notes', 'Price Checks'];

function deriveClientBadge(client) {
  const latest = client.dailyImports.at(-1);
  if (!latest) return { label: 'No data', tone: 'muted' };
  const critical = latest.flags.filter((flag) => flag.severity === 'Critical').length;
  if (critical) return { label: `${critical} critical`, tone: 'danger' };
  const open = latest.flags.length;
  if (open) return { label: `${open} flags`, tone: 'warning' };
  return { label: latest.status || 'Ready', tone: 'success' };
}

function filteredAccountsForTab(client, dailyImport, tab) {
  const accounts = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const snapshots = dailyImport?.snapshots || [];
  const entries = Object.fromEntries(Object.entries(accounts).filter(([, account]) => {
    if (tab === 'Review') return account.accountType === 'Unassigned' || account.accountType === 'Inactive / Ignore';
    if (tab === 'Evaluations') return account.accountType?.startsWith('Evaluation');
    if (tab === 'Funded') return account.accountType === 'Funded';
    if (tab === 'Cash') return account.accountType === 'Cash';
    return true;
  }));
  return {
    accounts: entries,
    snapshots: snapshots
      .filter((snapshot) => entries[snapshot.accountName])
      .map((snapshot) => ({ ...snapshot, meta: entries[snapshot.accountName] || {} })),
  };
}

function buildVisibleTabs(client, dailyImport) {
  const accounts = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const values = Object.values(accounts);
  const tabs = [];
  if (values.some((account) => account.accountType === 'Unassigned' || account.accountType === 'Inactive / Ignore')) tabs.push('Review');
  if (values.some((account) => account.accountType?.startsWith('Evaluation'))) tabs.push('Evaluations');
  if (values.some((account) => account.accountType === 'Funded')) tabs.push('Funded');
  if (values.some((account) => account.accountType === 'Cash')) tabs.push('Cash');
  return [...tabs, ...STATIC_TABS];
}

function tabMode(tab) {
  if (tab === 'Cash') return 'cash';
  if (tab === 'Review') return 'review';
  return 'standard';
}

function latestImports(clients = []) {
  return clients.map((client) => ({
    client,
    dailyImport: client.dailyImports?.at(-1) || null,
  }));
}

function buildManagerSummary(clients = []) {
  const imports = latestImports(clients);
  const snapshots = imports.flatMap(({ dailyImport }) => dailyImport?.snapshots || []);
  const openFlags = imports.flatMap(({ dailyImport }) => dailyImport?.flags || []);
  const activeStrategies = snapshots.flatMap((snapshot) => snapshot.strategies || []).filter((strategy) => strategy.enabled);
  const weeklyPnl = snapshots.reduce((total, snapshot) => total + Number(snapshot.weeklyPnl || 0), 0);
  const dailyPnl = snapshots.reduce((total, snapshot) => total + Number(snapshot.grossRealizedPnl || 0), 0);

  return {
    clients: clients.length,
    accounts: snapshots.length,
    algorithms: new Set(activeStrategies.map((strategy) => `${strategy.strategyFamily || strategy.strategyName}-${strategy.strategyVersion || ''}`)).size,
    dailyPnl,
    weeklyPnl,
    openFlags: openFlags.length,
  };
}

function buildTeamHistory(clients = []) {
  const byDate = new Map();
  for (const client of clients) {
    for (const dailyImport of client.dailyImports || []) {
      const existing = byDate.get(dailyImport.date) || { date: dailyImport.date, dailyPnl: 0, weeklyPnl: 0, accounts: 0 };
      for (const snapshot of dailyImport.snapshots || []) {
        existing.dailyPnl += Number(snapshot.grossRealizedPnl || 0);
        existing.weeklyPnl += Number(snapshot.weeklyPnl || 0);
        existing.accounts += 1;
      }
      byDate.set(dailyImport.date, existing);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('manager');
  const [password, setPassword] = useState('demo');

  function submit(event) {
    event.preventDefault();
    onLogin({ username, role: username.toLowerCase().includes('cam') ? 'CAM' : 'Manager' });
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <span className="eyebrow">Vincere Trading</span>
        <h1>Client Account Manager CRM</h1>
        <p>Demo access layer for manager and CAM workspaces.</p>
        <form onSubmit={submit} className="login-form">
          <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary-button">Sign in</button>
        </form>
        <small>Demo only: any username/password continues. Use "manager" to start at the executive overview.</small>
      </section>
    </main>
  );
}

function ManagerOverview({ clients, camProfiles = [], onOpenCam, onLoadDemo, onCreateCam }) {
  const [newCamName, setNewCamName] = useState('');
  const liveSummary = buildManagerSummary(clients);
  const teamHistory = buildTeamHistory(clients);
  const cams = (camProfiles.length ? camProfiles : createDemoState().camProfiles).map((profile) => (
    profile.live
      ? { ...profile, role: 'Live CAM', clients: liveSummary.clients, accounts: liveSummary.accounts, weeklyPnl: liveSummary.weeklyPnl, dailyPnl: liveSummary.dailyPnl, flags: liveSummary.openFlags }
      : profile
  ));
  const totals = cams.reduce((acc, cam) => ({
    clients: acc.clients + cam.clients,
    accounts: acc.accounts + cam.accounts,
    weeklyPnl: acc.weeklyPnl + cam.weeklyPnl,
    dailyPnl: acc.dailyPnl + cam.dailyPnl,
    flags: acc.flags + cam.flags,
  }), { clients: 0, accounts: 0, weeklyPnl: 0, dailyPnl: 0, flags: 0 });

  function submitCam(event) {
    event.preventDefault();
    onCreateCam(newCamName);
    setNewCamName('');
  }

  return (
    <main className="manager-shell">
      <aside className="manager-sidebar">
        <span className="eyebrow">Platform</span>
        <strong>Vincere CRM</strong>
        <button className="client-link active"><Users size={16} /><span>Manager Overview</span><em>Demo</em></button>
        <button className="client-link" onClick={onOpenCam}><BarChart3 size={16} /><span>Pedro CAM</span><em>Live</em></button>
      </aside>
      <section className="content">
        <div className="page-header">
          <div>
            <span className="eyebrow">Manager overview</span>
            <h1>Operations Command Center</h1>
            <p>Team-level analytics adapted from the master spreadsheet: accounts, strategy performance, lifecycle and flags.</p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={onLoadDemo}><Download size={16} /> Reload Demo Data</button>
            <button className="primary-button" onClick={onOpenCam}><BarChart3 size={16} /> Open Pedro Workspace</button>
          </div>
        </div>

        <div className="metric-grid">
          <div className="metric"><span>CAMs</span><strong>{cams.length}</strong></div>
          <div className="metric"><span>Clients</span><strong>{totals.clients}</strong></div>
          <div className="metric"><span>Accounts</span><strong>{totals.accounts}</strong></div>
          <div className="metric"><span>Open flags</span><strong>{totals.flags}</strong></div>
        </div>

        <div className="metric-grid">
          <div className="metric"><span>Team daily PnL</span><strong className={totals.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(totals.dailyPnl)}</strong></div>
          <div className="metric"><span>Team weekly PnL</span><strong className={totals.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(totals.weeklyPnl)}</strong></div>
          <div className="metric"><span>Running algorithms</span><strong>{Math.max(liveSummary.algorithms, 8)}</strong></div>
          <div className="metric"><span>Excel analytics</span><strong>Mapped</strong></div>
        </div>

        <section className="panel">
          <div className="panel-heading">
            <h3>Client account managers</h3>
            <form className="inline-create-form" onSubmit={submitCam}>
              <input value={newCamName} placeholder="New CAM name" onChange={(event) => setNewCamName(event.target.value)} />
              <button className="secondary-button"><Plus size={14} /> Create CAM</button>
            </form>
          </div>
          <div className="cam-card-grid">
            {cams.map((cam) => (
              <button className={cam.live ? 'cam-card live' : 'cam-card'} key={cam.name} onClick={cam.live ? onOpenCam : undefined}>
                <strong>{cam.name}</strong>
                <span>{cam.role} · {cam.status || 'Active'}</span>
                <small>{cam.clients} clients · {cam.accounts} accounts · {cam.flags} flags</small>
                <em className={cam.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.weeklyPnl)} weekly</em>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><h3>7-day trading backlog</h3><span className="badge muted">Historical closes</span></div>
          <div className="history-strip">
            {teamHistory.map((day) => (
              <div className="history-day" key={day.date}>
                <span>{day.date.slice(5)}</span>
                <strong className={day.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(day.dailyPnl)}</strong>
                <small>{day.accounts} accounts · weekly {formatCurrency(day.weeklyPnl)}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="overview-grid">
          <div className="panel">
            <div className="panel-heading"><h3>Strategy analyzer</h3><span className="count">Score 0-10</span></div>
            <div className="strategy-rank-list">
              {[
                ['RBO_PF', 8.7, 1240],
                ['IFSP', 7.9, 980],
                ['OGX_PF', 6.8, 420],
                ['Bullet Bot', 5.9, 0],
              ].map(([name, score, weekly]) => (
                <div className="rank-row" key={name}>
                  <strong>{name}</strong>
                  <span>{score}/10</span>
                  <em className={weekly >= 0 ? 'positive' : 'negative'}>{formatCurrency(weekly)}</em>
                </div>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-heading"><h3>Lifecycle metrics</h3><span className="badge muted">From Excel model</span></div>
            <div className="lifecycle-grid">
              <div><span>Total evaluations</span><strong>128</strong></div>
              <div><span>Avg days to fail</span><strong>5.4</strong></div>
              <div><span>Avg days to funded</span><strong>12.1</strong></div>
              <div><span>Avg days to payout</span><strong>18.7</strong></div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><h3>Exception logic</h3><span className="badge muted">Explainable flags</span></div>
          <div className="exception-grid">
            <div className="exception-card critical">
              <strong>Payout hold violation</strong>
              <span>Triggered when account status is `Payout Hold` and the latest close still has one or more enabled strategies.</span>
              <small>Formula: payout_hold && enabled_strategies &gt; 0</small>
            </div>
            <div className="exception-card critical">
              <strong>Unexpected strategy active</strong>
              <span>Triggered when an inactive, reserve, or failed account is still running an enabled strategy.</span>
              <small>Formula: status in [Inactive, Reserve, Failed] && enabled_strategies &gt; 0</small>
            </div>
            <div className="exception-card warning">
              <strong>Unassigned account</strong>
              <span>Triggered when a new imported account has not been manually classified as Evaluation, Funded, Cash, Bullet Bot, or Ignore.</span>
              <small>Formula: account_type = Unassigned</small>
            </div>
            <div className="exception-card warning">
              <strong>Strategy deviation</strong>
              <span>Triggered when an algorithm instance performs materially worse than peers running the same family/version.</span>
              <small>Formula: realized_pnl &lt; peer_mean - 1.5 * peer_stdev</small>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function ReportPanel({ client, dailyImport, onClose }) {
  const report = buildDailyReportSummary(client, dailyImport);
  return (
    <div className="report-overlay">
      <div className="report-sheet">
        <div className="report-actions no-print">
          <button className="secondary-button" onClick={() => window.print()}>Print / Save PDF</button>
          <button className="ghost-button" onClick={onClose}>Close</button>
        </div>
        <header className="report-header">
          <div>
            <p>Vincere Trading</p>
            <h1>{report.clientName}</h1>
            <span>Daily close report · {report.date}</span>
          </div>
          <strong>{report.status}</strong>
        </header>
        <section className="report-metrics">
          <div><span>Accounts</span><strong>{report.counts.accounts}</strong></div>
          <div><span>Daily/Gross PnL</span><strong>{formatCurrency(report.totals.grossRealizedPnl)}</strong></div>
          <div><span>Weekly PnL</span><strong>{formatCurrency(report.totals.weeklyPnl)}</strong></div>
        </section>
        {['evaluations', 'funded', 'cash'].map((group) => report.grouped[group].length ? (
          <section className="report-section" key={group}>
            <h2>{group === 'cash' ? 'Cash Accounts' : group}</h2>
            <div className={group === 'cash' ? 'report-row report-row-head cash' : 'report-row report-row-head'}>
              <strong>Account</strong>
              <span>Status</span>
              <span>Daily PnL</span>
              {group === 'cash' ? <span>Cash balance</span> : null}
            </div>
            {report.grouped[group].map((row) => (
              <div className={group === 'cash' ? 'report-row cash' : 'report-row'} key={row.accountName}>
                <strong>{row.meta?.alias || row.accountName}</strong>
                <span>{row.meta?.status || 'Active'}</span>
                <span>{formatCurrency(row.grossRealizedPnl)}</span>
                {group === 'cash' ? <span>{formatCurrency(row.accountBalance)}</span> : null}
              </div>
            ))}
          </section>
        ) : null)}
      </div>
    </div>
  );
}

function CamOverview({ clients, strategySetRecords = [], strategySetIndexStatus }) {
  const [expandedAlgorithm, setExpandedAlgorithm] = useState('');
  const overview = buildCamOverview(clients, strategySetRecords);

  return (
    <main className="content">
      <div className="page-header">
        <div>
          <span className="eyebrow">Account manager overview</span>
          <h1>CAM Overview</h1>
          <p>Algorithm performance across Pedro's latest client closes.</p>
        </div>
      </div>
      <div className="metric-grid">
        <div className="metric"><span>Clients</span><strong>{clients.length}</strong></div>
        <div className="metric"><span>Algorithms</span><strong>{overview.totals.algorithms}</strong></div>
        <div className="metric"><span>Accounts running</span><strong>{overview.totals.accounts}</strong></div>
        <div className="metric"><span>Deviation alerts</span><strong>{overview.totals.openDeviationFlags}</strong></div>
      </div>

      <section className="panel compact-panel">
        <div className="panel-heading">
          <h3>XML strategy index</h3>
          <span className={strategySetRecords.length ? 'badge success' : 'badge muted'}>
            {strategySetRecords.length ? `${strategySetRecords.length} set files` : strategySetIndexStatus}
          </span>
        </div>
        <p className="muted">Risk, period, pass type, and set version are matched locally from the generated XML index when signatures are unique.</p>
      </section>

      <section className={overview.deviationFlags.length ? 'panel danger-panel' : 'panel'}>
        <div className="panel-heading"><h3>Deviation alerts</h3><span className="count">{overview.deviationFlags.length}</span></div>
        {overview.deviationFlags.length ? (
          <div className="flag-list">
            {overview.deviationFlags.map((flag) => (
              <div className="flag warning" key={flag.id}>
                <AlertTriangle size={16} />
                <div>
                  <strong>{flag.algorithm}</strong>
                  <span>{flag.message} Daily realized: {formatCurrency(flag.realized)}.</span>
                </div>
              </div>
            ))}
          </div>
        ) : <div className="notice success"><CheckCircle2 size={16} /> No cross-account deviation alerts.</div>}
      </section>

      <section className="panel">
        <div className="panel-heading"><h3>Algorithm rollup</h3><span className="count">{overview.algorithms.length}</span></div>
        {overview.algorithms.length ? (
          <div className="table-wrap">
            <table className="ops-table cam-overview-table">
              <thead>
                <tr>
                  <th>Algorithm</th>
                  <th>Version</th>
                  <th>Accounts</th>
                  <th>Instances</th>
                  <th>Avg daily</th>
                  <th>Avg account weekly</th>
                  <th>Total daily</th>
                </tr>
              </thead>
              <tbody>
                {overview.algorithms.map((algorithm) => (
                  <Fragment key={algorithm.key}>
                    <tr
                      className="clickable-row"
                      onClick={() => setExpandedAlgorithm((current) => (current === algorithm.key ? '' : algorithm.key))}
                    >
                      <td><strong><ChevronDown className={expandedAlgorithm === algorithm.key ? 'chevron open' : 'chevron'} size={14} /> {algorithm.algorithm}</strong></td>
                      <td>{algorithm.version || 'Custom'}</td>
                      <td>{algorithm.accounts}</td>
                      <td>{algorithm.instances}</td>
                      <td className={algorithm.avgRealized >= 0 ? 'positive' : 'negative'}>{formatCurrency(algorithm.avgRealized)}</td>
                      <td className={algorithm.avgAccountWeeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(algorithm.avgAccountWeeklyPnl)}</td>
                      <td className={algorithm.totalRealized >= 0 ? 'positive' : 'negative'}>{formatCurrency(algorithm.totalRealized)}</td>
                    </tr>
                    {expandedAlgorithm === algorithm.key ? (
                      <tr className="account-detail-row">
                        <td colSpan="7">
                          <div className="cam-instance-list">
                            {algorithm.items.map((item) => (
                              <div className="cam-instance" key={`${item.clientId}-${item.accountName}-${item.strategyName}`}>
                                <strong>{item.clientName} · {item.accountAlias}</strong>
                                <span>{item.strategyName || algorithm.algorithm} · {item.enabled ? 'Enabled' : 'Disabled'}</span>
                                {item.configMatch?.matched ? (
                                  <span>{[item.configMatch.risk, item.configMatch.setVersion, item.configMatch.period ? `Period ${item.configMatch.period}` : '', item.configMatch.passType].filter(Boolean).join(' · ')}</span>
                                ) : <span>{item.configMatch?.reason || 'XML config unknown'}</span>}
                                <span className={item.realized >= 0 ? 'positive' : 'negative'}>Daily realized {formatCurrency(item.realized)}</span>
                                <span className={item.accountWeeklyPnl >= 0 ? 'positive' : 'negative'}>Account weekly {formatCurrency(item.accountWeeklyPnl)}</span>
                                <MovementSparkline points={item.executionPoints || []} />
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state compact">
            <BarChart3 size={24} />
            <h3>No algorithms yet</h3>
            <p>Upload daily files for at least one client to populate this overview.</p>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading"><h3>Team preview</h3><span className="badge muted">Mock</span></div>
        <div className="team-grid">
          {['Amanda', 'Josh', 'Camila'].map((name, index) => (
            <div className="team-card" key={name}>
              <strong>{name}</strong>
              <span>Mock account manager</span>
              <small>{index + 2} clients · {index} flags</small>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function MovementSparkline({ points = [] }) {
  const prices = points.map((point) => Number(point.price || 0)).filter((value) => Number.isFinite(value) && value > 0);
  if (!prices.length) return <small className="muted">No execution movement for this strategy.</small>;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = max - min || 1;
  const polyline = prices.map((price, index) => {
    const x = prices.length === 1 ? 100 : (index / (prices.length - 1)) * 180;
    const y = 42 - ((price - min) / spread) * 34;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className="movement-card">
      <svg viewBox="0 0 180 50" role="img" aria-label="Strategy execution price movement">
        <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <small>{prices.length} executions · {prices[0].toLocaleString('en-US')} → {prices.at(-1).toLocaleString('en-US')}</small>
    </div>
  );
}

function CredentialsTab({ client, onUpdateClient }) {
  const credentials = client.credentials || {};
  return (
    <section className="panel">
      <div className="panel-heading"><h3>Credentials & Notes</h3><Lock size={16} /></div>
      <div className="form-grid">
        <label>VPS IP<input value={credentials.ip || ''} onChange={(e) => onUpdateClient({ credentials: { ...credentials, ip: e.target.value } })} /></label>
        <label>Username<input value={credentials.username || ''} onChange={(e) => onUpdateClient({ credentials: { ...credentials, username: e.target.value } })} /></label>
        <label>Password<input type="password" value={credentials.password || ''} onChange={(e) => onUpdateClient({ credentials: { ...credentials, password: e.target.value } })} /></label>
        <label>Client notes<textarea value={client.notes || ''} onChange={(e) => onUpdateClient({ notes: e.target.value })} /></label>
      </div>
    </section>
  );
}

function PriceChecksTab() {
  return (
    <section className="panel">
      <div className="panel-heading"><h3>Price Checks</h3><span className="badge muted">Lightweight MVP</span></div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead><tr><th>Instrument</th><th>Time</th><th>Price</th><th>Connection</th><th>Algos</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>MNQ</td><td>09:00 EST</td><td>Manual</td><td>CONNECTED</td><td>RUNNING</td><td>Use as hourly checklist in phase 2.</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState(() => loadDemoState());
  const [session, setSession] = useState(null);
  const [platformView, setPlatformView] = useState('manager');
  const [newClientName, setNewClientName] = useState('');
  const [activeTab, setActiveTab] = useState('Evaluations');
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [showUpload, setShowUpload] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [reportImport, setReportImport] = useState(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [strategySetIndex, setStrategySetIndex] = useState({ status: 'Not loaded', records: [] });

  useEffect(() => saveDemoState(state), [state]);

  useEffect(() => {
    let cancelled = false;
    fetch('/strategy-set-index.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.records?.length) {
          setStrategySetIndex({ status: 'Loaded', records: data.records });
        } else {
          setStrategySetIndex({ status: 'Run npm run xml:index', records: [] });
        }
      })
      .catch(() => {
        if (!cancelled) setStrategySetIndex({ status: 'Run npm run xml:index', records: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedClient = state.clients.find((client) => client.id === state.selectedClientId) || state.clients[0] || null;
  const dailyImport = selectedClient ? getClientImportByDate(selectedClient, selectedDate) : null;
  const visibleTabs = selectedClient ? buildVisibleTabs(selectedClient, dailyImport) : STATIC_TABS;

  const effectiveActiveTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0] || 'Credentials & Notes';

  const currentTabData = selectedClient
    ? filteredAccountsForTab(selectedClient, dailyImport, effectiveActiveTab)
    : { accounts: {}, snapshots: [] };

  function handleAddClient(event) {
    event.preventDefault();
    setState((current) => addClient(current, newClientName));
    setNewClientName('');
    setShowOverview(false);
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName();
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const imported = parseImportedState(text);
      setState(imported);
      setShowOverview(false);
    } catch (err) {
      window.alert(err?.message || 'Could not import this file.');
    }
  }

  function handleParsedFiles(parsed) {
    if (!selectedClient) return;
    const result = reconcileDailyImport({
      clientId: selectedClient.id,
      date: selectedDate,
      registry: selectedClient.accountRegistry,
      parsed,
    });
    setState((current) => appendDailyImport(current, selectedClient.id, result));
    setShowUpload(false);
  }

  function handleAccountUpdate(accountName, patch) {
    if (!selectedClient) return;
    setState((current) => upsertAccountMeta(current, selectedClient.id, accountName, patch));
  }

  function handleUpdateClient(patch) {
    if (!selectedClient) return;
    setState((current) => updateClientDetails(current, selectedClient.id, patch));
  }

  function closeImport() {
    if (!selectedClient || !dailyImport) return;
    setState((current) => updateImportStatus(current, selectedClient.id, dailyImport.id, 'Closed'));
  }

  function recalculateImport() {
    if (!selectedClient || !dailyImport) return;
    const recalculated = recalculateDailyImport({
      dailyImport,
      registry: selectedClient.accountRegistry,
    });
    setState((current) => replaceDailyImport(current, selectedClient.id, recalculated));
  }

  if (!session) {
    return <LoginScreen onLogin={(nextSession) => setSession(nextSession)} />;
  }

  if (platformView === 'manager') {
    return (
      <ManagerOverview
        clients={state.clients}
        camProfiles={state.camProfiles}
        onOpenCam={() => setPlatformView('cam')}
        onLoadDemo={() => setState(createDemoState())}
        onCreateCam={(name) => setState((current) => addCamProfile(current, name))}
      />
    );
  }

  return (
    <>
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Account Manager</span>
          <strong>{state.accountManager.name}</strong>
          <div className="backup-actions">
            <button className="ghost-button" onClick={() => setPlatformView('manager')}><Users size={14} /> Team</button>
            <button className="ghost-button" onClick={handleExport}><Download size={14} /> Export</button>
            <label className="ghost-button">
              <Upload size={14} /> Import
              <input type="file" accept=".json,application/json" hidden onChange={handleImport} />
            </label>
          </div>
        </div>
        <form className="client-form" onSubmit={handleAddClient}>
          <input value={newClientName} placeholder="New client" onChange={(event) => setNewClientName(event.target.value)} />
          <button><Plus size={16} /></button>
        </form>
        <nav className="client-list">
          <button className={showOverview ? 'client-link active' : 'client-link'} onClick={() => setShowOverview(true)}>
            <Users size={16} />
            <span>CAM Overview</span>
            <em>Live</em>
          </button>
          <div className="nav-label">Clients</div>
          {state.clients.map((client) => {
            const badge = deriveClientBadge(client);
            return (
              <button
                className={!showOverview && selectedClient?.id === client.id ? 'client-link active' : 'client-link'}
                key={client.id}
                onClick={() => {
                  setState((current) => selectClient(current, client.id));
                  setShowOverview(false);
                }}
              >
                <BarChart3 size={16} />
                <span>{client.name}</span>
                <em className={badge.tone}>{badge.label}</em>
              </button>
            );
          })}
        </nav>
      </aside>

      {showOverview ? (
        <CamOverview
          clients={state.clients}
          strategySetRecords={strategySetIndex.records}
          strategySetIndexStatus={strategySetIndex.status}
        />
      ) : (
        <main className="content">
          {!selectedClient ? (
            <div className="empty-state">
              <Users size={28} />
              <h2>Create your first client</h2>
              <p>Add a client in the sidebar, then upload that client's four NinjaTrader files.</p>
            </div>
          ) : (
            <>
              <div className="page-header">
                <div>
                  <span className="eyebrow">Client workspace</span>
                  <h1>{selectedClient.name}</h1>
                  <p>{dailyImport ? `${dailyImport.status} · ${dailyImport.flags.length} flags` : 'No close loaded for this date'}</p>
                </div>
                <div className="header-actions">
                  <label className="date-control"><CalendarDays size={16} /><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
                  <button className="secondary-button" onClick={() => setShowUpload((value) => !value)}><Upload size={16} /> Upload Daily Files</button>
                  <button className="primary-button" disabled={!dailyImport} onClick={() => setReportImport(dailyImport)}><FileText size={16} /> Build Daily Report</button>
                  <button className="ghost-button" disabled={!dailyImport} onClick={closeImport}><CheckCircle2 size={16} /> Close Day</button>
                </div>
              </div>

              {showUpload || !dailyImport ? <UploadArea onParsed={handleParsedFiles} /> : null}

              <div className="tabs">
                {visibleTabs.map((tab) => (
                  <button className={effectiveActiveTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>
                ))}
              </div>

              {effectiveActiveTab === 'Credentials & Notes' ? <CredentialsTab client={selectedClient} onUpdateClient={handleUpdateClient} /> : null}
              {effectiveActiveTab === 'Price Checks' ? <PriceChecksTab /> : null}
              {['Review', 'Evaluations', 'Funded', 'Cash'].includes(effectiveActiveTab) ? (
                <>
                  <Dashboard
                    dailyImport={dailyImport}
                    rows={currentTabData.snapshots}
                    title={effectiveActiveTab}
                    mode={tabMode(effectiveActiveTab)}
                    onBuildReport={() => setReportImport(dailyImport)}
                    onRecalculate={recalculateImport}
                    strategySetRecords={strategySetIndex.records}
                  />
                  <section className="panel">
                    <button className="registry-toggle" onClick={() => setRegistryOpen((value) => !value)}>
                      <ChevronDown className={registryOpen ? 'chevron open' : 'chevron'} size={16} />
                      <h3>Account Registry</h3>
                      <span className="muted">Manual classification persists across days.</span>
                      <span className="count">{Object.keys(currentTabData.accounts).length}</span>
                    </button>
                    {registryOpen ? (
                      <AccountManager
                        {...currentTabData}
                        mode={tabMode(effectiveActiveTab)}
                        onUpdateAccount={handleAccountUpdate}
                      />
                    ) : null}
                  </section>
                </>
              ) : null}
            </>
          )}
        </main>
      )}
    </div>
    {reportImport ? <ReportPanel client={selectedClient} dailyImport={reportImport} onClose={() => setReportImport(null)} /> : null}
    </>
  );
}
