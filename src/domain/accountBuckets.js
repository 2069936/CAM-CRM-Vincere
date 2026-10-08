import { ACCOUNT_STATUSES, ACCOUNT_TYPES } from './reconcile.js';

/* ────────────────────────────────────────────────────────────────────────────
 * WHERE EACH REGISTRY ACCOUNT GOES, now that the database says what the closes
 * saw of it (step 65).
 *
 * Pedro's problem, in his words: the registry carries accounts that already
 * failed at the prop firm but still read Active, so they light up as "never
 * sampled" on the live tracker and pile up on the client page, and a CAM cannot
 * tell a dead account from a new one from a missing one. The database now
 * writes an observation on every row (trading_accounts.observed_state and its
 * five companions, refreshed whenever a close lands) and marks a breached
 * account Failed by itself. This module turns one client's registry into the
 * six buckets a screen prints, with one sentence each, so the lights and the
 * client page can stop showing a dead account everywhere and say why.
 *
 * THE SIX BUCKETS, and the order the questions are asked in:
 *
 *   retired              status Failed, Inactive or Reserve, or account type
 *                        Inactive / Ignore. Nothing is expected of these, so
 *                        no light and no question.
 *   looksFailed          still Active or Payout Hold but the closes say
 *                        breached. Rare once the auto fail runs; it is the
 *                        shape when auto_fail_on_breach is off, and when a
 *                        stale browser tab re-uploaded a close and reset a
 *                        status the database had set.
 *   goneFromClose        absent from at least stale_closes of the client's
 *                        closes. A reporting fact, not a death: six accounts
 *                        on this book skipped a close and came back.
 *   newNotSeen           never in a close, and added within new_account_days.
 *                        ALSO in `expected`, so a light can be drawn for it
 *                        with the word "new" beside it.
 *   registeredNeverSeen  never in a close and older than new_account_days (or
 *                        with no date added at all, which cannot claim new).
 *   expected             what the close should show: seen, plus the new ones,
 *                        plus every account the database has not observed yet
 *                        (observed_state null, a row read before step 65 ran).
 *                        Those stay expected on purpose: no observation is not
 *                        evidence of anything.
 *
 * Simulation accounts are not special here: they never breach (the database
 * rule says so), so they come out as seen, absent or never seen like any other
 * row, and the status decides whether they are retired.
 *
 * THE OBSERVATION IS READ, NEVER COMPUTED HERE. The browser only holds each
 * client's latest close, so it cannot count absences; the database can and
 * does. This module trusts observed_state and prints it. Dates are compared
 * as UTC calendar days, the way accountLifecycle.js does.
 * ──────────────────────────────────────────────────────────────────────────── */

export const OBSERVED_STATES = Object.freeze({
  SEEN: 'seen',
  BREACHED: 'breached',
  ABSENT: 'absent',
  NEVER_SEEN: 'never_seen',
});

/** The column defaults of account_observation_settings, for a database that
 * has not run step 65 or a read that failed. */
export const ACCOUNT_OBSERVATION_DEFAULTS = Object.freeze({
  staleCloses: 5,
  autoFailOnBreach: true,
  newAccountDays: 14,
});

export const BUCKET_KEYS = Object.freeze([
  'expected', 'looksFailed', 'goneFromClose', 'newNotSeen', 'registeredNeverSeen', 'retired',
]);

const EXPECTED_STATUSES = new Set([ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.PAYOUT_HOLD]);
const RETIRED_STATUSES = new Set([ACCOUNT_STATUSES.FAILED, ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE]);

function isoDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plural(count, word, words = `${word}s`) {
  return count === 1 ? word : words;
}

function range(values, unit) {
  const list = values.filter((value) => Number.isInteger(value));
  if (!list.length) return null;
  const min = Math.min(...list);
  const max = Math.max(...list);
  if (min === max) return `${min} ${plural(min, unit)}`;
  return `${min} to ${max} ${unit}s`;
}

function settingsOf(settings) {
  const newDays = integerOrNull(settings?.newAccountDays);
  const stale = integerOrNull(settings?.staleCloses);
  return {
    newAccountDays: newDays !== null && newDays >= 0 ? newDays : ACCOUNT_OBSERVATION_DEFAULTS.newAccountDays,
    staleCloses: stale !== null && stale > 0 ? stale : ACCOUNT_OBSERVATION_DEFAULTS.staleCloses,
  };
}

/** One registry entry as the buckets carry it. */
function rowOf(accountName, meta, today) {
  const dateAdded = isoDay(meta?.dateAdded);
  return {
    accountName,
    alias: meta?.alias || accountName,
    status: meta?.status || ACCOUNT_STATUSES.ACTIVE,
    accountType: meta?.accountType || ACCOUNT_TYPES.UNASSIGNED,
    observedState: meta?.observedState || null,
    closesMissed: integerOrNull(meta?.closesMissed),
    lastCloseSeenOn: isoDay(meta?.lastCloseSeenOn),
    breachedOn: isoDay(meta?.breachedOn),
    breachReading: numberOrNull(meta?.breachReading),
    dateAdded,
    daysSinceAdded: daysBetween(dateAdded, today),
    reason: '',
  };
}

function retiredReason(row) {
  if (RETIRED_STATUSES.has(row.status)) return row.status;
  if (row.accountType === ACCOUNT_TYPES.IGNORE) return 'Ignored';
  return null;
}

function countBy(rows, pick) {
  const counts = new Map();
  for (const row of rows) {
    const key = pick(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function expectedSentence(rows) {
  const n = rows.length;
  if (!n) return null;
  const parts = [];
  const seen = rows.filter((row) => row.reason === 'seen').length;
  const fresh = rows.filter((row) => row.reason === 'new').length;
  const unobserved = rows.filter((row) => row.reason === 'not observed').length;
  if (seen) parts.push(`${seen} seen in a close`);
  if (fresh) parts.push(`${fresh} new`);
  if (unobserved) parts.push(`${unobserved} not observed yet`);
  return `${n} expected on the close${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

function looksFailedSentence(rows) {
  const n = rows.length;
  if (!n) return null;
  return `${n} ${plural(n, 'account')} ${plural(n, 'looks', 'look')} failed, breached on the close, not shown`;
}

function goneSentence(rows) {
  const n = rows.length;
  if (!n) return null;
  const closes = range(rows.map((row) => row.closesMissed), 'close');
  return `${n} gone from the close${closes ? ` for ${closes}` : ''}`;
}

function newSentence(rows) {
  const n = rows.length;
  if (!n) return null;
  const days = rows.map((row) => row.daysSinceAdded).filter((value) => Number.isInteger(value));
  let when = '';
  if (days.length) {
    const min = Math.min(...days);
    const max = Math.max(...days);
    if (min === max) when = min <= 0 ? ', added today' : `, added ${min} ${plural(min, 'day')} ago`;
    else when = `, added ${Math.max(min, 0)} to ${max} days ago`;
  }
  return `${n} new${when}, not seen in a close yet`;
}

function neverSeenSentence(rows, newAccountDays) {
  const n = rows.length;
  if (!n) return null;
  const undated = rows.filter((row) => row.daysSinceAdded === null).length;
  const tail = undated === n
    ? ' with no date added'
    : `, added more than ${newAccountDays} ${plural(newAccountDays, 'day')} ago${undated ? ` or with no date added` : ''}`;
  return `${n} registered and never seen in a close${tail}`;
}

function retiredSentence(rows) {
  const n = rows.length;
  if (!n) return null;
  const counts = countBy(rows, (row) => row.reason);
  const order = [ACCOUNT_STATUSES.FAILED, ACCOUNT_STATUSES.INACTIVE, ACCOUNT_STATUSES.RESERVE, 'Ignored'];
  const parts = order.filter((key) => counts.get(key)).map((key) => `${counts.get(key)} ${key}`);
  return `${n} retired: ${parts.join(', ')}`;
}

function bucket(key, rows, sentence) {
  return { key, accounts: rows, count: rows.length, sentence };
}

/**
 * Sorts one client's registry into the six buckets.
 *
 * @param {Record<string, object>} registry client.accountRegistry: account name
 *   to meta, as accountMetaFromRow builds it (observedState, closesMissed,
 *   lastCloseSeenOn, breachedOn, breachReading, dateAdded, status, accountType).
 * @param {{now?: Date|number|string, settings?: {newAccountDays?: number, staleCloses?: number}}} options
 *   `now` anchors "new"; `settings` is the account_observation_settings row as
 *   loadSupabaseAccountObservationSettings maps it, defaults when absent.
 */
export function bucketRegistryAccounts(registry, { now = Date.now(), settings = null } = {}) {
  const today = isoDay(now instanceof Date ? now : new Date(now)) || isoDay(new Date());
  const tuned = settingsOf(settings);
  const rows = Object.entries(registry && typeof registry === 'object' ? registry : {})
    .filter(([accountName]) => Boolean(accountName))
    .map(([accountName, meta]) => rowOf(accountName, meta || {}, today))
    .sort((left, right) => left.accountName.localeCompare(right.accountName));

  const expected = [];
  const looksFailed = [];
  const goneFromClose = [];
  const newNotSeen = [];
  const registeredNeverSeen = [];
  const retired = [];

  for (const row of rows) {
    const retire = retiredReason(row);
    if (retire) {
      retired.push({ ...row, reason: retire });
      continue;
    }
    const liveStatus = EXPECTED_STATUSES.has(row.status);
    switch (row.observedState) {
      case OBSERVED_STATES.BREACHED:
        if (liveStatus) looksFailed.push({ ...row, reason: 'breached' });
        else expected.push({ ...row, reason: 'breached' });
        break;
      case OBSERVED_STATES.ABSENT:
        goneFromClose.push({ ...row, reason: 'absent' });
        break;
      case OBSERVED_STATES.NEVER_SEEN:
        if (row.daysSinceAdded !== null && row.daysSinceAdded <= tuned.newAccountDays) {
          const fresh = { ...row, reason: 'new' };
          newNotSeen.push(fresh);
          expected.push(fresh);
        } else {
          registeredNeverSeen.push({ ...row, reason: 'never seen' });
        }
        break;
      case OBSERVED_STATES.SEEN:
        expected.push({ ...row, reason: 'seen' });
        break;
      default:
        // No observation on the row: a database that has not run step 65, or a
        // row read before the first close refreshed it. Not evidence of anything.
        expected.push({ ...row, reason: 'not observed' });
    }
  }

  return {
    today,
    settings: tuned,
    total: rows.length,
    expected: bucket('expected', expected, expectedSentence(expected)),
    looksFailed: bucket('looksFailed', looksFailed, looksFailedSentence(looksFailed)),
    goneFromClose: bucket('goneFromClose', goneFromClose, goneSentence(goneFromClose)),
    newNotSeen: bucket('newNotSeen', newNotSeen, newSentence(newNotSeen)),
    registeredNeverSeen: bucket('registeredNeverSeen', registeredNeverSeen, neverSeenSentence(registeredNeverSeen, tuned.newAccountDays)),
    retired: bucket('retired', retired, retiredSentence(retired)),
  };
}

/** The names a light should be drawn for: the expected bucket, as a Set. */
export function expectedAccountNameSet(buckets) {
  return new Set((buckets?.expected?.accounts || []).map((row) => row.accountName));
}

/* ── What a light needs from the registry, in one call ────────────────────────
 *
 * The three screens with a light (the overview tiles, the desk drawer, the
 * client page strip) ask the same question of a registry: which names get a
 * pill, which of those are new, and what to say about the rest. Asked here so
 * the three cannot answer differently.
 *
 * THE FOLDED LINE. Pedro's words: show only the accounts expected to trade, and
 * say in one collapsed line why the others are not shown, so a CAM can tell a
 * dead account from a new one from a missing one. The line is the bucket
 * sentences of what has no light (looks failed, gone, never seen, retired) in
 * the order the questions are asked, and behind a Show toggle each hidden name
 * with a reason word and, one hover away, what the close saw of it. Nothing at
 * all when every account is expected: a new account is expected and shown, so
 * it is never in the line; it says "new" on its own pill instead.
 *
 * AN ACCOUNT THE VPS IS SAMPLING KEEPS ITS LIGHT, whatever the close said of
 * it: NinjaTrader still naming an account that looks failed is a question
 * worth a pill, not a thing to hide. The caller hands in the sampled names and
 * the line counts only what has no light anywhere.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The word printed beside a hidden account's name in the folded list, by the
 * row's bucket reason. The retired reasons are the status words themselves. */
export const NOT_SHOWN_WORDS = Object.freeze({
  breached: 'looks failed',
  absent: 'gone from the close',
  'never seen': 'never seen in a close',
  [ACCOUNT_STATUSES.FAILED]: ACCOUNT_STATUSES.FAILED,
  [ACCOUNT_STATUSES.INACTIVE]: ACCOUNT_STATUSES.INACTIVE,
  [ACCOUNT_STATUSES.RESERVE]: ACCOUNT_STATUSES.RESERVE,
  Ignored: 'Ignored',
});

function wholeDollars(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** What the close saw of a hidden account, for the hover on its name. */
function notShownDetail(row) {
  switch (row.reason) {
    case 'breached': {
      const when = row.breachedOn ? ` on ${row.breachedOn}` : ' on the close';
      const reading = row.breachReading !== null ? `, reading ${wholeDollars(row.breachReading)}` : '';
      return `Breached${when}${reading}, status still ${row.status}.`;
    }
    case 'absent': {
      const closes = Number.isInteger(row.closesMissed) && row.closesMissed > 0
        ? ` for ${row.closesMissed} ${plural(row.closesMissed, 'close')}`
        : '';
      const seen = row.lastCloseSeenOn ? `, last seen ${row.lastCloseSeenOn}` : '';
      return `Gone from the close${closes}${seen}.`;
    }
    case 'never seen':
      return `Never seen in a close${row.dateAdded ? `, added ${row.dateAdded}` : ', no date added'}.`;
    case 'Ignored':
      return `Account type ${ACCOUNT_TYPES.IGNORE}.`;
    default:
      return `Status ${row.reason}.`;
  }
}

/** "Added 3 days ago, not seen in a close yet." for a new account's pill. */
function newAccountWords(row) {
  const days = row.daysSinceAdded;
  const when = !Number.isInteger(days) || days <= 0 ? 'today' : `${days} ${plural(days, 'day')} ago`;
  return `Added ${when}, not seen in a close yet.`;
}

/**
 * The one folded line for the registry accounts without a light.
 *
 * @param {object} buckets from bucketRegistryAccounts.
 * @param {{except?: Iterable<string>}} [options] names to leave out because they
 *   have a light anyway: the accounts the VPS is sampling.
 * @returns {{count: number, sentence: string, accounts: object[]}|null} null when
 *   nothing is hidden. `accounts` are the hidden rows in the order of the
 *   questions (looks failed, gone, never seen, retired), each with `word` and
 *   `detail` added.
 */
export function notShownAccounts(buckets, { except = [] } = {}) {
  const skip = new Set(except);
  const keep = (bucket) => (bucket?.accounts || []).filter((row) => !skip.has(row.accountName));
  const looksFailed = keep(buckets?.looksFailed);
  const gone = keep(buckets?.goneFromClose);
  const neverSeen = keep(buckets?.registeredNeverSeen);
  const retired = keep(buckets?.retired);
  const hidden = [...looksFailed, ...gone, ...neverSeen, ...retired];
  if (!hidden.length) return null;
  const newAccountDays = buckets?.settings?.newAccountDays ?? ACCOUNT_OBSERVATION_DEFAULTS.newAccountDays;
  const parts = [
    // "not shown" is the line's own heading, so the bucket sentence drops it.
    looksFailedSentence(looksFailed)?.replace(/, not shown$/, ''),
    goneSentence(gone),
    neverSeenSentence(neverSeen, newAccountDays),
    retiredSentence(retired),
  ].filter(Boolean);
  return {
    count: hidden.length,
    sentence: `Not shown: ${parts.map((part) => `${part}.`).join(' ')}`,
    accounts: hidden.map((row) => ({
      ...row,
      word: NOT_SHOWN_WORDS[row.reason] || row.reason,
      detail: notShownDetail(row),
    })),
  };
}

/**
 * Everything a light needs from one registry.
 *
 * @param {Record<string, object>|null} registry client.accountRegistry.
 * @param {{now?: Date|number|string, settings?: object|null, sampled?: Iterable<string>}} [options]
 *   `sampled` are the account names the VPS has a sample for; they keep a light
 *   whatever the close said, so the folded line leaves them out.
 * @returns {{buckets: object, names: string[], fresh: Map<string, string>, notShown: object|null}}
 *   `names` are the expected accounts, sorted, a pill each; `fresh` maps the
 *   new ones among them to their sentence; `notShown` is the folded line or null.
 */
export function registryLights(registry, { now = Date.now(), settings = null, sampled = [] } = {}) {
  const buckets = bucketRegistryAccounts(registry, { now, settings });
  const expected = buckets.expected.accounts;
  return {
    buckets,
    names: expected.map((row) => row.accountName),
    fresh: new Map(expected.filter((row) => row.reason === 'new').map((row) => [row.accountName, newAccountWords(row)])),
    notShown: notShownAccounts(buckets, { except: sampled }),
  };
}
