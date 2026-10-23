/* WHAT THE DAY ALREADY HOLDS, HANDED BACK TO THE DERIVATION (step 73).
 *
 * Since step 73 a later capture of a day MERGES into it: a fill the day holds
 * and the new capture lacks is kept, because a NinjaTrader restart loses the
 * earlier fills from memory and the next capture simply does not list them.
 * The per algorithm split (`derivedRealized`, deriveStrategyPnl.js) is worked
 * out in JavaScript BEFORE the database merges anything, from the fills the
 * payload carries. Left alone it would be the split of the new capture's fills
 * only, stored beside a day that holds more.
 *
 * So the ingest route and the Manager's normal replay read the day's stored
 * fills, orders and strategy rows and add, for the accounts the new capture
 * names, the ones the capture does not list, before reconcileDailyImport runs.
 * The derivation is then the union's, and it covers the strategies an earlier
 * capture listed and this one does not: a strategy loaded in the morning and
 * gone from NinjaTrader by 16:30 still gets its share of the day's fills. Each
 * added row carries `fromStore: true`, which the database reads three ways: a
 * fill or an order merges onto itself (it is already stored); a fill does not
 * count as the capture's own when the database asks whether a capture showed
 * any activity for an account (step 73, rule d); and a strategy row is never
 * inserted, it only brings the stored row its derived_realized, ran and
 * ran_basis.
 *
 * Accounts the capture does not name get nothing added: their rows are kept by
 * the merge untouched, and naming them in the payload would make them present.
 *
 * IDENTITY, the database's own (step 73): a fill by its execution id within
 * its account, or, without one, by (instrument, action, quantity, price, time,
 * order id); an order by its order id, or (instrument, action, order type,
 * quantity, limit, stop, time, name). Matched by MULTIPLICITY: two identical
 * fills without an id in the day and one in the capture add one, never two and
 * never none. An order present in both is the capture's: its state and fill
 * move during the day. A strategy by (account, strategy name, instrument), as
 * a GROUP: when the capture lists any row of that identity, none of the
 * stored ones is added, because the database replaces the group.
 *
 * IF THE READ FAILS, THE CLOSE WAITS. The ingest route answers 503 and
 * releases the batch, and the agent sends the same capture again; storing it
 * without the day's fills would store a split over part of the day (which the
 * database would then have to blank). Only a store without the reader at all
 * (a test double, an adapter from before step 73) goes on with the capture.
 */

const lower = (value) => String(value ?? '').trim().toLowerCase();
const text = (value) => (value === null || value === undefined ? '' : String(value));

/** A number as the database compares it: null stays null, 1.50 equals 1.5. */
function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fillIdentity(row) {
  const account = lower(row.accountName);
  const id = text(row.id).trim();
  if (id) return JSON.stringify([account, 'id', id]);
  return JSON.stringify([
    account, 'fallback',
    text(row.instrument), text(row.action), amount(row.quantity), amount(row.price),
    text(row.time), text(row.orderId),
  ]);
}

function orderIdentity(row) {
  const account = lower(row.accountName);
  const id = text(row.id).trim();
  if (id) return JSON.stringify([account, 'id', id]);
  return JSON.stringify([
    account, 'fallback',
    text(row.instrument), text(row.action), text(row.orderType), amount(row.quantity),
    amount(row.limit), amount(row.stop), text(row.time), text(row.name),
  ]);
}

function strategyIdentity(row) {
  return JSON.stringify([lower(row.accountName), lower(row.strategyName), lower(row.instrument)]);
}

/** The accounts a capture speaks for, in any of its four sections, lower cased. */
export function accountsNamedBy(parsed = {}) {
  const names = new Set();
  for (const section of ['accounts', 'strategies', 'orders', 'executions']) {
    for (const row of parsed?.[section] || []) {
      const key = lower(row?.accountName);
      if (key) names.add(key);
    }
  }
  return names;
}

/**
 * The stored rows of one close, in the shape the normalizer produces, each
 * marked `fromStore`. Values are carried as stored, nulls as nulls, so the
 * identity the database computes on the way back in is the one it stored.
 *
 * @param {{ executions?: Object[], orders?: Object[], strategies?: Object[], accounts?: Object[] }} rows
 *   executions, orders and strategy rows as selected from their tables,
 *   accounts as `{ id, account_name }` of the client's trading_accounts. A
 *   provisional strategy row (source 'tracker') is not the close's and is
 *   left out: a capture replaces it.
 */
export function storedFillsFromRows({ executions = [], orders = [], strategies = [], accounts = [] } = {}) {
  const nameById = new Map((accounts || []).map((account) => [account.id, account.account_name || '']));
  return {
    executions: (executions || [])
      .filter((row) => nameById.has(row.trading_account_id))
      .map((row) => ({
        id: text(row.external_execution_id),
        orderId: text(row.external_order_id),
        accountName: nameById.get(row.trading_account_id),
        strategyName: text(row.strategy_name),
        instrument: text(row.instrument),
        action: text(row.action),
        quantity: amount(row.quantity),
        price: amount(row.price),
        time: text(row.time_text),
        entryExit: text(row.entry_exit),
        position: text(row.position),
        name: text(row.name),
        commission: amount(row.commission),
        rate: amount(row.rate),
        connection: text(row.connection),
        fromStore: true,
      })),
    orders: (orders || [])
      .filter((row) => nameById.has(row.trading_account_id))
      .map((row) => ({
        id: text(row.external_order_id),
        accountName: nameById.get(row.trading_account_id),
        strategyName: text(row.strategy_name),
        instrument: text(row.instrument),
        action: text(row.action),
        orderType: text(row.order_type),
        quantity: amount(row.quantity),
        limit: amount(row.limit_price),
        stop: amount(row.stop_price),
        state: text(row.state),
        filled: amount(row.filled),
        avgPrice: amount(row.avg_price),
        remaining: amount(row.remaining),
        name: text(row.name),
        time: text(row.time_text),
        fromStore: true,
      })),
    strategies: (strategies || [])
      .filter((row) => nameById.has(row.trading_account_id) && row.source !== 'tracker')
      .map((row) => ({
        accountName: nameById.get(row.trading_account_id),
        strategyName: text(row.strategy_name),
        strategyFamily: text(row.strategy_family),
        strategyVersion: text(row.strategy_version),
        instrument: text(row.instrument),
        dataSeries: text(row.data_series),
        direction: text(row.direction),
        enabled: row.enabled === true,
        realized: amount(row.realized),
        unrealized: amount(row.unrealized),
        ...(typeof row.ran === 'boolean' ? { ran: row.ran } : {}),
        ...(row.ran_basis ? { ranBasis: row.ran_basis } : {}),
        fromStore: true,
      })),
  };
}

/** The stored rows the capture does not list, by multiplicity. */
function missingFrom(captured, stored, identity, accounts) {
  const counts = new Map();
  for (const row of captured) {
    const key = identity(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const added = [];
  for (const row of stored) {
    if (!accounts.has(lower(row.accountName))) continue;
    const key = identity(row);
    const left = counts.get(key) || 0;
    if (left > 0) {
      counts.set(key, left - 1);
      continue;
    }
    added.push(row);
  }
  return added;
}

/**
 * The capture, with the day's stored fills and orders it does not list added
 * for the accounts it names. Returns the same object when there is nothing to
 * add, and a shallow copy otherwise; the capture's own rows come first, in
 * their order, so nothing the normalizer decided moves.
 *
 * @returns {{ parsed: Object, added: { executions: number, orders: number } }}
 */
export function withStoredFills(parsed, stored) {
  const capture = parsed || {};
  const accounts = accountsNamedBy(capture);
  const executions = missingFrom(capture.executions || [], stored?.executions || [], fillIdentity, accounts);
  const orders = missingFrom(capture.orders || [], stored?.orders || [], orderIdentity, accounts);
  // Strategies by group: an identity the capture lists at all is the capture's.
  const listed = new Set((capture.strategies || []).map(strategyIdentity));
  const strategies = (stored?.strategies || [])
    .filter((row) => accounts.has(lower(row.accountName)) && !listed.has(strategyIdentity(row)));
  if (!executions.length && !orders.length && !strategies.length) {
    return { parsed: capture, added: { executions: 0, orders: 0, strategies: 0 } };
  }
  return {
    parsed: {
      ...capture,
      executions: [...(capture.executions || []), ...executions],
      orders: [...(capture.orders || []), ...orders],
      strategies: [...(capture.strategies || []), ...strategies],
    },
    added: { executions: executions.length, orders: orders.length, strategies: strategies.length },
  };
}

/**
 * The step both callers run: read the day and add what the capture lacks. A
 * store without the reader (a test double, an adapter from before step 73)
 * leaves the capture as it came. A read that FAILS throws: the caller turns it
 * into a retry, so the capture lands later with the day's fills rather than
 * now with a split over part of them.
 */
export async function addStoredFills({ store, clientId, date, parsed }) {
  if (typeof store?.loadStoredFills !== 'function') return parsed;
  const stored = await store.loadStoredFills(clientId, date);
  return withStoredFills(parsed, stored).parsed;
}
