import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { sendViaBrevo } from '../../../src/domain/emailDelivery.js';
import { AgentReportError, buildAgentReportMessage } from '../../../src/domain/agentReportMail.js';

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

/* THE SECRET NOBODY HAD TO SET.
 *
 * This desk cannot add an environment variable to its own deployment. That is
 * not a hypothetical: server/apiLib/ingestPepper.js exists because
 * INGEST_TOKEN_PEPPER "was never set on this deployment", pairing therefore
 * never worked at all, and "waiting on a secret that only one person can
 * create had blocked the feature for days". The same person, the same
 * blocker, so the same answer - derived from a value the deployment is
 * guaranteed to have, because apiAuth refuses to start without it.
 *
 * An explicit AGENT_MAIL_SECRET still wins when it is set, so nothing here
 * prevents doing this properly later.
 *
 * WHAT THIS COSTS, and it is less than the pepper's. Anyone who obtains the
 * service role key can derive this value - and that key already grants full
 * read and write on every table. What this secret buys them on top is asking
 * one route to email a report to an address that route reads from its own
 * environment. Someone holding the service role key can already read every
 * close in the database directly; they do not need to ask for one by email.
 *
 * The derivation being public is fine and is the point: the input is not.
 */
export function resolveAgentMailSecret(env = process.env) {
  const configured = String(env?.AGENT_MAIL_SECRET || '').trim();
  if (configured) return configured;
  const serviceRoleKey = String(env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceRoleKey) return '';
  return createHmac('sha256', serviceRoleKey)
    .update('cam-crm:agent-mail-secret:v1')
    .digest('hex');
}

/* THE ADDRESS OF THE FUNCTION THAT ACTUALLY SENDS.
 *
 * Derived rather than configured, for the same reason the secret above is:
 * this deployment's environment is not something anyone here can add to. The
 * Edge Function lives on the Supabase project this CRM already talks to, so
 * its host is SUPABASE_URL's host and the rest is a fixed path.
 *
 * An explicit AGENT_MAIL_URL still wins, and an empty answer is honest: the
 * agent then keeps posting to this deployment's own relay route, which works
 * the day somebody does set a Brevo key here.
 */
export function resolveAgentMailUrl(env = process.env) {
  const configured = String(env?.AGENT_MAIL_URL || '').trim();
  if (configured) return configured;
  const supabaseUrl = String(env?.SUPABASE_URL || '').trim();
  if (!supabaseUrl) return '';
  try {
    return new URL('/functions/v1/daily-report-email/agent', supabaseUrl).toString();
  } catch {
    return '';
  }
}

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

export function createHandler({ send = sendViaBrevo, env = process.env } = {}) {
  return async function reportEmail(req, res) {
    try {
      requireMethod(req, ['POST']);

      const secret = resolveAgentMailSecret(env);
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

      let message;
      try {
        /* THE DESTINATION IS NOT IN THE REQUEST, and that is the security of
         * the whole arrangement. A leaked agent secret lets somebody send the
         * desk its own reports; it does not turn this into a way to mail
         * anyone. */
        message = buildAgentReportMessage({
          capture: body?.capture,
          roster: body?.roster,
          rosterFetchedAt: body?.rosterFetchedAt,
          clientName: String(body?.clientName || '').trim(),
          from,
          to: [{ email: to }],
        });
      } catch (error) {
        if (error instanceof AgentReportError) throw new ApiError(400, error.code, error.message);
        throw error;
      }

      const result = await send({ apiKey, ...message });
      return sendJson(res, 202, { ok: true, date: message.date, messageId: result?.messageId || null });
    } catch (error) {
      return handleApiError(res, error, { route: 'ingest/report-email' });
    }
  };
}

export default createHandler();
