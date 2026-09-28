import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createHandler, messageFor, resolveAgentMailSecret, subjectFor } from '../../../autoCollection/ingest/reportEmail.js';

const ENV = {
  AGENT_MAIL_SECRET: 'a-long-shared-secret',
  AGENT_MAIL_TO: 'pedro@vinceretrading.com',
  DAILY_EMAIL_FROM: 'reports@vinceretrading.com',
  BREVO_API_KEY: 'brevo-key',
};

const HTML = '<!doctype html><html><body><h1>Joel Onafowokan</h1></body></html>';

/* What the agent posts: the capture it has just written, unredacted. The
 * licence value here is the shape a real machine's queue carried. */
const CAPTURE = {
  schemaVersion: 1,
  captureId: 'c-1',
  capturedAt: '2026-09-28T20:30:00Z',
  tradingDate: '2026-09-28',
  timeZone: 'America/New_York',
  source: { machineId: 'm', agentVersion: '1.1.3', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.6.0' },
  accounts: [{
    accountName: 'FUNDED1', connectionName: 'LegendsT', displayName: 'FUNDED1',
    netLiquidation: 50000, cashValue: 50000, realizedPnl: 120, grossRealizedPnl: 120,
    unrealizedPnl: 0, totalPnl: 120, weeklyPnl: 300, trailingMaxDrawdown: 1000,
    buyingPower: 100000, excessIntradayMargin: 0, initialMargin: 0, maintenanceMargin: 0,
    currency: 'USD', status: 'Active',
    accountValues: { NetLiquidation: 50000 },
  }],
  strategies: [{
    strategyId: '1', strategyName: '0 - URGO-4.5', strategyDisplayName: 'URGO-4.5',
    accountName: 'FUNDED1', instrument: 'MNQ DEC26', state: 'Realtime', quantity: 0,
    position: 'Flat', averagePrice: 0, realizedPnl: null, unrealizedPnl: null,
    enabled: true, sync: null, dataSeries: '1 Minute', connectionName: 'LegendsT',
    startedAt: null, parameterCaptureStatus: 'partial',
    parameters: { URGO1: 33 },
    extraValues: { LicenseKey: 'V-9E2B00-2613327C-F8C645W', StopLossTicks: 300 },
  }],
  orders: [],
  executions: [],
};

function request({ method = 'POST', secret = ENV.AGENT_MAIL_SECRET, body = {} } = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from([payload]);
  stream.method = method;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...(secret === null ? {} : { 'x-agent-mail-secret': secret }),
  };
  return stream;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const goodBody = {
  clientName: 'Joel Onafowokan',
  capture: CAPTURE,
  roster: { FUNDED1: { accountType: 'Funded', status: 'Active' } },
  rosterFetchedAt: '2026-09-28T00:00:00Z',
};

async function run({ send = vi.fn(async () => ({ messageId: '<id>' })), env = ENV, ...options } = {}) {
  const res = response();
  await createHandler({ send, env })(request(options), res);
  return { res, send };
}

describe('the message it builds', () => {
  it('names the client and the day in the subject, so a mailbox sorts by client', () => {
    expect(subjectFor('Joel Onafowokan', '2026-09-28'))
      .toBe('Daily report · Joel Onafowokan · 2026-09-28');
  });

  it('zips the report, because Workspace blocks .html attachments by extension', () => {
    const message = messageFor({
      clientName: 'Joel Onafowokan', date: '2026-09-28', html: HTML,
      from: 'a@b.com', to: [{ email: 'c@d.com' }],
    });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].name).toBe('Joel Onafowokan - 2026-09-28 daily report.zip');
    const files = unzipSync(message.attachments[0].bytes);
    expect(Object.keys(files)).toEqual(['Joel Onafowokan - 2026-09-28 daily report.html']);
    expect(strFromU8(files['Joel Onafowokan - 2026-09-28 daily report.html'])).toBe(HTML);
  });

  it('says in the body that the numbers did not come from the CRM', () => {
    // It is the one thing a reader cannot tell from the attachment alone.
    const message = messageFor({
      clientName: 'X', date: '2026-09-28', html: HTML, from: 'a@b.com', to: [{ email: 'c@d.com' }],
    });
    expect(message.text).toContain('without the CRM');
    expect(message.text).toContain('last roster');
  });
});

describe('what it sends', () => {
  it('builds the report from the capture and hands it to the provider', async () => {
    const { res, send } = await run({ body: goodBody });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true, date: '2026-09-28' });
    expect(send).toHaveBeenCalledTimes(1);
    // The date is the capture's own, not one the caller asserted.
    expect(send.mock.calls[0][0].subject).toBe('Daily report · Joel Onafowokan · 2026-09-28');
  });

  /* The redaction happens here, on the desk's own server, rather than on
   * thirty client machines each being trusted to have done it. */
  it('strips the licence key and the tuning before the report is built', async () => {
    const { send } = await run({ body: goodBody });
    const zip = unzipSync(send.mock.calls[0][0].attachments[0].bytes);
    const html = strFromU8(Object.values(zip)[0]);
    expect(html).not.toContain('V-9E2B00-2613327C-F8C645W');
    expect(html).not.toMatch(/LicenseKey|StopLossTicks|URGO1/);
    // And it still says what ran, which is what the report is for.
    expect(html).toMatch(/URGO/);
    expect(html).toContain('MNQ DEC26');
  });

  it('carries the warnings into the body, not only onto the page', async () => {
    // A machine with no roster cannot total the day, and a reader skimming a
    // notification must not have to open the attachment to find that out.
    const { send } = await run({ body: { ...goodBody, roster: {}, rosterFetchedAt: null } });
    expect(send.mock.calls[0][0].text).toContain('Read before sending:');
  });

  /* THE DESTINATION IS NOT IN THE REQUEST, and that is the security of the
   * whole arrangement. The agent holds a secret whose only power is asking for
   * a report to be sent to an address this route already knows, so a leak
   * sends the desk its own reports rather than turning this into a mailer. */
  it('ignores a destination the caller tries to supply', async () => {
    const { send } = await run({
      body: { ...goodBody, to: 'attacker@example.com', from: 'attacker@example.com' },
    });
    expect(send.mock.calls[0][0].to).toEqual([{ email: 'pedro@vinceretrading.com' }]);
    expect(send.mock.calls[0][0].from).toBe('reports@vinceretrading.com');
  });
});

describe('what it refuses', () => {
  it('refuses a request with the wrong secret', async () => {
    const { res, send } = await run({ secret: 'wrong', body: goodBody });
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a request with no secret at all', async () => {
    const { res, send } = await run({ secret: null, body: goodBody });
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses everything when the deployment has no mail configured', async () => {
    // A relay that sends for whoever asks is a relay that sends for whoever
    // finds it, so an unconfigured deployment refuses rather than opening up.
    for (const missing of ['AGENT_MAIL_SECRET', 'BREVO_API_KEY', 'AGENT_MAIL_TO', 'DAILY_EMAIL_FROM']) {
      const env = { ...ENV, [missing]: '' };
      const { res, send } = await run({ env, body: goodBody });
      expect(res.statusCode, missing).toBe(503);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('refuses a GET', async () => {
    const { res } = await run({ method: 'GET', body: goodBody });
    expect(res.statusCode).toBe(405);
  });

  it('refuses a body with no capture in it', async () => {
    const { res } = await run({ body: { clientName: 'X' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'no_capture' });
  });

  it('says what is wrong with a capture it cannot read, rather than answering 500', async () => {
    const { res } = await run({ body: { ...goodBody, capture: { schemaVersion: 1 } } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_capture' });
  });
});

describe('the secret nobody had to set', () => {
  /* This desk cannot add an environment variable to its own deployment.
   * ingestPepper.js exists for exactly that reason - INGEST_TOKEN_PEPPER was
   * never set, so pairing never worked at all - and this follows it. */
  it('derives a secret from the key the deployment is guaranteed to have', () => {
    const derived = resolveAgentMailSecret({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same answer on every instance and every deploy', () => {
    // A value generated at startup is the obvious idea and the wrong one: the
    // agent caches what it was handed, and a secret that changes per instance
    // authenticates nothing.
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };
    expect(resolveAgentMailSecret(env)).toBe(resolveAgentMailSecret(env));
  });

  it('is not the service role key, and does not contain it', () => {
    const derived = resolveAgentMailSecret({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' });
    expect(derived).not.toContain('service-role-key');
  });

  it('lets an explicit value win, so this can be done properly later', () => {
    expect(resolveAgentMailSecret({
      AGENT_MAIL_SECRET: 'chosen',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    })).toBe('chosen');
  });

  it('answers empty rather than a constant when there is nothing to derive from', () => {
    // The route refuses on an empty secret. A fixed fallback would be a
    // published password.
    expect(resolveAgentMailSecret({})).toBe('');
  });

  it('accepts a request signed with the derived value', async () => {
    const env = { ...ENV, AGENT_MAIL_SECRET: '' , SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };
    const { res } = await run({ env, secret: resolveAgentMailSecret(env), body: goodBody });
    expect(res.statusCode).toBe(202);
  });
});

describe('what it must never do', () => {
  /* Every other ingest route authenticates against `ingest_devices`, which is
   * exactly what is unavailable on the day this route matters: on 2026-09-26
   * Vercel was up and Postgres was not. A query added here is a feature that
   * works on every day except the one it was written for. */
  it('reads no table, so it answers when the database does not', async () => {
    const source = await import('node:fs').then(
      (fs) => fs.readFileSync('server/autoCollection/ingest/reportEmail.js', 'utf8'),
    );
    /* The CODE, not the prose. The file's comments name deviceAuth.js and
     * ingest_devices precisely to say it does not use them, and a check that
     * cannot tell a comment from a call fails on its own explanation. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    /* A TABLE, not the word "supabase". The route derives its shared secret
     * by HMAC from SUPABASE_SERVICE_ROLE_KEY, the way ingestPepper.js does,
     * because nobody on this desk can add an environment variable to the
     * deployment. Reading an env var is not reading a row, and a check that
     * cannot tell them apart forbids the very thing that makes this route
     * work without Vercel access. */
    expect(code).not.toMatch(/\.from\(['"]/);
    expect(code).not.toMatch(/createClient|createServiceClient/);
    expect(code).not.toMatch(/requireIngestDevice|deviceAuth|ingest_devices/);
    expect(code).not.toMatch(/\bselect\(|\bupsert\(|\brpc\(/);
  });
});
