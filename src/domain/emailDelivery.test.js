import { describe, expect, it, vi } from 'vitest';
import {
  brevoPayload,
  EmailDeliveryError,
  MAX_ATTACHMENT_BYTES,
  sendViaBrevo,
  toBase64,
} from './emailDelivery';

const ok = (body = { messageId: '<abc@brevo>' }) => ({
  ok: true,
  status: 201,
  json: async () => body,
});

const refused = (status, body) => ({
  ok: false,
  status,
  json: async () => body,
});

const ARGS = {
  apiKey: 'test-key',
  from: { email: 'pedro@vinceretrading.com', name: 'Vincere CRM' },
  to: [{ email: 'camila@vinceretrading.com', name: 'Camila' }],
  subject: 'Daily reports · 2026-09-28 · 11 clients',
  text: 'the numbers',
};

describe('the request that goes out', () => {
  it('sends the body, the subject and the attachments to the provider', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await sendViaBrevo({ ...ARGS, attachments: [{ name: 'raw.json', bytes: new TextEncoder().encode('{}') }] }, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.sender.email).toBe('pedro@vinceretrading.com');
    expect(body.to).toEqual([{ email: 'camila@vinceretrading.com', name: 'Camila' }]);
    expect(body.subject).toContain('Daily reports');
    expect(body.textContent).toBe('the numbers');
    expect(body.attachment).toEqual([{ name: 'raw.json', content: toBase64(new TextEncoder().encode('{}')) }]);
  });

  it('carries the key in the header and nowhere else', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await sendViaBrevo(ARGS, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['api-key']).toBe('test-key');
    expect(init.body).not.toContain('test-key');
  });

  it('omits the attachment field entirely when there is nothing to attach', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await sendViaBrevo(ARGS, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('attachment');
  });
});

describe('what it refuses to attempt', () => {
  it('will not send without a key, rather than sending unauthenticated', async () => {
    const fetchImpl = vi.fn();
    await expect(sendViaBrevo({ ...ARGS, apiKey: '' }, fetchImpl)).rejects.toThrow(/no email provider key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('will not send to nobody', () => {
    expect(() => brevoPayload({ ...ARGS, to: [] })).toThrow(/no recipient/i);
    expect(() => brevoPayload({ ...ARGS, to: [{ name: 'No address' }] })).toThrow(/no recipient/i);
  });

  it('will not send without a verified sender', () => {
    expect(() => brevoPayload({ ...ARGS, from: {} })).toThrow(/sender address/i);
  });

  /* The measured package is 0.4 MB. This is not about today's book, it is
   * about the day somebody adds a client and nobody re-measures: a refusal
   * naming the size is a fixable problem, a provider truncating an attachment
   * is a report that silently went missing. */
  it('refuses a package over the size one message may carry, and says the size', () => {
    const tooBig = { name: 'reports.zip', bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) };
    expect(() => brevoPayload({ ...ARGS, attachments: [tooBig] })).toThrow(/over the 10 MB/);
  });
});

describe('when the provider says no', () => {
  it('repeats the provider\'s own reason, because it is the actionable part', async () => {
    const fetchImpl = vi.fn(async () => refused(400, { message: 'Sender not valid' }));
    await expect(sendViaBrevo(ARGS, fetchImpl)).rejects.toThrow(/refused \(400\): Sender not valid/);
  });

  it('still fails clearly when the provider answers with no json', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
    await expect(sendViaBrevo(ARGS, fetchImpl)).rejects.toThrow(/refused \(502\)/);
  });

  it('does not put the request in the error, so the key cannot reach a log', async () => {
    const fetchImpl = vi.fn(async () => refused(401, { message: 'Key not found' }));
    const error = await sendViaBrevo(ARGS, fetchImpl).catch((failure) => failure);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.status).toBe(401);
    expect(JSON.stringify(error.message)).not.toContain('test-key');
  });

  it('names the network as the cause when there is no answer at all', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(sendViaBrevo(ARGS, fetchImpl)).rejects.toThrow(/could not be reached/i);
  });
});

describe('base64', () => {
  it('round-trips bytes the provider will decode', () => {
    const bytes = new TextEncoder().encode('Daily reports · 2026-09-28');
    expect(new TextDecoder().decode(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))))
      .toBe('Daily reports · 2026-09-28');
  });

  /* A zip is binary with every byte value in it, and the chunked loop above
   * exists because spreading a 400 KB array into String.fromCharCode at once
   * overflows the call stack. */
  it('encodes binary of every byte value, in one piece', () => {
    const bytes = new Uint8Array(300 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(0);
    expect(decoded[255]).toBe(255);
    expect(decoded[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });
});
