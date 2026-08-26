import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

const VERSION = /^[0-9]{1,5}(?:\.[0-9]{1,5}){1,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const THUMBPRINT = /^[A-F0-9]{40,128}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;
const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
// Two ways to ship the agent. The signed setup executable, and the plain package
// the PowerShell installer expands. The package is listed first because an
// unsigned zip rollout does not need a code-signing certificate; a manifest that
// carries both resolves to the package, and the signed setup is the fallback.
const SETUP_ARTIFACTS = Object.freeze([
  { name: 'Vincere-AutoExport-Agent.zip', kind: 'zip' },
  { name: 'Vincere-AutoExport-Setup.exe', kind: 'exe' },
]);
const verifiedReleaseCache = new WeakMap();

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => keys.includes(key));
}

function approvedUrl(value, { production, origin } = {}) {
  const url = new URL(String(value || ''));
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && (production || !isLoopback))) throw new Error('url');
  if (origin && url.origin !== origin) throw new Error('origin');
  return url;
}

/**
 * Hosts a redirect may never send us to.
 *
 * This is the reason `redirect: 'error'` existed, and it is the part worth
 * keeping. A server that follows an arbitrary redirect is a request forwarder:
 * point it at 169.254.169.254 and it fetches the cloud instance's credentials on
 * your behalf. The content check downstream would reject the bytes, but the
 * request has already been made and that is the whole attack.
 *
 * Literal-address forms only. A hostname that RESOLVES to a private address is
 * not caught here, and cannot be without resolving it ourselves and pinning the
 * socket to that answer. The first hop is a hardcoded constant, so reaching this
 * requires whoever serves that constant to be redirecting us somewhere hostile,
 * and at that point the release itself is compromised.
 */
const BLOCKED_REDIRECT_HOST = /^(?:localhost|(?:10|127)\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?(?:::1|fc|fd|fe80)|0\.0\.0\.0$)/i;

/**
 * GET a manifest, following redirects by hand instead of refusing them.
 *
 * GitHub Releases answer a download URL with a 302 to a signed, time-limited
 * object host, so `redirect: 'error'` cannot fetch one at all. Hosting the
 * manifest somewhere that serves it directly is the alternative, and it costs a
 * per-release upload step by whoever holds those credentials — which is exactly
 * the handoff that left this feature sitting unusable for weeks.
 *
 * Following redirects is safe HERE for a reason that does not generalise: the
 * bytes are pinned by SHA-256 against a digest committed in this repository, so
 * a redirect cannot change WHAT is installed, only where the request goes. Every
 * hop is re-validated through approvedUrl (https, no credentials, no fragment)
 * and screened against the private ranges above, and the chain is bounded.
 */
async function fetchManifestFollowingRedirects(fetchImpl, startUrl, { production, maxHops = 5 }) {
  let url = startUrl;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    const location = response.status >= 300 && response.status < 400
      ? response.headers?.get?.('location')
      : null;
    if (!location) return response;
    // Relative Location headers are legal, so resolve against the current hop
    // rather than assuming an absolute URL.
    const next = approvedUrl(new URL(location, url).toString(), { production });
    if (BLOCKED_REDIRECT_HOST.test(next.hostname)) throw new Error('redirect-host');
    url = next;
  }
  throw new Error('redirect-loop');
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
  // signingThumbprint is optional: an unsigned package rollout has no
  // certificate. When it is present it must still be a real thumbprint, so a
  // malformed value is rejected rather than treated as unsigned. Integrity does
  // not depend on it — the manifest is pinned by SHA-256 through the environment
  // and every artifact carries its own SHA-256 below.
  if (!exactKeys(
    manifest,
    ['schemaVersion', 'version', 'minimumAgentVersion', 'minimumSchemaVersion', 'publishedAt', 'artifacts'],
    ['signingThumbprint'],
  )
    || manifest.schemaVersion !== 1
    || !VERSION.test(manifest.version)
    || !VERSION.test(manifest.minimumAgentVersion)
    || !Number.isInteger(manifest.minimumSchemaVersion) || manifest.minimumSchemaVersion < 1
    || !canonicalTimestamp(manifest.publishedAt)
    || ('signingThumbprint' in manifest && !THUMBPRINT.test(manifest.signingThumbprint))
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1) throw new Error('manifest');

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
  let setup = null;
  let kind = null;
  for (const candidate of SETUP_ARTIFACTS) {
    const match = manifest.artifacts.find(({ name }) => name === candidate.name);
    if (match) {
      setup = match;
      kind = candidate.kind;
      break;
    }
  }
  if (!setup) throw new Error('setup');
  return Object.freeze({
    url: approvedUrl(setup.url, { production, origin: manifestUrl.origin }).toString(),
    // 'zip' is expanded by the PowerShell installer, 'exe' is run directly, so
    // the UI can show the right instructions for whichever was published.
    kind,
    version: manifest.version,
    minimumAgentVersion: manifest.minimumAgentVersion,
    minimumSchemaVersion: manifest.minimumSchemaVersion,
    sha256: setup.sha256,
    publishedAt: canonicalTimestamp(manifest.publishedAt),
    size: setup.size,
    signingThumbprint: manifest.signingThumbprint ?? null,
  });
}

/**
 * The published agent, committed rather than configured.
 *
 * Neither value is a secret. The URL is public by definition — it is where a
 * client VPS downloads from — and the SHA-256 is the digest of a file anyone can
 * fetch. Nothing was protected by holding them in environment variables, and
 * holding them there cost a deployment step owned by whoever administers Vercel.
 * That handoff is why the card told every CAM it was "waiting for an approved
 * Windows release" for weeks, waiting on an approval nobody performs.
 *
 * The digest is what makes committing them safe. The manifest is rejected unless
 * it matches this byte for byte, and every artifact inside carries its own
 * SHA-256, so replacing the file at that URL does not replace what the desk
 * installs — it breaks the check and the card reports no release. Changing what
 * ships means changing this constant, in a commit, in review.
 *
 * Environment variables still win when set, so another deployment can point
 * elsewhere without touching code.
 *
 * Built by run 31595748544 of the Collector Windows workflow, published as
 * release agent-v1.0.0.
 */
const DEFAULT_RELEASE_MANIFEST_URL = 'https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.0/release-manifest.json';
const DEFAULT_RELEASE_MANIFEST_SHA256 = 'bf55101284f29588e7c75c0fa2fa8ea69b37e9af9a31127292a81f6b2aaa17a3';

export async function resolveInstallerRelease(env = process.env, {
  production = env.NODE_ENV === 'production',
  fetchImpl = globalThis.fetch,
} = {}) {
  // Whether the values came from configuration or from the constants above, and
  // it decides what a failure MEANS.
  //
  // A configured URL that will not resolve is a mistake someone made and has to
  // hear about, so it throws. The committed default failing is a different
  // event: GitHub is unreachable, or the release was pulled. Throwing there
  // turns a third party's outage into a 500 that takes the whole Auto Collection
  // card down for every client, when the honest answer is the one this function
  // already has a shape for — no release available right now.
  const configured = Boolean(
    String(env.AUTO_COLLECTION_RELEASE_MANIFEST_URL || '').trim()
    || String(env.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256 || '').trim(),
  );
  const values = [
    env.AUTO_COLLECTION_RELEASE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL,
    env.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256 || DEFAULT_RELEASE_MANIFEST_SHA256,
  ];
  if (values.every((value) => !String(value || '').trim())) return null;
  if (values.some((value) => !String(value || '').trim())) {
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }
  if (configured
    && (!String(env.AUTO_COLLECTION_RELEASE_MANIFEST_URL || '').trim()
      || !String(env.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256 || '').trim())) {
    // Half-configured: someone set the url and not the digest, or the reverse.
    // Falling back to the committed default here would install something other
    // than what they were reaching for, silently.
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
        const response = await fetchManifestFollowingRedirects(fetchImpl, url, { production });
        // Verified against the ORIGINAL url, not the hop the bytes came from.
        // The artifact URLs inside must share the origin the manifest was
        // published at; a redirect to a signed object host must not silently
        // widen what counts as same-origin.
        return verifiedManifest(await boundedResponseBytes(response), sha256, url, production);
      })();
      cache.set(cacheKey, pending);
      pending.catch(() => {
        if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
      });
    }
    return await cache.get(cacheKey);
  } catch {
    // See `configured` above: an outage on the committed default degrades to
    // "no release", a broken configuration is reported.
    if (!configured) return null;
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }
}
