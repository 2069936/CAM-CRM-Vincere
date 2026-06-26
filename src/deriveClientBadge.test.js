import { describe, expect, it } from 'vitest';
import { deriveClientBadge } from './App';

function makeClient(flags = []) {
  return {
    dailyImports: [
      {
        date: '2026-06-25',
        snapshots: [],
        flags,
      },
    ],
  };
}

describe('deriveClientBadge', () => {
  it('returns No data for a client with no imports', () => {
    expect(deriveClientBadge({ dailyImports: [] }).label).toBe('No data');
  });

  it('shows critical count for unresolved critical flags', () => {
    const client = makeClient([
      { severity: 'Critical', status: 'Open' },
      { severity: 'Critical', status: 'Open' },
    ]);
    expect(deriveClientBadge(client).label).toBe('2 critical');
    expect(deriveClientBadge(client).tone).toBe('danger');
  });

  it('excludes Resolved critical flags from the badge count', () => {
    const client = makeClient([
      { severity: 'Critical', status: 'Resolved' },
    ]);
    const badge = deriveClientBadge(client);
    expect(badge.tone).not.toBe('danger');
  });

  it('excludes Acknowledged critical flags from the badge count', () => {
    // Regression: badge was showing critical even after CAM acknowledged the flag
    const client = makeClient([
      { severity: 'Critical', status: 'Acknowledged' },
    ]);
    const badge = deriveClientBadge(client);
    expect(badge.tone).not.toBe('danger');
    expect(badge.label).not.toContain('critical');
  });

  it('shows open warning flags when no critical flags remain', () => {
    const client = makeClient([
      { severity: 'Warning', status: 'Open' },
      { severity: 'Warning', status: 'Open' },
    ]);
    const badge = deriveClientBadge(client);
    expect(badge.tone).toBe('warning');
    expect(badge.label).toContain('flags');
  });

  it('shows ok when all flags are resolved or acknowledged', () => {
    const client = makeClient([
      { severity: 'Critical', status: 'Resolved' },
      { severity: 'Warning', status: 'Acknowledged' },
    ]);
    const badge = deriveClientBadge(client);
    expect(badge.tone).not.toBe('danger');
    expect(badge.tone).not.toBe('warning');
  });

  it('shows overdue task count when no open flags exist', () => {
    const client = {
      ...makeClient([]),
      tasks: [
        { id: 't1', text: 'Follow up', done: false, dueDate: '2026-06-20' }, // past date = overdue
      ],
    };
    const badge = deriveClientBadge(client);
    expect(badge.tone).toBe('warning');
    expect(badge.label).toContain('overdue');
  });

  it('shows open task count when no flags and no overdue tasks', () => {
    const client = {
      ...makeClient([]),
      tasks: [
        { id: 't1', text: 'Review account', done: false, dueDate: '2027-01-01' }, // future = not overdue
        { id: 't2', text: 'Send report', done: false, dueDate: '2027-02-01' },
      ],
    };
    const badge = deriveClientBadge(client);
    expect(badge.label).toContain('tasks');
    expect(badge.tone).toBe('muted');
  });

  it('shows Ready/success when no flags and no open tasks', () => {
    const client = {
      ...makeClient([]),
      tasks: [{ id: 't1', text: 'Done', done: true, dueDate: '2026-06-01' }],
    };
    const badge = deriveClientBadge(client);
    expect(badge.tone).toBe('success');
  });
});
