import { describe, expect, it } from 'vitest';
import {
  attributeOrders,
  instrumentRoot,
  matchGeometry,
  reconstructTrades,
  rungOf,
  targetNumber,
  tickSizeFor,
  tradeGeometry,
} from './orderAttribution';

/* The numbers are from a real VPS export on 2026-09-24: 886 strategy templates
 * across 20 algorithm families and 18,827 orders over seven months. The G4M
 * template declares PosSize 2/1/1 with stop 80 and targets 80/120/160, and its
 * orders sat at exactly those distances from the entry fill. */
const G4M = {
  family: 'G4M', version: 'v1', risk: 'Low', instrument: 'MES', propFirm: false,
  size1: 2, size2: 1, size3: 1,
  stopTicks: 80, target1Ticks: 80, target2Ticks: 120, target3Ticks: 160,
};

/** A short at 7691.25 on MES, tick 0.25: PT1 80 ticks away is 7671.25. */
function g4mTrade(idBase = 1, account = 'A1') {
  const entry = 7691.25;
  return [
    { id: `${idBase}`, account, instrument: 'MES', name: 'Enter Short', quantity: 4, avgPrice: entry, time: '001' },
    { id: `${idBase + 1}`, account, instrument: 'MES', name: 'PT1-Short', quantity: 2, limitPrice: entry - 20, time: '002' },
    { id: `${idBase + 2}`, account, instrument: 'MES', name: 'PT2-Short', quantity: 1, limitPrice: entry - 30, time: '003' },
    { id: `${idBase + 3}`, account, instrument: 'MES', name: 'PT3-Short', quantity: 1, limitPrice: entry - 40, time: '004' },
    { id: `${idBase + 4}`, account, instrument: 'MES', name: 'Stop Short', quantity: 4, stopPrice: entry + 20, time: '005' },
  ];
}

describe('reading an order', () => {
  it('keeps the rung and drops the side', () => {
    // A strategy that goes long on Monday and short on Tuesday is one strategy.
    expect(rungOf('PT1-Short')).toBe('PT1');
    expect(rungOf('PT1-Long')).toBe('PT1');
    expect(rungOf('Enter Short')).toBe('Enter');
    expect(rungOf('Stop Long')).toBe('Stop');
    expect(rungOf(null)).toBe('');
  });

  it('numbers the rungs, with a bare PT as the first', () => {
    expect(targetNumber({ name: 'PT2-Short' })).toBe(2);
    expect(targetNumber({ name: 'PT-Long' })).toBe(1);
    expect(targetNumber({ name: 'Enter Long' })).toBe(0);
  });

  it('reads the contract root out of a dated instrument', () => {
    expect(instrumentRoot('MNQ 12-26')).toBe('MNQ');
    expect(instrumentRoot('MNQ SEP26')).toBe('MNQ');
    expect(instrumentRoot('mes')).toBe('MES');
    // A root can hold a digit. Cutting at the first one turns the micro Russell
    // into `M`, which is in no tick table, and drops the instrument in silence:
    // 151 orders across 33 trades on the seven months measured.
    expect(instrumentRoot('M2K 12-26')).toBe('M2K');
    expect(tickSizeFor('M2K')).toBe(0.1);
    expect(tickSizeFor('MES 03-27')).toBe(0.25);
    expect(tickSizeFor('YM')).toBe(1);
    // An instrument nobody has specified is not guessed at.
    expect(tickSizeFor('WHEAT')).toBeNull();
  });
});

describe('putting trades back together', () => {
  it('gives an entry the exits that belong to it', () => {
    const trades = reconstructTrades(g4mTrade());
    expect(trades).toHaveLength(1);
    expect(trades[0].exits).toHaveLength(4);
  });

  it('does not let a re-entry steal the previous trade\'s targets', () => {
    // The first trade's exits are still live when the second entry lands.
    const orders = [
      { id: '1', instrument: 'MES', name: 'Enter Short', quantity: 4, avgPrice: 100, time: '001' },
      { id: '2', instrument: 'MES', name: 'Enter Short', quantity: 4, avgPrice: 200, time: '002' },
      { id: '3', instrument: 'MES', name: 'PT1-Short', quantity: 2, limitPrice: 80, time: '003' },
      { id: '4', instrument: 'MES', name: 'PT1-Short', quantity: 2, limitPrice: 180, time: '004' },
    ];
    const trades = reconstructTrades(orders);
    expect(trades).toHaveLength(2);
    expect(trades[0].exits.map((exit) => exit.id)).toEqual(['3']);
    expect(trades[1].exits.map((exit) => exit.id)).toEqual(['4']);
  });

  it('orders numeric times as numbers, not as text', () => {
    // "10:00" sorts before "9:35" as text, which reorders a whole morning and
    // hands the first trade's exits to the second. deriveStrategyPnl records
    // this defect against NinjaTrader's own clock column.
    const orders = [
      { id: '99', instrument: 'MES', name: 'Enter Long', quantity: 2, avgPrice: 100, time: 99 },
      { id: '100', instrument: 'MES', name: 'PT1-Long', quantity: 2, limitPrice: 120, time: 100 },
      { id: '101', instrument: 'MES', name: 'Enter Long', quantity: 2, avgPrice: 200, time: 101 },
      { id: '102', instrument: 'MES', name: 'PT1-Long', quantity: 2, limitPrice: 220, time: 102 },
    ];
    const trades = reconstructTrades(orders);
    expect(trades.map((trade) => trade.exits.map((exit) => exit.id))).toEqual([['100'], ['102']]);
  });

  it('drops an exit that fits no open entry rather than guessing', () => {
    expect(reconstructTrades([{ id: '1', name: 'PT1-Long', limitPrice: 80 }])).toEqual([]);
  });
});

describe('the geometry a trade exhibits', () => {
  it('measures every distance in ticks from the entry fill', () => {
    const geometry = tradeGeometry(reconstructTrades(g4mTrade())[0]);
    expect(geometry.instrument).toBe('MES');
    expect(geometry.stopTicks).toBe(80);
    expect(geometry.rungs.get(1)).toEqual({ ticks: 80, size: 2 });
    expect(geometry.rungs.get(2)).toEqual({ ticks: 120, size: 1 });
    expect(geometry.rungs.get(3)).toEqual({ ticks: 160, size: 1 });
  });

  it('treats a zero as no price, not as a price of zero', () => {
    // An order row holds 0 in the column it does not use. Taking it measures
    // every stop from the instrument's own price: on crude that produced stops
    // 6,411 ticks away and matched nothing whatsoever.
    const orders = [
      { id: '1', instrument: 'MES', name: 'Enter Long', quantity: 2, avgPrice: 5000, limitPrice: 0, time: '001' },
      { id: '2', instrument: 'MES', name: 'PT1-Long', quantity: 2, limitPrice: 5020, stopPrice: 0, time: '002' },
    ];
    expect(tradeGeometry(reconstructTrades(orders)[0]).rungs.get(1)).toEqual({ ticks: 80, size: 2 });
  });

  it('answers nothing when it cannot measure', () => {
    const noFill = [{ id: '1', instrument: 'MES', name: 'Enter Long', quantity: 2, time: '001' }];
    expect(tradeGeometry(reconstructTrades(noFill)[0])).toBeNull();
    const noTick = [
      { id: '1', instrument: 'WHEAT', name: 'Enter Long', quantity: 2, avgPrice: 500, time: '001' },
      { id: '2', instrument: 'WHEAT', name: 'PT1-Long', quantity: 2, limitPrice: 510, time: '002' },
    ];
    expect(tradeGeometry(reconstructTrades(noTick)[0])).toBeNull();
  });
});

describe('matching a geometry to the catalogue', () => {
  const geometry = () => tradeGeometry(reconstructTrades(g4mTrade())[0]);

  it('names the algorithm and the version', () => {
    expect(matchGeometry(geometry(), [G4M])).toMatchObject({ family: 'G4M', version: 'v1' });
  });

  it('matches a trade that was stopped before its third target', () => {
    // THE DEFECT THIS EXISTS FOR. Requiring all three declared rungs meant only
    // 446 of 4,782 real trades could match and 5% of seven months was
    // recognised. Comparing what the trade actually placed took it to 55%.
    const partial = g4mTrade().filter((order) => order.name !== 'PT3-Short');
    const match = matchGeometry(tradeGeometry(reconstructTrades(partial)[0]), [G4M]);
    expect(match.family).toBe('G4M');
  });

  it('matches although the stop moved, because the stop was trailing', () => {
    // A template declares where the stop was PLACED; NinjaTrader rewrites that
    // price as the trail follows the position, so what the CRM stores is where
    // the stop ENDED. Comparing the two rejected 673 trades - 14% of seven
    // months - for a reason that was never a disagreement.
    const trailed = g4mTrade().map((order) => (
      order.name === 'Stop Short' ? { ...order, stopPrice: 7691.25 + 5 } : order
    ));
    const match = matchGeometry(tradeGeometry(reconstructTrades(trailed)[0]), [G4M]);
    expect(match).toMatchObject({ family: 'G4M', version: 'v1' });
  });

  it('lets the stop pick the version when that is all that separates two', () => {
    // Measured across the desk's whole library: exactly 3 template groups share
    // their targets and differ only in their stop, and none of the three crosses
    // families. So the stop separates versions, and here it still does.
    const wider = { ...G4M, version: 'v2', stopTicks: 120 };
    expect(matchGeometry(geometry(), [G4M, wider])).toMatchObject({ family: 'G4M', version: 'v1' });
  });

  it('answers the algorithm with no version when the stop picks out neither', () => {
    const a = { ...G4M, version: 'v1', stopTicks: 100 };
    const b = { ...G4M, version: 'v2', stopTicks: 120 };
    const match = matchGeometry(geometry(), [a, b]);
    expect(match.family).toBe('G4M');
    expect(match.version).toBeNull();
  });

  it('will not name an algorithm from a stop alone', () => {
    // No target ever went on, so the only evidence is one distance, and a great
    // many templates sit at any given distance.
    const entry = 7691.25;
    const stopOnly = [
      { id: '1', instrument: 'MES', name: 'Enter Short', quantity: 4, avgPrice: entry, time: '001' },
      { id: '2', instrument: 'MES', name: 'Stop Short', quantity: 4, stopPrice: entry + 20, time: '002' },
    ];
    expect(matchGeometry(tradeGeometry(reconstructTrades(stopOnly)[0]), [G4M])).toBeNull();
  });

  it('refuses five ticks out, because that is another version', () => {
    const other = { ...G4M, version: 'v2', target1Ticks: 85 };
    expect(matchGeometry(geometry(), [other])).toBeNull();
  });

  it('answers the algorithm with no version when two versions share a geometry', () => {
    // Measured: of 50 family/instrument/risk groups, 33 change geometry between
    // versions and 17 do not.
    const match = matchGeometry(geometry(), [G4M, { ...G4M, version: 'v2' }]);
    expect(match.family).toBe('G4M');
    expect(match.version).toBeNull();
  });

  it('an algorithm and its own prop firm variant are one answer', () => {
    // Measured: 105 of 173 fingerprints were shared by exactly two families and
    // every pair was an algorithm and its _PF. No two different algorithms
    // collided.
    const match = matchGeometry(geometry(), [G4M, { ...G4M, propFirm: true }]);
    expect(match).toMatchObject({ family: 'G4M', candidates: 2 });
  });

  it('two different algorithms sharing a geometry answer neither', () => {
    expect(matchGeometry(geometry(), [G4M, { ...G4M, family: 'URGO' }])).toBeNull();
  });

  it('another instrument is another strategy', () => {
    expect(matchGeometry(geometry(), [{ ...G4M, instrument: 'MNQ' }])).toBeNull();
  });
});

describe('attributing a book', () => {
  it('lets the platform\'s own answer win over anything worked out', () => {
    const orders = g4mTrade().map((order, index) => (
      index === 1 ? { ...order, strategyName: 'Something Else' } : order
    ));
    const rows = attributeOrders(orders, [G4M]);
    const recorded = rows.find((row) => row.id === '2');
    expect(recorded).toMatchObject({ family: 'Something Else', basis: 'record' });
    expect(rows.find((row) => row.id === '1')).toMatchObject({ family: 'G4M', basis: 'inferred' });
  });

  it('writes nothing for an order it cannot answer', () => {
    // Absence is the honest answer, and the column stays null.
    expect(attributeOrders(g4mTrade(), [])).toEqual([]);
  });

  it('survives an empty book', () => {
    expect(attributeOrders([], [G4M])).toEqual([]);
    expect(attributeOrders(undefined, undefined)).toEqual([]);
    expect(reconstructTrades(null)).toEqual([]);
  });
});
