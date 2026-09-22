import { describe, expect, it } from 'vitest';
import {
  RAN_BASES,
  familiesOnFills,
  familyFromStrategyName,
  ranBasisFromEvidence,
  ranBasisOf,
  strategyRan,
  withStrategyRan,
} from './strategyRan';

/* THE ONE RULE, AND THE FOUR ANSWERS IT CAN GIVE.
 *
 * Everything in the product that asks "did this algorithm run that day" reads
 * this module. It used to read `strategy_snapshots.enabled`, which is a
 * checkbox as it stood when the CAM exported, on exports taken after the desk
 * switches the algos off: on 2026-09-21, 45 of the 46 (close, strategy) pairs
 * that produced fills carry `enabled = false`.
 */
const row = (extra = {}) => ({
  accountName: 'ACC1',
  strategyName: '0 - RBO-1.8',
  strategyFamily: 'RBO',
  strategyVersion: '1.8',
  enabled: false,
  realized: 0,
  ...extra,
});

const fill = (strategyName, accountName = 'ACC1') => ({ accountName, strategyName });

describe('the rule', () => {
  it('has exactly four answers, strongest evidence first', () => {
    expect(RAN_BASES).toEqual(['enabled', 'fills', 'realized', 'none']);
  });

  it('answers enabled when the grid still had it switched on', () => {
    expect(ranBasisFromEvidence(row({ enabled: true }))).toBe('enabled');
    // Even against fills that name something else entirely.
    expect(ranBasisFromEvidence(row({ enabled: true }), familiesOnFills([fill('0 - URGO-4.5')]))).toBe('enabled');
  });

  it('answers fills when this account\'s fills name its family', () => {
    const fills = familiesOnFills([fill('2 - RBO-1.8')]);
    expect(ranBasisFromEvidence(row(), fills)).toBe('fills');
    // The grid index in front of the name is NinjaTrader's row number, not part
    // of the name: `0 - RBO-1.8` on the grid and `2 - RBO-1.8` on the fills are
    // the same product.
    expect(strategyRan(row(), fills)).toBe(true);
  });

  it('answers realized when the grid reported money on a row it had switched off', () => {
    expect(ranBasisFromEvidence(row({ realized: -485 }))).toBe('realized');
    expect(ranBasisFromEvidence(row({ realized: 485 }))).toBe('realized');
  });

  it('answers none, and only none, when nothing says it ran', () => {
    expect(ranBasisFromEvidence(row())).toBe('none');
    expect(strategyRan(row())).toBe(false);
    // A reported zero is a report of nothing, not evidence of something.
    expect(ranBasisFromEvidence(row({ realized: 0 }))).toBe('none');
    // And a row nobody reported on at all.
    expect(ranBasisFromEvidence(row({ realized: null }))).toBe('none');
  });

  it('does not let one account\'s fills answer for another account', () => {
    const fills = familiesOnFills([fill('0 - RBO-1.8', 'ACC2')]);
    // familiesOnFills is handed ONE account's fills by its caller; this is the
    // caller's contract, and withStrategyRan below is where it is enforced.
    expect(ranBasisFromEvidence(row(), fills)).toBe('fills');
    const rows = withStrategyRan([row()], [fill('0 - RBO-1.8', 'ACC2')]);
    expect(rows[0].ranBasis).toBe('none');
  });

  it('reads a family off a fill the way the grid stores it', () => {
    expect(familyFromStrategyName('0 - OGX-PF-2.4')).toBe('OGX_PF');
    expect(familyFromStrategyName('2 - URGO-4.5')).toBe('URGO');
    expect(familyFromStrategyName('Bullet Bot-1.1')).toBe('Bullet Bot');
    expect(familyFromStrategyName('')).toBeNull();
  });

  it('carries the version of a family that is only on the fills', () => {
    // 98 funded account-days on the book carry no strategy rows at all, so the
    // fill name is the only thing that knows which version ran.
    expect([...familiesOnFills([fill('0 - OGX-PF-2.4')])]).toEqual([['OGX_PF', '2.4']]);
  });
});

describe('the stored answer', () => {
  it('wins over a recomputation, because that is what storing it is for', () => {
    // No fills on hand at all, and the row still knows the day happened.
    expect(ranBasisOf(row({ ran: true, ranBasis: 'fills' }))).toBe('fills');
    expect(strategyRan(row({ ran: true, ranBasis: 'fills' }))).toBe(true);
    expect(strategyRan(row({ enabled: true, ran: false, ranBasis: 'none' }))).toBe(false);
  });

  it('falls back to the rule when the row carries none', () => {
    // A database where step 47 has not run: every row reads as it did before.
    expect(ranBasisOf(row({ ran: null, ranBasis: '' }))).toBe('none');
    expect(ranBasisOf(row({ enabled: true, ran: null, ranBasis: '' }))).toBe('enabled');
  });

  it('treats a value it does not recognise as no answer at all', () => {
    // Junk from a writer that is not this app degrades into today's reading
    // rather than onto a screen, which is why the column carries no CHECK.
    expect(ranBasisOf(row({ enabled: true, ranBasis: 'Enabled' }))).toBe('enabled');
    expect(ranBasisOf(row({ ranBasis: 'whatever' }))).toBe('none');
  });

  it('believes a boolean stored without its evidence', () => {
    expect(ranBasisOf(row({ ran: true }))).toBe('enabled');
    expect(ranBasisOf(row({ ran: false, enabled: true }))).toBe('none');
  });
});

describe('answering a whole close', () => {
  it('answers each row against its own account\'s fills', () => {
    const rows = withStrategyRan(
      [
        row({ accountName: 'ACC1' }),
        row({ accountName: 'ACC2' }),
        row({ accountName: 'ACC2', strategyName: '1 - URGO-4.5', strategyFamily: 'URGO', enabled: true }),
      ],
      [fill('0 - RBO-1.8', 'ACC2')],
    );
    expect(rows.map((r) => [r.accountName, r.ran, r.ranBasis])).toEqual([
      ['ACC1', false, 'none'],
      ['ACC2', true, 'fills'],
      ['ACC2', true, 'enabled'],
    ]);
  });

  it('matches an account name however it is cased', () => {
    const rows = withStrategyRan([row({ accountName: 'Acc1' })], [fill('0 - RBO-1.8', 'ACC1')]);
    expect(rows[0].ranBasis).toBe('fills');
  });

  it('leaves the rows it was given alone', () => {
    const original = row();
    const rows = withStrategyRan([original], []);
    expect(original.ran).toBeUndefined();
    expect(rows[0]).not.toBe(original);
  });

  it('does not rewrite a stored answer from a close whose fills are not loaded', () => {
    // NOT LOADED IS NOT EMPTY. The browser loads orders and executions after the
    // first screen, and Recalculate runs on whatever it holds at the time.
    // Without this, one Recalculate before the trade history arrived would
    // rewrite every `fills` row to `none` and report the day as idle.
    const stored = row({ ran: true, ranBasis: 'fills' });
    expect(withStrategyRan([stored], [])[0].ranBasis).toBe('fills');
    // A close that DOES carry fills is evidence, and re-answers the row.
    expect(withStrategyRan([stored], [fill('0 - URGO-4.5')])[0].ranBasis).toBe('none');
  });

  it('answers a row with no stored answer even when the close carries no fills', () => {
    expect(withStrategyRan([row({ enabled: true })], [])[0].ranBasis).toBe('enabled');
    expect(withStrategyRan([row({ realized: 12 })], [])[0].ranBasis).toBe('realized');
    expect(withStrategyRan([row()], [])[0].ranBasis).toBe('none');
  });
});
