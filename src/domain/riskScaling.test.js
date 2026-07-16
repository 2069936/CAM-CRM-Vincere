import { describe, it, expect } from 'vitest';
import { parseComboRisk, buildRiskScalingCurve, estimateMaxSafeMultiplier } from './riskScaling';

describe('parseComboRisk', () => {
  it('splits base algo from contract multiplier', () => {
    expect(parseComboRisk('URGO x2')).toEqual({ base: 'URGO', multiplier: 2 });
    expect(parseComboRisk('IFSP x4')).toEqual({ base: 'IFSP', multiplier: 4 });
    expect(parseComboRisk('URGO')).toEqual({ base: 'URGO', multiplier: 1 });
  });

  it('treats a multi-algo combo as its own base at 1x', () => {
    expect(parseComboRisk('URGO + IFSP')).toEqual({ base: 'URGO + IFSP', multiplier: 1 });
  });
});

describe('buildRiskScalingCurve', () => {
  it('groups levels by base and computes risk-normalized PnL', () => {
    const comboPerf = [
      { combo: 'URGO', avgPnl: 100, winRate: 60, accounts: 4 },
      { combo: 'URGO x2', avgPnl: 180, winRate: 55, accounts: 2 },
      { combo: 'IFSP', avgPnl: 90, winRate: 58, accounts: 3 },
    ];
    const curves = buildRiskScalingCurve(comboPerf);
    const urgo = curves.find((c) => c.base === 'URGO');
    expect(urgo.levels.map((l) => l.riskLevel)).toEqual([1, 2]);
    expect(urgo.hasScaling).toBe(true);
    // 1x: 100/1=100 ; 2x: 180/2=90 -> 1x is more efficient per contract
    expect(urgo.bestEfficiency.riskLevel).toBe(1);
    expect(urgo.levels[1].riskNormalizedPnl).toBeCloseTo(90);
  });
});

describe('estimateMaxSafeMultiplier', () => {
  it('sizes the safe multiplier from buffer and worst day', () => {
    // worst day -500, buffer 4500, cushion 3 -> capacity 4500/(3*500)=3 -> maxMult 3
    const series = [{ dayPnl: 200 }, { dayPnl: -500 }, { dayPnl: 100 }];
    const r = estimateMaxSafeMultiplier(series, 4500, 1, 3);
    expect(r.worstDay).toBe(-500);
    expect(r.maxMultiplier).toBeCloseTo(3);
    expect(r.safeLevel).toBe(2); // nearest doubling at/under 3
  });

  it('returns null without a buffer or a losing day', () => {
    expect(estimateMaxSafeMultiplier([{ dayPnl: 100 }], 0)).toBeNull();
    expect(estimateMaxSafeMultiplier([{ dayPnl: 100 }], 4000)).toBeNull();
  });
});
