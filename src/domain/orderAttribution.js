/* ---------------------------------------------------------------------------
 * WHICH ALGORITHM PLACED AN ORDER, WORKED OUT FROM THE SHAPE OF THE TRADE.
 *
 * This is the collector's attribution engine, on the desk's side of the wire.
 * The agent runs it on one machine against that machine's own database; this
 * runs it against the 59,264 orders the CRM already holds for every client, so
 * the answer does not wait for somebody to take a Deep Export.
 *
 * WHY IT IS NEEDED AT ALL. NinjaTrader records which strategy placed an order
 * and deletes that record by cascade the moment the strategy leaves the
 * workspace. Measured on a real VPS: 29 surviving links against 18,827 orders
 * over seven months. The desk rotates algorithms constantly, so it destroys its
 * own attribution constantly.
 *
 * HOW IT WORKS. A strategy template declares its geometry - how many contracts
 * each scale-out leg takes, and how far the stop and each profit target sit
 * from the entry in ticks - and a placed trade leaves exactly that geometry in
 * the order book. The G4M template declares 2/1/1 with stop 80 and targets
 * 80/120/160; its orders sat at exactly those distances. Tick for tick.
 *
 * THE ONE RULE. A wrong algorithm name is worse than none: absent, an account
 * day shows up as unattributable and somebody looks at it; wrong, it silently
 * moves a day's losses onto an algorithm that never traded them. So a geometry
 * two algorithms share attributes to neither, and a version two versions share
 * answers the algorithm with a null version rather than picking one.
 *
 * WHAT DIFFERS FROM THE AGENT'S COPY, and it is not the rule. The agent reads
 * NinjaTrader's own tables, so it knows each order's original price before a
 * trailing stop moved it, and the instrument's tick size. The CRM's `orders`
 * rows carry the price as submitted and no tick size at all, so the distances
 * come from TICK_SIZES below and the comparison is on what the rows can
 * support. Where that is not enough, this answers nothing.
 * ------------------------------------------------------------------------- */

/**
 * Tick size per instrument root, because `orders` does not carry one.
 *
 * These are contract specifications, not preferences: MES and MNQ move in
 * quarter points, YM in whole points, crude in cents. An instrument absent
 * here is not guessed at - its orders are left unattributed, which is the same
 * answer this gives for anything else it cannot measure.
 */
export const TICK_SIZES = Object.freeze({
  MES: 0.25, MNQ: 0.25, M2K: 0.1, MYM: 1,
  ES: 0.25, NQ: 0.25, RTY: 0.1, YM: 1,
  MGC: 0.1, GC: 0.1,
  CL: 0.01, MCL: 0.01,
  NG: 0.001,
  PL: 0.1,
});

/**
 * `MNQ 12-26` and `MNQ` are the same contract for this purpose.
 *
 * SPLIT ON THE SPACE, NOT ON THE DIGIT. A contract root can contain a digit -
 * M2K is the micro Russell - and cutting at the first one turns it into `M`,
 * which is in no tick table and silently drops the instrument. It cost 151
 * orders across 33 trades on the seven months measured. The expiry is always
 * separated by whitespace in this desk's data, in both forms it writes
 * (`MNQ 12-26` and `MNQ SEP26`).
 */
export function instrumentRoot(instrument) {
  const text = String(instrument || '').trim().toUpperCase();
  if (!text) return '';
  return text.split(/\s+/)[0] || '';
}

export function tickSizeFor(instrument) {
  return TICK_SIZES[instrumentRoot(instrument)] ?? null;
}

/**
 * The rung an order fills: `Enter`, `Stop`, `PT1`.
 *
 * The side is deliberately dropped. A strategy that goes long on Monday and
 * short on Tuesday is one strategy, and folding the side in would make it two.
 */
export function rungOf(orderName) {
  const name = String(orderName || '').trim();
  if (!name) return '';
  const head = name.split('-')[0];
  return head.split(' ')[0].trim();
}

export function isEntry(order) { return rungOf(order?.name).toLowerCase() === 'enter'; }
export function isStop(order) { return rungOf(order?.name).toLowerCase() === 'stop'; }
export function isTarget(order) { return rungOf(order?.name).toUpperCase().startsWith('PT'); }

/** `PT2-Short` is rung 2. A bare `PT` is rung 1. */
export function targetNumber(order) {
  if (!isTarget(order)) return 0;
  const digits = rungOf(order.name).replace(/\D/g, '');
  return digits ? Number(digits) : 1;
}

/**
 * Group one account's orders into trades: an entry and the exits belonging to
 * it.
 *
 * Two things break a naive walk and both are ordinary trading. A re-entry while
 * a position is open leaves the first trade's exits still live, so closing the
 * group on every entry hands them to the second. And an exit only belongs to an
 * entry if that entry has not already filled the same rung. So exits are given
 * to the OLDEST open entry with room for them, and one that fits nowhere is
 * dropped rather than attached to the nearest.
 */
export function reconstructTrades(orders = []) {
  const ordered = (orders || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => compare(a.time, b.time) || compare(a.id, b.id));

  const open = [];
  for (const order of ordered) {
    if (isEntry(order)) {
      open.push({ entry: order, exits: [] });
      continue;
    }
    const target = open.find((trade) => hasRoomFor(trade, order));
    if (target) target.exits.push(order);
  }
  return open;
}

/**
 * Order two of anything a caller might hand in as a time or an id.
 *
 * NUMBERS ARE COMPARED AS NUMBERS. Sorting them as text is the defect this
 * codebase has already paid for once: `deriveStrategyPnl` records that reading
 * NinjaTrader's clock column as a string puts "10:00 AM" before "9:35 AM", which
 * reorders an entire morning. The same applies to an epoch and to an order id -
 * "100" sorts before "99" - and a reordered book hands the first trade's targets
 * to the second. Text still compares as text, so a caller passing an ISO
 * timestamp is unaffected.
 */
function compare(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b) && String(left).trim() !== '' && String(right).trim() !== '') {
    return a - b;
  }
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function hasRoomFor(trade, order) {
  if (isStop(order)) return !trade.exits.some(isStop);
  if (!isTarget(order)) return false;
  const rung = targetNumber(order);
  return !trade.exits.some((exit) => isTarget(exit) && targetNumber(exit) === rung);
}

/**
 * The geometry a trade exhibits, in the units a template declares.
 *
 * Null when the entry never filled or the instrument has no tick size: a
 * distance measured against nothing is not a measurement.
 */
export function tradeGeometry(trade) {
  const entry = trade?.entry;
  if (!entry) return null;
  const tick = tickSizeFor(entry.instrument);
  if (!tick) return null;
  const basis = priceOf(entry.avgPrice) ?? priceOf(entry.limitPrice) ?? priceOf(entry.stopPrice);
  if (basis === null) return null;

  let stopTicks = 0;
  const rungs = new Map();
  for (const exit of trade.exits) {
    const price = priceOf(exit.limitPrice) ?? priceOf(exit.stopPrice);
    if (price === null) continue;
    const ticks = Math.round(Math.abs(price - basis) / tick);
    if (isStop(exit)) {
      if (stopTicks === 0) stopTicks = ticks;
    } else if (isTarget(exit)) {
      const rung = targetNumber(exit);
      if (rung >= 1 && rung <= 3 && !rungs.has(rung)) {
        rungs.set(rung, { ticks, size: Math.round(Number(exit.quantity) || 0) });
      }
    }
  }
  if (!rungs.size && !stopTicks) return null;
  return { instrument: instrumentRoot(entry.instrument), stopTicks, rungs };
}

/**
 * A zero is not a price.
 *
 * An order row carries both a limit and a stop column and the one it does not
 * use holds 0 rather than null. Taking the zero measures every stop from the
 * instrument's own price: on crude that produced stops 6,411 ticks away and
 * matched nothing at all. Filtering them took the same code from 0% to 55%.
 */
function priceOf(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Which template a geometry belongs to.
 *
 * MATCHED ON WHAT THE TRADE SHOWS, NOT ON THE WHOLE TEMPLATE. Requiring every
 * declared rung meant only trades that ran all the way to a third target could
 * match - 446 of 4,782 on a real machine, and 5% of seven months recognised.
 * Comparing only the rungs actually placed takes it to 55%.
 *
 * Never fuzzy: versions are separated by as little as five ticks, so a
 * tolerance wide enough to absorb noise is wide enough to answer the wrong
 * version.
 */
export function matchGeometry(geometry, templates = []) {
  if (!geometry) return null;
  const candidates = (templates || []).filter((template) => fits(template, geometry));
  if (!candidates.length) return null;

  const families = [...new Set(candidates.map((template) => template.family))];
  if (families.length !== 1) return null;

  // The stop NARROWS, it does not reject - see `fits`. Where the observed stop
  // does pick out a subset, that subset decides the version; where it picks out
  // nothing, the targets answer on their own and the version may come back null.
  const exact = geometry.stopTicks > 0
    ? candidates.filter((template) => Number(template.stopTicks) === geometry.stopTicks)
    : [];
  const deciding = exact.length ? exact : candidates;

  const versions = [...new Set(deciding.map((t) => t.version).filter(Boolean))];
  const risks = [...new Set(deciding.map((t) => t.risk).filter(Boolean))];
  return {
    family: families[0],
    version: versions.length === 1 ? versions[0] : null,
    risk: risks.length === 1 ? risks[0] : null,
    candidates: candidates.length,
  };
}

/**
 * THE TARGETS DECIDE; THE STOP IS NOT ALLOWED TO REFUSE.
 *
 * A template declares where the stop was PLACED. NinjaTrader rewrites that
 * price as a trailing stop moves, so what the CRM stores is where the stop
 * ENDED, and comparing the two rejects a correct match for a reason that is not
 * a disagreement. Measured over seven months: 673 trades, 14% of the book,
 * failed on the stop alone.
 *
 * Letting it go costs nothing, and that is measured rather than assumed. Across
 * the desk's whole library exactly 3 template groups share their targets and
 * differ in their stop, and NONE of the three crosses families - every one is
 * two versions of the same algorithm. So the stop has never been what separates
 * one algorithm from another here; it separates versions, which is why
 * `matchGeometry` still uses it to pick the version and reports a null version
 * rather than a guess when it cannot.
 *
 * The agent's own copy keeps the strict comparison, because on the machine it
 * can read the original price out of OrderUpdates and has nothing to forgive.
 */
function fits(template, geometry) {
  if (!template) return false;
  if (instrumentRoot(template.instrument) !== geometry.instrument) return false;
  for (const [rung, observed] of geometry.rungs) {
    const ticks = Number(template[`target${rung}Ticks`]);
    const size = Number(template[`size${rung}`]);
    if (ticks !== observed.ticks || size !== observed.size) return false;
  }
  // A trade that showed no targets at all has only its stop to go on, and a
  // stop alone is not enough to name an algorithm.
  return geometry.rungs.size > 0;
}

/**
 * Attribute every order of one account.
 *
 * RECORD ALWAYS BEATS INFERENCE. An order that already carries a strategy name
 * is what the platform itself asserted, and nothing worked out here replaces
 * it. Everything else is the geometry's answer, or nothing.
 */
export function attributeOrders(orders = [], templates = []) {
  const results = [];
  for (const trade of reconstructTrades(orders)) {
    const match = matchGeometry(tradeGeometry(trade), templates);
    for (const order of [trade.entry, ...trade.exits]) {
      const recorded = String(order.strategyName || '').trim();
      if (recorded) {
        results.push({ id: order.id, family: recorded, version: null, basis: 'record' });
      } else if (match) {
        results.push({ id: order.id, family: match.family, version: match.version, basis: 'inferred' });
      }
      // No row at all when neither settles it: absence is the honest answer and
      // the column stays null, which is what "nobody has worked this out" looks
      // like on every screen that reads it.
    }
  }
  return results;
}
