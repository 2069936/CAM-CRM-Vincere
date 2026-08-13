import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CamFlagQueue from './CamFlagQueue';
import { buildCamFlagQueue, createCamFlagResolver } from '../domain/camFlagQueue';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

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

    expect(calls).toEqual([
      { clientId: 'client-1', importId: 'imp-0715', flagId: 'f-0715', status: 'Resolved' },
      { clientId: 'client-1', importId: 'imp-0721', flagId: 'f-0721', status: 'Resolved' },
    ]);
    // The day a CAM lands on. handleResolveFlag would have sent this import's
    // id, or — because the picker opens on today and the book ends 2026-07-30 —
    // nothing at all.
    expect(calls.some((call) => call.importId === 'imp-0730')).toBe(false);
    expect(calls.some((call) => call.flagId === 'f-0730')).toBe(false);
  });

  it('acknowledges under the same ids and a different status', () => {
    const calls = [];
    const tree = CamFlagQueue({
      clients: strandedBook(),
      today: TODAY,
      onResolveFlag: (clientId, importId, flagId, status) => calls.push({ clientId, importId, flagId, status }),
    });
    buttons(tree, 'acknowledge-row')
      .find((node) => node.props['data-row-key'].includes('Missing account'))
      .props.onClick();

    expect(calls).toEqual([
      { clientId: 'client-1', importId: 'imp-0730', flagId: 'f-0730', status: 'Acknowledged' },
    ]);
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

/* ── The real book ────────────────────────────────────────────────────────── */

describe('rendered against the real book', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const state = buildCrmStateFromTables(snapshot.tables);
  const clientById = Object.fromEntries(state.clients.map((client) => [client.id, client]));
  const camClients = (name) => {
    const cam = state.camProfiles.find((profile) => profile.name === name);
    return (cam.clientIds || []).map((id) => clientById[id]).filter(Boolean);
  };

  const ellis = camClients('Ellis Glen');
  const html = renderToStaticMarkup(
    <CamFlagQueue clients={ellis} today={TODAY} onResolveFlag={() => {}} />,
  );

  it('renders every one of the 149 problems Ellis Glen holds — none folded away', () => {
    // Ellis Glen has 315 open flag records; nothing on any screen today can
    // reach any of them, because zero sit on a client's latest close.
    expect(countOf(html, /<tr data-row-key=/g)).toBe(149);
    expect(countOf(html, /data-action="resolve-row"/g)).toBe(149);
    expect(countOf(html, /data-action="resolve-group"/g)).toBe(51);
  });

  it('states the same counts in prose that it renders as rows', () => {
    const text = strip(html);
    expect(text).toContain('149 open · 59 critical');
    expect(text).toContain('149 problems across 10 clients, held in 315 flag records');
    expect(text).toContain('149 of them are no longer on their client');
    expect(countOf(html, /<tr data-row-key=/g)).toBe(149);
  });

  it('counts each group in problems, the same unit as the rows under it', () => {
    // The group summary is the one place the two units sit next to each other,
    // and it survived a green suite reading either. Ellis Glen's widest group —
    // "Expected strategy missing" on Harper Juniper — is 19 problems held on 46
    // records, and the heading is about what the CAM has to look at, so it says
    // 19. Printing 46 there is the 1,900-against-a-header-reading-253 defect at
    // group scale; the record count has its own sentence on the button below.
    const text = strip(html);
    expect(text).toContain('Expected strategy missing Harper Juniper · 19 flags · 19 critical');
    expect(text).not.toContain('Expected strategy missing Harper Juniper · 46 flags');

    // And it holds across all 51 groups: the header counts sum to the 149
    // problems the panel claims in prose, never to the 315 records behind them.
    const headings = [...text.matchAll(/· (\d+) flags? ·/g)].map((match) => Number(match[1]));
    expect(headings).toHaveLength(51);
    expect(headings.reduce((sum, count) => sum + count, 0)).toBe(149);
  });

  it('reads its ages against a stated anchor and a stated last close', () => {
    const text = strip(html);
    // Every row is 14+ days old because the export stops twelve days before the
    // anchor. Printing the buckets without both dates would read as a book
    // where nothing is ever caught the same week.
    expect(text).toContain('Age counted to 2026-08-11, latest close in the book 2026-07-30');
    expect(text).toContain('Today 0 · 1-6 days 0 · 7-13 days 0 · 14+ days 149 · Not measured 0');
    expect(text).toContain('oldest 27d');
  });

  it('every button on the page carries a real (client, import, flag) triple', () => {
    const tree = CamFlagQueue({ clients: ellis, today: TODAY, onResolveFlag: () => {} });
    const calls = [];
    const live = CamFlagQueue({
      clients: ellis,
      today: TODAY,
      onResolveFlag: (clientId, importId, flagId, status) => calls.push({ clientId, importId, flagId, status }),
    });
    expect(buttons(tree, 'resolve-row')).toHaveLength(149);

    for (const button of buttons(live, 'resolve-row')) button.props.onClick();

    // 149 problems, 315 records: one write per record, each on its own import.
    expect(calls).toHaveLength(315);
    for (const call of calls) {
      const client = clientById[call.clientId];
      const entry = (client.dailyImports || []).find((di) => di.id === call.importId);
      expect(entry).toBeTruthy();
      expect((entry.flags || []).some((f) => f.id === call.flagId)).toBe(true);
      expect(call.status).toBe('Resolved');
    }
    // No client's latest close appears, because Ellis Glen has nothing open on
    // one — the whole reason this queue exists.
    const latestIds = new Set(ellis.map((client) => client.dailyImports?.at(-1)?.id));
    expect(calls.some((call) => latestIds.has(call.importId))).toBe(false);
  });

  it('matches the domain model it renders, for the CAM with the largest book', () => {
    const marlow = camClients('Marlow Cedar');
    const model = buildCamFlagQueue(marlow, { today: TODAY });
    const marlowHtml = renderToStaticMarkup(
      <CamFlagQueue clients={marlow} today={TODAY} onResolveFlag={() => {}} />,
    );
    expect(model.totals.rows).toBe(242);
    expect(model.totals.occurrences).toBe(908);
    expect(countOf(marlowHtml, /<tr data-row-key=/g)).toBe(model.totals.rows);
    expect(countOf(marlowHtml, /data-action="resolve-group"/g)).toBe(model.totals.groups);
    expect(strip(marlowHtml)).toContain('242 problems across 11 clients, held in 908 flag records');
  });
  it('closes the flag that was clicked, not the client or the day on screen', () => {
    // The data-destroying shape this whole module exists to avoid: a CAM stood
    // on client A at date X presses Resolve on a row belonging to client B at
    // date Y. Driven end to end through the resolver App.jsx actually wires, so
    // what is asserted is what reaches updateSupabaseOperationalFlag.
    const selectedClient = ellis[0];
    const selectedImportId = selectedClient.dailyImports?.at(-1)?.id;

    const writes = [];
    let live = state;
    const resolver = createCamFlagResolver({
      setState: (fn) => { live = fn(live); },
      updateFlag: (flagId, status) => { writes.push({ flagId, status }); return Promise.resolve(null); },
    });

    const queue = buildCamFlagQueue(ellis, { today: TODAY });
    const target = queue.groups
      .flatMap((group) => group.rows)
      .find((row) => row.clientId !== selectedClient.id && !row.onLatestClose && row.occurrences.length >= 3);
    expect(target).toBeTruthy();

    const tree = CamFlagQueue({ clients: ellis, today: TODAY, queue, onResolveFlag: resolver });
    const button = buttons(tree, 'resolve-row').find((node) => node.props['data-row-key'] === target.key);
    button.props.onClick();

    // One write per open record, all of them the target's own uuids.
    expect(writes.map((write) => write.flagId).sort())
      .toEqual(target.occurrences.map((occurrence) => occurrence.flagId).sort());

    // The target's records really moved, on their own imports.
    const patchedTarget = live.clients.find((client) => client.id === target.clientId);
    for (const occurrence of target.occurrences) {
      const entry = patchedTarget.dailyImports.find((di) => di.id === occurrence.importId);
      expect(entry.flags.find((flag) => flag.id === occurrence.flagId).status).toBe('Resolved');
    }

    // And nothing on the client or the import the CAM was standing on did.
    const openOf = (client) => (client.dailyImports || [])
      .flatMap((di) => di.flags || [])
      .filter((flag) => (flag.status || 'Open') === 'Open').length;
    const patchedSelected = live.clients.find((client) => client.id === selectedClient.id);
    expect(openOf(patchedSelected)).toBe(openOf(selectedClient));
    expect(writes.some((write) => write.flagId === selectedImportId)).toBe(false);
  });
  it('says how many records a group button will write, not just how many rows', () => {
    // Oakley Larch's "Missing account" group is 14 problems held on 98 flag
    // rows, so "Resolve all 14" fires 98 patches. The label alone understates
    // what one click does by 84 writes.
    const oakley = camClients('Oakley Ash');
    const model = buildCamFlagQueue(oakley, { today: TODAY });
    const widest = model.groups.reduce((worst, group) => (
      group.occurrences - group.total > worst.occurrences - worst.total ? group : worst
    ), model.groups[0]);
    expect(widest.occurrences).toBeGreaterThan(widest.total);

    const text = strip(renderToStaticMarkup(
      <CamFlagQueue clients={oakley} today={TODAY} queue={model} onResolveFlag={() => {}} defaultOpenGroups={999} />,
    ));
    expect(text).toContain(
      `writes ${widest.occurrences} flag records — these ${widest.total} problems are held on ${widest.occurrences} rows`,
    );

    // And the count on the button is the count the click actually makes.
    const calls = [];
    const tree = CamFlagQueue({
      clients: oakley,
      today: TODAY,
      queue: model,
      onResolveFlag: (clientId, importId, flagId) => calls.push({ clientId, importId, flagId }),
    });
    buttons(tree, 'resolve-group')
      .find((node) => node.props['data-group-key'] === widest.key)
      .props.onClick();
    expect(calls).toHaveLength(widest.occurrences);
  });
});
