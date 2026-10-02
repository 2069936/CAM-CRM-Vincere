// What the CLIENT reads, asserted on the rendered markup.
//
// The same reason SimulationReportSection.test.jsx exists: a mutation pass over
// that component removed the word "simulated" from a rendered currency figure and
// deleted the "not included in any figure above" note entirely, with all 1782
// tests green, and both edits leave a client looking at a figure formatted exactly
// like the real balance six lines above it. An evaluation's balance is the same
// hazard — it is the prop firm's capital, and report.js carries the 2026-09-08
// report that headlined -$1,319 when -$509 of it was a failed challenge account.
//
// It also pins the half of the PDF contract that lives in this file: the markup
// carries no `.no-print`, because the whole complaint was that the evaluations
// never came out in the PDF. The other half — that the mount sits inside
// `.report-sheet` and outside every `.no-print` subtree — is in
// evaluationReportGate.test.js.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EvaluationsReportSection from './EvaluationsReportSection';
import { buildEvaluationSection } from '../domain/evaluationReport';
import { ACCOUNT_TYPES } from '../domain/reconcile';
import { summarizeAccountRows } from '../domain/report';

const strip = (html) => html
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#x27;|&apos;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const evalRow = (accountName, over = {}, meta = {}) => ({
  accountName,
  connection: 'Legends',
  accountBalance: 50000,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  trailingMaxDrawdown: 0,
  strategies: [],
  ...over,
  meta: { accountName, accountType: ACCOUNT_TYPES.EVALUATION_BULLET, ...meta },
});

function render(rows, { reportedAccountCount = rows.length, registry = null } = {}) {
  const accountRegistry = registry || Object.fromEntries(rows.map((r) => [r.accountName, r.meta]));
  const built = buildEvaluationSection(
    { accountRegistry, dailyImports: [] },
    { accounts: {} },
    { rows, totals: summarizeAccountRows(rows).totals, reportedAccountCount },
  );
  return renderToStaticMarkup(<EvaluationsReportSection evaluations={built} />);
}

describe('the evaluations block a client receives', () => {
  const rows = [
    evalRow('ROME7045', { accountBalance: 52050, grossRealizedPnl: -810, weeklyPnl: -1200, trailingMaxDrawdown: 1850, strategies: [{ strategyName: 'RBO', ran: true, enabled: true }] },
      { alias: 'Legends - 7045', accountType: ACCOUNT_TYPES.EVALUATION_STANDARD, startBalance: 50000, targetProfit: 54100 }),
    evalRow('CGD0658', { accountBalance: 50000 }, { alias: 'Bullet - 0658', startBalance: 50000 }),
  ];

  it('renders nothing at all for a client with no evaluation account', () => {
    expect(renderToStaticMarkup(<EvaluationsReportSection evaluations={null} />)).toBe('');
  });

  it('carries no .no-print class: the whole point is that it reaches the PDF', () => {
    // The complaint arrived as "it does not come out in the PDF". The PDF is the
    // live `.report-sheet` DOM rendered in headless Chrome against this build's
    // stylesheet, where `.no-print { display: none !important }`.
    expect(render(rows)).not.toContain('no-print');
  });

  it('says the money is the prop firm\'s, in words, beside the figures', () => {
    const text = strip(render(rows));
    expect(text).toContain('Challenge capital');
    expect(text).toContain('The capital in them belongs to the prop firm, not to you');
    // Currency formatting alone does not carry "this is not yours", so the words do.
    expect(text).toContain('$102,050 challenge capital');
    expect(text).toContain('-$810 challenge capital');
    expect(text).toContain('Daily P&L (challenge capital)');
    expect(text).toContain('Balance (challenge capital)');
  });

  it('states that nothing here is in the figures above', () => {
    expect(strip(render(rows)))
      .toContain('Not included in the daily or weekly figures above');
  });

  it('labels its own subtotal and prints it against its denominator', () => {
    const text = strip(render(rows, { reportedAccountCount: 7 }));
    expect(text).toContain('Challenge-capital total (2 of 7 accounts reported)');
    expect(text).toContain('Challenge accounts 2 of 7');
  });

  it('shows progress toward the target and says where the target came from', () => {
    const text = strip(render(rows));
    // 52,050 of the way from 50,000 to 54,100 is 50%.
    expect(text).toContain('50%');
    // The Bullet Bot row has no stored target; 53,000 is the standard one for its
    // type at 50k, and the cell says it was not typed by anyone.
    expect(text).toContain('$53,000');
    expect(text).toContain('standard for its type and size');
    expect(text).toContain('Progress shown on 2 of 2 accounts: 1 target on record');
    expect(text).toContain("1 taken from the standard target for the account's type and size");
  });

  it('says "reached", not "passed": the firm decides a pass', () => {
    const reached = [evalRow('ROME7045', { accountBalance: 54200 }, { startBalance: 50000, targetProfit: 54100 })];
    const text = strip(render(reached));
    expect(text).toContain('Target reached');
    expect(text).not.toContain('Passed');
    expect(text).toContain('Reached their target 1 of 1');
  });

  it('refuses a percentage where a percentage would be a lie, and says which lie', () => {
    const notAbove = [evalRow('A', { accountBalance: 54100 }, { startBalance: 54100, targetProfit: 54100 })];
    expect(strip(render(notAbove)))
      .toContain('The target on record is not above this account\'s starting balance, so a percentage cannot be shown');

    const noStart = [evalRow('B', { accountBalance: 7777 }, { targetProfit: 53000 })];
    expect(strip(render(noStart)))
      .toContain('No starting balance on record and no earlier close to take one from, so a percentage cannot be shown');

    const noTarget = [evalRow('C', { accountBalance: 7777 }, { startBalance: 7777 })];
    expect(strip(render(noTarget)))
      .toContain('No target on record for this account, so a percentage cannot be shown');
  });

  it('tells a day when nothing ran apart from a flat day', () => {
    // 164 of the 203 evaluation rows on the book's latest closes ran no algorithm.
    const text = strip(render([evalRow('A'), evalRow('B')]));
    expect(text).toContain('No challenge account traded in this close: no algorithm ran on any of them');
    // Says what ran, and does NOT claim the balance stood still: fees and
    // adjustments move a balance no algorithm touched.
    expect(text).toContain('a $0 line below means nothing traded rather than a day that ended level');
    expect(text).not.toContain('unchanged');
  });

  it('counts the idle ones separately when some did trade', () => {
    const text = strip(render([
      evalRow('A', { strategies: [{ strategyName: 'RBO', ran: true, enabled: true }] }),
      evalRow('B'),
    ]));
    expect(text).toContain('1 of 2 challenge accounts traded in this close');
    expect(text).toContain('No algorithm ran on the other 1');
  });

  it('names a failed account as broken on this close rather than leading with it', () => {
    // 21 of 203 rows on the book's latest closes are Failed and print only because
    // a breach flag fired that day. 4 of the 27 such accounts print as "died
    // today" on more than one close, one of them on 7, so a section that LED with
    // breaches would repeat a death. It is a clause at the end of the activity
    // line instead.
    const text = strip(render([evalRow('A', {}, { status: 'Failed' })]));
    expect(text).toContain('1 of them is recorded as failed');
    expect(text).toContain('shown because this close is the one it broke on');
  });

  it('prints the buffer the platform reported, and nothing where it reported none', () => {
    const text = strip(render(rows));
    expect(text).toContain('Buffer reported');
    expect(text).toContain('$1,850');
    expect(text).toContain('not reported');
  });

  it('calls a negative trailing figure what it is, not a negative buffer', () => {
    /* 84 of the 203 evaluation rows on the book's latest closes report a negative
     * trailing figure. App.jsx's drawdownLabel has always rendered that case as
     * BREACHED and a zero as "-", so printing "-$254" under a heading that says
     * "buffer" would be a third reading of the same number on the page the client
     * keeps. */
    const text = strip(render([evalRow('A', { trailingMaxDrawdown: -254 }, { startBalance: 50000, targetProfit: 53000 })]));
    expect(text).toContain('Past its drawdown');
    expect(text).not.toContain('-$254');
  });

  it('says so, in one sentence, when the accounts exist and none reported today', () => {
    const html = render([], {
      registry: {
        A: { accountType: ACCOUNT_TYPES.EVALUATION_BULLET },
        B: { accountType: ACCOUNT_TYPES.EVALUATION_STANDARD },
      },
    });
    const text = strip(html);
    expect(text).toContain('2 evaluation accounts on record');
    expect(text).toContain('none of them reported a close on this date');
    // No chip over an empty block, and no table of nothing.
    expect(html).not.toContain('eval-chip');
    expect(html).not.toContain('<table');
  });
});
