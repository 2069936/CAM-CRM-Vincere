import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Synthetic only. The export below is invented; nothing in this file reads a
// real export, a redacted book, or public/local-snapshot.json.

const SCRIPT = fileURLToPath(new URL('./redact-export.mjs', import.meta.url));

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'redact-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function syntheticExport() {
  return {
    tables: {
      clients: [{ id: 'c1', name: 'Rosalind Vance', email: 'rv@example.test' }],
      trading_accounts: [{ id: 'a1', client_id: 'c1', account_name: 'ROME6100', alias: 'Rome - 1', connection: 'Live' }],
      daily_imports: [{ id: 'd1', client_id: 'c1', trading_date: '2026-08-18' }],
      orders: [
        { id: 'o1', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200001', strategy_name: 'RBO-1.8', name: 'Enter Long', instrument: 'MNQ SEP26', state: 'Filled' },
        { id: 'o2', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200002', strategy_name: 'IFSP-1.1', name: 'Stop Short', instrument: 'MNQ SEP26', state: 'Filled' },
        { id: 'o3', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200003', strategy_name: '', name: 'PT1-Short', instrument: 'MNQ SEP26', state: 'Filled' },
      ],
      executions: [
        { id: 'e1', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200001', external_execution_id: '9001_1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, time_text: '8/18/2026 9:30:01 AM', entry_exit: 'Entry', position: '1 L' },
        { id: 'e2', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200002', external_execution_id: '9001_2', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 101, time_text: '8/18/2026 9:31:01 AM', entry_exit: 'Exit', position: '-' },
        { id: 'e3', daily_import_id: 'd1', trading_account_id: 'a1', external_order_id: '4200003', external_execution_id: '9002_1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 102, time_text: '8/18/2026 9:32:01 AM', entry_exit: 'Entry', position: '1 L' },
      ],
    },
  };
}

let stdout = '';
function redact(source) {
  const inputPath = join(dir, 'export.json');
  const outputPath = join(dir, 'book.json');
  writeFileSync(inputPath, JSON.stringify(source));
  stdout = String(execFileSync(process.execPath, [SCRIPT, inputPath, outputPath], { stdio: 'pipe' }));
  return JSON.parse(readFileSync(outputPath, 'utf8')).tables;
}

describe('redact-export', () => {
  it('keeps the executions -> orders join answerable after redaction', () => {
    // The whole per-strategy derivation resolves each leg's Strategy through
    // this join. Collapsing it to a length bucket left the book looking intact
    // and credited one arbitrary algo with a whole account-day.
    const source = syntheticExport();
    const out = redact(source);

    expect(new Set(out.orders.map((row) => row.external_order_id)).size).toBe(3);
    expect(new Set(out.executions.map((row) => row.external_order_id)).size).toBe(3);

    const strategyByOrderId = new Map(out.orders.map((row) => [row.external_order_id, row.strategy_name]));
    expect(out.executions.map((row) => strategyByOrderId.get(row.external_order_id)))
      .toEqual(['RBO-1.8', 'IFSP-1.1', '']);
  });

  it('says out loud that it checked the joins before writing', () => {
    // The check has to be visible. A guard whose only output is silence on
    // success is a guard whose removal nobody notices, and the collapse this
    // one exists for shipped a whole book without a word.
    redact(syntheticExport());
    expect(stdout).toContain('joins verified: 3 order ids, 3 execution ids, 3 of 3 fills resolve to an order');
  });

  it('keeps the execution id distinct so two fills are never the same fill', () => {
    const out = redact(syntheticExport());
    expect(new Set(out.executions.map((row) => row.external_execution_id)).size).toBe(3);
  });

  it('gives the same id the same token in every table it appears in', () => {
    const out = redact(syntheticExport());
    expect(out.executions[0].external_order_id).toBe(out.orders[0].external_order_id);
    expect(out.executions[1].external_order_id).toBe(out.orders[1].external_order_id);
  });

  it('still refuses to let an account name or a client name through', () => {
    const out = redact(syntheticExport());
    const text = JSON.stringify(out);
    expect(text).not.toContain('ROME6100');
    expect(text).not.toContain('Rosalind Vance');
    expect(text).not.toContain('rv@example.test');
    // The order id was not identity and must not have been pseudonymised into
    // something a reader would mistake for one.
    expect(text).not.toContain('4200001');
  });

  it('keeps the fill mechanics the derivation orders and pairs on', () => {
    const out = redact(syntheticExport());
    expect(out.executions.map((row) => row.time_text)).toEqual([
      '8/18/2026 9:30:01 AM', '8/18/2026 9:31:01 AM', '8/18/2026 9:32:01 AM',
    ]);
    expect(out.executions.map((row) => row.entry_exit)).toEqual(['Entry', 'Exit', 'Entry']);
    expect(out.executions.map((row) => row.position)).toEqual(['1 L', '-', '1 L']);
    expect(out.orders.map((row) => row.strategy_name)).toEqual(['RBO-1.8', 'IFSP-1.1', '']);
  });

  it('keeps the churn reason countable and redacts the note beside it', () => {
    // Step 39 put two new text columns on `clients` and they need opposite
    // treatment, which is the trap this script exists to make explicit.
    // churn_reason is one of seven fixed codes — the whole reason it is a code
    // and not a sentence is that it can be counted, and a book where every
    // reason reads `[redacted 4]` cannot answer that. churn_note is prose a CAM
    // wrote about a person, and prose is where a client's own name turns up.
    const source = syntheticExport();
    source.tables.clients[0].churn_reason = 'unresponsive';
    source.tables.clients[0].churn_note = 'Rosalind Vance stopped replying after the June drawdown.';
    source.tables.clients[0].churned_at = '2026-07-14';
    const out = redact(source);

    expect(out.clients[0].churn_reason).toBe('unresponsive');
    expect(out.clients[0].churned_at).toBe('2026-07-14');
    expect(out.clients[0].churn_note).not.toContain('Rosalind Vance');
    expect(out.clients[0].churn_note).toMatch(/^\[redacted \d+]$/);
    // Length survives because it drives layout, so the marker is not the empty
    // string and the assertion above is not passing on absence.
    expect(out.clients[0].churn_note).toContain('56');
  });

  it('leaves a blank Name blank, because rule 4b reads exactly that', () => {
    // deriveStrategyPnl distinguishes a detached strategy order (blank Strategy,
    // generated Name) from a hand-placed one (blank both) on nothing but whether
    // Name is empty. A redaction that invented a Name would move that line.
    const source = syntheticExport();
    source.tables.orders[2].name = '';
    const out = redact(source);
    expect(out.orders[2].name).toBe('');
    expect(out.orders[0].name).not.toBe('');
  });
});
