/* ------------------------------------------------------------------------- *
 * The refusal happened somewhere the CAM cannot see.
 *
 * Pairing is entered on the VPS and refused on the VPS, so the sentence that
 * explains it is read by whoever is sitting at that machine, and the CRM showed
 * the client at "Not connected" with nothing else. The two are usually not the
 * same person, and the one holding the CRM is the only one who can act.
 *
 * `machine_conflict` is why this exists. It is the single refusal a new code
 * can never fix, it accounted for sixty-six of sixty-eight refusals on this
 * desk, and the device blocking the machine belongs to whichever client claimed
 * it first, which is very often a client outside this CAM's book. The fleet
 * view shows them nothing and the admin fleet endpoint answers 403, so the only
 * available move was to generate another code and watch it fail again.
 *
 * Every line names the next action, or says plainly that there is not one, so
 * nobody spends another afternoon on a code that was never going to be taken.
 * ------------------------------------------------------------------------- */

/** Whether this refusal is worth interrupting the CAM with. */
export function isActionableRefusal(attempt) {
  return Boolean(attempt?.reason) && attempt.reason !== 'rate_limited';
}

/**
 * One sentence about the last refused attempt.
 *
 * @param attempt the `lastPairAttempt` from /api/admin/ingest-status.
 * @returns {{ headline: string, detail: string, newCodeHelps: boolean }|null}
 */
export function describePairRefusal(attempt) {
  if (!isActionableRefusal(attempt)) return null;
  const holder = String(attempt.blockedBy?.clientName || '').trim();

  switch (attempt.reason) {
    case 'machine_conflict':
      return {
        headline: 'That VPS is already connected to another client.',
        // The name is the whole point. Without it the CAM knows only that
        // something is in the way, which is what they knew before.
        detail: holder
          ? `It is collecting for ${holder}. Automatic collection has to be revoked on ${holder} before this VPS will accept a code for anyone else. A new code will not help.`
          : 'Its collector has to be revoked on that client before this VPS will accept a code for anyone else. A new code will not help. Ask a Manager which client holds it.',
        newCodeHelps: false,
      };
    case 'device_revoked':
      return {
        headline: 'That VPS was revoked here.',
        detail: 'Rebind this client to it before connecting again. A new code on its own will not help.',
        newCodeHelps: false,
      };
    case 'client_ineligible':
      return {
        headline: 'This client is not eligible for automatic collection.',
        detail: 'Check its status and product key in the client profile, then generate a code.',
        newCodeHelps: false,
      };
    case 'code_expired':
      return {
        headline: 'The code was entered after it expired.',
        detail: 'Generate another one and have it entered within four hours.',
        newCodeHelps: true,
      };
    case 'code_consumed':
      return {
        headline: 'That code had already been used.',
        detail: 'Generate another one.',
        newCodeHelps: true,
      };
    case 'code_revoked':
      return {
        headline: 'That code was revoked here before it was entered.',
        // The trap: generating a replacement cancels the outstanding code
        // inside the same transaction, so a CAM who regenerates while the
        // client is typing produces exactly this.
        detail: 'Generating a code cancels any earlier one, so this happens when a replacement is made while the client is still entering the first. Generate one and leave it alone.',
        newCodeHelps: true,
      };
    case 'credential_conflict':
    case 'nonce_or_credential_conflict':
      return {
        headline: 'Two pairings ran against the same code at once.',
        detail: 'Generate another one and have it entered once, on one VPS.',
        newCodeHelps: true,
      };
    case 'invalid_request':
      return {
        headline: 'The VPS sent an incomplete pairing request.',
        detail: 'That machine is usually running an old agent. Re-run the install line from step 1 to update it.',
        newCodeHelps: false,
      };
    default:
      return {
        headline: 'The last code was refused on the VPS.',
        detail: 'The reason was not one this page recognises. Ask a Manager to read the pairing audit.',
        newCodeHelps: false,
      };
  }
}
