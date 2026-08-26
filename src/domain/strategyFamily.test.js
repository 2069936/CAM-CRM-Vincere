import { describe, expect, it } from 'vitest';
import { strategyFamilyOf } from './strategyFamily';

// Carried over verbatim from strategyRiskProfile.test.js, which went out with
// buildStrategyRiskProfile. The cases are the reason the regex is shaped the way
// it is, and none of them depended on the profile builder.
describe('strategyFamilyOf', () => {
  it('strips the grid index and the version but keeps -PF', () => {
    expect(strategyFamilyOf('0 - OGX-PF-2.4')).toBe('OGX-PF');
    expect(strategyFamilyOf('1-URGO-4.5')).toBe('URGO');
    expect(strategyFamilyOf('0 - Bullet Bot-1.1')).toBe('Bullet Bot');
    expect(strategyFamilyOf('URGO')).toBe('URGO');
  });

  it('keeps -PF apart from the family it is named after', () => {
    // OGX-PF runs under prop-firm rules OGX does not. Folding the two together
    // would average a stop across two different products.
    expect(strategyFamilyOf('0 - OGX-PF-2.4')).not.toBe(strategyFamilyOf('0 - OGX-2.4'));
    expect(strategyFamilyOf('0 - OGX-2.4')).toBe('OGX');
  });

  it('leaves a trailing number alone when it is not a version', () => {
    // csvImport reads a version as digits with a dot in them. Stripping any
    // trailing -N as well would fold a family genuinely called B2X-4 into B2X
    // and average two products' stops together.
    expect(strategyFamilyOf('2 - B2X-4')).toBe('B2X-4');
    expect(strategyFamilyOf('2 - B2X-2.5')).toBe('B2X');
  });

  it('has nothing to say about an unnamed strategy', () => {
    expect(strategyFamilyOf('')).toBeNull();
    expect(strategyFamilyOf(null)).toBeNull();
  });

  it('gathers every version of a family into one key', () => {
    // What the dropped "gathers every version of a family into one row" case
    // was really asserting, once the profile builder it went through is gone.
    const names = ['0 - OGX-PF-2.4', '1 - OGX-PF-3.0', '2 - OGX-PF-3.0'];
    expect(new Set(names.map(strategyFamilyOf))).toEqual(new Set(['OGX-PF']));
  });
});
