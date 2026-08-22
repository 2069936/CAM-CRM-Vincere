import { useMemo } from 'react';
import { buildConfigDrift } from '../domain/strategyConfigDrift';
import { buildDriftView, DEFAULT_OPEN_ROWS } from '../domain/configDriftPresentation';

/**
 * Accounts running a configuration almost nobody else runs.
 *
 * Deliberately worded as a question. A minority configuration is often
 * legitimate — a client can be customised on purpose — so nothing here says
 * "wrong". The domain layer already declines to report a cohort with no real
 * majority, which is what keeps this list short enough to act on.
 *
 * Every finding is reachable. An earlier version rendered the first three
 * changes of each group and collapsed the rest into a `+N more` that was a plain
 * span — not a button, no title, no expansion — and on the real book that was
 * 192 of 267 changes (72%) with no way to open them. Each group is a <details>
 * now: summarised on the surface, complete inside.
 *
 * READABILITY, SECOND PASS. Reachable is not the same as legible, and the desk
 * manager kept reporting this panel as interesting and hard to understand.
 * Measured on the real book, the reason was volume in the wrong place: eight
 * algorithm rows opened by default, each printing every one of its group
 * summaries, put 1,241 words on screen before a single click — and the ten-item
 * list a reader actually chooses from, the algorithms, was the one thing that
 * could not be seen at once. Three changes, none of which remove a finding:
 *
 *   * Every algorithm is one row in one list, closed by default except the
 *     first, and a closed row states its own worst finding so it can be skipped
 *     or opened on sight. The old second disclosure — `2 more algorithms with
 *     fewer accounts` — is gone with it: one level, ten lines.
 *   * `PT 400/450/500 · SL 300` is the name every configuration on this panel
 *     goes by and appeared fifty times on the surface with nothing saying what
 *     it meant. It is spelled out once, at the top.
 *   * Inside a group, the change the headline names is marked, and the
 *     parameters with no established meaning are captioned as a block instead of
 *     carrying a tooltip each. A 22-row table that shows `Stop loss 315 vs 300`
 *     and `URGO4 2 vs 4` in identical rows is asking the reader to rank them.
 */
export default function ConfigDriftPanel({ clients = [], asOfDate = '', limit = DEFAULT_OPEN_ROWS }) {
  const view = useMemo(
    () => buildDriftView(buildConfigDrift(clients, { asOfDate }), { limit }),
    [clients, asOfDate, limit],
  );

  if (!view.rows.length) {
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
      {/* Said once. `PT …/…/… · SL …` is how every configuration below is named
          and it was on screen fifty times without a key. */}
      <p className="drift-key muted">
        Configurations are named by their targets and stop: <code>PT</code> is the three
        profit-target legs the strategy scales out at, <code>SL</code> the stop loss, both in ticks.
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

      <p className="drift-list-note muted">
        {view.rows.length} algorithm{view.rows.length === 1 ? '' : 's'} to review, worst first.
        Every one is listed; open the ones you have not settled.
      </p>
      {view.rows.map((row, index) => (
        <DriftRow key={row.key} row={row} open={index < view.openCount} />
      ))}
    </div>
  );
}

/**
 * One algorithm, closed unless it is one of the first `openCount`.
 *
 * The summary has to be enough to skip on. Name, how many accounts it is asking
 * about, how many separate findings, what the cohort runs, and the worst of the
 * findings in words — that is the decision a reader is making, and it used to
 * require expanding the row to make it.
 */
function DriftRow({ row, open = false }) {
  return (
    <details className="drift-row" open={open}>
      <summary>
        <span className="drift-head">
          <strong>{row.family}</strong>
          <span className="muted">{row.instrument}</span>
          <span
            className="drift-count"
            title={row.tally.rows === row.tally.total ? undefined
              : `${row.tally.rows} strategy rows, ${row.tally.total} accounts — some accounts carry more than one snapshot row.`}
          >
            {row.tally.total} to verify
          </span>
          <span className="drift-findings muted">
            {row.findings} finding{row.findings === 1 ? '' : 's'}
          </span>
        </span>
        <span className="drift-majority">
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
        </span>
        {row.worst ? <span className="drift-worst">{row.worst}</span> : null}
      </summary>
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
                      {group.namedChanges.map((change) => (
                        <ChangeRow
                          key={change.name}
                          change={change}
                          lead={change.name === group.leadName}
                        />
                      ))}
                    </tbody>
                    {group.unnamedChanges.length ? (
                      <tbody className="drift-unnamed">
                        {/* One caption for the block instead of a tooltip per
                            row. These carry no plain-language name — `URGO2` is
                            the strategy name plus a digit — and dressing them up
                            would tell a CAM they are understood. */}
                        <tr>
                          <th colSpan={3} scope="colgroup">
                            {group.unnamedChanges.length} more differ
                            {group.unnamedChanges.length === 1 ? 's' : ''} in parameters with no
                            established meaning — shown exactly as the strategy writes them
                          </th>
                        </tr>
                        {group.unnamedChanges.map((change) => (
                          <ChangeRow key={change.name} change={change} lead={false} />
                        ))}
                      </tbody>
                    ) : null}
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
    </details>
  );
}

/** One parameter, both sides of it. `lead` marks the one the headline names. */
function ChangeRow({ change, lead }) {
  return (
    <tr className={lead ? 'drift-change drift-change-lead' : 'drift-change'}>
      <th scope="row">
        {lead ? <span className="drift-lead-mark" aria-hidden="true">▸</span> : null}
        {change.mapped ? (
          change.label
        ) : (
          <code>{change.name}</code>
        )}
        {change.unit ? <em>{change.unit}</em> : null}
        {lead ? <span className="drift-lead-note"> — the difference named above</span> : null}
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
  );
}
