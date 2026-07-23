const OFFLINE_AFTER_MS = 5 * 60 * 1000;

const STATE_COPY = Object.freeze({
  unavailable: { label: 'Installer unavailable', tone: 'muted', detail: 'The Windows release has not been published yet.' },
  not_installed: { label: 'Not installed', tone: 'muted', detail: 'Start by downloading the Windows installer on this client\'s VPS.' },
  awaiting_pair: { label: 'Waiting for VPS', tone: 'info', detail: 'Enter the one-time code in the installer before it expires.' },
  paired: { label: 'Paired', tone: 'info', detail: 'The VPS is linked. Open NinjaTrader to complete the first connection test.' },
  online: { label: 'Connected', tone: 'success', detail: 'The VPS and CRM connection are healthy.' },
  offline: { label: 'Offline', tone: 'warning', detail: 'The VPS has not checked in recently. Confirm it is running and connected.' },
  failed: { label: 'Needs attention', tone: 'danger', detail: 'The collector reported a problem. Check NinjaTrader and retry the connection test.' },
  revoked: { label: 'Access revoked', tone: 'danger', detail: 'This VPS can no longer upload data. Rebind only if the replacement is intentional.' },
  update_required: { label: 'Update required', tone: 'warning', detail: 'Install the current agent release before the next scheduled capture.' },
});

export function remainingEnrollmentSeconds(expiresAt, nowMs) {
  const expiry = Date.parse(expiresAt || '');
  if (!Number.isFinite(expiry) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((expiry - nowMs) / 1000));
}

export function isEnrollmentUsable(enrollment, nowMs) {
  return Boolean(
    enrollment?.code
    && !enrollment.consumedAt
    && !enrollment.revokedAt
    && remainingEnrollmentSeconds(enrollment.expiresAt, nowMs) > 0,
  );
}

export function buildAutoCollectionViewModel(status, nowMs = 0) {
  const device = status?.device;
  if (isEnrollmentUsable(status?.enrollment, nowMs)) return { state: 'awaiting_pair', nextAction: 'enter_code', ...STATE_COPY.awaiting_pair };
  if (!status?.release && !device) return { state: 'unavailable', nextAction: 'release_unavailable', ...STATE_COPY.unavailable };
  if (device?.status === 'revoked' || device?.revokedAt) return { state: 'revoked', nextAction: 'rebind', ...STATE_COPY.revoked };
  if (status?.enrollment?.revokedAt && !device) return { state: 'revoked', nextAction: 'rebind', ...STATE_COPY.revoked };
  if (device?.healthStatus === 'update_required') return { state: 'update_required', nextAction: 'download', ...STATE_COPY.update_required };
  if (device?.healthStatus === 'error') return { state: 'failed', nextAction: 'retry', ...STATE_COPY.failed };
  if (device) {
    const lastSeen = Date.parse(device.lastSeenAt || '');
    if (device.healthStatus === 'online' && Number.isFinite(lastSeen) && nowMs - lastSeen <= OFFLINE_AFTER_MS) {
      return { state: 'online', nextAction: 'none', ...STATE_COPY.online };
    }
    if (device.healthStatus === 'pending') return { state: 'paired', nextAction: 'verify', ...STATE_COPY.paired };
    return { state: 'offline', nextAction: 'retry', ...STATE_COPY.offline };
  }
  return { state: 'not_installed', nextAction: 'download', ...STATE_COPY.not_installed };
}

export async function copyEnrollmentCode(code, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.writeText) throw new Error('Clipboard unavailable.');
  await clipboard.writeText(String(code || ''));
}

export function confirmationPhrase(kind, clientName) {
  const verbs = { generate: 'GENERATE', rebind: 'REBIND', revoke: 'REVOKE' };
  const verb = verbs[kind];
  if (!verb) return '';
  return `${verb} ${String(clientName || '').trim()}`;
}
