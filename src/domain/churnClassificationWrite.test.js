// One decision, one write: a client is never filed as Inactive without the
// reason that was given for it.
//
// The desk manager's third instruction was "a reason, RECORDED AT
// CLASSIFICATION". Everything downstream of that is already pinned elsewhere —
// what the reason list is (clientLifecycle.test.js), what the panel does with it
// (ChurnDetail.test.jsx), what the column may not default to
// (supabase/step_39_client_churn_reason.test.js), what the dialog will not let
// past (ChurnReasonDialog.test.jsx). What is left is the join between them, and
// it is two things that live in two different 15,000- and 1,900-line files:
//
//   THE APP must send the stage and the reason in ONE patch. Two patches, or a
//   stage written by the select with the dialog wired beside it, reopens the
//   window this whole change exists to close: a churned client with nothing
//   recorded, created by the one action that knew the answer.
//
//   THE APP must also hand the manager's roll-up the CAM map, because that one
//   prop is the whole of "which CAM did this client belong to" — the second half
//   of the manager's second instruction, and a column that vanishes silently.
//
//   THE STORE must map the three new columns ONLY on that patch. They are the
//   one thing in the schema this branch adds, so on a database where step 39 has
//   not run they are the one thing that can fail — and if an ordinary contact
//   card edit carried them, every save in the app would fail there instead of
//   only the classification. That is the whole reason `churn` rides beside
//   `profile` rather than inside it, and nothing else in the tree checks it.
//
// The store half drives the real updateSupabaseClient against a PostgREST
// stand-in, the way editsSurviveRefresh.test.js does, so it is the actual write
// path being measured and not a re-description of it. The App half reads source
// text, the way appSaveWiring.test.js does, because the invariant is the shape
// of two call sites inside a component no test renders whole.
//
// Synthetic throughout: no book, so CI runs every line.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ updates: [], row: { id: 'uuid-1' } }));

vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    from(table) {
      const builder = {
        payload: null,
        select() { return builder; },
        update(patch) {
          db.updates.push({ table, patch });
          return builder;
        },
        eq() { return builder; },
        upsert(patch) {
          db.updates.push({ table, patch });
          return Promise.resolve({ error: null });
        },
        delete() { return builder; },
        insert(rows) {
          db.updates.push({ table, patch: rows });
          return Promise.resolve({ error: null });
        },
        maybeSingle() { return Promise.resolve({ data: db.row, error: null }); },
        single() { return Promise.resolve({ data: db.row, error: null }); },
      };
      return builder;
    },
  },
}));

const { updateSupabaseClient, buildCrmStateFromTables } = await import('./supabaseStore.js');
const { clientChurnRecord } = await import('./clientLifecycle.js');

/** The UPDATE that landed on `clients`, which is the one this file is about. */
const clientUpdate = () => db.updates.filter((entry) => entry.table === 'clients').at(-1)?.patch;
const CHURN_COLUMNS = ['churn_reason', 'churn_note', 'churned_at'];

beforeEach(() => {
  db.updates = [];
});

describe('the classification and its reason reach the database together', () => {
  it('writes the stage and all three churn columns in one UPDATE', () => Promise.resolve(
    updateSupabaseClient('c1', {
      profile: { stage: 'Inactive', fullName: 'Rosalind Vance' },
      churn: { reason: 'unresponsive', note: 'Stopped replying.', at: '2026-07-14' },
    }),
  ).then(() => {
    // One statement, not two. A second UPDATE is a window in which the client is
    // churned and the reason is not yet stored, and a failure between them is
    // the unexplained row nobody can reconstruct.
    expect(db.updates.filter((entry) => entry.table === 'clients')).toHaveLength(1);
    expect(clientUpdate()).toMatchObject({
      stage: 'Inactive',
      churn_reason: 'unresponsive',
      churn_note: 'Stopped replying.',
      churned_at: '2026-07-14',
    });
  }));

  it('touches none of the three on an ordinary edit of the contact card', () =>
    Promise.resolve(
      updateSupabaseClient('c1', {
        profile: { stage: 'Active', phone: '+57 300 000 0000', fullName: 'Rosalind Vance' },
      }),
    ).then(() => {
      // THE assertion of this file. Step 39 is the only migration this branch
      // needs, so those three columns are the only thing that can be missing on
      // a database somebody has not run it against yet. Mapped from `profile`,
      // they would ride along with every phone number correction and every
      // stage change in the app, and a deploy that got ahead of the migration
      // would fail all of them instead of only the classification.
      const patch = clientUpdate();
      expect(patch.phone).toBe('+57 300 000 0000');
      for (const column of CHURN_COLUMNS) expect(column in patch).toBe(false);
    }));

  it('ignores a churn value smuggled in on the profile', () =>
    Promise.resolve(
      updateSupabaseClient('c1', {
        profile: { stage: 'Inactive', churn: { reason: 'cost' }, churnReason: 'cost' },
      }),
    ).then(() => {
      // The same rule from the other side: `profile` is re-sent whole by
      // updateProfile, so anything parked in it is written by every edit. Only
      // a top-level `churn` key maps.
      const patch = clientUpdate();
      expect(patch.stage).toBe('Inactive');
      for (const column of CHURN_COLUMNS) expect(column in patch).toBe(false);
    }));

  it('sends an absent date and an absent reason as null, not as empty text', () =>
    Promise.resolve(
      updateSupabaseClient('c1', { churn: { reason: '', note: '', at: '' } }),
    ).then(() => {
      // '' in a countable column is a value: it would group as its own bucket
      // beside 'cost' and 'other', and `where churn_reason is null` would stop
      // finding the clients nobody was asked about. The dialog cannot produce
      // this patch — it will not confirm without an option — so this is about
      // what the mapper does with one that reaches it another way.
      expect(clientUpdate()).toMatchObject({
        churn_reason: null,
        churn_note: '',
        churned_at: null,
      });
    }));
});

describe('the columns read back, and read as silence when they are not there', () => {
  const tables = (clientRow) => ({ clients: [{ id: 'uuid-1', name: 'Rosalind Vance', status: 'Active', stage: 'Inactive', ...clientRow }] });

  it('round-trips a recorded classification', () => {
    const patch = { churn: { reason: 'cost', note: 'Wanted a cheaper stack.', at: '2026-06-02' } };
    return Promise.resolve(updateSupabaseClient('c1', patch)).then(() => {
      // Written, then read by the same mapper the app loads through: the row the
      // panel groups on is the row the dialog produced.
      const [client] = buildCrmStateFromTables(tables(clientUpdate())).clients;
      expect(clientChurnRecord(client)).toEqual({
        recorded: true,
        reasonCode: 'cost',
        reasonLabel: 'Cost of the service',
        reasonNote: 'Wanted a cheaper stack.',
        churnedAt: '2026-06-02',
      });
    });
  });

  it('reads a row from before step 39 as Not recorded rather than failing', () => {
    // The graceful half. Every export taken before today — public/local-snapshot
    // .json included, which the suite loads — has no such columns at all.
    const [client] = buildCrmStateFromTables(tables({})).clients;
    expect(client.churn).toEqual({ reason: '', note: '', at: '' });
    expect(clientChurnRecord(client).recorded).toBe(false);
    expect(clientChurnRecord(client).reasonLabel).toBe('Not recorded');
    expect(clientChurnRecord(client).reasonLabel).not.toBe('Other');
  });

  it('keeps a timestamp from a hand-run UPDATE readable as a trading day', () => {
    // churned_at is a date column, but a hand-run UPDATE or a driver that
    // stringifies can still deliver a timestamp. Asserted on `client.churn.at`
    // and not through clientChurnRecord, because that normalises the same value
    // a second time — a test taken one layer further down passes whatever the
    // mapper does here, which is a guard that pins nothing.
    const [client] = buildCrmStateFromTables(
      tables({ churn_reason: 'other', churned_at: '2026-06-02T23:40:11.000Z' }),
    ).clients;
    expect(client.churn.at).toBe('2026-06-02');
    expect(clientChurnRecord(client).churnedAt).toBe('2026-06-02');
  });
});

/* ── The App sends one patch, from one place ──────────────────────────────── */

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

/** The body of `function NAME(...) { ... }`, by brace matching. */
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
  const openBrace = APP.indexOf('{', cursor);
  let depth = 0;
  for (let i = openBrace; i < APP.length; i += 1) {
    if (APP[i] === '{') depth += 1;
    else if (APP[i] === '}') {
      depth -= 1;
      if (depth === 0) return APP.slice(openBrace, i + 1);
    }
  }
  throw new Error(`Unbalanced braces reading ${name}`);
}

/** Source lines mentioning a symbol, comments dropped — prose is not a call. */
const codeLines = (needle) => APP.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.includes(needle))
  .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));

describe('the stage selector cannot file a client Inactive on its own', () => {
  it('sends the guard to the dialog instead of writing the stage', () => {
    // The select is the only control in the app that produces a churned client,
    // which is why it is the only place the reason can be captured at the moment
    // it is known. Choosing Inactive must STOP here — the `return` is the whole
    // guard, and without it the stage is written and the dialog merely appears.
    expect(APP).toMatch(
      /nextStage === CLIENT_STAGE_INACTIVE[\s\S]{0,120}?setChurnPrompt\(true\);\s*return;/,
    );
    // Every other stage still goes straight through, unchanged.
    expect(APP).toMatch(/setChurnPrompt\(true\);\s*return;\s*}\s*updateProfile\(\{ stage: nextStage \}\)/);
  });

  it('opens the dialog from that one place and nowhere else', () => {
    expect(codeLines('setChurnPrompt(true)')).toHaveLength(1);
  });

  it('writes the stage and the reason in a single patch', () => {
    const body = bodyOf('commitChurn');
    // One call. Two would be two UPDATEs and a window between them.
    expect(codeLinesIn(body, 'onUpdateClient(')).toHaveLength(1);
    expect(body).toContain('stage: CLIENT_STAGE_INACTIVE');
    expect(body).toContain('churn: { reason, note, at: todayIsoDate() }');
    // And it closes the prompt, so a second confirm cannot fire the same write.
    expect(body).toContain('setChurnPrompt(false)');
  });

  it('is the only thing in the app that writes a churn record', () => {
    // A second writer is a second chance to record a classification without one.
    expect(codeLines('churn: {')).toEqual(['churn: { reason, note, at: todayIsoDate() },']);
    // updateProfile spreads `profile` and must not carry churn with it.
    expect(bodyOf('updateProfile')).not.toContain('churn');
  });

  it('wires the dialog to that write and to nothing else', () => {
    expect(APP).toMatch(/<ChurnReasonDialog[\s\S]{0,200}?open=\{churnPrompt\}/);
    expect(APP).toMatch(/<ChurnReasonDialog[\s\S]{0,300}?onConfirm=\{commitChurn\}/);
    // Cancel puts the prompt away and writes nothing at all.
    expect(APP).toMatch(/<ChurnReasonDialog[\s\S]{0,300}?onCancel=\{\(\) => setChurnPrompt\(false\)\}/);
  });
});

describe('the manager\'s drill-down knows whose client each one was', () => {
  it('passes the CAM map on the consolidated view and withholds it on a CAM\'s own', () => {
    // "He needs to see WHICH CAM a churned client belonged to" is half of the
    // manager's second instruction, and buildChurnRetention fills camName only
    // when it is given the map — so the whole CAM column and its filter hang on
    // one prop at one call site. Dropped, every domain test still passes and the
    // manager's panel quietly loses the column he asked for.
    const rollups = codeLines('rollup={buildLifecycleRollup(');
    expect(rollups).toHaveLength(2);
    expect(rollups).toContain('rollup={buildLifecycleRollup(clients || [], { camNameByClientId })}');
    // And exactly one without it: on his own page the answer is always him, so a
    // column of one repeated name is noise. Same rule as DeviationAlertList.
    expect(rollups).toContain('rollup={buildLifecycleRollup(clients || [])}');
  });

  it('opens the client the manager clicked, on the CAM who holds them', () => {
    // The click has to land somewhere. On the consolidated view that means
    // resolving the CAM from the client id first — onOpenCam(camId, clientId) is
    // the established two-argument shape everywhere else on that screen.
    expect(APP).toMatch(
      /onSelectClient=\{\(clientId\) => onOpenCam\(\s*activeCamProfiles\.find\(\(p\) => \(p\.clientIds \|\| \[\]\)\.includes\(clientId\)\)\?\.id,\s*clientId,\s*\)\}/,
    );
  });
});

function codeLinesIn(source, needle) {
  return source.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}
