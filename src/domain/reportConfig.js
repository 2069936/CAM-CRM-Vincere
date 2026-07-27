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
  { key: 'showFlags', label: 'Open flags section', advanced: false },
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
  showFlags: true,
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
  showFlags: false,
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
