import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
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
  ClipboardList,
  Download,
  Edit3,
  FileUp,
  FileText,
  Building2,
  Clock3,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Globe2,
  Kanban,
  Languages,
  ListChecks,
  LoaderCircle,
  Plus,
  RefreshCw,
  MessageCircle,
  Search,
  Shield,
  Smartphone,
  Trash2,
  TrendingUp,
  Upload,
  UserPlus,
  Users,
  History,
  Mail,
  Phone,
  SquarePen,
} from "lucide-react";
import AccountManager from "./components/AccountManager";
import Dashboard from "./components/Dashboard";
import DatabaseCheck from "./components/DatabaseCheck";
import DailySOP from "./components/DailySOP";
import StackPlaybook from "./components/StackPlaybook";
import UploadArea from "./components/UploadArea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  addActivityEntry,
  addClient,
  removeClient,
  transferClient,
  togglePinClient,
  addTask,
  appendDailyImport,
  createInitialState,
  deleteActivityEntry,
  deleteTask,
  getClientImportByDate,
  replaceDailyImport,
  resolveFlagInImport,
  selectCam,
  selectClient,
  todayIsoDate,
  updateClientDetails,
  updateImportStatus,
  updateTask,
  upsertAccountMeta,
  removeAccountFromRegistry,
} from "./domain/crmStateStore";
import { buildCamOverview } from "./domain/camOverview";
import {
  recalculateDailyImport,
  reconcileDailyImport,
} from "./domain/reconcile";
import { parseNinjaTraderCsvText } from "./domain/csvImport";
import {
  buildClientMessageReport,
  buildWeeklyMessageReport,
  buildDailyReportSummary,
  buildTeamWeeklyReport,
  formatCurrency,
} from "./domain/report";
import {
  USER_ROLES,
} from "./domain/userStore";
import {
  authenticateSupabaseAppUser,
  getSupabaseSessionAppUser,
  signOutSupabase,
} from "./domain/supabaseAuth";
import {
  createSupabaseManagedUser,
  deactivateSupabaseManagedUser,
  deleteSupabaseManagedUser,
  loadSupabaseManagedUsers,
  updateSupabaseManagedUser,
} from "./domain/supabaseUserAdmin";
import { isSupabaseConfigured } from "./lib/supabaseClient";
import {
  loadSupabaseDataExport,
  loadSupabaseIntakeSheet,
} from "./domain/supabaseDataPortability";
import {
  createSupabaseSopItem,
  createSupabaseSopSection,
  createSupabaseReport,
  createSupabaseAuditLog,
  createSupabaseCamProfile,
  createSupabaseClient,
  deleteSupabaseActivity,
  deleteSupabaseTask,
  deleteSupabaseTradingAccount,
  insertSupabaseActivity,
  insertSupabasePayoutEvent,
  insertSupabaseTask,
  loadSupabaseCrmState,
  loadSupabaseDailySopTemplate,
  loadSupabaseReports,
  loadSupabaseAuditLogs,
  replaceSupabaseOperationalFlags,
  replaceSupabasePriceChecks,
  softDeleteSupabaseClient,
  transferSupabaseClient,
  updateSupabaseClient,
  updateSupabaseCamProfile,
  updateSupabaseDailyImportStatus,
  updateSupabaseOperationalFlag,
  updateSupabaseSopItem,
  updateSupabaseSopSection,
  updateSupabaseTask,
  updateSupabaseTradingAccount,
  upsertSupabaseDailyImport,
  upsertSupabaseTradingAccount,
} from "./domain/supabaseStore";

function InlineSpinner({ size = 14 }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />;
}

function ConfirmActionDialog({
  action,
  busy = false,
  onCancel,
  onConfirm,
}) {
  if (!action) return null;
  const isDanger = action.variant === "danger";
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => {
      if (!busy && !open) onCancel?.();
    }}>
      <DialogContent
        className={`confirm-dialog ${isDanger ? "danger" : ""}`}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          {action.description ? (
            <DialogDescription>{action.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {action.details?.length ? (
          <div className="confirm-dialog-details">
            {action.details.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </div>
        ) : null}
        <DialogFooter className="confirm-dialog-footer">
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={isDanger ? "danger-button" : "primary-button"}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <InlineSpinner /> : action.icon || null}
            {busy ? action.busyLabel || "Working..." : action.confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Panel error:", error, info);
  }
  render() {
    if (this.state.error)
      return (
        <div
          className="panel"
          style={{ margin: 16, padding: 24, borderColor: "var(--negative)" }}
        >
          <strong style={{ color: "var(--negative)" }}>
            Something went wrong in this panel.
          </strong>
          <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            {String(this.state.error)}
          </p>
          <button
            className="secondary-button"
            style={{ marginTop: 10 }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    return this.props.children;
  }
}

const STATIC_TABS = [
  "Activity",
  "Tasks",
  "Credentials & Notes",
  "Price Checks",
  "Stack Playbook",
];

// Builds a lowercase-keyed registry map from import accounts + client registry.
// Prevents silent cache misses when CSV and registry keys have different casing.
export function mergeRegistryCi(importAccounts, clientRegistry) {
  const merged = { ...(importAccounts || {}), ...(clientRegistry || {}) };
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]),
  );
}
export function ciMeta(regByLower, accountName) {
  return (regByLower || {})[(accountName || "").toLowerCase()] || {};
}

export function deriveClientBadge(client) {
  const latest = (client.dailyImports || []).at(-1);
  if (!latest) return { label: "No data", tone: "muted" };
  const critical = (latest.flags || []).filter(
    (flag) =>
      flag.severity === "Critical" &&
      flag.status !== "Resolved" &&
      flag.status !== "Acknowledged",
  ).length;
  if (critical) return { label: `${critical} critical`, tone: "danger" };
  const open = (latest.flags || []).filter(
    (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
  ).length;
  if (open) return { label: `${open} flags`, tone: "warning" };
  const today = todayIsoDate();
  const overdue = (client.tasks || []).filter(
    (t) => !t.done && t.dueDate && t.dueDate < today,
  ).length;
  if (overdue) return { label: `${overdue} overdue`, tone: "warning" };
  const openTasks = (client.tasks || []).filter((t) => !t.done).length;
  if (openTasks) return { label: `${openTasks} tasks`, tone: "muted" };
  return { label: latest.status || "Ready", tone: "success" };
}

export function lastContactDaysAgo(client) {
  const log = client.activityLog || [];
  if (!log.length) return null;
  // Log is prepended on insert so index 0 is always the most recent entry
  const latest = log[0];
  if (!latest.createdAt) return null;
  return Math.floor(
    (Date.now() - new Date(latest.createdAt).getTime()) / 86400000,
  );
}

export function buildTodayActions(client, dailyImport) {
  const today = todayIsoDate();
  const actions = [];

  // Overdue tasks
  const overdue = (client.tasks || []).filter(
    (t) => !t.done && t.dueDate && t.dueDate < today,
  );
  for (const t of overdue.slice(0, 3)) {
    actions.push({
      severity: "critical",
      icon: "⏰",
      text: `Overdue: ${t.text.slice(0, 80)}${t.text.length > 80 ? "…" : ""}`,
    });
  }

  // Tasks due today
  const dueToday = (client.tasks || []).filter(
    (t) => !t.done && t.dueDate === today,
  );
  for (const t of dueToday.slice(0, 2)) {
    actions.push({
      severity: "warning",
      icon: "📋",
      text: `Due today: ${t.text.slice(0, 80)}${t.text.length > 80 ? "…" : ""}`,
    });
  }

  // Critical flags
  const critFlags = (dailyImport?.flags || []).filter(
    (f) =>
      f.severity === "Critical" &&
      f.status !== "Resolved" &&
      f.status !== "Acknowledged",
  );
  for (const f of critFlags.slice(0, 2)) {
    actions.push({
      severity: "critical",
      icon: "🚨",
      text: `Flag: ${f.message.slice(0, 90)}${f.message.length > 90 ? "…" : ""}`,
    });
  }

  // No close today
  if (!dailyImport) {
    actions.push({
      severity: "warning",
      icon: "📂",
      text: `No daily close uploaded yet for ${today}`,
    });
  }

  // Payout alerts
  if (dailyImport) {
    const payouts = buildPayoutAlerts(client, dailyImport);
    for (const p of payouts.filter((x) => x.ready).slice(0, 2)) {
      actions.push({
        severity: "info-green",
        icon: "💰",
        text: `Payout ready: ${p.alias} reached ${Math.round((p.profit / p.target) * 100)}% of target`,
      });
    }
  }

  // Unclassified accounts
  if (dailyImport) {
    const unassigned = (dailyImport.snapshots || []).filter((s) => {
      const meta = ciMeta(
        mergeRegistryCi(dailyImport.accounts, client.accountRegistry),
        s.accountName,
      );
      return !meta || meta.accountType === "Unassigned" || !meta.accountType;
    });
    if (unassigned.length) {
      actions.push({
        severity: "warning",
        icon: "📂",
        text: `${unassigned.length} account${unassigned.length > 1 ? "s" : ""} unclassified — go to Review tab to assign type`,
      });
    }
  }

  // Funded accounts with no active strategy
  if (dailyImport) {
    const registry = mergeRegistryCi(
      dailyImport.accounts,
      client.accountRegistry,
    );
    const noStrat = (dailyImport.snapshots || []).filter((s) => {
      const meta = ciMeta(registry, s.accountName);
      if (meta?.accountType !== "Funded") return false;
      const active = (s.strategies || []).filter((st) => st.enabled);
      return active.length === 0;
    });
    for (const s of noStrat.slice(0, 2)) {
      const alias = ciMeta(registry, s.accountName)?.alias || s.accountName;
      actions.push({
        severity: "warning",
        icon: "⚙️",
        text: `No active strategy on ${alias} — check Stack Playbook`,
      });
    }
  }

  return actions;
}

export function filteredAccountsForTab(client, dailyImport, tab) {
  const regCi = mergeRegistryCi(dailyImport?.accounts, client?.accountRegistry);
  const snapshots = dailyImport?.snapshots || [];
  const entriesCi = Object.fromEntries(
    Object.entries(regCi).filter(([, account]) => {
      if (tab === "Review")
        return (
          account.accountType === "Unassigned" ||
          account.accountType === "Inactive / Ignore"
        );
      if (tab === "Evaluations")
        return account.accountType?.startsWith("Evaluation");
      if (tab === "Funded") return account.accountType === "Funded";
      if (tab === "Cash") return account.accountType === "Cash";
      return true;
    }),
  );
  // Rebuild original-casing entries for AccountManager (needs original keys for onUpdateAccount)
  const allMerged = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const entries = Object.fromEntries(
    Object.entries(allMerged).filter(([k]) => entriesCi[k.toLowerCase()]),
  );
  return {
    accounts: entries,
    snapshots: snapshots
      .filter((snapshot) => entriesCi[snapshot.accountName?.toLowerCase()])
      .map((snapshot) => ({
        ...snapshot,
        meta: ciMeta(regCi, snapshot.accountName),
      })),
  };
}

export function buildVisibleTabs(client, dailyImport) {
  const accounts = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const values = Object.values(accounts);
  const tabs = [];
  if (
    values.some(
      (account) =>
        account.accountType === "Unassigned" ||
        account.accountType === "Inactive / Ignore",
    )
  )
    tabs.push("Review");
  if (values.some((account) => account.accountType?.startsWith("Evaluation")))
    tabs.push("Evaluations");
  if (values.some((account) => account.accountType === "Funded"))
    tabs.push("Funded");
  if (values.some((account) => account.accountType === "Cash"))
    tabs.push("Cash");
  return ["Overview", ...tabs, ...STATIC_TABS];
}

function tabMode(tab) {
  if (tab === "Cash") return "cash";
  if (tab === "Review") return "review";
  return "standard";
}

function latestImports(clients = []) {
  return clients.map((client) => ({
    client,
    dailyImport: client.dailyImports?.at(-1) || null,
  }));
}

export function buildManagerSummary(clients = []) {
  const imports = latestImports(clients);
  const snapshots = imports.flatMap(
    ({ dailyImport }) => dailyImport?.snapshots || [],
  );
  const openFlags = imports.flatMap(({ dailyImport }) =>
    (dailyImport?.flags || []).filter(
      (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
    ),
  );
  const activeStrategies = snapshots
    .flatMap((snapshot) => snapshot.strategies || [])
    .filter((strategy) => strategy.enabled);
  const weeklyPnl = snapshots.reduce(
    (total, snapshot) => total + Number(snapshot.weeklyPnl || 0),
    0,
  );
  const dailyPnl = snapshots.reduce(
    (total, snapshot) => total + Number(snapshot.grossRealizedPnl || 0),
    0,
  );

  return {
    clients: clients.length,
    accounts: snapshots.length,
    algorithms: new Set(
      activeStrategies.map(
        (strategy) =>
          `${strategy.strategyFamily || strategy.strategyName}-${strategy.strategyVersion || ""}`,
      ),
    ).size,
    dailyPnl,
    weeklyPnl,
    openFlags: openFlags.length,
  };
}

export function buildTeamHistory(clients = []) {
  const byDate = new Map();
  for (const client of clients) {
    for (const dailyImport of client.dailyImports || []) {
      const existing = byDate.get(dailyImport.date) || {
        date: dailyImport.date,
        dailyPnl: 0,
        weeklyPnl: 0,
        accounts: 0,
      };
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

export function clientDailyTotals(client) {
  return (client?.dailyImports || [])
    .map((dailyImport) => {
      const snapshots = dailyImport.snapshots || [];
      return {
        date: dailyImport.date,
        dailyPnl: snapshots.reduce(
          (total, snapshot) => total + Number(snapshot.grossRealizedPnl || 0),
          0,
        ),
        weeklyPnl: snapshots.reduce(
          (total, snapshot) => total + Number(snapshot.weeklyPnl || 0),
          0,
        ),
        balance: snapshots.reduce(
          (total, snapshot) => total + Number(snapshot.accountBalance || 0),
          0,
        ),
        accounts: snapshots.length,
        flags: (dailyImport.flags || []).length,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildClientOverview(client, dailyImport) {
  const history = clientDailyTotals(client);
  const latest = dailyImport || client?.dailyImports?.at(-1) || null;
  const latestSnapshots = latest?.snapshots || [];
  const registry = mergeRegistryCi(latest?.accounts, client?.accountRegistry);
  const strategyTotals = new Map();
  const distribution = new Map();

  for (const importDay of client?.dailyImports || []) {
    for (const snapshot of importDay.snapshots || []) {
      for (const strategy of snapshot.strategies || []) {
        const key =
          strategy.strategyFamily || strategy.strategyName || "Unknown";
        const current = strategyTotals.get(key) || {
          name: key,
          realized: 0,
          days: 0,
          lastThree: [],
        };
        current.realized += Number(strategy.realized || 0);
        current.days += 1;
        current.lastThree.push(Number(strategy.realized || 0));
        if (current.lastThree.length > 3) current.lastThree.shift();
        strategyTotals.set(key, current);
      }
    }
  }

  for (const snapshot of latestSnapshots) {
    for (const strategy of snapshot.strategies || []) {
      const key = strategy.strategyFamily || strategy.strategyName || "Unknown";
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
        temperature:
          recentTotal > 250 ? "Hot" : recentTotal < -250 ? "Cold" : "Stable",
      };
    })
    .sort((a, b) => Math.abs(b.recentTotal) - Math.abs(a.recentTotal));

  const passProgress = latestSnapshots
    .map((snapshot) => {
      const meta = ciMeta(registry, snapshot.accountName);
      if (
        meta.accountType === "Cash" ||
        meta.accountType === "Inactive / Ignore"
      )
        return null;
      const startingBalance =
        Number(meta.startBalance || 0) ||
        (Number(snapshot.accountBalance || 0) >= 90000 ? 100000 : 50000);
      const target =
        Number(meta.targetProfit || 0) ||
        startingBalance + (meta.accountType === "Funded" ? 2000 : 3000);
      const progress = Math.max(
        0,
        Math.min(
          100,
          ((Number(snapshot.accountBalance || 0) - startingBalance) /
            (target - startingBalance || 1)) *
            100,
        ),
      );
      return {
        accountName: snapshot.accountName,
        alias: meta.alias || snapshot.accountName,
        accountType: meta.accountType || "Unassigned",
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
  const hotCount = algorithms.filter(
    (item) => item.temperature === "Hot",
  ).length;
  const coldCount = algorithms.filter(
    (item) => item.temperature === "Cold",
  ).length;

  return {
    history,
    algorithms,
    distribution: [...distribution.entries()].map(([name, count]) => ({
      name,
      count,
    })),
    passProgress,
    metrics: {
      dailyPnl: latestTotal,
      dailyDelta: latestTotal - priorTotal,
      accounts: latestSnapshots.length,
      openFlags: (latest?.flags || []).filter(
        (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
      ).length,
      hotCount,
      coldCount,
      streakLabel: streak.every((day) => day.dailyPnl >= 0)
        ? `${streak.length} day positive streak`
        : streak.every((day) => day.dailyPnl < 0)
          ? `${streak.length} day cold streak`
          : "Mixed streak",
    },
  };
}

export function buildLifetimeStats(client) {
  const imports = client.dailyImports || [];
  if (!imports.length) return null;
  const dailyPnls = imports.map((di) =>
    (di.snapshots || []).reduce(
      (s, snap) => s + Number(snap.grossRealizedPnl || 0),
      0,
    ),
  );
  const totalPnl = dailyPnls.reduce((s, v) => s + v, 0);
  const positiveDays = dailyPnls.filter((v) => v > 0).length;
  const negativeDays = dailyPnls.filter((v) => v < 0).length;
  const bestDay = Math.max(...dailyPnls);
  const worstDay = Math.min(...dailyPnls);
  const bestDayDate = imports[dailyPnls.indexOf(bestDay)]?.date;
  const worstDayDate = imports[dailyPnls.indexOf(worstDay)]?.date;
  const winRate = imports.length
    ? Math.round((positiveDays / imports.length) * 100)
    : 0;
  const avgDay = imports.length ? totalPnl / imports.length : 0;

  // Current positive/negative streak
  let streak = 0;
  let streakType = null;
  for (let i = dailyPnls.length - 1; i >= 0; i--) {
    const positive = dailyPnls[i] > 0;
    if (streakType === null) {
      streakType = positive;
      streak = 1;
    } else if (positive === streakType) streak++;
    else break;
  }

  const profile = client.profile || {};
  const startDate = profile.startDate || imports[0]?.date;
  const daysSinceStart = startDate
    ? Math.floor(
        (Date.now() - new Date(startDate + "T12:00:00").getTime()) / 86400000,
      )
    : null;

  return {
    totalDays: imports.length,
    totalPnl,
    positiveDays,
    negativeDays,
    winRate,
    avgDay,
    bestDay,
    worstDay,
    bestDayDate,
    worstDayDate,
    streak,
    streakType,
    daysSinceStart,
    startDate,
  };
}

export function buildMonthlyTotals(client) {
  const byMonth = {};
  for (const di of client.dailyImports || []) {
    if (!di.date) continue;
    const month = di.date.slice(0, 7);
    if (!byMonth[month])
      byMonth[month] = { month, monthlyPnl: 0, closedDays: 0, accounts: 0 };
    const snapshots = di.snapshots || [];
    byMonth[month].monthlyPnl += snapshots.reduce(
      (t, s) => t + Number(s.grossRealizedPnl || 0),
      0,
    );
    byMonth[month].closedDays += 1;
    byMonth[month].accounts = Math.max(
      byMonth[month].accounts,
      snapshots.length,
    );
  }
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
}

export function buildStrategyAnalyzer(clients = []) {
  const stratMap = new Map();
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    for (const snapshot of latest.snapshots || []) {
      const enabledCount =
        (snapshot.strategies || []).filter((s) => s.enabled).length || 1;
      for (const strategy of snapshot.strategies || []) {
        const key =
          strategy.strategyFamily || strategy.strategyName || "Unknown";
        const entry = stratMap.get(key) || {
          name: key,
          count: 0,
          totalRealized: 0,
          totalWeekly: 0,
          accountSet: new Set(),
        };
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
  return entries
    .map((e) => ({
      name: e.name,
      count: e.count,
      accounts: e.accountSet.size,
      totalRealized: e.totalRealized,
      avgDaily: e.count ? e.totalRealized / e.count : 0,
      avgWeekly: e.accountSet.size ? e.totalWeekly / e.accountSet.size : 0,
      score: Math.max(
        0,
        Math.min(10, ((e.totalRealized + maxAbs) / (2 * maxAbs)) * 10),
      ).toFixed(1),
    }))
    .sort((a, b) => b.totalRealized - a.totalRealized);
}

// Full historical strategy effectiveness — aggregates across all dailyImports
export function buildStrategyEffectiveness(clients = []) {
  // stratName → { totalPnl, days: [{date,pnl}], winDays, lossDays, accountSet, clientSet, last7Pnl }
  const stratMap = new Map();

  for (const client of clients) {
    for (const di of client.dailyImports || []) {
      for (const snapshot of di.snapshots || []) {
        const enabledCount =
          (snapshot.strategies || []).filter((s) => s.enabled).length || 1;
        for (const strategy of snapshot.strategies || []) {
          if (!strategy.enabled) continue;
          const key =
            strategy.strategyFamily || strategy.strategyName || "Unknown";
          const realized = Number(strategy.realized || 0);
          const accountContrib =
            Number(snapshot.grossRealizedPnl || 0) / enabledCount;
          if (!stratMap.has(key)) {
            stratMap.set(key, {
              name: key,
              totalPnl: 0,
              contributions: [],
              winDays: 0,
              lossDays: 0,
              accountSet: new Set(),
              clientSet: new Set(),
            });
          }
          const entry = stratMap.get(key);
          const pnl = strategy.realized != null ? realized : accountContrib;
          entry.totalPnl += pnl;
          entry.contributions.push({ date: di.date, pnl });
          if (pnl > 0) entry.winDays += 1;
          else if (pnl < 0) entry.lossDays += 1;
          entry.accountSet.add(snapshot.accountName);
          entry.clientSet.add(client.name);
        }
      }
    }
  }

  const cutoff7 = new Date();
  cutoff7.setDate(cutoff7.getDate() - 7);
  const cutoff7Str = cutoff7.toISOString().slice(0, 10);

  return [...stratMap.values()]
    .map((e) => {
      const last7 = e.contributions
        .filter((c) => c.date >= cutoff7Str)
        .reduce((s, c) => s + c.pnl, 0);
      const total = e.winDays + e.lossDays;
      const winRate = total ? Math.round((e.winDays / total) * 100) : 0;
      const avgPerDay = total ? e.totalPnl / total : 0;
      // trend: last7 vs prior 7
      const cutoff14Str = new Date(cutoff7.getTime() - 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      const prior7 = e.contributions
        .filter((c) => c.date >= cutoff14Str && c.date < cutoff7Str)
        .reduce((s, c) => s + c.pnl, 0);
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
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function buildLifecycleMetrics(clients = []) {
  const evalFails = [];
  const evalFunded = [];
  const fundedPayouts = [];
  let totalEvals = 0;
  let totalFunded = 0;

  for (const client of clients) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (
        meta.accountType?.startsWith("Evaluation") ||
        meta.accountType === "Unassigned"
      ) {
        totalEvals += 1;
        if (meta.dateAdded && meta.dateFailed) {
          const days =
            (new Date(meta.dateFailed) - new Date(meta.dateAdded)) / 86400000;
          if (days >= 0) evalFails.push(days);
        }
        if (meta.dateAdded && meta.dateFunded) {
          const days =
            (new Date(meta.dateFunded) - new Date(meta.dateAdded)) / 86400000;
          if (days >= 0) evalFunded.push(days);
        }
      }
      if (meta.accountType === "Funded") {
        totalFunded += 1;
        if (meta.dateFunded && meta.dateLastPayout) {
          const days =
            (new Date(meta.dateLastPayout) - new Date(meta.dateFunded)) /
            86400000;
          if (days >= 0) fundedPayouts.push(days);
        }
      }
    }
  }

  const avg = (arr) =>
    arr.length
      ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1)
      : "N/A";
  return {
    totalEvals,
    totalFunded,
    avgDaysToFail: avg(evalFails),
    avgDaysToFunded: avg(evalFunded),
    avgDaysToPayout: avg(fundedPayouts),
  };
}

// Monthly P&L grouped by account — includes active strategy families per account
export function buildMonthlyByAccount(client) {
  const byMonth = {};
  for (const di of client.dailyImports || []) {
    if (!di.date) continue;
    const month = di.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = {};
    const registry = mergeRegistryCi(di.accounts, client.accountRegistry);
    for (const snapshot of di.snapshots || []) {
      const alias =
        ciMeta(registry, snapshot.accountName)?.alias || snapshot.accountName;
      const acctKey = (snapshot.accountName || "").toLowerCase();
      if (!byMonth[month][acctKey]) {
        byMonth[month][acctKey] = {
          accountName: snapshot.accountName,
          alias,
          pnl: 0,
          days: 0,
          strategySet: new Set(),
        };
      }
      byMonth[month][acctKey].pnl += Number(snapshot.grossRealizedPnl || 0);
      byMonth[month][acctKey].days += 1;
      for (const strat of snapshot.strategies || []) {
        const name = strat.strategyFamily || strat.strategyName;
        if (name) byMonth[month][acctKey].strategySet.add(name);
      }
    }
  }
  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, accounts]) => ({
      month,
      accounts: Object.values(accounts)
        .map((a) => ({ ...a, strategies: [...a.strategySet].join(" · ") }))
        .sort((a, b) => b.pnl - a.pnl),
    }));
}

// P&L variance analysis: compare each account to the team average for same strategy
// Returns per-account deviation status (good / average / needs attention)
export function buildPnlVarianceAnalysis(client, allClients = []) {
  if (!client) return [];

  // Build cross-client strategy averages from last 7 closes
  const stratAvg = {};
  for (const c of allClients) {
    for (const di of (c.dailyImports || []).slice(-7)) {
      for (const snap of di.snapshots || []) {
        for (const strat of snap.strategies || []) {
          if (!strat.enabled) continue;
          const key = strat.strategyFamily || strat.strategyName || "Unknown";
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
      const acctKey = (snap.accountName || "").toLowerCase();
      const meta =
        registry[acctKey] ||
        Object.entries(registry).find(
          ([k]) => k.toLowerCase() === acctKey,
        )?.[1] ||
        {};
      if (meta.accountType === "Inactive / Ignore") continue;
      if (!accountMap[acctKey]) {
        accountMap[acctKey] = {
          accountName: snap.accountName,
          alias: meta.alias || snap.accountName,
          accountType: meta.accountType || "",
          totalActual: 0,
          totalExpected: 0,
          days: 0,
          stratNames: new Set(),
        };
      }
      const entry = accountMap[acctKey];
      entry.totalActual += Number(snap.grossRealizedPnl || 0);
      entry.days += 1;
      for (const strat of snap.strategies || []) {
        if (!strat.enabled) continue;
        const key = strat.strategyFamily || strat.strategyName || "Unknown";
        entry.stratNames.add(key);
        entry.totalExpected += avgByStrat[key] || 0;
      }
    }
  }

  return Object.values(accountMap)
    .filter((a) => a.days >= 2 && a.totalExpected !== 0)
    .map((a) => {
      const variance = a.totalActual - a.totalExpected;
      const variancePct =
        a.totalExpected !== 0
          ? (variance / Math.abs(a.totalExpected)) * 100
          : 0;
      let status;
      if (variancePct >= 10) status = "good";
      else if (variancePct >= -15) status = "average";
      else status = "review";
      return {
        ...a,
        strategies: [...a.stratNames].join(" · "),
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
  const rawDD = Number(snapshot?.trailingMaxDrawdown || 0);
  if (ddLimit > 0) {
    // Model 1: configured limit — rawDD is cumulative loss (abs = used)
    const used = Math.abs(rawDD);
    const pct = used / ddLimit;
    if (pct >= 0.85) return { level: "Critical", pct };
    if (pct >= 0.65) return { level: "High", pct };
    if (pct >= 0.4) return { level: "Medium", pct };
    return { level: "Low", pct };
  }
  if (rawDD > 0) {
    // Model 2: no configured limit — rawDD IS the remaining buffer
    // Use thresholds: Critical ≤ $500, High ≤ $1200, Medium ≤ $2500
    if (rawDD <= 500) return { level: "Critical", pct: null };
    if (rawDD <= 1200) return { level: "High", pct: null };
    if (rawDD <= 2500) return { level: "Medium", pct: null };
    return { level: "Low", pct: null };
  }
  return null;
}

// Detect consistency rule risk: best day > 30% of total positive P&L on a funded account
export function buildConsistencyWarnings(client) {
  const warnings = [];
  const registry = client?.accountRegistry || {};
  const funded = Object.values(registry).filter(
    (a) =>
      a.accountType === "Funded" &&
      a.status !== "Failed" &&
      a.status !== "Inactive",
  );

  for (const meta of funded) {
    const pnlByDay = [];
    for (const di of client.dailyImports || []) {
      const snap = (di.snapshots || []).find(
        (s) => s.accountName?.toLowerCase() === meta.accountName?.toLowerCase(),
      );
      if (snap)
        pnlByDay.push({
          date: di.date,
          pnl: Number(snap.grossRealizedPnl || 0),
        });
    }
    if (pnlByDay.length < 3) continue;

    const positiveDays = pnlByDay.filter((d) => d.pnl > 0);
    const totalPositive = positiveDays.reduce((s, d) => s + d.pnl, 0);
    if (totalPositive <= 0) continue;

    const bestDay = positiveDays.reduce(
      (best, d) => (d.pnl > best.pnl ? d : best),
      positiveDays[0],
    );
    const ratio = bestDay.pnl / totalPositive;

    if (ratio > 0.3) {
      warnings.push({
        id: `consistency-${meta.accountName}`,
        alias: meta.alias || meta.accountName,
        accountName: meta.accountName,
        bestDayPnl: bestDay.pnl,
        bestDayDate: bestDay.date,
        totalPositive,
        ratio: Math.round(ratio * 100),
        severity: ratio > 0.5 ? "Critical" : "Warning",
      });
    }
  }
  return warnings;
}

// Detect possible VPS/algo disconnect: enabled strategy + zero P&L when prior avg was positive
export function buildDisconnectAlerts(client) {
  const alerts = [];
  const latest = client.dailyImports?.at(-1);
  if (!latest) return alerts;
  // Only relevant if the latest close is recent (today or prev trading day)
  const today = todayIsoDate();
  const prevTrading = new Date();
  do {
    prevTrading.setDate(prevTrading.getDate() - 1);
  } while ([0, 6].includes(prevTrading.getDay()));
  const prevTradingStr = prevTrading.toISOString().slice(0, 10);
  if (latest.date !== today && latest.date !== prevTradingStr) return alerts;
  const registry = mergeRegistryCi(latest.accounts, client.accountRegistry);

  for (const snapshot of latest.snapshots || []) {
    const meta = ciMeta(registry, snapshot.accountName);
    if (meta.accountType === "Inactive / Ignore") continue;
    if (["Inactive", "Failed", "Reserve"].includes(meta.status)) continue;

    const activeStrategies = (snapshot.strategies || []).filter(
      (s) => s.enabled,
    );
    if (activeStrategies.length === 0) continue;

    const todayPnl = Number(snapshot.grossRealizedPnl || 0);
    if (todayPnl !== 0) continue;

    const priorPnls = (client.dailyImports.slice(-6, -1) || [])
      .map((di) => {
        const s = (di.snapshots || []).find(
          (x) =>
            x.accountName?.toLowerCase() ===
            snapshot.accountName?.toLowerCase(),
        );
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

export function buildRiskDistribution(clients = [], camProfiles = []) {
  const camById = Object.fromEntries(camProfiles.map((p) => [p.id, p]));
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }

  const buckets = { Critical: [], High: [], Medium: [], Low: [], Safe: [] };

  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = mergeRegistryCi(latest.accounts, client.accountRegistry);
    const camId = clientCam[client.id];
    const camName = camById[camId]?.name || "—";

    for (const snapshot of latest.snapshots || []) {
      const meta = ciMeta(registry, snapshot.accountName);
      if (
        meta.accountType === "Inactive / Ignore" ||
        meta.accountType === "Cash"
      )
        continue;
      if (["Inactive", "Failed"].includes(meta.status)) continue;

      const risk = accountRiskLevel(snapshot, meta);
      const entry = {
        alias: meta.alias || snapshot.accountName,
        clientName: client.name,
        camName,
        drawdown: Number(snapshot.trailingMaxDrawdown || 0),
        ddLimit: Number(meta.maxDrawdownLimit || 0),
        pct: risk?.pct || 0,
      };

      if (risk?.level === "Critical") buckets.Critical.push(entry);
      else if (risk?.level === "High") buckets.High.push(entry);
      else if (risk?.level === "Medium") buckets.Medium.push(entry);
      else if (risk?.level === "Low") buckets.Low.push(entry);
      else buckets.Safe.push(entry);
    }
  }

  const total = Object.values(buckets).reduce((s, b) => s + b.length, 0);
  return { buckets, total };
}

// Detect funded accounts that have reached their target profit — payout should be requested
export function buildPayoutAlerts(client, dailyImport) {
  if (!client || !dailyImport) return [];
  const registry = mergeRegistryCi(
    dailyImport.accounts,
    client.accountRegistry,
  );
  const alerts = [];
  for (const snap of dailyImport.snapshots || []) {
    const meta = ciMeta(registry, snap.accountName);
    if (meta.accountType !== "Funded") continue;
    if (meta.status === "Failed" || meta.status === "Inactive") continue;
    const target = Number(meta.targetProfit || 0);
    if (!target) continue;
    const balance = Number(snap.accountBalance || 0);
    const alreadyRequested =
      meta.payoutState && meta.payoutState !== "Not requested";
    if (!alreadyRequested && balance >= target * 0.9) {
      alerts.push({
        accountName: snap.accountName,
        alias: meta.alias || snap.accountName,
        profit: balance,
        target,
        pct: Math.round((balance / target) * 100),
        payoutState: meta.payoutState || "Not requested",
        ready: balance >= target,
      });
    }
  }
  return alerts.sort((a, b) => b.pct - a.pct);
}

export function buildPayoutPipeline(clients = [], camProfiles = []) {
  const camById = Object.fromEntries(camProfiles.map((p) => [p.id, p]));
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }
  const rows = [];
  for (const client of clients) {
    const camId = clientCam[client.id];
    const camName = camById[camId]?.name || "—";
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (!meta.payoutState || meta.payoutState === "Not requested") continue;
      const latest = client.dailyImports?.at(-1);
      const snapshot = (latest?.snapshots || []).find(
        (s) => s.accountName?.toLowerCase() === meta.accountName?.toLowerCase(),
      );
      rows.push({
        clientName: client.name,
        clientId: client.id,
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
  const order = [
    "Request payout",
    "Payout requested",
    "Payout approved",
    "Clear to trade",
    "Not requested",
  ];
  return rows.sort(
    (a, b) => order.indexOf(a.payoutState) - order.indexOf(b.payoutState),
  );
}

function clientsForCam(clients = [], camProfile = null) {
  const clientIds = camProfile?.clientIds || [];
  if (!clientIds.length) return [];
  const allowed = new Set(clientIds);
  return clients.filter((client) => allowed.has(client.id));
}

function activeCamProfilesForUsers(camProfiles = [], users = []) {
  const activeProfiles = (camProfiles || []).filter((profile) => (profile.status || "Active") !== "Inactive");
  if (!(users || []).length) return activeProfiles;
  const activeCamIds = new Set(
    (users || [])
      .filter((user) => (
        user.role === USER_ROLES.CAM &&
        (user.status || "Active") !== "Inactive" &&
        user.camProfileId
      ))
      .map((user) => user.camProfileId),
  );
  return activeProfiles.filter((profile) => activeCamIds.has(profile.id));
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      if (!isSupabaseConfigured) {
        throw new Error("Supabase environment is required.");
      }
      const user = await authenticateSupabaseAppUser(username, password);
      if (!user) {
        setError("Invalid username or password.");
        return;
      }
      onLogin(user);
    } catch (err) {
      setError(err?.message || "Invalid username or password.");
    } finally {
      setIsSubmitting(false);
    }
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
        <p>
          Access your workspace to monitor clients, accounts, and daily
          performance.
        </p>
        <form onSubmit={submit} className="login-form">
          <label>
            Username
            <input
              value={username}
              autoComplete="username"
              onChange={(event) => {
                setUsername(event.target.value);
                setError("");
              }}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button
            className="primary-button"
            disabled={isSubmitting}
            style={{ marginTop: 4 }}
          >
            {isSubmitting ? "Signing in..." : "Sign in →"}
          </button>
        </form>
      </section>
      <div className="login-footer">
        Vincere CRM · {new Date().getFullYear()} · Drive Insight
      </div>
    </main>
  );
}

export function buildCamPerformance(clients = [], camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const camMap = {};
  for (const cam of camProfiles) {
    camMap[cam.id] = {
      id: cam.id,
      name: cam.name,
      weeklyPnl: 0,
      dailyPnl: 0,
      monthlyPnl: 0,
      funded: 0,
      evaluations: 0,
      totalAccounts: 0,
      openFlags: 0,
      clients: 0,
      payoutsThisMonth: 0,
      payoutsThisMonthCount: 0,
    };
  }

  for (const client of clients) {
    const camId = clientCam[client.id];
    if (!camId || !camMap[camId]) continue;
    const bucket = camMap[camId];
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = mergeRegistryCi(latest.accounts, client.accountRegistry);
    bucket.clients++;
    for (const snap of latest.snapshots || []) {
      const meta = ciMeta(registry, snap.accountName);
      if (meta.accountType === "Inactive / Ignore") continue;
      bucket.totalAccounts++;
      bucket.weeklyPnl += Number(snap.weeklyPnl || 0);
      bucket.dailyPnl += Number(snap.grossRealizedPnl || 0);
      if (meta.accountType === "Funded") bucket.funded++;
      else if (meta.accountType?.startsWith("Evaluation")) bucket.evaluations++;
    }
    bucket.openFlags += (latest.flags || []).filter(
      (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
    ).length;
    // Monthly P&L across all imports this month
    for (const di of client.dailyImports || []) {
      if (!di.date?.startsWith(currentMonth)) continue;
      bucket.monthlyPnl += (di.snapshots || []).reduce(
        (s, sn) => s + Number(sn.grossRealizedPnl || 0),
        0,
      );
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

export function buildAllFundedAccounts(clients = [], camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.name;
  }
  const rows = [];
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = mergeRegistryCi(latest.accounts, client.accountRegistry);
    for (const snap of latest.snapshots || []) {
      const meta = ciMeta(registry, snap.accountName);
      if (meta.accountType !== "Funded") continue;
      const ddLimit = Number(meta.maxDrawdownLimit || 0);
      const rawDD = Number(snap.trailingMaxDrawdown || 0);
      const buffer = ddLimit > 0 ? ddLimit - Math.abs(rawDD) : rawDD;
      const bufferPct =
        ddLimit > 0 ? Math.round((buffer / ddLimit) * 100) : null;
      const target = Number(meta.targetProfit || 0);
      const start = Number(meta.startBalance || 0);
      const balance = Number(snap.accountBalance || 0);
      const profit = start ? balance - start : null;
      const targetPct =
        target && start && target > start
          ? Math.min(
              100,
              Math.round(((balance - start) / (target - start)) * 100),
            )
          : null;
      rows.push({
        clientId: client.id,
        clientName: client.name,
        camName: clientCam[client.id] || "—",
        accountName: snap.accountName,
        alias: meta.alias || snap.accountName,
        connection: meta.connection || "",
        payoutState: meta.payoutState || "",
        strategies:
          (snap.strategies || [])
            .filter((s) => s.enabled)
            .map((s) => s.strategyFamily || s.strategyName)
            .join(", ") || "None",
        dailyPnl: Number(snap.grossRealizedPnl || 0),
        weeklyPnl: Number(snap.weeklyPnl || 0),
        balance,
        buffer,
        bufferPct,
        profit,
        targetPct,
        target,
        status: meta.status || "",
      });
    }
  }
  rows.sort((a, b) => {
    // Model-1: sort by % remaining (ascending = most at risk first)
    // Model-2: normalize $0-$2500 buffer into 0-100 scale for consistent ordering
    const riskA =
      a.bufferPct !== null
        ? a.bufferPct
        : a.buffer > 0
          ? Math.min(100, (a.buffer / 2500) * 100)
          : 0;
    const riskB =
      b.bufferPct !== null
        ? b.bufferPct
        : b.buffer > 0
          ? Math.min(100, (b.buffer / 2500) * 100)
          : 0;
    return riskA - riskB;
  });
  return rows;
}

function buildTeamMessageReport(clients, camProfiles, totals, cams) {
  const today = new Date().toISOString().slice(0, 10);
  const sign = (n) => (n >= 0 ? "+" : "");
  const fmt = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(Number(n || 0));
  const lines = [];
  lines.push(`📊 *Team Daily Report — ${today}*`);
  lines.push("");
  lines.push(
    `💰 *Team daily P&L:* ${sign(totals.dailyPnl)}${fmt(totals.dailyPnl)}`,
  );
  lines.push(
    `📅 *Team weekly P&L:* ${sign(totals.weeklyPnl)}${fmt(totals.weeklyPnl)}`,
  );
  lines.push(
    `👥 *Clients:* ${totals.clients} · *Accounts:* ${totals.accounts} · *Open flags:* ${totals.flags}`,
  );
  lines.push("");
  for (const cam of cams) {
    lines.push(`*${cam.name}* (${cam.clients} clients · ${cam.accounts} accs)`);
    lines.push(
      `  Daily: ${sign(cam.dailyPnl)}${fmt(cam.dailyPnl)} · Weekly: ${sign(cam.weeklyPnl)}${fmt(cam.weeklyPnl)}${cam.flags ? ` · ⚠️ ${cam.flags} flags` : ""}`,
    );
    const camClients = clientsForCam(clients, cam);
    for (const c of camClients) {
      const latest = c.dailyImports?.at(-1);
      if (!latest) continue;
      const pnl = (latest.snapshots || []).reduce(
        (s, sn) => s + Number(sn.grossRealizedPnl || 0),
        0,
      );
      lines.push(`    • ${c.name}: ${sign(pnl)}${fmt(pnl)}`);
    }
  }
  lines.push("");
  lines.push(`_Generated by Vincere CRM · Drive Insight_`);
  return lines.join("\n");
}

function auditSilently(entry) {
  createSupabaseAuditLog(entry).catch((error) => {
    console.error("[CRM] Failed to write audit log:", error);
  });
}

function downloadTextFile(fileName, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function normalizedHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function getCsvField(row = {}, aliases = []) {
  const entries = Object.entries(row || {});
  const normalizedAliases = aliases.map(normalizedHeader);
  const found = entries.find(([key]) =>
    normalizedAliases.includes(normalizedHeader(key)),
  );
  return String(found?.[1] ?? "").trim();
}

function parseConnection(value) {
  return /rithmic/i.test(String(value || "")) ? "Rithmic" : "Tradovate";
}

function splitCredentialText(value = "") {
  const text = String(value || "").trim();
  if (!text) return { login: "", password: "" };
  const loginMatch = text.match(/(?:login|user(?:name)?|email)\s*[:=-]\s*([^\n,;]+)/i);
  const passwordMatch = text.match(/(?:pass(?:word)?)\s*[:=-]\s*([^\n,;]+)/i);
  if (loginMatch || passwordMatch) {
    return {
      login: loginMatch?.[1]?.trim() || text,
      password: passwordMatch?.[1]?.trim() || "",
    };
  }
  const parts = text.split(/\s*[|,;]\s*/).filter(Boolean);
  return {
    login: parts[0] || text,
    password: parts[1] || "",
  };
}

function intakeCsvRowToClient(row = {}) {
  const firstName = getCsvField(row, ["First Name", "First"]);
  const lastName = getCsvField(row, ["Last Name", "Last"]);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim()
    || getCsvField(row, ["Full Name", "Name", "Client Name"]);
  const email = getCsvField(row, [
    "Whop Registration Email",
    "Registration Email",
    "Email",
  ]);
  const preferredTime = getCsvField(row, [
    "Preferred Communication Time",
    "Preferred Comm Time",
    "Communication Time",
  ]);
  const notes = getCsvField(row, [
    "Special Instructions or Notes",
    "Special Instructions",
    "Notes",
  ]);
  const connection = parseConnection(getCsvField(row, [
    "Are you using Tradovate or Rithmic?",
    "Tradovate or Rithmic",
    "Connection",
  ]));
  const propCredentials = splitCredentialText(getCsvField(row, [
    "Tradovate credentials",
    "Tradovate Credentials",
    "Prop Firm Credentials",
    "Prop Credentials",
  ]));
  const vpsIp = getCsvField(row, ["VPS IP Address", "VPS IP", "VPS"]);
  const vpsUsername = getCsvField(row, ["VPS Username", "VPS User"]);
  const vpsPassword = getCsvField(row, ["VPS Password"]);
  const ntLogin = getCsvField(row, ["NT8 username", "NT8 Username", "NinjaTrader username"]);
  const ntPassword = getCsvField(row, ["NT8 password", "NT8 Password", "NinjaTrader password"]);

  return {
    name: fullName,
    cam: "",
    stage: "Onboarding",
    email,
    phone: getCsvField(row, ["Phone", "Phone Number"]),
    timezone: getCsvField(row, ["Time Zone", "Timezone"]) || "America/New_York",
    messenger: getCsvField(row, ["Discord Username", "Discord"]),
    preferredChannel: "Discord",
    notes: [
      preferredTime ? `Preferred communication time: ${preferredTime}` : "",
      notes,
    ].filter(Boolean).join("\n"),
    credentials: {
      ip: vpsIp,
      username: vpsUsername,
      password: vpsPassword,
      ntLogin,
      ntPassword,
    },
    propFirms: propCredentials.login || propCredentials.password || connection
      ? [{
          id: `intake-${Date.now().toString(36)}`,
          firmName: connection,
          connection,
          login: propCredentials.login,
          password: propCredentials.password,
          sortOrder: 0,
        }]
      : [],
    source: "intake_csv",
  };
}

function UsersAccessPanel({ users = [], onUsersChange, camProfiles = [], clients = [], onRefreshState }) {
  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    displayName: "",
    email: "",
    role: USER_ROLES.CAM,
    hasCamProfile: true,
  });
  const [editUserId, setEditUserId] = useState(null);
  const [editUserPatch, setEditUserPatch] = useState({});
  const [pendingAction, setPendingAction] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const actionBusy = Boolean(pendingAction);
  const isPending = (type, id = null) =>
    pendingAction?.type === type && (id === null || pendingAction.id === id);

  function refreshUsers() {
    setStatus("loading");
    setError("");
    if (!isSupabaseConfigured) {
      setStatus("error");
      setError("Supabase environment is required.");
      return;
    }
    loadSupabaseManagedUsers()
      .then((remoteUsers) => {
        if (!remoteUsers.length) {
          throw new Error("Supabase returned zero app users. Check public.app_users and API env project.");
        }
        onUsersChange(remoteUsers);
        setStatus("connected");
      })
      .catch((err) => {
        console.error("[CRM] Failed to load managed users:", err);
        setError(err.message || "Could not load users from Supabase.");
        setStatus("error");
      });
  }

  useEffect(() => {
    refreshUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function assignedClientsForUser(user) {
    const profile = (camProfiles || []).find((cam) => cam.id === user.camProfileId);
    const ids = new Set(profile?.clientIds || []);
    return (clients || []).filter((client) => ids.has(client.id));
  }

  function closeConfirmAction() {
    if (!actionBusy) setConfirmAction(null);
  }

  async function runConfirmAction() {
    if (!confirmAction?.onConfirm) return;
    await confirmAction.onConfirm();
    setConfirmAction(null);
  }

  async function submitNewUser(event) {
    event.preventDefault();
    if (actionBusy) return;
    if (!newUser.username || !newUser.password || !newUser.displayName || !newUser.email) return;
    const isDuplicate = (users || []).some(
      (u) => u.username?.toLowerCase() === newUser.username.toLowerCase(),
    );
    if (isDuplicate) {
      alert(`Username "${newUser.username}" is already taken. Choose a different username.`);
      return;
    }
    try {
      setPendingAction({ type: "create" });
      setError("");
      const payload = {
        ...newUser,
        hasCamProfile: newUser.role === USER_ROLES.CAM && Boolean(newUser.hasCamProfile),
      };
      const remoteUsers = await createSupabaseManagedUser(payload);
      onUsersChange(remoteUsers);
      const createdUser = remoteUsers.find((u) => u.username === newUser.username.toLowerCase());
      auditSilently({
        entityType: "app_user",
        entityId: createdUser?.appUserId || null,
        action: "user.create",
        afterData: {
          username: newUser.username,
          displayName: newUser.displayName,
          email: newUser.email,
          role: newUser.role,
          hasCamProfile: payload.hasCamProfile,
        },
      });
      await onRefreshState?.();
      setStatus("connected");
      setNewUser({
        username: "",
        password: "",
        displayName: "",
        email: "",
        role: USER_ROLES.CAM,
        hasCamProfile: true,
      });
    } catch (err) {
      window.alert(`Could not create user: ${err.message}`);
      setStatus("error");
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  }

  function requestUserSave(user) {
    if (actionBusy) return;
    const patch = { ...editUserPatch };
    if (!patch.password) delete patch.password;
    const passwordChanged = Boolean(patch.password);
    const nextUser = {
      appUserId: user.appUserId,
      username: patch.username ?? user.username,
      displayName: patch.displayName ?? user.displayName,
      email: patch.email ?? user.email,
      role: patch.role ?? user.role,
      hasCamProfile: (patch.role ?? user.role) === USER_ROLES.CAM
        ? (patch.hasCamProfile ?? Boolean(user.camProfileId))
        : false,
      status: patch.status ?? user.status ?? "Active",
      password: patch.password,
    };
    if (!nextUser.username || !nextUser.displayName || !nextUser.email) return;
    const assigned = user.camProfileId && !nextUser.hasCamProfile
      ? assignedClientsForUser(user)
      : [];
    setConfirmAction({
      type: "save",
      id: user.id,
      title: `Save changes for ${user.displayName}?`,
      description: assigned.length
        ? `${assigned.length} client${assigned.length !== 1 ? "s" : ""} will become Unassigned because CAM profile is being turned off.`
        : "This will update the user's profile, role, status, CAM profile access, or password if changed.",
      details: assigned.length ? assigned.map((client) => client.name) : [],
      confirmLabel: "Save changes",
      busyLabel: "Saving...",
      onConfirm: () => performUserSave(user, nextUser, passwordChanged),
    });
  }

  async function performUserSave(user, nextUser, passwordChanged = false) {
    try {
      setPendingAction({ type: "save", id: user.id });
      setError("");
      if (!user.appUserId) throw new Error("Supabase app user ID is missing.");
      const remoteUsers = await updateSupabaseManagedUser(nextUser);
      onUsersChange(remoteUsers);
      auditSilently({
        entityType: "app_user",
        entityId: user.appUserId,
        action: "user.update",
        beforeData: {
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          role: user.role,
          hasCamProfile: Boolean(user.camProfileId),
          status: user.status || "Active",
        },
        afterData: {
          username: nextUser.username,
          displayName: nextUser.displayName,
          email: nextUser.email,
          role: nextUser.role,
          hasCamProfile: nextUser.hasCamProfile,
          status: nextUser.status || "Active",
          passwordChanged,
        },
      });
      await onRefreshState?.();
      setStatus("connected");
      setEditUserId(null);
      setEditUserPatch({});
    } catch (err) {
      window.alert(`Could not save user: ${err.message}`);
      setStatus("error");
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  }

  function requestDeactivateUser(user) {
    if (user.role === USER_ROLES.MANAGER) return;
    if (actionBusy) return;
    setConfirmAction({
      type: "deactivate",
      id: user.id,
      title: `Deactivate ${user.displayName}?`,
      description: "They will no longer be able to sign in, but their record stays listed for history.",
      confirmLabel: "Deactivate user",
      busyLabel: "Deactivating...",
      variant: "danger",
      onConfirm: () => performDeactivateUser(user),
    });
  }

  async function performDeactivateUser(user) {
    try {
      setPendingAction({ type: "deactivate", id: user.id });
      setError("");
      if (!user.appUserId) throw new Error("Supabase app user ID is missing.");
      const remoteUsers = await deactivateSupabaseManagedUser(user.appUserId);
      onUsersChange(remoteUsers);
      auditSilently({
        entityType: "app_user",
        entityId: user.appUserId,
        action: "user.deactivate",
        beforeData: { username: user.username, status: user.status || "Active" },
        afterData: { username: user.username, status: "Inactive" },
      });
      await onRefreshState?.();
      setStatus("connected");
    } catch (err) {
      window.alert(`Could not deactivate user: ${err.message}`);
      setStatus("error");
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  }

  function requestDeleteUser(user) {
    if (user.role === USER_ROLES.MANAGER) return;
    if (actionBusy) return;
    const assigned = assignedClientsForUser(user);
    setConfirmAction({
      type: "delete",
      id: user.id,
      title: `Delete ${user.displayName} everywhere?`,
      description: assigned.length
        ? `This removes their login and linked CAM profile. ${assigned.length} client${assigned.length !== 1 ? "s" : ""} will become Unassigned.`
        : "This removes their login and linked CAM profile. This cannot be undone from the app.",
      details: assigned.length ? assigned.map((client) => client.name) : [],
      confirmLabel: "Delete user",
      busyLabel: "Deleting...",
      variant: "danger",
      onConfirm: () => performDeleteUser(user, assigned),
    });
  }

  async function performDeleteUser(user, assigned = []) {
    try {
      setPendingAction({ type: "delete", id: user.id });
      setError("");
      if (!user.appUserId) throw new Error("Supabase app user ID is missing.");
      const remoteUsers = await deleteSupabaseManagedUser(user.appUserId);
      onUsersChange(remoteUsers);
      auditSilently({
        entityType: "app_user",
        entityId: user.appUserId,
        action: "user.delete",
        beforeData: {
          username: user.username,
          displayName: user.displayName,
          camProfileId: user.camProfileId || null,
          assignedClientCount: assigned.length,
        },
      });
      await onRefreshState?.();
      setStatus("connected");
    } catch (err) {
      window.alert(`Could not delete user: ${err.message}`);
      setStatus("error");
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <div className="page-header manager-subpage-header">
        <div>
          <span className="eyebrow">Manager Admin</span>
          <h1>Users &amp; Access</h1>
          <div className="occ-status-row">
            <Shield size={14} />
            <span>Managers can manage users, roles, CAM assignments, and operational access.</span>
            {status === "connected" ? <span className="positive">· Supabase synced</span> : null}
          </div>
        </div>
        <button
          className="ghost-button"
          onClick={refreshUsers}
          disabled={!isSupabaseConfigured || status === "loading" || actionBusy}
        >
          {status === "loading" ? <InlineSpinner /> : <RefreshCw size={14} />}
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {status === "error" && <div className="notice error">{error}</div>}

      <section className="panel">
        <div className="panel-heading">
          <h3>User directory</h3>
          <span className="count">{users.length}</span>
        </div>
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>CAM profile</th>
                <th>Status</th>
                <th>Password</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isEditing = editUserId === u.id;
                const patch = editUserPatch;
                const camProfileEnabled = patch.hasCamProfile ?? Boolean(u.camProfileId);
                return (
                  <tr key={u.id} className={u.status === "Inactive" ? "row-muted" : ""}>
                    <td>
                      {isEditing ? (
                        <input value={patch.displayName ?? u.displayName ?? ""} onChange={(e) => setEditUserPatch((p) => ({ ...p, displayName: e.target.value }))} />
                      ) : u.displayName}
                    </td>
                    <td>
                      {isEditing ? (
                        <input value={patch.username ?? u.username ?? ""} onChange={(e) => setEditUserPatch((p) => ({ ...p, username: e.target.value }))} />
                      ) : <code>{u.username}</code>}
                    </td>
                    <td>
                      {isEditing ? (
                        <input type="email" value={patch.email ?? u.email ?? ""} onChange={(e) => setEditUserPatch((p) => ({ ...p, email: e.target.value }))} />
                      ) : <span className="muted">{u.email || "—"}</span>}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          value={patch.role ?? u.role}
                          onChange={(e) => setEditUserPatch((p) => ({
                            ...p,
                            role: e.target.value,
                            hasCamProfile: e.target.value === USER_ROLES.CAM
                              ? (p.hasCamProfile ?? Boolean(u.camProfileId))
                              : false,
                          }))}
                        >
                          {Object.values(USER_ROLES).map((role) => <option key={role}>{role}</option>)}
                        </select>
                      ) : (
                        <span className={u.role === USER_ROLES.MANAGER ? "badge success" : "badge muted"}>{u.role}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        (patch.role ?? u.role) === USER_ROLES.CAM ? (
                          <label className="inline-toggle switch-field">
                            <Switch
                              id={`cam-profile-${u.id}`}
                              type="button"
                              checked={camProfileEnabled}
                              onCheckedChange={(checked) => setEditUserPatch((p) => ({ ...p, hasCamProfile: checked }))}
                            />
                            <span>CAM profile</span>
                            <strong className={camProfileEnabled ? "positive" : "muted"}>
                              {camProfileEnabled ? "On" : "Off"}
                            </strong>
                          </label>
                        ) : "—"
                      ) : (
                        u.role === USER_ROLES.CAM
                          ? <span className={u.camProfileId ? "badge success" : "badge muted"}>{u.camProfileId ? "Yes" : "No"}</span>
                          : "—"
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select value={patch.status ?? u.status ?? "Active"} onChange={(e) => setEditUserPatch((p) => ({ ...p, status: e.target.value }))}>
                          <option>Active</option>
                          <option>Inactive</option>
                        </select>
                      ) : (
                        <span className={u.status === "Inactive" ? "badge warning" : "badge success"}>{u.status || "Active"}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input type="password" value={patch.password ?? ""} onChange={(e) => setEditUserPatch((p) => ({ ...p, password: e.target.value }))} placeholder="New password" autoComplete="new-password" />
                      ) : <span className="muted">••••••</span>}
                    </td>
                    <td style={{ display: "flex", gap: 4 }}>
                      {isEditing ? (
                        <>
                          <button
                            className="primary-button"
                            disabled={actionBusy}
                            style={{ fontSize: 12, padding: "2px 8px" }}
                            onClick={() => requestUserSave(u)}
                          >
                            {isPending("save", u.id) ? <InlineSpinner /> : null}
                            {isPending("save", u.id) ? "Saving..." : "Save"}
                          </button>
                          <button
                            className="ghost-button"
                            disabled={actionBusy}
                            onClick={() => { setEditUserId(null); setEditUserPatch({}); }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="ghost-button"
                            disabled={actionBusy}
                            title="Edit"
                            onClick={() => { setEditUserId(u.id); setEditUserPatch({}); }}
                          >
                            <Edit3 size={13} />
                          </button>
                          <button
                            className="ghost-button"
                            disabled={actionBusy || u.role === USER_ROLES.MANAGER || u.status === "Inactive"}
                            title="Deactivate user"
                            onClick={() => requestDeactivateUser(u)}
                          >
                            {isPending("deactivate", u.id) ? <InlineSpinner /> : <EyeOff size={13} />}
                          </button>
                          <button
                            className="ghost-button"
                            disabled={actionBusy || u.role === USER_ROLES.MANAGER}
                            title="Delete user everywhere"
                            onClick={() => requestDeleteUser(u)}
                          >
                            {isPending("delete", u.id) ? <InlineSpinner /> : <Trash2 size={13} />}
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
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>Add user</h3>
          <span className="badge muted">Supabase Auth</span>
        </div>
        <form className="user-create-form" onSubmit={submitNewUser}>
          <input required placeholder="Display name *" value={newUser.displayName} onChange={(e) => setNewUser((v) => ({ ...v, displayName: e.target.value }))} />
          <input required placeholder="Username *" value={newUser.username} onChange={(e) => setNewUser((v) => ({ ...v, username: e.target.value }))} />
          <input required type="email" placeholder="Email *" value={newUser.email} onChange={(e) => setNewUser((v) => ({ ...v, email: e.target.value }))} />
          <input required type="password" placeholder="Password *" value={newUser.password} autoComplete="new-password" onChange={(e) => setNewUser((v) => ({ ...v, password: e.target.value }))} />
          <select
            value={newUser.role}
            onChange={(e) => setNewUser((v) => ({
              ...v,
              role: e.target.value,
              hasCamProfile: e.target.value === USER_ROLES.CAM ? v.hasCamProfile : false,
            }))}
          >
            {Object.values(USER_ROLES).map((role) => <option key={role}>{role}</option>)}
          </select>
          <label className={`inline-toggle switch-field ${newUser.role !== USER_ROLES.CAM ? "disabled" : ""}`}>
            <Switch
              id="new-user-cam-profile"
              type="button"
              checked={newUser.role === USER_ROLES.CAM && Boolean(newUser.hasCamProfile)}
              disabled={newUser.role !== USER_ROLES.CAM}
              onCheckedChange={(checked) => setNewUser((v) => ({ ...v, hasCamProfile: checked }))}
            />
            <span>CAM profile</span>
            <strong className={newUser.role === USER_ROLES.CAM && Boolean(newUser.hasCamProfile) ? "positive" : "muted"}>
              {newUser.role === USER_ROLES.CAM && Boolean(newUser.hasCamProfile) ? "On" : "Off"}
            </strong>
          </label>
          <button className="secondary-button" disabled={actionBusy}>
            {isPending("create") ? <InlineSpinner /> : <Plus size={14} />}
            {isPending("create") ? "Creating..." : "Add user"}
          </button>
        </form>
      </section>
      <ConfirmActionDialog
        action={confirmAction}
        busy={actionBusy}
        onCancel={closeConfirmAction}
        onConfirm={runConfirmAction}
      />
    </>
  );
}

function AuditLogsPanel() {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  function loadLogs() {
    setStatus("loading");
    setError("");
    loadSupabaseAuditLogs({ limit: 50 })
      .then((rows) => {
        setLogs(rows);
        setStatus("ready");
      })
      .catch((err) => {
        console.error("[CRM] Failed to load audit logs:", err);
        setError(err.message || "Could not load audit logs.");
        setStatus("error");
      });
  }

  useEffect(() => {
    loadLogs();
  }, []);

  function describeLog(log) {
    const data = log.afterData || {};
    const name = data.clientName || data.name || data.username || data.accountName || data.title || data.text || "";
    return name ? `${log.action} · ${name}` : log.action;
  }

  return (
    <>
      <div className="page-header manager-subpage-header">
        <div>
          <span className="eyebrow">Manager Admin</span>
          <h1>Audit Logs</h1>
          <div className="occ-status-row">
            <History size={14} />
            <span>Recent database-backed operational changes.</span>
            {status === "ready" ? <span className="positive">· Supabase synced</span> : null}
          </div>
        </div>
        <button className="ghost-button" onClick={loadLogs}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {status === "error" ? <div className="notice error">{error}</div> : null}

      <section className="panel">
        <div className="panel-heading">
          <h3>Recent activity</h3>
          <span className="count">{logs.length}</span>
        </div>
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{log.createdAt ? new Date(log.createdAt).toLocaleString("en-US") : "—"}</td>
                  <td>
                    <strong>{log.userDisplayName || "System"}</strong>
                    {log.userEmail ? <small>{log.userEmail}</small> : null}
                  </td>
                  <td>{log.action}</td>
                  <td>{log.entityType}</td>
                  <td>
                    <small>{describeLog(log)}</small>
                  </td>
                </tr>
              ))}
              {!logs.length && (
                <tr>
                  <td colSpan={5}>
                    <span className="muted">
                      {status === "loading" ? "Loading audit logs..." : "No audit logs yet."}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function DataToolsPanel({ clients = [], camProfiles = [], onImportClient, session }) {
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [importRows, setImportRows] = useState([]);
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isFetchingIntake, setIsFetchingIntake] = useState(false);

  const duplicateKeys = useMemo(
    () => {
      const keys = new Set();
      for (const client of clients || []) {
        const name = String(client.name || "").trim().toLowerCase();
        const email = String(client.profile?.email || "").trim().toLowerCase();
        if (name) keys.add(`name:${name}`);
        if (email) keys.add(`email:${email}`);
      }
      return keys;
    },
    [clients],
  );

  function duplicateReason(row = {}) {
    const name = String(row.name || "").trim().toLowerCase();
    const email = String(row.email || "").trim().toLowerCase();
    if (name && duplicateKeys.has(`name:${name}`)) return "Name already exists";
    if (email && duplicateKeys.has(`email:${email}`)) return "Email already exists";
    return "";
  }

  function camForClient(clientId) {
    return (camProfiles || []).find((cam) => (cam.clientIds || []).includes(clientId)) || null;
  }

  function exportClientCsv() {
    const headers = [
      "name",
      "cam",
      "stage",
      "email",
      "additionalEmails",
      "phone",
      "timezone",
      "country",
      "startDate",
      "preferredChannel",
      "language",
      "productKey",
      "messenger",
      "notes",
    ];
    const rows = [
      headers.map(csvCell).join(","),
      ...(clients || []).map((client) => {
        const cam = camForClient(client.id);
        const profile = client.profile || {};
        return [
          client.name,
          cam?.name || "",
          profile.stage || client.status || "",
          profile.email || "",
          (profile.additionalEmails || []).join("; "),
          profile.phone || "",
          profile.timezone || "",
          profile.country || "",
          profile.startDate || "",
          profile.preferredChannel || "",
          profile.language || "",
          profile.productKey || "",
          profile.messenger || "",
          client.notes || "",
        ].map(csvCell).join(",");
      }),
    ];
    downloadTextFile(
      `cam-crm-clients-${new Date().toISOString().slice(0, 10)}.csv`,
      rows.join("\n"),
      "text/csv;charset=utf-8",
    );
    auditSilently({
      entityType: "data_export",
      action: "data_export.clients_csv",
      afterData: { clientCount: clients.length },
    });
  }

  async function exportDatabaseSnapshot() {
    try {
      setStatus("exporting");
      setMessage("Preparing Supabase export...");
      const payload = await loadSupabaseDataExport();
      downloadTextFile(
        `cam-crm-supabase-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(payload, null, 2),
      );
      setStatus("ready");
      setMessage(`Exported ${Object.keys(payload.tables || {}).length} tables. Credentials are excluded.`);
    } catch (error) {
      console.error("[CRM] Failed to export database snapshot:", error);
      setStatus("error");
      setMessage(error.message || "Could not export database snapshot.");
    }
  }

  function normalizeCsvRows(data = [], mode = "client_directory") {
    const seen = new Set();
    return (data || [])
      .map((row) => (
        mode === "intake"
          ? intakeCsvRowToClient(row)
          : {
              name: String(row.name || row.client || row.clientName || "").trim(),
              cam: String(row.cam || row.camName || row.assignedCam || "").trim(),
              stage: String(row.stage || row.status || "Active").trim() || "Active",
              email: String(row.email || "").trim(),
              additionalEmails: String(row.additionalEmails || row.additional_emails || "")
                .split(/[;,|]/)
                .map((email) => email.trim())
                .filter(Boolean),
              phone: String(row.phone || "").trim(),
              timezone: String(row.timezone || "").trim(),
              country: String(row.country || "").trim(),
              startDate: String(row.startDate || row.start_date || "").trim(),
              preferredChannel: String(row.preferredChannel || row.preferred_channel || "").trim(),
              language: String(row.language || "").trim(),
              productKey: String(row.productKey || row.product_key || "").trim(),
              propFirm: String(row.propFirm || row.prop_firm || "").trim(),
              messenger: String(row.messenger || "").trim(),
              notes: String(row.notes || "").trim(),
              credentials: null,
              propFirms: [],
              source: "client_csv",
            }
      ))
      .filter((row) => {
        if (!row.name) return false;
        const nameKey = `name:${row.name.toLowerCase()}`;
        const emailKey = row.email ? `email:${String(row.email).toLowerCase()}` : "";
        if (seen.has(nameKey) || (emailKey && seen.has(emailKey))) return false;
        seen.add(nameKey);
        if (emailKey) seen.add(emailKey);
        return true;
      });
  }

  function applyParsedCsvRows(data = [], mode = "client_directory", sourceLabel = "CSV") {
    const rows = normalizeCsvRows(data, mode);
    setImportRows(rows);
    setMessage(mode === "intake"
      ? `${sourceLabel} parsed. New clients will be imported without CAM assignment.`
      : "Client directory CSV parsed.");
  }

  function parseClientCsv(file, mode = "client_directory") {
    setImportRows([]);
    setImportError("");
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, errors }) => {
        if (errors?.length) {
          setImportError(errors[0].message || "Could not parse CSV.");
          return;
        }
        applyParsedCsvRows(data, mode, "Intake CSV");
      },
      error: (error) => {
        setImportError(error.message || "Could not parse CSV.");
      },
    });
  }

  async function fetchIntakeSheet() {
    setIsFetchingIntake(true);
    setImportRows([]);
    setImportError("");
    setStatus("loading");
    setMessage("Fetching Google Sheet intake data...");
    try {
      const payload = await loadSupabaseIntakeSheet();
      Papa.parse(payload.csv || "", {
        header: true,
        skipEmptyLines: true,
        complete: ({ data, errors }) => {
          if (errors?.length) {
            setStatus("error");
            setImportError(errors[0].message || "Could not parse Google Sheet CSV.");
            return;
          }
          const parsedRows = normalizeCsvRows(data, "intake");
          const duplicateCount = parsedRows.filter((row) => duplicateReason(row)).length;
          setImportRows(parsedRows);
          setMessage("Google Sheet parsed. New clients will be imported without CAM assignment.");
          auditSilently({
            entityType: "data_import",
            action: "data_import.google_sheet.fetch",
            afterData: {
              manager: session?.displayName || session?.username || "",
              parsedCount: data?.length || 0,
              newCount: parsedRows.length - duplicateCount,
              duplicateCount,
            },
          });
          setStatus("ready");
        },
        error: (error) => {
          setStatus("error");
          setImportError(error.message || "Could not parse Google Sheet CSV.");
        },
      });
    } catch (error) {
      console.error("[CRM] Failed to fetch intake sheet:", error);
      setStatus("error");
      setMessage(error.message || "Could not fetch Google Sheet intake data.");
    } finally {
      setIsFetchingIntake(false);
    }
  }

  async function importClients() {
    const rows = importRows.filter((row) => !duplicateReason(row));
    if (!rows.length) {
      setImportError("No new clients to import. Existing names/emails are skipped.");
      return;
    }
    setIsImporting(true);
    setImportError("");
    try {
      let imported = 0;
      for (const row of rows) {
        const cam = (camProfiles || []).find((profile) => (
          profile.id === row.cam || profile.name.toLowerCase() === row.cam.toLowerCase()
        ));
        await onImportClient?.(row, cam?.id || "");
        imported += 1;
      }
      setImportRows([]);
      setStatus("ready");
      setMessage(`Imported ${imported} client${imported !== 1 ? "s" : ""} to Supabase.`);
      auditSilently({
        entityType: "data_import",
        action: rows.some((row) => row.source === "intake_csv")
          ? "data_import.google_sheet.import"
          : "data_import.clients_csv",
        afterData: {
          manager: session?.displayName || session?.username || "",
          importedCount: imported,
          duplicateCount: importRows.length - rows.length,
          source: rows.some((row) => row.source === "intake_csv")
            ? "intake"
            : "client_csv",
        },
      });
    } catch (error) {
      console.error("[CRM] Failed to import clients CSV:", error);
      setImportError(error.message || "Could not import clients.");
    } finally {
      setIsImporting(false);
    }
  }

  const previewRows = importRows.map((row) => ({
    ...row,
    duplicateReason: duplicateReason(row),
  }));
  const newRows = previewRows.filter((row) => !row.duplicateReason);
  const duplicateRows = previewRows.filter((row) => row.duplicateReason);

  return (
    <section className="panel data-tools-panel">
      <div className="panel-heading">
        <h3>Data Tools</h3>
        <span className="badge muted">Supabase safe</span>
      </div>
      <div className="data-tools-grid">
        <div className="data-tool-card">
          <strong>Database snapshot</strong>
          <p className="muted">
            Export operational Supabase tables to JSON. Credential rows are excluded.
          </p>
          <button className="secondary-button" onClick={exportDatabaseSnapshot} disabled={status === "exporting"}>
            <Download size={14} /> {status === "exporting" ? "Exporting..." : "Export JSON"}
          </button>
        </div>
        <div className="data-tool-card">
          <strong>Client directory</strong>
          <p className="muted">
            Export visible clients and CAM assignments as CSV.
          </p>
          <button className="ghost-button" onClick={exportClientCsv}>
            <Download size={14} /> Export Clients CSV
          </button>
        </div>
        <div className="data-tool-card">
          <strong>Import clients CSV</strong>
          <p className="muted">
            Columns: name, cam, stage, email, additionalEmails, phone, timezone, country, startDate, preferredChannel, language, productKey, messenger, notes.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => parseClientCsv(event.target.files?.[0], "client_directory")}
          />
          <div className="data-tool-divider" />
          <strong>Import intake CSV</strong>
          <p className="muted">
            Pull from the connected Google Sheet, or upload the exported CSV. New rows become unassigned onboarding clients.
          </p>
          <button
            className="secondary-button"
            onClick={fetchIntakeSheet}
            disabled={isFetchingIntake}
          >
            <RefreshCw size={14} /> {isFetchingIntake ? "Fetching..." : "Fetch Google Sheet"}
          </button>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => parseClientCsv(event.target.files?.[0], "intake")}
          />
          {importRows.length ? (
            <div className="muted" style={{ fontSize: 12 }}>
              {newRows.length} new · {duplicateRows.length} duplicate skipped
            </div>
          ) : null}
          {previewRows.length ? (
            <div className="intake-preview">
              <div className="intake-preview-head">
                <strong>Preview</strong>
                <span className="muted">
                  {newRows.length} ready · {duplicateRows.length} duplicate
                </span>
              </div>
              <div className="table-wrap">
                <table className="ops-table compact-table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Email</th>
                      <th>Stage</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 8).map((row, index) => (
                      <tr key={`${row.name}-${row.email}-${index}`}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td className="muted">{row.email || "—"}</td>
                        <td>{row.stage || "Onboarding"}</td>
                        <td>
                          {row.duplicateReason ? (
                            <span className="badge warning">
                              {row.duplicateReason}
                            </span>
                          ) : (
                            <span className="badge success">Ready</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previewRows.length > 8 ? (
                <small className="muted">
                  Showing first 8 rows of {previewRows.length}.
                </small>
              ) : null}
            </div>
          ) : null}
          {importError ? <div className="notice error">{importError}</div> : null}
          <button className="primary-button" onClick={importClients} disabled={!newRows.length || isImporting}>
            <Upload size={14} /> {isImporting ? "Importing..." : `Import ${newRows.length || ""}`.trim()}
          </button>
        </div>
      </div>
      {message ? (
        <div className={`notice ${status === "error" ? "error" : "info"}`}>
          {message}
        </div>
      ) : null}
    </section>
  );
}

function SopBuilderPanel() {
  const [template, setTemplate] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [sectionDraft, setSectionDraft] = useState({
    title: "",
    time: "",
    emoji: "",
  });
  const [itemDrafts, setItemDrafts] = useState({});
  const [editingSections, setEditingSections] = useState({});
  const [editingItems, setEditingItems] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);

  function loadTemplate() {
    setStatus("loading");
    setError("");
    loadSupabaseDailySopTemplate()
      .then((data) => {
        setTemplate(data);
        setStatus(data ? "ready" : "empty");
      })
      .catch((err) => {
        console.error("[CRM] Failed to load SOP template:", err);
        setError(err.message || "Could not load SOP template.");
        setStatus("error");
      });
  }

  useEffect(() => {
    loadTemplate();
  }, []);

  async function addSection(event) {
    event.preventDefault();
    if (!template?.id || !sectionDraft.title.trim()) return;
    const displayOrder =
      Math.max(
        -1,
        ...(template.sections || []).map((section) =>
          Number(section.displayOrder || 0),
        ),
      ) + 1;
    try {
      const payload = {
        key: `section-${Date.now()}`,
        title: sectionDraft.title.trim(),
        time: sectionDraft.time.trim(),
        emoji: sectionDraft.emoji.trim(),
        displayOrder,
      };
      const saved = await createSupabaseSopSection(template.id, payload);
      auditSilently({
        entityType: "sop_section",
        entityId: saved?.id || null,
        action: "sop_section.create",
        afterData: { ...payload, templateId: template.id },
      });
      setSectionDraft({ title: "", time: "", emoji: "" });
      loadTemplate();
    } catch (err) {
      window.alert(`Could not add SOP section: ${err.message}`);
    }
  }

  async function saveSection(sectionId) {
    const draft = editingSections[sectionId];
    if (!draft?.title?.trim()) return;
    try {
      const payload = {
        title: draft.title.trim(),
        time: draft.time || "",
        emoji: draft.emoji || "",
        displayOrder: draft.displayOrder,
      };
      await updateSupabaseSopSection(sectionId, payload);
      auditSilently({
        entityType: "sop_section",
        entityId: sectionId,
        action: "sop_section.update",
        afterData: payload,
      });
      setEditingSections((current) => ({ ...current, [sectionId]: null }));
      loadTemplate();
    } catch (err) {
      window.alert(`Could not save SOP section: ${err.message}`);
    }
  }

  function deactivateSection(section) {
    setConfirmAction({
      title: `Hide ${section.title}?`,
      description: "This hides the section and its items from the Daily SOP.",
      confirmLabel: "Hide section",
      busyLabel: "Hiding...",
      variant: "danger",
      onConfirm: () => performDeactivateSection(section),
    });
  }

  async function performDeactivateSection(section) {
    try {
      await updateSupabaseSopSection(section.id, { isActive: false });
      auditSilently({
        entityType: "sop_section",
        entityId: section.id,
        action: "sop_section.hide",
        beforeData: { title: section.title, isActive: section.isActive },
        afterData: { title: section.title, isActive: false },
      });
      loadTemplate();
    } catch (err) {
      window.alert(`Could not hide SOP section: ${err.message}`);
    }
  }

  async function addItem(section) {
    const text = itemDrafts[section.id]?.trim();
    if (!text) return;
    const displayOrder =
      Math.max(
        -1,
        ...(section.items || []).map((item) => Number(item.displayOrder || 0)),
      ) + 1;
    try {
      const payload = {
        key: `${section.key || "item"}-${Date.now()}`,
        text,
        displayOrder,
      };
      const saved = await createSupabaseSopItem(section.id, payload);
      auditSilently({
        entityType: "sop_item",
        entityId: saved?.id || null,
        action: "sop_item.create",
        afterData: { ...payload, sectionId: section.id },
      });
      setItemDrafts((current) => ({ ...current, [section.id]: "" }));
      loadTemplate();
    } catch (err) {
      window.alert(`Could not add SOP item: ${err.message}`);
    }
  }

  async function saveItem(itemId) {
    const draft = editingItems[itemId];
    if (!draft?.text?.trim()) return;
    try {
      const payload = {
        text: draft.text.trim(),
        displayOrder: draft.displayOrder,
      };
      await updateSupabaseSopItem(itemId, payload);
      auditSilently({
        entityType: "sop_item",
        entityId: itemId,
        action: "sop_item.update",
        afterData: payload,
      });
      setEditingItems((current) => ({ ...current, [itemId]: null }));
      loadTemplate();
    } catch (err) {
      window.alert(`Could not save SOP item: ${err.message}`);
    }
  }

  function deactivateItem(item) {
    setConfirmAction({
      title: "Hide this SOP item?",
      description: item.text,
      confirmLabel: "Hide item",
      busyLabel: "Hiding...",
      variant: "danger",
      onConfirm: () => performDeactivateItem(item),
    });
  }

  async function performDeactivateItem(item) {
    try {
      await updateSupabaseSopItem(item.id, { isActive: false });
      auditSilently({
        entityType: "sop_item",
        entityId: item.id,
        action: "sop_item.hide",
        beforeData: { text: item.text, isActive: item.isActive },
        afterData: { text: item.text, isActive: false },
      });
      loadTemplate();
    } catch (err) {
      window.alert(`Could not hide SOP item: ${err.message}`);
    }
  }

  return (
    <>
    <section className="panel sop-builder-panel">
      <div className="panel-heading">
        <h3>SOP Builder</h3>
        <span className="badge muted">
          {template?.name || "Daily CAM Checklist"}
        </span>
        <span className="badge muted">Manager edit</span>
        <button
          className="ghost-button"
          style={{ marginLeft: "auto", fontSize: 12 }}
          onClick={loadTemplate}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {status === "loading" ? (
        <p className="muted" style={{ fontSize: 12 }}>
          Loading SOP template...
        </p>
      ) : null}
      {status === "error" ? <div className="notice error">{error}</div> : null}
      {status === "empty" ? (
        <div className="notice warning">
          No active SOP template found. Run `supabase/step_6_daily_sop.sql`
          first.
        </div>
      ) : null}

      {template ? (
        <>
          <form
            className="inline-create-form sop-builder-add-section"
            onSubmit={addSection}
          >
            <input
              value={sectionDraft.emoji}
              placeholder="Icon"
              maxLength={4}
              onChange={(event) =>
                setSectionDraft((draft) => ({
                  ...draft,
                  emoji: event.target.value,
                }))
              }
            />
            <input
              value={sectionDraft.title}
              placeholder="New section title"
              onChange={(event) =>
                setSectionDraft((draft) => ({
                  ...draft,
                  title: event.target.value,
                }))
              }
            />
            <input
              value={sectionDraft.time}
              placeholder="Time label"
              onChange={(event) =>
                setSectionDraft((draft) => ({
                  ...draft,
                  time: event.target.value,
                }))
              }
            />
            <button
              className="secondary-button"
              disabled={!sectionDraft.title.trim()}
            >
              <Plus size={14} /> Section
            </button>
          </form>

          <div className="sop-builder-sections">
            {(template.sections || []).map((section) => {
              const sectionEdit = editingSections[section.id];
              return (
                <div className="sop-builder-section" key={section.id}>
                  <div className="sop-builder-section-head">
                    {sectionEdit ? (
                      <>
                        <input
                          value={sectionEdit.emoji || ""}
                          maxLength={4}
                          onChange={(event) =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: {
                                ...sectionEdit,
                                emoji: event.target.value,
                              },
                            }))
                          }
                        />
                        <input
                          value={sectionEdit.title || ""}
                          onChange={(event) =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: {
                                ...sectionEdit,
                                title: event.target.value,
                              },
                            }))
                          }
                        />
                        <input
                          value={sectionEdit.time || ""}
                          onChange={(event) =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: {
                                ...sectionEdit,
                                time: event.target.value,
                              },
                            }))
                          }
                        />
                        <input
                          type="number"
                          value={sectionEdit.displayOrder ?? 0}
                          onChange={(event) =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: {
                                ...sectionEdit,
                                displayOrder: event.target.value,
                              },
                            }))
                          }
                        />
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => saveSection(section.id)}
                        >
                          Save
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: null,
                            }))
                          }
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="sop-builder-icon">
                          {section.emoji || "□"}
                        </span>
                        <strong>{section.title}</strong>
                        <span className="muted">
                          {section.time || "No time label"}
                        </span>
                        <span className="count">
                          {section.items?.length || 0}
                        </span>
                        <button
                          className="ghost-button icon-only"
                          title="Edit section"
                          onClick={() =>
                            setEditingSections((current) => ({
                              ...current,
                              [section.id]: {
                                title: section.title,
                                time: section.time,
                                emoji: section.emoji,
                                displayOrder: section.displayOrder,
                              },
                            }))
                          }
                        >
                          <Edit3 size={13} />
                        </button>
                        <button
                          className="ghost-button icon-only"
                          title="Hide section"
                          onClick={() => deactivateSection(section)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>

                  <div className="sop-builder-items">
                    {(section.items || []).map((item) => {
                      const itemEdit = editingItems[item.id];
                      return (
                        <div className="sop-builder-item" key={item.id}>
                          {itemEdit ? (
                            <>
                              <input
                                value={itemEdit.text || ""}
                                onChange={(event) =>
                                  setEditingItems((current) => ({
                                    ...current,
                                    [item.id]: {
                                      ...itemEdit,
                                      text: event.target.value,
                                    },
                                  }))
                                }
                              />
                              <input
                                type="number"
                                value={itemEdit.displayOrder ?? 0}
                                onChange={(event) =>
                                  setEditingItems((current) => ({
                                    ...current,
                                    [item.id]: {
                                      ...itemEdit,
                                      displayOrder: event.target.value,
                                    },
                                  }))
                                }
                              />
                              <button
                                className="primary-button"
                                type="button"
                                onClick={() => saveItem(item.id)}
                              >
                                Save
                              </button>
                              <button
                                className="ghost-button"
                                type="button"
                                onClick={() =>
                                  setEditingItems((current) => ({
                                    ...current,
                                    [item.id]: null,
                                  }))
                                }
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="muted">{item.key}</span>
                              <span>{item.text}</span>
                              <button
                                className="ghost-button icon-only"
                                title="Edit item"
                                onClick={() =>
                                  setEditingItems((current) => ({
                                    ...current,
                                    [item.id]: {
                                      text: item.text,
                                      displayOrder: item.displayOrder,
                                    },
                                  }))
                                }
                              >
                                <Edit3 size={13} />
                              </button>
                              <button
                                className="ghost-button icon-only"
                                title="Hide item"
                                onClick={() => deactivateItem(item)}
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <form
                    className="inline-create-form sop-builder-add-item"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addItem(section);
                    }}
                  >
                    <input
                      value={itemDrafts[section.id] || ""}
                      placeholder={`Add item to ${section.title}`}
                      onChange={(event) =>
                        setItemDrafts((current) => ({
                          ...current,
                          [section.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      className="secondary-button"
                      disabled={!itemDrafts[section.id]?.trim()}
                    >
                      <Plus size={14} /> Item
                    </button>
                  </form>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
    <ConfirmActionDialog
      action={confirmAction}
      onCancel={() => setConfirmAction(null)}
      onConfirm={() => {
        confirmAction?.onConfirm?.();
        setConfirmAction(null);
      }}
    />
    </>
  );
}

function ManagerOverview({
  clients,
  camProfiles = [],
  onOpenCam,
  onCreateCam,
  onUpdateCamProfile,
  onAddClient,
  onImportClient,
  onAppendDailyImport,
  onLogout,
  users = [],
  onUsersChange,
  onRefreshState,
  session,
  onUpdateClientAccount,
  onTransferClient,
  onResolveFlag,
}) {
  const [newCamName, setNewCamName] = useState("");
  const [showUserPanel, setShowUserPanel] = useState(false);
  const [showAuditPanel, setShowAuditPanel] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchImportResult, setBatchImportResult] = useState(null);
  const [drillDate, setDrillDate] = useState("");
  const [teamCopyDone, setTeamCopyDone] = useState(false);
  const [weeklyCopyDone, setWeeklyCopyDone] = useState(false);
  const [newClientForm, setNewClientForm] = useState({
    name: "",
    camId: "",
    stage: "Active",
  });
  const [showNewClient, setShowNewClient] = useState(false);
  const [showSopBuilder, setShowSopBuilder] = useState(false);
  const [showDataTools, setShowDataTools] = useState(false);
  const [fundedSort, setFundedSort] = useState({ col: "buffer", dir: -1 });
  const [managerSearch, setManagerSearch] = useState("");
  const [managerConfirmAction, setManagerConfirmAction] = useState(null);
  const teamHistory = useMemo(
    () => buildTeamHistory(clients).slice(-10),
    [clients],
  );
  const activeCamProfiles = useMemo(
    () => activeCamProfilesForUsers(camProfiles, users),
    [camProfiles, users],
  );
  const cams = useMemo(
    () =>
      activeCamProfiles.map((profile) => {
        const summary = buildManagerSummary(clientsForCam(clients, profile));
        return { ...profile, ...summary, flags: summary.openFlags };
      }),
    [clients, activeCamProfiles],
  );
  const totals = useMemo(
    () =>
      cams.reduce(
        (acc, cam) => ({
          clients: acc.clients + cam.clients,
          accounts: acc.accounts + cam.accounts,
          weeklyPnl: acc.weeklyPnl + cam.weeklyPnl,
          dailyPnl: acc.dailyPnl + cam.dailyPnl,
          flags: acc.flags + cam.flags,
        }),
        { clients: 0, accounts: 0, weeklyPnl: 0, dailyPnl: 0, flags: 0 },
      ),
    [cams],
  );

  const strategies = useMemo(() => buildStrategyAnalyzer(clients), [clients]);
  const strategyEffectiveness = useMemo(
    () => buildStrategyEffectiveness(clients),
    [clients],
  );
  const lifecycle = useMemo(() => buildLifecycleMetrics(clients), [clients]);
  const riskDist = useMemo(
    () => buildRiskDistribution(clients, activeCamProfiles),
    [clients, activeCamProfiles],
  );
  const camPerf = useMemo(
    () => buildCamPerformance(clients, activeCamProfiles),
    [clients, activeCamProfiles],
  );
  const managerInsights = useMemo(
    () => buildPortfolioInsights(clients),
    [clients],
  );
  const allFunded = useMemo(
    () => buildAllFundedAccounts(clients, activeCamProfiles),
    [clients, activeCamProfiles],
  );
  const allEvals = useMemo(() => {
    const rows = [];
    for (const client of clients) {
      const cam = activeCamProfiles.find((p) =>
        (p.clientIds || []).includes(client.id),
      );
      const reg = client.accountRegistry || {};
      const latestImport = (client.dailyImports || []).at(-1);
      for (const [accountName, meta] of Object.entries(reg)) {
        if (!meta.accountType?.startsWith("Evaluation")) continue;
        if (meta.status === "Failed" || meta.status === "Inactive") continue;
        const snap = (latestImport?.snapshots || []).find(
          (s) => s.accountName === accountName,
        );
        const dailyPnl = Number(snap?.grossRealizedPnl || 0);
        const weeklyPnl = Number(snap?.weeklyPnl || 0);
        const target = Number(meta.targetProfit || 0);
        const targetPct =
          target > 0 && weeklyPnl
            ? Math.round((weeklyPnl / target) * 100)
            : null;
        rows.push({
          accountName,
          alias: meta.alias || accountName,
          clientName: client.name,
          clientId: client.id,
          camName: cam?.name || "—",
          accountType: meta.accountType,
          bulletBotPassType: meta.bulletBotPassType || "",
          dailyPnl,
          weeklyPnl,
          targetPct,
          status: meta.status || "Active",
        });
      }
    }
    return rows.sort((a, b) => b.weeklyPnl - a.weeklyPnl);
  }, [clients, activeCamProfiles]);

  const unassignedClients = useMemo(() => {
    const assignedClientIds = new Set(
      activeCamProfiles.flatMap((profile) => profile.clientIds || []),
    );
    return (clients || []).filter((client) => !assignedClientIds.has(client.id));
  }, [clients, activeCamProfiles]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyKpis = useMemo(() => {
    let monthlyPnl = 0,
      payoutAmount = 0,
      payoutCount = 0,
      fundedActive = 0;
    const today = todayIsoDate();
    let closedToday = 0,
      withUploadToday = 0;
    for (const client of clients) {
      for (const di of client.dailyImports || []) {
        if (di.date?.startsWith(currentMonth)) {
          monthlyPnl += (di.snapshots || []).reduce(
            (s, sn) => s + Number(sn.grossRealizedPnl || 0),
            0,
          );
        }
        if (di.date === today) {
          withUploadToday++;
          if (di.status === "Closed") closedToday++;
        }
      }
      for (const acct of Object.values(client.accountRegistry || {})) {
        if (
          acct.accountType === "Funded" &&
          acct.status !== "Failed" &&
          acct.status !== "Inactive"
        )
          fundedActive++;
        for (const p of acct.payoutHistory || []) {
          if (p.date?.startsWith(currentMonth)) {
            payoutAmount += Number(p.amount || 0);
            payoutCount++;
          }
        }
      }
    }
    return {
      monthlyPnl,
      payoutAmount,
      payoutCount,
      fundedActive,
      closedToday,
      withUploadToday,
    };
  }, [clients, currentMonth]);

  function submitCam(event) {
    event.preventDefault();
    if (!newCamName.trim()) return;
    onCreateCam(newCamName.trim());
    setNewCamName("");
  }

  const healthScore = (() => {
    if (!clients.length) return null;
    let score = 100;
    const today = todayIsoDate();
    // Deduct for unclosed clients with uploads
    const withUpload = clients.filter((c) => getClientImportByDate(c, today));
    const unclosed = withUpload.filter(
      (c) => getClientImportByDate(c, today)?.status !== "Closed",
    ).length;
    if (withUpload.length)
      score -= Math.round((unclosed / withUpload.length) * 25);
    // Deduct for critical flags
    const critFlags = clients.reduce(
      (n, c) =>
        n +
        (c.dailyImports?.at(-1)?.flags || []).filter(
          (f) =>
            f.severity === "Critical" &&
            f.status !== "Resolved" &&
            f.status !== "Acknowledged",
        ).length,
      0,
    );
    score -= Math.min(critFlags * 5, 25);
    // Deduct for overdue tasks
    const overdueTasks = clients.reduce(
      (n, c) =>
        n +
        (c.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate < today)
          .length,
      0,
    );
    score -= Math.min(overdueTasks * 3, 20);
    // Deduct for accounts at critical drawdown (model-1: ≤10% remaining; model-2: ≤$500 remaining)
    const critBufferAccounts = allFunded.filter(
      (r) =>
        (r.bufferPct !== null && r.bufferPct <= 10) ||
        (r.bufferPct === null && r.buffer > 0 && r.buffer <= 500),
    ).length;
    score -= Math.min(critBufferAccounts * 5, 20);
    const clamped = Math.max(0, Math.min(100, score));
    const label =
      clamped >= 85
        ? "Excellent"
        : clamped >= 70
          ? "Good"
          : clamped >= 50
            ? "Fair"
            : "At Risk";
    const color =
      clamped >= 85
        ? "var(--success)"
        : clamped >= 70
          ? "var(--accent)"
          : clamped >= 50
            ? "var(--warning)"
            : "var(--negative)";
    return { score: clamped, label, color };
  })();

  return (
    <main className="manager-shell">
      <aside className="manager-sidebar">
        <div className="manager-sidebar-header">
          <span className="sidebar-role-badge manager-badge">Manager</span>
          <strong>Vincere CRM</strong>
          <small className="sidebar-role-sub">
            {session?.displayName || session?.username || "Manager"}
          </small>
        </div>
        <div className="manager-sidebar-main">
          <button
            className={!showUserPanel && !showAuditPanel ? "client-link active" : "client-link"}
            onClick={() => {
              setShowUserPanel(false);
              setShowAuditPanel(false);
            }}
          >
            <Users size={16} />
            <span>Operations</span>
            <em>Live</em>
          </button>
          <input
            className="client-search"
            value={managerSearch}
            placeholder="Search clients..."
            onChange={(e) => setManagerSearch(e.target.value)}
          />
          {managerSearch.length >= 2
            ? (() => {
                const q = managerSearch.toLowerCase();
                const results = clients.flatMap((c) => {
                  const cam = activeCamProfiles.find((p) =>
                    (p.clientIds || []).includes(c.id),
                  );
                  const nameMatch = c.name?.toLowerCase().includes(q);
                  const accountMatch = Object.keys(c.accountRegistry || {}).some(
                    (k) =>
                      k.toLowerCase().includes(q) ||
                      (c.accountRegistry[k].alias || "")
                        .toLowerCase()
                        .includes(q),
                  );
                  if (!nameMatch && !accountMatch) return [];
                  return [{ client: c, cam, nameMatch, accountMatch }];
                });
                return results.length ? (
                  results.map(({ client, cam }) => (
                    <button
                      key={client.id}
                      className="client-link client-link-search"
                      onClick={() => {
                        onOpenCam(cam?.id, client.id);
                        setManagerSearch("");
                      }}
                    >
                      <span>{client.name}</span>
                      <small className="muted">{cam?.name || "—"}</small>
                    </button>
                  ))
                ) : (
                  <div className="nav-label muted manager-sidebar-empty">
                    No match
                  </div>
                );
              })()
            : cams.map((cam) => (
                <button
                  className="client-link"
                  key={cam.id}
                  onClick={() => onOpenCam(cam.id)}
                >
                  <BarChart3 size={16} />
                  <span>{cam.name}</span>
                  <em className={cam.dailyPnl >= 0 ? "positive" : "negative"}>
                    {formatCurrency(cam.dailyPnl)}
                  </em>
                </button>
              ))}
        </div>
        <div className="manager-sidebar-footer">
          <button
            className={showUserPanel ? "client-link active" : "client-link"}
            onClick={() => {
              setShowUserPanel(true);
              setShowAuditPanel(false);
            }}
          >
            <Shield size={16} />
            <span>Users & Access</span>
          </button>
          <button
            className={showAuditPanel ? "client-link active" : "client-link"}
            onClick={() => {
              setShowAuditPanel(true);
              setShowUserPanel(false);
            }}
          >
            <History size={16} />
            <span>Audit Logs</span>
          </button>
          <button className="client-link" onClick={onLogout}>
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <section className="content">
        {showUserPanel ? (
          <UsersAccessPanel
            users={users}
            onUsersChange={onUsersChange}
            camProfiles={camProfiles}
            clients={clients}
            onRefreshState={onRefreshState}
          />
        ) : showAuditPanel ? (
          <AuditLogsPanel />
        ) : (
          <>
        <div className="page-header">
          <div>
            <span className="eyebrow">
              Vincere Trading ·{" "}
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
            <h1>Operations Command Center</h1>
            <div className="occ-status-row">
              <span className="occ-live-dot" />
              <span>
                {cams.length} CAMs active · {totals.clients} clients ·{" "}
                {totals.accounts} accounts tracked
              </span>
              {totals.flags > 0 && (
                <span className="badge danger">
                  {totals.flags} open flag{totals.flags !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
          <div className="header-actions operations-primary-actions">
            <button
              className="primary-button workspace-open-button"
              onClick={() => onOpenCam(cams[0]?.id || "am-pedro")}
            >
              <BarChart3 size={16} /> Open {cams[0]?.name || "Pedro"}'s
              Workspace
            </button>
            <button
              className={showNewClient ? "secondary-button" : "ghost-button"}
              onClick={() => setShowNewClient((v) => !v)}
            >
              <UserPlus size={14} /> New Client
            </button>
          </div>
        </div>

        <div className="operations-toolbar" aria-label="Operations tools">
          <span className="operations-toolbar-label">Tools</span>
          <button
            className={showSopBuilder ? "secondary-button" : "ghost-button"}
            onClick={() => setShowSopBuilder((v) => !v)}
          >
            <ListChecks size={14} /> SOP Item
          </button>
          <button
            className={showPipeline ? "secondary-button" : "ghost-button"}
            onClick={() => setShowPipeline((v) => !v)}
          >
            <Kanban size={14} /> Pipeline
          </button>
          <button
            className={showBatchImport ? "secondary-button" : "ghost-button"}
            onClick={() => {
              setShowBatchImport((v) => !v);
              setBatchImportResult(null);
            }}
          >
            <FileUp size={14} /> Batch Import
          </button>
          <button
            className={showDataTools ? "secondary-button" : "ghost-button"}
            onClick={() => setShowDataTools((value) => !value)}
          >
            <Download size={14} /> Data Tools
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              const txt = buildTeamWeeklyReport(clients, activeCamProfiles);
              navigator.clipboard.writeText(txt).then(() => {
                setWeeklyCopyDone(true);
                setTimeout(() => setWeeklyCopyDone(false), 2000);
              });
            }}
            title="Copy weekly team summary for Slack / email"
          >
            <ClipboardList size={14} />
            {weeklyCopyDone ? "Copied!" : "Weekly Report"}
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              const report = buildTeamMessageReport(
                clients,
                activeCamProfiles,
                totals,
                cams,
              );
              navigator.clipboard.writeText(report).then(() => {
                setTeamCopyDone(true);
                setTimeout(() => setTeamCopyDone(false), 2000);
              });
            }}
            title="Copy team daily report for WhatsApp/Telegram"
          >
            <Copy size={14} />
            {teamCopyDone ? "Copied!" : "Copy Team Report"}
          </button>
        </div>

        {unassignedClients.length > 0 && (
          <div className="notice warning">
            <AlertTriangle size={16} />
            <span>
              <strong>{unassignedClients.length} client{unassignedClients.length !== 1 ? "s" : ""} unassigned</strong>
              {" "}— no active CAM assigned. Reassign in the Client roster below:{" "}
              {unassignedClients.map((client) => client.name).join(", ")}
            </span>
          </div>
        )}

        <div className="metric-grid">
          <div className="metric">
            <span>Team daily P&L</span>
            <strong
              className={totals.dailyPnl >= 0 ? "positive" : "negative"}
              style={{ fontSize: 22 }}
            >
              {formatCurrency(totals.dailyPnl)}
            </strong>
          </div>
          <div className="metric">
            <span>Team weekly P&L</span>
            <strong
              className={totals.weeklyPnl >= 0 ? "positive" : "negative"}
              style={{ fontSize: 22 }}
            >
              {formatCurrency(totals.weeklyPnl)}
            </strong>
          </div>
          <div className="metric">
            <span>Monthly P&L ({currentMonth})</span>
            <strong
              className={monthlyKpis.monthlyPnl >= 0 ? "positive" : "negative"}
              style={{ fontSize: 22 }}
            >
              {formatCurrency(monthlyKpis.monthlyPnl)}
            </strong>
          </div>
          <div className="metric">
            <span>Payouts this month</span>
            <strong className="positive" style={{ fontSize: 22 }}>
              {formatCurrency(monthlyKpis.payoutAmount)}
            </strong>
            <small className="muted">×{monthlyKpis.payoutCount}</small>
          </div>
          <div className="metric">
            <span>Funded accounts active</span>
            <strong style={{ fontSize: 22 }}>{monthlyKpis.fundedActive}</strong>
          </div>
          <div className="metric">
            <span>Closes today</span>
            <strong style={{ fontSize: 22 }}>
              {monthlyKpis.closedToday}
              <span
                style={{ fontSize: 14, fontWeight: 400, color: "var(--muted)" }}
              >
                {" "}
                / {monthlyKpis.withUploadToday}
              </span>
            </strong>
          </div>
          <div className="metric">
            <span>Clients</span>
            <strong>{totals.clients}</strong>
          </div>
          <div className="metric">
            <span>Open flags</span>
            <strong className={totals.flags ? "negative" : ""}>
              {totals.flags}
            </strong>
          </div>
          {healthScore && (
            <div
              className="metric"
              style={{
                borderColor: healthScore.color,
                background: `${healthScore.color}0d`,
              }}
            >
              <span>Portfolio health</span>
              <strong style={{ fontSize: 28, color: healthScore.color }}>
                {healthScore.score}
              </strong>
              <small style={{ color: healthScore.color, fontWeight: 600 }}>
                {healthScore.label}
              </small>
            </div>
          )}
        </div>

        {showNewClient && (
          <section className="panel manager-new-client-panel">
            <div className="panel-heading">
              <h3>Add new client</h3>
            </div>
            <form
              className="form-grid"
              style={{ padding: "4px 0 8px" }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!newClientForm.name.trim()) return;
                onAddClient?.(
                  newClientForm.name.trim(),
                  newClientForm.camId,
                  newClientForm.stage,
                );
                setNewClientForm({ name: "", camId: "", stage: "Active" });
                setShowNewClient(false);
              }}
            >
              <label>
                Client name *
                <input
                  autoFocus
                  value={newClientForm.name}
                  onChange={(e) =>
                    setNewClientForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="e.g. Carlos M."
                />
              </label>
              <label>
                Assign to CAM
                <select
                  value={newClientForm.camId}
                  onChange={(e) =>
                    setNewClientForm((f) => ({ ...f, camId: e.target.value }))
                  }
                >
                  <option value="">— Unassigned —</option>
                  {activeCamProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Stage
                <select
                  value={newClientForm.stage}
                  onChange={(e) =>
                    setNewClientForm((f) => ({ ...f, stage: e.target.value }))
                  }
                >
                  {[
                    "Onboarding",
                    "Active",
                    "At Risk",
                    "Paused",
                    "Inactive",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  gridColumn: "1/-1",
                  marginTop: 4,
                }}
              >
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!newClientForm.name.trim()}
                >
                  Create client
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setShowNewClient(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {showSopBuilder && <SopBuilderPanel />}

        {showDataTools && (
          <DataToolsPanel
            clients={clients}
            camProfiles={activeCamProfiles}
            onImportClient={onImportClient}
            session={session}
          />
        )}

        {showPipeline &&
          (() => {
            const STAGES = [
              "Onboarding",
              "Active",
              "At Risk",
              "Paused",
              "Inactive",
            ];
            const byStage = {};
            STAGES.forEach((s) => (byStage[s] = []));
            for (const client of clients) {
              const stage = client.profile?.stage || "Active";
              const cam = activeCamProfiles.find((p) =>
                (p.clientIds || []).includes(client.id),
              );
              const latest = client.dailyImports?.at(-1);
              const pnl = (latest?.snapshots || []).reduce(
                (s, sn) => s + Number(sn.grossRealizedPnl || 0),
                0,
              );
              const openTasks = (client.tasks || []).filter(
                (t) => !t.done,
              ).length;
              const openFlags = (latest?.flags || []).filter(
                (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
              ).length;
              (byStage[stage] || (byStage[stage] = [])).push({
                client,
                cam,
                pnl,
                openTasks,
                openFlags,
              });
            }
            return (
              <section className="panel">
                <div className="panel-heading">
                  <h3>Client pipeline</h3>
                  <span className="badge muted">by stage · click to open</span>
                </div>
                <div className="pipeline-board">
                  {STAGES.map((stage) => {
                    const cards = byStage[stage] || [];
                    return (
                      <div key={stage} className="pipeline-column">
                        <div className="pipeline-col-header">
                          <span>{stage}</span>
                          <span className="count">{cards.length}</span>
                        </div>
                        {cards.length === 0 ? (
                          <div className="pipeline-empty muted">—</div>
                        ) : (
                          cards.map(
                            ({ client, cam, pnl, openTasks, openFlags }) => (
                              <div
                                key={client.id}
                                role="button"
                                tabIndex={0}
                                className={`pipeline-card${openFlags > 0 ? " pipeline-card-flag" : ""}`}
                                onClick={() => onOpenCam(cam?.id, client.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onOpenCam(cam?.id, client.id);
                                  }
                                }}
                              >
                                <strong>{client.name}</strong>
                                <small className="muted">
                                  {cam?.name || "Unassigned"}
                                </small>
                                <div className="pipeline-card-chips">
                                  <span
                                    className={
                                      pnl >= 0 ? "positive" : "negative"
                                    }
                                    style={{ fontSize: 11 }}
                                  >
                                    {formatCurrency(pnl)}
                                  </span>
                                  {openFlags > 0 && (
                                    <span
                                      className="task-chip task-chip-high"
                                      style={{ fontSize: 10 }}
                                    >
                                      {openFlags} flag
                                      {openFlags !== 1 ? "s" : ""}
                                    </span>
                                  )}
                                  {openTasks > 0 && (
                                    <span
                                      className="task-chip"
                                      style={{ fontSize: 10 }}
                                    >
                                      {openTasks} task
                                      {openTasks !== 1 ? "s" : ""}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ),
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })()}

        {showBatchImport && (
          <section className="panel">
            <div className="panel-heading">
              <h3>Batch import — all clients</h3>
              <span className="badge muted">
                Drop NT CSV files from any client
              </span>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              Upload accounts + strategies CSVs from multiple clients at once.
              The system matches each account to its registered client
              automatically.
            </p>
            <div
              className="batch-drop-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault();
                const files = [...e.dataTransfer.files].filter((f) =>
                  f.name.toLowerCase().endsWith(".csv"),
                );
                if (!files.length) {
                  setBatchImportResult({
                    error:
                      "No CSV files found. Drop NinjaTrader .csv export files here.",
                  });
                  return;
                }
                const today = new Date().toISOString().slice(0, 10);
                const parsed = [];
                for (const f of files) {
                  try {
                    const text = await new Promise((res, rej) => {
                      const r = new FileReader();
                      r.onload = () => res(String(r.result));
                      r.onerror = rej;
                      r.readAsText(f);
                    });
                    parsed.push(parseNinjaTraderCsvText(text, f.name));
                  } catch {
                    /* skip unreadable file */
                  }
                }
                const grouped = parsed.reduce((acc, p) => {
                  if (p.type !== "unknown")
                    acc[p.type] = [...(acc[p.type] || []), ...p.rows];
                  return acc;
                }, {});
                const accountNamesLower = new Set(
                  (grouped.accounts || []).map((a) =>
                    a.accountName.toLowerCase(),
                  ),
                );
                if (!accountNamesLower.size) {
                  setBatchImportResult({
                    error:
                      "No account data found in the uploaded files. Make sure to include the NT Accounts CSV.",
                  });
                  return;
                }
                const clientMatches = clients
                  .map((client) => {
                    const myAccounts = Object.keys(
                      client.accountRegistry || {},
                    ).filter((an) => accountNamesLower.has(an.toLowerCase()));
                    if (!myAccounts.length) return null;
                    const myAccountsLower = new Set(
                      myAccounts.map((a) => a.toLowerCase()),
                    );
                    const filteredGrouped = {
                      accounts: (grouped.accounts || []).filter((a) =>
                        myAccountsLower.has(a.accountName.toLowerCase()),
                      ),
                      strategies: (grouped.strategies || []).filter((a) =>
                        myAccountsLower.has(a.accountName.toLowerCase()),
                      ),
                      orders: (grouped.orders || []).filter((a) =>
                        myAccountsLower.has(a.accountName.toLowerCase()),
                      ),
                      executions: (grouped.executions || []).filter((a) =>
                        myAccountsLower.has(a.accountName.toLowerCase()),
                      ),
                    };
                    try {
                      const result = reconcileDailyImport({
                        clientId: client.id,
                        date: today,
                        registry: client.accountRegistry,
                        parsed: filteredGrouped,
                      });
                      return {
                        client,
                        result,
                        accountCount: myAccounts.length,
                      };
                    } catch {
                      return null;
                    }
                  })
                  .filter(Boolean);
                const unmatched = [
                  ...new Set(
                    (grouped.accounts || []).map((a) => a.accountName),
                  ),
                ].filter(
                  (an) =>
                    !clients.some((c) =>
                      Object.keys(c.accountRegistry || {})
                        .map((k) => k.toLowerCase())
                        .includes(an.toLowerCase()),
                    ),
                );
                setBatchImportResult({
                  clientMatches,
                  unmatched,
                  today,
                  filesLoaded: files.length,
                });
              }}
            >
              <span>Drag & drop NT CSV files here</span>
              <small className="muted">
                accounts + strategies + orders + executions from any number of
                clients
              </small>
              <label
                style={{
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--accent)",
                  marginTop: 4,
                }}
              >
                or{" "}
                <span style={{ textDecoration: "underline" }}>
                  click to browse
                </span>
                <input
                  type="file"
                  accept=".csv"
                  multiple
                  style={{ display: "none" }}
                  onChange={async (ev) => {
                    const files = [...ev.target.files];
                    ev.target.value = "";
                    if (!files.length) return;
                    const today = new Date().toISOString().slice(0, 10);
                    const parsed = [];
                    for (const f of files) {
                      try {
                        const text = await new Promise((res, rej) => {
                          const r = new FileReader();
                          r.onload = () => res(String(r.result));
                          r.onerror = rej;
                          r.readAsText(f);
                        });
                        parsed.push(parseNinjaTraderCsvText(text, f.name));
                      } catch {}
                    }
                    const grouped = parsed.reduce((acc, p) => {
                      if (p.type !== "unknown")
                        acc[p.type] = [...(acc[p.type] || []), ...p.rows];
                      return acc;
                    }, {});
                    const accountNamesLower2 = new Set(
                      (grouped.accounts || []).map((a) =>
                        a.accountName.toLowerCase(),
                      ),
                    );
                    if (!accountNamesLower2.size) {
                      setBatchImportResult({ error: "No account data found." });
                      return;
                    }
                    const clientMatches = clients
                      .map((client) => {
                        const myAccounts = Object.keys(
                          client.accountRegistry || {},
                        ).filter((an) =>
                          accountNamesLower2.has(an.toLowerCase()),
                        );
                        if (!myAccounts.length) return null;
                        const mal = new Set(
                          myAccounts.map((a) => a.toLowerCase()),
                        );
                        const fg = {
                          accounts: (grouped.accounts || []).filter((a) =>
                            mal.has(a.accountName.toLowerCase()),
                          ),
                          strategies: (grouped.strategies || []).filter((a) =>
                            mal.has(a.accountName.toLowerCase()),
                          ),
                          orders: (grouped.orders || []).filter((a) =>
                            mal.has(a.accountName.toLowerCase()),
                          ),
                          executions: (grouped.executions || []).filter((a) =>
                            mal.has(a.accountName.toLowerCase()),
                          ),
                        };
                        try {
                          return {
                            client,
                            result: reconcileDailyImport({
                              clientId: client.id,
                              date: today,
                              registry: client.accountRegistry,
                              parsed: fg,
                            }),
                            accountCount: myAccounts.length,
                          };
                        } catch {
                          return null;
                        }
                      })
                      .filter(Boolean);
                    setBatchImportResult({
                      clientMatches,
                      unmatched: [
                        ...new Set(
                          (grouped.accounts || []).map((a) => a.accountName),
                        ),
                      ].filter(
                        (an) =>
                          !clients.some((c) =>
                            Object.keys(c.accountRegistry || {})
                              .map((k) => k.toLowerCase())
                              .includes(an.toLowerCase()),
                          ),
                      ),
                      today,
                      filesLoaded: files.length,
                    });
                  }}
                />
              </label>
            </div>
            {batchImportResult?.error && (
              <div className="notice error" style={{ marginTop: 8 }}>
                {batchImportResult.error}
              </div>
            )}
            {batchImportResult && !batchImportResult.error && (
              <div style={{ marginTop: 12 }}>
                <p className="muted" style={{ fontSize: 12 }}>
                  <strong className="positive">
                    {batchImportResult.clientMatches.length} clients matched
                  </strong>
                  {batchImportResult.unmatched?.length > 0 ? (
                    <span className="negative">
                      {" "}
                      · {batchImportResult.unmatched.length} unregistered
                      accounts: {batchImportResult.unmatched.join(", ")}
                    </span>
                  ) : null}
                  {batchImportResult.filesLoaded ? (
                    <span> · {batchImportResult.filesLoaded} files loaded</span>
                  ) : null}
                </p>
                <table className="ops-table" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Accounts found</th>
                      <th>Flags</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchImportResult.clientMatches.map(
                      ({ client, result, accountCount }) => (
                        <tr key={client.id}>
                          <td>
                            <strong>{client.name}</strong>
                          </td>
                          <td>{accountCount}</td>
                          <td>
                            {(result.flags || []).filter(
                              (f) => f.severity === "Critical",
                            ).length > 0 ? (
                              <span className="negative">
                                {
                                  (result.flags || []).filter(
                                    (f) => f.severity === "Critical",
                                  ).length
                                }{" "}
                                critical
                              </span>
                            ) : (
                              <span className="positive">
                                {(result.flags || []).length} flags
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              className="primary-button"
                              style={{ padding: "3px 10px", fontSize: 11 }}
                              onClick={() => {
                                onAppendDailyImport?.(client.id, result);
                                setBatchImportResult((prev) => ({
                                  ...prev,
                                  clientMatches: prev.clientMatches.filter(
                                    (m) => m.client.id !== client.id,
                                  ),
                                }));
                              }}
                            >
                              Import
                            </button>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
                {batchImportResult.clientMatches.length > 1 && (
                  <button
                    className="secondary-button"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      batchImportResult.clientMatches.forEach(
                        ({ client, result }) =>
                          onAppendDailyImport?.(client.id, result),
                      );
                      setBatchImportResult(null);
                      setShowBatchImport(false);
                    }}
                  >
                    Import all {batchImportResult.clientMatches.length} clients
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <InsightFeedPanel
          insights={managerInsights}
          onSelectClient={(clientId) => {
            const cam = activeCamProfiles.find((p) =>
              (p.clientIds || []).includes(clientId),
            );
            onOpenCam(cam?.id, clientId);
          }}
        />

        {(() => {
          const allFlags = clients
            .flatMap((c) =>
              (c.dailyImports || []).flatMap((di) =>
                (di.flags || [])
                  .filter(
                    (f) =>
                      f.status !== "Resolved" && f.status !== "Acknowledged",
                  )
                  .map((f) => {
                    const cam = activeCamProfiles.find((p) =>
                      (p.clientIds || []).includes(c.id),
                    );
                    return {
                      ...f,
                      clientName: c.name,
                      clientId: c.id,
                      importId: di.id,
                      camId: cam?.id,
                      camName: cam?.name,
                      date: di.date,
                    };
                  }),
              ),
            )
            .sort((a, b) => {
              if (a.severity === "Critical" && b.severity !== "Critical")
                return -1;
              if (b.severity === "Critical" && a.severity !== "Critical")
                return 1;
              return (b.date || "").localeCompare(a.date || "");
            });
          if (!allFlags.length) return null;
          const critCount = allFlags.filter(
            (f) => f.severity === "Critical",
          ).length;
          return (
            <section className="panel open-flags-panel">
              <div className="panel-heading">
                <h3>Open flags — all clients</h3>
                <span className={`badge ${critCount ? "danger" : "warning"}`}>
                  {allFlags.length} open
                  {critCount ? ` · ${critCount} critical` : ""}
                </span>
              </div>
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>CAM</th>
                      <th>Date</th>
                      <th>Severity</th>
                      <th>Flag</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {allFlags.map((f, i) => (
                      <tr
                        key={i}
                        style={
                          f.severity === "Critical"
                            ? {
                                background:
                                  "var(--red-dim, rgba(239,68,68,.06))",
                              }
                            : undefined
                        }
                      >
                        <td>
                          <button
                            className="link-button"
                            onClick={() => onOpenCam(f.camId, f.clientId)}
                          >
                            {f.clientName}
                          </button>
                        </td>
                        <td className="muted">{f.camName || "—"}</td>
                        <td className="muted">{f.date}</td>
                        <td>
                          <span
                            className={`badge ${f.severity === "Critical" ? "danger" : "warning"}`}
                          >
                            {f.severity}
                          </span>
                        </td>
                        <td>{f.message || f.type || "—"}</td>
                        <td>
                          {onResolveFlag && (
                            <button
                              className="ghost-button"
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                whiteSpace: "nowrap",
                              }}
                              onClick={() =>
                                onResolveFlag(f.clientId, f.importId, f.id)
                              }
                            >
                              <CheckCircle2 size={13} /> Resolve
                            </button>
                          )}
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
            <h3>Account managers</h3>
          </div>
          <form
            className="inline-create-form"
            style={{ flexWrap: "wrap", marginBottom: 8 }}
            onSubmit={submitCam}
          >
            <input
              value={newCamName}
              placeholder="CAM display name"
              onChange={(e) => setNewCamName(e.target.value)}
              style={{ minWidth: 140 }}
            />
            <button className="secondary-button" disabled={!newCamName.trim()}>
              <Plus size={14} /> Create
            </button>
          </form>
          <div className="cam-card-grid">
            {cams.map((cam) => {
              const canManageClients = Boolean(cam.canManageClients);
              return (
                <div
                  className="cam-card live"
                  key={cam.id || cam.name}
                >
                  <button
                    className="cam-card-open"
                    type="button"
                    onClick={() => onOpenCam(cam.id)}
                  >
                    <strong>{cam.name}</strong>
                  </button>
                  <span>
                    {cam.role} · {cam.status || "Active"}
                  </span>
                  <small>
                    {cam.clients} clients · {cam.accounts} accounts · {cam.flags}{" "}
                    flags
                  </small>
                  <em className={cam.weeklyPnl >= 0 ? "positive" : "negative"}>
                    {formatCurrency(cam.weeklyPnl)} weekly
                  </em>
                  <label className="toggle-field cam-permission-toggle switch-field">
                    <Switch
                      id={`cam-client-permission-${cam.id}`}
                      type="button"
                      checked={canManageClients}
                      onCheckedChange={(checked) =>
                        onUpdateCamProfile?.(cam.id, {
                          canManageClients: checked,
                        })
                      }
                    />
                    <span>Create/delete clients</span>
                    <strong className={canManageClients ? "positive" : "muted"}>
                      {canManageClients ? "On" : "Off"}
                    </strong>
                  </label>
                </div>
              );
            })}
          </div>
        </section>

        {allFunded.length > 0 && (
          <section className="panel">
            <div className="panel-heading">
              <h3>All funded accounts</h3>
              <span className="badge muted">{allFunded.length} accounts</span>
              <button
                className="ghost-button"
                style={{ marginLeft: "auto" }}
                title="Export to CSV"
                onClick={() => {
                  const headers = [
                    "Account",
                    "Alias",
                    "Client",
                    "CAM",
                    "Strategies",
                    "Daily PnL",
                    "Weekly PnL",
                    "Buffer",
                    "Buffer %",
                    "Target %",
                    "Payout State",
                  ];
                  const rows = allFunded.map((r) => [
                    r.accountName,
                    r.alias,
                    r.clientName,
                    r.camName,
                    r.strategies,
                    r.dailyPnl.toFixed(2),
                    r.weeklyPnl.toFixed(2),
                    r.buffer.toFixed(2),
                    r.bufferPct !== null ? r.bufferPct : "",
                    r.targetPct !== null ? r.targetPct : "",
                    r.payoutState || "",
                  ]);
                  const csv = [headers, ...rows]
                    .map((row) =>
                      row
                        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
                        .join(","),
                    )
                    .join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(
                    new Blob([csv], { type: "text/csv" }),
                  );
                  a.download = `funded-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
                  a.click();
                }}
              >
                <Download size={14} /> Export CSV
              </button>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  {(() => {
                    const SortTh = ({ col, label }) => {
                      const active = fundedSort.col === col;
                      return (
                        <th
                          style={{
                            cursor: "pointer",
                            userSelect: "none",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() =>
                            setFundedSort((s) =>
                              s.col === col
                                ? { col, dir: -s.dir }
                                : { col, dir: -1 },
                            )
                          }
                        >
                          {label}
                          {active
                            ? fundedSort.dir === -1
                              ? " ↓"
                              : " ↑"
                            : " ·"}
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
                  {[...allFunded]
                    .sort((a, b) => {
                      const { col, dir } = fundedSort;
                      const av =
                        col === "client"
                          ? a.clientName || ""
                          : (a[col] ?? -Infinity);
                      const bv =
                        col === "client"
                          ? b.clientName || ""
                          : (b[col] ?? -Infinity);
                      if (typeof av === "string")
                        return dir * av.localeCompare(bv);
                      return dir * (bv - av);
                    })
                    .map((row) => (
                      <tr
                        key={row.accountName}
                        tabIndex={0}
                        className={
                          row.bufferPct !== null && row.bufferPct <= 20
                            ? "row-highlight"
                            : ""
                        }
                        style={{ cursor: "pointer" }}
                        onClick={() => {
                          const cam = activeCamProfiles.find((c) =>
                            c.clientIds?.includes(row.clientId),
                          );
                          onOpenCam(cam?.id, row.clientId);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            const cam = activeCamProfiles.find((c) =>
                              c.clientIds?.includes(row.clientId),
                            );
                            onOpenCam(cam?.id, row.clientId);
                          }
                        }}
                      >
                        <td>
                          <strong>{row.alias}</strong>
                          <small>{row.connection}</small>
                        </td>
                        <td>{row.clientName}</td>
                        <td>
                          <small>{row.camName}</small>
                        </td>
                        <td>
                          <small>{row.strategies}</small>
                        </td>
                        <td
                          className={
                            row.dailyPnl >= 0 ? "positive" : "negative"
                          }
                        >
                          {formatCurrency(row.dailyPnl)}
                        </td>
                        <td
                          className={
                            row.weeklyPnl >= 0 ? "positive" : "negative"
                          }
                        >
                          {formatCurrency(row.weeklyPnl)}
                        </td>
                        <td
                          className={
                            row.bufferPct !== null
                              ? row.bufferPct <= 20
                                ? "negative"
                                : row.bufferPct <= 50
                                  ? ""
                                  : "positive"
                              : ""
                          }
                        >
                          {row.bufferPct !== null
                            ? `${formatCurrency(row.buffer)} (${row.bufferPct}%)`
                            : row.buffer > 0
                              ? formatCurrency(row.buffer)
                              : "—"}
                        </td>
                        <td>
                          {row.targetPct !== null ? (
                            <div
                              className="target-progress"
                              style={{ minWidth: 80 }}
                            >
                              <div className="target-bar">
                                <i
                                  style={{
                                    width: `${row.targetPct}%`,
                                    background:
                                      row.targetPct >= 100
                                        ? "var(--success)"
                                        : row.targetPct >= 80
                                          ? "var(--warning)"
                                          : "var(--accent)",
                                  }}
                                />
                              </div>
                              <small>{row.targetPct}%</small>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <small
                            className={
                              row.payoutState === "Clear to trade"
                                ? "positive"
                                : row.payoutState?.includes("requested")
                                  ? ""
                                  : "muted"
                            }
                          >
                            {row.payoutState || "—"}
                          </small>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {row.bufferPct !== null &&
                          row.bufferPct <= 5 &&
                          onUpdateClientAccount ? (
                            <button
                              className="ghost-button"
                              style={{
                                color: "var(--negative)",
                                fontSize: 11,
                                padding: "2px 6px",
                                whiteSpace: "nowrap",
                              }}
                              onClick={() => {
                                setManagerConfirmAction({
                                  title: `Mark ${row.alias} as failed?`,
                                  description: "This sets status to Failed and dateFailed to today. It cannot be undone from this view.",
                                  confirmLabel: "Mark failed",
                                  busyLabel: "Updating...",
                                  variant: "danger",
                                  onConfirm: () =>
                                    onUpdateClientAccount(
                                      row.clientId,
                                      row.accountName,
                                      {
                                        status: "Failed",
                                        dateFailed: todayIsoDate(),
                                      },
                                    ),
                                });
                              }}
                            >
                              <AlertTriangle size={13} /> Mark Failed
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {allEvals.length > 0 && (
          <section className="panel">
            <div className="panel-heading">
              <h3>All evaluation accounts</h3>
              <span className="badge muted">{allEvals.length} active</span>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Client</th>
                    <th>CAM</th>
                    <th>Type</th>
                    <th>Pass</th>
                    <th>Daily PnL</th>
                    <th>Weekly PnL</th>
                    <th>Target %</th>
                  </tr>
                </thead>
                <tbody>
                  {allEvals.map((row) => (
                    <tr
                      key={`${row.clientId}-${row.accountName}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        const cam = activeCamProfiles.find((c) =>
                          c.clientIds?.includes(row.clientId),
                        );
                        onOpenCam(cam?.id, row.clientId);
                      }}
                    >
                      <td>
                        <strong>{row.alias}</strong>
                        <small>{row.accountName}</small>
                      </td>
                      <td>{row.clientName}</td>
                      <td>
                        <small>{row.camName}</small>
                      </td>
                      <td>
                        <small>
                          {row.accountType?.replace("Evaluation - ", "")}
                        </small>
                      </td>
                      <td>
                        <small>{row.bulletBotPassType || "—"}</small>
                      </td>
                      <td
                        className={row.dailyPnl >= 0 ? "positive" : "negative"}
                      >
                        {formatCurrency(row.dailyPnl)}
                      </td>
                      <td
                        className={row.weeklyPnl >= 0 ? "positive" : "negative"}
                      >
                        {formatCurrency(row.weeklyPnl)}
                      </td>
                      <td>
                        {row.targetPct !== null ? (
                          <span
                            className={
                              row.targetPct >= 100
                                ? "positive"
                                : row.targetPct >= 70
                                  ? "warning"
                                  : ""
                            }
                          >
                            {row.targetPct}%
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-heading">
            <h3>Recent team history</h3>
            <span className="badge muted">Last 10 trading days</span>
          </div>
          <div className="history-strip">
            {teamHistory.map((day) => (
              <div className="history-day" key={day.date}>
                <span>{day.date.slice(5)}</span>
                <strong className={day.dailyPnl >= 0 ? "positive" : "negative"}>
                  {formatCurrency(day.dailyPnl)}
                </strong>
                <small>
                  {day.accounts} acc · {formatCurrency(day.weeklyPnl)} weekly
                </small>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h3>Strategy Effectiveness Leaderboard</h3>
            <span className="badge muted">
              All history — total P&amp;L, win rate, 7-day trend
            </span>
          </div>
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
                      <td>
                        <strong>{s.name}</strong>
                        <small>
                          {s.clients} client{s.clients !== 1 ? "s" : ""}
                        </small>
                      </td>
                      <td className={s.totalPnl >= 0 ? "positive" : "negative"}>
                        {formatCurrency(s.totalPnl)}
                      </td>
                      <td
                        className={s.avgPerDay >= 0 ? "positive" : "negative"}
                      >
                        {formatCurrency(s.avgPerDay)}
                      </td>
                      <td
                        className={
                          s.winRate >= 60
                            ? "positive"
                            : s.winRate >= 40
                              ? ""
                              : "negative"
                        }
                      >
                        {s.winRate}%
                      </td>
                      <td>{s.days}</td>
                      <td>{s.accounts}</td>
                      <td className={s.last7Pnl >= 0 ? "positive" : "negative"}>
                        {s.last7Pnl >= 0 ? "+" : ""}
                        {formatCurrency(s.last7Pnl)}
                      </td>
                      <td className={s.trend >= 0 ? "positive" : "negative"}>
                        {s.trend >= 0 ? "▲" : "▼"}{" "}
                        {formatCurrency(Math.abs(s.trend))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ padding: "16px" }}>
              No strategy history available yet.
            </p>
          )}
        </section>

        <section className="overview-grid">
          <div className="panel">
            <div className="panel-heading">
              <h3>Latest close snapshot</h3>
              <span className="count">Score 0–10</span>
            </div>
            <div className="strategy-rank-list">
              {strategies.length ? (
                strategies.map((s) => (
                  <div className="rank-row" key={s.name}>
                    <strong>{s.name}</strong>
                    <small>
                      {s.count} instances · {s.accounts} accts
                    </small>
                    <span>{s.score}/10</span>
                    <em className={s.avgDaily >= 0 ? "positive" : "negative"}>
                      {formatCurrency(s.avgDaily)} avg daily
                    </em>
                  </div>
                ))
              ) : (
                <p className="muted">No strategy data in latest closes.</p>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h3>Lifecycle metrics</h3>
              <span className="badge muted">Account history</span>
            </div>
            <div className="lifecycle-grid">
              <div>
                <span>Total evaluations</span>
                <strong>{lifecycle.totalEvals}</strong>
              </div>
              <div>
                <span>Total funded</span>
                <strong>{lifecycle.totalFunded}</strong>
              </div>
              <div>
                <span>Avg days to fail</span>
                <strong>{lifecycle.avgDaysToFail}</strong>
              </div>
              <div>
                <span>Avg days to funded</span>
                <strong>{lifecycle.avgDaysToFunded}</strong>
              </div>
              <div>
                <span>Avg days to payout</span>
                <strong>{lifecycle.avgDaysToPayout}</strong>
              </div>
            </div>
          </div>
        </section>

        {riskDist.total > 0 ? (
          <section
            className={
              riskDist.buckets.Critical.length ? "panel danger-panel" : "panel"
            }
          >
            <div className="panel-heading">
              <h3>Drawdown risk distribution</h3>
              <span className="badge muted">
                {riskDist.total} active accounts
              </span>
            </div>
            <div className="risk-dist-grid">
              {[
                {
                  key: "Critical",
                  color: "var(--error)",
                  label: "Critical (≥85% / ≤$500)",
                },
                {
                  key: "High",
                  color: "var(--warning)",
                  label: "High (65–85% / ≤$1.2k)",
                },
                {
                  key: "Medium",
                  color: "var(--warning)",
                  label: "Medium (40–65% / ≤$2.5k)",
                },
                {
                  key: "Low",
                  color: "var(--success)",
                  label: "Low (<40% / >$2.5k)",
                },
                { key: "Safe", color: "var(--muted)", label: "No DD data" },
              ].map(({ key, color, label }) => {
                const accounts = riskDist.buckets[key];
                const pct =
                  riskDist.total > 0
                    ? (accounts.length / riskDist.total) * 100
                    : 0;
                return (
                  <div className="risk-dist-row" key={key}>
                    <span className="risk-dist-label" style={{ color }}>
                      {label}
                    </span>
                    <div className="risk-dist-bar">
                      <i style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <strong
                      style={{
                        color:
                          accounts.length && key === "Critical"
                            ? color
                            : undefined,
                      }}
                    >
                      {accounts.length}
                    </strong>
                    {accounts.length ? (
                      <span className="risk-dist-names">
                        {accounts
                          .slice(0, 4)
                          .map((a) => `${a.alias} (${a.clientName})`)
                          .join(" · ")}
                        {accounts.length > 4
                          ? ` +${accounts.length - 4} more`
                          : ""}
                      </span>
                    ) : (
                      <span className="risk-dist-names muted">—</span>
                    )}
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
              <span className="badge muted">
                Weekly P&amp;L · sorted best to worst
              </span>
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
                    const camUser = (users || []).find(
                      (u) => u.camProfileId === cam.id,
                    );
                    const lastActive = camUser?.lastActiveAt;
                    const lastActiveLabel = (() => {
                      if (!lastActive) return "—";
                      const mins = Math.round(
                        (Date.now() - new Date(lastActive)) / 60000,
                      );
                      if (mins < 2) return "Just now";
                      if (mins < 60) return `${mins}m ago`;
                      const hrs = Math.round(mins / 60);
                      if (hrs < 24) return `${hrs}h ago`;
                      return `${Math.round(hrs / 24)}d ago`;
                    })();
                    const isRecent =
                      lastActive && Date.now() - new Date(lastActive) < 3600000;
                    return (
                      <tr
                        key={cam.id}
                        className={cam.openFlags >= 3 ? "row-warning" : ""}
                      >
                        <td>
                          <span className="rank-badge">{i + 1}</span>
                        </td>
                        <td>
                          <strong>{cam.name}</strong>
                        </td>
                        <td>{cam.clients}</td>
                        <td>{cam.funded}</td>
                        <td>{cam.evaluations}</td>
                        <td
                          className={
                            cam.dailyPnl >= 0 ? "positive" : "negative"
                          }
                        >
                          {formatCurrency(cam.dailyPnl)}
                        </td>
                        <td
                          className={
                            cam.weeklyPnl >= 0 ? "positive" : "negative"
                          }
                        >
                          {formatCurrency(cam.weeklyPnl)}
                        </td>
                        <td
                          className={
                            cam.monthlyPnl >= 0 ? "positive" : "negative"
                          }
                        >
                          <strong>{formatCurrency(cam.monthlyPnl)}</strong>
                        </td>
                        <td className="positive">
                          {cam.payoutsThisMonthCount > 0 ? (
                            <>
                              <strong>
                                {formatCurrency(cam.payoutsThisMonth)}
                              </strong>
                              <small className="muted">
                                {" "}
                                ×{cam.payoutsThisMonthCount}
                              </small>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className={cam.openFlags >= 3 ? "negative" : ""}>
                          {cam.openFlags}
                        </td>
                        <td>
                          <span
                            className={isRecent ? "positive" : "muted"}
                            style={{ fontSize: 12 }}
                          >
                            {lastActiveLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {clients.length > 0 &&
          (() => {
            const roster = clients
              .map((client) => {
                const cam = activeCamProfiles.find((p) =>
                  (p.clientIds || []).includes(client.id),
                );
                const latest = client.dailyImports?.at(-1);
                const dailyPnl = (latest?.snapshots || []).reduce(
                  (s, sn) => s + Number(sn.grossRealizedPnl || 0),
                  0,
                );
                const funded = Object.values(
                  client.accountRegistry || {},
                ).filter(
                  (a) => a.accountType === "Funded" && a.status !== "Failed",
                ).length;
                return { client, cam, dailyPnl, funded };
              })
              .sort((a, b) =>
                (a.cam?.name || "zzz").localeCompare(b.cam?.name || "zzz"),
              );
            return (
              <section className="panel">
                <div className="panel-heading">
                  <h3>Client roster</h3>
                  <span className="badge muted">
                    {clients.length} clients · drag or reassign CAM
                  </span>
                </div>
                <div className="table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th>CAM</th>
                        <th>Funded</th>
                        <th>Daily P&L</th>
                        <th>Stage</th>
                        <th>Reassign</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roster.map(({ client, cam, dailyPnl, funded }) => (
                        <tr
                          key={client.id}
                          style={{ cursor: "pointer" }}
                          onClick={() => onOpenCam(cam?.id, client.id)}
                        >
                          <td>
                            <strong>{client.name}</strong>
                          </td>
                          <td>
                            <small>
                              {cam?.name || (
                                <span className="negative">Unassigned</span>
                              )}
                            </small>
                          </td>
                          <td>{funded || "—"}</td>
                          <td
                            className={dailyPnl >= 0 ? "positive" : "negative"}
                          >
                            <small>{formatCurrency(dailyPnl)}</small>
                          </td>
                          <td>
                            <small className="muted">
                              {client.profile?.stage || "Active"}
                            </small>
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <select
                              value={cam?.id || ""}
                              style={{ fontSize: 12, padding: "2px 6px" }}
                              onChange={(e) => {
                                const newCamId = e.target.value;
                                if (newCamId === (cam?.id || "")) return;
                                const targetCam = activeCamProfiles.find(
                                  (p) => p.id === newCamId,
                                );
                                const label = targetCam
                                  ? targetCam.name
                                  : "Unassigned";
                                setManagerConfirmAction({
                                  title: `Move ${client.name}?`,
                                  description: `Transfer this client to ${label}.`,
                                  confirmLabel: "Move client",
                                  busyLabel: "Moving...",
                                  onConfirm: () => onTransferClient(client.id, newCamId),
                                });
                              }}
                            >
                              <option value="">— Unassigned —</option>
                              {activeCamProfiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
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
            <input
              type="date"
              value={drillDate}
              onChange={(e) => setDrillDate(e.target.value)}
              style={{
                marginLeft: "auto",
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            />
            {drillDate && (
              <button
                className="ghost-button"
                style={{ fontSize: 11 }}
                onClick={() => setDrillDate("")}
              >
                Clear
              </button>
            )}
          </div>
          {!drillDate && (
            <p className="muted" style={{ fontSize: 12 }}>
              Pick a date to see every client's P&L, accounts, and flags for
              that day.
            </p>
          )}
          {drillDate &&
            (() => {
              const drillRows = clients
                .map((client) => {
                  const imp = (client.dailyImports || []).find(
                    (d) => d.date === drillDate,
                  );
                  if (!imp) return null;
                  const pnl = (imp.snapshots || []).reduce(
                    (s, sn) => s + Number(sn.grossRealizedPnl || 0),
                    0,
                  );
                  const cam = camProfiles.find((p) =>
                    (p.clientIds || []).includes(client.id),
                  );
                  return {
                    client,
                    cam,
                    pnl,
                    accounts: (imp.snapshots || []).length,
                    flags: (imp.flags || []).filter(
                      (f) => f.severity === "Critical",
                    ).length,
                  };
                })
                .filter(Boolean);
              if (!drillRows.length)
                return (
                  <p className="muted" style={{ fontSize: 12 }}>
                    No data uploaded for {drillDate}.
                  </p>
                );
              const total = drillRows.reduce((s, r) => s + r.pnl, 0);
              return (
                <div className="table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th>CAM</th>
                        <th>Accounts</th>
                        <th>Daily P&L</th>
                        <th>Critical flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drillRows
                        .sort((a, b) => b.pnl - a.pnl)
                        .map(({ client, cam, pnl, accounts, flags }) => (
                          <tr
                            key={client.id}
                            style={{ cursor: "pointer" }}
                            onClick={() => onOpenCam(cam?.id, client.id)}
                          >
                            <td>
                              <strong>{client.name}</strong>
                            </td>
                            <td className="muted">{cam?.name || "—"}</td>
                            <td>{accounts}</td>
                            <td className={pnl >= 0 ? "positive" : "negative"}>
                              <strong>
                                {pnl >= 0 ? "+" : ""}
                                {formatCurrency(pnl)}
                              </strong>
                            </td>
                            <td>
                              {flags > 0 ? (
                                <span className="negative">{flags}</span>
                              ) : (
                                <span className="muted">0</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      <tr
                        style={{
                          borderTop: "2px solid var(--line)",
                          fontWeight: 700,
                        }}
                      >
                        <td colSpan={3}>Total — {drillRows.length} clients</td>
                        <td className={total >= 0 ? "positive" : "negative"}>
                          {total >= 0 ? "+" : ""}
                          {formatCurrency(total)}
                        </td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })()}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h3>Exception rules</h3>
            <span className="badge muted">Auto-detected flags</span>
          </div>
          <div className="exception-grid">
            <div className="exception-card critical">
              <strong>Drawdown near limit</strong>
              <span>
                Account has less than $500 remaining before its max drawdown
                limit.
              </span>
              <small>balance_dd_remaining &lt; 500</small>
            </div>
            <div className="exception-card critical">
              <strong>Payout hold violation</strong>
              <span>Account in payout hold still has an enabled strategy.</span>
              <small>
                status = Payout Hold &amp;&amp; enabled_strategies &gt; 0
              </small>
            </div>
            <div className="exception-card warning">
              <strong>Payout eligible</strong>
              <span>
                Funded account balance reached or exceeded target profit and
                payout not yet requested.
              </span>
              <small>
                balance &ge; target_profit &amp;&amp; payout = Not requested
              </small>
            </div>
            <div className="exception-card warning">
              <strong>Drawdown approaching</strong>
              <span>
                Account has less than $1,200 remaining before its max drawdown
                limit.
              </span>
              <small>balance_dd_remaining &lt; 1200</small>
            </div>
            <div className="exception-card warning">
              <strong>Consistency rule risk</strong>
              <span>
                Funded account's best day represents more than 30% of total
                positive P&L — may violate prop firm consistency rule.
              </span>
              <small>best_day_pnl / total_positive_pnl &gt; 0.30</small>
            </div>
          </div>
        </section>

        {(() => {
          const pipeline = buildPayoutPipeline(clients, camProfiles);
          if (!pipeline.length) return null;
          return (
            <section className="panel">
              <div className="panel-heading">
                <h3>Payout pipeline</h3>
                <span className="count">{pipeline.length}</span>
              </div>
              <div className="table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Client</th>
                      <th>CAM</th>
                      <th>State</th>
                      <th>Balance</th>
                      <th>Payouts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.map((row) => (
                      <tr key={`${row.clientId}-${row.accountName}`}>
                        <td>
                          <strong>{row.alias}</strong>
                          <small>{row.accountName}</small>
                        </td>
                        <td
                          style={{ cursor: "pointer" }}
                          onClick={() => {
                            const cam = camProfiles.find((c) =>
                              c.clientIds?.includes(row.clientId),
                            );
                            onOpenCam(cam?.id, row.clientId);
                          }}
                        >
                          {row.clientName}
                        </td>
                        <td>{row.camName}</td>
                        <td>
                          <select
                            value={row.payoutState}
                            style={{ fontSize: 11, padding: "2px 6px" }}
                            onChange={(e) =>
                              onUpdateClientAccount?.(
                                row.clientId,
                                row.accountName,
                                { payoutState: e.target.value },
                              )
                            }
                          >
                            {[
                              "Not requested",
                              "Request payout",
                              "Payout requested",
                              "Payout approved",
                              "Clear to trade",
                            ].map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                          </select>
                        </td>
                        <td className="positive">
                          {formatCurrency(row.balance)}
                        </td>
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
          const allPayouts = clients
            .flatMap((client) => {
              const cam = camProfiles.find((c) =>
                c.clientIds?.includes(client.id),
              );
              return Object.values(client.accountRegistry || {}).flatMap(
                (acct) =>
                  (acct.payoutHistory || []).map((p) => ({
                    ...p,
                    clientName: client.name,
                    accountAlias: acct.alias || acct.accountName,
                    camName: cam?.name || "Unassigned",
                  })),
              );
            })
            .filter((p) => p.date && p.date.startsWith(currentMonth))
            .sort((a, b) => b.date.localeCompare(a.date));

          const allTimePayouts = clients.flatMap((client) =>
            Object.values(client.accountRegistry || {}).flatMap(
              (acct) => acct.payoutHistory || [],
            ),
          );
          const monthTotal = allPayouts.reduce(
            (s, p) => s + Number(p.amount || 0),
            0,
          );
          const allTimeTotal = allTimePayouts.reduce(
            (s, p) => s + Number(p.amount || 0),
            0,
          );
          const allTimeCount = allTimePayouts.length;
          if (!allTimePayouts.length) return null;

          return (
            <section className="panel">
              <div className="panel-heading">
                <h3>Payout history</h3>
                <span className="badge muted">{currentMonth}</span>
                <span className="count">{allPayouts.length} this month</span>
                <span
                  className="metric"
                  style={{ marginLeft: "auto", gap: 16, display: "flex" }}
                >
                  <span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      This month{" "}
                    </span>
                    <strong className="positive">
                      {formatCurrency(monthTotal)}
                    </strong>
                  </span>
                  <span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      All time{" "}
                    </span>
                    <strong className="positive">
                      {formatCurrency(allTimeTotal)}
                    </strong>
                  </span>
                  <span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      Total payouts{" "}
                    </span>
                    <strong>{allTimeCount}</strong>
                  </span>
                </span>
              </div>
              {allPayouts.length ? (
                <div className="table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Client</th>
                        <th>Account</th>
                        <th>CAM</th>
                        <th>Amount</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allPayouts.map((p, i) => (
                        <tr key={i}>
                          <td>
                            <small>{p.date}</small>
                          </td>
                          <td>{p.clientName}</td>
                          <td>
                            <small>{p.accountAlias}</small>
                          </td>
                          <td>
                            <small>{p.camName}</small>
                          </td>
                          <td className="positive">
                            <strong>
                              {formatCurrency(Number(p.amount || 0))}
                            </strong>
                          </td>
                          <td>
                            <small className="muted">{p.notes || "—"}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted" style={{ padding: "8px 0" }}>
                  No payouts recorded for {currentMonth}. Past payouts appear
                  when months change.
                </p>
              )}
            </section>
          );
        })()}

          </>
        )}
      </section>
      <ConfirmActionDialog
        action={managerConfirmAction}
        onCancel={() => setManagerConfirmAction(null)}
        onConfirm={() => {
          managerConfirmAction?.onConfirm?.();
          setManagerConfirmAction(null);
        }}
      />
    </main>
  );
}

function MonthlyReportPanel({ client, month, onClose }) {
  const [copied, setCopied] = useState(false);
  // month = 'YYYY-MM'
  const lastMonthImport = (client?.dailyImports || [])
    .filter((di) => di.date?.startsWith(month))
    .at(-1);
  const registry = mergeRegistryCi(
    lastMonthImport?.accounts,
    client?.accountRegistry,
  );
  const monthImports = (client?.dailyImports || []).filter((di) =>
    di.date?.startsWith(month),
  );
  const allDays = monthImports.map((di) => {
    const pnl = (di.snapshots || []).reduce(
      (s, snap) => s + Number(snap.grossRealizedPnl || 0),
      0,
    );
    return { date: di.date, pnl, status: di.status };
  });
  const totalPnl = allDays.reduce((s, d) => s + d.pnl, 0);
  const positiveDays = allDays.filter((d) => d.pnl > 0);
  const negativeDays = allDays.filter((d) => d.pnl < 0);
  const bestDay = allDays.length
    ? allDays.reduce((b, d) => (d.pnl > b.pnl ? d : b), allDays[0])
    : null;
  const worstDay = allDays.length
    ? allDays.reduce((w, d) => (d.pnl < w.pnl ? d : w), allDays[0])
    : null;

  // Per-account monthly summary
  const accountMap = {};
  for (const di of monthImports) {
    for (const snap of di.snapshots || []) {
      const meta = ciMeta(registry, snap.accountName);
      if (meta.accountType === "Inactive / Ignore") continue;
      if (!accountMap[snap.accountName]) {
        accountMap[snap.accountName] = {
          alias: meta.alias || snap.accountName,
          type: meta.accountType || "",
          pnl: 0,
          days: 0,
          winDays: 0,
        };
      }
      const pnl = Number(snap.grossRealizedPnl || 0);
      accountMap[snap.accountName].pnl += pnl;
      accountMap[snap.accountName].days += 1;
      if (pnl > 0) accountMap[snap.accountName].winDays += 1;
    }
  }
  const accountRows = Object.values(accountMap).sort((a, b) => b.pnl - a.pnl);

  const sign = (n) => (n >= 0 ? "+" : "");
  const monthLabel = new Date(month + "-02").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="report-overlay">
      <div className="report-sheet">
        <div className="report-actions no-print">
          <button className="secondary-button" onClick={() => window.print()}>
            <FileText size={14} /> Print / Save PDF
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              if (!allDays.length) return;
              const fmt = (n) =>
                new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                }).format(Number(n || 0));
              const s = (n) => (n >= 0 ? "+" : "");
              const lines = [
                `📊 *Monthly Report — ${monthLabel}*`,
                `👤 ${client?.name || "Client"}`,
                ``,
                `💰 *Net P&L:* ${s(totalPnl)}${fmt(totalPnl)}`,
                `📅 *Trading days:* ${allDays.length} | ✅ Positive: ${positiveDays.length} | ❌ Negative: ${negativeDays.length}`,
                bestDay
                  ? `📈 *Best day:* ${s(bestDay.pnl)}${fmt(bestDay.pnl)} (${bestDay.date})`
                  : null,
                worstDay && worstDay.date !== bestDay?.date
                  ? `📉 *Worst day:* ${s(worstDay.pnl)}${fmt(worstDay.pnl)} (${worstDay.date})`
                  : null,
                accountRows.length ? `` : null,
                accountRows.length ? `*Account breakdown:*` : null,
                ...accountRows
                  .slice(0, 8)
                  .map(
                    (r) =>
                      `  • ${r.alias}: ${s(r.pnl)}${fmt(r.pnl)} (${r.days}d, ${r.days ? Math.round((r.winDays / r.days) * 100) : 0}% win)`,
                  ),
                ``,
                `_Generated by CAM CRM · Drive Insight_`,
              ].filter((l) => l !== null);
              navigator.clipboard.writeText(lines.join("\n")).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              });
            }}
          >
            <Copy size={14} /> {copied ? "Copied!" : "Copy WhatsApp"}
          </button>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <header className="report-header">
          <div>
            <p className="report-firm">Vincere Trading</p>
            <h1>{client?.name}</h1>
            <span>Monthly performance report · {monthLabel}</span>
          </div>
          <div className="report-header-right">
            <strong className={totalPnl >= 0 ? "positive" : "negative"}>
              {sign(totalPnl)}
              {formatCurrency(totalPnl)}
            </strong>
            <small>net P&amp;L</small>
          </div>
        </header>

        <section className="report-metrics">
          <div>
            <span>Trading days</span>
            <strong>{allDays.length}</strong>
          </div>
          <div>
            <span>Positive days</span>
            <strong className="positive">{positiveDays.length}</strong>
          </div>
          <div>
            <span>Negative days</span>
            <strong className={negativeDays.length ? "negative" : ""}>
              {negativeDays.length}
            </strong>
          </div>
          <div>
            <span>Win rate</span>
            <strong>
              {allDays.length
                ? Math.round((positiveDays.length / allDays.length) * 100)
                : 0}
              %
            </strong>
          </div>
          {bestDay ? (
            <div>
              <span>Best day</span>
              <strong className="positive">
                {sign(bestDay.pnl)}
                {formatCurrency(bestDay.pnl)} <small>({bestDay.date})</small>
              </strong>
            </div>
          ) : null}
          {worstDay ? (
            <div>
              <span>Worst day</span>
              <strong className={worstDay.pnl < 0 ? "negative" : ""}>
                {sign(worstDay.pnl)}
                {formatCurrency(worstDay.pnl)} <small>({worstDay.date})</small>
              </strong>
            </div>
          ) : null}
        </section>

        {accountRows.length > 0 ? (
          <section>
            <h2>Account breakdown</h2>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Monthly P&amp;L</th>
                  <th>Trade days</th>
                  <th>Win rate</th>
                </tr>
              </thead>
              <tbody>
                {accountRows.map((row) => (
                  <tr key={row.alias}>
                    <td>
                      <strong>{row.alias}</strong>
                    </td>
                    <td>{row.type}</td>
                    <td className={row.pnl >= 0 ? "positive" : "negative"}>
                      {sign(row.pnl)}
                      {formatCurrency(row.pnl)}
                    </td>
                    <td>{row.days}</td>
                    <td>
                      {row.days
                        ? Math.round((row.winDays / row.days) * 100)
                        : 0}
                      %
                    </td>
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
              <thead>
                <tr>
                  <th>Date</th>
                  <th>P&amp;L</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {allDays.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className={d.pnl >= 0 ? "positive" : "negative"}>
                      {sign(d.pnl)}
                      {formatCurrency(d.pnl)}
                    </td>
                    <td>{d.status || "—"}</td>
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
  const report = useMemo(() => buildDailyReportSummary(client, dailyImport), [client, dailyImport]);
  const [msgCopied, setMsgCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [reportHistory, setReportHistory] = useState([]);
  const savedReportKeyRef = useRef("");

  const whatsappMessage = useMemo(
    () => buildClientMessageReport(client, dailyImport),
    [client, dailyImport],
  );

  useEffect(() => {
    if (!client?.id || !dailyImport?.id) return;
    const key = `${client.id}:${dailyImport.id}:daily_close`;
    if (savedReportKeyRef.current === key) return;
    savedReportKeyRef.current = key;

    const content = {
      title: `Daily close report - ${client.name || report.clientName} - ${report.date}`,
      reportDate: report.date,
      summary: report,
      message: whatsappMessage,
      source: {
        clientId: client.id,
        clientName: client.name || report.clientName,
        dailyImportId: dailyImport.id,
        dailyImportDate: dailyImport.date,
        status: dailyImport.status,
      },
    };

    setSaveStatus("saving");
    setSaveError("");
    createSupabaseReport(client.id, dailyImport.id, "daily_close", content)
      .then((savedReport) => {
        auditSilently({
          entityType: "report",
          entityId: savedReport?.id || null,
          action: "report.generate",
          afterData: {
            clientId: client.id,
            clientName: client.name || report.clientName,
            dailyImportId: dailyImport.id,
            reportDate: report.date,
            reportType: "daily_close",
          },
        });
        return savedReport;
      })
      .then(() => loadSupabaseReports(client.id, { limit: 5 }))
      .then((history) => {
        setReportHistory(history);
        setSaveStatus("saved");
      })
      .catch((error) => {
        console.error("[CRM] Failed to persist report:", error);
        setSaveError(error.message || "Could not save report history.");
        setSaveStatus("error");
      });
  }, [client, dailyImport, report, whatsappMessage]);

  function copyWhatsApp() {
    navigator.clipboard.writeText(whatsappMessage).then(() => {
      setMsgCopied(true);
      setTimeout(() => setMsgCopied(false), 2500);
    });
  }
  const dailyDelta =
    report.priorDailyPnl !== null
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
      return rawDD <= 0 ? "BREACHED" : `${formatCurrency(rawDD)} buffer`;
    }
    return "—";
  }

  function drawdownTone(row) {
    const ddLimit = Number(row.meta?.maxDrawdownLimit);
    const rawDD = Number(row.trailingMaxDrawdown || 0);
    if (Number.isFinite(ddLimit) && ddLimit > 0) {
      const remaining = ddLimit - Math.abs(rawDD);
      if (remaining <= 500) return "report-dd-critical";
      if (remaining <= 1200) return "report-dd-warning";
    } else if (rawDD !== 0) {
      if (rawDD <= 0) return "report-dd-critical";
      if (rawDD <= 500) return "report-dd-critical";
      if (rawDD <= 1200) return "report-dd-warning";
    }
    return "";
  }

  const GROUP_LABELS = {
    evaluations: "Evaluations",
    funded: "Funded Accounts",
    cash: "Cash Accounts",
  };

  return (
    <div className="report-overlay">
      <div className="report-sheet">
        <div className="report-actions no-print">
          <span className={`remote-pill ${saveStatus === "error" ? "error" : saveStatus === "saved" ? "connected" : ""}`}>
            {saveStatus === "saving"
              ? "Saving report..."
              : saveStatus === "saved"
                ? "Saved to Supabase"
                : saveStatus === "error"
                  ? "Report not saved"
                  : "Report history"}
          </span>
          <button className="secondary-button" onClick={() => window.print()}>
            <FileText size={14} /> Print / Save PDF
          </button>
          <button className="ghost-button" onClick={copyWhatsApp}>
            {msgCopied ? (
              "✓ Copied!"
            ) : (
              <>
                <Smartphone size={14} /> Copy for WhatsApp
              </>
            )}
          </button>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        {saveStatus === "error" ? (
          <div className="notice warning no-print" style={{ marginBottom: 12 }}>
            {saveError}
          </div>
        ) : null}

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
            <strong
              className={
                report.totals.grossRealizedPnl >= 0
                  ? "report-positive"
                  : "report-negative"
              }
            >
              {formatCurrency(report.totals.grossRealizedPnl)}
            </strong>
          </div>
          <div>
            <span>Weekly PnL</span>
            <strong
              className={
                report.totals.weeklyPnl >= 0
                  ? "report-positive"
                  : "report-negative"
              }
            >
              {formatCurrency(report.totals.weeklyPnl)}
            </strong>
          </div>
          {dailyDelta !== null ? (
            <div>
              <span>vs prior close</span>
              <strong
                className={
                  dailyDelta >= 0 ? "report-positive" : "report-negative"
                }
              >
                {dailyDelta >= 0 ? "+" : ""}
                {formatCurrency(dailyDelta)}
              </strong>
            </div>
          ) : null}
        </section>

        {["evaluations", "funded", "cash"].map((group) =>
          report.grouped[group].length ? (
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
                    {group !== "cash" ? <th>Drawdown</th> : null}
                    {group === "cash" ? <th>Balance</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {report.grouped[group].map((row) => {
                    const stratNames =
                      (row.strategies || [])
                        .map(
                          (s) =>
                            `${s.strategyName || s.strategyFamily || "Strategy"}${s.enabled ? "" : " (off)"}`,
                        )
                        .join(", ") || "—";
                    return (
                      <tr key={row.accountName}>
                        <td>
                          <strong>{row.meta?.alias || row.accountName}</strong>
                          <br />
                          <small>
                            {row.meta?.connection || row.connection || ""}
                          </small>
                        </td>
                        <td>{row.meta?.status || "Active"}</td>
                        <td>
                          <small>{stratNames}</small>
                        </td>
                        <td
                          className={
                            row.grossRealizedPnl >= 0
                              ? "report-positive"
                              : "report-negative"
                          }
                        >
                          {formatCurrency(row.grossRealizedPnl)}
                        </td>
                        <td
                          className={
                            row.weeklyPnl >= 0
                              ? "report-positive"
                              : "report-negative"
                          }
                        >
                          {formatCurrency(row.weeklyPnl)}
                        </td>
                        {group !== "cash" ? (
                          <td className={drawdownTone(row)}>
                            {drawdownLabel(row)}
                          </td>
                        ) : null}
                        {group === "cash" ? (
                          <td>{formatCurrency(row.accountBalance)}</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ) : null,
        )}

        <footer className="report-footer">
          <span>
            Generated {new Date(report.generatedAt).toLocaleString("en-US")}
          </span>
          <span>Vincere Trading · Confidential</span>
        </footer>

        {reportHistory.length ? (
          <section className="report-section no-print">
            <h2>Recent Saved Reports</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Saved</th>
                </tr>
              </thead>
              <tbody>
                {reportHistory.map((item) => (
                  <tr key={item.id}>
                    <td>{item.reportDate || item.content?.summary?.date || "—"}</td>
                    <td>{item.reportType === "daily_close" ? "Daily close" : item.reportType}</td>
                    <td>
                      {item.createdAt
                        ? new Date(item.createdAt).toLocaleString("en-US")
                        : "—"}
                    </td>
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

function ClientPnlChart({ history = [] }) {
  const values = history.map((day) => Number(day.dailyPnl || 0));
  if (!values.length)
    return <div className="sparkline-empty">No client history yet</div>;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const spread = max - min || 1;
  const nodes = history.map((day, index) => {
    const value = Number(day.dailyPnl || 0);
    const x = values.length === 1 ? 300 : (index / (values.length - 1)) * 600;
    const y = 150 - ((value - min) / spread) * 120;
    return { ...day, value, x, y };
  });
  const points = nodes.map((node) => `${node.x},${node.y}`).join(" ");
  const zeroY = 150 - ((0 - min) / spread) * 120;
  const areaPoints = `0,150 ${points} 600,150`;
  const netPnl = nodes.reduce((total, node) => total + node.value, 0);
  const bestDay = nodes.reduce(
    (best, node) => (node.value > best.value ? node : best),
    nodes[0],
  );
  const lastDay = nodes[nodes.length - 1];

  return (
    <div className="client-chart">
      <div className="client-chart-summary" aria-label="Client PnL summary">
        <div>
          <span>Net PnL</span>
          <strong className={netPnl >= 0 ? "positive" : "negative"}>
            {formatCurrency(netPnl)}
          </strong>
        </div>
        <div>
          <span>Best day</span>
          <strong className={bestDay.value >= 0 ? "positive" : "negative"}>
            {formatCurrency(bestDay.value)}
          </strong>
        </div>
        <div>
          <span>Last day</span>
          <strong className={lastDay.value >= 0 ? "positive" : "negative"}>
            {formatCurrency(lastDay.value)}
          </strong>
        </div>
      </div>
      <svg
        viewBox="0 0 600 180"
        role="img"
        aria-label="Client daily PnL history"
      >
        <defs>
          <linearGradient id="clientPnlLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--info)" />
            <stop offset="55%" stopColor="var(--primary-action)" />
            <stop offset="100%" stopColor="var(--success)" />
          </linearGradient>
          <linearGradient id="clientPnlArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(var(--info-rgb), 0.22)" />
            <stop offset="100%" stopColor="rgba(var(--info-rgb), 0)" />
          </linearGradient>
        </defs>
        {[30, 70, 110, 150].map((y) => (
          <line
            className="client-chart-guide"
            key={y}
            x1="0"
            x2="600"
            y1={y}
            y2={y}
          />
        ))}
        <polygon className="client-chart-area" points={areaPoints} />
        <line
          className="client-chart-zero"
          x1="0"
          x2="600"
          y1={zeroY}
          y2={zeroY}
        />
        <polyline
          className="client-chart-line"
          points={points}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {nodes.map((node) => (
          <circle
            className={`chart-node chart-node-large ${
              node.value >= 0 ? "chart-node-positive" : "chart-node-negative"
            }`}
            key={node.date}
            cx={node.x}
            cy={node.y}
            r="6"
          >
            <title>{`${node.date} · Daily PnL ${formatCurrency(node.dailyPnl)} · Weekly ${formatCurrency(node.weeklyPnl)} · ${node.accounts} accounts · ${node.flags} flags`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-axis">
        {history.map((day) => (
          <span
            key={day.date}
            className={Number(day.dailyPnl || 0) >= 0 ? "positive" : "negative"}
            title={`${day.date} · ${formatCurrency(day.dailyPnl)}`}
          >
            {day.date.slice(5)}
          </span>
        ))}
      </div>
    </div>
  );
}

function OnboardingChecklist({ client, onSwitchTab }) {
  const profile = client.profile || {};
  const creds = client.credentials || {};
  const registry = client.accountRegistry || {};

  const steps = [
    {
      done: !!(profile.email || profile.phone || profile.fullName),
      label: "Add contact info",
      detail:
        "Name, WhatsApp, email — so you can reach the client from the CRM",
      action: () => onSwitchTab?.("Profile"),
      actionLabel: "Open Profile →",
    },
    {
      done: !!(creds.ip && creds.username),
      label: "Save VPS credentials",
      detail: "IP, username, password — required for daily check-ins",
      action: () => onSwitchTab?.("Credentials & Notes"),
      actionLabel: "Open Credentials →",
    },
    {
      done: Object.keys(registry).length > 0,
      label: "Upload first NT CSV",
      detail:
        "Export from NinjaTrader and drag the file here to populate accounts",
      action: null,
      actionLabel: null,
    },
    {
      done: Object.values(registry).some(
        (m) => m.accountType && m.accountType !== "Unassigned",
      ),
      label: "Classify accounts in registry",
      detail: "Set each account as Funded, Evaluation, Cash, or Inactive",
      action: () => onSwitchTab?.("Account Registry"),
      actionLabel: "Open Registry →",
    },
    {
      done: Object.values(registry).some(
        (m) => m.accountType === "Funded" && m.targetProfit,
      ),
      label: "Set payout target on funded accounts",
      detail:
        "Target profit + max drawdown limit — enables payout alerts and progress tracking",
      action: () => onSwitchTab?.("Account Registry"),
      actionLabel: "Open Registry →",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  return (
    <div className="onboarding-checklist">
      <div className="onboarding-header">
        <strong>New client setup</strong>
        <span className="muted">
          {doneCount}/{steps.length} steps complete
        </span>
        <div className="onboarding-bar-wrap">
          <div
            className="onboarding-bar"
            style={{
              width: `${Math.round((doneCount / steps.length) * 100)}%`,
            }}
          />
        </div>
      </div>
      <div className="onboarding-steps">
        {steps.map((step, i) => (
          <div
            key={i}
            className={`onboarding-step${step.done ? " onboarding-step-done" : ""}`}
          >
            <span className="onboarding-dot">{step.done ? "✓" : i + 1}</span>
            <div className="onboarding-step-body">
              <strong>{step.label}</strong>
              <small className="muted">{step.detail}</small>
            </div>
            {!step.done && step.action && (
              <button
                className="ghost-button"
                style={{ fontSize: 12, whiteSpace: "nowrap" }}
                onClick={step.action}
              >
                {step.actionLabel}
              </button>
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
  const [logAmount, setLogAmount] = useState("");
  const [logDate, setLogDate] = useState(today);
  const [logNote, setLogNote] = useState("");

  function submitPayout(accountName) {
    const amount = Number(logAmount);
    if (!amount || amount <= 0) return;
    onLogPayout?.(accountName, { date: logDate, amount, note: logNote.trim() });
    setLogAccountName(null);
    setLogAmount("");
    setLogDate(today);
    setLogNote("");
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Payout History</h3>
        {grandTotal > 0 && (
          <span className="badge success">
            Total earned: {formatCurrency(grandTotal)}
          </span>
        )}
      </div>
      <div className="payout-history-list">
        {funded.map((m) => {
          const history = m.payoutHistory || [];
          const accountTotal = history.reduce(
            (s, p) => s + Number(p.amount || 0),
            0,
          );
          const isLogging = logAccountName === m.accountName;
          return (
            <div key={m.accountName} className="payout-history-account">
              <div className="payout-account-header">
                <strong>{m.alias || m.accountName}</strong>
                {accountTotal > 0 && (
                  <span className="positive">
                    {formatCurrency(accountTotal)} total · {history.length}{" "}
                    payout{history.length !== 1 ? "s" : ""}
                  </span>
                )}
                {!history.length && m.payoutCount > 0 && (
                  <small className="muted">
                    {m.payoutCount} payout{m.payoutCount !== 1 ? "s" : ""} — no
                    detail
                  </small>
                )}
                {!history.length && !m.payoutCount && (
                  <small className="muted">No payouts yet</small>
                )}
                <button
                  className="ghost-button"
                  style={{ marginLeft: "auto", fontSize: 12 }}
                  onClick={() =>
                    setLogAccountName(isLogging ? null : m.accountName)
                  }
                >
                  {isLogging ? (
                    "Cancel"
                  ) : (
                    <>
                      <SquarePen size={13} /> Log payout
                    </>
                  )}
                </button>
              </div>
              {isLogging && (
                <div className="payout-log-form">
                  <input
                    type="number"
                    placeholder="Amount (e.g. 2500)"
                    value={logAmount}
                    onChange={(e) => setLogAmount(e.target.value)}
                    min="1"
                  />
                  <input
                    type="date"
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                  />
                  <input
                    placeholder="Note (optional)"
                    value={logNote}
                    onChange={(e) => setLogNote(e.target.value)}
                  />
                  <button
                    className="primary-button"
                    onClick={() => submitPayout(m.accountName)}
                  >
                    Save
                  </button>
                </div>
              )}
              {history.length > 0 && (
                <div className="payout-entries">
                  {history.map((p, i) => (
                    <div key={i} className="payout-entry">
                      <span className="payout-date">{p.date}</span>
                      <span className="positive payout-amount">
                        {formatCurrency(p.amount)}
                      </span>
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

function ClientOverview({
  client,
  dailyImport,
  allClients = [],
  onRequestMonthlyReport,
  onLogPayout,
}) {
  const [monthlyExpanded, setMonthlyExpanded] = useState("");
  const overview = buildClientOverview(client, dailyImport);
  const lifetime = buildLifetimeStats(client);
  const maxDistribution = Math.max(
    ...overview.distribution.map((item) => item.count),
    1,
  );
  const disconnectAlerts = buildDisconnectAlerts(client);
  const consistencyWarnings = buildConsistencyWarnings(client);
  const varianceRows = buildPnlVarianceAnalysis(client, allClients);
  const payoutAlerts = buildPayoutAlerts(client, dailyImport);
  const monthlyByAccount = buildMonthlyByAccount(client);
  const latestRegistry = mergeRegistryCi(
    dailyImport?.accounts,
    client?.accountRegistry,
  );

  const profile = client.profile || {};
  const hasContact =
    profile.email ||
    profile.phone ||
    profile.messenger ||
    profile.timezone ||
    profile.propFirm ||
    profile.preferredChannel ||
    profile.country;
  const waLink = profile.phone
    ? `https://wa.me/${profile.phone.replace(/\D/g, "")}`
    : null;

  return (
    <div className="dashboard-stack">
      {hasContact && (
        <section className="contact-card">
          {profile.fullName && (
            <strong className="contact-name">{profile.fullName}</strong>
          )}
          {profile.email && (
            <a href={`mailto:${profile.email}`} className="contact-chip">
              <Mail size={13} />
              {profile.email}
            </a>
          )}
          {profile.phone && (
            <a
              href={waLink || `tel:${profile.phone}`}
              target="_blank"
              rel="noreferrer"
              className="contact-chip"
            >
              {waLink ? <Smartphone size={13} /> : <Phone size={13} />}
              {profile.phone}
            </a>
          )}
          {profile.messenger && (
            <span className="contact-chip">
              <MessageCircle size={13} />
              {profile.messenger}
            </span>
          )}
          {profile.timezone && (
            <span className="contact-chip muted">
              <Clock3 size={13} />
              {profile.timezone}
            </span>
          )}
          {profile.propFirm && (
            <span className="contact-chip muted">
              <Building2 size={13} />
              {profile.propFirm}
            </span>
          )}
          {profile.preferredChannel && (
            <span className="contact-chip muted">
              <MessageCircle size={13} />
              {profile.preferredChannel}
            </span>
          )}
          {profile.country && (
            <span className="contact-chip muted">
              <Globe2 size={13} />
              {profile.country}
            </span>
          )}
          {profile.language && (
            <span className="contact-chip muted">
              <Languages size={13} />
              {{ en: "English", es: "Español" }[profile.language] ||
                profile.language}
            </span>
          )}
          {profile.stage && profile.stage !== "Active" && (
            <span
              className={`client-stage-badge stage-${profile.stage?.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {profile.stage}
            </span>
          )}
        </section>
      )}
      <div className="metric-grid">
        <div className="metric">
          <span>Latest daily PnL</span>
          <strong
            className={overview.metrics.dailyPnl >= 0 ? "positive" : "negative"}
          >
            {formatCurrency(overview.metrics.dailyPnl)}
          </strong>
        </div>
        <div className="metric">
          <span>Change vs prior close</span>
          <strong
            className={
              overview.metrics.dailyDelta >= 0 ? "positive" : "negative"
            }
          >
            {formatCurrency(overview.metrics.dailyDelta)}
          </strong>
        </div>
        <div className="metric">
          <span>Accounts tracked</span>
          <strong>{overview.metrics.accounts}</strong>
        </div>
        <div className="metric">
          <span>Open flags</span>
          <strong>{overview.metrics.openFlags}</strong>
        </div>
        {lifetime && (
          <>
            <div className="metric">
              <span>Lifetime P&L</span>
              <strong
                className={lifetime.totalPnl >= 0 ? "positive" : "negative"}
              >
                {formatCurrency(lifetime.totalPnl)}
              </strong>
            </div>
            <div className="metric">
              <span>Win rate</span>
              <strong
                className={
                  lifetime.winRate >= 60
                    ? "positive"
                    : lifetime.winRate < 40
                      ? "negative"
                      : ""
                }
              >
                {lifetime.winRate}%
              </strong>
            </div>
            <div className="metric">
              <span>Avg day</span>
              <strong
                className={lifetime.avgDay >= 0 ? "positive" : "negative"}
              >
                {formatCurrency(lifetime.avgDay)}
              </strong>
            </div>
            <div className="metric">
              <span>Days traded</span>
              <strong>{lifetime.totalDays}</strong>
            </div>
            <div className="metric">
              <span>Best day</span>
              <strong className="positive">
                {formatCurrency(lifetime.bestDay)}
                <small className="muted"> {lifetime.bestDayDate}</small>
              </strong>
            </div>
            <div className="metric">
              <span>Worst day</span>
              <strong className="negative">
                {formatCurrency(lifetime.worstDay)}
                <small className="muted"> {lifetime.worstDayDate}</small>
              </strong>
            </div>
            <div className="metric">
              <span>Current streak</span>
              <strong className={lifetime.streakType ? "positive" : "negative"}>
                {lifetime.streak}d{" "}
                {lifetime.streakType ? "positive" : "negative"}
              </strong>
            </div>
            {lifetime.daysSinceStart !== null && (
              <div className="metric">
                <span>Days as client</span>
                <strong>
                  {lifetime.daysSinceStart}d
                  {lifetime.startDate ? (
                    <small className="muted"> since {lifetime.startDate}</small>
                  ) : null}
                </strong>
              </div>
            )}
          </>
        )}
      </div>

      <section className="panel client-overview-hero">
        <div>
          <div className="panel-heading">
            <h3>Client performance timeline</h3>
            <span className="badge muted">{overview.metrics.streakLabel}</span>
          </div>
          <ClientPnlChart history={overview.history} />
        </div>
        <div className="client-insight-stack">
          <div>
            <span>Hot algorithms</span>
            <strong className="positive">{overview.metrics.hotCount}</strong>
          </div>
          <div>
            <span>Cold algorithms</span>
            <strong className={overview.metrics.coldCount ? "negative" : ""}>
              {overview.metrics.coldCount}
            </strong>
          </div>
          <div>
            <span>Data tracked</span>
            <strong>Daily PnL · Weekly PnL · Drawdown · Balance</strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>P&amp;L Calendar</h3>
          <span className="badge muted">
            Last 10 weeks — green = profit, red = loss
          </span>
        </div>
        <PnlCalendarHeatmap client={client} />
      </section>

      <section className="overview-grid">
        <div className="panel">
          <div className="panel-heading">
            <h3>Algorithm temperature</h3>
            <span className="badge muted">Last 3 closes</span>
          </div>
          <div className="strategy-rank-list">
            {overview.algorithms.map((algorithm) => (
              <div className="rank-row algorithm-temp-row" key={algorithm.name}>
                <strong>{algorithm.name}</strong>
                <span
                  className={
                    algorithm.recentTotal >= 0 ? "positive" : "negative"
                  }
                >
                  {formatCurrency(algorithm.recentTotal)}
                </span>
                <em
                  className={
                    algorithm.temperature === "Hot"
                      ? "positive"
                      : algorithm.temperature === "Cold"
                        ? "negative"
                        : ""
                  }
                >
                  {algorithm.temperature}
                </em>
              </div>
            ))}
            {!overview.algorithms.length ? (
              <p className="muted">
                No algorithms assigned in this client history.
              </p>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h3>Strategy distribution</h3>
            <span className="badge muted">Latest close</span>
          </div>
          <div className="distribution-list">
            {overview.distribution.map((item) => (
              <div className="distribution-row" key={item.name}>
                <span>{item.name}</span>
                <div>
                  <i
                    style={{
                      width: `${(item.count / maxDistribution) * 100}%`,
                    }}
                  />
                </div>
                <strong>{item.count}</strong>
              </div>
            ))}
            {!overview.distribution.length ? (
              <p className="muted">
                No active strategy distribution for this close.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {disconnectAlerts.length > 0 ? (
        <section className="panel danger-panel">
          <div className="panel-heading">
            <h3>Anomaly detection</h3>
            <span className="count">{disconnectAlerts.length}</span>
          </div>
          <div className="flag-list">
            {disconnectAlerts.map((alert) => (
              <div className="flag critical" key={alert.id}>
                <AlertTriangle size={16} />
                <div>
                  <strong>
                    Possible VPS / algo disconnect — {alert.alias}
                  </strong>
                  <span>{alert.message}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {consistencyWarnings.length > 0 ? (
        <section
          className={
            consistencyWarnings.some((w) => w.severity === "Critical")
              ? "panel danger-panel"
              : "panel"
          }
        >
          <div className="panel-heading">
            <h3>Consistency Rule Risk</h3>
            <span className="count">{consistencyWarnings.length}</span>
            <span className="badge muted">Best day &gt;30% of total gains</span>
          </div>
          <div className="flag-list">
            {consistencyWarnings.map((w) => (
              <div
                className={`flag ${w.severity === "Critical" ? "critical" : "warning"}`}
                key={w.id}
              >
                <AlertTriangle size={16} />
                <div>
                  <strong>
                    {w.alias} — {w.ratio}% concentration risk
                  </strong>
                  <span>
                    Best day ({w.bestDayDate}): {formatCurrency(w.bestDayPnl)} ={" "}
                    {w.ratio}% of {formatCurrency(w.totalPositive)} total gains.
                    {w.severity === "Critical"
                      ? " Likely fails consistency rule. Contact client."
                      : " Monitor — approaching consistency rule limit."}
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
            <span className="badge muted">
              Accounts near or at target — request payout
            </span>
          </div>
          <div className="flag-list">
            {payoutAlerts.map((a) => (
              <div
                key={a.accountName}
                className={`flag-item ${a.ready ? "flag-critical" : "flag-warning"}`}
              >
                <div className="flag-body">
                  <strong>{a.alias}</strong>
                  <span>
                    {a.ready
                      ? `Ready for payout — profit ${formatCurrency(a.profit)} reached target ${formatCurrency(a.target)}`
                      : `Approaching target — ${a.pct}% of ${formatCurrency(a.target)} goal (${formatCurrency(a.profit)} profit)`}
                  </span>
                </div>
                <div className="payout-progress-wrap">
                  <div
                    className="payout-progress-bar"
                    style={{
                      width: `${Math.min(100, a.pct)}%`,
                      background: a.ready ? "var(--success)" : "var(--warning)",
                    }}
                  />
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
            <span className="badge muted">
              Last 7 closes — actual vs expected by strategy
            </span>
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
                    <td>
                      <strong>{row.alias}</strong>
                      <small>{row.accountType}</small>
                    </td>
                    <td>
                      <small className="muted">{row.strategies || "—"}</small>
                    </td>
                    <td
                      className={row.totalActual >= 0 ? "positive" : "negative"}
                    >
                      {formatCurrency(row.totalActual)}
                    </td>
                    <td className="muted">
                      {formatCurrency(row.totalExpected)}
                    </td>
                    <td className={row.variance >= 0 ? "positive" : "negative"}>
                      {row.variance >= 0 ? "+" : ""}
                      {formatCurrency(row.variance)}
                      <small className="muted">
                        {" "}
                        ({row.variancePct >= 0 ? "+" : ""}
                        {row.variancePct}%)
                      </small>
                    </td>
                    <td>
                      <span className={`variance-badge variance-${row.status}`}>
                        {row.status === "good"
                          ? "✓ Good"
                          : row.status === "average"
                            ? "~ Average"
                            : "⚠ Review"}
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
            <button
              className="ghost-button"
              style={{ marginLeft: "auto", fontSize: 12 }}
              onClick={() => onRequestMonthlyReport?.(monthlyExpanded)}
            >
              <FileText size={13} /> Monthly Report
            </button>
          ) : null}
        </div>
        <div className="history-strip">
          {buildMonthlyTotals(client).map((m) => (
            <button
              className={`history-day clickable${monthlyExpanded === m.month ? " active" : ""}`}
              key={m.month}
              onClick={() =>
                setMonthlyExpanded((v) => (v === m.month ? "" : m.month))
              }
            >
              <span>
                {m.month.slice(5)}/{m.month.slice(0, 4)}
              </span>
              <strong className={m.monthlyPnl >= 0 ? "positive" : "negative"}>
                {formatCurrency(m.monthlyPnl)}
              </strong>
              <small>
                {m.closedDays} days · {m.accounts} accts
              </small>
            </button>
          ))}
          {!buildMonthlyTotals(client).length ? (
            <p className="muted">No history yet.</p>
          ) : null}
        </div>
        {monthlyExpanded ? (
          <div className="monthly-account-breakdown">
            <div className="monthly-breakdown-head">
              <span>Account</span>
              <span>Algo Stack</span>
              <span>Monthly P&amp;L</span>
              <span>Days</span>
            </div>
            {(
              monthlyByAccount.find((m) => m.month === monthlyExpanded)
                ?.accounts || []
            ).map((row) => (
              <div className="monthly-breakdown-row" key={row.accountName}>
                <span>{row.alias}</span>
                <small className="muted">{row.strategies || "—"}</small>
                <strong className={row.pnl >= 0 ? "positive" : "negative"}>
                  {formatCurrency(row.pnl)}
                </strong>
                <small>{row.days}d</small>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>Closest to target</h3>
          <span className="badge muted">Evaluation / funded progress</span>
        </div>
        <div className="target-list">
          {overview.passProgress.slice(0, 6).map((account) => {
            const snapshot = (dailyImport?.snapshots || []).find(
              (s) => s.accountName === account.accountName,
            );
            const meta = ciMeta(latestRegistry, account.accountName);
            const risk = accountRiskLevel(snapshot, meta);
            return (
              <div className="target-row" key={account.accountName}>
                <div>
                  <strong>
                    {account.alias}
                    {risk ? (
                      <span
                        className={`risk-badge risk-${risk.level.toLowerCase()}`}
                      >
                        {risk.level} risk
                        {risk.pct != null
                          ? ` · ${Math.round(risk.pct * 100)}% DD used`
                          : ""}
                      </span>
                    ) : null}
                  </strong>
                  <span>
                    {account.accountType} · {formatCurrency(account.balance)}{" "}
                    balance · {formatCurrency(account.remaining)} remaining
                  </span>
                </div>
                <div className="progress-track">
                  <i style={{ width: `${account.progress}%` }} />
                </div>
                <em>{Math.round(account.progress)}%</em>
              </div>
            );
          })}
          {!overview.passProgress.length ? (
            <p className="muted">No target-bearing accounts for this client.</p>
          ) : null}
        </div>
      </section>

      {(() => {
        const registry = client.accountRegistry || {};
        const funded = Object.values(registry).filter(
          (m) => m.accountType === "Funded",
        );
        if (!funded.length) return null;
        const grandTotal = funded.reduce(
          (sum, m) =>
            sum +
            (m.payoutHistory || []).reduce(
              (s, p) => s + Number(p.amount || 0),
              0,
            ),
          0,
        );
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

export function buildPnlCalendar(client) {
  const imports = client.dailyImports || [];
  if (!imports.length) return [];
  const byDate = {};
  for (const di of imports) {
    const pnl = (di.snapshots || []).reduce(
      (s, snap) => s + Number(snap.grossRealizedPnl || 0),
      0,
    );
    byDate[di.date] = { date: di.date, pnl, status: di.status };
  }
  // Build a 12-week window of Mon-Fri only (no weekends)
  const end = new Date();
  const cur = new Date(end);
  // Rewind to most recent Friday or today
  while (cur.getDay() === 0 || cur.getDay() === 6)
    cur.setDate(cur.getDate() - 1);
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
    if (dow >= 1 && dow <= 5) {
      // Mon–Fri only
      const iso = iter.toISOString().slice(0, 10);
      week.push({
        date: iso,
        ...(byDate[iso] || { date: iso, pnl: null, status: null }),
      });
      if (week.length === 5) {
        weeks.push(week);
        week = [];
      }
    }
    iter.setDate(iter.getDate() + 1);
  }
  if (week.length) weeks.push(week);
  return weeks;
}

function PnlCalendarHeatmap({ client }) {
  const weeks = buildPnlCalendar(client);
  if (!weeks.length) return null;
  const allPnls = weeks
    .flat()
    .map((d) => d.pnl)
    .filter((v) => v !== null && v !== 0);
  const maxAbs = Math.max(...allPnls.map(Math.abs), 1);
  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  function cellColor(day) {
    if (day.pnl === null) return "var(--surface-3)";
    if (day.pnl === 0) return "var(--surface-2)";
    const intensity = Math.min(
      0.92,
      0.25 + (Math.abs(day.pnl) / maxAbs) * 0.67,
    );
    return day.pnl > 0
      ? `rgba(var(--success-rgb), ${intensity})`
      : `rgba(var(--error-rgb), ${intensity})`;
  }

  return (
    <div className="pnl-heatmap">
      <div className="pnl-heatmap-day-labels">
        {DAY_LABELS.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="pnl-heatmap-grid">
        {weeks.map((week, wi) => (
          <div className="pnl-heatmap-week" key={wi}>
            {week.map((day) => (
              <div
                key={day.date}
                className="pnl-heatmap-cell"
                style={{ background: cellColor(day) }}
                title={
                  day.pnl !== null
                    ? `${day.date}: ${day.pnl >= 0 ? "+" : ""}${formatCurrency(day.pnl)}`
                    : `${day.date} — no close`
                }
              />
            ))}
          </div>
        ))}
      </div>
      <div className="pnl-heatmap-legend">
        <span className="negative">Loss</span>
        <div className="heatmap-legend-bar">
          <i style={{ background: "rgba(255,90,105,0.85)" }} />
          <i style={{ background: "rgba(255,90,105,0.45)" }} />
          <i style={{ background: "var(--surface-3)" }} />
          <i style={{ background: "rgba(47,202,115,0.45)" }} />
          <i style={{ background: "rgba(47,202,115,0.85)" }} />
        </div>
        <span className="positive">Profit</span>
        <span className="muted" style={{ marginLeft: "8px" }}>
          Mon–Fri only
        </span>
      </div>
    </div>
  );
}

export function searchClients(clients, query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = [];

  for (const client of clients) {
    const matches = [];

    if (client.name.toLowerCase().includes(q)) {
      matches.push({ type: "client", label: client.name });
    }

    if (client.notes?.toLowerCase().includes(q)) {
      const idx = client.notes.toLowerCase().indexOf(q);
      matches.push({
        type: "note",
        label:
          "Notes: …" +
          client.notes.slice(Math.max(0, idx - 20), idx + 60) +
          "…",
      });
    }

    const registry = client.accountRegistry || {};
    for (const meta of Object.values(registry)) {
      if (
        meta.alias?.toLowerCase().includes(q) ||
        meta.accountName?.toLowerCase().includes(q) ||
        meta.connection?.toLowerCase().includes(q)
      ) {
        matches.push({
          type: "account",
          label: `Account: ${meta.alias || meta.accountName}`,
        });
      }
    }

    for (const task of client.tasks || []) {
      if (!task.done && task.text?.toLowerCase().includes(q)) {
        matches.push({
          type: "task",
          label: `Task: ${task.text.slice(0, 70)}${task.text.length > 70 ? "…" : ""}`,
        });
      }
    }

    for (const entry of client.activityLog || []) {
      if (entry.text?.toLowerCase().includes(q)) {
        matches.push({
          type: "activity",
          label: `Log: ${entry.text.slice(0, 70)}${entry.text.length > 70 ? "…" : ""}`,
        });
      }
    }

    if (matches.length) results.push({ client, matches: matches.slice(0, 3) });
  }
  return results;
}

export function buildTodayBriefing(clients) {
  const today = todayIsoDate();
  return clients
    .map((client) => {
      const todayImport = getClientImportByDate(client, today);
      const latest = client.dailyImports?.at(-1) || null;
      const criticalFlags = (latest?.flags || []).filter(
        (f) =>
          f.severity === "Critical" &&
          f.status !== "Resolved" &&
          f.status !== "Acknowledged",
      );
      const openFlags = (latest?.flags || []).filter(
        (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
      );
      const openTasks = (client.tasks || []).filter((t) => !t.done);
      const overdueTasks = openTasks.filter(
        (t) => t.dueDate && t.dueDate < today,
      );
      const highTasks = openTasks.filter((t) => t.priority === "High");
      const payoutAccounts = Object.values(client.accountRegistry || {}).filter(
        (m) => m.payoutState && m.payoutState !== "Not requested",
      );
      const dailyPnl = (latest?.snapshots || []).reduce(
        (s, snap) => s + Number(snap.grossRealizedPnl || 0),
        0,
      );
      const closeStatus = !todayImport
        ? "pending"
        : todayImport.status === "Closed"
          ? "closed"
          : "uploaded";

      const daysSinceContact = lastContactDaysAgo(client);
      const staleContact = daysSinceContact === null || daysSinceContact >= 7;

      const urgency =
        criticalFlags.length > 0
          ? "critical"
          : overdueTasks.length > 0
            ? "warning"
            : highTasks.length > 0 || payoutAccounts.length > 0
              ? "info"
              : staleContact
                ? "info"
                : closeStatus === "pending"
                  ? "pending"
                  : "ok";

      return {
        client,
        criticalFlags,
        openFlags,
        openTasks,
        overdueTasks,
        highTasks,
        payoutAccounts,
        dailyPnl,
        closeStatus,
        urgency,
        staleContact,
        daysSinceContact,
      };
    })
    .sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2, pending: 3, ok: 4 };
      return order[a.urgency] - order[b.urgency];
    });
}

// ── Insight Feed ─────────────────────────────────────────────────────────────
// Aggregates all notable signals across a CAM's portfolio into one prioritized list
export function remainingBuffer(s, m) {
  const ddLimit = Number(m?.maxDrawdownLimit || 0);
  const rawDD = Number(s?.trailingMaxDrawdown || 0);
  return ddLimit > 0 ? ddLimit - Math.abs(rawDD) : rawDD;
}

export function buildPortfolioInsights(clients) {
  const insights = [];
  const today = todayIsoDate();

  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    const snapshots = latest?.snapshots || [];
    const imports = client.dailyImports || [];
    const registryCi = mergeRegistryCi(
      latest?.accounts,
      client.accountRegistry,
    );

    // 1. Drawdown velocity — project breach date from last 7-day buffer consumption
    for (const snap of snapshots) {
      const meta = ciMeta(registryCi, snap.accountName);
      if (meta.accountType !== "Funded") continue;
      if (meta.status === "Failed" || meta.status === "Inactive") continue;

      const buffer = remainingBuffer(snap, meta);
      if (buffer <= 0) continue; // already breached

      // Compute daily buffer change over last 7 imports
      const last7 = imports.slice(-7);
      if (last7.length < 3) continue;
      const buffers = last7
        .map((di) => {
          const s = (di.snapshots || []).find(
            (x) =>
              x.accountName?.toLowerCase() === snap.accountName?.toLowerCase(),
          );
          return s ? remainingBuffer(s, meta) : null;
        })
        .filter((v) => v !== null);

      if (buffers.length < 2) continue;
      const dailyChange = (buffers.at(-1) - buffers[0]) / (buffers.length - 1);
      if (dailyChange >= 0) continue; // buffer growing or stable — no concern
      const daysToBreech = Math.floor(buffer / Math.abs(dailyChange));

      if (daysToBreech <= 5) {
        insights.push({
          severity: daysToBreech <= 2 ? "critical" : "warning",
          type: "Drawdown Velocity",
          clientId: client.id,
          clientName: client.name,
          accountAlias: meta.alias || snap.accountName,
          message: `Buffer ${formatCurrency(buffer)} depleting ~${formatCurrency(Math.abs(dailyChange))}/day — projected breach in ${daysToBreech} trading day${daysToBreech !== 1 ? "s" : ""}`,
          action: "Review stack or reduce position size",
        });
      }
    }

    // 2. Consistency rule — best day > 30% of total positive P&L
    const consistencyWarnings = buildConsistencyWarnings(client);
    for (const w of consistencyWarnings) {
      insights.push({
        severity: w.severity === "Critical" ? "critical" : "warning",
        type: "Consistency Rule",
        clientId: client.id,
        clientName: client.name,
        accountAlias: w.alias,
        message: `Best day (${formatCurrency(w.bestDayPnl)} on ${w.bestDayDate}) is ${w.ratio}% of total gains — consistency rule at risk`,
        action: "Consider reducing position on strong days",
      });
    }

    // 3. Payout opportunity — funded account near target
    if (latest) {
      const payoutAlerts = buildPayoutAlerts(client, latest);
      for (const a of payoutAlerts) {
        insights.push({
          severity: a.ready ? "info-green" : "info",
          type: "Payout Opportunity",
          clientId: client.id,
          clientName: client.name,
          accountAlias: a.alias,
          message: a.ready
            ? `Target reached — ${formatCurrency(a.profit)} profit vs ${formatCurrency(a.target)} goal. Request payout.`
            : `${a.pct}% of payout target — ${formatCurrency(a.target - a.profit)} remaining`,
          action: a.ready ? "Request payout now" : "Monitor until target",
        });
      }
    }

    // 4. Strategy cooling — algo was positive last week, now negative 3+ days
    if (latest) {
      for (const snap of snapshots) {
        const meta = ciMeta(registryCi, snap.accountName);
        if (!["Funded", "Evaluation - Standard"].includes(meta.accountType))
          continue;
        const enabledStrats = (snap.strategies || []).filter((s) => s.enabled);
        if (!enabledStrats.length) continue;
        const recentImports = imports.slice(-10);
        if (recentImports.length < 6) continue;
        const pnls = recentImports
          .map((di) => {
            const s = (di.snapshots || []).find(
              (x) =>
                x.accountName?.toLowerCase() ===
                snap.accountName?.toLowerCase(),
            );
            return s ? Number(s.grossRealizedPnl || 0) : null;
          })
          .filter((v) => v !== null);
        if (pnls.length < 6) continue;
        const prior4 = pnls.slice(0, Math.floor(pnls.length / 2));
        const recent4 = pnls.slice(Math.floor(pnls.length / 2));
        const priorAvg = prior4.reduce((s, v) => s + v, 0) / prior4.length;
        const recentAvg = recent4.reduce((s, v) => s + v, 0) / recent4.length;
        const negativeDays = recent4.filter((v) => v < 0).length;
        if (priorAvg > 50 && recentAvg < 0 && negativeDays >= 3) {
          insights.push({
            severity: "warning",
            type: "Strategy Cooling",
            clientId: client.id,
            clientName: client.name,
            accountAlias: meta.alias || snap.accountName,
            message: `Performance shift: avg was ${formatCurrency(priorAvg)}/day, now ${formatCurrency(recentAvg)}/day (${negativeDays} negative days recently)`,
            action: "Review in Stack Playbook — consider algo change",
          });
        }
      }
    }

    // 5. Account not uploading (no close today or yesterday)
    const todayImport = getClientImportByDate(client, today);
    if (!todayImport) {
      // Skip check on weekends (no trading)
      const todayDow = new Date().getDay();
      if (todayDow !== 0 && todayDow !== 6) {
        const prevTradingDay = new Date();
        // Step back to find last trading day (skip Saturday=6, Sunday=0)
        do {
          prevTradingDay.setDate(prevTradingDay.getDate() - 1);
        } while ([0, 6].includes(prevTradingDay.getDay()));
        const yest = prevTradingDay.toISOString().slice(0, 10);
        const yesterdayImport = getClientImportByDate(client, yest);
        if (!yesterdayImport && imports.length > 0) {
          insights.push({
            severity: "warning",
            type: "Missing Close",
            clientId: client.id,
            clientName: client.name,
            accountAlias: null,
            message: `No daily close uploaded in the last 2 trading days`,
            action: "Check VPS connection and upload NT CSV",
          });
        }
      } // end weekday check
    }
  }

  const order = { critical: 0, warning: 1, "info-green": 2, info: 3 };
  return insights.sort(
    (a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4),
  );
}

function InsightFeedPanel({ insights, onSelectClient }) {
  if (!insights.length) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h3>Insight Feed</h3>
          <span className="badge success">All clear</span>
        </div>
        <p className="muted" style={{ padding: "8px 0" }}>
          No signals across your portfolio right now. Keep uploading daily
          closes for continuous monitoring.
        </p>
      </section>
    );
  }

  const criticalCount = insights.filter(
    (i) => i.severity === "critical",
  ).length;
  const warningCount = insights.filter((i) => i.severity === "warning").length;

  const severityConfig = {
    critical: { label: "Critical", cls: "insight-critical", dot: "var(--error)" },
    warning: { label: "Warning", cls: "insight-warning", dot: "var(--warning)" },
    "info-green": {
      label: "Opportunity",
      cls: "insight-opportunity",
      dot: "var(--success)",
    },
    info: { label: "Info", cls: "insight-info", dot: "var(--info)" },
  };

  return (
    <section className={`panel ${criticalCount ? "danger-panel" : ""}`}>
      <div className="panel-heading">
        <h3>Insight Feed</h3>
        <div style={{ display: "flex", gap: 8 }}>
          {criticalCount ? (
            <span className="badge danger">{criticalCount} critical</span>
          ) : null}
          {warningCount ? (
            <span className="badge warning">{warningCount} warning</span>
          ) : null}
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
                  {item.accountAlias ? (
                    <span className="insight-account">
                      · {item.accountAlias}
                    </span>
                  ) : null}
                </div>
                <p className="insight-message">{item.message}</p>
                <small className="insight-action">→ {item.action}</small>
              </div>
              <span
                className={`insight-severity-badge insight-sev-${item.severity}`}
              >
                {cfg.label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function buildIncomeProjection(clients = []) {
  const rows = [];
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    if (!latest) continue;
    const registry = mergeRegistryCi(latest.accounts, client.accountRegistry);
    for (const snap of latest.snapshots || []) {
      const meta = ciMeta(registry, snap.accountName);
      if (meta.accountType !== "Funded") continue;
      const target = Number(meta.targetProfit || 0);
      const start = Number(meta.startBalance || 0);
      const balance = Number(snap.accountBalance || 0);
      if (!target || !start) continue;
      const profit = balance - start;
      const needed = target - start;
      const pct = needed > 0 ? Math.round((profit / needed) * 100) : 0;
      // velocity from last 7 imports
      const recent = (client.dailyImports || []).slice(-7);
      const pnlHistory = recent
        .map((di) => {
          const s = (di.snapshots || []).find(
            (x) =>
              x.accountName?.toLowerCase() === snap.accountName?.toLowerCase(),
          );
          return s ? Number(s.grossRealizedPnl || 0) : 0;
        })
        .filter((v) => v !== 0);
      const avgDaily = pnlHistory.length
        ? pnlHistory.reduce((s, v) => s + v, 0) / pnlHistory.length
        : 0;
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

function CamOverview({
  clients,
  camProfiles = [],
  allClients = [],
  strategySetRecords = [],
  strategySetIndexStatus,
  onSelectClient,
  onAddClientTask,
  onLogClientActivity,
  onCompleteTask,
  monthlyGoal: monthlyGoalProp = 0,
  onSetMonthlyGoal,
}) {
  const [expandedAlgorithm, setExpandedAlgorithm] = useState("");
  const [showBulkTask, setShowBulkTask] = useState(false);
  const [bulkTaskText, setBulkTaskText] = useState("");
  const [bulkTaskDue, setBulkTaskDue] = useState("");
  const [bulkTaskPriority, setBulkTaskPriority] = useState("Normal");
  const [bulkTaskTargets, setBulkTaskTargets] = useState([]);
  const [quickTaskClientId, setQuickTaskClientId] = useState(null);
  const [quickTaskText, setQuickTaskText] = useState("");
  const [quickTaskDue, setQuickTaskDue] = useState("");
  const [quickTaskPriority, setQuickTaskPriority] = useState("Normal");
  const monthlyGoal = monthlyGoalProp;
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyPnl = clients.reduce(
    (sum, c) =>
      sum +
      (c.dailyImports || [])
        .filter((di) => di.date?.startsWith(currentMonth))
        .reduce(
          (s, di) =>
            s +
            (di.snapshots || []).reduce(
              (ss, sn) => ss + Number(sn.grossRealizedPnl || 0),
              0,
            ),
          0,
        ),
    0,
  );
  const goalPct =
    monthlyGoal > 0
      ? Math.min(100, Math.round((monthlyPnl / monthlyGoal) * 100))
      : null;
  const overview = useMemo(
    () => buildCamOverview(clients, strategySetRecords),
    [clients, strategySetRecords],
  );
  const briefing = useMemo(() => buildTodayBriefing(clients), [clients]);
  const insights = useMemo(
    () => buildPortfolioInsights(clients),
    [clients],
  );
  const incomeProjection = useMemo(
    () => buildIncomeProjection(clients),
    [clients],
  );

  const urgencyCounts = { critical: 0, warning: 0, info: 0, pending: 0, ok: 0 };
  briefing.forEach((b) => {
    urgencyCounts[b.urgency] = (urgencyCounts[b.urgency] || 0) + 1;
  });

  const today = todayIsoDate();
  const closeStats = (() => {
    const withUpload = clients.filter((c) => getClientImportByDate(c, today));
    const closed = withUpload.filter(
      (c) => getClientImportByDate(c, today)?.status === "Closed",
    );
    return {
      total: clients.length,
      withUpload: withUpload.length,
      closed: closed.length,
    };
  })();
  const closePct = closeStats.total
    ? Math.round((closeStats.closed / closeStats.total) * 100)
    : 0;
  const todayPortfolioPnl = clients.reduce((sum, c) => {
    const imp = getClientImportByDate(c, today) || c.dailyImports?.at(-1);
    return (
      sum +
      (imp?.snapshots || []).reduce(
        (s, sn) => s + Number(sn.grossRealizedPnl || 0),
        0,
      )
    );
  }, 0);
  const openTasksToday = clients.reduce(
    (n, c) =>
      n + (c.tasks || []).filter((t) => !t.done && t.dueDate === today).length,
    0,
  );
  const overdueTotal = clients.reduce(
    (n, c) =>
      n +
      (c.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate < today)
        .length,
    0,
  );
  const criticalFlagsOpen = clients.reduce((n, c) => {
    return (
      n +
      (c.dailyImports || []).reduce(
        (m, di) =>
          m +
          (di.flags || []).filter(
            (f) =>
              f.severity === "Critical" &&
              f.status !== "Resolved" &&
              f.status !== "Acknowledged",
          ).length,
        0,
      )
    );
  }, 0);
  const staleContactClients = clients.filter((c) => {
    const d = lastContactDaysAgo(c);
    return d === null || d >= 7;
  }).length;

  return (
    <main className="content">
      <div className="page-header">
        <div>
          <span className="eyebrow">Account manager overview · {today}</span>
          <h1>CAM Overview</h1>
          <div className="occ-status-row" style={{ marginTop: 6 }}>
            <span className="occ-live-dot" />
            <span>
              {closeStats.closed}/{closeStats.total} clients closed today
            </span>
            {closeStats.withUpload > closeStats.closed && (
              <span className="muted">
                · {closeStats.withUpload - closeStats.closed} uploaded, not
                closed
              </span>
            )}
            {closeStats.total > closeStats.withUpload && (
              <span className="negative">
                · {closeStats.total - closeStats.withUpload} no upload
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 8,
              background: "var(--line)",
              borderRadius: 4,
              height: 6,
              width: 220,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${closePct}%`,
                background: closePct === 100 ? "var(--success)" : "var(--accent)",
                transition: "width .4s ease",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
        <div
          className="header-actions"
          style={{ alignSelf: "flex-end", gap: 12 }}
        >
          <div className="metric" style={{ minWidth: 120, textAlign: "right" }}>
            <span>Portfolio P&L today</span>
            <strong
              className={todayPortfolioPnl >= 0 ? "positive" : "negative"}
              style={{ fontSize: 22 }}
            >
              {formatCurrency(todayPortfolioPnl)}
            </strong>
          </div>
          {criticalFlagsOpen > 0 && (
            <div className="metric" style={{ textAlign: "right" }}>
              <span>Critical flags</span>
              <strong className="negative" style={{ fontSize: 20 }}>
                {criticalFlagsOpen}
              </strong>
            </div>
          )}
          {staleContactClients > 0 && (
            <div className="metric" style={{ textAlign: "right" }}>
              <span>No contact 7d+</span>
              <strong className="warning" style={{ fontSize: 20 }}>
                {staleContactClients}
              </strong>
            </div>
          )}
          {(openTasksToday > 0 || overdueTotal > 0) && (
            <div className="metric" style={{ textAlign: "right" }}>
              <span>Tasks</span>
              <strong>
                {overdueTotal > 0 && (
                  <span className="negative">{overdueTotal} overdue </span>
                )}
                {openTasksToday > 0 && <span>{openTasksToday} due today</span>}
              </strong>
            </div>
          )}
          <div className="metric" style={{ minWidth: 160, textAlign: "right" }}>
            <span
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 6,
              }}
            >
              Monthly goal
              <button
                className="ghost-button"
                style={{ fontSize: 10, padding: "1px 5px" }}
                onClick={() => {
                  setGoalDraft(monthlyGoal || "");
                  setEditingGoal(true);
                }}
              >
                Edit
              </button>
            </span>
            {editingGoal ? (
              <form
                style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(goalDraft);
                  onSetMonthlyGoal?.(v);
                  setEditingGoal(false);
                }}
              >
                <input
                  autoFocus
                  type="number"
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  placeholder="e.g. 10000"
                  style={{
                    width: 90,
                    fontSize: 12,
                    padding: "2px 6px",
                    background: "var(--surface-2)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    color: "var(--text)",
                  }}
                />
                <button
                  type="submit"
                  className="primary-button"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                >
                  Set
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  style={{ fontSize: 11 }}
                  onClick={() => setEditingGoal(false)}
                >
                  ✕
                </button>
              </form>
            ) : monthlyGoal > 0 ? (
              <>
                <strong
                  className={monthlyPnl >= monthlyGoal ? "positive" : ""}
                  style={{ fontSize: 16 }}
                >
                  {formatCurrency(monthlyPnl)} / {formatCurrency(monthlyGoal)}
                </strong>
                <div
                  style={{
                    marginTop: 4,
                    background: "var(--line)",
                    borderRadius: 4,
                    height: 5,
                    width: 160,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${goalPct}%`,
                      background:
                        goalPct >= 100 ? "var(--success)" : "var(--accent)",
                      borderRadius: 4,
                      transition: "width .4s",
                    }}
                  />
                </div>
                <small className={goalPct >= 100 ? "positive" : "muted"}>
                  {goalPct}% of goal
                </small>
              </>
            ) : (
              <small className="muted">No goal set</small>
            )}
          </div>
        </div>
      </div>

      <InsightFeedPanel insights={insights} onSelectClient={onSelectClient} />

      {(() => {
        const allOpenTasks = clients
          .flatMap((c) =>
            (c.tasks || [])
              .filter((t) => !t.done)
              .map((t) => ({ ...t, clientName: c.name, clientId: c.id })),
          )
          .sort((a, b) => {
            const scoreA =
              a.dueDate && a.dueDate < today
                ? 0
                : a.priority === "High"
                  ? 1
                  : a.dueDate === today
                    ? 2
                    : 3;
            const scoreB =
              b.dueDate && b.dueDate < today
                ? 0
                : b.priority === "High"
                  ? 1
                  : b.dueDate === today
                    ? 2
                    : 3;
            if (scoreA !== scoreB) return scoreA - scoreB;
            return (a.dueDate || "9").localeCompare(b.dueDate || "9");
          });
        if (!allOpenTasks.length) return null;
        const overdue = allOpenTasks.filter(
          (t) => t.dueDate && t.dueDate < today,
        ).length;
        const dueToday = allOpenTasks.filter((t) => t.dueDate === today).length;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>My open tasks</h3>
              <span className="count">{allOpenTasks.length} open</span>
              {overdue > 0 && (
                <span className="badge danger">{overdue} overdue</span>
              )}
              {dueToday > 0 && (
                <span className="badge warning">{dueToday} due today</span>
              )}
              <button
                className="ghost-button"
                style={{ marginLeft: "auto", fontSize: 12 }}
                onClick={() => {
                  setShowBulkTask((v) => !v);
                  setBulkTaskTargets(clients.map((c) => c.id));
                }}
              >
                + Bulk task
              </button>
            </div>
            {showBulkTask && (
              <form
                className="bulk-task-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!bulkTaskText.trim() || !bulkTaskTargets.length) return;
                  bulkTaskTargets.forEach((clientId) => {
                    onAddClientTask?.(clientId, {
                      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      text: bulkTaskText.trim(),
                      priority: bulkTaskPriority,
                      dueDate: bulkTaskDue || null,
                      done: false,
                      createdAt: new Date().toISOString(),
                    });
                  });
                  setBulkTaskText("");
                  setBulkTaskDue("");
                  setBulkTaskPriority("Normal");
                  setShowBulkTask(false);
                }}
              >
                <strong style={{ fontSize: 13, gridColumn: "1/-1" }}>
                  Add task to multiple clients
                </strong>
                <input
                  autoFocus
                  value={bulkTaskText}
                  onChange={(e) => setBulkTaskText(e.target.value)}
                  placeholder="Task description…"
                  style={{ gridColumn: "1/-1" }}
                />
                <input
                  type="date"
                  value={bulkTaskDue}
                  onChange={(e) => setBulkTaskDue(e.target.value)}
                />
                <select
                  value={bulkTaskPriority}
                  onChange={(e) => setBulkTaskPriority(e.target.value)}
                >
                  <option>Normal</option>
                  <option>High</option>
                  <option>Low</option>
                </select>
                <div
                  style={{
                    gridColumn: "1/-1",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {clients.map((c) => (
                    <label
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={bulkTaskTargets.includes(c.id)}
                        onChange={(ev) =>
                          setBulkTaskTargets((prev) =>
                            ev.target.checked
                              ? [...prev, c.id]
                              : prev.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!bulkTaskText.trim() || !bulkTaskTargets.length}
                >
                  Add to {bulkTaskTargets.length} client
                  {bulkTaskTargets.length !== 1 ? "s" : ""}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setShowBulkTask(false)}
                >
                  Cancel
                </button>
              </form>
            )}
            <div className="task-list">
              {allOpenTasks.slice(0, 20).map((task) => {
                const isOverdue = task.dueDate && task.dueDate < today;
                const isDueToday = task.dueDate === today;
                return (
                  <div
                    key={task.id}
                    className={`task-row${task.priority === "High" ? " task-high" : ""}`}
                  >
                    <div className="task-body" style={{ cursor: "default" }}>
                      <span className="task-text">{task.text}</span>
                      <div className="task-chips">
                        <span
                          className="task-chip"
                          style={{ background: "var(--surface-2)" }}
                        >
                          {task.clientName}
                        </span>
                        {task.priority === "High" && (
                          <span className="task-chip task-chip-high">High</span>
                        )}
                        {isOverdue && (
                          <span className="task-chip task-chip-due negative">
                            {Math.abs(
                              Math.round(
                                (new Date(task.dueDate + "T12:00:00") -
                                  new Date()) /
                                  86400000,
                              ),
                            )}
                            d overdue
                          </span>
                        )}
                        {!isOverdue && isDueToday && (
                          <span className="task-chip task-chip-due negative">
                            Due today
                          </span>
                        )}
                        {!isOverdue && !isDueToday && task.dueDate && (
                          <span className="task-chip task-chip-due muted">
                            Due {task.dueDate}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      className="ghost-button"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() => onSelectClient?.(task.clientId)}
                    >
                      Go →
                    </button>
                  </div>
                );
              })}
              {allOpenTasks.length > 20 && (
                <p className="muted" style={{ padding: "8px 0", fontSize: 12 }}>
                  +{allOpenTasks.length - 20} more — navigate to individual
                  clients to see all.
                </p>
              )}
            </div>
          </section>
        );
      })()}

      {incomeProjection.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h3>Funded account income projection</h3>
            <span className="badge muted">
              {incomeProjection.length} accounts · based on 7-day avg P&L
            </span>
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
                  <tr
                    key={row.alias}
                    style={{ cursor: "pointer" }}
                    onClick={() => onSelectClient?.(row.clientId)}
                  >
                    <td>
                      <strong>{row.alias}</strong>
                    </td>
                    <td>{row.clientName}</td>
                    <td>
                      <div
                        className="target-progress"
                        style={{ minWidth: 100 }}
                      >
                        <div className="target-bar">
                          <i
                            style={{
                              width: `${row.pct}%`,
                              background: row.ready
                                ? "var(--success)"
                                : row.pct >= 80
                                  ? "var(--warning)"
                                  : "var(--accent)",
                            }}
                          />
                        </div>
                        <small className={row.ready ? "positive" : ""}>
                          {row.ready ? "✓ Ready" : `${row.pct}%`}
                        </small>
                      </div>
                    </td>
                    <td className={row.profit >= 0 ? "positive" : "negative"}>
                      {formatCurrency(row.profit)}
                    </td>
                    <td className="muted">
                      {formatCurrency(Math.max(0, row.needed - row.profit))}
                    </td>
                    <td className={row.avgDaily >= 0 ? "positive" : "negative"}>
                      {formatCurrency(row.avgDaily)}/day
                    </td>
                    <td>
                      {row.ready ? (
                        <span className="badge success">Payout eligible</span>
                      ) : row.daysLeft !== null && row.daysLeft > 0 ? (
                        <span className={row.daysLeft <= 14 ? "positive" : ""}>
                          {row.daysLeft}d (~{Math.ceil(row.daysLeft / 5)} weeks)
                        </span>
                      ) : row.avgDaily <= 0 ? (
                        <span className="negative">Trending down</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {clients.length > 0 ? (
        <section
          className={urgencyCounts.critical ? "panel danger-panel" : "panel"}
        >
          <div className="panel-heading">
            <h3>Today's briefing</h3>
            <div style={{ display: "flex", gap: 8 }}>
              {urgencyCounts.critical ? (
                <span className="badge danger">
                  {urgencyCounts.critical} critical
                </span>
              ) : null}
              {urgencyCounts.warning ? (
                <span className="badge warning">
                  {urgencyCounts.warning} overdue
                </span>
              ) : null}
              {urgencyCounts.pending ? (
                <span className="badge muted">
                  {urgencyCounts.pending} not uploaded
                </span>
              ) : null}
              {!urgencyCounts.critical && !urgencyCounts.warning ? (
                <span className="badge success">All clear</span>
              ) : null}
            </div>
          </div>
          <div className="briefing-grid">
            {briefing.map(
              ({
                client,
                criticalFlags,
                openFlags,
                openTasks,
                overdueTasks,
                highTasks,
                payoutAccounts,
                dailyPnl,
                closeStatus,
                urgency,
                staleContact,
                daysSinceContact,
              }) => {
                const nextTask =
                  overdueTasks[0] || highTasks[0] || openTasks[0] || null;
                const nextFlag = criticalFlags[0] || null;
                const isQT = quickTaskClientId === client.id;
                return (
                  <div
                    key={client.id}
                    className={`briefing-card briefing-${urgency}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      if (!isQT) onSelectClient && onSelectClient(client.id);
                    }}
                  >
                    <div className="briefing-card-head">
                      <strong>{client.name}</strong>
                      <span
                        className={`briefing-dot briefing-dot-${closeStatus}`}
                        title={
                          closeStatus === "pending"
                            ? "No files today"
                            : closeStatus === "closed"
                              ? "Closed"
                              : "Uploaded"
                        }
                      />
                    </div>
                    <em className={dailyPnl >= 0 ? "positive" : "negative"}>
                      {formatCurrency(dailyPnl)} today
                    </em>
                    <div className="briefing-chips">
                      {criticalFlags.length ? (
                        <span className="task-chip task-chip-high">
                          {criticalFlags.length} critical
                        </span>
                      ) : null}
                      {openFlags.length && !criticalFlags.length ? (
                        <span className="task-chip">
                          {openFlags.length} flags
                        </span>
                      ) : null}
                      {overdueTasks.length ? (
                        <span className="task-chip task-chip-high">
                          {overdueTasks.length} overdue
                        </span>
                      ) : null}
                      {highTasks.length && !overdueTasks.length ? (
                        <span className="task-chip task-chip-due warning">
                          {highTasks.length} high tasks
                        </span>
                      ) : null}
                      {payoutAccounts.length ? (
                        <span className="task-chip">
                          {payoutAccounts.length} payout
                        </span>
                      ) : null}
                      {openTasks.length ? (
                        <span className="task-chip">
                          {openTasks.length} tasks
                        </span>
                      ) : null}
                      {staleContact ? (
                        <span
                          className="task-chip task-chip-due warning"
                          title={
                            daysSinceContact === null
                              ? "No contact logged"
                              : `Last contact ${daysSinceContact}d ago`
                          }
                        >
                          {daysSinceContact === null
                            ? "No contact"
                            : `${daysSinceContact}d silent`}
                        </span>
                      ) : null}
                      {!criticalFlags.length &&
                      !openFlags.length &&
                      !overdueTasks.length &&
                      !highTasks.length &&
                      !payoutAccounts.length &&
                      !openTasks.length &&
                      !staleContact ? (
                        <span
                          className="task-chip"
                          style={{ color: "var(--success)" }}
                        >
                          Clean
                        </span>
                      ) : null}
                    </div>
                    {nextFlag || nextTask ? (
                      <p className="briefing-next-action">
                        {nextFlag
                          ? `⚠ ${nextFlag.type}: ${nextFlag.message.slice(0, 80)}${nextFlag.message.length > 80 ? "…" : ""}`
                          : null}
                        {!nextFlag && nextTask
                          ? `→ ${nextTask.text.slice(0, 80)}${nextTask.text.length > 80 ? "…" : ""}`
                          : null}
                      </p>
                    ) : null}
                    {isQT ? (
                      <form
                        className="quick-task-inline"
                        onClick={(e) => e.stopPropagation()}
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!quickTaskText.trim()) return;
                          onAddClientTask?.(client.id, {
                            id: `task-${Date.now()}`,
                            text: quickTaskText.trim(),
                            priority: quickTaskPriority,
                            dueDate: quickTaskDue || null,
                            done: false,
                            createdAt: new Date().toISOString(),
                          });
                          setQuickTaskText("");
                          setQuickTaskDue("");
                          setQuickTaskPriority("Normal");
                          setQuickTaskClientId(null);
                        }}
                      >
                        <input
                          autoFocus
                          value={quickTaskText}
                          onChange={(e) => setQuickTaskText(e.target.value)}
                          placeholder="Task description…"
                          style={{ flex: 1 }}
                        />
                        <input
                          type="date"
                          value={quickTaskDue}
                          onChange={(e) => setQuickTaskDue(e.target.value)}
                          style={{ width: 120 }}
                        />
                        <select
                          value={quickTaskPriority}
                          onChange={(e) => setQuickTaskPriority(e.target.value)}
                          style={{ width: 80 }}
                        >
                          <option>Normal</option>
                          <option>High</option>
                          <option>Low</option>
                        </select>
                        <button
                          type="submit"
                          className="primary-button"
                          style={{ padding: "4px 10px" }}
                        >
                          Add
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => {
                            setQuickTaskClientId(null);
                            setQuickTaskText("");
                          }}
                        >
                          ✕
                        </button>
                      </form>
                    ) : (
                      <div
                        style={{ display: "flex", gap: 4, marginTop: 4 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="ghost-button"
                          style={{ fontSize: 11 }}
                          onClick={() => {
                            setQuickTaskClientId(client.id);
                            setQuickTaskText("");
                          }}
                        >
                          + Task
                        </button>
                        <button
                          className="ghost-button"
                          style={{ fontSize: 11 }}
                          title="Log a contact entry in the activity log"
                          onClick={() => {
                            onLogClientActivity?.(client.id, {
                              id: `act-${Date.now()}-contact`,
                              type: "Call",
                              text: "Client contacted.",
                              accountName: "",
                              createdAt: new Date().toISOString(),
                            });
                          }}
                        >
                          <Phone size={13} /> Contacted
                        </button>
                      </div>
                    )}
                  </div>
                );
              },
            )}
          </div>
        </section>
      ) : null}

      {(() => {
        const today = todayIsoDate();
        const allTasks = clients.flatMap((client) =>
          (client.tasks || [])
            .filter((t) => !t.done)
            .map((t) => ({
              ...t,
              clientName: client.name,
              clientId: client.id,
            })),
        );
        const sorted = allTasks.sort((a, b) => {
          const overA = a.dueDate && a.dueDate < today;
          const overB = b.dueDate && b.dueDate < today;
          if (overA && !overB) return -1;
          if (!overA && overB) return 1;
          const prioOrder = { High: 0, Normal: 1, Low: 2 };
          if ((prioOrder[a.priority] ?? 1) !== (prioOrder[b.priority] ?? 1))
            return (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1);
          if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          return 0;
        });
        if (!sorted.length) return null;
        const overdueCount = sorted.filter(
          (t) => t.dueDate && t.dueDate < today,
        ).length;
        return (
          <section className={overdueCount ? "panel danger-panel" : "panel"}>
            <div className="panel-heading">
              <h3>My task inbox</h3>
              <div style={{ display: "flex", gap: 8 }}>
                {overdueCount ? (
                  <span className="badge danger">{overdueCount} overdue</span>
                ) : null}
                <span className="badge muted">{sorted.length} open</span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th></th>
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
                        className={isOverdue ? "row-warning" : ""}
                      >
                        <td style={{ width: 28 }}>
                          <button
                            className="ghost-button"
                            style={{
                              padding: "2px 4px",
                              fontSize: 14,
                              lineHeight: 1,
                            }}
                            title="Mark done"
                            onClick={() =>
                              onCompleteTask?.(task.clientId, task.id)
                            }
                          >
                            ☐
                          </button>
                        </td>
                        <td
                          style={{
                            maxWidth: 260,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            onSelectClient && onSelectClient(task.clientId)
                          }
                          title={`Open ${task.clientName} → Tasks`}
                        >
                          {task.text}
                        </td>
                        <td>
                          <strong
                            style={{ cursor: "pointer" }}
                            onClick={() =>
                              onSelectClient && onSelectClient(task.clientId)
                            }
                          >
                            {task.clientName}
                          </strong>
                        </td>
                        <td>
                          <span
                            className={
                              task.priority === "High"
                                ? "task-chip task-chip-high"
                                : "task-chip"
                            }
                          >
                            {task.priority}
                          </span>
                        </td>
                        <td
                          className={
                            isOverdue ? "negative" : isToday ? "warning" : ""
                          }
                        >
                          {task.dueDate
                            ? isOverdue
                              ? `OVERDUE (${task.dueDate})`
                              : isToday
                                ? "Today"
                                : task.dueDate
                            : "—"}
                        </td>
                        <td>
                          <small>{task.accountName || "—"}</small>
                        </td>
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
        <div className="metric">
          <span>Clients</span>
          <strong>{clients.length}</strong>
        </div>
        <div className="metric">
          <span>Algorithms</span>
          <strong>{overview.totals.algorithms}</strong>
        </div>
        <div className="metric">
          <span>Accounts running</span>
          <strong>{overview.totals.accounts}</strong>
        </div>
        <div className="metric">
          <span>Deviation alerts</span>
          <strong>{overview.totals.openDeviationFlags}</strong>
        </div>
      </div>

      <section className="panel compact-panel">
        <div className="panel-heading">
          <h3>XML strategy index</h3>
          <span
            className={
              strategySetRecords.length ? "badge success" : "badge muted"
            }
          >
            {strategySetRecords.length
              ? `${strategySetRecords.length} set files`
              : strategySetIndexStatus}
          </span>
        </div>
        <p className="muted">
          Risk, period, pass type, and set version are matched locally from the
          generated XML index when signatures are unique.
        </p>
      </section>

      <section
        className={
          overview.deviationFlags.length ? "panel danger-panel" : "panel"
        }
      >
        <div className="panel-heading">
          <h3>Deviation alerts</h3>
          <span className="count">{overview.deviationFlags.length}</span>
        </div>
        {overview.deviationFlags.length ? (
          <div className="flag-list">
            {overview.deviationFlags.map((flag) => (
              <div className="flag warning" key={flag.id}>
                <AlertTriangle size={16} />
                <div>
                  <strong>{flag.algorithm}</strong>
                  <span>
                    {flag.message} Daily realized:{" "}
                    {formatCurrency(flag.realized)}.
                    {flag.executionMove !== undefined
                      ? ` Execution move: ${flag.executionMove > 0 ? "+" : ""}${flag.executionMove.toFixed(2)} vs peer direction ${flag.peerDirection}.`
                      : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="notice success">
            <CheckCircle2 size={16} /> No cross-account deviation alerts.
          </div>
        )}
      </section>

      {(() => {
        const fundedRows = clients.flatMap((client) => {
          const latestImport = client.dailyImports?.at(-1);
          return Object.values(client.accountRegistry || {})
            .filter(
              (a) =>
                a.accountType === "Funded" &&
                a.status !== "Failed" &&
                a.status !== "Ignore",
            )
            .map((a) => {
              const snap = (latestImport?.snapshots || []).find(
                (s) => s.accountName === a.accountName,
              );
              const todayPnl = snap
                ? (latestImport?.snapshots || [])
                    .filter((s) => s.accountName === a.accountName)
                    .reduce((t, s) => t + Number(s.grossRealizedPnl || 0), 0)
                : null;
              const rawDD = snap
                ? Number(snap.dailyNetPnl ?? snap.netPnl ?? 0)
                : null;
              const ddLimit = Number(a.maxDrawdownLimit || 0);
              const buffer =
                ddLimit > 0 && rawDD !== null
                  ? ddLimit - Math.abs(Math.min(0, rawDD))
                  : null;
              const bufferPct =
                buffer !== null && ddLimit > 0
                  ? Math.round((buffer / ddLimit) * 100)
                  : null;
              const target = Number(a.targetProfit || 0);
              const weeklyPnl = snap ? Number(snap.weeklyPnl || 0) : null;
              const pct =
                target > 0 && weeklyPnl !== null
                  ? Math.min(100, Math.round((weeklyPnl / target) * 100))
                  : null;
              return {
                client,
                account: a,
                todayPnl,
                buffer,
                bufferPct,
                pct,
                weeklyPnl,
                target,
              };
            });
        });
        if (!fundedRows.length) return null;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>Funded accounts</h3>
              <span className="count">{fundedRows.length}</span>
            </div>
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Client</th>
                    <th>Today P&L</th>
                    <th>DD Buffer</th>
                    <th>Target %</th>
                    <th>Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {fundedRows
                    .sort((a, b) => (a.bufferPct ?? 999) - (b.bufferPct ?? 999))
                    .map(
                      ({
                        client,
                        account,
                        todayPnl,
                        buffer,
                        bufferPct,
                        pct,
                      }) => (
                        <tr
                          key={account.accountName}
                          style={{ cursor: "pointer" }}
                          onClick={() => onSelectClient?.(client.id)}
                        >
                          <td>
                            <strong>
                              {account.alias || account.accountName}
                            </strong>
                            <small className="muted">
                              {account.accountName}
                            </small>
                          </td>
                          <td>{client.name}</td>
                          <td
                            className={
                              todayPnl === null
                                ? "muted"
                                : todayPnl >= 0
                                  ? "positive"
                                  : "negative"
                            }
                          >
                            {todayPnl === null
                              ? "—"
                              : (todayPnl >= 0 ? "+" : "") +
                                formatCurrency(todayPnl)}
                          </td>
                          <td>
                            {buffer === null ? (
                              <span className="muted">—</span>
                            ) : (
                              <span
                                className={
                                  bufferPct <= 20
                                    ? "negative"
                                    : bufferPct <= 40
                                      ? "warning"
                                      : "positive"
                                }
                              >
                                {formatCurrency(buffer)}{" "}
                                <small className="muted">({bufferPct}%)</small>
                              </span>
                            )}
                          </td>
                          <td>
                            {pct === null ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className={pct >= 100 ? "positive" : ""}>
                                {pct}%
                              </span>
                            )}
                          </td>
                          <td>
                            <span className="muted" style={{ fontSize: 11 }}>
                              {account.payoutState || "—"}
                            </span>
                          </td>
                        </tr>
                      ),
                    )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      <section className="panel">
        <div className="panel-heading">
          <h3>Algorithm rollup</h3>
          <span className="count">{overview.algorithms.length}</span>
        </div>
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
                      onClick={() =>
                        setExpandedAlgorithm((current) =>
                          current === algorithm.key ? "" : algorithm.key,
                        )
                      }
                    >
                      <td>
                        <strong>
                          <ChevronDown
                            className={
                              expandedAlgorithm === algorithm.key
                                ? "chevron open"
                                : "chevron"
                            }
                            size={14}
                          />{" "}
                          {algorithm.algorithm}
                        </strong>
                      </td>
                      <td>{algorithm.version || "Custom"}</td>
                      <td>{algorithm.accounts}</td>
                      <td>{algorithm.instances}</td>
                      <td
                        className={
                          algorithm.avgRealized >= 0 ? "positive" : "negative"
                        }
                      >
                        {formatCurrency(algorithm.avgRealized)}
                      </td>
                      <td
                        className={
                          algorithm.avgAccountWeeklyPnl >= 0
                            ? "positive"
                            : "negative"
                        }
                      >
                        {formatCurrency(algorithm.avgAccountWeeklyPnl)}
                      </td>
                      <td
                        className={
                          algorithm.totalRealized >= 0 ? "positive" : "negative"
                        }
                      >
                        {formatCurrency(algorithm.totalRealized)}
                      </td>
                    </tr>
                    {expandedAlgorithm === algorithm.key ? (
                      <tr className="account-detail-row">
                        <td colSpan="7">
                          <div className="cam-instance-list">
                            {algorithm.items.map((item) => (
                              <div
                                className="cam-instance"
                                key={`${item.clientId}-${item.accountName}-${item.strategyName}`}
                              >
                                <strong>
                                  {item.clientName} · {item.accountAlias}
                                </strong>
                                <span>
                                  {item.strategyName || algorithm.algorithm} ·{" "}
                                  {item.enabled ? "Enabled" : "Disabled"}
                                </span>
                                {item.configMatch?.matched ? (
                                  <span>
                                    {[
                                      item.configMatch.risk,
                                      item.configMatch.setVersion,
                                      item.configMatch.period
                                        ? `Period ${item.configMatch.period}`
                                        : "",
                                      item.configMatch.passType,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </span>
                                ) : (
                                  <span>
                                    {item.configMatch?.reason ||
                                      "XML config unknown"}
                                  </span>
                                )}
                                <span
                                  className={
                                    item.realized >= 0 ? "positive" : "negative"
                                  }
                                >
                                  Daily realized {formatCurrency(item.realized)}
                                </span>
                                <span
                                  className={
                                    item.accountWeeklyPnl >= 0
                                      ? "positive"
                                      : "negative"
                                  }
                                >
                                  Account weekly{" "}
                                  {formatCurrency(item.accountWeeklyPnl)}
                                </span>
                                <MovementSparkline
                                  points={item.executionPoints || []}
                                />
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
            <p>
              Upload daily files for at least one client to populate this
              overview.
            </p>
          </div>
        )}
      </section>

      {(() => {
        const allEntries = clients
          .flatMap((c) =>
            (c.activityLog || []).map((e) => ({
              ...e,
              clientName: c.name,
              clientId: c.id,
            })),
          )
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .slice(0, 20);
        if (!allEntries.length) return null;
        return (
          <section className="panel">
            <div className="panel-heading">
              <h3>Recent activity</h3>
              <span className="badge muted">
                Last 20 entries across all clients
              </span>
            </div>
            <div className="activity-feed-global">
              {allEntries.map((entry, i) => (
                <div
                  key={entry.id || i}
                  className="activity-feed-row"
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectClient?.(entry.clientId)}
                >
                  <span className="activity-feed-client">
                    {entry.clientName}
                  </span>
                  <span className="activity-feed-type muted">{entry.type}</span>
                  <span className="activity-feed-text">{entry.text}</span>
                  <span className="activity-feed-date muted">
                    {entry.createdAt
                      ? new Date(entry.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {camProfiles.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <h3>Team overview</h3>
            <span className="badge muted">All CAMs</span>
          </div>
          <div className="team-grid">
            {camProfiles.map((cam) => {
              const camClients = allClients.filter((c) =>
                cam.clientIds?.includes(c.id),
              );
              const summary = buildManagerSummary(camClients);
              return (
                <div className="team-card" key={cam.id}>
                  <strong>{cam.name}</strong>
                  <span>
                    {cam.role || "CAM"} · {cam.status || "Active"}
                  </span>
                  <small>
                    {summary.clients} clients · {summary.accounts} accounts ·{" "}
                    {summary.openFlags} flags
                  </small>
                  <em
                    className={summary.weeklyPnl >= 0 ? "positive" : "negative"}
                  >
                    {formatCurrency(summary.weeklyPnl)} weekly
                  </em>
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
    .filter(
      (point) => Number.isFinite(point.priceValue) && point.priceValue > 0,
    );
  if (!nodes.length)
    return (
      <small className="muted">No execution movement for this strategy.</small>
    );
  const min = Math.min(...nodes.map((point) => point.priceValue));
  const max = Math.max(...nodes.map((point) => point.priceValue));
  const spread = max - min || 1;
  const chartNodes = nodes.map((point, index) => {
    const x = nodes.length === 1 ? 100 : (index / (nodes.length - 1)) * 180;
    const y = 42 - ((point.priceValue - min) / spread) * 34;
    return { ...point, x, y };
  });
  const polyline = chartNodes.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div className="movement-card">
      <svg
        viewBox="0 0 180 50"
        role="img"
        aria-label="Strategy execution price movement"
      >
        <polyline
          points={polyline}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {chartNodes.map((point, index) => (
          <circle
            className="chart-node"
            key={`${point.time}-${point.priceValue}-${index}`}
            cx={point.x}
            cy={point.y}
            r="4"
          >
            <title>{`${point.time || "Execution"} · ${point.action || "Trade"} ${point.quantity || 0} @ ${point.priceValue.toLocaleString("en-US")} · ${point.entryExit || "-"}`}</title>
          </circle>
        ))}
      </svg>
      <small>
        {nodes.length} executions ·{" "}
        {nodes[0].priceValue.toLocaleString("en-US")} →{" "}
        {nodes.at(-1).priceValue.toLocaleString("en-US")}
      </small>
    </div>
  );
}

const ACTIVITY_TYPES = [
  "Note",
  "Call",
  "Message",
  "Disconnection",
  "Payout",
  "Alert",
  "Email",
  "Other",
];

function ActivityLog({ client, onAddEntry, onDeleteEntry }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("Note");
  const [accountName, setAccountName] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
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
    setText("");
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return (
        d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }) +
        " · " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      );
    } catch {
      return iso;
    }
  }

  const filtered = log
    .filter((entry) => {
      if (filterType !== "All" && entry.type !== filterType) return false;
      if (
        filterSearch &&
        !entry.text?.toLowerCase().includes(filterSearch.toLowerCase()) &&
        !entry.accountName?.toLowerCase().includes(filterSearch.toLowerCase())
      )
        return false;
      const entryDate = entry.createdAt?.slice(0, 10) || "";
      if (filterFrom && entryDate < filterFrom) return false;
      if (filterTo && entryDate > filterTo) return false;
      return true;
    })
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Activity log</h3>
        <span className="count">{log.length}</span>
        {log.length > 0 && (
          <button
            className="ghost-button"
            style={{ fontSize: 11, marginLeft: "auto" }}
            onClick={() => {
              const csvCell = (v) =>
                `"${String(v || "")
                  .replace(/"/g, '""')
                  .replace(/\r?\n/g, " ")}"`;
              const rows = [
                ["Date", "Type", "Account", "Text"].map(csvCell).join(","),
              ];
              [...log]
                .sort((a, b) =>
                  (b.createdAt || "").localeCompare(a.createdAt || ""),
                )
                .forEach((e) => {
                  const acct = Object.values(client.accountRegistry || {}).find(
                    (a) => a.accountName === e.accountName,
                  );
                  rows.push(
                    [
                      (e.createdAt || "").slice(0, 16).replace("T", " "),
                      e.type || "Note",
                      acct?.alias || e.accountName || "",
                      e.text || "",
                    ]
                      .map(csvCell)
                      .join(","),
                  );
                });
              const csv = rows.join("\n");
              const a = document.createElement("a");
              a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
              a.download = `activity-${client.name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
              a.click();
            }}
          >
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>
      <form className="activity-form" onSubmit={submit}>
        <div className="activity-form-row">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.accountName} value={a.accountName}>
                {a.alias || a.accountName}
              </option>
            ))}
          </select>
          <button className="primary-button">
            <SquarePen size={14} /> Add Log
          </button>
        </div>
        <textarea
          value={text}
          placeholder="What happened? (call outcome, action taken, client feedback...)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit(e);
            }
          }}
          rows={3}
        />
      </form>
      {log.length > 0 ? (
        <div className="activity-filter-row">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="All">All types</option>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input
            className="activity-search"
            value={filterSearch}
            placeholder="Search log..."
            onChange={(e) => setFilterSearch(e.target.value)}
          />
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            title="From date"
            style={{ width: 130, fontSize: 12 }}
          />
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            title="To date"
            style={{ width: 130, fontSize: 12 }}
          />
          {filterType !== "All" || filterSearch || filterFrom || filterTo ? (
            <button
              className="ghost-button"
              onClick={() => {
                setFilterType("All");
                setFilterSearch("");
                setFilterFrom("");
                setFilterTo("");
              }}
            >
              Clear
            </button>
          ) : null}
          <span className="muted" style={{ fontSize: 12 }}>
            {filtered.length} of {log.length}
          </span>
        </div>
      ) : null}
      {filtered.length ? (
        <div className="activity-list">
          {filtered.map((entry) => {
            const highlight = (str) => {
              if (!filterSearch || !str) return str;
              const idx = str.toLowerCase().indexOf(filterSearch.toLowerCase());
              if (idx === -1) return str;
              return (
                <>
                  {str.slice(0, idx)}
                  <mark
                    style={{
                      background: "rgba(69,163,255,0.3)",
                      borderRadius: 2,
                      padding: "0 1px",
                    }}
                  >
                    {str.slice(idx, idx + filterSearch.length)}
                  </mark>
                  {str.slice(idx + filterSearch.length)}
                </>
              );
            };
            return (
              <div className="activity-entry" key={entry.id}>
                <div className="activity-meta">
                  <span
                    className={`activity-type activity-${entry.type?.toLowerCase()}`}
                  >
                    {entry.type || "Note"}
                  </span>
                  {entry.accountName ? (
                    <code>
                      {Object.values(client.accountRegistry || {}).find(
                        (a) => a.accountName === entry.accountName,
                      )?.alias || entry.accountName}
                    </code>
                  ) : null}
                  <em>{formatDate(entry.createdAt)}</em>
                  <button
                    className="ghost-button icon-only"
                    onClick={() => onDeleteEntry(entry.id)}
                    title="Delete entry"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <p>{highlight(entry.text)}</p>
              </div>
            );
          })}
        </div>
      ) : log.length ? (
        <p className="muted">No entries match the current filter.</p>
      ) : (
        <p className="muted">
          No activity logged yet. Use the form above to log calls, notes, and
          actions.
        </p>
      )}
    </section>
  );
}

const TASK_PRIORITIES = ["Normal", "High", "Low"];

function TasksTab({ client, onAddTask, onUpdateTask, onDeleteTask }) {
  const [text, setText] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [accountName, setAccountName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editPriority, setEditPriority] = useState("Normal");
  const [taskFilter, setTaskFilter] = useState("open");

  function startEdit(task) {
    setEditingId(task.id);
    setEditText(task.text);
    setEditDue(task.dueDate || "");
    setEditPriority(task.priority || "Normal");
  }

  function saveEdit(taskId) {
    if (editText.trim()) {
      onUpdateTask(taskId, {
        text: editText.trim(),
        dueDate: editDue,
        priority: editPriority,
      });
    }
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }
  const tasks = (client.tasks || []).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.priority === "High" && b.priority !== "High") return -1;
    if (b.priority === "High" && a.priority !== "High") return 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  const today = todayIsoDate();
  const allTasks = tasks;
  const overdueCount = allTasks.filter(
    (t) => !t.done && t.dueDate && t.dueDate < today,
  ).length;
  const openCount = allTasks.filter((t) => !t.done).length;
  const doneCount = allTasks.filter((t) => t.done).length;
  const filteredTasks =
    taskFilter === "all"
      ? allTasks
      : taskFilter === "done"
        ? allTasks.filter((t) => t.done)
        : taskFilter === "overdue"
          ? allTasks.filter((t) => !t.done && t.dueDate && t.dueDate < today)
          : allTasks.filter((t) => !t.done);
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
    setText("");
    setDueDate("");
    setPriority("Normal");
    setAccountName("");
  }

  function formatDue(date) {
    if (!date) return null;
    const d = new Date(date + "T12:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff < 0)
      return { label: `${Math.abs(diff)}d overdue`, tone: "negative" };
    if (diff === 0) return { label: "Due today", tone: "negative" };
    if (diff === 1) return { label: "Due tomorrow", tone: "warning" };
    return {
      label: `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      tone: "muted",
    };
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>Tasks</h3>
        {openCount > 0 ? (
          <span className="count">{openCount} open</span>
        ) : (
          <span className="badge success">All done</span>
        )}
        <div
          className="task-filter-chips"
          style={{ marginLeft: "auto", display: "flex", gap: 4 }}
        >
          <button
            className={`ghost-button${taskFilter === "open" ? " active" : ""}`}
            onClick={() => setTaskFilter("open")}
          >
            Open{openCount > 0 ? ` (${openCount})` : ""}
          </button>
          {overdueCount > 0 && (
            <button
              className={`ghost-button${taskFilter === "overdue" ? " active" : ""}`}
              onClick={() => setTaskFilter("overdue")}
              style={{ color: "var(--error)" }}
            >
              Overdue ({overdueCount})
            </button>
          )}
          <button
            className={`ghost-button${taskFilter === "done" ? " active" : ""}`}
            onClick={() => setTaskFilter("done")}
          >
            Done{doneCount > 0 ? ` (${doneCount})` : ""}
          </button>
          <button
            className={`ghost-button${taskFilter === "all" ? " active" : ""}`}
            onClick={() => setTaskFilter("all")}
          >
            All
          </button>
          {openCount > 1 && (
            <button
              className="ghost-button"
              title="Mark all open tasks done"
              onClick={() => {
                allTasks
                  .filter((t) => !t.done)
                  .forEach((t) => onUpdateTask(t.id, { done: true }));
              }}
            >
              ✓ All
            </button>
          )}
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
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            title="Due date (optional)"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.accountName} value={a.accountName}>
                {a.alias || a.accountName}
              </option>
            ))}
          </select>
          <button className="primary-button">
            <ListChecks size={14} /> Add task
          </button>
        </div>
      </form>
      {filteredTasks.length ? (
        <div className="task-list">
          {filteredTasks.map((task) => {
            const due = formatDue(task.dueDate);
            const alias = task.accountName
              ? accounts.find((a) => a.accountName === task.accountName)
                  ?.alias || task.accountName
              : null;
            return (
              <div
                className={`task-row${task.done ? " task-done" : ""}${task.priority === "High" && !task.done ? " task-high" : ""}${editingId === task.id ? " task-editing" : ""}`}
                key={task.id}
              >
                {editingId === task.id ? (
                  <div className="task-edit-inline">
                    <input
                      className="task-text-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit(task.id);
                        if (e.key === "Escape") cancelEdit();
                      }}
                      autoFocus
                    />
                    <div className="task-form-meta">
                      <input
                        type="date"
                        value={editDue}
                        onChange={(e) => setEditDue(e.target.value)}
                      />
                      <select
                        value={editPriority}
                        onChange={(e) => setEditPriority(e.target.value)}
                      >
                        {TASK_PRIORITIES.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                      <button
                        className="primary-button"
                        onClick={() => saveEdit(task.id)}
                      >
                        Save
                      </button>
                      <button className="ghost-button" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      className="task-checkbox"
                      title={task.done ? "Mark open" : "Mark done"}
                      onClick={() =>
                        onUpdateTask(task.id, { done: !task.done })
                      }
                    >
                      <CheckSquare
                        size={16}
                        className={
                          task.done ? "task-checked" : "task-unchecked"
                        }
                      />
                    </button>
                    <div
                      className="task-body"
                      role="button"
                      tabIndex={task.done ? -1 : 0}
                      style={{ cursor: task.done ? "default" : "pointer" }}
                      onClick={() => !task.done && startEdit(task)}
                      onKeyDown={(e) => {
                        if (
                          !task.done &&
                          (e.key === "Enter" || e.key === " ")
                        ) {
                          e.preventDefault();
                          startEdit(task);
                        }
                      }}
                      title={task.done ? "" : "Click to edit"}
                    >
                      <span className="task-text">{task.text}</span>
                      <div className="task-chips">
                        {task.priority === "High" && !task.done ? (
                          <span className="task-chip task-chip-high">High</span>
                        ) : null}
                        {alias ? (
                          <span className="task-chip">{alias}</span>
                        ) : null}
                        {due ? (
                          <span
                            className={`task-chip task-chip-due ${due.tone}`}
                          >
                            {due.label}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      className="ghost-button icon-only"
                      onClick={() => onDeleteTask(task.id)}
                      title="Delete task"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">
          {taskFilter === "open" && allTasks.length
            ? "No open tasks — all done!"
            : taskFilter === "overdue"
              ? "No overdue tasks."
              : taskFilter === "done" && !doneCount
                ? "No completed tasks yet."
                : "No tasks yet. Add follow-ups, reminders, or action items above."}
        </p>
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
      {copied ? "✓" : <Copy size={12} />}
    </button>
  );
}

const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Bogota",
  "America/Mexico_City",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Australia/Sydney",
];

const COUNTRY_OPTIONS = [
  "United States",
  "Canada",
  "Mexico",
  "Colombia",
  "Brazil",
  "Argentina",
  "Chile",
  "Peru",
  "United Kingdom",
  "Spain",
  "France",
  "Germany",
  "Italy",
  "Netherlands",
  "United Arab Emirates",
  "Singapore",
  "Indonesia",
  "Australia",
];

function normalizeEmailList(emails = []) {
  if (!Array.isArray(emails)) return [];
  const seen = new Set();
  return emails
    .map((email) => String(email || "").trim())
    .filter((email) => {
      const key = email.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function CredentialsTab({
  client,
  onUpdateClient,
  onDeleteClient,
  canDeleteClient = true,
}) {
  const credentials = client.credentials || {};
  const profile = client.profile || {};
  const propFirms = Array.isArray(client.propFirms) ? client.propFirms : [];
  const additionalEmails = normalizeEmailList(profile.additionalEmails);
  const countryListId = `country-options-${String(client?.id || "client").replace(/[^a-z0-9_-]/gi, "-")}`;
  const [showPasswords, setShowPasswords] = useState(false);
  const [additionalEmailDraft, setAdditionalEmailDraft] = useState("");

  function updateProfile(patch) {
    onUpdateClient({ profile: { ...profile, ...patch } });
  }
  function updateCredentials(patch) {
    onUpdateClient({ credentials: { ...credentials, ...patch } });
  }
  function commitPropFirms(nextPropFirms) {
    onUpdateClient({
      propFirms: nextPropFirms.map((propFirm, index) => ({
        ...propFirm,
        sortOrder: index,
      })),
    });
  }
  function addPropFirm() {
    commitPropFirms([
      ...propFirms,
      {
        id: `local-${Date.now().toString(36)}`,
        firmName: "",
        connection: "Tradovate",
        login: "",
        password: "",
        sortOrder: propFirms.length,
      },
    ]);
  }
  function updatePropFirm(id, patch) {
    commitPropFirms(
      propFirms.map((propFirm) =>
        propFirm.id === id ? { ...propFirm, ...patch } : propFirm,
      ),
    );
  }
  function removePropFirm(id) {
    commitPropFirms(propFirms.filter((propFirm) => propFirm.id !== id));
  }
  function addAdditionalEmail() {
    const nextEmail = additionalEmailDraft.trim();
    if (!nextEmail) return;
    updateProfile({
      additionalEmails: normalizeEmailList([...additionalEmails, nextEmail]),
    });
    setAdditionalEmailDraft("");
  }
  function removeAdditionalEmail(email) {
    updateProfile({
      additionalEmails: additionalEmails.filter((item) => item !== email),
    });
  }

  return (
    <div className="credentials-stack">
      <section className="panel">
        <div className="panel-heading">
          <h3>Client profile</h3>
          <span className="badge muted">Contact information</span>
        </div>
        <div className="form-grid">
          <label>
            Full name
            <input
              value={profile.fullName || ""}
              placeholder="Legal name"
              onChange={(e) => updateProfile({ fullName: e.target.value })}
            />
          </label>
          <label>
            Primary email
            <div className="input-copy-row">
              <input
                type="email"
                value={profile.email || ""}
                placeholder="client@email.com"
                onChange={(e) => updateProfile({ email: e.target.value })}
              />
              {profile.email && (
                <a
                  className="ghost-button icon-only"
                  href={`mailto:${profile.email}`}
                  title="Send email"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 6px",
                    textDecoration: "none",
                  }}
                >
                  <Mail size={13} />
                </a>
              )}
              <CopyButton value={profile.email} />
            </div>
          </label>
          <div className="form-grid-wide form-field">
            <span className="form-field-label">Additional emails</span>
            <div className="email-chip-editor">
              {additionalEmails.length > 0 && (
                <div className="email-chip-list">
                  {additionalEmails.map((email) => (
                    <span className="email-chip" key={email}>
                      {email}
                      <button
                        type="button"
                        title={`Remove ${email}`}
                        onClick={() => removeAdditionalEmail(email)}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="input-copy-row">
                <input
                  type="email"
                  value={additionalEmailDraft}
                  placeholder="extra@email.com"
                  onChange={(e) => setAdditionalEmailDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAdditionalEmail();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={addAdditionalEmail}
                  disabled={!additionalEmailDraft.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          <label>
            Phone
            <div className="input-copy-row">
              <input
                type="tel"
                value={profile.phone || ""}
                placeholder="+1 (555) 000-0000"
                onChange={(e) => updateProfile({ phone: e.target.value })}
              />
              {profile.phone && (
                <a
                  className="ghost-button icon-only"
                  href={`tel:${profile.phone}`}
                  title="Call"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 6px",
                    textDecoration: "none",
                  }}
                >
                  <Phone size={13} />
                </a>
              )}
              <CopyButton value={profile.phone} />
            </div>
          </label>
          <label>
            Time zone
            <select
              value={profile.timezone || ""}
              onChange={(e) => updateProfile({ timezone: e.target.value })}
            >
              <option value="">-- Not set --</option>
              {TIMEZONE_OPTIONS.map((timezone) => (
                <option value={timezone} key={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product key
            <div className="input-copy-row">
              <input
                value={profile.productKey || ""}
                placeholder="Client product/license key"
                onChange={(e) => updateProfile({ productKey: e.target.value })}
              />
              <CopyButton value={profile.productKey} />
            </div>
          </label>
          <label>
            Discord username
            <div className="input-copy-row">
              <input
                value={profile.messenger || ""}
                placeholder="Discord username"
                onChange={(e) => updateProfile({ messenger: e.target.value })}
              />
              <CopyButton value={profile.messenger} />
            </div>
          </label>
          <label>
            Client stage
            <select
              value={profile.stage || "Active"}
              onChange={(e) => updateProfile({ stage: e.target.value })}
            >
              <option>Onboarding</option>
              <option>Active</option>
              <option>At Risk</option>
              <option>Paused</option>
              <option>Inactive</option>
            </select>
          </label>
          <label>
            Preferred channel
            <select
              value={profile.preferredChannel || ""}
              onChange={(e) =>
                updateProfile({ preferredChannel: e.target.value })
              }
            >
              <option value="">— Not set —</option>
              <option>WhatsApp</option>
              <option>Email</option>
              <option>Discord</option>
              <option>Other</option>
            </select>
          </label>
          <label>
            Language
            <select
              value={profile.language || ""}
              onChange={(e) => updateProfile({ language: e.target.value })}
            >
              <option value="">— Not set —</option>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <label>
            Country
            <input
              list={countryListId}
              value={profile.country || ""}
              placeholder="e.g. Colombia, USA"
              onChange={(e) => updateProfile({ country: e.target.value })}
            />
            <datalist id={countryListId}>
              {COUNTRY_OPTIONS.map((country) => (
                <option value={country} key={country} />
              ))}
            </datalist>
          </label>
          <label>
            Start date
            <input
              type="date"
              value={profile.startDate || ""}
              onChange={(e) => updateProfile({ startDate: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>VPS / Platform access</h3>
          <Lock size={16} />
          <button
            className="ghost-button"
            style={{ marginLeft: "auto", fontSize: 12 }}
            onClick={() => setShowPasswords((v) => !v)}
          >
            {showPasswords ? (
              <>
                <EyeOff size={14} /> Hide passwords
              </>
            ) : (
              <>
                <Eye size={14} /> Show passwords
              </>
            )}
          </button>
        </div>
        <div className="form-grid">
          <label>
            VPS IP
            <div className="input-copy-row">
              <input
                value={credentials.ip || ""}
                onChange={(e) => updateCredentials({ ip: e.target.value })}
              />
              <CopyButton value={credentials.ip} />
            </div>
          </label>
          <label>
            Username
            <div className="input-copy-row">
              <input
                value={credentials.username || ""}
                onChange={(e) =>
                  updateCredentials({ username: e.target.value })
                }
              />
              <CopyButton value={credentials.username} />
            </div>
          </label>
          <label>
            Password
            <div className="input-copy-row">
              <input
                type={showPasswords ? "text" : "password"}
                value={credentials.password || ""}
                onChange={(e) =>
                  updateCredentials({ password: e.target.value })
                }
              />
              <CopyButton value={credentials.password} />
            </div>
          </label>
          <div className="form-grid-wide form-field">
            <span className="form-field-label">NinjaTrader</span>
            <div className="paired-field-row">
              <div className="paired-field">
                <span>Username</span>
                <div className="input-copy-row">
                  <input
                    value={credentials.ntLogin || ""}
                    placeholder="NinjaTrader username"
                    onChange={(e) =>
                      updateCredentials({ ntLogin: e.target.value })
                    }
                  />
                  <CopyButton value={credentials.ntLogin} />
                </div>
              </div>
              <div className="paired-field">
                <span>Password</span>
                <div className="input-copy-row">
                  <input
                    type={showPasswords ? "text" : "password"}
                    value={credentials.ntPassword || ""}
                    onChange={(e) =>
                      updateCredentials({ ntPassword: e.target.value })
                    }
                  />
                  <CopyButton value={credentials.ntPassword} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>Prop firms</h3>
          <button className="ghost-button" type="button" onClick={addPropFirm}>
            <Plus size={14} /> Add firm
          </button>
        </div>
        {propFirms.length ? (
          <div className="prop-firm-list">
            {propFirms.map((propFirm, index) => (
              <div className="prop-firm-row" key={propFirm.id || index}>
                <div className="prop-firm-row-head">
                  <strong>Firm {index + 1}</strong>
                  <div className="segmented-control">
                    {["Tradovate", "Rithmic"].map((connection) => (
                      <button
                        type="button"
                        key={connection}
                        className={propFirm.connection === connection ? "active" : ""}
                        onClick={() => updatePropFirm(propFirm.id, { connection })}
                      >
                        {connection}
                      </button>
                    ))}
                  </div>
                  <button
                    className="ghost-button icon-only"
                    type="button"
                    title="Remove prop firm"
                    onClick={() => removePropFirm(propFirm.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="form-grid prop-firm-grid">
                  <label>
                    Firm name
                    <input
                      value={propFirm.firmName || ""}
                      placeholder="e.g. Apex, TopStep"
                      onChange={(e) =>
                        updatePropFirm(propFirm.id, { firmName: e.target.value })
                      }
                    />
                  </label>
                  <div className="form-grid-wide form-field">
                    <span className="form-field-label">Prop firm access</span>
                    <div className="paired-field-row">
                      <div className="paired-field">
                        <span>Login</span>
                        <div className="input-copy-row">
                          <input
                            value={propFirm.login || ""}
                            placeholder="Dashboard login email"
                            onChange={(e) =>
                              updatePropFirm(propFirm.id, {
                                login: e.target.value,
                              })
                            }
                          />
                          <CopyButton value={propFirm.login} />
                        </div>
                      </div>
                      <div className="paired-field">
                        <span>Password</span>
                        <div className="input-copy-row">
                          <input
                            type={showPasswords ? "text" : "password"}
                            value={propFirm.password || ""}
                            onChange={(e) =>
                              updatePropFirm(propFirm.id, {
                                password: e.target.value,
                              })
                            }
                          />
                          <CopyButton value={propFirm.password} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No prop firms added.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>Notes</h3>
        </div>
        <textarea
          className="client-notes-area"
          value={client.notes || ""}
          placeholder="Internal notes, special instructions, client preferences..."
          onChange={(e) => onUpdateClient({ notes: e.target.value })}
        />
      </section>

      {canDeleteClient ? (
        <section
          className="panel"
          style={{ borderColor: "var(--error)", opacity: 0.8 }}
        >
          <div className="panel-heading">
            <h3>Danger zone</h3>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 0",
            }}
          >
            <div>
              <strong style={{ fontSize: 13 }}>Remove client</strong>
              <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>
                Permanently deletes all data for this client. Confirm the data is
                no longer needed before deleting.
              </p>
            </div>
            <button
              className="secondary-button"
              style={{
                color: "var(--error)",
                borderColor: "var(--error)",
                flexShrink: 0,
              }}
              onClick={onDeleteClient}
            >
              <Trash2 size={13} /> Remove client
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

const DEFAULT_PRICE_CHECK_ROWS = [
  {
    id: "pc-1",
    instrument: "MNQ",
    checkTime: "09:00",
    connection: "",
    algos: "",
    notes: "",
    checked: false,
  },
  {
    id: "pc-2",
    instrument: "MES",
    checkTime: "10:00",
    connection: "",
    algos: "",
    notes: "",
    checked: false,
  },
];

function PriceChecksTab({ client, onUpdateClient }) {
  const nextRowId = useRef(Date.now());
  const checks = client.priceChecks?.length
    ? client.priceChecks
    : DEFAULT_PRICE_CHECK_ROWS;
  const today = todayIsoDate();
  const lastReset = client.priceChecksDate;

  const activeChecks =
    lastReset === today
      ? checks
      : checks.map((r) => ({ ...r, checked: false }));

  function save(rows) {
    onUpdateClient({ priceChecks: rows, priceChecksDate: today });
  }

  function update(id, patch) {
    save(activeChecks.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const id = `pc-custom-${nextRowId.current}`;
    nextRowId.current += 1;
    save([
      ...activeChecks,
      {
        id,
        instrument: "",
        checkTime: "",
        connection: "",
        algos: "",
        notes: "",
        checked: false,
      },
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {allDone ? (
            <span className="badge success">All checked · {today}</span>
          ) : (
            <span className="badge muted">
              {doneCount}/{activeChecks.length} checked today
            </span>
          )}
          <button className="secondary-button" onClick={resetAll}>
            Reset
          </button>
          <button className="secondary-button" onClick={addRow}>
            <Plus size={14} /> Row
          </button>
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
              <tr key={row.id} className={row.checked ? "pc-row-done" : ""}>
                <td>
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(e) =>
                      update(row.id, { checked: e.target.checked })
                    }
                    style={{ width: 16, height: 16, cursor: "pointer" }}
                  />
                </td>
                <td>
                  <input
                    value={row.instrument}
                    placeholder="MNQ"
                    style={{ width: "100%" }}
                    onChange={(e) =>
                      update(row.id, { instrument: e.target.value })
                    }
                  />
                </td>
                <td>
                  <input
                    value={row.checkTime}
                    placeholder="09:00"
                    style={{ width: 72 }}
                    onChange={(e) =>
                      update(row.id, { checkTime: e.target.value })
                    }
                  />
                </td>
                <td>
                  <select
                    value={row.connection}
                    onChange={(e) =>
                      update(row.id, { connection: e.target.value })
                    }
                    style={{ minWidth: 130 }}
                  >
                    <option value="">— not checked</option>
                    <option value="Connected">Connected</option>
                    <option value="Disconnected">Disconnected</option>
                    <option value="Degraded">Degraded</option>
                  </select>
                </td>
                <td>
                  <select
                    value={row.algos}
                    onChange={(e) => update(row.id, { algos: e.target.value })}
                    style={{ minWidth: 110 }}
                  >
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
                    style={{ width: "100%" }}
                    onChange={(e) => update(row.id, { notes: e.target.value })}
                  />
                </td>
                <td>
                  <button
                    className="ghost-button icon-only"
                    onClick={() => removeRow(row.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PinnedNote({ note, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note || "");
  if (!editing && !note)
    return (
      <button
        className="ghost-button"
        style={{
          fontSize: 11,
          marginBottom: 4,
          alignSelf: "flex-start",
          color: "var(--muted)",
        }}
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
      >
        📌 Pin a note…
      </button>
    );
  if (editing)
    return (
      <div className="pinned-note editing">
        <span>📌</span>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Pinned note — always visible (VPS IP, client quirks, warnings…)"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: "var(--text)",
            fontSize: 13,
            resize: "vertical",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              onSave(draft.trim());
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button
          className="primary-button"
          style={{ padding: "3px 10px", fontSize: 12 }}
          onClick={() => {
            onSave(draft.trim());
            setEditing(false);
          }}
        >
          Save
        </button>
        <button
          className="ghost-button"
          style={{ fontSize: 12 }}
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    );
  return (
    <div
      className="pinned-note"
      role="button"
      tabIndex={0}
      onClick={() => {
        setDraft(note);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setDraft(note);
          setEditing(true);
        }
      }}
      title="Click to edit pinned note"
    >
      <span>📌</span>
      <span style={{ flex: 1, fontSize: 13 }}>{note}</span>
      <button
        className="ghost-button"
        style={{ fontSize: 11, padding: "2px 6px" }}
        onClick={(e) => {
          e.stopPropagation();
          onSave("");
        }}
      >
        ✕
      </button>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(() => createInitialState());
  const [users, setUsers] = useState([]);
  const [remoteStatus, setRemoteStatus] = useState(() =>
    isSupabaseConfigured
      ? {
          source: "supabase",
          status: "loading",
          message: "Connecting to Supabase...",
        }
      : {
          source: "supabase",
          status: "error",
          message: "Supabase environment is required.",
        },
  );
  const [session, setSession] = useState(() => {
    try {
      const raw = sessionStorage.getItem("cam_crm_session");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [logoutConfirmAction, setLogoutConfirmAction] = useState(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [workspaceConfirmAction, setWorkspaceConfirmAction] = useState(null);
  function persistSession(user) {
    setSession(user);
    try {
      if (user) sessionStorage.setItem("cam_crm_session", JSON.stringify(user));
      else sessionStorage.removeItem("cam_crm_session");
    } catch {}
  }
  function handleLogout() {
    if (logoutBusy) return;
    setLogoutConfirmAction({
      title: "Sign out of Vincere CRM?",
      description: "Your current workspace session will close. Unsaved form changes on this screen may be lost.",
      confirmLabel: "Sign out",
      busyLabel: "Signing out...",
      variant: "danger",
      onConfirm: performLogout,
    });
  }
  async function performLogout() {
    try {
      setLogoutBusy(true);
      if (isSupabaseConfigured) await signOutSupabase();
    } catch (err) {
      console.error("[CRM] Supabase sign out failed:", err);
    } finally {
      setLogoutBusy(false);
      setLogoutConfirmAction(null);
    }
    persistSession(null);
    setPlatformView("manager");
  }
  function runWorkspaceConfirmAction() {
    const action = workspaceConfirmAction;
    if (!action?.onConfirm) return;
    action.onConfirm();
    setWorkspaceConfirmAction(null);
  }
  const [platformView, setPlatformView] = useState("manager");
  // On mount: if session was restored, re-validate and restore workspace
  useEffect(() => {
    if (!isSupabaseConfigured) {
      persistSession(null);
      return;
    }
    getSupabaseSessionAppUser()
      .then((fresh) => {
        if (!fresh) {
          persistSession(null);
          return;
        }
        persistSession(fresh);
        if (fresh.role === USER_ROLES.CAM && fresh.camProfileId) {
          openCamWorkspace(fresh.camProfileId);
        } else {
          openManagerWorkspace();
        }
      })
      .catch((err) => {
        console.error("[CRM] Supabase session restore failed:", err);
        persistSession(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [newClientName, setNewClientName] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const isFilteringClientList = clientSearch.trim().length >= 2;
  const [viewedClientIds, setViewedClientIds] = useState(() => {
    try {
      const raw = sessionStorage.getItem("cam_viewed_clients");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  function markClientViewed(clientId) {
    setViewedClientIds((s) => {
      const next = new Set([...s, clientId]);
      try {
        sessionStorage.setItem("cam_viewed_clients", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }
  const [activeTab, setActiveTab] = useState("Overview");
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [showUpload, setShowUpload] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [showSOP, setShowSOP] = useState(false);
  const [showQuickLog, setShowQuickLog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [quickLogType, setQuickLogType] = useState("Note");
  const [quickLogText, setQuickLogText] = useState("");
  const [quickLogAccount, setQuickLogAccount] = useState("");
  const [reportImport, setReportImport] = useState(null);
  const [monthlyReportMonth, setMonthlyReportMonth] = useState(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [strategySetIndex, setStrategySetIndex] = useState({
    status: "Not loaded",
    records: [],
  });
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchIdx, setGlobalSearchIdx] = useState(0);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    loadSupabaseCrmState({
      preferredCamProfileId:
        session?.camProfileId || state.accountManager?.id || "am-pedro",
    })
      .then((remoteState) => {
        if (cancelled) return;
        setState(remoteState);
        setRemoteStatus({
          source: "supabase",
          status: "connected",
          message: "Connected to Supabase",
        });
        if (session?.role === USER_ROLES.CAM && session.camProfileId)
          setPlatformView("cam");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[CRM] Supabase load failed:", error);
        setRemoteStatus({
          source: "supabase",
          status: "error",
          message: `Supabase unavailable: ${error.message}`,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadSupabaseState(preferredCamProfileId = null, selectedClientId = null) {
    if (!isSupabaseConfigured) return null;
    const remoteState = await loadSupabaseCrmState({
      preferredCamProfileId:
        preferredCamProfileId ||
        session?.camProfileId ||
        state.accountManager?.id ||
        "am-pedro",
    });
    const nextState = selectedClientId
      ? selectClient(remoteState, selectedClientId)
      : remoteState;
    setState(nextState);
    setRemoteStatus({
      source: "supabase",
      status: "connected",
      message: "Connected to Supabase",
    });
    return nextState;
  }

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setGlobalSearchOpen((v) => !v);
        setGlobalSearchQuery("");
      }
      if (e.key === "Escape") setGlobalSearchOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onKey(e) {
      // Ignore when typing in an input/textarea/select
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (e.altKey && e.key === "l") {
        e.preventDefault();
        setShowQuickLog((v) => !v);
      }
      if (e.altKey && e.key === "u") {
        e.preventDefault();
        setShowUpload((v) => !v);
      }
      if (e.altKey && e.key === "o") {
        e.preventDefault();
        setShowOverview(true);
        setShowSOP(false);
      }
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
      if (e.altKey && e.key === "s") {
        e.preventDefault();
        setShowSOP(true);
        setShowOverview(false);
      }
      if (e.altKey && e.key === "n") {
        e.preventDefault();
        setActiveTab("Tasks");
        setShowOverview(false);
        setShowSOP(false);
        setTimeout(
          () => document.querySelector(".task-text-input")?.focus(),
          100,
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/strategy-set-index.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.records?.length) {
          setStrategySetIndex({ status: "Loaded", records: data.records });
        } else {
          setStrategySetIndex({ status: "Run npm run xml:index", records: [] });
        }
      })
      .catch(() => {
        if (!cancelled)
          setStrategySetIndex({ status: "Run npm run xml:index", records: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleCamProfiles = activeCamProfilesForUsers(state.camProfiles || [], users);
  const currentCamProfile =
    visibleCamProfiles.find(
      (profile) => profile.id === state.accountManager?.id,
    ) ||
    (state.camProfiles || []).find(
      (profile) => profile.id === state.accountManager?.id,
    ) ||
    visibleCamProfiles[0] ||
    state.camProfiles?.[0] ||
    null;
  const currentCamClients = clientsForCam(state.clients, currentCamProfile);
  const isManagerSession = session?.role === USER_ROLES.MANAGER;
  const canCreateDeleteClients =
    isManagerSession || Boolean(currentCamProfile?.canManageClients);
  const accessibleClients = isManagerSession
    ? state.clients || []
    : currentCamClients;
  const selectedClient =
    currentCamClients.find((client) => client.id === state.selectedClientId) ||
    currentCamClients[0] ||
    null;

  // Auto-navigate to most recent import date when selected client has no import for selectedDate
  useEffect(() => {
    if (!selectedClient) return;
    const hasToday = getClientImportByDate(selectedClient, selectedDate);
    if (!hasToday) {
      const latest = selectedClient.dailyImports?.at(-1);
      if (latest?.date) setSelectedDate(latest.date);
    }
  }, [selectedClient?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dailyImport = selectedClient
    ? getClientImportByDate(selectedClient, selectedDate)
    : null;
  const visibleTabs = selectedClient
    ? buildVisibleTabs(selectedClient, dailyImport)
    : STATIC_TABS;
  const todayActions = useMemo(
    () =>
      selectedClient ? buildTodayActions(selectedClient, dailyImport) : [],
    [selectedClient, dailyImport],
  );

  const effectiveActiveTab = visibleTabs.includes(activeTab)
    ? activeTab
    : visibleTabs[0] || "Credentials & Notes";

  const currentTabData = selectedClient
    ? filteredAccountsForTab(selectedClient, dailyImport, effectiveActiveTab)
    : { accounts: {}, snapshots: [] };

  function handleAddClient(event) {
    event.preventDefault();
    if (!canCreateDeleteClients) {
      window.alert("This CAM does not have permission to create clients. Ask a Manager to enable client management access.");
      return;
    }
    const clientName = newClientName.trim();
    if (!clientName) return;
    const targetCamId = currentCamProfile?.id || state.accountManager?.id || null;
    setState((current) =>
      addClient(current, clientName, current.accountManager?.id),
    );
    setNewClientName("");
    setShowOverview(false);
    setShowSOP(false);
    if (isSupabaseConfigured) {
      createSupabaseClient(clientName, targetCamId, "Active")
        .then((savedClient) => {
          auditSilently({
            entityType: "client",
            entityId: savedClient?.id || null,
            action: "client.create",
            afterData: { clientName, camProfileId: targetCamId, stage: "Active" },
          });
          return reloadSupabaseState(targetCamId);
        })
        .catch((error) => {
          console.error("[CRM] Failed to create client:", error);
          window.alert(`Could not save client "${clientName}" to Supabase: ${error.message}`);
        });
    }
  }

  function openCamWorkspace(camId = "am-pedro", clientId = null) {
    setState((current) => {
      const next = selectCam(current, camId);
      return clientId ? { ...next, selectedClientId: clientId } : next;
    });
    setPlatformView("cam");
    setShowOverview(false);
    setShowSOP(false);
    setRegistryOpen(false);
    if (isSupabaseConfigured) {
      reloadSupabaseState(camId, clientId).catch((error) => {
        console.error("[CRM] Failed to refresh CAM workspace:", error);
      });
    }
  }

  function openManagerWorkspace() {
    setPlatformView("manager");
    setShowOverview(false);
    setShowSOP(false);
    if (isSupabaseConfigured) {
      reloadSupabaseState(null).catch((error) => {
        console.error("[CRM] Failed to refresh manager workspace:", error);
      });
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
    persistDailyImport(selectedClient.id, result);
    setShowUpload(false);
  }

  function persistDailyImport(clientId, result) {
    setState((current) => appendDailyImport(current, clientId, result));
    if (!isSupabaseConfigured) return Promise.resolve(null);
    return upsertSupabaseDailyImport(clientId, result)
      .then((savedImport) => {
        auditSilently({
          entityType: "daily_import",
          entityId: savedImport?.id || null,
          action: "daily_import.upsert",
          afterData: {
            clientId,
            reportDate: result.date,
            status: result.status,
            accountCount: Object.keys(result.accounts || {}).length,
            snapshotCount: (result.snapshots || []).length,
            flagCount: (result.flags || []).length,
          },
        });
        return reloadSupabaseState(state.accountManager?.id);
      })
      .catch((error) => {
        console.error("[CRM] Failed to save daily import:", error);
        window.alert(`Could not save daily import to Supabase: ${error.message}`);
        return null;
      });
  }

  function handleAccountUpdate(accountName, patch) {
    if (!selectedClient) return;
    persistAccountUpdate(selectedClient.id, accountName, patch);
  }

  function persistAccountUpdate(clientId, accountName, patch) {
    setState((current) =>
      upsertAccountMeta(current, clientId, accountName, patch),
    );
    updateSupabaseTradingAccount(clientId, accountName, patch).then(() => {
      auditSilently({
        entityType: "trading_account",
        entityId: accountName,
        action: "account.update",
        afterData: { clientId, accountName, patch },
      });
    }).catch(
      (error) => {
        console.error("[CRM] Failed to update trading account:", error);
        window.alert(
          `Could not save "${accountName}" to Supabase: ${error.message}`,
        );
      },
    );
  }

  function requestRemoveAccount(accountName) {
    if (!selectedClient) return;
    const client = selectedClient;
    setWorkspaceConfirmAction({
      title: `Remove ${accountName}?`,
      description: "Historical import data is kept, but account metadata such as type, alias, and targets will be deleted.",
      confirmLabel: "Remove account",
      busyLabel: "Removing...",
      variant: "danger",
      onConfirm: () => performRemoveAccount(client, accountName),
    });
  }

  function performRemoveAccount(client, accountName) {
    setState((current) =>
      removeAccountFromRegistry(
        current,
        client.id,
        accountName,
      ),
    );
    deleteSupabaseTradingAccount(
      client.id,
      accountName,
    ).then(() => {
      auditSilently({
        entityType: "trading_account",
        entityId: accountName,
        action: "account.delete",
        afterData: {
          clientId: client.id,
          clientName: client.name,
          accountName,
        },
      });
    }).catch((error) => {
      console.error(
        "[CRM] Failed to remove trading account:",
        error,
      );
      window.alert(
        `Could not remove "${accountName}" from Supabase: ${error.message}`,
      );
    });
  }

  function handleLogPayout(accountName, entry) {
    if (!selectedClient) return;
    setState((current) => {
      const clientData = (current.clients || []).find(
        (c) => c.id === selectedClient.id,
      );
      const reg = clientData?.accountRegistry || {};
      const regKey =
        Object.keys(reg).find(
          (k) => k.toLowerCase() === accountName.toLowerCase(),
        ) || accountName;
      const existing = reg[regKey]?.payoutHistory || [];
      const newHistory = [...existing, entry];
      const prevCount = Number(reg[regKey]?.payoutCount || 0);
      return upsertAccountMeta(current, selectedClient.id, accountName, {
        payoutHistory: newHistory,
        payoutCount: prevCount + 1,
        dateLastPayout: entry.date,
      });
    });
    insertSupabasePayoutEvent(selectedClient.id, accountName, entry)
      .then(() =>
        updateSupabaseTradingAccount(selectedClient.id, accountName, {
          payoutCount:
            (selectedClient.accountRegistry?.[accountName]?.payoutCount || 0) +
            1,
          dateLastPayout: entry.date,
        }),
      )
      .then(() => {
        auditSilently({
          entityType: "payout_event",
          entityId: accountName,
          action: "payout.create",
          afterData: {
            clientId: selectedClient.id,
            clientName: selectedClient.name,
            accountName,
            amount: entry.amount,
            date: entry.date,
          },
        });
      })
      .catch((error) => {
        console.error("[CRM] Failed to log payout:", error);
        window.alert(
          `Could not save payout for "${accountName}" to Supabase: ${error.message}`,
        );
      });
  }

  function handleUpdateClient(patch) {
    if (!selectedClient) return;
    setState((current) =>
      updateClientDetails(current, selectedClient.id, patch),
    );
    if (!isSupabaseConfigured) return;

    const { priceChecks, priceChecksDate, ...clientPatch } = patch;
    const writes = [];
    if (Object.keys(clientPatch).length) {
      writes.push(updateSupabaseClient(selectedClient.id, clientPatch));
    }
    if ("priceChecks" in patch) {
      writes.push(
        replaceSupabasePriceChecks(
          selectedClient.id,
          priceChecks || [],
          priceChecksDate || todayIsoDate(),
        ),
      );
    }
    Promise.all(writes).then(() => {
      auditSilently({
        entityType: "client",
        entityId: selectedClient.id,
        action: "client.update",
        beforeData: { clientName: selectedClient.name },
        afterData: {
          clientId: selectedClient.id,
          clientName: selectedClient.name,
          changedFields: Object.keys(patch || {}),
        },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to update client:", error);
      window.alert(`Could not save client "${selectedClient.name}" to Supabase: ${error.message}`);
    });
  }

  function handleDeleteClient() {
    if (!selectedClient) return;
    if (!canCreateDeleteClients) {
      window.alert("This CAM does not have permission to delete clients. Ask a Manager to enable client management access.");
      return;
    }
    const clientToDelete = selectedClient;
    setWorkspaceConfirmAction({
      title: `Remove ${clientToDelete.name}?`,
      description: "This removes the client from the active workspace. Confirm the data is no longer needed before deleting.",
      confirmLabel: "Remove client",
      busyLabel: "Removing...",
      variant: "danger",
      onConfirm: () => performDeleteClient(clientToDelete),
    });
  }

  function performDeleteClient(clientToDelete) {
    setState((current) => removeClient(current, clientToDelete.id));
    softDeleteSupabaseClient(clientToDelete.id)
      .then(() => {
        auditSilently({
          entityType: "client",
          entityId: clientToDelete.id,
          action: "client.deactivate",
          beforeData: { clientName: clientToDelete.name, status: clientToDelete.status },
          afterData: { clientId: clientToDelete.id, clientName: clientToDelete.name, status: "Inactive" },
        });
        return reloadSupabaseState(currentCamProfile?.id || state.accountManager?.id);
      })
      .catch((error) => {
        console.error("[CRM] Failed to delete client:", error);
        window.alert(`Could not deactivate "${clientToDelete.name}" in Supabase: ${error.message}`);
      });
  }

  function handleResolveFlag(flagId, status = "Resolved") {
    if (!selectedClient || !dailyImport) return;
    const flag = (dailyImport.flags || []).find((f) => f.id === flagId);
    let entry = null;
    if (flag && (status === "Resolved" || status === "Acknowledged")) {
      const verb = status === "Resolved" ? "resolved" : "acknowledged";
      entry = {
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: "Alert",
        text: `Flag ${verb}: [${flag.type}] ${flag.message}`,
        accountName: flag.accountName || "",
        createdAt: new Date().toISOString(),
      };
    }
    setState((current) => {
      let next = resolveFlagInImport(
        current,
        selectedClient.id,
        dailyImport.id,
        flagId,
        status,
      );
      if (entry) next = addActivityEntry(next, selectedClient.id, entry);
      return next;
    });
    updateSupabaseOperationalFlag(flagId, status).then(() => {
      auditSilently({
        entityType: "operational_flag",
        entityId: flagId,
        action: status === "Resolved" ? "flag.resolve" : "flag.acknowledge",
        beforeData: flag ? { status: flag.status || "Open", type: flag.type } : null,
        afterData: {
          clientId: selectedClient.id,
          clientName: selectedClient.name,
          dailyImportId: dailyImport.id,
          flagId,
          status,
        },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to update flag:", error);
      window.alert(`Could not update flag in Supabase: ${error.message}`);
    });
    if (entry)
      insertSupabaseActivity(selectedClient.id, entry).catch((error) =>
        console.error("[CRM] Failed to save flag activity:", error),
      );
  }

  function handleBulkResolveFlags(status = "Acknowledged") {
    if (!selectedClient || !dailyImport) return;
    const openFlags = (dailyImport.flags || []).filter(
      (f) => f.status !== "Resolved" && f.status !== "Acknowledged",
    );
    if (!openFlags.length) return;
    const verb = status === "Resolved" ? "resolved" : "acknowledged";
    const entry = {
      id: `act-${Date.now()}-bulk`,
      type: "Alert",
      text: `Bulk ${verb} ${openFlags.length} flag${openFlags.length !== 1 ? "s" : ""}`,
      accountName: "",
      createdAt: new Date().toISOString(),
    };
    setState((current) => {
      let next = current;
      for (const flag of openFlags) {
        next = resolveFlagInImport(
          next,
          selectedClient.id,
          dailyImport.id,
          flag.id,
          status,
        );
      }
      return addActivityEntry(next, selectedClient.id, entry);
    });
    Promise.all(
      openFlags.map((flag) => updateSupabaseOperationalFlag(flag.id, status)),
    )
      .then(() => insertSupabaseActivity(selectedClient.id, entry))
      .then(() => {
        auditSilently({
          entityType: "operational_flag",
          entityId: dailyImport.id,
          action: status === "Resolved" ? "flag.bulk_resolve" : "flag.bulk_acknowledge",
          afterData: {
            clientId: selectedClient.id,
            clientName: selectedClient.name,
            dailyImportId: dailyImport.id,
            flagCount: openFlags.length,
            status,
          },
        });
      })
      .catch((error) => {
        console.error("[CRM] Failed to bulk update flags:", error);
        window.alert(`Could not update flags in Supabase: ${error.message}`);
      });
  }

  function handleAddActivity(entry) {
    if (!selectedClient) return;
    persistActivity(selectedClient.id, entry);
  }

  function handleDeleteActivity(entryId) {
    if (!selectedClient) return;
    setState((current) =>
      deleteActivityEntry(current, selectedClient.id, entryId),
    );
    deleteSupabaseActivity(entryId).then(() => {
      auditSilently({
        entityType: "activity_log",
        entityId: entryId,
        action: "activity.delete",
        afterData: { clientId: selectedClient.id, clientName: selectedClient.name, entryId },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to delete activity:", error);
      window.alert(`Could not delete activity from Supabase: ${error.message}`);
    });
  }

  function handleAddTask(task) {
    if (!selectedClient) return;
    persistTask(selectedClient.id, task);
  }

  function handleUpdateTask(taskId, patch) {
    if (!selectedClient) return;
    setState((current) =>
      updateTask(current, selectedClient.id, taskId, patch),
    );
    updateSupabaseTask(taskId, patch).then(() => {
      auditSilently({
        entityType: "task",
        entityId: taskId,
        action: "task.update",
        afterData: { clientId: selectedClient.id, clientName: selectedClient.name, taskId, patch },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to update task:", error);
      window.alert(`Could not save task to Supabase: ${error.message}`);
    });
  }

  function handleDeleteTask(taskId) {
    if (!selectedClient) return;
    setState((current) => deleteTask(current, selectedClient.id, taskId));
    deleteSupabaseTask(taskId).then(() => {
      auditSilently({
        entityType: "task",
        entityId: taskId,
        action: "task.delete",
        afterData: { clientId: selectedClient.id, clientName: selectedClient.name, taskId },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to delete task:", error);
      window.alert(`Could not delete task from Supabase: ${error.message}`);
    });
  }

  function persistActivity(clientId, entry) {
    setState((current) => addActivityEntry(current, clientId, entry));
    insertSupabaseActivity(clientId, entry).then(() => {
      auditSilently({
        entityType: "activity_log",
        entityId: entry.id,
        action: "activity.create",
        afterData: { clientId, ...entry },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to save activity:", error);
      window.alert(`Could not save activity to Supabase: ${error.message}`);
    });
  }

  function persistTask(clientId, task) {
    setState((current) => addTask(current, clientId, task));
    insertSupabaseTask(clientId, task).then(() => {
      auditSilently({
        entityType: "task",
        entityId: task.id,
        action: "task.create",
        afterData: { clientId, ...task },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to save task:", error);
      window.alert(`Could not save task to Supabase: ${error.message}`);
    });
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
      const entry = {
        id: `act-send-${Date.now()}`,
        type: "Message",
        text: `Daily update sent (${dailyImport.date})`,
        createdAt: new Date().toISOString(),
      };
      setState((current) =>
        addActivityEntry(current, selectedClient.id, entry),
      );
      insertSupabaseActivity(selectedClient.id, entry).catch((error) =>
        console.error("[CRM] Failed to save report activity:", error),
      );
    });
  }

  function copyWeeklyReport() {
    if (!selectedClient) return;
    const text = buildWeeklyMessageReport(selectedClient);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopyWeekDone(true);
      setTimeout(() => setCopyWeekDone(false), 2000);
      const entry = {
        id: `act-wsend-${Date.now()}`,
        type: "Message",
        text: `Weekly summary sent`,
        createdAt: new Date().toISOString(),
      };
      setState((current) =>
        addActivityEntry(current, selectedClient.id, entry),
      );
      insertSupabaseActivity(selectedClient.id, entry).catch((error) =>
        console.error("[CRM] Failed to save weekly activity:", error),
      );
    });
  }

  function closeImport() {
    if (!selectedClient || !dailyImport) return;
    const flags = (dailyImport.flags || []).filter(
      (f) =>
        f.severity === "Critical" &&
        f.status !== "Resolved" &&
        f.status !== "Acknowledged",
    );
    const client = selectedClient;
    const importRecord = dailyImport;
    setWorkspaceConfirmAction({
      title: `Close ${client.name} for ${importRecord.date}?`,
      description: flags.length
        ? `This close has ${flags.length} unresolved critical flag${flags.length > 1 ? "s" : ""}. Closing locks the close record.`
        : "This marks the day as closed and locks the close record.",
      confirmLabel: "Close day",
      busyLabel: "Closing...",
      variant: flags.length ? "danger" : undefined,
      onConfirm: () => performCloseImport(client, importRecord),
    });
  }

  function performCloseImport(client, importRecord) {
    setState((current) =>
      updateImportStatus(current, client.id, importRecord.id, "Closed"),
    );
    updateSupabaseDailyImportStatus(importRecord.id, "Closed").then(() => {
      auditSilently({
        entityType: "daily_import",
        entityId: importRecord.id,
        action: "daily_import.close",
        beforeData: { status: importRecord.status },
        afterData: { clientId: client.id, clientName: client.name, dailyImportId: importRecord.id, status: "Closed" },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to close day:", error);
      window.alert(`Could not close day in Supabase: ${error.message}`);
    });
  }

  function reopenImport() {
    if (!selectedClient || !dailyImport) return;
    const client = selectedClient;
    const importRecord = dailyImport;
    setWorkspaceConfirmAction({
      title: `Reopen ${client.name} for ${importRecord.date}?`,
      description: 'The close will return to "Needs review" status.',
      confirmLabel: "Reopen day",
      busyLabel: "Reopening...",
      onConfirm: () => performReopenImport(client, importRecord),
    });
  }

  function performReopenImport(client, importRecord) {
    setState((current) =>
      updateImportStatus(
        current,
        client.id,
        importRecord.id,
        "Needs review",
      ),
    );
    updateSupabaseDailyImportStatus(importRecord.id, "Needs review").then(() => {
      auditSilently({
        entityType: "daily_import",
        entityId: importRecord.id,
        action: "daily_import.reopen",
        beforeData: { status: importRecord.status },
        afterData: { clientId: client.id, clientName: client.name, dailyImportId: importRecord.id, status: "Needs review" },
      });
    }).catch(
      (error) => {
        console.error("[CRM] Failed to reopen day:", error);
        window.alert(`Could not reopen day in Supabase: ${error.message}`);
      },
    );
  }

  function closeAllToday() {
    const today = todayIsoDate();
    const toClose = currentCamClients.filter((c) => {
      const imp = getClientImportByDate(c, today);
      return imp && imp.status !== "Closed";
    });
    if (!toClose.length) {
      window.alert(
        "No open imports for today — all clients are already closed or have no upload.",
      );
      return;
    }
    const critCount = toClose.reduce((n, c) => {
      const imp = getClientImportByDate(c, today);
      return (
        n +
        (imp?.flags || []).filter(
          (f) =>
            f.severity === "Critical" &&
            f.status !== "Resolved" &&
            f.status !== "Acknowledged",
        ).length
      );
    }, 0);
    setWorkspaceConfirmAction({
      title: `Close today for ${toClose.length} client${toClose.length !== 1 ? "s" : ""}?`,
      description: critCount
        ? `There are ${critCount} unresolved critical flag${critCount !== 1 ? "s" : ""} across these clients.`
        : "This marks today's uploaded imports as closed.",
      confirmLabel: "Close all",
      busyLabel: "Closing...",
      variant: critCount ? "danger" : undefined,
      onConfirm: () => performCloseAllToday(toClose, today),
    });
  }

  function performCloseAllToday(toClose, today) {
    setState((current) =>
      toClose.reduce((s, c) => {
        const imp = getClientImportByDate(c, today);
        return imp ? updateImportStatus(s, c.id, imp.id, "Closed") : s;
      }, current),
    );
    Promise.all(
      toClose.map((client) => {
        const imp = getClientImportByDate(client, today);
        return imp
          ? updateSupabaseDailyImportStatus(imp.id, "Closed")
          : Promise.resolve();
      }),
    ).then(() => {
      auditSilently({
        entityType: "daily_import",
        entityId: null,
        action: "daily_import.bulk_close",
        afterData: {
          closeDate: today,
          clientCount: toClose.length,
          clientIds: toClose.map((client) => client.id),
        },
      });
    }).catch((error) => {
      console.error("[CRM] Failed to close all today:", error);
      window.alert(`Could not close all days in Supabase: ${error.message}`);
    });
  }

  function recalculateImport() {
    if (!selectedClient || !dailyImport) return;
    const recalculated = recalculateDailyImport({
      dailyImport,
      registry: selectedClient.accountRegistry,
    });
    setState((current) =>
      replaceDailyImport(current, selectedClient.id, recalculated),
    );
    replaceSupabaseOperationalFlags(
      selectedClient.id,
      dailyImport.id,
      recalculated.flags || [],
      recalculated.status,
    )
      .then((savedFlags) => {
        auditSilently({
          entityType: "daily_import",
          entityId: dailyImport.id,
          action: "daily_import.recalculate_flags",
          afterData: {
            clientId: selectedClient.id,
            clientName: selectedClient.name,
            dailyImportId: dailyImport.id,
            flagCount: savedFlags.length,
            status: recalculated.status,
          },
        });
        setState((current) =>
          replaceDailyImport(current, selectedClient.id, {
            ...recalculated,
            flags: savedFlags,
          }),
        );
      })
      .catch((error) => {
        console.error("[CRM] Failed to recalculate flags in Supabase:", error);
        window.alert(
          `Could not recalculate flags in Supabase: ${error.message}`,
        );
      });
  }

  if (window.location.pathname === "/database") return <DatabaseCheck />;

  if (!session) {
    return (
      <LoginScreen
        onLogin={(user) => {
          persistSession(user);
          if (user.role === USER_ROLES.CAM && user.camProfileId) {
            openCamWorkspace(user.camProfileId);
          } else {
            openManagerWorkspace();
          }
        }}
      />
    );
  }

  if (platformView === "manager" && !isManagerSession) {
    return null;
  }

  if (platformView === "manager") {
    return (
      <ErrorBoundary>
        <>
          <ManagerOverview
            clients={state.clients}
            camProfiles={state.camProfiles}
            onOpenCam={openCamWorkspace}
            onCreateCam={(name) => {
              createSupabaseCamProfile(name)
                .then((savedProfile) => {
                  auditSilently({
                    entityType: "cam_profile",
                    entityId: savedProfile?.id || null,
                    action: "cam_profile.create",
                    afterData: { name },
                  });
                  return reloadSupabaseState();
                })
                .catch((error) => {
                  console.error("[CRM] Failed to create CAM profile:", error);
                  window.alert(`Could not save CAM profile to Supabase: ${error.message}`);
                });
            }}
            onUpdateCamProfile={(camProfileId, patch) => {
              setState((current) => ({
                ...current,
                camProfiles: (current.camProfiles || []).map((profile) =>
                  profile.id === camProfileId ? { ...profile, ...patch } : profile,
                ),
              }));
              updateSupabaseCamProfile(camProfileId, patch)
                .then(() => {
                  auditSilently({
                    entityType: "cam_profile",
                    entityId: camProfileId,
                    action: "cam_profile.permissions.update",
                    afterData: { camProfileId, patch, source: "manager" },
                  });
                })
                .catch((error) => {
                  console.error("[CRM] Failed to update CAM permissions:", error);
                  window.alert(`Could not save CAM permission to Supabase: ${error.message}`);
                });
            }}
            onLogout={handleLogout}
            users={users}
            onUsersChange={setUsers}
            onRefreshState={() => reloadSupabaseState(null)}
            session={session}
            onUpdateClientAccount={persistAccountUpdate}
            onTransferClient={(clientId, toCamId) => {
              setState((current) => transferClient(current, clientId, toCamId));
              transferSupabaseClient(clientId, toCamId)
                .then(() => {
                  auditSilently({
                    entityType: "client_assignment",
                    entityId: clientId,
                    action: "client.transfer",
                    afterData: { clientId, toCamId },
                  });
                  return reloadSupabaseState(toCamId);
                })
                .catch((error) => {
                  console.error("[CRM] Failed to transfer client:", error);
                  window.alert(`Could not transfer client in Supabase: ${error.message}`);
                });
            }}
            onResolveFlag={(clientId, importId, flagId, status = "Resolved") => {
              setState((current) =>
                resolveFlagInImport(current, clientId, importId, flagId, status),
              );
              updateSupabaseOperationalFlag(flagId, status).then(() => {
                auditSilently({
                  entityType: "operational_flag",
                  entityId: flagId,
                  action: status === "Resolved" ? "flag.resolve" : "flag.acknowledge",
                  afterData: { clientId, importId, flagId, status, source: "manager" },
                });
              }).catch((error) => {
                console.error("[CRM] Failed to update manager flag:", error);
                window.alert(
                  `Could not update flag in Supabase: ${error.message}`,
                );
              });
            }}
            onAddClient={(name, camId, stage) => {
              const clientName = String(name || "").trim();
              if (!clientName) return;
              setState((current) => {
                const withClient = addClient(current, clientName, camId || null);
                const newClient = withClient.clients.find(
                  (c) =>
                    c.name === clientName &&
                    !current.clients.find((x) => x.id === c.id),
                );
                if (newClient && stage && stage !== "Active") {
                  return {
                    ...withClient,
                    clients: withClient.clients.map((c) =>
                      c.id === newClient.id
                        ? { ...c, profile: { ...c.profile, stage } }
                        : c,
                    ),
                  };
                }
                return withClient;
              });
              createSupabaseClient(clientName, camId || null, stage || "Active")
                .then((savedClient) => {
                  auditSilently({
                    entityType: "client",
                    entityId: savedClient?.id || null,
                    action: "client.create",
                    afterData: { clientName, camProfileId: camId || null, stage: stage || "Active", source: "manager" },
                  });
                  return reloadSupabaseState(camId || null);
                })
                .catch((error) => {
                  console.error("[CRM] Failed to create manager client:", error);
                  window.alert(`Could not save client "${clientName}" to Supabase: ${error.message}`);
                });
            }}
            onImportClient={async (row, camId) => {
              const savedClient = await createSupabaseClient(row.name, camId || null, row.stage || "Active");
              await updateSupabaseClient(savedClient.id, {
                profile: {
                  stage: row.stage || "Active",
                  fullName: row.name,
                  email: row.email,
                  additionalEmails: row.additionalEmails || [],
                  phone: row.phone,
                  timezone: row.timezone,
                  country: row.country,
                  startDate: row.startDate,
                  preferredChannel: row.preferredChannel,
                  language: row.language,
                  productKey: row.productKey,
                  propFirm: row.propFirm,
                  messenger: row.messenger,
                },
                credentials: row.credentials || undefined,
                propFirms: row.propFirms || [],
                notes: row.notes,
              });
              auditSilently({
                entityType: "client",
                entityId: savedClient.id,
                action: "client.import",
                afterData: { ...row, camProfileId: camId || null },
              });
              await reloadSupabaseState(camId || null);
            }}
            onAppendDailyImport={(clientId, result) =>
              persistDailyImport(clientId, result)
            }
          />
          <ConfirmActionDialog
            action={logoutConfirmAction}
            busy={logoutBusy}
            onCancel={() => {
              if (!logoutBusy) setLogoutConfirmAction(null);
            }}
            onConfirm={performLogout}
          />
        </>
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
                <button
                  className="sidebar-logout-btn"
                  onClick={handleLogout}
                  title="Sign out"
                >
                  <LogOut size={14} />
                </button>
              </div>
              <strong>
                {currentCamProfile?.name || state.accountManager.name}
              </strong>
              <small className="sidebar-role-sub">
                {session?.displayName || session?.username || ""} ·{" "}
                {session?.role || "CAM"}
              </small>
              <small
                className={`sidebar-role-sub ${remoteStatus.status === "error" ? "negative" : remoteStatus.status === "connected" ? "positive" : ""}`}
              >
                Data:{" "}
                {remoteStatus.status === "connected"
                  ? "Supabase"
                  : remoteStatus.status === "loading"
                    ? "Connecting..."
                    : "Supabase required"}
              </small>
              <div className="backup-actions">
                {isManagerSession ? (
                  <button
                    className="ghost-button"
                    onClick={openManagerWorkspace}
                  >
                    <Users size={14} /> Team
                  </button>
                ) : null}
              </div>
            </div>
            {canCreateDeleteClients ? (
              <form className="client-form" onSubmit={handleAddClient}>
                <input
                  value={newClientName}
                  placeholder="New client"
                  onChange={(event) => setNewClientName(event.target.value)}
                />
                <button>
                  <Plus size={16} />
                </button>
              </form>
            ) : null}
            <div className="sidebar-search-group">
              <button
                className="global-search-trigger"
                onClick={() => {
                  setGlobalSearchOpen(true);
                  setGlobalSearchQuery("");
                }}
                title={
                  isManagerSession
                    ? "Search all clients (⌘K)"
                    : "Search your clients (⌘K)"
                }
              >
                <Search size={14} />
                <span>
                  {isManagerSession ? "Search all..." : "Search clients..."}
                </span>
                <kbd>⌘K</kbd>
              </button>
              <input
                className="client-search"
                value={clientSearch}
                placeholder="Filter client list..."
                onChange={(e) => setClientSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setClientSearch("");
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const list = e.currentTarget
                      .closest("aside")
                      ?.querySelectorAll(".client-link");
                    if (list?.length) list[0].focus();
                  }
                }}
              />
            </div>
            <nav className="client-list">
              {!isFilteringClientList ? (
                <>
                  {(() => {
                    const today = todayIsoDate();
                    const urgentCount = currentCamClients.reduce((total, c) => {
                      const critFlags = (
                        c.dailyImports?.at(-1)?.flags || []
                      ).filter(
                        (f) =>
                          f.severity === "Critical" &&
                          f.status !== "Resolved" &&
                          f.status !== "Acknowledged",
                      ).length;
                      const overdueTasks = (c.tasks || []).filter(
                        (t) => !t.done && t.dueDate && t.dueDate < today,
                      ).length;
                      return total + critFlags + overdueTasks;
                    }, 0);
                    return (
                      <button
                        className={
                          showOverview && !showSOP
                            ? "client-link active"
                            : "client-link"
                        }
                        onClick={() => {
                          setShowOverview(true);
                          setShowSOP(false);
                        }}
                      >
                        <Users size={16} />
                        <span>CAM Overview</span>
                        {urgentCount > 0 ? (
                          <em className="danger">{urgentCount} urgent</em>
                        ) : (
                          <em>Live</em>
                        )}
                      </button>
                    );
                  })()}
                  <button
                    className={showSOP ? "client-link active" : "client-link"}
                    onClick={() => {
                      setShowSOP(true);
                      setShowOverview(false);
                    }}
                  >
                    <CheckSquare size={16} />
                    <span>Daily SOP</span>
                    <em>Checklist</em>
                  </button>
                  {isManagerSession ? (
                    <>
                      <div className="nav-label">Other CAMs</div>
                      {visibleCamProfiles
                        .filter(
                          (profile) => profile.id !== state.accountManager?.id,
                        )
                        .map((profile) => (
                          <button
                            className="client-link"
                            key={profile.id}
                            onClick={() => openCamWorkspace(profile.id)}
                          >
                            <Users size={16} />
                            <span>{profile.name} CAM</span>
                            <em>{profile.status || "Active"}</em>
                          </button>
                        ))}
                    </>
                  ) : null}
                </>
              ) : null}
              {isFilteringClientList ? (
                (() => {
                  const searchResults = searchClients(
                    currentCamClients,
                    clientSearch,
                  );
                  return searchResults.length ? (
                    <>
                      <div className="nav-label">
                        {searchResults.length} match
                        {searchResults.length !== 1 ? "es" : ""}
                      </div>
                      {searchResults.map(({ client, matches }) => (
                        <button
                          key={client.id}
                          className={
                            !showOverview && selectedClient?.id === client.id
                              ? "client-link client-link-search active"
                              : "client-link client-link-search"
                          }
                          onClick={() => {
                            setState((current) =>
                              selectClient(current, client.id),
                            );
                            setShowOverview(false);
                            setShowSOP(false);
                            setClientSearch("");
                            markClientViewed(client.id);
                          }}
                        >
                          <span>{client.name}</span>
                          <div className="search-matches">
                            {matches.map((m, i) => (
                              <small
                                key={i}
                                className={`search-match-${m.type}`}
                              >
                                {m.label}
                              </small>
                            ))}
                          </div>
                        </button>
                      ))}
                    </>
                  ) : (
                    <div className="nav-label muted">
                      No matches for "{clientSearch}"
                    </div>
                  );
                })()
              ) : (
                <>
                  <div className="nav-label">Clients</div>
                  {currentCamClients.length === 0 && (
                    <div
                      style={{
                        padding: "10px 8px",
                        fontSize: 12,
                        color: "var(--muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      No clients yet. Type a name above and press{" "}
                      <kbd
                        style={{
                          fontSize: 10,
                          padding: "1px 4px",
                          border: "1px solid var(--border)",
                          borderRadius: 3,
                        }}
                      >
                        Enter
                      </kbd>{" "}
                      to add your first client.
                    </div>
                  )}
                  {[...currentCamClients]
                    .sort((a, b) => {
                      if (a.pinned && !b.pinned) return -1;
                      if (b.pinned && !a.pinned) return 1;
                      const urgencyScore = (c) => {
                        const bd = deriveClientBadge(c);
                        if (bd.tone === "danger") return 0;
                        if (bd.tone === "warning") return 1;
                        if (bd.tone === "muted" && bd.label !== "No data")
                          return 2;
                        return 3;
                      };
                      const diff = urgencyScore(a) - urgencyScore(b);
                      if (diff !== 0) return diff;
                      const critA = (
                        a.dailyImports?.at(-1)?.flags || []
                      ).filter(
                        (f) =>
                          f.severity === "Critical" &&
                          f.status !== "Resolved" &&
                          f.status !== "Acknowledged",
                      ).length;
                      const critB = (
                        b.dailyImports?.at(-1)?.flags || []
                      ).filter(
                        (f) =>
                          f.severity === "Critical" &&
                          f.status !== "Resolved" &&
                          f.status !== "Acknowledged",
                      ).length;
                      return critB - critA;
                    })
                    .map((client) => {
                      const badge = deriveClientBadge(client);
                      const todayClose = getClientImportByDate(
                        client,
                        todayIsoDate(),
                      );
                      const closeStatus = !todayClose
                        ? "no-close"
                        : todayClose.status === "Closed"
                          ? "closed"
                          : "uploaded";
                      return (
                        <button
                          className={
                            !showOverview && selectedClient?.id === client.id
                              ? "client-link active"
                              : "client-link"
                          }
                          key={client.id}
                          onClick={() => {
                            setState((current) =>
                              selectClient(current, client.id),
                            );
                            setShowOverview(false);
                            setShowSOP(false);
                            markClientViewed(client.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              e.currentTarget.nextElementSibling?.focus();
                            } else if (e.key === "ArrowUp") {
                              e.preventDefault();
                              (
                                e.currentTarget.previousElementSibling ||
                                e.currentTarget
                                  .closest("aside")
                                  ?.querySelector(".client-search")
                              )?.focus();
                            }
                          }}
                        >
                          <span
                            className={`close-dot close-dot-${closeStatus}`}
                            title={
                              closeStatus === "no-close"
                                ? "No files today"
                                : closeStatus === "closed"
                                  ? "Closed today"
                                  : "Uploaded · not closed"
                            }
                          />
                          {closeStatus === "uploaded" &&
                            !viewedClientIds.has(client.id) && (
                              <span
                                className="new-data-badge"
                                title="New data uploaded — not yet reviewed"
                              >
                                NEW
                              </span>
                            )}
                          <span>
                            {client.name}
                            {(() => {
                              const d = lastContactDaysAgo(client);
                              return d !== null && d > 3 ? (
                                <span
                                  className="last-contact-dot"
                                  title={`Last contact ${d}d ago`}
                                  style={{
                                    background:
                                      d > 7 ? "var(--error)" : "var(--warning)",
                                  }}
                                />
                              ) : null;
                            })()}
                            {(() => {
                              const td = todayIsoDate();
                              const tasks = (client.tasks || []).filter(
                                (t) => !t.done,
                              );
                              const overdue = tasks.filter(
                                (t) => t.dueDate && t.dueDate < td,
                              ).length;
                              const dueToday = tasks.filter(
                                (t) => t.dueDate === td,
                              ).length;
                              if (overdue)
                                return (
                                  <span
                                    style={{
                                      marginLeft: 3,
                                      fontSize: 9,
                                      fontWeight: 700,
                                      color: "var(--negative)",
                                      background: "rgba(239,68,68,0.15)",
                                      borderRadius: 3,
                                      padding: "1px 3px",
                                    }}
                                    title={`${overdue} overdue task${overdue !== 1 ? "s" : ""}`}
                                  >
                                    {overdue}
                                  </span>
                                );
                              if (dueToday)
                                return (
                                  <span
                                    style={{
                                      marginLeft: 3,
                                      fontSize: 9,
                                      fontWeight: 700,
                                      color: "var(--warning)",
                                      background: "rgba(245,158,11,0.15)",
                                      borderRadius: 3,
                                      padding: "1px 3px",
                                    }}
                                    title={`${dueToday} task${dueToday !== 1 ? "s" : ""} due today`}
                                  >
                                    {dueToday}
                                  </span>
                                );
                              return null;
                            })()}
                          </span>
                          {(() => {
                            const latest = client.dailyImports?.at(-1);
                            if (!latest) return null;
                            const pnl = (latest.snapshots || []).reduce(
                              (s, snap) =>
                                s + Number(snap.grossRealizedPnl || 0),
                              0,
                            );
                            return (
                              <small
                                className={
                                  pnl >= 0
                                    ? "sidebar-pnl positive"
                                    : "sidebar-pnl negative"
                                }
                              >
                                {pnl >= 0 ? "+" : ""}
                                {formatCurrency(pnl)}
                              </small>
                            );
                          })()}
                          <span
                            className={`pin-btn${client.pinned ? " pinned" : ""}`}
                            title={
                              client.pinned ? "Unpin client" : "Pin to top"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setState((s) => togglePinClient(s, client.id));
                              updateSupabaseClient(client.id, { pinned: !client.pinned }).then(() => {
                                auditSilently({
                                  entityType: "client",
                                  entityId: client.id,
                                  action: client.pinned ? "client.unpin" : "client.pin",
                                  beforeData: { pinned: Boolean(client.pinned) },
                                  afterData: { clientId: client.id, clientName: client.name, pinned: !client.pinned },
                                });
                              }).catch((error) => {
                                console.error("[CRM] Failed to pin client:", error);
                                window.alert(`Could not update pin for "${client.name}" in Supabase: ${error.message}`);
                              });
                            }}
                          >
                            ★
                          </span>
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
              <DailySOP camProfileId={currentCamProfile?.id} />
            </main>
          ) : showOverview ? (
            <>
              <CamOverview
                clients={currentCamClients}
                camProfiles={visibleCamProfiles}
                allClients={accessibleClients}
                strategySetRecords={strategySetIndex.records}
                strategySetIndexStatus={strategySetIndex.status}
                onSelectClient={(clientId) => {
                  setState((current) => selectClient(current, clientId));
                  setShowOverview(false);
                  setShowSOP(false);
                }}
                onAddClientTask={persistTask}
                onLogClientActivity={persistActivity}
                onCompleteTask={(clientId, taskId) => {
                  const patch = {
                    done: true,
                    doneAt: new Date().toISOString(),
                  };
                  setState((current) =>
                    updateTask(current, clientId, taskId, patch),
                  );
                  updateSupabaseTask(taskId, patch).catch((error) => {
                    console.error("[CRM] Failed to complete task:", error);
                    window.alert(
                      `Could not complete task in Supabase: ${error.message}`,
                    );
                  });
                }}
                monthlyGoal={currentCamProfile?.monthlyGoal || 0}
                onSetMonthlyGoal={(goal) => {
                  if (!currentCamProfile?.id) return;
                  setState((s) => ({
                    ...s,
                    camProfiles: (s.camProfiles || []).map((profile) =>
                      profile.id === currentCamProfile.id
                        ? { ...profile, monthlyGoal: goal }
                        : profile,
                    ),
                  }));
                  updateSupabaseCamProfile(currentCamProfile.id, { monthlyGoal: goal })
                    .then(() => {
                      auditSilently({
                        entityType: "cam_profile",
                        entityId: currentCamProfile.id,
                        action: "cam_profile.update_monthly_goal",
                        beforeData: { monthlyGoal: currentCamProfile.monthlyGoal || 0 },
                        afterData: { camProfileId: currentCamProfile.id, name: currentCamProfile.name, monthlyGoal: goal },
                      });
                    })
                    .catch((error) => {
                      console.error("[CRM] Failed to update CAM monthly goal:", error);
                      window.alert(`Could not save monthly goal to Supabase: ${error.message}`);
                    });
                }}
              />
            </>
          ) : (
            <main className="content">
              {!selectedClient ? (
                <div className="onboarding-empty">
                  <div className="onboarding-hero">
                    <Users size={36} />
                    <h2>
                      Welcome,{" "}
                      {session?.displayName || currentCamProfile?.name || "CAM"}
                    </h2>
                    <p className="muted">
                      Your workspace is ready. Here's how to get started:
                    </p>
                  </div>
                  <div className="onboarding-steps">
                    <div className="onboarding-step">
                      <span className="onboarding-step-num">1</span>
                      <div>
                        <strong>Add your clients</strong>
                        <p>
                          Use the <em>+ Add client</em> button in the left
                          sidebar to create a client profile for each trader you
                          manage. Enter their name, then configure their
                          accounts in the Account Registry tab.
                        </p>
                      </div>
                    </div>
                    <div className="onboarding-step">
                      <span className="onboarding-step-num">2</span>
                      <div>
                        <strong>Fill in client profile & credentials</strong>
                        <p>
                          In <em>Credentials & Notes</em>, save the client's VPS
                          IP, NinjaTrader login, email, and Telegram handle.
                          This is your quick-access reference during market
                          hours.
                        </p>
                      </div>
                    </div>
                    <div className="onboarding-step">
                      <span className="onboarding-step-num">3</span>
                      <div>
                        <strong>Upload daily NT files</strong>
                        <p>
                          After market close, export the Accounts + Strategies
                          CSV from NinjaTrader and upload both here. The
                          dashboard auto-generates flags, drawdown status, and
                          the client report.
                        </p>
                      </div>
                    </div>
                    <div className="onboarding-step">
                      <span className="onboarding-step-num">4</span>
                      <div>
                        <strong>Log activity & tasks</strong>
                        <p>
                          Use <em>Quick Log</em> (Alt+L) to record calls,
                          messages, and observations. Create tasks with due
                          dates so nothing falls through the cracks.
                        </p>
                      </div>
                    </div>
                  </div>
                  <p
                    className="muted"
                    style={{ textAlign: "center", fontSize: 12, marginTop: 16 }}
                  >
                    Tip: press <kbd>Alt+O</kbd> for CAM Overview ·{" "}
                    <kbd>Alt+S</kbd> for Daily SOP · <kbd>Alt+L</kbd> to
                    quick-log
                  </p>
                </div>
              ) : (
                <>
                  <div className="page-header">
                    <div>
                      <span className="eyebrow">Client workspace</span>
                      <h1
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        {selectedClient.name}
                        {selectedClient.profile?.stage &&
                        selectedClient.profile.stage !== "Active" ? (
                          <span
                            className={`client-stage-badge stage-${(selectedClient.profile.stage || "").toLowerCase().replace(" ", "-")}`}
                          >
                            {selectedClient.profile.stage}
                          </span>
                        ) : null}
                      </h1>
                      <p>
                        {dailyImport
                          ? `${dailyImport.status} · ${(dailyImport.flags || []).length} flags`
                          : "No close loaded for this date"}
                      </p>
                    </div>
                    <div className="header-actions client-primary-actions">
                      <div className="date-nav client-date-nav">
                        <button
                          className="ghost-button icon-only"
                          title="Previous day"
                          onClick={() => {
                            const d = new Date(selectedDate + "T12:00:00");
                            d.setDate(d.getDate() - 1);
                            setSelectedDate(d.toISOString().slice(0, 10));
                          }}
                        >
                          <ChevronLeft size={15} />
                        </button>
                        <label className="date-control">
                          <CalendarDays size={16} />
                          <input
                            type="date"
                            value={selectedDate}
                            onChange={(event) =>
                              setSelectedDate(event.target.value)
                            }
                          />
                        </label>
                        <button
                          className="ghost-button icon-only"
                          title="Next day"
                          onClick={() => {
                            const d = new Date(selectedDate + "T12:00:00");
                            d.setDate(d.getDate() + 1);
                            setSelectedDate(d.toISOString().slice(0, 10));
                          }}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </div>
                      <button
                        className="primary-button workspace-open-button"
                        disabled={!dailyImport}
                        onClick={() => setReportImport(dailyImport)}
                      >
                        <FileText size={16} /> Build Daily Report
                      </button>
                    </div>
                  </div>

                  <div className="operations-toolbar client-toolbar" aria-label="Client tools">
                    <span className="operations-toolbar-label">Tools</span>
                      <button
                        className={showQuickLog ? "secondary-button" : "ghost-button"}
                        disabled={!selectedClient}
                        onClick={() => setShowQuickLog((v) => !v)}
                        title="Quick Log (Alt+L)"
                      >
                        <Plus size={16} /> Quick Log
                      </button>
                      <button
                        className={showTemplates ? "secondary-button" : "ghost-button"}
                        disabled={!selectedClient}
                        onClick={() => setShowTemplates((v) => !v)}
                        title="Message templates for WhatsApp/Telegram"
                      >
                        <ClipboardList size={16} /> Templates
                      </button>
                      <button
                        className={showUpload || !dailyImport ? "secondary-button" : "ghost-button"}
                        onClick={() => setShowUpload((value) => !value)}
                        title="Upload NT CSV files (Alt+U)"
                      >
                        <Upload size={16} /> Upload Daily Files
                      </button>
                      <button
                        className="ghost-button"
                        disabled={!dailyImport}
                        onClick={copyClientReport}
                        title="Copy pre-formatted daily update for WhatsApp/Telegram"
                      >
                        <Copy size={16} />
                        {copyDone ? " Copied!" : " Copy Update"}
                      </button>
                      <button
                        className="ghost-button"
                        disabled={!selectedClient}
                        onClick={copyWeeklyReport}
                        title="Copy weekly summary for WhatsApp/Telegram"
                      >
                        <Copy size={16} />
                        {copyWeekDone ? " Copied!" : " Copy Week"}
                      </button>
                      {dailyImport?.status === "Closed" ? (
                        <button className="ghost-button" onClick={reopenImport}>
                          <RefreshCw size={16} /> Reopen Day
                        </button>
                      ) : (
                        <button
                          className="ghost-button"
                          disabled={!dailyImport}
                          onClick={closeImport}
                        >
                          <CheckCircle2 size={16} /> Close Day
                        </button>
                      )}
                      {(() => {
                        const today = todayIsoDate();
                        const openToday = currentCamClients.filter((c) => {
                          const imp = getClientImportByDate(c, today);
                          return imp && imp.status !== "Closed";
                        });
                        if (openToday.length < 2) return null;
                        return (
                          <button
                            className="ghost-button"
                            onClick={closeAllToday}
                            title="Close today for all clients that have an upload"
                          >
                            <CheckCircle2 size={16} /> Close all (
                            {openToday.length})
                          </button>
                          );
                        })()}
                  </div>

                  {!dailyImport &&
                    selectedClient &&
                    !selectedClient.dailyImports?.length && (
                      <OnboardingChecklist
                        client={selectedClient}
                        onSwitchTab={setActiveTab}
                      />
                    )}
                  {showUpload || !dailyImport ? (
                    <UploadArea onParsed={handleParsedFiles} />
                  ) : null}

                  {showQuickLog && selectedClient && (
                    <form
                      className="quick-log-panel"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!quickLogText.trim()) return;
                        handleAddActivity({
                          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                          type: quickLogType,
                          text: quickLogText.trim(),
                          accountName: quickLogAccount,
                          createdAt: new Date().toISOString(),
                        });
                        setQuickLogText("");
                        setQuickLogAccount("");
                        setShowQuickLog(false);
                      }}
                    >
                      <select
                        value={quickLogType}
                        onChange={(e) => setQuickLogType(e.target.value)}
                      >
                        {ACTIVITY_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <select
                        value={quickLogAccount}
                        onChange={(e) => setQuickLogAccount(e.target.value)}
                      >
                        <option value="">All accounts</option>
                        {Object.values(
                          selectedClient.accountRegistry || {},
                        ).map((a) => (
                          <option key={a.accountName} value={a.accountName}>
                            {a.alias || a.accountName}
                          </option>
                        ))}
                      </select>
                      <input
                        autoFocus
                        value={quickLogText}
                        placeholder="What happened? (call outcome, action taken, client feedback...)"
                        onChange={(e) => setQuickLogText(e.target.value)}
                      />
                      <button className="primary-button" type="submit">
                        <SquarePen size={14} /> Add Log
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => setShowQuickLog(false)}
                      >
                        Cancel
                      </button>
                    </form>
                  )}

                  {showTemplates &&
                    selectedClient &&
                    (() => {
                      const clientName =
                        selectedClient.profile?.fullName || selectedClient.name;
                      const templates = [
                        {
                          label: "Daily update",
                          text: `Hola ${clientName} 👋\n\nAquí tu resumen de hoy:\n📊 P&L: [AMOUNT]\n📉 Drawdown buffer: [BUFFER]\n✅ Todo bien — seguimos mañana!`,
                        },
                        {
                          label: "Drawdown warning",
                          text: `Hola ${clientName} — quick update:\n\n⚠️ Tu cuenta está acercándose al límite de drawdown.\n💰 Buffer restante: [BUFFER]\n\nVamos a monitorear de cerca. Si tienes dudas, avísame.`,
                        },
                        {
                          label: "Eval passed",
                          text: `🎉 Buenas noticias ${clientName}!\n\nTu cuenta de evaluación **PASÓ**.\n✅ Pasando al proceso de fondeo.\n📋 Próximos pasos: [STEPS]\n\nFelicidades!`,
                        },
                        {
                          label: "Payout processing",
                          text: `Hola ${clientName} 👋\n\n💸 Tu payout ha sido solicitado y está en proceso.\n📅 Tiempo estimado: 3–5 días hábiles.\n\nAvisamos cuando se confirme.`,
                        },
                        {
                          label: "Weekly check-in",
                          text: `Hola ${clientName} — resumen semanal:\n\n📅 Semana del [DATE]\n📊 P&L semana: [WEEKLY_PNL]\n📈 Días positivos: [WIN_DAYS]/[TOTAL_DAYS]\n\nSeguimos la próxima semana. Cualquier duda, aquí estamos!`,
                        },
                        {
                          label: "Account at risk",
                          text: `${clientName} — importante:\n\n🚨 Tu cuenta está en zona de riesgo.\nDrawdown buffer: [BUFFER]\n\nPor favor revisa tu VPS y confirma que todo esté corriendo bien. Si necesitas pausar la estrategia, avísame ANTES de hacer cambios.`,
                        },
                        {
                          label: "VPS issue detected",
                          text: `Hola ${clientName} 👋\n\n🖥️ Detecté una posible desconexión en tu VPS.\nVerifiqué [ACCOUNT] — [STATUS].\n\nTe aviso si hay algo que necesite tu atención.`,
                        },
                      ];
                      return (
                        <div className="templates-panel">
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              marginBottom: 8,
                            }}
                          >
                            <strong style={{ fontSize: 13 }}>
                              Message templates
                            </strong>
                            <button
                              className="ghost-button"
                              style={{ fontSize: 11 }}
                              onClick={() => setShowTemplates(false)}
                            >
                              ✕ Close
                            </button>
                          </div>
                          <div className="templates-grid">
                            {templates.map((t) => (
                              <button
                                key={t.label}
                                className="ghost-button"
                                style={{
                                  textAlign: "left",
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  justifyContent: "flex-start",
                                }}
                                onClick={() => {
                                  navigator.clipboard.writeText(t.text);
                                  setShowTemplates(false);
                                  handleAddActivity({
                                    id: `act-${Date.now()}`,
                                    type: "Message",
                                    text: `Template sent: ${t.label}`,
                                    createdAt: new Date().toISOString(),
                                  });
                                }}
                              >
                                <Copy size={12} /> {t.label}
                              </button>
                            ))}
                          </div>
                          <p
                            className="muted"
                            style={{ fontSize: 11, marginTop: 6 }}
                          >
                            Clicking copies template to clipboard and logs it as
                            a Message activity.
                          </p>
                        </div>
                      );
                    })()}

                  {todayActions.length > 0 && (
                    <div className="today-banner">
                      {todayActions.map((a, i) => (
                        <div
                          key={i}
                          className={`today-banner-item today-banner-${a.severity}`}
                        >
                          <span>{a.icon}</span>
                          <span>{a.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <PinnedNote
                    note={selectedClient.pinnedNote || ""}
                    onSave={(v) => handleUpdateClient({ pinnedNote: v })}
                  />

                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Client workspace sections"
                  >
                    {visibleTabs.map((tab) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={effectiveActiveTab === tab}
                        className={effectiveActiveTab === tab ? "active" : ""}
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  <div
                    className="tab-content"
                    role="tabpanel"
                    aria-label={effectiveActiveTab}
                  >
                    {effectiveActiveTab === "Overview" ? (
                      <ClientOverview
                        client={selectedClient}
                        dailyImport={dailyImport}
                        allClients={accessibleClients}
                        onRequestMonthlyReport={(month) =>
                          setMonthlyReportMonth(month)
                        }
                        onLogPayout={handleLogPayout}
                      />
                    ) : null}
                    {effectiveActiveTab === "Activity" ? (
                      <ActivityLog
                        client={selectedClient}
                        onAddEntry={handleAddActivity}
                        onDeleteEntry={handleDeleteActivity}
                      />
                    ) : null}
                    {effectiveActiveTab === "Tasks" ? (
                      <TasksTab
                        client={selectedClient}
                        onAddTask={handleAddTask}
                        onUpdateTask={handleUpdateTask}
                        onDeleteTask={handleDeleteTask}
                      />
                    ) : null}
                    {effectiveActiveTab === "Credentials & Notes" ? (
                      <CredentialsTab
                        client={selectedClient}
                        onUpdateClient={handleUpdateClient}
                        onDeleteClient={handleDeleteClient}
                        canDeleteClient={canCreateDeleteClients}
                      />
                    ) : null}
                    {effectiveActiveTab === "Price Checks" ? (
                      <PriceChecksTab
                        client={selectedClient}
                        onUpdateClient={handleUpdateClient}
                      />
                    ) : null}
                    {effectiveActiveTab === "Stack Playbook" ? (
                      <StackPlaybook
                        client={selectedClient}
                        dailyImport={dailyImport}
                        onUpdateAccount={handleAccountUpdate}
                        allClients={accessibleClients}
                      />
                    ) : null}
                    {["Review", "Evaluations", "Funded", "Cash"].includes(
                      effectiveActiveTab,
                    ) ? (
                      <>
                        <Dashboard
                          dailyImport={dailyImport}
                          rows={currentTabData.snapshots}
                          title={effectiveActiveTab}
                          mode={tabMode(effectiveActiveTab)}
                          onBuildReport={() => setReportImport(dailyImport)}
                          onRecalculate={recalculateImport}
                          onResolveFlag={handleResolveFlag}
                          onBulkResolveFlags={handleBulkResolveFlags}
                          onUpdateAccount={handleAccountUpdate}
                          strategySetRecords={strategySetIndex.records}
                          client={selectedClient}
                        />
                        <section className="panel">
                          <button
                            className="registry-toggle"
                            onClick={() => setRegistryOpen((value) => !value)}
                          >
                            <ChevronDown
                              className={
                                registryOpen ? "chevron open" : "chevron"
                              }
                              size={16}
                            />
                            <h3>Account Registry</h3>
                            <span className="muted">
                              Manual classification persists across days.
                            </span>
                            <span className="count">
                              {Object.keys(currentTabData.accounts).length}
                            </span>
                          </button>
                          {registryOpen ? (
                            <AccountManager
                              {...currentTabData}
                              mode={tabMode(effectiveActiveTab)}
                              onUpdateAccount={handleAccountUpdate}
                              onAddAccount={(accountName, meta) => {
                                if (!selectedClient || !accountName.trim())
                                  return;
                                setState((current) =>
                                  upsertAccountMeta(
                                    current,
                                    selectedClient.id,
                                    accountName.trim(),
                                    meta,
                                  ),
                                );
                                upsertSupabaseTradingAccount(
                                  selectedClient.id,
                                  accountName.trim(),
                                  meta,
                                ).then((savedAccount) => {
                                  auditSilently({
                                    entityType: "trading_account",
                                    entityId: savedAccount?.id || accountName.trim(),
                                    action: "account.create",
                                    afterData: {
                                      clientId: selectedClient.id,
                                      clientName: selectedClient.name,
                                      accountName: accountName.trim(),
                                      meta,
                                    },
                                  });
                                }).catch((error) => {
                                  console.error(
                                    "[CRM] Failed to add trading account:",
                                    error,
                                  );
                                  window.alert(
                                    `Could not save "${accountName}" to Supabase: ${error.message}`,
                                  );
                                });
                              }}
                              onRemoveAccount={(accountName) => {
                                requestRemoveAccount(accountName);
                              }}
                            />
                          ) : null}
                        </section>
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </main>
          )}
        </div>
        {reportImport ? (
          <ReportPanel
            client={selectedClient}
            dailyImport={reportImport}
            onClose={() => setReportImport(null)}
          />
        ) : null}
        {monthlyReportMonth ? (
          <MonthlyReportPanel
            client={selectedClient}
            month={monthlyReportMonth}
            onClose={() => setMonthlyReportMonth(null)}
          />
        ) : null}
        {showShortcuts && (
          <div
            className="global-search-overlay"
            onClick={() => setShowShortcuts(false)}
          >
            <div
              className="global-search-modal"
              style={{ maxWidth: 480 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  padding: "16px 20px",
                  borderBottom: "1px solid var(--line)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <strong>Keyboard shortcuts</strong>
                <button
                  className="ghost-button"
                  onClick={() => setShowShortcuts(false)}
                >
                  ✕
                </button>
              </div>
              <div
                style={{
                  padding: "16px 20px",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "8px 20px",
                  fontSize: 13,
                }}
              >
                {[
                  ["⌘K", "Global search (all clients, activities, tasks)"],
                  ["Alt+L", "Toggle Quick Log panel"],
                  ["Alt+U", "Toggle CSV upload panel"],
                  ["Alt+O", "Go to CAM Overview"],
                  ["↑ ↓ Enter", "Navigate search results"],
                  ["Esc", "Close any modal"],
                  ["?", "Show this panel"],
                ].map(([k, v]) => (
                  <>
                    <kbd
                      style={{
                        background: "var(--surface-3)",
                        border: "1px solid var(--line)",
                        borderRadius: 4,
                        padding: "2px 7px",
                        fontSize: 11,
                        fontFamily: "monospace",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {k}
                    </kbd>
                    <span className="muted">{v}</span>
                  </>
                ))}
              </div>
            </div>
          </div>
        )}
        {globalSearchOpen &&
          (() => {
            const q = globalSearchQuery.toLowerCase().trim();
            const clients = accessibleClients;
            const results = !q
              ? []
              : clients
                  .flatMap((client) => {
                    const hits = [];
                    (client.activityLog || [])
                      .filter((e) => e.text?.toLowerCase().includes(q))
                      .forEach((e) =>
                        hits.push({
                          client,
                          kind: "Activity",
                          text: e.text,
                          sub:
                            e.type + " · " + (e.createdAt || "").slice(0, 10),
                          tab: "Activity",
                        }),
                      );
                    (client.tasks || [])
                      .filter((t) => t.text?.toLowerCase().includes(q))
                      .forEach((t) =>
                        hits.push({
                          client,
                          kind: "Task",
                          text: t.text,
                          sub:
                            (t.done ? "✓ Done" : "Open") +
                            (t.dueDate ? " · due " + t.dueDate : ""),
                          tab: "Tasks",
                        }),
                      );
                    const profile = client.profile || {};
                    if (
                      [
                        profile.fullName,
                        profile.email,
                        profile.phone,
                        profile.messenger,
                        profile.notes,
                      ].some((v) => v?.toLowerCase().includes(q))
                    ) {
                      hits.push({
                        client,
                        kind: "Profile",
                        text: profile.fullName || client.name,
                        sub: "Profile / notes",
                        tab: "Credentials & Notes",
                      });
                    }
                    Object.values(client.accountRegistry || {})
                      .filter(
                        (a) =>
                          a.accountName?.toLowerCase().includes(q) ||
                          a.alias?.toLowerCase().includes(q),
                      )
                      .forEach((a) => {
                        hits.push({
                          client,
                          kind: "Account",
                          text: a.alias || a.accountName,
                          sub: `${a.accountType || "Account"} · ${a.accountName}`,
                          tab: "Overview",
                        });
                      });
                    if (client.name?.toLowerCase().includes(q)) {
                      hits.unshift({
                        client,
                        kind: "Client",
                        text: client.name,
                        sub: "Client name match",
                        tab: "Overview",
                      });
                    }
                    return hits;
                  })
                  .slice(0, 30);
            return (
              <div
                className="global-search-overlay"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setGlobalSearchOpen(false);
                }}
              >
                <div className="global-search-modal">
                  <div className="global-search-bar">
                    <Search className="global-search-icon" size={16} />
                    <input
                      autoFocus
                      value={globalSearchQuery}
                      onChange={(e) => {
                        setGlobalSearchQuery(e.target.value);
                        setGlobalSearchIdx(0);
                      }}
                      placeholder={
                        isManagerSession
                          ? "Search all clients — activity, tasks, notes…"
                          : "Search your clients — activity, tasks, notes…"
                      }
                      className="global-search-input"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setGlobalSearchOpen(false);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setGlobalSearchIdx((i) =>
                            Math.min(i + 1, results.length - 1),
                          );
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setGlobalSearchIdx((i) => Math.max(i - 1, 0));
                        } else if (
                          e.key === "Enter" &&
                          results[globalSearchIdx]
                        ) {
                          e.preventDefault();
                          const r = results[globalSearchIdx];
                          setGlobalSearchOpen(false);
                          const ownerCam = isManagerSession
                            ? visibleCamProfiles.find((p) =>
                                (p.clientIds || []).includes(r.client.id),
                              )
                            : currentCamProfile;
                          if (ownerCam) openCamWorkspace(ownerCam.id, r.client.id);
                          else setState((s) => selectClient(s, r.client.id));
                          setShowOverview(false);
                          setShowSOP(false);
                          setActiveTab(r.tab);
                        }
                      }}
                    />
                    <kbd
                      className="global-search-esc"
                      onClick={() => setGlobalSearchOpen(false)}
                    >
                      esc
                    </kbd>
                  </div>
                  <div className="global-search-results">
                    {!q && (
                      <div className="global-search-hint muted">
                        {isManagerSession
                          ? "Type to search across all clients"
                          : "Type to search your assigned clients"}
                      </div>
                    )}
                    {q && !results.length && (
                      <div className="global-search-hint muted">
                        No results for "{globalSearchQuery}"
                      </div>
                    )}
                    {results.map((r, i) => (
                      <button
                        key={i}
                        className={`global-search-result${i === globalSearchIdx ? " global-search-active" : ""}`}
                        onClick={() => {
                          setGlobalSearchOpen(false);
                          const ownerCam = isManagerSession
                            ? visibleCamProfiles.find((p) =>
                                (p.clientIds || []).includes(r.client.id),
                              )
                            : currentCamProfile;
                          if (ownerCam) openCamWorkspace(ownerCam.id, r.client.id);
                          else setState((s) => selectClient(s, r.client.id));
                          setShowOverview(false);
                          setShowSOP(false);
                          setActiveTab(r.tab);
                        }}
                      >
                        <span
                          className={`global-search-kind kind-${r.kind.toLowerCase()}`}
                        >
                          {r.kind}
                        </span>
                        <span className="global-search-text">{r.text}</span>
                        <span className="global-search-sub muted">
                          {r.client.name} · {r.sub}
                        </span>
                      </button>
                    ))}
                  </div>
                  {q && results.length > 0 && (
                    <div className="global-search-footer muted">
                      {results.length} result{results.length !== 1 ? "s" : ""} ·
                      click to navigate
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        <ConfirmActionDialog
          action={workspaceConfirmAction}
          onCancel={() => setWorkspaceConfirmAction(null)}
          onConfirm={runWorkspaceConfirmAction}
        />
        <ConfirmActionDialog
          action={logoutConfirmAction}
          busy={logoutBusy}
          onCancel={() => {
            if (!logoutBusy) setLogoutConfirmAction(null);
          }}
          onConfirm={performLogout}
        />
      </>
    </ErrorBoundary>
  );
}
