import React, { Fragment, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FileText,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import AccountManager from './components/AccountManager';
import Dashboard from './components/Dashboard';
import DailySOP from './components/DailySOP';
import StackPlaybook from './components/StackPlaybook';
import UploadArea from './components/UploadArea';
import {
  addActivityEntry,
  addClient,
  removeClient,
  transferClient,
  togglePinClient,
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
import { parseNinjaTraderCsvText } from './domain/csvImport';
import { buildClientMessageReport, buildWeeklyMessageReport, buildDailyReportSummary, buildTeamWeeklyReport, formatCurrency } from './domain/report';
import {
  USER_ROLES,
  addUser,
  authenticateUser,
  deleteUser,
  updateUser,
  loadUsers,
  saveUsers,
} from './domain/userStore';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Panel error:', error, info); }
  render() {
    if (this.state.error) return (
      <div className="panel" style={{margin:16,padding:24,borderColor:'var(--negative)'}}>
        <strong style={{color:'var(--negative)'}}>Something went wrong in this panel.</strong>
        <p className="muted" style={{marginTop:6,fontSize:12}}>{String(this.state.error)}</p>
        <button className="secondary-button" style={{marginTop:10}} onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}

const STATIC_TABS = ['Activity', 'Tasks', 'Credentials & Notes', 'Price Checks', 'Stack Playbook'];

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

function lastContactDaysAgo(client) {
  const log = client.activityLog || [];
  if (!log.length) return null;
  const latest = log.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  if (!latest.createdAt) return null;
  const diff = Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / 86400000);
  return diff;
}

function buildTodayActions(client, dailyImport) {
  const today = todayIsoDate();
  const actions = [];

  // Overdue tasks
  const overdue = (client.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate < today);
  for (const t of overdue.slice(0, 3)) {
    actions.push({ severity: 'critical', icon: '⏰', text: `Overdue: ${t.text.slice(0, 80)}${t.text.length > 80 ? '…' : ''}` });
  }

  // Tasks due today
  const dueToday = (client.tasks || []).filter((t) => !t.done && t.dueDate === today);
  for (const t of dueToday.slice(0, 2)) {
    actions.push({ severity: 'warning', icon: '📋', text: `Due today: ${t.text.slice(0, 80)}${t.text.length > 80 ? '…' : ''}` });
  }

  // Critical flags
  const critFlags = (dailyImport?.flags || []).filter((f) => f.severity === 'Critical' && f.status !== 'Resolved');
  for (const f of critFlags.slice(0, 2)) {
    actions.push({ severity: 'critical', icon: '🚨', text: `Flag: ${f.message.slice(0, 90)}${f.message.length > 90 ? '…' : ''}` });
  }

  // No close today
  if (!dailyImport) {
    actions.push({ severity: 'warning', icon: '📂', text: `No daily close uploaded yet for ${today}` });
  }

  // Payout alerts
  if (dailyImport) {
    const payouts = buildPayoutAlerts(client, dailyImport);
    for (const p of payouts.filter((x) => x.ready).slice(0, 2)) {
      actions.push({ severity: 'info-green', icon: '💰', text: `Payout ready: ${p.alias} reached ${Math.round((p.profit / p.target) * 100)}% of target` });
    }
  }

  // Unclassified accounts
  if (dailyImport) {
    const unassigned = (dailyImport.snapshots || []).filter((s) => {
      const meta = { ...(dailyImport.accounts || {}), ...(client.accountRegistry || {}) }[s.accountName];
      return !meta || meta.accountType === 'Unassigned' || !meta.accountType;
    });
    if (unassigned.length) {
      actions.push({ severity: 'warning', icon: '📂', text: `${unassigned.length} account${unassigned.length > 1 ? 's' : ''} unclassified — go to Review tab to assign type` });
    }
  }

  // Funded accounts with no active strategy
  if (dailyImport) {
    const registry = { ...(dailyImport.accounts || {}), ...(client.accountRegistry || {}) };
    const noStrat = (dailyImport.snapshots || []).filter((s) => {
      const meta = registry[s.accountName];
      if (meta?.accountType !== 'Funded') return false;
      const active = (s.strategies || []).filter((st) => st.enabled);
      return active.length === 0;
    });
    for (const s of noStrat.slice(0, 2)) {
      const alias = registry[s.accountName]?.alias || s.accountName;
      actions.push({ severity: 'warning', icon: '⚙️', text: `No active strategy on ${alias} — check Stack Playbook` });
    }
  }

  return actions;
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

function buildLifetimeStats(client) {
  const imports = client.dailyImports || [];
  if (!imports.length) return null;
  const dailyPnls = imports.map(di =>
    (di.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0)
  );
  const totalPnl = dailyPnls.reduce((s, v) => s + v, 0);
  const positiveDays = dailyPnls.filter(v => v > 0).length;
  const negativeDays = dailyPnls.filter(v => v < 0).length;
  const bestDay = Math.max(...dailyPnls);
  const worstDay = Math.min(...dailyPnls);
  const bestDayDate = imports[dailyPnls.indexOf(bestDay)]?.date;
  const worstDayDate = imports[dailyPnls.indexOf(worstDay)]?.date;
  const winRate = imports.length ? Math.round((positiveDays / imports.length) * 100) : 0;
  const avgDay = imports.length ? totalPnl / imports.length : 0;

  // Current positive/negative streak
  let streak = 0;
  let streakType = null;
  for (let i = dailyPnls.length - 1; i >= 0; i--) {
    const positive = dailyPnls[i] > 0;
    if (streakType === null) { streakType = positive; streak = 1; }
    else if (positive === streakType) streak++;
    else break;
  }

  const profile = client.profile || {};
  const startDate = profile.startDate || imports[0]?.date;
  const daysSinceStart = startDate
    ? Math.floor((Date.now() - new Date(startDate + 'T12:00:00').getTime()) / 86400000)
    : null;

  return {
    totalDays: imports.length, totalPnl, positiveDays, negativeDays,
    winRate, avgDay, bestDay, worstDay, bestDayDate, worstDayDate,
    streak, streakType, daysSinceStart, startDate,
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

// Full historical strategy effectiveness — aggregates across all dailyImports
function buildStrategyEffectiveness(clients = []) {
  // stratName → { totalPnl, days: [{date,pnl}], winDays, lossDays, accountSet, clientSet, last7Pnl }
  const stratMap = new Map();

  for (const client of clients) {
    for (const di of client.dailyImports || []) {
      for (const snapshot of di.snapshots || []) {
        const enabledCount = (snapshot.strategies || []).filter((s) => s.enabled).length || 1;
        for (const strategy of snapshot.strategies || []) {
          if (!strategy.enabled) continue;
          const key = strategy.strategyFamily || strategy.strategyName || 'Unknown';
          const realized = Number(strategy.realized || 0);
          const accountContrib = Number(snapshot.grossRealizedPnl || 0) / enabledCount;
          if (!stratMap.has(key)) {
            stratMap.set(key, { name: key, totalPnl: 0, contributions: [], winDays: 0, lossDays: 0, accountSet: new Set(), clientSet: new Set() });
          }
          const entry = stratMap.get(key);
          entry.totalPnl += realized || accountContrib;
          entry.contributions.push({ date: di.date, pnl: realized || accountContrib });
          if ((realized || accountContrib) > 0) entry.winDays += 1;
          else if ((realized || accountContrib) < 0) entry.lossDays += 1;
          entry.accountSet.add(snapshot.accountName);
          entry.clientSet.add(client.name);
        }
      }
    }
  }

  const cutoff7 = new Date();
  cutoff7.setDate(cutoff7.getDate() - 7);
  const cutoff7Str = cutoff7.toISOString().slice(0, 10);

  return [...stratMap.values()].map((e) => {
    const last7 = e.contributions.filter((c) => c.date >= cutoff7Str).reduce((s, c) => s + c.pnl, 0);
    const total = e.winDays + e.lossDays;
    const winRate = total ? Math.round((e.winDays / total) * 100) : 0;
    const avgPerDay = total ? e.totalPnl / total : 0;
    // trend: last7 vs prior 7
    const cutoff14Str = new Date(cutoff7.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const prior7 = e.contributions.filter((c) => c.date >= cutoff14Str && c.date < cutoff7Str).reduce((s, c) => s + c.pnl, 0);
    const trend = last7 - prior7;
    return {
      name: e.name,
      totalPnl: e.totalPnl,
      last7Pnl: last7,
      prior7Pnl: prior7,
      trend,
      winDays: e.winDays,
      lossDays: e.lossDays,
      winRate,
      avgPerDay,
      accounts: e.accountSet.size,
      clients: e.clientSet.size,
      days: total,
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);
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

// Monthly P&L grouped by account — includes active strategy families per account
function buildMonthlyByAccount(client) {
  const byMonth = {};
  for (const di of client.dailyImports || []) {
    const month = di.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = {};
    const registry = { ...(di.accounts || {}), ...(client.accountRegistry || {}) };
    for (const snapshot of di.snapshots || []) {
      const alias = registry[snapshot.accountName]?.alias || snapshot.accountName;
      if (!byMonth[month][snapshot.accountName]) {
        byMonth[month][snapshot.accountName] = { accountName: snapshot.accountName, alias, pnl: 0, days: 0, strategySet: new Set() };
      }
      byMonth[month][snapshot.accountName].pnl += Number(snapshot.grossRealizedPnl || 0);
      byMonth[month][snapshot.accountName].days += 1;
      for (const strat of snapshot.strategies || []) {
        const name = strat.strategyFamily || strat.strategyName;
        if (name) byMonth[month][snapshot.accountName].strategySet.add(name);
      }
    }
  }
  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, accounts]) => ({
      month,
      accounts: Object.values(accounts)
        .map((a) => ({ ...a, strategies: [...a.strategySet].join(' · ') }))
        .sort((a, b) => b.pnl - a.pnl),
    }));
}

// P&L variance analysis: compare each account to the team average for same strategy
// Returns per-account deviation status (good / average / needs attention)
function buildPnlVarianceAnalysis(client, allClients = []) {
  if (!client) return [];

  // Build cross-client strategy averages from last 7 closes
  const stratAvg = {};
  for (const c of allClients) {
    for (const di of (c.dailyImports || []).slice(-7)) {
      for (const snap of di.snapshots || []) {
        for (const strat of snap.strategies || []) {
          if (!strat.enabled) continue;
          const key = strat.strategyFamily || strat.strategyName || 'Unknown';
          if (!stratAvg[key]) stratAvg[key] = { total: 0, count: 0 };
          stratAvg[key].total += Number(strat.realized || 0);
          stratAvg[key].count += 1;
        }
      }
    }
  }
  const avgByStrat = {};
  for (const [k, v] of Object.entries(stratAvg)) {
    avgByStrat[k] = v.count ? v.total / v.count : 0;
  }

  // Now evaluate each account in this client's latest 7 closes
  const accountMap = {};
  const registry = { ...(client.accountRegistry || {}) };
  const recentImports = (client.dailyImports || []).slice(-7);

  for (const di of recentImports) {
    for (const snap of di.snapshots || []) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType === 'Inactive / Ignore') continue;
      if (!accountMap[snap.accountName]) {
        accountMap[snap.accountName] = {
          accountName: snap.accountName,
          alias: meta.alias || snap.accountName,
          accountType: meta.accountType || '',
          totalActual: 0,
          totalExpected: 0,
          days: 0,
          stratNames: new Set(),
        };
      }
      const entry = accountMap[snap.accountName];
      entry.totalActual += Number(snap.grossRealizedPnl || 0);
      entry.days += 1;
      for (const strat of snap.strategies || []) {
        if (!strat.enabled) continue;
        const key = strat.strategyFamily || strat.strategyName || 'Unknown';
        entry.stratNames.add(key);
        entry.totalExpected += avgByStrat[key] || 0;
      }
    }
  }

  return Object.values(accountMap)
    .filter((a) => a.days >= 2 && a.totalExpected !== 0)
    .map((a) => {
      const variance = a.totalActual - a.totalExpected;
      const variancePct = a.totalExpected !== 0 ? (variance / Math.abs(a.totalExpected)) * 100 : 0;
      let status;
      if (variancePct >= 10) status = 'good';
      else if (variancePct >= -15) status = 'average';
      else status = 'review';
      return {
        ...a,
        strategies: [...a.stratNames].join(' · '),
        variance,
        variancePct: Math.round(variancePct),
        status,
      };
    })
    .sort((a, b) => b.variancePct - a.variancePct);
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

// Detect consistency rule risk: best day > 30% of total positive P&L on a funded account
function buildConsistencyWarnings(client) {
  const warnings = [];
  const registry = client?.accountRegistry || {};
  const funded = Object.values(registry).filter((a) => a.accountType === 'Funded' && a.status !== 'Failed' && a.status !== 'Inactive');

  for (const meta of funded) {
    const pnlByDay = [];
    for (const di of client.dailyImports || []) {
      const snap = (di.snapshots || []).find((s) => s.accountName === meta.accountName);
      if (snap) pnlByDay.push({ date: di.date, pnl: Number(snap.grossRealizedPnl || 0) });
    }
    if (pnlByDay.length < 3) continue;

    const positiveDays = pnlByDay.filter((d) => d.pnl > 0);
    const totalPositive = positiveDays.reduce((s, d) => s + d.pnl, 0);
    if (totalPositive <= 0) continue;

    const bestDay = positiveDays.reduce((best, d) => d.pnl > best.pnl ? d : best, positiveDays[0]);
    const ratio = bestDay.pnl / totalPositive;

    if (ratio > 0.30) {
      warnings.push({
        id: `consistency-${meta.accountName}`,
        alias: meta.alias || meta.accountName,
        accountName: meta.accountName,
        bestDayPnl: bestDay.pnl,
        bestDayDate: bestDay.date,
        totalPositive,
        ratio: Math.round(ratio * 100),
        severity: ratio > 0.50 ? 'Critical' : 'Warning',
      });
    }
  }
  return warnings;
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

// Detect funded accounts that have reached their target profit — payout should be requested
function buildPayoutAlerts(client, dailyImport) {
  if (!client || !dailyImport) return [];
  const registry = { ...(dailyImport.accounts || {}), ...(client.accountRegistry || {}) };
  const alerts = [];
  for (const snap of dailyImport.snapshots || []) {
    const meta = registry[snap.accountName] || {};
    if (meta.accountType !== 'Funded') continue;
    if (meta.status === 'Failed' || meta.status === 'Inactive') continue;
    const target = Number(meta.targetProfit || 0);
    if (!target) continue;
    const balance = Number(snap.accountBalance || 0);
    const startBalance = Number(meta.startBalance || 0);
    const profit = startBalance > 0 ? balance - startBalance : 0;
    const alreadyRequested = meta.payoutState && meta.payoutState !== 'Not requested';
    if (!alreadyRequested && profit >= target * 0.9) {
      alerts.push({
        accountName: snap.accountName,
        alias: meta.alias || snap.accountName,
        profit,
        target,
        pct: Math.round((profit / target) * 100),
        payoutState: meta.payoutState || 'Not requested',
        ready: profit >= target,
      });
    }
  }
  return alerts.sort((a, b) => b.pct - a.pct);
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
      <div className="login-brand">
        <div className="login-logo-mark">V</div>
        <div>
          <div className="login-brand-name">Vincere Trading</div>
          <div className="login-brand-tagline">Drive Insight</div>
        </div>
      </div>
      <section className="login-panel">
        <span className="eyebrow">Client Account Manager Platform</span>
        <h1>Sign in</h1>
        <p>Access your workspace to monitor clients, accounts, and daily performance.</p>
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
          <button className="primary-button" style={{marginTop:4}}>Sign in →</button>
        </form>
        <div className="login-role-pills">
          <div className="login-role-pill">
            <span className="sidebar-role-badge manager-badge">Manager</span>
            <code>manager</code> / <code>demo</code>
          </div>
          <div className="login-role-pill">
            <span className="sidebar-role-badge cam-badge">CAM</span>
            <code>pedro</code> / <code>pedro123</code>
          </div>
        </div>
      </section>
      <div className="login-footer">Vincere CRM · {new Date().getFullYear()} · Drive Insight</div>
    </main>
  );
}

function buildCamPerformance(clients = [], camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const camMap = {};
  for (const cam of camProfiles) {
    camMap[cam.id] = { id: cam.id, name: cam.name, weeklyPnl: 0, dailyPnl: 0, monthlyPnl: 0, funded: 0, evaluations: 0, totalAccounts: 0, openFlags: 0, clients: 0, payoutsThisMonth: 0, payoutsThisMonthCount: 0 };
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
    // Monthly P&L across all imports this month
    for (const di of client.dailyImports || []) {
      if (!di.date?.startsWith(currentMonth)) continue;
      bucket.monthlyPnl += (di.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
    }
    // Payouts this month from accountRegistry
    for (const acct of Object.values(client.accountRegistry || {})) {
      for (const p of acct.payoutHistory || []) {
        if (p.date?.startsWith(currentMonth)) {
          bucket.payoutsThisMonth += Number(p.amount || 0);
          bucket.payoutsThisMonthCount++;
        }
      }
    }
  }

  return Object.values(camMap).sort((a, b) => b.weeklyPnl - a.weeklyPnl);
}

function buildAllFundedAccounts(clients = [], camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.name;
  }
  const rows = [];
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = { ...(latest.accounts || {}), ...(client.accountRegistry || {}) };
    for (const snap of latest.snapshots || []) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType !== 'Funded') continue;
      const ddLimit = Number(meta.maxDrawdownLimit || 0);
      const rawDD = Number(snap.trailingMaxDrawdown || 0);
      const buffer = ddLimit > 0 ? ddLimit - Math.abs(rawDD) : rawDD;
      const bufferPct = ddLimit > 0 ? Math.round((buffer / ddLimit) * 100) : null;
      const target = Number(meta.targetProfit || 0);
      const start = Number(meta.startBalance || 0);
      const balance = Number(snap.accountBalance || 0);
      const profit = start ? balance - start : null;
      const targetPct = (target && start) ? Math.min(100, Math.round(((balance - start) / (target - start)) * 100)) : null;
      rows.push({
        clientId: client.id,
        clientName: client.name,
        camName: clientCam[client.id] || '—',
        accountName: snap.accountName,
        alias: meta.alias || snap.accountName,
        connection: meta.connection || '',
        payoutState: meta.payoutState || '',
        strategies: (snap.strategies || []).filter((s) => s.enabled).map((s) => s.strategyFamily || s.strategyName).join(', ') || 'None',
        dailyPnl: Number(snap.grossRealizedPnl || 0),
        weeklyPnl: Number(snap.weeklyPnl || 0),
        balance,
        buffer,
        bufferPct,
        profit,
        targetPct,
        target,
        status: meta.status || '',
      });
    }
  }
  rows.sort((a, b) => (a.bufferPct !== null && b.bufferPct !== null ? a.bufferPct - b.bufferPct : 0));
  return rows;
}

function buildTeamMessageReport(clients, camProfiles, totals, cams) {
  const today = new Date().toISOString().slice(0, 10);
  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));
  const lines = [];
  lines.push(`📊 *Team Daily Report — ${today}*`);
  lines.push('');
  lines.push(`💰 *Team daily P&L:* ${sign(totals.dailyPnl)}${fmt(totals.dailyPnl)}`);
  lines.push(`📅 *Team weekly P&L:* ${sign(totals.weeklyPnl)}${fmt(totals.weeklyPnl)}`);
  lines.push(`👥 *Clients:* ${totals.clients} · *Accounts:* ${totals.accounts} · *Open flags:* ${totals.flags}`);
  lines.push('');
  for (const cam of cams) {
    lines.push(`*${cam.name}* (${cam.clients} clients · ${cam.accounts} accs)`);
    lines.push(`  Daily: ${sign(cam.dailyPnl)}${fmt(cam.dailyPnl)} · Weekly: ${sign(cam.weeklyPnl)}${fmt(cam.weeklyPnl)}${cam.flags ? ` · ⚠️ ${cam.flags} flags` : ''}`);
    const camClients = clientsForCam(clients, cam);
    for (const c of camClients) {
      const latest = c.dailyImports?.at(-1);
      if (!latest) continue;
      const pnl = (latest.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
      lines.push(`    • ${c.name}: ${sign(pnl)}${fmt(pnl)}`);
    }
  }
  lines.push('');
  lines.push(`_Generated by Vincere CRM · Drive Insight_`);
  return lines.join('\n');
}

function ManagerOverview({ clients, camProfiles = [], onOpenCam, onLoadDemo, onCreateCam, onAddClient, onLogout, users = [], onUsersChange, session, onUpdateClientAccount, onTransferClient, onResolveFlag, teamAnnouncement = '', onSetAnnouncement }) {
  const [newCamName, setNewCamName] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', displayName: '', email: '', role: USER_ROLES.CAM, camProfileId: '' });
  const [editUserId, setEditUserId] = useState(null);
  const [editUserPatch, setEditUserPatch] = useState({});
  const [showUserPanel, setShowUserPanel] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [showPipeline, setShowPipeline] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchImportResult, setBatchImportResult] = useState(null);
  const [drillDate, setDrillDate] = useState('');
  const [teamCopyDone, setTeamCopyDone] = useState(false);
  const [newClientForm, setNewClientForm] = useState({ name: '', camId: '', stage: 'Active' });
  const [showNewClient, setShowNewClient] = useState(false);
  const [fundedSort, setFundedSort] = useState({ col: 'buffer', dir: -1 });
  const [managerSearch, setManagerSearch] = useState('');
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
  const strategyEffectiveness = buildStrategyEffectiveness(clients);
  const lifecycle = buildLifecycleMetrics(clients);
  const riskDist = buildRiskDistribution(clients, camProfiles);
  const camPerf = buildCamPerformance(clients, camProfiles);
  const managerInsights = buildPortfolioInsights(clients, clients);
  const allFunded = buildAllFundedAccounts(clients, camProfiles);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyKpis = (() => {
    let monthlyPnl = 0, payoutAmount = 0, payoutCount = 0, fundedActive = 0;
    const today = todayIsoDate();
    let closedToday = 0, withUploadToday = 0;
    for (const client of clients) {
      for (const di of client.dailyImports || []) {
        if (di.date?.startsWith(currentMonth)) {
          monthlyPnl += (di.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
        }
        if (di.date === today) {
          withUploadToday++;
          if (di.status === 'Closed') closedToday++;
        }
      }
      for (const acct of Object.values(client.accountRegistry || {})) {
        if (acct.accountType === 'Funded' && acct.status !== 'Failed' && acct.status !== 'Inactive') fundedActive++;
        for (const p of acct.payoutHistory || []) {
          if (p.date?.startsWith(currentMonth)) {
            payoutAmount += Number(p.amount || 0);
            payoutCount++;
          }
        }
      }
    }
    return { monthlyPnl, payoutAmount, payoutCount, fundedActive, closedToday, withUploadToday };
  })();

  function submitCam(event) {
    event.preventDefault();
    onCreateCam(newCamName);
    setNewCamName('');
  }

  function submitNewUser(event) {
    event.preventDefault();
    if (!newUser.username || !newUser.password || !newUser.displayName) return;
    onUsersChange(addUser(users, newUser));
    setNewUser({ username: '', password: '', displayName: '', email: '', role: USER_ROLES.CAM, camProfileId: '' });
  }

  function saveUserEdit(userId) {
    onUsersChange(updateUser(users, userId, editUserPatch));
    setEditUserId(null);
    setEditUserPatch({});
  }

  const healthScore = (() => {
    if (!clients.length) return null;
    let score = 100;
    const today = todayIsoDate();
    // Deduct for unclosed clients with uploads
    const withUpload = clients.filter(c => getClientImportByDate(c, today));
    const unclosed = withUpload.filter(c => getClientImportByDate(c, today)?.status !== 'Closed').length;
    if (withUpload.length) score -= Math.round((unclosed / withUpload.length) * 25);
    // Deduct for critical flags
    const critFlags = clients.reduce((n, c) => n + ((c.dailyImports?.at(-1)?.flags || []).filter(f => f.severity === 'Critical' && f.status !== 'Resolved').length), 0);
    score -= Math.min(critFlags * 5, 25);
    // Deduct for overdue tasks
    const overdueTasks = clients.reduce((n, c) => n + (c.tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < today).length, 0);
    score -= Math.min(overdueTasks * 3, 20);
    // Deduct for accounts at critical drawdown (buffer <= 10%)
    const critBufferAccounts = allFunded.filter(r => r.bufferPct !== null && r.bufferPct <= 10).length;
    score -= Math.min(critBufferAccounts * 5, 20);
    const clamped = Math.max(0, Math.min(100, score));
    const label = clamped >= 85 ? 'Excellent' : clamped >= 70 ? 'Good' : clamped >= 50 ? 'Fair' : 'At Risk';
    const color = clamped >= 85 ? 'var(--green)' : clamped >= 70 ? 'var(--accent)' : clamped >= 50 ? '#f59e0b' : 'var(--negative)';
    return { score: clamped, label, color };
  })();

  return (
    <main className="manager-shell">
      <aside className="manager-sidebar">
        <div className="manager-sidebar-header">
          <span className="sidebar-role-badge manager-badge">Manager</span>
          <strong>Vincere CRM</strong>
          <small className="sidebar-role-sub">{session?.displayName || session?.username || 'Manager'}</small>
        </div>
        <button className="client-link active"><Users size={16} /><span>Operations</span><em>Live</em></button>
        <input
          className="client-search"
          value={managerSearch}
          placeholder="Search clients..."
          onChange={e => setManagerSearch(e.target.value)}
          style={{margin:'8px 8px 4px'}}
        />
        {managerSearch.length >= 2 ? (() => {
          const q = managerSearch.toLowerCase();
          const results = clients.flatMap(c => {
            const cam = camProfiles.find(p => (p.clientIds || []).includes(c.id));
            const nameMatch = c.name?.toLowerCase().includes(q);
            const accountMatch = Object.keys(c.accountRegistry || {}).some(k => k.toLowerCase().includes(q) || (c.accountRegistry[k].alias || '').toLowerCase().includes(q));
            if (!nameMatch && !accountMatch) return [];
            return [{ client: c, cam, nameMatch, accountMatch }];
          });
          return results.length ? results.map(({ client, cam }) => (
            <button key={client.id} className="client-link client-link-search" onClick={() => { onOpenCam(cam?.id, client.id); setManagerSearch(''); }}>
              <span>{client.name}</span>
              <small className="muted">{cam?.name || '—'}</small>
            </button>
          )) : <div className="nav-label muted" style={{padding:'4px 12px',fontSize:12}}>No match</div>;
        })() : cams.map((cam) => (
          <button className="client-link" key={cam.id} onClick={() => onOpenCam(cam.id)}>
            <BarChart3 size={16} />
            <span>{cam.name}</span>
            <em className={cam.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.dailyPnl)}</em>
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
            <span className="eyebrow">Vincere Trading · {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            <h1>Operations Command Center</h1>
            <div className="occ-status-row">
              <span className="occ-live-dot" />
              <span>{cams.length} CAMs active · {totals.clients} clients · {totals.accounts} accounts tracked</span>
              {totals.flags > 0 && <span className="negative">· {totals.flags} open flag{totals.flags !== 1 ? 's' : ''}</span>}
            </div>
          </div>
          <div className="header-actions">
            <button className={showNewClient ? 'secondary-button' : 'ghost-button'} onClick={() => setShowNewClient(v => !v)}>+ New Client</button>
            <button className={showPipeline ? 'secondary-button' : 'ghost-button'} onClick={() => setShowPipeline(v => !v)}>📋 Pipeline</button>
            <button className={showBatchImport ? 'secondary-button' : 'ghost-button'} onClick={() => { setShowBatchImport(v => !v); setBatchImportResult(null); }}>⬆ Batch Import</button>
            <button className="ghost-button" onClick={() => { const txt = buildTeamWeeklyReport(clients, camProfiles); navigator.clipboard.writeText(txt).then(() => alert('Weekly team summary copied!')); }} title="Copy weekly team summary for Slack / email">📋 Weekly Report</button>
            <button className="secondary-button" onClick={() => { if (window.confirm('Reset all data to demo state? This will erase any changes made during this session.')) onLoadDemo(); }}><Download size={16} /> Reload Demo</button>
            <button className="ghost-button" onClick={() => {
              const report = buildTeamMessageReport(clients, camProfiles, totals, cams);
              navigator.clipboard.writeText(report).then(() => { setTeamCopyDone(true); setTimeout(() => setTeamCopyDone(false), 2000); });
            }} title="Copy team daily report for WhatsApp/Telegram">
              <Copy size={16} />{teamCopyDone ? ' Copied!' : ' Copy Team Report'}
            </button>
            <button className="primary-button" onClick={() => onOpenCam(cams[0]?.id || 'am-pedro')}><BarChart3 size={16} /> Open {cams[0]?.name || 'Pedro'}'s Workspace</button>
          </div>
        </div>

        <div className="metric-grid">
          <div className="metric"><span>Team daily P&L</span><strong className={totals.dailyPnl >= 0 ? 'positive' : 'negative'} style={{fontSize:22}}>{formatCurrency(totals.dailyPnl)}</strong></div>
          <div className="metric"><span>Team weekly P&L</span><strong className={totals.weeklyPnl >= 0 ? 'positive' : 'negative'} style={{fontSize:22}}>{formatCurrency(totals.weeklyPnl)}</strong></div>
          <div className="metric"><span>Monthly P&L ({currentMonth})</span><strong className={monthlyKpis.monthlyPnl >= 0 ? 'positive' : 'negative'} style={{fontSize:22}}>{formatCurrency(monthlyKpis.monthlyPnl)}</strong></div>
          <div className="metric"><span>Payouts this month</span><strong className="positive" style={{fontSize:22}}>{formatCurrency(monthlyKpis.payoutAmount)}</strong><small className="muted">×{monthlyKpis.payoutCount}</small></div>
          <div className="metric"><span>Funded accounts active</span><strong style={{fontSize:22}}>{monthlyKpis.fundedActive}</strong></div>
          <div className="metric"><span>Closes today</span><strong style={{fontSize:22}}>{monthlyKpis.closedToday}<span style={{fontSize:14,fontWeight:400,color:'var(--muted)'}}> / {monthlyKpis.withUploadToday}</span></strong></div>
          <div className="metric"><span>Clients</span><strong>{totals.clients}</strong></div>
          <div className="metric"><span>Open flags</span><strong className={totals.flags ? 'negative' : ''}>{totals.flags}</strong></div>
          {healthScore && (
            <div className="metric" style={{borderColor: healthScore.color, background:`${healthScore.color}0d`}}>
              <span>Portfolio health</span>
              <strong style={{fontSize:28, color: healthScore.color}}>{healthScore.score}</strong>
              <small style={{color: healthScore.color, fontWeight:600}}>{healthScore.label}</small>
            </div>
          )}
        </div>

        {teamAnnouncement && (
          <div className="team-announcement-banner">
            <span>📢</span>
            <span style={{flex:1}}>{teamAnnouncement}</span>
            <button className="ghost-button" style={{fontSize:11}} onClick={() => { onSetAnnouncement?.(''); setAnnouncementDraft(''); }}>✕ Clear</button>
          </div>
        )}
        <form className="team-announcement-form" onSubmit={e => { e.preventDefault(); onSetAnnouncement?.(announcementDraft.trim()); }}>
          <input value={announcementDraft} onChange={e => setAnnouncementDraft(e.target.value)} placeholder="📢 Post team announcement (visible to all CAMs)…" />
          {announcementDraft.trim() && <button type="submit" className="primary-button" style={{padding:'5px 12px',fontSize:12}}>Post</button>}
        </form>

        {showNewClient && (
          <section className="panel" style={{maxWidth:480}}>
            <div className="panel-heading"><h3>Add new client</h3></div>
            <form className="form-grid" style={{padding:'4px 0 8px'}} onSubmit={e => {
              e.preventDefault();
              if (!newClientForm.name.trim()) return;
              onAddClient?.(newClientForm.name.trim(), newClientForm.camId, newClientForm.stage);
              setNewClientForm({ name: '', camId: '', stage: 'Active' });
              setShowNewClient(false);
            }}>
              <label>Client name *<input autoFocus value={newClientForm.name} onChange={e => setNewClientForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Carlos M." /></label>
              <label>Assign to CAM
                <select value={newClientForm.camId} onChange={e => setNewClientForm(f => ({...f, camId: e.target.value}))}>
                  <option value="">— Unassigned —</option>
                  {camProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label>Stage
                <select value={newClientForm.stage} onChange={e => setNewClientForm(f => ({...f, stage: e.target.value}))}>
                  {['Onboarding','Active','At Risk','Paused','Inactive'].map(s => <option key={s}>{s}</option>)}
                </select>
              </label>
              <div style={{display:'flex',gap:8,gridColumn:'1/-1',marginTop:4}}>
                <button type="submit" className="primary-button" disabled={!newClientForm.name.trim()}>Create client</button>
                <button type="button" className="ghost-button" onClick={() => setShowNewClient(false)}>Cancel</button>
              </div>
            </form>
          </section>
        )}

        {showPipeline && (() => {
          const STAGES = ['Onboarding', 'Active', 'At Risk', 'Paused', 'Inactive'];
          const byStage = {};
          STAGES.forEach(s => byStage[s] = []);
          for (const client of clients) {
            const stage = client.profile?.stage || 'Active';
            const cam = camProfiles.find(p => (p.clientIds || []).includes(client.id));
            const latest = client.dailyImports?.at(-1);
            const pnl = (latest?.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
            const openTasks = (client.tasks || []).filter(t => !t.done).length;
            const openFlags = (latest?.flags || []).filter(f => f.status !== 'Resolved').length;
            (byStage[stage] || (byStage[stage] = [])).push({ client, cam, pnl, openTasks, openFlags });
          }
          return (
            <section className="panel">
              <div className="panel-heading"><h3>Client pipeline</h3><span className="badge muted">by stage · click to open</span></div>
              <div className="pipeline-board">
                {STAGES.map(stage => {
                  const cards = byStage[stage] || [];
                  return (
                    <div key={stage} className="pipeline-column">
                      <div className="pipeline-col-header">
                        <span>{stage}</span>
                        <span className="count">{cards.length}</span>
                      </div>
                      {cards.length === 0 ? <div className="pipeline-empty muted">—</div> : cards.map(({ client, cam, pnl, openTasks, openFlags }) => (
                        <div key={client.id} className={`pipeline-card${openFlags > 0 ? ' pipeline-card-flag' : ''}`} onClick={() => onOpenCam(cam?.id, client.id)}>
                          <strong>{client.name}</strong>
                          <small className="muted">{cam?.name || 'Unassigned'}</small>
                          <div className="pipeline-card-chips">
                            <span className={pnl >= 0 ? 'positive' : 'negative'} style={{fontSize:11}}>{formatCurrency(pnl)}</span>
                            {openFlags > 0 && <span className="task-chip task-chip-high" style={{fontSize:10}}>{openFlags} flag{openFlags !== 1 ? 's' : ''}</span>}
                            {openTasks > 0 && <span className="task-chip" style={{fontSize:10}}>{openTasks} task{openTasks !== 1 ? 's' : ''}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })()}

        {showBatchImport && (
          <section className="panel">
            <div className="panel-heading"><h3>Batch import — all clients</h3><span className="badge muted">Drop NT CSV files from any client</span></div>
            <p className="muted" style={{fontSize:12,marginBottom:10}}>Upload accounts + strategies CSVs from multiple clients at once. The system matches each account to its registered client automatically.</p>
            <div className="batch-drop-zone" onDragOver={e => e.preventDefault()} onDrop={async e => {
              e.preventDefault();
              const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.csv'));
              if (!files.length) { setBatchImportResult({ error: 'No CSV files found. Drop NinjaTrader .csv export files here.' }); return; }
              const today = new Date().toISOString().slice(0, 10);
              const parsed = [];
              for (const f of files) {
                try {
                  const text = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f); });
                  parsed.push(parseNinjaTraderCsvText(text, f.name));
                } catch { /* skip unreadable file */ }
              }
              const grouped = parsed.reduce((acc, p) => { if (p.type !== 'unknown') acc[p.type] = [...(acc[p.type] || []), ...p.rows]; return acc; }, {});
              const accountNames = new Set((grouped.accounts || []).map(a => a.accountName));
              if (!accountNames.size) { setBatchImportResult({ error: 'No account data found in the uploaded files. Make sure to include the NT Accounts CSV.' }); return; }
              const clientMatches = clients.map(client => {
                const myAccounts = Object.keys(client.accountRegistry || {}).filter(an => accountNames.has(an));
                if (!myAccounts.length) return null;
                const filteredGrouped = {
                  accounts: (grouped.accounts || []).filter(a => myAccounts.includes(a.accountName)),
                  strategies: (grouped.strategies || []).filter(a => myAccounts.includes(a.accountName)),
                  orders: (grouped.orders || []).filter(a => myAccounts.includes(a.accountName)),
                  executions: (grouped.executions || []).filter(a => myAccounts.includes(a.accountName)),
                };
                try {
                  const result = reconcileDailyImport({ clientId: client.id, date: today, registry: client.accountRegistry, parsed: filteredGrouped });
                  return { client, result, accountCount: myAccounts.length };
                } catch { return null; }
              }).filter(Boolean);
              const unmatched = [...accountNames].filter(an => !clients.some(c => Object.keys(c.accountRegistry || {}).includes(an)));
              setBatchImportResult({ clientMatches, unmatched, today, filesLoaded: files.length });
            }}>
              <span>Drag & drop NT CSV files here</span>
              <small className="muted">accounts + strategies + orders + executions from any number of clients</small>
              <label style={{cursor:'pointer',fontSize:12,color:'var(--accent)',marginTop:4}}>
                or <span style={{textDecoration:'underline'}}>click to browse</span>
                <input type="file" accept=".csv" multiple style={{display:'none'}} onChange={async ev => {
                  const files = [...ev.target.files];
                  ev.target.value = '';
                  if (!files.length) return;
                  const today = new Date().toISOString().slice(0, 10);
                  const parsed = [];
                  for (const f of files) {
                    try { const text = await new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(String(r.result)); r.onerror=rej; r.readAsText(f); }); parsed.push(parseNinjaTraderCsvText(text, f.name)); } catch {}
                  }
                  const grouped = parsed.reduce((acc,p) => { if (p.type!=='unknown') acc[p.type]=[...(acc[p.type]||[]),...p.rows]; return acc; }, {});
                  const accountNames = new Set((grouped.accounts||[]).map(a=>a.accountName));
                  if (!accountNames.size) { setBatchImportResult({ error: 'No account data found.' }); return; }
                  const clientMatches = clients.map(client => { const myAccounts=Object.keys(client.accountRegistry||{}).filter(an=>accountNames.has(an)); if (!myAccounts.length) return null; const fg={accounts:(grouped.accounts||[]).filter(a=>myAccounts.includes(a.accountName)),strategies:(grouped.strategies||[]).filter(a=>myAccounts.includes(a.accountName)),orders:(grouped.orders||[]).filter(a=>myAccounts.includes(a.accountName)),executions:(grouped.executions||[]).filter(a=>myAccounts.includes(a.accountName))}; try { return {client,result:reconcileDailyImport({clientId:client.id,date:today,registry:client.accountRegistry,parsed:fg}),accountCount:myAccounts.length}; } catch { return null; } }).filter(Boolean);
                  setBatchImportResult({ clientMatches, unmatched:[...accountNames].filter(an=>!clients.some(c=>Object.keys(c.accountRegistry||{}).includes(an))), today, filesLoaded:files.length });
                }} />
              </label>
            </div>
            {batchImportResult?.error && <div className="notice error" style={{marginTop:8}}>{batchImportResult.error}</div>}
            {batchImportResult && !batchImportResult.error && (
              <div style={{marginTop:12}}>
                <p className="muted" style={{fontSize:12}}><strong className="positive">{batchImportResult.clientMatches.length} clients matched</strong>{batchImportResult.unmatched?.length > 0 ? <span className="negative"> · {batchImportResult.unmatched.length} unregistered accounts: {batchImportResult.unmatched.join(', ')}</span> : null}{batchImportResult.filesLoaded ? <span> · {batchImportResult.filesLoaded} files loaded</span> : null}</p>
                <table className="ops-table" style={{marginTop:8}}>
                  <thead><tr><th>Client</th><th>Accounts found</th><th>Flags</th><th>Action</th></tr></thead>
                  <tbody>
                    {batchImportResult.clientMatches.map(({ client, result, accountCount }) => (
                      <tr key={client.id}>
                        <td><strong>{client.name}</strong></td>
                        <td>{accountCount}</td>
                        <td>{(result.flags || []).filter(f => f.severity === 'Critical').length > 0 ? <span className="negative">{(result.flags || []).filter(f => f.severity === 'Critical').length} critical</span> : <span className="positive">{(result.flags || []).length} flags</span>}</td>
                        <td><button className="primary-button" style={{padding:'3px 10px',fontSize:11}} onClick={() => {
                          setState(s => appendDailyImport(s, client.id, result));
                          setBatchImportResult(prev => ({ ...prev, clientMatches: prev.clientMatches.filter(m => m.client.id !== client.id) }));
                        }}>Import</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {batchImportResult.clientMatches.length > 1 && (
                  <button className="secondary-button" style={{marginTop:8}} onClick={() => {
                    batchImportResult.clientMatches.forEach(({ client, result }) => setState(s => appendDailyImport(s, client.id, result)));
                    setBatchImportResult(null); setShowBatchImport(false);
                  }}>Import all {batchImportResult.clientMatches.length} clients</button>
                )}
              </div>
            )}
          </section>
        )}

        <InsightFeedPanel insights={managerInsights} onSelectClient={onOpenCam} />

        {(() => {
          const allFlags = clients.flatMap(c =>
            (c.dailyImports || []).flatMap(di =>
              (di.flags || [])
                .filter(f => f.status !== 'Resolved')
                .map(f => {
                  const cam = camProfiles.find(p => (p.clientIds || []).includes(c.id));
                  return { ...f, clientName: c.name, clientId: c.id, importId: di.id, camId: cam?.id, camName: cam?.name, date: di.date };
                })
            )
          ).sort((a, b) => {
            if (a.severity === 'Critical' && b.severity !== 'Critical') return -1;
            if (b.severity === 'Critical' && a.severity !== 'Critical') return 1;
            return (b.date || '').localeCompare(a.date || '');
          });
          if (!allFlags.length) return null;
          const critCount = allFlags.filter(f => f.severity === 'Critical').length;
          return (
            <section className="panel">
              <div className="panel-heading">
                <h3>Open flags — all clients</h3>
                <span className={`badge ${critCount ? 'danger' : 'warning'}`}>{allFlags.length} open{critCount ? ` · ${critCount} critical` : ''}</span>
              </div>
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead><tr><th>Client</th><th>CAM</th><th>Date</th><th>Severity</th><th>Flag</th><th></th></tr></thead>
                  <tbody>
                    {allFlags.map((f, i) => (
                      <tr key={i} style={f.severity === 'Critical' ? {background:'var(--red-dim, rgba(239,68,68,.06))'} : undefined}>
                        <td><button className="link-button" onClick={() => onOpenCam(f.camId, f.clientId)}>{f.clientName}</button></td>
                        <td className="muted">{f.camName || '—'}</td>
                        <td className="muted">{f.date}</td>
                        <td><span className={`badge ${f.severity === 'Critical' ? 'danger' : 'warning'}`}>{f.severity}</span></td>
                        <td>{f.message || f.type || '—'}</td>
                        <td>{onResolveFlag && <button className="ghost-button" style={{fontSize:11,padding:'2px 8px',whiteSpace:'nowrap'}} onClick={() => onResolveFlag(f.clientId, f.importId, f.id)}>✓ Resolve</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

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

        {allFunded.length > 0 && (
          <section className="panel">
            <div className="panel-heading">
              <h3>All funded accounts</h3>
              <span className="badge muted">{allFunded.length} accounts</span>
              <button className="ghost-button" style={{marginLeft:'auto'}} title="Export to CSV" onClick={() => {
                const headers = ['Account','Alias','Client','CAM','Strategies','Daily PnL','Weekly PnL','Buffer','Buffer %','Target %','Payout State'];
                const rows = allFunded.map(r => [
                  r.accountName, r.alias, r.clientName, r.camName, r.strategies,
                  r.dailyPnl.toFixed(2), r.weeklyPnl.toFixed(2),
                  r.buffer.toFixed(2), r.bufferPct !== null ? r.bufferPct : '',
                  r.targetPct !== null ? r.targetPct : '', r.payoutState || '',
                ]);
                const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                a.download = `funded-accounts-${new Date().toISOString().slice(0,10)}.csv`;
                a.click();
              }}><Download size={14} /> Export CSV</button>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  {(() => {
                    const SortTh = ({ col, label }) => {
                      const active = fundedSort.col === col;
                      return (
                        <th style={{cursor:'pointer',userSelect:'none',whiteSpace:'nowrap'}} onClick={() => setFundedSort(s => s.col === col ? { col, dir: -s.dir } : { col, dir: -1 })}>
                          {label}{active ? (fundedSort.dir === -1 ? ' ↓' : ' ↑') : ' ·'}
                        </th>
                      );
                    };
                    return (
                      <tr>
                        <th>Account</th>
                        <SortTh col="client" label="Client" />
                        <th>CAM</th>
                        <th>Strategies</th>
                        <SortTh col="dailyPnl" label="Daily PnL" />
                        <SortTh col="weeklyPnl" label="Weekly PnL" />
                        <SortTh col="buffer" label="Buffer" />
                        <SortTh col="targetPct" label="Target" />
                        <th>Payout</th>
                        <th></th>
                      </tr>
                    );
                  })()}
                </thead>
                <tbody>
                  {[...allFunded].sort((a, b) => {
                    const { col, dir } = fundedSort;
                    const av = col === 'client' ? (a.clientName || '') : (a[col] ?? -Infinity);
                    const bv = col === 'client' ? (b.clientName || '') : (b[col] ?? -Infinity);
                    if (typeof av === 'string') return dir * av.localeCompare(bv);
                    return dir * (bv - av);
                  }).map((row) => (
                    <tr key={row.accountName} className={row.bufferPct !== null && row.bufferPct <= 20 ? 'row-highlight' : ''} style={{cursor:'pointer'}} onClick={() => { const cam = camProfiles.find(c => c.clientIds?.includes(row.clientId)); onOpenCam(cam?.id, row.clientId); }}>
                      <td><strong>{row.alias}</strong><small>{row.connection}</small></td>
                      <td>{row.clientName}</td>
                      <td><small>{row.camName}</small></td>
                      <td><small>{row.strategies}</small></td>
                      <td className={row.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.dailyPnl)}</td>
                      <td className={row.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.weeklyPnl)}</td>
                      <td className={row.bufferPct !== null ? (row.bufferPct <= 20 ? 'negative' : row.bufferPct <= 50 ? '' : 'positive') : ''}>
                        {row.bufferPct !== null ? `${formatCurrency(row.buffer)} (${row.bufferPct}%)` : row.buffer > 0 ? formatCurrency(row.buffer) : '—'}
                      </td>
                      <td>{row.targetPct !== null ? <div className="target-progress" style={{minWidth:80}}><div className="target-bar"><i style={{width:`${row.targetPct}%`,background:row.targetPct>=100?'var(--green)':row.targetPct>=80?'#f59e0b':'var(--accent)'}}/></div><small>{row.targetPct}%</small></div> : '—'}</td>
                      <td><small className={row.payoutState === 'Clear to trade' ? 'positive' : row.payoutState?.includes('requested') ? '' : 'muted'}>{row.payoutState || '—'}</small></td>
                      <td onClick={e => e.stopPropagation()}>
                        {row.bufferPct !== null && row.bufferPct <= 5 && onUpdateClientAccount ? (
                          <button className="ghost-button" style={{color:'var(--negative)',fontSize:11,padding:'2px 6px',whiteSpace:'nowrap'}}
                            onClick={() => {
                              if (!window.confirm(`Mark ${row.alias} as FAILED?\n\nThis sets status=Failed and dateFailed=today. Cannot be undone from this view.`)) return;
                              onUpdateClientAccount(row.clientId, row.accountName, { status: 'Failed', dateFailed: todayIsoDate() });
                            }}>✕ Mark Failed</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

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

        <section className="panel">
          <div className="panel-heading"><h3>Strategy Effectiveness Leaderboard</h3><span className="badge muted">All history — total P&amp;L, win rate, 7-day trend</span></div>
          {strategyEffectiveness.length ? (
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Strategy</th>
                    <th>Total P&amp;L</th>
                    <th>Avg/Day</th>
                    <th>Win Rate</th>
                    <th>Days</th>
                    <th>Accounts</th>
                    <th>Last 7d</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyEffectiveness.map((s, i) => (
                    <tr key={s.name}>
                      <td className="muted">{i + 1}</td>
                      <td><strong>{s.name}</strong><small>{s.clients} client{s.clients !== 1 ? 's' : ''}</small></td>
                      <td className={s.totalPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(s.totalPnl)}</td>
                      <td className={s.avgPerDay >= 0 ? 'positive' : 'negative'}>{formatCurrency(s.avgPerDay)}</td>
                      <td className={s.winRate >= 60 ? 'positive' : s.winRate >= 40 ? '' : 'negative'}>{s.winRate}%</td>
                      <td>{s.days}</td>
                      <td>{s.accounts}</td>
                      <td className={s.last7Pnl >= 0 ? 'positive' : 'negative'}>{s.last7Pnl >= 0 ? '+' : ''}{formatCurrency(s.last7Pnl)}</td>
                      <td className={s.trend >= 0 ? 'positive' : 'negative'}>{s.trend >= 0 ? '▲' : '▼'} {formatCurrency(Math.abs(s.trend))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted" style={{padding:'16px'}}>No strategy history available yet.</p>}
        </section>

        <section className="overview-grid">
          <div className="panel">
            <div className="panel-heading"><h3>Latest close snapshot</h3><span className="count">Score 0–10</span></div>
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
                    <th>Funded</th>
                    <th>Evals</th>
                    <th>Daily P&amp;L</th>
                    <th>Weekly P&amp;L</th>
                    <th>Monthly P&amp;L</th>
                    <th>Payouts (mo.)</th>
                    <th>Open flags</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {camPerf.map((cam, i) => {
                    const camUser = (users || []).find(u => u.camProfileId === cam.id);
                    const lastActive = camUser?.lastActiveAt;
                    const lastActiveLabel = (() => {
                      if (!lastActive) return '—';
                      const mins = Math.round((Date.now() - new Date(lastActive)) / 60000);
                      if (mins < 2) return 'Just now';
                      if (mins < 60) return `${mins}m ago`;
                      const hrs = Math.round(mins / 60);
                      if (hrs < 24) return `${hrs}h ago`;
                      return `${Math.round(hrs / 24)}d ago`;
                    })();
                    const isRecent = lastActive && (Date.now() - new Date(lastActive)) < 3600000;
                    return (
                    <tr key={cam.id} className={cam.openFlags >= 3 ? 'row-warning' : ''}>
                      <td><span className="rank-badge">{i + 1}</span></td>
                      <td><strong>{cam.name}</strong></td>
                      <td>{cam.clients}</td>
                      <td>{cam.funded}</td>
                      <td>{cam.evaluations}</td>
                      <td className={cam.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.dailyPnl)}</td>
                      <td className={cam.weeklyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(cam.weeklyPnl)}</td>
                      <td className={cam.monthlyPnl >= 0 ? 'positive' : 'negative'}><strong>{formatCurrency(cam.monthlyPnl)}</strong></td>
                      <td className="positive">{cam.payoutsThisMonthCount > 0 ? <><strong>{formatCurrency(cam.payoutsThisMonth)}</strong><small className="muted"> ×{cam.payoutsThisMonthCount}</small></> : <span className="muted">—</span>}</td>
                      <td className={cam.openFlags >= 3 ? 'negative' : ''}>{cam.openFlags}</td>
                      <td><span className={isRecent ? 'positive' : 'muted'} style={{fontSize:12}}>{lastActiveLabel}</span></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {clients.length > 0 && (() => {
          const roster = clients.map(client => {
            const cam = camProfiles.find(p => (p.clientIds || []).includes(client.id));
            const latest = client.dailyImports?.at(-1);
            const dailyPnl = (latest?.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
            const funded = Object.values(client.accountRegistry || {}).filter(a => a.accountType === 'Funded' && a.status !== 'Failed').length;
            return { client, cam, dailyPnl, funded };
          }).sort((a, b) => (a.cam?.name || 'zzz').localeCompare(b.cam?.name || 'zzz'));
          return (
            <section className="panel">
              <div className="panel-heading">
                <h3>Client roster</h3>
                <span className="badge muted">{clients.length} clients · drag or reassign CAM</span>
              </div>
              <div className="table-wrap">
                <table className="ops-table">
                  <thead><tr><th>Client</th><th>CAM</th><th>Funded</th><th>Daily P&L</th><th>Stage</th><th>Reassign</th></tr></thead>
                  <tbody>
                    {roster.map(({ client, cam, dailyPnl, funded }) => (
                      <tr key={client.id} style={{cursor:'pointer'}} onClick={() => onOpenCam(cam?.id, client.id)}>
                        <td><strong>{client.name}</strong></td>
                        <td><small>{cam?.name || <span className="negative">Unassigned</span>}</small></td>
                        <td>{funded || '—'}</td>
                        <td className={dailyPnl >= 0 ? 'positive' : 'negative'}><small>{formatCurrency(dailyPnl)}</small></td>
                        <td><small className="muted">{client.profile?.stage || 'Active'}</small></td>
                        <td onClick={e => e.stopPropagation()}>
                          <select
                            value={cam?.id || ''}
                            style={{fontSize:12,padding:'2px 6px'}}
                            onChange={e => {
                              if (!e.target.value || e.target.value === cam?.id) return;
                              const targetCam = camProfiles.find(p => p.id === e.target.value);
                              if (window.confirm(`Move ${client.name} → ${targetCam?.name}?`)) {
                                onTransferClient(client.id, e.target.value);
                              } else {
                                e.target.value = cam?.id || '';
                              }
                            }}
                          >
                            <option value="">— Unassigned —</option>
                            {camProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        <section className="panel">
          <div className="panel-heading">
            <h3>Historical date drill-down</h3>
            <input type="date" value={drillDate} onChange={e => setDrillDate(e.target.value)} style={{marginLeft:'auto',fontSize:12,padding:'3px 8px',borderRadius:6,border:'1px solid var(--line)',background:'var(--surface)',color:'var(--text)'}} />
            {drillDate && <button className="ghost-button" style={{fontSize:11}} onClick={() => setDrillDate('')}>Clear</button>}
          </div>
          {!drillDate && <p className="muted" style={{fontSize:12}}>Pick a date to see every client's P&L, accounts, and flags for that day.</p>}
          {drillDate && (() => {
            const drillRows = clients.map(client => {
              const imp = (client.dailyImports || []).find(d => d.date === drillDate);
              if (!imp) return null;
              const pnl = (imp.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
              const cam = camProfiles.find(p => (p.clientIds || []).includes(client.id));
              return { client, cam, pnl, accounts: (imp.snapshots || []).length, flags: (imp.flags || []).filter(f => f.severity === 'Critical').length };
            }).filter(Boolean);
            if (!drillRows.length) return <p className="muted" style={{fontSize:12}}>No data uploaded for {drillDate}.</p>;
            const total = drillRows.reduce((s, r) => s + r.pnl, 0);
            return (
              <div className="table-wrap">
                <table className="ops-table">
                  <thead><tr><th>Client</th><th>CAM</th><th>Accounts</th><th>Daily P&L</th><th>Critical flags</th></tr></thead>
                  <tbody>
                    {drillRows.sort((a, b) => b.pnl - a.pnl).map(({ client, cam, pnl, accounts, flags }) => (
                      <tr key={client.id} style={{cursor:'pointer'}} onClick={() => onOpenCam(cam?.id, client.id)}>
                        <td><strong>{client.name}</strong></td>
                        <td className="muted">{cam?.name || '—'}</td>
                        <td>{accounts}</td>
                        <td className={pnl >= 0 ? 'positive' : 'negative'}><strong>{pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}</strong></td>
                        <td>{flags > 0 ? <span className="negative">{flags}</span> : <span className="muted">0</span>}</td>
                      </tr>
                    ))}
                    <tr style={{borderTop:'2px solid var(--line)',fontWeight:700}}>
                      <td colSpan={3}>Total — {drillRows.length} clients</td>
                      <td className={total >= 0 ? 'positive' : 'negative'}>{total >= 0 ? '+' : ''}{formatCurrency(total)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })()}
        </section>

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
            <div className="exception-card warning">
              <strong>Consistency rule risk</strong>
              <span>Funded account's best day represents more than 30% of total positive P&L — may violate prop firm consistency rule.</span>
              <small>best_day_pnl / total_positive_pnl &gt; 0.30</small>
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

        {(() => {
          const currentMonth = todayIsoDate().slice(0, 7);
          const allPayouts = clients.flatMap(client => {
            const cam = camProfiles.find(c => c.clientIds?.includes(client.id));
            return Object.values(client.accountRegistry || {}).flatMap(acct =>
              (acct.payoutHistory || []).map(p => ({
                ...p,
                clientName: client.name,
                accountAlias: acct.alias || acct.accountName,
                camName: cam?.name || 'Unassigned',
              }))
            );
          }).filter(p => p.date && p.date.startsWith(currentMonth))
            .sort((a, b) => b.date.localeCompare(a.date));

          const allTimePayouts = clients.flatMap(client =>
            Object.values(client.accountRegistry || {}).flatMap(acct => acct.payoutHistory || [])
          );
          const monthTotal = allPayouts.reduce((s, p) => s + Number(p.amount || 0), 0);
          const allTimeTotal = allTimePayouts.reduce((s, p) => s + Number(p.amount || 0), 0);
          const allTimeCount = allTimePayouts.length;
          if (!allTimePayouts.length) return null;

          return (
            <section className="panel">
              <div className="panel-heading">
                <h3>Payout history</h3>
                <span className="badge muted">{currentMonth}</span>
                <span className="count">{allPayouts.length} this month</span>
                <span className="metric" style={{marginLeft:'auto',gap:16,display:'flex'}}>
                  <span><span className="muted" style={{fontSize:11}}>This month </span><strong className="positive">{formatCurrency(monthTotal)}</strong></span>
                  <span><span className="muted" style={{fontSize:11}}>All time </span><strong className="positive">{formatCurrency(allTimeTotal)}</strong></span>
                  <span><span className="muted" style={{fontSize:11}}>Total payouts </span><strong>{allTimeCount}</strong></span>
                </span>
              </div>
              {allPayouts.length ? (
                <div className="table-wrap">
                  <table className="ops-table">
                    <thead><tr><th>Date</th><th>Client</th><th>Account</th><th>CAM</th><th>Amount</th><th>Notes</th></tr></thead>
                    <tbody>
                      {allPayouts.map((p, i) => (
                        <tr key={i}>
                          <td><small>{p.date}</small></td>
                          <td>{p.clientName}</td>
                          <td><small>{p.accountAlias}</small></td>
                          <td><small>{p.camName}</small></td>
                          <td className="positive"><strong>{formatCurrency(Number(p.amount || 0))}</strong></td>
                          <td><small className="muted">{p.notes || '—'}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted" style={{padding:'8px 0'}}>No payouts recorded for {currentMonth}. Past payouts appear when months change.</p>
              )}
            </section>
          );
        })()}

        {showUserPanel ? (
          <section className="panel">
            <div className="panel-heading"><h3>Users &amp; Access</h3><Shield size={16} /></div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead><tr><th>Display name</th><th>Username</th><th>Email</th><th>Role</th><th>CAM profile</th><th>Password</th><th></th></tr></thead>
                <tbody>
                  {users.map((u) => {
                    const isEditing = editUserId === u.id;
                    return (
                      <tr key={u.id}>
                        <td>{u.displayName}</td>
                        <td><code>{u.username}</code></td>
                        <td>{isEditing
                          ? <input style={{width:180}} value={editUserPatch.email ?? u.email ?? ''} onChange={e => setEditUserPatch(p => ({...p, email: e.target.value}))} placeholder="email@company.com" />
                          : <span className="muted">{u.email || '—'}</span>}
                        </td>
                        <td><span className={u.role === USER_ROLES.MANAGER ? 'badge success' : 'badge muted'}>{u.role}</span></td>
                        <td>{u.camProfileId ? camProfiles.find((p) => p.id === u.camProfileId)?.name || u.camProfileId : '—'}</td>
                        <td>{isEditing
                          ? <input style={{width:130}} type="text" value={editUserPatch.password ?? ''} onChange={e => setEditUserPatch(p => ({...p, password: e.target.value}))} placeholder="New password" />
                          : <span className="muted">••••••</span>}
                        </td>
                        <td style={{display:'flex',gap:4}}>
                          {isEditing ? (
                            <>
                              <button className="primary-button" style={{fontSize:12,padding:'2px 8px'}} onClick={() => saveUserEdit(u.id)}>Save</button>
                              <button className="ghost-button" onClick={() => { setEditUserId(null); setEditUserPatch({}); }}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="ghost-button" title="Edit" onClick={() => { setEditUserId(u.id); setEditUserPatch({}); }}><Edit3 size={13} /></button>
                              <button className="ghost-button" disabled={u.role === USER_ROLES.MANAGER} title="Delete user" onClick={() => { if(window.confirm(`Delete user "${u.displayName}"?`)) onUsersChange(deleteUser(users, u.id)); }}>
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <form className="user-create-form" onSubmit={submitNewUser}>
              <input required placeholder="Display name *" value={newUser.displayName} onChange={(e) => setNewUser((v) => ({ ...v, displayName: e.target.value }))} />
              <input required placeholder="Username *" value={newUser.username} onChange={(e) => setNewUser((v) => ({ ...v, username: e.target.value }))} />
              <input type="email" placeholder="Email" value={newUser.email} onChange={(e) => setNewUser((v) => ({ ...v, email: e.target.value }))} />
              <input required placeholder="Password *" value={newUser.password} onChange={(e) => setNewUser((v) => ({ ...v, password: e.target.value }))} />
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

function MonthlyReportPanel({ client, month, onClose }) {
  // month = 'YYYY-MM'
  const registry = client?.accountRegistry || {};
  const monthImports = (client?.dailyImports || []).filter((di) => di.date?.startsWith(month));
  const allDays = monthImports.map((di) => {
    const pnl = (di.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
    return { date: di.date, pnl, status: di.status };
  });
  const totalPnl = allDays.reduce((s, d) => s + d.pnl, 0);
  const positiveDays = allDays.filter((d) => d.pnl > 0);
  const negativeDays = allDays.filter((d) => d.pnl < 0);
  const bestDay = allDays.length ? allDays.reduce((b, d) => d.pnl > b.pnl ? d : b, allDays[0]) : null;
  const worstDay = allDays.length ? allDays.reduce((w, d) => d.pnl < w.pnl ? d : w, allDays[0]) : null;

  // Per-account monthly summary
  const accountMap = {};
  for (const di of monthImports) {
    for (const snap of di.snapshots || []) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType === 'Inactive / Ignore') continue;
      if (!accountMap[snap.accountName]) {
        accountMap[snap.accountName] = { alias: meta.alias || snap.accountName, type: meta.accountType || '', pnl: 0, days: 0, winDays: 0 };
      }
      const pnl = Number(snap.grossRealizedPnl || 0);
      accountMap[snap.accountName].pnl += pnl;
      accountMap[snap.accountName].days += 1;
      if (pnl > 0) accountMap[snap.accountName].winDays += 1;
    }
  }
  const accountRows = Object.values(accountMap).sort((a, b) => b.pnl - a.pnl);

  const sign = (n) => n >= 0 ? '+' : '';
  const monthLabel = new Date(month + '-02').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

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
            <h1>{client?.name}</h1>
            <span>Monthly performance report · {monthLabel}</span>
          </div>
          <div className="report-header-right">
            <strong className={totalPnl >= 0 ? 'positive' : 'negative'}>{sign(totalPnl)}{formatCurrency(totalPnl)}</strong>
            <small>net P&amp;L</small>
          </div>
        </header>

        <section className="report-metrics">
          <div><span>Trading days</span><strong>{allDays.length}</strong></div>
          <div><span>Positive days</span><strong className="positive">{positiveDays.length}</strong></div>
          <div><span>Negative days</span><strong className={negativeDays.length ? 'negative' : ''}>{negativeDays.length}</strong></div>
          <div><span>Win rate</span><strong>{allDays.length ? Math.round(positiveDays.length / allDays.length * 100) : 0}%</strong></div>
          {bestDay  ? <div><span>Best day</span><strong className="positive">{sign(bestDay.pnl)}{formatCurrency(bestDay.pnl)} <small>({bestDay.date})</small></strong></div> : null}
          {worstDay ? <div><span>Worst day</span><strong className={worstDay.pnl < 0 ? 'negative' : ''}>{sign(worstDay.pnl)}{formatCurrency(worstDay.pnl)} <small>({worstDay.date})</small></strong></div> : null}
        </section>

        {accountRows.length > 0 ? (
          <section>
            <h2>Account breakdown</h2>
            <table className="ops-table">
              <thead><tr><th>Account</th><th>Type</th><th>Monthly P&amp;L</th><th>Trade days</th><th>Win rate</th></tr></thead>
              <tbody>
                {accountRows.map((row) => (
                  <tr key={row.alias}>
                    <td><strong>{row.alias}</strong></td>
                    <td>{row.type}</td>
                    <td className={row.pnl >= 0 ? 'positive' : 'negative'}>{sign(row.pnl)}{formatCurrency(row.pnl)}</td>
                    <td>{row.days}</td>
                    <td>{row.days ? Math.round(row.winDays / row.days * 100) : 0}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {allDays.length > 0 ? (
          <section>
            <h2>Daily P&amp;L</h2>
            <table className="ops-table">
              <thead><tr><th>Date</th><th>P&amp;L</th><th>Status</th></tr></thead>
              <tbody>
                {allDays.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className={d.pnl >= 0 ? 'positive' : 'negative'}>{sign(d.pnl)}{formatCurrency(d.pnl)}</td>
                    <td>{d.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </div>
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
            <strong>{report.status}</strong>
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

function OnboardingChecklist({ client, onSwitchTab }) {
  const profile = client.profile || {};
  const creds = client.credentials || {};
  const registry = client.accountRegistry || {};
  const tasks = client.tasks || [];

  const steps = [
    {
      done: !!(profile.email || profile.phone || profile.fullName),
      label: 'Add contact info',
      detail: 'Name, WhatsApp, email — so you can reach the client from the CRM',
      action: () => onSwitchTab?.('Profile'),
      actionLabel: 'Open Profile →',
    },
    {
      done: !!(creds.ip && creds.username),
      label: 'Save VPS credentials',
      detail: 'IP, username, password — required for daily check-ins',
      action: () => onSwitchTab?.('Credentials & Notes'),
      actionLabel: 'Open Credentials →',
    },
    {
      done: Object.keys(registry).length > 0,
      label: 'Upload first NT CSV',
      detail: 'Export from NinjaTrader and drag the file here to populate accounts',
      action: null,
      actionLabel: null,
    },
    {
      done: Object.values(registry).some(m => m.accountType && m.accountType !== 'Unassigned'),
      label: 'Classify accounts in registry',
      detail: 'Set each account as Funded, Evaluation, Cash, or Inactive',
      action: () => onSwitchTab?.('Account Registry'),
      actionLabel: 'Open Registry →',
    },
    {
      done: Object.values(registry).some(m => m.accountType === 'Funded' && m.targetProfit),
      label: 'Set payout target on funded accounts',
      detail: 'Target profit + max drawdown limit — enables payout alerts and progress tracking',
      action: () => onSwitchTab?.('Account Registry'),
      actionLabel: 'Open Registry →',
    },
  ];

  const doneCount = steps.filter(s => s.done).length;
  if (doneCount === steps.length) return null;

  return (
    <div className="onboarding-checklist">
      <div className="onboarding-header">
        <strong>New client setup</strong>
        <span className="muted">{doneCount}/{steps.length} steps complete</span>
        <div className="onboarding-bar-wrap"><div className="onboarding-bar" style={{width:`${Math.round(doneCount/steps.length*100)}%`}} /></div>
      </div>
      <div className="onboarding-steps">
        {steps.map((step, i) => (
          <div key={i} className={`onboarding-step${step.done ? ' onboarding-step-done' : ''}`}>
            <span className="onboarding-dot">{step.done ? '✓' : i + 1}</span>
            <div className="onboarding-step-body">
              <strong>{step.label}</strong>
              <small className="muted">{step.detail}</small>
            </div>
            {!step.done && step.action && (
              <button className="ghost-button" style={{fontSize:12,whiteSpace:'nowrap'}} onClick={step.action}>{step.actionLabel}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PayoutHistoryPanel({ funded, grandTotal, onLogPayout }) {
  const today = todayIsoDate();
  const [logAccountName, setLogAccountName] = useState(null);
  const [logAmount, setLogAmount] = useState('');
  const [logDate, setLogDate] = useState(today);
  const [logNote, setLogNote] = useState('');

  function submitPayout(accountName) {
    const amount = Number(logAmount);
    if (!amount || amount <= 0) return;
    onLogPayout?.(accountName, { date: logDate, amount, note: logNote.trim() });
    setLogAccountName(null);
    setLogAmount('');
    setLogDate(today);
    setLogNote('');
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Payout History</h3>
        {grandTotal > 0 && <span className="badge success">Total earned: {formatCurrency(grandTotal)}</span>}
      </div>
      <div className="payout-history-list">
        {funded.map(m => {
          const history = m.payoutHistory || [];
          const accountTotal = history.reduce((s, p) => s + Number(p.amount || 0), 0);
          const isLogging = logAccountName === m.accountName;
          return (
            <div key={m.accountName} className="payout-history-account">
              <div className="payout-account-header">
                <strong>{m.alias || m.accountName}</strong>
                {accountTotal > 0 && <span className="positive">{formatCurrency(accountTotal)} total · {history.length} payout{history.length !== 1 ? 's' : ''}</span>}
                {!history.length && m.payoutCount > 0 && <small className="muted">{m.payoutCount} payout{m.payoutCount !== 1 ? 's' : ''} — no detail</small>}
                {!history.length && !m.payoutCount && <small className="muted">No payouts yet</small>}
                <button className="ghost-button" style={{marginLeft:'auto',fontSize:12}} onClick={() => setLogAccountName(isLogging ? null : m.accountName)}>
                  {isLogging ? 'Cancel' : '+ Log payout'}
                </button>
              </div>
              {isLogging && (
                <div className="payout-log-form">
                  <input type="number" placeholder="Amount (e.g. 2500)" value={logAmount} onChange={e => setLogAmount(e.target.value)} min="1" />
                  <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)} />
                  <input placeholder="Note (optional)" value={logNote} onChange={e => setLogNote(e.target.value)} />
                  <button className="primary-button" onClick={() => submitPayout(m.accountName)}>Save</button>
                </div>
              )}
              {history.length > 0 && (
                <div className="payout-entries">
                  {history.map((p, i) => (
                    <div key={i} className="payout-entry">
                      <span className="payout-date">{p.date}</span>
                      <span className="positive payout-amount">{formatCurrency(p.amount)}</span>
                      {p.note && <small className="muted">{p.note}</small>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ClientOverview({ client, dailyImport, allClients = [], onRequestMonthlyReport, onLogPayout }) {
  const [monthlyExpanded, setMonthlyExpanded] = useState('');
  const overview = buildClientOverview(client, dailyImport);
  const lifetime = buildLifetimeStats(client);
  const maxDistribution = Math.max(...overview.distribution.map((item) => item.count), 1);
  const disconnectAlerts = buildDisconnectAlerts(client);
  const consistencyWarnings = buildConsistencyWarnings(client);
  const varianceRows = buildPnlVarianceAnalysis(client, allClients);
  const payoutAlerts = buildPayoutAlerts(client, dailyImport);
  const monthlyByAccount = buildMonthlyByAccount(client);
  const latestRegistry = { ...(dailyImport?.accounts || {}), ...(client?.accountRegistry || {}) };

  const profile = client.profile || {};
  const hasContact = profile.email || profile.phone || profile.messenger || profile.timezone || profile.propFirm || profile.preferredChannel || profile.country;
  const waLink = profile.phone ? `https://wa.me/${profile.phone.replace(/\D/g, '')}` : null;

  return (
    <div className="dashboard-stack">
      {hasContact && (
        <section className="contact-card">
          {profile.fullName && <strong className="contact-name">{profile.fullName}</strong>}
          {profile.email && <a href={`mailto:${profile.email}`} className="contact-chip"><span>✉</span>{profile.email}</a>}
          {profile.phone && <a href={waLink || `tel:${profile.phone}`} target="_blank" rel="noreferrer" className="contact-chip"><span>{waLink ? '📱' : '📞'}</span>{profile.phone}</a>}
          {profile.messenger && <span className="contact-chip"><span>💬</span>{profile.messenger}</span>}
          {profile.timezone && <span className="contact-chip muted"><span>🕐</span>{profile.timezone}</span>}
          {profile.propFirm && <span className="contact-chip muted"><span>🏢</span>{profile.propFirm}</span>}
          {profile.preferredChannel && <span className="contact-chip muted"><span>💬</span>{profile.preferredChannel}</span>}
          {profile.country && <span className="contact-chip muted"><span>🌎</span>{profile.country}</span>}
          {profile.language && <span className="contact-chip muted"><span>🌐</span>{{en:'English',es:'Español'}[profile.language]||profile.language}</span>}
          {profile.stage && profile.stage !== 'Active' && <span className={`client-stage-badge stage-${profile.stage?.toLowerCase().replace(/\s+/g, '-')}`}>{profile.stage}</span>}
        </section>
      )}
      <div className="metric-grid">
        <div className="metric"><span>Latest daily PnL</span><strong className={overview.metrics.dailyPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(overview.metrics.dailyPnl)}</strong></div>
        <div className="metric"><span>Change vs prior close</span><strong className={overview.metrics.dailyDelta >= 0 ? 'positive' : 'negative'}>{formatCurrency(overview.metrics.dailyDelta)}</strong></div>
        <div className="metric"><span>Accounts tracked</span><strong>{overview.metrics.accounts}</strong></div>
        <div className="metric"><span>Open flags</span><strong>{overview.metrics.openFlags}</strong></div>
        {lifetime && <>
          <div className="metric"><span>Lifetime P&L</span><strong className={lifetime.totalPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(lifetime.totalPnl)}</strong></div>
          <div className="metric"><span>Win rate</span><strong className={lifetime.winRate >= 60 ? 'positive' : lifetime.winRate < 40 ? 'negative' : ''}>{lifetime.winRate}%</strong></div>
          <div className="metric"><span>Avg day</span><strong className={lifetime.avgDay >= 0 ? 'positive' : 'negative'}>{formatCurrency(lifetime.avgDay)}</strong></div>
          <div className="metric"><span>Days traded</span><strong>{lifetime.totalDays}</strong></div>
          <div className="metric"><span>Best day</span><strong className="positive">{formatCurrency(lifetime.bestDay)}<small className="muted"> {lifetime.bestDayDate}</small></strong></div>
          <div className="metric"><span>Worst day</span><strong className="negative">{formatCurrency(lifetime.worstDay)}<small className="muted"> {lifetime.worstDayDate}</small></strong></div>
          <div className="metric"><span>Current streak</span><strong className={lifetime.streakType ? 'positive' : 'negative'}>{lifetime.streak}d {lifetime.streakType ? 'positive' : 'negative'}</strong></div>
          {lifetime.daysSinceStart !== null && <div className="metric"><span>Days as client</span><strong>{lifetime.daysSinceStart}d{lifetime.startDate ? <small className="muted"> since {lifetime.startDate}</small> : null}</strong></div>}
        </>}
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

      <section className="panel">
        <div className="panel-heading"><h3>P&amp;L Calendar</h3><span className="badge muted">Last 10 weeks — green = profit, red = loss</span></div>
        <PnlCalendarHeatmap client={client} />
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

      {consistencyWarnings.length > 0 ? (
        <section className={consistencyWarnings.some((w) => w.severity === 'Critical') ? 'panel danger-panel' : 'panel'}>
          <div className="panel-heading">
            <h3>Consistency Rule Risk</h3>
            <span className="count">{consistencyWarnings.length}</span>
            <span className="badge muted">Best day &gt;30% of total gains</span>
          </div>
          <div className="flag-list">
            {consistencyWarnings.map((w) => (
              <div className={`flag ${w.severity === 'Critical' ? 'critical' : 'warning'}`} key={w.id}>
                <AlertTriangle size={16} />
                <div>
                  <strong>{w.alias} — {w.ratio}% concentration risk</strong>
                  <span>
                    Best day ({w.bestDayDate}): {formatCurrency(w.bestDayPnl)} = {w.ratio}% of {formatCurrency(w.totalPositive)} total gains.
                    {w.severity === 'Critical' ? ' Likely fails consistency rule. Contact client.' : ' Monitor — approaching consistency rule limit.'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {payoutAlerts.length > 0 ? (
        <section className="panel payout-alert-panel">
          <div className="panel-heading">
            <h3>Payout Alerts</h3>
            <span className="count">{payoutAlerts.length}</span>
            <span className="badge muted">Accounts near or at target — request payout</span>
          </div>
          <div className="flag-list">
            {payoutAlerts.map((a) => (
              <div key={a.accountName} className={`flag-item ${a.ready ? 'flag-critical' : 'flag-warning'}`}>
                <div className="flag-body">
                  <strong>{a.alias}</strong>
                  <span>
                    {a.ready
                      ? `Ready for payout — profit ${formatCurrency(a.profit)} reached target ${formatCurrency(a.target)}`
                      : `Approaching target — ${a.pct}% of ${formatCurrency(a.target)} goal (${formatCurrency(a.profit)} profit)`}
                  </span>
                </div>
                <div className="payout-progress-wrap">
                  <div className="payout-progress-bar" style={{ width: `${Math.min(100, a.pct)}%`, background: a.ready ? 'var(--green)' : 'var(--yellow)' }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {varianceRows.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <h3>Account Variance vs Team Avg</h3>
            <span className="badge muted">Last 7 closes — actual vs expected by strategy</span>
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Strategies</th>
                  <th>Actual P&amp;L</th>
                  <th>Expected P&amp;L</th>
                  <th>Variance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {varianceRows.map((row) => (
                  <tr key={row.accountName}>
                    <td><strong>{row.alias}</strong><small>{row.accountType}</small></td>
                    <td><small className="muted">{row.strategies || '—'}</small></td>
                    <td className={row.totalActual >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.totalActual)}</td>
                    <td className="muted">{formatCurrency(row.totalExpected)}</td>
                    <td className={row.variance >= 0 ? 'positive' : 'negative'}>
                      {row.variance >= 0 ? '+' : ''}{formatCurrency(row.variance)}
                      <small className="muted"> ({row.variancePct >= 0 ? '+' : ''}{row.variancePct}%)</small>
                    </td>
                    <td>
                      <span className={`variance-badge variance-${row.status}`}>
                        {row.status === 'good' ? '✓ Good' : row.status === 'average' ? '~ Average' : '⚠ Review'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <h3>Monthly P&amp;L</h3>
          <TrendingUp size={16} />
          {monthlyExpanded ? (
            <button className="ghost-button" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => onRequestMonthlyReport?.(monthlyExpanded)}>
              <FileText size={13} /> Monthly Report
            </button>
          ) : null}
        </div>
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
              <span>Account</span><span>Algo Stack</span><span>Monthly P&amp;L</span><span>Days</span>
            </div>
            {(monthlyByAccount.find((m) => m.month === monthlyExpanded)?.accounts || []).map((row) => (
              <div className="monthly-breakdown-row" key={row.accountName}>
                <span>{row.alias}</span>
                <small className="muted">{row.strategies || '—'}</small>
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

      {(() => {
        const registry = client.accountRegistry || {};
        const funded = Object.values(registry).filter(m => m.accountType === 'Funded');
        if (!funded.length) return null;
        const grandTotal = funded.reduce((sum, m) => sum + (m.payoutHistory || []).reduce((s, p) => s + Number(p.amount || 0), 0), 0);
        return (
          <PayoutHistoryPanel
            funded={funded}
            grandTotal={grandTotal}
            onLogPayout={onLogPayout}
          />
        );
      })()}
    </div>
  );
}

function buildPnlCalendar(client) {
  const imports = client.dailyImports || [];
  if (!imports.length) return [];
  const byDate = {};
  for (const di of imports) {
    const pnl = (di.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
    byDate[di.date] = { date: di.date, pnl, status: di.status };
  }
  // Build a 12-week window of Mon-Fri only (no weekends)
  const end = new Date();
  const cur = new Date(end);
  // Rewind to most recent Friday or today
  while (cur.getDay() === 0 || cur.getDay() === 6) cur.setDate(cur.getDate() - 1);
  // Rewind 12 weeks of Mon-Fri
  const start = new Date(cur);
  start.setDate(start.getDate() - 83); // ~12 weeks back
  // Align start to Monday
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1);

  const weeks = [];
  let week = [];
  const iter = new Date(start);
  while (iter <= end) {
    const dow = iter.getDay();
    if (dow >= 1 && dow <= 5) { // Mon–Fri only
      const iso = iter.toISOString().slice(0, 10);
      week.push({ date: iso, ...(byDate[iso] || { date: iso, pnl: null, status: null }) });
      if (week.length === 5) { weeks.push(week); week = []; }
    }
    iter.setDate(iter.getDate() + 1);
  }
  if (week.length) weeks.push(week);
  return weeks;
}

function PnlCalendarHeatmap({ client }) {
  const weeks = buildPnlCalendar(client);
  if (!weeks.length) return null;
  const allPnls = weeks.flat().map((d) => d.pnl).filter((v) => v !== null && v !== 0);
  const maxAbs = Math.max(...allPnls.map(Math.abs), 1);
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  function cellColor(day) {
    if (day.pnl === null) return 'var(--surface-3)';
    if (day.pnl === 0) return 'var(--surface-2)';
    const intensity = Math.min(0.92, 0.25 + (Math.abs(day.pnl) / maxAbs) * 0.67);
    return day.pnl > 0
      ? `rgba(47, 202, 115, ${intensity})`
      : `rgba(255, 90, 105, ${intensity})`;
  }

  return (
    <div className="pnl-heatmap">
      <div className="pnl-heatmap-day-labels">
        {DAY_LABELS.map((l) => <span key={l}>{l}</span>)}
      </div>
      <div className="pnl-heatmap-grid">
        {weeks.map((week, wi) => (
          <div className="pnl-heatmap-week" key={wi}>
            {week.map((day) => (
              <div
                key={day.date}
                className="pnl-heatmap-cell"
                style={{ background: cellColor(day) }}
                title={day.pnl !== null ? `${day.date}: ${day.pnl >= 0 ? '+' : ''}${formatCurrency(day.pnl)}` : `${day.date} — no close`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="pnl-heatmap-legend">
        <span className="negative">Loss</span>
        <div className="heatmap-legend-bar">
          <i style={{ background: 'rgba(255,90,105,0.85)' }} />
          <i style={{ background: 'rgba(255,90,105,0.45)' }} />
          <i style={{ background: 'var(--surface-3)' }} />
          <i style={{ background: 'rgba(47,202,115,0.45)' }} />
          <i style={{ background: 'rgba(47,202,115,0.85)' }} />
        </div>
        <span className="positive">Profit</span>
        <span className="muted" style={{marginLeft:'8px'}}>Mon–Fri only</span>
      </div>
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

// ── Insight Feed ─────────────────────────────────────────────────────────────
// Aggregates all notable signals across a CAM's portfolio into one prioritized list
function buildPortfolioInsights(clients, allClients = []) {
  const insights = [];
  const today = todayIsoDate();

  for (const client of clients) {
    const registry = client.accountRegistry || {};
    const latest = client.dailyImports?.at(-1);
    const snapshots = latest?.snapshots || [];
    const imports = client.dailyImports || [];

    // Helper: compute remaining buffer from a snapshot + meta
    function remainingBuffer(s, m) {
      const ddLimit = Number(m?.maxDrawdownLimit || 0);
      const rawDD = Number(s?.trailingMaxDrawdown || 0);
      return ddLimit > 0 ? ddLimit - Math.abs(rawDD) : rawDD;
    }

    // 1. Drawdown velocity — project breach date from last 7-day buffer consumption
    for (const snap of snapshots) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType !== 'Funded') continue;
      if (meta.status === 'Failed' || meta.status === 'Inactive') continue;

      const buffer = remainingBuffer(snap, meta);
      if (buffer <= 0) continue; // already breached

      // Compute daily buffer change over last 7 imports
      const last7 = imports.slice(-7);
      if (last7.length < 3) continue;
      const buffers = last7.map((di) => {
        const s = (di.snapshots || []).find((x) => x.accountName === snap.accountName);
        return s ? remainingBuffer(s, meta) : null;
      }).filter((v) => v !== null);

      if (buffers.length < 2) continue;
      const dailyChange = (buffers.at(-1) - buffers[0]) / (buffers.length - 1);
      if (dailyChange >= 0) continue; // buffer growing or stable — no concern
      const daysToBreech = Math.floor(buffer / Math.abs(dailyChange));

      if (daysToBreech <= 5) {
        insights.push({
          severity: daysToBreech <= 2 ? 'critical' : 'warning',
          type: 'Drawdown Velocity',
          clientId: client.id,
          clientName: client.name,
          accountAlias: meta.alias || snap.accountName,
          message: `Buffer ${formatCurrency(buffer)} depleting ~${formatCurrency(Math.abs(dailyChange))}/day — projected breach in ${daysToBreech} trading day${daysToBreech !== 1 ? 's' : ''}`,
          action: 'Review stack or reduce position size',
        });
      }
    }

    // 2. Consistency rule — best day > 30% of total positive P&L
    const consistencyWarnings = buildConsistencyWarnings(client);
    for (const w of consistencyWarnings) {
      insights.push({
        severity: w.severity === 'Critical' ? 'critical' : 'warning',
        type: 'Consistency Rule',
        clientId: client.id,
        clientName: client.name,
        accountAlias: w.alias,
        message: `Best day (${formatCurrency(w.bestDayPnl)} on ${w.bestDayDate}) is ${Math.round(w.ratio * 100)}% of total gains — consistency rule at risk`,
        action: 'Consider reducing position on strong days',
      });
    }

    // 3. Payout opportunity — funded account near target
    if (latest) {
      const payoutAlerts = buildPayoutAlerts(client, latest);
      for (const a of payoutAlerts) {
        insights.push({
          severity: a.ready ? 'info-green' : 'info',
          type: 'Payout Opportunity',
          clientId: client.id,
          clientName: client.name,
          accountAlias: a.alias,
          message: a.ready
            ? `Target reached — ${formatCurrency(a.profit)} profit vs ${formatCurrency(a.target)} goal. Request payout.`
            : `${a.pct}% of payout target — ${formatCurrency(a.target - a.profit)} remaining`,
          action: a.ready ? 'Request payout now' : 'Monitor until target',
        });
      }
    }

    // 4. Strategy cooling — algo was positive last week, now negative 3+ days
    if (latest) {
      const latestRegistry = { ...(latest.accounts || {}), ...registry };
      for (const snap of snapshots) {
        const meta = latestRegistry[snap.accountName] || {};
        if (!['Funded', 'Evaluation - Standard'].includes(meta.accountType)) continue;
        const enabledStrats = (snap.strategies || []).filter(s => s.enabled);
        if (!enabledStrats.length) continue;
        const recentImports = imports.slice(-10);
        if (recentImports.length < 6) continue;
        const pnls = recentImports.map(di => {
          const s = (di.snapshots || []).find(x => x.accountName === snap.accountName);
          return s ? Number(s.grossRealizedPnl || 0) : null;
        }).filter(v => v !== null);
        if (pnls.length < 6) continue;
        const prior4 = pnls.slice(0, Math.floor(pnls.length / 2));
        const recent4 = pnls.slice(Math.floor(pnls.length / 2));
        const priorAvg = prior4.reduce((s, v) => s + v, 0) / prior4.length;
        const recentAvg = recent4.reduce((s, v) => s + v, 0) / recent4.length;
        const negativeDays = recent4.filter(v => v < 0).length;
        if (priorAvg > 50 && recentAvg < 0 && negativeDays >= 3) {
          insights.push({
            severity: 'warning',
            type: 'Strategy Cooling',
            clientId: client.id,
            clientName: client.name,
            accountAlias: meta.alias || snap.accountName,
            message: `Performance shift: avg was ${formatCurrency(priorAvg)}/day, now ${formatCurrency(recentAvg)}/day (${negativeDays} negative days recently)`,
            action: 'Review in Stack Playbook — consider algo change',
          });
        }
      }
    }

    // 5. Account not uploading (no close today or yesterday)
    const todayImport = getClientImportByDate(client, today);
    if (!todayImport) {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const yest = yesterday.toISOString().slice(0, 10);
      const yesterdayImport = getClientImportByDate(client, yest);
      if (!yesterdayImport && imports.length > 0) {
        insights.push({
          severity: 'warning',
          type: 'Missing Close',
          clientId: client.id,
          clientName: client.name,
          accountAlias: null,
          message: `No daily close uploaded in the last 2 days`,
          action: 'Check VPS connection and upload NT CSV',
        });
      }
    }
  }

  const order = { critical: 0, warning: 1, 'info-green': 2, info: 3 };
  return insights.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
}

function InsightFeedPanel({ insights, onSelectClient }) {
  if (!insights.length) {
    return (
      <section className="panel">
        <div className="panel-heading"><h3>Insight Feed</h3><span className="badge success">All clear</span></div>
        <p className="muted" style={{ padding: '8px 0' }}>No signals across your portfolio right now. Keep uploading daily closes for continuous monitoring.</p>
      </section>
    );
  }

  const criticalCount = insights.filter((i) => i.severity === 'critical').length;
  const warningCount  = insights.filter((i) => i.severity === 'warning').length;

  const severityConfig = {
    critical:    { label: 'Critical',    cls: 'insight-critical',   dot: '#ff5a69' },
    warning:     { label: 'Warning',     cls: 'insight-warning',    dot: '#f4bb44' },
    'info-green':{ label: 'Opportunity', cls: 'insight-opportunity',dot: '#2fca73' },
    info:        { label: 'Info',        cls: 'insight-info',       dot: '#45a3ff' },
  };

  return (
    <section className={`panel ${criticalCount ? 'danger-panel' : ''}`}>
      <div className="panel-heading">
        <h3>Insight Feed</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {criticalCount ? <span className="badge danger">{criticalCount} critical</span> : null}
          {warningCount  ? <span className="badge warning">{warningCount} warning</span>  : null}
          <span className="badge muted">{insights.length} signals</span>
        </div>
      </div>
      <div className="insight-feed">
        {insights.map((item, i) => {
          const cfg = severityConfig[item.severity] || severityConfig.info;
          return (
            <button
              key={i}
              className={`insight-item ${cfg.cls}`}
              onClick={() => onSelectClient && onSelectClient(item.clientId)}
              title={`Open ${item.clientName}`}
            >
              <span className="insight-dot" style={{ background: cfg.dot }} />
              <div className="insight-body">
                <div className="insight-head">
                  <span className="insight-type">{item.type}</span>
                  <span className="insight-client">{item.clientName}</span>
                  {item.accountAlias ? <span className="insight-account">· {item.accountAlias}</span> : null}
                </div>
                <p className="insight-message">{item.message}</p>
                <small className="insight-action">→ {item.action}</small>
              </div>
              <span className={`insight-severity-badge insight-sev-${item.severity}`}>{cfg.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function buildIncomeProjection(clients = []) {
  const rows = [];
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = { ...(latest.accounts || {}), ...(client.accountRegistry || {}) };
    for (const snap of latest.snapshots || []) {
      const meta = registry[snap.accountName] || {};
      if (meta.accountType !== 'Funded') continue;
      const target = Number(meta.targetProfit || 0);
      const start = Number(meta.startBalance || 0);
      const balance = Number(snap.accountBalance || 0);
      if (!target || !start) continue;
      const profit = balance - start;
      const needed = target - start;
      const pct = needed > 0 ? Math.round((profit / needed) * 100) : 0;
      // velocity from last 7 imports
      const recent = (client.dailyImports || []).slice(-7);
      const pnlHistory = recent.map((di) => {
        const s = (di.snapshots || []).find((x) => x.accountName === snap.accountName);
        return s ? Number(s.grossRealizedPnl || 0) : 0;
      }).filter((v) => v !== 0);
      const avgDaily = pnlHistory.length ? pnlHistory.reduce((s, v) => s + v, 0) / pnlHistory.length : 0;
      const remaining = needed - profit;
      const daysLeft = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : null;
      rows.push({
        clientId: client.id,
        clientName: client.name,
        alias: meta.alias || snap.accountName,
        pct: Math.min(100, pct),
        profit,
        needed,
        avgDaily,
        daysLeft,
        ready: balance >= target,
      });
    }
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

function CamOverview({ clients, camProfiles = [], allClients = [], strategySetRecords = [], strategySetIndexStatus, camName = '', onSelectClient, onAddClientTask }) {
  const [expandedAlgorithm, setExpandedAlgorithm] = useState('');
  const [showBulkTask, setShowBulkTask] = useState(false);
  const [bulkTaskText, setBulkTaskText] = useState('');
  const [bulkTaskDue, setBulkTaskDue] = useState('');
  const [bulkTaskPriority, setBulkTaskPriority] = useState('Normal');
  const [bulkTaskTargets, setBulkTaskTargets] = useState([]);
  const [quickTaskClientId, setQuickTaskClientId] = useState(null);
  const [quickTaskText, setQuickTaskText] = useState('');
  const [quickTaskDue, setQuickTaskDue] = useState('');
  const [quickTaskPriority, setQuickTaskPriority] = useState('Normal');
  const goalKey = `cam-monthly-goal-${camName}`;
  const [monthlyGoal, setMonthlyGoal] = useState(() => { try { return Number(localStorage.getItem(goalKey) || 0); } catch { return 0; } });
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyPnl = clients.reduce((sum, c) => sum + (c.dailyImports || []).filter(di => di.date?.startsWith(currentMonth)).reduce((s, di) => s + (di.snapshots || []).reduce((ss, sn) => ss + Number(sn.grossRealizedPnl || 0), 0), 0), 0);
  const goalPct = monthlyGoal > 0 ? Math.min(100, Math.round((monthlyPnl / monthlyGoal) * 100)) : null;
  const overview = buildCamOverview(clients, strategySetRecords);
  const displayName = camName || 'this workspace';
  const briefing = buildTodayBriefing(clients);
  const insights = buildPortfolioInsights(clients, allClients);
  const incomeProjection = buildIncomeProjection(clients);

  const urgencyCounts = { critical: 0, warning: 0, info: 0, pending: 0, ok: 0 };
  briefing.forEach((b) => { urgencyCounts[b.urgency] = (urgencyCounts[b.urgency] || 0) + 1; });

  const today = todayIsoDate();
  const closeStats = (() => {
    const withUpload = clients.filter(c => getClientImportByDate(c, today));
    const closed = withUpload.filter(c => getClientImportByDate(c, today)?.status === 'Closed');
    return { total: clients.length, withUpload: withUpload.length, closed: closed.length };
  })();
  const closePct = closeStats.total ? Math.round((closeStats.closed / closeStats.total) * 100) : 0;
  const todayPortfolioPnl = clients.reduce((sum, c) => {
    const imp = getClientImportByDate(c, today) || c.dailyImports?.at(-1);
    return sum + (imp?.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0);
  }, 0);
  const openTasksToday = clients.reduce((n, c) => n + (c.tasks || []).filter(t => !t.done && t.dueDate === today).length, 0);
  const overdueTotal = clients.reduce((n, c) => n + (c.tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < today).length, 0);

  return (
    <main className="content">
      <div className="page-header">
        <div>
          <span className="eyebrow">Account manager overview · {today}</span>
          <h1>CAM Overview</h1>
          <div className="occ-status-row" style={{marginTop:6}}>
            <span className="occ-live-dot" />
            <span>{closeStats.closed}/{closeStats.total} clients closed today</span>
            {closeStats.withUpload > closeStats.closed && <span className="muted">· {closeStats.withUpload - closeStats.closed} uploaded, not closed</span>}
            {closeStats.total > closeStats.withUpload && <span className="negative">· {closeStats.total - closeStats.withUpload} no upload</span>}
          </div>
          <div style={{marginTop:8,background:'var(--line)',borderRadius:4,height:6,width:220,overflow:'hidden'}}>
            <div style={{height:'100%',width:`${closePct}%`,background:closePct===100?'var(--green)':'var(--accent)',transition:'width .4s ease',borderRadius:4}} />
          </div>
        </div>
        <div className="header-actions" style={{alignSelf:'flex-end',gap:12}}>
          <div className="metric" style={{minWidth:120,textAlign:'right'}}>
            <span>Portfolio P&L today</span>
            <strong className={todayPortfolioPnl >= 0 ? 'positive' : 'negative'} style={{fontSize:22}}>{formatCurrency(todayPortfolioPnl)}</strong>
          </div>
          {(openTasksToday > 0 || overdueTotal > 0) && (
            <div className="metric" style={{textAlign:'right'}}>
              <span>Tasks</span>
              <strong>
                {overdueTotal > 0 && <span className="negative">{overdueTotal} overdue </span>}
                {openTasksToday > 0 && <span>{openTasksToday} due today</span>}
              </strong>
            </div>
          )}
          <div className="metric" style={{minWidth:160,textAlign:'right'}}>
            <span style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:6}}>
              Monthly goal
              <button className="ghost-button" style={{fontSize:10,padding:'1px 5px'}} onClick={() => { setGoalDraft(monthlyGoal || ''); setEditingGoal(true); }}>Edit</button>
            </span>
            {editingGoal ? (
              <form style={{display:'flex',gap:4,justifyContent:'flex-end'}} onSubmit={e => { e.preventDefault(); const v = Number(goalDraft); setMonthlyGoal(v); try { localStorage.setItem(goalKey, String(v)); } catch {} setEditingGoal(false); }}>
                <input autoFocus type="number" value={goalDraft} onChange={e => setGoalDraft(e.target.value)} placeholder="e.g. 10000" style={{width:90,fontSize:12,padding:'2px 6px',background:'var(--surface-2)',border:'1px solid var(--line)',borderRadius:4,color:'var(--text)'}} />
                <button type="submit" className="primary-button" style={{padding:'2px 8px',fontSize:11}}>Set</button>
                <button type="button" className="ghost-button" style={{fontSize:11}} onClick={() => setEditingGoal(false)}>✕</button>
              </form>
            ) : monthlyGoal > 0 ? (
              <>
                <strong className={monthlyPnl >= monthlyGoal ? 'positive' : ''} style={{fontSize:16}}>{formatCurrency(monthlyPnl)} / {formatCurrency(monthlyGoal)}</strong>
                <div style={{marginTop:4,background:'var(--line)',borderRadius:4,height:5,width:160}}>
                  <div style={{height:'100%',width:`${goalPct}%`,background:goalPct >= 100 ? 'var(--green)' : 'var(--accent)',borderRadius:4,transition:'width .4s'}} />
                </div>
                <small className={goalPct >= 100 ? 'positive' : 'muted'}>{goalPct}% of goal</small>
              </>
            ) : <small className="muted">No goal set</small>}
          </div>
        </div>
      </div>

      <InsightFeedPanel insights={insights} onSelectClient={onSelectClient} />

      {(() => {
        const allOpenTasks = clients.flatMap(c =>
          (c.tasks || [])
            .filter(t => !t.done)
            .map(t => ({ ...t, clientName: c.name, clientId: c.id }))
        ).sort((a, b) => {
          const scoreA = a.dueDate && a.dueDate < today ? 0 : a.priority === 'High' ? 1 : a.dueDate === today ? 2 : 3;
          const scoreB = b.dueDate && b.dueDate < today ? 0 : b.priority === 'High' ? 1 : b.dueDate === today ? 2 : 3;
          if (scoreA !== scoreB) return scoreA - scoreB;
          return (a.dueDate || '9').localeCompare(b.dueDate || '9');
        });
        if (!allOpenTasks.length) return null;
        const overdue = allOpenTasks.filter(t => t.dueDate && t.dueDate < today).length;
        const dueToday = allOpenTasks.filter(t => t.dueDate === today).length;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>My open tasks</h3>
              <span className="count">{allOpenTasks.length} open</span>
              {overdue > 0 && <span className="badge danger">{overdue} overdue</span>}
              {dueToday > 0 && <span className="badge warning">{dueToday} due today</span>}
              <button className="ghost-button" style={{marginLeft:'auto',fontSize:12}} onClick={() => { setShowBulkTask(v => !v); setBulkTaskTargets(clients.map(c => c.id)); }}>+ Bulk task</button>
            </div>
            {showBulkTask && (
              <form className="bulk-task-form" onSubmit={e => {
                e.preventDefault();
                if (!bulkTaskText.trim() || !bulkTaskTargets.length) return;
                bulkTaskTargets.forEach(clientId => {
                  onAddClientTask?.(clientId, { id: `task-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, text: bulkTaskText.trim(), priority: bulkTaskPriority, dueDate: bulkTaskDue || null, done: false, createdAt: new Date().toISOString() });
                });
                setBulkTaskText(''); setBulkTaskDue(''); setBulkTaskPriority('Normal'); setShowBulkTask(false);
              }}>
                <strong style={{fontSize:13,gridColumn:'1/-1'}}>Add task to multiple clients</strong>
                <input autoFocus value={bulkTaskText} onChange={e => setBulkTaskText(e.target.value)} placeholder="Task description…" style={{gridColumn:'1/-1'}} />
                <input type="date" value={bulkTaskDue} onChange={e => setBulkTaskDue(e.target.value)} />
                <select value={bulkTaskPriority} onChange={e => setBulkTaskPriority(e.target.value)}>
                  <option>Normal</option><option>High</option><option>Low</option>
                </select>
                <div style={{gridColumn:'1/-1',display:'flex',flexWrap:'wrap',gap:6}}>
                  {clients.map(c => (
                    <label key={c.id} style={{display:'flex',alignItems:'center',gap:4,fontSize:12,cursor:'pointer'}}>
                      <input type="checkbox" checked={bulkTaskTargets.includes(c.id)} onChange={ev => setBulkTaskTargets(prev => ev.target.checked ? [...prev, c.id] : prev.filter(id => id !== c.id))} />
                      {c.name}
                    </label>
                  ))}
                </div>
                <button type="submit" className="primary-button" disabled={!bulkTaskText.trim() || !bulkTaskTargets.length}>Add to {bulkTaskTargets.length} client{bulkTaskTargets.length !== 1 ? 's' : ''}</button>
                <button type="button" className="ghost-button" onClick={() => setShowBulkTask(false)}>Cancel</button>
              </form>
            )}
            <div className="task-list">
              {allOpenTasks.slice(0, 20).map(task => {
                const isOverdue = task.dueDate && task.dueDate < today;
                const isDueToday = task.dueDate === today;
                return (
                  <div key={task.id} className={`task-row${task.priority === 'High' ? ' task-high' : ''}`}>
                    <div className="task-body" style={{cursor:'default'}}>
                      <span className="task-text">{task.text}</span>
                      <div className="task-chips">
                        <span className="task-chip" style={{background:'var(--surface-2)'}}>{task.clientName}</span>
                        {task.priority === 'High' && <span className="task-chip task-chip-high">High</span>}
                        {isOverdue && <span className="task-chip task-chip-due negative">{Math.abs(Math.round((new Date(task.dueDate+'T12:00:00') - new Date()) / 86400000))}d overdue</span>}
                        {!isOverdue && isDueToday && <span className="task-chip task-chip-due negative">Due today</span>}
                        {!isOverdue && !isDueToday && task.dueDate && <span className="task-chip task-chip-due muted">Due {task.dueDate}</span>}
                      </div>
                    </div>
                    <button className="ghost-button" style={{fontSize:11,padding:'2px 8px'}} onClick={() => onSelectClient?.(task.clientId)}>Go →</button>
                  </div>
                );
              })}
              {allOpenTasks.length > 20 && <p className="muted" style={{padding:'8px 0',fontSize:12}}>+{allOpenTasks.length - 20} more — navigate to individual clients to see all.</p>}
            </div>
          </section>
        );
      })()}

      {incomeProjection.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h3>Funded account income projection</h3>
            <span className="badge muted">{incomeProjection.length} accounts · based on 7-day avg P&L</span>
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Client</th>
                  <th>Progress</th>
                  <th>Profit earned</th>
                  <th>Remaining</th>
                  <th>Avg daily</th>
                  <th>Est. days to payout</th>
                </tr>
              </thead>
              <tbody>
                {incomeProjection.map((row) => (
                  <tr key={row.alias} style={{cursor:'pointer'}} onClick={() => onSelectClient?.(row.clientId)}>
                    <td><strong>{row.alias}</strong></td>
                    <td>{row.clientName}</td>
                    <td>
                      <div className="target-progress" style={{minWidth:100}}>
                        <div className="target-bar"><i style={{width:`${row.pct}%`, background: row.ready ? 'var(--green)' : row.pct >= 80 ? '#f59e0b' : 'var(--accent)'}} /></div>
                        <small className={row.ready ? 'positive' : ''}>{row.ready ? '✓ Ready' : `${row.pct}%`}</small>
                      </div>
                    </td>
                    <td className={row.profit >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.profit)}</td>
                    <td className="muted">{formatCurrency(Math.max(0, row.needed - row.profit))}</td>
                    <td className={row.avgDaily >= 0 ? 'positive' : 'negative'}>{formatCurrency(row.avgDaily)}/day</td>
                    <td>
                      {row.ready ? <span className="badge success">Payout eligible</span>
                        : row.daysLeft !== null && row.daysLeft > 0 ? <span className={row.daysLeft <= 14 ? 'positive' : ''}>{row.daysLeft}d (~{Math.ceil(row.daysLeft / 5)} weeks)</span>
                        : row.avgDaily <= 0 ? <span className="negative">Trending down</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
              const isQT = quickTaskClientId === client.id;
              return (
                <div
                  key={client.id}
                  className={`briefing-card briefing-${urgency}`}
                  style={{cursor:'pointer'}}
                  onClick={() => { if (!isQT) onSelectClient && onSelectClient(client.id); }}
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
                  {isQT ? (
                    <form className="quick-task-inline" onClick={e => e.stopPropagation()} onSubmit={e => {
                      e.preventDefault();
                      if (!quickTaskText.trim()) return;
                      onAddClientTask?.(client.id, { id: `task-${Date.now()}`, text: quickTaskText.trim(), priority: quickTaskPriority, dueDate: quickTaskDue || null, done: false, createdAt: new Date().toISOString() });
                      setQuickTaskText(''); setQuickTaskDue(''); setQuickTaskPriority('Normal'); setQuickTaskClientId(null);
                    }}>
                      <input autoFocus value={quickTaskText} onChange={e => setQuickTaskText(e.target.value)} placeholder="Task description…" style={{flex:1}} />
                      <input type="date" value={quickTaskDue} onChange={e => setQuickTaskDue(e.target.value)} style={{width:120}} />
                      <select value={quickTaskPriority} onChange={e => setQuickTaskPriority(e.target.value)} style={{width:80}}>
                        <option>Normal</option><option>High</option><option>Low</option>
                      </select>
                      <button type="submit" className="primary-button" style={{padding:'4px 10px'}}>Add</button>
                      <button type="button" className="ghost-button" onClick={() => { setQuickTaskClientId(null); setQuickTaskText(''); }}>✕</button>
                    </form>
                  ) : (
                    <button className="ghost-button" style={{fontSize:11,marginTop:4,alignSelf:'flex-start'}} onClick={e => { e.stopPropagation(); setQuickTaskClientId(client.id); setQuickTaskText(''); }}>+ Task</button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {(() => {
        const today = todayIsoDate();
        const allTasks = clients.flatMap((client) =>
          (client.tasks || [])
            .filter((t) => !t.done)
            .map((t) => ({ ...t, clientName: client.name, clientId: client.id }))
        );
        const sorted = allTasks.sort((a, b) => {
          const overA = a.dueDate && a.dueDate < today;
          const overB = b.dueDate && b.dueDate < today;
          if (overA && !overB) return -1;
          if (!overA && overB) return 1;
          const prioOrder = { High: 0, Normal: 1, Low: 2 };
          if ((prioOrder[a.priority] ?? 1) !== (prioOrder[b.priority] ?? 1)) return (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1);
          if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          return 0;
        });
        if (!sorted.length) return null;
        const overdueCount = sorted.filter((t) => t.dueDate && t.dueDate < today).length;
        return (
          <section className={overdueCount ? 'panel danger-panel' : 'panel'}>
            <div className="panel-heading">
              <h3>My task inbox</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {overdueCount ? <span className="badge danger">{overdueCount} overdue</span> : null}
                <span className="badge muted">{sorted.length} open</span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Client</th>
                    <th>Priority</th>
                    <th>Due</th>
                    <th>Account</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((task) => {
                    const isOverdue = task.dueDate && task.dueDate < today;
                    const isToday = task.dueDate === today;
                    return (
                      <tr
                        key={task.id}
                        className={isOverdue ? 'row-warning clickable-row' : 'clickable-row'}
                        onClick={() => onSelectClient && onSelectClient(task.clientId)}
                        title={`Open ${task.clientName} → Tasks`}
                      >
                        <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.text}</td>
                        <td><strong>{task.clientName}</strong></td>
                        <td>
                          <span className={task.priority === 'High' ? 'task-chip task-chip-high' : 'task-chip'}>
                            {task.priority}
                          </span>
                        </td>
                        <td className={isOverdue ? 'negative' : isToday ? 'warning' : ''}>
                          {task.dueDate ? (isOverdue ? `OVERDUE (${task.dueDate})` : isToday ? 'Today' : task.dueDate) : '—'}
                        </td>
                        <td><small>{task.accountName || '—'}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

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

      {(() => {
        const fundedRows = clients.flatMap(client => {
          const latestImport = client.dailyImports?.at(-1);
          return Object.values(client.accountRegistry || {})
            .filter(a => a.accountType === 'Funded' && a.status !== 'Failed' && a.status !== 'Ignore')
            .map(a => {
              const snap = (latestImport?.snapshots || []).find(s => s.accountName === a.accountName);
              const todayPnl = snap ? (latestImport?.snapshots || []).filter(s => s.accountName === a.accountName).reduce((t, s) => t + Number(s.grossRealizedPnl || 0), 0) : null;
              const rawDD = snap ? Number(snap.dailyNetPnl ?? snap.netPnl ?? 0) : null;
              const ddLimit = Number(a.maxDrawdownLimit || 0);
              const buffer = ddLimit > 0 && rawDD !== null ? ddLimit - Math.abs(Math.min(0, rawDD)) : null;
              const bufferPct = buffer !== null && ddLimit > 0 ? Math.round((buffer / ddLimit) * 100) : null;
              const target = Number(a.targetProfit || 0);
              const weeklyPnl = snap ? Number(snap.weeklyPnl || 0) : null;
              const pct = target > 0 && weeklyPnl !== null ? Math.min(100, Math.round((weeklyPnl / target) * 100)) : null;
              return { client, account: a, todayPnl, buffer, bufferPct, pct, weeklyPnl, target };
            });
        });
        if (!fundedRows.length) return null;
        return (
          <section className="panel">
            <div className="panel-heading"><h3>Funded accounts</h3><span className="count">{fundedRows.length}</span></div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead><tr><th>Account</th><th>Client</th><th>Today P&L</th><th>DD Buffer</th><th>Target %</th><th>Payout</th></tr></thead>
                <tbody>
                  {fundedRows.sort((a, b) => (a.bufferPct ?? 999) - (b.bufferPct ?? 999)).map(({ client, account, todayPnl, buffer, bufferPct, pct }) => (
                    <tr key={account.accountName} style={{cursor:'pointer'}} onClick={() => onSelectClient?.(client.id)}>
                      <td><strong>{account.alias || account.accountName}</strong><small className="muted">{account.accountName}</small></td>
                      <td>{client.name}</td>
                      <td className={todayPnl === null ? 'muted' : todayPnl >= 0 ? 'positive' : 'negative'}>{todayPnl === null ? '—' : (todayPnl >= 0 ? '+' : '') + formatCurrency(todayPnl)}</td>
                      <td>
                        {buffer === null ? <span className="muted">—</span> : (
                          <span className={bufferPct <= 20 ? 'negative' : bufferPct <= 40 ? 'warning' : 'positive'}>{formatCurrency(buffer)} <small className="muted">({bufferPct}%)</small></span>
                        )}
                      </td>
                      <td>{pct === null ? <span className="muted">—</span> : <span className={pct >= 100 ? 'positive' : ''}>{pct}%</span>}</td>
                      <td><span className="muted" style={{fontSize:11}}>{account.payoutState || '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

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

      {(() => {
        const allEntries = clients.flatMap(c =>
          (c.activityLog || []).map(e => ({ ...e, clientName: c.name, clientId: c.id }))
        ).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 20);
        if (!allEntries.length) return null;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>Recent activity</h3>
              <span className="badge muted">Last 20 entries across all clients</span>
            </div>
            <div className="activity-feed-global">
              {allEntries.map((entry, i) => (
                <div key={entry.id || i} className="activity-feed-row" style={{cursor:'pointer'}} onClick={() => onSelectClient?.(entry.clientId)}>
                  <span className="activity-feed-client">{entry.clientName}</span>
                  <span className="activity-feed-type muted">{entry.type}</span>
                  <span className="activity-feed-text">{entry.text}</span>
                  <span className="activity-feed-date muted">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

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

const ACTIVITY_TYPES = ['Note', 'Call', 'Message', 'Disconnection', 'Payout', 'Alert', 'Email', 'Other'];

function ActivityLog({ client, onAddEntry, onDeleteEntry }) {
  const [text, setText] = useState('');
  const [type, setType] = useState('Note');
  const [accountName, setAccountName] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
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
    const entryDate = entry.createdAt?.slice(0, 10) || '';
    if (filterFrom && entryDate < filterFrom) return false;
    if (filterTo && entryDate > filterTo) return false;
    return true;
  }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Activity log</h3><span className="count">{log.length}</span>
        {log.length > 0 && (
          <button className="ghost-button" style={{fontSize:11,marginLeft:'auto'}} onClick={() => {
            const csvCell = v => `"${String(v||'').replace(/"/g,'""').replace(/\r?\n/g,' ')}"`;
            const rows = [['Date','Type','Account','Text'].map(csvCell).join(',')];
            [...log].sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')).forEach(e => {
              const acct = Object.values(client.accountRegistry||{}).find(a=>a.accountName===e.accountName);
              rows.push([
                (e.createdAt||'').slice(0,16).replace('T',' '),
                e.type||'Note',
                acct?.alias||e.accountName||'',
                e.text||'',
              ].map(csvCell).join(','));
            });
            const csv = rows.join('\n');
            const a = document.createElement('a');
            a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
            a.download = `activity-${client.name.replace(/\s+/g,'-')}-${new Date().toISOString().slice(0,10)}.csv`;
            a.click();
          }}>⬇ Export CSV</button>
        )}
      </div>
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
          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} title="From date" style={{width:130,fontSize:12}} />
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} title="To date" style={{width:130,fontSize:12}} />
          {(filterType !== 'All' || filterSearch || filterFrom || filterTo) ? (
            <button className="ghost-button" onClick={() => { setFilterType('All'); setFilterSearch(''); setFilterFrom(''); setFilterTo(''); }}>Clear</button>
          ) : null}
          <span className="muted" style={{ fontSize: 12 }}>{filtered.length} of {log.length}</span>
        </div>
      ) : null}
      {filtered.length ? (
        <div className="activity-list">
          {filtered.map((entry) => {
            const highlight = (str) => {
              if (!filterSearch || !str) return str;
              const idx = str.toLowerCase().indexOf(filterSearch.toLowerCase());
              if (idx === -1) return str;
              return <>{str.slice(0, idx)}<mark style={{background:'rgba(69,163,255,0.3)',borderRadius:2,padding:'0 1px'}}>{str.slice(idx, idx + filterSearch.length)}</mark>{str.slice(idx + filterSearch.length)}</>;
            };
            return (
            <div className="activity-entry" key={entry.id}>
              <div className="activity-meta">
                <span className={`activity-type activity-${entry.type?.toLowerCase()}`}>{entry.type || 'Note'}</span>
                {entry.accountName ? <code>{Object.values(client.accountRegistry || {}).find((a) => a.accountName === entry.accountName)?.alias || entry.accountName}</code> : null}
                <em>{formatDate(entry.createdAt)}</em>
                <button className="ghost-button icon-only" onClick={() => onDeleteEntry(entry.id)} title="Delete entry"><Trash2 size={13} /></button>
              </div>
              <p>{highlight(entry.text)}</p>
            </div>
            );
          })}
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
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editDue, setEditDue] = useState('');
  const [editPriority, setEditPriority] = useState('Normal');
  const [taskFilter, setTaskFilter] = useState('open');

  function startEdit(task) {
    setEditingId(task.id);
    setEditText(task.text);
    setEditDue(task.dueDate || '');
    setEditPriority(task.priority || 'Normal');
  }

  function saveEdit(taskId) {
    if (editText.trim()) {
      onUpdateTask(taskId, { text: editText.trim(), dueDate: editDue, priority: editPriority });
    }
    setEditingId(null);
  }

  function cancelEdit() { setEditingId(null); }
  const tasks = (client.tasks || []).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.priority === 'High' && b.priority !== 'High') return -1;
    if (b.priority === 'High' && a.priority !== 'High') return 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  const today = todayIsoDate();
  const allTasks = tasks;
  const overdueCount = allTasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).length;
  const openCount = allTasks.filter((t) => !t.done).length;
  const doneCount = allTasks.filter((t) => t.done).length;
  const filteredTasks = taskFilter === 'all' ? allTasks
    : taskFilter === 'done' ? allTasks.filter(t => t.done)
    : taskFilter === 'overdue' ? allTasks.filter(t => !t.done && t.dueDate && t.dueDate < today)
    : allTasks.filter(t => !t.done);
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
        <div className="task-filter-chips" style={{marginLeft:'auto',display:'flex',gap:4}}>
          <button className={`ghost-button${taskFilter==='open'?' active':''}`} onClick={()=>setTaskFilter('open')}>Open{openCount>0?` (${openCount})`:''}</button>
          {overdueCount>0 && <button className={`ghost-button${taskFilter==='overdue'?' active':''}`} onClick={()=>setTaskFilter('overdue')} style={{color:'var(--red)'}}>Overdue ({overdueCount})</button>}
          <button className={`ghost-button${taskFilter==='done'?' active':''}`} onClick={()=>setTaskFilter('done')}>Done{doneCount>0?` (${doneCount})`:''}</button>
          <button className={`ghost-button${taskFilter==='all'?' active':''}`} onClick={()=>setTaskFilter('all')}>All</button>
          {openCount>1 && <button className="ghost-button" title="Mark all open tasks done" onClick={()=>{allTasks.filter(t=>!t.done).forEach(t=>onUpdateTask(t.id,{done:true}));}}>✓ All</button>}
        </div>
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
      {filteredTasks.length ? (
        <div className="task-list">
          {filteredTasks.map((task) => {
            const due = formatDue(task.dueDate);
            const alias = task.accountName
              ? (accounts.find((a) => a.accountName === task.accountName)?.alias || task.accountName)
              : null;
            return (
              <div className={`task-row${task.done ? ' task-done' : ''}${task.priority === 'High' && !task.done ? ' task-high' : ''}${editingId === task.id ? ' task-editing' : ''}`} key={task.id}>
                {editingId === task.id ? (
                  <div className="task-edit-inline">
                    <input className="task-text-input" value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEdit(task.id); if (e.key === 'Escape') cancelEdit(); }} autoFocus />
                    <div className="task-form-meta">
                      <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)} />
                      <select value={editPriority} onChange={e => setEditPriority(e.target.value)}>
                        {TASK_PRIORITIES.map(p => <option key={p}>{p}</option>)}
                      </select>
                      <button className="primary-button" onClick={() => saveEdit(task.id)}>Save</button>
                      <button className="ghost-button" onClick={cancelEdit}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button className="task-checkbox" title={task.done ? 'Mark open' : 'Mark done'} onClick={() => onUpdateTask(task.id, { done: !task.done })}>
                      <CheckSquare size={16} className={task.done ? 'task-checked' : 'task-unchecked'} />
                    </button>
                    <div className="task-body" style={{cursor:'pointer'}} onClick={() => !task.done && startEdit(task)} title={task.done ? '' : 'Click to edit'}>
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
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">{taskFilter==='open'&&allTasks.length?'No open tasks — all done!':taskFilter==='overdue'?'No overdue tasks.':taskFilter==='done'&&!doneCount?'No completed tasks yet.':'No tasks yet. Add follow-ups, reminders, or action items above.'}</p>
      )}
    </section>
  );
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      className="ghost-button icon-only copy-btn"
      title="Copy to clipboard"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? '✓' : <Copy size={12} />}
    </button>
  );
}

function CredentialsTab({ client, onUpdateClient, onDeleteClient }) {
  const credentials = client.credentials || {};
  const profile = client.profile || {};
  const [showPasswords, setShowPasswords] = useState(false);

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
          <label>Email
            <div className="input-copy-row">
              <input type="email" value={profile.email || ''} placeholder="client@email.com" onChange={(e) => updateProfile({ email: e.target.value })} />
              {profile.email && <a className="ghost-button icon-only" href={`mailto:${profile.email}`} title="Send email" style={{display:'flex',alignItems:'center',padding:'0 6px',textDecoration:'none'}}>✉</a>}
              <CopyButton value={profile.email} />
            </div>
          </label>
          <label>Phone
            <div className="input-copy-row">
              <input type="tel" value={profile.phone || ''} placeholder="+1 (555) 000-0000" onChange={(e) => updateProfile({ phone: e.target.value })} />
              {profile.phone && <a className="ghost-button icon-only" href={`tel:${profile.phone}`} title="Call" style={{display:'flex',alignItems:'center',padding:'0 6px',textDecoration:'none'}}>📞</a>}
              <CopyButton value={profile.phone} />
            </div>
          </label>
          <label>Time zone<input value={profile.timezone || ''} placeholder="e.g. America/New_York" onChange={(e) => updateProfile({ timezone: e.target.value })} /></label>
          <label>Prop firm<input value={profile.propFirm || ''} placeholder="e.g. Apex, TopStep, FTMO" onChange={(e) => updateProfile({ propFirm: e.target.value })} /></label>
          <label>Discord / Telegram
            <div className="input-copy-row">
              <input value={profile.messenger || ''} placeholder="Handle or username" onChange={(e) => updateProfile({ messenger: e.target.value })} />
              <CopyButton value={profile.messenger} />
            </div>
          </label>
          <label>Client stage
            <select value={profile.stage || 'Active'} onChange={(e) => updateProfile({ stage: e.target.value })}>
              <option>Onboarding</option>
              <option>Active</option>
              <option>At Risk</option>
              <option>Paused</option>
              <option>Inactive</option>
            </select>
          </label>
          <label>Preferred channel
            <select value={profile.preferredChannel || ''} onChange={(e) => updateProfile({ preferredChannel: e.target.value })}>
              <option value="">— Not set —</option>
              <option>WhatsApp</option>
              <option>Telegram</option>
              <option>Email</option>
              <option>Discord</option>
              <option>Other</option>
            </select>
          </label>
          <label>Language
            <select value={profile.language || ''} onChange={(e) => updateProfile({ language: e.target.value })}>
              <option value="">— Not set —</option>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <label>Country<input value={profile.country || ''} placeholder="e.g. Colombia, USA" onChange={(e) => updateProfile({ country: e.target.value })} /></label>
          <label>Start date<input type="date" value={profile.startDate || ''} onChange={(e) => updateProfile({ startDate: e.target.value })} /></label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>VPS / Platform access</h3><Lock size={16} />
          <button className="ghost-button" style={{marginLeft:'auto',fontSize:12}} onClick={() => setShowPasswords(v => !v)}>
            {showPasswords ? '🙈 Hide passwords' : '👁 Show passwords'}
          </button>
        </div>
        <div className="form-grid">
          <label>VPS IP<div className="input-copy-row"><input value={credentials.ip || ''} onChange={(e) => updateCredentials({ ip: e.target.value })} /><CopyButton value={credentials.ip} /></div></label>
          <label>Username<div className="input-copy-row"><input value={credentials.username || ''} onChange={(e) => updateCredentials({ username: e.target.value })} /><CopyButton value={credentials.username} /></div></label>
          <label>Password<div className="input-copy-row"><input type={showPasswords ? 'text' : 'password'} value={credentials.password || ''} onChange={(e) => updateCredentials({ password: e.target.value })} /><CopyButton value={credentials.password} /></div></label>
          <label>NT login<div className="input-copy-row"><input value={credentials.ntLogin || ''} placeholder="NinjaTrader username" onChange={(e) => updateCredentials({ ntLogin: e.target.value })} /><CopyButton value={credentials.ntLogin} /></div></label>
          <label>Prop firm login<div className="input-copy-row"><input value={credentials.firmLogin || ''} placeholder="Dashboard login email" onChange={(e) => updateCredentials({ firmLogin: e.target.value })} /><CopyButton value={credentials.firmLogin} /></div></label>
          <label>Prop firm password<div className="input-copy-row"><input type={showPasswords ? 'text' : 'password'} value={credentials.firmPassword || ''} onChange={(e) => updateCredentials({ firmPassword: e.target.value })} /><CopyButton value={credentials.firmPassword} /></div></label>
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

      <section className="panel" style={{borderColor:'var(--red)',opacity:0.8}}>
        <div className="panel-heading"><h3>Danger zone</h3></div>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'4px 0'}}>
          <div>
            <strong style={{fontSize:13}}>Remove client</strong>
            <p className="muted" style={{fontSize:12,margin:'2px 0 0'}}>Permanently deletes all data for this client. Export a backup first.</p>
          </div>
          <button className="secondary-button" style={{color:'var(--red)',borderColor:'var(--red)',flexShrink:0}} onClick={onDeleteClient}>
            <Trash2 size={13} /> Remove client
          </button>
        </div>
      </section>
    </div>
  );
}

const DEFAULT_PRICE_CHECK_ROWS = [
  { id: 'pc-1', instrument: 'MNQ', checkTime: '09:00', connection: '', algos: '', notes: '', checked: false },
  { id: 'pc-2', instrument: 'MES', checkTime: '10:00', connection: '', algos: '', notes: '', checked: false },
];

function PriceChecksTab({ client, onUpdateClient }) {
  const nextRowId = useRef((client.priceChecks?.length || DEFAULT_PRICE_CHECK_ROWS.length) + 1);
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
    const id = `pc-custom-${nextRowId.current}`;
    nextRowId.current += 1;
    save([
      ...activeChecks,
      { id, instrument: '', checkTime: '', connection: '', algos: '', notes: '', checked: false },
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
  const [showSOP, setShowSOP] = useState(false);
  const [showQuickLog, setShowQuickLog] = useState(false);
  const [quickLogType, setQuickLogType] = useState('Note');
  const [quickLogText, setQuickLogText] = useState('');
  const [quickLogAccount, setQuickLogAccount] = useState('');
  const [reportImport, setReportImport] = useState(null);
  const [monthlyReportMonth, setMonthlyReportMonth] = useState(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [strategySetIndex, setStrategySetIndex] = useState({ status: 'Not loaded', records: [] });
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchIdx, setGlobalSearchIdx] = useState(0);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setGlobalSearchOpen(v => !v); setGlobalSearchQuery(''); }
      if (e.key === 'Escape') setGlobalSearchOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => saveDemoState(state), [state]);
  useEffect(() => saveUsers(users), [users]);

  useEffect(() => {
    function onKey(e) {
      // Ignore when typing in an input/textarea/select
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.altKey && e.key === 'l') { e.preventDefault(); setShowQuickLog(v => !v); }
      if (e.altKey && e.key === 'u') { e.preventDefault(); setShowUpload(v => !v); }
      if (e.altKey && e.key === 'o') { e.preventDefault(); setShowOverview(true); setShowSOP(false); }
      if (e.altKey && e.key === 's') { e.preventDefault(); setShowSOP(true); setShowOverview(false); }
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        setActiveTab('Tasks');
        setShowOverview(false); setShowSOP(false);
        setTimeout(() => document.querySelector('.task-text-input')?.focus(), 100);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    setShowOverview(false); setShowSOP(false);
  }

  function openCamWorkspace(camId = 'am-pedro', clientId = null) {
    setState((current) => {
      const next = selectCam(current, camId);
      return clientId ? { ...next, selectedClientId: clientId } : next;
    });
    setPlatformView('cam');
    setShowOverview(false); setShowSOP(false);
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
    if (!window.confirm(`Import "${file.name}"? This will replace all current data.`)) return;
    try {
      const text = await file.text();
      const imported = parseImportedState(text);
      setState(imported);
      setShowOverview(false); setShowSOP(false);
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

  function handleLogPayout(accountName, entry) {
    if (!selectedClient) return;
    setState((current) => {
      const clientData = (current.clients || []).find(c => c.id === selectedClient.id);
      const existing = clientData?.accountRegistry?.[accountName]?.payoutHistory || [];
      const newHistory = [...existing, entry];
      const prevCount = Number(clientData?.accountRegistry?.[accountName]?.payoutCount || 0);
      return upsertAccountMeta(current, selectedClient.id, accountName, {
        payoutHistory: newHistory,
        payoutCount: prevCount + 1,
        dateLastPayout: entry.date,
      });
    });
  }

  function handleUpdateClient(patch) {
    if (!selectedClient) return;
    setState((current) => updateClientDetails(current, selectedClient.id, patch));
  }

  function handleDeleteClient() {
    if (!selectedClient) return;
    if (!window.confirm(`Remove "${selectedClient.name}" from this workspace? This cannot be undone. Export a backup first if you need the data.`)) return;
    setState((current) => removeClient(current, selectedClient.id));
  }

  function handleResolveFlag(flagId) {
    if (!selectedClient || !dailyImport) return;
    const flag = (dailyImport.flags || []).find((f) => f.id === flagId);
    setState((current) => {
      let next = resolveFlagInImport(current, selectedClient.id, dailyImport.id, flagId);
      if (flag) {
        const entry = {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'Alert',
          text: `Flag resolved: [${flag.type}] ${flag.message}`,
          accountName: flag.accountName || '',
          createdAt: new Date().toISOString(),
        };
        next = addActivityEntry(next, selectedClient.id, entry);
      }
      return next;
    });
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

  const [copyDone, setCopyDone] = useState(false);
  const [copyWeekDone, setCopyWeekDone] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  function copyClientReport() {
    if (!selectedClient || !dailyImport) return;
    const text = buildClientMessageReport(selectedClient, dailyImport);
    navigator.clipboard.writeText(text).then(() => {
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 2000);
      setState((current) => addActivityEntry(current, selectedClient.id, {
        id: `act-send-${Date.now()}`,
        type: 'Message',
        text: `Daily update sent (${dailyImport.date})`,
        createdAt: new Date().toISOString(),
      }));
    });
  }

  function copyWeeklyReport() {
    if (!selectedClient) return;
    const text = buildWeeklyMessageReport(selectedClient);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopyWeekDone(true);
      setTimeout(() => setCopyWeekDone(false), 2000);
      setState((current) => addActivityEntry(current, selectedClient.id, {
        id: `act-wsend-${Date.now()}`,
        type: 'Message',
        text: `Weekly summary sent`,
        createdAt: new Date().toISOString(),
      }));
    });
  }

  function closeImport() {
    if (!selectedClient || !dailyImport) return;
    const flags = (dailyImport.flags || []).filter((f) => f.severity === 'Critical' && f.status !== 'Resolved');
    const msg = flags.length
      ? `This close has ${flags.length} unresolved critical flag${flags.length > 1 ? 's' : ''}. Close anyway?`
      : 'Mark this day as closed? This locks the close record.';
    if (!window.confirm(msg)) return;
    setState((current) => updateImportStatus(current, selectedClient.id, dailyImport.id, 'Closed'));
  }

  function reopenImport() {
    if (!selectedClient || !dailyImport) return;
    if (!window.confirm('Reopen this day? The close will return to "Needs review" status.')) return;
    setState((current) => updateImportStatus(current, selectedClient.id, dailyImport.id, 'Needs review'));
  }

  function closeAllToday() {
    const today = todayIsoDate();
    const toClose = currentCamClients.filter(c => {
      const imp = getClientImportByDate(c, today);
      return imp && imp.status !== 'Closed';
    });
    if (!toClose.length) { window.alert('No open imports for today — all clients are already closed or have no upload.'); return; }
    const critCount = toClose.reduce((n, c) => {
      const imp = getClientImportByDate(c, today);
      return n + (imp?.flags || []).filter(f => f.severity === 'Critical' && f.status !== 'Resolved').length;
    }, 0);
    const msg = critCount
      ? `Close today for ${toClose.length} client${toClose.length !== 1 ? 's' : ''}? There are ${critCount} unresolved critical flag${critCount !== 1 ? 's' : ''} across these clients.`
      : `Close today for ${toClose.length} client${toClose.length !== 1 ? 's' : ''}?`;
    if (!window.confirm(msg)) return;
    setState(current => toClose.reduce((s, c) => {
      const imp = getClientImportByDate(c, today);
      return imp ? updateImportStatus(s, c.id, imp.id, 'Closed') : s;
    }, current));
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
      <ErrorBoundary>
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
        onUpdateClientAccount={(clientId, accountName, patch) =>
          setState((current) => upsertAccountMeta(current, clientId, accountName, patch))
        }
        onTransferClient={(clientId, toCamId) =>
          setState((current) => transferClient(current, clientId, toCamId))
        }
        teamAnnouncement={state.teamAnnouncement || ''}
        onSetAnnouncement={msg => setState(s => ({ ...s, teamAnnouncement: msg }))}
        onResolveFlag={(clientId, importId, flagId) =>
          setState((current) => resolveFlagInImport(current, clientId, importId, flagId))
        }
        onAddClient={(name, camId, stage) => setState(current => {
          const withClient = addClient(current, name, camId || null);
          const newClient = withClient.clients.find(c => c.name === name && !(current.clients.find(x => x.id === c.id)));
          if (newClient && stage && stage !== 'Active') {
            return { ...withClient, clients: withClient.clients.map(c => c.id === newClient.id ? { ...c, profile: { ...c.profile, stage } } : c) };
          }
          return withClient;
        })}
      />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <>
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-role-row">
            <span className="sidebar-role-badge cam-badge">CAM</span>
            <button className="sidebar-logout-btn" onClick={() => setSession(null)} title="Sign out"><LogOut size={14} /></button>
          </div>
          <strong>{currentCamProfile?.name || state.accountManager.name}</strong>
          <small className="sidebar-role-sub">{session?.displayName || session?.username || ''} · {session?.role || 'CAM'}</small>
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
        <button className="global-search-trigger" onClick={() => { setGlobalSearchOpen(true); setGlobalSearchQuery(''); }} title="Search all clients (⌘K)">
          <span>⌕ Search all…</span><kbd>⌘K</kbd>
        </button>
        <input
          className="client-search"
          value={clientSearch}
          placeholder="Filter sidebar..."
          onChange={(e) => setClientSearch(e.target.value)}
        />
        <nav className="client-list">
          {(() => {
            const today = todayIsoDate();
            const urgentCount = currentCamClients.reduce((total, c) => {
              const critFlags = (c.dailyImports?.at(-1)?.flags || []).filter(f => f.severity === 'Critical' && f.status !== 'Resolved').length;
              const overdueTasks = (c.tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < today).length;
              return total + critFlags + overdueTasks;
            }, 0);
            return (
              <button className={showOverview && !showSOP ? 'client-link active' : 'client-link'} onClick={() => { setShowOverview(true); setShowSOP(false); }}>
                <Users size={16} />
                <span>CAM Overview</span>
                {urgentCount > 0 ? <em className="danger">{urgentCount} urgent</em> : <em>Live</em>}
              </button>
            );
          })()}
          <button className={showSOP ? 'client-link active' : 'client-link'} onClick={() => { setShowSOP(true); setShowOverview(false); }}>
            <CheckSquare size={16} />
            <span>Daily SOP</span>
            <em>Checklist</em>
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
                    onClick={() => { setState((current) => selectClient(current, client.id)); setShowOverview(false); setShowSOP(false); setClientSearch(''); }}
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
              {[...currentCamClients].sort((a, b) => {
                if (a.pinned && !b.pinned) return -1;
                if (b.pinned && !a.pinned) return 1;
                const urgencyScore = (c) => {
                  const bd = deriveClientBadge(c);
                  if (bd.tone === 'danger') return 0;
                  if (bd.tone === 'warning') return 1;
                  if (bd.tone === 'muted' && bd.label !== 'No data') return 2;
                  return 3;
                };
                const diff = urgencyScore(a) - urgencyScore(b);
                if (diff !== 0) return diff;
                const critA = (a.dailyImports?.at(-1)?.flags || []).filter(f => f.severity === 'Critical' && f.status !== 'Resolved').length;
                const critB = (b.dailyImports?.at(-1)?.flags || []).filter(f => f.severity === 'Critical' && f.status !== 'Resolved').length;
                return critB - critA;
              }).map((client) => {
                const badge = deriveClientBadge(client);
                const todayClose = getClientImportByDate(client, todayIsoDate());
                const closeStatus = !todayClose ? 'no-close' : todayClose.status === 'Closed' ? 'closed' : 'uploaded';
                return (
                  <button
                    className={!showOverview && selectedClient?.id === client.id ? 'client-link active' : 'client-link'}
                    key={client.id}
                    onClick={() => { setState((current) => selectClient(current, client.id)); setShowOverview(false); setShowSOP(false); }}
                  >
                    <span className={`close-dot close-dot-${closeStatus}`} title={closeStatus === 'no-close' ? 'No files today' : closeStatus === 'closed' ? 'Closed today' : 'Uploaded · not closed'} />
                    <span>{client.name}{(() => { const d = lastContactDaysAgo(client); return d !== null && d > 3 ? <span className="last-contact-dot" title={`Last contact ${d}d ago`} style={{ background: d > 7 ? 'var(--red)' : 'var(--yellow)' }} /> : null; })()}{(() => { const td = todayIsoDate(); const tasks = (client.tasks||[]).filter(t=>!t.done); const overdue=tasks.filter(t=>t.dueDate&&t.dueDate<td).length; const dueToday=tasks.filter(t=>t.dueDate===td).length; if(overdue) return <span style={{marginLeft:3,fontSize:9,fontWeight:700,color:'var(--negative)',background:'rgba(239,68,68,0.15)',borderRadius:3,padding:'1px 3px'}} title={`${overdue} overdue task${overdue!==1?'s':''}`}>{overdue}</span>; if(dueToday) return <span style={{marginLeft:3,fontSize:9,fontWeight:700,color:'var(--warning)',background:'rgba(245,158,11,0.15)',borderRadius:3,padding:'1px 3px'}} title={`${dueToday} task${dueToday!==1?'s':''} due today`}>{dueToday}</span>; return null; })()}</span>
                    {(() => {
                      const latest = client.dailyImports?.at(-1);
                      if (!latest) return null;
                      const pnl = (latest.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
                      return <small className={pnl >= 0 ? 'sidebar-pnl positive' : 'sidebar-pnl negative'}>{pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}</small>;
                    })()}
                    <span
                      className={`pin-btn${client.pinned ? ' pinned' : ''}`}
                      title={client.pinned ? 'Unpin client' : 'Pin to top'}
                      onClick={e => { e.stopPropagation(); setState(s => togglePinClient(s, client.id)); }}
                    >★</span>
                    <em className={badge.tone}>{badge.label}</em>
                  </button>
                );
              })}
            </>
          )}
        </nav>
      </aside>

      {showSOP ? (
        <main className="content">
          <div className="page-header">
            <div>
              <span className="eyebrow">CAM workspace</span>
              <h1>Daily SOP</h1>
              <p>Morning-to-close checklist — resets every trading day.</p>
            </div>
          </div>
          <DailySOP />
        </main>
      ) : showOverview ? (
        <>
        {state.teamAnnouncement && (
          <div className="team-announcement-banner cam-announcement" style={{margin:'12px 20px 0'}}>
            <span>📢</span>
            <span style={{flex:1}}><strong>Manager:</strong> {state.teamAnnouncement}</span>
          </div>
        )}
        <CamOverview
          clients={currentCamClients}
          camProfiles={state.camProfiles || []}
          allClients={state.clients || []}
          strategySetRecords={strategySetIndex.records}
          strategySetIndexStatus={strategySetIndex.status}
          camName={currentCamProfile?.name || ''}
          onSelectClient={(clientId) => {
            setState((current) => selectClient(current, clientId));
            setShowOverview(false); setShowSOP(false);
          }}
          onAddClientTask={(clientId, task) => setState((current) => addTask(current, clientId, task))}
        />
        </>
      ) : (
        <main className="content">
          {!selectedClient ? (
            <div className="onboarding-empty">
              <div className="onboarding-hero">
                <Users size={36} />
                <h2>Welcome, {session?.displayName || currentCamProfile?.name || 'CAM'}</h2>
                <p className="muted">Your workspace is ready. Here's how to get started:</p>
              </div>
              <div className="onboarding-steps">
                <div className="onboarding-step">
                  <span className="onboarding-step-num">1</span>
                  <div>
                    <strong>Add your clients</strong>
                    <p>Use the <em>+ Add client</em> button in the left sidebar to create a client profile for each trader you manage. Enter their name, then configure their accounts in the Account Registry tab.</p>
                  </div>
                </div>
                <div className="onboarding-step">
                  <span className="onboarding-step-num">2</span>
                  <div>
                    <strong>Fill in client profile & credentials</strong>
                    <p>In <em>Credentials & Notes</em>, save the client's VPS IP, NinjaTrader login, email, and Telegram handle. This is your quick-access reference during market hours.</p>
                  </div>
                </div>
                <div className="onboarding-step">
                  <span className="onboarding-step-num">3</span>
                  <div>
                    <strong>Upload daily NT files</strong>
                    <p>After market close, export the Accounts + Strategies CSV from NinjaTrader and upload both here. The dashboard auto-generates flags, drawdown status, and the client report.</p>
                  </div>
                </div>
                <div className="onboarding-step">
                  <span className="onboarding-step-num">4</span>
                  <div>
                    <strong>Log activity & tasks</strong>
                    <p>Use <em>Quick Log</em> (Alt+L) to record calls, messages, and observations. Create tasks with due dates so nothing falls through the cracks.</p>
                  </div>
                </div>
              </div>
              <p className="muted" style={{textAlign:'center',fontSize:12,marginTop:16}}>Tip: press <kbd>Alt+O</kbd> for CAM Overview · <kbd>Alt+S</kbd> for Daily SOP · <kbd>Alt+L</kbd> to quick-log</p>
            </div>
          ) : (
            <>
              <div className="page-header">
                <div>
                  <span className="eyebrow">Client workspace</span>
                  <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {selectedClient.name}
                    {selectedClient.profile?.stage && selectedClient.profile.stage !== 'Active'
                      ? <span className={`client-stage-badge stage-${(selectedClient.profile.stage || '').toLowerCase().replace(' ', '-')}`}>{selectedClient.profile.stage}</span>
                      : null}
                  </h1>
                  <p>{dailyImport ? `${dailyImport.status} · ${dailyImport.flags.length} flags` : 'No close loaded for this date'}</p>
                </div>
                <div className="header-actions">
                  <div className="date-nav">
                    <button className="ghost-button icon-only" title="Previous day" onClick={() => {
                      const d = new Date(selectedDate + 'T12:00:00'); d.setDate(d.getDate() - 1);
                      setSelectedDate(d.toISOString().slice(0, 10));
                    }}><ChevronLeft size={15} /></button>
                    <label className="date-control"><CalendarDays size={16} /><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
                    <button className="ghost-button icon-only" title="Next day" onClick={() => {
                      const d = new Date(selectedDate + 'T12:00:00'); d.setDate(d.getDate() + 1);
                      setSelectedDate(d.toISOString().slice(0, 10));
                    }}><ChevronRight size={15} /></button>
                  </div>
                  <button className="ghost-button" disabled={!selectedClient} onClick={() => setShowQuickLog(v => !v)} title="Quick Log (Alt+L)"><Plus size={16} /> Quick Log</button>
                  <button className="ghost-button" disabled={!selectedClient} onClick={() => setShowTemplates(v => !v)} title="Message templates for WhatsApp/Telegram">📋 Templates</button>
                  <button className="secondary-button" onClick={() => setShowUpload((value) => !value)} title="Upload NT CSV files (Alt+U)"><Upload size={16} /> Upload Daily Files</button>
                  <button className="ghost-button" disabled={!dailyImport} onClick={copyClientReport} title="Copy pre-formatted daily update for WhatsApp/Telegram">
                    <Copy size={16} />{copyDone ? ' Copied!' : ' Copy Update'}
                  </button>
                  <button className="ghost-button" disabled={!selectedClient} onClick={copyWeeklyReport} title="Copy weekly summary for WhatsApp/Telegram">
                    <Copy size={16} />{copyWeekDone ? ' Copied!' : ' Copy Week'}
                  </button>
                  <button className="primary-button" disabled={!dailyImport} onClick={() => setReportImport(dailyImport)}><FileText size={16} /> Build Daily Report</button>
                  {dailyImport?.status === 'Closed'
                    ? <button className="ghost-button" onClick={reopenImport}><RefreshCw size={16} /> Reopen Day</button>
                    : <button className="ghost-button" disabled={!dailyImport} onClick={closeImport}><CheckCircle2 size={16} /> Close Day</button>}
                  {(() => {
                    const today = todayIsoDate();
                    const openToday = currentCamClients.filter(c => { const imp = getClientImportByDate(c, today); return imp && imp.status !== 'Closed'; });
                    if (openToday.length < 2) return null;
                    return <button className="ghost-button" onClick={closeAllToday} title="Close today for all clients that have an upload"><CheckCircle2 size={16} /> Close all ({openToday.length})</button>;
                  })()}

                </div>
              </div>

              {!dailyImport && selectedClient && !(selectedClient.dailyImports?.length) && (
                <OnboardingChecklist client={selectedClient} onSwitchTab={setActiveTab} />
              )}
              {showUpload || !dailyImport ? <UploadArea onParsed={handleParsedFiles} /> : null}

              {showQuickLog && selectedClient && (
                <form className="quick-log-panel" onSubmit={(e) => {
                  e.preventDefault();
                  if (!quickLogText.trim()) return;
                  handleAddActivity({
                    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    type: quickLogType,
                    text: quickLogText.trim(),
                    accountName: quickLogAccount,
                    createdAt: new Date().toISOString(),
                  });
                  setQuickLogText('');
                  setQuickLogAccount('');
                  setShowQuickLog(false);
                }}>
                  <select value={quickLogType} onChange={e => setQuickLogType(e.target.value)}>
                    {ACTIVITY_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                  <select value={quickLogAccount} onChange={e => setQuickLogAccount(e.target.value)}>
                    <option value="">All accounts</option>
                    {Object.values(selectedClient.accountRegistry || {}).map(a => (
                      <option key={a.accountName} value={a.accountName}>{a.alias || a.accountName}</option>
                    ))}
                  </select>
                  <input
                    autoFocus
                    value={quickLogText}
                    placeholder="What happened? (call outcome, action taken, client feedback...)"
                    onChange={e => setQuickLogText(e.target.value)}
                  />
                  <button className="primary-button" type="submit"><Plus size={14} /> Log</button>
                  <button className="ghost-button" type="button" onClick={() => setShowQuickLog(false)}>Cancel</button>
                </form>
              )}

              {showTemplates && selectedClient && (() => {
                const clientName = selectedClient.profile?.fullName || selectedClient.name;
                const templates = [
                  { label: 'Daily update', text: `Hola ${clientName} 👋\n\nAquí tu resumen de hoy:\n📊 P&L: [AMOUNT]\n📉 Drawdown buffer: [BUFFER]\n✅ Todo bien — seguimos mañana!` },
                  { label: 'Drawdown warning', text: `Hola ${clientName} — quick update:\n\n⚠️ Tu cuenta está acercándose al límite de drawdown.\n💰 Buffer restante: [BUFFER]\n\nVamos a monitorear de cerca. Si tienes dudas, avísame.` },
                  { label: 'Eval passed', text: `🎉 Buenas noticias ${clientName}!\n\nTu cuenta de evaluación **PASÓ**.\n✅ Pasando al proceso de fondeo.\n📋 Próximos pasos: [STEPS]\n\nFelicidades!` },
                  { label: 'Payout processing', text: `Hola ${clientName} 👋\n\n💸 Tu payout ha sido solicitado y está en proceso.\n📅 Tiempo estimado: 3–5 días hábiles.\n\nAvisamos cuando se confirme.` },
                  { label: 'Weekly check-in', text: `Hola ${clientName} — resumen semanal:\n\n📅 Semana del [DATE]\n📊 P&L semana: [WEEKLY_PNL]\n📈 Días positivos: [WIN_DAYS]/[TOTAL_DAYS]\n\nSeguimos la próxima semana. Cualquier duda, aquí estamos!` },
                  { label: 'Account at risk', text: `${clientName} — importante:\n\n🚨 Tu cuenta está en zona de riesgo.\nDrawdown buffer: [BUFFER]\n\nPor favor revisa tu VPS y confirma que todo esté corriendo bien. Si necesitas pausar la estrategia, avísame ANTES de hacer cambios.` },
                  { label: 'VPS issue detected', text: `Hola ${clientName} 👋\n\n🖥️ Detecté una posible desconexión en tu VPS.\nVerifiqué [ACCOUNT] — [STATUS].\n\nTe aviso si hay algo que necesite tu atención.` },
                ];
                return (
                  <div className="templates-panel">
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                      <strong style={{fontSize:13}}>Message templates</strong>
                      <button className="ghost-button" style={{fontSize:11}} onClick={() => setShowTemplates(false)}>✕ Close</button>
                    </div>
                    <div className="templates-grid">
                      {templates.map(t => (
                        <button key={t.label} className="ghost-button" style={{textAlign:'left',padding:'6px 10px',fontSize:12,justifyContent:'flex-start'}}
                          onClick={() => { navigator.clipboard.writeText(t.text); setShowTemplates(false); handleAddActivity({ id: `act-${Date.now()}`, type: 'Message', text: `Template sent: ${t.label}`, createdAt: new Date().toISOString() }); }}>
                          📋 {t.label}
                        </button>
                      ))}
                    </div>
                    <p className="muted" style={{fontSize:11,marginTop:6}}>Clicking copies template to clipboard and logs it as a Message activity.</p>
                  </div>
                );
              })()}

              {(() => {
                const actions = buildTodayActions(selectedClient, dailyImport);
                if (!actions.length) return null;
                return (
                  <div className="today-banner">
                    {actions.map((a, i) => (
                      <div key={i} className={`today-banner-item today-banner-${a.severity}`}>
                        <span>{a.icon}</span>
                        <span>{a.text}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {(() => {
                const note = selectedClient.pinnedNote;
                const [editing, setEditing] = React.useState(false);
                const [draft, setDraft] = React.useState(note || '');
                if (!editing && !note) return (
                  <button className="ghost-button" style={{fontSize:11,marginBottom:4,alignSelf:'flex-start',color:'var(--muted)'}} onClick={() => { setDraft(''); setEditing(true); }}>📌 Pin a note…</button>
                );
                if (editing) return (
                  <div className="pinned-note editing">
                    <span>📌</span>
                    <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder="Pinned note — always visible (VPS IP, client quirks, warnings…)" style={{flex:1,background:'transparent',border:'none',color:'var(--text)',fontSize:13,resize:'vertical',outline:'none'}} onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) { handleUpdateClient({ pinnedNote: draft.trim() }); setEditing(false); } if (e.key === 'Escape') setEditing(false); }} />
                    <button className="primary-button" style={{padding:'3px 10px',fontSize:12}} onClick={() => { handleUpdateClient({ pinnedNote: draft.trim() }); setEditing(false); }}>Save</button>
                    <button className="ghost-button" style={{fontSize:12}} onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                );
                return (
                  <div className="pinned-note" onClick={() => { setDraft(note); setEditing(true); }} title="Click to edit pinned note">
                    <span>📌</span>
                    <span style={{flex:1,fontSize:13}}>{note}</span>
                    <button className="ghost-button" style={{fontSize:11,padding:'2px 6px'}} onClick={e => { e.stopPropagation(); handleUpdateClient({ pinnedNote: '' }); }}>✕</button>
                  </div>
                );
              })()}

              <div className="tabs">
                {visibleTabs.map((tab) => (
                  <button className={effectiveActiveTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>
                ))}
              </div>

              {effectiveActiveTab === 'Overview' ? <ClientOverview client={selectedClient} dailyImport={dailyImport} allClients={state.clients || []} onRequestMonthlyReport={(month) => setMonthlyReportMonth(month)} onLogPayout={handleLogPayout} /> : null}
              {effectiveActiveTab === 'Activity' ? <ActivityLog client={selectedClient} onAddEntry={handleAddActivity} onDeleteEntry={handleDeleteActivity} /> : null}
              {effectiveActiveTab === 'Tasks' ? <TasksTab client={selectedClient} onAddTask={handleAddTask} onUpdateTask={handleUpdateTask} onDeleteTask={handleDeleteTask} /> : null}
              {effectiveActiveTab === 'Credentials & Notes' ? <CredentialsTab client={selectedClient} onUpdateClient={handleUpdateClient} onDeleteClient={handleDeleteClient} /> : null}
              {effectiveActiveTab === 'Price Checks' ? <PriceChecksTab client={selectedClient} onUpdateClient={handleUpdateClient} /> : null}
              {effectiveActiveTab === 'Stack Playbook' ? <StackPlaybook client={selectedClient} dailyImport={dailyImport} onUpdateAccount={handleAccountUpdate} allClients={state.clients || []} /> : null}
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
                    client={selectedClient}
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
                        onAddAccount={(accountName, meta) => {
                          if (!selectedClient || !accountName.trim()) return;
                          setState((current) => upsertAccountMeta(current, selectedClient.id, accountName.trim(), meta));
                        }}
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
    {monthlyReportMonth ? <MonthlyReportPanel client={selectedClient} month={monthlyReportMonth} onClose={() => setMonthlyReportMonth(null)} /> : null}
    {globalSearchOpen && (() => {
      const q = globalSearchQuery.toLowerCase().trim();
      const clients = state.clients || [];
      const results = !q ? [] : clients.flatMap(client => {
        const hits = [];
        (client.activityLog || []).filter(e => e.text?.toLowerCase().includes(q)).forEach(e => hits.push({ client, kind: 'Activity', text: e.text, sub: e.type + ' · ' + (e.createdAt||'').slice(0,10), tab: 'Activity' }));
        (client.tasks || []).filter(t => t.text?.toLowerCase().includes(q)).forEach(t => hits.push({ client, kind: 'Task', text: t.text, sub: (t.done ? '✓ Done' : 'Open') + (t.dueDate ? ' · due ' + t.dueDate : ''), tab: 'Tasks' }));
        const profile = client.profile || {};
        if ([profile.fullName, profile.email, profile.phone, profile.messenger, profile.notes].some(v => v?.toLowerCase().includes(q))) {
          hits.push({ client, kind: 'Profile', text: profile.fullName || client.name, sub: 'Profile / notes', tab: 'Credentials & Notes' });
        }
        Object.values(client.accountRegistry || {}).filter(a => a.accountName?.toLowerCase().includes(q) || a.alias?.toLowerCase().includes(q)).forEach(a => {
          hits.push({ client, kind: 'Account', text: a.alias || a.accountName, sub: `${a.accountType || 'Account'} · ${a.accountName}`, tab: 'Overview' });
        });
        if (client.name?.toLowerCase().includes(q) && !hits.length) {
          hits.push({ client, kind: 'Client', text: client.name, sub: 'Client name match', tab: 'Overview' });
        }
        return hits;
      }).slice(0, 30);
      return (
        <div className="global-search-overlay" onClick={e => { if (e.target === e.currentTarget) setGlobalSearchOpen(false); }}>
          <div className="global-search-modal">
            <div className="global-search-bar">
              <span className="global-search-icon">⌕</span>
              <input autoFocus value={globalSearchQuery} onChange={e => { setGlobalSearchQuery(e.target.value); setGlobalSearchIdx(0); }} placeholder="Search all clients — activity, tasks, notes…" className="global-search-input" onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setGlobalSearchIdx(i => Math.min(i + 1, results.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setGlobalSearchIdx(i => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter' && results[globalSearchIdx]) {
                  e.preventDefault();
                  const r = results[globalSearchIdx];
                  setGlobalSearchOpen(false);
                  const ownerCam = (state.camProfiles || []).find(p => (p.clientIds || []).includes(r.client.id));
                  setState(s => { const withCam = ownerCam ? selectCam(s, ownerCam.id) : s; return selectClient(withCam, r.client.id); });
                  setPlatformView('cam'); setShowOverview(false); setShowSOP(false); setActiveTab(r.tab);
                }
              }} />
              <kbd className="global-search-esc" onClick={() => setGlobalSearchOpen(false)}>esc</kbd>
            </div>
            <div className="global-search-results">
              {!q && <div className="global-search-hint muted">Type to search across all clients</div>}
              {q && !results.length && <div className="global-search-hint muted">No results for "{globalSearchQuery}"</div>}
              {results.map((r, i) => (
                <button key={i} className={`global-search-result${i === globalSearchIdx ? ' global-search-active' : ''}`} onClick={() => {
                  setGlobalSearchOpen(false);
                  const ownerCam = (state.camProfiles || []).find(p => (p.clientIds || []).includes(r.client.id));
                  setState(s => {
                    const withCam = ownerCam ? selectCam(s, ownerCam.id) : s;
                    return selectClient(withCam, r.client.id);
                  });
                  setPlatformView('cam');
                  setShowOverview(false);
                  setShowSOP(false);
                  setActiveTab(r.tab);
                }}>
                  <span className={`global-search-kind kind-${r.kind.toLowerCase()}`}>{r.kind}</span>
                  <span className="global-search-text">{r.text}</span>
                  <span className="global-search-sub muted">{r.client.name} · {r.sub}</span>
                </button>
              ))}
            </div>
            {q && results.length > 0 && <div className="global-search-footer muted">{results.length} result{results.length !== 1 ? 's' : ''} · click to navigate</div>}
          </div>
        </div>
      );
    })()}
    </>
    </ErrorBoundary>
  );
}
