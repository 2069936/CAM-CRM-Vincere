import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUCCESS_STATUS = new Set(['processed', 'incomplete', 'late_closed_day', 'replaced']);
const PERSISTED_COUNT_KEYS = ['accounts', 'strategies', 'orders', 'executions', 'flags'];
const PNL_SOURCE_KEYS = ['realized', 'gross_fallback', 'gross_missing_realized', 'unavailable', 'unknown'];

class HarnessFailure extends Error {
  constructor(stage, code) {
    super(code);
    this.name = 'HarnessFailure';
    this.stage = stage;
    this.code = code;
  }
}

function fail(stage, code) {
  throw new HarnessFailure(stage, code);
}

function canonicalOrigin(value, { allowLocalhost = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('invalid_staging_origin');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) {
    throw new Error('staging_origin_must_use_https');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('invalid_staging_origin');
  }
  return url.origin;
}

export function validateLoadConfiguration({
  baseUrl,
  managerToken,
  clientUuids,
  concurrency = 20,
  uploadJitterMaxMs = 0,
  allowLocalhost = false,
} = {}) {
  const origin = canonicalOrigin(baseUrl, { allowLocalhost });
  if (typeof managerToken !== 'string' || managerToken.length < 1 || managerToken.length > 16_384) {
    throw new Error('manager_token_required');
  }
  if (!Array.isArray(clientUuids) || clientUuids.length < 1 || clientUuids.length > 500) {
    throw new Error('client_manifest_size_invalid');
  }
  const normalizedClients = clientUuids.map((value) => String(value || '').trim().toLowerCase());
  if (normalizedClients.some((value) => !UUID.test(value))) throw new Error('client_uuid_invalid');
  if (new Set(normalizedClients).size !== normalizedClients.length) throw new Error('client_uuid_must_be_unique');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('concurrency_invalid');
  if (!Number.isInteger(uploadJitterMaxMs) || uploadJitterMaxMs < 0 || uploadJitterMaxMs > 10_000) {
    throw new Error('upload_jitter_invalid');
  }
  return { origin, clientUuids: normalizedClients, concurrency, uploadJitterMaxMs };
}

async function defaultSnapshotTemplate() {
  const source = new URL('../../test/fixtures/auto-export/snapshot-v1.json', import.meta.url);
  return JSON.parse(await readFile(source, 'utf8'));
}

function newYorkDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function makeSnapshot(template, scenario, capturedAt, spoofedMachineId) {
  const snapshot = structuredClone(template);
  snapshot.schemaVersion = 1;
  snapshot.captureId = scenario.captureId;
  snapshot.capturedAt = capturedAt.toISOString();
  snapshot.tradingDate = newYorkDate(capturedAt);
  snapshot.timeZone = 'America/New_York';
  snapshot.source = {
    ...snapshot.source,
    machineId: spoofedMachineId || scenario.machineId,
    agentVersion: '1.0.0',
    addonVersion: '1.0.0',
    ninjaTraderVersion: '8.1.5.2',
  };
  return snapshot;
}

async function mapPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(1));
}

function latencySummary(samples) {
  return Object.fromEntries([...samples.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([stage, values]) => [stage, {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(1)) : null,
  }]));
}

function groupedFailures(entries) {
  const groups = new Map();
  for (const { stage, code } of entries) {
    const key = `${stage}\0${code}`;
    const prior = groups.get(key) || { stage, code, count: 0 };
    prior.count += 1;
    groups.set(key, prior);
  }
  return [...groups.values()].sort((left, right) => `${left.stage}:${left.code}`.localeCompare(`${right.stage}:${right.code}`));
}

function safeFailure(error, fallbackStage) {
  if (error instanceof HarnessFailure) return { stage: error.stage, code: error.code };
  return { stage: fallbackStage, code: 'unexpected_failure' };
}

export async function runAutoCollectionFleet({
  baseUrl,
  managerToken,
  clientUuids,
  concurrency = 20,
  uploadJitterMaxMs = 0,
  allowLocalhost = false,
  fetchImpl = globalThis.fetch,
  snapshotTemplate,
  deterministicCaptureIds,
  now = () => new Date(),
  uuidFactory = randomUUID,
  nonceFactory = () => randomBytes(32).toString('base64url'),
  random = Math.random,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requestTimeoutMs = 30_000,
} = {}) {
  const config = validateLoadConfiguration({
    baseUrl, managerToken, clientUuids, concurrency, uploadJitterMaxMs, allowLocalhost,
  });
  if (typeof fetchImpl !== 'function') throw new Error('fetch_implementation_required');
  if (typeof random !== 'function' || typeof delay !== 'function') throw new Error('jitter_dependency_invalid');
  if (deterministicCaptureIds != null
    && (!Array.isArray(deterministicCaptureIds)
      || deterministicCaptureIds.length !== config.clientUuids.length
      || deterministicCaptureIds.some((value) => !UUID.test(String(value || '')))
      || new Set(deterministicCaptureIds.map((value) => value.toLowerCase())).size !== deterministicCaptureIds.length)) {
    throw new Error('capture_ids_invalid');
  }

  const template = snapshotTemplate ? structuredClone(snapshotTemplate) : await defaultSnapshotTemplate();
  const startedAt = now();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('clock_invalid');
  const samples = new Map();
  const rawFailures = [];
  const scenarios = config.clientUuids.map((clientUuid, index) => ({
    index,
    clientUuid,
    machineId: `vincere-load-${uuidFactory()}`,
    captureId: deterministicCaptureIds?.[index]?.toLowerCase() || uuidFactory(),
    pairingNonce: nonceFactory(),
    enrollmentCode: null,
    deviceId: null,
    deviceToken: null,
    batchId: null,
    dailyImportId: null,
    snapshot: null,
    paired: false,
    processed: false,
    duplicate: false,
    routed: false,
    jsonDownloaded: false,
    storageVerified: false,
    zipDownloaded: false,
    persistenceVerified: false,
    normalizedCounts: null,
    pnlSources: null,
    revoked: false,
  }));

  async function waitForUploadWindow() {
    if (config.uploadJitterMaxMs === 0) return;
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('random_sample_invalid');
    const milliseconds = Math.floor(sample * config.uploadJitterMaxMs);
    if (milliseconds > 0) await delay(milliseconds);
  }

  async function request(stage, path, {
    method = 'GET',
    token,
    machineId,
    body,
    expectedStatuses = [200],
    responseType = 'json',
  } = {}) {
    const url = new URL(path, config.origin);
    if (url.origin !== config.origin) fail(stage, 'origin_mismatch');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const requestStarted = performance.now();
    let response;
    try {
      response = await fetchImpl(url.href, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(machineId ? { 'X-Machine-Id': machineId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      fail(stage, error?.name === 'AbortError' ? 'request_timeout' : 'network_failure');
    } finally {
      clearTimeout(timer);
      const values = samples.get(stage) || [];
      values.push(performance.now() - requestStarted);
      samples.set(stage, values);
    }
    if (!expectedStatuses.includes(response.status)) fail(stage, `http_${response.status}`);
    if (responseType === 'bytes') return { response, body: new Uint8Array(await response.arrayBuffer()) };
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      fail(stage, 'invalid_json_response');
    }
    return { response, body: parsed };
  }

  async function stage(items, name, worker) {
    await mapPool(items, config.concurrency, async (scenario, index) => {
      try {
        await worker(scenario, index);
      } catch (error) {
        rawFailures.push(safeFailure(error, name));
      }
    });
  }

  await stage(scenarios, 'enrollment', async (scenario) => {
    const { body } = await request('enrollment', '/api/admin/ingest-enrollment', {
      method: 'POST',
      token: managerToken,
      body: { clientUuid: scenario.clientUuid, action: 'generate' },
      expectedStatuses: [201],
    });
    if (typeof body?.enrollment?.code !== 'string' || !UUID.test(body?.enrollment?.id || '')) {
      fail('enrollment', 'invalid_enrollment_response');
    }
    scenario.enrollmentCode = body.enrollment.code;
  });

  await stage(scenarios.filter((item) => item.enrollmentCode), 'pair', async (scenario) => {
    const { body } = await request('pair', '/api/ingest/pair', {
      method: 'POST',
      body: {
        enrollmentCode: scenario.enrollmentCode,
        machineId: scenario.machineId,
        pairingNonce: scenario.pairingNonce,
        agentVersion: '1.0.0',
        addonVersion: '1.0.0',
      },
    });
    if (!UUID.test(body?.deviceId || '') || typeof body?.deviceToken !== 'string' || body.deviceToken.length < 20) {
      fail('pair', 'invalid_pair_response');
    }
    scenario.deviceId = body.deviceId.toLowerCase();
    scenario.deviceToken = body.deviceToken;
    scenario.paired = true;
  });

  let enrollmentReplayRejected = 0;
  const replayTarget = scenarios.find((item) => item.paired);
  if (replayTarget) {
    try {
      await request('pair_replay', '/api/ingest/pair', {
        method: 'POST',
        body: {
          enrollmentCode: replayTarget.enrollmentCode,
          machineId: `vincere-replay-${uuidFactory()}`,
          pairingNonce: nonceFactory(),
          agentVersion: '1.0.0',
          addonVersion: '1.0.0',
        },
        expectedStatuses: [400],
      });
      enrollmentReplayRejected = 1;
    } catch (error) {
      rawFailures.push(safeFailure(error, 'pair_replay'));
    }
  }

  const paired = scenarios.filter((item) => item.paired);
  await stage(paired, 'heartbeat', async (scenario) => {
    const { body } = await request('heartbeat', '/api/ingest/heartbeat', {
      method: 'POST',
      token: scenario.deviceToken,
      machineId: scenario.machineId,
      body: {
        agentVersion: '1.0.0',
        addonVersion: '1.0.0',
        ninjaTraderVersion: '8.1.5.2',
        lastCaptureAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        queueDepth: 0,
        queueBytes: 0,
        addonAvailable: true,
      },
    });
    if (body?.deviceId !== scenario.deviceId || !['online', 'update_required'].includes(body?.status)) {
      fail('heartbeat', 'invalid_heartbeat_response');
    }
  });

  let sourceMetadataSpoofRejected = 0;
  const spoofTarget = paired[0];
  if (spoofTarget) {
    try {
      const otherMachine = paired[1]?.machineId || `vincere-spoof-${uuidFactory()}`;
      const spoofedSnapshot = makeSnapshot(template, spoofTarget, startedAt, otherMachine);
      const { body } = await request('source_metadata_spoof', '/api/ingest/daily', {
        method: 'POST',
        token: spoofTarget.deviceToken,
        machineId: spoofTarget.machineId,
        body: spoofedSnapshot,
        expectedStatuses: [400],
      });
      if (body?.error !== 'source_machine_mismatch') fail('source_metadata_spoof', 'spoof_rejection_mismatch');
      sourceMetadataSpoofRejected = 1;
    } catch (error) {
      rawFailures.push(safeFailure(error, 'source_metadata_spoof'));
    }
  }

  await stage(paired, 'ingest', async (scenario) => {
    await waitForUploadWindow();
    scenario.snapshot = makeSnapshot(template, scenario, startedAt, null);
    const { body } = await request('ingest', '/api/ingest/daily', {
      method: 'POST', token: scenario.deviceToken, machineId: scenario.machineId,
      body: scenario.snapshot, expectedStatuses: [201],
    });
    if (body?.ok !== true || body?.duplicate !== false || !UUID.test(body?.batchId || '')
      || !UUID.test(body?.dailyImportId || '') || !SUCCESS_STATUS.has(body?.status)) {
      fail('ingest', 'invalid_ingest_response');
    }
    scenario.batchId = body.batchId.toLowerCase();
    scenario.dailyImportId = body.dailyImportId.toLowerCase();
    scenario.processed = true;
  });

  await stage(scenarios.filter((item) => item.processed), 'duplicate', async (scenario) => {
    await waitForUploadWindow();
    const { body } = await request('duplicate', '/api/ingest/daily', {
      method: 'POST', token: scenario.deviceToken, machineId: scenario.machineId, body: scenario.snapshot,
    });
    if (body?.ok !== true || body?.duplicate !== true
      || body?.batchId?.toLowerCase() !== scenario.batchId
      || body?.dailyImportId?.toLowerCase() !== scenario.dailyImportId) {
      fail('duplicate', 'duplicate_receipt_mismatch');
    }
    scenario.duplicate = true;
  });

  await stage(scenarios.filter((item) => item.processed), 'history', async (scenario) => {
    const query = new URLSearchParams({ captureId: scenario.captureId, pageSize: '2' });
    const { body } = await request('history', `/api/admin/ingest-batches?${query}`, { token: managerToken });
    const rows = Array.isArray(body?.batches) ? body.batches : [];
    const row = rows[0];
    if (rows.length !== 1
      || row?.captureId?.toLowerCase() !== scenario.captureId.toLowerCase()
      || row?.clientUuid?.toLowerCase() !== scenario.clientUuid
      || row?.deviceId?.toLowerCase() !== scenario.deviceId
      || row?.id?.toLowerCase() !== scenario.batchId
      || row?.dailyImportId?.toLowerCase() !== scenario.dailyImportId) {
      fail('history', 'routing_mismatch');
    }
    scenario.routed = true;
  });

  await stage(scenarios.filter((item) => item.routed), 'download_json', async (scenario) => {
    const query = new URLSearchParams({ batchId: scenario.batchId, format: 'json' });
    const { body } = await request('download_json', `/api/admin/ingest-download?${query}`, { token: managerToken });
    if (body?.captureId?.toLowerCase() !== scenario.captureId.toLowerCase()) fail('download_json', 'snapshot_download_mismatch');
    scenario.jsonDownloaded = true;
    scenario.storageVerified = true;
  });

  await stage(scenarios.filter((item) => item.routed), 'download_zip', async (scenario) => {
    const query = new URLSearchParams({ batchId: scenario.batchId, format: 'zip' });
    const { response, body } = await request('download_zip', `/api/admin/ingest-download?${query}`, {
      token: managerToken, responseType: 'bytes',
    });
    if (response.headers.get('content-type') !== 'application/zip'
      || body.length < 4 || body[0] !== 80 || body[1] !== 75) {
      fail('download_zip', 'zip_download_invalid');
    }
    scenario.zipDownloaded = true;
  });

  await stage(scenarios.filter((item) => item.jsonDownloaded && item.zipDownloaded), 'persistence', async (scenario) => {
    const query = new URLSearchParams({ batchId: scenario.batchId });
    const { body } = await request('persistence', `/api/admin/ingest-verify?${query}`, { token: managerToken });
    const countsValid = PERSISTED_COUNT_KEYS.every((key) => Number.isSafeInteger(body?.counts?.[key]) && body.counts[key] >= 0);
    const expectedValid = PERSISTED_COUNT_KEYS.every((key) => Number.isSafeInteger(body?.expectedCounts?.[key]) && body.expectedCounts[key] >= 0);
    const countsMatch = countsValid && expectedValid
      && PERSISTED_COUNT_KEYS.every((key) => body.counts[key] === body.expectedCounts[key]);
    const pnlSourcesValid = PNL_SOURCE_KEYS.every((key) => Number.isSafeInteger(body?.pnlSources?.[key]) && body.pnlSources[key] >= 0)
      && PNL_SOURCE_KEYS.reduce((total, key) => total + body.pnlSources[key], 0) === body?.counts?.accounts;
    if (body?.ok !== true || !Array.isArray(body?.failures) || body.failures.length !== 0
      || !countsMatch || !pnlSourcesValid || body?.duplicateClaimCount !== 1
      || body?.terminalAuditCount !== 1 || body?.downloadAuditCount < 2) {
      fail('persistence', 'persistence_evidence_mismatch');
    }
    scenario.persistenceVerified = true;
    scenario.normalizedCounts = Object.fromEntries(PERSISTED_COUNT_KEYS.map((key) => [key, body.counts[key]]));
    scenario.pnlSources = Object.fromEntries(PNL_SOURCE_KEYS.map((key) => [key, body.pnlSources[key]]));
  });

  await stage(paired, 'revoke', async (scenario) => {
    const { body } = await request('revoke', '/api/admin/ingest-enrollment', {
      method: 'DELETE',
      token: managerToken,
      body: { clientUuid: scenario.clientUuid, deviceId: scenario.deviceId, reason: 'support_reset' },
    });
    if (body?.revoked?.id?.toLowerCase() !== scenario.deviceId) fail('revoke', 'revoke_response_mismatch');
    scenario.revoked = true;
    scenario.deviceToken = null;
    scenario.enrollmentCode = null;
    scenario.pairingNonce = null;
  });

  const failures = groupedFailures(rawFailures);
  const batchIds = scenarios.filter((item) => item.processed).map((item) => item.batchId);
  const requestCount = [...samples.values()].reduce((total, values) => total + values.length, 0);
  const failedOperations = rawFailures.length;
  const completedAt = now();
  const normalizedRows = Object.fromEntries(PERSISTED_COUNT_KEYS.map((key) => [
    key,
    scenarios.reduce((total, scenario) => total + (scenario.normalizedCounts?.[key] || 0), 0),
  ]));
  const pnlSources = Object.fromEntries(PNL_SOURCE_KEYS.map((key) => [
    key,
    scenarios.reduce((total, scenario) => total + (scenario.pnlSources?.[key] || 0), 0),
  ]));
  const report = {
    schemaVersion: 1,
    ok: failures.length === 0,
    startedAt: startedAt.toISOString(),
    completedAt: (completedAt instanceof Date && !Number.isNaN(completedAt.getTime()) ? completedAt : new Date()).toISOString(),
    requestCount,
    failedOperations,
    errorRate: requestCount ? Number((failedOperations / requestCount).toFixed(6)) : 0,
    requestedDevices: scenarios.length,
    uploadJitterMaxMs: config.uploadJitterMaxMs,
    pairedDevices: scenarios.filter((item) => item.paired).length,
    enrollmentReplayRejected,
    sourceMetadataSpoofRejected,
    processedCaptures: scenarios.filter((item) => item.processed).length,
    duplicateReceipts: scenarios.filter((item) => item.duplicate).length,
    routedCaptures: scenarios.filter((item) => item.routed).length,
    uniqueBatchCount: new Set(batchIds).size,
    verifiedPersistence: scenarios.filter((item) => item.persistenceVerified).length,
    verifiedStorageObjects: scenarios.filter((item) => item.storageVerified).length,
    normalizedRows,
    pnlSources,
    jsonDownloads: scenarios.filter((item) => item.jsonDownloaded).length,
    zipDownloads: scenarios.filter((item) => item.zipDownloaded).length,
    revokedDevices: scenarios.filter((item) => item.revoked).length,
    failures,
    latency: latencySummary(samples),
  };
  return report;
}

export function formatFleetLoadReport(report) {
  const lines = [
    `Auto-collection staging load: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Requested devices: ${report.requestedDevices}`,
    `Upload jitter window: ${report.uploadJitterMaxMs}ms`,
    `Requests: ${report.requestCount} failures=${report.failedOperations} errorRate=${report.errorRate}`,
    `Paired devices: ${report.pairedDevices}`,
    `Rejected source metadata spoof: ${report.sourceMetadataSpoofRejected}`,
    `Processed captures: ${report.processedCaptures}`,
    `Duplicate receipts: ${report.duplicateReceipts}`,
    `Routed captures: ${report.routedCaptures}`,
    `Unique batches: ${report.uniqueBatchCount}`,
    `Verified persistence: ${report.verifiedPersistence}`,
    `Verified Storage objects: ${report.verifiedStorageObjects}`,
    `Normalized rows: accounts=${report.normalizedRows?.accounts || 0} strategies=${report.normalizedRows?.strategies || 0} orders=${report.normalizedRows?.orders || 0} executions=${report.normalizedRows?.executions || 0} flags=${report.normalizedRows?.flags || 0}`,
    `PnL sources: realized=${report.pnlSources?.realized || 0} gross_fallback=${report.pnlSources?.gross_fallback || 0} gross_missing_realized=${report.pnlSources?.gross_missing_realized || 0} unavailable=${report.pnlSources?.unavailable || 0} unknown=${report.pnlSources?.unknown || 0}`,
    `JSON downloads: ${report.jsonDownloads}`,
    `ZIP downloads: ${report.zipDownloads}`,
    `Revoked devices: ${report.revokedDevices}`,
  ];
  for (const failure of report.failures || []) lines.push(`Failure ${failure.stage}/${failure.code}: ${failure.count}`);
  for (const [stage, metrics] of Object.entries(report.latency || {})) {
    lines.push(`Latency ${stage}: count=${metrics.count} p50=${metrics.p50Ms}ms p95=${metrics.p95Ms}ms p99=${metrics.p99Ms}ms max=${metrics.maxMs}ms`);
  }
  return `${lines.join('\n')}\n`;
}
