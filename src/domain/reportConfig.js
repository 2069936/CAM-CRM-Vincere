// What a daily report shows is configurable, because different clients need
// different reports: a problematic client asks for extra detail, while a client
// who "doesn't understand much" is better served by a stripped-down page.
//
// The base config lives on the CAM, so a CAM's reports look consistent across
// their book. Any client can override it — usually to simplify, sometimes to
// add. Resolution is: defaults, then the CAM's config, then the client's.

export const REPORT_FIELDS = [
  { key: 'showDailyMetrics', label: 'Daily / weekly P&L header', advanced: false },
  { key: 'showPriorDelta', label: 'Change vs prior close', advanced: true },
  { key: 'showSegmentTiles', label: 'Balance split by account type', advanced: true },
  { key: 'showProgressToTarget', label: 'Progress to profit target', advanced: false },
  { key: 'showAccountTable', label: 'Per-account table', advanced: false },
  { key: 'showStrategies', label: 'Strategies column', advanced: true },
  { key: 'showTrailing', label: 'Drawdown / trailing column', advanced: true },
  { key: 'showWeeklyColumn', label: 'Weekly P&L column', advanced: true },
  // Off by default and opt-in per client through the same scope radio every
  // other toggle uses. Most clients have a Sim101 sitting untouched at
  // NinjaTrader's stock $100,000 — 10 of the 11 in the real exports — and
  // printing that for them would be noise; the one client mid-SIM-test is the
  // one whose CAM turns this on.
  { key: 'showSimulation', label: 'Simulation section (not real money)', advanced: false },
  // Off by default like every other addition. Measured over the 485 imports the
  // local snapshot rebuilds: the section prints nothing at all on 159 of them
  // (33%), and where it does print the median is 2 lines. The four reasons fire
  // on 40% (accounts absent), 32% (past drawdown), 26% (strategies all off) and
  // 18% (orders refused) of imports respectively — see src/domain/reportReasons.js
  // for what was measured and dropped for firing too often to mean anything.
  { key: 'showReasons', label: 'What shaped this close (reasons)', advanced: false },
  { key: 'showFlags', label: 'Open flags section', advanced: false },
  { key: 'showCumulativeChart', label: 'Cumulative P&L chart', advanced: false },
  { key: 'showDailyChart', label: 'Daily P&L chart', advanced: false },
  // Same curve as the cumulative chart, in a different unit, so it is a switch
  // on that chart rather than a third chart saying the same thing again.
  { key: 'chartAsPercent', label: 'Show cumulative as % of capital', advanced: true },
];

// Defaults preserve the report exactly as it shipped, except progress-to-target
// which is new and opt-in.
export const DEFAULT_REPORT_CONFIG = {
  showDailyMetrics: true,
  showPriorDelta: true,
  showSegmentTiles: true,
  showProgressToTarget: false,
  showAccountTable: true,
  showStrategies: true,
  showTrailing: true,
  showWeeklyColumn: true,
  // Anything new ships false: an existing client's report must not change shape
  // without someone choosing it.
  showSimulation: false,
  showReasons: false,
  showFlags: true,
  // Charts are new, so they stay off until a CAM turns them on. An existing
  // client's report must not change shape without someone choosing it.
  showCumulativeChart: false,
  showDailyChart: false,
  chartAsPercent: false,
  headerNote: '',
};

// A one-click stripped-down report for clients who want the essentials only.
export const SIMPLIFIED_REPORT_CONFIG = {
  showDailyMetrics: true,
  showPriorDelta: false,
  showSegmentTiles: false,
  showProgressToTarget: true,
  showAccountTable: true,
  showStrategies: false,
  showTrailing: false,
  showWeeklyColumn: false,
  showSimulation: false,
  // The simplified report is for the client who reads a picture faster than a
  // table, and this section is prose about their own accounts — it is the part
  // of a stripped-down report that still says something. Explicit rather than
  // omitted: clean() only copies keys present in DEFAULT_REPORT_CONFIG, so a key
  // left out of this preset silently falls back to the default instead of to the
  // preset's intent.
  showReasons: true,
  showFlags: false,
  // A client who wants the essentials is usually the one who reads a picture
  // faster than a table, so the simplified report keeps the two charts.
  showCumulativeChart: true,
  showDailyChart: true,
  chartAsPercent: false,
  headerNote: '',
};

function clean(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const key of Object.keys(DEFAULT_REPORT_CONFIG)) {
    if (key in config && config[key] !== undefined && config[key] !== null) {
      out[key] = config[key];
    }
  }
  return out;
}

// Effective config for a client: defaults <- CAM config <- client override.
// A client config of {} (or missing) inherits the CAM's, which inherits defaults.
export function resolveReportConfig(camConfig, clientConfig) {
  return {
    ...DEFAULT_REPORT_CONFIG,
    ...clean(camConfig),
    ...clean(clientConfig),
  };
}

// True when the client stores its own overrides rather than inheriting the CAM.
export function hasClientOverride(clientConfig) {
  return Object.keys(clean(clientConfig)).length > 0;
}
