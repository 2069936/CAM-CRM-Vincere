import { describe, expect, it } from 'vitest';
import {
  buildStrategySignature,
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
