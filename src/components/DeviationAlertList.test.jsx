// The deviation alert the manager asked for, and the single computation behind it.
//
// One already existed per-CAM on the CAM overview. The manager wanted the
// consolidated view to have one too, and the instruction with it was explicit:
// reuse the existing computation rather than writing a second one that can
// disagree with it. That is what this file pins, from both ends —
//
//   * buildCamOverview in src/domain/camOverview.js is the ONLY producer of
//     deviation flags in the tree. A second one is how a manager and a CAM end
//     up looking at the same account and disagreeing about whether it is the
//     odd one out.
//   * DeviationAlertList is the only renderer, so the wording of an alert cannot
//     differ between the two screens either. It used to be JSX inlined in
//     CamOverview; copying that JSX into ManagerOverview would have been the
//     easy version of the same mistake, one level down from the computation.
//
// And the per-CAM panel STAYS — the CAM was asked directly, because his
// dictation was contradictory, and chose "add it to the manager view, and remove
// lifecycle by algo". Removing his is a different decision that nobody made.
//
// Synthetic fixtures only, so CI pins it. The desk-wide NUMBERS — 74 against the
// eight CAM views' 30 — are in src/domain/camOverview.book.test.js.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DeviationAlertList from './DeviationAlertList';
import { buildCamOverview } from '../domain/camOverview';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const APP = readFileSync(join(ROOT, 'src/App.jsx'), 'utf8');

const strip = (html) => String(html)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/* ── One computation ──────────────────────────────────────────────────────── */

function sourceFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFilesUnder(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(relative(ROOT, full));
    }
  }
  return out;
}

describe('there is one deviation computation and one deviation row', () => {
  it('is produced in camOverview.js and nowhere else', () => {
    // `deviationFlags:` is the key that creates the list. Reading it is fine
    // anywhere; producing it is not.
    const producers = sourceFilesUnder(join(ROOT, 'src'))
      .filter((file) => /deviationFlags\s*:/.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(producers).toEqual(['src/domain/camOverview.js']);
  });

  it('is rendered through the shared list on both screens', () => {
    // Two call sites, one component. If either screen goes back to inlining the
    // rows, the two can word the same alert differently.
    expect((APP.match(/<DeviationAlertList/g) || []).length).toBe(2);
    expect(APP).toContain('import DeviationAlertList from "./components/DeviationAlertList"');
    // And neither screen reaches past it to hand-roll a row.
    expect(APP).not.toContain('No cross-account deviation alerts');
  });

  it('gives the manager view its own call to the same builder', () => {
    // ManagerOverview passes every client; CamOverview passes the CAM's book.
    // Same function, different book — which is the whole reason the two counts
    // differ and why the panel reconciles them on screen.
    expect((APP.match(/buildCamOverview\(/g) || []).length).toBe(3);
    expect(APP).toContain('const deskDeviation = useMemo(() => buildCamOverview(clients), [clients]);');
  });

  it('compares against each CAM\'s book the same way the rest of the page scopes one', () => {
    // The reconciliation sentence counts what the CAM overviews show, so it has
    // to resolve a CAM's book through clientsForCam like `cams` and `camDesks`
    // above it — coverage included. Reading profile.clientIds directly is a
    // no-op on an export with no coverage rows and wrong the first time somebody
    // goes on leave, which is the kind of drift no book test would catch.
    expect(APP).toContain('const book = clientsForCam(clients, profile, coverage, asOfDate);');
    expect(APP).toContain('for (const flag of buildCamOverview(book).deviationFlags) {');
  });

  it('keeps the per-CAM panel the CAM asked to keep', () => {
    expect(APP).toContain('<DeviationAlertList flags={overview.deviationFlags} />');
    expect(APP).toContain('title="Deviation alerts"');
  });
});

/* ── One row ──────────────────────────────────────────────────────────────── */

const peerFlag = (overrides = {}) => ({
  id: 'cam-deviation-RBO 1.8-client-b-ACC3',
  severity: 'Warning',
  clientId: 'client-b',
  algorithm: 'RBO 1.8',
  clientName: 'Daniel',
  accountName: 'ACC3',
  accountAlias: 'Lucid - 1003',
  message: 'Daniel · Lucid - 1003 is below peer performance for RBO 1.8.',
  realized: -140,
  threshold: -21.25,
  ...overrides,
});

describe('DeviationAlertList', () => {
  it('says nothing is wrong rather than drawing an empty list', () => {
    const html = renderToStaticMarkup(<DeviationAlertList flags={[]} />);
    expect(strip(html)).toContain('No cross-account deviation alerts');
  });

  it('prints the algorithm, the message and the realized figure', () => {
    const text = strip(renderToStaticMarkup(<DeviationAlertList flags={[peerFlag()]} />));
    expect(text).toContain('RBO 1.8');
    expect(text).toContain('Daniel · Lucid - 1003 is below peer performance for RBO 1.8.');
    // formatCurrency rounds to whole dollars; this is the same helper the
    // rest of the app prints money with, not a second format.
    expect(text).toContain('Daily realized: -$140.');
  });

  it('adds the execution direction only when the alert carries one', () => {
    const drift = peerFlag({
      id: 'execution-drift-RBO 1.8-MNQ-client-b-ACC3',
      executionMove: -8,
      peerDirection: 'up',
      message: 'Daniel · Lucid - 1003 moved opposite to peer executions for MNQ.',
    });
    expect(strip(renderToStaticMarkup(<DeviationAlertList flags={[drift]} />)))
      .toContain('Execution move: -8.00 vs peer direction up');
    // A peer-performance alert has no executionMove at all, and must not be
    // given one: `flag.executionMove > 0 ? '+' : ''` on undefined would print
    // "Execution move: NaN".
    expect(strip(renderToStaticMarkup(<DeviationAlertList flags={[peerFlag()]} />)))
      .not.toContain('Execution move');
  });

  it('attributes to a CAM on the manager view and to nobody on the CAM view', () => {
    // The one difference between the two screens. A CAM reading his own book
    // knows whose client it is; a manager reading the desk needs to know which
    // book each alert lands on before he can do anything with it.
    const withCam = strip(renderToStaticMarkup(
      <DeviationAlertList flags={[peerFlag()]} camNameByClientId={{ 'client-b': 'Oakley Ash' }} />,
    ));
    expect(withCam).toContain('CAM: Oakley Ash.');
    expect(strip(renderToStaticMarkup(<DeviationAlertList flags={[peerFlag()]} />)))
      .not.toContain('CAM:');
  });

  it('prints no attribution rather than guessing one for an unassigned client', () => {
    const html = strip(renderToStaticMarkup(
      <DeviationAlertList flags={[peerFlag()]} camNameByClientId={{ 'client-z': 'Someone Else' }} />,
    ));
    expect(html).not.toContain('CAM:');
    expect(html).not.toContain('Someone Else');
    expect(html).not.toContain('Unassigned');
  });

  it('renders the same alert identically however it was reached', () => {
    // The point of the shared component, asserted rather than assumed: the CAM
    // view's markup for one flag is the manager view's markup minus the CAM
    // sentence, character for character.
    const camView = renderToStaticMarkup(<DeviationAlertList flags={[peerFlag()]} />);
    const managerView = renderToStaticMarkup(
      <DeviationAlertList flags={[peerFlag()]} camNameByClientId={{ 'client-b': 'Oakley Ash' }} />,
    );
    expect(managerView.replace(' CAM: Oakley Ash.', '')).toBe(camView);
  });
});

/* ── The flag carries what the manager needs to route it ──────────────────── */

describe('a deviation flag names its client', () => {
  it('carries clientId rather than leaving it to be parsed back out of the id', () => {
    // Four accounts on one algorithm, one of them well under the peer mean —
    // the same shape as camOverview.test.js's own deviation fixture.
    const client = (id, name, accounts) => ({
      id,
      name,
      accountRegistry: Object.fromEntries(accounts.map(([a]) => [a, { alias: `Lucid - ${a}` }])),
      dailyImports: [{
        id: `${id}-close`,
        snapshots: accounts.map(([accountName, realized]) => ({
          accountName,
          weeklyPnl: 0,
          grossRealizedPnl: realized,
          strategies: [{
            strategyName: '0 - RBO-1.8',
            strategyFamily: 'RBO',
            strategyVersion: '1.8',
            realized,
            enabled: true,
          }],
        })),
      }],
    });
    const overview = buildCamOverview([
      client('client-a', 'Amanda', [['A1', 110], ['A2', 100]]),
      client('client-b', 'Daniel', [['B1', -140], ['B2', 105]]),
    ]);
    expect(overview.deviationFlags.length).toBeGreaterThan(0);
    for (const flag of overview.deviationFlags) {
      expect(['client-a', 'client-b']).toContain(flag.clientId);
      // The id embeds the algorithm key, the client and the account name, and an
      // algorithm name can contain a hyphen. Splitting it to recover the client
      // is not a thing to route a manager's work on.
      expect(flag.id).toContain(flag.clientId);
    }
  });
});
