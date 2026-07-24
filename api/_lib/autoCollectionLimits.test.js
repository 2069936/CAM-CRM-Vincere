import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MAX_COMPRESSED_BYTES,
  ABSOLUTE_MAX_UNCOMPRESSED_BYTES,
  deriveAutoExportLimits,
  resolveAutoCollectionLimits,
} from './autoCollectionLimits.js';
import { DEFAULT_MAX_COMPRESSED_BYTES, DEFAULT_MAX_UNCOMPRESSED_BYTES } from './autoImportStore.js';

describe('shared auto-collection byte limits', () => {
  it('resolves the same positive safe environment limits for ingest and downloads', () => {
    expect(resolveAutoCollectionLimits({
      AUTO_COLLECTION_MAX_COMPRESSED_BYTES: String(DEFAULT_MAX_COMPRESSED_BYTES + 1),
      AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: String(DEFAULT_MAX_UNCOMPRESSED_BYTES + 1),
    })).toEqual({
      maxCompressedBytes: DEFAULT_MAX_COMPRESSED_BYTES + 1,
      maxUncompressedBytes: DEFAULT_MAX_UNCOMPRESSED_BYTES + 1,
    });
  });

  it('falls back for non-positive or unsafe values and clamps valid values to absolute memory caps', () => {
    expect(resolveAutoCollectionLimits({
      AUTO_COLLECTION_MAX_COMPRESSED_BYTES: '0',
      AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: String(Number.MAX_SAFE_INTEGER + 1),
    })).toEqual({
      maxCompressedBytes: DEFAULT_MAX_COMPRESSED_BYTES,
      maxUncompressedBytes: DEFAULT_MAX_UNCOMPRESSED_BYTES,
    });
    expect(resolveAutoCollectionLimits({
      AUTO_COLLECTION_MAX_COMPRESSED_BYTES: String(ABSOLUTE_MAX_COMPRESSED_BYTES + 1),
      AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: String(ABSOLUTE_MAX_UNCOMPRESSED_BYTES + 1),
    })).toEqual({
      maxCompressedBytes: ABSOLUTE_MAX_COMPRESSED_BYTES,
      maxUncompressedBytes: ABSOLUTE_MAX_UNCOMPRESSED_BYTES,
    });
  });

  it('derives safe ZIP input/output caps above the old 16 MiB threshold without unsafe arithmetic', () => {
    const raised = deriveAutoExportLimits(DEFAULT_MAX_UNCOMPRESSED_BYTES + 1);
    expect(raised.maxZipInputBytes).toBe((DEFAULT_MAX_UNCOMPRESSED_BYTES + 1) * 3);
    expect(raised.maxZipBytes).toBeGreaterThan(raised.maxZipInputBytes);
    const absolute = deriveAutoExportLimits(ABSOLUTE_MAX_UNCOMPRESSED_BYTES);
    expect(Number.isSafeInteger(absolute.maxZipInputBytes)).toBe(true);
    expect(Number.isSafeInteger(absolute.maxZipBytes)).toBe(true);
  });
});
