// Which strategy families the book is actually exposed to.
//
// The strategies table answers "what is this account running". It cannot answer
// "which algorithm is the firm most exposed to", because that question is about
// every client at once: how tight the stop is, how far the target sits, and how
// often the thing fires.
//
// Exposure is fills per day divided by reward:risk. A family that fires ten
// times a day for half a point of reward per point of risk is not the same
// animal as one that fires once for three, and a list of strategy names shows
// the two as equals.
//
// Pure: state in, plain data out. Nothing here reads a clock or touches I/O.

const round2 = (value) => Math.round(value * 100) / 100;

function numeric(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Median of the samples, or null when there are none.
 *
 * A median over zero samples is unknown, not zero. Returning 0 would put a
 * family with no stop on record at the top of a risk ranking forever.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* ── Parameters ───────────────────────────────────────────────────────────── */

/**
 * Splits the value list on '/' without breaking the dates inside it.
 *
 * NinjaTrader writes times as `1/1/2020 4:45:00 PM`, so a naive split turns one
 * value into three. A real URGO string gave 37 fragments against 31 names, and
 * the misalignment does not announce itself: every value after the first date
 * lands under the wrong name, so a stop reads as a trail frequency.
 *
 * The year must be followed by a time. `^\d{4}` alone — which is all the export
 * redactor needs, see scripts/redact-export.mjs — also matches a 1200-tick
 * target, and `PosSize2/PosSize3/ProfitTargetTicks1` of `1/0/1200` would be
 * swallowed into a single fake date.
 */
function splitValues(text) {
  const parts = text.split('/');
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index + 2 < parts.length
      && /^\d{1,2}$/.test(parts[index])
      && /^\d{1,2}$/.test(parts[index + 1])
      && /^\d{4}\s+\d{1,2}:\d{2}/.test(parts[index + 2])) {
      out.push(`${parts[index]}/${parts[index + 1]}/${parts[index + 2]}`);
      index += 2;
    } else {
      out.push(parts[index]);
    }
  }
  return out;
}

/**
 * `v1/v2/.../vN (Name1/Name2/.../NameN)` as a name → value object, or null.
 *
 * The counts must match. A set that does not line up is dropped whole rather
 * than zipped by index: a half-read set produces numbers that look plausible
 * and are attributed to the wrong parameter, which is worse than a family
 * reporting an honest null.
 */
function parseParameterSet(parametersRaw) {
  const text = String(parametersRaw || '').trim();
  const match = text.match(/^([\s\S]*)\(([^()]*)\)\s*$/);
  if (!match) return null;

  const values = splitValues(match[1].trim());
  const names = match[2].split('/').map((name) => name.trim());
  if (!names.length || !names[0] || values.length !== names.length) return null;
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

/** First of the given names that carries a readable number. */
function numericParam(valuesByName, ...names) {
  for (const name of names) {
    const value = numeric(valuesByName[name]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * A boolean parameter, ignoring any digits in front of `IsOn`.
 *
 * URGO writes TradeWindowIsOn and Bullet Bot writes TradeWindow1IsOn for the
 * same switch. Keying on the literal name read one family and reported the
 * other as having no trade window at all — indistinguishable, in the output,
 * from a family that trades around the clock.
 *
 * Present-but-unreadable returns null, not false: "off" is a claim about the
 * setting, and we only get to make it when the export actually said so.
 */
function booleanParam(valuesByName, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(valuesByName)) {
    if (key.replace(/\d+(?=IsOn$)/i, '').toLowerCase() !== wanted) continue;
    const text = String(value).trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return null;
  }
  return null;
}

/**
 * The family a strategy belongs to: `0 - OGX-PF-2.4` → `OGX-PF`.
 *
 * The leading number is the NinjaTrader grid's row index, not part of the name.
 * The trailing version is what the team versions and swaps; grouping by the
 * full name would split one family into a row per version and hide the size of
 * the exposure.
 *
 * A version is only stripped when it has a dot, matching parseStrategyVersion
 * in csvImport. `-PF` is a different product from its non-PF sibling — separate
 * prop-firm rules — so it stays.
 */
export function strategyFamilyOf(strategyName) {
  const withoutIndex = String(strategyName || '').trim().replace(/^\d+\s*-\s*/, '');
  const withoutVersion = withoutIndex.replace(/\s*-\s*\d+(?:\.\d+)+\s*$/, '');
  return withoutVersion.trim() || null;
}

/* ── Profile ──────────────────────────────────────────────────────────────── */

function emptyFamily(family) {
  return {
    family,
    strategies: 0,
    accounts: new Set(),
    stops: [],
    targets: [],
    fillsByPair: new Map(),
    parameterSets: new Set(),
    unattributedFills: 0,
    reEntry: { on: 0, read: 0 },
    window: { on: 0, read: 0 },
  };
}

function percentage(counter) {
  return counter.read ? round2((counter.on / counter.read) * 100) : null;
}

function finishRow(entry) {
  const stopTicks = median(entry.stops);
  const targetTicks = median(entry.targets);

  // A stop of 0 is not a tight stop, it is a strategy whose stop was never
  // exported, and dividing by it gives Infinity — a family that sorts to the
  // top of a risk ranking on the strength of a missing column. A target of 0 is
  // the same absence from the other side: no reward to weigh the risk against.
  const ratio = stopTicks > 0 && targetTicks > 0 ? targetTicks / stopTicks : null;
  const rewardRisk = ratio === null ? null : round2(ratio);

  // Fills are counted, not sampled: the import carries the whole execution list
  // for the day, so an account-day with none is a measured zero rather than a
  // missing input.
  //
  // That reasoning covers a pair that exists holding nothing. It does NOT cover
  // having no pairs at all, which is what happens when every row for a family is
  // parked and no execution names it. Defaulting that to 0 put a family nobody
  // has ever run at the safe end of the chart, ahead of families that trade — a
  // measured-looking zero standing in for "never observed".
  const fills = [...entry.fillsByPair.values()];
  const fillsPerDay = median(fills);

  return {
    family: entry.family,
    // Rows summed across days: one unchanged config imported for 200 days
    // counted as 200. Kept because it is what it is, renamed so nobody reads it
    // as breadth, and joined by the figure a reader actually wants.
    strategyRows: entry.strategies,
    strategies: entry.strategies,
    parameterSets: entry.parameterSets.size,
    unattributedFills: entry.unattributedFills,
    accounts: entry.accounts.size,
    stopTicks,
    targetTicks,
    rewardRisk,
    fillsPerDay,
    maxFillsPerDay: fills.length ? Math.max(...fills) : null,
    // Divided by the unrounded ratio. Rounding first turned any ratio under
    // 0.005 into exactly 0 — not null, so the guard above never fired — and
    // dividing by it gave Infinity, which sorted to the top of the very ranking
    // this guard exists to protect. Above that threshold the rounded divisor
    // still overstated thin-edge families by up to 40%, always in the same
    // direction, so the worst-looking row was the least accurate one.
    exposure: ratio === null || fillsPerDay === null ? null : round2(fillsPerDay / ratio),
    // Sample sizes travel with the figures. A median over one parameter set and
    // one over five hundred were byte-identical before this, and the chart
    // printed the family's row count beside both as though it were the n.
    stopSamples: entry.stops.length,
    targetSamples: entry.targets.length,
    accountDays: entry.fillsByPair.size,
    reEntrySamples: entry.reEntry.read,
    windowSamples: entry.window.read,
    reEntryPct: percentage(entry.reEntry),
    windowPct: percentage(entry.window),
  };
}

/** Most exposed first. A family whose reward:risk could not be read cannot be
 *  ranked against one that could, so it sits at the bottom instead of sorting
 *  as though its exposure were zero. */
function byExposure(a, b) {
  if (a.exposure === null || b.exposure === null) {
    if (a.exposure !== null) return -1;
    if (b.exposure !== null) return 1;
    return a.family.localeCompare(b.family);
  }
  return b.exposure - a.exposure || a.family.localeCompare(b.family);
}

/**
 * Risk profile per strategy family across every client on record.
 *
 * `asOfDate` bounds the history: imports filed after it are ignored, so a
 * manager reading last Tuesday sees what was true then. Left empty, everything
 * on record counts.
 */
export function buildStrategyRiskProfile(clients = [], { asOfDate = '' } = {}) {
  const bound = String(asOfDate || '').slice(0, 10);
  const families = new Map();
  const familyEntry = (name) => {
    if (!families.has(name)) families.set(name, emptyFamily(name));
    return families.get(name);
  };

  clients.forEach((client, index) => {
    // Account names repeat across clients — every book has a Sim101 — so an
    // account is only distinct within the client that owns it. Keying on the
    // display name alone merges two clients into one account and collapses
    // their separate account-days into a single, doubled fill count.
    const owner = client?.id || `#${index}`;

    for (const dailyImport of client?.dailyImports || []) {
      const date = String(dailyImport?.date || '').slice(0, 10);
      if (!date || (bound && date > bound)) continue;

      for (const strategy of dailyImport.strategies || []) {
        const family = strategyFamilyOf(strategy?.strategyName);
        if (!family) continue;   // a nameless row belongs to nothing actionable
        const entry = familyEntry(family);
        entry.strategies += 1;

        const account = String(strategy?.accountName || '').trim();
        if (account) entry.accounts.add(`${owner}|${account}`);

        // A disabled strategy could not have fired, so its zero says nothing
        // about how often the family trades — only that somebody parked it.
        // Opening a pair for it drags the median toward zero on every family
        // half the book has switched off.
        // Opened regardless of the enabled flag. Enabled is optional on the
        // Strategies grid and parseBool reads an absent column as false, so a
        // book exported without that column looked entirely parked and opened
        // no zero-pairs at all — leaving the median to the accounts that
        // happened to trade. The same book then scored differently by import
        // route, since the auto path passes enabled through as undefined.
        // A configured strategy that did not fire is a measured zero for that
        // account-day; that is more defensible than a figure whose meaning
        // depends on which columns a CAM had switched on.
        // Same rule as on the execution side: without an account name there is
        // no account-day to place this on. Opening a pair keyed on an empty
        // name invented a measured zero for a row that names no account, and
        // that zero is indistinguishable from a real quiet day.
        if (account) {
          const pair = `${owner}|${account}|${date}`;
          if (!entry.fillsByPair.has(pair)) entry.fillsByPair.set(pair, 0);
        }

        const params = parseParameterSet(strategy?.parametersRaw);
        if (!params) continue;
        entry.parameterSets.add(String(strategy.parametersRaw));

        const stop = numericParam(params, 'StopLossTicks');
        if (stop !== null) entry.stops.push(stop);
        // Bullet Bot writes one ProfitTargetTicks where URGO writes
        // ProfitTargetTicks1..3. Reading only the numbered name left Bullet Bot
        // with no target, hence no reward:risk, hence out of the ranking.
        const target = numericParam(params, 'ProfitTargetTicks1', 'ProfitTargetTicks');
        if (target !== null) entry.targets.push(target);

        for (const [flag, counter] of [['ReEntryIsOn', entry.reEntry], ['TradeWindowIsOn', entry.window]]) {
          const value = booleanParam(params, flag);
          if (value === null) continue;   // a family without the switch is unknown, not off
          counter.read += 1;
          if (value) counter.on += 1;
        }
      }

      for (const execution of dailyImport.executions || []) {
        const family = strategyFamilyOf(execution?.strategyName);
        if (!family) continue;
        const entry = familyEntry(family);
        // Grouped per account and per day, then taken as a median further down.
        // A total would report a family that ran on forty accounts as forty
        // times busier than the same family on one.
        //
        // The day is the import's own date: scopeExecutionsToDay already
        // dropped fills belonging to other sessions at ingest.
        const account = String(execution?.accountName || '').trim();
        if (!account) {
          // Account display name is optional on the Executions grid, and a
          // column that is not enabled is not exported. Without it a fill
          // cannot be placed on an account-day. Bucketing them together under
          // an empty name produced a row reading 0 fills a day beside a maximum
          // of 9 — the empty bucket sat alongside the real per-account pairs
          // the strategy rows had opened at zero, and the median found the
          // zeros. Counted separately so the total is visible and the median
          // stays a median of things it can actually attribute.
          entry.unattributedFills += 1;
          continue;
        }
        // A fill is proof the strategy ran, so it opens its own pair even when
        // the strategies grid never listed it.
        const pair = `${owner}|${account}|${date}`;
        entry.fillsByPair.set(pair, (entry.fillsByPair.get(pair) || 0) + 1);
      }
    }
  });

  return [...families.values()].map(finishRow).sort(byExposure);
}
