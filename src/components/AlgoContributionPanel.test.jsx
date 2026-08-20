// @vitest-environment jsdom
//
// The panel is asserted on rendered text, not on props, because the thing that
// can go wrong here is a presentation bug: showing a per-algo dollar figure on
// an account whose export never reported one. The domain refuses to compute
// that (algoContribution.test.js pins the refusal); these check the screen
// honours the refusal instead of rendering a zero that reads like a result.
//
// Every fixture in this file is SYNTHETIC, which is what keeps it out of
// vite.config.js's localSnapshotTests list: it runs on CI and on every clone,
// not only on the machine that holds public/local-snapshot.json. The renders
// that do need the real book are in AlgoContributionPanel.book.test.jsx.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import AlgoContributionPanel from './AlgoContributionPanel';

afterEach(cleanup);

async function open(client, accountName) {
  const user = userEvent.setup();
  render(<AlgoContributionPanel client={client} accountName={accountName} />);
  await user.click(screen.getByRole('button'));
}

describe('a period where every algo was switched off', () => {
  it('names it instead of leaving the cell blank', async () => {
    const client = {
      dailyImports: [
        { date: '2026-07-13', snapshots: [{ accountName: 'A', grossRealizedPnl: -300, strategies: [{ strategyFamily: 'IFSP', strategyVersion: '1.1', enabled: true, realized: 0 }] }] },
        { date: '2026-07-14', snapshots: [{ accountName: 'A', grossRealizedPnl: -776, strategies: [{ strategyFamily: 'IFSP', strategyVersion: '1.1', enabled: false, realized: 0 }] }] },
      ],
    };
    await open(client, 'A');
    expect(screen.getByText('no enabled algo')).toBeTruthy();
    // The account still lost money that day and the panel must not hide it.
    // Total and Avg/day are both -$776 on a one-day period, hence getAllByText.
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getAllByText('-$776').length).toBe(2);
  });
});

describe('a split the fills derived', () => {
  // Synthetic, because the stored snapshot cannot carry a derivation: its
  // `time_text` and `entry_exit` columns are redacted, so nothing in it can be
  // paired. See the header of algoContribution.js.
  const derivedClient = {
    dailyImports: [{
      date: '2026-08-18',
      snapshots: [{
        accountName: 'A',
        grossRealizedPnl: 110,
        // `reportedGross` is on every derivation reconcile emits, and the panel
        // will not print a derived figure without it: the rows have to be shown
        // adding up to the account's own gross before any of them is displayed.
        derivation: {
          status: 'exact',
          reportedGross: 110,
          residual: { realized: 0, pairs: 0, reasons: {} },
          join: { status: 'exact', published: true, offRoster: [], offRosterRealized: 0 },
        },
        strategies: [
          { strategyFamily: 'IFSP', strategyVersion: '1.1', enabled: true, realized: null, derivedRealized: 80 },
          { strategyFamily: 'RBO', strategyVersion: '1.8', enabled: true, realized: null, derivedRealized: 30 },
        ],
      }],
    }],
  };

  it('labels a derived figure as derived, not as something the export reported', async () => {
    await open(derivedClient, 'A');
    expect(screen.getAllByText('derived from fills').length).toBe(2);
    expect(screen.queryAllByText('reported by export').length).toBe(0);
    expect(screen.getByText(/1 derived from fills/)).toBeTruthy();
  });

  it('prints the derived contribution the export left blank', async () => {
    await open(derivedClient, 'A');
    const table = screen.getAllByRole('table')[1];
    expect(within(table).getByText('$80 over 1d')).toBeTruthy();
    expect(within(table).getByText('$30 over 1d')).toBeTruthy();
  });

  it('shows money that belongs to no single algo instead of hiding it', async () => {
    // The rule that keeps the rows honest: they no longer sum to the account
    // total, so the panel has to say where the difference went.
    const withResidual = {
      dailyImports: [{
        date: '2026-08-18',
        snapshots: [{
          accountName: 'A',
          grossRealizedPnl: 38,
          derivation: { status: 'partial', residual: { realized: -72, pairs: 1, reasons: { 'manual-leg': 1 } } },
          strategies: [{ strategyFamily: 'ARPD', strategyVersion: '1.1', enabled: true, realized: 110, derivedRealized: null }],
        }],
      }],
    };
    await open(withResidual, 'A');
    expect(screen.getByText(/-\$72 was paired from the fills but belongs to no single/)).toBeTruthy();
  });

  it('names derived money whose strategy is on no row of the Strategies grid', async () => {
    // The failure this line exists for: the account made $100, the fills gave
    // all of it to RBO-1.8, and RBO-1.8 is on no grid row. The panel used to
    // print "all 1 days carry a per-algo split", one row at "$0 over 1d", and no
    // residual — the $100 gone and the split shown as complete.
    const offRoster = {
      dailyImports: [{
        date: '2026-08-18',
        snapshots: [{
          accountName: 'A',
          grossRealizedPnl: 100,
          derivation: {
            status: 'exact',
            reportedGross: 100,
            residual: { realized: 0, pairs: 0, reasons: {} },
            join: {
              status: 'off-roster',
              published: false,
              offRoster: [{ strategyName: 'RBO-1.8', realized: 100 }],
              offRosterRealized: 100,
            },
          },
          strategies: [{ strategyFamily: 'IFSP', strategyVersion: '1.1', enabled: true, realized: null, derivedRealized: null }],
        }],
      }],
    };
    await open(offRoster, 'A');
    expect(screen.getByText('not attributable')).toBeTruthy();
    expect(screen.getByText(/no day carries a per-algo split — \$100 unattributed/)).toBeTruthy();
    expect(screen.getByText(/\$100 of that was credited by the fills to RBO-1.8/)).toBeTruthy();
    expect(screen.queryAllByText('derived from fills').length).toBe(0);
  });
});
