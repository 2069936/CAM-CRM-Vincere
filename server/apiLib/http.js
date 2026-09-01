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

export async function readJsonBody(req, {
  maxBytes = 64 * 1024,
  requireRawBody = false,
} = {}) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (requireRawBody) throw new ApiError(400, 'Raw JSON request body is required.');
    requireBodyWithinLimit(req.body, maxBytes);
    return req.body;
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const value = String(req.body);
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
function reportHiddenFailure(error) {
  const parts = [error?.name, error?.code, error?.message]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  if (!parts.length) return;
  console.error(`[CRM] Unhandled API failure: ${parts.join(' ')}`);
}

export function handleApiError(res, error, {
  fallbackMessage = 'Unexpected server error.',
  production = process.env.NODE_ENV === 'production',
  report = reportHiddenFailure,
} = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const exposed = error instanceof ApiError || (status >= 400 && status < 500);
  const message = (production && !exposed) ? fallbackMessage : (error?.message || fallbackMessage);
  if (!exposed) report?.(error);
  for (const [name, value] of Object.entries(error?.headers || {})) res.setHeader(name, value);
  return sendJson(res, status, { error: message });
}
