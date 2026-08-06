import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TimeOffPanel, { PendingTimeOffNotice } from './TimeOffPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';
import {
  buildCamWorkload,
  distributeClientsEvenly,
  pendingTimeOffAlert,
} from '../domain/camCoverage';

/**
 * WHAT IS REAL HERE AND WHAT IS NOT — read this before trusting a number below.
 *
 * public/local-snapshot.json is the real redacted book, but it does NOT contain
 * cam_time_off or client_coverage: the admin export predates step 34, and
 * scripts/redact-export.mjs does not drop them, it never had them. So the one
 * verification technique this repo relies on — render the real book and read the
 * output — cannot reach this feature end to end.
 *
 * The compensation: everything except the two missing tables is real. The CAMs
 * (8), their books, the clients (96 visible) and every accountRegistry come
 * straight out of the snapshot. The time-off and coverage rows are synthesised
 * here in raw DB row shape (step_34_cam_time_off_and_coverage.sql) using the
 * REAL uuids from the export, then fed through buildCrmStateFromTables — so
 * timeOffFromRow, coverageFromRow and the camIdByUuid/clientIdByUuid remapping
 * (supabaseStore.js:190-217, 532-533) all run for real. A uuid that failed to
 * remap would fall through to the raw uuid and silently match no CAM; the
 * "remaps onto the real book" test below is there to catch exactly that.
 *
 * Numbers asserted here (Reese Glen owns 17 clients; Avery Birch's own book is
 * 30 accounts and Parker Elm's 46; an even split puts 6 clients / 107 accounts
 * onto Avery and 0 onto Marlow Cedar) are read off the real snapshot.
 */

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const tables = snapshot.tables;
const TODAY = '2026-08-06';

const camRowByName = Object.fromEntries(tables.cam_profiles.map((row) => [row.name, row]));
const camUuidByAppId = Object.fromEntries(
  tables.cam_profiles.map((row) => [row.legacy_key || row.id, row.id]),
);
const clientUuidByAppId = Object.fromEntries(
  tables.clients.map((row) => [row.legacy_key || row.id, row.id]),
);

const baseState = buildCrmStateFromTables(tables);
const appCam = (name) => baseState.camProfiles.find((cam) => cam.name === name);

/** A cam_time_off row with every column step_34 defines, defaults included. */
const timeOffRow = (over = {}) => ({
  id: 'to-0',
  cam_profile_id: camRowByName['Reese Glen'].id,
  start_date: '2026-08-24',
  end_date: '2026-08-28',
  kind: 'Vacation',
  note: '',
  status: 'Approved',
  requested_at: '2026-08-01T09:00:00Z',
  decided_at: '2026-08-02T10:00:00Z',
  decided_by: camRowByName['Ellis Glen'].id,
  decision_note: '',
  ...over,
});

/** A client_coverage row with every column step_34 defines. */
const coverageRow = (clientAppId, coveringName, over = {}) => ({
  id: `cov-${clientAppId}`,
  client_id: clientUuidByAppId[clientAppId],
  covering_cam_profile_id: camUuidByAppId[appCam(coveringName).id],
  absent_cam_profile_id: camRowByName['Reese Glen'].id,
  time_off_id: 'to-0',
  start_date: '2026-08-24',
  end_date: '2026-08-28',
  note: '',
  ...over,
});

const stateWith = (timeOffRows, coverageRows) => buildCrmStateFromTables({
  ...tables,
  cam_time_off: timeOffRows,
  client_coverage: coverageRows,
});

const render = (state, props = {}) => renderToStaticMarkup(
  <TimeOffPanel
    camProfiles={state.camProfiles}
    clients={state.clients}
    timeOff={state.timeOff}
    coverage={state.coverage}
    today={TODAY}
    onApprove={() => {}}
    onDeny={() => {}}
    onEndCoverage={() => {}}
    onEditCoverage={() => {}}
    {...props}
  />,
);

const strip = (html) => String(html)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/\s+/g, ' ')
  .trim();

/** Every "Client | Accounts | Covered by" row of the approved distribution. */
function distributionRows(html) {
  const at = html.indexOf('<details class="timeoff-approved"');
  if (at === -1) return [];
  const end = html.indexOf('</details>', at);
  const body = html.slice(at, end);
  return [...body.matchAll(/<tr><td>([^<]*)<\/td><td>(.*?)<\/td><td><select[^>]*>([\s\S]*?)<\/select>/g)]
    .map(([, client, accounts, options]) => {
      const selected = options.match(/<option[^>]*selected=""[^>]*>([^<]*)<\/option>/)
        // renderToStaticMarkup marks the chosen <option> with selected on the
        // <select> value; fall back to reading the select's own value attribute.
        || [null, null];
      return { client: strip(client), accounts: strip(accounts), selected: strip(selected[1] || '') };
    });
}

/** The base → after chips, one per CAM. */
function loadChips(html) {
  return [...html.matchAll(/<li class="coverage-load-chip[^"]*">([\s\S]*?)<\/li>/g)]
    .map(([, chip]) => strip(chip));
}

const reese = appCam('Reese Glen');

/**
 * The distribution the panel's own "Split evenly" produces, stored as rows.
 *
 * Built by running distributeClientsEvenly over the real desk rather than by
 * hand: a hand-written order would be level in client count too, but land the
 * accounts somewhere else, and the account figures are the point of this file.
 */
function evenCoverageRows() {
  const workload = buildCamWorkload(
    baseState.camProfiles.filter((cam) => cam.id !== reese.id),
    baseState.clients,
    { coverage: [], timeOff: [], date: '2026-08-24' },
  );
  const camName = (id) => baseState.camProfiles.find((cam) => cam.id === id).name;
  return distributeClientsEvenly(reese.clientIds, workload)
    .map((row) => coverageRow(row.clientId, camName(row.coveringCamId)));
}

describe('the real book underneath these fixtures', () => {
  it('has no time off or coverage of its own — this is the gap being compensated for', () => {
    expect(tables.cam_time_off).toBeUndefined();
    expect(tables.client_coverage).toBeUndefined();
    expect(baseState.timeOff).toEqual([]);
    expect(baseState.coverage).toEqual([]);
  });

  it('remaps synthesised uuids onto the real book', () => {
    const state = stateWith([timeOffRow()], evenCoverageRows());
    expect(state.coverage).toHaveLength(17);
    // Every row must land on a client and a CAM that actually exist, or the
    // panel would render 17 raw uuids and every count below would be a lie.
    for (const entry of state.coverage) {
      expect(state.clients.some((client) => client.id === entry.clientId)).toBe(true);
      expect(state.camProfiles.some((cam) => cam.id === entry.coveringCamId)).toBe(true);
      expect(entry.absentCamId).toBe(reese.id);
      expect(entry.timeOffId).toBe('to-0');
    }
    expect(reese.clientIds).toHaveLength(17);
  });
});

describe('seeing the distribution after approval', () => {
  it('shows cover arranged for a future window, which the old today-scoped table did not', () => {
    const state = stateWith([timeOffRow()], evenCoverageRows());
    const html = render(state);
    // 2026-08-24 is 18 days after the day on screen: nothing is covered today.
    expect(html).not.toContain('Covered right now');
    expect(strip(html)).toContain('0 pending · 1 approved upcoming · 0 covered today');
    expect(strip(html)).toContain('Approved — who is covering what');
    expect(strip(html)).toContain('Reese Glen · Vacation · 2026-08-24 → 2026-08-28');
    expect(strip(html)).toContain('17/17 covered');
  });

  it('names every client and the CAM who took it', () => {
    const state = stateWith([timeOffRow()], evenCoverageRows());
    const rows = distributionRows(render(state));
    expect(rows).toHaveLength(17);
    const clientName = (id) => state.clients.find((client) => client.id === id).name;
    const expected = state.coverage.map((entry) => ({
      client: clientName(entry.clientId),
      cam: state.camProfiles.find((cam) => cam.id === entry.coveringCamId).name,
    }));
    for (const { client, cam } of expected) {
      const row = rows.find((candidate) => candidate.client === client);
      expect(row, `no row rendered for ${client}`).toBeTruthy();
      expect(row.selected).toContain(cam);
    }
    // Dates come from the stored row, not from "today".
    expect(render(state)).toContain('2026-08-24 → 2026-08-28');
  });

  it('shows the load each CAM ends up with, in clients AND accounts', () => {
    const chips = loadChips(render(stateWith([timeOffRow()], evenCoverageRows())));
    // The whole reason accounts are on screen: an even split by client count is
    // level at 14 clients each and wildly unlevel in work. Avery Birch's own
    // book is 30 accounts and absorbs 107 more; Marlow Cedar absorbs nothing.
    expect(chips).toContain('Avery Birch 8 → 14 clients 30 → 137 accounts');
    expect(chips).toContain('Parker Elm 8 → 14 clients 46 → 102 accounts');
    expect(chips).toContain('Marlow Cedar 13 clients 85 accounts');
    // The absent CAM is never offered as a target for their own cover.
    expect(chips.some((chip) => chip.startsWith('Reese Glen'))).toBe(false);
  });

  it('offers nothing to save on a distribution nobody has touched', () => {
    // Only half of "Save is disabled unless dirty" is reachable without a DOM
    // runner: this file renders the committed state, where there is no draft.
    // The other half — Save becoming clickable once a select moves — is covered
    // by coverageDraftChanges in camCoverage.test.js, which is the function this
    // button's disabled state is computed from.
    const html = render(stateWith([timeOffRow()], evenCoverageRows()));
    const at = html.indexOf('Save cover');
    expect(at, 'no Save button rendered').toBeGreaterThan(-1);
    const openTag = html.slice(0, at).lastIndexOf('<button');
    expect(html.slice(openTag, html.indexOf('>', openTag))).toContain('disabled');
    expect(strip(html)).not.toContain('unsaved changes');
  });

  it('counts a partly-covered request honestly instead of rounding it to fine', () => {
    const rows = evenCoverageRows().slice(0, 12);
    const html = render(stateWith([timeOffRow()], rows));
    expect(strip(html)).toContain('12/17 covered');
    expect(strip(html)).toContain('5 clients with nobody watching');
  });

  it('says so plainly when a request was approved with no cover at all', () => {
    const html = render(stateWith([timeOffRow()], []));
    expect(strip(html)).toContain('0/17 covered');
    expect(strip(html)).toContain('17 clients with nobody watching');
  });
});

describe('awkward cases', () => {
  it('a CAM with no clients has nothing to distribute, and says that rather than showing an empty grid', () => {
    // Manufactured by giving the request to a CAM whose book we empty: the real
    // desk has no clientless CAM, so this case cannot be read off the snapshot.
    const state = stateWith([timeOffRow()], []);
    const stripped = {
      ...state,
      camProfiles: state.camProfiles.map((cam) => (
        cam.id === reese.id ? { ...cam, clientIds: [] } : cam
      )),
    };
    const html = render(stripped);
    expect(strip(html)).toContain('0/0 covered');
    expect(strip(html)).toContain('has no clients on their book, so there was nothing to hand over');
    expect(distributionRows(html)).toHaveLength(0);
  });

  it('refuses a CAM who is themselves on approved leave for those dates', () => {
    const state = stateWith(
      [
        timeOffRow(),
        // Quinn is off for two days inside Reese's five-day window. `away` on
        // the start date alone would miss this — the overlap is what counts.
        timeOffRow({
          id: 'to-1',
          cam_profile_id: camRowByName['Quinn Glen'].id,
          start_date: '2026-08-26',
          end_date: '2026-08-27',
          kind: 'Medical',
        }),
      ],
      evenCoverageRows(),
    );
    const html = render(state);
    const quinnChip = loadChips(html).find((chip) => chip.startsWith('Quinn Glen'));
    expect(quinnChip).toContain('unavailable');
    // Every <option> for Quinn is disabled, in all 17 selects.
    const quinnOptions = [...html.matchAll(new RegExp(`<option value="${appCam('Quinn Glen').id}"[^>]*>`, 'g'))];
    expect(quinnOptions).toHaveLength(17);
    expect(quinnOptions.every(([tag]) => tag.includes('disabled'))).toBe(true);
    expect(strip(html)).toContain('Quinn Glen (13 clients · unavailable)');
  });

  it('shows the refusal reason on a cover already pointing at someone on leave', () => {
    const rows = evenCoverageRows();
    // A cover assigned to Quinn before Quinn's own leave was approved.
    rows[0] = coverageRow(reese.clientIds[0], 'Quinn Glen');
    const state = stateWith(
      [
        timeOffRow(),
        timeOffRow({
          id: 'to-1',
          cam_profile_id: camRowByName['Quinn Glen'].id,
          start_date: '2026-08-26',
          end_date: '2026-08-27',
          kind: 'Medical',
        }),
      ],
      rows,
    );
    const html = render(state);
    expect(strip(html)).toContain('Quinn Glen is on approved medical 2026-08-26 → 2026-08-27');
    // The reason is on the row, not just a greyed-out control. (That Save is
    // also disabled cannot be told apart in static markup from Save being
    // disabled for having no unsaved changes; `blocked` is asserted directly in
    // camCoverage.test.js instead.)
    expect(html).toContain('class="coverage-blocked"');
  });

  it('keeps two overlapping requests as two separate distributions', () => {
    const marlowClients = appCam('Marlow Cedar').clientIds;
    const second = timeOffRow({
      id: 'to-1',
      cam_profile_id: camRowByName['Marlow Cedar'].id,
      start_date: '2026-08-26',
      end_date: '2026-08-30',
      kind: 'Personal',
    });
    const secondCoverage = marlowClients.slice(0, 3).map((clientId) => coverageRow(clientId, 'Ellis Glen', {
      id: `cov2-${clientId}`,
      absent_cam_profile_id: camRowByName['Marlow Cedar'].id,
      time_off_id: 'to-1',
      start_date: '2026-08-26',
      end_date: '2026-08-30',
    }));
    const state = stateWith([timeOffRow(), second], [...evenCoverageRows(), ...secondCoverage]);
    const html = render(state);
    const blocks = html.split('<details class="timeoff-approved"').slice(1);
    expect(blocks).toHaveLength(2);
    expect(strip(blocks[0])).toContain('17/17 covered');
    expect(strip(blocks[1])).toContain('Marlow Cedar · Personal · 2026-08-26 → 2026-08-30');
    expect(strip(blocks[1])).toContain('3/13 covered');
    // The two blocks must agree about the same CAM. Avery ends Reese's request
    // on 14 clients / 137 accounts, so Marlow's block — whose window overlaps —
    // must open with exactly that. This caught a real mismatch: buildCamWorkload
    // counts accounts over owned clients only while counting borrowed ones into
    // totalClients, and the second block read "Avery Birch 14 clients / 30
    // accounts" against the first block's 137.
    expect(loadChips(blocks[0])).toContain('Avery Birch 8 → 14 clients 30 → 137 accounts');
    expect(loadChips(blocks[1])).toContain('Avery Birch 14 clients 137 accounts');
    // Ellis takes 1 from Reese's request plus 3 from Marlow's: 13 own + 1
    // borrowed = 14 clients / 115 accounts base in the second block, 17 / 146
    // after. The borrowed client is counted in BOTH figures or in neither.
    expect(loadChips(blocks[1])).toContain('Ellis Glen 14 → 17 clients 115 → 146 accounts');
    // And the same in the OTHER direction, which is where this was still broken.
    // Marlow's window (08-26 → 08-30) starts INSIDE Reese's (08-24 → 08-28), so
    // sampling the base on Reese's start date could not see the 3 clients Ellis
    // picks up on the 26th: the first block printed "Ellis Glen 13 → 14 clients
    // 114 → 115 accounts" while the second printed 17 / 146 for days the two
    // windows share. buildCamWorkload on 2026-08-27 says 17. Both blocks must
    // land on 17 / 146 — that is the number a manager acts on.
    expect(loadChips(blocks[0])).toContain('Ellis Glen 16 → 17 clients 145 → 146 accounts');
    const onOverlapDay = buildCamWorkload(state.camProfiles, state.clients, {
      coverage: state.coverage, timeOff: state.timeOff, date: '2026-08-27',
    }).find((row) => row.name === 'Ellis Glen');
    expect(onOverlapDay.totalClients).toBe(17);
  });

  it('says how many clients it could not measure instead of counting them as nought accounts', () => {
    // A coverage row pointing at a client this app state has no record for —
    // deleted, or filtered out as Inactive between the write and the read. The
    // uuid does not remap, so it reaches the panel as a raw uuid with no client
    // behind it.
    const rows = evenCoverageRows();
    const orphaned = [...rows.slice(1), { ...rows[0], id: 'cov-orphan', client_id: '00000000-0000-4000-8000-00000000dead' }];
    const html = render(stateWith([timeOffRow()], orphaned));
    // The row itself already refused to guess.
    expect(strip(html)).toContain('not measured');
    // And so does the chip for whoever holds it: an account total that had to
    // skip a client is not the same claim as one that counted them all.
    const chip = loadChips(html).find((entry) => entry.includes('not measured'));
    expect(chip, 'no load chip admitted the unmeasured client').toBeTruthy();
    expect(chip).toContain('(+1 not measured)');
  });

  it('a client whose owning CAM is on leave can still be handed to a covering CAM who is present', () => {
    // Reese away, Quinn away; the panel must still find someone for all 17.
    const state = stateWith(
      [
        timeOffRow(),
        timeOffRow({ id: 'to-1', cam_profile_id: camRowByName['Quinn Glen'].id, kind: 'Medical' }),
      ],
      evenCoverageRows(),
    );
    const html = render(state);
    expect(strip(html)).toContain('17/17 covered');
    const chips = loadChips(html);
    expect(chips.find((chip) => chip.startsWith('Quinn Glen'))).toContain('unavailable');
    // Nobody was actually assigned to Quinn, so nothing is blocked.
    expect(html).not.toContain('coverage-blocked');
  });
});

describe('pending requests still work', () => {
  it('lists a pending request for approval and does not treat it as approved', () => {
    const state = stateWith([timeOffRow({ status: 'Pending', decided_at: null, decided_by: null, note: 'Wedding' })], []);
    const html = render(state);
    expect(strip(html)).toContain('1 pending · 0 approved upcoming · 0 covered today');
    expect(html).toContain('timeoff-request');
    expect(html).not.toContain('timeoff-approved');
    expect(strip(html)).toContain('Wedding');
  });

  it('drops an approved request from the list once its window has passed', () => {
    const state = stateWith(
      [timeOffRow({ start_date: '2026-07-01', end_date: '2026-07-05' })],
      evenCoverageRows().map((row) => ({ ...row, start_date: '2026-07-01', end_date: '2026-07-05' })),
    );
    const html = render(state);
    expect(strip(html)).toContain('0 pending · 0 approved upcoming · 0 covered today');
    expect(html).not.toContain('timeoff-approved');
  });

  it('still shows cover that is live today in the Covered right now table', () => {
    const state = stateWith(
      [timeOffRow({ start_date: '2026-08-04', end_date: '2026-08-08' })],
      evenCoverageRows().map((row) => ({ ...row, start_date: '2026-08-04', end_date: '2026-08-08' })),
    );
    const html = render(state);
    expect(strip(html)).toContain('17 covered today');
    expect(strip(html)).toContain('Covered right now');
  });
});

describe('the pending-request alert', () => {
  const alertFor = (timeOffRows, today = TODAY) => pendingTimeOffAlert(
    stateWith(timeOffRows, []).timeOff,
    today,
  );
  const renderNotice = (timeOffRows, today) => renderToStaticMarkup(
    <PendingTimeOffNotice
      alert={alertFor(timeOffRows, today)}
      camProfiles={baseState.camProfiles}
    />,
  );
  const pendingRow = (over) => timeOffRow({
    status: 'Pending', decided_at: null, decided_by: null, ...over,
  });

  it('renders nothing at all when no request is undecided', () => {
    expect(renderNotice([timeOffRow()])).toBe('');
    expect(renderNotice([])).toBe('');
  });

  it('names the CAM, the reason and the dates so the manager can triage without scrolling', () => {
    const html = renderNotice([
      pendingRow({ id: 'p1', start_date: '2026-09-01', end_date: '2026-09-03', kind: 'Personal' }),
      pendingRow({
        id: 'p2',
        cam_profile_id: camRowByName['Marlow Cedar'].id,
        start_date: '2026-08-20',
        end_date: '2026-08-20',
        kind: 'Medical',
      }),
    ]);
    expect(strip(html)).toBe(
      '2 time-off requests waiting on you - Reese Glen (Personal, 2026-09-01 → 2026-09-03), '
      + 'Marlow Cedar (Medical, 2026-08-20). Approve or deny in Time off & coverage below.',
    );
    expect(html).toContain('class="notice warning"');
    // Points at the panel that can actually action it.
    expect(html).toContain('href="#timeoff-coverage"');
  });

  it('counts only undecided requests, never the size of the table', () => {
    const html = renderNotice([
      pendingRow({ id: 'p1' }),
      timeOffRow({ id: 'a1', status: 'Approved' }),
      timeOffRow({ id: 'd1', status: 'Denied' }),
      timeOffRow({ id: 'c1', status: 'Cancelled' }),
    ]);
    // One pending among four rows: the alert must read 1, not 4, and must not
    // name the three decided ones.
    expect(strip(html)).toMatch(/^1 time-off request waiting on you/);
    expect(strip(html).match(/Reese Glen \(/g)).toHaveLength(1);
  });

  it('calls out requests whose dates have already gone by', () => {
    const html = renderNotice([
      pendingRow({ id: 'p1', start_date: '2026-09-01', end_date: '2026-09-03' }),
      pendingRow({ id: 'p2', start_date: '2026-07-01', end_date: '2026-07-02' }),
    ]);
    expect(strip(html)).toContain('2 time-off requests waiting on you');
    expect(strip(html)).toContain('1 of them is for dates that have already passed.');
  });

  it('claims nothing about stale dates when the day on screen is unreadable', () => {
    const html = renderNotice([pendingRow({ id: 'p1' })], 'whenever');
    expect(strip(html)).toContain('1 time-off request waiting on you');
    expect(strip(html)).not.toContain('already passed');
  });
});
