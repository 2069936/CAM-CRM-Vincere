using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Control;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class ControlPipeServerTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vincere-control-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task MutatingCommandIsRejectedBeforePairingWhenCallerIsNotAdministrator()
    {
        Harness harness = CreateHarness();

        ControlCommandResponse response = await harness.Handler.HandleAsync(
            new ControlCommandRequest("pair", Guid.NewGuid(), EnrollmentCode: "ABCDEFGHJK"),
            isAdministrator: false);

        Assert.False(response.Ok);
        Assert.Equal("administrator_required", response.Code);
        Assert.Equal(0, harness.Crm.PairCalls);
        Assert.Null(await harness.Token.LoadTokenAsync());
    }

    [Fact]
    public async Task PairStoresOnlyReturnedClientBindingAndNeverReturnsDeviceToken()
    {
        Harness harness = CreateHarness();
        Guid requestId = Guid.NewGuid();

        ControlCommandResponse response = await harness.Handler.HandleAsync(
            new ControlCommandRequest("pair", requestId, EnrollmentCode: "ABCD-EFGH-JK"),
            isAdministrator: true);

        AgentOptions options = (await harness.Options.LoadAsync()).Options;
        Assert.True(response.Ok);
        Assert.Equal("paired", response.Code);
        Assert.Equal("client-name", options.ClientName);
        Assert.Equal("device-id", options.DeviceId);
        Assert.Equal("16:45", options.ScheduleTime);
        Assert.Equal("device-token", await harness.Token.LoadTokenAsync());
        Assert.DoesNotContain("device-token", JsonConvert.SerializeObject(response));
    }

    [Fact]
    public async Task ForgetDeviceRequiresConfirmationAndReturnsExplicitCrmOrphanWarning()
    {
        Harness harness = CreateHarness();
        await harness.Token.SaveTokenAsync("device-token");
        await harness.Options.SaveAsync(AgentOptions.CreateDefault() with
        {
            CrmBaseUrl = "https://crm.example.test/",
            DeviceId = "device-id",
            ClientName = "client-name",
        });

        ControlCommandResponse rejected = await harness.Handler.HandleAsync(
            new ControlCommandRequest("forgetDevice", Guid.NewGuid()),
            isAdministrator: true);
        ControlCommandResponse confirmed = await harness.Handler.HandleAsync(
            new ControlCommandRequest("forgetDevice", Guid.NewGuid(), Confirmed: true),
            isAdministrator: true);

        Assert.Equal("confirmation_required", rejected.Code);
        Assert.Equal("device_forgotten_with_orphan_warning", confirmed.Code);
        Assert.Contains("Revoke", confirmed.Message);
        Assert.Null(await harness.Token.LoadTokenAsync());
        Assert.Null((await harness.Options.LoadAsync()).Options.DeviceId);
    }

    [Fact]
    public async Task StatusIsReadOnlyAndAvailableWithoutMutationAuthorization()
    {
        Harness harness = CreateHarness();

        ControlCommandResponse response = await harness.Handler.HandleAsync(
            new ControlCommandRequest("status", Guid.NewGuid()),
            isAdministrator: false);

        Assert.True(response.Ok);
        ControlStatusData status = Assert.IsType<ControlStatusData>(response.Data);
        Assert.False(status.Paired);
        Assert.Equal(3, status.Queue.PendingCount);
    }

    /* THE QUARANTINE, ON THE SCREEN THAT CAN DO SOMETHING ABOUT IT.
     *
     * Status carries the folder's contents so the Setup window can list them
     * and say which will be retried; retryQuarantine runs the same review the
     * loop runs at midday and reports what moved. */

    private static readonly QueueQuarantineEntry Retryable = new(
        Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "2026-07-22",
        "snapshot_processing_failed",
        1,
        new DateTimeOffset(2026, 7, 22, 20, 46, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 7, 23, 16, 0, 0, TimeSpan.Zero),
        true);

    private static readonly QueueQuarantineEntry Final = new(
        Guid.Parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        "2026-07-21",
        "snapshot_rejected",
        0,
        new DateTimeOffset(2026, 7, 21, 20, 46, 0, TimeSpan.Zero),
        null,
        false);

    [Fact]
    public async Task StatusListsTheQuarantineNewestFirstWithTheReviewTime()
    {
        Harness harness = CreateHarness();
        harness.Queue.Quarantine.Add(Final);
        harness.Queue.Quarantine.Add(Retryable);

        ControlCommandResponse response = await harness.Handler.HandleAsync(
            new ControlCommandRequest("status", Guid.NewGuid()),
            isAdministrator: false);

        ControlStatusData status = Assert.IsType<ControlStatusData>(response.Data);
        Assert.Equal(2, status.Quarantine.Count);
        Assert.Equal("12:00", status.Quarantine.ReviewTime);
        Assert.Equal(new[] { "2026-07-22", "2026-07-21" }, status.Quarantine.Items.Select(item => item.TradingDate).ToArray());
        ControlQuarantineItem first = status.Quarantine.Items[0];
        Assert.Equal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", first.CaptureId);
        Assert.Equal("snapshot_processing_failed", first.Code);
        Assert.Equal(1, first.Attempts);
        Assert.True(first.WillRetry);
        Assert.False(status.Quarantine.Items[1].WillRetry);
        // The frame stays a frame: nothing from a payload rides along.
        Assert.DoesNotContain("Accounts", JsonConvert.SerializeObject(response));
    }

    [Fact]
    public async Task RetryQuarantineIsAnAdministratorCommandThatRunsTheReviewAndSaysWhatMoved()
    {
        Harness harness = CreateHarness();
        harness.Reviewer.Requeued.Add(Retryable);
        harness.Reviewer.Remaining.Add(Final);

        ControlCommandResponse refused = await harness.Handler.HandleAsync(
            new ControlCommandRequest("retryQuarantine", Guid.NewGuid()),
            isAdministrator: false);
        ControlCommandResponse reviewed = await harness.Handler.HandleAsync(
            new ControlCommandRequest("retryQuarantine", Guid.NewGuid()),
            isAdministrator: true);

        Assert.Equal("administrator_required", refused.Code);
        Assert.Equal(1, harness.Reviewer.Calls);
        Assert.True(reviewed.Ok);
        Assert.Equal("quarantine_reviewed", reviewed.Code);
        Assert.Contains("1 capture sent back for upload", reviewed.Message);
        Assert.Contains("1 capture that will not be retried", reviewed.Message);
        string data = JsonConvert.SerializeObject(reviewed.Data);
        Assert.Contains("\"requeued\":1", data);
        Assert.Contains("\"remaining\":1", data);
    }

    [Fact]
    public async Task AnEmptyQuarantineSaysSoRatherThanClaimingARetry()
    {
        Harness harness = CreateHarness();

        ControlCommandResponse reviewed = await harness.Handler.HandleAsync(
            new ControlCommandRequest("retryQuarantine", Guid.NewGuid()),
            isAdministrator: true);

        Assert.True(reviewed.Ok);
        Assert.Contains("nothing to retry", reviewed.Message);
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private Harness CreateHarness()
    {
        ConfigurationStore options = new(Path.Combine(directory, "config.json"), new TestDirectorySecurity());
        options.SaveAsync(AgentOptions.CreateDefault() with { CrmBaseUrl = "https://crm.example.test/" }).GetAwaiter().GetResult();
        FakeTokenStore token = new();
        FakeCrm crm = new(token);
        FakeQueue queue = new();
        FakeReviewer reviewer = new();
        ControlCommandHandler handler = new(
            options,
            crm,
            new FakeScheduler(),
            new FakeClock(),
            token,
            queue,
            new CollectorState(),
            new FakeDiagnostics(directory),
            new FakeCaptureHistory(),
            "1.2.3",
            "4.5.6",
            null,
            reviewer);
        return new Harness(handler, options, token, crm, queue, reviewer);
    }

    private sealed record Harness(
        ControlCommandHandler Handler,
        ConfigurationStore Options,
        FakeTokenStore Token,
        FakeCrm Crm,
        FakeQueue Queue,
        FakeReviewer Reviewer);

    private sealed class FakeReviewer : IQuarantineReviewer
    {
        public int Calls { get; private set; }
        public List<QueueQuarantineEntry> Requeued { get; } = new();
        public List<QueueQuarantineEntry> Remaining { get; } = new();

        public Task<QueueQuarantineReviewResult> ReviewNowAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            return Task.FromResult(new QueueQuarantineReviewResult(Requeued.ToList(), Remaining.ToList()));
        }
    }

    private sealed class FakeCrm : ICollectorCrmClient
    {
        private readonly FakeTokenStore token;
        public FakeCrm(FakeTokenStore token) => this.token = token;
        public int PairCalls { get; private set; }
        public async Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default)
        {
            PairCalls++;
            await token.SaveTokenAsync("device-token", cancellationToken);
            return new PairingResult("device-id", "client-name", "16:45", "America/New_York");
        }
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeScheduler : ICaptureScheduler
    {
        private static CaptureRunResult Result() => new(
            new CaptureScheduleDecision(CaptureScheduleDecisionKind.Due, "2026-07-23", null),
            true,
            null,
            null);
        public Task<CaptureRunResult> RunScheduledAsync(Instant now, CancellationToken cancellationToken = default) => Task.FromResult(Result());
        public Task<CaptureRunResult> RunManualAsync(Instant now, CancellationToken cancellationToken = default) => Task.FromResult(Result());
    }

    private sealed class FakeClock : ICollectorClock
    {
        private static readonly Instant Now = Instant.FromUtc(2026, 7, 23, 20, 45);
        public Instant GetCurrentInstant() => Now;
        public DateTimeOffset GetCurrentDateTimeOffset() => Now.ToDateTimeOffset();
    }

    private sealed class FakeQueue : ICollectorQueue
    {
        public Task<QueueEnqueueResult> EnqueueAsync(AutoExportSnapshotV1 snapshot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> RetryAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> CompleteAsync(QueueItem item, string batchId, string hash, DateTimeOffset at, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> QuarantineAsync(QueueItem item, string code, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new QueueStatus(3, 0, 1, 0, 512, false));
        public Task<QueueCleanupResult> CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IReadOnlyList<QueueQuarantineEntry>> ListQuarantineAsync(CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<QueueQuarantineEntry>>(Quarantine);
        public Task<QueueQuarantineReviewResult> ReviewQuarantineAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public List<QueueQuarantineEntry> Quarantine { get; } = new();
    }

    private sealed class FakeTokenStore : IDeviceTokenStore
    {
        private string token;
        public Task SaveTokenAsync(string value, CancellationToken cancellationToken = default) { token = value; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { token = null; return Task.CompletedTask; }
    }

    private sealed class FakeDiagnostics : IDiagnosticsCollector
    {
        private readonly string path;
        public FakeDiagnostics(string directory) => path = Path.Combine(directory, "diagnostics.zip");
        public Task<string> CollectAsync(CancellationToken cancellationToken = default) => Task.FromResult(path);
    }

    private sealed class TestDirectorySecurity : IAgentDirectorySecurity
    {
        public void EnsureProtected(string path) => Directory.CreateDirectory(path);
    }
}
