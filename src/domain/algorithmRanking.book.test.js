// The book-backed half of the algorithm ranking's suite.
//
// It reads public/local-snapshot.json, so vite.config.js drops it on every clone
// that does not hold the book and NOTHING HERE IS PINNED ON CI. The rules — the
// evidence gate, the configuration identity, the money-per-business rule, the
// refusals and the wall-clock defects — live in algorithmRanking.test.js, which
// is ungated. What is here is only what needs 96 clients and 14 closes to be
// sayable at all.
//
// It exists because the whole rework rests on one claim about this book: that
// OGX's +$23.52 on cash and -$54.12 on ordinary prop were one algorithm seen
// twice, not two behaviours — same version 2.4, same 1/1/0 sizing, same MNQ,
// closes that overlap almost completely — and that what actually differs inside
// OGX is its CONFIGURATION. If that stops being true, this file should be the
// thing that says so.
//
// Every figure below was read off the snapshot by running these modules over it,
// not by trusting them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAlgorithmDetail, buildStrategyRanking } from './algorithmRanking';
import { buildCrmStateFromTables } from './supabaseStore';
import { BUSINESS_KEYS, SEGMENTS } from './operationsSegments';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

const configFor = (detail, label) =>
  detail.configurations.find((config) => config.label === label) || null;
const businessFor = (result, key) => result.businesses.find((row) => row.key === key) || null;

describe('the ranking over the whole book', () => {
  const result = buildStrategyRanking(clients);

  it('anchors to the book’s last close and not to the wall clock', () => {
    expect(result.basis.anchor).toBe('2026-07-30');
    expect(result.basis.firstClose).toBe('2026-07-13');
    expect(result.basis.lastClose).toBe('2026-07-30');
    expect(result.basis.closeCount).toBe(13);
    expect(result.basis.closesToAnchor).toBe(14);
  });

  it('gives fourteen algorithms one rank each, eight of them earned', () => {
    // The build this replaced published 25 rows across four boards for the same
    // fifteen algorithms, because an algorithm held a row on every board its
    // accounts happened to fall on. Fourteen here rather than fifteen: the
    // fifteenth is the Bullet Bot PROGRAMME, which is off the ranked population
    // and on its own row below the table.
    expect(result.ranking.rows).toHaveLength(14);
    expect(result.ranking.rankedCount).toBe(8);
    expect(result.ranking.unrankedCount).toBe(6);
    expect(result.ranking.rows.slice(0, 8).map((row) => row.name)).toEqual([
      'ARPD', 'OGX', 'URGO', 'B2X', 'IFSP', 'G4M', 'RBO', 'SYFY',
    ]);
    // Every ranked row loses money per account-day. The board that sorted by
    // total P&L printed this book upside down.
    expect(result.ranking.rows.slice(0, 8).every((row) => row.meanPerAccountDay < 0)).toBe(true);
    expect(result.ranking.rows.some((row) => row.name === 'Bullet Bot')).toBe(false);
  });

  it('keeps the programme off the ranking and on its own row, with its counts', () => {
    // It was #7 at -$93.68 per account-day against OGX at -$11.98, and read as
    // the seventh-best algorithm on the desk. It is not an algorithm on that
    // list at all: it is alone on 337 of its 337 account-days, so that figure
    // is a whole account's day, while OGX's is a share of one.
    expect(result.ranking.programmeCount).toBe(1);
    const bullet = result.ranking.programmes[0];
    expect(bullet.name).toBe('Bullet Bot');
    expect(bullet.accountDays).toBe(337);
    expect(bullet.accounts).toBe(115);
    expect(bullet.clients).toBe(34);
    expect(bullet.soloAccountDays).toBe(337);
    expect(bullet.soloShare).toBe(100);
    // It trades NQ where OGX trades MNQ, which is one more reason the two were
    // never one measurement.
    expect(bullet.instruments[0].name).toBe('NQ SEP26');
    // And 12 of its 337 account-days are on accounts NOT typed for it.
    const away = bullet.deployment.filter((entry) => entry.segment !== SEGMENTS.EVAL_BULLET);
    expect(away.reduce((n, entry) => n + entry.accountDays, 0)).toBe(12);
    expect(bullet.offTypeAccountDays).toBe(12);
    expect(bullet.answeredBy).toBe('Bullet Bot across the desk');
  });

  it('publishes no rank and no per-account-day figure for the programme', () => {
    // -$93.68 is real and it is not on this object. The only place it appears
    // on the whole screen is inside the sentence that refuses to rank it, where
    // it cannot be sorted against anything.
    const bullet = result.ranking.programmes[0];
    const flat = JSON.stringify({ ...bullet, rankRefusal: '' });
    expect(flat).not.toContain('93.68');
    expect(flat).not.toContain('meanPerAccountDay');
    expect(bullet.rank).toBeUndefined();
    expect(bullet.ranked).toBeUndefined();
    expect(bullet.winRate).toBeUndefined();
  });

  it('names the ordinary algorithm a solo-versus-stacked threshold would strand', () => {
    // The boundary is the programme, not the ratio, and this is why. G4M runs
    // alone on 40% of its account-days and is an ordinary algorithm having
    // ordinary days; every line drawn between it and Bullet Bot's 100% is a
    // number nobody could defend.
    expect(result.ranking.thresholdRefusal).toMatch(/G4M, alone on 40% of its account-days/);
    const g4m = result.ranking.rows.find((row) => row.name === 'G4M');
    expect(g4m.rank).toBe(6);
    expect(g4m.soloShare).toBe(40);
    expect(g4m.soloAccountDays).toBe(44);
    expect(g4m.stackedAccountDays).toBe(66);
  });

  it('states the desk’s money per business, and none of it on a row', () => {
    // The money is per business and none of it is added: -$922.50 is a cash
    // dollar added to a prop dollar and is on no object here. But the split
    // itself is the desk's, not an algorithm's. OGX's row carried
    // [-$458.50 on 1, -$1,569.50 on 29, +$1,105.50 on 47] until it was pointed
    // out that -1569.5/29 = -$54.12 and 1105.5/47 = +$23.52 — the exact pair of
    // per-account-type figures this whole rework exists to have removed.
    const ogx = result.ranking.rows.find((row) => row.name === 'OGX');
    expect(ogx.exposure).toBeUndefined();
    expect(ogx.totalPnl).toBeUndefined();
    const rows = JSON.stringify(result.ranking.rows);
    for (const gone of ['-922.5', '-1569.5', '1105.5', '-458.5', '-54.12', '23.52']) {
      expect(rows).not.toContain(gone);
    }
    // And the desk still states each business's own money, over every algorithm.
    expect(businessFor(result, BUSINESS_KEYS.CASH).coverage.attributedPnl).toBe(-23113);
    expect(businessFor(result, BUSINESS_KEYS.PROP_OTHER).coverage.attributedPnl).toBe(-39123.25);
  });

  it('leaves nearly half the money on those account-days claimed by no algorithm', () => {
    const shares = Object.fromEntries(
      result.businesses.map((row) => [row.key, row.coverage.unattributedShare]),
    );
    expect(shares).toEqual({
      [BUSINESS_KEYS.BULLET]: 54.88,
      [BUSINESS_KEYS.PROP_OTHER]: 38.8,
      [BUSINESS_KEYS.CASH]: 53.72,
      [BUSINESS_KEYS.UNCLASSIFIED]: 36.52,
    });
    expect(businessFor(result, BUSINESS_KEYS.CASH).coverage.accountPnl).toBe(-49941.29);
    expect(businessFor(result, BUSINESS_KEYS.PROP_OTHER).coverage.accountPnl).toBe(-63924.21);
    expect(businessFor(result, BUSINESS_KEYS.BULLET).coverage.accountPnl).toBe(-57000.88);
  });

  it('counts the Ignored closes rather than dropping them', () => {
    expect(result.reconciliation.accountDays).toBe(14);
    expect(result.reconciliation.rows).toEqual([
      { segment: SEGMENTS.IGNORED, accountDays: 14, accounts: 7 },
    ]);
  });
});

describe('OGX on the real book — one algorithm, one answer', () => {
  const detail = buildAlgorithmDetail(clients, { algorithm: 'OGX' });

  it('is one row at #2, on evidence that clears both arms of the gate', () => {
    expect(detail.found).toBe(true);
    expect(detail.rank).toBe(2);
    expect(detail.rankedPeers).toBe(8);
    expect(detail.overall.accountDays).toBe(77);
    expect(detail.overall.accounts).toBe(24);
    expect(detail.overall.clients).toBe(19);
    expect(detail.overall.meanPerAccountDay).toBe(-11.98);
    // The interval crosses zero at #2, and the panel prints it. "Second best on
    // this book" is not the same claim as "makes money".
    expect(detail.overall.ci.low).toBe(-45.22);
    expect(detail.overall.ci.high).toBe(21.26);
    expect(detail.overall.ci.clusters).toBe(24);
  });

  it('publishes neither of the two figures the split by account type produced', () => {
    // +$23.52 over 47 cash account-days and -$54.12 over 29 prop ones were the
    // same version 2.4 at the same 1/1/0 sizing on the same contract, over
    // closes that overlap on 24 of 27. Presented as two means they read as two
    // behaviours; the reason they differ is which accounts fell in each sample.
    const flat = JSON.stringify(detail);
    expect(flat).not.toContain('23.52');
    expect(flat).not.toContain('-54.12');
    // The account types are still here, in counts, and 77 = 47 + 29 + 1.
    expect(detail.deployment.map((entry) => [entry.segment, entry.accountDays, entry.accounts]))
      .toEqual([
        [SEGMENTS.CASH, 47, 10],
        [SEGMENTS.FUNDED, 24, 11],
        [SEGMENTS.EVAL_STANDARD, 5, 2],
        [SEGMENTS.EVAL_BULLET, 1, 1],
      ]);
    for (const entry of detail.deployment) {
      expect(entry.totalPnl).toBeUndefined();
      expect(entry.meanPerAccountDay).toBeUndefined();
    }
  });

  it('runs one version at one sizing on one contract, which is why it pools', () => {
    const main = configFor(detail, 'v2.4 · PT 220/395/495 · SL 200');
    expect(main.version).toBe('2.4');
    expect(main.sizing).toEqual([{ name: '1/1/0', accountDays: 70 }]);
    expect(main.sizingCaveat).toBeNull();
    expect(main.instruments.map((entry) => entry.name)).toEqual(['MNQ SEP26', 'MNQ 09-26']);
    // Every configuration of OGX on this book is version 2.4 and MNQ.
    expect(detail.configurations.every((config) => config.version === '2.4')).toBe(true);
    expect(detail.configurations.every((config) => config.instruments
      .every((entry) => entry.name.startsWith('MNQ')))).toBe(true);
  });

  it('splits into three configurations, one of which carries the evidence', () => {
    expect(detail.configurationCount).toBe(3);
    expect(detail.readableConfigurations).toBe(1);
    expect(detail.splitAccountDays).toBe(0);
    expect(detail.configurations.map((config) => [config.label, config.accountDays, config.accounts]))
      .toEqual([
        ['v2.4 · PT 220/395/495 · SL 200', 70, 21],
        ['v2.4 · PT 30/60/90 · SL 181', 4, 1],
        ['v2.4 · PT 200/350/425 · SL 200', 3, 2],
      ]);
    // 70 + 4 + 3 = 77, the algorithm's own count, because no account-day on this
    // book ran two configurations of OGX at once.
    expect(detail.configurations.reduce((n, config) => n + config.accountDays, 0))
      .toBe(detail.overall.accountDays);
  });

  it('reads the one configuration that carries evidence at -$9.52 a day', () => {
    const main = configFor(detail, 'v2.4 · PT 220/395/495 · SL 200');
    expect(main.sufficient).toBe(true);
    expect(main.meanPerAccountDay).toBe(-9.52);
    expect(main.ci.low).toBe(-45.51);
    expect(main.ci.high).toBe(26.47);
    expect(main.clients).toBe(16);
    expect(main.upDays).toBe(20);
    expect(main.downDays).toBe(23);
    expect(main.flatDays).toBe(27);
    expect(main.measuredCloses).toBe(13);
    // Deployed across all four account types, which is context and not a result.
    expect(main.deployment.map((entry) => [entry.segment, entry.accountDays])).toEqual([
      [SEGMENTS.CASH, 42],
      [SEGMENTS.FUNDED, 22],
      [SEGMENTS.EVAL_STANDARD, 5],
      [SEGMENTS.EVAL_BULLET, 1],
    ]);
  });

  it('refuses to read the other two, and names which arm each one failed', () => {
    const thin = configFor(detail, 'v2.4 · PT 30/60/90 · SL 181');
    expect(thin.sufficient).toBe(false);
    expect(thin.meanPerAccountDay).toBe(-14);
    expect(thin.evidenceRefusal).toBe(
      'Not read as a result: 4 reported account-days, fewer than the 30 a result needs; '
      + '1 account, fewer than the 10 a result needs.',
    );
    // The only OGX configuration on this book at a different risk level, which
    // is reported beside it and is not part of its identity.
    expect(thin.sizing).toEqual([{ name: '1/2/1', accountDays: 4 }]);

    const small = configFor(detail, 'v2.4 · PT 200/350/425 · SL 200');
    expect(small.sufficient).toBe(false);
    expect(small.meanPerAccountDay).toBe(-66.67);
    expect(detail.comparisonRefusal).toMatch(/1 of the 3 configurations below carries the 30/);
    expect(detail.comparisonNote).toBeNull();
  });

  it('publishes no dollar for OGX or for any configuration of it', () => {
    // What this used to assert — that the three configurations' per-business
    // money added back to the algorithm's, business by business — was a check on
    // a figure that should never have been published. OGX's split read
    // -$458.50 / -$1,569.50 / +$1,105.50, and the account-days behind them, 1 /
    // 29 / 47, are in the deployment table on the same screen. The division is
    // -$54.12 on ordinary prop against +$23.52 on cash: the pair the desk
    // manager rejected, arrived at without the page ever printing either.
    expect(detail.exposure).toBeUndefined();
    expect(detail.totalPnl).toBeUndefined();
    for (const config of detail.configurations) {
      expect(config.exposure).toBeUndefined();
      expect(config.totalPnl).toBeUndefined();
      expect(config.moneyRefusal).toMatch(/No dollar figure on this population/);
    }
    // Neither the split, nor its sum, nor either quotient is anywhere in what
    // this page publishes — including inside the refusals, which describe the
    // division rather than performing it.
    const flat = JSON.stringify(detail);
    for (const gone of ['-1569.5', '1105.5', '-922.5', '-54.12', '23.52']) {
      expect(flat).not.toContain(gone);
    }
    // The one figure of the three that survives as a string is a per-ACCOUNT
    // one: the single bullet-bot-typed account OGX ran on made exactly -$458.50,
    // and the roster names that account. One account is not an account type.
    const seat = detail.accountRows.find((row) => row.measuredPnl === -458.5);
    expect(seat.accountKey).toBeTruthy();
    expect(seat.measuredAccountDays).toBe(1);
  });

  it('charts each close as a rate, with no total on the day to get the sign wrong', () => {
    // 2026-07-30 is why the column had to go rather than be relabelled. OGX's
    // nine measured account-days that close were five of ordinary prop making
    // +$7.00 and four of cash losing -$285.50. Summed they read -$278.50, and
    // the panel printed that under a column headed "Total on the day" carrying
    // the tooltip that promised every dollar was stated per business — twice
    // over, once on the algorithm's chart and once on its main configuration's,
    // where the same day was 5 prop account-days at +$7.00 against 3 cash ones.
    // The figure was a cash dollar added to a prop dollar AND, on both charts,
    // the wrong sign for the prop desk.
    const main = configFor(detail, 'v2.4 · PT 220/395/495 · SL 200');
    const algoPoint = detail.series.find((point) => point.date === '2026-07-30');
    const configPoint = main.series.find((point) => point.date === '2026-07-30');
    expect(Object.keys(algoPoint).sort()).toEqual(['accountDays', 'date', 'mean']);
    expect(Object.keys(configPoint).sort()).toEqual(['accountDays', 'date', 'mean']);
    expect([algoPoint.accountDays, algoPoint.mean]).toEqual([9, -30.94]);
    expect([configPoint.accountDays, configPoint.mean]).toEqual([8, -34.81]);
    // The sum itself is on nothing this page publishes.
    expect(JSON.stringify(detail)).not.toContain('-278.5');
    // Every close, on both series, carries a rate and a count and nothing else.
    for (const series of [detail.series, ...detail.configurations.map((c) => c.series)]) {
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual(['accountDays', 'date', 'mean']);
      }
    }
  });

  it('names the clients running it and what it made them', () => {
    expect(detail.clientRows).toHaveLength(19);
    expect(detail.accountRows).toHaveLength(24);
    expect(detail.accountRows).toHaveLength(detail.overall.accounts);
    expect(detail.clientRows[0].clientName).toBe('Wren Moss');
    expect(detail.clientRows[0].measuredPnl).toBe(935);
  });

  it('shows every dollar on this book as reported, because the book carries no derivation', () => {
    // public/local-snapshot.json predates the fill-derived split: all 1,402
    // enabled strategy rows on it carry `realized` and none carries
    // `derivedRealized`. This pins which side of the distinction this export
    // sits on, so the day an export with derivations lands, it fails and says so
    // rather than the screen quietly relabelling itself.
    for (const seat of detail.accountRows) {
      expect(seat.derivedPnl).toBe(0);
      expect(seat.daysDerived).toBe(0);
      expect(seat.daysMixed).toBe(0);
      expect(seat.reportedPnl).toBe(seat.measuredPnl);
    }
  });
});

describe('an algorithm the ranking refuses to rank', () => {
  const detail = buildAlgorithmDetail(clients, { algorithm: 'ARPD_PF' });

  it('is listed with its counts and given no position', () => {
    expect(detail.found).toBe(true);
    expect(detail.ranked).toBe(false);
    expect(detail.rank).toBe(null);
    expect(detail.overall.accountDays).toBe(2);
    expect(detail.overall.accounts).toBe(2);
    expect(detail.rankRefusal).toMatch(/2 reported account-days, fewer than the 30/);
    expect(detail.rankRefusal).toMatch(/2 accounts, fewer than the 10/);
  });

  it('shows the closes it did not run on as gaps, not as zeroes', () => {
    expect(detail.series).toHaveLength(14);
    expect(detail.measuredCloses).toBe(1);
    expect(detail.series.filter((point) => point.accountDays === 0)).toHaveLength(13);
    // A zero on any of them would draw a flat line either side of the one day it
    // traded and make a single +$432 account-day look like a record.
    expect(detail.series.every((point) => point.accountDays > 0 || point.mean === null)).toBe(true);
  });

  it('has no seven-day window and refuses a trend rather than printing level', () => {
    expect(detail.overall.recentAccountDays).toBe(0);
    expect(detail.overall.trend).toBe(null);
    expect(detail.overall.trendRefusal).toMatch(/Neither the seven days to 2026-07-30/);
  });
});

describe('the detail and the ranking cannot disagree', () => {
  it('is the ranking’s own row for every algorithm on the book', () => {
    const ranking = buildStrategyRanking(clients);
    for (const row of ranking.ranking.rows) {
      const detail = buildAlgorithmDetail(clients, { algorithm: row.name });
      expect(detail.overall.meanPerAccountDay).toBe(row.meanPerAccountDay);
      expect(detail.overall.accountDays).toBe(row.accountDays);
      expect(detail.overall.accounts).toBe(row.accounts);
      expect(detail.overall.ci).toEqual(row.ci);
      expect(detail.rank).toBe(row.rank);
      expect(detail.moneyRefusal).toBe(row.moneyRefusal);
      expect(detail.deployment).toEqual(row.deployment);
      // And the configurations under it account for every account-day the row
      // has, once each, unless an account-day ran two of them.
      const configDays = detail.configurations.reduce((n, config) => n + config.accountDays, 0);
      expect(configDays).toBeGreaterThanOrEqual(row.accountDays);
      expect(configDays - row.accountDays).toBeLessThanOrEqual(detail.splitAccountDays * 4);
    }
  });

  it('repeats each business’s coverage exactly as the ranking states it', () => {
    const ranking = buildStrategyRanking(clients);
    const detail = buildAlgorithmDetail(clients, { algorithm: 'OGX' });
    expect(detail.businesses).toEqual(ranking.businesses);
  });
});
