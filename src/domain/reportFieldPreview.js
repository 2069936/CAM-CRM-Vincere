// What each report toggle would actually produce for THIS client and THIS close.
//
// WHY THIS EXISTS. A CAM turned on a section in the report designer, nothing
// appeared on the sheet, and the product never said why. That is worse than a
// missing control: the person concludes the feature is broken and stops trusting
// the designer. The complaint that started this was about the simulation section,
// but the defect is not that toggle's — nine of the fourteen fields in
// REPORT_FIELDS can render nothing at all, and every one of them does it in
// silence:
//
//   showPriorDelta        the tile vanishes on a client's earliest close
//   showSegmentTiles      an empty <section> shell when no account is typed
//   showProgressToTarget  a heading and column headings over an empty body on
//                         214 of the book's 477 closes (44.9%) — and it is `true`
//                         in SIMPLIFIED_REPORT_CONFIG, so it ships that way today
//   showAccountTable      no rows when nothing filed a close
//   showSimulation        null on 477 of 477 closes on this book's data
//   showReasons           nothing on 159 of 485 imports (33%), measured in
//                         reportConfig.js:24-29
//   showFlags             nothing with no open flag
//   showCumulativeChart   both charts return null under two points, for 65 of
//   showDailyChart        the book's clients
//   showEvaluations       null when the client holds no challenge account
//
// So the fix is one mechanism for the family rather than a sentence bolted to
// whichever toggle was complained about. This module answers, per field, "would
// this print anything, and if not, what is missing" — and the designer prints the
// answer beside the checkbox.
//
// WHY THE ANSWER GOES IN THE DESIGNER AND NOT ON THE SHEET. The designer drawer
// is inside `.report-sheet` but carries `.no-print`, and the print stylesheet
// hides it (src/index.css, pinned by src/printLayout.test.js). The PDF is that
// same DOM rendered in headless Chrome, so a sentence here is seen by the CAM and
// never by the client — which is right, because "no account on this client is set
// to simulation" is a fact about the desk's own data entry. A self-explaining
// empty section inside the sheet would print that on the page the client keeps.
//
// THE GRAMMAR is PerformanceCharts.jsx:195, the one field in the family that
// already explains itself: *the missing fact* + ", so " + *what cannot be shown*.
// Where a CAM can fix the missing fact, the sentence says where.
//
// A FIELD THAT WILL SHOW SOMETHING GETS NO LINE. The silence is the defect; a
// toggle that works needs no caption, and fourteen captions would be noise in a
// drawer that is already fourteen checkboxes.

import { buildPerformanceSeries, summarizePerformance } from './performanceSeries.js';
import { REPORT_SEGMENT_TILES } from './reportConfig.js';

/** The pools the per-account table draws, in App.jsx's order. */
const TABLE_POOLS = ['evaluations', 'funded', 'cashIra', 'cashStraight', 'cashLegacy', 'unclassified'];
/**
 * The pools the segment tile row draws — the list App.jsx maps, not a second copy
 * of it. There were two copies until now, and what two copies drift into is this
 * module's whole subject: the designer promising something the sheet withholds.
 */
const TILE_SEGMENTS = REPORT_SEGMENT_TILES.map((tile) => tile.key);

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * The fields that would print nothing, each with the sentence saying why.
 *
 * @param {object} report a buildDailyReportSummary result
 * @param {object} cfg the resolved report config, because two sections hand work
 *   to each other: with `showEvaluations` on, the per-account table stops drawing
 *   its evaluations group, so a client whose only closes are evaluations has an
 *   empty table exactly then and not otherwise.
 * @param {object[]} history the performance series input the charts are given
 * @param {object[]} reasons the reasons section's input
 * @returns {Record<string, string>} field key -> one sentence. A key absent from
 *   the result will show something.
 */
export function describeSilentReportFields({ report, cfg = {}, history = [], reasons = [] } = {}) {
  const out = {};
  if (!report) return out;
  const grouped = report.grouped || {};
  const segments = report.segments || {};

  if (report.priorDailyPnl === null || report.priorDailyPnl === undefined) {
    out.showPriorDelta = 'This is the earliest close on record for this client, so there is no prior close to compare against.';
  }

  /* THE STRIP THE EVALUATIONS SECTION CAN EMPTY.
   *
   * Asked of the list AFTER the handoff, because that is the list the sheet draws:
   * with `showEvaluations` on the section takes the Evaluations tile over, and for
   * a client whose only tile was that one the strip has nothing left. 31 closes on
   * the book are in that state, 5 of them a client's latest, and before this they
   * were reported nowhere — the sheet emitted an empty strip and the designer said
   * nothing, which is the pair of failures this module was built to end.
   *
   * The unconditional case was reachable already: 38 closes, 14 of them a latest
   * close, have no tileable account at all. */
  const tiles = TILE_SEGMENTS.filter((key) => !(key === 'evalStandard' && cfg.showEvaluations));
  if (!tiles.some((key) => (segments[key]?.count || 0) > 0)) {
    out.showSegmentTiles = (segments.evalStandard?.count || 0) > 0 && cfg.showEvaluations
      ? 'The only tileable pool on this close is Evaluation - Standard, and the Evaluations section below is showing it, so this strip would have no tile left to draw.'
      : 'No account on this close is typed Funded, Evaluation - Standard or Cash, so there is no balance split to tile. Set the account type in the client\'s Accounts tab.';
  }

  // The table's own pools, minus the one the evaluations section takes over when
  // it is on. Asked of the same list App.jsx maps, so the two cannot disagree.
  const tablePools = TABLE_POOLS.filter((pool) => !(pool === 'evaluations' && cfg.showEvaluations));
  if (!tablePools.some((pool) => (grouped[pool]?.length || 0) > 0)) {
    out.showAccountTable = cfg.showEvaluations && (grouped.evaluations?.length || 0) > 0
      ? 'Every account that closed today is an evaluation, and the Evaluations section below is showing them, so this table would have no rows left to draw.'
      : 'No account filed a close on this date, so the per-account table would have no rows.';
  }

  /* THE ONE THAT IS ALREADY SHIPPING WRONG. 214 of the book's 477 closes have no
   * row eligible for this table, and it is on in the Simplified preset, so a
   * heading and four column headings over nothing has been reaching clients. The
   * sheet now withholds the section in that case; this is the CAM's half of the
   * same fix, and it names the field to fill because Target $ is a thing a CAM
   * can set. */
  const targetable = [...(grouped.funded || []), ...(grouped.evaluations || [])];
  const eligible = targetable.filter((row) => Number(row.meta?.targetProfit) > 0);
  if (!eligible.length) {
    out.showProgressToTarget = targetable.length
      ? `${targetable.length} funded or evaluation ${plural(targetable.length, 'account', 'accounts')} closed today and no Target $ is on record for any of them, so there is no progress to measure. Set Target $ in the client's Accounts tab.`
      : 'No funded or evaluation account filed a close on this date, so there is no progress to measure.';
  }

  /* NOT "you have no simulation accounts". The section also renders when the only
   * thing in it is UNDETERMINED — report.js:231 checks either list, and
   * report.js:260-266 retitles the block for that case — so a line claiming the
   * client has no simulation would be false for a client whose accounts are
   * merely conflicted. The sentence covers both, and it names the control,
   * because until now there was no way at all to mark an account as simulation. */
  if (!report.simulation) {
    out.showSimulation = 'No account on this client is set to simulation and none is undetermined, so this section has nothing to print. Set Sim / Live on the account in the client\'s Accounts tab.';
  }

  if (!report.evaluations) {
    out.showEvaluations = 'No evaluation account on this client\'s record, so this section has nothing to print. Set the account type to one of the Evaluation types in the client\'s Accounts tab.';
  }

  if (!reasons?.length) {
    out.showReasons = 'Nothing about this close matched one of the four reasons, so this section has nothing to print.';
  }

  if (!report.openFlags?.length) {
    out.showFlags = 'No open flag on this close, so there is nothing to list.';
  }

  /* BOTH CHARTS RETURN NULL UNDER TWO POINTS — PerformanceCharts.jsx:152, before
   * either of the two "Not enough history to chart yet." messages inside the
   * chart components can mount. Grepping for that string suggests the charts
   * already explain themselves; they do not, for 65 of the book's 136 clients. */
  const points = buildPerformanceSeries(history);
  if (points.length < 2) {
    const line = `Only ${points.length} ${plural(points.length, 'close', 'closes')} on record for this client and a line needs two points, so no chart can be drawn.`;
    out.showCumulativeChart = line;
    out.showDailyChart = line;
    out.chartAsPercent = line;
  } else if (summarizePerformance(points).returnPct === null) {
    // The sheet already says this where the chart would be. Repeating it here is
    // what stops a CAM ticking the box, seeing dollars, and assuming the toggle
    // is broken.
    out.chartAsPercent = 'No capital on record for these days, so a percentage cannot be shown and the chart stays in dollars.';
  }

  return out;
}
