import { useMemo } from 'react';
import { buildConfigDrift } from '../domain/strategyConfigDrift';
import { buildDriftView } from '../domain/configDriftPresentation';

/**
 * Accounts running a configuration almost nobody else runs.
 *
 * Deliberately worded as a question. A minority configuration is often
 * legitimate — a client can be customised on purpose — so nothing here says
 * "wrong". The domain layer already declines to report a cohort with no real
 * majority, which is what keeps this list short enough to act on.
 *
 * Every finding is reachable. The previous version rendered the first three
 * changes of each group and collapsed the rest into a `+N more` that was a plain
 * span — not a button, no title, no expansion — and on the real book that was
 * 192 of 267 changes (72%) with no way to open them. Each group is a <details>
 * now: summarised on the surface, complete inside.
 */
export default function ConfigDriftPanel({ clients = [], asOfDate = '', limit = 8 }) {
  const view = useMemo(
    () => buildDriftView(buildConfigDrift(clients, { asOfDate }), { limit }),
    [clients, asOfDate, limit],
  );

  if (!view.rows.length && !view.rest.length) {
    return (
      <p className="muted chart-empty">
        Every algorithm cohort with a clear majority is running one configuration.
      </p>
    );
  }

  const { totals, recurring } = view;

  return (
    <div className="drift-panel">
      <p className="drift-intro">
        <strong>{totals.strategyRows}</strong> strategy row
        {totals.strategyRows === 1 ? '' : 's'} across <strong>{totals.algorithms}</strong> algorithm
        {totals.algorithms === 1 ? '' : 's'} run settings the rest of their cohort does not —{' '}
        {totals.accounts} account{totals.accounts === 1 ? '' : 's'}, {totals.clients} client
        {totals.clients === 1 ? '' : 's'}
        {totals.unnamedRows ? (
          <>
            {' '}
            <span
              className="muted"
              title="These strategy rows carry no trading account on the import, so they cannot be resolved to an account number. Counted, not guessed at."
            >
              (+{totals.unnamedRows} row{totals.unnamedRows === 1 ? '' : 's'} with no account number)
            </span>
          </>
        ) : null}
        .
      </p>
      <p className="drift-ask">
        For each line, confirm the setting is what the client asked for. Different is not wrong —
        unexplained is. Customisation is legitimate; this is a list to verify, not a fault list.
      </p>

      {recurring ? (
        <p className="drift-recurring">
          <strong>One question covers {recurring.groups} of the {recurring.totalGroups} findings below.</strong>{' '}
          {recurring.label} is <code>{recurring.value}</code> on {recurring.accounts} of these
          accounts, across {recurring.algorithms} algorithm
          {recurring.algorithms === 1 ? '' : 's'}. Their cohorts do not agree on one value between
          them — {recurring.cohortValues.length} different{' '}
          {recurring.cohortValues.length === 1 ? 'value' : 'values'} (
          {recurring.cohortValues.map((value, index) => (
            <span key={value}>
              {index ? ', ' : ''}
              <code>{value}</code>
            </span>
          ))}
          ) — so the thing to settle is which one the desk means, once, rather than{' '}
          {recurring.groups} times.
        </p>
      ) : null}

      {view.rows.map((row) => (
        <DriftRow key={row.key} row={row} />
      ))}

      {view.rest.length ? (
        <details className="drift-rest">
          <summary>
            {view.rest.length} more algorithm{view.rest.length === 1 ? '' : 's'} with fewer accounts
            to verify — the count is accounts, not distance from the cohort, so a single account can
            be the furthest off the book.
          </summary>
          <div className="drift-rest-body">
            {view.rest.map((row) => (
              <DriftRow key={row.key} row={row} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function DriftRow({ row }) {
  return (
    <section className="drift-row">
      <div className="drift-head">
        <strong>{row.family}</strong>
        <span className="muted">{row.instrument}</span>
        <span
          className="drift-count"
          title={row.tally.rows === row.tally.total ? undefined
            : `${row.tally.rows} strategy rows, ${row.tally.total} accounts — some accounts carry more than one snapshot row.`}
        >
          {row.tally.total} to verify
        </span>
      </div>
      <p className="drift-majority">
        <span className="muted">
          Cohort: {row.dominant.count} of {row.cohort} ({row.dominant.share}%) run
        </span>
        <code>{row.dominant.label}</code>
        {row.versions > 1 ? (
          <span
            className="badge muted"
            title="More than one configuration holds a real share of this cohort, so the desk is running several versions on purpose."
          >
            {row.versions} versions in use
          </span>
        ) : null}
      </p>
      <ul className="drift-groups">
        {row.groups.map((group) => (
          <li key={group.key} className="drift-group">
            <details>
              <summary>
                <span className="drift-summary-body">
                  <span className="drift-group-head">
                    <span
                      className="drift-group-count"
                      title={group.tally.unnamedRows
                        ? `${group.tally.accounts} identified account${group.tally.accounts === 1 ? '' : 's'} and ${group.tally.unnamedRows} strategy row${group.tally.unnamedRows === 1 ? '' : 's'} with no trading account on the import.`
                        : undefined}
                    >
                      {group.count} account{group.count === 1 ? '' : 's'}
                    </span>
                    {group.sameLabelAsCohort ? (
                      <span className="drift-same" title="Same profit targets and stop as the cohort — the difference is in other settings.">
                        same targets &amp; stop
                      </span>
                    ) : (
                      <code>{group.label}</code>
                    )}
                    <span className="drift-more">
                      {group.changes.length} setting{group.changes.length === 1 ? '' : 's'} differ
                      {group.changes.length === 1 ? 's' : ''}
                    </span>
                  </span>
                  <span className="drift-headline">{group.headline}</span>
                  {group.buildNote ? (
                    <span className="drift-build">{group.buildNote}</span>
                  ) : null}
                  <span className="drift-who muted">{group.whoLine}</span>
                </span>
              </summary>
              <div className="drift-detail">
                <div className="drift-table-wrap">
                  <table className="drift-table">
                    <thead>
                      <tr>
                        <th scope="col">Setting</th>
                        <th scope="col">
                          Cohort
                          <em>{row.dominant.count} accounts</em>
                        </th>
                        <th scope="col">
                          These {group.count}
                          <em>account{group.count === 1 ? '' : 's'}</em>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.changes.map((change) => (
                        <tr key={change.name}>
                          <th scope="row">
                            {change.mapped ? (
                              change.label
                            ) : (
                              <code title="No safe plain-language name for this parameter — shown exactly as the strategy writes it.">
                                {change.name}
                              </code>
                            )}
                            {change.unit ? <em>{change.unit}</em> : null}
                          </th>
                          <td>
                            {change.absentInCohort ? (
                              <span className="drift-absent">not in this build</span>
                            ) : (
                              change.cohort
                            )}
                          </td>
                          <td className="drift-here">
                            {change.absentHere ? (
                              <span className="drift-absent">not in this build</span>
                            ) : (
                              change.here
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="drift-accounts">
                  {group.clients.map((client) => (
                    <li key={client.clientId}>
                      <strong>{client.clientName}</strong>
                      {client.accounts.length ? (
                        <span className="drift-account-numbers">{client.accounts.join('  ')}</span>
                      ) : null}
                      {client.unnamedRows ? (
                        <span className="drift-absent">
                          {client.unnamedRows} row{client.unnamedRows === 1 ? '' : 's'} with no
                          account number on the import
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
