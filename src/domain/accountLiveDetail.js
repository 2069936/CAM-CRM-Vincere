import { buildAlgorithmLiveComparison, cycleClock } from './algorithmLiveComparison';
import { NO_CONNECTION_WORD, differsWords } from './accountPill';
import { formatCurrency } from './report';

/* ────────────────────────────────────────────────────────────────────────────
 * WHAT ONE ACCOUNT IS RUNNING, AND HOW IT SITS AGAINST THE DESK.
 *
 * Pedro's words: click a client and see the breakdown; this client has these
 * connections, under them these accounts, and these accounts have done this.
 * This is the account layer of that breakdown: the connection, the totals the
 * account sample measured, and one row per strategy instance from
 * algorithm_live_samples, each held against the desk figure.
 *
 * THE COMPARISON IS NOT INVENTED HERE. Every row goes through
 * buildAlgorithmLiveComparison, the same function AlgorithmLivePanel renders,
 * with the same desk figure from algorithm_live_desk() and the same floors.
 * "Differs" is that module's only word and that module's band: three times
 * the larger of the desk's own spread and the settings floor, around the
 * median, in the same cycle. A desk whose accounts are sized differently has a
 * wide spread, and a doubled account sits inside it; a desk that agrees to the
 * dollar does not, and then a doubled account is a question. A thin cohort, a
 * restarted instance, an unmeasured part or a reading outside the cycle is
 * never compared and never amber.
 *
 * NULL IS NOT ZERO. A figure the sample did not carry stays null and the screen
 * says "not measured".
 *
 * WHOSE ROWS. Rows carry the client's uuid; the app names the client by its
 * legacy key when it has one. strategiesForAccount matches either, which is
 * the identity rule that has failed twice this week when forgotten.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  return Math.round(value * 100) / 100;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

/** Money as the rest of the app prints it, except that null stays null: formatCurrency
 * coerces a missing figure to $0, and a confident $0 about something nobody
 * measured is the failure liveAccounts.js exists to stop. */
export function money(value) {
  const parsed = finiteOrNull(value);
  return parsed === null ? null : formatCurrency(parsed);
}

/** This account's rows and nobody else's, matching the client by uuid or by id. */
export function strategiesForAccount(rows, client, accountName) {
  const keys = new Set([client?.uuid, client?.id].filter(Boolean));
  return (Array.isArray(rows) ? rows : []).filter((row) => row
    && row.accountName === accountName
    && keys.has(row.clientId));
}

function strategiesWords(sample) {
  const loaded = finiteOrNull(sample.strategyCount);
  const enabled = finiteOrNull(sample.enabledStrategyCount);
  if (loaded === null || enabled === null) return 'No strategy data in this sample';
  if (loaded === 0) return 'No strategies loaded';
  return `${enabled} of ${loaded} ${loaded === 1 ? 'strategy' : 'strategies'} enabled`;
}

function totalsOf(sample, now) {
  if (!sample) return null;
  const sampledMs = Date.parse(sample.sampledAt || '');
  const nowMs = now instanceof Date ? now.getTime() : (Number.isFinite(Number(now)) ? Number(now) : Date.parse(now));
  return {
    realized: finiteOrNull(sample.realizedPnl),
    unrealized: finiteOrNull(sample.unrealizedPnl),
    total: finiteOrNull(sample.totalPnl),
    strategyCount: finiteOrNull(sample.strategyCount),
    enabledStrategyCount: finiteOrNull(sample.enabledStrategyCount),
    strategiesWords: strategiesWords(sample),
    sampledAt: sample.sampledAt || null,
    sampledClock: Number.isFinite(sampledMs) ? cycleClock(sample.sampledAt) : null,
    ageMinutes: Number.isFinite(sampledMs) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - sampledMs) / 60_000)) : null,
  };
}

/* The sentence beside each row, in the words AlgorithmLivePanel uses for the
 * same statuses. */
function comparisonSentence(entry, cycleStart) {
  switch (entry?.status) {
    case 'compared':
      return entry.differs
        ? `Differs from the desk by ${formatCurrency(Math.abs(entry.distance))}, ${entry.spread} times the usual spread.`
        : `Within the usual spread of the desk (${entry.spread} times).`;
    case 'restarted':
      return `Restarted at ${cycleClock(entry.restartedAt)}, so this figure counts only since then. Not compared.`;
    case 'unmeasured':
      return 'Not measured, not zero.';
    case 'off_cycle':
    case 'not_in_cycle':
      return `Last read at ${cycleClock(entry.sampledAt)}, outside the ${cycleClock(cycleStart)} cycle. Not compared.`;
    case 'cohort_thin':
      return 'Not compared: the desk figure for this algorithm is too thin.';
    default:
      return 'Not compared with the desk.';
  }
}

function comparisonOf(entry, cycleStart) {
  if (!entry) {
    return { status: 'not_compared', differs: false, distance: null, spread: null, sentence: 'Not compared with the desk.' };
  }
  return {
    status: entry.status,
    differs: entry.status === 'compared' && entry.differs === true,
    distance: entry.distance,
    spread: entry.spread,
    sentence: comparisonSentence(entry, cycleStart),
  };
}

function strategyRow(row, entry, cycleStart) {
  const realized = finiteOrNull(row.realizedPnl);
  const unrealized = finiteOrNull(row.unrealizedPnl);
  const restarted = row.restartedAt && Number.isFinite(Date.parse(row.restartedAt)) ? row.restartedAt : null;
  return {
    key: `${row.strategyId ?? ''}|${row.strategyName ?? ''}|${row.algorithm}|${row.instrument}`,
    strategyId: row.strategyId ?? null,
    strategyName: row.strategyName || '',
    algorithm: row.algorithm,
    instrument: row.instrument || '',
    instrumentRoot: row.instrumentRoot,
    realized,
    unrealized,
    total: realized !== null && unrealized !== null ? cents(realized + unrealized) : null,
    restartedAt: restarted,
    restartNote: restarted ? `Restarted at ${cycleClock(restarted)}, so this figure counts only since then.` : null,
    sampledAt: row.sampledAt || null,
    cycleStart: row.cycleStart || null,
    comparison: comparisonOf(entry, cycleStart),
  };
}

/**
 * The detail under one pill.
 *
 * @param {object} input
 * @param {object} input.client {id, uuid?, name}
 * @param {string} input.accountName
 * @param {object|null} input.sample the account's last account_live_samples row, mapped.
 * @param {object|null} input.strategies the loader's answer for this client:
 *   {available, reason?, desk, rows, settings}; null when nothing has been read.
 * @param {Date|number} [input.now]
 */
export function buildAccountLiveDetail({ client, accountName, sample = null, strategies = null, now = new Date() } = {}) {
  const connectionName = typeof sample?.connectionName === 'string' && sample.connectionName.trim()
    ? sample.connectionName.trim() : null;
  const base = {
    accountName,
    clientName: client?.name || String(client?.id || ''),
    connectionName,
    connectionWord: connectionName || NO_CONNECTION_WORD,
    totals: totalsOf(sample, now),
    strategies: [],
    strategiesState: 'unread',
    cycleStart: null,
    differsCount: 0,
    differsWords: null,
  };
  if (!strategies) return base;
  if (strategies.available !== true) return { ...base, strategiesState: 'not_deployed' };

  const mine = strategiesForAccount(strategies.rows, client, accountName);
  if (!mine.length) return { ...base, strategiesState: 'empty' };

  const comparison = buildAlgorithmLiveComparison({
    desk: strategies.desk,
    rows: mine,
    settings: strategies.settings,
    clients: [client].filter(Boolean),
    now,
  });
  const entries = new Map();
  for (const group of comparison.algorithms || []) {
    for (const entry of group.accounts || []) {
      entries.set(`${entry.algorithm}\u0000${entry.instrumentRoot}`, entry);
    }
  }
  const rows = mine
    .map((row) => strategyRow(row, entries.get(`${row.algorithm}\u0000${row.instrumentRoot}`) || null, comparison.cycleStart))
    .sort((a, b) => compareText(a.algorithm, b.algorithm)
      || compareText(a.instrument, b.instrument)
      || compareText(a.strategyName, b.strategyName));
  // Algorithms, not rows: two instances of one algorithm on one root are one
  // account value in the comparison and one question for the desk.
  const differing = new Set(rows.filter((row) => row.comparison.differs).map((row) => `${row.algorithm}\u0000${row.instrumentRoot}`));
  return {
    ...base,
    strategies: rows,
    strategiesState: 'ready',
    cycleStart: comparison.cycleStart,
    comparisonState: comparison.state,
    differsCount: differing.size,
    differsWords: differsWords(differing.size),
  };
}
