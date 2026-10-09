import { Fragment, useId, useState } from 'react';
import { NO_CONNECTION_WORD } from '../domain/accountPill';

/**
 * ONE ROW PER ACCOUNT: THE TRACKER AT THE CLOSE AGAINST THE CLOSE ITSELF.
 *
 * The same table on the client page (under the tracker strip) and under a
 * client's line on the overview. Everything printed here was decided by
 * src/domain/trackerClosePanel.js over trackerCloseComparison.js; this file
 * only lays it out: Account (connection beneath), Tracker at close (total,
 * realized, open, when it was sampled and since when it held, the day's trail
 * when there is one), Close daily P&L (the close's own note about where its
 * figures came from one hover away), Delta, Strategies, Gap, Verdict with its
 * sentence, and "Add flag" on a row that asks for a look.
 *
 * A MISSING SIDE PRINTS NOTHING IN THE DELTA CELL. Never $0: a cell that read
 * $0 about an account the close does not list would be the one lie this whole
 * comparison exists to avoid.
 *
 * "ADD FLAG" ASKS INLINE, in the cell, and never through the browser's own
 * dialog: the title it will write is shown first, a second click writes it
 * through the queue's own path (onAddFlag(clientId, importId, flag)), and the
 * cell then says so. When that write is refused (the promise rejects), the
 * cell goes back to the button and says "Could not add the flag." beside it.
 * One row open at a time for the per algorithm list.
 */
export default function TrackerCloseTable({
  rows = [],
  pnlSourceSentence = '',
  clientId = null,
  importId = null,
  onAddFlag = null,
}) {
  const [openAccount, setOpenAccount] = useState(null);
  const baseId = useId();
  const canFlag = typeof onAddFlag === 'function';
  const columns = canFlag ? 8 : 7;
  return (
    <div className="ops-table-wrap tracker-close-table-wrap">
      <table className="ops-table tracker-close-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Tracker at close</th>
            <th title={pnlSourceSentence || undefined}>Close daily P&amp;L</th>
            <th>Delta</th>
            <th>Strategies</th>
            <th>Gap</th>
            <th>Verdict</th>
            {canFlag ? <th><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const open = openAccount === row.accountName;
            const detailId = `${baseId}row${index}`;
            const connection = row.connectionName || row.closeConnection || null;
            return (
              <Fragment key={row.accountName}>
                <tr
                  className={`tracker-close-row verdict-${row.verdict}${row.attention ? ' attention' : ''}`}
                  data-account={row.accountName}
                  data-verdict={row.verdict}
                >
                  <td>
                    <button
                      type="button"
                      className="tracker-close-toggle"
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      title={open ? 'Hide the algorithms' : 'Show the algorithms, both sides'}
                      onClick={() => setOpenAccount(open ? null : row.accountName)}
                    >
                      <strong className="tracker-close-account">{row.accountName}</strong>
                      <span className={`tracker-close-connection${connection ? '' : ' absent'}`}>{connection || NO_CONNECTION_WORD}</span>
                    </button>
                  </td>
                  <td><TrackerCell row={row} /></td>
                  <td className="tracker-close-close" title={pnlSourceSentence || undefined}>
                    {row.closeWords ?? <span className="tracker-close-absent">not in the close</span>}
                  </td>
                  <td className="tracker-close-delta">
                    {row.deltaWords === null ? null : (
                      <span className={row.delta > 0 ? 'positive' : row.delta < 0 ? 'negative' : ''}>{row.deltaWords}</span>
                    )}
                  </td>
                  <td>{row.strategiesWords}</td>
                  <td>{row.gapWords}</td>
                  <td>
                    <span className={`badge ${row.tone} tracker-close-verdict verdict-${row.verdict}`}>{row.verdictWord}</span>
                    <span className="tracker-close-sentence">{[row.sentence, ...row.notes].join(' ')}</span>
                  </td>
                  {canFlag ? (
                    <td className="tracker-close-actions">
                      <FlagAction row={row} clientId={clientId} importId={importId} onAddFlag={onAddFlag} />
                    </td>
                  ) : null}
                </tr>
                {open ? (
                  <tr className="tracker-close-detail" id={detailId}>
                    <td colSpan={columns}><Strategies row={row} /></td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrackerCell({ row }) {
  const words = row.trackerWords;
  if (!words) return <span className="tracker-close-absent">no tracker reading</span>;
  return (
    <div className="tracker-close-tracker">
      <span className="tracker-close-figure strong">{words.total ?? <span className="tracker-close-absent">total no figure</span>}</span>
      <span className="tracker-close-figure">
        <span className="tracker-close-figure-label">realized</span>
        {' '}
        {words.realized ?? <span className="tracker-close-absent">no figure</span>}
      </span>
      <span className="tracker-close-figure">
        <span className="tracker-close-figure-label">open</span>
        {' '}
        {words.open ?? <span className="tracker-close-absent">no figure</span>}
      </span>
      {words.sampled ? <span className="tracker-close-sampled">{words.sampled}</span> : null}
      {row.spark ? <Sparkline spark={row.spark} /> : null}
    </div>
  );
}

/* The day's trail of the account's realized figure, a step per value run, the
 * capture a dashed line. Drawn only when the history holds more than one run:
 * a flat day is one run, and a line through one value says nothing. */
function Sparkline({ spark }) {
  return (
    <svg
      className="tracker-close-spark"
      viewBox={`0 0 ${spark.width} ${spark.height}`}
      width={spark.width}
      height={spark.height}
      role="img"
      aria-label={spark.words}
    >
      <path d={spark.path} fill="none" />
      {spark.captureX !== null ? (
        <line className="tracker-close-spark-capture" x1={spark.captureX} x2={spark.captureX} y1={0} y2={spark.height} />
      ) : null}
    </svg>
  );
}

function Strategies({ row }) {
  const closeOnly = row.strategyGap?.closeOnly || [];
  if (!row.strategies.length && !closeOnly.length) {
    return <p className="tracker-close-strategies-empty">No strategy reading on either side.</p>;
  }
  return (
    <ul className="tracker-close-strategies" aria-label={`${row.accountName} algorithms, tracker against the close`}>
      {row.strategies.map((item) => (
        <li key={item.key} className={`tracker-close-strategy${item.moved ? ' moved' : ''}`} data-strategy={item.strategyName}>
          <strong>{item.strategyName}</strong>
          <span className="tracker-close-strategy-instrument">{item.instrument}</span>
          <span className="tracker-close-figure">
            <span className="tracker-close-figure-label">tracker</span>
            {' '}
            {item.trackerWords ?? <span className="tracker-close-absent">no figure</span>}
          </span>
          <span className="tracker-close-figure">
            <span className="tracker-close-figure-label">close</span>
            {' '}
            {item.closeWords ?? <span className="tracker-close-absent">not in the close</span>}
          </span>
          {item.gapWords !== null ? (
            <span className="tracker-close-figure strong">
              <span className="tracker-close-figure-label">gap</span>
              {' '}
              {item.gapWords}
            </span>
          ) : null}
          {item.moved ? <span className="badge warning tracker-close-strategy-moved">Moved</span> : null}
          <span className="tracker-close-strategy-words">{item.words}</span>
        </li>
      ))}
      {closeOnly.map((name) => (
        <li key={`close-only:${name}`} className="tracker-close-strategy close-only">
          <span className="tracker-close-strategy-words">{`${name} ran at the close and the tracker did not carry it.`}</span>
        </li>
      ))}
    </ul>
  );
}

function FlagAction({ row, clientId, importId, onAddFlag }) {
  const [phase, setPhase] = useState('idle');
  const [failed, setFailed] = useState(false);
  if (!row.flagDraft) return null;
  if (phase === 'added') return <span className="tracker-close-flag-added">Flag added</span>;

  // Said at once, like the queue's own optimistic row; taken back when the
  // write is refused, so the cell never claims a flag that was not written.
  function add() {
    setPhase('added');
    const takeBack = () => {
      setPhase('idle');
      setFailed(true);
    };
    let result;
    try {
      result = onAddFlag(clientId, importId, row.flagDraft);
    } catch {
      takeBack();
      return;
    }
    if (result && typeof result.then === 'function') result.then(null, takeBack);
  }

  if (phase === 'confirm') {
    return (
      <span className="tracker-close-flag-confirm" role="group" aria-label={`Add a flag for ${row.accountName}`}>
        <span>{`Add "${row.flagDraft.message}" to the flag queue?`}</span>
        <button type="button" className="resolve-button tracker-close-flag-confirm-yes" onClick={add}>
          Add flag
        </button>
        <button type="button" className="ghost-button tracker-close-flag-cancel" onClick={() => setPhase('idle')}>Cancel</button>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="ghost-button tracker-close-flag"
        title={row.flagDraft.message}
        onClick={() => {
          setFailed(false);
          setPhase('confirm');
        }}
      >
        Add flag
      </button>
      {failed ? <span className="tracker-close-flag-failed" role="status">Could not add the flag.</span> : null}
    </>
  );
}
