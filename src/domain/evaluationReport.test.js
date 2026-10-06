// The rules of the evaluations block, on fixtures.
//
// The NUMBERS live in evaluationReport.book.test.js, which reads the export and
// is dropped on any clone that does not hold it. These are the RULES, and they
// run everywhere, because every one of them is a case that is one or two rows on
// the real book and would not move a single headline figure if it broke.
//
// The one asserted hardest is the unit confusion, because it is the only defect
// here that would be silent, plausible and wrong on a third of the book: the
// stored `targetProfit` is an absolute target BALANCE, while
// `resolveAccountLimits().targetProfit` used to fall back to a profit AMOUNT. A
// comparison against the wrong one declared a third of the evaluation book
// finished and looked exactly like the comparison two other modules already
// make. That field is gone (targetBalance and targetProfitAmount replaced it),
// and the test below keeps it gone.

import { describe, expect, it } from 'vitest';
import {
  EVALUATION_PROGRESS,
  buildEvaluationSection,
  evaluationProgressFor,
  evaluationTargetFor,
  isEvaluationType,
} from './evaluationReport';
import { ACCOUNT_TYPES } from './reconcile';
import { resolveAccountLimits } from './propFirmRules';

const row = (over = {}) => ({
  accountName: 'ROME7045',
  connection: 'Legends',
  accountBalance: 51000,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  trailingMaxDrawdown: 0,
  strategies: [],
  meta: { accountName: 'ROME7045', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD },
  ...over,
});

const section = (rows, over = {}) => buildEvaluationSection(
  {
    accountRegistry: Object.fromEntries(rows.map((r) => [r.accountName, r.meta])),
    dailyImports: [],
    ...over.client,
  },
  { accounts: {}, ...over.dailyImport },
  { rows, totals: { grossRealizedPnl: 0, weeklyPnl: 0, aggregateBalance: 0 }, reportedAccountCount: rows.length },
);

describe('what counts as an evaluation', () => {
  it('is both evaluation types and nothing else', () => {
    expect(isEvaluationType(ACCOUNT_TYPES.EVALUATION_BULLET)).toBe(true);
    expect(isEvaluationType(ACCOUNT_TYPES.EVALUATION_STANDARD)).toBe(true);
    expect(isEvaluationType(ACCOUNT_TYPES.FUNDED)).toBe(false);
    expect(isEvaluationType(ACCOUNT_TYPES.SIMULATION)).toBe(false);
    expect(isEvaluationType(ACCOUNT_TYPES.CASH_IRA)).toBe(false);
    expect(isEvaluationType(undefined)).toBe(false);
  });
});

describe('the target is a BALANCE, never a profit amount', () => {
  it('uses the stored target_profit, which is an absolute balance', () => {
    expect(evaluationTargetFor({ accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, targetProfit: 54100 }, 50000))
      .toEqual({ target: 54100, source: 'stored' });
  });

  it('falls back to the standard target for the type and size, also a balance', () => {
    // The same table suggestAccountDefaults pre-fills from, so a derived figure
    // here can never disagree with the one a CAM would have been offered.
    expect(evaluationTargetFor({ accountType: ACCOUNT_TYPES.EVALUATION_STANDARD }, 50000))
      .toEqual({ target: 54100, source: 'inferred' });
    // A Bullet Bot evaluation passes at a lower target and accountTargets knows it.
    expect(evaluationTargetFor({ accountType: ACCOUNT_TYPES.EVALUATION_BULLET }, 50000))
      .toEqual({ target: 53000, source: 'inferred' });
  });

  it('the resolver no longer offers a profit amount under the target\'s name', () => {
    /* THE TRAP, pinned so it cannot come back.
     *
     * resolveAccountLimits is the function that looks like the right
     * abstraction. It used to return, with nothing stored, `rule.profitTarget`
     * (3,000 on a Legends 50k) in a field named `targetProfit`, the same name the
     * stored absolute balance uses, and a balance of 51,000 read as finished
     * against it. The field is gone: the resolver now answers with
     * `targetBalance`, in the stored column's unit, and `targetProfitAmount`, the
     * profit still to be made. */
    const account = { accountName: 'ROME7045', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, connection: 'Legends', startBalance: 50000 };
    const limits = resolveAccountLimits(account, { dailyImports: [] });
    expect(limits.targetSource).toBe('firm-rule');
    expect(limits).not.toHaveProperty('targetProfit');
    // A balance of 51,000 is 1,000 into the challenge, whichever table it is
    // measured against, and the resolver's number no longer calls it finished.
    expect(limits.targetBalance).toBeGreaterThan(51000);
    expect(51000 >= limits.targetBalance).toBe(false);
    expect(limits.targetProfitAmount).toBe(limits.targetBalance - 50000);
    // The section itself still reads the standard table, not the resolver's
    // tightest rule guess, and calls the account on its way.
    const progress = evaluationProgressFor(row({ meta: account }), []);
    expect(progress.target).toBe(54100);
    expect(progress.state).toBe(EVALUATION_PROGRESS.BELOW);
    expect(progress.percent).toBe(24);
  });
});

describe('progress toward the target', () => {
  it('measures from the stored starting balance when there is one', () => {
    const progress = evaluationProgressFor(
      row({ accountBalance: 52050, meta: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 50000, targetProfit: 54100 } }),
      [],
    );
    expect(progress).toMatchObject({
      state: EVALUATION_PROGRESS.BELOW, percent: 50, start: 50000, startSource: 'stored', targetSource: 'stored',
    });
  });

  it('takes the start from the earliest close on record when none is stored', () => {
    // The fallback that moves start coverage from 129 of 289 accounts to all 289.
    const dailyImports = [
      { date: '2026-07-01', snapshots: [{ accountName: 'ROME7045', accountBalance: 50000 }] },
      { date: '2026-07-30', snapshots: [{ accountName: 'ROME7045', accountBalance: 52050 }] },
    ];
    const progress = evaluationProgressFor(
      row({ accountBalance: 52050, meta: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, targetProfit: 54100 } }),
      dailyImports,
    );
    expect(progress).toMatchObject({ state: EVALUATION_PROGRESS.BELOW, percent: 50, start: 50000, startSource: 'observed' });
  });

  it('says the balance reached the target rather than that the account passed', () => {
    const progress = evaluationProgressFor(
      row({ accountBalance: 54200, meta: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 50000, targetProfit: 54100 } }),
      [],
    );
    expect(progress.state).toBe(EVALUATION_PROGRESS.REACHED);
  });

  it('refuses a percentage when the recorded target is not above the start', () => {
    /* 18 of the book's 289 evaluation accounts. Neither 0% nor 100% is true of an
     * account that is "there" the day it opens, so neither is printed. */
    const progress = evaluationProgressFor(
      row({ accountBalance: 50000, meta: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 54100, targetProfit: 54100 } }),
      [],
    );
    expect(progress.state).toBe(EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START);
    expect(progress.percent).toBeNull();
  });

  it('refuses a percentage against a zero start, which is the bug it replaces', () => {
    // The existing "Progress to target" table defaulted `startBalance` to 0, and
    // 70 of the 78 rows it drew that way printed 90% or more: an account sitting
    // untouched at its opening balance read as nearly finished. With no stored
    // start and no close on record there is no denominator, and that is said.
    const progress = evaluationProgressFor(
      row({ accountBalance: 50000, meta: { accountType: ACCOUNT_TYPES.EVALUATION_BULLET, targetProfit: 53000 } }),
      [],
    );
    expect(progress.state).toBe(EVALUATION_PROGRESS.NO_START);
    expect(progress.percent).toBeNull();
  });

  it('says so when no target exists and none can be derived', () => {
    const progress = evaluationProgressFor(
      row({ accountBalance: 7777, meta: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 7777 } }),
      [],
    );
    expect(progress.state).toBe(EVALUATION_PROGRESS.NO_TARGET);
    expect(progress.target).toBeNull();
  });
});

describe('the section itself', () => {
  it('is absent entirely for a client who holds no evaluation account', () => {
    expect(buildEvaluationSection({ accountRegistry: { A: { accountType: ACCOUNT_TYPES.FUNDED } } }, {}, { rows: [] }))
      .toBeNull();
  });

  it('still appears, with one sentence, when the accounts exist and none reported', () => {
    /* A client who holds three challenge accounts and saw none of them report is
     * owed that sentence — 3 of the 50 book clients with evaluations are in this
     * state on their latest close. This is a fact about the client's own accounts,
     * unlike "no account here is classified as simulation", which is a fact about
     * the desk's data entry and belongs in the designer. */
    const built = buildEvaluationSection(
      {
        accountRegistry: {
          A: { accountType: ACCOUNT_TYPES.EVALUATION_BULLET },
          B: { accountType: ACCOUNT_TYPES.EVALUATION_BULLET },
          C: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD },
        },
      },
      {},
      { rows: [], reportedAccountCount: 2 },
    );
    expect(built.hasRows).toBe(false);
    expect(built.counts).toMatchObject({ accounts: 0, onRecord: 3, notReported: 3 });
    expect(built.note).toContain('3 evaluation accounts on record');
    expect(built.note).toContain('none of them reported a close on this date');
  });

  it('tells idle apart from flat, which are different facts', () => {
    // 164 of the 203 evaluation rows on the book's latest closes ran no strategy
    // at all. Reporting those as a $0 day is a different claim from the true one.
    const idle = row({ accountName: 'IDLE', meta: { accountName: 'IDLE', accountType: ACCOUNT_TYPES.EVALUATION_BULLET } });
    const flat = row({
      accountName: 'FLAT',
      meta: { accountName: 'FLAT', accountType: ACCOUNT_TYPES.EVALUATION_BULLET },
      strategies: [{ strategyName: 'RBO', ran: true, enabled: true }],
    });
    const built = section([idle, flat]);
    expect(built.counts.traded).toBe(1);
    expect(built.counts.idle).toBe(1);
    expect(built.counts.flat).toBe(2);
  });

  it('counts its denominators and its column coverage', () => {
    const stored = row({ accountName: 'A', accountBalance: 52050, meta: { accountName: 'A', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 50000, targetProfit: 54100 } });
    const inferred = row({ accountName: 'B', accountBalance: 50500, meta: { accountName: 'B', accountType: ACCOUNT_TYPES.EVALUATION_BULLET, startBalance: 50000 } });
    const bad = row({ accountName: 'C', accountBalance: 50000, meta: { accountName: 'C', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 54100, targetProfit: 54100 } });
    const built = buildEvaluationSection(
      { accountRegistry: { A: stored.meta, B: inferred.meta, C: bad.meta }, dailyImports: [] },
      { accounts: {} },
      { rows: [stored, inferred, bad], reportedAccountCount: 9 },
    );
    expect(built.counts.ofAccountsReported).toBe(9);
    expect(built.coverage).toMatchObject({
      ofAccounts: 3, progressShown: 2, targetStored: 2, targetInferred: 1, targetMissing: 0, targetNotAboveStart: 1,
    });
  });

  it('reports the buffer the platform reported, or nothing at all', () => {
    /* NEVER a limit looked up from PROP_FIRM_RULES. It resolves for 93% of these
     * accounts, and on every one of them through tightestRuleFor, because
     * prop_firm_plan is unset on all 319 evaluation rows — the deliberately
     * pessimistic guess AccountManager labels "using tightest" for the desk.
     * propFirmRules.js is explicit that a derived figure answers "how much room
     * was there at the close" and never "was the account safe today". */
    const reported = row({ accountName: 'A', trailingMaxDrawdown: 1850, meta: { accountName: 'A', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, connection: 'Legends', startBalance: 50000 } });
    const silent = row({ accountName: 'B', trailingMaxDrawdown: 0, meta: { accountName: 'B', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, connection: 'Legends', startBalance: 50000 } });
    const built = section([reported, silent]);
    expect(built.accounts[0].reportedBuffer).toBe(1850);
    expect(built.accounts[1].reportedBuffer).toBeNull();
    expect(built.coverage.bufferReported).toBe(1);
    // And the row carries no drawdown LIMIT, derived or otherwise.
    expect(built.accounts[1]).not.toHaveProperty('maxDrawdownLimit');
  });

  it('hands the subtotal it was given straight through, and computes no second one', () => {
    // buildClientMessageReport stopped computing its own totals for this reason:
    // a second arithmetic over the same rows is a second answer waiting to drift
    // from the first.
    const totals = { grossRealizedPnl: -810, weeklyPnl: -1200, aggregateBalance: 149000 };
    const built = buildEvaluationSection(
      { accountRegistry: { A: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD } } },
      {},
      { rows: [row({ accountName: 'A', meta: { accountName: 'A', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD } })], totals, reportedAccountCount: 3 },
    );
    expect(built.totals).toBe(totals);
  });
});
