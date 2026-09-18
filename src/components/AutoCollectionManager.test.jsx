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
  expect(html).toContain('Reprocess batch');
});

it('requires a reason and exact client/date phrase before a closed-day replacement', () => {
  const batch = { ...fleet.rows[0].todayBatch, tradingDate: '2026-07-23', receivedAt: '2026-07-23T21:00:00Z', status: 'late_closed_day' };
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} initialSelectedClient={fleet.rows[0].client} initialBatches={[batch]} initialReplayBatch={batch} disableAutoLoad />);
  expect(html).toContain('Replace this closed day?');
  expect(html).toContain('REPLACE Rome McMahon 2026-07-23');
  expect(html).toContain('Operational reason');
  expect(html).toMatch(/type="submit"[^>]*disabled/);
  expect(html).toContain('original stored snapshot is never modified');
});

it('keeps failed closed-day attempts on the protected replacement path', () => {
  const batch = { ...fleet.rows[0].todayBatch, tradingDate: '2026-07-23', status: 'failed', reprocessMode: 'closed_day' };
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} initialSelectedClient={fleet.rows[0].client} initialBatches={[batch]} initialReplayBatch={batch} disableAutoLoad />);
  expect(html).toContain('Replace this closed day?');
  expect(html).toContain('REPLACE Rome McMahon 2026-07-23');
  expect(html).not.toContain('REPROCESS Rome McMahon 2026-07-23');
});

/* THE QUARANTINE THE DESK CAN CLEAR FROM ITS OWN SCREEN.
 *
 * Every 422 quarantine on a VPS is also a failed batch here, raw snapshot
 * included. The desk should see them in one place and replay them in one go
 * once the refusal has been fixed on this side. */
it('lists every failed close across the fleet with one replay for all of them', () => {
  const failed = [
    { id: 'b1', clientUuid: fleet.rows[0].client.uuid, tradingDate: '2026-09-14', receivedAt: '2026-09-14T20:30:09Z', rowCounts: { accounts: 8, strategies: 4, orders: 16, executions: 6 }, errorCode: 'normalization_failed', status: 'failed' },
    { id: 'b2', clientUuid: fleet.rows[0].client.uuid, tradingDate: '2026-09-17', receivedAt: '2026-09-17T20:30:09Z', rowCounts: { accounts: 8, strategies: 13, orders: 49, executions: 19 }, errorCode: 'normalization_failed', status: 'failed' },
  ];
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} initialFailedBatches={failed} disableAutoLoad />);
  expect(html).toContain('2 closes the CRM refused');
  expect(html).toContain('2026-09-14');
  expect(html).toContain('2026-09-17');
  expect(html).toContain('normalization_failed');
  expect(html).toContain('Reprocess all 2');
  expect(html).toContain(fleet.rows[0].client.name);
});

it('shows no failed closes panel when there is nothing to replay', () => {
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={fleet} initialFailedBatches={[]} disableAutoLoad />);
  expect(html).not.toContain('the CRM refused');
});

/* THE LINE THAT ANSWERS "IS THE INGEST SLOW?" WITHOUT A DASHBOARD. */
it('shows the day\'s ingest line with what was accepted, what was shed and how long it took', () => {
  const html = renderToStaticMarkup(<AutoCollectionManager
    initialFleet={{ ...fleet, tradingDate: '2026-07-23', ingestDay: { accepted: 9, shed: 4, measured: 9, medianMs: 820, slowestMs: 4310 } }}
    disableAutoLoad
  />);
  expect(html).toContain('Ingest on 2026-07-23');
  expect(html).toContain('9 accepted');
  expect(html).toContain('4 shed at the door');
  expect(html).toContain('median 820 ms');
  expect(html).toContain('slowest 4.3 s');
});

it('omits the ingest line entirely when nothing has been measured yet', () => {
  // Before migration step 45 runs there are no timings at all. Zeroes would
  // read as "every upload was instant", which is the opposite of what is known.
  const html = renderToStaticMarkup(<AutoCollectionManager initialFleet={{ ...fleet, ingestDay: null }} disableAutoLoad />);
  expect(html).not.toContain('shed at the door');
  expect(html).not.toContain('Ingest on');
});

it('says a measurement is missing rather than calling it zero', () => {
  const html = renderToStaticMarkup(<AutoCollectionManager
    initialFleet={{ ...fleet, tradingDate: '2026-07-23', ingestDay: { accepted: 0, shed: 2, measured: 0, medianMs: null, slowestMs: null } }}
    disableAutoLoad
  />);
  expect(html).toContain('2 shed at the door');
  expect(html).toContain('median not measured');
});
