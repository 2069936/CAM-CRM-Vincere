import { describe, expect, it, vi } from 'vitest';
import snapshot from '../../test/fixtures/auto-export/snapshot-v1.json';
import { csvForSection } from '../../api/_lib/autoExportDownload.js';
import { normalizeAutoImportSnapshot } from './autoImport.js';
import { parseNinjaTraderCsvText } from './csvImport.js';
import { reconcileDailyImport } from './reconcile.js';

const sections = ['accounts', 'strategies', 'orders', 'executions'];

// The shared wire fixture uses SIM-REDACTED-01, and reconcile drops any account
// whose name starts with "sim" as a simulator. Comparing the two paths on that
// fixture as-is compares four empty arrays, which passes no matter how badly
// they diverge. Rename the account for this test so real rows survive
// reconciliation; the fixture itself stays frozen for the wire-contract tests.
const LIVE_ACCOUNT = 'ROME-7045';

function withLiveAccountName(value) {
  if (Array.isArray(value)) return value.map(withLiveAccountName);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      key === 'accountName' && entry === 'SIM-REDACTED-01' ? LIVE_ACCOUNT : withLiveAccountName(entry),
    ]));
  }
  return value;
}

// Fields only the automatic path can carry, plus the two the CSV round trip
// drops on the way out. Compared separately below so they stay visible instead
// of being silently equalised away.
const AUTO_ONLY = new Set([
  'pnlSource', 'rawGrossRealizedPnl', 'rawRealizedPnl', 'realizedPnl', 'selectedPnl',
  'averagePrice', 'id', 'parameterCaptureStatus', 'position', 'startedAt', 'state', 'sync',
  'nativeId', 'fee', 'strategyId',
  // Not carried by the canonical CSV headers, so the manual path reads them empty.
  'connectionStatus', 'connection',
]);

// The two paths disagree on how "no value" is spelled: the JSON keeps null, the
// CSV parser coerces to 0 / "". Behaviourally identical everywhere the CRM reads
// them (Number(x || 0)), so compare them as the same absence.
function blank(value) {
  return value === null || value === undefined || value === '' || value === 0;
}

// Recursive: a reconciled snapshot nests its strategies, which need the same
// treatment as the row that holds them.
function shared(value) {
  if (Array.isArray(value)) return value.map(shared);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !AUTO_ONLY.has(key))
        .map(([key, entry]) => [key, shared(entry)]),
    );
  }
  return blank(value) ? null : value;
}

function registry() {
  return {
    [LIVE_ACCOUNT]: {
      accountName: LIVE_ACCOUNT, alias: 'Rome 7045', connection: 'Simulated Data Feed',
      accountType: 'Cash', status: 'Active', payoutState: 'Not requested',
    },
  };
}

describe('downloaded four-CSV round trip', () => {
  it('recognizes every canonical CSV by headers and preserves reconciliation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T21:00:00.000Z'));
    try {
      const live = withLiveAccountName(snapshot);
      const parsedFiles = sections.map((section) =>
        parseNinjaTraderCsvText(csvForSection(section, live[section]), `${section}.csv`));
      expect(parsedFiles.map((file) => file.type)).toEqual(sections);
      expect(parsedFiles.every((file) => file.errors.length === 0)).toBe(true);

      const manualParsed = Object.fromEntries(parsedFiles.map((file) => [file.type, file.rows]));
      const automatic = normalizeAutoImportSnapshot(live);
      const inputs = { clientId: 'client-1', date: live.tradingDate, registry: registry() };
      const manualResult = reconcileDailyImport({ ...inputs, parsed: manualParsed });
      const automaticResult = reconcileDailyImport({ ...inputs, parsed: automatic.parsed });

      // Guard the comparison itself: if reconciliation ever drops these rows
      // again, fail loudly instead of silently comparing empty arrays.
      expect(manualResult.snapshots.length).toBeGreaterThan(0);
      expect(manualResult.strategies.length).toBeGreaterThan(0);
      expect(manualResult.orders.length).toBeGreaterThan(0);
      expect(manualResult.executions.length).toBeGreaterThan(0);

      // Compare what the CRM actually stores and reads. The JSON snapshot is
      // richer than four CSV grids — it also carries native ids, capture state,
      // per-strategy timestamps and the PnL-source audit trail, none of which a
      // grid can express. That enrichment is expected; what must not drift is
      // the value of every field both paths produce.
      expect(shared(manualResult.snapshots)).toEqual(shared(automaticResult.snapshots));
      expect(shared(manualResult.strategies)).toEqual(shared(automaticResult.strategies));
      expect(shared(manualResult.orders)).toEqual(shared(automaticResult.orders));
      expect(shared(manualResult.executions)).toEqual(shared(automaticResult.executions));
      // The automatic path is a superset, not a different reading of the same
      // data. Lock that: if the collector stops emitting its richer fields, the
      // comparison above would still pass, so assert them here.
      expect(automaticResult.snapshots[0].pnlSource).toBe('realized');
      expect(automaticResult.snapshots[0].strategies[0].id).toBeTruthy();
      expect(automaticResult.executions[0].nativeId).toBeTruthy();

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
