import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import { clientsWithCloseOn } from './dailyReportPackage';
import { buildDailyEmailPackage, buildRawExport, subjectFor } from './dailyEmailPackage';

/**
 * Rendered against public/local-snapshot.json, the real redacted book. The
 * close of 2026-07-23 is the fullest one in it: 62 clients with a close, and
 * three pairs of clients that share a name.
 */
const BOOK = JSON.parse(readFileSync('public/local-snapshot.json', 'utf8'));
const CLIENTS = buildCrmStateFromTables(BOOK.tables || {}).clients || [];
const DATE = '2026-07-23';

const build = () => buildDailyEmailPackage({
  clients: CLIENTS,
  date: DATE,
  generatedAt: '2026-07-23T21:00:00Z',
  camName: 'Peter',
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

describe('the package, over the real book', () => {
  it('builds a report for every client that closed', () => {
    const pkg = build();
    expect(pkg.built.length).toBe(clientsWithCloseOn(CLIENTS, DATE).length);
    expect(pkg.failed).toHaveLength(0);
  });

  /* A ZIP IS A MAP AND A MAP LOSES A COLLISION IN SILENCE.
   *
   * Wren Larch, Oakley Larch and Ellis Onyx are each two different clients on
   * this book. Keyed on the name alone the zip held 59 files for 62 reports,
   * and nothing anywhere printed 62 for the CAM to compare it against. */
  it('loses no report to two clients sharing a name', () => {
    const pkg = build();
    expect(Object.keys(zipOf(pkg))).toHaveLength(pkg.built.length);
  });

  it('disambiguates every file of a repeated name, not the second one found', () => {
    // A suffix handed out by discovery order moves between the two clients
    // when the book is ordered differently, so yesterday's "(2)" is today's
    // plain name and a CAM filing these cannot tell the histories apart.
    const names = Object.keys(zipOf(build()));
    const wren = names.filter((name) => name.startsWith('Wren Larch - '));
    expect(wren).toHaveLength(2);
    for (const name of wren) expect(name).toMatch(/\(.+\)\.html$/);
  });

  it('names the files the way the desk already files them', () => {
    const names = Object.keys(zipOf(build()));
    expect(names.some((name) => /^[^/]+ - 2026-07-23 daily report(?: \(.+\))?\.html$/.test(name))).toBe(true);
  });

  it('attaches the reports and the raw, and nothing else', () => {
    const pkg = build();
    expect(pkg.attachments.map((a) => a.name)).toEqual([
      'reports-2026-07-23.zip',
      'raw-2026-07-23.json',
    ]);
  });

  /* WHY HTML AND NOT PDF, IN A NUMBER. The PDF path launches a Chromium per
   * client inside a 60 second function. This is plain JavaScript over the desk
   * record, and the whole close fits in a rounding error of an attachment. */
  it('stays small enough that no mail gateway has an opinion about it', () => {
    const pkg = build();
    const total = pkg.attachments.reduce((sum, a) => sum + a.bytes.length, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('what the reports say', () => {
  it('does not claim to have been made on a trading machine', () => {
    /* The offline renderer's provenance line says there was no CRM and the
     * classification came from a cached roster. Every word of that is false
     * here, and the line exists so a reader can tell the two apart. */
    const first = Object.values(zipOf(build()))[0];
    const html = strFromU8(first);
    expect(html).toContain('Generated from the desk record at the close.');
    expect(html).not.toContain('without the CRM');
  });

  it('carries no stylesheet, font or script it would have to fetch', () => {
    // It is opened from a mail attachment, on a phone, possibly offline.
    for (const bytes of Object.values(zipOf(build())).slice(0, 5)) {
      const html = strFromU8(bytes);
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/<link[^>]+href=/i);
      expect(html).not.toMatch(/<script[^>]+src=/i);
    }
  });
});

describe('the raw file', () => {
  /* Measured on production on 2026-09-28: of 16,435 strategy_snapshots rows,
   * 16,273 carry a LicenseKey and 12,239 carry a live licence value, with the
   * tuning beside it. An allowlist, not a redaction, so the next field
   * somebody adds upstream does not travel by default. */
  it('carries no licence key and no tuning', () => {
    // The data only. The document's own `redaction` line says the words
    // "Strategy parameters are not included", which is the point of it.
    const text = JSON.stringify(rawOf(build()).clients);
    for (const forbidden of [
      'LicenseKey', 'parametersRaw', 'parameters_raw', 'parameters', 'params', 'extraValues',
      'StopLossTicks', 'ProfitTargetTicks', 'TradeStartTime', 'EdgeLeverage',
      // URGO1..URGO4 are inputs. Bare 'URGO' is the algorithm's family name and
      // belongs in the file: naming what ran is the whole point of the report.
      'URGO1', 'URGO2', 'URGO3', 'URGO4',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('still names the algorithm that ran', () => {
    // The line above forbids the tuning. This is the other half of that rule:
    // a raw file that dropped the family name too would be safe and useless.
    const families = new Set(rawOf(build())
      .clients.flatMap((client) => client.accounts)
      .flatMap((account) => account.strategies)
      .map((strategy) => strategy.strategyFamily)
      .filter(Boolean));
    expect(families.size).toBeGreaterThan(0);
  });

  it('says in the file why a number is missing', () => {
    expect(rawOf(build()).redaction).toMatch(/Deep Export/);
  });

  it('keeps the account figures the CAM actually needs', () => {
    const raw = rawOf(build());
    const account = raw.clients.flatMap((client) => client.accounts).find((a) => a.accountName);
    expect(account).toMatchObject({
      accountName: expect.any(String),
    });
    expect(Object.keys(account)).toEqual([
      'accountName', 'alias', 'accountType', 'status',
      'grossRealizedPnl', 'weeklyPnl', 'unrealizedPnl',
      'accountBalance', 'trailingMaxDrawdown', 'strategies',
    ]);
  });

  it('names the algorithm and says whether it ran, and nothing about how it was set up', () => {
    const raw = rawOf(build());
    const strategy = raw.clients
      .flatMap((client) => client.accounts)
      .flatMap((account) => account.strategies)
      .find(Boolean);
    if (!strategy) return;
    expect(Object.keys(strategy)).toEqual([
      'strategyFamily', 'strategyVersion', 'strategyName', 'instrument', 'ran', 'realized',
    ]);
  });

  it('is empty rather than wrong when nothing closed', () => {
    const raw = buildRawExport({ entries: [], date: '2026-09-28', generatedAt: null });
    expect(raw.clients).toEqual([]);
    expect(raw.date).toBe('2026-09-28');
  });
});

describe('the body', () => {
  it('carries the numbers, so a phone does not have to open an attachment', () => {
    const pkg = build();
    expect(pkg.text).toContain('Daily Update');
    expect(pkg.text).toContain('*Daily P&L:*');
  });

  it('is the same text the CAM pastes into the client channel', () => {
    // Three places must agree: this body, the attached sheet, and the message.
    // buildClientMessageReport produces all three.
    const pkg = build();
    expect(pkg.text).toContain('_Any questions? Reply to this message._');
  });

  it('fits under the length Gmail clips a message at', () => {
    // Gmail clips around 102 KB and hides the rest behind "View entire message",
    // which on a phone is exactly the part a CAM would stop reading.
    expect(new TextEncoder().encode(build().text).length).toBeLessThan(102 * 1024);
  });

  it('says so plainly when no client closed', () => {
    const pkg = buildDailyEmailPackage({ clients: CLIENTS, date: '1999-01-01' });
    expect(pkg.text).toContain('No client has a close for this date.');
    expect(pkg.built).toHaveLength(0);
    // The raw still travels, so the absence is recorded rather than inferred.
    expect(pkg.attachments.map((a) => a.name)).toEqual(['raw-1999-01-01.json']);
  });
});
