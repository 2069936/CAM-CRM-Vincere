/* ---------------------------------------------------------------------------
 * Handing one built email to whoever sends mail today.
 *
 * ONE FUNCTION WIDE ON PURPOSE. The provider is not a decision this desk has
 * made once and for good: it was chosen for being free at this volume and for
 * verifying a sender with a code to that sender's own mailbox, because nobody
 * here has the DNS access a domain-authenticated setup needs. If that changes,
 * or the free tier does, the thing that has to be rewritten is one request
 * body. Everything above this file is already tested without a network.
 *
 * NO KEY IN THIS REPOSITORY, EVER. The key is read where the function runs and
 * passed in. It is never a default, never a fallback, and never logged: the
 * failure path below prints the provider's status and message and nothing of
 * the request. Same rule the desk set for INGEST_TOKEN_PEPPER.
 * ------------------------------------------------------------------------- */

/** Brevo's own ceiling for one message. Ours measured 0.4 MB; this catches a book that grew. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class EmailDeliveryError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmailDeliveryError';
    this.status = status;
  }
}

/* Base64 without Node's Buffer and without a dependency, because this runs in
 * a Deno edge runtime as often as it runs under vitest. */
export function toBase64(bytes) {
  if (typeof bytes === 'string') return toBase64(new TextEncoder().encode(bytes));
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  // btoa exists in browsers, in Deno and in Node 16+.
  return btoa(binary);
}

export function brevoPayload({ from, to, subject, text, attachments = [] }) {
  if (!from?.email) throw new EmailDeliveryError('A verified sender address is required.');
  const recipients = (Array.isArray(to) ? to : [to]).filter((entry) => entry?.email);
  if (!recipients.length) throw new EmailDeliveryError('No recipient has an email address.');

  const total = attachments.reduce((sum, item) => sum + (item.bytes?.length || 0), 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new EmailDeliveryError(
      `The attachments are ${(total / 1024 / 1024).toFixed(1)} MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB a message may carry.`,
    );
  }

  const payload = {
    sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
    to: recipients.map((entry) => ({ email: entry.email, ...(entry.name ? { name: entry.name } : {}) })),
    subject,
    textContent: text,
  };
  if (attachments.length) {
    payload.attachment = attachments.map((item) => ({
      name: item.name,
      content: toBase64(item.bytes),
    }));
  }
  return payload;
}

/**
 * Send one message. Resolves with the provider's message id, throws otherwise.
 *
 * @param fetchImpl injected so the tests assert the request that would go out
 *                  without one going out.
 */
export async function sendViaBrevo(
  { apiKey, from, to, subject, text, attachments = [] },
  fetchImpl = globalThis.fetch,
) {
  if (!apiKey) throw new EmailDeliveryError('No email provider key is configured, so nothing was sent.');
  const payload = brevoPayload({ from, to, subject, text, attachments });

  let response;
  try {
    response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new EmailDeliveryError('The email provider could not be reached.', { cause: error });
  }

  if (!response.ok) {
    /* The provider's own words, because they are the actionable part: an
     * unverified sender and an exhausted daily quota are different problems
     * with the same status, and a CAM reading a log needs to know which. The
     * request is not echoed, so the key cannot reach a log through here. */
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message || body?.code || '';
    } catch { /* a provider that answers with no JSON says nothing useful */ }
    throw new EmailDeliveryError(
      `The email was refused (${response.status})${detail ? `: ${detail}` : ''}.`,
      { status: response.status },
    );
  }

  try {
    const body = await response.json();
    return { messageId: body?.messageId || null };
  } catch {
    return { messageId: null };
  }
}
