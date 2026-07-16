import { describe, expect, it } from 'vitest';
import { buildCamOverview } from './camOverview';

function makeClient({ id, name, importedAt = '2026-06-08T22:00:00.000Z', registry = {}, snapshots = [] }) {
  return {
    id,
    name,
    accountRegistry: registry,
    dailyImports: [{
      id: `${id}-close`,
      importedAt,
      snapshots,
    }],
  };
}

function makeSnapshot({ accountName, weeklyPnl = 0, strategies = [] }) {
  return {
    accountName,
    weeklyPnl,
    grossRealizedPnl: strategies.reduce((total, strategy) => total + Number(strategy.realized || 0), 0),
    strategies,
  };
}

function makeStrategy({ name, family = 'RBO', version = '1.8', realized = 0, enabled = true }) {
  return {
    strategyName: name || `0 - ${family}-${version}`,
    strategyFamily: family,
    strategyVersion: version,
    realized,
    enabled,
  };
}

describe('buildCamOverview', () => {
  it('groups running strategies across clients by family and version', () => {
    const clients = [
      makeClient({
        id: 'client-a',
        name: 'Amanda',
        registry: { ACC1: { alias: 'Lucid - 1001', accountType: 'Funded' } },
        snapshots: [makeSnapshot({
          accountName: 'ACC1',
          weeklyPnl: 200,
          strategies: [makeStrategy({ realized: 100 })],
        })],
      }),
      makeClient({
        id: 'client-b',
        name: 'Daniel',
        registry: { ACC2: { alias: 'Lucid - 1002', accountType: 'Evaluation - Standard' } },
        snapshots: [makeSnapshot({
          accountName: 'ACC2',
          weeklyPnl: 50,
          strategies: [makeStrategy({ realized: -50 })],
        })],
      }),
    ];

    const overview = buildCamOverview(clients);

    expect(overview.algorithms).toHaveLength(1);
    expect(overview.algorithms[0]).toMatchObject({
      algorithm: 'RBO',
      version: '1.8',
      accounts: 2,
      instances: 2,
      totalRealized: 50,
      avgRealized: 25,
      avgAccountWeeklyPnl: 125,
    });
    expect(overview.algorithms[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientName: 'Amanda', accountAlias: 'Lucid - 1001', realized: 100, accountWeeklyPnl: 200 }),
      expect.objectContaining({ clientName: 'Daniel', accountAlias: 'Lucid - 1002', realized: -50, accountWeeklyPnl: 50 }),
    ]));
  });

  it('falls back to the strategy name when family and version are unknown', () => {
    const overview = buildCamOverview([
      makeClient({
        id: 'client-a',
        name: 'Amanda',
        snapshots: [makeSnapshot({
          accountName: 'ACC1',
          strategies: [makeStrategy({ name: 'Custom Algo', family: '', version: '', realized: 10 })],
        })],
      }),
    ]);

    expect(overview.algorithms[0]).toMatchObject({
      algorithm: 'Custom Algo',
      version: '',
      accounts: 1,
      instances: 1,
    });
  });

  it('flags a materially worse strategy instance when the peer group has enough samples', () => {
    const overview = buildCamOverview([
      makeClient({
        id: 'client-a',
        name: 'Amanda',
        registry: { ACC1: { alias: 'Lucid - 1001' }, ACC2: { alias: 'Lucid - 1002' } },
        snapshots: [
          makeSnapshot({ accountName: 'ACC1', strategies: [makeStrategy({ realized: 110 })] }),
          makeSnapshot({ accountName: 'ACC2', strategies: [makeStrategy({ realized: 100 })] }),
        ],
      }),
      makeClient({
        id: 'client-b',
        name: 'Daniel',
        registry: { ACC3: { alias: 'Lucid - 1003' }, ACC4: { alias: 'Lucid - 1004' } },
        snapshots: [
          makeSnapshot({ accountName: 'ACC3', strategies: [makeStrategy({ realized: -140 })] }),
          makeSnapshot({ accountName: 'ACC4', strategies: [makeStrategy({ realized: 105 })] }),
        ],
      }),
    ]);

    expect(overview.deviationFlags).toEqual([
      expect.objectContaining({
        severity: 'Warning',
        algorithm: 'RBO 1.8',
        clientName: 'Daniel',
        accountAlias: 'Lucid - 1003',
      }),
    ]);
  });

  it('does not flag small or flat peer groups', () => {
    const smallGroup = buildCamOverview([
      makeClient({
        id: 'client-a',
        name: 'Amanda',
        snapshots: [
          makeSnapshot({ accountName: 'ACC1', strategies: [makeStrategy({ realized: 100 })] }),
          makeSnapshot({ accountName: 'ACC2', strategies: [makeStrategy({ realized: -100 })] }),
        ],
      }),
    ]);
    const flatGroup = buildCamOverview([
      makeClient({
        id: 'client-b',
        name: 'Daniel',
        snapshots: [
          makeSnapshot({ accountName: 'ACC1', strategies: [makeStrategy({ realized: 25 })] }),
          makeSnapshot({ accountName: 'ACC2', strategies: [makeStrategy({ realized: 25 })] }),
          makeSnapshot({ accountName: 'ACC3', strategies: [makeStrategy({ realized: 25 })] }),
        ],
      }),
    ]);

    expect(smallGroup.deviationFlags).toEqual([]);
    expect(flatGroup.deviationFlags).toEqual([]);
  });

  it('attaches execution movement points to algorithm instances', () => {
    const clients = [
      {
        id: 'client-a',
        name: 'Amanda',
        accountRegistry: { ACC1: { alias: 'Lucid - 1001' } },
        dailyImports: [{
          id: 'client-a-close',
          importedAt: '2026-06-08T22:00:00.000Z',
          executions: [
            { accountName: 'ACC1', strategyName: '2 - RBO-1.8', time: '9:30 AM', price: 100, action: 'Buy' },
            { accountName: 'ACC1', strategyName: '2 - RBO-1.8', time: '9:45 AM', price: 108, action: 'Sell' },
            { accountName: 'ACC1', strategyName: '0 - OGX-1.0', time: '10:00 AM', price: 200, action: 'Buy' },
          ],
          snapshots: [makeSnapshot({
            accountName: 'ACC1',
            strategies: [{
              ...makeStrategy({ name: '2 - RBO-1.8', realized: 80 }),
              params: {
                parsed: true,
                direction: 'Both',
                posSizes: [2, 2, 2],
                profitTargets: [155, 175, 250],
                stopLossTicks: 105,
              },
            }],
          })],
        }],
      },
    ];
    const overview = buildCamOverview(clients);

    expect(overview.algorithms[0].items[0].executionPoints).toEqual([
      expect.objectContaining({ time: '9:30 AM', price: 100, action: 'Buy' }),
      expect.objectContaining({ time: '9:45 AM', price: 108, action: 'Sell' }),
    ]);
  });

  it('resolves accountAlias and accountType case-insensitively when registry key casing differs from snapshot', () => {
    const clients = [
      makeClient({
        id: 'client-ci',
        name: 'CI Test',
        registry: { APEX1234: { alias: 'My Funded', accountType: 'Funded' } },
        snapshots: [makeSnapshot({
          accountName: 'apex1234',
          weeklyPnl: 300,
          strategies: [makeStrategy({ realized: 180 })],
        })],
      }),
    ];

    const overview = buildCamOverview(clients);

    expect(overview.algorithms[0].items[0]).toMatchObject({
      accountAlias: 'My Funded',
      accountType: 'Funded',
    });
  });
});
