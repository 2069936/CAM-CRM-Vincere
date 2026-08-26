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

/**
 * The second finding on the same panel: the programme against the rule it runs
 * under. What the markup could undo is the shape of the count — one headline of
 * "running where it is not typed for" that adds the retired and the untyped
 * accounts to the exceptions and reads several times larger than the work.
 */
describe('the programme against its rule, on screen', () => {
  const runs = (id, accountType) => client({
    id,
    name: id,
    accountType,
    accounts: [`${id}1`],
    days: [{ date: '2026-07-10', rows: [{ strategies: [on('Bullet Bot')] }] }],
  });

  const book = [
    runs('ok', 'Evaluation - Bullet Bot'),
    runs('fund', 'Funded'),
    runs('retired', 'Inactive / Ignore'),
    runs('untyped', 'Unassigned'),
  ];

  it('leads with the exceptions only, and names each one', () => {
    render(<AccountTypeMismatchPanel clients={book} />);
    const intro = document.querySelector('.programme-standing .drift-intro');
    expect(intro.querySelector('strong').textContent).toBe('1');
    expect(intro.textContent).toMatch(
      /1 live account of another type is running Bullet Bot, of the 4 accounts/,
    );
    expect(screen.getByRole('row', { name: /fund1/ })).toBeTruthy();
  });

  it('keeps the retired and untyped accounts out of that number and says why', () => {
    render(<AccountTypeMismatchPanel clients={book} />);
    const groups = document.querySelectorAll('.programme-standing-groups > li');
    const text = [...groups].map((row) => row.textContent);
    expect(text.some((row) => /1 retired/.test(row))).toBe(true);
    expect(text.some((row) => /1 unclassified/.test(row))).toBe(true);
    expect(screen.getByText(/A retired record of what the account used to run/)).toBeTruthy();
    expect(screen.getByText(/classification backlog, not a breach/)).toBeTruthy();
    // The exception table holds the one account, not four.
    const table = screen.getByRole('table', { name: /The exceptions, longest-standing first/ });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('states the rule in the desk’s own words', () => {
    render(<AccountTypeMismatchPanel clients={book} />);
    expect(
      screen.getByText(/the only accounts that run Bullet Bot are evaluation accounts/),
    ).toBeTruthy();
    // Once as the rule, once as the note on the exception group.
    expect(screen.getAllByText(/there should be none/).length).toBe(2);
  });

  it('reports a clean rule rather than disappearing', () => {
    render(<AccountTypeMismatchPanel clients={[runs('ok', 'Evaluation - Bullet Bot')]} />);
    expect(
      screen.getByText(/Every live account running Bullet Bot is an evaluation account/),
    ).toBeTruthy();
    expect(screen.queryByRole('table', { name: /The exceptions/ })).toBe(null);
  });

  it('still asks its question when the labelling half of the panel found nothing', () => {
    // The panel used to return early on a clean labelling finding, which took
    // the rule check off the screen with it. They are two questions, and a
    // panel that goes quiet says nothing was checked.
    render(<AccountTypeMismatchPanel clients={[runs('ok', 'Evaluation - Bullet Bot')]} />);
    expect(screen.getByText(/Every account whose type names an algorithm is running that algorithm/))
      .toBeTruthy();
    expect(screen.getByText(/Bullet Bot against the rule it runs under/)).toBeTruthy();
    expect(
      screen.getByText(/Every live account running Bullet Bot is an evaluation account/),
    ).toBeTruthy();
  });
});
