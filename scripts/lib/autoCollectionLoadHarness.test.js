import { describe, expect, it } from 'vitest';
import {
  formatFleetLoadReport,
  runAutoCollectionFleet,
  validateLoadConfiguration,
} from './autoCollectionLoadHarness.mjs';

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const clients = (count) => Array.from({ length: count }, (_, index) => uuid(index + 1));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFakeStagingApi({ delayMs = 0, misrouteCapture = null } = {}) {
  const enrollments = new Map();
  const devices = new Map();
  const batches = new Map();
  const secrets = [];
  let active = 0;
  let maxActive = 0;

  async function fetchImpl(input, init = {}) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const url = new URL(input);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;

      if (url.pathname === '/api/admin/ingest-enrollment' && method === 'POST') {
        const index = enrollments.size + 1;
        const code = String(index).padStart(10, '0');
        enrollments.set(code, { clientUuid: body.clientUuid, consumed: false });
        secrets.push(code);
        return json({ enrollment: { id: uuid(10_000 + index), code, clientUuid: body.clientUuid } }, 201);
      }

      if (url.pathname === '/api/ingest/pair' && method === 'POST') {
        const enrollment = enrollments.get(body.enrollmentCode);
        if (!enrollment || enrollment.consumed) return json({ error: 'invalid_or_expired_code' }, 400);
        enrollment.consumed = true;
        const index = devices.size + 1;
        const deviceId = uuid(20_000 + index);
        const deviceToken = `device-token-${index}-${'x'.repeat(32)}`;
        devices.set(deviceToken, { deviceId, clientUuid: enrollment.clientUuid, machineId: body.machineId });
        secrets.push(deviceToken, body.machineId);
        return json({ deviceToken, deviceId, clientName: `Synthetic ${index}`, schedule: { time: '16:45', timeZone: 'America/New_York' } });
      }

      const authorization = new Headers(init.headers).get('authorization') || '';
      const device = devices.get(authorization.replace(/^Bearer\s+/i, ''));

      if (url.pathname === '/api/ingest/heartbeat' && method === 'POST') {
        if (!device) return json({ error: 'invalid_device_credential' }, 401);
        return json({ deviceId: device.deviceId, status: 'online', schedule: { time: '16:45', timeZone: 'America/New_York' } });
      }

      if (url.pathname === '/api/ingest/daily' && method === 'POST') {
        if (!device) return json({ error: 'invalid_device_credential' }, 401);
        const existing = batches.get(body.captureId);
        if (existing) return json({ ok: true, duplicate: true, batchId: existing.id, dailyImportId: existing.dailyImportId, status: 'processed' });
        const index = batches.size + 1;
        const batch = {
          id: uuid(30_000 + index),
          dailyImportId: uuid(40_000 + index),
          captureId: body.captureId,
          clientUuid: device.clientUuid,
          deviceId: device.deviceId,
          snapshot: body,
        };
        batches.set(body.captureId, batch);
        return json({ ok: true, duplicate: false, batchId: batch.id, dailyImportId: batch.dailyImportId, status: 'processed' }, 201);
      }

      if (url.pathname === '/api/admin/ingest-batches' && method === 'GET') {
        const captureId = url.searchParams.get('captureId');
        const batch = batches.get(captureId);
        if (!batch) return json({ batches: [], nextCursor: null });
        return json({
          batches: [{
            id: batch.id,
            captureId,
            clientUuid: captureId === misrouteCapture ? uuid(999_999) : batch.clientUuid,
            deviceId: batch.deviceId,
            dailyImportId: batch.dailyImportId,
            status: 'processed',
          }],
          nextCursor: null,
        });
      }

      if (url.pathname === '/api/admin/ingest-download' && method === 'GET') {
        const batch = [...batches.values()].find((candidate) => candidate.id === url.searchParams.get('batchId'));
        if (!batch) return json({ error: 'batch_not_found' }, 404);
        if (url.searchParams.get('format') === 'json') return json(batch.snapshot);
        return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip' } });
      }

      if (url.pathname === '/api/admin/ingest-enrollment' && method === 'DELETE') {
        const target = [...devices.entries()].find(([, candidate]) => candidate.deviceId === body.deviceId);
        if (!target || target[1].clientUuid !== body.clientUuid) return json({ error: 'ingest_access_not_found' }, 404);
        devices.delete(target[0]);
        return json({ revoked: { clientId: body.clientUuid, kind: 'device', id: body.deviceId } });
      }

      return json({ error: 'not_found' }, 404);
    } finally {
      active -= 1;
    }
  }

  return {
    fetchImpl,
    get maxActive() { return maxActive; },
    get secrets() { return secrets; },
  };
}

describe('auto-collection staging load harness', () => {
  it('runs 20 isolated device lifecycles with bounded concurrency and no secrets in its report', async () => {
    const api = createFakeStagingApi({ delayMs: 1 });
    const report = await runAutoCollectionFleet({
      baseUrl: 'https://staging.example.test',
      managerToken: `manager-${'m'.repeat(40)}`,
      clientUuids: clients(20),
      concurrency: 5,
      fetchImpl: api.fetchImpl,
    });

    expect(report).toMatchObject({
      ok: true,
      requestedDevices: 20,
      pairedDevices: 20,
      processedCaptures: 20,
      duplicateReceipts: 20,
      routedCaptures: 20,
      jsonDownloads: 20,
      zipDownloads: 20,
      revokedDevices: 20,
      failedOperations: 0,
      errorRate: 0,
      failures: [],
    });
    expect(report.requestCount).toBeGreaterThan(0);
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(api.maxActive).toBeGreaterThan(1);
    expect(api.maxActive).toBeLessThanOrEqual(5);
    const output = formatFleetLoadReport(report);
    for (const secret of [...api.secrets, `manager-${'m'.repeat(40)}`, ...clients(20)]) {
      expect(output).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain(secret);
    }
  });

  it('marks a cross-client history result as a routing failure', async () => {
    const clientUuids = clients(2);
    const captureIds = [uuid(700_001), uuid(700_002)];
    const failingApi = createFakeStagingApi({ misrouteCapture: captureIds[0] });
    const report = await runAutoCollectionFleet({
      baseUrl: 'https://staging.example.test',
      managerToken: 'manager-token-not-for-output',
      clientUuids,
      concurrency: 2,
      fetchImpl: failingApi.fetchImpl,
      deterministicCaptureIds: captureIds,
    });
    expect(report.ok).toBe(false);
    expect(report.failedOperations).toBe(1);
    expect(report.errorRate).toBeGreaterThan(0);
    expect(report.failures).toContainEqual({ stage: 'history', code: 'routing_mismatch', count: 1 });
    expect(report.routedCaptures).toBe(1);
  });

  it('supports a 200-device daily scenario without duplicate batches', async () => {
    const api = createFakeStagingApi();
    const report = await runAutoCollectionFleet({
      baseUrl: 'https://staging.example.test',
      managerToken: 'manager-token-not-for-output',
      clientUuids: clients(200),
      concurrency: 20,
      fetchImpl: api.fetchImpl,
    });
    expect(report).toMatchObject({ ok: true, requestedDevices: 200, processedCaptures: 200, duplicateReceipts: 200, routedCaptures: 200 });
    expect(report.uniqueBatchCount).toBe(200);
    expect(api.maxActive).toBeLessThanOrEqual(20);
  });

  it('requires an HTTPS staging origin and one unique client per device', () => {
    expect(() => validateLoadConfiguration({
      baseUrl: 'http://production.example.test', managerToken: 'x', clientUuids: clients(1), concurrency: 1,
    })).toThrow('staging_origin_must_use_https');
    expect(() => validateLoadConfiguration({
      baseUrl: 'https://staging.example.test', managerToken: 'x', clientUuids: [uuid(1), uuid(1)], concurrency: 2,
    })).toThrow('client_uuid_must_be_unique');
  });
});
