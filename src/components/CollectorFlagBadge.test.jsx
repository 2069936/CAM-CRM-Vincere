import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CollectorFlagBadge from './CollectorFlagBadge';
import AutoCollectionCard from './AutoCollectionCard';

/* A collection problem lives on Credentials & Notes, a tab nobody opens unless
 * they already suspect something. The badge says it beside the client's name on
 * every tab and takes them there. Both surfaces read the same collectorFlags,
 * so what is asserted here is that neither invents or hides one. */
const CLIENT = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-23T21:00:00Z';

function status(overrides = {}) {
  return {
    serverTime: NOW,
    client: { uuid: CLIENT, name: 'Acme Trading' },
    permissions: { generate: true, rebind: true, revoke: true },
    release: { url: 'https://downloads.example.test/agent.msi', version: '1.0.8', sha256: 'a'.repeat(64) },
    device: {
      id: 'device-1', status: 'active', healthStatus: 'online',
      agentVersion: '1.0.8', revokedAt: null,
      createdAt: '2026-01-04T12:00:00Z', lastSeenAt: NOW,
      schedule: { time: '16:30:00', timezone: 'America/New_York' },
    },
    enrollment: null,
    lastBatch: { tradingDate: '2026-09-23', status: 'processed', rowCounts: { accounts: 5 } },
    ...overrides,
  };
}

function badge(value, props = {}) {
  return renderToStaticMarkup(<CollectorFlagBadge
    clientUuid={CLIENT}
    initialStatus={value}
    api={{ loadStatus: () => new Promise(() => {}) }}
    now={() => new Date(NOW)}
    {...props}
  />);
}

describe('the flag beside the client name', () => {
  it('says nothing when there is nothing to say', () => {
    expect(badge(status())).toBe('');
    expect(badge(null)).toBe('');
  });

  it('names the newer build and points at the tab that installs it', () => {
    const html = badge(status({ device: { ...status().device, agentVersion: '1.0.5' } }));
    expect(html).toContain('Collector needs updating');
    expect(html).toContain('Open Credentials &amp; Notes');
    expect(html).toContain('collector-flag-badge warning');
  });

  it('is red, not amber, when the VPS collected nothing', () => {
    const html = badge(status({ lastBatch: { tradingDate: '2026-09-23', rowCounts: { accounts: 0 } } }));
    expect(html).toContain('collector-flag-badge alert');
    expect(html).toContain('Collected nothing on the last capture');
  });

  it('shows the worst one and counts the rest', () => {
    const html = badge(status({
      device: { ...status().device, agentVersion: '1.0.5' },
      lastBatch: { tradingDate: '2026-09-23', rowCounts: { accounts: 0 } },
    }));
    expect(html).toContain('Collected nothing on the last capture +1');
    expect(html).toContain('alert');
  });

  it('goes quiet rather than putting a load error beside a client name', async () => {
    const api = { loadStatus: vi.fn(async () => { throw new Error('collector_status_failed'); }) };
    expect(renderToStaticMarkup(<CollectorFlagBadge clientUuid={CLIENT} api={api} />)).toBe('');
  });

  it('has no dismiss control of any kind', () => {
    // The flag is derived on every load, so there is nothing to acknowledge and
    // no way to make it go away except by fixing what it describes.
    const html = badge(status({ device: { ...status().device, agentVersion: '1.0.5' } }));
    expect(html).not.toMatch(/dismiss|acknowledge|snooze|×/i);
  });
});

describe('the same flags in the card that fixes them', () => {
  function card(value) {
    return renderToStaticMarkup(<AutoCollectionCard
      clientUuid={CLIENT}
      clientName="Acme Trading"
      initialStatus={value}
      disableAutoLoad
    />);
  }

  it('lists what the badge summarizes, with what to do about it', () => {
    const html = card(status({
      device: { ...status().device, agentVersion: '1.0.5' },
      lastBatch: { tradingDate: '2026-09-22', rowCounts: { accounts: 0 } },
    }));
    expect(html).toContain('Collected nothing on the last capture');
    expect(html).toContain('Collector needs updating');
    expect(html).toContain('connect the broker');
    expect(html).toContain('1.0.5');
  });

  it('shows no list when the collection is healthy', () => {
    expect(card(status())).not.toContain('collector-flags');
  });

  it('offers nothing to click that would clear a flag', () => {
    const html = card(status({ lastBatch: { tradingDate: '2026-09-22', rowCounts: { accounts: 0 } } }));
    const list = html.slice(html.indexOf('collector-flags'), html.indexOf('</ul>'));
    expect(list).not.toContain('<button');
  });
});
