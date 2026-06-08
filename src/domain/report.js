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
    const meta = registry[snapshot.accountName] || {};
    const row = { ...snapshot, meta };
    if (meta.accountType === 'Cash') grouped.cash.push(row);
    else if (meta.accountType === 'Funded') grouped.funded.push(row);
    else if (meta.accountType === 'Inactive / Ignore') grouped.ignored.push(row);
    else if (meta.accountType?.startsWith('Evaluation')) grouped.evaluations.push(row);
    else grouped.ignored.push(row);
  }

  const allVisible = [...grouped.evaluations, ...grouped.funded, ...grouped.cash];
  const { totals } = summarizeAccountRows(allVisible);

  return {
    clientName: client?.name || 'Client',
    date: dailyImport?.date || '',
    status: dailyImport?.status || 'No data',
    generatedAt: new Date().toISOString(),
    grouped,
    totals,
    flags: dailyImport?.flags || [],
    counts: {
      accounts: allVisible.length,
      evaluations: grouped.evaluations.length,
      funded: grouped.funded.length,
      cash: grouped.cash.length,
      openFlags: (dailyImport?.flags || []).filter((flag) => flag.status === 'Open').length,
    },
  };
}
