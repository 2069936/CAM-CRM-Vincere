import { getLatestClientImport } from './demoStore';
import { matchStrategySet } from './xmlMatch';

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function strategyLabel(strategy) {
  const family = strategy.strategyFamily || '';
  const version = strategy.strategyVersion || '';
  const fallback = strategy.strategyName || 'Unknown strategy';

  if (!family || family === 'Unknown') return { algorithm: fallback, version: '', key: fallback };
  return {
    algorithm: family,
    version,
    key: version ? `${family} ${version}` : family,
  };
}

function accountMeta(client, importResult, accountName) {
  return {
    ...(importResult?.accounts?.[accountName] || {}),
    ...(client?.accountRegistry?.[accountName] || {}),
  };
}

export function buildCamOverview(clients = [], setRecords = []) {
  const groups = new Map();

  for (const client of clients) {
    const latestImport = getLatestClientImport(client);
    if (!latestImport) continue;

    for (const snapshot of latestImport.snapshots || []) {
      const meta = accountMeta(client, latestImport, snapshot.accountName);
      for (const strategy of snapshot.strategies || []) {
        const label = strategyLabel(strategy);
        const executionPoints = (latestImport.executions || [])
          .filter((execution) => execution.accountName === snapshot.accountName && execution.strategyName === strategy.strategyName)
          .map((execution) => ({
            time: execution.time || '',
            price: Number(execution.price || 0),
            action: execution.action || '',
            entryExit: execution.entryExit || '',
            quantity: Number(execution.quantity || 0),
          }));
        const item = {
          clientId: client.id,
          clientName: client.name,
          accountName: snapshot.accountName,
          accountAlias: meta.alias || snapshot.accountName,
          accountType: meta.accountType || '',
          strategyName: strategy.strategyName || '',
          algorithm: label.algorithm,
          version: label.version,
          realized: Number(strategy.realized || 0),
          unrealized: Number(strategy.unrealized || 0),
          accountWeeklyPnl: Number(snapshot.weeklyPnl || 0),
          enabled: Boolean(strategy.enabled),
          configMatch: matchStrategySet(strategy, setRecords),
          executionPoints,
        };

        if (!groups.has(label.key)) {
          groups.set(label.key, {
            key: label.key,
            algorithm: label.algorithm,
            version: label.version,
            items: [],
          });
        }
        groups.get(label.key).items.push(item);
      }
    }
  }

  const algorithms = [...groups.values()]
    .map((group) => {
      const realizedValues = group.items.map((item) => item.realized);
      const weeklyValues = group.items.map((item) => item.accountWeeklyPnl);
      return {
        ...group,
        instances: group.items.length,
        accounts: new Set(group.items.map((item) => `${item.clientId}:${item.accountName}`)).size,
        totalRealized: realizedValues.reduce((total, value) => total + value, 0),
        avgRealized: average(realizedValues),
        avgAccountWeeklyPnl: average(weeklyValues),
      };
    })
    .sort((a, b) => Math.abs(b.totalRealized) - Math.abs(a.totalRealized));

  const deviationFlags = algorithms.flatMap((group) => {
    if (group.instances < 3) return [];
    const realizedValues = group.items.map((item) => item.realized);
    const mean = average(realizedValues);
    const stdev = standardDeviation(realizedValues);
    if (!stdev) return [];
    const threshold = mean - (1.5 * stdev);

    return group.items
      .filter((item) => item.realized < threshold)
      .map((item) => ({
        id: `cam-deviation-${group.key}-${item.clientId}-${item.accountName}`,
        severity: 'Warning',
        algorithm: group.version ? `${group.algorithm} ${group.version}` : group.algorithm,
        clientName: item.clientName,
        accountName: item.accountName,
        accountAlias: item.accountAlias,
        message: `${item.clientName} · ${item.accountAlias} is below peer performance for ${group.version ? `${group.algorithm} ${group.version}` : group.algorithm}.`,
        realized: item.realized,
        threshold,
      }));
  });

  return {
    algorithms,
    deviationFlags,
    totals: {
      algorithms: algorithms.length,
      accounts: new Set(algorithms.flatMap((group) => group.items.map((item) => `${item.clientId}:${item.accountName}`))).size,
      instances: algorithms.reduce((total, group) => total + group.instances, 0),
      openDeviationFlags: deviationFlags.length,
    },
  };
}
