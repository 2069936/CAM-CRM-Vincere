import { isEnrollmentUsable, remainingEnrollmentSeconds } from './autoCollectionViewModel';

// Which of the four enrollment steps the card is allowed to call finished, and
// on what evidence. This lives outside AutoCollectionCard so the one rule that
// matters here is testable on its own: a step is `done` only when a field that
// came back from the server proves it, and `confirmedBy` names that field.
//
// The defect this exists for: step 1 was `activeDevice || installerStarted`,
// and `installerStarted` was a browser-local boolean set by exactly one
// onClick — the "or download the package manually" link. A click in the CRM
// says nothing about the client's VPS. install-agent.ps1 throws at its
// elevation preflight (line 68) if PowerShell is not elevated, throws again at
// line 159 when Documents\NinjaTrader 8\bin\Custom does not exist, and can sit
// for up to 30 s in WaitForStatus('Running') at line 195. Every one of those
// ends with no agent installed — and the card still drew a green check.
// Claiming a step is complete on a guess is the same class of defect as
// rendering a value nobody measured as 0.
//
// The card also cannot tell the difference by polling: it only refetches on
// mount and on the Check connection button. Local optimism is all it has, so
// local optimism is rendered as `active`, never as `done`.

// The step keys, in render order. `script` is the phase the old copy called
// "Approve the Windows prompt"; no prompt is involved, see AutoCollectionCard.
export const ENROLLMENT_STEP_KEYS = Object.freeze(['install', 'script', 'code', 'verify']);

// What a one-time code is doing right now, from the fields ingest-status
// actually returns. Note `code` is NOT one of them after a reload:
// publicEnrollment (server/autoCollection/admin/ingest-status.js:85) returns
// id/expiresAt/consumedAt/revokedAt and deliberately never the plaintext code,
// which is why 'outstanding' has to be its own status instead of collapsing
// into 'none'. Rendering those two the same is what made the card offer
// "Generate one-time code" while the client was holding a valid one — and
// create_ingest_enrollment revokes every unused code for the client before it
// inserts the new one (step_28_auto_collection.sql:543), so the client's code
// died the moment the CAM clicked.
export function describeEnrollment(enrollment, nowMs = 0) {
  if (!enrollment) return { status: 'none', remainingSeconds: null };
  if (enrollment.consumedAt) return { status: 'consumed', remainingSeconds: null };
  if (enrollment.revokedAt) return { status: 'revoked', remainingSeconds: null };
  // An unparseable or absent expiry is not an expiry. remainingEnrollmentSeconds
  // returns 0 for both "expired" and "cannot tell", and those are different
  // claims: one tells the CAM to generate a new code, the other is a bug we
  // must not dress up as a countdown that reached zero.
  const expiry = Date.parse(enrollment.expiresAt || '');
  if (!Number.isFinite(expiry)) return { status: 'unknown', remainingSeconds: null };
  const remainingSeconds = remainingEnrollmentSeconds(enrollment.expiresAt, nowMs);
  if (remainingSeconds <= 0) return { status: 'expired', remainingSeconds: 0 };
  if (enrollment.code) return { status: 'live', remainingSeconds };
  return { status: 'outstanding', remainingSeconds };
}

function step(confirmedBy, active, unconfirmed = false) {
  return {
    state: confirmedBy ? 'done' : active ? 'active' : 'future',
    // null, not false: "no signal has confirmed this" is not "a signal said no".
    confirmedBy: confirmedBy || null,
    // True when the only thing that moved this step forward happened in this
    // browser tab. The card renders a note instead of a check.
    unconfirmed: Boolean(!confirmedBy && active && unconfirmed),
  };
}

export function buildEnrollmentStepStates(status, nowMs = 0, local = {}) {
  const device = status?.device || null;
  const activeDevice = device?.status === 'active' && !device?.revokedAt ? device : null;
  const enrollment = describeEnrollment(status?.enrollment, nowMs);
  const hasRelease = Boolean(status?.release);
  const online = Boolean(
    activeDevice
    && activeDevice.healthStatus === 'online'
    && Number.isFinite(Date.parse(activeDevice.lastSeenAt || ''))
    && nowMs - Date.parse(activeDevice.lastSeenAt) <= 5 * 60 * 1000,
  );
  // Any device row at all — including a revoked one — is proof the agent was
  // installed and that the service was running, because the only thing that
  // creates the row is pair_ingest_device_v2, called by the installed service
  // over its control pipe (Crm/CrmClient.cs:128). After a revoke the CAM needs
  // a new code, not a second install, so steps 1 and 2 stay green there.
  const installed = device ? 'device row exists' : null;

  return {
    enrollment,
    install: step(installed, hasRelease, Boolean(local.commandHandedOff)),
    script: step(installed, Boolean(local.commandHandedOff), true),
    // consumedAt is the direct proof that this code was typed into the Setup
    // window; the device row is the proof when the enrollment has since been
    // replaced and ingest-status no longer returns the consumed one.
    code: step(
      status?.enrollment?.consumedAt ? 'enrollment.consumedAt' : activeDevice ? 'device.status=active' : null,
      enrollment.status === 'live' || enrollment.status === 'outstanding' || isEnrollmentUsable(status?.enrollment, nowMs),
    ),
    verify: step(online ? 'device.healthStatus=online within 5 min' : null, Boolean(activeDevice)),
  };
}
