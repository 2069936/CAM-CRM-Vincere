import { describe, expect, it } from 'vitest';
import { resolveIngestHandler } from './[action].js';

describe('ingest route dispatcher', () => {
  it.each(['daily', 'heartbeat', 'pair'])('preserves /api/ingest/%s', (action) => {
    expect(resolveIngestHandler(action)).toEqual(expect.any(Function));
  });

  it('does not dispatch unknown paths', () => {
    expect(resolveIngestHandler('unknown')).toBeNull();
  });
});
