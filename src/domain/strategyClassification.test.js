import { describe, it, expect } from 'vitest';
import {
  buildStrategySignature,
  signatureKey,
  groupStrategiesBySignature,
  classifyStrategy,
  detectVersionMismatches,
} from './strategyClassification';

const paramsV1 = {
  parsed: true,
  direction: 'Both',
  posSizes: [2, 2, 2],
  profitTargets: [155, 175, 250],
  stopLossTicks: 105,
  tradeWindow: ['9:27 AM', '9:29 AM'],
};
const paramsV2 = {
  parsed: true,
  direction: 'Short',
  posSizes: [1],
  profitTargets: [110],
  stopLossTicks: 90,
  tradeWindow: ['9:30 AM', '9:45 AM'],
};

function client(id, name, strategies) {
  return {
    id,
    name,
    dailyImports: [{ date: '2026-07-13', snapshots: [{ accountName: `${id}-ACC`, strategies }] }],
  };
}

describe('buildStrategySignature / signatureKey', () => {
  it('builds a comparable signature from parsed parameters', () => {
    expect(buildStrategySignature(paramsV1)).toMatchObject({
      direction: 'Both',
      posSizes: [2, 2, 2],
      profitTargets: [155, 175, 250],
      stopLossTicks: 105,
    });
  });

  it('returns null for unparsed parameters', () => {
    expect(buildStrategySignature({ parsed: false })).toBeNull();
    expect(buildStrategySignature(null)).toBeNull();
  });

  it('gives identical keys for identical signatures and different keys otherwise', () => {
    expect(signatureKey(buildStrategySignature(paramsV1))).toBe(signatureKey(buildStrategySignature(paramsV1)));
    expect(signatureKey(buildStrategySignature(paramsV1))).not.toBe(signatureKey(buildStrategySignature(paramsV2)));
  });
});

describe('groupStrategiesBySignature', () => {
  it('groups accounts that run the same family + signature and sorts by usage', () => {
    const clients = [
      client('c1', 'Pedro', [{ strategyFamily: 'OGX', strategyVersion: '1.0', instrument: 'NQ', realized: 100, params: paramsV1 }]),
      client('c2', 'Ana', [{ strategyFamily: 'OGX', strategyVersion: '1.0', instrument: 'NQ', realized: 50, params: paramsV1 }]),
      client('c3', 'Leo', [{ strategyFamily: 'OGX', strategyVersion: '5.0', instrument: 'NQ', realized: -20, params: paramsV2 }]),
    ];
    const groups = groupStrategiesBySignature(clients);
    expect(groups).toHaveLength(2); // two distinct OGX signatures
    expect(groups[0].accountCount).toBe(2); // the paramsV1 pool is bigger, sorts first
    expect(groups[0].family).toBe('OGX');
    expect(groups[0].clientCount).toBe(2);
  });
});

describe('classifyStrategy', () => {
  const classifications = [
    { key: `OGX|${signatureKey(buildStrategySignature(paramsV1))}`, family: 'OGX', version: 'v1', riskLevel: 'Low' },
  ];

  it('matches a strategy to its assigned version + risk by signature', () => {
    const result = classifyStrategy({ strategyFamily: 'OGX', params: paramsV1 }, classifications);
    expect(result).toMatchObject({ matched: true, version: 'v1', riskLevel: 'Low' });
  });

  it('returns unclassified when no classification matches the signature', () => {
    const result = classifyStrategy({ strategyFamily: 'OGX', params: paramsV2 }, classifications);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('unclassified');
  });
});

describe('detectVersionMismatches', () => {
  it('flags a family running more than one signature/version across accounts', () => {
    const clients = [
      client('c1', 'Pedro', [{ strategyFamily: 'OGX', strategyVersion: '1.0', instrument: 'NQ', realized: 100, params: paramsV1 }]),
      client('c2', 'Leo', [{ strategyFamily: 'OGX', strategyVersion: '5.0', instrument: 'NQ', realized: -20, params: paramsV2 }]),
    ];
    const mismatches = detectVersionMismatches(clients, []);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ family: 'OGX', variantCount: 2 });
  });

  it('does not flag a family where everyone runs the same signature', () => {
    const clients = [
      client('c1', 'Pedro', [{ strategyFamily: 'OGX', strategyVersion: '1.0', instrument: 'NQ', realized: 100, params: paramsV1 }]),
      client('c2', 'Ana', [{ strategyFamily: 'OGX', strategyVersion: '1.0', instrument: 'NQ', realized: 50, params: paramsV1 }]),
    ];
    expect(detectVersionMismatches(clients, [])).toHaveLength(0);
  });
});
