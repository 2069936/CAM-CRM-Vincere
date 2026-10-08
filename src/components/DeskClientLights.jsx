import { useEffect, useId, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { DESK_LEGEND, buildDeskClientLights } from '../domain/deskClientLights';
import { LIVE_SAMPLING_BUILD } from '../domain/fleetStatusLights';
import { withDiffers } from '../domain/accountPill';
import { buildAccountLiveDetail } from '../domain/accountLiveDetail';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';
import { loadSupabaseAccountObservationSettings, loadSupabaseClientLiveStrategies } from '../domain/supabaseStore';
import AccountPill from './AccountPill';
import AccountLiveDetail from './AccountLiveDetail';
import NotShownLine from './NotShownLine';
import RefreshNote from './RefreshNote';
import useAccountObservationSettings from './useAccountObservationSettings';
import useClientLiveStrategies from './useClientLiveStrategies';
import useDeskDevices, { loadDeskDevices } from './useDeskDevices';

/**
 * ONE BULB PER CLIENT, THE MANAGER'S DESK VIEW.
 *
 * Pedro's words: every client's accounts at once is unreadable for the Manager.
 * One light per client: is NinjaTrader up, are the connections active. Amber
 * when some are up and some that should be are not. Click the client for the
 * breakdown: the connections, under each its accounts, under each account what
 * it has been doing. The clients with no VPS are one folded line, not bulbs.
 *
 * THE GRID IS A ROW OF LIGHTS AND NAMES, nothing per account, worst first (off,
 * partly, silent, never sampled, live) and alphabetical inside each group. The
 * state
 * is decided in src/domain/deskClientLights.js from the client's samples, its
 * registry and, when the role can read the fleet, its devices.
 *
 * ONE DRAWER, UNDER THE GRID. A bulb is a button with aria-expanded; the open
 * one points at the drawer with aria-controls. The drawer prints the client's
 * sentence, then one section per connection ("Bluesky, 3 of 4 connected") with
 * builder 1's account pills under it, and a pill opens builder 1's detail with
 * the strategy rows and the money. One drawer at a time, one account open in
 * it; the open bulb, Escape or Close shut it. The strategies for the open
 * client are read on demand and cached per client, so the amber markers stay.
 *
 * EVERY COLOUR HAS WORDS BESIDE IT: the legend, a visually hidden state word on
 * each bulb, the sentence in each bulb's title and in the drawer. Red is the
 * off bulb and nothing else.
 *
 * WHERE THE DEVICES COME FROM, SAID OUT LOUD. The fleet route is Manager only;
 * the line under the summary says whether the lights include VPS health or
 * come from the samples and the registry alone.
 *
 * ONLY THE ACCOUNTS EXPECTED TO TRADE ARE IN THE DRAWER. The registry says
 * what the closes saw of each account (step 65); the never sampled group holds
 * the expected ones nobody has sampled, a new one saying so, and the rest of
 * the registry is one folded line at the bottom of the drawer (NotShownLine).
 * new_account_days is read once per session by useAccountObservationSettings.
 */
const SOURCE_WORDS = Object.freeze({
  readable: 'VPS health from the collector fleet.',
  reading: 'Reading VPS health from the collector fleet.',
  refused: 'VPS health is not readable for this role, so the lights come from the samples and the registry alone.',
  failed: 'Could not read VPS health, so the lights come from the samples and the registry alone.',
  stale: 'The last fleet read failed; the VPS states are from the previous read.',
});

function sourceWords(deviceAware, fleet, view) {
  if (!deviceAware || fleet.devices?.available === false) return SOURCE_WORDS.refused;
  if (view.deviceAware) return fleet.error ? `${SOURCE_WORDS.readable} ${SOURCE_WORDS.stale}` : SOURCE_WORDS.readable;
  if (fleet.reading) return SOURCE_WORDS.reading;
  return SOURCE_WORDS.failed;
}

export default function DeskClientLights({
  clients = [],
  tracker = null,
  now = null,
  onSelectClient = null,
  refreshMs = LIVE_REFRESH_MS,
  deviceAware = true,
  loadDevices = loadDeskDevices,
  loadStrategies = loadSupabaseClientLiveStrategies,
  loadObservationSettings = loadSupabaseAccountObservationSettings,
}) {
  // The clock is the caller's (the tracker hook moves it on every successful
  // read); a caller without one gets the mount time, held.
  const [mountedAt] = useState(() => Date.now());
  const at = now ?? mountedAt;
  const trackerReady = Boolean(tracker && tracker.available !== false);
  const fleet = useDeskDevices({ enabled: deviceAware && trackerReady, refreshMs, load: loadDevices });
  const observation = useAccountObservationSettings({ enabled: trackerReady, load: loadObservationSettings });
  const view = useMemo(
    () => buildDeskClientLights({ clients, tracker, devices: fleet.devices, now: at, settings: observation.settings }),
    [clients, tracker, fleet.devices, at, observation.settings],
  );
  const clientsById = useMemo(() => {
    const map = new Map();
    for (const client of clients || []) if (client?.id) map.set(client.id, client);
    return map;
  }, [clients]);

  const [open, setOpen] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const drawerId = useId();
  const detailId = useId();
  const hiddenId = useId();
  const openBulb = open ? view.bulbs.find((bulb) => bulb.clientId === open) || null : null;

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') setOpen(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  /* READ ON DEMAND, PER CLIENT: the strategies of the open client only, cached
   * by the hook so a reopened drawer shows its markers at once. */
  const strategies = useClientLiveStrategies(openBulb?.clientKey || '', {
    active: openBulb !== null,
    refreshMs,
    load: loadStrategies,
  });
  const details = useMemo(() => {
    if (!openBulb) return new Map();
    const client = clientsById.get(openBulb.clientId) || { id: openBulb.clientId, uuid: openBulb.clientKey, name: openBulb.clientName };
    return new Map(openBulb.dots.map((dot) => [
      dot.accountName,
      buildAccountLiveDetail({ client, accountName: dot.accountName, sample: dot.sample, strategies: strategies.data, now: at }),
    ]));
  }, [openBulb, clientsById, strategies.data, at]);

  function toggle(clientId) {
    setExpanded(null);
    setOpen((value) => (value === clientId ? null : clientId));
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
          <strong>No client on this desk to light.</strong>
          <span>Bulbs appear here as clients are added.</span>
        </div>
      </div>
    );
  }

  if (view.kind === 'no_samples') {
    if (fleet.reading) {
      return (
        <div className="fsl-empty" role="status">
          <Activity size={14} aria-hidden="true" />
          <div>
            <strong>Reading the desk.</strong>
            <span>{SOURCE_WORDS.reading}</span>
          </div>
        </div>
      );
    }
    const build = view.minAgentVersion || LIVE_SAMPLING_BUILD;
    return (
      <div className="fsl-empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>No collector sends live samples yet.</strong>
          <span>
            {view.minAgentVersion
              ? `Live sampling needs collector build ${build} or newer on each VPS, and no sample has arrived for any of the ${view.clientsTotal} clients on the desk.`
              : `Live sampling arrives with collector build ${build}. Nothing has sampled for any of the ${view.clientsTotal} clients on the desk, and no build is named in account_tracker_settings.min_agent_version yet.`}
            {view.deviceAware ? ' No VPS is paired with any of them.' : ''}
            {' '}The daily close is unaffected by this.
          </span>
        </div>
      </div>
    );
  }

  const hiddenCount = view.hidden.length;
  return (
    <div className="dcl" role="region" aria-label="Live accounts across the desk">
      <div className="dcl-head">
        <Activity size={14} aria-hidden="true" />
        <p className="dcl-summary">
          {view.words}
          {' '}
          <RefreshNote updatedAt={view.at} refreshMs={refreshMs} />
          {' '}
          <span className="dcl-source">{sourceWords(deviceAware, fleet, view)}</span>
        </p>
      </div>
      <ul className="dcl-legend" aria-label="What the colours mean">
        {DESK_LEGEND.map((entry) => (
          <li key={entry.state} className={`dcl-legend-item tone-${entry.tone}`}>
            <span className="dcl-light" aria-hidden="true" />
            <span>{entry.word}</span>
          </li>
        ))}
        <li className="dcl-legend-item dcl-legend-mark">
          <span className="dcl-light" aria-hidden="true"><span className="account-pill-mark" /></span>
          <span>Amber corner: an algorithm differs from the desk</span>
        </li>
      </ul>
      <ul className="dcl-grid" aria-label="One light per client">
        {view.bulbs.map((bulb) => {
          const isOpen = open === bulb.clientId;
          return (
            <li
              key={bulb.clientId}
              className={`dcl-bulb tone-${bulb.tone}${isOpen ? ' open' : ''}`}
              data-client-id={bulb.clientId}
              data-state={bulb.state}
            >
              <button
                type="button"
                className="dcl-bulb-button"
                aria-expanded={isOpen}
                aria-controls={isOpen ? drawerId : undefined}
                title={bulb.title}
                onClick={() => toggle(bulb.clientId)}
              >
                <span className="dcl-light" aria-hidden="true" />
                <span className="dcl-bulb-name">{bulb.clientName}</span>
                <span className="sr-only">{bulb.word}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {openBulb ? (
        <Drawer
          id={drawerId}
          bulb={openBulb}
          details={details}
          strategies={strategies}
          expanded={expanded}
          detailId={detailId}
          onExpand={(accountName) => setExpanded((value) => (value === accountName ? null : accountName))}
          onClose={() => setOpen(null)}
          onSelectClient={onSelectClient}
        />
      ) : null}
      {hiddenCount ? (
        <div className="dcl-hidden">
          <button
            type="button"
            className="dcl-hidden-toggle"
            aria-expanded={showHidden}
            aria-controls={showHidden ? hiddenId : undefined}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? 'Hide' : 'Show'}
          </button>
          <span className="dcl-hidden-words">{`${hiddenCount} client${hiddenCount === 1 ? '' : 's'} without a VPS paired`}</span>
          {showHidden ? (
            <ul id={hiddenId} className="dcl-hidden-list muted">
              {view.hidden.map((bulb) => <li key={bulb.clientId} title={bulb.sentence}>{bulb.clientName}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Drawer({ id, bulb, details, strategies, expanded, detailId, onExpand, onClose, onSelectClient }) {
  return (
    <div className={`dcl-drawer tone-${bulb.tone}`} id={id} role="region" aria-label={`${bulb.clientName}, connections and accounts`}>
      <div className="dcl-drawer-head">
        <span className="dcl-light" aria-hidden="true" />
        <strong className="dcl-drawer-name">{bulb.clientName}</strong>
        <span className="dcl-drawer-sentence">{bulb.sentence}</span>
        <span className="dcl-drawer-actions">
          {typeof onSelectClient === 'function' ? (
            <button type="button" className="ghost-button dcl-drawer-open" onClick={() => onSelectClient(bulb.clientId)}>Open client</button>
          ) : null}
          <button type="button" className="ghost-button dcl-drawer-close" aria-label={`Close ${bulb.clientName}`} onClick={onClose}>Close</button>
        </span>
      </div>
      {bulb.connections.length ? (
        <ul className="dcl-connections">
          {bulb.connections.map((group) => {
            const openHere = expanded && group.accounts.some((pill) => pill.accountName === expanded);
            return (
              <li key={group.key} className={`dcl-connection${group.neverSampled ? ' never' : ''}`} data-connection={group.name}>
                <div className="dcl-connection-head">
                  <strong className={`dcl-connection-name${group.hasName ? '' : ' absent'}`}>{group.name}</strong>
                  <span className="dcl-connection-words">{group.words}</span>
                </div>
                <ol className="account-pills dcl-pills" aria-label={`${bulb.clientName}, ${group.name} accounts`}>
                  {group.accounts.map((pill) => (
                    <AccountPill
                      key={pill.accountName}
                      pill={withDiffers(pill, details.get(pill.accountName)?.differsCount || 0)}
                      expanded={expanded === pill.accountName}
                      controls={detailId}
                      onToggle={() => onExpand(pill.accountName)}
                    />
                  ))}
                </ol>
                {openHere ? (
                  <AccountLiveDetail
                    id={detailId}
                    view={details.get(expanded)}
                    reading={strategies.reading}
                    error={strategies.error}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="dcl-drawer-empty">No account sampled and none expected on the registry.</p>
      )}
      <NotShownLine notShown={bulb.notShown} label={`${bulb.clientName}, accounts not shown`} />
    </div>
  );
}
