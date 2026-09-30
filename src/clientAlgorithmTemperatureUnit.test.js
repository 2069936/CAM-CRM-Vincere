// What the per-client "Algorithm temperature" panel's figure is a figure OF.
//
// The badge over that list said "Last 3 closes". It never was. `lastThree` in
// `buildClientOverview` is filled by pushing one contribution per
// (snapshot, strategy) PAIR as the walk goes through every close, every
// snapshot in it and every strategy row on that snapshot, keeping the last
// three. So one element is one algorithm on one account on one close: an
// account row. A client running one family across four accounts fills all three
// slots inside a SINGLE close, and the badge called that three closes.
//
// algorithmTemperature.js documents this in its own header and fixes the unit
// for the desk-wide panel, where heat is the last three TRADING DATES an
// algorithm was credited on. The two panels answer the same question in two
// units, which is survivable, and only one of them was labelled, which was not.
//
// Two halves here, because the defect had two:
//   * the arithmetic, which must NOT change: three rows inside one close, read
//     back off the real builder;
//   * the label, which is in JSX inside a 17,000-line component and can only be
//     reached by reading the source, the way src/domain/appSaveWiring.test.js
//     reaches the save wiring.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildClientOverview } from './App.jsx';

const APP = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

/* ONE close. Four accounts. One family on each. This is the shape the header of
 * algorithmTemperature.js names: "for a client running one family on four
 * accounts it spans four accounts inside one close and not three closes at
 * all." */
const ONE_CLOSE_FOUR_ACCOUNTS = {
  date: '2026-09-29',
  snapshots: ['A-1', 'A-2', 'A-3', 'A-4'].map((accountName, i) => ({
    accountName,
    grossRealizedPnl: 300,
    strategies: [{
      strategyFamily: 'URGO',
      strategyName: '0 - URGO',
      derivedRealized: 300 + i,
      enabled: true,
    }],
  })),
};

const overviewOf = (close) => buildClientOverview(
  { id: 'c1', name: 'Test', dailyImports: [close], tradingAccounts: [] },
  close,
);

describe('the per client temperature figure', () => {
  it('is three ACCOUNT ROWS, which one close can supply all three of', () => {
    const { algorithms } = overviewOf(ONE_CLOSE_FOUR_ACCOUNTS);
    expect(algorithms).toHaveLength(1);
    // The client history holds exactly one close. The figure is the sum of the
    // LAST three of its four account rows: 301 + 302 + 303. Not 300 (one
    // close), not 1,206 (all four rows). There is no reading of this number
    // under which it covers three closes, because there is only one.
    expect(algorithms[0].days).toBe(4);
    expect(algorithms[0].recentTotal).toBe(906);
    expect(algorithms[0].temperature).toBe('Hot');
  });

  it('is unchanged by this fix, which moved a label and no arithmetic', () => {
    // Three closes, one account: the case the old badge happened to describe.
    // It must read exactly as it did before.
    const closes = [100, 200, 4000].map((pnl, i) => ({
      date: `2026-09-2${i + 5}`,
      snapshots: [{
        accountName: 'A-1',
        grossRealizedPnl: pnl,
        strategies: [{ strategyFamily: 'G4M', strategyName: '0 - G4M', derivedRealized: pnl, enabled: true }],
      }],
    }));
    const client = { id: 'c2', name: 'Test', dailyImports: closes, tradingAccounts: [] };
    const { algorithms } = buildClientOverview(client, closes.at(-1));
    expect(algorithms[0].recentTotal).toBe(4300);
    expect(algorithms[0].days).toBe(3);
  });
});

describe('the badge over that list', () => {
  // The panel is the one headed "Algorithm temperature" on the client page;
  // the heading and its badge are adjacent in the JSX.
  const badge = (() => {
    const heading = APP.indexOf('<h3>Algorithm temperature</h3>');
    expect(heading).toBeGreaterThan(-1);
    const slice = APP.slice(heading, heading + 2000);
    const match = slice.match(/<span className="badge muted">([\s\S]*?)<\/span>/);
    return match ? match[1].replace(/\s+/g, ' ').trim() : '';
  })();

  it('no longer calls the unit a close', () => {
    // The exact string the panel carried, and the claim the fixture above
    // disproves in one close.
    expect(APP).not.toContain('<span className="badge muted">Last 3 closes</span>');
    expect(badge).not.toBe('Last 3 closes');
  });

  it('names the unit the figure is actually in', () => {
    expect(badge).toBe('Last 3 account rows per algorithm, not 3 closes');
  });
});
