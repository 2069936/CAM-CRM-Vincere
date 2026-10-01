// @vitest-environment jsdom
//
// The export dialog's two new jobs, both of which are UI guarantees that no
// domain test can hold.
//
// 1. THE MANAGER'S THIRD SCOPE. Inside a client the choice is "this client" or
//    "all my clients", which is right on a CAM's own page because for a CAM
//    those are the only two lists there are. On the manager's screen "all my
//    clients" is ambiguous — the sidebar he is reading is one CAM's book and the
//    list behind the dialog is the whole desk — so it becomes three.
//
// 2. NEVER A SILENT PARTIAL. A pull too big for one response is split into parts
//    sized by bytes, and the split is shown before it happens. The property that
//    matters is the refusal: when splitting cannot deliver the set whole, the
//    button does not go. Four good parts and a 413 on the fifth is exactly the
//    truncation the endpoint refuses to do inside one payload, moved into a
//    downloads folder where nothing is watching for it.
//
//    The parts are still one request each, and they still each fit the response
//    ceiling — that constraint has not moved. What changed is that they now
//    leave as ONE zip (src/domain/clientExportPackage.js), so this dialog talks
//    about requests where it used to talk about files.
//
// Synthetic throughout, so CI runs all of it. What the parts actually WEIGH on
// the real book is src/domain/clientExportPlan.book.test.js.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClientExportDialog from './ClientExportDialog';

afterEach(cleanup);

// process.cwd(), not import.meta.url: under `@vitest-environment jsdom` the
// module URL comes back with Vite's own /@fs prefix and resolves to nothing.
const APP = readFileSync(join(process.cwd(), 'src/App.jsx'), 'utf8');

// Sessions land inside the dialog's own default range (the last 30 days), which
// it computes from the clock. Fixed 2026 dates would fall outside it and every
// client would preview as empty — a fixture that silently agrees with any
// implementation.
const today = new Date().toISOString().slice(0, 10);
function daysAgo(delta) {
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - delta);
  return at.toISOString().slice(0, 10);
}

function client(id, sessions = 0, perDay = { accounts: 6, strategies: 7, orders: 30, executions: 15, flags: 13 }) {
  return {
    id,
    uuid: id,
    name: `Client ${id}`,
    accountRegistry: {},
    activityLog: [],
    dailyImports: Array.from({ length: sessions }, (_, day) => ({
      date: daysAgo(day % 30),
      sourceSummary: perDay,
    })),
  };
}

function open(props = {}) {
  const onExport = vi.fn();
  const view = render(
    <ClientExportDialog
      open
      onOpenChange={() => {}}
      clients={props.clients || [client('a'), client('b')]}
      onExport={onExport}
      {...props}
    />,
  );
  return { onExport, ...view };
}

const scopeNames = () => screen.getAllByRole('radio').map((input) => (
  input.closest('label').textContent.trim()
));
const downloadButton = () => screen.getAllByRole('button').find((button) => /Download/.test(button.textContent));

/* ── The manager's third scope ────────────────────────────────────────────── */

describe('export scope', () => {
  it('offers a CAM two choices, because a CAM has two lists', () => {
    open({ focusClientId: 'a' });
    expect(scopeNames()).toEqual(['Client a', 'All my clients (2)']);
  });

  it('offers a manager three, naming the CAM whose book the middle one is', () => {
    // The desk manager's ask, in one assertion: this client, that CAM's
    // clients, every client in the list.
    const book = [client('a'), client('b'), client('c'), client('d')];
    open({
      clients: book,
      camClients: [book[0], book[1]],
      camName: 'Rhea Calder',
      namedScopeForAll: true,
      focusClientId: 'a',
    });
    expect(scopeNames()).toEqual([
      'Client a',
      "Rhea Calder's clients (2)",
      'Every client (4)',
    ]);
  });

  it('does not offer the same list twice under two names', () => {
    // A manager on a desk with one CAM: the CAM's book IS every client. Two
    // buttons onto one list teaches a reader they are different books.
    const book = [client('a'), client('b')];
    open({ clients: book, camClients: book, camName: 'Rhea Calder', namedScopeForAll: true });
    expect(scopeNames()).toEqual(['This client', 'All my clients (2)']);
  });

  it('sends the CAM scope as that CAM\'s clients, not the whole desk', () => {
    const book = [client('a'), client('b'), client('c'), client('d')];
    const { onExport } = open({
      clients: book,
      camClients: [book[0], book[1]],
      camName: 'Rhea Calder',
      namedScopeForAll: true,
      focusClientId: 'a',
    });
    fireEvent.click(screen.getByRole('radio', { name: "Rhea Calder's clients (2)" }));
    fireEvent.click(downloadButton());
    expect(onExport).toHaveBeenCalledTimes(1);
    const [requests] = onExport.mock.calls[0];
    expect(requests).toHaveLength(1);
    expect(requests[0].clientIds).toEqual(['a', 'b']);
  });

  it('lets a CAM\'s "all my clients" go out with no ids at all', () => {
    // The server then reads the assignment table itself, so a stale browser
    // list cannot widen or narrow the pull.
    const { onExport } = open({ clients: [client('a'), client('b')] });
    fireEvent.click(downloadButton());
    expect(onExport.mock.calls[0][0][0].clientIds).toBeNull();
  });
});

/* ── Parts, and the refusal ───────────────────────────────────────────────── */

const OVER_ONE_RESPONSE = Array.from({ length: 14 }, (_, index) => client(`h${index}`, 20));

describe('a pull too big for one response', () => {
  it('says it will be read in parts, and handed over as one zip', () => {
    open({ clients: OVER_ONE_RESPONSE, namedScopeForAll: true });
    expect(screen.getByText(/Too big for one request/)).toBeTruthy();
    expect(screen.getByText(/downloaded as one zip/)).toBeTruthy();
    // The part count stays on the button: it is the wait being agreed to.
    expect(downloadButton().textContent).toMatch(/Download zip \(\d+ parts\)/);
  });

  it('sends one request per part, each labelled and each with its own clients', () => {
    const { onExport } = open({ clients: OVER_ONE_RESPONSE, namedScopeForAll: true });
    fireEvent.click(downloadButton());
    const [requests] = onExport.mock.calls[0];
    expect(requests.length).toBeGreaterThan(1);
    requests.forEach((request, index) => {
      expect(request.batch).toEqual({ index: index + 1, of: requests.length });
      expect(request.clientIds.length).toBeGreaterThan(0);
    });
    // Every client, once, across the parts. A split that lost one would be a
    // truncation nothing downstream could see.
    const sent = requests.flatMap((request) => request.clientIds);
    expect(sent).toEqual(OVER_ONE_RESPONSE.map((entry) => entry.uuid));
  });

  it('names its clients even for a CAM, because a part is defined by them', () => {
    // The unbatched "all my clients" sends no ids on purpose. A part cannot:
    // there is no other way to say which part this is.
    const { onExport } = open({ clients: OVER_ONE_RESPONSE, namedScopeForAll: false });
    fireEvent.click(downloadButton());
    for (const request of onExport.mock.calls[0][0]) {
      expect(request.clientIds).not.toBeNull();
    }
  });

  it('will not start a download it knows cannot be delivered whole', () => {
    // One client too big for a part on its own. Splitting the LIST cannot help,
    // so the button is dead rather than producing files up to the failure.
    const clients = [client('small', 1), client('enormous', 400), client('small2', 1)];
    const { onExport } = open({ clients, namedScopeForAll: true });
    expect(downloadButton().disabled).toBe(true);
    expect(screen.getByText(/splitting the list cannot deliver it/)).toBeTruthy();
    fireEvent.click(downloadButton());
    expect(onExport).not.toHaveBeenCalled();
  });

  it('sends one unlabelled request when it fits', () => {
    const { onExport } = open({ clients: [client('a', 2)], focusClientId: 'a' });
    fireEvent.click(downloadButton());
    const [requests] = onExport.mock.calls[0];
    expect(requests).toHaveLength(1);
    expect(requests[0].batch).toBeNull();
    expect(downloadButton().textContent).toMatch(/Download JSON/);
  });
});

describe('after the download', () => {
  const payload = (index, of, rows) => ({
    totalRows: rows,
    rowCounts: { daily_imports: 3 },
    truncated: false,
    truncation: [],
    range: { from: '2026-07-01', to: '2026-07-31' },
    scope: {
      batch: of > 1 ? { index, of } : null,
      requestedClientCount: 2,
      includedClientCount: 2,
      includedClients: [],
    },
  });

  it('adds the parts up rather than reporting only the last one', () => {
    open({
      clients: OVER_ONE_RESPONSE,
      result: { payloads: [payload(1, 3, 100), payload(2, 3, 250)], expectedParts: 3 },
    });
    expect(screen.getByText(/350 rows/)).toBeTruthy();
  });

  it('says out loud when a part never arrived', () => {
    // Two real files are sitting in a folder and they are not the whole range.
    // This is the only place anyone can be told.
    open({
      clients: OVER_ONE_RESPONSE,
      error: 'Part 3 of 3 failed: This export is 4.20 MB...',
      result: { payloads: [payload(1, 3, 100), payload(2, 3, 250)], expectedParts: 3 },
    });
    expect(screen.getByText(/Only 2 of 3 parts downloaded/)).toBeTruthy();
    expect(screen.getByText(/do not read it as the whole range/)).toBeTruthy();
  });

  it('stays quiet about parts when every one of them arrived', () => {
    open({
      clients: OVER_ONE_RESPONSE,
      result: { payloads: [payload(1, 2, 100), payload(2, 2, 250)], expectedParts: 2 },
    });
    expect(screen.queryByText(/parts downloaded/)).toBeNull();
  });

  it('reports a truncated table from whichever part hit the ceiling', () => {
    const short = { ...payload(2, 2, 250), truncated: true, truncation: [{ table: 'orders' }] };
    open({
      clients: OVER_ONE_RESPONSE,
      result: { payloads: [payload(1, 2, 100), short], expectedParts: 2 },
    });
    expect(screen.getByText(/Truncated:/)).toBeTruthy();
    expect(screen.getByText(/orders/)).toBeTruthy();
  });
});

/* ── The wiring, which is the half a rendered dialog cannot show ──────────── */

function runClientExportBody() {
  const runner = APP.slice(APP.indexOf('async function runClientExport('));
  return runner.slice(0, runner.indexOf('\n  /* THE SESSION THE LOADERS READ'));
}

describe('what App.jsx hands the dialog', () => {
  it('gives the manager the CAM whose workspace is open, and a CAM nothing', () => {
    // Without this the third scope renders on nobody's screen and every test
    // above passes anyway — the shape of an unpinned feature.
    expect(APP).toContain('camClients={isManagerSession ? currentCamClients : null}');
    expect(APP).toContain('camName={isManagerSession ? (currentCamProfile?.name || "") : ""}');
  });

  it('walks the parts instead of exporting only the first', () => {
    const body = runClientExportBody();
    expect(body).toMatch(/for \(const request of parts\)/);
    // A failure has to stop the walk. A catch inside the loop would keep going
    // and produce an archive that looks complete.
    const pushed = body.indexOf('payloads.push(await loadClientScopedExport(request))');
    expect(pushed).toBeGreaterThan(-1);
    expect(body.indexOf('} catch (error) {')).toBeGreaterThan(pushed);
  });

  it('keeps the parts that did arrive, so their number can be reported', () => {
    expect(runClientExportBody()).toContain(
      'result: payloads.length ? { payloads, expectedParts: parts.length } : null',
    );
  });

  it('writes ONE file per run, at the end, instead of one per part', () => {
    // The reason this feature exists. A save inside the loop is the four-file
    // download it replaced, and it would pass every other test here.
    const body = runClientExportBody();
    const loop = body.slice(body.indexOf('for (const request of parts)'), body.indexOf('saveClientExportPackage'));
    expect(loop).not.toContain('saveClientExportPackage');
    expect(body.match(/saveClientExportPackage\(payloads, parts\.length\)/g)).toHaveLength(2);
  });

  it('writes the parts it did get when the walk fails, rather than dropping them', () => {
    // Those parts cost a round trip each through every table. The archive that
    // carries them names itself INCOMPLETE — pinned in
    // src/domain/clientExportPackage.test.js, which is where the naming lives.
    const body = runClientExportBody();
    const failure = body.slice(body.indexOf('} catch (error) {'));
    expect(failure).toContain('saveClientExportPackage(payloads, parts.length)');
  });
});
