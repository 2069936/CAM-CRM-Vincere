// The wiring guard: no save in App.jsx may be made visible by a refetch again.
//
// WHY THIS IS A SOURCE-TEXT TEST
//
// The defect was never in a function that could be called from a test. It was
// in the SHAPE of eighteen call sites inside a 15,000-line component:
//
//     mutate(...)
//       .then(() => reloadSupabaseState(camId, clientId))
//       .catch((error) => window.alert("Could not save: " + error.message))
//
// persistEdit.test.js pins what the replacement does, against the real
// crmStateStore reducers, including the desk manager's three symptoms. What it
// cannot pin is that App.jsx actually uses it — and "the helper exists and
// nothing calls it" is exactly the state this file was written in, with
// saveEdit and refreshInBackground both defined and both unreferenced.
//
// So this reads the source. It is the same method src/localSnapshotGate.test.js
// uses on the test tree, for the same reason: the invariant is about which code
// exists, not about what a function returns. It fails if someone reintroduces
// the pattern, drops a rollback from one of the reported symptoms, or lets a
// write reach the full-reload path again.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

/**
 * The body of `function NAME(...) { ... }`, by brace matching.
 *
 * The parameter list is skipped by parens first, not by looking for the next
 * `{`: saveEdit destructures its options, so the first brace after the name is
 * the parameter object and matching from there returns the signature and no
 * body at all — which is a test that passes for the wrong reason.
 */
function bodyOf(name) {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`App.jsx has no function ${name}`);

  let parens = 0;
  let cursor = APP.indexOf('(', start);
  for (; cursor < APP.length; cursor += 1) {
    if (APP[cursor] === '(') parens += 1;
    else if (APP[cursor] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }

  const open = APP.indexOf('{', cursor);
  let depth = 0;
  for (let i = open; i < APP.length; i += 1) {
    if (APP[i] === '{') depth += 1;
    else if (APP[i] === '}') {
      depth -= 1;
      if (depth === 0) return APP.slice(open, i + 1);
    }
  }
  throw new Error(`Unbalanced braces reading ${name}`);
}

/** Lines that mention a symbol, with the comment lines dropped — the fix is
 *  described in prose in several places and prose is not a call site. */
function callLines(symbol) {
  return APP.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(`${symbol}(`))
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}

describe('no edit is made visible by re-downloading the database', () => {
  it('has no mutation chained into a full reload', () => {
    // The literal shape of the defect. Both spellings it took in the file.
    expect(APP).not.toMatch(/\.then\(\(\)\s*=>\s*reloadSupabaseState/);
    expect(APP).not.toMatch(/return reloadSupabaseState\(/);
    expect(APP).not.toMatch(/await reloadSupabaseState\(/);
  });

  it('calls reloadSupabaseState only from the three places a user asked to load', () => {
    // Opening a CAM workspace, opening the manager workspace, and the manager's
    // Refresh button. A fourth entry here means a save found its way back onto
    // the loading path; add it deliberately or not at all.
    const calls = callLines('reloadSupabaseState')
      .filter((line) => !line.startsWith('async function'));
    expect(calls).toEqual([
      'reloadSupabaseState(camId, clientId).catch((error) => {',
      'reloadSupabaseState(null).catch((error) => {',
      'onRefreshState={() => reloadSupabaseState(null)}',
    ]);
  });

  it('keeps the loading state out of the refresh a save is allowed to ask for', () => {
    // beginDashboardLoad is what emptied the screen mid-edit — the "the page
    // reloads" half of every symptom. reloadSupabaseState may call it;
    // refreshInBackground may not.
    expect(bodyOf('reloadSupabaseState')).toContain('beginDashboardLoad(');
    expect(bodyOf('refreshInBackground')).not.toContain('beginDashboardLoad(');
  });

  it('asks for a background refresh from exactly one save, the daily import', () => {
    // A close fans out server-side into rows the client cannot name. Every
    // other edit is fully described by what its own write returns, and adding a
    // refresh to one of those is re-adding the burst one call site at a time.
    const refreshes = callLines('refreshInBackground')
      .filter((line) => !line.startsWith('async function'));
    expect(refreshes).toEqual([
      'refresh: () => refreshInBackground(state.accountManager?.id, clientId, result.date),',
    ]);
    expect(bodyOf('persistDailyImport')).toContain('refresh: () => refreshInBackground(');
  });
});

// The four defects the first pass left behind. Each of these is the WIRING half
// of a reproduction that lives in src/domain/editsSurviveRefresh.test.js (D1-D3)
// or src/domain/remoteStatus.test.js (D4): the modules can be correct and still
// not be the thing App.jsx runs, which is precisely the state saveEdit and
// refreshInBackground were both in when this file was first written.

describe('a refresh folds in what it learned, and never replaces the screen', () => {
  it('merges the refreshed days into current state rather than assigning them', () => {
    // setState(nextState) with nextState built from reads that started before
    // the user's next click is the defect. It is a whole-state replacement
    // whichever function it sits in, so the literal is banned outright.
    expect(APP).toContain('setState((current) => mergeRefreshedDays(current, remoteState, targets));');
    expect(APP).not.toContain('setState(nextState);');
    // The one place a bare assignment is right is the FIRST load, where there
    // is nothing on screen to merge with. A second one is the defect back.
    expect(APP.match(/setState\(remoteState\)/g)).toHaveLength(1);
    expect(bodyOf('refreshInBackground')).not.toContain('setState(');
  });

  it('names the day a background refresh is for, down to the date', () => {
    // A refresh that cannot say which day it went to fetch has nothing to fold
    // in and no choice but to fold in everything.
    const body = bodyOf('refreshInBackground');
    expect(body).toContain('clientId: selectedClientId');
    expect(body).toContain('date,');
    expect(bodyOf('persistDailyImport')).toContain('clientId, result.date)');
  });

  it('reconciles the close from what its own write returned', () => {
    // The refetch used to be persistDailyImport's ONLY reconciliation, which is
    // why a refresh that failed or landed late left the day with no server
    // identity on it. The daily_imports row the write returns carries the uuid.
    const body = bodyOf('persistDailyImport');
    expect(body).toContain('reconcile: (current, savedImport) =>');
    expect(body).toContain('adoptSavedDailyImport(current, clientId, result.date, savedImport)');
  });

  it('puts every background refresh through one gate, so N closes are not N loads', () => {
    // "Import all N closes" called onAppendDailyImport in a forEach and each
    // close asked for its own detached full reload.
    expect(APP).toContain('createCoalescingRefresh({');
    expect(bodyOf('refreshInBackground')).toContain('backgroundRefresh.current.request({');
    // The gate has to outlive a render or it coalesces nothing.
    expect(APP).toContain('const backgroundRefresh = useRef(null);');
    expect(APP.match(/createCoalescingRefresh\(/g)).toHaveLength(1);
  });

  it('imports a batch of closes one at a time', () => {
    // The forEach is what put five writes and five reloads in the air together.
    // persistDailyImport settles on the WRITE, so awaiting it queues the next
    // close behind the last one actually stored.
    expect(callLines('onAppendDailyImport?.')).toEqual([
      'onAppendDailyImport?.(clientId, result);',
      'await onAppendDailyImport?.(clientId, result);',
    ]);
    expect(APP).not.toMatch(/forEach\([^)]*\)\s*=>\s*\n?\s*onAppendDailyImport/);
  });
});

describe('a refresh does not cost the user their trade history', () => {
  it('carries the fills already in memory across a full reload', () => {
    // loadSupabaseCrmState defaults includeTradeHistory=false, so the state a
    // reload returns has orders:[] executions:[] on every day. Assigning it
    // dropped ~24,000 rows off the screen on the Refresh button, on opening a
    // workspace, and on every upload.
    const body = bodyOf('reloadSupabaseState');
    expect(body).toContain('carryTradeHistoryForward(state, nextState)');
    expect(body).toContain('setState(carried.state)');
  });

  it('re-fetches trade history only for a day it has actually never seen', () => {
    // `force` existed and was passed nowhere, so the wipe had no recovery at
    // all. Reaching for it on every refresh would be the other failure: the
    // request burst the bounded gate was introduced to end.
    const body = bodyOf('reloadSupabaseState');
    expect(body).toContain('carried.missingImportIds.length');
    expect(body).toContain('hydrateTradeHistory({ force: true })');
    expect(callLines('hydrateTradeHistory')
      .filter((line) => !line.startsWith('function'))).toEqual([
      'hydrateTradeHistory();',
      'hydrateTradeHistory({ force: true });',
    ]);
  });
});

describe('the honest message is rendered, not merely written', () => {
  it('reads the message and not only the status', () => {
    // remoteStatus.message appeared nowhere in src/ for a whole pass. The
    // sidebar ternary read the status alone, so "stale" printed the same four
    // words as a dead connection.
    expect(APP).toContain('describeRemoteStatus(remoteStatus)');
    expect(APP).toContain('{remoteDataStatus.detail}');
  });

  it('has no status-only ternary left to fall through', () => {
    expect(APP).not.toContain('remoteStatus.status === "connected"');
    expect(APP).not.toContain('remoteStatus.status === "loading"');
    expect(APP).not.toContain('remoteStatus.status === "error"');
  });
});

describe('the three symptoms the desk manager reported', () => {
  // Each is: the edit shows from the edit, the write follows, and only a failed
  // WRITE takes it back off. `rollback` is the assertion that matters — without
  // it a refused save leaves a lie on screen, which is the same defect pointed
  // the other way.
  const symptoms = [
    ['marks a flag', 'handleResolveFlag', 'resolveFlagInImport('],
    ['closes the day', 'performCloseImport', 'updateImportStatus('],
    ['reopens the day', 'performReopenImport', 'updateImportStatus('],
    ['drags a client to reorder the sidebar', 'handleReorderClients', 'updateCamProfile('],
  ];

  for (const [symptom, fn, reducer] of symptoms) {
    it(`${symptom}: ${fn} applies locally, writes, and rolls back only on a failed write`, () => {
      const body = bodyOf(fn);
      expect(body).toContain('saveEdit({');
      expect(body).toContain('apply: (current) =>');
      expect(body).toContain('rollback: (current) =>');
      expect(body).toContain('write: () =>');
      expect(body).toContain(reducer);
      // No refetch of any kind on these paths.
      expect(body).not.toContain('reloadSupabaseState');
      expect(body).not.toContain('refreshInBackground');
      // And no hand-rolled alert: the message has to come from saveFailedMessage
      // so a failed save and a failed refresh cannot be worded the same.
      expect(body).not.toContain('window.alert(`Could not');
    });
  }

  it('rolls a flag back to the status it had, not to Open', () => {
    // A Warning that was Acknowledged and is being Resolved must not reopen
    // when the write is refused.
    const body = bodyOf('handleResolveFlag');
    expect(body).toContain('const previousStatus = flag?.status || "Open"');
    expect(body).toContain('flagId, previousStatus');
  });

  it('takes the activity line back with the flag', () => {
    // The line says the flag was resolved. If the resolve did not save, it did
    // not happen, and leaving it in the log is a false record.
    expect(bodyOf('handleResolveFlag')).toContain('deleteActivityEntry(');
  });

  it('writes the sidebar order to the column that stores it', () => {
    // cam_profiles.client_order. updateSupabaseCamProfile did not map
    // `clientOrder` at all, so the drag wrote an updated_at and reported
    // success, and the order vanished at the next load — the snap-back with no
    // error attached to it.
    const store = readFileSync(new URL('./supabaseStore.js', import.meta.url), 'utf8');
    const fn = store.slice(store.indexOf('export async function updateSupabaseCamProfile'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("if ('clientOrder' in patch) mapped.client_order");
  });
});

describe('every converted save reports the two failures apart', () => {
  it('routes every save through the one helper that separates them', () => {
    // saveEdit is the only thing that calls persistEdit, and persistEdit is the
    // only thing that can tell a failed write from a failed refresh. A save
    // that does not go through it cannot report the difference.
    expect(bodyOf('saveEdit').includes('persistEdit({')).toBe(true);
    expect(bodyOf('saveEdit')).toContain('saveFailedMessage(what, error, { rolledBack, applied })');
    expect(bodyOf('saveEdit')).toContain('onRefreshFailed: (error) => markRefreshFailed(what, error)');
  });

  it('reports a failed refresh as stale data, never as an error or a failed save', () => {
    // status "error" is what empties the client list and reads as "Supabase
    // required" — a rate-limited refresh made a working app look like an
    // outage. The user's own edit is still on screen and still saved.
    const body = bodyOf('markRefreshFailed');
    expect(body).toContain('status: "stale"');
    expect(body).toContain('refreshFailedMessage(what, error)');
    expect(body).not.toContain('setState(');
  });

  // Named one by one rather than counted. A count with slack in it lets a
  // conversion be deleted without failing anything, which is the shape of
  // regression this whole file exists to stop; and a count without slack fails
  // the next time someone adds an unrelated save.
  const converted = [
    'handleAddClient',
    'persistDailyImport',
    'handleUndoDailyImport',
    'handleRequestTimeOff',
    'handleApproveTimeOff',
    'handleEditCoverage',
    'handleDenyTimeOff',
    'handleEndCoverage',
    'performDeleteClient',
    'handleResolveFlag',
    'performCloseImport',
    'performReopenImport',
    'handleReorderClients',
  ];

  for (const fn of converted) {
    it(`${fn} goes through saveEdit`, () => {
      expect(bodyOf(fn)).toContain('saveEdit({');
    });
  }

  it('converts the manager-side handlers too, which are arrow props not declarations', () => {
    // onCreateCam, onUpdateCamProfile, onTransferClient and the manager's
    // onAddClient are inline props on ManagerOverview, so bodyOf cannot reach
    // them. Their `write:` lines are the evidence they were converted.
    for (const write of [
      'write: () => createSupabaseCamProfile(name),',
      'write: () => updateSupabaseCamProfile(camProfileId, patch),',
      'write: () => transferSupabaseClient(clientId, toCamId),',
      'write: () => createSupabaseClient(clientName, camId || null, stage || "Active"),',
    ]) {
      expect(APP).toContain(write);
    }
  });

  it('leaves the bulk client import throwing, because its caller depends on that', () => {
    // importClients() awaits onImportClient per row and stops the run on a
    // rejection to report which row failed. persistEdit never rejects, so this
    // one path deliberately keeps its own shape — what it does not keep is the
    // per-row full reload, which made a fifty-client import fifty full loads.
    expect(APP).toContain('// Deliberately NOT saveEdit: importClients() above awaits this per');
    const importProp = APP.slice(APP.indexOf('onImportClient={async (row, camId)'));
    expect(importProp.slice(0, importProp.indexOf('onAppendDailyImport'))).not.toContain('reloadSupabaseState');
  });
});
