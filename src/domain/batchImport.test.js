import { describe, it, expect } from 'vitest';
import {
  parseNinjaTraderFileDate,
  parseNinjaTraderFileTimeKey,
} from './csvImport.js';
import { groupParsedFilesByDate, buildBatchImportPlan } from './batchImport.js';

describe('parseNinjaTraderFileDate', () => {
  it('extracts the date from the export filename', () => {
    expect(parseNinjaTraderFileDate('NinjaTrader Grid 2026-07-21 04-07 PM1.csv')).toBe('2026-07-21');
  });

  it('returns null when there is no valid date', () => {
    expect(parseNinjaTraderFileDate('accounts.csv')).toBeNull();
    expect(parseNinjaTraderFileDate('2026-13-40 bad.csv')).toBeNull();
  });
});

describe('parseNinjaTraderFileTimeKey', () => {
  it('orders exports by their time stamp, PM after AM', () => {
    const am = parseNinjaTraderFileTimeKey('NinjaTrader Grid 2026-07-21 09-30 AM1.csv');
    const pm = parseNinjaTraderFileTimeKey('NinjaTrader Grid 2026-07-21 04-07 PM1.csv');
    expect(pm).toBeGreaterThan(am);
  });

  it('returns 0 when the name has no time stamp', () => {
    expect(parseNinjaTraderFileTimeKey('accounts.csv')).toBe(0);
  });
});

describe('groupParsedFilesByDate', () => {
  const acct = (name) => ({ fileName: name, type: 'accounts', rows: [{ accountName: 'ACC1' }] });

  it('groups files under the date in their filename', () => {
    const grouped = groupParsedFilesByDate(
      [
        acct('NinjaTrader Grid 2026-07-20 04-00 PM1.csv'),
        acct('NinjaTrader Grid 2026-07-21 04-00 PM1.csv'),
      ],
      '2026-07-99',
    );
    expect(Object.keys(grouped).sort()).toEqual(['2026-07-20', '2026-07-21']);
  });

  it('falls back to fallbackDate when the name has no date', () => {
    const grouped = groupParsedFilesByDate([acct('accounts.csv')], '2026-07-21');
    expect(grouped['2026-07-21'].accounts).toHaveLength(1);
  });

  it('de-dupes a repeat export of the same grid, keeping the later one', () => {
    const early = { fileName: 'NinjaTrader Grid 2026-07-21 09-00 AM1.csv', type: 'accounts', rows: [{ accountName: 'OLD' }] };
    const late = { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM1.csv', type: 'accounts', rows: [{ accountName: 'NEW' }] };
    const grouped = groupParsedFilesByDate([early, late], '2026-07-21');
    expect(grouped['2026-07-21'].accounts).toEqual([{ accountName: 'NEW' }]);
  });

  it('ignores unknown-type files', () => {
    const grouped = groupParsedFilesByDate(
      [{ fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM9.csv', type: 'unknown', rows: [] }],
      '2026-07-21',
    );
    expect(Object.keys(grouped)).toHaveLength(0);
  });
});

describe('buildBatchImportPlan', () => {
  const clients = [
    { id: 'c1', name: 'Todd', accountRegistry: { ACC1: { accountName: 'ACC1' } } },
    { id: 'c2', name: 'Other', accountRegistry: { ZZZ: { accountName: 'ZZZ' } } },
  ];

  it('builds one group per date and matches clients by account name', () => {
    const parsedFiles = [
      { fileName: 'NinjaTrader Grid 2026-07-20 04-00 PM1.csv', type: 'accounts', rows: [{ accountName: 'ACC1', accountBalance: 50000, grossRealizedPnl: 0 }] },
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM1.csv', type: 'accounts', rows: [{ accountName: 'ACC1', accountBalance: 51000, grossRealizedPnl: 100 }] },
    ];
    const plan = buildBatchImportPlan({ parsedFiles, clients, fallbackDate: '2026-07-21' });
    expect(plan.datesCount).toBe(2);
    expect(plan.totalMatches).toBe(2);
    const day21 = plan.dates.find((d) => d.date === '2026-07-21');
    expect(day21.clientMatches).toHaveLength(1);
    expect(day21.clientMatches[0].clientId).toBe('c1');
    expect(day21.clientMatches[0].result.date).toBe('2026-07-21');
  });

  describe('a position opened on one day of the batch and closed on another', () => {
    // The only way a multi-day upload can price such a lot is for each day it
    // reconciles to become the carry-in history of the day after it. Day one
    // opens 2 MNQ long at 100 and holds them; day two sells them at 110.
    const twoDayBatch = (accountRow2) => [
      { fileName: 'NinjaTrader Grid 2026-07-20 04-00 PM1.csv', type: 'accounts', rows: [{ accountName: 'ACC1', accountBalance: 50000, grossRealizedPnl: 0, grossRealizedPnlReported: 0 }] },
      { fileName: 'NinjaTrader Grid 2026-07-20 04-00 PM2.csv', type: 'strategies', rows: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', realized: null, enabled: true }] },
      { fileName: 'NinjaTrader Grid 2026-07-20 04-00 PM3.csv', type: 'orders', rows: [{ id: 'D1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }] },
      { fileName: 'NinjaTrader Grid 2026-07-20 04-00 PM4.csv', type: 'executions', rows: [{ id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 2, price: 100, position: '2 L', orderId: 'D1', time: '7/20/2026 9:30:01 AM' }] },
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM1.csv', type: 'accounts', rows: [accountRow2] },
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM2.csv', type: 'strategies', rows: [{ accountName: 'ACC1', strategyName: 'Alpha-1.0', realized: null, enabled: true }] },
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM3.csv', type: 'orders', rows: [{ id: 'D2', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' }] },
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM4.csv', type: 'executions', rows: [{ id: '9_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 2, price: 110, position: '-', orderId: 'D2', time: '7/21/2026 9:35:01 AM' }] },
    ];

    it('prices it, because the earlier day of the batch became the later day\'s history', () => {
      const plan = buildBatchImportPlan({
        parsedFiles: twoDayBatch({ accountName: 'ACC1', accountBalance: 51000, grossRealizedPnl: 40, grossRealizedPnlReported: 40 }),
        clients,
        fallbackDate: '2026-07-21',
      });
      const day21 = plan.dates.find((d) => d.date === '2026-07-21');
      const snapshot = day21.clientMatches[0].result.snapshots[0];
      expect(snapshot.derivation.status).toBe('exact');
      expect(snapshot.strategies[0].derivedRealized).toBe(40);
    });

    it('still refuses the day whose own opening position nothing in the batch explains', () => {
      // Day one is dropped from the upload. Day two now sells 2 contracts that
      // no day in the batch and no stored close ever opened.
      const files = twoDayBatch({ accountName: 'ACC1', accountBalance: 51000, grossRealizedPnl: 40, grossRealizedPnlReported: 40 })
        .filter((file) => !file.fileName.includes('2026-07-20'));
      const plan = buildBatchImportPlan({ parsedFiles: files, clients, fallbackDate: '2026-07-21' });
      const snapshot = plan.dates[0].clientMatches[0].result.snapshots[0];
      expect(snapshot.derivation.status).toBe('refused');
      expect(snapshot.strategies[0].derivedRealized).toBeNull();
    });
  });

  it('reports accounts that match no client as unmatched', () => {
    const parsedFiles = [
      { fileName: 'NinjaTrader Grid 2026-07-21 04-00 PM1.csv', type: 'accounts', rows: [{ accountName: 'GHOST', accountBalance: 1, grossRealizedPnl: 0 }] },
    ];
    const plan = buildBatchImportPlan({ parsedFiles, clients, fallbackDate: '2026-07-21' });
    expect(plan.totalMatches).toBe(0);
    expect(plan.dates[0].unmatched).toContain('GHOST');
  });
});
