import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  KeyRound,
  LoaderCircle,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import {
  buildAutoCollectionViewModel,
  confirmationPhrase,
  copyEnrollmentCode,
  buildInstallCommand,
  isEnrollmentUsable,
  remainingEnrollmentSeconds,
} from '../domain/autoCollectionViewModel';
import { buildEnrollmentStepStates } from '../domain/autoCollectionSteps';
const REBIND_REASON_OPTIONS = [
  ['vps_rebuilt', 'The VPS was rebuilt'],
  ['device_replaced', 'This is a replacement VPS'],
  ['support_reset', 'Support reset'],
];
const REVOKE_REASON_OPTIONS = [
  ['client_offboarded', 'Client offboarded'],
  ['security_revoke', 'Security concern'],
  ['support_reset', 'Support reset'],
];


function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} remaining`;
}

function formatTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

// The default lives in step_28 and in the agent's own AgentOptions. Repeating it
// here as a literal meant the card kept advertising 16:45 after the default moved
// to 16:30 — and it shows on unpaired clients, where the fallback is all there is.
// A CAM reading this tells the client a time nobody will capture at.
const DEFAULT_CAPTURE_TIME = '16:30';

// Any time reads as a wall clock, not only the one value that used to be
// special-cased. New York shortens to ET because that is what a CAM says out
// loud; every other zone keeps its full name rather than being guessed at.
function formatSchedule(schedule) {
  const time = String(schedule?.time || DEFAULT_CAPTURE_TIME).slice(0, 5);
  const timezone = schedule?.timezone || 'America/New_York';
  const [rawHour, minute] = time.split(':');
  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return `Daily at ${time} · ${timezone}`;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const clock = `${twelve}:${minute} ${suffix}`;
  return timezone === 'America/New_York'
    ? `Daily at ${clock} ET`
    : `Daily at ${clock} · ${timezone}`;
}

function StepMarker({ status = 'future' }) {
  if (status === 'done') return <Check size={14} aria-hidden="true" />;
  return <span aria-hidden="true" />;
}

function ConnectionStep({ number, title, description, state = 'future', unconfirmed = false, children }) {
  return (
    <li className={`auto-collection-step ${state}`}>
      <div className="auto-collection-step-marker">
        <StepMarker status={state} />
        <span className="sr-only">
          Step {number}: {state}{unconfirmed ? ', not confirmed by the VPS' : ''}
        </span>
      </div>
      <div className="auto-collection-step-copy">
        <span className="auto-collection-step-number">{String(number).padStart(2, '0')}</span>
        <strong>{title}</strong>
        <p>{description}</p>
        {/* Rendered instead of a check when the only thing that moved this step
            is a click in this browser tab. Nothing on the VPS reports progress
            back, so the alternative is a green tick that means "the CAM copied
            something". */}
        {unconfirmed ? <p className="auto-collection-step-hint">Not confirmed — the CRM hears nothing from the VPS until it pairs.</p> : null}
        {children}
      </div>
    </li>
  );
}

function SetupConfirmation({ action, clientName, busy, onCancel, onConfirm, returnFocusRef }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState(action?.kind === 'rebind' ? 'vps_rebuilt' : 'security_revoke');
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!action) return undefined;
    const target = returnFocusRef.current;
    return () => target?.focus?.();
  }, [action, returnFocusRef]);
  if (!action) return null;
  const phrase = confirmationPhrase(action.kind, clientName);
  const reasonOptions = action.kind === 'rebind' ? REBIND_REASON_OPTIONS : REVOKE_REASON_OPTIONS;
  return (
    <div className="auto-collection-confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="auto-collection-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collector-confirm-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="auto-collection-confirm-head">
          <div>
            <span className="auto-collection-eyebrow">Confirm client binding</span>
            <h4 id="collector-confirm-title">{action.title}</h4>
          </div>
          <button type="button" className="ghost-button icon-only" aria-label="Close confirmation" disabled={busy} onClick={onCancel}><X size={15} /></button>
        </div>
        <p>{action.description}</p>
        {action.kind !== 'generate' ? (
          <label>
            Reason
            <select value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}>
              {reasonOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          Type <code>{phrase}</code> to continue
          <input value={typed} disabled={busy} autoFocus onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </label>
        <div className="auto-collection-confirm-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={action.kind === 'revoke' ? 'danger-button' : 'primary-button'}
            disabled={busy || typed !== phrase}
            onClick={() => onConfirm(reason)}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : null}
            {busy ? 'Working…' : action.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusDetail({ label, value, dateTime }) {
  return (
    <div className="auto-collection-detail">
      <span>{label}</span>
      {dateTime && value !== 'Not yet' ? <time dateTime={dateTime}>{value}</time> : <strong>{value}</strong>}
    </div>
  );
}

export default function AutoCollectionCard({
  clientUuid,
  clientName,
  api = autoCollectionApi,
  initialStatus = null,
  initialError = null,
  disableAutoLoad = false,
}) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(!initialStatus && !initialError && !disableAutoLoad);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [copyState, setCopyState] = useState('idle');
  const [commandCopyState, setCommandCopyState] = useState('idle');
  // Renamed from `installerStarted`, which is a claim this card cannot make.
  // All it knows is that the CAM took the command or the download out of the
  // browser; whether anything ran on the VPS is invisible until the agent
  // pairs. buildEnrollmentStepStates treats it as `active`, never as `done`.
  const [commandHandedOff, setCommandHandedOff] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.parse(initialStatus?.serverTime || '') || Date.now());
  const requestSequence = useRef(0);
  const activeRequest = useRef(null);
  const clockAnchor = useRef(null);
  const copyTimer = useRef(null);
  const commandCopyTimer = useRef(null);
  const confirmationTrigger = useRef(null);

  function openConfirmation(action, trigger) {
    confirmationTrigger.current = trigger;
    setConfirmation(action);
  }

  const calibrateClock = useCallback((serverTime) => {
    const server = Date.parse(serverTime || '');
    if (!Number.isFinite(server)) return;
    clockAnchor.current = { server, local: Date.now() };
    setNowMs(server);
  }, []);

  const loadStatus = useCallback(async () => {
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await api.loadStatus(clientUuid, { signal: controller.signal });
      if (sequence !== requestSequence.current) return;
      setStatus(result);
      calibrateClock(result.serverTime);
    } catch (caught) {
      if (caught?.name !== 'AbortError' && sequence === requestSequence.current) setError(caught);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [api, calibrateClock, clientUuid]);

  useEffect(() => {
    const startTimer = disableAutoLoad ? null : window.setTimeout(loadStatus, 0);
    return () => {
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (commandCopyTimer.current !== null) window.clearTimeout(commandCopyTimer.current);
      requestSequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [disableAutoLoad, loadStatus]);

  const enrollmentSeconds = remainingEnrollmentSeconds(status?.enrollment?.expiresAt, nowMs);
  useEffect(() => {
    if (!status?.enrollment?.code) return undefined;
    const expiresAt = Date.parse(status.enrollment.expiresAt || '');
    const startingAt = clockAnchor.current?.server ?? Date.parse(status.serverTime || '');
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startingAt) || expiresAt <= startingAt) return undefined;
    if (!clockAnchor.current) clockAnchor.current = { server: startingAt, local: Date.now() };
    const timer = window.setInterval(() => {
      const anchor = clockAnchor.current;
      if (!anchor) return;
      const current = anchor.server + (Date.now() - anchor.local);
      setNowMs(Number.isFinite(expiresAt) ? Math.min(current, expiresAt) : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status?.enrollment?.code, status?.enrollment?.expiresAt, status?.serverTime]);

  async function runConfirmedAction(reason) {
    const action = confirmation;
    if (!action || busy) return;
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (action.kind === 'generate') result = await api.generateEnrollment(clientUuid, { signal: controller.signal });
      if (action.kind === 'rebind') result = await api.rebind(clientUuid, reason, { signal: controller.signal });
      if (action.kind === 'revoke') {
        const activeDeviceId = status?.device?.status === 'active' && !status?.device?.revokedAt
          ? status.device.id
          : null;
        result = await api.revoke(clientUuid, {
          ...(activeDeviceId ? { deviceId: activeDeviceId } : { enrollmentId: status?.enrollment?.id }),
          reason,
          signal: controller.signal,
        });
      }
      if (sequence !== requestSequence.current) return;
      if (action.kind === 'revoke') {
        const revokedAt = new Date().toISOString();
        setStatus((current) => ({
          ...current,
          device: result?.revoked?.kind === 'device'
            ? { ...current?.device, status: 'revoked', revokedAt }
            : current?.device,
          enrollment: result?.revoked?.kind === 'enrollment'
            ? { ...current?.enrollment, revokedAt }
            : current?.enrollment,
        }));
      } else {
        setStatus((current) => ({ ...current, serverTime: result.serverTime, enrollment: result.enrollment }));
        calibrateClock(result.serverTime);
      }
      setConfirmation(null);
    } catch (caught) {
      if (caught?.name !== 'AbortError' && sequence === requestSequence.current) setError(caught);
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }

  async function handleCopyCommand() {
    try {
      await copyEnrollmentCode(installCommand);
      setCommandCopyState('copied');
      // Copying the command is the documented primary path, and it used to set
      // nothing: step 2 stayed grey while step 3 was already lit, so the trace
      // skipped a step in front of the CAM. It still only means "the command
      // left the browser" — hence handed off, not done.
      setCommandHandedOff(true);
      if (commandCopyTimer.current !== null) window.clearTimeout(commandCopyTimer.current);
      commandCopyTimer.current = window.setTimeout(() => {
        commandCopyTimer.current = null;
        setCommandCopyState('idle');
      }, 1800);
    } catch {
      setCommandCopyState('failed');
    }
  }

  async function handleCopy() {
    try {
      await copyEnrollmentCode(status?.enrollment?.code);
      setCopyState('copied');
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopyState('idle');
      }, 1800);
    } catch {
      setCopyState('failed');
    }
  }

  if (error?.status === 403 || error?.status === 401) {
    return (
      <section className="panel auto-collection-panel permission-denied" aria-labelledby="auto-collection-title">
        <div className="auto-collection-state-icon"><ShieldCheck size={20} /></div>
        <div><h3 id="auto-collection-title">Permission required</h3><p>{error.message}</p></div>
      </section>
    );
  }

  const view = buildAutoCollectionViewModel(status, nowMs);
  const usableCode = isEnrollmentUsable(status?.enrollment, nowMs);
  const device = status?.device;
  const activeDevice = device?.status === 'active' && !device?.revokedAt ? device : null;
  const activeEnrollment = status?.enrollment
    && !status.enrollment.consumedAt
    && !status.enrollment.revokedAt
    ? status.enrollment
    : null;
  const hasRelease = Boolean(status?.release);
  const installCommand = buildInstallCommand(status?.release);
  const displayClientName = status?.client?.name || clientName;
  const steps = buildEnrollmentStepStates(status, nowMs, { commandHandedOff });
  const enrollmentPhase = steps.enrollment.status;
  // buildInstallCommand returns '' for a signed setup executable
  // (autoCollectionViewModel.js:62), which is run rather than expanded. Step 1
  // used to gate its body on hasRelease alone, so an exe release rendered
  // "…then paste this:" above an empty <code> block. The CAM was told to paste
  // nothing.
  const hasInstallCommand = Boolean(installCommand);
  // Step 1's instructions are for someone who has not installed yet. Gating them
  // on hasRelease alone kept the 100 MB PowerShell line, the ExecutionPolicy
  // note and the download link on screen for a VPS that is already paired and
  // sending heartbeats — the state where re-running the installer is exactly
  // what nobody should do.
  const showInstallInstructions = hasRelease && steps.install.state !== 'done';

  return (
    <section className={`panel auto-collection-panel state-${view.state}`} aria-labelledby="auto-collection-title" aria-busy={loading || busy}>
      <header className="auto-collection-header">
        <div>
          <span className="auto-collection-eyebrow"><Radio size={12} /> VPS data connection</span>
          <h3 id="auto-collection-title">Automatic NinjaTrader collection</h3>
          <p>Connect this client&apos;s VPS once. Accounts, strategies, orders, and executions will upload automatically.</p>
        </div>
        <div className={`auto-collection-state ${view.tone}`} role="status">
          <span className="auto-collection-state-dot" aria-hidden="true" />
          <div><strong>{loading ? 'Checking…' : view.label}</strong><span>{loading ? 'Loading the latest VPS status.' : view.detail}</span></div>
        </div>
      </header>

      {error ? <div className="auto-collection-notice danger" role="alert"><AlertTriangle size={15} /><span>{error.message}</span><button type="button" className="ghost-button" onClick={loadStatus}>Try again</button></div> : null}

      <div className="auto-collection-binding">
        <Server size={17} aria-hidden="true" />
        <span>Bound to</span>
        <strong>{displayClientName}</strong>
        <span className="auto-collection-schedule"><Clock3 size={13} /> {formatSchedule(device?.schedule)}</span>
      </div>

      <ol className="auto-collection-trace" aria-label="Collector setup progress">
        <ConnectionStep
          number={1}
          title="Install the agent"
          description={hasRelease
            ? `Windows agent ${status.release.version}`
            : 'The agent package is not configured yet.'}
          state={steps.install.state}
          unconfirmed={steps.install.unconfirmed}
        >
          {hasRelease || steps.install.state === 'done' ? null : (
            // Says what is actually missing, to whoever is reading.
            //
            // This used to read "Waiting for an approved Windows release", which
            // described a publishing ceremony that does not exist: there is no
            // store, no approval and no certificate. resolveInstallerRelease
            // (server/apiLib/collectorRelease.js:135) returns null when
            // AUTO_COLLECTION_RELEASE_MANIFEST_URL and _SHA256 are both empty,
            // and that is the entire condition behind this state.
            //
            // Signing is genuinely optional — collectorRelease.js:81 says so and
            // the server pins integrity by SHA-256 instead. A CAM who reads
            // "approved release" cannot tell whether it is their problem, and
            // forwards a request nobody can act on.
            <p className="auto-collection-step-hint">
              Nothing is wrong on this client. The agent package has not been
              pointed at yet, which needs two environment variables set once for
              the whole desk:{' '}
              <code>AUTO_COLLECTION_RELEASE_MANIFEST_URL</code> pointing at the
              manifest JSON over https, and{' '}
              <code>AUTO_COLLECTION_RELEASE_MANIFEST_SHA256</code> holding that
              file&apos;s SHA-256. No code signing and no certificate are
              involved. Until both are set, every client shows this step.
            </p>
          )}
          {showInstallInstructions && hasInstallCommand ? (
            <p className="auto-collection-step-hint">
              On the client&apos;s VPS, right-click PowerShell and choose Run as
              administrator — with NinjaTrader closed, or the script stops at its
              first check — then paste this. It downloads roughly 100 MB, so the
              two progress bars can run for a few minutes before anything else
              appears.
            </p>
          ) : null}
          {showInstallInstructions && !hasInstallCommand ? (
            // A signed setup executable has nothing to paste: it is downloaded
            // and double-clicked. Saying "paste this" over an empty code block
            // is how this branch used to render.
            <p className="auto-collection-step-hint">
              This release is a signed setup program, not a package the CRM can
              hand over as one line. Download it on the client&apos;s VPS, close
              NinjaTrader, and run it there.
            </p>
          ) : null}
          {showInstallInstructions && hasInstallCommand ? (
            <div className="auto-collection-code-wrap">
              <code className="auto-collection-command">{installCommand}</code>
              <button
                type="button"
                className="ghost-button icon-only"
                aria-label="Copy install command"
                onClick={handleCopyCommand}
              >
                <Copy size={14} />
              </button>
              <span>{commandCopyState === 'copied' ? 'Copied' : commandCopyState === 'failed' ? 'Copy unavailable' : ''}</span>
            </div>
          ) : null}
          {showInstallInstructions ? (
            <a
              className="auto-collection-step-link"
              href={status.release.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setCommandHandedOff(true)}
            >
              <Download size={13} /> {hasInstallCommand ? 'or download the package manually' : 'download the setup program'}
            </a>
          ) : null}
          {showInstallInstructions && hasInstallCommand ? (
            // The one blocker collector/docs/installing.md:43-56 documents, and
            // the pasted line carries no ExecutionPolicy handling of its own.
            <p className="auto-collection-step-hint">
              If PowerShell answers <code>running scripts is disabled on this
              system</code>, put{' '}
              <code>Set-ExecutionPolicy -Scope Process Bypass -Force;</code> in
              front of the line and paste it again.
            </p>
          ) : null}
        </ConnectionStep>
        <ConnectionStep
          number={2}
          // Not "Approve the Windows prompt". Step 1 already has the CAM open
          // PowerShell as administrator, so the session is elevated and no
          // second Windows dialog ever appears: install-agent.ps1 checks
          // IsInRole(Administrator) at line 67 and throws instead of elevating,
          // and the Setup UI it launches at the end inherits the elevated token
          // from Start-Process, so its requireAdministrator manifest triggers
          // nothing either. A step whose completion signal does not exist makes
          // people sit and wait for a dialog forever.
          title="Let the script finish"
          description="No prompt appears. The script copies the files, locks down the data folder, registers the Vincere Auto Export service and starts it. It is finished when the console prints Installed. and the Vincere Auto Export Setup window opens by itself."
          state={steps.script.state}
          unconfirmed={steps.script.unconfirmed}
        >
          {steps.script.state === 'active' ? (
            // The CI package deliberately ships without the AddOn
            // (.github/workflows/collector-windows.yml:120-138), so this warning
            // is what the CAM actually sees today — and it looks like a failure
            // right before the service registers.
            <p className="auto-collection-step-hint">
              <code>WARNING: No AddOn folder in the package - skipping</code> is
              expected and is not a failure: the service still installs and
              pairing still works. NinjaTrader capture stays off until the AddOn
              is deployed separately. Starting the service can hold the console
              for up to 30 seconds.
            </p>
          ) : null}
        </ConnectionStep>
        <ConnectionStep
          number={3}
          title="Enter one-time code"
          description="In the Vincere Auto Export Setup window, paste this code and press Connect this VPS. It is the only thing that tells the server which client this machine belongs to. It lasts 60 minutes; when it expires, generate another one."
          state={steps.code.state}
        >
          {usableCode ? (
            <>
              <div className="auto-collection-code-wrap">
                <code className="auto-collection-code">{status.enrollment.code}</code>
                <button type="button" className="ghost-button icon-only" aria-label="Copy one-time code" onClick={handleCopy}><Copy size={14} /></button>
                <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy unavailable' : formatCountdown(enrollmentSeconds)}</span>
              </div>
              {/* The server returns the plaintext code once, in the 201 body
                  (ingest-enrollment.js:109-134). ingest-status never returns it
                  again, so a reload really does lose it. */}
              <p className="auto-collection-step-hint">
                Shown once. Reload this page and the code is gone — the server
                never sends it a second time.
              </p>
            </>
          ) : null}
          {!usableCode && enrollmentPhase === 'outstanding' && !device ? (
            // Same render as "no code at all" until now, which is how a CAM
            // ended up killing a code the client was already typing:
            // create_ingest_enrollment revokes every unused code for the client
            // inside the same transaction (step_28_auto_collection.sql:543-547),
            // and the client's screen then says "invalid or expired".
            <p className="auto-collection-step-hint">
              A code for this client is already outstanding and valid until{' '}
              {formatTime(status.enrollment.expiresAt)}. It cannot be shown
              again. If the client still has it, let them use it — generating a
              replacement cancels theirs immediately.
            </p>
          ) : null}
          {!usableCode && enrollmentPhase === 'expired' && !device ? (
            <p className="auto-collection-step-hint">
              The previous code expired at {formatTime(status.enrollment.expiresAt)}.
              Generate another one; the expired one cannot be revived.
            </p>
          ) : null}
          {!usableCode && !device && status?.permissions?.generate && hasRelease ? (
            <button type="button" className="secondary-button auto-collection-step-action" onClick={(event) => openConfirmation({
              kind: 'generate',
              title: 'Generate a one-time code?',
              description: 'Any older unused code for this client will stop working.',
              confirmLabel: 'Generate one-time code',
            }, event.currentTarget)}><KeyRound size={14} /> {enrollmentPhase === 'outstanding' ? 'Replace the outstanding code' : 'Generate one-time code'}</button>
          ) : null}
          {!usableCode && !device && status?.permissions?.generate && !hasRelease ? (
            // The only thing that can consume a code is the Setup window, and
            // it ships inside the release package. With no package there is
            // nothing on the other end: the code would count down for 60
            // minutes and expire unused. That is the "the code does not work"
            // report. The permission guard is untouched — the button is simply
            // not offered while it can only produce a dead code.
            <p className="auto-collection-step-hint">
              No code yet. The window that accepts it ships inside the agent
              package, so a code generated now would expire with nothing able to
              read it. Finish step 1 first.
            </p>
          ) : null}
        </ConnectionStep>
        <ConnectionStep
          number={4}
          title="Restart NinjaTrader and test"
          // Was "Leave NinjaTrader open", which contradicted both step 1 (which
          // requires NinjaTrader closed) and the Setup window's own third
          // screen, MainWindow.xaml:180: "Close NinjaTrader completely, open it
          // again, connect the trading accounts, then run the test."
          description="On the VPS: close NinjaTrader completely, open it again, connect the trading accounts, then run the test in the Setup window. This turns green once the agent's heartbeat reaches the CRM."
          state={steps.verify.state}
        >
          {/* Nothing polls: status is fetched on mount and by this button.
              Without saying so, a CAM watches a card that will never change. */}
          {steps.verify.state === 'active' ? (
            <>
              <button type="button" className="secondary-button auto-collection-step-action" disabled={loading} onClick={loadStatus}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Check connection</button>
              <p className="auto-collection-step-hint">This card does not update on its own — press this to re-read the VPS status.</p>
            </>
          ) : null}
          {steps.verify.state === 'done' ? <span className="auto-collection-connected"><CheckCircle2 size={14} /> Heartbeat received in the last 5 minutes</span> : null}
        </ConnectionStep>
      </ol>

      {device ? (
        <div className="auto-collection-details" aria-label="Collector details">
          <StatusDetail label="Last heartbeat" value={formatTime(device.lastSeenAt)} dateTime={device.lastSeenAt} />
          <StatusDetail label="Last capture" value={formatTime(device.lastCaptureAt)} dateTime={device.lastCaptureAt} />
          <StatusDetail label="Last successful upload" value={formatTime(device.lastSuccessAt)} dateTime={device.lastSuccessAt} />
          <StatusDetail label="Installed versions" value={`Agent ${device.agentVersion || '—'} · Add-on ${device.addonVersion || '—'} · NinjaTrader ${device.ninjaTraderVersion || '—'}`} />
        </div>
      ) : null}

      {device || status?.enrollment ? (
        <footer className="auto-collection-footer">
          <span>Only rebind or revoke when the VPS assignment intentionally changes.</span>
          <div>
            {status?.permissions?.rebind ? <button type="button" className="ghost-button" onClick={(event) => openConfirmation({ kind: 'rebind', title: 'Rebind this client to another VPS?', description: 'The current VPS and all unused codes will immediately lose access.', confirmLabel: 'Rebind VPS' }, event.currentTarget)}><RotateCcw size={14} /> Rebind VPS</button> : null}
            {status?.permissions?.revoke && (activeDevice || activeEnrollment) ? <button type="button" className="ghost-button danger-text" onClick={(event) => openConfirmation({ kind: 'revoke', title: 'Revoke automatic collection access?', description: 'Uploads from the current VPS will stop immediately.', confirmLabel: 'Revoke access' }, event.currentTarget)}><Ban size={14} /> Revoke access</button> : null}
          </div>
        </footer>
      ) : null}

      <SetupConfirmation
        key={confirmation?.kind || 'none'}
        action={confirmation}
        clientName={displayClientName}
        busy={busy}
        returnFocusRef={confirmationTrigger}
        onCancel={() => { if (!busy) setConfirmation(null); }}
        onConfirm={runConfirmedAction}
      />
    </section>
  );
}
