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
import { resolvePeriod } from './deskPeriod';

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
  for (const date of period.missingWeekdays) {
    rows.push({
      date,
      noClose: true,
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

  return {
    rows,
    totals: {
      closesInPeriod: measured.length,
      weekdaysInPeriod: period.weekdays,
      weekendCloses: period.weekendCloses.length,
      clientsReporting: clientsInPeriod.size,
      accountsReporting: accountsInPeriod.size,
      accountCloses,
      fullestClose: fullest ? { date: fullest.date, accounts: fullest.accountRows, clients: fullest.clients.size } : null,
      thinnestClose: thinnest ? { date: thinnest.date, accounts: thinnest.accountRows, clients: thinnest.clients.size } : null,
      coverageRatio: ratio,
      clientsThatFiledNothing: filedNothing.length,
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
    sentence: fullest && thinnest
      ? `Coverage inside this period runs from ${thinnest.accountRows} to ${fullest.accountRows} `
        + `account rows per close, a factor of ${ratio}. ${PERIOD_DOLLAR_REFUSAL}`
      : PERIOD_DOLLAR_REFUSAL,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Money, per business, never added.                                */

function buildMoney(clients, period) {
  const desk = buildDeskMoneyForRange(clients, { from: period.from, to: period.to });
  const prior = period.priorEmpty
    ? null
    : buildDeskMoneyForRange(clients, { from: period.priorFrom, to: period.priorTo });

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
            + 'side — at that size a difference is one account’s day.'
          : null),
    };
  });

  // One strip per business per close, as a rate. Never one chart with four
  // series: a cash dollar and a prop dollar are not the same quantity and a
  // shared axis invites reading one against the other.
  const columns = deskBusinessColumns();
  const byClose = period.closes.map((date) => {
    const one = buildDeskMoneyForRange(clients, { from: date, to: date });
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

function buildRoster(clients, period, coverage) {
  const all = new Map();
  const lastClose = period.closes[period.closes.length - 1] || '';
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
            accountsOnLastClose: new Set(),
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
            if (date === lastClose) held.accountsOnLastClose.add(accountKey);
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
    const onLast = entry.accountsOnLastClose.size > 0;
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
      accountsOnLastClose: entry.accountsOnLastClose.size,
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

  // HOW MUCH OF THE DESK THE LAST CLOSE ACTUALLY HELD.
  //
  // Every state in this table is decided on one close, and on this book that
  // close is sometimes a Saturday carrying 7 of the 338 account rows the week's
  // fullest close carried. Under the rule as written, twelve algorithms then
  // read `Stopped` — which is true of that close and false of the desk. The
  // rule is not bent for it (a rule that moves with coverage is worse than one
  // that is stated), so the coverage of the deciding close is published beside
  // the states and the page prints the caveat when it is thin.
  const lastRow = (coverage?.rows || []).find((row) => row.date === lastClose) || null;
  const fullest = coverage?.totals?.fullestClose || null;
  const lastShare = lastRow && fullest && fullest.accounts
    ? Math.round((lastRow.accountsReporting / fullest.accounts) * 100)
    : null;
  const thinLastClose = lastShare !== null && lastShare < 50;

  return {
    rows,
    lastClose,
    lastCloseAccounts: lastRow ? lastRow.accountsReporting : null,
    lastCloseShareOfFullest: lastShare,
    thinLastClose,
    thinLastCloseNote: thinLastClose
      ? `Read the states with care. Running and Stopped are decided on ${lastClose}, which carried `
        + `${lastRow.accountsReporting} account row${lastRow.accountsReporting === 1 ? '' : 's'} — `
        + `${lastShare}% of the ${fullest.accounts} on ${fullest.date}, the fullest close in this `
        + 'period. An algorithm absent from a close that thin is absent from a small slice of the '
        + 'desk, not from the desk.'
      : null,
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
    stateNote: `Running is decided on ${lastClose || 'the last close inside this period'}, the last `
      + 'close inside this period. Not seen means no account in this population carried it inside '
      + 'this period — it does not mean retired, and on a book this short an algorithm can be '
      + 'absent here and enabled on an account type this population excludes.',
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

  const names = [...new Set([...inPeriod.keys(), ...inBook.keys()])];
  const rows = names.map((name) => {
    const here = inPeriod.get(name) || null;
    const before = inPrior.get(name) || null;
    const book = inBook.get(name) || null;
    const gated = (row) => Boolean(row && row.sufficient);
    const bothWindows = gated(here) && gated(before);
    const bookComparable = gated(here) && gated(book);
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
      againstBookRefusal: bookComparable ? null : 'Withheld under the same gate.',
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
    bookNote: `The book to date runs from the book’s first close to ${period.to} and CONTAINS this `
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
  return {
    perf,
    priorPerf,
    rows,
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
        const held = byAccount.get(key) || { name, meta, points: [] };
        held.points.push({
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
      const { points } = account;
      for (let index = 1; index < points.length; index += 1) {
        const here = points[index];
        const before = points[index - 1];
        if (here.combo === before.combo) continue;
        if (here.date < period.from || here.date > period.to) continue;
        const inPeriod = points.filter(
          (point) => point.date >= period.from && point.date <= period.to,
        );
        const after = inPeriod.filter((point) => point.date >= here.date);
        const priorSide = inPeriod.filter((point) => point.date < here.date);
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
        changes.push({
          involvesUnknown,
          date: here.date,
          clientId: client?.id ?? client?.name ?? '',
          clientName: client?.name || '',
          accountName: account.name,
          accountAlias: account.meta?.alias || '',
          from: before.combo,
          to: here.combo,
          accountDaysSince: after.length,
          beforeDays: priorSide.length,
          afterDays: after.length,
          perAccountDayBefore: comparable ? mean(priorSide) : null,
          perAccountDayAfter: comparable ? mean(after) : null,
          sidesRefusal: comparable
            ? null
            : `Withheld: ${priorSide.length} account day${priorSide.length === 1 ? '' : 's'} before `
              + `and ${after.length} after inside this period, and each side needs 5.`,
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
  return {
    rows: decisions,
    attributionGaps: attribution,
    counts: {
      total: rows.length,
      decisions: decisions.length,
      attributionGaps: attribution.length,
      accounts: new Set(rows.map((row) => `${row.clientId}::${row.accountName}`)).size,
      compared: decisions.filter((row) => row.perAccountDayBefore !== null).length,
    },
    attributionNote: `${attribution.length} further change${attribution.length === 1 ? '' : 's'} `
      + 'in this period were to or from Unknown — the export stopped naming an algorithm, or '
      + 'started. They are a change in evidence, not a change somebody made, and they are counted '
      + 'here rather than listed above.',
    sidesNote: `Each side of a change needs 5 account days inside ${period.label} before the two `
      + 'figures are printed. That is the floor comboPerformance already uses to split its trend '
      + 'halves, and it is not a new number.',
  };
}

/* ------------------------------------------------------------------ */
/* 6. The benchmark, measured separately and joined on identity only.  */

function buildBenchmark(roster, series, period, riskLevel) {
  const risk = BENCHMARK_RISK_LEVELS.includes(riskLevel) ? riskLevel : BENCHMARK_RISK_LEVELS[0];
  const list = Array.isArray(series) ? series : [];
  const coverage = buildBenchmarkCoverage(
    roster.rows.map((row) => ({
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
      quantities: entry.quantities,
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
    minCommonCloses: BENCHMARK_MIN_COMMON_CLOSES,
    separation: BENCHMARK_SEPARATION,
  };
}

/* ------------------------------------------------------------------ */
/* 7. The refusals, generated from the report's own counts.            */

export function periodReportRefusals(report) {
  const coverage = report?.coverage?.totals || {};
  const results = report?.results || {};
  const stack = report?.stack || {};
  const benchmark = report?.benchmark || {};
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
    + 'Owned by comboPerformance.js.'],
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
  scope = null,
  benchmarkSeries = [],
  benchmarkRisk = 'Low',
  builtAt = '',
  builtBy = '',
} = {}) {
  const list = clients || [];
  const resolved = period || resolvePeriod(list, { kind, key, from, to });
  const book = bookCloses(list);

  const scopeBlock = {
    kind: scope?.kind === 'cam' ? 'cam' : 'desk',
    camProfileId: scope?.camProfileId || null,
    camName: scope?.camName || '',
    clientsInScope: list.length,
    deskClientCount: scope?.deskClientCount ?? list.length,
    label: scope?.kind === 'cam'
      ? `Your book, ${list.length} of the desk’s ${scope?.deskClientCount ?? list.length} clients`
      : `Desk wide, ${list.length} client${list.length === 1 ? '' : 's'}`,
    // Which sections the scope actually narrows. Stated on the object rather
    // than only in the component: a CAM's coverage and money are their own
    // book, and the algorithm sections are the desk's, pooled — a ranking over
    // one CAM's eight clients under the same column header would be a different
    // measurement wearing the same label.
    scopedSections: scope?.kind === 'cam'
      ? ['coverage', 'money', 'changes']
      : [],
    deskWideNote: 'The roster, the results, the movement, the stack and the benchmark are desk '
      + 'wide for everybody. A ranking computed over one CAM’s clients under the same column '
      + 'header would be a different measurement wearing the same label, and almost every row of '
      + 'it would fall under the evidence gate.',
  };

  const coverage = buildCoverage(list, resolved);
  const money = buildMoney(list, resolved);
  const roster = buildRoster(list, resolved, coverage);

  const periodRanking = buildStrategyRanking(list, {
    fromDate: resolved.from,
    asOfDate: resolved.to,
  });
  const priorRanking = resolved.priorEmpty ? null : buildStrategyRanking(list, {
    fromDate: resolved.priorFrom,
    asOfDate: resolved.priorTo,
  });
  const bookRanking = buildStrategyRanking(list, {
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

  const results = {
    basis: periodRanking.basis,
    rows: periodRanking.ranking.rows,
    rankedCount: periodRanking.ranking.rankedCount,
    unrankedCount: periodRanking.ranking.unrankedCount,
    programmes: periodRanking.ranking.programmes,
    unitNote: periodRanking.ranking.unitNote,
    instrumentCaveat: periodRanking.ranking.instrumentCaveat,
    gate: periodRanking.gate,
    reconciliation: periodRanking.reconciliation,
    accountTypeRefusal: ACCOUNT_TYPE_REFUSAL,
    noRankNote: periodRanking.ranking.rankedCount === 0
      ? `No algorithm clears ${EVIDENCE_GATE.minAccountDays} reported account days and `
        + `${EVIDENCE_GATE.minAccounts} accounts in this period. Every row above carries its `
        + 'counts and no position.'
      : null,
  };

  const movement = buildMovement(periodRanking, priorRanking, bookRanking, resolved);
  const stack = buildStack(list, resolved);
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
  const { period, coverage, money, roster, results, stack } = report;
  const lines = [];
  lines.push(`*${report.title}*`);
  lines.push(`${period.from} to ${period.to} · ${coverage.totals.closesInPeriod} close`
    + `${coverage.totals.closesInPeriod === 1 ? '' : 's'} of ${period.weekdays} weekday`
    + `${period.weekdays === 1 ? '' : 's'} · ${report.scope.label}`);
  if (period.partial) lines.push(`_This period is not complete. ${period.partialReasons.join(' ')}_`);
  lines.push('');
  lines.push(`*Coverage* ${coverage.totals.accountCloses} account closes over `
    + `${coverage.totals.accountsReporting} accounts and `
    + `${coverage.totals.clientsReporting} clients.`);
  if (coverage.totals.fullestClose && coverage.totals.thinnestClose) {
    lines.push(`Fullest close ${coverage.totals.fullestClose.date} `
      + `(${coverage.totals.fullestClose.accounts} account rows), thinnest `
      + `${coverage.totals.thinnestClose.date} (${coverage.totals.thinnestClose.accounts}).`);
  }
  lines.push('');
  lines.push('*Money, per business, per account close — never added*');
  for (const row of money.rows) {
    lines.push(`${row.shortLabel}: ${signedMoney(row.perAccountClose)} per account close over `
      + `${row.accounts} account close${row.accounts === 1 ? '' : 's'}`);
  }
  lines.push('');
  const ranked = results.rows.filter((row) => row.ranked);
  lines.push(`*Algorithms ranked this period: ${ranked.length} of `
    + `${results.rankedCount + results.unrankedCount}*`);
  for (const row of ranked) {
    lines.push(`${row.rank}. ${row.name}: ${signedMoney(row.meanPerAccountDay)} per account day `
      + `over ${row.accountDays} account days on ${row.accounts} accounts`);
  }
  const newRows = roster.rows.filter((row) => row.isNew);
  const stopped = roster.rows.filter((row) => row.state === 'Stopped');
  if (newRows.length) {
    lines.push(`New in period: ${newRows.map((row) => row.algorithm).join(', ')}`);
  }
  if (stopped.length) {
    lines.push(`Stopped in period: ${stopped.map((row) => row.algorithm).join(', ')}`);
  }
  lines.push('');
  lines.push(`${results.unrankedCount} algorithm${results.unrankedCount === 1 ? '' : 's'} and `
    + `${stack.lowSampleCount} combination${stack.lowSampleCount === 1 ? '' : 's'} carry their `
    + 'counts and no verdict: too few account days or too few accounts in this period.');
  lines.push('');
  lines.push('_Generated by Vincere CRM · Drive Insight_');
  return lines.join('\n');
}
