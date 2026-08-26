// The algorithms that are not peers of the others, and where the boundary sits.
//
// WHAT THE CAM SAID, WHICH IS THE WHOLE OF THIS FILE. "They are different
// categories. Bullet Bot usually runs on a single account and should not be
// running in combination. The other algorithms can run however they like:
// combined, alone, on prop-firm accounts, on evaluation accounts, on cash
// accounts, on all of them. The only accounts that run Bullet Bot are evaluation
// accounts, because you cannot assign it wherever you want in NinjaTrader. But
// Bullet Bot is a strategy for PASSING EVALUATIONS, and it has different results
// from using a stack of ordinary algorithms."
//
// SO THE TWO THINGS ANSWER DIFFERENT QUESTIONS. Of a stack you ask what it
// MAKES. Of a programme you ask whether it PASSED. A dollar per account-day
// answers the first and is close to meaningless for the second: an evaluation
// bot that passes on day two by making a small amount has succeeded completely,
// and the same figure on a funded stack is a mediocre week. Ranking the two in
// one column ordered by that dollar is a category error, and it is the error
// this file exists to stop being made a fourth time.
//
// THE BOUNDARY IS THE ALGORITHM ITSELF — A NAMED FAMILY — AND NOT A THRESHOLD.
// Bullet Bot is alone on its account-day on nearly every one it has; the
// ordinary algorithms are mostly stacked. That is the SYMPTOM and it is not the
// rule. A solo-versus-stacked threshold would have to be stated as a number, and
// no number can be stated: on this book URGO runs alone on a third of its
// account-days and would sit in limbo under any line drawn between the two
// extremes, while an ordinary algorithm that happens to be the only thing
// enabled on an account is still an ordinary algorithm having an ordinary day.
// Membership is by name, it is listed here, and adding to it is a decision
// somebody makes on purpose rather than a side effect of a ratio moving.
//
// WHAT IS NOT IN THIS FILE. No measurement of any kind. The programme's own
// numbers — who passes, long or short, how fast — belong to
// bulletBotDeskStats.js and the panel it feeds, which were built for exactly
// that question. This file only says which names are programmes and why.

import { SEGMENTS } from './operationsSegments';

/**
 * The programmes, by family name.
 *
 * `family` is matched against the same family string the ranking rows carry
 * (strategyFamilyOf's output), so a version bump cannot take an algorithm out of
 * its own programme.
 *
 * `segment` is the account type the CAM's rule says it runs on, and the only
 * one. It is used by the operational finding that lists the accounts running the
 * programme on some other type — by his rule there should be none.
 */
export const PROGRAMMES = [
  {
    family: 'Bullet Bot',
    segment: SEGMENTS.EVAL_BULLET,
    asks: 'Did the account PASS — long or short, and how fast?',
    what: 'A programme for passing an evaluation, not a member of a stack. It is assigned to '
      + 'evaluation accounts and runs on its own, and the desk judges it on whether the account '
      + 'passed rather than on what it made per day.',
    answeredBy: 'Bullet Bot across the desk',
    answeredByNote: 'Passes against the account’s own target, long against short, which '
      + 'clients pass most, and how long an account takes to pass.',
  },
];

const BY_FAMILY = new Map(PROGRAMMES.map((entry) => [entry.family, entry]));

/** The programme a family belongs to, or null for an ordinary algorithm. */
export function programmeFor(family) {
  return BY_FAMILY.get(String(family || '')) || null;
}

/** Whether this family is a programme rather than a peer of OGX. */
export function isProgrammeFamily(family) {
  return BY_FAMILY.has(String(family || ''));
}

/**
 * Why the ranking does not hold the programmes, in the words the header prints.
 *
 * Deliberately says both halves: what the boundary IS (a named programme
 * answering a different question) and what it is NOT (a solo-versus-stacked
 * threshold). The second half is not padding — three passes at this problem
 * reached for the ratio, because the ratio is the thing you can see.
 */
export const PROGRAMME_BOUNDARY =
  'One algorithm on this book is not on this list. Bullet Bot is a PROGRAMME for passing an '
  + 'evaluation, and the question asked of it is whether the account passed — long or short, '
  + 'and how fast. The question asked of the algorithms below is what they made. A dollar per '
  + 'account-day answers the second and is close to meaningless for the first: an evaluation that '
  + 'passes on day two by making a small amount has succeeded completely, while the same figure on '
  + 'a funded stack is a mediocre week. The boundary is the ALGORITHM ITSELF being that programme '
  + '— a named family — and not how many algorithms shared the account-day. That the '
  + 'programme runs alone and the others are stacked is the SYMPTOM the desk noticed; the reason '
  + 'is the programme. Anything else that happens to run alone stays in the ranking, because the '
  + 'ordinary algorithms may run alone and that is ordinary.';

/** The reason a threshold was rejected, stated with the book's own counter-example. */
export function thresholdRefusal(topSoloOrdinary) {
  const example = topSoloOrdinary && topSoloOrdinary.soloShare != null
    ? `${topSoloOrdinary.name}, alone on ${topSoloOrdinary.soloShare}% of its account-days, `
      + 'would sit in limbo under any line drawn between the two ends of that range'
    : 'an ordinary algorithm running alone would have to be sorted by where it fell against the '
      + 'line, close by close';
  return 'A solo-versus-stacked threshold is the rule that suggests itself, and it cannot be '
    + `stated: ${example}, and a rule nobody can say out loud `
    + 'is a rule that gets applied differently every time somebody re-reads it. Membership is by '
    + 'name and the list is in algorithmProgrammes.js, so adding to it is a decision somebody '
    + 'makes rather than a ratio moving.';
}
