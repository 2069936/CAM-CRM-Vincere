import { describe, it, expect } from 'vitest';
import {
  conversionFromFree,
  monthlyValue,
  revenueLeakage,
  revenueMovement,
  revenueSnapshot,
} from './revenueHealth';

const client = (over = {}) => ({ id: over.id || 'c', name: 'C', status: 'Active', deletedAt: null, ...over });

const book = () => [
  client({ id: 'a', subscriptionPrice: '$500' }),
  client({ id: 'b', subscriptionPrice: '$500' }),
  client({ id: 'c', subscriptionPrice: '$250' }),
  client({ id: 'd', subscriptionPrice: 'Free' }),
  client({ id: 'e', subscriptionPrice: 'Undetermined' }),
  client({ id: 'f', subscriptionPrice: 'Undetermined' }),
];

describe('what the desk earns today', () => {
  it('adds up only the clients somebody has priced', () => {
    expect(revenueSnapshot(book())).toMatchObject({ mrr: 1250, priced: 4, unpriced: 2 });
  });

  it('reports how many it could not price, because on this book that is most of them', () => {
    // 83 of 121 active clients sit on Undetermined. A dashboard that treats
    // "we never asked" as $0 reports a business half its size and gets believed.
    expect(revenueSnapshot(book()).unpriced).toBe(2);
  });

  it('averages over priced clients, not over everyone', () => {
    // Dividing by everyone punishes the average for clients nobody classified,
    // so the number would drift every time someone did classification work.
    expect(revenueSnapshot(book()).arpc).toBe(312.5);
  });

  it('counts each tier and its share of the base', () => {
    const snapshot = revenueSnapshot(book());
    expect(snapshot.byTier).toMatchObject({ $500: 2, $250: 1, Free: 1, Undetermined: 2 });
    expect(snapshot.tierShare.$500).toBe(33.3);
  });

  it('leaves out deleted and non-active clients', () => {
    const withNoise = [
      ...book(),
      client({ id: 'x', subscriptionPrice: '$500', deletedAt: '2026-01-01' }),
      client({ id: 'y', subscriptionPrice: '$500', status: 'Churned' }),
    ];
    expect(revenueSnapshot(withNoise).mrr).toBe(1250);
  });

  it('treats an unknown tier string as undetermined rather than as zero revenue', () => {
    expect(monthlyValue('$999')).toBeNull();
    expect(monthlyValue(undefined)).toBeNull();
    expect(monthlyValue('Free')).toBe(0);
  });

  it('survives an empty book', () => {
    expect(revenueSnapshot([])).toMatchObject({ mrr: 0, arpc: 0, activeClients: 0 });
    expect(revenueSnapshot(null).mrr).toBe(0);
  });
});

describe('the money not being collected', () => {
  const freeBook = () => [
    client({ id: 'a', subscriptionPrice: '$500' }),
    client({ id: 'p', subscriptionPrice: 'Free', freeSince: '2026-08-25' }),
    client({ id: 'q', subscriptionPrice: 'Free', freeSince: '2026-03-01' }),
    client({ id: 'r', subscriptionPrice: 'Free', freeSince: '2026-08-01', tags: ['Refund save'] }),
  ];

  it('takes refund saves out of the convertible pipeline', () => {
    // A refund save arrived on Free because a prop firm kept them instead of
    // refunding. They look identical to an unconverted client and mean the
    // opposite, so pricing them as pipeline inflates it with people who were
    // never going to pay this quarter.
    expect(revenueLeakage(freeBook(), { asOf: '2026-09-08' }))
      .toMatchObject({ freeClients: 3, convertible: 2, refundSaves: 1 });
  });

  it('prices the pipeline at what PAYING clients pay, not at an average the free ones drag down', () => {
    // The brief said to value free clients at the average revenue per client.
    // Taken literally the calculation eats itself: the average is pulled down
    // by the very clients being valued, so the more unconverted revenue there
    // is, the less each one looks worth. This book has one payer at $500 and
    // two convertible free clients, so the pipeline is $1,000.
    expect(revenueLeakage(freeBook(), { asOf: '2026-09-08' }).potentialMrr).toBe(1000);
  });

  it('reports both averages, because they answer different questions', () => {
    const snapshot = revenueSnapshot(freeBook());
    expect(snapshot.arpc).toBe(125);
    expect(snapshot.arpuPaying).toBe(500);
  });

  it('ages the free clients longest first, because six months is a different problem from two weeks', () => {
    const aging = revenueLeakage(freeBook(), { asOf: '2026-09-08' }).aging;
    expect(aging.map((entry) => entry.id)).toEqual(['q', 'p']);
    expect(aging[0].days).toBe(191);
    expect(aging[1].days).toBe(14);
  });

  it('says how many could not be aged instead of showing them as brand new', () => {
    const result = revenueLeakage([client({ id: 'z', subscriptionPrice: 'Free' })], { asOf: '2026-09-08' });
    expect(result.undated).toBe(1);
    expect(result.aging[0].days).toBeNull();
  });
});

describe('what moved, and how far back anyone can actually see', () => {
  const changes = [
    { clientId: 'a', at: '2026-09-02T10:00:00Z', from: 'Free', to: '$500' },
    { clientId: 'b', at: '2026-09-04T10:00:00Z', from: '$250', to: 'Free' },
    { clientId: 'c', at: '2026-08-20T10:00:00Z', from: 'Free', to: '$250' },
  ];

  it('separates revenue added from revenue lost', () => {
    expect(revenueMovement(changes, { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' }))
      .toMatchObject({ newMrr: 500, lostMrr: 250, netMrr: 250, changes: 2 });
  });

  it('flags a period that starts before the log did, instead of answering zero', () => {
    // The audit log recorded WHICH field changed and never the values, so
    // nothing before this log exists. A confident zero over a period nobody
    // recorded is worse than an admission.
    expect(revenueMovement(changes, { from: '2026-01-01', to: '2026-09-30', logStartedAt: '2026-08-01' }))
      .toMatchObject({ partialPeriod: true });
    expect(revenueMovement(changes, { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' }).partialPeriod)
      .toBe(false);
  });

  it('treats an undetermined tier as no revenue on both sides of a change', () => {
    expect(revenueMovement(
      [{ clientId: 'a', at: '2026-09-02T10:00:00Z', from: 'Undetermined', to: '$250' }],
      { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' },
    ).newMrr).toBe(250);
  });

  it('says the period is partial when there is no log at all', () => {
    expect(revenueMovement([], { from: '2026-09-01', to: '2026-09-30' }).partialPeriod).toBe(true);
  });
});

describe('how many free clients ever started paying', () => {
  const history = [
    { clientId: 'a', at: '2026-07-01T00:00:00Z', from: 'Undetermined', to: 'Free' },
    { clientId: 'a', at: '2026-08-01T00:00:00Z', from: 'Free', to: '$500' },
    { clientId: 'b', at: '2026-07-01T00:00:00Z', from: 'Undetermined', to: 'Free' },
    { clientId: 'c', at: '2026-06-01T00:00:00Z', from: '$250', to: 'Free' },
    { clientId: 'c', at: '2026-06-11T00:00:00Z', from: 'Free', to: '$250' },
  ];

  it('counts only clients whose whole transition is inside the log', () => {
    // Anyone already paying when the log opened is in neither number. A rate
    // computed without saying so is wrong in the direction that flatters us.
    expect(conversionFromFree(history, { logStartedAt: '2026-06-01' }))
      .toMatchObject({ startedFree: 3, converted: 2, rate: 66.7 });
  });

  it('reports the median time, not the mean', () => {
    // One client who took a year is not the typical story and a mean lets them
    // tell it.
    expect(conversionFromFree(history, { logStartedAt: '2026-06-01' }).medianDaysToConvert).toBe(31);
  });

  it('does not count a move back to Free as a conversion', () => {
    expect(conversionFromFree([
      { clientId: 'z', at: '2026-07-01T00:00:00Z', from: '$500', to: 'Free' },
    ], { logStartedAt: '2026-06-01' })).toMatchObject({ startedFree: 1, converted: 0, rate: 0 });
  });

  it('answers nothing rather than zero days when nobody has converted', () => {
    expect(conversionFromFree([], { logStartedAt: '2026-06-01' }).medianDaysToConvert).toBeNull();
  });
});
