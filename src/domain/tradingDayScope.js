// Keeps a daily import to the day it claims to cover.
//
// The AddOn reads account.Orders and account.Executions straight from
// NinjaTrader, which holds whatever the platform has loaded — not what the
// Accounts grid happens to show. On a first capture that is months of history,
// and all of it lands stamped with today's trading date.
//
// This matters more than it sounds. Orders and executions drive the strategy
// attribution and the activity a CAM reads; a day carrying six months of fills
// reports a client as having traded far more than they did, on a day they may
// not have traded at all.
//
// The manual CSV flow was mostly safe by accident: a CAM exports the grid, and
// the grid shows the session. Even so, a real book carried 242 orders and 85
// executions dated before the import they were filed under.

/** Live states. An order in one of these is working now, whenever it was placed. */
const LIVE_ORDER_STATES = new Set([
  'initialized', 'submitted', 'accepted', 'working', 'pending submit',
  'pending change', 'pending cancel', 'cancel pending', 'partially filled',
  'change pending', 'triggered',
]);

/**
 * NinjaTrader writes `7/13/2026 12:15:35 PM`; the CRM stores ISO. Both appear
 * depending on whether a row came from a grid export or the AddOn.
 */
export function tradingDateOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

export function isLiveOrderState(state) {
  const text = String(state || '').trim().toLowerCase();
  if (!text) return false;
  // Rejections carry the broker's whole message, so match on the prefix.
  if (text.startsWith('rejected')) return false;
  return LIVE_ORDER_STATES.has(text);
}

/**
 * Orders belonging to a trading day.
 *
 * A working order placed last Friday is still live on Monday and still that
 * client's exposure, so state outranks date. Anything filled, cancelled or
 * rejected on an earlier day is finished business and belongs to the day it
 * happened on, not to this one.
 *
 * An order with no readable timestamp is kept. Dropping rows because a format
 * was not recognised would quietly delete real trading, which is a worse
 * failure than carrying a few extra.
 */
export function scopeOrdersToDay(orders = [], date) {
  const day = tradingDateOf(date) || String(date || '').slice(0, 10);
  if (!day) return orders;
  return orders.filter((order) => {
    const when = tradingDateOf(order?.time);
    if (!when) return true;
    if (when === day) return true;
    return isLiveOrderState(order?.state);
  });
}

/**
 * Executions belonging to a trading day.
 *
 * No state exception here: a fill is an event with a time. One from last week
 * happened last week, and counting it today would double it — it was already
 * counted on the day it occurred.
 */
export function scopeExecutionsToDay(executions = [], date) {
  const day = tradingDateOf(date) || String(date || '').slice(0, 10);
  if (!day) return executions;
  return executions.filter((execution) => {
    const when = tradingDateOf(execution?.time);
    return when === null || when === day;
  });
}

/** What was dropped and why, so a capture full of history is visible rather than silently trimmed. */
export function summarizeScope(orders = [], executions = [], date) {
  const keptOrders = scopeOrdersToDay(orders, date);
  const keptExecutions = scopeExecutionsToDay(executions, date);
  return {
    orders: { received: orders.length, kept: keptOrders.length, dropped: orders.length - keptOrders.length },
    executions: {
      received: executions.length,
      kept: keptExecutions.length,
      dropped: executions.length - keptExecutions.length,
    },
  };
}
