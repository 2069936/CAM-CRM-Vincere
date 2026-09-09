import { describe, it, expect } from 'vitest';
import {
  CLIENT_TAGS,
  CLIENT_TAG_LIST,
  hasClientTag,
  isRefundSave,
  normalizeClientTags,
  toggleClientTag,
} from './clientTags';

describe('the fixed set', () => {
  it('is the three management asked for', () => {
    expect(CLIENT_TAG_LIST).toEqual(['At risk', 'VIP', 'Refund save']);
  });

  it('drops anything not in the set rather than storing it', () => {
    // A free-text tag becomes eleven spellings of "at risk" in a month and
    // then nothing can be counted, which defeats the point of tagging.
    expect(normalizeClientTags(['At risk', 'urgent', '', null, 42])).toEqual(['At risk']);
  });

  it('accepts whatever casing and padding a stored value arrived with', () => {
    expect(normalizeClientTags(['  vip  ', 'REFUND SAVE'])).toEqual(['VIP', 'Refund save']);
    expect(normalizeClientTags(['refund save'])).toEqual(['Refund save']);
  });

  it('always returns the declared order, so two clients with the same tags compare equal', () => {
    expect(normalizeClientTags(['Refund save', 'VIP', 'At risk']))
      .toEqual(['At risk', 'VIP', 'Refund save']);
  });

  it('never duplicates', () => {
    expect(normalizeClientTags(['VIP', 'vip', 'VIP'])).toEqual(['VIP']);
  });

  it('survives anything that is not a list', () => {
    for (const value of [null, undefined, 'VIP', 7, {}]) {
      expect(normalizeClientTags(value)).toEqual([]);
    }
  });
});

describe('putting more than one on a client', () => {
  it('keeps both, because at risk and refund save together is the row that matters', () => {
    let tags = toggleClientTag([], CLIENT_TAGS.REFUND_SAVE);
    tags = toggleClientTag(tags, CLIENT_TAGS.AT_RISK);
    expect(tags).toEqual(['At risk', 'Refund save']);
  });

  it('removes one without touching the others', () => {
    expect(toggleClientTag(['At risk', 'VIP', 'Refund save'], CLIENT_TAGS.VIP))
      .toEqual(['At risk', 'Refund save']);
  });

  it('ignores a toggle of something outside the set', () => {
    expect(toggleClientTag(['VIP'], 'whatever')).toEqual(['VIP']);
  });
});

describe('the one that is a business fact', () => {
  it('separates a saved refund from an unconverted free client', () => {
    // They look identical in the data and mean opposite things: one is a
    // retained refund, the other is revenue nobody has collected yet.
    expect(isRefundSave({ tags: ['Refund save'] })).toBe(true);
    expect(isRefundSave({ tags: ['At risk'] })).toBe(false);
    expect(isRefundSave({})).toBe(false);
    expect(isRefundSave(null)).toBe(false);
  });

  it('answers for any single tag', () => {
    expect(hasClientTag(['VIP'], CLIENT_TAGS.VIP)).toBe(true);
    expect(hasClientTag(['VIP'], CLIENT_TAGS.AT_RISK)).toBe(false);
  });
});
