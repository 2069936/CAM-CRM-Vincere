import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AutoCollectionCard from './AutoCollectionCard';
import { buildAutoCollectionViewModel, buildInstallCommand, confirmationPhrase, copyEnrollmentCode, remainingEnrollmentSeconds } from '../domain/autoCollectionViewModel';
import { buildEnrollmentStepStates, describeEnrollment } from '../domain/autoCollectionSteps';

const base = {
  serverTime: '2026-07-23T16:45:00.000Z',
  client: { uuid: '11111111-1111-4111-8111-111111111111', name: 'Acme Trading' },
  permissions: { generate: true, rebind: true, revoke: true },
  release: { url: 'https://downloads.example.test/agent.msi', version: '1.4.2', sha256: 'a'.repeat(64), publishedAt: '2026-07-23T14:00:00.000Z' },
  device: null,
  enrollment: null,
};

function render(status, props = {}) {
  return renderToStaticMarkup(<AutoCollectionCard
    clientUuid={base.client.uuid}
    clientName={base.client.name}
    initialStatus={status}
    disableAutoLoad
    {...props}
  />);
}

describe('auto collection setup view model', () => {
  it('is safe during the initial status request', () => {
    expect(buildAutoCollectionViewModel(null, Date.parse(base.serverTime))).toMatchObject({ state: 'unavailable' });
    expect(render(null, { disableAutoLoad: false })).toContain('Checking…');
  });

  it('distinguishes unavailable and not installed states with a clear next action', () => {
    expect(buildAutoCollectionViewModel({ ...base, release: null }, Date.parse(base.serverTime))).toMatchObject({ state: 'unavailable', nextAction: 'release_unavailable' });
    expect(buildAutoCollectionViewModel(base, Date.parse(base.serverTime))).toMatchObject({ state: 'not_installed', nextAction: 'download' });
  });

  it('distinguishes paired online, offline, failed, revoked, and update-required devices', () => {
    const device = { id: 'device', status: 'active', healthStatus: 'online', lastSeenAt: '2026-07-23T16:44:00.000Z' };
    expect(buildAutoCollectionViewModel({ ...base, device }, Date.parse(base.serverTime)).state).toBe('online');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, lastSeenAt: '2026-07-23T16:30:00.000Z' } }, Date.parse(base.serverTime)).state).toBe('offline');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, healthStatus: 'error', lastErrorCode: 'capture_failed' } }, Date.parse(base.serverTime)).state).toBe('failed');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, status: 'revoked', revokedAt: base.serverTime } }, Date.parse(base.serverTime)).state).toBe('revoked');
    expect(buildAutoCollectionViewModel({ ...base, device: { ...device, healthStatus: 'update_required' } }, Date.parse(base.serverTime)).state).toBe('update_required');
  });

  it('uses server expiry for the one-time-code countdown', () => {
    expect(remainingEnrollmentSeconds('2026-07-23T16:46:30.000Z', Date.parse(base.serverTime))).toBe(90);
    expect(remainingEnrollmentSeconds('2026-07-23T16:44:00.000Z', Date.parse(base.serverTime))).toBe(0);
  });

  it('prioritizes a fresh rebind code over the revoked prior VPS', () => {
    const status = {
      ...base,
      device: { id: 'old-device', status: 'revoked', revokedAt: base.serverTime },
      enrollment: { id: 'new-enrollment', code: 'NEXT-CODE', expiresAt: '2026-07-23T16:50:00.000Z', consumedAt: null, revokedAt: null },
    };
    expect(buildAutoCollectionViewModel(status, Date.parse(base.serverTime))).toMatchObject({ state: 'awaiting_pair', nextAction: 'enter_code' });
  });

  it('shows a revoked unused enrollment even when no device has paired', () => {
    expect(buildAutoCollectionViewModel({ ...base, device: null, enrollment: { id: 'enrollment', revokedAt: base.serverTime } }, Date.parse(base.serverTime)).state).toBe('revoked');
  });
});

describe('AutoCollectionCard rendering and actions', () => {
  it('renders one sequential four-step connection trace instead of generic cards', () => {
    const html = render(base);
    expect(html).toContain('Install the agent');
    // Renamed deliberately. Step 1 opens PowerShell as administrator, so
    // elevation is already done and no second Windows dialog ever appears; the
    // old title had people waiting for a prompt that does not exist.
    expect(html).toContain('Let the script finish');
    expect(html).not.toContain('Approve the Windows prompt');
    expect(html).toContain('Enter one-time code');
    // Was "Confirm connection" with "Leave NinjaTrader open", which contradicted
    // step 1 (NinjaTrader closed) and the Setup window's own third screen.
    expect(html).toContain('Restart NinjaTrader and test');
    expect(html).not.toContain('Leave NinjaTrader open');
    expect(html).toContain('close NinjaTrader completely, open it again');
    expect((html.match(/auto-collection-step/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('href="https://downloads.example.test/agent.msi"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('describes what step 2 really does, and how the CAM knows it ended', () => {
    // install-agent.ps1 never elevates: it checks IsInRole(Administrator) at
    // line 67 and throws. The Setup UI it launches inherits the already-elevated
    // token from Start-Process, so its requireAdministrator manifest raises no
    // dialog either. The step named a signal that does not exist, and its
    // completion — "Installed." plus the Setup window opening — was never named.
    const html = render(base);

    expect(html).toContain('No prompt appears');
    expect(html).toContain('Vincere Auto Export Setup window opens by itself');
    expect(html).not.toMatch(/approve the Windows prompt|User Account Control/i);
  });

  it('tells step 1 readers which two settings are missing and whose they are', () => {
    // resolveInstallerRelease returns null only when both manifest variables are
    // blank (collectorRelease.js:135), one desk-wide condition — not anything
    // this client did. The old copy, "Waiting for an approved Windows release",
    // invented an approval nobody performs and left the CAM unable to say
    // whether it was their problem.
    const html = render({ ...base, release: null });

    expect(html).toContain('AUTO_COLLECTION_RELEASE_MANIFEST_URL');
    expect(html).toContain('AUTO_COLLECTION_RELEASE_MANIFEST_SHA256');
    expect(html).toContain('Nothing is wrong on this client');
    expect(html).not.toContain('approved Windows release');
  });

  it('says what the code is for and what to do when it expires', () => {
    const live = render({ ...base, enrollment: { id: 'e', code: 'A1B2C3D4E5', expiresAt: '2026-07-23T17:45:00.000Z', consumedAt: null, revokedAt: null } });
    expect(live).toContain('which client this machine belongs to');
    expect(live).toContain('lasts 60 minutes');
    // Only the POST response carries the plaintext code; ingest-status never
    // returns it (ingest-status.js:85-93), so a reload really does lose it.
    expect(live).toContain('Shown once');

    const expired = render({ ...base, enrollment: { id: 'e', expiresAt: '2026-07-23T16:30:00.000Z', consumedAt: null, revokedAt: null } });
    expect(expired).toContain('expired at');
    expect(expired).toContain('Generate one-time code');
  });

  it('warns before a regeneration kills the code the client is holding', () => {
    // create_ingest_enrollment revokes every unused code for the client in the
    // same transaction (step_28_auto_collection.sql:543-547). An outstanding
    // enrollment used to render identically to no enrollment at all, so the CAM
    // pressed Generate and the client's screen said "invalid or expired".
    const html = render({ ...base, enrollment: { id: 'e', expiresAt: '2026-07-23T17:45:00.000Z', consumedAt: null, revokedAt: null } });

    expect(html).toContain('already outstanding');
    expect(html).toContain('cancels theirs immediately');
    expect(html).toContain('Replace the outstanding code');
  });

  it('does not offer a code while nothing exists that could consume one', () => {
    // The Setup window is the only consumer and it ships inside the release
    // package. With no package the code counts down 60 minutes against nothing.
    const html = render({ ...base, release: null });

    expect(html).not.toContain('Generate one-time code');
    expect(html).toContain('nothing able to');
  });

  it('stops handing out installer instructions once the VPS has paired', () => {
    // Caught by rendering, not by a failing assertion: an online, paired client
    // still displayed the 100 MB PowerShell line, the ExecutionPolicy note and
    // the download link — telling a CAM to re-run an installer on a machine
    // that is already sending heartbeats.
    const html = render({ ...base, device: { id: 'd', status: 'active', healthStatus: 'online', lastSeenAt: '2026-07-23T16:44:00.000Z' } });

    expect(html).not.toContain('install-agent.ps1');
    expect(html).not.toContain('Set-ExecutionPolicy');
    expect(html).not.toContain('download the package manually');
    // The step itself stays, marked done, with the version it installed.
    expect(html).toContain('Install the agent');
    expect(html).toContain('Windows agent 1.4.2');
  });

  it('never writes "paste this" above an empty command block', () => {
    // buildInstallCommand returns '' for a signed setup executable
    // (autoCollectionViewModel.js:62). Step 1 gated its body on hasRelease, so
    // this branch rendered <code class="auto-collection-command"></code> under
    // an instruction to paste it.
    const html = render({ ...base, release: { ...base.release, url: 'https://downloads.example.test/Setup.exe', kind: 'exe' } });

    expect(html).not.toContain('<code class="auto-collection-command"></code>');
    expect(html).not.toContain('then paste this');
    expect(html).toContain('signed setup program');
    expect(html).toContain('download the setup program');
  });

  it('renders a generated code, expiry countdown, and copy control without leaking other secrets', () => {
    const html = render({ ...base, enrollment: { id: 'enrollment', code: 'ABCD-EFGH', expiresAt: '2026-07-23T16:47:00.000Z', consumedAt: null, revokedAt: null } });
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('2:00 remaining');
    expect(html).toContain('aria-label="Copy one-time code"');
    expect(html).not.toContain('auto-collection-step done');
    expect(html).not.toMatch(/product.?key|device.?token|credential.?hash|machine.?hash/i);
  });

  it('copies only the supplied enrollment code', async () => {
    const writeText = vi.fn(async () => undefined);
    await copyEnrollmentCode('ABCD-EFGH', { writeText });
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
  });

  it('requires exact client-bound confirmation phrases for every mutation', () => {
    expect(confirmationPhrase('generate', 'Acme Trading')).toBe('GENERATE Acme Trading');
    expect(confirmationPhrase('rebind', 'Acme Trading')).toBe('REBIND Acme Trading');
    expect(confirmationPhrase('revoke', 'Acme Trading')).toBe('REVOKE Acme Trading');
  });

  it.each([
    ['online', { healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:44:00.000Z' }, 'Connected'],
    ['offline', { healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:20:00.000Z' }, 'Offline'],
    ['failed', { healthStatus: 'error', status: 'active', lastSeenAt: base.serverTime, lastErrorCode: 'capture_failed' }, 'Needs attention'],
    ['revoked', { healthStatus: 'online', status: 'revoked', lastSeenAt: base.serverTime, revokedAt: base.serverTime }, 'Access revoked'],
    ['update', { healthStatus: 'update_required', status: 'active', lastSeenAt: base.serverTime }, 'Update required'],
  ])('renders the %s operational state', (_name, device, copy) => {
    expect(render({ ...base, device: { id: 'device', agentVersion: '1.4.1', addonVersion: '1.0.0', ninjaTraderVersion: '8.1.5.2', schedule: { time: '16:45:00', timezone: 'America/New_York' }, ...device } })).toContain(copy);
  });

  it('falls back to the real default capture time, not a stale literal', () => {
    // The card showed 4:45 PM for any client without a device — which is every
    // client before install, the moment a CAM is most likely to read it out.
    // The default had moved to 16:30 in step_28 and in the agent, and the card
    // kept advertising a time nobody would capture at.
    const html = render({ ...base, device: null });

    expect(html).toContain('4:30 PM ET');
    expect(html).not.toContain('4:45 PM ET');
  });

  it('reads any schedule as a wall clock, not just the one that was special-cased', () => {
    const morning = render({
      ...base,
      device: { id: 'd', schedule: { time: '09:05:00', timezone: 'Europe/London' } },
    });
    const noon = render({
      ...base,
      device: { id: 'd', schedule: { time: '12:00:00', timezone: 'America/New_York' } },
    });

    expect(morning).toContain('9:05 AM');
    expect(morning).toContain('Europe/London');
    // Noon is the case a 12-hour conversion gets wrong by turning it into 0:00.
    expect(noon).toContain('12:00 PM ET');
  });

  it('shows binding, timestamps, versions, 16:45 ET schedule, and intentional controls', () => {
    const html = render({ ...base, device: { id: 'device', healthStatus: 'online', status: 'active', lastSeenAt: '2026-07-23T16:44:00.000Z', lastCaptureAt: '2026-07-22T20:45:00.000Z', lastSuccessAt: '2026-07-22T20:46:00.000Z', agentVersion: '1.4.2', addonVersion: '1.1.0', ninjaTraderVersion: '8.1.5.2', schedule: { time: '16:45:00', timezone: 'America/New_York' } } });
    expect(html).toContain('Acme Trading');
    expect(html).toContain('4:45 PM ET');
    expect(html).toContain('Agent 1.4.2');
    expect(html).toContain('Add-on 1.1.0');
    expect(html).toContain('Rebind VPS');
    expect(html).toContain('Revoke access');
  });

  it('renders permission denied without operational actions', () => {
    const html = render(null, { initialError: { status: 403, message: 'You do not have access to this client setup.' } });
    expect(html).toContain('Permission required');
    expect(html).not.toContain('Generate one-time code');
    expect(html).not.toContain('Revoke access');
  });
});

describe('install command', () => {
  it('builds a one-line PowerShell install from the release url', () => {
    const command = buildInstallCommand({ url: 'https://downloads.example.test/agent.zip' });
    expect(command).toContain("Invoke-WebRequest 'https://downloads.example.test/agent.zip'");
    expect(command).toContain('Expand-Archive');
    expect(command).toContain('install-agent.ps1');
  });

  it('is empty when no release is published', () => {
    expect(buildInstallCommand(null)).toBe('');
    expect(buildInstallCommand({ url: '' })).toBe('');
  });

  it('is empty for a signed setup executable, which is run rather than expanded', () => {
    expect(buildInstallCommand({ url: 'https://x.test/Setup.exe', kind: 'exe' })).toBe('');
    expect(buildInstallCommand({ url: 'https://x.test/agent.zip', kind: 'zip' })).toContain('Expand-Archive');
  });

  it('escapes a single quote in the url so the command cannot break out', () => {
    expect(buildInstallCommand({ url: "https://x.test/a'b.zip" })).toContain("'https://x.test/a''b.zip'");
  });
});

describe('a step is only complete when a signal proves it', () => {
  const now = Date.parse(base.serverTime);
  const online = { id: 'd', status: 'active', healthStatus: 'online', lastSeenAt: '2026-07-23T16:44:00.000Z' };

  it('never reports done without naming the server field that confirms it', () => {
    // The rule this whole module exists for. `done` used to come partly from
    // `installerStarted`, a browser boolean set by one onClick, so the card drew
    // a green check for "the CAM clicked a download link". Claiming completion
    // on a guess is the same defect as printing an unmeasured value as 0.
    const cases = [
      ['no release', { ...base, release: null }],
      ['release, nothing done', base],
      ['live code', { ...base, enrollment: { id: 'e', code: 'A1B2C3D4E5', expiresAt: '2026-07-23T17:45:00.000Z' } }],
      ['expired code', { ...base, enrollment: { id: 'e', expiresAt: '2026-07-23T16:30:00.000Z' } }],
      ['paired but silent', { ...base, device: { ...online, healthStatus: 'pending', lastSeenAt: null } }],
      ['online', { ...base, device: online }],
      ['revoked', { ...base, device: { ...online, status: 'revoked', revokedAt: base.serverTime } }],
    ];

    for (const [name, status] of cases) {
      for (const local of [{}, { commandHandedOff: true }]) {
        const steps = buildEnrollmentStepStates(status, now, local);
        for (const key of ['install', 'script', 'code', 'verify']) {
          const step = steps[key];
          if (step.state === 'done') {
            expect(step.confirmedBy, `${name}/${key} is done with no signal`).toBeTruthy();
          } else {
            // Not "false": nothing has confirmed it, which is a different claim
            // from a signal that came back negative.
            expect(step.confirmedBy, `${name}/${key}`).toBeNull();
          }
        }
      }
    }
  });

  it('treats a local click as progress, never as proof', () => {
    const cold = buildEnrollmentStepStates(base, now, {});
    const clicked = buildEnrollmentStepStates(base, now, { commandHandedOff: true });

    expect(cold.script.state).toBe('future');
    expect(clicked.script.state).toBe('active');
    expect(clicked.script.state).not.toBe('done');
    expect(clicked.script.unconfirmed).toBe(true);
    expect(clicked.install.state).not.toBe('done');
    expect(clicked.install.unconfirmed).toBe(true);

    // And the rendered card says so, rather than showing a bare highlight the
    // CAM would read as "installed".
    const html = renderToStaticMarkup(<AutoCollectionCard
      clientUuid={base.client.uuid}
      clientName={base.client.name}
      initialStatus={base}
      disableAutoLoad
    />);
    expect(html).not.toContain('auto-collection-step done');
  });

  it('marks a paired device as proof of the install and the script, not just the code', () => {
    // Only the installed service can call pair_ingest_device_v2, so a device row
    // is real evidence for steps 1-3 — including after a revoke, where the CAM
    // needs a new code and not a second install.
    const steps = buildEnrollmentStepStates({ ...base, device: online }, now, {});
    expect(steps.install).toMatchObject({ state: 'done', confirmedBy: 'device row exists' });
    expect(steps.script).toMatchObject({ state: 'done', confirmedBy: 'device row exists' });
    expect(steps.code).toMatchObject({ state: 'done', confirmedBy: 'device.status=active' });
    expect(steps.verify.confirmedBy).toContain('online');

    const revoked = buildEnrollmentStepStates({ ...base, device: { ...online, status: 'revoked', revokedAt: base.serverTime } }, now, {});
    expect(revoked.install.state).toBe('done');
    expect(revoked.code.state).toBe('future');
    expect(revoked.verify.state).toBe('future');
  });

  it('stops calling step 4 done when the heartbeat goes stale', () => {
    const stale = buildEnrollmentStepStates({ ...base, device: { ...online, lastSeenAt: '2026-07-23T16:20:00.000Z' } }, now, {});
    expect(stale.verify).toMatchObject({ state: 'active', confirmedBy: null });
  });

  it('separates an expired code from one whose expiry cannot be read', () => {
    // remainingEnrollmentSeconds returns 0 for both, and the card tells the CAM
    // to generate a new one off the back of it. "Expired" and "unreadable" are
    // different claims and must not share a branch.
    expect(describeEnrollment({ id: 'e', expiresAt: '2026-07-23T16:30:00.000Z' }, now).status).toBe('expired');
    expect(describeEnrollment({ id: 'e', expiresAt: 'not a date' }, now).status).toBe('unknown');
    expect(describeEnrollment({ id: 'e' }, now).status).toBe('unknown');
    expect(describeEnrollment({ id: 'e', expiresAt: 'not a date' }, now).remainingSeconds).toBeNull();
    expect(describeEnrollment(null, now).status).toBe('none');
    expect(describeEnrollment({ id: 'e', expiresAt: '2026-07-23T17:45:00.000Z' }, now).status).toBe('outstanding');
    expect(describeEnrollment({ id: 'e', code: 'A1B2C3D4E5', expiresAt: '2026-07-23T17:45:00.000Z' }, now).status).toBe('live');
    expect(describeEnrollment({ id: 'e', consumedAt: base.serverTime, expiresAt: '2026-07-23T17:45:00.000Z' }, now).status).toBe('consumed');
  });
});

describe('install step rendering', () => {
  it('shows the copyable command when a release exists', () => {
    const html = render(base);
    expect(html).toContain('Install the agent');
    expect(html).toContain('install-agent.ps1');
  });

  it('names the two variables that are missing instead of an approval nobody grants', () => {
    // The card used to read "Waiting for an approved Windows release", which
    // describes a publishing ceremony that does not exist — there is no store,
    // no approval and no certificate. resolveInstallerRelease
    // (server/apiLib/collectorRelease.js:135) returns null only when both
    // environment variables are empty, and collectorRelease.js:81 states that
    // signing is optional because integrity is pinned by SHA-256 instead.
    //
    // A CAM who reads "approved release" cannot tell whether it is their
    // problem, and forwards a request their developer cannot act on. The names
    // are asserted here because they are the whole actionable content.
    const html = render({ ...base, release: null });
    expect(html).toContain('AUTO_COLLECTION_RELEASE_MANIFEST_URL');
    expect(html).toContain('AUTO_COLLECTION_RELEASE_MANIFEST_SHA256');
    expect(html).not.toContain('approved Windows release');
    expect(html).not.toContain('Waiting for');
    // It must also say the client is not at fault, since this is desk-wide.
    expect(html).toContain('Nothing is wrong on this client');
  });
});

describe('a version the VPS has not reported is not version zero', () => {
  // The reachable state, not a hypothetical: pair_ingest_device_v2 inserts
  // agent_version and addon_version only (step_28_auto_collection.sql:1080-1099)
  // and never touches ninjatrader_version, which is written exclusively by
  // record_ingest_heartbeat (line 1293). Every device therefore spends the whole
  // window between pairing and its first heartbeat with at least one null
  // version column, and ingest-status passes those through as null
  // (admin/ingest-status.js:68-70). That is precisely the state step 4 of this
  // card is about, so it is the state a CAM reads this line in.
  const pairedNoHeartbeat = {
    ...base,
    device: {
      id: 'd',
      status: 'active',
      healthStatus: 'pending',
      lastSeenAt: '2026-07-23T16:44:00.000Z',
      agentVersion: '1.4.2',
      addonVersion: null,
      ninjaTraderVersion: null,
      schedule: { time: '16:30:00', timezone: 'America/New_York' },
    },
  };

  it('renders the placeholder rather than a number nobody sent', () => {
    const html = render(pairedNoHeartbeat);
    // "Add-on 0 · NinjaTrader 0" reads as a real build number — and 0 is a
    // plausible one — so it would send a CAM chasing a broken install on a VPS
    // that has simply not filed its first heartbeat yet.
    expect(html).toContain('Agent 1.4.2 · Add-on — · NinjaTrader —');
    expect(html).not.toContain('Add-on 0');
    expect(html).not.toContain('NinjaTrader 0');
  });

  it('still prints the versions that did arrive', () => {
    const html = render({
      ...pairedNoHeartbeat,
      device: { ...pairedNoHeartbeat.device, addonVersion: '1.1.0' },
    });
    expect(html).toContain('Agent 1.4.2 · Add-on 1.1.0 · NinjaTrader —');
  });
});
