import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

const VERSION = /^[0-9]{1,5}(?:\.[0-9]{1,5}){1,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const THUMBPRINT = /^[A-F0-9]{40,128}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;
const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
const SETUP_ARTIFACT = 'Vincere-AutoExport-Setup.exe';
const verifiedReleaseCache = new WeakMap();

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function exactKeys(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function approvedUrl(value, { production, origin } = {}) {
  const url = new URL(String(value || ''));
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && (production || !isLoopback))) throw new Error('url');
  if (origin && url.origin !== origin) throw new Error('origin');
  return url;
}

async function boundedResponseBytes(response) {
  if (!response?.ok) throw new Error('response');
  const declaredHeader = response.headers?.get?.('content-length');
  const declared = declaredHeader === null || declaredHeader === undefined ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isFinite(declared) || declared < 1 || declared > RELEASE_MANIFEST_MAX_BYTES)) throw new Error('size');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > RELEASE_MANIFEST_MAX_BYTES) throw new Error('size');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RELEASE_MANIFEST_MAX_BYTES) throw new Error('size');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error('size');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function verifiedManifest(bytes, expectedSha256, manifestUrl, production) {
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(expectedSha256, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('hash');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!exactKeys(manifest, ['schemaVersion', 'version', 'minimumAgentVersion', 'minimumSchemaVersion', 'publishedAt', 'signingThumbprint', 'artifacts'])
    || manifest.schemaVersion !== 1
    || !VERSION.test(manifest.version)
    || !VERSION.test(manifest.minimumAgentVersion)
    || !Number.isInteger(manifest.minimumSchemaVersion) || manifest.minimumSchemaVersion < 1
    || !canonicalTimestamp(manifest.publishedAt)
    || !THUMBPRINT.test(manifest.signingThumbprint)
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length < 3) throw new Error('manifest');

  const names = new Set();
  for (const artifact of manifest.artifacts) {
    if (!exactKeys(artifact, ['name', 'url', 'sha256', 'size'])
      || !ARTIFACT_NAME.test(artifact.name)
      || names.has(artifact.name)
      || !SHA256.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size < 1) throw new Error('artifact');
    approvedUrl(artifact.url, { production, origin: manifestUrl.origin });
    names.add(artifact.name);
  }
  const setup = manifest.artifacts.find(({ name }) => name === SETUP_ARTIFACT);
  if (!setup) throw new Error('setup');
  return Object.freeze({
    url: approvedUrl(setup.url, { production, origin: manifestUrl.origin }).toString(),
    version: manifest.version,
    minimumAgentVersion: manifest.minimumAgentVersion,
    minimumSchemaVersion: manifest.minimumSchemaVersion,
    sha256: setup.sha256,
    publishedAt: canonicalTimestamp(manifest.publishedAt),
    size: setup.size,
    signingThumbprint: manifest.signingThumbprint,
  });
}

export async function resolveInstallerRelease(env = process.env, {
  production = env.NODE_ENV === 'production',
  fetchImpl = globalThis.fetch,
} = {}) {
  const values = [
    env.AUTO_COLLECTION_RELEASE_MANIFEST_URL,
    env.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256,
  ];
  if (values.every((value) => !String(value || '').trim())) return null;
  if (values.some((value) => !String(value || '').trim())) {
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }

  try {
    const url = approvedUrl(String(values[0]).trim(), { production });
    const sha256 = String(values[1]).trim().toLowerCase();
    if (!SHA256.test(sha256) || typeof fetchImpl !== 'function') throw new Error('fields');
    let cache = verifiedReleaseCache.get(fetchImpl);
    if (!cache) {
      cache = new Map();
      verifiedReleaseCache.set(fetchImpl, cache);
    }
    const cacheKey = `${production ? 'production' : 'development'}\0${url}\0${sha256}`;
    if (!cache.has(cacheKey)) {
      const pending = (async () => {
        const response = await fetchImpl(url.toString(), {
          method: 'GET',
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        return verifiedManifest(await boundedResponseBytes(response), sha256, url, production);
      })();
      cache.set(cacheKey, pending);
      pending.catch(() => {
        if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
      });
    }
    return await cache.get(cacheKey);
  } catch {
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }
}
