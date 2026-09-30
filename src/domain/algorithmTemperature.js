// ONE ROW PER ALGORITHM, ORDERED BY WHAT IT IS DOING RIGHT NOW, AND A CURVE
// UNDER IT THAT NOBODY CAN ADD UP TWICE.
//
// The Stack Playbook's team table measures COMBINATIONS: `G4M + OGX + URGO` is
// one row, and every other stack the desk ran is another. The arithmetic is
// right and the subject is wrong. The CAM's words: "lo separa por esas
// combinaciones raras, eso no funciona asi". A row named by three algorithms
// cannot answer "is OGX hot", and because the stack churns from close to close,
// one algorithm's money is spread across a dozen combo rows that each pass or
// fail the sample gate on their own. This file answers the other question: what
// is each real algorithm doing, hottest first, and what did its own cumulative
// contribution do while it did it.
//
// WHY THE COMBO TABLE GETS ITS PARTITION FOR FREE AND THIS ONE DOES NOT. That
// table credits the WHOLE, UNDIVIDED account day to one combo row
// (`comboPerformance.js`: `row.totalPnl += pnl`). Nothing is split, so nothing
// can be counted twice. The moment the subject becomes ONE algorithm on a day
// that three of them traded, an account day has to be DIVIDED, and that division
// is the only genuinely new arithmetic in this file. Everything else here is
// imported: the window, the funded population, the alive range, the sample gate,
// the identity rule, and the rule about which algorithms ran at all.
//
// THE ATTRIBUTION, AND IT IS A PARTITION OR IT IS NOTHING.
//
// Per funded account day, in this order:
//
//   1. SOLE. Exactly one algorithm ran. It is credited the whole account day.
//      Exact, and no assumption: the one part of a one-part partition is the
//      whole. This case is tested FIRST, before the measured one, because on a
//      solo day the account's own figure and the strategy row's figure are not
//      the same number, and the measurement that says so is taken on THIS FILE'S
//      OWN rule for which algorithms ran, not borrowed: of the 350 SOLE account
//      days on the stored book, 184 carry no figure at all on the one
//      algorithm's rows, so crediting the row would credit nothing whatever on
//      those. 166 do carry one, and it equals the account day on 110; on the
//      other 56, crediting the row rather than the account day would have moved
//      $6,470.28 and lost $3,914.68 of it net.
//      `docs/stack-playbook-spec.md` §2.6 (line 156, restated in §3 at line 191)
//      measures the same shape over a DIFFERENT population, 166 solo days by
//      the export-time `enabled` flag, account gross equal to the strategy's
//      realized on 108, and the two 166s are a coincidence of this book, not
//      one figure quoted twice. Neither is in §5, which is the test list.
//   2. MEASURED. Several algorithms ran, EVERY one of them carries its own
//      figure, and those figures reconcile with the account day inside
//      `RECONCILE_TOLERANCE`. Each is credited its own figure. A true partition,
//      published with the residual it leaves.
//   3. UNSPLIT. Anything else: several ran and a figure is missing, or every
//      figure is $0, or the figures do not add up to the day. NOTHING IS
//      CREDITED. The day is counted in the `unsplit` bucket with its money, its
//      date and WHICH of those three refusals applied, and the panel is expected
//      to print all of it. The three are not interchangeable: see below.
//
// WHY AN EQUAL SPLIT IS REFUSED, AND IT IS TWO DIFFERENT SINS. Crediting each of
// three algorithms the whole +$300 day makes the parts sum to $900, and every
// fall measured on the sum is inflated nonsense. Dividing the +$300 into three
// $100s sums correctly and invents which algorithm made what: on a day where one
// algorithm made +$500 while another lost -$200, an even split reports +$150
// each, and the row's own curve, its deepest dip and its temperature are then
// fiction with a dollar sign on them. `algorithmRanking.js` already removed that
// fallback, "which its own comment called a fabrication". A missing contribution
// is recoverable. A made-up one looks like an answer.
//
// WHAT UNSPLIT COSTS ON THIS BOOK, BECAUSE IT IS NOT A FOOTNOTE. Over the whole
// stored book (2026-07-13 to 2026-07-30), funded accounts, family level, traded
// basis: 896 funded account days resolve as 350 SOLE, 35 MEASURED and 214
// UNSPLIT, with 297 more carrying no attributable algorithm at all. The 214
// unsplit days hold -$53,417.10. The largest single row on that book carries
// -$16,547, so MORE MONEY SITS OUT OF THIS PANEL THAN ANY ROW ON IT CARRIES, and a
// screen that does not say so is telling the reader the desk lost less than it
// did.
//
// SO THE SHARE, WHICH IS THE FIGURE THAT DECIDES WHETHER THE PANEL IS WORTH
// SHOWING. The curve rests on 385 of 896 funded account days, 43.0%, and on
// -$70,574.75 of -$132,506.55, 53.3%. The unsplit bucket is 23.9% of the days
// and 40.3% of the money; the unknown bucket, where nothing names an algorithm
// at all, is another 33.1% of the days but only 6.4% of the money. Per close the
// attributable share of the desk's funded P&L ranges from -4.2% (2026-07-14) to
// 129.9% (2026-07-21, where the attributable accounts were up $1,409.30 while the
// rest of the desk gave back $324.50), which is why `population` publishes the
// counts and the dollars per bucket and the caption has to print them.
//
// BOTH ENDS OF THAT RANGE ARE SIGN INVERSIONS AND THE FLOOR IS THE WORSE ONE.
// This sentence used to read "from 27.7% (2026-07-20)", which is not the
// minimum: it is merely the smallest share that happens to be positive, and
// naming it as the floor hid the end that a reader needs. On 2026-07-14 the
// desk's funded accounts lost $2,059.00 while the accounts this panel can
// attribute MADE $87.00, so the share is -4.2% and the panel's rows point the
// opposite way to the book they are a part of. A share outside [0%, 100%] is
// not a defect in the partition, which reconciles to the cent; it is what a
// SHARE does when the numerator and the denominator have different signs, and a
// CAM who reads a green panel on a red day has to be able to find that out.
// Mirrored by algorithmTemperature.book.test.js so it cannot rot: this was the
// one figure in this header with no assertion behind it, and it was wrong.
//
// AND THE PARTITION EVERYONE ARGUED ABOUT DECIDES 3.9% OF THE BOOK. 350 of the
// 385 credited days are SOLE, where crediting is exact and no division happens;
// 35 are MEASURED, the only days where an account day is actually divided between
// algorithms, and they hold -$8,637.00, 12.2% of the credited money. The rule is
// still the right rule, and the honest statement of its reach is that it moves
// one day in twenty five.
//
// AND THEY SAT OUT FOR THREE DIFFERENT REASONS, WHICH IS WHY `unsplit.reasons`
// PUBLISHES THE SPLIT INSTEAD OF THIS COMMENT ASSERTING A CAUSE. This paragraph
// used to say that the 115 checked-and-refused days were "not missing figures
// either: every algorithm that ran carried one and they still did not add up".
// That is true of 43 of the 115. The 214 divide, on this book, as:
//
//   * 99 days holding -$32,040.50 where an algorithm that ran carries no figure
//     at all, so there was never anything to check (`missingFigure`);
//   * 72 days holding -$13,041.00 where every figure was exactly $0, which
//     `reconcilesOn` refuses as an unreported day rather than as agreement
//     (`unreported`), and on 28 of those 72 the account was flat as well, so
//     0 + 0 does reconcile with the account day to the cent and the day is
//     refused anyway, because nothing measured it. `reasons.unreported.flatDays`
//     is that 28, published rather than left for a reader to assume;
//   * 43 days holding -$8,335.60 where every figure is present and non-zero and
//     the sum misses the account day: by $2 at the least, $8 at the median and
//     $328 at the worst (`mismatched`).
//
// The first two are missing measurements and only the third is a disagreement.
// The sentence a CAM uses to explain -$53,417.10 sitting out of a client-facing
// panel has to name the one that applies, so each reason carries its own count,
// its own dollars and its own sentence, and `reconciliation` publishes the
// tolerance, the 150 days it checked, the 35 it accepted and the 115 it refused
// rather than a single percentage.
//
// THE IDENTITY RULE REACHES THIS FILE THROUGH ONE DOOR AND IS LIVE ON THIS DATA.
// `dayAlgoRows` is the only thing here that decides what an algorithm is called,
// and it resolves through `strategyRan.js` like everything else. It is not a
// theoretical concern: the 14 rows the stored book produces include IFSP and
// IFSP_PF as two separate algorithms, and OGX and OGX_PF as two more. The rule
// this file would have broken by keying rows off `strategyFamily || strategyName`,
// which two screens in this codebase still do, is the rule that keeps them apart.
//
// WHAT IT REFUSES TO PRODUCE.
//
//   * No "best" row, and no suggestion. Rows are ordered by heat, and heat is a
//     three date sum: an algorithm that ran twice can top the table on one good
//     afternoon. `lowSample` is published on every row so the screen can flag it,
//     and nothing here is crowned. `comboPerformance.js` sorts its gated rows
//     above its low sample ones precisely because it DOES crown one.
//   * No money on a row for the days it could not partition. A row carries
//     `attribution.unsplitDays`, a count, and no dollars: three algorithms on one
//     unsplit day would each carry the same money, and a reader adding the column
//     up would get three times what actually sat out. The money that sat out is
//     named once, in `unsplit`.
//   * No temperature and no dip on a row that was credited nothing. A row every
//     one of whose account days went to UNSPLIT publishes `unmeasured: true`,
//     `temperature: 'Unmeasured'` and `deepestDip: null`. It used to publish
//     'Stable' and $0.00, which are not gaps but two positive false claims: the
//     Hot/Cold/Stable badge is the instrument the CAM already trusts from the
//     client screen, and "Deepest dip inside this window: $0.00" against an
//     algorithm that ran on five days the desk lost $5,000 reads as a finding.
//     `lowSample` does not cover it; that flag means thin, not unmeasured.
//   * No percentage of anything for a dip. Every fall in this repository is in
//     dollars and the only percentages near the word divide by a prop firm's
//     limit, which is a different quantity entirely.
//   * No split fabricated from the fills. This module reads
//     `derivedRealized ?? realized` through `measuredOnAccountDay` and derives
//     nothing.
//
// "DRAWDOWN" IS ALREADY TAKEN IN THIS PRODUCT, SO NO FIELD HERE IS CALLED ONE.
// Everywhere else on these screens it is how close a prop account is to being
// killed by its firm: `trailingMaxDrawdown` read as cumulative loss on the 14
// accounts that carry a configured limit and as remaining buffer on the other
// 750 (`accountLifecycle.js`), against `max_drawdown_limit`, printed under the
// column header "Drawdown" in `Dashboard.jsx` and reasoned about as breach risk
// in `AccountLifecyclePanel.jsx`. The fields below measure a different thing: the
// deepest dip of ONE ALGORITHM'S OWN cumulative contribution, inside the window,
// with the curve reset to zero at the window's open.
//
// So the FIELD NAMES carry the distinction, not just this paragraph:
// `deepestDip`, `deepestDipFrom`, `deepestDipTo`, `sumOfPartDips`, and `dip` on
// every point of `equity`. A screen is wired to field names months before anyone
// reads a header, and a field called `maxDrawdown` here would be read as the
// prop firm's limit by a developer who never opens this file, so a test walks
// every key of the published result and the composite and fails if the other
// word appears in any of them. Never print any of these in the same row as a
// `trailingMaxDrawdown` figure.
//
// AND THE WORDING IS THE ONE THIS PRODUCT ALREADY RENDERS, NOT A THIRD ONE.
// `DEEPEST_DIP_LABEL` is "Deepest dip inside this window" and it is published on
// the result and on the composite as `dipLabel`, so the screen reads it beside
// the figure instead of inventing one. `PerformanceCharts.jsx:179` already
// prints "Deepest dip" over `summarizePerformance`'s `maxDrawdown`
// (`performanceSeries.js:103`), and that is this same measurement on a different
// curve: peak to trough on cumulative P&L, peak seeded at zero, signed negative.
// An earlier version of this header claimed `algorithmBenchmark.js` "already owns
// the safe wording"; it does not. Its comment at :401 asserts the quantity is
// "stated as 'deepest fall inside this window' everywhere it is printed", and
// that phrase is printed nowhere in this product: the citation reached another
// comment, so the label it justified was a third wording for one quantity.
//
// TWO DECISIONS ABOUT THAT DIP, BOTH OF WHICH HAVE A WRONG ANSWER IN THIS REPO.
//
//   * SIGN. Negative or zero, `cum - peak`, which is `performanceSeries.js`'s
//     convention and the one behind the rendered "Deepest dip".
//     `algorithmBenchmark.js` returns the same quantity as a positive magnitude.
//     Two conventions for one concept is how the 4.44% this file measures over
//     the stored book's ten gated rows silently inverts, so this one is stated
//     here, published on every point of `equity` as `dip`, and pinned in the
//     tests. That 4.44% is measured by `algorithmTemperature.book.test.js` on
//     public/local-snapshot.json and is the only reduction figure this checkout
//     can reproduce: an earlier version of this line, and the commit that
//     shipped the panel, both quoted a 51% measured by a cruder production query
//     that did not check the per algorithm figures against the account day.
//   * WHERE THE PEAK STARTS. At 0, because 0 is this curve's own first point:
//     the window opens with the algorithm having contributed nothing, and the
//     first day's loss is a real fall from where the window began.
//     `derivedAccountMetrics.js` seeds its peak from the series' own start
//     rather than from zero, and it is right to, because it measures a BALANCE,
//     where zero is not a level anybody was ever at. Same rule, different curve.
//     The consequence is deliberate: on a curve that only ever falls, and this
//     book is full of them, the deepest dip equals the total loss.
//
//     AND THE PRICE OF THAT CHOICE, STATED PLAINLY, BECAUSE THE TWO READINGS
//     CANNOT BOTH HOLD. A lone trading date on which the algorithm LOST reads as
//     a fall of that loss here, not as a fall of 0. The alternative, seeding the
//     peak from the first point's own value, gives 0 on a single date and it also
//     gives -$200 on a three day slide that lost $300, which is the reading that
//     tells a CAM an algorithm losing every day it ran never fell. One date is
//     not a special case in this file; it is the same rule with one point in it. A
//     lone WINNING date does read 0, and so does any curve that never gets below
//     where the window opened.
//
// TEMPERATURE IS THE INSTRUMENT THE CLIENT SCREEN ALREADY USES, WITH ITS UNIT
// FIXED. `buildClientOverview` in App.jsx sums the last three contributions and
// calls the result Hot above +250, Cold below -250, Stable between. Its "last
// three" is the last three (snapshot, strategy) PAIRS it walked, so for a client
// running one family on four accounts it spans four accounts inside one close and
// not three closes at all. Here the unit is the last three TRADING DATES the
// algorithm was credited on, across every client the CALLER hands this module,
// and `heatDates` publishes exactly which three so the screen can say it out
// loud.
//
// "ACROSS EVERY CLIENT THE CALLER HANDS THIS MODULE" IS NOT "DESK WIDE", and
// this sentence used to say desk wide. It is wrong for most logins and it is
// the sentence a developer reads before wiring a second caller. The Stack
// Playbook passes `state.clients`, which is scoped by `camScopeFor(session)` in
// the browser and by row level security in the database, so for a CAM these
// rows are that CAM's assigned clients and nothing else: step 52 measured one
// at 36 clients of 212. The module cannot detect this and must not guess at it,
// which is why `scopeNote` is the CALLER's to pass and StackPlaybook.jsx prints
// "Your book · N clients" over both headings. Read heat as hot across what was
// handed in, never as hot across the desk.
//
// ORDERING IS SIGNED AND IT IS NOT NEGOTIABLE. `heat` descending, ties by key.
// Sorting by magnitude was a live bug on the client screen until the commit
// under this one: it listed OGX at -$405 Cold above G4M at +$360 Hot, because
// 405 is more than 360. Hottest means warmest, not loudest. The one thing ahead
// of heat in the comparator is `unmeasured`: a row credited on no day at all has
// no heat to be warm or cold with, and leaving it at 0 files it among the rows
// whose three dates happened to sum to nothing, which is a reading. It sorts
// below every measured row instead.
//
// AND WHAT "RIGHT NOW" CANNOT MEAN, WHICH THIS BOOK DEMONSTRATES AT RANK 1. Heat
// is the last three dates the algorithm was CREDITED on, not the last three
// closes of the window, so on a sparse row it can be arbitrarily stale and the
// row still sorts by it. On the stored book the panel's first row is ARPD_PF,
// +$430 Hot, and it is the only row of 14 with positive heat: it was credited on
// exactly ONE account day, 2026-07-13, seventeen days before the window ends, as
// one of four algorithms on a +$265 close. So the top of a table the CAM reads as
// "hottest right now" is a single stale account day, and the two fields that say
// so, `heatDates` and `lowSample`, are both published and both have to be
// PRINTED. Sorting by recency instead would answer a different question and bury
// an algorithm that is up on its last three dates because it did not run
// yesterday; the fix is disclosure, not a different comparator.
//
// THE RECONCILIATION BASIS, AND THE ONE IT CANNOT HAVE. `reconcilesOn` checks
// the algorithms' figures against `snapshot.grossRealizedPnl` at one dollar.
// That column's name lies: it holds the commission-netted 'Realized PnL' on most
// traded accounts (csvImport.js), which is why the tolerance is a flat dollar and
// not a cent per row. The stricter check `algoContribution.js` runs on a DERIVED
// split needs `snapshot.derivation.reportedGross`, the raw gross column, and that
// arrives only with the OPENED close's detail (`CLOSE_DETAIL_COLUMNS`). A desk
// wide panel does not have it on 500 closes, so it cannot be used here: a day
// whose figures are derived is checked on the netted basis like every other day,
// and a day that fails goes to UNSPLIT rather than being accepted on a basis
// nobody checked. `reconciliation` publishes the tolerance, how many days were
// checked, how many reconciled, how many it refused, and the dollars the accepted
// ones left over.
//
// WHAT THE REDUCTION LOOKS LIKE HERE, SO NOBODY QUOTES A BORROWED ONE. EVERY
// FIGURE IN THIS PARAGRAPH IS MEASURED ON public/local-snapshot.json BY
// `algorithmTemperature.book.test.js`, which re-measures each one on every run
// that holds the book, and none of them is carried in from anywhere else.
// Selecting the ten rows that pass the sample gate on the stored book, the
// composite's deepest dip is -$66,855.34 against -$69,962.04 for the sum of the
// parts: a reduction of 4.44%. It is small on this book because 6 of those 10
// parts never get back above where they opened, a 7th comes within $31 of it,
// and neither does the composite, so the parts have almost nothing to offset. On
// a plausible three algorithm selection it is smaller still and reads as
// nothing: the three rows with the most MEASURED days (IFSP, IFSP_PF, URGO) give
// -$28,745.66 against -$28,776.66, a reduction of 0.11%, and the three with the
// most credited days (URGO, B2X, G4M) give 0.08%. The largest three algorithm
// figure anywhere on this book is 20.69%, on ARPD_PF, OGX_PF and ARPD.
//
// WHICH IS NOT WHAT THE COMMIT THAT SHIPPED THIS PANEL SAID, AND THE COMMIT WAS
// AMENDED RATHER THAN LEFT TO BE QUOTED. It read "measured on production over
// the last 120 days, the combined curve's deepest dip came out 51% below the sum
// of the parts' dips on prop, 20% on cash and 8% on Bullet Bot". Nothing in that
// sentence can be reproduced here and the sentence is no longer in the log: the
// window is 18 calendar days and 14 trading dates rather than 120; there is no
// prop/cash split in this module; Bullet Bot holds 2 credited account days on
// this book; and those figures came from a query that compared 15 to 19
// algorithms at once WITHOUT checking each one's figure against the account day,
// which is the check that sends 214 days of this book to UNSPLIT. A number
// measured without the partition is not this module's number.
//
// AND IT IS NOT STABLE UNDER SELECTION, IN A WAY THIS BOOK MEASURES RATHER THAN
// ASSUMES. Adding an algorithm adds the whole of its own dip to the denominator
// while the composite absorbs only whatever part of it lands on the composite's
// own worst stretch, so the figure is a property of the selection and not of the
// algorithms. What that does NOT license is a direction: an earlier version of
// this paragraph said "the figure drifts upward as the selection grows", and
// walking the 14 rows of this book one at a time, from the two row selection
// that is the first one comparable at all, it falls at 6 of the 12 steps (0.11%
// to 0.08% adding RBO, 2.46% to 1.88% adding B2X, 4.57% to 3.91% adding G4M,
// 5.42% to 5.06% adding ARPD, then again adding Bullet Bot and DJDR), while
// ending at 5.52% against the 0.00% it starts from. The denominator is the
// only half with a direction: it is a sum of non positive dips, so its magnitude
// never shrinks, and it does not always grow either, because a real row can have
// a dip of exactly 0 and this book has one (ARPD_PF, whose one credited day was
// a winning day). Adding THAT row moved the reduction up by lifting the
// composite's own curve, not by moving the denominator at all. `REDUCTION_CAVEAT`
// discloses the half that holds.
//
// AND MOST SELECTIONS HAVE NO COMPARISON IN THEM AT ALL, WHICH IS A REFUSAL AND
// NEVER A PERCENTAGE. `reduction` used to be guarded on the DENOMINATOR, null
// only when the sum of the parts' dips was 0, and that is not the case that
// breaks. The case that breaks is the composite never falling: 1 - (0 / a
// negative) is 1, printed "100.00% lower". On this book that is two clicks from
// a cold open. The panel's default view sorts ARPD_PF first and DJDR second,
// both credited on one account day each, 2026-07-13, and selecting the top two
// rows rendered "Combined $0 against -$26 for the sum of the parts, 100.00%
// lower" off a $25.50 denominator, while seven lines away in the same component
// the other branch printed "That is not a reduction of 100%, it is no
// comparison". Three more cases are the same refusal wearing a number: a
// selection of ONE algorithm is a curve compared against itself and gives
// exactly 0.00% (all 14 of this book's single row selections), a selection whose
// algorithms never shared a credited date is arithmetic about unrelated curves
// and can give any figure at all (3 of this book's 91 pairs), and a selection
// every row of which was credited on no day has no curve in it. So `reduction`
// is null in all five cases, `reductionRefusal` names which, `reductionNote`
// carries the sentence, and `REDUCTION_REFUSALS` holds the wording: see
// `buildAlgorithmComposite` for the field contract the panel reads.
//
// AND THE FIGURE IS MEASURED OVER EVERY CREDITED DATE IN THE SELECTION, NOT OVER
// THE OVERLAP. Both halves of the ratio are read off curves that span every date
// any selected algorithm was credited on, so that is what `reductionDates`,
// `reductionDateCount` and the `reductionBasis` sentence state.
// `overlapDays`/`overlapDates` are the subset where more than one of them was
// credited: a disclosure about how related the curves are, and the input to the
// `noSharedDate` refusal, never the basis of the figure. The panel printed the
// overlap count as the basis and on this book that said 4 where the comparison
// spanned 12 (ARPD_PF, OGX_PF and ARPD, 20.69% over 12 credited dates of which 4
// carry more than one), which describes the figure as more narrowly scoped than
// it is. The sentence is published from here for that reason.
//
// WHAT A HALF LOADED BOOK DOES TO EVERY FIGURE HERE. A live login fetches
// account and strategy rows for ONE close per client, so every other
// `dailyImport` reaches this file with `snapshots: []` and a thirty day window
// measures a handful of account days instead of thousands. This module cannot fix
// that and does not pretend to: `population` publishes the funded day, account
// and client counts it actually walked, so the caption can state them, and the
// screen is responsible for loading the window before it quotes a total.

import { REPORTED_TOLERANCE, reconcilesOn } from './algoContribution';
import { measuredOnAccountDay } from './algorithmRanking';
import {
  MIN_ACCOUNTS,
  MIN_DAYS,
  dayAlgoRows,
  executionsForAccount,
  fundedAccountDays,
  resolveWindow,
} from './comboPerformance';

/** Above this, over the last `HEAT_DATES` credited dates, a row reads Hot. */
export const HOT_ABOVE = 250;

/** Below this, over the same three dates, it reads Cold. Between them, Stable. */
export const COLD_BELOW = -250;

/** How many credited trading dates `heat` sums. Three, as the client screen. */
export const HEAT_DATES = 3;

/**
 * The dollar allowed between the algorithms' own figures and the account day.
 *
 * Imported, not chosen. `algoContribution.js` owns it and the reason it is a flat
 * dollar rather than a cent per row, and this module deliberately does not offer
 * it as an option: three tolerances already exist in this codebase and a fourth,
 * configurable one is how two panels end up disagreeing about which days
 * reconciled while both print the word.
 */
export const RECONCILE_TOLERANCE = REPORTED_TOLERANCE;

/**
 * The three cases an account day can fall into, in the order they are tried.
 *
 * The order is the rule, not a listing: SOLE before MEASURED is what credits a
 * solo day the account's own figure instead of checking the one strategy row
 * against it and refusing the 56 days on this book where the two disagree. A
 * test walks that order on a fixture rather than reading this array, so shortening
 * it to satisfy a reviewer changes nothing that matters and fails anyway.
 */
export const ATTRIBUTION_CASES = ['sole', 'measured', 'unsplit'];

/**
 * What the screen prints over `deepestDip`, published on the result as `dipLabel`.
 *
 * "Drawdown" on every other panel in this product is a prop firm's trailing limit
 * and a CAM reads it as breach risk, so neither the field names here nor this
 * label use the word. The wording is not invented for this panel either:
 * `PerformanceCharts.jsx:179` already renders "Deepest dip" over the same
 * measurement on the desk's own P&L curve (`performanceSeries.js`), and one
 * quantity with two printed names is how a comparison gets quoted against the
 * wrong denominator.
 */
export const DEEPEST_DIP_LABEL = 'Deepest dip inside this window';

/**
 * What a row carries in place of a temperature when it was credited on no day.
 *
 * Not 'Stable'. Hot, Cold and Stable are readings of a heat figure and the CAM
 * already trusts that badge from the client screen; a row whose every account day
 * went to UNSPLIT has no heat figure, and calling it Stable is a claim about an
 * algorithm nothing here measured.
 */
export const UNMEASURED_TEMPERATURE = 'Unmeasured';

/**
 * What the `unsplit` bucket is, for the screen to print beside the figures.
 *
 * It names the refusal rather than describing a gap, because a reader who is told
 * only "some days are missing" assumes a loading state.
 */
export const UNSPLIT_NOTE = 'Account days on which more than one algorithm ran and nothing on the '
  + 'close says how the money divided between them. Their money is counted here and credited to no '
  + 'algorithm. It is never divided equally: an even split adds up correctly and invents which '
  + 'algorithm made what, so every curve and every dip measured on it would be fiction.';

/**
 * WHY a day could not be partitioned, in the words the panel prints, one per
 * bucket of `unsplit.reasons`.
 *
 * Three reasons, and they partition `unsplit.days` and `unsplit.pnl` exactly. Two
 * of them are missing measurements and only the third is a disagreement, which is
 * the distinction the module header used to get wrong for 72 of 115 days: a CAM
 * explaining why -$53,417.10 sits out of a client-facing panel has to name the
 * cause that actually applied. Written without dashes of any kind, like
 * `REDUCTION_CAVEAT` and for the same reason.
 */
export const UNSPLIT_REASONS = {
  missingFigure: 'More than one algorithm ran and at least one of them carries no figure at all, so '
    + 'there was never anything to check. A family named only by the fills, with no strategy row on '
    + 'the close, can never have one.',
  unreported: 'More than one algorithm ran and every one of them reported exactly $0. That is an '
    + 'unreported day rather than agreement, so it is refused: on the days where the account was flat '
    + 'as well, counted here as flat days, the zeros do add up to the account day to the cent and the '
    + 'day is still refused, because nothing measured it.',
  mismatched: 'More than one algorithm ran, every one of them carries a figure, and the figures do '
    + 'not add up to the account day inside the tolerance. This is the only one of the three where '
    + 'something measured every algorithm and the measurements disagree with the close.',
};

/**
 * The sentence that has to travel with `reduction`, everywhere it is printed.
 *
 * `reduction` is the figure a CAM is about to put in front of a paying client,
 * and it invites one specific misreading: that the combined curve fell less than
 * "the portfolio" would have. There is no such portfolio. Written without dashes
 * of any kind, because the Stack Playbook section it renders in is asserted
 * against en dashes, em dashes and spaced hyphens.
 *
 * It used to end "so the sum grows with every algorithm added and this reduction
 * grows with it", and this book falsifies both halves of that: the denominator is
 * a sum of non positive dips, so its MAGNITUDE never shrinks, but it does not
 * always grow, because a real row can have a dip of exactly 0; and walking the 14
 * rows of the stored book one at a time the reduction FALLS at 6 of the 12 steps.
 * A client facing sentence cannot promise a direction the arithmetic does not
 * have, so it now says what is true: the figure belongs to the selection.
 *
 * Both of its remaining claims were re-checked against this file rather than
 * left standing. "Never shrinks as algorithms are added" is a theorem about a
 * sum of non positive dips and the tests walk it on a fixture and on the book.
 * "Over these dates" is deliberately vague here and is made exact beside it:
 * WHICH dates is `reductionBasis`, built by `basisOf`, because a caveat that
 * names the dates itself would have to be rebuilt per selection and this one is
 * asserted as a full string by the panel's own test.
 */
export const REDUCTION_CAVEAT = 'The sum of the parts is not a portfolio anyone held: it adds up '
  + 'each selected algorithm’s own deepest dip as though each had fallen alone, on its own '
  + 'dates, so that total never shrinks as algorithms are added and this figure belongs to the '
  + 'selection rather than to the algorithms. Read it as a statement about these algorithms over '
  + 'these dates, never as a property that survives selecting a fifth one.';

/**
 * WHY THERE IS NO REDUCTION TO PRINT, in the words the panel prints, one per
 * value of `reductionRefusal`. Exactly one applies when `reduction` is null and
 * none applies when it is a number.
 *
 * The same contract `UNSPLIT_REASONS` holds, and for the same reason: a refusal
 * a screen has to write a sentence for is a refusal that gets written wrong, or
 * gets printed as a 0 with a footnote nobody reads. The panel switches on the
 * key and prints the note, and the note is a full sentence because the key is
 * not one. Written without dashes of any kind, like `REDUCTION_CAVEAT` and for
 * the same reason: the Stack Playbook section they render in is asserted against
 * en dashes, em dashes and spaced hyphens.
 *
 * `compositeNeverFell` carries the wording `AlgorithmTemperaturePanel.jsx`
 * already had on its null branch, because one refusal with two sentences is how
 * two branches of one screen end up disagreeing about what was refused.
 */
export const REDUCTION_REFUSALS = {
  noSelection: 'No algorithm is selected, so there is no combined curve and nothing to compare it '
    + 'against.',
  allUnmeasured: 'Every selected algorithm was credited on no account day at all, so there is no '
    + 'curve here to compare. The days they ran on are counted in the unsplit bucket and credited '
    + 'to nobody.',
  singleAlgorithm: 'One algorithm is selected, and the combined curve of one algorithm IS that '
    + 'algorithm. The figure would be that curve measured against itself, which is 0% by '
    + 'construction and not a finding about anything.',
  noSharedDate: 'The selected algorithms were never credited on the same date, so the combined '
    + 'curve is the parts laid end to end and nothing either of them did ever offset anything the '
    + 'other did. A figure here would be arithmetic about unrelated curves.',
  compositeNeverFell: 'The combined curve never fell below where the window opened, so there is no '
    + 'fall to compare. That is not a reduction of 100%, it is no comparison.',
};

/**
 * Defaults.
 *
 * `level` is 'family' where `comboPerformance.DEFAULT_OPTIONS` says 'version',
 * and that is the whole point of the file: a combo table's subject is the stack,
 * so the version belongs in its key, while this panel's subject is the algorithm
 * the CAM names out loud. At 'version' the rows read `OGX_PF 2.4` and the desk
 * gets the same fragmentation it just rejected, under a new heading.
 *
 * `minDays` and `minAccounts` are `comboPerformance`'s gate, not
 * `algorithmRanking`'s 30 and 10, because this panel renders inside the Stack
 * Playbook beside the combo table and two "low sample" badges with two different
 * thresholds under one heading is the reason a manager stops trusting either.
 */
export const DEFAULT_OPTIONS = {
  basis: 'traded',
  level: 'family',
  window: { preset: 30, from: null, to: null },
  minDays: MIN_DAYS,
  minAccounts: MIN_ACCOUNTS,
  includeFailed: true,
};

/** Hot, Cold or Stable from a heat figure. The client screen's thresholds. */
export function temperatureOf(heat) {
  const value = Number(heat) || 0;
  if (value > HOT_ABOVE) return 'Hot';
  if (value < COLD_BELOW) return 'Cold';
  return 'Stable';
}

const byDateAsc = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const seriesOf = (byDate) => [...byDate.entries()].sort(byDateAsc).map(([date, pnl]) => ({ date, pnl }));

/**
 * The cumulative curve of a `{ date, pnl }` series, and its deepest dip.
 *
 * One pass, because the dip needs the date the peak was set on and the curve
 * needs the peak on every point: computing them apart is two loops that can
 * disagree about which peak was running.
 *
 * `deepestDipFrom` is '' when the deepest dip runs from the curve's own origin,
 * which is what happens on a curve that never gets above where the window opened.
 * It is not a missing value: it means the fall started before the algorithm had
 * contributed anything.
 *
 * Nothing here is called a drawdown, on the field or on the point: see the module
 * header for the collision that name would cause on these screens.
 */
export function curveOf(series = []) {
  const equity = [];
  let cum = 0;
  let peak = 0;
  let peakDate = '';
  let deepestDip = 0;
  let deepestDipFrom = '';
  let deepestDipTo = '';
  for (const point of series) {
    cum += Number(point.pnl) || 0;
    if (cum > peak) {
      peak = cum;
      peakDate = point.date;
    }
    const dip = cum - peak;
    if (dip < deepestDip) {
      deepestDip = dip;
      deepestDipFrom = peakDate;
      deepestDipTo = point.date;
    }
    equity.push({ date: point.date, cum, peak, dip });
  }
  return { equity, deepestDip, deepestDipFrom, deepestDipTo };
}

function newRow(key, family, level) {
  return {
    key,
    family,
    level,
    byDate: new Map(),
    totalPnl: 0,
    days: 0,
    accountSet: new Set(),
    clientSet: new Set(),
    measuredDays: 0,
    soleDays: 0,
    unsplitDays: 0,
  };
}

function finishRow(row, { minDays, minAccounts }) {
  const series = seriesOf(row.byDate);
  const { equity, deepestDip, deepestDipFrom, deepestDipTo } = curveOf(series);
  // The last three dates the algorithm was actually credited on, which on a
  // sparse row are not the last three closes of the window and are not claimed
  // to be. `heatDates` is published so the screen can name them.
  const heatDates = series.slice(-HEAT_DATES);
  const heat = heatDates.reduce((total, point) => total + point.pnl, 0);
  // A row every one of whose account days went to UNSPLIT was credited nothing,
  // so there is no curve here to read a temperature or a dip off. `days: 0`, an
  // empty `series` and a non-zero `unsplitDays` are the honest shape for "it ran
  // and nothing here can say what it made" and they always were; `temperature:
  // 'Stable'` and `deepestDip: 0` were not. Both are claims rather than gaps, one
  // in the badge the CAM already trusts from the client screen and one under a
  // label that says "deepest dip inside this window", on an algorithm that ran on
  // days the desk lost real money. `lowSample` is not the flag for it either: it
  // means the sample is thin, which is a different sentence from unmeasured.
  const unmeasured = row.days === 0;
  return {
    key: row.key,
    family: row.family,
    level: row.level,
    days: row.days,
    accounts: row.accountSet.size,
    clients: row.clientSet.size,
    totalPnl: row.totalPnl,
    avgPnl: row.days ? row.totalPnl / row.days : 0,
    series,
    equity,
    deepestDip: unmeasured ? null : deepestDip,
    deepestDipFrom,
    deepestDipTo,
    // null and not 0, for the same reason as `deepestDip`: the sum over no
    // credited dates is not a reading of anything, and `heatDates` is empty
    // beside it. The comparator below sorts on the unmeasured flag first, so
    // nothing here depends on a number being present.
    heat: unmeasured ? null : heat,
    heatDates: heatDates.map((point) => point.date),
    temperature: unmeasured ? UNMEASURED_TEMPERATURE : temperatureOf(heat),
    unmeasured,
    lowSample: row.days < minDays || row.accountSet.size < minAccounts,
    // `unsplitDays` is here and no unsplit dollars are: see the module header.
    attribution: {
      measuredDays: row.measuredDays,
      soleDays: row.soleDays,
      unsplitDays: row.unsplitDays,
    },
  };
}

/**
 * One row per algorithm over every client's funded account days inside a window,
 * hottest first, each with the cumulative curve of its own partitioned
 * contribution.
 *
 * Returns `{ basis, level, window, minDays, minAccounts, rows, unsplit,
 * population, reconciliation }`. See the module header for the three attribution
 * cases and for what `unsplit` is.
 *
 * Two identities hold over the return and the tests pin both:
 *
 *   population.fundedPnl === population.includedPnl + population.unknownPnl
 *                           + unsplit.pnl
 *   sum(rows.totalPnl)    === population.includedPnl + reconciliation.residualPnl
 *
 * The second is the no double counting property. `residualPnl` is the dollars the
 * accepted MEASURED days left between the algorithms' own figures and the
 * account day, each inside the tolerance; it is 0 on a book whose days are all
 * SOLE.
 */
export function buildAlgorithmTemperature(clients = [], options = {}) {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    window: { ...DEFAULT_OPTIONS.window, ...(options.window || {}) },
  };
  const { basis, level, minDays, minAccounts, includeFailed } = opts;
  const window = resolveWindow(clients, opts.window);
  const { from, to } = window;

  const rows = new Map();
  const unsplitByDate = new Map();
  const unsplit = { days: 0, pnl: 0 };
  // The three refusals, counted apart and in dollars, because they are three
  // different statements about the close and the header used to explain all of
  // them with the third. `flatDays` is the subset of `unreported` whose account
  // day was flat too: their zeros do reconcile with it and are refused anyway.
  const unsplitReasons = {
    missingFigure: { days: 0, pnl: 0, note: UNSPLIT_REASONS.missingFigure },
    unreported: { days: 0, pnl: 0, flatDays: 0, note: UNSPLIT_REASONS.unreported },
    mismatched: { days: 0, pnl: 0, note: UNSPLIT_REASONS.mismatched },
  };
  const reconciliation = {
    tolerance: RECONCILE_TOLERANCE,
    checkedDays: 0,
    reconciledDays: 0,
    refusedDays: 0,
    residualPnl: 0,
  };
  const population = {
    fundedDays: 0,
    fundedPnl: 0,
    includedDays: 0,
    includedPnl: 0,
    unknownDays: 0,
    unknownPnl: 0,
    failedAccountDays: 0,
    hiddenClients: Number(options.hiddenClientCount || 0),
    accounts: new Set(),
    clients: new Set(),
    fundedAccounts: new Set(),
    fundedClients: new Set(),
  };

  for (const funded of fundedAccountDays(clients, { from, to, includeFailed })) {
    const { client, dailyImport, snapshot, date, pnl, accountId, accountName, isFailed } = funded;
    population.fundedDays += 1;
    population.fundedPnl += pnl;
    population.fundedAccounts.add(accountId);
    population.fundedClients.add(client.id);

    // Which algorithms ran, at the caller's level, WITH the grid rows behind
    // each one. One resolve, and the same one `comboKeyFromDay` would give the
    // combo table beside this panel: an empty list is exactly that call
    // returning the Unknown key.
    const algos = dayAlgoRows(
      snapshot,
      executionsForAccount(dailyImport, accountName),
      { basis, level },
    );
    if (!algos.length) {
      population.unknownDays += 1;
      population.unknownPnl += pnl;
      continue;
    }

    // One figure per algorithm, summed over the rows this resolution accepted
    // for it. null means nothing measured it, which is not $0: a family the
    // fills name with no grid row at all has no figure and can never have one.
    const figures = algos.map((algo) => {
      let figure = null;
      for (const strategy of algo.strategies) {
        const measured = measuredOnAccountDay(strategy);
        if (measured == null) continue;
        figure = (figure == null ? 0 : figure) + measured;
      }
      return figure;
    });

    let credits = null;
    // Why this day could not be partitioned, when it could not. Named `refusal`
    // and not `reason` because `dayAlgoRows` already publishes a `reason` per
    // element, meaning the evidence that the algorithm ran at all, and two
    // different questions sharing one word in one loop is how the wrong one gets
    // printed. It starts at the default: several ran and a figure is absent.
    let refusal = 'missingFigure';
    if (algos.length === 1) {
      // SOLE. The whole account day, and not the strategy row's own figure.
      credits = [pnl];
    } else if (figures.every((figure) => figure != null)) {
      reconciliation.checkedDays += 1;
      const sum = figures.reduce((total, figure) => total + figure, 0);
      // Zero against zero is not agreement, it is an unreported day, and
      // `reconcilesOn` refuses it. Several algorithms all reporting a flat 0 on
      // a flat day therefore land in UNSPLIT, with no money, which is the
      // honest place for a day nothing measured. That refusal is counted as
      // `unreported` rather than as a mismatch: on a flat account day those
      // zeros do add up to the close, so calling it a disagreement would name a
      // cause that is not there.
      const anyReported = figures.some((figure) => figure !== 0);
      if (reconcilesOn(pnl, sum, anyReported)) {
        reconciliation.reconciledDays += 1;
        reconciliation.residualPnl += sum - pnl;
        credits = figures;
      } else {
        reconciliation.refusedDays += 1;
        refusal = anyReported ? 'mismatched' : 'unreported';
      }
    }

    if (!credits) {
      unsplit.days += 1;
      unsplit.pnl += pnl;
      const bucket = unsplitReasons[refusal];
      bucket.days += 1;
      bucket.pnl += pnl;
      if (refusal === 'unreported' && pnl === 0) bucket.flatDays += 1;
      const seen = unsplitByDate.get(date) || { date, days: 0, pnl: 0 };
      seen.days += 1;
      seen.pnl += pnl;
      unsplitByDate.set(date, seen);
    } else {
      population.includedDays += 1;
      population.includedPnl += pnl;
      population.accounts.add(accountId);
      population.clients.add(client.id);
      if (isFailed) population.failedAccountDays += 1;
    }

    const isSole = credits && algos.length === 1;
    algos.forEach((algo, index) => {
      const row = rows.get(algo.key) || newRow(algo.key, algo.family, level);
      rows.set(algo.key, row);
      if (!credits) {
        row.unsplitDays += 1;
        return;
      }
      const credit = credits[index];
      row.days += 1;
      row.totalPnl += credit;
      row.accountSet.add(accountId);
      row.clientSet.add(client.id);
      row.byDate.set(date, (row.byDate.get(date) || 0) + credit);
      if (isSole) row.soleDays += 1;
      else row.measuredDays += 1;
    });
  }

  const finished = [...rows.values()].map((row) => finishRow(row, { minDays, minAccounts }));
  // Signed heat, descending. Not magnitude: see the module header. An unmeasured
  // row goes below every measured one first, because its heat is not a reading.
  finished.sort((a, b) => (
    Number(a.unmeasured) - Number(b.unmeasured)
    || b.heat - a.heat
    || a.key.localeCompare(b.key)
  ));

  return {
    basis,
    level,
    window,
    minDays,
    minAccounts,
    rows: finished,
    dipLabel: DEEPEST_DIP_LABEL,
    unsplit: {
      days: unsplit.days,
      pnl: unsplit.pnl,
      dates: [...unsplitByDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      note: UNSPLIT_NOTE,
      reasons: unsplitReasons,
    },
    population: {
      fundedDays: population.fundedDays,
      fundedPnl: population.fundedPnl,
      avgPnlPerAccountDay: population.fundedDays ? population.fundedPnl / population.fundedDays : 0,
      includedDays: population.includedDays,
      includedPnl: population.includedPnl,
      unknownDays: population.unknownDays,
      unknownPnl: population.unknownPnl,
      failedAccountDays: population.failedAccountDays,
      hiddenClients: population.hiddenClients,
      accounts: population.accounts.size,
      clients: population.clients.size,
      fundedAccounts: population.fundedAccounts.size,
      fundedClients: population.fundedClients.size,
    },
    reconciliation,
  };
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * How far the combined curve has to fall before the fall is a fall: half a cent.
 *
 * Not zero, and this is not defensive rounding. The ratio does not care how
 * small its numerator is, so a dip of a float residue is 100% lower exactly like
 * a dip of nothing, and a residue is what summing money in binary produces:
 * three algorithms credited +$0.30, -$0.10 and -$0.20 on one date give a
 * composite of -2.8e-17, a dip of -2.8e-17 against a sum of parts of -$0.30, and
 * a reduction of 0.9999999999999999, which `percent` renders "100.00% lower"
 * over "Combined $0 against -$0". Below half a cent the fall rounds to $0.00
 * everywhere this product prints money, so there is nothing on the screen for
 * the percentage to be a percentage of. The same floor is applied to the
 * denominator, where a sub cent sum of dips is a ratio between two roundings.
 */
const FELL_AT_ALL = 0.005;

/**
 * The sentence naming WHICH DATES a published `reduction` was measured over.
 *
 * Asserted as a full string rather than assembled by the screen, like
 * `UNSPLIT_NOTE` and `REDUCTION_CAVEAT`, because the panel assembled this one
 * itself and got it wrong in the direction that flatters the figure: it printed
 * the overlap count, which on the stored book said the comparison was measured
 * over 4 dates when it was measured over 12. Both halves of the ratio are
 * computed over every date any selected algorithm was credited on, so that is
 * what this says, with the overlap named as the subset it is.
 *
 * AND WHEN THE TWO COUNTS COINCIDE THE CONTRAST HAS TO GO, which is the second
 * thing this sentence got wrong. The "not only the N dates" clause exists to
 * stop a reader shrinking the basis to the overlap, and it only does that while
 * the overlap is SMALLER. When every credited date is also an overlap date the
 * one-shape sentence read "Measured over 14 dates [...] not only the 14 dates
 * [...]", which denies itself out loud and invites exactly the question it was
 * written to close. That is not an edge case on this book: 7,520 of the 16,365
 * selections that publish a figure have `overlapCount === dateCount`, including
 * BOTH figures this module quotes to a reader, the 4.44% over the ten gated rows
 * and the 5.52% over all fourteen. So the counts are stated once and the
 * stronger fact, that every date in the basis carries more than one of the
 * selected algorithms, is stated instead of the contrast.
 */
function basisOf(dateCount, overlapCount) {
  const dates = plural(dateCount, 'date', 'dates');
  if (overlapCount === dateCount) {
    return `Measured over ${dates} on which at least one selected algorithm was credited, `
      + `and more than one of them was credited on every one of ${dateCount === 1 ? 'them' : 'those dates'}.`;
  }
  return `Measured over ${dates} on which at least one selected `
    + `algorithm was credited, not only the ${plural(overlapCount, 'date', 'dates')} on which more `
    + 'than one of them was.';
}

/**
 * The selected algorithms as one curve, against each of them on its own.
 *
 * Built from the per algorithm PARTITIONED series, so the composite on a date is
 * the sum of what the selected algorithms were credited on that date and never
 * more than the account days behind it: on a day three algorithms ran and the
 * figures reconciled, selecting all three reconstructs that day, once.
 *
 * `reduction` is 1 minus the composite's deepest dip over the sum of the parts'
 * deepest dips, OR null, and null is a refusal rather than a missing value. It
 * must never be printed without `caveat`, which says why the denominator is not
 * a portfolio and why the figure belongs to the selection rather than to the
 * algorithms. It is not monotone in the size of that selection: see the module
 * header, where this book's nesting steps are counted.
 *
 * THE FIVE FIELDS A SCREEN READS OFF THIS, AND THE RULE BETWEEN THEM. Exactly
 * one of the two sides below is populated, so a panel cannot print a percentage
 * and a refusal at once, and cannot fall through to a number when there is none:
 *
 *   reduction === null       `reductionRefusal` is one of the keys of
 *                            `REDUCTION_REFUSALS`, in this order of precedence:
 *                            'noSelection' (nothing selected, or no selected key
 *                            answers to a row), 'allUnmeasured' (every selected
 *                            row was credited on no day and is in
 *                            `unmeasuredKeys`), 'singleAlgorithm' (fewer than two
 *                            measured parts survived), 'noSharedDate'
 *                            (`overlapDays` is 0) and 'compositeNeverFell'
 *                            (`deepestDip` is shallower than half a cent, which
 *                            is the 100% case). `reductionNote` is that key's
 *                            sentence, ready to print. `reductionBasis` is null.
 *   reduction is a number    `reductionRefusal` and `reductionNote` are null, and
 *                            `reductionBasis` is the sentence naming the dates
 *                            the figure covers.
 *
 * AND WHICH DATES THAT IS, because the panel got it wrong: both `deepestDip` and
 * `sumOfPartDips` are measured over EVERY date any selected algorithm was
 * credited on. That list is `reductionDates`, its length is
 * `reductionDateCount`, and `reductionBasis` states it in words. The two lists
 * describe the curve rather than the ratio, so they are populated on a refusal
 * as well; only `reductionBasis`, which is a sentence about a figure, is not.
 * `overlapDays`/`overlapDates` are the SUBSET on which more than one of them was
 * credited: a disclosure about how related the curves are, never the basis of
 * the figure. Saying the reduction was measured over the overlap dates makes it
 * sound more narrowly scoped than it is.
 *
 * `selectedKeys` takes a Set or an array. A key no row answers to is ignored: not
 * because a 0 part would move the reduction, which it cannot, since adding 0 to a
 * sum of negative dips changes neither the sum nor the ratio, but because there is
 * nothing there to be a part of anything. A selected row that DOES exist and was
 * credited on no day at all is a different case and is not a part either: its dip
 * is null rather than 0. Those keys come back in `unmeasuredKeys`, so a selection
 * whose rows were all unsplit reads as "nothing here was measured" rather than as
 * a composite that never fell.
 */
export function buildAlgorithmComposite(result, selectedKeys = []) {
  const wanted = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  const selected = (result?.rows || []).filter((row) => wanted.has(row.key));
  const parts = selected.filter((row) => !row.unmeasured);
  const unmeasuredKeys = selected.filter((row) => row.unmeasured).map((row) => row.key);

  const byDate = new Map();
  const algosOnDate = new Map();
  for (const part of parts) {
    for (const point of part.series) {
      byDate.set(point.date, (byDate.get(point.date) || 0) + point.pnl);
      algosOnDate.set(point.date, (algosOnDate.get(point.date) || 0) + 1);
    }
  }

  const series = seriesOf(byDate);
  const { equity, deepestDip, deepestDipFrom, deepestDipTo } = curveOf(series);
  const sumOfPartDips = parts.reduce((total, part) => total + part.deepestDip, 0);
  // Dates where more than one SELECTED algorithm was credited. Measured on the
  // series the composite is built from, so an unsplit day on which two of them
  // ran is in neither this count nor the curve.
  const overlapDates = [...algosOnDate.entries()]
    .filter(([, count]) => count > 1)
    .map(([date]) => date)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Every date the comparison spans, which is every date ANY selected algorithm
  // was credited on and not the overlap subset: both halves of the ratio are
  // measured over this whole list. Published because the panel printed the
  // overlap count as the basis of the figure and on the book that said 4 where
  // the comparison spanned 12.
  const reductionDates = series.map((point) => point.date);

  // WHICH REFUSAL APPLIES, most fundamental first. Each one is a case where the
  // arithmetic still produces a number and the number is not about anything: see
  // REDUCTION_REFUSALS for what each one says and the module header for the two
  // that were reached from a cold open on the real book.
  let reductionRefusal = null;
  if (!parts.length) reductionRefusal = unmeasuredKeys.length ? 'allUnmeasured' : 'noSelection';
  else if (parts.length < 2) reductionRefusal = 'singleAlgorithm';
  else if (!overlapDates.length) reductionRefusal = 'noSharedDate';
  // The numerator, which is the guard this line used to be missing. It was
  // `sumOfPartDips === 0`, the DENOMINATOR, and that case cannot occur without
  // this one: a part whose dip is 0 has a non decreasing curve, so parts that
  // all have a dip of 0 sum to a composite that never falls either. The reverse
  // does not hold, and that is the whole defect: a composite of +$430 and
  // -$25.50 on one date never falls while the denominator is -$25.50, and
  // 1 - (0 / -25.5) is 1, printed as "100.00% lower". Measured at half a cent
  // rather than at 0 because a float residue is 100% lower too: see
  // `FELL_AT_ALL`.
  else if (-deepestDip < FELL_AT_ALL || -sumOfPartDips < FELL_AT_ALL) reductionRefusal = 'compositeNeverFell';

  // Both figures are negative or zero, so the ratio is positive and the sign
  // cancels. Reached only when neither is zero and the comparison has two curves
  // and a shared date to be a comparison between.
  //
  // CLAMPED AT 0, AND THIS IS THE LAST MEMBER OF THE "100.00% lower" FAMILY.
  // `FELL_AT_ALL` guards the two INPUTS against a float residue; it does not
  // guard the RATIO between two inputs that are both large and equal. When the
  // composite's dip and the sum of the parts' dips are the same money summed in
  // two different orders, the division lands one ulp on the wrong side of 1 and
  // the reduction comes back -2.220446049250313e-16, which `toFixed(2)` renders
  // "-0.00%" and the panel prints in bold as "-0.00% lower". Six selections of
  // this book do it, the smallest being IFSP + RBO, two ordinary gated rows two
  // clicks apart, at a dip of -$20,642.200000000008 against a sum of
  // -$20,642.200000000004. A reduction below 0 would mean the combined curve
  // fell FURTHER than its parts did separately, which the arithmetic forbids:
  // the composite's dip is bounded by the sum of the parts' dips. So a negative
  // here is never a finding, only a summation order, and 0 is the true figure.
  const reduction = reductionRefusal ? null : Math.max(0, 1 - (deepestDip / sumOfPartDips));

  return {
    series,
    equity,
    deepestDip,
    deepestDipFrom,
    deepestDipTo,
    dipLabel: DEEPEST_DIP_LABEL,
    parts: parts.map((part) => ({
      key: part.key,
      deepestDip: part.deepestDip,
      totalPnl: part.totalPnl,
    })),
    unmeasuredKeys,
    sumOfPartDips,
    reduction,
    // Exactly one of these two sides is populated. A figure carries the dates it
    // was measured over; a refusal carries the sentence saying why there is no
    // figure, and no basis, because there is nothing for a basis to be about.
    reductionRefusal,
    reductionNote: reductionRefusal ? REDUCTION_REFUSALS[reductionRefusal] : null,
    reductionBasis: reductionRefusal ? null : basisOf(reductionDates.length, overlapDates.length),
    reductionDates,
    reductionDateCount: reductionDates.length,
    overlapDays: overlapDates.length,
    overlapDates,
    caveat: REDUCTION_CAVEAT,
  };
}
