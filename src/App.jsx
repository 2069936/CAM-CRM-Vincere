import { useEffect, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
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
  appendDailyImport,
  getClientImportByDate,
  loadDemoState,
  replaceDailyImport,
  saveDemoState,
  selectClient,
  todayIsoDate,
  updateClientDetails,
  updateImportStatus,
  upsertAccountMeta,
} from './domain/demoStore';
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
          <div><span>Aggregate balance</span><strong>{formatCurrency(report.totals.aggregateBalance)}</strong></div>
        </section>
        {['evaluations', 'funded', 'cash'].map((group) => report.grouped[group].length ? (
          <section className="report-section" key={group}>
            <h2>{group === 'cash' ? 'Cash Accounts' : group}</h2>
            {report.grouped[group].map((row) => (
              <div className="report-row" key={row.accountName}>
                <strong>{row.meta.alias || row.accountName}</strong>
                <span>{row.meta.status || 'Active'}</span>
                <span>{formatCurrency(row.grossRealizedPnl)}</span>
                <span>{formatCurrency(row.accountBalance)}</span>
              </div>
            ))}
          </section>
        ) : null)}
      </div>
    </div>
  );
}

function TeamOverviewMock({ clients }) {
  const openFlags = clients.flatMap((client) => client.dailyImports.at(-1)?.flags || []).length;
  return (
    <main className="content">
      <div className="page-header">
        <div>
          <span className="eyebrow">Future view</span>
          <h1>Team Overview</h1>
          <p>Mock for manager-level visibility across account managers.</p>
        </div>
      </div>
      <div className="metric-grid">
        <div className="metric"><span>Pedro clients</span><strong>{clients.length}</strong></div>
        <div className="metric"><span>Open flags</span><strong>{openFlags}</strong></div>
        <div className="metric"><span>Mock AMs</span><strong>3</strong></div>
        <div className="metric"><span>Coverage</span><strong>Manual close</strong></div>
      </div>
      <section className="panel">
        <div className="panel-heading"><h3>Account manager rollup</h3></div>
        <div className="team-grid">
          {['Pedro', 'Amanda', 'Josh', 'Camila'].map((name, index) => (
            <div className="team-card" key={name}>
              <strong>{name}</strong>
              <span>{index === 0 ? `${clients.length} live demo clients` : 'Mock data'}</span>
              <small>{index === 0 ? `${openFlags} flags` : `${index + 2} clients · ${index} flags`}</small>
            </div>
          ))}
        </div>
      </section>
    </main>
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
  const [newClientName, setNewClientName] = useState('');
  const [activeTab, setActiveTab] = useState('Evaluations');
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [showUpload, setShowUpload] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [reportImport, setReportImport] = useState(null);

  useEffect(() => saveDemoState(state), [state]);

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
    setShowTeam(false);
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Account Manager</span>
          <strong>{state.accountManager.name}</strong>
        </div>
        <form className="client-form" onSubmit={handleAddClient}>
          <input value={newClientName} placeholder="New client" onChange={(event) => setNewClientName(event.target.value)} />
          <button><Plus size={16} /></button>
        </form>
        <nav className="client-list">
          <button className={showTeam ? 'client-link active' : 'client-link'} onClick={() => setShowTeam(true)}>
            <Users size={16} />
            <span>Team Overview</span>
            <em>Mock</em>
          </button>
          <div className="nav-label">Clients</div>
          {state.clients.map((client) => {
            const badge = deriveClientBadge(client);
            return (
              <button
                className={!showTeam && selectedClient?.id === client.id ? 'client-link active' : 'client-link'}
                key={client.id}
                onClick={() => {
                  setState((current) => selectClient(current, client.id));
                  setShowTeam(false);
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

      {showTeam ? <TeamOverviewMock clients={state.clients} /> : (
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
                  />
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>Account Registry</h3>
                      <span className="muted">Manual classification persists across days.</span>
                    </div>
                    <AccountManager {...currentTabData} onUpdateAccount={handleAccountUpdate} />
                  </section>
                </>
              ) : null}
            </>
          )}
        </main>
      )}

      {reportImport ? <ReportPanel client={selectedClient} dailyImport={reportImport} onClose={() => setReportImport(null)} /> : null}
    </div>
  );
}
