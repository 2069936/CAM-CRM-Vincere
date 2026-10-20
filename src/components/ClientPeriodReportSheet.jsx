import {
  dayLabel,
  fmtCount,
  fmtMoney,
  fmtShort,
} from '../domain/clientPeriodReport';
import { BalanceSparkline, CombinedBalanceLine, DailyPnlBars } from './ClientPeriodReportCharts';

/**
 * The client period report, rendered from `buildClientPeriodReport`.
 *
 * It renders and decides nothing: every figure, every gap and every sentence
 * that states a fact comes from the domain module, where it is tested. The
 * order is the reading order the report was designed in, coverage first: what
 * the report is built from, then the totals, then the breakdown by account and
 * by algorithm, then the day by day record, then the simulated accounts
 * that are in none of it.
 *
 * Everything here is inside the `.report-sheet` the PDF is made from, and
 * nothing here is `.no-print`: the controls live in the panel's action bar.
 */

const tone = (value) => {
  if (value == null) return 'cpr-muted';
  if (value > 0) return 'cpr-pos';
  if (value < 0) return 'cpr-neg';
  return 'cpr-muted';
};

function Money({ value, sign = false, empty = 'n/a' }) {
  if (value == null) return <span className="cpr-muted">{empty}</span>;
  return <span className={sign ? tone(value) : undefined}>{fmtMoney(value, { sign })}</span>;
}

function Header({ header }) {
  return (
    <header className="cpr-head">
      <div className="cpr-brandline">
        <span className="cpr-firm">{header.firm}</span>
        <span className="cpr-stamp">
          {`Built ${header.builtAt}`}
          {header.lastClose ? ` · last close ${header.lastClose}` : ''}
        </span>
      </div>
      <h1>{header.title}</h1>
      <div className="cpr-who">
        <span>Client <b>{header.clientName}</b></span>
        {header.accountManager ? <span>Account manager <b>{header.accountManager}</b></span> : null}
        <span>Period <b>{header.periodText}</b></span>
      </div>
    </header>
  );
}

function Coverage({ coverage }) {
  const accountsDetail = coverage.accounts && coverage.accountsEveryClose === coverage.accounts
    ? 'real money, all reporting'
    : `real money, ${fmtCount(coverage.accountsEveryClose)} reporting every close`;
  const cells = [
    ['Daily closes', fmtCount(coverage.loadedCloses), `of ${fmtCount(coverage.tradingDays)} trading ${coverage.tradingDays === 1 ? 'day' : 'days'}`],
    ['Accounts', fmtCount(coverage.accounts), accountsDetail],
    ['Algorithms', fmtCount(coverage.algorithms), 'loaded in the period'],
    [
      'Algorithm account days',
      fmtCount(coverage.algorithmAccountDays),
      coverage.unsplitAccountDays ? `${fmtCount(coverage.unsplitAccountDays)} not split` : 'measured',
    ],
    coverage.fills == null
      ? ['Fills', 'n/a', 'not loaded for every close']
      : ['Fills', fmtCount(coverage.fills), 'executions recorded'],
  ];
  if (coverage.evaluationAccounts) {
    cells.splice(2, 0, ['Evaluation accounts', fmtCount(coverage.evaluationAccounts), 'listed, not in the totals']);
  }
  return (
    <section className="cpr-section" aria-labelledby="cpr-coverage">
      <h2 id="cpr-coverage">What this report is built from</h2>
      <p className="cpr-sub">Every figure below is computed from these daily closes. A trading day without a close is shown as a gap, never as zero.</p>
      <dl className="cpr-coverage">
        {cells.map(([label, value, detail]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}<small>{detail}</small></dd>
          </div>
        ))}
      </dl>
      {coverage.sentences.map((sentence) => <p className="cpr-coverage-note" key={sentence}>{sentence}</p>)}
    </section>
  );
}

function Summary({ report }) {
  const { summary } = report;
  const sub = [
    'Real money accounts only.',
    report.evaluations ? 'Evaluation accounts are listed with the accounts and are not included here.' : '',
    report.simulation ? 'Simulated accounts are listed separately at the end and are not included here.' : '',
  ].filter(Boolean).join(' ');
  if (!summary) {
    return (
      <section className="cpr-section" aria-labelledby="cpr-summary">
        <h2 id="cpr-summary">Summary</h2>
        <p className="cpr-sub">{sub}</p>
        <p className="cpr-empty">No close in this period carries a figure for these accounts, so there is no summary.</p>
      </section>
    );
  }
  const otherDays = [
    summary.daysWithLoss ? `${fmtCount(summary.daysWithLoss)} with a loss` : '',
    summary.daysFlat ? `${fmtCount(summary.daysFlat)} with no realized P&L` : '',
  ].filter(Boolean).join(', ');
  const kpis = [
    {
      label: 'Realized P&L',
      value: <span className={tone(summary.realized)}>{fmtMoney(summary.realized, { sign: true })}</span>,
      detail: `${fmtCount(summary.closesWithTrades)} of ${fmtCount(summary.closes)} closes with trades`
        + (summary.closesTradeUnknown ? `, fills not loaded for ${fmtCount(summary.closesTradeUnknown)}` : ''),
    },
    {
      label: 'Combined balance',
      value: summary.balanceEnd == null ? 'n/a' : fmtMoney(summary.balanceEnd),
      detail: summary.balanceStart == null
        ? ''
        : (
          <>
            {`from ${fmtMoney(summary.balanceStart)} · `}
            <span className={tone(summary.balanceChange)}>{fmtMoney(summary.balanceChange, { sign: true })}</span>
          </>
        ),
    },
    {
      label: 'Days with a gain',
      value: `${fmtCount(summary.daysWithGain)} of ${fmtCount(summary.closes)}`,
      detail: otherDays || 'every close with a gain',
    },
    {
      label: 'Best and worst day',
      value: (
        <>
          <span className={tone(summary.best.realized)}>{fmtShort(summary.best.realized)}</span>
          {' '}<span className="cpr-muted">/</span>{' '}
          <span className={tone(summary.worst.realized)}>{fmtShort(summary.worst.realized)}</span>
        </>
      ),
      detail: `${dayLabel(summary.best.date)} and ${dayLabel(summary.worst.date)}`,
    },
  ];
  return (
    <section className="cpr-section" aria-labelledby="cpr-summary">
      <h2 id="cpr-summary">Summary</h2>
      <p className="cpr-sub">{sub}</p>
      <div className="cpr-kpis">
        {kpis.map((kpi) => (
          <div className="cpr-kpi" key={kpi.label}>
            <span className="cpr-kpi-label">{kpi.label}</span>
            <span className="cpr-kpi-value">{kpi.value}</span>
            <span className="cpr-kpi-detail">{kpi.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DayByDay({ report }) {
  return (
    <section className="cpr-section" aria-labelledby="cpr-days">
      <h2 id="cpr-days">Day by day</h2>
      <div className="cpr-charts">
        <div className="cpr-chart">
          <p className="cpr-chart-title">Realized P&amp;L per day</p>
          <p className="cpr-chart-sub">All real money accounts combined</p>
          <DailyPnlBars days={report.days} />
        </div>
        <div className="cpr-chart">
          <p className="cpr-chart-title">Combined balance at each close</p>
          <p className="cpr-chart-sub">
            {report.start.basis === 'prior'
              ? 'Sum of the account balances reported at the daily close, from the close before the period'
              : 'Sum of the account balances reported at the daily close'}
          </p>
          <CombinedBalanceLine points={report.balanceLine} />
        </div>
      </div>
    </section>
  );
}

function BufferCell({ buffer }) {
  if (!buffer || buffer.value == null) return <span className="cpr-muted">n/a</span>;
  return (
    <>
      {fmtMoney(buffer.value)}
      {buffer.limit ? <span className="cpr-muted">{` of ${fmtShort(buffer.limit)}`}</span> : null}
    </>
  );
}

function AccountRow({ row }) {
  const notes = [];
  if (row.startSource === 'first' && row.startDate) notes.push(`first close ${dayLabel(row.startDate)}`);
  if (!row.endIsLastClose) notes.push(`last close ${dayLabel(row.endDate)}`);
  return (
    <tr>
      <td>
        <span className="cpr-strong">{row.alias}</span>
        {notes.length ? <span className="cpr-meta">{notes.join(' · ')}</span> : null}
      </td>
      <td className="cpr-muted">{row.type}</td>
      <td>{fmtMoney(row.start)}</td>
      <td>{fmtMoney(row.end)}</td>
      <td className={tone(row.change)}>{fmtMoney(row.change, { sign: true })}</td>
      <td className={tone(row.realized)}>{fmtMoney(row.realized, { sign: true })}</td>
      <td><BufferCell buffer={row.buffer} /></td>
      <td className="cpr-spark-cell"><BalanceSparkline series={row.series} /></td>
    </tr>
  );
}

function AccountTable({ block, totalLabel }) {
  return (
    <div className="cpr-table-scroll">
      <table className="cpr-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th>Start</th>
            <th>End</th>
            <th>Change</th>
            <th>Realized P&amp;L</th>
            <th>Buffer to limit</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => <AccountRow row={row} key={row.key} />)}
        </tbody>
        {block.totals ? (
          <tfoot>
            <tr>
              <td>{totalLabel}</td>
              <td />
              <td>{fmtMoney(block.totals.start)}</td>
              <td>{fmtMoney(block.totals.end)}</td>
              <td className={tone(block.totals.change)}>{fmtMoney(block.totals.change, { sign: true })}</td>
              <td className={tone(block.totals.realized)}>{fmtMoney(block.totals.realized, { sign: true })}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function Accounts({ report }) {
  const { accounts, evaluations } = report;
  const left = [];
  if (accounts.excluded.ignored) {
    left.push(`${fmtCount(accounts.excluded.ignored)} account${accounts.excluded.ignored === 1 ? '' : 's'} marked inactive`);
  }
  if (accounts.excluded.retired) {
    left.push(`${fmtCount(accounts.excluded.retired)} account${accounts.excluded.retired === 1 ? '' : 's'} that failed before this period`);
  }
  return (
    <section className="cpr-section" aria-labelledby="cpr-accounts">
      <h2 id="cpr-accounts">Accounts</h2>
      <p className="cpr-sub">Balance at the start and at the last close of the period. For prop accounts, the buffer is the distance left to the firm&apos;s drawdown limit at the last close.</p>
      {accounts.rows.length
        ? <AccountTable block={accounts} totalLabel="Total" />
        : <p className="cpr-empty">No funded, cash or other real money account reported in this period.</p>}
      {evaluations ? (
        <div className="cpr-subblock">
          <h3>Evaluation accounts</h3>
          <p className="cpr-sub">Challenge accounts. Listed for reference and not included in any total, chart or algorithm figure.</p>
          <AccountTable block={evaluations} totalLabel="Evaluation subtotal" />
        </div>
      ) : null}
      {left.length ? <p className="cpr-coverage-note">{`Not shown: ${left.join(' and ')}.`}</p> : null}
    </section>
  );
}

function ShareBar({ value, maxAbs }) {
  const width = maxAbs ? (Math.abs(value) / maxAbs) * 50 : 0;
  const left = value >= 0 ? 50 : 50 - width;
  return (
    <div className="cpr-hbar">
      <span className="cpr-hbar-axis" />
      <span
        className={value >= 0 ? 'cpr-hbar-fill cpr-fill-pos' : 'cpr-hbar-fill cpr-fill-neg'}
        style={{ left: `${Math.round(left * 10) / 10}%`, width: `${Math.round(width * 10) / 10}%` }}
      />
    </div>
  );
}

function Algorithms({ report }) {
  const { rows, charges, unattributed, unsplit } = report.algorithms;
  const showUnsplit = rows.some((row) => row.unsplitAccountDays > 0);
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.realized)));
  // Every dollar of the accounts' realized P&L is on one of these rows: an
  // algorithm's own trades, the account charges (the firm's fees and any trade
  // no algorithm placed), or an account day with no algorithm at all.
  const showCharges = Boolean(charges?.accountDays);
  const showUnattributed = Boolean(unattributed?.accountDays);
  const showUnsplitRow = Boolean(unsplit?.accountDays);
  const columns = showUnsplit ? 9 : 8;
  return (
    <section className="cpr-section" aria-labelledby="cpr-algorithms">
      <h2 id="cpr-algorithms">Performance by algorithm</h2>
      <p className="cpr-sub">Each algorithm&apos;s own realized P&amp;L on this client&apos;s accounts. An account day counts when the algorithm was loaded on that account at the close.</p>
      {rows.length ? (
        <div className="cpr-table-scroll">
          <table className="cpr-table">
            <thead>
              <tr>
                <th>Algorithm</th>
                <th>Account days</th>
                <th>Days traded</th>
                <th>Days with a gain</th>
                <th>Fills</th>
                <th>Per account day</th>
                <th>Realized P&amp;L</th>
                {showUnsplit ? <th>Not split</th> : null}
                <th className="cpr-bar-cell">Share of the result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <span className="cpr-strong">{row.key}</span>
                    <span className="cpr-meta">
                      {[row.instruments.join(', '), `${fmtCount(row.accounts)} account${row.accounts === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td>{fmtCount(row.accountDays)}</td>
                  <td>{fmtCount(row.daysTraded)}</td>
                  <td>{`${fmtCount(row.daysWithGain)} of ${fmtCount(row.daysTraded)}`}</td>
                  <td>{row.fills == null ? <span className="cpr-muted">not loaded</span> : fmtCount(row.fills)}</td>
                  <td><Money value={row.perAccountDay} sign /></td>
                  <td className={tone(row.realized)}><b>{fmtMoney(row.realized, { sign: true })}</b></td>
                  {showUnsplit ? <td>{row.unsplitAccountDays ? fmtCount(row.unsplitAccountDays) : <span className="cpr-muted">0</span>}</td> : null}
                  <td className="cpr-bar-cell"><ShareBar value={row.realized} maxAbs={maxAbs} /></td>
                </tr>
              ))}
              {showCharges ? (
                <tr className="cpr-charges-row">
                  <td>
                    <span className="cpr-strong">Fees and other account charges</span>
                    <span className="cpr-meta">{`${fmtCount(charges.accountDays)} account ${charges.accountDays === 1 ? 'day' : 'days'}, not placed by an algorithm`}</span>
                  </td>
                  <td colSpan={5} />
                  <td className={tone(charges.realized)}><b>{fmtMoney(charges.realized, { sign: true })}</b></td>
                  <td colSpan={columns - 7} />
                </tr>
              ) : null}
              {showUnsplitRow ? (
                <tr className="cpr-charges-row">
                  <td>
                    <span className="cpr-strong">Not split between algorithms</span>
                    <span className="cpr-meta">{`${fmtCount(unsplit.accountDays)} account ${unsplit.accountDays === 1 ? 'day' : 'days'} whose algorithms' own figures could not be read`}</span>
                  </td>
                  <td colSpan={5} />
                  <td className={tone(unsplit.realized)}><b>{fmtMoney(unsplit.realized, { sign: true })}</b></td>
                  <td colSpan={columns - 7} />
                </tr>
              ) : null}
              {showUnattributed ? (
                <tr className="cpr-charges-row">
                  <td>
                    <span className="cpr-strong">No algorithm loaded</span>
                    <span className="cpr-meta">{`${fmtCount(unattributed.accountDays)} account ${unattributed.accountDays === 1 ? 'day' : 'days'} with a result and no algorithm`}</span>
                  </td>
                  <td colSpan={5} />
                  <td className={tone(unattributed.realized)}><b>{fmtMoney(unattributed.realized, { sign: true })}</b></td>
                  <td colSpan={columns - 7} />
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <td>All real money accounts</td>
                <td colSpan={5} />
                <td className={tone(report.summary?.realized)}>{report.summary ? fmtMoney(report.summary.realized, { sign: true }) : ""}</td>
                <td colSpan={columns - 7} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : <p className="cpr-empty">No algorithm was loaded on these accounts in this period.</p>}
    </section>
  );
}

const CELL_TITLE = {
  noClose: 'no close',
  missing: 'account figures not loaded',
  notLoaded: 'not loaded',
};

function heatCellProps(cell, heatMax) {
  const when = dayLabel(cell.date, { long: true });
  if (cell.state === 'noClose' || cell.state === 'missing') {
    return { className: 'cpr-heat-cell cpr-noclose', title: `${when}: ${CELL_TITLE[cell.state]}` };
  }
  if (cell.state === 'notLoaded') {
    return { className: 'cpr-heat-cell cpr-notloaded', title: `${when}: not loaded` };
  }
  const fills = cell.fills == null ? 'fills not loaded' : `${fmtCount(cell.fills)} fill${cell.fills === 1 ? '' : 's'}`;
  if (cell.state === 'unsplit') {
    const known = cell.realized ? `, ${fmtMoney(cell.realized, { sign: true })} on the other accounts` : '';
    return {
      className: 'cpr-heat-cell cpr-unsplit',
      title: `${when}: loaded with another algorithm on ${fmtCount(cell.unsplit)} account${cell.unsplit === 1 ? '' : 's'}, own figures not available${known}, ${fills}`,
    };
  }
  if (cell.state === 'quiet') {
    return { className: 'cpr-heat-cell cpr-quiet', title: `${when}: loaded, no realized P&L, ${fills}` };
  }
  const alpha = (0.18 + 0.72 * Math.min(1, Math.abs(cell.realized) / (heatMax || 1))).toFixed(2);
  return {
    className: `cpr-heat-cell ${cell.state === 'gain' ? 'cpr-gain' : 'cpr-loss'}`,
    style: { backgroundColor: cell.state === 'gain' ? `rgba(17, 128, 74, ${alpha})` : `rgba(194, 58, 47, ${alpha})` },
    title: `${when}: ${fmtMoney(cell.realized, { sign: true })}, ${fills}`,
  };
}

function Activity({ report }) {
  const { rows, heatMax } = report.algorithms;
  const days = report.days;
  const every = days.length > 10 ? 5 : 1;
  // Narrower columns for a longer window, so a quarter still fits the 725px
  // of a printed page instead of running off its edge.
  const minColumn = Math.max(4, Math.min(14, Math.floor(560 / Math.max(1, days.length))));
  const labelColumn = days.length > 31 ? 110 : 150;
  const columns = { gridTemplateColumns: `${labelColumn}px repeat(${days.length}, minmax(${minColumn}px, 1fr))` };
  const anyUnsplit = rows.some((row) => row.cells.some((cell) => cell.state === 'unsplit'));
  const anyMissing = days.some((entry) => entry.state === 'missing');
  return (
    <section className="cpr-section" aria-labelledby="cpr-activity">
      <h2 id="cpr-activity">Algorithm activity</h2>
      <p className="cpr-sub">Realized P&amp;L of each algorithm, per day, across this client&apos;s accounts. Darker means a larger amount.</p>
      {rows.length ? (
        <>
          <div className="cpr-heat-scroll">
            <div className="cpr-heat">
              <div className="cpr-heat-row cpr-heat-head" style={columns}>
                <span className="cpr-heat-lab" />
                {days.map((entry, index) => (
                  <span className="cpr-heat-day" key={entry.date}>{index % every === 0 ? dayLabel(entry.date) : ''}</span>
                ))}
              </div>
              {rows.map((row) => (
                <div className="cpr-heat-row" style={columns} key={row.key}>
                  <span className="cpr-heat-lab">
                    <b>{row.key}</b>
                    {row.instruments.length ? <span className="cpr-muted">{` ${row.instruments.join(', ')}`}</span> : null}
                  </span>
                  {row.cells.map((cell) => <span key={cell.date} {...heatCellProps(cell, heatMax)} />)}
                </div>
              ))}
            </div>
          </div>
          <div className="cpr-legend">
            <span><i className="cpr-key cpr-gain-key" />Gain</span>
            <span><i className="cpr-key cpr-loss-key" />Loss</span>
            <span><i className="cpr-key cpr-quiet" />Loaded, no realized P&amp;L</span>
            {anyUnsplit ? <span><i className="cpr-key cpr-unsplit" />Loaded with another algorithm, own figures not available</span> : null}
            <span><i className="cpr-key cpr-noclose" />{anyMissing ? 'No close that day, or its figures were not loaded' : 'No close that day'}</span>
            <span>Blank space means the algorithm was not loaded.</span>
          </div>
        </>
      ) : <p className="cpr-empty">No algorithm was loaded on these accounts in this period.</p>}
    </section>
  );
}

function Running({ running }) {
  return (
    <section className="cpr-section" aria-labelledby="cpr-running">
      <h2 id="cpr-running">Running at the last close</h2>
      {running ? (
        <>
          <p className="cpr-sub">{`Algorithms loaded on this client's accounts at the close of ${dayLabel(running.date, { long: true })}.`}</p>
          {running.chips.length ? (
            <div className="cpr-chips">
              {running.chips.map((chip) => (
                <span className="cpr-chip" key={chip.key}>
                  <b>{chip.key}</b>
                  <span>{[chip.instruments.join(', '), chip.accounts.join(', ')].filter(Boolean).join(' · ')}</span>
                </span>
              ))}
            </div>
          ) : <p className="cpr-empty">No algorithm was loaded on these accounts at that close.</p>}
        </>
      ) : <p className="cpr-empty">No close in this period could be read, so nothing is shown as running.</p>}
    </section>
  );
}

const HOLE_ROW = {
  gap: 'No close this day',
  missing: 'Account figures not loaded for this close',
  noAccounts: 'No real money account reported at this close',
};

function DailyRecord({ days }) {
  const rows = [...days].reverse();
  return (
    <section className="cpr-section" aria-labelledby="cpr-record">
      <h2 id="cpr-record">Daily record</h2>
      <div className="cpr-table-scroll">
        <table className="cpr-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Realized P&amp;L</th>
              <th>Accounts with trades</th>
              <th>Fills</th>
              <th>Combined balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (entry.state !== 'close' ? (
              <tr key={entry.date}>
                <td>{dayLabel(entry.date, { long: true })}</td>
                <td colSpan={4} className="cpr-muted cpr-hole">{HOLE_ROW[entry.state]}</td>
              </tr>
            ) : (
              <tr key={entry.date}>
                <td>{dayLabel(entry.date, { long: true })}</td>
                <td className={tone(entry.realized)}>{fmtMoney(entry.realized, { sign: true })}</td>
                <td>
                  {entry.accountsTraded == null
                    ? <span className="cpr-muted">not loaded</span>
                    : `${fmtCount(entry.accountsTraded)} of ${fmtCount(entry.accountsReporting)}`}
                </td>
                <td>{entry.fills == null ? <span className="cpr-muted">not loaded</span> : fmtCount(entry.fills)}</td>
                <td>{fmtMoney(entry.balance)}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Simulation({ simulation, undetermined }) {
  if (!simulation && !undetermined.length) return null;
  return (
    <section className="cpr-section" aria-labelledby="cpr-simulation">
      <h2 id="cpr-simulation">{simulation ? 'Simulation*' : 'Accounts not included'}</h2>
      {simulation ? simulation.accounts.map((account) => (
        <div className="cpr-sim-row" key={account.name}>
          <span><b>{account.name}</b> <span className="cpr-muted">simulated account</span></span>
          <span>Realized P&amp;L <b className={tone(account.realized)}>{fmtMoney(account.realized, { sign: true })}</b></span>
          <span>Balance <b>{fmtMoney(account.balance)}</b></span>
          <span className="cpr-muted">Not included in any figure above.</span>
        </div>
      )) : null}
      {undetermined.length ? (
        <p className="cpr-coverage-note">
          {`Not included in any figure: ${undetermined.join(', ')}. `}
          {undetermined.length === 1
            ? 'This account could not be identified as real money or simulated funds.'
            : 'These accounts could not be identified as real money or simulated funds.'}
        </p>
      ) : null}
    </section>
  );
}

export default function ClientPeriodReportSheet({ report }) {
  if (!report) return null;
  return (
    <article className="cpr-body">
      <Header header={report.header} />
      <Coverage coverage={report.coverage} />
      <Summary report={report} />
      <DayByDay report={report} />
      <Accounts report={report} />
      <Algorithms report={report} />
      <Activity report={report} />
      <Running running={report.running} />
      <DailyRecord days={report.days} />
      <Simulation simulation={report.simulation} undetermined={report.undetermined} />
      <footer className="cpr-notes">
        {report.notes.map((note) => (
          <p key={note.term}><b>{note.term}</b>{` ${note.text}`}</p>
        ))}
      </footer>
    </article>
  );
}
