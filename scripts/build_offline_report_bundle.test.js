/**
 * @vitest-environment jsdom
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';

/* The bundle the agent inlines into every report it writes. These assertions
 * are about the FILE, not about the modules inside it: the modules have their
 * own tests, and what can go wrong here is the packaging. */

const BUNDLE = path.join(
  process.cwd(),
  'collector/src/Vincere.AutoExport.Agent.UI/OfflineReport/report-bundle.js',
);

const account = (accountName, over = {}) => ({
  accountName, connectionName: 'Tradovate', displayName: accountName,
  netLiquidation: 50000, cashValue: 50000, realizedPnl: 0, grossRealizedPnl: 0,
  unrealizedPnl: 0, totalPnl: 0, weeklyPnl: 0, trailingMaxDrawdown: 0,
  buyingPower: 0, excessIntradayMargin: 0, initialMargin: 0, maintenanceMargin: 0,
  currency: 'UsDollar', accountValues: {}, status: 'Connected', ...over,
});

const payload = {
  capture: {
    schemaVersion: 1, captureId: 'c1', capturedAt: '2026-09-25T20:30:00Z',
    tradingDate: '2026-09-25', timeZone: 'America/New_York',
    source: { machineId: 'm', agentVersion: '1.1.1', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.6.0' },
    accounts: [account('FUNDED1', { grossRealizedPnl: 120 }), account('MYSTERY', { grossRealizedPnl: 1550 })],
    strategies: [], orders: [], executions: [],
  },
  roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
  rosterFetchedAt: '2026-09-25T00:00:00Z',
  clientName: 'Someone',
};

describe.skipIf(!fs.existsSync(BUNDLE))('the bundle the agent ships', () => {
  let source;
  beforeAll(() => { source = fs.readFileSync(BUNDLE, 'utf8'); });

  it('names no address to call', () => {
    // It is opened on a VPS that may have no egress, and a request from a
    // client's machine to somewhere nobody chose is worse than a blank page.
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('makes no request when it renders', () => {
    /* ASSERTED ON BEHAVIOUR, NOT ON THE TEXT, AND THAT IS DELIBERATE.
     *
     * The bundle does contain the string XMLHttpRequest: strategyRan imports
     * csvImport, which imports PapaParse, whose streaming reader uses XHR when
     * you hand it a URL. Nothing here hands it a URL, so that path is dead
     * code riding along for a helper. Asserting the string is absent would
     * fail for a reason that is not about whether the file phones home, so
     * this watches whether one is actually opened.
     */
    const opened = [];
    const realOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (...args) { opened.push(args[1]); };
    try {
      const json = JSON.stringify(payload).replace(/</g, '\\u003c');
      document.body.innerHTML = `<script id="vincere-offline-data" type="application/json">${json}</script>`;
      new Function(source)();
    } finally {
      window.XMLHttpRequest.prototype.open = realOpen;
    }
    expect(opened).toEqual([]);
  });

  it('is one file with nothing left to resolve', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+["']\.\.?\//);
  });

  it('does not carry the desk book that sits beside it in public/', () => {
    // vite copies publicDir into outDir unless told not to, and public/ holds
    // local-snapshot.json: 63 MB of real client closes. It would have gone
    // into the agent package and from there onto client machines.
    expect(source.length).toBeLessThan(400 * 1024);
  });

  it('renders the sheet when the page holds the data', () => {
    // The whole point: the agent writes data plus this file, a browser opens
    // it, and a report appears with no CRM and no network.
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    document.body.innerHTML = `<script id="vincere-offline-data" type="application/json">${json}</script>`;
    new Function(source)();
    const text = document.body.textContent;
    expect(text).toMatch(/Someone/);
    expect(text).toMatch(/\$120\.00/);
    // MYSTERY is not in the roster, so it is shown and not counted.
    expect(text).toMatch(/MYSTERY/);
    expect(text).toMatch(/Not classified on this machine/);
  });

  it('says why rather than showing a blank page when the data is broken', () => {
    document.body.innerHTML = '<script id="vincere-offline-data" type="application/json">{ not json</script>';
    new Function(source)();
    expect(document.body.textContent).toMatch(/could not be built/i);
  });
});
