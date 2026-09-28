import { describe, expect, it } from 'vitest';
import { redactCapture } from './captureRedaction';
import { buildOfflineDailyReport } from './offlineReport';
import { renderOfflineReport } from './renderOfflineReport';

const strategy = (overrides = {}) => ({
  strategyId: '1',
  strategyName: '0 - URGO-4.5',
  strategyDisplayName: 'URGO-4.5',
  accountName: 'FUNDED1',
  instrument: 'MNQ DEC26',
  state: 'Realtime',
  quantity: 0,
  position: 'Flat',
  averagePrice: 0,
  realizedPnl: null,
  unrealizedPnl: null,
  enabled: true,
  sync: null,
  dataSeries: '1 Minute',
  connectionName: 'LegendsT',
  startedAt: null,
  parameterCaptureStatus: 'partial',
  parameters: { LicenseKey: null, URGO1: 33, StopLossTicks: 300 },
  // Measured on a real machine: the live licence value is here, not in
  // `parameters`, which held an empty object on that row.
  extraValues: {
    DisplayName: 'URGO-4.5',
    LicenseKey: 'V-9E2B00-2613327C-F8C645W',
    URGO1: 33,
    StopLossTicks: 300,
    ProfitTargetTicks1: 400,
    TradeStartTime: '2020-01-01T09:30:00',
    EdgeLeverage: false,
  },
  ...overrides,
});

const capture = (strategies = [strategy()]) => ({
  schemaVersion: 1,
  captureId: 'c-1',
  capturedAt: '2026-09-28T20:30:00Z',
  tradingDate: '2026-09-28',
  timeZone: 'America/New_York',
  source: { machineId: 'm', agentVersion: '1.1.3', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.6.0' },
  accounts: [{
    accountName: 'FUNDED1',
    connectionName: 'LegendsT',
    displayName: 'FUNDED1',
    netLiquidation: 50000,
    cashValue: 50000,
    realizedPnl: 120,
    grossRealizedPnl: 120,
    unrealizedPnl: 0,
    totalPnl: 120,
    weeklyPnl: 300,
    trailingMaxDrawdown: 1000,
    buyingPower: 100000,
    excessIntradayMargin: 0,
    initialMargin: 0,
    maintenanceMargin: 0,
    currency: 'USD',
    status: 'Active',
    accountValues: { NetLiquidation: 50000, BuyingPower: 100000, TrailingMaxDrawdown: 1000 },
  }],
  strategies,
  orders: [],
  executions: [],
});

describe('what a capture may not carry off the machine', () => {
  it('empties the licence key and the tuning from both maps', () => {
    const text = JSON.stringify(redactCapture(capture()));
    for (const forbidden of [
      'V-9E2B00-2613327C-F8C645W', 'LicenseKey', 'URGO1',
      'StopLossTicks', 'ProfitTargetTicks1', 'TradeStartTime', 'EdgeLeverage',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('still names the algorithm, the instrument and whether it was running', () => {
    // The report exists to say what ran. A redaction that took the name too
    // would be safe and useless.
    const row = redactCapture(capture()).strategies[0];
    expect(row).toMatchObject({
      strategyName: '0 - URGO-4.5',
      instrument: 'MNQ DEC26',
      state: 'Realtime',
      enabled: true,
    });
  });

  /* autoExportContract validates a snapshot before anything reads it and
   * requires `parameters` to be an object. The first version of the C# copy of
   * this rule deleted the property, and every capture with a strategy then
   * rendered "strategies[0].parameters must be an object" where the client's
   * day should have been. */
  it('empties the maps rather than removing them', () => {
    const row = redactCapture(capture()).strategies[0];
    expect(row.parameters).toEqual({});
    expect(row.extraValues).toEqual({});
    expect(row).not.toHaveProperty('parametersRaw');
  });

  it('keeps the client\'s own account figures', () => {
    // accountValues is the other large map in a capture and it is the subject
    // of the report, not the desk's tuning.
    const account = redactCapture(capture()).accounts[0];
    expect(account.accountValues).toEqual({
      NetLiquidation: 50000, BuyingPower: 100000, TrailingMaxDrawdown: 1000,
    });
  });

  it('does not touch the capture it was handed', () => {
    // A caller that goes on to upload the same capture must upload what the
    // machine actually reported.
    const original = capture();
    redactCapture(original);
    expect(original.strategies[0].extraValues.LicenseKey).toBe('V-9E2B00-2613327C-F8C645W');
  });

  it('finds a strategy row wherever it sits', () => {
    const nested = { closes: [{ rows: [strategy()] }] };
    expect(JSON.stringify(redactCapture(nested))).not.toContain('V-9E2B00');
  });

  it('leaves a capture with no strategies alone', () => {
    const empty = capture([]);
    expect(redactCapture(empty)).toEqual(empty);
  });
});

describe('the report still builds from a redacted capture', () => {
  it('renders the day, and names the algorithm, with the tuning gone', () => {
    const built = buildOfflineDailyReport({
      capture: redactCapture(capture()),
      roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
      rosterFetchedAt: '2026-09-28T00:00:00Z',
      clientName: 'Joel Onafowokan',
    });
    const html = renderOfflineReport(built);
    expect(html).not.toMatch(/could not be built/i);
    expect(html).not.toMatch(/must be an object/i);
    expect(html).toContain('Joel Onafowokan');
    expect(html).toMatch(/URGO/);
    expect(html).toMatch(/MNQ DEC26/);
    expect(html).not.toMatch(/LicenseKey|StopLossTicks/);
  });
});
