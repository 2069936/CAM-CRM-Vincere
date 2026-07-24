using System;
using System.IO;
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
        ControlCommandHandler handler = new(
            options,
            crm,
            new FakeScheduler(),
            new FakeClock(),
            token,
            new FakeQueue(),
            new CollectorState(),
            new FakeDiagnostics(directory),
            "1.2.3",
            "4.5.6");
        return new Harness(handler, options, token, crm);
    }

    private sealed record Harness(
        ControlCommandHandler Handler,
        ConfigurationStore Options,
        FakeTokenStore Token,
        FakeCrm Crm);

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
