// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* The card reads the pinned rows through the store; the store is stood in for
 * here so a mounted card can reach a ready panel without a database. The rest
 * of the module is the real one. */
const mocks = vi.hoisted(() => ({
  loadSupabaseTrackerCloseReadings: vi.fn(),
  loadSupabaseAccountLiveSampleHistory: vi.fn(),
}));

vi.mock('../domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseTrackerCloseReadings: mocks.loadSupabaseTrackerCloseReadings,
  loadSupabaseAccountLiveSampleHistory: mocks.loadSupabaseAccountLiveSampleHistory,
}));

import TrackerCloseComparisonPanel from './TrackerCloseComparisonPanel';
import AutoCollectionCard from './AutoCollectionCard';
import { buildTrackerClosePanel } from '../domain/trackerClosePanel';
import { ANSWER, CLIENT, DATE, SETTINGS, VERDICT_TONES, allVerdictsClose, dailyImport, history, noTrackerClient } from './trackerCloseFixtures.test-helpers';

/* ------------------------------------------------------------------------- *
 * THE TRACKER AGAINST THE CLOSE, ON THE CLIENT PAGE, AS A CAM READS IT.
 *
 * Pedro's ask: compare what the tracker said during the day with the end of day
 * result and see what changed. One row per account with both sides, the delta,
 * the strategies, the gap and the verdict in words; the row opens to the
 * algorithms; "Add flag" puts the row into the queue after an inline yes.
 * Every assertion is on the rendered DOM.
 * ------------------------------------------------------------------------- */

const NOW = Date.parse('2026-10-07T20:40:00.000Z');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function viewOf(over = {}) {
  return buildTrackerClosePanel({ client: CLIENT, dailyImport: dailyImport(), date: DATE, answer: ANSWER, history: history(), ...over });
}

function show(over = {}, props = {}) {
  const onAddFlag = props.onAddFlag === undefined ? vi.fn() : props.onAddFlag;
  const read = { clock: NOW, error: over.error || null, reading: false, retry: vi.fn(), ...(props.read || {}) };
  const utils = render(
    <TrackerCloseComparisonPanel
      view={viewOf(over)}
      read={read}
      clientId={CLIENT.id}
      importId="di-1"
      refreshMs={0}
      {...props}
      onAddFlag={onAddFlag}
    />,
  );
  return { ...utils, onAddFlag, read };
}

const rowsOf = (container) => [...container.querySelectorAll('tr.tracker-close-row')];
const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const cells = (row) => [...row.querySelectorAll('td')].map(text);

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the rows', () => {
  it('one row per account, attention first, each with both sides, the delta, the strategies, the gap and the verdict word', () => {
    const { container } = show();
    const rows = rowsOf(container);
    expect(rows.map((row) => row.dataset.account)).toEqual(['ACC 01', 'ACC 03', 'ACC 04', 'ACC 02']);
    expect(rows.map((row) => row.dataset.verdict)).toEqual(['differs', 'tracker_only', 'close_only', 'matches']);
    expect(rows.map((row) => text(row.querySelector('.tracker-close-verdict')))).toEqual(['Differs', 'Tracker only', 'Close only', 'Matches']);
    expect(rows[0].className).toContain('attention');
    expect(rows[3].className).not.toContain('attention');
    const [account, tracker, close, delta, strategies, gap, verdict] = cells(rows[0]);
    expect(account).toContain('ACC 01');
    expect(account).toContain('Bluesky');
    expect(tracker).toContain('$353');
    expect(tracker).toContain('realized $340');
    expect(tracker).toContain('open $13');
    expect(tracker).toMatch(/sampled \d\d:\d\d, held since \d\d:\d\d/);
    expect(close).toBe('$200');
    expect(delta).toBe('+$140');
    expect(strategies).toBe('1 seen, 1 at close');
    expect(gap).toBe('1 moved');
    expect(verdict).toContain('Differs');
    expect(verdict).toContain('differs from the close $200.00 by $140.00');
    expect(verdict).toContain('OGX-PF-2.4 on MNQ 12-26 moved');
    const headers = [...container.querySelectorAll('th')].map(text);
    expect(headers.slice(0, 7)).toEqual(['Account', 'Tracker at close', 'Close daily P&L', 'Delta', 'Strategies', 'Gap', 'Verdict']);
  });

  it('prints NOTHING in the delta cell when a side is missing, and $0 nowhere', () => {
    const { container } = show();
    const [, trackerOnly, closeOnly] = rowsOf(container);
    expect(cells(trackerOnly)[3]).toBe('');
    expect(cells(closeOnly)[3]).toBe('');
    expect(cells(trackerOnly)[2]).toBe('not in the close');
    expect(cells(closeOnly)[1]).toBe('no tracker reading');
    expect(cells(closeOnly)[2]).toBe('$55');
    expect(container.textContent).not.toContain('$0');
  });

  it('says the header in clocks with the tolerance, the ratio rule one hover away, and the close source sentence once', () => {
    const { container } = show();
    const header = container.querySelector('.tracker-close-header-words');
    expect(text(header)).toMatch(/^Close captured \d\d:\d\d, compared \d\d:\d\d, tolerance \$5$/);
    expect(header.getAttribute('title')).toBe('Tolerance per account is the larger of $5 and 2% of the close figure.');
    expect(text(container.querySelector('.tracker-close-source'))).toBe('The close carried a realized figure for 3 of 4 accounts; 1 used the gross figure instead.');
    expect(container.querySelectorAll('.tracker-close-source').length).toBe(1);
    expect(text(container.querySelector('.tracker-close-summary'))).toBe('3 of 4 accounts ask for a look.');
    expect(container.querySelector('.live-refresh')).not.toBeNull();
  });

  it('says the tolerance is the default when the settings could not be read, and why, one hover away', () => {
    const { container } = show({ answer: { ...ANSWER, settings: null } });
    const header = container.querySelector('.tracker-close-header-words');
    expect(text(header)).toMatch(/^Close captured \d\d:\d\d, compared \d\d:\d\d, tolerance \$5 \(default\)$/);
    expect(header.getAttribute('title')).toBe(
      'Tolerance per account is the larger of $5 and 2% of the close figure. The database settings could not be read, so these are the defaults.');
    expect(text(container.querySelector('.tracker-close-head'))).toMatch(/tolerance \$5 \(default\)\./);
  });

  it('says a client whose VPS does not sample yet has no tracker reading, and lists no account as close only', () => {
    const pine = noTrackerClient({ id: 'c-pine', uuid: 'pine-uuid', name: 'Lone Pine', accounts: ['LP 01', 'LP 02', 'LP 03'] });
    const view = buildTrackerClosePanel({ client: pine.client, dailyImport: pine.client.dailyImports[0], date: DATE, answer: { available: true, readings: pine.readings, settings: SETTINGS } });
    const { container } = render(<TrackerCloseComparisonPanel view={view} read={{ clock: NOW, error: null, reading: false, retry: vi.fn() }} clientId="c-pine" importId="di-c-pine" refreshMs={0} onAddFlag={vi.fn()} />);
    expect(text(container.querySelector('.tracker-close-no-tracker'))).toBe(
      "This client's VPS does not sample yet, so there is no tracker reading to compare. It needs agent 1.2.0 or newer.");
    expect(text(container.querySelector('.tracker-close-head'))).toContain('No tracker reading for this close.');
    expect(container.querySelector('.tracker-close-table')).toBeNull();
    expect(container.querySelectorAll('.tracker-close-verdict').length).toBe(0);
    expect(text(container)).not.toContain('Close only');
    expect(container.querySelector('.tracker-close-flag')).toBeNull();
  });

  it('names a scheduled capture time, since a manual close has no capture of its own', () => {
    const scheduled = { ...ANSWER, readings: ANSWER.readings.map((row) => ({ ...row, closeTimeBasis: 'scheduled' })) };
    const { container } = show({ answer: scheduled });
    expect(text(container.querySelector('.tracker-close-head'))).toContain('capture time taken from the schedule');
  });

  it('draws the day as a sparkline with the capture marked only where the history holds more than one run', () => {
    const { container } = show();
    const [differs, , , matches] = rowsOf(container);
    const spark = differs.querySelector('svg.tracker-close-spark');
    expect(spark).not.toBeNull();
    expect(spark.getAttribute('aria-label')).toMatch(/^Tracker realized through the day, 2 runs from \d\d:\d\d to \d\d:\d\d, capture marked$/);
    expect(spark.querySelector('path').getAttribute('d')).toMatch(/^M/);
    expect(spark.querySelector('.tracker-close-spark-capture')).not.toBeNull();
    expect(matches.querySelector('svg')).toBeNull();
  });
});

describe('the algorithms behind a click, one row open at a time', () => {
  it('opens both sides per algorithm with the gap and the moved chip, and closes again', () => {
    const { container } = show();
    const [differs, trackerOnly] = rowsOf(container);
    const toggle = differs.querySelector('.tracker-close-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tracker-close-detail')).toBeNull();
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = container.querySelector('.tracker-close-detail');
    expect(toggle.getAttribute('aria-controls')).toBe(detail.id);
    const items = [...detail.querySelectorAll('.tracker-close-strategy')];
    expect(items).toHaveLength(1);
    expect(items[0].className).toContain('moved');
    expect(text(items[0])).toContain('OGX-PF-2.4');
    expect(text(items[0])).toContain('MNQ 12-26');
    expect(text(items[0])).toContain('tracker $340');
    expect(text(items[0])).toContain('close $200');
    expect(text(items[0])).toContain('gap +$140');
    expect(text(items[0].querySelector('.badge.warning.tracker-close-strategy-moved'))).toBe('Moved');
    expect(text(items[0].querySelector('.tracker-close-strategy-words'))).toBe('Moved beyond $5.');
    // A second row opens and the first closes.
    act(() => { trackerOnly.querySelector('.tracker-close-toggle').click(); });
    expect(container.querySelectorAll('.tracker-close-detail').length).toBe(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(text(container.querySelector('.tracker-close-strategies-empty'))).toBe('No strategy reading on either side.');
    act(() => { trackerOnly.querySelector('.tracker-close-toggle').click(); });
    expect(container.querySelector('.tracker-close-detail')).toBeNull();
  });

  it('lists a strategy the close ran that the tracker did not carry', () => {
    const close = dailyImport();
    close.snapshots[0].strategies.push({ id: 'ss-2', strategyName: 'URGO 1.3', instrument: 'MES 12-26', realized: 10, unrealized: 0, enabled: true, ran: true });
    const { container } = show({ dailyImport: close });
    const [differs] = rowsOf(container);
    expect(cells(differs)[5]).toBe('1 moved, 1 only at close');
    act(() => { differs.querySelector('.tracker-close-toggle').click(); });
    const closeOnly = container.querySelector('.tracker-close-strategy.close-only');
    expect(text(closeOnly)).toBe('URGO 1.3 on MES 12-26 ran at the close and the tracker did not carry it.');
  });
});

describe('"Add flag", confirmed inline', () => {
  it('offers the button on attention rows only, asks inline, and hands the queue the exact title', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('no browser dialog'); });
    const { container, onAddFlag } = show();
    const [differs, trackerOnly, closeOnly, matches] = rowsOf(container);
    expect(differs.querySelector('.tracker-close-flag')).not.toBeNull();
    expect(trackerOnly.querySelector('.tracker-close-flag')).not.toBeNull();
    expect(closeOnly.querySelector('.tracker-close-flag')).not.toBeNull();
    expect(matches.querySelector('.tracker-close-flag')).toBeNull();
    expect(text(differs.querySelector('.tracker-close-flag'))).toBe('Add flag');

    act(() => { differs.querySelector('.tracker-close-flag').click(); });
    expect(onAddFlag).not.toHaveBeenCalled();
    const confirm = differs.querySelector('.tracker-close-flag-confirm');
    expect(text(confirm)).toContain('Add "Tracker and close differ on ACC 01 by $140" to the flag queue?');
    act(() => { confirm.querySelector('.tracker-close-flag-confirm-yes').click(); });
    expect(onAddFlag).toHaveBeenCalledTimes(1);
    const [clientId, importId, flag] = onAddFlag.mock.calls[0];
    expect(clientId).toBe(CLIENT.id);
    expect(importId).toBe('di-1');
    expect(flag).toMatchObject({
      type: 'Tracker differs from the close', severity: 'Warning', status: 'Open', accountName: 'ACC 01',
      message: 'Tracker and close differ on ACC 01 by $140',
    });
    expect(flag.id).toMatch(UUID_RE);
    expect(text(differs.querySelector('.tracker-close-flag-added'))).toBe('Flag added');
    expect(differs.querySelector('.tracker-close-flag')).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('takes "Flag added" back when the write is refused, and says it could not, inline', async () => {
    let refuse;
    const onAddFlag = vi.fn(() => new Promise((resolve, reject) => { refuse = () => reject(new Error('insert refused')); }));
    const { container } = show({}, { onAddFlag });
    const [differs] = rowsOf(container);
    act(() => { differs.querySelector('.tracker-close-flag').click(); });
    act(() => { differs.querySelector('.tracker-close-flag-confirm-yes').click(); });
    expect(onAddFlag).toHaveBeenCalledTimes(1);
    // Said at once, while the write is out.
    expect(text(differs.querySelector('.tracker-close-flag-added'))).toBe('Flag added');
    await act(async () => { refuse(); });
    expect(differs.querySelector('.tracker-close-flag-added')).toBeNull();
    expect(text(differs.querySelector('.tracker-close-flag'))).toBe('Add flag');
    const status = differs.querySelector('.tracker-close-actions [role="status"]');
    expect(text(status)).toBe('Could not add the flag.');
    expect(status.className).toContain('tracker-close-flag-failed');
    // Another try clears the sentence, and a write that lands says Flag added for good.
    onAddFlag.mockImplementation(() => Promise.resolve({ id: 'f-1' }));
    act(() => { differs.querySelector('.tracker-close-flag').click(); });
    expect(differs.querySelector('.tracker-close-flag-failed')).toBeNull();
    act(() => { differs.querySelector('.tracker-close-flag-confirm-yes').click(); });
    await act(async () => {});
    expect(text(differs.querySelector('.tracker-close-flag-added'))).toBe('Flag added');
    expect(differs.querySelector('.tracker-close-flag-failed')).toBeNull();
  });

  it('takes "Flag added" back when onAddFlag throws before it returns', () => {
    const onAddFlag = vi.fn(() => { throw new Error('no import'); });
    const { container } = show({}, { onAddFlag });
    const [differs] = rowsOf(container);
    act(() => { differs.querySelector('.tracker-close-flag').click(); });
    act(() => { differs.querySelector('.tracker-close-flag-confirm-yes').click(); });
    expect(differs.querySelector('.tracker-close-flag-added')).toBeNull();
    expect(text(differs.querySelector('.tracker-close-flag-failed'))).toBe('Could not add the flag.');
  });

  it('cancel puts the button back and writes nothing, and the other rows carry their own titles', () => {
    const { container, onAddFlag } = show();
    const [, trackerOnly, closeOnly] = rowsOf(container);
    act(() => { trackerOnly.querySelector('.tracker-close-flag').click(); });
    act(() => { trackerOnly.querySelector('.tracker-close-flag-cancel').click(); });
    expect(onAddFlag).not.toHaveBeenCalled();
    expect(text(trackerOnly.querySelector('.tracker-close-flag'))).toBe('Add flag');
    act(() => { closeOnly.querySelector('.tracker-close-flag').click(); });
    act(() => { closeOnly.querySelector('.tracker-close-flag-confirm-yes').click(); });
    expect(onAddFlag.mock.calls[0][2].message).toBe('Close lists ACC 04 but the tracker had no reading before the capture');
  });

  it('shows no flag column at all when nothing can add a flag', () => {
    const { container } = show({}, { onAddFlag: null });
    expect(container.querySelector('.tracker-close-flag')).toBeNull();
    expect([...container.querySelectorAll('th')].length).toBe(7);
  });
});

describe('the honest empty states', () => {
  it('no close for this date, not available on this CRM, no database, reading, failed with a retry, reading the close, not pinned', () => {
    const noClose = show({ dailyImport: null });
    expect(text(noClose.container)).toContain('No close for this date yet.');
    expect(text(noClose.container)).toContain('No close for 2026-10-07 yet.');
    expect(noClose.container.querySelector('table')).toBeNull();
    noClose.unmount();

    const notDeployed = show({ answer: { available: false, reason: 'not_deployed' } });
    expect(text(notDeployed.container)).toContain('Not available on this CRM yet.');
    expect(text(notDeployed.container)).toContain('Migration step 66 has not been run');
    notDeployed.unmount();

    const notConfigured = show({ answer: { available: false, reason: 'not_configured' } });
    expect(text(notConfigured.container)).toContain('reads the database, and this session has none');
    notConfigured.unmount();

    const reading = show({ answer: null });
    expect(reading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(text(reading.container)).toContain('Reading the tracker readings pinned at this close.');
    reading.unmount();

    const failed = show({ answer: null, error: 'boom' });
    expect(failed.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(failed.container)).toContain('Could not read the tracker readings for this close.');
    expect(text(failed.container)).not.toMatch(/\$/);
    act(() => { fireEvent.click(failed.container.querySelector('button.ghost-button')); });
    expect(failed.read.retry).toHaveBeenCalledTimes(1);
    failed.unmount();

    const readingClose = show({ dailyImport: dailyImport({ snapshotsLoaded: false, snapshots: [] }) });
    expect(text(readingClose.container)).toContain('Reading the close.');
    expect(readingClose.container.querySelector('table')).toBeNull();
    readingClose.unmount();

    const notPinned = show({ answer: { available: true, readings: [], settings: SETTINGS } });
    expect(text(notPinned.container)).toContain('The tracker had no reading before this close.');
    expect(text(notPinned.container)).toContain('record_tracker_close_readings');
    expect(notPinned.container.querySelector('table')).toBeNull();
    expect(notPinned.container.querySelectorAll('.tracker-close-verdict').length).toBe(0);
  });

  it('a failed refresh keeps the rows and says so under the header', () => {
    const { container } = show({ error: 'boom' });
    expect(rowsOf(container)).toHaveLength(4);
    expect(text(container.querySelector('.tracker-close-failed'))).toBe('Could not refresh the comparison. The rows are the last answer.');
  });
});

describe('the words and the styles', () => {
  it('has no verdict word stronger than differs and no dash as punctuation, in any state, rows open', () => {
    const states = [
      {}, { dailyImport: null }, { answer: { available: false, reason: 'not_deployed' } }, { answer: null },
      { answer: null, error: 'boom' }, { answer: { available: true, readings: [], settings: SETTINGS } },
      { dailyImport: dailyImport({ snapshotsLoaded: false }) },
    ];
    for (const over of states) {
      const { container, unmount } = show(over);
      for (const toggle of container.querySelectorAll('.tracker-close-toggle')) act(() => { toggle.click(); });
      for (const button of container.querySelectorAll('.tracker-close-flag')) act(() => { button.click(); });
      const words = text(container);
      for (const word of ['wrong', 'worse', 'fraud', 'bad ']) expect(words.toLowerCase(), word).not.toContain(word);
      expect(words).not.toMatch(/[\u2013\u2014]| - /);
      for (const node of container.querySelectorAll('[title]')) expect(node.getAttribute('title')).not.toMatch(/[\u2013\u2014]| - /);
      unmount();
    }
    for (const file of ['src/components/TrackerCloseComparisonPanel.jsx', 'src/components/TrackerCloseTable.jsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/['"`][^'"`\n]*[\u2013\u2014][^'"`\n]*['"`]/);
      expect(source, file).not.toMatch(/(title|label)="[^"\n]* - [^"\n]*"/);
    }
  });

  it('paints every verdict chip amber, green or muted, by verdict, and never red', () => {
    /* The badge tone is the one thing the house rule says about a chip: a
     * question is amber, agreement is green, nothing to compare is muted, and
     * nothing is ever red. Over the four account close and over the nine
     * verdict close, every chip is checked against the verdict on its row. */
    const all = allVerdictsClose();
    const chips = [];
    for (const over of [{}, { dailyImport: all.dailyImport, answer: all.answer }]) {
      const { container, unmount } = show(over);
      for (const row of rowsOf(container)) {
        const chip = row.querySelector('.tracker-close-verdict');
        chips.push({ verdict: row.dataset.verdict, className: chip.className, word: text(chip) });
      }
      unmount();
    }
    expect(chips).toHaveLength(13);
    expect(new Set(chips.map((chip) => chip.verdict)).size).toBe(9);
    for (const chip of chips) {
      expect(chip.className, chip.verdict).toMatch(/^badge (warning|success|muted) tracker-close-verdict verdict-[a-z_]+$/);
      expect(chip.className, chip.verdict).not.toMatch(/error|danger|red/);
      expect(chip.className, chip.verdict).toBe(`badge ${VERDICT_TONES[chip.verdict]} tracker-close-verdict verdict-${chip.verdict}`);
    }
    const byVerdict = Object.fromEntries(chips.map((chip) => [chip.verdict, chip.className.split(' ')[1]]));
    expect(byVerdict).toEqual({
      differs: 'warning', tracker_reset: 'warning', tracker_only: 'warning', close_only: 'warning', stale_reading: 'warning',
      matches: 'success', settled_at_close: 'success',
      after_close: 'muted', tracker_no_figure: 'muted',
    });
    expect(chips.map((chip) => chip.word)).toEqual(expect.arrayContaining(['Differs', 'Tracker reset', 'Tracker only', 'Close only', 'Stale reading', 'After the close', 'No tracker figure', 'Settled at the close', 'Matches']));
  });

  it('has a rule in index.css for every tracker-close class it renders, amber and never red', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const seen = new Set();
    // SVG elements carry an SVGAnimatedString, not a string, so the attribute is read.
    const collect = (container) => {
      for (const node of container.querySelectorAll('[class]')) {
        for (const name of String(node.getAttribute('class')).split(/\s+/)) if (name.startsWith('tracker-close')) seen.add(name);
      }
    };
    const unsampled = noTrackerClient({ id: 'c-pine', name: 'Lone Pine' });
    const states = [
      {}, { dailyImport: null }, { answer: { available: false, reason: 'not_deployed' } }, { answer: null, error: 'boom' }, { error: 'boom' },
      { answer: { available: true, readings: [], settings: SETTINGS } },
      { client: unsampled.client, dailyImport: unsampled.client.dailyImports[0], answer: { available: true, readings: unsampled.readings, settings: SETTINGS } },
    ];
    for (const over of states) {
      const { container, unmount } = show(over);
      collect(container);
      // One row open at a time: the first row has algorithms, the second has none.
      for (const toggle of [...container.querySelectorAll('.tracker-close-toggle')].slice(0, 2)) {
        act(() => { toggle.click(); });
        collect(container);
      }
      const flag = container.querySelector('.tracker-close-flag');
      if (flag) act(() => { flag.click(); });
      collect(container);
      const added = container.querySelector('.tracker-close-flag-confirm-yes');
      if (added) act(() => { added.click(); });
      collect(container);
      unmount();
    }
    // A refused write: the cell says so beside the button.
    const refused = show({}, { onAddFlag: vi.fn(() => { throw new Error('refused'); }) });
    act(() => { refused.container.querySelector('.tracker-close-flag').click(); });
    act(() => { refused.container.querySelector('.tracker-close-flag-confirm-yes').click(); });
    collect(refused.container);
    refused.unmount();
    expect([...seen]).toEqual(expect.arrayContaining([
      'tracker-close', 'tracker-close-head', 'tracker-close-header-words', 'tracker-close-source', 'tracker-close-summary',
      'tracker-close-empty', 'tracker-close-failed', 'tracker-close-table-wrap', 'tracker-close-table', 'tracker-close-row',
      'tracker-close-toggle', 'tracker-close-account', 'tracker-close-connection', 'tracker-close-figure', 'tracker-close-figure-label',
      'tracker-close-sampled', 'tracker-close-absent', 'tracker-close-spark', 'tracker-close-spark-capture', 'tracker-close-delta',
      'tracker-close-verdict', 'tracker-close-sentence', 'tracker-close-flag', 'tracker-close-flag-confirm', 'tracker-close-flag-confirm-yes',
      'tracker-close-flag-cancel', 'tracker-close-flag-added', 'tracker-close-flag-failed', 'tracker-close-detail', 'tracker-close-strategies', 'tracker-close-strategy',
      'tracker-close-strategy-instrument', 'tracker-close-strategy-moved', 'tracker-close-strategy-words', 'tracker-close-strategies-empty',
      'tracker-close-no-tracker',
    ]));
    for (const name of seen) {
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
    const block = css.slice(css.indexOf('(TrackerCloseComparisonPanel'), css.indexOf('/* ── ', css.indexOf('(TrackerCloseComparisonPanel') + 1));
    expect(block.length).toBeGreaterThan(200);
    expect(block).toMatch(/\.tracker-close-row\.attention[^}]*var\(--warning\)/);
    expect(block).not.toMatch(/--error|--red|#ff5a69/);
  });
});

describe('the collector card that hosts it', () => {
  const paired = {
    serverTime: '2026-10-07T20:40:00.000Z',
    client: { uuid: CLIENT.uuid, name: CLIENT.name },
    permissions: { generate: true, rebind: true, revoke: true },
    release: { url: 'https://downloads.example.test/agent.msi', version: '1.2.0', sha256: 'a'.repeat(64) },
    device: {
      id: 'device-1', status: 'active', healthStatus: 'online', agentVersion: '1.2.0',
      revokedAt: null, createdAt: '2026-01-04T12:00:00Z', lastSeenAt: '2026-10-07T20:39:30.000Z',
      schedule: { time: '16:30:00', timezone: 'America/New_York' },
    },
    enrollment: null,
    lastBatch: { tradingDate: DATE, status: 'processed', rowCounts: { accounts: 4 } },
    accountTracker: { staleSeconds: 1500, sampleIntervalSeconds: 600, minAgentVersion: '1.2.0', deviceHasSamples: true, accounts: [] },
  };
  function card(props = {}) {
    return renderToStaticMarkup(<AutoCollectionCard
      clientUuid={CLIENT.uuid}
      clientName={CLIENT.name}
      initialStatus={paired}
      disableAutoLoad
      api={{ loadStatus: () => new Promise(() => {}) }}
      {...props}
    />);
  }

  it('renders the comparison under the tracker when it is handed the client and the close, and not otherwise', () => {
    const withClose = card({ client: CLIENT, dailyImport: dailyImport(), selectedDate: DATE });
    expect(withClose).toContain('class="tracker-close"');
    expect(withClose.indexOf('class="account-tracker"')).toBeLessThan(withClose.indexOf('class="tracker-close"'));
    // Nothing has been read on a static render: the state says so, no verdict is invented.
    expect(withClose).toContain('Reading the tracker readings pinned at this close.');
    expect(withClose).not.toContain('tracker-close-verdict');
    const noClose = card({ client: CLIENT, dailyImport: null, selectedDate: '2026-10-08' });
    expect(noClose).toContain('No close for 2026-10-08 yet.');
    expect(card()).not.toContain('tracker-close');
  });

  it('hands the strip the verdicts it read, so the pill of the account whose close differs carries the badge and the one that matches does not', async () => {
    /* Mounted, so the read happens: the four accounts are sampled live and the
     * pinned rows say ACC 01 differs by $140 while ACC 02 matches. One answer,
     * two readers: the table under the strip and the badge on the strip's pill. */
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue(ANSWER);
    mocks.loadSupabaseAccountLiveSampleHistory.mockResolvedValue(null);
    const names = ['ACC 01', 'ACC 02', 'ACC 03', 'ACC 04'];
    const sample = (accountName) => ({
      accountName, connectionName: 'Bluesky', connected: true, status: 'Connected', realizedPnl: 100, unrealizedPnl: 0, totalPnl: 100,
      strategyCount: 1, enabledStrategyCount: 1, runState: 'running', sampledAt: '2026-10-07T20:38:00.000Z',
    });
    const { container } = render(<AutoCollectionCard
      clientUuid={CLIENT.uuid}
      clientName={CLIENT.name}
      initialStatus={{ ...paired, accountTracker: { ...paired.accountTracker, accounts: names.map(sample) } }}
      disableAutoLoad
      api={{ loadStatus: () => new Promise(() => {}) }}
      accountNames={names}
      client={CLIENT}
      dailyImport={dailyImport()}
      selectedDate={DATE}
    />);
    await waitFor(() => expect(container.querySelector('.tracker-close-table')).not.toBeNull());
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledWith({ clientIds: [CLIENT.uuid], importIds: ['imp-1'], tradingDate: null });
    const pills = [...container.querySelectorAll('.account-pills .account-pill')];
    expect(pills.map((pill) => pill.dataset.account)).toEqual(names);
    const differs = pills.find((pill) => pill.dataset.account === 'ACC 01');
    const matches = pills.find((pill) => pill.dataset.account === 'ACC 02');
    expect(differs.querySelector('.account-pill-close-differs')).not.toBeNull();
    expect(text(differs.querySelector('.account-pill-close-differs'))).toBe('Close differs');
    expect(differs.querySelector('.account-pill-close-differs').getAttribute('title')).toBe('Close differs: the realized figures differ.');
    expect(differs.className).toContain('close-differs');
    expect(matches.querySelector('.account-pill-close-differs')).toBeNull();
    expect(matches.className).not.toContain('close-differs');
  });
});
