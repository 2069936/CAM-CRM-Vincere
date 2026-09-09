/* ------------------------------------------------------------------------- *
 * Tags a CAM puts on a client, and the one that is really a business metric.
 *
 * Three were asked for, and they are not the same kind of thing.
 *
 * AT RISK and VIP are judgement. A CAM reads the room and marks it, and the
 * value is that the next person sees it without asking.
 *
 * REFUND SAVE is a fact about money, and it is the reason this exists. When a
 * client asks a prop firm for a refund, the firm keeps them by handing over
 * three or six months of CAM for free, and they arrive here on the Free tier.
 * A refund save and an ordinary free client look identical in the data and are
 * opposites in meaning: one is a retained refund, the other is unconverted
 * revenue. Counting a refund save inside "free clients we could convert"
 * inflates the pipeline with people who were never going to pay this quarter.
 *
 * A client can carry more than one. At risk and refund save together is not a
 * contradiction, it is the most important row on the page.
 *
 * The set is fixed, like SUBSCRIPTION_PRICES beside it. A free-text tag field
 * becomes eleven spellings of "at risk" within a month and then nothing can be
 * counted, which defeats the point of tagging.
 * ------------------------------------------------------------------------- */

export const CLIENT_TAGS = Object.freeze({
  AT_RISK: 'At risk',
  VIP: 'VIP',
  REFUND_SAVE: 'Refund save',
});

export const CLIENT_TAG_LIST = Object.freeze([
  CLIENT_TAGS.AT_RISK,
  CLIENT_TAGS.VIP,
  CLIENT_TAGS.REFUND_SAVE,
]);

/** What each one means, shown next to the checkbox so it is used consistently. */
export const CLIENT_TAG_DESCRIPTIONS = Object.freeze({
  [CLIENT_TAGS.AT_RISK]: 'Losing engagement, performance or patience. Needs attention this week.',
  [CLIENT_TAGS.VIP]: 'Treat first when time is short.',
  [CLIENT_TAGS.REFUND_SAVE]: 'Kept by the prop firm with free CAM months instead of a refund. Not a conversion prospect.',
});

/**
 * Coerce anything stored or typed into the fixed set.
 *
 * Order is the declared order, not insertion order, so two clients with the
 * same tags always render and compare identically. Unknown values are dropped
 * rather than kept: a tag nothing can count is worse than no tag.
 */
export function normalizeClientTags(value) {
  const incoming = Array.isArray(value) ? value : [];
  const wanted = new Set(
    incoming
      .map((tag) => String(tag ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  return CLIENT_TAG_LIST.filter((tag) => wanted.has(tag.toLowerCase()));
}

/** Add or remove one tag, always returning a normalized list. */
export function toggleClientTag(tags, tag) {
  const current = normalizeClientTags(tags);
  const target = normalizeClientTags([tag]);
  if (!target.length) return current;
  const [only] = target;
  return current.includes(only)
    ? current.filter((entry) => entry !== only)
    : normalizeClientTags([...current, only]);
}

export function hasClientTag(tags, tag) {
  return normalizeClientTags(tags).includes(tag);
}

/** True when this client is free because a refund was saved, not because they have not converted. */
export function isRefundSave(client) {
  return hasClientTag(client?.tags, CLIENT_TAGS.REFUND_SAVE);
}
