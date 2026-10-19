using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Updates;

namespace Vincere.AutoExport.Agent.Service;

/* "UPDATE THE AGENT FROM THE CRM", THE MACHINE'S HALF.
 *
 * Every five minutes a paired machine tells the CRM where it is with its update
 * and hears whether a Manager has asked for a newer agent. When one has:
 *
 *   1. the directive is checked (newer than this build, and naming only this
 *      repository's release for that version, pinned by digest);
 *   2. the release manifest is fetched and checked against that digest;
 *   3. the package is downloaded, hashed and extracted under ProgramData;
 *   4. it waits, as "staged", until it is outside 15:45 to 17:45 New York on a
 *      weekday and nothing is uploading;
 *   5. it tells the CRM "applying" and hands the package to a SYSTEM scheduled
 *      task running update-agent.ps1, which stops this service, backs up the
 *      install, installs with -SkipAddOn and puts everything back if the new
 *      agent does not come up as the version it should be.
 *
 * NINJATRADER IS NEVER TOUCHED. The install runs with -SkipAddOn, which leaves
 * NinjaTrader, its AddOn, its Documents folder and the client's strategies
 * exactly as they are, and does not need NinjaTrader closed. A release that needs
 * a newer AddOn says so with minimumAddonVersion, and this machine then refuses
 * the update rather than run an agent its AddOn cannot talk to.
 *
 * BOUNDED. Three attempts per press of the button: a failed download, a refused
 * package, or a started install each spends one, and a failure that would repeat
 * exactly (a malformed release, a binary of the wrong version, an AddOn too old)
 * spends all three. A new press is a new budget.
 * After an install is started nothing else happens for 45 minutes, which is more
 * than the task's own 30-minute limit, so a second attempt can never overlap the
 * first or delete the folder it is running from.
 *
 * NEVER THROWS for an ordinary failure. Every outcome is a state the next poll
 * reports and, when it changes, one line in this machine's log. Nothing logged
 * here carries client data: versions and codes only. */
public sealed class AgentUpdateLoop : ICollectorLoop
{
    public const int MaximumAttempts = 3;
    public static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(5);

    /// <summary>How long a started install is given before it counts as failed, and before anything else is tried.</summary>
    public static readonly TimeSpan ApplyTimeout = TimeSpan.FromMinutes(45);

    /// <summary>A CRM without the route is asked again after this, not every five minutes.</summary>
    public static readonly TimeSpan UnsupportedBackoff = TimeSpan.FromHours(1);

    /* FAILURES THAT WOULD REPEAT EXACTLY ARE NOT RETRIED. The same release gives
     * the same manifest, the same package and the same binary, so trying again
     * only stops the service again. They spend the whole budget at once; pressing
     * Update again (after fixing the release or the AddOn) starts a new one. */
    private static readonly HashSet<string> FinalCodes = new(StringComparer.Ordinal)
    {
        UpdateErrorCodes.ManifestInvalid,
        UpdateErrorCodes.PackageInvalid,
        UpdateErrorCodes.VersionMismatch,
        UpdateErrorCodes.AddonUpdateRequired,
    };

    // update-agent.ps1 and this service read the same clock, so this only covers
    // the few seconds between taking the time and saving it.
    private static readonly TimeSpan ResultClockSkew = TimeSpan.FromMinutes(2);

    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly ICollectorQueue queue;
    private readonly CollectorState collectorState;
    private readonly UpdateStateStore stateStore;
    private readonly ReleaseManifestReader manifestReader;
    private readonly UpdatePackageStager stager;
    private readonly UpdateApplyWindow applyWindow;
    private readonly IUpdateTaskScheduler scheduler;
    private readonly UpdateLayout layout;
    private readonly ICollectorClock clock;
    private readonly string agentVersion;
    private readonly Version runningVersion;
    private readonly IServiceReporter reporter;
    private readonly IRedactingLogger logger;

    private DateTimeOffset? unsupportedUntil;
    private bool unsupportedLogged;
    private string lastReportedCode;

    /* No optional parameters, on purpose. A loop that took its scheduler or its
     * logger as an optional last argument could be registered without it and
     * still compile, which is exactly how the report-email loop once shipped
     * mailing nothing. */
    public AgentUpdateLoop(
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        ICollectorQueue queue,
        CollectorState collectorState,
        UpdateStateStore stateStore,
        ReleaseManifestReader manifestReader,
        UpdatePackageStager stager,
        UpdateApplyWindow applyWindow,
        IUpdateTaskScheduler scheduler,
        UpdateLayout layout,
        ICollectorClock clock,
        string agentVersion,
        IServiceReporter reporter,
        IRedactingLogger logger)
    {
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.collectorState = collectorState ?? throw new ArgumentNullException(nameof(collectorState));
        this.stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        this.manifestReader = manifestReader ?? throw new ArgumentNullException(nameof(manifestReader));
        this.stager = stager ?? throw new ArgumentNullException(nameof(stager));
        this.applyWindow = applyWindow ?? throw new ArgumentNullException(nameof(applyWindow));
        this.scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        this.layout = layout ?? throw new ArgumentNullException(nameof(layout));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        if (!UpdateVersion.TryParseLoose(agentVersion, out runningVersion))
            throw new ArgumentException("The running agent version must be numeric.", nameof(agentVersion));
        this.agentVersion = agentVersion.Trim();
        this.reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string Name => "agent-update";
    public TimeSpan Interval => PollInterval;

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        // The same test the heartbeat makes: an unpaired machine has nobody to ask.
        if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
            return;
        DateTimeOffset now = clock.GetCurrentDateTimeOffset();
        if (unsupportedUntil is DateTimeOffset until && now < until) return;
        try
        {
            await RunPassAsync(now, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            ReportChange("agent_update_failed", exception);
        }
    }

    private async Task RunPassAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        AgentUpdateState loaded = stateStore.Load();
        AgentUpdateState state = Reconcile(loaded, now);
        if (state != loaded) stateStore.Save(state);

        AgentUpdatePollResult poll = await crm.PollAgentUpdateAsync(Report(state), cancellationToken)
            .ConfigureAwait(false);
        if (poll.Status == AgentUpdatePollStatus.Unsupported)
        {
            unsupportedUntil = now + UnsupportedBackoff;
            if (!unsupportedLogged)
            {
                unsupportedLogged = true;
                logger.Write(
                    "INFO",
                    "agent_update_unsupported",
                    "The CRM does not offer agent updates yet. It will be asked again in an hour.");
            }
            return;
        }
        if (poll.Status == AgentUpdatePollStatus.Failed)
        {
            // Including a 401: the heartbeat owns unpairing, never this loop.
            ReportChange(poll.Code ?? "agent_update_failed", null);
            return;
        }
        unsupportedUntil = null;
        unsupportedLogged = false;

        AgentUpdateState next = await ActAsync(state, poll.Update, cancellationToken).ConfigureAwait(false);
        if (next != state) stateStore.Save(next);
        // What the pass ended as, written once per change: a failure that stands
        // for an hour is one line, not twelve.
        ReportChange(next.State == AgentUpdateStates.Failed ? next.ErrorCode : null, null);
    }

    /* WHAT BECAME OF THE LAST INSTALL, read on every pass while one is in flight.
     *
     * A success is this build being the target, confirmed by update-agent.ps1's
     * "installed", or by the timeout passing without it. The new agent starts
     * while the script is still checking it, so until then it keeps reporting
     * "applying" rather than declaring victory a minute before a rollback. */
    private AgentUpdateState Reconcile(AgentUpdateState state, DateTimeOffset now)
    {
        if (state.State != AgentUpdateStates.Applying
            || !UpdateVersion.TryParseTriple(state.TargetVersion, out Version target))
            return state;

        AgentUpdateLastResult result = stateStore.ReadLastResult();
        bool relevant = result != null
            && string.Equals(result.Version, state.TargetVersion, StringComparison.Ordinal)
            && (state.ApplyStartedAt is not DateTimeOffset launched || result.At >= launched - ResultClockSkew);
        bool timedOut = state.ApplyStartedAt is not DateTimeOffset started || now - started > ApplyTimeout;

        if (relevant && result.Outcome == AgentUpdateLastResult.RolledBack)
        {
            logger.Write(
                "WARN",
                "agent_update_rolled_back",
                $"The update to {state.TargetVersion} was rolled back ({result.ErrorCode}). Agent {agentVersion} is running.");
            return Final(state with { State = AgentUpdateStates.Failed, ErrorCode = result.ErrorCode });
        }

        if (UpdateVersion.Compare(runningVersion, target) >= 0)
        {
            if ((relevant && result.Outcome == AgentUpdateLastResult.Installed) || timedOut)
            {
                logger.Write("INFO", "agent_update_installed", $"Agent {agentVersion} is installed and running.");
                // The package has done its job and is a few hundred megabytes of a
                // trading machine's disk. The script has finished with it: it wrote
                // "installed" last, or the task's own time limit is long past. The
                // rollback copy stays, for the next update to replace.
                stager.CleanOtherVersions(keepVersion: null);
                return state.WithoutReport().WithoutStagedPackage();
            }
            return state;
        }

        // The script says it installed the target and the service that came back
        // says otherwise: the release's binary does not carry the version it was
        // published as. Retrying would install the same binary again.
        if (relevant && result.Outcome == AgentUpdateLastResult.Installed)
            return Final(state with { State = AgentUpdateStates.Failed, ErrorCode = UpdateErrorCodes.VersionMismatch });
        if (timedOut)
            return state with { State = AgentUpdateStates.Failed, ErrorCode = UpdateErrorCodes.ApplyTimeout };
        return state;
    }

    private async Task<AgentUpdateState> ActAsync(
        AgentUpdateState state,
        AgentUpdateDirective directive,
        CancellationToken cancellationToken)
    {
        // An install in flight is left alone whatever the CRM says now.
        if (state.State == AgentUpdateStates.Applying) return state;

        // Nothing asked, or asked and withdrawn. What is on disk stays until the
        // next update replaces it.
        if (directive == null) return state.State == null ? state : state.WithoutReport();

        UpdateDirectiveValidation validation = UpdateDirectiveValidator.Validate(directive, agentVersion);
        if (!validation.IsValid)
        {
            // Asked for the version already running: done, and nothing to report.
            if (validation.ErrorCode == UpdateErrorCodes.VersionNotNewer && IsRunningVersion(directive.Version))
                return state.State == null ? state : state.WithoutReport();
            return state with
            {
                State = AgentUpdateStates.Failed,
                ErrorCode = validation.ErrorCode,
                TargetVersion = validation.Version,
            };
        }
        string version = validation.Version;

        // A new press of the button, or a different version: a fresh budget. A
        // package already verified for the same version is kept.
        if (!string.Equals(state.BudgetVersion, version, StringComparison.Ordinal)
            || !string.Equals(state.BudgetRequestedAt, validation.RequestedAt, StringComparison.Ordinal))
        {
            bool sameVersion = string.Equals(state.BudgetVersion, version, StringComparison.Ordinal);
            state = AgentUpdateState.Empty with
            {
                BudgetVersion = version,
                BudgetRequestedAt = validation.RequestedAt,
                ApplyStartedAt = state.ApplyStartedAt,
                StagedSha256 = sameVersion ? state.StagedSha256 : null,
                StagedSize = sameVersion ? state.StagedSize : null,
                MinimumAddonVersion = sameVersion ? state.MinimumAddonVersion : null,
            };
        }

        DateTimeOffset now = clock.GetCurrentDateTimeOffset();
        if (state.ApplyStartedAt is DateTimeOffset started && started <= now && now - started < ApplyTimeout)
            return state;

        if (state.Attempts >= MaximumAttempts)
        {
            return state with
            {
                State = AgentUpdateStates.Failed,
                ErrorCode = state.State == AgentUpdateStates.Failed && state.ErrorCode != null
                    ? state.ErrorCode
                    : UpdateErrorCodes.AttemptsExhausted,
                TargetVersion = version,
            };
        }

        bool staged = state.StagedSha256 != null && state.StagedSize is > 0 && stager.HasPackage(version);
        if (!staged)
        {
            ReleaseManifestResult manifest = await manifestReader
                .ReadAsync(version, validation.ManifestSha256, cancellationToken)
                .ConfigureAwait(false);
            if (!manifest.Ok) return Fail(state, version, manifest.ErrorCode);
            // Before a byte of the package is fetched: an agent the AddOn on this
            // machine cannot serve is not worth downloading.
            if (!AddonSatisfies(manifest.Manifest.MinimumAddonVersion))
                return Fail(state, version, UpdateErrorCodes.AddonUpdateRequired);

            state = state with { State = AgentUpdateStates.Downloading, ErrorCode = null, TargetVersion = version };
            stateStore.Save(state);
            UpdateStageResult stage = await stager
                .StageAsync(version, manifest.Manifest.Package, cancellationToken)
                .ConfigureAwait(false);
            if (!stage.Ok) return Fail(state, version, stage.ErrorCode);

            state = state with
            {
                State = AgentUpdateStates.Staged,
                StagedSha256 = manifest.Manifest.Package.Sha256,
                StagedSize = manifest.Manifest.Package.Size,
                MinimumAddonVersion = manifest.Manifest.MinimumAddonVersion,
            };
            stateStore.Save(state);
            logger.Write("INFO", "agent_update_staged", $"Agent {version} is downloaded and verified.");
        }
        else if (state.State != AgentUpdateStates.Staged)
        {
            state = state with { State = AgentUpdateStates.Staged, ErrorCode = null, TargetVersion = version };
        }

        // Read again: a download can take minutes, and the window is a matter of minutes.
        now = clock.GetCurrentDateTimeOffset();
        if (!applyWindow.IsApplyAllowed(now)) return state;
        QueueStatus queueStatus = await queue.GetStatusAsync(cancellationToken).ConfigureAwait(false);
        if (queueStatus.UploadingCount > 0) return state;
        if (!AddonSatisfies(state.MinimumAddonVersion))
            return Fail(state, version, UpdateErrorCodes.AddonUpdateRequired);

        UpdateStageResult prepared = await stager
            .PrepareForApplyAsync(version, state.StagedSha256, state.StagedSize ?? 0, cancellationToken)
            .ConfigureAwait(false);
        if (!prepared.Ok) return Fail(state, version, prepared.ErrorCode);

        string taskXml = layout.TaskXml(version);
        try
        {
            UpdateTaskXml.Write(taskXml, prepared.PackagePath, version);
        }
        catch (ArgumentException)
        {
            return Fail(state, version, UpdateErrorCodes.ScheduleFailed);
        }

        state = state with
        {
            Attempts = state.Attempts + 1,
            State = AgentUpdateStates.Applying,
            ErrorCode = null,
            TargetVersion = version,
            ApplyStartedAt = now,
        };
        stateStore.Save(state);
        logger.Write(
            "INFO",
            "agent_update_applying",
            $"Installing agent {version} (attempt {state.Attempts} of {MaximumAttempts}). This service will restart.");

        /* TOLD BEFORE, NOT AFTER: the task stops this service, so there is no
         * "after" in this process. Whatever the answer, the install goes ahead;
         * the next agent to start reports how it went. */
        try
        {
            await crm.PollAgentUpdateAsync(Report(state), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
        }

        string scheduleError = await scheduler.CreateAndRunAsync(taskXml, cancellationToken).ConfigureAwait(false);
        if (scheduleError != null)
            return state with { State = AgentUpdateStates.Failed, ErrorCode = scheduleError };
        return state;
    }

    private AgentUpdatePollRequest Report(AgentUpdateState state)
    {
        string reported = AgentUpdateStates.IsKnown(state.State) ? state.State : null;
        return new AgentUpdatePollRequest(
            agentVersion,
            reported,
            reported == AgentUpdateStates.Failed ? state.ErrorCode ?? UpdateErrorCodes.UpdateFailed : null,
            reported == null ? null : state.TargetVersion);
    }

    // One attempt spent, the package forgotten so the next attempt fetches it again.
    private static AgentUpdateState Fail(AgentUpdateState state, string version, string code)
    {
        return Final(state.WithoutStagedPackage() with
        {
            Attempts = state.Attempts + 1,
            State = AgentUpdateStates.Failed,
            ErrorCode = code,
            TargetVersion = version,
        });
    }

    private static AgentUpdateState Final(AgentUpdateState state)
        => FinalCodes.Contains(state.ErrorCode ?? string.Empty)
            ? state with { Attempts = Math.Max(state.Attempts, MaximumAttempts) }
            : state;

    /* The AddOn version this machine has SEEN, from the last capture that
     * reported one. Never seen is not good enough: a release that names a minimum
     * is a release that cannot be assumed to work with whatever is there. */
    private bool AddonSatisfies(string minimumAddonVersion)
    {
        if (minimumAddonVersion == null) return true;
        string observed = collectorState.Snapshot().AddonVersion;
        return UpdateVersion.TryParseLoose(observed, out Version addon)
            && UpdateVersion.TryParseTriple(minimumAddonVersion, out Version required)
            && UpdateVersion.Compare(addon, required) >= 0;
    }

    private bool IsRunningVersion(string version)
        => UpdateVersion.TryParseTriple(version, out Version requested)
            && UpdateVersion.Compare(requested, runningVersion) == 0;

    // The rule every loop here follows: the first occurrence and every change,
    // never the repeats, and a success clears it so a returning fault is written.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter.LoopFailed(Name, code, exception);
    }
}
