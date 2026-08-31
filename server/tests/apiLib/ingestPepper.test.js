import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';

// The pepper has one non negotiable property: the same value on every instance,
// every request and every deploy. A code issued under one value and redeemed
// under another does not verify, and a paired VPS stops authenticating. These
// tests exist to hold that property, and to hold the precedence that decides
// which value is in force.
describe('resolveIngestPepper', () => {
  it('uses the configured secret when there is one', () => {
    const pepper = resolveIngestPepper({
      INGEST_TOKEN_PEPPER: 'configured secret',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    });

    expect(pepper).toBe('configured secret');
  });

  it('ignores a blank configured secret rather than hashing with nothing', () => {
    const pepper = resolveIngestPepper({
      INGEST_TOKEN_PEPPER: '   ',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    });

    expect(pepper).not.toBe('   ');
    expect(pepper.length).toBeGreaterThan(0);
  });

  it('derives a stable value when the secret was never set', () => {
    // Deterministic is the whole point. This deployment ran without
    // INGEST_TOKEN_PEPPER and pairing could never work; deriving fixes that only
    // if the derived value is identical on every cold start.
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };

    expect(resolveIngestPepper(env)).toBe(resolveIngestPepper({ ...env }));
    expect(resolveIngestPepper(env)).toBe(
      createHmac('sha256', 'service-role-key').update('cam-crm:ingest-pepper:v1').digest('hex'),
    );
  });

  it('never returns the service role key itself', () => {
    const key = 'service-role-key';

    expect(resolveIngestPepper({ SUPABASE_SERVICE_ROLE_KEY: key })).not.toBe(key);
    expect(resolveIngestPepper({ SUPABASE_SERVICE_ROLE_KEY: key })).not.toContain(key);
  });

  it('separates deployments, so one cannot verify another deployment credentials', () => {
    const a = resolveIngestPepper({ SUPABASE_SERVICE_ROLE_KEY: 'key-a' });
    const b = resolveIngestPepper({ SUPABASE_SERVICE_ROLE_KEY: 'key-b' });

    expect(a).not.toBe(b);
  });

  it('returns nothing when there is no source at all, so the caller can refuse', () => {
    // Callers answer 503 collector_not_configured on a blank pepper. Returning a
    // fabricated value here would let hashing proceed under a secret nobody
    // chose, which is worse than refusing.
    expect(resolveIngestPepper({})).toBe('');
  });
});
