// @vitest-environment jsdom
//
// The screen half of the mismatched-account finding, on SYNTHETIC fixtures only,
// so it stays off vite.config.js's localSnapshotTests list and runs on CI. The
// counts against the real book are in accountTypeAlgorithm.book.test.js.
//
// What is asserted here is the thing the markup could undo: printing money on a
// labelling question, leading with the row count, or wording it as a fault.

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AccountTypeMismatchPanel from './AccountTypeMismatchPanel';

afterEach(cleanup);

function client({ id, name, accountType = 'Evaluation - Bullet Bot', accounts = ['A1'], days = [] }) {
  const accountRegistry = {};
  for (const accountName of accounts) {
    accountRegistry[accountName] = { accountName, accountType, status: 'Active' };
  }
  return {
    id,
    name,
    accountRegistry,
    dailyImports: days.map(({ date, rows }) => ({
      id: `${id}-${date}`,
      date,
      accounts: {},
      flags: [],
      snapshots: rows.map(({ account = accounts[0], strategies = [] }) => ({
        accountName: account,
        grossRealizedPnl: -777,
        accountBalance: 50000,
        strategies,
      })),
    })),
  };
}

const on = (family) => ({ strategyFamily: family, enabled: true, realized: -100 });

const swapped = client({
  id: 'swap',
  name: 'Swap client',
  accounts: ['S1'],
  days: [
    { date: '2026-07-10', rows: [{ account: 'S1', strategies: [on('OGX')] }] },
    { date: '2026-07-11', rows: [{ account: 'S1', strategies: [on('OGX')] }] },
  ],
});

const stacked = client({
  id: 'stack',
  name: 'Stack client',
  accounts: ['T1'],
  days: [{ date: '2026-07-10', rows: [{ account: 'T1', strategies: [on('Bullet Bot'), on('IFSP')] }] }],
});

describe('the finding on screen', () => {
  it('leads with accounts and keeps the row count as ageing evidence', () => {
    render(<AccountTypeMismatchPanel clients={[swapped, stacked]} />);
    const intro = document.querySelector('.drift-intro');
    expect(intro.querySelector('strong').textContent).toBe('2');
    expect(intro.textContent).toMatch(
      /2 accounts of the 2 typed for an algorithm are running a different one/,
    );
    expect(screen.getByText(/3 strategy rows behind them/)).toBeTruthy();
  });

  it('separates the swap from the stack in words a manager can act on', () => {
    render(<AccountTypeMismatchPanel clients={[swapped, stacked]} />);
    expect(screen.getByText(/carry no row of the algorithm they are named for at all/))
      .toBeTruthy();
    const row = screen.getByRole('row', { name: /S1/ });
    expect(within(row).getByText('no Bullet Bot row at all')).toBeTruthy();
    const stack = screen.getByRole('row', { name: /T1/ });
    expect(within(stack).getByText(/running Bullet Bot too/)).toBeTruthy();
  });

  it('prints no money, on a panel whose accounts moved -$777 a close', () => {
    const { container } = render(<AccountTypeMismatchPanel clients={[swapped, stacked]} />);
    expect(container.textContent).not.toContain('777');
    expect(container.textContent).not.toContain('$');
    expect(screen.getAllByText(/labelling question, not a performance one/).length)
      .toBeGreaterThan(0);
  });

  it('asks rather than accuses', () => {
    const { container } = render(<AccountTypeMismatchPanel clients={[swapped]} />);
    expect(screen.getByText(/Different is not wrong/)).toBeTruthy();
    // "wrong" appears once, in the sentence that says different is not it, and
    // in the refusal that declines to name which side is stale.
    expect(container.textContent).not.toMatch(/is wrong\b(?! —)/);
  });

  it('reports the same question from the other side', () => {
    const elsewhere = client({
      id: 'std',
      name: 'Standard client',
      accountType: 'Evaluation - Standard',
      accounts: ['E1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'E1', strategies: [on('Bullet Bot')] }] }],
    });
    render(<AccountTypeMismatchPanel clients={[swapped, elsewhere]} />);
    expect(screen.getByText(/The same question from the other side/)).toBeTruthy();
    expect(screen.getByText(/1 evaluations - standard \(1 row\)/)).toBeTruthy();
  });

  it('says the labelling is clean rather than rendering an empty table', () => {
    const clean = client({
      id: 'ok',
      name: 'Clean client',
      accounts: ['B1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('Bullet Bot')] }] }],
    });
    render(<AccountTypeMismatchPanel clients={[clean]} />);
    expect(screen.getByText(/Every account whose type names an algorithm is running that algorithm/))
      .toBeTruthy();
    expect(screen.queryByRole('table')).toBe(null);
  });
});
