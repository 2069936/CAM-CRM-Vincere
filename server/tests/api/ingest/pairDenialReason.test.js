import { describe, it, expect } from 'vitest';
import { publicDenialReason } from '../../../autoCollection/ingest/pair.js';

/* Nine ways to be refused used to come back as one sentence, and the Setup
 * window told the desk to generate a new code for all of them. Two are actually
 * fixed by a new code. The rest are not, and the desk generated code after code
 * against a machine that already had a device. */

describe('what a refused pairing is allowed to say', () => {
  it('withholds only the one that would let someone guess codes', () => {
    // Told apart from the others, code_not_found turns this endpoint into an
    // oracle: try a code, learn whether it exists.
    expect(publicDenialReason('code_not_found')).toBe('invalid_or_expired_code');
  });

  it('names every refusal that already required a real code', () => {
    // These are only reachable once an enrollment row was found by its hash, so
    // the caller already holds a valid code and the name tells them nothing
    // they did not bring with them.
    for (const reason of [
      'code_expired',
      'code_consumed',
      'code_revoked',
      'machine_conflict',
      'device_revoked',
      'client_ineligible',
      'credential_conflict',
      'nonce_or_credential_conflict',
    ]) {
      expect(publicDenialReason(reason)).toBe(reason);
    }
  });

  it('names machine_conflict, which no new code can fix', () => {
    // The one that cost the desk an afternoon: the VPS already has an active
    // device, so every regenerated code fails the same way.
    expect(publicDenialReason('machine_conflict')).toBe('machine_conflict');
  });
});
