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
 * fills and orders and add, for the accounts the new capture names, the ones
 * the capture does not list, before reconcileDailyImport runs. The derivation
 * is then the union's. Each added row carries `fromStore: true`, which the
 * database reads twice: it merges the row onto itself (it is already stored),
 * and it does not count it as the capture's own when it asks whether a capture
 * showed any activity for an account (step 73, rule d).
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
 * move during the day.
 *
 * If the read fails, the caller goes on without it, and the database sets the
 * split of every account whose stored fills the payload did not carry to NULL
 * ("not derived"), so a figure over part of the day is never stored either way.
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
 * @param {{ executions?: Object[], orders?: Object[], accounts?: Object[] }} rows
 *   executions and orders as selected from their tables, accounts as
 *   `{ id, account_name }` of the client's trading_accounts.
 */
export function storedFillsFromRows({ executions = [], orders = [], accounts = [] } = {}) {
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
  if (!executions.length && !orders.length) {
    return { parsed: capture, added: { executions: 0, orders: 0 } };
  }
  return {
    parsed: {
      ...capture,
      executions: [...(capture.executions || []), ...executions],
      orders: [...(capture.orders || []), ...orders],
    },
    added: { executions: executions.length, orders: orders.length },
  };
}

/**
 * The step both callers run: read the day, add what the capture lacks, and
 * never fail the close over it. A store without the reader (a test double, an
 * older adapter) and a read that fails both leave the capture as it came; the
 * database then refuses to keep a split computed over part of the day.
 */
export async function addStoredFills({ store, clientId, date, parsed, report = () => {} }) {
  if (typeof store?.loadStoredFills !== 'function') return parsed;
  try {
    const stored = await store.loadStoredFills(clientId, date);
    return withStoredFills(parsed, stored).parsed;
  } catch (error) {
    try { report(error); } catch { /* a reporter must not fail the close */ }
    return parsed;
  }
}
