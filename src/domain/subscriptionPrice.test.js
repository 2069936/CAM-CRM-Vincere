import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYMENT_STATUS,
  DEFAULT_SUBSCRIPTION_PRICE,
  PAYMENT_STATUSES,
  SUBSCRIPTION_AMOUNT_PRESETS,
  derivePaymentStatus,
  formatSubscriptionAmount,
  normalizePaymentStatus,
  normalizeSubscriptionPrice,
  parseSubscriptionAmount,
  subscriptionAmountOf,
  subscriptionPriceFor,
} from './subscriptionPrice';

describe('the amount a cell carries', () => {
  it('reads whole dollars with or without the sign and thousands separators', () => {
    expect(parseSubscriptionAmount('$400')).toBe(400);
    expect(parseSubscriptionAmount('400')).toBe(400);
    expect(parseSubscriptionAmount(' $ 183 ')).toBe(183);
    expect(parseSubscriptionAmount('$1,000')).toBe(1000);
    expect(parseSubscriptionAmount('375.00')).toBe(375);
    expect(parseSubscriptionAmount(333)).toBe(333);
  });

  it('answers null for anything that is not an amount, "???" included', () => {
    for (const cell of ['???', '', null, undefined, 'Free', 'n/a', '$', 'TBD', '$0', 0, -5, '4 00']) {
      expect(parseSubscriptionAmount(cell)).toBeNull();
    }
  });

  it('formats back to the stored shape', () => {
    expect(formatSubscriptionAmount(400)).toBe('$400');
    expect(formatSubscriptionAmount('$1,000')).toBe('$1000');
    expect(formatSubscriptionAmount(null)).toBe(DEFAULT_SUBSCRIPTION_PRICE);
  });
});

describe('the price column', () => {
  it('accepts any whole dollar amount, not only the presets', () => {
    expect(normalizeSubscriptionPrice('$400')).toBe('$400');
    expect(normalizeSubscriptionPrice('$183')).toBe('$183');
    expect(normalizeSubscriptionPrice('$42')).toBe('$42');
    expect(normalizeSubscriptionPrice(' $500 ')).toBe('$500');
  });

  it('keeps Free and Undetermined as they are', () => {
    expect(normalizeSubscriptionPrice('Free')).toBe('Free');
    expect(normalizeSubscriptionPrice('Undetermined')).toBe('Undetermined');
  });

  it('lands an unknown stored string on Undetermined rather than on a tier nobody can price', () => {
    for (const value of ['premium', '$0', '$', '400', 'free', null, undefined, '', 'TBD', '$12.50x']) {
      expect(normalizeSubscriptionPrice(value)).toBe(DEFAULT_SUBSCRIPTION_PRICE);
    }
  });

  it('gives the amount back out of the stored string, and null for the two labels', () => {
    expect(subscriptionAmountOf('$375')).toBe(375);
    expect(subscriptionAmountOf('Free')).toBeNull();
    expect(subscriptionAmountOf('Undetermined')).toBeNull();
    expect(subscriptionAmountOf('nonsense')).toBeNull();
  });

  it('lists the six presets the desk charges, highest first', () => {
    expect([...SUBSCRIPTION_AMOUNT_PRESETS]).toEqual([500, 400, 375, 333, 250, 183]);
  });
});

describe('the payment status', () => {
  it('has the six values step 62 checks for', () => {
    expect([...PAYMENT_STATUSES]).toEqual(['paying', 'free', 'undetermined', 'paused', 'idle', 'cancelled']);
  });

  it('is derived from the price the way the backfill derives it when the column is absent', () => {
    expect(derivePaymentStatus('$500')).toBe('paying');
    expect(derivePaymentStatus('$400')).toBe('paying');
    expect(derivePaymentStatus('Free')).toBe('free');
    expect(derivePaymentStatus('Undetermined')).toBe('undetermined');
    expect(derivePaymentStatus(null)).toBe('undetermined');
    expect(derivePaymentStatus('premium')).toBe('undetermined');
    expect(normalizePaymentStatus(null, '$250')).toBe('paying');
    expect(normalizePaymentStatus(undefined, 'Free')).toBe('free');
    expect(normalizePaymentStatus('', undefined)).toBe(DEFAULT_PAYMENT_STATUS);
  });

  it('trusts a stored status over the price, and lands an unknown one on the default', () => {
    expect(normalizePaymentStatus('paused', '$500')).toBe('paused');
    expect(normalizePaymentStatus('Cancelled', '$500')).toBe('cancelled');
    expect(normalizePaymentStatus('whatever', '$500')).toBe(DEFAULT_PAYMENT_STATUS);
  });

  it('decides the price column from the status: only paying keeps an amount', () => {
    expect(subscriptionPriceFor('paying', 400)).toBe('$400');
    expect(subscriptionPriceFor('paying', null)).toBe('Undetermined');
    expect(subscriptionPriceFor('free', 500)).toBe('Free');
    for (const status of ['paused', 'idle', 'cancelled', 'undetermined']) {
      expect(subscriptionPriceFor(status, 500)).toBe('Undetermined');
    }
  });
});
