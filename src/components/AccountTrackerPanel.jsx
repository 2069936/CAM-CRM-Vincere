import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import {
  accountRunStateCopy,
  classifyAccountTracker,
  summarizeAccountTracker,
} from '../domain/autoCollectionFleet';
import { registryLights } from '../domain/accountBuckets';
import { buildAccountPill, withDiffers } from '../domain/accountPill';
import { buildAccountLiveDetail } from '../domain/accountLiveDetail';
import { loadSupabaseAccountObservationSettings, loadSupabaseClientLiveStrategies } from '../domain/supabaseStore';
import AccountPill from './AccountPill';
import AccountLiveDetail from './AccountLiveDetail';
import NotShownLine from './NotShownLine';
import RefreshNote from './RefreshNote';
import useAccountObservationSettings from './useAccountObservationSettings';
import useClientLiveStrategies from './useClientLiveStrategies';

/**
 * WHAT IS HAPPENING NOW, ONE ROW PER ACCOUNT.
 *
 * The daily close answers what happened today, at 16:45. Nothing answered what
 * is happening now, and the desk asks that all morning: which accounts are
 * alive, which are running, and roughly how the day is going. Step 55 keeps the
 * last sample of each account on each paired VPS and this is where a CAM reads
 * it.
 *
 * THE STATE MATTERS MORE THAN THE COLOUR, and that is why every row carries its
 * own sentence rather than a dot and a legend. An account that is disconnected,
 * an account whose VPS cannot be reached, an account whose collector is too old
 * to sample and an account nobody has ever sampled are four different jobs, and
 * a CAM has to be able to tell them apart without leaving this screen. The
 * sentences come from autoCollectionFleet's own STATUS_COPY, so a machine's
 * wording and an account's wording can never drift.
 *
 * THE TIME LIVES ON THE ROW, NEVER IN THE HEADING. The same rule
 * LiveAccountsPanel is built on, and for the same reason: the rows disagree. One
 * account sampled forty seconds ago and one that went silent at 09:40 under a
 * single "as of 11:02" heading would make the second a lie, and a wrong time on
 * a real balance is a number a CAM repeats to a client.
 *
 * TWO ABSENCES THAT ARE NOT THE SAME THING. `tracker === null` means the CRM
 * cannot see the tracker at all - migration step 55 has not been run - and the
 * panel says so and stops. A tracker that is present with no expected build
 * (`minAgentVersion` null) means no collector in the world samples yet, which is
 * the state on the day step 55 is run, and the panel says that instead and
 * claims no fault against the machine.
 *
 * THE STRIP IS A ROW OF PILLS, the same AccountPill the overview tiles render:
 * the dot, the account, the connection, the state in words. Pedro's words: this
 * one says more, keep it everywhere. A click on a pill opens, under the strip,
 * what that account is running: the connection, the totals of its sample, and
 * one row per strategy instance held against the desk (AccountLiveDetail). One
 * open at a time. The strategy rows for this client are read when the panel
 * mounts and refreshed on the same cadence as the tracker, so the amber marker
 * for an algorithm that differs from the desk is on the pill before any click.
 *
 * ONLY THE ACCOUNTS EXPECTED TO TRADE GET A PILL. Pedro's words: dead accounts
 * piled up here as never sampled. The strip takes the registry itself
 * (`accountRegistry`, with what the closes saw of each row, step 65) and
 * lights the accounts the database expects on the close; a new one says "New,
 * not sampled yet"; the rest is one folded line under the pills (NotShownLine)
 * so a CAM can tell a dead account from a new one from a missing one. The
 * plain `accountNames` prop still works and treats every name as expected.
 * new_account_days is read once per session by useAccountObservationSettings.
 */
export default function AccountTrackerPanel({
  clientUuid = '',
  clientName = '',
  tracker = null,
  device = null,
  accountNames = [],
  accountRegistry = null,
  api = autoCollectionApi,
  refreshMs = 120_000,
  disableAutoRefresh = false,
  now = () => new Date(),
  defaultDetailsOpen = false,
  loadStrategies = loadSupabaseClientLiveStrategies,
  loadObservationSettings = loadSupabaseAccountObservationSettings,
}) {
  /* THE PICTURE FIRST, THE SENTENCES BEHIND A CLICK. Pedro's words: the tracker
   * is good but there is a lot to read. The strip above the rows is one pill
   * per account with its name, its connection and its state in words, and the
   * rows (every sentence kept, because the sentences are what the desk acts on)
   * open on "Details". Nothing is lost; the glance just comes first. */
  const [showDetails, setShowDetails] = useState(defaultDetailsOpen);
  const [expanded, setExpanded] = useState(null);
  const detailId = useId();
  /* IT REFRESHES ITSELF, AND IT ASKS FOR NOTHING ELSE.
   *
   * The card around this panel deliberately does NOT reload on a timer: only the
   * POST response carries a pairing code in plaintext, so a reload loses a code
   * the CAM is in the middle of using. Its clock therefore only ticks while that
   * code is counting down, which on a paired client means never - and an age
   * frozen at "4m ago" for an hour is the one thing a tracker cannot do.
   *
   * So this asks the same endpoint again on its own and keeps ONLY the tracker
   * and the device out of the answer, in its own state. The card's `status` is
   * untouched, so nothing it is holding can be lost by a refresh of this.
   *
   * THE CLOCK ADVANCES ONLY ON A SUCCESSFUL READ. Advancing it on a failure
   * would age the last reading until the panel reported Silent about a machine
   * that is sampling perfectly well and a CRM that simply could not be reached -
   * inventing a fault on the desk's side out of a fault on ours. A frozen age is
   * a worse number; a fabricated fault is a worse morning. */
  const [fresh, setFresh] = useState(null);
  const [clock, setClock] = useState(() => (typeof now === 'function' ? now() : now));
  const seeded = useRef(tracker);
  // A new tracker from the card (a client change, a manual retry) wins over
  // whatever this panel last fetched for the previous one.
  if (seeded.current !== tracker) {
    seeded.current = tracker;
    if (fresh) setFresh(null);
  }
  useEffect(() => {
    if (!clientUuid || disableAutoRefresh || !(refreshMs > 0)) return undefined;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const body = await api.loadStatus(clientUuid);
        if (!live) return;
        setFresh({ tracker: body?.accountTracker ?? null, device: body?.device ?? null });
        setClock(new Date());
      } catch {
        // Silence. The card reports its own failures in its own words.
      }
    }, refreshMs);
    return () => { live = false; clearInterval(timer); };
  }, [api, clientUuid, disableAutoRefresh, refreshMs]);

  const shownTracker = fresh ? fresh.tracker : tracker;
  const shownDevice = fresh ? fresh.device : device;
  const at = clock;
  /* What this client is running, for the detail under a pill and the amber
   * marker on it. One select per client, cached by the hook; read once here
   * when refreshing is off (the tests' and the card's quiet mode). */
  const strategies = useClientLiveStrategies(clientUuid, {
    active: Boolean(clientUuid) && Boolean(shownTracker),
    refreshMs: disableAutoRefresh ? 0 : refreshMs,
    load: loadStrategies,
  });
  const client = useMemo(() => ({ id: clientUuid, uuid: clientUuid, name: clientName || clientUuid }), [clientUuid, clientName]);
  /* new_account_days, read once per session; null until read means the defaults. */
  const observation = useAccountObservationSettings({ enabled: Boolean(shownTracker), load: loadObservationSettings });
  const view = useMemo(() => {
    if (!shownTracker) return null;
    const staleSeconds = shownTracker.staleSeconds;
    const samples = Array.isArray(shownTracker.accounts) ? shownTracker.accounts : [];
    const byName = new Map(samples.map((sample) => [sample.accountName, sample]));
    /* The registry's EXPECTED accounts are listed beside the sampled ones, so an
     * account the desk knows about and the VPS has never mentioned is VISIBLE as
     * never sampled rather than simply missing from a list; what the close has
     * hidden (looks failed, gone, never seen, retired) is the folded line under
     * the pills. A row that is only in the sample is kept too: NinjaTrader
     * naming an account the registry does not have is the existing "new account
     * needs classification" flow, and hiding it here would hide the thing that
     * starts it; and a sampled account the close hid keeps its pill as well. */
    const registry = accountRegistry && typeof accountRegistry === 'object'
      ? accountRegistry
      : Object.fromEntries((accountNames || []).filter(Boolean).map((name) => [name, {}]));
    const sampledNames = samples.map((sample) => sample.accountName);
    const lights = registryLights(registry, { now: at, settings: observation.settings, sampled: sampledNames });
    const names = [...new Set([...sampledNames, ...lights.names])]
      .sort((left, right) => String(left).localeCompare(String(right)));
    const rows = names.map((accountName) => {
      const sample = byName.get(accountName) || null;
      const inRegistry = Object.prototype.hasOwnProperty.call(registry, accountName);
      const verdict = classifyAccountTracker({
        now: at,
        device: shownDevice,
        sample,
        deviceHasSamples: shownTracker.deviceHasSamples === true,
        trackerMinAgentVersion: shownTracker.minAgentVersion,
        staleSeconds,
      });
      return {
        accountName,
        sample,
        inRegistry,
        verdict,
        // sampleOnly false: this screen has the device, so the verdict's own
        // never_sampled sentence (which names the VPS) is the true one here.
        pill: buildAccountPill({
          accountName, sample, verdict, inRegistry, sampleOnly: false,
          isNew: lights.fresh.has(accountName), newWords: lights.fresh.get(accountName) || null,
        }),
      };
    });
    return {
      rows,
      notShown: lights.notShown,
      summary: summarizeAccountTracker(samples, { now: at, staleSeconds }),
      intervalMinutes: Math.round((shownTracker.sampleIntervalSeconds || 600) / 60),
      everySampled: samples.length > 0,
      enabled: Boolean(shownTracker.minAgentVersion),
    };
  }, [shownTracker, shownDevice, accountNames, accountRegistry, observation.settings, at]);
  const details = useMemo(() => new Map((view?.rows || []).map((row) => [
    row.accountName,
    buildAccountLiveDetail({ client, accountName: row.accountName, sample: row.sample, strategies: strategies.data, now: at }),
  ])), [view, client, strategies.data, at]);
  const openRow = expanded && view ? view.rows.find((row) => row.accountName === expanded) || null : null;

  if (!shownTracker) {
    return (
      <div className="account-tracker empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>Live account tracking is not available on this CRM yet.</strong>
          <span>Migration step 55 has not been run, so nothing is being recorded between closes.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="account-tracker" role="region" aria-label="Live account tracking">
      <div className="account-tracker-head">
        <Activity size={14} aria-hidden="true" />
        <div>
          <strong>
            Live accounts
            {view.everySampled ? ` · ${headline(view.summary)}` : ''}
          </strong>
          {/* THREE SENTENCES, BECAUSE THERE ARE THREE STATES AND THE MIDDLE ONE
              USED TO BE MISSING. With no build named AND nothing sampled, the
              panel says so and claims no fault - that is the day step 55 is run.
              With a build named, it says the cadence. The third case is a machine
              that is sampling before anybody has named a build, which is exactly
              what happens between installing the sampler and Pedro editing the
              column: the old wording said "nothing below is live" directly above
              rows that said Live and carried money. */}
          <span>
            {view.enabled
              ? `Sampled about every ${view.intervalMinutes} minutes, between the open and the close. The close is unaffected by this.`
              : view.everySampled
                ? 'A collector is already sampling, and no build is named yet. Set account_tracker_settings.min_agent_version to the build that samples, so a machine too old to sample can be told apart from one that simply has not reported.'
                : 'No collector build sends live samples yet, so nothing below is live. Set account_tracker_settings.min_agent_version to the build that does.'}
            {' '}
            <RefreshNote updatedAt={at} refreshMs={disableAutoRefresh ? 0 : refreshMs} />
          </span>
        </div>
      </div>

      {view.rows.length ? (
        <>
          <ol className="account-pills" aria-label="Accounts at a glance">
            {view.rows.map((row) => (
              <AccountPill
                key={row.accountName}
                pill={withDiffers(row.pill, details.get(row.accountName)?.differsCount || 0)}
                expanded={expanded === row.accountName}
                controls={detailId}
                onToggle={() => setExpanded((value) => (value === row.accountName ? null : row.accountName))}
              />
            ))}
          </ol>
          {openRow ? (
            <AccountLiveDetail
              id={detailId}
              view={details.get(openRow.accountName)}
              reading={strategies.reading}
              error={strategies.error}
            />
          ) : null}
          <NotShownLine notShown={view.notShown} label={`${clientName || 'this client'}, accounts not shown`} />
          <button
            type="button"
            className="account-tracker-details-toggle"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails
              ? 'Hide details'
              : `Details (${view.rows.length} account${view.rows.length === 1 ? '' : 's'}, each with its own sentence and time)`}
          </button>
          {showDetails ? (
            <ul className="account-tracker-rows">
              {view.rows.map((row) => <TrackerRow key={row.accountName} row={row} />)}
            </ul>
          ) : null}
        </>
      ) : (
        <>
          <p className="account-tracker-none">
            {view.notShown
              ? 'No account is expected on the close for this client and none has been sampled.'
              : 'No account is registered for this client and none has been sampled.'}
          </p>
          <NotShownLine notShown={view.notShown} label={`${clientName || 'this client'}, accounts not shown`} />
        </>
      )}
    </div>
  );
}

/** The one line the header prints, when there is anything to print it about. */
function headline(summary) {
  const parts = [];
  if (summary.running) parts.push(`${summary.running} running`);
  if (summary.idle) parts.push(`${summary.idle} all off`);
  if (summary.no_strategies) parts.push(`${summary.no_strategies} with nothing loaded`);
  if (summary.unmeasured) parts.push(`${summary.unmeasured} not measured`);
  if (summary.disconnected) parts.push(`${summary.disconnected} disconnected`);
  if (summary.silent) parts.push(`${summary.silent} silent`);
  return parts.join(', ');
}

/* Money is printed only when it was measured, and the figure never stands in for
 * a number that was not sent. `Number(null)` is 0, and a confident "$0" about
 * something nobody reported is the exact failure liveAccounts.js exists to stop. */
function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function TrackerRow({ row }) {
  const { verdict, sample, pill } = row;
  const total = money(sample?.totalPnl);
  /* The run state is shown only while the reading is current. A silent account's
   * last known "running" is a claim about a machine that has stopped answering,
   * and the desk would read it as now. */
  const showsRun = verdict.state === 'live' || verdict.state === 'disconnected';
  const run = showsRun ? accountRunStateCopy(verdict.runState) : null;
  return (
    <li className={`account-tracker-row tracker-${verdict.state}`}>
      <span className="account-tracker-dot" aria-hidden="true" />
      <span className="account-tracker-name">
        {row.accountName}
        {row.inRegistry ? null : (
          <abbr title="NinjaTrader reported this account and the registry does not have it yet.">
            {' '}
            new
          </abbr>
        )}
      </span>
      {/* THE STATE IS WRITTEN OUT IN WORDS, never carried by the dot alone. The
          existing strategy chips encode enabled in a colour class and nothing
          else, which is colour-only encoding of the most important bit on the
          panel. */}
      <span className="account-tracker-state" title={pill.detail}>{pill.label}</span>
      {run ? <span className={`badge ${runTone(run.runState)}`} title={run.detail}>{run.label}</span> : null}
      {total ? (
        <span className={sample.totalPnl >= 0 ? 'positive' : 'negative'} title="Realized plus unrealized, as of this row's own sample.">
          {total}
        </span>
      ) : (
        <span className="account-tracker-absent" title="This sample carried no profit and loss figure. Not measured, not zero.">
          no figure
        </span>
      )}
      {/* The age, on the row, because the rows disagree. */}
      <span className="account-tracker-age">
        {verdict.sampledAt
          ? <time dateTime={verdict.sampledAt}>{agedLabel(verdict.ageMinutes)}</time>
          : <span className="account-tracker-absent">never</span>}
      </span>
      {/* The pill's words: the verdict's, or the new account's sentence in front of them. */}
      <span className="account-tracker-detail">{pill.detail}</span>
    </li>
  );
}

/* `no_strategies` IS MUTED AND `unmeasured` IS NOT, which is the difference the
 * fourth run state exists for. "The VPS looked and there is nothing loaded" is an
 * ordinary morning; "the sample carried no count" is a reading the desk did not
 * get, and the only one of the four worth a second look. */
function runTone(runState) {
  if (runState === 'running') return 'success';
  if (runState === 'idle' || runState === 'no_strategies') return 'muted';
  return 'warning';
}

function agedLabel(minutes) {
  if (!Number.isInteger(minutes)) return 'unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
