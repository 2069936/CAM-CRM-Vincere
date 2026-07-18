import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPnlCalendar, buildRiskDistribution } from './App';

// ── buildRiskDistribution ─────────────────────────────────────────────────────

function makeRiskClient({ id = 'c1', name = 'Pedro', ddLimit = 0, rawDD = 0, accountType = 'Funded', status = 'Active', riskLevel = '' } = {}) {
  return {
    id, name,
    accountRegistry: {
      ACC1: { accountName: 'ACC1', alias: 'Test', accountType, status, maxDrawdownLimit: ddLimit, riskLevel },
    },
    dailyImports: [{
      id: `${id}-di`, date: '2026-06-25', accounts: {},
      snapshots: [{ accountName: 'ACC1', grossRealizedPnl: 0, weeklyPnl: 0, accountBalance: 50000, trailingMaxDrawdown: rawDD }],
      flags: [],
    }],
  };
}

describe('buildRiskDistribution', () => {
  it('returns zero total for empty client list', () => {
    const r = buildRiskDistribution([], []);
    expect(r.total).toBe(0);
    expect(Object.values(r.buckets).every(b => b.length === 0)).toBe(true);
  });

  it('buckets an account by its manually-assigned High risk level', () => {
    const client = makeRiskClient({ riskLevel: 'High' });
    const r = buildRiskDistribution([client], []);
    expect(r.buckets.High).toHaveLength(1);
    expect(r.total).toBe(1);
  });

  it('buckets an account by its manually-assigned Medium risk level', () => {
    const client = makeRiskClient({ riskLevel: 'Medium' });
    const r = buildRiskDistribution([client], []);
    expect(r.buckets.Medium).toHaveLength(1);
  });

  it('buckets an account by its manually-assigned Low risk level', () => {
    const client = makeRiskClient({ riskLevel: 'Low' });
    const r = buildRiskDistribution([client], []);
    expect(r.buckets.Low).toHaveLength(1);
  });

  it('places an account with no assigned risk level in the Unassigned bucket', () => {
    const client = makeRiskClient({ riskLevel: '' });
    const r = buildRiskDistribution([client], []);
    expect(r.buckets.Unassigned).toHaveLength(1);
  });

  it('excludes Inactive/Ignore and Failed/Inactive accounts', () => {
    const ignored = makeRiskClient({ id: 'c1', accountType: 'Inactive / Ignore', ddLimit: 2000, rawDD: -1900 });
    const failed  = makeRiskClient({ id: 'c2', status: 'Failed', ddLimit: 2000, rawDD: -1900 });
    const r = buildRiskDistribution([ignored, failed], []);
    expect(r.total).toBe(0);
  });

  it('excludes Cash account type', () => {
    const cash = makeRiskClient({ id: 'c1', accountType: 'Cash', ddLimit: 2000, rawDD: -1900 });
    const r = buildRiskDistribution([cash], []);
    expect(r.total).toBe(0);
  });
});

// ── buildPnlCalendar ──────────────────────────────────────────────────────────

// Pin to a known Thursday so the calendar window is deterministic
const FAKE_TODAY = '2026-06-25';
describe('buildPnlCalendar', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${FAKE_TODAY}T12:00:00`)); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns empty for client with no imports', () => {
    expect(buildPnlCalendar({ dailyImports: [] })).toHaveLength(0);
  });

  it('returns a non-empty array of weeks (each with up to 5 trading days)', () => {
    const client = {
      dailyImports: [
        { id: 'd1', date: '2026-06-25', status: 'Closed', snapshots: [{ accountName: 'A1', grossRealizedPnl: 300 }] },
        { id: 'd2', date: '2026-06-24', status: 'Closed', snapshots: [{ accountName: 'A1', grossRealizedPnl: -100 }] },
      ],
    };
    const weeks = buildPnlCalendar(client);
    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks.every(w => w.length <= 5)).toBe(true);
  });

  it('places known import dates in the calendar with correct P&L', () => {
    const client = {
      dailyImports: [
        { id: 'd1', date: '2026-06-25', status: 'Closed', snapshots: [{ accountName: 'A1', grossRealizedPnl: 450 }] },
      ],
    };
    const weeks = buildPnlCalendar(client);
    const allDays = weeks.flat();
    const jun25 = allDays.find(d => d.date === '2026-06-25');
    expect(jun25).toBeDefined();
    expect(jun25.pnl).toBe(450);
  });

  it('fills trading days with no import as null pnl', () => {
    const client = {
      dailyImports: [
        { id: 'd1', date: '2026-06-25', status: 'Closed', snapshots: [{ accountName: 'A1', grossRealizedPnl: 200 }] },
      ],
    };
    const weeks = buildPnlCalendar(client);
    const allDays = weeks.flat();
    const noData = allDays.filter(d => d.pnl === null);
    expect(noData.length).toBeGreaterThan(0);
  });

  it('never includes weekend days (Saturday=6, Sunday=0)', () => {
    const client = {
      dailyImports: [
        { id: 'd1', date: '2026-06-25', status: 'Closed', snapshots: [] },
      ],
    };
    const allDays = buildPnlCalendar(client).flat();
    const hasWeekend = allDays.some(d => {
      const dow = new Date(d.date + 'T12:00:00').getDay();
      return dow === 0 || dow === 6;
    });
    expect(hasWeekend).toBe(false);
  });
});
