import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import {
  accountRunStateCopy,
  classifyAccountTracker,
  summarizeAccountTracker,
} from '../domain/autoCollectionFleet';

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
 */
export default function AccountTrackerPanel({
  clientUuid = '',
  tracker = null,
  device = null,
  accountNames = [],
  api = autoCollectionApi,
  refreshMs = 120_000,
  disableAutoRefresh = false,
  now = () => new Date(),
  defaultDetailsOpen = false,
}) {
  /* THE PICTURE FIRST, THE SENTENCES BEHIND A CLICK. Pedro's words: the tracker
   * is good but there is a lot to read. The strip above the rows is one large
   * dot per account with its name and its state in words under it, and the rows
   * (every sentence kept, because the sentences are what the desk acts on) open
   * on "Details". Nothing is lost; the glance just comes first. */
  const [showDetails, setShowDetails] = useState(defaultDetailsOpen);
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
  const view = useMemo(() => {
    if (!shownTracker) return null;
    const staleSeconds = shownTracker.staleSeconds;
    const samples = Array.isArray(shownTracker.accounts) ? shownTracker.accounts : [];
    const byName = new Map(samples.map((sample) => [sample.accountName, sample]));
    /* The registry's accounts are listed beside the sampled ones, so an account
     * the desk knows about and the VPS has never mentioned is VISIBLE as never
     * sampled rather than simply missing from a list. A row that is only in the
     * sample is kept too: NinjaTrader naming an account the registry does not
     * have is the existing "new account needs classification" flow, and hiding
     * it here would hide the thing that starts it. */
    const names = [...new Set([
      ...samples.map((sample) => sample.accountName),
      ...(accountNames || []).filter(Boolean),
    ])].sort((left, right) => String(left).localeCompare(String(right)));
    const rows = names.map((accountName) => {
      const sample = byName.get(accountName) || null;
      return {
        accountName,
        sample,
        inRegistry: (accountNames || []).includes(accountName),
        verdict: classifyAccountTracker({
          now: at,
          device: shownDevice,
          sample,
          deviceHasSamples: shownTracker.deviceHasSamples === true,
          trackerMinAgentVersion: shownTracker.minAgentVersion,
          staleSeconds,
        }),
      };
    });
    return {
      rows,
      summary: summarizeAccountTracker(samples, { now: at, staleSeconds }),
      intervalMinutes: Math.round((shownTracker.sampleIntervalSeconds || 600) / 60),
      everySampled: samples.length > 0,
      enabled: Boolean(shownTracker.minAgentVersion),
    };
  }, [shownTracker, shownDevice, accountNames, at]);

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
          </span>
        </div>
      </div>

      {view.rows.length ? (
        <>
          <ol className="account-tracker-lights" aria-label="Accounts at a glance">
            {view.rows.map((row) => <TrackerLight key={row.accountName} row={row} />)}
          </ol>
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
        <p className="account-tracker-none">
          No account is registered for this client and none has been sampled.
        </p>
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

/* ONE LARGE DOT, THE NAME, THE STATE IN WORDS. The traffic light Pedro asked
 * for: readable from across the desk, and still never a colour alone. The run
 * state is shown under the same rule as the row: only while the reading is
 * current, because a silent account's last known "running" is a claim about a
 * machine that has stopped answering. */
function TrackerLight({ row }) {
  const { verdict } = row;
  const showsRun = verdict.state === 'live' || verdict.state === 'disconnected';
  const run = showsRun ? accountRunStateCopy(verdict.runState) : null;
  return (
    <li className={`account-tracker-light tracker-${verdict.state}`} title={verdict.detail}>
      <span className="account-tracker-light-dot" aria-hidden="true" />
      <span className="account-tracker-light-name">{row.accountName}</span>
      <span className="account-tracker-light-state">{verdict.label}</span>
      {run ? <span className="account-tracker-light-run" title={run.detail}>{run.label}</span> : null}
    </li>
  );
}

function TrackerRow({ row }) {
  const { verdict, sample } = row;
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
      <span className="account-tracker-state" title={verdict.detail}>{verdict.label}</span>
      {run ? <span className={`badge ${runTone(run.runState)}`} title={run.detail}>{run.label}</span> : null}
      {total ? (
        <span className={sample.totalPnl >= 0 ? 'positive' : 'negative'} title="Realized plus unrealized, as of this row's own sample.">
          {total}
        </span>
      ) : (
        <span className="account-tracker-absent" title="This sample carried no profit and loss figure. Not measured - not zero.">
          no figure
        </span>
      )}
      {/* The age, on the row, because the rows disagree. */}
      <span className="account-tracker-age">
        {verdict.sampledAt
          ? <time dateTime={verdict.sampledAt}>{agedLabel(verdict.ageMinutes)}</time>
          : <span className="account-tracker-absent">never</span>}
      </span>
      <span className="account-tracker-detail">{verdict.detail}</span>
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
  if (!Number.isInteger(minutes)) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
