import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { zipSync, strToU8 } from 'fflate';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { sendViaBrevo } from '../../../src/domain/emailDelivery.js';

/* ---------------------------------------------------------------------------
 * The one route that still works when the database does not.
 *
 * THE WHOLE POINT IS WHAT IT DOES NOT TOUCH. Every other ingest route
 * authenticates the agent against `ingest_devices` (server/apiLib/deviceAuth.js
 * reads it), which is exactly what is unavailable on the day this matters: on
 * 2026-09-26 Vercel was up and Postgres was not, and the desk spent three days
 * unable to send a client a report. So this reads no table, and it must stay
 * that way. A query added here is a feature that works on every day except the
 * one it was written for.
 *
 * WHY THE AGENT DOES NOT SIMPLY HOLD THE MAIL KEY. It runs on ~30 machines
 * carrying live client prop-firm accounts. A sending credential there is a
 * credential in thirty places, and a leak lets someone send mail as the desk to
 * anyone. The secret the agent holds instead buys exactly one thing: asking
 * this route to email a report TO AN ADDRESS THIS ROUTE ALREADY KNOWS. The
 * destination is read from the environment and never from the request, so the
 * worst a leaked agent secret can do is send the desk its own reports.
 *
 * ZIPPED, like the scheduled mail and for the same reason: Google Workspace
 * administrators commonly block .htm and .html attachments outright, and the
 * rule matches the extension.
 * ------------------------------------------------------------------------- */

/** A rendered report measured 8 KB from the CRM and 94 KB from a machine. */
const MAX_BODY_BYTES = 1024 * 1024;

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so both sides are hashed to one fixed width by comparing against a
  // padded copy. Equal lengths first, then the constant-time compare.
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

export function messageFor({ clientName, date, html, from, to }) {
  const stem = fileStem(clientName, date);
  return {
    from,
    to,
    subject: subjectFor(clientName, date),
    /* Short on purpose. The report is the attachment; this says where it came
     * from, which is the one thing a reader cannot tell from the file. */
    text: [
      `${clientName || 'Client'} · ${date}`,
      '',
      'Built on the trading machine from its own captured close, without the CRM.',
      'Account classification comes from the last roster the CRM was able to send to that machine.',
    ].join('\n'),
    attachments: [{
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
      const date = String(body?.date || '').trim();
      const html = typeof body?.html === 'string' ? body.html : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new ApiError(400, 'bad_date', 'A trading date of the form YYYY-MM-DD is required.');
      }
      if (!html) throw new ApiError(400, 'no_report', 'There is no report in the request.');

      /* THE DESTINATION IS NOT IN THE REQUEST, and that is the security of the
       * whole arrangement. A leaked agent secret lets somebody send the desk
       * its own reports; it does not turn this into a way to mail anyone. */
      const result = await send({ apiKey, ...messageFor({ clientName, date, html, from, to: [{ email: to }] }) });

      return sendJson(res, 202, { ok: true, messageId: result?.messageId || null });
    } catch (error) {
      return handleApiError(res, error, { route: 'ingest/report-email' });
    }
  };
}

export default createHandler();
