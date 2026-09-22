/**
 * The desk period report: one week, one month, or a range somebody typed, with
 * every figure carrying the population it was measured over, the window it was
 * measured in, and the basis it was measured on.
 *
 * WHAT THIS MODULE OWNS: composition, and the four things no existing module
 * could answer on its own — coverage per close, the algorithm roster's four
 * states, the movement table that puts one window beside another, and the
 * combination changes inside the period. Everything else is another module's
 * answer, called once and rendered: `deskMoney.js` for money,
 * `algorithmRanking.js` for results, `comboPerformance.js` for the stack,
 * `quietAccounts.js` for who stopped filing, `strategyConfigDrift.js` for
 * configuration drift, `algorithmBenchmark.js` for My Futures Book.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN. It is not a fifth answer to what the desk
 * made. `report.js:406` records why `buildTeamWeeklyReport` was deleted — it
 * was a fourth independent arithmetic for the same question — and the money
 * block here is the object `buildDeskMoneyForRange` returns, with two derived
 * columns (per account close, and this period against the one before) and no
 * sum of its own. There is no total across businesses anywhere in this file.
 *
 * THE THREE RULES EVERY FIGURE HERE OBEYS, and they are not style:
 *
 * 1. NO DOLLAR TOTAL IS A HEADLINE AND NO TWO PERIODS ARE COMPARED IN DOLLARS.
 *    Account rows per close on this book run from 7 to 438 — a factor of sixty
 *    — because the denominator is how many CAMs exported that day, not how much
 *    of the desk traded. Every result is a rate per account day or per account
 *    close with its denominator beside it.
 *
 * 2. NOTHING IS RANKED ON A SAMPLE TOO THIN TO RANK. The gates are the ones the
 *    modules already own — 30 account days and 10 accounts for an algorithm
 *    (`EVIDENCE_GATE`), 10 account days and 3 accounts for a combination
 *    (`MIN_DAYS` / `MIN_ACCOUNTS`) — and this file adds exactly one of its own,
 *    `MIN_CLOSES_FOR_MONEY_CHANGE`, which is stated on screen where it applies.
 *
 * 3. CLIENT ACCOUNT RESULTS AND BACKTEST RESULTS NEVER SHARE A COLUMN, A CHART
 *    SERIES OR A TOTAL. The benchmark block is built from its own module, keyed
 *    by its own series, and the only thing it is joined to the client side on
 *    is the algorithm's name and version — which is the one field that means
 *    the same thing on both sides. Every benchmark figure carries
 *    `benchmarkBasisLabel`, and `formatDeskPeriodReport` carries none of them at
 *    all, because a pasted line loses the label that makes the figure legal.
 */

import {
  buildDeskMoneyForRange,
  bookCloses,
  DESK_BUSINESS_ORDER,
  deskBusinessColumns,
} from './deskMoney';
import { ACCOUNT_TYPE_REFUSAL, buildStrategyRanking, EVIDENCE_GATE } from './algorithmRanking';
import {
  buildComboPerformance,
  comboKeyFromDay,
  executionsForAccount,
  MIN_ACCOUNTS,
  MIN_DAYS,
  NOTE_NO_GATE,
  NOTE_NO_POSITIVE,
  UNKNOWN_KEY,
} from './comboPerformance';
import { buildQuietAccounts } from './quietAccounts';
import { buildConfigDrift } from './strategyConfigDrift';
import {
  BENCHMARK_MIN_COMMON_CLOSES,
  BENCHMARK_RISK_LEVELS,
  benchmarkBasisLabel,
  buildBenchmarkCoverage,
} from './algorithmBenchmark';
import { instrumentRoot } from './instrumentSpecs';
import { SEGMENTS, segmentForAccount } from './operationsSegments';
import { isWeekday, resolvePeriod } from './deskPeriod';

/**
 * Account closes a business needs on BOTH sides before this report prints a
 * change between two periods' means.
 *
 * The one threshold in this file that is not inherited from a module, and it is
 * here rather than in `deskMoney.js` because it is a property of the
 * comparison, not of the money. At two or three account closes a difference of
 * means is one account's day wearing the label of a business; ten is the
 * smallest number at which the difference survives one account going quiet. It
 * is printed in the column's own tooltip, not only here.
 */
export const MIN_CLOSES_FOR_MONEY_CHANGE = 10;

/**
 * The band inside which a movement is reported as "no change shown".
 *
 * A tenth of the PRIOR window's magnitude, which is the rule
 * `comboPerformance.finishRow` already uses for its trend halves, chosen there
 * because a multiplicative bar (`recent > prior * 1.1`) inverts on negative
 * numbers: a combination losing exactly as much as before read as "up". Every
 * algorithm on this book is negative, so the multiplicative version would be
 * wrong on every row of this table.
 */
const CHANGE_BAND = 0.1;

const PERIOD_DOLLAR_REFUSAL = 'A dollar total over a period moves with how many CAMs exported in '
  + 'it. Every result in this report is stated per account day or per account close, with the '
  + 'count it divides by printed beside it, and no two periods are compared in dollars.';

const BENCHMARK_SEPARATION = 'Client account results over the period. Not the algorithms’ own '
  + 'track records. Not comparable to My Futures Book, which is measured in its own section and '
  + 'never in the same table as these.';

const ROSTER_STATES = {
  RUNNING: 'Running',
  NEW_RUNNING: 'New, running',
  NEW: 'New',
  STOPPED: 'Stopped',
  NOT_SEEN: 'Not seen',
};

/**
 * The three buckets the desk manager asked for by name, under the rule that
 * decides them.
 *
 * `history` is NOT "retired". On an eighteen-day book it means "no account in
 * scope carried it inside this period", and three of the algorithms it holds
 * are sitting enabled on account types this population excludes. The label and
 * the tooltip both say the rule rather than the conclusion.
 */
const BUCKETS = {
  ALIVE: 'alive',
  RECENT: 'recent',
  HISTORY: 'history',
};

function day(value) {
  return String(value || '').slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function accountKeyOf(client, accountName) {
  return `${client?.id ?? client?.name ?? ''}::${String(accountName || '').toLowerCase()}`;
}

function registryOf(client) {
  const out = {};
  for (const [name, meta] of Object.entries(client?.accountRegistry || {})) {
    out[name.toLowerCase()] = meta;
  }
  return out;
}

/**
 * The population every section except the stack table measures over: accounts
 * the desk has not shelved.
 *
 * Wider than `isFundedPopulation`, which the stack table uses, and the two
 * labels say so on screen. Narrower than "every row in the export", because an
 * account marked Inactive / Ignore is one the desk has told the CRM to stop
 * counting and counting it here would put it back into a denominator it was
 * removed from everywhere else.
 */
function inReportPopulation(meta, accountName) {
  return segmentForAccount(meta, accountName) !== SEGMENTS.IGNORED;
}

/** `URGO 4.5` -> `{ family: 'URGO', version: '4.5' }`. `Bullet Bot 1.1` too. */
export function splitElement(element) {
  const text = String(element || '').trim();
  const cut = text.lastIndexOf(' ');
  if (cut < 0) return { family: text, version: '' };
  const version = text.slice(cut + 1);
  // A version is a dotted number. Anything else is part of the family's name,
  // which is why this splits on the LAST space and then checks what it found:
  // `Bullet Bot 1.1` is one family and one version, `Bullet Bot` is one family.
  if (!/^\d[\d.]*$/.test(version)) return { family: text, version: '' };
  return { family: text.slice(0, cut), version };
}

/* ------------------------------------------------------------------ */
/* 1. Coverage: the denominator of everything after it.                */

function buildCoverage(clients, period) {
  const byDate = new Map();
  const clientsInPeriod = new Set();
  const accountsInPeriod = new Set();
  let accountCloses = 0;
  let lateCloses = 0;
  let afterPeriodCloses = 0;

  for (const client of clients || []) {
    const registry = registryOf(client);
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date || date < period.from || date > period.to) continue;
      const seen = byDate.get(date) || {
        date,
        clients: new Set(),
        accounts: new Set(),
        accountRows: 0,
        accountDaysWithPnl: 0,
        lateImports: 0,
        importsOnDate: 0,
        afterPeriod: 0,
      };
      seen.clients.add(client?.id ?? client?.name ?? '');
      clientsInPeriod.add(client?.id ?? client?.name ?? '');
      seen.importsOnDate += 1;
      const importedDay = day(dailyImport?.importedAt);
      // "Arrived late" is the import landing on a LATER calendar date than the
      // trading date it describes. A timestamp earlier than its trading date —
      // this book has one — is not late and is not counted as early either; it
      // is simply not this figure's subject.
      if (importedDay && importedDay > date) {
        seen.lateImports += 1;
        lateCloses += 1;
        if (importedDay > period.to) {
          seen.afterPeriod += 1;
          afterPeriodCloses += 1;
        }
      }
      for (const snapshot of dailyImport?.snapshots || []) {
        const name = snapshot?.accountName || '';
        if (!inReportPopulation(registry[name.toLowerCase()], name)) continue;
        const key = accountKeyOf(client, name);
        seen.accounts.add(key);
        accountsInPeriod.add(key);
        seen.accountRows += 1;
        accountCloses += 1;
        if (Number(snapshot?.grossRealizedPnl || 0) !== 0) seen.accountDaysWithPnl += 1;
      }
      byDate.set(date, seen);
    }
  }

  const measured = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fullest = measured.reduce(
    (best, row) => (!best || row.accountRows > best.accountRows ? row : best), null,
  );
  const thinnest = measured.reduce(
    (worst, row) => (!worst || row.accountRows < worst.accountRows ? row : worst), null,
  );

  const rows = measured.map((row) => ({
    date: row.date,
    noClose: false,
    clientsReporting: row.clients.size,
    accountsReporting: row.accountRows,
    accounts: row.accounts.size,
    shareOfFullest: fullest && fullest.accountRows
      ? Math.round((row.accountRows / fullest.accountRows) * 100)
      : null,
    accountDaysWithPnl: row.accountDaysWithPnl,
    arrivedLate: row.lateImports,
    closes: row.importsOnDate,
  }));

  // A weekday inside the period with no close is a ROW, with the word `No
  // close` across it. It is not a zero: nobody reported, which is a different
  // claim from "the desk made nothing", and the two have been confused on this
  // codebase's charts before.
  //
  // Three different reasons, named on the row. A weekday before the book's
  // first close or after its last is a fact about where the export begins and
  // ends; only a weekday inside that range is a close somebody owed and did not
  // file. `resolvePeriod` draws the same line for `partialReasons`.
  const beforeBook = new Set(period.weekdaysBeforeBook || []);
  const afterBook = new Set(period.weekdaysAfterBook || []);
  // Weekdays with no close IN SCOPE, not in the book. On a CAM's copy the
  // report's coverage is that CAM's, and a weekday the desk filed and this CAM
  // did not is a gap in this table whatever the desk did.
  const measuredDates = new Set(measured.map((row) => row.date));
  const weekdaysWithoutClose = (period.weekdayDates || [])
    .filter((date) => !measuredDates.has(date));
  for (const date of weekdaysWithoutClose) {
    rows.push({
      date,
      noClose: true,
      noCloseReason: beforeBook.has(date)
        ? `Before the book's first close (${period.bookFirstClose}).`
        : (afterBook.has(date)
          ? `After the book's newest close (${period.bookLastClose}).`
          : 'Inside the book’s range and no close was filed.'),
      beforeBook: beforeBook.has(date),
      afterBook: afterBook.has(date),
      clientsReporting: null,
      accountsReporting: null,
      accounts: null,
      shareOfFullest: null,
      accountDaysWithPnl: null,
      arrivedLate: null,
      closes: 0,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const quiet = buildQuietAccounts(clients, { asOf: period.to });
  const filedNothing = (quiet.collection?.filedNothing || [])
    .filter((entry) => entry.date >= period.from && entry.date <= period.to);
  // One entry per (client, close), so the count of entries is a count of client
  // closes and not of clients. A client quiet on two closes is one client.
  const filedNothingClients = new Set(filedNothing.map((entry) => entry.clientId)).size;

  // Accounts that reported earlier in the period and are absent from its last
  // close. Absence, not status: `accountLifecycle` finds accounts the desk has
  // written off that are still trading and accounts still marked live that
  // stopped filing weeks ago, so the registry cannot answer this.
  const lastClose = period.closes[period.closes.length - 1] || '';
  const onLastClose = new Set();
  const seenEarlier = new Set();
  for (const client of clients || []) {
    const registry = registryOf(client);
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date || date < period.from || date > period.to) continue;
      for (const snapshot of dailyImport?.snapshots || []) {
        const name = snapshot?.accountName || '';
        if (!inReportPopulation(registry[name.toLowerCase()], name)) continue;
        const key = accountKeyOf(client, name);
        if (date === lastClose) onLastClose.add(key);
        else seenEarlier.add(key);
      }
    }
  }
  const stoppedFiling = [...seenEarlier].filter((key) => !onLastClose.has(key));

  const ratio = thinnest && thinnest.accountRows
    ? round2(fullest.accountRows / thinnest.accountRows)
    : null;

  // THE HEADER SENTENCE'S NUMERATOR AND DENOMINATOR, FROM ONE SET.
  //
  // "6 closes of 5 weekdays" is what the header printed for Week of 2026-07-20,
  // because 2026-07-25 is a Saturday close: the numerator counted every close
  // and the denominator counted Monday to Friday. Split here, once, and both
  // the sheet and the pasted summary read this.
  const weekendCloseDates = measured.map((row) => row.date).filter((date) => !isWeekday(date));
  const weekdayCloseDates = measured.map((row) => row.date).filter(isWeekday);
  const closesSentence = `${weekdayCloseDates.length} of ${period.weekdays} weekday`
    + `${period.weekdays === 1 ? '' : 's'} hold${weekdayCloseDates.length === 1 ? 's' : ''} a close`
    + (weekendCloseDates.length
      ? `, plus ${weekendCloseDates.length} weekend close`
        + `${weekendCloseDates.length === 1 ? '' : 's'} (${weekendCloseDates.join(', ')})`
      : '');

  return {
    rows,
    totals: {
      closesInPeriod: measured.length,
      weekdaysInPeriod: period.weekdays,
      // The header sentence divides closes by weekdays, so the weekend closes
      // have to be visible or the numerator and the denominator come from
      // different sets: Week of 2026-07-20 holds six closes over five weekdays
      // because 2026-07-25 is a Saturday. `resolvePeriod` computes these with a
      // comment naming that exact trap; here is where they are published.
      weekendCloses: weekendCloseDates.length,
      weekendCloseDates,
      weekdayCloses: weekdayCloseDates.length,
      weekdaysWithAClose: weekdayCloseDates.length,
      weekdaysWithNoClose: weekdaysWithoutClose.length,
      missingWeekdays: weekdaysWithoutClose.filter(
        (date) => !beforeBook.has(date) && !afterBook.has(date),
      ),
      weekdaysBeforeBook: weekdaysWithoutClose.filter((date) => beforeBook.has(date)),
      weekdaysAfterBook: weekdaysWithoutClose.filter((date) => afterBook.has(date)),
      // One sentence, used verbatim by the sheet header, the "What this period
      // holds" table and the pasted summary. Three copies of this arithmetic is
      // how the three disagree.
      closesSentence,
      clientsReporting: clientsInPeriod.size,
      accountsReporting: accountsInPeriod.size,
      accountCloses,
      fullestClose: fullest ? { date: fullest.date, accounts: fullest.accountRows, clients: fullest.clients.size } : null,
      thinnestClose: thinnest ? { date: thinnest.date, accounts: thinnest.accountRows, clients: thinnest.clients.size } : null,
      coverageRatio: ratio,
      // Two counts, because the entries are (client, close) pairs. Printing the
      // entry count under a row label reading "clients" made two quiet closes of
      // one client read as two clients.
      clientsThatFiledNothing: filedNothingClients,
      clientClosesThatFiledNothing: filedNothing.length,
      filedNothing,
      accountsThatStoppedFiling: stoppedFiling.length,
      // Absence from the period's last close. Reported with that close's own
      // coverage beside it, because on a period whose last close is thin this
      // figure is mostly a fact about that close: `buildRoster` carries the
      // same caveat for the same reason.
      stoppedFilingNote: 'Accounts that reported earlier in this period and are absent from '
        + `${lastClose || 'its last close'}. Absence, not account status: the registry dates `
        + 'nothing this can be read off.',
      closesThatArrivedLate: lateCloses,
      closesThatArrivedAfterThePeriod: afterPeriodCloses,
      lastClose,
    },
    // The sentence under the table, with this period's own numbers in it, so
    // the caveat cannot drift from the coverage that produced it.
    // A ZERO-ROW CLOSE HAS NO FACTOR, AND THE SENTENCE MUST NOT PRINT ONE.
    // `ratio` is null when the thinnest close in the period carries no account
    // row at all, which is ordinary under a per-close login: the close is in
    // the book, this session simply did not fetch it. The sentence interpolated
    // that null and read "a factor of null" on screen. It says the shape it can
    // actually support instead.
    sentence: fullest && thinnest
      ? `Coverage inside this period runs from ${thinnest.accountRows} to ${fullest.accountRows} `
        + `account rows per close${ratio === null
          ? `, and ${thinnest.date} carries none at all, so there is no factor between them`
          : `, a factor of ${ratio}`}. ${PERIOD_DOLLAR_REFUSAL}`
      : PERIOD_DOLLAR_REFUSAL,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Money, per business, never added.                                */

/**
 * `summaries` IS NOT OPTIONAL FURNITURE ON THIS FUNCTION.
 *
 * deskMoney is the one desk answer, and it reads stored close summaries for the
 * closes a session did not load row by row. These three calls omitted them, so
 * the same book produced two answers on one screen: over 2026-07 the manager's
 * month tile read other prop -$166,205.23 over 1,156 account closes while this
 * report read -$42,200.94 over 161, both labelled "Every close from 2026-07-01
 * to 2026-07-31". Worse than the headline, the per-account-close RATE the
 * `change` column subtracts moved with it, so the column compared a rate from
 * one population against a rate from another.
 */
function buildMoney(clients, period, summaries) {
  const desk = buildDeskMoneyForRange(clients, { from: period.from, to: period.to, summaries });
  const prior = period.priorEmpty
    ? null
    : buildDeskMoneyForRange(clients, { from: period.priorFrom, to: period.priorTo, summaries });

  const priorByKey = new Map((prior?.rows || []).map((row) => [row.key, row]));
  const rows = desk.rows.map((row) => {
    const before = priorByKey.get(row.key) || null;
    const perClose = row.accounts ? round2(row.dailyPnl / row.accounts) : null;
    const priorPerClose = before && before.accounts
      ? round2(before.dailyPnl / before.accounts)
      : null;
    const thin = !before
      || row.accounts < MIN_CLOSES_FOR_MONEY_CHANGE
      || before.accounts < MIN_CLOSES_FOR_MONEY_CHANGE;
    return {
      ...row,
      perAccountClose: perClose,
      priorAccountCloses: before ? before.accounts : null,
      priorPerAccountClose: priorPerClose,
      change: thin || perClose === null || priorPerClose === null
        ? null
        : round2(perClose - priorPerClose),
      changeRefusal: !before
        ? `The period before holds no close.`
        : (thin
          ? `Withheld: ${row.accounts} account close${row.accounts === 1 ? '' : 's'} in this `
            + `period and ${before.accounts} in ${period.priorLabel}, and this report will not `
            + `subtract two means under ${MIN_CLOSES_FOR_MONEY_CHANGE} account closes on either `
            + 'side. At that size a difference is one account’s day.'
          : null),
    };
  });

  // One strip per business per close, as a rate. Never one chart with four
  // series: a cash dollar and a prop dollar are not the same quantity and a
  // shared axis invites reading one against the other.
  const columns = deskBusinessColumns();
  const byClose = period.closes.map((date) => {
    const one = buildDeskMoneyForRange(clients, { from: date, to: date, summaries });
    return {
      date,
      businesses: DESK_BUSINESS_ORDER.map((key) => {
        const row = one.rows.find((entry) => entry.key === key);
        const accounts = row?.accounts || 0;
        return {
          key,
          shortLabel: columns.find((column) => column.key === key)?.shortLabel || key,
          accountCloses: accounts,
          perAccountClose: accounts ? round2((row?.dailyPnl || 0) / accounts) : null,
        };
      }),
    };
  });

  return {
    desk,
    prior,
    rows,
    byClose,
    rowsDoNotSum: desk.rowsDoNotSum,
    minClosesForChange: MIN_CLOSES_FOR_MONEY_CHANGE,
  };
}

/* ------------------------------------------------------------------ */
/* 3. The roster: what is running, what started, what stopped, what is */
/*    not here any more.                                               */

/**
 * The close the roster decides Running and Stopped on.
 *
 * NOT "whichever date sorts last", and that is the whole point. On this book the
 * week of 2026-07-20 ends on a Saturday close carrying one client and 7 account
 * rows against the 338 of the week's fullest close. Deciding the states on it
 * printed `Stopped` against twelve algorithms, Bullet Bot among them after 212
 * account days that week, while the Results section four rows below ranked five
 * of the twelve. A prose caveat under the heading does not stop a column headed
 * State from reading "Stopped".
 *
 * The rule: the LAST close in the period that carries at least half the account
 * rows of the period's fullest close. Half, because the question the column
 * answers is "is this still running on the desk", and a close carrying less than
 * half the desk cannot answer it either way. When no close clears the bar — a
 * period of nothing but thin closes — the fullest close decides, because a
 * measurement on the best evidence the period holds beats one on the worst.
 *
 * The deciding date is published, printed in the column header and in the note,
 * and `lastClose` stays on the object for the coverage section, which is asking
 * a different question about a different date.
 */
export const STATE_CLOSE_SHARE = 0.5;

function decideStateClose(period, coverage) {
  const closes = period.closes || [];
  const lastClose = closes[closes.length - 1] || '';
  const fullest = coverage?.totals?.fullestClose || null;
  const accountsByDate = new Map(
    (coverage?.rows || []).filter((row) => !row.noClose).map((row) => [row.date, row.accountsReporting]),
  );
  const floor = fullest && fullest.accounts ? fullest.accounts * STATE_CLOSE_SHARE : 0;
  let chosen = '';
  for (const date of closes) {
    if ((accountsByDate.get(date) || 0) >= floor) chosen = date;
  }
  // Reachable only when the period holds no measured close at all: the fullest
  // close always clears half of itself, so any period with a close has one.
  const noCloseClears = !chosen;
  if (noCloseClears) chosen = fullest?.date || lastClose;
  const accounts = accountsByDate.get(chosen) ?? null;
  const share = accounts !== null && fullest && fullest.accounts
    ? Math.round((accounts / fullest.accounts) * 100)
    : null;
  return {
    stateClose: chosen,
    lastClose,
    stateCloseAccounts: accounts,
    stateCloseShareOfFullest: share,
    stateCloseIsLastClose: chosen === lastClose,
    stateCloseFellBackToFullest: noCloseClears,
  };
}

function buildRoster(clients, period, coverage) {
  const all = new Map();
  const chosen = decideStateClose(period, coverage);
  const { stateClose, lastClose } = chosen;
  // "New in period" is only a fact when the book holds history BEFORE the
  // period to be new against. A period that starts on the book's first close
  // makes every algorithm's first appearance fall inside it, and marking them
  // all New would report where the export begins as a decision the desk took.
  // 115 of this book's 180 funded accounts first appear on its first close for
  // exactly the same reason.
  const newMeasurable = Boolean(period.bookFirstClose) && period.from > period.bookFirstClose;

  for (const client of clients || []) {
    const registry = registryOf(client);
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date) continue;
      const inPeriod = date >= period.from && date <= period.to;
      for (const snapshot of dailyImport?.snapshots || []) {
        const name = snapshot?.accountName || '';
        const meta = registry[name.toLowerCase()];
        if (!inReportPopulation(meta, name)) continue;
        const { elements } = comboKeyFromDay(
          snapshot,
          executionsForAccount(dailyImport, name),
          { basis: 'traded', level: 'version' },
        );
        if (!elements.length) continue;
        const accountKey = accountKeyOf(client, name);
        for (const element of elements) {
          if (element === UNKNOWN_KEY) continue;
          const held = all.get(element) || {
            element,
            ...splitElement(element),
            firstSeen: date,
            lastSeen: date,
            accountsInPeriod: new Set(),
            accountDaysInPeriod: 0,
            closesPresent: new Set(),
            accountsByClose: new Map(),
            accountsOnStateClose: new Set(),
            instruments: new Map(),
            bookAccountDays: 0,
          };
          if (date < held.firstSeen) held.firstSeen = date;
          if (date > held.lastSeen) held.lastSeen = date;
          held.bookAccountDays += 1;
          if (inPeriod) {
            held.accountsInPeriod.add(accountKey);
            held.accountDaysInPeriod += 1;
            held.closesPresent.add(date);
            const onDate = held.accountsByClose.get(date) || new Set();
            onDate.add(accountKey);
            held.accountsByClose.set(date, onDate);
            if (date === stateClose) held.accountsOnStateClose.add(accountKey);
            for (const strategy of snapshot?.strategies || []) {
              const family = strategy?.strategyFamily || '';
              const instrument = String(strategy?.instrument || '').trim();
              if (!instrument) continue;
              if (family && family !== held.family) continue;
              // The contract ROOT, not the contract month. `MNQ SEP26`,
              // `MNQ 09-26` and `MNQU6` are three spellings of one instrument in
              // this book's own exports, and a column that listed all three
              // would report a naming convention as a trading decision — and
              // would never join to the benchmark, whose files are keyed MNQ.
              const root = instrumentRoot(instrument) || instrument;
              held.instruments.set(root, (held.instruments.get(root) || 0) + 1);
            }
          }
          all.set(element, held);
        }
      }
    }
  }

  const rows = [...all.values()].map((entry) => {
    const inPeriod = entry.accountDaysInPeriod > 0;
    const onLast = entry.accountsOnStateClose.size > 0;
    const isNew = newMeasurable
      && entry.firstSeen >= period.from
      && entry.firstSeen <= period.to;
    let state = ROSTER_STATES.NOT_SEEN;
    let bucket = BUCKETS.HISTORY;
    if (onLast) {
      state = isNew ? ROSTER_STATES.NEW_RUNNING : ROSTER_STATES.RUNNING;
      bucket = BUCKETS.ALIVE;
    } else if (inPeriod) {
      state = isNew ? ROSTER_STATES.NEW : ROSTER_STATES.STOPPED;
      bucket = BUCKETS.RECENT;
    }
    return {
      algorithm: entry.element,
      family: entry.family,
      version: entry.version,
      state,
      bucket,
      isNew,
      accountsOnStateClose: entry.accountsOnStateClose.size,
      accountsInPeriod: entry.accountsInPeriod.size,
      accountDaysInPeriod: entry.accountDaysInPeriod,
      closesPresent: entry.closesPresent.size,
      closesPresentDates: [...entry.closesPresent].sort(),
      // Accounts carrying it on each close, which is what the deployment grid
      // shades by. Shaded against this algorithm's OWN busiest close, never
      // against another algorithm's, so intensity reads as its own deployment.
      accountsByClose: Object.fromEntries(
        [...entry.accountsByClose.entries()].map(([date, set]) => [date, set.size]),
      ),
      busiestClose: Math.max(
        0,
        ...[...entry.accountsByClose.values()].map((set) => set.size),
      ),
      closesInPeriod: period.closes.length,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      instruments: [...entry.instruments.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, accountDays]) => ({ name, accountDays })),
      bookAccountDays: entry.bookAccountDays,
    };
  });

  const order = {
    [ROSTER_STATES.RUNNING]: 0,
    [ROSTER_STATES.NEW_RUNNING]: 0,
    [ROSTER_STATES.NEW]: 1,
    [ROSTER_STATES.STOPPED]: 2,
    [ROSTER_STATES.NOT_SEEN]: 3,
  };
  rows.sort((a, b) => order[a.state] - order[b.state]
    || b.accountDaysInPeriod - a.accountDaysInPeriod
    || a.algorithm.localeCompare(b.algorithm));

  const count = (bucket) => rows.filter((row) => row.bucket === bucket).length;

  // WHICH CLOSE DECIDED, AND HOW MUCH OF THE DESK IT HELD.
  //
  // Published beside the states rather than left in a tooltip: the deciding date
  // is part of the measurement, the same way a window is, and it is printed in
  // the column header, in the note and in the pasted summary.
  const lastRow = (coverage?.rows || []).find((row) => row.date === lastClose) || null;
  const fullest = coverage?.totals?.fullestClose || null;
  const lastShare = lastRow && fullest && fullest.accounts
    ? Math.round((lastRow.accountsReporting / fullest.accounts) * 100)
    : null;
  const thinLastClose = lastShare !== null && lastShare < 50;

  return {
    rows,
    ...chosen,
    lastCloseAccounts: lastRow ? lastRow.accountsReporting : null,
    lastCloseShareOfFullest: lastShare,
    stateCloseShare: STATE_CLOSE_SHARE,
    thinLastClose,
    // Only when the period's last close is NOT the one that decided. The
    // sentence says which date was used instead and why, so a reader who
    // expected the last close is told where the states came from.
    thinLastCloseNote: chosen.stateCloseIsLastClose
      ? null
      : `Running and Stopped are decided on ${stateClose}, not on ${lastClose}. `
        + `${lastClose} is the last close inside this period and it carried `
        + `${lastRow ? lastRow.accountsReporting : 0} account row`
        + `${lastRow && lastRow.accountsReporting === 1 ? '' : 's'}, `
        + `${lastShare === null ? 'an unmeasured share' : `${lastShare}%`} of the `
        + `${fullest ? fullest.accounts : 0} on ${fullest ? fullest.date : 'the fullest close'}. `
        + `${stateClose} is the last close in this period carrying at least half of that, `
        + `${chosen.stateCloseAccounts ?? 0} account row`
        + `${chosen.stateCloseAccounts === 1 ? '' : 's'}. An algorithm absent from a close that `
        + 'thin is absent from a small slice of the desk, not from the desk.',
    counts: {
      total: rows.length,
      running: rows.filter((row) => row.bucket === BUCKETS.ALIVE).length,
      new: rows.filter((row) => row.isNew).length,
      stopped: rows.filter((row) => row.state === ROSTER_STATES.STOPPED).length,
      notSeen: rows.filter((row) => row.state === ROSTER_STATES.NOT_SEEN).length,
      alive: count(BUCKETS.ALIVE),
      recent: count(BUCKETS.RECENT),
      history: count(BUCKETS.HISTORY),
    },
    newMeasurable,
    newRefusal: newMeasurable
      ? null
      : 'No algorithm is marked New in this period: the period starts on or before the book’s '
        + `first close (${period.bookFirstClose}), so every algorithm’s first appearance falls `
        + 'inside it and "new" would mean "the export begins here".',
    stateNote: `Running is decided on ${stateClose || 'the last close inside this period'}`
      + `${chosen.stateCloseIsLastClose
        ? ', the last close inside this period.'
        : ', the last close inside this period carrying at least half the account rows of its '
          + 'fullest close.'}`
      + ' Not seen means no account in this population carried it inside this period. It does not '
      + 'mean retired, and on a book this short an algorithm can be absent here and enabled on an '
      + 'account type this population excludes.',
    populationNote: 'Every account not marked Inactive / Ignore, which is wider than the funded '
      + 'population the stack table below measures.',
  };
}

/* ------------------------------------------------------------------ */
/* 4. Results, movement: three windows of one function.                */

function rankingIndex(ranking) {
  return new Map((ranking?.ranking?.rows || []).map((row) => [row.name, row]));
}

function readingFor(recent, prior, change, refusal) {
  if (change === null) return refusal || 'No comparison is made.';
  const band = CHANGE_BAND * Math.abs(prior);
  if (change > band) return 'Moved up';
  if (change < -band) return 'Moved down';
  return 'No change shown';
}

function buildMovement(periodRanking, priorRanking, bookRanking, period) {
  const inPeriod = rankingIndex(periodRanking);
  const inPrior = rankingIndex(priorRanking);
  const inBook = rankingIndex(bookRanking);
  // THE BOOK TO DATE IS SOMETIMES THIS PERIOD, EXACTLY.
  //
  // `bookRanking` runs from the book's first close to the period's last day. On
  // a month that starts on or before the book's first close those are the same
  // closes, so every difference is 0 by construction and a column of eight
  // $0.00 cells reads as a finding about the desk. Withheld with the reason,
  // the way every other comparison here is withheld.
  const bookIsThisPeriod = Boolean(period.bookFirstClose) && period.from <= period.bookFirstClose;
  const bookSameRefusal = `Withheld: this period holds every close the book has up to ${period.to}, `
    + 'so the book to date is this same measurement over these same days.';

  const names = [...new Set([...inPeriod.keys(), ...inBook.keys()])];
  const rows = names.map((name) => {
    const here = inPeriod.get(name) || null;
    const before = inPrior.get(name) || null;
    const book = inBook.get(name) || null;
    const gated = (row) => Boolean(row && row.sufficient);
    const bothWindows = gated(here) && gated(before);
    const bookComparable = !bookIsThisPeriod && gated(here) && gated(book);
    const change = bothWindows
      ? round2(here.meanPerAccountDay - before.meanPerAccountDay)
      : null;
    const priorRefusal = !before
      ? `${period.priorLabel} measured nothing for this algorithm.`
      : (before.sufficient ? null : before.rankRefusal);
    const changeRefusal = bothWindows
      ? null
      : (period.priorEmpty
        ? 'The period before holds no close.'
        : (!before
          ? `Withheld: ${period.priorLabel} measured nothing for this algorithm.`
          // Compact on purpose: this sentence sits in a cell of a seven-column
          // table, and the long form stacked one word per line and made an
          // ungated row six times the height of a gated one, which reads as
          // emphasis on the rows carrying the least evidence.
          : `Withheld: ${here ? here.accountDays : 0} account-days over `
            + `${here ? here.accounts : 0} accounts here, ${before.accountDays} over `
            + `${before.accounts} then. The gate is ${EVIDENCE_GATE.minAccountDays} and `
            + `${EVIDENCE_GATE.minAccounts}.`));
    return {
      algorithm: name,
      periodMean: here ? here.meanPerAccountDay : null,
      periodAccountDays: here ? here.accountDays : 0,
      periodAccounts: here ? here.accounts : 0,
      periodGated: gated(here),
      periodRefusal: here ? here.rankRefusal : 'This algorithm ran on no account day in this period.',
      priorMean: before ? before.meanPerAccountDay : null,
      priorAccountDays: before ? before.accountDays : 0,
      priorAccounts: before ? before.accounts : 0,
      priorGated: gated(before),
      priorRefusal,
      change,
      changeRefusal,
      bookMean: book ? book.meanPerAccountDay : null,
      bookAccountDays: book ? book.accountDays : 0,
      bookAccounts: book ? book.accounts : 0,
      againstBook: bookComparable && here && book
        ? round2(here.meanPerAccountDay - book.meanPerAccountDay)
        : null,
      againstBookRefusal: bookComparable
        ? null
        : (bookIsThisPeriod ? bookSameRefusal : 'Withheld under the same gate.'),
      reading: readingFor(
        here ? here.meanPerAccountDay : null,
        before ? before.meanPerAccountDay : 0,
        change,
        changeRefusal,
      ),
      // Both windows clear the gate: the only rows the slope chart may draw.
      drawable: bothWindows,
      crossedIntoLoss: bothWindows
        && before.meanPerAccountDay > 0
        && here.meanPerAccountDay < 0,
    };
  });

  rows.sort((a, b) => {
    if (a.drawable !== b.drawable) return a.drawable ? -1 : 1;
    return b.periodAccountDays - a.periodAccountDays || a.algorithm.localeCompare(b.algorithm);
  });

  return {
    rows,
    drawable: rows.filter((row) => row.drawable),
    notDrawable: rows.filter((row) => !row.drawable),
    bookIsThisPeriod,
    bookNote: bookIsThisPeriod
      ? `The book to date runs from its first close (${period.bookFirstClose}) to ${period.to}, `
        + 'which on this period is the very same set of closes. The column is withheld on every '
        + 'row rather than printed as a column of zeros.'
      : `The book to date runs from the book’s first close to ${period.to} and CONTAINS this `
        + 'period, so the two are not independent windows.',
    changeBand: CHANGE_BAND,
  };
}

/* ------------------------------------------------------------------ */
/* 5. The stack, and what changed on the accounts.                     */

function buildStack(clients, period) {
  const perf = buildComboPerformance(clients, {
    window: { from: period.from, to: period.to },
  });
  const priorPerf = period.priorEmpty
    ? null
    : buildComboPerformance(clients, {
      window: { from: period.priorFrom, to: period.priorTo },
    });

  const priorRank = new Map();
  if (priorPerf) {
    priorPerf.rows
      .filter((row) => !row.lowSample)
      .sort((a, b) => b.avgPnl - a.avgPnl)
      .forEach((row, index) => priorRank.set(row.key, index + 1));
  }

  const rows = perf.rows.map((row) => ({
    ...row,
    rankLastPeriod: priorRank.get(row.key) || null,
    rankLastPeriodRefusal: priorRank.has(row.key)
      ? null
      : (period.priorEmpty
        ? 'The period before holds no close.'
        : 'New: this combination has no gated row in the period before.'),
  }));

  const gated = rows.filter((row) => !row.lowSample);
  const population = perf.population;
  return {
    perf,
    priorPerf,
    rows,
    population,
    // WRITTEN HERE, NOT IN THE MARKUP, and every count in it names what it
    // counts. The version this replaces read "599 attributed of 896 funded
    // account days · 149 accounts · 44 clients" inside a sentence whose subject
    // was the funded population — but those two counts are of accounts and
    // clients that ATTRIBUTED, 31 accounts and 4 clients short of the
    // population the same sentence claimed to describe.
    populationNote: 'Funded accounts, failed ones included, over each account’s own alive range · '
      + `${population.includedDays} attributed of ${population.fundedDays} funded account days · `
      + `${population.accounts} of ${population.fundedAccounts} accounts · `
      + `${population.clients} of ${population.fundedClients} clients attributed · `
      + 'traded attribution at version level',
    gatedCount: gated.length,
    lowSampleCount: rows.length - gated.length,
    best: perf.best,
    bestNote: perf.best
      ? null
      : (gated.length ? NOTE_NO_POSITIVE : NOTE_NO_GATE),
    sampleGateNote: `A row is marked Low sample under ${MIN_DAYS} account days or under `
      + `${MIN_ACCOUNTS} accounts, and a Low sample row is never marked Best.`,
    rankNote: 'The two ranks are not a trend: a combination’s population changes between periods.',
    minDays: MIN_DAYS,
    minAccounts: MIN_ACCOUNTS,
  };
}

/**
 * Every close inside the period on which an account's combination differs from
 * the close before it.
 *
 * Attribution is the report's attribution — traded, at version level — so a
 * change here and a row in the stack table above are keyed the same way. The
 * close BEFORE the first close of the period counts as the previous close when
 * the account has one: a combination that changed over the weekend changed
 * inside the period the reader is looking at, and hiding it because its
 * predecessor is one day outside the bounds would be an artefact of the bounds.
 */
function buildComboChanges(clients, period) {
  const changes = [];
  for (const client of clients || []) {
    const registry = registryOf(client);
    const imports = [...(client?.dailyImports || [])]
      .filter((entry) => day(entry?.date))
      .sort((a, b) => day(a.date).localeCompare(day(b.date)));

    const byAccount = new Map();
    for (const dailyImport of imports) {
      const date = day(dailyImport.date);
      for (const snapshot of dailyImport.snapshots || []) {
        const name = snapshot?.accountName || '';
        const meta = registry[name.toLowerCase()];
        if (!inReportPopulation(meta, name)) continue;
        const key = name.toLowerCase();
        const held = byAccount.get(key) || { name, meta, byDate: new Map() };
        // ONE POINT PER TRADING DATE, latest import wins. A client that filed
        // two imports for one date would otherwise be diffed against its own
        // duplicate and print a combination change nobody made. `imports` is
        // sorted by date, so the last write for a date is the later import.
        held.byDate.set(date, {
          date,
          combo: comboKeyFromDay(
            snapshot,
            executionsForAccount(dailyImport, name),
            { basis: 'traded', level: 'version' },
          ).key,
          pnl: Number(snapshot?.grossRealizedPnl || 0),
        });
        byAccount.set(key, held);
      }
    }

    for (const account of byAccount.values()) {
      const points = [...account.byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      // Where every change on this account sits, so each one's two sides can be
      // bounded by its NEIGHBOURS rather than by the period.
      //
      // The boundaries are the DECISIONS only. A change to or from Unknown is
      // the export losing or regaining the algorithm's name, which this section
      // counts apart for exactly that reason, and letting one truncate the
      // evidence window of a real change would let a gap in the data decide how
      // much data a decision gets measured on. On this book the attribution
      // flickers often enough that bounding on every change left 0 of 239
      // monthly rows with five closes a side.
      const changeAt = [];
      const decisionAt = [];
      for (let index = 1; index < points.length; index += 1) {
        if (points[index].combo === points[index - 1].combo) continue;
        changeAt.push(index);
        if (points[index].combo !== UNKNOWN_KEY && points[index - 1].combo !== UNKNOWN_KEY) {
          decisionAt.push(index);
        }
      }
      for (let nth = 0; nth < changeAt.length; nth += 1) {
        const index = changeAt[nth];
        const here = points[index];
        const before = points[index - 1];
        if (here.date < period.from || here.date > period.to) continue;
        // THE TWO SIDES ARE THE TWO COMBINATIONS, NOT THE TWO HALVES OF A WEEK.
        //
        // Both bugs this replaces were the report's own class. Clipping the
        // sides to the period made "5 before and 5 after" arithmetically
        // impossible on a week (6 closes at most on this book), so the column
        // printed a refusal on every one of 103 rows; and running the after side
        // to the end of the period swept in days run on a THIRD combination on
        // 168 of the month's 239 rows, under a column labelled the P&L on each
        // side of this change.
        //
        // So: the before side runs from the previous change on this account (or
        // its first close) to the day before this one, the after side from this
        // change to the day before the next one (or the account's last close),
        // and neither is clipped by the period. The change is dated inside the
        // period; the evidence for it need not be, and the two bounds are
        // printed on the row.
        const previousIndex = decisionAt.filter((at) => at < index).pop() ?? 0;
        const nextIndex = decisionAt.find((at) => at > index) ?? points.length;
        const priorSide = points.slice(previousIndex, index);
        const after = points.slice(index, nextIndex);
        const mean = (list) => (list.length
          ? round2(list.reduce((sum, point) => sum + point.pnl, 0) / list.length)
          : null);
        // Five account days a side, the same floor `comboPerformance` uses to
        // split its trend halves. Under it the two figures are one account's
        // week against one account's other week.
        const comparable = priorSide.length >= 5 && after.length >= 5;
        // A change to or from `Unknown` is a change in what the export could
        // attribute, not a change somebody made to the account. Counted and
        // listed apart, because a table headed "the decisions" whose rows are
        // mostly evidence gaps is the same defect as a mislabelled column.
        const involvesUnknown = here.combo === UNKNOWN_KEY || before.combo === UNKNOWN_KEY;
        const nextChangeDate = nextIndex < points.length ? points[nextIndex].date : '';
        const sideFrom = priorSide[0]?.date || '';
        const sideTo = after[after.length - 1]?.date || '';
        changes.push({
          involvesUnknown,
          date: here.date,
          clientId: client?.id ?? client?.name ?? '',
          clientName: client?.name || '',
          accountName: account.name,
          accountAlias: account.meta?.alias || '',
          from: before.combo,
          to: here.combo,
          // Closes on the NEW combination only: the count stops at this
          // account's next change, whose date is on the row beside it.
          accountDaysSince: after.length,
          nextChangeDate,
          endsAtNextChange: Boolean(nextChangeDate),
          beforeDays: priorSide.length,
          afterDays: after.length,
          beforeFrom: sideFrom,
          beforeTo: before.date,
          afterFrom: here.date,
          afterTo: sideTo,
          outsidePeriod: Boolean(
            (sideFrom && sideFrom < period.from) || (sideTo && sideTo > period.to),
          ),
          // The two bounds, short enough to PRINT in the cell. The long form is
          // the cell's title; a title renders on no paper and on no touch
          // screen, and a window nobody can read is a window nobody checks.
          sidesWindowShort: `${sideFrom || '—'} to ${before.date} · ${here.date} to ${sideTo || '—'}`,
          sidesWindow: `${priorSide.length} close${priorSide.length === 1 ? '' : 's'} on `
            + `${before.combo} (${sideFrom || 'none'} to ${before.date}), `
            + `${after.length} on ${here.combo} (${here.date} to ${sideTo || 'none'}`
            + `${nextChangeDate ? `, cut at the next change on ${nextChangeDate}` : ''}). `
            + 'This account’s own closes, which may run outside this period.',
          perAccountDayBefore: comparable ? mean(priorSide) : null,
          perAccountDayAfter: comparable ? mean(after) : null,
          // The counts, short enough for a cell. The full sentence is the
          // cell's title and the gate is stated once under the table: the long
          // form printed in every cell made the widest column of a 103-row
          // table a wall of identical refusals.
          sidesCountsShort: `${priorSide.length} before / ${after.length} after, needs 5 each`,
          sidesRefusal: comparable
            ? null
            : `Withheld: ${priorSide.length} account day${priorSide.length === 1 ? '' : 's'} on `
              + `${before.combo} and ${after.length} on ${here.combo}, this account’s own closes `
              + 'either side of the change, and each side needs 5.',
        });
      }
    }
  }

  changes.sort((a, b) => b.date.localeCompare(a.date)
    || a.clientName.localeCompare(b.clientName)
    || a.accountName.localeCompare(b.accountName));
  return changes;
}

function summariseChanges(rows, period) {
  const decisions = rows.filter((row) => !row.involvesUnknown);
  const attribution = rows.filter((row) => row.involvesUnknown);
  const accountsOf = (list) => new Set(
    list.map((row) => `${row.clientId}::${row.accountName}`),
  ).size;
  return {
    rows: decisions,
    attributionGaps: attribution,
    counts: {
      total: rows.length,
      decisions: decisions.length,
      attributionGaps: attribution.length,
      // THE COUNT THE TABLE'S OWN SENTENCE DIVIDES BY. `accounts` counts every
      // account touched by any change including the attribution gaps, which are
      // explicitly not listed in the table; printing the decisions over THAT
      // read as "239 changes over 320 accounts" when the 239 rows below touch 91.
      decisionAccounts: accountsOf(decisions),
      attributionGapAccounts: accountsOf(attribution),
      accounts: accountsOf(rows),
      compared: decisions.filter((row) => row.perAccountDayBefore !== null).length,
    },
    attributionNote: `${attribution.length} further change${attribution.length === 1 ? '' : 's'} `
      + `in this period, over ${accountsOf(attribution)} account`
      + `${accountsOf(attribution) === 1 ? '' : 's'}, were to or from Unknown: the export stopped `
      + 'naming an algorithm, or started. They are a change in evidence, not a change somebody '
      + 'made, and they are counted here rather than listed above.',
    sidesGate: 5,
    // WHAT THE COLUMN ACTUALLY DELIVERED, said once, above a column that mostly
    // cannot deliver it. On this book an account changes combination often
    // enough that five of its own closes on one combination either side of a
    // decision is rare: 2 of 239 on 2026-07. That is a fact about the book, and
    // a sentence stating it is worth more than 237 identical refusals.
    sidesSummary: `${decisions.filter((row) => row.perAccountDayBefore !== null).length} of `
      + `${decisions.length} change${decisions.length === 1 ? '' : 's'} hold five of the `
      + 'account’s own closes on each side and print the two figures. The rest print their two '
      + 'counts and no figures. An account that changes combination every few closes has no run '
      + 'long enough to measure either side of a change, which is a fact about this desk’s '
      + 'configuration cadence and not about the algorithms.',
    sidesNote: 'Each side of a change is this account’s own closes between the change before it '
      + 'and the change after it, and each side needs 5 of them before the two figures are '
      + `printed. Those closes are not clipped to ${period.label}: the change is dated inside the `
      + 'period, the evidence for it need not be, and every row prints its own two bounds. Five is '
      + 'the floor comboPerformance already uses to split its trend halves, and it is not a new '
      + 'number.',
  };
}

/* ------------------------------------------------------------------ */
/* 6. The benchmark, measured separately and joined on identity only.  */

function buildBenchmark(roster, series, period, riskLevel) {
  const risk = BENCHMARK_RISK_LEVELS.includes(riskLevel) ? riskLevel : BENCHMARK_RISK_LEVELS[0];
  const list = Array.isArray(series) ? series : [];
  const coverage = buildBenchmarkCoverage(
    roster.rows.map((row) => ({
      element: row.algorithm,
      algorithm: row.family,
      version: row.version,
      instruments: row.instruments.map((entry) => entry.name),
      closesPresent: row.closesPresentDates,
      accountDays: row.accountDaysInPeriod,
      accounts: row.accountsInPeriod,
    })),
    list,
    { from: period.from, to: period.to, riskLevel: risk },
  );

  const atRisk = list.filter((entry) => entry.riskLevel === risk);
  const rows = atRisk.map((entry) => {
    const days = (entry.days || []).filter(
      (bucket) => bucket.date >= period.from && bucket.date <= period.to,
    );
    const net = round2(days.reduce((sum, bucket) => sum + bucket.net, 0));
    const trades = days.reduce((sum, bucket) => sum + bucket.trades, 0);
    return {
      key: entry.key,
      algorithm: entry.algorithm,
      version: entry.version,
      instrument: entry.instrument,
      riskLevel: entry.riskLevel,
      daysWithATrade: days.length,
      trades,
      // Named `netProfit` and never `pnl`: nothing in this report may add it to
      // a client figure, and the key is the first thing a future caller reads.
      netProfit: net,
      netPerDayWithATrade: days.length ? round2(net / days.length) : null,
      basis: entry.basis || benchmarkBasisLabel(entry),
      sourceFile: entry.sourceFile,
      sourceFiles: entry.sourceFiles || (entry.sourceFile ? [entry.sourceFile] : []),
      quantities: entry.quantities,
      // The vendor's own running total against ours, carried onto the row.
      // `buildBenchmarkSeries` merges two files describing the same series on
      // purpose, and the realistic re-download collides by name: parsing
      // `RBO_-_M2K_-_Low_Risk.csv` twice, once as `... (1).csv`, doubles the
      // trades and the net with nothing on screen to say so. The Data Tools
      // card already prints this; the report printed nothing.
      reconciliation: entry.reconciliation || null,
      reconciliationRefusal: entry.reconciliation && entry.reconciliation.matches === false
        ? `This series disagrees with the vendor’s own running total by `
          + `${entry.reconciliation.difference}. Its file${(entry.sourceFiles || []).length === 1 ? ' is' : 's are'} `
          + `${(entry.sourceFiles || [entry.sourceFile]).join(', ')}. Two downloads of one series `
          + 'merge into one, so the usual cause is the same file imported twice under two names, '
          + 'which doubles every figure on this row.'
        : null,
    };
  }).sort((a, b) => a.algorithm.localeCompare(b.algorithm));

  // One cumulative curve per series, over the calendar year the period ends in
  // and up to the period's last day. Its own plot, its own axis, never on the
  // same axes as anything else in this report.
  const year = period.to.slice(0, 4);
  const curves = atRisk.map((entry) => {
    let cumulative = 0;
    const points = (entry.days || [])
      .filter((bucket) => bucket.date >= `${year}-01-01` && bucket.date <= period.to)
      .map((bucket) => {
        cumulative = round2(cumulative + bucket.net);
        return { date: bucket.date, cumulative, net: bucket.net, trades: bucket.trades };
      });
    return {
      key: entry.key,
      algorithm: entry.algorithm,
      version: entry.version,
      instrument: entry.instrument,
      riskLevel: entry.riskLevel,
      basis: entry.basis || benchmarkBasisLabel(entry),
      points,
      from: points[0]?.date || '',
      to: points[points.length - 1]?.date || '',
    };
  }).filter((curve) => curve.points.length);

  return {
    riskLevel: risk,
    riskLevels: BENCHMARK_RISK_LEVELS,
    imported: list.length > 0,
    emptyReason: list.length
      ? null
      : 'No My Futures Book file has been imported. Import the CSVs from the desk’s portfolio page '
        + 'to fill this section.',
    coverage,
    rows,
    curves,
    // Series whose figures cannot be believed as they stand, named so the
    // section carries the refusal rather than the numbers alone.
    disagreeingSeries: rows.filter((row) => row.reconciliationRefusal),
    minCommonCloses: BENCHMARK_MIN_COMMON_CLOSES,
    separation: BENCHMARK_SEPARATION,
  };
}

/* ------------------------------------------------------------------ */
/* 6b. The answer, first, from the same fields the pasted line uses.   */

/**
 * The three questions the desk manager asked, answered above the denominators.
 *
 * WHY THIS EXISTS AT ALL. Coverage goes first on this page and that is still
 * the right call — every rate under it divides by a denominator that moves by a
 * factor of fifty between closes. But "coverage first" was implemented as "no
 * answer at all until section four": the reader met a 6-column, 31-row table of
 * closes, a chart and a 9-row totals table before a single verdict. The
 * arithmetic for the answer already existed and was reachable only through the
 * clipboard.
 *
 * SO IT IS ONE OBJECT AND BOTH SURFACES READ IT. The sheet renders this and
 * `formatDeskPeriodReport` prints this; neither computes anything of its own, so
 * the page and the pasted WhatsApp line cannot disagree about what the desk made
 * or which algorithm came first. Every figure here is a rate with its own
 * denominator beside it, and there is no total across businesses.
 */
function buildSummary({ period, scope, coverage, money, roster, results, stack, changes }) {
  const totals = coverage.totals;
  const ranked = results.rows.filter((row) => row.ranked);
  return {
    title: `Desk period report, ${period.label}`,
    periodLabel: period.label,
    dates: `${period.from} to ${period.to}`,
    closesSentence: totals.closesSentence,
    scopeLabel: scope.label,
    partial: period.partial,
    partialReasons: period.partialReasons,
    coverageLine: `${totals.accountCloses} account close`
      + `${totals.accountCloses === 1 ? '' : 's'} over ${totals.accountsReporting} account`
      + `${totals.accountsReporting === 1 ? '' : 's'} and ${totals.clientsReporting} client`
      + `${totals.clientsReporting === 1 ? '' : 's'}`,
    // Same refusal as `coverage.sentence`: with a zero-row close in the period
    // there is no factor, and printing "a factor of null" is worse than saying
    // there is none.
    coverageRange: totals.fullestClose && totals.thinnestClose
      ? `Fullest close ${totals.fullestClose.date} (${totals.fullestClose.accounts} account rows), `
        + `thinnest ${totals.thinnestClose.date} (${totals.thinnestClose.accounts})`
        + (totals.coverageRatio === null
          ? ', which carries none, so there is no factor between them'
          : `, a factor of ${totals.coverageRatio}`)
      : null,
    // Per business, per account close, with the count it divides by. Never
    // added: see `money.rowsDoNotSum`.
    money: money.rows.map((row) => ({
      key: row.key,
      label: row.label,
      shortLabel: row.shortLabel,
      perAccountClose: row.perAccountClose,
      accountCloses: row.accounts,
    })),
    moneyNote: money.rowsDoNotSum,
    ranked: ranked.map((row) => ({
      rank: row.rank,
      name: row.name,
      meanPerAccountDay: row.meanPerAccountDay,
      accountDays: row.accountDays,
      ranAccountDays: row.accountDays + (row.unmeasuredAccountDays || 0),
      accounts: row.accounts,
    })),
    rankedCount: results.rankedCount,
    rankableCount: results.rankedCount + results.unrankedCount,
    // The roster's answer to "which are alive right now", with the date that
    // decided it, because Running is a fact about one close.
    stateClose: roster.stateClose,
    running: roster.rows.filter((row) => row.bucket === BUCKETS.ALIVE).map((row) => row.algorithm),
    newInPeriod: roster.rows.filter((row) => row.isNew).map((row) => row.algorithm),
    stopped: roster.rows
      .filter((row) => row.state === ROSTER_STATES.STOPPED).map((row) => row.algorithm),
    changesLine: `${changes.counts.decisions} combination change`
      + `${changes.counts.decisions === 1 ? '' : 's'} over ${changes.counts.decisionAccounts} `
      + `account${changes.counts.decisionAccounts === 1 ? '' : 's'}`,
    noVerdictLine: `${results.unrankedCount} algorithm`
      + `${results.unrankedCount === 1 ? '' : 's'} and ${stack.lowSampleCount} combination`
      + `${stack.lowSampleCount === 1 ? '' : 's'} carry their counts and no verdict: too few `
      + 'account days or too few accounts in this period',
    measuredLine: `${results.measuredAccountDays} of ${results.ranAccountDays} account days that `
      + 'carried an algorithm state what it made; every rate below divides by the first number',
  };
}

/* ------------------------------------------------------------------ */
/* 7. The refusals, generated from the report's own counts.            */

export function periodReportRefusals(report) {
  const coverage = report?.coverage?.totals || {};
  const results = report?.results || {};
  const stack = report?.stack || {};
  const benchmark = report?.benchmark || {};
  const movement = report?.movement || {};
  const thin = coverage.thinnestClose?.accounts ?? 0;
  const full = coverage.fullestClose?.accounts ?? 0;
  const ranked = results.rankedCount ?? 0;
  const rankable = (results.rankedCount ?? 0) + (results.unrankedCount ?? 0);
  const gatedCombos = stack.gatedCount ?? 0;
  const allCombos = (stack.rows || []).length;
  const moneyRefusal = (results.rows || [])[0]?.moneyRefusal || null;

  return [
    {
      figure: 'One P&L for the desk over this period',
      value: 'not stated',
      reason: 'The four businesses are not added. A cash dollar is real client money and a prop '
        + 'dollar is movement against a plan size the firm simulates. Each business states its '
        + 'own, per account close, in the money section.',
    },
    {
      figure: 'A period against a period in dollars',
      value: 'not stated',
      reason: `Coverage inside this period runs from ${thin} to ${full} account rows per close. `
        + PERIOD_DOLLAR_REFUSAL,
    },
    ...(moneyRefusal ? [{
      figure: 'A dollar for any algorithm',
      value: 'not stated',
      reason: moneyRefusal,
    }] : []),
    ...((results.accountTypeRefusal) ? [{
      figure: 'A performance figure per account type',
      value: 'not stated',
      reason: results.accountTypeRefusal,
    }] : []),
    ...((results.programmes || []).map((programme) => ({
      figure: `A rank for ${programme.name}`,
      value: 'not ranked',
      reason: programme.rankRefusal,
    }))),
    {
      figure: 'A rank, a best combination, or a change where the evidence gate is not cleared',
      value: `${ranked} of ${rankable} algorithms, ${gatedCombos} of ${allCombos} combinations`,
      reason: `${ranked} of ${rankable} algorithms and ${gatedCombos} of ${allCombos} combinations `
        + 'cleared their gates in this period. The rest carry their counts and no verdict. Naming '
        + 'a best combination off one account day is the mistake the Stack Playbook was rebuilt '
        + 'to stop.',
    },
    {
      figure: 'A mean over every account day an algorithm ran on',
      value: results.measuredShare === null || results.measuredShare === undefined
        ? 'not stated'
        : `${results.measuredAccountDays} of ${results.ranAccountDays} account days measured`,
      reason: 'Every rate in the results and movement tables divides by REPORTED account days. '
        + `${results.ranAccountDays ?? 0} account days in this period carried an algorithm under `
        + `traded attribution and ${results.measuredAccountDays ?? 0} of them state what it made. `
        + 'The rest are on the row beside the mean and in no mean: a grid row the desk switched '
        + 'off reports realized 0 whether or not it traded, and counting that 0 would put hundreds '
        + 'of false flat days into the denominator of every algorithm.',
    },
    ...(movement.bookIsThisPeriod ? [{
      figure: 'This period against the book to date',
      value: 'not stated',
      reason: movement.bookNote,
    }] : []),
    ...((benchmark.disagreeingSeries || []).length ? [{
      figure: 'The backtest figures for '
        + `${benchmark.disagreeingSeries.map((row) => row.algorithm).join(', ')}`,
      value: 'not to be believed as printed',
      reason: benchmark.disagreeingSeries.map((row) => row.reconciliationRefusal).join(' '),
    }] : []),
    {
      figure: 'Any agreement between this desk and My Futures Book',
      value: 'not stated',
      reason: benchmark.coverage?.refusal
        || `No agreement figure is stated. A comparison of direction needs at least `
          + `${BENCHMARK_MIN_COMMON_CLOSES} closes held by both series.`,
    },
    {
      figure: 'A forecast, a projection, or a target',
      value: 'not stated',
      reason: 'Nothing in this report extrapolates. The income projection on the Stack Playbook '
        + 'is a typed assumption and is labelled there as one; it is not repeated here.',
    },
    {
      figure: 'A client name in any algorithm table',
      value: 'not shown',
      reason: 'The algorithm sections are about algorithms. Whose money it is belongs to the '
        + 'client’s own report and to the algorithm detail roster, where it is one client, one '
        + 'figure, not a client ranked against another.',
    },
    {
      figure: 'A league table of CAMs',
      value: 'not shown',
      reason: 'This report is not a performance review. Coverage is stated per close and per '
        + 'client, so a CAM who did not export is visible as a gap in the denominator, which is a '
        + 'fact about the data, not about the person.',
    },
    {
      figure: 'Targets crossed, payouts, time to funding and time to failure',
      value: 'not measurable',
      reason: 'The registry cannot date them: `date_funded` is set on 7 of 764 account rows and '
        + '`date_failed` on 2, and this book holds no payout event inside any period it covers. A '
        + 'zero here would be a measurement, and there is none.',
    },
  ];
}

const DEFINITIONS = [
  ['Account day', 'One account on one close. The same account is one account day per close it '
    + 'reported on, never one per calendar day. Owned by algorithmRanking.js and comboPerformance.js.'],
  ['Account close', 'The same unit on the money side: one account, one close. Owned by deskMoney.js.'],
  ['Traded attribution', 'An algorithm ran on an account day when the grid says it was enabled, or '
    + 'the fills name it, or the grid reports a non-zero realized on a row it had switched off. '
    + 'Every section of this report attributes this way: the roster, the results, the movement, '
    + 'the stack and the account changes. Owned by comboPerformance.js.'],
  ['Enabled-at-export attribution', 'The other rule, and the one this report does NOT use: an '
    + 'algorithm counts on an account day only when its Strategies grid checkbox was still ticked '
    + 'at the moment the CAM exported. An algorithm that hit its daily stop and switched itself '
    + 'off before the export vanishes, and with it the day it lost. It drops 64% of funded account '
    + 'days on this book and whether a day counts moves with the hour of the export. The '
    + 'Operations ranking panel still quotes it; nothing on this page does.'],
  ['Reported account day', 'An account day on which the algorithm ran AND something stated what it '
    + 'made: a figure derived from the fills, or a realized the grid reported. The mean, the '
    + 'interval, the win rate and the evidence gate all divide by this. A grid row switched off '
    + 'reads realized 0 whether or not it traded, so that 0 is not counted as a measurement.'],
  ['Measured P&L', 'Realized net of commission where the Strategies grid reported it, derived from '
    + 'the fills otherwise. Owned by algorithmRanking.js.'],
  ['Funded population', 'Accounts whose registry type is Funded, failed ones included, over each '
    + 'account’s own alive range. The stack table’s population. Owned by comboPerformance.js.'],
  ['Report population', 'Every account not marked Inactive / Ignore. Wider than the funded '
    + 'population, and used for coverage, the roster and the account changes.'],
  ['Alive range', 'An account’s first close to the later of its last close and the date it was '
    + 'marked Failed. What an account’s status is today says nothing about the days it traded.'],
  ['Evidence gate', `${EVIDENCE_GATE.minAccountDays} reported account days and `
    + `${EVIDENCE_GATE.minAccounts} accounts before an algorithm is given a rank. Owned by `
    + 'algorithmRanking.js.'],
  ['Sample gate', `${MIN_DAYS} account days and ${MIN_ACCOUNTS} accounts before a combination is `
    + 'gated, and a low-sample row is never marked Best. Owned by comboPerformance.js.'],
  ['Decided day', 'An account day whose measured P&L is not exactly zero. The denominator of a win '
    + 'rate and of nothing else.'],
  ['Flat day', 'An account day on which the algorithm ran and made exactly nothing. In the '
    + 'denominator of every rate per account day.'],
  ['Business', 'One of the desk’s four: Bullet Bot evaluations, other prop, cash, unclassified. '
    + 'Never added together. Owned by operationsSegments.js and deskMoney.js.'],
  ['Programme', 'An account type sold as a product rather than an algorithm. Counted, never '
    + 'ranked. Owned by algorithmProgrammes.js.'],
  ['Benchmark', 'A My Futures Book backtest of the version this desk runs today, re-run over '
    + 'history on one simulated account at one risk sizing. Not client money. Owned by '
    + 'algorithmBenchmark.js.'],
];

/* ------------------------------------------------------------------ */
/* 8. The report.                                                      */

export function buildDeskPeriodReport(clients = [], {
  period = null,
  kind = 'week',
  key = '',
  from = '',
  to = '',
  deskClients = null,
  scope = null,
  benchmarkSeries = [],
  benchmarkRisk = 'Low',
  // The stored per-close money, as indexCloseSummaries returns it. Handed
  // straight to deskMoney so this report and the manager's tiles read the same
  // closes; see buildMoney for what the two answers looked like without it.
  summaries = null,
  builtAt = '',
  builtBy = '',
} = {}) {
  const list = clients || [];
  // THE TWO POPULATIONS, AND WHICH SECTION EACH ONE ANSWERS.
  //
  // `list` is the clients the reader owns: their coverage, their money, their
  // accounts' configuration changes. `pooled` is the desk — every client the
  // report can see — and it is what the roster, the three rankings, the stack
  // and the benchmark are measured over.
  //
  // This is not a refinement. Without it a CAM's copy computed every one of
  // those sections over that CAM's eight clients and printed the sentence "The
  // roster, the results, the movement, the stack and the benchmark are desk
  // wide for everybody" underneath. Desk wide, 2026-07 ranks ARPD first at
  // -$3.57 per account day over 61 account days; over an eight-client book it
  // ranks URGO first at -$39.05 over 56, with two of nine algorithms clearing
  // the gate. Same column headers, same sentence. That is the exact defect this
  // branch exists to close, one level up from the ones it closed.
  //
  // With no desk list handed in, the two are the same list and the scope block
  // says `desk`.
  const pooled = deskClients && deskClients.length ? deskClients : list;
  const resolved = period || resolvePeriod(pooled, { kind, key, from, to });
  const book = bookCloses(pooled);
  const isCam = scope?.kind === 'cam';

  const scopeBlock = {
    kind: isCam ? 'cam' : 'desk',
    camProfileId: scope?.camProfileId || null,
    camName: scope?.camName || '',
    clientsInScope: list.length,
    deskClientCount: scope?.deskClientCount ?? pooled.length,
    // Whether the pooled sections really were pooled, computed rather than
    // asserted: a caller that forgets `deskClients` on a CAM shell must not be
    // able to print the desk-wide sentence over one CAM's book.
    pooledClientCount: pooled.length,
    pooledIsDeskWide: pooled !== list,
    label: isCam
      ? `Your book, ${list.length} of the desk’s ${scope?.deskClientCount ?? pooled.length} clients`
      : `Desk wide, ${list.length} client${list.length === 1 ? '' : 's'}`,
    // Which sections the scope actually narrows. Stated on the object rather
    // than only in the component: a CAM's coverage and money are their own
    // book, and the algorithm sections are the desk's, pooled — a ranking over
    // one CAM's eight clients under the same column header would be a different
    // measurement wearing the same label.
    scopedSections: isCam ? ['coverage', 'money', 'changes'] : [],
    pooledSections: isCam ? ['roster', 'results', 'movement', 'stack', 'benchmark'] : [],
    deskWideNote: isCam && pooled === list
      ? 'The roster, the results, the movement, the stack and the benchmark were computed over '
        + 'this book alone, because no desk-wide client list was handed to this report. They are '
        + 'NOT comparable with another CAM’s copy and they are not the desk’s figures.'
      : 'The roster, the results, the movement, the stack and the benchmark are desk wide for '
        + `everybody, measured over ${pooled.length} client${pooled.length === 1 ? '' : 's'}. A `
        + 'ranking computed over one CAM’s clients under the same column header would be a '
        + 'different measurement wearing the same label, and almost every row of it would fall '
        + 'under the evidence gate.',
  };

  const coverage = buildCoverage(list, resolved);
  const money = buildMoney(list, resolved, summaries);
  // The roster's own coverage, over the pooled book, so the close its states are
  // decided on is chosen against the desk's fullest close and not against this
  // CAM's. On the desk shell the two calls have the same argument.
  const pooledCoverage = pooled === list ? coverage : buildCoverage(pooled, resolved);
  const roster = buildRoster(pooled, resolved, pooledCoverage);

  // TRADED ATTRIBUTION, THE SAME AS EVERY OTHER SECTION OF THIS REPORT.
  //
  // `buildStrategyRanking` defaults to the export-time `enabled` flag, which is
  // what the Operations panel quotes and what `docs/stack-playbook-spec.md`
  // §2.1 documents as a blocker: it drops 64% of funded account-days, and the
  // dropped days are where the losses sit. The roster and the stack on this
  // same page already attribute on `traded`, so the two put different
  // measurements under one "Account days" header six rows apart — URGO 216
  // against 344 on 2026-07. Every ranking here now asks for the same basis the
  // rest of the page uses, and `results.attribution` prints it.
  const rankingOptions = { basis: 'traded' };
  const periodRanking = buildStrategyRanking(pooled, {
    ...rankingOptions,
    fromDate: resolved.from,
    asOfDate: resolved.to,
  });
  const priorRanking = resolved.priorEmpty ? null : buildStrategyRanking(pooled, {
    ...rankingOptions,
    fromDate: resolved.priorFrom,
    asOfDate: resolved.priorTo,
  });
  const bookRanking = buildStrategyRanking(pooled, {
    ...rankingOptions,
    asOfDate: resolved.to,
    windows: {
      recentFrom: resolved.from,
      recentTo: resolved.to,
      priorFrom: resolved.priorFrom,
      priorTo: resolved.priorTo,
      recentLabel: 'this period',
      priorLabel: 'the period before',
    },
  });

  // What the Results table's own denominator is, in account days rather than in
  // closes and clients. The ranking gates and ranks on REPORTED account days —
  // days something measured what the algorithm made — while the roster on the
  // same page counts every account day it ran on. Both numbers are on every row
  // now, so a reader can see that ARPD is ranked first on 61 of the 137 account
  // days it ran.
  const rankingAttribution = {
    rankedOn: 'reported account days',
    ranOn: 'account days the algorithm ran on, under the same traded attribution the roster uses',
    note: 'Two counts per row, and they are not the same unit. An algorithm runs on an account '
      + 'day when the grid says it was enabled, or the fills name it, or the grid reports a '
      + 'non-zero realized on a row it had switched off. It is MEASURED on that day only when '
      + 'something states what it made: a figure derived from the fills, or a realized the grid '
      + 'reported. The mean, the interval, the win rate and the evidence gate all divide by the '
      + 'measured count; the roster above counts every day it ran.',
  };
  const attributed = periodRanking.ranking.rows.reduce(
    (sum, row) => sum + row.accountDays, 0,
  );
  const ranOn = periodRanking.ranking.rows.reduce(
    (sum, row) => sum + row.accountDays + (row.unmeasuredAccountDays || 0), 0,
  );

  const results = {
    basis: periodRanking.basis,
    attribution: periodRanking.basis.attribution,
    attributionLabel: periodRanking.basis.attributionLabel,
    rows: periodRanking.ranking.rows,
    rankedCount: periodRanking.ranking.rankedCount,
    unrankedCount: periodRanking.ranking.unrankedCount,
    programmes: periodRanking.ranking.programmes,
    unitNote: periodRanking.ranking.unitNote,
    instrumentCaveat: periodRanking.ranking.instrumentCaveat,
    gate: periodRanking.gate,
    reconciliation: periodRanking.reconciliation,
    // Attributed against unmeasured account days per business: the row a client
    // asking "what did you leave out" is entitled to see, and where the gap
    // between running and measuring shows per business rather than per family.
    //
    // COUNTS ONLY. `buildStrategyRanking().businesses[].coverage` carries
    // `accountPnl`, `attributedPnl` and `unattributedPnl`, and those belong to
    // the money section, which states money per business under its own labels.
    // Copying them onto `results` would put a dollar on the object the ranking
    // lives on, which is the key the next caller sums — the defect
    // `finishStats` refuses money for in the first place.
    businesses: periodRanking.businesses.map((business) => ({
      key: business.key,
      label: business.label,
      shortLabel: business.shortLabel,
      note: business.note,
      measuredAccountDays: business.coverage.accountDays,
      unmeasuredAccountDays: business.coverage.unmeasuredAccountDays,
      ranAccountDays: business.coverage.accountDays + business.coverage.unmeasuredAccountDays,
    })),
    measuredAccountDays: attributed,
    ranAccountDays: ranOn,
    measuredShare: ranOn ? Math.round((attributed / ranOn) * 100) : null,
    accountDayNote: rankingAttribution.note,
    accountTypeRefusal: ACCOUNT_TYPE_REFUSAL,
    noRankNote: periodRanking.ranking.rankedCount === 0
      ? `No algorithm clears ${EVIDENCE_GATE.minAccountDays} reported account days and `
        + `${EVIDENCE_GATE.minAccounts} accounts in this period. Every row above carries its `
        + 'counts and no position.'
      : null,
  };

  const movement = buildMovement(periodRanking, priorRanking, bookRanking, resolved);
  const stack = buildStack(pooled, resolved);
  const changes = {
    ...summariseChanges(buildComboChanges(list, resolved), resolved),
    drift: buildConfigDrift(list, { asOfDate: resolved.to }),
    driftWindowNote: `Window: the last close inside this period, ${resolved.to}.`,
    note: 'A change is a fact with a date. This section carries no chart: a chart of it would be '
      + 'a chart of how busy the CAMs were.',
  };
  const benchmark = buildBenchmark(roster, benchmarkSeries, resolved, benchmarkRisk);

  const latestImportedAt = (() => {
    let latest = '';
    for (const client of list) {
      for (const dailyImport of client?.dailyImports || []) {
        const date = day(dailyImport?.date);
        if (!date || date < resolved.from || date > resolved.to) continue;
        const stamp = String(dailyImport?.importedAt || '');
        if (stamp && stamp > latest) latest = stamp;
      }
    }
    return latest || null;
  })();

  const report = {
    title: `Desk period report, ${resolved.label}`,
    period: resolved,
    scope: scopeBlock,
    stamp: {
      builtAt: builtAt || null,
      builtBy: builtBy || null,
      bookFirstClose: book.closes[0] || null,
      bookLastClose: book.latest || null,
      closesInPeriod: coverage.totals.closesInPeriod,
      accountCloses: coverage.totals.accountCloses,
      latestImportedAt,
      moduleVersions: {
        comboPerformance: 'traded/version',
        algorithmRanking: `traded/${periodRanking.basis.attribution}`,
        evidenceGate: `${EVIDENCE_GATE.minAccountDays}/${EVIDENCE_GATE.minAccounts}`,
        sampleGate: `${MIN_DAYS}/${MIN_ACCOUNTS}`,
      },
    },
    separation: BENCHMARK_SEPARATION,
    coverage,
    money,
    roster,
    results,
    movement,
    stack,
    changes,
    benchmark,
    definitions: DEFINITIONS.map(([term, meaning]) => ({ term, meaning })),
  };
  report.summary = buildSummary({
    period: resolved,
    scope: scopeBlock,
    coverage,
    money,
    roster,
    results,
    stack,
    changes,
  });
  report.refusals = periodReportRefusals(report);
  return report;
}

/* ------------------------------------------------------------------ */
/* 9. The text that goes to WhatsApp and Slack.                        */

function signedMoney(value) {
  if (value === null || value === undefined) return 'not measured';
  const rounded = Math.round(Number(value));
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Math.abs(rounded));
  return `${rounded < 0 ? '-' : '+'}${formatted}`;
}

/**
 * The pasteable summary.
 *
 * IT CARRIES NO BENCHMARK FIGURE, deliberately and permanently. A pasted line
 * loses the label that makes a backtest figure legal — the risk sizing, the one
 * simulated account, the version re-run over history — and a number with the
 * word URGO next to it in a WhatsApp thread will be read as what URGO made on
 * the desk. It also carries no total across businesses, for the reason
 * `deskMoney.rowsDoNotSum` gives.
 */
export function formatDeskPeriodReport(report) {
  if (!report) return '';
  const summary = report.summary || buildSummary(report);
  const lines = [];
  lines.push(`*${summary.title}*`);
  lines.push(`${summary.dates} · ${summary.closesSentence} · ${summary.scopeLabel}`);
  if (summary.partial) lines.push(`_This period is not complete. ${summary.partialReasons.join(' ')}_`);
  lines.push('');
  lines.push(`*Coverage* ${summary.coverageLine}.`);
  if (summary.coverageRange) lines.push(`${summary.coverageRange}.`);
  lines.push('');
  lines.push('*Money, per business, per account close. Never added*');
  for (const row of summary.money) {
    lines.push(`${row.shortLabel}: ${signedMoney(row.perAccountClose)} per account close over `
      + `${row.accountCloses} account close${row.accountCloses === 1 ? '' : 's'}`);
  }
  lines.push('');
  lines.push(`*Algorithms ranked this period: ${summary.rankedCount} of ${summary.rankableCount}*`);
  for (const row of summary.ranked) {
    lines.push(`${row.rank}. ${row.name}: ${signedMoney(row.meanPerAccountDay)} per account day `
      + `over ${row.accountDays} measured of ${row.ranAccountDays} account days it ran, on `
      + `${row.accounts} accounts`);
  }
  if (summary.newInPeriod.length) {
    lines.push(`New in period: ${summary.newInPeriod.join(', ')}`);
  }
  if (summary.stopped.length) {
    lines.push(`Stopped as of ${summary.stateClose}: ${summary.stopped.join(', ')}`);
  }
  lines.push('');
  lines.push(`${summary.noVerdictLine}.`);
  lines.push(`${summary.measuredLine}.`);
  lines.push('');
  lines.push('_Generated by Vincere CRM · Drive Insight_');
  return lines.join('\n');
}
