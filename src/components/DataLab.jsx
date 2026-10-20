import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FlaskConical, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import {
  FIRST_SLIM_EXPORT_AGENT,
  TRADING_EXPORT_DATASETS,
  TRADING_EXPORT_DATASET_LABELS,
  TRADING_EXPORT_STATUSES,
  TRADING_EXPORT_STATUS_LABELS,
  TRADING_EXPORT_TOO_OLD_COPY,
  describeTradingExport,
  formatExportDate,
  isOpenTradingExport,
  requestedRangeWords,
  tradingExportRequestWords,
} from '../domain/tradingExport';
import { saveFromUrl } from '../lib/saveFromUrl';

/* DATA LAB: SLIM TRADING EXPORTS FROM THE CLIENTS' VPS (step 72), Manager only.
 *
 * A developer tool for the desk owner, not a CAM screen. The top half lists
 * every paired, active device with its client, its agent and the date of its
 * last ready export, and asks the eligible ones (agent 1.4.0 and later) for an
 * export of a date range and a set of datasets. The bottom half lists every
 * export across clients, newest first, with Download and Delete for a ready
 * one, Cancel for one the agent is still working on, and Download all ready,
 * which fetches the signed URLs one at a time and lets the browser save each
 * file as <client>_<from>_<to>.jsonl.gz.
 *
 * Every call goes through /api/admin/ingest-trading-export as the signed in
 * Manager; the files themselves come straight from storage through signed
 * URLs that live five minutes. */

const PAGE_SIZE = 50;
const READY_PAGE = 200;
// Browsers drop or block downloads fired back to back; a short gap keeps each one.
const BULK_PAUSE_MS = 800;

function datasetsWords(list) {
  if (!Array.isArray(list) || list.length === TRADING_EXPORT_DATASETS.length) return 'All';
  return list.map((name) => TRADING_EXPORT_DATASET_LABELS[name] || name).join(', ');
}

function bulkWords(bulk) {
  if (!bulk) return '';
  if (bulk.error) return bulk.error;
  if (bulk.running) return bulk.total ? `Downloading ${bulk.done + 1} of ${bulk.total}.` : 'Finding the ready exports.';
  if (!bulk.total) return 'No ready exports to download.';
  const saved = bulk.total - bulk.failed.length;
  const head = `Downloaded ${saved} of ${bulk.total}.`;
  return bulk.failed.length ? `${head} ${bulk.failed.length} failed: ${bulk.failed.join(', ')}.` : head;
}

export default function DataLab({
  api = autoCollectionApi,
  initialDevices = null,
  initialExports = null,
  disableAutoLoad = false,
  confirm = (message) => window.confirm(message),
  saveFile = saveFromUrl,
  pause = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); }),
}) {
  const [devices, setDevices] = useState(initialDevices);
  const [devicesError, setDevicesError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [datasets, setDatasets] = useState(() => new Set(TRADING_EXPORT_DATASETS));
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestNote, setRequestNote] = useState(null);
  const [exportsList, setExportsList] = useState(() => ({
    rows: initialExports?.exports || [],
    total: Number(initialExports?.total) || 0,
  }));
  const [exportsError, setExportsError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);
  const [rowNote, setRowNote] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      const result = await api.loadTradingExportDevices();
      setDevices(Array.isArray(result?.devices) ? result.devices : []);
      setDevicesError(null);
    } catch (error) {
      if (error?.code === 'trading_export_unavailable') setUnavailable(true);
      else setDevicesError(error);
    }
  }, [api]);

  const loadExports = useCallback(async (status, { offset = 0, append = false } = {}) => {
    setLoading(true);
    try {
      const result = await api.listTradingExports({ limit: PAGE_SIZE, offset, status: status || null });
      const rows = Array.isArray(result?.exports) ? result.exports : [];
      setExportsList((current) => ({ rows: append ? [...current.rows, ...rows] : rows, total: Number(result?.total) || 0 }));
      setExportsError(null);
    } catch (error) {
      if (error?.code === 'trading_export_unavailable') setUnavailable(true);
      else setExportsError(error);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (disableAutoLoad) return undefined;
    const timer = window.setTimeout(() => {
      loadDevices();
      loadExports('');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [disableAutoLoad, loadDevices, loadExports]);

  const eligible = useMemo(() => (devices || []).filter((device) => device.eligible), [devices]);
  const datesBackwards = Boolean(from && to && from > to);
  const canRequest = selected.size > 0 && datasets.size > 0 && !datesBackwards && !requestBusy;

  function toggleDevice(deviceId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }

  function toggleDataset(name) {
    setDatasets((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function refresh() {
    await Promise.all([loadDevices(), loadExports(statusFilter)]);
  }

  async function requestExports() {
    if (!canRequest) return;
    setRequestBusy(true);
    setRequestNote(null);
    try {
      const result = await api.requestTradingExports({
        deviceIds: [...selected],
        from: from || null,
        to: to || null,
        datasets: TRADING_EXPORT_DATASETS.filter((name) => datasets.has(name)),
      });
      setRequestNote({ tone: 'status', text: tradingExportRequestWords(result) });
      setSelected(new Set());
      await refresh();
    } catch (error) {
      setRequestNote({ tone: 'alert', text: error?.message || 'The request did not go through. Try again.' });
    } finally {
      setRequestBusy(false);
    }
  }

  async function runRowAction(row, action) {
    setRowBusy(row.id);
    setRowNote(null);
    try {
      await action();
    } catch (error) {
      setRowNote({ id: row.id, text: error?.message || 'That did not work. Try again.' });
      if (error?.code === 'export_expired' || error?.code === 'export_not_found') await loadExports(statusFilter);
    } finally {
      setRowBusy(null);
    }
  }

  function downloadOne(row) {
    return runRowAction(row, async () => {
      const { url, fileName } = await api.downloadTradingExport(row.id);
      saveFile(url, fileName);
    });
  }

  function deleteOne(row) {
    if (!confirm(`Delete the export for ${row.clientName || 'this client'}? Its file is removed from storage and cannot be downloaded again.`)) return undefined;
    return runRowAction(row, async () => {
      await api.deleteTradingExport(row.id);
      await loadExports(statusFilter);
    });
  }

  function cancelOne(row) {
    return runRowAction(row, async () => {
      await api.cancelTradingExports([row.id]);
      await refresh();
    });
  }

  async function downloadAllReady() {
    if (bulk?.running) return;
    setBulk({ running: true, done: 0, total: 0, failed: [] });
    const ready = new Map();
    try {
      for (let offset = 0; ; offset += READY_PAGE) {
        const page = await api.listTradingExports({ limit: READY_PAGE, offset, status: 'ready' });
        const rows = Array.isArray(page?.exports) ? page.exports : [];
        for (const row of rows) if (row.status === 'ready') ready.set(row.id, row);
        if (rows.length < READY_PAGE) break;
      }
    } catch (error) {
      setBulk({ running: false, done: 0, total: 0, failed: [], error: error?.message || 'The ready exports could not be listed. Try again.' });
      return;
    }
    const rows = [...ready.values()];
    const failed = [];
    for (let index = 0; index < rows.length; index += 1) {
      setBulk({ running: true, done: index, total: rows.length, failed: [...failed] });
      try {
        const { url, fileName } = await api.downloadTradingExport(rows[index].id);
        saveFile(url, fileName);
      } catch {
        failed.push(rows[index].clientName || rows[index].id);
      }
      if (index < rows.length - 1) await pause(BULK_PAUSE_MS);
    }
    setBulk({ running: false, done: rows.length, total: rows.length, failed });
  }

  const header = (
    <div className="page-header manager-subpage-header">
      <div>
        <span className="eyebrow">Manager tools</span>
        <h1>Data lab</h1>
        <div className="occ-status-row">
          <FlaskConical size={14} />
          <span>Slim trading exports from each client&apos;s VPS: orders, fills, strategy configurations and per trade geometry.</span>
        </div>
      </div>
      <button className="ghost-button" type="button" disabled={loading} onClick={refresh}>
        <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
      </button>
    </div>
  );

  if (unavailable) {
    return (
      <div className="page-stack data-lab">
        {header}
        <section className="panel" role="status">
          <p>Trading exports need step 72 in the database. Run it, then reload this page.</p>
        </section>
      </div>
    );
  }

  const rows = exportsList.rows;

  return (
    <div className="page-stack data-lab">
      {header}

      <section className="panel data-lab-request" aria-label="Request exports">
        <div className="collector-toolbar">
          <div>
            <span className="eyebrow">Paired devices</span>
            <h2>Request exports</h2>
            <p className="muted">
              {devices ? `${devices.length} paired ${devices.length === 1 ? 'device' : 'devices'}, ${eligible.length} can send an export (agent ${FIRST_SLIM_EXPORT_AGENT} or later). ` : ''}
              Leave both dates empty to export each device since its last export.
            </p>
          </div>
        </div>

        <div className="data-lab-controls">
          <label>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="From date" />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="To date" />
          </label>
          <fieldset className="data-lab-datasets">
            <legend>Datasets</legend>
            {TRADING_EXPORT_DATASETS.map((name) => (
              <label key={name}>
                <input type="checkbox" checked={datasets.has(name)} onChange={() => toggleDataset(name)} />
                {TRADING_EXPORT_DATASET_LABELS[name]}
              </label>
            ))}
          </fieldset>
          <div className="data-lab-actions">
            <button type="button" className="ghost-button" disabled={!eligible.length} onClick={() => setSelected(new Set(eligible.map((device) => device.id)))}>
              {`Select all eligible (${eligible.length})`}
            </button>
            <button type="button" className="ghost-button" disabled={!selected.size} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <button type="button" className="primary-button" disabled={!canRequest} onClick={requestExports} data-action="request-exports">
              {requestBusy ? <LoaderCircle className="spin" size={14} /> : null}
              {selected.size ? `Request exports (${selected.size})` : 'Request exports'}
            </button>
          </div>
        </div>
        {datesBackwards ? <p className="data-lab-note" role="alert">The from date is after the to date.</p> : null}
        {!datasets.size ? <p className="data-lab-note" role="alert">Choose at least one dataset.</p> : null}
        {requestNote ? <p className="data-lab-note" role={requestNote.tone}>{requestNote.text}</p> : null}
        {devicesError ? <p className="data-lab-note" role="alert">{devicesError.message}</p> : null}

        <div className="table-wrap">
          <table className="ops-table" aria-label="Paired devices">
            <thead>
              <tr><th><span className="sr-only">Select</span></th><th>Client</th><th>Agent</th><th>Last ready export</th><th>In progress</th></tr>
            </thead>
            <tbody>
              {(devices || []).map((device) => (
                <tr key={device.id} data-device={device.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${device.clientName || device.id}`}
                      checked={selected.has(device.id)}
                      disabled={!device.eligible}
                      onChange={() => toggleDevice(device.id)}
                    />
                  </td>
                  <td><strong>{device.clientName || 'Unnamed client'}</strong></td>
                  <td>
                    {device.agentVersion || 'Unknown'}
                    {device.eligible ? null : <small className="data-lab-hint">{TRADING_EXPORT_TOO_OLD_COPY}</small>}
                  </td>
                  <td>
                    {formatExportDate(device.lastReadyExportAt) || 'None yet'}
                    {device.lastReadyCoveredTo ? <small className="data-lab-hint">{`Covers through ${formatExportDate(device.lastReadyCoveredTo)}`}</small> : null}
                  </td>
                  <td>{device.openStatus ? TRADING_EXPORT_STATUS_LABELS[device.openStatus] : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices && !devices.length ? <p className="muted">No paired devices.</p> : null}
        </div>
      </section>

      <section className="panel data-lab-exports" aria-label="Exports">
        <div className="collector-toolbar">
          <div>
            <span className="eyebrow">Every client, newest first</span>
            <h2>{`Exports (${exportsList.total})`}</h2>
            <p className="muted">A ready export can be downloaded for 14 days. Download all ready saves each file as client_from_to.jsonl.gz; your browser may ask once to allow several downloads.</p>
          </div>
          <div className="data-lab-actions">
            <label>
              <span className="sr-only">Status</span>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value);
                  loadExports(event.target.value);
                }}
              >
                <option value="">All statuses</option>
                {TRADING_EXPORT_STATUSES.map((status) => <option key={status} value={status}>{TRADING_EXPORT_STATUS_LABELS[status]}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button" disabled={Boolean(bulk?.running)} onClick={downloadAllReady} data-action="download-all-ready">
              {bulk?.running ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} Download all ready
            </button>
          </div>
        </div>
        {bulk ? <p className="data-lab-note" role="status">{bulkWords(bulk)}</p> : null}
        {exportsError ? <p className="data-lab-note" role="alert">{exportsError.message}</p> : null}

        <div className="table-wrap">
          <table className="ops-table" aria-label="Trading exports">
            <thead>
              <tr><th>Client</th><th>Requested</th><th>Days asked for</th><th>Datasets</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-export={row.id}>
                  <td><strong>{row.clientName || 'Unnamed client'}</strong></td>
                  <td>{formatExportDate(row.requestedAt)}</td>
                  <td>{requestedRangeWords(row)}</td>
                  <td>{datasetsWords(row.datasets)}</td>
                  <td>
                    <span className={`data-lab-status state-${row.status}`}>{describeTradingExport(row)}</span>
                    {rowNote?.id === row.id ? <small className="data-lab-hint" role="alert">{rowNote.text}</small> : null}
                  </td>
                  <td>
                    <div className="data-lab-actions">
                      {row.status === 'ready' ? (
                        <>
                          <button type="button" className="ghost-button" disabled={rowBusy === row.id} onClick={() => downloadOne(row)} data-action="download-export">
                            <Download size={13} /> Download
                          </button>
                          <button type="button" className="ghost-button danger-text" disabled={rowBusy === row.id} onClick={() => deleteOne(row)} data-action="delete-export">
                            <Trash2 size={13} /> Delete
                          </button>
                        </>
                      ) : null}
                      {isOpenTradingExport(row.status) ? (
                        <button type="button" className="ghost-button" disabled={rowBusy === row.id} onClick={() => cancelOne(row)} data-action="cancel-export">
                          <X size={13} /> Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <p className="muted">{statusFilter ? 'No exports with this status.' : 'No exports yet.'}</p> : null}
        </div>
        {rows.length < exportsList.total ? (
          <button type="button" className="ghost-button" disabled={loading} onClick={() => loadExports(statusFilter, { offset: rows.length, append: true })}>
            Show more
          </button>
        ) : null}
      </section>
    </div>
  );
}
