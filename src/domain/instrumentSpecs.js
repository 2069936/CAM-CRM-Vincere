// Futures contract specs, so PnL can be derived from log executions (price moves)
// without account balances. pointValue = dollars per 1.0 price move per contract;
// tickSize = the minimum price increment (for reporting ticks moved).
// Extend this table for any instrument that shows up as "unknown".

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
  // Metals — COMEX
  GC: { pointValue: 100, tickSize: 0.1 },
  MGC: { pointValue: 10, tickSize: 0.1 },
  SI: { pointValue: 5000, tickSize: 0.005 },
  // Energy — NYMEX
  CL: { pointValue: 1000, tickSize: 0.01 },
  MCL: { pointValue: 100, tickSize: 0.01 },
  NG: { pointValue: 10000, tickSize: 0.001 },
  QG: { pointValue: 2500, tickSize: 0.005 },
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
