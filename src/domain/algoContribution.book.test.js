// The book-backed half of algoContribution's suite.
//
// It lives in its own file for one reason: it reads public/local-snapshot.json,
// which is untracked and gitignored, so vite.config.js drops this file whenever
// the snapshot is absent. Anything gated that way is pinned on exactly one
// machine. The synthetic half — including the two guards that stop a partial or
// an over-summing derived split from ever reaching a screen — stays in
// algoContribution.test.js, which is NOT gated and therefore runs on CI and on
// every clone.
//
// The rule for what belongs here: a test belongs in this file if and only if it
// needs the real book. Nothing else.
//
// The numbers below were read off the snapshot by running this module over it,
// not by trusting it. They exist to pin the one thing this feature can get wrong
// in a way nobody would notice: showing a per-algo split that the export never
// actually reported.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAlgoAccountHistory } from './algoContribution';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

describe('the real book', () => {
  const sage = clients.find((c) => c.name === 'Sage Birch');
  const history = buildAlgoAccountHistory(sage, '7448494');

  it('reads the deepest account history in the book', () => {
    expect(history.days).toHaveLength(13);
    expect(history.periods).toHaveLength(6);
    expect(Math.round(history.attribution.accountTotal)).toBe(-5765);
  });

  it('names the algo that actually cost this account the most', () => {
    // The question the Playbook could not answer before: of the four algos on
    // this account, SYFY 1.4 is over half the reported damage.
    const syfy = history.algos.find((a) => a.key.startsWith('SYFY'));
    expect(syfy.reportedPnl).toBe(-2540);
    expect(syfy.reportedDays).toBe(9);
    expect(history.algos.find((a) => a.key.startsWith('URGO')).reportedPnl).toBe(-331);
  });

  it('reports its own coverage instead of implying the split is whole', () => {
    expect(history.attribution.status).toBe('partial');
    expect(history.attribution.attributedDays).toBe(9);
    expect(history.attribution.totalDays).toBe(13);
    expect(Math.round(history.attribution.unattributedPnl)).toBe(-904);
  });

  it('keeps combination periods exact even where attribution is missing', () => {
    // The guarantee that makes the top table trustworthy regardless of what the
    // Strategies tab did or did not report: the periods account for every
    // dollar of the account's history.
    const summed = history.periods.reduce((n, p) => n + p.totalPnl, 0);
    expect(summed).toBeCloseTo(history.attribution.accountTotal, 6);
  });

  it('finds that most accounts have no per-algo split at all', () => {
    // Why the UI leads with combinations and treats the split as a bonus.
    const statuses = {};
    for (const c of clients) {
      const names = new Set();
      for (const di of c.dailyImports || []) for (const s of di.snapshots || []) names.add(s.accountName);
      for (const n of names) {
        const s = buildAlgoAccountHistory(c, n).attribution.status;
        statuses[s] = (statuses[s] || 0) + 1;
      }
    }
    expect(statuses).toEqual({ unavailable: 616, partial: 65, complete: 8 });
  });
});
