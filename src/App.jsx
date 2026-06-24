import { Fragment, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Download,
  FileText,
  Lock,
  LogOut,
  Plus,
  Shield,
  Trash2,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import AccountManager from './components/AccountManager';
import Dashboard from './components/Dashboard';
import UploadArea from './components/UploadArea';
import {
  addActivityEntry,
  addClient,
  addCamProfile,
  addTask,
  appendDailyImport,
  createDemoState,
  deleteActivityEntry,
  deleteTask,
  exportFileName,
  getClientImportByDate,
  loadDemoState,
  parseImportedState,
  replaceDailyImport,
  resolveFlagInImport,
  saveDemoState,
  selectCam,
  selectClient,
  todayIsoDate,
  updateClientDetails,
  updateImportStatus,
  updateTask,
  upsertAccountMeta,
} from './domain/demoStore';
import { buildCamOverview } from './domain/camOverview';
import { recalculateDailyImport, reconcileDailyImport } from './domain/reconcile';
import { buildDailyReportSummary, formatCurrency } from './domain/report';
import {
  USER_ROLES,
  addUser,
  authenticateUser,
  deleteUser,
  loadUsers,
  saveUsers,
} from './domain/userStore';

const STATIC_TABS = ['Activity', 'Tasks', 'Credentials & Notes', 'Price Checks'];

function deriveClientBadge(client) {
  const latest = client.dailyImports.at(-1);
  if (!latest) return { label: 'No data', tone: 'muted' };
  const critical = latest.flags.filter((flag) => flag.severity === 'Critical' && flag.status !== 'Resolved').length;
  if (critical) return { label: `${critical} critical`, tone: 'danger' };
  const open = latest.flags.filter((f) => f.status !== 'Resolved').length;
  if (open) return { label: `${open} flags`, tone: 'warning' };
  const today = todayIsoDate();
  const overdue = (client.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate < today).length;
  if (overdue) return { label: `${overdue} overdue`, tone: 'warning' };
  const openTasks = (client.tasks || []).filter((t) => !t.done).length;
  if (openTasks) return { label: `${openTasks} tasks`, tone: 'muted' };
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
  return ['Overview', ...tabs, ...STATIC_TABS];
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

function clientDailyTotals(client) {
  return (client?.dailyImports || []).map((dailyImport) => {
    const snapshots = dailyImport.snapshots || [];
    return {
      date: dailyImport.date,
      dailyPnl: snapshots.reduce((total, snapshot) => total + Number(snapshot.grossRealizedPnl || 0), 0),
      weeklyPnl: snapshots.reduce((total, snapshot) => total + Number(snapshot.weeklyPnl || 0), 0),
      balance: snapshots.reduce((total, snapshot) => total + Number(snapshot.accountBalance || 0), 0),
      accounts: snapshots.length,
      flags: (dailyImport.flags || []).length,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function buildClientOverview(client, dailyImport) {
  const history = clientDailyTotals(client);
  const latest = dailyImport || client?.dailyImports?.at(-1) || null;
  const latestSnapshots = latest?.snapshots || [];
  const registry = { ...(latest?.accounts || {}), ...(client?.accountRegistry || {}) };
  const strategyTotals = new Map();
  const distribution = new Map();

  for (const importDay of client?.dailyImports || []) {
    for (const snapshot of importDay.snapshots || []) {
      for (const strategy of snapshot.strategies || []) {
        const key = strategy.strategyFamily || strategy.strategyName || 'Unknown';
        const current = strategyTotals.get(key) || { name: key, realized: 0, days: 0, lastThree: [] };
        current.realized += Number(strategy.realized || 0);
        current.days += 1;
        current.lastThree.push(Number(strategy.realized || 0));
        strategyTotals.set(key, current);
      }
    }
  }

  for (const snapshot of latestSnapshots) {
    for (const strategy of snapshot.strategies || []) {
      const key = strategy.strategyFamily || strategy.strategyName || 'Unknown';
      distribution.set(key, (distribution.get(key) || 0) + 1);
    }
  }

  const algorithms = [...strategyTotals.values()]
    .map((item) => {
      const recent = item.lastThree.slice(-3);
      const recentTotal = recent.reduce((total, value) => total + value, 0);
      return {
        ...item,
        recentTotal,
        temperature: recentTotal > 250 ? 'Hot' : recentTotal < -250 ? 'Cold' : 'Stable',
      };
    })
    .sort((a, b) => Math.abs(b.recentTotal) - Math.abs(a.recentTotal));

  const passProgress = latestSnapshots
    .map((snapshot) => {
      const meta = registry[snapshot.accountName] || {};
      if (meta.accountType === 'Cash' || meta.accountType === 'Inactive / Ignore') return null;
      const startingBalance = Number(snapshot.accountBalance || 0) >= 90000 ? 100000 : 50000;
      const target = Number(meta.targetProfit || 0) || startingBalance + (meta.accountType === 'Funded' ? 2000 : 3000);
      const progress = Math.max(0, Math.min(100, ((Number(snapshot.accountBalance || 0) - startingBalance) / (target - startingBalance || 1)) * 100));
      return {
        accountName: snapshot.accountName,
        alias: meta.alias || snapshot.accountName,
        accountType: meta.accountType || 'Unassigned',
        balance: Number(snapshot.accountBalance || 0),
        target,
        remaining: Math.max(0, target - Number(snapshot.accountBalance || 0)),
        progress,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.progress - a.progress);

  const latestTotal = history.at(-1)?.dailyPnl || 0;
  const priorTotal = history.at(-2)?.dailyPnl || 0;
  const streak = history.slice(-4);
  const hotCount = algorithms.filter((item) => item.temperature === 'Hot').length;
  const coldCount = algorithms.filter((item) => item.temperature === 'Cold').length;

  return {
    history,
    algorithms,
    distribution: [...distribution.entries()].map(([name, count]) => ({ name, count })),
    passProgress,
    metrics: {
      dailyPnl: latestTotal,
      dailyDelta: latestTotal - priorTotal,
      accounts: latestSnapshots.length,
      openFlags: latest?.flags?.length || 0,
      hotCount,
      coldCount,
      streakLabel: streak.every((day) => day.dailyPnl >= 0) ? `${streak.length} day positive streak` : streak.every((day) => day.dailyPnl < 0) ? `${streak.length} day cold streak` : 'Mixed streak',
    },
  };
}

function buildMonthlyTotals(client) {
  const byMonth = {};
  for (const di of client.dailyImports || []) {
    const month = di.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { month, monthlyPnl: 0, closedDays: 0, accounts: 0 };
    const snapshots = di.snapshots || [];
    byMonth[month].monthlyPnl += snapshots.reduce((t, s) => t + Number(s.grossRealizedPnl || 0), 0);
    byMonth[month].closedDays += 1;
    byMonth[month].accounts = Math.max(byMonth[month].accounts, snapshots.length);
  }
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
}

function buildStrategyAnalyzer(clients = []) {
  const stratMap = new Map();
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    for (const snapshot of latest.snapshots || []) {
      const enabledCount = (snapshot.strategies || []).filter((s) => s.enabled).length || 1;
      for (const strategy of snapshot.strategies || []) {
        const key = strategy.strategyFamily || strategy.strategyName || 'Unknown';
        const entry = stratMap.get(key) || { name: key, count: 0, totalRealized: 0, totalWeekly: 0, accountSet: new Set() };
        entry.count += 1;
        entry.totalRealized += Number(strategy.realized || 0);
        entry.totalWeekly += Number(snapshot.weeklyPnl || 0) / enabledCount;
        entry.accountSet.add(snapshot.accountName);
        stratMap.set(key, entry);
      }
    }
  }
  const entries = [...stratMap.values()];
  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.totalRealized)), 1);
  return entries.map((e) => ({
    name: e.name,
    count: e.count,
    accounts: e.accountSet.size,
    totalRealized: e.totalRealized,
    avgDaily: e.count ? e.totalRealized / e.count : 0,
    avgWeekly: e.accountSet.size ? e.totalWeekly / e.accountSet.size : 0,
    score: Math.max(0, Math.min(10, ((e.totalRealized + maxAbs) / (2 * maxAbs)) * 10)).toFixed(1),
  })).sort((a, b) => b.totalRealized - a.totalRealized);
}

function buildLifecycleMetrics(clients = []) {
  const evalFails = [];
  const evalFunded = [];
  const fundedPayouts = [];
  let totalEvals = 0;
  let totalFunded = 0;

  for (const client of clients) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (meta.accountType?.startsWith('Evaluation') || meta.accountType === 'Unassigned') {
        totalEvals += 1;
        if (meta.dateAdded && meta.dateFailed) {
          const days = (new Date(meta.dateFailed) - new Date(meta.dateAdded)) / 86400000;
          if (days >= 0) evalFails.push(days);
        }
        if (meta.dateAdded && meta.dateFunded) {
          const days = (new Date(meta.dateFunded) - new Date(meta.dateAdded)) / 86400000;
          if (days >= 0) evalFunded.push(days);
        }
      }
      if (meta.accountType === 'Funded') {
        totalFunded += 1;
        if (meta.dateFunded && meta.dateLastPayout) {
          const days = (new Date(meta.dateLastPayout) - new Date(meta.dateFunded)) / 86400000;
          if (days >= 0) fundedPayouts.push(days);
        }
      }
    }
  }

  const avg = (arr) => (arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : 'N/A');
  return {
    totalEvals,
    totalFunded,
    avgDaysToFail: avg(evalFails),
    avgDaysToFunded: avg(evalFunded),
    avgDaysToPayout: avg(fundedPayouts),
  };
}

// Monthly P&L grouped by account
function buildMonthlyByAccount(client) {
  const byMonth = {};
  for (const di of client.dailyImports || []) {
    const month = di.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = {};
    const registry = { ...(di.accounts || {}), ...(client.accountRegistry || {}) };
    for (const snapshot of di.snapshots || []) {
      const alias = registry[snapshot.accountName]?.alias || snapshot.accountName;
      if (!byMonth[month][snapshot.accountName]) {
        byMonth[month][snapshot.accountName] = { accountName: snapshot.accountName, alias, pnl: 0, days: 0 };
      }
      byMonth[month][snapshot.accountName].pnl += Number(snapshot.grossRealizedPnl || 0);
      byMonth[month][snapshot.accountName].days += 1;
    }
  }
  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, accounts]) => ({
      month,
      accounts: Object.values(accounts).sort((a, b) => b.pnl - a.pnl),
    }));
}

// Drawdown-based risk level for an account
function accountRiskLevel(snapshot, meta) {
  const ddLimit = Number(meta?.maxDrawdownLimit || 0);
  if (!ddLimit) return null;
  const used = Math.abs(Number(snapshot?.trailingMaxDrawdown || 0));
  const pct = used / ddLimit;
  if (pct >= 0.85) return { level: 'Critical', pct };
  if (pct >= 0.65) return { level: 'High', pct };
  if (pct >= 0.40) return { level: 'Medium', pct };
  return { level: 'Low', pct };
}

// Detect possible VPS/algo disconnect: enabled strategy + zero P&L when prior avg was positive
function buildDisconnectAlerts(client) {
  const alerts = [];
  const latest = client.dailyImports?.at(-1);
  if (!latest) return alerts;
  const registry = { ...(latest.accounts || {}), ...(client.accountRegistry || {}) };

  for (const snapshot of latest.snapshots || []) {
    const meta = registry[snapshot.accountName] || {};
    if (meta.accountType === 'Inactive / Ignore') continue;
    if (['Inactive', 'Failed', 'Reserve'].includes(meta.status)) continue;

    const activeStrategies = (snapshot.strategies || []).filter((s) => s.enabled);
    if (activeStrategies.length === 0) continue;

    const todayPnl = Number(snapshot.grossRealizedPnl || 0);
    if (todayPnl !== 0) continue;

    const priorPnls = (client.dailyImports.slice(-6, -1) || [])
      .map((di) => {
        const s = (di.snapshots || []).find((x) => x.accountName === snapshot.accountName);
        return s ? Number(s.grossRealizedPnl || 0) : null;
      })
      .filter((v) => v !== null && v !== 0);

    if (priorPnls.length >= 3) {
      const avg = priorPnls.reduce((sum, v) => sum + v, 0) / priorPnls.length;
      if (avg > 50) {
        alerts.push({
          id: `disc-${snapshot.accountName}`,
          accountName: snapshot.accountName,
          alias: meta.alias || snapshot.accountName,
          avgPnl: avg,
          message: `${meta.alias || snapshot.accountName} has active strategies but $0 P&L today. Prior 5-day avg: ${formatCurrency(avg)}. Verify VPS/strategy connection.`,
        });
      }
    }
  }
  return alerts;
}

function buildRiskDistribution(clients = [], camProfiles = []) {
  const camById = Object.fromEntries(camProfiles.map((p) => [p.id, p]));
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }

  const buckets = { Critical: [], High: [], Medium: [], Low: [], Safe: [] };

  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = { ...(latest.accounts || {}), ...(client.accountRegistry || {}) };
    const camId = clientCam[client.id];
    const camName = camById[camId]?.name || '—';

    for (const snapshot of latest.snapshots || []) {
      const meta = registry[snapshot.accountName] || {};
      if (meta.accountType === 'Inactive / Ignore' || meta.accountType === 'Cash') continue;
      if (['Inactive', 'Failed'].includes(meta.status)) continue;

      const risk = accountRiskLevel(snapshot, meta);
      const entry = {
        alias: meta.alias || snapshot.accountName,
        clientName: client.name,
        camName,
        drawdown: Number(snapshot.trailingMaxDrawdown || 0),
        ddLimit: Number(meta.maxDrawdownLimit || 0),
        pct: risk?.pct || 0,
      };

      if (risk?.level === 'Critical') buckets.Critical.push(entry);
      else if (risk?.level === 'High') buckets.High.push(entry);
      else if (risk?.level === 'Medium') buckets.Medium.push(entry);
      else if (risk?.level === 'Low') buckets.Low.push(entry);
      else buckets.Safe.push(entry);
    }
  }

  const total = Object.values(buckets).reduce((s, b) => s + b.length, 0);
  return { buckets, total };
}

function buildPayoutPipeline(clients = [], camProfiles = []) {
  const camById = Object.fromEntries(camProfiles.map((p) => [p.id, p]));
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }
  const rows = [];
  for (const client of clients) {
    const camId = clientCam[client.id];
    const camName = camById[camId]?.name || '—';
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (!meta.payoutState || meta.payoutState === 'Not requested') continue;
      const latest = client.dailyImports?.at(-1);
      const snapshot = (latest?.snapshots || []).find((s) => s.accountName === meta.accountName);
      rows.push({
        clientName: client.name,
        camName,
        accountName: meta.accountName,
        alias: meta.alias || meta.accountName,
        payoutState: meta.payoutState,
        balance: Number(snapshot?.accountBalance || 0),
        targetProfit: Number(meta.targetProfit || 0),
        payoutCount: meta.payoutCount || 0,
      });
    }
  }
  const order = ['Payout eligible', 'Request payout', 'Payout requested', 'Payout approved', 'Clear to trade'];
  return rows.sort((a, b) => order.indexOf(a.payoutState) - order.indexOf(b.payoutState));
}

function clientsForCam(clients = [], camProfile = null) {
  const clientIds = camProfile?.clientIds || [];
  if (!clientIds.length) return [];
  const allowed = new Set(clientIds);
  return clients.filter((client) => allowed.has(client.id));
}

function LoginScreen({ onLogin, users }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    const user = authenticateUser(username, password, users);
    if (!user) {
      setError('Invalid username or password.');
      return;
    }
    setError('');
    onLogin(user);
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <span className="eyebrow">Vincere Trading</span>
        <h1>CAM CRM</h1>
        <p>Client Account Manager platform. Sign in to continue.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            Username
            <input
              value={username}
              autoComplete="username"
              onChange={(event) => { setUsername(event.target.value); setError(''); }}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => { setPassword(event.target.value); setError(''); }}
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="primary-button">Sign in</button>
        </form>
        <div className="login-hints">
          <small><strong>Manager:</strong> manager / demo</small>
          <small><strong>CAM:</strong> pedro / pedro123 · amanda / amanda123</small>
        </div>
      </section>
    </main>
  );
}

function buildCamPerformance(clients = [], camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }

  const camMap = {};
  for (const cam of camProfiles) {
    camMap[cam.id] = { id: cam.id, name: cam.name, weeklyPnl: 0, dailyPnl: 0, funded: 0, evaluations: 0, totalAccounts: 0, openFlags: 0, clients: 0 };
  }

  for (const client of clients) {
    const camId = clientCam[client.id];
    if (!camId || !camMap[camId]) continue;
    const bucket = camMap[camId];
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = { ...(latest.accounts || {}), ...(client.accountRegistry || {}) };
    bucket.clients++;
    for (const snap of latest.snapshots || []) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType === 'Inactive / Ignore') continue;
      bucket.totalAccounts++;
      bucket.weeklyPnl += Number(snap.weeklyPnl || 0);
      bucket.dailyPnl += Number(snap.grossRealizedPnl || 0);
      if (meta.accountType === 'Funded') bucket.funded++;
      else if (meta.accountType?.startsWith('Evaluation')) bucket.evaluations++;
    }
    bucket.openFlags += (latest.flags || []).filter((f) => f.status !== 'Resolved').length;
  }

  return Object.values(camMap).sort((a, b) => b.weeklyPnl - a.weeklyPnl);
}

function ManagerOverview({ clients, camProfiles = [], onOpenCam, onLoadDemo, onCreateCam, onLogout, users = [], onUsersChange, session }) {
  const [newCamName, setNewCamName] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', displayName: '', role: USER_ROLES.CAM, camProfileId: '' });
  const [showUserPanel, setShowUserPanel] = useState(false);
  const teamHistory = buildTeamHistory(clients);
  const cams = (camProfiles.length ? camProfiles : createDemoState().camProfiles).map((profile) => {
    const summary = buildManagerSummary(clientsForCam(clients, profile));
    return { ...profile, ...summary, flags: summary.openFlags };
  });
  const totals = cams.reduce((acc, cam) => ({
    clients: acc.clients + cam.clients,
    accounts: acc.accounts + cam.accounts,
    weeklyPnl: acc.weeklyPnl + cam.weeklyPnl,
    dailyPnl: acc.dailyPnl + cam.dailyPnl,
    flags: acc.flags + cam.flags,
  }), { clients: 0, accounts: 0, weeklyPnl: 0, dailyPnl: 0, flags: 0 });

  const strategies = buildStrategyAnalyzer(clients);
  const lifecycle = buildLifecycleMetrics(clients);
  const riskDist = buildRiskDistribution(clients, camProfiles);
  const camPerf = buildCamPerformance(clients, camProfiles);

  function submitCam(event) {
    event.preventDefault();
    onCreateCam(newCamName);
    setNewCamName('');
  }

  function submitNewUser(event) {
    event.preventDefault();
    if (!newUser.username || !newUser.password || !newUser.displayName) return;
    onUsersChange(addUser(users, newUser));
    setNewUser({ username: '', password: '', displayName: '', role: USER_ROLES.CAM, camProfileId: '' });
  }

  return (
    <main className="manager-shell">
      <aside className="manager-sidebar">
        <span className="eyebrow">Platform</span>
        <strong>Vincere CRM</strong>
        <button className="client-link active"><Users size={16} /><span>Operations</span><em>Live</em></button>
        {(camProfiles.length ? camProfiles : cams).map((cam) => (
          <button className="client-link" key={cam.id} onClick={() => onOpenCam(cam.id)}>
            <BarChart3 size={16} />
            <span>{cam.name}</span>
            <em>{cam.status || 'Active'}</em>
          </button>
        ))}
        <div className="manager-sidebar-footer">
          <button className="client-link" onClick={() => setShowUserPanel((v) => !v)}>
            <Shield size={16} /><span>Users & Access</span>
          </button>
          <button className="client-link" onClick={onLogout}>
            <LogOut size={16} /><span>Sign out</span>
          </button>
        </div>
      </aside>
      <section className="content">
        <div className="page-header">
          <div>
            <span className="eyebrow">Manager overview · {session?.displayName || 'Manager'}</span>
            <h1>Operations Command Center</h1>
            <p>Team-level analytics: accounts, strategy performance, lifecycle and flags.</p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={onLoadDemo}><Download size={16} /> Reload Demo</button>
            <button className="primary-button" onClick={() => onOpenCam('am-pedro')}><BarChart3 size={16} /> Open Pedro Workspace</button>
          </div>
        </div>

        <div className="metric-grid">
          <div className="metric"><span>CAMs</span><strong>{cams.length}</strong></div>
          <div className="metric"><span>Clients</span><strong>{totals.clients}</strong></div>
          <div className="metric"><span>Accounts</span><strong>{totals.accounts}</strong></div>
          <div className="metric"><span>Open flags</span><strong className={totals.flags ? 'negative' : ''}>{totals.flags}</strong></div>
          <div className="metric"><span>Team daily PnL</span><strong className={totals.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(totals.dailyPnl)}</strong></div>
          <div className="metric"><span>Team weekly PnL</span><strong className={totals.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(totals.weeklyPnl)}</strong></div>
        </div>

        <section className="panel">
          <div className="panel-heading">
            <h3>Account managers</h3>
            <form className="inline-create-form" onSubmit={submitCam}>
              <input value={newCamName} placeholder="New CAM name" onChange={(event) => setNewCamName(event.target.value)} />
              <button className="secondary-button"><Plus size={14} /> Create</button>
            </form>
          </div>
          <div className="cam-card-grid">
            {cams.map((cam) => (
              <button className="cam-card live" key={cam.id || cam.name} onClick={() => onOpenCam(cam.id)}>
                <strong>{cam.name}</strong>
                <span>{cam.role} · {cam.status || 'Active'}</span>
                <small>{cam.clients} clients · {cam.accounts} accounts · {cam.flags} flags</small>
                <em className={cam.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.weeklyPnl)} weekly</em>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><h3>7-day team history</h3><span className="badge muted">Historical closes</span></div>
          <div className="history-strip">
            {teamHistory.map((day) => (
              <div className="history-day" key={day.date}>
                <span>{day.date.slice(5)}</span>
                <strong className={day.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(day.dailyPnl)}</strong>
                <small>{day.accounts} acc · {formatCurrency(day.weeklyPnl)} weekly</small>
              </div>
            ))}
          </div>
        </section>

        <section className="overview-grid">
          <div className="panel">
            <div className="panel-heading"><h3>Strategy analyzer</h3><span className="count">Score 0–10</span></div>
            <div className="strategy-rank-list">
              {strategies.length ? strategies.map((s) => (
                <div className="rank-row" key={s.name}>
                  <strong>{s.name}</strong>
                  <small>{s.count} instances · {s.accounts} accts</small>
                  <span>{s.score}/10</span>
                  <em className={s.avgDaily >= 0 ? 'positive' : 'negative'}>{formatCurrency(s.avgDaily)} avg daily</em>
                </div>
              )) : <p className="muted">No strategy data in latest closes.</p>}
            </div>
          </div>
          <div className="panel">
            <div className="panel-heading"><h3>Lifecycle metrics</h3><span className="badge muted">Account history</span></div>
            <div className="lifecycle-grid">
              <div><span>Total evaluations</span><strong>{lifecycle.totalEvals}</strong></div>
              <div><span>Total funded</span><strong>{lifecycle.totalFunded}</strong></div>
              <div><span>Avg days to fail</span><strong>{lifecycle.avgDaysToFail}</strong></div>
              <div><span>Avg days to funded</span><strong>{lifecycle.avgDaysToFunded}</strong></div>
              <div><span>Avg days to payout</span><strong>{lifecycle.avgDaysToPayout}</strong></div>
            </div>
          </div>
        </section>

        {riskDist.total > 0 ? (
          <section className={riskDist.buckets.Critical.length ? 'panel danger-panel' : 'panel'}>
            <div className="panel-heading">
              <h3>Drawdown risk distribution</h3>
              <span className="badge muted">{riskDist.total} accounts with DD config</span>
            </div>
            <div className="risk-dist-grid">
              {[
                { key: 'Critical', color: 'var(--red)', label: 'Critical ≥85%' },
                { key: 'High',     color: '#f59e0b',   label: 'High 65–85%' },
                { key: 'Medium',   color: 'var(--yellow)', label: 'Medium 40–65%' },
                { key: 'Low',      color: 'var(--green)', label: 'Low <40%' },
                { key: 'Safe',     color: 'var(--muted)', label: 'No limit set' },
              ].map(({ key, color, label }) => {
                const accounts = riskDist.buckets[key];
                const pct = riskDist.total > 0 ? (accounts.length / riskDist.total) * 100 : 0;
                return (
                  <div className="risk-dist-row" key={key}>
                    <span className="risk-dist-label" style={{ color }}>{label}</span>
                    <div className="risk-dist-bar">
                      <i style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <strong style={{ color: accounts.length && key === 'Critical' ? color : undefined }}>
                      {accounts.length}
                    </strong>
                    {accounts.length ? (
                      <span className="risk-dist-names">
                        {accounts.slice(0, 4).map((a) => `${a.alias} (${a.clientName})`).join(' · ')}
                        {accounts.length > 4 ? ` +${accounts.length - 4} more` : ''}
                      </span>
                    ) : <span className="risk-dist-names muted">—</span>}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {camPerf.length > 0 ? (
          <section className="panel">
            <div className="panel-heading">
              <h3>CAM performance ranking</h3>
              <span className="badge muted">Weekly P&amp;L · sorted best to worst</span>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>CAM</th>
                    <th>Clients</th>
                    <th>Accounts</th>
                    <th>Funded</th>
                    <th>Evals</th>
                    <th>Daily P&amp;L</th>
                    <th>Weekly P&amp;L</th>
                    <th>Open flags</th>
                  </tr>
                </thead>
                <tbody>
                  {camPerf.map((cam, i) => (
                    <tr key={cam.id} className={cam.openFlags >= 3 ? 'row-warning' : ''}>
                      <td><span className="rank-badge">{i + 1}</span></td>
                      <td><strong>{cam.name}</strong></td>
                      <td>{cam.clients}</td>
                      <td>{cam.totalAccounts}</td>
                      <td>{cam.funded}</td>
                      <td>{cam.evaluations}</td>
                      <td className={cam.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.dailyPnl)}</td>
                      <td className={cam.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.weeklyPnl)}</td>
                      <td className={cam.openFlags >= 3 ? 'negative' : ''}>{cam.openFlags}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-heading"><h3>Exception rules</h3><span className="badge muted">Auto-detected flags</span></div>
          <div className="exception-grid">
            <div className="exception-card critical">
              <strong>Drawdown near limit</strong>
              <span>Account has less than $500 remaining before its max drawdown limit.</span>
              <small>balance_dd_remaining &lt; 500</small>
            </div>
            <div className="exception-card critical">
              <strong>Payout hold violation</strong>
              <span>Account in payout hold still has an enabled strategy.</span>
              <small>status = Payout Hold &amp;&amp; enabled_strategies &gt; 0</small>
            </div>
            <div className="exception-card warning">
              <strong>Payout eligible</strong>
              <span>Funded account balance reached or exceeded target profit and payout not yet requested.</span>
              <small>balance &ge; target_profit &amp;&amp; payout = Not requested</small>
            </div>
            <div className="exception-card warning">
              <strong>Drawdown approaching</strong>
              <span>Account has less than $1,200 remaining before its max drawdown limit.</span>
              <small>balance_dd_remaining &lt; 1200</small>
            </div>
          </div>
        </section>

        {(() => {
          const pipeline = buildPayoutPipeline(clients, camProfiles);
          if (!pipeline.length) return null;
          return (
            <section className="panel">
              <div className="panel-heading"><h3>Payout pipeline</h3><span className="count">{pipeline.length}</span></div>
              <div className="table-wrap">
                <table className="ops-table">
                  <thead><tr><th>Account</th><th>Client</th><th>CAM</th><th>State</th><th>Balance</th><th>Payouts</th></tr></thead>
                  <tbody>
                    {pipeline.map((row) => (
                      <tr key={`${row.clientName}-${row.accountName}`}>
                        <td><strong>{row.alias}</strong></td>
                        <td>{row.clientName}</td>
                        <td>{row.camName}</td>
                        <td><span className={`badge ${row.payoutState === 'Payout approved' || row.payoutState === 'Clear to trade' ? 'success' : row.payoutState === 'Payout requested' ? 'warning' : 'muted'}`}>{row.payoutState}</span></td>
                        <td className="positive">{formatCurrency(row.balance)}</td>
                        <td>{row.payoutCount}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        {showUserPanel ? (
          <section className="panel">
            <div className="panel-heading"><h3>Users &amp; Access</h3><Shield size={16} /></div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead><tr><th>Display name</th><th>Username</th><th>Role</th><th>CAM profile</th><th>Action</th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.displayName}</td>
                      <td><code>{u.username}</code></td>
                      <td><span className={u.role === USER_ROLES.MANAGER ? 'badge success' : 'badge muted'}>{u.role}</span></td>
                      <td>{u.camProfileId ? camProfiles.find((p) => p.id === u.camProfileId)?.name || u.camProfileId : '—'}</td>
                      <td>
                        <button
                          className="ghost-button"
                          disabled={u.role === USER_ROLES.MANAGER}
                          onClick={() => onUsersChange(deleteUser(users, u.id))}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form className="user-create-form" onSubmit={submitNewUser}>
              <input placeholder="Display name" value={newUser.displayName} onChange={(e) => setNewUser((v) => ({ ...v, displayName: e.target.value }))} />
              <input placeholder="Username" value={newUser.username} onChange={(e) => setNewUser((v) => ({ ...v, username: e.target.value }))} />
              <input placeholder="Password" value={newUser.password} onChange={(e) => setNewUser((v) => ({ ...v, password: e.target.value }))} />
              <select value={newUser.role} onChange={(e) => setNewUser((v) => ({ ...v, role: e.target.value }))}>
                {Object.values(USER_ROLES).map((r) => <option key={r}>{r}</option>)}
              </select>
              <select value={newUser.camProfileId} onChange={(e) => setNewUser((v) => ({ ...v, camProfileId: e.target.value }))}>
                <option value="">No CAM profile</option>
                {camProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="secondary-button"><Plus size={14} /> Add user</button>
            </form>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function ReportPanel({ client, dailyImport, onClose }) {
  const report = buildDailyReportSummary(client, dailyImport);
  const dailyDelta = report.priorDailyPnl !== null
    ? report.totals.grossRealizedPnl - report.priorDailyPnl
    : null;

  function drawdownLabel(row) {
    const ddLimit = Number(row.meta?.maxDrawdownLimit);
    const rawDD = Number(row.trailingMaxDrawdown || 0);
    if (Number.isFinite(ddLimit) && ddLimit > 0) {
      const remaining = ddLimit - Math.abs(rawDD);
      const pct = Math.round((Math.abs(rawDD) / ddLimit) * 100);
      return `${formatCurrency(remaining)} remaining (${pct}% used)`;
    }
    if (rawDD !== 0) {
      return rawDD <= 0 ? 'BREACHED' : `${formatCurrency(rawDD)} buffer`;
    }
    return '—';
  }

  function drawdownTone(row) {
    const ddLimit = Number(row.meta?.maxDrawdownLimit);
    const rawDD = Number(row.trailingMaxDrawdown || 0);
    if (Number.isFinite(ddLimit) && ddLimit > 0) {
      const remaining = ddLimit - Math.abs(rawDD);
      if (remaining <= 500) return 'report-dd-critical';
      if (remaining <= 1200) return 'report-dd-warning';
    } else if (rawDD !== 0) {
      if (rawDD <= 0) return 'report-dd-critical';
      if (rawDD <= 500) return 'report-dd-critical';
      if (rawDD <= 1200) return 'report-dd-warning';
    }
    return '';
  }

  const GROUP_LABELS = { evaluations: 'Evaluations', funded: 'Funded Accounts', cash: 'Cash Accounts' };

  return (
    <div className="report-overlay">
      <div className="report-sheet">
        <div className="report-actions no-print">
          <button className="secondary-button" onClick={() => window.print()}>Print / Save PDF</button>
          <button className="ghost-button" onClick={onClose}>Close</button>
        </div>

        <header className="report-header">
          <div>
            <p className="report-firm">Vincere Trading</p>
            <h1>{report.clientName}</h1>
            <span>Daily close report · {report.date}</span>
          </div>
          <div className="report-header-right">
            <strong className={report.counts.criticalFlags > 0 ? 'report-status-critical' : ''}>{report.status}</strong>
            {report.counts.criticalFlags > 0 ? <span className="report-flag-badge">{report.counts.criticalFlags} critical</span> : null}
          </div>
        </header>

        <section className="report-metrics">
          <div>
            <span>Accounts</span>
            <strong>{report.counts.accounts}</strong>
          </div>
          <div>
            <span>Daily / Gross PnL</span>
            <strong className={report.totals.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
              {formatCurrency(report.totals.grossRealizedPnl)}
            </strong>
          </div>
          <div>
            <span>Weekly PnL</span>
            <strong className={report.totals.weeklyPnl >= 0 ? 'report-positive' : 'report-negative'}>
              {formatCurrency(report.totals.weeklyPnl)}
            </strong>
          </div>
          {dailyDelta !== null ? (
            <div>
              <span>vs prior close</span>
              <strong className={dailyDelta >= 0 ? 'report-positive' : 'report-negative'}>
                {dailyDelta >= 0 ? '+' : ''}{formatCurrency(dailyDelta)}
              </strong>
            </div>
          ) : null}
          <div>
            <span>Open flags</span>
            <strong className={report.counts.openFlags > 0 ? 'report-negative' : ''}>
              {report.counts.openFlags}
            </strong>
          </div>
        </section>

        {['evaluations', 'funded', 'cash'].map((group) => report.grouped[group].length ? (
          <section className="report-section" key={group}>
            <h2>{GROUP_LABELS[group]}</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Strategies</th>
                  <th>Daily PnL</th>
                  <th>Weekly PnL</th>
                  {group !== 'cash' ? <th>Drawdown</th> : null}
                  {group === 'cash' ? <th>Balance</th> : null}
                </tr>
              </thead>
              <tbody>
                {report.grouped[group].map((row) => {
                  const stratNames = (row.strategies || []).map((s) =>
                    `${s.strategyName || s.strategyFamily || 'Strategy'}${s.enabled ? '' : ' (off)'}`
                  ).join(', ') || '—';
                  return (
                    <tr key={row.accountName}>
                      <td><strong>{row.meta?.alias || row.accountName}</strong><br /><small>{row.meta?.connection || row.connection || ''}</small></td>
                      <td>{row.meta?.status || 'Active'}</td>
                      <td><small>{stratNames}</small></td>
                      <td className={row.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>{formatCurrency(row.grossRealizedPnl)}</td>
                      <td className={row.weeklyPnl >= 0 ? 'report-positive' : 'report-negative'}>{formatCurrency(row.weeklyPnl)}</td>
                      {group !== 'cash' ? <td className={drawdownTone(row)}>{drawdownLabel(row)}</td> : null}
                      {group === 'cash' ? <td>{formatCurrency(row.accountBalance)}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null)}

        {report.openFlags.length > 0 ? (
          <section className="report-section">
            <h2>Open flags</h2>
            <div className="report-flags">
              {report.openFlags.map((flag) => (
                <div key={flag.id} className={`report-flag-row report-flag-${flag.severity?.toLowerCase()}`}>
                  <strong>{flag.severity} · {flag.type}</strong>
                  <span>{flag.message}</span>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="report-section">
            <p className="report-ok">✓ No open flags for this close.</p>
          </section>
        )}

        <footer className="report-footer">
          <span>Generated {new Date(report.generatedAt).toLocaleString('en-US')}</span>
          <span>Vincere Trading · Confidential</span>
        </footer>
      </div>
    </div>
  );
}

function ClientPnlChart({ history = [] }) {
  const values = history.map((day) => Number(day.dailyPnl || 0));
  if (!values.length) return <div className="sparkline-empty">No client history yet</div>;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const spread = max - min || 1;
  const nodes = history.map((day, index) => {
    const value = Number(day.dailyPnl || 0);
    const x = values.length === 1 ? 300 : (index / (values.length - 1)) * 600;
    const y = 150 - ((value - min) / spread) * 120;
    return { ...day, value, x, y };
  });
  const points = nodes.map((node) => `${node.x},${node.y}`).join(' ');
  const zeroY = 150 - ((0 - min) / spread) * 120;

  return (
    <div className="client-chart">
      <svg viewBox="0 0 600 180" role="img" aria-label="Client daily PnL history">
        <line x1="0" x2="600" y1={zeroY} y2={zeroY} />
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {nodes.map((node) => (
          <circle className="chart-node chart-node-large" key={node.date} cx={node.x} cy={node.y} r="6">
            <title>{`${node.date} · Daily PnL ${formatCurrency(node.dailyPnl)} · Weekly ${formatCurrency(node.weeklyPnl)} · ${node.accounts} accounts · ${node.flags} flags`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-axis">
        {history.map((day) => <span key={day.date}>{day.date.slice(5)}</span>)}
      </div>
    </div>
  );
}

function ClientOverview({ client, dailyImport }) {
  const [monthlyExpanded, setMonthlyExpanded] = useState('');
  const overview = buildClientOverview(client, dailyImport);
  const maxDistribution = Math.max(...overview.distribution.map((item) => item.count), 1);
  const disconnectAlerts = buildDisconnectAlerts(client);
  const monthlyByAccount = buildMonthlyByAccount(client);
  const latestRegistry = { ...(dailyImport?.accounts || {}), ...(client?.accountRegistry || {}) };

  return (
    <div className="dashboard-stack">
      <div className="metric-grid">
        <div className="metric"><span>Latest daily PnL</span><strong className={overview.metrics.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(overview.metrics.dailyPnl)}</strong></div>
        <div className="metric"><span>Change vs prior close</span><strong className={overview.metrics.dailyDelta >= 0 ? 'positive' : 'negative'}>{formatCurrency(overview.metrics.dailyDelta)}</strong></div>
        <div className="metric"><span>Accounts tracked</span><strong>{overview.metrics.accounts}</strong></div>
        <div className="metric"><span>Open flags</span><strong>{overview.metrics.openFlags}</strong></div>
      </div>

      <section className="panel client-overview-hero">
        <div>
          <div className="panel-heading"><h3>Client performance timeline</h3><span className="badge muted">{overview.metrics.streakLabel}</span></div>
          <ClientPnlChart history={overview.history} />
        </div>
        <div className="client-insight-stack">
          <div><span>Hot algorithms</span><strong className="positive">{overview.metrics.hotCount}</strong></div>
          <div><span>Cold algorithms</span><strong className={overview.metrics.coldCount ? 'negative' : ''}>{overview.metrics.coldCount}</strong></div>
          <div><span>Data tracked</span><strong>Daily PnL · Weekly PnL · Drawdown · Balance</strong></div>
        </div>
      </section>

      <section className="overview-grid">
        <div className="panel">
          <div className="panel-heading"><h3>Algorithm temperature</h3><span className="badge muted">Last 3 closes</span></div>
          <div className="strategy-rank-list">
            {overview.algorithms.map((algorithm) => (
              <div className="rank-row algorithm-temp-row" key={algorithm.name}>
                <strong>{algorithm.name}</strong>
                <span className={algorithm.recentTotal >= 0 ? 'positive' : 'negative'}>{formatCurrency(algorithm.recentTotal)}</span>
                <em className={algorithm.temperature === 'Hot' ? 'positive' : algorithm.temperature === 'Cold' ? 'negative' : ''}>{algorithm.temperature}</em>
              </div>
            ))}
            {!overview.algorithms.length ? <p className="muted">No algorithms assigned in this client history.</p> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading"><h3>Strategy distribution</h3><span className="badge muted">Latest close</span></div>
          <div className="distribution-list">
            {overview.distribution.map((item) => (
              <div className="distribution-row" key={item.name}>
                <span>{item.name}</span>
                <div><i style={{ width: `${(item.count / maxDistribution) * 100}%` }} /></div>
                <strong>{item.count}</strong>
              </div>
            ))}
            {!overview.distribution.length ? <p className="muted">No active strategy distribution for this close.</p> : null}
          </div>
        </div>
      </section>

      {disconnectAlerts.length > 0 ? (
        <section className="panel danger-panel">
          <div className="panel-heading"><h3>Anomaly detection</h3><span className="count">{disconnectAlerts.length}</span></div>
          <div className="flag-list">
            {disconnectAlerts.map((alert) => (
              <div className="flag critical" key={alert.id}>
                <AlertTriangle size={16} />
                <div>
                  <strong>Possible VPS / algo disconnect — {alert.alias}</strong>
                  <span>{alert.message}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading"><h3>Monthly P&amp;L</h3><TrendingUp size={16} /></div>
        <div className="history-strip">
          {buildMonthlyTotals(client).map((m) => (
            <button
              className={`history-day clickable${monthlyExpanded === m.month ? ' active' : ''}`}
              key={m.month}
              onClick={() => setMonthlyExpanded((v) => v === m.month ? '' : m.month)}
            >
              <span>{m.month.slice(5)}/{m.month.slice(0, 4)}</span>
              <strong className={m.monthlyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(m.monthlyPnl)}</strong>
              <small>{m.closedDays} days · {m.accounts} accts</small>
            </button>
          ))}
          {!buildMonthlyTotals(client).length ? <p className="muted">No history yet.</p> : null}
        </div>
        {monthlyExpanded ? (
          <div className="monthly-account-breakdown">
            <div className="monthly-breakdown-head">
              <span>Account</span><span>Monthly P&amp;L</span><span>Days</span>
            </div>
            {(monthlyByAccount.find((m) => m.month === monthlyExpanded)?.accounts || []).map((row) => (
              <div className="monthly-breakdown-row" key={row.accountName}>
                <span>{row.alias}</span>
                <strong className={row.pnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.pnl)}</strong>
                <small>{row.days}d</small>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-heading"><h3>Closest to target</h3><span className="badge muted">Evaluation / funded progress</span></div>
        <div className="target-list">
          {overview.passProgress.slice(0, 6).map((account) => {
            const snapshot = (dailyImport?.snapshots || []).find((s) => s.accountName === account.accountName);
            const meta = latestRegistry[account.accountName] || {};
            const risk = accountRiskLevel(snapshot, meta);
            return (
              <div className="target-row" key={account.accountName}>
                <div>
                  <strong>
                    {account.alias}
                    {risk ? <span className={`risk-badge risk-${risk.level.toLowerCase()}`}>{risk.level} risk · {Math.round(risk.pct * 100)}% DD used</span> : null}
                  </strong>
                  <span>{account.accountType} · {formatCurrency(account.balance)} balance · {formatCurrency(account.remaining)} remaining</span>
                </div>
                <div className="progress-track"><i style={{ width: `${account.progress}%` }} /></div>
                <em>{Math.round(account.progress)}%</em>
              </div>
            );
          })}
          {!overview.passProgress.length ? <p className="muted">No target-bearing accounts for this client.</p> : null}
        </div>
      </section>
    </div>
  );
}

function searchClients(clients, query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = [];

  for (const client of clients) {
    const matches = [];

    if (client.name.toLowerCase().includes(q)) {
      matches.push({ type: 'client', label: client.name });
    }

    if (client.notes?.toLowerCase().includes(q)) {
      const idx = client.notes.toLowerCase().indexOf(q);
      matches.push({ type: 'note', label: 'Notes: …' + client.notes.slice(Math.max(0, idx - 20), idx + 60) + '…' });
    }

    const registry = client.accountRegistry || {};
    for (const meta of Object.values(registry)) {
      if (
        meta.alias?.toLowerCase().includes(q) ||
        meta.accountName?.toLowerCase().includes(q) ||
        meta.connection?.toLowerCase().includes(q)
      ) {
        matches.push({ type: 'account', label: `Account: ${meta.alias || meta.accountName}` });
      }
    }

    for (const task of (client.tasks || [])) {
      if (!task.done && task.text?.toLowerCase().includes(q)) {
        matches.push({ type: 'task', label: `Task: ${task.text.slice(0, 70)}${task.text.length > 70 ? '…' : ''}` });
      }
    }

    for (const entry of (client.activityLog || [])) {
      if (entry.text?.toLowerCase().includes(q)) {
        matches.push({ type: 'activity', label: `Log: ${entry.text.slice(0, 70)}${entry.text.length > 70 ? '…' : ''}` });
      }
    }

    if (matches.length) results.push({ client, matches: matches.slice(0, 3) });
  }
  return results;
}

function buildTodayBriefing(clients) {
  const today = todayIsoDate();
  return clients.map((client) => {
    const todayImport = getClientImportByDate(client, today);
    const latest = client.dailyImports?.at(-1) || null;
    const criticalFlags = (latest?.flags || []).filter((f) => f.severity === 'Critical' && f.status !== 'Resolved');
    const openFlags = (latest?.flags || []).filter((f) => f.status !== 'Resolved');
    const openTasks = (client.tasks || []).filter((t) => !t.done);
    const overdueTasks = openTasks.filter((t) => t.dueDate && t.dueDate < today);
    const highTasks = openTasks.filter((t) => t.priority === 'High');
    const payoutAccounts = Object.values(client.accountRegistry || {}).filter(
      (m) => m.payoutState && m.payoutState !== 'Not requested'
    );
    const dailyPnl = (latest?.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
    const closeStatus = !todayImport ? 'pending' : todayImport.status === 'Closed' ? 'closed' : 'uploaded';

    const urgency = criticalFlags.length > 0 ? 'critical'
      : overdueTasks.length > 0 ? 'warning'
      : highTasks.length > 0 || payoutAccounts.length > 0 ? 'info'
      : closeStatus === 'pending' ? 'pending'
      : 'ok';

    return { client, criticalFlags, openFlags, openTasks, overdueTasks, highTasks, payoutAccounts, dailyPnl, closeStatus, urgency };
  }).sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2, pending: 3, ok: 4 };
    return order[a.urgency] - order[b.urgency];
  });
}

function CamOverview({ clients, camProfiles = [], allClients = [], strategySetRecords = [], strategySetIndexStatus, camName = '', onSelectClient }) {
  const [expandedAlgorithm, setExpandedAlgorithm] = useState('');
  const overview = buildCamOverview(clients, strategySetRecords);
  const displayName = camName || 'this workspace';
  const briefing = buildTodayBriefing(clients);

  const urgencyCounts = { critical: 0, warning: 0, info: 0, pending: 0, ok: 0 };
  briefing.forEach((b) => { urgencyCounts[b.urgency] = (urgencyCounts[b.urgency] || 0) + 1; });

  return (
    <main className="content">
      <div className="page-header">
        <div>
          <span className="eyebrow">Account manager overview</span>
          <h1>CAM Overview</h1>
          <p>Algorithm performance across {displayName}'s latest client closes.</p>
        </div>
      </div>

      {clients.length > 0 ? (
        <section className={urgencyCounts.critical ? 'panel danger-panel' : 'panel'}>
          <div className="panel-heading">
            <h3>Today's briefing</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {urgencyCounts.critical ? <span className="badge danger">{urgencyCounts.critical} critical</span> : null}
              {urgencyCounts.warning ? <span className="badge warning">{urgencyCounts.warning} overdue</span> : null}
              {urgencyCounts.pending ? <span className="badge muted">{urgencyCounts.pending} not uploaded</span> : null}
              {!urgencyCounts.critical && !urgencyCounts.warning ? <span className="badge success">All clear</span> : null}
            </div>
          </div>
          <div className="briefing-grid">
            {briefing.map(({ client, criticalFlags, openFlags, openTasks, overdueTasks, highTasks, payoutAccounts, dailyPnl, closeStatus, urgency }) => {
              const nextTask = overdueTasks[0] || highTasks[0] || openTasks[0] || null;
              const nextFlag = criticalFlags[0] || null;
              return (
                <button
                  key={client.id}
                  className={`briefing-card briefing-${urgency}`}
                  onClick={() => onSelectClient && onSelectClient(client.id)}
                >
                  <div className="briefing-card-head">
                    <strong>{client.name}</strong>
                    <span className={`briefing-dot briefing-dot-${closeStatus}`} title={closeStatus === 'pending' ? 'No files today' : closeStatus === 'closed' ? 'Closed' : 'Uploaded'} />
                  </div>
                  <em className={dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(dailyPnl)} today</em>
                  <div className="briefing-chips">
                    {criticalFlags.length ? <span className="task-chip task-chip-high">{criticalFlags.length} critical</span> : null}
                    {openFlags.length && !criticalFlags.length ? <span className="task-chip">{openFlags.length} flags</span> : null}
                    {overdueTasks.length ? <span className="task-chip task-chip-high">{overdueTasks.length} overdue</span> : null}
                    {highTasks.length && !overdueTasks.length ? <span className="task-chip task-chip-due warning">{highTasks.length} high tasks</span> : null}
                    {payoutAccounts.length ? <span className="task-chip">{payoutAccounts.length} payout</span> : null}
                    {openTasks.length ? <span className="task-chip">{openTasks.length} tasks</span> : null}
                    {!criticalFlags.length && !openFlags.length && !overdueTasks.length && !highTasks.length && !payoutAccounts.length && !openTasks.length
                      ? <span className="task-chip" style={{ color: 'var(--green)' }}>Clean</span>
                      : null}
                  </div>
                  {(nextFlag || nextTask) ? (
                    <p className="briefing-next-action">
                      {nextFlag ? `⚠ ${nextFlag.type}: ${nextFlag.message.slice(0, 80)}${nextFlag.message.length > 80 ? '…' : ''}` : null}
                      {!nextFlag && nextTask ? `→ ${nextTask.text.slice(0, 80)}${nextTask.text.length > 80 ? '…' : ''}` : null}
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

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
                  <span>
                    {flag.message} Daily realized: {formatCurrency(flag.realized)}.
                    {flag.executionMove !== undefined ? ` Execution move: ${flag.executionMove > 0 ? '+' : ''}${flag.executionMove.toFixed(2)} vs peer direction ${flag.peerDirection}.` : ''}
                  </span>
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

      {camProfiles.length > 0 ? (
        <section className="panel">
          <div className="panel-heading"><h3>Team overview</h3><span className="badge muted">All CAMs</span></div>
          <div className="team-grid">
            {camProfiles.map((cam) => {
              const camClients = allClients.filter((c) => cam.clientIds?.includes(c.id));
              const summary = buildManagerSummary(camClients);
              return (
                <div className="team-card" key={cam.id}>
                  <strong>{cam.name}</strong>
                  <span>{cam.role || 'CAM'} · {cam.status || 'Active'}</span>
                  <small>{summary.clients} clients · {summary.accounts} accounts · {summary.openFlags} flags</small>
                  <em className={summary.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(summary.weeklyPnl)} weekly</em>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function MovementSparkline({ points = [] }) {
  const nodes = points
    .map((point) => ({ ...point, priceValue: Number(point.price || 0) }))
    .filter((point) => Number.isFinite(point.priceValue) && point.priceValue > 0);
  if (!nodes.length) return <small className="muted">No execution movement for this strategy.</small>;
  const min = Math.min(...nodes.map((point) => point.priceValue));
  const max = Math.max(...nodes.map((point) => point.priceValue));
  const spread = max - min || 1;
  const chartNodes = nodes.map((point, index) => {
    const x = nodes.length === 1 ? 100 : (index / (nodes.length - 1)) * 180;
    const y = 42 - ((point.priceValue - min) / spread) * 34;
    return { ...point, x, y };
  });
  const polyline = chartNodes.map((point) => `${point.x},${point.y}`).join(' ');
  return (
    <div className="movement-card">
      <svg viewBox="0 0 180 50" role="img" aria-label="Strategy execution price movement">
        <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {chartNodes.map((point, index) => (
          <circle className="chart-node" key={`${point.time}-${point.priceValue}-${index}`} cx={point.x} cy={point.y} r="4">
            <title>{`${point.time || 'Execution'} · ${point.action || 'Trade'} ${point.quantity || 0} @ ${point.priceValue.toLocaleString('en-US')} · ${point.entryExit || '-'}`}</title>
          </circle>
        ))}
      </svg>
      <small>{nodes.length} executions · {nodes[0].priceValue.toLocaleString('en-US')} → {nodes.at(-1).priceValue.toLocaleString('en-US')}</small>
    </div>
  );
}

const ACTIVITY_TYPES = ['Note', 'Call', 'Payout', 'Alert', 'Email', 'Other'];

function ActivityLog({ client, onAddEntry, onDeleteEntry }) {
  const [text, setText] = useState('');
  const [type, setType] = useState('Note');
  const [accountName, setAccountName] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterSearch, setFilterSearch] = useState('');
  const log = client.activityLog || [];
  const accounts = Object.values(client.accountRegistry || {});

  function submit(event) {
    event.preventDefault();
    if (!text.trim()) return;
    onAddEntry({
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      text: text.trim(),
      accountName,
      createdAt: new Date().toISOString(),
    });
    setText('');
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  const filtered = log.filter((entry) => {
    if (filterType !== 'All' && entry.type !== filterType) return false;
    if (filterSearch && !entry.text?.toLowerCase().includes(filterSearch.toLowerCase()) && !entry.accountName?.toLowerCase().includes(filterSearch.toLowerCase())) return false;
    return true;
  });

  return (
    <section className="panel">
      <div className="panel-heading"><h3>Activity log</h3><span className="count">{log.length}</span></div>
      <form className="activity-form" onSubmit={submit}>
        <div className="activity-form-row">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {ACTIVITY_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <select value={accountName} onChange={(e) => setAccountName(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.accountName} value={a.accountName}>{a.alias || a.accountName}</option>)}
          </select>
          <button className="primary-button">+ Log</button>
        </div>
        <textarea
          value={text}
          placeholder="What happened? (call outcome, action taken, client feedback...)"
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      </form>
      {log.length > 0 ? (
        <div className="activity-filter-row">
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="All">All types</option>
            {ACTIVITY_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input
            className="activity-search"
            value={filterSearch}
            placeholder="Search log..."
            onChange={(e) => setFilterSearch(e.target.value)}
          />
          {(filterType !== 'All' || filterSearch) ? (
            <button className="ghost-button" onClick={() => { setFilterType('All'); setFilterSearch(''); }}>Clear</button>
          ) : null}
          <span className="muted" style={{ fontSize: 12 }}>{filtered.length} of {log.length}</span>
        </div>
      ) : null}
      {filtered.length ? (
        <div className="activity-list">
          {filtered.map((entry) => (
            <div className="activity-entry" key={entry.id}>
              <div className="activity-meta">
                <span className={`activity-type activity-${entry.type?.toLowerCase()}`}>{entry.type || 'Note'}</span>
                {entry.accountName ? <code>{Object.values(client.accountRegistry || {}).find((a) => a.accountName === entry.accountName)?.alias || entry.accountName}</code> : null}
                <em>{formatDate(entry.createdAt)}</em>
                <button className="ghost-button icon-only" onClick={() => onDeleteEntry(entry.id)} title="Delete entry"><Trash2 size={13} /></button>
              </div>
              <p>{entry.text}</p>
            </div>
          ))}
        </div>
      ) : log.length ? (
        <p className="muted">No entries match the current filter.</p>
      ) : (
        <p className="muted">No activity logged yet. Use the form above to log calls, notes, and actions.</p>
      )}
    </section>
  );
}

const TASK_PRIORITIES = ['Normal', 'High', 'Low'];

function TasksTab({ client, onAddTask, onUpdateTask, onDeleteTask }) {
  const [text, setText] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('Normal');
  const [accountName, setAccountName] = useState('');
  const tasks = (client.tasks || []).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.priority === 'High' && b.priority !== 'High') return -1;
    if (b.priority === 'High' && a.priority !== 'High') return 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  const openCount = tasks.filter((t) => !t.done).length;
  const accounts = Object.values(client.accountRegistry || {});

  function submit(event) {
    event.preventDefault();
    if (!text.trim()) return;
    onAddTask({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: text.trim(),
      dueDate,
      priority,
      accountName,
      done: false,
      createdAt: new Date().toISOString(),
    });
    setText('');
    setDueDate('');
    setPriority('Normal');
    setAccountName('');
  }

  function formatDue(date) {
    if (!date) return null;
    const d = new Date(date + 'T12:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, tone: 'negative' };
    if (diff === 0) return { label: 'Due today', tone: 'negative' };
    if (diff === 1) return { label: 'Due tomorrow', tone: 'warning' };
    return { label: `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, tone: 'muted' };
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Tasks</h3>
        {openCount > 0 ? <span className="count">{openCount} open</span> : <span className="badge success">All done</span>}
      </div>
      <form className="task-form" onSubmit={submit}>
        <input
          className="task-text-input"
          value={text}
          placeholder="Add a follow-up task (e.g. call client about drawdown, request payout...)"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="task-form-meta">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} title="Due date (optional)" />
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={accountName} onChange={(e) => setAccountName(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.accountName} value={a.accountName}>{a.alias || a.accountName}</option>)}
          </select>
          <button className="primary-button"><Plus size={14} /> Add task</button>
        </div>
      </form>
      {tasks.length ? (
        <div className="task-list">
          {tasks.map((task) => {
            const due = formatDue(task.dueDate);
            const alias = task.accountName
              ? (accounts.find((a) => a.accountName === task.accountName)?.alias || task.accountName)
              : null;
            return (
              <div className={`task-row${task.done ? ' task-done' : ''}${task.priority === 'High' && !task.done ? ' task-high' : ''}`} key={task.id}>
                <button
                  className="task-checkbox"
                  title={task.done ? 'Mark open' : 'Mark done'}
                  onClick={() => onUpdateTask(task.id, { done: !task.done })}
                >
                  <CheckSquare size={16} className={task.done ? 'task-checked' : 'task-unchecked'} />
                </button>
                <div className="task-body">
                  <span className="task-text">{task.text}</span>
                  <div className="task-chips">
                    {task.priority === 'High' && !task.done ? <span className="task-chip task-chip-high">High</span> : null}
                    {alias ? <span className="task-chip">{alias}</span> : null}
                    {due ? <span className={`task-chip task-chip-due ${due.tone}`}>{due.label}</span> : null}
                  </div>
                </div>
                <button className="ghost-button icon-only" onClick={() => onDeleteTask(task.id)} title="Delete task">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">No tasks yet. Add follow-ups, reminders, or action items above.</p>
      )}
    </section>
  );
}

function CredentialsTab({ client, onUpdateClient }) {
  const credentials = client.credentials || {};
  const profile = client.profile || {};

  function updateProfile(patch) {
    onUpdateClient({ profile: { ...profile, ...patch } });
  }
  function updateCredentials(patch) {
    onUpdateClient({ credentials: { ...credentials, ...patch } });
  }

  return (
    <div className="credentials-stack">
      <section className="panel">
        <div className="panel-heading"><h3>Client profile</h3><span className="badge muted">Contact information</span></div>
        <div className="form-grid">
          <label>Full name<input value={profile.fullName || ''} placeholder="Legal name" onChange={(e) => updateProfile({ fullName: e.target.value })} /></label>
          <label>Email<input type="email" value={profile.email || ''} placeholder="client@email.com" onChange={(e) => updateProfile({ email: e.target.value })} /></label>
          <label>Phone<input type="tel" value={profile.phone || ''} placeholder="+1 (555) 000-0000" onChange={(e) => updateProfile({ phone: e.target.value })} /></label>
          <label>Time zone<input value={profile.timezone || ''} placeholder="e.g. America/New_York" onChange={(e) => updateProfile({ timezone: e.target.value })} /></label>
          <label>Prop firm<input value={profile.propFirm || ''} placeholder="e.g. Apex, TopStep, FTMO" onChange={(e) => updateProfile({ propFirm: e.target.value })} /></label>
          <label>Discord / Telegram<input value={profile.messenger || ''} placeholder="Handle or username" onChange={(e) => updateProfile({ messenger: e.target.value })} /></label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h3>VPS / Platform access</h3><Lock size={16} /></div>
        <div className="form-grid">
          <label>VPS IP<input value={credentials.ip || ''} onChange={(e) => updateCredentials({ ip: e.target.value })} /></label>
          <label>Username<input value={credentials.username || ''} onChange={(e) => updateCredentials({ username: e.target.value })} /></label>
          <label>Password<input type="password" value={credentials.password || ''} onChange={(e) => updateCredentials({ password: e.target.value })} /></label>
          <label>NT login<input value={credentials.ntLogin || ''} placeholder="NinjaTrader username" onChange={(e) => updateCredentials({ ntLogin: e.target.value })} /></label>
          <label>Prop firm login<input value={credentials.firmLogin || ''} placeholder="Dashboard login email" onChange={(e) => updateCredentials({ firmLogin: e.target.value })} /></label>
          <label>Prop firm password<input type="password" value={credentials.firmPassword || ''} onChange={(e) => updateCredentials({ firmPassword: e.target.value })} /></label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h3>Notes</h3></div>
        <textarea
          className="client-notes-area"
          value={client.notes || ''}
          placeholder="Internal notes, special instructions, client preferences..."
          onChange={(e) => onUpdateClient({ notes: e.target.value })}
        />
      </section>
    </div>
  );
}

const DEFAULT_PRICE_CHECK_ROWS = [
  { id: 'pc-1', instrument: 'MNQ', checkTime: '09:00', connection: '', algos: '', notes: '', checked: false },
  { id: 'pc-2', instrument: 'MES', checkTime: '10:00', connection: '', algos: '', notes: '', checked: false },
];

function PriceChecksTab({ client, onUpdateClient }) {
  const checks = client.priceChecks?.length ? client.priceChecks : DEFAULT_PRICE_CHECK_ROWS;
  const today = todayIsoDate();
  const lastReset = client.priceChecksDate;

  const activeChecks = lastReset === today
    ? checks
    : checks.map((r) => ({ ...r, checked: false }));

  function save(rows) {
    onUpdateClient({ priceChecks: rows, priceChecksDate: today });
  }

  function update(id, patch) {
    save(activeChecks.map((r) => r.id === id ? { ...r, ...patch } : r));
  }

  function addRow() {
    save([
      ...activeChecks,
      { id: `pc-${Date.now()}`, instrument: '', checkTime: '', connection: '', algos: '', notes: '', checked: false },
    ]);
  }

  function removeRow(id) {
    save(activeChecks.filter((r) => r.id !== id));
  }

  function resetAll() {
    save(activeChecks.map((r) => ({ ...r, checked: false })));
  }

  const doneCount = activeChecks.filter((r) => r.checked).length;
  const allDone = activeChecks.length > 0 && doneCount === activeChecks.length;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Price Checks</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {allDone
            ? <span className="badge success">All checked · {today}</span>
            : <span className="badge muted">{doneCount}/{activeChecks.length} checked today</span>}
          <button className="secondary-button" onClick={resetAll}>Reset</button>
          <button className="secondary-button" onClick={addRow}><Plus size={14} /> Row</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>✓</th>
              <th>Instrument</th>
              <th>Time</th>
              <th>Connection</th>
              <th>Algos</th>
              <th>Notes</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {activeChecks.map((row) => (
              <tr key={row.id} className={row.checked ? 'pc-row-done' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(e) => update(row.id, { checked: e.target.checked })}
                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td>
                  <input
                    value={row.instrument}
                    placeholder="MNQ"
                    style={{ width: '100%' }}
                    onChange={(e) => update(row.id, { instrument: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.checkTime}
                    placeholder="09:00"
                    style={{ width: 72 }}
                    onChange={(e) => update(row.id, { checkTime: e.target.value })}
                  />
                </td>
                <td>
                  <select value={row.connection} onChange={(e) => update(row.id, { connection: e.target.value })} style={{ minWidth: 130 }}>
                    <option value="">— not checked</option>
                    <option value="Connected">Connected</option>
                    <option value="Disconnected">Disconnected</option>
                    <option value="Degraded">Degraded</option>
                  </select>
                </td>
                <td>
                  <select value={row.algos} onChange={(e) => update(row.id, { algos: e.target.value })} style={{ minWidth: 110 }}>
                    <option value="">— not checked</option>
                    <option value="Running">Running</option>
                    <option value="Stopped">Stopped</option>
                    <option value="N/A">N/A</option>
                  </select>
                </td>
                <td>
                  <input
                    value={row.notes}
                    placeholder="Optional note"
                    style={{ width: '100%' }}
                    onChange={(e) => update(row.id, { notes: e.target.value })}
                  />
                </td>
                <td>
                  <button className="ghost-button icon-only" onClick={() => removeRow(row.id)}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState(() => loadDemoState());
  const [users, setUsers] = useState(() => loadUsers());
  const [session, setSession] = useState(null);
  const [platformView, setPlatformView] = useState('manager');
  const [newClientName, setNewClientName] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [activeTab, setActiveTab] = useState('Overview');
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [showUpload, setShowUpload] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [reportImport, setReportImport] = useState(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [strategySetIndex, setStrategySetIndex] = useState({ status: 'Not loaded', records: [] });

  useEffect(() => saveDemoState(state), [state]);
  useEffect(() => saveUsers(users), [users]);

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

  const currentCamProfile = (state.camProfiles || []).find((profile) => profile.id === state.accountManager?.id) || state.camProfiles?.[0] || null;
  const currentCamClients = clientsForCam(state.clients, currentCamProfile);
  const selectedClient = currentCamClients.find((client) => client.id === state.selectedClientId) || currentCamClients[0] || null;
  const dailyImport = selectedClient ? getClientImportByDate(selectedClient, selectedDate) : null;
  const visibleTabs = selectedClient ? buildVisibleTabs(selectedClient, dailyImport) : STATIC_TABS;

  const effectiveActiveTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0] || 'Credentials & Notes';

  const currentTabData = selectedClient
    ? filteredAccountsForTab(selectedClient, dailyImport, effectiveActiveTab)
    : { accounts: {}, snapshots: [] };

  function handleAddClient(event) {
    event.preventDefault();
    setState((current) => addClient(current, newClientName, current.accountManager?.id));
    setNewClientName('');
    setShowOverview(false);
  }

  function openCamWorkspace(camId = 'am-pedro') {
    setState((current) => selectCam(current, camId));
    setPlatformView('cam');
    setShowOverview(false);
    setRegistryOpen(false);
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

  function handleResolveFlag(flagId) {
    if (!selectedClient || !dailyImport) return;
    setState((current) => resolveFlagInImport(current, selectedClient.id, dailyImport.id, flagId));
  }

  function handleAddActivity(entry) {
    if (!selectedClient) return;
    setState((current) => addActivityEntry(current, selectedClient.id, entry));
  }

  function handleDeleteActivity(entryId) {
    if (!selectedClient) return;
    setState((current) => deleteActivityEntry(current, selectedClient.id, entryId));
  }

  function handleAddTask(task) {
    if (!selectedClient) return;
    setState((current) => addTask(current, selectedClient.id, task));
  }

  function handleUpdateTask(taskId, patch) {
    if (!selectedClient) return;
    setState((current) => updateTask(current, selectedClient.id, taskId, patch));
  }

  function handleDeleteTask(taskId) {
    if (!selectedClient) return;
    setState((current) => deleteTask(current, selectedClient.id, taskId));
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
    return (
      <LoginScreen
        users={users}
        onLogin={(user) => {
          setSession(user);
          if (user.role === USER_ROLES.CAM && user.camProfileId) {
            openCamWorkspace(user.camProfileId);
          } else {
            setPlatformView('manager');
          }
        }}
      />
    );
  }

  if (platformView === 'manager') {
    return (
      <ManagerOverview
        clients={state.clients}
        camProfiles={state.camProfiles}
        onOpenCam={openCamWorkspace}
        onLoadDemo={() => setState(createDemoState())}
        onCreateCam={(name) => setState((current) => addCamProfile(current, name))}
        onLogout={() => setSession(null)}
        users={users}
        onUsersChange={setUsers}
        session={session}
      />
    );
  }

  return (
    <>
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Account Manager</span>
          <strong>{currentCamProfile?.name || state.accountManager.name}</strong>
          <div className="backup-actions">
            <button className="ghost-button" onClick={() => setPlatformView('manager')}><Users size={14} /> Team</button>
            <button className="ghost-button" onClick={handleExport}><Download size={14} /> Export</button>
            <label className="ghost-button">
              <Upload size={14} /> Import
              <input type="file" accept=".json,application/json" hidden onChange={handleImport} />
            </label>
            <button className="ghost-button" onClick={() => setSession(null)}><LogOut size={14} /> Out</button>
          </div>
        </div>
        <form className="client-form" onSubmit={handleAddClient}>
          <input value={newClientName} placeholder="New client" onChange={(event) => setNewClientName(event.target.value)} />
          <button><Plus size={16} /></button>
        </form>
        <input
          className="client-search"
          value={clientSearch}
          placeholder="Search clients..."
          onChange={(e) => setClientSearch(e.target.value)}
        />
        <nav className="client-list">
          <button className={showOverview ? 'client-link active' : 'client-link'} onClick={() => setShowOverview(true)}>
            <Users size={16} />
            <span>CAM Overview</span>
            <em>Live</em>
          </button>
          <div className="nav-label">Other CAMs</div>
          {(state.camProfiles || []).filter((profile) => profile.id !== state.accountManager?.id).map((profile) => (
            <button className="client-link" key={profile.id} onClick={() => openCamWorkspace(profile.id)}>
              <Users size={16} />
              <span>{profile.name} CAM</span>
              <em>{profile.status || 'Active'}</em>
            </button>
          ))}
          {clientSearch.length >= 2 ? (() => {
            const searchResults = searchClients(currentCamClients, clientSearch);
            return searchResults.length ? (
              <>
                <div className="nav-label">{searchResults.length} match{searchResults.length !== 1 ? 'es' : ''}</div>
                {searchResults.map(({ client, matches }) => (
                  <button
                    key={client.id}
                    className={!showOverview && selectedClient?.id === client.id ? 'client-link client-link-search active' : 'client-link client-link-search'}
                    onClick={() => { setState((current) => selectClient(current, client.id)); setShowOverview(false); setClientSearch(''); }}
                  >
                    <span>{client.name}</span>
                    <div className="search-matches">
                      {matches.map((m, i) => <small key={i} className={`search-match-${m.type}`}>{m.label}</small>)}
                    </div>
                  </button>
                ))}
              </>
            ) : <div className="nav-label muted">No matches for "{clientSearch}"</div>;
          })() : (
            <>
              <div className="nav-label">Clients</div>
              {currentCamClients.map((client) => {
                const badge = deriveClientBadge(client);
                const todayClose = getClientImportByDate(client, todayIsoDate());
                const closeStatus = !todayClose ? 'no-close' : todayClose.status === 'Closed' ? 'closed' : 'uploaded';
                return (
                  <button
                    className={!showOverview && selectedClient?.id === client.id ? 'client-link active' : 'client-link'}
                    key={client.id}
                    onClick={() => { setState((current) => selectClient(current, client.id)); setShowOverview(false); }}
                  >
                    <span className={`close-dot close-dot-${closeStatus}`} title={closeStatus === 'no-close' ? 'No files today' : closeStatus === 'closed' ? 'Closed today' : 'Uploaded · not closed'} />
                    <span>{client.name}</span>
                    <em className={badge.tone}>{badge.label}</em>
                  </button>
                );
              })}
            </>
          )}
        </nav>
      </aside>

      {showOverview ? (
        <CamOverview
          clients={currentCamClients}
          camProfiles={state.camProfiles || []}
          allClients={state.clients || []}
          strategySetRecords={strategySetIndex.records}
          strategySetIndexStatus={strategySetIndex.status}
          camName={currentCamProfile?.name || ''}
          onSelectClient={(clientId) => {
            setState((current) => selectClient(current, clientId));
            setShowOverview(false);
          }}
        />
      ) : (
        <main className="content">
          {!selectedClient ? (
            <div className="empty-state">
              <Users size={28} />
              <h2>Create your first client</h2>
              <p>Add a client for {currentCamProfile?.name || 'this CAM'}, then upload that client's NinjaTrader files.</p>
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

              {effectiveActiveTab === 'Overview' ? <ClientOverview client={selectedClient} dailyImport={dailyImport} /> : null}
              {effectiveActiveTab === 'Activity' ? <ActivityLog client={selectedClient} onAddEntry={handleAddActivity} onDeleteEntry={handleDeleteActivity} /> : null}
              {effectiveActiveTab === 'Tasks' ? <TasksTab client={selectedClient} onAddTask={handleAddTask} onUpdateTask={handleUpdateTask} onDeleteTask={handleDeleteTask} /> : null}
              {effectiveActiveTab === 'Credentials & Notes' ? <CredentialsTab client={selectedClient} onUpdateClient={handleUpdateClient} /> : null}
              {effectiveActiveTab === 'Price Checks' ? <PriceChecksTab client={selectedClient} onUpdateClient={handleUpdateClient} /> : null}
              {['Review', 'Evaluations', 'Funded', 'Cash'].includes(effectiveActiveTab) ? (
                <>
                  <Dashboard
                    dailyImport={dailyImport}
                    rows={currentTabData.snapshots}
                    title={effectiveActiveTab}
                    mode={tabMode(effectiveActiveTab)}
                    onBuildReport={() => setReportImport(dailyImport)}
                    onRecalculate={recalculateImport}
                    onResolveFlag={handleResolveFlag}
                    onUpdateAccount={handleAccountUpdate}
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
