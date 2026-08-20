// @vitest-environment jsdom
//
// The book-backed half of AlgoContributionPanel's suite: every assertion here
// renders a real client out of public/local-snapshot.json. That is why it is
// separate — vite.config.js drops this file when the snapshot is absent, so
// nothing pinned here is pinned on CI. The synthetic renders, including the
// derived-split ones, stay in AlgoContributionPanel.test.jsx, which is not
// gated.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import AlgoContributionPanel from './AlgoContributionPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

// jsdom gives import.meta.url an http scheme, so the snapshot is resolved from
// the project root the way the other jsdom suites do.
const snapshot = JSON.parse(
  readFileSync(resolve(cwd(), 'public/local-snapshot.json'), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);
const jordan = clients.find((c) => c.name === 'Jordan Larch');
const grayElm = clients.find((c) => c.name === 'Gray Elm');

afterEach(cleanup);

async function open(client, accountName) {
  const user = userEvent.setup();
  render(<AlgoContributionPanel client={client} accountName={accountName} />);
  await user.click(screen.getByRole('button'));
}

describe('an account whose export never reported a split', () => {
  // Gray Elm / FKJEEGABE388758794757: 13 days, four algos, not one day
  // attributed — the majority case in the book (616 of 689 accounts).
  it('says so rather than printing $0 next to every algo', async () => {
    await open(grayElm, 'FKJEEGABE388758794757');
    const rows = screen.getAllByText('not attributable');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByText(/no day carries a per-algo split/)).toBeTruthy();
  });

  it('still shows what the account did, because that part is known', async () => {
    await open(grayElm, 'FKJEEGABE388758794757');
    // The combination table is exact even here — that is the whole point of
    // leading with it.
    expect(screen.getByText(/Combination/)).toBeTruthy();
    expect(screen.queryAllByText(/\$/).length).toBeGreaterThan(0);
  });
});

describe('an account with a partial split', () => {
  // CGFGJB931350378998: 6 of 13 days attributed.
  it('states the coverage instead of implying the split is whole', async () => {
    await open(jordan, 'CGFGJB931350378998');
    expect(screen.getByText(/6 of 13 days carry a per-algo split/)).toBeTruthy();
  });

  // Every stored close in this snapshot predates derivation, so each of these
  // figures came off NinjaTrader's Strategies grid. The panel has to say so:
  // a derived number and a reported one are not equally checkable, and once
  // both appear on the same table a reader who cannot tell them apart cannot
  // judge either.
  it('names the source of each contribution rather than leaving it implied', async () => {
    await open(jordan, 'CGFGJB931350378998');
    expect(screen.getAllByText('reported by export').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('derived from fills').length).toBe(0);
    expect(screen.getByText(/6 reported by NinjaTrader/)).toBeTruthy();
  });

  it('labels a contribution with the number of days it covers', async () => {
    await open(jordan, 'CGFGJB931350378998');
    // "over 6d" is what stops the figure from being read as the algo's whole
    // history on this account.
    expect(screen.getAllByText(/over \d+d/).length).toBeGreaterThan(0);
  });
});

describe('the collapsed state', () => {
  it('leads with the count of combinations, not with a dollar figure', () => {
    render(<AlgoContributionPanel client={jordan} accountName="CGFGJB931350378998" />);
    const toggle = screen.getByRole('button');
    expect(toggle.textContent).toMatch(/5 combinations over 13 days/);
    expect(toggle.textContent).not.toMatch(/\$/);
  });

  it('renders nothing at all for an account with no stored history', () => {
    const { container } = render(<AlgoContributionPanel client={jordan} accountName="does-not-exist" />);
    expect(container.innerHTML).toBe('');
  });
});

