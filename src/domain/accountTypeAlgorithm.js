// Accounts whose TYPE names an algorithm they are not running.
//
// WHERE THIS CAME FROM. The algorithm boards used to carry a board called
// "Bullet Bot", and it was an ACCOUNT TYPE — `Evaluation - Bullet Bot` — that
// happens to share its name with an algorithm. So "OGX on the Bullet Bot board"
// read as OGX being a Bullet Bot strategy, which it is not: Bullet Bot is a peer
// algorithm with its own family and its own contract (NQ, where OGX runs MNQ).
// The desk manager's words were "Bullet Bot does not run OGX".
//
// Taking that board away leaves a real finding behind, and it is the reason this
// file exists rather than the collision being deleted quietly: on this book 18
// accounts typed `Evaluation - Bullet Bot` are running algorithms that are not
// Bullet Bot — OGX, IFSP, G4M, B2X, URGO, DJDR, ARPD and SYFY between them — and
// on 9 of those 18 there is no Bullet Bot row at all. Either the account is
// mislabelled or the algorithm was swapped and the type was never updated.
//
// WHAT THIS IS AND IS NOT. It is an OPERATIONAL finding, in the register the
// configuration review already uses: a list to verify, never a fault list.
// Nothing here decides anything is wrong — a client can be moved onto a
// different algorithm on purpose and the evaluation account keeps its name.
// What it is NOT is a performance segment. It carries no P&L, no mean and no
// verdict about any algorithm, deliberately: the whole point of the rework
// underneath it is that an account's label says nothing about how an algorithm
// behaved.
//
// THE UNIT IS THE ACCOUNT, NOT THE ROW. A still-true condition is re-imported
// every close, so counting strategy rows across the book counts one problem once
// per day it survived — the same inflation camFlagQueue.js was written to undo
// (1,952 rows against 253 real ones). The headline is distinct accounts; the row
// count is carried beside it as evidence of how long it has been true, and is
// never the number the finding leads with.

import { segmentForAccount, SEGMENTS } from './operationsSegments';

/**
 * Account types that name an algorithm, and the algorithm they name.
 *
 * A table rather than a hard-coded string because the collision is a naming
 * convention, not a one-off: the day the desk adds `Evaluation - <something>`
 * for another algorithm, the finding should extend rather than be rewritten.
 * One entry today, which is the honest state of this book.
 */
export const ALGORITHM_NAMED_TYPES = [
  { segment: SEGMENTS.EVAL_BULLET, family: 'Bullet Bot' },
];

const ASK = 'For each account, confirm which algorithm it is meant to be running. Different is '
  + 'not wrong — a client can be moved onto another algorithm deliberately — but an account '
  + 'labelled for one algorithm and running another is a label nobody can trust afterwards. '
  + 'Either correct the account type or record why it stays.';

const NOT_A_SEGMENT = 'This is a labelling question, not a performance one. No P&L, no mean and '
  + 'no ranking appears here: what an algorithm made has nothing to do with what the account it '
  + 'ran on is called, which is the reason the per-account-type boards were removed.';

const POPULATION = 'Read off the real-money closes in the book — the same account-days the '
  + 'algorithm ranking measures. Simulated accounts and accounts with no registry row are not in '
  + 'this list.';

function day(value) {
  return String(value || '').slice(0, 10);
}

function familyOf(strategy) {
  return strategy?.strategyFamily || strategy?.strategyName || 'Unknown';
}

/**
 * Accounts typed for an algorithm they are not running, and the same algorithm
 * running on accounts not typed for it.
 *
 * Both halves, because a manager cannot tell "mislabelled" from "swapped" with
 * only one of them: an account typed Standard that is running Bullet Bot is the
 * same defect seen from the other side, and on this book there are more of those
 * than there are of the first kind.
 */
export function buildAccountTypeMismatch(clients = [], { asOfDate = '' } = {}) {
  const bound = day(asOfDate);
  const byType = new Map(ALGORITHM_NAMED_TYPES.map((entry) => [entry.segment, entry]));
  const namedFamilies = new Map(ALGORITHM_NAMED_TYPES.map((entry) => [entry.family, entry]));

  // key -> one typed account, with every family ever seen on it.
  const typedAccounts = new Map();
  // family -> where it runs on accounts NOT typed for it.
  const elsewhere = new Map();

  for (const client of clients || []) {
    const registry = client?.accountRegistry || {};
    const clientKey = client?.id ?? client?.name ?? '';
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date) continue;
      if (bound && date > bound) continue;
      for (const snapshot of dailyImport?.snapshots || []) {
        const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
        const typed = byType.get(segment);
        const accountKey = `${clientKey} ${snapshot.accountName}`;
        for (const strategy of snapshot.strategies || []) {
          const family = familyOf(strategy);
          if (typed) {
            const seat = typedAccounts.get(accountKey) || {
              accountKey,
              accountName: snapshot.accountName,
              clientKey,
              clientName: client?.name || '',
              segment,
              expected: typed.family,
              families: new Map(),
              closes: new Set(),
              firstDate: date,
              lastDate: date,
            };
            if (date < seat.firstDate) seat.firstDate = date;
            if (date > seat.lastDate) seat.lastDate = date;
            seat.closes.add(date);
            const held = seat.families.get(family)
              || { name: family, rows: 0, enabledRows: 0, closes: new Set() };
            held.rows += 1;
            if (strategy?.enabled) held.enabledRows += 1;
            held.closes.add(date);
            seat.families.set(family, held);
            typedAccounts.set(accountKey, seat);
            continue;
          }
          const named = namedFamilies.get(family);
          if (!named) continue;
          const away = elsewhere.get(family) || { family, expected: named.segment, bySegment: new Map() };
          const bucket = away.bySegment.get(segment)
            || { segment, rows: 0, accounts: new Set(), clients: new Set() };
          bucket.rows += 1;
          bucket.accounts.add(accountKey);
          bucket.clients.add(clientKey);
          away.bySegment.set(segment, bucket);
          elsewhere.set(family, away);
        }
      }
    }
  }

  const seats = [...typedAccounts.values()];
  const rows = seats
    .filter((seat) => [...seat.families.keys()].some((family) => family !== seat.expected))
    .map((seat) => {
      const others = [...seat.families.values()]
        .filter((family) => family.name !== seat.expected)
        .map((family) => ({
          name: family.name,
          rows: family.rows,
          enabledRows: family.enabledRows,
          closes: family.closes.size,
        }))
        .sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
      const expectedRows = seat.families.get(seat.expected)?.rows || 0;
      return {
        accountKey: seat.accountKey,
        accountName: seat.accountName,
        clientKey: seat.clientKey,
        clientName: seat.clientName,
        segment: seat.segment,
        expected: seat.expected,
        // The two shapes read differently and are counted apart: an account with
        // no row of the algorithm it is named for looks like a swap nobody
        // recorded; one running it alongside something else looks like a stack.
        runsExpected: expectedRows > 0,
        expectedRows,
        others,
        otherRows: others.reduce((sum, family) => sum + family.rows, 0),
        closes: seat.closes.size,
        firstDate: seat.firstDate,
        lastDate: seat.lastDate,
      };
    })
    // Worst first is not "most rows" — it is the account that has been wrong the
    // longest with nothing of its own algorithm on it.
    .sort((a, b) => Number(a.runsExpected) - Number(b.runsExpected)
      || b.closes - a.closes
      || b.otherRows - a.otherRows
      || a.accountName.localeCompare(b.accountName));

  const families = new Map();
  for (const row of rows) {
    for (const other of row.others) {
      const held = families.get(other.name)
        || { name: other.name, rows: 0, accounts: new Set(), clients: new Set() };
      held.rows += other.rows;
      held.accounts.add(row.accountKey);
      held.clients.add(row.clientKey);
      families.set(other.name, held);
    }
  }

  return {
    // The finding, in the unit that can be acted on.
    accounts: rows.length,
    clients: new Set(rows.map((row) => row.clientKey)).size,
    strategyRows: rows.reduce((sum, row) => sum + row.otherRows, 0),
    // Of the accounts above, the ones carrying no row of the algorithm they are
    // named for at all.
    swapped: rows.filter((row) => !row.runsExpected).length,
    alongside: rows.filter((row) => row.runsExpected).length,
    // The denominator. "18 accounts" alone reads as a share of the desk.
    typedAccountsSeen: seats.length,
    families: [...families.values()]
      .map((family) => ({
        name: family.name,
        rows: family.rows,
        accounts: family.accounts.size,
        clients: family.clients.size,
      }))
      .sort((a, b) => b.accounts - a.accounts || b.rows - a.rows || a.name.localeCompare(b.name)),
    rows,
    // The other side of the same question.
    elsewhere: [...elsewhere.values()].map((away) => ({
      family: away.family,
      rows: [...away.bySegment.values()]
        .map((bucket) => ({
          segment: bucket.segment,
          rows: bucket.rows,
          accounts: bucket.accounts.size,
          clients: bucket.clients.size,
        }))
        .sort((a, b) => b.accounts - a.accounts || a.segment.localeCompare(b.segment)),
      accounts: [...away.bySegment.values()]
        .reduce((set, bucket) => { for (const key of bucket.accounts) set.add(key); return set; },
          new Set()).size,
    })),
    ask: ASK,
    notASegment: NOT_A_SEGMENT,
    population: POPULATION,
  };
}

/**
 * The figures this finding will not produce.
 *
 * Short on purpose. The one thing a reader might expect and must not be given is
 * a performance comparison, because that is the mistake the whole rework
 * removed.
 */
export function accountTypeMismatchRefusals(finding) {
  return [
    {
      figure: 'What these accounts made, by account type',
      value: null,
      reason: NOT_A_SEGMENT,
    },
    {
      figure: 'A verdict on which accounts are wrong',
      value: null,
      reason: `${finding?.accounts || 0} account${finding?.accounts === 1 ? '' : 's'} carry a type `
        + 'that names one algorithm and rows that name another. Which of the two is stale is not '
        + 'something an export can say — only the CAM who moved the client knows — so this is a '
        + 'list to verify and the wording never says "wrong".',
    },
    {
      figure: 'A count of strategy rows as the headline',
      value: null,
      reason: 'A still-true condition is re-imported on every close, so a row count grows with '
        + `how long it has been true: the ${finding?.strategyRows || 0} rows below sit on `
        + `${finding?.accounts || 0} account${finding?.accounts === 1 ? '' : 's'}. The accounts `
        + 'are the work; the rows are how long it has been waiting.',
    },
  ];
}
