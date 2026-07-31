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
  { firm: 'Take Profit Trader', match: /take ?profit|^tpt$/i },
];

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
  return text;
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
 * Firm rules, keyed `${firm}|${size}`.
 *
 * DELIBERATELY EMPTY. These numbers decide whether an account is reported as
 * safe or about to breach, and inventing them would put a fabricated threshold
 * in front of a money decision. Fill from each firm's published rules; there is
 * a place to record them and their source in
 * docs/prop-firm-rules-catalog.md.
 *
 *   'Legends|50000': { trailingDrawdown: 2500, profitTarget: 3000, basis: 'end-of-day' },
 *
 * basis matters: an intraday trail and an end-of-day trail give different
 * answers on the same account, and we established during the NinjaTrader work
 * that we do not yet know which each firm uses.
 */
export const PROP_FIRM_RULES = {};

/**
 * Generic profit targets by account size, as a fallback below firm rules.
 *
 * Stated by the desk as target *balances*, not profit amounts: a 50k account
 * passes at 54,000. Recorded that way and converted here, because writing the
 * profit down instead invites someone to read 4,000 as a balance.
 *
 * UNCONFIRMED against any firm's published rules. This is a working assumption
 * to make classification less blind, and a firm rule always wins over it. The
 * 150k figure was given as "159 or 160" and is left out rather than picked:
 * a target the desk was unsure of is not a target to measure an account against.
 */
export const GENERIC_TARGET_BALANCE = {
  50000: 54000,
  100000: 107000,
};

export function genericProfitTarget(size) {
  const target = GENERIC_TARGET_BALANCE[size];
  return target ? target - size : null;
}

export function ruleFor(firm, size, rules = PROP_FIRM_RULES) {
  if (!firm || !size) return null;
  return rules[`${firm}|${size}`] || null;
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
  const rule = ruleFor(firm, size, rules);

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
    basis: rule?.basis ?? null,
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
      row.hasRule = ruleFor(limits.firm, limits.accountSize, rules) != null;
      combos.set(key, row);
    }
  }

  return {
    resolved,
    unresolved,
    combos: [...combos.values()].sort((a, b) => b.accounts - a.accounts),
  };
}
