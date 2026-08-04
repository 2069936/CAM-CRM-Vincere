import { buildConfigDrift } from '../domain/strategyConfigDrift';

/**
 * Accounts running a configuration almost nobody else runs.
 *
 * Deliberately worded as a question. A minority configuration is often
 * legitimate — a client can be customised on purpose — so nothing here says
 * "wrong". The domain layer already declines to report a cohort with no real
 * majority, which is what keeps this list short enough to act on.
 */
export default function ConfigDriftPanel({ clients = [], asOfDate = '', limit = 8 }) {
  const rows = buildConfigDrift(clients, { asOfDate });

  if (!rows.length) {
    return (
      <p className="muted chart-empty">
        Every algorithm cohort with a clear majority is running one configuration.
      </p>
    );
  }

  const shown = rows.slice(0, limit);
  const accounts = rows.reduce((sum, row) => sum + row.outlierAccounts, 0);

  return (
    <div className="drift-panel">
      <p className="muted chart-empty">
        {accounts} account{accounts === 1 ? '' : 's'} across {rows.length} algorithm
        {rows.length === 1 ? '' : 's'} run settings the rest of the cohort does not.
        Customisation is legitimate — this is a list to verify, not a fault list.
      </p>

      {shown.map((row) => (
        <div key={`${row.family}|${row.instrument}`} className="drift-row">
          <div className="drift-head">
            <strong>{row.family}</strong>
            <span className="muted">{row.instrument}</span>
            <span className="drift-count">{row.outlierAccounts} to verify</span>
          </div>
          <div className="drift-majority">
            <span className="muted">
              {row.dominant.count} of {row.cohort} ({row.dominant.share}%) run
            </span>
            <code>{row.dominant.label}</code>
            {row.versions > 1 ? (
              <span className="badge muted" title="More than one configuration holds a real share of this cohort, so the desk is running several versions on purpose.">
                {row.versions} versions in use
              </span>
            ) : null}
          </div>
          <ul className="drift-outliers">
            {row.outliers.map((outlier) => (
              <li key={outlier.label}>
                {outlier.changes.length ? (
                  <span className="drift-change">
                    {outlier.changes.slice(0, 3).map((change) => (
                      <code key={change.name}>
                        {change.name} {change.from} → {change.to ?? 'absent'}
                      </code>
                    ))}
                    {outlier.changes.length > 3 ? (
                      <span className="muted">+{outlier.changes.length - 3} more</span>
                    ) : null}
                  </span>
                ) : (
                  <code>{outlier.label}</code>
                )}
                <span className="muted">
                  {outlier.accounts.slice(0, 4).map((account) => (
                    `${account.clientName}${account.accountName ? ` · ${account.accountName}` : ''}`
                  )).join(' — ')}
                  {outlier.accounts.length > 4 ? ` and ${outlier.accounts.length - 4} more` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {rows.length > limit ? (
        <p className="muted chart-empty">{rows.length - limit} more not shown.</p>
      ) : null}
    </div>
  );
}
