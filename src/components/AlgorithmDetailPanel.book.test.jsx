// @vitest-environment jsdom
//
// The book-backed half of AlgorithmDetailPanel's suite: what the desk actually
// sees when it opens OGX. vite.config.js drops this file when
// public/local-snapshot.json is absent, so NOTHING HERE IS PINNED ON CI — every
// rule the panel must not break is in AlgorithmDetailPanel.test.jsx, which is
// ungated.
//
// It exists because the design now rests on the opposite claim to the one it
// used to: that "how has OGX been doing" has ONE answer, and that what splits it
// is its configuration rather than the type of the accounts it ran on. If that
// stops being true of this book, this file should be the thing that says so.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AlgorithmDetailPanel from './AlgorithmDetailPanel';
import AlgorithmRankingPanel from './AlgorithmRankingPanel';
import { buildAlgorithmDetail, buildStrategyRanking } from '../domain/algorithmRanking';

const snapshot = JSON.parse(readFileSync(resolve(cwd(), 'public/local-snapshot.json'), 'utf8'));
const { buildCrmStateFromTables } = await import('../domain/supabaseStore');
const { clients } = buildCrmStateFromTables(snapshot.tables);

afterEach(cleanup);

const open = (algorithm) =>
  render(<AlgorithmDetailPanel detail={buildAlgorithmDetail(clients, { algorithm })} />);

const blockFor = (heading) =>
  within(
    [...document.querySelectorAll('.algo-detail-segment')].find(
      (block) => block.querySelector('h4').textContent === heading,
    ),
  );

describe('opening OGX off a ranking row', () => {
  it('shows one algorithm at #2 with three configurations under it', () => {
    open('OGX');
    expect(screen.getByRole('heading', { name: 'Algorithm · OGX' })).toBeTruthy();
    expect(screen.getByText('3 configurations · #2 of 8 ranked')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Across every account it ran on' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'v2.4 · PT 220/395/495 · SL 200' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'v2.4 · PT 200/350/425 · SL 200' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'v2.4 · PT 30/60/90 · SL 181' })).toBeTruthy();
  });

  it('prints neither of the two account-type verdicts the rejected build produced', () => {
    open('OGX');
    // +$23.52 on cash and -$54.12 on ordinary prop, rendered as "$24" and
    // "-$54" by formatCurrency. Neither is a reading of OGX.
    expect(screen.queryByText('$24')).toBe(null);
    expect(screen.queryByText('-$54')).toBe(null);
    expect(screen.queryByRole('heading', { name: 'Cash' })).toBe(null);
    expect(screen.queryByRole('heading', { name: 'Other prop algos' })).toBe(null);
    expect(screen.queryByRole('heading', { name: 'Bullet Bot' })).toBe(null);
  });

  it('reads -$12 a day over 77 account-days, with an interval that crosses zero', () => {
    open('OGX');
    const overall = blockFor('Across every account it ran on');
    expect(overall.getByText('#2 of 8 ranked')).toBeTruthy();
    expect(overall.getByText('-$12')).toBeTruthy();
    expect(overall.getByText('95% CI -$45 to $21')).toBeTruthy();
    expect(overall.getByText('77 account-days')).toBeTruthy();
    expect(overall.getByText(/24 accounts · 19 clients/)).toBeTruthy();
  });

  it('keeps the account type as counts, under the refusal that says why', () => {
    open('OGX');
    const table = within(
      screen.getByRole('table', { name: /Account types this algorithm is deployed on/ }),
    );
    const cash = table.getByRole('row', { name: /^Cash/ });
    expect(within(cash).getByText('47')).toBeTruthy();
    expect(within(cash).getByText('61%')).toBeTruthy();
    // The money that used to sit on this row is not on it.
    expect(within(cash).queryByText(/\$/)).toBe(null);
    expect(
      screen.getAllByText(/No P&L and no mean per account type/).length,
    ).toBeGreaterThan(0);
  });

  it('reads the one configuration that carries evidence, and refuses the other two', () => {
    open('OGX');
    const main = blockFor('v2.4 · PT 220/395/495 · SL 200');
    expect(main.getByText('reads as a result · 70 account-days on 21 accounts')).toBeTruthy();
    expect(main.getByText('-$10')).toBeTruthy();
    expect(main.getByText('95% CI -$46 to $26')).toBeTruthy();
    expect(main.getByText(/1\/1\/0 on 70 account-days/)).toBeTruthy();
    expect(main.getByText('13 of 14 closes measured')).toBeTruthy();

    expect(screen.getAllByText('not enough evidence to read')).toHaveLength(2);
    expect(
      screen.getByText(/1 of the 3 configurations below carries the 30 reported account-days/),
    ).toBeTruthy();
    const thin = blockFor('v2.4 · PT 30/60/90 · SL 181');
    expect(thin.getByText(/4 reported account-days, fewer than the 30 a result needs/)).toBeTruthy();
    // The only OGX configuration at a different risk level, named beside it.
    expect(thin.getByText(/1\/2\/1 on 4 account-days/)).toBeTruthy();
  });

  it('prints no money for OGX or for a configuration of it, at any sign', () => {
    open('OGX');
    // The overall block used to carry -$1,570 on ordinary prop, +$1,106 on cash
    // and -$459 on bullet-bot, never added — the careful-looking answer. The
    // deployment table three inches below it prints 29, 47 and 1 account-days
    // against the same three buckets, so the screen published -$54.12 and
    // +$23.52 with a division left to the reader. It is not printed now, in any
    // block, and neither is the -$923 that adding them would give.
    expect(document.querySelectorAll('.algo-money-list')).toHaveLength(0);
    for (const gone of ['-$1,570', '$1,106', '-$923', '-$922.50', '$24', '-$54']) {
      expect(screen.queryByText(gone)).toBe(null);
    }
    // Every block says so rather than falling silent.
    const blocks = [...document.querySelectorAll('.algo-detail-segment')];
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      expect(within(block).getByText(/No dollar figure on this population/)).toBeTruthy();
    }
    // -$459 survives on exactly one row: the single bullet-bot-typed ACCOUNT OGX
    // ran on made that, and the roster names the account. One account is not an
    // account type, and its row carries no account type beside the figure.
    const accounts = within(document.querySelector('.algo-detail-overall .algo-detail-accounts table'));
    expect(accounts.getAllByText('-$459')).toHaveLength(1);
    expect(accounts.getAllByRole('columnheader').map((cell) => cell.textContent))
      .toEqual(['Account', 'Client', 'What it made', 'Source', 'Seen']);
  });

  it('charts every close as a rate, with no total on the day', () => {
    open('OGX');
    // 2026-07-30: five prop account-days at +$7.00 and four cash ones at
    // -$285.50. The column headed "Total on the day" printed -$278.50 — a cash
    // dollar added to a prop dollar, and the wrong SIGN for the prop desk —
    // twice, once here and once on the main configuration's chart below.
    for (const table of document.querySelectorAll('.algo-detail-closes table')) {
      expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent))
        .toEqual(['Close', 'Per account-day', 'Account-days']);
    }
    for (const title of document.querySelectorAll('.algo-detail-series svg title')) {
      expect(title.textContent).not.toMatch(/in total/);
    }
    expect(screen.queryByText('-$279')).toBe(null);
    expect(screen.queryByText('-$278.50')).toBe(null);
    // The rate for that close is kept, on both charts, in the page's own unit.
    expect(screen.getAllByText('-$31').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-$35').length).toBeGreaterThan(0);
  });

  it('names the clients running it and repeats what each business does not see', () => {
    open('OGX');
    const table = within(screen.getByRole('table', { name: /Every client running it, best first/ }));
    const best = table.getByRole('row', { name: /Wren Moss/ });
    expect(within(best).getByText('$935')).toBeTruthy();
    // Every dollar on this export came off NinjaTrader's Strategies grid; the
    // snapshot predates the fill-derived split.
    expect(within(best).getByText('reported 4d')).toBeTruthy();
    expect(screen.getByText(/What Cash does not see:/)).toBeTruthy();
    expect(screen.getByText(/53.72% of it — is in no algorithm/)).toBeTruthy();
  });
});

describe('opening an algorithm the ranking refuses to rank', () => {
  it('shows ARPD_PF with its counts and no position', () => {
    open('ARPD_PF');
    expect(screen.getByText(/no rank/)).toBeTruthy();
    expect(
      screen.getAllByText(/2 reported account-days, fewer than the 30 a rank needs/).length,
    ).toBeGreaterThan(0);
    const overall = blockFor('Across every account it ran on');
    expect(overall.getByText('2 account-days')).toBeTruthy();
    // One configuration, and it is refused on the same evidence the rank was.
    expect(screen.getByText('1 configuration, most evidence first')).toBeTruthy();
    expect(screen.getByText('not enough evidence to read')).toBeTruthy();
    expect(
      screen.getByText('This algorithm runs one configuration on this book, so there is no comparison to make.'),
    ).toBeTruthy();
    // Neither seven-day window measured it, so the trend is refused rather than
    // drawn level — on the algorithm and on the configuration alike.
    expect(screen.getAllByText('not measured')).toHaveLength(4);
  });
});

describe('the ranking table itself, over the real book', () => {
  it('renders fourteen algorithms as fourteen rows, ranked eight, plus the programme', () => {
    // The panel is otherwise only seen against fixtures, and the book is where
    // the shapes fixtures do not have live: a row with four businesses of money
    // on it, a row whose windows refuse a trend, a name with a space in it.
    render(<AlgorithmRankingPanel result={buildStrategyRanking(clients)} />);
    expect(screen.getByText(/8 ranked · 6 without a rank/)).toBeTruthy();
    expect(screen.getByText(/1 programme off the ranking/)).toBeTruthy();
    const body = screen.getByRole('table').querySelectorAll('tbody tr');
    // Fourteen ranked-population rows and the programme's own, which is the
    // fifteenth line on the table and holds no rank and no mean.
    expect(body).toHaveLength(15);
    expect(body[14].className).toBe('board-programme');
    const ogx = screen.getByRole('row', { name: /^1?2\s*OGX/ });
    expect(within(ogx).getByText('-$12')).toBeTruthy();
    expect(within(ogx).getByText('95% CI -$45 to $21')).toBeTruthy();
    // The row carried three businesses of money — -$459, -$1,570, +$1,106 —
    // with each business's account-days in the same cell, and no fourth figure
    // adding them. That was still the account-type verdict, one division away.
    // The only dollars on the row now are rates per account-day.
    for (const gone of ['-$459', '-$1,570', '$1,106', '-$923']) {
      expect(within(ogx).queryByText(gone)).toBe(null);
    }
    // And the desk's money, per business, is under the table where it belongs.
    expect(screen.getByText(/What Cash does not see:/)).toBeTruthy();
    expect(screen.getByText(/What Other prop algos does not see:/)).toBeTruthy();
  });

  it("puts the programme's own figure nowhere a reader could sort it", () => {
    // -$93.68 per account-day is what it read at #7. The number is on the page
    // exactly twice — in the refusal on its row and in the refusal drawer —
    // and in neither place is it in a column.
    const { container } = render(<AlgorithmRankingPanel result={buildStrategyRanking(clients)} />);
    const row = screen.getByRole('row', { name: /Bullet Bot/ });
    expect(within(row).getByText('not ranked')).toBeTruthy();
    expect(within(row).getByText(/A programme, not a peer of the rows above/)).toBeTruthy();
    expect(within(row).getByText('Bullet Bot across the desk')).toBeTruthy();
    expect(within(row).getByText(/337 measured account-days on 115 accounts across 34 clients/))
      .toBeTruthy();
    expect(container.textContent).not.toContain('93.68');
  });
});
