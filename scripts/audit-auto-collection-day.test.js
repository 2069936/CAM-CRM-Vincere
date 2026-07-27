import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifyFleetRow } from '../src/domain/autoCollectionFleet.js';
import {
  auditAutoCollectionDay,
  buildAuditReport,
  parseArguments,
  runDailyAudit,
} from './audit-auto-collection-day.mjs';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const REDACTION_KEY = 'a-private-audit-redaction-key-at-least-32-bytes';

function rowAt(now, overrides = {}) {
  const device = {
    id: DEVICE_ID,
    status: 'active',
    healthStatus: 'online',
    lastSeenAt: now,
    agentVersion: '1.4.2',
    schedule: { time: '16:45:00', timezone: 'America/New_York' },
    ...overrides.device,
  };
  const todayBatch = overrides.todayBatch || null;
  return {
    client: { uuid: CLIENT_ID, name: 'Must never enter the report' },
    device,
    todayBatch,
    operationalStatus: classifyFleetRow({
      now,
      device,
      todayBatch,
      releaseVersion: '1.4.2',
    }),
  };
}

describe('daily collector audit classifications', () => {
  it.each([
    ['pre-schedule', '2026-07-23T20:30:00.000Z', {}, 'pending'],
    ['grace', '2026-07-23T20:55:00.000Z', {}, 'expected'],
    ['late', '2026-07-23T21:01:00.000Z', {}, 'late'],
    ['weekend', '2026-07-25T21:01:00.000Z', {}, 'not_expected'],
    ['revoked', '2026-07-23T21:01:00.000Z', { device: { status: 'revoked', revokedAt: '2026-07-23T20:00:00Z' } }, 'revoked'],
    ['paused', '2026-07-23T21:01:00.000Z', { device: { status: 'paused' } }, 'paused'],
    ['incomplete', '2026-07-23T21:01:00.000Z', { todayBatch: { status: 'incomplete', errorCode: 'invalid_auto_import_snapshot' } }, 'incomplete'],
    ['update-required', '2026-07-23T21:01:00.000Z', { device: { healthStatus: 'update_required' } }, 'update_required'],
  ])('classifies %s in America/New_York', (_label, now, overrides, expected) => {
    expect(rowAt(now, overrides).operationalStatus.state).toBe(expected);
  });

  it('emits aggregate counts and stable HMAC references without identifiers or values', () => {
    const now = '2026-07-23T21:01:00.000Z';
    const rows = [
      rowAt(now),
      rowAt(now, { todayBatch: { status: 'incomplete', errorCode: 'invalid_auto_import_snapshot' } }),
    ];
    const report = buildAuditReport({ rows, serverTime: now, redactionKey: REDACTION_KEY });
    const output = JSON.stringify(report);
    expect(report).toMatchObject({
      schemaVersion: 1,
      tradingDate: '2026-07-23',
      total: 2,
      counts: { late: 1, incomplete: 1 },
      attention: [{ state: 'late' }, { state: 'incomplete', errorCode: 'invalid_auto_import_snapshot' }],
    });
    expect(report.attention[0].clientRef).toMatch(/^client_[a-f0-9]{16}$/);
    expect(report.attention[0].deviceRef).toMatch(/^device_[a-f0-9]{16}$/);
    expect(output).not.toContain(CLIENT_ID);
    expect(output).not.toContain(DEVICE_ID);
    expect(output).not.toContain('Must never enter the report');
    expect(output).not.toContain(REDACTION_KEY);
  });
});

describe('daily collector audit API consumer', () => {
  it('reads only bounded Manager fleet pages and never follows redirects', async () => {
    const now = '2026-07-23T21:01:00.000Z';
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...rowAt(now),
      client: { uuid: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Client ${index}` },
    }));
    const fetchImpl = vi.fn(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify({
        serverTime: now,
        page,
        pageSize: 100,
        total: rows.length,
        rows: page === 1 ? rows.slice(0, 100) : rows.slice(100),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const report = await auditAutoCollectionDay({
      baseUrl: 'https://crm.example.test',
      managerToken: 'ephemeral-token',
      redactionKey: REDACTION_KEY,
      fetchImpl,
    });
    expect(report.total).toBe(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url).toMatch(/^https:\/\/crm\.example\.test\/api\/admin\/ingest-fleet\?/);
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(options.headers.Authorization).toBe('Bearer ephemeral-token');
    }
  });

  it('fails closed on malformed totals and unexpected statuses', async () => {
    const response = (body) => vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(auditAutoCollectionDay({
      baseUrl: 'https://crm.example.test', managerToken: 'token', redactionKey: REDACTION_KEY,
      fetchImpl: response({ serverTime: '2026-07-23T21:01:00Z', page: 1, pageSize: 100, total: 2, rows: [rowAt('2026-07-23T21:01:00Z')] }),
    })).rejects.toThrow('fleet_page_count_mismatch');
    await expect(auditAutoCollectionDay({
      baseUrl: 'https://crm.example.test', managerToken: 'token', redactionKey: REDACTION_KEY,
      fetchImpl: response({ serverTime: '2026-07-23T21:01:00Z', page: 1, pageSize: 100, total: 1, rows: [{ ...rowAt('2026-07-23T21:01:00Z'), operationalStatus: { state: 'secret_state' } }] }),
    })).rejects.toThrow('fleet_status_invalid');
  });

  it('rejects a New York trading-date change across pages', async () => {
    const firstPageRows = Array.from({ length: 100 }, () => rowAt('2026-07-23T21:01:00Z'));
    const fetchImpl = vi.fn(async () => {
      const page = fetchImpl.mock.calls.length;
      return new Response(JSON.stringify({
        serverTime: page === 1 ? '2026-07-23T23:59:00Z' : '2026-07-24T04:01:00Z',
        page,
        pageSize: 100,
        total: 101,
        rows: page === 1 ? firstPageRows : [rowAt('2026-07-24T04:01:00Z')],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await expect(auditAutoCollectionDay({
      baseUrl: 'https://crm.example.test', managerToken: 'token', redactionKey: REDACTION_KEY, fetchImpl,
    })).rejects.toThrow('fleet_trading_date_changed');
  });
});

describe('daily collector audit CLI', () => {
  it('requires an exact origin confirmation and accepts no secret arguments', () => {
    expect(() => parseArguments(['--base-url', 'https://crm.example.test', '--out', 'audit.json']))
      .toThrow('Missing required argument --confirm-origin.');
    expect(() => parseArguments([
      '--base-url', 'https://crm.example.test', '--confirm-origin', 'https://crm.example.test',
      '--out', 'audit.json', '--manager-token', 'secret',
    ])).toThrow('Unknown argument: --manager-token');
  });

  it('writes a private sanitized report and does not persist credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'collector-audit-'));
    const outputPath = join(directory, 'audit.json');
    const report = { schemaVersion: 1, tradingDate: '2026-07-23', total: 0, counts: {}, attention: [] };
    const audit = vi.fn(async () => report);
    await runDailyAudit({
      baseUrl: 'https://crm.example.test',
      confirmOrigin: 'https://crm.example.test',
      outputPath,
      env: {
        AUTO_COLLECTION_AUDIT_MANAGER_TOKEN: 'ephemeral-token',
        AUTO_COLLECTION_AUDIT_REDACTION_KEY: REDACTION_KEY,
        AUTO_COLLECTION_AUDIT_ALLOW_ORIGIN: 'https://crm.example.test',
      },
      audit,
    });
    const output = await readFile(outputPath, 'utf8');
    expect(JSON.parse(output)).toEqual(report);
    expect(output).not.toContain('ephemeral-token');
    expect(output).not.toContain(REDACTION_KEY);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it('uses domain-separated hashes for client and device references', () => {
    const report = buildAuditReport({
      rows: [rowAt('2026-07-23T21:01:00.000Z')],
      serverTime: '2026-07-23T21:01:00.000Z',
      redactionKey: REDACTION_KEY,
    });
    const plainHash = createHash('sha256').update(CLIENT_ID).digest('hex').slice(0, 16);
    expect(report.attention[0].clientRef).not.toContain(plainHash);
    expect(report.attention[0].clientRef).not.toBe(report.attention[0].deviceRef);
  });
});
