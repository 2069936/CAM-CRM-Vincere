// The sentence the user actually reads, and the four states it has to tell apart.
//
// THE DEFECT THIS PINS
//
// The pass that split "your save failed" from "your view is stale" wrote the
// honest sentence for the second case and then never rendered it:
// `remoteStatus.message` appeared nowhere in src/. The sidebar read the status
// alone, through a three-way ternary, so the new fourth state fell through to
// the same four words as a dead connection — a user whose refresh was
// rate-limited, whose edit is saved and whose screen is correct, was told
// exactly what a user with no database is told.
//
// A ternary is not testable and a fourth state added to one is not reviewable,
// which is the whole reason the mapping has a module of its own.

import { describe, expect, it } from 'vitest';
import { describeRemoteStatus } from './remoteStatus.js';
import { refreshFailedMessage } from './persistEdit.js';

const stale = () => ({
  source: 'supabase',
  status: 'stale',
  message: refreshFailedMessage('the close', new Error('429 Too Many Requests')),
});

const dead = () => ({
  source: 'supabase',
  status: 'error',
  message: 'Supabase unavailable: Failed to fetch',
});

describe('describeRemoteStatus', () => {
  it('does not tell a stale user what it tells a disconnected one', () => {
    // The defect, stated as the thing that must never be true again.
    expect(describeRemoteStatus(stale()).label).not.toBe(describeRemoteStatus(dead()).label);
  });

  it('renders the stale sentence rather than dropping it', () => {
    // "your change is safe" is the half of the message the user needs, and it
    // reached only the tests.
    const { detail } = describeRemoteStatus(stale());
    expect(detail).toContain('The view could not be refreshed');
    expect(detail).toContain('your change is safe');
    expect(detail).not.toMatch(/could not save/i);
  });

  it('does not call a stale view an error', () => {
    // status "error" is what reads as a total outage. A refresh that was rate
    // limited is not one, and colouring it the same way says it is.
    const { tone, label } = describeRemoteStatus(stale());
    expect(tone).toBe('warning');
    expect(label).toBe('Showing older data');
  });

  it('shows the reason a hard error gives, which was also being dropped', () => {
    const { tone, label, detail } = describeRemoteStatus(dead());
    expect(tone).toBe('negative');
    expect(label).toBe('Supabase required');
    expect(detail).toBe('Supabase unavailable: Failed to fetch');
  });

  it('says nothing extra when there is nothing to act on', () => {
    // A connected user does not need a sentence, and "Connected to Supabase"
    // printed under "Data: Supabase" is noise that trains people to stop
    // reading the line that sometimes matters.
    for (const status of ['connected', 'loading']) {
      const described = describeRemoteStatus({ source: 'supabase', status, message: 'Connected to Supabase' });
      expect(described.detail).toBe('');
    }
  });

  it('names the connected and connecting states as it always did', () => {
    expect(describeRemoteStatus({ source: 'supabase', status: 'connected' })).toMatchObject({
      label: 'Supabase', tone: 'positive',
    });
    expect(describeRemoteStatus({ source: 'supabase', status: 'loading' })).toMatchObject({
      label: 'Connecting...', tone: '',
    });
  });

  it('does not claim a local snapshot session is talking to Supabase', () => {
    // The old ternary printed "Data: Supabase" while the app was running
    // read-only off public/local-snapshot.json. Same class of defect: the
    // status was read and the source was not.
    expect(describeRemoteStatus({
      source: 'local-snapshot', status: 'connected', message: 'Local snapshot (read-only)',
    }).label).toBe('Local snapshot');
  });

  it('treats an unknown status as an error rather than as connected', () => {
    // Fail towards telling the user something is wrong. The opposite default is
    // how a broken state gets a green label.
    const described = describeRemoteStatus({ source: 'supabase', status: 'wat', message: 'boom' });
    expect(described.tone).toBe('negative');
    expect(described.detail).toBe('boom');
  });
});
