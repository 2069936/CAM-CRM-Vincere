import { describe, expect, it } from 'vitest';
import snapshotFixture from '../../test/fixtures/auto-export/snapshot-v1.json';
import { reconcileDailyImport } from './reconcile.js';
import {
  AutoImportValidationError,
  normalizeAutoImportSnapshot,
  selectDailyPnl,
} from './autoImport.js';

function snapshotWithLiveAccount() {
  const snapshot = structuredClone(snapshotFixture);
  const accountName = 'LIVE-REDACTED-01';
  snapshot.accounts[0].accountName = accountName;
  snapshot.strategies[0].accountName = accountName;
  snapshot.orders[0].accountName = accountName;
  snapshot.executions[0].accountName = accountName;
  return snapshot;
}

function expectValidationFailure(snapshot, code = 'invalid_auto_import_snapshot') {
  expect(() => normalizeAutoImportSnapshot(snapshot)).toThrow(AutoImportValidationError);
  try {
    normalizeAutoImportSnapshot(snapshot);
  } catch (error) {
    expect(error).toMatchObject({ code, errors: expect.any(Array) });
    return error;
  }
  throw new Error('expected normalization to throw');
}

describe('selectDailyPnl', () => {
  it('prefers realized unless it reset to zero while gross is non-zero', () => {
    expect(selectDailyPnl({ realizedPnl: 125, grossRealizedPnl: 140 }))
      .toEqual({ value: 125, source: 'realized' });
    expect(selectDailyPnl({ realizedPnl: 0, grossRealizedPnl: 140 }))
      .toEqual({ value: 140, source: 'gross_fallback' });
    expect(selectDailyPnl({ realizedPnl: 0, grossRealizedPnl: 0 }))
      .toEqual({ value: 0, source: 'realized' });
  });

  it('does not silently treat a missing realized P&L as zero', () => {
    expect(selectDailyPnl({ realizedPnl: null, grossRealizedPnl: 140 }))
      .toEqual({ value: 140, source: 'gross_missing_realized' });
    expect(selectDailyPnl({ realizedPnl: null, grossRealizedPnl: 0 }))
      .toEqual({ value: 0, source: 'gross_missing_realized' });
  });
});

describe('normalizeAutoImportSnapshot', () => {
  it('maps the v1 fixture into manual-compatible reconcile input', () => {
    const normalized = normalizeAutoImportSnapshot(snapshotWithLiveAccount());

    expect(normalized).toMatchObject({ date: '2026-07-23' });
    expect(normalized.parsed.accounts).toEqual([
      expect.objectContaining({
        accountName: 'LIVE-REDACTED-01',
        connection: 'Simulated Data Feed',
        accountBalance: 51245.75,
        grossRealizedPnl: 125.5,
        realizedPnl: 125.5,
        rawGrossRealizedPnl: 140.25,
        pnlSource: 'realized',
        trailingMaxDrawdown: null,
      }),
    ]);
    expect(normalized.parsed.strategies).toEqual([
      expect.objectContaining({
        id: 'strategy-redacted-01',
        strategyName: 'RBO-1.8',
        strategyFamily: 'RBO',
        strategyVersion: '1.8',
        accountName: 'LIVE-REDACTED-01',
        direction: 'Long',
        enabled: true,
        parametersRaw: '{"MyTradeDirection":"Long","OptionalSignal":null,"PositionSize":1,"ProfitTargetTicks":40,"UseTrailingStop":true}',
        params: expect.objectContaining({
          parsed: true,
          valuesByName: snapshotFixture.strategies[0].parameters,
          direction: 'Long',
          posSizes: [1],
          profitTargets: [40],
        }),
      }),
    ]);
    expect(normalized.parsed.orders).toEqual([
      expect.objectContaining({
        id: 'order-redacted-01', limit: 20120.25, stop: null, avgPrice: 20120.25,
      }),
    ]);
    expect(normalized.parsed.executions).toEqual([
      expect.objectContaining({
        id: 'execution-redacted-01', commission: 1.24, fee: null, rate: 1,
      }),
    ]);
    expect(normalized.metadata).toMatchObject({
      sectionCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
      missingSections: [],
      emptySections: [],
      isComplete: true,
      captureId: snapshotFixture.captureId,
      timeZone: 'America/New_York',
      source: snapshotFixture.source,
      accountPnl: {
        'LIVE-REDACTED-01': {
          realizedPnl: 125.5,
          grossRealizedPnl: 140.25,
          selectedPnl: 125.5,
          pnlSource: 'realized',
        },
      },
    });

    const dailyImport = reconcileDailyImport({
      clientId: 'client-1', date: normalized.date, registry: {}, parsed: normalized.parsed,
    });
    expect(dailyImport.snapshots).toEqual([
      expect.objectContaining({ accountName: 'LIVE-REDACTED-01', grossRealizedPnl: 125.5 }),
    ]);
  });

  it('preserves the additional NinjaTrader grid fields used by manual imports', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.accounts[0].trailingMaxDrawdown = -1750.25;
    Object.assign(snapshot.strategies[0], {
      dataSeries: 'NQ 1 Minute',
      sync: true,
      connectionName: 'Strategy connection',
    });
    Object.assign(snapshot.executions[0], {
      entryExit: 'Entry',
      name: 'Long entry',
      rate: 1,
      connectionName: 'Execution connection',
    });

    const normalized = normalizeAutoImportSnapshot(snapshot);

    expect(normalized.parsed.accounts[0].trailingMaxDrawdown).toBe(-1750.25);
    expect(normalized.parsed.strategies[0]).toMatchObject({
      dataSeries: 'NQ 1 Minute',
      sync: true,
      connection: 'Strategy connection',
    });
    expect(normalized.parsed.executions[0]).toMatchObject({
      entryExit: 'Entry',
      name: 'Long entry',
      rate: 1,
      connection: 'Execution connection',
    });
  });

  it.each(['accounts', 'strategies', 'orders', 'executions'])('keeps a valid empty %s section as incomplete metadata', (section) => {
    const snapshot = snapshotWithLiveAccount();
    snapshot[section] = [];
    if (section === 'accounts') {
      snapshot.strategies = [];
      snapshot.orders = [];
      snapshot.executions = [];
    }

    const normalized = normalizeAutoImportSnapshot(snapshot);

    expect(normalized.parsed[section]).toEqual([]);
    expect(normalized.metadata).toMatchObject({
      sectionCounts: expect.objectContaining({ [section]: 0 }),
      missingSections: [],
      emptySections: section === 'accounts' ? ['accounts', 'strategies', 'orders', 'executions'] : [section],
      isComplete: false,
    });
  });

  it.each(['accounts', 'strategies', 'orders', 'executions'])('rejects a missing required %s section', (section) => {
    const snapshot = snapshotWithLiveAccount();
    delete snapshot[section];

    const error = expectValidationFailure(snapshot);
    expect(error.errors).toContain(`${section} must be an array`);
  });

  it('rejects malformed required numeric values before mapping', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.orders[0].quantity = Number.NaN;

    const error = expectValidationFailure(snapshot);
    expect(error.errors).toContain('orders[0].quantity must be a number or null');
  });

  it('requires the New York time zone and trading date captured in that zone', () => {
    const wrongZone = snapshotWithLiveAccount();
    wrongZone.timeZone = 'UTC';
    expect(expectValidationFailure(wrongZone).errors).toContain('timeZone must be America/New_York');

    const wrongDate = snapshotWithLiveAccount();
    wrongDate.capturedAt = '2026-07-24T00:30:00-04:00';
    expect(expectValidationFailure(wrongDate).errors).toContain('tradingDate must match capturedAt in America/New_York');
  });

  it('rejects duplicate account names case-insensitively after trimming', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.accounts.push({ ...snapshot.accounts[0], accountName: ' live-redacted-01 ' });

    const error = expectValidationFailure(snapshot);
    expect(error.errors).toContain('accounts[1].accountName duplicates accounts[0].accountName');
  });

  it.each([
    ['strategies', 'strategyId'],
    ['orders', 'orderId'],
    ['executions', 'executionId'],
  ])('rejects duplicate %s %s values after trimming', (section, identifier) => {
    const snapshot = snapshotWithLiveAccount();
    snapshot[section].push({ ...snapshot[section][0], [identifier]: ` ${snapshot[section][0][identifier]} ` });

    const error = expectValidationFailure(snapshot);
    expect(error.errors).toContain(`${section}[1].${identifier} duplicates ${section}[0].${identifier}`);
  });

  it('uses the stable unsupported-schema code', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.schemaVersion = 2;

    const error = expectValidationFailure(snapshot, 'unsupported_schema_version');
    expect(error.errors).toContain('schemaVersion must be 1');
  });

  it('maps gross P&L only when realized is zero or missing', () => {
    const fallback = snapshotWithLiveAccount();
    fallback.accounts[0].realizedPnl = 0;
    fallback.accounts[0].grossRealizedPnl = 9;
    expect(normalizeAutoImportSnapshot(fallback).parsed.accounts[0]).toMatchObject({
      grossRealizedPnl: 9,
      pnlSource: 'gross_fallback',
    });

    const missing = snapshotWithLiveAccount();
    missing.accounts[0].realizedPnl = null;
    missing.accounts[0].grossRealizedPnl = 9;
    expect(normalizeAutoImportSnapshot(missing).parsed.accounts[0]).toMatchObject({
      grossRealizedPnl: 9,
      realizedPnl: null,
      pnlSource: 'gross_missing_realized',
    });
  });

  it('preserves explicit account nulls through reconciliation while legacy undefined fields still fall back', () => {
    const snapshot = snapshotWithLiveAccount();
    Object.assign(snapshot.accounts[0], {
      realizedPnl: null,
      grossRealizedPnl: null,
      cashValue: null,
      weeklyPnl: null,
      unrealizedPnl: null,
    });

    const normalized = normalizeAutoImportSnapshot(snapshot);
    const dailyImport = reconcileDailyImport({
      clientId: 'client-null', date: normalized.date, registry: {}, parsed: normalized.parsed,
    });

    expect(dailyImport.snapshots[0]).toMatchObject({
      grossRealizedPnl: null,
      trailingMaxDrawdown: null,
      accountBalance: null,
      weeklyPnl: null,
      unrealizedPnl: null,
    });
  });

  it('canonicalizes cross-section account casing before reconciliation', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.strategies[0].accountName = 'live-redacted-01';
    snapshot.orders[0].accountName = 'live-redacted-01';
    snapshot.executions[0].accountName = 'live-redacted-01';

    const normalized = normalizeAutoImportSnapshot(snapshot);
    expect(normalized.parsed.strategies[0]).toMatchObject({ accountName: 'LIVE-REDACTED-01', connection: 'Simulated Data Feed' });
    expect(normalized.parsed.orders[0].accountName).toBe('LIVE-REDACTED-01');
    expect(normalized.parsed.executions[0].accountName).toBe('LIVE-REDACTED-01');

    const dailyImport = reconcileDailyImport({
      clientId: 'client-case', date: normalized.date, registry: {}, parsed: normalized.parsed,
    });
    expect(dailyImport.snapshots[0].strategies).toHaveLength(1);
  });

  it('rejects references to an account absent from the account section', () => {
    const snapshot = snapshotWithLiveAccount();
    snapshot.orders[0].accountName = 'MISSING-ACCOUNT';

    const error = expectValidationFailure(snapshot);
    expect(error.errors).toContain('orders[0].accountName does not reference an account');
  });
});
