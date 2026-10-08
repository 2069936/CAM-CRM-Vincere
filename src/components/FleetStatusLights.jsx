import { useId, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  LEGEND,
  LIVE_SAMPLING_BUILD,
  agedWords,
  buildFleetStatusLights,
} from '../domain/fleetStatusLights';
import { CLOSE_DIFFERS_WORD, withCloseDiffers, withDiffers } from '../domain/accountPill';
import { buildAccountLiveDetail } from '../domain/accountLiveDetail';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import { loadSupabaseAccountObservationSettings, loadSupabaseClientLiveStrategies } from '../domain/supabaseStore';
import AccountPill from './AccountPill';
import AccountLiveDetail from './AccountLiveDetail';
import NotShownLine from './NotShownLine';
import RefreshNote from './RefreshNote';
import useAccountObservationSettings from './useAccountObservationSettings';
import useClientLiveStrategies from './useClientLiveStrategies';

/**
 * THE STATUS LIGHT, FIRST, FOR EVERY CLIENT IN THE BOOK.
 *
 * One tile per client, tinted by its worst account; inside it one PILL per
 * account, the same pill the client page strip renders: the dot, the account,
 * the connection, the state in words. Worst first, so the top left of the grid
 * is where the morning starts.
 *
 * TWO CLICKS, TWO DIFFERENT THINGS. The tile's head (the client's name and its
 * worst state) opens the client. A pill opens, inside the tile, what that
 * account is running: the connection, the account totals, and one row per
 * strategy instance held against the desk. One account open per tile at a
 * time; the strategy rows for that client are read on demand when a pill is
 * opened, cached per client, and refreshed on the tracker's cadence while one
 * is open. A pill is never a button inside a button: the head is one button
 * and each pill is its own.
 *
 * EVERY COLOUR HAS WORDS BESIDE IT. The legend names the four tones and the
 * amber marker, every tile says its worst state in a word, every pill carries
 * its state and sentence. The amber corner on a pill means an algorithm on that
 * account differs from the desk in this cycle, by algorithmLiveComparison's
 * own rule; it is a question, never red, and never the pill's colour.
 *
 * IT READS WHAT THE OVERVIEW ALREADY LOADED. The tracker object comes from
 * useLiveAccountTracker (one PostgREST request every two minutes for the whole
 * set of clients); this component makes no request of its own for the tiles.
 * The refresh is said out loud over the grid: "Updated 40 s ago, refreshes
 * every 2 min."
 *
 * ONLY THE ACCOUNTS EXPECTED TO TRADE GET A PILL. The registry says what the
 * closes saw of every account (step 65); a tile lights the expected ones, says
 * "New, not sampled yet" on a new one, and folds the rest into one muted line
 * under the tile with a Show toggle (NotShownLine). The one setting this needs,
 * new_account_days, is read once per session by useAccountObservationSettings
 * and defaults to 14 when it cannot be read.
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
  refreshMs = LIVE_REFRESH_MS,
  loadStrategies = loadSupabaseClientLiveStrategies,
  loadObservationSettings = loadSupabaseAccountObservationSettings,
  // Today's tracker against the close verdicts by client key (uuid or id),
  // each a Map of lower case account name to verdict, from the overview's
  // read (step 66). A pill whose verdict asks for a look carries the amber
  // "Close differs" badge in words. Null says nothing about anything.
  closeVerdicts = null,
}) {
  // The clock is the caller's (the tracker hook moves it on every successful
  // read). A caller without one gets the mount time, held, never a fresh
  // Date.now() per render: a picture that aged on its own re-renders would say
  // "silent" about accounts nobody has re-read.
  const [mountedAt] = useState(() => Date.now());
  const at = now ?? mountedAt;
  const observation = useAccountObservationSettings({
    enabled: Boolean(tracker && tracker.available !== false),
    load: loadObservationSettings,
  });
  const view = useMemo(
    () => buildFleetStatusLights({ clients, tracker, now: at, settings: observation.settings }),
    [clients, tracker, at, observation.settings],
  );
  const clientsById = useMemo(() => {
    const map = new Map();
    for (const client of clients || []) if (client?.id) map.set(client.id, client);
    return map;
  }, [clients]);

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
          <RefreshNote updatedAt={view.at} refreshMs={refreshMs} />
        </p>
      </div>
      <ul className="fsl-legend" aria-label="What the colours mean">
        {LEGEND.map((entry) => (
          <li key={entry.tone} className={`fsl-legend-item tone-${entry.tone}`}>
            <span className="fsl-dot" aria-hidden="true" />
            <span>{entry.word}</span>
          </li>
        ))}
        <li className="fsl-legend-item fsl-legend-mark">
          <span className="fsl-dot" aria-hidden="true"><span className="account-pill-mark" /></span>
          <span>Amber corner: an algorithm differs from the desk</span>
        </li>
        {closeVerdicts ? (
          <li className="fsl-legend-item fsl-legend-close">
            <span className="account-pill-close-differs" aria-hidden="true">{CLOSE_DIFFERS_WORD}</span>
            <span>The tracker and today&apos;s close disagree about the account</span>
          </li>
        ) : null}
      </ul>
      <ul className="fsl-grid">
        {view.tiles.map((tile) => (
          <Tile
            key={tile.clientId}
            tile={tile}
            client={clientsById.get(tile.clientId) || { id: tile.clientId, uuid: tile.clientKey, name: tile.clientName }}
            now={view.at}
            onSelectClient={onSelectClient}
            refreshMs={refreshMs}
            loadStrategies={loadStrategies}
            closeVerdicts={closeVerdicts?.get(tile.clientKey) || closeVerdicts?.get(tile.clientId) || null}
          />
        ))}
      </ul>
    </div>
  );
}

function Tile({ tile, client, now, onSelectClient, refreshMs, loadStrategies, closeVerdicts = null }) {
  const [expanded, setExpanded] = useState(null);
  const detailId = useId();
  const openDot = expanded ? tile.dots.find((dot) => dot.accountName === expanded) || null : null;
  /* READ ON DEMAND, PER CLIENT. Active while a pill on this tile is open; the
   * answer is cached per client by the hook, so the amber markers stay on the
   * pills after the detail is closed and a reopened pill shows at once. */
  const strategies = useClientLiveStrategies(tile.clientKey, {
    active: openDot !== null,
    refreshMs,
    load: loadStrategies,
  });
  const details = useMemo(() => new Map(tile.dots.map((dot) => [
    dot.accountName,
    buildAccountLiveDetail({ client, accountName: dot.accountName, sample: dot.sample, strategies: strategies.data, now }),
  ])), [tile, client, strategies.data, now]);

  const clickable = typeof onSelectClient === 'function';
  const head = (
    <span className="fsl-tile-head">
      <strong className="fsl-tile-name">{tile.clientName}</strong>
      <span className="fsl-tile-state">{tile.worst.word}</span>
    </span>
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
          {head}
        </button>
      ) : (
        <div className="fsl-tile-button">{head}</div>
      )}
      {tile.dots.length ? (
        <ol className="account-pills fsl-pills" aria-label={`${tile.clientName} accounts`}>
          {tile.dots.map((dot) => (
            <AccountPill
              key={dot.accountName}
              pill={withCloseDiffers(
                withDiffers(dot, details.get(dot.accountName)?.differsCount || 0),
                closeVerdicts?.get(String(dot.accountName).trim().toLowerCase()) || null,
              )}
              expanded={expanded === dot.accountName}
              controls={detailId}
              onToggle={() => setExpanded((value) => (value === dot.accountName ? null : dot.accountName))}
            />
          ))}
        </ol>
      ) : null}
      {openDot ? (
        <AccountLiveDetail
          id={detailId}
          view={details.get(openDot.accountName)}
          reading={strategies.reading}
          error={strategies.error}
        />
      ) : null}
      <span className="fsl-tile-words">
        {tile.words}
        {tile.sampled ? ` Latest sample ${agedWords(tile.ageMinutes)}.` : ''}
      </span>
      <NotShownLine notShown={tile.notShown} label={`${tile.clientName}, accounts not shown`} />
    </li>
  );
}
