// @vitest-environment jsdom
//
// buildAlgoComboPerformance is the alias the component keeps over
// src/domain/comboPerformance.js with the OLD rules (enabled at export, family
// keys, current-status population, all history); the rules themselves are
// pinned in comboPerformance.test.js. The two rendering tests at the bottom
// are synthetic on purpose so this file stays off the local-snapshot gate.

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import StackPlaybook, { buildAlgoComboPerformance } from './StackPlaybook';

afterEach(cleanup);

function makeClient({ id, accountName, accountType = 'Funded', strategyName = '1 - RBO-1.8', pnls = [] }) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType, status: 'Active' },
    },
    dailyImports: pnls.map((pnl, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{
        accountName,
        grossRealizedPnl: pnl,
        strategies: [{ strategyName, strategyFamily: 'RBO', enabled: true }],
      }],
    })),
  };
}

describe('buildAlgoComboPerformance', () => {
  it('returns empty array when no clients provided', () => {
    expect(buildAlgoComboPerformance([])).toEqual([]);
  });

  it('aggregates funded account combos across clients', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'ACC1', pnls: [100, 200, 150] }),
      makeClient({ id: 'c2', accountName: 'ACC2', pnls: [50, 100] }),
    ];
    const result = buildAlgoComboPerformance(clients);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(5);
    expect(result[0].accounts).toBe(2);
    expect(result[0].clients).toBe(2);
    expect(result[0].avgPnl).toBeCloseTo((100 + 200 + 150 + 50 + 100) / 5);
  });

  it('excludes non-funded account types from combo performance', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'EVAL1', accountType: 'Evaluation - Standard', pnls: [500, 600] }),
    ];
    expect(buildAlgoComboPerformance(clients)).toEqual([]);
  });

  it('resolves account registry case-insensitively when CSV name differs from registry key', () => {
    const client = {
      id: 'c-ci',
      accountRegistry: {
        APEX1234: { accountName: 'APEX1234', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [{
        date: '2026-06-25',
        snapshots: [{ accountName: 'apex1234', grossRealizedPnl: 300, strategies: [{ strategyName: '1 - RBO-1.8', strategyFamily: 'RBO', enabled: true }] }],
      }],
    };
    const result = buildAlgoComboPerformance([client]);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(1);
  });

  it('computes the recent-window average by real date, not array position', () => {
    // 6 closes 2026-06-01..06; a 3-day window covers only the last three dates
    const clients = [makeClient({ id: 'c1', accountName: 'ACC1', pnls: [10, 20, 30, 40, 50, 60] })];
    const result = buildAlgoComboPerformance(clients, { windowDays: 3 });
    expect(result[0].recentDays).toBe(3);
    expect(result[0].recentAvg).toBeCloseTo((40 + 50 + 60) / 3);
  });

  it('aligns the window across clients with different import cadences (date, not tail)', () => {
    const c1 = makeClient({ id: 'c1', accountName: 'A1', pnls: [1, 2, 3, 4, 5, 6] }); // 06-01..06-06
    const c2 = makeClient({ id: 'c2', accountName: 'A2', pnls: [100, 200] }); // 06-01..06-02
    const result = buildAlgoComboPerformance([c1, c2], { windowDays: 2 });
    // anchor = 2026-06-06; the 2-day window is 06-05/06-06 — c2 has nothing there,
    // so its tail (100,200) must NOT leak into the recent window.
    expect(result[0].recentDays).toBe(2);
    expect(result[0].recentAvg).toBeCloseTo((5 + 6) / 2);
  });
});

// One funded account with a close per day, URGO 4.5 enabled on every one.
function tenCloseClient() {
  const accountName = 'FUND1';
  return {
    id: 'c-ten',
    name: 'Ten closes',
    accountRegistry: { [accountName]: { accountName, accountType: 'Funded', status: 'Active' } },
    dailyImports: Array.from({ length: 10 }, (_, i) => ({
      id: `di-${i}`,
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      accounts: {},
      flags: [],
      executions: [],
      snapshots: [{
        accountName,
        grossRealizedPnl: i % 3 === 0 ? -40 : 25,
        accountBalance: 50000,
        trailingMaxDrawdown: -500,
        strategies: [{ strategyName: '0 - URGO-4.5', strategyFamily: 'URGO', strategyVersion: '4.5', enabled: true, realized: 0 }],
      }],
    })),
  };
}

function renderPlaybook(client = tenCloseClient()) {
  return render(createElement(StackPlaybook, {
    client,
    dailyImport: client.dailyImports[client.dailyImports.length - 1],
    allClients: [client],
    hiddenClientCount: 3,
  }));
}

// The team table, found by the column that only it carries.
function teamTable() {
  return screen.getByText('Account days').closest('table');
}

function accountDaysOf(key) {
  const table = teamTable();
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
  const column = headers.indexOf('Account days');
  const tr = [...table.querySelectorAll('tbody tr')].find((r) => r.querySelector('td strong')?.textContent === key);
  return tr.querySelectorAll('td')[column].textContent;
}

describe('the rendered team panel', () => {
  it('26. labels the figures as client account results and heads the average column honestly', () => {
    const { container } = renderPlaybook();
    expect(container.textContent).toContain('Not comparable to My Futures Book');
    expect(container.textContent).toContain('Client account results while the combo was running. Not the algorithm\'s own track record. Not comparable to My Futures Book.');
    const headers = [...teamTable().querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual([
      'Combo', 'Range', 'Account days', 'Traded days', 'Accounts', 'Clients',
      'Avg P&L per account day', 'Avg P&L per traded day', 'Win rate on traded days',
      'Flat days', 'Trend in window', 'Sample',
    ]);
    // The caption carries the live numbers, the hidden-client count included.
    expect(container.textContent).toContain('10 of 10 funded account days in range');
    expect(container.textContent).toContain('3 inactive clients are not loaded');
    // No dash of any kind in the panel's own copy.
    const panel = teamTable().closest('section');
    expect(panel.textContent).not.toMatch(/[\u2013\u2014]/);
    expect(panel.textContent).not.toMatch(/\s-\s/);
    // The window, grouping and attribution controls carry their exact labels.
    expect([...panel.querySelectorAll('select.window-select option')].map((o) => o.textContent)).toEqual([
      'Last 7 days', 'Last 30 days', 'Last 90 days', 'All history', 'Custom range',
    ]);
    expect([...panel.querySelectorAll('.playbook-toggles button')].map((b) => b.textContent)).toEqual([
      'By version', 'By family', 'Traded (enabled or filled)', 'Enabled at export',
    ]);
    // And the client panel beside it says the same thing in the same words.
    const insight = screen.getByText('Client Config vs Team Avg').closest('section');
    expect([...insight.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Account', 'Combo on this close', 'This account on this combo, avg per account day',
      'Team on this combo, avg per account day', 'Difference', 'Suggestion',
    ]);
    expect(insight.textContent).toContain('Team figures are client account results, not the algorithm\'s own track record.');
    expect(insight.textContent).toContain('No suggestion passes the gate');
    expect(insight.textContent).toContain('10 of 10 days in range');
    expect(insight.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it('27. changes every column when the window select moves from 30 to 7 days', () => {
    renderPlaybook();
    const select = screen.getByLabelText('Window');
    expect(select.value).toBe('30');
    expect(within(select).getByText('Last 30 days')).toBeTruthy();
    expect(accountDaysOf('URGO 4.5')).toBe('10');

    fireEvent.change(select, { target: { value: '7' } });
    expect(select.value).toBe('7');
    expect(accountDaysOf('URGO 4.5')).toBe('7');
  });

  it('28. prefills the custom range from the book and measures the range it is given', () => {
    renderPlaybook();
    const select = screen.getByLabelText('Window');
    expect(screen.queryByLabelText('From')).toBeNull();

    fireEvent.change(select, { target: { value: 'custom' } });
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    // Prefilled with the range the closes cover, not with the 30 day preset's
    // 2026-05-12, and neither input can be pushed outside the book.
    expect(from.value).toBe('2026-06-01');
    expect(to.value).toBe('2026-06-10');
    expect(from.getAttribute('min')).toBe('2026-06-01');
    expect(from.getAttribute('max')).toBe('2026-06-10');
    expect(to.getAttribute('max')).toBe('2026-06-10');
    expect(accountDaysOf('URGO 4.5')).toBe('10');

    fireEvent.change(from, { target: { value: '2026-06-05' } });
    expect(accountDaysOf('URGO 4.5')).toBe('6');
    fireEvent.change(to, { target: { value: '2026-06-07' } });
    expect(accountDaysOf('URGO 4.5')).toBe('3');
  });
});
