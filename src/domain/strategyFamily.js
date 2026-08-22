// The family a strategy name belongs to.
//
// This module used to be strategyRiskProfile.js, and most of it was
// buildStrategyRiskProfile — the reward:risk-against-fills-per-day exposure
// ranking behind the "Algorithm risk profile" scatter on the CAM overview and
// the "Exposure by algorithm" column on the manager's configuration review.
// The desk manager asked twice for that chart to go, so it went, and the whole
// profile builder went with it: the parameter-set parser, the tick medians and
// the exposure ratio existed for nothing else.
//
// strategyFamilyOf is what survived, because three other modules were already
// importing it for a question that has nothing to do with risk ranking:
// liveAccounts, setFileMatch and strategyConfigDrift all need to know that
// `0 - OGX-PF-2.4` and `1 - OGX-PF-3.0` are the same product. It lives under its
// own name now so the file says what it holds.

/**
 * The family a strategy belongs to: `0 - OGX-PF-2.4` → `OGX-PF`.
 *
 * The leading number is the NinjaTrader grid's row index, not part of the name.
 * The trailing version is what the team versions and swaps; grouping by the
 * full name would split one family into a row per version and hide the size of
 * the exposure.
 *
 * A version is only stripped when it has a dot, matching parseStrategyVersion
 * in csvImport. `-PF` is a different product from its non-PF sibling — separate
 * prop-firm rules — so it stays.
 */
export function strategyFamilyOf(strategyName) {
  const withoutIndex = String(strategyName || '').trim().replace(/^\d+\s*-\s*/, '');
  const withoutVersion = withoutIndex.replace(/\s*-\s*\d+(?:\.\d+)+\s*$/, '');
  return withoutVersion.trim() || null;
}
