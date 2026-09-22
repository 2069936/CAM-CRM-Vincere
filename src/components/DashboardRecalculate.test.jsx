// The one button on this screen that WRITES from what the screen holds.
//
// Recalculate re-derives a close's flags from its own rows, and the flags that
// matter most on it answer "did this algorithm run" — which is answered from
// the day's FILLS. A login carries the fills of each client's latest close and
// of no other, so on any older close, or after the close-detail fetch failed,
// the button was offered over a close whose evidence was not there. Pressing it
// produced `Expected strategy missing` Critical on every real-money account
// that had traded all day and `Strategy disabled` Warning once per row, and
// `replaceSupabaseOperationalFlags` wrote them; because the wording of those
// flags changed in this same branch, the ones somebody had already resolved did
// not match on (type, account, message) and came back Open.
//
// reconcile.js refuses those four flags without the fills as well — see
// reconcile.test.js. This is the half that means nobody has to press the button
// to find out.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Dashboard from './Dashboard';

const close = (over = {}) => ({
  id: 'imp-1',
  date: '2026-07-13',
  clientId: 'c1',
  snapshots: [],
  strategies: [],
  orders: [],
  executions: [],
  flags: [],
  ...over,
});

const rows = [{
  accountName: 'ACC1',
  grossRealizedPnl: 100,
  accountBalance: 50000,
  weeklyPnl: 100,
  trailingMaxDrawdown: 0,
  strategies: [],
  meta: { accountName: 'ACC1', alias: 'Apex Main', accountType: 'Funded', status: 'Active' },
}];

const render = (dailyImport) => renderToStaticMarkup(
  <Dashboard
    dailyImport={dailyImport}
    rows={rows}
    title="Funded"
    mode="funded"
    client={{ id: 'c1', name: 'Craig', accountRegistry: {} }}
    onRecalculate={() => {}}
    onBuildReport={() => {}}
  />,
);

/** The markup of the Recalculate button alone. */
function recalculateButton(markup) {
  const match = /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Recalculate[\s\S]*?<\/button>/.exec(markup);
  return match ? match[0] : '';
}

describe('Recalculate is offered only when the close carries its own fills', () => {
  it('is disabled on a close whose fills a login did not carry, and says why', () => {
    const html = render(close({ detailLoaded: false }));
    const button = recalculateButton(html);

    expect(button).toContain('disabled');
    expect(button).toContain('fills are not loaded');
    expect(button).toContain('would read a day that traded as a quiet one');
  });

  it('is offered once the close has been opened', () => {
    const button = recalculateButton(render(close({ detailLoaded: true })));

    expect(button).not.toContain('disabled');
  });

  it('is offered on a fixture that predates the marker but carries fills', () => {
    // fillsLoadedFor falls back to the old evidence for a close with no
    // `detailLoaded` field at all, so nothing that used to answer "loaded"
    // starts answering "not".
    const button = recalculateButton(render(close({ executions: [{ id: 'e1' }] })));

    expect(button).not.toContain('disabled');
  });
});
