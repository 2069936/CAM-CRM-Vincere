import { buildClientSegments } from './clientSegments';

function ciLookup(registry, accountName) {
  if (!registry || !accountName) return {};
  if (registry[accountName]) return registry[accountName];
  const lower = accountName.toLowerCase();
  const key = Object.keys(registry).find(k => k.toLowerCase() === lower);
  return key ? registry[key] : {};
}

export function buildWeeklyMessageReport(client) {
  if (!client) return '';
  const imports = (client.dailyImports || []);
  if (!imports.length) return '';

  // Last 5 trade days (Mon-Fri, ignoring no-close days)
  const recent = imports.slice(-7).filter((di) => di.status === 'Closed' || di.snapshots?.length > 0);
  if (!recent.length) return '';

  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));

  const registry = client.accountRegistry || {};
  const dailyTotals = recent.map((di) => {
    const pnl = (di.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0);
    return { date: di.date, pnl };
  });

  const weekPnl = dailyTotals.reduce((s, d) => s + d.pnl, 0);
  const bestDay = dailyTotals.reduce((best, d) => d.pnl > best.pnl ? d : best, dailyTotals[0]);
  const worstDay = dailyTotals.reduce((worst, d) => d.pnl < worst.pnl ? d : worst, dailyTotals[0]);
  const positiveDays = dailyTotals.filter((d) => d.pnl > 0).length;

  const latestImport = recent.at(-1);
  const fundedSnaps = (latestImport?.snapshots || []).filter((s) => ciLookup(registry, s.accountName)?.accountType === 'Funded');

  const weekStart = recent[0]?.date;
  const weekEnd = recent.at(-1)?.date;

  const lines = [];
  lines.push(`📊 *Weekly Summary - ${weekStart} → ${weekEnd}*`);
  lines.push(`👤 ${client?.name || 'Client'}`);
  lines.push('');
  lines.push(`💰 *Net P&L:* ${sign(weekPnl)}${fmt(weekPnl)}`);
  lines.push(`📅 *Trading days:* ${recent.length} | ✅ Positive: ${positiveDays}`);
  lines.push(`📈 *Best day:* ${sign(bestDay.pnl)}${fmt(bestDay.pnl)} (${bestDay.date})`);
  if (worstDay.date !== bestDay.date) {
    lines.push(`📉 *Worst day:* ${sign(worstDay.pnl)}${fmt(worstDay.pnl)} (${worstDay.date})`);
  }
  lines.push('');

  if (fundedSnaps.length) {
    lines.push(`✅ *Funded Accounts (${fundedSnaps.length}):*`);
    for (const s of fundedSnaps) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const strats = (s.strategies || []).filter((st) => st.enabled).map((st) => st.strategyFamily || st.strategyName).join(', ');
      const dd = Number(s.trailingMaxDrawdown || 0);
      lines.push(`  • ${alias}${strats ? ` [${strats}]` : ''}${dd > 0 ? ` - Buffer: ${fmt(dd)}` : ''}`);
    }
    lines.push('');
  }

  lines.push(`_Great week! Any questions, reply here._`);
  return lines.join('\n');
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function summarizeAccountRows(rows = []) {
  const totals = rows.reduce(
    (acc, item) => ({
      grossRealizedPnl: acc.grossRealizedPnl + Number(item.grossRealizedPnl || 0),
      weeklyPnl: acc.weeklyPnl + Number(item.weeklyPnl || 0),
      aggregateBalance: acc.aggregateBalance + Number(item.accountBalance || 0),
      unrealizedPnl: acc.unrealizedPnl + Number(item.unrealizedPnl || 0),
    }),
    { grossRealizedPnl: 0, weeklyPnl: 0, aggregateBalance: 0, unrealizedPnl: 0 },
  );

  return {
    totals,
    counts: {
      accounts: rows.length,
    },
  };
}

export function buildClientMessageReport(client, dailyImport) {
  const snapshots = dailyImport?.snapshots || [];
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };

  const funded = snapshots.filter((s) => ciLookup(registry, s.accountName)?.accountType === 'Funded');
  const evals = snapshots.filter((s) => ciLookup(registry, s.accountName)?.accountType?.startsWith('Evaluation'));

  const totalDaily = snapshots.reduce((sum, s) => sum + Number(s.grossRealizedPnl || 0), 0);
  const totalWeekly = snapshots.reduce((sum, s) => sum + Number(s.weeklyPnl || 0), 0);

  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => formatCurrency(n);
  const date = dailyImport?.date || new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`📊 *Daily Update - ${date}*`);
  lines.push(`👤 ${client?.name || 'Client'}`);
  lines.push('');
  lines.push(`💰 *Daily P&L:* ${sign(totalDaily)}${fmt(totalDaily)}`);
  lines.push(`📈 *Weekly P&L:* ${sign(totalWeekly)}${fmt(totalWeekly)}`);
  lines.push('');

  if (funded.length) {
    lines.push(`✅ *Funded Accounts (${funded.length}):*`);
    for (const s of funded) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const dd = Number(s.trailingMaxDrawdown || 0);
      const pnl = Number(s.grossRealizedPnl || 0);
      const strats = (s.strategies || []).filter((st) => st.enabled).map((st) => st.strategyFamily || st.strategyName).join(', ');
      lines.push(`  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily${dd > 0 ? ` | Buffer: ${fmt(dd)}` : ''}${strats ? ` | ${strats}` : ''}`);
    }
    lines.push('');
  }

  if (evals.length) {
    lines.push(`🔄 *Evaluations (${evals.length}):*`);
    for (const s of evals) {
      const meta = ciLookup(registry, s.accountName) || {};
      const alias = meta.alias || s.accountName;
      const pnl = Number(s.grossRealizedPnl || 0);
      lines.push(`  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily`);
    }
    lines.push('');
  }

  lines.push('_Any questions? Reply to this message._');

  return lines.join('\n');
}

export function buildDailyReportSummary(client, dailyImport) {
  const snapshots = dailyImport?.snapshots || [];
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const grouped = {
    evaluations: [],
    funded: [],
    cash: [],
    ignored: [],
  };

  for (const snapshot of snapshots) {
    const meta = ciLookup(registry, snapshot.accountName) || {};
    const row = { ...snapshot, meta };
    if (meta.accountType === 'Cash') grouped.cash.push(row);
    else if (meta.accountType === 'Funded') grouped.funded.push(row);
    else if (meta.accountType === 'Inactive / Ignore') grouped.ignored.push(row);
    else if (meta.accountType?.startsWith('Evaluation')) grouped.evaluations.push(row);
    else grouped.ignored.push(row);
  }

  const allVisible = [...grouped.evaluations, ...grouped.funded, ...grouped.cash];
  const { totals } = summarizeAccountRows(allVisible);

  const openFlags = (dailyImport?.flags || []).filter((f) => f.status !== 'Resolved' && f.status !== 'Acknowledged');
  const criticalFlags = openFlags.filter((f) => f.severity === 'Critical');

  // Prior close for delta
  const imports = client?.dailyImports || [];
  const currentIdx = imports.findIndex((d) => d.date === dailyImport?.date);
  const priorImport = currentIdx > 0 ? imports[currentIdx - 1] : null;
  const priorDailyPnl = priorImport
    ? (priorImport.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0)
    : null;

  return {
    clientName: client?.name || 'Client',
    camName: '',
    date: dailyImport?.date || '',
    status: dailyImport?.status || 'No data',
    generatedAt: new Date().toISOString(),
    grouped,
    totals,
    // Per-account-type subtotals so the report can show balance + realized PnL
    // split by pool (Eval-standard / Funded / Cash / Bullet Bot) instead of one
    // combined total. Eval-standard is kept separate from Bullet Bot because a
    // bullet-bot eval is tracked by pass/fail, not by balance. Cash PnL is net
    // of fees (the NinjaTrader "Realized PnL" column already subtracts them).
    segments: buildClientSegments(client, dailyImport),
    priorDailyPnl,
    flags: dailyImport?.flags || [],
    openFlags,
    criticalFlags,
    counts: {
      accounts: allVisible.length,
      evaluations: grouped.evaluations.length,
      funded: grouped.funded.length,
      cash: grouped.cash.length,
      openFlags: openFlags.length,
      criticalFlags: criticalFlags.length,
    },
  };
}

// Every client's daily report for one date (for a CAM's "all clients for the
// day" export). Only clients that have an import on that date are included.
export function buildCamDayReport(clients = [], date) {
  const rows = [];
  for (const client of clients) {
    const dailyImport = (client.dailyImports || []).find((d) => d.date === date);
    if (!dailyImport) continue;
    rows.push({ client, dailyImport, report: buildDailyReportSummary(client, dailyImport) });
  }
  return rows.sort((a, b) => (b.report.totals.grossRealizedPnl || 0) - (a.report.totals.grossRealizedPnl || 0));
}

export function buildTeamWeeklyReport(clients, camProfiles) {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const sign = (n) => (n >= 0 ? '+' : '');
  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));

  const camSummaries = (camProfiles || []).map(cam => {
    const camClients = clients.filter(c => (cam.clientIds || []).includes(c.id));
    let weekPnl = 0, funded = 0, payouts = 0;
    camClients.forEach(c => {
      const weekImports = (c.dailyImports || []).filter(d => d.date >= weekStartStr);
      weekImports.forEach(d => { weekPnl += (d.snapshots || []).reduce((s, sn) => s + Number(sn.grossRealizedPnl || 0), 0); });
      funded += Object.values(c.accountRegistry || {}).filter(a => a.accountType === 'Funded' && a.status !== 'Failed').length;
      payouts += Object.values(c.accountRegistry || {}).reduce((n, meta) => n + (meta.payoutHistory || []).filter(p => p.date >= weekStartStr).length, 0);
    });
    return { cam, clients: camClients.length, weekPnl, funded, payouts };
  }).filter(r => r.clients > 0);

  const totalPnl = camSummaries.reduce((s, r) => s + r.weekPnl, 0);
  const totalPayouts = camSummaries.reduce((s, r) => s + r.payouts, 0);
  const totalFunded = camSummaries.reduce((s, r) => s + r.funded, 0);

  const lines = [
    `📊 *TEAM WEEKLY SUMMARY* - Week of ${weekStartStr}`,
    ``,
    `🏆 Portfolio P&L: *${sign(totalPnl)}${fmt(totalPnl)}*`,
    `💰 Payouts this week: ${totalPayouts}`,
    `📈 Funded accounts: ${totalFunded}`,
    ``,
    `*CAM Breakdown:*`,
    ...camSummaries.sort((a, b) => b.weekPnl - a.weekPnl).map((r, i) =>
      `${i + 1}. ${r.cam.name} - ${sign(r.weekPnl)}${fmt(r.weekPnl)} · ${r.clients} clients · ${r.funded} funded${r.payouts ? ` · ${r.payouts} payout${r.payouts !== 1 ? 's' : ''}` : ''}`
    ),
    ``,
    `Generated by CAM CRM · Drive Insight`,
  ];
  return lines.join('\n');
}
