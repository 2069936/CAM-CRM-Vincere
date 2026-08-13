// The redirect chain, and what it must refuse.
//
// resolveInstallerRelease used to pass `redirect: 'error'`, which is a real
// control and not a formality: a server that follows an arbitrary redirect is a
// request forwarder, and the classic target is a cloud metadata address that
// answers with the instance's credentials.
//
// It now follows redirects, because GitHub Releases answer a download URL with a
// 302 to a signed object host and the alternative was a per-release upload by
// whoever holds the storage credentials. These pin the controls that replaced
// it. Each one fails if the corresponding guard is removed.

import { describe, expect, it } from 'vitest';
import { resolveInstallerRelease } from '../../apiLib/collectorRelease.js';
import { createHash } from 'node:crypto';

const MANIFEST_URL = 'https://downloads.test/release-manifest.json';

function manifestBody(base = 'https://downloads.test') {
  return JSON.stringify({
    schemaVersion: 1,
    version: '1.0.0',
    minimumAgentVersion: '1.0.0',
    minimumSchemaVersion: 1,
    publishedAt: '2026-08-13T14:28:46.729Z',
    artifacts: [{
      name: 'Vincere-AutoExport-Agent.zip',
      url: `${base}/Vincere-AutoExport-Agent.zip`,
      sha256: 'a'.repeat(64),
      size: 107969110,
    }],
  });
}

const digestOf = (body) => createHash('sha256').update(Buffer.from(body)).digest('hex');

/** A fetch that replays a scripted redirect chain, then serves `body`. */
function fetchWithChain(hops, body) {
  let call = 0;
  return async () => {
    if (call < hops.length) {
      const location = hops[call];
      call += 1;
      return {
        status: 302,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null) },
      arrayBuffer: async () => Buffer.from(body),
    };
  };
}

const env = (body) => ({
  AUTO_COLLECTION_RELEASE_MANIFEST_URL: MANIFEST_URL,
  AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: digestOf(body),
});

describe('following a redirect to the manifest', () => {
  it('resolves through a redirect, which is the whole point of the change', async () => {
    const body = manifestBody();
    const release = await resolveInstallerRelease(env(body), {
      production: true,
      fetchImpl: fetchWithChain(['https://objects.test/signed?sig=abc'], body),
    });
    expect(release.version).toBe('1.0.0');
    expect(release.kind).toBe('zip');
  });

  it('still rejects a manifest whose bytes do not match the pinned digest', async () => {
    // The primary control. A redirect can change WHERE the request goes; it must
    // never change WHAT gets installed.
    const body = manifestBody();
    await expect(resolveInstallerRelease(
      { ...env(body), AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: 'b'.repeat(64) },
      { production: true, fetchImpl: fetchWithChain(['https://objects.test/signed'], body) },
    )).rejects.toThrow(/Invalid auto-collection installer/);
  });

  for (const target of [
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/admin',
    'https://localhost/admin',
    'https://10.0.0.5/internal',
    'https://192.168.1.10/internal',
    'https://172.16.4.4/internal',
    'https://[::1]/internal',
  ]) {
    it(`refuses a redirect to ${target}`, async () => {
      const body = manifestBody();
      await expect(resolveInstallerRelease(env(body), {
        production: true,
        fetchImpl: fetchWithChain([target], body),
      })).rejects.toThrow(/Invalid auto-collection installer/);
    });
  }

  it('refuses a redirect that drops to plain http', async () => {
    const body = manifestBody();
    await expect(resolveInstallerRelease(env(body), {
      production: true,
      fetchImpl: fetchWithChain(['http://downloads.test/manifest.json'], body),
    })).rejects.toThrow(/Invalid auto-collection installer/);
  });

  it('refuses a redirect carrying credentials in the url', async () => {
    const body = manifestBody();
    await expect(resolveInstallerRelease(env(body), {
      production: true,
      fetchImpl: fetchWithChain(['https://user:pass@objects.test/signed'], body),
    })).rejects.toThrow(/Invalid auto-collection installer/);
  });

  it('bounds the chain instead of following it forever', async () => {
    const body = manifestBody();
    const forever = Array.from({ length: 20 }, (_, i) => `https://objects.test/hop-${i}`);
    await expect(resolveInstallerRelease(env(body), {
      production: true,
      fetchImpl: fetchWithChain(forever, body),
    })).rejects.toThrow(/Invalid auto-collection installer/);
  });

  it('keeps same-origin keyed on the published url, not on where the bytes came from', async () => {
    // The artifact lives at downloads.test because that is where the manifest was
    // published. If the origin check followed the redirect to objects.test, a
    // signed object host would silently become an approved place to serve
    // artifacts from.
    const body = manifestBody('https://objects.test');
    await expect(resolveInstallerRelease(env(body), {
      production: true,
      fetchImpl: fetchWithChain(['https://objects.test/signed'], body),
    })).rejects.toThrow(/Invalid auto-collection installer/);
  });
});
