using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CollectorLoopTests
{
    private static readonly QueueItem Item = new(
        Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "2026-07-23",
        "capture.json",
        new string('a', 64),
        QueueState.Uploading);

    [Fact]
    public async Task UnpairedUploaderLeavesQueueUntouched()
    {
        FakeQueue queue = new() { Next = Item };
        FakeTokenStore token = new(null);
        UploadLoop loop = new(queue, new FakeCrm(), token, new CollectorState());

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, queue.Claims);
        Assert.Null(queue.Completed);
    }

    [Fact]
    public async Task PairedUploaderCompletesOnlyAfterCrmAcknowledgement()
    {
        FakeQueue queue = new() { Next = Item };
        FakeCrm crm = new();
        CollectorState state = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), state);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Same(Item, crm.Uploaded);
        Assert.Same(Item, queue.Completed);
        Assert.Equal("batch-id", queue.CompletedBatchId);
        Assert.NotNull(state.Snapshot().LastSuccessAt);
    }

    [Fact]
    public async Task OfflineUploadReturnsClaimToPendingForLaterRecovery()
    {
        FakeQueue queue = new() { Next = Item };
        FakeCrm crm = new()
        {
            UploadError = new CrmClientException(
                "upload_failed",
                "offline",
                true,
                disposition: CrmFailureDisposition.Retry),
        };
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState());

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Same(Item, queue.Retried);
        Assert.Null(queue.Completed);
    }

    [Fact]
    public async Task RevokedCredentialIsDeletedAndClaimIsReturnedToQueue()
    {
        FakeQueue queue = new() { Next = Item };
        FakeTokenStore token = new("token");
        FakeCrm crm = new()
        {
            UploadError = new CrmClientException(
                "device_credential_revoked",
                "revoked",
                false,
                disposition: CrmFailureDisposition.RePair),
        };
        UploadLoop loop = new(queue, crm, token, new CollectorState());

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.True(token.Deleted);
        Assert.Same(Item, queue.Retried);
    }

    [Fact]
    public async Task CaptureFailureIsIncludedInNextHeartbeatWithoutSnapshotData()
    {
        FakeScheduler scheduler = new()
        {
            Result = new CaptureRunResult(
                new CaptureScheduleDecision(CaptureScheduleDecisionKind.Due, "2026-07-23", null),
                false,
                "addon_unavailable",
                null),
        };
        CollectorState state = new();
        FakeClock clock = new(Instant.FromUtc(2026, 7, 23, 20, 45));
        await new ScheduledCaptureLoop(scheduler, clock, state).RunOnceAsync(CancellationToken.None);
        FakeCrm crm = new();
        FakeQueue queue = new();
        HeartbeatLoop heartbeat = new(
            queue,
            crm,
            new FakeTokenStore("token"),
            state,
            "1.2.3",
            "4.5.6",
            "8.1.5");

        await heartbeat.RunOnceAsync(CancellationToken.None);

        Assert.Equal("addon_unavailable", crm.Heartbeat.LastErrorCode);
        Assert.False(crm.Heartbeat.AddonAvailable);
        Assert.DoesNotContain("Accounts", crm.Heartbeat.LastErrorMessage ?? string.Empty);
    }

    private sealed class FakeClock : ICollectorClock
    {
        public FakeClock(Instant now) => Now = now;
        public Instant Now { get; }
        public Instant GetCurrentInstant() => Now;
        public DateTimeOffset GetCurrentDateTimeOffset() => Now.ToDateTimeOffset();
    }

    private sealed class FakeScheduler : ICaptureScheduler
    {
        public CaptureRunResult Result { get; init; }
        public Task<CaptureRunResult> RunScheduledAsync(Instant now, CancellationToken cancellationToken = default) => Task.FromResult(Result);
        public Task<CaptureRunResult> RunManualAsync(Instant now, CancellationToken cancellationToken = default) => Task.FromResult(Result);
    }

    private sealed class FakeQueue : ICollectorQueue
    {
        public QueueItem Next { get; init; }
        public int Claims { get; private set; }
        public QueueItem Retried { get; private set; }
        public QueueItem Completed { get; private set; }
        public string CompletedBatchId { get; private set; }

        public Task<QueueEnqueueResult> EnqueueAsync(AutoExportSnapshotV1 snapshot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default) => Task.FromResult(new QueueRecoveryResult(0, 0, 0, 0));
        public Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default) { Claims++; return Task.FromResult(Next); }
        public Task<QueueItem> RetryAsync(QueueItem item, CancellationToken cancellationToken = default) { Retried = item; return Task.FromResult(item); }
        public Task<QueueItem> CompleteAsync(QueueItem item, string batchId, string hash, DateTimeOffset at, CancellationToken cancellationToken = default) { Completed = item; CompletedBatchId = batchId; return Task.FromResult(item); }
        public Task<QueueItem> QuarantineAsync(QueueItem item, string code, CancellationToken cancellationToken = default) => Task.FromResult(item);
        public Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new QueueStatus(1, 0, 2, 0, 128, false));
        public Task<QueueCleanupResult> CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => Task.FromResult(new QueueCleanupResult(0, 0));
    }

    private sealed class FakeCrm : ICollectorCrmClient
    {
        public QueueItem Uploaded { get; private set; }
        public HeartbeatPayload Heartbeat { get; private set; }
        public CrmClientException UploadError { get; init; }

        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default)
        {
            Uploaded = item;
            if (UploadError != null) throw UploadError;
            return Task.FromResult(new UploadAcknowledgement("batch-id", null, false, "processed", item.ContentSha256, DateTimeOffset.UtcNow));
        }
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default)
        {
            Heartbeat = payload;
            return Task.FromResult(new HeartbeatResult("device-id", "online", false, false, "16:45", "America/New_York"));
        }
    }

    private sealed class FakeTokenStore : IDeviceTokenStore
    {
        private string value;
        public FakeTokenStore(string value) => this.value = value;
        public bool Deleted { get; private set; }
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { value = null; Deleted = true; return Task.CompletedTask; }
    }
}
