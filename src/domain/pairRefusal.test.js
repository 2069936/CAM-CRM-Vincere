import { describe, it, expect } from 'vitest';
import { describePairRefusal, isActionableRefusal } from './pairRefusal';

const attempt = (over = {}) => ({ at: '2026-09-01T21:03:00Z', reason: 'machine_conflict', ...over });

describe('the refusal a new code can never fix', () => {
  it('names the client holding the VPS, which is the only actionable fact', () => {
    // THE CASE THIS EXISTS FOR. The blocking device usually belongs to a client
    // outside this CAM's book, so the fleet view shows them nothing and the
    // admin fleet endpoint answers 403. Without the name there is no next step.
    const described = describePairRefusal(attempt({ blockedBy: { clientName: 'Andrew Nestra' } }));
    expect(described.detail).toContain('Andrew Nestra');
    expect(described.newCodeHelps).toBe(false);
  });

  it('says a new code will not help, in those words', () => {
    // Sixty-six of the last sixty-eight refusals were this, and every one was
    // answered with another code.
    expect(describePairRefusal(attempt({ blockedBy: { clientName: 'Andrew Nestra' } })).detail)
      .toContain('A new code will not help');
  });

  it('sends them to a Manager when the name did not survive the lookup', () => {
    // The audit row predates the attribution, or the device was revoked between
    // the refusal and the read. Still not a code problem.
    const described = describePairRefusal(attempt({ blockedBy: null }));
    expect(described.detail).toContain('Manager');
    expect(described.newCodeHelps).toBe(false);
  });

  it('ignores a blank name rather than printing an empty sentence', () => {
    expect(describePairRefusal(attempt({ blockedBy: { clientName: '   ' } })).detail)
      .toContain('Ask a Manager');
  });
});

describe('separating the refusals a code fixes from the ones it does not', () => {
  it.each([
    ['code_expired', true],
    ['code_consumed', true],
    ['code_revoked', true],
    ['credential_conflict', true],
    ['nonce_or_credential_conflict', true],
    ['machine_conflict', false],
    ['device_revoked', false],
    ['client_ineligible', false],
    ['invalid_request', false],
  ])('%s', (reason, helps) => {
    expect(describePairRefusal(attempt({ reason })).newCodeHelps).toBe(helps);
  });

  it('warns that regenerating is what revokes a code someone is typing', () => {
    expect(describePairRefusal(attempt({ reason: 'code_revoked' })).detail)
      .toContain('cancels any earlier one');
  });

  it('reads an unknown reason as unknown instead of inventing one', () => {
    const described = describePairRefusal(attempt({ reason: 'pairing_refused' }));
    expect(described.newCodeHelps).toBe(false);
    expect(described.detail).toContain('Manager');
  });
});

describe('when nothing should be shown', () => {
  it('says nothing without an attempt', () => {
    expect(describePairRefusal(null)).toBeNull();
    expect(describePairRefusal(undefined)).toBeNull();
    expect(describePairRefusal({})).toBeNull();
  });

  it('stays quiet about rate limiting, which is the desk retrying, not a fault', () => {
    expect(isActionableRefusal(attempt({ reason: 'rate_limited' }))).toBe(false);
    expect(describePairRefusal(attempt({ reason: 'rate_limited' }))).toBeNull();
  });
});
