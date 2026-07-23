import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import AutoCollectionManager from './AutoCollectionManager';

const fleet = {
  serverTime: '2026-07-23T21:01:00.000Z', page: 1, pageSize: 25, total: 1,
  summary: { total: 1, attention: 1, incomplete: 1 },
  rows: [{
    client: { uuid: '11111111-1111-4111-8111-111111111111', name: 'Rome McMahon' },
    device: { id: '22222222-2222-4222-8222-222222222222', lastSeenAt: '2026-07-23T21:00:00Z', agentVersion: '1.4.2', schedule: { time: '16:45:00', timezone: 'America/New_York' } },
    todayBatch: { id: '33333333-3333-4333-8333-333333333333', status: 'incomplete', rowCounts: { accounts: 2, strategies: 3, orders: 4, executions: 5 } },
    operationalStatus: { state: 'incomplete', label: 'Incomplete', detail: 'The latest batch is missing required sections or rows.' },
  }],
};

it('renders Manager summaries, searchable fleet columns, and accessible status text', () => {
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} disableAutoLoad />);
  expect(html).toContain('Auto Collection');
  expect(html).toContain('Search clients or VPS');
  expect(html).toContain('Rome McMahon');
  expect(html).toContain('Accounts 2');
  expect(html).toContain('Incomplete');
  expect(html).toContain('aria-label="Collector status: Incomplete"');
});

it('renders immutable history and both safe download actions in the drawer', () => {
  const batch = { ...fleet.rows[0].todayBatch, tradingDate: '2026-07-23', receivedAt: '2026-07-23T21:00:00Z', errorCode: 'normalization_failed', replacesBatchId: 'prior' };
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} initialSelectedClient={fleet.rows[0].client} initialBatches={[batch]} disableAutoLoad />);
  expect(html).toContain('Immutable batch history');
  expect(html).toContain('normalization_failed');
  expect(html).toContain('Download JSON');
  expect(html).toContain('Download four-CSV ZIP');
});
