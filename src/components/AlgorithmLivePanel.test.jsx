// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlgorithmLivePanel, { LIVE_STRATEGY_SAMPLE_VERSION } from './AlgorithmLivePanel';
import { reviewNotePrefix } from '../domain/algorithmLiveComparison';

/* WHAT THE CAM READS. Every assertion is on the panel's own DOM: the sentences
 * are what the desk acts on, so the sentences are what is tested. */

const CYCLE = '2026-10-06T14:10:00.000Z';
const NOW = new Date('2026-10-06T14:13:00Z');
const SETTINGS = {
  minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false,
};

const CLIENTS = [
  { id: 'c-ash', name: 'Ash', activityLog: [] },
  { id: 'c-birch', name: 'Birch', activityLog: [] },
];

function sample(overrides = {}) {
  return {
    clientId: 'c-ash',
    accountName: 'ACC-1',
    strategyId: '1',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrumentRoot: 'MNQ',
    instrument: 'MNQ 12-26',
    realizedPnl: -1100,
    unrealizedPnl: -100,
    restartedAt: null,
    sampledAt: '2026-10-06T14:10:02.000Z',
    cycleStart: CYCLE,
    ...overrides,
  };
}

function compared(overrides = {}) {
  return {
    algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared',
    nAccounts: 12, nClients: 8, median: -500, spread: 100, nFlat: 0, ...overrides,
  };
}

function live({ rows = [sample()], cohorts = [compared()], scope = 'rest_of_desk', settings = SETTINGS, desk = {} } = {}) {
  return {
    available: true,
    desk: { available: true, cycleStart: CYCLE, filling: false, scope, cohorts, ...desk },
    rows,
    settings,
  };
}

async function show(props = {}) {
  const load = props.load || vi.fn(async () => live());
  let view;
  await act(async () => {
    view = render(
      <AlgorithmLivePanel
        clients={CLIENTS}
        load={load}
        refreshMs={0}
        now={() => NOW}
        {...props}
      />,
    );
  });
  return { ...view, load };
}

function panelText(container) {
  return container.textContent || '';
}

afterEach(() => cleanup());

describe('the empty states, never zeros', () => {
  it('says the migration has not run', async () => {
    const { container } = await show({ load: async () => ({ available: false, reason: 'not_deployed' }) });
    expect(panelText(container)).toContain('Migration step 57 has not been run, so there is nothing to compare yet.');
  });

  it('says no machine has sent a reading yet, naming the build', async () => {
    const { container } = await show({ load: async () => live({ rows: [], desk: { cycleStart: null } }) });
    expect(LIVE_STRATEGY_SAMPLE_VERSION).toBe('1.2.0');
    expect(panelText(container)).toContain(
      'No machine has sent per strategy readings yet. They start once a VPS runs agent and add-on 1.2.0.');
  });

  it('waits for the first complete cycle', async () => {
    const { container } = await show({ load: async () => live({ desk: { cycleStart: null } }) });
    expect(panelText(container)).toContain('Waiting for the first complete cycle.');
  });

  it('says a failed read failed, offers to retry, and shows no figure', async () => {
    const load = vi.fn(async () => { throw new Error('boom'); });
    const { container } = await show({ load });
    expect(panelText(container)).toContain('Could not read the live comparison.');
    expect(panelText(container)).not.toMatch(/\$/);
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('says the cycle is old when the strategies have been switched off', async () => {
    const { container } = await show({ now: () => new Date('2026-10-06T15:50:00Z') });
    expect(panelText(container)).toMatch(/Last cycle with readings: \d\d:\d\d, 1 h 40 min ago\. Strategies are switched off after the close, so the comparison stops there\./);
  });
});

describe('whose book against whom', () => {
  it('a CAM reads its book against the rest of the desk, and why', async () => {
    const { container } = await show();
    expect(panelText(container)).toMatch(/Your book against the rest of the desk · cycle \d\d:\d\d/);
    expect(panelText(container)).toContain('The desk figure leaves out your own clients, so it is the rest of the desk.');
  });

  it('a manager in a CAM\'s workspace reads that CAM\'s book against the whole desk', async () => {
    const { container } = await show({ isManager: true, camName: 'Quinn', load: async () => live({ scope: 'desk' }) });
    expect(panelText(container)).toMatch(/Quinn's book against the whole desk · cycle \d\d:\d\d/);
    expect(panelText(container)).not.toContain('rest of the desk');
  });
});

describe('the figures', () => {
  it('puts the sample size beside the desk figure and beside the account', async () => {
    const { container } = await show();
    expect(panelText(container)).toContain('Desk median -$500 over 12 accounts from 8 clients.');
    expect(panelText(container)).toContain('desk n 12');
  });

  it('says "differs", with the distance and the spread multiple, and lists it as a question', async () => {
    const { container } = await show();
    expect(panelText(container)).toContain('Differs from the desk by $700, 7 times the usual spread.');
    expect(panelText(container)).toContain('Worth a look');
    expect(panelText(container)).toContain('These are questions about where to look, not faults.');
  });

  it('a thin cohort is not compared, says the floors outside the book, and is not in the list', async () => {
    const { container } = await show({
      load: async () => live({ cohorts: [compared({ status: 'thin', nAccounts: null, nClients: null, median: null, spread: null, nFlat: null })] }),
    });
    expect(panelText(container)).toContain(
      'Not compared: fewer than 5 accounts from 3 clients outside your book ran it in this cycle.');
    expect(panelText(container)).not.toContain('Worth a look');
    expect(panelText(container)).not.toContain('Differs from the desk');
  });

  it('the floors it prints are the settings table\'s, not the defaults', async () => {
    const { container } = await show({
      load: async () => live({
        settings: { ...SETTINGS, minCohortAccounts: 8, minCohortClients: 4 },
        cohorts: [compared({ status: 'thin', nAccounts: null, nClients: null, median: null, spread: null, nFlat: null })],
      }),
    });
    expect(panelText(container)).toContain(
      'Not compared: fewer than 8 accounts from 4 clients outside your book ran it in this cycle.');
    expect(panelText(container)).not.toContain('fewer than 5 accounts');
  });

  it('names the cycle length the settings carry, not a fixed ten minutes', async () => {
    const five = await show({ load: async () => live({ settings: { ...SETTINGS, cycleSeconds: 300 } }) });
    expect(panelText(five.container)).toContain('read on the same 5 minute cycle for everyone');
    expect(panelText(five.container)).not.toContain('ten minute');
    five.unmount();
    const hour = await show({ load: async () => live({ settings: { ...SETTINGS, cycleSeconds: 3600 } }) });
    expect(panelText(hour.container)).toContain('read on the same 60 minute cycle for everyone');
  });

  it('a manager reads the floor as "on the desk"', async () => {
    const { container } = await show({
      isManager: true,
      load: async () => live({ scope: 'desk', cohorts: [compared({ status: 'thin', median: null, nAccounts: null })] }),
    });
    expect(panelText(container)).toContain('fewer than 5 accounts from 3 clients on the desk ran it in this cycle.');
  });

  it('a reading not measured reads "not measured, not zero" and never $0', async () => {
    const { container } = await show({ load: async () => live({ rows: [sample({ realizedPnl: null, unrealizedPnl: null })] }) });
    expect(panelText(container)).toContain('Not measured, not zero.');
    expect(panelText(container)).not.toContain('$0');
  });

  it('a restarted instance says when, and is not compared', async () => {
    const { container } = await show({ load: async () => live({ rows: [sample({ restartedAt: '2026-10-06T13:40:00Z' })] }) });
    expect(panelText(container)).toMatch(/Restarted at \d\d:40, so this counts only since then\. Not compared\./);
    expect(panelText(container)).not.toContain('Worth a look');
  });

  it('keeps the last complete cycle on screen while the next one fills', async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      return call === 1 ? live() : live({ rows: [], cohorts: [], desk: { filling: true, cycleStart: '2026-10-06T14:20:00Z' } });
    });
    const { container } = await show({ load, refreshMs: 50 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(panelText(container)).toContain('Desk median -$500 over 12 accounts from 8 clients.');
    expect(panelText(container)).toMatch(/The \d\d:20 cycle is still coming in, so this shows the last complete one\./);
  });
});

describe('what the basis line owns up to', () => {
  it('says a quick off and on can go unseen, because the agent cannot always tell', async () => {
    const { container } = await show();
    expect(panelText(container)).toContain(
      'A strategy switched off and on between two readings is not always seen as restarted; when it is not, its figure counts only since it came back on.',
    );
  });

  it('says when the floors are the defaults, without a verdict word', async () => {
    const { container } = await show({ load: async () => live({ settings: { ...SETTINGS, fallback: true } }) });
    expect(panelText(container)).toContain('The floors this panel uses are the defaults, because the settings could not be read.');
  });
});

describe('the styles', () => {
  /* #70 shipped this panel with no rule in index.css for any of its classes, so
   * on the desk it read as unstyled text and nothing failed. The classes asserted
   * here are the ones the panel actually rendered, in every state below, so a
   * class added later without a rule fails here too. */
  it('has a rule in index.css for every algorithm-live class it renders', async () => {
    const css = readFileSync('src/index.css', 'utf8');
    const account = sample();
    const noted = [{
      id: 'c-ash',
      name: 'Ash',
      activityLog: [{ id: 'n1', type: 'Review', text: `${reviewNotePrefix(account)} cycle 10:10: looked`, createdAt: '2026-10-02T15:00:00Z' }],
    }];
    const states = [
      { clients: noted, onLogClientActivity: vi.fn(), openNote: true },
      { load: async () => live({ rows: [sample({ realizedPnl: null }), sample({ accountName: 'R', restartedAt: '2026-10-06T13:40:00Z' })] }) },
      { load: async () => ({ available: false, reason: 'not_deployed' }) },
      { load: async () => live({ cohorts: [compared({ median: -1150 })] }) },
    ];
    const seen = new Set();
    for (const { openNote, ...props } of states) {
      const { container, unmount } = await show(props);
      if (openNote) fireEvent.click(screen.getByText('Note what you found'));
      for (const element of container.querySelectorAll('[class]')) {
        for (const name of element.classList) if (name.startsWith('algorithm-live')) seen.add(name);
      }
      unmount();
    }
    expect([...seen]).toEqual(expect.arrayContaining([
      'algorithm-live', 'algorithm-live-head', 'algorithm-live-verify', 'algorithm-live-algorithm',
      'algorithm-live-desk', 'algorithm-live-accounts', 'algorithm-live-account', 'algorithm-live-account-line',
      'algorithm-live-absent', 'algorithm-live-previous', 'algorithm-live-actions', 'algorithm-live-note',
    ]));
    for (const name of seen) {
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
  });

  it('marks the account that differs, and only that one', async () => {
    const differing = await show();
    expect(differing.container.querySelector('.algorithm-live-account.differs')).not.toBeNull();
    differing.unmount();
    const within = await show({ load: async () => live({ cohorts: [compared({ median: -1150 })] }) });
    expect(within.container.querySelector('.algorithm-live-account')).not.toBeNull();
    expect(within.container.querySelector('.algorithm-live-account.differs')).toBeNull();
  });
});

describe('the words', () => {
  it('has no verdict word and no dash used as punctuation, in any state it renders', async () => {
    const states = [
      live(),
      live({ cohorts: [compared({ status: 'thin', median: null, nAccounts: null })] }),
      live({ rows: [sample({ realizedPnl: null }), sample({ accountName: 'OFF', cycleStart: null }), sample({ accountName: 'R', restartedAt: '2026-10-06T13:40:00Z' })] }),
      { available: false, reason: 'not_deployed' },
      live({ rows: [], desk: { cycleStart: null } }),
      live({ settings: { ...SETTINGS, fallback: true } }),
    ];
    for (const state of states) {
      const { container, unmount } = await show({ load: async () => state });
      // NinjaTrader's own strategy name ("0 - OGX-PF-2.4") is data shown as it
      // is, not copy, so it is taken out before the copy rule is checked.
      const text = panelText(container).replaceAll(sample().strategyName, '');
      for (const word of ['wrong', 'worse', 'underperform', 'outlier', 'below', 'bad ']) {
        expect(text.toLowerCase(), word).not.toContain(word);
      }
      expect(text).not.toMatch(/\s[-\u2013\u2014]\s|[\u2013\u2014]/);
      unmount();
    }
  });
});

describe('the feedback loop', () => {
  it('"Note what you found" logs a Review entry with the prefix, and no logDate or logPnl', async () => {
    const onLogClientActivity = vi.fn();
    await show({ onLogClientActivity });
    fireEvent.click(screen.getByText('Note what you found'));
    fireEvent.change(screen.getByLabelText('What you found'), { target: { value: 'sizing is 4 on this one' } });
    await act(async () => { fireEvent.click(screen.getByText('Save note')); });
    expect(onLogClientActivity).toHaveBeenCalledTimes(1);
    const [clientId, entry] = onLogClientActivity.mock.calls[0];
    expect(clientId).toBe('c-ash');
    expect(entry.type).toBe('Review');
    expect(entry.text.startsWith('[algorithm live] OGX_PF MNQ, ACC-1, cycle ')).toBe(true);
    expect(entry.text).toContain('-$1,200 against desk median -$500 (12 accounts, 8 clients).');
    expect(entry.text.endsWith('sizing is 4 on this one')).toBe(true);
    expect(entry).not.toHaveProperty('logDate');
    expect(entry).not.toHaveProperty('logPnl');
  });

  it('a note on an account read outside the cycle carries no desk median', async () => {
    const onLogClientActivity = vi.fn();
    const onAddClientTask = vi.fn();
    await show({
      onLogClientActivity,
      onAddClientTask,
      load: async () => live({ rows: [sample({ cycleStart: null, sampledAt: '2026-10-06T14:14:00.000Z' })] }),
    });
    fireEvent.click(screen.getByText('Note what you found'));
    fireEvent.change(screen.getByLabelText('What you found'), { target: { value: 'late VPS clock' } });
    await act(async () => { fireEvent.click(screen.getByText('Save note')); });
    fireEvent.click(screen.getByText('Add a follow up task'));
    const noteText = onLogClientActivity.mock.calls[0][1].text;
    const taskText = onAddClientTask.mock.calls[0][1].text;
    for (const text of [noteText, taskText]) {
      expect(text.startsWith('[algorithm live] OGX_PF MNQ, ACC-1, read at ')).toBe(true);
      expect(text).toMatch(/outside the \d\d:\d\d cycle: -\$1,200, not compared\./);
      expect(text).not.toContain('desk median');
      expect(text).not.toContain('-$500');
    }
    expect(noteText.endsWith('late VPS clock')).toBe(true);
  });

  it('"Add a follow up task" carries the same prefix', async () => {
    const onAddClientTask = vi.fn();
    await show({ onAddClientTask });
    fireEvent.click(screen.getByText('Add a follow up task'));
    expect(onAddClientTask.mock.calls[0][0]).toBe('c-ash');
    expect(onAddClientTask.mock.calls[0][1].text.startsWith('[algorithm live] OGX_PF MNQ, ACC-1,')).toBe(true);
  });

  it('shows what was found last time, for the same account and algorithm', async () => {
    const account = { algorithm: 'OGX_PF', instrumentRoot: 'MNQ', accountName: 'ACC-1' };
    const clients = [{
      id: 'c-ash',
      name: 'Ash',
      activityLog: [{ id: 'n1', type: 'Review', text: `${reviewNotePrefix(account)} cycle 10:10: sizing was 4, agreed with client`, createdAt: '2026-10-02T15:00:00Z' }],
    }];
    const { container } = await show({ clients });
    expect(panelText(container)).toContain('Last note, 2026-10-02:');
    expect(panelText(container)).toContain('sizing was 4, agreed with client');
  });

  it('"Open client" opens the client', async () => {
    const onSelectClient = vi.fn();
    await show({ onSelectClient });
    fireEvent.click(screen.getByText('Open client'));
    expect(onSelectClient).toHaveBeenCalledWith('c-ash');
  });
});

describe('the settings beside the number', () => {
  it('names a field that differs, with the date of the close it was read from', async () => {
    const strategy = (accountName, posSize) => ({
      accountName,
      strategyName: '0 - OGX-PF-2.4',
      strategyFamily: 'OGX_PF',
      strategyVersion: '2.4',
      instrument: 'MNQ 12-26',
      dataSeries: '1 Minute',
      params: { valuesByName: { PosSize1: posSize, StopLoss: '20' } },
    });
    const close = (id, accountName, posSize) => ({ id: `d-${id}`, date: '2026-10-05', strategies: [strategy(accountName, posSize)] });
    const clients = [
      { id: 'c-ash', name: 'Ash', activityLog: [], dailyImports: [close('a', 'ACC-1', '4')] },
      { id: 'c-b', name: 'B', activityLog: [], dailyImports: [close('b', 'B-1', '2')] },
      { id: 'c-c', name: 'C', activityLog: [], dailyImports: [close('c', 'C-1', '2')] },
      { id: 'c-d', name: 'D', activityLog: [], dailyImports: [close('d', 'D-1', '2')] },
    ];
    const onNeedParameters = vi.fn();
    const { container } = await show({ clients, onNeedParameters });
    expect(onNeedParameters).toHaveBeenCalledWith('algorithm-live', ['d-a', 'd-b', 'd-c', 'd-d']);
    expect(panelText(container)).toContain(
      'Settings on the 2026-10-05 close: PosSize1 differs (this account 4, your book 2, 3 of 4 accounts)');
  });
});
