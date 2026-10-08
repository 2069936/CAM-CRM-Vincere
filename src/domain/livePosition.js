/* ────────────────────────────────────────────────────────────────────────────
 * WHICH WAY IT FIRED, IN WORDS.
 *
 * Step 64 put three nullable columns on the per strategy reading
 * (algorithm_live_samples): market_position ('long', 'short' or 'flat'),
 * position_quantity (contracts held, 0 when flat) and trades_this_run. Agent
 * 1.2.1 reads them off the strategy's own Position object and posts them with
 * the reading; a 1.2.0 agent posts none, and an add-on that could not read the
 * position posts null.
 *
 * NULL IS "NOT READ". It is never printed as flat and never as 0: a screen that
 * invented a flat position for a machine that did not say would be the thing
 * the CAMs ask each other in the chat to avoid. So every helper here answers
 * null for a reading without the fields, and the screens print nothing.
 *
 * Two phrasings, one place: the drill down under a pill reads
 * "long, 2 contracts, 1 trade this run"; the roll call row reads "long 2" and
 * "3 trades this run" beside it. Both come from here so they cannot drift.
 *
 * Pure: no React, no Supabase.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The three words the column's CHECK constraint allows, in this order. */
export const MARKET_POSITIONS = Object.freeze(['long', 'short', 'flat']);

function wholeOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** 'long', 'short' or 'flat' as the column holds it; anything else is not read. */
export function knownPosition(value) {
  return MARKET_POSITIONS.includes(value) ? value : null;
}

/** "1 trade this run", "3 trades this run", or null when not read. */
export function tradesWords(trades) {
  const n = wholeOrNull(trades);
  return n === null ? null : `${plural(n, 'trade', 'trades')} this run`;
}

/**
 * The drill down sentence for one strategy row: "long, 2 contracts, 1 trade
 * this run". Flat carries no contract count (it is 0 by definition). Only what
 * the reading carried is said; a reading that carried nothing is null.
 */
export function positionWords(row) {
  if (!row) return null;
  const direction = knownPosition(row.marketPosition);
  const quantity = wholeOrNull(row.positionQuantity);
  const trades = tradesWords(row.tradesThisRun);
  const parts = [];
  if (direction) parts.push(direction);
  if (direction !== 'flat' && quantity !== null) parts.push(plural(quantity, 'contract', 'contracts'));
  if (trades) parts.push(trades);
  return parts.length ? parts.join(', ') : null;
}

/** The roll call word for one row: "long 2", "short 1", "flat", or null. */
export function positionShortWords(row) {
  const direction = knownPosition(row?.marketPosition);
  if (!direction) return null;
  if (direction === 'flat') return 'flat';
  const quantity = wholeOrNull(row.positionQuantity);
  return quantity === null ? direction : `${direction} ${quantity}`;
}

const UNREAD = Object.freeze({ direction: null, quantity: null, trades: null, words: null, tradesWords: null });

/**
 * One account's position over its instances of one algorithm (usually one).
 * Instances that agree sum their contracts and read one word; instances that
 * disagree read 'mixed' and list each ("long 2, short 1"). Instances whose
 * position was not read are left out; when none was read, everything is null.
 *
 * @param {Array<{marketPosition?: string, positionQuantity?: number, tradesThisRun?: number}>} instances
 * @returns {{direction: string|null, quantity: number|null, trades: number|null, words: string|null, tradesWords: string|null}}
 */
export function positionOfInstances(instances) {
  const list = Array.isArray(instances) ? instances.filter(Boolean) : [];
  const known = list.filter((row) => knownPosition(row.marketPosition));
  const tradeCounts = list.map((row) => wholeOrNull(row.tradesThisRun)).filter((n) => n !== null);
  const trades = tradeCounts.length ? tradeCounts.reduce((sum, n) => sum + n, 0) : null;
  if (!known.length) {
    return trades === null ? { ...UNREAD } : { ...UNREAD, trades, tradesWords: tradesWords(trades) };
  }
  const directions = [...new Set(known.map((row) => row.marketPosition))];
  const quantities = known.map((row) => wholeOrNull(row.positionQuantity)).filter((n) => n !== null);
  const quantity = quantities.length ? quantities.reduce((sum, n) => sum + n, 0) : null;
  const direction = directions.length === 1 ? directions[0] : 'mixed';
  const words = direction === 'mixed'
    ? known.map(positionShortWords).join(', ')
    : positionShortWords({ marketPosition: direction, positionQuantity: quantity });
  return { direction, quantity, trades, words, tradesWords: tradesWords(trades) };
}
