import { describe, expect, it } from 'vitest';
import {
  MARKET_POSITIONS,
  knownPosition,
  positionOfInstances,
  positionShortWords,
  positionWords,
  tradesWords,
} from './livePosition';

/* ------------------------------------------------------------------------- *
 * WHICH WAY IT FIRED, IN WORDS.
 *
 * Step 64 put three nullable columns on the per strategy reading: the market
 * position (long, short, flat), the contracts held and the trades this run.
 * Agent 1.2.1 fills them; 1.2.0 leaves them null. NULL IS "NOT READ": a
 * reading without them prints nothing, never "flat" and never 0.
 * ------------------------------------------------------------------------- */

describe('knownPosition', () => {
  it('keeps only the three words the column allows', () => {
    expect(MARKET_POSITIONS).toEqual(['long', 'short', 'flat']);
    expect(knownPosition('long')).toBe('long');
    expect(knownPosition('short')).toBe('short');
    expect(knownPosition('flat')).toBe('flat');
    expect(knownPosition('Long')).toBeNull();
    expect(knownPosition('')).toBeNull();
    expect(knownPosition(null)).toBeNull();
    expect(knownPosition(undefined)).toBeNull();
    expect(knownPosition('sideways')).toBeNull();
  });
});

describe('positionWords, the drill down sentence', () => {
  it('reads "long, 2 contracts, 1 trade this run"', () => {
    expect(positionWords({ marketPosition: 'long', positionQuantity: 2, tradesThisRun: 1 })).toBe('long, 2 contracts, 1 trade this run');
    expect(positionWords({ marketPosition: 'short', positionQuantity: 1, tradesThisRun: 3 })).toBe('short, 1 contract, 3 trades this run');
  });

  it('says flat without a contract count, and keeps the trades', () => {
    expect(positionWords({ marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 4 })).toBe('flat, 4 trades this run');
    expect(positionWords({ marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 0 })).toBe('flat, 0 trades this run');
    expect(positionWords({ marketPosition: 'flat', positionQuantity: null, tradesThisRun: null })).toBe('flat');
  });

  it('prints only what the reading carried', () => {
    expect(positionWords({ marketPosition: 'long', positionQuantity: null, tradesThisRun: null })).toBe('long');
    expect(positionWords({ marketPosition: null, positionQuantity: null, tradesThisRun: 2 })).toBe('2 trades this run');
    expect(positionWords({ marketPosition: null, positionQuantity: 3, tradesThisRun: null })).toBe('3 contracts');
  });

  it('is null, not "flat" and not "0", when all three are null (a 1.2.0 reading)', () => {
    expect(positionWords({ marketPosition: null, positionQuantity: null, tradesThisRun: null })).toBeNull();
    expect(positionWords({})).toBeNull();
    expect(positionWords(null)).toBeNull();
    // An unknown word is not read either.
    expect(positionWords({ marketPosition: 'sideways', positionQuantity: null, tradesThisRun: null })).toBeNull();
  });

  it('never prints a dash', () => {
    const cases = [
      { marketPosition: 'long', positionQuantity: 2, tradesThisRun: 1 },
      { marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 0 },
      { marketPosition: null, positionQuantity: null, tradesThisRun: 12 },
    ];
    for (const row of cases) {
      expect(positionWords(row)).not.toMatch(/[–—]| - /);
      expect(positionShortWords(row) || '').not.toMatch(/[–—]| - /);
    }
  });
});

describe('positionShortWords, the roll call word', () => {
  it('reads "long 2", "short 1" and "flat"', () => {
    expect(positionShortWords({ marketPosition: 'long', positionQuantity: 2 })).toBe('long 2');
    expect(positionShortWords({ marketPosition: 'short', positionQuantity: 1 })).toBe('short 1');
    expect(positionShortWords({ marketPosition: 'flat', positionQuantity: 0 })).toBe('flat');
    expect(positionShortWords({ marketPosition: 'long', positionQuantity: null })).toBe('long');
    expect(positionShortWords({ marketPosition: null, positionQuantity: 2 })).toBeNull();
  });
});

describe('tradesWords', () => {
  it('counts trades this run, singular and plural, and is null when not read', () => {
    expect(tradesWords(1)).toBe('1 trade this run');
    expect(tradesWords(0)).toBe('0 trades this run');
    expect(tradesWords(7)).toBe('7 trades this run');
    expect(tradesWords(null)).toBeNull();
    expect(tradesWords(undefined)).toBeNull();
    expect(tradesWords('')).toBeNull();
  });
});

describe('positionOfInstances, one account with one or more instances', () => {
  it('reads one instance straight through', () => {
    expect(positionOfInstances([{ marketPosition: 'long', positionQuantity: 2, tradesThisRun: 3 }]))
      .toEqual({ direction: 'long', quantity: 2, trades: 3, words: 'long 2', tradesWords: '3 trades this run' });
  });

  it('is all null when no instance carries a position', () => {
    expect(positionOfInstances([{ marketPosition: null, positionQuantity: null, tradesThisRun: null }, {}]))
      .toEqual({ direction: null, quantity: null, trades: null, words: null, tradesWords: null });
    expect(positionOfInstances([])).toEqual({ direction: null, quantity: null, trades: null, words: null, tradesWords: null });
  });

  it('sums contracts and trades over instances that agree, and says mixed when they do not', () => {
    expect(positionOfInstances([
      { marketPosition: 'long', positionQuantity: 2, tradesThisRun: 3 },
      { marketPosition: 'long', positionQuantity: 1, tradesThisRun: 1 },
    ])).toEqual({ direction: 'long', quantity: 3, trades: 4, words: 'long 3', tradesWords: '4 trades this run' });
    expect(positionOfInstances([
      { marketPosition: 'long', positionQuantity: 2, tradesThisRun: 3 },
      { marketPosition: 'short', positionQuantity: 1, tradesThisRun: null },
    ])).toEqual({ direction: 'mixed', quantity: 3, trades: 3, words: 'long 2, short 1', tradesWords: '3 trades this run' });
  });

  it('ignores an instance whose position was not read and keeps the one that was', () => {
    expect(positionOfInstances([
      { marketPosition: null, positionQuantity: null, tradesThisRun: null },
      { marketPosition: 'short', positionQuantity: 1, tradesThisRun: 2 },
    ])).toEqual({ direction: 'short', quantity: 1, trades: 2, words: 'short 1', tradesWords: '2 trades this run' });
  });
});
