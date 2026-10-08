import { useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  LEGEND,
  LIVE_SAMPLING_BUILD,
  agedWords,
  buildFleetStatusLights,
} from '../domain/fleetStatusLights';

/**
 * THE STATUS LIGHT, FIRST, FOR EVERY CLIENT IN THE BOOK.
 *
 * One tile per client, tinted by its worst account; inside it one dot per
 * account, coloured by the sample-only classification the overview already
 * runs, with the run state as a tiny word under each dot. Worst first, so the
 * top left of the grid is where the morning starts.
 *
 * EVERY COLOUR HAS WORDS BESIDE IT. The legend names the four tones, every tile
 * says its worst state in a word, every dot carries its state and sentence in
 * its title and a visible word under it. The same rule AccountTrackerPanel is
 * built on: the dot says whether to look, never what is wrong.
 *
 * IT READS WHAT THE OVERVIEW ALREADY LOADED. The tracker object comes from
 * useLiveAccountTracker (one PostgREST request every two minutes for the whole
 * set of clients); this component makes no request of its own.
 *
 * THREE HONEST EMPTY STATES, each a different thing to do: step 55 not run
 * (nothing is recorded), nothing sampled yet (install the build that samples),
 * and a client nothing has reached (open it: the client page has the device).
 */
export default function FleetStatusLights({
  clients = [],
  tracker = null,
  now = null,
  onSelectClient = null,
}) {
  // The clock is the caller's (the tracker hook moves it on every successful
  // read). A caller without one gets the mount time, held, never a fresh
  // Date.now() per render: a picture that aged on its own re-renders would say
  // "silent" about accounts nobody has re-read.
  const [mountedAt] = useState(() => Date.now());
  const at = now ?? mountedAt;
  const view = useMemo(() => buildFleetStatusLights({ clients, tracker, now: at }), [clients, tracker, at]);

  if (view.kind === 'unavailable') {
    return (
      <div className="fsl-empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>Live account tracking is not available on this CRM yet.</strong>
          <span>Migration step 55 has not been run, so nothing is being recorded between closes.</span>
        </div>
      </div>
    );
  }

  if (view.kind === 'no_clients') {
    return (
      <div className="fsl-empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>No client in this book to light.</strong>
          <span>Tiles appear here as clients are added.</span>
        </div>
      </div>
    );
  }

  if (view.kind === 'no_samples') {
    const build = view.minAgentVersion || LIVE_SAMPLING_BUILD;
    return (
      <div className="fsl-empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>No collector sends live samples yet.</strong>
          <span>
            {view.minAgentVersion
              ? `Live sampling needs collector build ${build} or newer on each VPS, and no sample has arrived for any of the ${view.tiles.length} clients in this book.`
              : `Live sampling arrives with collector build ${build}. Nothing has sampled for any of the ${view.tiles.length} clients in this book, and no build is named in account_tracker_settings.min_agent_version yet.`}
            {' '}The daily close is unaffected by this.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="fsl" role="region" aria-label="Live accounts across the book">
      <div className="fsl-head">
        <Activity size={14} aria-hidden="true" />
        <p className="fsl-summary">
          {view.words}
          {' '}
          <span className="muted">
            As of {view.at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.
          </span>
        </p>
      </div>
      <ul className="fsl-legend" aria-label="What the colours mean">
        {LEGEND.map((entry) => (
          <li key={entry.tone} className={`fsl-legend-item tone-${entry.tone}`}>
            <span className="fsl-dot" aria-hidden="true" />
            <span>{entry.word}</span>
          </li>
        ))}
      </ul>
      <ul className="fsl-grid">
        {view.tiles.map((tile) => (
          <Tile key={tile.clientId} tile={tile} onSelectClient={onSelectClient} />
        ))}
      </ul>
    </div>
  );
}

function Tile({ tile, onSelectClient }) {
  const clickable = typeof onSelectClient === 'function';
  const body = (
    <>
      <span className="fsl-tile-head">
        <strong className="fsl-tile-name">{tile.clientName}</strong>
        <span className="fsl-tile-state">{tile.worst.word}</span>
      </span>
      {tile.dots.length ? (
        <span className="fsl-dots" role="list" aria-label={`${tile.clientName} accounts`}>
          {tile.dots.map((dot) => (
            <span
              key={dot.accountName}
              role="listitem"
              className={`fsl-dot-item tone-${dot.tone} tracker-${dot.state}`}
              title={dot.title}
              aria-label={`${dot.accountName}: ${dot.label}${dot.runLabel ? `, ${dot.runLabel}` : ''}`}
            >
              <span className="fsl-dot" aria-hidden="true" />
              <span className="fsl-dot-word">{dot.word}</span>
            </span>
          ))}
        </span>
      ) : null}
      <span className="fsl-tile-words">
        {tile.words}
        {tile.sampled ? ` Latest sample ${agedWords(tile.ageMinutes)}.` : ''}
      </span>
    </>
  );
  return (
    <li className={`fsl-tile tone-${tile.worst.tone}`} data-client-id={tile.clientId} data-worst={tile.worst.state}>
      {clickable ? (
        <button
          type="button"
          className="fsl-tile-button"
          onClick={() => onSelectClient(tile.clientId)}
          title={`Open ${tile.clientName}`}
        >
          {body}
        </button>
      ) : (
        <div className="fsl-tile-button">{body}</div>
      )}
    </li>
  );
}
