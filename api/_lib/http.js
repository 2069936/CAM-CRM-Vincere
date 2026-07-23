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

export async function readJsonBody(req, { maxBytes = 64 * 1024 } = {}) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const value = String(req.body);
    if (Buffer.byteLength(value) > maxBytes) throw new ApiError(413, 'Request body is too large.');
    return parseJson(value);
  }
  if (req && Symbol.asyncIterator in Object(req)) return parseJson(await readStream(req, maxBytes));
  return {};
}

export function handleApiError(res, error, {
  fallbackMessage = 'Unexpected server error.',
  production = process.env.NODE_ENV === 'production',
} = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const exposed = error instanceof ApiError || (status >= 400 && status < 500);
  const message = (production && !exposed) ? fallbackMessage : (error?.message || fallbackMessage);
  for (const [name, value] of Object.entries(error?.headers || {})) res.setHeader(name, value);
  return sendJson(res, status, { error: message });
}
