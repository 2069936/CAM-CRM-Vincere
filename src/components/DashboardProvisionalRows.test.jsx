// A provisional account row (step 73): the close lost the account, the
// tracker's reading stands in for it with no fills and no balance, and the
// close's account table says so in the words every screen uses. The three
// flags a merging close and the tracker fill write carry their hover here too.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Dashboard from './Dashboard';
import { CLOSE_MERGE_FLAG_HINTS } from '../domain/databaseFlagTypes';

const account = (accountName, alias, over = {}) => ({
  accountName,
  grossRealizedPnl: 250,
  accountBalance: 50000,
  weeklyPnl: 0,
  trailingMaxDrawdown: 0,
  strategies: [],
  meta: { accountName, alias, accountType: 'Funded', status: 'Active' },
  ...over,
});

function render(rows, flags = []) {
  return renderToStaticMarkup(
    <Dashboard
      dailyImport={{ id: 'imp-1', date: '2026-10-22', clientId: 'c1', snapshots: [], strategies: [], orders: [], executions: [], flags }}
      rows={rows}
      title="Funded"
      mode="funded"
      client={{ id: 'c1', name: 'Craig', accountRegistry: {} }}
      onRecalculate={() => {}}
      onBuildReport={() => {}}
    />,
  );
}

describe('the close\'s account table and a row the tracker filled in', () => {
  it('marks the provisional row and only that one', () => {
    const markup = render([
      account('ACC1', 'Apex Main', { source: 'capture' }),
      account('ACC2', 'Apex Lost', { source: 'tracker', accountBalance: 0 }),
    ]);
    expect(markup.match(/From the tracker, no fills/g)).toHaveLength(1);
    const lost = markup.indexOf('Apex Lost');
    expect(markup.indexOf('From the tracker, no fills')).toBeGreaterThan(lost);
    expect(markup.indexOf('From the tracker, no fills')).toBeGreaterThan(markup.indexOf('Apex Main'));
  });

  it('shows the three new flags with their hover', () => {
    const flags = Object.keys(CLOSE_MERGE_FLAG_HINTS).map((type, index) => ({
      id: `f${index}`, type, severity: index === 2 ? 'Critical' : 'Warning', status: 'Open', message: `${type} on ACC2.`,
    }));
    const markup = render([account('ACC1', 'Apex Main')], flags);
    for (const [type, hint] of Object.entries(CLOSE_MERGE_FLAG_HINTS)) {
      expect(markup).toContain(`${type} on ACC2.`);
      expect(markup).toContain(`title="${hint.replace(/'/g, '&#x27;')}"`);
    }
  });
});
