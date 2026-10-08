import { useEffect, useId, useMemo, useState } from 'react';
import { loadSupabaseAlgorithmLive } from '../domain/supabaseStore';
import { buildAlgorithmRollCall } from '../domain/algorithmRollCall';
import { cycleClock } from '../domain/algorithmLiveComparison';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import { copyToClipboard } from '../lib/copyToClipboard';
import RefreshNote from './RefreshNote';
import useAlgorithmLiveRead from './useAlgorithmLiveRead';

/* The first agent and add-on build that posts the position with the reading
 * (step 64). Only ever printed: the rows decide from the data whether a
 * position was read, never from a version. */
export const LIVE_POSITION_SAMPLE_VERSION = '1.2.1';

/** How long the button says Copied. */
export const COPIED_MS = 2000;

/**
 * THE ROLL CALL PER ALGORITHM, FOR THE TEAM CHAT.
 *
 * Pedro's words: the CAMs tell each other in the chat how each algorithm is
 * doing ("URGO -300", "how did BulletBot leave you?") and spot the odd one out.
 * One row per algorithm the viewer's clients run in the current cycle: the
 * name, how many of my instances, my range, the desk median and spread, and
 * the status word; a click opens the instances one by one (client, account,
 * connection, the three figures, which way it fired and the trades when the
 * machine said); "Copy for the chat" puts one line on the clipboard.
 *
 * EVERYTHING THAT COMPARES IS algorithmLiveComparison's, through
 * buildAlgorithmRollCall: the same cycle, the same band, "differs" as the only
 * verdict, null as not measured. The instance that differs carries the amber
 * chip the pill and the drill down use; it is a question, never red, and the
 * word is beside it.
 *
 * READ ON THE SAME CADENCE AS THE COMPARISON PANEL, two minutes, by uuid, and
 * said out loud over the rows. The position and the trades come only from
 * machines on agent 1.2.1 or newer; a 1.2.0 reading prints nothing of them.
 */
export default function AlgorithmRollCall({
  clients = [],
  tracker = null,
  bookWords = 'your clients',
  load = loadSupabaseAlgorithmLive,
  refreshMs = LIVE_REFRESH_MS,
  now = () => new Date(),
  copy = null,
  copiedMs = COPIED_MS,
}) {
  const clientIds = useMemo(
    () => (clients || []).map((client) => client?.uuid || client?.id).filter(Boolean),
    [clients],
  );
  const { data, error, reading, clock, retry } = useAlgorithmLiveRead({ clientIds, load, refreshMs, now });
  const view = useMemo(
    () => buildAlgorithmRollCall({ live: data, clients, tracker, now: clock }),
    [data, clients, tracker, clock],
  );

  const [openKey, setOpenKey] = useState(null);
  const [copied, setCopied] = useState(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), copiedMs);
    return () => clearTimeout(timer);
  }, [copied, copiedMs]);
  const baseId = useId();
  const copier = typeof copy === 'function' ? copy : copyToClipboard;

  if (error && !data) {
    return (
      <div className="algorithm-rollcall" role="alert">
        <p className="algorithm-rollcall-empty">Could not read the roll call.</p>
        <button type="button" className="ghost-button" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!data) {
    return <p className="algorithm-rollcall algorithm-rollcall-empty muted" role="status">{reading ? 'Reading the roll call.' : ''}</p>;
  }

  const cycle = cycleClock(view.cycleStart);
  const empty = emptyStateCopy(view, { cycle, bookWords });
  if (empty) {
    return (
      <div className="algorithm-rollcall" role="status">
        <p className="algorithm-rollcall-empty">{empty}</p>
      </div>
    );
  }

  const cycleSeconds = view.settings?.cycleSeconds || 600;
  const stale = view.cycleAgeSeconds > 2 * cycleSeconds;

  async function copyLine(row) {
    const ok = await copier(row.chatLine);
    // A new object every time, so a second copy of the same row restarts the
    // two seconds; a counter, not a clock, keeps the render pure.
    setCopied((previous) => ({ key: row.key, ok, n: (previous?.n || 0) + 1 }));
  }

  return (
    <div className="algorithm-rollcall" role="region" aria-label="Algorithm roll call">
      <div className="algorithm-rollcall-head">
        <p className="muted">
          {`One row per algorithm ${bookWords} run, cycle ${cycle}: the instances against the desk, realized plus open in whole dollars. Position and trades arrive from machines on agent ${LIVE_POSITION_SAMPLE_VERSION} or newer.`}
          {' '}
          <RefreshNote updatedAt={clock} refreshMs={refreshMs} />
        </p>
        {stale ? (
          <p className="muted">{`Last cycle with readings: ${cycle}. Strategies are switched off after the close, so the roll call stops there.`}</p>
        ) : null}
        {data.fillingCycleStart ? (
          <p className="muted">{`The ${cycleClock(data.fillingCycleStart)} cycle is still coming in, so this shows the last complete one.`}</p>
        ) : null}
        {error ? (
          <p className="muted">
            Could not refresh the roll call.
            {' '}
            <button type="button" className="ghost-button" onClick={retry}>Try again</button>
          </p>
        ) : null}
      </div>

      <ul className="algorithm-rollcall-list">
        {view.rows.map((row, index) => {
          const open = openKey === row.key;
          const listId = `${baseId}row${index}`;
          return (
            <li
              key={row.key}
              className={`algorithm-rollcall-row status-${row.status}${row.differsCount ? ' differs' : ''}`}
              data-algorithm={row.algorithm}
              data-root={row.instrumentRoot}
            >
              <div className="algorithm-rollcall-line">
                <button
                  type="button"
                  className="algorithm-rollcall-toggle"
                  aria-expanded={open}
                  aria-controls={open ? listId : undefined}
                  title={open ? 'Hide the instances' : 'Show the instances, one by one'}
                  onClick={() => setOpenKey(open ? null : row.key)}
                >
                  <strong className="algorithm-rollcall-name">{row.heading}</strong>
                  <span className="algorithm-rollcall-count">{row.countWords}</span>
                  <span className="algorithm-rollcall-range">{row.rangeWords}</span>
                  <span className="algorithm-rollcall-desk">{row.deskWords}</span>
                  <span className={`algorithm-rollcall-status ${row.status}`}>{row.statusWords}</span>
                </button>
                <button
                  type="button"
                  className="ghost-button algorithm-rollcall-copy"
                  title={row.chatLine}
                  onClick={() => copyLine(row)}
                >
                  {copyLabel(copied, row.key)}
                </button>
              </div>
              {open ? (
                <ul id={listId} className="algorithm-rollcall-instances" aria-label={`${row.heading} instances`}>
                  {row.instances.map((instance) => <Instance key={`${instance.clientId}|${instance.accountName}`} instance={instance} />)}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function copyLabel(copied, key) {
  if (!copied || copied.key !== key) return 'Copy for the chat';
  return copied.ok ? 'Copied' : 'Could not copy';
}

function emptyStateCopy(view, { cycle, bookWords }) {
  switch (view.state) {
    case 'not_configured':
      return 'The roll call reads the database, and this session has none.';
    case 'not_deployed':
      return 'Migration step 57 has not been run, so there is no roll call yet.';
    case 'no_readings':
      return 'No machine has sent per strategy readings yet. They start once a VPS runs an agent and add-on that samples strategies.';
    case 'no_complete_cycle':
      return 'Waiting for the first complete cycle.';
    case 'cycle_filling':
      return `The ${cycle} cycle is still coming in. The roll call shows once it is complete.`;
    case 'ready':
      return view.rows.length ? null : `None of ${bookWords} ran an algorithm in the ${cycle} cycle.`;
    default:
      return null;
  }
}

/* Whole dollars. Only ever called with a measured number: null never reaches a
 * dollar sign, it reaches "not measured". */
function money(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function Instance({ instance }) {
  return (
    <li className={`algorithm-rollcall-instance status-${instance.status}${instance.differs ? ' differs' : ''}`} data-account={instance.accountName}>
      <strong>{`${instance.clientName} / ${instance.accountName}`}</strong>
      <span className={`algorithm-rollcall-connection${instance.hasConnection ? '' : ' absent'}`}>{instance.connectionWord}</span>
      <Figure label="realized" value={instance.realized} />
      <Figure label="open" value={instance.unrealized} />
      <Figure label="total" value={instance.value} strong />
      {instance.positionWords ? <span className="algorithm-rollcall-position">{instance.positionWords}</span> : null}
      {instance.tradesWords ? <span className="algorithm-rollcall-trades">{instance.tradesWords}</span> : null}
      {instance.differs ? <span className="badge warning algorithm-rollcall-differs">Differs from the desk</span> : null}
    </li>
  );
}

function Figure({ label, value, strong = false }) {
  const className = `algorithm-rollcall-figure${strong ? ' strong' : ''}`;
  if (value === null || value === undefined) {
    return <span className={className}><span className="algorithm-rollcall-absent">{`${label} not measured`}</span></span>;
  }
  return (
    <span className={className}>
      <span className="algorithm-rollcall-figure-label">{label}</span>
      {' '}
      <span className={value >= 0 ? 'positive' : 'negative'}>{money(value)}</span>
    </span>
  );
}
