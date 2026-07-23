import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, RefreshCw, Search, Server, X } from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';

function fmt(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not yet' : date.toLocaleString('en-US');
}

function schedule(value) {
  return String(value?.time || '16:45').slice(0, 5) === '16:45' ? '4:45 PM ET' : `${String(value?.time || '').slice(0, 5)} · ${value?.timezone || ''}`;
}

function counts(rowCounts = {}) {
  return `Accounts ${rowCounts.accounts || 0} · Strategies ${rowCounts.strategies || 0} · Orders ${rowCounts.orders || 0} · Executions ${rowCounts.executions || 0}`;
}

export default function AutoCollectionManager({ api = autoCollectionApi, visible = true, initialFleet = null, initialSelectedClient = null, initialBatches = null, disableAutoLoad = false }) {
  const [fleet, setFleet] = useState(initialFleet);
  const [page, setPage] = useState(initialFleet?.page || 1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selectedClient, setSelectedClient] = useState(initialSelectedClient);
  const [batches, setBatches] = useState(initialBatches || []);
  const [loading, setLoading] = useState(!initialFleet && !disableAutoLoad);
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  async function loadFleet(nextPage = page, nextSearch = query) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true); setError('');
    try { setFleet(await api.loadFleet({ page: nextPage, pageSize: 25, search: nextSearch, signal: controller.signal })); }
    catch (caught) { if (caught?.name !== 'AbortError') setError(caught.message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  useEffect(() => {
    if (!visible || disableAutoLoad) return undefined;
    const start = window.setTimeout(() => loadFleet(), 0);
    const poll = window.setInterval(() => loadFleet(), 60_000);
    return () => { window.clearTimeout(start); window.clearInterval(poll); abortRef.current?.abort(); };
  }, [visible, disableAutoLoad, page, query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || disableAutoLoad || !selectedClient?.uuid) return undefined;
    const controller = new AbortController();
    api.loadBatchHistory({ clientUuid: selectedClient.uuid, pageSize: 50, signal: controller.signal })
      .then((result) => setBatches(result.batches || []))
      .catch((caught) => { if (caught?.name !== 'AbortError') setError(caught.message); });
    return () => controller.abort();
  }, [api, disableAutoLoad, selectedClient?.uuid, visible]);

  function openHistory(client) {
    setBatches([]);
    setError('');
    setSelectedClient(client);
  }

  async function download(batch, format) {
    try {
      const result = await api.downloadBatch(batch.id, format);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ninjatrader-${batch.tradingDate}.${format === 'zip' ? 'zip' : 'json'}`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) { setError(caught.message); }
  }

  const totalPages = Math.max(1, Math.ceil((fleet?.total || 0) / 25));
  return <div className="page-stack auto-collection-manager">
    <div className="page-header manager-subpage-header"><div><span className="eyebrow">Manager Operations</span><h1>Auto Collection</h1><div className="occ-status-row"><Server size={14} /><span>Expected versus received NinjaTrader snapshots across every VPS.</span></div></div><button className="ghost-button" type="button" disabled={loading} onClick={() => loadFleet()}><RefreshCw size={14} /> Refresh</button></div>
    {error ? <div className="notice error" role="alert"><AlertTriangle size={15} /> {error}</div> : null}
    <section className="collector-summary" aria-label="Fleet summary"><div><strong>{fleet?.summary?.total || 0}</strong><span>Clients</span></div><div><strong>{fleet?.summary?.received || 0}</strong><span>Received</span></div><div><strong>{fleet?.summary?.expected || 0}</strong><span>Expected</span></div><div className="attention"><strong>{fleet?.summary?.attention || 0}</strong><span>Need attention</span></div></section>
    <section className="panel"><div className="collector-toolbar"><form onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}><Search size={15} /><input aria-label="Search clients or VPS" placeholder="Search clients or VPS" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="secondary-button" type="submit">Search</button></form><span>{fleet?.total || 0} clients</span></div>
      <div className="table-wrap"><table className="ops-table"><thead><tr><th>Client / VPS</th><th>Schedule</th><th>Last seen</th><th>Today&apos;s batch</th><th>Rows</th><th>Version</th><th>Status</th></tr></thead><tbody>{(fleet?.rows || []).map((row) => <tr key={row.client.uuid}><td><button type="button" className="collector-client-button" onClick={() => openHistory(row.client)}><strong>{row.client.name}</strong><small>{row.device?.id || 'Not paired'}</small></button></td><td>{schedule(row.device?.schedule)}</td><td>{fmt(row.device?.lastSeenAt)}</td><td>{row.todayBatch?.status || '—'}</td><td><small>{counts(row.todayBatch?.rowCounts)}</small></td><td>{row.device?.agentVersion || '—'}</td><td><span className={`collector-status state-${row.operationalStatus.state}`} aria-label={`Collector status: ${row.operationalStatus.label}`}>{row.operationalStatus.label}</span></td></tr>)}</tbody></table></div>
      <div className="collector-pagination"><button className="ghost-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {totalPages}</span><button className="ghost-button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
    </section>
    {selectedClient ? <aside className="collector-drawer" aria-label={`Batch history for ${selectedClient.name}`}><header><div><span className="eyebrow">Client detail</span><h2>{selectedClient.name}</h2></div><button className="ghost-button icon-only" aria-label="Close batch history" onClick={() => setSelectedClient(null)}><X size={16} /></button></header><h3>Immutable batch history</h3>{batches.map((batch) => <article key={batch.id} className="collector-batch"><div><strong>{batch.tradingDate} · {batch.status}</strong><span>{fmt(batch.receivedAt)}</span></div><small>{counts(batch.rowCounts)}</small>{batch.errorCode ? <span className="negative">{batch.errorCode}</span> : null}{batch.replacesBatchId ? <small>Replaces {batch.replacesBatchId}</small> : null}<div><button className="ghost-button" onClick={() => download(batch, 'json')}><Download size={13} /> Download JSON</button><button className="ghost-button" onClick={() => download(batch, 'zip')}><Download size={13} /> Download four-CSV ZIP</button></div></article>)}{!batches.length ? <p className="muted">No batches found for this client.</p> : null}</aside> : null}
  </div>;
}
