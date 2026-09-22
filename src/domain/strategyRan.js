// DID IT RUN, WHICH IS NOT THE SAME QUESTION AS WAS IT ENABLED.
//
// `strategy_snapshots.enabled` is the state of a checkbox at the moment the
// export was taken. The exports are taken after the desk switches the algos
// off, so on most closes the checkbox says no about a day that happened.
//
// On 2026-09-21, across 84 closes: 438 strategy rows, 543 executions, and 46
// distinct (close, strategy) pairs produced fills. 45 of those 46 carry
// `enabled = false`. On the stored book (3,805 strategy rows over 516 closes)
// the two answers part company on 220 closes: 1,517 rows are enabled, 2,528
// ran, and 261 closes carry no enabled row at all while 207 of them ran
// something. A screen reading the checkbox is not reading a quiet desk, it is
// reading the export clock.
//
// THE RULE, AND WHY IT IS HERE AND NOWHERE ELSE.
//
// A strategy ran on an account day when ANY of three things is true, strongest
// evidence first:
//
//   enabled   the grid still had it switched on when the export was taken
//   fills     that account's own fills name its family that day
//   realized  the grid reported a non-zero realized on a row it had switched off
//   none      none of the above, which is the only honest "it did not run"
//
// comboPerformance.js has answered exactly this since the Stack Playbook was
// built, under `basis: 'traded'`, and it was the only thing in the product that
// did. Everything else asked the checkbox. The rule lives here now so the
// ingest, the backfill, the combo table and every screen share one copy of it;
// two copies of an identity rule is how IFSP_PF ended up folded into IFSP on
// one screen and kept apart on another (see comboPerformance's header).
//
// WHY `derived_realized` IS NOT A FIFTH BASIS.
//
// Step 37's derived figure is worked out FROM the fills: a row carrying one is
// a row the fills named, which this rule already answers `fills`. Counting it
// separately would count one fact twice, and worse, would make the answer
// depend on whether the derivation ran at all, which it does not on the
// automatic collection path.
//
// WHY THE STORED ANSWER WINS OVER A RECOMPUTATION.
//
// Step 47 stores `ran` and `ran_basis` on the row at ingest, where the day's
// fills are on hand. Every reader prefers the stored answer, because the whole
// point of storing it is that the fills do not have to be loaded to ask the
// question. A row with no stored answer falls back to the rule over whatever
// evidence the caller holds, which on a database where step 47 has not run
// is the checkbox plus the row's own realized: the same answer the product
// gave before this existed.

// Extensions explicit: reconcile.js imports this module, and reconcile.js is on
// the import chain of a Vercel serverless function (the ingest endpoint). Plain
// Node ESM does not resolve './strategyFamily', and the failure is a 500 on
// upload that never happens in dev, which this repository has paid for once.
import { strategyFamilyOf } from './strategyFamily.js';
import { parseStrategyVersion } from './csvImport.js';

/** The four answers, strongest evidence first. */
export const RAN_BASES = ['enabled', 'fills', 'realized', 'none'];

/** Evidence order, for a caller folding several rows into one answer. */
export const RAN_BASIS_RANK = { enabled: 0, fills: 1, realized: 2, none: 3 };

const lower = (value) => String(value || '').toLowerCase();

/**
 * The family a strategy NAME belongs to, by this product's one rule.
 *
 * The fills name a strategy the way the Strategies grid does (`0 - OGX-PF-2.4`)
 * but the grid row stores its family as `OGX_PF`: strategyFamilyOf keeps the
 * `-PF` and csvImport's normalizeStrategyFamily turns it into `_PF`. Measured
 * over the stored book, this reproduces `strategy_snapshots.strategy_family` on
 * all 3,805 rows, which is why the step 47 backfill is allowed to compute the
 * family from the name on both sides of its join.
 */
export function familyFromStrategyName(strategyName) {
  const family = strategyFamilyOf(strategyName);
  if (!family) return null;
  const pf = family.match(/^([A-Z0-9]+)-PF$/i);
  return pf ? `${pf[1].toUpperCase()}_PF` : family;
}

/** The family of one Strategies-grid row: what it stores, or its name. */
export function familyOfStrategyRow(strategy) {
  return strategy?.strategyFamily || familyFromStrategyName(strategy?.strategyName) || null;
}

/**
 * The families named on a set of fills, as `Map(family -> version)`.
 *
 * The version travels with the family because a family named ONLY on the fills
 * (98 funded days on the book carried no strategy rows at all) has nowhere else
 * to get one.
 */
export function familiesOnFills(executions = []) {
  const families = new Map();
  for (const execution of executions || []) {
    const family = familyFromStrategyName(execution?.strategyName);
    if (!family) continue;
    if (!families.has(family)) families.set(family, parseStrategyVersion(execution.strategyName));
  }
  return families;
}

/**
 * THE RULE. One grid row against the families its own account's fills name.
 *
 * `filledFamilies` is what familiesOnFills returned for THIS account's fills on
 * THIS close. Pass nothing and the fills cannot be consulted, which is not the
 * same as their naming nothing: a caller with no fills on hand gets the answer
 * the checkbox and the row's own realized can support, never a claim that the
 * day was quiet.
 */
export function ranBasisFromEvidence(strategy, filledFamilies = null) {
  if (strategy?.enabled === true) return 'enabled';
  const family = familyOfStrategyRow(strategy);
  if (family && filledFamilies?.has(family)) return 'fills';
  const realized = strategy?.realized;
  if (realized != null && Number(realized) !== 0) return 'realized';
  return 'none';
}

/** The stored answer if the row carries one this product recognises. */
export function storedRanBasis(strategy) {
  const basis = strategy?.ranBasis;
  return RAN_BASES.includes(basis) ? basis : '';
}

/**
 * What this row says about the day: the stored answer, or the rule.
 *
 * A row that carries `ran` without a basis (a writer that stored the boolean
 * alone) is believed on the boolean and reported as `enabled` or `none`, which
 * are the two answers a boolean can support.
 */
export function ranBasisOf(strategy, filledFamilies = null) {
  const stored = storedRanBasis(strategy);
  if (stored) return stored;
  if (typeof strategy?.ran === 'boolean') return strategy.ran ? 'enabled' : 'none';
  return ranBasisFromEvidence(strategy, filledFamilies);
}

/** Did this strategy run on its close. The one-line question a screen asks. */
export function strategyRan(strategy, filledFamilies = null) {
  return ranBasisOf(strategy, filledFamilies) !== 'none';
}

/**
 * CAN THIS ROW'S "NO" BE BELIEVED WITHOUT THE CLOSE'S FILLS?
 *
 * `none` is the only answer of the four that needs evidence the caller may not
 * hold. A row that is enabled, or that carries a stored answer from step 47,
 * answers itself; a row that is none of those answers `none` only because the
 * fills were never consulted, and that is not the same statement as "the day
 * was quiet".
 *
 * It exists for Recalculate. A login carries no executions, so pressing it on a
 * close whose fills have not arrived, on a database where step 47's backfill
 * has not run, re-derived every row as `none` and wrote back the flags this
 * product just spent a commit removing: `Expected strategy missing` Critical on
 * real-money accounts that had traded all day, and `Strategy disabled` Warning
 * once per row on each of them. A positive answer never needs this; only a
 * negative one does.
 */
export function ranAnswerIsKnown(strategy, { closeHasFills = true } = {}) {
  if (closeHasFills) return true;
  if (storedRanBasis(strategy) || typeof strategy?.ran === 'boolean') return true;
  return strategy?.enabled === true;
}

/**
 * The ingest side: every row of a close answered against that close's own fills.
 *
 * Returns a new array, row for row, each carrying `ran` and `ranBasis`. Fills
 * are matched per ACCOUNT, by name, because a family running on one account of
 * a client says nothing about the same family on another.
 *
 * A close that carries NO fills at all leaves a row's existing stored answer
 * alone. An empty executions array is not evidence of a quiet day: the browser
 * loads orders and executions after the first screen, and Recalculate runs on
 * whatever it holds at the time. Without this, one Recalculate on a close whose
 * trade history had not arrived would rewrite every `fills` row to `none` and
 * flag the day as idle.
 *
 * `evidenceComplete` IS THE OTHER HALF OF THAT, FOR A ROW WITH NO STORED ANSWER.
 *
 * The guard above protects a row that already carries one. On a database where
 * step 47 has run and `call public.backfill_strategy_ran_all();` has not yet
 * finished, every row reads back `ran: null, ranBasis: ''`, so there is nothing
 * to protect and the rule ran with no fills — which on a close exported after
 * shutdown answers `none` for nearly every row. Pass `evidenceComplete: false`
 * (which recalculateDailyImport does for a close whose fills a login did not
 * carry) and such a row is left UNANSWERED rather than answered `none`. An
 * unanswered row reads as `none` to anything that asks, which is the product's
 * behaviour either way; what it does not do is let a caller mistake it for a
 * measurement. See ranAnswerIsKnown, and reconcile.js's four flags.
 */
export function withStrategyRan(strategies = [], executions = [], { evidenceComplete = true } = {}) {
  const byAccount = new Map();
  for (const execution of executions || []) {
    const name = lower(execution?.accountName);
    if (!name) continue;
    if (!byAccount.has(name)) byAccount.set(name, []);
    byAccount.get(name).push(execution);
  }
  const filledByAccount = new Map(
    [...byAccount.entries()].map(([name, rows]) => [name, familiesOnFills(rows)]),
  );
  const closeHasFills = (executions || []).length > 0;

  return (strategies || []).map((strategy) => {
    if (!closeHasFills && (storedRanBasis(strategy) || typeof strategy?.ran === 'boolean')) {
      const basis = ranBasisOf(strategy);
      return { ...strategy, ran: basis !== 'none', ranBasis: basis };
    }
    if (!closeHasFills && !evidenceComplete && !ranAnswerIsKnown(strategy, { closeHasFills: false })) {
      // No stored answer, not enabled, and the fills that could say otherwise
      // are not in this caller's hands. Left as it arrived.
      return { ...strategy, ran: strategy?.ran ?? null, ranBasis: strategy?.ranBasis || '' };
    }
    const basis = ranBasisFromEvidence(strategy, filledByAccount.get(lower(strategy?.accountName)));
    return { ...strategy, ran: basis !== 'none', ranBasis: basis };
  });
}
