// How a CAM reads the configuration review list.
//
// buildConfigDrift decides WHAT is worth a look; nothing in this file may change
// that. Its guards (minCohort 8, outlierShare 0.15, minDominantShare 0.4) are
// what keep the list to 10 rows on the real book, and loosening them here would
// undo the only reason the panel is trusted.
//
// What this file fixes is that the finding never reached the reader. Over the
// real snapshot the panel produced 267 change entries and painted 75 of them:
// 192 (72%) sat behind an inert "+N more" with no way to open it, and 23 of the
// 29 outlier groups were truncated. The three that survived were chosen by
// Map insertion order, which configKeyOf sorts alphabetically — so all 8
// stop-loss changes on the book were hidden while BreakEven* showed 21 times out
// of 21, purely because of the letter B.

/**
 * NinjaTrader writes a TimeSpan parameter as a DateTime with a fixed sentinel
 * date. All 86 timestamp values printed by the panel on the real book carried
 * `1/1/2020`, zero exceptions — so the date component is 13 characters of noise
 * on the widest, most frequent element in a column that can be 320px wide.
 *
 * Matched, never split. Rule of this codebase: a '/' split has silently produced
 * a wrong answer three times, and `1/1/2020 4:45:00 PM` is exactly the value
 * that does it.
 */
const SENTINEL_CLOCK = /^1\/1\/2020 (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM)$/;

/**
 * The same instant in the set files' dialect.
 *
 * The XML writes `2020-01-01T16:45:00` where the export writes
 * `1/1/2020 4:45:00 PM`, and setFileNormalise.js canonicalises both sides to the
 * ISO form — so every value the set-file matcher hands this module arrives in
 * that shape. Nine fields carry times, and without this case all nine render as
 * a 19-character machine string in a column 320px wide. The drift panel never
 * produces this form, so nothing it renders changes.
 */
const SENTINEL_CLOCK_ISO = /^2020-01-01T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A sentinel-dated timestamp as a desk clock time, or null when the value is not
 * one — a real date is content and must survive untouched.
 */
export function formatClockValue(value) {
  const text = String(value ?? '').trim();
  const iso = SENTINEL_CLOCK_ISO.exec(text);
  if (iso) {
    const second = iso[3] || '00';
    return second === '00' ? `${iso[1]}:${iso[2]}` : `${iso[1]}:${iso[2]}:${second}`;
  }
  const match = SENTINEL_CLOCK.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  if (!(hour >= 1 && hour <= 12)) return null;
  const [, , minute, second = '00', meridiem] = match;
  if (hour === 12) hour = 0;
  if (meridiem === 'PM') hour += 12;
  const hh = String(hour).padStart(2, '0');
  return second === '00' ? `${hh}:${minute}` : `${hh}:${minute}:${second}`;
}

const WEEKDAY = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)Filter$/;

/**
 * Rank is what to lead with, not what to keep. Every change stays reachable; the
 * rank only decides which one gets stated in the one-line summary and what order
 * the expanded table runs in.
 *
 * Ordered by what costs money first. On the real book this moves
 * `StopLossTicks 33 → 25` — a 24% tighter stop on IFSP NG AUG26, 2 accounts —
 * from behind "+16 more" to the headline.
 */
const RANK = {
  STOP: 1,
  TARGET: 2,
  MARTINGALE: 3,
  ENTRIES: 4,
  MANAGEMENT: 5,
  ENTRY_PRICE: 6,
  FLATTEN: 7,
  SESSION: 8,
  WEEKDAY: 9,
  /** An unrecognised name can never become the headline. See headlineFor. */
  UNKNOWN: 99,
};

/**
 * Human phrases for the parameter names that actually occur on the book.
 *
 * Cosmetic only, on purpose: CamelCase broken up, a redundant `IsOn`/`Ticks`
 * suffix dropped (the unit gets its own column), digits preserved because the
 * `1/2/3` on the profit targets is the scale-out leg and the `1` on
 * `TradeStart1` counts something this data does not explain. Nothing here
 * asserts a meaning the parameter name does not already state.
 *
 * Names NOT in this map are deliberate. `EdgeLeverage`, `URGO2` and `URGO4` are
 * opaque — `URGO2 2 → 4` is the strategy name plus a digit — and dressing them
 * up as prose would tell a CAM they are understood. They render as raw
 * monospace names instead, which reads as "system name, meaning not
 * established", and they are ranked UNKNOWN so they can never be the headline.
 */
const PARAMETERS = {
  StopLossTicks: { label: 'Stop loss', rank: RANK.STOP },
  ProfitTargetTicks1: { label: 'Profit target 1', rank: RANK.TARGET },
  ProfitTargetTicks2: { label: 'Profit target 2', rank: RANK.TARGET },
  ProfitTargetTicks3: { label: 'Profit target 3', rank: RANK.TARGET },
  Martingale: { label: 'Martingale', kind: 'toggle', rank: RANK.MARTINGALE },
  MartingaleMultiplier: { label: 'Martingale multiplier', rank: RANK.MARTINGALE },
  MaxMartingales: { label: 'Max martingales', rank: RANK.MARTINGALE },
  MaxDailyEntries: { label: 'Max daily entries', rank: RANK.ENTRIES },
  LimitDailyEntries: { label: 'Limit daily entries', kind: 'toggle', rank: RANK.ENTRIES },
  BreakEvenIsOn: { label: 'Break-even', kind: 'toggle', rank: RANK.MANAGEMENT },
  BreakEvenAfterTicks: { label: 'Break-even after', rank: RANK.MANAGEMENT },
  BreakEvenOffset: { label: 'Break-even offset', rank: RANK.MANAGEMENT },
  StartTrailAfterTicks: { label: 'Start trail after', rank: RANK.MANAGEMENT },
  TrailByTicks: { label: 'Trail by', rank: RANK.MANAGEMENT },
  TrailFrequency: { label: 'Trail frequency', rank: RANK.MANAGEMENT },
  EntryOrderTickOffset: { label: 'Entry order offset', rank: RANK.ENTRY_PRICE },
  ReEntryIsOn: { label: 'Re-entry', kind: 'toggle', rank: RANK.ENTRY_PRICE },
  ReEntryWaitBars: { label: 'Re-entry wait', rank: RANK.ENTRY_PRICE },
  CloseAllOpenTradeTime: { label: 'Close all open trades', kind: 'clock', rank: RANK.FLATTEN },
  TradeStart1: { label: 'Trade start 1', kind: 'clock', rank: RANK.SESSION },
  TradeEnd1: { label: 'Trade end 1', kind: 'clock', rank: RANK.SESSION },
  RangeStart: { label: 'Range start', kind: 'clock', rank: RANK.SESSION },
  RangeEnd: { label: 'Range end', kind: 'clock', rank: RANK.SESSION },
  TradeWindowIsOn: { label: 'Trade window', kind: 'toggle', rank: RANK.SESSION },
};

for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
  // `True` on SaturdayFilter and SundayFilter for natural gas — a market that is
  // shut then — says True means blocked, not enabled. That inference is strong
  // but it is an inference, so the label stays at "Monday filter" and the value
  // at on/off. Reading it as "Monday blocked" would be this panel telling a CAM
  // something the data does not state.
  PARAMETERS[`${day}Filter`] = { label: `${day} filter`, kind: 'toggle', rank: RANK.WEEKDAY };
}

/**
 * Only the unit the raw name itself states.
 *
 * `StopLossTicks`, `TrailByTicks`, `EntryOrderTickOffset` and the three
 * `ProfitTargetTicks` legs carry it; `BreakEvenOffset` and `TrailFrequency` do
 * not, and both are plausibly ticks — which is exactly why neither gets the
 * word. A unit is a claim about magnitude.
 */
function unitOf(name) {
  if (/Tick/i.test(name)) return 'ticks';
  if (/Bars$/.test(name)) return 'bars';
  return null;
}

/** The human phrase, or the raw name when there is no safe one. */
export function describeParameter(name) {
  const key = String(name || '');
  const known = PARAMETERS[key];
  return {
    name: key,
    label: known ? known.label : key,
    mapped: Boolean(known),
    kind: known?.kind || 'number',
    unit: unitOf(key),
    rank: known ? known.rank : RANK.UNKNOWN,
    weekday: WEEKDAY.test(key),
  };
}

/**
 * A parameter value in the form the parameter is written in.
 *
 * Clock formatting keys off the value's own shape rather than the name, because
 * `1/1/2020 4:45:00 PM` proves what it is without anyone having to know what
 * `CloseAllOpenTradeTime` means. on/off keys off the name, because only the map
 * establishes that a True/False is a toggle.
 */
export function formatParameterValue(name, value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const clock = formatClockValue(text);
  if (clock) return clock;
  const known = PARAMETERS[String(name || '')];
  if (known?.kind === 'toggle') {
    // Two dialects again: the export writes `True`, the set files write `true`,
    // and setFileNormalise.js lower-cases both. 36 of the 113 unmatched values
    // measured against the library were only this. Case-insensitive here so a
    // toggle reads as on/off whichever side of the comparison it came from.
    if (/^true$/i.test(text)) return 'on';
    if (/^false$/i.test(text)) return 'off';
  }
  return text;
}

/** A value with its unit, for prose. `25 ticks`, `16:30`, `on`. */
function withUnit(formatted, unit) {
  if (formatted === null) return null;
  return unit ? `${formatted} ${unit}` : formatted;
}

/**
 * One change, ready to render.
 *
 * `cohort` is `change.from` and `here` is `change.to` — describeConfigDifference
 * builds the diff from the dominant map to the outlier map. That direction was
 * unrecoverable from the old `from → to` arrow: on the real book
 * CloseAllOpenTradeTime runs 4:45→4:30 on URGO and 3:45→4:30 on ARPD, and
 * EdgeLeverage runs False→True on OGX and True→False on RBO, so neither "the
 * right side is later" nor "the right side is riskier" could be learned. Every
 * surface built from this object names the two sides in words.
 */
export function describeChangeRow(change) {
  const meta = describeParameter(change?.name);
  const cohort = formatParameterValue(meta.name, change?.from ?? null);
  const here = formatParameterValue(meta.name, change?.to ?? null);
  return {
    ...meta,
    cohort,
    here,
    // 94 of 267 changes on the book render with one side absent (35%). The old
    // panel printed "absent" for a dropped parameter and, because JSX renders
    // null as nothing, printed a blank for an added one — `Martingale  → False`
    // with an empty left side. Both are a build difference, not a deletion.
    absentInCohort: cohort === null,
    absentHere: here === null,
  };
}

function sortChanges(rows) {
  return rows.slice().sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

/** "this account" / "these 6 accounts" — the phrase the headline needs. */
function subjectOf(count) {
  return count === 1 ? 'this account' : `these ${count} accounts`;
}

function listNames(rows, max = 3) {
  const names = rows.slice(0, max).map((row) => row.label);
  const rest = rows.length - names.length;
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

function splitPresence(rows) {
  return {
    valued: rows.filter((row) => !row.absentHere && !row.absentInCohort),
    missingHere: rows.filter((row) => row.absentHere),
    extraHere: rows.filter((row) => row.absentInCohort),
  };
}

/**
 * A build difference is a second fact, not a competing headline.
 *
 * IFSP-PF NG SEP26 is the case that forced this. Its single account differs in
 * 22 settings, and the highest-ranked value change is a stop of 33 against the
 * cohort's 30 — a 3-tick difference that is the least interesting thing in the
 * group. The fact worth a CAM's attention is that the account runs a build
 * carrying Martingale, MartingaleMultiplier 2 and MaxMartingales 5, which the
 * cohort's build has no fields for at all. Ranking could not surface both, so
 * the presence difference gets its own line.
 *
 * Returns null when the headline already states it, so nothing is said twice.
 */
export function buildNoteFor(changes) {
  const rows = sortChanges(changes.map(describeChangeRow));
  const { valued, missingHere, extraHere } = splitPresence(rows);
  if (!valued.length) return null;
  if (!missingHere.length && !extraHere.length) return null;

  const parts = [];
  if (extraHere.length) {
    parts.push(`carries ${listNames(extraHere)}, which the cohort's has not`);
  }
  if (missingHere.length && missingHere.every((row) => row.weekday)) {
    parts.push(`no day-of-week filters here, ${missingHere.length} in the cohort's`);
  } else if (missingHere.length) {
    parts.push(`${missingHere.length} ${plural(missingHere.length, 'setting', 'settings')} `
      + `the cohort has (${listNames(missingHere)}) are not in it`);
  }
  // Same version string on both sides for every one of these on the real book —
  // `0 - IFSP-1.1` on the cohort and on the outlier — so nothing else in the row
  // reveals that the parameter list itself differs.
  return `Different build: ${parts.join('; ')}.`;
}

/**
 * The change the headline leads with, or null when the headline is not about a
 * single change.
 *
 * Exported so the expanded table can mark the row the sentence above it is
 * talking about. Pulled OUT of headlineFor rather than recomputed beside it: two
 * copies of "which change leads" is a fork waiting to happen, and the failure
 * would be silent — a table with the wrong row marked reads exactly like a table
 * with the right one marked.
 */
export function leadChangeOf(changes = []) {
  const rows = sortChanges(changes.map(describeChangeRow));
  const { valued } = splitPresence(rows);
  const top = valued[0];
  // An unrecognised name can never be the lead, for the same reason it can never
  // be the headline: `URGO2 2 → 4` is the strategy name plus a digit.
  if (!top || top.rank === RANK.UNKNOWN) return null;
  return top;
}

/**
 * The one line a CAM reads to know what this group is.
 *
 * Leads with the highest-ranked change that has a value on both sides, because a
 * value change is the only kind that states a number a CAM can act on. When
 * there is none, the group is a build difference and says so — the clearest case
 * on the book is IFSP NG AUG26, 6 accounts whose entire diff is 7 weekday
 * filters going absent, which the old panel spent three slots on and summarised
 * as `FridayFilter True → absent MondayFilter False → absent …`.
 */
export function headlineFor(changes, count) {
  const rows = sortChanges(changes.map(describeChangeRow));
  if (!rows.length) {
    // 0 of 29 groups on the book. describeConfigDifference returns an empty diff
    // only when a parameter string could not be parsed into named fields, and
    // inventing a comparison there is worse than declining one.
    return 'These settings could not be compared field by field against the cohort.';
  }

  const subject = subjectOf(count);
  const { valued, missingHere, extraHere } = splitPresence(rows);

  if (valued.length) {
    const top = valued[0];
    if (top.rank === RANK.UNKNOWN) {
      // Reachable only when every valued change is an unrecognised name. 0 of 29
      // drift groups on this book, and the guard is the point: URGO2 and URGO4
      // must never be the sentence a CAM is handed.
      //
      // No longer hypothetical. The observed-reference section reaches it on its
      // only finding: G4M's single outlier differs from its cohort in
      // `EdgeLeverage` alone, which is deliberately unmapped, so this is the
      // whole sentence that account gets. It read "1 setting differ from the
      // cohort" — the plural helper covered the noun and not the verb, and the
      // one branch that had never rendered was the one carrying the typo.
      return `${plural(valued.length, '1 setting', `${valued.length} settings`)} `
        + `${plural(valued.length, 'differs', 'differ')} from the cohort, `
        + 'none of them a named risk control — open the row for the raw parameters.';
    }
    // The same change leadChangeOf returns, by construction: both take the first
    // valued row of the same sorted list and both refuse an unknown name.
    const here = withUnit(top.here, top.unit);
    const cohort = top.cohort;
    return `${top.label}: ${here} on ${subject}, ${cohort} in the cohort.`;
  }

  if (missingHere.length && missingHere.every((row) => row.weekday)) {
    return `This build has no day-of-week filters; the cohort's build has ${missingHere.length}.`;
  }
  if (missingHere.length) {
    return `This build does not carry ${missingHere.length} `
      + `${plural(missingHere.length, 'setting', 'settings')} the cohort's does: ${listNames(missingHere)}.`;
  }
  return `This build carries ${extraHere.length} `
    + `${plural(extraHere.length, 'setting', 'settings')} the cohort's does not: ${listNames(extraHere)}.`;
}

/**
 * Who is affected, grouped by client rather than by strategy row.
 *
 * A CAM works client-by-client and the panel was organised algorithm-by-
 * algorithm, so the real shape of this book was invisible: 15 of the 29 groups
 * belong to a single client — Avery Frost owns all 5 accounts in one IFSP group
 * — and 21 accounts appear in more than one row, `Kai Moss · 1121557` in four.
 *
 * Two rendering casualties are handled here. Duplicates: `Avery Frost ·
 * BDG9159854231060` was listed twice inside one group, two strategy_snapshots
 * rows for the same account with byte-identical parameters. Unnamed rows: Devon
 * North's strategies carry `trading_account_id = null`, which rendered as two
 * identical bare client names. They are counted, not merged and not invented —
 * two unidentifiable rows are not one account.
 */
export function rollUpAccounts(accounts = []) {
  const byClient = new Map();
  for (const account of accounts) {
    const id = account?.clientId ?? account?.clientName ?? '';
    if (!byClient.has(id)) {
      byClient.set(id, {
        clientId: id,
        clientName: account?.clientName || String(id),
        accounts: [],
        seen: new Set(),
        unnamedRows: 0,
        rows: 0,
      });
    }
    const client = byClient.get(id);
    client.rows += 1;
    const name = String(account?.accountName || '').trim();
    if (!name) {
      client.unnamedRows += 1;
      continue;
    }
    if (client.seen.has(name)) continue;
    client.seen.add(name);
    client.accounts.push(name);
  }
  return [...byClient.values()]
    .map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName,
      accounts: client.accounts,
      unnamedRows: client.unnamedRows,
      rows: client.rows,
    }))
    .sort((a, b) => b.rows - a.rows || a.clientName.localeCompare(b.clientName));
}

/**
 * How many accounts, as opposed to how many strategy rows.
 *
 * `outlier.count` counts strategy_snapshots rows, and on the real book one group
 * is 5 rows over 4 accounts — Avery Frost's `BDG9159854231060` appears twice,
 * two rows with byte-identical parameters_raw. A group headed "5 accounts" above
 * a list of 4 account numbers is the kind of mismatch that costs a panel its
 * credibility, and the CAM has no way to tell which number is the wrong one.
 *
 * Unidentifiable rows are counted separately, never folded in: two rows with no
 * trading account on the import are not one account, and they are not two
 * either — they are two rows nobody can resolve yet.
 */
export function countAccounts(accounts = []) {
  const pairs = new Set();
  let unnamedRows = 0;
  let rows = 0;
  for (const account of accounts) {
    rows += 1;
    const name = String(account?.accountName || '').trim();
    if (!name) { unnamedRows += 1; continue; }
    pairs.add(`${account?.clientId ?? account?.clientName}${name}`);
  }
  return { accounts: pairs.size, unnamedRows, rows, total: pairs.size + unnamedRows };
}

/** The short who-line on the collapsed row. Full account numbers live inside. */
function whoLineOf(clients) {
  const named = clients.slice(0, 2).map((client) => client.clientName);
  const rest = clients.length - named.length;
  const who = rest > 0 ? `${named.join(', ')} +${rest} more` : named.join(', ');
  return clients.length === 1 ? `${who} — one client's book` : who;
}

/**
 * How many algorithm rows open on their own.
 *
 * One. Every algorithm is a row either way — the number only decides how many
 * arrive already expanded, and one is enough to show what the panel is without
 * burying the other nine under it.
 *
 * It used to be eight, from when a row past the limit was hidden inside a second
 * disclosure and eight was how many the panel could afford to show. It could not
 * afford eight: measured over the real book, the eight open rows and their 29
 * always-visible group summaries put 1,241 words on screen before the reader
 * touched anything, and the list of ten algorithms — the one thing a reader
 * needs to pick from — was the one thing that could not be seen at once.
 */
export const DEFAULT_OPEN_ROWS = 1;

/**
 * Everything the panel renders, derived once.
 *
 * `limit` decides how many rows open, and NOTHING else. There is no second fold:
 * every algorithm is a row in one list, closed rows included, so the ten
 * findings on this book are ten lines a reader can see together. The previous
 * shape kept rows past the limit inside a `2 more algorithms` disclosure, which
 * was itself the fix for an older version that dropped them outright — and that
 * one had hidden IFSP-PF NG SEP26, 1 account with 22 changes running
 * PT 43/53/73 · SL 33 against a cohort on PT 200/400/500 · SL 30, because
 * sorting by account count put the largest configuration distance on the book
 * below the fold. A closed row that states its own worst finding needs neither.
 */
export function buildDriftView(rows = [], { limit = DEFAULT_OPEN_ROWS } = {}) {
  const view = rows.map((row) => {
    const groups = row.outliers.map((outlier, index) => {
      const changes = sortChanges((outlier.changes || []).map(describeChangeRow));
      const clients = rollUpAccounts(outlier.accounts);
      const tally = countAccounts(outlier.accounts);
      return {
        // Not the label. `PT …/… · SL …` collides on 6 of the 8 visible rows —
        // URGO MNQ SEP26 has 5 groups and 3 distinct labels — which is the exact
        // failure describeConfigDifference was written to fix, left in the key.
        key: `${row.family}|${row.instrument}|${index}`,
        count: tally.total,
        tally,
        label: outlier.label,
        sameLabelAsCohort: outlier.label === row.dominant.label,
        headline: headlineFor(outlier.changes || [], tally.total),
        buildNote: buildNoteFor(outlier.changes || []),
        /** Which change the headline is about, so the table can mark that row. */
        leadName: leadChangeOf(outlier.changes || [])?.name || null,
        changes,
        // Stated once above the block instead of as a tooltip on each name.
        // These are the parameters with no safe plain-language reading — the
        // rank-99 tail — and a reader who cannot see where the named settings
        // stop is being asked to weigh `URGO4 2 → 4` against a stop loss.
        namedChanges: changes.filter((change) => change.mapped),
        unnamedChanges: changes.filter((change) => !change.mapped),
        topRank: changes.length ? changes[0].rank : RANK.UNKNOWN,
        clients,
        whoLine: whoLineOf(clients),
        singleClient: clients.length === 1,
      };
    });
    const rowTally = countAccounts(row.outliers.flatMap((outlier) => outlier.accounts || []));
    return {
      key: `${row.family}|${row.instrument}`,
      family: row.family,
      instrument: row.instrument,
      cohort: row.cohort,
      dominant: row.dominant,
      versions: row.versions,
      // The domain's outlierAccounts is a strategy-row count. Kept, because it
      // is what the cohort share is computed against, but never labelled
      // "accounts" again.
      outlierRows: row.outlierAccounts,
      tally: rowTally,
      // Most material first inside a row. The domain orders outliers by account
      // count, which ranked a 9-account 15-minute close-time difference above a
      // 1-account 22-parameter one.
      groups: groups.sort((a, b) => a.topRank - b.topRank || b.count - a.count),
    };
  });

  for (const row of view) {
    // What a closed row says about itself. Without this a collapsed algorithm is
    // a name and a number, and a reader has to open all ten to find out which
    // one is worth opening.
    row.worst = row.groups.length ? row.groups[0].headline : null;
    row.findings = row.groups.length;
  }

  return {
    rows: view,
    /** How many of `rows` arrive open. Never how many exist. */
    openCount: Math.min(Math.max(0, limit), view.length),
    totals: totalsOf(rows),
    recurring: recurringChangeOf(view),
  };
}

/**
 * The headline counts, each named for what it actually counts.
 *
 * The old line said "72 accounts". 72 is strategy rows: those 72 rows are 43
 * distinct client-and-account pairs, because 21 accounts appear in more than one
 * algorithm row — Harper Juniper in 7 of the 10. Calling rows accounts inflated
 * the only number on the panel by two thirds.
 */
export function totalsOf(rows = []) {
  const pairs = new Set();
  const clients = new Set();
  let unnamedRows = 0;
  let strategyRows = 0;
  for (const row of rows) {
    for (const outlier of row.outliers || []) {
      for (const account of outlier.accounts || []) {
        strategyRows += 1;
        clients.add(account.clientId ?? account.clientName);
        const name = String(account.accountName || '').trim();
        // An unidentifiable row cannot be resolved to an account, so it is not
        // folded into one. Two of them on this book, both Devon North.
        if (!name) { unnamedRows += 1; continue; }
        pairs.add(`${account.clientId ?? account.clientName}${name}`);
      }
    }
  }
  return {
    strategyRows,
    accounts: pairs.size,
    unnamedRows,
    clients: clients.size,
    algorithms: rows.length,
  };
}

/**
 * The one fact the panel was making a CAM derive over and over.
 *
 * `Close all open trades → 16:30` is the entire finding for 6 outlier groups and
 * appears in 14 of 29, covering 44 accounts across 7 of the 10 algorithms. It was
 * 19 of the 75 chips the old panel ever painted — a quarter of everything it
 * showed, spent restating one operational decision fourteen times.
 *
 * Keyed on the parameter and the value on THIS side only. The cohort side is
 * reported as the set of values it actually takes rather than as one number,
 * because it takes three of them here — 15:45, 16:45 and 16:50 — so there is no
 * single "the cohort runs X" to state, and picking one would be the panel
 * inventing a norm the book does not have. Declines below 3 groups or a quarter
 * of them: a coincidence stated as a pattern is worse than no line at all.
 *
 * Keys are joined with nothing at all, never '/'. `1/1/2020 4:30:00 PM` is
 * exactly the value that has broken a '/' split in this codebase three times.
 */
export function recurringChangeOf(view = []) {
  const counts = new Map();
  let groups = 0;
  for (const row of view) {
    for (const group of row.groups) {
      groups += 1;
      for (const change of group.changes) {
        if (change.absentHere || change.absentInCohort) continue;
        const key = `${change.name}${change.here}`;
        if (!counts.has(key)) {
          counts.set(key, {
            label: change.label,
            value: withUnit(change.here, change.unit),
            groups: 0,
            accounts: 0,
            algorithms: new Set(),
            cohortValues: new Set(),
          });
        }
        const entry = counts.get(key);
        entry.groups += 1;
        // group.count is accounts, not strategy_snapshots rows — see
        // countAccounts. The old panel conflated the two everywhere.
        entry.accounts += group.count;
        entry.algorithms.add(row.key);
        entry.cohortValues.add(change.cohort);
      }
    }
  }
  if (!groups) return null;
  const top = [...counts.values()].sort((a, b) => b.groups - a.groups)[0];
  if (!top || top.groups < 3 || top.groups / groups < 0.25) return null;
  return {
    label: top.label,
    value: top.value,
    groups: top.groups,
    totalGroups: groups,
    accounts: top.accounts,
    algorithms: top.algorithms.size,
    cohortValues: [...top.cohortValues].sort(),
  };
}
