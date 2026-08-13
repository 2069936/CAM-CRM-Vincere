import { useMemo } from 'react';
import { buildLiveAccounts, buildLiveBook, bookLatestDateOf } from '../domain/liveAccounts';

/**
 * What is running, how it ran, and in which group.
 *
 * The date lives on the ROW, never in the heading. That is the whole point of
 * this panel. The client workspace pins one date — seeded from the wall clock —
 * and on this book that date has a close for 0 of 96 clients, so the screen
 * reads "you have not uploaded" when the truth is "the last close was 12 days
 * ago". Falling back to the latest close without saying which one would be
 * worse: 220 of 685 accounts last reported 1 to 17 days before their own
 * client's most recent close, and one client here (Gray Elm) has 18 accounts
 * spread across 8 different as-of dates. A single header date would be wrong
 * for most of them, and a wrong date on a real balance is a number a CAM
 * repeats to a client.
 *
 * Enabled is written out in words. The existing strategy chips encode it in a
 * colour class alone (`.strategy` grey vs `.strategy.enabled` green), which is
 * colour-only encoding of the single most important bit on the panel.
 *
 * Nothing here consults today's date.
 */
export default function LiveAccountsPanel({ client = null, clients = [], asOfDate = '' }) {
  const view = useMemo(() => {
    if (client) {
      return {
        book: false,
        views: [buildLiveAccounts(client, {
          asOfDate,
          // A single client still gets the desk yardstick when the book is
          // handed in, so "17 days behind everyone else" stays visible.
          bookLatestDate: clients.length ? bookLatestDateOf(clients, asOfDate) : null,
        })],
      };
    }
    const built = buildLiveBook(clients, { asOfDate });
    return { book: true, built, views: built.clients.filter((entry) => entry.accounts.length || entry.retiredCount) };
  }, [client, clients, asOfDate]);

  if (!view.views.length) {
    return <p className="muted chart-empty">No accounts on file.</p>;
  }

  return (
    <div className="drift-panel">
      {view.book ? <BookIntro built={view.built} /> : null}
      {view.views.map((entry) => (
        <ClientBlock key={entry.clientId || entry.clientName} view={entry} showClientName={view.book} />
      ))}
    </div>
  );
}

function BookIntro({ built }) {
  const { totals } = built;
  return (
    <>
      <p className="drift-intro">
        <strong>{totals.runningOnLatestClose}</strong> of {totals.accounts} account
        {totals.accounts === 1 ? '' : 's'} were running at least one enabled strategy on their own
        client&apos;s most recent close.{' '}
        {totals.runningBehindLatestClose ? (
          <strong>
            {totals.runningBehindLatestClose} more were running as of an older close and have not
            reported since
          </strong>
        ) : null}
        {totals.runningBehindLatestClose ? ', ' : ''}
        {totals.idle} have every strategy switched off, and{' '}
        <span title="These accounts reported a balance but no strategy row came with the close. Nobody looked — it is not a reading of zero.">
          {totals.unmeasured} sent no strategy data at all
        </span>{'. '}
      </p>
      <p className="drift-ask">
        Most recent close on the desk is <strong>{built.bookLatestDate || 'none'}</strong>, but each
        account is shown as of the last close <em>it</em> appeared in — {totals.reporting} are on
        their client&apos;s most recent close, {totals.behind} are behind it and{' '}
        {totals.neverReported} have never reported. {built.clientsWithoutClose} client
        {built.clientsWithoutClose === 1 ? ' has' : 's have'} no close on file at all
        {built.clientsRunningAllStale
          ? `, and on ${built.clientsRunningAllStale} client${built.clientsRunningAllStale === 1 ? '' : 's'} not one running account is on that client's own latest close`
          : ''}
        .
      </p>
      {built.notInRegistry ? (
        <p className="drift-ask">
          <span className="muted">
            {totals.accounts + built.retiredCount} rows here against{' '}
            {totals.accounts + built.retiredCount - built.notInRegistry} registry accounts:{' '}
            {built.notInRegistry} account{built.notInRegistry === 1 ? '' : 's'} across{' '}
            {built.clientsWithOrphans} client{built.clientsWithOrphans === 1 ? '' : 's'} report under
            a name the registry does not hold. Any count taken from the registry alone will be
            short by exactly those.
          </span>
        </p>
      ) : null}
    </>
  );
}

function ClientBlock({ view, showClientName }) {
  if (!view.latestCloseDate) {
    return (
      <section className="drift-row">
        <div className="drift-head">
          <strong>{view.clientName}</strong>
          <span className="muted">no close on file — {view.accounts.length} account{view.accounts.length === 1 ? '' : 's'} in the registry, none has ever reported</span>
        </div>
        <RetiredBlock view={view} />
      </section>
    );
  }

  return (
    <section className="drift-row">
      <div className="drift-head">
        <strong>{showClientName ? view.clientName : 'Live accounts'}</strong>
        <span className="muted">
          last close {view.latestCloseDate}
          {view.daysBehindBook ? ` — ${view.daysBehindBook} day${view.daysBehindBook === 1 ? '' : 's'} behind the desk` : ''}
        </span>
        {/* Two badges, never one sum. "4 running" beside "last close 2026-07-30"
            is a stale reading wearing a fresh date: on Vale Frost all four of
            those accounts last reported 2026-07-13 and every account that did
            report on the 30th is idle or unmeasured. Seven clients on this book
            have a running count that is entirely stale. */}
        <span
          className="drift-count"
          title={`Enabled strategies on ${view.latestCloseDate}, this client's most recent close.`}
        >
          {view.totals.runningOnLatestClose} running on {view.latestCloseDate}
        </span>
        {view.totals.runningBehindLatestClose ? (
          <span
            className="drift-observed-warn"
            title="These accounts had a strategy enabled the last time they appeared in a close, but they were absent from the client's most recent one. Nothing here says they are running now."
          >
            {view.totals.runningBehindLatestClose} last seen running on an older close
          </span>
        ) : null}
      </div>
      {showClientName ? null : (
      <p className="drift-intro">
        <strong>{view.totals.runningOnLatestClose}</strong> of {view.totals.accounts} account
        {view.totals.accounts === 1 ? '' : 's'} had a strategy enabled on {view.latestCloseDate}
        {view.totals.runningBehindLatestClose ? (
          <>
            {', and '}
            <strong>{view.totals.runningBehindLatestClose}</strong> more were running the last time
            they reported
            {view.runningBehindMaxDays === null
              ? ''
              : `, up to ${view.runningBehindMaxDays} day${view.runningBehindMaxDays === 1 ? '' : 's'} before that close`}
            {' — enabled and then absent, which is a different job from either running or off'}
          </>
        ) : null}
        {'. '}
        {view.totals.idle} have every strategy off, and{' '}
        <span title="Reported a balance but no strategy row came with the close. Nobody looked — it is not a reading of zero.">
          {view.totals.unmeasured} sent no strategy data
        </span>{'. '}
        {view.totals.strategiesOn} of {view.totals.strategyRows} strategy rows are enabled.
      </p>
      )}
      {!showClientName && view.notInRegistry ? (
        <p className="drift-majority">
          <span className="muted">
            {view.accounts.length + view.retiredCount} accounts are listed here against{' '}
            {view.registryAccounts} in the account registry: {view.notInRegistry} of them report
            under a name the registry does not hold. &ldquo;Accounts (all time)&rdquo; above counts
            the registry only, which is why it reads {view.registryAccounts} and this reads{' '}
            {view.accounts.length + view.retiredCount}.
          </span>
        </p>
      ) : null}
      {view.asOfDates.length > 1 ? (
        <p className="drift-majority">
          <span className="muted">
            These accounts do not share a date. {view.asOfDates.length} different closes are on
            screen ({view.asOfDates.join(', ')}), so every row carries its own —{' '}
            {view.totals.reporting} on {view.latestCloseDate}, {view.totals.behind} behind it
            {view.totals.neverReported ? `, ${view.totals.neverReported} never reported` : ''}.
          </span>
        </p>
      ) : null}

      {view.groups.map((group) => (
        <GroupBlock key={group.key} group={group} />
      ))}
      <RetiredBlock view={view} />
    </section>
  );
}

function GroupBlock({ group }) {
  return (
    <div className="drift-observed">
      <div className="drift-observed-head">
        <strong>{group.label}</strong>
        <span className="muted">
          {group.accounts.length} account{group.accounts.length === 1 ? '' : 's'}
          {group.totals.strategyRows
            ? ` · ${group.totals.strategiesOn} of ${group.totals.strategyRows} strategies on`
            : ''}
        </span>
        {group.note ? <span className="drift-build">{group.note}</span> : null}
      </div>
      <ul className="drift-groups">
        {group.accounts.map((account) => (
          <li key={`${account.clientId || ''}:${account.accountName}`} className="drift-group">
            <AccountRow account={account} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountRow({ account }) {
  return (
    <details>
      <summary>
        <span className="drift-summary-body">
          <span className="drift-group-head">
            <RunBadge account={account} />
            <strong>{account.alias}</strong>
            <AsOf account={account} />
            <span className="drift-more">{account.accountType || 'not in the registry'}</span>
          </span>
          <span className="drift-headline">
            <Session account={account} />
          </span>
          <span className="drift-who muted">
            {/* The index is in the key because name+instrument is NOT unique.
                Two accounts on this book (Avery Frost/BDG9159854231060 and
                Marlow Dune/DDE19906037837903) carry four strategy rows that
                collapse to three keys — the same algo running twice on two data
                series, which liveAccounts documents as the reason the name
                prefix is a period and not a grid row index. Duplicate keys make
                React warn and, on update, drop or reuse the wrong node: the
                segment row that remounted on every render and destroyed the
                button just pressed was this same class of bug. */}
            {account.strategies.length
              ? account.strategies.map((strategy, index) => (
                <StrategyChip
                  key={`${index}:${strategy.name}:${strategy.instrument}`}
                  strategy={strategy}
                />
              ))
              : 'no strategy row on this close'}
          </span>
        </span>
      </summary>
      <div className="drift-detail">
        <AccountDetail account={account} />
      </div>
    </details>
  );
}

/**
 * Running / off / not measured — three states, three words.
 *
 * 179 of the 595 live accounts on this book carry no strategy row. Reporting
 * them as "off" would say the desk switched them down when in fact the close
 * arrived without a strategy export, which is a different job to do.
 */
function RunBadge({ account }) {
  if (account.runState === 'running') {
    return (
      <span className="badge success" title={`${account.enabledCount} of ${account.strategyCount} strategies enabled`}>
        running
      </span>
    );
  }
  if (account.runState === 'idle') {
    return (
      <span className="badge muted" title={`${account.strategyCount} strategies loaded, all disabled`}>
        all off
      </span>
    );
  }
  return (
    <span
      className="badge warning"
      title="The account reported on this close but no strategy row came with it. Not measured — not zero."
    >
      no strategy data
    </span>
  );
}

/** The date this row's numbers actually come from. Never a header, never today. */
function AsOf({ account }) {
  if (!account.asOfDate) {
    return (
      <span className="drift-absent" title="This account is in the registry but has never appeared in a close.">
        never reported
      </span>
    );
  }
  if (account.reported) {
    return <span className="drift-group-count">as of {account.asOfDate}</span>;
  }
  const days = account.daysBehindClose;
  return (
    <span
      className="drift-observed-warn"
      title={`This client's most recent close does not contain this account. These numbers are from ${account.asOfDate}, the last close it appeared in.`}
    >
      as of {account.asOfDate}
      {days === null ? '' : ` — ${days} day${days === 1 ? '' : 's'} behind the last close`}
    </span>
  );
}

function Session({ account }) {
  if (!account.session) return <span className="drift-absent">no close to report</span>;
  const { realized, unrealized, balance } = account.session;
  return (
    <>
      <span>{money(realized)} realized</span>
      {unrealized ? <span> · {money(unrealized)} open</span> : null}
      <span className="muted"> · balance {money(balance)}</span>
      <span className="muted"> · {tradedText(account)}</span>
    </>
  );
}

/**
 * "Traded" is three-valued. 13 of the 84 closes on this book carry no execution
 * list, so a flat balance on those days cannot be told apart from a day nobody
 * counted; that reads "not measured", not "0 trades".
 */
function tradedText(account) {
  if (account.traded === null) return 'trading not measured on this close';
  if (account.fills === null) return account.traded ? 'moved, fills not counted' : 'no movement';
  return `${account.fills} fill${account.fills === 1 ? '' : 's'}`;
}

function StrategyChip({ strategy }) {
  const label = [strategy.family || strategy.name, strategy.version].filter(Boolean).join(' ');
  return (
    <span
      className={strategy.enabled === true ? 'strategy enabled' : 'strategy'}
      title={strategy.name}
    >
      {label} {periodTag(strategy.period)} {enabledWord(strategy.enabled)}
    </span>
  );
}

/**
 * The period comes from the strategy name's leading number and nothing else
 * carries it. Missing renders as a question mark, never as 0: 645 of 3805 rows
 * on this book have no prefix, and the set-file library has no unprefixed build
 * for them to have come from.
 */
function periodTag(period) {
  return period === null ? 'P?' : `P${period}`;
}

function enabledWord(enabled) {
  if (enabled === true) return 'on';
  if (enabled === false) return 'off';
  return 'on/off unknown';
}

function AccountDetail({ account }) {
  return (
    <>
      <div className="drift-table-wrap">
        <table className="drift-table">
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Period</th>
              <th scope="col">Instrument</th>
              <th scope="col">State</th>
              <th scope="col">Realized</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {account.strategies.length ? (
              account.strategies.map((strategy, index) => (
                // Index first for the same reason as the chips above: adding
                // dataSeries was not enough — the two colliding accounts collide
                // on all three fields.
                <tr key={`${index}:${strategy.name}:${strategy.instrument}:${strategy.dataSeries}`}>
                  <th scope="row">{strategy.name || <span className="drift-absent">unnamed</span>}</th>
                  <td>
                    {strategy.period === null ? (
                      <span className="drift-absent" title="No period prefix on the name. Unknown, not 0.">
                        not stated
                      </span>
                    ) : (
                      strategy.period
                    )}
                  </td>
                  <td>{strategy.instrument || <span className="drift-absent">—</span>}</td>
                  <td className="drift-here">{enabledWord(strategy.enabled)}</td>
                  <td>{money(strategy.realized)}</td>
                  <td>{money(strategy.unrealized)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  <span className="drift-absent">
                    No strategy row arrived with the {account.asOfDate} close for this account. Not
                    measured — this is not a reading of zero strategies.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {account.realizedGap ? (
        <p className="drift-build">
          Strategy rows total {money(account.strategyRealized)}; the account closed at{' '}
          {money(account.session.realized)}. NinjaTrader reports realized{' '}
          <em>since the strategy was enabled</em>, so these rows are not a breakdown of the day.
        </p>
      ) : null}
      <ul className="drift-accounts">
        <li>
          <strong>{account.accountName}</strong>
          <span className="drift-account-numbers">
            {account.connection || 'no connection on file'} · seen in {account.closeCount} close
            {account.closeCount === 1 ? '' : 's'}
            {account.workingOrders === null
              ? ' · working orders not measured on this close'
              : ` · ${account.workingOrders} order${account.workingOrders === 1 ? '' : 's'} in a live state`}
          </span>
          {account.inRegistry ? null : (
            <span className="drift-absent">
              reported by the platform but absent from the account registry
            </span>
          )}
        </li>
      </ul>
    </>
  );
}

function RetiredBlock({ view }) {
  if (!view.retiredCount) return null;
  return (
    <details className="drift-rest">
      <summary>
        {view.retiredCount} account{view.retiredCount === 1 ? '' : 's'} stood down — failed,
        inactive, or typed Inactive / Ignore. Kept here rather than dropped, because an account
        vanishing from a panel and an account being switched off look the same on screen.
      </summary>
      <div className="drift-rest-body">
        <ul className="drift-groups">
          {view.retired.map((account) => (
            <li key={account.accountName} className="drift-group">
              <span className="drift-group-head">
                <span className="badge muted">{account.retiredReason}</span>
                <strong>{account.alias}</strong>
                <AsOf account={account} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** Null renders as "not measured". A missing balance is not a balance of zero. */
function money(value) {
  if (value === null || value === undefined) return 'not measured';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}
