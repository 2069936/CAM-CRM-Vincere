import { Buffer } from 'node:buffer';
import process from 'node:process';

export class ApiError extends Error {
  constructor(status, message, { headers = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.headers = headers;
  }
}

export function sendJson(res, status, body) {
  return res.status(status).json(body);
}

export function requireMethod(req, methods) {
  const allowed = Array.isArray(methods) ? methods : [methods];
  if (allowed.includes(req.method)) return;
  throw new ApiError(405, 'Method not allowed.', { headers: { Allow: allowed.join(', ') } });
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    throw new ApiError(400, 'Invalid JSON request body.');
  }
}

function requireBodyWithinLimit(body, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new ApiError(400, 'Invalid JSON request body.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new ApiError(413, 'Request body is too large.');
  }
}

async function readStream(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new ApiError(413, 'Request body is too large.');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* THE PLATFORM PARSES THE BODY, AND ASKING IT NOT TO DOES NOTHING.
 *
 * api/ingest/[action].js exports `config = { api: { bodyParser: false } }`.
 * That key belongs to the Next.js Pages Router and this is not a Next.js
 * project, so nothing reads it. The Vercel Node runtime installs `req.query`
 * and a lazy `req.body` getter together, in one function, and the router in
 * that same file dispatches on `req.query.action`. Routing works, therefore
 * the body getter is installed too. There is no configuration that keeps one
 * and drops the other.
 *
 * Two consequences, and both were live:
 *
 *   - The getter is LAZY and it THROWS when the bytes are not the JSON the
 *     Content-Type promised. Every gzipped upload has Content-Type
 *     application/json, so merely LOOKING at `req.body` threw, out of a line
 *     that was only testing what type it was.
 *   - `requireRawBody` refused a body the platform had already parsed. That
 *     encoded an assumption, that the platform never parses, which is false
 *     here. It rejected every heartbeat with 400 before reading one field.
 *
 * So the body is read defensively and a parsed body is accepted as what it is.
 * The raw stream stays the fallback and still works: the runtime restores it
 * after reading, so a handler that needs the bytes can still have them.
 */
function platformParsedBody(req) {
  try {
    return req?.body;
  } catch {
    // The lazy getter threw, which means the bytes are not what the
    // Content-Type claimed. The stream below is the real source.
    return undefined;
  }
}

export async function readJsonBody(req, {
  maxBytes = 64 * 1024,
} = {}) {
  const body = platformParsedBody(req);
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    requireBodyWithinLimit(body, maxBytes);
    return body;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const value = String(body);
    if (Buffer.byteLength(value) > maxBytes) throw new ApiError(413, 'Request body is too large.');
    return parseJson(value);
  }
  if (req && Symbol.asyncIterator in Object(req)) return parseJson(await readStream(req, maxBytes));
  return {};
}

/* ------------------------------------------------------------------------- *
 * An error the client is not allowed to see still has to be visible somewhere.
 *
 * WHAT THIS COST. The collector spent two days retrying uploads that came back
 * 500. The client is deliberately told only "Unexpected server error", which is
 * right, and until now that was also the whole record: this function formatted a
 * response and dropped the error object. Nothing reached the function logs, so
 * the deployment could not say what had failed either. The failure was
 * unobservable from both ends at once, and all anyone could do was reason
 * backwards from which retry disposition an agent had chosen.
 *
 * WHAT IS SAFE TO WRITE. The name, the code and the message. A PostgREST error
 * carries `code`, which is the Postgres SQLSTATE and is the whole diagnosis in
 * five characters: 42501 is a permission denial, 42P01 a missing relation,
 * 57014 a timeout. Deliberately NOT `details` or `hint`, which quote the row
 * that failed and would put client data in a log, and not the stack, which is
 * long and carries paths.
 *
 * ONLY THE HIDDEN ONES. A 4xx already tells the caller what was wrong, so
 * logging it again would bury the one line that matters under every rejected
 * request.
 * ------------------------------------------------------------------------- */
/* ------------------------------------------------------------------------- *
 * A cause the caller can act on, from a vocabulary that says nothing else.
 *
 * WHY THE CALLER GETS ANYTHING AT ALL. The collector is not a browser, it is a
 * program on a VPS with a log the desk can read, and the only reason two days
 * went by on a 500 is that neither end could name it. Telling it "Unexpected
 * server error" and writing the real cause to a log one person can open makes
 * every future outage take as long as this one did.
 *
 * WHAT IT IS ALLOWED TO SAY. A fixed vocabulary, mapped from SQLSTATE. Not the
 * message, not `details` or `hint` which quote the failing row, not the table,
 * not the query. `server_permission_denied` tells the desk to look at grants and
 * tells an attacker that a backend they cannot reach has a permissions problem,
 * which is a trade worth making once you have watched the alternative.
 *
 * Unknown codes collapse to `server_error`, which is exactly today's silence, so
 * a code nobody anticipated cannot leak by default.
 * ------------------------------------------------------------------------- */
const SQLSTATE_CAUSES = new Map([
  ['42501', 'server_permission_denied'],
  ['42P01', 'server_schema_missing'],
  ['42703', 'server_schema_missing'],
  ['42883', 'server_schema_missing'],
  ['57014', 'server_timeout'],
  ['53300', 'server_capacity'],
  ['53400', 'server_capacity'],
  ['23505', 'server_conflict'],
  ['23503', 'server_conflict'],
]);

export function failureCause(error) {
  const code = String(error?.code ?? '').trim().toUpperCase();
  if (!code) return 'server_error';
  if (SQLSTATE_CAUSES.has(code)) return SQLSTATE_CAUSES.get(code);
  // Connection classes are 08xxx across every driver.
  if (code.startsWith('08')) return 'server_unreachable';
  return 'server_error';
}

function reportHiddenFailure(error) {
  const parts = [error?.name, error?.code, error?.message]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  if (!parts.length) return;
  console.error(`[CRM] Unhandled API failure: ${parts.join(' ')}`);
}

/**
 * @param underlying the real error, when the endpoint has replaced it with a
 *   public one. An endpoint that catches something unexpected and answers with
 *   `new ApiError(500, 'something_unavailable')` is choosing the STATUS, not
 *   choosing to throw away the reason, and without this the reason was thrown
 *   away: the substitute is an ApiError, ApiErrors are treated as deliberate,
 *   and deliberate errors are neither logged nor given a cause. Every
 *   unexpected failure in the snapshot upload path went out as a silent,
 *   causeless 500 for that reason, for days, while the collector retried it.
 *   Only consulted for a 5xx, because a 4xx already told the caller what was
 *   wrong.
 */
export function handleApiError(res, error, {
  fallbackMessage = 'Unexpected server error.',
  production = process.env.NODE_ENV === 'production',
  report = reportHiddenFailure,
  underlying = null,
} = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const exposed = error instanceof ApiError || (status >= 400 && status < 500);
  const message = (production && !exposed) ? fallbackMessage : (error?.message || fallbackMessage);
  for (const [name, value] of Object.entries(error?.headers || {})) res.setHeader(name, value);
  if (exposed && underlying && status >= 500) {
    // The endpoint chose the status and handed over what it was hiding. The
    // caller still reads exactly the string the endpoint picked.
    report?.(underlying);
    return sendJson(res, status, { error: message, cause: failureCause(underlying) });
  }
  if (exposed) return sendJson(res, status, { error: message });
  // Hidden from the caller, so it goes to the log AND comes back as a cause the
  // caller can put in its own log. `error` keeps whatever the endpoint chose, so
  // nothing that reads it today changes.
  report?.(error);
  return sendJson(res, status, { error: message, cause: failureCause(error) });
}
