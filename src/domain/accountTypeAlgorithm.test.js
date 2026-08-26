// Accounts whose type names an algorithm they are not running — the rules, on
// fixtures.
//
// UNGATED ON PURPOSE. This file reads no snapshot, so it runs on CI and on every
// clone. The counts against the real book are in accountTypeAlgorithm.book.test.js,
// which IS gated and pins nothing anywhere but this machine.
//
// The three things this finding can get wrong in a way nobody would catch:
//
//   1. Becoming a performance segment again. A P&L or a mean on any of these
//      rows turns a labelling question back into the account-type verdict the
//      whole rework removed.
//   2. Leading with a strategy-row count. A still-true condition is re-imported
//      every close, so rows measure how long it has been true, not how much work
//      there is — the same inflation that made the flag counter read 1,952 for
//      253 real problems.
//   3. Flagging an account that runs the algorithm it is named for, or missing
//      one that runs nothing else.

import { describe, expect, it } from 'vitest';
import {
  ALGORITHM_NAMED_TYPES,
  PROGRAMME_STANDINGS,
  accountTypeMismatchRefusals,
  buildAccountTypeMismatch,
  buildProgrammeAccountStanding,
  programmeStandingRefusals,
} from './accountTypeAlgorithm';
import { SEGMENTS } from './operationsSegments';

function makeClient({
  id = 'c1',
  name = 'Pedro',
  accountType = 'Evaluation - Bullet Bot',
  accounts = ['A1'],
  days = [],
} = {}) {
  const accountRegistry = {};
  for (const accountName of accounts) {
    accountRegistry[accountName] = { accountName, accountType, status: 'Active' };
  }
  return {
    id,
    name,
    accountRegistry,
    dailyImports: days.map(({ date, rows }) => ({
      id: `${id}-${date}`,
      date,
      accounts: {},
      flags: [],
      snapshots: rows.map(({ account = accounts[0], strategies = [] }) => ({
        accountName: account,
        grossRealizedPnl: -500,
        accountBalance: 50000,
        strategies,
      })),
    })),
  };
}

const on = (family, { enabled = true } = {}) => ({ strategyFamily: family, enabled, realized: -100 });

describe('which account types name an algorithm', () => {
  it('is a table, not a hard-coded string, and holds the one collision this book has', () => {
    expect(ALGORITHM_NAMED_TYPES).toEqual([
      { segment: SEGMENTS.EVAL_BULLET, family: 'Bullet Bot' },
    ]);
  });
});

describe('the finding', () => {
  it('names an account typed for one algorithm and running another', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('OGX')] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(1);
    expect(finding.clients).toBe(1);
    expect(finding.rows[0].accountName).toBe('B1');
    expect(finding.rows[0].expected).toBe('Bullet Bot');
    expect(finding.rows[0].others).toEqual([
      { name: 'OGX', rows: 1, enabledRows: 1, closes: 1 },
    ]);
  });

  it('leaves an account running the algorithm it is named for alone', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('Bullet Bot')] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(0);
    expect(finding.rows).toEqual([]);
    // The denominator is still reported, so "0 accounts" is not read as "no
    // bullet-bot accounts exist".
    expect(finding.typedAccountsSeen).toBe(1);
  });

  it('says nothing about an account whose type names no algorithm', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        accountType: 'Funded',
        accounts: ['F1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'F1', strategies: [on('OGX')] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(0);
    expect(finding.typedAccountsSeen).toBe(0);
  });

  it('separates a swap from a stack, because they read differently', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        id: 'swap',
        accounts: ['S1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'S1', strategies: [on('IFSP')] }] }],
      }),
      makeClient({
        id: 'stack',
        name: 'Stack',
        accounts: ['T1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'T1', strategies: [on('Bullet Bot'), on('IFSP')] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(2);
    expect(finding.swapped).toBe(1);
    expect(finding.alongside).toBe(1);
    // The account with no row of its own algorithm sorts first: it is the one
    // that looks like a swap nobody recorded.
    expect(finding.rows[0].accountName).toBe('S1');
    expect(finding.rows[0].runsExpected).toBe(false);
    expect(finding.rows[1].runsExpected).toBe(true);
    expect(finding.rows[1].expectedRows).toBe(1);
  });

  it('counts a disabled row, and says it was disabled', () => {
    // A disabled row is still a row on the account, and the label is still
    // wrong. Dropping it would hide an account whose algorithm was swapped and
    // then turned off.
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('OGX', { enabled: false })] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(1);
    expect(finding.rows[0].others[0].enabledRows).toBe(0);
    expect(finding.rows[0].others[0].rows).toBe(1);
  });

  it('is one row per account however many closes carry it', () => {
    // The unit that can be acted on. Counting strategy rows counts one problem
    // once per day it survived, which is the inflation that made the flag
    // counter unusable.
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: Array.from({ length: 6 }, (_, d) => ({
          date: `2026-07-1${d}`,
          rows: [{ account: 'B1', strategies: [on('OGX')] }],
        })),
      }),
    ]);
    expect(finding.accounts).toBe(1);
    expect(finding.rows).toHaveLength(1);
    expect(finding.rows[0].closes).toBe(6);
    expect(finding.rows[0].firstDate).toBe('2026-07-10');
    expect(finding.rows[0].lastDate).toBe('2026-07-15');
    // The rows are carried as ageing evidence, never as the headline.
    expect(finding.strategyRows).toBe(6);
  });

  it('carries no money on any row, at any level', () => {
    // The defect this whole rework removed, reappearing one panel down. The
    // account made -$500 on each of these closes and none of it belongs here.
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('OGX')] }] }],
      }),
    ]);
    expect(JSON.stringify(finding)).not.toContain('-500');
    for (const row of finding.rows) {
      expect(row.totalPnl).toBeUndefined();
      expect(row.measuredPnl).toBeUndefined();
      expect(row.meanPerAccountDay).toBeUndefined();
    }
    expect(finding.totalPnl).toBeUndefined();
    expect(finding.notASegment).toMatch(/labelling question, not a performance one/);
  });

  it('groups the offending algorithms by account, not by row', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        id: 'a',
        accounts: ['A1'],
        days: Array.from({ length: 4 }, (_, d) => ({
          date: `2026-07-1${d}`,
          rows: [{ account: 'A1', strategies: [on('OGX')] }],
        })),
      }),
      makeClient({
        id: 'b',
        name: 'B',
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('OGX'), on('IFSP')] }] }],
      }),
    ]);
    expect(finding.families).toEqual([
      { name: 'OGX', rows: 5, accounts: 2, clients: 2 },
      { name: 'IFSP', rows: 1, accounts: 1, clients: 1 },
    ]);
  });

  it('reports the same question from the other side', () => {
    // An account typed Standard running Bullet Bot is the same defect seen the
    // other way round, and a manager cannot tell "mislabelled" from "swapped"
    // with only one half of it.
    const finding = buildAccountTypeMismatch([
      makeClient({
        accountType: 'Evaluation - Standard',
        accounts: ['E1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'E1', strategies: [on('Bullet Bot')] }] }],
      }),
    ]);
    expect(finding.accounts).toBe(0);
    expect(finding.elsewhere).toEqual([
      {
        family: 'Bullet Bot',
        accounts: 1,
        rows: [{ segment: SEGMENTS.EVAL_STANDARD, rows: 1, accounts: 1, clients: 1 }],
      },
    ]);
  });

  it('runs to a pinned close and does not read what came after it', () => {
    const client = makeClient({
      accounts: ['B1'],
      days: [
        { date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('Bullet Bot')] }] },
        { date: '2026-07-20', rows: [{ account: 'B1', strategies: [on('OGX')] }] },
      ],
    });
    expect(buildAccountTypeMismatch([client], { asOfDate: '2026-07-10' }).accounts).toBe(0);
    expect(buildAccountTypeMismatch([client], { asOfDate: '2026-07-20' }).accounts).toBe(1);
  });

  it('survives an empty book without inventing a finding', () => {
    const finding = buildAccountTypeMismatch([]);
    expect(finding.accounts).toBe(0);
    expect(finding.rows).toEqual([]);
    expect(finding.elsewhere).toEqual([]);
    expect(finding.typedAccountsSeen).toBe(0);
  });
});

describe('what the finding will not say', () => {
  it('refuses a verdict and never uses the word wrong', () => {
    const finding = buildAccountTypeMismatch([
      makeClient({
        accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', strategies: [on('OGX')] }] }],
      }),
    ]);
    const refusals = accountTypeMismatchRefusals(finding);
    expect(refusals.map((row) => row.figure)).toEqual([
      'What these accounts made, by account type',
      'A verdict on which accounts are wrong',
      'A count of strategy rows as the headline',
    ]);
    expect(refusals.every((row) => row.value === null && row.reason.length > 40)).toBe(true);
    // The ask is a question, in the same register as the configuration review.
    expect(finding.ask).toMatch(/Different is not wrong/);
    expect(finding.ask).toMatch(/confirm/);
  });
});

/**
 * The second finding: the programme against the rule it runs under.
 *
 * The CAM stated the rule — the only accounts that run Bullet Bot are evaluation
 * accounts — so a LIVE account of another type running it is an exception and
 * there should be none. The thing this can get wrong is the shape of the count:
 * a retired account and an untyped account are not exceptions, and adding them
 * in makes the work look several times larger than it is.
 */
describe('the programme against the rule it runs under', () => {
  const runs = (accountType, id) => makeClient({
    id,
    name: id,
    accountType,
    accounts: [`${id}-1`],
    days: [{ date: '2026-07-10', rows: [{ strategies: [on('Bullet Bot')] }] }],
  });

  const book = () => [
    runs('Evaluation - Bullet Bot', 'ok'),
    runs('Funded', 'funded'),
    runs('Evaluation - Standard', 'std'),
    runs('Inactive / Ignore', 'retired'),
    runs('Unassigned', 'untyped'),
  ];

  it('counts only the live accounts of another type as exceptions', () => {
    const [finding] = buildProgrammeAccountStanding(book());
    expect(finding.family).toBe('Bullet Bot');
    expect(finding.accounts).toBe(5);
    expect(finding.anomalyAccounts).toBe(2);
    expect(finding.anomalyClients).toBe(2);
    expect(finding.anomalies.map((row) => row.segment).sort()).toEqual([
      SEGMENTS.EVAL_STANDARD, SEGMENTS.FUNDED,
    ]);
    expect(finding.expectedAccounts).toBe(1);
  });

  it('holds the retired and the untyped accounts apart from the exceptions', () => {
    const [finding] = buildProgrammeAccountStanding(book());
    const standing = Object.fromEntries(
      finding.byStanding.map((row) => [row.standing, row.accounts]),
    );
    expect(standing[PROGRAMME_STANDINGS.ANOMALY]).toBe(2);
    expect(standing[PROGRAMME_STANDINGS.RETIRED]).toBe(1);
    expect(standing[PROGRAMME_STANDINGS.UNCLASSIFIED]).toBe(1);
    expect(standing[PROGRAMME_STANDINGS.EXPECTED]).toBe(1);
    // Every group carries the reason it is not an exception, on the object
    // rather than in the markup.
    for (const row of finding.byStanding) expect(row.note).toBeTruthy();
  });

  it('treats an account type this build has never seen as an exception, not as expected', () => {
    const [finding] = buildProgrammeAccountStanding([runs('Some Future Type', 'new')]);
    expect(finding.anomalyAccounts).toBe(1);
    expect(finding.anomalies[0].segment).toBe('Some Future Type');
  });

  it('says so plainly when the rule holds, rather than going quiet', () => {
    const [finding] = buildProgrammeAccountStanding([runs('Evaluation - Bullet Bot', 'ok')]);
    expect(finding.anomalyAccounts).toBe(0);
    expect(finding.byStanding.map((row) => row.standing)).toEqual([PROGRAMME_STANDINGS.EXPECTED]);
    expect(finding.rule).toMatch(/there should be none/);
  });

  it('returns nothing at all for a book the programme never ran on', () => {
    expect(buildProgrammeAccountStanding([
      makeClient({
        id: 'x',
        accountType: 'Funded',
        days: [{ date: '2026-07-10', rows: [{ strategies: [on('OGX')] }] }],
      }),
    ])).toEqual([]);
  });

  it('carries no money, on accounts that moved -$500 a close', () => {
    const flat = JSON.stringify(buildProgrammeAccountStanding(book()));
    expect(flat).not.toContain('500');
    expect(flat).not.toContain('grossRealizedPnl');
    expect(flat).not.toContain('meanPerAccountDay');
  });

  it('leads with the account and keeps the row count as ageing evidence', () => {
    const [finding] = buildProgrammeAccountStanding([
      makeClient({
        id: 'f',
        accountType: 'Funded',
        accounts: ['F1'],
        days: [
          { date: '2026-07-10', rows: [{ strategies: [on('Bullet Bot')] }] },
          { date: '2026-07-11', rows: [{ strategies: [on('Bullet Bot')] }] },
          { date: '2026-07-12', rows: [{ strategies: [on('Bullet Bot')] }] },
        ],
      }),
    ]);
    expect(finding.anomalyAccounts).toBe(1);
    expect(finding.anomalyRows).toBe(3);
    expect(finding.anomalies[0].closes).toBe(3);
    expect(finding.anomalies[0].firstDate).toBe('2026-07-10');
    expect(finding.anomalies[0].lastDate).toBe('2026-07-12');
  });

  it('counts one account once, however many closes carried the programme', () => {
    // The unit is the account. A still-true condition is re-imported on every
    // close, and a finding whose headline counted rows would grow every day
    // nobody acted on it — the inflation camFlagQueue.js exists to undo.
    const [finding] = buildProgrammeAccountStanding([
      makeClient({
        id: 'one',
        accountType: 'Funded',
        accounts: ['M1'],
        days: [
          { date: '2026-07-10', rows: [{ strategies: [on('Bullet Bot')] }] },
          { date: '2026-07-11', rows: [{ strategies: [on('Bullet Bot')] }] },
        ],
      }),
    ]);
    expect(finding.accounts).toBe(1);
    expect(finding.anomalyAccounts).toBe(1);
    expect(finding.anomalies[0].rows).toBe(2);
  });

  it('refuses to add the retired and untyped accounts into one headline', () => {
    const refusals = programmeStandingRefusals(buildProgrammeAccountStanding(book()));
    const lump = refusals.find((row) => row.figure.startsWith('One number for'));
    expect(lump.reason).toMatch(/5 accounts have run a programme on this book and 2 of them are/);
    expect(lump.reason).toMatch(/a retired account is a record of what it used to run/);
    expect(refusals.some((row) => /performance/i.test(row.reason))).toBe(true);
  });
});
