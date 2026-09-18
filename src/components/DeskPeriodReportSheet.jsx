import { useRef, useState } from 'react';
import { formatCurrency } from '../domain/report';
import ReportSheetActions from './ReportSheetActions';
import {
  AccountsPerCloseChart,
  BenchmarkCurves,
  ComboBarChart,
  DeploymentGrid,
  IntervalChart,
  MoneyStrips,
  SlopeChart,
} from './DeskPeriodReportCharts';

/**
 * The desk period report sheet. RENDERING ONLY.
 *
 * Every number on this page arrives on the object `buildDeskPeriodReport`
 * returns. This component computes nothing except SVG geometry and the order of
 * its own sections — the same division `StackPlaybook.jsx` was rewritten into,
 * for the same reason: a figure computed in markup is a figure no test can
 * reach and no second surface can agree with.
 *
 * COVERAGE GOES FIRST, and that is a decision rather than a layout. It is the
 * least interesting section on the page and the most load bearing: every rate
 * below it divides by a denominator that moves by a factor of fifty between
 * closes on this book. Putting it last, where it belongs aesthetically, is how
 * a reader reaches the ranking without the denominator.
 *
 * EVERY TOOLTIP NAMES A POPULATION, A WINDOW AND A BASIS. Not decoration: a
 * number on this desk has been wrong three times this month by measuring
 * something other than its label, and the column header is where that is
 * caught.
 *
 * The period controls live in `.report-actions.no-print` OUTSIDE the sheet, so
 * the paper carries the period as prose in its header and a printed copy is
 * self-describing with no control visible.
 */

const money = (value) => (value === null || value === undefined
  ? 'not measured'
  : `${value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`);

const rate = (value) => (value === null || value === undefined
  ? 'not measured'
  : `${value < 0 ? '-' : ''}$${Math.abs(Number(value)).toFixed(2)}`);

const count = (value) => (value === null || value === undefined
  ? '—'
  : new Intl.NumberFormat('en-US').format(Number(value)));

const percent = (value) => (value === null || value === undefined ? '—' : `${value}%`);

function Refusal({ children }) {
  if (!children) return null;
  return <p className="muted desk-refusal">{children}</p>;
}

function Cell({ value, refusal, title }) {
  if (value === null || value === undefined) {
    return <td className="muted" title={title}>{refusal || 'not measured'}</td>;
  }
  return <td title={title}>{value}</td>;
}

/* ------------------------------------------------------------------ */

function PeriodControls({
  period, periods, kind, onPeriodChange, benchmarkRisk, onBenchmarkRiskChange, riskLevels,
}) {
  return (
    <div className="period-controls">
      <div className="period-kind" role="group" aria-label="Period kind">
        {[['week', 'Week'], ['month', 'Month'], ['custom', 'Custom range']].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={kind === value ? 'secondary-button' : 'ghost-button'}
            onClick={() => onPeriodChange({ kind: value })}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'custom' ? (
        <>
          <label className="period-field">
            <span>From</span>
            <input
              type="date"
              value={period.from}
              min={period.bookFirstClose}
              max={period.bookLastClose}
              onChange={(event) => onPeriodChange({ kind: 'custom', from: event.target.value, to: period.to })}
            />
          </label>
          <label className="period-field">
            <span>To</span>
            <input
              type="date"
              value={period.to}
              min={period.bookFirstClose}
              max={period.bookLastClose}
              onChange={(event) => onPeriodChange({ kind: 'custom', from: period.from, to: event.target.value })}
            />
          </label>
        </>
      ) : (
        <label className="period-field">
          <span>{kind === 'month' ? 'Month' : 'Week'}</span>
          <select
            value={period.key}
            onChange={(event) => onPeriodChange({ kind, key: event.target.value })}
          >
            {periods.map((entry) => (
              <option key={entry.key} value={entry.key}>{entry.optionLabel}</option>
            ))}
          </select>
        </label>
      )}
      <label className="period-field">
        <span>Benchmark risk level</span>
        <select
          value={benchmarkRisk}
          onChange={(event) => onBenchmarkRiskChange(event.target.value)}
        >
          {riskLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function DeskPeriodReportSheet({
  report,
  periods = [],
  kind = 'week',
  onPeriodChange = () => {},
  benchmarkRisk = 'Low',
  onBenchmarkRiskChange = () => {},
  onImportBenchmark = null,
  benchmarkImport = null,
  onCopySummary = null,
  copied = false,
}) {
  const sheetRef = useRef(null);
  const [changesOpen, setChangesOpen] = useState(false);
  if (!report) return null;

  const {
    period, scope, stamp, coverage, money: moneyBlock, roster, results,
    movement, stack, changes, benchmark, refusals, definitions,
  } = report;
  const businesses = moneyBlock.desk.rows.map((row) => ({
    key: row.key, label: row.label, shortLabel: row.shortLabel,
  }));
  const shownChanges = changesOpen ? changes.rows : changes.rows.slice(0, 25);

  return (
    <div className="page-stack desk-period-report">
      <div className="report-actions no-print">
        <PeriodControls
          period={period}
          periods={periods}
          kind={kind}
          onPeriodChange={onPeriodChange}
          benchmarkRisk={benchmarkRisk}
          onBenchmarkRiskChange={onBenchmarkRiskChange}
          riskLevels={benchmark.riskLevels}
        />
        <ReportSheetActions title={`Desk period report ${period.label}`} sheetRef={sheetRef} />
        {onCopySummary ? (
          <button className="ghost-button" type="button" onClick={onCopySummary}>
            {copied ? 'Copied!' : 'Copy summary'}
          </button>
        ) : null}
      </div>

      <div className="report-sheet" ref={sheetRef}>
        {/* 7.1 Header ------------------------------------------------ */}
        <header className="report-header">
          <div>
            <p className="report-firm">Vincere Trading</p>
            <h1>Desk Period Report</h1>
            <p className="report-period-label"><strong>{period.label}</strong></p>
            <p className="muted">
              {`${period.from} to ${period.to}, `}
              {`${count(coverage.totals.closesInPeriod)} close${coverage.totals.closesInPeriod === 1 ? '' : 's'} `}
              {`of ${count(period.weekdays)} weekday${period.weekdays === 1 ? '' : 's'}`}
            </p>
            <p className="muted">{scope.label}</p>
            <p className="muted">
              {`Built ${stamp.builtAt || 'now'}${stamp.builtBy ? ` by ${stamp.builtBy}` : ''}, `}
              {`from a book whose newest close is ${stamp.bookLastClose || 'unknown'}`}
            </p>
          </div>
        </header>

        <p className="desk-refusal report-separation"><strong>{report.separation}</strong></p>

        {period.partial ? (
          <p className="desk-refusal">
            <strong>{`This period is not complete. ${period.partialReasons.join(' ')}`}</strong>
          </p>
        ) : null}

        {period.empty ? (
          <p className="muted">{period.emptyReason}</p>
        ) : null}

        {/* 7.2 Coverage ---------------------------------------------- */}
        <section className="report-section">
          <h2>How much of the desk this period holds</h2>
          <p className="muted">
            The denominator of every number after it, printed first for that reason and not as a
            summary.
          </p>

          <h3>Closes in this period</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="One trading date inside the period. Population: dates the book holds a close for. Window: this period. Basis: the trading date on the daily import.">Date</th>
                  <th scope="col" title="Clients whose book holds a close on this date. Population: the clients in scope for this report. Window: this date. Basis: presence of a daily import row, not whether it carried accounts.">Clients reporting</th>
                  <th scope="col" title="Account rows inside those closes, excluding accounts marked Inactive / Ignore. Population: the clients in scope. Window: this date. Basis: account snapshot rows, one per account per close.">Accounts reporting</th>
                  <th scope="col" title="Accounts reporting on this date as a share of the accounts reporting on the fullest close in this period. Population: the clients in scope. Window: this period. Basis: counts of account rows, never money.">Share of the fullest close</th>
                  <th scope="col" title="Account rows on this date carrying a nonzero P&L. Population: the accounts reporting on this date. Window: this date. Basis: realized net of commission where the Strategies grid reported it, gross otherwise.">Account days with a P&amp;L</th>
                  <th scope="col" title="Closes for this date that were imported at least one calendar day after it. Population: daily imports for this date. Window: import timestamp against trading date. Basis: imported_at on the daily import row.">Arrived late</th>
                </tr>
              </thead>
              <tbody>
                {coverage.rows.map((row) => (row.noClose ? (
                  <tr key={row.date} className="row-muted">
                    <td className="muted">{row.date}</td>
                    <td className="muted" colSpan={5}>No close</td>
                  </tr>
                ) : (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{count(row.clientsReporting)}</td>
                    <td>{count(row.accountsReporting)}</td>
                    <td>{percent(row.shareOfFullest)}</td>
                    <td>{count(row.accountDaysWithPnl)}</td>
                    <td>{count(row.arrivedLate)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>

          <h3>Accounts reporting per close</h3>
          <AccountsPerCloseChart rows={coverage.rows} period={period} />
          <p className="muted">
            One bar per calendar day in the period so the gaps are visible. Population: the clients
            in scope. Window: this period. Basis: counts of account snapshot rows, never money. A
            weekday with no close draws a hollow tick and is not a zero.
          </p>

          <h3>What this period holds</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr><th scope="col">Figure</th><th scope="col">Value</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" title="Distinct trading dates inside the period that the book holds a close for. Population: the clients in scope. Window: this period. Basis: daily import rows.">Closes in the period</th>
                  <td>{count(coverage.totals.closesInPeriod)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Monday to Friday dates inside the period, whether or not a close exists. Population: the calendar. Window: this period. Basis: the date only.">Weekdays in the period</th>
                  <td>{count(coverage.totals.weekdaysInPeriod)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Distinct clients with at least one close inside the period. Population: the clients in scope. Window: this period. Basis: daily import rows.">Clients reporting</th>
                  <td>{count(coverage.totals.clientsReporting)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Distinct accounts with at least one snapshot inside the period, excluding accounts marked Inactive / Ignore. Population: the clients in scope. Window: this period. Basis: account snapshot rows.">Accounts reporting</th>
                  <td>{count(coverage.totals.accountsReporting)}</td>
                </tr>
                <tr>
                  <th scope="row" title="One account, one close. The same account is counted once per close it reported on. Population: the accounts reporting. Window: this period. Basis: account snapshot rows.">Account closes</th>
                  <td>{count(coverage.totals.accountCloses)}</td>
                </tr>
                <tr>
                  <th scope="row" title="The dates carrying the most and the fewest account rows in this period. Population: the clients in scope. Window: this period. Basis: counts of account rows.">Fullest close and thinnest close</th>
                  <td>
                    {coverage.totals.fullestClose && coverage.totals.thinnestClose
                      ? `${coverage.totals.fullestClose.date} (${count(coverage.totals.fullestClose.accounts)} account rows, `
                        + `${count(coverage.totals.fullestClose.clients)} clients) and `
                        + `${coverage.totals.thinnestClose.date} (${count(coverage.totals.thinnestClose.accounts)}, `
                        + `${count(coverage.totals.thinnestClose.clients)} clients)`
                      : 'not measured'}
                  </td>
                </tr>
                <tr>
                  <th scope="row" title="Clients whose close for a date carried no account rows at all. Population: the clients in scope. Window: this period. Basis: quietAccounts.js, a close present with zero account rows.">Clients that filed nothing on a close they held</th>
                  <td>{count(coverage.totals.clientsThatFiledNothing)}</td>
                </tr>
                <tr>
                  <th scope="row" title={`${coverage.totals.stoppedFilingNote} Population: the accounts reporting. Window: this period. Basis: absence from the last close, not account status.`}>Accounts that stopped filing inside the period</th>
                  <td>{count(coverage.totals.accountsThatStoppedFiling)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Closes for a date inside the period whose import timestamp is after the period's last day. Population: daily imports inside the period. Window: import timestamp. Basis: imported_at.">Closes that arrived after the period ended</th>
                  <td>{count(coverage.totals.closesThatArrivedAfterThePeriod)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="desk-refusal"><strong>{coverage.sentence}</strong></p>
        </section>

        {/* 7.3 Money -------------------------------------------------- */}
        <section className="report-section">
          <h2>Desk money in this period</h2>
          <p className="muted">{moneyBlock.desk.basis.label}</p>

          <h3>Money by business</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="One of the desk's four businesses. Population: every account close in the period, segmented by account type. Window: this period. Basis: operationsSegments.js. These rows are never added: a cash dollar is real client money and a prop dollar is movement against a plan size the firm simulates.">Business</th>
                  <th scope="col" title="One account, one close. Population: this business. Window: this period. Basis: account snapshot rows. Not a count of accounts: the same account is counted once per close it reported on.">Account closes</th>
                  <th scope="col" title="Distinct clients with an account close in this business. Population: this business. Window: this period. Basis: account snapshot rows.">Clients</th>
                  <th scope="col" title="Sum of the account closes in this business. Population: this business. Window: this period. Basis: realized net of commission where the grid reported it, gross otherwise. It moves with how many clients exported this period: read the next column to compare periods.">P&amp;L in the period</th>
                  <th scope="col" title="The column before it divided by account closes. Population: this business. Window: this period. Basis: the same P&L, unweighted, one account close one observation. This is the only money figure in this report that two periods may be compared on.">P&amp;L per account close</th>
                  <th scope="col" title={`The same figure over the period before this one. Population: this business. Window: ${period.priorLabel}. Basis: identical. Blank with a reason when the prior period holds no close.`}>Prior period, per account close</th>
                  <th scope="col" title={`This period's rate minus the prior period's. Population: this business. Window: this period against the one before. Basis: two means per account close, never two totals. Withheld when either period holds fewer than ${moneyBlock.minClosesForChange} account closes in this business.`}>Change</th>
                  <th scope="col" title="Cash held for the cash row; the prop firm's simulated plan size for a prop row, which is not money. Population: this business. Window: refused over a range. Basis: deskMoney.js, whose refusal text is the tooltip on the cell.">Cash held or plan size</th>
                </tr>
              </thead>
              <tbody>
                {moneyBlock.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" title={row.note}>{row.label}</th>
                    <td>{count(row.accounts)}</td>
                    <td>{count(row.clients)}</td>
                    <td className={row.dailyPnl >= 0 ? 'report-positive' : 'report-negative'}>
                      {money(row.dailyPnl)}
                    </td>
                    <td className={(row.perAccountClose || 0) >= 0 ? 'report-positive' : 'report-negative'}>
                      {rate(row.perAccountClose)}
                    </td>
                    <Cell
                      value={row.priorPerAccountClose === null ? null : rate(row.priorPerAccountClose)}
                      refusal={period.priorEmpty ? 'The period before holds no close.' : 'not measured'}
                    />
                    <Cell value={row.change === null ? null : rate(row.change)} refusal={row.changeRefusal} />
                    <td className="muted" title={row.refusals.balance || ''}>
                      {row.balance !== null
                        ? money(row.balance)
                        : (row.planSize !== null ? money(row.planSize) : (row.refusals.balance || 'not measured'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Refusal>{moneyBlock.rowsDoNotSum}</Refusal>

          <h3>Counted, never added</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Account closes</th>
                  <th scope="col">Clients</th>
                </tr>
              </thead>
              <tbody>
                {moneyBlock.desk.reconciliation.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" title={row.note}>{row.label}</th>
                    <td>{count(row.accounts)}</td>
                    <td>{count(row.clients)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{moneyBlock.desk.reconciliation.note}</p>

          <h3>P&amp;L per account close, by close and by business</h3>
          <MoneyStrips byClose={moneyBlock.byClose} businesses={businesses} />
          <p className="muted">
            Four separate strips, never one chart with four series: the four are not comparable
            quantities and a shared axis would invite reading them against each other. Population:
            each business. Window: each close in this period. Basis: P&amp;L per account close, a
            rate. A close where the business has no account close draws a hollow tick, not a zero.
          </p>
        </section>

        {/* 7.4 Roster ------------------------------------------------- */}
        <section className="report-section">
          <h2>Algorithm roster: running, new, stopped, history</h2>
          <p className="muted">
            Counts and dates only. No money and no mean appears in this section, so that nothing
            here can be read as a verdict. Population: {roster.populationNote}
          </p>
          <p className="muted">{roster.stateNote}</p>
          <Refusal>{roster.newRefusal}</Refusal>
          {roster.thinLastCloseNote ? (
            <p className="desk-refusal"><strong>{roster.thinLastCloseNote}</strong></p>
          ) : null}

          <h3>Algorithm roster</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="The family and version exactly as the Strategies grid stores them. IFSP_PF is not IFSP and OGX_PF is not OGX. Population: every account not marked Inactive / Ignore. Window: the whole book. Basis: strategy rows and fills, traded attribution.">Algorithm</th>
                  <th scope="col" title={`Running, New, Stopped or Not seen, decided on the last close inside the period (${roster.lastClose}). Population: accounts not marked Inactive / Ignore. Window: this period against the whole book. Basis: presence on an account day, never account status.`}>State</th>
                  <th scope="col" title={`Distinct accounts carrying this algorithm on ${roster.lastClose}. Population: accounts reporting on that close. Window: one close. Basis: traded attribution, enabled at export or named on the fills.`}>Accounts on the last close</th>
                  <th scope="col" title="Distinct accounts carrying it on at least one close inside the period. Population: accounts not marked Inactive / Ignore. Window: this period. Basis: traded attribution.">Accounts in the period</th>
                  <th scope="col" title="One account, one close, counted once per close it carried this algorithm. Population: as the column before. Window: this period. Basis: traded attribution. Not calendar days.">Account days in the period</th>
                  <th scope="col" title="Closes inside the period on which at least one account carried it, out of the closes the period holds. Population: as the column before. Window: this period. Basis: traded attribution.">Closes present</th>
                  <th scope="col" title="The earliest close anywhere in the book on which any account carried it. Population: accounts not marked Inactive / Ignore. Window: the whole book. Basis: traded attribution.">First seen</th>
                  <th scope="col" title="The latest close anywhere in the book on which any account carried it. Population and basis as First seen. Window: the whole book.">Last seen</th>
                  <th scope="col" title="The contracts its account days traded, most account days first, by contract root rather than contract month. Population: as Account days. Window: this period. Basis: the instrument on the account's strategy rows.">Instruments</th>
                  <th scope="col" title="Whether My Futures Book publishes a series for this family, and whether its version matches the one this desk runs. Population: the imported benchmark series. Window: the benchmark's own history. Basis: the file's Strategy column. A benchmark is a backtest of one simulated account and is never compared with these columns.">Benchmark</th>
                </tr>
              </thead>
              <tbody>
                {roster.rows.map((row) => {
                  const coverageRow = benchmark.coverage.rows.find(
                    (entry) => entry.algorithm === row.family,
                  );
                  return (
                    <tr key={row.algorithm} className={row.state === 'Not seen' ? 'row-muted' : ''}>
                      <th scope="row">{row.algorithm}</th>
                      <td>{row.state}</td>
                      <td>{count(row.accountsOnLastClose)}</td>
                      <td>{count(row.accountsInPeriod)}</td>
                      <td>{count(row.accountDaysInPeriod)}</td>
                      <td>{`${count(row.closesPresent)} of ${count(row.closesInPeriod)}`}</td>
                      <td>{row.firstSeen}</td>
                      <td>{row.lastSeen}</td>
                      <td>{row.instruments.map((entry) => entry.name).join(', ') || '—'}</td>
                      <td className="muted" title={coverageRow?.seriesNote || ''}>
                        {coverageRow?.hasSeries
                          ? `${coverageRow.benchmarkVersion} · version ${coverageRow.versionMatch === 'yes' ? 'matches' : 'differs'}`
                          : 'No series'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3>Deployment over the period</h3>
          <DeploymentGrid rows={roster.rows} closes={period.closes} />
        </section>

        {/* 7.5 Results ------------------------------------------------ */}
        <section className="report-section">
          <h2>Algorithm results in this period</h2>
          <p className="muted">{results.basis.label}</p>

          <h3>Algorithm results in this period</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="Position by measured P&L per account day among the algorithms that clear the evidence gate in this period. Population: the ranked algorithms. Window: this period. Basis: means per reported account day. Blank where the row is not ranked.">Rank</th>
                  <th scope="col" title="Family as the Strategies grid stores it. Population: every account day this desk reported in the period. Window: this period. Basis: measured P&L, from the fills where they derive and the Strategies grid otherwise.">Algorithm</th>
                  <th scope="col" title={results.unitNote}>P&amp;L per account day</th>
                  <th scope="col" title="The interval around the mean, clustered on the account because the same account contributes many days. Population and window as the mean. Basis: a clustered mean over at least two accounts; one account carries no interval and says so.">95% interval</th>
                  <th scope="col" title="Reported account days behind the mean and its interval. Population: accounts running this algorithm. Window: this period. Basis: one account, one close, counted once per close the algorithm ran on it.">Account days</th>
                  <th scope="col" title="Distinct accounts behind the account days. Population and window as Account days. Basis: account identity, not client identity.">Accounts</th>
                  <th scope="col" title="Distinct clients behind the accounts. Population and window as Account days. Basis: client identity.">Clients</th>
                  <th scope="col" title="Account days with positive, negative and exactly zero measured P&L. Population and window as Account days. Basis: the sign of the measured figure. A flat day is a day it ran and made nothing, and it is in the denominator of the mean.">Up, down, flat</th>
                  <th scope="col" title="Up days as a share of up plus down days. Population: this algorithm's decided account days. Window: this period. Basis: the sign only. Flat days are excluded from this denominator and from no other.">Win rate on decided days</th>
                  <th scope="col" title="The share of its account days on which no other algorithm ran on the same account. Population and window as Account days. Basis: counts. Context for the mean and never a rule: a solo day's figure is close to the whole account's day and a stacked day's is a share of one.">Alone on the account day</th>
                  <th scope="col" title={results.instrumentCaveat}>Instruments and sizing</th>
                  <th scope="col" title={results.gate.note}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {results.rows.map((row) => (
                  <tr key={row.name} className={row.ranked ? '' : 'row-muted'}>
                    <td>{row.rank ?? ''}</td>
                    <th scope="row">{row.name}</th>
                    <td className={(row.meanPerAccountDay || 0) >= 0 ? 'report-positive' : 'report-negative'}>
                      {rate(row.meanPerAccountDay)}
                    </td>
                    <Cell
                      value={row.ci ? `${rate(row.ci.low)} to ${rate(row.ci.high)}` : null}
                      refusal={row.ciRefusal}
                    />
                    <td>{count(row.accountDays)}</td>
                    <td>{count(row.accounts)}</td>
                    <td>{count(row.clients)}</td>
                    <td>{`${count(row.upDays)} / ${count(row.downDays)} / ${count(row.flatDays)}`}</td>
                    <td>{percent(row.winRate)}</td>
                    <td>{percent(row.soloShare)}</td>
                    <td>
                      {[
                        row.instruments.map((entry) => entry.name).join(', '),
                        row.sizing.map((entry) => entry.name).join(', '),
                      ].filter(Boolean).join(' · ') || '—'}
                    </td>
                    {/* The gate's own counts, not its sentence. The sentence is
                        the cell's title and is printed in full under the table:
                        inside a twelve-column row it stacked one word per line
                        and made an unranked row six times the height of a
                        ranked one, which reads as emphasis. */}
                    <td className="muted" title={row.rankRefusal || results.gate.note}>
                      {row.ranked
                        ? 'Ranked'
                        : (
                          <>
                            <span className="badge">Not ranked</span>
                            <span className="muted">
                              {` ${count(row.accountDays)} of ${results.gate.minAccountDays} `}
                              {`account days, ${count(row.accounts)} of ${results.gate.minAccounts} accounts`}
                            </span>
                          </>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{results.unitNote}</p>
          <p className="muted">{results.instrumentCaveat}</p>
          <Refusal>{results.rows[0]?.moneyRefusal}</Refusal>

          {results.programmes.length ? (
            <>
              <h3>Programmes, measured separately</h3>
              <div className="table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th scope="col">Algorithm</th>
                      <th scope="col">What it is</th>
                      <th scope="col">Account days</th>
                      <th scope="col">Accounts</th>
                      <th scope="col">Clients</th>
                      <th scope="col">Where it is measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.programmes.map((programme) => (
                      <tr key={programme.name} className="row-muted">
                        <th scope="row">{programme.name}</th>
                        <td>{programme.what}</td>
                        <td>{count(programme.accountDays)}</td>
                        <td>{count(programme.accounts)}</td>
                        <td>{count(programme.clients)}</td>
                        <td className="muted">{programme.answeredBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {results.programmes.map((programme) => (
                <Refusal key={programme.name}>{programme.rankRefusal}</Refusal>
              ))}
            </>
          ) : null}

          <h3>P&amp;L per account day, with the interval around it</h3>
          {results.noRankNote ? (
            <p className="desk-refusal"><strong>{results.noRankNote}</strong></p>
          ) : (
            <>
              <IntervalChart rows={results.rows} />
              <p className="desk-refusal">
                <strong>
                  Compare the intervals, not the dots. Two intervals that overlap have not been
                  shown to differ, and two that do not overlap are a conservative test on data
                  where the same account contributes many days. Algorithms that did not clear the
                  gate in this period are listed above with their counts and are not drawn here.
                </strong>
              </p>
              <p className="muted">
                {results.unrankedCount
                  ? `Not drawn: ${results.rows.filter((row) => !row.ranked)
                    .map((row) => `${row.name} (${row.accountDays} account day${row.accountDays === 1 ? '' : 's'}, ${row.accounts} account${row.accounts === 1 ? '' : 's'})`)
                    .join(', ')}.`
                  : 'Every algorithm in this period clears the gate.'}
              </p>
            </>
          )}
        </section>

        {/* 7.6 Movement ----------------------------------------------- */}
        <section className="report-section">
          <h2>This period against the period before, and against the book</h2>
          <p className="muted">
            Three windows of the same function, so the columns cannot be three arithmetics.
            {' '}{movement.bookNote}
          </p>

          <h3>Movement</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="As the results table. Population: every account day this desk reported. Window: each column names its own. Basis: measured P&L per reported account day throughout.">Algorithm</th>
                  <th scope="col" title={`P&L per account day over this period, with the account days behind it. Population: accounts running this algorithm. Window: ${period.label}. Basis: measured P&L per reported account day.`}>This period</th>
                  <th scope="col" title={`The same figure over the period before. Population: as This period. Window: ${period.priorLabel}. Basis: identical. Blank with a reason when that period measured nothing for this algorithm.`}>The period before</th>
                  <th scope="col" title={`This period minus the period before, in dollars per account day. Population: as This period. Window: this period against the one before. Basis: a difference of two means, never of two totals. Withheld unless both windows clear the evidence gate.`}>Change</th>
                  <th scope="col" title={`P&L per account day over every close the book holds up to ${period.to}, with the account days behind it. Population: as This period. Window: the book’s first close to ${period.to}, which CONTAINS this period. Basis: identical.`}>Book to date</th>
                  <th scope="col" title="This period minus the book to date. Population: as This period. Window: this period against the book to date. Basis: a difference of two means. Withheld under the same gate as Change. Note that the book to date contains this period.">This period against the book</th>
                  <th scope="col" title="Moved up, Moved down, No change shown, or the reason no comparison is made. Population, window and basis as the columns it summarises. A change is called only when both windows clear the gate; nothing here is a forecast.">Reading</th>
                </tr>
              </thead>
              <tbody>
                {movement.rows.map((row) => (
                  <tr key={row.algorithm} className={row.drawable ? '' : 'row-muted'}>
                    <th scope="row">{row.algorithm}</th>
                    <Cell
                      value={row.periodMean === null ? null : `${rate(row.periodMean)} (${count(row.periodAccountDays)} account days)`}
                      refusal={row.periodRefusal}
                    />
                    <Cell
                      value={row.priorMean === null ? null : `${rate(row.priorMean)} (${count(row.priorAccountDays)} account days)`}
                      refusal={row.priorRefusal}
                    />
                    {/* The withholding is stated ONCE per row, in the Reading
                        column the table's last heading promises it in. The two
                        numeric cells carry it as their title so a reader who
                        lands on either is not left with a bare dash. */}
                    <Cell
                      value={row.change === null ? null : rate(row.change)}
                      refusal="Withheld"
                      title={row.changeRefusal}
                    />
                    <Cell
                      value={row.bookMean === null ? null : `${rate(row.bookMean)} (${count(row.bookAccountDays)} account days)`}
                      refusal="Not measured anywhere in the book to this close."
                    />
                    <Cell
                      value={row.againstBook === null ? null : rate(row.againstBook)}
                      refusal="Withheld"
                      title={row.againstBookRefusal}
                    />
                    <td className={row.change === null ? 'muted' : ''}>{row.reading}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Where each algorithm moved</h3>
          {movement.drawable.length ? (
            <>
              <SlopeChart
                rows={movement.drawable}
                periodLabel={period.label}
                priorLabel={period.priorLabel}
              />
              <p className="muted">
                {movement.notDrawable.length
                  ? `Not drawn, because one window or both fall under the evidence gate: `
                    + `${movement.notDrawable.map((row) => `${row.algorithm} (${row.periodAccountDays} account days here, ${row.priorAccountDays} then)`).join(', ')}.`
                  : 'Every algorithm clears the gate in both windows.'}
              </p>
            </>
          ) : (
            <p className="desk-refusal">
              <strong>
                {period.priorEmpty
                  ? 'The period before holds no close, so no algorithm can be drawn between two windows.'
                  : 'No algorithm clears the evidence gate in both windows, so nothing is drawn here. '
                    + 'The table above carries every row with its counts.'}
              </strong>
            </p>
          )}
        </section>

        {/* 7.7 Stack -------------------------------------------------- */}
        <section className="report-section">
          <h2>The stack: what combinations of algorithms did on funded client accounts</h2>
          <p className="muted">
            {`Funded accounts, failed ones included, over each account's own alive range · `}
            {`${count(stack.perf.population.includedDays)} attributed of `}
            {`${count(stack.perf.population.fundedDays)} funded account days · `}
            {`${count(stack.perf.population.accounts)} accounts · `}
            {`${count(stack.perf.population.clients)} clients · traded attribution at version level`}
          </p>
          <p className="muted">{stack.sampleGateNote}</p>

          <h3>Combinations in this period</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title={`Where this combination sat in the previous period's table, by average per account day among rows that cleared the sample gate. Population: funded accounts, same as this table. Window: ${period.priorLabel}. Basis: identical. New when the combination has no gated row in that period, and the two ranks are not a trend: a combination's population changes between periods.`}>Rank last period</th>
                  <th scope="col" title="The algorithms running together on an account day, at version level. Population: funded accounts. Window: this period. Basis: traded attribution.">Combo</th>
                  <th scope="col" title="First and last close inside this period on which this combination was seen. Population: funded accounts. Window: this period. Basis: account snapshot dates.">Range</th>
                  <th scope="col" title="One account, one close. Population: funded accounts running this combination. Window: this period. Basis: account snapshot rows.">Account days</th>
                  <th scope="col" title="Account days on which the account's P&L was not exactly zero. Population and window as Account days. Basis: the sign of the day's figure.">Traded days</th>
                  <th scope="col" title="Distinct accounts behind the account days. Population and window as Account days. Basis: account identity.">Accounts</th>
                  <th scope="col" title="Distinct clients behind the accounts. Population and window as Account days. Basis: client identity.">Clients</th>
                  <th scope="col" title="Total P&L divided by account days. One account day, one vote. Population: funded accounts running this combination. Window: this period. Basis: realized net of commission where the grid reported it, gross otherwise.">Avg P&amp;L per account day</th>
                  <th scope="col" title="Total P&L divided by traded days. Population and window as Avg per account day. Basis: the same figure over a smaller denominator, which is why the two columns differ.">Avg P&amp;L per traded day</th>
                  <th scope="col" title="Winning days as a share of traded days. Population and window as Traded days. Basis: the sign of the day's figure. Flat days are excluded from this denominator.">Win rate on traded days</th>
                  <th scope="col" title="Account days on which the account made exactly nothing. Population and window as Account days. Basis: the sign. In the denominator of Avg per account day and of no other figure here.">Flat days</th>
                  <th scope="col" title="The second half of the window against the first, as means per account day, with a bar of a tenth of the first half's magnitude. Population and window as Account days. Basis: halves of this window, each needing 5 account days.">Trend in window</th>
                  <th scope="col" title={stack.sampleGateNote}>Sample</th>
                </tr>
              </thead>
              <tbody>
                {stack.rows.map((row) => (
                  <tr key={row.key} className={row.lowSample ? 'row-muted' : ''}>
                    <Cell value={row.rankLastPeriod} refusal={row.rankLastPeriodRefusal} />
                    <th scope="row">{row.key}</th>
                    <td>{`${row.firstDate} to ${row.lastDate}`}</td>
                    <td>{count(row.days)}</td>
                    <td>{count(row.tradedDays)}</td>
                    <td>{count(row.accounts)}</td>
                    <td>{count(row.clients)}</td>
                    <td className={row.avgPnl >= 0 ? 'report-positive' : 'report-negative'}>
                      {rate(row.avgPnl)}
                    </td>
                    <Cell value={row.avgTradedPnl === null ? null : rate(row.avgTradedPnl)} refusal="No traded day." />
                    <td>{row.winRate === null ? '—' : `${Math.round(row.winRate * 100)}%`}</td>
                    <td>{count(row.flatDays)}</td>
                    <td>{row.trend}</td>
                    <td>{row.lowSample ? <span className="badge">Low sample</span> : 'Gated'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stack.best ? (
            <p className="muted">{`Best gated combination: ${stack.best.key}.`}</p>
          ) : (
            <p className="desk-refusal"><strong>{stack.bestNote}</strong></p>
          )}
          <p className="muted">{stack.rankNote}</p>

          <h3>Average per account day by combination</h3>
          <ComboBarChart rows={stack.rows} />
        </section>

        {/* 7.8 Changes ------------------------------------------------- */}
        <section className="report-section">
          <h2>What changed on the accounts in this period</h2>
          <p className="muted">
            Performance that moved with no configuration change is noise. Performance that moved
            with one is a decision somebody made. This section is the decisions. {changes.note}
          </p>

          <h3>Combination changes</h3>
          <p className="muted">
            {`${count(changes.counts.decisions)} change${changes.counts.decisions === 1 ? '' : 's'} `}
            {`over ${count(changes.counts.accounts)} accounts. ${changes.sidesNote}`}
          </p>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="The first close on which the account's combination differed from its previous close. Population: accounts in scope with at least two closes. Window: this period. Basis: traded attribution at version level.">Date</th>
                  <th scope="col" title="The client the account belongs to. Population and window as Date. Basis: the client record.">Client</th>
                  <th scope="col" title="The account's alias where it has one, otherwise its name. Population and window as Date. Basis: the account registry.">Account</th>
                  <th scope="col" title="The combination on the close before. Population and window as Date. Basis: traded attribution, enabled at export or named on the fills.">From</th>
                  <th scope="col" title="The combination on this close. Population, window and basis as From.">To</th>
                  <th scope="col" title="Closes this account has filed on the new combination, up to the end of the period. Population: this account. Window: the change date to the end of the period. Basis: account snapshot rows.">Account days since</th>
                  <th scope="col" title="This account's own P&L per account day on each side of the change. Population: this one account. Window: its closes inside this period on each side. Basis: realized net of commission where the grid reported it, gross otherwise. Withheld unless each side holds at least 5 account days.">Per account day before and after</th>
                </tr>
              </thead>
              <tbody>
                {shownChanges.map((row) => (
                  <tr key={`${row.clientId}-${row.accountName}-${row.date}`}>
                    <td>{row.date}</td>
                    <td>{row.clientName}</td>
                    <td>{row.accountAlias || row.accountName}</td>
                    <td>{row.from}</td>
                    <td>{row.to}</td>
                    <td>{count(row.accountDaysSince)}</td>
                    <Cell
                      value={row.perAccountDayBefore === null
                        ? null
                        : `${rate(row.perAccountDayBefore)} → ${rate(row.perAccountDayAfter)}`}
                      refusal={row.sidesRefusal}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {changes.rows.length > shownChanges.length ? (
            <button
              className="ghost-button no-print"
              type="button"
              onClick={() => setChangesOpen(true)}
            >
              {`Show all ${changes.rows.length} changes`}
            </button>
          ) : null}
          <p className="muted">{changes.attributionNote}</p>

          <h3>Configuration drift open at the end of the period</h3>
          <p className="muted">{changes.driftWindowNote}</p>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="The algorithm family and the contract its cohort trades. Population: accounts carrying it on the last close inside this period. Window: that close. Basis: the Strategies grid parameters.">Algorithm and contract</th>
                  <th scope="col" title="The configuration most of the cohort runs. Population: this cohort. Window: the last close inside this period. Basis: the grid parameters, normalised.">Dominant configuration</th>
                  <th scope="col">Accounts on it</th>
                  <th scope="col">Outlier configuration</th>
                  <th scope="col">Accounts on it</th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {changes.drift.flatMap((row) => row.outliers.map((outlier, index) => (
                  // Two outliers of one cohort can carry the same label when
                  // they differ outside the fields the label shows, so the
                  // index is part of the key.
                  <tr key={`${row.family}-${row.instrument}-${index}-${outlier.label}`}>
                    <th scope="row">{`${row.family} · ${row.instrument}`}</th>
                    <td>{row.dominant.label}</td>
                    <td>{`${count(row.dominant.count)} of ${count(row.cohort)}`}</td>
                    <td>{outlier.label}</td>
                    <td>{count(outlier.count)}</td>
                    <td className="muted">
                      {outlier.changes.length
                        ? outlier.changes
                          .map((change) => `${change.name} ${change.from ?? 'not set'} → ${change.to ?? 'not set'}`)
                          .join(', ')
                        : 'The two configurations differ outside the fields this table shows.'}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 7.9 Benchmark ---------------------------------------------- */}
        <section className="report-section">
          <h2>{`My Futures Book, measured separately (${benchmark.riskLevel} risk)`}</h2>
          <p className="desk-refusal"><strong>{benchmark.separation}</strong></p>
          {onImportBenchmark ? (
            <div className="no-print period-benchmark-import">
              <label className="period-field">
                <span>Import benchmark files</span>
                <input
                  type="file"
                  accept=".csv"
                  multiple
                  onChange={(event) => onImportBenchmark(event.target.files)}
                />
              </label>
              {benchmarkImport && benchmarkImport.accepted ? (
                <span className="muted">
                  {`${benchmarkImport.accepted} file${benchmarkImport.accepted === 1 ? '' : 's'} read, `}
                  {`${benchmark.coverage.seriesCount} series. They are read in this browser and `}
                  {'are not saved with the report.'}
                </span>
              ) : null}
              {/* A refused file is named with the sentence that refused it. A
                  file dropped in silence is a row missing from every table
                  below with nothing on screen to say so. */}
              {(benchmarkImport?.rejected || []).map((entry) => (
                <p className="desk-refusal" key={entry.fileName}>
                  <strong>{entry.fileName}</strong>{`: ${entry.reason}`}
                </p>
              ))}
            </div>
          ) : null}
          {benchmark.imported ? null : <p className="muted">{benchmark.emptyReason}</p>}

          <h3>Benchmark coverage</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="The family as this desk's Strategies grid stores it. Population: the roster above. Window: this period. Basis: traded attribution.">Algorithm</th>
                  <th scope="col" title="Whether a My Futures Book file has been imported for this family. Population: imported benchmark files. Window: the file's own history. Basis: the file's Strategy column.">Benchmark series</th>
                  <th scope="col" title="The version this desk runs against the version the benchmark file was produced from. Population: as the two columns before. Window: this period here, the file's whole history there. Basis: the Strategies grid here, the Strategy column there. A version mismatch makes the two series different algorithms.">Version here and there</th>
                  <th scope="col" title="The contract this desk's strategy rows show against the contract in the file. Population, window and basis as the column before. A different contract is a different measurement, not a different result.">Instrument here and there</th>
                  <th scope="col" title="The sizings the imported files carry. Population: imported files for this family. Window: the file's history. Basis: the Qty column, which varies within a file as the strategy scales, so a risk level is a base size and not a fixed one.">Risk levels available</th>
                  <th scope="col" title="Days inside this period on which the benchmark file closed at least one trade. Population: one benchmark file at one risk level. Window: this period. Basis: exit time. A day with no trade is absent, not zero.">Benchmark days in this period</th>
                  <th scope="col" title="Closes this desk holds inside this period on which the algorithm ran here AND the benchmark closed a trade there. Population: both series. Window: this period. Basis: the intersection of the two sets of dates.">Closes in common</th>
                  <th scope="col" title={`Whether the two series can be compared at all. Population: as Closes in common. Window: this period. Basis: at least ${benchmark.minCommonCloses} closes in common are needed before any agreement figure is stated. See the sentence under this table.`}>Comparison</th>
                </tr>
              </thead>
              <tbody>
                {benchmark.coverage.rows.map((row) => (
                  <tr key={row.algorithm} className={row.hasSeries ? '' : 'row-muted'}>
                    <th scope="row">{row.algorithm}</th>
                    <td className="muted" title={row.seriesNote || ''}>
                      {row.hasSeries ? 'Imported' : 'No series'}
                    </td>
                    <td>{row.hasSeries ? `${row.version || '—'} / ${row.benchmarkVersion}` : '—'}</td>
                    <td title={row.instrumentNote || ''}>
                      {row.hasSeries
                        ? `${row.instrumentsHere.join(', ') || '—'} / ${row.instrumentsThere.join(', ')}`
                        : '—'}
                    </td>
                    <td>{row.riskLevelsAvailable.join(', ') || '—'}</td>
                    <td>{row.hasSeries ? count(row.benchmarkDays) : '—'}</td>
                    <td>{row.hasSeries ? count(row.commonCloses) : '—'}</td>
                    <td className="muted">{row.comparisonRefusal || 'Comparable'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {benchmark.coverage.neverDeployed.length ? (
            <>
              <h3>Benchmarked, never deployed</h3>
              <div className="table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th scope="col">Algorithm</th>
                      <th scope="col">Version</th>
                      <th scope="col">Instrument</th>
                      <th scope="col">Risk levels available</th>
                      <th scope="col">Benchmark history</th>
                    </tr>
                  </thead>
                  <tbody>
                    {benchmark.coverage.neverDeployed.map((row) => (
                      <tr key={row.algorithm} className="row-muted">
                        <th scope="row">{row.algorithm}</th>
                        <td>{row.version}</td>
                        <td>{row.instrument}</td>
                        <td>{row.riskLevelsAvailable.join(', ')}</td>
                        <td>{`${row.firstDate} to ${row.lastDate}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <p className="desk-refusal"><strong>{benchmark.coverage.refusal}</strong></p>

          <h3>Benchmark series in this period</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" title="As published in the benchmark file's Strategy column. Population: one file. Window: this period. Basis: My Futures Book backtest. One simulated account, algorithm alone.">Algorithm and version</th>
                  <th scope="col" title="Low, Medium or High, which is a base position size, not a different strategy. Population: one file. Window: the file's history. Basis: the Qty column, which varies within the file.">Risk level</th>
                  <th scope="col" title="The contract the backtest traded. Population, window and basis as Algorithm and version.">Instrument</th>
                  <th scope="col" title="Days inside this period on which the backtest closed at least one trade. Population: one file. Window: this period. Basis: exit time. Days with no trade are absent and are not zeros.">Days with a trade</th>
                  <th scope="col" title="Round turns closed inside this period. Population, window and basis as Days with a trade.">Trades</th>
                  <th scope="col" title="Sum of the Profit column, which is already net of the separate Commission column. Population: one file. Window: this period. Basis: My Futures Book backtest, one simulated account. Not client money and not comparable with any other table in this report.">Backtest net in the period</th>
                  <th scope="col" title="The backtest net divided by days with a trade. Population, window and basis as the column before. Its denominator is days with a trade, which is not the account day this report's other rates divide by.">Backtest net per day with a trade</th>
                </tr>
              </thead>
              <tbody>
                {benchmark.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" title={row.basis}>{`${row.algorithm} ${row.version}`}</th>
                    <td>{row.riskLevel}</td>
                    <td>{row.instrument}</td>
                    <td>{count(row.daysWithATrade)}</td>
                    <td>{count(row.trades)}</td>
                    <td title={row.basis}>{money(row.netProfit)}</td>
                    <td title={row.basis}>{rate(row.netPerDayWithATrade)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {benchmark.curves.length ? (
            <>
              <h3>{`Benchmark cumulative net, ${period.to.slice(0, 4)} to date (${benchmark.riskLevel} risk)`}</h3>
              <BenchmarkCurves curves={benchmark.curves} period={period} />
            </>
          ) : null}
        </section>

        {/* 7.10 Method ------------------------------------------------ */}
        <section className="report-section">
          <h2>Method, populations, and what this report refuses</h2>

          <h3>Definitions</h3>
          <dl className="period-definitions">
            {definitions.map((entry) => (
              <div key={entry.term}>
                <dt>{entry.term}</dt>
                <dd>{entry.meaning}</dd>
              </div>
            ))}
          </dl>

          <h3>What this report refuses to state</h3>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  <th scope="col">Value</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {refusals.map((entry) => (
                  <tr key={entry.figure}>
                    <th scope="row">{entry.figure}</th>
                    <td className="muted">{entry.value}</td>
                    <td className="muted">{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{scope.deskWideNote}</p>
        </section>
      </div>
    </div>
  );
}
