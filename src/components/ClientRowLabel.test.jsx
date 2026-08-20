// @vitest-environment jsdom
//
// Which half of a client row is allowed to be cut.
//
// The CAM's report was two sidebar rows: one reading "Ca..." and one reading
// only "...". The kind chip already carried `white-space: nowrap`
// (src/index.css:6947), so the chip was never the thing being measured — the
// name and the chip shared one <span>, `.client-link span` made that span an
// ellipsing box, and the ellipsis cut the end of the run, which is the chip.
//
// A test that asserted on class names would have passed on the broken version:
// the classes were fine, the box model was not. So this file loads the real
// src/index.css into jsdom and asserts what the CASCADE produces on a real
// render — and, at the bottom, renders the OLD markup shape and asserts the same
// checks FAIL on it, so a future refactor cannot quietly make these assertions
// vacuous.
//
// jsdom has no layout engine, so "the chip is 75px wide" is not assertable here;
// that number came from the browser (280px sidebar -> 201.5px label -> the chip
// keeps its 75.2px and the name gets what is left). What IS assertable, and what
// actually decides the bug, is which boxes ellipse and which boxes are allowed
// to shrink. Both are computed style.

import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import ClientKindBadge from './ClientKindBadge';
import ClientRowLabel from './ClientRowLabel';

afterEach(cleanup);

beforeAll(() => {
  // The real stylesheet, not a hand-copied excerpt: the defect lived in the
  // interaction between `.client-link span` and the row, so a trimmed copy
  // could hide it.
  const style = document.createElement('style');
  // Relative to the repo root: under the jsdom environment import.meta.url is an
  // http URL, which readFileSync will not take.
  style.textContent = readFileSync('src/index.css', 'utf8');
  document.head.appendChild(style);
});

/** A client whose account mix produces the widest label: "Cash + Prop". */
const mixedClient = {
  id: 'c1',
  name: 'Wrenfield Larchmont-Beauchamp',
  accountRegistry: {
    A: { accountName: 'A', accountType: 'Cash - IRA', status: 'Active' },
    B: { accountName: 'B', accountType: 'Funded', status: 'Active' },
  },
};

/** Renders inside a `.client-link`, because that is where the rules are scoped. */
function renderRow(children) {
  return render(<div className="client-link">{children}</div>);
}

/** True when this element is a box that paints an ellipsis over its overflow. */
function ellipses(element) {
  const style = getComputedStyle(element);
  return style.textOverflow === 'ellipsis' && style.overflow !== 'visible';
}

/** Every ancestor between `element` and the row, `element` included. */
function selfAndAncestorsWithinRow(element) {
  const chain = [];
  for (let node = element; node && !node.classList.contains('client-link'); node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

describe('ClientRowLabel — the name is cut, the chip is not', () => {
  it('gives the name its own ellipsing box', () => {
    const { container } = renderRow(
      <ClientRowLabel name={mixedClient.name}>
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const name = container.querySelector('.client-row-name');
    expect(name.textContent).toBe('Wrenfield Larchmont-Beauchamp');
    expect(ellipses(name)).toBe(true);
    expect(getComputedStyle(name).whiteSpace).toBe('nowrap');
    // It must be the item that gives up width when the row is too narrow.
    expect(getComputedStyle(name).flexShrink).toBe('1');
    expect(getComputedStyle(name).minWidth).toBe('0px');
  });

  it('puts no ellipsing box anywhere above the chip', () => {
    // THE ASSERTION THE BUG WOULD HAVE FAILED. The chip is not clipped by its
    // own styling and never was; it was clipped by an ancestor. So the check is
    // on the ancestors, not on the chip.
    const { container } = renderRow(
      <ClientRowLabel name={mixedClient.name}>
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const chip = container.querySelector('.client-kind');
    expect(chip.textContent).toBe('Cash + Prop');
    const clipping = selfAndAncestorsWithinRow(chip).filter(ellipses);
    expect(clipping.map((el) => el.className)).toEqual([]);
  });

  it('does not let the chip give up width', () => {
    const { container } = renderRow(
      <ClientRowLabel name={mixedClient.name}>
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const chip = container.querySelector('.client-kind');
    expect(getComputedStyle(chip).flexShrink).toBe('0');
    expect(getComputedStyle(chip).whiteSpace).toBe('nowrap');
  });

  it('treats every other thing in the row the same way as the chip', () => {
    // The Covering pill, the last-contact dot and the task count are handed in
    // as children exactly like the chip is, and a 6px dot squeezed to 4px is as
    // wrong as a half-printed chip.
    const { container } = renderRow(
      <ClientRowLabel name={mixedClient.name}>
        <ClientKindBadge client={mixedClient} />
        <span className="client-kind client-kind-covering">Covering</span>
        <span className="last-contact-dot" />
        <span className="task-count">3</span>
      </ClientRowLabel>,
    );
    const label = container.querySelector('.client-row-label');
    const fixed = [...label.children].filter((el) => !el.classList.contains('client-row-name'));
    expect(fixed).toHaveLength(4);
    for (const element of fixed) {
      expect(getComputedStyle(element).flexShrink).toBe('0');
    }
  });

  it('lays the label out as a line, so the name and the chips sit side by side', () => {
    const { container } = renderRow(
      <ClientRowLabel name={mixedClient.name}>
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const label = container.querySelector('.client-row-label');
    expect(getComputedStyle(label).display).toBe('flex');
    expect(getComputedStyle(label).minWidth).toBe('0px');
    expect(ellipses(label)).toBe(false);
  });

  it('keeps a leading badge inside the label instead of beside it', () => {
    // Not a styling preference — a grid-placement one. `.client-link` is a
    // 3-column grid filled by auto-placement, so a "NEW" badge rendered as a
    // sibling of the label makes the label the row's THIRD child and moves it
    // into the `auto` track, which the grid grows to content before the 1fr
    // track gets anything. Measured in the browser at a 280px sidebar: columns
    // resolved to `16px 0px 213px`, the 28px badge painted 10px wide and the pin
    // star resolved to width 0 — unclickable on exactly the rows with new data.
    // jsdom cannot measure that, but it can hold the shape that causes it: the
    // badge must be a descendant of the label, and the label must stay the row's
    // second child.
    const { container } = renderRow(
      <ClientRowLabel
        name={mixedClient.name}
        leading={<span className="new-data-badge">NEW</span>}
      >
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const row = container.querySelector('.client-link');
    const label = container.querySelector('.client-row-label');
    const badge = container.querySelector('.new-data-badge');
    expect(label.contains(badge)).toBe(true);
    expect(badge.parentElement).toBe(label);
    expect([...row.children]).toEqual([label]);
    // Before the name, and never the item that gives up width.
    expect(label.firstElementChild).toBe(badge);
    expect(getComputedStyle(badge).flexShrink).toBe('0');
  });

  it('renders no leading slot when there is nothing to lead with', () => {
    const { container } = renderRow(
      <ClientRowLabel name="Kai Moss">
        <ClientKindBadge client={mixedClient} />
      </ClientRowLabel>,
    );
    const label = container.querySelector('.client-row-label');
    expect(label.firstElementChild.className).toBe('client-row-name');
  });

  it('renders nothing extra for a client with no account mix', () => {
    const { container } = renderRow(<ClientRowLabel name="Kai Moss" />);
    const label = container.querySelector('.client-row-label');
    expect(label.textContent).toBe('Kai Moss');
    expect(label.children).toHaveLength(1);
  });
});

describe('the checks above have teeth', () => {
  // The markup this replaced, rendered on purpose. If these two stop failing the
  // way they used to, the assertions above have stopped testing anything.
  function renderOldMarkup() {
    return renderRow(
      <span>
        {mixedClient.name}
        <ClientKindBadge client={mixedClient} />
      </span>,
    );
  }

  it('the old single-span row does put an ellipsing box above the chip', () => {
    const { container } = renderOldMarkup();
    const chip = container.querySelector('.client-kind');
    const clipping = selfAndAncestorsWithinRow(chip).filter(ellipses);
    // The precise shape of the bug: a box that holds the name AND the chip, and
    // ellipses the two of them as one run of text. The name is at the front of
    // that run, so the chip is what the ellipsis eats.
    const carriesBoth = clipping.find(
      (el) => el.textContent.includes('Wrenfield') && el.textContent.includes('Cash + Prop'),
    );
    expect(carriesBoth).toBeTruthy();
  });

  it('the old single-span row has no separate box for the name to be cut in', () => {
    const { container } = renderOldMarkup();
    expect(container.querySelector('.client-row-name')).toBeNull();
  });
});
