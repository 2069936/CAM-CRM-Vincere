import { describe, it, expect } from 'vitest';
import {
  conversionFromFree,
  monthlyValue,
  payingAmountOf,
  revenueLeakage,
  revenueMovement,
  revenueSnapshot,
} from './revenueHealth';

const client = (over = {}) => ({ id: over.id || 'c', name: 'C', status: 'Active', deletedAt: null, ...over });

/* The book the desk's sheet describes: amounts, not tiers. */
const book = () => [
  client({ id: 'a', paymentStatus: 'paying', subscriptionPrice: '$500' }),
  client({ id: 'b', paymentStatus: 'paying', subscriptionPrice: '$500' }),
  client({ id: 'c', paymentStatus: 'paying', subscriptionPrice: '$400' }),
  client({ id: 'd', paymentStatus: 'paying', subscriptionPrice: '$183' }),
  // Paying, but the sheet says "???": counted as paying, left out of the MRR.
  client({ id: 'e', paymentStatus: 'paying', subscriptionPrice: 'Undetermined' }),
  client({ id: 'f', paymentStatus: 'free', subscriptionPrice: 'Free' }),
  client({ id: 'g', paymentStatus: 'paused', subscriptionPrice: 'Undetermined' }),
  client({ id: 'h', paymentStatus: 'idle', subscriptionPrice: 'Undetermined' }),
  client({ id: 'i', paymentStatus: 'undetermined', subscriptionPrice: 'Undetermined' }),
  client({ id: 'j', paymentStatus: 'undetermined', subscriptionPrice: 'Undetermined' }),
  // Cancelled: still 'Active' on the CRM record, not part of the base.
  client({ id: 'k', paymentStatus: 'cancelled', subscriptionPrice: 'Undetermined' }),
];

describe('what the desk earns today', () => {
  it('adds up the amounts of the paying clients with an amount', () => {
    expect(revenueSnapshot(book())).toMatchObject({ mrr: 1583, paying: 5, payingUnknownAmount: 1 });
  });

  it('reports how many it could not price: the undetermined and the paying with no amount', () => {
    // 97 of the active clients sit on undetermined. A dashboard that treats
    // "we never asked" as $0 reports a business half its size and gets believed.
    expect(revenueSnapshot(book())).toMatchObject({ unpriced: 3, priced: 7 });
  });

  it('excludes cancelled clients from the active base', () => {
    expect(revenueSnapshot(book()).activeClients).toBe(10);
    expect(revenueSnapshot(book()).byStatus).not.toHaveProperty('cancelled');
  });

  it('does not count a paused or idle client\'s old amount', () => {
    const paused = [client({ id: 'p', paymentStatus: 'paused', subscriptionPrice: '$500' })];
    expect(revenueSnapshot(paused)).toMatchObject({ mrr: 0, paying: 0 });
    expect(payingAmountOf(paused[0])).toBeNull();
  });

  it('averages over priced clients, not over everyone, and over paying clients for the pipeline', () => {
    const snapshot = revenueSnapshot(book());
    expect(snapshot.arpc).toBe(226.14);
    expect(snapshot.arpuPaying).toBe(395.75);
  });

  it('groups the base by distinct amount, highest first, with each amount\'s MRR and share', () => {
    expect(revenueSnapshot(book()).byAmount).toEqual([
      { amount: 500, clients: 2, mrr: 1000, share: 20 },
      { amount: 400, clients: 1, mrr: 400, share: 10 },
      { amount: 183, clients: 1, mrr: 183, share: 10 },
    ]);
  });

  it('counts each status and its share of the base', () => {
    const snapshot = revenueSnapshot(book());
    expect(snapshot.byStatus).toEqual({ paying: 5, free: 1, undetermined: 2, paused: 1, idle: 1 });
    expect(snapshot.statusShare.paying).toBe(50);
    expect(snapshot.statusShare.undetermined).toBe(20);
  });

  it('leaves out deleted and non-active clients', () => {
    const withNoise = [
      ...book(),
      client({ id: 'x', paymentStatus: 'paying', subscriptionPrice: '$500', deletedAt: '2026-01-01' }),
      client({ id: 'y', paymentStatus: 'paying', subscriptionPrice: '$500', status: 'Churned' }),
    ];
    expect(revenueSnapshot(withNoise).mrr).toBe(1583);
  });

  it('derives the status from the price when a client carries none, so an old book still reads', () => {
    const legacy = [
      client({ id: 'a', subscriptionPrice: '$500' }),
      client({ id: 'b', subscriptionPrice: '$250' }),
      client({ id: 'c', subscriptionPrice: 'Free' }),
      client({ id: 'd', subscriptionPrice: 'Undetermined' }),
    ];
    expect(revenueSnapshot(legacy)).toMatchObject({ mrr: 750, paying: 2, unpriced: 1, byStatus: { free: 1, undetermined: 1 } });
  });

  it('treats an unknown price string as no revenue rather than as zero revenue', () => {
    expect(monthlyValue('premium')).toBeNull();
    expect(monthlyValue(undefined)).toBeNull();
    expect(monthlyValue('Free')).toBe(0);
    expect(monthlyValue('$333')).toBe(333);
  });

  it('survives an empty book', () => {
    expect(revenueSnapshot([])).toMatchObject({ mrr: 0, arpc: 0, activeClients: 0, byAmount: [] });
    expect(revenueSnapshot(null).mrr).toBe(0);
  });
});

describe('the money not being collected', () => {
  const freeBook = () => [
    client({ id: 'a', paymentStatus: 'paying', subscriptionPrice: '$500' }),
    client({ id: 'p', paymentStatus: 'free', subscriptionPrice: 'Free', freeSince: '2026-08-25' }),
    client({ id: 'q', paymentStatus: 'free', subscriptionPrice: 'Free', freeSince: '2026-03-01' }),
    client({ id: 'r', paymentStatus: 'free', subscriptionPrice: 'Free', freeSince: '2026-08-01', tags: ['Refund save'] }),
    // A cancelled client who was free is not pipeline.
    client({ id: 's', paymentStatus: 'cancelled', subscriptionPrice: 'Undetermined', freeSince: '2026-08-01' }),
  ];

  it('takes refund saves out of the convertible pipeline', () => {
    expect(revenueLeakage(freeBook(), { asOf: '2026-09-08' }))
      .toMatchObject({ freeClients: 3, convertible: 2, refundSaves: 1 });
  });

  it('prices the pipeline at what PAYING clients pay, not at an average the free ones drag down', () => {
    expect(revenueLeakage(freeBook(), { asOf: '2026-09-08' }).potentialMrr).toBe(1000);
  });

  it('reports both averages, because they answer different questions', () => {
    const snapshot = revenueSnapshot(freeBook());
    expect(snapshot.arpc).toBe(125);
    expect(snapshot.arpuPaying).toBe(500);
  });

  it('ages the free clients longest first', () => {
    const aging = revenueLeakage(freeBook(), { asOf: '2026-09-08' }).aging;
    expect(aging.map((entry) => entry.id)).toEqual(['q', 'p']);
    expect(aging[0].days).toBe(191);
    expect(aging[1].days).toBe(14);
  });

  it('says how many could not be aged instead of showing them as brand new', () => {
    const result = revenueLeakage([client({ id: 'z', paymentStatus: 'free', subscriptionPrice: 'Free' })], { asOf: '2026-09-08' });
    expect(result.undated).toBe(1);
    expect(result.aging[0].days).toBeNull();
  });
});

describe('what moved, and how far back anyone can actually see', () => {
  const changes = [
    { clientId: 'a', at: '2026-09-02T10:00:00Z', from: 'Free', to: '$400' },
    { clientId: 'b', at: '2026-09-04T10:00:00Z', from: '$250', to: 'Free' },
    { clientId: 'c', at: '2026-08-20T10:00:00Z', from: 'Free', to: '$250' },
  ];

  it('separates revenue added from revenue lost, at the amounts the log holds', () => {
    expect(revenueMovement(changes, { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' }))
      .toMatchObject({ newMrr: 400, lostMrr: 250, netMrr: 150, changes: 2 });
  });

  it('records a pause or a cancellation as lost MRR, because the price column goes to Undetermined', () => {
    expect(revenueMovement(
      [{ clientId: 'a', at: '2026-09-02T10:00:00Z', from: '$375', to: 'Undetermined' }],
      { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' },
    )).toMatchObject({ newMrr: 0, lostMrr: 375 });
  });

  it('flags a period that starts before the log did, instead of answering zero', () => {
    expect(revenueMovement(changes, { from: '2026-01-01', to: '2026-09-30', logStartedAt: '2026-08-01' }))
      .toMatchObject({ partialPeriod: true });
    expect(revenueMovement(changes, { from: '2026-09-01', to: '2026-09-30', logStartedAt: '2026-08-01' }).partialPeriod)
      .toBe(false);
  });

  it('treats an undetermined price as no revenue on both sides of a change', () => {
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
    { clientId: 'a', at: '2026-08-01T00:00:00Z', from: 'Free', to: '$333' },
    { clientId: 'b', at: '2026-07-01T00:00:00Z', from: 'Undetermined', to: 'Free' },
    { clientId: 'c', at: '2026-06-01T00:00:00Z', from: '$250', to: 'Free' },
    { clientId: 'c', at: '2026-06-11T00:00:00Z', from: 'Free', to: '$250' },
  ];

  it('counts only clients whose whole transition is inside the log', () => {
    expect(conversionFromFree(history, { logStartedAt: '2026-06-01' }))
      .toMatchObject({ startedFree: 3, converted: 2, rate: 66.7 });
  });

  it('reports the median time, not the mean', () => {
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
