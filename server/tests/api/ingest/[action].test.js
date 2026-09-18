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

  it.each(['daily', 'heartbeat', 'pair'])('preserves /api/ingest/%s', (action) => {
    expect(resolveIngestHandler(action)).toEqual(expect.any(Function));
  });

  it('does not dispatch unknown paths', () => {
    expect(resolveIngestHandler('unknown')).toBeNull();
  });
});
