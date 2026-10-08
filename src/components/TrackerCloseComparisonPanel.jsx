import { Scale } from 'lucide-react';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import RefreshNote from './RefreshNote';
import TrackerCloseTable from './TrackerCloseTable';

/**
 * THE TRACKER AGAINST THE CLOSE, ON THE CLIENT PAGE, UNDER THE TRACKER STRIP.
 *
 * Pedro's ask: compare what the tracker said during the day with the end of
 * day result and see what changed. Step 66 pins the tracker's reading at each
 * close; the browser joins it to the close it already holds and
 * trackerCloseComparison.js says one verdict per account. This panel prints
 * that for the close on the date picker: the header in clocks and the
 * tolerance, the close's own note about its figures, then the table.
 *
 * TAKES THE VIEW AND THE READ STATE, reads nothing itself. The card around it
 * (AutoCollectionCard) owns the hook, so the strip's pills and this panel share
 * one answer; the tests render every state directly.
 *
 * THE EMPTY STATES ARE SENTENCES, each a different thing to do: no close on this
 * date yet; the CRM has not run step 66; no database in this session; still
 * reading; could not read (with a retry, and the last rows kept when there are
 * any); the close's own rows still loading; a close with no reading pinned,
 * which names the three ways that happens. No verdict is ever invented for a
 * state that has no data.
 */
export default function TrackerCloseComparisonPanel({
  view,
  read = null,
  clientId = null,
  importId = null,
  onAddFlag = null,
  refreshMs = LIVE_REFRESH_MS,
}) {
  const clock = read?.clock ?? null;
  const ready = view?.state === 'ready';
  return (
    <div className="tracker-close" role="region" aria-label="Tracker against the close">
      <div className="tracker-close-head">
        <Scale size={14} aria-hidden="true" />
        <div>
          <strong>Tracker against the close</strong>
          <span>
            {ready ? (
              <span className="tracker-close-header-words" title={view.header.toleranceRule}>{view.header.words}</span>
            ) : headWords(view)}
            {ready && view.header.basis === 'scheduled'
              ? ', capture time taken from the schedule because the close was not automatic'
              : ''}
            {ready ? '.' : ''}
            {' '}
            <RefreshNote updatedAt={clock} refreshMs={refreshMs} />
          </span>
        </div>
      </div>
      <Body view={view} read={read} clientId={clientId} importId={importId} onAddFlag={onAddFlag} />
    </div>
  );
}

function headWords(view) {
  switch (view?.state) {
    case 'no_close': return 'No close for this date yet.';
    case 'not_configured': return 'Not available in this session.';
    case 'not_deployed': return 'Not available on this CRM yet.';
    case 'reading': return 'Reading.';
    case 'failed': return 'Could not read.';
    case 'reading_close': return 'Reading the close.';
    case 'not_pinned': return 'The tracker had no reading before this close.';
    default: return '';
  }
}

function Body({ view, read, clientId, importId, onAddFlag }) {
  switch (view?.state) {
    case 'no_close':
      return (
        <p className="tracker-close-empty">
          {`No close for ${view.date || 'this date'} yet. The comparison starts when the close is captured and its tracker readings are pinned.`}
        </p>
      );
    case 'not_configured':
      return <p className="tracker-close-empty">The comparison reads the database, and this session has none.</p>;
    case 'not_deployed':
      return (
        <p className="tracker-close-empty">
          Migration step 66 has not been run, so no tracker reading is pinned at the close and there is nothing to compare.
        </p>
      );
    case 'reading':
      return <p className="tracker-close-empty" role="status">Reading the tracker readings pinned at this close.</p>;
    case 'failed':
      return (
        <div className="tracker-close-failed" role="alert">
          <p>Could not read the tracker readings for this close.</p>
          <button type="button" className="ghost-button" onClick={read?.retry}>Try again</button>
        </div>
      );
    case 'reading_close':
      return <p className="tracker-close-empty" role="status">Reading the close.</p>;
    case 'not_pinned':
      return (
        <p className="tracker-close-empty">
          Nothing was pinned when this close was captured: either step 66 was not yet running, the close was uploaded by hand
          (a manual close is pinned with record_tracker_close_readings), or no VPS sampled this client that day. No verdict is
          made up for it.
        </p>
      );
    case 'ready':
      return (
        <>
          <p className="tracker-close-source muted">{view.pnlSourceSentence}</p>
          <p className="tracker-close-summary">{attentionWords(view.summary)}</p>
          {view.error ? <p className="tracker-close-failed">Could not refresh the comparison. The rows are the last answer.</p> : null}
          <TrackerCloseTable
            rows={view.rows}
            pnlSourceSentence={view.pnlSourceSentence}
            clientId={clientId}
            importId={importId}
            onAddFlag={onAddFlag}
          />
        </>
      );
    default:
      return null;
  }
}

function attentionWords(summary) {
  const accounts = summary?.accounts || 0;
  const attention = summary?.attention || 0;
  const noun = accounts === 1 ? 'account' : 'accounts';
  const verb = attention === 1 ? 'asks' : 'ask';
  return `${attention} of ${accounts} ${noun} ${verb} for a look.`;
}
