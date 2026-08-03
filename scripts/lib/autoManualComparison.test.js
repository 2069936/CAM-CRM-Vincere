import { describe, expect, it } from 'vitest';
import fixture from '../../test/fixtures/auto-export/snapshot-v1.json';
import { csvForSection } from '../../server/apiLib/autoExportDownload.js';
import { compareAutoAndManual } from './autoManualComparison.mjs';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const SECTIONS = ['accounts', 'strategies', 'orders', 'executions'];

function snapshot() {
  const value = structuredClone(fixture);
  const accountName = 'LIVE-REDACTED-01';
  value.accounts[0].accountName = accountName;
  value.accounts[0].displayName = accountName;
  value.strategies[0].accountName = accountName;
  value.orders[0].accountName = accountName;
  value.executions[0].accountName = accountName;
  return value;
}

function registry(accountName = 'LIVE-REDACTED-01') {
  return {
    [accountName]: {
      accountName,
      alias: 'Redacted account',
      connection: 'Simulated Data Feed',
      accountType: 'Cash',
      status: 'Active',
      payoutState: 'Not requested',
    },
  };
}

function manualFiles(value) {
  return Object.fromEntries(SECTIONS.map((section) => [section, csvForSection(section, value[section])]));
}

function input(overrides = {}) {
  const autoSnapshot = snapshot();
  return {
    expectedClientUuid: CLIENT_ID,
    autoClientUuid: CLIENT_ID,
    manualCapturedAt: '2026-07-23T16:45:40-04:00',
    snapshot: autoSnapshot,
    manualFiles: manualFiles(autoSnapshot),
    registry: registry(),
    ...overrides,
  };
}

describe('redacted automatic versus manual shadow comparison', () => {
  it('accepts reordered rows and normalized numeric and timestamp representations', () => {
    const autoSnapshot = snapshot();
    const second = structuredClone(autoSnapshot.accounts[0]);
    second.accountName = 'LIVE-REDACTED-02';
    second.displayName = 'LIVE-REDACTED-02';
    second.cashValue = 1000;
    second.realizedPnl = 5;
    second.grossRealizedPnl = 7;
    autoSnapshot.accounts.push(second);
    const files = manualFiles(autoSnapshot);
    const lines = files.accounts.replace(/\r/g, '').trimEnd().split('\n');
    files.accounts = [lines[0], lines[2], lines[1]].join('\r\n')
      .replace('51245.75', '"51,245.750"')
      .replace('2026-07-23T16:44:46-04:00', '7/23/2026 4:44:46 PM');

    const report = compareAutoAndManual(input({
      snapshot: autoSnapshot,
      manualFiles: files,
      registry: { ...registry(), ...registry('LIVE-REDACTED-02') },
    }));

    expect(report).toMatchObject({
      ok: true,
      clientRouting: 'matched',
      captureWindow: 'same-minute',
      failures: [],
      sections: { accounts: { autoRows: 2, manualRows: 2, missingAutoRows: 0, missingManualRows: 0 } },
    });
    expect(JSON.stringify(report)).not.toMatch(/live-redacted|51245|20120|11111111/i);
  });

  it('records gross fallback parity without exposing the account or PnL value', () => {
    const autoSnapshot = snapshot();
    autoSnapshot.accounts[0].realizedPnl = 0;
    autoSnapshot.accounts[0].grossRealizedPnl = 140.25;
    const report = compareAutoAndManual(input({
      snapshot: autoSnapshot,
      manualFiles: manualFiles(autoSnapshot),
    }));

    expect(report).toMatchObject({
      ok: true,
      pnl: {
        matchedAccounts: 1,
        mismatchedAccounts: 0,
        autoSources: { gross_fallback: 1 },
        manualSources: { gross_fallback: 1 },
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/140\.25|live-redacted/i);
  });

  it('tolerates missing optional fields but fails a missing required row', () => {
    const autoSnapshot = snapshot();
    const files = manualFiles(autoSnapshot);
    files.accounts = files.accounts.split('\n').map((line) => line.split(',').filter((_value, index) => index !== 9).join(',')).join('\n');
    const optional = compareAutoAndManual(input({ snapshot: autoSnapshot, manualFiles: files }));
    expect(optional.ok).toBe(true);
    expect(optional.sections.accounts.optionalDifferences).toBeGreaterThan(0);

    const missing = manualFiles(autoSnapshot);
    missing.orders = `${missing.orders.split('\n')[0]}\n`;
    const failed = compareAutoAndManual(input({ snapshot: autoSnapshot, manualFiles: missing }));
    expect(failed.ok).toBe(false);
    expect(failed.failures).toContain('orders_missing_manual_rows');
    expect(failed.sections.orders).toMatchObject({ autoRows: 1, manualRows: 0, missingManualRows: 1 });
  });

  it('fails closed on cross-client routing and a different capture minute', () => {
    const report = compareAutoAndManual(input({
      autoClientUuid: OTHER_CLIENT_ID,
      manualCapturedAt: '2026-07-23T16:47:00-04:00',
    }));
    expect(report).toMatchObject({
      ok: false,
      clientRouting: 'mismatch',
      captureWindow: 'different-minute',
    });
    expect(report.failures).toEqual(expect.arrayContaining(['client_routing_mismatch', 'capture_minute_mismatch']));
    expect(JSON.stringify(report)).not.toMatch(/11111111|22222222/);
  });
});
