// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrackerCloseOverview from './TrackerCloseOverview';
import { buildTrackerCloseOverview } from '../domain/trackerClosePanel';
import { CLIENT, DATE, READINGS, SETTINGS, dailyImport, reading, snapshot } from './trackerCloseFixtures.test-helpers';

/* ------------------------------------------------------------------------- *
 * THE OVERVIEW: ONE LINE PER CLIENT, WORST FIRST, THE TABLE BEHIND A CLICK.
 * ------------------------------------------------------------------------- */

const NOW = Date.parse('2026-10-07T20:40:00.000Z');
const northwind = { ...CLIENT, dailyImports: [dailyImport()] };
const maple = { id: 'c-maple', name: 'Maple Ridge', dailyImports: [dailyImport({ id: 'di-m', uuid: 'imp-m', clientId: 'c-maple', snapshots: [snapshot('snap-m', 'MR 01', 10)] })] };
const quiet = { id: 'c-quiet', uuid: 'q-uuid', name: 'Quiet Pond', dailyImports: [] };
const mapleReading = reading({ id: 9, clientId: 'c-maple', dailyImportId: 'imp-m', accountName: 'MR 01', realizedPnl: 10, unrealizedPnl: 1, totalPnl: 11 });
const BOOK = [quiet, maple, northwind];
const BOOK_ANSWER = { available: true, readings: [...READINGS, mapleReading], settings: SETTINGS };

function show({ clients = BOOK, answer = BOOK_ANSWER, error = null, props = {} } = {}) {
  const view = buildTrackerCloseOverview({ clients, today: DATE, answer, error });
  const onSelectClient = vi.fn();
  const onAddFlag = vi.fn();
  const onNeedClose = vi.fn();
  const read = { clock: NOW, error, reading: false, retry: vi.fn() };
  const utils = render(
    <TrackerCloseOverview view={view} read={read} refreshMs={0} onSelectClient={onSelectClient} onAddFlag={onAddFlag} onNeedClose={onNeedClose} {...props} />,
  );
  return { ...utils, view, onSelectClient, onAddFlag, onNeedClose, read };
}

const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const linesOf = (container) => [...container.querySelectorAll('.tracker-close-line')];

afterEach(() => { cleanup(); });

describe('the lines', () => {
  it('one per client, worst first, each saying the client and the counts in words', () => {
    const { container } = show();
    const lines = linesOf(container);
    expect(lines.map((line) => line.dataset.clientId)).toEqual([CLIENT.id, 'c-maple', 'c-quiet']);
    expect(lines.map((line) => text(line.querySelector('.tracker-close-line-toggle, .tracker-close-line-still')))).toEqual([
      'Northwind: 1 differs, 1 tracker only, 1 close only, 1 matches, 1 algorithm moved',
      'Maple Ridge: 1 matches',
      'Quiet Pond: No close yet today.',
    ]);
    expect(lines[0].className).toContain('attention');
    expect(lines[1].className).not.toContain('attention');
    expect(lines[2].className).toContain('state-no_close');
    expect(text(container.querySelector('.tracker-close-overview-summary'))).toBe('1 of 3 clients asks for a look.');
    expect(container.querySelector('.live-refresh')).not.toBeNull();
  });

  it('opens the same table under the line, one client at a time, and hands Add flag the client and the close', () => {
    const { container, onAddFlag } = show();
    const [northwindLine, mapleLine, quietLine] = linesOf(container);
    const toggle = northwindLine.querySelector('.tracker-close-line-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tracker-close-table')).toBeNull();
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const table = northwindLine.querySelector('.tracker-close-table');
    expect(table).not.toBeNull();
    expect([...table.querySelectorAll('tr.tracker-close-row')].map((row) => row.dataset.account)).toEqual(['ACC 01', 'ACC 03', 'ACC 04', 'ACC 02']);
    act(() => { table.querySelector('.tracker-close-flag').click(); });
    act(() => { table.querySelector('.tracker-close-flag-confirm-yes').click(); });
    expect(onAddFlag).toHaveBeenCalledWith(CLIENT.id, 'di-1', expect.objectContaining({ message: 'Tracker and close differ on ACC 01 by $140' }));
    act(() => { mapleLine.querySelector('.tracker-close-line-toggle').click(); });
    expect(northwindLine.querySelector('.tracker-close-table')).toBeNull();
    expect(mapleLine.querySelector('.tracker-close-table')).not.toBeNull();
    // A line with nothing to open is not a button.
    expect(quietLine.querySelector('.tracker-close-line-toggle')).toBeNull();
  });

  it('folds a book with no close yet into one sentence instead of a list of the same line', () => {
    const { container } = show({ clients: [quiet, { id: 'c-2', name: 'Second', dailyImports: [] }], answer: { available: true, readings: [], settings: SETTINGS } });
    expect(container.querySelector('.tracker-close-line')).toBeNull();
    expect(text(container.querySelector('.tracker-close-empty'))).toBe('No close yet today for any of the 2 clients. The comparison starts with the first close captured today.');
  });

  it('opens the client from its line', () => {
    const { container, onSelectClient } = show();
    act(() => { linesOf(container)[0].querySelector('.tracker-close-line-open').click(); });
    expect(onSelectClient).toHaveBeenCalledWith(CLIENT.id);
  });

  it('asks for the rows of a close this session has not loaded, once per set, whatever the identity of the callback', () => {
    const unloaded = { ...northwind, dailyImports: [dailyImport({ snapshotsLoaded: false })] };
    const { container, onNeedClose, rerender, view } = show({ clients: [unloaded] });
    expect(text(linesOf(container)[0])).toContain('Reading the close.');
    expect(onNeedClose).toHaveBeenCalledTimes(1);
    expect(onNeedClose).toHaveBeenCalledWith(['imp-1']);
    rerender(<TrackerCloseOverview view={view} read={{ clock: NOW, error: null, reading: false, retry: vi.fn() }} refreshMs={0} onNeedClose={onNeedClose} />);
    expect(onNeedClose).toHaveBeenCalledTimes(1);
    // App.jsx hands a new arrow function every render: the same set of closes
    // is still asked for once in all, not once per render.
    const fresh = vi.fn();
    rerender(<TrackerCloseOverview view={view} read={{ clock: NOW, error: null, reading: false, retry: vi.fn() }} refreshMs={0} onNeedClose={fresh} />);
    expect(fresh).not.toHaveBeenCalled();
    expect(onNeedClose).toHaveBeenCalledTimes(1);
  });

  it('ranks a client whose worst is tracker only or stale above one that matches, and the one that differs first of all', () => {
    const cedar = { id: 'c-cedar', name: 'Cedar Hill', dailyImports: [dailyImport({ id: 'di-c', uuid: 'imp-c', clientId: 'c-cedar', snapshots: [snapshot('snap-c1', 'CH 01', 10)] })] };
    const birch = { id: 'c-birch', name: 'Birch Lane', dailyImports: [dailyImport({ id: 'di-b', uuid: 'imp-b', clientId: 'c-birch', snapshots: [snapshot('snap-b1', 'BL 01', 80)] })] };
    const readings = [
      ...BOOK_ANSWER.readings,
      reading({ id: 21, clientId: 'c-cedar', dailyImportId: 'imp-c', accountName: 'CH 01', realizedPnl: 10, unrealizedPnl: 0, totalPnl: 10 }),
      reading({ id: 22, clientId: 'c-cedar', dailyImportId: 'imp-c', accountName: 'CH 02', realizedPnl: 25, unrealizedPnl: 0, totalPnl: 25 }),
      reading({ id: 23, clientId: 'c-birch', dailyImportId: 'imp-b', accountName: 'BL 01', realizedPnl: 80, unrealizedPnl: 0, totalPnl: 80, sampledAt: '2026-10-07T19:00:00.000Z', readingSince: '2026-10-07T18:50:00.000Z' }),
    ];
    const { container } = show({ clients: [quiet, maple, birch, cedar, northwind], answer: { ...BOOK_ANSWER, readings } });
    const lines = linesOf(container);
    expect(lines.map((line) => text(line.querySelector('.tracker-close-line-toggle, .tracker-close-line-still')))).toEqual([
      'Northwind: 1 differs, 1 tracker only, 1 close only, 1 matches, 1 algorithm moved',
      'Cedar Hill: 1 tracker only, 1 matches',
      'Birch Lane: 1 stale',
      'Maple Ridge: 1 matches',
      'Quiet Pond: No close yet today.',
    ]);
    expect(lines.slice(0, 3).every((line) => line.className.includes('attention'))).toBe(true);
    expect(lines[3].className).not.toContain('attention');
    expect(text(container.querySelector('.tracker-close-overview-summary'))).toBe('3 of 5 clients ask for a look.');
  });

  it('names a close pinned after this session loaded, and the one with no reading pinned', () => {
    const late = { id: 'act-late', uuid: 'late-uuid', name: 'Late Close', dailyImports: [] };
    const lateReading = reading({ id: 11, clientId: 'late-uuid', dailyImportId: 'imp-late', accountName: 'LC 01' });
    const { container } = show({ clients: [late, northwind], answer: { available: true, readings: [lateReading], settings: SETTINGS } });
    const [lateLine, northwindLine] = linesOf(container);
    expect(text(lateLine)).toMatch(/Late Close: Close compared at \d\d:\d\d, after this session loaded\. Reload to see it\./);
    expect(text(northwindLine)).toContain('Northwind: The tracker had no reading before this close.');
  });

  it('lists the five line states in rank: differs, matches, pinned after login, still loading, no close', () => {
    const late = { id: 'act-late', uuid: 'late-uuid', name: 'Late Close', dailyImports: [] };
    const lateReading = reading({ id: 11, clientId: 'late-uuid', dailyImportId: 'imp-late', accountName: 'LC 01' });
    const still = { id: 'c-still', uuid: 'still-uuid', name: 'Still Loading', dailyImports: [dailyImport({ id: 'di-s', uuid: 'imp-s', clientId: 'c-still', snapshotsLoaded: false, snapshots: [] })] };
    const { container, onNeedClose } = show({
      clients: [quiet, still, late, maple, northwind],
      answer: { ...BOOK_ANSWER, readings: [...BOOK_ANSWER.readings, lateReading] },
    });
    const lines = linesOf(container);
    expect(lines.map((line) => line.dataset.clientId)).toEqual([CLIENT.id, 'c-maple', 'act-late', 'c-still', 'c-quiet']);
    expect(lines.map((line) => text(line.querySelector('.tracker-close-line-name')))).toEqual(['Northwind', 'Maple Ridge', 'Late Close', 'Still Loading', 'Quiet Pond']);
    expect(lines.map((line) => [...line.classList].find((name) => name.startsWith('state-')))).toEqual([
      'state-ready', 'state-ready', 'state-close_after_login', 'state-reading_close', 'state-no_close',
    ]);
    expect(text(lines[3].querySelector('.tracker-close-line-words'))).toBe('Reading the close.');
    expect(onNeedClose).toHaveBeenCalledWith(['imp-s']);
    expect(text(container.querySelector('.tracker-close-overview-summary'))).toBe('1 of 5 clients asks for a look.');
  });
});

describe('the empty states and the styles', () => {
  it('not deployed, no database, reading, failed with a retry, no clients', () => {
    const deployed = show({ answer: { available: false, reason: 'not_deployed' } });
    expect(text(deployed.container)).toContain('Not available on this CRM yet. Migration step 66 has not been run');
    expect(deployed.container.querySelector('.tracker-close-line')).toBeNull();
    deployed.unmount();
    const none = show({ answer: { available: false, reason: 'not_configured' } });
    expect(text(none.container)).toContain('reads the database, and this session has none');
    none.unmount();
    const reading = show({ answer: null });
    expect(reading.container.querySelector('[role="status"]')).not.toBeNull();
    reading.unmount();
    const failed = show({ answer: null, error: 'boom' });
    expect(failed.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(failed.container)).toContain('Could not read the tracker readings.');
    act(() => { failed.container.querySelector('button.ghost-button').click(); });
    expect(failed.read.retry).toHaveBeenCalledTimes(1);
    failed.unmount();
    const empty = show({ clients: [] });
    expect(text(empty.container)).toContain('No client in this book to compare.');
  });

  it('has a rule for every class, no dash as punctuation, nothing red', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const seen = new Set();
    for (const options of [{}, { answer: { available: false, reason: 'not_deployed' } }, { answer: null, error: 'boom' }]) {
      const { container, unmount } = show(options);
      const first = container.querySelector('.tracker-close-line-toggle');
      if (first) act(() => { first.click(); });
      for (const node of container.querySelectorAll('[class]')) {
        for (const name of String(node.getAttribute('class')).split(/\s+/)) if (name.startsWith('tracker-close')) seen.add(name);
      }
      expect(text(container)).not.toMatch(/[\u2013\u2014]| - /);
      unmount();
    }
    expect([...seen]).toEqual(expect.arrayContaining([
      'tracker-close-overview', 'tracker-close-overview-head', 'tracker-close-overview-summary', 'tracker-close-lines', 'tracker-close-line',
      'tracker-close-line-head', 'tracker-close-line-toggle', 'tracker-close-line-name', 'tracker-close-line-words', 'tracker-close-line-open',
      'tracker-close-line-table', 'tracker-close-empty',
    ]));
    for (const name of seen) expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    const source = readFileSync('src/components/TrackerCloseOverview.jsx', 'utf8');
    expect(source).not.toMatch(/['"`][^'"`\n]*[\u2013\u2014][^'"`\n]*['"`]/);
  });
});
