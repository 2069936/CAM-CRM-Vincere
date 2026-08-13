import { describe, expect, it } from 'vitest';
import { buildClientSeries } from '../../export/clientExportSeries.js';
import { ABSENCE_REASONS, ABSENCE_REASON_TEXT, buildAbsenceIndex } from '../../export/absentAccounts.js';

const C1 = 'c1';
const C2 = 'c2';
const DATES = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'];

/**
 * One client, four closes, and one account per shape the payload has to tell
 * apart. Every account below exists because the real book has that shape:
 * 229 accounts registered after a close they appear in, 84 marked Inactive /
 * Ignore, 48 marked Failed while 30 keep reporting, 33 snapshots with no
 * registry row.
 */
function fixture() {
  const accounts = [
    // Reports every close. Never absent.
    { id: 'a-always', account_name: 'ALWAYS', date_added: '2026-07-01', account_type: 'Funded' },
    // Reports 13 + 14, silent after. Healthy buffer -> still live.
    { id: 'a-quiet', account_name: 'QUIET', date_added: '2026-07-01', account_type: 'Funded' },
    // Buffer goes negative on the 14th, silent after -> finished.
    { id: 'a-breach', account_name: 'BREACH', date_added: '2026-07-01', account_type: 'Funded' },
    // Registered on the LAST close. Must not be absent on the first three.
    { id: 'a-late', account_name: 'LATE', date_added: '2026-07-16', account_type: 'Funded' },
    // date_added AFTER a close it demonstrably reported in.
    { id: 'a-backdated', account_name: 'BACKDATED', date_added: '2026-07-15', account_type: 'Funded' },
    // Registered from the start, never seen.
    { id: 'a-never', account_name: 'NEVER', date_added: '2026-07-01', account_type: 'Funded' },
    // Reports every close with a realized P&L of exactly 0.
    { id: 'a-zero', account_name: 'ZERO', date_added: '2026-07-01', account_type: 'Funded' },
    // Existed from the 13th, first files on the 15th.
    { id: 'a-warmup', account_name: 'WARMUP', date_added: '2026-07-13', account_type: 'Funded' },
    // Neither date_added nor an observed close.
    { id: 'a-nostart', account_name: 'NOSTART', date_added: null, account_type: 'Funded' },
    // Marked Failed by the desk, healthy buffer on its last close.
    { id: 'a-failed', account_name: 'FAILEDMARK', date_added: '2026-07-01', account_type: 'Funded', status: 'Failed' },
    // Healthy on the 13th, absent the 14th, breaches on the 15th, absent the 16th.
    // Its absence on the 14th has a LATER close behind it, which is the only
    // shape that can catch a rule reading the range's last close instead of the
    // last one on or before the day. 23 absent rows on the real book sit in it.
    { id: 'a-latebreach', account_name: 'LATEBREACH', date_added: '2026-07-01', account_type: 'Funded' },
    // Buffer measured on the 13th, then a close carrying trailing_max_drawdown
    // exactly 0 on the 14th, then silence. 585 of the 3,100 real snapshot rows
    // carry that 0 and accountLifecycle.readingOf reads it as "the import had no
    // drawdown column", not as a buffer — so the last MEASURED buffer stays
    // dated the 13th while the last close this account filed is the 14th.
    { id: 'a-ddstale', account_name: 'DDSTALE', date_added: '2026-07-01', account_type: 'Funded' },
    // Shelved by the desk.
    { id: 'a-ignore', account_name: 'IGNORED', date_added: '2026-07-01', account_type: 'Inactive / Ignore' },
  ].map((row) => ({
    client_id: C1,
    status: 'Active',
    alias: null,
    algo_stack: null,
    max_drawdown_limit: null,
    start_balance: 50000,
    ...row,
  }));

  const dailyImports = DATES.map((date, index) => ({
    id: `i${index + 1}`, client_id: C1, trading_date: date, status: 'Closed',
  }));
  dailyImports.push({ id: 'i-c2', client_id: C2, trading_date: DATES[0], status: 'Closed' });

  const snap = (importId, account, extra = {}) => ({
    id: `s-${importId}-${account}`,
    daily_import_id: importId,
    trading_account_id: `a-${account.toLowerCase()}`,
    account_name: account,
    gross_realized_pnl: 100,
    trailing_max_drawdown: 1000,
    account_balance: 50000,
    unrealized_pnl: 0,
    weekly_pnl: 100,
    ...extra,
  });

  const accountSnapshots = [
    ...DATES.map((_, index) => snap(`i${index + 1}`, 'ALWAYS')),
    ...DATES.map((_, index) => snap(`i${index + 1}`, 'ZERO', { gross_realized_pnl: 0 })),
    snap('i1', 'QUIET'), snap('i2', 'QUIET'),
    snap('i1', 'BREACH'), snap('i2', 'BREACH', { trailing_max_drawdown: -300 }),
    snap('i1', 'BACKDATED'),
    snap('i3', 'WARMUP'), snap('i4', 'WARMUP'),
    snap('i1', 'FAILEDMARK'),
    snap('i1', 'LATEBREACH'), snap('i3', 'LATEBREACH', { trailing_max_drawdown: -900 }),
    snap('i1', 'DDSTALE', { trailing_max_drawdown: 1045.5 }),
    snap('i2', 'DDSTALE', { trailing_max_drawdown: 0 }),
    // A snapshot with no registry row behind it, and no trading_account_id
    // either — 41 of 3,100 real rows are in that state.
    { id: 's-orphan', daily_import_id: 'i1', trading_account_id: null, account_name: 'GHOST', gross_realized_pnl: 42 },
    snap('i-c2', 'ALWAYS', { trading_account_id: 'a-c2', account_name: 'C2ACC' }),
  ];

  const strategySnapshots = [
    { id: 'st1', daily_import_id: 'i1', trading_account_id: 'a-quiet', strategy_name: 'URGO-4.5', strategy_family: 'URGO', strategy_version: '4.5', instrument: 'MNQ', direction: 'Both', enabled: true },
    { id: 'st2', daily_import_id: 'i2', trading_account_id: 'a-quiet', strategy_name: 'URGO-4.5', strategy_family: 'URGO', strategy_version: '4.5', instrument: 'MNQ', direction: 'Both', enabled: false },
    { id: 'st3', daily_import_id: 'i2', trading_account_id: 'a-quiet', strategy_name: 'RBO-1.8', strategy_family: 'RBO', strategy_version: '1.8', instrument: 'MES', direction: 'Long', enabled: null },
    // LATEBREACH files on the 13th with its strategy ON and again on the 15th
    // with the same strategy OFF, so the two closes around its absence on the
    // 14th disagree. Devon Hollow's EEH42302784576280 is this exact shape on the
    // real book: absent 2026-07-15, last close 2026-07-13 carrying IFSP-1.1 /
    // RBO-1.8 / OGX-2.4 all OFF, next close 2026-07-30 carrying all three ON.
    // Reading the later close would answer "it was running" about a day two
    // weeks before that close existed.
    { id: 'st4', daily_import_id: 'i1', trading_account_id: 'a-latebreach', strategy_name: 'OGX-2.4', strategy_family: 'OGX', strategy_version: '2.4', instrument: 'MNQ', direction: 'Both', enabled: true },
    { id: 'st5', daily_import_id: 'i3', trading_account_id: 'a-latebreach', strategy_name: 'OGX-2.4', strategy_family: 'OGX', strategy_version: '2.4', instrument: 'MNQ', direction: 'Both', enabled: false },
  ];

  return {
    clients: [{ id: C1, name: 'Client One' }, { id: C2, name: 'Client Two' }],
    tradingAccounts: [...accounts, {
      id: 'a-c2', client_id: C2, account_name: 'C2ACC', status: 'Active', account_type: 'Funded', date_added: '2026-07-01',
    }, {
      // Registered on the last of the three dates C2 never filed on, so only one
      // of those three dates can be charged against it.
      id: 'a-c2late', client_id: C2, account_name: 'C2LATE', status: 'Active', account_type: 'Funded', date_added: '2026-07-16',
    }],
    dailyImports,
    accountSnapshots,
    strategySnapshots,
    orders: [],
    executions: [],
  };
}

function seriesOf(overrides = {}) {
  return buildClientSeries({ ...fixture(), ...overrides, includeTradeHistory: false, rangeFrom: DATES[0] });
}

function dayOf(series, date, clientId = C1) {
  return series.find((entry) => entry.clientId === clientId).days.find((day) => day.date === date);
}

function starts(series, name, clientId = C1) {
  return series.find((entry) => entry.clientId === clientId)
    .summary.coverage.accountStarts.find((row) => row.accountName === name) || null;
}

function absent(day, name) {
  return day.absentAccounts.find((row) => row.accountName === name) || null;
}

describe('absent accounts: the day is the whole book, not just who filed', () => {
  it('lists a registered account that existed and did not file', () => {
    const day = dayOf(seriesOf(), '2026-07-15');
    expect(day.accounts.map((row) => row.accountName).sort())
      .toEqual(['ALWAYS', 'LATEBREACH', 'WARMUP', 'ZERO']);
    expect(day.absentAccounts.map((row) => row.accountName).sort())
      .toEqual(['BACKDATED', 'BREACH', 'DDSTALE', 'FAILEDMARK', 'IGNORED', 'NEVER', 'QUIET']);
  });

  it('never renders "did not report" as a zero', () => {
    const quiet = absent(dayOf(seriesOf(), '2026-07-15'), 'QUIET');
    expect(quiet.reported).toBe(false);
    // The absent entry carries no P&L of its own at any depth. A 0 here is the
    // exact failure this whole feature exists to prevent.
    expect(quiet).not.toHaveProperty('realizedPnl');
    expect(quiet).not.toHaveProperty('accountBalance');
    // What IS known travels with the date it was true on.
    expect(quiet.lastReportedDate).toBe('2026-07-14');
    expect(quiet.lastReported).toMatchObject({ realizedPnl: 100, accountBalance: 50000 });
  });

  it('keeps "reported zero" out of the absence list entirely', () => {
    const day = dayOf(seriesOf(), '2026-07-15');
    expect(absent(day, 'ZERO')).toBeNull();
    expect(day.accounts.find((row) => row.accountName === 'ZERO').realizedPnl).toBe(0);
  });
});

describe('the not-yet-registered trap', () => {
  it('does not list an account as absent before it could have existed', () => {
    const series = seriesOf();
    for (const date of ['2026-07-13', '2026-07-14', '2026-07-15']) {
      const day = dayOf(series, date);
      expect(absent(day, 'LATE')).toBeNull();
      expect(day.notYetRegisteredAccountIds).toContain('a-late');
    }
    // On its own registration date it becomes a real absence.
    const last = dayOf(series, '2026-07-16');
    expect(absent(last, 'LATE').reason).toBe(ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE);
    expect(last.notYetRegisteredAccountIds).not.toContain('a-late');
    // The identity behind the id, carried once with the date it starts from.
    expect(starts(series, 'LATE')).toMatchObject({
      dateAdded: '2026-07-16', existsFrom: '2026-07-16', existsFromBasis: 'date_added',
    });
  });

  it('lets an observed close override a date_added that is later than it', () => {
    // 229 of the 720 observed accounts on the real book carry a date_added later
    // than the first close they appear in. Trusting the column would hide them.
    const series = seriesOf();
    const first = dayOf(series, '2026-07-13');
    expect(first.accounts.map((row) => row.accountName)).toContain('BACKDATED');
    expect(first.notYetRegisteredAccountIds).not.toContain('a-backdated');
    expect(absent(dayOf(series, '2026-07-14'), 'BACKDATED')).not.toBeNull();
    expect(starts(series, 'BACKDATED')).toMatchObject({
      dateAdded: '2026-07-15', existsFrom: '2026-07-13', existsFromBasis: 'first-observed-report',
    });
  });

  it('excludes an account with no usable start date rather than inventing absences', () => {
    for (const date of DATES) {
      const day = dayOf(seriesOf(), date);
      expect(absent(day, 'NOSTART')).toBeNull();
      expect(day.notYetRegisteredAccountIds).toContain('a-nostart');
    }
    expect(starts(seriesOf(), 'NOSTART'))
      .toMatchObject({ existsFrom: null, existsFromBasis: 'unknown' });
  });

  it('ignores created_at entirely', () => {
    // created_at on the real book is the CRM migration stamp: all 764 values sit
    // in one month and 246 of them post-date the first close their account
    // appears in. A rule that read it would drop LATE's absence on the 16th.
    const base = fixture();
    const series = buildClientSeries({
      ...base,
      tradingAccounts: base.tradingAccounts.map((row) => ({ ...row, created_at: '2027-01-01T00:00:00Z' })),
      includeTradeHistory: false,
      rangeFrom: DATES[0],
    });
    expect(absent(dayOf(series, '2026-07-16'), 'LATE')).not.toBeNull();
  });
});

describe('the four reasons are four different facts', () => {
  it('separates never-reported, not-yet-reporting, still-live and finished', () => {
    const series = seriesOf();
    const day14 = dayOf(series, '2026-07-14');
    expect(absent(day14, 'NEVER').reason).toBe(ABSENCE_REASONS.NEVER_REPORTED_IN_RANGE);
    expect(absent(day14, 'WARMUP').reason).toBe(ABSENCE_REASONS.NOT_YET_REPORTING);
    expect(absent(day14, 'LATEBREACH').reason).toBe(ABSENCE_REASONS.ABSENT_STILL_LIVE);

    const day15 = dayOf(series, '2026-07-15');
    expect(absent(day15, 'QUIET').reason).toBe(ABSENCE_REASONS.ABSENT_STILL_LIVE);
    expect(absent(day15, 'BREACH').reason).toBe(ABSENCE_REASONS.ABSENT_FINISHED);
    expect(absent(day15, 'BREACH').lastReported.breached).toBe(true);
  });

  it('asks the lifecycle question as of the day, not as of the end of the range', () => {
    // LATEBREACH goes negative on the 15th. Answering every day with the
    // end-of-range verdict would backdate the breach across the 14th, which is
    // the shape of 76 breaches on the real book that are all dated 2026-07-30.
    const series = seriesOf();
    expect(absent(dayOf(series, '2026-07-14'), 'LATEBREACH').reason)
      .toBe(ABSENCE_REASONS.ABSENT_STILL_LIVE);
    expect(absent(dayOf(series, '2026-07-16'), 'LATEBREACH').reason)
      .toBe(ABSENCE_REASONS.ABSENT_FINISHED);
  });

  it('does not let the desk status column decide that an account is finished', () => {
    // 48 accounts are marked Failed on the real book and 30 of them appear in
    // the most recent close. src/domain/accountLifecycle.js refuses to read the
    // column as evidence, and this reuses that refusal rather than re-deciding.
    const failed = absent(dayOf(seriesOf(), '2026-07-15'), 'FAILEDMARK');
    expect(failed.accountStatus).toBe('Failed');
    expect(failed.reason).toBe(ABSENCE_REASONS.ABSENT_STILL_LIVE);
  });

  it('counts desk-shelved accounts apart without hiding them', () => {
    const day = dayOf(seriesOf(), '2026-07-15');
    expect(absent(day, 'IGNORED').markedIgnore).toBe(true);
    expect(absent(day, 'QUIET').markedIgnore).toBe(false);
    expect(day.coverage.absentMarkedIgnore).toEqual({ count: 1, of: 7 });
  });
});

describe('what an absent account would have been running', () => {
  it('carries the strategies last seen on it, with enabled kept tri-state', () => {
    const quiet = absent(dayOf(seriesOf(), '2026-07-16'), 'QUIET');
    // The 14th, not the 13th: the last close it actually filed. lastReportedDate
    // is the date these strategies were read on.
    expect(quiet.lastReportedDate).toBe('2026-07-14');
    expect(quiet.lastStrategies).toEqual([
      { strategyName: 'URGO-4.5', strategyFamily: 'URGO', strategyVersion: '4.5', instrument: 'MNQ', direction: 'Both', enabled: false },
      // enabled null is "the import carried no such column", not "switched off".
      { strategyName: 'RBO-1.8', strategyFamily: 'RBO', strategyVersion: '1.8', instrument: 'MES', direction: 'Long', enabled: null },
    ]);
  });

  it('gives an account that never filed a null strategy list, not an empty one', () => {
    const never = absent(dayOf(seriesOf(), '2026-07-15'), 'NEVER');
    expect(never.lastStrategies).toBeNull();
    expect(never.lastReportedDate).toBeNull();
    expect(never.lastReported).toBeNull();
  });

  it('carries the lifecycle evidence line for the day', () => {
    const quiet = absent(dayOf(seriesOf(), '2026-07-16'), 'QUIET');
    expect(quiet.lifecycle.closesSinceSeen).toBe(2);
    expect(quiet.lifecycle.lastTradeDate).toBe('2026-07-14');
    expect(quiet.lastReportedDate).toBe('2026-07-14');
    expect(quiet.closesReportedBeforeThisDay).toBe(2);
  });

  it('never reads the strategies from a close that had not happened yet', () => {
    // LATEBREACH is absent on the 14th with closes on BOTH sides of it: the
    // 13th, where OGX-2.4 was on, and the 15th, where it was off. Only the 13th
    // is an answer about the 14th. 18 absent rows on the real book sit before a
    // later close and every one of them changes value under the later close —
    // Devon Hollow's EEH42302784576280 on 2026-07-15 flips from three
    // strategies OFF (its 07-13 close, which is why it did not run) to the same
    // three ON (its 07-30 close, fifteen days after the day being described).
    const series = seriesOf();
    const day14 = absent(dayOf(series, '2026-07-14'), 'LATEBREACH');
    expect(day14.lastReportedDate).toBe('2026-07-13');
    expect(day14.lastStrategies).toEqual([{
      strategyName: 'OGX-2.4', strategyFamily: 'OGX', strategyVersion: '2.4', instrument: 'MNQ', direction: 'Both', enabled: true,
    }]);
    // ... and once the 15th IS in the past, that close is the one that answers.
    const day16 = absent(dayOf(series, '2026-07-16'), 'LATEBREACH');
    expect(day16.lastReportedDate).toBe('2026-07-15');
    expect(day16.lastStrategies.map((row) => row.enabled)).toEqual([false]);
  });

  it('counts only the closes that came before this day, not the whole range', () => {
    // Same trap as the strategies above, on the count beside them. On the 14th
    // LATEBREACH has filed once; its second close is still ahead. Counting the
    // range would say 2, and on the real book it says 7 where the truth is 1
    // (Devon Hollow, EEH42302784576280, 2026-07-15).
    const series = seriesOf();
    expect(absent(dayOf(series, '2026-07-14'), 'LATEBREACH').closesReportedBeforeThisDay).toBe(1);
    expect(absent(dayOf(series, '2026-07-16'), 'LATEBREACH').closesReportedBeforeThisDay).toBe(2);
  });

  it('dates the trailing-drawdown reading by when it was measured, not by the last close', () => {
    // DDSTALE files a real 1,045.50 buffer on the 13th and then a close whose
    // trailing_max_drawdown is exactly 0 on the 14th. accountLifecycle refuses
    // to read that 0 as a buffer, so the last MEASURED reading is a day older
    // than the last close — and stamping it with the close's date would claim a
    // measurement that was never taken. 21 absent rows on the real book have
    // the two dates apart, 12 of them with no reading at all; Harper Juniper's
    // CCF23009250154227 on 2026-07-21 carries a buffer read on 07-13 while its
    // last close was 07-20.
    const row = absent(dayOf(seriesOf(), '2026-07-15'), 'DDSTALE');
    expect(row.lastReportedDate).toBe('2026-07-14');
    expect(row.lastReported.trailingMaxDrawdown).toBe(1045.5);
    expect(row.lastReported.trailingMaxDrawdownDate).toBe('2026-07-13');
    // The stale reading is still not a breach, so the account stays live.
    expect(row.reason).toBe(ABSENCE_REASONS.ABSENT_STILL_LIVE);
  });
});

describe('every count carries its denominator and they reconcile', () => {
  it('splits the registry into existed / reported / absent on every day', () => {
    for (const date of DATES) {
      const { coverage } = dayOf(seriesOf(), date);
      expect(coverage.registered).toBe(13);
      expect(coverage.existedOnDay + coverage.notYetRegistered.count).toBe(coverage.registered);
      expect(coverage.reported.count + coverage.absent.count).toBe(coverage.existedOnDay);
      // The absence count is out of what EXISTED, never out of what reported.
      // Swapping the two makes Devon Hollow's 2026-07-30 read "17 absent of 8"
      // where the truth is 17 of 25, and 230 of the 535 client-days on the real
      // book have existedOnDay != reported, so the swap is visible almost
      // everywhere rather than in a corner case.
      expect(coverage.absent.of).toBe(coverage.existedOnDay);
      const reasons = coverage.absentByReason;
      const summed = reasons.neverReportedInRange + reasons.notYetReporting
        + reasons.absentStillLive + reasons.absentFinished;
      expect(summed).toBe(coverage.absent.count);
      expect(reasons.of).toBe(coverage.existedOnDay);
      expect(coverage.reported.of).toBe(coverage.existedOnDay);
      expect(coverage.notYetRegistered.of).toBe(coverage.registered);
    }
  });

  it('counts a snapshot with no registry row apart from both sides', () => {
    const day = dayOf(seriesOf(), '2026-07-13');
    // GHOST filed and is in `accounts`, but it is neither a registered account
    // reporting nor an absence — it is trading the registry cannot name.
    expect(day.coverage.reportedWithoutRegistryRow).toBe(1);
    expect(day.coverage.snapshotRows).toBe(day.accounts.length);
    expect(day.coverage.reported.count).toBe(day.accounts.length - 1);
  });

  it('rolls the range up as account-days with the same denominator', () => {
    const { coverage } = seriesOf().find((entry) => entry.clientId === C1).summary;
    expect(coverage.accountDaysReported.count + coverage.accountDaysAbsent.count)
      .toBe(coverage.accountDaysExpected);
    expect(coverage.accountDaysReported.of).toBe(coverage.accountDaysExpected);
    // Same denominator rule one level up. Reading the range's reason split
    // against account-days REPORTED instead of account-days expected makes
    // Jordan Cedar's book read "63 absent account-days of 33" — more absences
    // than the denominator admits — and it moves 42 of the real book's 136
    // clients.
    expect(coverage.accountDaysAbsent.of).toBe(coverage.accountDaysExpected);
    expect(coverage.absentByReason.of).toBe(coverage.accountDaysExpected);
    expect(coverage.reportRatePct)
      .toBe(Math.round((coverage.accountDaysReported.count / coverage.accountDaysExpected) * 1000) / 10);
  });

  it('reports a null rate, never 0%, when there is no denominator', () => {
    const base = fixture();
    const coverage = buildClientSeries({
      ...base,
      tradingAccounts: base.tradingAccounts.filter((row) => row.client_id !== C1),
      includeTradeHistory: false,
      rangeFrom: DATES[0],
    }).find((entry) => entry.clientId === C1).summary.coverage;
    expect(coverage.accountDaysExpected).toBe(0);
    expect(coverage.reportRatePct).toBeNull();
  });
});

describe('a collection problem is not an account problem', () => {
  it('marks the day when the client filed an import carrying no account rows', () => {
    const base = fixture();
    const series = buildClientSeries({
      ...base,
      accountSnapshots: base.accountSnapshots.filter((row) => row.daily_import_id !== 'i2'),
      includeTradeHistory: false,
      rangeFrom: DATES[0],
    });
    const day = dayOf(series, '2026-07-14');
    expect(day.coverage.clientFiledNothing).toBe(true);
    expect(day.coverage.snapshotRows).toBe(0);
    // Real accounts existed and are listed, so the absences are attributed —
    // but to the collector, via the day flag, not to each account.
    expect(day.coverage.absent.count).toBeGreaterThan(0);
    // ... and a normal day is not flagged.
    expect(dayOf(series, '2026-07-13').coverage.clientFiledNothing).toBe(false);
  });

  it('counts the trading dates the client produced no import for, apart from absences', () => {
    const { uncollected } = seriesOf().find((entry) => entry.clientId === C2).summary.coverage;
    // C2 filed only on the first of the four dates its payload knows about.
    expect(uncollected.deskDates).toBe(4);
    expect(uncollected.datesFiled).toEqual({ count: 1, of: 4 });
    expect(uncollected.datesNotFiled).toEqual({ count: 3, of: 4 });
    expect(uncollected.dates).toEqual(['2026-07-14', '2026-07-15', '2026-07-16']);
    // C2ACC existed on all three, C2LATE only on the 16th: 3 + 1, not 3 x 2. An
    // uncollected day is charged per account that could have been collected, or
    // a client who added an account today looks like it has been missing all
    // month.
    expect(uncollected.accountDaysUncollected).toBe(4);
    // None of those four are counted as an absence — that is the whole point of
    // keeping the two numbers apart.
    const c2 = seriesOf().find((entry) => entry.clientId === C2).summary.coverage;
    expect(c2.accountDaysAbsent.count).toBe(0);
    expect(c2.accountDaysExpected).toBe(1);
  });

  it('refuses to build a day out of an import with no usable trading date', () => {
    // The manufacturing path that does NOT come through the registry. Every
    // absence figure is keyed on the date; isoDay() turns an unusable one into
    // null, and `existsFrom > null` is false for every account, so the entire
    // registry clears the existence gate and nothing can match a reported name.
    // Before the guard this fixture's client emitted a 13-account day called
    // "null" and its reportRatePct fell from 61.5 to 51.3. On the real book the
    // same shape invented 41 absences — a whole client — for one dateless row.
    const base = fixture();
    const clean = buildClientSeries({ ...base, includeTradeHistory: false, rangeFrom: DATES[0] })
      .find((entry) => entry.clientId === C1);
    const series = buildClientSeries({
      ...base,
      dailyImports: [...base.dailyImports, { id: 'i-undated', client_id: C1, trading_date: null, status: 'Closed' }],
      includeTradeHistory: false,
      rangeFrom: DATES[0],
    }).find((entry) => entry.clientId === C1);

    expect(series.days.some((day) => day.dailyImportId === 'i-undated')).toBe(false);
    expect(series.days.map((day) => day.date)).toEqual(clean.days.map((day) => day.date));
    // The undated row moves no coverage number at all, in either direction.
    expect(series.summary.coverage.accountDaysExpected).toBe(clean.summary.coverage.accountDaysExpected);
    expect(series.summary.coverage.accountDaysAbsent.count).toBe(clean.summary.coverage.accountDaysAbsent.count);
    expect(series.summary.coverage.reportRatePct).toBe(clean.summary.coverage.reportRatePct);
  });

  it('names the calendar it is measuring against', () => {
    // A one-client export derives the calendar from that client's own imports,
    // so datesNotFiled is 0 by construction. The basis string is what stops that
    // being read as "filed on every trading day".
    const { uncollected } = seriesOf().find((entry) => entry.clientId === C1).summary.coverage;
    expect(uncollected.datesNotFiled.count).toBe(0);
    expect(uncollected.deskDatesBasis).toContain('2 client(s)');
  });
});

describe('buildAbsenceIndex on its own', () => {
  it('answers for a client with no registry at all without inventing anything', () => {
    const { absenceFor } = buildAbsenceIndex({
      clients: [{ id: C1 }],
      tradingAccounts: [],
      dailyImports: [{ id: 'i1', client_id: C1, trading_date: '2026-07-13' }],
      accountSnapshots: [],
    });
    const result = absenceFor(C1, '2026-07-13');
    expect(result.absentAccounts).toEqual([]);
    expect(result.notYetRegisteredAccountIds).toEqual([]);
    expect(result.coverage.registered).toBe(0);
    expect(result.coverage.existedOnDay).toBe(0);
    expect(result.coverage.clientFiledNothing).toBe(true);
  });

  it('gives every reason a human-readable text in the shared legend', () => {
    // Emitted once per payload by clientExport.js rather than once per row.
    for (const reason of Object.values(ABSENCE_REASONS)) {
      expect(ABSENCE_REASON_TEXT[reason]).toBeTruthy();
      expect(ABSENCE_REASON_TEXT[reason].length).toBeGreaterThan(40);
    }
    for (const row of dayOf(seriesOf(), '2026-07-15').absentAccounts) {
      expect(ABSENCE_REASON_TEXT[row.reason]).toBeTruthy();
    }
  });

  it('leaves every static registry attribute to the join', () => {
    // tables.trading_accounts travels un-range-filtered in the same payload and
    // every absent row carries tradingAccountId. Repeating alias / risk_level /
    // start_balance / target_profit / max_drawdown_limit / date_added per
    // account per day was 35 KB of the 337 KB this array cost the busiest CAM.
    const row = absent(dayOf(seriesOf(), '2026-07-15'), 'QUIET');
    for (const field of ['alias', 'riskLevel', 'startBalance', 'targetProfit', 'maxDrawdownLimit', 'dateAdded', 'reasonText']) {
      expect(row).not.toHaveProperty(field);
    }
    expect(row.tradingAccountId).toBe('a-quiet');
  });
});
