import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { createDeviceAuthStore, requireIngestDevice } from '../../apiLib/deviceAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';

/* ITS OWN ENDPOINT, AND NOT A FIELD ON THE HEARTBEAT.
 *
 * The heartbeat refuses any key it does not know with a 400 and its record
 * function refuses any error code outside its list, and every deployed agent
 * depends on that staying true. An agent that put accounts on the heartbeat
 * would silence every heartbeat on the fleet until the CRM caught up - and the
 * heartbeat is the only thing that says a machine is alive, which is the very
 * traffic light this exists to build. Step 46 wrote that lesson down for the
 * quarantine; this is the same answer for the same reason.
 *
 * WHAT A SAMPLE IS. The least data that answers three questions a CAM asks all
 * morning: which accounts are alive, which are running, and roughly how the day
 * is going. Not a close. Everything the close already stores - net liquidation,
 * the margin fields, cash value, the weekly figure, the drawdown, the account
 * value dictionary - is deliberately absent, and the route REFUSES a body
 * carrying any of it rather than ignoring it, so an agent that starts sending
 * the whole snapshot here learns immediately instead of quietly doubling the
 * write.
 *
 * NOT DEPLOYED YET IS AN ANSWER, NOT A FAULT. The table and the function arrive
 * with migration step 55, and this handler may be live before it has run.
 * PostgREST names a function it cannot find PGRST202 and Postgres names a
 * missing relation 42P01; both mean the same thing the agent already expects
 * from a CRM without this handler at all, so the answer is the same 404. That
 * is what makes the deploy and the migration orderable either way with no error
 * line on a VPS, and it is the whole of "harmless on its own".
 *
 * THE REPLY CARRIES THE TUNING. `sampleIntervalSeconds` comes from
 * account_tracker_settings, so Pedro retunes the whole fleet's cadence from the
 * SQL editor rather than from an environment variable he cannot set. An old
 * agent that does not read the field is unaffected; a new one honours it. */
const SAMPLE_KEYS = new Set(['schemaVersion', 'sampledAt', 'accounts']);
const ACCOUNT_KEYS = new Set([
  'accountName',
  'connectionName',
  'connected',
  'status',
  'realizedPnl',
  'unrealizedPnl',
  'totalPnl',
  'strategyCount',
  'enabledStrategyCount',
]);

/* A STRUCTURAL CEILING BESIDE THE SETTINGS COLUMN, not instead of it. The
 * function enforces max_accounts_per_report, which is the tunable; this is the
 * bound that holds whatever that column is edited to, in the same spirit as
 * step 46 validating in both the route and the SQL. The largest client on this
 * book runs in the eighteen-account range. */
export const MAX_ACCOUNTS = 500;
/* ~160 bytes a row at 500 rows is 80 KiB. The cap that actually bites is
 * MAX_ACCOUNTS; this is the defensive read, the same one the heartbeat and the
 * quarantine report do. */
const MAX_BODY_BYTES = 128 * 1024;
/* NinjaTrader's own ConnectionStatus word, shape-checked rather than enumerated.
 * An unknown word is a newer platform and the desk still needs every other
 * account in the sample, so refusing the whole report for one word would be the
 * heartbeat's trap repeated. Shape-checked and never free text, because it
 * reaches a screen from a machine the CRM does not control. */
const STATUS_SHAPE = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;
const NAME_SHAPE = /^\S(?:.*\S)?$/;
const MAX_NAME_LENGTH = 64;
/* Four orders of magnitude past anything this desk trades, and the bound the
 * table repeats. A sample is money on a screen; an unbounded number or a NaN
 * would turn a client's whole live total into nonsense. */
const MONEY_LIMIT = 1e12;
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

export const config = { api: { bodyParser: false } };

function invalidSample(status = 400) {
  return new ApiError(status, 'invalid_account_sample');
}

function plainObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && !Object.keys(value).some((key) => !keys.has(key));
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function timestamp(value, latestAllowedMs) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP_WITH_OFFSET.exec(value) : null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    (match?.slice(1) || []).map((part) => (part === undefined ? undefined : Number(part)));
  const validOffset = offsetHour === undefined
    || (offsetHour < 14 && offsetMinute <= 59)
    || (offsetHour === 14 && offsetMinute === 0);
  if (!match
    || !validCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || !validOffset
    || Number.isNaN(Date.parse(value))
    || Date.parse(value) > latestAllowedMs) {
    throw invalidSample();
  }
  return value;
}

function accountName(value) {
  if (typeof value !== 'string'
    || value.length > MAX_NAME_LENGTH
    || !NAME_SHAPE.test(value)) {
    throw invalidSample();
  }
  return value;
}

function nullableName(value) {
  if (value === null || value === undefined) return null;
  return accountName(value);
}

function connectionStatus(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !STATUS_SHAPE.test(value)) throw invalidSample();
  return value;
}

/* NULL IS NOT ZERO, in either direction. A missing P&L means the account did not
 * report one, and coercing it to 0 would put a confident "$0 today" on a screen
 * about a number nobody measured - which is the exact failure
 * src/domain/liveAccounts.js was written to stop. */
function money(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MONEY_LIMIT) {
    throw invalidSample();
  }
  return value;
}

function count(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw invalidSample();
  return value;
}

function connected(value) {
  if (typeof value !== 'boolean') throw invalidSample();
  return value;
}

/* THE TWO COUNTS TRAVEL TOGETHER OR NOT AT ALL, and the enabled one cannot
 * exceed the total. A strategy count with no enabled count derives `idle` -
 * "the desk switched everything off" - about an account nobody measured. Step 47
 * is why these two integers are here at all: across 84 closes, 45 of the 46
 * strategies that actually produced fills read `enabled = false`, because the
 * close is taken after the desk switches the algos off. A mid-day sample is the
 * only honest reading of `enabled` the desk can ever get. */
function strategyCounts(value) {
  const strategyCount = count(value.strategyCount);
  const enabledStrategyCount = count(value.enabledStrategyCount);
  if ((strategyCount === null) !== (enabledStrategyCount === null)) throw invalidSample();
  if (strategyCount !== null && enabledStrategyCount > strategyCount) throw invalidSample();
  return { strategyCount, enabledStrategyCount };
}

function accountRow(value) {
  if (!plainObject(value, ACCOUNT_KEYS)) throw invalidSample();
  return {
    accountName: accountName(value.accountName),
    connectionName: nullableName(value.connectionName),
    connected: connected(value.connected),
    status: connectionStatus(value.status),
    realizedPnl: money(value.realizedPnl),
    unrealizedPnl: money(value.unrealizedPnl),
    totalPnl: money(value.totalPnl),
    ...strategyCounts(value),
  };
}

export function normalizeAccountSampleBody(value, {
  now = new Date(),
  maxFutureSkewMs = 5 * 60 * 1000,
} = {}) {
  if (!plainObject(value, SAMPLE_KEYS)) throw invalidSample();
  try {
    const referenceNow = now instanceof Date ? now : new Date(now);
    const latestAllowedMs = referenceNow.getTime() + maxFutureSkewMs;
    if (Number.isNaN(latestAllowedMs)) throw invalidSample();
    if (value.schemaVersion !== 1) throw invalidSample();
    if (!Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) throw invalidSample();
    const accounts = value.accounts.map(accountRow);
    // The same account twice is not a sample of a terminal, where an account
    // has one name, and it would make the upsert's outcome depend on the order
    // of the array.
    if (new Set(accounts.map((account) => account.accountName)).size !== accounts.length) {
      throw invalidSample();
    }
    return {
      schemaVersion: 1,
      sampledAt: timestamp(value.sampledAt, latestAllowedMs),
      accounts,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidSample();
  }
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function errorText(error) {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
}

function isNotDeployedYet(error) {
  const code = String(error?.code || '');
  if (code === 'PGRST202' || code === '42883' || code === '42P01') return true;
  const text = errorText(error).toLowerCase();
  return /could not find the function|function .* does not exist|relation .* does not exist/.test(text);
}

function sampleValidationError(error) {
  const source = errorText(error).toUpperCase();
  if (source.includes('INVALID_ACCOUNT_SAMPLE')) return invalidSample();
  if (source.includes('INVALID_INGEST_DEVICE')) return new ApiError(401, 'invalid_device_credential');
  return null;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function createAccountSampleStore(admin) {
  return {
    async recordSample(payload) {
      const { data, error } = await admin.rpc('record_account_live_sample', {
        p_device_id: payload.deviceId,
        p_sampled_at: payload.sampledAt,
        p_accounts: payload.accounts,
      });
      if (error) {
        if (isNotDeployedYet(error)) throw new ApiError(404, 'not_found');
        throw sampleValidationError(error) || error;
      }
      const row = unwrapRpcRow(data);
      if (!row?.device_id || !Number.isInteger(row.recorded)) {
        throw new Error('Account sample RPC returned no device.');
      }
      return {
        deviceId: row.device_id,
        recorded: row.recorded,
        removed: Number.isInteger(row.removed) ? row.removed : 0,
        throttled: row.throttled === true,
        // Defaults mirror the column defaults in step 55, for the case where an
        // older function is deployed and does not return them. Never zero: an
        // interval of zero read as truth would be a machine sampling flat out.
        sampleIntervalSeconds: positiveInteger(row.sample_interval_seconds, 600),
      };
    },
  };
}

export function createHandler({
  createClient = createServiceClient,
  createAuthStore = createDeviceAuthStore,
  createStore = createAccountSampleStore,
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
        if (error instanceof ApiError && [400, 413].includes(error.status)) {
          throw invalidSample(error.status);
        }
        throw error;
      }
      const sample = normalizeAccountSampleBody(requestBody, { now: now() });
      const recorded = await createStore(admin).recordSample({
        deviceId: device.id,
        sampledAt: sample.sampledAt,
        accounts: sample.accounts,
      });

      return sendJson(res, 200, {
        ok: true,
        recorded: recorded.recorded,
        throttled: recorded.throttled,
        sampleIntervalSeconds: recorded.sampleIntervalSeconds,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return handleApiError(res, error, { fallbackMessage: 'account_sample_unavailable' });
      }
      /* A 503, not a 500. A sample is worthless five minutes later, so nothing
       * queues it and nothing retries it on this side: the next pass carries a
       * FRESH reading, which is the only kind worth having. The cause reaches
       * the function log the way the heartbeat's does, so the next failure here
       * gets to name itself. */
      return handleApiError(res, new ApiError(503, 'account_sample_unavailable'), {
        fallbackMessage: 'account_sample_unavailable',
        underlying: error,
      });
    }
  };
}

export default createHandler();
