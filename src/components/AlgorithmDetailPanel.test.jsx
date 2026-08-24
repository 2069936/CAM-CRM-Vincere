// @vitest-environment jsdom
//
// The screen half of the algorithm ranking and its detail view, on SYNTHETIC
// fixtures only — which is what keeps this file off vite.config.js's
// localSnapshotTests list, so it runs on CI and on every clone. The renders that
// need the real book are in AlgorithmDetailPanel.book.test.jsx.
//
// What is asserted here is what the domain refuses and the markup could still
// undo: a block per account type reappearing, a P&L printed beside an account
// type — including the roster's own Account type column, which is that pairing
// one grouping step away — a per-business money list reappearing beside the
// account-days that are its denominator, a total on the day back in the close
// table or in a bar's tooltip, two businesses' money added into one line, a
// client with no attributable split rendered as $0, a close nobody measured
// rendered as a zero, and the refusal list quietly shortened. The domain guards
// are in algorithmRanking.test.js; these check the screen honours them.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlgorithmDetailPanel from './AlgorithmDetailPanel';
import AlgorithmRankingPanel from './AlgorithmRankingPanel';
import { algorithmRefusals, buildAlgorithmDetail, buildStrategyRanking } from '../domain/algorithmRanking';

afterEach(cleanup);

function client({ id, name, accountType = 'Funded', accounts = ['A1'], days = [] }) {
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
      snapshots: rows.map(({ account = accounts[0], pnl = 0, strategies = [] }) => ({
        accountName: account,
        grossRealizedPnl: pnl,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies,
      })),
    })),
  };
}

const on = (algo, realized, { targets = [100, 200, 300], stop = 50, sizes = [1, 1, 0] } = {}) => [{
  strategyFamily: algo,
  strategyVersion: '1.0',
  instrument: 'MNQ SEP26',
  enabled: true,
  params: { profitTargets: targets, stopLossTicks: stop, posSizes: sizes },
  ...(realized === undefined ? {} : { realized }),
}];

/** Ten funded accounts x four closes, so SUBJECT clears the gate. */
function propBulk() {
  const accounts = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  return client({
    id: 'prop',
    name: 'Prop client',
    accounts,
    days: Array.from({ length: 4 }, (_, d) => ({
      date: `2026-07-1${d}`,
      rows: accounts.map((account) => ({ account, pnl: -50, strategies: on('SUBJECT', -50) })),
    })),
  });
}

const cashClient = client({
  id: 'cash',
  name: 'Cash client',
  accountType: 'Cash',
  accounts: ['C1'],
  days: [
    { date: '2026-07-10', rows: [{ account: 'C1', pnl: 900, strategies: on('SUBJECT', 900) }] },
  ],
});

const openDetail = (clients, algorithm = 'SUBJECT') =>
  render(<AlgorithmDetailPanel detail={buildAlgorithmDetail(clients, { algorithm })} />);

/** The roster table of the algorithm's own block, by its caption. */
const overallRoster = () =>
  within(screen.getByRole('table', { name: /Every client running it, best first/ }));

describe('one algorithm, one block per configuration', () => {
  it('heads a block with the configuration, never with an account type', () => {
    openDetail([propBulk(), cashClient]);
    expect(screen.getByRole('heading', { name: 'v1.0 · PT 100/200/300 · SL 50' })).toBeTruthy();
    // The headings the rejected build printed. A block per business is what made
    // one algorithm read as several.
    expect(screen.queryByRole('heading', { name: 'Cash' })).toBe(null);
    expect(screen.queryByRole('heading', { name: 'Other prop algos' })).toBe(null);
    expect(screen.getByRole('heading', { name: 'Across every account it ran on' })).toBeTruthy();
  });

  it('prints one mean for the algorithm, not one per account type', () => {
    // -$50 a day on ten funded accounts and +$900 on one cash account is one run
    // of one configuration. Pooled it is -$27 a day over 41 account-days.
    openDetail([propBulk(), cashClient]);
    expect(screen.getAllByText('-$27').length).toBeGreaterThan(0);
    // Two headline means on the page — the algorithm's and its one
    // configuration's. The rejected build printed one per business, which on
    // this fixture is where "+$900 a day on cash" came from.
    expect(screen.getAllByText('Mean P&L per reported account-day')).toHaveLength(2);
  });

  it('prints no per-business money for the algorithm or a configuration, and says why', () => {
    openDetail([propBulk(), cashClient]);
    // There was a list here: "Other prop algos -$2,000 over 40 account-days" and
    // "Cash $900 over 1 account-day", never added into -$1,100. Divide either
    // line by the account-days printed inside it and the account-type verdict is
    // back — -$50 a day on prop, +$900 a day on cash, which is the pair this
    // whole view was rebuilt to stop producing.
    expect(document.querySelectorAll('.algo-money-list')).toHaveLength(0);
    expect(screen.queryByText('-$1,100')).toBe(null);
    // One refusal in every block — the algorithm's and each configuration's —
    // rather than a silent omission, because the list looked like the careful
    // answer and was built once already.
    const blocks = [...document.querySelectorAll('.algo-detail-segment')];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(within(block).getByText(/No dollar figure on this population/)).toBeTruthy();
      expect(within(block).getByText(/not one total, and not one per business either/))
        .toBeTruthy();
    }
  });

  it('leaves the money per business on the desk, so the separation is not deleted', () => {
    // The other half. Prop dollars and cash dollars genuinely must not be added,
    // so each business still states its own — over every algorithm at once,
    // which is what stops it reading as this algorithm's cash performance.
    openDetail([propBulk(), cashClient]);
    expect(screen.getByText(/What Other prop algos does not see:/)).toBeTruthy();
    expect(screen.getByText(/What Cash does not see:/)).toBeTruthy();
    expect(screen.getByText(/The only dollars on this page carrying a business are these/))
      .toBeTruthy();
  });

  it('never prints an account type in the same row as a dollar', () => {
    openDetail([propBulk(), cashClient]);
    // The account roster used to carry an Account type column beside "What it
    // made". Grouping 11 rows by that column is the same figure the block above
    // refuses, arrived at by hand.
    const accounts = within(
      document.querySelector('.algo-detail-overall .algo-detail-accounts table'),
    );
    const headers = accounts.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Account', 'Client', 'What it made', 'Source', 'Seen']);
    expect(headers).not.toContain('Account type');
    // And the type is still on screen where it has no money beside it.
    const deployment = within(
      screen.getAllByRole('table', { name: /Account types this algorithm is deployed on/ })[0],
    );
    expect(deployment.getByRole('row', { name: /Funded/ })).toBeTruthy();
  });

  it('renders the account type as counts, under a refusal, with no money column', () => {
    openDetail([propBulk(), cashClient]);
    const table = within(
      screen.getAllByRole('table', { name: /Account types this algorithm is deployed on/ })[0],
    );
    const headers = table.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual([
      'Account type', 'Business', 'Account-days', 'Accounts', 'Clients', 'Share of deployment',
    ]);
    expect(headers.some((header) => /P&L|Mean|made/i.test(header))).toBe(false);
    const funded = table.getByRole('row', { name: /Funded/ });
    expect(within(funded).getByText('40')).toBeTruthy();
    expect(screen.getAllByText(/property of the ACCOUNT, not of the run/).length)
      .toBeGreaterThan(0);
  });

  it('refuses to read a configuration below the gate and says which arm failed', () => {
    const thin = client({
      id: 'thin',
      name: 'Thin client',
      accounts: ['T1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'T1', pnl: -20, strategies: on('SUBJECT', -20, { targets: [30, 60, 90], stop: 181 }) }] }],
    });
    openDetail([propBulk(), thin]);
    expect(screen.getByRole('heading', { name: 'v1.0 · PT 30/60/90 · SL 181' })).toBeTruthy();
    expect(screen.getByText('not enough evidence to read')).toBeTruthy();
    expect(
      screen.getAllByText(/1 reported account-day, fewer than the 30 a result needs/).length,
    ).toBeGreaterThan(0);
    // And the page says outright that there is no comparison to make.
    expect(screen.getByText(/1 of the 2 configurations below carries the 30/)).toBeTruthy();
  });

  it('names the position sizing beside a configuration rather than inside it', () => {
    openDetail([propBulk()]);
    expect(screen.getByText(/1\/1\/0 on 40 account-days/)).toBeTruthy();
    expect(screen.getByText(/MNQ SEP26 on 40/)).toBeTruthy();
  });

  it('publishes every refusal the domain names, never a shortened list', () => {
    const clients = [propBulk(), cashClient];
    openDetail(clients);
    const expected = algorithmRefusals(buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }));
    expect(expected.length).toBeGreaterThan(3);
    expect(
      screen.getByText(`${expected.length} figures this view will not produce, and why`),
    ).toBeTruthy();
    for (const row of expected) {
      expect(screen.getAllByText(row.figure).length).toBeGreaterThan(0);
    }
  });

  it('states each business’s coverage rather than one number over all of them', () => {
    openDetail([propBulk(), cashClient]);
    const leads = screen.getAllByText(/does not see:/);
    expect(leads).toHaveLength(2);
    expect(screen.getByText(/What Other prop algos does not see:/)).toBeTruthy();
    expect(screen.getByText(/What Cash does not see:/)).toBeTruthy();
  });
});

describe('a client the split cannot answer for', () => {
  it('prints a refusal, not $0 and not a share of the account’s own day', () => {
    const dark = client({
      id: 'dark',
      name: 'Unmeasured client',
      accounts: ['D1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'D1', pnl: 700, strategies: on('SUBJECT') }] }],
    });
    openDetail([propBulk(), dark]);
    const row = overallRoster().getByRole('row', { name: /Unmeasured client/ });
    expect(within(row).getByText('not attributable')).toBeTruthy();
    expect(within(row).queryByText('$0')).toBe(null);
    // The account made $700 that day and it must not appear beside the algorithm.
    expect(within(row).queryByText(/700/)).toBe(null);
    expect(screen.queryByText('$700')).toBe(null);
  });

  it('names the unmeasured account-days beside a client it can only partly answer', () => {
    const half = client({
      id: 'half',
      name: 'Half client',
      accounts: ['H1'],
      days: [
        { date: '2026-07-10', rows: [{ account: 'H1', pnl: -120, strategies: on('SUBJECT', -120) }] },
        { date: '2026-07-11', rows: [{ account: 'H1', pnl: 900, strategies: on('SUBJECT') }] },
      ],
    });
    openDetail([propBulk(), half]);
    const row = overallRoster().getByRole('row', { name: /Half client/ });
    expect(within(row).getByText('-$120')).toBeTruthy();
    expect(within(row).getByText('over 1 account-day')).toBeTruthy();
    expect(within(row).getByText('1 not measured')).toBeTruthy();
    // Not folded in: -120 + 900 would be $780.
    expect(within(row).queryByText('$780')).toBe(null);
  });
});

describe('the chart of closes', () => {
  const sparse = () => client({
    id: 'sparse',
    name: 'Sparse',
    accounts: ['S1'],
    days: [
      { date: '2026-07-10', rows: [{ account: 'S1', pnl: -80, strategies: on('SUBJECT', -80) }] },
      { date: '2026-07-11', rows: [{ account: 'S1', pnl: -10, strategies: on('OTHER', -10) }] },
    ],
  });

  it('calls a close nobody measured "not measured", never a zero', async () => {
    const user = userEvent.setup();
    openDetail([sparse()]);
    await user.click(screen.getAllByText('Close by close')[0]);
    const row = screen.getAllByRole('row', { name: /2026-07-11/ })[0];
    expect(within(row).getByText('not measured on this close')).toBeTruthy();
    expect(within(row).queryByText('$0')).toBe(null);
  });

  it('gives a close a rate and a count, and no total on the day', () => {
    // The fourth column here was headed "Total on the day" and carried the
    // money-is-per-business tooltip, which is the opposite of what the number
    // was: one close is whichever accounts ran that day, so the sum adds a cash
    // dollar to a prop dollar. Every bar's tooltip repeated it.
    const clients = [propBulk(), cashClient];
    openDetail(clients);
    const closes = within(
      document.querySelector('.algo-detail-overall .algo-detail-closes table'),
    );
    const headers = closes.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Close', 'Per account-day', 'Account-days']);
    expect(headers).not.toContain('Total on the day');
    for (const title of document.querySelectorAll('.algo-detail-series svg title')) {
      expect(title.textContent).not.toMatch(/in total/);
    }
    // 2026-07-10 is 10 prop account-days at -$50 and one cash account-day at
    // +$900. The mean, +$36.36, is a rate and stays; +$400, the sum, was a cash
    // dollar added to a prop dollar and printed a gain on a day every one of the
    // ten prop accounts lost money.
    expect(screen.getAllByText('$36').length).toBeGreaterThan(0);
    expect(screen.queryByText('$400')).toBe(null);
  });

  it('says how many of the book’s closes it was measured on', () => {
    openDetail([sparse()]);
    expect(screen.getAllByText('1 of 2 closes measured').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nothing is fitted through the bars/).length).toBeGreaterThan(0);
  });

  it('refuses the chart outright rather than drawing an empty axis', () => {
    const dark = client({
      id: 'dark',
      name: 'Dark',
      accounts: ['D1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'D1', pnl: 300, strategies: on('SUBJECT') }] }],
    });
    openDetail([dark]);
    expect(screen.getAllByText(/nothing to chart/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('img')).toBe(null);
  });

  it('ends on the book’s last close even when the wall clock is months later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-01T00:00:00Z'));
    try {
      openDetail([propBulk()]);
      expect(screen.getAllByText('2026-07-13').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Per account-day, seven days to 2026-07-13/).length)
        .toBeGreaterThan(0);
      expect(screen.queryByText(/2027/)).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an algorithm the ranking does not carry', () => {
  it('says so instead of rendering a page of zeroes', () => {
    openDetail([propBulk()], 'NOPE');
    expect(screen.getByText('not in the ranking')).toBeTruthy();
    expect(screen.getByText(/Nothing in this book carries a row for/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBe(null);
  });
});

describe('the ranking table it opens from', () => {
  it('gives one algorithm one row, and puts no dollar of any kind on it', () => {
    const result = buildStrategyRanking([propBulk(), cashClient]);
    render(<AlgorithmRankingPanel result={result} />);
    // One row for SUBJECT, not one per business.
    expect(screen.getAllByRole('row', { name: /SUBJECT/ })).toHaveLength(1);
    const row = screen.getByRole('row', { name: /SUBJECT/ });
    // The row carried "Prop algos -$2,000 · 40d" and "Cash $900 · 1d" in one
    // cell — never added into -$1,100, and still the account-type verdict for
    // anyone who divides. None of the three is here.
    expect(within(row).queryByText('-$2,000')).toBe(null);
    expect(within(row).queryByText('$900')).toBe(null);
    expect(within(row).queryByText('-$1,100')).toBe(null);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers.some((header) => /per business/i.test(header))).toBe(false);
    // The money is under the table, per business, and it is the desk's.
    expect(screen.getByText(/What Other prop algos does not see:/)).toBeTruthy();
    expect(screen.getByText(/What Cash does not see:/)).toBeTruthy();
    // And there is exactly one table of algorithms on the page.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('names the contract on the row, because the unit is not size-normalised', () => {
    render(<AlgorithmRankingPanel result={buildStrategyRanking([propBulk()])} />);
    expect(screen.getByText(/MNQ SEP26/)).toBeTruthy();
    // Stated above the table and repeated in the refusal list, so it is on the
    // page whichever of the two a reader is looking at.
    expect(screen.getAllByText(/An algorithm on NQ moves roughly ten times/)).toHaveLength(2);
  });

  it('opens the algorithm the row names, and closes it when picked again', async () => {
    const user = userEvent.setup();
    const result = buildStrategyRanking([propBulk(), cashClient]);
    const onSelect = vi.fn();
    render(
      <AlgorithmRankingPanel result={result} selectedAlgorithm={null} onSelectAlgorithm={onSelect} />,
    );
    await user.click(screen.getAllByRole('button', { name: /SUBJECT/ })[0]);
    expect(onSelect).toHaveBeenCalledWith('SUBJECT');

    cleanup();
    render(
      <AlgorithmRankingPanel
        result={result}
        selectedAlgorithm="SUBJECT"
        onSelectAlgorithm={onSelect}
      />,
    );
    await user.click(screen.getAllByRole('button', { name: /SUBJECT/ })[0]);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('leaves the name as plain text where nothing can open it', () => {
    render(<AlgorithmRankingPanel result={buildStrategyRanking([propBulk()])} />);
    expect(screen.queryByRole('button', { name: /SUBJECT/ })).toBe(null);
    expect(screen.getByText('SUBJECT')).toBeTruthy();
  });
});
