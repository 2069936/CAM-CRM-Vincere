import { money } from '../domain/accountLiveDetail';
import { agedWords } from '../domain/fleetStatusLights';

/**
 * WHAT ONE ACCOUNT IS RUNNING, under its pill.
 *
 * Pedro's words: this client has these connections, under them these accounts,
 * and these accounts have done this. This is the account layer: the connection,
 * the totals the account sample measured (realized, open, total, strategies
 * loaded and enabled, when it was sampled), then one row per strategy instance
 * from algorithm_live_samples with its own three figures, a restart note when
 * NinjaTrader restarted it, and how it sits against the desk.
 *
 * EVERYTHING HERE IS SAID BY THE DOMAIN. buildAccountLiveDetail decides the
 * figures, the sentences and the "differs" verdict (which is
 * algorithmLiveComparison's rule, not a new one); this component only prints
 * them. An instance that differs carries an amber chip and its sentence; the
 * chip is never red, because "differs" is a question about where to look.
 *
 * FOUR STATES FOR THE ROWS, each its own sentence: still reading, could not
 * read (inside the detail, never a banner), step 57 not run, nothing sampled
 * for this account. A failed refresh with an older answer on screen says so in
 * a muted line and keeps the answer.
 *
 * Takes the view and the read state; it reads nothing itself, so the Manager
 * breakdown can render it from whatever it has loaded.
 */
export default function AccountLiveDetail({ view, reading = false, error = null, id = undefined }) {
  const totals = view.totals;
  return (
    <div className="account-live-detail" id={id} role="region" aria-label={`${view.accountName}, what it is running`}>
      <div className="account-live-detail-head">
        <strong>{view.accountName}</strong>
        <span className={`account-live-detail-connection${view.connectionName ? '' : ' absent'}`}>
          {view.connectionName ? `Connection ${view.connectionName}` : view.connectionWord}
        </span>
        {view.differsWords ? <span className="badge warning account-live-detail-differs">{view.differsWords}</span> : null}
      </div>

      {totals ? (
        <dl className="account-live-detail-totals">
          <Figure label="Realized" value={totals.realized} />
          <Figure label="Unrealized" value={totals.unrealized} />
          <Figure label="Total" value={totals.total} title="Realized plus unrealized, as of this account's own sample." />
          <div>
            <dt>Strategies</dt>
            <dd>{totals.strategiesWords}</dd>
          </div>
          <div>
            <dt>Sampled</dt>
            <dd>
              {totals.sampledAt
                ? <time dateTime={totals.sampledAt}>{`${totals.sampledClock}, ${agedWords(totals.ageMinutes)}`}</time>
                : <span className="account-live-detail-absent">never</span>}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="account-live-detail-none">No account sample has arrived for this account.</p>
      )}

      <Strategies view={view} reading={reading} error={error} />
    </div>
  );
}

function Figure({ label, value, title }) {
  const text = money(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd title={title}>
        {text === null
          ? <span className="account-live-detail-absent" title="This sample carried no figure. Not measured, not zero.">not measured</span>
          : <span className={value >= 0 ? 'positive' : 'negative'}>{text}</span>}
      </dd>
    </div>
  );
}

function Strategies({ view, reading, error }) {
  if (view.strategiesState === 'unread') {
    if (error) return <p className="account-live-detail-failed" role="status">Could not read what is running.</p>;
    return <p className="account-live-detail-reading" role="status">{reading ? 'Reading what is running.' : 'What is running has not been read yet.'}</p>;
  }
  if (view.strategiesState === 'not_deployed') {
    return <p className="account-live-detail-empty">Per strategy readings are not available on this CRM yet. Migration step 57 has not been run.</p>;
  }
  if (view.strategiesState === 'empty') {
    return (
      <>
        <p className="account-live-detail-empty">No strategy reading for this account yet.</p>
        {error ? <p className="account-live-detail-failed">Could not refresh what is running.</p> : null}
      </>
    );
  }
  return (
    <>
      <ul className="account-live-detail-strategies" aria-label={`${view.accountName} strategies`}>
        {view.strategies.map((strategy) => <StrategyRow key={strategy.key} strategy={strategy} />)}
      </ul>
      {error ? <p className="account-live-detail-failed">Could not refresh what is running. The rows are the last answer.</p> : null}
    </>
  );
}

function StrategyRow({ strategy }) {
  const { comparison } = strategy;
  return (
    <li
      className={`account-live-strategy status-${comparison.status}${comparison.differs ? ' differs' : ''}`}
      data-algorithm={strategy.algorithm}
    >
      <span className="account-live-strategy-name">
        {strategy.algorithm}
        {' '}
        <span className="account-live-strategy-instrument">{strategy.instrument || strategy.instrumentRoot}</span>
        {strategy.strategyName ? <span className="account-live-strategy-instance">{strategy.strategyName}</span> : null}
      </span>
      <Money label="realized" value={strategy.realized} />
      <Money label="open" value={strategy.unrealized} />
      <Money label="total" value={strategy.total} strong />
      {/* Which way it fired, the contracts and the trades (step 64, agent
          1.2.1). A reading that carried none says nothing here: null is not
          read, never flat. */}
      {strategy.positionWords ? (
        <span className="account-live-strategy-position" title="Market position, contracts held and trades this run, as the agent read them off the strategy.">
          {strategy.positionWords}
        </span>
      ) : null}
      {comparison.differs ? (
        <span className="badge warning account-live-strategy-differs">Differs from the desk</span>
      ) : null}
      <span className="account-live-strategy-words">
        {comparison.sentence}
        {/* The comparison sentence already names the restart when that is why
            the row is not compared; the note is added only when it does not. */}
        {strategy.restartNote && comparison.status !== 'restarted' ? ` ${strategy.restartNote}` : ''}
      </span>
    </li>
  );
}

function Money({ label, value, strong = false }) {
  const text = money(value);
  const className = `account-live-strategy-figure${strong ? ' strong' : ''}`;
  if (text === null) {
    return <span className={className}><span className="account-live-detail-absent">{`${label} not measured`}</span></span>;
  }
  return (
    <span className={className}>
      <span className="account-live-strategy-figure-label">{label}</span>
      {' '}
      <span className={value >= 0 ? 'positive' : 'negative'}>{text}</span>
    </span>
  );
}
