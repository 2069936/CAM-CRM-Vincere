import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { normalizeCollectorVersion } from '../../apiLib/collectorVersion.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import {
  SIGNED_UPLOAD_SECONDS,
  byteSizeOf,
  createTradingExportDeviceStore,
} from '../../apiLib/tradingExportStore.js';
import {
  TRADING_EXPORT_DATASETS,
  TRADING_EXPORT_MAX_BYTES,
  isIsoDate,
} from '../../../src/domain/tradingExport.js';

/* THE AGENT'S HALF OF A SLIM TRADING EXPORT (step 72), three routes.
 *
 *   POST /api/ingest/export-request     { agentVersion }
 *     -> { ok, request: null | { id, from, to, datasets, maxBytes } }
 *   POST /api/ingest/export-upload-url  { requestId, sha256, byteSize, contentType }
 *     -> { ok, uploadUrl, path, expiresAt }
 *   POST /api/ingest/export-complete    { requestId, status, sha256, byteSize,
 *                                         rowCounts, from, to, errorCode }
 *     -> { ok, status }
 *
 * Authenticated exactly like the heartbeat and the agent update poll: the
 * device token and machine id headers, checked before the body is read. Each
 * body has its own keys and nothing else; a key the route does not know is a
 * 400, like the heartbeat, and an absent nullable key reads as null.
 *
 * Their own keys and not fields on the heartbeat, for the reason the agent
 * update poll gives: the heartbeat refuses a key it does not know, and every
 * deployed agent depends on that staying true.
 *
 * THE BYTES NEVER PASS THROUGH HERE. Vercel caps a request body far below the
 * 25 MiB an export may reach, so export-upload-url hands the agent a signed
 * upload URL into the private bucket and export-complete only looks at what
 * landed: the object must be at the path with exactly the size the upload
 * declared. Storage keeps an MD5 etag, not a SHA-256, so the agent's digest is
 * what is recorded (and compared when the object's metadata carries one).
 *
 * A REQUEST IS ONLY EVER THIS DEVICE'S. Every lookup and every function call
 * carries the authenticated device's id; another device's request id is
 * answered exactly like one that does not exist, 404 export_request_not_found.
 *
 * Before step 72 runs, every route answers 404 not_found, which the agent
 * treats like a CRM without these routes. A database or storage fault is a 503
 * the agent retries; nothing here is worth a 500 in a VPS log. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UPLOAD_CONTENT_TYPE = 'application/gzip';

export const config = { api: { bodyParser: false } };

function invalidRequest(status = 400) {
  return new ApiError(status, 'invalid_request');
}

function nullable(value) {
  return value === undefined ? null : value;
}

function plainObject(value, keys) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !keys.has(key))) {
    throw invalidRequest();
  }
  return value;
}

function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidRequest();
  return value.toLowerCase();
}

function sha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalidRequest();
  return value.toLowerCase();
}

function byteSize(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidRequest();
  return value;
}

function exportDate(value) {
  if (value === null) return null;
  if (!isIsoDate(value)) throw invalidRequest();
  return value;
}

const REQUEST_KEYS = new Set(['agentVersion']);

/** { agentVersion } and nothing else. */
export function parseExportRequestBody(value) {
  const body = plainObject(value, REQUEST_KEYS);
  if (typeof body.agentVersion !== 'string') throw invalidRequest();
  try {
    return { agentVersion: normalizeCollectorVersion(body.agentVersion) };
  } catch {
    throw invalidRequest();
  }
}

const UPLOAD_KEYS = new Set(['requestId', 'sha256', 'byteSize', 'contentType']);

/**
 * The four keys, every one required. A byteSize that is a whole number but
 * outside 1 to 25 MiB is a 413 export_too_large, decided before anything is
 * written; anything that is not a whole number is a 400.
 */
export function parseUploadUrlBody(value) {
  const body = plainObject(value, UPLOAD_KEYS);
  const parsed = {
    requestId: requestId(body.requestId),
    sha256: sha256(body.sha256),
    byteSize: byteSize(body.byteSize),
  };
  if (body.contentType !== UPLOAD_CONTENT_TYPE) throw invalidRequest();
  if (parsed.byteSize < 1 || parsed.byteSize > TRADING_EXPORT_MAX_BYTES) throw new ApiError(413, 'export_too_large');
  return parsed;
}

const COMPLETE_KEYS = new Set(['requestId', 'status', 'sha256', 'byteSize', 'rowCounts', 'from', 'to', 'errorCode']);
const ROW_COUNT_KEYS = new Set(TRADING_EXPORT_DATASETS);

function rowCounts(value) {
  if (value === null) return null;
  const counts = plainObject(value, ROW_COUNT_KEYS);
  const result = {};
  for (const name of TRADING_EXPORT_DATASETS) {
    const count = counts[name];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalidRequest();
    result[name] = count;
  }
  return result;
}

/**
 * requestId and status are required; the rest read as null when absent.
 * ready carries the digest, the size and the four counts, and no error code;
 * failed carries its error code.
 */
export function parseCompleteBody(value) {
  const body = plainObject(value, COMPLETE_KEYS);
  const status = body.status;
  if (status !== 'ready' && status !== 'failed') throw invalidRequest();
  const digest = nullable(body.sha256);
  const size = nullable(body.byteSize);
  const errorCode = nullable(body.errorCode);
  const parsed = {
    requestId: requestId(body.requestId),
    status,
    sha256: digest === null ? null : sha256(digest),
    byteSize: size === null ? null : byteSize(size),
    rowCounts: rowCounts(nullable(body.rowCounts)),
    from: exportDate(nullable(body.from)),
    to: exportDate(nullable(body.to)),
    errorCode,
  };
  if (errorCode !== null && (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode))) throw invalidRequest();
  if ((status === 'failed') !== (errorCode !== null)) throw invalidRequest();
  if (parsed.from && parsed.to && parsed.from > parsed.to) throw invalidRequest();
  if (status === 'ready') {
    if (parsed.sha256 === null || parsed.byteSize === null || parsed.rowCounts === null) throw invalidRequest();
    if (parsed.byteSize < 1 || parsed.byteSize > TRADING_EXPORT_MAX_BYTES) throw new ApiError(413, 'export_too_large');
    return parsed;
  }
  // A failure records its code and nothing else, so whatever else the agent
  // knew about a file that will never be downloaded is not passed on.
  return { ...parsed, sha256: null, byteSize: null, rowCounts: null };
}

async function removeQuietly(store, path) {
  if (!path) return;
  try {
    await store.removeObjects([path]);
  } catch {
    // An object nobody points at is left in a private bucket; the request
    // itself is already settled, and that is what the agent is told about.
  }
}

function unavailable(underlying) {
  return Object.assign(new ApiError(503, 'trading_export_unavailable'), { underlying });
}

/* ── The three answers ────────────────────────────────────────────────────── */

async function answerExportRequest({ body, device, store }) {
  const { agentVersion } = parseExportRequestBody(body);
  const claimed = await store.claim({ deviceId: device.id, agentVersion });
  return {
    ok: true,
    request: claimed
      ? { id: claimed.id, from: claimed.from, to: claimed.to, datasets: claimed.datasets, maxBytes: TRADING_EXPORT_MAX_BYTES }
      : null,
  };
}

async function answerUploadUrl({ body, device, store, now }) {
  const input = parseUploadUrlBody(body);
  const path = await store.beginUpload({ deviceId: device.id, ...input });
  const issuedAt = now();
  let uploadUrl;
  try {
    uploadUrl = await store.signUpload(path);
  } catch (error) {
    // The request stays uploading, which accepts another ask for a URL.
    throw unavailable(error);
  }
  return {
    ok: true,
    uploadUrl,
    path,
    expiresAt: new Date(issuedAt.getTime() + SIGNED_UPLOAD_SECONDS * 1000).toISOString(),
  };
}

async function verifyUploadedObject(store, row, input) {
  if (row.sha256 !== input.sha256 || byteSizeOf(row.byte_size) !== input.byteSize) {
    throw new ApiError(409, 'export_mismatch');
  }
  let info;
  try {
    info = await store.objectInfo(row.storage_path);
  } catch (error) {
    throw unavailable(error);
  }
  if (!info) throw new ApiError(409, 'export_object_missing');
  if (info.size !== input.byteSize) throw new ApiError(409, 'export_object_mismatch');
  if (info.sha256 && info.sha256 !== input.sha256) throw new ApiError(409, 'export_object_mismatch');
}

async function answerComplete({ body, device, store }) {
  const input = parseCompleteBody(body);
  const row = await store.loadForDevice(device.id, input.requestId);
  if (!row) throw new ApiError(404, 'export_request_not_found');

  const alreadyReady = input.status === 'ready'
    && row.status === 'ready'
    && row.sha256 === input.sha256
    && byteSizeOf(row.byte_size) === input.byteSize;
  if (input.status === 'ready' && !alreadyReady) {
    if (row.status !== 'uploading') {
      // A request cancelled while the agent was uploading: what landed is
      // nobody's any more.
      if (row.status === 'cancelled') await removeQuietly(store, row.storage_path);
      throw new ApiError(409, 'export_request_closed');
    }
    await verifyUploadedObject(store, row, input);
  }

  let status;
  try {
    status = await store.complete({ deviceId: device.id, ...input });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && row.status === 'cancelled') {
      await removeQuietly(store, row.storage_path);
    }
    throw error;
  }
  // A failed export is never downloaded, so a file that reached storage first is removed.
  if (status === 'failed' && row.status !== 'failed') await removeQuietly(store, row.storage_path);
  return { ok: true, status };
}

function createDeviceExportHandler(answer) {
  return function createHandler({
    createClient = createServiceClient,
    createAuthStore = createDeviceAuthStore,
    createStore = createTradingExportDeviceStore,
    authenticate = requireIngestDevice,
    pepper = resolveIngestPepper(),
    now = () => new Date(),
  } = {}) {
    return async function handler(req, res) {
      try {
        requireMethod(req, 'POST');
        const admin = createClient();
        const device = await authenticate(req, {
          store: createAuthStore(admin),
          pepper,
        });

        let body;
        try {
          // A handful of short fields; the agent update poll's defensive read.
          body = await readJsonBody(req, { maxBytes: 4 * 1024 });
        } catch (error) {
          if (error instanceof ApiError && [400, 413].includes(error.status)) throw invalidRequest(error.status);
          throw error;
        }
        const result = await answer({ body, device, store: createStore(admin), now });
        return sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof ApiError) {
          return handleApiError(res, error, {
            fallbackMessage: 'trading_export_unavailable',
            underlying: error.underlying || null,
          });
        }
        // A 503, like the agent update poll: the agent asks again and nothing
        // depends on this one landing. The cause reaches the log.
        return handleApiError(res, new ApiError(503, 'trading_export_unavailable'), {
          fallbackMessage: 'trading_export_unavailable',
          underlying: error,
        });
      }
    };
  };
}

export const createExportRequestHandler = createDeviceExportHandler(answerExportRequest);
export const createExportUploadUrlHandler = createDeviceExportHandler(answerUploadUrl);
export const createExportCompleteHandler = createDeviceExportHandler(answerComplete);

export const exportRequest = createExportRequestHandler();
export const exportUploadUrl = createExportUploadUrlHandler();
export const exportComplete = createExportCompleteHandler();
