// The separation itself, asserted where it is actually enforced.
//
// WHY THIS FILE EXISTS. simulationAccounts.test.js covers the classifier and
// the split thoroughly. Nothing covered what the split is FOR: that the
// simulated dollars stay out of desk capital in operationsSegments.js, that
// they stay out of the client report totals in report.js, and that the report
// section carrying them exists at all. A mutation pass over commit dcd3196
// found the whole of buildSimulationSection could be replaced with
// `return null` — the feature deleted outright — with all 1782 tests green,
// and that removing SEGMENTS.SIMULATION from EXCLUDED_FROM_TOTAL, which puts
// $1,099,590 of play money back into desk capital, was equally invisible.
//
// Figures are Craig Weschke's real 2026-08-06 close: Craig - Main $55,893.06
// flat, Craig - Sub 1 $29,936.54 flat, Sim101 $99,590.00 at -$1,297.9999999
// with 40 orders, 15 executions and 2 enabled strategies.

import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_FROM_TOTAL,
  SEGMENTS,
  buildSegmentTotals,
  rollUpByBusiness,
  segmentForAccount,
} from './operationsSegments';
import { ACCOUNT_TYPES, makeAccountAlias } from './reconcile';
import { ACCOUNT_NATURES, classifyAccountNature, splitSimulationRows } from './simulationAccounts';
import { buildSimulationSection } from './report';

const CRAIG_MAIN = 55893.06;
const CRAIG_SUB1 = 29936.54;
const SIM101_BALANCE = 99590;
const SIM101_DAILY = -1297.9999999;

const snapshot = (accountName, over = {}) => ({
  accountName,
  connection: 'Legends',
  accountBalance: 0,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  unrealizedPnl: 0,
  strategies: [],
  ...over,
});

// One client folder as the app holds it after an import: a registry, plus a
// daily import whose live arrays are live-money-only and whose simulated and
// undetermined rows travel in `simulation`.
function craigImport() {
  const registry = {
    'Craig - Main': { accountName: 'Craig - Main', alias: 'Live - Craig - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
    'Craig - Sub 1': { accountName: 'Craig - Sub 1', alias: 'Live - Craig - Sub 1', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
    Sim101: { accountName: 'Sim101', alias: 'Live - Sim101', accountType: ACCOUNT_TYPES.SIMULATION },
  };
  const split = splitSimulationRows({
    accounts: registry,
    snapshots: [
      snapshot('Craig - Main', { accountBalance: CRAIG_MAIN }),
      snapshot('Craig - Sub 1', { accountBalance: CRAIG_SUB1 }),
      snapshot('Sim101', {
        accountBalance: SIM101_BALANCE,
        grossRealizedPnl: SIM101_DAILY,
        strategies: [
          { strategyName: '0 - URGO-4.5 MNQ SEP26', enabled: true },
          { strategyName: '0 - IFSP-1.1 NG SEP26', enabled: true },
          { strategyName: '0 - ARPD-1.1', enabled: false },
        ],
      }),
    ],
    strategies: [
      { accountName: 'Sim101', strategyName: '0 - URGO-4.5 MNQ SEP26', enabled: true },
      { accountName: 'Sim101', strategyName: '0 - IFSP-1.1 NG SEP26', enabled: true },
      { accountName: 'Sim101', strategyName: '0 - ARPD-1.1', enabled: false },
    ],
    orders: Array.from({ length: 40 }, (unused, i) => ({ accountName: 'Sim101', id: `O${i}` })),
    executions: Array.from({ length: 15 }, (unused, i) => ({ accountName: 'Sim101', id: `E${i}` })),
  });
  const client = { id: 'craig', name: 'Craig Weschke', accountRegistry: registry };
  const dailyImport = {
    clientId: 'craig',
    date: '2026-08-06',
    accounts: registry,
    ...split.live,
    simulation: split.simulation,
  };
  return { client, dailyImport, registry };
}

describe('desk capital never contains simulated dollars', () => {
  it('excludes the simulated segment from the total, and says so on the row', () => {
    // Removing SEGMENTS.SIMULATION from this set is the single edit that puts
    // $1,099,590 of NinjaTrader play money back into a figure the desk reports.
    expect(EXCLUDED_FROM_TOTAL.has(SEGMENTS.SIMULATION)).toBe(true);

    const { client, dailyImport } = craigImport();
    const totals = buildSegmentTotals([{ client, dailyImport }]);
    const simulated = totals.segments.find((row) => row.segment === SEGMENTS.SIMULATION);

    expect(simulated).toBeTruthy();
    expect(simulated.countedInTotal).toBe(false);
    expect(simulated.accounts).toBe(1);
    expect(simulated.balance).toBe(SIM101_BALANCE);
    expect(totals.excluded.map((row) => row.segment)).toContain(SEGMENTS.SIMULATION);

    // The figure that goes on a tile is the two real accounts and nothing else.
    expect(totals.total.accounts).toBe(2);
    expect(totals.total.balance).toBeCloseTo(CRAIG_MAIN + CRAIG_SUB1, 2);
    expect(totals.total.dailyPnl).toBe(0);
    expect(rollUpByBusiness(totals).cash.balance).toBeCloseTo(CRAIG_MAIN + CRAIG_SUB1, 2);
    expect(rollUpByBusiness(totals).simulation.balance).toBe(SIM101_BALANCE);
  });

  it('excludes the undetermined segment from the total too', () => {
    expect(EXCLUDED_FROM_TOTAL.has(SEGMENTS.UNDETERMINED)).toBe(true);

    // An account the desk recorded as Funded whose name is NinjaTrader's
    // simulator naming. The two signals disagree, so the money belongs to
    // neither total until a human says which.
    const registry = {
      'Craig - Main': { accountName: 'Craig - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
      Sim101: { accountName: 'Sim101', accountType: ACCOUNT_TYPES.FUNDED },
    };
    const split = splitSimulationRows({
      accounts: registry,
      snapshots: [
        snapshot('Craig - Main', { accountBalance: CRAIG_MAIN }),
        snapshot('Sim101', { accountBalance: SIM101_BALANCE, grossRealizedPnl: SIM101_DAILY }),
      ],
      strategies: [], orders: [], executions: [],
    });
    const dailyImport = { accounts: registry, ...split.live, simulation: split.simulation };
    const totals = buildSegmentTotals([{ client: { accountRegistry: registry }, dailyImport }]);
    const row = totals.segments.find((seg) => seg.segment === SEGMENTS.UNDETERMINED);

    expect(row).toBeTruthy();
    expect(row.countedInTotal).toBe(false);
    expect(row.balance).toBe(SIM101_BALANCE);
    expect(totals.total.accounts).toBe(1);
    expect(totals.total.balance).toBeCloseTo(CRAIG_MAIN, 2);
    expect(totals.total.dailyPnl).toBe(0);
  });

  it('segments a contradiction as undetermined rather than by its stored type', () => {
    // Without this, a Sim101 the desk has stored as Funded lands in the Funded
    // segment, which IS counted in desk capital.
    const meta = { accountName: 'Sim101', accountType: ACCOUNT_TYPES.FUNDED };
    expect(classifyAccountNature(meta, { accountName: 'Sim101' }).nature)
      .toBe(ACCOUNT_NATURES.UNDETERMINED);
    expect(segmentForAccount(meta, 'Sim101')).toBe(SEGMENTS.UNDETERMINED);
    expect(segmentForAccount(meta, 'Sim101')).not.toBe(SEGMENTS.FUNDED);
  });

  it('counts the simulated and undetermined closes instead of dropping them', () => {
    // Separation, not deletion. The old filter deleted these rows and the
    // Operations view could not show that a sim engagement had run at all.
    const { client, dailyImport } = craigImport();
    const totals = buildSegmentTotals([{ client, dailyImport }]);

    expect(totals.accountsSeen).toBe(3);
    expect(totals.simulated.accounts).toBe(1);
    expect(totals.simulated.balance).toBe(SIM101_BALANCE);
    expect(totals.simulated.dailyPnl).toBeCloseTo(SIM101_DAILY, 6);
    // Every close in the folder is on some row, counted or excluded.
    expect(totals.segments.reduce((sum, row) => sum + row.accounts, 0)).toBe(3);
  });
});

describe('the platform naming test stays anchored', () => {
  it('does not treat a real account as a simulator because Sim<number> is somewhere inside its name', () => {
    // Unanchoring PLATFORM_SIM_NAME is a one-character edit. It makes every
    // name CONTAINING sim+digits simulated, and because simulated balances are
    // excluded from desk capital, a live account matched this way vanishes
    // from the total with no flag on any money surface.
    const live = classifyAccountNature({}, { accountName: 'Craig - Sim 1 backup' });
    expect(live.nature).toBe(ACCOUNT_NATURES.LIVE);
    expect(live.source).toBe('default');

    // Anchored at the other end too: an annotated copy is not the platform's
    // own naming, so it is reported rather than bucketed as simulated.
    expect(classifyAccountNature({}, { accountName: 'Sim101 archive' }).nature)
      .not.toBe(ACCOUNT_NATURES.SIMULATION);

    // And the name it does recognise still resolves.
    expect(classifyAccountNature({}, { accountName: 'Sim101' }).nature)
      .toBe(ACCOUNT_NATURES.SIMULATION);
  });
});

describe('makeAccountAlias shows a short name whole', () => {
  it('never prints a client-facing alias that looks like a truncation bug', () => {
    // Sim101 rendered as "Live - m101" in a report the desk sent a client.
    expect(makeAccountAlias('Sim101', 'Live')).toBe('Live - Sim101');
    // Six real accounts across the 11 client exports are bare 7-digit ids.
    for (const name of ['2001608', '2012618', '2015650', '2018219', '2051306', '2066077']) {
      expect(makeAccountAlias(name, 'Legends')).toBe(`Legends - ${name}`);
    }
    // The masking rule itself is untouched: a full prop-firm account number is
    // still shown by its last four.
    expect(makeAccountAlias('LTATAGREH506107949826', 'Legends Trading'))
      .toBe('Legends Trading - 9826');
  });
});

describe('buildSimulationSection', () => {
  it('exists, and reports the simulated close the old filter threw away', () => {
    // The report the desk actually sent Craig read ACCOUNTS 2, DAILY REALIZED
    // PNL $0 on the day this was his only account that traded.
    const { client, dailyImport } = craigImport();
    const section = buildSimulationSection(client, dailyImport, 2);

    expect(section).not.toBeNull();
    expect(section.accounts).toHaveLength(1);
    expect(section.accounts[0].accountName).toBe('Sim101');
    expect(section.totals.aggregateBalance).toBe(SIM101_BALANCE);
    expect(section.totals.grossRealizedPnl).toBeCloseTo(SIM101_DAILY, 6);
    expect(section.counts.orders).toBe(40);
    expect(section.counts.executions).toBe(15);
    expect(section.counts.enabledStrategies).toBe(2);
    expect(section.counts.traded).toBe(true);
    expect(section.accounts[0].enabledStrategies).toEqual([
      '0 - URGO-4.5 MNQ SEP26',
      '0 - IFSP-1.1 NG SEP26',
    ]);
  });

  it('says in words that its figures are in no total above', () => {
    // The section prints currency next to currency. Formatting alone does not
    // carry "this is not money", so the sentence has to, and it has to survive
    // an edit to the copy.
    const { client, dailyImport } = craigImport();
    const section = buildSimulationSection(client, dailyImport, 2);

    expect(section.label).toMatch(/not real money/i);
    expect(section.note).toMatch(/simulated funds/i);
    expect(section.note).toMatch(/not included in any figure above/i);
  });

  it('counts simulated accounts against every account reported, not against the live ones', () => {
    // "1 of 2" against the live count reads as "one of your two real accounts
    // is simulated". The denominator is every account on the report.
    const { client, dailyImport } = craigImport();
    const section = buildSimulationSection(client, dailyImport, 2);

    expect(section.counts.accounts).toBe(1);
    expect(section.counts.liveAccounts).toBe(2);
    expect(section.counts.ofAccountsReported).toBe(3);
    expect(section.counts.ofAccountsReported).toBeGreaterThan(section.counts.liveAccounts);
  });

  it('is null when there is nothing simulated and nothing undetermined', () => {
    // Absence of a section, never a section full of zeros.
    const registry = { 'Craig - Main': { accountName: 'Craig - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT } };
    const split = splitSimulationRows({
      accounts: registry,
      snapshots: [snapshot('Craig - Main', { accountBalance: CRAIG_MAIN })],
      strategies: [], orders: [], executions: [],
    });
    expect(buildSimulationSection(
      { accountRegistry: registry },
      { accounts: registry, ...split.live, simulation: split.simulation },
      1,
    )).toBeNull();
  });
});
