import { describe, expect, it } from 'vitest';
import snapshot from '../../test/fixtures/auto-export/snapshot-v1.json';
import { validateAutoExportSnapshot } from './autoExportContract.js';

const requiredKeys = {
  accounts: ['accountName'],
  strategies: ['strategyId', 'strategyName', 'accountName', 'instrument', 'state', 'parameterCaptureStatus'],
  orders: ['orderId', 'accountName', 'instrument', 'action', 'orderType', 'quantity', 'state'],
  executions: ['executionId', 'accountName', 'instrument', 'action', 'quantity', 'price', 'time'],
};

const numericOrNullKeys = {
  accounts: ['netLiquidation', 'cashValue', 'realizedPnl', 'grossRealizedPnl', 'unrealizedPnl', 'totalPnl', 'weeklyPnl', 'buyingPower', 'excessIntradayMargin', 'initialMargin', 'maintenanceMargin'],
  strategies: ['quantity', 'averagePrice', 'realizedPnl', 'unrealizedPnl'],
  orders: ['quantity', 'filled', 'remaining', 'limitPrice', 'stopPrice', 'averageFillPrice'],
  executions: ['quantity', 'price', 'commission', 'fee', 'realizedPnl'],
};

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

describe('auto-export snapshot v1 contract', () => {
  it('accepts the canonical v1 fixture', () => {
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      captureId: expect.any(String),
      capturedAt: expect.stringMatching(isoTimestamp),
      tradingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      timeZone: expect.any(String),
      source: expect.objectContaining({
        machineId: expect.any(String),
        agentVersion: expect.any(String),
        addonVersion: expect.any(String),
        ninjaTraderVersion: expect.any(String),
      }),
    });

    for (const section of Object.keys(requiredKeys)) {
      expect(snapshot[section]).toBeInstanceOf(Array);
      expect(snapshot[section]).not.toHaveLength(0);
      for (const row of snapshot[section]) {
        expect(row).toEqual(expect.objectContaining(Object.fromEntries(requiredKeys[section].map((key) => [key, expect.anything()]))));
        for (const key of numericOrNullKeys[section]) {
          expect(row[key] === null || typeof row[key] === 'number').toBe(true);
        }
      }
    }

    expect(snapshot.strategies[0].parameters).toEqual(expect.any(Object));
    expect(snapshot.orders[0].remaining).toBeGreaterThan(0);
    expect(snapshot.executions[0]).toEqual(expect.objectContaining({ commission: expect.any(Number), fee: expect.any(Number) }));
    for (const timestamp of [snapshot.strategies[0].startedAt, snapshot.orders[0].time, snapshot.executions[0].time]) {
      expect(timestamp === null || isoTimestamp.test(timestamp)).toBe(true);
    }

    expect(validateAutoExportSnapshot(snapshot)).toEqual({ ok: true, errors: [] });
  });

  it('rejects formatted money and missing row identifiers', () => {
    const invalid = structuredClone(snapshot);
    invalid.accounts[0].realizedPnl = '$12.00';
    delete invalid.orders[0].orderId;
    expect(validateAutoExportSnapshot(invalid).errors).toEqual(
      expect.arrayContaining([
        'accounts[0].realizedPnl must be a number or null',
        'orders[0].orderId is required',
      ]),
    );
  });

  it('rejects calendar-invalid ISO timestamps', () => {
    const invalid = structuredClone(snapshot);
    invalid.strategies[0].startedAt = '2026-02-31T09:30:00-04:00';

    expect(validateAutoExportSnapshot(invalid).errors).toEqual(
      expect.arrayContaining([
        'strategies[0].startedAt must be an ISO-8601 timestamp with an offset or null',
      ]),
    );
  });

  it.each([
    '2026-02-28T24:00:00-04:00',
    '2026-02-28T23:60:00-04:00',
    '2026-02-28T23:59:60-04:00',
    '2026-02-28T23:59:59+14:01',
    '2026-02-28T23:59:59+15:00',
  ])('rejects ISO timestamps with invalid clock or offset component: %s', (timestamp) => {
    const invalid = structuredClone(snapshot);
    invalid.strategies[0].startedAt = timestamp;

    expect(validateAutoExportSnapshot(invalid).errors).toEqual(
      expect.arrayContaining([
        'strategies[0].startedAt must be an ISO-8601 timestamp with an offset or null',
      ]),
    );
  });

  it('accepts 23:59:59 with the conservative maximum +14:00 offset', () => {
    const valid = structuredClone(snapshot);
    valid.strategies[0].startedAt = '2026-02-28T23:59:59+14:00';

    expect(validateAutoExportSnapshot(valid)).toEqual({ ok: true, errors: [] });
  });
});
