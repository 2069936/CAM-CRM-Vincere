// The one thing a list headed "Algorithm temperature" has to get right.
//
// It sorted by |recentTotal|, which is the size of the move and not its
// direction, so the biggest mover sat on top whichever way it moved. On
// 2026-09-29 the client screen listed OGX at -$405 marked Cold ABOVE G4M at
// +$360 marked Hot, because 405 > 360. Every row's own label was correct and
// the order contradicted all of them.
//
// The CAM reads this top-down to decide what to keep running. These tests pin
// the order to the temperature, not to the volume.

import { describe, expect, it } from 'vitest';
import { buildClientOverview } from './App.jsx';

/* One close, one account, one strategy row per algorithm. `derivedRealized`
 * is what the roll-up prefers, so the figures below are the contributions
 * verbatim - no attribution rule is under test here, only the ordering. */
const closeWith = (byAlgorithm) => ({
  date: '2026-09-29',
  snapshots: [{
    accountName: 'APEX-1',
    grossRealizedPnl: Object.values(byAlgorithm).reduce((a, b) => a + b, 0),
    strategies: Object.entries(byAlgorithm).map(([strategyFamily, derivedRealized]) => ({
      strategyFamily, strategyName: `0 - ${strategyFamily}`, derivedRealized, enabled: true,
    })),
  }],
});

const overviewFor = (byAlgorithm) => {
  const close = closeWith(byAlgorithm);
  const client = { id: 'c1', name: 'Test', dailyImports: [close], tradingAccounts: [] };
  return buildClientOverview(client, close);
};

describe('the temperature list is ordered by temperature', () => {
  it('puts a smaller winner above a larger loser', () => {
    // The exact pair off the 2026-09-29 screen. |-405| > |360|, and the loser
    // used to win the top row for it.
    const { algorithms } = overviewFor({ OGX: -405, G4M: 360, URGO: 302 });
    expect(algorithms.map((a) => a.name)).toEqual(['G4M', 'URGO', 'OGX']);
  });

  it('agrees with the label it prints beside each row', () => {
    /* Hot above Stable above Cold, always. A reader must never find a row
     * marked Cold sitting above one marked Hot. */
    const { algorithms } = overviewFor({ A: -900, B: 20, C: 700, D: -30 });
    const rank = { Hot: 0, Stable: 1, Cold: 2 };
    const labels = algorithms.map((a) => rank[a.temperature]);
    expect(labels).toEqual([...labels].sort((x, y) => x - y));
    expect(algorithms[0].name).toBe('C');
  });

  it('is descending by the figure it shows', () => {
    const { algorithms } = overviewFor({ A: -900, B: 20, C: 700, D: -30, E: 55 });
    const totals = algorithms.map((a) => a.recentTotal);
    expect(totals).toEqual([...totals].sort((x, y) => y - x));
  });

  it('breaks a tie by name rather than by whatever order the rows arrived in', () => {
    // Two algorithms flat on the same close must not swap places between
    // renders; the list is read as a ranking and a jitter reads as a change.
    const { algorithms } = overviewFor({ Zulu: 0, Alpha: 0, Mike: 0 });
    expect(algorithms.map((a) => a.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('still labels each row by the same thresholds', () => {
    // The ordering change must not move the Hot/Cold boundary underneath it.
    const { algorithms } = overviewFor({ Hotter: 251, Edge: 250, Colder: -251 });
    const byName = Object.fromEntries(algorithms.map((a) => [a.name, a.temperature]));
    expect(byName).toEqual({ Hotter: 'Hot', Edge: 'Stable', Colder: 'Cold' });
  });
});
