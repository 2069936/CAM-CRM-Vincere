// Does the redacted book still join to itself?
//
// scripts/redact-export.mjs already asks "did any identity get OUT". This asks
// the opposite question, which nothing asked before and which a whole export
// failed silently: is what is left still able to answer anything.
//
// WHY THIS EXISTS, WITH THE PRICE ON IT. The redactor's ID_FIELDS list shipped
// without `external_order_id`. That is not one id among many — it is the join
// key of the entire fill pipeline: supabaseStore rehydrates `orderId:
// row.external_order_id` onto every execution and `id: row.external_order_id`
// onto every order, and deriveStrategyPnl reads each leg's Strategy through
// exactly that join. Missing from the list, it fell through to the generic
// `[redacted N]` marker, which keeps only a string's LENGTH — so 30,955 order
// ids became four distinct values and every leg of an account-day resolved to
// one arbitrary order.
//
// Measured on the 2026-08-20 redacted book (29 trading dates, 14,958 fills),
// replaying the shipped derivation per strategy against
// strategy_snapshots.realized:
//
//   join key                        agree  disagree  |$| disagreement  wrong on 'exact'
//   collapsed (what shipped)          511       185       77,876.25    54 / $22,899.25
//   1:1 token (ID_FIELDS, fixed)    1,052        11        2,814.25     0 /      $0.00
//
// Nothing in the derivation changed between those two rows. A book with merged
// join keys is not a censored book, it is a WRONG one: every row present, every
// number real, and the wrong algo credited with the money. It reads as intact,
// which is why three separate investigations of "the derivation is broken" were
// all measuring the redactor.
//
// THE INVARIANT IS ONE LINE. Redaction may rename an identifier; it may never
// merge two of them. Everything below is that sentence, counted.

/**
 * The columns a replay of the fill pipeline has to be able to join on.
 *
 * Keep this list next to the reason each entry is on it, because the failure
 * mode is silent and the next id column will be added by someone who has not
 * read this file.
 */
export const JOIN_KEYS = [
  // executions -> orders. deriveStrategyPnl's strategyOf()/nameOf() resolve
  // every leg through this and nothing else.
  ['executions', 'external_order_id'],
  ['orders', 'external_order_id'],
  // orderExecutions' preferred ordering basis (rule 1). See ORDERABILITY below.
  ['executions', 'external_execution_id'],
];

const distinctValues = (rows, field) => {
  const values = new Set();
  for (const row of rows || []) {
    const value = row?.[field];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    values.add(String(value));
  }
  return values;
};

/**
 * What fraction of fills can still find their order.
 *
 * Distinctness alone does not prove the two sides still MEET. A rule that
 * tokenised executions and orders by different recipes would preserve every
 * count on both sides and join nothing at all, so the rate is checked too.
 * Returns null when there is nothing to join, which is not a failure.
 */
function resolveRate(tables) {
  const orderIds = distinctValues(tables?.orders, 'external_order_id');
  const fills = (tables?.executions || []).filter((row) => String(row?.external_order_id ?? '').trim());
  if (!fills.length) return null;
  return fills.filter((row) => orderIds.has(String(row.external_order_id))).length / fills.length;
}

/**
 * What the redacted book can still join, in one line an operator can read.
 *
 * The check has to SAY it ran. A guard whose only output is silence on success
 * is a guard nobody notices the removal of, and this one exists because a
 * silent failure shipped.
 */
export function summarizeJoins(tables = {}) {
  const fills = (tables?.executions || []).filter((row) => String(row?.external_order_id ?? '').trim());
  const rate = resolveRate(tables);
  return {
    orderIds: distinctValues(tables?.orders, 'external_order_id').size,
    executionIds: distinctValues(tables?.executions, 'external_execution_id').size,
    fills: fills.length,
    resolved: rate == null ? 0 : Math.round(rate * fills.length),
  };
}

/**
 * Every way redaction merged a join, named. Empty array means the book is still
 * joinable and may be written.
 *
 * ORDERABILITY IS NOT CHECKED HERE, BECAUSE IT IS NOT PRESERVED, AND THAT IS THE
 * ONE THING A REDACTED BOOK STILL CANNOT ANSWER. NinjaTrader execution ids are
 * "<seq>_<n>" or a bare monotonic integer, and deriveStrategyPnl orders by them
 * when it can. The redactor's token() emits "x<14 hex>", which matches neither
 * shape, so `orderExecutions` falls back to the TIME basis on every account of
 * any redacted book — measured at 2,819 of 2,832 traded account-days on the
 * 2026-08-20 book, with the remaining 13 on fileOrder. An ordering question
 * asked of a redacted book is therefore answered about the time basis plus the
 * Position-column repair, never about the shipped executionId basis. Say which
 * one you measured.
 */
export function collapsedJoins(source = {}, redacted = {}) {
  const failures = [];
  for (const [table, field] of JOIN_KEYS) {
    if (!Array.isArray(source?.[table]) || !source[table].length) continue;
    const before = distinctValues(source[table], field);
    const after = distinctValues(redacted?.[table], field);
    if (after.size < before.size) {
      failures.push(`${table}.${field}: ${before.size} distinct values collapsed to ${after.size}`);
    }
  }

  const before = resolveRate(source);
  const after = resolveRate(redacted);
  if (before != null && after != null && after < before - 1e-9) {
    failures.push(`executions -> orders on external_order_id: ${(before * 100).toFixed(1)}% of fills found their order before redaction, ${(after * 100).toFixed(1)}% after`);
  }

  return failures;
}
