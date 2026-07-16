// Manual strategy classification by parameter signature.
//
// Replaces the removed XML set-file matching. Two accounts running the same
// strategy family AND the same version export the same `parameters`, so the
// parsed parameters form a comparable signature. The team assigns a version
// label to a signature (they only SELECT the version, they don't define the
// algorithm); the system then identifies each running strategy's version by
// matching its signature, suggests a version from the pool of what everyone runs,
// and flags version mismatches. Risk level lives on the classification too.

// A comparable signature from a strategy's parsed parameters (parseStrategyParameters
// output). Returns null when the parameters could not be parsed.
export function buildStrategySignature(params) {
  if (!params || !params.parsed) return null;
  return {
    direction: params.direction || '',
    posSizes: [...(params.posSizes || [])],
    profitTargets: [...(params.profitTargets || [])],
    stopLossTicks: params.stopLossTicks ?? null,
    tradeWindow: [...(params.tradeWindow || ['', ''])],
  };
}

// Stable string key for a signature — used to group, match, and key the DB.
export function signatureKey(signature) {
  if (!signature) return '';
  return JSON.stringify([
    signature.direction,
    signature.posSizes,
    signature.profitTargets,
    signature.stopLossTicks,
    signature.tradeWindow,
  ]);
}

function familyKey(family, signature) {
  return `${family || 'Unknown'}|${signatureKey(signature)}`;
}

// Every distinct (family + signature) running across all clients — each is a
// "version candidate": the accounts/clients/instruments running that exact
// parameter set. The team assigns a version + risk to each. Sorted by how widely
// it is used (accountCount desc) so the biggest pools surface first.
export function groupStrategiesBySignature(clients = []) {
  const groups = new Map();
  for (const client of clients) {
    const latest = client.dailyImports?.at(-1);
    for (const snapshot of latest?.snapshots || []) {
      for (const strategy of snapshot.strategies || []) {
        const signature = buildStrategySignature(strategy.params);
        if (!signature) continue;
        const family = strategy.strategyFamily || 'Unknown';
        const key = familyKey(family, signature);
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            family,
            signature,
            nameVersions: new Set(),
            instruments: new Set(),
            clientIds: new Set(),
            accounts: [],
          });
        }
        const group = groups.get(key);
        group.instruments.add(strategy.instrument || '');
        group.clientIds.add(client.id);
        if (strategy.strategyVersion) group.nameVersions.add(strategy.strategyVersion);
        group.accounts.push({
          clientId: client.id,
          clientName: client.name,
          accountName: snapshot.accountName,
          realized: Number(strategy.realized || 0),
        });
      }
    }
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      family: group.family,
      signature: group.signature,
      nameVersions: [...group.nameVersions],
      instruments: [...group.instruments].filter(Boolean),
      clientCount: group.clientIds.size,
      accountCount: group.accounts.length,
      accounts: group.accounts,
    }))
    .sort((a, b) => b.accountCount - a.accountCount);
}

// Identify a single strategy against the classification set: exact signature +
// family match returns the assigned version/risk. Returns { matched:false } when
// the parameters do not parse or no classification matches (a candidate to
// classify).
export function classifyStrategy(strategy, classifications = []) {
  const signature = buildStrategySignature(strategy?.params);
  if (!signature) return { matched: false, reason: 'unparsed-parameters' };
  const family = strategy.strategyFamily || 'Unknown';
  const key = familyKey(family, signature);
  const match = classifications.find((c) => c.key === key);
  if (!match) return { matched: false, reason: 'unclassified', signature };
  return {
    matched: true,
    family,
    version: match.version,
    riskLevel: match.riskLevel || '',
    signature,
  };
}

// Within each family, if accounts run more than one signature (i.e. more than one
// version), flag it — "I run OGX v1, this client runs OGX v5". Returns one entry
// per family that has a split, listing the versions/signatures in play.
export function detectVersionMismatches(clients = [], classifications = []) {
  const groups = groupStrategiesBySignature(clients);
  const byFamily = new Map();
  for (const group of groups) {
    if (!byFamily.has(group.family)) byFamily.set(group.family, []);
    const classification = classifications.find((c) => c.key === group.key);
    byFamily.get(group.family).push({
      version: classification?.version || null,
      nameVersions: group.nameVersions,
      accountCount: group.accountCount,
      clientCount: group.clientCount,
      signatureKey: signatureKey(group.signature),
    });
  }
  const mismatches = [];
  for (const [family, variants] of byFamily) {
    if (variants.length > 1) {
      mismatches.push({ family, variantCount: variants.length, variants });
    }
  }
  return mismatches;
}
