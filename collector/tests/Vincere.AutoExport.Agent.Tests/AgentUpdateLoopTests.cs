using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Agent.Updates;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE LOOP, END TO END, WITH THE NETWORK, THE DISK AND TASK SCHEDULER FAKED.
 *
 * Real stager, real manifest reader, real state file in a temp folder, real New
 * York window. What is faked is what would leave the test: the CRM, GitHub and
 * schtasks.exe. */
public sealed class AgentUpdateLoopTests : IDisposable
{
    // Tuesday 20 October 2026. New York is on daylight time, UTC-4.
    private static readonly DateTimeOffset Midday = new(2026, 10, 20, 16, 0, 0, TimeSpan.Zero);   // 12:00 NY
    private static readonly DateTimeOffset AtTheClose = new(2026, 10, 20, 20, 30, 0, TimeSpan.Zero); // 16:30 NY
    private const string Target = "1.3.1";
    private const string Pressed = "2026-10-20T15:55:00.000Z";

    private readonly Harness h = new();

    public void Dispose() => h.Dispose();

    [Fact]
    public async Task An_unpaired_machine_asks_nothing_and_writes_nothing()
    {
        h.Token.Value = null;
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(h.Crm.Polls);
        Assert.Empty(h.Downloader.Requests);
        Assert.Empty(h.Scheduler.Calls);
        Assert.False(Directory.Exists(h.Layout.Root));
    }

    [Fact]
    public async Task With_nothing_asked_it_reports_nothing_in_progress_and_does_nothing()
    {
        await h.Loop.RunOnceAsync(CancellationToken.None);

        AgentUpdatePollRequest poll = Assert.Single(h.Crm.Polls);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", null, null, null), poll);
        Assert.Empty(h.Downloader.Requests);
        Assert.Empty(h.Scheduler.Calls);
    }

    [Fact]
    public async Task Outside_the_window_it_downloads_verifies_and_hands_over_to_the_task()
    {
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        string xml = Assert.Single(h.Scheduler.Calls);
        Assert.Equal(h.Layout.TaskXml(Target), xml);
        Assert.True(File.Exists(xml));
        Assert.Contains("update-agent.ps1", File.ReadAllText(xml));
        AgentUpdateState state = h.State;
        Assert.Equal(AgentUpdateStates.Applying, state.State);
        Assert.Equal(Target, state.TargetVersion);
        Assert.Equal(1, state.Attempts);
        Assert.Equal(Midday, state.ApplyStartedAt);
        Assert.True(File.Exists(Path.Combine(h.Layout.PackageDirectory(Target), "update-agent.ps1")));
    }

    [Fact]
    public async Task It_tells_the_crm_it_is_applying_before_it_starts_the_task_that_stops_it()
    {
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "poll:null", "poll:applying", "schedule" }, h.Events);
        AgentUpdatePollRequest applying = h.Crm.Polls[1];
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "applying", null, Target), applying);
    }

    [Fact]
    public async Task During_the_close_it_stages_and_waits_and_applies_once_the_window_ends()
    {
        h.Clock.Now = AtTheClose;
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(h.Scheduler.Calls);
        Assert.Equal(AgentUpdateStates.Staged, h.State.State);
        Assert.Equal(0, h.State.Attempts);

        h.Clock.Now = AtTheClose.AddMinutes(5);
        await h.Loop.RunOnceAsync(CancellationToken.None);
        // Reported on the next poll, still waiting, nothing fetched again.
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "staged", null, Target), h.Crm.Polls[1]);
        Assert.Empty(h.Scheduler.Calls);

        h.Clock.Now = new DateTimeOffset(2026, 10, 20, 21, 50, 0, TimeSpan.Zero); // 17:50 NY
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(h.Scheduler.Calls);
        Assert.Equal(1, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
        Assert.Equal(1, h.Downloader.RequestsFor(UpdateDirectiveValidator.ManifestUrlFor(Target)));
    }

    [Fact]
    public async Task It_waits_while_a_snapshot_is_uploading()
    {
        h.Queue.Uploading = 1;
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(h.Scheduler.Calls);
        Assert.Equal(AgentUpdateStates.Staged, h.State.State);

        h.Queue.Uploading = 0;
        h.Clock.Now = Midday.AddMinutes(5);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(h.Scheduler.Calls);
    }

    [Fact]
    public async Task A_directive_naming_another_address_is_reported_failed_and_nothing_is_fetched()
    {
        h.Crm.Directive = h.Publish() with
        {
            ManifestUrl = "https://evil.example/agent-v1.3.1/release-manifest.json",
        };

        await h.Loop.RunOnceAsync(CancellationToken.None);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(h.Downloader.Requests);
        Assert.Empty(h.Scheduler.Calls);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "url_not_allowed", Target), h.Crm.Polls[1]);
        // Refusing a directive costs nothing from the budget.
        Assert.Equal(0, h.State.Attempts);
        // Logged once, not on every pass.
        Assert.Equal(new[] { "url_not_allowed" }, h.Reporter.Codes);
    }

    [Fact]
    public async Task A_downgrade_is_refused()
    {
        h.Crm.Directive = h.Publish("1.2.9");

        await h.Loop.RunOnceAsync(CancellationToken.None);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "version_not_newer", "1.2.9"), h.Crm.Polls[1]);
        Assert.Empty(h.Downloader.Requests);
    }

    [Fact]
    public async Task A_directive_for_the_version_already_running_is_simply_done()
    {
        h.Crm.Directive = h.Publish("1.3.0");

        await h.Loop.RunOnceAsync(CancellationToken.None);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.All(h.Crm.Polls, poll => Assert.Null(poll.State));
        Assert.Empty(h.Downloader.Requests);
        Assert.Empty(h.Reporter.Codes);
    }

    [Fact]
    public async Task Three_failed_attempts_and_it_stops_until_the_button_is_pressed_again()
    {
        AgentUpdateDirective directive = h.Publish();
        h.Downloader.Responses[UpdateDirectiveValidator.PackageUrlFor(Target)] = new byte[] { 1, 2, 3 };
        h.Crm.Directive = directive;

        for (int pass = 0; pass < 5; pass++)
        {
            h.Clock.Now = Midday.AddMinutes(5 * pass);
            await h.Loop.RunOnceAsync(CancellationToken.None);
        }

        Assert.Equal(3, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
        Assert.Equal(3, h.State.Attempts);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "package_hash_mismatch", Target), h.Crm.Polls[^1]);
        Assert.Empty(h.Scheduler.Calls);

        // Pressed again: a new requestedAt is a new budget.
        h.Crm.Directive = directive with { RequestedAt = "2026-10-20T16:30:00.000Z" };
        h.Clock.Now = Midday.AddMinutes(30);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(4, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
        Assert.Equal(1, h.State.Attempts);
    }

    [Fact]
    public async Task An_unreachable_manifest_spends_an_attempt_and_is_reported()
    {
        AgentUpdateDirective directive = h.Publish();
        h.Downloader.Failures[UpdateDirectiveValidator.ManifestUrlFor(Target)] = UpdateDownloadFailure.Unreachable;
        h.Crm.Directive = directive;

        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.Clock.Now = Midday.AddMinutes(5);
        h.Downloader.Failures.Clear();
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "manifest_unreachable", Target), h.Crm.Polls[1]);
        // The second pass found it and went ahead, on attempt two.
        Assert.Single(h.Scheduler.Calls);
        Assert.Equal(2, h.State.Attempts);
    }

    [Fact]
    public async Task Not_enough_disk_is_reported_and_nothing_is_downloaded()
    {
        h.Disk.FreeBytes = 1024;
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.DiskSpace, h.State.ErrorCode);
        Assert.Equal(0, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
    }

    [Fact]
    public async Task A_failed_schedule_is_reported_and_counted()
    {
        h.Scheduler.Error = UpdateErrorCodes.ScheduleFailed;
        h.Crm.Directive = h.Publish();

        await h.Loop.RunOnceAsync(CancellationToken.None);

        AgentUpdateState state = h.State;
        Assert.Equal(AgentUpdateStates.Failed, state.State);
        Assert.Equal(UpdateErrorCodes.ScheduleFailed, state.ErrorCode);
        Assert.Equal(1, state.Attempts);

        h.Clock.Now = Midday.AddMinutes(5);
        await h.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "schedule_failed", Target), h.Crm.Polls[^1]);
    }

    [Fact]
    public async Task A_rolled_back_install_is_reported_with_its_code_and_retried_only_after_the_cooldown()
    {
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Single(h.Scheduler.Calls);

        // update-agent.ps1 put 1.3.0 back. The service restarted as 1.3.0.
        h.WriteLastResult(Target, "rolled_back", "service_not_running", Midday.AddMinutes(3));
        AgentUpdateLoop restarted = h.Build("1.3.0");
        h.Clock.Now = Midday.AddMinutes(4);
        await restarted.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "service_not_running", Target), h.Crm.Polls[^1]);
        Assert.Single(h.Scheduler.Calls);

        // Not again while a task from the last attempt could still be running.
        h.Clock.Now = Midday.AddMinutes(30);
        await restarted.RunOnceAsync(CancellationToken.None);
        Assert.Single(h.Scheduler.Calls);

        h.Clock.Now = Midday.AddMinutes(50);
        await restarted.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, h.Scheduler.Calls.Count);
        Assert.Equal(2, h.State.Attempts);
        // The verified package was kept: the retry did not fetch it again.
        Assert.Equal(1, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
    }

    [Fact]
    public async Task A_result_from_an_earlier_attempt_is_not_read_as_this_one()
    {
        h.Crm.Directive = h.Publish();
        h.WriteLastResult(Target, "rolled_back", "install_failed", Midday.AddHours(-3));
        await h.Loop.RunOnceAsync(CancellationToken.None);

        AgentUpdateLoop restarted = h.Build("1.3.0");
        h.Clock.Now = Midday.AddMinutes(4);
        await restarted.RunOnceAsync(CancellationToken.None);

        Assert.Equal(AgentUpdateStates.Applying, h.Crm.Polls[^1].State);
    }

    [Fact]
    public async Task The_new_agent_reports_applying_until_the_script_confirms_then_nothing()
    {
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);

        // The service came back as 1.3.1 while update-agent.ps1 is still checking it.
        AgentUpdateLoop upgraded = h.Build(Target);
        h.Crm.Directive = null;
        h.Clock.Now = Midday.AddMinutes(2);
        await upgraded.RunOnceAsync(CancellationToken.None);
        Assert.Equal(new AgentUpdatePollRequest(Target, "applying", null, Target), h.Crm.Polls[^1]);

        h.WriteLastResult(Target, "installed", null, Midday.AddMinutes(3));
        h.Clock.Now = Midday.AddMinutes(7);
        await upgraded.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest(Target, null, null, null), h.Crm.Polls[^1]);
        Assert.Null(h.State.State);
        Assert.Contains(h.Logger.Lines, line => line.Code == "agent_update_installed");
        // The package is gone from the disk; the rollback copy and the record stay.
        Assert.False(Directory.Exists(h.Layout.VersionDirectory(Target)));
        Assert.True(File.Exists(h.Layout.LastResultFile));
        Assert.True(File.Exists(h.Layout.StateFile));
    }

    [Fact]
    public async Task An_install_that_never_reports_back_times_out()
    {
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);

        h.Clock.Now = Midday.AddMinutes(46);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        // The pass's first poll says so. The budget then allows a second attempt
        // in the same pass, which is the "applying" poll after it.
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "apply_timeout", Target), h.Crm.Polls[2]);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "applying", null, Target), h.Crm.Polls[3]);
        Assert.Equal(2, h.State.Attempts);
    }

    [Fact]
    public async Task An_install_the_script_called_good_that_left_the_old_version_running_is_a_version_mismatch()
    {
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.WriteLastResult(Target, "installed", null, Midday.AddMinutes(3));

        h.Clock.Now = Midday.AddMinutes(5);
        await h.Build("1.3.0").RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "version_mismatch", Target), h.Crm.Polls[^1]);
    }

    [Fact]
    public async Task A_release_that_needs_a_newer_addon_than_this_machine_has_seen_is_refused_before_downloading()
    {
        h.Collector.RecordEnvironment("8.1.6.0", "1.2.9");
        h.Crm.Directive = h.Publish(minimumAddonVersion: "1.3.0");

        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.Clock.Now = Midday.AddMinutes(5);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "addon_update_required", Target), h.Crm.Polls[^1]);
        Assert.Equal(0, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
        Assert.Empty(h.Scheduler.Calls);
        // Final for this press: the manifest is not fetched again every five minutes.
        Assert.Equal(1, h.Downloader.RequestsFor(UpdateDirectiveValidator.ManifestUrlFor(Target)));
    }

    [Fact]
    public async Task A_package_that_is_not_installable_is_not_downloaded_again_for_the_same_press()
    {
        AgentUpdateDirective directive = h.Publish();
        byte[] broken = UpdateFixtures.Zip(("readme.txt", "no agent in here"));
        h.Downloader.Responses[UpdateDirectiveValidator.PackageUrlFor(Target)] = broken;
        h.Downloader.Responses[UpdateDirectiveValidator.ManifestUrlFor(Target)] =
            UpdateFixtures.Bytes(UpdateFixtures.Manifest(Target, broken));
        h.Crm.Directive = directive with
        {
            ManifestSha256 = UpdateFixtures.Sha256(h.Downloader.Responses[UpdateDirectiveValidator.ManifestUrlFor(Target)]),
        };

        for (int pass = 0; pass < 3; pass++)
        {
            h.Clock.Now = Midday.AddMinutes(5 * pass);
            await h.Loop.RunOnceAsync(CancellationToken.None);
        }

        Assert.Equal(1, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "package_invalid", Target), h.Crm.Polls[^1]);
    }

    [Fact]
    public async Task A_rollback_for_a_binary_of_the_wrong_version_is_not_retried()
    {
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.WriteLastResult(Target, "rolled_back", "version_mismatch", Midday.AddMinutes(3));

        AgentUpdateLoop restarted = h.Build("1.3.0");
        foreach (int minutes in new[] { 5, 50, 100 })
        {
            h.Clock.Now = Midday.AddMinutes(minutes);
            await restarted.RunOnceAsync(CancellationToken.None);
        }

        Assert.Single(h.Scheduler.Calls);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", "failed", "version_mismatch", Target), h.Crm.Polls[^1]);
    }

    [Fact]
    public async Task An_addon_never_seen_is_not_assumed_to_be_new_enough()
    {
        h.Crm.Directive = h.Publish(minimumAddonVersion: "1.3.0");

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.AddonUpdateRequired, h.State.ErrorCode);
        Assert.Equal(0, h.Downloader.RequestsFor(UpdateDirectiveValidator.PackageUrlFor(Target)));
    }

    [Theory]
    [InlineData("1.3.0")]
    [InlineData("1.3.0.0")]
    [InlineData("1.4.2")]
    public async Task An_addon_at_or_above_the_minimum_lets_the_update_through(string addon)
    {
        h.Collector.RecordEnvironment("8.1.6.0", addon);
        h.Crm.Directive = h.Publish(minimumAddonVersion: "1.3.0");

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(h.Scheduler.Calls);
    }

    [Fact]
    public async Task An_older_crm_is_asked_again_in_an_hour_not_every_five_minutes()
    {
        h.Crm.Answer = AgentUpdatePollResult.Unsupported;

        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.Clock.Now = Midday.AddMinutes(30);
        await h.Loop.RunOnceAsync(CancellationToken.None);
        h.Clock.Now = Midday.AddMinutes(61);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, h.Crm.Polls.Count);
        Assert.Empty(h.Reporter.Codes);
        Assert.Single(h.Logger.Lines, line => line.Code == "agent_update_unsupported");
    }

    [Fact]
    public async Task A_revoked_credential_is_left_to_the_heartbeat()
    {
        h.Crm.Answer = () => AgentUpdatePollResult.Failed("device_credential_revoked", CrmFailureDisposition.RePair);

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.False(h.Token.Deleted);
        Assert.Equal(new[] { "device_credential_revoked" }, h.Reporter.Codes);
    }

    [Fact]
    public async Task A_withdrawn_request_clears_what_is_reported()
    {
        h.Clock.Now = AtTheClose;
        h.Crm.Directive = h.Publish();
        await h.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(AgentUpdateStates.Staged, h.State.State);

        h.Crm.Directive = null;
        await h.Loop.RunOnceAsync(CancellationToken.None);
        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Null(h.State.State);
        Assert.Equal(new AgentUpdatePollRequest("1.3.0", null, null, null), h.Crm.Polls[^1]);
        Assert.Empty(h.Scheduler.Calls);
    }

    [Fact]
    public async Task An_unexpected_fault_is_logged_and_never_thrown()
    {
        h.Crm.Answer = () => throw new InvalidOperationException("boom");

        await h.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "agent_update_failed" }, h.Reporter.Codes);
    }

    [Fact]
    public void Its_name_and_interval_are_what_the_supervisor_expects()
    {
        Assert.Equal("agent-update", h.Loop.Name);
        Assert.Equal(TimeSpan.FromMinutes(5), h.Loop.Interval);
    }

    private sealed class Harness : IDisposable
    {
        private readonly UpdateTempDirectory temp = new();

        public Harness()
        {
            Layout = new UpdateLayout(Path.Combine(temp.Path, "updates"));
            Clock = new FakeClock { Now = Midday };
            Crm = new FakeUpdateCrm(Events);
            Scheduler = new RecordingScheduler(Events);
            Loop = Build("1.3.0");
        }

        public List<string> Events { get; } = new();
        public UpdateLayout Layout { get; }
        public FakeUpdateDownloader Downloader { get; } = new();
        public FixedUpdateDisk Disk { get; } = new();
        public RecordingDirectorySecurity Security { get; } = new();
        public FakeUpdateCrm Crm { get; }
        public FakeTokenStore Token { get; } = new() { Value = "token" };
        public FakeQueue Queue { get; } = new();
        public CollectorState Collector { get; } = new();
        public FakeClock Clock { get; }
        public RecordingScheduler Scheduler { get; }
        public RecordingReporter Reporter { get; } = new();
        public RecordingLogger Logger { get; } = new();
        public AgentUpdateLoop Loop { get; }

        public AgentUpdateState State => new UpdateStateStore(Layout).Load();

        /// <summary>A loop as a restarted service would build it, over the same disk.</summary>
        public AgentUpdateLoop Build(string runningVersion) => new(
            Crm,
            Token,
            Queue,
            Collector,
            new UpdateStateStore(Layout),
            new ReleaseManifestReader(Downloader),
            new UpdatePackageStager(Layout, Downloader, Disk, Security),
            new UpdateApplyWindow(),
            Scheduler,
            Layout,
            Clock,
            runningVersion,
            Reporter,
            Logger);

        /// <summary>Puts a release on the fake GitHub and returns the directive the CRM would send for it.</summary>
        public AgentUpdateDirective Publish(string version = Target, string minimumAddonVersion = null)
        {
            byte[] package = UpdateFixtures.Package();
            Downloader.Responses[UpdateDirectiveValidator.PackageUrlFor(version)] = package;
            byte[] manifest = UpdateFixtures.Bytes(UpdateFixtures.Manifest(version, package, minimumAddonVersion));
            Downloader.Responses[UpdateDirectiveValidator.ManifestUrlFor(version)] = manifest;
            return new AgentUpdateDirective(
                version,
                UpdateDirectiveValidator.ManifestUrlFor(version),
                UpdateFixtures.Sha256(manifest),
                Pressed);
        }

        public void WriteLastResult(string version, string outcome, string code, DateTimeOffset at)
        {
            Directory.CreateDirectory(Layout.Root);
            string codeJson = code == null ? "null" : "\"" + code + "\"";
            File.WriteAllText(
                Layout.LastResultFile,
                "{\"version\":\"" + version + "\",\"outcome\":\"" + outcome + "\",\"errorCode\":" + codeJson
                + ",\"at\":\"" + at.UtcDateTime.ToString("o") + "\"}");
        }

        public void Dispose() => temp.Dispose();
    }

    private sealed class FakeUpdateCrm : ICollectorCrmClient
    {
        private readonly List<string> events;

        public FakeUpdateCrm(List<string> events) => this.events = events;

        public List<AgentUpdatePollRequest> Polls { get; } = new();
        public Func<AgentUpdatePollResult> Answer { get; set; } = () => AgentUpdatePollResult.Accepted(null);

        public AgentUpdateDirective Directive
        {
            set => Answer = () => AgentUpdatePollResult.Accepted(value);
        }

        public Task<AgentUpdatePollResult> PollAgentUpdateAsync(AgentUpdatePollRequest request, CancellationToken cancellationToken = default)
        {
            Polls.Add(request);
            events.Add("poll:" + (request.State ?? "null"));
            return Task.FromResult(Answer());
        }

        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class RecordingScheduler : IUpdateTaskScheduler
    {
        private readonly List<string> events;

        public RecordingScheduler(List<string> events) => this.events = events;

        public List<string> Calls { get; } = new();
        public string Error { get; set; }

        public Task<string> CreateAndRunAsync(string taskXmlPath, CancellationToken cancellationToken)
        {
            events.Add("schedule");
            Calls.Add(taskXmlPath);
            return Task.FromResult(Error);
        }
    }

    private sealed class FakeQueue : ICollectorQueue
    {
        public int Uploading { get; set; }

        public Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(new QueueStatus(0, Uploading, 0, 0, 0, false));

        public Task<QueueEnqueueResult> EnqueueAsync(AutoExportSnapshotV1 snapshot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> RetryAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> CompleteAsync(QueueItem item, string batchId, string hash, DateTimeOffset at, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> QuarantineAsync(QueueItem item, string code, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueCleanupResult> CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IReadOnlyList<QueueQuarantineEntry>> ListQuarantineAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueQuarantineReviewResult> ReviewQuarantineAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeTokenStore : IDeviceTokenStore
    {
        public string Value { get; set; }
        public bool Deleted { get; private set; }
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { Value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(Value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { Value = null; Deleted = true; return Task.CompletedTask; }
    }

    private sealed class FakeClock : ICollectorClock
    {
        public DateTimeOffset Now { get; set; }
        public Instant GetCurrentInstant() => Instant.FromDateTimeOffset(Now);
        public DateTimeOffset GetCurrentDateTimeOffset() => Now;
    }

    private sealed class RecordingReporter : IServiceReporter
    {
        public List<string> Codes { get; } = new();
        public void LoopFailed(string loopName, string errorCode, Exception exception = null) => Codes.Add(errorCode);
    }

    private sealed class RecordingLogger : IRedactingLogger
    {
        public List<(string Level, string Code)> Lines { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
            => Lines.Add((level, eventCode));
    }
}
