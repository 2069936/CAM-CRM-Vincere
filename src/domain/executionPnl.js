// Derive realized PnL per account from NinjaTrader log executions — no balances
// needed. Executions carry price, quantity, market position and entry/exit; an
// average-cost pass per account+instrument realizes PnL on each exit:
//   pnl = (exitPrice - avgEntry) * directionOfOpenPosition * qty * pointValue.
// Instruments without a spec are skipped and reported so the table can be extended.

import { specForInstrument, instrumentRoot } from './instrumentSpecs';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export function computeExecutionPnl(executions = []) {
  const books = new Map(); // `${account}|${root}` -> { openQty (signed), avgPrice }
  const byAccount = {};

  function acct(name) {
    if (!byAccount[name]) {
      byAccount[name] = { accountName: name, realizedPnl: 0, roundTrips: 0, ticksMoved: 0, unknownInstruments: new Set() };
    }
    return byAccount[name];
  }

  for (const ex of executions) {
    const name = ex.accountName;
    if (!name) continue;
    const a = acct(name);
    const spec = specForInstrument(ex.instrument);
    if (!spec) {
      a.unknownInstruments.add(instrumentRoot(ex.instrument));
      continue;
    }
    const key = `${name}|${instrumentRoot(ex.instrument)}`;
    if (!books.has(key)) books.set(key, { openQty: 0, avgPrice: 0 });
    const book = books.get(key);
    const q = Math.abs(Number(ex.quantity) || 0);
    const p = Number(ex.price) || 0;
    if (!q) continue;

    if (ex.entryExit === 'Entry') {
      const dir = /long/i.test(ex.position) ? 1 : /short/i.test(ex.position) ? -1 : (sign(book.openQty) || 1);
      const prevAbs = Math.abs(book.openQty);
      if (sign(book.openQty) === 0 || sign(book.openQty) === dir) {
        book.avgPrice = prevAbs + q ? (book.avgPrice * prevAbs + p * q) / (prevAbs + q) : p;
        book.openQty += dir * q;
      } else {
        book.openQty += dir * q;
        if (sign(book.openQty) === dir) book.avgPrice = p;
      }
    } else if (ex.entryExit === 'Exit') {
      const dir = sign(book.openQty);
      if (dir === 0) continue;
      const closeQty = Math.min(q, Math.abs(book.openQty));
      a.realizedPnl += (p - book.avgPrice) * dir * closeQty * spec.pointValue;
      a.ticksMoved += Math.abs(p - book.avgPrice) / spec.tickSize;
      a.roundTrips += 1;
      book.openQty -= dir * closeQty;
      if (book.openQty === 0) book.avgPrice = 0;
    }
  }

  return Object.values(byAccount).map((a) => ({
    accountName: a.accountName,
    realizedPnl: Math.round(a.realizedPnl * 100) / 100,
    roundTrips: a.roundTrips,
    ticksMoved: Math.round(a.ticksMoved),
    unknownInstruments: [...a.unknownInstruments],
  }));
}
