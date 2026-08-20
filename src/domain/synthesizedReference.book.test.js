// The book-backed half of synthesizedReference's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so
// vite.config.js drops it on every clone that does not hold the export. A test
// that only runs here is not a test CI can hold anyone to, and the synthetic
// half of this suite was being dropped alongside it for no reason at all. The
// rules live in synthesizedReference.test.js, which runs everywhere; the NUMBERS
// live here, where the book is.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFERENCE, buildSynthesizedReference } from './synthesizedReference';
import { buildCrmStateFromTables } from './supabaseStore';

/* ── The real book ────────────────────────────────────────────────────────── */

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

describe('the real book', () => {
  const result = buildSynthesizedReference(clients);

  it('has exactly one cohort the library cannot speak to', () => {
    // G4M: 47 of the 619 latest strategy rows, no folder in the library. The
    // other 17 book families all resolve, and the four catalogued families with
    // no rows (DJDR_PF, PLPI, PLPI_PF, TendoCentinel) are the gap the other way.
    expect(result.cohorts.map((cohort) => `${cohort.family}|${cohort.instrument}`))
      .toEqual(['G4M|MES']);
    expect(result.totals).toMatchObject({
      cohorts: 1, withReference: 1, withoutReference: 0, rows: 47, accounts: 46,
    });
  });

  it('merges the three contract strings G4M runs into one root', () => {
    // MES SEP26 (43), MES 09-26 (3) and MESU6 (1) are one contract. Grouped on
    // the raw string they are three cohorts, two of them below every floor.
    const [cohort] = result.cohorts;
    expect(cohort.rows).toBe(47);
    expect(cohort.accounts).toBe(46);
    expect(cohort.unnamedRows).toBe(1);
    expect(cohort.clients).toBe(36);
  });

  it('finds a majority, and says how much of one', () => {
    const [cohort] = result.cohorts;
    expect(cohort.status).toBe(REFERENCE.OBSERVED);
    expect(cohort.distinctConfigurations).toBe(3);
    expect(cohort.configurationRows).toEqual([35, 11, 1]);
    expect(cohort.reference.share).toBe(74);
    // 27 comparable settings: the export's 31 names less LicenseKey and the
    // three PosSize fields.
    expect(cohort.reference.fieldCount).toBe(27);
    expect(cohort.reference.unanimousFields).toHaveLength(25);
  });

  it('is unanimous on the four settings that identify a version', () => {
    const [cohort] = result.cohorts;
    expect(cohort.reference.identity.unanimous).toBe(true);
    expect(cohort.reference.identity.values).toEqual({
      ProfitTargetTicks1: '80',
      ProfitTargetTicks2: '120',
      ProfitTargetTicks3: '160',
      StopLossTicks: '80',
    });
  });

  it('yields one account to verify and one second configuration, not twelve findings', () => {
    const [cohort] = result.cohorts;

    expect(cohort.outliers).toHaveLength(1);
    expect(cohort.outliers[0].rows).toBe(1);
    expect(cohort.outliers[0].changes)
      .toEqual([{ name: 'EdgeLeverage', from: 'false', to: 'true' }]);
    expect(cohort.outliers[0].accounts[0].accountName).toBe('7128848');

    expect(cohort.variants).toHaveLength(1);
    expect(cohort.variants[0].rows).toBe(11);
    expect(cohort.variants[0].share).toBe(23);
    expect(cohort.variants[0].changes).toEqual([{
      name: 'CloseAllOpenTradeTime',
      from: '2020-01-01T16:45:00',
      to: '2020-01-01T16:30:00',
    }]);
  });

  it('checks the reference against the whole history it has', () => {
    const [cohort] = result.cohorts;
    // 254 G4M rows over every import, 193 of them on today's reference. Stable —
    // which is not the same as correct, and nothing here claims it is.
    expect(cohort.history).toEqual({
      rows: 254,
      distinctConfigurations: 3,
      referenceRows: 193,
      referenceShare: 76,
      referenceIsAllTimeMajority: true,
    });
  });
});
