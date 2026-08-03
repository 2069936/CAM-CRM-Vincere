import { describe, expect, it } from 'vitest';
import { buildParityEvidence } from './parityEvidence.mjs';

const HASH = 'a'.repeat(64);

function matchingSection(field = 'id') {
  return {
    apiRowCount: 1,
    gridRowCount: 1,
    rows: [{
      key: 'sensitive-row-key',
      rowStatus: 'matched',
      fields: [{
        field,
        apiValue: 'sensitive-api-value',
        gridValue: 'sensitive-grid-value',
        status: 'exact',
      }],
    }],
  };
}

function validReport() {
  return {
    inputTypes: ['accounts', 'strategies', 'orders', 'executions'],
    summary: { exact: 4, 'missing-api': 1, 'missing-grid': 1 },
    sections: {
      accounts: {
        apiRowCount: 1,
        gridRowCount: 1,
        rows: [{
          key: 'secret-account',
          rowStatus: 'matched',
          fields: [
            { field: 'accountName', apiValue: 'secret-account', gridValue: 'secret-account', status: 'exact' },
            { field: 'weeklyPnl', apiValue: null, gridValue: 123.45, status: 'missing-api' },
            { field: 'buyingPower', apiValue: 99999, gridValue: null, status: 'missing-grid' },
          ],
        }],
      },
      strategies: matchingSection('strategyName'),
      orders: matchingSection('orderId'),
      executions: matchingSection('executionId'),
    },
  };
}

function validReview() {
  return {
    reviewer: 'Approved Operator',
    reviewedAt: '2026-07-23T21:00:00.000Z',
    environment: {
      windowsVersion: 'Windows Server 2025',
      ninjaTraderVersion: '8.1.5.2',
      connectionProvider: 'Approved test provider',
      localTimeZone: 'Eastern Standard Time',
    },
    checks: {
      sameMinuteCapture: true,
      postResetRealizedGrossVerified: true,
      twoStrategyAlgorithmsVerified: true,
      currentSessionExecutionsConfirmed: true,
    },
    decisions: [
      {
        section: 'accounts', field: 'weeklyPnl', status: 'missing-api', required: false,
        action: 'preserve-null-optional', rationale: 'The CRM can operate without this grid-only value.',
      },
      {
        section: 'accounts', field: 'buyingPower', status: 'missing-grid', required: false,
        action: 'accept-supported-api', rationale: 'The supported API value is retained.',
      },
    ],
  };
}

describe('NinjaTrader parity evidence', () => {
  it('creates a sanitized, report-bound approval for all four populated sections', () => {
    const evidence = buildParityEvidence(validReport(), validReview(), HASH);

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      captureMethod: 'supported-api',
      comparisonSha256: HASH,
      allFourSectionsPassed: true,
      reviewer: 'Approved Operator',
      sections: {
        accounts: { passed: true, apiRowCount: 1, gridRowCount: 1 },
        strategies: { passed: true, apiRowCount: 1, gridRowCount: 1 },
        orders: { passed: true, apiRowCount: 1, gridRowCount: 1 },
        executions: { passed: true, apiRowCount: 1, gridRowCount: 1 },
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('secret-account');
    expect(serialized).not.toContain('sensitive-api-value');
    expect(serialized).not.toContain('sensitive-grid-value');
    expect(evidence.decisions).toHaveLength(2);
  });

  it.each([
    ['value-mismatch', { field: 'cashValue', apiValue: 1, gridValue: 2, status: 'value-mismatch' }],
    ['missing-api-row', null],
    ['missing-grid-row', null],
  ])('rejects unresolved %s results', (status, field) => {
    const report = validReport();
    report.sections.orders.rows = [{
      key: 'secret-order',
      rowStatus: status === 'value-mismatch' ? 'matched' : status,
      fields: field ? [field] : [],
    }];

    expect(() => buildParityEvidence(report, validReview(), HASH)).toThrow(status);
  });

  it('requires one approved production decision for every missing field', () => {
    const review = validReview();
    review.decisions = review.decisions.filter((decision) => decision.field !== 'weeklyPnl');

    expect(() => buildParityEvidence(validReport(), review, HASH)).toThrow(/weeklyPnl/);
  });

  it.each([
    ['pixel-automation', false],
    ['preserve-null-optional', true],
    ['blocked', false],
  ])('rejects the non-production action %s', (action, required) => {
    const review = validReview();
    review.decisions[0] = { ...review.decisions[0], action, required };

    expect(() => buildParityEvidence(validReport(), review, HASH)).toThrow(/production action/i);
  });

  it('requires every operational parity check', () => {
    const review = validReview();
    review.checks.postResetRealizedGrossVerified = false;

    expect(() => buildParityEvidence(validReport(), review, HASH)).toThrow(/postResetRealizedGrossVerified/);
  });

  it('requires every controlled-environment field', () => {
    const review = validReview();
    review.environment.ninjaTraderVersion = '';

    expect(() => buildParityEvidence(validReport(), review, HASH)).toThrow(/ninjaTraderVersion/);
  });
});
