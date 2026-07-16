// Risk-scaling frontier for the Stack Playbook.
//
// The team's "risk level" essentially just multiplies contract count (each level
// roughly doubles the previous). A combo like "URGO x2" is the same base algo as
// "URGO" run at 2x contracts. These helpers separate the base algo from its risk
// multiplier so we can chart how PnL scales with risk, compare levels on a
// per-contract-unit basis (risk-normalized PnL), and estimate the highest risk
// level an account's drawdown buffer can safely carry.

// Split a combo label into its base algo + contract multiplier.
// "URGO x2" -> { base: 'URGO', multiplier: 2 }; "URGO" -> { base: 'URGO', multiplier: 1 }.
// A multi-algo combo ("URGO + IFSP") is its own base at multiplier 1.
export function parseComboRisk(combo) {
  const text = String(combo || '').trim();
  const match = text.match(/^(.*?)\s*x\s*(\d+)$/i);
  if (match) {
    return { base: match[1].trim(), multiplier: Number(match[2]) };
  }
  return { base: text, multiplier: 1 };
}

// Group combo performance into per-base risk curves. Each base gets its levels
// sorted by multiplier, with risk-normalized PnL (avgPnl / multiplier) so a 1x
// and a 2x version compare fairly. bestEfficiency = the level with the highest
// per-contract-unit PnL.
export function buildRiskScalingCurve(comboPerf = []) {
  const byBase = {};
  for (const row of comboPerf) {
    const { base, multiplier } = parseComboRisk(row.combo);
    if (!byBase[base]) byBase[base] = [];
    byBase[base].push({
      combo: row.combo,
      riskLevel: multiplier,
      avgPnl: row.avgPnl,
      winRate: row.winRate,
      accounts: row.accounts,
      riskNormalizedPnl: multiplier ? row.avgPnl / multiplier : row.avgPnl,
    });
  }

  return Object.entries(byBase)
    .map(([base, levels]) => {
      const sorted = levels.sort((a, b) => a.riskLevel - b.riskLevel);
      const bestEfficiency = sorted.reduce(
        (best, l) => (l.riskNormalizedPnl > (best?.riskNormalizedPnl ?? -Infinity) ? l : best),
        null,
      );
      return {
        base,
        levels: sorted,
        hasScaling: sorted.length > 1,
        bestEfficiency,
      };
    })
    .sort((a, b) => (b.bestEfficiency?.avgPnl || 0) - (a.bestEfficiency?.avgPnl || 0));
}

// Estimate the highest contract multiplier an account can carry given its
// remaining drawdown buffer and its recent worst single-day loss. The idea: the
// buffer should absorb a few worst-case days even after scaling contracts, so
// maxSafeMultiplier = currentMultiplier * buffer / (cushionDays * |worstDay|).
// Grounded but approximate — surface it as guidance, not a rule.
export function estimateMaxSafeMultiplier(series = [], buffer = 0, currentMultiplier = 1, cushionDays = 3) {
  if (!(buffer > 0) || !series.length) return null;
  const worstDay = Math.min(0, ...series.map((p) => Number(p.dayPnl || 0)));
  if (worstDay >= 0) return null; // no losing day on record to size against
  const capacity = buffer / (cushionDays * Math.abs(worstDay)); // worst-days the buffer covers at 1x
  const maxMultiplier = currentMultiplier * capacity;
  return {
    worstDay,
    maxMultiplier: Math.max(0, maxMultiplier),
    // The nearest doubling level (1,2,4,8...) that stays within capacity.
    safeLevel: Math.max(1, Math.pow(2, Math.floor(Math.log2(Math.max(1, maxMultiplier))))),
  };
}
