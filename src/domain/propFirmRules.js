// Prop firm identity and account limits, derived from what the CRM already has.
//
// The limits that decide whether an account lives or dies — trailing drawdown,
// profit target — are firm rules, not platform data. NinjaTrader reports how far
// down an account is; it has no idea how far down it is allowed to go. So the
// auto-export will not fill these in, however many columns it brings.
//
// On a real book max_drawdown_limit was set on 7 of 764 accounts. Everything
// that reads it — the drawdown flags, the trailing chart — was therefore
// running on nothing.
//
// Two of the three inputs can be derived from data already stored. The third,
// the rules themselves, is knowledge only the desk has, and is left empty here
// rather than guessed at: a fabricated drawdown limit would present an invented
// number as a risk threshold, and someone would trade against it.

/**
 * Connection names as typed by whoever set the account up.
 *
 * A real book held Legends under four spellings and Bluesky under five. Grouping
 * by the raw string splits one firm into five, and any per-firm rule then
 * applies to a fraction of the accounts it should.
 */
const FIRM_PATTERNS = [
  { firm: 'Legends', match: /legend/i },
  { firm: 'Bluesky', match: /^bl(ue?)?\s?sky/i },
  { firm: 'Lucid', match: /lucid/i },
  { firm: 'Tradeify', match: /tradeify/i },
  { firm: 'MFF', match: /^mff|my ?funded ?futures/i },
  { firm: 'Apex', match: /apex/i },
  { firm: 'Topstep', match: /topstep/i },
  { firm: 'Take Profit Trader', match: /take ?profit|^tpt$|^takept$/i },
  { firm: 'Funded Futures Family', match: /^f{2,3}family|funded ?futures ?family|^funded futures$/i },
  { firm: 'Bulenox', match: /bulenox/i },
  { firm: 'TradeDay', match: /trade ?day/i },
];

// A misspelling is the same firm. The book holds "Tradefify" beside "Tradeify",
// and leaving them apart puts two accounts under a firm with no rules while the
// rules for their actual firm sit right there.
const FIRM_TYPOS = { TRADEFIFY: 'Tradeify', BLUSKY: 'Bluesky' };

/**
 * The canonical firm for a connection, or null when it is not a firm at all.
 *
 * "Live" and "Sim101" are NinjaTrader's own connection names. Treating them as
 * firms would invent two more, each with rules nobody wrote.
 */
export function normalizePropFirm(connection) {
  const text = String(connection || '').trim();
  if (!text) return null;
  if (/^(live|sim\d*|playback|backtest|replay)$/i.test(text)) return null;
  for (const { firm, match } of FIRM_PATTERNS) {
    if (match.test(text)) return firm;
  }
  return FIRM_TYPOS[text.toUpperCase().replace(/[^A-Z]/g, '')] || text;
}

/** Sizes prop firms actually sell. */
export const STANDARD_ACCOUNT_SIZES = [
  5000, 10000, 25000, 50000, 75000, 100000, 150000, 250000, 300000,
];

/**
 * The nearest standard size to a starting balance, or null.
 *
 * Balances drift the moment trading starts, so this only reads a balance from
 * the earliest close on record and only accepts a match within a tolerance. A
 * 50,000 account that opened at 50,000 is a 50k account; one sitting at 61,400
 * is not any size we sell, and guessing would put an account under rules that
 * were never its own.
 */
export function inferAccountSize(balance, { tolerance = 0.15 } = {}) {
  const value = Number(balance);
  if (!Number.isFinite(value) || value <= 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const size of STANDARD_ACCOUNT_SIZES) {
    const distance = Math.abs(value - size) / size;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = size;
    }
  }
  return bestDistance <= tolerance ? best : null;
}

/** Earliest balance on record for an account, which is the closest thing to its opening size. */
export function firstObservedBalance(accountName, dailyImports = []) {
  const sorted = (dailyImports || [])
    .filter((entry) => entry?.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const entry of sorted) {
    for (const snapshot of entry.snapshots || []) {
      if (snapshot.accountName !== accountName) continue;
      const balance = Number(snapshot.accountBalance);
      if (Number.isFinite(balance) && balance > 0) return balance;
    }
  }
  return null;
}

/**
 * Firm rules, keyed `${firm}|${plan}|${size}`.
 *
 * Every figure was read from the firm's own pages on 2026-07-31 and checked by a
 * second independent pass. Nothing here is inferred: these numbers decide
 * whether an account reads as safe or about to breach, so a plausible guess
 * would be worse than a blank.
 *
 * Keyed by plan because every firm sells the same size under several, and they
 * diverge. Legends 50k is 2,000 on Apprentice and 2,200 on Elite. Lucid 100k is
 * 3,000 on Pro and Flex but 3,500 on Direct.
 *
 * `basis` is per plan and does not converge across firms. Apex runs an intraday
 * and an end-of-day product at identical money; MFF Rapid switches from
 * end-of-day to intraday when the account funds, which is why `fundedBasis`
 * exists.
 *
 * `breachTested` is a SEPARATE question from `basis`, and conflating them was a
 * mistake worth naming. Tradeify's help centre is explicit: "Even though EOD
 * drawdown only UPDATES at end of day, it is ENFORCED in real-time. If your
 * balance hits the drawdown limit during trading, your account fails
 * immediately - even if you might have recovered by end of day."
 *
 * So on an end-of-day plan, deriving the FLOOR from stored closing balances is
 * correct — the floor genuinely only moves on the close. Concluding from those
 * same closes that an account SURVIVED is not: a touch during the session kills
 * it permanently and leaves no trace in any closing balance we store. A green
 * account in this CRM can already be dead.
 *
 * Where breachTested is 'real-time', a derived figure answers "how much room
 * was there at the close", never "was the account safe today".
 *
 * Sources are recorded in docs/prop-firm-rules-catalog.md.
 */
export const PROP_FIRM_RULES = {
  // Legends — thelegendstrading.com/plans + knowledge.thelegendstrading.com,
  // read 2026-07-31. Explicitly end-of-day: "We calculate your Max Drawdown at
  // the end of each trading day." Intraday was removed in the Jan 2026 change.
  'Legends|Apprentice|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Legends|Apprentice|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Legends|Apprentice|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },
  'Legends|Elite|25000': { trailingDrawdown: 1250, profitTarget: 1500, basis: 'end-of-day' },
  'Legends|Elite|50000': { trailingDrawdown: 2200, profitTarget: 2700, basis: 'end-of-day' },
  'Legends|Elite|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Legends|Elite|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },

  // Lucid — lucidtrading.com plan cards + support.lucidtrading.com rule
  // articles. Pro, Flex and Daily share one ladder; Direct does not.
  'Lucid|Flex|25000': { trailingDrawdown: 1000, profitTarget: 1250, basis: 'end-of-day' },
  'Lucid|Flex|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Lucid|Flex|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Lucid|Flex|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },
  'Lucid|Pro|25000': { trailingDrawdown: 1000, profitTarget: 1250, basis: 'end-of-day' },
  'Lucid|Pro|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Lucid|Pro|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Lucid|Pro|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },
  // Direct breaks the ladder at the top two sizes. Quoting one "Lucid 100K
  // drawdown" without naming the plan is wrong half the time.
  'Lucid|Direct|50000': { trailingDrawdown: 2000, profitTarget: null, basis: 'end-of-day' },
  'Lucid|Direct|100000': { trailingDrawdown: 3500, profitTarget: null, basis: 'end-of-day' },
  'Lucid|Direct|150000': { trailingDrawdown: 5000, profitTarget: null, basis: 'end-of-day' },

  // BluSky — blusky.pro. Evaluations are end-of-day per the help centre.
  'Bluesky|Launch|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Bluesky|Launch|100000': { trailingDrawdown: 2500, profitTarget: 6000, basis: 'end-of-day' },
  'Bluesky|Propel|25000': { trailingDrawdown: 1200, profitTarget: 1500, basis: 'end-of-day' },
  'Bluesky|Propel|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Bluesky|Propel|100000': { trailingDrawdown: 2500, profitTarget: 6000, basis: 'end-of-day' },
  'Bluesky|Orbit|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Bluesky|Orbit|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Bluesky|Orbit|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },

  // My Funded Futures — the one place basis changes with the account's STAGE.
  // Rapid is end-of-day while evaluating and intraday once funded, off peak
  // equity including unrealised gains. A derived figure understates it.
  'MFF|Rapid|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'end-of-day', fundedBasis: 'intraday' },
  'MFF|Rapid|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day', fundedBasis: 'intraday' },
  'MFF|Rapid|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day', fundedBasis: 'intraday' },
  'MFF|Rapid|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day', fundedBasis: 'intraday' },
  'MFF|Pro|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'MFF|Pro|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'MFF|Pro|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day' },
  'MFF|Flex|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'end-of-day' },
  'MFF|Flex|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'MFF|Builder|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },

  // Apex — three drawdown models run side by side. Same money at 50k, opposite
  // basis, and the 150k figure is 4,000 where every other firm here says 4,500.
  'Apex|Intraday Trail|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'intraday' },
  'Apex|Intraday Trail|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'intraday' },
  'Apex|Intraday Trail|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'intraday' },
  'Apex|Intraday Trail|150000': { trailingDrawdown: 4000, profitTarget: 9000, basis: 'intraday' },
  'Apex|EOD Trail|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'end-of-day' },
  'Apex|EOD Trail|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day' },
  'Apex|EOD Trail|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day' },
  'Apex|EOD Trail|150000': { trailingDrawdown: 4000, profitTarget: 9000, basis: 'end-of-day' },

  // Tradeify — tradeify.co + help.tradeify.co. Every plan updates end-of-day and
  // every plan is enforced in real time. A plain fetch of the homepage returns
  // an un-hydrated shell printing $1,000 on both the 25K and 50K cards, so these
  // came from the live render and the help centre.
  //
  // Select Daily and Select Flex diverge above 50k: 100k is 3,000 on Flex and
  // 2,500 on Daily, 150k is 4,500 and 3,500.
  'Tradeify|Growth|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Growth|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Growth|100000': { trailingDrawdown: 3500, profitTarget: 6000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Growth|150000': { trailingDrawdown: 5000, profitTarget: 9000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select|25000': { trailingDrawdown: 1000, profitTarget: 1500, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select|50000': { trailingDrawdown: 2000, profitTarget: 3000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select|100000': { trailingDrawdown: 3000, profitTarget: 6000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select|150000': { trailingDrawdown: 4500, profitTarget: 9000, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select Daily|25000': { trailingDrawdown: 1000, profitTarget: null, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select Daily|50000': { trailingDrawdown: 2000, profitTarget: null, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select Daily|100000': { trailingDrawdown: 2500, profitTarget: null, basis: 'end-of-day', breachTested: 'real-time' },
  'Tradeify|Select Daily|150000': { trailingDrawdown: 3500, profitTarget: null, basis: 'end-of-day', breachTested: 'real-time' },
};

/**
 * Plans a firm sells, for the classification prompt.
 *
 * The account's plan cannot be derived from anything the platform reports — it
 * is a purchase decision — so a CAM has to say which one. Until they do, the
 * fallback below is used and marked as a fallback.
 */
export function plansFor(firm, rules = PROP_FIRM_RULES) {
  const plans = new Set();
  for (const key of Object.keys(rules)) {
    const [keyFirm, plan] = key.split('|');
    if (keyFirm === firm) plans.add(plan);
  }
  return [...plans].sort();
}

/**
 * The rule to use when the plan is unknown: the tightest drawdown that firm
 * sells at that size.
 *
 * Every firm researched charges 2,000 on a 50k account except Legends Elite at
 * 2,200. Guessing the looser number on an Apprentice account would raise the
 * warning 200 dollars after the account was already dead; guessing the tighter
 * one on an Elite raises it 200 dollars early. Only one of those is survivable,
 * so an unknown plan always takes the tighter figure and says it is a fallback.
 */
export function tightestRuleFor(firm, size, rules = PROP_FIRM_RULES) {
  let best = null;
  for (const [key, rule] of Object.entries(rules)) {
    const [keyFirm, , keySize] = key.split('|');
    if (keyFirm !== firm || Number(keySize) !== Number(size)) continue;
    if (rule.trailingDrawdown == null) continue;
    if (!best || rule.trailingDrawdown < best.trailingDrawdown) best = rule;
  }
  return best;
}

/**
 * Generic profit targets by account size, as a fallback below firm rules.
 *
 * Stated by the desk as target *balances*, not profit amounts: a 50k account
 * passes at 54,000. Recorded that way and converted here, because writing the
 * profit down instead invites someone to read 4,000 as a balance.
 *
 * UNCONFIRMED against any firm's published rules. This is a working assumption
 * to make classification less blind, and a firm rule always wins over it.
 */
export const GENERIC_TARGET_BALANCE = {
  50000: 54000,
  100000: 107000,
  150000: 159000,
};

export function genericProfitTarget(size) {
  const target = GENERIC_TARGET_BALANCE[size];
  return target ? target - size : null;
}

export function ruleFor(firm, size, plan = null, rules = PROP_FIRM_RULES) {
  if (!firm || !size) return null;
  if (plan) return rules[`${firm}|${plan}|${size}`] || null;
  return tightestRuleFor(firm, size, rules);
}

/**
 * Resolves an account's limits, saying where each number came from.
 *
 * A stored value always wins — someone typed it deliberately. A derived one is
 * labelled as derived so nothing downstream can present a lookup as though a
 * human confirmed it, the same way a derived trailing figure is kept distinct
 * from a reported one.
 */
export function resolveAccountLimits(account, { dailyImports = [], rules = PROP_FIRM_RULES } = {}) {
  const firm = normalizePropFirm(account?.connection);
  const storedDrawdown = Number(account?.maxDrawdownLimit);
  const storedTarget = Number(account?.targetProfit);
  const storedStart = Number(account?.startBalance);

  const startBalance = Number.isFinite(storedStart) && storedStart > 0
    ? storedStart
    : firstObservedBalance(account?.accountName, dailyImports);
  const size = inferAccountSize(startBalance);
  const plan = String(account?.propFirmPlan || '').trim() || null;
  const rule = ruleFor(firm, size, plan, rules);
  const planKnown = Boolean(plan && rules[`${firm}|${plan}|${size}`]);

  return {
    firm,
    accountSize: size,
    sizeSource: Number.isFinite(storedStart) && storedStart > 0 ? 'stored' : (size ? 'inferred' : null),
    maxDrawdownLimit: Number.isFinite(storedDrawdown) && storedDrawdown > 0
      ? storedDrawdown
      : (rule?.trailingDrawdown ?? null),
    drawdownSource: Number.isFinite(storedDrawdown) && storedDrawdown > 0
      ? 'stored'
      : (rule?.trailingDrawdown != null ? 'firm-rule' : null),
    targetProfit: Number.isFinite(storedTarget) && storedTarget > 0
      ? storedTarget
      : (rule?.profitTarget ?? genericProfitTarget(size)),
    targetSource: Number.isFinite(storedTarget) && storedTarget > 0
      ? 'stored'
      : (rule?.profitTarget != null
        ? 'firm-rule'
        : (genericProfitTarget(size) != null ? 'generic' : null)),
    plan,
    // A rule found without a named plan is the tightest that firm sells at that
    // size, not that account's own. Saying so keeps a fallback from reading as a
    // confirmed limit.
    planKnown,
    ruleSource: rule ? (planKnown ? 'plan' : 'tightest-for-size') : null,
    basis: rule?.basis ?? null,
    // Only MFF Rapid so far: end-of-day while evaluating, intraday once funded.
    // A trailing figure derived from stored closes understates an intraday
    // trail, so the account this applies to needs the reported number.
    fundedBasis: rule?.fundedBasis ?? null,
    // Whether a breach is checked continuously or only at the close. Where this
    // is 'real-time', anything derived from stored closes can say how much room
    // there was at the close and nothing about whether the account survived.
    breachTested: rule?.breachTested ?? null,
  };
}

/**
 * What a book would gain from filling the rules table.
 *
 * Answers "which firm and size combinations do we actually hold, and how many
 * accounts is each rule worth", so the desk fills the twenty rows that cover
 * the book instead of every rule every firm publishes.
 */
export function summarizeRuleCoverage(clients = [], rules = PROP_FIRM_RULES) {
  const combos = new Map();
  let resolved = 0;
  let unresolved = 0;

  for (const client of clients) {
    const imports = client?.dailyImports || [];
    for (const [accountName, meta] of Object.entries(client?.accountRegistry || {})) {
      const limits = resolveAccountLimits(
        { ...meta, accountName },
        { dailyImports: imports, rules },
      );
      if (limits.maxDrawdownLimit != null) resolved += 1;
      else unresolved += 1;
      if (!limits.firm || !limits.accountSize) continue;
      const key = `${limits.firm}|${limits.accountSize}`;
      const row = combos.get(key) || {
        key, firm: limits.firm, accountSize: limits.accountSize, accounts: 0, hasRule: false,
      };
      row.accounts += 1;
      row.hasRule = ruleFor(limits.firm, limits.accountSize, limits.plan, rules) != null;
      combos.set(key, row);
    }
  }

  return {
    resolved,
    unresolved,
    combos: [...combos.values()].sort((a, b) => b.accounts - a.accounts),
  };
}
