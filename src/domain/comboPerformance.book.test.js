// The book-backed half of the combo performance suite.
//
// It reads public/local-snapshot.json, so vite.config.js drops it on every clone
// that does not hold the book and NOTHING HERE IS PINNED ON CI. The rules live
// in comboPerformance.test.js, which is ungated. What is here is what needs 96
// clients and 14 closes to be sayable at all: that the new aggregator, asked
// for the OLD rules, reproduces the old table to the cent, and that asked for
// the new ones it says what docs/stack-playbook-spec.md says it should.
//
// Every figure below was computed from the raw tables by
// scratchpad/playbook/spec_numbers.py and cross-checked against the previous
// component aggregator (audit.md, recompute.md), not read off this module.
// Each test carries its number from the spec's section 5.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildComboPerformance } from './comboPerformance';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const state = buildCrmStateFromTables(snapshot.tables);
const { clients } = state;

const ALL = { preset: 'all' };
const row = (perf, key) => perf.rows.find((r) => r.key === key) || null;
const sumOf = (rows, field) => rows.reduce((s, r) => s + r[field], 0);

// Today's table: enabled at export, family keys, current-status population.
const legacy = { basis: 'enabled', level: 'family', includeFailed: false, window: ALL };

describe('the old rules, reproduced', () => {
  const perf = buildComboPerformance(clients, legacy);

  it('16. lands on the same 311 account days and the same dollars as the table it replaces', () => {
    expect(sumOf(perf.rows, 'days')).toBe(311);
    expect(sumOf(perf.rows, 'totalPnl')).toBeCloseTo(-45500.83, 2);
    // 33 rows, not the old 32: IFSP_PF no longer folds into IFSP.
    expect(perf.rows).toHaveLength(33);
    expect(row(perf, 'URGO')).toMatchObject({
      days: 66, accounts: 25, clients: 18, firstDate: '2026-07-13', lastDate: '2026-07-30',
    });
    expect(row(perf, 'URGO').totalPnl).toBeCloseTo(-4275.38, 2);
    expect(row(perf, 'URGO').avgPnl).toBeCloseTo(-64.78, 2);
  });

  it('17. keeps the one-day +$265 row off the throne', () => {
    const versioned = buildComboPerformance(clients, { ...legacy, level: 'version' });
    const crown = row(versioned, 'ARPD_PF 1.1 + IFSP_PF 1.1 + OGX 2.4 + RBO_PF 1.8');
    expect(crown).not.toBeNull();
    expect(crown.days).toBe(1);
    expect(crown.accounts).toBe(1);
    expect(crown.lowSample).toBe(true);
    expect(versioned.best).not.toBe(crown);
    expect(versioned.best?.key).not.toBe(crown.key);
    // Whoever is best passed the gate.
    if (versioned.best) expect(versioned.best.lowSample).toBe(false);
  });

  it('20. moves URGO and RBO, and three more, when the Failed accounts keep their own days', () => {
    const withFailed = buildComboPerformance(clients, { ...legacy, includeFailed: true });
    expect(row(perf, 'URGO')).toMatchObject({ days: 66 });
    expect(row(perf, 'URGO').avgPnl).toBeCloseTo(-64.78, 2);
    expect(row(withFailed, 'URGO')).toMatchObject({ days: 70 });
    expect(row(withFailed, 'URGO').avgPnl).toBeCloseTo(-73.98, 2);
    expect(row(perf, 'RBO')).toMatchObject({ days: 4 });
    expect(row(perf, 'RBO').avgPnl).toBeCloseTo(-240.75, 2);
    expect(row(withFailed, 'RBO')).toMatchObject({ days: 6 });
    expect(row(withFailed, 'RBO').avgPnl).toBeCloseTo(-287.1, 2);
    // The six Failed accounts' twelve known-combo days land on five rows, the
    // five the spec's section 2.5 table lists; every other row is untouched.
    const moved = {
      'URGO': [70, -73.98],
      'RBO': [6, -287.1],
      'IFSP + URGO': [35, -149.25],
      'IFSP + OGX + RBO': [10, -252.4],
      'ARPD + URGO': [12, 73.03],
    };
    for (const [key, [days, avg]] of Object.entries(moved)) {
      expect(row(withFailed, key).days).toBe(days);
      expect(row(withFailed, key).avgPnl).toBeCloseTo(avg, 2);
    }
    const untouched = perf.rows.filter((r) => !(r.key in moved));
    expect(untouched.length).toBe(28);
    for (const r of untouched) {
      expect(row(withFailed, r.key)).toMatchObject({ days: r.days, accounts: r.accounts });
      expect(row(withFailed, r.key).totalPnl).toBeCloseTo(r.totalPnl, 2);
    }
    expect(withFailed.population.failedAccountDays).toBe(12);
    expect(sumOf(withFailed.rows, 'days')).toBe(323);
  });

  it('21. applies the seven-day window to every column, and the +$265 day is outside it', () => {
    const week = buildComboPerformance(clients, { ...legacy, window: { preset: 7 } });
    expect(week.window).toMatchObject({ from: '2026-07-24', to: '2026-07-30', anchor: '2026-07-30' });
    expect(row(week, 'URGO')).toMatchObject({ days: 45, firstDate: '2026-07-24', lastDate: '2026-07-30' });
    expect(row(week, 'URGO').avgPnl).toBeCloseTo(-41.49, 2);
    expect(week.rows.some((r) => r.key.includes('ARPD_PF'))).toBe(false);
  });
});

describe('the new rules', () => {
  const traded = buildComboPerformance(clients, { basis: 'traded', level: 'family', includeFailed: false, window: ALL });

  it('18. credits each family with the days it actually traded', () => {
    expect(row(traded, 'URGO').days).toBe(107);
    expect(row(traded, 'URGO').avgPnl).toBeCloseTo(-124.72, 2);
    expect(row(traded, 'B2X').days).toBe(57);
    expect(row(traded, 'B2X').avgPnl).toBeCloseTo(-176.49, 2);
    // OGX never had a row of its own under the old rule: it was the algo most
    // often switched off before the export.
    expect(row(traded, 'OGX')).not.toBeNull();
    expect(row(traded, 'OGX').days).toBe(26);
    expect(row(traded, 'OGX').avgPnl).toBeCloseTo(-84.74, 2);
    // The old table's only positive multi-day row turns negative once its
    // switched-off days count.
    expect(row(traded, 'ARPD + URGO').days).toBe(23);
    expect(row(traded, 'ARPD + URGO').avgPnl).toBeCloseTo(-90.62, 2);
  });

  it('19. leaves 292 days unattributable, carrying $8,514.70 of the losses', () => {
    expect(traded.population.unknownDays).toBe(292);
    expect(traded.population.unknownPnl).toBeCloseTo(-8514.7, 2);
    expect(traded.population.includedDays).toBe(573);
  });

  it('22. accounts for every one of the 865 funded account days', () => {
    expect(traded.population.fundedDays).toBe(865);
    expect(sumOf(traded.rows, 'totalPnl') + traded.population.unknownPnl).toBeCloseTo(-127292.95, 2);
    expect(traded.population.fundedPnl).toBeCloseTo(-127292.95, 2);
  });

  it('23. knows how many clients the loader hid', () => {
    expect(state.hiddenClientCount).toBe(40);
    expect(clients).toHaveLength(96);
    const perf = buildComboPerformance(clients, { hiddenClientCount: state.hiddenClientCount });
    expect(perf.population.hiddenClients).toBe(40);
  });

  it('24. never writes IFSP_PF as IFSP', () => {
    for (const basis of ['enabled', 'traded']) {
      const versioned = buildComboPerformance(clients, { basis, level: 'version', includeFailed: false, window: ALL });
      for (const r of versioned.rows) {
        // Every IFSP element carries a version token.
        for (const element of r.elements) {
          if (element.startsWith('IFSP')) expect(element).toMatch(/^IFSP(_PF)? \d+(\.\d+)+$/);
        }
        expect(r.key).not.toBe('IFSP');
      }
      const pf = row(versioned, 'IFSP_PF 1.1 + OGX_PF 2.4');
      expect(pf).not.toBeNull();
      if (basis === 'enabled') {
        expect(pf.days).toBe(12);
        expect(pf.totalPnl).toBeCloseTo(-596.5, 2);
      }
      // And under the family roll-up those days sit on IFSP_PF, not IFSP.
      const families = buildComboPerformance(clients, { basis, level: 'family', includeFailed: false, window: ALL });
      expect(row(families, 'IFSP + OGX_PF')).toBeNull();
      expect(row(families, 'IFSP_PF + OGX_PF')).not.toBeNull();
    }
  });

  it('25. starts the income projection from the book, not from +$800', () => {
    const perf = buildComboPerformance(clients, { basis: 'traded', includeFailed: false, window: ALL });
    expect(perf.population.avgPnlPerAccountDay).toBeCloseTo(-147.16, 2);
    expect(Math.round(perf.population.avgPnlPerAccountDay * 21)).toBe(-3090);
    expect(Math.round(-147.16 * 21)).toBe(-3090);
  });
});
