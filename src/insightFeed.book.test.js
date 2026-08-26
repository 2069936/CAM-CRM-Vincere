// The Insight Feed measured on the real book.
//
// src/domain/insightFeed.test.js and src/components/InsightFeedPanel.test.jsx
// pin the layout rule and run everywhere. THESE ARE THE NUMBERS, and they are
// the reason the rule exists: nothing synthetic shows what a panel does when one
// of its rules fires 84 times with the same sentence.
//
// The clock is pinned to 2026-07-31 — a Friday, and the first trading day after
// the book's last close on 2026-07-30. buildPortfolioInsights reads the wall
// clock (a missing close is "no upload in the last 2 trading days"), so an
// unpinned run would drift with the calendar and these counts would rot. The
// pinned day is the one an operator would actually have been looking at.
//
// What this file is FOR, in one line: the layout change may not move a count.
// Every signal the producer emits is still rendered, still attributed to its
// client, still carries its own sentence. If a future "simplification" starts
// dropping rows, the totals here fail before anyone sees a shorter screen and
// calls it an improvement.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPortfolioInsights } from './App';
import { groupInsights } from './domain/insightFeed';
import { buildCrmStateFromTables } from './domain/supabaseStore';

const AS_OF = '2026-07-31';

const snapshot = JSON.parse(
  readFileSync(new URL('../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const state = buildCrmStateFromTables(snapshot.tables);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${AS_OF}T12:00:00`));
});
afterEach(() => vi.useRealTimers());

const groupNamed = (groups, type) => groups.find((group) => group.type === type);

describe('the desk feed on the real book (96 clients, closes 2026-07-13 → 2026-07-30)', () => {
  it('is a trading day, which is what makes the missing-close rule run at all', () => {
    // Saturday or Sunday and the rule skips entirely, so the 26 below would be 0
    // and this whole file would be asserting the weekend.
    expect(new Date(`${AS_OF}T12:00:00`).getDay()).toBe(5);
  });

  it('reads 134 signals over 59 clients, in three rules', () => {
    const { groups, totals } = groupInsights(buildPortfolioInsights(state.clients));
    expect(totals).toEqual({ signals: 134, critical: 83, warning: 51, clients: 59 });
    expect(groups.map((group) => [group.type, group.count])).toEqual([
      ['Consistency Rule', 65],
      ['Drawdown Velocity', 43],
      ['Missing Close', 26],
    ]);
    // Two of the five rules are silent on this book — Payout Opportunity and
    // Strategy Cooling. Stated rather than left to the reader of the list above,
    // because a rule that never fires is a rule nothing is testing on real data.
    const firing = new Set(groups.map((group) => group.type));
    expect(firing.has('Payout Opportunity')).toBe(false);
    expect(firing.has('Strategy Cooling')).toBe(false);
  });

  it('renders every signal it produces — the layout drops nothing', () => {
    const insights = buildPortfolioInsights(state.clients);
    const { groups } = groupInsights(insights);
    const rendered = groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(rendered).toBe(insights.length);
    // And every one of them is attributable and readable on its own.
    for (const group of groups) {
      for (const item of group.items) {
        expect(item.clientId).toBeTruthy();
        expect(item.message).toBeTruthy();
        expect(Array.isArray(item.facts) && item.facts.length).toBeTruthy();
      }
    }
  });

  it('adds up to the sum of the eight CAMs’ own feeds, unlike the deviation panel', () => {
    // Worth stating because the panel directly above it on the manager's page
    // does NOT: a deviation alert is measured against a peer group, so widening
    // from a CAM to the desk moves the threshold and 74 desk alerts sit against
    // 30 across the CAM views. Every insight rule is computed inside one client,
    // so this feed genuinely is the union and needs no reconciliation sentence.
    // The day a rule starts comparing a client to its peers, this fails.
    const byId = new Map(state.clients.map((client) => [client.id, client]));
    let signals = 0;
    const clients = new Set();
    for (const profile of state.camProfiles) {
      const own = (profile.clientIds || []).map((id) => byId.get(id)).filter(Boolean);
      const totals = groupInsights(buildPortfolioInsights(own)).totals;
      signals += totals.signals;
      for (const item of buildPortfolioInsights(own)) clients.add(item.clientId);
    }
    const desk = groupInsights(buildPortfolioInsights(state.clients)).totals;
    expect(signals).toBe(desk.signals);
    expect(clients.size).toBe(desk.clients);
  });
});

describe('the repetition the layout rule was written for', () => {
  it('carries three distinct actions across all 134 rows, and prints three lines', () => {
    // This is the whole measurement. The old panel gave every signal a
    // "→ what to do" line of its own: 134 lines of text carrying 3 sentences.
    const insights = buildPortfolioInsights(state.clients);
    expect(new Set(insights.map((item) => item.action)).size).toBe(3);

    const { groups } = groupInsights(insights);
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group.action).toBeTruthy();
  });

  it('turns the 26 identical Missing Close rows into 26 rows that differ', () => {
    const { groups } = groupInsights(buildPortfolioInsights(state.clients));
    const missing = groupNamed(groups, 'Missing Close');

    // The rule's sentence is one sentence, on all 26 rows. That is what made the
    // group unreadable, and it is still true — the message was not rewritten.
    expect(new Set(missing.items.map((item) => item.message)).size).toBe(1);
    // It is a client-level rule, so it names no account on any row: the column
    // is dropped rather than printed 26 times empty.
    expect(missing.items.every((item) => item.accountAlias === null)).toBe(true);
    expect(missing.showAccount).toBe(false);
    // Every row is a warning, so the severity is a heading and not a column.
    expect(missing.severity).toBe('warning');
    expect(missing.critical).toBe(0);

    // And what replaces the repetition actually separates the rows: seven
    // distinct last-close dates spanning 3 to 18 calendar days of silence.
    const lastClose = missing.items.map((item) => item.facts[0].value);
    expect(new Set(lastClose).size).toBe(7);
    const days = missing.items.map((item) => item.urgency);
    expect(Math.min(...days)).toBe(3);
    expect(Math.max(...days)).toBe(18);
    // Longest silence first. A client who has not uploaded in eighteen days and
    // one who missed yesterday were indistinguishable before.
    expect(days).toEqual([...days].sort((a, b) => b - a));
    expect(missing.items[0].facts[0].value).toBe('2026-07-13');
  });

  it('keeps the severity column on Drawdown Velocity, which is genuinely split', () => {
    // The hoist is decided per group by comparing values, not by rule. 21
    // critical against 22 warning is the case where the column earns its width.
    const { groups } = groupInsights(buildPortfolioInsights(state.clients));
    const velocity = groupNamed(groups, 'Drawdown Velocity');
    expect([velocity.critical, velocity.warning]).toEqual([21, 22]);
    expect(velocity.severity).toBeNull();
    expect(velocity.showAccount).toBe(true);
    expect(velocity.columns).toEqual(['Breach in', 'Buffer left', 'Depleting']);
  });

  it('puts the account closest to breaching at the top of its group', () => {
    // Ordered by the number that makes it urgent, inside the group only. The old
    // feed left rows in whatever order the clients were walked in, so among 21
    // criticals nothing said which was breaching first.
    const { groups } = groupInsights(buildPortfolioInsights(state.clients));
    const velocity = groupNamed(groups, 'Drawdown Velocity');
    const projections = velocity.items.map((item) => -item.urgency);
    expect(projections[0]).toBe(0);
    expect(projections.at(-1)).toBe(5);
    expect(projections).toEqual([...projections].sort((a, b) => a - b));
  });
});

describe('what a single CAM sees', () => {
  it('gives the two quietest CAMs one group with nothing repeated in it', () => {
    // Parker Elm and Avery Birch have 8 signals each, all Missing Close. Their
    // whole feed is now one heading — the rule, its severity, its instruction —
    // over eight rows of a name and two dates. It used to be eight cards of
    // three lines each, 24 lines to say what eight names say.
    const byId = new Map(state.clients.map((client) => [client.id, client]));
    for (const name of ['Parker Elm', 'Avery Birch']) {
      const profile = state.camProfiles.find((entry) => entry.name === name);
      const own = (profile.clientIds || []).map((id) => byId.get(id)).filter(Boolean);
      const { groups, totals } = groupInsights(buildPortfolioInsights(own));
      expect(totals.signals).toBe(8);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('Missing Close');
      expect(groups[0].action).toBeTruthy();
      expect(groups[0].severity).toBe('warning');
      expect(groups[0].showAccount).toBe(false);
      expect(groups[0].columns).toEqual(['Last close', 'Calendar days ago']);
    }
  });

  it('never hoists an action on a CAM whose rows disagree about one', () => {
    // Guard against the hoist being read as "actions are constant per rule". No
    // group on this book disagrees, so this states the mechanism instead: adding
    // one dissenting row to the busiest CAM's biggest group must put the column
    // back.
    const profile = state.camProfiles.find((entry) => entry.name === 'Reese Glen');
    const byId = new Map(state.clients.map((client) => [client.id, client]));
    const own = (profile.clientIds || []).map((id) => byId.get(id)).filter(Boolean);
    const insights = buildPortfolioInsights(own);
    const velocity = insights.filter((item) => item.type === 'Drawdown Velocity');
    expect(velocity.length).toBe(18);
    expect(groupNamed(groupInsights(insights).groups, 'Drawdown Velocity').action).toBeTruthy();

    const dissenting = [
      ...insights,
      { ...velocity[0], clientId: 'other', action: 'Escalate to the desk manager' },
    ];
    expect(groupNamed(groupInsights(dissenting).groups, 'Drawdown Velocity').action).toBeNull();
  });
});
