import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { validateLoadManifest } from '../../scripts/load-test-auto-collection.mjs';
import { runAutoCollectionFleet } from '../../scripts/lib/autoCollectionLoadHarness.mjs';

const enabled = process.env.AUTO_COLLECTION_E2E === '1';

describe.skipIf(!enabled)('auto-collection staging end to end', () => {
  async function configuration(requiredClients) {
    const manifestPath = process.env.AUTO_COLLECTION_LOAD_MANIFEST;
    const managerToken = process.env.AUTO_COLLECTION_LOAD_MANAGER_TOKEN;
    const confirmation = process.env.AUTO_COLLECTION_E2E_CONFIRM_STAGING;
    const allowedOrigin = process.env.AUTO_COLLECTION_LOAD_ALLOW_ORIGIN;
    if (!manifestPath || !managerToken || !confirmation || !allowedOrigin) {
      throw new Error('staging_e2e_configuration_required');
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const validated = validateLoadManifest(manifest, confirmation);
    if (validated.baseUrl !== allowedOrigin) throw new Error('load_origin_confirmation_required');
    if (validated.clientUuids.length < requiredClients) throw new Error('insufficient_synthetic_clients');
    return { ...validated, managerToken, clientUuids: validated.clientUuids.slice(0, requiredClients) };
  }

  it('enrolls, ingests, verifies, downloads, and revokes 20 concurrent devices', async () => {
    const report = await runAutoCollectionFleet({
      ...await configuration(20), concurrency: 20, uploadJitterMaxMs: 2_000,
    });
    expect(report).toMatchObject({
      ok: true,
      requestedDevices: 20,
      sourceMetadataSpoofRejected: 1,
      processedCaptures: 20,
      duplicateReceipts: 20,
      routedCaptures: 20,
      uniqueBatchCount: 20,
      verifiedPersistence: 20,
      verifiedStorageObjects: 20,
      normalizedRows: { accounts: 20, strategies: 20, orders: 20, executions: 20 },
      jsonDownloads: 20,
      zipDownloads: 20,
      revokedDevices: 20,
      failures: [],
    });
  }, 10 * 60 * 1000);

  it('processes the 200-device daily fleet scenario without routing or duplicate errors', async () => {
    const report = await runAutoCollectionFleet({
      ...await configuration(200), concurrency: 20, uploadJitterMaxMs: 2_000,
    });
    expect(report).toMatchObject({
      ok: true,
      requestedDevices: 200,
      sourceMetadataSpoofRejected: 1,
      processedCaptures: 200,
      duplicateReceipts: 200,
      routedCaptures: 200,
      uniqueBatchCount: 200,
      verifiedPersistence: 200,
      verifiedStorageObjects: 200,
      normalizedRows: { accounts: 200, strategies: 200, orders: 200, executions: 200 },
      jsonDownloads: 200,
      zipDownloads: 200,
      revokedDevices: 200,
      failures: [],
    });
  }, 30 * 60 * 1000);
});
