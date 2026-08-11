import { useMemo } from 'react';
import {
  buildAccountLifecycleStates,
  LIFECYCLE_STATE_LABELS,
} from '../domain/accountLifecycle';

/**
 * Accounts the desk should probably retire, with the evidence beside each one.
 *
 * Same shape of promise as ConfigDriftPanel and for the same reason: this is a
 * review list, not a verdict. Retiring an account is a human action with money
 * attached — on the real book 25 accounts the desk had already written off
 * traded on the most recent close, holding $1.2m — so a false "this is dead"
 * costs far more than a missed suggestion. Every row carries the four facts a
 * CAM checks it against (declared status, trailing buffer with its date, last
 * reported, last traded) and nothing is retired from here; the panel proposes.
 *
 * Two things it deliberately does NOT do:
 *   - it never says delete. Nothing here removes a row, an import or a
 *     snapshot. AccountManager's trash icon is the only delete in the product
 *     and it is what creates the orphaned snapshots this panel then has to
 *     report as unretirable.
 *   - it never hides what it declined to suggest. The withheld block at the
 *     bottom counts every account left off the list and says why, because "539
 *     accounts were not suggested" is only trustworthy if the reasons are
 *     readable.
 *
 * Every finding is reachable: the overflow lives inside a <details>, not behind
 * an inert "+N more" span — the mistake ConfigDriftPanel had to fix after it hid
 * 72% of its own findings.
 */

const GROUPS = [
  {
    kind: 'breached-and-trading',
    title: 'Past its drawdown limit and still trading',
    blurb: 'The trailing buffer is negative and the account was still trading in that same close. '
      + 'These are the ones to look at first: whatever the registry says, the book says this account is over its line and has not stopped.',
  },
  {
    kind: 'breached',
    title: 'Past its drawdown limit',
    blurb: 'The last trailing buffer we hold for these is negative. Under the no-configured-limit model that '
      + 'NinjaTrader exports for 750 of 764 accounts, the number IS the buffer remaining, so below zero means the limit is reached.',
  },
  {
    kind: 'declared-and-silent',
    title: 'Marked Failed by the desk and gone quiet',
    blurb: 'No breach on record for these. The case is that someone marked them Failed and they have not appeared in a close since — '
      + 'two weak facts that agree. Confirm rather than assume.',
  },
];

function money(value) {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(Number(value) || 0);
  return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

export default function AccountLifecyclePanel({
  clients = [],
  asOfDate = '',
  limit = 10,
  staleCloses = 5,
}) {
  const view = useMemo(
    () => buildAccountLifecycleStates(clients, { asOf: asOfDate, staleCloses }),
    [clients, asOfDate, staleCloses],
  );

  const { counts, suggestions, withheld, declared } = view;
  const total = view.accounts.length;

  if (!total) {
    return <p className="muted chart-empty">No accounts on file for this book yet.</p>;
  }

  const groups = GROUPS
    .map((group) => ({ ...group, rows: suggestions.filter((row) => row.suggestion.kind === group.kind) }))
    .filter((group) => group.rows.length);

  return (
    <div className="drift-panel">
      <p className="drift-intro">
        <strong>{suggestions.length}</strong> of {total} account{total === 1 ? '' : 's'} carry enough
        evidence to propose retiring them, across{' '}
        {new Set(suggestions.map((row) => row.clientId)).size} client
        {new Set(suggestions.map((row) => row.clientId)).size === 1 ? '' : 's'}
        {/* The date the evidence reaches, not the date on the picker. The ops
            screen hands in its own asOfDate and that is seeded from the wall
            clock, so this line read "closes to 2026-08-11" for a book whose
            last close is 2026-07-30 — twelve days of nothing, printed as if it
            had been looked at. When the two differ the gap is said out loud. */}
        {view.asOf ? <> · closes to {view.asOf}</> : null}
        {view.bound && view.asOf && view.bound !== view.asOf ? (
          <span className="muted"> (nothing closed between {view.asOf} and {view.bound})</span>
        ) : null}.{' '}
        <span className="muted">
          {LIFECYCLE_STATE_LABELS.running} {counts.running} · {LIFECYCLE_STATE_LABELS.quiet}{' '}
          {counts.quiet} · {LIFECYCLE_STATE_LABELS.finished} {counts.finished} ·{' '}
          {LIFECYCLE_STATE_LABELS.stale} {counts.stale} · {LIFECYCLE_STATE_LABELS.unknown}{' '}
          {counts.unknown}
        </span>
      </p>

      <p className="drift-ask">
        Nothing here retires anything. Read the evidence on each row and confirm it account by
        account — a wrong retire on a live funded account costs more than a suggestion nobody acts
        on, which is why an account the evidence cannot place comes back as &ldquo;not enough to
        say&rdquo; rather than a guess.
      </p>

      {declared.failed ? (
        <p className="drift-recurring">
          <strong>
            {declared.failed} account{declared.failed === 1 ? '' : 's'} are marked Failed today and{' '}
            {declared.failedWithDate} of them carr{declared.failedWithDate === 1 ? 'ies' : 'y'} a
            failure date.
          </strong>{' '}
          {declared.failedSuggested} of those are on the list below because the closes agree with the
          status.{' '}
          {declared.failedStillTrading ? (
            <>
              {declared.failedStillTrading} of them were still trading in their latest close,
              holding {money(declared.failedStillTradingBalance)} and realising{' '}
              {money(declared.failedStillTradingDailyPnl)} that day.{' '}
              {declared.failedStillTradingSuggested} of those are on the list anyway because their
              buffer is negative too; the other {declared.failedStillTradingWithheld} are the real
              disagreement — written off, still trading, no breach on record — and they are a
              question for the CAM, not a retire.
            </>
          ) : null}
        </p>
      ) : null}

      {groups.map((group) => (
        <SuggestionGroup key={group.kind} group={group} limit={limit} />
      ))}

      <WithheldBlock withheld={withheld} total={view.withheldTotal} />
    </div>
  );
}

function SuggestionGroup({ group, limit }) {
  const head = group.rows.slice(0, limit);
  const rest = group.rows.slice(limit);

  return (
    <section className="drift-row">
      <div className="drift-head">
        <strong>{group.title}</strong>
        <span className="drift-count">{group.rows.length} to confirm</span>
      </div>
      <p className="drift-majority">
        <span className="muted">{group.blurb}</span>
      </p>
      <ul className="drift-groups">
        {head.map((row) => (
          <AccountRow key={`${row.clientId}:${row.accountName}`} row={row} />
        ))}
      </ul>
      {rest.length ? (
        <details className="drift-rest">
          <summary>
            {rest.length} more in this group, smallest balance last — the order is balance at risk,
            not how sure the evidence is, so the bottom of the list is not the safe end of it.
          </summary>
          <div className="drift-rest-body">
            <ul className="drift-groups">
              {rest.map((row) => (
                <AccountRow key={`${row.clientId}:${row.accountName}`} row={row} />
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function AccountRow({ row }) {
  return (
    <li className="drift-group">
      <details>
        <summary>
          <span className="drift-summary-body">
            <span className="drift-group-head">
              <span className="drift-group-count">{row.clientName}</span>
              <code>{row.accountName}</code>
              <span className="drift-more">{row.accountType || 'no type set'}</span>
              {row.declaredFailed ? (
                <span className="badge danger">status Failed</span>
              ) : (
                <span className="badge muted">status {row.status || 'Active'}</span>
              )}
              <span className="drift-more">balance {money(row.lastBalance)}</span>
            </span>
            <span className="drift-headline">{row.suggestion.headline}</span>
            <span className="drift-build">{row.suggestion.confidence}</span>
            <span className="drift-who muted">{row.evidenceLine}</span>
          </span>
        </summary>
        <div className="drift-detail">
          <div className="drift-table-wrap">
            <table className="drift-table">
              <thead>
                <tr>
                  <th scope="col">Evidence</th>
                  <th scope="col">
                    What the book holds
                    <em>{row.closes} close{row.closes === 1 ? '' : 's'} for this client</em>
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.evidence.map((chip) => (
                  <tr key={chip.key}>
                    <th scope="row">
                      {chip.label}
                      {chip.note ? <em>{chip.note}</em> : null}
                    </th>
                    <td className={chip.tone === 'danger' ? 'drift-here' : undefined}>
                      {/* "never reported" is not a zero and must not read like one:
                          the drawdown column read exactly 0 on every close for 89
                          accounts, which is the import having no column, not a
                          buffer of nothing left. */}
                      {chip.value === 'never reported' || chip.value.startsWith('not known')
                        ? <span className="drift-absent">{chip.value}</span>
                        : chip.value}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">reported in</th>
                  <td>
                    {row.seenCloses} of {row.closes} closes
                    {row.skippedCloses
                      ? ` · missed ${row.skippedCloses} inside its own span and came back`
                      : ''}
                  </td>
                </tr>
                <tr>
                  <th scope="row">where it sits now</th>
                  <td>{row.stateBasis}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="drift-build">{row.suggestion.agreement}</p>
        </div>
      </details>
    </li>
  );
}

/**
 * What was deliberately left off the list.
 *
 * This block is the honest half of the panel. 539 accounts on the real book are
 * not suggested, and without the reasons that number is either invisible or
 * reads as "checked and fine" — which is wrong for the 104 that simply stopped
 * reporting and the 29 nobody has ever seen in a close.
 */
function WithheldBlock({ withheld, total }) {
  if (!withheld.length) return null;
  return (
    <details className="drift-rest">
      <summary>
        {total} account{total === 1 ? '' : 's'} were deliberately NOT suggested — the reasons, counted
      </summary>
      <div className="drift-rest-body">
        <ul className="drift-accounts">
          {withheld.map((entry) => (
            <li key={entry.reason}>
              <strong>
                {entry.count} · {entry.reason}
              </strong>
              <span className="drift-account-numbers">{entry.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
