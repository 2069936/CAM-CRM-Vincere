// The two things that hold this export under a 4 MiB response ceiling, and the
// one shape rule that keeps both of them from failing quietly.
//
// Everything here is synthetic and ungated, so CI pins it. The measurement that
// says HOW MUCH the dictionary is worth on the real book — 99.9% of the ceiling
// down to 62.6% for the busiest CAM — is in src/domain/clientExportPlan.book.test.js,
// which is on the localSnapshotTests list. What is pinned here is the property:
// the columns move, they move together, every row keeps a way back to them, and
// a payload that still cannot be delivered says so.

import { describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  hoistStrategyParameters,
  normalizeBatch,
  rehydrateStrategyParameters,
} from '../../export/clientExport.js';
import { createFakeSupabase } from './fakeSupabase.js';

const CAM_PROFILE = '11111111-1111-4111-8111-111111111111';
const MINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const MINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ACCOUNT_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const IMPORT_1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const IMPORT_2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';

// Six rows over four distinct configurations, arranged so every case the
// dictionary has to keep apart is present: one configuration repeated across
// accounts and days, one carried by a single row, one that parses to the same
// object from a different raw string, and one row with nothing configured.
const CONFIG_A_RAW = 'False/1/1/2020 40/400/300 (Backtest/MyTradeDirection/ProfitTargetTicks)';
const CONFIG_A_RAW_RESPELT = 'False/01/01/2020 40/400/300 (Backtest/MyTradeDirection/ProfitTargetTicks)';
const CONFIG_A_PARSED = { Backtest: false, MyTradeDirection: 'Long', ProfitTargetTicks: 40 };
const CONFIG_B_RAW = 'True/2/2/2021 80/800/600 (Backtest/MyTradeDirection/ProfitTargetTicks)';
const CONFIG_B_PARSED = { Backtest: true, MyTradeDirection: 'Short', ProfitTargetTicks: 80 };

function fixture() {
  return {
    clients: [
      { id: MINE_A, name: 'Client A', status: 'Active' },
      { id: MINE_B, name: 'Client B', status: 'Active' },
    ],
    client_assignments: [
      { id: 'as1', client_id: MINE_A, cam_profile_id: CAM_PROFILE },
      { id: 'as2', client_id: MINE_B, cam_profile_id: CAM_PROFILE },
    ],
    trading_accounts: [
      { id: ACCOUNT_A, client_id: MINE_A, account_name: 'ACC-1', account_type: 'Funded', status: 'Active' },
    ],
    daily_imports: [
      { id: IMPORT_1, client_id: MINE_A, trading_date: '2026-07-20', status: 'Closed', source_summary: {} },
      { id: IMPORT_2, client_id: MINE_A, trading_date: '2026-07-21', status: 'Closed', source_summary: {} },
    ],
    account_snapshots: [
      { id: 'sn1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, account_name: 'ACC-1', gross_realized_pnl: 10, account_balance: 100, weekly_pnl: 10, unrealized_pnl: 0 },
    ],
    strategy_snapshots: [
      { id: 'st1', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet', parameters_raw: CONFIG_A_RAW, params_parsed: CONFIG_A_PARSED },
      { id: 'st2', daily_import_id: IMPORT_1, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet', parameters_raw: CONFIG_A_RAW, params_parsed: CONFIG_A_PARSED },
      { id: 'st3', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet', parameters_raw: CONFIG_A_RAW, params_parsed: CONFIG_A_PARSED },
      { id: 'st4', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, strategy_name: 'URGO', parameters_raw: CONFIG_B_RAW, params_parsed: CONFIG_B_PARSED },
      // Same parsed object, different raw string — the parser keeps no record
      // of which spelling produced it. The book has this shape: 116 distinct
      // params_parsed and 129 distinct parameters_raw, but 135 distinct pairs,
      // so neither column alone identifies a configuration.
      { id: 'st6', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet', parameters_raw: CONFIG_A_RAW_RESPELT, params_parsed: CONFIG_A_PARSED },
      // 98 of the book's 3,805 strategy rows carry an empty parameters_raw.
      { id: 'st5', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, strategy_name: 'Quiet', parameters_raw: '', params_parsed: null },
      // The MIRROR of st6, and the direction the fixture was missing: same raw
      // string, different parsed object. Without it, keying the dictionary on
      // parameters_raw alone passed every test in the tree while silently
      // corrupting 77 rows of the real book — one raw value there maps to more
      // than one parsed object (the empty-parameters_raw group of 98 rows).
      // A guard that only holds in one direction is not a guard on the pair.
      { id: 'st7', daily_import_id: IMPORT_2, trading_account_id: ACCOUNT_A, strategy_name: 'Bullet', parameters_raw: CONFIG_A_RAW, params_parsed: CONFIG_B_PARSED },
    ],
    orders: [],
    executions: [],
    operational_flags: [],
    tasks: [],
    activity_logs: [],
    price_checks: [],
    payout_events: [],
    reports: [],
    client_credentials: [],
    client_prop_firms: [],
    audit_logs: [],
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ actor, tables = fixture(), ...options } = {}) {
  const inserts = [];
  const admin = createFakeSupabase(tables, { inserts });
  const handler = createHandler({
    createClients: () => ({ admin, auth: {} }),
    authorize: vi.fn(async () => actor),
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    ...options,
  });
  return { handler, inserts };
}

const CAM = { id: 'user-cam', role: 'CAM', cam_profile_id: CAM_PROFILE };
const MANAGER = { id: 'user-manager', role: 'Manager', cam_profile_id: null };

async function post(handler, body) {
  const res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body }, res);
  return res;
}

const wholeRange = { clientIds: [MINE_A], from: '2026-07-20', to: '2026-07-21' };

describe('the strategy parameter dictionary', () => {
  it('stores each distinct configuration once and refers every row to it', async () => {
    // The whole point, and the number it turns on: six rows, four distinct
    // (params_parsed, parameters_raw) pairs. On the real book it is 1,022 rows
    // and 42 pairs, which is 38.8% of the entire response budget.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    const dictionary = res.body.dictionaries.strategyParameters;
    // 7 rows, 5 distinct configurations: A, B, A-respelt, empty, and st7's
    // (A's raw with B's parsed) which exists to pin the pair in both directions.
    expect(res.body.tables.strategy_snapshots).toHaveLength(7);
    expect(dictionary.entries).toHaveLength(5);
    expect(dictionary.distinctValues).toBe(5);
    expect(dictionary.rows).toBe(7);
    const refs = res.body.tables.strategy_snapshots.map((row) => row.parameters_ref);
    expect(refs).toHaveLength(7);
    expect(refs.every((ref) => Number.isInteger(ref))).toBe(true);
    // The three rows on the shared configuration point at ONE entry.
    const byId = Object.fromEntries(res.body.tables.strategy_snapshots.map((row) => [row.id, row]));
    expect(byId.st1.parameters_ref).toBe(byId.st2.parameters_ref);
    expect(byId.st1.parameters_ref).toBe(byId.st3.parameters_ref);
    expect(byId.st4.parameters_ref).not.toBe(byId.st1.parameters_ref);
  });

  it('takes the columns off the row rather than blanking them', async () => {
    // The failure this shape is chosen for: `parameters_raw: ""` reads as "this
    // strategy had no configuration" to every parser in the CRM, and would be
    // wrong on 1,022 of the busiest CAM's rows. An absent key cannot be
    // mistaken for an answer.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    for (const row of res.body.tables.strategy_snapshots) {
      expect(row).not.toHaveProperty('params_parsed');
      expect(row).not.toHaveProperty('parameters_raw');
      expect(row).toHaveProperty('parameters_ref');
    }
  });

  it('gives a row with no configuration a ref of its own instead of no ref', async () => {
    // Without this, "no ref" would mean both "nothing was configured" and "this
    // file predates the dictionary", and a consumer would have to guess.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    const quiet = res.body.tables.strategy_snapshots.find((row) => row.id === 'st5');
    expect(quiet.parameters_ref).toEqual(expect.any(Number));
    const entry = res.body.dictionaries.strategyParameters.entries[quiet.parameters_ref];
    expect(entry).toMatchObject({ parameters_raw: '', params_parsed: null });
  });

  it('hoists the two columns as one pair, so the pairing survives', async () => {
    // Keyed on either column alone, st1 and st6 collapse into one entry and one
    // of the two raw strings is lost. They are the same fact told twice and
    // they have to travel together.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    const entries = res.body.dictionaries.strategyParameters.entries;
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['parameters_raw', 'params_parsed', 'ref']);
    }
    const byId = Object.fromEntries(res.body.tables.strategy_snapshots.map((row) => [row.id, row]));
    expect(byId.st6.parameters_ref).not.toBe(byId.st1.parameters_ref);
    expect(entries[byId.st6.parameters_ref]).toMatchObject({
      parameters_raw: CONFIG_A_RAW_RESPELT,
      params_parsed: CONFIG_A_PARSED,
    });
    // Same raw, different parsed: the other direction. Keyed on parameters_raw
    // alone, st7 and st1 collapse and st7's parsed object is replaced by st1's.
    expect(byId.st7.parameters_ref).not.toBe(byId.st1.parameters_ref);
    expect(entries[byId.st7.parameters_ref]).toMatchObject({
      parameters_raw: CONFIG_A_RAW,
      params_parsed: CONFIG_B_PARSED,
    });
    expect(entries[byId.st1.parameters_ref]).toMatchObject({
      parameters_raw: CONFIG_A_RAW,
      params_parsed: CONFIG_A_PARSED,
    });
    expect(entries.filter((entry) => entry.parameters_raw === CONFIG_B_RAW)).toHaveLength(1);
  });

  it('puts every row back exactly as it was stored', async () => {
    // The round trip is the contract. If this ever stops holding, an analysis
    // reading configurations out of this payload is reading a different book
    // from the CRM.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    const restored = rehydrateStrategyParameters(res.body);
    const stored = fixture().strategy_snapshots;
    expect(restored).toHaveLength(stored.length);
    for (const row of stored) {
      expect(restored.find((entry) => entry.id === row.id)).toEqual(row);
    }
  });

  it('refuses a ref the dictionary does not hold rather than inventing a blank config', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    res.body.tables.strategy_snapshots[0].parameters_ref = 999;
    expect(() => rehydrateStrategyParameters(res.body)).toThrow(/not in the dictionary/);
  });

  it('says the shape changed, in the version and in the caveats', async () => {
    // A consumer pinned to the old payload has two ways to notice, and neither
    // of them is "a column I expected is undefined".
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    expect(res.body.version).toBe(2);
    const dictionary = res.body.dictionaries.strategyParameters;
    expect(dictionary.appliesTo).toBe('tables.strategy_snapshots');
    expect(dictionary.movedColumns).toEqual(['params_parsed', 'parameters_raw']);
    expect(dictionary.referenceColumn).toBe('parameters_ref');
    expect(dictionary.rehydrate).toMatch(/parameters_ref/);
    const caveat = res.body.caveats.find((entry) => entry.field.includes('params_parsed'));
    expect(caveat.note).toMatch(/parameters_ref/);
  });

  it('leaves the per-day strategy counts alone', async () => {
    // The series counts rows, not bytes. A hoist that changed a count would be
    // changing what the export says happened.
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    const days = res.body.series[0].days;
    expect(days.find((day) => day.date === '2026-07-20').counts.strategySnapshots).toBe(2);
    expect(days.find((day) => day.date === '2026-07-21').counts.strategySnapshots).toBe(5);
    expect(res.body.rowCounts.strategy_snapshots).toBe(7);
  });
});

describe('hoistStrategyParameters', () => {
  it('does not touch the rows it was handed', () => {
    // `series` is built from the same row objects. A mutation here would reach
    // into a block that has nothing to do with byte size.
    const rows = [{ id: 'a', parameters_raw: 'x', params_parsed: { a: 1 } }];
    const before = JSON.stringify(rows);
    hoistStrategyParameters(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('numbers entries in order so entries[ref] and find(ref) agree', () => {
    const { entries } = hoistStrategyParameters([
      { id: 'a', parameters_raw: 'x', params_parsed: null },
      { id: 'b', parameters_raw: 'y', params_parsed: null },
      { id: 'c', parameters_raw: 'x', params_parsed: null },
    ]);
    expect(entries.map((entry) => entry.ref)).toEqual([0, 1]);
    entries.forEach((entry, index) => expect(entries[index].ref).toBe(entry.ref));
  });

  it('keeps a null and an empty string apart', () => {
    // They are different facts: no column at all versus a column that was read
    // and was empty. Collapsing them would merge two configurations into one.
    const { entries } = hoistStrategyParameters([
      { id: 'a', parameters_raw: '', params_parsed: null },
      { id: 'b', parameters_raw: null, params_parsed: null },
    ]);
    expect(entries).toHaveLength(2);
  });
});

describe('batch labelling', () => {
  it('is absent on an ordinary export', async () => {
    const { handler, inserts } = setup({ actor: MANAGER });
    const res = await post(handler, wholeRange);
    expect(res.body.scope.batch).toBeNull();
    expect(inserts[0].row.after_data.batch).toBeNull();
  });

  it('echoes which part this is into the payload and the audit row', async () => {
    // Five files in a downloads folder with no part marker is the same silent
    // truncation this module refuses to do inside one payload.
    const { handler, inserts } = setup({ actor: MANAGER });
    const res = await post(handler, { ...wholeRange, batch: { index: 2, of: 5 } });
    expect(res.body.scope.batch).toEqual({ index: 2, of: 5 });
    expect(inserts[0].row.after_data.batch).toEqual({ index: 2, of: 5 });
    const caveat = res.body.caveats.find((entry) => entry.field === 'scope.batch');
    expect(caveat.note).toMatch(/every part from 1 to/);
  });

  it('changes nothing about which clients come back', async () => {
    // It is a label. If it ever starts selecting, an export could be narrowed
    // by a field nobody authorises against.
    const { handler } = setup({ actor: CAM });
    const plain = await post(handler, { from: '2026-07-20', to: '2026-07-21' });
    const labelled = await post(handler, { from: '2026-07-20', to: '2026-07-21', batch: { index: 1, of: 9 } });
    expect(labelled.body.scope.clientIds).toEqual(plain.body.scope.clientIds);
    expect(labelled.body.rowCounts).toEqual(plain.body.rowCounts);
  });

  it('rejects a part number that cannot describe a real split', async () => {
    for (const batch of [
      { index: 0, of: 3 },
      { index: 4, of: 3 },
      { index: 1, of: 0 },
      { index: 1, of: 201 },
      { index: 1.5, of: 3 },
      { index: '1', of: '3' },
    ]) {
      expect(() => normalizeBatch(batch)).toThrow();
    }
    expect(normalizeBatch(undefined)).toBeNull();
    expect(normalizeBatch(null)).toBeNull();
    expect(normalizeBatch({ index: 1, of: 1 })).toEqual({ index: 1, of: 1 });
    expect(() => normalizeBatch([1, 3])).toThrow(/must be an object/);
  });

  it('answers a bad part number with a 400 rather than a 500', async () => {
    const { handler } = setup({ actor: MANAGER });
    const res = await post(handler, { ...wholeRange, batch: { index: 9, of: 2 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/batch\.index/);
  });
});

describe('a payload that still will not fit', () => {
  it('does not tell a single-client pull to export fewer clients', async () => {
    // The old message said "export fewer clients at a time" whatever was asked
    // for. On a one-client pull that is advice to do nothing, and this endpoint
    // exists to make a refusal actionable.
    const { handler } = setup({ actor: MANAGER, maxResponseBytes: 1 });
    const res = await post(handler, wholeRange);
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/1 client,/);
    expect(res.body.error).toMatch(/Shorten the range/);
    expect(res.body.error).not.toMatch(/in parts/);
  });

  it('tells a multi-client pull to split it', async () => {
    const { handler } = setup({ actor: CAM, maxResponseBytes: 1 });
    const res = await post(handler, { from: '2026-07-20', to: '2026-07-21' });
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/2 clients,/);
    expect(res.body.error).toMatch(/Export these clients in parts/);
  });

  it('records the refusal, with the part it was refusing', async () => {
    const { handler, inserts } = setup({ actor: MANAGER, maxResponseBytes: 1 });
    await post(handler, { ...wholeRange, batch: { index: 3, of: 4 } });
    expect(inserts[0].row.action).toBe('client_data_export.denied');
    expect(inserts[0].row.after_data).toMatchObject({
      reason: 'response_too_large',
      batch: { index: 3, of: 4 },
    });
  });
});
