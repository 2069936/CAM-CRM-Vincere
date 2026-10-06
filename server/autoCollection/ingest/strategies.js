import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { familyFromStrategyName } from '../../../src/domain/strategyRan.js';
import { instrumentRoot } from '../../../src/domain/instrumentSpecs.js';

/* POST /api/ingest/strategies: the last reading of each live strategy instance.
 *
 * ITS OWN ROUTE, for the reason /accounts is its own route and twice over.
 * The heartbeat answers 400 to a key it does not know, so a new agent sending a
 * new heartbeat key would silence the fleet's heartbeats until the CRM caught up
 * (step 46). And /accounts answers 400 to a key it does not know too, so putting
 * strategies inside the account body would cost a new agent every account row
 * on a CRM that has not caught up. Here, a CRM without this route answers the
 * router's 404 `not_found`, which the agent reads as "try again in an hour", and
 * the account tracker never notices.
 *
 * UNKNOWN KEYS ARE IGNORED, which is the opposite of /accounts and on purpose.
 * A later agent may add an optional field, and refusing it would silence the
 * feature fleet wide until the CRM caught up: the heartbeat lesson again. They
 * are ignored, never forwarded: the RPC receives exactly ROW_KEYS below, built
 * here, so nothing the agent invents reaches SQL.
 *
 * THE FAMILY AND THE ROOT ARE COMPUTED HERE, in JavaScript, by the product's one
 * rule (familyFromStrategyName reproduces strategy_snapshots.strategy_family on
 * all 3,805 stored rows and keeps X_PF apart from X) and instrumentRoot. SQL
 * never holds a second copy of either. A row whose name yields no family is
 * skipped and counted, rather than refusing the whole reading.
 *
 * NOT DEPLOYED YET IS AN ANSWER. Until step 57 runs, the RPC is missing, and the
 * answer is 404 `strategy_sample_not_deployed`: the agent stops asking for an
 * hour and its account posts carry on every cycle. */

/* Wire bounds. The SQL enforces max_strategies_per_report (a settings column,
 * default 200) on top of this structural ceiling. */
export const MAX_STRATEGIES = 1000;
const MAX_BODY_BYTES = 128 * 1024;
const MONEY_LIMIT = 1e12;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** The exact keys of every item handed to record_algorithm_live_sample. */
export const ROW_KEYS = Object.freeze([
  'accountName',
  'strategyId',
  'strategyName',
  'algorithm',
  'instrument',
  'instrumentRoot',
  'realizedPnl',
  'unrealizedPnl',
  'restartedAt',
]);

const STRING_LIMITS = Object.freeze({
  accountName: 200,
  strategyId: 64,
  strategyName: 200,
  instrument: 64,
});
const MAX_ALGORITHM_LENGTH = 200;
const MAX_ROOT_LENGTH = 16;

export const config = { api: { bodyParser: false } };

function invalidSample(status = 400) {
  return new ApiError(status, 'invalid_strategy_sample');
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** An ISO timestamp WITH an offset, returned as milliseconds, or a refusal. */
function timestampMs(value) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP_WITH_OFFSET.exec(value) : null;
  if (!match) throw invalidSample();
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const validOffset = offsetHour === undefined
    || (offsetHour < 14 && offsetMinute <= 59)
    || (offsetHour === 14 && offsetMinute === 0);
  const parsed = Date.parse(value);
  if (!validCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || !validOffset
    || Number.isNaN(parsed)) {
    throw invalidSample();
  }
  return parsed;
}

function text(value, limit) {
  if (typeof value !== 'string') throw invalidSample();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw invalidSample();
  return trimmed;
}

/* NULL IS NOT MEASURED, never zero, and a missing key is null. An add-on that
 * could not read the Strategies tab sends the instance with both parts null,
 * and the screen says "not measured" about it rather than "$0". */
function money(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MONEY_LIMIT) {
    throw invalidSample();
  }
  return value;
}

function restartedAt(value, sampledMs) {
  if (value === null || value === undefined) return null;
  const ms = timestampMs(value);
  if (ms > sampledMs || ms < sampledMs - DAY_MS) throw invalidSample();
  return value;
}

/**
 * The body, validated and reduced to what the RPC takes.
 *
 * @returns {{ sampledAt: string, strategies: object[], skipped: number }}
 */
export function normalizeStrategySampleBody(value, {
  now = new Date(),
  maxFutureSkewMs = 5 * 60 * 1000,
} = {}) {
  if (!isPlainObject(value)) throw invalidSample();
  if (value.schemaVersion !== 1) throw new ApiError(400, 'unsupported_schema_version');
  const sampledMs = timestampMs(value.sampledAt);
  if (sampledMs > now.getTime() + maxFutureSkewMs) throw invalidSample();
  if (!Array.isArray(value.strategies) || value.strategies.length > MAX_STRATEGIES) {
    throw invalidSample();
  }

  const seen = new Set();
  const strategies = [];
  let skipped = 0;
  for (const raw of value.strategies) {
    if (!isPlainObject(raw)) throw invalidSample();
    const accountName = text(raw.accountName, STRING_LIMITS.accountName);
    const strategyId = text(raw.strategyId, STRING_LIMITS.strategyId);
    const strategyName = text(raw.strategyName, STRING_LIMITS.strategyName);
    const instrument = text(raw.instrument, STRING_LIMITS.instrument);
    const row = {
      accountName,
      strategyId,
      strategyName,
      algorithm: null,
      instrument,
      instrumentRoot: null,
      realizedPnl: money(raw.realizedPnl),
      unrealizedPnl: money(raw.unrealizedPnl),
      restartedAt: restartedAt(raw.restartedAt, sampledMs),
    };
    // One instance once. Two readings of the same instance would make the
    // upsert's outcome depend on the order of the array.
    const key = `${accountName}\u0000${strategyId}`;
    if (seen.has(key)) throw invalidSample();
    seen.add(key);

    const algorithm = familyFromStrategyName(strategyName);
    const root = instrumentRoot(instrument);
    if (!algorithm || algorithm.length > MAX_ALGORITHM_LENGTH || !root || root.length > MAX_ROOT_LENGTH) {
      skipped += 1;
      continue;
    }
    row.algorithm = algorithm;
    row.instrumentRoot = root;
    strategies.push(row);
  }

  return { sampledAt: value.sampledAt, strategies, skipped };
}

function errorText(error) {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
}

/** Migration 57 has not been applied: the function or the table is missing. */
export function isStrategySampleNotDeployed(error) {
  const code = String(error?.code || '');
  if (code === 'PGRST202' || code === '42883' || code === '42P01') return true;
  return /does not exist|could not find the function/i.test(errorText(error));
}

function rpcRefusal(error) {
  const source = errorText(error).toUpperCase();
  if (source.includes('INVALID_STRATEGY_SAMPLE')) return invalidSample();
  if (source.includes('INVALID_INGEST_DEVICE')) return new ApiError(401, 'invalid_device_credential');
  return null;
}

function cycleIso(value) {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function createStrategySampleStore(admin) {
  return {
    async recordSample({ deviceId, sampledAt, strategies }) {
      const { data, error } = await admin.rpc('record_algorithm_live_sample', {
        p_device_id: deviceId,
        p_sampled_at: sampledAt,
        p_strategies: strategies,
      });
      if (error) {
        if (isStrategySampleNotDeployed(error)) throw new ApiError(404, 'strategy_sample_not_deployed');
        throw rpcRefusal(error) || error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || !Number.isInteger(row.recorded)) {
        throw new Error('Strategy sample RPC returned no count.');
      }
      return {
        recorded: row.recorded,
        throttled: row.throttled === true,
        cycleStart: cycleIso(row.cycleStart),
      };
    },
  };
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createStrategySampleStore,
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

      let requestBody;
      try {
        requestBody = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
      } catch (error) {
        if (error instanceof ApiError && error.status === 413) {
          throw new ApiError(413, 'strategy_sample_too_large');
        }
        if (error instanceof ApiError && error.status === 400) throw invalidSample();
        throw error;
      }
      const sample = normalizeStrategySampleBody(requestBody, { now: now() });
      if (!sample.strategies.length) {
        return sendJson(res, 200, {
          ok: true, recorded: 0, throttled: false, cycleStart: null, skipped: sample.skipped,
        });
      }
      const recorded = await createStore(admin).recordSample({
        deviceId: device.id,
        sampledAt: sample.sampledAt,
        strategies: sample.strategies,
      });
      return sendJson(res, 200, {
        ok: true,
        recorded: recorded.recorded,
        throttled: recorded.throttled,
        cycleStart: recorded.cycleStart,
        skipped: sample.skipped,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'strategy_sample_unavailable' });
      }
      /* A 503, as /accounts answers. A reading is worthless ten minutes later, so
       * nothing queues it: the next cycle carries a fresh one. The cause reaches
       * the function log. */
      return handleApiError(res, new ApiError(503, 'strategy_sample_unavailable'), {
        fallbackMessage: 'strategy_sample_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
