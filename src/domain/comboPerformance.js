// What the Stack Playbook says about algo combinations, and what it is allowed
// to say.
//
// Everything the "Team Algo Performance" and "Client Config vs Team Avg" panels
// show is computed here, over plain client objects, so it can be run against
// the book in a test and checked to the cent. StackPlaybook.jsx only renders.
//
// The measurement is a CLIENT ACCOUNT DAY: one funded account, one close, the
// P&L the account reported that day, attributed to whatever algorithms were
// running on it. It is not the algorithm's own track record, it is not one
// contract, and it is not comparable to My Futures Book. The labels in the
// component say so; the arithmetic here is what makes the labels true.
//
// Four things the previous aggregator got wrong, each decided here once:
//
//   * ATTRIBUTION. The combo used to be "strategies whose Enabled checkbox was
//     still ticked when the CSV was exported". An algo that hit its daily stop
//     and switched itself off before the export vanished, and with it the day
//     it lost. On the book that dropped 64% of funded account days. `basis:
//     'traded'` attributes a day to every strategy that was enabled, OR
//     reported non-zero realized, OR is named on that account's fills.
//   * IDENTITY. `includes('IFSP')` folded IFSP_PF into IFSP while OGX_PF stayed
//     apart; the version was dropped. Now the family is exactly what the row
//     stores and the version is part of the key unless the caller asks for the
//     family roll-up.
//   * WINDOW. The window used to gate the trend columns only; every other
//     figure was all history. Now every accumulator runs over in-scope closes.
//   * POPULATION. A Funded account judged by its CURRENT status: an account
//     marked Failed today lost every day it ever traded, which flattered the
//     losing combos. A day now counts when it sits inside the account's own
//     alive range. `includeFailed: false` exists only to reproduce the old
//     population for a comparison label.
//
// And one thing it never had: a sample gate. A row under MIN_DAYS account days
// or MIN_ACCOUNTS accounts is shown, flagged, and never crowned "Best".

import { ACCOUNT_STATUSES, ACCOUNT_TYPES } from './reconcile';
import { strategyFamilyOf } from './strategyFamily';
import { parseStrategyVersion } from './csvImport';

export const MIN_DAYS = 10;
export const MIN_ACCOUNTS = 3;

export const UNKNOWN_KEY = 'Unknown';

export const DEFAULT_OPTIONS = {
  basis: 'traded',
  level: 'version',
  window: { preset: 30, from: null, to: null },
  minDays: MIN_DAYS,
  minAccounts: MIN_ACCOUNTS,
  includeFailed: true,
};

const MS_PER_DAY = 86400000;

function shiftDate(date, days) {
  if (!date) return '';
  const ms = new Date(`${date}T00:00:00Z`).getTime() + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  if (!from || !to) return 0;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

const lower = (value) => String(value || '').toLowerCase();

// The fills name a strategy the way the Strategies grid does (`0 - OGX-PF-2.4`)
// but the grid row stores its family as `OGX_PF`: strategyFamilyOf keeps the
// `-PF` and csvImport's normalizeStrategyFamily turns it into `_PF`. Same rule
// here, so a family named only on the fills lands on the same key as one that
// also has a grid row.
function familyFromName(strategyName) {
  const family = strategyFamilyOf(strategyName);
  if (!family) return null;
  const pf = family.match(/^([A-Z0-9]+)-PF$/i);
  return pf ? `${pf[1].toUpperCase()}_PF` : family;
}

function familyOfStrategy(strategy) {
  return strategy.strategyFamily || familyFromName(strategy.strategyName) || null;
}

const elementOf = (family, version, level) => (
  level === 'family' || !version ? family : `${family} ${version}`
);

function joinKey(elements) {
  const unique = [...new Set(elements)].sort();
  return unique.length ? unique.join(' + ') : UNKNOWN_KEY;
}

/** The executions of one close that belong to one account, by name. */
export function executionsForAccount(dailyImport, accountName) {
  const name = lower(accountName);
  if (!name) return [];
  return (dailyImport?.executions || []).filter((e) => lower(e.accountName) === name);
}

// Evidence, strongest first.
const RANK = { enabled: 0, fills: 1, realized: 2, none: 3 };

// Which algorithms ran on this account day, as `{ family, version, reason }`
// pairs. `reason` records the strongest evidence per family: the grid said it
// was enabled, the fills name it, or the grid reported a non-zero realized on
// a row it had already switched off.
function resolveDayAlgos(snapshot, executionsForThisAccount, basis) {
  const strategies = snapshot?.strategies || [];
  const traded = basis === 'traded';
  const filledFamilies = new Map();
  if (traded) {
    for (const execution of executionsForThisAccount || []) {
      const family = familyFromName(execution.strategyName);
      if (!family) continue;
      if (!filledFamilies.has(family)) filledFamilies.set(family, parseStrategyVersion(execution.strategyName));
    }
  }

  const byElement = new Map();
  const add = (family, version, reason) => {
    // `|` separates the two halves of the id because neither a family nor a
    // version can contain one: families are grid identifiers (IFSP_PF, B2X) and
    // versions are dotted numbers.
    const id = `${family}|${version}`;
    const existing = byElement.get(id);
    if (!existing || RANK[reason] < RANK[existing.reason]) byElement.set(id, { family, version, reason });
  };

  const rowFamilies = new Set();
  for (const strategy of strategies) {
    const family = familyOfStrategy(strategy);
    if (!family) continue;
    rowFamilies.add(family);
    const version = strategy.strategyVersion || '';
    if (strategy.enabled === true) add(family, version, 'enabled');
    else if (traded && filledFamilies.has(family)) add(family, version, 'fills');
    else if (traded && strategy.realized != null && Number(strategy.realized) !== 0) add(family, version, 'realized');
  }
  // A family named on the fills with no grid row at all (98 funded days on the
  // book carried no strategy rows): the fill name is the only evidence and it
  // carries its own version.
  for (const [family, version] of filledFamilies) {
    if (!rowFamilies.has(family)) add(family, version, 'fills');
  }
  return [...byElement.values()];
}

// The key at the requested level AND the family key, from ONE resolve. The
// aggregator needs both on every included day (the row carries familyKey so the
// UI can group version rows by family), and resolving twice meant a second scan
// of the close's executions and a second pass over the grid rows for every
// account day at the default level.
function dayKeys(snapshot, executionsForThisAccount, basis, level) {
  const algos = resolveDayAlgos(snapshot, executionsForThisAccount, basis);
  const elements = [...new Set(algos.map((a) => elementOf(a.family, a.version, level)))].sort();
  const reason = algos.reduce((best, a) => (RANK[a.reason] < RANK[best] ? a.reason : best), 'none');
  const key = joinKey(elements);
  return {
    key,
    elements,
    reason,
    familyKey: level === 'family' ? key : joinKey(algos.map((a) => a.family)),
  };
}

/**
 * The combo key of one account day.
 *
 * Returns `{ key, elements, reason }`. `key` is 'Unknown' only when no
 * algorithm can be attributed; `reason` is the strongest evidence behind the
 * key: 'enabled', 'fills', 'realized' or 'none'.
 */
export function comboKeyFromDay(snapshot, executionsForThisAccount = [], { basis = DEFAULT_OPTIONS.basis, level = DEFAULT_OPTIONS.level } = {}) {
  const { key, elements, reason } = dayKeys(snapshot, executionsForThisAccount, basis, level);
  return { key, elements, reason };
}

/** Today's rule for who is in the population, kept for the comparison label. */
export function isFundedPopulation(meta, { includeFailed = DEFAULT_OPTIONS.includeFailed } = {}) {
  if (!meta || meta.accountType !== ACCOUNT_TYPES.FUNDED) return false;
  if (includeFailed) return true;
  return meta.status !== ACCOUNT_STATUSES.FAILED && meta.status !== ACCOUNT_STATUSES.INACTIVE;
}

function registryOf(client) {
  return Object.fromEntries(
    Object.entries(client?.accountRegistry || {}).map(([name, meta]) => [name.toLowerCase(), meta]),
  );
}

function mergeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    window: { ...DEFAULT_OPTIONS.window, ...(options.window || {}) },
  };
}

// Anchor = the latest close of ANY client, so the window lines up across
// clients whatever their import cadence. firstClose bounds a custom range.
function closeBounds(clients) {
  let first = '';
  let last = '';
  for (const client of clients || []) {
    for (const di of client.dailyImports || []) {
      const date = di.date || '';
      if (!date) continue;
      if (!first || date < first) first = date;
      if (date > last) last = date;
    }
  }
  return { firstClose: first, lastClose: last };
}

/** Resolves a window option to inclusive `from`/`to` dates over the book. */
export function resolveWindow(clients, window = DEFAULT_OPTIONS.window) {
  const { firstClose, lastClose } = closeBounds(clients);
  const anchor = lastClose;
  const preset = window?.preset ?? DEFAULT_OPTIONS.window.preset;
  let from;
  let to;
  if (window?.from || window?.to) {
    from = window.from || firstClose;
    to = window.to || anchor;
  } else if (preset === 'all' || preset === 'custom') {
    from = firstClose;
    to = anchor;
  } else {
    const days = Number(preset);
    from = anchor && days > 0 ? shiftDate(anchor, -(days - 1)) : firstClose;
    to = anchor;
  }
  return { preset, from, to, anchor, firstClose, lastClose };
}

const inWindow = (date, from, to) => Boolean(date) && (!from || date >= from) && (!to || date <= to);

// The earliest close the window actually holds. The trend halves split THIS,
// not the calendar the window spans: at the default preset the window reaches
// back 30 days over a book whose first close is 17 days old, so halving the
// calendar put 3 of 14 closes in the first half and called the result a
// comparison of halves.
function firstCloseInWindow(clients, from, to) {
  let first = '';
  for (const client of clients || []) {
    for (const di of client.dailyImports || []) {
      if (!inWindow(di.date, from, to)) continue;
      if (!first || di.date < first) first = di.date;
    }
  }
  return first;
}

function newRow(key, level, elements, familyKey) {
  return {
    key,
    level,
    elements,
    familyKey,
    totalPnl: 0,
    days: 0,
    tradedDays: 0,
    winDays: 0,
    lossDays: 0,
    flatDays: 0,
    firstDate: '',
    lastDate: '',
    accountSet: new Set(),
    clientSet: new Set(),
    failedSet: new Set(),
    recentPnl: 0,
    recentDays: 0,
    priorPnl: 0,
    priorDays: 0,
  };
}

function finishRow(row, { minDays, minAccounts }) {
  const avgPnl = row.days ? row.totalPnl / row.days : 0;
  const recentAvg = row.recentDays ? row.recentPnl / row.recentDays : null;
  const priorAvg = row.priorDays ? row.priorPnl / row.priorDays : null;
  // Half against half, and the bar is a tenth of the prior's MAGNITUDE: the old
  // `recent > prior * 1.1` lowered the bar whenever prior was negative, so a
  // combo losing exactly as much as before read as "up".
  let trend = 'n/a';
  if (row.recentDays >= 5 && row.priorDays >= 5) {
    const bar = 0.1 * Math.abs(priorAvg);
    const diff = recentAvg - priorAvg;
    trend = diff > bar ? 'up' : diff < -bar ? 'down' : 'stable';
  }
  return {
    key: row.key,
    level: row.level,
    elements: row.elements,
    familyKey: row.familyKey,
    totalPnl: row.totalPnl,
    days: row.days,
    tradedDays: row.tradedDays,
    winDays: row.winDays,
    lossDays: row.lossDays,
    flatDays: row.flatDays,
    avgPnl,
    avgTradedPnl: row.tradedDays ? row.totalPnl / row.tradedDays : null,
    winRate: row.tradedDays ? row.winDays / row.tradedDays : null,
    accounts: row.accountSet.size,
    clients: row.clientSet.size,
    firstDate: row.firstDate,
    lastDate: row.lastDate,
    failedAccounts: row.failedSet.size,
    lowSample: row.days < minDays || row.accountSet.size < minAccounts,
    trend,
    recentAvg,
    priorAvg,
    recentDays: row.recentDays,
    priorDays: row.priorDays,
  };
}

/**
 * Combo performance over every client's funded account days inside a window.
 *
 * Returns `{ rows, best, basis, level, window, population, minDays,
 * minAccounts }`. Rows passing the sample gate come first, by average; then
 * the low-sample rows, by average. `best` is the first gated row with a
 * positive average, or null: a combo nobody has made money on is not "best".
 */
export function buildComboPerformance(clients = [], options = {}) {
  const opts = mergeOptions(options);
  const { basis, level, minDays, minAccounts, includeFailed } = opts;
  const window = resolveWindow(clients, opts.window);
  const { from, to } = window;
  // Trend halves: [splitFrom, mid) is prior, [mid, to] is recent.
  const splitFrom = firstCloseInWindow(clients, from, to) || from;
  const mid = to ? shiftDate(to, -Math.floor(daysBetween(splitFrom, to) / 2)) : '';

  const rows = {};
  const population = {
    fundedDays: 0,
    fundedPnl: 0,
    includedDays: 0,
    includedPnl: 0,
    unknownDays: 0,
    unknownPnl: 0,
    failedAccountDays: 0,
    hiddenClients: Number(options.hiddenClientCount || 0),
    accounts: new Set(),
    clients: new Set(),
  };

  for (const client of clients || []) {
    const registry = registryOf(client);
    const imports = client.dailyImports || [];

    // The account's own alive range: first close to the later of its last
    // close and the date it was marked Failed. What its status is TODAY says
    // nothing about the days it traded.
    //
    // While the range is derived from the same snapshots the loop below walks,
    // the check on it excludes nothing: a day that reaches it was itself one of
    // the days that widened the range. It is the shape the population rule is
    // meant to have, and it goes live the moment the range comes from the
    // registry (dateFunded, dateFailed) instead. What does the work today is
    // `includeFailed`, which skips the status test in isFundedPopulation.
    const alive = {};
    for (const di of imports) {
      for (const snap of di.snapshots || []) {
        const name = lower(snap.accountName);
        const range = alive[name] || (alive[name] = { first: di.date || '', last: di.date || '' });
        if (di.date && (!range.first || di.date < range.first)) range.first = di.date;
        if (di.date && di.date > range.last) range.last = di.date;
      }
    }

    for (const di of imports) {
      if (!inWindow(di.date, from, to)) continue;
      for (const snap of di.snapshots || []) {
        const name = lower(snap.accountName);
        const meta = registry[name] || {};
        if (!isFundedPopulation(meta, { includeFailed })) continue;
        const range = alive[name] || { first: '', last: '' };
        const aliveTo = range.last > (meta.dateFailed || '') ? range.last : (meta.dateFailed || '');
        if (!inWindow(di.date, range.first, aliveTo)) continue;

        const pnl = Number(snap.grossRealizedPnl || 0);
        population.fundedDays += 1;
        population.fundedPnl += pnl;

        const day = dayKeys(snap, executionsForAccount(di, snap.accountName), basis, level);
        if (day.key === UNKNOWN_KEY) {
          population.unknownDays += 1;
          population.unknownPnl += pnl;
          continue;
        }

        const accountId = `${client.id}::${name}`;
        const isFailed = meta.status === ACCOUNT_STATUSES.FAILED;
        population.includedDays += 1;
        population.includedPnl += pnl;
        population.accounts.add(accountId);
        population.clients.add(client.id);
        if (isFailed) population.failedAccountDays += 1;

        const row = rows[day.key] || (rows[day.key] = newRow(day.key, level, day.elements, day.familyKey));
        row.totalPnl += pnl;
        row.days += 1;
        if (pnl > 0) { row.winDays += 1; row.tradedDays += 1; }
        else if (pnl < 0) { row.lossDays += 1; row.tradedDays += 1; }
        else row.flatDays += 1;
        row.accountSet.add(accountId);
        row.clientSet.add(client.id);
        if (isFailed) row.failedSet.add(accountId);
        if (!row.firstDate || di.date < row.firstDate) row.firstDate = di.date;
        if (di.date > row.lastDate) row.lastDate = di.date;
        if (mid && di.date >= mid) { row.recentPnl += pnl; row.recentDays += 1; }
        else { row.priorPnl += pnl; row.priorDays += 1; }
      }
    }
  }

  const gate = { minDays, minAccounts };
  const byAvgDesc = (a, b) => b.avgPnl - a.avgPnl || a.key.localeCompare(b.key);
  const finished = Object.values(rows).map((row) => finishRow(row, gate));
  const sorted = [
    ...finished.filter((row) => !row.lowSample).sort(byAvgDesc),
    ...finished.filter((row) => row.lowSample).sort(byAvgDesc),
  ];
  const best = sorted.find((row) => !row.lowSample && row.avgPnl > 0) || null;

  return {
    rows: sorted,
    best,
    basis,
    level,
    window,
    minDays,
    minAccounts,
    population: {
      fundedDays: population.fundedDays,
      fundedPnl: population.fundedPnl,
      avgPnlPerAccountDay: population.fundedDays ? population.fundedPnl / population.fundedDays : 0,
      includedDays: population.includedDays,
      includedPnl: population.includedPnl,
      unknownDays: population.unknownDays,
      unknownPnl: population.unknownPnl,
      failedAccountDays: population.failedAccountDays,
      hiddenClients: population.hiddenClients,
      accounts: population.accounts.size,
      clients: population.clients.size,
    },
  };
}

/** Suggestion margin: at least $25 and at least 15% of the team figure. */
export function suggestionMargin(teamAvg) {
  return Math.max(25, 0.15 * Math.abs(teamAvg ?? 0));
}

export const NOTE_NO_ALGO = 'No algo recorded on this close';
export const NOTE_NO_GATE = 'No combo passes the sample gate';
// `best` is null in two different situations and they read very differently on
// screen. Nothing passed MIN_DAYS and MIN_ACCOUNTS at all is one; rows passed
// and every one of them loses money is the other, and on the book's default
// view that is the true one for 16 gated rows. Saying "No combo passes the
// sample gate" there is a sentence the table beside it contradicts.
export const NOTE_NO_POSITIVE = 'No combo with a positive average passes the sample gate';
export const NOTE_ON_BEST = 'On the best combo';
export const NOTE_NO_CHANGE = 'No change suggested';

/**
 * One client's funded accounts on the viewed close, each against the team row
 * for the combo it ran that day.
 *
 * The account side counts ONLY this account's in-window closes on the same
 * key; the old panel averaged every close whatever ran, then compared it to a
 * team figure built on a different day set. Both sides now come from the same
 * call, same window, same basis. No fallback between windowed and all-time.
 */
export function buildClientComboInsights(client, dailyImport, perf, options = {}) {
  if (!client || !perf) return [];
  const opts = mergeOptions({ ...options, window: perf.window });
  const { basis, level, includeFailed } = opts;
  const { from, to } = perf.window || {};
  const registry = registryOf({ accountRegistry: { ...(dailyImport?.accounts || {}), ...(client.accountRegistry || {}) } });
  const rowByKey = Object.fromEntries((perf.rows || []).map((row) => [row.key, row]));
  const best = perf.best || null;
  const someGated = (perf.rows || []).some((row) => !row.lowSample);

  return (dailyImport?.snapshots || [])
    .filter((snap) => isFundedPopulation(registry[lower(snap.accountName)], { includeFailed }))
    .map((snap) => {
      const meta = registry[lower(snap.accountName)] || {};
      const current = comboKeyFromDay(snap, executionsForAccount(dailyImport, snap.accountName), { basis, level });
      const name = lower(snap.accountName);

      let sum = 0;
      let accountDaysOnCombo = 0;
      let accountDaysTotal = 0;
      for (const di of client.dailyImports || []) {
        if (!inWindow(di.date, from, to)) continue;
        const own = (di.snapshots || []).find((s) => lower(s.accountName) === name);
        if (!own) continue;
        accountDaysTotal += 1;
        const key = comboKeyFromDay(own, executionsForAccount(di, own.accountName), { basis, level }).key;
        if (key !== current.key) continue;
        accountDaysOnCombo += 1;
        sum += Number(own.grossRealizedPnl || 0);
      }
      const accountAvg = accountDaysOnCombo ? sum / accountDaysOnCombo : null;
      const teamRow = rowByKey[current.key] || null;
      const teamAvg = teamRow ? teamRow.avgPnl : null;
      const delta = accountAvg != null && teamAvg != null ? accountAvg - teamAvg : null;

      let suggestion = null;
      let note;
      if (current.key === UNKNOWN_KEY) note = NOTE_NO_ALGO;
      else if (!best) note = someGated ? NOTE_NO_POSITIVE : NOTE_NO_GATE;
      else if (best.key === current.key) note = NOTE_ON_BEST;
      else if (best.avgPnl - (teamAvg ?? 0) >= suggestionMargin(teamAvg)) { suggestion = best.key; note = null; }
      else note = NOTE_NO_CHANGE;

      return {
        accountName: snap.accountName,
        alias: meta.alias || snap.accountName,
        currentKey: current.key,
        currentReason: current.reason,
        accountAvg,
        accountDaysOnCombo,
        accountDaysTotal,
        teamRow,
        teamAvg,
        delta,
        suggestion,
        best,
        note,
      };
    });
}
