import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AutoImportValidationError, normalizeAutoImportSnapshot } from './autoImport.js';
import {
  REASON_MAX_CHARS,
  REASON_RULE_LIMIT,
  validationReasonSummary,
  validationRule,
} from './autoImportValidationReason.js';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/auto-export/snapshot-v1.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(fixture));

function rejection(snapshot) {
  try {
    normalizeAutoImportSnapshot(snapshot);
  } catch (error) {
    if (error instanceof AutoImportValidationError) return error;
    throw error;
  }
  throw new Error('the snapshot was accepted');
}

describe('validationRule: one message as the rule it states', () => {
  it('collapses the row a rule was broken on, so forty rows are one rule', () => {
    expect(validationRule('accounts[3].netLiquidation must be a number or null'))
      .toBe('accounts[*].netLiquidation must be a number or null');
    expect(validationRule('orders[12].time must be an ISO-8601 timestamp with an offset or null'))
      .toBe('orders[*].time must be an ISO-8601 timestamp with an offset or null');
    expect(validationRule('executions[4].executionId duplicates executions[1].executionId'))
      .toBe('executions[*].executionId duplicates executions[*].executionId');
  });

  it('keeps the account name a reference rule names, with its sampled rows collapsed', () => {
    expect(validationRule('executions[0, 1, 2] and 5 more.accountName does not reference an account (APEX 4521 07)'))
      .toBe('executions[*].accountName does not reference an account (APEX 4521 07)');
    expect(validationRule('orders[9].accountName does not reference an account (blank)'))
      .toBe('orders[*].accountName does not reference an account (blank)');
    expect(validationRule('orders[9].accountName does not reference an account ()'))
      .toBe('orders[*].accountName does not reference an account (blank)');
  });

  it('cuts an account name past 64 characters', () => {
    const name = 'A'.repeat(80);
    expect(validationRule(`orders[0].accountName does not reference an account (${name})`))
      .toBe(`orders[*].accountName does not reference an account (${'A'.repeat(64)}…)`);
  });

  it('keeps a strategy parameter name that is an identifier, and withholds one that is not', () => {
    expect(validationRule('strategies[2].parameters.StopLossTicks must be a scalar or null'))
      .toBe('strategies[*].parameters.StopLossTicks must be a scalar or null');
    expect(validationRule('strategies[2].parameters.Stop at 1,250.00 USD must be a scalar or null'))
      .toBe('strategies[*].parameters.<parameter> must be a scalar or null');
  });

  it('withholds a message whose text is not a rule it knows, keeping only its path', () => {
    expect(validationRule('accounts[2].netLiquidation must be a number or null, got 52341.17'))
      .toBe('accounts[*].netLiquidation unrecognized rule');
    expect(validationRule('the CAM wrote: balance 52,341.17 is wrong')).toBe('unrecognized rule');
    expect(validationRule('Balance is required')).toBe('unrecognized rule');
    expect(validationRule('Gray duplicates Birch')).toBe('unrecognized rule');
  });

  it('turns control characters into spaces and folds the runs', () => {
    expect(validationRule('accounts[1].cashValue\nmust be a number\u0007\tor null\u0085'))
      .toBe('accounts[*].cashValue must be a number or null');
  });

  it('says nothing about nothing', () => {
    expect(validationRule('')).toBe('');
    expect(validationRule(null)).toBe('');
    expect(validationRule(' \n ')).toBe('');
  });
});

describe('validationReasonSummary: the errors array as one short text', () => {
  it('unique rules, in the order first broken, joined with "; "', () => {
    expect(validationReasonSummary([
      'accounts[0].netLiquidation must be a number or null',
      'orders[3].accountName does not reference an account (APEX 1)',
      'accounts[1].netLiquidation must be a number or null',
      'accounts[7].netLiquidation must be a number or null',
    ])).toBe('accounts[*].netLiquidation must be a number or null; orders[*].accountName does not reference an account (APEX 1)');
  });

  it('shows the first twelve and says how many more there were', () => {
    const errors = Array.from({ length: 15 }, (_, index) => `orders[${index}].accountName does not reference an account (APEX ${index})`);
    const summary = validationReasonSummary(errors);
    expect(REASON_RULE_LIMIT).toBe(12);
    expect(summary.split('; ')).toHaveLength(12);
    expect(summary.startsWith('orders[*].accountName does not reference an account (APEX 0); ')).toBe(true);
    expect(summary).toContain('(APEX 11) (+3 more)');
    expect(summary).not.toContain('APEX 12');
    expect(summary.endsWith(' (+3 more)')).toBe(true);
  });

  it('has no tail at exactly twelve, and one at thirteen', () => {
    const rules = (n) => Array.from({ length: n }, (_, index) => `orders[0].accountName does not reference an account (X${index})`);
    expect(validationReasonSummary(rules(12))).not.toMatch(/more\)$/);
    expect(validationReasonSummary(rules(13)).endsWith('(X11) (+1 more)')).toBe(true);
  });

  it('counts the tail in unique rules, not in rows', () => {
    const errors = [
      ...Array.from({ length: 14 }, (_, index) => `orders[0].accountName does not reference an account (N${index})`),
      ...Array.from({ length: 50 }, (_, index) => `orders[${index}].accountName does not reference an account (N13)`),
    ];
    expect(validationReasonSummary(errors).endsWith(' (+2 more)')).toBe(true);
  });

  it('twelve of the longest rules the validator writes fit in 2000 characters without cutting one', () => {
    const errors = Array.from({ length: 40 }, (_, index) => `strategies[${index}].accountName does not reference an account (${String(index).padStart(2, '0')}${'Z'.repeat(200)})`);
    const summary = validationReasonSummary(errors);
    expect(summary.split('; ')).toHaveLength(12);
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary.endsWith(`(${'1'}1${'Z'.repeat(62)}…) (+28 more)`)).toBe(true);
  });

  it('stays inside the 2000 characters step 69 stores, tail included, when the rules are longer still', () => {
    // Unrecognized rules keep a path of up to 160 characters, so twelve of
    // them do not fit: the budget stops at eleven and counts the rest.
    const errors = Array.from({ length: 20 }, (_, index) => `accounts[${index}].${'f'.repeat(140)}${String(index).padStart(2, '0')} broke a rule added tomorrow`);
    const summary = validationReasonSummary(errors);
    expect(REASON_MAX_CHARS).toBe(2000);
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary.split('; ')).toHaveLength(11);
    expect(summary.endsWith(`accounts[*].${'f'.repeat(140)}10 unrecognized rule (+9 more)`)).toBe(true);
  });

  it('keeps an unrecognized rule\'s path only up to 160 characters', () => {
    expect(validationRule(`accounts[0].${'g'.repeat(148)} is odd`)).toBe(`accounts[*].${'g'.repeat(148)} unrecognized rule`);
    expect(validationRule(`accounts[0].${'g'.repeat(149)} is odd`)).toBe('unrecognized rule');
  });

  it('is empty for anything that is not a list of messages', () => {
    expect(validationReasonSummary(undefined)).toBe('');
    expect(validationReasonSummary('accounts must be an array')).toBe('');
    expect(validationReasonSummary([])).toBe('');
    expect(validationReasonSummary([null, '', '  '])).toBe('');
  });
});

describe('every message the real validator writes is a rule this knows, and carries no value', () => {
  // The snapshots that break every rule autoExportContract.js and autoImport.js
  // can state, each holding figures and free text a stored reason must never
  // carry.
  function brokenSnapshots() {
    const structural = clone();
    structural.captureId = '';
    structural.timeZone = 'Europe/Madrid';
    structural.capturedAt = 'yesterday at 4';
    structural.tradingDate = '2026-02-30';
    structural.source = { machineId: '', agentVersion: '1.2.2' };
    structural.accounts[0].netLiquidation = '51,245.75 USD';
    structural.accounts[0].connectionName = 51245.75;
    structural.accounts[0].isSimulated = 'the client says yes';
    structural.accounts.push('Balance 99,812.40 per the CAM');
    structural.strategies[0].enabled = 'mostly';
    structural.strategies[0].startedAt = 'this morning';
    structural.strategies[0].parameters = { StopLossTicks: { ticks: 18 }, 'Note: pays 1,250.00 a month': [1] };
    delete structural.strategies[0].state;
    structural.orders = 'none today';
    structural.executions[0].time = null;
    structural.executions[0].price = 'twenty thousand';

    const sessions = clone();
    sessions.tradingDate = '2026-07-24';

    const referencesAndDuplicates = clone();
    referencesAndDuplicates.accounts.push({ ...referencesAndDuplicates.accounts[0], accountName: 'sim-redacted-01' });
    referencesAndDuplicates.orders.push({ ...referencesAndDuplicates.orders[0], orderId: 'order-02', accountName: 'APEX 4521 07' });
    referencesAndDuplicates.executions.push({ ...referencesAndDuplicates.executions[0], executionId: 'execution-02', accountName: 'Sim101' });
    referencesAndDuplicates.executions.push({ ...referencesAndDuplicates.executions[0] });

    return [null, { ...clone(), schemaVersion: 2 }, structural, sessions, referencesAndDuplicates];
  }

  it('recognizes all of them', () => {
    const messages = brokenSnapshots().flatMap((snapshot) => rejection(snapshot).errors);
    expect(messages.length).toBeGreaterThan(20);
    for (const message of messages) expect(validationRule(message), message).not.toMatch(/unrecognized rule/);
  });

  it('stores the rules and none of the figures or free text the snapshots held', () => {
    const summaries = brokenSnapshots().map((snapshot) => validationReasonSummary(rejection(snapshot).errors));
    const text = summaries.join('\n');
    for (const value of ['51,245.75', '51245.75', '99,812.40', '1,250.00', 'the client says yes', 'twenty thousand', 'mostly', 'this morning', 'none today', 'Europe/Madrid', 'yesterday', 'pays']) {
      expect(text, value).not.toContain(value);
    }
    expect(summaries[0]).toBe('snapshot must be an object');
    expect(summaries[1]).toBe('schemaVersion must be 1');
    expect(summaries[3]).toBe('tradingDate must match capturedAt in America/New_York');
    expect(summaries[4]).toBe([
      'accounts[*].accountName duplicates accounts[*].accountName',
      'executions[*].executionId duplicates executions[*].executionId',
      'orders[*].accountName does not reference an account (APEX 4521 07)',
      'executions[*].accountName does not reference an account (Sim101)',
    ].join('; '));
    // The structural one breaks nineteen rules: twelve shown, seven counted.
    expect(summaries[2].split('; ')).toHaveLength(12);
    expect(summaries[2]).toContain('accounts[*] must be an object');
    expect(summaries[2].endsWith(' (+7 more)')).toBe(true);
    const rules = rejection(brokenSnapshots()[2]).errors.map(validationRule);
    expect(new Set(rules).size).toBe(19);
    expect(rules).toContain('strategies[*].parameters.StopLossTicks must be a scalar or null');
    expect(rules).toContain('strategies[*].parameters.<parameter> must be a scalar or null');
  });
});
