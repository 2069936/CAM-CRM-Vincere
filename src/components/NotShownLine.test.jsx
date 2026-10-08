// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import NotShownLine from './NotShownLine';
import { registryLights } from '../domain/accountBuckets';

/* ------------------------------------------------------------------------- *
 * THE ONE FOLDED LINE UNDER A TILE, A STRIP OR A DRAWER.
 *
 * Pedro's words: show only the accounts expected to trade, and say in one
 * collapsed line why the others are not shown, so a CAM can tell a dead
 * account from a new one from a missing one. The line is muted, the names are
 * behind a Show toggle, each with its reason word, and there is nothing at all
 * when every account is expected.
 * ------------------------------------------------------------------------- */

const NOW = '2026-10-08T15:00:00Z';

function meta(over = {}) {
  return {
    accountType: 'Funded', status: 'Active', observedState: 'seen', closesMissed: 0,
    lastCloseSeenOn: '2026-10-07', breachedOn: '', breachReading: null, dateAdded: '2026-06-01', ...over,
  };
}

const REGISTRY = {
  'ACC 01': meta(),
  'ACC 02': meta({ observedState: 'breached', breachedOn: '2026-10-07', breachReading: -263 }),
  'ACC 03': meta({ observedState: 'absent', closesMissed: 6, lastCloseSeenOn: '2026-09-29' }),
  'ACC 04': meta({ observedState: 'never_seen', dateAdded: '2026-10-06' }),
  'ACC 05': meta({ status: 'Failed' }),
};

afterEach(cleanup);

describe('NotShownLine', () => {
  it('renders nothing when there is nothing to hide', () => {
    expect(render(<NotShownLine notShown={null} />).container.innerHTML).toBe('');
    cleanup();
    const allExpected = registryLights({ 'ACC 01': meta(), 'ACC 04': meta({ observedState: 'never_seen', dateAdded: '2026-10-06' }) }, { now: NOW });
    expect(allExpected.notShown).toBeNull();
    expect(render(<NotShownLine notShown={allExpected.notShown} />).container.innerHTML).toBe('');
  });

  it('is one muted line with a Show toggle, and the names with their reason word behind it', () => {
    const { notShown } = registryLights(REGISTRY, { now: NOW });
    const { container } = render(<NotShownLine notShown={notShown} label="Maple Ridge, accounts not shown" />);
    const line = container.querySelector('.not-shown');
    expect(line.querySelector('.not-shown-words').textContent)
      .toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. 1 retired: 1 Failed.');
    expect(line.querySelector('.not-shown-words').className).toContain('muted');
    const toggle = line.querySelector('button.not-shown-toggle');
    expect(toggle.textContent).toBe('Show');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show Maple Ridge, accounts not shown');
    expect(line.querySelector('.not-shown-list')).toBeNull();

    act(() => { toggle.click(); });
    expect(toggle.textContent).toBe('Hide');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = line.querySelector('.not-shown-list');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    expect(list.className).toContain('muted');
    const items = [...list.querySelectorAll('li')];
    expect(items.map((item) => item.textContent)).toEqual(['ACC 02 looks failed', 'ACC 03 gone from the close', 'ACC 05 Failed']);
    expect(items.map((item) => item.querySelector('.not-shown-name').textContent)).toEqual(['ACC 02', 'ACC 03', 'ACC 05']);
    expect(items.map((item) => item.querySelector('.not-shown-reason').textContent)).toEqual(['looks failed', 'gone from the close', 'Failed']);
    // What the close saw, one hover away on each name.
    expect(items[0].getAttribute('title')).toBe('Breached on 2026-10-07, reading -$263, status still Active.');
    expect(items[1].getAttribute('title')).toBe('Gone from the close for 6 closes, last seen 2026-09-29.');

    act(() => { toggle.click(); });
    expect(toggle.textContent).toBe('Show');
    expect(line.querySelector('.not-shown-list')).toBeNull();
  });

  it('has a rule in index.css for every class it renders, and prints no dash', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const { notShown } = registryLights(REGISTRY, { now: NOW });
    const { container } = render(<NotShownLine notShown={notShown} />);
    act(() => { container.querySelector('button').click(); });
    const classes = new Set();
    for (const node of container.querySelectorAll('[class]')) {
      for (const name of node.classList) if (name.startsWith('not-shown')) classes.add(name);
    }
    expect([...classes].sort()).toEqual(['not-shown', 'not-shown-list', 'not-shown-name', 'not-shown-reason', 'not-shown-toggle', 'not-shown-words']);
    for (const name of classes) expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    expect(container.textContent).not.toMatch(/—|–| - /);
    for (const node of container.querySelectorAll('[title]')) expect(node.getAttribute('title')).not.toMatch(/—|–| - /);
  });
});
