// What the two units of `trading_accounts.target_profit` were worth on the real
// book, and what the one unit is worth now.
//
// The rules half of this is src/domain/targetProfitUnit.test.jsx, which ties each
// writer to each reader and runs on every clone. This half reads
// public/local-snapshot.json and is therefore dropped by CI, so nothing here is a
// guard — it is the measurement, kept runnable so the numbers in
// accountTargets.js and in propFirmRules.resolveAccountLimits stay checkable
// instead of ageing into folklore.
//
// Counts and bucket edges only. No individual client value is asserted or
// printed; the one figure that looks like a value, 52,999, is the minimum of a
// 195-row distribution and is the whole point of the first assertion.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import {
  resolveAccountLimits,
  firstObservedBalance,
  inferAccountSize,
  genericProfitTarget,
  normalizePropFirm,
  ruleFor,
} from './propFirmRules';
import { ACCOUNT_TYPES } from './reconcile';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

const pos = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const EVAL_TYPES = [ACCOUNT_TYPES.EVALUATION_BULLET, ACCOUNT_TYPES.EVALUATION_STANDARD];

/** Every account row the CRM holds, with its latest close and its client's history. */
const rows = clients.flatMap((client) => {
  const imports = client.dailyImports || [];
  return Object.entries(client.accountRegistry || {}).map(([accountName, meta]) => {
    let balance = null;
    for (let i = imports.length - 1; i >= 0 && balance == null; i -= 1) {
      const snap = (imports[i].snapshots || []).find(
        (entry) => String(entry.accountName).toLowerCase() === String(accountName).toLowerCase(),
      );
      const value = Number(snap?.accountBalance);
      if (Number.isFinite(value)) balance = value;
    }
    return { accountName, meta, imports, balance };
  });
});

const limitsFor = (row) => resolveAccountLimits(
  { ...row.meta, accountName: row.accountName },
  { dailyImports: row.imports },
);

/** The account's own opening size, as near as the book can say. */
const anchorFor = (row) => pos(row.meta.startBalance)
  ?? pos(firstObservedBalance(row.accountName, row.imports))
  ?? pos(row.balance);

/**
 * What `resolveAccountLimits().targetProfit` returned before this change, for a
 * row with nothing stored: the firm's published profit AMOUNT, or the generic
 * one. Reconstructed here rather than asserted against a saved number, because
 * the field it came from no longer exists — see resolveAccountLimits.
 */
const oldDerivedValue = (row) => {
  const start = pos(row.meta.startBalance) ?? pos(firstObservedBalance(row.accountName, row.imports));
  const size = inferAccountSize(start);
  const rule = ruleFor(
    normalizePropFirm(row.meta.connection),
    size,
    String(row.meta.propFirmPlan || '').trim() || null,
  );
  return pos(rule?.profitTarget ?? genericProfitTarget(size));
};

describe('the stored column is uniformly balances, which is why balance won', () => {
  it('holds a target on 312 of 685 accounts', () => {
    expect(rows).toHaveLength(685);
    expect(rows.filter((row) => pos(row.meta.targetProfit))).toHaveLength(312);
  });

  it('stores a balance on all 195 evaluation rows that carry one, the smallest 52,999', () => {
    const stored = rows
      .filter((row) => EVAL_TYPES.includes(row.meta.accountType))
      .map((row) => pos(row.meta.targetProfit))
      .filter((value) => value != null);

    expect(stored).toHaveLength(195);
    expect(stored.filter((value) => value >= 40000)).toHaveLength(195);
    expect(Math.min(...stored)).toBe(52999);
  });

  it('sits above the account’s own start on 302 of the 312, and below it on 9', () => {
    const anchored = rows.filter((row) => pos(row.meta.targetProfit) && anchorFor(row) != null);
    expect(anchored).toHaveLength(311);
    expect(anchored.filter((row) => pos(row.meta.targetProfit) >= anchorFor(row))).toHaveLength(302);
    expect(anchored.filter((row) => pos(row.meta.targetProfit) < anchorFor(row))).toHaveLength(9);
  });
});

describe('no production row needs converting, which is why no migration ships', () => {
  it('finds not one stored value equal to a published amount for its own size', () => {
    // The migration question. An amount-unit write would have been exactly
    // `rule.profitTarget` or `genericProfitTarget(size)`. If any stored value
    // matched one of those AND sat below its start, a migration would be needed
    // and this count would be non-zero.
    const convertible = rows.filter((row) => {
      const stored = pos(row.meta.targetProfit);
      const anchor = anchorFor(row);
      if (stored == null || anchor == null || stored >= anchor) return false;
      const size = inferAccountSize(anchor);
      const rule = ruleFor(
        normalizePropFirm(row.meta.connection),
        size,
        String(row.meta.propFirmPlan || '').trim() || null,
      );
      const amounts = [rule?.profitTarget, size != null ? genericProfitTarget(size) : null]
        .filter((value) => value != null);
      return amounts.includes(stored);
    });

    expect(convertible).toHaveLength(0);
  });

  it('leaves the 9 below-start values alone, because none of them is an amount either', () => {
    // A separate and still-open defect, and the measurement says what kind.
    // Eight of the nine are 40,000 or more and none is under 10,000 — they are
    // balance-shaped, not amount-shaped: a target stated for one account size
    // sitting on an account that opened larger. Not one of them has a stored
    // start balance, so what they are "below" is their earliest close on record.
    //
    // A migration that scaled them up would be inventing the number it claimed
    // to recover, so they are reported and left.
    const belowStart = rows.filter((row) => {
      const stored = pos(row.meta.targetProfit);
      const anchor = anchorFor(row);
      return stored != null && anchor != null && stored < anchor;
    });

    expect(belowStart).toHaveLength(9);
    expect(belowStart.filter((row) => pos(row.meta.targetProfit) >= 40000)).toHaveLength(8);
    expect(belowStart.filter((row) => pos(row.meta.targetProfit) < 10000)).toHaveLength(0);
    expect(belowStart.filter((row) => pos(row.meta.startBalance) != null)).toHaveLength(0);
    // Mostly evaluations, which is where the 50k Bullet Bot target lives.
    expect(belowStart.filter((row) => EVAL_TYPES.includes(row.meta.accountType))).toHaveLength(8);
  });
});

describe('what the amount-unit reading was worth', () => {
  const evaluations = rows.filter((row) => EVAL_TYPES.includes(row.meta.accountType));

  it('would have flipped 94 of 296 evaluations to finished, against the 21 that are', () => {
    expect(evaluations).toHaveLength(296);

    const unstored = evaluations.filter((row) => pos(row.meta.targetProfit) == null);
    expect(unstored).toHaveLength(101);

    const derived = unstored
      .map((row) => ({ row, value: oldDerivedValue(row) }))
      .filter((entry) => entry.value != null);
    expect(derived).toHaveLength(94);

    // Every one of them an amount, and every one already cleared.
    expect(derived.filter((entry) => entry.value < 10000)).toHaveLength(94);
    expect(derived.filter((entry) => entry.row.balance >= entry.value)).toHaveLength(94);

    const reallyDone = evaluations.filter((row) => {
      const stored = pos(row.meta.targetProfit);
      return stored != null && row.balance != null && row.balance >= stored;
    });
    expect(reallyDone).toHaveLength(21);

    // 31.8% of the evaluation book, declared passed by a unit mismatch.
    expect(Math.round((derived.length / evaluations.length) * 1000) / 10).toBe(31.8);
  });

  it('is gone: no DERIVED target lands below its start for a reason about units', () => {
    // The fix, measured. 606 of the 685 rows resolve to a target with a start to
    // judge it against, and 43 of those targets sit below that start. Every one
    // has a cause that is not the unit:
    //
    //   9 are stored values that were already below their account's own start
    //     before this change — the separate, still-open defect above.
    //  34 are derived, and in all 34 the start is ABOVE the nominal size the
    //     target was stated against: inferAccountSize snapped a drifted opening
    //     close down to the next standard size, so a 56k first close resolves a
    //     50k target. That is the documented limit of inferring size from a
    //     balance, and it is why `targetProfitAmount` refuses a number here
    //     rather than printing one.
    //
    // Under the old amount unit all 606 would have been below their start, which
    // is the whole defect.
    const resolved = rows
      .map((row) => {
        const limits = limitsFor(row);
        return { row, target: pos(limits.targetBalance), source: limits.targetSource, anchor: anchorFor(row) };
      })
      .filter((entry) => entry.target != null && entry.anchor != null);

    expect(resolved).toHaveLength(606);
    const below = resolved.filter((entry) => entry.target < entry.anchor);
    expect(below).toHaveLength(43);
    expect(below.filter((entry) => entry.source === 'stored')).toHaveLength(9);

    const derivedBelow = below.filter((entry) => entry.source !== 'stored');
    expect(derivedBelow).toHaveLength(34);
    for (const entry of derivedBelow) {
      const start = pos(entry.row.meta.startBalance)
        ?? pos(firstObservedBalance(entry.row.accountName, entry.row.imports));
      const size = inferAccountSize(start);
      expect(size).not.toBeNull();
      expect(entry.anchor).toBeGreaterThan(size);
    }
  });

  it('gives the two percentage readers an amount, never the balance', () => {
    // buildCamFundedRows and ManagerOverview divide a weekly PnL by this. On the
    // book's funded rows the figure came out at a median of 1/13 of the real one.
    const withTarget = rows.filter((row) => pos(row.meta.targetProfit) && anchorFor(row) != null);
    expect(withTarget).toHaveLength(311);

    const pairs = withTarget
      .map((row) => {
        const limits = limitsFor(row);
        return { amount: pos(limits.targetProfitAmount), target: pos(limits.targetBalance) };
      })
      .filter((entry) => entry.amount != null);

    expect(pairs).toHaveLength(302);
    // The invariant that makes it an amount: strictly less than the balance it
    // was measured back from, on every row.
    expect(pairs.filter((entry) => entry.amount < entry.target)).toHaveLength(302);
    expect(pairs.filter((entry) => entry.amount < 10000)).toHaveLength(298);
    // Four rows carry an implausibly large amount, two of them over 40,000,
    // because their earliest close on record is a near-empty account and the
    // target is a full-size one. The unit is right and the start is junk; both
    // print ~0% either way, so this change neither causes nor fixes them.
    expect(pairs.filter((entry) => entry.amount >= 40000)).toHaveLength(2);
  });
});
