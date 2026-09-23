// Is anybody running an algorithm configured differently from the rest of the
// desk TODAY?
//
// Not against history. The desk changes a setting deliberately and the whole
// cohort moves within a day or two, so a comparison against last month reports
// every intended change as drift and goes quiet about the one account that never
// got the change. The question the desk actually asks is "eight people are
// running URGO 4.5 on MNQ right now — is one of them on something nobody else
// is on", and the only honest reference for that is the other accounts running
// it on the same day.
//
// WHAT THIS IS NOT. strategyConfigDrift.js answers a related but different
// question: it walks each client's LATEST close, whatever day that falls on,
// groups on (family, instrument) and ranks whole CONFIGURATIONS by how rare they
// are. That is the right shape for "which cohorts are fragmented". It cannot
// answer this one, because two accounts whose latest closes are a fortnight
// apart are not evidence about each other, and because a configuration key is
// all-or-nothing: an account differing in one field and an account differing in
// twenty are both simply "not the majority key". Here the unit is the FIELD.
//
// NOTHING BELOW DECIDES ANYTHING IS WRONG. A client can be customised on
// purpose, and most of what this finds is that. The output is a list of
// questions, the wording everywhere is "differs", and the word "wrong" does not
// appear. The desk decides.

import { instrumentRoot } from './instrumentSpecs';
import {
  PER_CLIENT_FIELDS,
  SIZING,
  normaliseSetFileValue,
  parseLiveParameters,
} from './setFileNormalise';

/**
 * Three accounts, because two cannot disagree with a majority.
 *
 * With two accounts on different values there is no majority and no minority,
 * only two readings; calling either of them the outlier is a coin toss wearing a
 * finding's clothes. With three and a two-one split there is something to say.
 * A group under the floor is REPORTED, with its accounts, and marked unmeasured
 * — the alternative is a group that was checked and found uniform, a group of
 * two and a group that does not exist all rendering identically, which is the
 * "cannot be determined is null, never 0" rule broken one level up.
 */
export const MIN_CONSENSUS_ACCOUNTS = 3;

/**
 * THE FLOOR IS ON ACCOUNTS, AND ONE CLIENT CAN CLEAR IT ON HIS OWN.
 *
 * Three machines is enough for a two-one split to mean something only when the
 * three are not all the same person's. Two real cases on the book: DJDR 1.1 on
 * MNQ on 2026-07-13 is three accounts of one client, reported as "all on the
 * desk setting" — one client's three machines agreeing with themselves; and
 * RBO_PF 1.8 on M2K on 2026-07-30 is four accounts of two clients, two each,
 * whose seventeen flat 2-2 fields are reported as a divided desk.
 *
 * A client floor would hide both groups, and this file's own argument is that a
 * group nobody could measure must stay VISIBLE and say so. So the group says
 * its shape instead: the panel prints "one client's own settings, not a desk
 * reference" beside a group whose accounts all belong to one client, and the
 * reader discounts it themselves. Groups of exactly two accounts were already
 * handled honestly by the floor above.
 */
export const MIN_CONSENSUS_CLIENTS = 2;

/**
 * How much of a group one reading has to hold before it is the desk's answer.
 *
 * A plain majority is not enough, and the book says so in one number: Bullet Bot
 * 1.1 on NQ runs MyTradeDirection Long on 53 accounts and Short on 45 on
 * 2026-07-30. "More accounts than every other value put together" makes Long the
 * consensus and puts 45 accounts on a review list for running Short, which turns
 * a 98 account group into 54 findings and teaches the reader to close the panel.
 * At 60% neither reading wins and the group says the desk is divided, once.
 *
 * Measured over that day: the floor takes the accounts reported from 200 of 411
 * to 60, and every one of the 140 it drops was dropped by a field on which the
 * desk genuinely runs two settings.
 */
export const CONSENSUS_SHARE = 0.6;

/**
 * A reading the desk is actually running, rather than a deviation from it.
 *
 * Two conditions, and both are needed. MORE THAN 15% of the group, because a
 * setting a sixth of the desk runs is a decision somebody took; and AT LEAST
 * MIN_CONSENSUS_ACCOUNTS accounts, because in a group of three a share rule
 * alone makes the single account of a two-one split 33% and therefore
 * unreportable, which would silence the smallest groups entirely — exactly the
 * ones a manager can still act on.
 *
 * On the book's last close this is what separates URGO's eleven accounts closing
 * at 16:30 (a session) from its one account closing at 15:45 (a question), and
 * the twelve IFSP accounts on a build with no day-of-week filters (two builds)
 * from the one account whose entry offset is 0 where 36 run 1.
 */
export const SECOND_READING_SHARE = 0.15;

/**
 * How many accounts a field has to be distinct on before "distinct on every one
 * of them" means it identifies the machine.
 *
 * The derived noise rule is only sound at scale. Three accounts holding three
 * different stop losses is an ordinary cohort of three, and calling StopLossTicks
 * an identifier there is a wrong answer with a confident label on it — which is
 * what a floor of MIN_CONSENSUS_ACCOUNTS did: on 2026-07-30 it marked
 * StartTrailAfterTicks and StopLossTicks per machine on OGX_PF 2.4, a group of
 * three. Eight is buildConfigDrift's own cohort floor, reused rather than
 * invented, and a settings field that is distinct on eight accounts running one
 * version on one day does not occur on this book.
 *
 * A field that misses this floor is not lost. Nothing can agree with it either,
 * so it reads as "the desk does not agree on this", which is the truthful
 * sentence for a group that small.
 */
export const MIN_UNIQUE_FIELD_ACCOUNTS = 8;

/**
 * Fields that identify a machine or an export rather than a configuration.
 *
 * Two sources, and the split matters:
 *
 *   DERIVED (deskNoiseFields below) — a field whose value is distinct on every
 *   account in the group cannot have a consensus by construction. `Account` is
 *   the account number; no two rows share one, so the mode is a group of one and
 *   every other account "differs" from it. This is the rule, and it is derived
 *   from the rows rather than from a list, so a per machine field nobody has
 *   thought of yet is caught the first day it appears.
 *
 *   NAMED (here) — the derived rule cannot see a per machine field that happens
 *   to be CONSTANT. `Backtest` is `False` on 3,700 of the book's 3,707 readable
 *   rows: distinct-per-row never fires on it, and an account exporting
 *   `Backtest=True` is a statement about how the export was taken, not about
 *   what the account was configured to trade. `BacktestCommissionTemplate` is
 *   the same field's companion. `LicenseKey` is already dropped one layer down
 *   by parseLiveParameters (PER_CLIENT_FIELDS) and is named here as well,
 *   because the params_parsed fallback path below does not go through it.
 *
 * Three names, and they are the only ones. A list that grows is a list that ends
 * up hiding a real finding, so a candidate for it has to fail the derived rule
 * first.
 */
export const PER_MACHINE_FIELDS = new Set([
  ...PER_CLIENT_FIELDS,
  'Backtest',
  'BacktestCommissionTemplate',
]);

/* ── Instrument identity ──────────────────────────────────────────────────── */

const MONTH_CODES = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * One contract, however the grid spelled it.
 *
 * NinjaTrader writes the same contract three ways and all three are in the book:
 * `MNQ SEP26` (820 rows), `MNQ 09-26` (93) and `MNQU6` (21). Grouping on the raw
 * string is what makes this panel useless: on 2026-07-30 it splits URGO 4.5 on
 * MNQ into 54 + 7 + 1 + others, and the 14 accounts that fall out of the big
 * group land in groups too small to have a consensus — so the one account that
 * IS out of step could be any of them and would never be looked at. Normalised,
 * that day's 56 raw groups become 19 and URGO 4.5 is one group of 68.
 *
 * The contract MONTH is kept, deliberately. `NG AUG26` and `NG SEP26` are not
 * the same contract and an account still on August while the desk has rolled to
 * September is precisely the "somebody is out of date" the desk asked about. Six
 * accounts are in exactly that position on the book's last close, and
 * `contractPeers` on each group is what says so.
 *
 * `root` reuses instrumentSpecs.js rather than re-deriving ticker grammar: the
 * longest-known-root rule there already knows that `M2KU6` is M2K and not M.
 * Returns the raw text as the label when no contract can be read, which groups
 * those rows together without pretending to have parsed them.
 */
export function deskInstrumentOf(instrument) {
  const text = String(instrument || '').trim().toUpperCase();
  if (!text) return { root: '', contract: '', label: '' };
  const root = instrumentRoot(text);
  const rest = text.slice(root.length).trim();

  let month = 0;
  let year = 0;
  let match = rest.match(/^([A-Z]{3})\s*(\d{2})$/);
  if (match && MONTH_NAMES[match[1]]) {
    month = MONTH_NAMES[match[1]];
    year = 2000 + Number(match[2]);
  } else if ((match = rest.match(/^(\d{1,2})-(\d{2})$/))) {
    month = Number(match[1]);
    year = 2000 + Number(match[2]);
  } else if ((match = rest.match(/^([FGHJKMNQUVXZ])(\d)$/))) {
    // Single-digit year code. NinjaTrader writes the decade's last digit only,
    // so `U6` is 2026 while this decade lasts; there is no other reading
    // available in the string and inventing one would be worse than this.
    month = MONTH_CODES[match[1]];
    year = 2020 + Number(match[2]);
  }

  if (!month || !year) return { root: root || text, contract: '', label: root || text };
  const contract = `${year}-${String(month).padStart(2, '0')}`;
  return { root, contract, label: `${root} ${contract}` };
}

/* ── Reading a row's parameters ───────────────────────────────────────────── */

/**
 * One strategy row as a canonical name to value map, or null.
 *
 * `parameters_raw` first, `params_parsed.valuesByName` second. They are two
 * renderings of one thing — the ingest writes both from the same export — and
 * the raw string is the one ConfigDriftPanel and SetFileMatchPanel already read,
 * so preferring it is what stops three panels on one screen disagreeing about
 * what an account is running. parseLiveParameters also does the work this
 * comparison depends on: it refuses a value list whose count does not match its
 * name list rather than zipping it by index, and it states every value in ONE
 * dialect, so `True` and `true`, `1/1/2020 4:45:00 PM` and `2020-01-01T16:45:00`
 * do not read as differences.
 *
 * The fallback is not decoration: the parsed map is the only rendering that
 * survives a redacted export, and a row that carries one and no raw text would
 * otherwise be unreadable. Its values go through the same normaliser so both
 * paths speak the same dialect.
 *
 * Null, never `{}`. "This row exported nothing anyone can read" is not "this row
 * exported no settings", and a group counts the first separately.
 */
export function rowParameters(strategy) {
  const fromRaw = parseLiveParameters(strategy?.parametersRaw);
  if (fromRaw) return fromRaw;

  const named = strategy?.params?.valuesByName;
  if (!named || typeof named !== 'object') return null;
  const out = {};
  for (const [name, value] of Object.entries(named)) {
    if (!name || PER_CLIENT_FIELDS.has(name)) continue;
    out[name] = normaliseSetFileValue(value);
  }
  return Object.keys(out).length ? out : null;
}

/* ── Values ───────────────────────────────────────────────────────────────── */

function asNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Rounded to the precision the inputs carry, so 0.1 + 0.2 does not print. */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/* ── The build ────────────────────────────────────────────────────────────── */

/**
 * Which fields this group cannot be compared on, and why.
 *
 * The derived half of PER_MACHINE_FIELDS' note above. A field carried by at
 * least MIN_UNIQUE_FIELD_ACCOUNTS accounts with a different value on every one
 * of them has no mode worth the name — whatever it holds is a machine's, a
 * client's or a timestamp's, not a setting the desk agreed on.
 *
 * The consensus rule below would refuse such a field anyway (a mode of one
 * against everybody else is not a majority). Naming it separately is what keeps
 * the panel honest: "Account cannot have a consensus, it is unique per account"
 * and "the desk does not agree on MyTradeDirection" are different sentences and
 * a reader must not have to tell them apart by eye.
 */
function deskNoiseFields(byField) {
  const noise = [];
  for (const [name, values] of byField) {
    if (PER_MACHINE_FIELDS.has(name)) {
      noise.push({ name, reason: 'per-machine' });
      continue;
    }
    const present = [...values.values()].reduce((sum, list) => sum + list.length, 0);
    if (present >= MIN_UNIQUE_FIELD_ACCOUNTS && values.size === present) {
      noise.push({ name, reason: 'unique-per-account' });
    }
  }
  return noise.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One trading day's configuration groups, and who inside each differs.
 *
 * `clients` is the CRM state's client list; only the closes whose date is
 * exactly `date` are read, because the whole point is same-day comparison. A
 * client who did not close that day is absent from the day, not compared
 * against an older close of their own — their settings on the 21st say nothing
 * about what the desk was running on the 22nd.
 *
 * `parametersOf` is injected for the same reason buildConfigCohorts injects its
 * three readers: a caller testing the comparison should not have to build a
 * NinjaTrader parameter string to do it.
 */
export function buildDeskConfigOutliers(clients = [], {
  date = '',
  minAccounts = MIN_CONSENSUS_ACCOUNTS,
  consensusShare = CONSENSUS_SHARE,
  secondReadingShare = SECOND_READING_SHARE,
  parametersOf = rowParameters,
} = {}) {
  const day = String(date || '').slice(0, 10);
  // What the answer rests on, so a reader can see the denominator rather than
  // trust it. `accounts` counts an account once PER GROUP — one machine running
  // two algorithms is two accounts here and two questions on screen — and
  // `accountsCompared` is that minus the accounts in groups too small to have a
  // consensus. The two are never the same number and neither is the desk's
  // account count.
  const basis = {
    date: day,
    closes: 0,
    clients: 0,
    accounts: 0,
    rows: 0,
    readable: 0,
    unreadable: 0,
    unnamed: 0,
    groups: 0,
    compared: 0,
    tooSmall: 0,
    accountsCompared: 0,
    accountsDiffering: 0,
    // THE SAME TWO NUMBERS AS MACHINES RATHER THAN AS PAIRS, because the
    // sentence the panel prints is read as machines. On 2026-07-30
    // `accountsCompared` is 411 and `accountsDiffering` 81, and the desk that
    // day is 252 accounts of which 63 differ: Kai Moss's 1121557 is in five
    // groups and a CAM working the list top to bottom meets it five times. Both
    // pairs are on the object so the sentence and the table cannot drift apart,
    // and each says in its name which unit it is.
    accountsComparedDistinct: 0,
    accountsDifferingDistinct: 0,
  };
  if (!day) return { ...emptyResult(basis), reason: 'no-date' };

  // Pass one: every row of the day, bucketed on its full identity, with the
  // stated data series of each (family, version, contract) remembered so the
  // rows that state none can be placed.
  const buckets = new Map();
  const seriesByBase = new Map();

  for (const client of clients || []) {
    let closed = false;
    for (const daily of client?.dailyImports || []) {
      if (String(daily?.date || '').slice(0, 10) !== day) continue;
      basis.closes += 1;
      closed = true;
      for (const strategy of daily.strategies || []) {
        const family = String(strategy?.strategyFamily || '').trim()
          || String(strategy?.strategyName || '').trim();
        if (!family) continue;
        basis.rows += 1;
        const version = String(strategy?.strategyVersion || '').trim();
        const instrument = deskInstrumentOf(strategy?.instrument);
        const base = [family, version, instrument.label].join('');
        const series = String(strategy?.dataSeries || '').trim();
        if (series) {
          if (!seriesByBase.has(base)) seriesByBase.set(base, new Map());
          const counts = seriesByBase.get(base);
          counts.set(series, (counts.get(series) || 0) + 1);
        }
        if (!buckets.has(base)) buckets.set(base, []);
        buckets.get(base).push({
          client,
          strategy,
          series,
          instrument,
          family,
          version,
          spelling: String(strategy?.instrument || '').trim(),
        });
      }
    }
    if (closed) basis.clients += 1;
  }

  // Pass two: place the rows that stated no data series, and build the groups.
  //
  // A blank data series is absent information, not a data series of its own. Of
  // the book's last close 36 of 417 rows state none, and holding them out would
  // have invented six groups that nobody runs. They join the busiest stated
  // series of their own (family, version, contract) and the group SAYS how many
  // of its accounts arrived that way, so a reader can discount them. The one
  // account genuinely on a second series — Bullet Bot 1.1 on NQ at 1 Minute
  // while 106 run it at 20 Second, on 2026-07-13 — still stands alone, because
  // it stated its series and was never a blank to place.
  const groups = new Map();
  for (const [base, entries] of buckets) {
    const stated = seriesByBase.get(base) || new Map();
    const busiest = [...stated.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    for (const entry of entries) {
      const series = entry.series || (busiest ? busiest[0] : '');
      const key = `${base}${series}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          family: entry.family,
          version: entry.version,
          instrument: entry.instrument.label,
          instrumentRoot: entry.instrument.root,
          contract: entry.instrument.contract,
          dataSeries: series,
          spellings: new Set(),
          unstatedSeries: 0,
          rows: 0,
          unreadable: 0,
          unnamed: 0,
          accounts: new Map(),
          clientIds: new Set(),
          clientIdsDropped: new Set(),
        });
      }
      const group = groups.get(key);
      group.rows += 1;
      if (entry.spelling) group.spellings.add(entry.spelling);
      if (!entry.series) group.unstatedSeries += 1;

      const accountName = String(entry.strategy?.accountName || '').trim();
      if (!accountName) {
        // Counted, never compared. A strategy row whose import carries no
        // trading account cannot be attributed to anybody, and a finding nobody
        // can be told about is not a finding. buildConfigCohorts counts these
        // the same way and for the same reason.
        group.unnamed += 1;
        group.clientIdsDropped.add(entry.client.id);
        continue;
      }
      const parameters = parametersOf(entry.strategy);
      if (!parameters) {
        group.unreadable += 1;
        group.clientIdsDropped.add(entry.client.id);
        continue;
      }
      // COUNTED AFTER THE TWO GUARDS, NOT BEFORE THEM. It was counted first, so
      // a client whose only row in a group carried no trading account counted
      // as a client of the group while its account counted as nothing — and the
      // closed summary line, which is what a manager scans, then printed more
      // clients than accounts. On 2026-07-13 SYFY 1.4 MES read "9 accounts, 10
      // clients" and DJDR 1.1 YM read "7 accounts, 10 clients". Every account
      // belongs to exactly one client, so that is impossible on its face, and a
      // panel a desk cannot check is a panel it stops trusting. The clients
      // whose rows were dropped are kept separately rather than lost.
      group.clientIds.add(entry.client.id);

      const accountKey = `${entry.client.id}${accountName}`;
      if (!group.accounts.has(accountKey)) {
        group.accounts.set(accountKey, {
          clientId: entry.client.id,
          clientName: entry.client.name || entry.client.id,
          accountName,
          rows: 0,
          // A Map of name to the distinct values this account's rows carry.
          // Usually one row per account per group; 1 of the book's 417 last-close
          // rows is a second row on an account already in its group, and an
          // account whose two rows disagree about a field has to be able to say
          // so rather than having one of them silently win.
          values: new Map(),
        });
      }
      const account = group.accounts.get(accountKey);
      account.rows += 1;
      for (const [name, value] of Object.entries(parameters)) {
        if (!account.values.has(name)) account.values.set(name, new Set());
        account.values.get(name).add(value);
      }
    }
  }

  // Pass three: the consensus inside each group, and who is off it.
  const built = [...groups.values()]
    .map((group) => measureGroup(group, { minAccounts, consensusShare, secondReadingShare }));

  // The other contracts of the same algorithm running that day. An account is
  // not "out of date" for being alone on a contract, but a group of six on
  // August while forty-seven run September is the question the desk asked, and
  // it is invisible from inside a single group.
  const byAlgorithm = new Map();
  for (const group of built) {
    if (!group.contract) continue;
    const key = `${group.family}${group.version}${group.instrumentRoot}`;
    if (!byAlgorithm.has(key)) byAlgorithm.set(key, []);
    byAlgorithm.get(key).push(group);
  }
  for (const siblings of byAlgorithm.values()) {
    for (const group of siblings) {
      group.contractPeers = siblings
        .filter((other) => other.contract !== group.contract)
        .map((other) => ({
          contract: other.contract,
          instrument: other.instrument,
          accounts: other.accounts,
        }))
        .sort((a, b) => b.accounts - a.accounts || a.contract.localeCompare(b.contract));
    }
  }

  const comparedAccounts = new Set();
  const differingAccounts = new Set();
  for (const group of built) {
    basis.groups += 1;
    basis.readable += group.rows - group.unreadable - group.unnamed;
    basis.unreadable += group.unreadable;
    basis.unnamed += group.unnamed;
    basis.accounts += group.accounts;
    if (group.measured) {
      basis.compared += 1;
      basis.accountsCompared += group.accounts;
      basis.accountsDiffering += group.outliers.length;
      for (const account of group.accountList) comparedAccounts.add(`${account.clientId}\u0000${account.accountName}`);
      for (const outlier of group.outliers) differingAccounts.add(`${outlier.clientId}\u0000${outlier.accountName}`);
    } else {
      basis.tooSmall += 1;
    }
  }
  basis.accountsComparedDistinct = comparedAccounts.size;
  basis.accountsDifferingDistinct = differingAccounts.size;

  built.sort((a, b) => b.accounts - a.accounts
    || a.family.localeCompare(b.family)
    || a.instrument.localeCompare(b.instrument)
    || a.dataSeries.localeCompare(b.dataSeries));

  return { date: day, basis, groups: built, reason: null };
}

function emptyResult(basis) {
  return { date: basis.date, basis, groups: [], reason: null };
}


/**
 * One group: what the desk agrees on, what it does not, and who is off it.
 *
 * ONE RULE, over one list. Every account in the group has exactly one READING of
 * a field: the value it carries, or "does not carry it". Absence is a reading
 * and not a special case, which is what lets the same arithmetic answer "this
 * account runs a stop nobody else runs" and "this account is on a build that has
 * no stop field" without either of them borrowing the other's wording.
 *
 * Readings are ranked, and the top one is the desk's consensus if it clears
 * CONSENSUS_SHARE. Then:
 *
 *   A READING IN REAL USE is not a deviation. At least MIN_CONSENSUS_ACCOUNTS
 *   accounts and more than SECOND_READING_SHARE of the group means the desk is
 *   running two settings on purpose; it is named on the group and nobody is
 *   listed for it. Measured on the book's last close: URGO 4.5 closes at 16:45
 *   on 54 of 68 accounts and at 16:30 on 11, and the 11 are a session, not
 *   eleven mistakes. 25 of 37 IFSP accounts carry the day-of-week filters and 12
 *   carry none, which is two builds of one version rather than twelve accounts
 *   with a setting missing.
 *
 *   NO CONSENSUS AT ALL when the top reading is under CONSENSUS_SHARE. Bullet
 *   Bot's MyTradeDirection is Long on 53 accounts and Short on 45 that day.
 *   Under a plain "more than everyone else put together" majority that made 45
 *   accounts outliers on one field and turned a 98 account group into 54
 *   findings, which is a review list nobody reads twice. The finding is that the
 *   desk does not agree, said once, on the group.
 *
 *   EVERYTHING ELSE is a deviation, and its accounts are listed with the field.
 *
 *   IGNORED fields are per machine, named or derived. Not compared, and counted
 *   so the panel can say what it left out rather than leaving it to be noticed.
 */
function measureGroup(group, {
  minAccounts = MIN_CONSENSUS_ACCOUNTS,
  consensusShare = CONSENSUS_SHARE,
  secondReadingShare = SECOND_READING_SHARE,
} = {}) {
  const accounts = [...group.accounts.values()]
    .sort((a, b) => a.clientName.localeCompare(b.clientName)
      || a.accountName.localeCompare(b.accountName));

  const shape = {
    key: group.key,
    family: group.family,
    version: group.version,
    instrument: group.instrument,
    instrumentRoot: group.instrumentRoot,
    contract: group.contract,
    dataSeries: group.dataSeries,
    spellings: [...group.spellings].sort(),
    unstatedSeries: group.unstatedSeries,
    rows: group.rows,
    accounts: accounts.length,
    clients: group.clientIds.size,
    // Clients whose every row in this group was dropped (no trading account on
    // the import, or settings nobody could read). They are not clients of the
    // comparison, and counting them as such is what let a group print more
    // clients than accounts.
    clientsDropped: [...group.clientIdsDropped].filter((id) => !group.clientIds.has(id)).length,
    // The account floor can be cleared by one client running three machines.
    // Said on the group rather than silently measured or silently dropped: see
    // MIN_CONSENSUS_CLIENTS.
    singleClient: group.clientIds.size < MIN_CONSENSUS_CLIENTS,
    unreadable: group.unreadable,
    unnamed: group.unnamed,
    contractPeers: [],
    measured: false,
    reason: null,
    fields: { compared: 0, agreed: 0, split: 0, ignored: [] },
    consensus: [],
    splitFields: [],
    outliers: [],
    accountList: accounts.map((account) => ({
      clientId: account.clientId,
      clientName: account.clientName,
      accountName: account.accountName,
    })),
  };

  if (accounts.length < minAccounts) {
    // Stated, not ranked. Below the floor there is no majority to be off, so
    // there is nothing here that could be called a finding, and saying "no
    // differences" about it would be a claim this group cannot support.
    shape.reason = accounts.length ? 'too-few-accounts' : 'no-readable-parameters';
    return shape;
  }

  // field -> value -> the accounts holding it, plus the accounts whose own rows
  // disagree with each other about it.
  const byField = new Map();
  const inconsistent = new Map();
  const seen = new Set();
  for (const account of accounts) {
    for (const [name, values] of account.values) {
      seen.add(name);
      if (values.size > 1) {
        if (!inconsistent.has(name)) inconsistent.set(name, []);
        inconsistent.get(name).push({ account, values: [...values].sort() });
        continue;
      }
      const value = [...values][0];
      if (!byField.has(name)) byField.set(name, new Map());
      const holders = byField.get(name);
      if (!holders.has(value)) holders.set(value, []);
      holders.get(value).push(account);
    }
  }

  const ignored = deskNoiseFields(byField);
  const ignoredNames = new Set(ignored.map((entry) => entry.name));
  shape.fields.ignored = ignored;
  shape.measured = true;

  const differences = new Map();
  const noteDifference = (account, difference) => {
    const key = `${account.clientId}${account.accountName}`;
    if (!differences.has(key)) differences.set(key, { account, list: [] });
    differences.get(key).list.push(difference);
  };

  // ONE DENOMINATOR PER GROUP. This tested against `accounts.length` while the
  // consensus test and every share the panel prints use `population`, which is
  // `accounts.length` minus the accounts whose two rows in the group disagree
  // about that field. On the current book that is at most one account and no
  // printed figure moves, but two answers to "how big is this group" inside one
  // function is exactly what this file argues a reader must never have to tell
  // apart by eye, and the next export with a handful of duplicated rows makes
  // the 15% floor quietly stricter than the share printed beside it.
  const secondReading = (count, population) => count >= minAccounts
    && count > population * secondReadingShare;

  for (const name of [...seen].sort((a, b) => a.localeCompare(b))) {
    if (ignoredNames.has(name)) continue;
    const holders = byField.get(name) || new Map();
    const disagreeing = inconsistent.get(name) || [];
    const carriers = [...holders.values()].reduce((sum, list) => sum + list.length, 0);
    // Absence is a reading. `value: null` is "this account's export does not
    // carry this field", which is a different statement from carrying it empty
    // — and an empty value is a value, so it ranks as one.
    const missing = accounts.filter((account) => !account.values.has(name));
    const readings = [...holders.entries()]
      .map(([value, list]) => ({ value, accounts: list }))
      .concat(missing.length ? [{ value: null, accounts: missing }] : [])
      .sort((a, b) => b.accounts.length - a.accounts.length
        || String(a.value).localeCompare(String(b.value)));
    // The denominator excludes the accounts that cannot be read as one value.
    const population = carriers + missing.length;
    if (!population) {
      // Every account in the group carries this field on two rows that disagree
      // with each other, so there is no reading to be the desk's. The accounts
      // are still reported: silently dropping a field because nobody could be
      // read on it is the one outcome this module exists to avoid.
      for (const entry of disagreeing) {
        noteDifference(entry.account, {
          name,
          state: 'inconsistent',
          value: entry.values.join(', '),
          values: entry.values,
          consensus: null,
          consensusAccounts: 0,
          population: 0,
          numeric: false,
          distance: null,
          distancePct: null,
        });
      }
      continue;
    }

    shape.fields.compared += 1;
    const top = readings[0];
    const numeric = readings.every((reading) => reading.value !== null && asNumber(reading.value) !== null);
    const modeNumber = numeric ? asNumber(top.value) : null;

    if (top.accounts.length < population * consensusShare) {
      shape.fields.split += 1;
      shape.splitFields.push({
        name,
        reason: 'no-majority',
        population,
        readings: readings.map((reading) => ({
          value: reading.value,
          accounts: reading.accounts.length,
          share: Math.round((reading.accounts.length / population) * 100),
        })),
      });
      continue;
    }

    const alsoInUse = [];
    const deviations = [];
    for (const reading of readings.slice(1)) {
      if (secondReading(reading.accounts.length, population)) {
        alsoInUse.push({
          value: reading.value,
          accounts: reading.accounts.length,
          share: Math.round((reading.accounts.length / population) * 100),
        });
      } else {
        deviations.push(reading);
      }
    }

    const differing = deviations.reduce((sum, reading) => sum + reading.accounts.length, 0);
    if (readings.length === 1) shape.fields.agreed += 1;
    shape.consensus.push({
      name,
      value: top.value,
      accounts: top.accounts.length,
      population,
      share: Math.round((top.accounts.length / population) * 100),
      numeric,
      alsoInUse,
      differing,
    });

    for (const reading of deviations) {
      for (const account of reading.accounts) {
        const value = reading.value === null ? null : asNumber(reading.value);
        // Three states, three sentences. `missing` and `extra` are not
        // `different`: printing "BreakEvenOffset: (blank) vs 5" invites a CAM to
        // go and set a field that does not exist on that account's build, and
        // "5 vs (blank)" invites them to clear one the desk never had.
        let state = 'different';
        if (reading.value === null) state = 'missing';
        else if (top.value === null) state = 'extra';
        noteDifference(account, {
          name,
          state,
          value: reading.value,
          consensus: top.value,
          consensusAccounts: top.accounts.length,
          population,
          numeric,
          distance: numeric && value !== null ? round(value - modeNumber) : null,
          distancePct: numeric && value !== null && modeNumber !== 0
            ? round(((value - modeNumber) / Math.abs(modeNumber)) * 100)
            : null,
        });
      }
    }

    // An account whose two rows in one group disagree with each other has no
    // single value to compare, so it is reported as that rather than having one
    // of its own rows arbitrarily win.
    for (const entry of disagreeing) {
      noteDifference(entry.account, {
        name,
        state: 'inconsistent',
        value: entry.values.join(', '),
        values: entry.values,
        consensus: top.value,
        consensusAccounts: top.accounts.length,
        population,
        numeric: false,
        distance: null,
        distancePct: null,
      });
    }
  }

  shape.consensus.sort((a, b) => b.differing - a.differing || a.name.localeCompare(b.name));
  shape.splitFields.sort((a, b) => b.readings.length - a.readings.length
    || a.name.localeCompare(b.name));

  /* SIZING IS COMPARED AND IS NOT RANKED WITH THE REST.
   *
   * PosSize1/2/3 and PositionSize followed account size and prop-firm plan
   * long before anything here looked at them; buildConfigDrift takes an `omit`
   * regex for exactly this and says why (setFileNormalise.js: of 127
   * config-and-risk combinations on the book, 17 differ by sizing alone). This
   * module had no such split and ranked them beside BarsPeriod, so on
   * 2026-07-30 six of the 81 listed accounts differ ONLY on sizing and on
   * 2026-07-13 ten of 88 — the rows most likely to be correct by design,
   * sitting above real findings because the sort counts fields.
   *
   * They are still compared and still listed: this is a ranking decision, not a
   * wording one, and a position size nobody else runs is worth a look. It is
   * simply not what decides whether an account is at the top of the list.
   */
  const isSizing = (difference) => SIZING.test(difference.name);
  shape.outliers = [...differences.values()]
    .map(({ account, list }) => {
      const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
      const sizing = sorted.filter(isSizing);
      return {
        clientId: account.clientId,
        clientName: account.clientName,
        accountName: account.accountName,
        rows: account.rows,
        differences: sorted,
        // The two counts, because the sentence on the account row names both.
        configurationDifferences: sorted.length - sizing.length,
        sizingDifferences: sizing.length,
      };
    })
    .sort((a, b) => b.configurationDifferences - a.configurationDifferences
      || b.sizingDifferences - a.sizingDifferences
      || a.clientName.localeCompare(b.clientName)
      || a.accountName.localeCompare(b.accountName));

  return shape;
}


/**
 * The closes a day's comparison reads, by uuid.
 *
 * Exactly the day, not "at or before it" — which is what configPanelImportIds
 * does for the two panels that compare each client's own latest close. The two
 * rules are different on purpose and the difference is the whole point of this
 * panel: a client's settings from a fortnight ago are not evidence about what
 * the desk was running today.
 */
export function deskDayImportIds(clients = [], date = '') {
  const day = String(date || '').slice(0, 10);
  if (!day) return [];
  const ids = [];
  for (const client of clients || []) {
    for (const daily of client?.dailyImports || []) {
      if (String(daily?.date || '').slice(0, 10) !== day) continue;
      ids.push(daily.uuid || daily.id);
    }
  }
  return ids;
}

/**
 * The day this panel should show: the one pinned at the top of the page, or the
 * book's most recent close when nothing is pinned.
 *
 * Not `new Date()`. The ranking board it sits below was anchored to the wall
 * clock and printed $0.00 in every cell whenever the book ended before today.
 */
export function deskConfigDayFor(clients = [], asOfDate = '') {
  const pinned = String(asOfDate || '').slice(0, 10);
  if (pinned) return pinned;
  let latest = '';
  for (const client of clients || []) {
    for (const daily of client?.dailyImports || []) {
      const date = String(daily?.date || '').slice(0, 10);
      if (date > latest) latest = date;
    }
  }
  return latest;
}
