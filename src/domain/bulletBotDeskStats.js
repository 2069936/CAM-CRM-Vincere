// Desk-level Bullet Bot statistics: how the algo is doing across every client,
// by direction, by client, and how long a pass actually takes.
//
// This module exists because the per-client Bullet Bot card answers a different
// question than a manager asks, and three of its numbers are wrong in a way that
// reads as right:
//
//   - "fired" there means "the account traded", not "the account blew up". The
//     real book has 147 fired and 29 status='Failed', and 13 accounts are
//     counted as fired AND passed. Here the two concepts are named `traded` and
//     `failed` and never share a column.
//   - 87 of its 236 records carry no profit target, so they cannot satisfy
//     `balance >= target` at any price, yet they sit in the pass-rate
//     denominator as though they had failed. That is the "0 is a claim" failure:
//     a targetless account is unknown, not failed. Excluding them takes the real
//     pass rate from 9.3% to 14.8%; inferring the standard 53,000 target for the
//     86 accounts whose first balance is within ±20% of 50,000 takes the
//     scorable cohort from 149 to 235 of 240.
//   - long + short is not the book. 60 records have no derivable direction and
//     hold 7 of the 22 passes, so the two cards a manager compares silently drop
//     a quarter of the desk. Unknown and Ambiguous are first-class buckets here.
//
// Everything is derived from `trading_accounts` (status, target) plus the
// snapshot history (balances, strategy direction, executions). The Bullet Bot
// evaluation columns are not usable: bullet_bot_direction is populated on 11 of
// 244 and disagrees with the strategy rows on 2 of those; bullet_bot_pass_type
// on 22 of 244 across four spellings of three concepts ("2-day pass" and
// "2 Day Pass" are the same thing typed twice); date_funded, date_last_payout
// and payout_count are empty on all 244, and payout_events holds 11 rows of
// which 0 belong to a Bullet Bot account.

import { buildBulletBotAccountRecords } from './bulletBotStats';
import { ACCOUNT_STATUSES } from './reconcile';

/**
 * Why there is no streak in this module, and no `streaks` value other than null.
 *
 * A streak needs a terminal outcome per account and an order over those outcomes
 * per client. Neither exists on this book:
 *
 *   - Order. date_failed is populated on 1 of 244 accounts, date_funded on 0, and
 *     payout_events contains 0 Bullet Bot rows, so no outcome carries its own
 *     event date. date_added is on all 244 but holds only 14 distinct values
 *     (77 accounts share 2026-07-13, 88 share 2026-07-15), and 41 of the 43
 *     clients with more than one Bullet Bot account have duplicate date_added
 *     values — for 95% of the clients a streak would describe, the ordering is
 *     ambiguous by construction. activity_logs adds nothing: 512 rows attach to
 *     Bullet Bot accounts, 511 of type Alert, 0 whose text mentions a pass or a
 *     failure.
 *   - Cohort. Only 7 clients hold 2 or more accounts with a determinate Failed
 *     status, the largest run of failures any client could possibly have is 5,
 *     and the largest number of passes is 4.
 *
 * Sorting by date_added and calling the result "3 passes in a row" would be
 * inventing the order, which is the one thing a manager would act on. The
 * unordered per-client tally in `ranking` is the honest ceiling of this data.
 */
export const STREAKS_UNAVAILABLE =
  'Not derivable. A streak needs each outcome to carry a date, and none does: '
  + 'date_failed is set on 1 of 244 accounts, date_funded on 0, and there are no '
  + 'Bullet Bot payout events. date_added has only 14 distinct values across 244 '
  + 'accounts, so 41 of the 43 multi-account clients cannot be ordered at all. '
  + 'The per-client tallies below are counts, not sequences.';

function normalizeDirectionValue(value) {
  const v = String(value || '').toLowerCase();
  if (v.startsWith('long')) return 'Long';
  if (v.startsWith('short')) return 'Short';
  return null;
}

/**
 * The direction the account actually ran.
 *
 * strategy_snapshots wins over the bullet_bot_direction column: the column is
 * set on 11 of 244 accounts and contradicts the strategy rows on 2 of them. On
 * the real book the column fallback recovers 0 accounts — every account that has
 * the column also has strategy rows — but it stays because it costs nothing and
 * the column is the field ops edits by hand.
 *
 * 'Ambiguous' is not a rounding of 'Both'. 7 accounts carry Long rows on some
 * days and Short rows on others; picking the first one seen (what the per-client
 * card does) reports a coin flip as a fact.
 */
export function resolveDirection(record) {
  const seen = record.directionsSeen || [];
  if (seen.length > 1) return 'Ambiguous';
  if (seen.length === 1) return seen[0];
  const column = normalizeDirectionValue(record.directionColumn);
  return column || 'Unknown';
}

/**
 * One outcome per account, in precedence order.
 *
 * 'passed' beats 'failed' because reaching the target is an observed balance
 * event while Failed is a hand-set status; exactly 1 account on the real book is
 * both, and it is reported as `conflicts` rather than absorbed silently.
 *
 * 'unscorable' is the point of this function. An account with no target and no
 * Failed status cannot be called a pass or a fail — 5 accounts on the real book
 * are in that state (95 before target inference). Counting them as non-passes is
 * a claim the data does not support.
 */
export function classifyOutcome(record) {
  if (record.passed) return 'passed';
  if (record.status === ACCOUNT_STATUSES.FAILED) return 'failed';
  if (!(Number(record.target) > 0)) return 'unscorable';
  if (record.status === ACCOUNT_STATUSES.RESERVE) return 'reserve';
  return 'running';
}

function emptyBucket() {
  return {
    accounts: 0,
    passed: 0,
    // Of `passed`: crossed the target on a day we were watching, versus already
    // sitting above it the first time the account appeared. See the selection
    // effect documented on buildBulletBotDeskStats — the split is not cosmetic.
    passedObserved: 0,
    passedCensored: 0,
    failed: 0,
    running: 0,
    reserve: 0,
    unscorable: 0,
    traded: 0,
    scorable: 0,
    passRate: null,
  };
}

function addToBucket(bucket, record) {
  bucket.accounts += 1;
  bucket[record.outcome] += 1;
  if (record.outcome === 'passed') {
    if (record.censored) bucket.passedCensored += 1;
    else bucket.passedObserved += 1;
  }
  if (record.fired) bucket.traded += 1;
}

/**
 * Pass rate over the accounts that can be scored at all.
 *
 * Denominator = passed + failed + running + reserve, i.e. everything except the
 * accounts with no target. It is a floor, never a final rate: 178 of the 235
 * scorable accounts are still open, so the number can only rise. The UI has to
 * show the denominator next to it for that reason.
 *
 * Below `minCohort` the rate is null rather than a number. 2 of 2 is not a 100%
 * pass rate, it is two accounts.
 */
function finishBucket(bucket, minCohort) {
  bucket.scorable = bucket.passed + bucket.failed + bucket.running + bucket.reserve;
  bucket.passRate = bucket.scorable >= minCohort ? bucket.passed / bucket.scorable : null;
  return bucket;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

/**
 * Days from first sighting to the first balance at or above target.
 *
 * Not date_funded − date_added: date_funded is empty on all 244 Bullet Bot
 * accounts, so the metric as originally specified does not exist. And not
 * date_added either — it is a bulk backfill (14 distinct values), which put 4 of
 * the 22 passes at a negative duration, i.e. crossing the target before the
 * account was supposedly added.
 *
 * The left-censored passes are dropped, not zeroed: 19 accounts were already at
 * or above target on the first day they appear in an import, so all we know is
 * "≤ the age of our data". Averaging their zeros in is what makes the existing
 * card report an overall mean (5.36d) lower than both of its own halves (6.0d
 * and 8.33d).
 *
 * Median, not mean: the surviving sample runs 1..15 days and a mean over that
 * tail reads as a typical case that no account actually had.
 */
function buildDaysToPass(records, minSample) {
  const censored = records.filter((r) => r.passed && r.censored).length;
  const days = records
    .filter((r) => r.passed && !r.censored && r.daysToPass != null)
    .map((r) => r.daysToPass)
    .sort((a, b) => a - b);

  if (days.length < minSample) {
    return { value: null, n: days.length, censored };
  }

  const counts = new Map();
  for (const d of days) counts.set(d, (counts.get(d) || 0) + 1);

  return {
    value: {
      n: days.length,
      median: median(days),
      min: days[0],
      max: days[days.length - 1],
      // Quartiles need enough points to mean anything; under 8 observations the
      // IQR is two data points wearing a statistic's name.
      iqr: days.length >= 8 ? [quantile(days, 0.25), quantile(days, 0.75)] : null,
      censored,
      distribution: [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([days_, accounts]) => ({ days: days_, accounts })),
    },
    n: days.length,
    censored,
  };
}

/**
 * Per-client tally, ranked by count and carrying its own rate.
 *
 * Count and rate are both required and neither is sufficient: 4 passes out of 8
 * scorable accounts and 4 out of 40 are the same rank on count and completely
 * different facts. The rate is null below `minClientCohort` — the largest Bullet
 * Bot client holds 12 accounts and 13 clients hold exactly one pass, so a
 * percentage on a two-account client is noise with a decimal point.
 */
function buildClientRows(records, minClientCohort) {
  const byClient = new Map();
  for (const record of records) {
    if (!byClient.has(record.clientId)) {
      byClient.set(record.clientId, {
        clientId: record.clientId,
        clientName: record.clientName || record.clientId,
        ...emptyBucket(),
      });
    }
    addToBucket(byClient.get(record.clientId), record);
  }

  return [...byClient.values()].map((row) => {
    finishBucket(row, minClientCohort);
    return {
      ...row,
      failRate: row.scorable >= minClientCohort ? row.failed / row.scorable : null,
    };
  });
}

function rankBy(rows, field, rateField) {
  return rows
    .filter((row) => row[field] > 0)
    .sort((a, b) => b[field] - a[field]
      || (b[rateField] ?? -1) - (a[rateField] ?? -1)
      || b.scorable - a.scorable
      || String(a.clientName).localeCompare(String(b.clientName)));
}

/**
 * Desk-level Bullet Bot statistics.
 *
 * Composes buildBulletBotAccountRecords (the shared snapshot walk) rather than
 * re-deriving passes, and opts into target inference and the 4 accounts that
 * have a status but no snapshot row. buildBulletBotStats keeps its old defaults
 * and its old numbers, so StackPlaybook is unaffected.
 *
 * THE SELECTION EFFECT THAT MAKES Long-vs-Short A COMPARISON, NOT A RANKING.
 * The direction-unknown bucket comes out with the best pass rate on this book —
 * 15 passes in 60 scorable accounts, 25%, against 6.7% Long and 17.2% Short —
 * and every single one of those 15 passes is left-censored: the account was
 * already sitting just above 53,000 the first day it appeared (53,076 / 53,082
 * ×4 / 53,228 / 53,362 …), on 1 observed day for most of them, and 14 of the 15
 * never traded inside the window. The direction is unknown *because* the account
 * had already passed and its strategy rows were gone before we started looking.
 * So passes that happened before the observation window systematically leave the
 * Long and Short buckets and pile into Unknown. Long vs Short is therefore a
 * comparison of what happened during 2026-06-25..2026-07-30 only, which is why
 * every bucket carries passedObserved and passedCensored separately and the
 * panel prints the unattributed count next to the two cards.
 */
export function buildBulletBotDeskStats(clients = [], {
  minDirectionCohort = 5,
  minClientCohort = 5,
  minDaysSample = 5,
  inferTargets = true,
} = {}) {
  const records = buildBulletBotAccountRecords(clients, {
    inferTargets,
    includeUnobserved: true,
  }).map((record) => {
    const enriched = { ...record, resolvedDirection: resolveDirection(record) };
    enriched.outcome = classifyOutcome(enriched);
    return enriched;
  });

  const buckets = {
    long: { label: 'Long', ...emptyBucket() },
    short: { label: 'Short', ...emptyBucket() },
    unknown: { label: 'Direction unknown', ...emptyBucket() },
    ambiguous: { label: 'Long and Short', ...emptyBucket() },
    overall: { label: 'Desk', ...emptyBucket() },
  };
  // 'Both' is a value NinjaTrader really writes in strategy_snapshots.direction —
  // 60 rows on Bullet Bot accounts carry it, all of them from other families
  // (G4M, OGX, IFSP, B2X, URGO, DJDR, SYFY, ARPD). No Bullet-Bot-family row in
  // the 3,805-row table carries it today, so resolveDirection never returns it
  // on the current book. One such row in a future import would, and an
  // unmapped key made buckets[undefined] reach addToBucket and threw, taking the
  // whole panel down rather than mislabelling one account.
  //
  // It maps to 'ambiguous' because that bucket already means "not one direction",
  // which is what the value says. The fallback below is the second line: any
  // direction string this map has not seen lands in 'unknown', where an
  // unclassifiable account belongs, instead of crashing.
  const bucketKey = {
    Long: 'long', Short: 'short', Ambiguous: 'ambiguous', Unknown: 'unknown', Both: 'ambiguous',
  };

  for (const record of records) {
    addToBucket(buckets[bucketKey[record.resolvedDirection] || 'unknown'], record);
    addToBucket(buckets.overall, record);
  }
  for (const bucket of Object.values(buckets)) finishBucket(bucket, minDirectionCohort);

  const clientRows = buildClientRows(records, minClientCohort);
  const days = buildDaysToPass(records, minDaysSample);

  const unavailable = { streaks: STREAKS_UNAVAILABLE };
  if (!days.value) {
    unavailable.daysToPass = `Only ${days.n} account${days.n === 1 ? '' : 's'} reached target on a day after we first saw it`
      + `${days.censored ? ` (${days.censored} more were already at target the first day, so their duration is unknown)` : ''}`
      + `. Below ${minDaysSample} observations there is no median worth printing.`;
  }

  return {
    cohort: {
      accounts: records.length,
      clients: clientRows.length,
      observed: records.filter((r) => r.observedDays > 0).length,
      // No snapshot row at all — they still carry a status, so they count in the
      // failure numbers but can never be scored on balance.
      unobserved: records.filter((r) => r.observedDays === 0).length,
      scorable: buckets.overall.scorable,
      unscorable: buckets.overall.unscorable,
      inferredTargets: records.filter((r) => r.targetSource === 'inferred').length,
      // Passes that no direction can claim: the strategy rows were already gone
      // when the account first appeared. 16 of 37 on the real book, so a Long vs
      // Short read of the pass counts is missing 43% of the passes.
      unattributedPasses: buckets.unknown.passed + buckets.ambiguous.passed,
      // Reached target and is also flagged Failed. Counted as a pass; surfaced
      // so the two sources disagreeing stays visible instead of being rounded
      // away inside a precedence rule.
      conflicts: records.filter((r) => r.passed && r.status === ACCOUNT_STATUSES.FAILED).length,
      minDirectionCohort,
      minClientCohort,
    },
    direction: buckets,
    ranking: {
      byPasses: rankBy(clientRows, 'passed', 'passRate'),
      byFailures: rankBy(clientRows, 'failed', 'failRate'),
      minClientCohort,
    },
    // See STREAKS_UNAVAILABLE. Null is the answer, not a placeholder.
    streaks: null,
    daysToPass: days.value,
    accounts: records,
    unavailable,
  };
}
