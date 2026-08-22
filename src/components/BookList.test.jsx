// @vitest-environment jsdom
//
// The one rule for a list as long as the book: bound it, say it scrolls, and
// never drop an entry.
//
// The second half is the one that needs a test. A bounded box that renders 12 of
// 95 entries looks exactly like a bounded box that renders all 95, because the
// difference is below the fold either way — and this codebase has shipped that
// mistake twice, once as a `+N more` that was a plain span hiding 192 of 267
// configuration differences, and once as a drill-down that dropped every row
// past its limit. So the count is asserted against the DOM, not against a prop.

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import BookList from './BookList';

afterEach(cleanup);

const clients = (n) => Array.from({ length: n }, (_, index) => ({
  id: `c${index}`,
  name: `Client ${index}`,
}));

const renderList = (props = {}) => render(
  <BookList items={clients(95)} keyOf={(client) => client.id} {...props}>
    {(client) => <span>{client.name}</span>}
  </BookList>,
);

describe('nothing is dropped', () => {
  it('renders every entry, however long the book is', () => {
    const { container } = renderList();
    expect(container.querySelectorAll('.book-list-item')).toHaveLength(95);
    // Both ends, named: a slice that kept the head would still pass a count of
    // "some", and a reversed one would still pass a check on the first.
    expect(screen.getByText('Client 0')).toBeTruthy();
    expect(screen.getByText('Client 94')).toBeTruthy();
  });

  it('keeps the entries in the order it was given them', () => {
    const { container } = renderList({ items: clients(5) });
    expect([...container.querySelectorAll('.book-list-item')].map((node) => node.textContent))
      .toEqual(['Client 0', 'Client 1', 'Client 2', 'Client 3', 'Client 4']);
  });
});

describe('it says that it scrolls', () => {
  it('states the true total, not the number that fits', () => {
    renderList({ fits: 6 });
    expect(screen.getByText('All 95 clients are here — the list scrolls.')).toBeTruthy();
  });

  it('stays quiet when everything fits, rather than saying so for no reason', () => {
    const { container } = renderList({ items: clients(4), fits: 6 });
    expect(container.querySelector('.book-list-note')).toBeNull();
    expect(container.querySelectorAll('.book-list-item')).toHaveLength(4);
  });

  it('speaks at one past what fits, not one before', () => {
    const at = (n) => {
      cleanup();
      const { container } = renderList({ items: clients(n), fits: 6 });
      return Boolean(container.querySelector('.book-list-note'));
    };
    expect(at(6)).toBe(false);
    expect(at(7)).toBe(true);
  });

  it('names what it is counting, and gets the singular right', () => {
    renderList({ items: clients(3), fits: 1, noun: 'account' });
    expect(screen.getByText('All 3 accounts are here — the list scrolls.')).toBeTruthy();
    cleanup();
    renderList({ items: clients(2), fits: 1, noun: 'algorithm', nounPlural: 'algorithms' });
    expect(screen.getByText('All 2 algorithms are here — the list scrolls.')).toBeTruthy();
  });

  it('is bounded and scrollable, not just visually short', () => {
    // The class carries the max-height and the overflow. Without it the "it
    // scrolls" note is a claim about nothing.
    const { container } = renderList();
    expect(container.querySelector('.book-list-body')).toBeTruthy();
  });
});

describe('an empty book', () => {
  it('renders what the caller supplies and no note', () => {
    const { container } = render(
      <BookList items={[]} empty={<em>nobody here</em>}>
        {(client) => <span>{client.name}</span>}
      </BookList>,
    );
    expect(within(container).getByText('nobody here')).toBeTruthy();
    expect(container.querySelector('.book-list-note')).toBeNull();
    expect(container.querySelectorAll('.book-list-item')).toHaveLength(0);
  });
});
