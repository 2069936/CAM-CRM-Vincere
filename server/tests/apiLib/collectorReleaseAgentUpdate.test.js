// What updating the agent from the CRM needs from the pinned release.
//
// Two things. The manifest may now say which NinjaTrader AddOn the release
// needs (minimumAddonVersion, optional, a version when present), because the
// agent cannot install the AddOn itself and a VPS below it has to be told to
// update on the VPS. And the agent is handed the manifest's own address and
// digest, which have to be the pair resolveInstallerRelease verified, so
// pinnedReleaseManifest reads them from the same place.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pinnedReleaseManifest, resolveInstallerRelease } from '../../apiLib/collectorRelease.js';

const MANIFEST_URL = 'https://downloads.test/agent-v1.3.1/release-manifest.json';

function manifestBody(extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    version: '1.3.1',
    minimumAgentVersion: '1.0.0',
    minimumSchemaVersion: 1,
    publishedAt: '2026-10-18T12:00:00.000Z',
    artifacts: [{
      name: 'Vincere-AutoExport-Agent.zip',
      url: 'https://downloads.test/agent-v1.3.1/Vincere-AutoExport-Agent.zip',
      sha256: 'a'.repeat(64),
      size: 110635838,
    }],
    ...extra,
  });
}

const digestOf = (body) => createHash('sha256').update(Buffer.from(body)).digest('hex');
const envFor = (body) => ({ AUTO_COLLECTION_RELEASE_MANIFEST_URL: MANIFEST_URL, AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: digestOf(body) });
// A fresh fetch each time: the verified release is cached per fetch function.
const serve = (body) => async () => new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });

async function resolve(body) {
  return resolveInstallerRelease(envFor(body), { production: true, fetchImpl: serve(body) });
}

describe('minimumAddonVersion in the release manifest', () => {
  it('is null on the release when the manifest does not carry it', async () => {
    await expect(resolve(manifestBody())).resolves.toMatchObject({ version: '1.3.1', minimumAddonVersion: null });
  });

  it.each([['1.3.0'], ['1.3'], ['1.3.0.12']])('is returned as given when it is a version: %s', async (value) => {
    await expect(resolve(manifestBody({ minimumAddonVersion: value }))).resolves.toMatchObject({ minimumAddonVersion: value });
  });

  it.each([[null], [''], ['latest'], ['1'], ['1.3.0.0.0'], [130], [{}]])(
    'rejects the whole manifest when it is present and not a version: %j', async (value) => {
      // A configured manifest that fails verification is reported, not read as "no release".
      await expect(resolve(manifestBody({ minimumAddonVersion: value })))
        .rejects.toThrow('Invalid auto-collection installer manifest configuration.');
    },
  );

  it('keeps every other key strict: an unknown key still rejects the manifest', async () => {
    await expect(resolve(manifestBody({ minimumAddonVersion: '1.3.0', minimumNinjaTraderVersion: '8.1.0' })))
      .rejects.toThrow('Invalid auto-collection installer manifest configuration.');
  });
});

describe('pinnedReleaseManifest', () => {
  it('names the configured manifest, trimmed, with the digest in lower case', () => {
    expect(pinnedReleaseManifest({
      AUTO_COLLECTION_RELEASE_MANIFEST_URL: `  ${MANIFEST_URL} `,
      AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: ` ${'AB'.repeat(32)} `,
    })).toEqual({ url: MANIFEST_URL, sha256: 'ab'.repeat(32) });
  });

  it('names the committed manifest when nothing is configured', () => {
    const pinned = pinnedReleaseManifest({});
    expect(pinned.url).toMatch(/^https:\/\/github\.com\/.+\/release-manifest\.json$/);
    expect(pinned.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a half configuration, exactly as resolveInstallerRelease does', async () => {
    for (const env of [
      { AUTO_COLLECTION_RELEASE_MANIFEST_URL: MANIFEST_URL },
      { AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: 'a'.repeat(64) },
    ]) {
      expect(() => pinnedReleaseManifest(env)).toThrow('Invalid auto-collection installer manifest configuration.');
      await expect(resolveInstallerRelease(env, { production: true, fetchImpl: serve(manifestBody()) }))
        .rejects.toThrow('Invalid auto-collection installer manifest configuration.');
    }
  });

  it('is the url resolveInstallerRelease fetched and the digest it verified', async () => {
    const body = manifestBody();
    const env = envFor(body);
    const fetched = [];
    const fetchImpl = async (url) => { fetched.push(url); return serve(body)(); };
    await expect(resolveInstallerRelease(env, { production: true, fetchImpl })).resolves.toMatchObject({ version: '1.3.1' });
    const pinned = pinnedReleaseManifest(env);
    expect(fetched).toEqual([pinned.url]);
    expect(pinned.sha256).toBe(digestOf(body));
  });
});
