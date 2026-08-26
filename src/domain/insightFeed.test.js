// The one rule the Insight Feed's layout has: a column whose value is the same
// on every row of a group is not a column.
//
// Synthetic fixtures only, so CI runs every line of it. The numbers this rule
// was derived from — 192 signals, 84 of them one sentence repeated — are in
// src/insightFeed.book.test.js, which needs the book and does not run on a
// clone. The BEHAVIOUR has to be pinned here or it is not pinned at all.

import { describe, expect, it } from 'vitest';
import {
  columnsOf,
  factValue,
  groupInsights,
  sortSignals,
  SEVERITY_RANK,
} from './insightFeed';

function signal(overrides = {}) {
  return {
    severity: 'warning',
    type: 'Drawdown Velocity',
    clientId: 'c1',
    clientName: 'Alice',
    accountAlias: 'ACC1',
    message: 'a sentence',
    action: 'Review stack or reduce position size',
    urgency: 0,
    facts: [{ label: 'Breach in', value: '3 trading days' }],
    ...overrides,
  };
}

describe('hoisting what every row of a group agrees on', () => {
  it('states a shared action once for the group instead of once per row', () => {
    // The measured defect: on the book, 192 rows carried three distinct action
    // sentences between them.
    const { groups } = groupInsights([
      signal({ clientId: 'c1', clientName: 'Alice' }),
      signal({ clientId: 'c2', clientName: 'Bob' }),
      signal({ clientId: 'c3', clientName: 'Cara' }),
    ]);
    expect(groups[0].action).toBe('Review stack or reduce position size');
    expect(groups[0].count).toBe(3);
  });

  it('refuses to hoist an action the rows do not agree on', () => {
    // Payout Opportunity already does this: a ready account says "Request payout
    // now" and a near one says "Monitor until target". Hoisting either would
    // print the wrong instruction over half the group.
    const { groups } = groupInsights([
      signal({ type: 'Payout Opportunity', action: 'Request payout now' }),
      signal({ type: 'Payout Opportunity', action: 'Monitor until target', clientId: 'c2' }),
    ]);
    expect(groups[0].action).toBeNull();
  });

  it('refuses to hoist when one row of the group is missing the field entirely', () => {
    // Five rows agreeing and a sixth saying nothing is not agreement — and it
    // does not matter which row is the silent one. The first is tested too
    // because the comparison reads row zero and then checks the rest against it,
    // so a missing value there is the case that short-circuits.
    expect(groupInsights([
      signal(),
      signal({ clientId: 'c2', action: undefined }),
    ]).groups[0].action).toBeNull();

    expect(groupInsights([
      signal({ action: undefined }),
      signal({ clientId: 'c2' }),
    ]).groups[0].action).toBeNull();
  });

  it('does not hoist an empty value as though the group had agreed on something', () => {
    // Every row carrying '' is not every row carrying an answer. Hoisted, it
    // would print a heading with nothing under it AND take the column away, so
    // the panel would lose the field in both directions at once.
    const blankAction = groupInsights([
      signal({ action: '' }),
      signal({ clientId: 'c2', action: '' }),
    ]).groups[0];
    expect(blankAction.action).toBeNull();

    const blankFact = groupInsights([
      signal({ facts: [{ label: 'Breach in', value: '' }] }),
      signal({ clientId: 'c2', facts: [{ label: 'Breach in', value: '' }] }),
    ]).groups[0];
    expect(blankFact.constants).toEqual([]);
    expect(blankFact.columns).toEqual(['Breach in']);
  });

  it('hoists severity for a single-severity group and keeps it on a mixed one', () => {
    // Missing Close is 84 warnings and nothing else on the book, so the word
    // "Warning" belongs in the heading. Drawdown Velocity is 21 critical and 22
    // warning, and there the difference is the whole point of the column.
    const uniform = groupInsights([
      signal({ type: 'Missing Close' }),
      signal({ type: 'Missing Close', clientId: 'c2' }),
    ]);
    expect(uniform.groups[0].severity).toBe('warning');

    const mixed = groupInsights([
      signal({ severity: 'critical' }),
      signal({ severity: 'warning', clientId: 'c2' }),
    ]);
    expect(mixed.groups[0].severity).toBeNull();
  });

  it('hoists a fact every row shares and keeps the ones that differ', () => {
    const { groups } = groupInsights([
      signal({
        facts: [
          { label: 'Instrument', value: 'MNQ SEP26' },
          { label: 'Breach in', value: '1 trading day' },
        ],
      }),
      signal({
        clientId: 'c2',
        facts: [
          { label: 'Instrument', value: 'MNQ SEP26' },
          { label: 'Breach in', value: '4 trading days' },
        ],
      }),
    ]);
    expect(groups[0].constants).toEqual([{ label: 'Instrument', value: 'MNQ SEP26' }]);
    expect(groups[0].columns).toEqual(['Breach in']);
  });

  it('hoists everything for a group of one, which agrees with itself', () => {
    const { groups } = groupInsights([signal()]);
    expect(groups[0].columns).toEqual([]);
    expect(groups[0].constants).toEqual([{ label: 'Breach in', value: '3 trading days' }]);
    expect(groups[0].severity).toBe('warning');
  });
});

describe('the account column', () => {
  it('is dropped, not hoisted, when the rule names no account at all', () => {
    // Missing Close is a client-level rule: accountAlias is null on all 84 rows.
    // A heading reading "Account: —" is worse than no heading.
    const { groups } = groupInsights([
      signal({ type: 'Missing Close', accountAlias: null }),
      signal({ type: 'Missing Close', accountAlias: null, clientId: 'c2' }),
    ]);
    expect(groups[0].showAccount).toBe(false);
    expect(groups[0].accountConstant).toBeNull();
  });

  it('is hoisted when every row names the SAME account', () => {
    const { groups } = groupInsights([
      signal({ accountAlias: 'ACC1' }),
      signal({ accountAlias: 'ACC1', clientId: 'c2' }),
    ]);
    expect(groups[0].showAccount).toBe(false);
    expect(groups[0].accountConstant).toBe('ACC1');
  });

  it('is a column when the accounts differ', () => {
    const { groups } = groupInsights([
      signal({ accountAlias: 'ACC1' }),
      signal({ accountAlias: 'ACC2', clientId: 'c2' }),
    ]);
    expect(groups[0].showAccount).toBe(true);
  });
});

describe('columns', () => {
  it('keeps the order the producer states its facts in, never alphabetised', () => {
    // The Consistency Rule's own order, chosen because it is NOT alphabetical:
    // sorting it would lead with "Best day" instead of the share of gains that
    // is the reason the signal fired. Drawdown Velocity's three labels happen to
    // be in alphabetical order already, so a test written on those would pass
    // against a sort and prove nothing.
    const items = [
      signal({
        type: 'Consistency Rule',
        facts: [
          { label: 'Share of gains', value: '86%' },
          { label: 'Best day', value: '$434' },
          { label: 'On', value: '2026-07-27' },
          { label: 'Total gains', value: '$505' },
        ],
      }),
    ];
    expect(columnsOf(items)).toEqual(['Share of gains', 'Best day', 'On', 'Total gains']);
    expect(columnsOf(items)).not.toEqual([...columnsOf(items)].sort());
  });

  it('gives a column to a label only some rows carry', () => {
    const items = [
      signal({ facts: [{ label: 'Breach in', value: '1 trading day' }] }),
      signal({
        clientId: 'c2',
        facts: [
          { label: 'Breach in', value: '4 trading days' },
          { label: 'Note', value: 'reserve account' },
        ],
      }),
    ];
    expect(columnsOf(items)).toEqual(['Breach in', 'Note']);
  });

  it('reads a cell by its label so a missing value cannot shift the next one left', () => {
    // The failure this exists for: a row rendered by walking its own facts in
    // order prints its second value under the third column's heading. On this
    // pair that would put "reserve account" under "Breach in".
    const sparse = signal({ facts: [{ label: 'Note', value: 'reserve account' }] });
    expect(factValue(sparse, 'Breach in')).toBeNull();
    expect(factValue(sparse, 'Note')).toBe('reserve account');
  });

  it('ignores a malformed fact rather than making a column out of it', () => {
    const items = [signal({ facts: [null, { value: 'no label' }, { label: 'Breach in', value: '1' }] })];
    expect(columnsOf(items)).toEqual(['Breach in']);
  });
});

describe('the order a reader works a group in', () => {
  it('puts worst severity first, then the biggest urgency inside it', () => {
    const sorted = sortSignals([
      signal({ clientName: 'Warn-small', severity: 'warning', urgency: -5 }),
      signal({ clientName: 'Crit-far', severity: 'critical', urgency: -2 }),
      signal({ clientName: 'Crit-near', severity: 'critical', urgency: -1 }),
      signal({ clientName: 'Warn-big', severity: 'warning', urgency: -3 }),
    ]);
    expect(sorted.map((item) => item.clientName)).toEqual([
      'Crit-near',
      'Crit-far',
      'Warn-big',
      'Warn-small',
    ]);
  });

  it('sorts an unranked signal last within its severity, never first', () => {
    // "No magnitude stated" is not "the most urgent one".
    const sorted = sortSignals([
      signal({ clientName: 'Unranked', urgency: undefined }),
      signal({ clientName: 'Ranked', urgency: -9 }),
    ]);
    expect(sorted.map((item) => item.clientName)).toEqual(['Ranked', 'Unranked']);
  });

  it('is stable by name so two renders of the same feed do not reshuffle', () => {
    const tie = [
      signal({ clientName: 'Zoe', urgency: 1 }),
      signal({ clientName: 'Adam', urgency: 1 }),
    ];
    expect(sortSignals(tie).map((item) => item.clientName)).toEqual(['Adam', 'Zoe']);
    expect(sortSignals(tie.slice().reverse()).map((item) => item.clientName))
      .toEqual(['Adam', 'Zoe']);
  });

  it('never lets one rule’s urgency outrank another rule’s', () => {
    // Days-until-breach and percent-of-gains are different quantities. A
    // consistency signal at 86 must not be sorted above a drawdown signal at -1
    // just because 86 is the larger number: they are never in the same list.
    const { groups } = groupInsights([
      signal({ type: 'Drawdown Velocity', severity: 'critical', urgency: -1 }),
      signal({ type: 'Consistency Rule', severity: 'critical', urgency: 86, clientId: 'c2' }),
    ]);
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(group.items).toHaveLength(1);
  });
});

describe('groups and totals', () => {
  it('orders groups by worst severity, then by size', () => {
    const { groups } = groupInsights([
      signal({ type: 'Missing Close', severity: 'warning' }),
      signal({ type: 'Missing Close', severity: 'warning', clientId: 'c2' }),
      signal({ type: 'Missing Close', severity: 'warning', clientId: 'c3' }),
      signal({ type: 'Drawdown Velocity', severity: 'critical' }),
    ]);
    expect(groups.map((group) => group.type)).toEqual(['Drawdown Velocity', 'Missing Close']);
  });

  it('adds the group counts up to the totals the header prints', () => {
    // The header used to run its own filter over the same array, so nothing made
    // "83 critical" and the groups' own badges agree.
    // A fourth severity is in the fixture on purpose. With only criticals and
    // warnings on the board, "count the criticals" and "count everything that is
    // not a warning" give the same answer, and a header recomputing the wrong
    // one of those would agree with the groups by luck.
    const insights = [
      signal({ severity: 'critical' }),
      signal({ severity: 'warning', clientId: 'c2' }),
      signal({ type: 'Missing Close', severity: 'warning', clientId: 'c3' }),
      signal({ type: 'Payout Opportunity', severity: 'info-green', clientId: 'c4' }),
    ];
    const { groups, totals } = groupInsights(insights);
    expect(totals.signals).toBe(4);
    expect(totals.critical).toBe(groups.reduce((sum, g) => sum + g.critical, 0));
    expect(totals.warning).toBe(groups.reduce((sum, g) => sum + g.warning, 0));
    expect(totals.critical).toBe(1);
    expect(totals.warning).toBe(2);
    // Neither total swallows the severities that are neither.
    expect(totals.critical + totals.warning).toBe(3);
  });

  it('counts distinct clients, not signals', () => {
    const { totals } = groupInsights([
      signal({ clientId: 'c1' }),
      signal({ clientId: 'c1', accountAlias: 'ACC2' }),
      signal({ clientId: 'c2' }),
    ]);
    expect(totals.signals).toBe(3);
    expect(totals.clients).toBe(2);
  });

  it('holds the severity order the producer sorts by', () => {
    expect(SEVERITY_RANK).toEqual({ critical: 0, warning: 1, 'info-green': 2, info: 3 });
  });

  it('returns nothing at all for an empty feed rather than an empty group', () => {
    expect(groupInsights([])).toEqual({
      groups: [],
      totals: { signals: 0, critical: 0, warning: 0, clients: 0 },
    });
  });
});
