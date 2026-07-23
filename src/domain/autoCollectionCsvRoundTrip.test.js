import { describe, expect, it, vi } from 'vitest';
import snapshot from '../../test/fixtures/auto-export/snapshot-v1.json';
import { csvForSection } from '../../api/_lib/autoExportDownload.js';
import { normalizeAutoImportSnapshot } from './autoImport.js';
import { parseNinjaTraderCsvText } from './csvImport.js';
import { reconcileDailyImport } from './reconcile.js';

const sections = ['accounts', 'strategies', 'orders', 'executions'];

function registry() {
  return {
    'SIM-REDACTED-01': {
      accountName: 'SIM-REDACTED-01', alias: 'Simulation 01', connection: 'Simulated Data Feed',
      accountType: 'Cash', status: 'Active', payoutState: 'Not requested',
    },
  };
}

describe('downloaded four-CSV round trip', () => {
  it('recognizes every canonical CSV by headers and preserves reconciliation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T21:00:00.000Z'));
    try {
      const parsedFiles = sections.map((section) =>
        parseNinjaTraderCsvText(csvForSection(section, snapshot[section]), `${section}.csv`));
      expect(parsedFiles.map((file) => file.type)).toEqual(sections);
      expect(parsedFiles.every((file) => file.errors.length === 0)).toBe(true);

      const manualParsed = Object.fromEntries(parsedFiles.map((file) => [file.type, file.rows]));
      const automatic = normalizeAutoImportSnapshot(snapshot);
      const inputs = { clientId: 'client-1', date: snapshot.tradingDate, registry: registry() };
      const manualResult = reconcileDailyImport({ ...inputs, parsed: manualParsed });
      const automaticResult = reconcileDailyImport({ ...inputs, parsed: automatic.parsed });

      expect(manualResult.snapshots).toEqual(automaticResult.snapshots);
      expect(manualResult.strategies).toEqual(automaticResult.strategies);
      expect(manualResult.orders).toEqual(automaticResult.orders);
      expect(manualResult.executions).toEqual(automaticResult.executions);
      const stableFlags = (flags) => flags.map((flag) => ({
        type: flag.type, severity: flag.severity, accountName: flag.accountName,
        message: flag.message, status: flag.status,
      }));
      expect(stableFlags(manualResult.flags)).toEqual(stableFlags(automaticResult.flags));
    } finally {
      vi.useRealTimers();
    }
  });
});
