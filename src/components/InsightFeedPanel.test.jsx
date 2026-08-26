// @vitest-environment jsdom
//
// That the Insight Feed's layout rule reaches the screen.
//
// src/domain/insightFeed.test.js pins what gets hoisted. This pins that the
// panel renders the hoist — that the action a group agrees on appears once and
// not once per row, that a column only appears when it can tell two rows apart,
// and above all that a row missing a value keeps its cell.
//
// THAT LAST ONE IS THE POINT OF THE FILE. Every other assertion here would still
// pass if the panel rendered each row by walking its own facts in order, because
// on today's book every signal of a rule carries the same fact labels. The first
// rule that states a fact conditionally would then print its second number under
// the third column's heading, silently, with the number itself perfectly
// correct. So the shift is tested directly, against a deliberately sparse row,
// by reading cells by column INDEX and comparing them to the header.
//
// Synthetic fixtures only, so CI runs every line of it.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightFeedPanel } from '../App';

afterEach(cleanup);

function signal(overrides = {}) {
  return {
    severity: 'warning',
    type: 'Drawdown Velocity',
    clientId: 'c1',
    clientName: 'Alice',
    accountAlias: 'ACC1',
    message: 'Buffer $287 depleting ~$204/day - projected breach in 1 trading day',
    action: 'Review stack or reduce position size',
    urgency: -1,
    facts: [
      { label: 'Breach in', value: '1 trading day' },
      { label: 'Buffer left', value: '$287' },
    ],
    ...overrides,
  };
}

/** Opens a rule's group the way a reader does. */
function openGroup(type) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(type, 'i') }));
}

function headerCells() {
  return within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent.trim());
}

function rowCells(name) {
  const row = screen.getByRole('row', { name: new RegExp(name) });
  return [...row.children].map((cell) => cell.textContent.trim());
}

describe('the rule is stated once, the rows carry what differs', () => {
  it('renders a shared action once for the whole group, not once per row', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ clientId: 'c1', clientName: 'Alice' }),
          signal({ clientId: 'c2', clientName: 'Bob' }),
          signal({ clientId: 'c3', clientName: 'Cara' }),
        ]}
      />,
    );
    openGroup('Drawdown Velocity');
    expect(screen.getAllByText('Review stack or reduce position size')).toHaveLength(1);
    expect(headerCells()).not.toContain('What to do');
  });

  it('gives every row its own action when the group does not agree on one', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ type: 'Payout Opportunity', severity: 'info-green', action: 'Request payout now' }),
          signal({
            type: 'Payout Opportunity',
            severity: 'info',
            clientId: 'c2',
            clientName: 'Bob',
            action: 'Monitor until target',
          }),
        ]}
      />,
    );
    openGroup('Payout Opportunity');
    expect(headerCells()).toContain('What to do');
    expect(screen.getByText('Request payout now')).toBeTruthy();
    expect(screen.getByText('Monitor until target')).toBeTruthy();
  });

  it('drops the severity column when the whole group is one severity', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ type: 'Missing Close', accountAlias: null }),
          signal({ type: 'Missing Close', accountAlias: null, clientId: 'c2', clientName: 'Bob' }),
        ]}
      />,
    );
    openGroup('Missing Close');
    expect(headerCells()).not.toContain('Severity');
    // Stated once instead, with how many rows it covers.
    expect(screen.getByText(/all 2/)).toBeTruthy();
  });

  it('keeps the severity column when the group is mixed', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ severity: 'critical' }),
          signal({ severity: 'warning', clientId: 'c2', clientName: 'Bob' }),
        ]}
      />,
    );
    openGroup('Drawdown Velocity');
    expect(headerCells()).toContain('Severity');
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
  });

  it('drops the account column for a rule that names no account', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ type: 'Missing Close', accountAlias: null }),
          signal({ type: 'Missing Close', accountAlias: null, clientId: 'c2', clientName: 'Bob' }),
        ]}
      />,
    );
    openGroup('Missing Close');
    expect(headerCells()).not.toContain('Account');
  });
});

describe('a row missing a value keeps its cell', () => {
  it('leaves the gap empty and holds every other value under its own heading', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({
            clientName: 'Complete',
            facts: [
              { label: 'Breach in', value: '1 trading day' },
              { label: 'Buffer left', value: '$287' },
              { label: 'Depleting', value: '$204/day' },
            ],
          }),
          signal({
            clientId: 'c2',
            clientName: 'Sparse',
            accountAlias: 'ACC2',
            urgency: -4,
            facts: [
              // No "Buffer left" at all. A panel that walked this row's own
              // facts in order would print $99/day under "Buffer left".
              { label: 'Breach in', value: '4 trading days' },
              { label: 'Depleting', value: '$99/day' },
            ],
          }),
        ]}
      />,
    );
    openGroup('Drawdown Velocity');

    const headers = headerCells();
    expect(headers).toEqual(['Client', 'Account', 'Breach in', 'Buffer left', 'Depleting']);

    expect(rowCells('Complete')).toEqual([
      'Complete', 'ACC1', '1 trading day', '$287', '$204/day',
    ]);
    const sparse = rowCells('Sparse');
    expect(sparse).toHaveLength(headers.length);
    expect(sparse[headers.indexOf('Buffer left')]).toBe('');
    expect(sparse[headers.indexOf('Depleting')]).toBe('$99/day');
    expect(sparse[headers.indexOf('Breach in')]).toBe('4 trading days');
  });
});

describe('what the panel still has to do', () => {
  it('keeps the signal’s own sentence on the row', () => {
    // Nothing is lost by tabling the numbers: the prose the producer wrote is
    // still there, one hover away.
    render(<InsightFeedPanel insights={[signal()]} />);
    openGroup('Drawdown Velocity');
    expect(screen.getByRole('row', { name: /Alice/ }).getAttribute('title')).toBe(
      'Buffer $287 depleting ~$204/day - projected breach in 1 trading day',
    );
  });

  it('still reaches the client the signal is about', () => {
    const onSelectClient = vi.fn();
    render(<InsightFeedPanel insights={[signal()]} onSelectClient={onSelectClient} />);
    openGroup('Drawdown Velocity');
    fireEvent.click(screen.getByTitle('Open Alice'));
    expect(onSelectClient).toHaveBeenCalledWith('c1');
  });

  it('works the most urgent row of a group first', () => {
    render(
      <InsightFeedPanel
        insights={[
          signal({ clientName: 'Later', severity: 'critical', urgency: -2 }),
          signal({ clientName: 'Tomorrow', severity: 'critical', clientId: 'c2', urgency: -1 }),
        ]}
      />,
    );
    openGroup('Drawdown Velocity');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Tomorrow'),
      expect.stringContaining('Later'),
    ]);
  });

  it('opens closed, and shows no table until a group is asked for', () => {
    render(<InsightFeedPanel insights={[signal(), signal({ clientId: 'c2' })]} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Drawdown Velocity')).toBeTruthy();
    openGroup('Drawdown Velocity');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('says all clear rather than rendering an empty feed', () => {
    render(<InsightFeedPanel insights={[]} />);
    expect(screen.getByText('All clear')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('counts the clients behind the signals in its header', () => {
    // 192 signals over 84 clients reads differently from 192 over 192, and the
    // header had no way to say which.
    render(
      <InsightFeedPanel
        insights={[
          signal({ clientId: 'c1', accountAlias: 'ACC1' }),
          signal({ clientId: 'c1', accountAlias: 'ACC2' }),
          signal({ clientId: 'c2', clientName: 'Bob' }),
        ]}
      />,
    );
    expect(screen.getByText(/3 signals · 2 clients/)).toBeTruthy();
  });
});
