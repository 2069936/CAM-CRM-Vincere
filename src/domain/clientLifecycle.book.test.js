// The churn drill-down, measured on the real book.
//
// public/local-snapshot.json is a redacted export of the desk as it stands, and
// on the churn question it says something a fixture cannot: THERE IS NO CHURN.
// 96 clients, 95 Active and 1 Paused, nobody marked Inactive. The manager's
// panel reads 0 today, and it read 0 before this change too — his complaint was
// never that the number was wrong, it was that a number he cannot open tells him
// nothing.
//
// So a test written only against this book would prove almost nothing about the
// drill-down, and every rule it has to obey is pinned synthetically in
// clientLifecycle.test.js and ChurnDetail.test.jsx, which are ungated and
// therefore run on CI. What lives HERE is the three things only the book can
// say:
//
//   1. that the export predates step 39, so every client on it reads as "Not
//      recorded" and no reason is fabricated on the data the desk actually has;
//   2. that the 40 soft-deleted rows in the raw table — every one of them
//      `status: 'Inactive'` — are not departures. The churn definition reads
//      profile.stage, and a definition that reached for `status` instead would
//      print 40 churned clients on a desk that has lost none;
//   3. what the panel does once somebody uses it, driven through the real CAM
//      assignment map rather than a hand-written one.
//
// Gated (vite.config.js localSnapshotTests) because it reads the export.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHURN_REASON_UNRECORDED,
  CLIENT_STAGES,
  buildChurnDetail,
  buildChurnRetention,
  buildLifecycleRollup,
  clientChurnRecord,
  isChurnedClient,
  pipelineColumns,
} from './clientLifecycle';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const state = buildCrmStateFromTables(snapshot.tables);
const { clients, camProfiles } = state;

// Exactly the map App.jsx builds for the manager's page: every CAM's own book,
// name by client id. Built here rather than typed out, so it stays the same map
// the screen passes down.
const camNameByClientId = Object.fromEntries(
  camProfiles.flatMap((profile) => (profile.clientIds || []).map((id) => [id, profile.name])),
);

/** Mark one real client Inactive, the way the Client stage selector does. */
const churn = (client, { reason, note, at } = {}) => ({
  ...client,
  profile: { ...client.profile, stage: 'Inactive' },
  ...(reason || note || at ? { churn: { reason: reason || '', note: note || '', at: at || '' } } : {}),
});

describe('the churn number on the real book', () => {
  it('is zero, on a book of 96 clients across eight CAMs', () => {
    // The state this change was made in. Worth stating rather than assuming:
    // every assertion below about "what happens when a client churns" is about
    // a case this export does not contain, and that is the reason the guards
    // that matter are synthetic.
    expect(clients).toHaveLength(96);
    expect(camProfiles).toHaveLength(8);
    expect(clients.filter(isChurnedClient)).toEqual([]);

    const rollup = buildLifecycleRollup(clients, { camNameByClientId });
    expect(rollup.churned).toBe(0);
    expect(rollup.churnedClients).toEqual([]);
    expect(rollup.retentionRate).toBe(1);
    // And the drill-down behind the 0 is empty rather than absent, so the panel
    // shows "nobody has been classified" instead of a table with no rows.
    expect(buildChurnDetail(rollup.churnedClients).total).toBe(0);
    expect(buildChurnDetail(rollup.churnedClients).rows).toEqual([]);
  });

  it('does not count the 40 soft-deleted clients as departures', () => {
    // THE assertion of this file, and the one only the book can make. The raw
    // clients table carries two different meanings of the word Inactive:
    // `status` is the soft-delete flag that the Remove client button sets, and
    // `stage` is the CAM's classification. 40 rows carry the first and none
    // carry the second.
    //
    // buildCrmStateFromTables drops the 40 at load, so they never reach a
    // lifecycle roll-up at all — but a churn definition that reached for
    // `client.status` would still find them the moment anything stopped
    // filtering, and the manager would open a churn count of 40 on a desk that
    // has lost nobody. isChurnedClient reads profile.stage and only that.
    const raw = snapshot.tables.clients;
    expect(raw).toHaveLength(136);
    expect(raw.filter((row) => row.status === 'Inactive')).toHaveLength(40);
    expect(raw.filter((row) => row.stage === 'Inactive')).toHaveLength(0);
    expect(clients.some((client) => client.status === 'Inactive')).toBe(false);

    // Driven, not just counted: a soft-deleted row put back through the mapper's
    // own shape is still not churn.
    const softDeleted = raw.find((row) => row.status === 'Inactive');
    expect(isChurnedClient({ ...clients[0], status: softDeleted.status })).toBe(false);
    expect(buildChurnRetention(clients.map((c) => ({ ...c, status: 'Inactive' }))).churned).toBe(0);
  });

  it('reads an export taken before step 39 as Not recorded, never as Other', () => {
    // The graceful half of the migration, on the file the suite actually loads.
    // The three columns do not exist in this export; supabaseStore materialises
    // `churn` as three empty strings anyway, which is a DIFFERENT shape from the
    // synthetic fixture's "no churn key at all" and has to land in the same
    // place. Both are silence, and silence is not the 'other' option.
    for (const column of ['churn_reason', 'churn_note', 'churned_at']) {
      expect(snapshot.tables.clients.some((row) => column in row)).toBe(false);
    }
    for (const client of clients) {
      expect(client.churn).toEqual({ reason: '', note: '', at: '' });
      const record = clientChurnRecord(client);
      expect(record.recorded).toBe(false);
      expect(record.reasonCode).toBe(CHURN_REASON_UNRECORDED);
      expect(record.reasonCode).not.toBe('other');
      expect(record.reasonLabel).toBe('Not recorded');
      expect(record.churnedAt).toBe('');
    }
  });
});

describe('what the manager opens once clients start leaving', () => {
  // Three real clients off two real books, classified the way a CAM classifies
  // them. Chosen by position in the CAM's own assignment list so the fixture is
  // derived from the export rather than typed beside it.
  const reese = camProfiles.find((p) => p.name === 'Reese Glen');
  const oakley = camProfiles.find((p) => p.name === 'Oakley Ash');
  const byId = Object.fromEntries(clients.map((client) => [client.id, client]));
  const gone = [
    churn(byId[reese.clientIds[0]], { reason: 'cost', note: 'Wanted a cheaper stack.', at: '2026-06-02' }),
    churn(byId[reese.clientIds[1]], { reason: 'unresponsive', at: '2026-07-20' }),
    churn(byId[oakley.clientIds[0]]),
  ];
  const book = clients.map((client) => gone.find((g) => g.id === client.id) || client);
  const rollup = buildLifecycleRollup(book, { camNameByClientId });

  it('attributes each departure to the book it came off', () => {
    expect(rollup.churned).toBe(3);
    expect(rollup.clients).toBe(96);
    expect(rollup.retentionRate).toBeCloseTo(93 / 96, 10);
    // In book order, which is the order buildChurnRetention filters in — the
    // drill-down is what re-sorts them by departure date.
    expect(rollup.churnedClients.map((row) => [row.clientName, row.camName])).toEqual(
      book.filter(isChurnedClient).map((client) => [client.name, camNameByClientId[client.id]]),
    );
    expect(rollup.churnedClients.map((row) => row.camName).sort())
      .toEqual(['Oakley Ash', 'Reese Glen', 'Reese Glen']);
    // Real names off the export, not placeholders — the row a manager clicks is
    // the client he knows.
    expect(rollup.churnedClients.every((row) => row.clientName.length > 0)).toBe(true);
  });

  it('adds up: the desk list is exactly the CAMs\' lists together', () => {
    // Said out loud because the OTHER panel on this screen does not do this. The
    // desk deviation count is not the sum of the CAMs' — a peer group widens
    // with the book and moves its own threshold — and that panel prints a
    // reconciliation sentence for exactly that reason. Churn has no peer group:
    // a client belongs to one CAM, so the desk number is the sum, and nobody
    // needs to be told why 3 disagrees with 2 and 1. If this ever stops holding,
    // this panel needs that sentence too.
    const perCam = camProfiles.map((profile) => buildChurnRetention(
      book.filter((client) => (profile.clientIds || []).includes(client.id)),
    ).churned);
    expect(perCam.reduce((sum, n) => sum + n, 0)).toBe(rollup.churned);
    // Every client on this book is assigned to exactly one CAM, so nothing is
    // counted twice and nothing falls between the books.
    expect(Object.keys(camNameByClientId)).toHaveLength(96);
  });

  it('filters by CAM and by when they left, over the real assignment map', () => {
    const all = buildChurnDetail(rollup.churnedClients);
    expect(all.cams).toEqual(['Oakley Ash', 'Reese Glen']);
    expect(all.rows.map((row) => row.clientName)).toEqual([
      gone[1].name, gone[0].name, gone[2].name,
    ]);

    const reeseOnly = buildChurnDetail(rollup.churnedClients, { cam: 'Reese Glen' });
    expect(reeseOnly.rows.map((row) => row.clientName)).toEqual([gone[1].name, gone[0].name]);
    expect(reeseOnly.total).toBe(3);
    expect(reeseOnly.scoped).toBe(2);

    const july = buildChurnDetail(rollup.churnedClients, { from: '2026-07-01' });
    expect(july.rows.map((row) => row.clientName)).toEqual([gone[1].name]);
    // The client nobody was asked about cannot satisfy a date range, and the
    // panel says so instead of shrinking around him.
    expect(july.undatedHidden).toBe(1);
  });

  it('counts the reasons, including the ones nobody gave', () => {
    expect(buildChurnDetail(rollup.churnedClients).reasons).toEqual([
      { code: 'cost', label: 'Cost of the service', count: 1 },
      { code: CHURN_REASON_UNRECORDED, label: 'Not recorded', count: 1 },
      { code: 'unresponsive', label: 'Stopped responding', count: 1 },
    ]);
    expect(
      buildChurnDetail(rollup.churnedClients, { reason: CHURN_REASON_UNRECORDED })
        .rows.map((row) => row.clientName),
    ).toEqual([gone[2].name]);
  });

  it('leaves the 93 who stayed exactly where they were', () => {
    // A classification is one client's story changing. The roll-up is read off
    // the same screen as the money, and a change that moved anybody else's
    // account or payout totals would be a churn feature quietly rewriting the
    // book.
    const before = buildLifecycleRollup(clients);
    expect(rollup.totalAccounts).toBe(before.totalAccounts);
    expect(rollup.payoutTotal).toBe(before.payoutTotal);
    expect(rollup.fundedCount).toBe(before.fundedCount);
    expect(rollup.evaluationCount).toBe(before.evaluationCount);
  });
});

describe('the pipeline board’s lanes on the real book', () => {
  it('puts 95 of 96 clients in one lane, which is the shape the treatment is for', () => {
    // The desk manager's report was about this board. On the export it is not a
    // spread across five stages, it is one lane holding 95 cards beside four
    // that hold one between them — roughly seven thousand pixels of Active
    // against four columns that end in the first screenful. That is the number
    // the bounded, scrolling lane exists for, and if the book ever spreads out
    // this is where anyone would see it.
    const { columns, placed, unknown } = pipelineColumns(clients);

    expect(placed).toBe(96);
    expect(unknown).toBe(0);
    expect(columns.map((column) => [column.stage, column.clients.length])).toEqual([
      ['Onboarding', 0],
      ['Active', 95],
      ['At Risk', 0],
      ['Paused', 1],
      ['Inactive', 0],
    ]);
  });

  it('loses nobody between the roster and the lanes', () => {
    // The board prints `placed` against the client count on the same page. Two
    // numbers derived from one walk cannot disagree; two derived separately can,
    // and the old board's could — it bucketed into a private stage list and
    // rendered a column per name in the same list, so anything else fell out
    // with no count anywhere to contradict it.
    const { columns } = pipelineColumns(clients);
    const laneIds = columns.flatMap((column) => column.clients.map((client) => client.id));
    expect(laneIds.slice().sort()).toEqual(clients.map((client) => client.id).sort());
  });

  it('keeps every stage lane on screen even though three of them are empty here', () => {
    // An empty "At Risk" column is information. A board whose columns appear and
    // disappear with the data cannot be read at a glance, and on this book three
    // of the five would never be seen at all.
    const { columns } = pipelineColumns(clients);
    expect(columns).toHaveLength(CLIENT_STAGES.length);
    expect(columns.filter((column) => !column.clients.length)).toHaveLength(3);
  });
});
