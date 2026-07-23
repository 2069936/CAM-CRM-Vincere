import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, runEvidence } from './create-ninjatrader-parity-evidence.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function matchingSection(field) {
  return {
    apiRowCount: 1,
    gridRowCount: 1,
    rows: [{
      key: 'sensitive-key',
      rowStatus: 'matched',
      fields: [{ field, apiValue: 'sensitive-value', gridValue: 'sensitive-value', status: 'exact' }],
    }],
  };
}

describe('parity evidence command', () => {
  it('parses the comparison, review, and output paths', () => {
    expect(parseArguments([
      '--comparison', 'comparison.json',
      '--review', 'review.json',
      '--out', 'parity-evidence.json',
    ])).toEqual({
      comparisonPath: 'comparison.json',
      reviewPath: 'review.json',
      outputPath: 'parity-evidence.json',
    });
    expect(() => parseArguments(['--comparison', 'comparison.json'])).toThrow(/--review/);
  });

  it('writes sanitized evidence bound to the exact comparison bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vincere-parity-'));
    temporaryDirectories.push(directory);
    const comparisonPath = join(directory, 'comparison.json');
    const reviewPath = join(directory, 'review.json');
    const outputPath = join(directory, 'out', 'parity-evidence.json');
    const report = {
      inputTypes: ['accounts', 'strategies', 'orders', 'executions'],
      sections: {
        accounts: matchingSection('accountName'),
        strategies: matchingSection('strategyName'),
        orders: matchingSection('orderId'),
        executions: matchingSection('executionId'),
      },
    };
    const review = {
      reviewer: 'Approved Operator',
      reviewedAt: '2026-07-23T21:00:00.000Z',
      environment: {
        windowsVersion: 'Windows Server 2025',
        ninjaTraderVersion: '8.1.5.2',
        connectionProvider: 'Approved provider',
        localTimeZone: 'Eastern Standard Time',
      },
      checks: {
        sameMinuteCapture: true,
        postResetRealizedGrossVerified: true,
        twoStrategyAlgorithmsVerified: true,
        currentSessionExecutionsConfirmed: true,
      },
      decisions: [],
    };
    const comparisonText = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(comparisonPath, comparisonText, 'utf8');
    writeFileSync(reviewPath, JSON.stringify(review), 'utf8');

    const evidence = await runEvidence({ comparisonPath, reviewPath, outputPath });

    expect(existsSync(outputPath)).toBe(true);
    expect(evidence.comparisonSha256).toBe(
      createHash('sha256').update(comparisonText).digest('hex'),
    );
    expect(readFileSync(outputPath, 'utf8')).not.toContain('sensitive-value');
  });
});
