import { formatCurrency } from '../domain/report';
import SimulationBadge from './SimulationBadge';

/**
 * The simulation block of a client report.
 *
 * Opt-in through the existing report designer (`showSimulation` in
 * reportConfig.js REPORT_FIELDS, off by default, per-CAM or per-client through
 * the same scope radio every other toggle uses). Rendered only when
 * `report.simulation` is non-null — a client with no simulation gets no section,
 * rather than a section full of zeros.
 *
 * WHY IT EXISTS. The report the desk actually sent Craig Weschke for 2026-08-06
 * read `ACCOUNTS 2 · DAILY REALIZED PNL $0 · WEEKLY PNL $0` while his Sim101 —
 * the only account of his that traded that day — ran 40 orders and 15 executions
 * across two enabled strategies for a realized -$1,297.9999999, and his CAM had
 * hand-written him a paragraph about that very session. The desk could not show
 * the thing it was being paid to run.
 *
 * WHAT IT MUST NEVER DO. Its figures are never added to `report.totals` and
 * never appear in the segment tile row. The visual separation is deliberate and
 * structural, not just adjacency: its own bordered block, its own heading, its
 * own subtotal row labelled "Simulated", and the word "simulated" attached to
 * every currency figure it prints. Two totals on one page that could be mistaken
 * for each other is the defect, not the layout.
 */
export default function SimulationReportSection({ simulation }) {
  if (!simulation) return null;

  const { totals, counts } = simulation;
  const hasAccounts = simulation.accounts.length > 0;

  return (
    <section className="report-section report-simulation">
      <header className="report-simulation-head">
        <h2>{simulation.label}</h2>
        {/*
          Only when there IS something simulated. A block holding nothing but
          undetermined accounts was still wearing this chip, so a client whose
          three real accounts happened to be named Practice / Demo 4 / Simulator
          read "Simulated funds" over $200,000 of possibly-real money. Telling a
          client their money is play money is the same defect as the reverse.
        */}
        {hasAccounts ? <span className="sim-chip">Simulated funds</span> : null}
      </header>
      <p className="report-simulation-note">{simulation.note}</p>

      {hasAccounts ? (
        <>
          <div className="report-simulation-totals">
            <div>
              <span>Simulated accounts</span>
              {/* Every count carries its denominator. */}
              <strong>
                {counts.accounts} of {counts.ofAccountsReported}
              </strong>
            </div>
            <div>
              <span>Simulated balance</span>
              <strong>{formatCurrency(totals.aggregateBalance)} simulated</strong>
            </div>
            <div>
              <span>Simulated daily P&amp;L</span>
              <strong className={totals.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                {formatCurrency(totals.grossRealizedPnl)} simulated
              </strong>
            </div>
            <div>
              <span>Simulated weekly P&amp;L</span>
              <strong className={totals.weeklyPnl >= 0 ? 'report-positive' : 'report-negative'}>
                {formatCurrency(totals.weeklyPnl)} simulated
              </strong>
            </div>
          </div>

          <p className="report-simulation-activity">
            {counts.traded ? (
              <>
                This session ran <strong>{counts.orders}</strong> order
                {counts.orders === 1 ? '' : 's'} and <strong>{counts.executions}</strong> execution
                {counts.executions === 1 ? '' : 's'} on {counts.enabledStrategies} enabled strateg
                {counts.enabledStrategies === 1 ? 'y' : 'ies'}.
              </>
            ) : (
              // "Idle" and "flat" are different facts. 10 of the 11 simulation
              // accounts in the real book were idle on 2026-08-06 — no
              // strategies, no orders, no executions, balance untouched at
              // NinjaTrader's stock $100,000 — and reporting that as a $0 day
              // would be the same lie in the other direction.
              <>No simulated trading activity in this close: no orders and no executions.</>
            )}
          </p>

          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Strategies running</th>
                  <th scope="col">Daily P&amp;L (simulated)</th>
                  <th scope="col">Weekly P&amp;L (simulated)</th>
                  <th scope="col">Balance (simulated)</th>
                </tr>
              </thead>
              <tbody>
                {simulation.accounts.map((row) => (
                  <tr key={row.accountName}>
                    <td>
                      <strong>{row.meta?.alias || row.accountName}</strong>
                      <SimulationBadge nature={row.nature} compact />
                      <br />
                      <small title={row.natureReason}>
                        {row.meta?.connection || row.connection || ''}
                      </small>
                    </td>
                    <td>
                      <small>{row.enabledStrategies.join(', ') || '-'}</small>
                    </td>
                    <td className={row.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                      {formatCurrency(row.grossRealizedPnl)}
                    </td>
                    <td className={row.weeklyPnl >= 0 ? 'report-positive' : 'report-negative'}>
                      {formatCurrency(row.weeklyPnl)}
                    </td>
                    <td>{formatCurrency(row.accountBalance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Simulated total ({counts.accounts} of {counts.ofAccountsReported} accounts)</th>
                  <td />
                  <td className={totals.grossRealizedPnl >= 0 ? 'report-positive' : 'report-negative'}>
                    {formatCurrency(totals.grossRealizedPnl)}
                  </td>
                  <td className={totals.weeklyPnl >= 0 ? 'report-positive' : 'report-negative'}>
                    {formatCurrency(totals.weeklyPnl)}
                  </td>
                  <td>{formatCurrency(totals.aggregateBalance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : null}

      {simulation.undetermined ? (
        <div className="report-simulation-undetermined">
          <h3>{simulation.undetermined.label}</h3>
          <p>
            {simulation.undetermined.counts.accounts} account
            {simulation.undetermined.counts.accounts === 1 ? '' : 's'} of {counts.ofAccountsReported} could
            not be identified as either real or simulated, so{' '}
            {formatCurrency(simulation.undetermined.totals.aggregateBalance)} is excluded from every
            total on this report — the real ones above and the simulated ones here.
          </p>
          <ul>
            {simulation.undetermined.accounts.map((row) => (
              <li key={row.accountName}>
                <strong>{row.meta?.alias || row.accountName}</strong>
                <SimulationBadge nature={row.nature} compact />{' '}
                <span className="muted">{row.natureReason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
