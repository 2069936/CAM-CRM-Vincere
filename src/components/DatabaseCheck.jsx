import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Database, RefreshCw, XCircle } from 'lucide-react';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { loadSupabaseDiagnostics } from '../domain/supabaseStore';

function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function SampleTable({ table }) {
  const columns = table.columns.slice(0, 6);
  if (!table.sample.length) return <p className="muted">No sample rows.</p>;

  return (
    <div className="db-sample-wrap">
      <table className="db-sample-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {table.sample.map((row, index) => (
            <tr key={row.id || index}>
              {columns.map((column) => <td key={column}>{formatValue(row[column]).slice(0, 90)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DatabaseCheck() {
  const [diagnostics, setDiagnostics] = useState({ connected: false, tables: [] });
  const [status, setStatus] = useState(isSupabaseConfigured ? 'loading' : 'missing-env');
  const [error, setError] = useState('');

  async function refresh() {
    if (!isSupabaseConfigured) {
      setStatus('missing-env');
      setError('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }
    setStatus('loading');
    setError('');
    try {
      const result = await loadSupabaseDiagnostics();
      setDiagnostics(result);
      setStatus(result.connected ? 'connected' : 'partial');
    } catch (err) {
      setStatus('error');
      setError(err?.message || 'Could not connect to Supabase.');
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let active = true;
    loadSupabaseDiagnostics()
      .then((result) => {
        if (!active) return;
        setDiagnostics(result);
        setStatus(result.connected ? 'connected' : 'partial');
      })
      .catch((err) => {
        if (!active) return;
        setStatus('error');
        setError(err?.message || 'Could not connect to Supabase.');
      });
    return () => { active = false; };
  }, []);

  const totals = useMemo(() => {
    const tables = diagnostics.tables || [];
    return {
      tables: tables.length,
      ok: tables.filter((table) => table.ok).length,
      rows: tables.reduce((sum, table) => sum + Number(table.count || 0), 0),
    };
  }, [diagnostics]);

  const isConnected = status === 'connected';

  return (
    <main className="database-page">
      <section className="database-header">
        <div>
          <span className="eyebrow">Supabase</span>
          <h1>Database Check</h1>
          <p>Connection, table counts, and sample rows from the CRM database.</p>
        </div>
        <button className="primary-button" onClick={refresh} disabled={status === 'loading'}>
          <RefreshCw size={16} className={status === 'loading' ? 'spin' : ''} />
          Refresh
        </button>
      </section>

      <section className="db-status-grid">
        <div className={`db-status-card ${isConnected ? 'success' : 'danger'}`}>
          {isConnected ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
          <span>Connection</span>
          <strong>{status === 'loading' ? 'Checking...' : isConnected ? 'Connected' : 'Needs attention'}</strong>
        </div>
        <div className="db-status-card">
          <Database size={22} />
          <span>Tables</span>
          <strong>{totals.ok}/{totals.tables}</strong>
        </div>
        <div className="db-status-card">
          <Database size={22} />
          <span>Total rows</span>
          <strong>{totals.rows.toLocaleString()}</strong>
        </div>
      </section>

      {error ? <div className="notice danger">{error}</div> : null}
      {!isSupabaseConfigured ? (
        <div className="notice warning">Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to `.env.local`.</div>
      ) : null}

      <section className="panel db-table-panel">
        <div className="panel-heading">
          <h3>Tables</h3>
          <span className="badge muted">{status}</span>
        </div>
        <div className="db-table-list">
          {(diagnostics.tables || []).map((table) => (
            <details className="db-table-card" key={table.table}>
              <summary>
                <span className={`close-dot close-dot-${table.ok ? 'closed' : 'no-close'}`} />
                <strong>{table.table}</strong>
                <em>{table.count.toLocaleString()} rows</em>
              </summary>
              {table.error ? <p className="negative">{table.error}</p> : <SampleTable table={table} />}
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
