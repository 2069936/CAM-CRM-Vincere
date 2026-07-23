import { describe, expect, it } from 'vitest';
import {
  buildManualRowKey,
  compareProbeSnapshot,
  compareFieldValues,
  normalizeManualGridFile,
  renderComparisonMarkdown,
  selectDailyPnl,
} from './manualGridNormalization.mjs';

describe('manual NinjaTrader grid normalization', () => {
  it('preserves realized and gross PnL separately and selects gross only as zero fallback', () => {
    const csv = [
      'Cash value,Connection,Gross realized PnL,Display name,Realized PnL',
      '"$51,245.75",Live,"$140.25",SIM-01,$0.00',
    ].join('\n');

    const result = normalizeManualGridFile(csv, 'accounts.csv');

    expect(result.type).toBe('accounts');
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      accountName: 'SIM-01',
      connectionName: 'Live',
      cashValue: 51245.75,
      realizedPnl: 0,
      grossRealizedPnl: 140.25,
    });
    expect(selectDailyPnl(result.rows[0])).toEqual({
      value: 140.25,
      source: 'gross_fallback',
    });
  });

  it('detects and maps all four grids from reordered alternate headers', () => {
    const files = [
      normalizeManualGridFile([
        'Parameters,Instrument,Account display name,Strategy,State,Enabled,Realized,Unrealized',
        'Long / 1 (MyTradeDirection / PositionSize),NQ 09-26,SIM-01,RBO-1.8,Realtime,True,$12.50,$1.25',
      ].join('\n'), 'anything-a.csv'),
      normalizeManualGridFile([
        'Remaining,Filled,Type,State,Account display name,ID,Instrument,Action,Quantity,Limit,Stop,Avg price,Time,Strategy',
        '1,1,Limit,Working,SIM-01,order-1,NQ 09-26,Buy,2,20120.25,,20120.25,7/23/2026 4:44:45 PM,RBO-1.8',
      ].join('\n'), 'anything-b.csv'),
      normalizeManualGridFile([
        'Price,Order ID,Ex.,Account display name,Instrument,Action,Quantity,Time,ID,Position,Commission,Rate',
        '20120.25,order-1,Entry,SIM-01,NQ 09-26,Buy,1,7/23/2026 4:44:46 PM,execution-1,Long,$1.24,$0.35',
      ].join('\n'), 'anything-c.csv'),
    ];

    expect(files.map((file) => file.type)).toEqual(['strategies', 'orders', 'executions']);
    expect(files[0].rows[0]).toMatchObject({
      strategyName: 'RBO-1.8', accountName: 'SIM-01', instrument: 'NQ 09-26',
      state: 'Realtime', realizedPnl: 12.5, unrealizedPnl: 1.25, enabled: true,
    });
    expect(files[1].rows[0]).toMatchObject({
      orderId: 'order-1', accountName: 'SIM-01', orderType: 'Limit', quantity: 2,
      filled: 1, remaining: 1, limitPrice: 20120.25, stopPrice: null,
    });
    expect(files[2].rows[0]).toMatchObject({
      executionId: 'execution-1', orderId: 'order-1', accountName: 'SIM-01',
      price: 20120.25, commission: 1.24, fee: 0.35,
    });
  });

  it('rejects a header set that matches more than one grid type', () => {
    const csv = [
      'Strategy,Account display name,Parameters,State,Type,Filled,Remaining,Instrument',
      'RBO-1.8,SIM-01,params,Working,Limit,0,1,NQ 09-26',
    ].join('\n');

    const result = normalizeManualGridFile(csv, 'ambiguous.csv');

    expect(result.type).toBe('unknown');
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous_grid_type' }),
    ]));
  });

  it('builds stable section keys with documented identifier fallbacks', () => {
    expect(buildManualRowKey('accounts', { accountName: ' SIM-01 ' })).toBe('sim-01');
    expect(buildManualRowKey('strategies', {
      accountName: 'SIM-01', strategyName: 'RBO-1.8', instrument: 'NQ 09-26',
    })).toBe('sim-01|rbo-1.8|nq 09-26');
    expect(buildManualRowKey('orders', {
      accountName: 'SIM-01', orderId: '', nativeId: 'native-1',
    })).toBe('sim-01|native-1');
    expect(buildManualRowKey('executions', {
      accountName: 'SIM-01', executionId: '', orderId: 'order-1',
      time: '2026-07-23T16:44:46-04:00', quantity: 1, price: 20120.25,
    })).toBe('sim-01|order-1|2026-07-23t16:44:46-04:00|1|20120.25');
  });

  it('classifies exact, normalized, absent, and mismatched field values', () => {
    expect(compareFieldValues(12.5, 12.5)).toBe('exact');
    expect(compareFieldValues(' Buy ', 'buy')).toBe('normalized-match');
    expect(compareFieldValues(null, 12.5)).toBe('missing-api');
    expect(compareFieldValues(12.5, null)).toBe('missing-grid');
    expect(compareFieldValues(12.5, 14)).toBe('value-mismatch');
  });

  it('reports field parity by matched row key instead of filename or position', () => {
    const manual = normalizeManualGridFile([
      'Display name,Cash value,Realized PnL,Gross realized PnL,Connection',
      'SIM-02,$10.00,$5.00,$7.00,Live',
      'SIM-01,"$51,245.75",$0.00,$140.25,Live',
    ].join('\n'), 'random.csv');
    const snapshot = {
      accounts: [{
        accountName: 'SIM-01', connectionName: 'Live', cashValue: 51245.75,
        realizedPnl: 0, grossRealizedPnl: 140.25,
      }],
      strategies: [], orders: [], executions: [],
    };

    const report = compareProbeSnapshot(snapshot, [manual]);
    const matched = report.sections.accounts.rows.find((row) => row.key === 'sim-01');
    const extraGrid = report.sections.accounts.rows.find((row) => row.key === 'sim-02');

    expect(matched.rowStatus).toBe('matched');
    expect(matched.fields.find((field) => field.field === 'grossRealizedPnl').status).toBe('exact');
    expect(extraGrid.rowStatus).toBe('missing-api-row');
    expect(report.summary['missing-api-row']).toBe(1);
  });

  it('renders a reviewable markdown parity report', () => {
    const markdown = renderComparisonMarkdown({
      summary: { exact: 4, 'value-mismatch': 1 },
      sections: {
        accounts: {
          apiRowCount: 1,
          gridRowCount: 1,
          rows: [{
            key: 'sim-01', rowStatus: 'matched',
            fields: [{ field: 'cashValue', apiValue: 10, gridValue: 12, status: 'value-mismatch' }],
          }],
        },
      },
    });

    expect(markdown).toContain('# NinjaTrader probe comparison');
    expect(markdown).toContain('## Accounts');
    expect(markdown).toContain('| sim-01 | cashValue | 10 | 12 | value-mismatch |');
  });
});
