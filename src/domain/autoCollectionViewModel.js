const OFFLINE_AFTER_MS = 5 * 60 * 1000;

const STATE_COPY = Object.freeze({
  // These headline the card, so they have to agree with the steps below them.
  // "The Windows release has not been published yet" described an approval that
  // does not exist; the real condition is two unset environment variables
  // (collectorRelease.js:135), and it is desk-wide, not client-specific.
  unavailable: { label: 'Installer unavailable', tone: 'muted', detail: 'No agent package is configured for the desk yet.' },
  // Not "downloading the Windows installer": the documented path is pasting one
  // PowerShell line, and the download link is the fallback.
  not_installed: { label: 'Not installed', tone: 'muted', detail: 'Run the PowerShell line from step 1 on this client\'s VPS.' },
  awaiting_pair: { label: 'Waiting for VPS', tone: 'info', detail: 'Paste the one-time code into the Setup window before it expires.' },
  // "Open NinjaTrader" understates it: the AddOn is only picked up on a restart,
  // which is why the Setup window says close it completely first
  // (MainWindow.xaml:180).
  paired: { label: 'Paired', tone: 'info', detail: 'The VPS is linked. Restart NinjaTrader there, then run the test.' },
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

const RELEASE_SHA256 = /^[0-9a-f]{64}$/i;

// True when the release carries a digest the install line can check against.
export function hasVerifiableSha256(release) {
  return typeof release?.sha256 === 'string' && RELEASE_SHA256.test(release.sha256);
}

/* One line the CAM pastes into an elevated PowerShell on the client's VPS, the
 * same line for a first install and for an update. It downloads the agent
 * package and runs the installer inside it, so nothing has to be signed or
 * clicked through: the release only needs to be a reachable .zip.
 *
 * IT CHECKS THE BYTES BEFORE ANYTHING OUT OF THEM RUNS. The line runs as
 * administrator on a machine holding live client accounts, and the release
 * already carries the package's SHA-256, read out of a manifest the server
 * pins by its own digest (server/apiLib/collectorRelease.js). So the zip is
 * hashed right after the download and compared with that value; on a mismatch
 * the zip is deleted and the line throws, which stops the rest of the pasted
 * line, before Expand-Archive and before install-agent.ps1. -ne compares
 * strings case insensitively, so Get-FileHash's upper case answer matches the
 * manifest's lower case digest.
 *
 * Returns '' when there is nothing verifiable to hand over: no release, a
 * signed setup executable (run directly, so it gets the download link), or a
 * package without a well formed sha256. Handing over an unverified line is
 * exactly what this exists to prevent. */
export function buildInstallCommand(release) {
  const url = String(release?.url || '').trim();
  // Only the package release is expandable. A signed setup executable is run
  // directly, so it gets the download link instead of a command.
  if (!url || (release?.kind && release.kind !== 'zip')) return '';
  if (!hasVerifiableSha256(release)) return '';
  // Single quoted in PowerShell so nothing in the URL is interpolated. The
  // digest is hex by the check above, so it cannot carry a quote at all.
  const safeUrl = url.replace(/'/g, "''");
  const sha256 = release.sha256.toLowerCase();
  return [
    "$d=\"$env:TEMP\\vincere-agent\"",
    'Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue',
    `Invoke-WebRequest '${safeUrl}' -OutFile "$d.zip" -UseBasicParsing`,
    '$hash=(Get-FileHash -LiteralPath "$d.zip" -Algorithm SHA256).Hash',
    `if ($hash -ne '${sha256}') { Remove-Item -LiteralPath "$d.zip" -Force -ErrorAction SilentlyContinue; throw "SHA256 mismatch, nothing was installed: $hash" }`,
    'Expand-Archive "$d.zip" $d -Force',
    '& "$d\\install-agent.ps1" -PackagePath $d',
  ].join('; ');
}

export function confirmationPhrase(kind, clientName) {
  const verbs = { generate: 'GENERATE', rebind: 'REBIND', revoke: 'REVOKE' };
  const verb = verbs[kind];
  if (!verb) return '';
  return `${verb} ${String(clientName || '').trim()}`;
}
