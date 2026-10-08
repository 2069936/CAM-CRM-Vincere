// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountPill from './AccountPill';
import AccountLiveDetail from './AccountLiveDetail';
import RefreshNote from './RefreshNote';
import { classifyAccountSample } from '../domain/autoCollectionFleet';
import { CLOSE_DIFFERS_WORD, buildAccountPill, withCloseDiffers, withDiffers } from '../domain/accountPill';
import { buildAccountLiveDetail } from '../domain/accountLiveDetail';

/* ------------------------------------------------------------------------- *
 * THE PILL, THE DETAIL UNDER IT, AND THE SENTENCE ABOUT THE REFRESH.
 *
 * Pedro's words: the dot should say the account, what kind of connection it
 * is, and whether it is active; a click should show what the account is
 * running. These are the three small components both screens compose, asked
 * directly, with fictional data.
 * ------------------------------------------------------------------------- */

const NOW = new Date('2026-10-08T15:00:00.000Z');
const CYCLE = '2026-10-08T14:50:00.000Z';
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const CLIENT = { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' };

function sample(overrides = {}) {
  return {
    accountName: 'ACC 01',
    connectionName: 'Bluesky',
    connected: true,
    status: 'Connected',
    realizedPnl: -950,
    unrealizedPnl: -50,
    totalPnl: -1000,
    strategyCount: 3,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-08T14:56:00.000Z',
    ...overrides,
  };
}

function pillFor(overrides = {}) {
  const row = sample(overrides);
  const verdict = classifyAccountSample({ now: NOW, sample: row, staleSeconds: 1500 });
  return buildAccountPill({ accountName: row.accountName, sample: row, verdict });
}

function row(overrides = {}) {
  return {
    clientId: UUID,
    accountName: 'ACC 01',
    strategyId: '1',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -950,
    unrealizedPnl: -50,
    restartedAt: null,
    sampledAt: '2026-10-08T14:50:02.000Z',
    cycleStart: CYCLE,
    ...overrides,
  };
}

function strategies({ rows = [row()], median = -500, spread = 100, available = true } = {}) {
  return {
    available,
    desk: {
      available: true, cycleStart: CYCLE, filling: false, scope: 'desk',
      cohorts: [{ algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 12, nClients: 8, median, spread, nFlat: 0 }],
    },
    rows,
    settings: { minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false },
  };
}

function detailFor(overrides = {}) {
  return buildAccountLiveDetail({ client: CLIENT, accountName: 'ACC 01', sample: sample(), strategies: strategies(), now: NOW, ...overrides });
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the pill', () => {
  it('says the account, the connection and the state in words, and the run state under a current reading', () => {
    const { container } = render(<ol><AccountPill pill={pillFor()} onToggle={vi.fn()} /></ol>);
    const pill = container.querySelector('.account-pill');
    expect(pill.className).toBe('account-pill tracker-live tone-live');
    expect(pill.querySelector('.account-pill-name').textContent).toBe('ACC 01');
    expect(pill.querySelector('.account-pill-connection').textContent).toBe('Bluesky');
    expect(pill.querySelector('.account-pill-connection').className).toBe('account-pill-connection');
    expect(pill.querySelector('.account-pill-state').textContent).toBe('Live');
    expect(pill.querySelector('.account-pill-run').textContent).toBe('running');
    expect(pill.querySelector('button').getAttribute('title')).toBe('ACC 01: Live. Connection Bluesky. Sampled 4 minutes ago. Strategies: running.');
  });

  it('prints "No connection name" muted, as a normal state', () => {
    const { container } = render(<ol><AccountPill pill={pillFor({ connectionName: null })} /></ol>);
    const connection = container.querySelector('.account-pill-connection');
    expect(connection.textContent).toBe('No connection name');
    expect(connection.className).toBe('account-pill-connection absent');
    expect(container.querySelector('.account-pill').className).toContain('tracker-live');
    expect(container.querySelector('.account-pill-button').getAttribute('title')).toContain('No connection name.');
  });

  it('is a button with aria-expanded that calls back on a click, and a plain box when nothing opens', () => {
    const onToggle = vi.fn();
    const { container } = render(<ol><AccountPill pill={pillFor()} onToggle={onToggle} expanded={false} controls="d-1" /></ol>);
    const button = container.querySelector('button.account-pill-button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeNull();
    act(() => { button.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);

    const open = render(<ol><AccountPill pill={pillFor()} onToggle={onToggle} expanded controls="d-1" /></ol>);
    const openButton = open.container.querySelector('button.account-pill-button');
    expect(openButton.getAttribute('aria-expanded')).toBe('true');
    expect(openButton.getAttribute('aria-controls')).toBe('d-1');
    expect(open.container.querySelector('.account-pill').className).toContain('expanded');

    const still = render(<ol><AccountPill pill={pillFor()} /></ol>);
    expect(still.container.querySelector('button')).toBeNull();
    expect(still.container.querySelector('.account-pill-button').tagName).toBe('DIV');
  });

  it('shows the run word only for live and disconnected, and the state word for every state', () => {
    const silent = render(<ol><AccountPill pill={pillFor({ sampledAt: '2026-10-08T13:00:00.000Z' })} /></ol>).container;
    expect(silent.querySelector('.account-pill-state').textContent).toBe('Silent');
    expect(silent.querySelector('.account-pill-run')).toBeNull();
    const down = render(<ol><AccountPill pill={pillFor({ connected: false, status: 'ConnectionLost' })} /></ol>).container;
    expect(down.querySelector('.account-pill-state').textContent).toBe('Disconnected');
    expect(down.querySelector('.account-pill-run').textContent).toBe('running');
    const never = buildAccountPill({ accountName: 'ACC 09', sample: null, verdict: classifyAccountSample({ now: NOW, sample: null }) });
    const faint = render(<ol><AccountPill pill={never} /></ol>).container;
    expect(faint.querySelector('.account-pill').className).toBe('account-pill tracker-never_sampled tone-faint');
    expect(faint.querySelector('.account-pill-state').textContent).toBe('Never sampled');
    expect(faint.querySelector('.account-pill-connection').textContent).toBe('No connection name');
  });

  it('carries the amber marker, its words and its title only when an algorithm differs', () => {
    const plain = render(<ol><AccountPill pill={pillFor()} /></ol>).container;
    expect(plain.querySelector('.account-pill-mark')).toBeNull();
    expect(plain.querySelector('.account-pill').className).not.toContain('differs');
    expect(plain.textContent).not.toContain('differs from the desk');

    const marked = render(<ol><AccountPill pill={withDiffers(pillFor(), 1)} /></ol>).container;
    expect(marked.querySelector('.account-pill').className).toBe('account-pill tracker-live tone-live differs');
    expect(marked.querySelector('.account-pill-dot .account-pill-mark')).not.toBeNull();
    expect(marked.querySelector('.sr-only').textContent).toBe('1 algorithm differs from the desk');
    expect(marked.querySelector('.account-pill-button').getAttribute('title')).toContain('1 algorithm differs from the desk.');
    // The marker changes nothing about the pill's own colour or state.
    expect(marked.querySelector('.account-pill-state').textContent).toBe('Live');
  });
});

describe('the amber "Close differs" badge (step 66)', () => {
  it('is on the pill only for a verdict that asks for attention, in words, with the verdict in the title', () => {
    const marked = render(<ol><AccountPill pill={withCloseDiffers(pillFor(), 'tracker_only')} /></ol>).container;
    const pill = marked.querySelector('.account-pill');
    expect(pill.className).toBe('account-pill tracker-live tone-live close-differs');
    expect(pill.querySelector('.account-pill-close-differs').textContent).toBe(CLOSE_DIFFERS_WORD);
    expect(CLOSE_DIFFERS_WORD).toBe('Close differs');
    expect(pill.querySelector('.account-pill-close-differs').getAttribute('title')).toBe('Close differs: tracker only.');
    expect(pill.querySelector('.account-pill-button').getAttribute('title')).toContain('Close differs: tracker only.');
    // The pill keeps its own colour and state.
    expect(pill.querySelector('.account-pill-state').textContent).toBe('Live');
    expect(pill.querySelector('.account-pill-mark')).toBeNull();
  });

  it('rides beside the desk marker, and both are said in the title', () => {
    const both = withCloseDiffers(withDiffers(pillFor(), 2), 'differs');
    const { container } = render(<ol><AccountPill pill={both} /></ol>);
    const pill = container.querySelector('.account-pill');
    expect(pill.className).toBe('account-pill tracker-live tone-live differs close-differs');
    expect(pill.querySelector('.account-pill-mark')).not.toBeNull();
    const title = pill.querySelector('.account-pill-button').getAttribute('title');
    expect(title).toContain('2 algorithms differ from the desk.');
    expect(title).toContain('Close differs: the realized figures differ.');
    expect(title).not.toMatch(/[\u2013\u2014]| - /);
  });

  it('leaves the pill alone for a verdict that agrees, for no verdict, and for one that says nothing to compare', () => {
    for (const verdict of ['matches', 'settled_at_close', 'after_close', 'tracker_no_figure', null, undefined, 'nonsense']) {
      const plain = withCloseDiffers(pillFor(), verdict);
      expect(plain, String(verdict)).toEqual(pillFor());
      const { container, unmount } = render(<ol><AccountPill pill={plain} /></ol>);
      expect(container.querySelector('.account-pill-close-differs')).toBeNull();
      expect(container.querySelector('.account-pill').className).not.toContain('close-differs');
      unmount();
    }
  });
});

describe('the detail under a pill', () => {
  it('prints the connection, the account totals and one row per strategy instance', () => {
    const { container } = render(<AccountLiveDetail view={detailFor()} id="d-1" />);
    const detail = container.querySelector('.account-live-detail');
    expect(detail.getAttribute('id')).toBe('d-1');
    expect(detail.querySelector('.account-live-detail-connection').textContent).toBe('Connection Bluesky');
    const totals = [...detail.querySelectorAll('.account-live-detail-totals dt')].map((dt) => dt.textContent);
    expect(totals).toEqual(['Realized', 'Unrealized', 'Total', 'Strategies', 'Sampled']);
    const values = [...detail.querySelectorAll('.account-live-detail-totals dd')].map((dd) => dd.textContent);
    expect(values[0]).toBe('-$950');
    expect(values[1]).toBe('-$50');
    expect(values[2]).toBe('-$1,000');
    expect(values[3]).toBe('2 of 3 strategies enabled');
    expect(values[4]).toMatch(/^\d\d:\d\d, 4m ago$/);
    const rows = [...detail.querySelectorAll('.account-live-strategy')];
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-algorithm')).toBe('OGX_PF');
    expect(rows[0].textContent).toContain('MNQ 12-26');
    expect(rows[0].textContent).toContain('0 - OGX-PF-2.4');
    expect(rows[0].textContent).toContain('realized -$950');
    expect(rows[0].textContent).toContain('open -$50');
    expect(rows[0].textContent).toContain('total -$1,000');
  });

  it('marks the instance that differs with an amber chip and the comparison sentence, and never a red one', () => {
    const { container } = render(<AccountLiveDetail view={detailFor()} />);
    const strategy = container.querySelector('.account-live-strategy');
    expect(strategy.className).toBe('account-live-strategy status-compared differs');
    const chip = strategy.querySelector('.account-live-strategy-differs');
    expect(chip.textContent).toBe('Differs from the desk');
    expect(chip.className).toBe('badge warning account-live-strategy-differs');
    expect(chip.className).not.toMatch(/danger|error/);
    expect(strategy.querySelector('.account-live-strategy-words').textContent).toBe('Differs from the desk by $500, 5 times the usual spread.');
    expect(container.querySelector('.account-live-detail-differs').textContent).toBe('1 algorithm differs from the desk');
  });

  it('shows nothing amber for an instance within the desk spread or against a thin desk', () => {
    const within = render(<AccountLiveDetail view={detailFor({ strategies: strategies({ rows: [row({ realizedPnl: -550, unrealizedPnl: 0 })] }) })} />).container;
    expect(within.querySelector('.account-live-strategy-differs')).toBeNull();
    expect(within.querySelector('.account-live-strategy').className).toBe('account-live-strategy status-compared');
    expect(within.textContent).toContain('Within the usual spread of the desk (0.5 times).');
    const thin = strategies();
    thin.desk.cohorts[0] = { ...thin.desk.cohorts[0], status: 'thin', nAccounts: null, median: null, spread: null };
    const thinView = render(<AccountLiveDetail view={detailFor({ strategies: thin })} />).container;
    expect(thinView.querySelector('.account-live-strategy-differs')).toBeNull();
    expect(thinView.textContent).toContain('Not compared: the desk figure for this algorithm is too thin.');
    expect(thinView.querySelector('.account-live-detail-differs')).toBeNull();
  });

  it('notes a restart and keeps a missing figure at not measured', () => {
    const view = detailFor({
      sample: sample({ realizedPnl: null, totalPnl: null }),
      strategies: strategies({ rows: [row({ restartedAt: '2026-10-08T14:40:00.000Z', unrealizedPnl: null })] }),
    });
    const { container } = render(<AccountLiveDetail view={view} />);
    expect(container.textContent).toMatch(/Restarted at \d\d:\d\d, so this figure counts only since then\./);
    expect(container.textContent).toContain('not measured');
    expect(container.textContent).not.toContain('$0');
    expect(container.querySelector('.account-live-strategy-differs')).toBeNull();
  });

  it('says it is reading, could not read, is not deployed, or has nothing, each in its own words and never as a banner', () => {
    const unread = detailFor({ strategies: null });
    const reading = render(<AccountLiveDetail view={unread} reading />).container;
    expect(reading.querySelector('.account-live-detail-reading').textContent).toBe('Reading what is running.');
    const failed = render(<AccountLiveDetail view={unread} error="timeout" />).container;
    expect(failed.querySelector('.account-live-detail-failed').textContent).toBe('Could not read what is running.');
    expect(failed.querySelector('[role="alert"]')).toBeNull();
    // The totals from the account sample are still there: the failure is the rows'.
    expect(failed.textContent).toContain('-$1,000');
    const notDeployed = render(<AccountLiveDetail view={detailFor({ strategies: strategies({ available: false }) })} />).container;
    expect(notDeployed.textContent).toContain('Migration step 57 has not been run');
    const empty = render(<AccountLiveDetail view={detailFor({ strategies: strategies({ rows: [] }) })} />).container;
    expect(empty.querySelector('.account-live-detail-empty').textContent).toBe('No strategy reading for this account yet.');
  });

  it('keeps the last rows and says so when a refresh fails', () => {
    const { container } = render(<AccountLiveDetail view={detailFor()} error="offline" />);
    expect(container.querySelectorAll('.account-live-strategy')).toHaveLength(1);
    expect(container.querySelector('.account-live-detail-failed').textContent).toBe('Could not refresh what is running. The rows are the last answer.');
  });

  it('says there is no account sample while still listing the strategies', () => {
    const { container } = render(<AccountLiveDetail view={detailFor({ sample: null })} />);
    expect(container.querySelector('.account-live-detail-none').textContent).toBe('No account sample has arrived for this account.');
    expect(container.querySelector('.account-live-detail-connection').textContent).toBe('No connection name');
    expect(container.querySelectorAll('.account-live-strategy')).toHaveLength(1);
  });
});

describe('the position on a strategy row (step 64, agent 1.2.1)', () => {
  it('prints which way it fired, the contracts and the trades beside the figures, and nothing when not read', () => {
    const fired = render(<AccountLiveDetail view={detailFor({ strategies: strategies({ rows: [row({ marketPosition: 'long', positionQuantity: 2, tradesThisRun: 1 })] }) })} />);
    const position = fired.container.querySelector('.account-live-strategy-position');
    expect(position.textContent).toBe('long, 2 contracts, 1 trade this run');
    // Between the total and the comparison, so the row reads figures, position, verdict.
    const strategy = fired.container.querySelector('.account-live-strategy');
    const children = [...strategy.children].map((node) => node.className.split(' ')[0]);
    expect(children.indexOf('account-live-strategy-position')).toBeGreaterThan(children.lastIndexOf('account-live-strategy-figure'));
    expect(children.indexOf('account-live-strategy-position')).toBeLessThan(children.indexOf('account-live-strategy-words'));
    fired.unmount();
    const unread = render(<AccountLiveDetail view={detailFor()} />);
    expect(unread.container.querySelector('.account-live-strategy-position')).toBeNull();
    expect(unread.container.textContent).not.toContain('flat');
    expect(unread.container.textContent).not.toContain('position');
  });
});

describe('the refresh sentence', () => {
  it('ages every ten seconds from the clock it is given, without a read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T15:00:40.000Z'));
    const { container } = render(<RefreshNote updatedAt={Date.parse('2026-10-08T15:00:00.000Z')} refreshMs={120_000} />);
    expect(container.textContent).toBe('Updated 40 s ago, refreshes every 2 min.');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(container.textContent).toBe('Updated 50 s ago, refreshes every 2 min.');
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(container.textContent).toBe('Updated 1 min ago, refreshes every 2 min.');
    expect(container.querySelector('.live-refresh')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('drops the cadence when nothing refreshes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T15:00:05.000Z'));
    const { container } = render(<RefreshNote updatedAt={Date.parse('2026-10-08T15:00:00.000Z')} refreshMs={0} />);
    expect(container.textContent).toBe('Updated just now.');
  });
});

describe('the styles', () => {
  it('has a rule in index.css for every class the three components render, and the marker is amber, never red', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const seen = new Set();
    const renders = [
      <ol><AccountPill pill={withDiffers(pillFor(), 1)} onToggle={vi.fn()} expanded controls="d" /></ol>,
      <ol><AccountPill pill={pillFor({ connectionName: null })} /></ol>,
      <ol><AccountPill pill={withCloseDiffers(pillFor(), 'differs')} /></ol>,
      <AccountLiveDetail view={detailFor()} error="x" id="d" />,
      <AccountLiveDetail view={detailFor({ sample: null, strategies: null })} error="x" />,
      <AccountLiveDetail view={detailFor({ strategies: null })} reading />,
      <AccountLiveDetail view={detailFor({ strategies: strategies({ rows: [] }) })} />,
      <AccountLiveDetail view={detailFor({ sample: sample({ realizedPnl: null }), strategies: strategies({ rows: [row({ realizedPnl: null })] }) })} />,
      <AccountLiveDetail view={detailFor({ strategies: strategies({ rows: [row({ marketPosition: 'short', positionQuantity: 1, tradesThisRun: 2 })] }) })} />,
      <RefreshNote updatedAt={Date.now()} />,
    ];
    for (const element of renders) {
      const { container, unmount } = render(element);
      for (const node of container.querySelectorAll('[class]')) {
        for (const name of node.classList) {
          if (name.startsWith('account-pill') || name.startsWith('account-live') || name === 'live-refresh') seen.add(name);
        }
      }
      unmount();
    }
    expect([...seen]).toEqual(expect.arrayContaining([
      'account-pill', 'account-pill-button', 'account-pill-dot', 'account-pill-mark', 'account-pill-name',
      'account-pill-connection', 'account-pill-state', 'account-pill-run', 'account-pill-close-differs',
      'account-live-detail', 'account-live-detail-head', 'account-live-detail-connection', 'account-live-detail-differs',
      'account-live-detail-totals', 'account-live-detail-absent', 'account-live-detail-none', 'account-live-detail-reading',
      'account-live-detail-failed', 'account-live-detail-empty', 'account-live-detail-strategies', 'account-live-strategy',
      'account-live-strategy-name', 'account-live-strategy-instrument', 'account-live-strategy-instance',
      'account-live-strategy-figure', 'account-live-strategy-differs', 'account-live-strategy-words', 'account-live-strategy-position',
      'live-refresh',
    ]));
    for (const name of seen) {
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
    // The amber rule: the marker and the differing row are painted with the
    // warning token, and nothing in the pill or detail block touches the error one.
    const block = css.slice(css.indexOf('.account-pills'), css.indexOf('/* ── The status light for the whole book'));
    expect(block).toMatch(/\.account-pill-mark[^}]*var\(--warning\)/);
    expect(block).toMatch(/\.account-pill-close-differs[^}]*var\(--warning\)/);
    expect(block).toMatch(/\.account-live-strategy\.differs[^}]*var\(--warning\)/);
    expect(block).not.toMatch(/--error|--red|#ff5a69/);
  });
});
