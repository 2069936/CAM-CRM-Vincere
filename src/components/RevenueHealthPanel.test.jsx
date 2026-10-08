import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RevenueHealthPanel from './RevenueHealthPanel';

const client = (over) => ({ id: over.id, name: over.name || over.id, status: 'Active', deletedAt: null, ...over });

const book = [
  client({ id: 'a', paymentStatus: 'paying', subscriptionPrice: '$500' }),
  client({ id: 'b', paymentStatus: 'paying', subscriptionPrice: '$250' }),
  client({ id: 'c', paymentStatus: 'free', subscriptionPrice: 'Free', name: 'Long free', freeSince: '2026-03-01' }),
  client({ id: 'd', paymentStatus: 'free', subscriptionPrice: 'Free', name: 'Saved', tags: ['Refund save'] }),
  client({ id: 'e', paymentStatus: 'undetermined', subscriptionPrice: 'Undetermined' }),
  client({ id: 'f', paymentStatus: 'undetermined', subscriptionPrice: 'Undetermined' }),
  client({ id: 'g', paymentStatus: 'paused', subscriptionPrice: 'Undetermined' }),
  client({ id: 'h', paymentStatus: 'cancelled', subscriptionPrice: 'Undetermined' }),
];

const render = (props = {}) => renderToStaticMarkup(
  <RevenueHealthPanel clients={book} asOf="2026-09-08" monthStart="2026-09-01" {...props} />,
);

describe('the page says what it cannot see', () => {
  it('prints the MRR as a floor while clients are unpriced', () => {
    // A dashboard that treats "nobody asked" as $0 reports a business half its
    // size and gets believed.
    const html = render();
    expect(html).toContain('$750');
    expect(html).toContain('Floor, not total');
    expect(html).toContain('2 of 7 clients have no amount set');
  });

  it('warns that every number understates the desk while the status is unset', () => {
    expect(render()).toContain('understates the desk');
  });

  it('drops the caveat once every client is priced', () => {
    const priced = book.filter((c) => c.paymentStatus !== 'undetermined');
    expect(render({ clients: priced })).toContain('Every active client is priced');
  });

  it('lists the base by amount, highest first, then by the statuses that bring in nothing', () => {
    const html = render({ clients: [...book, client({ id: 'i', paymentStatus: 'paying', subscriptionPrice: '$400' })] });
    const order = ['$500 a month', '$400 a month', '$250 a month', 'Free', 'Paused', 'Idle', 'Undetermined']
      .map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).not.toContain('Cancelled');
  });

  it('counts cancelled clients out of the base and says so', () => {
    expect(render()).toContain('7 active clients, cancelled excluded');
  });

  it('shows a paying client with no amount on record as its own warning row', () => {
    const html = render({ clients: [...book, client({ id: 'j', paymentStatus: 'paying', subscriptionPrice: 'Undetermined' })] });
    expect(html).toContain('Paying, amount unknown');
    expect(html).toContain('3 of 8 clients have no amount set');
  });
});

describe('the pipeline', () => {
  it('separates refund saves from clients who simply have not converted', () => {
    const html = render();
    expect(html).toContain('1 of them are refund saves');
    expect(html).toContain('the firm already paid to keep them');
  });

  it('ages the free clients it can and says so about the ones it cannot', () => {
    const html = render();
    expect(html).toContain('191 days');
  });
});

describe('movement', () => {
  it('says the period is not recorded rather than reporting zero', () => {
    // The audit trail recorded which field changed and never the values.
    expect(render()).toContain('not recorded rather than zero');
  });

  it('reports real movement once the log covers the period', () => {
    const html = render({
      priceLogStartedAt: '2026-08-01T00:00:00Z',
      priceChanges: [
        { clientId: 'a', at: '2026-09-02T00:00:00Z', from: 'Free', to: '$500' },
        { clientId: 'b', at: '2026-09-03T00:00:00Z', from: '$250', to: 'Free' },
      ],
    });
    expect(html).not.toContain('not recorded rather than zero');
    expect(html).toContain('2 price changes recorded');
  });
});

describe('conversion', () => {
  it('explains why it is empty instead of showing a confident zero percent', () => {
    expect(render()).toContain('Nothing to measure yet');
  });

  it('reports the rate once whole transitions exist in the log', () => {
    const html = render({
      priceLogStartedAt: '2026-06-01T00:00:00Z',
      priceChanges: [
        { clientId: 'a', at: '2026-07-01T00:00:00Z', from: 'Undetermined', to: 'Free' },
        { clientId: 'a', at: '2026-08-01T00:00:00Z', from: 'Free', to: '$500' },
      ],
    });
    expect(html).toContain('1 of 1');
    expect(html).toContain('31 days');
  });
});

describe('robustness', () => {
  it('renders with nothing at all', () => {
    expect(() => renderToStaticMarkup(<RevenueHealthPanel />)).not.toThrow();
  });
});
