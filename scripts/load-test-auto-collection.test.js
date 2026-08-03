import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseArguments,
  runLoadTest,
  validateLoadManifest,
} from './load-test-auto-collection.mjs';

const CLIENT_ID = '00000000-0000-4000-8000-000000000001';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    purpose: 'vincere-auto-collection-load-test',
    environment: 'staging',
    stagingProjectRef: 'cam-staging-01',
    baseUrl: 'https://cam-staging.example.test',
    clients: [{ clientUuid: CLIENT_ID }],
    ...overrides,
  };
}

describe('auto-collection load CLI', () => {
  it('requires an explicit staging confirmation and never accepts a token argument', () => {
    expect(() => parseArguments(['--manifest', 'clients.json', '--out', 'report.json']))
      .toThrow('Missing required argument --confirm-staging.');
    expect(() => parseArguments([
      '--manifest', 'clients.json', '--confirm-staging', 'cam-staging-01', '--out', 'report.json', '--manager-token', 'secret',
    ])).toThrow('Unknown argument: --manager-token');
    expect(parseArguments([
      '--manifest', 'clients.json', '--confirm-staging', 'cam-staging-01', '--out', 'report.json', '--jitter-ms', '750',
    ])).toMatchObject({ concurrency: 20, uploadJitterMaxMs: 750 });
  });

  it('rejects production, mismatched confirmation, unknown fields, and secret-bearing manifests', () => {
    expect(() => validateLoadManifest(manifest({ environment: 'production' }), 'cam-staging-01')).toThrow('load_environment_must_be_staging');
    expect(() => validateLoadManifest(manifest(), 'different-project')).toThrow('staging_confirmation_mismatch');
    expect(() => validateLoadManifest(manifest({ productKey: 'must-not-be-here' }), 'cam-staging-01')).toThrow('load_manifest_unknown_field');
    expect(() => validateLoadManifest(manifest({ clients: [{ clientUuid: CLIENT_ID, deviceToken: 'must-not-be-here' }] }), 'cam-staging-01'))
      .toThrow('load_manifest_client_shape_invalid');
  });

  it('writes only the sanitized aggregate report and fails closed when the fleet gate fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vincere-load-test-'));
    const manifestPath = join(directory, 'manifest.json');
    const outputPath = join(directory, 'report.json');
    await writeFile(manifestPath, JSON.stringify(manifest()), 'utf8');
    const runFleet = vi.fn(async (options) => {
      expect(options).toMatchObject({
        baseUrl: 'https://cam-staging.example.test',
        managerToken: 'ephemeral-manager-token',
        clientUuids: [CLIENT_ID],
        concurrency: 7,
        uploadJitterMaxMs: 2_000,
      });
      return {
        schemaVersion: 1,
        ok: false,
        requestedDevices: 1,
        pairedDevices: 1,
        processedCaptures: 1,
        duplicateReceipts: 1,
        routedCaptures: 0,
        uniqueBatchCount: 1,
        jsonDownloads: 0,
        zipDownloads: 0,
        revokedDevices: 1,
        failures: [{ stage: 'history', code: 'routing_mismatch', count: 1 }],
        latency: {},
      };
    });

    const common = {
      manifestPath,
      outputPath,
      confirmStaging: 'cam-staging-01',
      concurrency: 7,
      runFleet,
    };
    await expect(runLoadTest({
      ...common,
      env: { AUTO_COLLECTION_LOAD_MANAGER_TOKEN: 'ephemeral-manager-token' },
    })).rejects.toThrow('load_origin_confirmation_required');
    await expect(runLoadTest({
      ...common,
      env: {
        AUTO_COLLECTION_LOAD_MANAGER_TOKEN: 'ephemeral-manager-token',
        AUTO_COLLECTION_LOAD_ALLOW_ORIGIN: 'https://cam-staging.example.test',
      },
    })).rejects.toThrow('auto_collection_load_gate_failed');

    const output = await readFile(outputPath, 'utf8');
    expect(JSON.parse(output)).toMatchObject({ ok: false, failures: [{ code: 'routing_mismatch' }] });
    expect(output).not.toContain('ephemeral-manager-token');
    expect(output).not.toContain(CLIENT_ID);
    expect(output).not.toContain('cam-staging-01');
  });
});
