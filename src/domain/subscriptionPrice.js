// What a client pays for CAM, and where they stand with it.
//
// TWO FIELDS, ONE ANSWER. `subscription_price` (text) predates everything here
// and is kept for backward compatibility: it holds the amount as "$N" in whole
// dollars, or 'Free', or 'Undetermined'. `payment_status` is the newer column
// that says which of the desk's five sheet groups the client sits in, plus
// cancelled. The amount only means something while the status is `paying`;
// everywhere else `subscription_price` is derived from the status, so the two
// columns cannot disagree about whether money comes in.
//
// THE OPTIONS USED TO BE FIXED at $500 / $250 / Free / Undetermined. The desk's
// payment sheet holds $500, $400, $375, $333, $250 and $183, and a "???" where
// somebody is paying an amount nobody wrote down, so the fixed list was wrong
// for a third of the paying clients and every one of them was filed as
// Undetermined. Any whole dollar amount is accepted now; the presets are only
// the quick buttons.
//
// Used by the data layer (supabaseStore), the client form, the revenue panel
// and the sheet importer, so all four share one source of truth.

export const DEFAULT_SUBSCRIPTION_PRICE = 'Undetermined';
export const FREE_SUBSCRIPTION_PRICE = 'Free';

/** Quick presets, highest first. The amount field accepts any whole dollar figure. */
export const SUBSCRIPTION_AMOUNT_PRESETS = Object.freeze([500, 400, 375, 333, 250, 183]);

/** The historical option list, kept for callers that still render it. */
export const SUBSCRIPTION_PRICES = [
  ...SUBSCRIPTION_AMOUNT_PRESETS.map((amount) => `$${amount}`),
  FREE_SUBSCRIPTION_PRICE,
  DEFAULT_SUBSCRIPTION_PRICE,
];

export const PAYMENT_STATUSES = Object.freeze(['paying', 'free', 'undetermined', 'paused', 'idle', 'cancelled']);
export const DEFAULT_PAYMENT_STATUS = 'undetermined';

export const PAYMENT_STATUS_LABELS = Object.freeze({
  paying: 'Paying',
  free: 'Free',
  undetermined: 'Undetermined',
  paused: 'Paused',
  idle: 'Idle',
  cancelled: 'Cancelled',
});

/**
 * Whole dollars out of an amount cell, or null.
 *
 * "$400" -> 400, "$1,000" -> 1000, "375.00" -> 375, " $ 183 " -> 183.
 * "???", "", "Free", "n/a" -> null: the caller decides what null means there.
 */
export function parseSubscriptionAmount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/.exec(text);
  if (!match) return null;
  const amount = Math.round(Number(match[1].replace(/,/g, '')));
  return amount > 0 ? amount : null;
}

/** 400 -> "$400". Null or a non-positive amount -> the default label. */
export function formatSubscriptionAmount(amount) {
  const parsed = parseSubscriptionAmount(amount);
  return parsed === null ? DEFAULT_SUBSCRIPTION_PRICE : `$${parsed}`;
}

/**
 * Coerce any stored or incoming value to a valid price, falling back to the
 * default. An unknown string ('premium', 'TBD', '$0') still lands on
 * Undetermined rather than being stored as a tier nobody can price.
 */
export function normalizeSubscriptionPrice(value) {
  if (value === FREE_SUBSCRIPTION_PRICE) return FREE_SUBSCRIPTION_PRICE;
  if (value === DEFAULT_SUBSCRIPTION_PRICE || value == null) return DEFAULT_SUBSCRIPTION_PRICE;
  const text = String(value).trim();
  if (text === FREE_SUBSCRIPTION_PRICE) return FREE_SUBSCRIPTION_PRICE;
  if (!text.startsWith('$')) return DEFAULT_SUBSCRIPTION_PRICE;
  return formatSubscriptionAmount(text);
}

/** The amount a price string carries, or null for Free and Undetermined. */
export function subscriptionAmountOf(subscriptionPrice) {
  const price = normalizeSubscriptionPrice(subscriptionPrice);
  if (price === FREE_SUBSCRIPTION_PRICE || price === DEFAULT_SUBSCRIPTION_PRICE) return null;
  return parseSubscriptionAmount(price);
}

/**
 * The status a legacy row implies from its price alone. This is the rule step
 * 62's backfill applies in SQL, restated here for rows read from a database
 * (or a local snapshot) that has not run it yet.
 */
export function derivePaymentStatus(subscriptionPrice) {
  const price = normalizeSubscriptionPrice(subscriptionPrice);
  if (price === FREE_SUBSCRIPTION_PRICE) return 'free';
  if (price === DEFAULT_SUBSCRIPTION_PRICE) return DEFAULT_PAYMENT_STATUS;
  return 'paying';
}

/**
 * Coerce a stored status. When the column is absent (null/undefined), the
 * status is derived from the price so a pre-62 database still reads sensibly;
 * an unknown string lands on the default.
 */
export function normalizePaymentStatus(value, subscriptionPrice) {
  if (value == null || value === '') return derivePaymentStatus(subscriptionPrice);
  const text = String(value).trim().toLowerCase();
  return PAYMENT_STATUSES.includes(text) ? text : DEFAULT_PAYMENT_STATUS;
}

/**
 * The price column that goes with a status and an amount.
 *
 * Only `paying` keeps an amount. Free is 'Free'. Everything else, including a
 * paying client whose amount nobody knows ("???" on the sheet), is
 * 'Undetermined', so a client who pauses or cancels drops out of the MRR and
 * the price log records the money that stopped.
 */
export function subscriptionPriceFor(paymentStatus, amount) {
  const status = normalizePaymentStatus(paymentStatus, DEFAULT_SUBSCRIPTION_PRICE);
  if (status === 'free') return FREE_SUBSCRIPTION_PRICE;
  if (status !== 'paying') return DEFAULT_SUBSCRIPTION_PRICE;
  return formatSubscriptionAmount(amount);
}

export function paymentStatusLabel(status) {
  return PAYMENT_STATUS_LABELS[normalizePaymentStatus(status, DEFAULT_SUBSCRIPTION_PRICE)];
}
