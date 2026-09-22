// Not loaded is not empty, and a book-wide probe cannot tell them apart.
//
// THE DEFECT THIS PINS. accountLifecycle.js and StackPlaybook.jsx each asked
// "does ANY close anywhere carry a fill" and called the answer "trade history
// has loaded". That was correct while the whole trade history arrived in one
// pass after the dashboard shell: one fill anywhere meant every fill
// everywhere.
//
// It stopped being correct the moment a login started carrying the executions
// of each client's LATEST close and of no other. The old probe then answers
// "loaded" over a book where 2,379 of 2,585 closes hold nothing — and both
// surfaces would drop the sentence that says their figures are reading the
// strategy grid alone, at exactly the point where it became most true. The
// lifecycle panel would go further and report accounts as "never traded".

import { describe, expect, it } from 'vitest';
import { closesAwaitingFills, fillsLoadedAcross, fillsLoadedFor } from './closeLoadState';

const close = (overrides = {}) => ({
  id: 'i1', uuid: 'u1', date: '2026-09-22', orders: [], executions: [], ...overrides,
});

describe('one close', () => {
  it('believes the close when it says so', () => {
    expect(fillsLoadedFor(close({ detailLoaded: true }))).toBe(true);
    // A close that says its fills are not loaded is not loaded EVEN IF it
    // carries rows: the login brings each client's latest close executions and
    // no orders at all, so "has an execution" is not "has its fills".
    expect(fillsLoadedFor(close({ detailLoaded: false, executions: [{ id: 'e' }] }))).toBe(false);
  });

  it('falls back to the old evidence on a close that does not say', () => {
    // Fixtures written before the field existed, and every test in this tree
    // that builds a close by hand. Nothing that used to answer "loaded" now
    // answers "not".
    expect(fillsLoadedFor(close({ orders: [{ id: 'o' }] }))).toBe(true);
    expect(fillsLoadedFor(close({ simulation: { orders: [{ id: 'o' }] } }))).toBe(true);
    expect(fillsLoadedFor(close())).toBe(false);
  });
});

describe('a whole book', () => {
  const client = (closes) => ({ id: 'c1', dailyImports: closes });

  it('is loaded only when every close is', () => {
    // Unanimous on purpose. A panel that says "reading the strategy grid alone"
    // while 205 of 206 closes have their fills is saying something almost
    // untrue; a panel that says nothing while 2,379 closes are missing theirs
    // is saying something entirely untrue, and that is the one that costs money.
    expect(fillsLoadedAcross([client([
      close({ detailLoaded: true }), close({ detailLoaded: true }),
    ])])).toBe(true);
    expect(fillsLoadedAcross([client([
      close({ detailLoaded: true }), close({ detailLoaded: false }),
    ])])).toBe(false);
  });

  it('is the login shape, and it is not loaded', () => {
    // What a login actually hands over: every close's date, the latest one's
    // executions, no orders anywhere. The probe this replaces answered `true`
    // to this book.
    const book = [client([
      close({ id: 'old', detailLoaded: false }),
      close({ id: 'latest', detailLoaded: false, executions: [{ id: 'e' }] }),
    ])];
    expect(fillsLoadedAcross(book)).toBe(false);
  });

  it('is not loaded when there is nothing to load either', () => {
    // An empty book is not a loaded book. Reporting it as loaded would let a
    // panel state a finding over no data at all.
    expect(fillsLoadedAcross([])).toBe(false);
    expect(fillsLoadedAcross([client([])])).toBe(false);
  });
});

describe('which closes still need their fills', () => {
  it('names them, newest last, inside the window asked for', () => {
    const book = [{
      id: 'c1',
      dailyImports: [
        close({ uuid: 'u-jul', date: '2026-07-01', detailLoaded: false }),
        close({ uuid: 'u-sep-1', date: '2026-09-20', detailLoaded: false }),
        close({ uuid: 'u-sep-2', date: '2026-09-21', detailLoaded: true }),
        close({ uuid: 'u-sep-3', date: '2026-09-22', detailLoaded: false }),
      ],
    }];
    expect(closesAwaitingFills(book)).toEqual(['u-jul', 'u-sep-1', 'u-sep-3']);
    expect(closesAwaitingFills(book, { from: '2026-09-01' })).toEqual(['u-sep-1', 'u-sep-3']);
    expect(closesAwaitingFills(book, { from: '2026-09-01', to: '2026-09-21' })).toEqual(['u-sep-1']);
  });
});
