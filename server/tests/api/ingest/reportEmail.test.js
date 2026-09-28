import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createHandler, messageFor, subjectFor } from '../../../autoCollection/ingest/reportEmail.js';

const ENV = {
  AGENT_MAIL_SECRET: 'a-long-shared-secret',
  AGENT_MAIL_TO: 'pedro@vinceretrading.com',
  DAILY_EMAIL_FROM: 'reports@vinceretrading.com',
  BREVO_API_KEY: 'brevo-key',
};

const HTML = '<!doctype html><html><body><h1>Joel Onafowokan</h1></body></html>';

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

const goodBody = { clientName: 'Joel Onafowokan', date: '2026-09-28', html: HTML };

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
  it('accepts a report and hands it to the provider', async () => {
    const { res, send } = await run({ body: goodBody });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe('Daily report · Joel Onafowokan · 2026-09-28');
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

  it('refuses a body with no report in it', async () => {
    const { res } = await run({ body: { clientName: 'X', date: '2026-09-28' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'no_report' });
  });

  it('refuses a date that is not a trading date', async () => {
    const { res } = await run({ body: { ...goodBody, date: 'yesterday' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_date' });
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
    expect(code).not.toMatch(/\.from\(['"]/);
    expect(code).not.toMatch(/createClient|serviceRole|supabase/i);
    expect(code).not.toMatch(/requireIngestDevice|deviceAuth|ingest_devices/);
  });
});
