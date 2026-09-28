import { zipSync, strToU8 } from 'fflate';
import { redactCapture } from '../offline/captureRedaction.js';
import { buildOfflineDailyReport } from '../offline/offlineReport.js';
import { renderOfflineReport } from '../offline/renderOfflineReport.js';

/* ---------------------------------------------------------------------------
 * One machine's own close, turned into a message.
 *
 * Pure, and in src/domain rather than beside a route, because it runs in two
 * places now: the Vercel ingest route, and a Supabase Edge Function. The second
 * exists because the Brevo key cannot live on the first - nobody on this desk
 * can add an environment variable to that deployment, and the repository is
 * public so a committed ciphertext would be published to the world for good.
 * Supabase Edge Function secrets are neither: the CAM sets them himself, they
 * are not rows in Postgres, and they are not in git.
 *
 * REDACTED BEFORE IT IS READ. The licence key and the algorithm tuning have no
 * part in a report and no reason to exist in the process's memory past the
 * parse. One server strips them rather than thirty client machines each being
 * trusted to have done it.
 * ------------------------------------------------------------------------- */

export function fileStem(clientName, date) {
  const name = String(clientName || 'Client')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Client';
  return `${name} - ${date} daily report`;
}

/** What a machine's own report is called in a mailbox, so it sorts by client. */
export function subjectFor(clientName, date) {
  return `Daily report · ${clientName || 'Client'} · ${date}`;
}

export class AgentReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentReportError';
    this.code = code;
  }
}

/**
 * @param capture           the machine's capture, exactly as it wrote it.
 * @param roster            the roster it had cached, or nothing.
 * @param rosterFetchedAt   ISO, or null.
 * @param clientName        whose close this is.
 * @param from,to           the addresses, which never come from the request.
 * @returns {{ date, subject, text, attachments }}
 */
export function buildAgentReportMessage({
  capture, roster = {}, rosterFetchedAt = null, clientName = '', from, to,
}) {
  if (!capture) throw new AgentReportError('no_capture', 'There is no capture in the request.');

  let built;
  try {
    built = buildOfflineDailyReport({
      capture: redactCapture(capture),
      roster: roster || {},
      rosterFetchedAt: rosterFetchedAt || null,
      clientName,
    });
  } catch (error) {
    // The machine's own capture failed our own contract. Worth saying back to
    // it rather than answering with nothing.
    throw new AgentReportError('bad_capture', error?.message || 'The capture could not be read.');
  }

  const date = built?.report?.date || '';
  const html = renderOfflineReport(built);
  const stem = fileStem(clientName, date);
  const warnings = built.warnings || [];

  const lines = [
    `${clientName || 'Client'} · ${date}`,
    '',
    'Built on the trading machine from its own captured close, without the CRM.',
    'Account classification comes from the last roster the CRM was able to send to that machine.',
  ];
  /* THE WARNINGS TRAVEL IN THE BODY, NOT ONLY ON THE PAGE. They are the reason
   * a figure might be wrong - a machine with no roster cannot total the day -
   * and a reader skimming a phone notification should not have to open the
   * attachment to learn that. */
  if (warnings.length) {
    lines.push('', 'Read before sending:');
    for (const warning of warnings) lines.push(`  • ${warning}`);
  }

  return {
    date,
    from,
    to,
    subject: subjectFor(clientName, date),
    text: lines.join('\n'),
    attachments: [{
      /* Zipped, and not for size. Google Workspace administrators commonly
       * block .htm and .html attachments outright, because an HTML attachment
       * is a standard phishing vehicle, and the rule matches the extension. */
      name: `${stem}.zip`,
      bytes: zipSync({ [`${stem}.html`]: strToU8(html) }, { level: 6 }),
    }],
  };
}
