// What each account still held open when the previous stored close ended.
//
// WHY THIS EXISTS. deriveStrategyPnl prices a closed pair from the price of the
// lot it closes. A position opened yesterday and closed today has its entry in
// yesterday's file, so a derivation given only today's fills cannot price it and
// refuses the whole book (deriveStrategyPnl rule 5). That refusal is the right
// answer for a caller that cannot see yesterday — scripts/verify-derived-pnl.mjs
// reads one folder and will never see it — and the wrong answer for the CRM,
// which stores every daily_import's executions and orders and therefore CAN.
//
// This module is the difference between those two callers. It replays the stored
// closes forward and hands deriveStrategyPnl the priced opening lots.
//
// WHAT IT REFUSES, AND WHY REFUSING IS THE POINT. A gap in the book — a client
// who did not upload on Tuesday — cannot be detected from a calendar, because
// holidays and half-days make "the previous weekday" a guess. It is detected
// arithmetically instead, and in two independent places:
//
//   HERE. Replaying a stored close whose own fills imply a position the running
//   book does not hold means something happened between the closes we have. That
//   account's carry-in is marked unavailable with reason 'gap' and the CRM then
//   refuses those books exactly as the one-day script would.
//
//   AND AGAIN IN deriveStrategyPnl. The lots handed over must add up to the
//   Position column's implied start for the day being derived, to the contract.
//   Stale lots from a day-before-last almost never will, and when they do not the
//   book is refused rather than priced off a stale basis.
//
// Neither check is a calendar. Both are arithmetic over columns NinjaTrader
// wrote, which is the only kind of check this codebase trusts about a day it did
// not see.
//
// NOT YET EXERCISED BY REAL DATA. Every book on both real exports held so far
// (2026-08-18 and 2026-08-19) started flat and ended flat, so no account has ever
// actually needed this. The tests below it are synthetic and say so. When a real
// carry-in day arrives, re-verify before trusting a split on it — the same
// warning the 08-18 build phase left, still unretired.

import { isExitFill, orderExecutions, parsePosition } from './deriveStrategyPnl.js';

export const CARRY_IN_REASONS = {
  // Nobody looked: the caller holds no close before this date for this account.
  NO_HISTORY: 'no-history',
  // A stored close needed a position the replay did not hold — a day is missing,
  // or the history simply starts mid-position. Either way the lots that would be
  // handed over rest on a basis nobody has, so nothing is handed over as usable.
  GAP: 'gap',
};

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const signedQty = (execution) => (/^buy/i.test(String(execution?.action || '')) ? 1 : -1) * Math.abs(num(execution?.quantity));

/**
 * Replay one close's fills for one account onto a running per-instrument book.
 *
 * Returns the reason the account's carry-in became unusable, or '' if it stayed
 * usable. The book is mutated in place either way: the quantities stay honest
 * even when the prices stop being, so a later day's Position check still lines
 * up and reports a gap rather than a silently short book.
 */
function replayAccountDay(book, executions, strategyByOrderId) {
  const { ordered } = orderExecutions(executions);
  const byInstrument = new Map();
  for (const execution of ordered) {
    const instrument = String(execution?.instrument || '').trim();
    if (!byInstrument.has(instrument)) byInstrument.set(instrument, []);
    byInstrument.get(instrument).push(execution);
  }

  let broken = '';
  for (const [instrument, fills] of byInstrument) {
    if (!book.has(instrument)) book.set(instrument, []);
    const lots = book.get(instrument);
    const held = lots.reduce((total, lot) => total + lot.side * lot.qty, 0);

    const statedFirst = parsePosition(fills[0]?.position);
    const impliedStart = statedFirst == null ? null : statedFirst - signedQty(fills[0]);
    const needs = impliedStart == null ? (isExitFill(fills[0]) ? null : 0) : impliedStart;

    if (needs == null || Math.abs(needs - held) > 1e-9) {
      // This close opened holding something the replay does not have. A day
      // between the closes we hold is missing, or the history simply starts
      // mid-position. Either way the basis is not ours to state.
      broken = CARRY_IN_REASONS.GAP;
      if (needs != null && needs !== held) {
        const missing = needs - held;
        lots.push({ side: missing > 0 ? 1 : -1, qty: Math.abs(missing), price: null, strategyName: '' });
      }
    }

    for (const execution of fills) {
      const side = /^buy/i.test(String(execution?.action || '')) ? 1 : -1;
      const price = num(execution?.price);
      let remaining = Math.abs(num(execution?.quantity));
      while (remaining > 0 && lots.length && lots[0].side !== side) {
        const take = Math.min(remaining, lots[0].qty);
        lots[0].qty -= take;
        remaining -= take;
        if (lots[0].qty <= 1e-9) lots.shift();
      }
      if (remaining > 0) {
        lots.push({
          side,
          qty: remaining,
          price,
          strategyName: strategyByOrderId.get(String(execution?.orderId || '').trim()) || '',
        });
      }
    }
  }
  return broken;
}

/**
 * Open lots per account at the last stored close before `date`.
 *
 * @param {object[]} dailyImports the client's stored closes, each
 *        `{ date, executions, orders }`. Closes on or after `date` are ignored,
 *        so a re-import of the same day cannot feed itself.
 * @param {string} date the trading date being derived.
 * @returns {{ byAccount: Map<string, object>, priorDate: string|null, days: number }}
 *          Each entry is the `carryIn` shape deriveStrategyPnl accepts:
 *          `{ available, reason, priorDate, lots }`. An account with no stored
 *          close is simply absent from the map — deriveStrategyPnl reads that
 *          as 'no-history', which is what it is.
 */
export function carryForwardLots({ dailyImports = [], date } = {}) {
  const prior = (dailyImports || [])
    .filter((entry) => entry && entry.date && String(entry.date) < String(date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const byAccount = new Map();
  if (!prior.length) return { byAccount, priorDate: null, days: 0 };

  const books = new Map();   // account -> Map instrument -> lots
  const broken = new Map();  // account -> reason

  for (const close of prior) {
    const strategyByOrderId = new Map(
      (close.orders || []).map((order) => [String(order?.id || '').trim(), String(order?.strategyName || '').trim()]),
    );
    const byAccountExecutions = new Map();
    for (const execution of close.executions || []) {
      const name = String(execution?.accountName || '').trim();
      if (!name) continue;
      if (!byAccountExecutions.has(name)) byAccountExecutions.set(name, []);
      byAccountExecutions.get(name).push(execution);
    }
    for (const [name, executions] of byAccountExecutions) {
      if (!books.has(name)) books.set(name, new Map());
      const reason = replayAccountDay(books.get(name), executions, strategyByOrderId);
      if (reason && !broken.has(name)) broken.set(name, reason);
    }
  }

  const priorDate = String(prior[prior.length - 1].date);
  for (const [name, book] of books) {
    const lots = [];
    for (const [instrument, instrumentLots] of book) {
      for (const lot of instrumentLots) {
        if (lot.qty <= 1e-9) continue;
        lots.push({ instrument, side: lot.side, qty: lot.qty, price: lot.price, strategyName: lot.strategyName });
      }
    }
    // No separate "these lots have no price" verdict, on purpose. The ONLY way a
    // lot here can lack a price is the placeholder the gap branch above pushes,
    // and that branch sets `broken` in the same breath — so a second check would
    // be a second name for one fact, and an unreachable one. That is not a
    // guess: a mutation that disabled such a check ("M11 carry-forward-unpriced")
    // changed no test and no behaviour, which is how it was found and why it is
    // not here. If a future change can produce an unpriced lot WITHOUT a gap,
    // this needs its own verdict and its own test.
    const reason = broken.get(name) || '';
    byAccount.set(name, {
      available: !reason,
      reason,
      priorDate,
      // Handed over even when unavailable, so a caller that wants to report the
      // size of what it refused can. deriveStrategyPnl ignores them unless
      // `available` is true.
      lots,
    });
  }

  return { byAccount, priorDate, days: prior.length };
}
