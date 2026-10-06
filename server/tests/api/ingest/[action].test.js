import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { resolveIngestHandler } from '../../../../api/ingest/[action].js';

describe('ingest route dispatcher', () => {
  it('loads in native Node ESM, as it does in the Vercel function', () => {
    const routeUrl = new URL('../../../../api/ingest/[action].js', import.meta.url).href;
    expect(() => execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(routeUrl)})`,
    ])).not.toThrow();
  });

  it.each(['accounts', 'daily', 'heartbeat', 'pair', 'quarantine', 'report-email'])('preserves /api/ingest/%s', (action) => {
    expect(resolveIngestHandler(action)).toEqual(expect.any(Function));
  });

  it('dispatches /api/ingest/strategies to its own handler, leaving /accounts as it was', async () => {
    const strategies = (await import('../../../autoCollection/ingest/strategies.js')).default;
    const accounts = (await import('../../../autoCollection/ingest/accounts.js')).default;
    expect(resolveIngestHandler('strategies')).toBe(strategies);
    expect(resolveIngestHandler('accounts')).toBe(accounts);
    expect(strategies).not.toBe(accounts);
  });

  it('does not dispatch unknown paths', () => {
    expect(resolveIngestHandler('unknown')).toBeNull();
  });
});
