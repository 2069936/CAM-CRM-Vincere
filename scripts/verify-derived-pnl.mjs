// Checks the shipped per-strategy derivation against a directory of real
// NinjaTrader exports.
//
//   node scripts/verify-derived-pnl.mjs "/path/to/exports"
//
// The path argument is REQUIRED and no export is committed with this file.
// Nothing here writes, copies or moves anything — the export is read in place.
// Output is aggregates only: account display names are real client account
// numbers, so they are never printed; where a single row has to be pointed at it
// is reduced to a 6-hex opaque tag.
//
// This script imports src/domain/csvImport.js, src/domain/deriveStrategyPnl.js
// and src/domain/joinDerivedStrategies.js DIRECTLY, on purpose. Every earlier probe reimplemented the parsing and the
// pairing, and every one of them drifted: one sniffed grid types by header
// substring and mistook a Strategies grid for an Orders grid, another read an
// absent column as a reported zero. A verification that does not exercise the
// shipped code verifies nothing about the shipped code.
//
// Layout expected: <root>/<subfolder>/*.csv — four NinjaTrader grid CSVs per
// client subfolder, identified by HEADER, because the filenames carry no type.
//
// Exit status is 0 only when every assertion below holds.
//
// READ THE "WHAT THIS RUN DOES AND DOES NOT PROVE" SECTION BEFORE QUOTING ANY
// NUMBER THIS PRINTS. The five assertions are real and they pass, but on an
// export where every book opens and closes flat under a single strategy they are
// insensitive to the pairing rule, to the ordering basis and to the tie-breaking
// — every one of those could be wrong and these assertions would still pass.
// That section measures how much of that insensitivity is present in the export
// being checked, so the headline is never read as proving more than it does.
//
// THIS SCRIPT HAS NO YESTERDAY, AND SAYS SO. It reads ONE directory. A position
// opened before that day's session has its entry in no file it holds, so its
// close cannot be priced here by any means. It therefore passes `carryIn: null`
// into every derivation, and every carried-in book comes back REFUSED. That is
// not a limitation being worked around; it is the correct answer for this caller
// and the difference between it and the CRM, which stores every daily_import and
// can carry the lots forward (src/domain/carryForwardLots.js). ASSERTION 5 below
// pins it: a refused book must publish nothing, here or anywhere.
//
// A MISREADING THIS SCRIPT NOW MEASURES AGAINST. On 2026-08-19, 25 of the 31
// books have an E/X of "Exit" on their FIRST ROW, and that was briefly read as
// 25 carried-in positions. It is not: six of ten executions grids export
// time-DESCENDING, so a book's first row is usually its LAST fill, and a day
// that closed flat ends on an exit. Ordered chronologically, 0 of 31 books open
// on an exit. Both counts are printed below, side by side, so the two can never
// again be mistaken for each other.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { parseNinjaTraderCsvText } from '../src/domain/csvImport.js';
import { deriveStrategyPnl, orderExecutions, parsePosition } from '../src/domain/deriveStrategyPnl.js';
import { joinDerivedStrategies } from '../src/domain/joinDerivedStrategies.js';

const TOLERANCE = 0.51;

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/verify-derived-pnl.mjs <exports-dir>');
  process.exit(2);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`not a directory: ${root}`);
  process.exit(2);
}

const tag = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 6);
const f = (n) => (n == null ? 'n/a' : n.toFixed(2));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

function readFolder(dir) {
  const grids = { accounts: [], strategies: [], orders: [], executions: [] };
  const types = [];
  // The raw header line per grid type. ASSERTION 2 has to be able to say WHICH
  // P&L column a client's terminal exported, not merely that the one it wanted
  // was missing — "no gross" and "no columns at all" are different failures and
  // only one of them is fixed by asking the client to switch a column on.
  const headers = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const parsed = parseNinjaTraderCsvText(text, name);
    types.push(parsed.type);
    if (grids[parsed.type]) {
      grids[parsed.type].push(...parsed.rows);
      headers[parsed.type] = String(text.split(/\r?\n/)[0] || '');
    }
  }
  return { grids, types, headers };
}

/** The P&L columns an accounts grid actually carried, for the refusal message. */
function pnlColumnsIn(header) {
  return String(header || '')
    .split(',')
    .map((cell) => cell.trim())
    .filter((cell) => /pnl/i.test(cell));
}

const totals = {
  folders: 0, foldersNoTrades: 0, unknownFiles: 0,
  accounts: 0, traded: 0,
  executions: 0, executionsJoined: 0,
  pairs: 0, unpricedPairs: 0, openContracts: 0, carriedInContracts: 0,
  reconciled: 0, checkable: 0, exact: 0, partial: 0, unreconciled: 0,
  positionDisagrees: 0,
  strategyRows: 0, reportedRows: 0, reportedAbsent: 0, reportedZero: 0,
  crossChecked: 0, recovered: 0, recoveredAbs: 0, recoveredOnInexactAccount: 0, reportedNotDerived: 0,
  joinStatuses: {}, joinPublished: 0, joinRosterRows: 0, joinMatchedRows: 0, joinNullRows: 0,
  joinAmbiguousAccounts: 0, joinOffRosterRows: 0, joinOffRosterAbs: 0,
  books: 0, flatBooks: 0, multiStrategyBooks: 0, singleStrategyBooks: 0, unnamedBooks: 0,
  namedAndUnnamedBooks: 0,
  pairingIndependentBooks: 0, tiedFills: 0,
  booksExitFirstInFileOrder: 0, booksExitFirstChronologically: 0, booksCarryingIn: 0,
  refusedAccounts: 0, refusedBooks: 0, refusedBookReasons: {}, refusedButPublished: 0,
  noReportedGross: 0, noReportedGrossTraded: 0, grossColumnsSeen: {}, refusedWithGross: 0,
  detachedPairs: 0,
  grossAbsTraded: 0, grossAbsExact: 0,
  attributedAbs: 0, residualAbs: 0,
  residualReasons: {},
  orderingBasis: {},
  unknownInstruments: new Set(),
};
const failures = { unjoined: [], reconciliation: [], crossCheck: [], join: [], refusal: [] };
const refusals = [];

/**
 * How much of the pairing rule this export is actually able to test.
 *
 * Two properties of a book — one (account, instrument) — decide that, and both
 * are arithmetic facts rather than opinions:
 *
 *   FLAT AT BOTH ENDS. If a book carries nothing in and leaves nothing open,
 *   every contract is paired, and the book's total is
 *   multiplier * (sum of sell notional - sum of buy notional) under ANY complete
 *   matching of buys to sells. FIFO, LIFO, file order, reversed order and random
 *   order all give the same number. The account total is then pairing-independent
 *   and reconciling it proves nothing whatever about FIFO or about the ordering.
 *
 *   ONE NAMED STRATEGY. If every fill on the book belongs to a single strategy,
 *   every pair is intra-strategy under any matching, so the per-strategy split is
 *   pairing-independent too — and the "credit a pair only when both legs name the
 *   same strategy" rule never has to arbitrate between two competing strategies,
 *   which means the choice of that rule is untested here.
 *
 * Ordering is taken from the shipped orderExecutions so the measurement follows
 * the shipped code rather than a second opinion about what order the fills are in.
 */
function measureBooks(executions, orders) {
  const strategyByOrderId = new Map(
    (orders || []).map((order) => [String(order.id || '').trim(), String(order.strategyName || '').trim()]),
  );
  const { ordered } = orderExecutions(executions);
  const books = new Map();
  for (const execution of ordered) {
    const key = String(execution?.instrument || '').trim();
    if (!books.has(key)) books.set(key, []);
    books.get(key).push(execution);
  }
  // The same books in the order the FILE listed them, kept only to print the two
  // counts side by side. Reading row 1 of a time-descending grid as the day's
  // opening fill is what produced the 2026-08-19 misdiagnosis; the gap between
  // these two numbers is that mistake, made visible and quantified every run.
  const fileOrderBooks = new Map();
  for (const execution of executions) {
    const key = String(execution?.instrument || '').trim();
    if (!fileOrderBooks.has(key)) fileOrderBooks.set(key, []);
    fileOrderBooks.get(key).push(execution);
  }
  const isExit = (fill) => /^exit$/i.test(String(fill?.entryExit || '').trim());
  for (const fills of fileOrderBooks.values()) {
    if (isExit(fills[0])) totals.booksExitFirstInFileOrder += 1;
  }

  for (const fills of books.values()) {
    totals.books += 1;
    if (isExit(fills[0])) totals.booksExitFirstChronologically += 1;
    const signed = (fill) => (/^buy/i.test(String(fill?.action || '')) ? 1 : -1) * Math.abs(Number(fill?.quantity) || 0);
    const statedFirst = parsePosition(fills[0]?.position);
    const start = statedFirst == null ? 0 : statedFirst - signed(fills[0]);
    const end = fills.reduce((n, fill) => n + signed(fill), start);
    const flat = start === 0 && end === 0;
    if (flat) totals.flatBooks += 1;
    if (start !== 0 || isExit(fills[0])) totals.booksCarryingIn += 1;

    const strategyNames = fills.map((fill) => strategyByOrderId.get(String(fill?.orderId || '').trim()) || '');
    const named = new Set(strategyNames.filter(Boolean));
    if (named.size > 1) totals.multiStrategyBooks += 1;
    else if (named.size === 1) totals.singleStrategyBooks += 1;
    else totals.unnamedBooks += 1;
    // A named strategy trading alongside blank-Strategy fills (a hand-placed leg
    // or an exit NinjaTrader detached from its strategy) is the one attribution
    // decision this export DOES exercise: the rule refuses those pairs and books
    // them to the residual. It is not the same as arbitrating between two named
    // strategies, which nothing here does.
    if (named.size === 1 && strategyNames.some((name) => !name)) totals.namedAndUnnamedBooks += 1;
    if (flat && named.size <= 1) totals.pairingIndependentBooks += 1;

    // Fills sharing a timestamp are the only place the tie-breaking can matter,
    // and they are counted so "the tie-breaker was exercised" is never assumed.
    const seen = new Map();
    for (const fill of fills) {
      const stamp = String(fill?.time || '');
      seen.set(stamp, (seen.get(stamp) || 0) + 1);
    }
    for (const count of seen.values()) if (count > 1) totals.tiedFills += count;
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const { grids, types, headers } = readFolder(path.join(root, entry.name));
  const grossColumns = pnlColumnsIn(headers.accounts).join(' + ') || '(none)';
  totals.grossColumnsSeen[grossColumns] = (totals.grossColumnsSeen[grossColumns] || 0) + 1;
  totals.unknownFiles += types.filter((t) => t === 'unknown').length;
  if (!grids.accounts.length) continue;
  totals.folders += 1;
  if (!grids.executions.length) totals.foldersNoTrades += 1;
  totals.executions += grids.executions.length;
  totals.strategyRows += grids.strategies.length;

  const orderIds = new Set(grids.orders.map((o) => String(o.id || '').trim()).filter(Boolean));
  for (const execution of grids.executions) {
    const orderId = String(execution.orderId || '').trim();
    if (orderId && orderIds.has(orderId)) totals.executionsJoined += 1;
    else failures.unjoined.push(`[${tag(execution.accountName)}] execution has no order row (order id ${orderId ? 'present' : 'EMPTY'})`);
  }

  // ASSERTION 3 needs the grid's own per-strategy Realized, keyed by
  // (account, strategy). A name-only key smears one account's money across every
  // row sharing the name — measured at 13 of 47 rows on a real export.
  const reported = new Map();
  for (const strategy of grids.strategies) {
    const key = `${String(strategy.accountName || '').trim()} ${String(strategy.strategyName || '').trim()}`;
    const value = strategy.realized;
    if (value == null) { totals.reportedAbsent += 1; if (!reported.has(key)) reported.set(key, null); continue; }
    if (Math.abs(value) < 0.005) totals.reportedZero += 1;
    else totals.reportedRows += 1;
    reported.set(key, (reported.get(key) || 0) + value);
  }

  const execsByAccount = new Map();
  for (const execution of grids.executions) {
    const name = String(execution.accountName || '').trim();
    if (!execsByAccount.has(name)) execsByAccount.set(name, []);
    execsByAccount.get(name).push(execution);
  }

  for (const account of grids.accounts) {
    const name = String(account.accountName || '').trim();
    if (!name) continue;
    totals.accounts += 1;
    if (account.grossRealizedPnlReported == null) totals.noReportedGross += 1;
    const executions = execsByAccount.get(name) || [];
    // The RAW 'Gross realized PnL' column. account.grossRealizedPnl prefers the
    // NET 'Realized PnL' whenever the grid exported both, and FIFO reproduces
    // gross — reconciling against the blend rejects nearly every account.
    const reportedGross = account.grossRealizedPnlReported;
    if (!executions.length && !reportedGross) continue;
    totals.traded += 1;
    totals.grossAbsTraded += Math.abs(reportedGross ?? 0);

    measureBooks(executions, grids.orders);

    // `carryIn` is NOT omitted, it is explicitly null, and the difference is the
    // point of this line. Omitting it would read as "nothing was carried in";
    // null reads as "this caller cannot know", which is the truth about a script
    // that was handed one directory. Every carried-in book comes back refused.
    const result = deriveStrategyPnl({
      executions, orders: grids.orders, reportedGross, carryIn: null, tolerance: TOLERANCE,
    });
    totals.detachedPairs += result.detachedPairs;
    for (const book of result.refusedBooks) {
      totals.refusedBooks += 1;
      const reason = book.carryInReason ? `${book.reason} (${book.carryInReason})` : book.reason;
      totals.refusedBookReasons[reason] = (totals.refusedBookReasons[reason] || 0) + 1;
    }
    if (result.status === 'refused') {
      totals.refusedAccounts += 1;
      refusals.push(`[${tag(name)}] ${result.refusedBooks.length} book(s) refused: ${result.refusedBooks.map((b) => b.reason).join(', ')}`);
    }
    // NOT EVERY REFUSAL IS ACCEPTABLE, and the difference is whose fault it is.
    //
    // A carry-in refusal is this script being honest about data it does not
    // hold: the entry is in a file nobody handed it, and no amount of work in
    // this repo produces it. That is an expected outcome, reported and not
    // failed.
    //
    // An unknown instrument is the opposite. The multiplier table is ours, the
    // fix is one line in instrumentSpecs.js, and the whole account stops
    // publishing until someone writes it. Letting the run go green on it is how
    // PL sat unpriceable through a "perfect" 2026-08-18 run and only surfaced
    // when it took an account down the next day. It fails.
    for (const book of result.refusedBooks) {
      if (book.reason !== 'unknown-instrument') continue;
      failures.refusal.push(`[${tag(name)}] ${book.instrument} has no multiplier — add its root to src/domain/instrumentSpecs.js`);
    }
    if (result.status === 'no-reported-gross') {
      totals.noReportedGrossTraded += 1;
      // DECIDED, not defaulted. This grid carried a P&L column — just not the one
      // a FIFO derivation reproduces. 'Realized PnL' is NET of commissions, and
      // on this very account it sits $27.92 away from the derived total for that
      // reason alone. Reading it would fail a correct derivation and call it a
      // pairing error; comparing against undefined would pass anything. The
      // account is refused, and the columns it DID export are named so the fix is
      // "ask the client to enable Gross realized PnL", not "debug the pairing".
      refusals.push(`[${tag(name)}] no 'Gross realized PnL' column; grid carried: ${grossColumns}`);
    }
    totals.pairs += result.pairs;
    totals.unpricedPairs += result.unpricedPairs;
    totals.openContracts += result.openContracts;
    totals.carriedInContracts += result.carriedInContracts;
    totals.orderingBasis[result.orderingBasis] = (totals.orderingBasis[result.orderingBasis] || 0) + 1;
    if (!result.positionAgrees) totals.positionDisagrees += 1;
    for (const instrument of result.unknownInstruments) totals.unknownInstruments.add(instrument);
    for (const [reason, count] of Object.entries(result.residual.reasons)) {
      totals.residualReasons[reason] = (totals.residualReasons[reason] || 0) + count;
    }
    totals.attributedAbs += Math.abs(result.attributedTotal);
    totals.residualAbs += Math.abs(result.residual.realized);

    // ASSERTION 2: FIFO total == Gross realized PnL.
    //
    // A REFUSED ACCOUNT IS NOT A RECONCILIATION FAILURE, and folding the two
    // together is how a refusal gets "fixed" by someone loosening a tolerance.
    // An account with an unpriceable book, or with no gross column to check
    // against, never had a comparison to fail — it is excluded from the ratio
    // here and asserted separately, in ASSERTION 5, to publish nothing at all.
    const isRefusal = result.status === 'refused' || result.status === 'no-reported-gross';
    if (!isRefusal) {
      totals.checkable += 1;
      if (result.reconciles) totals.reconciled += 1;
      else failures.reconciliation.push(`[${tag(name)}] derived ${f(result.derivedTotal)} vs gross ${f(reportedGross)} (delta ${f(result.difference)})`);
    }
    totals[result.status] = (totals[result.status] || 0) + 1;
    if (result.status === 'exact') totals.grossAbsExact += Math.abs(reportedGross ?? 0);

    // ASSERTION 3: every value the grid actually reported equals the derived one.
    //
    // "Actually reported" means a NON-ZERO Realized. A 0.00 in that column is not
    // a claim that the strategy made nothing — it is the gap this whole feature
    // exists to fill. Most rows sit at zero on days the account plainly moved,
    // because NinjaTrader credits a strategy's Realized only when its own
    // position tracking saw the round trip, and it does not when the position was
    // flattened outside the strategy or the strategy was restarted mid-session.
    // Those rows are counted as RECOVERED below, with the account-level
    // reconciliation as their evidence.
    //
    // This exclusion is stated rather than quietly applied. Scoring a grid zero
    // as a disagreement would fail this script on precisely the rows the feature
    // is for; dropping it without saying so would hide a real check. Anyone who
    // wants the stricter reading can count the RECOVERED rows below.
    const derivedByName = new Map(result.byStrategy.map((row) => [row.strategyName, row.realized]));
    for (const [key, value] of reported) {
      if (!key.startsWith(`${name} `)) continue;
      const strategyName = key.slice(name.length + 1);
      if (value == null || Math.abs(value) < 0.005) continue;
      const derived = derivedByName.get(strategyName);
      if (derived == null) { totals.reportedNotDerived += 1; continue; }
      totals.crossChecked += 1;
      if (Math.abs(derived - value) > TOLERANCE) {
        failures.crossCheck.push(`[${tag(name)}] ${strategyName}: grid reported ${f(value)}, derived ${f(derived)}`);
      }
    }
    // ASSERTION 4: the join onto the Strategies-grid roster.
    //
    // A correct derivation is not the same thing as correct rows on a screen.
    // These two lists are joined by strategy name and they are not the same
    // list, so the shipped join is run here on real rosters: it is where a
    // fabricated zero once absorbed an account's whole day, and where one
    // derived row once landed on two same-named grid rows for double the money.
    const rosterRows = grids.strategies.filter((s) => String(s.accountName || '').trim() === name);
    const joined = joinDerivedStrategies({ strategies: rosterRows, derivation: result });
    totals.joinStatuses[joined.join.status] = (totals.joinStatuses[joined.join.status] || 0) + 1;
    if (joined.join.published) totals.joinPublished += 1;
    if (joined.join.ambiguousNames.length) totals.joinAmbiguousAccounts += 1;
    totals.joinRosterRows += rosterRows.length;
    totals.joinMatchedRows += joined.strategies.filter((row) => row.derivedRealized != null).length;
    totals.joinNullRows += joined.strategies.filter((row) => row.derivedRealized == null).length;
    totals.joinOffRosterRows += joined.join.offRoster.length;
    totals.joinOffRosterAbs += Math.abs(joined.join.offRosterRealized);
    if (joined.join.published && Math.abs(joined.join.difference ?? 0) > TOLERANCE) {
      failures.join.push(`[${tag(name)}] published a split whose rows miss gross by ${f(joined.join.difference)}`);
    }
    // ASSERTION 5: a refusal reaches the screen as nothing at all.
    //
    // Every other assertion here is about arithmetic being right. This one is
    // about arithmetic that was never done not being shown anyway. An account
    // holding a book that could not be priced — a carried-in position with no
    // basis, an instrument with no multiplier — has a derived total that is
    // missing money by construction, and its remaining books would still produce
    // perfectly plausible per-strategy rows. The only thing standing between
    // those rows and a client report is this refusal.
    if (isRefusal && joined.join.published) {
      totals.refusedButPublished += 1;
      failures.refusal.push(`[${tag(name)}] status '${result.status}' yet the join published a derived split`);
    }
    // Whether this account could have failed the check above at all. A refused
    // account with NO reported gross is stopped twice over — the join has
    // nothing to balance its rows against and would decline it whatever the
    // status said — so it cannot discriminate. Counted so the assertion can
    // declare itself vacuous instead of quietly passing on nothing.
    if (isRefusal && reportedGross != null) totals.refusedWithGross += 1;

    for (const row of result.byStrategy) {
      const value = reported.get(`${name} ${row.strategyName}`);
      if (value != null && Math.abs(value) >= 0.005) continue;
      totals.recovered += 1;
      totals.recoveredAbs += Math.abs(row.realized);
      if (result.status !== 'exact') totals.recoveredOnInexactAccount += 1;
    }
  }
}

const H = (s) => `\n== ${s}`;
console.log('== scope');
console.log(`client folders with an accounts grid : ${totals.folders} (${totals.foldersNoTrades} traded nothing)`);
console.log(`files no header rule could classify  : ${totals.unknownFiles}`);
console.log(`accounts in the accounts grids       : ${totals.accounts}, of which traded: ${totals.traded}`);
console.log(`executions / closed FIFO pairs       : ${totals.executions} / ${totals.pairs}`);
console.log(`ordering basis used                  : ${JSON.stringify(totals.orderingBasis)}`);
console.log(`contracts carried in / left open     : ${totals.carriedInContracts} / ${totals.openContracts}`);
console.log(`instruments with no multiplier       : ${[...totals.unknownInstruments].join(', ') || 'none'}`);
console.log(`accounts-grid P&L columns exported   : ${JSON.stringify(totals.grossColumnsSeen)}`);

console.log(H('ASSERTION 1 — every execution resolves to an order row'));
console.log(`joined: ${totals.executionsJoined} / ${totals.executions} (${pct(totals.executionsJoined, totals.executions)})`);
for (const line of failures.unjoined.slice(0, 10)) console.log(`  FAIL ${line}`);

console.log(H(`ASSERTION 2 — each account's FIFO total equals Gross realized PnL (±$${TOLERANCE})`));
console.log(`reconciled: ${totals.reconciled} / ${totals.checkable} checkable (${pct(totals.reconciled, totals.checkable)})`);
console.log(`refused before any comparison        : ${totals.traded - totals.checkable} of ${totals.traded} traded`);
console.log('  a refused account is NOT a reconciliation failure and is not in the ratio above:');
console.log('  it never had a comparison to fail. ASSERTION 5 checks it publishes nothing.');
for (const line of failures.reconciliation.slice(0, 10)) console.log(`  FAIL ${line}`);

console.log(H('WHAT THIS RUN DOES AND DOES NOT PROVE — read before quoting the line above'));
console.log(`books (one account × one instrument)     : ${totals.books}`);
console.log(`  flat at both ends (nothing carried in or left open) : ${totals.flatBooks} / ${totals.books}`);
console.log(`  touched by more than one named strategy             : ${totals.multiStrategyBooks} / ${totals.books}`);
console.log(`  one named strategy / no named strategy              : ${totals.singleStrategyBooks} / ${totals.unnamedBooks}`);
console.log(`  one named strategy plus blank-Strategy fills        : ${totals.namedAndUnnamedBooks} / ${totals.books}`);
console.log(`  therefore pairing-independent (flat AND ≤1 strategy) : ${totals.pairingIndependentBooks} / ${totals.books} (${pct(totals.pairingIndependentBooks, totals.books)})`);
console.log(`fills sharing a timestamp with another fill on the same book: ${totals.tiedFills}`);
console.log('');
console.log('CARRY-IN, and the count that is not it:');
console.log(`  books whose FIRST FILE ROW has E/X = Exit          : ${totals.booksExitFirstInFileOrder} / ${totals.books}`);
console.log(`  books whose first CHRONOLOGICAL fill is an Exit    : ${totals.booksExitFirstChronologically} / ${totals.books}`);
console.log(`  books that actually carried a position in         : ${totals.booksCarryingIn} / ${totals.books}`);
console.log('  The first number is an artefact of how the operator sorted the grid — six of');
console.log('  ten executions grids export time-DESCENDING, so a book\'s first ROW is usually');
console.log('  its LAST fill, and any day that closed flat ends on an exit. Only the second');
console.log('  and third numbers are statements about the trading. On 2026-08-19 they read');
console.log('  25, 0 and 0, and the 25 was briefly reported as 25 carried-in positions.');
console.log('');
console.log('A book that is flat at both ends has every contract paired, so its total is');
console.log('  multiplier × (sell notional − buy notional) under ANY complete matching:');
console.log('  FIFO, LIFO, file order, reversed order and random order all agree. A book');
console.log('  under a single named strategy has every pair intra-strategy under any');
console.log('  matching, so its per-strategy split is order-independent too.');
if (totals.pairingIndependentBooks === totals.books && totals.books > 0) {
  console.log('EVERY book here is pairing-independent. ASSERTION 2 above is therefore a');
  console.log('  TAUTOLOGY on this export: it tests the fill set, the multipliers, the root');
  console.log('  matching and the (account, strategy) keying, and it is ZERO evidence for');
  console.log('  FIFO, for the ordering basis, or for the tie-breaking. Do not cite it as');
  console.log('  proof of the pairing rule. Evidence for those needs an export with a book');
  console.log('  that carries a position in or leaves one open, or one worked by two');
  console.log('  strategies at once.');
} else {
  console.log(`${totals.books - totals.pairingIndependentBooks} book(s) here are NOT pairing-independent, so the assertions above do`);
  console.log('  bear on the pairing rule for those books — and only for those.');
}
if (!totals.multiStrategyBooks) {
  console.log('No book is worked by two NAMED strategies, so the attribution rule (credit a');
  console.log('  pair only when both legs name the same strategy) never had to arbitrate');
  console.log('  between two competitors, and rule 4b\'s fence — credit a detached leg only');
  console.log('  where the book has ONE named strategy — is never load-bearing here either.');
  console.log(`  What IS exercised is the weaker case: a named strategy beside blank-Strategy`);
  console.log(`  fills, on ${totals.namedAndUnnamedBooks} book(s). Rule 4b credits those to the one named strategy when`);
  console.log('  the blank order carries a NinjaTrader-generated Name, and refuses them as');
  console.log('  `manual-leg` when it does not. The named-vs-named arbitration is UNEXERCISED');
  console.log('  by this data; the evidence for the rules is the 16 reported values reproduced');
  console.log('  across 2026-08-18 and 2026-08-19, tabulated in deriveStrategyPnl.js, and the');
  console.log('  ASSERTION 3 cross-check above — not anything this section measures.');
}

console.log(H(`ASSERTION 3 — every reported per-strategy Realized equals the derived figure (±$${TOLERANCE})`));
console.log(`cross-checked: ${totals.crossChecked}, disagreements: ${failures.crossCheck.length}`);
console.log(`reported non-zero but derivation declined to attribute: ${totals.reportedNotDerived}`);
console.log('a grid Realized of exactly 0.00 is NOT cross-checked — see the comment at the assertion.');
for (const line of failures.crossCheck) console.log(`  FAIL ${line}`);

console.log(H('what the derivation adds'));
console.log(`strategy rows: ${totals.strategyRows}`);
console.log(`  carrying a non-zero Realized : ${totals.reportedRows}`);
console.log(`  sitting at exactly 0.00      : ${totals.reportedZero}`);
console.log(`  no Realized column at all    : ${totals.reportedAbsent}`);
console.log(`rows derived where the grid reported zero or nothing: ${totals.recovered} (worth ${f(totals.recoveredAbs)})`);
console.log(`  of those, on an account that did NOT fully derive : ${totals.recoveredOnInexactAccount}`);
console.log(`accounts fully split (reconciled, nothing unattributed): ${totals.exact || 0} / ${totals.traded}`);
console.log(`  |gross| they cover: ${f(totals.grossAbsExact)} of ${f(totals.grossAbsTraded)} (${pct(totals.grossAbsExact, totals.grossAbsTraded)})`);
console.log(`accounts reconciled but with a residual : ${totals.partial || 0}`);
console.log(`accounts that did not reconcile         : ${totals.unreconciled || 0}`);
console.log(`accounts whose Position column disagrees with the pairing: ${totals.positionDisagrees}`);

console.log(H('ASSERTION 4 — a published split\'s rows still add up to the account\'s gross'));
console.log(`accounts by join outcome             : ${JSON.stringify(totals.joinStatuses)}`);
console.log(`accounts publishing a derived figure : ${totals.joinPublished} / ${totals.traded}`);
console.log(`roster rows: ${totals.joinRosterRows}, given a derived figure: ${totals.joinMatchedRows}, left absent: ${totals.joinNullRows}`);
console.log(`refused for an ambiguous name (one derived row, several same-named rows): ${totals.joinAmbiguousAccounts}`);
console.log(`derived strategies on no roster row  : ${totals.joinOffRosterRows} (worth ${f(totals.joinOffRosterAbs)})`);
console.log('"left absent" is a roster row the fills never named. It is NOT a derived zero:');
console.log('  a fabricated zero there once absorbed an account\'s entire day while the panel');
console.log('  reported the split as complete. An account with any absent row still publishes');
console.log('  the figures that were matched, but is not shown as a whole-roster split.');
for (const line of failures.join) console.log(`  FAIL ${line}`);

console.log(H('ASSERTION 5 — a book that cannot be priced is refused, and publishes nothing'));
console.log(`accounts refused                     : ${totals.traded - totals.checkable} / ${totals.traded}`);
console.log(`  because a book could not be priced : ${totals.refusedAccounts}`);
console.log(`  because the grid exported no 'Gross realized PnL' : ${totals['no-reported-gross'] || 0}`);
console.log(`books refused                        : ${totals.refusedBooks} / ${totals.books}`);
console.log(`by reason: ${JSON.stringify(totals.refusedBookReasons)}`);
console.log(`accounts with no gross column at all (traded or not): ${totals.noReportedGross} / ${totals.accounts}`);
for (const line of refusals.slice(0, 10)) console.log(`  refused ${line}`);
console.log('A carry-in refusal is reported, not failed: the entry is in a file this script');
console.log('  was never handed. An UNKNOWN-INSTRUMENT refusal IS failed — the multiplier');
console.log('  table is ours and the fix is one line, so a green run on it is how an');
console.log('  unpriceable contract survives a "perfect" day and takes an account down later.');
console.log('This script passes carryIn: null into every derivation — it holds ONE day and');
console.log('  cannot price a lot opened before it. A caller that stores the previous closes');
console.log('  (the CRM, via src/domain/carryForwardLots.js) supplies the priced opening lots');
console.log('  instead, and refuses only when its own replay cannot explain the day\'s opening');
console.log('  position. Neither caller guesses a cost basis.');
if (!totals.refusedWithGross) {
  console.log('THE PUBLICATION HALF OF THIS ASSERTION IS VACUOUS ON THIS EXPORT. Every');
  console.log('  account refused here also has no reported gross, so joinDerivedStrategies');
  console.log('  would decline to publish it on the arithmetic alone — there is nothing for');
  console.log('  its rows to add up to. A mutation removing the status check entirely passes');
  console.log('  this run. What pins it is the unit test "publishes nothing from a refused');
  console.log('  derivation" in joinDerivedStrategies.test.js, not this line. Deciding it');
  console.log('  needs an export with a refused book on an account that DID report gross.');
} else {
  console.log(`${totals.refusedWithGross} refused account(s) here reported a gross, so the join could have`);
  console.log('  published them and did not. That much this export does decide.');
}
for (const line of failures.refusal) console.log(`  FAIL ${line}`);

console.log(H('residual — money paired but credited to no single strategy'));
console.log(`|attributed| ${f(totals.attributedAbs)}   |residual| ${f(totals.residualAbs)}   pairs on a refused book ${totals.unpricedPairs}`);
console.log(`by reason: ${JSON.stringify(totals.residualReasons)}`);
console.log(`pairs credited by rule 4b (a detached leg, book with one named strategy): ${totals.detachedPairs}`);

const failed = failures.unjoined.length + failures.reconciliation.length
  + failures.crossCheck.length + failures.join.length + failures.refusal.length;
console.log(H(failed ? `FAILED — ${failed} assertion failures` : 'PASSED — all five assertions hold'));
if (!failed) {
  console.log('"All five assertions hold" is the whole claim. It is NOT a claim that FIFO');
  console.log('is the right pairing rule, that the ordering basis is right, or that the');
  console.log('attribution rule was tested against a competing strategy — see the section');
  console.log('above for how much of that this export can and cannot decide. And an export');
  console.log('with no carried-in book, as both real ones so far have been, says NOTHING');
  console.log('about carry-in beyond the fact that it did not arise.');
}
process.exit(failed ? 1 : 0);
