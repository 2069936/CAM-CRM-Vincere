// The desk's money, computed once, for every surface that reports it.
//
// WHY THIS FILE EXISTS. Three places on the Operations screen answered "what did
// the team make today" and all three were on screen at the same time, disagreeing:
//
//   the headline tile        -$169,926.90 over 427 accounts
//   Recent team history      -$172,979.64 over 333 accounts
//   Copy Team Report         -$175,206.02 over 457 accounts
//
// 3.1% apart on the day, 6.7% on the week, and on 2026-07-24 the weekly figure
// SIGN-FLIPPED between two of them: -$2,128.97 on the strip against +$299.87 on
// the tile. The gap was not a rounding drift. Each surface had its own loop:
// the tile filtered segments, the strip filtered nothing (its gap against the
// tile decomposes exactly to Ignored + Orphan, residual $0.00 on all 14 days),
// and the report filtered nothing either but read a different cohort again. Three
// call sites that agree by luck is what produced this, so there is now one
// function and the three surfaces are three renderings of its output.
//
// WHAT IT REFUSES TO PRODUCE, and this is the substance of it:
//
//   * There is no desk total. Not a hidden one, not a convenience one. Prop-firm
//     balances are a plan size the firm simulates; cash accounts are real client
//     money. A figure that adds them answers no question anyone asks, and it got
//     the SIGN wrong twice in fourteen days — 2026-07-21 printed green at
//     +$605.79 while the prop desk had lost $5,505.46 and cash carried it.
//   * Bullet Bot is not folded into prop. Opposite signs on 9 of the 13 non-zero
//     days; on the 2026-07-30 close it is 71.0% of everything prop did.
//   * A prop row has no balance. It has movement. `planSize` carries the number
//     the firm simulates, under a name no one will print as capital by accident.
//   * Ignored and orphan closes are a reconciliation COUNT. They carry no money
//     fields at all, so nothing downstream can add them back in.
//
// Every object this module returns states its own date basis, because the
// defaults do not mean what they look like: with no date pinned the figures are
// each client's LAST close whatever date that is — on the real book 427 accounts
// drawn from 8 different dates, 13 clients last closed 17 days before the newest
// close on the book, injecting -$3,752.98 of P&L that is not today's.

import { BUSINESS_KEYS, SEGMENTS, buildSegmentTotals, rollUpByBusiness } from './operationsSegments';

/**
 * The four businesses, re-exported under the name every caller here already
 * uses. The strings are defined once, next to `businessForSegment`, so the
 * function that decides which business a segment belongs to and the object that
 * names the businesses cannot drift.
 */
export const DESK_BUSINESS = BUSINESS_KEYS;

/**
 * Fixed order, never sorted by size.
 *
 * The history table puts one of these rows in each column across ten closes; a
 * size sort would move a business between columns from day to day and make the
 * table unreadable in exactly the way that hides a change of sign.
 */
export const DESK_BUSINESS_ORDER = [
  DESK_BUSINESS.BULLET,
  DESK_BUSINESS.PROP_OTHER,
  DESK_BUSINESS.CASH,
  DESK_BUSINESS.UNCLASSIFIED,
];

const ROW_DEFINITIONS = {
  [DESK_BUSINESS.BULLET]: {
    label: 'Bullet Bot',
    shortLabel: 'Bullet Bot',
    kind: 'prop',
    note: 'Prop evaluations run by the bullet bot. A different business from the ordinary '
      + 'algorithms — pass or fail inside days — so it is never added to them.',
  },
  [DESK_BUSINESS.PROP_OTHER]: {
    label: 'Other prop algos',
    shortLabel: 'Prop algos',
    kind: 'prop',
    note: 'Funded and standard-evaluation prop accounts, plus any account type this build has '
      + 'not been taught, so a new type is reported rather than dropped.',
  },
  [DESK_BUSINESS.CASH]: {
    label: 'Cash',
    shortLabel: 'Cash',
    kind: 'cash',
    note: 'Real client money. The only row on this page whose balance is capital.',
  },
  [DESK_BUSINESS.UNCLASSIFIED]: {
    label: 'Unclassified',
    shortLabel: 'Unclassed',
    kind: 'backlog',
    note: 'Real closes on accounts nobody has classified yet. A classification backlog, not a '
      + 'result: it is shown on its own so it is neither counted as prop nor hidden.',
  },
};

/**
 * The businesses as columns, in row order, for a table that puts one business
 * per column across many closes.
 *
 * Derived from the same definitions the rows are built from rather than written
 * out again at the call site. A hand-written column list whose `key` drifts from
 * a row key renders an empty column for every day and says nothing — which is
 * how a table stops reporting a whole business without anybody noticing.
 */
export function deskBusinessColumns() {
  return DESK_BUSINESS_ORDER.map((key) => ({
    key,
    label: ROW_DEFINITIONS[key].label,
    shortLabel: ROW_DEFINITIONS[key].shortLabel,
  }));
}

const PROP_BALANCE_REFUSAL = 'A prop account balance is the plan size the firm simulates, not '
  + 'money the desk holds. It is not reported as capital; the movement above is the figure.';

const UNCLASSIFIED_BALANCE_REFUSAL = 'Not reported as capital. Nobody has said what these '
  + 'accounts are, and on this book almost every one of them carries a prop-firm connection, so '
  + 'calling their balance capital would be the prop mistake under a different label.';

const WEEK_OVER_MONTH_REFUSAL = 'Weekly P&L is a Monday-to-Friday accumulator, not a daily '
  + 'figure. Adding it across a month counts the same trades once per close, so it is refused '
  + 'here rather than printed.';

const BALANCE_OVER_RANGE_REFUSAL = 'A balance is a level, not a flow. Adding one account’s '
  + 'balance across every close in the range counts the same money once per close.';

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function day(value) {
  return String(value || '').slice(0, 10);
}

/**
 * The close a client had on a given date, or their most recent one when no date
 * is pinned.
 *
 * The single implementation. App.jsx's `importAsOf` delegates here so that the
 * date the tiles read and the date this module reports as their basis cannot
 * drift apart.
 */
export function closeAsOf(client, asOfDate = '') {
  const imports = client?.dailyImports || [];
  if (!asOfDate) return imports.at(-1) || null;
  return imports.find((entry) => entry.date === asOfDate) || null;
}

/** Every close date in the book, ascending, with the newest called out. */
export function bookCloses(clients = []) {
  const dates = new Set();
  for (const client of clients || []) {
    for (const entry of client?.dailyImports || []) {
      const date = day(entry?.date);
      if (date) dates.add(date);
    }
  }
  const closes = [...dates].sort();
  return { closes, latest: closes.length ? closes[closes.length - 1] : null };
}

/**
 * The month a page pinned to `asOfDate` is looking at.
 *
 * NOT `new Date()`. The monthly tile keyed off the wall clock, so on 2026-08-20
 * it rendered "Monthly P&L (2026-08) $0.00" over a book whose last close is
 * 2026-07-30 — and July's figure was unreachable from the tile at any as-of
 * date the picker could be moved to. A screen pinned to a July close reports
 * July.
 */
export function monthFor(clients = [], asOfDate = '') {
  if (asOfDate) return day(asOfDate).slice(0, 7);
  const { latest } = bookCloses(clients);
  return latest ? latest.slice(0, 7) : '';
}

function describeBasis({ mode, requested, dates, clientsInScope, clientsCounted, book, onRequested }) {
  const dateCount = dates.length;
  const latest = book.latest;
  const missing = Math.max(0, clientsInScope - clientsCounted);

  let label = '';
  if (!dateCount) {
    label = 'No close in view.';
  } else if (mode === 'latest-per-client') {
    const offLatest = clientsCounted - onRequested;
    label = `Latest close per client across ${dateCount} date${dateCount === 1 ? '' : 's'}`
      + ` · ${clientsCounted} client${clientsCounted === 1 ? '' : 's'}`
      + (latest && offLatest > 0
        ? ` · ${offLatest} of them last closed before ${latest}`
        : latest ? ` · all on ${latest}` : '');
  } else if (mode === 'close') {
    label = `Close of ${requested} · ${clientsCounted} of ${clientsInScope} clients reported`;
  } else if (mode === 'month') {
    label = `Every close in ${requested} · ${dateCount} date${dateCount === 1 ? '' : 's'}`
      + ` · ${clientsCounted} client${clientsCounted === 1 ? '' : 's'}`;
  }

  return {
    mode,
    requested: requested || null,
    dates,
    dateCount,
    latestClose: latest,
    clientsInScope,
    clientsCounted,
    clientsWithoutClose: missing,
    // How many of the counted clients sit on the date the label names. For the
    // latest-per-client mode that is the book's newest close, and the gap is the
    // staleness the headline used to hide.
    clientsOnLatestClose: mode === 'latest-per-client' ? onRequested : clientsCounted,
    clientsOffLatestClose: mode === 'latest-per-client' ? clientsCounted - onRequested : 0,
    // True only when every figure in this object comes from one close on one day.
    singleDate: dateCount === 1,
    // What `row.accounts` counts. Over one close it is accounts; over a month the
    // same account is read once per close it reported on, so 1,234 is a count of
    // account closes and calling it "accounts" on a desk of 584 would be a lie
    // by label.
    countNoun: mode === 'month' ? 'account close' : 'account',
    label,
  };
}

function buildRow(key, rolled, { weeklyAdditive, balanceComparable }) {
  const definition = ROW_DEFINITIONS[key];
  const isCash = definition.kind === 'cash';
  const refusals = {};

  if (!weeklyAdditive) refusals.weeklyPnl = WEEK_OVER_MONTH_REFUSAL;
  if (!isCash) {
    refusals.balance = definition.kind === 'prop'
      ? PROP_BALANCE_REFUSAL
      : UNCLASSIFIED_BALANCE_REFUSAL;
  } else if (!balanceComparable) {
    refusals.balance = BALANCE_OVER_RANGE_REFUSAL;
  }

  return {
    key,
    label: definition.label,
    shortLabel: definition.shortLabel,
    kind: definition.kind,
    note: definition.note,
    segments: rolled.segments,
    accounts: rolled.accounts,
    clients: rolled.clients,
    dailyPnl: round2(rolled.dailyPnl),
    weeklyPnl: weeklyAdditive ? round2(rolled.weeklyPnl) : null,
    // Cash is the only row that gets a balance, and only when the figures come
    // from a single cross-section. Everything else says why not.
    balance: isCash && balanceComparable ? round2(rolled.balance) : null,
    // The prop plan size, under a name that cannot be mistaken for capital. Kept
    // because "$8.4m of Bullet Bot plan size" is a real fact about the desk's
    // exposure; it is simply not money.
    planSize: definition.kind === 'prop' && balanceComparable ? round2(rolled.balance) : null,
    refusals,
  };
}

const RECONCILIATION_DEFINITIONS = [
  {
    key: 'ignored',
    segment: SEGMENTS.IGNORED,
    label: 'Marked Inactive / Ignore',
    note: 'A person decided these are not the book. Counted so the decision is visible.',
  },
  {
    key: 'orphan',
    segment: SEGMENTS.ORPHAN,
    label: 'No account on record',
    note: 'A close whose account was deleted or renamed underneath it. Worth chasing, not worth '
      + 'adding to a P&L.',
  },
  {
    key: 'simulated',
    segment: SEGMENTS.SIMULATION,
    label: 'Simulated (not real money)',
    note: 'Simulated funds. Shown in the client’s own report, never in a desk figure.',
  },
  {
    key: 'undetermined',
    segment: SEGMENTS.UNDETERMINED,
    label: 'Nature undetermined',
    note: 'Neither real nor simulated could be established. Counted as neither.',
  },
];

/**
 * Turns one set of (client, close) pairs into the desk's businesses.
 *
 * This is the function. `buildDeskMoney`, `buildDeskMoneyForMonth` and
 * `buildDeskMoneyHistory` differ only in which pairs they hand it, which is what
 * makes the tile, the history strip and the clipboard text the same computation
 * rather than three that resemble each other.
 */
function assemble(entries, { mode, requested, clientsInScope, book, weeklyAdditive = true, balanceComparable = true }) {
  const totals = buildSegmentTotals(entries);
  const business = rollUpByBusiness(totals);

  const dates = [...new Set(entries.map((entry) => day(entry.dailyImport?.date)).filter(Boolean))].sort();
  const clientsCounted = new Set(entries.map((entry) => entry.client?.id ?? entry.client?.name ?? '')).size;
  const anchor = mode === 'latest-per-client' ? book.latest : requested;
  const onAnchor = new Set(
    entries
      .filter((entry) => day(entry.dailyImport?.date) === anchor)
      .map((entry) => entry.client?.id ?? entry.client?.name ?? ''),
  ).size;

  const rows = DESK_BUSINESS_ORDER.map((key) => buildRow(key, business[key], {
    weeklyAdditive,
    balanceComparable,
  }));

  const reconciliationRows = RECONCILIATION_DEFINITIONS.map((definition) => {
    const rolled = totals.segments.find((row) => row.segment === definition.segment);
    return {
      key: definition.key,
      segment: definition.segment,
      label: definition.label,
      note: definition.note,
      // Counts only. No dailyPnl, no weeklyPnl, no balance — deliberately, so
      // that nothing downstream can add these back into a figure. The money is
      // still reachable per segment through buildSegmentTotals for anyone who
      // needs to chase a specific orphan; it is not reachable from here.
      accounts: rolled?.accounts || 0,
      clients: rolled?.clients || 0,
    };
  }).filter((row) => row.accounts > 0);

  return {
    basis: describeBasis({
      mode, requested, dates, clientsInScope, clientsCounted, book, onRequested: onAnchor,
    }),
    // Four rows that do not add up, in a fixed order. There is no total here and
    // there must never be one; see the header of this file.
    rows,
    rowsDoNotSum: 'Cash is real client money and prop is a simulated plan size. Bullet Bot is a '
      + 'different business from the ordinary algorithms. These rows are reported side by side '
      + 'and are never summed.',
    reconciliation: {
      rows: reconciliationRows,
      accounts: reconciliationRows.reduce((sum, row) => sum + row.accounts, 0),
      note: 'Counted, never added to any figure above.',
    },
    // Every account close read, the denominator for all counts above.
    accountsSeen: totals.accountsSeen,
    // The per-segment detail behind the four rows, so a caller that wants to open
    // one segment (the capital panel does) reads the same numbers the rows were
    // built from instead of recomputing them.
    segments: totals.segments,
  };
}

export function deskRow(desk, key) {
  return (desk?.rows || []).find((row) => row.key === key) || null;
}

/**
 * The desk on the day the page is pinned to, or on each client's latest close.
 */
export function buildDeskMoney(clients = [], { asOfDate = '' } = {}) {
  const list = clients || [];
  const book = bookCloses(list);
  const entries = [];
  for (const client of list) {
    const dailyImport = closeAsOf(client, asOfDate);
    if (dailyImport) entries.push({ client, dailyImport });
  }
  return assemble(entries, {
    mode: asOfDate ? 'close' : 'latest-per-client',
    requested: asOfDate ? day(asOfDate) : null,
    clientsInScope: list.length,
    book,
    weeklyAdditive: true,
    // Balances are comparable within one close. In latest-per-client mode they
    // are each account's last observed balance across several dates, which the
    // basis label states; the cash figure is still the desk's cash, and the
    // dates it lands on are on the label beside it.
    balanceComparable: true,
  });
}

/**
 * Every close inside one calendar month, through the same segmentation.
 *
 * The monthly tile did not go through it: it summed `grossRealizedPnl` over
 * every snapshot in the month with no segment filter at all, so Ignored and
 * Orphan were inside it (-$8,385.58, 2.2% of July) and cash was 26.0% of a
 * figure printed as one number.
 */
export function buildDeskMoneyForMonth(clients = [], { month = '' } = {}) {
  const list = clients || [];
  const book = bookCloses(list);
  const entries = [];
  for (const client of list) {
    for (const dailyImport of client?.dailyImports || []) {
      if (month && !day(dailyImport?.date).startsWith(month)) continue;
      entries.push({ client, dailyImport });
    }
  }
  return assemble(entries, {
    mode: 'month',
    requested: month || null,
    clientsInScope: list.length,
    book,
    // Both refused across a range, each with the reason on the row.
    weeklyAdditive: false,
    balanceComparable: false,
  });
}

/**
 * One entry per close, newest last, each one a full desk-money object.
 *
 * The strip used to be its own loop with no segment filter. Now every cell is
 * `buildDeskMoney` pinned to that date, so a day on the strip and the same day
 * on the tile are the same arithmetic by construction.
 */
export function buildDeskMoneyHistory(clients = [], { limit = 10 } = {}) {
  const list = clients || [];
  const { closes } = bookCloses(list);
  const window = limit > 0 ? closes.slice(-limit) : closes;
  return window.map((date) => ({ date, desk: buildDeskMoney(list, { asOfDate: date }) }));
}

/* ------------------------------------------------------------------ */
/* The text that goes to WhatsApp and Slack, from the same object.     */

function signedMoney(value) {
  if (value === null || value === undefined) return 'n/a';
  const rounded = Math.round(Number(value));
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Math.abs(rounded));
  return `${rounded < 0 ? '-' : '+'}${formatted}`;
}

function plainMoney(value) {
  if (value === null || value === undefined) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Number(value));
}

function reportRow(row, { weekly = true, countNoun = 'account' } = {}) {
  const parts = [`day ${signedMoney(row.dailyPnl)}`];
  if (weekly && row.weeklyPnl !== null) parts.push(`week ${signedMoney(row.weeklyPnl)}`);
  parts.push(`${row.accounts} ${countNoun}${row.accounts === 1 ? '' : 's'}`);
  if (row.balance !== null) parts.push(`cash held ${plainMoney(row.balance)}`);
  return `  • ${row.label}: ${parts.join(' · ')}`;
}

/**
 * The clipboard text.
 *
 * It prints the same four rows the tile prints, from the same object, and it
 * prints the basis line — the previous version opened with "Team Daily Report -
 * <today's date>" over figures drawn from eight different closes, none of which
 * was today.
 */
export function formatDeskReport(desk, { title = 'Desk report', month = null, cams = [], openFlags = null } = {}) {
  const lines = [];
  lines.push(`📊 *${title}*`);
  lines.push(`🗓 ${desk.basis.label}`);
  lines.push('');
  lines.push('*These lines are not added together.* Cash is client money; a prop balance is a');
  lines.push('plan size the firm simulates. Bullet Bot is its own business.');
  for (const row of desk.rows) lines.push(reportRow(row, { countNoun: desk.basis.countNoun }));

  if (desk.reconciliation.rows.length) {
    lines.push('');
    lines.push('🔎 *Not money — reconciliation:*');
    for (const row of desk.reconciliation.rows) {
      lines.push(`  • ${row.label}: ${row.accounts} account${row.accounts === 1 ? '' : 's'}`);
    }
  }

  if (month) {
    lines.push('');
    lines.push(`📆 *${month.basis.label}*`);
    for (const row of month.rows) {
      lines.push(reportRow(row, { weekly: false, countNoun: month.basis.countNoun }));
    }
    lines.push('  (weekly and balance are not reported over a month; both would double-count.)');
  }

  if (openFlags !== null) {
    lines.push('');
    lines.push(`⚠️ Open flags: ${openFlags}`);
  }

  if (cams.length) {
    lines.push('');
    lines.push('*By CAM* — same four businesses, same basis:');
    for (const cam of cams) {
      lines.push(`*${cam.name}* (${cam.clients} clients)`);
      for (const row of cam.desk.rows) {
        if (!row.accounts) continue;
        lines.push(`    ${row.shortLabel}: ${signedMoney(row.dailyPnl)} · ${row.accounts} acc`);
      }
    }
  }

  lines.push('');
  lines.push('_Generated by Vincere CRM · Drive Insight_');
  return lines.join('\n');
}
