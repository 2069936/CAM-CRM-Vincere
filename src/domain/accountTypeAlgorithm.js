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

import { segmentForAccount, SEGMENTS, EXCLUDED_FROM_TOTAL } from './operationsSegments';
import { PROGRAMMES } from './algorithmProgrammes';

/**
 * Account types that name an algorithm, and the algorithm they name.
 *
 * A table rather than a hard-coded string because the collision is a naming
 * convention, not a one-off: the day the desk adds `Evaluation - <something>`
 * for another algorithm, the finding should extend rather than be rewritten.
 * One entry today, which is the honest state of this book.
 *
 * DERIVED FROM THE PROGRAMME LIST rather than written out again. The pair
 * (account type, algorithm name) is the same pair algorithmProgrammes.js holds
 * for the ranking, and two lists that agree today are two lists that drift: the
 * day a second programme is added, an algorithm could be off the ranking and
 * still absent from this finding, or the reverse.
 */
export const ALGORITHM_NAMED_TYPES = PROGRAMMES
  .map(({ segment, family }) => ({ segment, family }));

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

// ---------------------------------------------------------------------------
// THE SECOND FINDING: THE PROGRAMME RUNNING WHERE THE RULE SAYS IT CANNOT.
//
// The CAM stated a rule about the desk: "The only accounts that run Bullet Bot
// are evaluation accounts, because you cannot assign it wherever you want in
// NinjaTrader." A rule stated that plainly is worth checking, and the book does
// not quite keep it.
//
// WHY IT IS NOT THE FINDING ABOVE. That one starts from the account TYPE — an
// account labelled for an algorithm and running another — and its `elsewhere`
// line counts the reverse in one lump. This one starts from the PROGRAMME and
// sorts the reverse by what each account actually is, because by the CAM's rule
// the four groups are four different things and only one of them is an
// exception:
//
//   * A LIVE account of another type running it is the exception. There should
//     be none, and each one is named.
//   * An account marked Inactive / Ignore is a retired record of what it used to
//     run. Not an exception.
//   * An account nobody has typed yet is a classification backlog. Not an
//     exception either — it may well be an evaluation account whose row is
//     blank, and calling it a breach would be inventing the type.
//   * A close with no account row on record is a reconciliation problem about
//     the account, not about the programme.
//
// Printing all four as one number — the shape the `elsewhere` line has — makes
// the exception look an order of magnitude bigger than it is, and an operational
// list nobody can act on is one nobody reads twice.
//
// NO MONEY, SAME AS ABOVE. What these accounts made has nothing to do with
// whether the programme should be assigned to them.
// ---------------------------------------------------------------------------

/**
 * How an account running a programme stands against the rule.
 *
 * The order is the order the panel prints them in, and `anomaly` is deliberately
 * first: it is the only one that is work.
 */
export const PROGRAMME_STANDINGS = {
  ANOMALY: 'anomaly',
  EXPECTED: 'expected',
  UNCLASSIFIED: 'unclassified',
  RETIRED: 'retired',
  NO_RECORD: 'no record',
  NOT_REAL_MONEY: 'not real money',
};

const STANDING_ORDER = [
  PROGRAMME_STANDINGS.ANOMALY,
  PROGRAMME_STANDINGS.EXPECTED,
  PROGRAMME_STANDINGS.UNCLASSIFIED,
  PROGRAMME_STANDINGS.RETIRED,
  PROGRAMME_STANDINGS.NO_RECORD,
  PROGRAMME_STANDINGS.NOT_REAL_MONEY,
];

const STANDING_NOTES = {
  [PROGRAMME_STANDINGS.ANOMALY]: 'Live accounts of another type. By the rule there should be '
    + 'none of these, so each one is named below.',
  [PROGRAMME_STANDINGS.EXPECTED]: 'Evaluation accounts — where the rule says the programme runs, '
    + 'and where nearly all of it does.',
  [PROGRAMME_STANDINGS.UNCLASSIFIED]: 'Accounts nobody has typed yet. A classification backlog, '
    + 'not a breach: an untyped account may well be an evaluation account whose row is blank, and '
    + 'counting it as an exception would be inventing the type.',
  [PROGRAMME_STANDINGS.RETIRED]: 'Accounts marked Inactive / Ignore. A retired record of what the '
    + 'account used to run, not something running today.',
  [PROGRAMME_STANDINGS.NO_RECORD]: 'Closes whose account has no registry row at all. A '
    + 'reconciliation problem about the account, not about the programme.',
  [PROGRAMME_STANDINGS.NOT_REAL_MONEY]: 'Simulated or nature-undetermined accounts. Not the '
    + 'desk’s money and not in any total.',
};

function standingFor(segment, expectedSegment) {
  if (segment === expectedSegment) return PROGRAMME_STANDINGS.EXPECTED;
  if (segment === SEGMENTS.UNCLASSIFIED) return PROGRAMME_STANDINGS.UNCLASSIFIED;
  if (segment === SEGMENTS.IGNORED) return PROGRAMME_STANDINGS.RETIRED;
  if (segment === SEGMENTS.ORPHAN) return PROGRAMME_STANDINGS.NO_RECORD;
  if (EXCLUDED_FROM_TOTAL.has(segment)) return PROGRAMME_STANDINGS.NOT_REAL_MONEY;
  // Cash, Funded, Evaluation - Standard, and any account type this build has
  // not been taught. A new type lands here — as an exception to be looked at —
  // rather than being quietly folded into the expected group.
  return PROGRAMME_STANDINGS.ANOMALY;
}

const PROGRAMME_ASK = 'For each account named below, confirm which of the two is stale: the '
  + 'account type, or the assignment. Different is not wrong — this is a list to verify, and only '
  + 'the CAM who moved the client can say which side to correct — but the desk states this one as '
  + 'a rule, and an exception to a stated rule is either a mislabelled account or a rule that '
  + 'needs restating.';

// Not the mismatch finding's POPULATION, which says an account with no registry
// row is not in the list. This one keeps that account and gives it a group of
// its own: dropping it would quietly shrink the denominator every count here is
// read against.
const PROGRAMME_POPULATION = 'Read off the real-money closes in the book — the same account-days '
  + 'the algorithm ranking measures. Simulated closes are not in this list. A close whose account '
  + 'has no registry row is counted in its own group below rather than dropped, so the total is '
  + 'every account the book has seen the programme on.';

const PROGRAMME_NOT_A_SEGMENT = 'A labelling question, not a performance one. No P&L, no mean '
  + 'and no verdict on the programme appears here: whether an account should be running it has '
  + 'nothing to do with what it made.';

/**
 * Every account the book has seen running a programme, sorted by how it stands
 * against the rule that the programme runs on evaluation accounts only.
 *
 * One finding per programme family. The unit is the ACCOUNT, as it is on the
 * mismatch finding above: a still-true condition is re-imported on every close,
 * so the strategy-row count grows with how long it has been true and is carried
 * as ageing evidence rather than as the headline.
 */
export function buildProgrammeAccountStanding(clients = [], { asOfDate = '' } = {}) {
  const bound = day(asOfDate);
  const byFamily = new Map(PROGRAMMES.map((entry) => [entry.family, {
    programme: entry,
    accounts: new Map(),
  }]));

  for (const client of clients || []) {
    const registry = client?.accountRegistry || {};
    const clientKey = client?.id ?? client?.name ?? '';
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date) continue;
      if (bound && date > bound) continue;
      for (const snapshot of dailyImport?.snapshots || []) {
        const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
        const accountKey = `${clientKey} ${snapshot.accountName}`;
        for (const strategy of snapshot.strategies || []) {
          const held = byFamily.get(familyOf(strategy));
          if (!held) continue;
          const seat = held.accounts.get(accountKey) || {
            accountKey,
            accountName: snapshot.accountName,
            clientKey,
            clientName: client?.name || '',
            // One type per account, not one per close: the registry is per
            // client and holds a single accountType, so every close of this
            // account segments the same way. Re-deriving it per close and
            // keeping the latest would suggest the type can move inside the
            // window, which this data model cannot express.
            segment,
            rows: 0,
            enabledRows: 0,
            closes: new Set(),
            firstDate: date,
            lastDate: date,
          };
          if (date < seat.firstDate) seat.firstDate = date;
          if (date >= seat.lastDate) seat.lastDate = date;
          seat.rows += 1;
          if (strategy?.enabled) seat.enabledRows += 1;
          seat.closes.add(date);
          held.accounts.set(accountKey, seat);
        }
      }
    }
  }

  return [...byFamily.values()]
    .filter((held) => held.accounts.size > 0)
    .map(({ programme, accounts }) => {
      const seats = [...accounts.values()].map((seat) => ({
        accountKey: seat.accountKey,
        accountName: seat.accountName,
        clientKey: seat.clientKey,
        clientName: seat.clientName,
        segment: seat.segment,
        standing: standingFor(seat.segment, programme.segment),
        rows: seat.rows,
        enabledRows: seat.enabledRows,
        closes: seat.closes.size,
        firstDate: seat.firstDate,
        lastDate: seat.lastDate,
      }));

      const byStanding = STANDING_ORDER
        .map((standing) => {
          const held = seats.filter((seat) => seat.standing === standing);
          return {
            standing,
            note: STANDING_NOTES[standing],
            accounts: held.length,
            clients: new Set(held.map((seat) => seat.clientKey)).size,
            rows: held.reduce((sum, seat) => sum + seat.rows, 0),
            segments: [...new Set(held.map((seat) => seat.segment))].sort()
              .map((segment) => ({
                segment,
                accounts: held.filter((seat) => seat.segment === segment).length,
              })),
          };
        })
        .filter((row) => row.accounts > 0);

      const anomalies = seats
        .filter((seat) => seat.standing === PROGRAMME_STANDINGS.ANOMALY)
        // Longest-standing first: the one that has been true across the most
        // closes is the one nobody has looked at.
        .sort((a, b) => b.closes - a.closes
          || b.rows - a.rows
          || a.accountName.localeCompare(b.accountName));

      return {
        family: programme.family,
        expectedSegment: programme.segment,
        accounts: seats.length,
        clients: new Set(seats.map((seat) => seat.clientKey)).size,
        byStanding,
        anomalies,
        anomalyAccounts: anomalies.length,
        anomalyClients: new Set(anomalies.map((seat) => seat.clientKey)).size,
        anomalyRows: anomalies.reduce((sum, seat) => sum + seat.rows, 0),
        expectedAccounts: seats
          .filter((seat) => seat.standing === PROGRAMME_STANDINGS.EXPECTED).length,
        rule: `The desk states this as a rule: the only accounts that run ${programme.family} are `
          + 'evaluation accounts, because it cannot be assigned wherever you like in NinjaTrader. '
          + 'So a LIVE account of any other type running it is an exception, and there should be '
          + 'none. Retired accounts and accounts nobody has typed yet are counted apart below — '
          + 'neither is an exception to the rule, and folding all three together makes the '
          + 'exception look several times larger than it is.',
        ask: PROGRAMME_ASK,
        notASegment: PROGRAMME_NOT_A_SEGMENT,
        population: PROGRAMME_POPULATION,
      };
    });
}

/**
 * The figures the programme-standing finding will not produce.
 *
 * Two of them, and both are about the same temptation: turning a list of
 * accounts into a verdict on the programme.
 */
export function programmeStandingRefusals(findings = []) {
  const anomalies = findings.reduce((sum, finding) => sum + finding.anomalyAccounts, 0);
  const seen = findings.reduce((sum, finding) => sum + finding.accounts, 0);
  return [
    {
      figure: 'What the accounts breaking the rule made, against the ones keeping it',
      value: null,
      reason: PROGRAMME_NOT_A_SEGMENT + ' It would also be the per-account-type verdict the '
        + 'algorithm ranking was rebuilt to remove, arrived at from the other direction.',
    },
    {
      figure: 'One number for “accounts running it that are not typed for it”',
      value: null,
      reason: `${seen} account${seen === 1 ? '' : 's'} have run a programme on this book and `
        + `${anomalies} of them ${anomalies === 1 ? 'is' : 'are'} a live account of another type. `
        + 'Adding the retired accounts and the untyped ones to that figure would multiply it '
        + 'several times over with rows that are not exceptions: a retired account is a record of '
        + 'what it used to run, and an untyped account has no type to contradict.',
    },
    {
      figure: 'A verdict on which side is stale',
      value: null,
      reason: 'Whether the account type is wrong or the assignment is cannot be read off an '
        + 'export. The list names the accounts and the wording never says “wrong”.',
    },
  ];
}
