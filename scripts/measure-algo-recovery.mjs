// Measures how much per-algo P&L a FIFO derivation actually recovers, and where
// it still cannot help, against a directory of real NinjaTrader exports.
//
//   node scripts/measure-algo-recovery.mjs "/path/to/exports"
//
// The path argument is REQUIRED. Nothing here writes, copies or moves the export
// — it is read in place. Output is aggregates only: account display names are
// real client account numbers, so they are never printed; accounts are counted
// and, where a single row must be pointed at, reduced to a 6-hex opaque tag.
//
// Layout expected: <root>/<subfolder>/*.csv, four NinjaTrader grid CSVs per
// subfolder, identified by HEADER (the filenames carry no type).
//
// The three rules this script exists to hold, each established against the real
// export and each one a place an earlier attempt went wrong:
//
//   1. Order rows by the EXECUTION ID, not by file order and not by Time. The
//      grid exports newest-first, and Time has same-second ties. Exec ID is
//      "<seq>_<n>" and is monotonic; under it the Position column is
//      reproducible from Action+Quantity on 100% of fills.
//   2. FIFO reproduces 'Gross realized PnL', NOT 'Realized PnL'. The latter is
//      net of commissions and differs on nearly every account.
//   3. Key derived P&L by (ACCOUNT, strategy name). A strategy name is not
//      unique within one client export — the same name runs on up to 4 accounts
//      — so a name-only key silently moves one account's money onto another's row.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import Papa from 'papaparse';

const MULT = {
  MES: 5, MNQ: 2, M2K: 5, MGC: 10, MYM: 0.5, MCL: 100,
  ES: 50, NQ: 20, YM: 5, RTY: 50, GC: 100, NG: 10000, CL: 1000, ZB: 1000,
};
const ROOTS = Object.keys(MULT).sort((a, b) => b.length - a.length);
const EPS = 0.005;

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/measure-algo-recovery.mjs <exports-dir>');
  process.exit(1);
}

const norm = (h) => String(h || '').trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
const tag = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
const money = (v) => {
  if (v == null || v === '') return 0;
  let s = String(v).trim().replace(/[$,]/g, '');
  if (s.startsWith('(') && s.endsWith(')')) s = `-${s.slice(1, -1)}`;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const rootOf = (i) => {
  const c = String(i || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  for (const r of ROOTS) if (c.startsWith(r)) return r;
  return null;
};
const execSeq = (e) => {
  const m = String(e.id || '').match(/^(\d+)_(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, 0];
};
const byExecId = (a, b) => {
  const [a1, a2] = execSeq(a); const [b1, b2] = execSeq(b);
  return a1 - b1 || a2 - b2;
};

function classify(fields) {
  const k = new Set(fields.map(norm));
  if (k.has('grossrealizedpnl') && k.has('displayname')) return 'accounts';
  if (k.has('ex') && k.has('position')) return 'executions';
  if (k.has('strategy') && k.has('parameters')) return 'strategies';
  if (k.has('strategy') && k.has('avgprice')) return 'orders';
  return 'unknown';
}

function readFolder(dir) {
  const out = { accounts: [], strategies: [], orders: [], executions: [] };
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const res = Papa.parse(fs.readFileSync(path.join(dir, name), 'utf8'), { header: true, skipEmptyLines: true });
    const type = classify(res.meta.fields || []);
    if (type === 'unknown') continue;
    for (const raw of res.data) {
      const row = {};
      for (const [k, v] of Object.entries(raw)) if (k) row[norm(k)] = v;
      out[type].push(row);
    }
  }
  return out;
}

// FIFO over exec-ID-ordered fills, per (account, instrument). Each closed pair
// remembers BOTH legs' order ids so the caller can refuse to attribute a pair
// whose two legs do not belong to the same strategy.
function fifo(executions) {
  const list = [...executions].sort(byExecId);
  const books = new Map();
  const pairs = [];
  for (const e of list) {
    const acct = String(e.accountdisplayname || '').trim();
    const instr = String(e.instrument || '').trim();
    const mult = MULT[rootOf(instr)] ?? null;
    const key = `${acct}|${instr}`;
    if (!books.has(key)) books.set(key, []);
    const book = books.get(key);
    const side = /^buy/i.test(e.action) ? 1 : -1;
    let qty = Math.abs(money(e.quantity));
    const price = money(e.price);
    while (qty > 0 && book.length && book[0].side !== side) {
      const lot = book[0];
      const take = Math.min(qty, lot.qty);
      pairs.push({
        account: acct,
        instrument: instr,
        qty: take,
        pnl: (price - lot.price) * take * (mult ?? 0) * (lot.side === 1 ? 1 : -1),
        multKnown: mult != null,
        openOrderId: String(lot.oid || '').trim(),
        closeOrderId: String(e.orderid || '').trim(),
      });
      lot.qty -= take; qty -= take;
      if (lot.qty <= 1e-9) book.shift();
    }
    if (qty > 0) book.push({ side, qty, price, oid: e.orderid || '' });
  }
  const openContracts = [...books.values()].reduce((n, b) => n + b.reduce((m, l) => m + l.qty, 0), 0);
  return { pairs, openContracts };
}

const folders = fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)).sort();

const T = {
  folders: 0, foldersWithNoTrades: 0,
  accountsInGrid: 0, accountsTraded: 0, accountsReconciled: 0,
  accountsAnyReported: 0, accountsFullyReported: 0, accountsFullyDerived: 0,
  execs: 0, pairs: 0,
  pairsSameStrategy: 0, pairsMixed: 0, pairsNoStrategy: 0, pairsCrossStrategy: 0,
  dollarsPairsTotal: 0, dollarsPairsAttributable: 0, dollarsPairsMixed: 0,
  strategyRows: 0, strategyRowsNonZero: 0,
  grossAbsTraded: 0, grossAbsFullyDerived: 0, grossAbsGridSplit: 0,
  openContracts: 0,
  execsJoined: 0,
  gridOnlyAccounts: 0, derivedOnlyAccounts: 0, grossAbsDerivedOnly: 0,
};
const dangerous = [];
const reportedOnly = [];
const recovered = [];
const agreements = [];
const nameOnlyCollisions = [];

for (const dir of folders) {
  const data = readFolder(dir);
  if (!data.accounts.length) continue;
  T.folders += 1;
  T.execs += data.executions.length;
  T.strategyRows += data.strategies.length;
  for (const s of data.strategies) if (money(s.realized) !== 0) T.strategyRowsNonZero += 1;
  if (!data.executions.length) T.foldersWithNoTrades += 1;

  const orderStrategy = new Map();
  for (const o of data.orders) {
    const id = String(o.id || '').trim();
    if (id) orderStrategy.set(id, String(o.strategy || '').trim());
  }
  for (const e of data.executions) if (orderStrategy.has(String(e.orderid || '').trim())) T.execsJoined += 1;

  const gross = new Map();
  for (const a of data.accounts) {
    const nm = String(a.displayname || '').trim();
    if (nm) gross.set(nm, money(a.grossrealizedpnl));
  }

  const reported = new Map();
  for (const s of data.strategies) {
    const k = `${String(s.accountdisplayname || '').trim()}\u0000${String(s.strategy || '').trim()}`;
    reported.set(k, (reported.get(k) || 0) + money(s.realized));
  }

  const { pairs, openContracts } = fifo(data.executions);
  T.openContracts += openContracts;
  T.pairs += pairs.length;

  const derived = new Map();          // account \0 strategy -> attributable pnl
  const derivedAll = new Map();       // account -> every pair, attributable or not
  const unattributable = new Map();   // account -> pnl that cannot be assigned
  const byNameOnly = new Map();       // the buggy key, kept only to measure the damage

  for (const p of pairs) {
    const so = orderStrategy.get(p.openOrderId) || '';
    const sc = orderStrategy.get(p.closeOrderId) || '';
    T.dollarsPairsTotal += Math.abs(p.pnl);
    derivedAll.set(p.account, (derivedAll.get(p.account) || 0) + p.pnl);

    if (so && sc && so === sc) {
      T.pairsSameStrategy += 1;
      T.dollarsPairsAttributable += Math.abs(p.pnl);
      const k = `${p.account}\u0000${so}`;
      derived.set(k, (derived.get(k) || 0) + p.pnl);
      byNameOnly.set(so, (byNameOnly.get(so) || 0) + p.pnl);
    } else if (so && sc) {
      T.pairsCrossStrategy += 1;
      T.dollarsPairsMixed += Math.abs(p.pnl);
      unattributable.set(p.account, (unattributable.get(p.account) || 0) + p.pnl);
    } else if (so || sc) {
      // One leg is a strategy order, the other a manual/unowned order. The
      // strategy did not own both sides, so this money is not the strategy's.
      T.pairsMixed += 1;
      T.dollarsPairsMixed += Math.abs(p.pnl);
      unattributable.set(p.account, (unattributable.get(p.account) || 0) + p.pnl);
    } else {
      T.pairsNoStrategy += 1;
      T.dollarsPairsMixed += Math.abs(p.pnl);
      unattributable.set(p.account, (unattributable.get(p.account) || 0) + p.pnl);
    }
  }

  // How much would the name-only key have moved onto the wrong account's row?
  for (const s of data.strategies) {
    const acct = String(s.accountdisplayname || '').trim();
    const name = String(s.strategy || '').trim();
    const wrong = byNameOnly.get(name) || 0;
    const right = derived.get(`${acct}\u0000${name}`) || 0;
    if (Math.abs(wrong - right) > EPS) {
      nameOnlyCollisions.push({ acct: tag(acct), name, wrong, right, reported: money(s.realized) });
    }
  }

  for (const [acct, g] of gross) {
    T.accountsInGrid += 1;
    const traded = Math.abs(g) > EPS || derivedAll.has(acct);
    if (!traded) continue;
    T.accountsTraded += 1;
    T.grossAbsTraded += Math.abs(g);

    const derivedTotal = derivedAll.get(acct) || 0;
    const reconciled = Math.abs(derivedTotal - g) < EPS;
    if (reconciled) T.accountsReconciled += 1;

    const stuck = unattributable.get(acct) || 0;
    const fullyDerived = reconciled && Math.abs(stuck) < EPS;
    if (fullyDerived) { T.accountsFullyDerived += 1; T.grossAbsFullyDerived += Math.abs(g); }

    const keys = new Set([
      ...[...reported.keys()].filter((k) => k.startsWith(`${acct}\u0000`)),
      ...[...derived.keys()].filter((k) => k.startsWith(`${acct}\u0000`)),
    ]);
    let repSum = 0; let anyRep = false;
    for (const k of keys) { const r = reported.get(k) || 0; repSum += r; if (r !== 0) anyRep = true; }
    if (anyRep) T.accountsAnyReported += 1;
    const fullyReported = anyRep && Math.abs(repSum - g) < EPS;
    if (fullyReported) { T.accountsFullyReported += 1; T.grossAbsGridSplit += Math.abs(g); }
    if (fullyReported && !fullyDerived) T.gridOnlyAccounts += 1;
    if (fullyDerived && !fullyReported) { T.derivedOnlyAccounts += 1; T.grossAbsDerivedOnly += Math.abs(g); }

    for (const k of keys) {
      const name = k.split('\u0000')[1];
      const r = reported.get(k) || 0;
      const d = derived.get(k) || 0;
      if (Math.abs(r) > EPS && Math.abs(d) > EPS && Math.abs(r - d) > EPS) {
        dangerous.push({ acct: tag(acct), name, reported: r, derived: d });
      } else if (Math.abs(r) > EPS && Math.abs(d) > EPS) {
        agreements.push({ acct: tag(acct), name, value: r });
      } else if (Math.abs(r) > EPS && Math.abs(d) <= EPS) {
        reportedOnly.push({ acct: tag(acct), name, reported: r });
      } else if (Math.abs(d) > EPS && Math.abs(r) <= EPS) {
        recovered.push({ acct: tag(acct), name, derived: d, reconciled });
      }
    }
  }
}

const f = (n) => n.toFixed(2);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const H = (s) => `\n== ${s}`;

console.log('== scope');
console.log(`client folders with an accounts grid : ${T.folders}`);
console.log(`  of those, folders with no trades   : ${T.foldersWithNoTrades}`);
console.log(`accounts present in the accounts grid: ${T.accountsInGrid}`);
console.log(`accounts that traded                 : ${T.accountsTraded}`);
console.log(`executions / closed FIFO pairs       : ${T.execs} / ${T.pairs}`);
console.log(`contracts left unpaired (carried)    : ${T.openContracts}`);

console.log(H('attribution join: executions.OrderID -> orders.ID -> orders.Strategy'));
console.log(`executions whose Order ID resolves : ${T.execsJoined} / ${T.execs} (${pct(T.execsJoined, T.execs)})`);
console.log(`pairs with BOTH legs one strategy  : ${T.pairsSameStrategy} (${pct(T.pairsSameStrategy, T.pairs)})  <- attributable`);
console.log(`pairs with legs of two strategies  : ${T.pairsCrossStrategy}`);
console.log(`pairs with one strategy + one manual: ${T.pairsMixed}  <- NOT attributable`);
console.log(`pairs with neither leg a strategy  : ${T.pairsNoStrategy}  <- NOT attributable`);

console.log(H('recovery, in dollars'));
console.log(`gross |P&L| across all closed pairs  : ${f(T.dollarsPairsTotal)}`);
console.log(`  attributable to a named strategy   : ${f(T.dollarsPairsAttributable)} (${pct(T.dollarsPairsAttributable, T.dollarsPairsTotal)})`);
console.log(`  unattributable (mixed/manual legs) : ${f(T.dollarsPairsMixed)} (${pct(T.dollarsPairsMixed, T.dollarsPairsTotal)})`);
console.log(`|gross| over accounts that traded    : ${f(T.grossAbsTraded)}`);
console.log(`  the grid already split completely  : ${f(T.grossAbsGridSplit)} (${pct(T.grossAbsGridSplit, T.grossAbsTraded)})`);
console.log(`  derivation splits completely       : ${f(T.grossAbsFullyDerived)} (${pct(T.grossAbsFullyDerived, T.grossAbsTraded)})`);

console.log(H('recovery, in account-days'));
console.log(`accounts reconciled by FIFO       : ${T.accountsReconciled} / ${T.accountsTraded} (${pct(T.accountsReconciled, T.accountsTraded)})`);
console.log(`accounts with ANY reported split  : ${T.accountsAnyReported} / ${T.accountsTraded} (${pct(T.accountsAnyReported, T.accountsTraded)})`);
console.log(`accounts the grid split COMPLETELY: ${T.accountsFullyReported} / ${T.accountsTraded} (${pct(T.accountsFullyReported, T.accountsTraded)})`);
console.log(`accounts derivation splits FULLY  : ${T.accountsFullyDerived} / ${T.accountsTraded} (${pct(T.accountsFullyDerived, T.accountsTraded)})`);
console.log(`  net NEW accounts derivation adds : ${T.derivedOnlyAccounts} (worth ${f(T.grossAbsDerivedOnly)})`);
console.log(`  accounts the grid split but derivation cannot: ${T.gridOnlyAccounts}`);

console.log(H('strategies grid coverage'));
console.log(`strategy rows: ${T.strategyRows}, with a non-zero Realized: ${T.strategyRowsNonZero} (${pct(T.strategyRowsNonZero, T.strategyRows)})`);

console.log(H('CROSS-CHECK: rows the grid DID report, vs what derivation says'));
console.log(`exact agreements (both non-zero, equal to the cent): ${agreements.length}`);
console.log(`disagreements                                      : ${dangerous.length}`);
console.log(`grid reported but derivation declined              : ${reportedOnly.length}`);

console.log(H('DANGEROUS CLASS: reported non-zero AND derived non-zero AND different'));
console.log(`count: ${dangerous.length}`);
for (const d of dangerous) console.log(`  [${d.acct}] ${d.name}: reported ${f(d.reported)} vs derived ${f(d.derived)}  (delta ${f(d.derived - d.reported)})`);

console.log(H('reported non-zero, derivation declines to attribute'));
console.log(`count: ${reportedOnly.length}`);
for (const d of reportedOnly) console.log(`  [${d.acct}] ${d.name}: reported ${f(d.reported)}`);

console.log(H('RECOVERED: derived non-zero where the grid reported 0'));
console.log(`rows: ${recovered.length}, dollars: ${f(recovered.reduce((n, r) => n + Math.abs(r.derived), 0))}`);
for (const r of recovered) console.log(`  [${r.acct}] ${r.name}: ${f(r.derived)}${r.reconciled ? '' : '  (account did not reconcile)'}`);

console.log(H('damage a name-only key would do (the bug this measurement rules out)'));
console.log(`strategy rows given the wrong number by a name-only key: ${nameOnlyCollisions.length}`);
for (const c of nameOnlyCollisions) {
  console.log(`  [${c.acct}] ${c.name}: reported ${f(c.reported)} | name-only would show ${f(c.wrong)} | correct ${f(c.right)}`);
}
