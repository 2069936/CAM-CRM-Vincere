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
// THE STATE OF THE EVIDENCE, IN ONE PLACE
//
// This header used to say that FIFO tie-breaking and rule 4b rested on two days
// of data and had never been settled. That is no longer true, and the section
// "WHAT THE 2026-08-20 BOOK SETTLED" below says what settled them, on how many
// observations, and what it cost to get the wrong answer three times first.
//
//   ordering basis + tie-break   SETTLED. 743 tie-bearing books; 727 admit
//                                exactly one ordering the Position column
//                                allows, 8 admit several and the split is
//                                identical on all 8. There is no freedom to get
//                                wrong. Rule 1, and rule 6 for what is left.
//   rule 4b (detached leg)       SETTLED. 1,051 pairs across 29 dates; every
//                                alternative disposition is worse, and one of
//                                them publishes wrong money. Rule 4b.
//   rule 4b's FENCE              STILL UNSETTLED. One discriminating row in 29
//                                dates. Unchanged, and still not evidence.
//   carry-in                     STILL UNSETTLED, still synthetic-only. Rule 5.
//   executionId ordering basis   UNTESTABLE against any redacted book. Rule 1.
//
// AND BEFORE YOU REPLAY ANYTHING AGAINST A REDACTED BOOK, READ RULE 0.
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
// WHAT THE 2026-08-20 BOOK SETTLED
//
// The two days above could not settle FIFO, the ordering basis or the
// tie-breaking, because every book on both was flat at both ends under a single
// strategy. A redacted export covering 2026-06-25 to 2026-08-19 finally could:
// 29 trading dates, 1,296 imports, 14,958 fills, 2,832 traded account-days,
// 3,818 (date x account x instrument) books, and 1,176 places where the
// Strategies grid reports a non-zero `Realized` this module can be checked
// against. Everything below is the per-strategy comparison against
// strategy_snapshots.realized. It is NOT the account-level reconciliation,
// which on that book is proxy-conditioned — see the note at the end.
//
// THE FIRST THING IT SETTLED WAS THAT THE FIRST THREE ANSWERS WERE WRONG. Three
// separate investigations replayed this module over that book, all three joined
// executions to orders on `external_order_id` because that is what the module
// does, and all three reported the same defect: 182 per-strategy figures wrong,
// $76,283.25, 54 of them on accounts this module certifies publishable, worth
// $22,899.25 of per-algo money reaching a CAM screen wrong.
//
// There is no such defect. The export's redactor did not have
// `external_order_id` on its identifier list, so the column fell through to a
// marker that keeps only a string's LENGTH: 30,955 distinct order ids became
// FOUR values. `strategyOf()` therefore returned one arbitrary name for every
// leg of an account-day, and the derivation emitted exactly one strategy row per
// account-day carrying the whole day's money — right whenever the day had one
// strategy, wrong whenever it had several. 161 of the 185 disagreements sit on
// multi-strategy account-days; 509 of the 511 "agreements" sit on
// single-strategy ones, where a collapsed lookup cannot be wrong. Those
// agreements were the 08-18 tautology, re-run 511 times.
//
// `reconcile` stamps the ORDER's Strategy onto every execution before
// persistence (`strategyName: orderStrategyById[execution.orderId]`), so
// `executions.strategy_name` IS what a sound join would return and it survived
// redaction. Rebuilding the leg lookup from it, with nothing in this module
// changed:
//
//   leg -> Strategy lookup                agree  disagree     |$|  wrong on 'exact'
//   through the collapsed order id          511       185  77,876.25  54 / $22,899.25
//   from the fill's own Strategy cell     1,052        11   2,814.25   0 /      $0.00
//   ...and day-scoped, as reconcile does  1,049         8   2,381.25   0 /      $0.00
//   ...and with rule 6 below              1,049         4   1,351.25   0 /      $0.00
//
// One convention throughout: every count above is over the same 1,176 grid rows,
// one comparison per stored (import, account, strategy) row, nothing deduplicated
// and nothing filtered. The rest is `no derived row` — a visible gap, never a
// figure. The 'exact' subset is the only one that reaches a screen.
//
// The redactor is fixed (scripts/lib/redactionJoins.mjs now refuses to write a
// book whose join keys were merged), and rule 0 below is the standing rule.
//
// FIFO TIE-BREAKING IS SETTLED, AND THERE WAS NEVER ANY FREEDOM IN IT. Fills
// share a timestamp constantly: of the 3,805 books that order by timestamp,
// 743 contain at least one same-second tie — 1,014 tie runs, 2,128 fills, run
// lengths 2 x 935, 3 x 63, 4 x 11, 5 x 5. Enumerating every permutation inside
// every tie run and keeping the orderings the Position column allows:
//
//   727 of 743 tie books admit EXACTLY ONE position-consistent ordering
//     8 admit more than one — and the per-strategy split is IDENTICAL on all
//       eight, so the tie-break is worth $0 on every book where it has a choice
//     7 admit NONE, which is rule 6 below
//     1 is too large to enumerate (this module's own 5,040 cap gives up too)
//
// Not one disagreeing row is rescued by any position-consistent ordering.
// Scored against the Position column across the tie books, the shipped rule
// reproduces it on 766 of 782; every alternative anyone proposed — file order,
// file order reversed, smaller quantity first, entries before exits, exits
// before entries, buys before sells — contradicts it on 691 to 773 of them.
// The three that cut the wrong-count do it by DECLINING 25-35 more rows and
// getting 25 fewer right, which is a loss, not a fix. There is no tie-break
// change that can move any of this book's disagreements: the measured value of
// any further tie-break work is $0.
//
// RULE 4b IS SETTLED, AND IT IS THE BEST DISPOSITION BY A WIDE MARGIN. On the
// sound join it credits 1,051 pairs across 29 dates and reaches 229 of the 1,176
// comparisons. Every alternative, same module, same ordering, same everything
// else:
//
//   disposition of 4b       agree  disagree     |$|  publishable   published wrong
//   shipped                 1,049         4  1,351.25         613   0 /    $0.00
//   refuse the pair           906        70 21,411.25         427   0 /    $0.00
//   drop the fence          1,050         3  1,336.25         613   0 /    $0.00
//   drop the Name guard     1,015        39 13,144.75         665   5 /  $997.00
//
// Refusing costs 143 agreements and 186 publishable account-days. Dropping the
// Name guard — crediting the NAMELESS blank-Strategy legs rule 4 refuses — is
// the only disposition in the whole book that puts wrong money on a screen, and
// it is pinned by "will not credit a NAMELESS blank-Strategy leg, whatever else
// is on the book". The 08-19 promotion of 4b was correct and now rests on 1,051
// pairs rather than five.
//
// WHAT THE BOOK DID NOT SETTLE, AND WHAT WAS LEFT ALONE BECAUSE OF IT.
//
//   4b's FENCE. "At most one named strategy on the book" is reached on 10 of
//   3,818 books over 29 dates, fires on TWO pairs, and moves exactly ONE
//   comparison row — dropping it scores 1,050 against 1,049. One observation is the
//   same standard of evidence the 08-18 header declined to promote 4b on, and
//   it is declined again here. The fence stays. It is not settled; it simply has
//   almost nothing to settle it against.
//
//   CARRY-IN. 52 pairs refused as `carry-in-refused` across the whole book, on
//   29 books that carried a contract in, none of them reaching a checkable row.
//   Still synthetic-only, still a refusal.
//
//   FIFO ITSELF. 3,756 of the 3,818 books are flat at both ends AND worked by at
//   most one named strategy, which makes their split pairing-independent — the
//   same tautology as 08-18, 3,756 times. Only 62 books can discriminate a
//   pairing rule at all: 46 end open, 29 carry in, 10 carry more than one named
//   strategy. The whole residual over the book, for scale: no-strategy 652,
//   manual-leg 307, carry-in-refused 52, position-unreproducible 49,
//   unknown-instrument 13, cross-strategy 4, detached-exit 2.
//
//   THE executionId ORDERING BASIS. Redaction tokenises execution ids into a
//   shape `execSequence` cannot read, so the basis falls to `time` on 2,819 of
//   2,832 account-days and to `fileOrder` on 13. NO redacted book can test rule
//   1's preferred basis. Every ordering statement above is about the time basis
//   plus the Position-column repair. Say which one you measured.
//
//   THE ACCOUNT-LEVEL RECONCILIATION. `account_snapshots.gross_realized_pnl`
//   stores the NET figure, so replaying rule 2 against it fails roughly 1,955
//   account-days by a commission-shaped amount that is an artefact of the stored
//   column and not of the pairing. Every number in this section is the
//   per-strategy comparison against strategy_snapshots.realized, which is
//   unaffected. Keep the two apart and say which one a figure comes from.
//
// THE SIX RULES, each measured, each a place an earlier attempt went wrong.
//
// 0. A RULE ABOUT MEASURING THIS MODULE, NOT ABOUT RUNNING IT. NEVER RESOLVE A
//    LEG'S STRATEGY THROUGH A REDACTED BOOK'S ORDER IDS. Redaction may rename an
//    id; if it ever merges two, this module's first step silently resolves every
//    leg of an account-day to one arbitrary order and the whole day lands on one
//    strategy. It looks exactly like an attribution defect, it is worth $76,283
//    of phantom disagreement on the 2026-08-20 book, and it cost three
//    investigations before anyone counted the distinct ids. A replay of a stored
//    book must build the leg lookup from `executions.strategy_name` /
//    `executions.name`, which reconcile writes from the order and which is the
//    same value a sound join returns. If a replay must use the ids, count them
//    first: `new Set(orders.map(o => o.external_order_id)).size` against
//    `orders.length`. scripts/lib/redactionJoins.mjs now refuses to WRITE such a
//    book, but books written before that fix still exist.
//
// 1. ORDER BY EXECUTION ID, not by file order and not by Time. The grid exports
//    in whatever order the operator had it sorted — measured across ten client
//    folders: six time-descending, three grouped by the E/X column, zero
//    ascending. Time has same-second ties. The execution id is "<seq>_<n>" and
//    is monotonic; under it the Position column is reproducible from
//    Action+Quantity on 100% of fills, which is the check `positionAgrees`
//    performs on every leg.
//
//    THE POSITION COLUMN IS THE ARBITER, AND THE 2026-08-20 BOOK PROVED IT IS
//    ALSO SUFFICIENT. Decoded (-/N L/N S) against the Buy/Sell sign it predicts
//    the E/X column on 14,884 of 14,897 readable fills, and on the time basis it
//    pins 727 of 743 tie-bearing books to a single ordering with no freedom left
//    over. Two things follow for anyone tempted to re-open this. Sorting
//    `time_text` as a STRING puts "10:00 AM" before "9:35 AM"; and that column
//    carries two formats in one grid ("9:35 AM" and "7/13/2026 4:30:52 PM"), so
//    a regex anchored on the first rejects 14,932 of 14,958 rows in silence.
//    `parseExecutionTime` handles both. Whatever ordering you adopt, it has to
//    reproduce the Position column; where it does not, the ordering is wrong and
//    the data is not — and rule 6 now refuses the book rather than guessing.
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
//    worked by two named strategies the pair stays refused as `detached-exit`:
//    FIFO would pick an owner and nothing would check it. And it never fires on
//    a nameless order, which is rule 4's case.
//
//    BOTH HALVES ARE NOW MEASURED, AND THEY ARE NOT MEASURED EQUALLY WELL.
//
//    The NAME GUARD is settled and load-bearing. Dropping it credits the 4b way
//    to every nameless blank-Strategy leg and is the ONLY change tested against
//    the 2026-08-20 book that puts wrong money on a screen: 1,015 agreements
//    against 1,049, 39 disagreements against 4, and five rows totalling $997.00
//    published on accounts this module still certifies 'exact'. That is the
//    level-3 outcome — crediting a strategy the evidence does not name — and it
//    is pinned by name in the tests.
//
//    The FENCE is not settled and has not been changed. Over 29 trading dates it
//    is reached on 10 of 3,818 books, fires on TWO pairs, and moves exactly ONE
//    comparison row; removing it scores 1,050 agreements against 1,049. One is what
//    the 08-18 header refused to promote 4b itself on, so it is refused here
//    too. If a later book produces a real population of two-named-strategy books
//    carrying a detached leg, measure it then — the pairs are all tagged
//    `detached-exit` in the residual, exactly so that day needs no re-measuring
//    from scratch.
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
//
// 6. A BOOK WHOSE ORDERING DOES NOT REPRODUCE THE POSITION COLUMN IS REFUSED,
//    for the same reason and by the same mechanism as rule 5.
//
//    `resolveTiesByPosition` permutes within each same-timestamp run and keeps
//    the ordering with the fewest Position-column mismatches. On the 2026-08-20
//    book that succeeds outright on 727 of the 743 tie books and is worth $0 on the
//    8 where it has a choice. But it returns its BEST candidate even when the
//    best candidate still contradicts the column — and there the fills are out
//    of sequence across DISTINCT timestamps, not merely tied, so no tie-break
//    can repair them. The clock and the Position column disagree, and the clock
//    is the one this module sorted on.
//
//    That state used to be silent. The book was paired anyway, every pair was
//    priced and credited to a strategy, and the only thing between those figures
//    and a screen was the account-wide `positionAgrees` boolean — which says
//    that SOMETHING on the account is unreadable and never which book or how
//    much money. A boolean is not a refusal: it cannot be counted, it cannot be
//    named in a residual, and one relaxation of the `complete` ladder would have
//    published it.
//
//    Now the book is refused whole, its pairs are counted and never valued, and
//    `position-unreproducible` names them in the residual. Measured on the
//    2026-08-20 book, sound join, day-scoped: 9 books across 6 account-days, 49
//    pairs. It moves NO account off the screen that was ever on it — 'exact'
//    already required `positionAgrees` — and after it, zero non-refused
//    account-days are left contradicting the column, where 19 of 2,832 did
//    before. Four disagreeing comparison rows become named refusals: the
//    residual goes from 8 rows / $2,381.25 to 4 rows / $1,351.25 with all 1,049
//    agreements kept. That is the whole trade: refusals bought with wrong rows,
//    never with right ones.
//
//    ORDER MATTERS INSIDE THE REFUSAL LADDER, TWICE. An unknown instrument is
//    decided FIRST — a grid that exported no Position column at all reads as
//    flat after every fill and so contradicts the pairing, and all 13 books in
//    that state on this book are also missing their instrument, where the
//    existing name is the better one. Carry-in is decided AFTER, because both of
//    its witnesses are read off the very ordering rule 6 has just rejected.

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
  // The ordered fills do not reproduce the Position column, so the sequence the
  // pairing would run on is one the file itself contradicts. See rule 6.
  POSITION_UNREPRODUCIBLE: 'position-unreproducible',
};

// Why a whole book was refused. Same strings as the residual reasons that carry
// them, so a reader does not have to hold two vocabularies.
export const BOOK_REFUSALS = {
  CARRY_IN: RESIDUAL_REASONS.CARRY_IN,
  UNKNOWN_INSTRUMENT: RESIDUAL_REASONS.UNKNOWN_INSTRUMENT,
  POSITION_UNREPRODUCIBLE: RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE,
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
 * number, which is the exact failure this module exists to prevent.
 *
 * HOW MUCH WORK THIS ACTUALLY DOES, MEASURED. On the 2026-08-20 book 743 of
 * 3,805 timestamp-ordered books contain a same-second tie (1,014 runs, 2,128
 * fills; runs of 2 x 935, 3 x 63, 4 x 11, 5 x 5), and the column pins 727 to
 * exactly ONE admissible ordering. Eight admit several, and on all eight the
 * per-strategy split is identical — so where this function has a choice, the
 * choice is worth $0. Ties are two rows long in practice; the search is capped
 * so a pathological grid degrades to "leave it alone" rather than hanging (one
 * book on that export exceeds the cap).
 *
 * IT RETURNS ITS BEST CANDIDATE, WHICH IS NOT ALWAYS A GOOD ONE, AND THAT IS
 * DELIBERATE. When no permutation inside the tie runs reproduces the column, the
 * fills are out of sequence across DISTINCT timestamps and no tie-break can
 * repair them. This function does not decide what to do about that; it hands
 * back the least-bad ordering and rule 6 in planBooks REFUSES the book by name.
 * Silently keeping the least-bad ordering and pairing on it is what happened
 * before, and it left the money unnamed and unpriceable-but-priced.
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
    } else if (positionMismatches(fills) > 0) {
      // RULE 6. The ordering does not reproduce the Position column, so the
      // sequence every pair below would be built from is one the file itself
      // contradicts. Refuse the book by name rather than pair it anyway.
      //
      // ORDER MATTERS HERE, TWICE OVER. An unknown instrument is checked FIRST
      // because it is a fact about the multiplier table and nothing to do with
      // sequence: on the 2026-08-20 book, 13 books whose grid exported no
      // Position column at all are also missing their instrument, and calling
      // those "position-unreproducible" would rename a refusal that already has
      // the right name. Carry-in is checked AFTER, because both of its
      // witnesses — the first fill's E/X and the position it implies — are read
      // off the very ordering this test has just rejected. An unreadable
      // sequence cannot be asked whether it carried a contract in.
      refusal = BOOK_REFUSALS.POSITION_UNREPRODUCIBLE;
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
 *                       basis, an instrument with no multiplier, or an ordering
 *                       the Position column contradicts. Nothing about this
 *                       account may be published.
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
