import { describe, expect, it } from 'vitest';
import {
  compareCollectorVersions,
  normalizeCollectorVersion,
  requiresCollectorUpdate,
} from './collectorVersion.js';

describe('collector versions', () => {
  it.each([
    ['1.2', '1.2'],
    ['001.00002.3', '001.00002.3'],
    ['65535.65535.65535.65535', '65535.65535.65535.65535'],
  ])('accepts strict numeric dotted version %s', (value, expected) => {
    expect(normalizeCollectorVersion(value)).toBe(expected);
  });

  it.each(['', '1', '1.', '.1', '1.2.3.4.5', '1.2-beta', '1. 2', '123456.1'])(
    'rejects malformed version %j', (value) => {
      expect(() => normalizeCollectorVersion(value)).toThrow('Invalid version.');
    },
  );

  it.each([
    ['1.2.9', '1.10.0', -1],
    ['2.0', '1.9999.9999', 1],
    ['1.2', '1.2.0.0', 0],
    ['01.002.0003', '1.2.3', 0],
  ])('compares %s and %s numerically', (left, right, expected) => {
    expect(Math.sign(compareCollectorVersions(left, right))).toBe(expected);
  });

  it('treats a blank minimum as no update requirement', () => {
    expect(requiresCollectorUpdate('1.0', '')).toBe(false);
    expect(requiresCollectorUpdate('1.0', '   ')).toBe(false);
  });

  it('normalizes harmless surrounding whitespace like the pairing route', () => {
    expect(normalizeCollectorVersion('  1.2.3\n')).toBe('1.2.3');
  });

  it.each([
    ['1.9.9', '2.0.0', true],
    ['2.0', '2.0.0', false],
    ['2.1.0', '2.0.0', false],
  ])('calculates update requirement for agent %s and minimum %s', (agent, minimum, expected) => {
    expect(requiresCollectorUpdate(agent, minimum)).toBe(expected);
  });

  it('rejects invalid nonblank server minimum versions', () => {
    expect(() => requiresCollectorUpdate('1.0', 'latest')).toThrow('Invalid version.');
  });
});
