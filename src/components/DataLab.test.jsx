// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataLab from './DataLab';
import { requestedRangeWords } from '../domain/tradingExport';
import { saveFromUrl } from '../lib/saveFromUrl';

/* ------------------------------------------------------------------------- *
 * DATA LAB, THE MANAGER'S SLIM TRADING EXPORTS (step 72).
 *
 * The devices with their agent and last ready export, the request (all
 * eligible or a subset, a date pair, the datasets), and every export across
 * clients with Download, Delete, Cancel, a status filter and Download all
 * ready. Asked of the RENDERED page, with the clicks a Manager makes and the
 * API calls those clicks produce.
 * ------------------------------------------------------------------------- */

afterEach(cleanup);

const DASHES = /[‒–—―]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const ALL = ['executions', 'orders', 'strategies', 'trades'];
const dev = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const exp = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const DEVICES = [
  { id: dev(1), clientId: 'c1', clientName: 'Gray Elm', agentVersion: '1.4.0', lastSeenAt: null, eligible: true, lastReadyExportAt: '2026-10-01T10:00:00.000Z', lastReadyCoveredTo: '2026-09-30', openStatus: null },
  { id: dev(2), clientId: 'c2', clientName: 'Blue Oak', agentVersion: '1.10.2', lastSeenAt: null, eligible: true, lastReadyExportAt: null, lastReadyCoveredTo: null, openStatus: 'building' },
  { id: dev(3), clientId: 'c3', clientName: 'Red Pine', agentVersion: '1.3.1', lastSeenAt: null, eligible: false, lastReadyExportAt: null, lastReadyCoveredTo: null, openStatus: null },
];

function exportRow(n, overrides = {}) {
  return {
    id: exp(n), deviceId: dev(1), clientId: 'c1', clientName: 'Gray Elm', requestedAt: '2026-10-19T14:00:00.000Z',
    fromDate: null, toDate: null, datasets: ALL, status: 'ready', errorCode: null, byteSize: 831488,
    rowCounts: { executions: 2140, orders: 900, strategies: 12, trades: 610 }, coveredFrom: '2026-07-01', coveredTo: '2026-10-19',
    startedAt: null, completedAt: '2026-10-19T14:05:00.000Z', expiresAt: '2026-11-02T14:05:00.000Z', updatedAt: null,
    ...overrides,
  };
}

const EXPORTS = [
  exportRow(1),
  exportRow(2, { clientName: 'Blue Oak', status: 'building', byteSize: null, rowCounts: null, coveredFrom: null, coveredTo: null, fromDate: '2026-07-01', datasets: ['orders', 'trades'] }),
  exportRow(3, { clientName: 'Red Pine', status: 'failed', errorCode: 'disk_full', byteSize: null, rowCounts: null, coveredFrom: null, coveredTo: null }),
  exportRow(4, { status: 'expired' }),
];

function renderLab({ api = {}, devices = DEVICES, exports = EXPORTS, total = exports.length, confirm = vi.fn(() => true), ...props } = {}) {
  const fullApi = {
    loadTradingExportDevices: vi.fn(async () => ({ ok: true, minimumAgentVersion: '1.4.0', devices })),
    listTradingExports: vi.fn(async () => ({ ok: true, exports, total, limit: 50, offset: 0 })),
    requestTradingExports: vi.fn(async ({ deviceIds }) => ({ ok: true, requested: deviceIds.length, skipped: 0, needsVps: 0 })),
    cancelTradingExports: vi.fn(async (ids) => ({ ok: true, cancelled: ids.length })),
    downloadTradingExport: vi.fn(async (id) => ({ url: `https://storage.example.test/sign/${id}?token=t`, fileName: `file-${id}.jsonl.gz`, expiresAt: null })),
    deleteTradingExport: vi.fn(async () => ({ ok: true, deleted: true })),
    ...api,
  };
  const saveFile = props.saveFile || vi.fn();
  const pause = props.pause || vi.fn(async () => {});
  const view = render(
    <DataLab
      api={fullApi}
      initialDevices={devices}
      initialExports={{ exports, total }}
      disableAutoLoad={props.disableAutoLoad ?? true}
      confirm={confirm}
      saveFile={saveFile}
      pause={pause}
    />,
  );
  return { ...view, api: fullApi, saveFile, pause, confirm };
}

const devicesTable = () => screen.getByRole('table', { name: 'Paired devices' });
const exportsTable = () => screen.getByRole('table', { name: 'Trading exports' });
const rowOf = (table, text) => within(table).getByText(text).closest('tr');
const requestButton = () => screen.getByRole('button', { name: /^Request exports/ });

describe('the devices', () => {
  it('lists each paired device with its client, agent, last ready export and what is in progress', () => {
    renderLab();
    const gray = rowOf(devicesTable(), 'Gray Elm');
    expect(within(gray).getByText('1.4.0')).toBeTruthy();
    expect(within(gray).getByText('Oct 1, 2026')).toBeTruthy();
    expect(within(gray).getByText('Covers through Sep 30, 2026')).toBeTruthy();
    const blue = rowOf(devicesTable(), 'Blue Oak');
    expect(within(blue).getByText('None yet')).toBeTruthy();
    expect(within(blue).getByText('Building on the VPS')).toBeTruthy();
    expect(screen.getByText(/3 paired devices, 2 can send an export \(agent 1\.4\.0 or later\)/)).toBeTruthy();
  });

  it('an agent older than 1.4.0 says to update it first and cannot be selected', () => {
    renderLab();
    const red = rowOf(devicesTable(), 'Red Pine');
    expect(within(red).getByText('This agent is older than 1.4.0 and cannot send trading exports. Update it first.')).toBeTruthy();
    expect(within(red).getByRole('checkbox').disabled).toBe(true);
    expect(within(rowOf(devicesTable(), 'Gray Elm')).getByRole('checkbox').disabled).toBe(false);
  });
});

describe('requesting exports', () => {
  it('select all eligible picks only agents at 1.4.0 or later, and the request goes with every dataset and no dates', async () => {
    const { api } = renderLab();
    expect(requestButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select all eligible (2)' }));
    expect(requestButton().textContent).toContain('Request exports (2)');
    await act(async () => { fireEvent.click(requestButton()); });
    expect(api.requestTradingExports).toHaveBeenCalledWith({ deviceIds: [dev(1), dev(2)], from: null, to: null, datasets: ALL });
    await waitFor(() => expect(screen.getByText('Requested 2 exports.')).toBeTruthy());
    // The page reads both lists again, and the selection is cleared.
    expect(api.loadTradingExportDevices).toHaveBeenCalledTimes(1);
    expect(api.listTradingExports).toHaveBeenCalledWith({ limit: 50, offset: 0, status: null });
    expect(requestButton().disabled).toBe(true);
  });

  it('a subset, a date pair and fewer datasets go exactly as chosen', async () => {
    const { api } = renderLab();
    fireEvent.click(within(rowOf(devicesTable(), 'Blue Oak')).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-19' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Strategies' }));
    await act(async () => { fireEvent.click(requestButton()); });
    expect(api.requestTradingExports).toHaveBeenCalledWith({ deviceIds: [dev(2)], from: '2026-07-01', to: '2026-10-19', datasets: ['executions', 'orders', 'trades'] });
  });

  it('says what was skipped and why', async () => {
    renderLab({ api: { requestTradingExports: vi.fn(async () => ({ ok: true, requested: 1, skipped: 1, needsVps: 0 })) } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all eligible (2)' }));
    await act(async () => { fireEvent.click(requestButton()); });
    expect(screen.getByText('Requested 1 export. 1 skipped. 1 already has an export in progress or is no longer active.')).toBeTruthy();
  });

  it('will not send dates that run backwards, or no dataset at all', () => {
    renderLab();
    fireEvent.click(screen.getByRole('button', { name: 'Select all eligible (2)' }));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-19' } });
    expect(screen.getByText('The from date is after the to date.')).toBeTruthy();
    expect(requestButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '' } });
    expect(requestButton().disabled).toBe(false);
    for (const name of ['Executions', 'Orders', 'Strategies', 'Trades']) fireEvent.click(screen.getByRole('checkbox', { name }));
    expect(screen.getByText('Choose at least one dataset.')).toBeTruthy();
    expect(requestButton().disabled).toBe(true);
  });

  it('keeps a refused request on the page', async () => {
    const refused = Object.assign(new Error('You do not have access to this client setup.'), { code: 'permission_denied', status: 403 });
    renderLab({ api: { requestTradingExports: vi.fn(async () => { throw refused; }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all eligible (2)' }));
    await act(async () => { fireEvent.click(requestButton()); });
    expect(screen.getByText(refused.message).getAttribute('role')).toBe('alert');
    expect(screen.getByRole('heading', { name: 'Data lab' })).toBeTruthy();
  });
});

describe('the exports', () => {
  it('says where each one stands in plain English', () => {
    renderLab();
    const table = exportsTable();
    expect(within(table).getByText('Ready, 812 KB, Jul 1 to Oct 19, 2,140 fills')).toBeTruthy();
    expect(within(table).getByText('Building on the VPS')).toBeTruthy();
    expect(within(table).getByText('Failed: disk_full')).toBeTruthy();
    expect(within(table).getByText('Expired')).toBeTruthy();
    expect(within(rowOf(table, 'Blue Oak')).getByText('From Jul 1 to today')).toBeTruthy();
    expect(within(rowOf(table, 'Blue Oak')).getByText('Orders, Trades')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Exports (4)' })).toBeTruthy();
  });

  it('offers Download and Delete only on a ready export, and Cancel only on one in progress', () => {
    renderLab();
    const table = exportsTable();
    const actions = (text) => within(rowOf(table, text)).queryAllByRole('button').map((button) => button.textContent.trim());
    expect(actions('Ready, 812 KB, Jul 1 to Oct 19, 2,140 fills')).toEqual(['Download', 'Delete']);
    expect(actions('Building on the VPS')).toEqual(['Cancel']);
    expect(actions('Failed: disk_full')).toEqual([]);
    expect(actions('Expired')).toEqual([]);
  });

  it('Download asks for a signed URL and hands it to the browser with the file name', async () => {
    const { api, saveFile } = renderLab();
    await act(async () => { fireEvent.click(within(exportsTable()).getByRole('button', { name: 'Download' })); });
    expect(api.downloadTradingExport).toHaveBeenCalledWith(exp(1));
    expect(saveFile).toHaveBeenCalledWith(`https://storage.example.test/sign/${exp(1)}?token=t`, `file-${exp(1)}.jsonl.gz`);
  });

  it('an export that expired meanwhile says so beside it, and the list is read again', async () => {
    const expired = Object.assign(new Error('This export has expired and its file is gone. Request a new one.'), { code: 'export_expired', status: 410 });
    const { api, saveFile } = renderLab({ api: { downloadTradingExport: vi.fn(async () => { throw expired; }) } });
    await act(async () => { fireEvent.click(within(exportsTable()).getByRole('button', { name: 'Download' })); });
    expect(screen.getByText(expired.message)).toBeTruthy();
    expect(saveFile).not.toHaveBeenCalled();
    expect(api.listTradingExports).toHaveBeenCalledTimes(1);
  });

  it('Delete asks first, names the client, and does nothing on no', async () => {
    const confirm = vi.fn(() => false);
    const { api } = renderLab({ confirm });
    await act(async () => { fireEvent.click(within(exportsTable()).getByRole('button', { name: 'Delete' })); });
    expect(confirm).toHaveBeenCalledWith('Delete the export for Gray Elm? Its file is removed from storage and cannot be downloaded again.');
    expect(api.deleteTradingExport).not.toHaveBeenCalled();
  });

  it('Delete on yes removes it and reads the list again', async () => {
    const { api } = renderLab();
    await act(async () => { fireEvent.click(within(exportsTable()).getByRole('button', { name: 'Delete' })); });
    expect(api.deleteTradingExport).toHaveBeenCalledWith(exp(1));
    expect(api.listTradingExports).toHaveBeenCalledTimes(1);
  });

  it('Cancel takes back the one in progress', async () => {
    const { api } = renderLab();
    await act(async () => { fireEvent.click(within(exportsTable()).getByRole('button', { name: 'Cancel' })); });
    expect(api.cancelTradingExports).toHaveBeenCalledWith([exp(2)]);
  });

  it('the status filter reads the list again from the first page', async () => {
    const { api } = renderLab();
    await act(async () => { fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'ready' } }); });
    expect(api.listTradingExports).toHaveBeenCalledWith({ limit: 50, offset: 0, status: 'ready' });
  });

  it('Show more reads the next page and adds it below', async () => {
    const more = [exportRow(9, { clientName: 'Green Ash' })];
    const { api } = renderLab({ total: 5, api: { listTradingExports: vi.fn(async () => ({ ok: true, exports: more, total: 5 })) } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show more' })); });
    expect(api.listTradingExports).toHaveBeenCalledWith({ limit: 50, offset: 4, status: null });
    expect(within(exportsTable()).getByText('Green Ash')).toBeTruthy();
    // The four already shown stay, and the fifth is added below them.
    expect(within(exportsTable()).getAllByRole('row').slice(1).map((row) => row.dataset.export)).toEqual([exp(1), exp(2), exp(3), exp(4), exp(9)]);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('Download all ready', () => {
  it('lists every ready export, then fetches one signed URL at a time and saves each file, pausing between them', async () => {
    const ready = [exportRow(1), exportRow(5, { clientName: 'Blue Oak' })];
    const order = [];
    const { api, saveFile, pause } = renderLab({
      api: {
        listTradingExports: vi.fn(async () => ({ ok: true, exports: ready, total: 2 })),
        downloadTradingExport: vi.fn(async (id) => { order.push(`url ${id}`); return { url: `https://s/${id}`, fileName: `${id}.jsonl.gz` }; }),
      },
      saveFile: vi.fn((url) => { order.push(`save ${url}`); }),
      pause: vi.fn(async () => { order.push('pause'); }),
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download all ready/ })); });
    expect(api.listTradingExports).toHaveBeenCalledWith({ limit: 200, offset: 0, status: 'ready' });
    expect(order).toEqual([`url ${exp(1)}`, `save https://s/${exp(1)}`, 'pause', `url ${exp(5)}`, `save https://s/${exp(5)}`]);
    expect(saveFile).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Downloaded 2 of 2.')).toBeTruthy();
  });

  it('keeps going past one that fails, and names it', async () => {
    const ready = [exportRow(1), exportRow(5, { clientName: 'Blue Oak' })];
    renderLab({
      api: {
        listTradingExports: vi.fn(async () => ({ ok: true, exports: ready, total: 2 })),
        downloadTradingExport: vi.fn(async (id) => {
          if (id === exp(5)) throw new Error('This export has expired and its file is gone. Request a new one.');
          return { url: `https://s/${id}`, fileName: 'x.jsonl.gz' };
        }),
      },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download all ready/ })); });
    expect(screen.getByText('Downloaded 1 of 2. 1 failed: Blue Oak.')).toBeTruthy();
  });

  it('pages through more than 200 ready exports, and says when there are none', async () => {
    const page = Array.from({ length: 200 }, (_, n) => exportRow(100 + n));
    const listTradingExports = vi.fn(async ({ offset }) => ({ ok: true, exports: offset === 0 ? page : [exportRow(999)], total: 201 }));
    const { saveFile } = renderLab({ api: { listTradingExports } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download all ready/ })); });
    expect(listTradingExports.mock.calls.map(([args]) => args.offset)).toEqual([0, 200]);
    expect(saveFile).toHaveBeenCalledTimes(201);
    cleanup();
    renderLab({ api: { listTradingExports: vi.fn(async () => ({ ok: true, exports: [], total: 0 })) } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download all ready/ })); });
    expect(screen.getByText('No ready exports to download.')).toBeTruthy();
  });
});

describe('the page as a whole', () => {
  it('reads the devices and the exports when it opens', async () => {
    const { api } = renderLab({ disableAutoLoad: false });
    await waitFor(() => expect(api.loadTradingExportDevices).toHaveBeenCalledTimes(1));
    expect(api.listTradingExports).toHaveBeenCalledWith({ limit: 50, offset: 0, status: null });
  });

  it('before step 72 it says what is missing, and nothing else', async () => {
    const unavailable = Object.assign(new Error('Trading exports need step 72 in the database. Run it, then reload this page.'), { code: 'trading_export_unavailable', status: 404 });
    renderLab({
      disableAutoLoad: false,
      devices: null,
      exports: [],
      api: {
        loadTradingExportDevices: vi.fn(async () => { throw unavailable; }),
        listTradingExports: vi.fn(async () => { throw unavailable; }),
      },
    });
    await waitFor(() => expect(screen.getByText('Trading exports need step 72 in the database. Run it, then reload this page.')).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('carries no dash and no emoji anywhere on the page', () => {
    const { container } = renderLab();
    expect(container.textContent).not.toMatch(DASHES);
    expect(container.textContent).not.toMatch(EMOJI);
  });

  it('the days asked for read in words', () => {
    expect(requestedRangeWords({ fromDate: null, toDate: null })).toBe('Since the last export');
    expect(requestedRangeWords({ fromDate: '2026-07-01', toDate: '2026-10-19' })).toBe('Jul 1 to Oct 19');
    expect(requestedRangeWords({ fromDate: '2026-07-01', toDate: null })).toBe('From Jul 1 to today');
    expect(requestedRangeWords({ fromDate: null, toDate: '2026-10-19' })).toBe('Since the last export, through Oct 19');
  });
});

describe('saveFromUrl', () => {
  it('clicks a hidden link to the URL with the file name, and leaves nothing behind', () => {
    const clicked = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
    try {
      saveFromUrl('https://storage.example.test/sign/x?token=t&download=Gray-Elm_start_latest.jsonl.gz', 'Gray-Elm_start_latest.jsonl.gz');
    } finally {
      click.mockRestore();
    }
    expect(clicked).toEqual([{ href: 'https://storage.example.test/sign/x?token=t&download=Gray-Elm_start_latest.jsonl.gz', download: 'Gray-Elm_start_latest.jsonl.gz', attached: true }]);
    expect(document.querySelectorAll('a').length).toBe(0);
  });
});
