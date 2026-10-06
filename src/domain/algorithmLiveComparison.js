// Each algorithm today, against the desk, read live.
//
// Pedro's question: "if OGX is at -500, I want to compare between clients and
// see, ah, this client has something odd, because it is not at -500 but at
// -1200. Or what configuration the client has." The number is the Strategies
// tab's Realized plus Unrealized for one NinjaTrader instance, sampled by the
// account tracker (step 57), and the desk figure comes from
// algorithm_live_desk(), which leaves the viewer's own clients out.
//
// THE DISCIPLINE IS deskConfigOutliers.js's, carried over whole:
//
//   * The word is "differs". Nothing here says an account is wrong, worse,
//     below the desk or an outlier; DIFFERS_WORD is the only verdict this
//     module produces. A client can be sized or configured differently on
//     purpose, and the -500 against -1200 in Pedro's example can be sizing
//     alone, which is why the configuration differences are attached beside the
//     number rather than left for the reader to go and find.
//   * The list is questions about where to look, not failures.
//   * NOTHING IS EVER SORTED BY P&L. The only ranking is distance from the
//     cohort median measured in the cohort's own usual spread, and only for an
//     account whose cohort cleared the floor. A thin cohort is listed with its
//     value and never ranked: algorithmTemperature ranks low sample rows by heat
//     and this module exists partly to not do that.
//   * NULL IS NOT ZERO. An instance with a part not measured has no value, and
//     the screen says "not measured, not zero".
//   * The sample size is carried beside every desk figure.
//
// SAME CYCLE OR NOT AT ALL. The figure is marked to market, so a client value
// read at 10:14 and a desk median read at 10:10 differ by whatever the market
// did in four minutes. An account is compared only when its readings belong to
// exactly the cycle the desk figure was computed over.
//
// Pure: no React, no Supabase.

import { SIZING } from './setFileNormalise';

/** The only verdict word this module produces. */
export const DIFFERS_WORD = 'differs';

/** Used only when the settings read fails, and labelled as such by the caller. */
export const FALLBACK_SETTINGS = Object.freeze({
  minCohortAccounts: 5,
  minCohortClients: 3,
  differsAtSpread: 3,
  minSpreadDollars: 50,
  cycleSeconds: 600,
  fallback: true,
});

export const ACCOUNT_STATUSES = Object.freeze([
  'compared',
  'cohort_thin',
  'restarted',
  'unmeasured',
  'off_cycle',
  'not_in_cycle',
]);

const REVIEW_PREFIX = '[algorithm live]';

function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  return Math.round(value * 100) / 100;
}

function cohortKey(algorithm, root) {
  return `${algorithm}\u0000${root}`;
}

function clientDirectory(clients) {
  const byId = new Map();
  if (clients instanceof Map) {
    for (const [id, client] of clients) byId.set(id, client);
  } else {
    for (const client of clients || []) if (client?.id) byId.set(client.id, client);
  }
  return byId;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

/**
 * The settings a caller read, completed from the fallbacks where a field is
 * missing. `fallback: true` tells the screen the floors it prints are the
 * defaults rather than what is in the database.
 */
export function resolveSettings(settings) {
  if (!settings) return { ...FALLBACK_SETTINGS };
  const pick = (key) => {
    const value = finiteOrNull(settings[key]);
    return value !== null && value > 0 ? value : FALLBACK_SETTINGS[key];
  };
  return {
    minCohortAccounts: pick('minCohortAccounts'),
    minCohortClients: pick('minCohortClients'),
    differsAtSpread: pick('differsAtSpread'),
    minSpreadDollars: pick('minSpreadDollars'),
    cycleSeconds: pick('cycleSeconds'),
    fallback: Boolean(settings.fallback),
  };
}

function deskCohort(cohort) {
  const nAccounts = finiteOrNull(cohort.nAccounts);
  const median = finiteOrNull(cohort.median);
  const nFlat = finiteOrNull(cohort.nFlat);
  const compared = cohort.status === 'compared' && nAccounts !== null && median !== null;
  return {
    status: compared ? 'compared' : 'thin',
    nAccounts: compared ? nAccounts : null,
    nClients: compared ? finiteOrNull(cohort.nClients) : null,
    median: compared ? median : null,
    spread: compared ? Math.max(0, finiteOrNull(cohort.spread) ?? 0) : null,
    nFlat: compared ? nFlat : null,
    // A reading, not agreement: most of the desk has not traded it yet in this
    // cycle, so a median of 0 says nothing about how it is going.
    mostlyUntraded: compared && median === 0 && nFlat !== null && nFlat * 2 >= nAccounts,
  };
}

const ABSENT_COHORT = Object.freeze({
  status: 'absent',
  nAccounts: null,
  nClients: null,
  median: null,
  spread: null,
  nFlat: null,
  mostlyUntraded: false,
});

/**
 * One account's readings for one algorithm on one root, against the desk.
 */
function accountEntry(group, { desk, cohort, settings, client, configFor }) {
  const deskCycleMs = ms(desk.cycleStart);
  const inCycle = group.rows.filter((row) => deskCycleMs !== null && ms(row.cycleStart) === deskCycleMs);
  const latestMs = Math.max(...group.rows.map((row) => ms(row.sampledAt) ?? -Infinity));
  const latest = group.rows.filter((row) => (ms(row.sampledAt) ?? -Infinity) === latestMs);
  const reading = inCycle.length ? inCycle : latest;

  const realizedParts = reading.map((row) => finiteOrNull(row.realizedPnl));
  const unrealizedParts = reading.map((row) => finiteOrNull(row.unrealizedPnl));
  const measured = realizedParts.every((v) => v !== null) && unrealizedParts.every((v) => v !== null);
  const realized = measured ? cents(realizedParts.reduce((s, v) => s + v, 0)) : null;
  const unrealized = measured ? cents(unrealizedParts.reduce((s, v) => s + v, 0)) : null;
  const value = measured ? cents(realized + unrealized) : null;
  const restartTimes = reading.map((row) => ms(row.restartedAt)).filter((v) => v !== null);
  const restartedAt = restartTimes.length ? new Date(Math.max(...restartTimes)).toISOString() : null;

  let status;
  if (!inCycle.length) {
    status = reading.some((row) => ms(row.cycleStart) === null) ? 'off_cycle' : 'not_in_cycle';
  } else if (!measured) {
    status = 'unmeasured';
  } else if (restartedAt) {
    status = 'restarted';
  } else if (cohort.status === 'compared') {
    status = 'compared';
  } else {
    status = 'cohort_thin';
  }

  let distance = null;
  let spread = null;
  let differs = false;
  if (status === 'compared') {
    distance = cents(value - cohort.median);
    // Never divide by a spread of zero: a cohort that agrees to the cent would
    // turn a five dollar gap into infinity. The floor is a settings column.
    const usual = Math.max(cohort.spread ?? 0, settings.minSpreadDollars);
    spread = Math.round((Math.abs(distance) / usual) * 10) / 10;
    differs = spread >= settings.differsAtSpread;
  }

  const sampled = reading.map((row) => ms(row.sampledAt)).filter((v) => v !== null);
  return {
    clientId: group.clientId,
    clientName: client?.name || group.clientId,
    accountName: group.accountName,
    algorithm: group.algorithm,
    instrumentRoot: group.instrumentRoot,
    instances: reading
      .map((row) => ({ strategyName: row.strategyName || '', instrument: row.instrument || '' }))
      .sort((a, b) => compareText(a.strategyName, b.strategyName) || compareText(a.instrument, b.instrument)),
    realized,
    unrealized,
    value,
    status,
    distance,
    spread,
    differs,
    config: configFor
      ? configFor(group.clientId, group.accountName, group.algorithm, group.instrumentRoot) ?? null
      : null,
    restartedAt,
    sampledAt: sampled.length ? new Date(Math.max(...sampled)).toISOString() : null,
    cycleStart: reading.find((row) => row.cycleStart)?.cycleStart ?? null,
  };
}

function byClientThenAccount(a, b) {
  return compareText(a.clientName, b.clientName) || compareText(a.accountName, b.accountName);
}

/**
 * Builds the comparison the panel renders.
 *
 * @param {object} input
 * @param {object} input.desk  {available:false}, or {available:true, cycleStart:null},
 *   or {available:true, cycleStart, filling, scope, cohorts:[...]}.
 * @param {object[]} input.rows the viewer's own algorithm_live_samples rows, any cycle.
 * @param {object} input.settings the floors and the differs threshold.
 * @param {object[]|Map} input.clients id to client, for names.
 * @param {Function} [input.configFor] (clientId, accountName, algorithm, root) => config or null.
 * @param {Date|number} [input.now]
 */
export function buildAlgorithmLiveComparison({
  desk = { available: false },
  rows = [],
  settings = null,
  clients = [],
  configFor = null,
  now = new Date(),
} = {}) {
  const resolved = resolveSettings(settings);
  const nowMs = ms(now) ?? Date.now();
  const base = {
    state: 'not_deployed',
    cycleStart: null,
    cycleAgeSeconds: null,
    scope: desk?.scope || null,
    settings: resolved,
    algorithms: [],
    toVerify: [],
    notInCycle: [],
  };

  if (!desk || desk.available !== true) return base;
  const ownRows = (rows || []).filter((row) => row && row.clientId && row.accountName
    && row.algorithm && row.instrumentRoot);
  const cycleMs = ms(desk.cycleStart);
  if (cycleMs === null) {
    return { ...base, state: ownRows.length ? 'no_complete_cycle' : 'no_readings' };
  }
  const cycleAgeSeconds = Math.max(0, Math.round((nowMs - cycleMs) / 1000));
  if (desk.filling) {
    return {
      ...base,
      state: 'cycle_filling',
      cycleStart: new Date(cycleMs).toISOString(),
      cycleAgeSeconds,
    };
  }

  const directory = clientDirectory(clients);
  const cohorts = new Map();
  for (const cohort of desk.cohorts || []) {
    if (!cohort?.algorithm || !cohort?.instrumentRoot) continue;
    cohorts.set(cohortKey(cohort.algorithm, cohort.instrumentRoot), deskCohort(cohort));
  }

  // The viewer's readings, one group per (client, account, algorithm, root):
  // the client value is PER ACCOUNT. Summing per client would make a five
  // account client look five times larger than a one account client.
  const groups = new Map();
  for (const row of ownRows) {
    const key = [row.clientId, row.accountName, row.algorithm, row.instrumentRoot].join('\u0000');
    if (!groups.has(key)) {
      groups.set(key, {
        clientId: row.clientId,
        accountName: row.accountName,
        algorithm: row.algorithm,
        instrumentRoot: row.instrumentRoot,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }

  const byAlgorithm = new Map();
  const ensure = (algorithm, root) => {
    const key = cohortKey(algorithm, root);
    if (!byAlgorithm.has(key)) {
      byAlgorithm.set(key, {
        algorithm,
        instrumentRoot: root,
        desk: cohorts.get(key) || ABSENT_COHORT,
        alsoOn: [],
        accounts: [],
      });
    }
    return byAlgorithm.get(key);
  };
  for (const cohort of desk.cohorts || []) {
    if (cohort?.algorithm && cohort?.instrumentRoot) ensure(cohort.algorithm, cohort.instrumentRoot);
  }
  for (const group of groups.values()) {
    const entry = ensure(group.algorithm, group.instrumentRoot);
    entry.accounts.push(accountEntry(group, {
      desk,
      cohort: entry.desk,
      settings: resolved,
      client: directory.get(group.clientId),
      configFor,
    }));
  }

  // Mixed instruments are refused by construction, each root its own cohort,
  // and the screen says where else the algorithm runs.
  const rootsOf = new Map();
  for (const entry of byAlgorithm.values()) {
    if (!rootsOf.has(entry.algorithm)) rootsOf.set(entry.algorithm, new Set());
    rootsOf.get(entry.algorithm).add(entry.instrumentRoot);
  }
  for (const entry of byAlgorithm.values()) {
    entry.alsoOn = [...rootsOf.get(entry.algorithm)]
      .filter((root) => root !== entry.instrumentRoot)
      .sort(compareText);
    // Compared rows first, by how far they sit from the median in the cohort's
    // own spread; then everything else by name. Never by value.
    entry.accounts.sort((a, b) => {
      const aCompared = a.status === 'compared';
      const bCompared = b.status === 'compared';
      if (aCompared !== bCompared) return aCompared ? -1 : 1;
      if (aCompared) return b.spread - a.spread || byClientThenAccount(a, b);
      return byClientThenAccount(a, b);
    });
  }

  const algorithms = [...byAlgorithm.values()].sort((a, b) => compareText(a.algorithm, b.algorithm)
    || compareText(a.instrumentRoot, b.instrumentRoot));
  const accounts = algorithms.flatMap((entry) => entry.accounts);
  const toVerify = accounts
    .filter((account) => account.status === 'compared' && account.differs)
    .sort((a, b) => b.spread - a.spread || byClientThenAccount(a, b));
  const notInCycle = accounts
    .filter((account) => account.status === 'not_in_cycle' || account.status === 'off_cycle')
    .sort(byClientThenAccount);

  return {
    ...base,
    state: 'ready',
    cycleStart: new Date(cycleMs).toISOString(),
    cycleAgeSeconds,
    algorithms,
    toVerify,
    notInCycle,
  };
}

/* ── The configuration beside the number ─────────────────────────────────── */

function differenceLine(difference) {
  return {
    field: difference.name,
    state: difference.state,
    account: difference.value ?? null,
    consensus: difference.consensus ?? null,
    countText: `${difference.consensusAccounts} of ${difference.population} accounts`,
  };
}

/**
 * Turns one buildDeskConfigOutliers result into the configFor the comparison
 * takes: the settings an account carried on that day's close, beside the
 * consensus of the group it was compared in.
 *
 * The close and the live number are different moments, so the date always
 * travels with the answer. `scope` says whose consensus it is: 'book' when the
 * outliers were computed over a CAM's own book, 'desk' over the whole desk.
 *
 * @param {object} outliers a buildDeskConfigOutliers result.
 * @param {{scope?: "book"|"desk", sizing?: RegExp}} [options]
 */
export function configIndexFromOutliers(outliers, { scope = 'book', sizing = SIZING } = {}) {
  const date = outliers?.date || '';
  if (!date || outliers?.reason) return () => null;

  const keyOf = (clientId, accountName, family, root) => [clientId, accountName, family, root].join('\u0000');
  const index = new Map();
  const closedAccounts = new Set();
  for (const group of outliers.groups || []) {
    const outliersByAccount = new Map(
      (group.outliers || []).map((outlier) => [`${outlier.clientId}\u0000${outlier.accountName}`, outlier]),
    );
    for (const account of group.accountList || []) {
      closedAccounts.add(`${account.clientId}\u0000${account.accountName}`);
      const key = keyOf(account.clientId, account.accountName, group.family, group.instrumentRoot);
      if (!index.has(key)) {
        index.set(key, { date, scope, measured: false, differing: [], sizing: [] });
      }
      const entry = index.get(key);
      entry.measured = entry.measured || Boolean(group.measured);
      const outlier = outliersByAccount.get(`${account.clientId}\u0000${account.accountName}`);
      for (const difference of outlier?.differences || []) {
        (sizing.test(difference.name) ? entry.sizing : entry.differing).push(differenceLine(difference));
      }
    }
  }

  return function configFor(clientId, accountName, algorithm, instrumentRoot) {
    const found = index.get(keyOf(clientId, accountName, algorithm, instrumentRoot));
    if (found) return found;
    if (closedAccounts.has(`${clientId}\u0000${accountName}`)) return { date, scope, reason: 'not_on_close' };
    return { date, scope, reason: 'no_close' };
  };
}

/* ── The feedback loop ───────────────────────────────────────────────────── */

function wholeDollars(value) {
  if (value === null || value === undefined) return 'not measured';
  const rounded = Math.round(value);
  return rounded < 0 ? `-$${Math.abs(rounded).toLocaleString('en-US')}` : `$${rounded.toLocaleString('en-US')}`;
}

/** "HH:MM" of a cycle, in the viewer's own clock. */
export function cycleClock(cycleStart) {
  const value = ms(cycleStart);
  if (value === null) return '';
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The prefix every note about one account on one algorithm starts with. */
export function reviewNotePrefix({ algorithm, instrumentRoot, accountName }) {
  return `${REVIEW_PREFIX} ${algorithm} ${instrumentRoot}, ${accountName},`;
}

/**
 * The activity entry text for a note taken from the comparison. Plain text, no
 * logDate and no logPnl: an activity entry carrying either becomes a point on
 * the client's equity curve, and this is a note, not a result.
 */
export function reviewNoteText({ account, desk, cycleStart, note = '' }) {
  const deskPart = desk?.status === 'compared'
    ? `against desk median ${wholeDollars(desk.median)} (${desk.nAccounts} accounts, ${desk.nClients} clients)`
    : 'not compared with the desk';
  const text = `${reviewNotePrefix(account)} cycle ${cycleClock(cycleStart)}: ${wholeDollars(account.value)} ${deskPart}.`;
  const extra = String(note || '').trim();
  return extra ? `${text} ${extra}` : text;
}

/**
 * The newest earlier note about this account on this algorithm and root, so the
 * next time it differs the CAM reads what was found last time.
 */
export function previousReviewNote(client, account) {
  const prefix = reviewNotePrefix(account);
  let best = null;
  for (const entry of client?.activityLog || []) {
    if (entry?.type !== 'Review' || !String(entry.text || '').startsWith(prefix)) continue;
    if (!best || compareText(entry.createdAt, best.createdAt) > 0) best = entry;
  }
  return best;
}
