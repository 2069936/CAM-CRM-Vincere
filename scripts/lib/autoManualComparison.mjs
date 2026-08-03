import { normalizeAutoImportSnapshot } from '../../src/domain/autoImport.js';
import { parseNinjaTraderCsvText } from '../../src/domain/csvImport.js';
import { summarizePnlSources } from '../../src/domain/pnlSourceSummary.js';
import { reconcileDailyImport } from '../../src/domain/reconcile.js';
import { normalizeManualGridFile, selectDailyPnl } from './manualGridNormalization.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECTIONS = ['accounts', 'strategies', 'orders', 'executions'];
const FIELD_POLICY = {
  accounts: {
    required: ['accountName', 'grossRealizedPnl', 'accountBalance'],
    optional: ['connection', 'trailingMaxDrawdown', 'weeklyPnl', 'unrealizedPnl'],
  },
  strategies: {
    required: ['accountName', 'strategyName', 'instrument', 'enabled', 'parametersRaw'],
    optional: ['dataSeries', 'direction', 'realized', 'unrealized', 'connection'],
  },
  orders: {
    required: ['id', 'accountName', 'instrument', 'action', 'orderType', 'quantity', 'state'],
    optional: ['strategyName', 'filled', 'remaining', 'limit', 'stop', 'avgPrice', 'time', 'name'],
  },
  executions: {
    required: ['id', 'orderId', 'accountName', 'instrument', 'action', 'quantity', 'price', 'time'],
    optional: ['strategyName', 'entryExit', 'position', 'name', 'commission', 'rate', 'connection'],
  },
};

function normalizedText(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function rowKey(section, row) {
  if (section === 'accounts') return normalizedText(row.accountName);
  if (section === 'strategies') return [row.accountName, row.strategyName, row.instrument].map(normalizedText).join('|');
  if (section === 'orders') return normalizedText(row.id) || [row.accountName, row.time, row.instrument].map(normalizedText).join('|');
  if (section === 'executions') return normalizedText(row.id) || [row.accountName, row.orderId, row.time, row.price].map(normalizedText).join('|');
  return '';
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function comparable(field, value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(stableObject(value));
  const text = String(value).trim();
  if (['time', 'startedAt'].includes(field)) {
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
  }
  const numeric = Number(text.replace(/[$,]/g, ''));
  if (text !== '' && Number.isFinite(numeric) && /^\(?[-+$]?\d[\d,.]*\)?$/.test(text)) return numeric;
  return text.toLocaleLowerCase('en-US');
}

function sectionRows(importResult, section) {
  return section === 'accounts' ? importResult.snapshots || [] : importResult[section] || [];
}

function indexedRows(section, rows) {
  const index = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = rowKey(section, row);
    if (!key || index.has(key)) duplicateRows += 1;
    else index.set(key, row);
  }
  return { index, duplicateRows };
}

function compareSection(section, autoRows, manualRows) {
  const auto = indexedRows(section, autoRows);
  const manual = indexedRows(section, manualRows);
  const result = {
    autoRows: autoRows.length,
    manualRows: manualRows.length,
    matchedRows: 0,
    missingAutoRows: 0,
    missingManualRows: 0,
    duplicateAutoRows: auto.duplicateRows,
    duplicateManualRows: manual.duplicateRows,
    requiredMismatches: 0,
    optionalDifferences: 0,
  };
  for (const key of new Set([...auto.index.keys(), ...manual.index.keys()])) {
    const autoRow = auto.index.get(key);
    const manualRow = manual.index.get(key);
    if (!autoRow) { result.missingAutoRows += 1; continue; }
    if (!manualRow) { result.missingManualRows += 1; continue; }
    result.matchedRows += 1;
    for (const field of FIELD_POLICY[section].required) {
      if (!Object.is(comparable(field, autoRow[field]), comparable(field, manualRow[field]))) {
        result.requiredMismatches += 1;
      }
    }
    for (const field of FIELD_POLICY[section].optional) {
      if (!Object.is(comparable(field, autoRow[field]), comparable(field, manualRow[field]))) {
        result.optionalDifferences += 1;
      }
    }
  }
  return result;
}

function flagSignature(flag) {
  return [flag?.type, flag?.severity, flag?.accountName, flag?.message, flag?.status]
    .map(normalizedText).join('|');
}

function compareFlags(autoFlags, manualFlags) {
  const auto = new Set((autoFlags || []).map(flagSignature));
  const manual = new Set((manualFlags || []).map(flagSignature));
  return {
    autoFlags: autoFlags?.length || 0,
    manualFlags: manualFlags?.length || 0,
    matchedFlags: [...auto].filter((key) => manual.has(key)).length,
    missingAutoFlags: [...manual].filter((key) => !auto.has(key)).length,
    missingManualFlags: [...auto].filter((key) => !manual.has(key)).length,
  };
}

function pnlComparison(snapshot, accountCsv) {
  const manual = normalizeManualGridFile(accountCsv || '', 'accounts.csv');
  const autoRows = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const autoByAccount = new Map(autoRows.map((row) => [normalizedText(row.accountName), row]));
  const manualByAccount = new Map((manual.rows || []).map((row) => [normalizedText(row.accountName), row]));
  let matchedAccounts = 0;
  let mismatchedAccounts = 0;
  const autoSources = summarizePnlSources(autoRows.map((row) => ({
    pnlSource: selectDailyPnl(row).source,
  })));
  const manualSelections = [...manualByAccount.values()].map((row) => ({ row, selected: selectDailyPnl(row) }));
  const manualSources = summarizePnlSources(manualSelections.map(({ selected }) => ({ pnlSource: selected.source })));
  for (const [account, autoRow] of autoByAccount) {
    const manualRow = manualByAccount.get(account);
    if (!manualRow || !Object.is(selectDailyPnl(autoRow).value, selectDailyPnl(manualRow).value)) mismatchedAccounts += 1;
    else matchedAccounts += 1;
  }
  mismatchedAccounts += [...manualByAccount.keys()].filter((account) => !autoByAccount.has(account)).length;
  return { matchedAccounts, mismatchedAccounts, autoSources, manualSources };
}

function captureWindow(autoCapturedAt, manualCapturedAt) {
  const auto = Date.parse(autoCapturedAt);
  const manual = Date.parse(manualCapturedAt);
  if (Number.isNaN(auto) || Number.isNaN(manual)) return 'invalid';
  return Math.floor(auto / 60_000) === Math.floor(manual / 60_000) ? 'same-minute' : 'different-minute';
}

export function compareAutoAndManual({
  expectedClientUuid,
  autoClientUuid,
  manualCapturedAt,
  snapshot,
  manualFiles,
  registry = {},
} = {}) {
  if (!UUID.test(String(expectedClientUuid || '')) || !UUID.test(String(autoClientUuid || ''))) {
    throw new Error('comparison_client_uuid_invalid');
  }
  if (!manualFiles || typeof manualFiles !== 'object' || Array.isArray(manualFiles)) {
    throw new Error('comparison_manual_files_invalid');
  }
  const failures = [];
  const clientRouting = expectedClientUuid.toLowerCase() === autoClientUuid.toLowerCase() ? 'matched' : 'mismatch';
  if (clientRouting === 'mismatch') failures.push('client_routing_mismatch');
  const window = captureWindow(snapshot?.capturedAt, manualCapturedAt);
  if (window !== 'same-minute') failures.push('capture_minute_mismatch');

  let automatic;
  try {
    automatic = normalizeAutoImportSnapshot(snapshot);
  } catch {
    failures.push('automatic_contract_invalid');
  }
  const parsedManual = {};
  for (const section of SECTIONS) {
    const file = parseNinjaTraderCsvText(String(manualFiles[section] || ''), `${section}.csv`);
    if (file.type !== section || file.errors.length > 0) failures.push(`manual_${section}_invalid`);
    parsedManual[section] = file.type === section ? file.rows : [];
  }

  const date = automatic?.date || snapshot?.tradingDate;
  let autoImport = { snapshots: [], strategies: [], orders: [], executions: [], flags: [] };
  let manualImport = { snapshots: [], strategies: [], orders: [], executions: [], flags: [] };
  if (automatic) {
    autoImport = reconcileDailyImport({ clientId: expectedClientUuid, date, registry, parsed: automatic.parsed });
    manualImport = reconcileDailyImport({ clientId: expectedClientUuid, date, registry, parsed: parsedManual });
  }

  const sections = {};
  for (const section of SECTIONS) {
    sections[section] = compareSection(section, sectionRows(autoImport, section), sectionRows(manualImport, section));
    if (sections[section].missingManualRows > 0) failures.push(`${section}_missing_manual_rows`);
    if (sections[section].missingAutoRows > 0) failures.push(`${section}_missing_automatic_rows`);
    if (sections[section].duplicateAutoRows + sections[section].duplicateManualRows > 0) failures.push(`${section}_duplicate_rows`);
    if (sections[section].requiredMismatches > 0) failures.push(`${section}_required_field_mismatch`);
  }

  const flags = compareFlags(autoImport.flags, manualImport.flags);
  if (flags.missingAutoFlags + flags.missingManualFlags > 0) failures.push('reconciled_flags_mismatch');
  const pnl = pnlComparison(snapshot, manualFiles.accounts);
  if (pnl.mismatchedAccounts > 0) failures.push('reconciled_pnl_mismatch');

  const stableFailures = [...new Set(failures)].sort();
  return {
    schemaVersion: 1,
    ok: stableFailures.length === 0,
    clientRouting,
    captureWindow: window,
    sections,
    pnl,
    flags,
    failures: stableFailures,
  };
}
