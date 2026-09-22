// The same-day desk comparison, over the real book.
//
// Gated: it reads public/local-snapshot.json, so vite.config.js drops it on
// every clone that does not hold the export and NOTHING HERE IS PINNED ON CI.
// Every rule — the group floor, the consensus share, the per machine fields,
// missing against different, the numeric distance — lives in
// deskConfigOutliers.test.js, which is ungated. What is here is only what needs
// 58 closes and 416 accounts to be sayable at all.
//
// It exists because two design decisions in deskConfigOutliers.js are claims
// about this book and would be arbitrary without it:
//
//   ONE CONTRACT, THREE SPELLINGS. Grouping on the raw instrument string gives
//   56 groups on 2026-07-30 and splits URGO 4.5 on MNQ into 54 accounts and a
//   tail of small ones. Normalised it is 19 groups and URGO is 68 accounts in
//   one place. The tail is not a rounding error: an account in a group of one
//   can never be reported, so the fourteen that fell out were the fourteen most
//   likely to be the thing somebody was looking for.
//
//   A MAJORITY IS NOT A CONSENSUS. Bullet Bot 1.1 runs MyTradeDirection Long on
//   53 accounts and Short on 45 that day. Under "more accounts than every other
//   value put together" that made Long the desk and put 45 accounts on a review
//   list; the day went from 81 accounts to verify to 200.
//
// Every figure below was read off the snapshot by running this module over it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDeskConfigOutliers,
  deskDayImportIds,
  PER_MACHINE_FIELDS,
} from './deskConfigOutliers';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

/** The book's last close. Every figure in this file is that day. */
const DAY = '2026-07-30';
const result = buildDeskConfigOutliers(clients, { date: DAY });

const groupFor = (family, instrument) => result.groups
  .find((group) => group.family === family && group.instrument === instrument) || null;

describe('the desk on the book’s last close', () => {
  it('reads 58 closes into 19 groups, 15 of them large enough to compare', () => {
    expect(result.basis).toEqual({
      date: DAY,
      closes: 58,
      clients: 58,
      accounts: 416,
      rows: 417,
      readable: 417,
      unreadable: 0,
      unnamed: 0,
      groups: 19,
      compared: 15,
      tooSmall: 4,
      accountsCompared: 411,
      accountsDiffering: 81,
      // THE SAME DAY AS MACHINES RATHER THAN AS PAIRS, and the gap is why the
      // panel's headline had to change. 411 and 81 count an account once PER
      // GROUP; the desk that day is 252 accounts of which 63 run at least one
      // setting the rest of their group does not. Kai Moss's 1121557 alone is
      // in five groups, so a CAM working the list top to bottom meets one
      // machine five times, and a manager sizing the desk off the old sentence
      // read 411 for a desk of 252.
      accountsComparedDistinct: 252,
      accountsDifferingDistinct: 63,
    });
  });

  it('never prints more clients than accounts in a group', () => {
    // `clientIds` was added before the unnamed and unreadable guards, so a
    // client whose only row in a group carried no trading account counted as a
    // client of that group while its account counted as nothing. The closed
    // summary line prints both side by side, and on this book it produced
    // "9 accounts, 10 clients" on 2026-07-13 SYFY and "7 accounts, 10 clients"
    // on 2026-07-13 DJDR. Every account belongs to exactly one client, so more
    // clients than accounts is impossible on its face.
    for (const date of ['2026-07-13', '2026-07-22', '2026-07-23', DAY]) {
      const day = buildDeskConfigOutliers(clients, { date });
      for (const group of day.groups) {
        expect(group.clients).toBeLessThanOrEqual(group.accounts);
      }
    }
  });

  it('does not rank an account above another for a position size', () => {
    // Sizing follows account size and prop-firm plan, so the accounts listed
    // only for PosSize are the likeliest rows in the list to be right by
    // design. Six of the 81 pairs on this day differ on nothing else, and the
    // sort used to put them above accounts running a stop nobody else runs.
    const measured = result.groups.filter((group) => group.measured);
    const sizingOnly = measured
      .flatMap((group) => group.outliers)
      .filter((outlier) => outlier.configurationDifferences === 0);
    expect(sizingOnly.length).toBe(6);
    for (const outlier of sizingOnly) expect(outlier.sizingDifferences).toBeGreaterThan(0);
    // Every group lists its configuration findings before its sizing-only ones.
    for (const group of measured) {
      const counts = group.outliers.map((outlier) => outlier.configurationDifferences);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    }
  });

  it('fetches 58 closes for the day and not one more', () => {
    // configPanelImportIds asks for each client's latest close AT OR BEFORE the
    // date, which on this book is 96 closes spread over three weeks. This panel
    // wants the day.
    expect(deskDayImportIds(clients, DAY)).toHaveLength(58);
  });

  it('names the four groups it cannot measure rather than dropping them', () => {
    const small = result.groups.filter((group) => !group.measured);
    expect(small.map((group) => `${group.family} ${group.version} ${group.instrument}`)).toEqual([
      'SYFY_PF 1.4 MES 2026-09',
      'Bullet Bot 1.1 MNQ 2026-09',
      'FSA 2.2 MNQ 2026-09',
      'MST 3.3 YM 2026-09',
    ]);
    expect(small.every((group) => group.reason === 'too-few-accounts')).toBe(true);
    expect(small.every((group) => group.outliers.length === 0)).toBe(true);
  });

  it('never reports a per machine field anywhere on the day', () => {
    const reported = new Set();
    for (const group of result.groups) {
      for (const outlier of group.outliers) {
        for (const difference of outlier.differences) reported.add(difference.name);
      }
      for (const entry of group.consensus) reported.add(entry.name);
      for (const field of group.splitFields) reported.add(field.name);
    }

    for (const name of PER_MACHINE_FIELDS) expect(reported.has(name)).toBe(false);
    // LicenseKey is on all 3,707 readable rows of this book and reaches no
    // screen: parseLiveParameters drops it before the comparison sees it.
    expect(reported.has('LicenseKey')).toBe(false);
  });
});

describe('one contract, however the grid spelled it', () => {
  const urgo = groupFor('URGO', 'MNQ 2026-09');

  it('holds all 68 URGO 4.5 accounts, not the 54 on the commonest spelling', () => {
    const raw = new Set();
    for (const client of clients) {
      for (const daily of client.dailyImports || []) {
        if (String(daily.date).slice(0, 10) !== DAY) continue;
        for (const strategy of daily.strategies || []) {
          if (strategy.strategyFamily !== 'URGO' || strategy.strategyVersion !== '4.5') continue;
          if (strategy.instrument !== 'MNQ SEP26' || strategy.dataSeries !== '15 Minute') continue;
          raw.add(strategy.accountName);
        }
      }
    }

    expect(raw.size).toBe(54);
    expect(urgo.accounts).toBe(68);
    expect(urgo.clients).toBe(44);
    expect(urgo.spellings).toEqual(['MNQ 09-26', 'MNQ SEP26', 'MNQU6']);
  });

  it('would be 56 groups on the raw strings and is 19', () => {
    const raw = new Set();
    for (const client of clients) {
      for (const daily of client.dailyImports || []) {
        if (String(daily.date).slice(0, 10) !== DAY) continue;
        for (const strategy of daily.strategies || []) {
          raw.add([
            strategy.strategyFamily || strategy.strategyName,
            strategy.strategyVersion,
            strategy.instrument,
            strategy.dataSeries,
          ].join('|'));
        }
      }
    }

    expect(raw.size).toBe(56);
    expect(result.groups).toHaveLength(19);
  });

  it('keeps the August gas contract apart and says the desk has rolled', () => {
    // Six accounts on NG AUG26 while 47 run NG SEP26. This is the "somebody is
    // out of date" the panel exists for, and it is invisible from inside either
    // group.
    const august = groupFor('IFSP', 'NG 2026-08');
    expect(august.accounts).toBe(6);
    expect(august.clients).toBe(4);
    expect(august.contractPeers).toEqual([
      { contract: '2026-09', instrument: 'NG 2026-09', accounts: 47 },
    ]);
    expect(groupFor('IFSP', 'NG 2026-09').accounts).toBe(47);
  });
});

describe('what the day actually says', () => {
  it('ranks the groups by how many accounts each holds', () => {
    expect(result.groups.slice(0, 8).map((group) => [
      `${group.family} ${group.version} ${group.instrument}`,
      group.accounts,
      group.clients,
      group.outliers.length,
    ])).toEqual([
      ['Bullet Bot 1.1 NQ 2026-09', 98, 34, 19],
      ['URGO 4.5 MNQ 2026-09', 68, 44, 16],
      ['IFSP 1.1 NG 2026-09', 47, 29, 10],
      ['RBO 1.8 M2K 2026-09', 41, 33, 3],
      ['G4M 3.4 MES 2026-09', 33, 26, 2],
      ['OGX 2.4 MNQ 2026-09', 32, 21, 3],
      ['B2X 2.5 M2K 2026-09', 29, 19, 8],
      ['ARPD 1.1 MGC 2026-12', 20, 15, 1],
    ]);
  });

  it('says the desk is divided on Bullet Bot’s direction instead of listing 45 accounts', () => {
    const bullet = groupFor('Bullet Bot', 'NQ 2026-09');
    const split = bullet.splitFields.find((field) => field.name === 'MyTradeDirection');

    expect(split.readings).toEqual([
      { value: 'Long', accounts: 53, share: 54 },
      { value: 'Short', accounts: 45, share: 46 },
    ]);
    expect(bullet.outliers.every(
      (outlier) => outlier.differences.every((difference) => difference.name !== 'MyTradeDirection'),
    )).toBe(true);
  });

  it('finds the one URGO account running a stop nobody else runs', () => {
    const urgo = groupFor('URGO', 'MNQ 2026-09');
    const outlier = urgo.outliers.find((entry) => entry.accountName === 'EAFHAFDB672974196481');
    const stop = outlier.differences.find((difference) => difference.name === 'StopLossTicks');

    expect(outlier.clientName).toBe('Wren Larch');
    expect(stop).toMatchObject({
      state: 'different',
      value: '315',
      consensus: '300',
      consensusAccounts: 67,
      population: 68,
      numeric: true,
      distance: 15,
    });
    expect(stop.distancePct).toBeCloseTo(5, 5);
  });

  it('scales a target that is an order of magnitude out', () => {
    // Four accounts run the 30/60/90 targets against the desk's 400/450/500.
    // The distance is what says those are not a tweak.
    const urgo = groupFor('URGO', 'MNQ 2026-09');
    const outlier = urgo.outliers.find((entry) => entry.accountName === '8290722');
    const target = outlier.differences.find((difference) => difference.name === 'ProfitTargetTicks1');

    expect(outlier.clientName).toBe('Finley Dune');
    expect(target.value).toBe('30');
    expect(target.consensus).toBe('400');
    expect(target.distance).toBe(-370);
    expect(target.distancePct).toBeCloseTo(-92.5, 5);
  });

  it('calls a second session a second session, not eleven mistakes', () => {
    // RBO closes at 16:50 on 32 of 41 accounts and at 16:30 on 8. Nobody is
    // listed for the eight.
    const rbo = groupFor('RBO', 'M2K 2026-09');
    const entry = rbo.consensus.find((field) => field.name === 'CloseAllOpenTradeTime');

    expect(entry.value).toBe('2020-01-01T16:50:00');
    expect(entry.accounts).toBe(32);
    expect(entry.alsoInUse).toEqual([
      { value: '2020-01-01T16:30:00', accounts: 8, share: 20 },
    ]);

    // Not silence on the field. The one account closing at 15:45 is still
    // reported; it is the eight on a session the desk runs that are not.
    const listed = rbo.outliers.flatMap((outlier) => outlier.differences)
      .filter((difference) => difference.name === 'CloseAllOpenTradeTime');
    expect(listed.map((difference) => difference.value)).toEqual(['2020-01-01T15:45:00']);
  });

  it('reports a build that carries a whole block the desk has not, as extra', () => {
    // One of the six August gas accounts carries the seven day-of-week filters
    // and the other five carry none. "Not in this build" on both sides, never
    // "(blank) against true".
    const august = groupFor('IFSP', 'NG 2026-08');
    const outlier = august.outliers.find((entry) => entry.accountName === 'DBF88272130879087');
    const filters = outlier.differences.filter((difference) => /Filter$/.test(difference.name));

    expect(filters).toHaveLength(7);
    expect(filters.every((difference) => difference.state === 'extra')).toBe(true);
    expect(filters.every((difference) => difference.consensus === null)).toBe(true);
    expect(filters.every((difference) => difference.distance === null)).toBe(true);
  });

  it('reports a build that is missing a block the desk carries, as missing', () => {
    const missing = [];
    for (const group of result.groups) {
      for (const outlier of group.outliers) {
        for (const difference of outlier.differences) {
          if (difference.state === 'missing') missing.push([group.family, difference.name]);
        }
      }
    }

    // Five on the day, all on ONE account: an IFSP_PF row whose build carries
    // no daily-entry or re-entry fields at all, and carries three Martingale
    // ones the rest of its group has not. Both halves of that are reported, and
    // neither is worded as a value that differs.
    expect(missing).toEqual([
      ['IFSP_PF', 'EdgeLeverage'],
      ['IFSP_PF', 'LimitDailyEntries'],
      ['IFSP_PF', 'MaxDailyEntries'],
      ['IFSP_PF', 'ReEntryIsOn'],
      ['IFSP_PF', 'ReEntryWaitBars'],
    ]);

    const outlier = groupFor('IFSP_PF', 'NG 2026-09').outliers
      .find((entry) => entry.accountName === 'ECCACHDEDE979218739');
    expect(outlier.differences.filter((difference) => difference.state === 'extra')
      .map((difference) => difference.name))
      .toEqual(['Martingale', 'MartingaleMultiplier', 'MaxMartingales']);
  });

  it('does not call a setting an identifier in a group of three', () => {
    // OGX_PF 2.4 has three accounts and three different stops. The derived per
    // machine rule fired here before it had a floor, which labelled
    // StopLossTicks and StartTrailAfterTicks as machine fields on a cohort that
    // simply does not agree yet.
    const ogx = groupFor('OGX_PF', 'MNQ 2026-09');
    expect(ogx.accounts).toBe(3);
    expect(ogx.fields.ignored).toEqual([{ name: 'Backtest', reason: 'per-machine' }]);
    expect(ogx.splitFields.map((field) => field.name))
      .toEqual(['StartTrailAfterTicks', 'StopLossTicks']);
  });
});

describe('every day of the book, not only the one this file quotes', () => {
  const days = ['2026-07-13', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-28', DAY];


  it('never reports an account in a group that cannot have a consensus', () => {
    for (const day of days) {
      const answer = buildDeskConfigOutliers(clients, { date: day });
      for (const group of answer.groups) {
        if (group.measured) continue;
        expect(group.outliers).toEqual([]);
        expect(group.consensus).toEqual([]);
      }
    }
  });

  it('keeps the review list short enough to read', () => {
    // 68 to 88 accounts a day out of 389 to 508, across 13 to 15 groups. The
    // plain-majority rule this replaced produced 200 on the last close alone,
    // 45 of them for one field nobody had decided.
    const measured = days.map((day) => {
      const answer = buildDeskConfigOutliers(clients, { date: day });
      return [day, answer.basis.accountsCompared, answer.basis.accountsDiffering];
    });

    expect(measured).toEqual([
      ['2026-07-13', 508, 88],
      ['2026-07-22', 389, 78],
      ['2026-07-23', 417, 68],
      ['2026-07-24', 394, 71],
      ['2026-07-27', 419, 72],
      ['2026-07-28', 430, 81],
      [DAY, 411, 81],
    ]);
  });
});
