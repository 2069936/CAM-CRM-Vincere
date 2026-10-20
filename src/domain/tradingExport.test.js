import { describe, expect, it } from 'vitest';
import {
  FIRST_SLIM_EXPORT_AGENT,
  TRADING_EXPORT_DATASETS,
  TRADING_EXPORT_MAX_BYTES,
  TRADING_EXPORT_STATUSES,
  TRADING_EXPORT_STATUS_LABELS,
  TRADING_EXPORT_TOO_OLD_COPY,
  canSendTradingExport,
  chunkIds,
  describeExportRange,
  describeTradingExport,
  formatExportBytes,
  formatExportDate,
  isIsoDate,
  normalizeDatasets,
  tradingExportFileName,
  tradingExportRequestWords,
} from './tradingExport';

/* The one place that says which agent can send a slim export, and what each
 * export says in words. The request route and the Data lab page both read it. */

const DASHES = /[‒–—―]/;

describe('the vocabulary', () => {
  it('names the first agent, the four datasets, the seven statuses and the 25 MiB limit', () => {
    expect(FIRST_SLIM_EXPORT_AGENT).toBe('1.4.0');
    expect(TRADING_EXPORT_DATASETS).toEqual(['executions', 'orders', 'strategies', 'trades']);
    expect(TRADING_EXPORT_STATUSES).toEqual(['requested', 'building', 'uploading', 'ready', 'failed', 'cancelled', 'expired']);
    expect(TRADING_EXPORT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('says what an older agent needs, in the desk\'s words', () => {
    expect(TRADING_EXPORT_TOO_OLD_COPY).toBe('This agent is older than 1.4.0 and cannot send trading exports. Update it first.');
  });
});

describe('canSendTradingExport', () => {
  it.each([
    ['1.4.0', true], ['1.4', true], ['1.4.0.1', true], ['1.10.0', true], ['2.0.0', true],
    ['1.3.9', false], ['1.3.1', false], ['0.9.0', false], [null, false], ['', false], ['latest', false], [undefined, false],
  ])('%j -> %j', (version, expected) => {
    expect(canSendTradingExport(version)).toBe(expected);
  });
});

describe('isIsoDate and normalizeDatasets', () => {
  it.each([['2026-10-19', true], ['2024-02-29', true], ['2026-02-29', false], ['2026-13-01', false], ['10/19/2026', false], ['2026-10-19T00:00:00Z', false], [20261019, false], [null, false]])(
    'isIsoDate(%j) is %j', (value, expected) => { expect(isIsoDate(value)).toBe(expected); },
  );

  it('puts datasets in the contract\'s order and refuses an empty, unknown or repeated list', () => {
    expect(normalizeDatasets(['trades', 'executions'])).toEqual(['executions', 'trades']);
    expect(normalizeDatasets([...TRADING_EXPORT_DATASETS].reverse())).toEqual(TRADING_EXPORT_DATASETS);
    for (const bad of [[], ['fills'], ['orders', 'orders'], 'orders', null, ['orders', 'orders', 'trades', 'strategies', 'executions']]) {
      expect(normalizeDatasets(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the words', () => {
  it.each([[0, '0 bytes'], [1, '1 byte'], [512, '512 bytes'], [831488, '812 KB'], [13002342, '12.4 MB'], [null, ''], [-1, '']])(
    'formatExportBytes(%j) is %j', (bytes, words) => { expect(formatExportBytes(bytes)).toBe(words); },
  );

  it('a range reads with years only when the ends are in different years', () => {
    expect(describeExportRange('2026-07-01', '2026-10-19')).toBe('Jul 1 to Oct 19');
    expect(describeExportRange('2025-12-01', '2026-01-05')).toBe('Dec 1, 2025 to Jan 5, 2026');
    expect(describeExportRange(null, '2026-10-19')).toBe('Through Oct 19');
    expect(describeExportRange('2026-07-01', null)).toBe('From Jul 1');
    expect(describeExportRange(null, '2026-10-19', { midSentence: true })).toBe('through Oct 19');
    expect(describeExportRange(null, null)).toBe('');
  });

  it('formatExportDate reads a date or a timestamp as "Oct 19, 2026"', () => {
    expect(formatExportDate('2026-10-19')).toBe('Oct 19, 2026');
    expect(formatExportDate('2026-10-19T14:05:00.000Z')).toBe('Oct 19, 2026');
    expect(formatExportDate(null)).toBe('');
  });

  it.each([
    [{ status: 'requested' }, 'Requested'],
    [{ status: 'building' }, 'Building on the VPS'],
    [{ status: 'uploading' }, 'Uploading'],
    [{ status: 'ready', byteSize: 831488, coveredFrom: '2026-07-01', coveredTo: '2026-10-19', rowCounts: { executions: 2140, orders: 1, strategies: 1, trades: 1 } }, 'Ready, 812 KB, Jul 1 to Oct 19, 2,140 fills'],
    [{ status: 'ready', byteSize: 512, coveredFrom: null, coveredTo: '2026-10-19', rowCounts: { executions: 1, orders: 1, strategies: 1, trades: 1 } }, 'Ready, 512 bytes, through Oct 19, 1 fill'],
    [{ status: 'ready', byteSize: 512, coveredFrom: null, coveredTo: null, rowCounts: null }, 'Ready, 512 bytes'],
    [{ status: 'failed', errorCode: 'database_locked' }, 'Failed: database_locked'],
    [{ status: 'failed', errorCode: null }, 'Failed: unknown_error'],
    [{ status: 'cancelled' }, 'Cancelled'],
    [{ status: 'expired' }, 'Expired'],
    [{ status: 'something' }, 'Unknown'],
  ])('describeTradingExport(%j) is %j', (row, words) => {
    expect(describeTradingExport(row)).toBe(words);
  });

  it('no label, sentence or status reads with a dash', () => {
    const copy = [
      TRADING_EXPORT_TOO_OLD_COPY,
      ...Object.values(TRADING_EXPORT_STATUS_LABELS),
      describeTradingExport({ status: 'ready', byteSize: 1, coveredFrom: '2025-12-01', coveredTo: '2026-01-05', rowCounts: { executions: 3, orders: 1, strategies: 1, trades: 1 } }),
      tradingExportRequestWords({ requested: 3, skipped: 4, needsVps: 2 }),
    ];
    for (const line of copy) expect(line, line).not.toMatch(DASHES);
  });
});

describe('tradingExportFileName', () => {
  it('is <clientName>_<from>_<to>.jsonl.gz from the days the file holds', () => {
    expect(tradingExportFileName({ clientName: 'Gray Elm', coveredFrom: '2026-07-01', coveredTo: '2026-10-19' })).toBe('Gray-Elm_2026-07-01_2026-10-19.jsonl.gz');
  });

  it('makes the name safe for any file system', () => {
    expect(tradingExportFileName({ clientName: 'José Peña / LLC: "A"\\B?*', coveredFrom: '2026-07-01', coveredTo: '2026-10-19' }))
      .toBe('Jose-Pena-LLC-A-B_2026-07-01_2026-10-19.jsonl.gz');
    expect(tradingExportFileName({ clientName: '../../etc', coveredFrom: null, coveredTo: null })).toBe('etc_start_latest.jsonl.gz');
    expect(tradingExportFileName({ clientName: '', coveredFrom: null, coveredTo: null })).toBe('client_start_latest.jsonl.gz');
    expect(tradingExportFileName({ clientName: 'x'.repeat(80) }).split('_')[0]).toHaveLength(60);
  });

  it('falls back to the days that were asked for, then to start and latest', () => {
    expect(tradingExportFileName({ clientName: 'Gray Elm', fromDate: '2026-01-01', toDate: null })).toBe('Gray-Elm_2026-01-01_latest.jsonl.gz');
    expect(tradingExportFileName({ clientName: 'Gray Elm', coveredFrom: 'soon', fromDate: null, coveredTo: '2026-10-19' })).toBe('Gray-Elm_start_2026-10-19.jsonl.gz');
  });
});

describe('tradingExportRequestWords and chunkIds', () => {
  it('says what was requested, skipped and why', () => {
    expect(tradingExportRequestWords({ requested: 12, skipped: 0, needsVps: 0 })).toBe('Requested 12 exports.');
    expect(tradingExportRequestWords({ requested: 1, skipped: 3, needsVps: 2 }))
      .toBe('Requested 1 export. 3 skipped. 2 need an agent update on the VPS first (older than 1.4.0). 1 already has an export in progress or is no longer active.');
    expect(tradingExportRequestWords({ requested: 0, skipped: 1, needsVps: 1 }))
      .toBe('Requested 0 exports. 1 skipped. 1 needs an agent update on the VPS first (older than 1.4.0).');
  });

  it('slices ids into requests of at most 300', () => {
    const ids = Array.from({ length: 601 }, (_, n) => String(n));
    expect(chunkIds(ids).map((chunk) => chunk.length)).toEqual([300, 300, 1]);
    expect(chunkIds([])).toEqual([]);
  });
});
