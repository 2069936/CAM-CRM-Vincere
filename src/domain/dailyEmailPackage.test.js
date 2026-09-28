import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDailyEmailPackage, buildRawExport, subjectFor } from './dailyEmailPackage';

/* The synthetic half of this suite. Its sibling dailyEmailPackage.book.test.js
 * asserts the same rules against the real book and is dropped from any run that
 * cannot see public/local-snapshot.json, which is every CI run. What guards a
 * file that emails a client's money has to run on CI, so the rules live here
 * and the scale lives there. */

const account = (name, type, extra = {}) => ({
  accountName: name,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  accountBalance: 50000,
  unrealizedPnl: 0,
  trailingMaxDrawdown: 1000,
  strategies: [],
  ...extra,
  meta: { accountType: type, alias: name, status: 'Active', ...(extra.meta || {}) },
});

const client = (id, name, snapshots, registry) => ({
  id,
  name,
  accountRegistry: registry
    || Object.fromEntries(snapshots.map((s) => [s.accountName, { accountType: s.meta.accountType, status: 'Active' }])),
  dailyImports: [{ id: `${id}-close`, date: '2026-09-28', accounts: {}, snapshots, flags: [] }],
});

const ONE = client('c1', 'Corey Krupp', [
  account('F1', 'Funded', { grossRealizedPnl: 120, weeklyPnl: 300 }),
]);

const build = (clients = [ONE], date = '2026-09-28') => buildDailyEmailPackage({
  clients, date, generatedAt: '2026-09-28T21:00:00Z', camName: 'Peter',
});

const zipOf = (pkg) => unzipSync(pkg.attachments.find((a) => a.name.endsWith('.zip')).bytes);
const rawOf = (pkg) => JSON.parse(strFromU8(pkg.attachments.find((a) => a.name.endsWith('.json')).bytes));

describe('the subject', () => {
  it('leads with the day, because it is read from a notification', () => {
    expect(subjectFor('2026-09-28', 11)).toBe('Daily reports · 2026-09-28 · 11 clients');
  });

  it('does not say "1 clients"', () => {
    expect(subjectFor('2026-09-28', 1)).toBe('Daily reports · 2026-09-28 · 1 client');
  });
});

describe('what is attached', () => {
  it('attaches the reports and the raw, and nothing else', () => {
    expect(build().attachments.map((a) => a.name)).toEqual([
      'reports-2026-09-28.zip', 'raw-2026-09-28.json',
    ]);
  });

  it('names the files the way the desk already files them', () => {
    expect(Object.keys(zipOf(build()))).toEqual(['Corey Krupp - 2026-09-28 daily report.html']);
  });

  it('strips what a file name may not contain', () => {
    const awkward = client('c9', 'A/B: "C" <D>', [account('F1', 'Funded')]);
    expect(Object.keys(zipOf(build([awkward])))[0]).toBe('A B C D - 2026-09-28 daily report.html');
  });

  /* A ZIP IS A MAP AND A MAP LOSES A COLLISION IN SILENCE. Three pairs of
   * clients on the real book share a name; keyed on the name alone the zip
   * held 59 files for 62 reports and nothing printed 62 to compare against. */
  it('loses no report to two clients sharing a name', () => {
    const twins = [
      client('c1', 'Wren Larch', [account('A1', 'Funded')]),
      client('c2', 'Wren Larch', [account('B1', 'Funded')]),
      client('c3', 'Someone Else', [account('C1', 'Funded')]),
    ];
    const names = Object.keys(zipOf(build(twins)));
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('disambiguates every file of a repeated name, not the second one found', () => {
    /* A suffix handed out by discovery order moves between the two clients
     * whenever the book is ordered differently, so yesterday's "(2)" is
     * today's plain name and a CAM filing these cannot tell the two
     * histories apart. The unique name keeps the name it always had. */
    const twins = [
      client('aaaa1111', 'Wren Larch', [account('A1', 'Funded')]),
      client('bbbb2222', 'Wren Larch', [account('B1', 'Funded')]),
      client('cccc3333', 'Someone Else', [account('C1', 'Funded')]),
    ];
    const names = Object.keys(zipOf(build(twins)));
    expect(names).toContain('Wren Larch - 2026-09-28 daily report (aaaa1111).html');
    expect(names).toContain('Wren Larch - 2026-09-28 daily report (bbbb2222).html');
    expect(names).toContain('Someone Else - 2026-09-28 daily report.html');
  });
});

describe('what the reports say', () => {
  it('does not claim to have been made on a trading machine', () => {
    /* The offline renderer's provenance line says there was no CRM and the
     * classification came from a cached roster. Every word of that is false
     * here, and the line exists so a reader can tell the two apart. */
    const html = strFromU8(Object.values(zipOf(build()))[0]);
    expect(html).toContain('Generated from the desk record at the close.');
    expect(html).not.toContain('without the CRM');
  });

  it('carries no stylesheet, font or script it would have to fetch', () => {
    // It is opened from a mail attachment, on a phone, possibly offline.
    const html = strFromU8(Object.values(zipOf(build()))[0]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});

describe('the raw file', () => {
  const withTuning = client('c1', 'Corey Krupp', [
    account('F1', 'Funded', {
      grossRealizedPnl: 120,
      strategies: [{
        strategyFamily: 'URGO',
        strategyVersion: '4.5',
        strategyName: '0 - URGO-4.5',
        instrument: 'MNQ DEC26',
        enabled: true,
        state: 'Realtime',
        realized: 120,
        parameters: { LicenseKey: 'V-9E2B00-SECRET', URGO1: 33, StopLossTicks: 300 },
        parametersRaw: '{"LicenseKey":"V-9E2B00-SECRET"}',
        extraValues: { LicenseKey: 'V-9E2B00-SECRET', EdgeLeverage: false },
      }],
    }),
  ]);

  /* Measured on production on 2026-09-28: of 16,435 strategy_snapshots rows,
   * 16,273 carry a LicenseKey and 12,239 carry a live licence value, with the
   * tuning beside it. An allowlist, not a redaction, so the next field
   * somebody adds upstream does not travel by default. */
  it('carries no licence key and no tuning, even when the row does', () => {
    // The data only. The document's own `redaction` line says the words
    // "Strategy parameters are not included", which is the point of it.
    const text = JSON.stringify(rawOf(build([withTuning])).clients);
    for (const forbidden of [
      'V-9E2B00-SECRET', 'LicenseKey', 'parametersRaw', 'parameters', 'extraValues',
      'StopLossTicks', 'URGO1', 'EdgeLeverage',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('still names the algorithm that ran', () => {
    // The other half of the rule: a raw file that dropped the family name too
    // would be safe and useless.
    const strategy = rawOf(build([withTuning])).clients[0].accounts[0].strategies[0];
    expect(strategy).toEqual({
      strategyFamily: 'URGO',
      strategyVersion: '4.5',
      strategyName: '0 - URGO-4.5',
      instrument: 'MNQ DEC26',
      ran: true,
      realized: 120,
    });
  });

  it('keeps exactly the account fields a CAM needs, and no others', () => {
    const account0 = rawOf(build()).clients[0].accounts[0];
    expect(Object.keys(account0)).toEqual([
      'accountName', 'alias', 'accountType', 'status',
      'grossRealizedPnl', 'weeklyPnl', 'unrealizedPnl',
      'accountBalance', 'trailingMaxDrawdown', 'strategies',
    ]);
  });

  it('says in the file why a number is missing', () => {
    expect(rawOf(build()).redaction).toMatch(/Deep Export/);
  });

  it('is empty rather than wrong when nothing closed', () => {
    const raw = buildRawExport({ entries: [], date: '2026-09-28', generatedAt: null });
    expect(raw.clients).toEqual([]);
    expect(raw.date).toBe('2026-09-28');
  });
});

describe('the body', () => {
  it('carries the numbers, so a phone does not have to open an attachment', () => {
    const text = build().text;
    expect(text).toContain('Daily Update');
    expect(text).toContain('*Daily P&L:*');
    expect(text).toContain('Corey Krupp');
  });

  it('is the same text the CAM pastes into the client channel', () => {
    // Three places must agree: this body, the attached sheet and the message.
    // buildClientMessageReport produces all three.
    expect(build().text).toContain('_Any questions? Reply to this message._');
  });

  it('names a client whose report could not be built, and sends the rest', () => {
    const broken = { id: 'c2', name: 'Broken', accountRegistry: {}, dailyImports: [{ date: '2026-09-28', snapshots: [{ accountName: 'X' }], get accounts() { throw new Error('registry unreadable'); } }] };
    const pkg = build([ONE, broken]);
    expect(pkg.built).toEqual(['Corey Krupp']);
    expect(pkg.failed).toEqual([{ client: 'Broken', reason: 'registry unreadable' }]);
    expect(pkg.text).toContain('Not built (1)');
    expect(pkg.text).toContain('Broken: registry unreadable');
  });

  it('says so plainly when no client closed, and still records the absence', () => {
    const pkg = build([ONE], '1999-01-01');
    expect(pkg.text).toContain('No client has a close for this date.');
    expect(pkg.built).toHaveLength(0);
    expect(pkg.attachments.map((a) => a.name)).toEqual(['raw-1999-01-01.json']);
  });
});
