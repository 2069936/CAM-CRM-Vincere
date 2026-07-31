import { describe, expect, it } from 'vitest';
import {
  TIME_OFF_STATUSES,
  activeCoverageFor,
  buildCamRecord,
  buildCamWorkload,
  conflictingTimeOff,
  coverageForClient,
  coversDate,
  distributeClientsEvenly,
  effectiveClientIds,
  isActiveTimeOff,
  overlapsOwnTimeOff,
  overlapsRange,
} from './camCoverage';

const cam = (id, name, clientIds = []) => ({ id, name, clientIds });
const cover = (clientId, coveringCamId, startDate, endDate) => ({
  clientId, coveringCamId, absentCamId: 'peter', startDate, endDate,
});
const request = (over = {}) => ({
  id: 'r1', camProfileId: 'peter', startDate: '2026-08-10', endDate: '2026-08-14',
  status: TIME_OFF_STATUSES.APPROVED, ...over,
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
