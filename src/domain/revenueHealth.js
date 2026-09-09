import { DEFAULT_SUBSCRIPTION_PRICE, SUBSCRIPTION_PRICES } from './subscriptionPrice';
import { isRefundSave } from './clientTags';

/* ------------------------------------------------------------------------- *
 * What the desk earns, what it is not collecting, and what moved.
 *
 * THE HONEST NUMBER FIRST. 83 of 121 active clients sit on 'Undetermined'.
 * Any MRR computed over this book is a FLOOR, not a total, and every figure
 * here carries the count it could not price so nobody reads the floor as the
 * answer. A dashboard that quietly treats "we never asked" as $0 reports a
 * business half its size and gets believed.
 *
 * A REFUND SAVE IS NOT A CONVERSION PROSPECT. When a prop firm keeps a client
 * by handing them three or six free months of CAM, that client lands on Free.
 * They look exactly like a client who has not converted yet and they mean the
 * opposite. Counting them in "free clients we could convert" inflates the
 * pipeline with people who were never going to pay this quarter, so they are
 * counted apart.
 *
 * MOVEMENT NEEDS HISTORY THAT MOSTLY DOES NOT EXIST YET. The audit log records
 * WHICH field changed and never the values, so nothing before the price log
 * shipped can say whether a client went from Free to $500 or the reverse. New
 * and lost MRR and the conversion rate are computed from the price log alone,
 * and each answer says how far back the log actually reaches. A confident zero
 * over a period nobody recorded is worse than an admission.
 * ------------------------------------------------------------------------- */

export const MONTHLY_VALUE = Object.freeze({ $500: 500, $250: 250, Free: 0 });

/** Dollars per month, or null when the tier has never been decided. */
export function monthlyValue(subscriptionPrice) {
  const tier = SUBSCRIPTION_PRICES.includes(subscriptionPrice)
    ? subscriptionPrice
    : DEFAULT_SUBSCRIPTION_PRICE;
  return tier === DEFAULT_SUBSCRIPTION_PRICE ? null : MONTHLY_VALUE[tier];
}

function activeClients(clients) {
  return (clients || []).filter((client) => client && !client.deletedAt && client.status === 'Active');
}

function tierOf(client) {
  return SUBSCRIPTION_PRICES.includes(client?.subscriptionPrice)
    ? client.subscriptionPrice
    : DEFAULT_SUBSCRIPTION_PRICE;
}

/**
 * Revenue as it stands today.
 *
 * `mrr` counts only clients with a decided tier. `unpriced` is how many were
 * left out, and it is not a footnote: on this book it is most of them.
 */
export function revenueSnapshot(clients) {
  const active = activeClients(clients);
  const byTier = Object.fromEntries(SUBSCRIPTION_PRICES.map((tier) => [tier, 0]));
  let mrr = 0;
  let priced = 0;
  for (const client of active) {
    const tier = tierOf(client);
    byTier[tier] += 1;
    const value = monthlyValue(tier);
    if (value === null) continue;
    mrr += value;
    priced += 1;
  }
  const unpriced = active.length - priced;
  const paying = active.filter((c) => (monthlyValue(tierOf(c)) ?? 0) > 0).length;
  return {
    activeClients: active.length,
    mrr,
    // Over PRICED clients only. Dividing by everyone would quietly punish the
    // average for clients nobody has classified, and the number would drift
    // every time someone did classification work rather than sales work.
    arpc: priced ? Number((mrr / priced).toFixed(2)) : 0,
    /* AND A SECOND AVERAGE, FOR PRICING THE PIPELINE.
     *
     * The brief said to value the free clients at the average revenue per
     * client. Do that literally and the calculation eats itself: the average
     * is dragged down by the very free clients being valued, so the more
     * unconverted revenue there is, the less each one appears to be worth.
     *
     * What a converted free client would pay is what the PAYING clients pay,
     * so that is the number the pipeline is priced at. Both are reported;
     * arpc is the one to trend over time, this is the one to multiply by. */
    arpuPaying: paying ? Number((mrr / paying).toFixed(2)) : 0,
    paying,
    priced,
    unpriced,
    byTier,
    tierShare: Object.fromEntries(SUBSCRIPTION_PRICES.map((tier) => [
      tier,
      active.length ? Number(((byTier[tier] * 100) / active.length).toFixed(1)) : 0,
    ])),
  };
}

/**
 * The money not being collected, with the refund saves taken out of it.
 *
 * @param asOf ISO date used to age each free client. Passed in, never read
 *   from the clock, so the same book always produces the same page.
 */
export function revenueLeakage(clients, { asOf } = {}) {
  const active = activeClients(clients);
  const free = active.filter((client) => tierOf(client) === 'Free');
  const convertible = free.filter((client) => !isRefundSave(client));
  const refundSaves = free.filter((client) => isRefundSave(client));
  const { arpuPaying } = revenueSnapshot(clients);
  const reference = asOf ? Date.parse(asOf) : NaN;

  const aged = convertible
    .map((client) => {
      const since = client.freeSince || client.createdAt || null;
      const start = since ? Date.parse(since) : NaN;
      const days = Number.isNaN(start) || Number.isNaN(reference)
        ? null
        : Math.max(0, Math.floor((reference - start) / 86400000));
      return { id: client.id, name: client.name, since, days };
    })
    // Longest first: a client free for six months is a different problem from
    // one free for two weeks, and the six month one is the one being missed.
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));

  return {
    freeClients: free.length,
    convertible: convertible.length,
    refundSaves: refundSaves.length,
    // At what paying clients actually pay, not at the top tier and not at an
    // average the free clients themselves drag down. Pricing the pipeline at
    // $500 each is a forecast nobody can defend.
    potentialMrr: Number((convertible.length * arpuPaying).toFixed(2)),
    aging: aged,
    // Aging needs a date. Say how many could not be aged instead of showing
    // them as brand new, which is what a 0 would look like.
    undated: aged.filter((entry) => entry.days === null).length,
  };
}

/**
 * What moved, from the price log and nothing else.
 *
 * @param changes rows of { clientId, at, from, to }.
 * @param since   ISO date the log begins. Everything before it is unknown, and
 *   saying so is the point of this function.
 */
export function revenueMovement(changes, { from, to, logStartedAt } = {}) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const window = (changes || []).filter((change) => {
    const at = Date.parse(change?.at);
    return !Number.isNaN(at) && at >= start && at <= end;
  });

  let added = 0;
  let lost = 0;
  for (const change of window) {
    const before = monthlyValue(change.from) ?? 0;
    const after = monthlyValue(change.to) ?? 0;
    const delta = after - before;
    if (delta > 0) added += delta;
    else lost += -delta;
  }

  const logStart = Date.parse(logStartedAt);
  return {
    newMrr: added,
    lostMrr: lost,
    netMrr: added - lost,
    changes: window.length,
    // TRUE when the window opens before the log did, which means the answer is
    // "what we recorded", not "what happened". Nothing before the log exists.
    partialPeriod: Number.isNaN(logStart) || logStart > start,
    coversFrom: Number.isNaN(logStart) ? null : new Date(Math.max(logStart, start)).toISOString(),
  };
}

/**
 * How many free clients ever started paying, and how long it took.
 *
 * Only clients whose whole free-to-paid transition is inside the log can be
 * counted. Anyone already paying before the log started is invisible here, and
 * a rate computed without them would be wrong in a direction that flatters us.
 */
export function conversionFromFree(changes, { logStartedAt } = {}) {
  const byClient = new Map();
  for (const change of (changes || [])) {
    const at = Date.parse(change?.at);
    if (Number.isNaN(at)) continue;
    if (!byClient.has(change.clientId)) byClient.set(change.clientId, []);
    byClient.get(change.clientId).push({ ...change, at });
  }

  let startedFree = 0;
  let converted = 0;
  const durations = [];
  for (const history of byClient.values()) {
    history.sort((a, b) => a.at - b.at);
    const becameFree = history.find((change) => change.to === 'Free');
    if (!becameFree) continue;
    startedFree += 1;
    const paid = history.find((change) => change.at > becameFree.at && (monthlyValue(change.to) ?? 0) > 0);
    if (!paid) continue;
    converted += 1;
    durations.push(Math.max(0, Math.round((paid.at - becameFree.at) / 86400000)));
  }

  durations.sort((a, b) => a - b);
  return {
    startedFree,
    converted,
    rate: startedFree ? Number(((converted * 100) / startedFree).toFixed(1)) : 0,
    // Median, not mean. One client who took a year is not the typical story and
    // a mean lets them tell it.
    medianDaysToConvert: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    logStartedAt: logStartedAt || null,
    // Only whole transitions inside the log count. Anyone already paying when
    // the log opened is not in either number.
    countsOnlyLoggedTransitions: true,
  };
}
