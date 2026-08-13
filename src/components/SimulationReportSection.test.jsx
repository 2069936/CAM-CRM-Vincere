// What the CLIENT reads, asserted on the rendered markup.
//
// The component had no test at all. A mutation pass over commit dcd3196 removed
// the word "simulated" from a rendered currency figure, and deleted the
// "not included in any figure above" note entirely, with all 1782 tests green.
// Both edits leave a client looking at $99,590 formatted exactly like the real
// balance six lines above it.
//
// Rendered with renderToStaticMarkup, the same idiom CamFlagQueue.test.jsx
// uses: the component is pure, so it needs no DOM.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SimulationReportSection from './SimulationReportSection';
import { buildSimulationSection } from '../domain/report';
import { ACCOUNT_TYPES } from '../domain/reconcile';
import { splitSimulationRows } from '../domain/simulationAccounts';

const strip = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const snapshot = (accountName, over = {}) => ({
  accountName,
  connection: 'Legends',
  accountBalance: 0,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  unrealizedPnl: 0,
  strategies: [],
  ...over,
});

// Craig Weschke's real 2026-08-06 close.
function craigSection() {
  const registry = {
    'Craig - Main': { accountName: 'Craig - Main', alias: 'Live - Craig - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
    Sim101: { accountName: 'Sim101', alias: 'Live - Sim101', accountType: ACCOUNT_TYPES.SIMULATION, connection: 'BlueSky' },
  };
  const split = splitSimulationRows({
    accounts: registry,
    snapshots: [
      snapshot('Craig - Main', { accountBalance: 55893.06 }),
      snapshot('Sim101', {
        accountBalance: 99590,
        grossRealizedPnl: -1297.9999999,
        strategies: [
          { strategyName: '0 - URGO-4.5 MNQ SEP26', enabled: true },
          { strategyName: '0 - IFSP-1.1 NG SEP26', enabled: true },
        ],
      }),
    ],
    strategies: [
      { accountName: 'Sim101', strategyName: '0 - URGO-4.5 MNQ SEP26', enabled: true },
      { accountName: 'Sim101', strategyName: '0 - IFSP-1.1 NG SEP26', enabled: true },
    ],
    orders: Array.from({ length: 40 }, (unused, i) => ({ accountName: 'Sim101', id: `O${i}` })),
    executions: Array.from({ length: 15 }, (unused, i) => ({ accountName: 'Sim101', id: `E${i}` })),
  });
  return buildSimulationSection(
    { accountRegistry: registry },
    { accounts: registry, ...split.live, simulation: split.simulation },
    1,
  );
}

describe('SimulationReportSection', () => {
  it('attaches the word simulated to every currency figure it prints', () => {
    // Two totals on one page that could be mistaken for each other is the
    // defect. $99,590 rendered bare is indistinguishable from real money.
    const html = renderToStaticMarkup(<SimulationReportSection simulation={craigSection()} />);
    const text = strip(html);

    expect(text).toContain('$99,590 simulated');
    expect(text).toContain('-$1,298 simulated');
    // Not one currency figure in the totals block without the word next to it.
    const totalsBlock = html.slice(html.indexOf('report-simulation-totals'), html.indexOf('report-simulation-activity'));
    const figures = strip(totalsBlock).match(/-?\$[\d,]+/g) || [];
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(strip(totalsBlock)).toContain(`${figure} simulated`);
    }
  });

  it('prints the sentence that says these figures are in no total above', () => {
    const html = renderToStaticMarkup(<SimulationReportSection simulation={craigSection()} />);
    const text = strip(html);

    expect(text).toMatch(/not included in any figure above/i);
    expect(text).toContain('Simulated funds');
  });

  it('reports the activity the old filter deleted, with its denominator', () => {
    const html = renderToStaticMarkup(<SimulationReportSection simulation={craigSection()} />);
    const text = strip(html);

    expect(text).toContain('40');
    expect(text).toContain('15');
    expect(text).toMatch(/1 of 2/);
    expect(text).toContain('0 - URGO-4.5 MNQ SEP26');
  });

  it('renders nothing at all when the client has no simulation', () => {
    expect(renderToStaticMarkup(<SimulationReportSection simulation={null} />)).toBe('');
  });
});
