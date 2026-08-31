using System;
using System.Collections.Generic;
using System.Linq;
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
        UploadLoop loop = new(queue, new FakeCrm(), token, new CollectorState(), new FakeCaptureHistory());

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
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), state, new FakeCaptureHistory());

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
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), new FakeCaptureHistory());

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Same(Item, queue.Retried);
        Assert.Null(queue.Completed);
    }

    [Fact]
    public async Task RejectedUploadIsWrittenToTheLogOnceAndNotOnEveryRetry()
    {
        // A rejection the CRM sends back used to leave no trace at all: it is a
        // handled exception, so it never reached the supervisor, and the
        // supervisor was the only thing that wrote to the log. An afternoon of
        // refused uploads produced an empty log.
        //
        // Once, not every pass, because this loop runs every ten seconds and the
        // repeats would bury the line that matters.
        FakeQueue queue = new() { Next = Item };
        MutableCrm crm = new()
        {
            UploadError = new CrmClientException(
                "upload_failed",
                "The CRM did not accept the snapshot.",
                true,
                disposition: CrmFailureDisposition.Retry),
        };
        RecordingReporter reporter = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), new FakeCaptureHistory(), reporter);

        await loop.RunOnceAsync(CancellationToken.None);
        await loop.RunOnceAsync(CancellationToken.None);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "upload_failed" }, reporter.Codes);
        Assert.Equal("uploader", Assert.Single(reporter.Loops));
        Assert.Contains("did not accept", Assert.Single(reporter.Messages));
    }

    [Fact]
    public async Task AFaultThatChangesShapeIsWrittenAgain()
    {
        // Only identical repeats are suppressed. A different code is a new fact.
        FakeQueue queue = new() { Next = Item };
        MutableCrm crm = new()
        {
            UploadError = new CrmClientException("upload_failed", "first", true, disposition: CrmFailureDisposition.Retry),
        };
        RecordingReporter reporter = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), new FakeCaptureHistory(), reporter);

        await loop.RunOnceAsync(CancellationToken.None);
        crm.UploadError = new CrmClientException("capture_timeout", "second", true, disposition: CrmFailureDisposition.Retry);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "upload_failed", "capture_timeout" }, reporter.Codes);
    }

    [Fact]
    public async Task AGoodPassLetsTheSameFaultBeWrittenAgainWhenItReturns()
    {
        // What clearing on success buys. Without it, a fault that came back after
        // a working upload would be silent for the rest of the process lifetime.
        FakeQueue queue = new() { Next = Item };
        MutableCrm crm = new()
        {
            UploadError = new CrmClientException("upload_failed", "refused", true, disposition: CrmFailureDisposition.Retry),
        };
        RecordingReporter reporter = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), new FakeCaptureHistory(), reporter);

        await loop.RunOnceAsync(CancellationToken.None);
        crm.UploadError = null;
        await loop.RunOnceAsync(CancellationToken.None);
        crm.UploadError = new CrmClientException("upload_failed", "refused again", true, disposition: CrmFailureDisposition.Retry);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "upload_failed", "upload_failed" }, reporter.Codes);
    }

    [Fact]
    public async Task ASuccessfulUploadWritesNothing()
    {
        FakeQueue queue = new() { Next = Item };
        RecordingReporter reporter = new();
        UploadLoop loop = new(queue, new FakeCrm(), new FakeTokenStore("token"), new CollectorState(), new FakeCaptureHistory(), reporter);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(reporter.Codes);
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
        UploadLoop loop = new(queue, crm, token, new CollectorState(), new FakeCaptureHistory());

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
        await new ScheduledCaptureLoop(scheduler, clock, state, new FakeCaptureHistory()).RunOnceAsync(CancellationToken.None);
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

    [Fact]
    public async Task UploaderRecordsTheDayAsUploadedOnlyAfterAcknowledgement()
    {
        FakeQueue queue = new() { Next = Item };
        FakeCaptureHistory history = new();
        UploadLoop loop = new(queue, new FakeCrm(), new FakeTokenStore("token"), new CollectorState(), history);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "2026-07-23" }, history.Uploaded.ToArray());
        Assert.Empty(history.Failures);
    }

    [Fact]
    public async Task ARetryableUploadFailureLeavesTheDayUnmarked()
    {
        // A transient CRM outage is retried on the next pass. Painting the day red
        // for a blip that fixes itself would train the CAM to ignore red.
        FakeQueue queue = new() { Next = Item };
        FakeCrm crm = new()
        {
            UploadError = new CrmClientException("crm_unavailable", "unavailable", true, disposition: CrmFailureDisposition.Retry),
        };
        FakeCaptureHistory history = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), history);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(history.Failures);
        Assert.Empty(history.Uploaded);
    }

    [Fact]
    public async Task AQuarantinedUploadRecordsTheDayAsFailed()
    {
        FakeQueue queue = new() { Next = Item };
        FakeCrm crm = new()
        {
            UploadError = new CrmClientException("payload_rejected", "rejected", false, disposition: CrmFailureDisposition.Quarantine),
        };
        FakeCaptureHistory history = new();
        UploadLoop loop = new(queue, crm, new FakeTokenStore("token"), new CollectorState(), history);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(("2026-07-23", "payload_rejected"), Assert.Single(history.Failures));
    }

    [Fact]
    public async Task AnUnwritableHistoryDoesNotBreakTheUpload()
    {
        // History is a reporting aid. Losing it must never cost a completed
        // upload, which would leave the queue item stuck and the day uncollected.
        FakeQueue queue = new() { Next = Item };
        FakeCaptureHistory history = new() { ThrowOnWrite = true };
        UploadLoop loop = new(queue, new FakeCrm(), new FakeTokenStore("token"), new CollectorState(), history);

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Same(Item, queue.Completed);
    }

    [Fact]
    public async Task TheCaptureLoopRecordsOnlyDueDayFailures()
    {
        FakeCaptureHistory failed = new();
        await new ScheduledCaptureLoop(
                new FakeScheduler
                {
                    Result = new CaptureRunResult(
                        new CaptureScheduleDecision(CaptureScheduleDecisionKind.Due, "2026-07-23", null),
                        false,
                        "addon_unavailable",
                        null),
                },
                new FakeClock(Instant.FromUtc(2026, 7, 23, 20, 45)),
                new CollectorState(),
                failed)
            .RunOnceAsync(CancellationToken.None);

        // A weekend or an already-collected day reports no error and must leave
        // no trace at all.
        FakeCaptureHistory quiet = new();
        await new ScheduledCaptureLoop(
                new FakeScheduler
                {
                    Result = new CaptureRunResult(
                        new CaptureScheduleDecision(CaptureScheduleDecisionKind.DisabledDay, "2026-07-25", null),
                        false,
                        null,
                        null),
                },
                new FakeClock(Instant.FromUtc(2026, 7, 25, 20, 45)),
                new CollectorState(),
                quiet)
            .RunOnceAsync(CancellationToken.None);

        Assert.Equal(("2026-07-23", "addon_unavailable"), Assert.Single(failed.Failures));
        Assert.Empty(quiet.Failures);
        Assert.Empty(quiet.Entries);
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

    // FakeCrm's UploadError is init-only, which is right for the tests that set
    // one fault and assert on it. Change-detection needs the fault to move while
    // the same loop instance keeps running, because the loop is what remembers.
    private sealed class MutableCrm : ICollectorCrmClient
    {
        public CrmClientException UploadError { get; set; }

        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default)
        {
            if (UploadError != null) throw UploadError;
            return Task.FromResult(new UploadAcknowledgement("batch-id", null, false, "processed", item.ContentSha256, DateTimeOffset.UtcNow));
        }
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default)
            => Task.FromResult(new HeartbeatResult("device-id", "online", false, false, "16:45", "America/New_York"));
    }

    private sealed class RecordingReporter : IServiceReporter
    {
        public List<string> Loops { get; } = new();
        public List<string> Codes { get; } = new();
        public List<string> Messages { get; } = new();

        public void LoopFailed(string loopName, string errorCode, Exception exception = null)
        {
            Loops.Add(loopName);
            Codes.Add(errorCode);
            Messages.Add(exception?.Message ?? string.Empty);
        }
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
