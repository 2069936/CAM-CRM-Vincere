import { describe, expect, it } from 'vitest';
import {
  CLOSE_MERGE_FLAG_HINTS,
  CLOSE_MERGE_FLAG_TYPES,
  DATABASE_FLAG_HINTS,
  DATABASE_FLAG_TYPES,
  databaseFlagHint,
} from './databaseFlagTypes.js';
import { LIVE_ACCOUNT_FLAG_TYPES } from './reconcile.js';

/* The flag types the database writes itself (steps 65 and 71). The step 71
 * cluster test compares this list with the types a running database wrote;
 * this file holds the browser's half of the promise. */
describe('the flag types the database writes', () => {
  it('are the five, step 65\'s and step 71\'s, by these exact words', () => {
    expect(DATABASE_FLAG_TYPES).toEqual({
      MARKED_FAILED: 'Marked Failed by the close',
      BREACH_SUSPECTED: 'Breach suspected',
      REACTIVATED: 'Reactivated by the close',
      FAILED_ACCOUNT_TRADED: 'Failed account traded',
      STRATEGIES_STILL_LOADED: 'Strategies still loaded',
    });
    expect(Object.isFrozen(DATABASE_FLAG_TYPES)).toBe(true);
  });

  it('none of them is one of the five live account flags step 67 drops for a dead account', () => {
    // Step 67's insert guard drops an Open flag of LIVE_ACCOUNT_FLAG_TYPES on an
    // account that reads breached. These are written exactly for such accounts.
    for (const type of Object.values(DATABASE_FLAG_TYPES)) expect(LIVE_ACCOUNT_FLAG_TYPES).not.toContain(type);
  });

  it('each has one sentence for its hover, with no dash as punctuation, and reconcile\'s types have none', () => {
    expect(Object.keys(DATABASE_FLAG_HINTS).sort()).toEqual(Object.values(DATABASE_FLAG_TYPES).sort());
    for (const [type, hint] of Object.entries(DATABASE_FLAG_HINTS)) {
      expect(hint, type).toMatch(/^[A-Z].*\.$/);
      expect(hint, type).not.toMatch(/—|–| - /);
      expect(databaseFlagHint(type)).toBe(hint);
    }
    for (const type of ['Missing account', 'Drawdown breached', 'Strategy disabled']) expect(databaseFlagHint(type)).toBeUndefined();
  });

  it('no hover says a breach alone marks an account Failed', () => {
    for (const hint of Object.values(DATABASE_FLAG_HINTS)) {
      expect(hint).not.toMatch(/breach(ed)? (alone )?marks?/i);
    }
    expect(DATABASE_FLAG_HINTS['Marked Failed by the close']).toMatch(/confirmed by later closes/);
  });
});

/* Step 73's three. The step 73 cluster test compares this list with the types
 * a running database wrote; this file holds the browser's half. */
describe('the flag types a merging close and the tracker fill write', () => {
  it('are the three, by these exact words, and none of them is one of the five above', () => {
    expect(CLOSE_MERGE_FLAG_TYPES).toEqual({
      CAPTURE_LOST_ACTIVITY: 'Capture lost activity',
      TRACKER_ONLY_ACCOUNT: 'Tracker only account',
      CLOSE_BELOW_TRACKER: 'Close below tracker',
    });
    expect(Object.isFrozen(CLOSE_MERGE_FLAG_TYPES)).toBe(true);
    for (const type of Object.values(CLOSE_MERGE_FLAG_TYPES)) {
      expect(Object.values(DATABASE_FLAG_TYPES)).not.toContain(type);
      expect(LIVE_ACCOUNT_FLAG_TYPES).not.toContain(type);
    }
  });

  it('each has one sentence for its hover, with no dash as punctuation, reached through databaseFlagHint', () => {
    expect(Object.keys(CLOSE_MERGE_FLAG_HINTS).sort()).toEqual(Object.values(CLOSE_MERGE_FLAG_TYPES).sort());
    for (const [type, hint] of Object.entries(CLOSE_MERGE_FLAG_HINTS)) {
      expect(hint, type).toMatch(/^[A-Z].*\.$/);
      expect(hint, type).not.toMatch(/—|–| - /);
      expect(databaseFlagHint(type)).toBe(hint);
    }
    expect(databaseFlagHint('Marked Failed by the close')).toBe(DATABASE_FLAG_HINTS['Marked Failed by the close']);
  });
});
