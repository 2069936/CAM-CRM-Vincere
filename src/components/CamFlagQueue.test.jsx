// The synthetic half of CamFlagQueue's component suite.
//
// It was ONE file until now, and the whole thing was listed in
// `localSnapshotTests` because its second half reads
// public/local-snapshot.json — so every case below was dropped on CI along with
// it. That is the exact defect vite.config.js carries an essay about: the
// fixtures here need no book, they pin what a click sends and which buttons
// exist at all, and a guard only CI's one machine-with-the-export can run is
// not a guard. The book-backed half now lives in CamFlagQueue.book.test.jsx and
// is the only one on the list.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CamFlagQueue from './CamFlagQueue';

const TODAY = '2026-08-11';

/**
 * The component has no state, so it can be called as a plain function and its
 * buttons fired without a DOM. That is deliberate: the defect this replaces is
 * about which ids a click sends, and rendered HTML cannot show that. Anything
 * that needed useState here would have to be tested by trusting the markup.
 */
function elements(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node.props) {
    out.push(node);
    elements(node.props.children, out);
  }
  return out;
}

const buttons = (tree, action) => elements(tree).filter(
  (node) => node.type === 'button' && node.props['data-action'] === action,
);

const strip = (html) => String(html)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&rarr;|→/g, '→')
  .replace(/\s+/g, ' ')
  .trim();

const countOf = (html, pattern) => (html.match(pattern) || []).length;

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function flag(id, overrides = {}) {
  return {
    id,
    type: 'Strategy disabled',
    severity: 'Warning',
    accountName: 'ACC-1',
    message: 'Strategy Bullet 3.2 is disabled on ACC-1',
    status: 'Open',
    ...overrides,
  };
}

/** A problem open on two old closes and gone from the newest — the shape of
 * 1,102 of the 1,952 open rows in the book. */
const strandedBook = () => [
  {
    id: 'client-1',
    name: 'Harper Juniper',
    dailyImports: [
      { id: 'imp-0715', date: '2026-07-15', flags: [flag('f-0715')] },
      { id: 'imp-0721', date: '2026-07-21', flags: [flag('f-0721')] },
      {
        id: 'imp-0730',
        date: '2026-07-30',
        flags: [flag('f-0730', { type: 'Missing account', accountName: 'ACC-9', message: 'ACC-9 has no upload' })],
      },
    ],
  },
];

/* ── The defect ───────────────────────────────────────────────────────────── */

describe('a click resolves the flag it was clicked on', () => {
  it('sends the flag id, client id and import id of the row, not of the latest close', () => {
    const calls = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: (clientId, importId, flagId, status) => calls.push({ clientId, importId, flagId, status }),
    });

    const stranded = buttons(tree, 'resolve-row').find(
      (node) => node.props['data-row-key'].includes('Strategy disabled'),
    );
    stranded.props.onClick();

    // Three arguments, no status: Resolve is the only action left on a flag, so
    // the fourth is captured as undefined rather than being sent.
    expect(calls).toEqual([
      { clientId: 'client-1', importId: 'imp-0715', flagId: 'f-0715', status: undefined },
      { clientId: 'client-1', importId: 'imp-0721', flagId: 'f-0721', status: undefined },
    ]);
    // The day a CAM lands on. handleResolveFlag would have sent this import's
    // id, or — because the picker opens on today and the book ends 2026-07-30 —
    // nothing at all.
    expect(calls.some((call) => call.importId === 'imp-0730')).toBe(false);
    expect(calls.some((call) => call.flagId === 'f-0730')).toBe(false);
  });

  it('offers no Acknowledge button, on a row or on a group', () => {
    // It used to: every row carried Resolve and Acknowledge side by side, and
    // every group carried "Resolve all N" and "Acknowledge all N". The desk
    // manager wanted one way to close a flag. Asserted on the rendered tree
    // rather than by reading the source, because a button that is rendered is a
    // status that can still be written.
    const tree = CamFlagQueue({ clients: strandedBook(), today: TODAY, onResolveFlag: () => {} });
    expect(buttons(tree, 'resolve-row').length).toBeGreaterThan(0);
    expect(buttons(tree, 'resolve-group').length).toBeGreaterThan(0);
    expect(buttons(tree, 'acknowledge-row')).toEqual([]);
    expect(buttons(tree, 'acknowledge-group')).toEqual([]);

    const html = renderToStaticMarkup(
      <CamFlagQueue clients={strandedBook()} today={TODAY} onResolveFlag={() => {}} defaultOpenGroups={999} />,
    );
    expect(html).not.toMatch(/Acknowledge/i);
    expect(html).toContain('Resolve');
  });

  it('clears a whole run in one click, each record naming its own import', () => {
    const calls = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: (clientId, importId, flagId, status) => calls.push({ clientId, importId, flagId, status }),
    });
    buttons(tree, 'resolve-group')[0].props.onClick();

    expect(calls.map((call) => `${call.importId}/${call.flagId}`)).toEqual([
      'imp-0715/f-0715',
      'imp-0721/f-0721',
    ]);
  });

  it('logs the resolution on the client, naming the close it was raised on', () => {
    const logged = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: () => {},
      onLogClientActivity: (clientId, entry) => logged.push({ clientId, entry }),
    });
    buttons(tree, 'resolve-row')
      .find((node) => node.props['data-row-key'].includes('Strategy disabled'))
      .props.onClick();

    expect(logged).toHaveLength(1);
    expect(logged[0].clientId).toBe('client-1');
    expect(logged[0].entry.text).toBe(
      'Flag resolved: [Strategy disabled] Strategy Bullet 3.2 is disabled on ACC-1 (raised 2026-07-15)',
    );
  });

  it('writes one summary line for a group, not one per row', () => {
    const logged = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: () => {},
      onLogClientActivity: (clientId, entry) => logged.push(entry),
    });
    buttons(tree, 'resolve-group')[0].props.onClick();
    expect(logged).toHaveLength(1);
    expect(logged[0].text).toContain('Bulk resolved 1 flag [Strategy disabled] raised 2026-07-15 → 2026-07-21');
  });

  it('does nothing at all without a resolve callback, rather than half-acting', () => {
    const logged = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: null,
      onLogClientActivity: (clientId, entry) => logged.push(entry),
    });
    buttons(tree, 'resolve-row')[0].props.onClick();
    expect(logged).toHaveLength(0);
  });
});

/* ── What it puts on the screen ───────────────────────────────────────────── */

describe('what the queue says', () => {
  it('names the client and the close for every row, because the CAM is not standing on that day', () => {
    const html = renderToStaticMarkup(
      <CamFlagQueue clients={strandedBook()} today={TODAY} onResolveFlag={() => {}} />,
    );
    const text = strip(html);
    expect(text).toContain('Harper Juniper · 2026-07-15 → 2026-07-21');
    expect(text).toContain('2 records');
    expect(text).toContain('behind 2026-07-30');
    expect(text).toContain('27d');
  });

  it('prints an unmeasurable age as "not measured", never as 0d', () => {
    const clients = [
      {
        id: 'client-2',
        name: 'Gray Elm',
        dailyImports: [{ id: 'imp-x', date: 'unknown', flags: [flag('f-x')] }],
      },
    ];
    const html = renderToStaticMarkup(
      <CamFlagQueue clients={clients} today={TODAY} onResolveFlag={() => {}} />,
    );
    const text = strip(html);
    expect(text).toContain('not measured');
    expect(text).not.toContain('0d');
    // And the flag is still here to be closed: an unreadable date is not a
    // reason to hide a client's flag from the only screen that can close it.
    expect(countOf(html, /data-action="resolve-row"/g)).toBe(1);
  });

  it('says there is nothing open instead of drawing an empty table', () => {
    const html = renderToStaticMarkup(
      <CamFlagQueue clients={[]} today={TODAY} onResolveFlag={() => {}} />,
    );
    expect(strip(html)).toContain('Nothing open across 0 clients');
    expect(countOf(html, /data-action="resolve-row"/g)).toBe(0);
  });
});
