import { describe, expect, it } from 'vitest';
import {
  buildStrategySignature,
  enrichStrategyWithSetMatch,
  matchStrategySet,
  parseSetFileName,
  parseStrategySetXml,
} from './xmlMatch';

describe('parseSetFileName', () => {
  it('parses normal strategy labels from XML filenames', () => {
    expect(parseSetFileName('3 - RBO (M2K) - 10 Min Candle - High Risk - v5 - Period 2.xml')).toMatchObject({
      family: 'RBO',
      instrument: 'M2K',
      risk: 'High Risk',
      riskTier: 3,
      setVersion: 'v5',
      period: '2',
    });
  });

  it('parses Bullet Bot pass type, direction, size, and target from XML filenames', () => {
    expect(parseSetFileName('1-L - Bullet Bot - (1 Day Pass) LONG - 4 Mini - 50K (3k Target) - Period 0.xml')).toMatchObject({
      family: 'Bullet Bot',
      passType: '1 Day Pass',
      direction: 'Long',
      size: '4 Mini',
      accountSize: '50K',
      target: '3k Target',
      period: '0',
    });
  });
});

describe('parseStrategySetXml', () => {
  it('extracts comparable strategy settings from XML bodies', () => {
    const xml = `
      <StrategyTemplate>
        <Strategy>
          <RBO>
            <Name>2 - RBO-PF-1.8</Name>
            <BarsPeriodSerializable><Value>10</Value></BarsPeriodSerializable>
            <MyTradeDirection>Both</MyTradeDirection>
            <PosSize1>2</PosSize1>
            <PosSize2>2</PosSize2>
            <PosSize3>2</PosSize3>
            <StopLossTicks>105</StopLossTicks>
            <ProfitTargetTicks1>155</ProfitTargetTicks1>
            <ProfitTargetTicks2>175</ProfitTargetTicks2>
            <ProfitTargetTicks3>250</ProfitTargetTicks3>
          </RBO>
        </Strategy>
      </StrategyTemplate>
    `;

    expect(parseStrategySetXml(xml)).toMatchObject({
      strategyName: '2 - RBO-PF-1.8',
      strategyFamily: 'RBO_PF',
      strategyVersion: '1.8',
      candleValue: '10',
      signature: {
        direction: 'Both',
        posSizes: [2, 2, 2],
        profitTargets: [155, 175, 250],
        stopLossTicks: 105,
      },
    });
  });
});

describe('matchStrategySet', () => {
  it('matches a running strategy to one XML record within the same family', () => {
    const runningStrategy = {
      strategyFamily: 'RBO_PF',
      strategyName: '2 - RBO-PF-1.8',
      params: {
        parsed: true,
        direction: 'Both',
        posSizes: [2, 2, 2],
        profitTargets: [155, 175, 250],
        stopLossTicks: 105,
      },
    };
    const setRecords = [
      {
        family: 'RBO_PF',
        risk: 'Low Risk',
        period: '0',
        setVersion: 'v3',
        signature: buildStrategySignature({
          direction: 'Both',
          posSizes: [2, 2, 2],
          profitTargets: [155, 175, 250],
          stopLossTicks: 105,
        }),
      },
      {
        family: 'RBO_PF',
        risk: 'Low Risk',
        period: '2',
        setVersion: 'v3',
        signature: buildStrategySignature({
          direction: 'Both',
          posSizes: [2, 2, 2],
          profitTargets: [155, 175, 250],
          stopLossTicks: 105,
        }),
      },
      {
        family: 'OGX',
        risk: 'High Risk',
        period: '1',
        setVersion: 'v1',
        signature: buildStrategySignature({
          direction: 'Both',
          posSizes: [2, 2, 2],
          profitTargets: [155, 175, 250],
          stopLossTicks: 105,
        }),
      },
    ];

    expect(matchStrategySet(runningStrategy, setRecords)).toMatchObject({
      matched: true,
      risk: 'Low Risk',
      period: '2',
      setVersion: 'v3',
    });
  });

  it('fails closed when matching is ambiguous or params are unavailable', () => {
    const runningStrategy = {
      strategyFamily: 'RBO_PF',
      params: {
        parsed: true,
        direction: 'Both',
        posSizes: [2, 2, 2],
        profitTargets: [155, 175, 250],
        stopLossTicks: 105,
      },
    };
    const duplicateRecord = {
      family: 'RBO_PF',
      risk: 'Low Risk',
      period: '2',
      signature: buildStrategySignature(runningStrategy.params),
    };

    expect(matchStrategySet(runningStrategy, [duplicateRecord, duplicateRecord])).toEqual({
      matched: false,
      reason: 'Ambiguous XML strategy match',
    });
    expect(matchStrategySet({ strategyFamily: 'RBO_PF', params: { parsed: false } }, [duplicateRecord])).toEqual({
      matched: false,
      reason: 'Strategy parameters not parsed',
    });
  });
});

// ── buildStrategySignature ────────────────────────────────────────────────────

describe('buildStrategySignature', () => {
  it('normalizes direction to title case', () => {
    expect(buildStrategySignature({ direction: 'LONG' }).direction).toBe('Long');
    expect(buildStrategySignature({ direction: 'short' }).direction).toBe('Short');
    expect(buildStrategySignature({ direction: 'both' }).direction).toBe('Both');
  });

  it('coerces posSizes and profitTargets arrays to numbers preserving order', () => {
    const sig = buildStrategySignature({ posSizes: ['3', '1', '2'], profitTargets: ['200', '100'] });
    expect(sig.posSizes).toEqual([3, 1, 2]);
    expect(sig.profitTargets).toEqual([200, 100]);
  });

  it('returns empty arrays and null for missing inputs', () => {
    const sig = buildStrategySignature({});
    expect(sig.posSizes).toEqual([]);
    expect(sig.profitTargets).toEqual([]);
    expect(sig.stopLossTicks).toBeNull();
  });

  it('coerces stopLossTicks to a number', () => {
    expect(buildStrategySignature({ stopLossTicks: '105' }).stopLossTicks).toBe(105);
  });
});

// ── enrichStrategyWithSetMatch ────────────────────────────────────────────────

describe('enrichStrategyWithSetMatch', () => {
  it('returns strategy with configMatch.matched = false when no records', () => {
    const strategy = { strategyFamily: 'RBO', params: { parsed: true, direction: 'Long', posSizes: [2], profitTargets: [155], stopLossTicks: 100 } };
    const result = enrichStrategyWithSetMatch(strategy, []);
    expect(result.configMatch).toBeDefined();
    expect(result.configMatch.matched).toBe(false);
  });

  it('preserves all original strategy fields', () => {
    const strategy = { strategyFamily: 'RBO', strategyName: '1-RBO', enabled: true, realized: 250, params: { parsed: false } };
    const result = enrichStrategyWithSetMatch(strategy, []);
    expect(result.strategyName).toBe('1-RBO');
    expect(result.enabled).toBe(true);
    expect(result.realized).toBe(250);
  });

  it('attaches matched XML metadata when a record matches', () => {
    const params = { parsed: true, direction: 'Long', posSizes: [2, 2, 2], profitTargets: [155, 175, 250], stopLossTicks: 105 };
    const strategy = { strategyFamily: 'RBO', strategyName: '2-RBO', params };
    const record = {
      family: 'RBO', period: '2', risk: 'Low Risk', riskTier: 1, setVersion: 'v4',
      signature: buildStrategySignature(params),
    };
    const result = enrichStrategyWithSetMatch(strategy, [record]);
    expect(result.configMatch.matched).toBe(true);
    expect(result.configMatch.risk).toBe('Low Risk');
    expect(result.configMatch.setVersion).toBe('v4');
  });
});
