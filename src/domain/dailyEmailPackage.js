import { zipSync, strToU8 } from 'fflate';
import { buildClientMessageReport, buildDailyReportSummary } from './report';
import { PROVENANCE_FROM_CRM, renderOfflineReport } from '../offline/renderOfflineReport';
import { clientsWithCloseOn } from './dailyReportPackage';
import { strategyRan } from './strategyRan';

/* ---------------------------------------------------------------------------
 * One email, once a day, carrying a CAM's whole close.
 *
 * WHY HTML AND NOT PDF. The PDF path needs a headless Chromium inside a
 * serverless function, which is why buildDailyReportPackage renders eleven
 * reports one at a time and still risks the 60 second ceiling on
 * api/report/pdf.js. This produces the same sheet as a standalone HTML file
 * with its own inline stylesheet, no fetch and no font: eleven of them measured
 * 75 KB in total, the largest 8 KB, against hundreds of KB and a browser launch
 * each for the PDFs. It is plain JavaScript over the desk record, so it runs
 * anywhere JavaScript runs - including a Supabase Edge Function, which is the
 * point: nobody on this desk has the access to add a secret to Vercel.
 *
 * The reader loses nothing. The file opens on a double click, reflows on a
 * phone where a PDF does not, and carries the print button that turns it into
 * the same PDF from wherever it was opened.
 *
 * ZIPPED, AND THAT IS NOT ABOUT SIZE. 75 KB needs no compression. Google
 * Workspace administrators commonly block .htm and .html attachments outright,
 * because an HTML attachment is a standard phishing vehicle; the rule matches
 * on the extension, so a .zip carrying them is not matched. Whether this
 * desk's administrator has that rule set is unknown and unknowable from here,
 * so the attachment is shaped to survive either answer.
 *
 * ONE FAILURE MUST NOT COST THE OTHERS, the same rule the PDF package follows.
 * A client whose report cannot be built is named in the body and the other ten
 * still go. An empty package is reported rather than sent.
 * ------------------------------------------------------------------------- */

/** The subject a CAM sees in their phone's notification, so it leads with the day. */
export function subjectFor(date, clientCount) {
  const clients = `${clientCount} client${clientCount === 1 ? '' : 's'}`;
  return `Daily reports · ${date} · ${clients}`;
}

export function packageFileNames(date) {
  return {
    reports: `reports-${date}.zip`,
    raw: `raw-${date}.json`,
  };
}

/* WHAT THE RAW FILE IS ALLOWED TO CONTAIN, NAMED ONE FIELD AT A TIME.
 *
 * Measured on production on 2026-09-28: of 16,435 strategy_snapshots rows,
 * 16,273 carry a LicenseKey and 12,239 carry a licence value that matches the
 * live format. The tuning is there too - StopLossTicks on 16,170 of them, and
 * the URGO inputs, the day filters and the trade windows beside it. That is the
 * desk's edge and a working licence, and a raw export that simply removed the
 * fields it currently knows about would leak the next one somebody adds.
 *
 * So this is an allowlist, not a redaction. A field that is not named here does
 * not travel, whatever appears upstream. The full record still exists and is
 * still reachable: Deep Export, asked for by a person, on one machine at a time.
 */
function rawAccount(snapshot) {
  return {
    accountName: snapshot.accountName ?? null,
    alias: snapshot.meta?.alias ?? null,
    accountType: snapshot.meta?.accountType ?? null,
    status: snapshot.meta?.status ?? null,
    grossRealizedPnl: numberOrNull(snapshot.grossRealizedPnl),
    weeklyPnl: numberOrNull(snapshot.weeklyPnl),
    unrealizedPnl: numberOrNull(snapshot.unrealizedPnl),
    accountBalance: numberOrNull(snapshot.accountBalance),
    trailingMaxDrawdown: numberOrNull(snapshot.trailingMaxDrawdown),
    strategies: (snapshot.strategies || []).map((strategy) => ({
      strategyFamily: strategy.strategyFamily ?? null,
      strategyVersion: strategy.strategyVersion ?? null,
      strategyName: strategy.strategyName ?? null,
      instrument: strategy.instrument ?? null,
      // The CRM's own answer, not a guess made here: a strategy that was
      // enabled and in Realtime ran, whether or not it happened to trade.
      ran: strategyRan(strategy),
      realized: numberOrNull(strategy.realized),
    })),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildRawExport({ entries, date, generatedAt }) {
  return {
    date,
    generatedAt: generatedAt ?? null,
    source: 'Vincere CRM desk record',
    /* Said in the file, not only in the code, because the person who opens it
     * six months from now is looking for a number that is not there. */
    redaction:
      'Strategy parameters are not included: they carry the desk licence key '
      + 'and the algorithm tuning. Use Deep Export on the machine for the full record.',
    clients: entries.map(({ client, dailyImport }) => ({
      client: client?.name || 'Client',
      accounts: (dailyImport?.snapshots || []).map(rawAccount),
    })),
  };
}

/**
 * Everything one email carries, built from the desk record alone.
 *
 * @param clients      the CAM's book.
 * @param date         'YYYY-MM-DD'.
 * @param generatedAt  ISO stamp, passed in rather than read, so a test can
 *                     assert the whole payload byte for byte.
 * @param camName      shown in the body so a forwarded email says whose it is.
 */
export function buildDailyEmailPackage({ clients, date, generatedAt = null, camName = '' }) {
  const entries = clientsWithCloseOn(clients, date);
  const built = [];
  const failed = [];

  for (const entry of entries) {
    try {
      const report = buildDailyReportSummary(entry.client, entry.dailyImport);
      const html = renderOfflineReport({
        report,
        client: entry.client,
        dailyImport: entry.dailyImport,
        warnings: [],
        metadata: null,
        // Never the offline sentence. These numbers came from the database.
        provenance: PROVENANCE_FROM_CRM,
      });
      built.push({ ...entry, report, html });
    } catch (error) {
      failed.push({ client: entry.client?.name || 'Client', reason: error?.message || 'could not be built' });
    }
  }

  const attachments = [];
  const attachmentNames = packageFileNames(date);

  if (built.length) {
    const files = {};
    const names = entryNames(built, date);
    for (const [index, item] of built.entries()) {
      files[`${names[index]}.html`] = strToU8(item.html);
    }
    /* A ZIP IS A MAP, AND A MAP LOSES A COLLISION IN SILENCE.
     *
     * Three pairs of clients on the real book share a name. Keyed on the name
     * alone this produced 59 files for 62 reports, and the CAM had no way to
     * know which three were missing: the count is not printed on a zip. The
     * names are disambiguated above, and this is the assertion that the
     * disambiguation worked, because the next way to collide will not be one
     * anybody predicted. */
    if (Object.keys(files).length !== built.length) {
      throw new Error(
        `The report package would have lost ${built.length - Object.keys(files).length} of ${built.length} reports to a file name collision.`,
      );
    }
    // Level 6 rather than the PDF package's 0: these are HTML and compress to
    // about a fifth, where a PDF is already compressed and deflating it buys
    // nothing for the seconds it costs.
    attachments.push({ name: attachmentNames.reports, bytes: zipSync(files, { level: 6 }) });
  }

  const raw = buildRawExport({ entries: built, date, generatedAt });
  attachments.push({ name: attachmentNames.raw, bytes: strToU8(`${JSON.stringify(raw, null, 2)}\n`) });

  return {
    subject: subjectFor(date, built.length),
    text: bodyFor({ built, failed, date, camName }),
    attachments,
    built: built.map((item) => item.client?.name || 'Client'),
    failed,
  };
}

/* THE BODY IS THE REPORT, NOT A COVERING NOTE.
 *
 * A CAM reads this on a phone, at the close, to find out whether anything needs
 * them tonight. An email that says "your reports are attached" makes them open
 * eleven files to learn nothing happened. So the numbers are in the body, and
 * they are the SAME numbers the attachment carries and the same text the CAM
 * pastes into a client's channel, because buildClientMessageReport is what
 * produces all three. Three places that must agree, one function.
 */
export function bodyFor({ built, failed = [], date, camName = '' }) {
  const lines = [];
  lines.push(`Daily reports · ${date}${camName ? ` · ${camName}` : ''}`);
  lines.push('');
  if (!built.length) {
    lines.push('No client has a close for this date.');
    return lines.join('\n');
  }

  for (const item of built) {
    lines.push(buildClientMessageReport(item.client, item.dailyImport));
    lines.push('');
    lines.push('—'.repeat(3));
    lines.push('');
  }

  if (failed.length) {
    lines.push(`Not built (${failed.length}):`);
    for (const failure of failed) lines.push(`  • ${failure.client}: ${failure.reason}`);
    lines.push('');
  }

  lines.push('The same reports are attached as HTML, one file per client.');
  lines.push('Open one and print it if a client asks for a PDF.');
  return lines.join('\n');
}

/* The file name inside the zip, matching what the desk already files by hand:
 * "<Client> - <date> daily report". reportFileName.js owns the sanitiser for
 * the PDF paths; this one is deliberately stricter because a zip entry name
 * travels through more implementations than a download does. */
function fileStem(clientName, date) {
  const name = String(clientName || 'Client')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Client';
  return `${name} - ${date} daily report`;
}

/* TWO CLIENTS CAN HAVE THE SAME NAME, AND THREE PAIRS DO.
 *
 * Wren Larch, Oakley Larch and Ellis Onyx are each two different clients on the
 * real book. The disambiguator is the client's own id and it is applied to
 * EVERY file of a repeated name, not to the second one found: a suffix handed
 * out by discovery order moves between the two clients whenever the book is
 * ordered differently, so yesterday's "(2)" is today's plain name and a CAM
 * filing these cannot tell one client's history from the other's.
 *
 * A client whose name is unique keeps the plain name it has always had.
 */
function entryNames(built, date) {
  const counts = new Map();
  for (const item of built) {
    const stem = fileStem(item.client?.name, date);
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }
  return built.map((item) => {
    const stem = fileStem(item.client?.name, date);
    if ((counts.get(stem) || 0) < 2) return stem;
    const id = String(item.client?.id || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
    return id ? `${stem} (${id})` : stem;
  });
}
