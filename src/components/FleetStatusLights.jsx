import { useId, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  LIVE_ACCOUNTS_VIEW_KEY,
  LIVE_SAMPLING_BUILD,
  agedWords,
  buildFleetStatusLights,
  disconnectedClientKeys,
  legendFor,
  parseLiveAccountsView,
} from '../domain/fleetStatusLights';
import { CLOSE_DIFFERS_WORD, withCloseDiffers, withDiffers, withDisconnectedSince } from '../domain/accountPill';
import { buildAccountLiveDetail } from '../domain/accountLiveDetail';
import { disconnectedSinceByClient } from '../domain/disconnectedSince';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import {
  loadSupabaseAccountLiveSampleHistory,
  loadSupabaseAccountObservationSettings,
  loadSupabaseClientLiveStrategies,
} from '../domain/supabaseStore';
import AccountPill from './AccountPill';
import AccountLiveDetail from './AccountLiveDetail';
import NotShownLine from './NotShownLine';
import RefreshNote from './RefreshNote';
import useAccountObservationSettings from './useAccountObservationSettings';
import useBulbDrawer, { useEscapeToClose } from './useBulbDrawer';
import useClientLiveStrategies from './useClientLiveStrategies';
import useDisconnectedSince from './useDisconnectedSince';

/* The remembered view, per browser. Storage can be missing, full or refused
 * (a private window, blocked site data): every read and write is guarded, and
 * a read that fails is the default, Compact. */
function readStoredView() {
  try {
    return parseLiveAccountsView(window.localStorage.getItem(LIVE_ACCOUNTS_VIEW_KEY));
  } catch {
    return parseLiveAccountsView(null);
  }
}

function writeStoredView(view) {
  try {
    window.localStorage.setItem(LIVE_ACCOUNTS_VIEW_KEY, view);
  } catch {
    // A convenience, not state: the panel works the same without it.
  }
}

const VIEW_WORDS = Object.freeze({ compact: 'Compact', tiles: 'Tiles' });

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
 * its state and sentence. A client whose VPS samples only retired accounts is
 * the desk's hollow grey (tone-retired), never the solid grey of a client
 * nothing has sampled, and the legend names it while one is on screen. The amber corner on a pill means an algorithm on that
 * account differs from the desk in this cycle, by algorithmLiveComparison's
 * own rule; it is a question, never red, and never the pill's colour.
 *
 * ONE SYMBOL, ONE MEANING. The amber corner means "differs from the desk" in
 * both views and its legend line says so in both. A bulb whose client has an
 * account marked retired that is still running carries a different glyph, an
 * amber ring around the light (fsl-bulb-still-running), with its own legend
 * line in Compact; the "Marked" badge's legend line is there whenever a pill
 * on screen carries it (any tile in Tiles, the open drawer in Compact).
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
 *
 * COMPACT BY DEFAULT, THE TILES ONE CLICK AWAY. Pedro's words: the tiles are
 * the expanded view; summarised, one circle per client with the same colours,
 * so every client fits at once without scrolling. Compact is one bulb per
 * client in its tile's worst tone, the name and "5 of 6 live", worst first in
 * the tiles' own order; a bulb is a button (aria-expanded, aria-controls) and
 * opens THAT client's tile, the same component with its pills, its sentence,
 * its folded line and its pill detail, in a drawer under the bulbs. One open at
 * a time; the open bulb, Escape or Close shut it, and focus goes back to the
 * bulb (useBulbDrawer: Escape only, and not while typing in a field or a
 * dialog). "Compact" and "Tiles" in the header switch between the two and the
 * choice is remembered per browser.
 * The Manager's desk bulbs (DeskClientLights) are the same vocabulary: the
 * same light, the same size, the same drawer under the grid.
 *
 * SINCE WHEN IT IS DISCONNECTED. For the clients with a disconnected pill, and
 * only for them, today's tracker history is read once per tracker read
 * (useDisconnectedSince) and the pill's title and its detail say
 * "Disconnected since 09:40". The pill's word stays "Disconnected".
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
  loadHistory = loadSupabaseAccountLiveSampleHistory,
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

  const [mode, setMode] = useState(readStoredView);
  const drawer = useBulbDrawer();
  const open = drawer.open;
  const drawerId = useId();
  const compact = mode === 'compact';
  const openTile = compact && open ? view.tiles.find((tile) => tile.clientId === open) || null : null;
  // Escape shuts the drawer, while one is on screen.
  useEscapeToClose(openTile !== null, drawer.close);

  /* "Disconnected since": today's history for the clients with a disconnected
   * pill, read again on every tracker read; nobody disconnected reads nothing. */
  const disconnectedKeys = useMemo(() => disconnectedClientKeys(view.tiles), [view.tiles]);
  const history = useDisconnectedSince({ clientIds: disconnectedKeys, clock: view.at.getTime(), load: loadHistory });
  const sinceByClient = useMemo(() => disconnectedSinceByClient(history, { now: view.at }), [history, view.at]);

  function chooseMode(next) {
    drawer.reset();
    setMode(next);
    writeStoredView(next);
  }

  function tileProps(tile) {
    return {
      tile,
      client: clientsById.get(tile.clientId) || { id: tile.clientId, uuid: tile.clientKey, name: tile.clientName },
      now: view.at,
      onSelectClient,
      refreshMs,
      loadStrategies,
      closeVerdicts: closeVerdicts?.get(tile.clientKey) || closeVerdicts?.get(tile.clientId) || null,
      since: sinceByClient.get(tile.clientKey) || sinceByClient.get(tile.clientId) || null,
    };
  }

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
        <div className="segmented-control fsl-view-toggle" role="group" aria-label="Live accounts view">
          {['compact', 'tiles'].map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? 'active' : ''}
              aria-pressed={mode === value}
              onClick={() => chooseMode(value)}
            >
              {VIEW_WORDS[value]}
            </button>
          ))}
        </div>
      </div>
      <ul className="fsl-legend" aria-label="What the colours mean">
        {legendFor(view.tiles).map((entry) => (
          <li key={entry.tone} className={`fsl-legend-item tone-${entry.tone}`}>
            <span className="fsl-dot" aria-hidden="true" />
            <span>{entry.word}</span>
          </li>
        ))}
        <li className="fsl-legend-item fsl-legend-mark">
          <span className="fsl-dot" aria-hidden="true"><span className="account-pill-mark" /></span>
          <span>Amber corner: an algorithm differs from the desk</span>
        </li>
        {compact && view.tiles.some((tile) => tile.marked.length) ? (
          <li className="fsl-legend-item fsl-legend-still-running">
            <span className="fsl-dot fsl-bulb-still-running" aria-hidden="true" />
            <span>Amber ring: an account marked retired is still running</span>
          </li>
        ) : null}
        {(compact ? openTile?.marked.length : view.tiles.some((tile) => tile.marked.length)) ? (
          <li className="fsl-legend-item fsl-legend-marked">
            <span className="account-pill-marked" aria-hidden="true">Marked</span>
            <span>The registry retired the account and it is still running</span>
          </li>
        ) : null}
        {closeVerdicts ? (
          <li className="fsl-legend-item fsl-legend-close">
            <span className="account-pill-close-differs" aria-hidden="true">{CLOSE_DIFFERS_WORD}</span>
            <span>The tracker and today&apos;s close disagree about the account</span>
          </li>
        ) : null}
      </ul>
      {compact ? (
        <>
          <ul className="fsl-bulbs" aria-label="One light per client">
            {view.tiles.map((tile) => {
              const isOpen = open === tile.clientId;
              return (
                <li
                  key={tile.clientId}
                  className={`fsl-bulb tone-${tile.worst.tone}${isOpen ? ' open' : ''}${tile.marked.length ? ' marked' : ''}`}
                  data-client-id={tile.clientId}
                  data-worst={tile.worst.state}
                >
                  <button
                    type="button"
                    className="fsl-bulb-button"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? drawerId : undefined}
                    title={bulbTitle(tile)}
                    onClick={(event) => drawer.toggle(tile.clientId, event)}
                  >
                    <span className={`dcl-light fsl-light${tile.marked.length ? ' fsl-bulb-still-running' : ''}`} aria-hidden="true" />
                    <span className="dcl-bulb-name fsl-bulb-name">{tile.clientName}</span>
                    <span className="fsl-bulb-count">{tile.countWords}</span>
                    <span className="sr-only">
                      {tile.worst.word}
                      {tile.marked.length ? `, ${markedWords(tile)}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {openTile ? (
            <div
              className={`fsl-drawer tone-${openTile.worst.tone}`}
              id={drawerId}
              role="region"
              aria-label={`${openTile.clientName}, accounts`}
            >
              <ul className="fsl-drawer-tile">
                <Tile key={openTile.clientId} {...tileProps(openTile)} onClose={drawer.close} />
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <ul className="fsl-grid">
          {view.tiles.map((tile) => <Tile key={tile.clientId} {...tileProps(tile)} />)}
        </ul>
      )}
    </div>
  );
}

function markedWords(tile) {
  return tile.marked.map((entry) => `${entry.accountName} ${entry.words.charAt(0).toLowerCase()}${entry.words.slice(1)}`).join(', ');
}

/* The bulb's title: the client, its worst state, the tile's sentence, and the
 * accounts marked retired that are still running. */
function bulbTitle(tile) {
  const marked = tile.marked.length ? ` ${markedWords(tile)}.` : '';
  return `${tile.clientName}: ${tile.worst.word}. ${tile.words}${marked}`;
}

function Tile({ tile, client, now, onSelectClient, refreshMs, loadStrategies, closeVerdicts = null, since = null, onClose = null }) {
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
  const sinceOf = (dot) => (dot.state === 'disconnected' ? since?.get(dot.accountName) || null : null);
  const details = useMemo(() => new Map(tile.dots.map((dot) => [
    dot.accountName,
    buildAccountLiveDetail({
      client,
      accountName: dot.accountName,
      sample: dot.sample,
      strategies: strategies.data,
      now,
      disconnectedSince: dot.state === 'disconnected' ? since?.get(dot.accountName) || null : null,
    }),
  ])), [tile, client, strategies.data, now, since]);

  const clickable = typeof onSelectClient === 'function';
  const head = (
    <span className="fsl-tile-head">
      <strong className="fsl-tile-name">{tile.clientName}</strong>
      <span className="fsl-tile-state">{tile.worst.word}</span>
    </span>
  );
  const opener = clickable ? (
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
  );
  return (
    <li className={`fsl-tile tone-${tile.worst.tone}`} data-client-id={tile.clientId} data-worst={tile.worst.state}>
      {typeof onClose === 'function' ? (
        <div className="fsl-tile-top">
          {opener}
          <button type="button" className="ghost-button fsl-tile-close" aria-label={`Close ${tile.clientName}`} onClick={onClose}>
            Close
          </button>
        </div>
      ) : opener}
      {tile.dots.length ? (
        <ol className="account-pills fsl-pills" aria-label={`${tile.clientName} accounts`}>
          {tile.dots.map((dot) => (
            <AccountPill
              key={dot.accountName}
              pill={withCloseDiffers(
                withDiffers(withDisconnectedSince(dot, sinceOf(dot)), details.get(dot.accountName)?.differsCount || 0),
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
