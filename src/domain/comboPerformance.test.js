// The rules behind the Stack Playbook's team table, on synthetic fixtures, so
// CI runs them. comboPerformance.book.test.js holds the numbers against the
// book and is dropped on every clone without public/local-snapshot.json.
//
// Each test carries its number from docs/stack-playbook-spec.md section 5.

import { describe, expect, it } from 'vitest';
import {
  buildClientComboInsights,
  buildComboPerformance,
  comboKeyFromDay,
  DEFAULT_OPTIONS,
  MIN_ACCOUNTS,
  MIN_DAYS,
} from './comboPerformance';
import { buildComboByFirm } from './stackAnalytics';

const strategy = (family, version, { enabled = true, realized = 0 } = {}) => ({
  strategyName: `0 - ${family.replace('_PF', '-PF')}-${version}`,
  strategyFamily: family,
  strategyVersion: version,
  enabled,
  realized,
});

const execution = (accountName, strategyName) => ({ accountName, strategyName, quantity: 1 });

// One client, one account, one close per entry of `days`. Each day is
// `{ date, pnl, strategies, executions }`; strategies default to URGO 4.5
// enabled so a bare `{ date, pnl }` is an ordinary URGO day.
function client({ id = 'c1', accountName = 'ACC1', accountType = 'Funded', status = 'Active', dateFailed = '', days = [] } = {}) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType, status, dateFailed },
    },
    dailyImports: days.map(({ date, pnl = 0, strategies = [strategy('URGO', '4.5')], executions = [] }) => ({
      date,
      accounts: {},
      snapshots: [{ accountName, grossRealizedPnl: pnl, strategies }],
      executions: executions.map((name) => execution(accountName, name)),
    })),
  };
}

const june = (day) => `2026-06-${String(day).padStart(2, '0')}`;
const ALL = { window: { preset: 'all' } };
const row = (perf, key) => perf.rows.find((r) => r.key === key) || null;

describe('comboKeyFromDay', () => {
  it('1. keeps IFSP_PF as IFSP_PF, with its version', () => {
    const snap = { strategies: [strategy('IFSP_PF', '1.1')] };
    expect(comboKeyFromDay(snap, [], { basis: 'enabled', level: 'version' }).key).toBe('IFSP_PF 1.1');
    expect(comboKeyFromDay(snap, [], { basis: 'enabled', level: 'family' }).key).toBe('IFSP_PF');
  });

  it('2. separates two versions of one family at version level and folds them at family level', () => {
    const snap = { strategies: [strategy('URGO', '4.5'), strategy('URGO', '2.0')] };
    expect(comboKeyFromDay(snap, [], { basis: 'enabled', level: 'version' }).key).toBe('URGO 2.0 + URGO 4.5');
    expect(comboKeyFromDay(snap, [], { basis: 'enabled', level: 'family' }).key).toBe('URGO');
  });

  it('3. attributes a disabled, zero-realized strategy from the fills on the traded basis only', () => {
    const snap = { strategies: [strategy('OGX', '2.4', { enabled: false, realized: 0 })] };
    const fills = [execution('ACC1', '0 - OGX-2.4')];
    expect(comboKeyFromDay(snap, fills, { basis: 'traded', level: 'version' })).toEqual({
      key: 'OGX 2.4', elements: ['OGX 2.4'], reason: 'fills',
    });
    expect(comboKeyFromDay(snap, fills, { basis: 'enabled', level: 'version' })).toEqual({
      key: 'Unknown', elements: [], reason: 'none',
    });
  });

  it('4. reads a PF fill name the way the grid stores the family', () => {
    const snap = { strategies: [] };
    const fills = [execution('ACC1', '0 - OGX-PF-2.4')];
    expect(comboKeyFromDay(snap, fills, { basis: 'traded', level: 'version' }).key).toBe('OGX_PF 2.4');
    expect(comboKeyFromDay(snap, fills, { basis: 'traded', level: 'family' }).key).toBe('OGX_PF');
  });

  it('attributes a switched-off strategy that still reported realized money', () => {
    const snap = { strategies: [strategy('B2X', '2.5', { enabled: false, realized: -120 })] };
    expect(comboKeyFromDay(snap, [], { basis: 'traded', level: 'version' })).toEqual({
      key: 'B2X 2.5', elements: ['B2X 2.5'], reason: 'realized',
    });
    expect(comboKeyFromDay(snap, [], { basis: 'enabled', level: 'version' }).key).toBe('Unknown');
  });
});

describe('buildComboPerformance', () => {
  const sixCloses = [10, 20, 30, 40, 50, 60].map((pnl, i) => ({ date: june(i + 1), pnl }));

  it('5. runs every accumulator over the preset window only', () => {
    const other = client({ id: 'c2', accountName: 'EARLY', days: [{ date: june(1), pnl: 500 }, { date: june(2), pnl: 500 }] });
    const perf = buildComboPerformance([client({ days: sixCloses }), other], { window: { preset: 3 } });
    expect(perf.window).toMatchObject({ preset: 3, from: '2026-06-04', to: '2026-06-06', anchor: '2026-06-06' });
    const urgo = row(perf, 'URGO 4.5');
    expect(urgo.days).toBe(3);
    expect(urgo.avgPnl).toBeCloseTo((40 + 50 + 60) / 3);
    expect(urgo.totalPnl).toBe(150);
    expect(urgo.accounts).toBe(1);
    expect(urgo.clients).toBe(1);
    expect(urgo.firstDate).toBe('2026-06-04');
    expect(urgo.lastDate).toBe('2026-06-06');
    expect(perf.population.fundedDays).toBe(3);
  });

  it('6. honours an explicit from/to range, inclusive on both ends', () => {
    const perf = buildComboPerformance([client({ days: sixCloses })], { window: { from: '2026-06-02', to: '2026-06-03' } });
    const urgo = row(perf, 'URGO 4.5');
    expect(urgo.days).toBe(2);
    expect(urgo.totalPnl).toBe(50);
    expect(urgo.firstDate).toBe('2026-06-02');
    expect(urgo.lastDate).toBe('2026-06-03');
    expect(perf.window.from).toBe('2026-06-02');
    expect(perf.window.to).toBe('2026-06-03');
  });

  it('7. counts a Failed account by its own days unless includeFailed is off', () => {
    const failed = client({ status: 'Failed', days: [1, 2, 3].map((d) => ({ date: june(d), pnl: -100 })) });
    const included = buildComboPerformance([failed], { includeFailed: true, ...ALL });
    expect(row(included, 'URGO 4.5').days).toBe(3);
    expect(row(included, 'URGO 4.5').failedAccounts).toBe(1);
    expect(included.population.failedAccountDays).toBe(3);

    const excluded = buildComboPerformance([failed], { includeFailed: false, ...ALL });
    expect(excluded.rows).toEqual([]);
    expect(excluded.population.fundedDays).toBe(0);
  });

  it('8. counts a flat day as an account day but not a traded day, and rates wins over traded days', () => {
    const perf = buildComboPerformance([client({ days: [
      { date: june(1), pnl: 100 }, { date: june(2), pnl: 0 }, { date: june(3), pnl: -50 }, { date: june(4), pnl: 0 },
    ] })], ALL);
    const urgo = row(perf, 'URGO 4.5');
    expect(urgo).toMatchObject({ days: 4, tradedDays: 2, flatDays: 2, winDays: 1, lossDays: 1 });
    expect(urgo.winRate).toBeCloseTo(0.5);
    expect(urgo.avgPnl).toBeCloseTo(12.5);
    expect(urgo.avgTradedPnl).toBeCloseTo(25);

    const flatOnly = buildComboPerformance([client({ days: [{ date: june(1), pnl: 0 }, { date: june(2), pnl: 0 }] })], ALL);
    expect(row(flatOnly, 'URGO 4.5').winRate).toBeNull();
    expect(row(flatOnly, 'URGO 4.5').avgTradedPnl).toBeNull();
  });

  it('9. flags a one-day, one-account row as a low sample and never crowns it', () => {
    const lucky = client({ id: 'lucky', accountName: 'L1', days: [{ date: june(1), pnl: 1000, strategies: [strategy('OGX', '2.4')] }] });
    // Ten URGO accounts on ten clients, one close each, so URGO passes the gate.
    const crowd = Array.from({ length: 10 }, (_, i) => client({ id: `c${i}`, accountName: `A${i}`, days: [{ date: june(1), pnl: 10 }] }));
    const perf = buildComboPerformance([lucky, ...crowd], ALL);
    expect(row(perf, 'OGX 2.4').lowSample).toBe(true);
    expect(row(perf, 'OGX 2.4').avgPnl).toBeGreaterThan(row(perf, 'URGO 4.5').avgPnl);
    expect(row(perf, 'URGO 4.5').lowSample).toBe(false);
    expect(perf.best.key).toBe('URGO 4.5');
    // Gated rows sort first, low-sample rows after them, whatever the average.
    expect(perf.rows.map((r) => r.key)).toEqual(['URGO 4.5', 'OGX 2.4']);
    expect(perf.minDays).toBe(MIN_DAYS);
    expect(perf.minAccounts).toBe(MIN_ACCOUNTS);
  });

  it('10. has no best when nothing passes the gate, and then suggests nothing', () => {
    const only = client({ days: [{ date: june(1), pnl: 500 }, { date: june(2), pnl: 500 }] });
    const perf = buildComboPerformance([only], ALL);
    expect(perf.best).toBeNull();
    const insights = buildClientComboInsights(only, only.dailyImports[1], perf);
    expect(insights).toHaveLength(1);
    expect(insights.every((i) => i.suggestion === null)).toBe(true);
    expect(insights[0].note).toBe('No combo passes the sample gate');
  });

  it('11. reports n/a under five days a half, and stable when both halves lose the same', () => {
    const four = client({ days: [1, 2, 3, 4].map((d) => ({ date: june(d), pnl: -100 })) });
    expect(row(buildComboPerformance([four], ALL), 'URGO 4.5').trend).toBe('n/a');

    // Window 06-01..06-10, split at 06-06: five closes a half, both at -100.
    const ten = client({ days: Array.from({ length: 10 }, (_, i) => ({ date: june(i + 1), pnl: -100 })) });
    const flat = row(buildComboPerformance([ten], ALL), 'URGO 4.5');
    expect(flat).toMatchObject({ priorDays: 5, recentDays: 5, trend: 'stable' });
    expect(flat.priorAvg).toBeCloseTo(-100);
    expect(flat.recentAvg).toBeCloseTo(-100);

    const better = client({ days: Array.from({ length: 10 }, (_, i) => ({ date: june(i + 1), pnl: i < 5 ? -100 : -50 })) });
    expect(row(buildComboPerformance([better], ALL), 'URGO 4.5').trend).toBe('up');
    const worse = client({ days: Array.from({ length: 10 }, (_, i) => ({ date: june(i + 1), pnl: i < 5 ? -100 : -150 })) });
    expect(row(buildComboPerformance([worse], ALL), 'URGO 4.5').trend).toBe('down');
  });

  it('splits the closes the window holds, not the empty calendar in front of them', () => {
    // Ten closes 06-01..06-10 inside a 30 day window that opens on 05-12.
    // Halving the calendar put every close in the second half and left the
    // first one empty, so the column read n/a on a row with ten days; halving
    // the closes gives five and five.
    const ten = client({ days: Array.from({ length: 10 }, (_, i) => ({ date: june(i + 1), pnl: i < 5 ? -100 : -50 })) });
    const perf = buildComboPerformance([ten], { window: { preset: 30 } });
    expect(perf.window.from).toBe('2026-05-12');
    const urgo = row(perf, 'URGO 4.5');
    expect(urgo).toMatchObject({ days: 10, priorDays: 5, recentDays: 5, trend: 'up' });
    expect(urgo.priorAvg).toBeCloseTo(-100);
    expect(urgo.recentAvg).toBeCloseTo(-50);
  });

  it('exposes the defaults the screen starts from', () => {
    expect(DEFAULT_OPTIONS).toEqual({
      basis: 'traded',
      level: 'version',
      window: { preset: 30, from: null, to: null },
      minDays: 10,
      minAccounts: 3,
      includeFailed: true,
    });
  });
});

describe('buildClientComboInsights', () => {
  // A gated best so a suggestion can fire: OGX at +200 on ten accounts.
  const bestCrowd = (avg) => Array.from({ length: 10 }, (_, i) => client({
    id: `b${i}`, accountName: `B${i}`, days: [{ date: june(1), pnl: avg, strategies: [strategy('OGX', '2.4')] }],
  }));
  // A gated team row for URGO at `avg`.
  const teamCrowd = (avg) => Array.from({ length: 10 }, (_, i) => client({
    id: `t${i}`, accountName: `T${i}`, days: [{ date: june(1), pnl: avg }],
  }));

  it('12. averages only this account\'s closes on the combo it runs on the viewed close', () => {
    const mine = client({ id: 'me', accountName: 'ME', days: [
      { date: june(1), pnl: 100 },
      { date: june(2), pnl: -500, strategies: [] },
      { date: june(3), pnl: 100 },
    ] });
    const perf = buildComboPerformance([mine, ...teamCrowd(10)], ALL);
    const [insight] = buildClientComboInsights(mine, mine.dailyImports[2], perf);
    expect(insight.currentKey).toBe('URGO 4.5');
    expect(insight.accountAvg).toBe(100);
    expect(insight.accountDaysOnCombo).toBe(2);
    expect(insight.accountDaysTotal).toBe(3);
    expect(insight.teamRow.key).toBe('URGO 4.5');
    expect(insight.teamAvg).toBeCloseTo(perf.rows.find((r) => r.key === 'URGO 4.5').avgPnl);
    expect(insight.delta).toBeCloseTo(100 - insight.teamAvg);
  });

  it('13. says so when the viewed close carries no algo', () => {
    const mine = client({ id: 'me', accountName: 'ME', days: [{ date: june(1), pnl: -20, strategies: [] }] });
    const perf = buildComboPerformance([mine, ...bestCrowd(200)], ALL);
    expect(perf.best).not.toBeNull();
    const [insight] = buildClientComboInsights(mine, mine.dailyImports[0], perf);
    expect(insight.currentKey).toBe('Unknown');
    expect(insight.suggestion).toBeNull();
    expect(insight.note).toBe('No algo recorded on this close');
    expect(insight.teamAvg).toBeNull();
  });

  it('separates "nothing passed the gate" from "nothing that passed it makes money"', () => {
    // Ten accounts on ten clients, one close each, all losing: the row passes
    // MIN_DAYS and MIN_ACCOUNTS, so a note saying nothing passes the gate is a
    // sentence the Sample column contradicts on every row.
    const crowd = teamCrowd(-10);
    const perf = buildComboPerformance(crowd, ALL);
    expect(row(perf, 'URGO 4.5').lowSample).toBe(false);
    expect(perf.best).toBeNull();
    const [insight] = buildClientComboInsights(crowd[0], crowd[0].dailyImports[0], perf);
    expect(insight.suggestion).toBeNull();
    expect(insight.note).toBe('No combo with a positive average passes the sample gate');
  });

  it('14. suggests only when the best clears the team figure by the larger of $25 and 15%', () => {
    const mine = client({ id: 'me', accountName: 'ME', days: [{ date: june(1), pnl: 10 }] });
    const fire = (bestAvg) => {
      const perf = buildComboPerformance([mine, ...teamCrowd(10), ...bestCrowd(bestAvg)], ALL);
      expect(perf.best.key).toBe('OGX 2.4');
      return buildClientComboInsights(mine, mine.dailyImports[0], perf)[0];
    };
    expect(fire(30).suggestion).toBeNull();
    expect(fire(30).note).toBe('No change suggested');
    expect(fire(60).suggestion).toBe('OGX 2.4');
    expect(fire(60).best.key).toBe('OGX 2.4');
  });
});

describe('buildComboByFirm', () => {
  it('15. folds the spellings of one firm into one column and keeps the Funded population', () => {
    const day = (account, connection) => ({
      date: june(1),
      snapshots: [{ accountName: account, connection, grossRealizedPnl: 100, strategies: [strategy('URGO', '4.5')] }],
      executions: [],
    });
    const c = {
      id: 'c1',
      accountRegistry: {
        F1: { accountName: 'F1', accountType: 'Funded', status: 'Active' },
        F2: { accountName: 'F2', accountType: 'Funded', status: 'Active' },
        F3: { accountName: 'F3', accountType: 'Funded', status: 'Active' },
        E1: { accountName: 'E1', accountType: 'Evaluation - Standard', status: 'Active' },
      },
      dailyImports: [day('F1', 'Blusky '), day('F2', 'BLUSKY'), day('F3', 'BlueSky'), day('E1', 'BluSky')],
    };
    const result = buildComboByFirm([c], (snap, execs) => comboKeyFromDay(snap, execs).key);
    expect(result.firms).toEqual(['BluSky']);
    expect(result.combos).toEqual(['URGO 4.5']);
    expect(result.matrix[0].cells).toEqual([{ firm: 'BluSky', avgPnl: 100, days: 3 }]);
  });

  it('counts only the closes inside the window it is given', () => {
    // The caption says "same population as the table above"; the table runs on
    // the selected window, so the cross-tab has to as well.
    const day = (date, grossRealizedPnl) => ({
      date,
      snapshots: [{ accountName: 'F1', connection: 'Lucid', grossRealizedPnl, strategies: [strategy('URGO', '4.5')] }],
      executions: [],
    });
    const c = {
      id: 'c1',
      accountRegistry: { F1: { accountName: 'F1', accountType: 'Funded', status: 'Active' } },
      dailyImports: [day(june(1), -400), day(june(5), 100), day(june(6), 300)],
    };
    const comboFn = (snap, execs) => comboKeyFromDay(snap, execs).key;
    expect(buildComboByFirm([c], comboFn).matrix[0].cells[0]).toEqual({ firm: 'Lucid', avgPnl: 0, days: 3 });
    const windowed = buildComboByFirm([c], comboFn, { window: { from: june(5), to: june(6) } });
    expect(windowed.matrix[0].cells[0]).toEqual({ firm: 'Lucid', avgPnl: 200, days: 2 });
  });
});
