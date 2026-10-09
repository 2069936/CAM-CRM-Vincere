import { useEffect, useId, useRef, useState } from 'react';
import { Scale } from 'lucide-react';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import NotShownLine from './NotShownLine';
import RefreshNote from './RefreshNote';
import TrackerCloseTable from './TrackerCloseTable';

/**
 * THE TRACKER AGAINST THE CLOSE, FOR A WHOLE BOOK: ONE LINE PER CLIENT.
 *
 * "Northwind: 2 differ, 1 tracker only, 5 match", worst first, the same table
 * the client page shows behind a click, "Open" to the client. The lines come
 * from buildTrackerCloseOverview over the one read the overview makes for
 * today's pinned rows (useTrackerCloseComparison, every two minutes).
 *
 * THREE LINES THAT ARE NOT VERDICTS: a close pinned after this session loaded
 * (the login state does not have it; reload), a close in the session with no
 * reading pinned, and no close yet today. A close whose rows this session has
 * not loaded is asked for once through `onNeedClose`, the way every other
 * panel asks App.jsx for a close's rows.
 *
 * THE CLIENTS WITH NO TRACKER READING ARE ONE FOLDED LINE UNDER THE LIST, not a
 * line each: on a real close 70 of 80 clients had a VPS that does not sample
 * yet, and a line per client ("15 close only") buried the 10 with a tracker.
 * The names are behind a Show toggle (NotShownLine), and the header counts
 * only the clients with a tracker: "3 of 10 clients with a tracker ask for a
 * look."
 */
export default function TrackerCloseOverview({
  view,
  read = null,
  refreshMs = LIVE_REFRESH_MS,
  onSelectClient = null,
  onAddFlag = null,
  onNeedClose = null,
}) {
  const [openKey, setOpenKey] = useState(null);
  const baseId = useId();
  const unloaded = (view?.unloadedImportIds || []).join(',');
  // Asked once per set of closes, whatever the identity of the callback: the
  // caller's loader is cached by id, but a nudge per render is still noise.
  const asked = useRef('');
  useEffect(() => {
    if (!onNeedClose || !unloaded || asked.current === unloaded) return;
    asked.current = unloaded;
    onNeedClose(unloaded.split(','));
  }, [onNeedClose, unloaded]);

  return (
    <div className="tracker-close-overview" role="region" aria-label="Tracker against the close, by client">
      <div className="tracker-close-overview-head">
        <Scale size={14} aria-hidden="true" />
        <p className="muted">
          One line per client for today&apos;s close: what the tracker said just before the capture, against the close, worst first.
          A click on a line opens its accounts.
          {' '}
          <RefreshNote updatedAt={read?.clock ?? null} refreshMs={refreshMs} />
        </p>
      </div>
      <Lines view={view} read={read} baseId={baseId} openKey={openKey} setOpenKey={setOpenKey} onSelectClient={onSelectClient} onAddFlag={onAddFlag} />
    </div>
  );
}

function Lines({ view, read, baseId, openKey, setOpenKey, onSelectClient, onAddFlag }) {
  switch (view?.state) {
    case 'not_deployed':
      return <p className="tracker-close-empty">Not available on this CRM yet. Migration step 66 has not been run, so no tracker reading is pinned at the close.</p>;
    case 'not_configured':
      return <p className="tracker-close-empty">The comparison reads the database, and this session has none.</p>;
    case 'reading':
      return <p className="tracker-close-empty" role="status">Reading the tracker readings pinned at today&apos;s close.</p>;
    case 'failed':
      return (
        <div className="tracker-close-empty tracker-close-failed" role="alert">
          <p>Could not read the tracker readings.</p>
          <button type="button" className="ghost-button" onClick={read?.retry}>Try again</button>
        </div>
      );
    case 'no_clients':
      return <p className="tracker-close-empty">No client in this book to compare.</p>;
    case 'ready':
      break;
    default:
      return null;
  }
  const lines = view.lines;
  const noTracker = view.noTracker || { count: 0, clients: [], sentence: null };
  // Before the first close of the day every line would say the same thing;
  // one sentence says it once, and the lines return with the first close.
  if (!noTracker.count && lines.length && lines.every((line) => line.state === 'no_close')) {
    const clients = lines.length === 1 ? 'client' : 'clients';
    return (
      <p className="tracker-close-empty">
        {`No close yet today for any of the ${lines.length} ${clients}. The comparison starts with the first close captured today.`}
      </p>
    );
  }
  const tracked = view.trackedClients || 0;
  const attention = view.attentionClients || 0;
  return (
    <>
      {tracked ? (
        <p className="tracker-close-overview-summary">
          {`${attention} of ${tracked} ${tracked === 1 ? 'client' : 'clients'} with a tracker ${attention === 1 ? 'asks' : 'ask'} for a look.`}
        </p>
      ) : null}
      {read?.error ? <p className="tracker-close-failed">Could not refresh the comparison. The lines are the last answer.</p> : null}
      {lines.length ? (
        <ul className="tracker-close-lines">
          {lines.map((line, index) => {
            const ready = line.state === 'ready';
            const open = ready && openKey === line.clientKey;
            const tableId = `${baseId}line${index}`;
            const words = (
              <>
                <strong className="tracker-close-line-name">{line.clientName}</strong>
                {': '}
                <span className="tracker-close-line-words">{line.words}</span>
              </>
            );
            return (
              <li
                key={line.clientKey}
                className={`tracker-close-line state-${line.state}${line.summary?.attention ? ' attention' : ''}`}
                data-client-id={line.clientId}
              >
                <div className="tracker-close-line-head">
                  {ready ? (
                    <button
                      type="button"
                      className="tracker-close-line-toggle"
                      aria-expanded={open}
                      aria-controls={open ? tableId : undefined}
                      title={open ? 'Hide the accounts' : 'Show the accounts'}
                      onClick={() => setOpenKey(open ? null : line.clientKey)}
                    >
                      {words}
                    </button>
                  ) : (
                    <span className="tracker-close-line-still">{words}</span>
                  )}
                  {typeof onSelectClient === 'function' ? (
                    <button type="button" className="link-button tracker-close-line-open" title={`Open ${line.clientName}`} onClick={() => onSelectClient(line.clientId)}>
                      Open
                    </button>
                  ) : null}
                </div>
                {open ? (
                  <div id={tableId} className="tracker-close-line-table">
                    <TrackerCloseTable
                      rows={line.panel.rows}
                      pnlSourceSentence={line.panel.pnlSourceSentence}
                      clientId={line.clientId}
                      importId={line.importId}
                      onAddFlag={onAddFlag}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {noTracker.count ? (
        <div className="tracker-close-no-tracker">
          <NotShownLine
            notShown={{
              count: noTracker.count,
              sentence: noTracker.sentence,
              accounts: noTracker.clients.map((entry) => ({ key: entry.clientKey, accountName: entry.clientName })),
            }}
            label="clients with no tracker reading"
          />
        </div>
      ) : null}
    </>
  );
}
