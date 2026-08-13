// What the CLIENT reads, asserted on the rendered markup.
//
// Rendered with renderToStaticMarkup, the idiom every other component in this
// folder is tested with. The section is pure, so it needs no DOM.
//
// The mutation this guards against is the cheapest one available on this
// component: dropping the `unstated` block. That leaves a section that renders
// clean on a close whose orders were never collected — the exact "we do not have
// the file" reading as "nothing was wrong" that the whole feature exists to
// prevent — and every domain test still passes, because the derivation is right
// and only the render is lying.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReportReasonsSection from './ReportReasonsSection';
import { buildReportReasons } from '../domain/reportReasons';
import { ACCOUNT_TYPES } from '../domain/reconcile';

const strip = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const REJECT = 'Rejected: Your account is currently set to liquidation only due to Drawdown level breached at end of day. Please contact the Trade Desk for additional details.';

function snapshot(accountName, over = {}) {
  return { accountName, connection: 'Legends', accountBalance: 50000, grossRealizedPnl: 0, weeklyPnl: 0, unrealizedPnl: 0, trailingMaxDrawdown: 2000, strategies: [], ...over };
}

/** Daniel Swanson's real 2026-08-11 close. */
function swanson() {
  const registry = {
    'Legends - 1095': { alias: 'Legends - 1095', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active', dateAdded: '2026-08-01' },
    'Legends - 2574': { alias: 'Legends - 2574', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active', dateAdded: '2026-08-01' },
    'BlueSky - 1319': { alias: 'BlueSky - 1319', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active', dateAdded: '2026-08-01' },
  };
  const close = {
    date: '2026-08-11',
    snapshots: [
      snapshot('Legends - 1095', { accountBalance: 47727, trailingMaxDrawdown: -273.04, strategies: [{ strategyName: 'Bullet Bot-1.1', enabled: true }] }),
      snapshot('Legends - 2574', { accountBalance: 47927, weeklyPnl: -942, trailingMaxDrawdown: -73.04, strategies: [{ strategyName: 'Bullet Bot-1.1', enabled: true }] }),
      snapshot('BlueSky - 1319', { accountBalance: 50000 }),
    ],
    orders: [
      { accountName: 'Legends - 1095', state: REJECT, filled: 0, id: 'o1' },
      { accountName: 'Legends - 2574', state: REJECT, filled: 0, id: 'o2' },
    ],
    executions: [],
    strategies: [],
  };
  const client = { id: 'c-swanson', name: 'Daniel Swanson', accountRegistry: registry, dailyImports: [close] };
  return buildReportReasons(client, close);
}

describe('the reasons a client reads', () => {
  it("prints the platform's own sentence in quotes, attributed to the platform", () => {
    const text = strip(renderToStaticMarkup(<ReportReasonsSection reasons={swanson()} />));
    expect(text).toContain('What shaped this close');
    expect(text).toContain('Legends - 1095: the only order sent on this account was not accepted by the platform.');
    expect(text).toContain('The platform’s reason:');
    expect(text).toContain('Your account is currently set to liquidation only due to Drawdown level breached at end of day.');
    // Both accounts, by name. $0 with no name on it is what the PDF already did.
    expect(text).toContain('Legends - 2574');
  });

  it('states the drawdown reading as its own line, joined to nothing', () => {
    const text = strip(renderToStaticMarkup(<ReportReasonsSection reasons={swanson()} />));
    expect(text).toContain('Legends - 1095 is past its trailing drawdown');
    expect(text).toContain('-$273');
    expect(text).not.toMatch(/because|therefore|as a result/i);
  });

  it('renders the "not stated" block rather than an empty clean section', () => {
    const registry = { A1: { alias: 'A1', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active', dateAdded: '2026-08-01' } };
    const close = { date: '2026-08-11', snapshots: [snapshot('A1')], orders: [], executions: [], strategies: [] };
    const reasons = buildReportReasons({ id: 'c', name: 'X', accountRegistry: registry, dailyImports: [close] }, close);
    const text = strip(renderToStaticMarkup(<ReportReasonsSection reasons={reasons} />));
    expect(text).toContain('Not stated in this report');
    expect(text).toContain('Order records for this close are not on file');
    expect(text).toContain('That is not the same as saying none was.');
  });

  it('renders nothing at all when there is nothing to say', () => {
    const registry = { A1: { alias: 'A1', accountType: ACCOUNT_TYPES.FUNDED, status: 'Active', dateAdded: '2026-08-01' } };
    const close = {
      date: '2026-08-11',
      snapshots: [snapshot('A1', { grossRealizedPnl: 425 })],
      orders: [{ accountName: 'A1', state: 'Filled', filled: 1 }],
      executions: [],
      strategies: [],
    };
    const reasons = buildReportReasons({ id: 'c', name: 'X', accountRegistry: registry, dailyImports: [close] }, close);
    expect(renderToStaticMarkup(<ReportReasonsSection reasons={reasons} />)).toBe('');
    expect(renderToStaticMarkup(<ReportReasonsSection reasons={null} />)).toBe('');
  });

  it('carries no .no-print class: the whole point is that it reaches the PDF', () => {
    const html = renderToStaticMarkup(<ReportReasonsSection reasons={swanson()} />);
    expect(html).not.toContain('no-print');
    // .report-section is what src/index.css:5272 gives `break-inside: avoid`.
    expect(html).toContain('class="report-section report-reasons"');
  });
});
