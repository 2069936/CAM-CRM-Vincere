// Per-strategy realized P&L, derived from the fills rather than read off the
// Strategies grid.
//
// The Strategies grid reports a `Realized` per strategy on only a minority of
// rows — 11 of 47 on the first export this was built against, 27 of 64 on the
// second — so most accounts move without the export ever saying which algo moved
// them. Everything here exists to close that gap without inventing anything,
// because a per-algo number that is wrong is worse than one that is missing: the
// missing one is visibly missing, the wrong one gets acted on.
//
// THE PIPELINE
//
//   executions --Order ID--> orders --Strategy--> a name on each leg
//   FIFO per (account, instrument), chronological, closes each opening lot
//   a book that cannot be priced is REFUSED whole; it is never valued at zero
//
// WHAT TWO DAYS OF REAL EXPORTS ESTABLISHED, AND WHAT THEY DID NOT
//
// Read this before citing any number below, and before deciding a rule here is
// settled because the verifier is green.
//
// 2026-08-18 (25 books, 21 accounts). Every (account, instrument) book started
// flat and ended flat, and no book was touched by more than one named strategy.
// On such a book every contract is paired, so the book's total is
// multiplier * (sell notional - buy notional) under ANY complete matching of
// buys to sells — FIFO, LIFO, file order, reversed order and random order all
// produce the identical account total, and every pair is intra-strategy under
// any matching. "21 of 21 accounts reconcile" was therefore a TAUTOLOGY on that
// day. It was real evidence about the fill set, the multipliers, the
// instrument-root matching and the (account, strategy) keying — all of which it
// exercises hard — and ZERO evidence for FIFO, for the ordering basis, or for
// the tie-breaking.
//
// 2026-08-19, the very next trading day (31 books, 20 traded accounts). Also
// flat at both ends on all 31 books, also no book worked by two named
// strategies. So the second day did not settle FIFO either. What it DID settle
// is rule 4b below, because it produced FIVE new discriminating observations
// where the first day had three — and on the strict rule the first day shipped,
// four of them came out WRONG, by $311.50, $315.00, $400.00 and $201.00.
//
// WHAT THE 08-18 RUN WAS NEVER EVIDENCE ABOUT: CARRY-IN. Not one book on either
// day carried a position in. The first day's perfect run said nothing whatever
// about a book whose entry lies in a session we do not hold, and the build phase
// said so at the time ("CARRY-IN IS SYNTHETIC-ONLY ... a day with a genuine
// carry-in should be re-verified before trusting the split on it"). That day has
// still not arrived. Carry-in handling below is therefore still synthetic-only,
// and it is now a REFUSAL rather than an attempt — see rule 5.
//
// A WARNING ABOUT HOW THAT WAS NEARLY MISDIAGNOSED. The 08-19 failure was first
// read as carry-in, on the observation that 25 of the 31 books have an E/X of
// "Exit" on their FIRST ROW. That count is real and it means nothing: six of ten
// executions grids export time-DESCENDING, so the first row of a book is usually
// its LAST fill of the day, and a day that closed flat ends on an exit. Ordered
// chronologically by orderExecutions, ZERO of the 31 books open on an exit and
// ZERO carry a contract in. Order the fills before reading anything off their
// sequence; the E/X column is not a substitute.
//
// THE FIVE RULES, each measured, each a place an earlier attempt went wrong.
//
// 1. ORDER BY EXECUTION ID, not by file order and not by Time. The grid exports
//    in whatever order the operator had it sorted — measured across ten client
//    folders: six time-descending, three grouped by the E/X column, zero
//    ascending. Time has same-second ties. The execution id is "<seq>_<n>" and
//    is monotonic; under it the Position column is reproducible from
//    Action+Quantity on 100% of fills, which is the check `positionAgrees`
//    performs on every leg.
//
// 2. RECONCILE AGAINST 'Gross realized PnL', never 'Realized PnL'. The latter is
//    net of commissions and differs on 19 of 21 traded accounts. Note that
//    csvImport's mapAccount stores the NET figure in the field it calls
//    `grossRealizedPnl` whenever the grid exported both, so this module wants
//    `reportedGross` passed in from `grossRealizedPnlReported` — the raw column.
//    AND WHEN THAT COLUMN IS ABSENT THE ACCOUNT IS REFUSED, not reconciled
//    against the net one and not against undefined — status 'no-reported-gross'.
//    One client on 08-19 runs a terminal configured without it; substituting the
//    net column would have failed that account by exactly its commissions
//    ($27.92) and called it a pairing error.
//
// 3. KEY BY (ACCOUNT, STRATEGY NAME), never by name alone. A strategy name is
//    not unique inside one client export: "Bullet Bot-1.1" runs on four separate
//    accounts in a single folder, and six of ten folders hold at least one name
//    spanning several accounts. A name-only key gave 13 of 47 strategy rows a
//    wrong number — three rows that genuinely made $0 would each have displayed
//    -1115 belonging to a different account. This module is account-scoped by
//    construction: callers hand it one account's fills.
//
// 4. ATTRIBUTE A PAIR ONLY WHEN BOTH LEGS NAME THE SAME STRATEGY — with one
//    exception, 4b, which two days of data forced open and which is bounded so
//    that the case rule 4 was built to refuse is still refused.
//
//    The rule as first shipped, measured on 08-18 against every value the grid
//    did report:
//
//      rule                            agrees  DISAGREES  |$| attributed
//      both legs same strategy             11          0      11,867.00
//      opening lot's strategy              10          1      14,067.75
//      closing leg, else opening           10          1      14,067.75
//
//    Both looser rules got one row wrong the same way: an account whose FIFO
//    book pairs a MANUAL entry against a strategy exit for -72. NinjaTrader
//    excludes that -72 and reports -228; they report -300. That case is still
//    refused here, as `manual-leg`, and the test named "refuses a pair whose two
//    legs belong to different owners" pins it.
//
// 4b. A DETACHED LEG IS CREDITED TO THE STRATEGY ON THE OTHER LEG, when the
//    detached order carries a NinjaTrader-generated Name and the book is worked
//    by at most one named strategy.
//
//    A "detached" leg is an order whose Strategy cell is BLANK but whose Name is
//    one NinjaTrader writes for a strategy's own order — "Stop Short", "PT1-
//    Short", "Enter Long", "Close". A hand-placed order has no Name at all, and
//    that is the whole distinction between this and the -72 case above.
//
//    The 08-18 header recorded this refinement, measured it at 11 agreements /
//    0 disagreements and $13,320.75, and declined it: "It rests on three
//    discriminating observations on one trading day ... Every such pair is
//    tagged `detached-exit` in the residual below, so a later day's evidence can
//    promote it without re-measuring from scratch." 08-19 is that later day, and
//    it did not merely add evidence — it made the strict rule WRONG:
//
//      account   strategy    grid reported   strict rule   with 4b
//      A         RBO-1.8          -922.50       -611.00    -922.50
//      B         RBO-1.8          -957.50       -642.50    -957.50
//      C         IFSP-1.1         +100.00       -300.00    +100.00
//      C         OGX-2.4          -410.50       -209.50    -410.50
//      D         Bullet Bot-1.1  +1550.00      (declined)  +1550.00
//
//    All five to the cent. The first four are detached EXITS; D is the mirror
//    image — a detached ENTRY ("Enter Short") closed by two named exits — which
//    is why the rule is written about a detached LEG and not about exits.
//
//    The totals, with the multiplier table complete on both days:
//
//      rule            08-18            08-19            declined
//      4b              11 agree, 0 dis  26 agree, 0 dis  1
//      strict          11 agree, 0 dis  21 agree, 4 DIS  2
//
//    "Declined" is a value the grid reported that the derivation would not
//    attribute at all — visible as a gap, never as a wrong figure. The one 4b
//    still declines is the both-legs-detached book described below.
//
//    WHAT 4b IS STILL FENCED AGAINST. It fires only when the book carries at
//    most ONE named strategy, because then the strategy the detached leg belongs
//    to is not in question — there is only one candidate on that book. On a book
//    worked by two named strategies, which no export has yet shown, the pair
//    stays refused as `detached-exit`: FIFO would pick an owner and nothing would
//    check it. And it never fires on a nameless order, which is rule 4's case.
//
//    ONE CASE 4b DOES NOT REACH, measured and left refused. On 08-19 one book
//    had BOTH legs detached — entry and exit each blank-Strategy with a
//    generated Name — and the grid credited the whole round trip (-330.00) to
//    the single strategy its Strategies-grid row names for that instrument.
//    Reaching it needs the roster passed into this module, which is fills-only
//    by construction, and it is one observation. It stays `no-strategy` in the
//    residual, where it is visible and countable.
//
// 5. A BOOK THAT CANNOT BE PRICED IS REFUSED WHOLE, and the account it belongs
//    to publishes nothing.
//
//    Two things make a book unpriceable, and neither is allowed to end as a
//    number on a screen:
//
//    CARRY-IN. A position opened before this export's session has its entry in
//    no file we hold, so its cost basis does not exist and its close cannot be
//    valued. A caller that HAS the previous days — the CRM, which stores every
//    daily_import's executions — can supply the priced opening lots through
//    `carryIn` (see carryForwardLots.js), and the seeded lots must match the
//    Position column's implied start exactly or they are rejected. A caller that
//    does NOT have them — scripts/verify-derived-pnl.mjs, which reads one folder
//    — passes nothing and every carried-in book is refused as
//    `carry-in-refused`. Both witnesses are read: a non-zero implied start from
//    the Position column, OR a first chronological fill whose E/X is "Exit".
//
//    UNKNOWN INSTRUMENT. A root missing from instrumentSpecs has no multiplier,
//    so every pair on that book is unvaluable. It is refused as
//    `unknown-instrument` and the root is named in `unknownInstruments` so the
//    table can be extended. On 08-19 this was PL (platinum) — added since.
//
//    Refusal is at BOOK level and it poisons the ACCOUNT: `status` becomes
//    'refused', and joinDerivedStrategies publishes only on 'exact'. An earlier
//    shape let the priceable books of a refused account still produce rows and
//    left the account's failure to reconcile as the only thing standing between
//    a half-priced day and the screen. That is one arithmetic coincidence away
//    from a wrong number, so the refusal is now explicit and named.

import { instrumentRoot, SPECS } from './instrumentSpecs.js';

export const RESIDUAL_REASONS = {
  CROSS_STRATEGY: 'cross-strategy',
  // A detached leg on a book worked by MORE than one named strategy: rule 4b
  // will not pick between them. Not the same as `manual-leg`.
  DETACHED_EXIT: 'detached-exit',
  MANUAL_LEG: 'manual-leg',
  NO_STRATEGY: 'no-strategy',
  // Book refusals. Every pair on a refused book carries one of these and is
  // counted, never valued.
  CARRY_IN: 'carry-in-refused',
  UNKNOWN_INSTRUMENT: 'unknown-instrument',
};

// Why a whole book was refused. Same strings as the residual reasons that carry
// them, so a reader does not have to hold two vocabularies.
export const BOOK_REFUSALS = {
  CARRY_IN: RESIDUAL_REASONS.CARRY_IN,
  UNKNOWN_INSTRUMENT: RESIDUAL_REASONS.UNKNOWN_INSTRUMENT,
};

// Reconciliation is asserted to the cent. Across the two real exports the
// pairing reproduces Gross realized PnL exactly on every account whose books are
// all priceable, so a looser window would only hide a real break. (Every book on
// both days was flat at both ends, which makes that total pairing-independent —
// see the header. The cent-level tightness is evidence about the multipliers and
// the fill set, not about FIFO.)
export const DEFAULT_TOLERANCE = 0.005;

const ROOTS_BY_LENGTH = Object.keys(SPECS).sort((a, b) => b.length - a.length);

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Point multiplier for an instrument string.
 *
 * The grid writes the same contract three ways — 'MNQ SEP26', 'MNQ 09-26',
 * 'MNQU6' — so the month-code-aware root is tried first and a longest-known-root
 * prefix match on the alphanumeric-stripped string is the fallback. Returns null
 * for an instrument with no spec; its book is refused, not valued at zero.
 */
export function multiplierFor(instrument) {
  const direct = SPECS[instrumentRoot(instrument)];
  if (direct) return direct.pointValue;
  const cleaned = String(instrument || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  for (const root of ROOTS_BY_LENGTH) {
    if (cleaned.startsWith(root)) return SPECS[root].pointValue;
  }
  return null;
}

/** '2 S' -> -2, '4 L' -> 4, '-' / '' -> 0. The position AFTER the fill. */
export function parsePosition(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '-') return 0;
  const match = text.match(/^(-?[\d.]+)\s*([LS])?/i);
  if (!match) return null;
  const size = Number.parseFloat(match[1]);
  if (!Number.isFinite(size)) return null;
  if (/^s$/i.test(match[2] || '')) return -Math.abs(size);
  if (/^l$/i.test(match[2] || '')) return Math.abs(size);
  return size;
}

/** NinjaTrader writes '8/18/2026 9:30:01 AM'; the AddOn writes ISO. */
export function parseExecutionTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([AP]M)?/i);
  if (us) {
    let hour = Number(us[4]);
    if (us[8]) {
      const pm = /^pm$/i.test(us[8]);
      hour = hour % 12 + (pm ? 12 : 0);
    }
    return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), hour, Number(us[5]), Number(us[6]), Number(us[7] || 0));
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// NinjaTrader writes execution ids two ways, and one real export used both — a
// "<seq>_<n>" pair in some client folders and a bare monotonic integer in others,
// with one folder carrying both. Either is orderable on its own; comparing one
// against the other is meaningless, so a mixed set is not ordered by id at all.
function execSequence(execution) {
  const id = String(execution?.id || '').trim();
  const pair = id.match(/^(\d+)_(\d+)$/);
  if (pair) return { form: 'pair', major: Number(pair[1]), minor: Number(pair[2]) };
  if (/^\d+$/.test(id)) return { form: 'int', major: Number(id), minor: 0 };
  return null;
}

const signedQty = (execution) => (/^buy/i.test(String(execution?.action || '')) ? 1 : -1) * Math.abs(num(execution?.quantity));

/** True when this fill's E/X column says it closed a position. */
export function isExitFill(execution) {
  return /^exit$/i.test(String(execution?.entryExit || '').trim());
}

/**
 * How many fills in this ordering contradict the Position column.
 *
 * Position is the account's position in that instrument AFTER the fill, so a
 * correct ordering reproduces it exactly from Action + Quantity. Zero mismatches
 * is the signal that the fills are in the order they actually happened.
 */
function positionMismatches(executions) {
  if (!executions.length) return 0;
  const firstStated = parsePosition(executions[0]?.position);
  let running = firstStated == null ? 0 : firstStated - signedQty(executions[0]);
  let mismatches = 0;
  for (const execution of executions) {
    running += signedQty(execution);
    const stated = parsePosition(execution?.position);
    if (stated != null && Math.abs(running - stated) > 1e-9) mismatches += 1;
  }
  return mismatches;
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([items[i], ...rest]);
  }
  return out;
}

/**
 * Reorder fills that share a sort key so the Position column comes out right.
 *
 * Timestamps tie: a real export had two fills on one instrument stamped the same
 * second, and the wrong one first made the leg look as though it had carried a
 * contract in overnight. That invented an unpriced lot, dropped a real pair, and
 * left the account $13.75 short of its own gross — a plausible-looking wrong
 * number, which is the exact failure this module exists to prevent. Ties are
 * two rows long in practice; the search is capped so a pathological grid degrades
 * to "leave it alone" rather than hanging.
 */
function resolveTiesByPosition(executions, keys) {
  if (executions.length < 2 || positionMismatches(executions) === 0) return executions;

  const runs = [];
  for (let i = 0; i < executions.length;) {
    let j = i + 1;
    while (j < executions.length && keys[j] === keys[i]) j += 1;
    if (j - i > 1) runs.push([i, j]);
    i = j;
  }
  if (!runs.length) return executions;

  const perRun = runs.map(([from, to]) => permutations(executions.slice(from, to)));
  const combinations = perRun.reduce((n, list) => n * list.length, 1);
  if (combinations > 5040) return executions;

  let best = executions;
  let bestScore = positionMismatches(executions);
  for (let n = 0; n < combinations; n += 1) {
    const candidate = [...executions];
    let cursor = n;
    for (let r = 0; r < runs.length; r += 1) {
      const list = perRun[r];
      const choice = list[cursor % list.length];
      cursor = Math.floor(cursor / list.length);
      for (let k = 0; k < choice.length; k += 1) candidate[runs[r][0] + k] = choice[k];
    }
    const score = positionMismatches(candidate);
    if (score < bestScore) { best = candidate; bestScore = score; if (!score) break; }
  }
  return best;
}

/**
 * Chronological order for one account's fills.
 *
 * Execution id first, timestamp second, and file order only when neither is
 * readable. `basis` says which was used so a caller can see how the grid was
 * ordered — falling back to row order silently is how a reversed export produces
 * a plausible wrong number. Measured across ten client folders: six executions
 * grids were time-DESCENDING, three were grouped by the E/X column, none was
 * ascending. There is no fixed direction that works.
 *
 * Ties are then broken per instrument against the Position column, which is the
 * only witness in the file to what order the fills really happened in.
 *
 * NOTHING may read a book's "first" fill without coming through here. Reading
 * row 1 of a time-descending grid as the day's opening fill is what produced the
 * 2026-08-19 misdiagnosis recorded in the header: 25 of 31 books "started" with
 * an exit in file order, 0 of 31 did once ordered.
 */
export function orderExecutions(executions = []) {
  const rows = executions.map((execution, index) => ({ execution, index, seq: execSequence(execution), time: parseExecutionTime(execution?.time) }));
  const forms = new Set(rows.map((row) => row.seq?.form));
  const basis = rows.every((row) => row.seq) && forms.size === 1
    ? 'executionId'
    : rows.every((row) => row.time != null)
      ? 'time'
      : 'fileOrder';

  const sorted = [...rows].sort((a, b) => {
    if (basis === 'executionId') return a.seq.major - b.seq.major || a.seq.minor - b.seq.minor || a.index - b.index;
    if (basis === 'time') return a.time - b.time || a.index - b.index;
    return a.index - b.index;
  });

  const keyOf = (row) => (basis === 'executionId' ? `${row.seq.major}_${row.seq.minor}` : basis === 'time' ? String(row.time) : `i${row.index}`);

  // Tie resolution is per instrument: the books are independent, so the relative
  // order of two fills on different contracts cannot change any P&L.
  const byInstrument = new Map();
  for (const row of sorted) {
    const instrument = String(row.execution?.instrument || '').trim();
    if (!byInstrument.has(instrument)) byInstrument.set(instrument, []);
    byInstrument.get(instrument).push(row);
  }
  const resolved = new Map();
  for (const [instrument, group] of byInstrument) {
    resolved.set(instrument, resolveTiesByPosition(group.map((row) => row.execution), group.map(keyOf)));
  }

  // Reassemble in the global order, drawing each instrument's next fill from its
  // own resolved sequence.
  const cursors = new Map();
  const ordered = sorted.map((row) => {
    const instrument = String(row.execution?.instrument || '').trim();
    const index = cursors.get(instrument) || 0;
    cursors.set(instrument, index + 1);
    return resolved.get(instrument)[index];
  });

  return { ordered, basis };
}

function emptyResidual() {
  return { realized: 0, pairs: 0, reasons: {} };
}

function addResidual(residual, reason, pnl) {
  residual.pairs += 1;
  residual.reasons[reason] = (residual.reasons[reason] || 0) + 1;
  if (pnl != null) residual.realized += pnl;
  return residual;
}

/**
 * Normalise whatever the caller knows about the previous close.
 *
 * `null` / omitted is the honest answer for a caller with no history at all, and
 * it is NOT the same as "there was nothing open": it means nobody looked. Both
 * end in the same refusal, but only one of them is a bug if it ever shows up on
 * a caller that does hold the history.
 */
function normalizeCarryIn(carryIn) {
  if (!carryIn) return { available: false, reason: 'no-history', priorDate: null, lotsByInstrument: new Map() };
  const lotsByInstrument = new Map();
  for (const lot of carryIn.lots || []) {
    const key = String(lot?.instrument || '').trim();
    if (!lotsByInstrument.has(key)) lotsByInstrument.set(key, []);
    lotsByInstrument.get(key).push(lot);
  }
  return {
    available: Boolean(carryIn.available),
    reason: String(carryIn.reason || ''),
    priorDate: carryIn.priorDate ?? null,
    lotsByInstrument,
  };
}

/**
 * Decide, before any pricing, whether each book can be priced at all.
 *
 * Returns instrument -> { multiplier, refusal, seedLots, impliedStart,
 * namedStrategies }. Every decision here is made from the ORDERED fills; see the
 * warning on orderExecutions about reading row 1 of a descending grid.
 */
function planBooks(orderedByInstrument, { strategyOf, carryIn }) {
  const plans = new Map();
  for (const [instrument, fills] of orderedByInstrument) {
    const multiplier = multiplierFor(instrument);
    const first = fills[0];
    const statedFirst = parsePosition(first?.position);
    const startKnown = statedFirst != null;
    const impliedStart = startKnown ? statedFirst - signedQty(first) : null;
    // Two independent witnesses that this book held a position before the file
    // begins. Either alone is enough to refuse; the Position column is the one
    // that can also SIZE the carry-in, which is why a book that only trips the
    // E/X witness can never be seeded.
    const carriesIn = isExitFill(first) || (startKnown && impliedStart !== 0);

    const namedStrategies = new Set();
    for (const fill of fills) {
      const strategyName = strategyOf(fill?.orderId);
      if (strategyName) namedStrategies.add(strategyName);
    }

    // What the book held before the file starts, as an unpriced placeholder.
    // A refused book still gets it: the contracts demonstrably exist, so the
    // fills that close them must still pair against something and land in the
    // residual. Without it a refused carry-in would leave no trace in the
    // residual at all — the refusal would be silent, which is the one shape
    // this module is not allowed to produce.
    const phantom = () => (startKnown && impliedStart !== 0
      ? [{ side: impliedStart > 0 ? 1 : -1, qty: Math.abs(impliedStart), price: null, orderId: '', strategyName: '' }]
      : []);

    let refusal = null;
    let seedLots = [];
    if (multiplier == null) {
      refusal = BOOK_REFUSALS.UNKNOWN_INSTRUMENT;
      seedLots = phantom();
    } else if (carriesIn) {
      const lots = carryIn.available ? (carryIn.lotsByInstrument.get(instrument) || []) : [];
      const net = lots.reduce((total, lot) => total + lot.side * Math.abs(num(lot.qty)), 0);
      const priced = lots.length > 0 && lots.every((lot) => Number.isFinite(Number(lot.price)));
      // The carried lots have to explain the day's opening position exactly. A
      // client who skipped an upload leaves a hole this check falls into: the
      // lots we held are from a stale day and will not add up to what the fills
      // imply, so the book is refused instead of priced off a stale basis.
      if (startKnown && priced && Math.abs(net - impliedStart) < 1e-9) {
        seedLots = lots.map((lot) => ({
          side: lot.side,
          qty: Math.abs(num(lot.qty)),
          price: Number(lot.price),
          orderId: '',
          strategyName: String(lot.strategyName || ''),
        }));
      } else {
        refusal = BOOK_REFUSALS.CARRY_IN;
        seedLots = phantom();
      }
    }

    plans.set(instrument, {
      multiplier,
      refusal,
      seedLots,
      carriesIn,
      carriedInContracts: carriesIn && startKnown ? Math.abs(impliedStart) : 0,
      impliedStart: startKnown ? impliedStart : 0,
      namedStrategies,
    });
  }
  return plans;
}

/**
 * Per-strategy realized P&L for ONE account's trading day.
 *
 * @param {object[]} executions fills for a single account, as mapExecution shapes them
 * @param {object[]} orders     that account's orders (or the whole day's — joined by id)
 * @param {number|null} reportedGross the Accounts grid's 'Gross realized PnL' for this
 *        account, used only to gate the result. Pass null when the grid did not
 *        carry the column; the account is then REFUSED ('no-reported-gross')
 *        rather than compared against undefined or against the net column.
 * @param {object|null} carryIn what the caller knows about the previous close —
 *        `{ available, reason, priorDate, lots: [{ instrument, side, qty, price,
 *        strategyName }] }`, as carryForwardLots.js builds it. Omit it (or pass
 *        null) when the caller has no history; every carried-in book is then
 *        refused. Omitting it is a refusal, never a claim that nothing was open.
 *
 * Returns per-strategy rows plus everything a caller needs to decide whether it
 * may show them. `status` is the short answer:
 *   'no-trades'         the account did not trade
 *   'refused'           a book could not be priced at all — carry-in with no
 *                       basis, or an instrument with no multiplier. Nothing
 *                       about this account may be published.
 *   'no-reported-gross' the Accounts grid carried no 'Gross realized PnL', so
 *                       nothing could check the total. Also unpublishable.
 *   'exact'             every closed pair is attributed AND the total matches gross
 *   'partial'           the total matches gross but some pairs could not be attributed
 *   'unreconciled'      the derived total does not match gross — show nothing per-algo
 */
export function deriveStrategyPnl({
  executions = [],
  orders = [],
  reportedGross = null,
  carryIn = null,
  tolerance = DEFAULT_TOLERANCE,
} = {}) {
  const orderById = new Map();
  for (const order of orders || []) {
    const id = String(order?.id || '').trim();
    if (id) orderById.set(id, order);
  }
  const strategyOf = (orderId) => String(orderById.get(String(orderId || '').trim())?.strategyName || '').trim();
  const nameOf = (orderId) => String(orderById.get(String(orderId || '').trim())?.name || '').trim();

  const { ordered, basis } = orderExecutions(executions);
  if (!ordered.length) {
    return {
      byStrategy: [],
      residual: emptyResidual(),
      attributedTotal: 0,
      derivedTotal: 0,
      reportedGross,
      difference: reportedGross == null ? null : -num(reportedGross),
      pairs: 0,
      unpricedPairs: 0,
      detachedPairs: 0,
      openContracts: 0,
      carriedInContracts: 0,
      refusedBooks: [],
      unknownInstruments: [],
      carryInBasis: carryIn?.available ? 'prior-close' : (carryIn?.reason || 'no-history'),
      orderingBasis: basis,
      positionAgrees: true,
      reconciles: reportedGross == null ? false : Math.abs(num(reportedGross)) <= tolerance,
      status: 'no-trades',
    };
  }

  const normalizedCarryIn = normalizeCarryIn(carryIn);

  const orderedByInstrument = new Map();
  for (const execution of ordered) {
    const instrument = String(execution?.instrument || '').trim();
    if (!orderedByInstrument.has(instrument)) orderedByInstrument.set(instrument, []);
    orderedByInstrument.get(instrument).push(execution);
  }
  const plans = planBooks(orderedByInstrument, { strategyOf, carryIn: normalizedCarryIn });

  const books = new Map();          // instrument -> [{ side, qty, price, orderId, strategyName }]
  const runningPosition = new Map();
  const attributed = new Map();     // strategy name -> { realized, pairs }
  const residual = emptyResidual();
  const unknownInstruments = new Set();
  const refusedBooks = [];

  let pairs = 0;
  let unpricedPairs = 0;
  let detachedPairs = 0;
  let carriedInContracts = 0;
  let attributedTotal = 0;
  let derivedTotal = 0;
  let positionAgrees = true;

  for (const [instrument, plan] of plans) {
    if (plan.multiplier == null) unknownInstruments.add(instrumentRoot(instrument) || instrument);
    carriedInContracts += plan.carriedInContracts;
    if (plan.refusal) {
      refusedBooks.push({
        instrument,
        reason: plan.refusal,
        carriedInContracts: plan.carriedInContracts,
        // Only meaningful on a carry-in refusal: what the caller was able to say
        // about the previous close. 'no-history' is a caller that never looked.
        carryInReason: plan.refusal === BOOK_REFUSALS.CARRY_IN ? (normalizedCarryIn.available ? 'no-matching-lots' : normalizedCarryIn.reason) : '',
      });
    }
    books.set(instrument, plan.seedLots.map((lot) => ({ ...lot })));
    runningPosition.set(instrument, plan.seedLots.length
      ? plan.seedLots.reduce((total, lot) => total + lot.side * lot.qty, 0)
      : plan.impliedStart);
  }

  for (const execution of ordered) {
    const instrument = String(execution?.instrument || '').trim();
    const plan = plans.get(instrument);
    const multiplier = plan.multiplier;

    const side = /^buy/i.test(String(execution?.action || '')) ? 1 : -1;
    const filled = Math.abs(num(execution?.quantity));
    const price = num(execution?.price);
    const stated = parsePosition(execution?.position);

    const book = books.get(instrument);
    let remaining = filled;

    while (remaining > 0 && book.length && book[0].side !== side) {
      const lot = book[0];
      const take = Math.min(remaining, lot.qty);
      pairs += 1;

      if (plan.refusal) {
        // A refused book is counted and never valued. Not a zero: a zero would
        // be a claim, and this is the absence of one.
        unpricedPairs += 1;
        addResidual(residual, plan.refusal, null);
      } else {
        const openStrategy = lot.strategyName != null && lot.strategyName !== ''
          ? lot.strategyName
          : (lot.orderId ? strategyOf(lot.orderId) : '');
        const closeStrategy = strategyOf(execution?.orderId);
        const pnl = (price - lot.price) * take * multiplier * (lot.side === 1 ? 1 : -1);
        derivedTotal += pnl;

        const credit = (strategyName) => {
          const row = attributed.get(strategyName) || { realized: 0, pairs: 0 };
          row.realized += pnl;
          row.pairs += 1;
          attributed.set(strategyName, row);
          attributedTotal += pnl;
        };

        if (openStrategy && closeStrategy && openStrategy === closeStrategy) {
          credit(openStrategy);
        } else if (openStrategy && closeStrategy) {
          addResidual(residual, RESIDUAL_REASONS.CROSS_STRATEGY, pnl);
        } else if (openStrategy || closeStrategy) {
          // Rule 4b. One leg names a strategy and the other names nothing. A
          // blank-Strategy order that still carries a Name is NinjaTrader's own
          // order for that strategy, detached from it ("Stop Short", "PT1-Short",
          // "Enter Long", "Close"); a nameless one is hand-placed and stays
          // refused. The credit is only taken when this book has a single named
          // strategy, so there is no second candidate to choose between.
          const named = openStrategy || closeStrategy;
          const untagged = openStrategy ? execution?.orderId : lot.orderId;
          if (!nameOf(untagged)) {
            addResidual(residual, RESIDUAL_REASONS.MANUAL_LEG, pnl);
          } else if (plan.namedStrategies.size > 1) {
            addResidual(residual, RESIDUAL_REASONS.DETACHED_EXIT, pnl);
          } else {
            credit(named);
            detachedPairs += 1;
          }
        } else {
          addResidual(residual, RESIDUAL_REASONS.NO_STRATEGY, pnl);
        }
      }

      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-9) book.shift();
    }

    if (remaining > 0) book.push({ side, qty: remaining, price, orderId: execution?.orderId || '', strategyName: '' });

    const nextPosition = num(runningPosition.get(instrument)) + side * filled;
    runningPosition.set(instrument, nextPosition);
    if (stated != null && Math.abs(nextPosition - stated) > 1e-9) positionAgrees = false;
  }

  const openContracts = [...books.values()].reduce((total, book) => total + book.reduce((n, lot) => n + lot.qty, 0), 0);

  const byStrategy = [...attributed.entries()]
    .map(([strategyName, row]) => ({ strategyName, realized: Math.round(row.realized * 100) / 100, pairs: row.pairs }))
    .sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized) || a.strategyName.localeCompare(b.strategyName));

  residual.realized = Math.round(residual.realized * 100) / 100;
  attributedTotal = Math.round(attributedTotal * 100) / 100;
  derivedTotal = Math.round(derivedTotal * 100) / 100;

  const reconciles = reportedGross != null && Math.abs(derivedTotal - num(reportedGross)) <= tolerance;
  // No `!refusedBooks.length` clause here, on purpose. The status ladder below
  // answers 'refused' before it ever consults `complete`, so such a clause is
  // unreachable — a mutation that deleted it ("M12") changed no test and no
  // behaviour. The refusal is enforced in exactly one place; two places that
  // each half-enforce it is how one of them ends up quietly relaxed.
  const complete = reconciles
    && residual.pairs === 0
    && unpricedPairs === 0
    && !unknownInstruments.size
    && positionAgrees;

  // Order matters. A refused book is a fact about the fills and outranks a
  // missing column; both outrank any arithmetic verdict, because neither one
  // leaves an arithmetic verdict worth having.
  const status = refusedBooks.length
    ? 'refused'
    : reportedGross == null
      ? 'no-reported-gross'
      : complete
        ? 'exact'
        : reconciles
          ? 'partial'
          : 'unreconciled';

  return {
    byStrategy,
    residual,
    attributedTotal,
    derivedTotal,
    reportedGross,
    difference: reportedGross == null ? null : Math.round((derivedTotal - num(reportedGross)) * 100) / 100,
    pairs,
    unpricedPairs,
    // How many pairs rule 4b claimed. Reported so the cost of promoting it stays
    // measurable on every later export instead of disappearing into the total.
    detachedPairs,
    openContracts,
    carriedInContracts,
    // One entry per (instrument) book this account could not price, with why.
    refusedBooks,
    unknownInstruments: [...unknownInstruments].filter(Boolean).sort(),
    // What the caller was able to say about the previous close, carried through
    // so a refusal can name its cause rather than just its effect.
    carryInBasis: normalizedCarryIn.available ? 'prior-close' : (normalizedCarryIn.reason || 'no-history'),
    orderingBasis: basis,
    positionAgrees,
    reconciles,
    status,
  };
}

/**
 * Same derivation, run once per account over a whole day's grids.
 *
 * Keying is (account, strategy) throughout: the returned map is per account and
 * each account's strategies are derived only from that account's own fills. A
 * single flat map keyed on strategy name would smear one account's money across
 * every row sharing the name — measured at 13 of 47 rows on the real export.
 *
 * `carryInByAccount` is what the caller knows about each account's previous
 * close, keyed by account name. A caller with no history passes nothing and
 * every carried-in book is refused — which is the correct answer for a caller
 * that cannot see yesterday, and the wrong one for a caller that can. See
 * carryForwardLots.js.
 */
export function deriveStrategyPnlByAccount({
  executions = [],
  orders = [],
  accounts = [],
  carryInByAccount = null,
  tolerance = DEFAULT_TOLERANCE,
} = {}) {
  const grossByAccount = new Map();
  for (const account of accounts || []) {
    const name = String(account?.accountName || '').trim();
    if (!name) continue;
    const gross = account?.grossRealizedPnlReported;
    grossByAccount.set(name, gross === undefined ? null : gross);
  }

  const execsByAccount = new Map();
  for (const execution of executions || []) {
    const name = String(execution?.accountName || '').trim();
    if (!name) continue;
    if (!execsByAccount.has(name)) execsByAccount.set(name, []);
    execsByAccount.get(name).push(execution);
  }

  const ordersByAccount = new Map();
  for (const order of orders || []) {
    const name = String(order?.accountName || '').trim();
    if (!name) continue;
    if (!ordersByAccount.has(name)) ordersByAccount.set(name, []);
    ordersByAccount.get(name).push(order);
  }

  const carryInFor = (name) => {
    if (!carryInByAccount) return null;
    if (typeof carryInByAccount.get === 'function') return carryInByAccount.get(name) || null;
    return carryInByAccount[name] || null;
  };

  const result = new Map();
  for (const name of new Set([...grossByAccount.keys(), ...execsByAccount.keys()])) {
    result.set(name, deriveStrategyPnl({
      executions: execsByAccount.get(name) || [],
      orders: ordersByAccount.get(name) || [],
      reportedGross: grossByAccount.has(name) ? grossByAccount.get(name) : null,
      carryIn: carryInFor(name),
      tolerance,
    }));
  }
  return result;
}
