import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  BATCH_TARGET_FRACTION,
  MAX_BATCHES,
  MAX_CLIENTS_PER_REQUEST,
  MAX_RESPONSE_BYTES,
  buildClientExportPlan,
  estimateClientExportBytes,
  formatBytes,
  planExportBatches,
} from './clientExportPlan';

function client(id, name, dailyImports = [], extra = {}) {
  return {
    id,
    uuid: id,
    name,
    accountRegistry: { 'ACC-1': {}, 'ACC-2': {} },
    activityLog: [],
    dailyImports,
    ...extra,
  };
}

const busyDay = {
  date: '2026-07-21',
  sourceSummary: { accounts: 4, strategies: 6, orders: 120, executions: 58, flags: 9 },
  snapshots: [],
  strategies: [],
  flags: [],
  orders: [],
  executions: [],
};

describe('buildClientExportPlan', () => {
  it('counts only the sessions inside the range', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [
        { ...busyDay, date: '2026-07-10' },
        { ...busyDay, date: '2026-07-21' },
        { ...busyDay, date: '2026-08-02' },
      ])],
      { from: '2026-07-15', to: '2026-07-31' },
    );
    expect(plan.sessions).toBe(1);
    expect(plan.rows.daily_imports).toBe(1);
    expect(plan.clientsWithSessions).toBe(1);
  });

  it('reads the importer counts rather than the loaded arrays for trade rows', () => {
    // The CRM does not load orders or executions on a normal session, so
    // dailyImport.orders is [] even on a 120-order day. Reading that as zero
    // would promise a small download and deliver a large one.
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true },
    );
    expect(plan.rows.orders).toBe(120);
    expect(plan.rows.executions).toBe(58);
  });

  it('leaves trade tables out of the row count but still reports what is being skipped', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.rows.orders).toBeUndefined();
    expect(plan.excludedTradeRows).toBe(178);
  });

  it('grows with the number of clients and keeps quiet clients visible', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay]), client('c2', 'B', [])],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.clients).toBe(2);
    expect(plan.clientsWithSessions).toBe(1);
    expect(plan.rows.trading_accounts).toBe(4);
  });

  it('estimates a download that is a fraction of the raw size', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true },
    );
    expect(plan.estimatedBytes).toBeGreaterThan(0);
    expect(plan.estimatedDownloadBytes).toBeLessThan(plan.estimatedBytes);
  });

  it('windows activity notes on the date they were written', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [], {
        activityLog: [
          { createdAt: '2026-07-20T10:00:00Z', text: 'in' },
          { createdAt: '2026-05-01T10:00:00Z', text: 'out' },
        ],
      })],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.rows.activity_logs).toBe(1);
  });
});

describe('formatBytes', () => {
  it('reads as a size a person recognises', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
  });
});

describe('response-limit preview', () => {
  it('flags an estimate the server would refuse, so the warning lands before the request', () => {
    // The server measures the real payload and 413s past 4 MiB. On the real
    // book that is not a corner case: the busiest CAM's default 30-day pull
    // with trade history is 6.92 MB.
    const heavy = Array.from({ length: 40 }, (_, index) => ({
      uuid: `c${index}`,
      accountRegistry: {},
      activityLog: [],
      dailyImports: Array.from({ length: 20 }, (_, day) => ({
        date: `2026-07-${String((day % 28) + 1).padStart(2, '0')}`,
        sourceSummary: { accounts: 6, strategies: 7, orders: 30, executions: 15, flags: 13 },
      })),
    }));
    const plan = buildClientExportPlan(heavy, { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true });
    expect(plan.estimatedBytes).toBeGreaterThan(plan.maxResponseBytes);
    expect(plan.exceedsResponseLimit).toBe(true);
  });

  it('does not flag a single client over a week', () => {
    const light = [{
      uuid: 'c1',
      accountRegistry: { a: {} },
      activityLog: [],
      dailyImports: [{ date: '2026-07-20', sourceSummary: { accounts: 5, strategies: 5, orders: 13, executions: 6, flags: 10 } }],
    }];
    const plan = buildClientExportPlan(light, { from: '2026-07-20', to: '2026-07-26', includeTradeHistory: true });
    expect(plan.exceedsResponseLimit).toBe(false);
  });
});

// Clients of a chosen weight, so a test can say "two heavy and forty idle" and
// mean it. Sessions are what actually cost bytes.
function weighted(id, sessions, perDay = { accounts: 6, strategies: 7, orders: 30, executions: 15, flags: 13 }) {
  return {
    id,
    uuid: id,
    name: `Client ${id}`,
    accountRegistry: {},
    activityLog: [],
    dailyImports: Array.from({ length: sessions }, (_, day) => ({
      date: `2026-07-${String((day % 28) + 1).padStart(2, '0')}`,
      sourceSummary: perDay,
    })),
  };
}

const RANGE = { from: '2026-07-01', to: '2026-07-31' };

describe('planExportBatches', () => {
  it('splits on bytes, not on how many clients there are', () => {
    // The finding this whole axis change came from: on the real book the CAM
    // with the MOST clients (32) has the SMALLEST export on the desk, and the
    // one that was 0.1% from being refused carries 28. A count-based split
    // would have put the 32 in one part and failed on the 28.
    const heavy = Array.from({ length: 12 }, (_, index) => weighted(`h${index}`, 20));
    const idle = Array.from({ length: 40 }, (_, index) => weighted(`i${index}`, 0));

    const heavyPlan = planExportBatches(heavy, RANGE);
    const idlePlan = planExportBatches(idle, RANGE);

    expect(heavyPlan.batchCount).toBeGreaterThan(1);
    // Forty idle clients fit in one part; twelve busy ones do not fit in any
    // one part. Client count says the opposite in both cases, and so does the
    // weight: fewer clients, more bytes.
    expect(idlePlan.batchCount).toBe(1);
    expect(idlePlan.batches[0].clients).toHaveLength(40);
    expect(heavy.length).toBeLessThan(idle.length);
    expect(heavyPlan.totalEstimatedBytes).toBeGreaterThan(idlePlan.totalEstimatedBytes);
  });

  it('keeps every part under what one response can carry', () => {
    const clients = Array.from({ length: 30 }, (_, index) => weighted(`c${index}`, 18));
    const result = planExportBatches(clients, RANGE);
    for (const part of result.batches) {
      expect(part.estimatedBytes).toBeLessThanOrEqual(result.budgetBytes + result.fixedBytes);
      expect(part.estimatedBytes).toBeLessThan(MAX_RESPONSE_BYTES);
    }
  });

  it('leaves the estimate room to be wrong, because it measurably is', () => {
    // The estimate under-states the worst measured case on the book by 9.7%, so
    // a part planned to fill the ceiling is a part the server refuses. If this
    // fraction ever creeps to 1, multi-part downloads start failing mid-way.
    expect(BATCH_TARGET_FRACTION).toBeLessThanOrEqual(0.85);
    const result = planExportBatches([weighted('c', 40)], RANGE);
    expect(result.budgetBytes).toBeLessThan(MAX_RESPONSE_BYTES * 0.9);
  });

  it('carries every client exactly once, in the order it was given', () => {
    // A split that dropped or duplicated a client would be a silent truncation
    // spread across files, which is the one thing this must not do.
    const clients = Array.from({ length: 25 }, (_, index) => weighted(`c${index}`, 12));
    const result = planExportBatches(clients, RANGE);
    const placed = result.batches.flatMap((part) => part.clientIds);
    expect(placed).toEqual(clients.map((client) => client.uuid));
    expect(new Set(placed).size).toBe(clients.length);
  });

  it('numbers the parts so a folder of files can be counted', () => {
    const clients = Array.from({ length: 25 }, (_, index) => weighted(`c${index}`, 12));
    const result = planExportBatches(clients, RANGE);
    expect(result.batches.map((part) => part.index)).toEqual(
      Array.from({ length: result.batchCount }, (_, index) => index + 1),
    );
    for (const part of result.batches) expect(part.of).toBe(result.batchCount);
  });

  it('refuses to promise a split when one client alone is too big', () => {
    // Splitting the LIST cannot help a single client that overflows on its own.
    // Saying "3 parts" here would promise a download that 413s on part 2.
    const clients = [weighted('small', 1), weighted('enormous', 400), weighted('small2', 1)];
    const result = planExportBatches(clients, RANGE);
    expect(result.deliverable).toBe(false);
    expect(result.oversized.map((entry) => entry.id)).toEqual(['enormous']);
    // Still placed, and alone: a client this dialog cannot deliver is named,
    // never dropped out of the plan so the count quietly comes up short.
    const placed = result.batches.flatMap((part) => part.clientIds);
    expect(placed).toContain('enormous');
    expect(result.batches.find((part) => part.clientIds.includes('enormous')).clientIds).toEqual(['enormous']);
  });

  it('honours the server client cap as well as the byte budget', () => {
    // The two bite in opposite places and both are real: the server refuses
    // more than 60 ids in one request whatever they weigh.
    const clients = Array.from({ length: 150 }, (_, index) => weighted(`i${index}`, 0));
    const result = planExportBatches(clients, { ...RANGE, maxClients: 60 });
    expect(result.batchCount).toBe(3);
    for (const part of result.batches) expect(part.clients.length).toBeLessThanOrEqual(60);
  });

  it('says so when even the parts are too many to declare', () => {
    const clients = Array.from({ length: 40 }, (_, index) => weighted(`c${index}`, 30));
    const result = planExportBatches(clients, { ...RANGE, maxBatches: 2 });
    expect(result.batchCount).toBeGreaterThan(2);
    expect(result.tooManyBatches).toBe(true);
    expect(result.deliverable).toBe(false);
  });

  it('pays the envelope once per part, not once per export', () => {
    // On the real book that is up to 112 KB a part, mostly the strategy
    // dictionary, and it is why more parts is not free.
    const clients = Array.from({ length: 20 }, (_, index) => weighted(`c${index}`, 15));
    const result = planExportBatches(clients, RANGE);
    const clientBytes = clients.reduce(
      (sum, client) => sum + estimateClientExportBytes(client, RANGE).bytes,
      0,
    );
    expect(result.totalEstimatedBytes).toBe(clientBytes + result.batchCount * result.fixedBytes);
  });

  it('agrees with the number printed on the button', () => {
    // Two estimates of the same thing, free to disagree, is how a preview ends
    // up promising a download the batcher then plans differently.
    const clients = Array.from({ length: 9 }, (_, index) => weighted(`c${index}`, 14));
    const plan = buildClientExportPlan(clients, RANGE);
    const result = planExportBatches(clients, RANGE);
    const fromPlan = plan.estimatedBytes - plan.fixedBytes;
    const fromBatches = result.totalEstimatedBytes - result.batchCount * result.fixedBytes;
    expect(fromBatches).toBe(fromPlan);
  });

  it('is empty rather than one blank part when there is nothing to export', () => {
    const result = planExportBatches([], RANGE);
    expect(result.batches).toEqual([]);
    expect(result.deliverable).toBe(false);
  });
});

describe('the limits this module mirrors', () => {
  // Four numbers live in two files, and the comments beside them have always
  // said "must track the server". Nothing checked. Drift here is not cosmetic:
  // a ceiling copy that is too high plans parts the endpoint refuses one at a
  // time, and one that is too low warns about pulls that would have been fine.
  const SERVER = readFileSync(join(process.cwd(), 'server/export/clientExport.js'), 'utf8');
  const DIALOG = readFileSync(join(process.cwd(), 'src/components/ClientExportDialog.jsx'), 'utf8');
  // Reads `const NAME = 60;` and `const NAME = 4 * 1024 * 1024;` and nothing
  // else. Deliberately not eval: a guard that runs whatever the file it is
  // guarding happens to say is not a guard.
  const serverConst = (name) => {
    const match = SERVER.match(new RegExp(`^const ${name} = ([\\d\\s*]+);$`, 'm'));
    expect(match, `${name} not found as a plain numeric const in server/export/clientExport.js`).toBeTruthy();
    return match[1].split('*').reduce((product, part) => product * Number(part.trim()), 1);
  };

  it('copies the response ceiling the server actually enforces', () => {
    expect(MAX_RESPONSE_BYTES).toBe(serverConst('MAX_RESPONSE_BYTES'));
  });

  it('copies the per-request client cap and the part-count cap', () => {
    expect(MAX_CLIENTS_PER_REQUEST).toBe(serverConst('MAX_CLIENTS'));
    expect(MAX_BATCHES).toBe(serverConst('MAX_BATCHES'));
  });

  it('gives the dialog the same defaults, since App.jsx passes none', () => {
    expect(DIALOG).toContain(`maxRangeDays = ${serverConst('MAX_RANGE_DAYS')}`);
    expect(DIALOG).toContain(`maxClients = ${serverConst('MAX_CLIENTS')}`);
  });
});
