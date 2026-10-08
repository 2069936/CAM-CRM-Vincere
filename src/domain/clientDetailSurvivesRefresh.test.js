// The VPS and platform access block read full on the first paint, blanked on
// the reload a few seconds later, and stayed blank until the client was
// reopened in a fresh tab.
//
// A login carries no passwords and no prop firm logins: they are fetched when a
// client is opened and merged in with detailLoaded true. A wholesale reload
// (the manager Refresh button, the load after sign in) rebuilt every client
// from the login, with blank credentials and detailLoaded unset, and nothing
// put them back. carryTradeHistoryForward now carries the detail across the
// same way it carries the fills. Synthetic throughout.
import { describe, expect, it } from 'vitest';
import { carryTradeHistoryForward } from './refreshMerge';

const DETAIL = {
  credentials: { ip: '10.0.0.2', username: 'vps-user', password: 'secret', ntLogin: 'nt', ntPassword: 'nt-secret', firmLogin: '', firmPassword: '', notes: '' },
  propFirms: [{ id: 'pf-1', firmName: 'Firm A', connection: 'Tradovate', login: 'login-a', password: 'pw-a', sortOrder: 0 }],
  detailLoaded: true,
};
const BLANK = {
  credentials: { ip: '', username: '', password: '', ntLogin: '', ntPassword: '', firmLogin: '', firmPassword: '', notes: '' },
  propFirms: [],
};

const client = (id, extra = {}) => ({ id, uuid: `uuid-${id}`, name: `Client ${id}`, dailyImports: [], ...extra });
const state = (...clients) => ({ clients });

describe('a reload keeps the client detail this session already fetched', () => {
  it('carries credentials, prop firms and the loaded marker onto the reloaded client', () => {
    const current = state(client('a', DETAIL), client('b', BLANK));
    const next = state(client('a', BLANK), client('b', BLANK));
    const { state: merged } = carryTradeHistoryForward(current, next);
    const a = merged.clients.find((c) => c.id === 'a');
    expect(a.credentials).toEqual(DETAIL.credentials);
    expect(a.propFirms).toEqual(DETAIL.propFirms);
    expect(a.detailLoaded).toBe(true);
  });

  it('invents nothing for a client whose detail was never fetched', () => {
    const current = state(client('b', BLANK));
    const next = state(client('b', BLANK));
    const { state: merged } = carryTradeHistoryForward(current, next);
    const b = merged.clients.find((c) => c.id === 'b');
    expect(b.credentials).toEqual(BLANK.credentials);
    expect(b.propFirms).toEqual([]);
    expect(b.detailLoaded).toBeUndefined();
  });

  it('lets a reload that did carry the detail win over the stale copy', () => {
    const fresh = { ...DETAIL, credentials: { ...DETAIL.credentials, ip: '10.0.0.9' } };
    const current = state(client('a', DETAIL));
    const next = state(client('a', fresh));
    const { state: merged } = carryTradeHistoryForward(current, next);
    expect(merged.clients[0].credentials.ip).toBe('10.0.0.9');
  });

  it('matches by uuid when the reload renumbered the client', () => {
    const current = state({ ...client('a', DETAIL), uuid: 'uuid-x' });
    const next = state({ ...client('zz', BLANK), uuid: 'uuid-x' });
    const { state: merged } = carryTradeHistoryForward(current, next);
    expect(merged.clients[0].credentials).toEqual(DETAIL.credentials);
    expect(merged.clients[0].detailLoaded).toBe(true);
  });

  it('keeps the fills carry-over working beside it', () => {
    const day = { id: 'd1', uuid: 'd1', date: '2026-10-07', orders: [{ id: 'o1' }], executions: [{ id: 'e1' }], detailLoaded: true };
    const current = state(client('a', { ...DETAIL, dailyImports: [day] }));
    const next = state(client('a', { ...BLANK, dailyImports: [{ ...day, orders: [], executions: [], detailLoaded: false }] }));
    const { state: merged, missingImportIds } = carryTradeHistoryForward(current, next);
    expect(merged.clients[0].dailyImports[0].orders).toEqual([{ id: 'o1' }]);
    expect(merged.clients[0].credentials).toEqual(DETAIL.credentials);
    expect(missingImportIds).toEqual([]);
  });
});
