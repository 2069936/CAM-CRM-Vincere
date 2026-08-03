import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  formatReadinessReport,
  parseEnvironmentText,
  verifyAutoCollectionEnvironments,
} from './verify-auto-collection-env.mjs';

const manifest = {
  schemaVersion: 1,
  version: '1.4.2',
  minimumAgentVersion: '1.4.2',
  minimumSchemaVersion: 1,
  publishedAt: '2026-07-23T14:00:00.000Z',
  signingThumbprint: 'A'.repeat(40),
  artifacts: [
    { name: 'Vincere.AutoExport.Machine.msi', url: 'https://downloads.example.test/Vincere.AutoExport.Machine.msi', sha256: 'b'.repeat(64), size: 100 },
    { name: 'Vincere.AutoExport.AddOn.msi', url: 'https://downloads.example.test/Vincere.AutoExport.AddOn.msi', sha256: 'c'.repeat(64), size: 200 },
    { name: 'Vincere-AutoExport-Setup.exe', url: 'https://downloads.example.test/Vincere-AutoExport-Setup.exe', sha256: 'a'.repeat(64), size: 300 },
  ],
};
const manifestText = JSON.stringify(manifest);
const manifestHash = createHash('sha256').update(manifestText).digest('hex');

function environment(name) {
  return {
    SUPABASE_URL: `https://${name}-project.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${name}_${'p'.repeat(24)}`,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${name}_${'s'.repeat(32)}`,
    VITE_SUPABASE_URL: `https://${name}-project.supabase.co`,
    VITE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${name}_${'p'.repeat(24)}`,
    INGEST_TOKEN_PEPPER: `${name}_${'x'.repeat(48)}`,
    INGEST_PAIR_RATE_LIMIT_MAX_ATTEMPTS: '10',
    INGEST_PAIR_RATE_LIMIT_WINDOW_SECONDS: '60',
    INGEST_PAIR_RATE_LIMIT_BLOCK_SECONDS: '300',
    AUTO_COLLECTION_MIN_AGENT_VERSION: '1.4.2',
    AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS: '30',
    AUTO_COLLECTION_MAX_COMPRESSED_BYTES: String(2 * 1024 * 1024),
    AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: String(16 * 1024 * 1024),
    AUTO_COLLECTION_PROCESSING_LEASE_SECONDS: '120',
    AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'https://downloads.example.test/release-manifest.json',
    AUTO_COLLECTION_RELEASE_MANIFEST_SHA256: manifestHash,
  };
}

const fetchImpl = vi.fn(async () => new Response(manifestText, { status: 200 }));

describe('auto-collection environment readiness', () => {
  it('accepts distinct, complete staging and production metadata with a pinned valid manifest', async () => {
    const report = await verifyAutoCollectionEnvironments({
      staging: environment('staging'),
      production: environment('production'),
      fetchImpl,
    });
    expect(report).toMatchObject({ ok: true, staging: { ok: true }, production: { ok: true }, crossEnvironment: { ok: true } });
    expect(report.staging.release).toEqual({ version: '1.4.2', minimumSchemaVersion: 1 });
  });

  it.each([
    ['missing required value', (env) => { delete env.SUPABASE_SERVICE_ROLE_KEY; }, 'SUPABASE_SERVICE_ROLE_KEY'],
    ['placeholder value', (env) => { env.INGEST_TOKEN_PEPPER = 'change-me'; }, 'INGEST_TOKEN_PEPPER'],
    ['missing minimum agent version', (env) => { env.AUTO_COLLECTION_MIN_AGENT_VERSION = ''; }, 'AUTO_COLLECTION_MIN_AGENT_VERSION'],
    ['non-HTTPS manifest URL', (env) => { env.AUTO_COLLECTION_RELEASE_MANIFEST_URL = 'http://downloads.example.test/release-manifest.json'; }, 'AUTO_COLLECTION_RELEASE_MANIFEST_URL'],
  ])('rejects %s without printing its value', async (_label, mutate, expectedSetting) => {
    const staging = environment('staging');
    mutate(staging);
    const report = await verifyAutoCollectionEnvironments({ staging, production: environment('production'), fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.staging.checks).toContainEqual(expect.objectContaining({ setting: expectedSetting, status: 'fail' }));
    const output = formatReadinessReport(report);
    for (const secret of [staging.INGEST_TOKEN_PEPPER, staging.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean)) {
      expect(output).not.toContain(secret);
    }
  });

  it('rejects identical projects and token peppers across staging and production', async () => {
    const staging = environment('staging');
    const production = environment('production');
    production.SUPABASE_URL = staging.SUPABASE_URL;
    production.INGEST_TOKEN_PEPPER = staging.INGEST_TOKEN_PEPPER;
    const report = await verifyAutoCollectionEnvironments({ staging, production, fetchImpl });
    expect(report.crossEnvironment.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ setting: 'SUPABASE_URL', status: 'fail' }),
      expect.objectContaining({ setting: 'INGEST_TOKEN_PEPPER', status: 'fail' }),
    ]));
    expect(formatReadinessReport(report)).not.toContain(staging.INGEST_TOKEN_PEPPER);
  });

  it('rejects a malformed or hash-mismatched release manifest', async () => {
    const staging = environment('staging');
    const production = environment('production');
    const malformed = JSON.stringify({ schemaVersion: 1 });
    const badFetch = vi.fn(async () => new Response(malformed, { status: 200 }));
    staging.AUTO_COLLECTION_RELEASE_MANIFEST_SHA256 = createHash('sha256').update(malformed).digest('hex');
    const report = await verifyAutoCollectionEnvironments({ staging, production, fetchImpl: badFetch });
    expect(report.ok).toBe(false);
    expect(report.staging.checks).toContainEqual(expect.objectContaining({ setting: 'AUTO_COLLECTION_RELEASE_MANIFEST', status: 'fail' }));
  });

  it('parses dotenv metadata without interpolation and formats only names/statuses', () => {
    const parsed = parseEnvironmentText('A=plain\nB="quoted value"\nexport SECRET=top-secret\n# comment\n');
    expect(parsed).toEqual({ A: 'plain', B: 'quoted value', SECRET: 'top-secret' });
    const output = formatReadinessReport({ ok: false, staging: { ok: false, checks: [{ setting: 'SECRET', status: 'fail', code: 'missing' }] }, production: { ok: true, checks: [] }, crossEnvironment: { ok: true, checks: [] } });
    expect(output).toContain('SECRET');
    expect(output).not.toContain('top-secret');
  });
});
