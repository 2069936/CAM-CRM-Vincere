import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { zipSync, strToU8 } from 'fflate';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { sendViaBrevo } from '../../../src/domain/emailDelivery.js';
import { redactCapture } from '../../../src/offline/captureRedaction.js';
import { buildOfflineDailyReport } from '../../../src/offline/offlineReport.js';
import { renderOfflineReport } from '../../../src/offline/renderOfflineReport.js';

/* ---------------------------------------------------------------------------
 * The one route that still answers when the database does not.
 *
 * THE WHOLE POINT IS WHAT IT DOES NOT TOUCH. Every other ingest route
 * authenticates the agent against `ingest_devices`, which is exactly what is
 * unavailable on the day this matters: on 2026-09-26 Vercel was up and Postgres
 * was not, and the desk spent three days unable to send a client a report. So
 * this reads no table, and a test reads the file back to keep it that way. A
 * query added here is a feature that works on every day except the one it was
 * written for.
 *
 * THE MACHINE SENDS WHAT IT ALREADY HAS, AND THIS BUILDS THE REPORT. The first
 * version took a rendered page, which meant the service on the trading machine
 * had to learn to render one - it is the Setup window that does that today,
 * and the Setup window is not open at the close. Sending the capture instead
 * makes the agent's side a POST of a file it has just written anyway, and puts
 * the rendering on the desk's own server where the report code already runs.
 * The redaction moves with it: one server strips the tuning rather than thirty
 * client machines each being trusted to.
 *
 * WHY THE AGENT DOES NOT HOLD THE MAIL KEY. It runs on about thirty machines
 * carrying live client prop-firm accounts. A sending credential there is a
 * credential in thirty places, and a leak lets someone send mail as the desk to
 * anyone. The secret the agent holds instead buys one thing: asking this route
 * to email a report TO AN ADDRESS THIS ROUTE ALREADY KNOWS. The destination
 * comes from the environment and never from the request.
 * ------------------------------------------------------------------------- */

/** A real machine's capture measured 48 KB at the largest, 30 KB on average. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Equal lengths first, then the constant-time compare.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

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

export function messageFor({ clientName, date, html, warnings = [], from, to }) {
  const stem = fileStem(clientName, date);
  const lines = [
    `${clientName || 'Client'} · ${date}`,
    '',
    'Built on the trading machine from its own captured close, without the CRM.',
    'Account classification comes from the last roster the CRM was able to send to that machine.',
  ];
  /* THE WARNINGS TRAVEL IN THE BODY, NOT ONLY ON THE PAGE. They are the reason
   * a figure might be wrong - a machine with no roster cannot total the day -
   * and a reader who is skimming a phone notification must not have to open
   * the attachment to find that out. */
  if (warnings.length) {
    lines.push('', 'Read before sending:');
    for (const warning of warnings) lines.push(`  • ${warning}`);
  }
  return {
    from,
    to,
    subject: subjectFor(clientName, date),
    text: lines.join('\n'),
    attachments: [{
      // Zipped, like the scheduled mail and for the same reason: Workspace
      // administrators commonly block .html attachments by extension.
      name: `${stem}.zip`,
      bytes: zipSync({ [`${stem}.html`]: strToU8(html) }, { level: 6 }),
    }],
  };
}

export function createHandler({ send = sendViaBrevo, env = process.env } = {}) {
  return async function reportEmail(req, res) {
    try {
      requireMethod(req, ['POST']);

      const secret = env.AGENT_MAIL_SECRET || '';
      const to = env.AGENT_MAIL_TO || '';
      const from = env.DAILY_EMAIL_FROM || '';
      const apiKey = env.BREVO_API_KEY || '';
      /* Refuses rather than accepting anonymously. This route is reachable from
       * anywhere whatever the agent does, and a relay that sends for whoever
       * asks is a relay that sends for whoever finds it. */
      if (!secret || !apiKey || !to || !from) {
        throw new ApiError(503, 'mail_not_configured', 'Report email is not configured on this deployment.');
      }
      if (!constantTimeEquals(req.headers['x-agent-mail-secret'], secret)) {
        throw new ApiError(401, 'unauthorized', 'Not authorised.');
      }

      const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
      const clientName = String(body?.clientName || '').trim();
      if (!body?.capture) throw new ApiError(400, 'no_capture', 'There is no capture in the request.');

      let built;
      try {
        /* Redacted before it is read, not after. The licence key and the
         * tuning have no part in a report and no reason to exist in this
         * process's memory for longer than the parse. */
        built = buildOfflineDailyReport({
          capture: redactCapture(body.capture),
          roster: body.roster || {},
          rosterFetchedAt: body.rosterFetchedAt || null,
          clientName,
        });
      } catch (error) {
        // The machine's own capture failed our own contract. That is worth
        // saying back to it rather than answering 500 with nothing in it.
        throw new ApiError(400, 'bad_capture', error?.message || 'The capture could not be read.');
      }

      const date = built?.report?.date || '';
      const html = renderOfflineReport(built);

      /* THE DESTINATION IS NOT IN THE REQUEST, and that is the security of the
       * whole arrangement. A leaked agent secret lets somebody send the desk
       * its own reports; it does not turn this into a way to mail anyone. */
      const result = await send({
        apiKey,
        ...messageFor({ clientName, date, html, warnings: built.warnings || [], from, to: [{ email: to }] }),
      });

      return sendJson(res, 202, { ok: true, date, messageId: result?.messageId || null });
    } catch (error) {
      return handleApiError(res, error, { route: 'ingest/report-email' });
    }
  };
}

export default createHandler();
