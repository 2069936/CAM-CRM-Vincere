import { createHmac } from 'node:crypto';
import process from 'node:process';

// Where the credential pepper comes from.
//
// The pepper hashes enrollment codes and device tokens. It has to be the same
// value on every request, on every serverless instance, across every deploy:
// a code issued under one value and redeemed under another simply does not
// verify, and a device paired under one stops authenticating under the next.
// That rules out generating one at startup, which is the obvious idea and the
// wrong one.
//
// INGEST_TOKEN_PEPPER is still the right way to set it, and it wins whenever it
// is present. But it was never set on this deployment, and pairing therefore had
// never worked at all: the desk could install an agent on a VPS and then had no
// way to connect it, with the CRM reporting only that setup was "temporarily
// unavailable". Waiting on a secret that only one person can create had blocked
// the feature for days.
//
// So when it is absent this derives one from SUPABASE_SERVICE_ROLE_KEY, which
// every deployment already has because apiAuth refuses to start without it.
// HMAC with a fixed, versioned domain string, so the value is deterministic,
// specific to this purpose, and not the service role key itself.
//
// WHAT THIS COSTS, stated plainly, because it is a real reduction.
//
// A pepper is meant to live outside the data it protects, so that a leaked
// database dump does not also hand over the means to verify its hashes. Deriving
// from the service role key keeps that property: the key lives in the
// deployment's environment, not in the database. What it gives up is
// independence. Anyone who obtains the service role key can now also derive the
// pepper, where before they would have needed two secrets rather than one. That
// matters less than it sounds here, because that key already grants full
// read/write access to every table, including the ability to insert a device
// row directly. An attacker holding it does not need to forge a token.
//
// TWO THINGS THAT WILL UNPAIR EVERY VPS, and there is no way to make them safe:
//   * rotating SUPABASE_SERVICE_ROLE_KEY while the derived pepper is in use;
//   * setting INGEST_TOKEN_PEPPER later, on a deployment that has been running
//     without it, because the explicit value takes over from the derived one.
// Either is a deliberate act. Both require re-pairing every machine afterwards.
export function resolveIngestPepper(env = process.env) {
  const configured = String(env?.INGEST_TOKEN_PEPPER || '').trim();
  if (configured) return configured;
  const serviceRoleKey = String(env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceRoleKey) return '';
  return createHmac('sha256', serviceRoleKey)
    .update('cam-crm:ingest-pepper:v1')
    .digest('hex');
}
