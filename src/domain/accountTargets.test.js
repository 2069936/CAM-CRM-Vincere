import { describe, it, expect } from 'vitest';
import { inferStartingBalance, targetForAccount, suggestAccountDefaults } from './accountTargets';

describe('inferStartingBalance', () => {
  it('snaps a live balance to the nearest standard size within 20%', () => {
    expect(inferStartingBalance(49000)).toBe(50000);
    expect(inferStartingBalance(54100)).toBe(50000);
    expect(inferStartingBalance(101000)).toBe(100000);
    expect(inferStartingBalance(159000)).toBe(150000);
  });

  it('returns null when the balance is not close to any standard size', () => {
    expect(inferStartingBalance(70000)).toBeNull(); // gap between 50k and 100k
    expect(inferStartingBalance(250000)).toBeNull();
    expect(inferStartingBalance(0)).toBeNull();
    expect(inferStartingBalance('x')).toBeNull();
  });
});

describe('targetForAccount', () => {
  it('assigns the standard target for Funded and normal Evaluation by size', () => {
    expect(targetForAccount('Funded', 50000)).toBe(54100);
    expect(targetForAccount('Evaluation - Standard', 50000)).toBe(54100);
    expect(targetForAccount('Funded', 100000)).toBe(107300);
    expect(targetForAccount('Funded', 150000)).toBe(159000);
  });

  it('assigns the lower Bullet Bot target', () => {
    expect(targetForAccount('Evaluation - Bullet Bot', 50000)).toBe(53000);
  });

  it('has no target for Cash accounts', () => {
    expect(targetForAccount('Cash', 50000)).toBeNull();
  });

  it('returns null for a size/type without a known rule', () => {
    expect(targetForAccount('Evaluation - Bullet Bot', 100000)).toBeNull();
    expect(targetForAccount('Funded', 25000)).toBeNull();
  });
});

describe('suggestAccountDefaults', () => {
  it('infers start + target for a funded account from its balance', () => {
    expect(suggestAccountDefaults('Funded', 51500)).toEqual({ startingBalance: 50000, target: 54100 });
  });

  it('gives a Bullet Bot the lower target', () => {
    expect(suggestAccountDefaults('Evaluation - Bullet Bot', 49500)).toEqual({ startingBalance: 50000, target: 53000 });
  });

  it('gives cash accounts neither start nor target', () => {
    expect(suggestAccountDefaults('Cash', 12345)).toEqual({ startingBalance: null, target: null });
  });

  it('leaves target null when the size cannot be inferred', () => {
    expect(suggestAccountDefaults('Funded', 70000)).toEqual({ startingBalance: null, target: null });
  });
});
