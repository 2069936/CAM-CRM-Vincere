// What the same-day desk panel says, on synthetic fixtures, so CI runs it.
//
// The numbers live in deskConfigOutliers.book.test.js and are dropped on any
// clone without the export. What is here is what the panel can get wrong
// silently: a group it cannot measure rendered as a group with no findings, a
// field the desk is divided on rendered as a deviation, a missing field
// rendered as a blank value, and the waiting state rendered as a clean bill of
// health. None of those fail a count.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DeskConfigOutlierPanel from './DeskConfigOutlierPanel';

const DAY = '2026-09-21';

const params = (values) => {
  const names = Object.keys(values);
  return `${names.map((name) => values[name]).join('/')} (${names.join('/')})`;
};

const BASE = {
  LicenseKey: 'V-8F5D54-C32866C2-3DB348W',
  StopLossTicks: '300',
  ProfitTargetTicks1: '400',
  MyTradeDirection: 'Both',
};

const strategy = (accountName, overrides = {}, extra = {}) => ({
  strategyName: '0 - URGO-4.5',
  strategyFamily: 'URGO',
  strategyVersion: '4.5',
  instrument: 'MNQ SEP26',
  dataSeries: '15 Minute',
  accountName,
  parametersRaw: params({ ...BASE, ...overrides }),
  ...extra,
});

const client = (id, rows, date = DAY) => ({
  id,
  name: id,
  dailyImports: [{ id: `${id}-close`, uuid: `${id}-uuid`, date, strategies: rows }],
});

const desk = (count, overrides = {}, prefix = 'c') => Array.from(
  { length: count },
  (_, index) => client(`${prefix}${index}`, [strategy(`${prefix.toUpperCase()}${index}`, overrides)]),
);

const strip = (markup) => String(markup)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const render = (clients, props = {}) => renderToStaticMarkup(
  <DeskConfigOutlierPanel clients={clients} date={DAY} {...props} />,
);

describe('a group with something to verify', () => {
  const clients = [
    ...desk(9),
    client('odd', [strategy('ODD', { StopLossTicks: '315', ProfitTargetTicks1: '30' })]),
  ];
  const html = render(clients);
  const text = strip(html);

  it('counts the desk before it names anybody', () => {
    expect(text).toContain('On 2026-09-21 , 10 closes put 10 accounts into 1 group');
    expect(text).toContain('1 of them run at least one setting the rest of their group does not');
  });

  it('says different is not wrong, in the panel and not in a comment', () => {
    expect(text).toContain('Different is not wrong');
    expect(text).toContain('a list to verify rather than a fault list');
    expect(text.toLowerCase()).not.toContain('incorrect');
  });

  it('names the account, the desk value and its denominator', () => {
    expect(text).toContain('ODD');
    expect(text).toContain('Stop loss');
    expect(text).toContain('9 of 10');
  });

  it('prints how far a numeric setting sits from the desk', () => {
    expect(text).toContain('+15');
    expect(text).toContain('-370');
    // Scaled as well as absolute: -50 on a 300 stop and -370 on a 400 target
    // are both real and are not the same size of question.
    expect(text).toContain('-93%');
  });

  it('opens the first group with a finding and no other', () => {
    expect((html.match(/<details class="drift-row" open=""/g) || []).length).toBe(1);
  });
});

describe('a group too small to have a consensus', () => {
  const clients = [
    client('a', [strategy('A0')]),
    client('b', [strategy('B0', { StopLossTicks: '250' })]),
  ];
  const text = strip(render(clients));

  it('says so instead of ranking it', () => {
    expect(text).toContain('1 group had fewer than 3 accounts on 2026-09-21');
    expect(text).toContain('There is no desk consensus to be off in a group that size');
  });

  it('lists the group rather than dropping it', () => {
    // "checked and uniform", "too small" and "does not exist" must not render
    // identically.
    expect(text).toContain('URGO · 4.5 · MNQ 2026-09 · 15 Minute');
    expect(text).toContain('2 accounts');
  });

  it('names nobody in it', () => {
    expect(text).not.toContain('B0');
    expect(text).not.toContain('Stop loss');
  });
});

describe('a field the desk itself is divided on', () => {
  const clients = [
    ...desk(11, { MyTradeDirection: 'Long' }, 'l'),
    ...desk(9, { MyTradeDirection: 'Short' }, 's'),
  ];
  const text = strip(render(clients));

  it('states it once on the group', () => {
    expect(text).toContain('The desk does not agree on these');
    expect(text).toContain('MyTradeDirection : Long on 11 , Short on 9');
  });

  it('lists nobody against it', () => {
    expect(text).toContain('Nobody is listed against these, because there is nothing to be off');
    expect(text).toContain('Every account in this group runs the same settings');
  });
});

describe('two settings the desk runs on purpose', () => {
  const clients = [
    ...desk(16, { CloseAllOpenTradeTime: '1/1/2020 4:45:00 PM' }, 'a'),
    ...desk(4, { CloseAllOpenTradeTime: '1/1/2020 4:30:00 PM' }, 'b'),
  ];
  const text = strip(render(clients));

  it('names both readings rather than the minority', () => {
    expect(text).toContain('Two settings in use on purpose');
    expect(text).toContain('Close all open trades : 16:45 on 16 , 16:30 on 4');
  });
});

describe('a field an account does not carry', () => {
  it('reads as a build and not as a blank value', () => {
    // `Break-even offset: (blank) against 5` invites a CAM to go and set a
    // field that does not exist on that account's strategy.
    const clients = [...desk(9, { BreakEvenOffset: '5' }), client('bare', [strategy('BARE')])];
    const text = strip(render(clients));

    expect(text).toContain('not in this build');
    expect(text).toContain('missing');
    expect(text).not.toContain('(blank)');
  });

  it('reads the same way when it is the account that carries an extra one', () => {
    const clients = [...desk(9), client('more', [strategy('MORE', { Martingale: 'True' })])];
    const text = strip(render(clients));

    expect(text).toContain('Martingale');
    expect(text).toContain('the desk carries none');
  });
});

describe('per machine settings', () => {
  it('names what it left out rather than leaving it to be noticed', () => {
    const clients = desk(10).map((entry, index) => ({
      ...entry,
      dailyImports: [{
        ...entry.dailyImports[0],
        strategies: [strategy(`C${index}`, { Account: `APEX-${index}` })],
      }],
    }));
    const text = strip(render(clients));

    expect(text).toContain('Left out of the comparison');
    expect(text).toContain('Account (a different value on every account, so it cannot have a consensus)');
  });

  it('never puts a licence key on screen', () => {
    expect(render([...desk(9), client('x', [strategy('X', { StopLossTicks: '250' })])]))
      .not.toContain('V-8F5D54');
  });
});

describe('one contract, three spellings', () => {
  it('says it compared them together', () => {
    const clients = ['MNQ SEP26', 'MNQ 09-26', 'MNQU6', 'MNQ SEP26'].map((instrument, index) => client(
      `i${index}`,
      [strategy(`I${index}`, {}, { instrument })],
    ));
    const text = strip(render(clients));

    expect(text).toContain('The grid spelled this contract 3 ways');
    expect(text).toContain('They are one contract and are compared together');
  });

  it('says when part of the desk is on another contract month', () => {
    const clients = [
      ...desk(4),
      ...['a', 'b', 'c'].map((suffix) => client(
        `aug-${suffix}`,
        [strategy(`AUG${suffix}`, {}, { instrument: 'MNQ AUG26' })],
      )),
    ];
    const text = strip(render(clients));

    expect(text).toContain('Also running on MNQ 2026-08 (3)');
    expect(text).toContain('Also running on MNQ 2026-09 (4)');
  });
});

describe('nothing to say', () => {
  it('states the finding when every group runs its consensus', () => {
    const text = strip(render(desk(9)));
    expect(text).toContain('Every group with a consensus is running it');
    expect(text).toContain('Nothing on 2026-09-21 sits off the desk');
  });

  it('says there is nothing to compare when no close carries a strategy row', () => {
    expect(strip(render([client('a', [])])))
      .toContain('No close on 2026-09-21 carries a strategy row');
  });

  it('says so when no day is selected', () => {
    expect(strip(render(desk(9), { date: '' })))
      .toContain('No trading day is selected');
  });
});

/* ── Waiting for its own columns ─────────────────────────────────────────────
 *
 * Third reader of `parameters_raw` and `params_parsed`, and the same risk the
 * other two carry: "Every group with a consensus is running it" is a FINDING
 * about the desk, and printing it over rows that never arrived would be this
 * panel telling a manager his configurations are clean because a request had
 * not come back. */

describe('a panel waiting for its own parameters', () => {
  const load = (status, error = '') => ({ status, error });
  const clients = [...desk(9), client('odd', [strategy('ODD', { StopLossTicks: '315' })])];

  it('says what it is waiting for, and states no finding', () => {
    for (const status of ['idle', 'loading']) {
      const html = render(clients, { load: load(status) });
      expect(html).toContain('Reading the settings every account ran on 2026-09-21');
      expect(html).not.toContain('sits off the desk');
      expect(html).not.toContain('to verify');
      expect(html).not.toContain('ODD');
    }
  });

  it('says what failed, and offers to try again', () => {
    const html = render(clients, {
      load: load('error', 'Could not load the settings for this day: the database did not answer.'),
      onRetry: () => {},
    });

    expect(html).toContain('Could not load the settings for this day');
    expect(html).toContain('Try again');
    expect(html).not.toContain('ODD');
  });

  it('states the finding once the rows are in hand', () => {
    expect(render(clients, { load: load('loaded') })).toContain('ODD');
  });

  it('renders as loaded when nobody passes a load state', () => {
    expect(render(clients)).toContain('ODD');
  });
});
