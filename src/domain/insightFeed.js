// How the Insight Feed reads.
//
// buildPortfolioInsights decides WHAT fires; nothing in this file may change
// that. Every signal it produces still reaches the screen, and no threshold,
// severity or count moves. What this file fixes is that the feed spent almost
// all of its screen restating the rule instead of showing the reading.
//
// Measured on public/local-snapshot.json, the manager's consolidated view:
// 192 signals over 84 of the 96 clients, in three rules.
//
//   Missing Close      84 rows   1 distinct message   1 distinct action
//   Consistency Rule   65 rows  46 distinct messages  1 distinct action
//   Drawdown Velocity  43 rows  40 distinct messages  1 distinct action
//
// So the panel's 192 "→ what to do" lines carried three sentences between them,
// and one whole group of 84 rows was the same sentence 84 times: the group said
// "Missing Close 84" and then said "No daily close uploaded in the last 2
// trading days" once per client, with nothing on the row but the name to tell
// one from another. Opened, the feed was 576 lines of text of which the reader
// could skip about two thirds without losing a fact.
//
// THE RULE, and it is the only one in this file: a column whose value is the
// same on every row of a group is not a column. It is stated once, above the
// table, and the row keeps only what varies. That is the same rule
// DeviationAlertList applies to its CAM column and ChurnDetail to its reason
// filter — a field that cannot distinguish two rows is a heading, not a cell.
//
// It is applied uniformly rather than case by case, so nothing has to be
// re-decided when a rule changes shape: the action, the severity and every
// individual fact go through the same test. On today's book that hoists
//
//   * the action out of all three groups (192 lines → 3),
//   * the severity out of Missing Close, which is 84 warnings and nothing else,
//     while Drawdown Velocity keeps its column because it is 21 critical and 22
//     warning and the difference is the point,
//   * the account column out of Missing Close, which is a client-level rule and
//     names no account at all.
//
// What it must never do is hide a difference. `constants` is derived from the
// values actually present, so a group of one row hoists everything and a group
// where a single row disagrees hoists nothing.

/** Worst first. The same order buildPortfolioInsights sorts its output by. */
export const SEVERITY_RANK = { critical: 0, warning: 1, 'info-green': 2, info: 3 };

/**
 * Presentation for a severity. Kept here rather than in the panel so the group
 * header, the row and the empty state cannot disagree about what a severity is
 * called.
 */
export const SEVERITY_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  'info-green': 'Opportunity',
  info: 'Info',
};

const severityRankOf = (severity) => SEVERITY_RANK[severity] ?? SEVERITY_RANK.info;

/**
 * The facts of one signal, in the order the rule states them.
 *
 * Values are strings the producer already formatted — currency, dates and
 * percentages are its business, not this module's. `null` means the row has no
 * value for that label, which is a different thing from an empty string and is
 * why a missing cell must stay a cell (see columnsOf).
 */
function factsOf(item) {
  return Array.isArray(item?.facts) ? item.facts.filter((fact) => fact && fact.label) : [];
}

/**
 * Every fact label in the group, in the order the rows first state them.
 *
 * First-seen order, never sorted: the producer writes the facts in reading order
 * — buffer, then rate, then when it breaches — and alphabetising them would put
 * "Breach in" before "Buffer" for no reason a reader could recover.
 *
 * A label that only some rows carry still gets a column. The rows without it
 * render an empty cell, NOT a shifted one: a table that closes the gap by
 * sliding the next value left is a table that prints a stop loss under "Profit
 * target", and that is the failure mode this returns a full label list to avoid.
 */
export function columnsOf(items = []) {
  const seen = [];
  for (const item of items) {
    for (const fact of factsOf(item)) {
      if (!seen.includes(fact.label)) seen.push(fact.label);
    }
  }
  return seen;
}

/** The value one row has for one column, or null when it has none. */
export function factValue(item, label) {
  const found = factsOf(item).find((fact) => fact.label === label);
  return found ? (found.value ?? null) : null;
}

/**
 * A value every row of the group agrees on, or null when they do not.
 *
 * Null is also the answer when a single row is missing the field entirely. A
 * group of 6 where 5 say "16:30" and one says nothing does not get to print
 * "16:30" as a heading over all six.
 */
function sharedValue(items, read) {
  if (!items.length) return null;
  const first = read(items[0]);
  if (first === null || first === undefined || first === '') return null;
  return items.every((item) => read(item) === first) ? first : null;
}

/**
 * Higher is more urgent, and ONLY within its own rule.
 *
 * The number that makes a signal urgent is a different quantity in every rule —
 * days until a buffer breaches, a share of total gains, days since a client last
 * uploaded — so these are not comparable across groups and this module never
 * compares them across groups. Sorting is done inside a group and nowhere else;
 * the groups themselves are ordered by severity, which IS comparable because
 * buildPortfolioInsights assigns it from one scale.
 *
 * Missing from an item means "no magnitude stated", and those sort last within
 * their severity rather than first — an unranked row is not the most urgent one.
 */
function urgencyOf(item) {
  const value = Number(item?.urgency);
  return Number.isFinite(value) ? value : -Infinity;
}

/**
 * Signals in the order a reader should work them: worst severity first, then the
 * biggest magnitude inside that severity, then by name so the list is stable
 * across renders.
 *
 * The old panel left rows in the order the clients happened to be walked, so on
 * the book the account with one trading day of buffer left sat fourteen rows
 * below an account with two — inside the same block of 21 criticals, with
 * nothing on either row saying which was which.
 */
export function sortSignals(items = []) {
  return items.slice().sort((a, b) => severityRankOf(a.severity) - severityRankOf(b.severity)
    || urgencyOf(b) - urgencyOf(a)
    || String(a.clientName || '').localeCompare(String(b.clientName || ''))
    || String(a.accountAlias || '').localeCompare(String(b.accountAlias || '')));
}

/**
 * Everything the panel renders, derived once.
 *
 * The totals come from here rather than from a second pass in the panel, because
 * the header's "83 critical" and the groups' own critical badges were two
 * independent filters over the same array and nothing made them agree.
 */
export function groupInsights(insights = []) {
  const byType = new Map();
  for (const item of insights) {
    const key = item?.type || 'Other';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(item);
  }

  const groups = [...byType.entries()].map(([type, raw]) => {
    const items = sortSignals(raw);
    const critical = items.filter((item) => item.severity === 'critical').length;
    const warning = items.filter((item) => item.severity === 'warning').length;

    // The hoist. Everything a row could carry goes through the same test, and
    // whatever survives it is a heading instead of a repeated cell.
    const action = sharedValue(items, (item) => item.action || null);
    const severity = sharedValue(items, (item) => item.severity || null);
    const account = sharedValue(items, (item) => item.accountAlias || null);

    const allLabels = columnsOf(items);
    const constants = [];
    const columns = [];
    for (const label of allLabels) {
      const shared = sharedValue(items, (item) => factValue(item, label));
      if (shared === null) columns.push(label);
      else constants.push({ label, value: shared });
    }
    // An account column that is the same alias on every row is the same
    // repetition as a constant fact, so it is hoisted by the same test. An
    // account column that is EMPTY on every row is not hoisted, it is dropped:
    // Missing Close is a client-level rule and names no account, and a heading
    // reading "Account: —" is worse than no heading.
    const namesAccounts = items.some((item) => item.accountAlias);

    return {
      type,
      items,
      count: items.length,
      critical,
      warning,
      /** Hoisted, or null when the rows disagree and must each state it. */
      action,
      severity,
      /** Constant facts, in reading order, stated above the table. */
      constants,
      /** Fact labels that actually vary — the table's columns. */
      columns,
      showAccount: namesAccounts && account === null,
      accountConstant: namesAccounts ? account : null,
      severityRank: items.length
        ? Math.min(...items.map((item) => severityRankOf(item.severity)))
        : SEVERITY_RANK.info,
    };
  });

  // Worst rule first, then the biggest. Same order the panel has always used.
  groups.sort((a, b) => a.severityRank - b.severityRank || b.count - a.count);

  return {
    groups,
    totals: {
      signals: insights.length,
      critical: groups.reduce((sum, group) => sum + group.critical, 0),
      warning: groups.reduce((sum, group) => sum + group.warning, 0),
      clients: new Set(insights.map((item) => item?.clientId)).size,
    },
  };
}
