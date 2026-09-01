import { describe, it, expect } from 'vitest';
import { stampAccountOutcome, OUTCOME_PROMPTS } from './accountOutcomeStamp';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES } from './reconcile';

describe('dating a classification at the moment it is made', () => {
  it('stamps date_failed when an account is marked Failed', () => {
    // THE BUG THIS CLOSES. 48 accounts on the real book are marked Failed and 1
    // carries a date_failed, because the select saved {status} and nothing else.
    // 47 of them cannot be placed in time and never will be.
    expect(stampAccountOutcome({ status: ACCOUNT_STATUSES.FAILED }, {}, '2026-09-01'))
      .toEqual({ status: ACCOUNT_STATUSES.FAILED, dateFailed: '2026-09-01' });
  });

  it('stamps date_funded when an account becomes Funded, which is what passing is', () => {
    // There is no 'Passed' status and there should not be one: an evaluation
    // that passes becomes a Funded account, and date_funded is already the
    // column for when that happened.
    expect(stampAccountOutcome({ accountType: ACCOUNT_TYPES.FUNDED }, {}, '2026-09-01'))
      .toEqual({ accountType: ACCOUNT_TYPES.FUNDED, dateFunded: '2026-09-01' });
  });

  it('leaves a date the caller supplied alone', () => {
    const patch = { status: ACCOUNT_STATUSES.FAILED, dateFailed: '2026-08-14' };
    expect(stampAccountOutcome(patch, {}, '2026-09-01')).toEqual(patch);
  });

  it('leaves a date already on the account alone', () => {
    // A date on record is evidence. This is a guess, and a guess does not get to
    // overwrite the day someone actually recorded.
    expect(stampAccountOutcome(
      { status: ACCOUNT_STATUSES.FAILED },
      { dateFailed: '2026-07-02' },
      '2026-09-01',
    )).toEqual({ status: ACCOUNT_STATUSES.FAILED });
  });

  it('does not date a patch that is not making the claim', () => {
    // Editing the risk level of an account that is already Failed is not a new
    // classification and must not move its date to today.
    expect(stampAccountOutcome({ riskLevel: 'High' }, { status: ACCOUNT_STATUSES.FAILED }, '2026-09-01'))
      .toEqual({ riskLevel: 'High' });
  });

  it('does not date a status that is not terminal', () => {
    for (const status of [ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.RESERVE, ACCOUNT_STATUSES.PAYOUT_HOLD]) {
      expect(stampAccountOutcome({ status }, {}, '2026-09-01')).toEqual({ status });
    }
  });

  it('never clears a date when an account moves off Failed', () => {
    // It failed on that day whether or not it was revived afterwards, and the
    // lifecycle module reads declared status and observed evidence as two
    // independent facts on purpose.
    expect(stampAccountOutcome(
      { status: ACCOUNT_STATUSES.ACTIVE },
      { dateFailed: '2026-07-02' },
      '2026-09-01',
    )).toEqual({ status: ACCOUNT_STATUSES.ACTIVE });
  });

  it('stamps both when one patch carries both claims', () => {
    expect(stampAccountOutcome(
      { status: ACCOUNT_STATUSES.FAILED, accountType: ACCOUNT_TYPES.FUNDED },
      {},
      '2026-09-01',
    )).toEqual({
      status: ACCOUNT_STATUSES.FAILED,
      accountType: ACCOUNT_TYPES.FUNDED,
      dateFailed: '2026-09-01',
      dateFunded: '2026-09-01',
    });
  });

  it('is a no-op without a date rather than writing an empty one', () => {
    // An empty date_failed is worse than none: it reads as recorded.
    const patch = { status: ACCOUNT_STATUSES.FAILED };
    expect(stampAccountOutcome(patch, {}, '')).toEqual(patch);
    expect(stampAccountOutcome(patch, {}, '   ')).toEqual(patch);
  });

  it('returns the same object when it changes nothing, so callers can skip a save', () => {
    const patch = { riskLevel: 'Low' };
    expect(stampAccountOutcome(patch, {}, '2026-09-01')).toBe(patch);
  });

  it('survives being handed nothing', () => {
    expect(stampAccountOutcome(null, {}, '2026-09-01')).toBe(null);
    expect(stampAccountOutcome(undefined, {}, '2026-09-01')).toBe(undefined);
  });

  it('is safe to run twice over the same patch', () => {
    const once = stampAccountOutcome({ status: ACCOUNT_STATUSES.FAILED }, {}, '2026-09-01');
    expect(stampAccountOutcome(once, {}, '2026-09-08')).toEqual(once);
  });
});

describe('the two questions a CAM is asked', () => {
  it('writes exactly what the prompt says it writes', () => {
    // The prompt and the write live in one file so they cannot drift into
    // describing different things.
    expect(OUTCOME_PROMPTS.TARGET_REACHED.patch).toEqual({ accountType: ACCOUNT_TYPES.FUNDED });
    expect(OUTCOME_PROMPTS.WENT_MISSING.patch).toEqual({ status: ACCOUNT_STATUSES.FAILED });
  });

  it('produces a dated write when answered', () => {
    for (const prompt of Object.values(OUTCOME_PROMPTS)) {
      const written = stampAccountOutcome(prompt.patch, {}, '2026-09-01');
      const dates = Object.keys(written).filter((key) => key.startsWith('date'));
      expect(dates).toHaveLength(1);
      expect(written[dates[0]]).toBe('2026-09-01');
    }
  });
});
