// The book-backed half of CamFlagQueue's component suite.
//
// Split out from CamFlagQueue.test.jsx, which vite.config.js was dropping whole
// on every clone without public/local-snapshot.json — taking the synthetic
// fixtures beside it out of CI for no reason. The rules and the button
// inventory live in the sibling and run everywhere; the NUMBERS live here,
// where the book is.

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
      // The status is the resolver's to decide, not the button's — see
      // camFlagQueue.test.js, 'writes Resolved whatever a caller tries to hand
      // it'. All 315 of these carry three ids and nothing else.
      expect(call.status).toBeUndefined();
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

/* ── The evidence read back onto a Missing account row ─────────────────────── */

/**
 * The flag says "<alias> existed before but did not appear in this close" and
 * nothing else, which is why 106 of them are open on this book across 19 clients
 * in 309 records and nobody works them. Everything needed to separate them is in
 * account_snapshots; these assertions are about it reaching the row.
 */
describe('Missing account evidence', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const { clients } = buildCrmStateFromTables(snapshot.tables);
  const only = (name, minAccounts) => clients.filter(
    (client) => client.name === name
      && Object.keys(client.accountRegistry || {}).length >= minAccounts,
  );

  // 14 problems on one client, the largest Missing account group on the book.
  const oakley = only('Oakley Larch', 10);
  const html = renderToStaticMarkup(
    <CamFlagQueue clients={oakley} today={TODAY} onResolveFlag={() => {}} defaultOpenGroups={999} />,
  );

  it('puts the last close, the reading then, the balance then and the gap on the row', () => {
    expect(strip(html)).toContain(
      'Healthy when it went quiet. Last seen 2026-07-13 with $2,171 of buffer left on a $148,223 balance — absent for the 7 closes since.',
    );
    expect(strip(html)).toContain(
      'Past its drawdown when it went quiet. Last seen 2026-07-22 already $20 past its trailing drawdown on a $47,980 balance — absent for the 6 closes since.',
    );
  });

  it('renders the two shapes as visually different rows', () => {
    expect(countOf(html, /class="flag-evidence flag-evidence-past"/g)).toBe(2);
    expect(countOf(html, /class="flag-evidence flag-evidence-healthy"/g)).toBe(12);
    // And never as a verdict.
    expect(strip(html).toLowerCase()).not.toContain('failed account');
    for (const line of html.match(/<span class="flag-evidence[^"]*"[^>]*>.*?<\/span>/g) || []) {
      expect(line.toLowerCase()).not.toMatch(/\bfail(ed|s|ure)?\b/);
    }
  });

  it('leaves the flag’s own stored message on the row rather than replacing it', () => {
    // The redacted book stores every message as `[redacted <length>]`. The point
    // is that it is still there: the evidence is a second line under what was
    // written at the time, never a rewrite of it.
    expect(countOf(html, /class="flag-evidence/g)).toBe(14);
    expect(countOf(html, /\[redacted \d+\]<span class="flag-evidence/g)).toBe(14);
  });

  /**
   * A third of the queue is flags with nothing behind them, and this is the one
   * that would be hardest to believe without the read-back: reconcile.js sweeps
   * the registry AS IT STANDS TODAY against a close from weeks ago and applies
   * no existence rule, so a row added on 2026-07-16 raises a Missing account
   * flag on the 2026-07-13 close.
   */
  it('says when a flag stands on a close its account did not exist on', () => {
    const reese = only('Reese North', 5);
    const text = strip(renderToStaticMarkup(
      <CamFlagQueue clients={reese} today={TODAY} onResolveFlag={() => {}} defaultOpenGroups={999} />,
    ));
    expect(text).toContain(
      "Did not exist on that close. This account's earliest provable existence date is 2026-07-16 (date_added), after the 2026-07-13 close the flag stands on. It could not have appeared in it.",
    );
    // The collection fact travels beside it, never instead of it.
    expect(text).toContain('The 2026-07-13 close for this client carried no account rows at all.');
  });

  it('says when the account the flag names is reporting again', () => {
    const jordan = only('Jordan Cedar', 5);
    const text = strip(renderToStaticMarkup(
      <CamFlagQueue clients={jordan} today={TODAY} onResolveFlag={() => {}} defaultOpenGroups={999} />,
    ));
    expect(text).toContain(
      "Reporting again. Reported again on 2026-07-30, this client's latest close. Nothing is missing now.",
    );
    expect(text).toContain('Never seen in any close.');
  });

  it('adds nothing to a flag type it has no evidence for', () => {
    const other = renderToStaticMarkup(
      <CamFlagQueue clients={oakley} today={TODAY} onResolveFlag={() => {}} defaultOpenGroups={999} />,
    );
    // Every evidence line sits inside a Missing account group and nowhere else.
    const missingGroupRows = countOf(other, /<tr data-row-key=/g);
    expect(countOf(other, /class="flag-evidence/g)).toBeLessThan(missingGroupRows);
  });
});
