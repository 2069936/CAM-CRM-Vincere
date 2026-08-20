// Futures contract specs, so PnL can be derived from log executions (price moves)
// without account balances. pointValue = dollars per 1.0 price move per contract;
// tickSize = the minimum price increment (for reporting ticks moved).
// Extend this table for any instrument that shows up as "unknown".
//
// AN UNKNOWN ROOT IS A REFUSAL, NOT A ZERO. deriveStrategyPnl refuses the whole
// (account, instrument) book when this table has no entry for it, and the
// account it belongs to then publishes no per-strategy split at all. That is
// deliberate: an instrument missing from here is a gap in this table, and the
// only two ways it can end is someone adding the row or someone being told the
// day could not be split. Silently pricing it at zero would be the third way,
// and it is the one that looks like an answer.

const SPECS = {
  // Index — CME
  NQ: { pointValue: 20, tickSize: 0.25 },
  MNQ: { pointValue: 2, tickSize: 0.25 },
  ES: { pointValue: 50, tickSize: 0.25 },
  MES: { pointValue: 5, tickSize: 0.25 },
  RTY: { pointValue: 50, tickSize: 0.1 },
  M2K: { pointValue: 5, tickSize: 0.1 },
  YM: { pointValue: 5, tickSize: 1 },
  MYM: { pointValue: 0.5, tickSize: 1 },
  // Metals — COMEX / NYMEX
  GC: { pointValue: 100, tickSize: 0.1 },
  MGC: { pointValue: 10, tickSize: 0.1 },
  SI: { pointValue: 5000, tickSize: 0.005 },
  // Platinum, NYMEX: 50 troy oz × $1, minimum fluctuation $0.10/oz = $5 a tick.
  // Added on the 2026-08-19 export, where it was the only unknown root and one
  // whole book could not be priced because of it. The multiplier is not taken on
  // faith from the contract spec: that book's own Strategies grid reported
  // PLPI-1.3 at -320.00 on a single contract that moved 6.4 points, and
  // 6.4 × 50 = 320 to the cent. See the ASSERTION 3 cross-check in
  // scripts/verify-derived-pnl.mjs, which now reproduces that row.
  PL: { pointValue: 50, tickSize: 0.1 },
  // Energy — NYMEX
  CL: { pointValue: 1000, tickSize: 0.01 },
  MCL: { pointValue: 100, tickSize: 0.01 },
  NG: { pointValue: 10000, tickSize: 0.001 },
  QG: { pointValue: 2500, tickSize: 0.005 },
  // Rates — CBOT. Added when it turned up in a real export and every fill on it
  // was being skipped as "unknown", which silently dropped those accounts out of
  // execution-derived PnL rather than reporting a gap.
  ZB: { pointValue: 1000, tickSize: 1 / 32 },
};

// "NQ JUN26" / "M2K JUN26" / "NG JUL26" -> "NQ". Takes the leading contract root.
export function instrumentRoot(instrument) {
  const m = String(instrument || '').trim().match(/^([A-Za-z0-9]+?)(?:\s|[FGHJKMNQUVXZ]\d{1,2}$)/);
  const raw = m ? m[1] : String(instrument || '').trim().split(/\s+/)[0];
  return (raw || '').toUpperCase();
}

export function specForInstrument(instrument) {
  return SPECS[instrumentRoot(instrument)] || null;
}

export { SPECS };
