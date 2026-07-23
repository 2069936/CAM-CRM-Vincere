import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AutoCollectionCard from './AutoCollectionCard';
import { buildAutoCollectionViewModel, confirmationPhrase, copyEnrollmentCode, remainingEnrollmentSeconds } from '../domain/autoCollectionViewModel';

const base = {
  serverTime: '2026-07-23T16:45:00.000Z',
  client: { uuid: '11111111-1111-4111-8111-111111111111', name: 'Acme Trading' },
  permissions: { generate: true, rebind: true, revoke: true },
  release: { url: 'https://downloads.example.test/agent.msi', version: '1.4.2', sha256: 'a'.repeat(64), publishedAt: '2026-07-23T14:00:00.000Z' },
  device: null,
  enrollment: null,
};

function render(status, props = {}) {
  return renderToStaticMarkup(<AutoCollectionCard
    clientUuid={base.client.uuid}
    clientName={base.client.name}
    initialStatus={status}
    disableAutoLoad
    {...props}
  />);
}

describe('auto collection setup view model', () => {
  it('is safe during the initial status request', () => {
    expect(buildAutoCollectionViewModel(null, Date.parse(base.serverTime))).toMatchObject({ state: 'unavailable' });
    expect(render(null, { disableAutoLoad: false })).toContain('Checking…');
  });

  it('distinguishes unavailable and not installed states with a clear next action', () => {
    expect(buildAutoCollectionViewModel({ ...base, release: null }, Date.parse(base.serverTime))).toMatchObject({ state: 'unavailable', nextAction: 'release_unavailable' });
    expect(buildAutoCollectionViewModel(base, Date.parse(base.serverTime))).toMatchObject({ state: 'not_installed', nextAction: 'download' });
  });

  it('distinguishes paired online, offline, failed, revoked, and update-required devices', () => {
    const device = { id: 'device', status: 'active', healthStatus: 'online', lastSeenAt: '2026-07-23T16:44:00.000Z' };
    expect(buildAutoCollectionViewModel({ ...base, device }, Date.parse(base.serverTime)).state).toBe('online');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, lastSeenAt: '2026-07-23T16:30:00.000Z' } }, Date.parse(base.serverTime)).state).toBe('offline');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, healthStatus: 'error', lastErrorCode: 'capture_failed' } }, Date.parse(base.serverTime)).state).toBe('failed');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, status: 'revoked', revokedAt: base.serverTime } }, Date.parse(base.serverTime)).state).toBe('revoked');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, healthStatus: 'update_required' } }, Date.parse(base.serverTime)).state).toBe('update_required');
  });

  it('uses server expiry for the one-time-code countdown', () => {
    expect(remainingEnrollmentSeconds('2026-07-23T16:46:30.000Z', Date.parse(base.serverTime))).toBe(90);
    expect(remainingEnrollmentSeconds('2026-07-23T16:44:00.000Z', Date.parse(base.serverTime))).toBe(0);
  });

  it('prioritizes a fresh rebind code over the revoked prior VPS', () => {
    const status = {
      ...base,
      device: { id: 'old-device', status: 'revoked', revokedAt: base.serverTime },
      enrollment: { id: 'new-enrollment', code: 'NEXT-CODE', expiresAt: '2026-07-23T16:50:00.000Z', consumedAt: null, revokedAt: null },
    };
    expect(buildAutoCollectionViewModel(status, Date.parse(base.serverTime))).toMatchObject({ state: 'awaiting_pair', nextAction: 'enter_code' });
  });

  it('shows a revoked unused enrollment even when no device has paired', () => {
    expect(buildAutoCollectionViewModel({ ...base, device: null, enrollment: { id: 'enrollment', revokedAt: base.serverTime } }, Date.parse(base.serverTime)).state).toBe('revoked');
  });
});

describe('AutoCollectionCard rendering and actions', () => {
  it('renders one sequential four-step connection trace instead of generic cards', () => {
    const html = render(base);
    expect(html).toContain('Download installer');
    expect(html).toContain('Run as administrator');
    expect(html).toContain('Enter one-time code');
    expect(html).toContain('Confirm connection');
    expect((html.match(/auto-collection-step/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('href="https://downloads.example.test/agent.msi"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders a generated code, expiry countdown, and copy control without leaking other secrets', () => {
    const html = render({ ...base, enrollment: { id: 'enrollment', code: 'ABCD-EFGH', expiresAt: '2026-07-23T16:47:00.000Z', consumedAt: null, revokedAt: null } });
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('2:00 remaining');
    expect(html).toContain('aria-label="Copy one-time code"');
    expect(html).not.toContain('auto-collection-step done');
    expect(html).not.toMatch(/product.?key|device.?token|credential.?hash|machine.?hash/i);
  });

  it('copies only the supplied enrollment code', async () => {
    const writeText = vi.fn(async () => undefined);
    await copyEnrollmentCode('ABCD-EFGH', { writeText });
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
  });

  it('requires exact client-bound confirmation phrases for every mutation', () => {
    expect(confirmationPhrase('generate', 'Acme Trading')).toBe('GENERATE Acme Trading');
    expect(confirmationPhrase('rebind', 'Acme Trading')).toBe('REBIND Acme Trading');
    expect(confirmationPhrase('revoke', 'Acme Trading')).toBe('REVOKE Acme Trading');
  });

  it.each([
    ['online', { healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:44:00.000Z' }, 'Connected'],
    ['offline', { healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:20:00.000Z' }, 'Offline'],
    ['failed', { healthStatus: 'error', status: 'active', lastSeenAt: base.serverTime, lastErrorCode: 'capture_failed' }, 'Needs attention'],
    ['revoked', { healthStatus: 'online', status: 'revoked', lastSeenAt: base.serverTime, revokedAt: base.serverTime }, 'Access revoked'],
    ['update', { healthStatus: 'update_required', status: 'active', lastSeenAt: base.serverTime }, 'Update required'],
  ])('renders the %s operational state', (_name, device, copy) => {
    expect(render({ ...base, device: { id: 'device', agentVersion: '1.4.1', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.5.2', schedule: { time: '16:45:00', timezone: 'America/New_York' }, ...device } })).toContain(copy);
  });

  it('shows binding, timestamps, versions, 16:45 ET schedule, and intentional controls', () => {
    const html = render({ ...base, device: { id: 'device', healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:44:00.000Z', lastCaptureAt: '2026-07-22T20:45:00.000Z', lastSuccessAt: '2026-07-22T20:46:00.000Z', agentVersion: '1.4.2', addonVersion: '1.1.0', ninjaTraderVersion: '8.1.5.2', schedule: { time: '16:45:00', timezone: 'America/New_York' } } });
    expect(html).toContain('Acme Trading');
    expect(html).toContain('4:45 PM ET');
    expect(html).toContain('Agent 1.4.2');
    expect(html).toContain('Add-on 1.1.0');
    expect(html).toContain('Rebind VPS');
    expect(html).toContain('Revoke access');
  });

  it('renders permission denied without operational actions', () => {
    const html = render(null, { initialError: { status: 403, message: 'You do not have access to this client setup.' } });
    expect(html).toContain('Permission required');
    expect(html).not.toContain('Generate one-time code');
    expect(html).not.toContain('Revoke access');
  });
});
