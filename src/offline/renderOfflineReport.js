/* ---------------------------------------------------------------------------
 * The offline report as HTML, for a browser on the machine to print.
 *
 * DELIBERATELY NOT A COPY OF THE CRM'S SHEET. ReportPanel is 515 lines inside
 * App.jsx and pulls charts, a design drawer and a server PDF endpoint; lifting
 * it would drag React, a chart library and a fetch to an API that is not
 * answering into a file that has to open from a folder with no network.
 *
 * What must not differ is the arithmetic, and that does not: every number here
 * comes from buildDailyReportSummary, the same function the CRM calls. What
 * differs is the paper. A client reading this gets the same money, laid out
 * more plainly, on a page that says where it came from.
 *
 * NO SCRIPT, NO FETCH, NO FONTS. The file is opened by double-clicking it on a
 * Windows VPS that may have no network at all, and printed with Ctrl+P.
 * ------------------------------------------------------------------------- */

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? MONEY.format(n) : '—';
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sign(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? ' pos' : ' neg';
}

/* WHAT RAN ON THE ACCOUNT, AND NOTHING ELSE FROM THE STRATEGY ROW.
 *
 * reconcile hands each snapshot its strategies fully resolved - family,
 * version, instrument, whether it ran - and also `parametersRaw` and `params`,
 * which carry every NinjaScript input the strategy was configured with,
 * including a `LicenseKey` field. None of that belongs on a document that goes
 * to a client, so this reads four named fields and never spreads the row.
 *
 * `ran` is the CRM's own answer (strategyRan.js), not a guess made here: a
 * strategy that was enabled and in Realtime ran, whether or not it happened to
 * take a trade that day.
 */
function strategyLine(strategies = []) {
  if (!strategies.length) return '';
  const names = strategies.map((s) => {
    const name = [s.strategyFamily, s.strategyVersion].filter(Boolean).join(' ')
      || s.strategyName || 'unnamed';
    const where = s.instrument ? ` on ${s.instrument}` : '';
    const idle = s.ran === false ? ' (did not run)' : '';
    return esc(`${name}${where}${idle}`);
  });
  return `<tr class="sub-row"><td colspan="4">${names.join(' &middot; ')}</td></tr>`;
}

function rows(list = []) {
  if (!list.length) return '';
  return list.map((row) => `
      <tr>
        <td>${esc(row.alias || row.accountName)}</td>
        <td class="num${sign(row.grossRealizedPnl)}">${money(row.grossRealizedPnl)}</td>
        <td class="num${sign(row.weeklyPnl)}">${money(row.weeklyPnl)}</td>
        <td class="num">${money(row.accountBalance)}</td>
      </tr>${strategyLine(row.strategies)}`).join('');
}

function section(title, list, totals, note = '') {
  if (!list?.length) return '';
  return `
    <section>
      <h2>${esc(title)}</h2>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <table>
        <thead><tr><th>Account</th><th class="num">Day</th><th class="num">Week</th><th class="num">Balance</th></tr></thead>
        <tbody>${rows(list)}</tbody>
        ${totals ? `<tfoot><tr>
          <th>Subtotal</th>
          <th class="num${sign(totals.grossRealizedPnl)}">${money(totals.grossRealizedPnl)}</th>
          <th class="num${sign(totals.weeklyPnl)}">${money(totals.weeklyPnl)}</th>
          <th class="num">${money(totals.aggregateBalance)}</th>
        </tr></tfoot>` : ''}
      </table>
    </section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color: #17202a; background: #fff; }
  .sheet { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 2px solid #17202a; padding-bottom: 14px; margin-bottom: 22px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .sub { color: #5a6673; font-size: 13px; }
  .headline { display: flex; gap: 28px; flex-wrap: wrap; margin: 22px 0 26px; }
  .tile { min-width: 150px; }
  .tile .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #5a6673; }
  .tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .pos { color: #0f7a3d; } .neg { color: #b3261e; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e3e7ea; }
  th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #5a6673; font-weight: 600; }
  tfoot th { border-top: 2px solid #17202a; border-bottom: none; font-size: 13px; text-transform: none; color: #17202a; }
  .num { text-align: right; }
  .note { font-size: 12px; color: #5a6673; margin: 0 0 8px; }
  .sub-row td { padding-top: 0; padding-bottom: 9px; border-bottom: 1px solid #e3e7ea;
                font-size: 11.5px; color: #5a6673; }
  tbody tr:not(.sub-row) td { border-bottom: none; }
  .warnings { border: 1px solid #e0b000; background: #fff8e1; border-radius: 6px; padding: 12px 16px; margin: 0 0 22px; }
  .warnings h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: #7a5c00; }
  .warnings ul { margin: 0; padding-left: 18px; }
  .warnings li { font-size: 13px; margin: 3px 0; }
  footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e3e7ea; font-size: 11px; color: #5a6673; }
  @media print { body { padding: 0; } .sheet { max-width: none; } section { break-inside: avoid; } }
`;

/**
 * The sentence the document carries about itself.
 *
 * A report generated on the machine is not the desk's record. It is built from
 * one machine's captured day, with the last account classification the CRM was
 * able to send, and it says so where the reader cannot miss it.
 */
export const PROVENANCE =
  'Generated on the trading machine from its own captured close, without the CRM. '
  + 'Account classification comes from the last roster the CRM was able to send to this machine.';

export function renderOfflineReport(built) {
  const { report, warnings = [], metadata } = built || {};
  if (!report) throw new Error('There is no report to render.');

  const g = report.grouped || {};
  const title = `${report.clientName} - ${report.date} daily report`;

  const tiles = [
    ['Accounts', String((report.grouped?.funded?.length || 0) + (report.grouped?.cash?.length || 0)
      + (report.grouped?.unclassified?.length || 0)), ''],
    ['Daily realized', money(report.totals?.grossRealizedPnl), sign(report.totals?.grossRealizedPnl)],
    ['Weekly', money(report.totals?.weeklyPnl), sign(report.totals?.weeklyPnl)],
  ].map(([label, value, cls]) => `
      <div class="tile"><div class="label">${esc(label)}</div><div class="value${cls}">${esc(value)}</div></div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><div class="sheet">
  <header>
    <h1>${esc(report.clientName)}</h1>
    <div class="sub">Daily close report &middot; ${esc(report.date)}</div>
  </header>

  <div class="headline">${tiles}</div>

  ${warnings.length ? `<div class="warnings"><h3>Read before sending</h3><ul>${
    warnings.map((w) => `<li>${esc(w)}</li>`).join('')
  }</ul></div>` : ''}

  ${section('Funded', g.funded, null)}
  ${section('Cash', g.cash, null)}
  ${section('Unclassified', g.unclassified, null, 'Real money whose pool has not been named yet. Counted in the total above.')}
  ${section('Evaluations', g.evaluations, report.evaluationTotals,
    'Challenge capital, not the client’s money. Shown here and never in the total above.')}
  ${section('Not classified on this machine', g.pendingClassification, report.pendingClassificationTotals,
    'These accounts are not in the roster this machine holds, so they could not be classified and are not in the total above.')}

  <footer>
    ${esc(PROVENANCE)}
    ${metadata?.capturedAt ? `<br />Capture taken ${esc(metadata.capturedAt)}.` : ''}
  </footer>
</div></body></html>`;
}
