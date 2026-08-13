import { describe, expect, it } from 'vitest';
import {
  TIME_OFF_STATUSES,
  activeCoverageFor,
  buildCamRecord,
  buildCamWorkload,
  buildCoverageDistribution,
  conflictingTimeOff,
  coverageBlockReason,
  coverageDraftChanges,
  coverageForClient,
  coverageForRequest,
  coversDate,
  distributeClientsEvenly,
  effectiveClientIds,
  isActiveTimeOff,
  isCurrentOrUpcoming,
  overlapsOwnTimeOff,
  overlapsRange,
  pendingTimeOffAlert,
} from './camCoverage';

const cam = (id, name, clientIds = []) => ({ id, name, clientIds });
const cover = (clientId, coveringCamId, startDate, endDate) => ({
  clientId, coveringCamId, absentCamId: 'peter', startDate, endDate,
});
const request = (over = {}) => ({
  id: 'r1', camProfileId: 'peter', startDate: '2026-08-10', endDate: '2026-08-14',
  status: TIME_OFF_STATUSES.APPROVED, ...over,
});

/*
 * Schema-faithful factories for the coverage-distribution tests below.
 *
 * The `cover()` and `request()` factories above have drifted from what the
 * store actually produces: `cover()` has no `id` (the row's identity, which
 * handleEndCoverage reads) and no `timeOffId` (the key the whole per-request
 * view is grouped by), and hardcodes absentCamId: 'peter' whoever is away.
 * These two mirror coverageFromRow and timeOffFromRow field for field
 * (supabaseStore.js:190-217), so a column that stops being mapped shows up
 * here. They are used by everything from 'coverage grouped by request' down.
 */
const coverRow = (over = {}) => ({
  id: 'cov1',
  clientId: 'c1',
  coveringCamId: 'sam',
  absentCamId: 'peter',
  timeOffId: 'r1',
  startDate: '2026-08-10',
  endDate: '2026-08-14',
  note: '',
  ...over,
});
const timeOffRecord = (over = {}) => ({
  id: 'r1',
  camProfileId: 'peter',
  camUuid: '00000000-0000-0000-0000-0000000000p1',
  startDate: '2026-08-10',
  endDate: '2026-08-14',
  kind: 'Vacation',
  note: '',
  status: TIME_OFF_STATUSES.APPROVED,
  requestedAt: '2026-08-01T09:00:00Z',
  decidedAt: '2026-08-02T09:00:00Z',
  decisionNote: '',
  ...over,
});

describe('the strings that actually reach the database', () => {
  it('pins cam_time_off.status to the exact values the writers send', () => {
    // status is plain `text` with no check constraint
    // (step_34_cam_time_off_and_coverage.sql:17), and THREE separate string
    // literals write it, none of which reference this object:
    // requestSupabaseTimeOff inserts 'Pending' (supabaseStore.js:980), and
    // App.jsx calls decideSupabaseTimeOff with "Approved" (:12508) and "Denied"
    // (:12586). Rename a value here and every stored row keeps its old spelling:
    // isActiveTimeOff returns false for every approved absence, the panel reports
    // "0 approved upcoming", no coverage is ever in force — and nothing fails,
    // because every test builds its own rows from this same object.
    expect(TIME_OFF_STATUSES).toEqual({
      PENDING: 'Pending', APPROVED: 'Approved', DENIED: 'Denied', CANCELLED: 'Cancelled',
    });
  });
});

describe('date windows', () => {
  it('treats both ends as inclusive', () => {
    expect(overlapsRange('2026-08-10', '2026-08-14', '2026-08-14', '2026-08-20')).toBe(true);
    expect(overlapsRange('2026-08-10', '2026-08-14', '2026-08-15', '2026-08-20')).toBe(false);
  });

  it('handles a single-day absence with no end date', () => {
    expect(coversDate({ startDate: '2026-08-10', endDate: '' }, '2026-08-10')).toBe(true);
    expect(coversDate({ startDate: '2026-08-10', endDate: '' }, '2026-08-11')).toBe(false);
  });

  it('ignores malformed dates instead of matching everything', () => {
    expect(coversDate({ startDate: 'soon', endDate: '' }, '2026-08-10')).toBe(false);
    expect(coversDate({ startDate: '2026-08-10' }, '')).toBe(false);
  });
});

describe('effectiveClientIds', () => {
  const peter = cam('peter', 'Peter', ['c1', 'c2']);
  const sam = cam('sam', 'Sam', ['c9']);

  it('adds covered clients without taking any away', () => {
    const coverage = [cover('c1', 'sam', '2026-08-10', '2026-08-14')];
    expect([...effectiveClientIds(sam, coverage, '2026-08-12')].sort()).toEqual(['c1', 'c9']);
    // the absent CAM keeps their own book
    expect([...effectiveClientIds(peter, coverage, '2026-08-12')].sort()).toEqual(['c1', 'c2']);
  });

  it('stops covering once the window closes', () => {
    const coverage = [cover('c1', 'sam', '2026-08-10', '2026-08-14')];
    expect([...effectiveClientIds(sam, coverage, '2026-08-15')]).toEqual(['c9']);
  });

  it('is unaffected by coverage belonging to someone else', () => {
    const coverage = [cover('c1', 'other', '2026-08-10', '2026-08-14')];
    expect([...effectiveClientIds(sam, coverage, '2026-08-12')]).toEqual(['c9']);
  });
});

describe('coverage lookups', () => {
  const coverage = [cover('c1', 'sam', '2026-08-10', '2026-08-14')];

  it('lists what a CAM is covering today', () => {
    expect(activeCoverageFor(coverage, 'sam', '2026-08-12')).toHaveLength(1);
    expect(activeCoverageFor(coverage, 'sam', '2026-09-01')).toHaveLength(0);
  });

  it('says who is covering a client', () => {
    expect(coverageForClient(coverage, 'c1', '2026-08-12').coveringCamId).toBe('sam');
    expect(coverageForClient(coverage, 'c2', '2026-08-12')).toBeNull();
  });
});

describe('time off validation', () => {
  it('only counts approved requests as active', () => {
    expect(isActiveTimeOff(request(), '2026-08-12')).toBe(true);
    expect(isActiveTimeOff(request({ status: TIME_OFF_STATUSES.PENDING }), '2026-08-12')).toBe(false);
  });

  it('surfaces other people already approved for the same days', () => {
    const existing = [
      request({ id: 'r0', camProfileId: 'sam', startDate: '2026-08-12', endDate: '2026-08-13' }),
      request({ id: 'r2', camProfileId: 'ana', startDate: '2026-09-01', endDate: '2026-09-05' }),
      request({ id: 'r3', camProfileId: 'leo', startDate: '2026-08-12', endDate: '2026-08-13', status: TIME_OFF_STATUSES.PENDING }),
    ];
    const conflicts = conflictingTimeOff(existing, request({ id: 'r1', camProfileId: 'peter' }));
    expect(conflicts.map((c) => c.camProfileId)).toEqual(['sam']);
  });

  it('catches a CAM double-booking their own days', () => {
    const existing = [request({ id: 'r0', startDate: '2026-08-12', endDate: '2026-08-13' })];
    expect(overlapsOwnTimeOff(existing, request({ id: 'r1' }))).toBe(true);
    expect(overlapsOwnTimeOff(existing, request({ id: 'r1', startDate: '2026-09-01', endDate: '2026-09-02' }))).toBe(false);
  });

  it('ignores denied and cancelled requests when checking overlap', () => {
    const existing = [request({ id: 'r0', status: TIME_OFF_STATUSES.DENIED })];
    expect(overlapsOwnTimeOff(existing, request({ id: 'r1' }))).toBe(false);
  });
});

describe('buildCamWorkload', () => {
  const camProfiles = [cam('peter', 'Peter', ['c1', 'c2', 'c3']), cam('sam', 'Sam', ['c9']), cam('ana', 'Ana', [])];
  const clients = [
    { id: 'c1', accountRegistry: { a: {}, b: {} } },
    { id: 'c2', accountRegistry: { a: {} } },
    { id: 'c3', accountRegistry: {} },
    { id: 'c9', accountRegistry: { a: {} } },
  ];

  it('sorts by who has room, counting coverage as load', () => {
    const rows = buildCamWorkload(camProfiles, clients, {
      coverage: [cover('c1', 'sam', '2026-08-10', '2026-08-14')],
      date: '2026-08-12',
    });
    expect(rows.map((r) => r.camProfileId)).toEqual(['ana', 'sam', 'peter']);
    expect(rows.find((r) => r.camProfileId === 'sam')).toMatchObject({ ownClients: 1, coveringClients: 1, totalClients: 2 });
    expect(rows.find((r) => r.camProfileId === 'peter').accounts).toBe(3);
  });

  it('marks whoever is away that day', () => {
    const rows = buildCamWorkload(camProfiles, clients, {
      timeOff: [request({ camProfileId: 'sam' })],
      date: '2026-08-12',
    });
    expect(rows.find((r) => r.camProfileId === 'sam').away).toBe(true);
    expect(rows.find((r) => r.camProfileId === 'ana').away).toBe(false);
  });
});

describe('distributeClientsEvenly', () => {
  it('gives each client to whoever is carrying least', () => {
    const workload = [
      { camProfileId: 'ana', totalClients: 0, away: false },
      { camProfileId: 'sam', totalClients: 1, away: false },
    ];
    expect(distributeClientsEvenly(['c1', 'c2', 'c3'], workload)).toEqual([
      { clientId: 'c1', coveringCamId: 'ana' },
      { clientId: 'c2', coveringCamId: 'ana' },
      { clientId: 'c3', coveringCamId: 'sam' },
    ]);
  });

  it('never hands work to someone who is also away', () => {
    const workload = [
      { camProfileId: 'ana', totalClients: 0, away: true },
      { camProfileId: 'sam', totalClients: 5, away: false },
    ];
    expect(distributeClientsEvenly(['c1'], workload)).toEqual([{ clientId: 'c1', coveringCamId: 'sam' }]);
  });

  it('returns nothing when there is no one available', () => {
    expect(distributeClientsEvenly(['c1'], [{ camProfileId: 'ana', totalClients: 0, away: true }])).toEqual([]);
    expect(distributeClientsEvenly([], [{ camProfileId: 'ana', totalClients: 0, away: false }])).toEqual([]);
  });
});

describe('buildCamRecord', () => {
  const peter = cam('peter', 'Peter', ['c1', 'c2']);
  const clients = [{ id: 'c1', accountRegistry: { a: {}, b: {} } }, { id: 'c2', accountRegistry: { a: {} } }];

  it('summarises what the CAM carries and their time off', () => {
    const record = buildCamRecord(peter, clients, {
      coverage: [cover('c9', 'peter', '2026-08-01', '2026-08-05')],
      timeOff: [
        request({ id: 'r1', startDate: '2026-08-01', endDate: '2026-08-05' }),
        request({ id: 'r2', startDate: '2026-09-01', endDate: '2026-09-01' }),
        request({ id: 'r3', startDate: '2026-10-01', endDate: '2026-10-02', status: TIME_OFF_STATUSES.PENDING }),
      ],
      date: '2026-08-03',
    });
    expect(record).toMatchObject({ clients: 2, accounts: 3, covering: 1, away: true, pendingRequests: 1 });
    expect(record.approvedDaysOff).toBe(6); // 5 days + 1 single day
    expect(record.nextTimeOff.id).toBe('r2');
  });

  it('handles a CAM with nothing on record', () => {
    expect(buildCamRecord(cam('new', 'New'), [], { date: '2026-08-03' })).toMatchObject({
      clients: 0, accounts: 0, covering: 0, away: false, approvedDaysOff: 0, nextTimeOff: null,
    });
  });
});

describe('coverage grouped by request', () => {
  const coverage = [
    coverRow({ id: 'a', clientId: 'c1', coveringCamId: 'sam', timeOffId: 'r1' }),
    coverRow({ id: 'b', clientId: 'c2', coveringCamId: 'ana', timeOffId: 'r1' }),
    coverRow({ id: 'c', clientId: 'c9', coveringCamId: 'sam', timeOffId: 'r2', absentCamId: 'leo' }),
    // A manager arranging cover with no request behind it: time_off_id is null
    // in the DB and arrives as ''. It must belong to no request, not to all.
    coverRow({ id: 'd', clientId: 'c8', coveringCamId: 'ana', timeOffId: '' }),
  ];

  it('returns every row for a request whatever its dates', () => {
    expect(coverageForRequest(coverage, 'r1').map((row) => row.id)).toEqual(['a', 'b']);
    expect(coverageForRequest(coverage, 'r2').map((row) => row.id)).toEqual(['c']);
  });

  it('matches nothing on a missing request id rather than everything', () => {
    expect(coverageForRequest(coverage, '')).toEqual([]);
    expect(coverageForRequest(coverage, null)).toEqual([]);
    expect(coverageForRequest(coverage, undefined)).toEqual([]);
  });
});

describe('coverageBlockReason', () => {
  const req = timeOffRecord({ startDate: '2026-08-10', endDate: '2026-08-14' });

  it('allows a CAM with nothing in the way', () => {
    expect(coverageBlockReason('sam', req, [req])).toBeNull();
  });

  it('refuses the CAM who is taking the time off', () => {
    expect(coverageBlockReason('peter', req, [req])).toBe('is the CAM taking this time off');
  });

  it('refuses a CAM on approved leave that overlaps, and says which leave', () => {
    const timeOff = [req, timeOffRecord({
      id: 'r2', camProfileId: 'sam', startDate: '2026-08-13', endDate: '2026-08-18', kind: 'Medical',
    })];
    expect(coverageBlockReason('sam', req, timeOff))
      .toBe('is on approved medical 2026-08-13 → 2026-08-18');
  });

  it('catches leave that only touches the middle of the window', () => {
    // A one-day absence on day 3. `away` on the request's START date — which is
    // what buildCamWorkload reports — is false here, so a check built on that
    // alone would wave this through.
    const timeOff = [req, timeOffRecord({
      id: 'r2', camProfileId: 'sam', startDate: '2026-08-12', endDate: '2026-08-12', kind: 'Personal',
    })];
    expect(buildCamWorkload([cam('sam', 'Sam')], [], { timeOff, date: '2026-08-10' })[0].away).toBe(false);
    expect(coverageBlockReason('sam', req, timeOff)).toBe('is on approved personal 2026-08-12');
  });

  it('does not refuse over a request that is only pending, denied or cancelled', () => {
    for (const status of [TIME_OFF_STATUSES.PENDING, TIME_OFF_STATUSES.DENIED, TIME_OFF_STATUSES.CANCELLED]) {
      const timeOff = [req, timeOffRecord({ id: 'r2', camProfileId: 'sam', status })];
      expect(coverageBlockReason('sam', req, timeOff)).toBeNull();
    }
  });

  it('does not refuse over leave that ends before the window opens', () => {
    const timeOff = [req, timeOffRecord({
      id: 'r2', camProfileId: 'sam', startDate: '2026-08-01', endDate: '2026-08-09',
    })];
    expect(coverageBlockReason('sam', req, timeOff)).toBeNull();
  });

  it('treats "nobody" as allowed, not as a refusal', () => {
    expect(coverageBlockReason('', req, [req])).toBeNull();
  });
});

describe('buildCoverageDistribution', () => {
  const camProfiles = [
    cam('peter', 'Peter', ['c1', 'c2', 'c3']),
    cam('sam', 'Sam', ['c9']),
    cam('ana', 'Ana', []),
    cam('leo', 'Leo', ['c7', 'c8']),
  ];
  const clients = [
    { id: 'c1', name: 'One', accountRegistry: { a: {}, b: {}, c: {} } },
    { id: 'c2', name: 'Two', accountRegistry: { a: {} } },
    { id: 'c3', name: 'Three', accountRegistry: {} },
    { id: 'c7', name: 'Seven', accountRegistry: { a: {} } },
    { id: 'c8', name: 'Eight', accountRegistry: { a: {} } },
    { id: 'c9', name: 'Nine', accountRegistry: { a: {}, b: {} } },
  ];
  const req = timeOffRecord();
  const coverage = [
    coverRow({ id: 'a', clientId: 'c1', coveringCamId: 'sam' }),
    coverRow({ id: 'b', clientId: 'c2', coveringCamId: 'ana' }),
  ];
  const build = (over = {}) => buildCoverageDistribution(req, {
    coverage, camProfiles, clients, timeOff: [req], ...over,
  });

  it('lists every client of the absent CAM, covered or not', () => {
    const dist = build();
    expect(dist.rows.map((row) => [row.clientName, row.coveringCamName])).toEqual([
      ['One', 'Sam'], ['Two', 'Ana'], ['Three', ''],
    ]);
    expect(dist).toMatchObject({ clientsToCover: 3, covered: 2, uncovered: 1, blocked: 0 });
    expect(dist.absentCamName).toBe('Peter');
  });

  it('carries the stored row id, dates and note through so the row can be acted on', () => {
    const dist = build();
    expect(dist.rows[0]).toMatchObject({
      coverageId: 'a', clientId: 'c1', startDate: '2026-08-10', endDate: '2026-08-14',
    });
    // A client with no row yet has no id — null, because "no row" and "a row
    // with a blank id" are different things and the delete button reads this.
    expect(dist.rows[2].coverageId).toBeNull();
  });

  it('does not count this request\'s own coverage into the base load', () => {
    // Sam owns 1 client and is covering 1 for THIS request. The base must read
    // 1, not 2 — buildCamWorkload counts active coverage into totalClients, so
    // feeding it the unfiltered list reports Sam's load one too high before the
    // manager has touched anything, and the "after" figure two too high.
    const sam = build().byCam.find((row) => row.camProfileId === 'sam');
    expect(sam).toMatchObject({ baseClients: 1, addedClients: 1, totalClients: 2 });
  });

  it('does count coverage belonging to a different request into the base load', () => {
    const withOther = [...coverage, coverRow({
      id: 'z', clientId: 'c7', coveringCamId: 'sam', timeOffId: 'r9', absentCamId: 'leo',
    })];
    const sam = build({ coverage: withOther }).byCam.find((row) => row.camProfileId === 'sam');
    expect(sam).toMatchObject({ baseClients: 2, addedClients: 1, totalClients: 3 });
    // Clients and accounts must be measured over the SAME set. buildCamWorkload
    // counts accounts on owned clients only while counting borrowed ones into
    // totalClients, which on the real book printed "Avery Birch 14 clients / 30
    // accounts" for a CAM already carrying 6 borrowed clients worth 107
    // accounts. Sam owns c9 (2 accounts) and already borrows c7 (1) = 3, then
    // takes c1 (3) here = 6.
    expect(sam).toMatchObject({ baseAccounts: 3, addedAccounts: 3, totalAccounts: 6 });
  });

  it('reports accounts as well as clients, and never counts the absent CAM', () => {
    const dist = build();
    expect(dist.byCam.map((row) => row.camProfileId).sort()).toEqual(['ana', 'leo', 'sam']);
    // Sam owns c9 (2 accounts) and takes c1 (3 accounts).
    expect(dist.byCam.find((row) => row.camProfileId === 'sam'))
      .toMatchObject({ baseAccounts: 2, addedAccounts: 3, totalAccounts: 5 });
    // Ana owns nothing and takes c2 (1 account).
    expect(dist.byCam.find((row) => row.camProfileId === 'ana'))
      .toMatchObject({ baseAccounts: 0, addedAccounts: 1, totalAccounts: 1 });
    // Leo takes nothing: base and total agree, so the chip renders one figure.
    expect(dist.byCam.find((row) => row.camProfileId === 'leo'))
      .toMatchObject({ addedClients: 0, baseClients: 2, totalClients: 2 });
  });

  it('previews a draft without touching what is stored', () => {
    const draft = [{ clientId: 'c1', coveringCamId: 'leo' }, { clientId: 'c2', coveringCamId: 'ana' }];
    const after = build({ assignments: draft });
    expect(after.rows[0].coveringCamName).toBe('Leo');
    // Same function, same numbers: Leo picks up c1's 3 accounts, Sam drops them.
    expect(after.byCam.find((row) => row.camProfileId === 'leo'))
      .toMatchObject({ baseClients: 2, totalClients: 3, baseAccounts: 2, totalAccounts: 5 });
    expect(after.byCam.find((row) => row.camProfileId === 'sam'))
      .toMatchObject({ addedClients: 0, totalClients: 1 });
    // The stored view is unchanged.
    expect(build().rows[0].coveringCamName).toBe('Sam');
  });

  it('removes a cover when the draft drops the client', () => {
    const after = build({ assignments: [{ clientId: 'c2', coveringCamId: 'ana' }] });
    expect(after).toMatchObject({ covered: 1, uncovered: 2 });
    expect(after.rows.find((row) => row.clientId === 'c1').coveringCamId).toBe('');
    // The stored row id survives on the row, so the UI can still name what it
    // is about to delete.
    expect(after.rows.find((row) => row.clientId === 'c1').coverageId).toBe('a');
  });

  it('flags an assignment pointed at a CAM on approved leave', () => {
    const timeOff = [req, timeOffRecord({
      id: 'r2', camProfileId: 'sam', startDate: '2026-08-12', endDate: '2026-08-12', kind: 'Medical',
    })];
    const dist = build({ timeOff });
    expect(dist.blocked).toBe(1);
    expect(dist.rows[0].blockedReason).toBe('is on approved medical 2026-08-12');
    expect(dist.byCam.find((row) => row.camProfileId === 'sam').blockedReason)
      .toBe('is on approved medical 2026-08-12');
    expect(dist.byCam.find((row) => row.camProfileId === 'ana').blockedReason).toBeNull();
  });

  it('handles a request with no clients to distribute at all', () => {
    const dist = buildCoverageDistribution(timeOffRecord({ id: 'r5', camProfileId: 'ana' }), {
      coverage: [], camProfiles, clients, timeOff: [],
    });
    expect(dist).toMatchObject({ clientsToCover: 0, covered: 0, uncovered: 0, blocked: 0 });
    expect(dist.rows).toEqual([]);
    expect(dist.byCam).toHaveLength(3);
  });

  it('still shows a client the absent CAM no longer owns but is still covered', () => {
    // A transfer mid-window leaves a real coverage row behind. Dropping it from
    // the table would hide a cover that is still in force.
    const orphan = [...coverage, coverRow({ id: 'x', clientId: 'c9', coveringCamId: 'leo' })];
    const dist = build({ coverage: orphan });
    expect(dist.rows.map((row) => row.clientId)).toEqual(['c1', 'c2', 'c3', 'c9']);
    expect(dist.rows[3]).toMatchObject({ coveringCamName: 'Leo', coverageId: 'x' });
  });

  it('says "not measured" rather than zero for a client it cannot find', () => {
    const dist = build({ clients: clients.filter((client) => client.id !== 'c1') });
    const row = dist.rows.find((entry) => entry.clientId === 'c1');
    expect(row.accounts).toBeNull();
    expect(row.clientName).toBe('c1');
  });

  it('counts cover that starts LATER in the window, not only what is live on day one', () => {
    // Leo covers c7 for Peter's colleague from day 3 of Peter's own window.
    // Sampling the base on the start date alone made this invisible, so the
    // chip read "Leo 2 clients" for a window in which Leo carries 3 — while the
    // other request's block, whose start date sat inside this window, read 3.
    // Two totals for one CAM over the same days, one scroll apart.
    const later = [...coverage, coverRow({
      id: 'z', clientId: 'c9', coveringCamId: 'leo', timeOffId: 'r9',
      absentCamId: 'sam', startDate: '2026-08-13', endDate: '2026-08-20',
    })];
    const leo = build({ coverage: later }).byCam.find((row) => row.camProfileId === 'leo');
    // Leo owns c7 + c8 (1 account each) and borrows c9 (2 accounts) from day 3.
    expect(leo).toMatchObject({ baseClients: 3, baseAccounts: 4 });
  });

  it('ignores cover that ends before the window opens', () => {
    const earlier = [...coverage, coverRow({
      id: 'z', clientId: 'c9', coveringCamId: 'leo', timeOffId: 'r9',
      absentCamId: 'sam', startDate: '2026-08-01', endDate: '2026-08-09',
    })];
    const leo = build({ coverage: earlier }).byCam.find((row) => row.camProfileId === 'leo');
    expect(leo).toMatchObject({ baseClients: 2, baseAccounts: 2 });
  });

  it('counts one client once even when two rows cover them inside the window', () => {
    // Legal under the unique key: same client, same covering CAM, different
    // spans. Two rows is still one client's worth of work.
    const twice = [...coverage,
      coverRow({ id: 'y', clientId: 'c9', coveringCamId: 'leo', timeOffId: 'r9', startDate: '2026-08-10', endDate: '2026-08-11' }),
      coverRow({ id: 'z', clientId: 'c9', coveringCamId: 'leo', timeOffId: 'r9', startDate: '2026-08-12', endDate: '2026-08-13' }),
    ];
    const leo = build({ coverage: twice }).byCam.find((row) => row.camProfileId === 'leo');
    expect(leo).toMatchObject({ baseClients: 3, baseAccounts: 4 });
  });

  it('marks a CAM away for leave touching any day of the window, like the refusal does', () => {
    // `away` and `blockedReason` sat on the same chip answering the same
    // question two different ways: one sampled the start date, the other the
    // whole window, so a CAM off on day 3 rendered away:false beside
    // "unavailable".
    const timeOff = [req, timeOffRecord({
      id: 'r2', camProfileId: 'sam', startDate: '2026-08-12', endDate: '2026-08-12', kind: 'Medical',
    })];
    const sam = build({ timeOff }).byCam.find((row) => row.camProfileId === 'sam');
    expect(sam.away).toBe(true);
    expect(sam.blockedReason).toBe('is on approved medical 2026-08-12');
  });

  it('does not mark a CAM away over leave nobody has approved', () => {
    // `away` feeds "Split evenly" (TimeOffPanel proposeEven passes it straight
    // into distributeClientsEvenly), so a CAM who is merely away-on-paper gets
    // silently skipped and everyone else absorbs their share — with no
    // "unavailable" badge to explain it, because blockedReason stays null for
    // an undecided request. Asking for leave is not being granted it.
    for (const status of [TIME_OFF_STATUSES.PENDING, TIME_OFF_STATUSES.DENIED, TIME_OFF_STATUSES.CANCELLED]) {
      const timeOff = [req, timeOffRecord({ id: 'r2', camProfileId: 'sam', status })];
      const sam = build({ timeOff }).byCam.find((row) => row.camProfileId === 'sam');
      expect(sam.away, `status ${status} must not count as away`).toBe(false);
      expect(sam.blockedReason).toBeNull();
    }
  });

  it('reports unmeasured clients rather than folding them into the account total', () => {
    // c1 has 3 accounts and goes to Sam. Drop c1's record: the row already says
    // "not measured", and the chip must not print 2 as though 3 + nothing = 2.
    const dist = build({ clients: clients.filter((client) => client.id !== 'c1') });
    const sam = dist.byCam.find((row) => row.camProfileId === 'sam');
    expect(sam).toMatchObject({ baseAccounts: 2, addedAccounts: 0, totalAccounts: 2, totalUnmeasured: 1 });
    // Everyone else counted every client they hold.
    expect(dist.byCam.find((row) => row.camProfileId === 'ana').totalUnmeasured).toBe(0);
  });

  it('falls back to the caller\'s date when the request start date is unusable', () => {
    const broken = timeOffRecord({ startDate: 'next week', endDate: '' });
    const dist = buildCoverageDistribution(broken, {
      coverage: [], camProfiles, clients, date: '2026-08-12',
      timeOff: [broken, timeOffRecord({ id: 'r2', camProfileId: 'sam', startDate: '2026-08-12', endDate: '2026-08-12' })],
    });
    expect(dist.startDate).toBe('');
    expect(dist.byCam.find((row) => row.camProfileId === 'sam').away).toBe(true);
  });
});

describe('coverageDraftChanges', () => {
  // Exactly the shape ApprovedCoverageRow holds: the committed rows, and a plan
  // keyed by clientId. This decides whether Save is clickable, so a wrong answer
  // either loses the manager's edit or offers to save nothing.
  const rows = [
    { clientId: 'c1', coveringCamId: 'sam' },
    { clientId: 'c2', coveringCamId: 'ana' },
    { clientId: 'c3', coveringCamId: '' },
  ];
  const committedPlan = { c1: 'sam', c2: 'ana', c3: '' };

  it('sees nothing to save when the plan still matches what is stored', () => {
    expect(coverageDraftChanges(rows, committedPlan)).toEqual([]);
    // An untouched client is absent from the plan, not present as ''. Both mean
    // "nobody", and comparing them naively would report a change on every row.
    expect(coverageDraftChanges(rows, { c1: 'sam', c2: 'ana' })).toEqual([]);
  });

  it('sees a reassignment', () => {
    expect(coverageDraftChanges(rows, { ...committedPlan, c1: 'leo' }).map((r) => r.clientId)).toEqual(['c1']);
  });

  it('sees a cover being removed', () => {
    expect(coverageDraftChanges(rows, { ...committedPlan, c2: '' }).map((r) => r.clientId)).toEqual(['c2']);
  });

  it('sees an uncovered client being given to someone', () => {
    expect(coverageDraftChanges(rows, { ...committedPlan, c3: 'leo' }).map((r) => r.clientId)).toEqual(['c3']);
  });

  it('sees nothing after a change is undone', () => {
    expect(coverageDraftChanges(rows, { ...committedPlan, c1: 'leo', ...{ c1: 'sam' } })).toEqual([]);
  });

  it('reports every changed row, not just the first', () => {
    expect(coverageDraftChanges(rows, { c1: 'leo', c2: '', c3: 'ana' })).toHaveLength(3);
  });
});

describe('pendingTimeOffAlert', () => {
  const timeOff = [
    timeOffRecord({ id: 'r1', status: TIME_OFF_STATUSES.PENDING, startDate: '2026-09-01', endDate: '2026-09-03' }),
    timeOffRecord({ id: 'r2', status: TIME_OFF_STATUSES.PENDING, startDate: '2026-08-20', endDate: '2026-08-21' }),
    timeOffRecord({ id: 'r3', status: TIME_OFF_STATUSES.PENDING, startDate: '2026-07-01', endDate: '2026-07-02' }),
    timeOffRecord({ id: 'r4', status: TIME_OFF_STATUSES.APPROVED }),
    timeOffRecord({ id: 'r5', status: TIME_OFF_STATUSES.DENIED }),
    timeOffRecord({ id: 'r6', status: TIME_OFF_STATUSES.CANCELLED }),
  ];

  it('counts only requests nobody has decided', () => {
    const alert = pendingTimeOffAlert(timeOff, '2026-08-06');
    expect(alert.pending).toBe(3);
    expect(alert.requests.map((row) => row.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('separates the ones still worth deciding from the ones already past', () => {
    const alert = pendingTimeOffAlert(timeOff, '2026-08-06');
    expect(alert).toMatchObject({ actionable: 2, expired: 1, soonest: '2026-08-20' });
  });

  it('counts a request whose window is running today as actionable', () => {
    const alert = pendingTimeOffAlert(
      [timeOffRecord({ status: TIME_OFF_STATUSES.PENDING, startDate: '2026-08-01', endDate: '2026-08-06' })],
      '2026-08-06',
    );
    expect(alert).toMatchObject({ pending: 1, actionable: 1, expired: 0 });
  });

  it('returns null, not zero, for the day-relative split when the date is unusable', () => {
    const alert = pendingTimeOffAlert(timeOff, 'soon');
    expect(alert.pending).toBe(3);
    expect(alert.actionable).toBeNull();
    expect(alert.expired).toBeNull();
    expect(alert.soonest).toBeNull();
  });

  it('reports a quiet desk as zero rather than as unknown', () => {
    expect(pendingTimeOffAlert([], '2026-08-06'))
      .toMatchObject({ pending: 0, actionable: 0, expired: 0, soonest: null });
  });
});

describe('isCurrentOrUpcoming', () => {
  it('keeps a window that ends today and drops one that ended yesterday', () => {
    expect(isCurrentOrUpcoming({ startDate: '2026-08-01', endDate: '2026-08-06' }, '2026-08-06')).toBe(true);
    expect(isCurrentOrUpcoming({ startDate: '2026-08-01', endDate: '2026-08-05' }, '2026-08-06')).toBe(false);
  });

  it('keeps a window that has not started yet', () => {
    expect(isCurrentOrUpcoming({ startDate: '2026-09-01', endDate: '2026-09-03' }, '2026-08-06')).toBe(true);
  });

  it('treats a missing end date as a single day', () => {
    expect(isCurrentOrUpcoming({ startDate: '2026-08-06', endDate: '' }, '2026-08-06')).toBe(true);
    expect(isCurrentOrUpcoming({ startDate: '2026-08-05', endDate: '' }, '2026-08-06')).toBe(false);
  });

  it('fails closed on dates it cannot read, rather than matching everything', () => {
    // A raw string compare would put 'soon' after '2026-...' and keep the row
    // on screen forever; a Postgres timestamp is truncated to its date instead.
    expect(isCurrentOrUpcoming({ startDate: 'soon', endDate: '' }, '2026-08-06')).toBe(false);
    expect(isCurrentOrUpcoming({ startDate: '2026-08-06', endDate: '' }, 'today')).toBe(false);
    expect(isCurrentOrUpcoming({ startDate: '2026-08-10T00:00:00Z', endDate: '2026-08-14T00:00:00Z' }, '2026-08-06')).toBe(true);
  });
});
