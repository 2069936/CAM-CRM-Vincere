import process from 'node:process';

const MIB = 1024 * 1024;
export const DEFAULT_MAX_COMPRESSED_BYTES = 2 * MIB;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 16 * MIB;
export const ABSOLUTE_MAX_COMPRESSED_BYTES = 32 * MIB;
export const ABSOLUTE_MAX_UNCOMPRESSED_BYTES = 128 * MIB;
const ZIP_EXPANSION_FACTOR = 3;
const ZIP_CONTAINER_ALLOWANCE_BYTES = MIB;

function configuredLimit(value, fallback, absoluteMax) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, absoluteMax);
}

export function resolveAutoCollectionLimits(env = process.env) {
  return {
    maxCompressedBytes: configuredLimit(
      env?.AUTO_COLLECTION_MAX_COMPRESSED_BYTES,
      DEFAULT_MAX_COMPRESSED_BYTES,
      ABSOLUTE_MAX_COMPRESSED_BYTES,
    ),
    maxUncompressedBytes: configuredLimit(
      env?.AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES,
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
      ABSOLUTE_MAX_UNCOMPRESSED_BYTES,
    ),
  };
}

function safeProduct(value, factor) {
  const result = value * factor;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid auto-export byte limits.');
  return result;
}

export function deriveAutoExportLimits(maxUncompressedBytes) {
  const bounded = configuredLimit(
    maxUncompressedBytes,
    DEFAULT_MAX_UNCOMPRESSED_BYTES,
    ABSOLUTE_MAX_UNCOMPRESSED_BYTES,
  );
  const maxZipInputBytes = safeProduct(bounded, ZIP_EXPANSION_FACTOR);
  const maxZipBytes = maxZipInputBytes + ZIP_CONTAINER_ALLOWANCE_BYTES;
  if (!Number.isSafeInteger(maxZipBytes)) throw new Error('Invalid auto-export byte limits.');
  return { maxZipInputBytes, maxZipBytes };
}

export const DEFAULT_AUTO_EXPORT_LIMITS = Object.freeze(
  deriveAutoExportLimits(DEFAULT_MAX_UNCOMPRESSED_BYTES),
);
