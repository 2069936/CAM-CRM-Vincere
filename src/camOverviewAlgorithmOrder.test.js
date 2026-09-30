// The same ordering defect, on the screen a CAM opens on.
//
// `algorithmTemperatureOrder.test.js` beside this file pins `buildClientOverview`,
// which listed OGX at -$405 marked Cold above G4M at +$360 marked Hot because
// 405 > 360. `buildCamOverview` carried the third copy of that comparator, and
// it feeds the "Algorithm rollup" table on the CAM overview: `setPlatformView`
// opens there, so it is the first algorithm list of the session.
//
// On the stored book the rollup read Bullet Bot -$18,590, RBO -$7,856,
// SYFY -$3,890, B2X -$2,372, OGX_PF -$848 and only then ARPD_PF at +$434, with
// RBO_PF at +$294 in eighth. Both winning rows sat under five losers.
//
// These tests pin the order to the figure the "Total daily" column prints.

import { describe, expect, it } from 'vitest';
import { buildCamOverview } from './domain/camOverview';

/* One close, one client, one funded account per algorithm, one strategy row on
 * each. `enabled: true` is what `withStrategyRan` answers "it ran" from when a
 * close carries no fills, and `realized` is the contribution verbatim: no
 * attribution rule is under test here, only the ordering. */
function bookWith(byAlgorithm) {
  const entries = Object.entries(byAlgorithm);
  return [{
    id: 'c1',
    name: 'Test client',
    accountRegistry: Object.fromEntries(entries.map((_entry, i) => [
      `ACC-${i}`, { accountName: `ACC-${i}`, accountType: 'Funded', status: 'Active' },
    ])),
    dailyImports: [{
      date: '2026-09-29',
      accounts: {},
      executions: [],
      snapshots: entries.map(([family, realized], i) => ({
        accountName: `ACC-${i}`,
        weeklyPnl: 0,
        grossRealizedPnl: realized,
        strategies: [{
          strategyName: `0 - ${family}`,
          strategyFamily: family,
          strategyVersion: '',
          enabled: true,
          realized,
        }],
      })),
    }],
  }];
}

const rollupOrder = (byAlgorithm) => buildCamOverview(bookWith(byAlgorithm))
  .algorithms
  .map((group) => group.key);

describe('the algorithm rollup is ordered by the figure it prints', () => {
  it('puts a smaller winner above a larger loser', () => {
    // The shape of the stored book's rollup: one winner, several bigger losers.
    // |-18590| > |434|, and the loser used to win the top row for it.
    expect(rollupOrder({
      'Bullet Bot': -18590,
      RBO: -7856,
      SYFY: -3890,
      ARPD_PF: 434,
      RBO_PF: 294,
    })).toEqual(['ARPD_PF', 'RBO_PF', 'SYFY', 'RBO', 'Bullet Bot']);
  });

  it('is descending by totalRealized, the column the table shows', () => {
    const order = buildCamOverview(bookWith({ A: -900, B: 20, C: 700, D: -30, E: 55 }));
    const totals = order.algorithms.map((group) => group.totalRealized);
    expect(totals).toEqual([...totals].sort((x, y) => y - x));
  });

  it('never seats a losing row above a winning one', () => {
    const groups = buildCamOverview(bookWith({ A: -900, B: 20, C: 700, D: -30 })).algorithms;
    const firstLoser = groups.findIndex((group) => group.totalRealized < 0);
    const lastWinner = groups.map((group) => group.totalRealized >= 0).lastIndexOf(true);
    expect(lastWinner).toBeLessThan(firstLoser);
  });

  it('breaks a tie by key rather than by whatever order the accounts arrived in', () => {
    // Two algorithms flat on the same close must not swap places between
    // renders; the list is read as a ranking and a jitter reads as a change.
    expect(rollupOrder({ Zulu: 0, Alpha: 0, Mike: 0 })).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('orders two versions of one family, which a tie on the name would not', () => {
    /* These rows are `algorithm + version`, so the comparator's tiebreak is the
     * KEY. Two flat versions of OGX_PF tie on the family name and would still
     * be unordered if the tiebreak read `algorithm`. */
    const clients = bookWith({ OGX_PF: 0, ARPD: 0 });
    clients[0].dailyImports[0].snapshots[0].strategies[0].strategyVersion = '2.4';
    clients[0].dailyImports[0].snapshots.push({
      accountName: 'ACC-9',
      weeklyPnl: 0,
      grossRealizedPnl: 0,
      strategies: [{
        strategyName: '0 - OGX_PF', strategyFamily: 'OGX_PF', strategyVersion: '1.1', enabled: true, realized: 0,
      }],
    });
    clients[0].accountRegistry['ACC-9'] = { accountName: 'ACC-9', accountType: 'Funded', status: 'Active' };
    expect(buildCamOverview(clients).algorithms.map((group) => group.key))
      .toEqual(['ARPD', 'OGX_PF 1.1', 'OGX_PF 2.4']);
  });

  it('leaves the peer deviation flags reading the same groups', () => {
    // The ordering change must not move what counts as a peer group or what
    // trips a flag underneath it: `deviationFlags` walks `algorithms` in order
    // and a reorder that dropped or merged a group would be silent here.
    const clients = bookWith({ RBO: 100 });
    const snapshot = clients[0].dailyImports[0].snapshots[0];
    for (const [i, realized] of [200, 150, -900].entries()) {
      clients[0].accountRegistry[`RBO-${i}`] = { accountName: `RBO-${i}`, accountType: 'Funded', status: 'Active' };
      clients[0].dailyImports[0].snapshots.push({
        ...snapshot,
        accountName: `RBO-${i}`,
        grossRealizedPnl: realized,
        strategies: [{ ...snapshot.strategies[0], realized }],
      });
    }
    const { algorithms, deviationFlags } = buildCamOverview(clients);
    expect(algorithms).toHaveLength(1);
    expect(algorithms[0].instances).toBe(4);
    expect(deviationFlags.map((flag) => flag.accountName)).toEqual(['RBO-2']);
  });
});
