import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSupabaseAlgorithmLive } from '../domain/supabaseStore';
import {
  buildAlgorithmLiveComparison,
  configIndexFromOutliers,
  cycleClock,
  previousReviewNote,
  reviewNoteText,
} from '../domain/algorithmLiveComparison';
import {
  buildDeskConfigOutliers,
  deskConfigDayFor,
  deskDayImportIds,
} from '../domain/deskConfigOutliers';

/**
 * The first agent and add-on build that sends per strategy readings. It matches
 * the version bump in the collector's csproj files and is only ever printed: the
 * panel decides from the data whether readings exist, never from a version.
 */
export const LIVE_STRATEGY_SAMPLE_VERSION = '1.2.0';

/**
 * EACH ALGORITHM TODAY, AGAINST THE DESK.
 *
 * Pedro's question, in his words: if OGX is at -500 on the desk, is any client
 * at -1200 instead, and what configuration does that client run. The figures
 * come from step 57 and buildAlgorithmLiveComparison, and every rule that
 * matters lives there: the same cycle for desk and client, the floor, the
 * refusal to rank a thin cohort, null as "not measured". This component only
 * says it.
 *
 * IT LOADS ONLY WHILE IT IS OPEN. CollapsiblePanel renders its children only
 * when expanded, so this mounts on expand, reads, refreshes every two minutes,
 * and stops when the panel is collapsed.
 *
 * THE WORDS. "Differs", never a verdict. The list at the top is questions about
 * where to look. No figure ever reads $0 for something nobody measured.
 */
export default function AlgorithmLivePanel({
  clients = [],
  configClients = null,
  isManager = false,
  camName = '',
  onNeedParameters = null,
  onSelectClient = null,
  onLogClientActivity = null,
  onAddClientTask = null,
  load = loadSupabaseAlgorithmLive,
  refreshMs = 120_000,
  now = () => new Date(),
}) {
  const clientIds = useMemo(
    () => (clients || []).map((client) => client?.id).filter(Boolean).sort(),
    [clients],
  );
  const scopeKey = clientIds.join(',');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(true);
  const [clock, setClock] = useState(() => now());

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    async function read() {
      try {
        const result = await load({ clientIds: scopeKey ? scopeKey.split(',') : [] });
        if (!live) return;
        /* While the newest cycle fills, keep the last complete one on screen and
         * say a newer one is coming, rather than blanking a screen somebody is
         * reading. The previous read's rows go with it, so desk and accounts are
         * still from one cycle. */
        setData((previous) => {
          const filling = result?.available && result.desk?.filling;
          const previousComplete = previous?.available && previous.desk?.cycleStart && !previous.desk.filling;
          if (filling && previousComplete) return { ...previous, fillingCycleStart: result.desk.cycleStart };
          return result;
        });
        setError('');
      } catch (failure) {
        if (live) setError(String(failure?.message || failure || 'failed'));
      } finally {
        if (live) {
          setReading(false);
          setClock(now());
        }
      }
    }
    read();
    const timer = refreshMs ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
    // `now` is a clock, not a dependency: a new function each render must not
    // turn the two minute refresh into a refresh every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, scopeKey, refreshMs, attempt]);

  /* THE SETTINGS BESIDE THE NUMBER come from a close, through the same desk
   * comparison the manager's configuration panel uses. For a CAM the consensus
   * is the CAM's own book, and the copy says so; for a manager, the desk. */
  const sourceClients = configClients || clients;
  const configDay = useMemo(() => deskConfigDayFor(sourceClients), [sourceClients]);
  const configIds = useMemo(() => deskDayImportIds(sourceClients, configDay), [sourceClients, configDay]);
  const configKey = configIds.join(',');
  useEffect(() => {
    if (onNeedParameters && configIds.length) onNeedParameters('algorithm-live', configIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNeedParameters, configKey]);
  const configScope = isManager ? 'desk' : 'book';
  const configFor = useMemo(() => {
    if (!configDay) return null;
    return configIndexFromOutliers(buildDeskConfigOutliers(sourceClients, { date: configDay }), { scope: configScope });
  }, [sourceClients, configDay, configScope]);

  const comparison = useMemo(() => {
    if (!data) return null;
    if (data.available === false) {
      return { state: data.reason === 'not_configured' ? 'not_configured' : 'not_deployed' };
    }
    return buildAlgorithmLiveComparison({
      desk: data.desk,
      rows: data.rows,
      settings: data.settings,
      clients,
      configFor,
      now: clock,
    });
  }, [data, clients, configFor, clock]);

  const shown = comparison;

  const clientById = useMemo(
    () => new Map((clients || []).filter(Boolean).map((client) => [client.id, client])),
    [clients],
  );

  if (error && !shown) {
    return (
      <div className="algorithm-live" role="alert">
        <p>Could not read the live comparison.</p>
        <button type="button" className="ghost-button" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!shown) {
    return <p className="algorithm-live muted" role="status">{reading ? 'Reading the live comparison.' : ''}</p>;
  }

  const empty = emptyStateCopy(shown);
  if (empty) {
    return (
      <div className="algorithm-live" role="status">
        <p>{empty}</p>
      </div>
    );
  }

  const settings = shown.settings;
  const scopeIsDesk = (shown.scope || (isManager ? 'desk' : 'rest_of_desk')) === 'desk';
  const cycle = cycleClock(shown.cycleStart);
  const stale = shown.cycleAgeSeconds > 2 * (settings.cycleSeconds || 600);

  return (
    <div className="algorithm-live" role="region" aria-label="Each algorithm today, against the desk">
      <div className="algorithm-live-head">
        <span className="badge muted">
          {scopeIsDesk
            ? `${camName ? `${camName}'s book` : 'This book'} against the whole desk · cycle ${cycle}`
            : `Your book against the rest of the desk · cycle ${cycle}`}
        </span>
        <p className="muted">
          {scopeIsDesk
            ? 'The desk figure counts every client on the desk.'
            : 'The desk figure leaves out your own clients, so it is the rest of the desk.'}
          {' '}{`Realized plus open, as the Strategies tab shows it, read on the same ${cycleWords(settings.cycleSeconds)} cycle for everyone.`}
          {settings.fallback ? ' The floors below are the defaults, because the settings could not be read.' : ''}
        </p>
        {stale ? (
          <p className="muted">
            {`Last cycle with readings: ${cycle}, ${ageWords(shown.cycleAgeSeconds)} ago. Strategies are switched off after the close, so the comparison stops there.`}
          </p>
        ) : null}
        {data?.fillingCycleStart ? (
          <p className="muted">{`The ${cycleClock(data.fillingCycleStart)} cycle is still coming in, so this shows the last complete one.`}</p>
        ) : null}
        {error ? (
          <p className="muted">
            Could not refresh the live comparison.
            {' '}
            <button type="button" className="ghost-button" onClick={retry}>Try again</button>
          </p>
        ) : null}
      </div>

      {shown.toVerify.length ? (
        <section className="algorithm-live-verify" aria-label="Worth a look">
          <h4>Worth a look</h4>
          <p className="muted">These are questions about where to look, not faults. An account can differ on purpose.</p>
          <ul>
            {shown.toVerify.map((account) => (
              <li key={`${account.clientId}|${account.accountName}|${account.algorithm}|${account.instrumentRoot}`}>
                {`${account.clientName} / ${account.accountName} · ${account.algorithm} ${account.instrumentRoot} · ${differsWords(account)}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {shown.algorithms.map((entry) => (
        <section className="algorithm-live-algorithm" key={`${entry.algorithm}|${entry.instrumentRoot}`}>
          <h4>{`${entry.algorithm} ${entry.instrumentRoot}`}</h4>
          <p className="algorithm-live-desk">{deskWords(entry, { settings, scopeIsDesk })}</p>
          {entry.alsoOn.length ? (
            <p className="muted">{`Also runs on ${entry.alsoOn.join(', ')}, compared separately.`}</p>
          ) : null}
          {entry.accounts.length ? (
            <ul className="algorithm-live-accounts">
              {entry.accounts.map((account) => (
                <AccountRow
                  key={`${account.clientId}|${account.accountName}`}
                  account={account}
                  entry={entry}
                  cycleStart={shown.cycleStart}
                  scopeIsDesk={scopeIsDesk}
                  client={clientById.get(account.clientId)}
                  onSelectClient={onSelectClient}
                  onLogClientActivity={onLogClientActivity}
                  onAddClientTask={onAddClientTask}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function emptyStateCopy(comparison) {
  switch (comparison.state) {
    case 'not_configured':
      return 'The live comparison reads the database, and this session has none.';
    case 'not_deployed':
      return 'Migration step 57 has not been run, so there is nothing to compare yet.';
    case 'no_readings':
      return `No machine has sent per strategy readings yet. They start once a VPS runs agent and add-on ${LIVE_STRATEGY_SAMPLE_VERSION}.`;
    case 'no_complete_cycle':
      return 'Waiting for the first complete cycle.';
    case 'cycle_filling':
      return `The ${cycleClock(comparison.cycleStart)} cycle is still coming in. The comparison shows once it is complete.`;
    default:
      return null;
  }
}

/* Whole dollars. Only ever called with a measured number: null never reaches a
 * dollar sign, it reaches "not measured". */
function money(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function ageWords(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/* The cycle is step 55's sample_interval_seconds, 300 to 3600, so the copy
 * names whatever the settings say rather than a fixed ten minutes. */
function cycleWords(seconds) {
  const value = Number(seconds) > 0 ? Number(seconds) : 600;
  return value % 60 === 0 ? `${value / 60} minute` : `${value} second`;
}

function deskWords(entry, { settings, scopeIsDesk }) {
  const desk = entry.desk;
  if (desk.status === 'compared') {
    const base = `Desk median ${money(desk.median)} over ${plural(desk.nAccounts, 'account', 'accounts')} from ${plural(desk.nClients, 'client', 'clients')}.`;
    return desk.mostlyUntraded
      ? `${base} Most of the desk has not traded it yet in this cycle, so the median says little.`
      : base;
  }
  const where = scopeIsDesk ? 'on the desk' : 'outside your book';
  return `Not compared: fewer than ${plural(settings.minCohortAccounts, 'account', 'accounts')} from ${plural(settings.minCohortClients, 'client', 'clients')} ${where} ran it in this cycle.`;
}

function differsWords(account) {
  return `differs from the desk median by ${money(Math.abs(account.distance))}, ${account.spread} times the usual spread`;
}

function statusWords(account, cycleStart) {
  switch (account.status) {
    case 'restarted':
      return `Restarted at ${cycleClock(account.restartedAt)}, so this counts only since then. Not compared.`;
    case 'unmeasured':
      return 'Not measured, not zero.';
    case 'off_cycle':
    case 'not_in_cycle':
      return `Last read at ${cycleClock(account.sampledAt)}, outside the ${cycleClock(cycleStart)} cycle. Not compared.`;
    case 'cohort_thin':
      return 'Not compared: the desk figure for this algorithm is too thin.';
    default:
      return null;
  }
}

function configWords(config, scopeIsDesk) {
  if (!config) return null;
  if (config.reason === 'no_close') return `No close on ${config.date} to read its settings from.`;
  if (config.reason === 'not_on_close') return `Its close on ${config.date} does not show this algorithm, so there are no settings to read.`;
  const consensus = config.scope === 'desk' || scopeIsDesk ? 'the desk' : 'your book';
  const lines = [...(config.differing || []), ...(config.sizing || [])];
  if (!lines.length) {
    return config.measured
      ? `Settings on the ${config.date} close match ${consensus}.`
      : `Settings on the ${config.date} close: too few accounts to compare.`;
  }
  const parts = lines.map((line) => {
    const mine = line.account ?? 'not set';
    const theirs = line.consensus ?? 'not set';
    return `${line.field} differs (this account ${mine}, ${consensus} ${theirs}, ${line.countText})`;
  });
  return `Settings on the ${config.date} close: ${parts.join('; ')}`;
}

function AccountRow({
  account,
  entry,
  cycleStart,
  scopeIsDesk,
  client,
  onSelectClient,
  onLogClientActivity,
  onAddClientTask,
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const previous = previousReviewNote(client, account);
  const status = statusWords(account, cycleStart);
  const config = configWords(account.config, scopeIsDesk);
  const text = (extra) => reviewNoteText({ account, desk: entry.desk, cycleStart, note: extra });

  return (
    <li className={`algorithm-live-account status-${account.status}`}>
      <div className="algorithm-live-account-line">
        <strong>{`${account.clientName} / ${account.accountName}`}</strong>
        {account.value === null ? (
          <span className="algorithm-live-absent">not measured</span>
        ) : (
          <span className={account.value >= 0 ? 'positive' : 'negative'}>
            {money(account.value)}
          </span>
        )}
        {account.value !== null ? (
          <span className="muted">{`realized ${money(account.realized)}, open ${money(account.unrealized)}`}</span>
        ) : null}
        {entry.desk.status === 'compared' ? (
          <span className="badge muted">{`desk n ${entry.desk.nAccounts}`}</span>
        ) : (
          <span className="badge muted">desk not compared</span>
        )}
      </div>
      {account.status === 'compared' ? (
        <p>
          {account.differs
            ? `Differs from the desk by ${money(Math.abs(account.distance))}, ${account.spread} times the usual spread.`
            : `Within the usual spread of the desk (${account.spread} times).`}
        </p>
      ) : null}
      {status ? <p className="muted">{status}</p> : null}
      {config ? <p className="muted">{config}</p> : null}
      {account.instances.length ? (
        <p className="muted">{account.instances.map((i) => `${i.strategyName} on ${i.instrument}`).join(', ')}</p>
      ) : null}
      {previous ? (
        <p className="algorithm-live-previous">
          {`Last note, ${String(previous.createdAt || '').slice(0, 10)}: ${previous.text}`}
        </p>
      ) : null}
      <div className="algorithm-live-actions">
        {onSelectClient ? (
          <button type="button" className="ghost-button" onClick={() => onSelectClient(account.clientId)}>Open client</button>
        ) : null}
        {onLogClientActivity ? (
          <button type="button" className="ghost-button" onClick={() => setNoting((value) => !value)}>Note what you found</button>
        ) : null}
        {onAddClientTask ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onAddClientTask(account.clientId, {
              id: `task-${Date.now()}-algorithm-live`,
              text: text(''),
              priority: 'Normal',
              dueDate: null,
              done: false,
              createdAt: new Date().toISOString(),
            })}
          >
            Add a follow up task
          </button>
        ) : null}
      </div>
      {noting ? (
        <form
          className="algorithm-live-note"
          onSubmit={(event) => {
            event.preventDefault();
            // NO logDate, NO logPnl: either one turns this note into a point on
            // the client's equity curve.
            onLogClientActivity(account.clientId, {
              id: `act-${Date.now()}-algorithm-live`,
              type: 'Review',
              text: text(note),
              accountName: account.accountName,
              createdAt: new Date().toISOString(),
            });
            setNote('');
            setNoting(false);
          }}
        >
          <textarea
            aria-label="What you found"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
          />
          <button type="submit" className="primary-button">Save note</button>
        </form>
      ) : null}
    </li>
  );
}
