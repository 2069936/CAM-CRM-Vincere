import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_VERDICT_WORDS,
  OVERVIEW_LINE_STATES,
  PANEL_STATES,
  buildSparkline,
  buildTrackerCloseOverview,
  buildTrackerClosePanel,
  closeSidesOf,
  closeVerdictsOf,
  readingsForClose,
  verdictCountWords,
} from './trackerClosePanel';
import { VERDICTS } from './trackerCloseComparison';
import { VERDICT_TONES, allVerdictsClose } from '../components/trackerCloseFixtures.test-helpers';

/* ------------------------------------------------------------------------- *
 * WHAT THE CLIENT PAGE AND THE OVERVIEW PRINT ABOUT THE TRACKER AND THE CLOSE.
 *
 * Fictional book: one client, Northwind, with four accounts on the 2026-10-07
 * close. ACC 01 differs by $140, ACC 02 matches, ACC 03 was only in the
 * tracker, ACC 04 only in the close. Every assertion is about the words a CAM
 * reads and the rule that a missing side prints nothing, never $0.
 * ------------------------------------------------------------------------- */

const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const CLIENT = { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' };
const CAPTURED = '2026-10-07T20:31:00.000Z';
const DATE = '2026-10-07';
/* An em dash or an en dash anywhere; a spaced hyphen is checked on the source,
 * because '0 - OGX-PF-2.4' is a real NinjaTrader instance name and data. */
const DASH = /[\u2013\u2014]/;

function reading(over = {}) {
  return {
    id: 1,
    dailyImportId: 'imp-1',
    clientId: UUID,
    tradingDate: DATE,
    accountName: 'ACC 01',
    source: 'crm_history',
    connectionName: 'Bluesky',
    connected: true,
    status: 'Connected',
    realizedPnl: 340,
    unrealizedPnl: 0,
    totalPnl: 340,
    strategyCount: 1,
    enabledStrategyCount: 1,
    runState: 'running',
    sampledAt: '2026-10-07T20:30:00.000Z',
    readingSince: '2026-10-07T20:20:00.000Z',
    resetSeen: false,
    nextSampledAt: null,
    strategies: [],
    closeBatchId: 'batch-1',
    closeCapturedAt: CAPTURED,
    closeTimeBasis: 'captured',
    graceSeconds: 120,
    staleSeconds: 1500,
    comparedAt: '2026-10-07T20:31:05.000Z',
    ...over,
  };
}

const READINGS = [
  reading({
    strategies: [{ strategyId: '100', strategyName: '0 - OGX-PF-2.4', algorithm: 'OGX_PF', instrument: 'MNQ 12-26', realizedPnl: 340, unrealizedPnl: 0, restartedAt: null, sampledAt: '2026-10-07T20:30:02.000Z' }],
  }),
  reading({ id: 2, accountName: 'ACC 02', realizedPnl: 120.5, totalPnl: 120.5, connectionName: 'Bluesky' }),
  reading({ id: 3, accountName: 'ACC 03', realizedPnl: -40, totalPnl: -40 }),
  reading({ id: 4, accountName: 'ACC 04', source: 'none', connectionName: null, connected: null, realizedPnl: null, unrealizedPnl: null, totalPnl: null, strategyCount: null, enabledStrategyCount: null, runState: null, sampledAt: null, readingSince: null }),
];

function snapshot(id, accountName, realized, strategies = []) {
  return { id, accountName, connection: 'Bluesky', grossRealizedPnl: realized, unrealizedPnl: 0, strategies };
}

function dailyImport(over = {}) {
  return {
    id: 'di-1',
    uuid: 'imp-1',
    clientId: CLIENT.id,
    date: DATE,
    status: 'Needs review',
    sourceSummary: { pnl_sources: { realized: 3, gross_fallback: 1 } },
    snapshots: [
      snapshot('snap-1', 'ACC 01', 200, [{ id: 'ss-1', strategyName: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26', realized: 200, unrealized: 0, enabled: false, ran: true }]),
      snapshot('snap-2', 'ACC 02', 120.5),
      snapshot('snap-4', 'ACC 04', 55),
    ],
    strategies: [],
    simulation: {},
    flags: [],
    snapshotsLoaded: true,
    detailLoaded: true,
    ...over,
  };
}

const SETTINGS = { toleranceDollars: 5, toleranceRatio: 0.02, staleSeconds: 1500, graceSeconds: 120, fallback: false };
const ANSWER = { available: true, readings: READINGS, settings: SETTINGS };

function history(over = []) {
  const run = (accountName, realizedPnl, firstSampledAt, lastSampledAt) => ({
    clientId: UUID, accountName, realizedPnl, totalPnl: realizedPnl, firstSampledAt, lastSampledAt, samples: 3,
  });
  return {
    available: true,
    rows: [
      run('ACC 01', 100, '2026-10-07T14:00:00.000Z', '2026-10-07T18:00:00.000Z'),
      run('ACC 01', 340, '2026-10-07T18:10:00.000Z', '2026-10-07T20:30:00.000Z'),
      run('ACC 02', 120.5, '2026-10-07T14:00:00.000Z', '2026-10-07T20:30:00.000Z'),
      ...over,
    ],
  };
}

function panel(over = {}) {
  return buildTrackerClosePanel({ client: CLIENT, dailyImport: dailyImport(), date: DATE, answer: ANSWER, history: history(), ...over });
}

describe('the states, each named and never a verdict by accident', () => {
  it('lists its states', () => {
    expect(PANEL_STATES).toEqual(['no_close', 'not_configured', 'not_deployed', 'reading', 'failed', 'reading_close', 'not_pinned', 'ready']);
  });

  it('no close for the date comes before anything the database says', () => {
    expect(panel({ dailyImport: null }).state).toBe('no_close');
    expect(panel({ dailyImport: null, answer: { available: false, reason: 'not_deployed' } }).state).toBe('no_close');
  });

  it('not configured, not deployed, still reading, failed with nothing in hand', () => {
    expect(panel({ answer: { available: false, reason: 'not_configured' } }).state).toBe('not_configured');
    expect(panel({ answer: { available: false, reason: 'not_deployed' } }).state).toBe('not_deployed');
    expect(panel({ answer: null }).state).toBe('reading');
    expect(panel({ answer: null, error: 'boom' }).state).toBe('failed');
    // A failed refresh with an answer in hand keeps the answer and says so.
    const kept = panel({ error: 'boom' });
    expect(kept.state).toBe('ready');
    expect(kept.error).toBe('boom');
  });

  it('a close whose rows are not loaded yet is reading the close, never a verdict', () => {
    const view = panel({ dailyImport: dailyImport({ snapshotsLoaded: false, snapshots: [] }) });
    expect(view.state).toBe('reading_close');
    expect(view.rows).toEqual([]);
  });

  it('a close with no pinned reading says the tracker had no reading, never close_only for every account', () => {
    const view = panel({ answer: { available: true, readings: [], settings: SETTINGS } });
    expect(view.state).toBe('not_pinned');
    expect(view.rows).toEqual([]);
    // Readings pinned for ANOTHER close are not this close's.
    const other = panel({ answer: { available: true, readings: READINGS.map((row) => ({ ...row, dailyImportId: 'imp-9' })), settings: SETTINGS } });
    expect(other.state).toBe('not_pinned');
  });
});

describe('the rows a CAM reads', () => {
  it('sorts attention first, strongest verdict first, then by name, and says each verdict in words', () => {
    const view = panel();
    expect(view.state).toBe('ready');
    expect(view.rows.map((row) => [row.accountName, row.verdict])).toEqual([
      ['ACC 01', 'differs'], ['ACC 03', 'tracker_only'], ['ACC 04', 'close_only'], ['ACC 02', 'matches'],
    ]);
    expect(view.rows.map((row) => row.verdictWord)).toEqual(['Differs', 'Tracker only', 'Close only', 'Matches']);
    expect(CLOSE_VERDICT_WORDS.settled_at_close).toBe('Settled at the close');
    expect(view.rows[0].attention).toBe(true);
    expect(view.rows[3].attention).toBe(false);
  });

  it('prints the delta signed and NOTHING when a side is missing, never $0', () => {
    const [differs, trackerOnly, closeOnly, matches] = panel().rows;
    expect(differs.deltaWords).toBe('+$140');
    expect(matches.deltaWords).toBe('$0');
    expect(trackerOnly.delta).toBeNull();
    expect(trackerOnly.deltaWords).toBeNull();
    expect(closeOnly.delta).toBeNull();
    expect(closeOnly.deltaWords).toBeNull();
  });

  it('prints the tracker side as total, realized and open, with the sample and the hold clocks', () => {
    const [differs, trackerOnly, closeOnly] = panel().rows;
    expect(differs.trackerWords.total).toBe('$340');
    expect(differs.trackerWords.realized).toBe('$340');
    expect(differs.trackerWords.open).toBe('$0');
    expect(differs.trackerWords.sampled).toMatch(/^sampled \d\d:\d\d, held since \d\d:\d\d$/);
    expect(trackerOnly.trackerWords.total).toBe('-$40');
    // No tracker side at all: no figure is invented.
    expect(closeOnly.trackerWords).toBeNull();
  });

  it('prints the close side and keeps it null when the close does not list the account', () => {
    const [differs, trackerOnly, closeOnly] = panel().rows;
    expect(differs.closeWords).toBe('$200');
    expect(closeOnly.closeWords).toBe('$55');
    expect(trackerOnly.closeWords).toBeNull();
  });

  it('counts the strategies seen against the strategies at the close, and names the gap', () => {
    const [differs, trackerOnly, closeOnly, matches] = panel().rows;
    expect(differs.strategiesWords).toBe('1 seen, 1 at close');
    expect(differs.gapWords).toBe('1 moved');
    expect(differs.flags).toEqual(['algo_moved']);
    expect(differs.strategies[0]).toMatchObject({ strategyName: '0 - OGX-PF-2.4', moved: true, trackerWords: '$340', closeWords: '$200', gapWords: '+$140' });
    expect(trackerOnly.strategiesWords).toBe('0 seen, no close side');
    expect(trackerOnly.gapWords).toBe('no close side');
    expect(closeOnly.strategiesWords).toBe('no tracker side, 0 at close');
    expect(closeOnly.gapWords).toBe('no tracker side');
    expect(matches.gapWords).toBe('none');
  });

  it('counts at the close only the strategies that ran there: one the close lists as not run is seen, not counted, and not a gap', () => {
    // The tracker carried URGO 1.3 too; the close lists it with ran: false.
    const close = dailyImport();
    close.snapshots[0].strategies.push({ id: 'ss-2', strategyName: 'URGO 1.3', instrument: 'MES 12-26', realized: 0, unrealized: 0, enabled: false, ran: false });
    const readings = READINGS.map((row) => (row.accountName !== 'ACC 01' ? row : {
      ...row,
      strategies: [...row.strategies, { strategyId: '200', strategyName: 'URGO 1.3', algorithm: 'URGO', instrument: 'MES 12-26', realizedPnl: 0, unrealizedPnl: 0, restartedAt: null, sampledAt: '2026-10-07T20:30:02.000Z' }],
    }));
    const [differs] = panel({ dailyImport: close, answer: { ...ANSWER, readings } }).rows;
    expect(differs.strategiesWords).toBe('2 seen, 1 at close');
    expect(differs.gapWords).toBe('1 moved');
    expect(differs.strategies.find((item) => item.strategyName === 'URGO 1.3')).toMatchObject({ inClose: true, closeRan: false, moved: false, words: 'Did not run at the close.' });
    // A strategy only the close lists, and lists as not run, is no gap either.
    const quiet = dailyImport();
    quiet.snapshots[0].strategies.push({ id: 'ss-3', strategyName: 'URGO 1.3', instrument: 'MES 12-26', realized: 0, unrealized: 0, enabled: false, ran: false });
    const [unchanged] = panel({ dailyImport: quiet }).rows;
    expect(unchanged.strategiesWords).toBe('1 seen, 1 at close');
    expect(unchanged.gapWords).toBe('1 moved');
  });

  it('says the header in clocks and the tolerance in dollars with the ratio rule beside it', () => {
    const view = panel();
    expect(view.header.capturedClock).toMatch(/^\d\d:\d\d$/);
    expect(view.header.comparedClock).toMatch(/^\d\d:\d\d$/);
    expect(view.header.basis).toBe('captured');
    expect(view.header.toleranceWords).toBe('$5');
    expect(view.header.toleranceRule).toBe('Tolerance per account is the larger of $5 and 2% of the close figure.');
    expect(view.header.words).toMatch(/^Close captured \d\d:\d\d, compared \d\d:\d\d, tolerance \$5$/);
    expect(view.pnlSourceSentence).toBe('The close carried a realized figure for 3 of 4 accounts; 1 used the gross figure instead.');
    expect(view.summary).toMatchObject({ accounts: 4, attention: 3, worst: 'differs' });
  });

  it('says the tolerance is the default, and why, when the settings could not be read', () => {
    // account_tracker_settings refused or empty: the loader hands null.
    const view = panel({ answer: { ...ANSWER, settings: null } });
    expect(view.state).toBe('ready');
    expect(view.header.fallback).toBe(true);
    expect(view.header.words).toMatch(/^Close captured \d\d:\d\d, compared \d\d:\d\d, tolerance \$5 \(default\)$/);
    expect(view.header.toleranceRule).toBe(
      'Tolerance per account is the larger of $5 and 2% of the close figure. The database settings could not be read, so these are the defaults.');
    // Read settings say nothing of the kind.
    const read = panel();
    expect(read.header.fallback).toBe(false);
    expect(read.header.words).not.toContain('default');
    expect(read.header.toleranceRule).not.toContain('could not be read');
  });

  it('takes the tolerance from the settings, not from a constant', () => {
    const view = panel({ answer: { ...ANSWER, settings: { ...SETTINGS, toleranceDollars: 10, toleranceRatio: 0.05 } } });
    expect(view.header.toleranceWords).toBe('$10');
    expect(view.header.toleranceRule).toContain('5%');
  });

  it('draws a sparkline only when the history holds more than one run for the account, and marks the capture', () => {
    const [differs, , , matches] = panel().rows;
    expect(differs.spark).not.toBeNull();
    expect(differs.spark.runs).toBe(2);
    expect(differs.spark.captureX).toBeGreaterThan(0);
    expect(differs.spark.path).toMatch(/^M[\d. ,L]+$/);
    expect(differs.spark.words).toMatch(/^Tracker realized through the day, 2 runs from \d\d:\d\d to \d\d:\d\d, capture marked$/);
    expect(matches.spark).toBeNull();
    expect(panel({ history: null }).rows[0].spark).toBeNull();
    expect(panel({ history: { available: false } }).rows[0].spark).toBeNull();
  });

  it('draws only this client\'s history: another client\'s runs on an account of the same name are not its trail', () => {
    const elsewhere = (realizedPnl, firstSampledAt, lastSampledAt) => ({
      clientId: 'someone-else', accountName: 'ACC 02', realizedPnl, totalPnl: realizedPnl, firstSampledAt, lastSampledAt, samples: 2,
    });
    const view = panel({
      history: history([
        elsewhere(10, '2026-10-07T14:00:00.000Z', '2026-10-07T16:00:00.000Z'),
        elsewhere(90, '2026-10-07T16:10:00.000Z', '2026-10-07T20:30:00.000Z'),
      ]),
    });
    const matches = view.rows.find((row) => row.accountName === 'ACC 02');
    // Northwind's own ACC 02 held one value all day: one run, no line.
    expect(matches.spark).toBeNull();
    expect(view.rows.find((row) => row.accountName === 'ACC 01').spark.runs).toBe(2);
  });

  it('writes the flag draft for every attention row and none for a row that matches', () => {
    const [differs, trackerOnly, closeOnly, matches] = panel().rows;
    expect(differs.flagDraft).toMatchObject({
      type: 'Tracker differs from the close', severity: 'Warning', accountName: 'ACC 01', status: 'Open',
      message: 'Tracker and close differ on ACC 01 by $140',
    });
    expect(trackerOnly.flagDraft.message).toBe('Tracker saw ACC 03 at the close but the close does not list it');
    expect(closeOnly.flagDraft.message).toBe('Close lists ACC 04 but the tracker had no reading before the capture');
    expect(matches.flagDraft).toBeNull();
  });

  it('has no dash as punctuation anywhere in its words, nor in its source', () => {
    const view = panel();
    const words = JSON.stringify([view.header, view.pnlSourceSentence, view.rows.map((row) => [row.sentence, row.notes, row.trackerWords, row.gapWords, row.strategiesWords, row.flagDraft?.message, row.spark?.words, row.strategies.map((item) => item.words)])]);
    expect(words).not.toMatch(DASH);
    for (const file of ['src/domain/trackerClosePanel.js', 'src/domain/trackerCloseFlag.js']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/['"`][^'"`\n]*[\u2013\u2014][^'"`\n]*['"`]/);
      expect(source, file).not.toMatch(/['"`][^'"`\n]* - [^'"`\n]*['"`]/);
    }
  });
});

describe('the chip tone per verdict: a question is amber, agreement green, nothing to compare muted, never red', () => {
  /* Nine accounts on one close, one per verdict (trackerCloseFixtures). The
   * tone is pinned per verdict here so that a chip turned red anywhere in the
   * table fails a test, not a review: the pill badge and the CSS block were
   * already pinned, the chip was not. */
  const all = allVerdictsClose();
  const view = buildTrackerClosePanel({ client: CLIENT, dailyImport: all.dailyImport, date: DATE, answer: all.answer });

  it('reaches every verdict once, attention first, strongest first', () => {
    expect(view.state).toBe('ready');
    expect(view.rows.map((row) => [row.accountName, row.verdict])).toEqual([
      ['ACC 01', 'differs'], ['ACC 05', 'tracker_reset'], ['ACC 03', 'tracker_only'], ['ACC 04', 'close_only'], ['ACC 06', 'stale_reading'],
      ['ACC 07', 'after_close'], ['ACC 08', 'tracker_no_figure'], ['ACC 09', 'settled_at_close'], ['ACC 02', 'matches'],
    ]);
    expect([...view.rows.map((row) => row.verdict)].sort()).toEqual([...VERDICTS].sort());
  });

  it('pins the tone of each verdict', () => {
    expect(Object.fromEntries(view.rows.map((row) => [row.verdict, row.tone]))).toEqual({
      differs: 'warning',
      tracker_reset: 'warning',
      tracker_only: 'warning',
      close_only: 'warning',
      stale_reading: 'warning',
      matches: 'success',
      settled_at_close: 'success',
      after_close: 'muted',
      tracker_no_figure: 'muted',
    });
    expect(VERDICT_TONES).toEqual(Object.fromEntries(view.rows.map((row) => [row.verdict, row.tone])));
  });

  it('never paints a chip red, and every verdict that asks for a look is amber', () => {
    for (const row of view.rows) {
      expect(['warning', 'success', 'muted'], row.verdict).toContain(row.tone);
      expect(row.tone, row.verdict).not.toMatch(/error|danger|red/);
      if (row.attention) expect(row.tone, row.verdict).toBe('warning');
    }
    expect(view.rows.filter((row) => row.tone === 'warning')).toHaveLength(5);
    expect(view.summary).toMatchObject({ accounts: 9, attention: 5, worst: 'differs' });
  });
});

describe('the identity rule and the close side', () => {
  it('matches readings to the client by uuid or by id, and to the close by uuid or by id', () => {
    const byUuid = readingsForClose(READINGS, { client: CLIENT, dailyImport: dailyImport() });
    expect(byUuid).toHaveLength(4);
    const legacyRows = READINGS.map((row) => ({ ...row, clientId: CLIENT.id, dailyImportId: 'di-1' }));
    expect(readingsForClose(legacyRows, { client: CLIENT, dailyImport: dailyImport() })).toHaveLength(4);
    expect(readingsForClose(READINGS, { client: { id: 'someone-else' }, dailyImport: dailyImport() })).toHaveLength(0);
    expect(readingsForClose(READINGS, { client: CLIENT, dailyImport: dailyImport({ uuid: 'imp-2', id: 'di-2' }) })).toHaveLength(0);
  });

  it('feeds the whole close, simulation accounts included, with the strategies flattened under their snapshot', () => {
    const close = dailyImport({
      simulation: { snapshots: [snapshot('snap-sim', 'SIM 01', 10, [{ id: 'ss-sim', strategyName: 'X', instrument: 'MES 12-26', realized: 10, ran: true }])] },
    });
    const sides = closeSidesOf(close);
    expect(sides.accountSnapshots.map((row) => row.accountName)).toEqual(['ACC 01', 'ACC 02', 'ACC 04', 'SIM 01']);
    expect(sides.strategySnapshots).toEqual([
      expect.objectContaining({ accountSnapshotId: 'snap-1', strategyName: '0 - OGX-PF-2.4' }),
      expect.objectContaining({ accountSnapshotId: 'snap-sim', strategyName: 'X' }),
    ]);
  });

  it('hands the pills only the verdicts that ask for attention, keyed by lower case account name', () => {
    const verdicts = closeVerdictsOf(panel());
    expect([...verdicts.entries()]).toEqual([['acc 01', 'differs'], ['acc 03', 'tracker_only'], ['acc 04', 'close_only']]);
    expect(closeVerdictsOf(panel({ dailyImport: null })).size).toBe(0);
  });
});

describe('the sparkline geometry', () => {
  it('is null under two runs and otherwise a step path inside the box with the capture inside the box', () => {
    const one = [{ realizedPnl: 5, firstSampledAt: '2026-10-07T14:00:00Z', lastSampledAt: '2026-10-07T15:00:00Z' }];
    expect(buildSparkline(one, { capturedAt: CAPTURED })).toBeNull();
    const two = [...one, { realizedPnl: 25, firstSampledAt: '2026-10-07T15:10:00Z', lastSampledAt: '2026-10-07T20:00:00Z' }];
    const spark = buildSparkline(two, { capturedAt: CAPTURED, width: 100, height: 20 });
    expect(spark.width).toBe(100);
    expect(spark.height).toBe(20);
    expect(spark.captureX).toBe(100);
    expect(spark.path.startsWith('M0,')).toBe(true);
    // A run with no figure is skipped, not drawn as zero.
    const gap = buildSparkline([...two, { realizedPnl: null, firstSampledAt: '2026-10-07T20:05:00Z', lastSampledAt: '2026-10-07T20:20:00Z' }], { capturedAt: CAPTURED });
    expect(gap.runs).toBe(2);
  });
});

describe('the overview, one line per client, worst first', () => {
  const TODAY = DATE;
  const other = { id: 'c-maple', name: 'Maple Ridge', dailyImports: [dailyImport({ id: 'di-m', uuid: 'imp-m', clientId: 'c-maple', snapshots: [snapshot('snap-m', 'MR 01', 10)] })] };
  const quiet = { id: 'c-quiet', uuid: 'q-uuid', name: 'Quiet Pond', dailyImports: [] };
  const northwind = { ...CLIENT, dailyImports: [dailyImport()] };
  const mapleReading = reading({ id: 9, clientId: 'c-maple', dailyImportId: 'imp-m', accountName: 'MR 01', realizedPnl: 10, totalPnl: 10 });

  it('lists its line states', () => {
    expect(OVERVIEW_LINE_STATES).toEqual(['ready', 'close_after_login', 'not_pinned', 'reading_close', 'no_close']);
  });

  it('says the counts in words, worst client first, and the quiet ones after', () => {
    const view = buildTrackerCloseOverview({
      clients: [quiet, other, northwind],
      today: TODAY,
      answer: { available: true, readings: [...READINGS, mapleReading], settings: SETTINGS },
    });
    expect(view.state).toBe('ready');
    expect(view.lines.map((line) => [line.clientName, line.state])).toEqual([
      ['Northwind', 'ready'], ['Maple Ridge', 'ready'], ['Quiet Pond', 'no_close'],
    ]);
    expect(view.lines[0].words).toBe('1 differs, 1 tracker only, 1 close only, 1 matches, 1 algorithm moved');
    expect(view.lines[1].words).toBe('1 matches');
    expect(view.lines[2].words).toBe('No close yet today.');
    expect(view.lines[0].panel.rows).toHaveLength(4);
    expect(view.attentionClients).toBe(1);
  });

  it('ranks a client whose worst is tracker only or stale above one that matches, with the one that differs first of all', () => {
    /* A real book: one client differs, one has an account only the tracker saw,
     * one has a stale reading, one matches, one has no close yet. A line that
     * matches must never sort above a line that asks for a look, whatever the
     * verdict that asks. */
    const cedar = { id: 'c-cedar', name: 'Cedar Hill', dailyImports: [dailyImport({ id: 'di-c', uuid: 'imp-c', clientId: 'c-cedar', snapshots: [snapshot('snap-c1', 'CH 01', 10)] })] };
    const birch = { id: 'c-birch', name: 'Birch Lane', dailyImports: [dailyImport({ id: 'di-b', uuid: 'imp-b', clientId: 'c-birch', snapshots: [snapshot('snap-b1', 'BL 01', 80)] })] };
    const readings = [
      ...READINGS,
      mapleReading,
      reading({ id: 21, clientId: 'c-cedar', dailyImportId: 'imp-c', accountName: 'CH 01', realizedPnl: 10, totalPnl: 10 }),
      reading({ id: 22, clientId: 'c-cedar', dailyImportId: 'imp-c', accountName: 'CH 02', realizedPnl: 25, totalPnl: 25 }),
      reading({ id: 23, clientId: 'c-birch', dailyImportId: 'imp-b', accountName: 'BL 01', realizedPnl: 80, totalPnl: 80, sampledAt: '2026-10-07T19:00:00.000Z', readingSince: '2026-10-07T18:50:00.000Z' }),
    ];
    const view = buildTrackerCloseOverview({
      clients: [quiet, other, birch, cedar, northwind],
      today: TODAY,
      answer: { available: true, readings, settings: SETTINGS },
    });
    expect(view.lines.map((line) => [line.clientName, line.state, line.summary?.worst ?? null])).toEqual([
      ['Northwind', 'ready', 'differs'],
      ['Cedar Hill', 'ready', 'tracker_only'],
      ['Birch Lane', 'ready', 'stale_reading'],
      ['Maple Ridge', 'ready', 'matches'],
      ['Quiet Pond', 'no_close', null],
    ]);
    expect(view.lines[1].words).toBe('1 tracker only, 1 matches');
    expect(view.lines[2].words).toBe('1 stale');
    expect(view.attentionClients).toBe(3);
    // The one that differs first of all, even when it is the only one with that verdict and the others ask for a look too.
    expect(view.lines.findIndex((line) => line.clientName === 'Northwind')).toBe(0);
  });

  it('says the verdict counts in rank order with the flags after them', () => {
    expect(verdictCountWords({ byVerdict: { differs: 2, tracker_only: 1, matches: 5 }, byFlag: { algo_moved: 1 } })).toBe('2 differ, 1 tracker only, 5 match, 1 algorithm moved');
    expect(verdictCountWords({ byVerdict: { settled_at_close: 1, matches: 1, tracker_reset: 1 }, byFlag: {} })).toBe('1 tracker reset, 1 settled at the close, 1 matches');
  });

  it('promotes the briefing: a client whose close is pinned today but not in this session is named, and its key is in the set', () => {
    const late = { id: 'act-late', uuid: 'late-uuid', name: 'Late Close', dailyImports: [] };
    const lateReading = reading({ id: 11, clientId: 'late-uuid', dailyImportId: 'imp-late', accountName: 'LC 01' });
    const view = buildTrackerCloseOverview({ clients: [late, northwind], today: TODAY, answer: { available: true, readings: [...READINGS, lateReading], settings: SETTINGS } });
    const line = view.lines.find((entry) => entry.clientName === 'Late Close');
    expect(line.state).toBe('close_after_login');
    expect(line.words).toMatch(/^Close compared at \d\d:\d\d, after this session loaded\. Reload to see it\.$/);
    expect([...view.pinnedClientKeys].sort()).toEqual([UUID, 'late-uuid'].sort());
    // A reading pinned for another day promotes nothing today.
    const stale = buildTrackerCloseOverview({ clients: [late], today: '2026-10-08', answer: { available: true, readings: [lateReading], settings: SETTINGS } });
    expect(stale.pinnedClientKeys.size).toBe(0);
    expect(stale.lines[0].state).toBe('no_close');
  });

  it('ranks a close pinned after this session loaded under every line that compared, and above a close still loading and a client with no close', () => {
    /* Five clients, one per line state: Northwind differs, Maple Ridge matches,
     * Late Close was pinned today with no import in the session, Still Loading
     * has today's import with its rows not loaded yet, Quiet Pond has nothing.
     * The lines that compared come first, agreement after the question; then
     * the one asking for a reload, then the one still reading, then no close. */
    const late = { id: 'act-late', uuid: 'late-uuid', name: 'Late Close', dailyImports: [] };
    const lateReading = reading({ id: 11, clientId: 'late-uuid', dailyImportId: 'imp-late', accountName: 'LC 01' });
    const still = { id: 'c-still', uuid: 'still-uuid', name: 'Still Loading', dailyImports: [dailyImport({ id: 'di-s', uuid: 'imp-s', clientId: 'c-still', snapshotsLoaded: false, snapshots: [] })] };
    const view = buildTrackerCloseOverview({
      clients: [quiet, still, late, other, northwind],
      today: TODAY,
      answer: { available: true, readings: [...READINGS, mapleReading, lateReading], settings: SETTINGS },
    });
    expect(view.state).toBe('ready');
    expect(view.lines.map((line) => [line.clientName, line.state])).toEqual([
      ['Northwind', 'ready'],
      ['Maple Ridge', 'ready'],
      ['Late Close', 'close_after_login'],
      ['Still Loading', 'reading_close'],
      ['Quiet Pond', 'no_close'],
    ]);
    expect(view.attentionClients).toBe(1);
    expect(view.unloadedImportIds).toEqual(['imp-s']);
    expect([...view.pinnedClientKeys].sort()).toEqual([UUID, 'c-maple', 'late-uuid'].sort());
  });

  it('a close in the session with no pinned reading, and a close whose rows are still loading', () => {
    const unpinned = buildTrackerCloseOverview({ clients: [northwind], today: TODAY, answer: { available: true, readings: [], settings: SETTINGS } });
    expect(unpinned.lines[0].state).toBe('not_pinned');
    expect(unpinned.lines[0].words).toBe('The tracker had no reading before this close.');
    const loading = buildTrackerCloseOverview({
      clients: [{ ...northwind, dailyImports: [dailyImport({ snapshotsLoaded: false })] }], today: TODAY, answer: ANSWER,
    });
    expect(loading.lines[0].state).toBe('reading_close');
    expect(loading.unloadedImportIds).toEqual(['imp-1']);
  });

  it('hands the tiles the attention verdicts by client key, and nothing for a client that matches', () => {
    const view = buildTrackerCloseOverview({ clients: [other, northwind], today: TODAY, answer: { available: true, readings: [...READINGS, mapleReading], settings: SETTINGS } });
    expect(view.verdictsByClient.get(UUID).get('acc 01')).toBe('differs');
    expect(view.verdictsByClient.get(CLIENT.id)).toBe(view.verdictsByClient.get(UUID));
    expect(view.verdictsByClient.has('c-maple')).toBe(false);
  });

  it('names the empty states of the whole panel', () => {
    expect(buildTrackerCloseOverview({ clients: [northwind], today: TODAY, answer: null }).state).toBe('reading');
    expect(buildTrackerCloseOverview({ clients: [northwind], today: TODAY, answer: null, error: 'boom' }).state).toBe('failed');
    expect(buildTrackerCloseOverview({ clients: [northwind], today: TODAY, answer: { available: false, reason: 'not_deployed' } }).state).toBe('not_deployed');
    expect(buildTrackerCloseOverview({ clients: [northwind], today: TODAY, answer: { available: false, reason: 'not_configured' } }).state).toBe('not_configured');
    expect(buildTrackerCloseOverview({ clients: [], today: TODAY, answer: ANSWER }).state).toBe('no_clients');
  });
});
