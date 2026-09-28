import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES } from '../domain/reconcile';
import { buildOfflineDailyReport, registryForCapture, ROSTER_STALE_DAYS } from './offlineReport';
import { PROVENANCE, renderOfflineReport, summaryText } from './renderOfflineReport';

/* Synthetic only. The shapes are the agent's real capture contract; the numbers
 * are invented so the arithmetic is readable. */

const account = (accountName, over = {}) => ({
  accountName,
  connectionName: 'Tradovate',
  displayName: accountName,
  netLiquidation: 50000,
  cashValue: 50000,
  realizedPnl: 0,
  grossRealizedPnl: 0,
  unrealizedPnl: 0,
  totalPnl: 0,
  weeklyPnl: 0,
  trailingMaxDrawdown: 0,
  buyingPower: 0,
  excessIntradayMargin: 0,
  initialMargin: 0,
  maintenanceMargin: 0,
  currency: 'UsDollar',
  accountValues: {},
  status: 'Connected',
  ...over,
});

const capture = (accounts) => ({
  schemaVersion: 1,
  captureId: 'cap-1',
  capturedAt: '2026-09-25T20:30:00Z',
  tradingDate: '2026-09-25',
  timeZone: 'America/New_York',
  source: { machineId: 'm', agentVersion: '1.1.1', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.6.0' },
  accounts,
  strategies: [],
  orders: [],
  executions: [],
});

describe('the registry the offline report reads', () => {
  it('names an account the roster cannot explain instead of guessing', () => {
    const { registry, pending } = registryForCapture(
      { accounts: [{ accountName: 'KNOWN' }, { accountName: 'NEW' }] },
      { KNOWN: { accountType: 'Funded' } },
    );
    expect(registry.KNOWN.accountType).toBe('Funded');
    expect(registry.NEW.accountType).toBe(ACCOUNT_TYPES.PENDING_CLASSIFICATION);
    expect(pending).toEqual(['NEW']);
  });

  it('treats a roster entry with no type as no entry at all', () => {
    // A row that reached the machine without account_type classifies nothing,
    // and pretending otherwise would put it in the counted bucket.
    const { pending } = registryForCapture(
      { accounts: [{ accountName: 'A' }] },
      { A: { status: 'Active' } },
    );
    expect(pending).toEqual(['A']);
  });

  it('matches the roster without caring about case', () => {
    const { pending } = registryForCapture(
      { accounts: [{ accountName: 'AbC123' }] },
      { abc123: { accountType: 'Funded' } },
    );
    expect(pending).toEqual([]);
  });
});

describe('the report built on the machine', () => {
  const twoAccounts = capture([
    account('FUNDED1', { grossRealizedPnl: 120, weeklyPnl: 300 }),
    account('MYSTERY', { grossRealizedPnl: 1550, weeklyPnl: 1550 }),
  ]);

  it('keeps an unclassifiable account out of the headline', () => {
    // THE DEFECT THIS EXISTS FOR. Measured on a real capture from 2026-09-22:
    // counting the accounts the roster could not explain read +$1,565 against a
    // true $0.00, because the money had moved in evaluation accounts holding
    // challenge capital the client does not own.
    const built = buildOfflineDailyReport({
      capture: twoAccounts,
      roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
      rosterFetchedAt: '2026-09-25T00:00:00Z',
      clientName: 'Someone',
    });
    expect(built.report.totals.grossRealizedPnl).toBe(120);
    expect(built.report.pendingClassificationTotals.grossRealizedPnl).toBe(1550);
    expect(built.pending).toEqual(['MYSTERY']);
  });

  it('totals nothing at all when it has never had a roster', () => {
    const built = buildOfflineDailyReport({ capture: twoAccounts, roster: {}, clientName: 'Someone' });
    expect(built.report.totals.grossRealizedPnl).toBe(0);
    expect(built.report.grouped.pendingClassification).toHaveLength(2);
    expect(built.warnings.join(' ')).toMatch(/never received an account roster/);
  });

  it('says how old the roster is once it is stale', () => {
    const fresh = buildOfflineDailyReport({
      capture: twoAccounts, roster: { FUNDED1: { accountType: 'Funded' }, MYSTERY: { accountType: 'Funded' } },
      rosterFetchedAt: '2026-09-24T00:00:00Z', clientName: 'Someone',
    });
    // The only warning a fresh roster leaves is the empty-section one, because
    // this synthetic capture carries no strategies.
    expect(fresh.warnings.join(' ')).not.toMatch(/roster/);

    const stale = buildOfflineDailyReport({
      capture: twoAccounts, roster: { FUNDED1: { accountType: 'Funded' }, MYSTERY: { accountType: 'Funded' } },
      rosterFetchedAt: '2026-09-01T00:00:00Z', clientName: 'Someone',
    });
    expect(stale.rosterAgeDays).toBe(24);
    expect(stale.warnings.join(' ')).toMatch(new RegExp(`24 days old`));
    expect(ROSTER_STALE_DAYS).toBe(7);
  });

  it('refuses a capture with no trading date rather than dating it itself', () => {
    const undated = { ...twoAccounts, tradingDate: '' };
    expect(() => buildOfflineDailyReport({ capture: undated })).toThrow();
    expect(() => buildOfflineDailyReport({})).toThrow(/No capture/);
  });

  it('splits the platform simulation account out without being told to', () => {
    // Sim101 is NinjaTrader's own, present on every machine. reconcile splits it
    // by name, so the offline path gets that for free and a simulated balance
    // never reaches a client's total.
    const withSim = capture([
      account('FUNDED1', { grossRealizedPnl: 120 }),
      account('Sim101', { grossRealizedPnl: 9999 }),
    ]);
    const built = buildOfflineDailyReport({
      capture: withSim, roster: { FUNDED1: { accountType: 'Funded' } }, clientName: 'Someone',
    });
    expect(built.report.totals.grossRealizedPnl).toBe(120);
    const everyRow = Object.values(built.report.grouped).flat().map((r) => r.accountName);
    expect(everyRow).not.toContain('Sim101');
  });
});

describe('what it must never print', () => {
  it('shows which algorithms ran and none of their parameters', () => {
    // reconcile hands each snapshot its strategies with `parametersRaw` and
    // `params` attached, and those carry every NinjaScript input the strategy
    // was configured with - including a LicenseKey field. The report names the
    // algorithm and says nothing about how it was set up.
    const withStrategy = {
      ...capture([account('FUNDED1', { grossRealizedPnl: 120 })]),
      strategies: [{
        strategyId: '1',
        strategyName: '0 - URGO-4.5',
        strategyDisplayName: 'URGO-4.5',
        accountName: 'FUNDED1',
        instrument: 'MNQ DEC26',
        state: 'Realtime',
        quantity: 0,
        position: 'Flat',
        averagePrice: 0,
        realizedPnl: null,
        unrealizedPnl: null,
        enabled: true,
        sync: null,
        dataSeries: '1 Minute',
        connectionName: 'LegendsT',
        startedAt: null,
        parameters: { LicenseKey: 'SECRET-DO-NOT-PRINT', URGO1: 33, StopLossTicks: 300 },
        parameterCaptureStatus: 'full',
      }],
    };
    const built = buildOfflineDailyReport({
      capture: withStrategy,
      roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
      rosterFetchedAt: '2026-09-25T00:00:00Z',
      clientName: 'Someone',
    });
    const html = renderOfflineReport(built);
    expect(html).toMatch(/URGO/);
    expect(html).toMatch(/MNQ DEC26/);
    expect(html).not.toMatch(/SECRET-DO-NOT-PRINT/);
    expect(html).not.toMatch(/LicenseKey/i);
    expect(html).not.toMatch(/parametersRaw/i);
    expect(html).not.toMatch(/StopLossTicks/);
  });
});

describe('what the agent actually embeds', () => {
  it('builds the report when the strategy parameters have been emptied', () => {
    /* THE FILE ON THE DESKTOP IS NOT THE SHEET.
     *
     * OfflineReportWriter.BuildPayload empties every strategy's `parameters`
     * before embedding the capture, because the raw capture travels inside the
     * file and carries the desk's tuning. It EMPTIES rather than removes:
     * autoExportContract.js requires the property to be an object, and the
     * first version of that strip deleted it, so every capture with a strategy
     * rendered "strategies[0].parameters must be an object" where the client's
     * day should have been. This is that shape. */
    const withEmptiedStrategy = {
      ...capture([account('FUNDED1', { grossRealizedPnl: 120 })]),
      strategies: [{
        strategyId: '1',
        strategyName: '0 - URGO-4.5',
        strategyDisplayName: 'URGO-4.5',
        accountName: 'FUNDED1',
        instrument: 'MNQ DEC26',
        state: 'Realtime',
        quantity: 0,
        position: 'Flat',
        averagePrice: 0,
        realizedPnl: null,
        unrealizedPnl: null,
        enabled: true,
        sync: null,
        dataSeries: '1 Minute',
        connectionName: 'LegendsT',
        startedAt: null,
        parameters: {},
        parameterCaptureStatus: 'partial',
      }],
    };
    const built = buildOfflineDailyReport({
      capture: withEmptiedStrategy,
      roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
      rosterFetchedAt: '2026-09-25T00:00:00Z',
      clientName: 'Someone',
    });
    const html = renderOfflineReport(built);
    expect(html).not.toMatch(/could not be built/i);
    expect(html).not.toMatch(/must be an object/i);
    // The algorithm is still named on the page: that is the part worth keeping.
    expect(html).toMatch(/URGO/);
    expect(html).toMatch(/MNQ DEC26/);
  });
});

describe('the page it prints', () => {
  const built = () => buildOfflineDailyReport({
    capture: capture([
      account('FUNDED1', { grossRealizedPnl: 120 }),
      account('MYSTERY', { grossRealizedPnl: 1550 }),
    ]),
    roster: { FUNDED1: { accountType: 'Funded' } },
    rosterFetchedAt: '2026-09-25T00:00:00Z',
    clientName: 'Corey Krupp',
  });

  it('says on the page that it was made without the CRM', () => {
    // A client-facing document that does not say where it came from invites the
    // reader to assume it came from the desk's record. It did not.
    expect(renderOfflineReport(built())).toContain(PROVENANCE);
  });

  it('prints the warnings where the reader cannot miss them', () => {
    const html = renderOfflineReport(built());
    expect(html).toMatch(/Read before sending/);
    expect(html).toMatch(/MYSTERY/);
  });

  it('opens with no network: no fetch, no remote asset, nothing loaded from a url', () => {
    // It is double-clicked on a Windows VPS that may have no egress at all.
    //
    // THIS USED TO ASSERT `no <script>` AND THAT WAS THE WRONG PROPERTY. The
    // file the agent writes has always carried a script: it is the report
    // bundle, inlined, and it is the only interpreter on a machine with no
    // Node. What has to be true is that nothing is FETCHED, and that is what
    // is asserted now. The page's own script is inline, reads only what is
    // already in the document, and touches no url.
    const html = renderOfflineReport(built());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|import\s*\(/);
  });

  it('offers the PDF, and says not to send the file itself', () => {
    // The close ends in a message with a report attached. Left to Ctrl+P, the
    // thing that gets attached is this .html, which carries the raw capture
    // behind the page.
    const html = renderOfflineReport(built());
    expect(html).toMatch(/Save as PDF/);
    expect(html).toMatch(/window\.print\(\)/);
    expect(html).toMatch(/Send the PDF/);
  });

  it('keeps every control off the paper', () => {
    // Same contract as the CRM's report sheet, where `.report-actions` carries
    // `.no-print` (src/index.css). A button printed onto a client's PDF is a
    // button the client tries to press.
    const html = renderOfflineReport(built());
    expect(html).toMatch(/class="actions no-print"/);
    expect(html).toMatch(/\.no-print \{ display: none !important; \}/);
  });

  it("hands over the desk's own message, not a second one invented here", () => {
    /* A client reading their channel must not be able to tell which day came
     * from the database and which from a VPS with no network, so this is
     * buildClientMessageReport: the same function behind the CRM's "Copy
     * Update" button and behind content.message on every stored close. */
    const summary = summaryText(built());
    expect(summary).toContain('Daily Update');
    expect(summary).toContain('Corey Krupp');
    expect(summary).toMatch(/\*Daily P&L:\*/);
    expect(summary).toMatch(/\*Weekly P&L:\*/);
    expect(summary).toContain('_Any questions? Reply to this message._');
  });

  it('carries the offline warnings into the message', () => {
    // They are the reason a number might be wrong and they exist on this side
    // only. MYSTERY is not in this machine's roster.
    const summary = summaryText(built());
    expect(summary).toMatch(/MYSTERY/);
    expect(summary).toMatch(/not in the total/i);
  });

  it('says the same number the printed sheet says', () => {
    // One arithmetic. The message is pasted into the channel the PDF is
    // attached to; the two disagreeing is the whole defect this guards.
    const report = built();
    const summary = summaryText(report);
    const total = report.report.totals.grossRealizedPnl;
    const money = new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }).format(total);
    expect(summary).toContain(`*Daily P&L:* ${total >= 0 ? '+' : ''}${money}`);
  });

  it('escapes what it prints', () => {
    const built2 = buildOfflineDailyReport({
      capture: capture([account('<img src=x onerror=alert(1)>')]),
      roster: {}, clientName: '<b>hi</b>',
    });
    const html = renderOfflineReport(built2);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<b>hi<\/b>/);
  });

  it('refuses to render nothing', () => {
    expect(() => renderOfflineReport(null)).toThrow(/no report/i);
  });
});
