// What the mismatched-account finding reads on the real book.
//
// Gated: it reads public/local-snapshot.json, so vite.config.js drops it on
// every clone that does not hold the book and NOTHING HERE IS PINNED ON CI. The
// rules are in accountTypeAlgorithm.test.js, which is ungated.
//
// This file exists because the finding is the whole reason the "Bullet Bot"
// board was not simply deleted along with the other three. If these counts go to
// zero, the desk should be told the labelling was cleaned up, not left assuming
// the panel still has something to say.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAccountTypeMismatch } from './accountTypeAlgorithm';
import { buildCrmStateFromTables } from './supabaseStore';
import { SEGMENTS } from './operationsSegments';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);
const finding = buildAccountTypeMismatch(clients);

describe('accounts typed Evaluation - Bullet Bot that are not running Bullet Bot', () => {
  it('is 18 accounts across 12 clients, half of them running no Bullet Bot at all', () => {
    expect(finding.typedAccountsSeen).toBe(185);
    expect(finding.accounts).toBe(18);
    expect(finding.clients).toBe(12);
    expect(finding.swapped).toBe(9);
    expect(finding.alongside).toBe(9);
    // Carried as ageing evidence, never as the headline: 58 rows over 18
    // accounts is one problem re-imported on every close it survived.
    expect(finding.strategyRows).toBe(58);
  });

  it('names the eight algorithms found on them, by account', () => {
    expect(finding.families).toEqual([
      { name: 'IFSP', rows: 14, accounts: 7, clients: 4 },
      { name: 'OGX', rows: 16, accounts: 6, clients: 5 },
      { name: 'G4M', rows: 11, accounts: 4, clients: 4 },
      { name: 'URGO', rows: 6, accounts: 4, clients: 4 },
      { name: 'B2X', rows: 7, accounts: 2, clients: 2 },
      { name: 'DJDR', rows: 2, accounts: 2, clients: 1 },
      { name: 'ARPD', rows: 1, accounts: 1, clients: 1 },
      { name: 'SYFY', rows: 1, accounts: 1, clients: 1 },
    ]);
  });

  it('puts the longest-standing swap at the top of the list', () => {
    const worst = finding.rows[0];
    expect(worst.runsExpected).toBe(false);
    expect(worst.expectedRows).toBe(0);
    expect(worst.closes).toBe(8);
    expect(worst.others.map((family) => family.name)).toEqual(['IFSP']);
    expect(worst.segment).toBe(SEGMENTS.EVAL_BULLET);
    // Every account with no Bullet Bot row on it sorts above every account that
    // runs Bullet Bot alongside something else.
    const firstAlongside = finding.rows.findIndex((row) => row.runsExpected);
    expect(firstAlongside).toBe(finding.swapped);
  });

  it('reports the reverse — Bullet Bot on 42 accounts not typed for it', () => {
    expect(finding.elsewhere).toHaveLength(1);
    const away = finding.elsewhere[0];
    expect(away.family).toBe('Bullet Bot');
    expect(away.accounts).toBe(42);
    expect(away.rows).toEqual([
      { segment: SEGMENTS.UNCLASSIFIED, rows: 20, accounts: 18, clients: 4 },
      { segment: SEGMENTS.IGNORED, rows: 27, accounts: 17, clients: 9 },
      { segment: SEGMENTS.EVAL_STANDARD, rows: 10, accounts: 4, clients: 3 },
      { segment: SEGMENTS.FUNDED, rows: 6, accounts: 2, clients: 1 },
      { segment: SEGMENTS.ORPHAN, rows: 1, accounts: 1, clients: 1 },
    ]);
  });

  it('carries no money at all, on a book where these accounts moved plenty', () => {
    // The accounts in this finding are real closes with real movement on them.
    // None of it is here: the question is what the account is called, not what
    // the algorithm made.
    const flat = JSON.stringify(finding);
    expect(flat).not.toContain('grossRealizedPnl');
    expect(flat).not.toContain('measuredPnl');
    expect(flat).not.toContain('meanPerAccountDay');
  });
});
