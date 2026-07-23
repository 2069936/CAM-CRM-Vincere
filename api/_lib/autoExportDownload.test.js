import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { canonicalSnapshotPayload } from './autoImportStore.js';
import {
  buildSnapshotZip,
  CSV_COLUMNS,
  csvForSection,
  deterministicDownloadName,
  verifyStoredSnapshot,
} from './autoExportDownload.js';

const snapshot = JSON.parse(readFileSync(new URL('../../test/fixtures/auto-export/snapshot-v1.json', import.meta.url), 'utf8'));
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

function evidence(overrides = {}) {
  const canonical = canonicalSnapshotPayload(snapshot);
  return {
    batch: {
      id: BATCH_ID,
      clientId: CLIENT_ID,
      deviceId: '33333333-3333-4333-8333-333333333333',
      captureId: snapshot.captureId,
      tradingDate: snapshot.tradingDate,
      // Postgres returns timestamptz normalized to UTC, while the immutable
      // source preserves its original New York offset.
      capturedAt: '2026-07-23T20:45:00.000Z',
      receivedAt: '2026-07-23T20:45:03.000Z',
      processedAt: '2026-07-23T20:45:04.000Z',
      status: 'processed',
      schemaVersion: 1,
      storagePath: `${CLIENT_ID}/${snapshot.tradingDate}/${snapshot.captureId}.json.gz`,
      contentSha256: canonical.sha256,
      byteCount: canonical.utf8.length,
      rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
      completeness: { isComplete: true, emptySections: [] },
      dailyImportId: '44444444-4444-4444-8444-444444444444',
      replacesBatchId: null,
      errorCode: null,
      ...overrides,
    },
    compressed: canonical.gzip,
    canonical,
  };
}

describe('auto-export download evidence verification', () => {
  it('returns the exact immutable canonical JSON after checking gzip, bytes, hash, metadata and row counts', () => {
    const item = evidence();
    const verified = verifyStoredSnapshot(item);
    expect(verified.snapshot).toEqual(snapshot);
    expect(verified.jsonBytes.equals(item.canonical.utf8)).toBe(true);
  });

  it('compares capturedAt by instant after Postgres normalizes the source offset to UTC', () => {
    const item = evidence({ capturedAt: '2026-07-23T20:45:00+00:00' });
    expect(verifyStoredSnapshot(item).snapshot.capturedAt).toBe('2026-07-23T16:45:00-04:00');
  });

  it.each([
    ['wrong path', { storagePath: `${CLIENT_ID}/2026-07-22/${snapshot.captureId}.json.gz` }, undefined],
    ['wrong client path', { storagePath: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${snapshot.tradingDate}/${snapshot.captureId}.json.gz` }, undefined],
    ['wrong hash metadata', { contentSha256: 'a'.repeat(64) }, undefined],
    ['wrong byte metadata', { byteCount: 3 }, undefined],
    ['wrong row counts', { rowCounts: { accounts: 2, strategies: 1, orders: 1, executions: 1 } }, undefined],
    ['wrong capture metadata', { capturedAt: '2026-07-23T16:44:00-04:00' }, undefined],
    ['corrupt gzip', {}, Buffer.from('not-gzip')],
  ])('rejects %s with one stable corruption error', (_name, batchPatch, compressed) => {
    const item = evidence(batchPatch);
    expect(() => verifyStoredSnapshot({ ...item, compressed: compressed || item.compressed }))
      .toThrow(expect.objectContaining({ status: 409, message: 'stored_snapshot_corrupt' }));
  });

  it('rejects an unsupported batch or embedded schema version with a stable error', () => {
    expect(() => verifyStoredSnapshot(evidence({ schemaVersion: 2 })))
      .toThrow(expect.objectContaining({ status: 409, message: 'unsupported_schema_version' }));

    const changed = structuredClone(snapshot);
    changed.schemaVersion = 2;
    const canonical = canonicalSnapshotPayload(changed);
    const item = evidence({ contentSha256: canonical.sha256, byteCount: canonical.utf8.length });
    expect(() => verifyStoredSnapshot({ ...item, compressed: canonical.gzip }))
      .toThrow(expect.objectContaining({ status: 409, message: 'unsupported_schema_version' }));
  });

  it('bounds compressed and decompressed evidence before materializing a download', () => {
    const item = evidence();
    expect(() => verifyStoredSnapshot({ ...item, maxCompressedBytes: item.compressed.length - 1 }))
      .toThrow(expect.objectContaining({ status: 409, message: 'stored_snapshot_corrupt' }));

    const oversized = gzipSync(Buffer.alloc(2048, 65));
    expect(() => verifyStoredSnapshot({
      ...item,
      compressed: oversized,
      batch: { ...item.batch, byteCount: 2048 },
      maxUncompressedBytes: 1024,
    })).toThrow(expect.objectContaining({ status: 409, message: 'stored_snapshot_corrupt' }));
  });
});

describe('auto-export CSV and ZIP reconstruction', () => {
  it('locks every CSV header to the frozen snapshot-v1 field order', () => {
    for (const section of ['accounts', 'strategies', 'orders', 'executions']) {
      expect(CSV_COLUMNS[section]).toEqual(Object.keys(snapshot[section][0]));
    }
  });

  it('uses stable source-contract columns, Excel BOM, CRLF and RFC-4180 escaping', () => {
    const row = { ...snapshot.orders[0], name: 'entry, "alpha"\nnext' };
    const csv = csvForSection('orders', [row]);
    expect(csv.startsWith('\uFEFForderId,accountName,strategyId,strategyName,instrument,action,orderType,quantity,filled,remaining,limitPrice,stopPrice,averageFillPrice,state,time,tif,oco,name,nativeId\r\n')).toBe(true);
    expect(csv).toContain('"entry, ""alpha""\nnext"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('serializes strategy parameters deterministically and leaves null fields empty', () => {
    const csv = csvForSection('strategies', [{ ...snapshot.strategies[0], parameters: { z: 2, a: 'x' }, startedAt: null }]);
    expect(csv).toContain('"{""a"":""x"",""z"":2}"');
    expect(csv).toContain(',true,,');
  });

  it('builds the bounded four-CSV ZIP and a manifest with verifiable provenance', () => {
    const item = evidence();
    const verified = verifyStoredSnapshot(item);
    const archive = buildSnapshotZip({ batch: item.batch, ...verified });
    const files = unzipSync(archive);
    expect(Object.keys(files).sort()).toEqual([
      'Accounts.csv', 'Executions.csv', 'Orders.csv', 'Strategies.csv', 'manifest.json',
    ]);
    expect([...files['Accounts.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(files['Accounts.csv'])).toContain('accountName,connectionName,displayName');
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      capture: { id: snapshot.captureId, capturedAt: snapshot.capturedAt, tradingDate: snapshot.tradingDate },
      batch: { id: BATCH_ID, status: 'processed' },
      rowCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1 },
      hashes: { canonicalJsonSha256: item.canonical.sha256 },
      pnlSources: { realized: 1, grossFallback: 0, grossMissingRealized: 0, unavailable: 0 },
    });
    expect(manifest.pnlSourceDetails).toEqual([{
      accountName: 'SIM-REDACTED-01',
      realizedPnl: 125.5,
      grossRealizedPnl: 140.25,
      selectedPnl: 125.5,
      source: 'realized',
    }]);
    expect(manifest.hashes.csvSha256).toEqual(expect.objectContaining({ accounts: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    expect(manifest).not.toHaveProperty('storagePath');
    expect(manifest).not.toHaveProperty('errorDetail');
  });

  it('rejects a ZIP that exceeds its output bound', () => {
    const item = evidence();
    const verified = verifyStoredSnapshot(item);
    expect(() => buildSnapshotZip({ batch: item.batch, ...verified, maxZipBytes: 10 }))
      .toThrow(expect.objectContaining({ status: 413, message: 'download_too_large' }));
  });

  it('records the zero-realized Gross PnL fallback per account in the manifest', () => {
    const changed = structuredClone(snapshot);
    changed.accounts[0].realizedPnl = 0;
    const jsonBytes = canonicalSnapshotPayload(changed).utf8;
    const archive = buildSnapshotZip({ batch: evidence().batch, snapshot: changed, jsonBytes });
    const manifest = JSON.parse(strFromU8(unzipSync(archive)['manifest.json']));
    expect(manifest.pnlSourceDetails[0]).toMatchObject({
      realizedPnl: 0,
      grossRealizedPnl: 140.25,
      selectedPnl: 140.25,
      source: 'gross_fallback',
    });
    expect(manifest.pnlSources.grossFallback).toBe(1);
  });

  it('creates header-safe deterministic filenames without client-entered text', () => {
    expect(deterministicDownloadName(evidence().batch, 'zip')).toBe(
      `ninjatrader-${CLIENT_ID}-2026-07-23-${snapshot.captureId}.zip`,
    );
    expect(() => deterministicDownloadName({ ...evidence().batch, tradingDate: 'x\r\nInjected: y' }, 'json'))
      .toThrow(expect.objectContaining({ message: 'stored_snapshot_corrupt' }));
  });
});
